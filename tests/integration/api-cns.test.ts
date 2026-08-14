/**
 * Integration tests for GET/HEAD /api/cns/{char}.json
 *
 * Uses the golden 䴉 (U+4D09, CNS 4-6C51) fixture seeded in tests/helpers/fixtures.ts.
 * Verifies API contract: 200/HEAD/CORS/Cache-Tag/ETag, invalid input 400, 404, 405,
 * and that existing dictionary routes (/c/䴉, /t/䴉, /uni/䴉) are unaffected.
 *
 * Contract invariant: CNS Cache-Tag must be "cns,cns-record" — not "dict,dict-a"
 * (the resolveDictCacheTags default-a fallback must not pollute dict-a purge scope).
 */

import { describe, expect, it } from "vite-plus/test";
import { fetchFromServer, fetchJson } from "./_harness";

const IBIS = "䴉"; // U+4D09
const IBIS_ENCODED = encodeURIComponent(IBIS); // %E4%B4%89

describe("GET /api/cns/{char}.json — 200 golden 䴉", () => {
  it("returns 200 with correct JSON for 䴉", async () => {
    const { status, body } = await fetchJson<Record<string, unknown>>(
      `/api/cns/${IBIS_ENCODED}.json`,
    );
    expect(status).toBe(200);
    expect(body.char).toBe(IBIS);
    expect(body.unicode).toBe("U+4D09");
    expect(body.cns).toBe("4-6C51");
    expect(body.pua).toBe(false);
  });

  it("phonetic ㄒㄩㄢˊ", async () => {
    const { body } = await fetchJson<Record<string, unknown>>(`/api/cns/${IBIS_ENCODED}.json`);
    const attrs = body.attributes as Record<string, unknown>;
    expect(Array.isArray(attrs.phonetic)).toBe(true);
    expect((attrs.phonetic as string[]).includes("ㄒㄩㄢˊ")).toBe(true);
  });

  it("radical 196 鳥, stroke 24, cangjie WVHAF", async () => {
    const { body } = await fetchJson<Record<string, unknown>>(`/api/cns/${IBIS_ENCODED}.json`);
    const attrs = body.attributes as Record<string, unknown>;
    const radical = attrs.radical as Record<string, unknown>;
    expect(radical.id).toBe(196);
    expect(radical.char).toBe("鳥");
    expect(attrs.stroke).toBe(24);
    expect(Array.isArray(attrs.cangjie)).toBe(true);
    expect((attrs.cangjie as string[])[0]).toBe("WVHAF");
  });

  it("strokeSequence 252211251353432511154444", async () => {
    const { body } = await fetchJson<Record<string, unknown>>(`/api/cns/${IBIS_ENCODED}.json`);
    const attrs = body.attributes as Record<string, unknown>;
    expect(attrs.strokeSequence).toBe("252211251353432511154444");
  });

  it("returns CORS Access-Control-Allow-Origin: *", async () => {
    const res = await fetchFromServer(`/api/cns/${IBIS_ENCODED}.json`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("Cache-Tag is cns,cns-record (never dict-a)", async () => {
    const res = await fetchFromServer(`/api/cns/${IBIS_ENCODED}.json`);
    const tag = res.headers.get("cache-tag") ?? "";
    expect(tag).toContain("cns");
    expect(tag).toContain("cns-record");
    expect(tag).not.toContain("dict-a");
    expect(tag).not.toContain("dict,");
  });

  it("Cache-Control has browser max-age and CDN bypass headers (s-maxage stripped on outgoing response)", async () => {
    const res = await fetchFromServer(`/api/cns/${IBIS_ENCODED}.json`);
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("max-age=300");
    expect(cc).not.toContain("s-maxage");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
  });

  it("Content-Type is application/json", async () => {
    const res = await fetchFromServer(`/api/cns/${IBIS_ENCODED}.json`);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
  });
});

describe("HEAD /api/cns/{char}.json", () => {
  it("returns 200 with same headers, empty body", async () => {
    const res = await fetchFromServer(`/api/cns/${IBIS_ENCODED}.json`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    expect(res.headers.get("cache-control") ?? "").toContain("max-age=300");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    // Body must be null/empty for HEAD
    const text = await res.text();
    expect(text).toBe("");
  });

  it("returns 304 for GET with matching If-None-Match", async () => {
    const first = await fetchFromServer(`/api/cns/${IBIS_ENCODED}.json`);
    const etag = first.headers.get("etag")!;
    const res = await fetchFromServer(`/api/cns/${IBIS_ENCODED}.json`, {
      headers: { "If-None-Match": etag },
    });
    expect(res.status).toBe(304);
    const text = await res.text();
    expect(text).toBe("");
  });

  it("returns 304 for HEAD with matching If-None-Match", async () => {
    const first = await fetchFromServer(`/api/cns/${IBIS_ENCODED}.json`);
    const etag = first.headers.get("etag")!;
    const res = await fetchFromServer(`/api/cns/${IBIS_ENCODED}.json`, {
      method: "HEAD",
      headers: { "If-None-Match": etag },
    });
    expect(res.status).toBe(304);
    const text = await res.text();
    expect(text).toBe("");
    expect(res.headers.get("etag")).toBe(etag);
  });
});

describe("GET /api/cns/{char}.json — invalid input 400", () => {
  it("rejects malformed percent-encoding", async () => {
    const res = await fetchFromServer("/api/cns/%E0%A4%A.json");
    expect(res.status).toBe(400);
  });

  it("rejects multi-scalar input", async () => {
    const res = await fetchFromServer(`/api/cns/${encodeURIComponent("䴉一")}.json`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Bad Request");
  });

  it("rejects path traversal attempts", async () => {
    const res = await fetchFromServer("/api/cns/..%2Fx.json");
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
  });

  it("rejects empty segment", async () => {
    const res = await fetchFromServer("/api/cns/.json");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/cns/{char}.json — 405 Method Not Allowed", () => {
  it("rejects POST", async () => {
    const res = await fetchFromServer(`/api/cns/${IBIS_ENCODED}.json`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("rejects DELETE", async () => {
    const res = await fetchFromServer(`/api/cns/${IBIS_ENCODED}.json`, { method: "DELETE" });
    expect(res.status).toBe(405);
  });
});

describe("GET /api/cns/{char}.json — 404 not in dataset", () => {
  it("returns 404 for a char with no CNS fixture", async () => {
    // 互 (U+4E92) is a common char not in CNS fixture set
    const res = await fetchFromServer(`/api/cns/${encodeURIComponent("互")}.json`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Not Found");
  });
});

describe("Dictionary-hit non-shadowing contract", () => {
  // 䴉 (U+4D09) is present in BOTH:
  //   - pcck/9.txt (兩岸辭典 bucket 9, seeded in fixtures)
  //   - cns/by-codepoint/4D/4D09.json (CNS golden fixture)
  // The invariant: the two payloads coexist and are DIFFERENT —
  // CNS does NOT shadow the dictionary route.
  //
  // Note: /c/ sub-route returns raw pack format (compressed keys).
  // Pack key "h" = heteronyms array; "t" = title; "n" = stroke_count.
  // CNS payload uses "attributes"/"provenance"/"pua" — mutually exclusive shapes.

  it("/c/䴉.json returns 200 with a dictionary payload (pack h field), NOT a CNS payload", async () => {
    const { status, body } = await fetchJson<Record<string, unknown>>(`/c/${IBIS_ENCODED}.json`);
    // Must be a real dictionary 200
    expect(status).toBe(200);
    // Dictionary payload: pack uses compressed key "h" for heteronyms array
    expect(Array.isArray(body.h)).toBe(true);
    expect((body.h as unknown[]).length).toBeGreaterThan(0);
    // Title field "t" must be the character itself
    expect(body.t).toBe(IBIS);
    // Must NOT be a CNS attributes payload
    expect(body.attributes).toBeUndefined();
    expect(body.pua).toBeUndefined();
    expect(body.provenance).toBeUndefined();
  });

  it("/api/cns/䴉.json returns 200 with a CNS payload (attributes/provenance/pua), NOT a dict payload", async () => {
    const { status, body } = await fetchJson<Record<string, unknown>>(
      `/api/cns/${IBIS_ENCODED}.json`,
    );
    expect(status).toBe(200);
    // CNS payload has attributes.phonetic and provenance
    const attrs = body.attributes as Record<string, unknown> | undefined;
    expect(attrs).toBeDefined();
    expect(Array.isArray(attrs?.phonetic)).toBe(true);
    expect(body.pua).toBe(false);
    expect(body.provenance).toBeDefined();
    // Must NOT be a dictionary payload — neither pack key "h" nor decoded "heteronyms"
    expect(body.h).toBeUndefined();
    expect(body.heteronyms).toBeUndefined();
  });

  it("both coexist: same char 䴉 returns different payloads from /c/ vs /api/cns/", async () => {
    const [dictResult, cnsResult] = await Promise.all([
      fetchJson<Record<string, unknown>>(`/c/${IBIS_ENCODED}.json`),
      fetchJson<Record<string, unknown>>(`/api/cns/${IBIS_ENCODED}.json`),
    ]);
    // Both are 200
    expect(dictResult.status).toBe(200);
    expect(cnsResult.status).toBe(200);
    // Dict has pack key "h" (heteronyms); CNS has "attributes" — mutually exclusive shapes
    expect(Array.isArray(dictResult.body.h)).toBe(true);
    expect(dictResult.body.attributes).toBeUndefined();
    expect(
      (cnsResult.body.attributes as Record<string, unknown> | undefined)?.phonetic,
    ).toBeDefined();
    expect(cnsResult.body.h).toBeUndefined();
  });

  it("/t/䴉.json returns 404 (no Taiwanese fixture seeded)", async () => {
    const res = await fetchFromServer(`/t/${IBIS_ENCODED}.json`);
    expect(res.status).toBe(404);
  });

  it("/uni/䴉.json returns 404", async () => {
    const res = await fetchFromServer(`/uni/${IBIS_ENCODED}.json`);
    expect(res.status).toBe(404);
  });
});
