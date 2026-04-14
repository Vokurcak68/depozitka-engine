import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { verifyTurnstile } from "@/lib/turnstile";
import { getRequestIp, hashIp } from "@/lib/support";
import { corsHeaders, normalizeEmail, safeText, assert } from "@/lib/direct-deals";
import { getTransporter, SMTP_FROM } from "@/lib/smtp";

export const runtime = "nodejs";

type Body = {
  turnstileToken: string;

  initiatorRole: "buyer" | "seller";
  initiatorName: string;
  initiatorEmail: string;

  counterpartyName?: string;
  counterpartyEmail: string;

  amountCzk: number;
  shippingCarrier: string;

  subject: string;
  message?: string;
};

function getWebBaseUrl(): string {
  // Used for links in invitation emails (counterparty).
  // Must point to depozitka-web (not engine).
  const raw =
    process.env.WEB_BASE_URL ||
    process.env.NEXT_PUBLIC_WEB_BASE_URL ||
    "https://www.depozitka.eu";

  const normalized = (raw || "").trim();
  const withScheme = /^https?:\/\//i.test(normalized)
    ? normalized
    : `https://${normalized}`;

  try {
    const url = new URL(withScheme);
    url.protocol = "https:";

    if (url.hostname === "depozitka.eu") {
      url.hostname = "www.depozitka.eu";
    }

    if (
      url.hostname === "engine.depozitka.eu" ||
      url.hostname.endsWith(".vercel.app")
    ) {
      return "https://www.depozitka.eu";
    }

    return url.origin;
  } catch {
    return "https://www.depozitka.eu";
  }
}

type _BodyRemoved = {
  turnstileToken: string;

  initiatorRole: "buyer" | "seller";
  initiatorName: string;
  initiatorEmail: string;

  counterpartyName?: string;
  counterpartyEmail: string;

  amountCzk: number;
  shippingCarrier: string;

  subject: string;
  message?: string;
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
    // Turnstile tokens are often >400 chars; don't truncate or verification will fail.
    const token = safeText(body.turnstileToken, 5000);
    assert(token, "MISSING_TURNSTILE");

    const initiatorRole = body.initiatorRole;
    assert(initiatorRole === "buyer" || initiatorRole === "seller", "INVALID_INITIATOR_ROLE");

    const initiatorName = safeText(body.initiatorName, 120);
    const initiatorEmail = normalizeEmail(body.initiatorEmail);
    const counterpartyName = safeText(body.counterpartyName, 120) || null;
    const counterpartyEmail = normalizeEmail(body.counterpartyEmail);

    const subject = safeText(body.subject, 180);
    const message = safeText(body.message, 8000) || null;

    const shippingCarrier = safeText(body.shippingCarrier, 80);

    const amountCzk = Number(body.amountCzk);

    assert(initiatorName, "MISSING_INITIATOR_NAME");
    assert(initiatorEmail.includes("@"), "INVALID_INITIATOR_EMAIL");
    assert(counterpartyEmail.includes("@"), "INVALID_COUNTERPARTY_EMAIL");
    assert(subject, "MISSING_SUBJECT");
    assert(Number.isFinite(amountCzk) && amountCzk > 0, "INVALID_AMOUNT");
    assert(shippingCarrier, "MISSING_SHIPPING_CARRIER");

    // Turnstile verify
    const ip = getRequestIp(req);
    const verify = await verifyTurnstile({ token, remoteIp: ip, action: "direct_deal_create" });
    if (!verify.success) {
      const codes = (verify.error_codes && verify.error_codes.length > 0)
        ? verify.error_codes
        : ["unknown"];

      console.warn("Turnstile failed (direct_deals.create)", {
        codes,
        hostname: verify.hostname,
        action: verify.action,
      });

      return json(
        403,
        {
          ok: false,
          error: "TURNSTILE_FAILED",
          details: {
            codes,
            hostname: verify.hostname,
            action: verify.action,
          },
        },
        origin,
      );
    }

    // Rate limit: max 5 direct deals / 10 min per IP hash
    const ipHash = hashIp(ip);
    if (ipHash) {
      const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { count } = await supabase
        .from("dpt_direct_deal_versions")
        .select("id", { count: "exact", head: true })
        .eq("ip_hash", ipHash)
        .gte("created_at", since);

      if ((count || 0) >= 5) {
        return json(429, { ok: false, error: "RATE_LIMIT" }, origin);
      }
    }

    // Create deal + version (version_no = 1)
    const { data: deal, error: dealErr } = await supabase
      .from("dpt_direct_deals")
      .insert({
        status: "pending",
        initiator_role: initiatorRole,
        initiator_name: initiatorName,
        initiator_email: initiatorEmail,
        counterparty_name: counterpartyName,
        counterparty_email: counterpartyEmail,
      })
      .select("id, public_token, edit_token")
      .single();

    if (dealErr || !deal) {
      return json(500, { ok: false, error: "DB_INSERT_DEAL_FAILED" }, origin);
    }

    const { data: ver, error: verErr } = await supabase
      .from("dpt_direct_deal_versions")
      .insert({
        deal_id: deal.id,
        version_no: 1,
        status: "pending_response",
        subject,
        message,
        amount_czk: amountCzk,
        shipping_carrier: shippingCarrier,
        ip_hash: ipHash || null,
        user_agent: (req.headers.get("user-agent") || "").slice(0, 300) || null,
      })
      .select("id")
      .single();

    if (verErr || !ver) {
      return json(500, { ok: false, error: "DB_INSERT_VERSION_FAILED" }, origin);
    }

    // Point deal to current version
    await supabase
      .from("dpt_direct_deals")
      .update({ current_version_id: ver.id })
      .eq("id", deal.id);

    // Send invitation email to counterparty (link + summary)
    let inviteSent = false;
    try {
      const webBase = getWebBaseUrl();
      const dealUrl = `${webBase}/bezpecna-platba/deal/${deal.public_token}`;

      const transporter = getTransporter();
      const subjectMail = `Depozitka: návrh bezpečné platby`;
      const text = [
        `Dobrý den,`,
        ``,
        `${initiatorName} vám poslal(a) návrh bezpečné platby přes Depozitku.`,
        ``,
        `Předmět: ${subject}`,
        `Cena (vč. dopravy): ${amountCzk.toLocaleString("cs-CZ")} Kč`,
        `Dopravce: ${shippingCarrier}`,
        message ? `Poznámka: ${message}` : null,
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

      // Optional: confirmation to initiator (lightweight)
      await transporter.sendMail({
        from: SMTP_FROM,
        to: initiatorEmail,
        subject: `Depozitka: pozvánka odeslána`,
        text: [
          `Pozvánka byla odeslána na ${counterpartyEmail}.`,
          ``,
          `Link na nabídku: ${dealUrl}`,
        ].join("\n"),
      });

      inviteSent = true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("Direct deal invite email failed", { dealId: deal.id, error: msg });
    }

    return json(
      200,
      {
        ok: true,
        dealToken: String(deal.public_token),
        editToken: String((deal as unknown as { edit_token?: unknown }).edit_token),
        inviteSent,
      },
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
