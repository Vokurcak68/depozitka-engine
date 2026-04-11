import { getSupabase } from "@/lib/supabase";
import { runFioSync } from "@/lib/jobs/fio-sync";
import { runProcessEmails } from "@/lib/jobs/process-emails";

type JobName = "fio-sync" | "process-emails";
interface JobOutcome {
  ok: boolean;
  status: number;
  error?: string;
}
type JobRunner = () => Promise<JobOutcome>;

export interface DailyJobsResult {
  ok: boolean;
  ran_at: string;
  jobs_run: number;
  errors: number;
  results: Record<string, unknown>;
}

export interface CronSettings {
  dailyJobsTimesUtc: string[];
}

const DEFAULT_CRON_SETTINGS: CronSettings = {
  dailyJobsTimesUtc: ["08:00"],
};

function isValidUtcTime(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

export function normalizeTimes(values: string[] | undefined): string[] {
  const out = (values || [])
    .map((v) => v.trim())
    .filter((v) => isValidUtcTime(v))
    .sort((a, b) => a.localeCompare(b));

  return Array.from(new Set(out));
}

export async function loadCronSettings(): Promise<CronSettings> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("dpt_settings")
    .select("value")
    .eq("key", "cron")
    .maybeSingle();

  if (error) {
    console.error("Failed to load cron settings:", error.message);
    return DEFAULT_CRON_SETTINGS;
  }

  const incoming = (data?.value || {}) as Partial<CronSettings>;
  const times = normalizeTimes(incoming.dailyJobsTimesUtc);

  return {
    dailyJobsTimesUtc: times.length ? times : DEFAULT_CRON_SETTINGS.dailyJobsTimesUtc,
  };
}

export async function executeDailyJobs(triggeredBy: string): Promise<DailyJobsResult> {
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

  return {
    ok: errorCount === 0,
    ran_at: new Date().toISOString(),
    jobs_run: jobs.length,
    errors: errorCount,
    results,
  };
}

export function getUtcTimeParts(date = new Date()): { nowIso: string; hhmm: string; dayStartIso: string; dayEndIso: string } {
  const nowIso = date.toISOString();
  const hhmm = nowIso.slice(11, 16);
  const day = nowIso.slice(0, 10);

  return {
    nowIso,
    hhmm,
    dayStartIso: `${day}T00:00:00.000Z`,
    dayEndIso: `${day}T23:59:59.999Z`,
  };
}

export async function alreadyRanSlotToday(triggeredBy: string, dayStartIso: string, dayEndIso: string): Promise<boolean> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("dpt_cron_runs")
    .select("id")
    .eq("job_name", "daily-jobs")
    .eq("triggered_by", triggeredBy)
    .gte("started_at", dayStartIso)
    .lte("started_at", dayEndIso)
    .limit(1);

  if (error) {
    console.error("Failed checking existing cron slot run:", error.message);
    return false;
  }

  return !!(data && data.length > 0);
}
