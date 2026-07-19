/**
 * R2 release fallback logic + version metadata helpers.
 *
 * This module provides the fallback layer that eliminates the
 * `renderHtmlShell` → `null` → `404` fallthrough. When `SITE_ASSETS.fetch`
 * returns non-OK or throws, the Worker reads the current release's
 * `index.html` from R2, injects head metadata, and serves it. If both
 * `SITE_ASSETS` and R2 fail (or the release tag is absent), the Worker
 * returns a self-contained 503 recovery response.
 *
 * Key derivation is imported from the shared `src/utils/release-keys.ts`
 * — no duplicate string concatenation.
 *
 * R2 object bodies are streamed directly (`new Response(object.body, ...)`)
 * — never `await object.text()` for asset responses.
 */

import { CACHE_CONTROL } from "./cache";
import {
  immutableKey,
  isImmutableAsset,
  releaseKey,
  validateReleaseTag,
} from "../utils/release-keys";

/**
 * The `version_metadata` binding shape from the Cloudflare runtime.
 * `id` = Cloudflare version UUID (NOT the release ID).
 * `tag` = release ID (our `--tag` value to `wrangler versions upload`).
 * `timestamp` = ISO 8601 deployment timestamp.
 */
export interface VersionMetadata {
  id: string;
  tag: string;
  timestamp: string;
}

/** Allow VersionMetadata | undefined everywhere the binding may be absent. */
export type OptionalVersionMetadata = VersionMetadata | undefined;

/** Minimal R2 object body shape used by this module. */
export interface R2ObjectBodyLike {
  body: ReadableStream<Uint8Array>;
  httpEtag: string;
  size?: number;
  writeHttpMetadata(headers: Headers): void;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Minimal R2 bucket shape used by this module. */
export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
}

/** Minimal Fetcher shape used by this module. */
export interface FetcherLike {
  fetch(request: Request): Promise<Response>;
}

/**
 * Extract the Cloudflare version UUID for diagnostic headers.
 * Returns `"unknown"` when metadata is absent or id is empty.
 */
export function getVersionId(meta: OptionalVersionMetadata): string {
  return meta?.id || "unknown";
}

/**
 * Extract the release tag for diagnostic headers.
 * Returns `null` when metadata is absent or tag is empty.
 * A null return means "skip R2 fallback" — do NOT construct
 * `releases/unknown/...` R2 keys.
 */
export function getReleaseTag(meta: OptionalVersionMetadata): string | null {
  const tag = meta?.tag;
  if (!tag) return null;
  try {
    validateReleaseTag(tag);
    return tag;
  } catch {
    return null;
  }
}

/**
 * Build version headers for a response.
 * - `X-Moedict-Version`: always set (UUID or `"unknown"`)
 * - `X-Moedict-Release`: omitted entirely when tag is absent/empty
 */
export function getVersionHeaders(meta: OptionalVersionMetadata): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Moedict-Version": getVersionId(meta),
  };
  const tag = getReleaseTag(meta);
  if (tag) {
    headers["X-Moedict-Release"] = tag;
  }
  return headers;
}

/** Fixed CORS for public asset GETs. */
const PUBLIC_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * Minimal self-contained 503 recovery HTML page.
 * Auto-refreshes after 5 seconds.
 */
const RECOVERY_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="5">
  <title>萌典 — 服務暫時無法使用</title>
  <style>
    body { font-family: sans-serif; text-align: center; padding: 2rem; }
    h1 { font-size: 1.5rem; }
    p { color: #666; }
  </style>
</head>
<body>
  <h1>萌典服務暫時無法使用</h1>
  <p>正在自動重試，請稍候…</p>
</body>
</html>`;

/**
 * Create the 503 recovery response.
 * This is the ONLY both-stores-fail outcome for HTML routes — never 404.
 */
export function createRecoveryResponse(_request: Request, meta: OptionalVersionMetadata): Response {
  const headers: HeadersInit = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": CACHE_CONTROL.recovery,
    "Retry-After": "5",
    "X-Moedict-Shell-Source": "recovery",
    ...getVersionHeaders(meta),
  };
  return new Response(RECOVERY_HTML, { status: 503, headers });
}

/**
 * Serve an R2 object as an HTTP response with proper headers.
 * Streams the body directly — no `await object.text()`.
 *
 * Handles ETag/If-None-Match → 304, HEAD, CORS, and Cache-Control.
 */
function serveR2Object(
  object: R2ObjectBodyLike,
  request: Request,
  options: {
    cacheControl: string;
    source: string;
    meta: OptionalVersionMetadata;
  },
): Response {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);

  // Version/asset-source headers
  const versionHeaders = getVersionHeaders(options.meta);
  for (const [k, v] of Object.entries(versionHeaders)) {
    headers.set(k, v);
  }
  headers.set("X-Moedict-Asset-Source", options.source);

  // ETag / If-None-Match → 304
  if (request.headers.get("If-None-Match") === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  // CORS — all public asset GETs
  for (const [k, v] of Object.entries(PUBLIC_CORS_HEADERS)) {
    headers.set(k, v);
  }

  // Cache-Control
  headers.set("Cache-Control", options.cacheControl);

  // HEAD
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(object.body, { status: 200, headers });
}

/**
 * Environment shape needed by the fallback functions.
 * Kept loose to avoid circular imports with worker/index.ts.
 */
export interface FallbackEnv {
  SITE_ASSETS?: FetcherLike;
  ASSETS: R2BucketLike;
  CF_VERSION_METADATA?: VersionMetadata;
}

/**
 * Render the HTML shell with R2 fallback.
 *
 * Flow:
 * 1. Try SITE_ASSETS.fetch("/") [fast path]
 *    → if OK: inject head metadata, set source=site-assets, return Response
 *    → if non-OK or throw: fall through to R2 (if tag present) or 503
 * 2. If tag present: R2 fallback: env.ASSETS.get("releases/<tag>/index.html")
 *    → if found: inject head metadata, set source=r2-release, return Response
 * 3. Both fail (or tag absent): return self-contained 503
 *
 * The `injectHead` callback is passed in to avoid a circular import
 * with worker/index.ts (which owns the dictionary-lookup-aware injection).
 *
 * Returns a Response — never null. The 503 recovery is the ONLY
 * both-stores-fail outcome for HTML routes.
 */
export async function renderHtmlShellWithFallback<E extends FallbackEnv>(
  request: Request,
  env: E,
  pathname: string,
  injectHead: (html: string, pathname: string, env: E) => Promise<string>,
): Promise<Response> {
  const meta = env.CF_VERSION_METADATA;
  const tag = getReleaseTag(meta);

  // Track SITE_ASSETS result for the final structured log.
  let siteAssetsResult: "non-ok" | "throw" | "no-fetcher" = "no-fetcher";
  let siteAssetsStatus: number | null = null;

  // ── Fast path: SITE_ASSETS ──────────────────────────────────────────
  const fetcher = env.SITE_ASSETS;
  if (fetcher && typeof fetcher.fetch === "function") {
    try {
      const shellUrl = new URL("/", request.url);
      // Strip conditional-request headers (If-None-Match/If-Modified-Since)
      // before this internal fetch: the shell HTML is always rewritten with
      // route-specific head metadata (title/og:*) via injectHead below, so a
      // 304 (empty body) from SITE_ASSETS validating the CLIENT's cached copy
      // of some earlier route's rewritten HTML against its own unmodified
      // index.html ETag would leave nothing to inject into -- forwarding
      // those headers made every conditional-GET for the SPA shell fall
      // through the entire R2/legacy chain to 503 recovery instead of
      // simply fetching the real body once and rewriting it, exactly like
      // the browser never sent a conditional request at all.
      const shellRequestInit = new Request(shellUrl.toString(), request);
      shellRequestInit.headers.delete("If-None-Match");
      shellRequestInit.headers.delete("If-Modified-Since");
      const shellResponse = await fetcher.fetch(shellRequestInit);
      if (shellResponse.ok) {
        if (request.method === "HEAD") {
          const headers = new Headers(shellResponse.headers);
          headers.set("Content-Type", "text/html; charset=utf-8");
          headers.set("Cache-Control", CACHE_CONTROL.htmlShell);
          headers.set("X-Moedict-Shell-Source", "site-assets");
          for (const [k, v] of Object.entries(getVersionHeaders(meta))) {
            headers.set(k, v);
          }
          return new Response(null, { status: shellResponse.status, headers });
        }

        const html = await shellResponse.text();
        const rewritten = await injectHead(html, pathname, env);
        const headers = new Headers(shellResponse.headers);
        headers.set("Content-Type", "text/html; charset=utf-8");
        headers.set("Cache-Control", CACHE_CONTROL.htmlShell);
        headers.set("X-Moedict-Shell-Source", "site-assets");
        for (const [k, v] of Object.entries(getVersionHeaders(meta))) {
          headers.set(k, v);
        }
        return new Response(rewritten, { status: shellResponse.status, headers });
      }

      siteAssetsResult = "non-ok";
      siteAssetsStatus = shellResponse.status;
    } catch {
      siteAssetsResult = "throw";
      siteAssetsStatus = null;
    }
  }

  // ── R2 fallback (only if tag present) ───────────────────────────────
  if (tag) {
    const key = releaseKey(tag, "index.html");
    let r2Result: "hit" | "miss" | "throw" = "miss";
    let r2Object: R2ObjectBodyLike | null = null;

    try {
      r2Object = await env.ASSETS.get(key);
      r2Result = r2Object ? "hit" : "miss";
    } catch {
      r2Result = "throw";
    }

    if (r2Object) {
      // Build metadata headers first — needed for both 304 and 200 paths.
      const headers = new Headers();
      r2Object.writeHttpMetadata(headers);
      headers.set("Content-Type", "text/html; charset=utf-8");
      headers.set("Cache-Control", CACHE_CONTROL.htmlShell);
      headers.set("etag", r2Object.httpEtag);
      headers.set("X-Moedict-Shell-Source", "r2-release");
      for (const [k, v] of Object.entries(getVersionHeaders(meta))) {
        headers.set(k, v);
      }

      // ETag / If-None-Match → 304 BEFORE text()/injectHead (avoid unnecessary work)
      if (request.headers.get("If-None-Match") === r2Object.httpEtag) {
        console.log(
          JSON.stringify({
            event: "shell-miss",
            pathname,
            cfRay: request.headers.get("cf-ray") || null,
            versionId: getVersionId(meta),
            releaseTag: tag,
            siteAssetsResult,
            siteAssetsStatus,
            r2Attempted: true,
            r2Key: key,
            r2Result,
            finalSource: "r2-release",
            finalStatus: 304,
          }),
        );
        return new Response(null, { status: 304, headers });
      }

      // Only now read the body and inject head metadata.
      const html = await r2Object.text();
      const rewritten = await injectHead(html, pathname, env);

      console.log(
        JSON.stringify({
          event: "shell-miss",
          pathname,
          cfRay: request.headers.get("cf-ray") || null,
          versionId: getVersionId(meta),
          releaseTag: tag,
          siteAssetsResult,
          siteAssetsStatus,
          r2Attempted: true,
          r2Key: key,
          r2Result,
          finalSource: "r2-release",
          finalStatus: 200,
        }),
      );

      if (request.method === "HEAD") {
        return new Response(null, { status: 200, headers });
      }
      return new Response(rewritten, { status: 200, headers });
    }

    // R2 miss/throw — log and fall through to 503
    console.log(
      JSON.stringify({
        event: "shell-miss",
        pathname,
        cfRay: request.headers.get("cf-ray") || null,
        versionId: getVersionId(meta),
        releaseTag: tag,
        siteAssetsResult,
        siteAssetsStatus,
        r2Attempted: true,
        r2Key: key,
        r2Result,
        finalSource: "recovery",
        finalStatus: 503,
      }),
    );
  } else {
    // Tag absent — skip R2, log and go to 503
    console.log(
      JSON.stringify({
        event: "shell-miss",
        pathname,
        cfRay: request.headers.get("cf-ray") || null,
        versionId: getVersionId(meta),
        releaseTag: null,
        siteAssetsResult,
        siteAssetsStatus,
        r2Attempted: false,
        r2Key: null,
        r2Result: "skipped",
        finalSource: "recovery",
        finalStatus: 503,
      }),
    );
  }

  // ── 503 recovery ─────────────────────────────────────────────────────
  return createRecoveryResponse(request, meta);
}

/**
 * Serve an asset with R2 fallback.
 *
 * Flow:
 * 1. SITE_ASSETS.fetch(request) [fast path — unchanged]
 *    → if OK: return with source=site-assets
 *    → if non-OK or null: fall through to R2
 * 2. R2 current release: env.ASSETS.get("releases/<tag>/<relative-path>")
 *    → if found: return with proper headers, source=r2-release
 * 3. R2 global immutable: env.ASSETS.get("immutable/assets/<relative-path>")
 *    → for /assets/* hashed paths only
 *    → if found: return with immutable cache headers, source=r2-immutable
 * 4. Returns null when all sources miss (for legacy proxy fallback)
 *
 * The caller (worker/index.ts) handles the legacy ASSET_BASE_URL proxy
 * and other legacy compatibility paths when this returns null.
 *
 * R2 bodies are streamed directly — no `await object.text()`.
 */
export async function serveAssetWithFallback(
  request: Request,
  env: FallbackEnv,
): Promise<Response | null> {
  const meta = env.CF_VERSION_METADATA;
  const tag = getReleaseTag(meta);
  const url = new URL(request.url);
  const pathname = url.pathname;

  // ── Fast path: SITE_ASSETS ──────────────────────────────────────────
  const fetcher = env.SITE_ASSETS;
  if (fetcher && typeof fetcher.fetch === "function") {
    try {
      const response = await fetcher.fetch(request);
      // response.ok is false for 304 (Not Modified) -- but a 304 means
      // SITE_ASSETS successfully validated the browser's cached copy via
      // If-None-Match/If-Modified-Since, which is a hit, not a miss.
      // Treating it as non-ok sent every conditional-GET revalidation for
      // hashed bundle assets down the entire R2/legacy fallback chain to
      // the dead ASSET_BASE_URL proxy host on every repeat navigation.
      if (response.ok || response.status === 304) {
        const headers = new Headers(response.headers);
        headers.set("X-Moedict-Asset-Source", "site-assets");
        for (const [k, v] of Object.entries(getVersionHeaders(meta))) {
          headers.set(k, v);
        }
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
    } catch {
      // Fall through to R2
    }
  }

  // ── R2 fallback ──────────────────────────────────────────────────────

  // 1. Current release key (if tag present)
  if (tag) {
    try {
      const key = releaseKey(tag, pathname);
      const object = await env.ASSETS.get(key);
      if (object) {
        return serveR2Object(object, request, {
          cacheControl: CACHE_CONTROL.htmlShell,
          source: "r2-release",
          meta,
        });
      }
    } catch {
      // Fall through to immutable
    }
  }

  // 2. Global immutable key (for /assets/* hashed paths only)
  if (isImmutableAsset(pathname)) {
    try {
      const key = immutableKey(pathname);
      const object = await env.ASSETS.get(key);
      if (object) {
        return serveR2Object(object, request, {
          cacheControl: CACHE_CONTROL.immutableAsset,
          source: "r2-immutable",
          meta,
        });
      }
    } catch {
      // Fall through to legacy
    }
  }
  // 3. Legacy R2 bucket direct lookup (preserves pre-fallback behavior):
  //    the ASSETS bucket may contain files under their stripped /assets/
  //    path (e.g. "js/jquery.strokeWords.js"). This is the original
  //    getAssetFromBucket path for non-hashed /assets/* files.
  if (pathname.startsWith("/assets/") && (request.method === "GET" || request.method === "HEAD")) {
    const legacyKey = pathname.replace(/^\/assets\//, "");
    if (legacyKey) {
      try {
        const object = await env.ASSETS.get(legacyKey);
        if (object) {
          return serveR2Object(object, request, {
            cacheControl: CACHE_CONTROL.staticDay,
            source: "r2-legacy",
            meta,
          });
        }
      } catch {
        // Fall through to null
      }
    }
  }

  // 4. All R2 sources missed — return null for legacy proxy fallback
  return null;
}
