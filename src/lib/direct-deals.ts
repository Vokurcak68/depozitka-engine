import crypto from "crypto";

export function normalizeEmail(v: string): string {
  return (v || "").trim().toLowerCase();
}

export function corsHeaders(origin?: string): Record<string, string> {
  const allow = new Set([
    "https://www.depozitka.eu",
    "https://depozitka.eu",
    "https://status.depozitka.eu",
    "http://localhost:3000",
  ]);

  const o = origin && allow.has(origin) ? origin : "https://www.depozitka.eu";

  return {
    "access-control-allow-origin": o,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  };
}

export function randomOtp6(): string {
  // 6 digits
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, "0");
}

export function hashOtp(otp: string): string {
  const secret = process.env.DIRECT_DEALS_OTP_SECRET || process.env.CRON_SECRET || "";
  if (!secret) {
    return crypto.createHash("sha256").update(otp).digest("hex");
  }
  return crypto.createHmac("sha256", secret).update(otp).digest("hex");
}

export function safeText(v: unknown, max: number): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.slice(0, max);
}

export function nameFromEmail(email: string): string {
  const e = (email || "").trim();
  const local = e.split("@")[0] || "Uživatel";
  return local.replace(/[._-]+/g, " ").slice(0, 80) || "Uživatel";
}

export function assert(condition: unknown, code: string): asserts condition {
  if (!condition) {
    const err = new Error(code);
    (err as unknown as { code?: string }).code = code;
    throw err;
  }
}
