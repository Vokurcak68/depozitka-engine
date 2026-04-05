import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getShipmentVerification } from "@/lib/shieldtrack";

export const dynamic = "force-dynamic";

function cors(res: NextResponse): NextResponse {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

/**
 * GET /api/verification?transaction_id=<uuid>
 * Returns ShieldTrack verification data for a transaction
 */
export async function GET(req: NextRequest) {
  try {
    const transactionId = req.nextUrl.searchParams.get("transaction_id");
    if (!transactionId) {
      return cors(
        NextResponse.json({ error: "Chybí transaction_id" }, { status: 400 }),
      );
    }

    const { data: tx, error } = await supabase
      .from("dpt_transactions")
      .select(
        "id, transaction_code, shieldtrack_shipment_id, status, st_score, st_status",
      )
      .eq("id", transactionId)
      .single();

    if (error || !tx) {
      return cors(
        NextResponse.json({ error: "Transakce nenalezena" }, { status: 404 }),
      );
    }

    if (!tx.shieldtrack_shipment_id) {
      return cors(NextResponse.json({ available: false }));
    }

    try {
      const shipment = await getShipmentVerification(
        tx.shieldtrack_shipment_id,
      );

      const verification = shipment.verification;

      // Cache score + status
      if (verification) {
        const score =
          typeof verification.score === "number" ? verification.score : null;
        const stStatus = verification.status || null;

        await supabase
          .from("dpt_transactions")
          .update({ st_score: score, st_status: stStatus })
          .eq("id", tx.id);

        // Auto-deliver if ShieldTrack shows delivery confirmed and status is shipped
        if (tx.status === "shipped") {
          const deliveryCheck = verification.checks?.find(
            (c) => c.name === "delivery_confirmed" && c.status === "passed",
          );

          if (deliveryCheck) {
            await supabase.rpc("dpt_change_status", {
              p_transaction_code: tx.transaction_code,
              p_new_status: "delivered",
              p_actor_role: "system",
              p_actor_email: null,
              p_note:
                "Auto-delivered via ShieldTrack (delivery_confirmed=pass)",
            });
            console.log(
              `Auto-delivered ${tx.transaction_code} via verification check`,
            );
          }
        }
      }

      return cors(NextResponse.json({ available: true, verification }));
    } catch (stError) {
      console.warn("ShieldTrack verification fetch failed:", stError);
      return cors(
        NextResponse.json({
          available: false,
          error: "Nepodařilo se načíst verifikaci",
        }),
      );
    }
  } catch (err) {
    console.error("Verification API error:", err);
    return cors(
      NextResponse.json(
        { error: err instanceof Error ? err.message : "Neznámá chyba" },
        { status: 500 },
      ),
    );
  }
}
