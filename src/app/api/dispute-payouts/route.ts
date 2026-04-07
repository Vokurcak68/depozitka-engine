import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { verifyCron } from "@/lib/cron-auth";
import { sendEmailDirect } from "@/lib/send-email-direct";

export const dynamic = "force-dynamic";

const FIO_API_BASE = process.env.FIO_API_BASE || "https://fioapi.fio.cz/v1/rest";

function cors(res: NextResponse): NextResponse {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return res;
}

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function splitBankAccount(account: string): { accountNumber: string; bankCode: string } | null {
  const trimmed = account.trim();
  const match = trimmed.match(/^(\d[\d-]*)\/(\d{4})$/);
  if (!match) return null;
  return { accountNumber: match[1], bankCode: match[2] };
}

function ibanToAccount(iban: string): { accountNumber: string; bankCode: string } | null {
  const cleaned = iban.replace(/\s/g, "").toUpperCase();
  if (!/^CZ\d{22}$/.test(cleaned)) return null;
  const bankCode = cleaned.substring(4, 8);
  const prefix = cleaned.substring(8, 14).replace(/^0+/, "");
  const account = cleaned.substring(14).replace(/^0+/, "");
  const accountNumber = prefix ? `${prefix}-${account}` : account;
  return { accountNumber, bankCode };
}

/**
 * Akceptuje:
 *  - CZ účet "1234567890/0100" nebo "19-2000145399/0800"
 *  - IBAN "CZ65 0800 0000 1920 0014 5399" (s mezerami i bez)
 * Vrací jednotný { accountNumber, bankCode } pro FIO XML.
 */
function parseAccountAny(raw: string): { accountNumber: string; bankCode: string } | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // CZ format first (rychlejší check)
  const czParsed = splitBankAccount(trimmed);
  if (czParsed) return czParsed;
  // Fallback na IBAN
  return ibanToAccount(trimmed);
}

interface PayoutItemInput {
  recipient_type: "buyer" | "seller" | "platform_fee";
  recipient_name?: string | null;
  recipient_account?: string | null; // CZ formát nebo IBAN
  recipient_iban?: string | null; // zpětná kompatibilita
  amount_czk: number;
  variable_symbol?: string | null;
  note?: string | null;
}

/**
 * POST /api/dispute-payouts
 *
 * Body: {
 *   transaction_id: string,
 *   items: PayoutItemInput[],
 *   created_by?: string  // email admina
 * }
 *
 * Auth: CRON_SECRET (Bearer / query / body)
 *
 * Validuje kontrolní součet (musí přesně sedět na transaction.amount_czk),
 * vytvoří dpt_payout_items v 'pending', pak prochází items a:
 *  - pro buyer/seller s IBAN → odešle FIO XML, status 'sent' / 'failed'
 *  - pro platform_fee → jen status 'sent' (interní log, žádný převod)
 * Po každé item pošle email (sendEmailDirect).
 * Pokud všechny items 'sent' → status transakce 'dispute_settled'.
 * Pokud aspoň jedna 'failed' → admin notifikace, transakce zůstává 'disputed'.
 */
export async function POST(req: NextRequest) {
  const authError = verifyCron(req);
  if (authError) return cors(authError);

  const FIO_TOKEN = process.env.FIO_API_TOKEN;
  if (!FIO_TOKEN) {
    return cors(NextResponse.json({ error: "FIO_API_TOKEN not configured" }, { status: 500 }));
  }

  const FIO_SOURCE = process.env.FIO_SOURCE_ACCOUNT;
  if (!FIO_SOURCE) {
    return cors(
      NextResponse.json({ error: "FIO_SOURCE_ACCOUNT není nastavený." }, { status: 500 })
    );
  }

  const sourceParsed = splitBankAccount(FIO_SOURCE);
  if (!sourceParsed) {
    return cors(
      NextResponse.json({ error: `FIO_SOURCE_ACCOUNT formát: '${FIO_SOURCE}'.` }, { status: 500 })
    );
  }

  const body = await req.json();
  const { transaction_id, items, created_by } = body as {
    transaction_id?: string;
    items?: PayoutItemInput[];
    created_by?: string;
  };

  if (!transaction_id) {
    return cors(NextResponse.json({ error: "Chybí transaction_id." }, { status: 400 }));
  }

  if (!Array.isArray(items) || items.length === 0) {
    return cors(NextResponse.json({ error: "items musí být neprázdné pole." }, { status: 400 }));
  }

  const supabase = getSupabase();

  // Načti transakci
  const { data: tx, error: txErr } = await supabase
    .from("dpt_transactions")
    .select("*")
    .eq("id", transaction_id)
    .single();

  if (txErr || !tx) {
    return cors(NextResponse.json({ error: "Transakce nenalezena." }, { status: 404 }));
  }

  if (tx.status !== "disputed") {
    return cors(
      NextResponse.json(
        { error: `Dispute payouts možný jen ze stavu 'disputed' (aktuální: ${tx.status}).` },
        { status: 400 }
      )
    );
  }

  // Validace items
  const totalDeposit = Number(tx.amount_czk);
  if (!totalDeposit || totalDeposit <= 0) {
    return cors(NextResponse.json({ error: "Transakce nemá platnou částku." }, { status: 400 }));
  }

  let sumItems = 0;
  for (const item of items) {
    if (!["buyer", "seller", "platform_fee"].includes(item.recipient_type)) {
      return cors(
        NextResponse.json({ error: `Neplatný recipient_type: ${item.recipient_type}` }, { status: 400 })
      );
    }
    const amt = Number(item.amount_czk);
    if (!Number.isFinite(amt) || amt < 0) {
      return cors(NextResponse.json({ error: "Neplatná částka v itemu." }, { status: 400 }));
    }
    const account = item.recipient_account || item.recipient_iban;
    if (item.recipient_type !== "platform_fee" && !account) {
      return cors(
        NextResponse.json(
          { error: `Item typu '${item.recipient_type}' musí mít číslo účtu.` },
          { status: 400 }
        )
      );
    }
    if (item.recipient_type !== "platform_fee" && account && !parseAccountAny(account)) {
      return cors(
        NextResponse.json(
          {
            error: `Neplatný formát účtu '${account}'. Použij '1234567890/0100' nebo IBAN CZ...`,
          },
          { status: 400 }
        )
      );
    }
    sumItems += amt;
  }

  // Kontrolní součet — musí sedět na korunu
  const sumRounded = Math.round(sumItems * 100) / 100;
  const depositRounded = Math.round(totalDeposit * 100) / 100;
  if (sumRounded !== depositRounded) {
    return cors(
      NextResponse.json(
        {
          error: `Kontrolní součet nesedí: items=${sumRounded.toFixed(2)} Kč, transakce=${depositRounded.toFixed(2)} Kč.`,
        },
        { status: 400 }
      )
    );
  }

  // Vytvoř items v 'pending'
  // Poznámka: sloupec v DB se jmenuje recipient_iban (kvůli migraci 041), ale akceptujeme i CZ formát.
  const itemsToInsert = items.map((it) => ({
    transaction_id: tx.id,
    recipient_type: it.recipient_type,
    recipient_name: it.recipient_name || null,
    recipient_iban: it.recipient_account || it.recipient_iban || null,
    amount_czk: it.amount_czk,
    variable_symbol: it.variable_symbol || null,
    note: it.note || null,
    status: "pending" as const,
    created_by: created_by || null,
  }));

  const { data: insertedItems, error: insertErr } = await supabase
    .from("dpt_payout_items")
    .insert(itemsToInsert)
    .select();

  if (insertErr || !insertedItems) {
    return cors(
      NextResponse.json(
        { error: `Nepodařilo se vytvořit payout items: ${insertErr?.message}` },
        { status: 500 }
      )
    );
  }

  const today = new Date().toISOString().split("T")[0];
  const results: Array<{
    item_id: string;
    recipient_type: string;
    amount: number;
    status: string;
    error?: string;
  }> = [];

  let allSent = true;
  let anyFailed = false;

  // Process items sequentially
  for (const item of insertedItems) {
    const amount = Number(item.amount_czk);

    // Platform fee → jen log, žádný převod
    if (item.recipient_type === "platform_fee") {
      await supabase
        .from("dpt_payout_items")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          fio_response: "INTERNAL: platform fee — žádný bankovní převod",
        })
        .eq("id", item.id);

      results.push({
        item_id: item.id,
        recipient_type: "platform_fee",
        amount,
        status: "sent",
      });
      continue;
    }

    // Buyer / Seller → FIO převod
    const targetParsed = parseAccountAny(item.recipient_iban!);
    if (!targetParsed) {
      await supabase
        .from("dpt_payout_items")
        .update({
          status: "failed",
          error_message: `Neplatný formát účtu: ${item.recipient_iban}`,
        })
        .eq("id", item.id);

      results.push({
        item_id: item.id,
        recipient_type: item.recipient_type,
        amount,
        status: "failed",
        error: "Neplatný IBAN",
      });
      allSent = false;
      anyFailed = true;
      continue;
    }

    const vs = (item.variable_symbol || tx.payment_reference || tx.transaction_code || "").replace(
      /[^0-9]/g,
      ""
    );
    const message =
      item.recipient_type === "buyer"
        ? `Refund ${tx.transaction_code}`
        : `Vyplata ${tx.transaction_code}`;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Import xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.fio.cz/schema/importIB.xsd">
  <Orders>
    <DomesticTransaction>
      <accountFrom>${escapeXml(sourceParsed.accountNumber)}</accountFrom>
      <currency>CZK</currency>
      <amount>${amount.toFixed(2)}</amount>
      <accountTo>${escapeXml(targetParsed.accountNumber)}</accountTo>
      <bankCode>${escapeXml(targetParsed.bankCode)}</bankCode>
      <vs>${escapeXml(vs)}</vs>
      <date>${escapeXml(today)}</date>
      <messageForRecipient>${escapeXml(message)}</messageForRecipient>
      <comment>${escapeXml(message)}</comment>
      <paymentType>431001</paymentType>
    </DomesticTransaction>
  </Orders>
</Import>`;

    try {
      const formData = new FormData();
      formData.append("token", FIO_TOKEN.trim());
      formData.append("type", "xml");
      formData.append("file", new Blob([xml], { type: "application/xml" }), "import.xml");

      const fioRes = await fetch(`${FIO_API_BASE}/import/`, {
        method: "POST",
        body: formData,
      });

      const fioText = await fioRes.text();

      if (!fioRes.ok) {
        await supabase
          .from("dpt_payout_items")
          .update({
            status: "failed",
            error_message: `FIO ${fioRes.status}: ${fioText.substring(0, 1500)}`,
            fio_response: fioText.substring(0, 2000),
          })
          .eq("id", item.id);

        // Také zaloguj do dpt_payout_log pro jednotný přehled
        await supabase.from("dpt_payout_log").insert({
          transaction_id: tx.id,
          transaction_code: tx.transaction_code,
          amount_czk: amount,
          iban: item.recipient_iban!.replace(/\s/g, "").toUpperCase(),
          account_name: item.recipient_name,
          variable_symbol: vs || null,
          status: "failed",
          error_message: `[${item.recipient_type}] FIO ${fioRes.status}: ${fioText.substring(0, 1000)}`,
          triggered_by: created_by || "dispute",
        });

        results.push({
          item_id: item.id,
          recipient_type: item.recipient_type,
          amount,
          status: "failed",
          error: `FIO ${fioRes.status}`,
        });
        allSent = false;
        anyFailed = true;
        continue;
      }

      // Úspěch
      await supabase
        .from("dpt_payout_items")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          fio_response: fioText.substring(0, 2000),
        })
        .eq("id", item.id);

      await supabase.from("dpt_payout_log").insert({
        transaction_id: tx.id,
        transaction_code: tx.transaction_code,
        amount_czk: amount,
        iban: item.recipient_iban!.replace(/\s/g, "").toUpperCase(),
        account_name: item.recipient_name,
        variable_symbol: vs || null,
        fio_response: fioText.substring(0, 2000),
        status: "sent",
        triggered_by: created_by || "dispute",
      });

      results.push({
        item_id: item.id,
        recipient_type: item.recipient_type,
        amount,
        status: "sent",
      });

      // Email po každé item
      try {
        const targetEmail =
          item.recipient_type === "buyer" ? tx.buyer_email : tx.seller_email;
        const templateKey =
          item.recipient_type === "buyer" ? "dispute_payout_buyer" : "dispute_payout_seller";
        if (targetEmail) {
          await sendEmailDirect(tx.id, templateKey, targetEmail);
        }
      } catch (emailErr) {
        console.error("[dispute-payouts] email send failed:", emailErr);
        // Email failure neblokuje výplatu
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "unknown";
      await supabase
        .from("dpt_payout_items")
        .update({
          status: "failed",
          error_message: `Exception: ${errMsg}`,
        })
        .eq("id", item.id);

      results.push({
        item_id: item.id,
        recipient_type: item.recipient_type,
        amount,
        status: "failed",
        error: errMsg,
      });
      allSent = false;
      anyFailed = true;
    }
  }

  // Pokud všechny items sent → změna stavu
  if (allSent && !anyFailed) {
    const { error: statusErr } = await supabase.rpc("dpt_change_status", {
      p_transaction_code: tx.transaction_code,
      p_new_status: "dispute_settled",
      p_actor_role: "service",
      p_actor_email: null,
      p_note: `Spor vypořádán — odesláno ${insertedItems.length} výplat (celkem ${depositRounded.toFixed(2)} Kč)`,
    });
    if (statusErr) {
      console.error("[dispute-payouts] status change error:", statusErr);
    }
  } else if (anyFailed) {
    // Admin alert
    try {
      await supabase.from("dpt_email_logs").insert({
        transaction_id: tx.id,
        template_key: "dispute_opened_admin", // reuse existing
        to_email: process.env.ADMIN_EMAIL || "info@lokopolis.cz",
        subject: `⚠️ Dispute payout selhala — ${tx.transaction_code}`,
        status: "queued",
      });
    } catch (e) {
      console.error("[dispute-payouts] admin alert insert failed:", e);
    }
  }

  return cors(
    NextResponse.json({
      success: allSent,
      total_items: insertedItems.length,
      sent: results.filter((r) => r.status === "sent").length,
      failed: results.filter((r) => r.status === "failed").length,
      results,
    })
  );
}
