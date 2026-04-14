import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { corsHeaders, hashOtp, safeText, assert } from "@/lib/direct-deals";

export const runtime = "nodejs";

type Body = { token: string; otp: string };

type DealWithVersion = {
  dpt_direct_deal_versions?: {
    id?: string;
    status?: string;
  } | null;
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
    const token = safeText(body.token, 80);
    const otp = safeText(body.otp, 16);
    assert(token, "MISSING_TOKEN");
    assert(otp, "MISSING_OTP");

    const { data: deal, error: dealErr } = await supabase
      .from("dpt_direct_deals")
      .select(
        `id, current_version_id,
         dpt_direct_deal_versions!dpt_direct_deals_current_version_id_fkey(id,status)`
      )
      .eq("public_token", token)
      .single();

    if (dealErr || !deal) return json(404, { ok: false, error: "NOT_FOUND" }, origin);

    const version = (deal as unknown as DealWithVersion).dpt_direct_deal_versions;
    if (!version?.id) return json(409, { ok: false, error: "MISSING_VERSION" }, origin);
    if (version.status !== "pending_response") return json(409, { ok: false, error: "INVALID_STATE" }, origin);

    const nowIso = new Date().toISOString();

    // latest active OTP
    const { data: otpRow } = await supabase
      .from("dpt_direct_deal_otps")
      .select("id, otp_hash, expires_at, attempts, consumed_at")
      .eq("deal_version_id", version.id)
      .is("consumed_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!otpRow) return json(409, { ok: false, error: "OTP_NOT_REQUESTED" }, origin);
    if (otpRow.consumed_at) return json(409, { ok: false, error: "OTP_ALREADY_USED" }, origin);
    if (otpRow.expires_at < nowIso) return json(409, { ok: false, error: "OTP_EXPIRED" }, origin);
    if ((otpRow.attempts || 0) >= 5) return json(429, { ok: false, error: "OTP_TOO_MANY_ATTEMPTS" }, origin);

    const ok = otpRow.otp_hash === hashOtp(otp);

    // increment attempts regardless
    await supabase
      .from("dpt_direct_deal_otps")
      .update({ attempts: (otpRow.attempts || 0) + 1 })
      .eq("id", otpRow.id);

    if (!ok) return json(403, { ok: false, error: "OTP_INVALID" }, origin);

    await supabase
      .from("dpt_direct_deal_otps")
      .update({ consumed_at: nowIso })
      .eq("id", otpRow.id);

    await supabase
      .from("dpt_direct_deal_versions")
      .update({ status: "pending_otp" })
      .eq("id", version.id);

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
