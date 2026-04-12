import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { corsHeaders, getRequestIp, randomId, sanitizeFilename, hashToken } from "@/lib/support";

export const runtime = "nodejs";

type Body = {
  // Backward compatible: we used to require Turnstile here, but we intentionally don't anymore.
  // Turnstile tokens are single-use; the create endpoint already verified it.
  // Upload security is enforced via uploadToken + expiry returned from /api/support/create.
  turnstileToken?: string;
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

  const ip = getRequestIp(req);

  // NOTE: We intentionally do NOT re-verify Turnstile here.
  // Turnstile tokens are single-use and /api/support/create already verified it.
  // Abuse is prevented by the short-lived uploadToken bound to the created ticket.

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
