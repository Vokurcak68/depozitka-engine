import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { corsHeaders } from "@/lib/direct-deals";
import { hashViewToken, safeEqual, safeText, assert } from "@/lib/deals";
import { randomId, sanitizeFilename } from "@/lib/support";
import { getSettingNumber } from "@/lib/settings";

export const runtime = "nodejs";

type Body = {
  dealId: string;
  viewToken: string;
  fileName: string;
  contentType: string;
  fileSize: number;
};

const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

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

function extFromContentType(ct: string): string {
  const t = (ct || "").toLowerCase();
  if (t.includes("image/png")) return "png";
  if (t.includes("image/webp")) return "webp";
  if (t.includes("image/gif")) return "gif";
  if (t.includes("image/jpeg") || t.includes("image/jpg")) return "jpg";
  if (t.includes("application/pdf")) return "pdf";
  return "bin";
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
    const rawFileName = safeText(body.fileName, 300);
    const contentType = (safeText(body.contentType, 120) || "").toLowerCase();
    const fileSize = Number(body.fileSize);

    if (!dealId || !viewToken) return json(400, { ok: false, error: "MISSING_DEAL_ID_OR_TOKEN" }, origin);
    if (!rawFileName || !contentType) return json(400, { ok: false, error: "MISSING_FILE_META" }, origin);
    if (!ALLOWED_TYPES.has(contentType)) return json(400, { ok: false, error: "UNSUPPORTED_TYPE" }, origin);
    if (!Number.isFinite(fileSize) || fileSize <= 0) return json(400, { ok: false, error: "INVALID_FILE_SIZE" }, origin);

    const fileName = sanitizeFilename(rawFileName);

    const maxPhotos = await getSettingNumber("deals.maxPhotos", 8);
    const maxFileSizeMb = await getSettingNumber("deals.maxFileSizeMb", 10);
    const maxBytes = maxFileSizeMb > 0 ? maxFileSizeMb * 1024 * 1024 : Infinity;

    if (fileSize > maxBytes) return json(400, { ok: false, error: "FILE_TOO_LARGE" }, origin);

    // Verify deal + token
    const { data: deal, error: dealErr } = await supabase
      .from("dpt_deals")
      .select("id,view_token_hash,view_token_expires_at")
      .eq("id", dealId)
      .maybeSingle();

    if (dealErr || !deal) return json(404, { ok: false, error: "NOT_FOUND" }, origin);

    const nowIso = new Date().toISOString();
    if ((deal.view_token_expires_at as string) < nowIso) return json(410, { ok: false, error: "VIEW_TOKEN_EXPIRED" }, origin);

    const expectedHash = String(deal.view_token_hash || "");
    const gotHash = hashViewToken(viewToken);
    if (!safeEqual(expectedHash, gotHash)) return json(403, { ok: false, error: "INVALID_VIEW_TOKEN" }, origin);

    // Attachment count guard (cheap, best-effort)
    if (maxPhotos > 0) {
      const { count } = await supabase
        .from("dpt_deal_attachments")
        .select("id", { count: "exact", head: true })
        .eq("deal_id", dealId);

      if ((count || 0) >= maxPhotos) {
        return json(400, { ok: false, error: "TOO_MANY_ATTACHMENTS" }, origin);
      }
    }

    const ext = extFromContentType(contentType);
    const storagePath = `deals/${dealId}/${Date.now()}-${randomId()}.${ext}`;

    const sb = supabase as unknown as { storage: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const { data: signed, error: signErr } = await sb.storage
      .from("dpt-deal-attachments")
      .createSignedUploadUrl(storagePath);

    if (signErr || !signed?.signedUrl) {
      return json(500, { ok: false, error: "SIGNED_URL_FAILED" }, origin);
    }

    // Record attachment metadata now (we don't know for sure upload succeeded; that's OK)
    const { error: attErr } = await supabase.from("dpt_deal_attachments").insert({
      deal_id: dealId,
      storage_path: storagePath,
      file_name: fileName,
      content_type: contentType,
      file_size: fileSize,
    });

    if (attErr) {
      return json(500, { ok: false, error: "DB_INSERT_ATTACHMENTS_FAILED" }, origin);
    }

    return json(
      200,
      {
        ok: true,
        path: storagePath,
        signedUrl: signed.signedUrl,
        token: signed.token,
      },
      origin,
    );
  } catch (e: any) {
    return json(400, { ok: false, error: e?.code || e?.message || "BAD_REQUEST" }, origin);
  }
}
