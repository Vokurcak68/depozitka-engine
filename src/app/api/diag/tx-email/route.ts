import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { verifyCron, withCors, preflight } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const authError = verifyCron(req);
  if (authError) return withCors(authError);

  const code =
    req.nextUrl.searchParams.get("code") ||
    req.nextUrl.searchParams.get("transaction_code");

  if (!code) {
    return withCors(
      NextResponse.json(
        { ok: false, error: "Missing query param: code" },
        { status: 400 },
      ),
    );
  }

  const { data: tx, error: txErr } = await supabase
    .from("dpt_transactions")
    .select(
      "id, transaction_code, buyer_email, seller_email, status, payment_reference, amount_czk, created_at, updated_at",
    )
    .eq("transaction_code", code)
    .maybeSingle();

  if (txErr) {
    return withCors(
      NextResponse.json({ ok: false, error: txErr.message }, { status: 500 }),
    );
  }

  if (!tx) {
    return withCors(
      NextResponse.json(
        { ok: false, error: `Transaction not found: ${code}` },
        { status: 404 },
      ),
    );
  }

  const [{ data: events }, { data: logs }] = await Promise.all([
    supabase
      .from("dpt_transaction_events")
      .select("id, event_type, old_status, new_status, note, created_at")
      .eq("transaction_id", tx.id)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("dpt_email_logs")
      .select("id, template_key, to_email, status, error_message, created_at, sent_at")
      .eq("transaction_id", tx.id)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const origin = req.nextUrl.origin;

  const buyerPayload = {
    transaction_id: tx.id,
    template_key: "payment_received_buyer",
    to_email: tx.buyer_email,
  };

  const sellerPayload = {
    transaction_id: tx.id,
    template_key: "payment_received_seller",
    to_email: tx.seller_email,
  };

  return withCors(
    NextResponse.json({
      ok: true,
      transaction: tx,
      recentEvents: events || [],
      recentEmailLogs: logs || [],
      testPayloads: {
        buyer: buyerPayload,
        seller: sellerPayload,
      },
      curlExamples: {
        buyer:
          `curl -X POST \"${origin}/api/send-email\" -H \"Content-Type: application/json\" -H \"Authorization: Bearer <TOKEN>\" -d '${JSON.stringify(buyerPayload)}'`,
        seller:
          `curl -X POST \"${origin}/api/send-email\" -H \"Content-Type: application/json\" -H \"Authorization: Bearer <TOKEN>\" -d '${JSON.stringify(sellerPayload)}'`,
      },
    }),
  );
}

export async function OPTIONS() {
  return preflight();
}
