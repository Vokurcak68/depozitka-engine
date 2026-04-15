import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { corsHeaders } from "@/lib/direct-deals";
import { assert, safeText, normalizeEmail, hashViewToken, safeEqual, getWebBaseUrl } from "@/lib/deals";
import { getTransporter, SMTP_FROM } from "@/lib/smtp";
import { buildDealInviteEmail } from "@/lib/deal-email";

export const runtime = "nodejs";

type Body = {
  dealId: string;
  viewToken: string;
};

type DealRow = {
  id: string;
  status: string;
  view_token_hash: string | null;
  view_token_expires_at: string | null;
  initiator_email: string | null;
  counterparty_email: string | null;
  title: string | null;
  total_amount_czk: number | null;
  external_url: string | null;
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
    const dealId = safeText(body.dealId, 120);
    const viewToken = safeText(body.viewToken, 200);
    assert(dealId, "MISSING_DEAL_ID");
    assert(viewToken, "MISSING_VIEW_TOKEN");

    const { data: deal, error: dealErr } = await supabase
      .from("dpt_deals")
      .select(
        "id,status,view_token_hash,view_token_expires_at,initiator_email,counterparty_email,title,description,total_amount_czk,external_url",
      )
      .eq("id", dealId)
      .maybeSingle();

    if (dealErr || !deal) return json(404, { ok: false, error: "NOT_FOUND" }, origin);

    if ((deal.view_token_expires_at as string) < new Date().toISOString()) {
      return json(410, { ok: false, error: "VIEW_TOKEN_EXPIRED" }, origin);
    }

    if (!safeEqual(String(deal.view_token_hash || ""), hashViewToken(viewToken))) {
      return json(403, { ok: false, error: "INVALID_VIEW_TOKEN" }, origin);
    }

    if (String(deal.status) !== "draft") {
      // idempotent-ish: allow re-send only from draft in MVP
      return json(409, { ok: false, error: "INVALID_STATE" }, origin);
    }

    const dealRow = deal as DealRow;
    const initiatorEmail = normalizeEmail(dealRow.initiator_email || "");
    const counterpartyEmail = normalizeEmail(dealRow.counterparty_email || "");
    assert(initiatorEmail.includes("@"), "INVALID_INITIATOR_EMAIL");
    assert(counterpartyEmail.includes("@"), "INVALID_COUNTERPARTY_EMAIL");

    const webBase = getWebBaseUrl();
    const dealUrl = `${webBase}/deal/${deal.id}?t=${encodeURIComponent(viewToken)}`;

    const transporter = getTransporter();
    const mail = buildDealInviteEmail({
      initiator: initiatorEmail,
      title: String(dealRow.title || "").slice(0, 180),
      totalAmountCzk: Number(dealRow.total_amount_czk),
      dealUrl,
      externalUrl: dealRow.external_url,
    });

    await transporter.sendMail({
      from: SMTP_FROM,
      to: counterpartyEmail,
      replyTo: initiatorEmail,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });

    const { error: updErr } = await supabase
      .from("dpt_deals")
      .update({ status: "sent" })
      .eq("id", deal.id)
      .eq("status", "draft");

    if (updErr) return json(500, { ok: false, error: "DB_UPDATE_STATUS_FAILED" }, origin);

    return json(200, { ok: true }, origin);
  } catch (e: unknown) {
    const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code?: unknown }).code) : undefined;
    const message = e instanceof Error ? e.message : String(e);
    return json(400, { ok: false, error: code || message || "BAD_REQUEST" }, origin);
  }
}
