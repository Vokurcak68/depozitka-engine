/**
 * Helper to send email directly via internal /api/send-email endpoint
 */

export async function sendEmailDirect(
  transactionId: string,
  templateKey: string,
  toEmail: string,
): Promise<void> {
  const baseUrl =
    process.env.NEXT_PUBLIC_ENGINE_URL ||
    `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || "depozitka-engine.vercel.app"}`;

  const token = process.env.CRON_SECRET || process.env.MANUAL_EMAIL_TRIGGER_TOKEN;

  const res = await fetch(`${baseUrl}/api/send-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transaction_id: transactionId,
      template_key: templateKey,
      to_email: toEmail,
      token,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`send-email failed: ${res.status} ${text}`);
  }
}
