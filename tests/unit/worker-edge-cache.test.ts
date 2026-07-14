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
