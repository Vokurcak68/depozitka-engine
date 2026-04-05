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
  paidAmountCzk?: string;
  remainingAmountCzk?: string;
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

  // Ship page link (for seller to enter tracking)
  shipUrl?: string;

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

function qrPaymentBlock(d: EmailData, amountCzk?: string): string {
  const amount = amountCzk || d.amountCzk;
  if (!d.escrowIban || !d.paymentReference || !amount) return "";

  // Build SPD string per Czech QR Platba standard (qr-platba.cz)
  // Keys: ACC (povinný, IBAN), AM, CC, X-VS, MSG
  const amountNum = amount.replace(/\s/g, "").replace(",", ".");
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
  | "partial_paid_buyer"
  | "partial_paid_seller"
  | "partial_paid_admin"
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

type SimpleTemplateCfg = {
  subject: string;
  title: string;
  intro: string;
  includeVs?: boolean;
  includeTracking?: boolean;
  includePayout?: boolean;
  includeShipLink?: boolean;
  highlight?: string;
};

function simpleTemplate(
  d: EmailData,
  cfg: SimpleTemplateCfg,
): { subject: string; html: string; text: string } {
  const accent = accentOrDefault(d.marketplace);
  const mp = d.marketplace;

  const rows: [string, string | undefined][] = [
    ["Kód transakce", d.transactionCode],
    ["Č. objednávky", d.externalOrderId],
    ["Položka", d.listingTitle],
    ["Kupující", d.buyerName],
    ["Prodávající", d.sellerName],
    ["Částka", `${d.amountCzk} Kč`],
  ];

  if (cfg.includeVs) rows.push(["Variabilní symbol", d.paymentReference]);
  if (cfg.includePayout)
    rows.push([
      "Výplata prodávajícímu",
      d.payoutAmountCzk ? `${d.payoutAmountCzk} Kč` : undefined,
    ]);
  if (cfg.includeTracking) {
    rows.push(["Dopravce", d.shippingCarrier]);
    rows.push(["Tracking číslo", d.shippingTrackingNumber]);
    rows.push(["Tracking URL", d.shippingTrackingUrl]);
  }

  const html = wrapLayout(
    mp,
    [
      heading(cfg.title, accent),
      paragraph(cfg.intro),
      infoTable(rows),
      cfg.includeShipLink && d.shipUrl
        ? `<div style="text-align:center;margin:24px 0;">
            <a href="${esc(d.shipUrl)}" style="display:inline-block;padding:14px 32px;background:${accent};color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px;">
              📦 Zadat tracking a odeslat zásilku
            </a>
           </div>`
        : "",
      cfg.highlight ? highlightBox(cfg.highlight, "#eff6ff", accent) : "",
      paragraph(
        `Dotazy? Napište nám na <a href="mailto:${esc(mp.supportEmail || "info@depozitka.cz")}" style="color:${accent};">${esc(mp.supportEmail || "info@depozitka.cz")}</a>.`,
      ),
    ].join(""),
  );

  const text = [
    cfg.subject,
    "",
    cfg.title,
    cfg.intro.replace(/<br>/g, " "),
    "",
    `Kód transakce: ${d.transactionCode}`,
    `Č. objednávky: ${d.externalOrderId}`,
    d.listingTitle ? `Položka: ${d.listingTitle}` : "",
    `Kupující: ${d.buyerName}`,
    `Prodávající: ${d.sellerName}`,
    `Částka: ${d.amountCzk} Kč`,
    cfg.includeVs && d.paymentReference ? `VS: ${d.paymentReference}` : "",
    cfg.includePayout && d.payoutAmountCzk
      ? `Výplata prodávajícímu: ${d.payoutAmountCzk} Kč`
      : "",
    cfg.includeTracking && d.shippingCarrier ? `Dopravce: ${d.shippingCarrier}` : "",
    cfg.includeTracking && d.shippingTrackingNumber
      ? `Tracking: ${d.shippingTrackingNumber}`
      : "",
    cfg.includeTracking && d.shippingTrackingUrl
      ? `Tracking URL: ${d.shippingTrackingUrl}`
      : "",
    cfg.includeShipLink && d.shipUrl
      ? `\nZadat tracking a odeslat zásilku: ${d.shipUrl}\n`
      : "",
    cfg.highlight || "",
  ]
    .filter(Boolean)
    .join("\n");

  return { subject: cfg.subject, html, text };
}

/**
 * Render an email template by key.
 * Returns null if no HTML template is registered (fallback to DB plain-text).
 */
export function renderTemplate(
  key: string,
  d: EmailData,
): { subject: string; html: string; text: string } | null {
  const mp = d.marketplace;

  switch (key) {
    case "tx_created_buyer":
      return txCreatedBuyer(d);
    case "tx_created_seller":
      return simpleTemplate(d, {
        subject: `${mp.name}: Nová objednávka ${d.transactionCode}`,
        title: "Nová transakce čeká na úhradu",
        intro:
          "Dobrý den,<br>u objednávky byla vytvořena nová transakce. Jakmile kupující zaplatí, pošleme vám výzvu k odeslání zásilky.",
      });
    case "tx_created_admin":
      return simpleTemplate(d, {
        subject: `${mp.name}: Nová transakce ${d.transactionCode} (admin)`,
        title: "Byla založena nová transakce",
        intro: "Admin notifikace: byla vytvořena nová transakce.",
        includeVs: true,
      });
    case "partial_paid_buyer": {
      const accent = accentOrDefault(d.marketplace);
      const paid = d.paidAmountCzk || "0,00";
      const remaining = d.remainingAmountCzk || d.amountCzk;
      const subject = `${mp.name}: Částečná úhrada přijata (${d.transactionCode})`;
      const html = wrapLayout(
        mp,
        [
          heading("Evidujeme částečnou platbu", accent),
          paragraph("Dobrý den,<br>k této transakci jsme přijali jen část platby. Pro dokončení doplaťte zbývající částku."),
          infoTable([
            ["Kód transakce", d.transactionCode],
            ["Č. objednávky", d.externalOrderId],
            ["Kupující", d.buyerName],
            ["Prodávající", d.sellerName],
            ["Celková částka", `${d.amountCzk} Kč`],
            ["Již uhrazeno", `${paid} Kč`],
            ["Zbývá doplatit", `${remaining} Kč`],
            ["Variabilní symbol", d.paymentReference],
            ["Číslo účtu", d.escrowAccountNumber],
          ]),
          highlightBox("Po připsání doplatku přepneme transakci do stavu Zaplaceno a prodávající dostane výzvu k odeslání.", "#fff7ed", accent),
          qrPaymentBlock(d, remaining),
          paragraph(
            `Dotazy? Napište nám na <a href=\"mailto:${esc(mp.supportEmail || "info@depozitka.cz")}\" style=\"color:${accent};\">${esc(mp.supportEmail || "info@depozitka.cz")}</a>.`,
          ),
        ].join(""),
      );
      const text = [
        subject,
        "",
        "Evidujeme částečnou platbu.",
        `Kód transakce: ${d.transactionCode}`,
        `Č. objednávky: ${d.externalOrderId}`,
        `Celková částka: ${d.amountCzk} Kč`,
        `Již uhrazeno: ${paid} Kč`,
        `Zbývá doplatit: ${remaining} Kč`,
        d.paymentReference ? `VS: ${d.paymentReference}` : "",
        d.escrowAccountNumber ? `Číslo účtu: ${d.escrowAccountNumber}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { subject, html, text };
    }
    case "partial_paid_seller":
      return simpleTemplate(d, {
        subject: `${mp.name}: Kupující uhradil část platby (${d.transactionCode})`,
        title: "Kupující zaplatil zatím jen část",
        intro:
          "Dobrý den,<br>u této transakce evidujeme částečnou platbu od kupujícího. Na odeslání vyčkejte až na plnou úhradu.",
        includeVs: true,
      });
    case "partial_paid_admin":
      return simpleTemplate(d, {
        subject: `${mp.name}: Částečná platba (${d.transactionCode})`,
        title: "Admin notifikace: částečná platba",
        intro: "U transakce evidujeme částečné uhrazení částky.",
        includeVs: true,
      });
    case "payment_received_buyer":
      return simpleTemplate(d, {
        subject: `${mp.name}: Platba přijata (${d.transactionCode})`,
        title: "Platba byla přijata",
        intro:
          "Dobrý den,<br>vaše platba byla úspěšně připsána. Prodávající nyní připraví odeslání zásilky.",
        includeVs: true,
      });
    case "payment_received_seller":
      return simpleTemplate(d, {
        subject: `${mp.name}: Kupující zaplatil — odešlete zásilku (${d.transactionCode})`,
        title: "Kupující uhradil platbu",
        intro:
          "Dobrý den,<br>platba od kupujícího byla přijata. Připravte zásilku a klikněte na tlačítko níže pro zadání tracking čísla.",
        includeVs: true,
        includeShipLink: true,
      });
    case "shipped_buyer":
      return simpleTemplate(d, {
        subject: `${mp.name}: Zboží odesláno (${d.transactionCode})`,
        title: "Prodávající odeslal zásilku",
        intro: "Dobrý den,<br>prodávající označil zásilku jako odeslanou.",
        includeTracking: true,
      });
    case "delivered_buyer":
      return simpleTemplate(d, {
        subject: `${mp.name}: Zásilka doručena (${d.transactionCode})`,
        title: "Zásilka byla doručena",
        intro:
          "Dobrý den,<br>zásilka byla označena jako doručená. Potvrďte prosím převzetí, aby mohla být výplata uvolněna prodávajícímu.",
        includeTracking: true,
      });
    case "delivered_seller":
      return simpleTemplate(d, {
        subject: `${mp.name}: Zásilka doručena kupujícímu (${d.transactionCode})`,
        title: "Kupující převzal zásilku",
        intro:
          "Dobrý den,<br>zásilka byla doručena kupujícímu. Po potvrzení převzetí bude transakce dokončena.",
        includeTracking: true,
      });
    case "completed_buyer":
      return simpleTemplate(d, {
        subject: `${mp.name}: Transakce dokončena (${d.transactionCode})`,
        title: "Transakce je dokončena",
        intro:
          "Dobrý den,<br>transakce byla úspěšně dokončena. Děkujeme za využití bezpečné platby.",
      });
    case "completed_seller":
      return simpleTemplate(d, {
        subject: `${mp.name}: Transakce dokončena (${d.transactionCode})`,
        title: "Transakce je dokončena",
        intro:
          "Dobrý den,<br>transakce byla dokončena. Výplata bude zpracována dle pravidel marketplace.",
        includePayout: true,
      });
    case "dispute_opened_buyer":
      return simpleTemplate(d, {
        subject: `${mp.name}: Otevřen spor (${d.transactionCode})`,
        title: "Byl otevřen spor",
        intro:
          "Dobrý den,<br>u této transakce byl otevřen spor. Náš tým případ prověří a ozve se vám.",
        highlight: d.note ? `Důvod: ${esc(d.note)}` : undefined,
      });
    case "dispute_opened_seller":
      return simpleTemplate(d, {
        subject: `${mp.name}: Otevřen spor (${d.transactionCode})`,
        title: "Byl otevřen spor",
        intro:
          "Dobrý den,<br>u této transakce byl otevřen spor. Náš tým případ prověří a ozve se vám.",
        highlight: d.note ? `Důvod: ${esc(d.note)}` : undefined,
      });
    case "dispute_opened_admin":
      return simpleTemplate(d, {
        subject: `${mp.name}: Nový spor (${d.transactionCode})`,
        title: "Nový spor čeká na řešení",
        intro:
          "Admin notifikace: byl otevřen spor a je potřeba manuální kontrola.",
        highlight: d.note ? `Poznámka: ${esc(d.note)}` : undefined,
      });
    case "hold_set_buyer":
      return simpleTemplate(d, {
        subject: `${mp.name}: Transakce pozastavena (${d.transactionCode})`,
        title: "Transakce je dočasně na hold",
        intro: "Dobrý den,<br>transakce byla dočasně pozastavena.",
        highlight: d.note ? `Důvod hold: ${esc(d.note)}` : undefined,
      });
    case "hold_set_seller":
      return simpleTemplate(d, {
        subject: `${mp.name}: Transakce pozastavena (${d.transactionCode})`,
        title: "Transakce je dočasně na hold",
        intro: "Dobrý den,<br>transakce byla dočasně pozastavena.",
        highlight: d.note ? `Důvod hold: ${esc(d.note)}` : undefined,
      });
    case "refunded_buyer":
      return simpleTemplate(d, {
        subject: `${mp.name}: Platba vrácena (${d.transactionCode})`,
        title: "Platba byla vrácena",
        intro:
          "Dobrý den,<br>platba za transakci byla refundována kupujícímu.",
      });
    case "refunded_seller":
      return simpleTemplate(d, {
        subject: `${mp.name}: Refundace provedena (${d.transactionCode})`,
        title: "U transakce byla provedena refundace",
        intro:
          "Dobrý den,<br>u této transakce byla provedena refundace kupujícímu.",
      });
    case "payout_seller":
      return simpleTemplate(d, {
        subject: `${mp.name}: Výplata odeslána (${d.transactionCode})`,
        title: "Výplata byla odeslána",
        intro:
          "Dobrý den,<br>výplata k této transakci byla odeslána na váš payout účet.",
        includePayout: true,
      });
    case "payout_admin":
      return simpleTemplate(d, {
        subject: `${mp.name}: Výplata zpracována (${d.transactionCode})`,
        title: "Výplata byla zpracována",
        intro: "Admin notifikace: výplata byla úspěšně zpracována.",
        includePayout: true,
      });
    default:
      return null;
  }
}
