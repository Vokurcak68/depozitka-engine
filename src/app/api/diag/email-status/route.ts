import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { verifyCron, withCors, preflight } from "@/lib/cron-auth";
import { verifySmtp, SMTP_FROM } from "@/lib/smtp";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const authError = verifyCron(req);
  if (authError) return withCors(authError);

  const diag: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
  };

  // 1. SMTP connectivity test
  try {
    await verifySmtp();
    diag.smtp = { ok: true };
  } catch (err) {
    diag.smtp = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 2. Queue stats from dpt_email_logs (core)
  try {
    const { data: coreStats, error } = await supabase
      .from("dpt_email_logs")
      .select("status")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      diag.coreLogs = { error: error.message };
    } else {
      const counts: Record<string, number> = {};
      for (const row of coreStats || []) {
        counts[row.status] = (counts[row.status] || 0) + 1;
      }
      diag.coreLogs = { total: coreStats?.length || 0, byStatus: counts };
    }
  } catch (err) {
    diag.coreLogs = {
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 3. (removed) dpt_email_queue — deprecated 2026-04-09, single source = dpt_email_logs

  // 4. Last 5 failed emails with error detail
  try {
    const { data: failed } = await supabase
      .from("dpt_email_logs")
      .select("id, template_key, to_email, status, error_message, created_at")
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(5);

    diag.recentFailed = failed || [];
  } catch {
    /* ignore */
  }

  // 5. Last 5 queued (stuck) emails
  try {
    const { data: queued } = await supabase
      .from("dpt_email_logs")
      .select(
        "id, template_key, to_email, status, error_message, created_at",
      )
      .eq("status", "queued")
      .order("created_at", { ascending: false })
      .limit(5);

    diag.stuckQueued = queued || [];
  } catch {
    /* ignore */
  }

  // 6. Env var presence check (no values exposed)
  diag.envPresent = {
    SMTP_HOST: !!process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT || "(default)",
    SMTP_USER: !!process.env.SMTP_USER,
    SMTP_PASS: !!process.env.SMTP_PASS,
    SMTP_FROM: process.env.SMTP_FROM || "(default noreplay@depozitka.eu)",
    SMTP_SECURE: process.env.SMTP_SECURE || "(default)",
    SUPABASE_URL: !!process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    CRON_SECRET: !!process.env.CRON_SECRET,
    MANUAL_EMAIL_TRIGGER_TOKEN: !!process.env.MANUAL_EMAIL_TRIGGER_TOKEN,
  };

  return withCors(NextResponse.json(diag));
}

export async function OPTIONS() {
  return preflight();
}
