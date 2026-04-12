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
  pushoverEnabled?: boolean;
  pushoverUserKeys?: string[];
  pushoverPriority?: number;
  pushoverSound?: string;
}

const DEFAULT_REMINDER_MINUTES = 60;

function uniqueEmails(values: (string | undefined | null)[]): string[] {
  const out = values
    .map((v) => (typeof v === "string" ? v.trim().toLowerCase() : ""))
    .filter((v) => v.includes("@"));
  return Array.from(new Set(out));
}

function uniquePushoverUsers(values: (string | undefined | null)[]): string[] {
  const out = values
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => /^[A-Za-z0-9]{20,}$/.test(v));
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

const STATUS_PAGE_URL = (process.env.STATUS_PUBLIC_URL || "https://status.depozitka.eu").trim();
const CORE_URL = (process.env.CORE_PUBLIC_URL || "https://core.depozitka.eu").trim();
const ENGINE_URL = (process.env.ENGINE_PUBLIC_URL || "https://engine.depozitka.eu").trim();

function inferComponent(target: Pick<MonitorTarget, "code" | "url">): "core" | "engine" | "unknown" {
  const code = (target.code || "").toLowerCase();
  const url = (target.url || "").toLowerCase();

  if (code.startsWith("core") || url.includes("core.depozitka.eu")) return "core";
  if (code.startsWith("engine") || url.includes("engine.depozitka.eu") || url.includes("depozitka-engine")) return "engine";
  return "unknown";
}

interface MonitorState {
  fioSyncLastAlertRunId?: string | null;
}

async function loadMonitorState(supabase: ReturnType<typeof getSupabase>): Promise<MonitorState> {
  const { data } = await supabase
    .from("dpt_settings")
    .select("value")
    .eq("key", "monitoring_state")
    .maybeSingle();

  return (data?.value || {}) as MonitorState;
}

async function saveMonitorState(supabase: ReturnType<typeof getSupabase>, state: MonitorState): Promise<void> {
  await supabase
    .from("dpt_settings")
    .upsert(
      {
        key: "monitoring_state",
        value: state,
        description: "Interní stav monitoringu (deduplikace alertů)",
      },
      { onConflict: "key" },
    );
}

async function sendAlertPushover(
  userKeys: string[],
  title: string,
  message: string,
  priority = 1,
  sound?: string,
  url?: string,
  urlTitle?: string,
): Promise<boolean> {
  const appToken = (process.env.PUSHOVER_APP_TOKEN || "").trim();
  if (!appToken || userKeys.length === 0) return false;

  let anySent = false;

  for (const user of userKeys) {
    try {
      const body = new URLSearchParams({
        token: appToken,
        user,
        title,
        message,
        priority: String(priority),
      });

      if (sound) body.set("sound", sound);
      if (url) body.set("url", url);
      if (urlTitle) body.set("url_title", urlTitle);

      const res = await fetch("https://api.pushover.net/1/messages.json", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (res.ok) {
        anySent = true;
      } else {
        const payload = await res.text().catch(() => "");
        console.error("Monitoring pushover failed:", res.status, payload);
      }
    } catch (err) {
      console.error("Monitoring pushover failed:", err);
    }
  }

  return anySent;
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
  const state = await loadMonitorState(supabase);
  const alertEmails = uniqueEmails([
    ...(Array.isArray(settings.alertEmails) ? settings.alertEmails : []),
    process.env.ADMIN_EMAIL,
    process.env.SMTP_USER,
  ]);
  const reminderMinutes = Number(settings.reminderMinutes || DEFAULT_REMINDER_MINUTES);
  const pushoverEnabled = settings.pushoverEnabled === true;
  const pushoverUserKeys = uniquePushoverUsers([
    ...(Array.isArray(settings.pushoverUserKeys) ? settings.pushoverUserKeys : []),
    process.env.PUSHOVER_USER_KEY,
  ]);
  const pushoverPriority = Number.isFinite(Number(settings.pushoverPriority))
    ? Number(settings.pushoverPriority)
    : 1;
  const pushoverSound = typeof settings.pushoverSound === "string" ? settings.pushoverSound.trim() : "";

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

  // ─────────────────────────────────────────────────────────
  // Job-level monitoring: FIO sync should not fail twice in a row
  // We alert based on dpt_cron_runs (job_name='fio-sync').
  // ─────────────────────────────────────────────────────────
  try {
    const { data: fioRuns } = await supabase
      .from("dpt_cron_runs")
      .select("id, status, started_at, error_message")
      .eq("job_name", "fio-sync")
      .order("started_at", { ascending: false })
      .limit(2);

    const lastTwo = (fioRuns || []) as { id: string; status: string; started_at: string; error_message: string | null }[];
    const twoErrors = lastTwo.length >= 2 && lastTwo[0].status === "error" && lastTwo[1].status === "error";

    if (twoErrors) {
      const latestId = lastTwo[0].id;
      const alreadyAlerted = state.fioSyncLastAlertRunId && state.fioSyncLastAlertRunId === latestId;

      if (!alreadyAlerted) {
        const subject = "🚨 Depozitka: FIO sync selhal 2× za sebou";
        const text = [
          "Job: fio-sync",
          `Latest run: ${lastTwo[0].started_at}`,
          `Error: ${lastTwo[0].error_message || "(no error_message)"}`,
          `Engine: ${ENGINE_URL}`,
          `Core: ${CORE_URL}`,
        ].join("\n");

        const emailSent = await sendAlertEmail(alertEmails, subject, text);
        const pushSent = pushoverEnabled
          ? await sendAlertPushover(pushoverUserKeys, subject, text, pushoverPriority, pushoverSound, ENGINE_URL, "Engine")
          : false;

        if (emailSent || pushSent) {
          alertsSent++;
          state.fioSyncLastAlertRunId = latestId;
          await saveMonitorState(supabase, state);
        }
      }
    }
  } catch (err) {
    errors.push(`fio-sync monitor failed: ${err instanceof Error ? err.message : String(err)}`);
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
        const subject = `🚨 Depozitka monitoring: incident OPEN (${target.name})`;
        const component = inferComponent(target);
        const urlTitle = component === "core" ? "Core" : component === "engine" ? "Engine" : "Status";
        const linkUrl = component === "core" ? CORE_URL : component === "engine" ? ENGINE_URL : STATUS_PAGE_URL;

        const text = [
          `Component: ${component === "core" ? "Depozitka Core" : component === "engine" ? "Depozitka Engine" : "Unknown"}`,
          `Target: ${target.name}`,
          `URL: ${target.url}`,
          `Status page: ${STATUS_PAGE_URL}`,
          `Severity: ${target.severity}`,
          `Reason: ${reason}`,
          `Time: ${new Date().toISOString()}`,
        ].join("\n");

        const emailSent = await sendAlertEmail(alertEmails, subject, text);
        const pushSent = pushoverEnabled
          ? await sendAlertPushover(
              pushoverUserKeys,
              subject,
              text,
              pushoverPriority,
              pushoverSound,
              linkUrl,
              urlTitle,
            )
          : false;

        if (emailSent || pushSent) {
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
        const subject = `✅ Depozitka monitoring: incident RESOLVED (${target.name})`;
        const component = inferComponent(target);
        const urlTitle = component === "core" ? "Core" : component === "engine" ? "Engine" : "Status";
        const linkUrl = component === "core" ? CORE_URL : component === "engine" ? ENGINE_URL : STATUS_PAGE_URL;

        const text = [
          `Component: ${component === "core" ? "Depozitka Core" : component === "engine" ? "Depozitka Engine" : "Unknown"}`,
          `Target: ${target.name}`,
          `URL: ${target.url}`,
          `Status page: ${STATUS_PAGE_URL}`,
          `Reason: ${reason}`,
          `Time: ${new Date().toISOString()}`,
        ].join("\n");

        const emailSent = await sendAlertEmail(alertEmails, subject, text);
        const pushSent = pushoverEnabled
          ? await sendAlertPushover(
              pushoverUserKeys,
              subject,
              text,
              pushoverPriority,
              pushoverSound,
              linkUrl,
              urlTitle,
            )
          : false;

        if (emailSent || pushSent) alertsSent++;
      }

      continue;
    }

    if (openIncident) {
      const lastNotifiedAt = openIncident.last_notified_at
        ? new Date(openIncident.last_notified_at).getTime()
        : 0;
      const due = Date.now() - lastNotifiedAt >= reminderMinutes * 60_000;

      if (due) {
        const subject = `⏱️ Depozitka monitoring: incident trvá (${target.name})`;
        const component = inferComponent(target);
        const urlTitle = component === "core" ? "Core" : component === "engine" ? "Engine" : "Status";
        const linkUrl = component === "core" ? CORE_URL : component === "engine" ? ENGINE_URL : STATUS_PAGE_URL;

        const text = [
          `Component: ${component === "core" ? "Depozitka Core" : component === "engine" ? "Depozitka Engine" : "Unknown"}`,
          `Target: ${target.name}`,
          `URL: ${target.url}`,
          `Status page: ${STATUS_PAGE_URL}`,
          `Open since: ${openIncident.opened_at}`,
          `Last status: ${probe.statusCode ?? "ERR"}`,
          `Time: ${new Date().toISOString()}`,
        ].join("\n");

        const emailSent = await sendAlertEmail(alertEmails, subject, text);
        const pushSent = pushoverEnabled
          ? await sendAlertPushover(
              pushoverUserKeys,
              subject,
              text,
              pushoverPriority,
              pushoverSound,
              linkUrl,
              urlTitle,
            )
          : false;

        if (emailSent || pushSent) {
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
