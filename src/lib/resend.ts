import { Resend } from "resend";

let _client: Resend | null = null;

/** Lazy-init Resend client */
export function getResend(): Resend {
  if (_client) return _client;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("Missing RESEND_API_KEY");
  _client = new Resend(key);
  return _client;
}

export const resend = new Proxy({} as Resend, {
  get(_, prop) {
    return (getResend() as any)[prop];
  },
});

export const EMAIL_FROM = process.env.EMAIL_FROM || "noreply@depozitka.eu";
