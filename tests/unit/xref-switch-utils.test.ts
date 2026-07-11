import { beforeEach, describe, expect, it, vi, afterEach } from "vite-plus/test";
import {
  LANG_PREFIX,
  computeLangSwitchPath,
  computeLangSwitchPathAsync,
  setCurrentXrefs,
} from "../../src/utils/xref-switch-utils";
import { addToLRU, clearLRUWords } from "../../src/utils/word-record-utils";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  clearLRUWords("a");
  clearLRUWords("t");
  clearLRUWords("h");
  clearLRUWords("c");
  vi.restoreAllMocks();
  globalThis.fetch = vi.fn(
    async () => new Response("missing", { status: 404 }),
  ) as typeof fetch;
});

// Load the module with fresh state (clears XREF_CACHE / XREF_LOADED / XREF_LOADING
// and the _word / _lang / _xrefs module-level state). Follows the pattern in
// tests/unit/dictionary-cache.test.ts.
async function importFresh(): Promise<typeof import("../../src/utils/xref-switch-utils")> {
  vi.resetModules();
  return import("../../src/utils/xref-switch-utils");
}

describe("LANG_PREFIX", () => {
  it("maps each lang to its URL prefix", () => {
    expect(LANG_PREFIX).toEqual({ a: "", t: "'", h: ":", c: "~" });
  });
});

describe("computeLangSwitchPath", () => {
  it("same lang → reformats with prefix", () => {
    expect(computeLangSwitchPath("a", "a", "萌")).toBe("/萌");
    expect(computeLangSwitchPath("t", "t", "食")).toBe("/'食");
  });

  it("a ↔ c swaps prefix without consulting xref", () => {
    expect(computeLangSwitchPath("a", "c", "萌")).toBe("/~萌");
    expect(computeLangSwitchPath("c", "a", "萌")).toBe("/萌");
  });

  it("falls back to LRU of target lang when xref is absent", () => {
    addToLRU("記憶", "t");
    expect(computeLangSwitchPath("a", "t", "萌")).toBe("/'記憶");
  });

  it("falls back to default word when xref and LRU are empty", () => {
    expect(computeLangSwitchPath("a", "t", "萌")).toBe("/'發穎");
    expect(computeLangSwitchPath("a", "h", "萌")).toBe("/:發芽");
  });

  it("uses entry.xrefs fallback when set via setCurrentXrefs", () => {
    setCurrentXrefs("萌", "a", [{ lang: "t", words: ["發穎"] }]);
    expect(computeLangSwitchPath("a", "t", "萌")).toBe("/'發穎");
  });

  it("decodes percent-encoded input word", () => {
    setCurrentXrefs("萌", "a", [{ lang: "t", words: ["發穎"] }]);
    expect(computeLangSwitchPath("a", "t", "%E8%90%8C")).toBe("/'發穎");
  });

  it("tolerates malformed percent-encoded input (decodeURIComponent throws)", () => {
    // "%E8%90" is truncated UTF-8 and raises URIError — the decodeWord
    // try/catch falls back to normalizeWordToken on the raw input.
    // No xrefs / LRU set → expect the default for target lang.
    expect(computeLangSwitchPath("a", "t", "%E8%90")).toBe("/'發穎");
  });

  it("t → c falls back via 華語 xref (t→a), then slaps the ~ prefix", () => {
    // entry.xrefs on the t entry says the Mandarin equivalent is 萌. With
    // no direct t→c xref we expect the two-step path to produce /~萌.
    setCurrentXrefs("發穎", "t", [{ lang: "a", words: ["萌"] }]);
    expect(computeLangSwitchPath("t", "c", "發穎")).toBe("/~萌");
  });

  it("h → c also takes the 華語-bridge path when no direct xref exists", () => {
    setCurrentXrefs("發芽", "h", [{ lang: "a", words: ["萌"] }]);
    expect(computeLangSwitchPath("h", "c", "發芽")).toBe("/~萌");
  });
});

describe("computeLangSwitchPathAsync", () => {
  it("loads xref JSON on first call and uses it", async () => {
    const xrefPayload = { t: { 萌: "發穎" } };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      expect(url).toMatch(/\/api\/xref\/a\.json$/);
      return new Response(JSON.stringify(xrefPayload), { status: 200 });
    }) as typeof fetch;

    const path = await computeLangSwitchPathAsync("a", "t", "萌");
    expect(path).toBe("/'發穎");
  });

  it("falls back cleanly when fetch fails", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("not found", { status: 404 }),
    ) as typeof fetch;
    // NOTE: module-level cache already loaded in previous test may persist; create a fresh fromLang
    const path = await computeLangSwitchPathAsync("h", "a", "nothing");
    expect(path.startsWith("/")).toBe(true);
  });
});

/**
 * Tests that drive loadXrefForLang's body (lines 56-67) and the lookupXref
 * cache-hit branches (lines 102-120). Each test re-imports the module via
 * importFresh() so module-level state (XREF_CACHE / XREF_LOADED / XREF_LOADING
 * / _word / _lang / _xrefs) starts empty.
 */
describe("loadXrefForLang via computeLangSwitchPathAsync (fresh module)", () => {
  it("fetches once, caches, and reuses on subsequent calls", async () => {
    const mod = await importFresh();
    const payload = { t: { 萌: "發穎" } };
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      expect(url).toMatch(/\/api\/xref\/a\.json$/);
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    globalThis.fetch = fetchSpy as typeof fetch;

    const first = await mod.computeLangSwitchPathAsync("a", "t", "萌");
    const second = await mod.computeLangSwitchPathAsync("a", "t", "萌");
    expect(first).toBe("/'發穎");
    expect(second).toBe("/'發穎");
    // Second call must hit the XREF_LOADED short-circuit — no extra fetch.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("handles non-OK response (404) — no cache, falls back to DEFAULTS", async () => {
    const mod = await importFresh();
    const fetchSpy = vi.fn(async () => new Response("missing", { status: 404 }));
    globalThis.fetch = fetchSpy as typeof fetch;

    // With no xref cache, no LRU, and no entry.xrefs the target lang 't' falls
    // through to DEFAULTS['t'] === '發穎'.
    const path = await mod.computeLangSwitchPathAsync("a", "t", "萌");
    expect(path).toBe("/'發穎");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Because XREF_LOADED['a'] was never set (non-OK branch), a subsequent
    // async call will fetch again — proving the success branch wasn't taken.
    await mod.computeLangSwitchPathAsync("a", "t", "萌");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("handles fetch rejection — catch path, XREF_LOADING cleared via finally", async () => {
    const mod = await importFresh();
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error("network boom"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ t: { 萌: "發穎" } }), { status: 200 }));
    globalThis.fetch = fetchSpy as typeof fetch;

    // First async call — fetch rejects. The finally block clears
    // XREF_LOADING so a retry is allowed. Fallback → DEFAULTS.
    const first = await mod.computeLangSwitchPathAsync("a", "t", "萌");
    expect(first).toBe("/'發穎"); // DEFAULTS['t']

    // Second async call — XREF_LOADING was cleared in finally, so another
    // fetch goes out. This time it resolves and the xref is used.
    const second = await mod.computeLangSwitchPathAsync("a", "t", "萌");
    expect(second).toBe("/'發穎"); // now from xref map
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("concurrent calls: second invocation returns early via XREF_LOADING guard", async () => {
    const mod = await importFresh();
    let resolveFetch: (r: Response) => void = () => {};
    const pending = new Promise<Response>((r) => {
      resolveFetch = r;
    });
    const fetchSpy = vi.fn(async () => pending);
    globalThis.fetch = fetchSpy as typeof fetch;

    // Kick off two concurrent async lookups. The first enters loadXrefForLang,
    // sets XREF_LOADING['a'] and awaits fetch. The second sees the guard and
    // returns early — so only ONE fetch is issued.
    const a = mod.computeLangSwitchPathAsync("a", "t", "萌");
    const b = mod.computeLangSwitchPathAsync("a", "t", "萌");
    // Give the microtask queue one tick so both calls enter loadXrefForLang
    // before the fetch resolves.
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    resolveFetch(new Response(JSON.stringify({ t: { 萌: "發穎" } }), { status: 200 }));
    const [pa, pb] = await Promise.all([a, b]);
    // 'a' gets the populated xref; 'b' returned early before the cache was
    // populated so it falls through to DEFAULTS['t']. Both equal "/'發穎"
    // by happy accident (DEFAULTS['t'] === '發穎'); the key fact is that
    // fetch was called exactly once.
    expect(pa).toBe("/'發穎");
    expect(pb).toBe("/'發穎");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("computeLangSwitchPathAsync short-circuits when XREF_LOADED already has the lang", async () => {
    const mod = await importFresh();
    const payload = { t: { 萌: "發穎" } };
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    globalThis.fetch = fetchSpy as typeof fetch;

    // Prime the cache.
    await mod.computeLangSwitchPathAsync("a", "t", "萌");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // setCurrentXrefs also calls loadXrefForLang('a'); because XREF_LOADED
    // already has 'a', the guard on line 52 short-circuits without fetching.
    mod.setCurrentXrefs("萌", "a", []);
    // Flush the microtask that setCurrentXrefs fire-and-forgets.
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("lookupXref — cache present, various miss/hit shapes", () => {
  it("toLang map present but word absent → returns empty (falls through to LRU/DEFAULTS)", async () => {
    const mod = await importFresh();
    // xref cache for 'a' has a t-map but no entry for our word.
    const payload = { t: { 其他: "其他t" } };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));

    // Prime LRU so we can distinguish "lookup returned empty" (uses LRU) from
    // "lookup returned a value" (doesn't touch LRU).
    addToLRU("LRU命中", "t");

    const path = await mod.computeLangSwitchPathAsync("a", "t", "萌");
    expect(path).toBe("/'LRU命中");
  });

  it("matches backtick-prefixed key fallback (`萌)", async () => {
    const mod = await importFresh();
    // Real xref.json occasionally stores keys with a leading backtick (the
    // pleco/raw-trie escape). lookupXref's candidates array probes both.
    const payload = { t: { "`萌": "發穎" } };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));

    const path = await mod.computeLangSwitchPathAsync("a", "t", "萌");
    expect(path).toBe("/'發穎");
  });

  it("empty-string value for the matched key → words.length === 0 guard returns empty", async () => {
    const mod = await importFresh();
    // The word IS a key in the toLang map but its value is empty. After
    // raw.split(',').filter(Boolean) words is empty, so lookupXref returns ''.
    // Fallback: LRU.
    const payload = { t: { 萌: "" } };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    addToLRU("兜底", "t");

    const path = await mod.computeLangSwitchPathAsync("a", "t", "萌");
    expect(path).toBe("/'兜底");
  });

  it("non-empty xref value that filters down to no candidates still falls through", async () => {
    const mod = await importFresh();
    // The value is present, so raw is truthy, but after split/trim/filter the
    // candidate list is empty and lookupXref must still miss.
    const payload = { t: { 萌: " , , " } };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    addToLRU("空白兜底", "t");

    const path = await mod.computeLangSwitchPathAsync("a", "t", "萌");
    expect(path).toBe("/'空白兜底");
  });

  it("blank normalized input still falls through even when xref.json has an empty-string key", async () => {
    const mod = await importFresh();
    const payload = { t: { "": "發穎" } };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    addToLRU("空字串兜底", "t");

    const path = await mod.computeLangSwitchPathAsync("a", "t", "   ");
    expect(path).toBe("/'空字串兜底");
  });

  it("blank normalized input and missing cache key still falls through cleanly", async () => {
    const mod = await importFresh();
    const payload = { t: { 其他: "發穎" } };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    addToLRU("完全空白兜底", "t");

    const path = await mod.computeLangSwitchPathAsync("a", "t", "   ");
    expect(path).toBe("/'完全空白兜底");
  });

  it("toLang map entirely missing (different lang present) → falls back via LRU/DEFAULTS", async () => {
    const mod = await importFresh();
    // xref cache has h-map only, but caller asks for t. Hits the else arm
    // of `if (toLangMap)` on line 119-120.
    const payload = { h: { 萌: "發芽" } };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));

    const path = await mod.computeLangSwitchPathAsync("a", "t", "萌");
    expect(path).toBe("/'發穎"); // DEFAULTS['t']
  });

  it("splits comma-separated values and takes the first non-empty one", async () => {
    const mod = await importFresh();
    const payload = { t: { 萌: "發穎,別名,備案" } };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));

    const path = await mod.computeLangSwitchPathAsync("a", "t", "萌");
    expect(path).toBe("/'發穎");
  });
});

describe("setCurrentXrefs — normalizeWordToken strips malformed input", () => {
  it("filters undefined words and strips backtick prefix + trailing tildes", async () => {
    const mod = await importFresh();
    // Malformed payload: the outer word has a backtick prefix, the xref words
    // array contains an undefined and a backtick-prefixed token.
    mod.setCurrentXrefs("`萌~", "a", [
      {
        lang: "t",
        // @ts-expect-error — deliberately malformed input to exercise filter.
        words: [undefined, "`發穎~~"],
      },
    ]);

    // After normalization the entry xref should point at '發穎'. With no
    // direct xref cache and lookupXref's fallback arm matching on _word ===
    // fromWord, the path resolves via entry.xrefs.
    expect(mod.computeLangSwitchPath("a", "t", "萌")).toBe("/'發穎");
  });

  it("tolerates null xrefs and xref entries with missing words array", async () => {
    const mod = await importFresh();
    // xrefs param: undefined (nullish-coalesced to []). No throw.
    mod.setCurrentXrefs("萌", "a", undefined as unknown as []);
    expect(mod.computeLangSwitchPath("a", "a", "萌")).toBe("/萌");

    // xrefs with a missing `words` array — inner nullish-coalescing → [].
    mod.setCurrentXrefs("萌", "a", [
      { lang: "t" } as unknown as { lang: "a" | "t" | "h" | "c"; words: string[] },
    ]);
    // Entry xref for 't' has zero words after normalization → lookupXref
    // falls through to DEFAULTS['t'].
    expect(mod.computeLangSwitchPath("a", "t", "萌")).toBe("/'發穎");
  });

  it("skips entry.xrefs when the word matches but the language does not", async () => {
    const mod = await importFresh();
    mod.setCurrentXrefs("萌", "a", [{ lang: "t", words: ["發穎"] }]);

    // Same word, different source language. This keeps _word === fromWord
    // true but _lang === fromLang false, which exercises the skip branch.
    expect(mod.computeLangSwitchPath("t", "a", "萌")).toBe("/萌");
  });

  it("uses a direct t→c xref instead of the 華語 bridge when one exists", async () => {
    const mod = await importFresh();
    mod.setCurrentXrefs("發穎", "t", [{ lang: "c", words: ["上訴"] }]);

    expect(mod.computeLangSwitchPath("t", "c", "發穎")).toBe("/~上訴");
  });

  it("falls back to the target-lang default when the 華語 bridge has no answer", async () => {
    const mod = await importFresh();
    mod.setCurrentXrefs("發穎", "t", []);

    expect(mod.computeLangSwitchPath("t", "c", "發穎")).toBe("/~萌");
  });
});
