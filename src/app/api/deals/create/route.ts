import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { verifyTurnstile } from "@/lib/turnstile";
import { getRequestIp, hashIp } from "@/lib/support";
import { getTransporter, SMTP_FROM } from "@/lib/smtp";
import {
  assert,
  normalizeEmail,
  safeText,
  randomToken,
  hashViewToken,
  getWebBaseUrl,
  type DealRole,
} from "@/lib/deals";
import { corsHeaders } from "@/lib/direct-deals";
import { getSettingNumber } from "@/lib/settings";

export const runtime = "nodejs";

type Attachment = {
  storagePath: string;
  fileName: string;
  contentType: string;
  fileSize: number;
};

// NOTE: attachments are now primarily handled via /api/deals/upload-url (signed upload + DB row insert).
// We keep attachments[] here for backward-compat / optional bulk-create flows.

type Body = {
  turnstileToken: string;

  initiatorRole: DealRole;
  initiatorEmail: string;
  initiatorName?: string | null;
  initiatorPhone?: string | null;

  counterpartyEmail: string;
  counterpartyName?: string | null;
  counterpartyPhone?: string | null;

  title: string;
  description?: string | null;
  totalAmountCzk: number;

  deliveryMethod?: "personal" | "carrier" | null;
  shippingTerms?: "buyer_pays" | "seller_pays" | "included" | "split" | "other" | null;
  shippingCarrier?: string | null;
  shippingNote?: string | null;
  estimatedShipDate?: string | null; // YYYY-MM-DD

  termsAccepted?: boolean;
  termsVersion?: string | null;

  externalUrl?: string | null;
  externalSnapshot?: Record<string, unknown> | null;
  externalImageStoragePath?: string | null;

  attachments?: Attachment[] | null;
};

function json(status: number, data: unknown, origin?: string) {
  return new NextResponse(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
    },
  });
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req.headers.get("origin") || undefined),
  });
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin") || undefined;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" }, origin);
  }

  try {
    // Validate + normalize
    const token = safeText(body.turnstileToken, 5000);
    assert(token, "MISSING_TURNSTILE");

    const initiatorRole = body.initiatorRole;
    assert(initiatorRole === "buyer" || initiatorRole === "seller", "INVALID_INITIATOR_ROLE");

    const initiatorEmail = normalizeEmail(body.initiatorEmail);
    const counterpartyEmail = normalizeEmail(body.counterpartyEmail);

    const initiatorName = safeText(body.initiatorName, 120) || null;
    const counterpartyName = safeText(body.counterpartyName, 120) || null;

    const initiatorPhone = safeText(body.initiatorPhone, 40) || null;
    const counterpartyPhone = safeText(body.counterpartyPhone, 40) || null;

    const deliveryMethod = (body.deliveryMethod as any) || null;
    assert(!deliveryMethod || deliveryMethod === "personal" || deliveryMethod === "carrier", "INVALID_DELIVERY_METHOD");

    const shippingTerms = (body.shippingTerms as any) || null;
    assert(
      !shippingTerms ||
        ["buyer_pays", "seller_pays", "included", "split", "other"].includes(String(shippingTerms)),
      "INVALID_SHIPPING_TERMS",
    );

    const shippingCarrier = safeText(body.shippingCarrier, 120) || null;
    const shippingNote = safeText(body.shippingNote, 500) || null;

    const estimatedShipDate = safeText(body.estimatedShipDate, 20) || null;
    if (estimatedShipDate) {
      assert(/^\d{4}-\d{2}-\d{2}$/.test(estimatedShipDate), "INVALID_ESTIMATED_SHIP_DATE");
    }

    const termsAccepted = body.termsAccepted === true;
    assert(termsAccepted, "TERMS_REQUIRED");
    const termsVersion = safeText(body.termsVersion, 50) || null;

    const title = safeText(body.title, 180);
    const description = safeText(body.description, 8000) || null;

    const totalAmountCzk = Number(body.totalAmountCzk);

    assert(initiatorEmail.includes("@"), "INVALID_INITIATOR_EMAIL");
    assert(counterpartyEmail.includes("@"), "INVALID_COUNTERPARTY_EMAIL");
    assert(title, "MISSING_TITLE");
    assert(Number.isFinite(totalAmountCzk) && totalAmountCzk > 0, "INVALID_AMOUNT");

    // Turnstile
    const ip = getRequestIp(req);
    const verify = await verifyTurnstile({ token, remoteIp: ip, action: "deals_create" });
    if (!verify.success) {
      const codes = verify.error_codes?.length ? verify.error_codes : ["unknown"];
      return json(
        403,
        { ok: false, error: "TURNSTILE_FAILED", details: { codes, hostname: verify.hostname, action: verify.action } },
        origin,
      );
    }

    // Rate limit: IP per hour (settings)
    const ipHash = hashIp(ip);
    const ipPerHour = await getSettingNumber("deals.rateLimit.ipPerHour", 10);
    if (ipHash && ipPerHour > 0) {
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count } = await supabase
        .from("dpt_deals")
        .select("id", { count: "exact", head: true })
        .eq("ip_hash", ipHash)
        .gte("created_at", since);

      if ((count || 0) >= ipPerHour) {
        return json(429, { ok: false, error: "RATE_LIMIT" }, origin);
      }
    }

    // Generate view token
    const viewToken = randomToken(24);
    const viewTokenHash = hashViewToken(viewToken);

    const dealExpiryHours = await getSettingNumber("deals.dealExpiryHours", 48);
    const viewTokenExpiryHours = await getSettingNumber("deals.viewTokenExpiryHours", 48);

    const now = Date.now();
    const expiresAt = new Date(now + dealExpiryHours * 60 * 60 * 1000).toISOString();
    const viewTokenExpiresAt = new Date(now + viewTokenExpiryHours * 60 * 60 * 1000).toISOString();

    const externalUrl = safeText(body.externalUrl, 800) || null;
    const externalSnapshot = body.externalSnapshot ?? null;
    const externalImageStoragePath = safeText(body.externalImageStoragePath, 500) || null;

    // Create deal
    const { data: deal, error: dealErr } = await supabase
      .from("dpt_deals")
      .insert({
        status: "sent",
        initiator_role: initiatorRole,
        initiator_email: initiatorEmail,
        initiator_name: initiatorName,
        initiator_phone: initiatorPhone,
        counterparty_email: counterpartyEmail,
        counterparty_name: counterpartyName,
        counterparty_phone: counterpartyPhone,
        title,
        description,
        total_amount_czk: totalAmountCzk,
        delivery_method: deliveryMethod,
        shipping_terms: shippingTerms,
        shipping_carrier: shippingCarrier,
        shipping_note: shippingNote,
        estimated_ship_date: estimatedShipDate,
        terms_accepted_at: new Date().toISOString(),
        terms_version: termsVersion,
        external_url: externalUrl,
        external_snapshot: externalSnapshot,
        external_image_storage_path: externalImageStoragePath,
        view_token_hash: viewTokenHash,
        view_token_expires_at: viewTokenExpiresAt,
        expires_at: expiresAt,
        ip_hash: ipHash || null,
        user_agent: (req.headers.get("user-agent") || "").slice(0, 300) || null,
      })
      .select("id")
      .single();

    if (dealErr || !deal) {
      // include minimal diagnostics (safe for client) to speed up debugging
      return json(
        500,
        {
          ok: false,
          error: "DB_INSERT_DEAL_FAILED",
          details: {
            code: (dealErr as any)?.code,
            message: (dealErr as any)?.message,
            details: (dealErr as any)?.details,
            hint: (dealErr as any)?.hint,
          },
        },
        origin,
      );
    }

    // Insert attachment snapshot rows
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (attachments.length > 0) {
      const maxPhotos = await getSettingNumber("deals.maxPhotos", 8);
      if (maxPhotos > 0 && attachments.length > maxPhotos) {
        return json(400, { ok: false, error: "TOO_MANY_ATTACHMENTS" }, origin);
      }

      const maxFileSizeMb = await getSettingNumber("deals.maxFileSizeMb", 10);
      const maxBytes = maxFileSizeMb > 0 ? maxFileSizeMb * 1024 * 1024 : Infinity;

      const rows = attachments.map((a) => {
        const storagePath = safeText(a.storagePath, 500);
        const fileName = safeText(a.fileName, 180);
        const contentType = safeText(a.contentType, 120);
        const fileSize = Number(a.fileSize);
        assert(storagePath, "INVALID_ATTACHMENT_PATH");
        assert(fileName, "INVALID_ATTACHMENT_NAME");
        assert(contentType, "INVALID_ATTACHMENT_TYPE");
        assert(Number.isFinite(fileSize) && fileSize > 0 && fileSize <= maxBytes, "INVALID_ATTACHMENT_SIZE");
        return {
          deal_id: deal.id,
          storage_path: storagePath,
          file_name: fileName,
          content_type: contentType,
          file_size: fileSize,
        };
      });

      const { error: attErr } = await supabase.from("dpt_deal_attachments").insert(rows);
      if (attErr) {
        return json(500, { ok: false, error: "DB_INSERT_ATTACHMENTS_FAILED" }, origin);
      }
    }

    // Send invitation email to counterparty
    let inviteSent = false;
    try {
      const webBase = getWebBaseUrl();
      const dealUrl = `${webBase}/deal/${deal.id}?t=${encodeURIComponent(viewToken)}`;

      const transporter = getTransporter();
      const subjectMail = `Depozitka: návrh bezpečné platby`;
      const text = [
        `Dobrý den,`,
        ``,
        `${initiatorEmail} vám poslal(a) návrh bezpečné platby přes Depozitku.`,
        ``,
        `Název: ${title}`,
        `Cena (vč. dopravy): ${totalAmountCzk.toLocaleString("cs-CZ")} Kč`,
        externalUrl ? `Odkaz: ${externalUrl}` : null,
        ``,
        `Otevřít nabídku: ${dealUrl}`,
        ``,
        `Na stránce si vyžádáte OTP kód a nabídku potvrdíte nebo odmítnete.`,
      ]
        .filter(Boolean)
        .join("\n");

      await transporter.sendMail({
        from: SMTP_FROM,
        to: counterpartyEmail,
        replyTo: initiatorEmail,
        subject: subjectMail,
        text,
      });

      inviteSent = true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("Deal invite email failed", { dealId: deal.id, error: msg });
    }

    return json(
      200,
      { ok: true, dealId: String(deal.id), viewToken, status: "sent", inviteSent },
      origin,
    );
  } catch (e: unknown) {
    const code =
      typeof e === "object" && e !== null && "code" in e
        ? String((e as { code?: unknown }).code)
        : undefined;

    const message = e instanceof Error ? e.message : String(e);

    return json(400, { ok: false, error: code || message || "BAD_REQUEST" }, origin);
  }
}
