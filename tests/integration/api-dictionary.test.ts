import { describe, expect, it } from "vite-plus/test";
import { fetchFromServer, fetchJson } from "./_harness";

interface DictEntry {
  title?: string;
  heteronyms?: Array<{
    bopomofo?: string;
    bopomofo2?: string;
    id?: string;
    trs?: string;
    reading?: string;
    definitions?: Array<{ def?: string }>;
  }>;
  xrefs?: Array<{ lang: string; words: string[] }>;
  stroke_count?: number;
  radical?: string;
}

describe("/{word}.json — default lang (a)", () => {
  it("returns a populated entry for 萌", async () => {
    const { status, body } = await fetchJson<DictEntry>("/api/%E8%90%8C.json");
    expect(status).toBe(200);
    expect(body.title).toBeDefined();
    expect(body.heteronyms?.length).toBeGreaterThan(0);
    expect(body.heteronyms?.[0].definitions?.length).toBeGreaterThan(0);
    // xrefs key may be absent or populated — assert shape only if present
    if (body.xrefs) expect(Array.isArray(body.xrefs)).toBe(true);
  });

  it("404 with fuzzy terms for an unknown multi-char word", async () => {
    const { status, body } = await fetchJson<{ terms: string[] }>(
      "/api/%E4%B8%8D%E5%AD%98%E5%9C%A8.json",
    );
    expect(status).toBe(404);
    expect(Array.isArray(body.terms)).toBe(true);
    expect(body.terms.length).toBe(3); // 不 存 在 (single chars)
  });

  it("404 returns terms array even for single-char miss (split of the string)", async () => {
    const { status, body } = await fetchJson<{ error?: string; terms?: string[] }>("/api/xx.json");
    expect(status).toBe(404);
    // performFuzzySearch splits "xx" into ["x","x"] so body has terms, not error
    expect(body.terms).toBeDefined();
    expect(body.terms?.length).toBeGreaterThan(0);
  });

  it("short-circuits devtools / well-known probes with 404", async () => {
    const res = await fetchFromServer("/api/.well-known/foo.json");
    expect(res.status).toBe(404);
  });
});

describe("/{langPrefix}{word}.json", () => {
  it("'{word} → t lang", async () => {
    const { status, body } = await fetchJson<DictEntry>("/api/'%E9%A3%9F.json");
    expect(status).toBe(200);
    expect(body.title).toBeDefined();
  });

  it("preserves 蛇 siâ as a reading-only Taiwanese heteronym without an audio id", async () => {
    const { status, body } = await fetchJson<DictEntry>("/api/'%E8%9B%87.json");
    expect(status).toBe(200);
    const sia = body.heteronyms?.find((heteronym) => heteronym.trs?.normalize("NFC") === "siâ");
    expect(sia).toBeDefined();
    expect(sia?.definitions).toEqual([]);
    expect(sia?.reading?.replace(/<[^>]*>/g, "")).toBe("文");
    expect(sia?.id).toBeUndefined();
  });

  it("resolves 長褲 as the pinned no-definition Taiwanese entry (g0v/moedict-webkit#271)", async () => {
    const { status, body } = await fetchJson<DictEntry>("/api/'%E9%95%B7%E8%A4%B2.json");
    expect(status).toBe(200);
    // Multi-char lang=t titles resolve to per-character cross-reference
    // anchors on the default route (same as every other multi-char entry,
    // e.g. 管理 → `<a href="./#'管">管</a><a href="./#'理">理</a>`) — strip
    // tags to assert the resolved word while still proving the anchor shape
    // matches the established per-character convention.
    expect(body.title?.replace(/<[^>]*>/g, "")).toBe("長褲");
    expect(body.title).toBe(`<a href="./#'長">長</a><a href="./#'褲">褲</a>`);
    expect(body.heteronyms?.length).toBe(1);
    const heteronym = body.heteronyms?.[0];
    expect(heteronym?.trs?.normalize("NFC")).toBe("tn\u0302g-kho\u0300o".normalize("NFC"));
    expect(heteronym?.definitions).toEqual([]);
    expect(heteronym?.reading).toBeUndefined();
    expect(heteronym?.id).toBeUndefined();
  });

  it(":{word} → h lang", async () => {
    const { status, body } = await fetchJson<DictEntry>("/api/%3A%E5%AD%97.json");
    expect(status).toBe(200);
    expect(body.title).toBeDefined();
  });

  it("~{word} → c lang", async () => {
    const { status, body } = await fetchJson<DictEntry>("/api/~%E4%B8%8A%E8%A8%B4.json");
    expect(status).toBe(200);
    expect(body.title).toBeDefined();
  });
});

describe("/{lang}/{word}.json sub-routes (raw packed format)", () => {
  // The /{lang}/{word}.json sub-routes return the raw packed entry using compact keys
  // (t=title, h=heteronyms, b=bopomofo, d=definitions, f=def, ...). Presence of either
  // the compact or expanded key is acceptable — some buckets may already be expanded.
  function assertEntryShape(body: Record<string, unknown>) {
    const hasTitle = "t" in body || "title" in body;
    const hasHeteronyms = "h" in body || "heteronyms" in body;
    expect(hasTitle || hasHeteronyms).toBe(true);
  }

  it("/a/萌.json", async () => {
    const { status, body } = await fetchJson<Record<string, unknown>>("/a/%E8%90%8C.json");
    expect(status).toBe(200);
    assertEntryShape(body);
  });

  it("/t/食.json", async () => {
    const { status, body } = await fetchJson<Record<string, unknown>>("/t/%E9%A3%9F.json");
    expect(status).toBe(200);
    assertEntryShape(body);
  });

  it("/h/字.json", async () => {
    const { status, body } = await fetchJson<Record<string, unknown>>("/h/%E5%AD%97.json");
    expect(status).toBe(200);
    assertEntryShape(body);
  });

  it("/c/上訴.json", async () => {
    const { status, body } = await fetchJson<Record<string, unknown>>("/c/%E4%B8%8A%E8%A8%B4.json");
    expect(status).toBe(200);
    assertEntryShape(body);
  });

  it("/a/<unknown>.json returns 404", async () => {
    const { status } = await fetchJson("/a/zzzz.json");
    expect(status).toBe(404);
  });
});

describe("/raw, /uni, /pua sub-routes", () => {
  it("/raw/萌.json returns title + heteronyms", async () => {
    const { status, body } = await fetchJson<DictEntry>("/raw/%E8%90%8C.json");
    expect(status).toBe(200);
    expect(body.title).toBeDefined();
    expect(Array.isArray(body.heteronyms)).toBe(true);
  });

  it("/uni/萌.json returns IDS-normalised payload", async () => {
    const { status, body } = await fetchJson<DictEntry>("/uni/%E8%90%8C.json");
    expect(status).toBe(200);
    expect(body.title).toBeDefined();
  });

  it("/pua/萌.json returns PUA-codepoint payload", async () => {
    const { status, body } = await fetchJson<DictEntry>("/pua/%E8%90%8C.json");
    expect(status).toBe(200);
    expect(body.title).toBeDefined();
  });

  it("raw bopomofo2 field is populated if heteronym has bopomofo", async () => {
    const { body } = await fetchJson<DictEntry>("/raw/%E8%90%8C.json");
    const heteronym = body.heteronyms?.[0];
    if (heteronym?.bopomofo) {
      expect(heteronym.bopomofo2).toBeDefined();
    }
  });

  it("/raw/萌.json includes radical/stroke_count/non_radical_stroke_count (README.md documented shape)", async () => {
    const { status, body } = await fetchJson<DictEntry & { non_radical_stroke_count?: number }>(
      "/raw/%E8%90%8C.json",
    );
    expect(status).toBe(200);
    expect(body.radical).toBeDefined();
    expect(body.stroke_count).toBeDefined();
    expect(body.non_radical_stroke_count).toBeDefined();
  });
});

describe("bare-URL forms of the 7 legacy endpoints (no .json, README.md example shape)", () => {
  it.each(["a", "raw", "uni", "pua"])(
    "/%s/萌 (no .json) matches the .json form",
    async (prefix) => {
      const withoutJson = await fetchJson<DictEntry>(`/${prefix}/%E8%90%8C`);
      const withJson = await fetchJson<DictEntry>(`/${prefix}/%E8%90%8C.json`);
      expect(withoutJson.status).toBe(200);
      expect(withoutJson.body).toEqual(withJson.body);
    },
  );

  it("/t/食 and /c/上訴 (no .json) also resolve", async () => {
    const t = await fetchJson<Record<string, unknown>>("/t/%E9%A3%9F");
    expect(t.status).toBe(200);
    const c = await fetchJson<Record<string, unknown>>("/c/%E4%B8%8A%E8%A8%B4");
    expect(c.status).toBe(200);
  });
});

describe("/a/@radical.json (radical index pages)", () => {
  it("returns a 2D array (or {rowIdx: chars})", async () => {
    const res = await fetchFromServer("/a/%40%E5%AD%90.json");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body === null || typeof body === "object").toBe(true);
  });

  it("404 for unknown radical", async () => {
    const res = await fetchFromServer("/a/%40%E4%B8%8D%E5%AD%98.json");
    expect(res.status).toBe(404);
  });
});

describe("/t/@radical.json (g0v/moedict-webkit#122 台語部首表)", () => {
  it("returns a populated radical bucket for 子 via the /t/@radical.json sub-route", async () => {
    const res = await fetchFromServer("/t/%40%E5%AD%90.json");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toContain("子");
  });

  it("returns the same bucket via the top-level '@ prefixed token", async () => {
    const res = await fetchFromServer("/%27%40%E5%AD%90.json");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toContain("子");
  });

  it("404 for unknown radical", async () => {
    const res = await fetchFromServer("/t/%40%E4%B8%8D%E5%AD%98.json");
    expect(res.status).toBe(404);
  });
});

describe("/a/=<category>.json (list pages)", () => {
  it("returns a JSON array", async () => {
    const res = await fetchFromServer("/a/=%E8%BF%91%E7%BE%A9%E8%A9%9E.json");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("404 for unknown list", async () => {
    const res = await fetchFromServer("/a/=nothinghere.json");
    expect(res.status).toBe(404);
  });
});
