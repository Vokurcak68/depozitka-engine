import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getTransporter, SMTP_FROM } from "@/lib/smtp";
import { preflight, verifyCron, withCors } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // Vercel Hobby: max 10s, Pro: 60s

type QueueStats = {
  source: "engine_queue" | "core_logs";
  processed: number;
  sent: number;
  failed: number;
  skipped: boolean;
  error?: string;
};

async function processEngineQueue(batchSize: number): Promise<QueueStats> {
  const stats: QueueStats = {
    source: "engine_queue",
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: false,
  };

  const { data: emails, error: fetchError } = await supabase
    .from("dpt_email_queue")
    .select("id, to_email, subject, html_body, text_body, status, attempts, created_at")
    .eq("status", "pending")
    .lt("attempts", 3)
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (fetchError) {
    stats.error = fetchError.message;
    return stats;
  }

  if (!emails || emails.length === 0) {
    return stats;
  }

  const transporter = getTransporter();

  for (const email of emails) {
    try {
      await transporter.sendMail({
        from: SMTP_FROM,
        to: email.to_email,
        subject: email.subject,
        html: email.html_body || undefined,
        text: email.text_body || undefined,
      });

      await supabase
        .from("dpt_email_queue")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          attempts: email.attempts + 1,
          last_error: null,
        })
        .eq("id", email.id);

      stats.sent++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to send engine email ${email.id}:`, errorMsg);

      await supabase
        .from("dpt_email_queue")
        .update({
          status: email.attempts + 1 >= 3 ? "failed" : "pending",
          attempts: email.attempts + 1,
          last_error: errorMsg,
        })
        .eq("id", email.id);

      stats.failed++;
    }
  }

  stats.processed = emails.length;
  return stats;
}

async function processCoreLogs(batchSize: number): Promise<QueueStats> {
  const stats: QueueStats = {
    source: "core_logs",
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: false,
  };

  const { data: emails, error: fetchError } = await supabase
    .from("dpt_email_logs")
    .select("id, to_email, subject, body_preview, status, created_at")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (fetchError) {
    // Engine může běžet i bez core schématu — nepadat tvrdě, jen vrátit info.
    stats.skipped = true;
    stats.error = fetchError.message;
    return stats;
  }

  if (!emails || emails.length === 0) {
    return stats;
  }

  const transporter = getTransporter();

  for (const email of emails) {
    try {
      const info = await transporter.sendMail({
        from: SMTP_FROM,
        to: email.to_email,
        subject: email.subject,
        text: email.body_preview || undefined,
      });

      await supabase
        .from("dpt_email_logs")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          provider: "smtp",
          provider_message_id: info?.messageId || null,
          error_message: null,
        })
        .eq("id", email.id);

      stats.sent++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to send core email ${email.id}:`, errorMsg);

      await supabase
        .from("dpt_email_logs")
        .update({
          status: "failed",
          error_message: errorMsg,
        })
        .eq("id", email.id);

      stats.failed++;
    }
  }

  stats.processed = emails.length;
  return stats;
}

/**
 * Process email queues from both independent projects sharing one DB:
 * - dpt_email_queue (engine-native queue: pending/sent/failed)
 * - dpt_email_logs (core queue/log: queued/sent/failed)
 */
export async function GET(req: NextRequest) {
  const authError = verifyCron(req);
  if (authError) return withCors(authError);

  const BATCH_SIZE = 20;

  try {
    const engine = await processEngineQueue(BATCH_SIZE);
    const core = await processCoreLogs(BATCH_SIZE);

    if (engine.error && !engine.processed && !core.processed && core.skipped) {
      return withCors(
        NextResponse.json(
          { error: `Queue fetch failed: ${engine.error}` },
          { status: 500 },
        ),
      );
    }

    return withCors(
      NextResponse.json({
        processed: engine.processed + core.processed,
        sent: engine.sent + core.sent,
        failed: engine.failed + core.failed,
        engine,
        core,
      }),
    );
  } catch (err) {
    console.error("process-emails error:", err);
    return withCors(
      NextResponse.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        { status: 500 },
      ),
    );
  }
}

export async function OPTIONS() {
  return preflight();
}
