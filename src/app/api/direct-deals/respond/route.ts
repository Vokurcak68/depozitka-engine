import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { corsHeaders, safeText, assert, nameFromEmail } from "@/lib/direct-deals";

export const runtime = "nodejs";

type Body = { token: string; accept: boolean };

type DealWithVersion = {
  dpt_direct_deal_versions?: {
    id?: string;
    version_no?: number;
    status?: string;
    subject?: string;
    message?: string | null;
    amount_czk?: number;
    shipping_carrier?: string;
    transaction_id?: string | null;
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

    const accept = !!body.accept;

    const { data: deal, error: dealErr } = await supabase
      .from("dpt_direct_deals")
      .select(
        `id, public_token, status, initiator_role, initiator_name, initiator_email, counterparty_name, counterparty_email,
         dpt_direct_deal_versions!dpt_direct_deals_current_version_id_fkey(id,version_no,status,subject,message,amount_czk,shipping_carrier,transaction_id)`
      )
      .eq("public_token", token)
      .single();

    if (dealErr || !deal) return json(404, { ok: false, error: "NOT_FOUND" }, origin);

    const v = (deal as unknown as DealWithVersion).dpt_direct_deal_versions;
    if (!v?.id) return json(409, { ok: false, error: "MISSING_VERSION" }, origin);

    // Must be OTP-verified
    if (v.status !== "pending_otp") {
      return json(409, { ok: false, error: "OTP_REQUIRED" }, origin);
    }

    if (!accept) {
      await supabase.from("dpt_direct_deal_versions").update({ status: "rejected" }).eq("id", v.id);
      await supabase.from("dpt_direct_deals").update({ status: "rejected" }).eq("id", deal.id);
      return json(200, { ok: true }, origin);
    }

    // Create escrow transaction
    const marketplaceCode = "depozitka-direct";

    const initiatorRole = deal.initiator_role as "buyer" | "seller";

    const buyerName = initiatorRole === "buyer" ? deal.initiator_name : (deal.counterparty_name || nameFromEmail(deal.counterparty_email));
    const buyerEmail = initiatorRole === "buyer" ? deal.initiator_email : deal.counterparty_email;

    const sellerName = initiatorRole === "seller" ? deal.initiator_name : (deal.counterparty_name || nameFromEmail(deal.counterparty_email));
    const sellerEmail = initiatorRole === "seller" ? deal.initiator_email : deal.counterparty_email;

    const externalOrderId = `DD-${deal.id}-v${v.version_no}`;

    const metadata = {
      source: "direct_deal",
      direct_deal_id: deal.id,
      direct_deal_public_token: (deal as { public_token?: string }).public_token || token,
      direct_deal_version_id: v.id,
      direct_deal_version_no: v.version_no,
      subject: v.subject,
      message: v.message,
    };

    const { data: tx, error: txErr } = await supabase.rpc("dpt_create_transaction", {
      p_marketplace_code: marketplaceCode,
      p_external_order_id: externalOrderId,
      p_listing_id: null,
      p_listing_title: v.subject,
      p_buyer_name: buyerName,
      p_buyer_email: buyerEmail,
      p_seller_name: sellerName,
      p_seller_email: sellerEmail,
      p_amount_czk: v.amount_czk,
      p_payment_method: "escrow",
      p_metadata: metadata,
    });

    if (txErr || !tx) return json(500, { ok: false, error: "TX_CREATE_FAILED" }, origin);

    // Save carrier as free-text label for now (actual ship API uses normalized carrier codes later)
    // and mark source explicitly for easier filtering in core UI.
    await supabase
      .from("dpt_transactions")
      .update({ shipping_carrier: v.shipping_carrier, source: "direct_deal" })
      .eq("id", tx.id);

    await supabase.from("dpt_direct_deal_versions").update({ status: "accepted", transaction_id: tx.id }).eq("id", v.id);
    await supabase.from("dpt_direct_deals").update({ status: "accepted" }).eq("id", deal.id);

    return json(200, { ok: true, next: { type: "tx", transactionCode: tx.transaction_code } }, origin);
  } catch (e: unknown) {
    const code =
      typeof e === "object" && e !== null && "code" in e
        ? String((e as { code?: unknown }).code)
        : undefined;

    const message = e instanceof Error ? e.message : String(e);

    return json(400, { ok: false, error: code || message || "BAD_REQUEST" }, origin);
  }
}
