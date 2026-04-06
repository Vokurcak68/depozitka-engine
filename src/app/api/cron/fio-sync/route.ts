import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { verifyCron, withCors } from "@/lib/cron-auth";
import { getTransporter } from "@/lib/smtp";

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
  if (authError) return withCors(authError);

  const FIO_TOKEN = process.env.FIO_API_TOKEN;
  if (!FIO_TOKEN) {
    return withCors(NextResponse.json({ error: "FIO_API_TOKEN not configured" }, { status: 500 }));
  }

  try {
    // Fetch transactions from FIO (from 2026-04-01 onward to avoid legacy movements)
    const FIO_START_DATE = "2026-04-01";
    const today = new Date().toISOString().slice(0, 10);
    const fioUrl = `${FIO_API_BASE}/periods/${FIO_TOKEN}/${FIO_START_DATE}/${today}/transactions.json`;
    const fioRes = await fetch(fioUrl, {
      headers: { Accept: "application/json" },
    });

    if (!fioRes.ok) {
      const text = await fioRes.text();
      console.error("FIO API error:", fioRes.status, text);
      return withCors(NextResponse.json(
        { error: `FIO API ${fioRes.status}`, detail: text },
        { status: 502 },
      ));
    }

    const fioData = await fioRes.json();
    const transactions =
      fioData?.accountStatement?.transactionList?.transaction || [];

    if (transactions.length === 0) {
      return withCors(NextResponse.json({
        synced: 0,
        matched: 0,
        message: "No new FIO transactions",
      }));
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
      const isOverpaid = newPaid > totalAmount;
      await supabase
        .from("dpt_bank_transactions")
        .update({ matched: true, matched_transaction_id: escrowTx.id, overpaid: isOverpaid })
        .eq("bank_tx_id", bankTxId);

      // Insert event → triggers pg_net instant email via DB trigger
      await supabase.from("dpt_transaction_events").insert({
        transaction_id: escrowTx.id,
        event_type: "status_changed",
        old_status: escrowTx.status,
        new_status: newStatus,
        actor_role: "service",
        note: `FIO sync: přijato ${amount.toFixed(2)} Kč (VS ${vs}), celkem ${newPaid.toFixed(2)}/${totalAmount.toFixed(2)} Kč`,
      });

      matched++;
    }

    // Send admin alert if there are unmatched payments
    try {
      const { data: unmatchedRows } = await supabase
        .from("dpt_bank_transactions")
        .select("bank_tx_id, amount, variable_symbol, date, counter_account, message")
        .eq("matched", false)
        .eq("ignored", false)
        .order("date", { ascending: false })
        .limit(50);

      const unmatched = unmatchedRows || [];
      if (unmatched.length > 0) {
        const adminEmail = process.env.ADMIN_EMAIL || process.env.SMTP_USER;
        if (adminEmail) {
          const lines = unmatched.map(
            (u) =>
              `• ${u.date || "?"} | ${Number(u.amount).toLocaleString("cs-CZ")} Kč | VS: ${u.variable_symbol || "—"} | ${u.counter_account || "—"} | ${u.message || ""}`,
          );

          const transporter = getTransporter();
          await transporter.sendMail({
            from: process.env.SMTP_FROM || adminEmail,
            to: adminEmail,
            subject: `⚠️ Depozitka: ${unmatched.length} nespárovaných plateb`,
            text: `Po FIO syncu zůstává ${unmatched.length} nespárovaných plateb:\n\n${lines.join("\n")}\n\nPřihlas se do Depozitka Core → záložka Banka a vyřeš je.`,
          });
        }
      }
    } catch (alertErr) {
      console.warn("Admin alert failed:", alertErr);
    }

    return withCors(NextResponse.json({
      synced,
      matched,
      total: transactions.length,
      ...(errors.length ? { errors } : {}),
    }));
  } catch (err) {
    console.error("fio-sync error:", err);
    return withCors(NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    ));
  }
}

/**
 * POST handler — manual trigger from Core UI.
 * Reuses GET logic. Auth via Authorization header or ?token= query.
 */
export async function POST(req: NextRequest) {
  return GET(req);
}

/** CORS preflight for manual POST calls from Core UI */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    },
  });
}
