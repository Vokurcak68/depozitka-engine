import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { corsHeaders, normalizeEmail, randomOtp6, hashOtp, safeText, assert } from "@/lib/direct-deals";
import { getTransporter, SMTP_FROM } from "@/lib/smtp";

export const runtime = "nodejs";

type Body = { token: string };

type DealWithVersion = {
  dpt_direct_deal_versions?: {
    id?: string;
    status?: string;
    version_no?: number;
    subject?: string;
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
    assert(token, "MISSING_TOKEN");

    const { data: deal, error: dealErr } = await supabase
      .from("dpt_direct_deals")
      .select(
        `id, status, counterparty_email, current_version_id,
         dpt_direct_deal_versions!dpt_direct_deals_current_version_id_fkey(id,status,version_no,subject)`
      )
      .eq("public_token", token)
      .single();

    if (dealErr || !deal) return json(404, { ok: false, error: "NOT_FOUND" }, origin);

    const version = (deal as unknown as DealWithVersion).dpt_direct_deal_versions;
    if (!version?.id) return json(409, { ok: false, error: "MISSING_VERSION" }, origin);

    // only allow if pending response
    if (version.status !== "pending_response") {
      return json(409, { ok: false, error: "INVALID_STATE" }, origin);
    }

    const email = normalizeEmail(deal.counterparty_email);
    assert(email.includes("@"), "INVALID_EMAIL");

    const otp = randomOtp6();
    const otpHash = hashOtp(otp);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await supabase
      .from("dpt_direct_deal_otps")
      .insert({
        deal_version_id: version.id,
        otp_hash: otpHash,
        expires_at: expiresAt,
      });

    const transporter = getTransporter();
    const subject = `Depozitka: potvrzení nabídky (OTP)`;
    const text = [
      `Dobrý den,`,
      ``,
      `někdo vám poslal nabídku na Depozitce.` ,
      ``,
      `Předmět: ${version.subject}`,
      ``,
      `Váš ověřovací kód (OTP): ${otp}`,
      `Platnost: 10 minut`,
      ``,
      `Pokud jste o ničem nevěděli, email můžete ignorovat.`,
    ].join("\n");

    await transporter.sendMail({
      from: SMTP_FROM,
      to: email,
      subject,
      text,
    });

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
