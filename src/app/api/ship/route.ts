import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { registerShipment, getShipmentVerification } from "@/lib/shieldtrack";

export const dynamic = "force-dynamic";

const VALID_CARRIERS = ["ceska_posta", "ppl", "dpd", "zasilkovna", "gls", "geis", "other"];

function cors(res: NextResponse): NextResponse {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { token, carrier, trackingNumber } = body;

    if (!token || !carrier) {
      return cors(NextResponse.json({ error: "Token a dopravce jsou povinné." }, { status: 400 }));
    }

    if (!VALID_CARRIERS.includes(carrier)) {
      return cors(NextResponse.json({ error: "Neplatný dopravce." }, { status: 400 }));
    }

    // Find transaction by shipping token
    const { data: tx, error: txErr } = await supabase
      .from("dpt_transactions")
      .select("id, transaction_code, status, seller_email, seller_name, buyer_name, buyer_email, payment_reference")
      .eq("shipping_token", token)
      .single();

    if (txErr || !tx) {
      return cors(NextResponse.json({ error: "Transakce nenalezena." }, { status: 404 }));
    }

    if (tx.status !== "paid") {
      return cors(NextResponse.json({
        error: tx.status === "shipped"
          ? "Zásilka již byla odeslána."
          : `Transakce není ve stavu pro odeslání (stav: ${tx.status}).`,
      }, { status: 409 }));
    }

    // Save carrier + tracking number
    const { error: updateErr } = await supabase
      .from("dpt_transactions")
      .update({
        shipping_carrier: carrier,
        shipping_tracking_number: (trackingNumber || "").trim() || null,
      })
      .eq("id", tx.id);

    if (updateErr) {
      console.error("Ship update error:", updateErr);
      return cors(NextResponse.json({ error: "Uložení údajů selhalo." }, { status: 500 }));
    }

    // Change status to shipped via RPC
    const { error: statusErr } = await supabase.rpc("dpt_change_status", {
      p_transaction_code: tx.transaction_code,
      p_new_status: "shipped",
      p_actor_role: "seller",
      p_actor_email: tx.seller_email || null,
      p_note: trackingNumber ? `Tracking: ${trackingNumber.trim()}` : "Odesláno prodávajícím",
    });

    if (statusErr) {
      console.error("Status change error:", statusErr);
      return cors(NextResponse.json({ error: "Změna stavu selhala." }, { status: 500 }));
    }

    // Register shipment in ShieldTrack (non-blocking)
    const tn = (trackingNumber || "").trim();
    if (tn) {
      try {
        const stResult = await registerShipment({
          tracking_number: tn,
          carrier,
          recipient_name: tx.buyer_name || "",
          external_order_id: tx.payment_reference || tx.transaction_code,
          sender_name: tx.seller_name || "",
        });

        if (stResult?.id) {
          // Save shieldtrack_shipment_id
          await supabase
            .from("dpt_transactions")
            .update({ shieldtrack_shipment_id: stResult.id })
            .eq("id", tx.id);

          // Check if already delivered
          try {
            const shipment = await getShipmentVerification(stResult.id);
            const deliveryCheck = shipment.verification?.checks?.find(
              (c) => c.name === "delivery_confirmed" && c.status === "passed",
            );

            if (deliveryCheck) {
              await supabase
                .from("dpt_transactions")
                .update({
                  st_score: shipment.verification?.score ?? null,
                  st_status: shipment.verification?.status ?? null,
                })
                .eq("id", tx.id);

              // Auto-deliver
              await supabase.rpc("dpt_change_status", {
                p_transaction_code: tx.transaction_code,
                p_new_status: "delivered",
                p_actor_role: "system",
                p_actor_email: null,
                p_note: "Auto-delivered via ShieldTrack (zásilka již doručena)",
              });

              console.log(`ShieldTrack: auto-delivered ${tx.transaction_code}`);
            }
          } catch (verifyErr) {
            console.warn("ShieldTrack immediate delivery check failed:", verifyErr);
          }
        }
      } catch (stError) {
        console.warn("ShieldTrack registration failed (non-blocking):", stError);
      }
    }

    return cors(NextResponse.json({ ok: true, transactionCode: tx.transaction_code }));
  } catch (err) {
    console.error("Ship API error:", err);
    return cors(NextResponse.json(
      { error: err instanceof Error ? err.message : "Neznámá chyba" },
      { status: 500 },
    ));
  }
}
