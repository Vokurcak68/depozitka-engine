import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { corsHeaders } from "@/lib/direct-deals";

export const runtime = "nodejs";

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

export async function GET(req: Request) {
  const origin = req.headers.get("origin") || undefined;
  const url = new URL(req.url);
  const token = url.searchParams.get("token")?.trim();

  if (!token) return json(400, { ok: false, error: "MISSING_TOKEN" }, origin);

  const { data, error } = await supabase
    .from("dpt_direct_deals")
    .select(
      `status, initiator_role, initiator_name, counterparty_email,
       dpt_direct_deal_versions!dpt_direct_deals_current_version_id_fkey(version_no,status,subject,amount_czk,shipping_carrier)`
    )
    .eq("public_token", token)
    .maybeSingle();

  if (error || !data) {
    return json(404, { ok: false, error: "NOT_FOUND" }, origin);
  }

  const v = (data as any).dpt_direct_deal_versions;

  return json(
    200,
    {
      ok: true,
      deal: {
        status: data.status,
        subject: v?.subject,
        amountCzk: v?.amount_czk,
        shippingCarrier: v?.shipping_carrier,
        initiatorRole: data.initiator_role,
        initiatorName: data.initiator_name,
        counterpartyEmail: data.counterparty_email,
        versionNo: v?.version_no,
      },
    },
    origin,
  );
}
