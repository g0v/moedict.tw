/**
 * Workers Cache policy helpers for moedict.tw.
 *
 * Edge TTLs use s-maxage; browser TTLs use shorter max-age so a purge
 * (or redeploy) is not stuck behind multi-day client caches.
 * Cache-Tag values are ASCII-only (Cloudflare silently drops invalid tags).
 */
import type { OptionalVersionMetadata } from "./release-fallback";

export type DictionaryLang = "a" | "t" | "h" | "c";
const LANGS: DictionaryLang[] = ["a", "t", "h", "c"];

/** Coarse tags used on cacheable dictionary/static GETs. */
export const DICTIONARY_CACHE_TAGS: readonly string[] = [
  "dict",
  ...LANGS.map((lang) => `dict-${lang}`),
  "list",
  ...LANGS.map((lang) => `list-${lang}`),
  "search-index",
  ...LANGS.map((lang) => `search-index-${lang}`),
  "index",
  ...LANGS.map((lang) => `index-${lang}`),
  "xref",
  ...LANGS.map((lang) => `xref-${lang}`),
  "translation",
  "translation-cfdict",
  "stroke",
  "png",
  "assets",
  "appcache",
  "cns",
  "cns-record",
];

const ALLOWED_TAG_SET = new Set<string>(DICTIONARY_CACHE_TAGS);

/** Browser short / edge long splits. */
export const CACHE_CONTROL = {
  /** Dictionary entry JSON */
  dict: "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800",
  /** Category list JSON */
  list: "public, max-age=300, s-maxage=3600",
  /** Full-text search index */
  searchIndex: "public, max-age=3600, s-maxage=604800, stale-while-revalidate=86400",
  /** Sidebar index */
  index: "public, max-age=60, s-maxage=300",
  /** Cross-language xref */
  xref: "public, max-age=300, s-maxage=3600",
  /** cfdict translation dumps */
  translation: "public, max-age=3600, s-maxage=86400",
  /** Stroke JSON proxy */
  stroke: "public, max-age=3600, s-maxage=86400",
  /** Generated word PNG (edge long, browser 1 day) */
  png: "public, max-age=86400, s-maxage=31536000",
  /** Static-ish assets (badge, appcache) */
  staticDay: "public, max-age=3600, s-maxage=86400",
  /** HTML SPA shell with path-specific head */
  htmlShell: "public, max-age=0, s-maxage=60",
  /** Content-hashed /assets/* from R2 fallback — immutable, 1 year */
  immutableAsset: "public, max-age=31536000, immutable",
  /** 503 recovery response — never cached */
  recovery: "no-store",
} as const;

export type PurgeOptions =
  | { tags: string[]; pathPrefixes?: string[] }
  | { pathPrefixes: string[]; tags?: string[] }
  | { purgeEverything: true };

export type CachePurger = (options: PurgeOptions) => Promise<unknown>;

export function dictTagsForLang(lang: DictionaryLang): string {
  return `dict,dict-${lang}`;
}

export function listTagsForLang(lang: DictionaryLang): string {
  return `list,list-${lang}`;
}

/** Filter client-supplied tags to the known allowlist. */
export function filterAllowedTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = String(raw || "").trim();
    if (!tag || !ALLOWED_TAG_SET.has(tag) || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function extractPurgeToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1].trim();
  }
  const header = request.headers.get("X-Cache-Purge-Token");
  return header?.trim() || null;
}

export interface PurgeRequestBody {
  tags?: string[];
  /** Specific request URLs to evict from `caches.default` (Worker Cache API). */
  urls?: string[];
  /** When true, purge the full DICTIONARY_CACHE_TAGS set (not purgeEverything). */
  allDictionaryTags?: boolean;
}

export interface HandleCachePurgeOptions {
  env: { CACHE_PURGE_TOKEN?: string; CF_VERSION_METADATA?: OptionalVersionMetadata };
  /** Injected purger — Worker passes ctx.cache.purge.bind(ctx.cache). */
  purge: CachePurger;
  /** Optional function to derive the exact Request cache key used by Worker Cache API. */
  deriveCacheKey?: (request: Request) => Request | null | Promise<Request | null>;
}

/**
 * Protected POST /api/cache/purge handler.
 * Fail-closed: missing secret or bad token → 403.
 * Only whitelisted tags; never arbitrary purgeEverything from the wire.
 */
export async function handleCachePurge(
  request: Request,
  options: HandleCachePurgeOptions,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Allow: "POST",
        "Cache-Control": "no-store",
      },
    });
  }

  const expected = options.env.CACHE_PURGE_TOKEN?.trim();
  if (!expected) {
    return new Response(JSON.stringify({ error: "Forbidden", message: "purge not configured" }), {
      status: 403,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  const provided = extractPurgeToken(request);
  if (!provided || !timingSafeEqualString(provided, expected)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  let body: PurgeRequestBody = {};
  try {
    const text = await request.text();
    if (text.trim()) {
      body = JSON.parse(text) as PurgeRequestBody;
    }
  } catch {
    return new Response(JSON.stringify({ error: "Bad Request", message: "invalid JSON" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  let tags: string[];
  if (body.allDictionaryTags === true || !body.tags || body.tags.length === 0) {
    tags = [...DICTIONARY_CACHE_TAGS];
  } else {
    tags = filterAllowedTags(body.tags);
    if (tags.length === 0) {
      return new Response(JSON.stringify({ error: "Bad Request", message: "no allowed tags" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
  }

  try {
    await options.purge({ tags });
  } catch (err) {
    console.error("[workers cache] purge error", err);
    return new Response(
      JSON.stringify({ error: "Internal Server Error", message: "purge failed" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  // Note on Worker Cache API (caches.default) vs Zone Cache Purge:
  // Cloudflare's Worker Cache API (`caches.default`) requires exact Request matching
  // and does NOT support tag-based, wildcard, prefix, or bulk `purge_everything` operations.
  // Zone Cache Purge (via REST API POST /zones/{zoneId}/purge_cache) evicts CDN edge objects,
  // but does NOT purge `caches.default`.
  // Therefore, Worker Cache API entries must be version-namespaced at key derivation time
  // (see worker/index.ts) so release deployments self-heal, while explicit `urls` purges
  // below provide targeted single-URL deletion from `caches.default`.
  const purgedUrls: string[] = [];
  if (typeof caches !== "undefined" && Array.isArray(body.urls) && body.urls.length > 0) {
    const edgeCache = (caches as unknown as { default: { delete(req: Request): Promise<boolean> } })
      .default;
    for (const urlStr of body.urls) {
      if (typeof urlStr !== "string" || !urlStr.trim()) continue;
      try {
        const u = new URL(urlStr.trim(), request.url);
        const rawReq = new Request(u.toString());
        await edgeCache.delete(rawReq);
        purgedUrls.push(u.toString());

        if (options.deriveCacheKey) {
          const derived = await options.deriveCacheKey(rawReq);
          if (derived && derived.url !== rawReq.url) {
            await edgeCache.delete(derived);
          }
        }
      } catch {
        /* best effort */
      }
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      purgedTags: tags,
      ...(purgedUrls.length > 0 ? { purgedUrls } : {}),
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}
