import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

const FIO_API_BASE = process.env.FIO_API_BASE || "https://fioapi.fio.cz/v1/rest";

function cors(res: NextResponse): NextResponse {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return res;
}

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

/**
 * GET /api/fio/status
 * Returns last 14 days of FIO account transactions (both in + out)
 * for monitoring outgoing payouts.
 *
 * Auth: CRON_SECRET (Bearer header)
 */
export async function GET(req: NextRequest) {
  const authError = verifyCron(req);
  if (authError) return cors(authError);

  const FIO_TOKEN = process.env.FIO_API_TOKEN;
  if (!FIO_TOKEN) {
    return cors(NextResponse.json({ error: "FIO_API_TOKEN not configured" }, { status: 500 }));
  }

  try {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 14);
    const fmt = (d: Date) => d.toISOString().split("T")[0];

    const url = `${FIO_API_BASE}/periods/${FIO_TOKEN}/${fmt(start)}/${fmt(end)}/transactions.json`;
    const fioRes = await fetch(url);

    if (!fioRes.ok) {
      const text = await fioRes.text();
      return cors(
        NextResponse.json(
          { error: `FIO ${fioRes.status}`, details: text.substring(0, 1000) },
          { status: 502 }
        )
      );
    }

    const data = await fioRes.json();
    const info = data?.accountStatement?.info || {};
    const rawTxs = data?.accountStatement?.transactionList?.transaction || [];

    // FIO transactions have numeric column keys, normalize
    const txs = rawTxs.map((t: Record<string, { value?: unknown; name?: string } | null>) => {
      const get = (col: string) => (t[col]?.value ?? null);
      return {
        id: get("column22"),
        date: get("column0"),
        amount: get("column1"),
        currency: get("column14"),
        counterAccount: get("column2"),
        counterBankCode: get("column3"),
        counterName: get("column10"),
        vs: get("column5"),
        ks: get("column4"),
        ss: get("column6"),
        userIdentification: get("column7"),
        messageForRecipient: get("column16"),
        type: get("column8"),
      };
    });

    // Filter only outgoing (negative amount)
    const outgoing = txs.filter((t: { amount: unknown }) => typeof t.amount === "number" && (t.amount as number) < 0);
    const incoming = txs.filter((t: { amount: unknown }) => typeof t.amount === "number" && (t.amount as number) > 0);

    return cors(
      NextResponse.json({
        success: true,
        account: {
          iban: info.iban,
          bic: info.bic,
          accountId: info.accountId,
          bankId: info.bankId,
          closingBalance: info.closingBalance,
          currency: info.currency,
          dateStart: info.dateStart,
          dateEnd: info.dateEnd,
        },
        outgoing,
        incoming,
        totalCount: txs.length,
      })
    );
  } catch (err) {
    return cors(
      NextResponse.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        { status: 500 }
      )
    );
  }
}
