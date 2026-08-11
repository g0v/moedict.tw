/**
 * Unit tests for the per-R2-binding JSON memo (src/api/r2-json-cache.ts) and
 * its integration into the dictionary handler's bucket/xref reads.
 *
 * The memo exists to kill repeat R2 Class B GETs (2026-07 billing audit);
 * these tests defend the contracts that make it safe: WeakMap isolation per
 * binding, TTL-bounded staleness, LRU-bounded memory, negative caching,
 * digest-namespaced memo keys after pointer promotion, and error transparency.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  DICTIONARY_CORPUS_CACHE_TTL_MS,
  R2_JSON_CACHE_MAX_ENTRIES,
  R2_JSON_CACHE_TTL_MS,
  peekDictionaryCorpusDigest,
  readR2JsonCached,
  resolveDictionaryPointerState,
  type R2JsonSource,
} from "../../src/api/r2-json-cache";
import { DICTIONARY_CORPUS_POINTER_KEY } from "../../src/utils/dictionary-corpus";
import { handleDictionaryAPI } from "../../src/api/handleDictionaryAPI";

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

function validPointer(digest: string): string {
  return JSON.stringify({
    schema: 1,
    dictionaryDigest: digest,
    manifestKey: `dictionary-corpora/${digest}/manifest.json`,
    fileCount: 1,
    totalBytes: 1,
  });
}

describe("readR2JsonCached", () => {
  it("fetches once and serves repeats from the memo within the TTL", async () => {
    const source = makeSource({ "a/xref.json": '{"t":{}}' });
    const first = await readR2JsonCached(source, "a/xref.json");
    const second = await readR2JsonCached(source, "a/xref.json");
    expect(first).toEqual({ t: {} });
    expect(second).toEqual({ t: {} });
    // pointer peek (miss) once + object once
    expect(source.getCalls).toEqual([DICTIONARY_CORPUS_POINTER_KEY, "a/xref.json"]);
  });

  it("caches misses as null (repeat misses are billed too)", async () => {
    const source = makeSource({});
    expect(await readR2JsonCached(source, "absent.json")).toBeNull();
    expect(await readR2JsonCached(source, "absent.json")).toBeNull();
    expect(source.getCalls).toEqual([DICTIONARY_CORPUS_POINTER_KEY, "absent.json"]);
  });

  it("re-fetches after the TTL elapses", async () => {
    const source = makeSource({ "k.json": "1" });
    let clock = 0;
    const now = () => clock;
    expect(await readR2JsonCached(source, "k.json", now)).toBe(1);
    clock = R2_JSON_CACHE_TTL_MS - 1;
    expect(await readR2JsonCached(source, "k.json", now)).toBe(1);
    expect(source.getCalls.filter((k) => k === "k.json")).toHaveLength(1);
    clock = R2_JSON_CACHE_TTL_MS;
    expect(await readR2JsonCached(source, "k.json", now)).toBe(1);
    expect(source.getCalls.filter((k) => k === "k.json")).toHaveLength(2);
  });

  it("evicts the least-recently-used key beyond the cap, keeping refreshed keys", async () => {
    const objects: Record<string, string> = {};
    for (let i = 0; i <= R2_JSON_CACHE_MAX_ENTRIES; i++) objects[`k${i}.json`] = String(i);
    const source = makeSource(objects);
    for (let i = 0; i < R2_JSON_CACHE_MAX_ENTRIES; i++) {
      await readR2JsonCached(source, `k${i}.json`);
    }
    // Touch k0 so it becomes most-recent; adding one more must evict k1.
    await readR2JsonCached(source, "k0.json");
    await readR2JsonCached(source, `k${R2_JSON_CACHE_MAX_ENTRIES}.json`);
    const callsBefore = source.getCalls.filter((k) => k.startsWith("k")).length;
    await readR2JsonCached(source, "k0.json"); // still cached
    expect(source.getCalls.filter((k) => k.startsWith("k"))).toHaveLength(callsBefore);
    await readR2JsonCached(source, "k1.json"); // evicted → refetch
    expect(source.getCalls.filter((k) => k.startsWith("k"))).toHaveLength(callsBefore + 1);
  });

  it("isolates caches per binding object and propagates parse errors uncached", async () => {
    const a = makeSource({ "k.json": "1" });
    const b = makeSource({ "k.json": "2" });
    expect(await readR2JsonCached(a, "k.json")).toBe(1);
    expect(await readR2JsonCached(b, "k.json")).toBe(2);
    expect(a.getCalls.filter((k) => k === "k.json")).toHaveLength(1);
    expect(b.getCalls.filter((k) => k === "k.json")).toHaveLength(1);

    const broken = makeSource({ "k.json": "not-json" });
    await expect(readR2JsonCached(broken, "k.json")).rejects.toThrow();
    await expect(readR2JsonCached(broken, "k.json")).rejects.toThrow();
    expect(broken.getCalls.filter((k) => k === "k.json")).toHaveLength(2); // errors are not cached
  });

  it("namespaces pack memo by dictionary digest so pointer change cannot re-serve warm old bytes", async () => {
    const digestV1 = "a".repeat(64);
    const digestV2 = "b".repeat(64);

    let currentPointer = validPointer(digestV1);
    const packBodies: Record<string, string> = {
      "pack/0.txt": JSON.stringify({ old: true }),
    };
    const getCalls: string[] = [];
    const source: R2JsonSource & { getCalls: string[] } = {
      getCalls,
      get: async (key: string) => {
        getCalls.push(key);
        if (key === DICTIONARY_CORPUS_POINTER_KEY) {
          return { text: async () => currentPointer };
        }
        const body = packBodies[key];
        if (body === undefined) return null;
        return { text: async () => body };
      },
    };

    const first = await readR2JsonCached(source, "pack/0.txt");
    expect(first).toEqual({ old: true });

    // Promote pointer + replace pack bytes on the SAME binding (warm isolate).
    currentPointer = validPointer(digestV2);
    packBodies["pack/0.txt"] = JSON.stringify({ old: false, fresh: true });

    // Force pointer cache TTL expiry so the new digest is observed.
    const later = Date.now() + DICTIONARY_CORPUS_CACHE_TTL_MS + 1;
    const second = await readR2JsonCached(source, "pack/0.txt", () => later);
    expect(second).toEqual({ old: false, fresh: true });
  });
});

describe("resolveDictionaryPointerState", () => {
  it("distinguishes valid, missing, and error states", async () => {
    const digest = "c".repeat(64);
    const valid = makeSource({
      [DICTIONARY_CORPUS_POINTER_KEY]: validPointer(digest),
    });
    expect(await resolveDictionaryPointerState(valid)).toEqual({
      kind: "valid",
      digest,
    });
    expect(await peekDictionaryCorpusDigest(valid)).toBe(digest);

    const missing = makeSource({});
    expect(await resolveDictionaryPointerState(missing)).toEqual({ kind: "missing" });

    const badSchema = makeSource({
      [DICTIONARY_CORPUS_POINTER_KEY]: JSON.stringify({ schema: 1, dictionaryDigest: "short" }),
    });
    expect(await resolveDictionaryPointerState(badSchema)).toEqual({ kind: "error" });

    const unreadable = makeSource({ [DICTIONARY_CORPUS_POINTER_KEY]: "not-json" });
    expect(await resolveDictionaryPointerState(unreadable)).toEqual({ kind: "error" });
  });
});

describe("dictionary handler memoization", () => {
  // 萌 = U+840C → escape() key %u840C; bucketOf for lang "a" = 0x840c % 1024 = 12.
  const BUCKET_BODY = JSON.stringify({ "%u840C": { t: "萌", h: [{ d: [{ f: "義" }] }] } });

  function makeDictionaryEnv() {
    const source = makeSource({
      "pack/12.txt": BUCKET_BODY,
      "a/xref.json": "{}",
      "a/xref-by-id.json": "{}",
    });
    return { env: { DICTIONARY: source }, source };
  }

  it("reads bucket and xref sidecars from R2 once across repeated lookups", async () => {
    const { env, source } = makeDictionaryEnv();
    const url = new URL("http://localhost/api/%E8%90%8C.json");
    const first = await handleDictionaryAPI(new Request(url), url, env);
    expect(first?.status).toBe(200);
    const callsAfterFirst = [...source.getCalls];
    expect(callsAfterFirst).toContain("pack/12.txt");
    expect(callsAfterFirst).toContain("a/xref.json");
    expect(callsAfterFirst).toContain("a/xref-by-id.json");

    const second = await handleDictionaryAPI(new Request(url), url, env);
    expect(second?.status).toBe(200);
    expect(source.getCalls).toEqual(callsAfterFirst); // zero new R2 GETs
  });

  it("does not leak memo state across distinct DICTIONARY bindings", async () => {
    const first = makeDictionaryEnv();
    const url = new URL("http://localhost/api/%E8%90%8C.json");
    await handleDictionaryAPI(new Request(url), url, first.env);

    const second = makeDictionaryEnv();
    const res = await handleDictionaryAPI(new Request(url), url, second.env);
    expect(res?.status).toBe(200);
    expect(second.source.getCalls).toContain("pack/12.txt");
  });
});
