import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function cors(res: NextResponse): NextResponse {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return res;
}

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

export async function GET() {
  const now = new Date().toISOString();

  try {
    const supabase = getSupabase();
    const { error } = await supabase.from("dpt_settings").select("key").limit(1);

    if (error) {
      return cors(
        NextResponse.json(
          {
            ok: false,
            service: "depozitka-engine",
            status: "degraded",
            timestamp: now,
            checks: {
              supabase: {
                ok: false,
                message: error.message,
              },
            },
          },
          { status: 503 },
        ),
      );
    }

    return cors(
      NextResponse.json({
        ok: true,
        service: "depozitka-engine",
        status: "ok",
        timestamp: now,
        checks: {
          supabase: { ok: true },
        },
      }),
    );
  } catch (err) {
    return cors(
      NextResponse.json(
        {
          ok: false,
          service: "depozitka-engine",
          status: "down",
          timestamp: now,
          error: err instanceof Error ? err.message : "unknown_error",
        },
        { status: 500 },
      ),
    );
  }
}
