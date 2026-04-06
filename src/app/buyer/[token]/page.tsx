import { supabase } from "@/lib/supabase";
import { notFound } from "next/navigation";
import BuyerForm from "./BuyerForm";

export const dynamic = "force-dynamic";

export default async function BuyerPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Validate UUID format
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    notFound();
  }

  const { data: tx } = await supabase
    .from("dpt_transactions")
    .select("id, transaction_code")
    .eq("buyer_token", token)
    .single();

  if (!tx) notFound();

  return (
    <html lang="cs">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Bezpečná platba — {tx.transaction_code}</title>
        <style>{`
          *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
          :root {
            --bg: #f8fafc; --card: #fff; --text: #1e293b; --muted: #64748b;
            --border: #e2e8f0; --accent: #2563eb; --accent-hover: #1d4ed8;
            --success-bg: #f0fdf4; --success-border: #86efac; --success-text: #166534;
            --error-bg: #fef2f2; --error-border: #fca5a5; --error-text: #991b1b;
            --info-bg: #eff6ff; --info-border: #93c5fd; --info-text: #1e40af;
          }
          @media (prefers-color-scheme: dark) {
            :root {
              --bg: #0f172a; --card: #1e293b; --text: #f1f5f9; --muted: #94a3b8;
              --border: #334155; --accent: #3b82f6; --accent-hover: #60a5fa;
              --success-bg: #052e16; --success-border: #16a34a; --success-text: #86efac;
              --error-bg: #450a0a; --error-border: #dc2626; --error-text: #fca5a5;
              --info-bg: #172554; --info-border: #2563eb; --info-text: #93c5fd;
            }
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg); color: var(--text);
            min-height: 100vh; display: flex; justify-content: center; align-items: flex-start;
            padding: 24px 16px;
          }
          .container { max-width: 480px; width: 100%; }
          .card {
            background: var(--card); border: 1px solid var(--border);
            border-radius: 16px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,.1);
          }
          .logo { text-align: center; margin-bottom: 16px; font-size: 0.85rem; color: var(--muted); letter-spacing: 1px; text-transform: uppercase; }
          h1 { font-size: 1.25rem; margin-bottom: 16px; }
          h2 { font-size: 1.1rem; }
          .info { display: flex; flex-direction: column; gap: 6px; margin-bottom: 20px; font-size: 0.9rem; }
          .info span { color: var(--muted); }
          .info strong { color: var(--text); }
          .amount { font-size: 1.3rem; font-weight: 700; }
          .vs { font-size: 1.2rem; font-weight: 700; color: var(--accent); }
          .alert { padding: 14px 16px; border-radius: 10px; font-size: 0.9rem; margin-bottom: 16px; line-height: 1.5; }
          .alert-success { background: var(--success-bg); border: 1px solid var(--success-border); color: var(--success-text); }
          .alert-info { background: var(--info-bg); border: 1px solid var(--info-border); color: var(--info-text); }
          .alert-error { background: var(--error-bg); border: 1px solid var(--error-border); color: var(--error-text); }
          .payment-box {
            display: flex; flex-direction: column; gap: 8px;
            padding: 16px; background: var(--info-bg); border: 1px solid var(--info-border);
            border-radius: 10px; font-size: 0.9rem;
          }
          .payment-box span { color: var(--muted); }
          label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px; color: var(--muted); }
          select, input[type="text"] {
            width: 100%; padding: 10px 12px; border: 1px solid var(--border);
            border-radius: 8px; font-size: 1rem; background: var(--bg); color: var(--text);
            margin-bottom: 14px; -webkit-appearance: none;
          }
          select:focus, input:focus { outline: 2px solid var(--accent); border-color: transparent; }
          button[type="submit"] {
            width: 100%; padding: 12px; border: none; border-radius: 10px;
            background: var(--accent); color: #fff; font-size: 1rem; font-weight: 600;
            cursor: pointer; transition: background 120ms;
          }
          button[type="submit"]:hover { background: var(--accent-hover); }
          button[type="submit"]:disabled { opacity: .5; cursor: not-allowed; }
          .footer { text-align: center; margin-top: 16px; font-size: 0.75rem; color: var(--muted); }
        `}</style>
      </head>
      <body>
        <div className="container">
          <div className="card">
            <div className="logo">Depozitka — Bezpečná platba</div>
            <h1>🔒 Bezpečná platba</h1>
            <BuyerForm token={token} />
          </div>
          <div className="footer">Depozitka © {new Date().getFullYear()}</div>
        </div>
      </body>
    </html>
  );
}
