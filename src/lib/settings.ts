import { supabase } from "@/lib/supabase";

let cache: Record<string, unknown> | null = null;
let cacheAt = 0;
const TTL_MS = 30_000;

async function loadSettings(force = false): Promise<Record<string, unknown>> {
  const now = Date.now();
  if (!force && cache && now - cacheAt < TTL_MS) return cache;

  const { data, error } = await supabase.from("dpt_settings").select("key,value");
  if (error || !data) {
    cache = {};
    cacheAt = now;
    return cache;
  }

  const out: Record<string, unknown> = {};
  for (const row of data as Array<{ key: string; value: unknown }>) {
    out[String(row.key)] = row.value;
  }
  cache = out;
  cacheAt = now;
  return out;
}

export async function getSettingValue<T = unknown>(
  key: string,
  def: T,
  opts?: { force?: boolean },
): Promise<T> {
  const s = await loadSettings(!!opts?.force);
  return (s[key] as T) ?? def;
}

export async function getSettingNumber(
  key: string,
  def: number,
  opts?: { force?: boolean },
): Promise<number> {
  const raw = await getSettingValue<unknown>(key, def, opts);
  if (raw == null) return def;

  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }

  // Support JSON objects in dpt_settings.value (common pattern)
  if (typeof raw === "object" && raw !== null) {
    // Support shape like { value: "10" }
    const maybe = raw as Record<string, unknown>;
    const n = Number(maybe.value);
    if (Number.isFinite(n)) return n;
  }

  return def;
}
