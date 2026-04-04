import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { verifyCron } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const FIO_API_BASE = process.env.FIO_API_BASE || "https://fioapi.fio.cz/v1/rest";

/**
 * Process pending payouts — generate FIO XML payment orders and submit.
 * Picks dpt_transactions with status=completed & payout_status=pending.
 */
export async function GET(req: NextRequest) {
  const authError = verifyCron(req);
  if (authError) return authError;

  const FIO_TOKEN = process.env.FIO_API_TOKEN;
  if (!FIO_TOKEN) {
    return NextResponse.json({ error: "FIO_API_TOKEN not configured" }, { status: 500 });
  }

  try {
    // Fetch transactions ready for payout
    const { data: payouts, error: fetchError } = await supabase
      .from("dpt_transactions")
      .select("id, seller_iban, payout_amount, commission_amount, payment_reference")
      .eq("status", "completed")
      .eq("payout_status", "pending")
      .limit(10);

    if (fetchError) {
      console.error("Failed to fetch payouts:", fetchError);
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }

    if (!payouts || payouts.length === 0) {
      return NextResponse.json({ processed: 0, message: "No pending payouts" });
    }

    let processed = 0;
    let errors = 0;

    for (const payout of payouts) {
      if (!payout.seller_iban || !payout.payout_amount) {
        console.error(`Payout ${payout.id}: missing IBAN or amount`);
        errors++;
        continue;
      }

      try {
        // Build FIO XML domestic payment order
        const xml = buildFioPaymentXml({
          accountTo: payout.seller_iban,
          amount: payout.payout_amount,
          vs: extractVs(payout.payment_reference),
          message: `Výplata Depozitka ${payout.payment_reference}`,
        });

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

        // Mark payout as sent
        await supabase
          .from("dpt_transactions")
          .update({
            payout_status: "sent",
            payout_sent_at: new Date().toISOString(),
          })
          .eq("id", payout.id);

        // Queue payout confirmation email
        await supabase.from("dpt_email_queue").insert({
          to_email: "", // Will be resolved from seller profile
          subject: "Výplata odeslána — Depozitka",
          html_body: `<p>Výplata ${payout.payout_amount} Kč za transakci ${payout.payment_reference} byla odeslána na váš účet.</p>`,
          status: "pending",
          attempts: 0,
          transaction_id: payout.id,
        });

        processed++;
      } catch (err) {
        console.error(`Payout ${payout.id} error:`, err);
        await supabase
          .from("dpt_transactions")
          .update({
            payout_status: "error",
            payout_error: err instanceof Error ? err.message : String(err),
          })
          .eq("id", payout.id);
        errors++;
      }
    }

    return NextResponse.json({ processed, errors, total: payouts.length });
  } catch (err) {
    console.error("fio-payout error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}

/** Extract numeric VS from payment reference like "DPT-2026-0001" */
function extractVs(ref: string | null): string {
  if (!ref) return "";
  return ref.replace(/[^0-9]/g, "");
}

/** Build FIO domestic payment XML */
function buildFioPaymentXml(params: {
  accountTo: string;
  amount: number;
  vs: string;
  message: string;
}): string {
  // IBAN → account number + bank code (CZ format)
  const iban = params.accountTo.replace(/\s/g, "");
  // CZ IBAN: CZxx BBBB PPPP PPPP PPPP PPPP
  // Bank code = positions 4-7, account = positions 8-24
  const bankCode = iban.substring(4, 8);
  const accountNumber = iban.substring(8).replace(/^0+/, "");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Import xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:noNamespaceSchemaLocation="http://www.fio.cz/schema/netbanking/import.xsd">
  <Orders>
    <DomesticTransaction>
      <accountFrom></accountFrom>
      <currency>CZK</currency>
      <amount>${params.amount.toFixed(2)}</amount>
      <accountTo>${accountNumber}</accountTo>
      <bankCode>${bankCode}</bankCode>
      <vs>${params.vs}</vs>
      <date>${new Date().toISOString().split("T")[0]}</date>
      <messageForRecipient>${escapeXml(params.message)}</messageForRecipient>
      <paymentType>431001</paymentType>
    </DomesticTransaction>
  </Orders>
</Import>`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
