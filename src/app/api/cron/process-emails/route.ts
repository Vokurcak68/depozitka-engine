import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getTransporter, SMTP_FROM } from "@/lib/smtp";
import { preflight, verifyCron, withCors } from "@/lib/cron-auth";
import {
  renderTemplate,
  type EmailData,
  type MarketplaceBranding,
} from "@/lib/email-templates";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type QueueStats = {
  source: "engine_queue" | "core_logs";
  processed: number;
  sent: number;
  failed: number;
  skipped: boolean;
  htmlRendered: number;
  error?: string;
};

// ---------------------------------------------------------------------------
// Resolve marketplace branding from DB
// ---------------------------------------------------------------------------

async function getMarketplaceBranding(
  marketplaceId: string,
): Promise<MarketplaceBranding | null> {
  const { data } = await supabase
    .from("dpt_marketplaces")
    .select(
      "code, name, logo_url, accent_color, company_name, company_address, company_id, support_email, website_url",
    )
    .eq("id", marketplaceId)
    .single();

  if (!data) return null;

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
  const { data } = await supabase
    .from("dpt_settings")
    .select("value")
    .eq("key", "escrow_account")
    .single();

  if (!data?.value) return {};
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
    marketplace: mp,
  };
}

// ---------------------------------------------------------------------------
// Process engine-native queue (dpt_email_queue)
// ---------------------------------------------------------------------------

async function processEngineQueue(batchSize: number): Promise<QueueStats> {
  const stats: QueueStats = {
    source: "engine_queue",
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: false,
    htmlRendered: 0,
  };

  const { data: emails, error: fetchError } = await supabase
    .from("dpt_email_queue")
    .select(
      "id, to_email, subject, html_body, text_body, status, attempts, created_at",
    )
    .eq("status", "pending")
    .lt("attempts", 3)
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (fetchError) {
    stats.error = fetchError.message;
    return stats;
  }

  if (!emails || emails.length === 0) {
    return stats;
  }

  const transporter = getTransporter();

  for (const email of emails) {
    try {
      await transporter.sendMail({
        from: SMTP_FROM,
        to: email.to_email,
        subject: email.subject,
        html: email.html_body || undefined,
        text: email.text_body || undefined,
      });

      await supabase
        .from("dpt_email_queue")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          attempts: email.attempts + 1,
          last_error: null,
        })
        .eq("id", email.id);

      stats.sent++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to send engine email ${email.id}:`, errorMsg);

      await supabase
        .from("dpt_email_queue")
        .update({
          status: email.attempts + 1 >= 3 ? "failed" : "pending",
          attempts: email.attempts + 1,
          last_error: errorMsg,
        })
        .eq("id", email.id);

      stats.failed++;
    }
  }

  stats.processed = emails.length;
  return stats;
}

// ---------------------------------------------------------------------------
// Process core email logs (dpt_email_logs) — with HTML template rendering
// ---------------------------------------------------------------------------

async function processCoreLogs(batchSize: number): Promise<QueueStats> {
  const stats: QueueStats = {
    source: "core_logs",
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: false,
    htmlRendered: 0,
  };

  const { data: emails, error: fetchError } = await supabase
    .from("dpt_email_logs")
    .select(
      "id, transaction_id, template_key, to_email, subject, body_preview, status, created_at",
    )
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (fetchError) {
    stats.skipped = true;
    stats.error = fetchError.message;
    return stats;
  }

  if (!emails || emails.length === 0) {
    return stats;
  }

  // Pre-fetch escrow account (same for all emails in batch)
  const escrow = await getEscrowAccount();

  // Cache marketplace branding per marketplace_id
  const mpCache = new Map<string, MarketplaceBranding | null>();

  const transporter = getTransporter();

  for (const email of emails) {
    try {
      let finalSubject = email.subject;
      let finalHtml: string | undefined;
      let finalText: string | undefined = email.body_preview || undefined;

      // Try to render HTML template if we have transaction context
      if (email.transaction_id && email.template_key) {
        try {
          // Fetch transaction
          const { data: tx } = await supabase
            .from("dpt_transactions")
            .select("*")
            .eq("id", email.transaction_id)
            .single();

          if (tx?.marketplace_id) {
            // Get or cache marketplace branding
            if (!mpCache.has(tx.marketplace_id)) {
              mpCache.set(
                tx.marketplace_id,
                await getMarketplaceBranding(tx.marketplace_id),
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
                stats.htmlRendered++;
              }
            }
          }
        } catch (renderErr) {
          // Template rendering failed — fall through to plain-text
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

      stats.sent++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to send core email ${email.id}:`, errorMsg);

      await supabase
        .from("dpt_email_logs")
        .update({
          status: "failed",
          error_message: errorMsg,
        })
        .eq("id", email.id);

      stats.failed++;
    }
  }

  stats.processed = emails.length;
  return stats;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Process email queues from both independent projects sharing one DB:
 * - dpt_email_queue (engine-native queue: pending/sent/failed)
 * - dpt_email_logs (core queue/log: queued/sent/failed) — with HTML template rendering
 */
export async function GET(req: NextRequest) {
  const authError = verifyCron(req);
  if (authError) return withCors(authError);

  const BATCH_SIZE = 20;

  try {
    const engine = await processEngineQueue(BATCH_SIZE);
    const core = await processCoreLogs(BATCH_SIZE);

    if (engine.error && !engine.processed && !core.processed && core.skipped) {
      return withCors(
        NextResponse.json(
          { error: `Queue fetch failed: ${engine.error}` },
          { status: 500 },
        ),
      );
    }

    return withCors(
      NextResponse.json({
        processed: engine.processed + core.processed,
        sent: engine.sent + core.sent,
        failed: engine.failed + core.failed,
        htmlRendered: core.htmlRendered,
        engine,
        core,
      }),
    );
  } catch (err) {
    console.error("process-emails error:", err);
    return withCors(
      NextResponse.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        { status: 500 },
      ),
    );
  }
}

export async function OPTIONS() {
  return preflight();
}
