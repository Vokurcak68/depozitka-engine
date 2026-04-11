import { NextRequest, NextResponse } from "next/server";
import { preflight, verifyCron, withCors } from "@/lib/cron-auth";
import { runMonitoringChecks } from "@/lib/jobs/monitoring";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(triggeredBy: string) {
  const supabase = getSupabase();
  const started = Date.now();

  const { data: runRow } = await supabase
    .from("dpt_cron_runs")
    .insert({ job_name: "monitoring", status: "running", triggered_by: triggeredBy })
    .select("id")
    .single();

  try {
    const result = await runMonitoringChecks();

    await supabase
      .from("dpt_cron_runs")
      .update({
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - started,
        status: result.ok ? "success" : "error",
        result,
        error_message: result.ok ? null : result.errors?.join("; ") || "Monitoring failed",
      })
      .eq("id", runRow?.id || "");

    return withCors(NextResponse.json(result, { status: result.status || 200 }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase
      .from("dpt_cron_runs")
      .update({
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - started,
        status: "error",
        result: { ok: false, error: msg },
        error_message: msg,
      })
      .eq("id", runRow?.id || "");

    return withCors(NextResponse.json({ ok: false, error: msg }, { status: 500 }));
  }
}

export async function GET(req: NextRequest) {
  const authError = verifyCron(req);
  if (authError) return withCors(authError);
  return run("manual");
}

export async function POST(req: NextRequest) {
  return GET(req);
}

export async function OPTIONS() {
  return preflight();
}
