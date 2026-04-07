import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { verifyCron } from "@/lib/cron-auth";

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

  // Configured crons (from vercel.json)
  const configured = [
    {
      name: "daily-jobs",
      path: "/api/cron/daily-jobs",
      schedule: "0 8 * * *",
      description: "Master job: fio-sync → expire-unpaid → shipping/delivery reminders → auto-complete",
      runs: ["fio-sync", "expire-unpaid", "shipping-reminder", "expire-unshipped", "delivery-reminder", "auto-complete"],
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
