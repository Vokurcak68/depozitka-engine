import crypto from "crypto";

function toBuf(hex: string): Buffer {
  return Buffer.from(hex || "", "utf8");
}

export type DealRole = "buyer" | "seller";

export function normalizeEmail(v: string): string {
  return (v || "").trim().toLowerCase();
}

export function safeText(v: unknown, max: number): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.slice(0, max);
}

export function assert(condition: unknown, code: string): asserts condition {
  if (!condition) {
    const err = new Error(code);
    (err as unknown as { code?: string }).code = code;
    throw err;
  }
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("hex");
}

function hmacOrSha256(input: string, secret: string): string {
  if (!secret) return crypto.createHash("sha256").update(input).digest("hex");
  return crypto.createHmac("sha256", secret).update(input).digest("hex");
}

export function hashViewToken(token: string): string {
  const secret = process.env.DEALS_VIEW_TOKEN_SECRET || process.env.CRON_SECRET || "";
  return hmacOrSha256(token, secret);
}

export function safeEqual(a: string, b: string): boolean {
  const ab = toBuf(a);
  const bb = toBuf(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function randomOtp6(): string {
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, "0");
}

export function hashOtp(otp: string): string {
  const secret = process.env.DEALS_OTP_SECRET || process.env.CRON_SECRET || "";
  return hmacOrSha256(otp, secret);
}

export function nameFromEmail(email: string): string {
  const e = (email || "").trim();
  const local = e.split("@")[0] || "Uživatel";
  return local.replace(/[._-]+/g, " ").slice(0, 80) || "Uživatel";
}

export function getWebBaseUrl(): string {
  const raw =
    process.env.WEB_BASE_URL ||
    process.env.NEXT_PUBLIC_WEB_BASE_URL ||
    "https://www.depozitka.eu";

  const normalized = (raw || "").trim();
  const withScheme = /^https?:\/\//i.test(normalized)
    ? normalized
    : `https://${normalized}`;

  try {
    const url = new URL(withScheme);

    // vždy HTTPS
    url.protocol = "https:";

    // apex občas dělá problémy s certifikátem v některých klientech
    if (url.hostname === "depozitka.eu") {
      url.hostname = "www.depozitka.eu";
    }

    // bezpečná fallback doména pro webové linky v e-mailech
    if (
      url.hostname === "engine.depozitka.eu" ||
      url.hostname.endsWith(".vercel.app")
    ) {
      return "https://www.depozitka.eu";
    }

    return url.origin;
  } catch {
    return "https://www.depozitka.eu";
  }
}

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);

  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isPrivateHost(hostname: string): boolean {
  const h = (hostname || "").trim().toLowerCase();
  if (!h) return true;

  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h.startsWith("[") && h.endsWith("]")) {
    const inside = h.slice(1, -1);
    if (inside === "::1") return true;
    if (inside.startsWith("fc") || inside.startsWith("fd") || inside.startsWith("fe80")) return true;
  }
  if (h.includes(":")) {
    const low = h.replace(/^\[|\]$/g, "");
    if (low === "::1") return true;
    if (low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe80")) return true;
  }

  if (isPrivateIpv4(h)) return true;
  return false;
}

export function parsePublicHttpUrl(input: string): URL {
  const s = safeText(input, 1500);
  assert(s, "MISSING_URL");

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    assert(false, "INVALID_URL");
  }

  assert(u.protocol === "http:" || u.protocol === "https:", "INVALID_URL_PROTOCOL");
  assert(!isPrivateHost(u.hostname), "URL_PRIVATE_HOST_BLOCKED");

  return u;
}
