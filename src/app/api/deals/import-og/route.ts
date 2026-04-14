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

function extractMetaProperty(html: string, key: string): string | undefined {
  const re1 = new RegExp(`<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${key}["'][^>]*>`, "i");
  return html.match(re1)?.[1] || html.match(re2)?.[1];
}

function extractMetaName(html: string, key: string): string | undefined {
  const re1 = new RegExp(`<meta[^>]+name=["']${key}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${key}["'][^>]*>`, "i");
  return html.match(re1)?.[1] || html.match(re2)?.[1];
}

function extractMetaAny(html: string, key: string): string | undefined {
  return extractMetaProperty(html, key) || extractMetaName(html, key);
}

function extractTitle(html: string): string | undefined {
  const og = extractMetaProperty(html, "og:title");
  if (og) return og;
  const tw = extractMetaAny(html, "twitter:title") || extractMetaAny(html, "title");
  if (tw) return tw;
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m?.[1]?.trim();
}

function isGenericTitle(t: string | null | undefined): boolean {
  const s = String(t || "").trim().toLowerCase();
  if (!s) return true;
  return (
    s === "facebook" ||
    s === "instagram" ||
    s === "log in" ||
    s.includes("log into facebook") ||
    s.includes("facebook – přihlášení") ||
    s.includes("facebook — přihlášení") ||
    s.includes("facebook - log in")
  );
}

function unwrapFacebookRedirect(u: URL): URL {
  // FB sometimes wraps outbound links like https://l.facebook.com/l.php?u=<encoded>
  try {
    const host = u.hostname.toLowerCase();
    if (host === "l.facebook.com" || host === "lm.facebook.com") {
      const target = u.searchParams.get("u");
      if (target) return new URL(target);
    }
  } catch {
    // ignore
  }
  return u;
}

function isFacebookHost(u: URL): boolean {
  const h = u.hostname.toLowerCase();
  return h === "facebook.com" || h.endsWith(".facebook.com") || h === "fb.com" || h.endsWith(".fb.com");
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
    const u0 = parsePublicHttpUrl(body.url);
    const u = unwrapFacebookRedirect(u0);

    if (isFacebookHost(u)) {
      return json(
        400,
        {
          ok: false,
          error: "FB_LOGIN_REQUIRED",
        },
        origin,
      );
    }

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

    // Prefer OG/Twitter description; fall back to meta name=description.
    const titleRaw = safeText(extractTitle(html), 180) || null;
    const descRaw =
      safeText(
        extractMetaProperty(html, "og:description") ||
          extractMetaAny(html, "twitter:description") ||
          extractMetaName(html, "description"),
        1000,
      ) || null;

    // FB sometimes serves a generic login/landing HTML with useless title/description.
    const title = isGenericTitle(titleRaw) ? null : titleRaw;
    const description = title ? descRaw : null;

    const imageRaw = safeText(extractMetaProperty(html, "og:image") || extractMetaAny(html, "twitter:image"), 1200) || null;

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
