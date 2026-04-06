import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { czechAccountToIban, isValidCzechIban } from "@/lib/iban";

export const dynamic = "force-dynamic";

/**
 * POST /api/seller-account
 * Prodávající zadá číslo účtu pro výplatu (přes shipping_token).
 *
 * Body: { token, account_number, bank_code, account_name? }
 * account_number: "123456789" nebo "19-123456789"
 * bank_code: "0800"
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { token, account_number, bank_code, account_name } = body;

  if (!token || !account_number || !bank_code) {
    return NextResponse.json({ error: "Vyplňte číslo účtu a kód banky." }, { status: 400 });
  }

  // Compute IBAN
  const iban = czechAccountToIban(account_number.trim(), bank_code.trim());
  if (!iban || !isValidCzechIban(iban)) {
    return NextResponse.json({ error: "Neplatné číslo účtu nebo kód banky." }, { status: 400 });
  }

  const supabase = getSupabase();

  // Find transaction by shipping_token
  const { data: tx, error: txErr } = await supabase
    .from("dpt_transactions")
    .select("id, status, seller_payout_iban, seller_payout_locked_at")
    .eq("shipping_token", token)
    .single();

  if (txErr || !tx) {
    return NextResponse.json({ error: "Transakce nenalezena." }, { status: 404 });
  }

  // Don't allow changing locked payout info
  if (tx.seller_payout_locked_at) {
    return NextResponse.json({ error: "Údaje o výplatě jsou zamčené a nelze je měnit." }, { status: 400 });
  }

  // Only allow setting before completion
  const blockedStatuses = ["payout_sent", "payout_confirmed", "refunded", "cancelled"];
  if (blockedStatuses.includes(tx.status)) {
    return NextResponse.json({ error: `Nelze měnit účet ve stavu "${tx.status}".` }, { status: 400 });
  }

  // Save IBAN + account name
  const { error: updateErr } = await supabase
    .from("dpt_transactions")
    .update({
      seller_payout_iban: iban,
      seller_payout_account_name: (account_name || "").trim() || null,
      seller_payout_source: "seller_form",
    })
    .eq("id", tx.id);

  if (updateErr) {
    console.error("Seller account update error:", updateErr);
    return NextResponse.json({ error: "Nepodařilo se uložit údaje." }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    iban,
    message: `Účet uložen. IBAN: ${iban}`,
  });
}

/**
 * GET /api/seller-account?token=...
 * Vrátí aktuální payout info pro transakci.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "Chybí token." }, { status: 400 });
  }

  const supabase = getSupabase();

  const { data: tx, error } = await supabase
    .from("dpt_transactions")
    .select("id, transaction_code, seller_payout_iban, seller_payout_account_name, seller_payout_locked_at, status")
    .eq("shipping_token", token)
    .single();

  if (error || !tx) {
    return NextResponse.json({ error: "Transakce nenalezena." }, { status: 404 });
  }

  return NextResponse.json({
    hasAccount: !!tx.seller_payout_iban,
    iban: tx.seller_payout_iban || null,
    accountName: tx.seller_payout_account_name || null,
    locked: !!tx.seller_payout_locked_at,
    status: tx.status,
  });
}
