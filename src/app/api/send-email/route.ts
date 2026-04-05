import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getTransporter, SMTP_FROM } from "@/lib/smtp";
import { withCors, preflight } from "@/lib/cron-auth";
import {
  renderTemplate,
  type EmailData,
  type MarketplaceBranding,
} from "@/lib/email-templates";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Auth — same token as process-emails (manual trigger)
// ---------------------------------------------------------------------------

function verifyToken(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  const manualToken = process.env.MANUAL_EMAIL_TRIGGER_TOKEN || cronSecret;

  // Bearer header
  const authHeader = req.headers.get("authorization");
  if (manualToken && authHeader === `Bearer ${manualToken}`) return null;

  // Query param
  const qToken = req.nextUrl.searchParams.get("token");
  if (manualToken && qToken === manualToken) return null;

  // Body token (for POST)
  // Will be checked after JSON parse if needed

  if (!manualToken && process.env.NODE_ENV === "development") return null;

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

// ---------------------------------------------------------------------------
// Helpers (same as process-emails)
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
    paidAmountCzk: tx.paid_amount != null && Number(tx.paid_amount) > 0 ? formatCzk(tx.paid_amount) : undefined,
    remainingAmountCzk: tx.paid_amount != null && Number(tx.paid_amount) > 0 ? formatCzk(Number(tx.amount_czk) - Number(tx.paid_amount)) : undefined,
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
// POST /api/send-email — send email immediately (no queue)
// ---------------------------------------------------------------------------

/**
 * Expects JSON body:
 * {
 *   transaction_id: string,
 *   template_key: string,
 *   to_email: string,
 *   token?: string  // alternative auth
 * }
 *
 * Sends the email immediately via SMTP (no queue).
 * Returns { ok: true, messageId } or { ok: false, error }.
 */
export async function POST(req: NextRequest) {
  // Auth via header/query first
  const authErr = verifyToken(req);

  let body: {
    transaction_id?: string;
    template_key?: string;
    to_email?: string;
    token?: string;
  };

  try {
    body = await req.json();
  } catch {
    return withCors(
      NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 }),
    );
  }

  // Allow token in body as fallback auth
  if (authErr) {
    const manualToken = process.env.MANUAL_EMAIL_TRIGGER_TOKEN || process.env.CRON_SECRET;
    if (manualToken && body.token === manualToken) {
      // OK, authenticated via body token
    } else {
      return withCors(authErr);
    }
  }

  const { transaction_id, template_key, to_email } = body;

  if (!transaction_id || !template_key || !to_email) {
    return withCors(
      NextResponse.json(
        { ok: false, error: "Missing transaction_id, template_key, or to_email" },
        { status: 400 },
      ),
    );
  }

  try {
    // Fetch transaction
    const { data: tx, error: txErr } = await supabase
      .from("dpt_transactions")
      .select("*")
      .eq("id", transaction_id)
      .single();

    if (txErr || !tx) {
      return withCors(
        NextResponse.json(
          { ok: false, error: `Transaction not found: ${txErr?.message || "no data"}` },
          { status: 404 },
        ),
      );
    }

    // Marketplace branding
    let mp: MarketplaceBranding = { code: "unknown", name: "Depozitka" };
    if (tx.marketplace_id) {
      const resolved = await getMarketplaceBranding(tx.marketplace_id);
      if (resolved) mp = resolved;
    }

    // Escrow account
    let escrow: EscrowAccount = {};
    try {
      escrow = await getEscrowAccount();
    } catch {
      // continue with empty
    }

    // Build data + render template
    const emailData = buildEmailData(tx, mp, escrow);
    const rendered = renderTemplate(template_key, emailData);

    if (!rendered) {
      return withCors(
        NextResponse.json(
          { ok: false, error: `No template found for key: ${template_key}` },
          { status: 400 },
        ),
      );
    }

    // Ensure key exists in catalog (FK in dpt_email_logs)
    const { data: catalogRow } = await supabase
      .from("dpt_email_template_catalog")
      .select("key")
      .eq("key", template_key)
      .maybeSingle();

    if (!catalogRow?.key) {
      return withCors(
        NextResponse.json(
          { ok: false, error: `Template key not registered in dpt_email_template_catalog: ${template_key}` },
          { status: 400 },
        ),
      );
    }

    // Insert log row first (queued), then update to sent/failed
    const preview = rendered.text?.slice(0, 400) || rendered.subject;
    const { data: logRow, error: logInsertErr } = await supabase
      .from("dpt_email_logs")
      .insert({
        transaction_id,
        template_key,
        to_email: to_email.toLowerCase().trim(),
        subject: rendered.subject,
        body_preview: preview,
        provider: "smtp",
        status: "queued",
      })
      .select("id")
      .single();

    if (logInsertErr || !logRow?.id) {
      return withCors(
        NextResponse.json(
          { ok: false, error: `Failed to create email log: ${logInsertErr?.message || "unknown"}` },
          { status: 500 },
        ),
      );
    }

    // Send immediately via SMTP
    const transporter = getTransporter();
    try {
      const info = await transporter.sendMail({
        from: SMTP_FROM,
        to: to_email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });

      await supabase
        .from("dpt_email_logs")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          provider_message_id: info?.messageId || null,
          error_message: null,
        })
        .eq("id", logRow.id);

      return withCors(
        NextResponse.json({
          ok: true,
          messageId: info?.messageId || null,
          subject: rendered.subject,
          to: to_email,
          logId: logRow.id,
        }),
      );
    } catch (sendErr) {
      const sendMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
      await supabase
        .from("dpt_email_logs")
        .update({
          status: "failed",
          error_message: sendMsg,
        })
        .eq("id", logRow.id);

      return withCors(
        NextResponse.json({ ok: false, error: sendMsg, logId: logRow.id }, { status: 500 }),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[send-email] Error:", msg);
    return withCors(
      NextResponse.json({ ok: false, error: msg }, { status: 500 }),
    );
  }
}

export async function OPTIONS() {
  return preflight();
}
