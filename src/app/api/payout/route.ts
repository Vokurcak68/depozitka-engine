import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { verifyCron } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

const FIO_API_BASE = process.env.FIO_API_BASE || "https://fioapi.fio.cz/v1/rest";

/**
 * POST /api/payout
 * Manuální výplata prodávajícímu — odešle FIO platební příkaz.
 *
 * Body: { transaction_id: string }
 * Auth: CRON_SECRET (Bearer / query / body)
 */
export async function POST(req: NextRequest) {
  const authError = verifyCron(req);
  if (authError) return authError;

  const FIO_TOKEN = process.env.FIO_API_TOKEN;
  if (!FIO_TOKEN) {
    return NextResponse.json({ error: "FIO_API_TOKEN not configured" }, { status: 500 });
  }

  const body = await req.json();
  const { transaction_id } = body;

  if (!transaction_id) {
    return NextResponse.json({ error: "Chybí transaction_id." }, { status: 400 });
  }

  const supabase = getSupabase();

  // Fetch transaction
  const { data: tx, error: txErr } = await supabase
    .from("dpt_transactions")
    .select("*")
    .eq("id", transaction_id)
    .single();

  if (txErr || !tx) {
    return NextResponse.json({ error: "Transakce nenalezena." }, { status: 404 });
  }

  // Validate status — payout only from delivered/completed/auto_completed
  if (!["delivered", "completed", "auto_completed"].includes(tx.status)) {
    return NextResponse.json({
      error: `Výplata možná jen z delivered/completed/auto_completed (aktuální: ${tx.status}).`,
    }, { status: 400 });
  }

  // Check IBAN
  const iban = tx.seller_payout_iban;
  if (!iban) {
    return NextResponse.json({ error: "Prodávající nemá nastavený IBAN pro výplatu." }, { status: 400 });
  }

  const payoutAmount = tx.payout_amount_czk;
  if (!payoutAmount || payoutAmount <= 0) {
    return NextResponse.json({ error: "Částka výplaty je 0 nebo neplatná." }, { status: 400 });
  }

  try {
    // Build FIO XML domestic payment order
    const cleanIban = iban.replace(/\s/g, "").toUpperCase();
    const bankCode = cleanIban.substring(4, 8);
    const accountNumber = cleanIban.substring(8).replace(/^0+/, "");
    const vs = (tx.payment_reference || "").replace(/[^0-9]/g, "");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Import xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="http://www.fio.cz/schema/netbanking/import.xsd">
  <Orders>
    <DomesticTransaction>
      <accountFrom></accountFrom>
      <currency>CZK</currency>
      <amount>${Number(payoutAmount).toFixed(2)}</amount>
      <accountTo>${accountNumber}</accountTo>
      <bankCode>${bankCode}</bankCode>
      <vs>${vs}</vs>
      <date>${new Date().toISOString().split("T")[0]}</date>
      <messageForRecipient>Výplata ${tx.transaction_code}</messageForRecipient>
      <paymentType>431001</paymentType>
    </DomesticTransaction>
  </Orders>
</Import>`;

    // Submit to FIO
    const formData = new FormData();
    formData.append("type", "xml");
    formData.append("token", FIO_TOKEN);
    formData.append("lng", "cs");
    const blob = new Blob([xml], { type: "application/xml" });
    formData.append("file", blob, "payment.xml");

    const fioRes = await fetch(`${FIO_API_BASE}/import/`, {
      method: "POST",
      body: formData,
    });

    if (!fioRes.ok) {
      const errText = await fioRes.text();
      throw new Error(`FIO import ${fioRes.status}: ${errText}`);
    }

    const fioResult = await fioRes.text();

    // Change status to payout_sent via RPC
    const { error: statusErr } = await supabase.rpc("dpt_change_status", {
      p_transaction_code: tx.transaction_code,
      p_new_status: "payout_sent",
      p_actor_role: "service",
      p_actor_email: null,
      p_note: `Výplata ${Number(payoutAmount).toFixed(2)} Kč odeslána na ${cleanIban}`,
    });

    if (statusErr) {
      console.error("Payout status change error:", statusErr);
      // FIO payment was already submitted, log but don't fail
    }

    return NextResponse.json({
      success: true,
      amount: payoutAmount,
      iban: cleanIban,
      fio_response: fioResult.substring(0, 500),
    });
  } catch (err) {
    console.error("Payout error:", err);
    return NextResponse.json({
      error: err instanceof Error ? err.message : "Chyba při odesílání výplaty.",
    }, { status: 500 });
  }
}
