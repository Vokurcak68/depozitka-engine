import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { corsHeaders } from "@/lib/direct-deals";
import { hashViewToken, safeEqual, safeText } from "@/lib/deals";

export const runtime = "nodejs";

type Body = {
  dealId: string;
  viewToken: string;
  storagePath: string;
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
    const storagePath = safeText(body.storagePath, 500);

    if (!dealId || !viewToken || !storagePath) {
      return json(400, { ok: false, error: "MISSING_PARAMS" }, origin);
    }

    const { data: deal, error: dealErr } = await supabase
      .from("dpt_deals")
      .select("id,view_token_hash,view_token_expires_at,external_image_storage_path")
      .eq("id", dealId)
      .maybeSingle();

    if (dealErr || !deal) return json(404, { ok: false, error: "NOT_FOUND" }, origin);

    const nowIso = new Date().toISOString();
    if ((deal.view_token_expires_at as string) < nowIso) {
      return json(410, { ok: false, error: "VIEW_TOKEN_EXPIRED" }, origin);
    }

    const expectedHash = String(deal.view_token_hash || "");
    const gotHash = hashViewToken(viewToken);
    if (!safeEqual(expectedHash, gotHash)) {
      return json(403, { ok: false, error: "INVALID_VIEW_TOKEN" }, origin);
    }

    // Ensure the path belongs to this deal (either attachment row or OG image path)
    let allowed = false;
    const ogPath = String(deal.external_image_storage_path || "");
    if (ogPath && ogPath === storagePath) {
      allowed = true;
    } else {
      const { data: att } = await supabase
        .from("dpt_deal_attachments")
        .select("id")
        .eq("deal_id", dealId)
        .eq("storage_path", storagePath)
        .maybeSingle();
      if (att) allowed = true;
    }

    if (!allowed) {
      return json(403, { ok: false, error: "FILE_NOT_ALLOWED" }, origin);
    }

    const storageClient = (supabase as unknown as {
      storage: {
        from: (bucket: string) => {
          createSignedUrl: (
            path: string,
            expiresIn: number,
          ) => Promise<{ data: { signedUrl?: string } | null; error: unknown }>;
        };
      };
    }).storage;

    const { data: signed, error: signErr } = await storageClient
      .from("dpt-deal-attachments")
      .createSignedUrl(storagePath, 60 * 60);

    if (signErr || !signed?.signedUrl) {
      return json(500, { ok: false, error: "SIGNED_URL_FAILED" }, origin);
    }

    return json(200, { ok: true, signedUrl: signed.signedUrl }, origin);
  } catch (e: unknown) {
    const code =
      typeof e === "object" && e !== null && "code" in e ? String((e as { code?: unknown }).code) : undefined;
    const message = e instanceof Error ? e.message : String(e);
    return json(400, { ok: false, error: code || message || "BAD_REQUEST" }, origin);
  }
}
