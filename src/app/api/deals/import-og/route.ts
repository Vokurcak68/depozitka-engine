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

type ImportedAttachment = {
  storagePath: string;
  fileName: string;
  contentType: string;
  fileSize: number;
};

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

function extractAllMetaProperty(html: string, key: string): string[] {
  // Match both orders: property=... content=... and content=... property=...
  const out: string[] = [];
  const re1 = new RegExp(`<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']+)["'][^>]*>`, "ig");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${key}["'][^>]*>`, "ig");

  for (const m of html.matchAll(re1)) out.push(m[1]);
  for (const m of html.matchAll(re2)) out.push(m[1]);

  return Array.from(new Set(out.map((s) => s.trim()).filter(Boolean)));
}

function extractJsonLdCandidates(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const raw = (m[1] || "").trim();
    // keep it cheap + safe
    if (!raw || raw.length > 200_000) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      // ignore
    }
  }
  return out;
}

function pickFromJsonLd(docs: unknown[]): { title?: string; description?: string; images?: string[] } {
  const images: string[] = [];
  let title: string | undefined;
  let description: string | undefined;

  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;

    // If graph, walk it
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }

    if (node["@graph"]) visit(node["@graph"]);

    const name = typeof node.name === "string" ? node.name : undefined;
    const desc = typeof node.description === "string" ? node.description : undefined;

    if (!title && name) title = name;
    if (!description && desc) description = desc;

    const img = node.image;
    if (typeof img === "string") images.push(img);
    else if (Array.isArray(img)) {
      for (const it of img) {
        if (typeof it === "string") images.push(it);
        else if (it && typeof it === "object" && typeof it.url === "string") images.push(it.url);
      }
    } else if (img && typeof img === "object" && typeof img.url === "string") {
      images.push(img.url);
    }
  };

  for (const d of docs) visit(d as any);

  const uniqImages = Array.from(new Set(images.map((s) => s.trim()).filter(Boolean)));
  return { title, description, images: uniqImages.length ? uniqImages : undefined };
}

async function downloadImageToStorage(u: URL, pageBase: URL, imageUrlRaw: string, maxBytes: number): Promise<ImportedAttachment | null> {
  try {
    const imgUrl = new URL(imageUrlRaw, pageBase.toString());
    if (imgUrl.protocol !== "http:" && imgUrl.protocol !== "https:") return null;

    const imgRes = await fetch(imgUrl.toString(), {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": "DepozitkaBot/1.0 (+https://depozitka.eu)" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!imgRes.ok) return null;

    const imgType = (imgRes.headers.get("content-type") || "application/octet-stream").toLowerCase();
    const ab = await imgRes.arrayBuffer();
    if (ab.byteLength <= 0 || ab.byteLength > maxBytes) return null;

    const ext = imgType.includes("png")
      ? "png"
      : imgType.includes("webp")
        ? "webp"
        : imgType.includes("gif")
          ? "gif"
          : "jpg";

    const storagePath = `og/${Date.now()}-${randomId()}-${randomToken(4)}.${ext}`;

    const sb = supabase as unknown as { storage: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const { error: upErr } = await sb.storage.from("dpt-deal-attachments").upload(storagePath, Buffer.from(ab), {
      contentType: imgType,
      upsert: false,
    });

    if (upErr) return null;

    return {
      storagePath,
      fileName: `inzerat.${ext}`,
      contentType: imgType,
      fileSize: ab.byteLength,
    };
  } catch {
    return null;
  }
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

    // Images: collect from OG + twitter + JSON-LD (some sites don't expose og:image)
    const ogImages = extractAllMetaProperty(html, "og:image");
    const twImage = extractMetaAny(html, "twitter:image") || undefined;
    const jsonLd = extractJsonLdCandidates(html);
    const jsonLdPicked = pickFromJsonLd(jsonLd);

    const candidateImages = Array.from(
      new Set([
        ...ogImages,
        ...(twImage ? [twImage] : []),
        ...((jsonLdPicked.images || []) as string[]),
      ].map((s) => String(s).trim()).filter(Boolean)),
    ).slice(0, 6);

    const maxImgBytes = 5 * 1024 * 1024;

    // Keep backward compatible: store the first downloaded image as imageStoragePath
    let imageStoragePath: string | null = null;
    const importedAttachments: ImportedAttachment[] = [];

    for (const img of candidateImages) {
      const att = await downloadImageToStorage(u, u, img, maxImgBytes);
      if (!att) continue;
      importedAttachments.push(att);
      if (!imageStoragePath) imageStoragePath = att.storagePath;
      // cap
      if (importedAttachments.length >= 6) break;
    }

    return json(
      200,
      {
        ok: true,
        snapshot: {
          url: u.toString(),
          title,
          description,
          images: candidateImages,
          fetchedAt: new Date().toISOString(),
        },
        imageStoragePath,
        importedAttachments,
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
