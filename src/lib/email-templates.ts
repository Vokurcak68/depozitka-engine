/**
 * Depozitka Email Template Engine
 *
 * Variabilní HTML šablony — každý bazar (marketplace) má vlastní branding:
 * logo, název, barvy, kontakt, firemní údaje.
 *
 * Šablony se skládají z:
 * 1. Společný layout (header + footer s údaji marketplace)
 * 2. Variabilní obsah dle template_key
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarketplaceBranding {
  /** Marketplace code (e.g. "lokopolis-bazar") */
  code: string;
  /** Display name */
  name: string;
  /** Full URL to logo image (ideally ~200px wide, transparent PNG) */
  logoUrl?: string;
  /** Primary accent color (hex), default #2563eb */
  accentColor?: string;
  /** Company / legal name for footer */
  companyName?: string;
  /** Company address line */
  companyAddress?: string;
  /** IČO / DIČ */
  companyId?: string;
  /** Support email */
  supportEmail?: string;
  /** Website URL */
  websiteUrl?: string;
}

export interface EmailData {
  // Transaction
  transactionCode: string;
  externalOrderId: string;
  listingTitle?: string;

  // Buyer
  buyerName: string;
  buyerEmail: string;

  // Seller
  sellerName: string;
  sellerEmail: string;

  // Amounts
  amountCzk: string; // formatted e.g. "890,00"
  feeAmountCzk?: string;
  payoutAmountCzk?: string;

  // Payment
  paymentReference?: string; // VS
  paymentDueAt?: string; // formatted datetime
  escrowAccountNumber?: string; // Czech account number e.g. "2900000710/2010"
  escrowIban?: string; // IBAN (used for QR SPD string generation)

  // Shipping
  shippingCarrier?: string;
  shippingTrackingNumber?: string;
  shippingTrackingUrl?: string;

  // Other
  note?: string;

  // Marketplace branding (resolved from DB)
  marketplace: MarketplaceBranding;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string | undefined | null): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function accentOrDefault(mp: MarketplaceBranding): string {
  return mp.accentColor || "#2563eb";
}

// ---------------------------------------------------------------------------
// Layout wrapper
// ---------------------------------------------------------------------------

function wrapLayout(mp: MarketplaceBranding, bodyHtml: string): string {
  const accent = accentOrDefault(mp);
  const logoHtml = mp.logoUrl
    ? `<img src="${esc(mp.logoUrl)}" alt="${esc(mp.name)}" style="max-width:200px;max-height:60px;display:block;margin:0 auto 12px;" />`
    : `<h1 style="margin:0 0 12px;font-size:22px;color:${accent};text-align:center;">${esc(mp.name)}</h1>`;

  const footerLines: string[] = [];
  if (mp.companyName) footerLines.push(esc(mp.companyName));
  if (mp.companyAddress) footerLines.push(esc(mp.companyAddress));
  if (mp.companyId) footerLines.push(`IČO: ${esc(mp.companyId)}`);
  if (mp.supportEmail)
    footerLines.push(
      `<a href="mailto:${esc(mp.supportEmail)}" style="color:${accent};">${esc(mp.supportEmail)}</a>`,
    );
  if (mp.websiteUrl)
    footerLines.push(
      `<a href="${esc(mp.websiteUrl)}" style="color:${accent};">${esc(mp.websiteUrl)}</a>`,
    );

  return `<!DOCTYPE html>
<html lang="cs">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;">
<tr><td align="center" style="padding:24px 16px;">

  <!-- Container -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

    <!-- Header -->
    <tr>
      <td style="padding:28px 32px 16px;text-align:center;border-bottom:3px solid ${accent};">
        ${logoHtml}
      </td>
    </tr>

    <!-- Body -->
    <tr>
      <td style="padding:28px 32px 32px;">
        ${bodyHtml}
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="padding:20px 32px;background-color:#fafafa;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;text-align:center;line-height:1.6;">
        ${footerLines.join("<br>")}
        <br><span style="color:#9ca3af;">Tento email byl odeslán automaticky systémem Depozitka.</span>
      </td>
    </tr>

  </table>
</td></tr>
</table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Styled helpers
// ---------------------------------------------------------------------------

function heading(text: string, _accent: string): string {
  return `<h2 style="margin:0 0 16px;font-size:20px;color:#111827;">${esc(text)}</h2>`;
}

function paragraph(html: string): string {
  return `<p style="margin:0 0 14px;font-size:15px;color:#374151;line-height:1.6;">${html}</p>`;
}

function infoRow(label: string, value: string): string {
  return `<tr>
    <td style="padding:8px 12px;font-size:14px;color:#6b7280;white-space:nowrap;vertical-align:top;">${esc(label)}</td>
    <td style="padding:8px 12px;font-size:14px;color:#111827;font-weight:600;">${esc(value)}</td>
  </tr>`;
}

function infoTable(rows: [string, string | undefined][]): string {
  const filtered = rows.filter((r) => r[1]);
  if (!filtered.length) return "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
    ${filtered.map((r) => infoRow(r[0], r[1]!)).join("")}
  </table>`;
}

function highlightBox(
  html: string,
  bgColor = "#eff6ff",
  borderColor = "#2563eb",
): string {
  return `<div style="margin:16px 0;padding:16px 20px;background-color:${bgColor};border-left:4px solid ${borderColor};border-radius:4px;font-size:14px;color:#1e3a5f;line-height:1.6;">
    ${html}
  </div>`;
}

function _ctaButton(
  text: string,
  url: string,
  accent: string,
): string {
  return `<div style="text-align:center;margin:24px 0;">
    <a href="${esc(url)}" style="display:inline-block;padding:12px 32px;background-color:${accent};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px;">${esc(text)}</a>
  </div>`;
}

function qrPaymentBlock(d: EmailData): string {
  if (!d.escrowIban || !d.paymentReference || !d.amountCzk) return "";

  // Build SPD string per Czech QR Platba standard (qr-platba.cz)
  // Keys: ACC (povinný, IBAN), AM, CC, X-VS, MSG
  const amountNum = d.amountCzk.replace(/\s/g, "").replace(",", ".");
  const spdParts = [
    "SPD*1.0",
    `ACC:${d.escrowIban}`,
    `AM:${amountNum}`,
    "CC:CZK",
    `X-VS:${d.paymentReference.slice(0, 10)}`,
    `MSG:PLATBA ${d.transactionCode.replace(/-/g, "")}`,
  ];
  const spdString = spdParts.join("*");
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(spdString)}`;

  return `<div style="text-align:center;margin:20px 0;">
    <p style="margin:0 0 8px;font-size:14px;color:#6b7280;">Naskenujte QR kód pro rychlou platbu:</p>
    <img src="${qrUrl}" alt="QR platba" width="200" height="200"
         style="display:inline-block;border:1px solid #e5e7eb;border-radius:8px;padding:8px;background:#fff;" />
  </div>`;
}

// ---------------------------------------------------------------------------
// Template: tx_created_buyer
// ---------------------------------------------------------------------------

function txCreatedBuyer(d: EmailData): { subject: string; html: string; text: string } {
  const accent = accentOrDefault(d.marketplace);
  const mp = d.marketplace;

  const subject = `${mp.name}: Objednávka ${d.transactionCode} — platební údaje`;

  const bodyParts: string[] = [];

  bodyParts.push(heading("Vaše objednávka byla přijata", accent));

  bodyParts.push(
    paragraph(
      `Dobrý den,<br>
       děkujeme za nákup na <strong>${esc(mp.name)}</strong>. Vaše objednávka byla zaregistrována v systému bezpečné platby Depozitka.`,
    ),
  );

  // Order info
  bodyParts.push(
    infoTable([
      ["Kód transakce", d.transactionCode],
      ["Č. objednávky", d.externalOrderId],
      ["Položka", d.listingTitle],
      ["Prodávající", d.sellerName],
      ["Částka", `${d.amountCzk} Kč`],
    ]),
  );

  // Payment instructions — always show if we have at least amount
  {
    bodyParts.push(
      `<h3 style="margin:20px 0 8px;font-size:16px;color:#111827;">💳 Platební údaje</h3>`,
    );

    const paymentLines: string[] = [];
    if (d.escrowAccountNumber)
      paymentLines.push(`<strong>Číslo účtu:</strong> ${esc(d.escrowAccountNumber)}`);
    if (d.paymentReference)
      paymentLines.push(`<strong>Variabilní symbol:</strong> <span style="font-size:18px;font-weight:700;color:${accent};">${esc(d.paymentReference)}</span>`);
    if (d.amountCzk)
      paymentLines.push(`<strong>Částka k úhradě:</strong> <span style="font-size:18px;font-weight:700;">${esc(d.amountCzk)} Kč</span>`);

    bodyParts.push(
      highlightBox(
        paymentLines.join("<br>"),
        "#eff6ff",
        accent,
      ),
    );

    // QR code
    bodyParts.push(qrPaymentBlock(d));

    if (d.paymentDueAt) {
      bodyParts.push(
        paragraph(
          `⏰ <strong>Platbu proveďte do ${esc(d.paymentDueAt)}</strong>. Po uplynutí lhůty bude objednávka automaticky zrušena.`,
        ),
      );
    }
  }

  // How it works
  bodyParts.push(
    `<h3 style="margin:20px 0 8px;font-size:16px;color:#111827;">🔒 Jak bezpečná platba funguje</h3>`,
  );
  bodyParts.push(
    paragraph(
      `1. Převedete částku na escrow účet (výše uvedené údaje)<br>
       2. Peníze jsou bezpečně drženy, dokud nepotvrdíte převzetí zboží<br>
       3. Po potvrzení doručení se výplata uvolní prodávajícímu`,
    ),
  );

  bodyParts.push(
    paragraph(
      `Máte otázky? Napište nám na <a href="mailto:${esc(mp.supportEmail || "info@depozitka.cz")}" style="color:${accent};">${esc(mp.supportEmail || "info@depozitka.cz")}</a>.`,
    ),
  );

  const html = wrapLayout(mp, bodyParts.join(""));

  // Plain text fallback
  const text = [
    `${mp.name}: Objednávka ${d.transactionCode}`,
    "",
    "Dobrý den,",
    `děkujeme za nákup na ${mp.name}.`,
    "",
    `Kód transakce: ${d.transactionCode}`,
    `Č. objednávky: ${d.externalOrderId}`,
    d.listingTitle ? `Položka: ${d.listingTitle}` : "",
    `Prodávající: ${d.sellerName}`,
    `Částka: ${d.amountCzk} Kč`,
    "",
    "PLATEBNÍ ÚDAJE:",
    d.escrowAccountNumber ? `Číslo účtu: ${d.escrowAccountNumber}` : "",
    d.paymentReference ? `VS: ${d.paymentReference}` : "",
    `Částka: ${d.amountCzk} Kč`,
    d.paymentDueAt ? `Splatnost: ${d.paymentDueAt}` : "",
    "",
    `Otázky: ${mp.supportEmail || "info@depozitka.cz"}`,
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type TemplateKey =
  | "tx_created_buyer"
  | "tx_created_seller"
  | "tx_created_admin"
  | "payment_received_buyer"
  | "payment_received_seller"
  | "shipped_buyer"
  | "delivered_buyer"
  | "delivered_seller"
  | "completed_buyer"
  | "completed_seller"
  | "dispute_opened_buyer"
  | "dispute_opened_seller"
  | "dispute_opened_admin"
  | "hold_set_buyer"
  | "hold_set_seller"
  | "refunded_buyer"
  | "refunded_seller"
  | "payout_seller"
  | "payout_admin";

/**
 * Render an email template by key.
 * Returns null if no HTML template is registered (fallback to DB plain-text).
 */
export function renderTemplate(
  key: string,
  data: EmailData,
): { subject: string; html: string; text: string } | null {
  switch (key) {
    case "tx_created_buyer":
      return txCreatedBuyer(data);
    // TODO: add more templates as we finalize the first one
    default:
      return null;
  }
}
