import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { verifyCron } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const FIO_API_BASE = process.env.FIO_API_BASE || "https://fioapi.fio.cz/v1/rest";

/**
 * Sync incoming payments from FIO bank.
 * Fetches new transactions since last sync, matches by variable symbol (VS)
 * to dpt_transactions.payment_reference.
 *
 * Flow:
 *   1. Fetch new bank movements from FIO API
 *   2. Store each in dpt_bank_transactions (idempotent via bank_tx_id)
 *   3. If VS present, match to dpt_transactions.payment_reference
 *   4. Cumulative: add amount to paid_amount
 *   5. If fully paid → status "paid"; partially → "partial_paid"
 */
export async function GET(req: NextRequest) {
  const authError = verifyCron(req);
  if (authError) return authError;

  const FIO_TOKEN = process.env.FIO_API_TOKEN;
  if (!FIO_TOKEN) {
    return NextResponse.json({ error: "FIO_API_TOKEN not configured" }, { status: 500 });
  }

  try {
    // Fetch new transactions from FIO (since last download)
    const fioUrl = `${FIO_API_BASE}/last/${FIO_TOKEN}/transactions.json`;
    const fioRes = await fetch(fioUrl, {
      headers: { Accept: "application/json" },
    });

    if (!fioRes.ok) {
      const text = await fioRes.text();
      console.error("FIO API error:", fioRes.status, text);
      return NextResponse.json(
        { error: `FIO API ${fioRes.status}`, detail: text },
        { status: 502 },
      );
    }

    const fioData = await fioRes.json();
    const transactions =
      fioData?.accountStatement?.transactionList?.transaction || [];

    if (transactions.length === 0) {
      return NextResponse.json({
        synced: 0,
        matched: 0,
        message: "No new FIO transactions",
      });
    }

    let synced = 0;
    let matched = 0;
    const errors: string[] = [];

    for (const tx of transactions) {
      // FIO column mapping (standard FIO API columns)
      const bankTxId = tx.column22?.value?.toString(); // ID pohybu
      const amount = Number(tx.column1?.value); // Částka
      const vs = tx.column5?.value?.toString()?.trim(); // VS
      const date = tx.column0?.value; // Datum
      const counterAccount = tx.column2?.value; // Protiúčet
      const message = tx.column16?.value; // Zpráva pro příjemce

      if (!bankTxId || !amount || amount <= 0) continue;

      // Idempotence: skip already processed bank transactions
      const { data: existing } = await supabase
        .from("dpt_bank_transactions")
        .select("id")
        .eq("bank_tx_id", bankTxId)
        .maybeSingle();

      if (existing) {
        synced++;
        continue;
      }

      // Store raw bank transaction
      const { error: insertErr } = await supabase
        .from("dpt_bank_transactions")
        .insert({
          bank_tx_id: bankTxId,
          amount,
          variable_symbol: vs || null,
          date: date || new Date().toISOString(),
          counter_account: counterAccount || null,
          message: message || null,
          matched: false,
        });

      if (insertErr) {
        errors.push(`Insert bank tx ${bankTxId}: ${insertErr.message}`);
        continue;
      }

      synced++;

      // Try to match VS to escrow transaction
      if (!vs) continue;

      const { data: escrowTx } = await supabase
        .from("dpt_transactions")
        .select("id, status, amount_czk, paid_amount, buyer_email, seller_email, transaction_code")
        .eq("payment_reference", vs)
        .maybeSingle();

      if (!escrowTx) continue;

      // Only match transactions in payable states
      if (escrowTx.status !== "created" && escrowTx.status !== "partial_paid") {
        continue;
      }

      // Cumulative payment
      const currentPaid = Number(escrowTx.paid_amount) || 0;
      const totalAmount = Number(escrowTx.amount_czk);
      const newPaid = currentPaid + amount;
      const isFullyPaid = newPaid >= totalAmount;

      const newStatus = isFullyPaid ? "paid" : "partial_paid";

      const { error: updateErr } = await supabase
        .from("dpt_transactions")
        .update({
          paid_amount: newPaid,
          status: newStatus,
          ...(isFullyPaid ? { paid_at: new Date().toISOString() } : {}),
          bank_tx_id: bankTxId, // last matching bank tx
        })
        .eq("id", escrowTx.id);

      if (updateErr) {
        errors.push(`Update tx ${escrowTx.id}: ${updateErr.message}`);
        continue;
      }

      // Mark bank tx as matched
      await supabase
        .from("dpt_bank_transactions")
        .update({ matched: true, matched_transaction_id: escrowTx.id })
        .eq("bank_tx_id", bankTxId);

      // Queue confirmation emails when fully paid
      if (isFullyPaid) {
        // Email to buyer
        await supabase.from("dpt_email_queue").insert({
          to_email: escrowTx.buyer_email,
          subject: `Platba přijata — ${escrowTx.transaction_code}`,
          text_body: `Dobrý den,\n\nVaše platba ${totalAmount.toFixed(2)} Kč za transakci ${escrowTx.transaction_code} byla úspěšně přijata.\n\nProdávající bude informován k odeslání zboží.\n\nDěkujeme.`,
          status: "pending",
          attempts: 0,
        });

        // Email to seller
        await supabase.from("dpt_email_queue").insert({
          to_email: escrowTx.seller_email,
          subject: `Platba přijata — odešlete zboží (${escrowTx.transaction_code})`,
          text_body: `Dobrý den,\n\nKupující uhradil platbu za transakci ${escrowTx.transaction_code}.\n\nProsím odešlete zboží a zadejte trackingové číslo.\n\nDěkujeme.`,
          status: "pending",
          attempts: 0,
        });
      }

      matched++;
    }

    return NextResponse.json({
      synced,
      matched,
      total: transactions.length,
      ...(errors.length ? { errors } : {}),
    });
  } catch (err) {
    console.error("fio-sync error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
