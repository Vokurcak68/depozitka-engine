import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { verifyCron } from "@/lib/cron-auth";

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

/**
 * "1234567890/0100" → { accountNumber, bankCode }
 * Akceptuje i pomlčky v čísle účtu (např. "19-2000145399/0800").
 */
function splitBankAccount(account: string): { accountNumber: string; bankCode: string } | null {
  const trimmed = account.trim();
  const match = trimmed.match(/^(\d[\d-]*)\/(\d{4})$/);
  if (!match) return null;
  return { accountNumber: match[1], bankCode: match[2] };
}

/**
 * IBAN (CZxx BBBB PPPP PPPP PPPP PPPP) → { accountNumber (bez vedoucích nul), bankCode }.
 * IBAN má standardní strukturu: CZ kontrola(2) bank(4) prefix(6) account(10).
 * Vrací číslo bez prefixu/pomlčky pro FIO importIB.xsd schema.
 */
function ibanToAccount(iban: string): { accountNumber: string; bankCode: string } | null {
  const cleaned = iban.replace(/\s/g, "").toUpperCase();
  if (!/^CZ\d{22}$/.test(cleaned)) return null;
  const bankCode = cleaned.substring(4, 8);
  // Position 8-13 = prefix (6 digits), 14-23 = account number (10 digits)
  const prefix = cleaned.substring(8, 14).replace(/^0+/, "");
  const account = cleaned.substring(14).replace(/^0+/, "");
  const accountNumber = prefix ? `${prefix}-${account}` : account;
  return { accountNumber, bankCode };
}

/**
 * POST /api/payout
 * Manuální výplata prodávajícímu — odešle FIO platební příkaz.
 *
 * Body: { transaction_id: string }
 * Auth: CRON_SECRET (Bearer / query / body)
 *
 * Vyžaduje env var FIO_SOURCE_ACCOUNT (formát "1234567890/0100") = zdrojový účet pro výplatu.
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
      NextResponse.json(
        { error: "FIO_SOURCE_ACCOUNT není nastavený (formát '1234567890/0100')." },
        { status: 500 }
      )
    );
  }

  const sourceParsed = splitBankAccount(FIO_SOURCE);
  if (!sourceParsed) {
    return cors(
      NextResponse.json(
        { error: `FIO_SOURCE_ACCOUNT má neplatný formát: '${FIO_SOURCE}'. Očekávám '1234567890/0100'.` },
        { status: 500 }
      )
    );
  }

  const body = await req.json();
  const { transaction_id } = body;

  if (!transaction_id) {
    return cors(NextResponse.json({ error: "Chybí transaction_id." }, { status: 400 }));
  }

  const supabase = getSupabase();

  const { data: tx, error: txErr } = await supabase
    .from("dpt_transactions")
    .select("*")
    .eq("id", transaction_id)
    .single();

  if (txErr || !tx) {
    return cors(NextResponse.json({ error: "Transakce nenalezena." }, { status: 404 }));
  }

  if (!["delivered", "completed", "auto_completed"].includes(tx.status)) {
    return cors(
      NextResponse.json(
        {
          error: `Výplata možná jen z delivered/completed/auto_completed (aktuální: ${tx.status}).`,
        },
        { status: 400 }
      )
    );
  }

  const iban = tx.seller_payout_iban;
  if (!iban) {
    return cors(
      NextResponse.json({ error: "Prodávající nemá nastavený IBAN pro výplatu." }, { status: 400 })
    );
  }

  const targetParsed = ibanToAccount(iban);
  if (!targetParsed) {
    return cors(
      NextResponse.json(
        { error: `Neplatný IBAN prodávajícího: '${iban}'.` },
        { status: 400 }
      )
    );
  }

  const payoutAmount = Number(tx.payout_amount_czk);
  if (!payoutAmount || payoutAmount <= 0) {
    return cors(NextResponse.json({ error: "Částka výplaty je 0 nebo neplatná." }, { status: 400 }));
  }

  const cleanIban = iban.replace(/\s/g, "").toUpperCase();
  const vs = (tx.payment_reference || tx.transaction_code || "").replace(/[^0-9]/g, "");
  const today = new Date().toISOString().split("T")[0];
  const message = `Vyplata ${tx.transaction_code}`;

  // Build FIO XML — schéma importIB.xsd, accountFrom MUSÍ být vyplněný (jinak FIO tiše zahodí).
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Import xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.fio.cz/schema/importIB.xsd">
  <Orders>
    <DomesticTransaction>
      <accountFrom>${escapeXml(sourceParsed.accountNumber)}</accountFrom>
      <currency>CZK</currency>
      <amount>${payoutAmount.toFixed(2)}</amount>
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
      await supabase.from("dpt_payout_log").insert({
        transaction_id: tx.id,
        transaction_code: tx.transaction_code,
        amount_czk: payoutAmount,
        iban: cleanIban,
        account_name: tx.seller_payout_account_name || null,
        variable_symbol: vs || null,
        status: "failed",
        error_message: `FIO ${fioRes.status}: ${fioText.substring(0, 1500)}`,
        triggered_by: "manual",
      });
      return cors(
        NextResponse.json(
          {
            error: "FIO API odmítla import",
            fio_status: fioRes.status,
            fio_response: fioText.substring(0, 1000),
          },
          { status: 502 }
        )
      );
    }

    // Log success
    await supabase.from("dpt_payout_log").insert({
      transaction_id: tx.id,
      transaction_code: tx.transaction_code,
      amount_czk: payoutAmount,
      iban: cleanIban,
      account_name: tx.seller_payout_account_name || null,
      variable_symbol: vs || null,
      fio_response: fioText.substring(0, 2000),
      status: "sent",
      triggered_by: "manual",
    });

    // Change tx status → payout_sent
    const { error: statusErr } = await supabase.rpc("dpt_change_status", {
      p_transaction_code: tx.transaction_code,
      p_new_status: "payout_sent",
      p_actor_role: "service",
      p_actor_email: null,
      p_note: `Výplata ${payoutAmount.toFixed(2)} Kč odeslána na ${cleanIban}`,
    });

    if (statusErr) {
      console.error("Payout status change error:", statusErr);
    }

    return cors(
      NextResponse.json({
        success: true,
        amount: payoutAmount,
        iban: cleanIban,
        from_account: FIO_SOURCE,
        fio_response: fioText.substring(0, 500),
      })
    );
  } catch (err) {
    console.error("Payout error:", err);
    return cors(
      NextResponse.json(
        {
          error: err instanceof Error ? err.message : "Chyba při odesílání výplaty.",
        },
        { status: 500 }
      )
    );
  }
}
