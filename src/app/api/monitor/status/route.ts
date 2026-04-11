import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function cors(res: NextResponse): NextResponse {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return res;
}

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

export async function GET() {
  const supabase = getSupabase();

  const [{ data: targets, error: targetsErr }, { data: openIncidents, error: incidentsErr }] =
    await Promise.all([
      supabase
        .from("dpt_monitor_targets")
        .select("id, code, name, url, enabled, severity")
        .eq("enabled", true)
        .order("code", { ascending: true }),
      supabase
        .from("dpt_monitor_incidents")
        .select("id, target_id, opened_at, open_reason, notifications_sent")
        .eq("status", "open")
        .order("opened_at", { ascending: false }),
    ]);

  if (targetsErr || incidentsErr) {
    return cors(
      NextResponse.json(
        {
          ok: false,
          error: targetsErr?.message || incidentsErr?.message || "failed_to_load_monitor_status",
        },
        { status: 500 },
      ),
    );
  }

  const targetList = targets || [];
  const targetIds = targetList.map((t) => t.id);

  const { data: latestChecks, error: checksErr } = await supabase
    .from("dpt_monitor_checks")
    .select("id, target_id, checked_at, ok, status_code, response_ms, error_message")
    .in("target_id", targetIds.length ? targetIds : ["00000000-0000-0000-0000-000000000000"])
    .order("checked_at", { ascending: false })
    .limit(200);

  if (checksErr) {
    return cors(NextResponse.json({ ok: false, error: checksErr.message }, { status: 500 }));
  }

  const lastByTarget = new Map<string, (typeof latestChecks)[number]>();
  for (const row of latestChecks || []) {
    if (!lastByTarget.has(row.target_id)) lastByTarget.set(row.target_id, row);
  }

  const incidentByTarget = new Map<string, (typeof openIncidents)[number]>();
  for (const inc of openIncidents || []) {
    if (!incidentByTarget.has(inc.target_id)) incidentByTarget.set(inc.target_id, inc);
  }

  const items = targetList.map((t) => {
    const last = lastByTarget.get(t.id) || null;
    const open = incidentByTarget.get(t.id) || null;

    return {
      code: t.code,
      name: t.name,
      url: t.url,
      severity: t.severity,
      status: open ? "incident" : last?.ok ? "operational" : "degraded",
      lastCheck: last,
      openIncident: open,
    };
  });

  const overall = items.some((i) => i.status === "incident")
    ? "major_outage"
    : items.some((i) => i.status === "degraded")
      ? "degraded"
      : "operational";

  return cors(
    NextResponse.json({
      ok: true,
      service: "depozitka-monitoring",
      overall,
      generatedAt: new Date().toISOString(),
      targets: items,
      openIncidents: openIncidents || [],
    }),
  );
}
