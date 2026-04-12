import crypto from "crypto";

export function getRequestIp(req: Request): string | undefined {
  // Vercel forwards client IP here.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || undefined;

  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  return undefined;
}

export function hashIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const secret = process.env.SUPPORT_IP_HASH_SECRET || process.env.CRON_SECRET || "";
  if (!secret) {
    // As a last resort, still hash (but weak). Better than storing raw IP.
    return crypto.createHash("sha256").update(ip).digest("hex");
  }
  return crypto.createHmac("sha256", secret).update(ip).digest("hex");
}

export function sanitizeFilename(name: string): string {
  const base = name
    .replace(/\\/g, "/")
    .split("/")
    .pop() ||
    "file";

  return base
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120) || "file";
}

export function randomId(bytes = 12): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function hashToken(token: string): string {
  const secret = process.env.SUPPORT_IP_HASH_SECRET || process.env.CRON_SECRET || "";
  if (!secret) {
    return crypto.createHash("sha256").update(token).digest("hex");
  }
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
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
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
}
