/**
 * Unit tests for handleCnsAPI — the Worker handler for GET/HEAD /api/cns/{char}.json
 *
 * Tests the state machine directly without Miniflare by providing a mock
 * R2 bucket. Golden character: 䴉 (U+4D09, CNS 4-6C51).
 */

import { describe, expect, it } from "vite-plus/test";
import { handleCnsAPI } from "../../src/api/handleCnsAPI";

// ── Minimal mock R2 env ──────────────────────────────────────────────────────

const IBIS_KEY = "cns/by-codepoint/4D/4D09.json";
const IBIS_RECORD = {
  char: "䴉",
  unicode: "U+4D09",
  codepoint: 19721,
  cns: "4-6C51",
  plane: 4,
  cell: "6C51",
  pua: false,
  attributes: {
    phonetic: ["ㄒㄩㄢˊ"],
    radical: { id: 196, char: "鳥" },
    stroke: 24,
    cangjie: ["WVHAF"],
    strokeSequence: "252211251353432511154444",
    source: "罕用國字標準字體表",
  },
  provenance: {
    generator: "scripts/generate-cns-data.mjs",
    sourceFiles: ["Properties.zip", "MapingTables.zip"],
    license: "OGDL-1.0",
    attribution: "數位發展部，CNS11643中文標準交換碼全字庫網站，https://www.cns11643.gov.tw",
  },
};

function makeMockEnv(records: Record<string, unknown> = {}) {
  return {
    DICTIONARY: {
      async get(key: string) {
        if (key in records) {
          const data = records[key];
          const text = JSON.stringify(data);
          return {
            async text() {
              return text;
            },
            httpEtag: `"mock-etag-${key}"`,
          };
        }
        return null;
      },
    },
  };
}

function makeRequest(path: string, method = "GET"): [Request, URL] {
  const url = new URL(`https://moedict.tw${path}`);
  return [new Request(url.href, { method }), url];
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("handleCnsAPI — GET 200", () => {
  it("returns 200 for 䴉 (%E4%B4%89)", async () => {
    const env = makeMockEnv({ [IBIS_KEY]: IBIS_RECORD });
    const [req, url] = makeRequest("/api/cns/%E4%B4%89.json");
    const res = await handleCnsAPI(req, url, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.char).toBe("䴉");
    expect(body.unicode).toBe("U+4D09");
    expect(body.cns).toBe("4-6C51");
  });

  it("phonetic includes ㄒㄩㄢˊ", async () => {
    const env = makeMockEnv({ [IBIS_KEY]: IBIS_RECORD });
    const [req, url] = makeRequest("/api/cns/%E4%B4%89.json");
    const res = await handleCnsAPI(req, url, env);
    const body = (await res.json()) as Record<string, unknown>;
    const attrs = body.attributes as Record<string, unknown>;
    expect((attrs.phonetic as string[])[0]).toBe("ㄒㄩㄢˊ");
  });

  it("Cache-Tag is cns,cns-record — never dict-a", async () => {
    const env = makeMockEnv({ [IBIS_KEY]: IBIS_RECORD });
    const [req, url] = makeRequest("/api/cns/%E4%B4%89.json");
    const res = await handleCnsAPI(req, url, env);
    const tag = res.headers.get("cache-tag") ?? "";
    expect(tag).toBe("cns,cns-record");
    expect(tag).not.toContain("dict");
  });

  it("Cache-Control s-maxage=86400 (dict policy)", async () => {
    const env = makeMockEnv({ [IBIS_KEY]: IBIS_RECORD });
    const [req, url] = makeRequest("/api/cns/%E4%B4%89.json");
    const res = await handleCnsAPI(req, url, env);
    expect(res.headers.get("cache-control") ?? "").toContain("s-maxage=86400");
  });

  it("CORS Access-Control-Allow-Origin: *", async () => {
    const env = makeMockEnv({ [IBIS_KEY]: IBIS_RECORD });
    const [req, url] = makeRequest("/api/cns/%E4%B4%89.json");
    const res = await handleCnsAPI(req, url, env);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("supports If-None-Match 304", async () => {
    const env = makeMockEnv({ [IBIS_KEY]: IBIS_RECORD });
    const etag = `"mock-etag-${IBIS_KEY}"`;
    const [req, url] = makeRequest("/api/cns/%E4%B4%89.json");
    const res = await handleCnsAPI(
      new Request(req.url, { headers: { "If-None-Match": etag } }),
      url,
      env,
    );
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("etag")).toBe(etag);
  });
  it("R2 ETag propagated when available", async () => {
    const env = makeMockEnv({ [IBIS_KEY]: IBIS_RECORD });
    const [req, url] = makeRequest("/api/cns/%E4%B4%89.json");
    const res = await handleCnsAPI(req, url, env);
    const etag = res.headers.get("etag") ?? "";
    expect(etag.length).toBeGreaterThan(0);
  });
});

describe("handleCnsAPI — HEAD 200", () => {
  it("HEAD returns 200 with empty body and same headers", async () => {
    const env = makeMockEnv({ [IBIS_KEY]: IBIS_RECORD });
    const [req, url] = makeRequest("/api/cns/%E4%B4%89.json", "HEAD");
    const res = await handleCnsAPI(req, url, env);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    expect(res.headers.get("cache-control") ?? "").toContain("s-maxage=86400");
  });

  it("supports If-None-Match 304", async () => {
    const env = makeMockEnv({ [IBIS_KEY]: IBIS_RECORD });
    const etag = `"mock-etag-${IBIS_KEY}"`;
    const [req, url] = makeRequest("/api/cns/%E4%B4%89.json", "HEAD");
    const res = await handleCnsAPI(
      new Request(req.url, { method: "HEAD", headers: { "If-None-Match": etag } }),
      url,
      env,
    );
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });
});

describe("handleCnsAPI — 400 invalid input", () => {
  it("rejects multi-scalar input 䴉一", async () => {
    const env = makeMockEnv({ [IBIS_KEY]: IBIS_RECORD });
    const encoded = encodeURIComponent("䴉一");
    const [req, url] = makeRequest(`/api/cns/${encoded}.json`);
    const res = await handleCnsAPI(req, url, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Bad Request");
  });

  it("rejects path traversal ../x", async () => {
    const env = makeMockEnv({});
    const [req, url] = makeRequest("/api/cns/..%2Fx.json");
    const res = await handleCnsAPI(req, url, env);
    expect(res.status).toBe(400);
  });

  it("rejects slash in decoded char", async () => {
    const env = makeMockEnv({});
    const [req, url] = makeRequest("/api/cns/%2F.json");
    const res = await handleCnsAPI(req, url, env);
    expect(res.status).toBe(400);
  });

  it("rejects empty segment", async () => {
    const env = makeMockEnv({});
    const [req, url] = makeRequest("/api/cns/.json");
    const res = await handleCnsAPI(req, url, env);
    expect(res.status).toBe(400);
  });
});

describe("handleCnsAPI — 404 not in dataset", () => {
  it("returns 404 when R2 key not found", async () => {
    const env = makeMockEnv({}); // empty store
    const [req, url] = makeRequest("/api/cns/%E5%8C%85.json"); // 包
    const res = await handleCnsAPI(req, url, env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Not Found");
    expect(typeof body.message).toBe("string");
  });
});

describe("handleCnsAPI — 405 Method Not Allowed", () => {
  it("rejects POST", async () => {
    const env = makeMockEnv({ [IBIS_KEY]: IBIS_RECORD });
    const [req, url] = makeRequest("/api/cns/%E4%B4%89.json", "POST");
    const res = await handleCnsAPI(req, url, env);
    expect(res.status).toBe(405);
  });

  it("rejects DELETE", async () => {
    const env = makeMockEnv({ [IBIS_KEY]: IBIS_RECORD });
    const [req, url] = makeRequest("/api/cns/%E4%B4%89.json", "DELETE");
    const res = await handleCnsAPI(req, url, env);
    expect(res.status).toBe(405);
  });

  it("rejects PATCH", async () => {
    const env = makeMockEnv({ [IBIS_KEY]: IBIS_RECORD });
    const [req, url] = makeRequest("/api/cns/%E4%B4%89.json", "PATCH");
    const res = await handleCnsAPI(req, url, env);
    expect(res.status).toBe(405);
  });
});

describe("handleCnsAPI — R2 key construction", () => {
  it("constructs key cns/by-codepoint/4D/4D09.json for 䴉 (U+4D09)", async () => {
    // Verify the correct key is used by seeding only that key
    const env = makeMockEnv({ [IBIS_KEY]: IBIS_RECORD });
    const [req, url] = makeRequest("/api/cns/%E4%B4%89.json");
    const res = await handleCnsAPI(req, url, env);
    expect(res.status).toBe(200); // proves the correct key was used
  });

  it("constructs key with 3-char shard for supplementary characters", async () => {
    // 𠀀 U+20000: hex=20000, shard=200
    const key = "cns/by-codepoint/200/20000.json";
    const record = {
      char: "𠀀",
      unicode: "U+20000",
      codepoint: 0x20000,
      cns: "2-2121",
      pua: false,
      attributes: { phonetic: [], stroke: 1 },
      provenance: {},
    };
    const env = makeMockEnv({ [key]: record });
    const [req, url] = makeRequest(`/api/cns/${encodeURIComponent("𠀀")}.json`);
    const res = await handleCnsAPI(req, url, env);
    expect(res.status).toBe(200);
  });
});

describe("handleCnsAPI — PUA characters return 404", () => {
  it("U+E000 (BMP PUA) returns 404 without R2 lookup", async () => {
    const puaChar = String.fromCodePoint(0xe000);
    const env = makeMockEnv({ [`cns/by-codepoint/E0/E000.json`]: { char: puaChar } });
    const [req, url] = makeRequest(`/api/cns/${encodeURIComponent(puaChar)}.json`);
    const res = await handleCnsAPI(req, url, env);
    // Phase 1: PUA → 404 without R2 lookup
    expect(res.status).toBe(404);
  });

  it("U+F0000 (PUA-A) returns 404", async () => {
    const puaChar = String.fromCodePoint(0xf0000);
    const env = makeMockEnv({});
    const [req, url] = makeRequest(`/api/cns/${encodeURIComponent(puaChar)}.json`);
    const res = await handleCnsAPI(req, url, env);
    expect(res.status).toBe(404);
  });
});
