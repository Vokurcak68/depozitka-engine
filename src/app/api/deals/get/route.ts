import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { corsHeaders } from "@/lib/direct-deals";
import { hashViewToken, safeText, safeEqual } from "@/lib/deals";

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

  const dealId = safeText(url.searchParams.get("dealId"), 120);
  const viewToken = safeText(url.searchParams.get("viewToken"), 200);

  if (!dealId || !viewToken) {
    return json(400, { ok: false, error: "MISSING_DEAL_ID_OR_TOKEN" }, origin);
  }

  const { data: deal, error: dealErr } = await supabase
    .from("dpt_deals")
    .select(
      "id,status,initiator_role,initiator_email,initiator_name,counterparty_email,counterparty_name,title,description,total_amount_czk,delivery_method,shipping_terms,shipping_carrier,shipping_note,estimated_ship_date,terms_accepted_at,terms_version,external_url,external_snapshot,external_image_storage_path,view_token_hash,view_token_expires_at,expires_at,created_at,updated_at,transaction_id"
    )
    .eq("id", dealId)
    .maybeSingle();

  if (dealErr || !deal) {
    return json(404, { ok: false, error: "NOT_FOUND" }, origin);
  }

  const nowIso = new Date().toISOString();
  if ((deal.view_token_expires_at as string) < nowIso) {
    return json(410, { ok: false, error: "VIEW_TOKEN_EXPIRED" }, origin);
  }

  const expectedHash = String(deal.view_token_hash || "");
  const gotHash = hashViewToken(viewToken);
  if (!safeEqual(expectedHash, gotHash)) {
    return json(403, { ok: false, error: "INVALID_VIEW_TOKEN" }, origin);
  }

  const { data: attachments } = await supabase
    .from("dpt_deal_attachments")
    .select("id,file_name,content_type,file_size,storage_path,created_at")
    .eq("deal_id", dealId)
    .order("created_at", { ascending: true });

  return json(
    200,
    {
      ok: true,
      deal: {
        id: deal.id,
        status: deal.status,
        initiatorRole: deal.initiator_role,
        initiatorEmail: deal.initiator_email,
        initiatorName: (deal as any).initiator_name || null,
        counterpartyEmail: deal.counterparty_email,
        counterpartyName: (deal as any).counterparty_name || null,
        title: deal.title,
        description: deal.description,
        totalAmountCzk: deal.total_amount_czk,
        deliveryMethod: (deal as any).delivery_method || null,
        shippingTerms: (deal as any).shipping_terms || null,
        shippingCarrier: (deal as any).shipping_carrier || null,
        shippingNote: (deal as any).shipping_note || null,
        estimatedShipDate: (deal as any).estimated_ship_date || null,
        termsAcceptedAt: (deal as any).terms_accepted_at || null,
        termsVersion: (deal as any).terms_version || null,
        externalUrl: deal.external_url,
        externalSnapshot: deal.external_snapshot,
        externalImageStoragePath: deal.external_image_storage_path,
        expiresAt: deal.expires_at,
        transactionId: deal.transaction_id,
        createdAt: deal.created_at,
        updatedAt: deal.updated_at,
      },
      attachments: attachments || [],
    },
    origin,
  );
}
