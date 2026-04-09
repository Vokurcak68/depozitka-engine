import { NextRequest, NextResponse } from "next/server";

/**
 * Verify cron/trigger authorization.
 * Supports:
 * 1) Authorization: Bearer <CRON_SECRET>
 * 2) Query token (?token=...) for browser-triggered manual runs from depozitka-core
 */
export function verifyCron(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : null;

  const expectedManualToken = process.env.MANUAL_EMAIL_TRIGGER_TOKEN || cronSecret;

  // Vercel cron / server-to-server path
  if (cronSecret && bearerToken === cronSecret) {
    return null;
  }

  // Manual trigger via Authorization: Bearer <MANUAL_EMAIL_TRIGGER_TOKEN>
  // (used by Depozitka Core Cron tab)
  if (expectedManualToken && bearerToken === expectedManualToken) {
    return null;
  }

  // Manual browser trigger path via query token
  const manualToken = req.nextUrl.searchParams.get("token");
  if (expectedManualToken && manualToken === expectedManualToken) {
    return null;
  }

  // No secret configured — allow only in development
  if (!cronSecret && process.env.NODE_ENV === "development") {
    return null;
  }

  if (!cronSecret && !expectedManualToken) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export function withCors(res: NextResponse): NextResponse {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  return res;
}

export function preflight(): NextResponse {
  return withCors(new NextResponse(null, { status: 204 }));
}
