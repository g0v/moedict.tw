/**
 * Direct-call unit tests for the R2 release fallback module
 * (src/api/release-fallback.ts).
 *
 * Tests version metadata helpers, shell fallback, asset fallback, 503
 * recovery, and structured shell-miss logging — all via pure/direct
 * calls without Miniflare (which cannot synthesize the version_metadata
 * binding).
 */

import { describe, expect, it, vi } from "vite-plus/test";
import {
  createRecoveryResponse,
  getVersionHeaders,
  getVersionId,
  getReleaseTag,
  renderHtmlShellWithFallback,
  serveAssetWithFallback,
  type R2BucketLike,
  type FetcherLike,
} from "../../src/api/release-fallback";
import { immutableKey, releaseKey } from "../../src/utils/release-keys";

// ── Types ──────────────────────────────────────────────────────────────

interface R2Obj {
  body: ReadableStream<Uint8Array>;
  httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
  text(): Promise<string>;
}

function r2Obj(body: string, contentType = "text/html"): R2Obj {
  return {
    body: new Response(body).body!,
    httpEtag: '"etag-abc"',
    writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", contentType),
    text: async () => body,
  };
}

function makeBucket(
  entries: Record<string, { body: string; contentType?: string }> = {},
): R2BucketLike {
  return {
    async get(key: string) {
      const e = entries[key];
      return e ? r2Obj(e.body, e.contentType) : null;
    },
  } as unknown as R2BucketLike;
}

function makeFetcher(response: Response | (() => Response)): FetcherLike {
  const fn = typeof response === "function" ? response : () => response;
  return { fetch: vi.fn(async () => fn()) } as unknown as FetcherLike;
}

function req(pathname: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${pathname}`, init);
}

const SHELL_HTML = `<!doctype html><html><head>
  <title>old</title>
  <meta name="description" content="old" />
  <meta property="og:title" content="old" />
  <meta property="og:description" content="old" />
  <meta property="og:url" content="old" />
  <meta property="og:image" content="old" />
  <meta property="og:image:type" content="old" />
  <meta property="og:image:width" content="old" />
  <meta property="og:image:height" content="old" />
  <meta name="twitter:title" content="old" />
  <meta name="twitter:description" content="old" />
  <meta name="twitter:image" content="old" />
  <meta name="twitter:site" content="old" />
  <meta name="twitter:creator" content="old" />
</head><body></body></html>`;

// ── Version metadata helpers ────────────────────────────────────────────

describe("getVersionId", () => {
  it("returns the Cloudflare version UUID when metadata is present", () => {
    const meta = { id: "abc-123-uuid", tag: "release-tag", timestamp: "2026-07-12T00:00:00Z" };
    expect(getVersionId(meta)).toBe("abc-123-uuid");
  });

  it("returns 'unknown' when metadata is undefined", () => {
    expect(getVersionId(undefined)).toBe("unknown");
  });

  it("returns 'unknown' when id is empty", () => {
    const meta = { id: "", tag: "release-tag", timestamp: "2026-07-12T00:00:00Z" };
    expect(getVersionId(meta)).toBe("unknown");
  });
});

describe("getReleaseTag", () => {
  it("returns the tag when metadata is present", () => {
    const meta = { id: "abc-123", tag: "release-tag", timestamp: "2026-07-12T00:00:00Z" };
    expect(getReleaseTag(meta)).toBe("release-tag");
  });

  it("returns null when metadata is undefined", () => {
    expect(getReleaseTag(undefined)).toBe(null);
  });

  it("returns null when tag is empty string", () => {
    const meta = { id: "abc-123", tag: "", timestamp: "2026-07-12T00:00:00Z" };
    expect(getReleaseTag(meta)).toBe(null);
  });
});

describe("getVersionHeaders", () => {
  it("sets X-Moedict-Version to id and X-Moedict-Release to tag", () => {
    const meta = { id: "uuid-123", tag: "rel-abc", timestamp: "2026-07-12T00:00:00Z" };
    const headers = getVersionHeaders(meta);
    expect(headers["X-Moedict-Version"]).toBe("uuid-123");
    expect(headers["X-Moedict-Release"]).toBe("rel-abc");
  });

  it("sets X-Moedict-Version to 'unknown' and omits X-Moedict-Release when metadata is undefined", () => {
    const headers = getVersionHeaders(undefined);
    expect(headers["X-Moedict-Version"]).toBe("unknown");
    expect(headers).not.toHaveProperty("X-Moedict-Release");
  });

  it("omits X-Moedict-Release when tag is empty", () => {
    const meta = { id: "uuid-123", tag: "", timestamp: "2026-07-12T00:00:00Z" };
    const headers = getVersionHeaders(meta);
    expect(headers["X-Moedict-Version"]).toBe("uuid-123");
    expect(headers).not.toHaveProperty("X-Moedict-Release");
  });
});

// ── 503 Recovery ────────────────────────────────────────────────────────

describe("createRecoveryResponse", () => {
  it("returns a 503 with no-store, Retry-After, and refresh meta", async () => {
    const meta = { id: "uuid-123", tag: "rel-abc", timestamp: "2026-07-12T00:00:00Z" };
    const res = createRecoveryResponse(req("/"), meta);
    expect(res!.status).toBe(503);
    expect(res!.headers.get("Cache-Control")).toBe("no-store");
    expect(res!.headers.get("Retry-After")).toBe("5");
    expect(res!.headers.get("X-Moedict-Shell-Source")).toBe("recovery");
    expect(res!.headers.get("X-Moedict-Version")).toBe("uuid-123");
    expect(res!.headers.get("X-Moedict-Release")).toBe("rel-abc");
    // Body should contain auto-refresh meta tag
    const text = await res.text();
    expect(text).toContain('<meta http-equiv="refresh" content="5">');
  });

  it("omits X-Moedict-Release when tag is absent", () => {
    const res = createRecoveryResponse(req("/"), undefined);
    expect(res!.status).toBe(503);
    expect(res!.headers.get("X-Moedict-Version")).toBe("unknown");
    expect(res!.headers.get("X-Moedict-Release")).toBe(null);
  });

  it("body is self-contained HTML with user-friendly message", async () => {
    const res = createRecoveryResponse(req("/"), undefined);
    const body = await res.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain('<meta http-equiv="refresh" content="5">');
    // Should have some user-visible text (not just empty page)
    expect(body.replace(/<[^>]*>/g, "").trim().length).toBeGreaterThan(0);
  });
});

// ── Shell fallback ──────────────────────────────────────────────────────

describe("renderHtmlShellWithFallback", () => {
  it("serves from SITE_ASSETS on fast-path success (source=site-assets)", async () => {
    const fetcher = makeFetcher(
      new Response(SHELL_HTML, { headers: { "Content-Type": "text/html" } }),
    );
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket(),
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    const res = await renderHtmlShellWithFallback(
      req("/about"),
      env as never,
      "/about",
      async (h) => h,
    );
    expect(res!.status).toBe(200);
    expect(res!.headers.get("X-Moedict-Shell-Source")).toBe("site-assets");
    expect(res!.headers.get("X-Moedict-Version")).toBe("uuid-1");
    expect(res!.headers.get("X-Moedict-Release")).toBe("rel-1");
    const body = await res.text();
    expect(body).toContain("<title>");
  });

  it("falls back to R2 when SITE_ASSETS returns non-OK (source=r2-release)", async () => {
    const shellKey = releaseKey("rel-1", "index.html");
    const fetcher = makeFetcher(new Response("error", { status: 500 }));
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket({ [shellKey]: { body: SHELL_HTML } }),
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    const res = await renderHtmlShellWithFallback(
      req("/about"),
      env as never,
      "/about",
      async (h) => h,
    );
    expect(res!.status).toBe(200);
    expect(res!.headers.get("X-Moedict-Shell-Source")).toBe("r2-release");
    expect(res!.headers.get("X-Moedict-Version")).toBe("uuid-1");
    expect(res!.headers.get("X-Moedict-Release")).toBe("rel-1");
  });

  it("returns 503 recovery when SITE_ASSETS throws and tag is absent", async () => {
    const fetcher = makeFetcher(() => {
      throw new Error("fetch failed");
    });
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket(),
      CF_VERSION_METADATA: undefined,
    };
    const res = await renderHtmlShellWithFallback(
      req("/about"),
      env as never,
      "/about",
      async (h) => h,
    );
    expect(res!.status).toBe(503);
    expect(res!.headers.get("X-Moedict-Shell-Source")).toBe("recovery");
    expect(res!.headers.get("X-Moedict-Version")).toBe("unknown");
    expect(res!.headers.get("X-Moedict-Release")).toBe(null);
  });

  it("returns 503 recovery when SITE_ASSETS non-OK, tag present, but R2 miss", async () => {
    const fetcher = makeFetcher(new Response("error", { status: 500 }));
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket(), // empty bucket
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    const res = await renderHtmlShellWithFallback(
      req("/about"),
      env as never,
      "/about",
      async (h) => h,
    );
    expect(res!.status).toBe(503);
    expect(res!.headers.get("X-Moedict-Shell-Source")).toBe("recovery");
  });

  it("returns 503 recovery when SITE_ASSETS non-OK and tag is empty string", async () => {
    const fetcher = makeFetcher(new Response("error", { status: 500 }));
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket({ "releases//index.html": { body: "bad" } }),
      CF_VERSION_METADATA: { id: "uuid-1", tag: "", timestamp: "2026-07-12T00:00:00Z" } as never,
    };
    const res = await renderHtmlShellWithFallback(
      req("/about"),
      env as never,
      "/about",
      async (h) => h,
    );
    expect(res!.status).toBe(503);
    expect(res!.headers.get("X-Moedict-Shell-Source")).toBe("recovery");
  });

  it("returns 503 when SITE_ASSETS is undefined (no fetcher)", async () => {
    const env = {
      SITE_ASSETS: undefined,
      ASSETS: makeBucket(),
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    const res = await renderHtmlShellWithFallback(
      req("/about"),
      env as never,
      "/about",
      async (h) => h,
    );
    // No SITE_ASSETS → R2 fallback with tag → R2 miss → 503
    expect(res!.status).toBe(503);
    expect(res!.headers.get("X-Moedict-Shell-Source")).toBe("recovery");
  });

  it("HEAD request returns empty body with same headers from R2", async () => {
    const shellKey = releaseKey("rel-1", "index.html");
    const fetcher = makeFetcher(new Response("error", { status: 500 }));
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket({ [shellKey]: { body: SHELL_HTML } }),
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    const res = await renderHtmlShellWithFallback(
      req("/about", { method: "HEAD" }),
      env as never,
      "/about",
      async (h) => h,
    );
    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe("");
    expect(res!.headers.get("X-Moedict-Shell-Source")).toBe("r2-release");
  });

  it("returns 304 from R2 when If-None-Match matches the shell ETag", async () => {
    const shellKey = releaseKey("rel-1", "index.html");
    const fetcher = makeFetcher(new Response("error", { status: 500 }));
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket({ [shellKey]: { body: SHELL_HTML } }),
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    // First request to get the ETag
    const res1 = await renderHtmlShellWithFallback(
      req("/about"),
      env as never,
      "/about",
      async (h) => h,
    );
    const etag = res1.headers.get("etag");
    expect(etag).toBeTruthy();
    // Second request with If-None-Match → 304
    const res2 = await renderHtmlShellWithFallback(
      req("/about", { headers: { "If-None-Match": etag! } }),
      env as never,
      "/about",
      async (h) => h,
    );
    expect(res2.status).toBe(304);
    expect(res2.headers.get("X-Moedict-Shell-Source")).toBe("r2-release");
    expect(await res2.text()).toBe("");
  });

  it("HEAD on SITE_ASSETS fast path returns empty body", async () => {
    const fetcher = makeFetcher(
      new Response(SHELL_HTML, { headers: { "Content-Type": "text/html" } }),
    );
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket(),
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    const res = await renderHtmlShellWithFallback(
      req("/about", { method: "HEAD" }),
      env as never,
      "/about",
      async (h) => h,
    );
    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe("");
    expect(res!.headers.get("X-Moedict-Shell-Source")).toBe("site-assets");
  });
});

// ── Asset fallback ──────────────────────────────────────────────────────

describe("serveAssetWithFallback", () => {
  it("serves from SITE_ASSETS on fast-path success (source=site-assets)", async () => {
    const fetcher = makeFetcher(
      new Response("JS bytes", {
        status: 200,
        headers: { "Content-Type": "application/javascript" },
      }),
    );
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket(),
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    const res = await serveAssetWithFallback(req("/assets/index-BU7Lztf4.js"), env as never);
    expect(res!.status).toBe(200);
    expect(res!.headers.get("X-Moedict-Asset-Source")).toBe("site-assets");
  });

  it("falls back to R2 current release (source=r2-release)", async () => {
    const key = releaseKey("rel-1", "assets/index-BU7Lztf4.js");
    const fetcher = makeFetcher(new Response("", { status: 404 }));
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket({ [key]: { body: "JS bytes", contentType: "application/javascript" } }),
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    const res = await serveAssetWithFallback(req("/assets/index-BU7Lztf4.js"), env as never);
    expect(res!.status).toBe(200);
    expect(res!.headers.get("X-Moedict-Asset-Source")).toBe("r2-release");
    expect(await res!.text()).toBe("JS bytes");
  });

  it("falls back to R2 global immutable (source=r2-immutable) with immutable cache headers", async () => {
    const imKey = immutableKey("/assets/index-BU7Lztf4.js");
    const fetcher = makeFetcher(new Response("", { status: 404 }));
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket({ [imKey]: { body: "JS bytes", contentType: "application/javascript" } }),
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    const res = await serveAssetWithFallback(req("/assets/index-BU7Lztf4.js"), env as never);
    expect(res!.status).toBe(200);
    expect(res!.headers.get("X-Moedict-Asset-Source")).toBe("r2-immutable");
    expect(res!.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("returns null when all sources miss (for legacy proxy fallback)", async () => {
    const fetcher = makeFetcher(new Response("", { status: 404 }));
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket(),
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    const res = await serveAssetWithFallback(req("/assets/missing.js"), env as never);
    expect(res).toBe(null);
  });

  it("returns null when tag is absent and SITE_ASSETS misses (skip R2)", async () => {
    const fetcher = makeFetcher(new Response("", { status: 404 }));
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket({ "releases/unknown/assets/foo.js": { body: "bad" } }),
      CF_VERSION_METADATA: undefined,
    };
    const res = await serveAssetWithFallback(req("/assets/foo.js"), env as never);
    expect(res).toBe(null);
  });

  it("returns null when immutable path misses R2 and legacy bucket (hashed asset, all miss)", async () => {
    const fetcher = makeFetcher(new Response("", { status: 404 }));
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket(),
      CF_VERSION_METADATA: undefined,
    };
    const res = await serveAssetWithFallback(req("/assets/index-NotFound0.js"), env as never);
    expect(res).toBe(null);
  });

  it("returns null when hashed asset misses release R2, immutable R2, and legacy (tag present)", async () => {
    const fetcher = makeFetcher(new Response("", { status: 404 }));
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket(),
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    // Hashed path: isImmutableAsset → true, enters immutable block.
    // Release key miss, immutable key miss, legacy key miss → null.
    const res = await serveAssetWithFallback(req("/assets/index-MissHash0.js"), env as never);
    expect(res).toBe(null);
  });

  it("preserves ETag and supports If-None-Match → 304", async () => {
    const key = releaseKey("rel-1", "assets/index-BU7Lztf4.js");
    const fetcher = makeFetcher(new Response("", { status: 404 }));
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket({ [key]: { body: "JS bytes", contentType: "application/javascript" } }),
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    // First request to get the etag
    const res1 = await serveAssetWithFallback(req("/assets/index-BU7Lztf4.js"), env as never);
    const etag = res1!.headers.get("etag");
    expect(etag).toBeTruthy();
    // Second request with If-None-Match
    const res2 = await serveAssetWithFallback(
      req("/assets/index-BU7Lztf4.js", { headers: { "If-None-Match": etag! } }),
      env as never,
    );
    expect(res2!.status).toBe(304);
    expect(await res2!.text()).toBe("");
  });

  it("HEAD request returns empty body with headers", async () => {
    const key = releaseKey("rel-1", "assets/index-BU7Lztf4.js");
    const fetcher = makeFetcher(new Response("", { status: 404 }));
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket({ [key]: { body: "JS bytes", contentType: "application/javascript" } }),
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    const res = await serveAssetWithFallback(
      req("/assets/index-BU7Lztf4.js", { method: "HEAD" }),
      env as never,
    );
    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe("");
    expect(res!.headers.get("X-Moedict-Asset-Source")).toBe("r2-release");
  });

  it("streams R2 body (no text() copy)", async () => {
    const key = releaseKey("rel-1", "assets/index-BU7Lztf4.js");
    const fetcher = makeFetcher(new Response("", { status: 404 }));
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket({ [key]: { body: "JS bytes", contentType: "application/javascript" } }),
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    const res = await serveAssetWithFallback(req("/assets/index-BU7Lztf4.js"), env as never);
    // The body should be a ReadableStream (not buffered)
    expect(res!.body).toBeTruthy();
    // Consume to verify it works
    const text = await res!.text();
    expect(text).toBe("JS bytes");
  });

  it("immutable cache header for /assets/* hashed path from immutable store", async () => {
    const imKey = immutableKey("/assets/style-BKH8HGTI.css");
    const fetcher = makeFetcher(new Response("", { status: 404 }));
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket({ [imKey]: { body: "CSS bytes", contentType: "text/css" } }),
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    const res = await serveAssetWithFallback(req("/assets/style-BKH8HGTI.css"), env as never);
    expect(res!.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res!.headers.get("X-Moedict-Asset-Source")).toBe("r2-immutable");
  });

  it("checks current release before global immutable (order)", async () => {
    const relKey = releaseKey("rel-1", "assets/index-BU7Lztf4.js");
    const imKey = immutableKey("/assets/index-BU7Lztf4.js");
    const fetcher = makeFetcher(new Response("", { status: 404 }));
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket({
        [relKey]: { body: "from-release", contentType: "application/javascript" },
        [imKey]: { body: "from-immutable", contentType: "application/javascript" },
      }),
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    const res = await serveAssetWithFallback(req("/assets/index-BU7Lztf4.js"), env as never);
    expect(await res!.text()).toBe("from-release");
    expect(res!.headers.get("X-Moedict-Asset-Source")).toBe("r2-release");
  });

  it("serves from legacy R2 bucket direct lookup (source=r2-legacy)", async () => {
    const fetcher = makeFetcher(new Response("", { status: 404 }));
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket({
        "js/jquery.strokeWords.js": { body: "JS content", contentType: "application/javascript" },
      }),
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    const res = await serveAssetWithFallback(req("/assets/js/jquery.strokeWords.js"), env as never);
    expect(res!.status).toBe(200);
    expect(res!.headers.get("X-Moedict-Asset-Source")).toBe("r2-legacy");
    expect(await res!.text()).toBe("JS content");
  });
});

// ── Structured shell-miss logging ───────────────────────────────────────

describe("structured shell-miss logging", () => {
  it("logs structured event when SITE_ASSETS returns non-OK and R2 hit", async () => {
    const shellKey = releaseKey("rel-1", "index.html");
    const fetcher = makeFetcher(new Response("error", { status: 500 }));
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket({ [shellKey]: { body: SHELL_HTML } }),
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await renderHtmlShellWithFallback(req("/about"), env as never, "/about", async (h) => h);
    // Find the structured log call
    const structuredCall = logSpy.mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.event === "shell-miss";
      } catch {
        return false;
      }
    });
    expect(structuredCall).toBeTruthy();
    const parsed = JSON.parse(structuredCall![0]);
    expect(parsed.event).toBe("shell-miss");
    expect(parsed.pathname).toBe("/about");
    expect(parsed.versionId).toBe("uuid-1");
    expect(parsed.releaseTag).toBe("rel-1");
    expect(parsed.siteAssetsResult).toBe("non-ok");
    expect(parsed.r2Attempted).toBe(true);
    expect(parsed.r2Result).toBe("hit");
    expect(parsed.finalSource).toBe("r2-release");
    expect(parsed.finalStatus).toBe(200);
    logSpy.mockRestore();
  });

  it("logs r2Result=skipped when tag is absent", async () => {
    const fetcher = makeFetcher(new Response("error", { status: 500 }));
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket(),
      CF_VERSION_METADATA: undefined,
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await renderHtmlShellWithFallback(req("/about"), env as never, "/about", async (h) => h);
    const structuredCall = logSpy.mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.event === "shell-miss";
      } catch {
        return false;
      }
    });
    expect(structuredCall).toBeTruthy();
    const parsed = JSON.parse(structuredCall![0]);
    expect(parsed.r2Attempted).toBe(false);
    expect(parsed.r2Result).toBe("skipped");
    expect(parsed.finalSource).toBe("recovery");
    expect(parsed.finalStatus).toBe(503);
    expect(parsed.versionId).toBe("unknown");
    expect(parsed.releaseTag).toBe(null);
    logSpy.mockRestore();
  });

  it("logs siteAssetsResult=throw when SITE_ASSETS throws", async () => {
    const fetcher = makeFetcher(() => {
      throw new Error("network error");
    });
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket(),
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await renderHtmlShellWithFallback(req("/about"), env as never, "/about", async (h) => h);
    const structuredCall = logSpy.mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.event === "shell-miss";
      } catch {
        return false;
      }
    });
    expect(structuredCall).toBeTruthy();
    const parsed = JSON.parse(structuredCall![0]);
    expect(parsed.siteAssetsResult).toBe("throw");
    expect(parsed.r2Result).toBe("miss");
    expect(parsed.finalSource).toBe("recovery");
    logSpy.mockRestore();
  });

  it("structured log contains no secrets", async () => {
    const fetcher = makeFetcher(new Response("error", { status: 500 }));
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: makeBucket(),
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await renderHtmlShellWithFallback(req("/about"), env as never, "/about", async (h) => h);
    const structuredCall = logSpy.mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.event === "shell-miss";
      } catch {
        return false;
      }
    });
    expect(structuredCall).toBeTruthy();
    const logString = structuredCall![0] as string;
    // No secret-like values (tokens, API keys, passwords)
    expect(logString).not.toMatch(/token|password|secret|api[_-]?key/i);
    logSpy.mockRestore();
  });

  it("logs r2Result=throw when R2 bucket throws", async () => {
    const fetcher = makeFetcher(new Response("error", { status: 500 }));
    const throwingBucket = {
      async get() {
        throw new Error("R2 unavailable");
      },
    } as unknown as R2BucketLike;
    const env = {
      SITE_ASSETS: fetcher,
      ASSETS: throwingBucket,
      CF_VERSION_METADATA: {
        id: "uuid-1",
        tag: "rel-1",
        timestamp: "2026-07-12T00:00:00Z",
      } as never,
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await renderHtmlShellWithFallback(req("/about"), env as never, "/about", async (h) => h);
    const structuredCall = logSpy.mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.event === "shell-miss";
      } catch {
        return false;
      }
    });
    expect(structuredCall).toBeTruthy();
    const parsed = JSON.parse(structuredCall![0]);
    expect(parsed.r2Result).toBe("throw");
    expect(parsed.finalSource).toBe("recovery");
    logSpy.mockRestore();
  });
});
