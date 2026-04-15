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
  const ACCENT = "#2563eb";

  const rows = (params.rows || []).filter((r) => r.value && String(r.value).trim().length > 0);
  const steps = (params.steps || []).filter(Boolean);

  const textLines: string[] = [params.title, "", params.intro, "", ...rows.map((r) => `${r.label}: ${String(r.value)}`)];

  if (steps.length) textLines.push("", "Co dál:", ...steps.map((s, i) => `${i + 1}. ${s}`));
  if (params.ctaUrl) textLines.push("", `${params.ctaLabel || "Otevřít"}: ${params.ctaUrl}`);
  if (params.note) textLines.push("", params.note);
  textLines.push("", "—", "Depozitka.eu · Bezpečná platba mezi lidmi");

  const htmlRows = rows.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
        ${rows
          .map(
            (r) => `<tr>
              <td style="padding:8px 12px;font-size:14px;color:#6b7280;white-space:nowrap;vertical-align:top;">${escapeHtml(r.label)}</td>
              <td style="padding:8px 12px;font-size:14px;color:#111827;font-weight:600;${r.mono ? "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:1px;" : ""}">${escapeHtml(String(r.value))}</td>
            </tr>`,
          )
          .join("")}
      </table>`
    : "";

  const htmlSteps = steps.length
    ? `<div style="margin:16px 0;padding:16px 20px;background-color:#eff6ff;border-left:4px solid ${ACCENT};border-radius:4px;font-size:14px;color:#1e3a5f;line-height:1.6;">
        <strong>Co dál:</strong>
        <ol style="margin:8px 0 0;padding-left:18px;">
          ${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}
        </ol>
      </div>`
    : "";

  const ctaHtml = params.ctaUrl
    ? `<div style="text-align:center;margin:24px 0;">
        <a href="${escapeHtml(params.ctaUrl)}" style="display:inline-block;padding:12px 32px;background-color:${ACCENT};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px;">${escapeHtml(params.ctaLabel || "Otevřít")}</a>
      </div>`
    : "";

  const noteHtml = params.note
    ? `<p style="margin:0 0 14px;font-size:15px;color:#374151;line-height:1.6;">${escapeHtml(params.note)}</p>`
    : "";

  const badgeHtml = params.badge
    ? `<div style="display:inline-block;margin:0 0 14px;padding:6px 12px;border-radius:999px;background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;font-size:12px;font-weight:700;">${escapeHtml(params.badge)}</div>`
    : "";

  const logoUrl = (process.env.DEPOSITKA_EMAIL_LOGO_URL || "https://depozitka.eu/brand/logo-transparent.png").trim();
  const logoHtml = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="Depozitka.eu" style="max-width:200px;max-height:60px;display:block;margin:0 auto 12px;" />`
    : `<h1 style="margin:0 0 12px;font-size:22px;color:${ACCENT};text-align:center;">Depozitka.eu</h1>`;

  const html = `<!DOCTYPE html>
<html lang="cs" style="color-scheme:only light;supported-color-schemes:only light;">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="color-scheme" content="only light">
<meta name="supported-color-schemes" content="only light">
<style>
  :root { color-scheme: only light; supported-color-schemes: only light; }
  body, table, td { background-color:#ffffff !important; }
  @media (prefers-color-scheme: dark) {
    body, table, td { background-color:#ffffff !important; }
  }
</style>
<title>${escapeHtml(params.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffffff;">
<tr><td align="center" style="padding:24px 16px;background-color:#ffffff;">

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">

    <tr>
      <td style="padding:28px 32px 16px;text-align:center;border-bottom:3px solid ${ACCENT};background-color:#ffffff;">
        ${logoHtml}
      </td>
    </tr>

    <tr>
      <td style="padding:28px 32px 32px;background-color:#ffffff;">
        <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(params.preview)}</div>
        ${badgeHtml}
        <h2 style="margin:0 0 16px;font-size:20px;color:#111827;">${escapeHtml(params.title)}</h2>
        <p style="margin:0 0 14px;font-size:15px;color:#374151;line-height:1.6;">${escapeHtml(params.intro)}</p>
        ${htmlRows}
        ${htmlSteps}
        ${ctaHtml}
        ${params.ctaUrl ? `<p style="margin:8px 0 0;color:#6b7280;font-size:12px;line-height:1.45;word-break:break-all;">${escapeHtml(params.ctaUrl)}</p>` : ""}
        ${noteHtml}
      </td>
    </tr>

    <tr>
      <td style="padding:20px 32px;background-color:#ffffff;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;text-align:center;line-height:1.6;">
        Depozitka.eu
        <br><a href="mailto:info@depozitka.eu" style="color:${ACCENT};">info@depozitka.eu</a>
        <br><a href="https://depozitka.eu" style="color:${ACCENT};">https://depozitka.eu</a>
        <br><span style="color:#9ca3af;">Tento email byl odeslán automaticky systémem Depozitka.</span>
      </td>
    </tr>

  </table>
</td></tr>
</table>
</body>
</html>`;

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
