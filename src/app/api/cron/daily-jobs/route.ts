import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function cors(res: NextResponse): NextResponse {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return res;
}

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

/**
 * Master orchestrator — runs all cron jobs sequentially.
 * Vercel Hobby tier allows only 1 cron schedule, so this chains them.
 *
 * Each job failure doesn't block the next.
 * Audit log goes to dpt_cron_runs (migrace 040).
 */
export async function GET(req: NextRequest) {
  return runDailyJobs(req, "vercel_cron");
}

export async function POST(req: NextRequest) {
  return runDailyJobs(req, "manual");
}

async function runDailyJobs(req: NextRequest, triggeredBy: string): Promise<NextResponse> {
  const authError = verifyCron(req);
  if (authError) return cors(authError);

  const supabase = getSupabase();
  const baseUrl = getBaseUrl(req);
  const cronSecret = process.env.CRON_SECRET || "";

  const masterStarted = Date.now();
  const { data: masterRun } = await supabase
    .from("dpt_cron_runs")
    .insert({
      job_name: "daily-jobs",
      status: "running",
      triggered_by: triggeredBy,
    })
    .select("id")
    .single();

  // Pouze existující sub-joby (fio-payout je broken — neptat se).
  const jobs = [
    "fio-sync",
    "process-emails",
  ];

  const results: Record<string, unknown> = {};
  let errorCount = 0;

  for (const job of jobs) {
    const jobStarted = Date.now();
    const { data: jobRun } = await supabase
      .from("dpt_cron_runs")
      .insert({
        job_name: job,
        status: "running",
        triggered_by: triggeredBy,
      })
      .select("id")
      .single();

    try {
      const res = await fetch(`${baseUrl}/api/cron/${job}`, {
        headers: {
          Authorization: `Bearer ${cronSecret}`,
        },
      });
      const body = await res.json().catch(() => ({ body: "non-json" }));
      const ok = res.ok;
      results[job] = { status: res.status, ...body };

      if (jobRun?.id) {
        await supabase
          .from("dpt_cron_runs")
          .update({
            finished_at: new Date().toISOString(),
            duration_ms: Date.now() - jobStarted,
            status: ok ? "success" : "error",
            result: body,
            error_message: ok ? null : `HTTP ${res.status}`,
          })
          .eq("id", jobRun.id);
      }

      if (!ok) errorCount++;
    } catch (err) {
      console.error(`Job ${job} failed:`, err);
      const msg = err instanceof Error ? err.message : String(err);
      results[job] = { status: "error", error: msg };
      errorCount++;

      if (jobRun?.id) {
        await supabase
          .from("dpt_cron_runs")
          .update({
            finished_at: new Date().toISOString(),
            duration_ms: Date.now() - jobStarted,
            status: "error",
            error_message: msg,
          })
          .eq("id", jobRun.id);
      }
    }
  }

  if (masterRun?.id) {
    await supabase
      .from("dpt_cron_runs")
      .update({
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - masterStarted,
        status: errorCount === 0 ? "success" : "error",
        result: { jobs_run: jobs.length, errors: errorCount, results },
      })
      .eq("id", masterRun.id);
  }

  return cors(
    NextResponse.json({
      ok: errorCount === 0,
      ran_at: new Date().toISOString(),
      jobs_run: jobs.length,
      errors: errorCount,
      results,
    })
  );
}

function getBaseUrl(req: NextRequest): string {
  // Vercel sets this header
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") || "https";
  return `${proto}://${host}`;
}
