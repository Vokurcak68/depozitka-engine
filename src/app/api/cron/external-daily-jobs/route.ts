import { NextRequest, NextResponse } from "next/server";
import { preflight, verifyCron, withCors } from "@/lib/cron-auth";
import { executeDailyJobs } from "@/lib/jobs/daily-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function getTriggeredBy(req: NextRequest): string {
  const source = req.nextUrl.searchParams.get("source")?.trim();
  if (!source) return "external_trigger";

  const safe = source.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40);
  return safe ? `external_trigger@${safe}` : "external_trigger";
}

async function run(req: NextRequest) {
  const authError = verifyCron(req);
  if (authError) return withCors(authError);

  const result = await executeDailyJobs(getTriggeredBy(req));
  return withCors(NextResponse.json(result, { status: result.ok ? 200 : 500 }));
}

export async function GET(req: NextRequest) {
  return run(req);
}

export async function POST(req: NextRequest) {
  return run(req);
}

export async function OPTIONS() {
  return preflight();
}
