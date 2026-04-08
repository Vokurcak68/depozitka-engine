import { NextRequest, NextResponse } from "next/server";
import { verifyCron, withCors } from "@/lib/cron-auth";
import { runFioSync } from "@/lib/jobs/fio-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * HTTP wrapper around runFioSync().
 * Used by:
 *   - manual trigger from Core UI (POST + Bearer/?token=)
 *   - direct curl/manual ops (GET + Bearer)
 *
 * The Vercel scheduled cron does NOT call this — it calls /api/cron/daily-jobs
 * which invokes runFioSync() directly in-process (no HTTP, no auth).
 */
export async function GET(req: NextRequest) {
  const authError = verifyCron(req);
  if (authError) return withCors(authError);

  const result = await runFioSync();
  return withCors(NextResponse.json(result, { status: result.status }));
}

export async function POST(req: NextRequest) {
  return GET(req);
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    },
  });
}
