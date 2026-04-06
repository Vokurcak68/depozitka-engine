import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

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
 * GET /api/buyer-payment?token=<uuid>
 * Returns payment details for the buyer (only if address is filled)
 */
export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get("token");
    if (!token || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
      return cors(NextResponse.json({ error: "Neplatný token" }, { status: 400 }));
    }

    const { data: tx, error } = await supabase
      .from("dpt_transactions")
      .select("id, transaction_code, amount_czk, payment_reference, payment_due_at, buyer_address_filled, paid_amount")
      .eq("buyer_token", token)
      .single();

    if (error || !tx) {
      return cors(NextResponse.json({ error: "Transakce nenalezena" }, { status: 404 }));
    }

    if (!tx.buyer_address_filled) {
      return cors(NextResponse.json({ error: "Nejdřív vyplňte doručovací adresu" }, { status: 403 }));
    }

    // Get escrow account
    const { data: settings } = await supabase
      .from("dpt_settings")
      .select("value")
      .eq("key", "escrow_account")
      .maybeSingle();

    const escrow = settings?.value as { account_number?: string; iban?: string } | null;

    // Build QR SPD
    let qrUrl: string | undefined;
    const iban = escrow?.iban;
    const vs = tx.payment_reference;
    const amountNum = Number(tx.amount_czk);
    const paidNum = tx.paid_amount ? Number(tx.paid_amount) : 0;
    const remaining = amountNum - paidNum;

    if (iban && vs && remaining > 0) {
      const spdParts = [
        "SPD*1.0",
        `ACC:${iban}`,
        `AM:${remaining.toFixed(2)}`,
        "CC:CZK",
        `X-VS:${vs.slice(0, 10)}`,
        `MSG:PLATBA ${tx.transaction_code.replace(/-/g, "")}`,
      ];
      const spdString = spdParts.join("*");
      qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(spdString)}`;
    }

    return cors(NextResponse.json({
      accountNumber: escrow?.account_number || undefined,
      iban: iban || undefined,
      paymentReference: vs || undefined,
      amountCzk: remaining > 0 ? remaining : amountNum,
      paymentDueAt: tx.payment_due_at || undefined,
      qrUrl,
    }));
  } catch (err) {
    console.error("buyer-payment GET error:", err);
    return cors(NextResponse.json({ error: "Interní chyba" }, { status: 500 }));
  }
}
