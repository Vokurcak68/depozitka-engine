import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { verifyTurnstile } from "@/lib/turnstile";
import { corsHeaders, getRequestIp, hashIp, randomId, hashToken } from "@/lib/support";
import { sendSupportEmails } from "@/lib/support-email";

export const runtime = "nodejs";

type Body = {
  turnstileToken: string;
  email: string;
  name?: string;
  category?: string;
  subject: string;
  message: string;
  pageUrl?: string;
  transactionRef?: string;
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
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin") || undefined) });
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin") || undefined;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json(400, { error: "INVALID_JSON" }, origin);
  }

  const email = (body.email || "").trim();
  const subject = (body.subject || "").trim();
  const message = (body.message || "").trim();
  const token = (body.turnstileToken || "").trim();

  if (!token) return json(400, { error: "MISSING_TURNSTILE" }, origin);
  if (!email || !email.includes("@")) return json(400, { error: "INVALID_EMAIL" }, origin);
  if (!subject) return json(400, { error: "MISSING_SUBJECT" }, origin);
  if (!message) return json(400, { error: "MISSING_MESSAGE" }, origin);
  if (subject.length > 160) return json(400, { error: "SUBJECT_TOO_LONG" }, origin);
  if (message.length > 8000) return json(400, { error: "MESSAGE_TOO_LONG" }, origin);

  // Turnstile verify
  const ip = getRequestIp(req);
  const verify = await verifyTurnstile({ token, remoteIp: ip, action: "support_create" });
  if (!verify.success) {
    return json(403, { error: "TURNSTILE_FAILED", details: verify.error_codes || [] }, origin);
  }

  // Basic rate-limit: max 5 tickets / 10 min per IP hash
  const ipHash = hashIp(ip);
  if (ipHash) {
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from("dpt_support_tickets")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash)
      .gte("created_at", since);

    if ((count || 0) >= 5) {
      return json(429, { error: "RATE_LIMIT" }, origin);
    }
  }

  const ua = req.headers.get("user-agent")?.slice(0, 300) || null;

  const uploadToken = randomId(24);
  const uploadTokenHash = hashToken(uploadToken);
  const uploadTokenExpiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("dpt_support_tickets")
    .insert({
      status: "open",
      email,
      name: (body.name || "").trim() || null,
      category: (body.category || "").trim() || null,
      subject,
      message,
      page_url: (body.pageUrl || "").trim() || null,
      transaction_ref: (body.transactionRef || "").trim() || null,
      ip_hash: ipHash || null,
      user_agent: ua,
      upload_token_hash: uploadTokenHash,
      upload_token_expires_at: uploadTokenExpiresAt,
      submitted_at: new Date().toISOString(),
    })
    .select("id,ticket_no")
    .single();

  if (error || !data) {
    return json(500, { error: "DB_INSERT_FAILED" }, origin);
  }

  const ticketId = data.id as string;
  const ticketNo = data.ticket_no as number;
  const ticketCode = `DPT-${ticketNo}`;

  // Fire-and-forget-ish: attempt to send email, but don't fail the whole request if SMTP hiccups.
  try {
    const bodyText = [
      `Ticket: ${ticketCode}`,
      `Email: ${email}`,
      body.name ? `Jméno: ${body.name}` : null,
      body.category ? `Kategorie: ${body.category}` : null,
      body.pageUrl ? `URL: ${body.pageUrl}` : null,
      body.transactionRef ? `Reference: ${body.transactionRef}` : null,
      ``,
      `Zpráva:`,
      message,
    ]
      .filter(Boolean)
      .join("\n");

    await sendSupportEmails({
      ticketCode,
      toUserEmail: email,
      subject,
      bodyText,
    });
  } catch {
    // ignore
  }

  return json(
    200,
    {
      ticketId,
      ticketNo,
      ticketCode,
      uploadToken,
      uploadTokenExpiresAt,
    },
    origin
  );
}
