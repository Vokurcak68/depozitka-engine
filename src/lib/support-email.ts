import { getTransporter, SMTP_FROM } from "@/lib/smtp";

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

  const transporter = getTransporter();

  const adminSubject = `[${params.ticketCode}] ${params.subject}`;
  const userSubject = `Depozitka: přijetí požadavku ${params.ticketCode}`;

  const base = `${params.bodyText}${params.attachmentsText ? `\n\nPřílohy:\n${params.attachmentsText}` : ""}`;

  try {
    await transporter.sendMail({
      from: SMTP_FROM,
      to: supportTo,
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
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
