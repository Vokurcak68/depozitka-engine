import { getSupabase } from "@/lib/supabase";
import { getTransporter, SMTP_FROM } from "@/lib/smtp";

interface MonitorTarget {
  id: string;
  code: string;
  name: string;
  url: string;
  method: string;
  timeout_ms: number;
  expected_statuses: number[];
  enabled: boolean;
  severity: "critical" | "high" | "low";
}

interface MonitorCheckRow {
  id: string;
  ok: boolean;
  status_code: number | null;
  checked_at: string;
}

interface OpenIncident {
  id: string;
  opened_at: string;
  notifications_sent: number;
  last_notified_at: string | null;
}

export interface MonitoringResult {
  ok: boolean;
  status: number;
  checked: number;
  healthy: number;
  failed: number;
  openedIncidents: number;
  closedIncidents: number;
  alertsSent: number;
  errors?: string[];
}

interface MonitorSettings {
  alertEmails?: string[];
  reminderMinutes?: number;
}

const DEFAULT_REMINDER_MINUTES = 60;

function uniqueEmails(values: (string | undefined | null)[]): string[] {
  const out = values
    .map((v) => (typeof v === "string" ? v.trim().toLowerCase() : ""))
    .filter((v) => v.includes("@"));
  return Array.from(new Set(out));
}

async function loadMonitorSettings(): Promise<MonitorSettings> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("dpt_settings")
    .select("value")
    .eq("key", "monitoring")
    .maybeSingle();

  return (data?.value || {}) as MonitorSettings;
}

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

async function checkTarget(target: MonitorTarget): Promise<{ ok: boolean; statusCode: number | null; responseMs: number | null; error: string | null }> {
  const started = Date.now();
  try {
    const res = await fetch(target.url, {
      method: target.method || "GET",
      redirect: "follow",
      cache: "no-store",
      signal: timeoutSignal(Math.max(1000, target.timeout_ms || 10000)),
    });

    const elapsed = Date.now() - started;
    const expected = Array.isArray(target.expected_statuses) && target.expected_statuses.length > 0
      ? target.expected_statuses
      : [200];

    return {
      ok: expected.includes(res.status),
      statusCode: res.status,
      responseMs: elapsed,
      error: null,
    };
  } catch (err) {
    const elapsed = Date.now() - started;
    return {
      ok: false,
      statusCode: null,
      responseMs: elapsed,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

async function sendAlertEmail(to: string[], subject: string, text: string): Promise<boolean> {
  if (!to.length) return false;
  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: SMTP_FROM,
      to: to.join(","),
      subject,
      text,
    });
    return true;
  } catch (err) {
    console.error("Monitoring alert email failed:", err);
    return false;
  }
}

export async function runMonitoringChecks(): Promise<MonitoringResult> {
  const supabase = getSupabase();
  const errors: string[] = [];
  let checked = 0;
  let healthy = 0;
  let failed = 0;
  let openedIncidents = 0;
  let closedIncidents = 0;
  let alertsSent = 0;

  const settings = await loadMonitorSettings();
  const alertEmails = uniqueEmails([
    ...(Array.isArray(settings.alertEmails) ? settings.alertEmails : []),
    process.env.ADMIN_EMAIL,
    process.env.SMTP_USER,
  ]);
  const reminderMinutes = Number(settings.reminderMinutes || DEFAULT_REMINDER_MINUTES);

  const { data: targets, error: targetsErr } = await supabase
    .from("dpt_monitor_targets")
    .select("id, code, name, url, method, timeout_ms, expected_statuses, enabled, severity")
    .eq("enabled", true)
    .order("code", { ascending: true });

  if (targetsErr) {
    return {
      ok: false,
      status: 500,
      checked: 0,
      healthy: 0,
      failed: 0,
      openedIncidents: 0,
      closedIncidents: 0,
      alertsSent: 0,
      errors: [targetsErr.message],
    };
  }

  for (const target of (targets || []) as MonitorTarget[]) {
    checked++;
    const probe = await checkTarget(target);

    const { data: insertedCheck, error: insertErr } = await supabase
      .from("dpt_monitor_checks")
      .insert({
        target_id: target.id,
        ok: probe.ok,
        status_code: probe.statusCode,
        response_ms: probe.responseMs,
        error_message: probe.error,
        meta: { code: target.code, url: target.url },
      })
      .select("id")
      .single();

    if (insertErr) {
      failed++;
      errors.push(`${target.code}: failed to insert check (${insertErr.message})`);
      continue;
    }

    if (probe.ok) healthy++;
    else failed++;

    const { data: openIncident } = await supabase
      .from("dpt_monitor_incidents")
      .select("id, opened_at, notifications_sent, last_notified_at")
      .eq("target_id", target.id)
      .eq("status", "open")
      .maybeSingle();

    const { data: lastChecks, error: histErr } = await supabase
      .from("dpt_monitor_checks")
      .select("id, ok, status_code, checked_at")
      .eq("target_id", target.id)
      .order("checked_at", { ascending: false })
      .limit(2);

    if (histErr) {
      errors.push(`${target.code}: failed to load check history (${histErr.message})`);
      continue;
    }

    const checks = (lastChecks || []) as MonitorCheckRow[];
    const twoFails = checks.length >= 2 && checks[0].ok === false && checks[1].ok === false;
    const twoSuccess = checks.length >= 2 && checks[0].ok === true && checks[1].ok === true;

    if (!openIncident && twoFails) {
      const reason = `2 po sobě jdoucí neúspěšné kontroly (${checks[0].status_code ?? "ERR"}, ${checks[1].status_code ?? "ERR"})`;
      const { error: openErr } = await supabase
        .from("dpt_monitor_incidents")
        .insert({
          target_id: target.id,
          status: "open",
          open_reason: reason,
          opened_check_id: insertedCheck?.id || null,
        });

      if (openErr) {
        errors.push(`${target.code}: failed to open incident (${openErr.message})`);
      } else {
        openedIncidents++;
        const sent = await sendAlertEmail(
          alertEmails,
          `🚨 Depozitka monitoring: incident OPEN (${target.name})`,
          [
            `Target: ${target.name}`,
            `URL: ${target.url}`,
            `Severity: ${target.severity}`,
            `Reason: ${reason}`,
            `Time: ${new Date().toISOString()}`,
          ].join("\n"),
        );

        if (sent) {
          alertsSent++;
          await supabase
            .from("dpt_monitor_incidents")
            .update({ notifications_sent: 1, last_notified_at: new Date().toISOString() })
            .eq("target_id", target.id)
            .eq("status", "open");
        }
      }

      continue;
    }

    if (openIncident && twoSuccess) {
      const reason = "2 po sobě jdoucí úspěšné kontroly";
      const { error: closeErr } = await supabase
        .from("dpt_monitor_incidents")
        .update({
          status: "closed",
          closed_at: new Date().toISOString(),
          close_reason: reason,
          closed_check_id: insertedCheck?.id || null,
        })
        .eq("id", openIncident.id);

      if (closeErr) {
        errors.push(`${target.code}: failed to close incident (${closeErr.message})`);
      } else {
        closedIncidents++;
        const sent = await sendAlertEmail(
          alertEmails,
          `✅ Depozitka monitoring: incident RESOLVED (${target.name})`,
          [
            `Target: ${target.name}`,
            `URL: ${target.url}`,
            `Reason: ${reason}`,
            `Time: ${new Date().toISOString()}`,
          ].join("\n"),
        );
        if (sent) alertsSent++;
      }

      continue;
    }

    if (openIncident) {
      const lastNotifiedAt = openIncident.last_notified_at
        ? new Date(openIncident.last_notified_at).getTime()
        : 0;
      const due = Date.now() - lastNotifiedAt >= reminderMinutes * 60_000;

      if (due) {
        const sent = await sendAlertEmail(
          alertEmails,
          `⏱️ Depozitka monitoring: incident trvá (${target.name})`,
          [
            `Target: ${target.name}`,
            `URL: ${target.url}`,
            `Open since: ${openIncident.opened_at}`,
            `Last status: ${probe.statusCode ?? "ERR"}`,
            `Time: ${new Date().toISOString()}`,
          ].join("\n"),
        );

        if (sent) {
          alertsSent++;
          await supabase
            .from("dpt_monitor_incidents")
            .update({
              notifications_sent: (openIncident.notifications_sent || 0) + 1,
              last_notified_at: new Date().toISOString(),
            })
            .eq("id", openIncident.id);
        }
      }
    }
  }

  return {
    ok: true,
    status: 200,
    checked,
    healthy,
    failed,
    openedIncidents,
    closedIncidents,
    alertsSent,
    ...(errors.length ? { errors } : {}),
  };
}
