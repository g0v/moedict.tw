/**
 * Unit tests for versioned dictionary CDN object fetching (src/api/r2-json-cache.ts).
 */
import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import { fetchDictionaryObjectText, type R2JsonSource } from "../../src/api/r2-json-cache";
import { DICTIONARY_CORPUS_POINTER_KEY } from "../../src/utils/dictionary-corpus";

function makeSource(objects: Record<string, string | undefined>): R2JsonSource & {
  getCalls: string[];
} {
  const getCalls: string[] = [];
  return {
    getCalls,
    get: async (key: string) => {
      getCalls.push(key);
      const body = objects[key];
      if (body === undefined) return null;
      return { text: async () => body };
    },
  };
}

const TEST_DIGEST = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

function validPointer(digest: string = TEST_DIGEST): string {
  return JSON.stringify({
    schema: 1,
    dictionaryDigest: digest,
    manifestKey: `dictionary-corpora/${digest}/manifest.json`,
    fileCount: 1,
    totalBytes: 1,
  });
}

describe("fetchDictionaryObjectText", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("happy path issues exactly ONE fetch whose URL contains both key and digest, returning body without touching binding for the object key", async () => {
    const source = makeSource({
      [DICTIONARY_CORPUS_POINTER_KEY]: validPointer(TEST_DIGEST),
      "a/index.json": '{"fromBinding":true}',
    });
    const fetchCalls: {
      url: string;
      options?: RequestInit & { cf?: { cacheEverything?: boolean; cacheTtl?: number } };
    }[] = [];
    globalThis.fetch = vi
      .fn()
      .mockImplementation(
        async (
          url: string | URL | Request,
          options?: RequestInit & { cf?: { cacheEverything?: boolean; cacheTtl?: number } },
        ) => {
          fetchCalls.push({
            url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
            options,
          });
          return new Response('{"fromCdn":true}', { status: 200 });
        },
      ) as unknown as typeof fetch;

    const env = {
      DICTIONARY: source,
      DICTIONARY_BASE_URL: "https://r2-dictionary.moedict.tw",
      DICTIONARY_PUBLIC_READS: "1",
    };

    const text = await fetchDictionaryObjectText(env, "a/index.json");
    expect(text).toBe('{"fromCdn":true}');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(
      `https://r2-dictionary.moedict.tw/a/index.json?v=${TEST_DIGEST}`,
    );
    expect(fetchCalls[0].options?.cf).toEqual({
      cacheEverything: true,
      cacheTtl: 86400,
    });
    expect(source.getCalls).toEqual([DICTIONARY_CORPUS_POINTER_KEY]);
  });

  it("HTTP 404 -> returns null without touching binding for the object key", async () => {
    const source = makeSource({
      [DICTIONARY_CORPUS_POINTER_KEY]: validPointer(TEST_DIGEST),
      "a/absent.json": '{"fromBinding":true}',
    });
    const fetchCalls: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      fetchCalls.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    const env = {
      DICTIONARY: source,
      DICTIONARY_BASE_URL: "https://r2-dictionary.moedict.tw",
      DICTIONARY_PUBLIC_READS: "1",
    };

    const text = await fetchDictionaryObjectText(env, "a/absent.json");
    expect(text).toBeNull();
    expect(fetchCalls).toHaveLength(1);
    expect(source.getCalls).toEqual([DICTIONARY_CORPUS_POINTER_KEY]);
  });

  it("HTTP 500 -> falls back to the binding and returns binding bytes", async () => {
    const source = makeSource({
      [DICTIONARY_CORPUS_POINTER_KEY]: validPointer(TEST_DIGEST),
      "a/index.json": '{"fromBinding":true}',
    });
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return new Response("Internal Server Error", { status: 500 });
    }) as unknown as typeof fetch;

    const env = {
      DICTIONARY: source,
      DICTIONARY_BASE_URL: "https://r2-dictionary.moedict.tw",
      DICTIONARY_PUBLIC_READS: "1",
    };

    const text = await fetchDictionaryObjectText(env, "a/index.json");
    expect(text).toBe('{"fromBinding":true}');
    expect(source.getCalls).toEqual([DICTIONARY_CORPUS_POINTER_KEY, "a/index.json"]);
  });

  it("fetch throwing -> falls back to the binding", async () => {
    const source = makeSource({
      [DICTIONARY_CORPUS_POINTER_KEY]: validPointer(TEST_DIGEST),
      "a/index.json": '{"fromBinding":true}',
    });
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      throw new TypeError("Network failure");
    }) as unknown as typeof fetch;

    const env = {
      DICTIONARY: source,
      DICTIONARY_BASE_URL: "https://r2-dictionary.moedict.tw",
      DICTIONARY_PUBLIC_READS: "1",
    };

    const text = await fetchDictionaryObjectText(env, "a/index.json");
    expect(text).toBe('{"fromBinding":true}');
    expect(source.getCalls).toEqual([DICTIONARY_CORPUS_POINTER_KEY, "a/index.json"]);
  });

  it("missing DICTIONARY_BASE_URL -> binding only, zero fetches", async () => {
    const source = makeSource({
      "a/index.json": '{"fromBinding":true}',
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const env = {
      DICTIONARY: source,
      DICTIONARY_BASE_URL: "",
      DICTIONARY_PUBLIC_READS: "1",
    };

    const text = await fetchDictionaryObjectText(env, "a/index.json");
    expect(text).toBe('{"fromBinding":true}');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(source.getCalls).toEqual(["a/index.json"]);
  });

  it("pointer state error -> binding only, zero fetches", async () => {
    const source = makeSource({
      [DICTIONARY_CORPUS_POINTER_KEY]: "invalid-json-pointer",
      "a/index.json": '{"fromBinding":true}',
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const env = {
      DICTIONARY: source,
      DICTIONARY_BASE_URL: "https://r2-dictionary.moedict.tw",
      DICTIONARY_PUBLIC_READS: "1",
    };

    const text = await fetchDictionaryObjectText(env, "a/index.json");
    expect(text).toBe('{"fromBinding":true}');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(source.getCalls).toEqual([DICTIONARY_CORPUS_POINTER_KEY, "a/index.json"]);
  });

  it("base URL set but DICTIONARY_PUBLIC_READS unset -> binding only, zero fetches (staging isolation guard)", async () => {
    // staging binds moedict-dictionary-preview yet still advertises the
    // PRODUCTION r2-dictionary.moedict.tw for /api/config. Gating on the base
    // URL alone would make staging silently serve production dictionary bytes.
    const source = makeSource({
      [DICTIONARY_CORPUS_POINTER_KEY]: validPointer(TEST_DIGEST),
      "a/index.json": '{"fromBinding":true}',
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const env = {
      DICTIONARY: source,
      DICTIONARY_BASE_URL: "https://r2-dictionary.moedict.tw",
    };

    const text = await fetchDictionaryObjectText(env, "a/index.json");
    expect(text).toBe('{"fromBinding":true}');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(source.getCalls).toEqual(["a/index.json"]);
  });

  it("knownDigest passed as string -> uses it without pointer read", async () => {
    const source = makeSource({
      "a/index.json": '{"fromBinding":true}',
    });
    const fetchSpy = vi.fn(async () => new Response('{"fromCdn":true}', { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const env = {
      DICTIONARY: source,
      DICTIONARY_BASE_URL: "https://r2-dictionary.moedict.tw",
      DICTIONARY_PUBLIC_READS: "1",
    };

    const text = await fetchDictionaryObjectText(env, "a/index.json", "customdigest");
    expect(text).toBe('{"fromCdn":true}');
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://r2-dictionary.moedict.tw/a/index.json?v=customdigest",
      expect.objectContaining({ cf: { cacheEverything: true, cacheTtl: 86400 } }),
    );
    expect(source.getCalls).toEqual([]);
  });

  it("knownDigest passed as null -> immediately falls back to binding without fetch or pointer read", async () => {
    const source = makeSource({
      "a/index.json": '{"fromBinding":true}',
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const env = {
      DICTIONARY: source,
      DICTIONARY_BASE_URL: "https://r2-dictionary.moedict.tw",
      DICTIONARY_PUBLIC_READS: "1",
    };

    const text = await fetchDictionaryObjectText(env, "a/index.json", null);
    expect(text).toBe('{"fromBinding":true}');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(source.getCalls).toEqual(["a/index.json"]);
  });

  it("returns null when env.DICTIONARY is undefined", async () => {
    const env = {} as unknown as Parameters<typeof fetchDictionaryObjectText>[0];
    const text = await fetchDictionaryObjectText(env, "a/index.json");
    expect(text).toBeNull();
  });
});
