import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  escapeHtml,
  fetchJsonByToken,
  fetchRadicalRows,
  normalizeRadicalVariant,
  normalizeRows,
  normalizeTooltipId,
  stripTags,
  getTokenByLang,
} from "../../src/utils/radical-page-utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("escapeHtml", () => {
  it("escapes all five HTML-critical characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("coerces numbers and nullish to string", () => {
    expect(escapeHtml(42 as unknown as string)).toBe("42");
    expect(escapeHtml(null as unknown as string)).toBe("null");
  });
});

describe("stripTags", () => {
  it("removes HTML tags, keeps inner text", () => {
    expect(stripTags("<b>萌</b><i>典</i>")).toBe("萌典");
  });

  it("handles null/empty", () => {
    expect(stripTags("")).toBe("");
    expect(stripTags(null as unknown as string)).toBe("");
  });
});

describe("normalizeRadicalVariant", () => {
  it("maps 靑 → 青, passes everything else through", () => {
    expect(normalizeRadicalVariant("靑")).toBe("青");
    expect(normalizeRadicalVariant("青")).toBe("青");
    expect(normalizeRadicalVariant("木")).toBe("木");
  });
});

describe("getTokenByLang", () => {
  it("prefixes ~ for c lang, leaves a lang as-is", () => {
    expect(getTokenByLang("a", "@木")).toBe("@木");
    expect(getTokenByLang("c", "@木")).toBe("~@木");
  });
});

describe("normalizeRows", () => {
  it("returns [] for falsy input", () => {
    expect(normalizeRows(null)).toEqual([]);
    expect(normalizeRows(undefined)).toEqual([]);
    expect(normalizeRows(0)).toEqual([]);
  });

  it("accepts numeric-key object form", () => {
    expect(
      normalizeRows({
        0: ["木", "林"],
        1: ["森"],
      }),
    ).toEqual([["木", "林"], ["森"]]);
  });

  it("fills gaps with empty rows when keys are sparse", () => {
    expect(
      normalizeRows({
        0: ["a"],
        2: ["b"],
      }),
    ).toEqual([["a"], [], ["b"]]);
  });

  it("accepts array-of-arrays form", () => {
    expect(normalizeRows([["a"], ["b"]])).toEqual([["a"], ["b"]]);
  });

  it("handles mixed arrays with null rows", () => {
    expect(normalizeRows([["a"], null, ["b"]])).toEqual([["a"], [], ["b"]]);
  });

  it("treats a flat array as a single row", () => {
    expect(normalizeRows(["a", "b", "c"])).toEqual([["a", "b", "c"]]);
  });

  it("maps 靑 → 青 inside rows", () => {
    expect(normalizeRows([["靑", "青"]])).toEqual([["青", "青"]]);
  });

  it("drops falsy entries from rows", () => {
    expect(normalizeRows([["a", "", null as unknown as string, "b"]])).toEqual([["a", "b"]]);
  });

  it("returns [] on unexpected input (string)", () => {
    expect(normalizeRows("hello")).toEqual([]);
  });

  it("returns [] for objects without numeric keys", () => {
    expect(normalizeRows({ foo: ["a"], bar: "b" })).toEqual([]);
  });

  it("swallows row access errors and returns []", () => {
    const raw = Object.create(null);
    Object.defineProperty(raw, "0", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });

    expect(normalizeRows(raw)).toEqual([]);
  });
});

describe("normalizeTooltipId", () => {
  it("strips leading ./, /, #", () => {
    expect(normalizeTooltipId("./foo")).toBe("foo");
    expect(normalizeTooltipId("/bar")).toBe("bar");
    expect(normalizeTooltipId("#baz")).toBe("baz");
  });

  it("preserves known lang-prefix + strips backticks and trailing ~", () => {
    expect(normalizeTooltipId("'`萌~")).toBe("'萌");
    expect(normalizeTooltipId(":`萌~~")).toBe(":萌");
    expect(normalizeTooltipId("~`萌~")).toBe("~萌");
  });

  it("decodes percent-encoding safely", () => {
    expect(normalizeTooltipId("%E8%90%8C")).toBe("萌");
  });

  it("does not throw on malformed percent-encoding", () => {
    expect(normalizeTooltipId("%E8")).toBe("%E8");
  });

  it("coerces nullish tooltip IDs to an empty string", () => {
    expect(normalizeTooltipId(null as unknown as string)).toBe("");
  });
});

describe("fetchJsonByToken", () => {
  it("returns null for empty or whitespace-only tokens without fetching", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchJsonByToken("   ")).resolves.toBeNull();
    await expect(fetchJsonByToken(null as unknown as string)).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null when the response is not ok", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchJsonByToken("@木")).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledWith("/api/%40%E6%9C%A8.json", {
      headers: { Accept: "application/json" },
    });
  });

  it("fetches encoded tokens and returns parsed JSON", async () => {
    const payload = { title: "radical" };
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(payload),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchJsonByToken(" ~@木 ")).resolves.toEqual(payload);
    expect(fetchSpy).toHaveBeenCalledWith("/api/~%40%E6%9C%A8.json", {
      headers: { Accept: "application/json" },
    });
  });
});

describe("fetchRadicalRows", () => {
  it("delegates to the c-lang token helper and normalizes the fetched rows", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        0: ["靑", "木"],
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchRadicalRows("c", "@青")).resolves.toEqual([["青", "木"]]);
    expect(fetchSpy).toHaveBeenCalledWith("/api/~%40%E9%9D%92.json", {
      headers: { Accept: "application/json" },
    });
  });
});
