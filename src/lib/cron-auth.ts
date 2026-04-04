import { NextRequest, NextResponse } from "next/server";

/**
 * Verify Vercel cron secret.
 * Returns null if OK, or a 401 NextResponse if unauthorized.
 */
export function verifyCron(req: NextRequest): NextResponse | null {
  const secret = req.headers.get("authorization");
  if (!process.env.CRON_SECRET) {
    // No secret configured — allow in dev
    if (process.env.NODE_ENV === "development") return null;
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (secret !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
