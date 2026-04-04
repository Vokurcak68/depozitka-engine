import nodemailer, { Transporter } from "nodemailer";

let _transporter: Transporter | null = null;

function parseBool(v: string | undefined, def = false): boolean {
  if (v == null) return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export function getTransporter(): Transporter {
  if (_transporter) return _transporter;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || "465");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = parseBool(process.env.SMTP_SECURE, port === 465);

  if (!host || !user || !pass) {
    throw new Error("Missing SMTP_HOST/SMTP_USER/SMTP_PASS");
  }

  _transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  return _transporter;
}

export const SMTP_FROM =
  process.env.SMTP_FROM || process.env.EMAIL_FROM || "noreplay@depozitka.eu";

export async function verifySmtp(): Promise<void> {
  const transporter = getTransporter();
  await transporter.verify();
}
