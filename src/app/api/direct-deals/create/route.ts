import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { verifyTurnstile } from "@/lib/turnstile";
import { getRequestIp, hashIp } from "@/lib/support";
import { corsHeaders, normalizeEmail, safeText, assert } from "@/lib/direct-deals";

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

function json(status: number, data: any, origin?: string) {
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
    const token = safeText(body.turnstileToken, 400);
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
      return json(403, { ok: false, error: "TURNSTILE_FAILED" }, origin);
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
      .select("id, public_token")
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

    return json(
      200,
      {
        ok: true,
        dealToken: String(deal.public_token),
      },
      origin,
    );
  } catch (e: any) {
    return json(400, { ok: false, error: e?.code || e?.message || "BAD_REQUEST" }, origin);
  }
}
