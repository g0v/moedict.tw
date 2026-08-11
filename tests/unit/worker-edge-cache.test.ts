/**
 * Unit tests for the dispatch-boundary edge cache layer (worker/index.ts).
 *
 * Cloudflare never edge-caches Worker-generated responses on its own; the
 * 2026-07 billing audit showed bots re-rendering identical responses on
 * every hit. dispatch() now reads through `caches.default` and writes back
 * responses that opt in via `isEdgeCacheable`. These tests install a fake
 * `caches` global (absent in plain Node, so every other unit test exercises
 * the no-op path) and defend: read-through hits, opt-in criteria, probe
 * safety (unique URLs miss), and failure isolation (cache errors never break
 * rendering).
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { dispatch, isEdgeCacheable } from "../../worker/index";

type WorkerEnv = Parameters<typeof dispatch>[1];
type WorkerCtx = NonNullable<Parameters<typeof dispatch>[2]>;

interface FakeCacheControls {
  store: Map<string, Response>;
  matchCalls: number;
  putCalls: number;
}

function installFakeEdgeCache(
  overrides: {
    match?: (request: Request) => Promise<Response | undefined>;
    put?: (request: Request, response: Response) => Promise<void>;
  } = {},
): FakeCacheControls {
  const controls: FakeCacheControls = { store: new Map(), matchCalls: 0, putCalls: 0 };
  const fake = {
    default: {
      match: async (request: Request) => {
        controls.matchCalls += 1;
        if (overrides.match) return overrides.match(request);
        const hit = controls.store.get(request.url);
        return hit ? hit.clone() : undefined;
      },
      put: async (request: Request, response: Response) => {
        controls.putCalls += 1;
        if (overrides.put) return overrides.put(request, response);
        controls.store.set(request.url, response);
      },
    },
  };
  // Test seam: the fake implements only the two Cache methods dispatch uses.
  globalThis.caches = fake as unknown as typeof caches;
  return controls;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "caches");
});

function makeEnv() {
  const getCalls: string[] = [];
  const env = {
    DICTIONARY: {
      getCalls,
      get: async (key: string) => {
        getCalls.push(key);
        if (key === "search-index/a.json") {
          return { text: async () => '{"terms":["萌"]}' };
        }
        return null;
      },
    },
  } as unknown as WorkerEnv;
  return { env, getCalls };
}

const INDEX_URL = "http://localhost/api/search-index/a.json";

describe("dispatch edge cache layer", () => {
  it("stores an s-maxage GET once and serves the repeat from cache with a hit marker", async () => {
    const controls = installFakeEdgeCache();
    const { env, getCalls } = makeEnv();

    const first = await dispatch(new Request(INDEX_URL), env);
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Moedict-Edge-Cache")).toBeNull();
    await first.text();
    expect(controls.store.size).toBe(1);
    expect(getCalls).toHaveLength(1);

    const second = await dispatch(new Request(INDEX_URL), env);
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Moedict-Edge-Cache")).toBe("hit");
    expect(await second.json()).toEqual({ terms: ["萌"] });
    expect(getCalls).toHaveLength(1); // renderer never re-invoked
  });

  it("keeps distinct URLs distinct, so cache-busted probes always re-render", async () => {
    const controls = installFakeEdgeCache();
    const { env, getCalls } = makeEnv();
    await dispatch(new Request(`${INDEX_URL}?_probe=a`), env);
    const second = await dispatch(new Request(`${INDEX_URL}?_probe=b`), env);
    expect(second.headers.get("X-Moedict-Edge-Cache")).toBeNull();
    expect(getCalls).toHaveLength(2);
    expect(controls.store.size).toBe(2);
  });

  it("never stores no-store responses (404 fallback)", async () => {
    const controls = installFakeEdgeCache();
    const { env } = makeEnv();
    const res = await dispatch(new Request("http://localhost/some/random.txt"), env);
    expect(res.status).toBe(404);
    expect(controls.store.size).toBe(0);
  });

  it("never consults or writes the cache for non-GET requests", async () => {
    const controls = installFakeEdgeCache();
    const { env } = makeEnv();
    await dispatch(new Request(INDEX_URL, { method: "HEAD" }), env);
    await dispatch(new Request(INDEX_URL, { method: "POST" }), env);
    expect(controls.matchCalls).toBe(0);
    expect(controls.store.size).toBe(0);
  });

  it("renders normally when the cache lookup throws", async () => {
    installFakeEdgeCache({
      match: async () => {
        throw new Error("cache backend unavailable");
      },
    });
    const { env } = makeEnv();
    const res = await dispatch(new Request(INDEX_URL), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ terms: ["萌"] });
  });

  it("returns the response even when the cache write rejects, via ctx.waitUntil", async () => {
    const controls = installFakeEdgeCache({
      put: async () => {
        throw new Error("write failed");
      },
    });
    const { env } = makeEnv();
    const waited: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        waited.push(p);
      },
    } as unknown as WorkerCtx;
    const res = await dispatch(new Request(INDEX_URL), env, ctx);
    expect(res.status).toBe(200);
    expect(waited).toHaveLength(1);
    await Promise.all(waited); // .catch() arm swallows the rejection
    expect(controls.putCalls).toBe(1);
  });

  it("fires the cache write without ctx (fire-and-forget) and serves it next time", async () => {
    const controls = installFakeEdgeCache();
    const { env } = makeEnv();
    await dispatch(new Request(INDEX_URL), env);
    await vi.waitFor(() => {
      expect(controls.putCalls).toBe(1);
    });
    const second = await dispatch(new Request(INDEX_URL), env);
    expect(second.headers.get("X-Moedict-Edge-Cache")).toBe("hit");
  });

  it("namespaces the entry cache key by release tag, invalidating stale cache on release change", async () => {
    const controls = installFakeEdgeCache();
    const envV1 = {
      ...makeEnv().env,
      CF_VERSION_METADATA: { id: "uuid-1", tag: "release-v1", timestamp: "2026-08-11T00:00:00Z" },
    };
    const envV2 = {
      ...makeEnv().env,
      CF_VERSION_METADATA: { id: "uuid-2", tag: "release-v2", timestamp: "2026-08-11T01:00:00Z" },
    };

    const first = await dispatch(new Request(INDEX_URL), envV1);
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Moedict-Edge-Cache")).toBeNull();
    await vi.waitFor(() => expect(controls.putCalls).toBe(1));

    // Repeat request on same release -> HIT
    const second = await dispatch(new Request(INDEX_URL), envV1);
    expect(second.headers.get("X-Moedict-Edge-Cache")).toBe("hit");

    // Request on new release -> MISS (re-renders fresh)
    const third = await dispatch(new Request(INDEX_URL), envV2);
    expect(third.headers.get("X-Moedict-Edge-Cache")).toBeNull();
    await vi.waitFor(() => expect(controls.putCalls).toBe(2));
  });
});

describe("isEdgeCacheable", () => {
  const GET = new Request("http://localhost/x");
  const ok = (headers: Record<string, string>, status = 200) =>
    new Response("body", { status, headers });

  it("accepts a GET 200 with positive s-maxage and non-HTML content type", () => {
    expect(
      isEdgeCacheable(
        GET,
        ok({ "Cache-Control": "public, max-age=0, s-maxage=60", "Content-Type": "image/png" }),
      ),
    ).toBe(true);
  });

  it("rejects non-GET, non-200, no-store, private, missing/zero s-maxage, Set-Cookie, and HTML", () => {
    const cacheable = { "Cache-Control": "public, s-maxage=60", "Content-Type": "image/png" };
    expect(
      isEdgeCacheable(new Request("http://localhost/x", { method: "POST" }), ok(cacheable)),
    ).toBe(false);
    expect(isEdgeCacheable(GET, ok(cacheable, 404))).toBe(false);
    expect(isEdgeCacheable(GET, ok({ "Cache-Control": "no-store, s-maxage=60" }))).toBe(false);
    expect(isEdgeCacheable(GET, ok({ "Cache-Control": "private, s-maxage=60" }))).toBe(false);
    expect(isEdgeCacheable(GET, ok({ "Cache-Control": "public, max-age=300" }))).toBe(false);
    expect(isEdgeCacheable(GET, ok({ "Cache-Control": "public, s-maxage=0" }))).toBe(false);
    // happy-dom's Headers drops the forbidden Set-Cookie header from real
    // Response objects, so this arm uses a structural fake (test seam).
    const withSetCookie = {
      status: 200,
      headers: {
        get: (key: string) => (key === "Cache-Control" ? "public, s-maxage=60" : null),
        has: (key: string) => key === "Set-Cookie",
      },
    } as unknown as Response;
    expect(isEdgeCacheable(GET, withSetCookie)).toBe(false);
    expect(
      isEdgeCacheable(
        GET,
        ok({ "Cache-Control": "public, s-maxage=60", "Content-Type": "text/html; charset=utf-8" }),
      ),
    ).toBe(false);
  });

  it("treats absent Cache-Control / Content-Type headers as empty strings", () => {
    const noCacheControl = {
      status: 200,
      headers: { get: () => null, has: () => false },
    } as unknown as Response;
    expect(isEdgeCacheable(GET, noCacheControl)).toBe(false); // no s-maxage → reject

    const noContentType = {
      status: 200,
      headers: {
        get: (key: string) => (key === "Cache-Control" ? "public, s-maxage=60" : null),
        has: () => false,
      },
    } as unknown as Response;
    expect(isEdgeCacheable(GET, noContentType)).toBe(true); // opt-in via s-maxage stands
  });
});

// ---------------------------------------------------------------------------
// P1 fix: /api/stroke-json/* edge cache identity is namespaced by the
// current atomic corpusDigest instead of the bare URL. CACHE_PURGE_TOKEN
// (the Worker secret) is unavailable to the corpus-upload CLI pipeline
// (promoteCorpusPointer runs as a local operator command, never inside the
// Worker), so cache identity is fixed at the source: a pointer promotion
// changes corpusDigest, which changes the cache key, which means the OLD
// bare-URL entry can never be read again after a new Worker version with
// this fix is live — it just ages out on its own TTL, unread. This block
// builds a full 6,063-file schema-valid corpus (matching the pattern in
// worker-dispatch.test.ts's "dispatch — /api/stroke-json R2 ASSETS" block)
// so handleStrokeAPI's resolveCorpus() actually resolves, and tracks R2
// `get` calls to prove the digest peek reuses handleStrokeAPI's own
// per-isolate resolver (shared WeakMap — zero duplicate reads after the
// first cold resolution).
// ---------------------------------------------------------------------------
describe("dispatch edge cache layer — /api/stroke-json digest-namespaced key", () => {
  interface AssetsGetCall {
    key: string;
  }

  function seedAtomicCorpus(
    digest: string,
    bodyByHex: Record<string, string>,
  ): Record<string, { body: string }> {
    const entries: Record<string, { body: string }> = {};
    const files: Array<{ path: string; sha256: string; bytes: number }> = [];
    const hexes = new Set(Object.keys(bodyByHex));
    let synthetic = 0x4e00;
    const allBodies: Record<string, string> = { ...bodyByHex };
    while (hexes.size < 6063) {
      const hex = synthetic.toString(16);
      synthetic++;
      if (hexes.has(hex)) continue;
      hexes.add(hex);
      allBodies[hex] = "[]";
    }
    for (const hex of hexes) {
      const body = allBodies[hex];
      const bytes = new TextEncoder().encode(body).length;
      const sha256 = bytes.toString(16).padStart(64, "0");
      files.push({ path: `stroke-json/${hex}.json`, sha256, bytes });
      entries[`stroke-corpora/${digest}/stroke-json/${hex}.json`] = { body };
    }
    const totalBytes = files.reduce((s, f) => s + f.bytes, 0);
    const manifest = {
      schema: 1,
      corpusDigest: digest,
      fileCount: files.length,
      totalBytes,
      files,
    };
    const pointer = {
      schema: 1,
      corpusDigest: digest,
      manifestKey: `stroke-corpora/${digest}/manifest.json`,
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
    };
    entries["stroke-corpus/current.json"] = { body: JSON.stringify(pointer) };
    entries[`stroke-corpora/${digest}/manifest.json`] = { body: JSON.stringify(manifest) };
    return entries;
  }

  function makeStrokeEnv(entries: Record<string, { body: string }>) {
    const getCalls: AssetsGetCall[] = [];
    const bucket = {
      async head(key: string) {
        const e = entries[key];
        if (!e) return null;
        return { httpEtag: '"etag-stub"', writeHttpMetadata: () => {} };
      },
      async get(key: string) {
        getCalls.push({ key });
        const e = entries[key];
        if (!e) return null;
        return {
          httpEtag: '"etag-stub"',
          writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", "application/json"),
          body: new Response(e.body).body!,
          text: async () => e.body,
        };
      },
    };
    const env = { ASSETS: bucket } as unknown as WorkerEnv;
    return { env, getCalls };
  }

  const STROKE_URL = "http://localhost/api/stroke-json/840c.json";

  it("stores under a digest-namespaced key distinct from the bare public URL", async () => {
    const digestA = "a".repeat(64);
    const controls = installFakeEdgeCache();
    const { env } = makeStrokeEnv(seedAtomicCorpus(digestA, { "840c": "[]" }));

    const res = await dispatch(new Request(STROKE_URL), env);
    expect(res.status).toBe(200);
    await res.text();

    expect(controls.store.size).toBe(1);
    // The stored key carries the digest namespace param; the bare public
    // URL itself was never used as the literal cache key.
    const storedUrl = [...controls.store.keys()][0];
    expect(storedUrl).not.toBe(STROKE_URL);
    expect(storedUrl.startsWith(`${STROKE_URL}?`)).toBe(true);
    expect(storedUrl).toContain(digestA);
  });

  it("same corpus (same digest): repeat GET is served from cache with a hit marker", async () => {
    const digestA = "a".repeat(64);
    installFakeEdgeCache();
    const { env, getCalls } = makeStrokeEnv(seedAtomicCorpus(digestA, { "840c": "[]" }));

    const first = await dispatch(new Request(STROKE_URL), env);
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Moedict-Edge-Cache")).toBeNull();
    await first.text();
    const readsAfterFirst = getCalls.length;
    expect(readsAfterFirst).toBeGreaterThan(0);

    const second = await dispatch(new Request(STROKE_URL), env);
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Moedict-Edge-Cache")).toBe("hit");
    // Shared resolver (handleStrokeAPI's own per-isolate WeakMap, reused
    // by peekStrokeCorpusDigest via resolveCorpus) means a second dispatch
    // for the same bucket within the TTL does not re-read pointer/manifest
    // — but the digest peek itself still runs once per dispatch call, so
    // a cache HIT means handleStrokeAPI's own object GET is fully skipped
    // (never re-invoked) while the peek's pointer/manifest reads are
    // served from the warm resolver cache (no growth beyond first-call).
    expect(getCalls.length).toBe(readsAfterFirst);
  });

  it("pointer change to a new corpusDigest: old bare-URL cache entry is never served; new digest misses and re-renders", async () => {
    const digestA = "a".repeat(64);
    const digestB = "b".repeat(64);
    const controls = installFakeEdgeCache();

    // First Worker instance: old corpus, digest A.
    const { env: envA } = makeStrokeEnv(seedAtomicCorpus(digestA, { "840c": '["before"]' }));
    const first = await dispatch(new Request(STROKE_URL), envA);
    expect(first.status).toBe(200);
    await first.text();
    expect(controls.store.size).toBe(1);

    // Simulate the resolver TTL/isolate boundary elapsing (a fresh
    // isolate, or the per-isolate resolvedCorpusCache TTL expiring) by
    // constructing a brand-new bucket/env for the SAME dispatch — a
    // pointer promotion happened; digest is now B with new content.
    const { env: envB } = makeStrokeEnv(seedAtomicCorpus(digestB, { "840c": '["after"]' }));
    const second = await dispatch(new Request(STROKE_URL), envB);
    expect(second.status).toBe(200);
    // Never served the old digest-A cached body — a genuine cache MISS
    // for the new digest, not a stale hit.
    expect(second.headers.get("X-Moedict-Edge-Cache")).toBeNull();
    expect(await second.json()).toEqual(["after"]);

    // Both digest-namespaced keys now coexist; the bare (un-namespaced)
    // public URL was never used as a literal cache key at any point.
    expect(controls.store.size).toBe(2);
    for (const storedUrl of controls.store.keys()) {
      expect(storedUrl).not.toBe(STROKE_URL);
    }
  });

  it("bypasses the edge cache entirely (no read, no write) when the pointer/manifest fails to resolve", async () => {
    const controls = installFakeEdgeCache();
    const { env } = makeStrokeEnv({}); // no pointer object at all
    const res = await dispatch(new Request(STROKE_URL), env);
    expect(res.status).toBe(503); // handleStrokeAPI's own fail-closed response
    expect(controls.matchCalls).toBe(0);
    expect(controls.putCalls).toBe(0);
    expect(controls.store.size).toBe(0);
  });

  it("bypasses the edge cache entirely when env.ASSETS is not a bucket at all (getAssetsBucket returns null)", async () => {
    const controls = installFakeEdgeCache();
    // No ASSETS binding whatsoever — deriveStrokeJsonEdgeCacheKey's own
    // getAssetsBucket(env) guard returns null before ever calling
    // peekStrokeCorpusDigest, so the edge-cache layer bypasses cleanly.
    const env = {} as WorkerEnv;
    const res = await dispatch(new Request(STROKE_URL), env);
    expect(controls.matchCalls).toBe(0);
    expect(controls.putCalls).toBe(0);
    expect(controls.store.size).toBe(0);
    // handleStrokeAPI itself still runs (unrelated failure mode for a
    // totally-absent ASSETS binding) — not the point under test here.
    expect(res.status).toBe(500);
  });

  it("bypasses the edge cache when the corpus resolver's own R2 read throws (never crashes rendering)", async () => {
    // resolveCorpusUncached (shared by handleStrokeAPI and
    // peekStrokeCorpusDigest) already catches ANY error during
    // pointer/manifest resolution and returns null — so a throwing bucket
    // here resolves gracefully to "corpus unavailable" for BOTH the
    // digest peek (bypass the edge cache) and handleStrokeAPI itself
    // (fail-closed 503), never an uncaught exception at the dispatch
    // layer. This proves the cache layer's own defensive try/catch around
    // deriveStrokeJsonEdgeCacheKey never needs to fire for this input
    // shape, and that a resolver failure never partially writes the cache.
    const controls = installFakeEdgeCache();
    const throwingBucket = {
      head: async () => null,
      get: async () => {
        throw new Error("R2 unavailable");
      },
    };
    const env = { ASSETS: throwingBucket } as unknown as WorkerEnv;
    const res = await dispatch(new Request(STROKE_URL), env);
    expect(res.status).toBe(503);
    expect(controls.matchCalls).toBe(0);
    expect(controls.putCalls).toBe(0);
    expect(controls.store.size).toBe(0);
  });

  it("never touches the digest-peek path for HEAD requests (unchanged conditional/HEAD contract)", async () => {
    const digestA = "a".repeat(64);
    const controls = installFakeEdgeCache();
    const { env, getCalls } = makeStrokeEnv(seedAtomicCorpus(digestA, { "840c": "[]" }));
    const res = await dispatch(new Request(STROKE_URL, { method: "HEAD" }), env);
    expect(res.status).toBe(200);
    expect(controls.matchCalls).toBe(0);
    expect(controls.putCalls).toBe(0);
    // handleStrokeAPI itself still resolves the corpus for the HEAD
    // response (unchanged), just never through the edge-cache layer.
    expect(getCalls.length).toBeGreaterThan(0);
  });
});
