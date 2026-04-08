import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import { getSupabase } from "@/lib/supabase";
import { runFioSync } from "@/lib/jobs/fio-sync";
import { runProcessEmails } from "@/lib/jobs/process-emails";

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
 * IMPORTANT: sub-jobs are invoked as in-process function calls, NOT via HTTP fetch.
 * The previous HTTP-based approach failed with 401 because the internal Bearer
 * header relied on process.env.CRON_SECRET being readable in the master function
 * runtime, which was not always the case (Vercel may inject CRON_SECRET only into
 * the Vercel-cron-triggered request without exposing it back to user code).
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

type JobName = "fio-sync" | "process-emails";
interface JobOutcome {
  ok: boolean;
  status: number;
  error?: string;
}
type JobRunner = () => Promise<JobOutcome>;

async function runDailyJobs(req: NextRequest, triggeredBy: string): Promise<NextResponse> {
  const authError = verifyCron(req);
  if (authError) return cors(authError);

  const supabase = getSupabase();

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

  const jobs: { name: JobName; run: JobRunner }[] = [
    { name: "fio-sync", run: runFioSync },
    { name: "process-emails", run: runProcessEmails },
  ];

  const results: Record<string, unknown> = {};
  let errorCount = 0;

  for (const job of jobs) {
    const jobStarted = Date.now();
    const { data: jobRun } = await supabase
      .from("dpt_cron_runs")
      .insert({
        job_name: job.name,
        status: "running",
        triggered_by: triggeredBy,
      })
      .select("id")
      .single();

    try {
      const result = await job.run();
      const ok = result.ok;
      results[job.name] = result;

      if (jobRun?.id) {
        await supabase
          .from("dpt_cron_runs")
          .update({
            finished_at: new Date().toISOString(),
            duration_ms: Date.now() - jobStarted,
            status: ok ? "success" : "error",
            result,
            error_message: ok
              ? null
              : `${typeof result.error === "string" ? result.error : `HTTP ${result.status}`}`,
          })
          .eq("id", jobRun.id);
      }

      if (!ok) errorCount++;
    } catch (err) {
      console.error(`Job ${job.name} failed:`, err);
      const msg = err instanceof Error ? err.message : String(err);
      results[job.name] = { status: "error", error: msg };
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
    }),
  );
}
