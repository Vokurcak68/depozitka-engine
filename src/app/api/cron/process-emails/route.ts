import { NextRequest, NextResponse } from "next/server";
import { preflight, verifyCron, withCors } from "@/lib/cron-auth";
import { runProcessEmails } from "@/lib/jobs/process-emails";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * HTTP wrapper around runProcessEmails().
 * Used by:
 *   - manual trigger from Core UI (POST + Bearer/?token=)
 *   - direct curl/manual ops (GET + Bearer)
 *
 * The Vercel scheduled cron does NOT call this — it calls /api/cron/daily-jobs
 * which invokes runProcessEmails() directly in-process (no HTTP, no auth).
 */
export async function GET(req: NextRequest) {
  const authError = verifyCron(req);
  if (authError) return withCors(authError);

  const result = await runProcessEmails();
  return withCors(NextResponse.json(result, { status: result.status }));
}

export async function POST(req: NextRequest) {
  return GET(req);
}

export async function OPTIONS() {
  return preflight();
}
