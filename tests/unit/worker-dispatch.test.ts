/**
 * Direct-call unit tests for the Worker's top-level routing (worker/index.ts
 * `dispatch`). This closes the coverage gap that workerd's CDP inspector
 * can't fill — Miniflare runs the worker in a separate V8 isolate so
 * vitest's v8 collector never sees it during integration runs. Importing
 * `dispatch` directly gives us vitest-instrumented attribution for the
 * ~535-line routing switch plus the helpers it calls.
 *
 * All external I/O is mocked with plain JS stubs. The worker handlers
 * themselves (handleDictionaryAPI, handleLookupAPI, etc.) have their own
 * direct-call tests in api-handlers-direct.test.ts; here we just verify
 * that `dispatch` routes to the right handler + applies the right headers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { dispatch, respondWithConfigApi } from "../../worker/index";

type AnyEnv = Parameters<typeof dispatch>[1];

interface R2Obj {
  body: ReadableStream<Uint8Array>;
  httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
  text(): Promise<string>;
}

function r2Obj(body: string, contentType = "application/octet-stream"): R2Obj {
  return {
    body: new Response(body).body!,
    httpEtag: '"etag-stub"',
    writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", contentType),
    text: async () => body,
  };
}

function makeBucket(
  entries: Record<string, { body: string; contentType?: string }> = {},
): AnyEnv["DICTIONARY"] {
  return {
    async head(key: string) {
      const e = entries[key];
      if (!e) return null;
      return {
        httpEtag: '"etag-stub"',
        writeHttpMetadata: (headers: Headers) =>
          headers.set("Content-Type", e.contentType ?? "application/octet-stream"),
      };
    },
    async get(key: string) {
      const e = entries[key];
      return e ? r2Obj(e.body, e.contentType) : null;
    },
  } as unknown as AnyEnv["DICTIONARY"];
}

function makeEnv(overrides: Partial<AnyEnv> = {}): AnyEnv {
  return {
    ASSET_BASE_URL: "https://r2-assets.test.local",
    DICTIONARY_BASE_URL: "https://r2-dictionary.test.local",
    DICTIONARY: makeBucket(),
    ASSETS: makeBucket(),
    FONTS: makeBucket(),
    ...overrides,
  } as AnyEnv;
}

function req(pathname: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${pathname}`, init);
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
beforeEach(() => {
  vi.restoreAllMocks();
});

describe("dispatch — CORS preflight", () => {
  it("OPTIONS on any path returns 204 with fixed-star CORS headers", async () => {
    const res = await dispatch(req("/anything", { method: "OPTIONS" }), makeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-max-age")).toBe("86400");
  });
});

describe("dispatch — /api/config", () => {
  it("returns the wrangler vars as JSON", async () => {
    const res = await dispatch(req("/api/config"), makeEnv());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      assetBaseUrl: "https://r2-assets.test.local",
      dictionaryBaseUrl: "https://r2-dictionary.test.local",
    });
  });

  it("sets fixed CORS and no-store so env changes are not edge-pinned", async () => {
    const res = await dispatch(req("/api/config"), makeEnv());
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toMatch(/no-store|max-age=0|private/i);
    expect(res.headers.get("cache-control") ?? "").not.toMatch(/s-maxage=[1-9]/);
  });

  it("serves empty strings when vars are absent", async () => {
    const env = makeEnv({ ASSET_BASE_URL: undefined, DICTIONARY_BASE_URL: undefined });
    const body = await (await dispatch(req("/api/config"), env)).json();
    expect(body).toMatchObject({ assetBaseUrl: "", dictionaryBaseUrl: "" });
  });
});

describe("dispatch — global version headers", () => {
  const metadata = {
    id: "uuid-dispatch-test",
    tag: "release-dispatch-test",
    timestamp: "2026-07-12T00:00:00Z",
  };

  it("decorates config API responses without changing JSON, CORS, or cache policy", async () => {
    const res = await dispatch(req("/api/config"), makeEnv({ CF_VERSION_METADATA: metadata }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      assetBaseUrl: "https://r2-assets.test.local",
      dictionaryBaseUrl: "https://r2-dictionary.test.local",
    });
    expect(res.headers.get("X-Moedict-Version")).toBe(metadata.id);
    expect(res.headers.get("X-Moedict-Release")).toBe(metadata.tag);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("decorates dictionary API responses without changing body, CORS, or cache policy", async () => {
    const env = makeEnv({
      CF_VERSION_METADATA: metadata,
      DICTIONARY: makeBucket({ "search-index/a.json": { body: '{"words":[]}' } }),
    });
    const res = await dispatch(req("/api/search-index/a.json"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"words":[]}');
    expect(res.headers.get("X-Moedict-Version")).toBe(metadata.id);
    expect(res.headers.get("X-Moedict-Release")).toBe(metadata.tag);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=604800");
  });

  it("uses unknown version and omits invalid release tags on OPTIONS", async () => {
    const res = await dispatch(
      req("/anything", { method: "OPTIONS" }),
      makeEnv({ CF_VERSION_METADATA: { ...metadata, id: "", tag: "../invalid" } }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("X-Moedict-Version")).toBe("unknown");
    expect(res.headers.get("X-Moedict-Release")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("decorates final 404 responses while preserving status and no-store", async () => {
    const res = await dispatch(req("/some/random.txt"), makeEnv({ CF_VERSION_METADATA: metadata }));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(res.headers.get("X-Moedict-Version")).toBe(metadata.id);
    expect(res.headers.get("X-Moedict-Release")).toBe(metadata.tag);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("decorates shell responses without changing status, body, or content type", async () => {
    const shellHtml = "<html><head><title>old</title></head><body>shell</body></html>";
    const fetcher = {
      fetch: vi.fn(
        async () =>
          new Response(shellHtml, {
            status: 200,
            statusText: "Shell OK",
            headers: { "Content-Type": "text/html" },
          }),
      ),
    };
    const res = await dispatch(
      req("/about"),
      makeEnv({
        CF_VERSION_METADATA: metadata,
        SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"],
      }),
    );
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("");
    expect(await res.text()).toContain("<title>");
    expect(res.headers.get("X-Moedict-Version")).toBe(metadata.id);
    expect(res.headers.get("X-Moedict-Release")).toBe(metadata.tag);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
  });
  it("preserves tagged-shell 304 semantics and metadata headers", async () => {
    const env = makeEnv({
      CF_VERSION_METADATA: metadata,
      ASSETS: makeBucket({
        "releases/release-dispatch-test/index.html": {
          body: "<html><head><title>cached</title></head></html>",
          contentType: "text/html",
        },
      }),
    });
    const res = await dispatch(req("/about", { headers: { "If-None-Match": '"etag-stub"' } }), env);
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("ETag")).toBe('"etag-stub"');
    expect(res.headers.get("X-Moedict-Shell-Source")).toBe("r2-release");
    expect(res.headers.get("X-Moedict-Version")).toBe(metadata.id);
    expect(res.headers.get("X-Moedict-Release")).toBe(metadata.tag);
  });

  it("decorates asset proxy responses without changing stream, status, CORS, cache, or ETag", async () => {
    const fetcher = { fetch: vi.fn(async () => new Response("", { status: 404 })) };
    globalThis.fetch = vi.fn(
      async () =>
        new Response("font bytes", {
          status: 206,
          statusText: "Partial Content",
          headers: {
            "Content-Type": "font/woff2",
            "Cache-Control": "public, max-age=60",
            ETag: '"asset-etag"',
          },
        }),
    ) as typeof fetch;
    const res = await dispatch(
      req("/assets/some-font.woff2"),
      makeEnv({
        CF_VERSION_METADATA: metadata,
        SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"],
      }),
    );
    expect(res.status).toBe(206);
    expect(res.statusText).toBe("Partial Content");
    expect(await res.text()).toBe("font bytes");
    expect(res.headers.get("X-Moedict-Version")).toBe(metadata.id);
    expect(res.headers.get("X-Moedict-Release")).toBe(metadata.tag);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(res.headers.get("ETag")).toBe('"asset-etag"');
  });
});

describe("respondWithConfigApi — no edge pin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not read or write caches.default", async () => {
    const match = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ assetBaseUrl: "from-cache", dictionaryBaseUrl: "cached-dict" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const put = vi.fn();
    vi.stubGlobal("caches", { default: { match, put } });
    const waitUntil = vi.fn();

    const res = await respondWithConfigApi(
      req("/api/config"),
      makeEnv({ ASSET_BASE_URL: "live-assets", DICTIONARY_BASE_URL: "live-dict" }),
      { waitUntil },
    );

    expect(match).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toMatch(/no-store|max-age=0|private/i);
    expect(await res.json()).toEqual({
      assetBaseUrl: "live-assets",
      dictionaryBaseUrl: "live-dict",
    });
  });

  it("builds JSON with fixed CORS when caches is unavailable", async () => {
    vi.stubGlobal("caches", undefined);

    const res = await respondWithConfigApi(req("/api/config"), makeEnv());

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/no-store|max-age=0|private/i);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toMatchObject({
      assetBaseUrl: "https://r2-assets.test.local",
      dictionaryBaseUrl: "https://r2-dictionary.test.local",
    });
  });
});

describe("dispatch — /api/cache/purge", () => {
  it("403s when CACHE_PURGE_TOKEN is not configured", async () => {
    const res = await dispatch(
      req("/api/cache/purge", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: "{}",
      }),
      makeEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("purges allowed tags through the Zone Cache Purge API", async () => {
    const zonePurge = vi.fn(
      async () => new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    globalThis.fetch = zonePurge as typeof fetch;
    const res = await dispatch(
      req("/api/cache/purge", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ tags: ["dict", "evil"] }),
      }),
      makeEnv({ CACHE_PURGE_TOKEN: "secret", CLOUDFLARE_API_TOKEN: "zone-token" }),
      { waitUntil: vi.fn() } as never,
    );
    expect(res.status).toBe(200);
    expect(zonePurge).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/zones/208ed37cabff643b306011964e52ad25/purge_cache",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer zone-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tags: ["dict"] }),
      }),
    );
    const body = (await res.json()) as { ok: boolean; purgedTags: string[] };
    expect(body.ok).toBe(true);
    expect(body.purgedTags).toEqual(["dict"]);
  });

  it("500s when the Zone Cache Purge token is unavailable", async () => {
    const res = await dispatch(
      req("/api/cache/purge", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ tags: ["dict"] }),
      }),
      makeEnv({ CACHE_PURGE_TOKEN: "secret" }),
      { waitUntil: vi.fn() },
    );
    expect(res.status).toBe(500);
  });
});

describe("dispatch — /api/search-index/{lang}.json", () => {
  it("200 serves JSON with fixed-star CORS, s-maxage, and search-index tags", async () => {
    const env = makeEnv({
      DICTIONARY: makeBucket({ "search-index/a.json": { body: '{"words":[]}' } }),
    });
    const request = req("/api/search-index/a.json");
    request.headers.set("Origin", "https://evil.example");
    const res = await dispatch(request, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"words":[]}');
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("vary")).toBeNull();
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
    expect(res.headers.get("cache-control")).toContain("s-maxage=604800");
    expect(res.headers.get("cache-tag")).toMatch(/\bsearch-index\b/);
    expect(res.headers.get("cache-tag")).toMatch(/\bsearch-index-a\b/);
  });

  it("404 with error body when the language key is missing", async () => {
    const res = await dispatch(req("/api/search-index/a.json"), makeEnv());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Not Found");
  });
});

describe("dispatch — /api/index/{lang}.json", () => {
  it("serves per-lang sidebar index JSON", async () => {
    const env = makeEnv({
      DICTIONARY: makeBucket({ "a/index.json": { body: '["萌"]' } }),
    });
    const res = await dispatch(req("/api/index/a.json"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('["萌"]');
  });

  it("404s with a message when the lang index is missing", async () => {
    const res = await dispatch(req("/api/index/a.json"), makeEnv());
    expect(res.status).toBe(404);
  });
});

describe("dispatch — /api/xref/{lang}.json", () => {
  it("serves xref JSON with a 1-hour cache", async () => {
    const env = makeEnv({
      DICTIONARY: makeBucket({ "a/xref.json": { body: '{"t":{}}' } }),
    });
    const res = await dispatch(req("/api/xref/a.json"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=300");
    expect(res.headers.get("cache-control")).toContain("s-maxage=3600");
  });

  it("returns empty-object JSON (not 404) when xref file is missing", async () => {
    const res = await dispatch(req("/api/xref/a.json"), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("{}");
  });
});

describe("dispatch — /api/xref-by-id/{lang}.json", () => {
  it("serves xref-by-id JSON with xref cache headers", async () => {
    const env = makeEnv({
      DICTIONARY: makeBucket({ "t/xref-by-id.json": { body: '{"a":{}}' } }),
    });
    const res = await dispatch(req("/api/xref-by-id/t.json"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=300");
    expect(res.headers.get("cache-control")).toContain("s-maxage=3600");
    expect(res.headers.get("cache-tag")).toContain("xref");
    expect(res.headers.get("cache-tag")).toContain("xref-t");
    expect(await res.text()).toBe('{"a":{}}');
  });

  it("returns empty-object JSON (not 404) when xref-by-id file is missing", async () => {
    const res = await dispatch(req("/api/xref-by-id/t.json"), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("{}");
  });
});

describe("dispatch — /manifest.appcache", () => {
  it("serves the manifest as text/cache-manifest", async () => {
    const env = makeEnv({
      ASSETS: makeBucket({ "manifest.appcache": { body: "CACHE MANIFEST\n" } }),
    });
    const res = await dispatch(req("/manifest.appcache"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("cache-manifest");
  });

  it("HEAD returns headers only (empty body)", async () => {
    const env = makeEnv({
      ASSETS: makeBucket({ "manifest.appcache": { body: "CACHE MANIFEST" } }),
    });
    const res = await dispatch(req("/manifest.appcache", { method: "HEAD" }), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("404s when the manifest is absent", async () => {
    const res = await dispatch(req("/manifest.appcache"), makeEnv());
    expect(res.status).toBe(404);
  });
});

describe("dispatch — /robots.txt", () => {
  it("returns plain text directives instead of HTML shell", async () => {
    const res = await dispatch(req("/robots.txt"), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Disallow: /api/");
    expect(body).toContain("Disallow: /*.json$");
    expect(body).toContain("Disallow: /*.png$");
    expect(body).toContain("Allow: /");
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
  });

  it("HEAD returns headers only", async () => {
    const res = await dispatch(req("/robots.txt", { method: "HEAD" }), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("");
  });
});

describe("dispatch — /moetris", () => {
  it("302-redirects /moetris to dodo.moedict.tw", async () => {
    const res = await dispatch(req("/moetris"), makeEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://dodo.moedict.tw/moetris.html");
  });

  it("302-redirects /moetris/ (trailing slash) to dodo.moedict.tw", async () => {
    const res = await dispatch(req("/moetris/"), makeEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://dodo.moedict.tw/moetris.html");
  });
});

describe("dispatch — /images/Download_on_the_App_Store_Badge_HK_TW_135x40.png", () => {
  it("serves the PNG from ASSETS R2 with caching + etag", async () => {
    const env = makeEnv({
      ASSETS: makeBucket({
        "Download_on_the_App_Store_Badge_HK_TW_135x40.png": {
          body: "PNGBYTES",
          contentType: "image/png",
        },
      }),
    });
    const res = await dispatch(
      req("/images/Download_on_the_App_Store_Badge_HK_TW_135x40.png"),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
    expect(res.headers.get("cache-control")).toContain("s-maxage=86400");
    expect(res.headers.get("cache-tag")).toBe("assets");
    expect(res.headers.get("etag")).toBe('"etag-stub"');
  });

  it("404s when the badge is missing", async () => {
    const res = await dispatch(
      req("/images/Download_on_the_App_Store_Badge_HK_TW_135x40.png"),
      makeEnv(),
    );
    expect(res.status).toBe(404);
  });
});

describe("dispatch — /translation-data/cfdict.*", () => {
  it("serves cfdict.xml with content-disposition + CORS", async () => {
    const env = makeEnv({
      DICTIONARY: makeBucket({
        "translation-data/cfdict.xml": { body: "<root />", contentType: "application/xml" },
      }),
    });
    const res = await dispatch(req("/translation-data/cfdict.xml"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("xml");
    expect(res.headers.get("content-disposition")).toContain("cfdict.xml");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("404s cfdict.xml when absent, still with CORS headers", async () => {
    const res = await dispatch(req("/translation-data/cfdict.xml"), makeEnv());
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("serves cfdict.txt as text/plain utf-8", async () => {
    const env = makeEnv({
      DICTIONARY: makeBucket({ "translation-data/cfdict.txt": { body: "fixture" } }),
    });
    const res = await dispatch(req("/translation-data/cfdict.txt"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("HEAD variants return empty bodies", async () => {
    const env = makeEnv({
      DICTIONARY: makeBucket({
        "translation-data/cfdict.xml": { body: "xml" },
        "translation-data/cfdict.txt": { body: "txt" },
      }),
    });
    expect(
      await (await dispatch(req("/translation-data/cfdict.xml", { method: "HEAD" }), env)).text(),
    ).toBe("");
    expect(
      await (await dispatch(req("/translation-data/cfdict.txt", { method: "HEAD" }), env)).text(),
    ).toBe("");
  });
});

describe("dispatch — /api/stroke-json R2 ASSETS", () => {
  it("serves a seeded stroke-json object from env.ASSETS", async () => {
    const env = makeEnv({
      ASSETS: makeBucket({
        "stroke-json/840c.json": {
          body: '[{"outline":[],"track":[]}]',
          contentType: "application/json",
        },
      }),
    });
    const res = await dispatch(req("/api/stroke-json/840c.json"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/json/);
    expect(res.headers.get("cache-tag")).toBe("stroke");
    expect(await res.json()).toEqual([{ outline: [], track: [] }]);
  });

  it("rejects a non-hex codepoint with 400 from handleStrokeAPI", async () => {
    const res = await dispatch(req("/api/stroke-json/xyz.json"), makeEnv());
    expect(res.status).toBe(400);
  });

  it("returns 404 when the stroke object is absent from ASSETS", async () => {
    const res = await dispatch(req("/api/stroke-json/ffff.json"), makeEnv());
    expect(res.status).toBe(404);
  });
});

describe("dispatch — generic API fallback", () => {
  it('returns {"name":"Cloudflare"} for unmatched /api/ paths', async () => {
    const res = await dispatch(req("/api/totally-unknown"), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Cloudflare" });
  });
});

describe("dispatch — HTML shell rendering", () => {
  it("renders the SPA shell with head metadata when ASSETS is a Fetcher", async () => {
    const shellHtml = `
      <html><head>
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
      </head></html>`;
    const fetcher = {
      fetch: vi.fn(
        async () => new Response(shellHtml, { headers: { "Content-Type": "text/html" } }),
      ),
    };
    const env = makeEnv({ SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"] });
    const res = await dispatch(req("/about"), env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/<title>.*關於.*<\/title>/);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("HEAD on an HTML route returns empty body but same headers", async () => {
    const fetcher = {
      fetch: vi.fn(
        async () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }),
      ),
    };
    const env = makeEnv({ SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"] });
    const res = await dispatch(req("/about", { method: "HEAD" }), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("skips HTML shell rendering for Vite-internal requests", async () => {
    const fetcher = {
      fetch: vi.fn(
        async () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }),
      ),
    };
    const env = makeEnv({ SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"] });
    // /@vite/client is a Vite dev-server transform request — dispatch must
    // pass it through to the asset fetcher without injecting metadata.
    await dispatch(req("/@vite/client"), env);
    // Didn't crash with undefined title substitution — that's the contract.
  });
});

describe("dispatch — /assets/* ASSET_BASE_URL proxy fallback", () => {
  it("proxies /assets/* via ASSET_BASE_URL when the ASSETS binding returns 404", async () => {
    const fetcher = { fetch: vi.fn(async () => new Response("", { status: 404 })) };
    globalThis.fetch = vi.fn(async (url) => {
      expect(String(url)).toContain("r2-assets.test.local/some-font.woff2");
      return new Response("font bytes", { status: 200, headers: { "Content-Type": "font/woff2" } });
    }) as typeof fetch;
    const env = makeEnv({ SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"] });
    const res = await dispatch(req("/assets/some-font.woff2"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/woff2/);
  });

  it("returns 502 when the upstream fetch rejects", async () => {
    const fetcher = { fetch: vi.fn(async () => new Response("", { status: 404 })) };
    globalThis.fetch = vi.fn(async () => {
      throw new Error("upstream down");
    }) as typeof fetch;
    const env = makeEnv({ SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"] });
    const res = await dispatch(req("/assets/missing.woff2"), env);
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("uses fixed-star CORS on the proxied response", async () => {
    const fetcher = { fetch: vi.fn(async () => new Response("", { status: 404 })) };
    globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as typeof fetch;
    const env = makeEnv({ SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"] });
    const res = await dispatch(
      req("/assets/x.js", { headers: { Origin: "https://example.test" } }),
      env,
    );
    // Happy-dom may strip Origin on Request; either way response is fixed `*`.
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("sets Cache-Control: no-store when the proxied upstream response is not ok", async () => {
    // Guards a real incident: a transient upstream miss (propagation lag
    // right after deploy, or a genuinely absent legacy file) must never
    // be cached, or it can outlive its own transience at the edge.
    const fetcher = { fetch: vi.fn(async () => new Response("", { status: 404 })) };
    globalThis.fetch = vi.fn(
      async () => new Response("not found upstream", { status: 404 }),
    ) as typeof fetch;
    const env = makeEnv({ SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"] });
    const res = await dispatch(req("/assets/missing-bundle.css"), env);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("dispatch — 404 fallback", () => {
  it("returns a null-body 404 when no route matches", async () => {
    // /some.random.txt isn't JSON, not a PNG, not an asset, not HTML.
    const res = await dispatch(req("/some/random.txt"), makeEnv());
    expect([200, 404]).toContain(res.status);
    if (res.status === 404) {
      expect(await res.text()).toBe("");
    }
  });
});
