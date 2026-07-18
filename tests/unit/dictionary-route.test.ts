/**
 * Direct-call tests for src/utils/dictionary-route.ts — the shared
 * `'`/`:`/`~` language-prefix URL-scheme helpers used by worker/index.ts's
 * HTML-shell head injection and by the src/oembed/* handlers.
 *
 * Moved out of tests/unit/worker-helpers.test.ts when these functions were
 * extracted from worker/index.ts so the oEmbed feature could reuse them
 * without a worker → src/oembed → worker import cycle.
 */

import { describe, expect, it } from "vite-plus/test";
import {
  buildDefinitionDescription,
  buildDictionaryPathname,
  classifyRoute,
  parseDictionaryRoute,
  resolveLegacyHashRoute,
  stripLangPrefix,
  stripTags,
  tryDecodeURIComponent,
} from "../../src/utils/dictionary-route";

describe("stripTags", () => {
  it("coerces null/undefined to empty string", () => {
    expect(stripTags(null as unknown as string)).toBe("");
    expect(stripTags(undefined as unknown as string)).toBe("");
    expect(stripTags("" as string)).toBe("");
  });

  it("removes HTML tags and collapses whitespace", () => {
    expect(stripTags("<b>hello</b>  world")).toBe("hello world");
    expect(stripTags("  <p>line\n\nbreak</p>  ")).toBe("line break");
  });
});

describe("parseDictionaryRoute", () => {
  it("returns null for empty or slash-only paths", () => {
    expect(parseDictionaryRoute("/")).toBeNull();
    expect(parseDictionaryRoute("")).toBeNull();
    expect(parseDictionaryRoute("///")).toBeNull();
  });

  it('coerces falsy pathname via String(... || "")', () => {
    expect(parseDictionaryRoute(null as unknown as string)).toBeNull();
    expect(parseDictionaryRoute(undefined as unknown as string)).toBeNull();
  });

  it('returns null for about, radicals, lists, and "=*" meta routes', () => {
    expect(parseDictionaryRoute("/about")).toBeNull();
    expect(parseDictionaryRoute("/about.html")).toBeNull();
    expect(parseDictionaryRoute("/@部首")).toBeNull();
    expect(parseDictionaryRoute("/~@部首")).toBeNull();
    expect(parseDictionaryRoute("/'@部首")).toBeNull();
    expect(parseDictionaryRoute("/=成語")).toBeNull();
    expect(parseDictionaryRoute("/'=諺語")).toBeNull();
    expect(parseDictionaryRoute("/:=諺語")).toBeNull();
    expect(parseDictionaryRoute("/~=異名")).toBeNull();
    expect(parseDictionaryRoute("/'=*star")).toBeNull();
    expect(parseDictionaryRoute("/:=*star")).toBeNull();
    expect(parseDictionaryRoute("/~=*star")).toBeNull();
    expect(parseDictionaryRoute("/=*star")).toBeNull();
  });

  it("extracts lang and text from prefixed paths", () => {
    expect(parseDictionaryRoute("/'食")).toEqual({ lang: "t", text: "食" });
    expect(parseDictionaryRoute("/:字")).toEqual({ lang: "h", text: "字" });
    expect(parseDictionaryRoute("/~萌")).toEqual({ lang: "c", text: "萌" });
    expect(parseDictionaryRoute("/萌")).toEqual({ lang: "a", text: "萌" });
  });

  it("parses a trailing /<digits> as the legacy definition-index permalink (g0v/moedict.tw#131)", () => {
    expect(parseDictionaryRoute("/萌/2")).toEqual({ lang: "a", text: "萌", idx: 2 });
    expect(parseDictionaryRoute("/'食/1")).toEqual({ lang: "t", text: "食", idx: 1 });
    expect(parseDictionaryRoute("/:字/10")).toEqual({ lang: "h", text: "字", idx: 10 });
    expect(parseDictionaryRoute("/~萌/3")).toEqual({ lang: "c", text: "萌", idx: 3 });
  });

  it("idx is undefined (not present) when there is no trailing /<digits>", () => {
    const result = parseDictionaryRoute("/萌");
    expect(result?.idx).toBeUndefined();
  });

  it("still rejects non-word routes even with a trailing /<digits> — idx is ignored, not a bypass", () => {
    expect(parseDictionaryRoute("/about/2")).toBeNull();
    expect(parseDictionaryRoute("/@木/2")).toBeNull();
    expect(parseDictionaryRoute("/=成語/2")).toBeNull();
  });

  it("a word that is itself all-digits is not misparsed as text+idx (no separating slash)", () => {
    expect(parseDictionaryRoute("/123")).toEqual({ lang: "a", text: "123" });
  });

  it("decode-fails closed to null instead of throwing on malformed % escapes", () => {
    // A lone `%` (or any invalid percent-escape) makes decodeURIComponent
    // throw URIError. This path is reachable with fully attacker-supplied
    // input via the oEmbed `?url=` query parameter, so it must not 500.
    expect(parseDictionaryRoute("/%")).toBeNull();
    expect(parseDictionaryRoute("/%E8%90")).toBeNull();
    expect(parseDictionaryRoute("/'%")).toBeNull();
  });
});

describe("buildDefinitionDescription", () => {
  it("returns null when entry is null or has no heteronyms", () => {
    expect(buildDefinitionDescription(null)).toBeNull();
    expect(buildDefinitionDescription({})).toBeNull();
    expect(buildDefinitionDescription({ heteronyms: [] })).toBeNull();
  });

  it("skips heteronyms whose definitions is not an array", () => {
    const entry = {
      heteronyms: [
        { definitions: "not-an-array" as unknown as Array<{ def?: string }> },
        { definitions: [{ def: "有效定義" }] },
      ],
    };
    expect(buildDefinitionDescription(entry)).toBe("有效定義。");
  });

  it("treats missing/empty def as falsy and filters them out", () => {
    const entry = {
      heteronyms: [{ definitions: [{ def: "" }, { def: "實際定義" }, {}] }],
    };
    expect(buildDefinitionDescription(entry)).toBe("實際定義。");
  });

  it("returns null when every definition is empty after stripping", () => {
    const entry = {
      heteronyms: [{ definitions: [{ def: "<br>" }, { def: "   " }, { def: "" }] }],
    };
    expect(buildDefinitionDescription(entry)).toBeNull();
  });

  it("breaks after the 4th def in a single heteronym", () => {
    const entry = {
      heteronyms: [
        {
          definitions: [{ def: "一" }, { def: "二" }, { def: "三" }, { def: "四" }, { def: "五" }],
        },
      ],
    };
    expect(buildDefinitionDescription(entry)).toBe("一。二。三。四。");
  });

  it("breaks the outer heteronym loop once 4 defs accumulated", () => {
    const entry = {
      heteronyms: [
        { definitions: [{ def: "一" }, { def: "二" }] },
        { definitions: [{ def: "三" }, { def: "四" }] },
        { definitions: [{ def: "五" }] },
      ],
    };
    expect(buildDefinitionDescription(entry)).toBe("一。二。三。四。");
  });

  it("truncates sentences longer than 180 chars with an ellipsis", () => {
    const longDef = "あ".repeat(200);
    const entry = { heteronyms: [{ definitions: [{ def: longDef }] }] };
    const out = buildDefinitionDescription(entry);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(180);
    expect(out!.endsWith("…")).toBe(true);
  });

  it("short sentences pass through untruncated", () => {
    const entry = { heteronyms: [{ definitions: [{ def: "短定義" }] }] };
    expect(buildDefinitionDescription(entry)).toBe("短定義。");
  });
});

describe("buildDictionaryPathname", () => {
  it("is the inverse of parseDictionaryRoute for each lang prefix", () => {
    expect(buildDictionaryPathname("a", "萌")).toBe("/%E8%90%8C");
    expect(buildDictionaryPathname("t", "食")).toBe("/'%E9%A3%9F");
    expect(buildDictionaryPathname("h", "字")).toBe("/:%E5%AD%97");
    expect(buildDictionaryPathname("c", "萌")).toBe("/~%E8%90%8C");
    // Round-trips back through parseDictionaryRoute (which decodes).
    expect(parseDictionaryRoute(buildDictionaryPathname("t", "食"))).toEqual({
      lang: "t",
      text: "食",
    });
  });

  it("percent-encodes the word", () => {
    expect(buildDictionaryPathname("a", "a b")).toBe("/a%20b");
  });
});

describe("classifyRoute", () => {
  describe("default / home", () => {
    it("returns default for /", () => {
      expect(classifyRoute("/")).toEqual({ kind: "default" });
    });
    it("returns default for empty string", () => {
      expect(classifyRoute("")).toEqual({ kind: "default" });
    });
    it("returns default for slash-only paths", () => {
      expect(classifyRoute("///")).toEqual({ kind: "default" });
    });
    it("returns default for falsy pathname", () => {
      expect(classifyRoute(null as unknown as string)).toEqual({ kind: "default" });
      expect(classifyRoute(undefined as unknown as string)).toEqual({ kind: "default" });
    });
  });

  describe("about", () => {
    it("classifies /about", () => {
      expect(classifyRoute("/about")).toEqual({ kind: "about" });
    });
    it("classifies /about.html (legacy alias)", () => {
      expect(classifyRoute("/about.html")).toEqual({ kind: "about" });
    });
  });

  describe("radical", () => {
    it("classifies /@ as empty radical (a)", () => {
      expect(classifyRoute("/@")).toEqual({ kind: "radical", lang: "a", radical: "" });
    });
    it("classifies /~@ as empty radical (c)", () => {
      expect(classifyRoute("/~@")).toEqual({ kind: "radical", lang: "c", radical: "" });
    });
    it("classifies /@木 as radical a with 木", () => {
      expect(classifyRoute("/@木")).toEqual({ kind: "radical", lang: "a", radical: "木" });
    });
    it("classifies /~@水 as radical c with 水", () => {
      expect(classifyRoute("/~@水")).toEqual({ kind: "radical", lang: "c", radical: "水" });
    });
    it("decodes percent-encoded radical", () => {
      expect(classifyRoute("/@%E6%9C%A8")).toEqual({ kind: "radical", lang: "a", radical: "木" });
    });
    it("classifies /'@ as empty radical (t)", () => {
      expect(classifyRoute("/'@")).toEqual({ kind: "radical", lang: "t", radical: "" });
    });
    it("classifies /'@木 as radical t with 木", () => {
      expect(classifyRoute("/'@木")).toEqual({ kind: "radical", lang: "t", radical: "木" });
    });
  });

  describe("starred", () => {
    it("classifies /=* as starred (a)", () => {
      expect(classifyRoute("/=*")).toEqual({ kind: "starred", lang: "a", entry: "" });
    });
    it("classifies /'=* as starred (t)", () => {
      expect(classifyRoute("/'=*")).toEqual({ kind: "starred", lang: "t", entry: "" });
    });
    it("classifies /:=* as starred (h)", () => {
      expect(classifyRoute("/:=*")).toEqual({ kind: "starred", lang: "h", entry: "" });
    });
    it("classifies /~=* as starred (c)", () => {
      expect(classifyRoute("/~=*")).toEqual({ kind: "starred", lang: "c", entry: "" });
    });
  });

  describe("group", () => {
    it("classifies /=成語 as group (a)", () => {
      expect(classifyRoute("/=成語")).toEqual({ kind: "group", lang: "a", category: "成語" });
    });
    it("classifies /'=台諺語 as group (t)", () => {
      expect(classifyRoute("/'=台諺語")).toEqual({ kind: "group", lang: "t", category: "台諺語" });
    });
    it("classifies /:=諺語 as group (h)", () => {
      expect(classifyRoute("/:=諺語")).toEqual({ kind: "group", lang: "h", category: "諺語" });
    });
    it("classifies /~=成語 as group (c)", () => {
      expect(classifyRoute("/~=成語")).toEqual({ kind: "group", lang: "c", category: "成語" });
    });
    it("handles empty category (=)", () => {
      expect(classifyRoute("/=")).toEqual({ kind: "group", lang: "a", category: "" });
    });
    it("handles empty category (:=) for Hakka", () => {
      expect(classifyRoute("/:=")).toEqual({ kind: "group", lang: "h", category: "" });
    });
  });

  describe("entry", () => {
    it("classifies /萌 as entry (a)", () => {
      expect(classifyRoute("/萌")).toEqual({ kind: "entry", lang: "a", text: "萌" });
    });
    it("classifies /'食 as entry (t)", () => {
      expect(classifyRoute("/'食")).toEqual({ kind: "entry", lang: "t", text: "食" });
    });
    it("classifies /:字 as entry (h)", () => {
      expect(classifyRoute("/:字")).toEqual({ kind: "entry", lang: "h", text: "字" });
    });
    it("classifies /~萌 as entry (c)", () => {
      expect(classifyRoute("/~萌")).toEqual({ kind: "entry", lang: "c", text: "萌" });
    });
    it("decodes percent-encoded word", () => {
      expect(classifyRoute("/%E8%90%8C")).toEqual({ kind: "entry", lang: "a", text: "萌" });
    });
    it("parses trailing /<digits> as idx", () => {
      expect(classifyRoute("/萌/2")).toEqual({ kind: "entry", lang: "a", text: "萌", idx: 2 });
    });
    it("idx is undefined when no trailing /<digits>", () => {
      const route = classifyRoute("/萌");
      expect(route.kind).toBe("entry");
      if (route.kind === "entry") expect(route.idx).toBeUndefined();
    });
    it("a word that is itself all-digits is not misparsed as text+idx", () => {
      expect(classifyRoute("/123")).toEqual({ kind: "entry", lang: "a", text: "123" });
    });
  });

  describe("invalid-encoding", () => {
    it("returns invalid-encoding with raw string on malformed % escapes", () => {
      expect(classifyRoute("/%")).toEqual({ kind: "invalid-encoding", raw: "%" });
      expect(classifyRoute("/%E8%90")).toEqual({ kind: "invalid-encoding", raw: "%E8%90" });
      expect(classifyRoute("/'%")).toEqual({ kind: "invalid-encoding", raw: "'%" });
    });
  });

  describe("idx stripping on non-entry routes", () => {
    it("strips trailing /<digits> from about route", () => {
      expect(classifyRoute("/about/2")).toEqual({ kind: "about" });
    });
    it("strips trailing /<digits> from radical route", () => {
      expect(classifyRoute("/@木/2")).toEqual({ kind: "radical", lang: "a", radical: "木" });
      expect(classifyRoute("/'@木/2")).toEqual({ kind: "radical", lang: "t", radical: "木" });
    });
    it("strips trailing /<digits> from group route", () => {
      expect(classifyRoute("/=成語/2")).toEqual({ kind: "group", lang: "a", category: "成語" });
    });
    it("strips trailing /<digits> from starred route", () => {
      expect(classifyRoute("/=*/2")).toEqual({ kind: "starred", lang: "a", entry: "" });
    });
    it("does NOT attach idx to non-entry kinds", () => {
      const route = classifyRoute("/=成語/2");
      expect(route).not.toHaveProperty("idx");
    });
  });

  describe("precedence order", () => {
    it("'=* (starred) takes precedence over '= (group)", () => {
      expect(classifyRoute("/'=*star")).toEqual({ kind: "starred", lang: "t", entry: "star" });
    });
    it("'= (group) takes precedence over ' (entry)", () => {
      expect(classifyRoute("/'=諺語")).toEqual({ kind: "group", lang: "t", category: "諺語" });
    });
    it("'=* before '= before ' — full chain", () => {
      // The three-level precedence: starred > group > entry
      expect(classifyRoute("/'=*")).toEqual({ kind: "starred", lang: "t", entry: "" });
      expect(classifyRoute("/'=詞")).toEqual({ kind: "group", lang: "t", category: "詞" });
      expect(classifyRoute("/'食")).toEqual({ kind: "entry", lang: "t", text: "食" });
    });
    it("=* (starred a) takes precedence over = (group a)", () => {
      expect(classifyRoute("/=*star")).toEqual({ kind: "starred", lang: "a", entry: "star" });
    });
    it("= (group) takes precedence over bare entry", () => {
      expect(classifyRoute("/=成語")).toEqual({ kind: "group", lang: "a", category: "成語" });
    });
    it("~@ (radical c) takes precedence over ~ (entry c)", () => {
      expect(classifyRoute("/~@水")).toEqual({ kind: "radical", lang: "c", radical: "水" });
    });
    it("~@ exact match before ~@ prefix", () => {
      expect(classifyRoute("/~@")).toEqual({ kind: "radical", lang: "c", radical: "" });
    });
    it("'@ (radical t) takes precedence over ' (entry t)", () => {
      expect(classifyRoute("/'@木")).toEqual({ kind: "radical", lang: "t", radical: "木" });
      expect(classifyRoute("/'木")).toEqual({ kind: "entry", lang: "t", text: "木" });
    });
  });

  describe("query-string stripping", () => {
    it("strips ?query before classifying", () => {
      expect(classifyRoute("/萌?foo=bar")).toEqual({ kind: "entry", lang: "a", text: "萌" });
    });
    it("strips ?query from about route", () => {
      expect(classifyRoute("/about?x=1")).toEqual({ kind: "about" });
    });
  });

  describe("parseDictionaryRoute is a thin wrapper over classifyRoute", () => {
    it("returns entry shape for entry routes", () => {
      expect(parseDictionaryRoute("/萌")).toEqual({ lang: "a", text: "萌" });
      expect(parseDictionaryRoute("/萌/2")).toEqual({ lang: "a", text: "萌", idx: 2 });
    });
    it("returns null for non-entry kinds", () => {
      expect(parseDictionaryRoute("/about")).toBeNull();
      expect(parseDictionaryRoute("/@木")).toBeNull();
      expect(parseDictionaryRoute("/=*")).toBeNull();
      expect(parseDictionaryRoute("/=成語")).toBeNull();
    });
    it("returns null for invalid-encoding", () => {
      expect(parseDictionaryRoute("/%")).toBeNull();
    });
  });
});

describe("stripLangPrefix", () => {
  it("maps the three canonical prefixes and defaults to a", () => {
    expect(stripLangPrefix("'食")).toEqual({ lang: "t", rest: "食" });
    expect(stripLangPrefix(":字")).toEqual({ lang: "h", rest: "字" });
    expect(stripLangPrefix("~上訴")).toEqual({ lang: "c", rest: "上訴" });
    expect(stripLangPrefix("萌")).toEqual({ lang: "a", rest: "萌" });
  });

  it("returns lang a with empty rest for the empty string", () => {
    expect(stripLangPrefix("")).toEqual({ lang: "a", rest: "" });
  });

  it("honors the extra alias map only for non-canonical heads", () => {
    expect(stripLangPrefix("!食", { "!": "t" })).toEqual({ lang: "t", rest: "食" });
    expect(stripLangPrefix("'食", { "!": "t" })).toEqual({ lang: "t", rest: "食" });
    expect(stripLangPrefix("!食")).toEqual({ lang: "a", rest: "!食" });
  });
});

describe("tryDecodeURIComponent", () => {
  it("decodes valid percent-encoding", () => {
    expect(tryDecodeURIComponent("%E8%90%8C")).toBe("萌");
    expect(tryDecodeURIComponent("plain")).toBe("plain");
  });

  it("returns null instead of throwing on malformed encoding", () => {
    expect(tryDecodeURIComponent("%")).toBeNull();
    expect(tryDecodeURIComponent("%E8%9")).toBeNull();
  });
});

describe("resolveLegacyHashRoute (g0v/moedict-webkit#131)", () => {
  it("converts a legacy Taiwanese-Hokkien hashbang word link into its real pathname", () => {
    // The exact case from the issue: content links still emit `./#'word`,
    // which the browser resolves to pathname "/" + hash "#'煏".
    expect(resolveLegacyHashRoute("/", "#'煏")).toBe("/'煏");
  });

  it("handles all four language-prefix hash forms", () => {
    expect(resolveLegacyHashRoute("/", "#萌")).toBe("/萌");
    expect(resolveLegacyHashRoute("/", "#'食")).toBe("/'食");
    expect(resolveLegacyHashRoute("/", "#:字")).toBe("/:字");
    expect(resolveLegacyHashRoute("/", "#~萌")).toBe("/~萌");
  });

  it("decodes a percent-encoded hash token (bopomofo-pinyin-utils.ts's encodeURIComponent form)", () => {
    expect(resolveLegacyHashRoute("/", "#%E8%B3%8A")).toBe("/賊");
  });

  it("converts radical-tag hash links (DictionaryPage.tsx's `./#@char` / `./#~@char`)", () => {
    expect(resolveLegacyHashRoute("/", "#@木")).toBe("/@木");
    expect(resolveLegacyHashRoute("/", "#~@木")).toBe("/~@木");
  });

  it("does nothing when the pathname is not the homepage — never touches a real page's own anchors", () => {
    expect(resolveLegacyHashRoute("/'煏豬油", "#'煏")).toBeNull();
    expect(resolveLegacyHashRoute("/about", "#how-to-use")).toBeNull();
  });

  it('does nothing for an empty or bare hash — leaves navbar `href="#"` toggles untouched', () => {
    expect(resolveLegacyHashRoute("/", "")).toBeNull();
    expect(resolveLegacyHashRoute("/", "#")).toBeNull();
  });

  it("fails closed to null on malformed percent-encoding instead of throwing", () => {
    expect(resolveLegacyHashRoute("/", "#%")).toBeNull();
    expect(resolveLegacyHashRoute("/", "#%E8%9")).toBeNull();
  });
});
