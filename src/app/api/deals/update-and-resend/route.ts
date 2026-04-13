import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { corsHeaders } from "@/lib/direct-deals";
import {
  assert,
  safeText,
  normalizeEmail,
  hashViewToken,
  safeEqual,
  randomToken,
  getWebBaseUrl,
} from "@/lib/deals";
import { getTransporter, SMTP_FROM } from "@/lib/smtp";
import { getSettingNumber } from "@/lib/settings";

export const runtime = "nodejs";

type Body = {
  dealId: string;
  viewToken: string;
  initiatorRole: "buyer" | "seller";
  initiatorEmail: string;
  initiatorPhone?: string | null;
  counterpartyEmail: string;
  counterpartyPhone?: string | null;
  title: string;
  description?: string | null;
  totalAmountCzk: number;
  externalUrl?: string | null;
  externalSnapshot?: Record<string, unknown> | null;
  externalImageStoragePath?: string | null;
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

    const { data: oldDeal, error: oldErr } = await supabase
      .from("dpt_deals")
      .select("id,status,view_token_hash,view_token_expires_at")
      .eq("id", dealId)
      .maybeSingle();

    if (oldErr || !oldDeal) return json(404, { ok: false, error: "NOT_FOUND" }, origin);

    if ((oldDeal.view_token_expires_at as string) < new Date().toISOString()) {
      return json(410, { ok: false, error: "VIEW_TOKEN_EXPIRED" }, origin);
    }

    if (!safeEqual(String(oldDeal.view_token_hash || ""), hashViewToken(viewToken))) {
      return json(403, { ok: false, error: "INVALID_VIEW_TOKEN" }, origin);
    }

    if (["accepted", "cancelled", "superseded"].includes(String(oldDeal.status))) {
      return json(409, { ok: false, error: "INVALID_STATE" }, origin);
    }

    const initiatorRole = body.initiatorRole;
    assert(initiatorRole === "buyer" || initiatorRole === "seller", "INVALID_INITIATOR_ROLE");

    const initiatorEmail = normalizeEmail(body.initiatorEmail);
    const counterpartyEmail = normalizeEmail(body.counterpartyEmail);
    assert(initiatorEmail.includes("@"), "INVALID_INITIATOR_EMAIL");
    assert(counterpartyEmail.includes("@"), "INVALID_COUNTERPARTY_EMAIL");

    const title = safeText(body.title, 180);
    assert(title, "MISSING_TITLE");

    const totalAmountCzk = Number(body.totalAmountCzk);
    assert(Number.isFinite(totalAmountCzk) && totalAmountCzk > 0, "INVALID_AMOUNT");

    const dealExpiryHours = await getSettingNumber("deals.dealExpiryHours", 48);
    const viewTokenExpiryHours = await getSettingNumber("deals.viewTokenExpiryHours", 48);

    const now = Date.now();
    const expiresAt = new Date(now + dealExpiryHours * 60 * 60 * 1000).toISOString();
    const viewTokenExpiresAt = new Date(now + viewTokenExpiryHours * 60 * 60 * 1000).toISOString();

    const newViewToken = randomToken(24);
    const newViewHash = hashViewToken(newViewToken);

    const { data: newDeal, error: insErr } = await supabase
      .from("dpt_deals")
      .insert({
        status: "sent",
        initiator_role: initiatorRole,
        initiator_email: initiatorEmail,
        initiator_phone: safeText(body.initiatorPhone, 40) || null,
        counterparty_email: counterpartyEmail,
        counterparty_phone: safeText(body.counterpartyPhone, 40) || null,
        title,
        description: safeText(body.description, 8000) || null,
        total_amount_czk: totalAmountCzk,
        external_url: safeText(body.externalUrl, 800) || null,
        external_snapshot: body.externalSnapshot ?? null,
        external_image_storage_path: safeText(body.externalImageStoragePath, 500) || null,
        view_token_hash: newViewHash,
        view_token_expires_at: viewTokenExpiresAt,
        expires_at: expiresAt,
        previous_deal_id: oldDeal.id,
        ip_hash: null,
        user_agent: (req.headers.get("user-agent") || "").slice(0, 300) || null,
      })
      .select("id")
      .single();

    if (insErr || !newDeal) return json(500, { ok: false, error: "DB_INSERT_DEAL_FAILED" }, origin);

    await supabase
      .from("dpt_deals")
      .update({ status: "superseded", superseded_at: new Date().toISOString() })
      .eq("id", oldDeal.id)
      .neq("status", "accepted");

    let inviteSent = false;
    try {
      const webBase = getWebBaseUrl();
      const dealUrl = `${webBase}/deal/${newDeal.id}?t=${encodeURIComponent(newViewToken)}`;

      const transporter = getTransporter();
      await transporter.sendMail({
        from: SMTP_FROM,
        to: counterpartyEmail,
        replyTo: initiatorEmail,
        subject: "Depozitka: upravená nabídka bezpečné platby",
        text: [
          "Dobrý den,",
          "",
          `${initiatorEmail} upravil(a) nabídku bezpečné platby.`,
          "",
          `Název: ${title}`,
          `Cena: ${totalAmountCzk.toLocaleString("cs-CZ")} Kč`,
          `Otevřít nabídku: ${dealUrl}`,
        ].join("\n"),
      });

      inviteSent = true;
    } catch {
      // keep request successful
    }

    return json(
      200,
      { ok: true, dealId: String(newDeal.id), status: "sent", inviteSent },
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
