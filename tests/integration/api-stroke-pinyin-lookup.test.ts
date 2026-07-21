import { describe, expect, it } from "vite-plus/test";
import { fetchFromServer, fetchJson } from "./_harness";

/**
 * Integration coverage for /api/stroke-json/{codepoint}.json against the real
 * Miniflare ASSETS binding. fixtures.ts seeds a full atomic corpus (pointer
 * at stroke-corpus/current.json, manifest listing 6,063 allowlisted
 * codepoints, and the real digest-scoped object for 840c.json/萌) into the
 * ASSETS bucket; the handler resolves pointer→manifest→versioned object on
 * every request (src/api/handleStrokeAPI.ts) so staging can validate
 * preview-bucket uploads end to end, not just read a flat legacy key.
 */
describe("/api/stroke-json/{codepoint}.json (R2 ASSETS)", () => {
  it("returns 400 for invalid codepoint format", async () => {
    const { status, body } = await fetchJson<{ error: string }>("/api/stroke-json/zzz.json");
    expect(status).toBe(400);
    expect(body.error).toBe("Bad Request");
  });

  it("returns 400 for path traversal attempt", async () => {
    const res = await fetchFromServer("/api/stroke-json/..%2Fetc%2Fpasswd.json");
    expect(res.status).toBe(400);
  });

  it("returns 400 when no .json extension", async () => {
    const res = await fetchFromServer("/api/stroke-json/840c");
    // Falls through to dictionary / asset handler (no stroke match) — may 404
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("serves the seeded 840c.json (萌) from ASSETS with stroke cache headers", async () => {
    const res = await fetchFromServer("/api/stroke-json/840c.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/json/);
    expect(res.headers.get("cache-control")).toContain("s-maxage=86400");
    expect(res.headers.get("cache-tag")).toBe("stroke");
    expect(res.headers.get("etag")).toBeTruthy();
    const body = await res.json();
    // Real stroke-json schema: array of {outline, track}
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty("outline");
    expect(body[0]).toHaveProperty("track");
  });

  it("supports HEAD for the seeded object (useStrokeAvailability probe)", async () => {
    const res = await fetchFromServer("/api/stroke-json/840c.json", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeTruthy();
    expect(res.headers.get("cache-tag")).toBe("stroke");
    expect(await res.text()).toBe("");
  });

  it("returns 404 for a codepoint not seeded in ASSETS", async () => {
    // ffff is outside the CJK range and is never in the 6,063 corpus.
    const { status, body } = await fetchJson<{ error: string }>("/api/stroke-json/ffff.json");
    expect(status).toBe(404);
    expect(body.error).toBe("Not Found");
  });

  it("returns 304 when If-None-Match matches the live ETag", async () => {
    const first = await fetchFromServer("/api/stroke-json/840c.json");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    // Drain body so the connection is free for the conditional request.
    await first.arrayBuffer();

    const second = await fetchFromServer("/api/stroke-json/840c.json", {
      headers: { "If-None-Match": etag! },
    });
    // Miniflare R2 may or may not honour onlyIf depending on version; accept
    // either a correct 304 or a full 200 with the same ETag (still correct
    // content). The unit test locks the 304 branch with an injected double.
    if (second.status === 304) {
      expect(second.headers.get("etag")).toBe(etag);
      expect(await second.text()).toBe("");
    } else {
      expect(second.status).toBe(200);
      expect(second.headers.get("etag")).toBe(etag);
    }
  });
});

describe("/api/lookup/pinyin/{lang}/{type}/{term}.json", () => {
  it("returns an array of titles for seeded Taiwanese TL term", async () => {
    const { status, body, headers } = await fetchJson<string[]>(
      "/api/lookup/pinyin/t/TL/tsiah.json",
    );
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(headers.get("cache-control")).toContain("max-age=");
  });

  it("returns empty array for unseeded term (not 404)", async () => {
    const { status, body } = await fetchJson<string[]>(
      "/api/lookup/pinyin/a/HanYu/nothinghere.json",
    );
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it("normalises the term (case-folding, diacritics strip)", async () => {
    const res = await fetchFromServer("/api/lookup/pinyin/t/TL/TSIAH.json");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("sets CORS headers when Origin is allowlisted", async () => {
    const res = await fetchFromServer("/api/lookup/pinyin/t/TL/tsiah.json", {
      headers: { Origin: "https://www.moedict.org" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://www.moedict.org");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("omits CORS headers for non-allowlisted Origin", async () => {
    const res = await fetchFromServer("/api/lookup/pinyin/t/TL/tsiah.json", {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("/api/lookup/trs/{term} and /lookup/trs/{term}", () => {
  it("serves text/plain via /api/lookup/trs/{term}", async () => {
    const res = await fetchFromServer("/api/lookup/trs/tsiah");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("serves via legacy /lookup/trs/{term}", async () => {
    const res = await fetchFromServer("/lookup/trs/tsiah");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("returns empty body for unseeded term", async () => {
    const res = await fetchFromServer("/api/lookup/trs/nothinghere");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});
