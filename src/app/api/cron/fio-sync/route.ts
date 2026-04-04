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
        { status: 502 }
      );
    }

    const fioData = await fioRes.json();
    const transactions = fioData?.accountStatement?.transactionList?.transaction || [];

    if (transactions.length === 0) {
      return NextResponse.json({ synced: 0, matched: 0, message: "No new FIO transactions" });
    }

    let synced = 0;
    let matched = 0;

    for (const tx of transactions) {
      // FIO column mapping
      const bankTxId = tx.column22?.value?.toString(); // ID pohybu
      const amount = tx.column1?.value; // Částka
      const vs = tx.column5?.value?.toString(); // VS
      const date = tx.column0?.value; // Datum
      const counterAccount = tx.column2?.value; // Protiúčet
      const message = tx.column16?.value; // Zpráva pro příjemce

      if (!bankTxId || !amount || amount <= 0) continue;

      // Idempotence: skip already processed
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
      await supabase.from("dpt_bank_transactions").insert({
        bank_tx_id: bankTxId,
        amount,
        variable_symbol: vs || null,
        date: date || new Date().toISOString(),
        counter_account: counterAccount || null,
        message: message || null,
        matched: false,
      });

      synced++;

      // Try to match VS to escrow transaction
      if (vs) {
        // VS format: extract from payment_reference (e.g. "DPT-2026-0001" → "202600001")
        const { data: escrowTx } = await supabase
          .from("dpt_transactions")
          .select("id, status, total_amount, paid_amount")
          .or(`payment_reference.eq.${vs},payment_vs.eq.${vs}`)
          .maybeSingle();

        if (escrowTx) {
          // Cumulative payment
          const newPaid = (escrowTx.paid_amount || 0) + amount;
          const isPaid = newPaid >= escrowTx.total_amount;

          await supabase
            .from("dpt_transactions")
            .update({
              paid_amount: newPaid,
              ...(isPaid && escrowTx.status === "created"
                ? { status: "paid" }
                : isPaid && escrowTx.status === "partial_paid"
                ? { status: "paid" }
                : !isPaid && escrowTx.status === "created"
                ? { status: "partial_paid" }
                : {}),
            })
            .eq("id", escrowTx.id);

          // Mark bank tx as matched
          await supabase
            .from("dpt_bank_transactions")
            .update({ matched: true, matched_transaction_id: escrowTx.id })
            .eq("bank_tx_id", bankTxId);

          // Queue confirmation email
          if (isPaid) {
            await supabase.from("dpt_email_queue").insert({
              to_email: "", // Will be resolved from transaction parties
              subject: "Platba přijata — Depozitka",
              html_body: `<p>Platba za transakci ${escrowTx.id} byla úspěšně přijata.</p>`,
              status: "pending",
              attempts: 0,
              transaction_id: escrowTx.id,
            });
          }

          matched++;
        }
      }
    }

    return NextResponse.json({ synced, matched, total: transactions.length });
  } catch (err) {
    console.error("fio-sync error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
