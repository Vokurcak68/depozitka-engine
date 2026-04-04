import { NextRequest, NextResponse } from "next/server";
import { verifyCron } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Master orchestrator — runs all cron jobs sequentially.
 * Vercel Hobby tier allows only 1 cron schedule, so this chains them.
 * 
 * Order:
 * 1. fio-sync (match incoming payments)
 * 2. process-emails (send queued emails)
 * 3. fio-payout (send seller payouts)
 * 
 * Each job failure doesn't block the next.
 */
export async function GET(req: NextRequest) {
  const authError = verifyCron(req);
  if (authError) return authError;

  const baseUrl = getBaseUrl(req);
  const cronSecret = process.env.CRON_SECRET || "";

  const jobs = [
    "fio-sync",
    "process-emails",
    "fio-payout",
  ];

  const results: Record<string, unknown> = {};

  for (const job of jobs) {
    try {
      const res = await fetch(`${baseUrl}/api/cron/${job}`, {
        headers: {
          Authorization: `Bearer ${cronSecret}`,
        },
      });
      results[job] = {
        status: res.status,
        ...(await res.json().catch(() => ({ body: "non-json" }))),
      };
    } catch (err) {
      console.error(`Job ${job} failed:`, err);
      results[job] = {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return NextResponse.json({
    ok: true,
    ran_at: new Date().toISOString(),
    results,
  });
}

function getBaseUrl(req: NextRequest): string {
  // Vercel sets this header
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") || "https";
  return `${proto}://${host}`;
}
