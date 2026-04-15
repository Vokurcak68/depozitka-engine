type Row = {
  label: string;
  value?: string | null;
  mono?: boolean;
};

type BuiltMail = {
  subject: string;
  text: string;
  html: string;
};

function escapeHtml(v: string): string {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatCzk(value: number): string {
  return `${value.toLocaleString("cs-CZ")} Kč`;
}

function displayNameFromIdentity(identity: string): string {
  const raw = String(identity || "").trim();
  if (!raw) return "Uživatel";
  if (!raw.includes("@")) return raw;
  const local = raw.split("@")[0] || "";
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : raw;
}

function buildEmail(params: {
  subject: string;
  preview: string;
  title: string;
  intro: string;
  badge?: string;
  rows?: Row[];
  steps?: string[];
  ctaLabel?: string;
  ctaUrl?: string;
  note?: string;
}): BuiltMail {
  const rows = (params.rows || []).filter((r) => r.value && String(r.value).trim().length > 0);
  const steps = (params.steps || []).filter(Boolean);

  const textLines: string[] = [params.title, "", params.intro, "", ...rows.map((r) => `${r.label}: ${String(r.value)}`)];

  if (steps.length) {
    textLines.push("", "Co dál:", ...steps.map((s, i) => `${i + 1}. ${s}`));
  }

  if (params.ctaUrl) {
    textLines.push("", `${params.ctaLabel || "Otevřít"}: ${params.ctaUrl}`);
  }

  if (params.note) {
    textLines.push("", params.note);
  }

  textLines.push("", "—", "Depozitka.eu · Bezpečná platba mezi lidmi");

  const htmlRows = rows.length
    ? `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:16px 0 14px;">
        ${rows
          .map(
            (r) => `
          <tr>
            <td style="padding:8px 0;color:#64748b;font-size:13px;width:170px;vertical-align:top;">${escapeHtml(r.label)}</td>
            <td style="padding:8px 0 8px 12px;color:#0f172a;font-size:14px;font-weight:600;${r.mono ? "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:1px;" : ""}">${escapeHtml(String(r.value))}</td>
          </tr>
        `,
          )
          .join("")}
      </table>
    `
    : "";

  const htmlSteps = steps.length
    ? `
      <div style="margin:14px 0 0;padding:12px 14px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;">
        <div style="font-size:12px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">Co dál</div>
        <ol style="margin:0;padding-left:18px;color:#334155;font-size:13px;line-height:1.6;">
          ${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}
        </ol>
      </div>
    `
    : "";

  const ctaHtml = params.ctaUrl
    ? `
      <p style="margin:20px 0 8px;">
        <a href="${escapeHtml(params.ctaUrl)}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 16px;border-radius:10px;font-weight:700;font-size:14px;">
          ${escapeHtml(params.ctaLabel || "Otevřít")}
        </a>
      </p>
      <p style="margin:8px 0 0;color:#64748b;font-size:12px;line-height:1.45;word-break:break-all;">${escapeHtml(params.ctaUrl)}</p>
    `
    : "";

  const noteHtml = params.note
    ? `<p style="margin:16px 0 0;color:#334155;font-size:13px;line-height:1.55;">${escapeHtml(params.note)}</p>`
    : "";

  const badgeHtml = params.badge
    ? `<div style="display:inline-block;margin:0 0 10px;padding:4px 10px;border-radius:999px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-size:12px;font-weight:700;">${escapeHtml(params.badge)}</div>`
    : "";

  const html = `
<!doctype html>
<html lang="cs">
  <head>
    <meta charSet="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(params.subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0f172a;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(params.preview)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#f8fafc;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;border-collapse:collapse;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="height:5px;background:linear-gradient(90deg,#0f172a 0%,#334155 45%,#f59e0b 100%);"></td>
            </tr>
            <tr>
              <td style="padding:20px 24px;background:linear-gradient(180deg,#f8fafc 0%,#ffffff 100%);border-bottom:1px solid #e2e8f0;">
                <div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#64748b;">Depozitka.eu</div>
                ${badgeHtml}
                <h1 style="margin:8px 0 0;font-size:22px;line-height:1.25;color:#0f172a;">${escapeHtml(params.title)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:22px 24px;">
                <p style="margin:0;color:#334155;font-size:14px;line-height:1.6;">${escapeHtml(params.intro)}</p>
                ${htmlRows}
                ${htmlSteps}
                ${ctaHtml}
                ${noteHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 24px;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:1.55;">
                Tento email byl odeslán automaticky z Depozitka.eu.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`.trim();

  return {
    subject: params.subject,
    text: textLines.join("\n"),
    html,
  };
}

export function buildDealInviteEmail(params: {
  initiator: string;
  title: string;
  totalAmountCzk: number;
  dealUrl: string;
  externalUrl?: string | null;
}): BuiltMail {
  const initiator = displayNameFromIdentity(params.initiator);

  return buildEmail({
    subject: "Depozitka: návrh bezpečné platby",
    preview: "Máte nový návrh bezpečné platby",
    badge: "Nová nabídka",
    title: "Nová nabídka bezpečné platby",
    intro: `${initiator} vám poslal(a) návrh bezpečné platby přes Depozitku.`,
    rows: [
      { label: "Název", value: params.title },
      { label: "Cena (vč. dopravy)", value: formatCzk(params.totalAmountCzk) },
      { label: "Původní inzerát", value: params.externalUrl || null },
    ],
    steps: ["Otevřete nabídku.", "Na stránce si vyžádejte OTP kód.", "Nabídku potvrďte nebo odmítněte."],
    ctaLabel: "Otevřít nabídku",
    ctaUrl: params.dealUrl,
  });
}

export function buildDealUpdatedEmail(params: {
  initiator: string;
  title: string;
  totalAmountCzk: number;
  dealUrl: string;
}): BuiltMail {
  const initiator = displayNameFromIdentity(params.initiator);

  return buildEmail({
    subject: "Depozitka: upravená nabídka bezpečné platby",
    preview: "Máte upravenou nabídku bezpečné platby",
    badge: "Upravená nabídka",
    title: "Upravená nabídka bezpečné platby",
    intro: `${initiator} upravil(a) nabídku bezpečné platby.`,
    rows: [
      { label: "Název", value: params.title },
      { label: "Cena", value: formatCzk(params.totalAmountCzk) },
    ],
    ctaLabel: "Zobrazit upravenou nabídku",
    ctaUrl: params.dealUrl,
  });
}

export function buildDealOtpEmail(params: {
  title: string;
  otp: string;
  otpExpiryMinutes: number;
  dealUrl: string;
}): BuiltMail {
  return buildEmail({
    subject: "Depozitka: ověřovací kód (OTP)",
    preview: "Váš ověřovací kód pro potvrzení nabídky",
    badge: "Ověření nabídky",
    title: "Ověřovací kód pro nabídku",
    intro: "Pro potvrzení nabídky použijte následující OTP kód:",
    rows: [
      { label: "Název nabídky", value: params.title },
      { label: "OTP kód", value: params.otp, mono: true },
      { label: "Platnost", value: `${params.otpExpiryMinutes} minut` },
    ],
    ctaLabel: "Otevřít nabídku",
    ctaUrl: params.dealUrl,
    note: "Kód nikomu neposílejte. Pokud jste o něj nežádal(a), email ignorujte.",
  });
}

export function buildDealRejectedEmail(params: {
  title: string;
  totalAmountCzk: number;
  reason: string;
  externalUrl?: string | null;
}): BuiltMail {
  return buildEmail({
    subject: "Depozitka: nabídka byla zamítnuta",
    preview: "Protistrana zamítla nabídku bezpečné platby",
    badge: "Zamítnutá nabídka",
    title: "Nabídka byla zamítnuta",
    intro: "Protistrana zamítla nabídku bezpečné platby.",
    rows: [
      { label: "Název", value: params.title },
      { label: "Cena", value: formatCzk(params.totalAmountCzk) },
      { label: "Původní inzerát", value: params.externalUrl || null },
      { label: "Důvod zamítnutí", value: params.reason },
    ],
    note: "Pokud chcete pokračovat, upravte nabídku a pošlete novou.",
  });
}
