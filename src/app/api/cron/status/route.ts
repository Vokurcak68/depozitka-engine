import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { verifyCron } from "@/lib/cron-auth";
import { loadCronSettings, normalizeTimes } from "@/lib/jobs/daily-jobs";

export const dynamic = "force-dynamic";

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
 * GET /api/cron/status
 * Returns info about configured cron jobs, their last run, and next scheduled run.
 * Reads from dpt_cron_runs audit table (created in migration 040).
 */
export async function GET(req: NextRequest) {
  const authError = verifyCron(req);
  if (authError) return cors(authError);

  const supabase = getSupabase();

  const cronSettings = await loadCronSettings();
  const slots = normalizeTimes(cronSettings.dailyJobsTimesUtc);

  // Configured crons (from db + vercel wiring)
  const configured = [
    {
      name: "daily-jobs",
      path: "/api/cron/daily-jobs",
      schedulesUtc: slots,
      schedulesCron: slots.map((t) => {
        const [h, m] = t.split(":");
        return `${m} ${h} * * *`;
      }),
      description: "Master job: fio-sync + process-emails (ve slotech)",
      runs: ["fio-sync", "process-emails"],
    },
    {
      name: "monitoring",
      path: "/api/cron/monitoring",
      schedulesUtc: [],
      schedulesCron: [],
      description: "On-demand endpoint pro externí 5min trigger (UptimeRobot/BetterStack)",
      runs: ["monitoring"],
    },
  ];

  // Fetch last runs
  const { data: runs, error } = await supabase
    .from("dpt_cron_runs")
    .select("job_name, started_at, finished_at, status, result, error_message, duration_ms")
    .order("started_at", { ascending: false })
    .limit(50);

  if (error) {
    return cors(NextResponse.json({ error: error.message, configured }, { status: 500 }));
  }

  // Group last runs by job_name
  const lastByJob: Record<string, unknown> = {};
  for (const run of runs || []) {
    if (!lastByJob[run.job_name]) {
      lastByJob[run.job_name] = run;
    }
  }

  return cors(
    NextResponse.json({
      success: true,
      configured,
      lastRuns: lastByJob,
      recentRuns: runs || [],
      now: new Date().toISOString(),
    })
  );
}
