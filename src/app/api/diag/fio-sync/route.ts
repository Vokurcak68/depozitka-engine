import { NextRequest, NextResponse } from "next/server";
import { verifyCron, withCors, preflight } from "@/lib/cron-auth";
import { FIO_API_BASE, FIO_SYNC_START_DATE } from "@/lib/jobs/fio-sync";

export const dynamic = "force-dynamic";

function summarizeTxs(rawTxs: Array<Record<string, { value?: unknown } | null>>) {
  const txs = (rawTxs || []).map((t) => {
    const get = (col: string) => (t[col]?.value ?? null);
    const amountRaw = get("column1");
    const amount = typeof amountRaw === "number" ? amountRaw : Number(amountRaw);

    return {
      bankTxId: get("column22"),
      date: get("column0"),
      amount: Number.isFinite(amount) ? amount : null,
      vs: get("column5")?.toString?.() || null,
      message: get("column16")?.toString?.() || null,
    };
  });

  const incoming = txs.filter((t) => typeof t.amount === "number" && t.amount > 0);
  const latestIncoming = incoming
    .filter((t) => t.date)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0] || null;

  return {
    total: txs.length,
    incomingCount: incoming.length,
    latestIncoming,
    sampleIncoming: incoming.slice(0, 10),
  };
}

export async function GET(req: NextRequest) {
  const authError = verifyCron(req);
  if (authError) return withCors(authError);

  const FIO_TOKEN = process.env.FIO_API_TOKEN;
  if (!FIO_TOKEN) {
    return withCors(NextResponse.json({ error: "FIO_API_TOKEN not configured" }, { status: 500 }));
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const fioUrl = `${FIO_API_BASE}/periods/${FIO_TOKEN}/${FIO_SYNC_START_DATE}/${today}/transactions.json`;

    const fioRes = await fetch(fioUrl, { headers: { Accept: "application/json" } });
    const bodyText = await fioRes.text();

    if (!fioRes.ok) {
      return withCors(
        NextResponse.json(
          {
            ok: false,
            fioStatus: fioRes.status,
            fioUrl: fioUrl.replace(FIO_TOKEN, "***"),
            detail: bodyText.slice(0, 1000),
          },
          { status: 502 }
        )
      );
    }

    const data = JSON.parse(bodyText);
    const info = data?.accountStatement?.info || {};
    const rawTxs = data?.accountStatement?.transactionList?.transaction || [];
    const summary = summarizeTxs(rawTxs);

    return withCors(
      NextResponse.json({
        ok: true,
        fioUrl: fioUrl.replace(FIO_TOKEN, "***"),
        range: {
          from: FIO_SYNC_START_DATE,
          to: today,
          statementFrom: info.dateStart || null,
          statementTo: info.dateEnd || null,
        },
        counts: {
          total: summary.total,
          incoming: summary.incomingCount,
        },
        latestIncoming: summary.latestIncoming,
        sampleIncoming: summary.sampleIncoming,
      })
    );
  } catch (err) {
    return withCors(
      NextResponse.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : "Unknown error",
        },
        { status: 500 }
      )
    );
  }
}

export async function OPTIONS() {
  return preflight();
}
