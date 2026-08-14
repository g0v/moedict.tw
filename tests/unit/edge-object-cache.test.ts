import { describe, expect, it, vi, beforeEach, afterEach } from "vite-plus/test";
import {
  buildEdgeObjectCacheKey,
  cachedObjectText,
  cachedObjectBytes,
  EDGE_OBJECT_CACHE_ORIGIN,
  type EdgeObjectCacheOptions,
} from "../../src/utils/edge-object-cache";
import { loadTwKaiShardBuffer } from "../../src/utils/image-generation";

class FakeCache {
  public store = new Map<string, Response>();
  public matchCalls = 0;
  public putCalls = 0;

  async match(request: Request | string): Promise<Response | undefined> {
    this.matchCalls++;
    const url = typeof request === "string" ? request : request.url;
    const res = this.store.get(url);
    if (!res) return undefined;
    return res.clone();
  }

  async put(request: Request | string, response: Response): Promise<void> {
    this.putCalls++;
    const url = typeof request === "string" ? request : request.url;
    this.store.set(url, response.clone());
  }

  clear() {
    this.store.clear();
    this.matchCalls = 0;
    this.putCalls = 0;
  }
}

describe("edge-object-cache", () => {
  let fakeCache: FakeCache;

  const testOpts: EdgeObjectCacheOptions = {
    namespace: "fonts",
    version: "1",
    sMaxAgeSeconds: 2592000,
  };

  beforeEach(() => {
    fakeCache = new FakeCache();
    vi.stubGlobal("caches", { default: fakeCache });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("buildEdgeObjectCacheKey", () => {
    it("encodes R2 key with encodeURIComponent into single path segment", () => {
      const key1 = "U+840C.svg";
      const req1 = buildEdgeObjectCacheKey(testOpts, key1);
      expect(req1.url).toBe(`${EDGE_OBJECT_CACHE_ORIGIN}/fonts/1/U%2B840C.svg`);

      const key2 = "fonts/TW-Kai-shard-0.ttf";
      const req2 = buildEdgeObjectCacheKey(testOpts, key2);
      expect(req2.url).toBe(`${EDGE_OBJECT_CACHE_ORIGIN}/fonts/1/fonts%2FTW-Kai-shard-0.ttf`);
    });
  });

  describe("cachedObjectText", () => {
    it("L2 hit avoids the R2 read entirely", async () => {
      const cacheKey = buildEdgeObjectCacheKey(testOpts, "glyph.svg");
      await fakeCache.put(cacheKey, new Response("<svg>hit</svg>", { status: 200 }));

      const bucketGet = vi.fn();
      const bucket = { get: bucketGet };

      const result = await cachedObjectText(bucket, "glyph.svg", testOpts);
      expect(result).toBe("<svg>hit</svg>");
      expect(bucketGet).not.toHaveBeenCalled();
    });

    it("L2 miss populates the cache then serves from it on a second call", async () => {
      const bucketGet = vi.fn(async (k: string) => {
        if (k === "glyph.svg") {
          return { text: async () => "<svg>fetched</svg>" };
        }
        return null;
      });
      const bucket = { get: bucketGet };

      // First call (miss) -> reads R2, populates L2 cache
      const result1 = await cachedObjectText(bucket, "glyph.svg", testOpts);
      expect(result1).toBe("<svg>fetched</svg>");
      expect(bucketGet).toHaveBeenCalledTimes(1);

      // Second call (hit) -> reads from L2, no R2 read
      const result2 = await cachedObjectText(bucket, "glyph.svg", testOpts);
      expect(result2).toBe("<svg>fetched</svg>");
      expect(bucketGet).toHaveBeenCalledTimes(1);
    });

    it("cached 404 sentinel resolves to null without a second R2 read", async () => {
      const bucketGet = vi.fn(async () => null);
      const bucket = { get: bucketGet };

      // First call (R2 404) -> populates 404 sentinel in L2
      const result1 = await cachedObjectText(bucket, "missing.svg", testOpts);
      expect(result1).toBeNull();
      expect(bucketGet).toHaveBeenCalledTimes(1);

      // Verify 404 sentinel stored in cache with Cache-Control
      const cacheKey = buildEdgeObjectCacheKey(testOpts, "missing.svg");
      const stored = fakeCache.store.get(cacheKey.url);
      expect(stored).toBeDefined();
      expect(stored?.status).toBe(404);
      expect(stored?.headers.get("Cache-Control")).toBe("public, s-maxage=2592000");

      // Second call -> returns null from L2 sentinel without calling R2
      const result2 = await cachedObjectText(bucket, "missing.svg", testOpts);
      expect(result2).toBeNull();
      expect(bucketGet).toHaveBeenCalledTimes(1);
    });

    it("caches global that is absent falls through to R2", async () => {
      vi.stubGlobal("caches", undefined);

      const bucketGet = vi.fn(async () => ({ text: async () => "<svg>fallback</svg>" }));
      const bucket = { get: bucketGet };

      const result = await cachedObjectText(bucket, "glyph.svg", testOpts);
      expect(result).toBe("<svg>fallback</svg>");
      expect(bucketGet).toHaveBeenCalledTimes(1);
    });

    it("match or put that throws still returns correct data from R2", async () => {
      // 1. Throwing match
      vi.stubGlobal("caches", {
        default: {
          match: vi.fn().mockRejectedValue(new Error("Match error")),
          put: vi.fn().mockResolvedValue(undefined),
        },
      });

      const bucketGet = vi.fn(async () => ({ text: async () => "<svg>ok</svg>" }));
      const resultMatchThrow = await cachedObjectText({ get: bucketGet }, "glyph.svg", testOpts);
      expect(resultMatchThrow).toBe("<svg>ok</svg>");

      // 2. Throwing put
      vi.stubGlobal("caches", {
        default: {
          match: vi.fn().mockResolvedValue(undefined),
          put: vi.fn().mockRejectedValue(new Error("Put error")),
        },
      });

      const resultPutThrow = await cachedObjectText({ get: bucketGet }, "glyph.svg", testOpts);
      expect(resultPutThrow).toBe("<svg>ok</svg>");
    });

    it("falls through to R2 when caches is an empty object or non-object without default", async () => {
      vi.stubGlobal("caches", {});
      const bucketGet = vi.fn(async () => ({ text: async () => "<svg>nodefault</svg>" }));
      expect(await cachedObjectText({ get: bucketGet }, "glyph.svg", testOpts)).toBe(
        "<svg>nodefault</svg>",
      );

      vi.stubGlobal("caches", "invalid-primitive");
      expect(await cachedObjectText({ get: bucketGet }, "glyph.svg", testOpts)).toBe(
        "<svg>nodefault</svg>",
      );
    });

    it("falls through to R2 load when cached response has unexpected status", async () => {
      const cacheKey = buildEdgeObjectCacheKey(testOpts, "glyph.svg");
      await fakeCache.put(cacheKey, new Response("error", { status: 500 }));

      const bucketGet = vi.fn(async () => ({ text: async () => "<svg>reloaded</svg>" }));
      const result = await cachedObjectText({ get: bucketGet }, "glyph.svg", testOpts);
      expect(result).toBe("<svg>reloaded</svg>");
      expect(bucketGet).toHaveBeenCalledTimes(1);
    });

    it("falls through to R2 when caches access throws an error", async () => {
      const throwingProxy = new Proxy(
        {},
        {
          has() {
            throw new Error("Access error");
          },
          get() {
            throw new Error("Access error");
          },
        },
      );
      vi.stubGlobal("caches", throwingProxy);
      const bucketGet = vi.fn(async () => ({ text: async () => "<svg>proxyfallback</svg>" }));
      expect(await cachedObjectText({ get: bucketGet }, "glyph.svg", testOpts)).toBe(
        "<svg>proxyfallback</svg>",
      );
    });
  });

  describe("cachedObjectBytes", () => {
    it("L2 hit avoids R2 read entirely for bytes", async () => {
      const data = new Uint8Array([1, 2, 3, 4]);
      const cacheKey = buildEdgeObjectCacheKey(testOpts, "font.ttf");
      await fakeCache.put(cacheKey, new Response(data, { status: 200 }));

      const bucketGet = vi.fn();
      const result = await cachedObjectBytes({ get: bucketGet }, "font.ttf", testOpts);
      expect(result).toEqual(data);
      expect(bucketGet).not.toHaveBeenCalled();
    });

    it("L2 miss populates cache then serves from it on second call for bytes", async () => {
      const data = new Uint8Array([10, 20, 30]);
      const bucketGet = vi.fn(async () => ({ arrayBuffer: async () => data.buffer }));

      const res1 = await cachedObjectBytes({ get: bucketGet }, "font.ttf", testOpts);
      expect(res1).toEqual(data);
      expect(bucketGet).toHaveBeenCalledTimes(1);

      const res2 = await cachedObjectBytes({ get: bucketGet }, "font.ttf", testOpts);
      expect(res2).toEqual(data);
      expect(bucketGet).toHaveBeenCalledTimes(1);
    });

    it("cached 404 sentinel resolves to null without second R2 read for bytes", async () => {
      const bucketGet = vi.fn(async () => null);

      const res1 = await cachedObjectBytes({ get: bucketGet }, "missing.ttf", testOpts);
      expect(res1).toBeNull();
      expect(bucketGet).toHaveBeenCalledTimes(1);

      const res2 = await cachedObjectBytes({ get: bucketGet }, "missing.ttf", testOpts);
      expect(res2).toBeNull();
      expect(bucketGet).toHaveBeenCalledTimes(1);
    });
  });

  describe("loadTwKaiShardBuffer LRU + L2 integration", () => {
    it("performs ZERO R2 reads on a second call for the same shard when the colo cache is warm but isolate LRU evicted it", async () => {
      const shardData: Record<string, Uint8Array> = {
        "fonts/TW-Kai-shard-0.ttf": new Uint8Array([0, 1]),
        "fonts/TW-Kai-shard-1.ttf": new Uint8Array([1, 2]),
        "fonts/TW-Kai-shard-2.ttf": new Uint8Array([2, 3]),
      };

      const env = {
        FONTS: { get: vi.fn(async () => null) },
        ASSETS: {
          get: vi.fn(
            async (key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> => {
              const data = shardData[key];
              if (!data) return null;
              return { arrayBuffer: async () => data.buffer as ArrayBuffer };
            },
          ),
        },
      };

      // 1. Fetch Shard 0 (misses LRU and L2 -> reads R2, populates L2 and L1)
      const res0 = await loadTwKaiShardBuffer(env, "fonts/TW-Kai-shard-0.ttf");
      expect(res0).toEqual(shardData["fonts/TW-Kai-shard-0.ttf"]);
      expect(env.ASSETS.get).toHaveBeenCalledTimes(1);

      // 2. Fetch Shard 1 (misses LRU and L2 -> reads R2, populates L2 and L1)
      const res1 = await loadTwKaiShardBuffer(env, "fonts/TW-Kai-shard-1.ttf");
      expect(res1).toEqual(shardData["fonts/TW-Kai-shard-1.ttf"]);
      expect(env.ASSETS.get).toHaveBeenCalledTimes(2);

      // 3. Fetch Shard 2 (MAX_ISOLATE_SHARD_CACHE_SIZE is 2 -> evicts Shard 0 from isolate L1 cache)
      const res2 = await loadTwKaiShardBuffer(env, "fonts/TW-Kai-shard-2.ttf");
      expect(res2).toEqual(shardData["fonts/TW-Kai-shard-2.ttf"]);
      expect(env.ASSETS.get).toHaveBeenCalledTimes(3);

      // 4. Fetch Shard 0 AGAIN. It is evicted from isolate L1 LRU cache, but L2 colo cache is warm!
      const res0Again = await loadTwKaiShardBuffer(env, "fonts/TW-Kai-shard-0.ttf");
      expect(res0Again).toEqual(shardData["fonts/TW-Kai-shard-0.ttf"]);

      // PROOF: ZERO additional R2 reads performed! (ASSETS.get still called 3 times total)
      expect(env.ASSETS.get).toHaveBeenCalledTimes(3);
    });

    it("falls back cleanly to R2 when caches exists but caches.default is undefined", async () => {
      vi.stubGlobal("caches", { default: undefined });
      const bucket = {
        get: vi.fn(async () => ({
          text: async () => "fallback-content",
        })),
      };
      const result = await cachedObjectText(bucket, "test.svg", testOpts);
      expect(result).toBe("fallback-content");
      expect(bucket.get).toHaveBeenCalledWith("test.svg");
    });
  });
});
