/**
 * Email queue processor — pure function (no HTTP layer).
 *
 * Called by:
 *   - /api/cron/process-emails route (HTTP wrapper, manual trigger from Core UI)
 *   - /api/cron/daily-jobs (master orchestrator, in-process call)
 *
 * Processes ONLY dpt_email_logs (single source of truth).
 * Records with status='queued' are picked up, rendered (if they have
 * transaction_id + template_key), sent via SMTP, and marked 'sent' or 'failed'.
 *
 * The old dpt_email_queue table was deprecated on 2026-04-09 — it was a
 * leftover from earlier iterations and caused split-brain between engine
 * and core admin UI (which only reads dpt_email_logs). Migration 032
 * drops that table after porting any residual queued rows over.
 */

import { supabase } from "@/lib/supabase";
import { getTransporter, SMTP_FROM } from "@/lib/smtp";
import {
  renderTemplate,
  type EmailData,
  type MarketplaceBranding,
} from "@/lib/email-templates";
import { getOperatorBranding, applyOperatorBranding } from "@/lib/operator-branding";

export interface ProcessEmailsResult {
  ok: boolean;
  status: number;
  processed: number;
  sent: number;
  failed: number;
  htmlRendered: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Resolve marketplace branding from DB
// ---------------------------------------------------------------------------

async function getMarketplaceBranding(
  marketplaceId: string,
): Promise<MarketplaceBranding | null> {
  const { data, error } = await supabase
    .from("dpt_marketplaces")
    .select(
      "code, name, logo_url, accent_color, company_name, company_address, company_id, support_email, website_url",
    )
    .eq("id", marketplaceId)
    .maybeSingle();

  if (error || !data) return null;

  return {
    code: data.code,
    name: data.name,
    logoUrl: data.logo_url ?? undefined,
    accentColor: data.accent_color ?? undefined,
    companyName: data.company_name ?? undefined,
    companyAddress: data.company_address ?? undefined,
    companyId: data.company_id ?? undefined,
    supportEmail: data.support_email ?? undefined,
    websiteUrl: data.website_url ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Resolve escrow account settings
// ---------------------------------------------------------------------------

interface EscrowAccount {
  accountNumber?: string;
  iban?: string;
}

async function getEscrowAccount(): Promise<EscrowAccount> {
  const { data, error } = await supabase
    .from("dpt_settings")
    .select("value")
    .eq("key", "escrow_account")
    .maybeSingle();

  if (error || !data?.value) return {};
  const v = data.value as Record<string, string>;
  return {
    accountNumber: v.account_number || undefined,
    iban: v.iban || undefined,
  };
}

// ---------------------------------------------------------------------------
// Build EmailData from a transaction row + marketplace + escrow
// ---------------------------------------------------------------------------

function formatCzk(amount: number | string | null): string {
  if (amount == null) return "0,00";
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  return num.toLocaleString("cs-CZ", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDate(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return d.toLocaleDateString("cs-CZ", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildEmailData(tx: any, mp: MarketplaceBranding, escrow: EscrowAccount): EmailData {
  return {
    transactionCode: tx.transaction_code,
    externalOrderId: tx.external_order_id || "",
    listingTitle: tx.listing_title || undefined,
    buyerName: tx.buyer_name || "",
    buyerEmail: tx.buyer_email || "",
    sellerName: tx.seller_name || "",
    sellerEmail: tx.seller_email || "",
    amountCzk: formatCzk(tx.amount_czk),
    feeAmountCzk: tx.fee_amount_czk ? formatCzk(tx.fee_amount_czk) : undefined,
    payoutAmountCzk: tx.payout_amount_czk ? formatCzk(tx.payout_amount_czk) : undefined,
    paymentReference: tx.payment_reference || undefined,
    paymentDueAt: formatDate(tx.payment_due_at),
    escrowAccountNumber: escrow.accountNumber,
    escrowIban: escrow.iban,
    shippingCarrier: tx.shipping_carrier || undefined,
    shippingTrackingNumber: tx.shipping_tracking_number || undefined,
    shippingTrackingUrl: tx.shipping_tracking_url || undefined,
    shipUrl: tx.shipping_token
      ? `${process.env.NEXT_PUBLIC_ENGINE_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || "depozitka-engine.vercel.app"}`}/ship/${tx.shipping_token}`
      : undefined,
    marketplace: mp,
  };
}

// ---------------------------------------------------------------------------
// Main entry — processes dpt_email_logs with status='queued'
// ---------------------------------------------------------------------------

export async function runProcessEmails(): Promise<ProcessEmailsResult> {
  const BATCH_SIZE = 20;
  const result: ProcessEmailsResult = {
    ok: true,
    status: 200,
    processed: 0,
    sent: 0,
    failed: 0,
    htmlRendered: 0,
  };

  try {
    const { data: emails, error: fetchError } = await supabase
      .from("dpt_email_logs")
      .select(
        "id, transaction_id, template_key, to_email, subject, body_preview, status, created_at",
      )
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE);

    if (fetchError) {
      return {
        ok: false,
        status: 500,
        processed: 0,
        sent: 0,
        failed: 0,
        htmlRendered: 0,
        error: `Queue fetch failed: ${fetchError.message}`,
      };
    }

    if (!emails || emails.length === 0) {
      return result;
    }

    // Preload escrow account (for QR payment blocks in templates)
    let escrow: EscrowAccount = {};
    try {
      escrow = await getEscrowAccount();
    } catch (e) {
      console.warn("Failed to fetch escrow account, continuing with empty:", e);
    }

    // Marketplace branding cache (key = marketplace_id)
    const mpCache = new Map<string, MarketplaceBranding | null>();

    // SMTP transporter — fail loudly if it can't initialize
    let transporter;
    try {
      transporter = getTransporter();
    } catch (e) {
      const errMsg = `SMTP init failed: ${e instanceof Error ? e.message : String(e)}`;
      // Mark whole batch as failed so they're not retried endlessly without info
      for (const email of emails) {
        await supabase
          .from("dpt_email_logs")
          .update({ status: "failed", error_message: errMsg })
          .eq("id", email.id);
        result.failed++;
      }
      result.processed = emails.length;
      result.ok = false;
      result.status = 500;
      result.error = errMsg;
      return result;
    }

    for (const email of emails) {
      try {
        let finalSubject = email.subject;
        let finalHtml: string | undefined;
        let finalText: string | undefined = email.body_preview || undefined;

        if (email.transaction_id && email.template_key) {
          try {
            const { data: tx } = await supabase
              .from("dpt_transactions")
              .select("*")
              .eq("id", email.transaction_id)
              .single();

            if (tx?.marketplace_id) {
              if (!mpCache.has(tx.marketplace_id)) {
                const baseMp = await getMarketplaceBranding(tx.marketplace_id);
                const op = await getOperatorBranding();
                mpCache.set(
                  tx.marketplace_id,
                  baseMp ? applyOperatorBranding(baseMp, op) : null,
                );
              }
              const mp = mpCache.get(tx.marketplace_id);

              if (mp) {
                const emailData = buildEmailData(tx, mp, escrow);
                const rendered = renderTemplate(email.template_key, emailData);

                if (rendered) {
                  finalSubject = rendered.subject;
                  finalHtml = rendered.html;
                  finalText = rendered.text;
                  result.htmlRendered++;
                }
              }
            }
          } catch (renderErr) {
            console.warn(
              `Template render failed for ${email.id} (${email.template_key}):`,
              renderErr instanceof Error ? renderErr.message : renderErr,
            );
          }
        }

        const info = await transporter.sendMail({
          from: SMTP_FROM,
          to: email.to_email,
          subject: finalSubject,
          html: finalHtml,
          text: finalText,
        });

        await supabase
          .from("dpt_email_logs")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
            provider: "smtp",
            provider_message_id: info?.messageId || null,
            error_message: null,
          })
          .eq("id", email.id);

        result.sent++;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to send email log ${email.id}:`, errorMsg);

        await supabase
          .from("dpt_email_logs")
          .update({
            status: "failed",
            error_message: errorMsg,
          })
          .eq("id", email.id);

        result.failed++;
      }
    }

    result.processed = emails.length;
    if (result.failed > 0 && result.sent === 0) {
      result.ok = false;
      result.status = 500;
    }
    return result;
  } catch (err) {
    console.error("process-emails fatal error:", err);
    return {
      ok: false,
      status: 500,
      processed: 0,
      sent: 0,
      failed: 0,
      htmlRendered: 0,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
