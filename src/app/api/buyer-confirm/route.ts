import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

/**
 * POST /api/buyer-confirm
 * Kupující potvrdí doručení nebo zahájí spor (přes delivery_confirm_token).
 *
 * Body:
 *   { token, action: "confirm" }                             — potvrdit doručení
 *   { token, action: "dispute", reason, evidence_urls? }     — zahájit spor
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { token, action, reason, evidence_urls } = body;

  if (!token || !action) {
    return NextResponse.json({ error: "Chybí token nebo action." }, { status: 400 });
  }

  const supabase = getSupabase();

  // Find transaction by delivery_confirm_token
  const { data: tx, error: txErr } = await supabase
    .from("dpt_transactions")
    .select("*")
    .eq("delivery_confirm_token", token)
    .single();

  if (txErr || !tx) {
    return NextResponse.json({ error: "Transakce nenalezena nebo neplatný odkaz." }, { status: 404 });
  }

  // --- CONFIRM DELIVERY ---
  if (action === "confirm") {
    if (!["shipped", "delivered"].includes(tx.status)) {
      return NextResponse.json({
        error: `Nelze potvrdit doručení ve stavu "${tx.status}".`,
      }, { status: 400 });
    }

    // Already delivered? Nothing to do — buyer confirmation only moves shipped → delivered
    if (tx.status === "delivered") {
      return NextResponse.json({ success: true, new_status: "delivered", already: true });
    }

    // Change status via RPC (validates transitions, inserts event → triggers email)
    const { error: statusErr } = await supabase.rpc("dpt_change_status", {
      p_transaction_code: tx.transaction_code,
      p_new_status: "delivered",
      p_actor_role: "buyer",
      p_actor_email: tx.buyer_email || null,
      p_note: "Kupující potvrdil přijetí zásilky.",
    });

    if (statusErr) {
      console.error("Confirm delivery error:", statusErr);
      return NextResponse.json({ error: "Nepodařilo se aktualizovat transakci: " + statusErr.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, new_status: "delivered" });
  }

  // --- OPEN DISPUTE ---
  if (action === "dispute") {
    if (!reason?.trim()) {
      return NextResponse.json({ error: "Vyplňte důvod sporu." }, { status: 400 });
    }

    if (!["shipped", "delivered"].includes(tx.status)) {
      return NextResponse.json({
        error: `Nelze otevřít spor ve stavu "${tx.status}".`,
      }, { status: 400 });
    }

    // Save dispute details first
    const { error: disputeErr } = await supabase
      .from("dpt_transactions")
      .update({
        dispute_reason: reason.trim(),
        dispute_evidence_urls: evidence_urls || [],
        disputed_at: new Date().toISOString(),
      })
      .eq("id", tx.id);

    if (disputeErr) {
      console.error("Dispute save error:", disputeErr);
      return NextResponse.json({ error: "Nepodařilo se uložit důvod sporu." }, { status: 500 });
    }

    // Change status via RPC (validates transitions, inserts event → triggers email)
    const { error: statusErr } = await supabase.rpc("dpt_change_status", {
      p_transaction_code: tx.transaction_code,
      p_new_status: "disputed",
      p_actor_role: "buyer",
      p_actor_email: tx.buyer_email || null,
      p_note: `Spor otevřen kupujícím: ${reason.trim()}`,
    });

    if (statusErr) {
      console.error("Dispute status error:", statusErr);
      return NextResponse.json({ error: "Nepodařilo se otevřít spor: " + statusErr.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, new_status: "disputed" });
  }

  return NextResponse.json({ error: `Neznámá akce: ${action}` }, { status: 400 });
}

/**
 * GET /api/buyer-confirm?token=...
 * Vrátí info o transakci pro zobrazení na stránce.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.json({ error: "Chybí token." }, { status: 400 });
  }

  const supabase = getSupabase();

  const { data: tx, error: txErr } = await supabase
    .from("dpt_transactions")
    .select("id, transaction_code, status, amount_czk, buyer_name, seller_name, shipping_carrier, shipping_tracking_number, shipped_at")
    .eq("delivery_confirm_token", token)
    .single();

  if (txErr || !tx) {
    return NextResponse.json({ error: "Transakce nenalezena." }, { status: 404 });
  }

  return NextResponse.json({ transaction: tx });
}
