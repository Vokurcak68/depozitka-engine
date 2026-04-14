import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { corsHeaders } from "@/lib/direct-deals";

export const runtime = "nodejs";

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

export async function GET(req: Request) {
  const origin = req.headers.get("origin") || undefined;
  const url = new URL(req.url);
  const token = url.searchParams.get("token")?.trim();

  if (!token) return json(400, { ok: false, error: "MISSING_TOKEN" }, origin);

  const { data: deal, error: dealErr } = await supabase
    .from("dpt_direct_deals")
    .select("status, initiator_role, initiator_name, counterparty_email, current_version_id")
    .eq("public_token", token)
    .maybeSingle();

  if (dealErr || !deal) {
    return json(404, { ok: false, error: "NOT_FOUND" }, origin);
  }

  if (!deal.current_version_id) {
    return json(409, { ok: false, error: "MISSING_VERSION" }, origin);
  }

  const { data: v, error: verErr } = await supabase
    .from("dpt_direct_deal_versions")
    .select("version_no,status,subject,amount_czk,shipping_carrier")
    .eq("id", deal.current_version_id)
    .maybeSingle();

  if (verErr || !v) {
    return json(409, { ok: false, error: "MISSING_VERSION" }, origin);
  }

  return json(
    200,
    {
      ok: true,
      deal: {
        status: deal.status,
        subject: v.subject,
        amountCzk: v.amount_czk,
        shippingCarrier: v.shipping_carrier,
        initiatorRole: deal.initiator_role,
        initiatorName: deal.initiator_name,
        counterpartyEmail: deal.counterparty_email,
        versionNo: v.version_no,
      },
    },
    origin,
  );
}
