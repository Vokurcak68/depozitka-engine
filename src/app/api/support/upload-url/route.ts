import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { verifyTurnstile } from "@/lib/turnstile";
import { corsHeaders, getRequestIp, hashIp, randomId, sanitizeFilename, hashToken } from "@/lib/support";

export const runtime = "nodejs";

type Body = {
  turnstileToken: string;
  ticketId: string;
  uploadToken: string;
  fileName: string;
  contentType: string;
  fileSize: number;
};

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
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin") || undefined) });
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "text/plain",
]);

export async function POST(req: Request) {
  const origin = req.headers.get("origin") || undefined;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json(400, { error: "INVALID_JSON" }, origin);
  }

  const token = (body.turnstileToken || "").trim();
  if (!token) return json(400, { error: "MISSING_TURNSTILE" }, origin);

  const ticketId = (body.ticketId || "").trim();
  if (!ticketId) return json(400, { error: "MISSING_TICKET_ID" }, origin);

  const uploadToken = (body.uploadToken || "").trim();
  if (!uploadToken) return json(400, { error: "MISSING_UPLOAD_TOKEN" }, origin);

  const contentType = (body.contentType || "").trim().toLowerCase();
  const fileSize = Number(body.fileSize || 0);
  if (!ALLOWED_TYPES.has(contentType)) return json(400, { error: "UNSUPPORTED_TYPE" }, origin);
  if (!Number.isFinite(fileSize) || fileSize <= 0) return json(400, { error: "INVALID_FILE_SIZE" }, origin);
  if (fileSize > MAX_FILE_SIZE) return json(400, { error: "FILE_TOO_LARGE" }, origin);

  const fileName = sanitizeFilename(body.fileName || "");

  // Turnstile verify
  const ip = getRequestIp(req);
  const verify = await verifyTurnstile({ token, remoteIp: ip, action: "support_upload" });
  if (!verify.success) {
    return json(403, { error: "TURNSTILE_FAILED", details: verify.error_codes || [] }, origin);
  }

  // Optional rate-limit: max 15 uploads / 10 min per IP hash
  const ipHash = hashIp(ip);
  if (ipHash) {
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from("dpt_support_tickets")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash)
      .gte("created_at", since);

    if ((count || 0) >= 15) {
      return json(429, { error: "RATE_LIMIT" }, origin);
    }
  }

  // Ensure ticket exists + validate upload token
  const { data: ticket, error: ticketErr } = await supabase
    .from("dpt_support_tickets")
    .select("id,ticket_no,upload_token_hash,upload_token_expires_at")
    .eq("id", ticketId)
    .single();

  if (ticketErr || !ticket) {
    return json(404, { error: "TICKET_NOT_FOUND" }, origin);
  }

  const now = Date.now();
  const expiresAt = ticket.upload_token_expires_at ? Date.parse(ticket.upload_token_expires_at as any) : 0;
  const expected = ticket.upload_token_hash as string | null;
  if (!expected || !expiresAt || expiresAt < now) {
    return json(403, { error: "UPLOAD_TOKEN_EXPIRED" }, origin);
  }

  const got = hashToken(uploadToken);
  if (got !== expected) {
    return json(403, { error: "UPLOAD_TOKEN_INVALID" }, origin);
  }

  const objectPath = `tickets/${ticketId}/${randomId()}-${fileName}`;

  // Signed upload URL (short-lived)
  const { data: signed, error: signErr } = await (supabase as any)
    .storage
    .from("dpt-support-attachments")
    .createSignedUploadUrl(objectPath);

  if (signErr || !signed?.signedUrl) {
    return json(500, { error: "SIGNED_URL_FAILED" }, origin);
  }

  // Record attachment metadata now (we don't know for sure upload succeeded; that's OK)
  await supabase.from("dpt_support_attachments").insert({
    ticket_id: ticketId,
    storage_path: objectPath,
    file_name: fileName,
    content_type: contentType,
    file_size: fileSize,
  });

  return json(
    200,
    {
      ticketCode: `DPT-${ticket.ticket_no}`,
      path: objectPath,
      signedUrl: signed.signedUrl,
      token: signed.token,
    },
    origin
  );
}
