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

export const runtime = "nodejs";

type Body = {
  dealId: string;
  viewToken: string;
  otp: string;
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
    assert(dealId, "MISSING_DEAL_ID");
    assert(viewToken, "MISSING_VIEW_TOKEN");
    assert(otp, "MISSING_OTP");

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
    await supabase.from("dpt_deals").update({ status: "rejected" }).eq("id", dealId);

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
