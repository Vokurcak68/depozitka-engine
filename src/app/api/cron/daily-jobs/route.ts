import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";
import {
  alreadyRanSlotToday,
  executeDailyJobs,
  getUtcTimeParts,
  loadCronSettings,
  normalizeTimes,
} from "@/lib/jobs/daily-jobs";
import { runMonitoringChecks } from "@/lib/jobs/monitoring";
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

async function runDailyJobs(req: NextRequest, triggeredBy: string): Promise<NextResponse> {
  const authError = verifyCron(req);
  if (authError) return cors(authError);

  const supabase = getSupabase();

  // Monitoring běží při každém cron ticku a i při manuálním triggeru.
  let monitoring: unknown = null;
  if (triggeredBy === "vercel_cron" || triggeredBy === "manual") {
    const monStarted = Date.now();
    const { data: monRun } = await supabase
      .from("dpt_cron_runs")
      .insert({ job_name: "monitoring", status: "running", triggered_by: triggeredBy })
      .select("id")
      .single();

    try {
      monitoring = await runMonitoringChecks();
      await supabase
        .from("dpt_cron_runs")
        .update({
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - monStarted,
          status: (monitoring as { ok?: boolean })?.ok ? "success" : "error",
          result: monitoring,
          error_message: (monitoring as { ok?: boolean; errors?: string[] })?.ok
            ? null
            : (monitoring as { errors?: string[] })?.errors?.join("; ") || "Monitoring failed",
        })
        .eq("id", monRun?.id || "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      monitoring = { ok: false, error: msg };
      await supabase
        .from("dpt_cron_runs")
        .update({
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - monStarted,
          status: "error",
          result: monitoring,
          error_message: msg,
        })
        .eq("id", monRun?.id || "");
    }
  }

  // Pro scheduled běh si ověříme sloty z dpt_settings.cron.dailyJobsTimesUtc.
  // Vercel umí mít víc cron entries se stejnou path; tenhle guard zajistí,
  // že daily-jobs poběží jen v nakonfigurovaných časech a max jednou per slot/den.
  if (triggeredBy === "vercel_cron") {
    const settings = await loadCronSettings();
    const slots = normalizeTimes(settings.dailyJobsTimesUtc);
    const { hhmm, dayStartIso, dayEndIso } = getUtcTimeParts();

    if (!slots.includes(hhmm)) {
      return cors(
        NextResponse.json({
          ok: true,
          skipped: true,
          reason: `Current UTC time ${hhmm} is not in configured slots`,
          configuredSlotsUtc: slots,
          monitoring,
        }),
      );
    }

    const slotTriggeredBy = `vercel_cron@${hhmm}`;
    const duplicate = await alreadyRanSlotToday(slotTriggeredBy, dayStartIso, dayEndIso);
    if (duplicate) {
      return cors(
        NextResponse.json({
          ok: true,
          skipped: true,
          reason: `Slot ${hhmm} already executed today`,
          configuredSlotsUtc: slots,
          monitoring,
        }),
      );
    }

    const result = await executeDailyJobs(slotTriggeredBy);
    return cors(NextResponse.json({ ...result, monitoring }));
  }

  const result = await executeDailyJobs(triggeredBy);
  return cors(NextResponse.json(result));
}
