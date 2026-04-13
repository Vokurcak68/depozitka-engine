import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { corsHeaders } from "@/lib/direct-deals";
import { parsePublicHttpUrl, randomToken, safeText } from "@/lib/deals";
import { randomId } from "@/lib/support";

export const runtime = "nodejs";

type Body = {
  url: string;
};

function json(status: number, data: unknown, origin?: string) {
  return new NextResponse(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
    },
  });
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req.headers.get("origin") || undefined),
  });
}

function extractMeta(html: string, key: string): string | undefined {
  const re1 = new RegExp(`<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${key}["'][^>]*>`, "i");
  return html.match(re1)?.[1] || html.match(re2)?.[1];
}

function extractTitle(html: string): string | undefined {
  const og = extractMeta(html, "og:title");
  if (og) return og;
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m?.[1]?.trim();
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin") || undefined;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" }, origin);
  }

  try {
    const u = parsePublicHttpUrl(body.url);

    const r = await fetch(u.toString(), {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": "DepozitkaBot/1.0 (+https://depozitka.eu)",
        accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!r.ok) {
      return json(400, { ok: false, error: "FETCH_FAILED" }, origin);
    }

    const ctype = (r.headers.get("content-type") || "").toLowerCase();
    if (!ctype.includes("text/html")) {
      return json(400, { ok: false, error: "NOT_HTML" }, origin);
    }

    const html = await r.text();
    const title = safeText(extractTitle(html), 180) || null;
    const description = safeText(extractMeta(html, "og:description") || extractMeta(html, "description"), 1000) || null;
    const imageRaw = safeText(extractMeta(html, "og:image"), 1200) || null;

    let imageStoragePath: string | null = null;

    if (imageRaw) {
      try {
        const imgUrl = new URL(imageRaw, u.toString());
        if (imgUrl.protocol === "http:" || imgUrl.protocol === "https:") {
          const imgRes = await fetch(imgUrl.toString(), {
            method: "GET",
            redirect: "follow",
            headers: { "user-agent": "DepozitkaBot/1.0 (+https://depozitka.eu)" },
            signal: AbortSignal.timeout(10_000),
          });

          if (imgRes.ok) {
            const imgType = (imgRes.headers.get("content-type") || "application/octet-stream").toLowerCase();
            const ab = await imgRes.arrayBuffer();
            const max = 5 * 1024 * 1024;
            if (ab.byteLength > 0 && ab.byteLength <= max) {
              const ext = imgType.includes("png")
                ? "png"
                : imgType.includes("webp")
                  ? "webp"
                  : imgType.includes("gif")
                    ? "gif"
                    : "jpg";

              const path = `og/${Date.now()}-${randomId()}-${randomToken(4)}.${ext}`;

              const sb = supabase as unknown as { storage: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
              const { error: upErr } = await sb.storage
                .from("dpt-deal-attachments")
                .upload(path, Buffer.from(ab), {
                  contentType: imgType,
                  upsert: false,
                });

              if (!upErr) {
                imageStoragePath = path;
              }
            }
          }
        }
      } catch {
        // ignore image failures
      }
    }

    return json(
      200,
      {
        ok: true,
        snapshot: {
          url: u.toString(),
          title,
          description,
          image: imageRaw,
          fetchedAt: new Date().toISOString(),
        },
        imageStoragePath,
      },
      origin,
    );
  } catch (e: unknown) {
    const code =
      typeof e === "object" && e !== null && "code" in e
        ? String((e as { code?: unknown }).code)
        : undefined;

    const message = e instanceof Error ? e.message : String(e);
    return json(400, { ok: false, error: code || message || "BAD_REQUEST" }, origin);
  }
}
