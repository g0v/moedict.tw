/**
 * Coverage for src/utils/dictionary-cache.ts — verifies the in-memory LRU
 * cache, PENDING_CACHE dedupe, lang-prefix token building, and the
 * AbortSignal path that deliberately bypasses dedupe.
 *
 * NOTE: the module keeps state at module scope, so each test uses a unique
 * word to avoid cross-contamination. `vi.resetModules()` gives fresh state
 * where we need it (LRU eviction test).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function importFresh() {
  vi.resetModules();
  return import("../../src/utils/dictionary-cache");
}

function makeFetchMock(
  responses: Array<{ body: unknown; status?: number }>,
): ReturnType<typeof vi.fn> {
  let call = 0;
  return vi.fn(async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  });
}

describe("readCachedDictionaryEntry", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns null when the word is not cached", async () => {
    const mod = await importFresh();
    expect(mod.readCachedDictionaryEntry("uncached-word", "a")).toBeNull();
  });

  it("returns null for empty / whitespace-only input", async () => {
    const mod = await importFresh();
    expect(mod.readCachedDictionaryEntry("", "a")).toBeNull();
    expect(mod.readCachedDictionaryEntry("   ", "a")).toBeNull();
  });
});

describe("fetchDictionaryEntry — lang prefixes", () => {
  it.each([
    ["a", "萌", "/api/%E8%90%8C.json"],
    ["t", "食", "/api/'%E9%A3%9F.json"],
    ["h", "字", "/api/%3A%E5%AD%97.json"],
    ["c", "萌", "/api/~%E8%90%8C.json"],
  ] as const)("builds %s-lang token with correct prefix", async (lang, word, expectedUrl) => {
    const mod = await importFresh();
    const fetchSpy = makeFetchMock([{ body: { title: word } }]);
    globalThis.fetch = fetchSpy as typeof fetch;

    const result = await mod.fetchDictionaryEntry(word, lang);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const called = fetchSpy.mock.calls[0][0] as string;
    expect(decodeURIComponent(called)).toBe(decodeURIComponent(expectedUrl));
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });
});

describe("fetchDictionaryEntry — caching", () => {
  it("caches a successful response and skips the network on second call", async () => {
    const mod = await importFresh();
    const fetchSpy = makeFetchMock([{ body: { title: "萌" } }]);
    globalThis.fetch = fetchSpy as typeof fetch;

    const first = await mod.fetchDictionaryEntry("cache-hit", "a");
    const second = await mod.fetchDictionaryEntry("cache-hit", "a");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(second).toBe(first); // identity equality — same cached object
  });

  it("dedupes concurrent un-signalled requests via PENDING_CACHE", async () => {
    const mod = await importFresh();
    let resolve: (value: Response) => void = () => {};
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    const fetchSpy = vi.fn(async () => pending);
    globalThis.fetch = fetchSpy as typeof fetch;

    const a = mod.fetchDictionaryEntry("dedupe", "a");
    const b = mod.fetchDictionaryEntry("dedupe", "a");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    resolve(new Response(JSON.stringify({ title: "x" }), { status: 200 }));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
  });

  it("AbortSignal path bypasses PENDING_CACHE dedupe", async () => {
    const mod = await importFresh();
    const fetchSpy = makeFetchMock([{ body: { title: "a" } }, { body: { title: "b" } }]);
    globalThis.fetch = fetchSpy as typeof fetch;

    // Un-signalled primes PENDING_CACHE.
    const unsigned = mod.fetchDictionaryEntry("signalled", "a");
    // Signalled call should NOT dedupe — it issues its own fetch.
    const signalled = mod.fetchDictionaryEntry("signalled", "a", new AbortController().signal);
    await Promise.all([unsigned, signalled]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects empty word with an Error", async () => {
    const mod = await importFresh();
    await expect(mod.fetchDictionaryEntry("", "a")).rejects.toThrow(/empty/i);
    await expect(mod.fetchDictionaryEntry("   ", "a")).rejects.toThrow(/empty/i);
  });

  it("propagates non-OK status through the returned response", async () => {
    const mod = await importFresh();
    globalThis.fetch = makeFetchMock([{ body: { error: "nope" }, status: 404 }]) as typeof fetch;
    const result = await mod.fetchDictionaryEntry("not-found", "a");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.data).toEqual({ error: "nope" });
  });

  it("falls back to empty object when the response body is not valid JSON", async () => {
    const mod = await importFresh();
    globalThis.fetch = vi.fn(async () => new Response("not json", { status: 200 })) as typeof fetch;
    const result = await mod.fetchDictionaryEntry("bad-json", "a");
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({});
  });
});

describe("fetchDictionaryEntry — LRU eviction", () => {
  it("drops the oldest entry after 300 cached responses", async () => {
    const mod = await importFresh();
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount += 1;
      return new Response(JSON.stringify({ n: callCount }), { status: 200 });
    }) as typeof fetch;

    for (let i = 0; i < 301; i += 1) {
      await mod.fetchDictionaryEntry(`lru-${i}`, "a");
    }

    // First entry should now be evicted → re-fetching it issues a new request.
    const before = callCount;
    await mod.fetchDictionaryEntry("lru-0", "a");
    expect(callCount).toBe(before + 1);

    // Most recent entry stays cached → no additional fetch.
    await mod.fetchDictionaryEntry("lru-300", "a");
    expect(callCount).toBe(before + 1);
  });

  it("skips eviction when the cache iterator is unexpectedly empty", async () => {
    const mod = await importFresh();
    const keysSpy = vi.spyOn(Map.prototype, "keys").mockImplementation(function () {
      return {
        next: () => ({ value: undefined, done: true }),
        [Symbol.iterator]() {
          return this;
        },
      } as IterableIterator<string>;
    });
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount += 1;
      return new Response(JSON.stringify({ n: callCount }), { status: 200 });
    }) as typeof fetch;

    for (let i = 0; i < 301; i += 1) {
      await mod.fetchDictionaryEntry(`lru-empty-${i}`, "a");
    }

    expect(keysSpy).toHaveBeenCalled();
    expect(callCount).toBe(301);
  });
});

describe("prefetchDictionaryEntry", () => {
  it("warms the cache without throwing on network failure", async () => {
    const mod = await importFresh();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(() => mod.prefetchDictionaryEntry("prefetch", "a")).not.toThrow();
    // Give the microtask queue a chance to settle the swallowed rejection.
    await Promise.resolve();
  });

  it("is a no-op for empty input", async () => {
    const mod = await importFresh();
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    mod.prefetchDictionaryEntry("", "a");
    mod.prefetchDictionaryEntry("   ", "a");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
