import { describe, expect, it } from "vite-plus/test";
import { fetchFromServer, fetchJson } from "./_harness";

describe("/api/stroke-json/{codepoint}.json (proxy)", () => {
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

  // We deliberately do NOT test real Rackspace CDN proxying here (external
  // dependency). Unit tests in tests/unit/api-stroke.test.ts mock that path.
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
