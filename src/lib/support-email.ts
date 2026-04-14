import { getTransporter, SMTP_FROM } from "@/lib/smtp";

function splitEmails(v: string | undefined): string[] {
  return (v || "")
    .split(/[\n,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function sendSupportEmails(params: {
  ticketCode: string;
  toUserEmail: string;
  subject: string;
  bodyText: string;
  attachmentsText?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const supportTo = (process.env.SUPPORT_EMAIL_TO || "").trim();
  if (!supportTo) {
    return { ok: false, error: "Missing SUPPORT_EMAIL_TO" };
  }

  const ccList = splitEmails(process.env.SUPPORT_EMAIL_CC).join(", ") || undefined;

  const transporter = getTransporter();

  const adminSubject = `[${params.ticketCode}] ${params.subject}`;
  const userSubject = `Depozitka: přijetí požadavku ${params.ticketCode}`;

  const base = `${params.bodyText}${params.attachmentsText ? `\n\nPřílohy:\n${params.attachmentsText}` : ""}`;

  try {
    await transporter.sendMail({
      from: SMTP_FROM,
      to: supportTo,
      cc: ccList,
      replyTo: params.toUserEmail,
      subject: adminSubject,
      text: base,
    });

    await transporter.sendMail({
      from: SMTP_FROM,
      to: params.toUserEmail,
      replyTo: supportTo,
      subject: userSubject,
      text: `Díky, požadavek jsme přijali.\n\nTicket: ${params.ticketCode}\n\nShrnutí:\n${params.subject}\n\nZpráva:\n${params.bodyText}\n\nKdyž bude potřeba, ozveme se na tenhle email.`,
    });

    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
