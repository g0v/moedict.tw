/**
 * Direct-call coverage for the Kangxi-Radicals NFKC compatibility fallback
 * added to `fillBucketWithCompatibilityFallback` (issue #214: searching the
 * literal Kangxi radical-block character ⼴ U+2F34 previously 404'd even
 * though it carries a canonical NFKC decomposition to 广 U+5E7F, which IS a
 * real MOE dictionary entry — the Kangxi radical-53 entry itself).
 *
 * Follows the `makeR2` / `makeRequest` stub pattern from
 * `tests/unit/api-handlers-direct.test.ts` /
 * `tests/unit/api-dictionary-raw-uni-pua.test.ts`.
 */

import { describe, expect, it } from "vite-plus/test";
import {
  bucketOf,
  handleDictionaryAPI,
  lookupDictionaryEntry,
} from "../../src/api/handleDictionaryAPI";

interface R2Stub {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

function makeR2(entries: Record<string, string>): R2Stub {
  return {
    async get(key) {
      const payload = entries[key];
      if (payload === undefined) return null;
      return { text: async () => payload };
    },
  };
}

function makeRequest(pathname: string): { request: Request; url: URL } {
  const url = new URL(`http://localhost${pathname}`);
  return { request: new Request(url.toString()), url };
}

function makeEnv(entries: Record<string, string>): { DICTIONARY: R2Stub } {
  return { DICTIONARY: makeR2(entries) };
}

// ⼴ U+2F34 KANGXI RADICAL YEN — literal radical-block character a user might
// paste from a Unicode radical chart or an IME's radical-input mode.
const RADICAL_YEN = "\u2F34";
// 广 U+5E7F — the CJK Unified Ideograph MOE actually keys the radical-53
// entry under. RADICAL_YEN.normalize("NFKC") === IDEOGRAPH_YAN.
const IDEOGRAPH_YAN = "\u5E7F";

const RADICAL_BUCKET = bucketOf(RADICAL_YEN, "a"); // '820'
const IDEOGRAPH_BUCKET = bucketOf(IDEOGRAPH_YAN, "a"); // '639'
const IDEOGRAPH_KEY = escape(IDEOGRAPH_YAN); // '%u5E7F'

function makeYanEntry(extra: Record<string, unknown> = {}) {
  return {
    t: "广",
    c: 3,
    r: "广",
    h: [{ b: "ㄧㄢˇ", p: "yǎn", d: [{ f: "二一四部首之一。" }] }],
    ...extra,
  };
}

describe("bucketOf sanity guard for ⼴ / 广", () => {
  it("lands the radical-block char and the CJK ideograph in DIFFERENT buckets", () => {
    // The whole point of the fallback: a naive same-bucket retry cannot work
    // because the two codepoints hash to different bucket files.
    expect(RADICAL_BUCKET).toBe("820");
    expect(IDEOGRAPH_BUCKET).toBe("639");
    expect(RADICAL_BUCKET).not.toBe(IDEOGRAPH_BUCKET);
  });

  it("confirms ⼴ NFKC-normalizes to 广 and 广 is already NFKC-idempotent", () => {
    expect(RADICAL_YEN.normalize("NFKC")).toBe(IDEOGRAPH_YAN);
    expect(IDEOGRAPH_YAN.normalize("NFKC")).toBe(IDEOGRAPH_YAN);
  });
});

describe("lookupDictionaryEntry — Kangxi radical-block fallback", () => {
  it("resolves ⼴ (U+2F34) to the 广 (U+5E7F) entry when only the ideograph bucket is seeded", async () => {
    const env = makeEnv({
      [`pack/${IDEOGRAPH_BUCKET}.txt`]: JSON.stringify({ [IDEOGRAPH_KEY]: makeYanEntry() }),
    });
    const result = await lookupDictionaryEntry(RADICAL_YEN, "a", env);
    expect(result).toBeTruthy();
    expect(result?.title).toBe("广");
    expect((result?.heteronyms as Array<{ bopomofo?: string }> | undefined)?.[0]?.bopomofo).toBe(
      "ㄧㄢˇ",
    );
  });

  it("still returns null when NEITHER the radical bucket NOR the normalized ideograph bucket has the word", async () => {
    const env = makeEnv({});
    expect(await lookupDictionaryEntry(RADICAL_YEN, "a", env)).toBeNull();
  });

  it("prefers an EXACT match over the NFKC fallback (no unnecessary normalization on a hit)", async () => {
    // Seed only the exact-match bucket for an NFKC-idempotent word (萌) —
    // this is the pre-existing happy path and must be untouched.
    const bucket = bucketOf("萌", "a");
    const key = escape("萌");
    const env = makeEnv({
      [`pack/${bucket}.txt`]: JSON.stringify({ [key]: { t: "萌", c: 12, r: "艸", h: [] } }),
    });
    const result = await lookupDictionaryEntry("萌", "a", env);
    expect(result?.title).toBe("萌");
  });

  it("resolves xrefs under the NORMALIZED key, not the literal radical-block key", async () => {
    const env = makeEnv({
      [`pack/${IDEOGRAPH_BUCKET}.txt`]: JSON.stringify({ [IDEOGRAPH_KEY]: makeYanEntry() }),
      "a/xref.json": JSON.stringify({ t: { [IDEOGRAPH_YAN]: ["yan-related"] } }),
    });
    const result = await lookupDictionaryEntry(RADICAL_YEN, "a", env);
    expect(result?.xrefs).toEqual([{ lang: "t", words: ["yan-related"] }]);
  });
});

describe("handleDictionaryAPI — /a/⼴.json and bare /⼴ sub-routes", () => {
  it("GET /a/%E2%BC%B4.json (⼴) resolves via the ideograph bucket, not a 404", async () => {
    const env = makeEnv({
      [`pack/${IDEOGRAPH_BUCKET}.txt`]: JSON.stringify({ [IDEOGRAPH_KEY]: makeYanEntry() }),
    });
    const { request, url } = makeRequest(`/a/${encodeURIComponent(RADICAL_YEN)}.json`);
    const res = await handleDictionaryAPI(request, url, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { t?: string };
    expect(body.t).toBe("广");
  });

  it("GET /a/%E2%BC%B4.json (⼴) still 404s with an empty terms list when the ideograph is also missing", async () => {
    const env = makeEnv({});
    const { request, url } = makeRequest(`/a/${encodeURIComponent(RADICAL_YEN)}.json`);
    const res = await handleDictionaryAPI(request, url, env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { terms?: string[] };
    expect(body.terms).toEqual([]);
  });

  it("GET /⼴ (bare SPA-style dictionary route) resolves via lookupDictionaryEntry's fallback", async () => {
    const env = makeEnv({
      [`pack/${IDEOGRAPH_BUCKET}.txt`]: JSON.stringify({ [IDEOGRAPH_KEY]: makeYanEntry() }),
    });
    const { request, url } = makeRequest(`/${encodeURIComponent(RADICAL_YEN)}`);
    const res = await handleDictionaryAPI(request, url, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title?: string };
    expect(body.title).toBe("广");
  });
});
