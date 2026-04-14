import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { corsHeaders } from "@/lib/direct-deals";
import {
  assert,
  safeText,
  hashViewToken,
  safeEqual,
  hashOtp,
} from "@/lib/deals";
import { getSettingNumber } from "@/lib/settings";
import { getTransporter, SMTP_FROM } from "@/lib/smtp";

export const runtime = "nodejs";

type Body = {
  dealId: string;
  viewToken: string;
  otp: string;
  reason?: string | null;
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
    const otp = safeText(body.otp, 16);
    const reason = safeText(body.reason, 2000) || "";
    assert(dealId, "MISSING_DEAL_ID");
    assert(viewToken, "MISSING_VIEW_TOKEN");
    assert(otp, "MISSING_OTP");
    assert(reason, "MISSING_REJECT_REASON");

    const { data: deal, error: dealErr } = await supabase
      .from("dpt_deals")
      .select("id,status,view_token_hash,view_token_expires_at,transaction_id")
      .eq("id", dealId)
      .maybeSingle();

    if (dealErr || !deal) return json(404, { ok: false, error: "NOT_FOUND" }, origin);
    if (deal.transaction_id) return json(409, { ok: false, error: "ALREADY_ACCEPTED" }, origin);

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

    const otpMaxAttempts = await getSettingNumber("deals.otpMaxAttempts", 5);

    const { data: otpRow } = await supabase
      .from("dpt_deal_otps")
      .select("id,otp_hash,expires_at,attempts,consumed_at")
      .eq("deal_id", dealId)
      .is("consumed_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!otpRow) return json(409, { ok: false, error: "OTP_NOT_REQUESTED" }, origin);
    if (otpRow.consumed_at) return json(409, { ok: false, error: "OTP_ALREADY_USED" }, origin);
    if (String(otpRow.expires_at) < nowIso) return json(409, { ok: false, error: "OTP_EXPIRED" }, origin);
    if ((otpRow.attempts || 0) >= otpMaxAttempts) {
      return json(429, { ok: false, error: "OTP_TOO_MANY_ATTEMPTS" }, origin);
    }

    const otpOk = safeEqual(String(otpRow.otp_hash || ""), hashOtp(otp));
    await supabase
      .from("dpt_deal_otps")
      .update({ attempts: (otpRow.attempts || 0) + 1 })
      .eq("id", otpRow.id);

    if (!otpOk) return json(403, { ok: false, error: "OTP_INVALID" }, origin);

    await supabase.from("dpt_deal_otps").update({ consumed_at: nowIso }).eq("id", otpRow.id);

    // store reason (best-effort; keep reject working even if DB not migrated yet)
    const { error: rejErr } = await supabase
      .from("dpt_deals")
      .update({ status: "rejected", rejection_reason: reason } as any)
      .eq("id", dealId);

    if (rejErr) {
      const msg = String((rejErr as any)?.message || "");
      const code = String((rejErr as any)?.code || "");
      const missingColumn = code === "42703" || msg.includes("rejection_reason");

      if (!missingColumn) return json(500, { ok: false, error: "DB_UPDATE_REJECT_FAILED" }, origin);

      // fallback: update status only
      const { error: rejFallbackErr } = await supabase.from("dpt_deals").update({ status: "rejected" }).eq("id", dealId);
      if (rejFallbackErr) return json(500, { ok: false, error: "DB_UPDATE_REJECT_FAILED" }, origin);
    }

    // Notify initiator
    try {
      const { data: fullDeal } = await supabase
        .from("dpt_deals")
        .select("initiator_email,counterparty_email,title,total_amount_czk,external_url")
        .eq("id", dealId)
        .maybeSingle();

      if (fullDeal?.initiator_email) {
        const transporter = getTransporter();
        const subject = `Depozitka: nabídka byla zamítnuta`;
        const text = [
          `Dobrý den,`,
          ``,
          `Protistrana zamítla nabídku bezpečné platby.`,
          ``,
          `Název: ${fullDeal.title}`,
          `Cena: ${Number(fullDeal.total_amount_czk).toLocaleString("cs-CZ")} Kč`,
          fullDeal.external_url ? `Odkaz: ${fullDeal.external_url}` : null,
          ``,
          `Důvod zamítnutí:`,
          reason,
          ``,
          `Pokud chcete pokračovat, upravte nabídku a pošlete novou.`,
        ]
          .filter(Boolean)
          .join("\n");

        await transporter.sendMail({
          from: SMTP_FROM,
          to: String(fullDeal.initiator_email),
          replyTo: String(fullDeal.counterparty_email || "") || undefined,
          subject,
          text,
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("Reject notify initiator email failed", { dealId, error: msg });
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
