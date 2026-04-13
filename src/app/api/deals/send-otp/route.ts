import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { corsHeaders } from "@/lib/direct-deals";
import {
  assert,
  safeText,
  hashViewToken,
  safeEqual,
  randomOtp6,
  hashOtp,
  getWebBaseUrl,
} from "@/lib/deals";
import { getTransporter, SMTP_FROM } from "@/lib/smtp";
import { getSettingNumber } from "@/lib/settings";

export const runtime = "nodejs";

type Body = {
  dealId: string;
  viewToken: string;
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
      .select("id,status,title,initiator_email,counterparty_email,view_token_hash,view_token_expires_at")
      .eq("id", dealId)
      .maybeSingle();

    if (dealErr || !deal) return json(404, { ok: false, error: "NOT_FOUND" }, origin);

    if (["accepted", "rejected", "expired", "cancelled", "superseded"].includes(String(deal.status))) {
      return json(409, { ok: false, error: "INVALID_STATE" }, origin);
    }

    const nowIso = new Date().toISOString();
    if ((deal.view_token_expires_at as string) < nowIso) {
      return json(410, { ok: false, error: "VIEW_TOKEN_EXPIRED" }, origin);
    }

    if (!safeEqual(String(deal.view_token_hash || ""), hashViewToken(viewToken))) {
      return json(403, { ok: false, error: "INVALID_VIEW_TOKEN" }, origin);
    }

    const otpMinResendSeconds = await getSettingNumber("deals.otpMinResendSeconds", 60);
    const otpExpiryMinutes = await getSettingNumber("deals.otpExpiryMinutes", 10);

    const { data: lastOtp } = await supabase
      .from("dpt_deal_otps")
      .select("id,last_sent_at")
      .eq("deal_id", dealId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastOtp?.last_sent_at && otpMinResendSeconds > 0) {
      const diffMs = Date.now() - Date.parse(String(lastOtp.last_sent_at));
      if (Number.isFinite(diffMs) && diffMs >= 0 && diffMs < otpMinResendSeconds * 1000) {
        return json(429, { ok: false, error: "OTP_RESEND_TOO_SOON" }, origin);
      }
    }

    const otp = randomOtp6();
    const expiresAt = new Date(Date.now() + otpExpiryMinutes * 60 * 1000).toISOString();

    const { error: otpErr } = await supabase.from("dpt_deal_otps").insert({
      deal_id: dealId,
      target_email: deal.counterparty_email,
      otp_hash: hashOtp(otp),
      expires_at: expiresAt,
      last_sent_at: new Date().toISOString(),
    });

    if (otpErr) return json(500, { ok: false, error: "OTP_CREATE_FAILED" }, origin);

    try {
      const webBase = getWebBaseUrl();
      const dealUrl = `${webBase}/deal/${dealId}?t=${encodeURIComponent(viewToken)}`;

      const transporter = getTransporter();
      await transporter.sendMail({
        from: SMTP_FROM,
        to: deal.counterparty_email,
        replyTo: deal.initiator_email,
        subject: "Depozitka: ověřovací kód (OTP)",
        text: [
          "Dobrý den,",
          "",
          `Název nabídky: ${deal.title}`,
          `Váš OTP kód: ${otp}`,
          `Platnost: ${otpExpiryMinutes} minut`,
          "",
          `Otevřít nabídku: ${dealUrl}`,
        ].join("\n"),
      });
    } catch {
      // do not fail request due to SMTP
    }

    return json(200, { ok: true }, origin);
  } catch (e: unknown) {
    const code =
      typeof e === "object" && e !== null && "code" in e
        ? String((e as { code?: unknown }).code)
        : undefined;

    const message = e instanceof Error ? e.message : String(e);
    return json(400, { ok: false, error: code || message || "BAD_REQUEST" }, origin);
  }
}
