import { describe, expect, it } from "vite-plus/test";
import {
  parseTextFromUrl,
  getFontName,
  getCORSHeaders,
  generateTextSVGWithR2Fonts,
} from "../../src/utils/image-generation";

interface FakeFontsEnv {
  FONTS: { get(key: string): Promise<{ size: number; text(): Promise<string> } | null> };
}

/** Minimal R2-shaped FONTS stub: only the listed keys resolve to a glyph SVG. */
function makeFontsEnv(entries: Record<string, string>): FakeFontsEnv {
  return {
    FONTS: {
      async get(key: string) {
        const body = entries[key];
        return body === undefined ? null : { size: body.length, text: async () => body };
      },
    },
  };
}

describe("parseTextFromUrl", () => {
  it.each([
    ["/萌.png", { text: "萌", lang: "a", cleanText: "萌" }],
    ["/%27食.png", { text: "'食", lang: "t", cleanText: "食" }],
    ["/%3A字.png", { text: ":字", lang: "h", cleanText: "字" }],
    ["/~上訴.png", { text: "~上訴", lang: "c", cleanText: "上訴" }],
    ["/!食.png", { text: "!食", lang: "t", cleanText: "食" }],
  ])("parses %s", (path, expected) => {
    expect(parseTextFromUrl(path)).toEqual(expected);
  });

  it("strips .json, .html suffixes too", () => {
    expect(parseTextFromUrl("/萌.json").cleanText).toBe("萌");
    expect(parseTextFromUrl("/萌.html").cleanText).toBe("萌");
  });

  it("strips _json/ prefix if present", () => {
    expect(parseTextFromUrl("/_json/萌.json").cleanText).toBe("萌");
  });

  it("handles starred redirect prefix =*", () => {
    // =* is stripped — the *remainder* becomes the parse input
    const result = parseTextFromUrl("/=*萌");
    expect(result.cleanText).toBe("萌");
  });
});

describe("getCORSHeaders", () => {
  it("emits wildcard origin and the three Cloudflare-safe headers", () => {
    const headers = getCORSHeaders() as Record<string, string>;
    expect(headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(headers["Access-Control-Allow-Methods"]).toContain("GET");
    expect(headers["Access-Control-Allow-Headers"]).toContain("Content-Type");
  });
});

describe("getFontName", () => {
  it("falls back to TW-Kai for unknown params", () => {
    expect(getFontName("")).toBe("TW-Kai");
    expect(getFontName("unknown-font")).toBe("TW-Kai");
    expect(getFontName("kai")).toBe("TW-Kai");
  });

  it("maps TW-Sung aliases", () => {
    expect(getFontName("sung")).toBe("TW-Sung");
    expect(getFontName("SUNG")).toBe("TW-Sung"); // case-insensitive
  });

  it("maps cwTeX Q family", () => {
    expect(getFontName("cwming")).toBe("cwTeXQMing");
    expect(getFontName("cwhei")).toBe("cwTeXQHei");
    expect(getFontName("cwyuan")).toBe("cwTeXQYuan");
    expect(getFontName("cwkai")).toBe("cwTeXQKai");
    expect(getFontName("cwfangsong")).toBe("cwTeXQFangsong");
  });

  it("maps all seven SourceHanSansTC weights", () => {
    expect(getFontName("srcx")).toBe("SourceHanSansTCExtraLight");
    expect(getFontName("srcl")).toBe("SourceHanSansTCLight");
    expect(getFontName("srcn")).toBe("SourceHanSansTCNormal");
    expect(getFontName("srcr")).toBe("SourceHanSansTCRegular");
    expect(getFontName("srcm")).toBe("SourceHanSansTCMedium");
    expect(getFontName("srcb")).toBe("SourceHanSansTCBold");
    expect(getFontName("srch")).toBe("SourceHanSansTCHeavy");
  });

  it("maps all seven SourceHanSerifTC weights", () => {
    expect(getFontName("shsx")).toBe("SourceHanSerifTCExtraLight");
    expect(getFontName("shsl")).toBe("SourceHanSerifTCLight");
    expect(getFontName("shsm")).toBe("SourceHanSerifTCMedium");
    expect(getFontName("shsr")).toBe("SourceHanSerifTCRegular");
    expect(getFontName("shss")).toBe("SourceHanSerifTCSemiBold");
    expect(getFontName("shsb")).toBe("SourceHanSerifTCBold");
    expect(getFontName("shsh")).toBe("SourceHanSerifTCHeavy");
  });

  it("maps GenWanMinTW weights", () => {
    expect(getFontName("gwmel")).toBe("GenWanMinTWEL");
    expect(getFontName("gwml")).toBe("GenWanMinTWL");
    expect(getFontName("gwmr")).toBe("GenWanMinTWR");
    expect(getFontName("gwmm")).toBe("GenWanMinTWM");
    expect(getFontName("gwmsb")).toBe("GenWanMinTWSB");
  });

  it("maps ebas, shuowen, rxkt, openhuninn", () => {
    expect(getFontName("ebas")).toBe("EBAS");
    expect(getFontName("shuowen")).toBe("ShuoWen");
    expect(getFontName("rxkt")).toBe("Typography");
    expect(getFontName("openhuninn")).toBe("jf-openhuninn-2.1");
  });

  it("maps legacy Hanwang wt* codes via lookup table", () => {
    expect(getFontName("wt001")).toBe("HanWangMingLight");
    expect(getFontName("wt024")).toBe("HanWangFangSongMedium");
    expect(getFontName("wt064")).toBe("HanWangYanKai");
    expect(getFontName("wtcc02")).toBe("HanWangCC02");
    expect(getFontName("wthc06")).toBe("HanWangGB06");
  });
});

describe("generateTextSVGWithR2Fonts", () => {
  it("splits by Unicode code point, not UTF-16 code unit, for a supplementary-plane headword", async () => {
    // 𣁳仔 (U+23073, U+4ED4) — 𣁳 is a surrogate pair in JS strings; the old
    // text[i]/text.length loop treated the two surrogate halves as separate
    // "characters", drawing 3 grid cells and looking up the bogus lone
    // surrogate code points U+D84C / U+DC73 instead of the real U+23073.
    const requested: string[] = [];
    const env = {
      FONTS: {
        async get(key: string) {
          requested.push(key);
          // 𣁳's glyph SVG doesn't exist in R2 for any font (confirmed against
          // the live moedict-fonts bucket); 仔's does.
          if (key === "TW-Kai/U+4ED4.svg") {
            return { size: 10, text: async () => '<svg><path d="M0 0 L10 10"/></svg>' };
          }
          return null;
        },
      },
    };

    const { svg, usedFallbackGlyph } = await generateTextSVGWithR2Fonts(
      "𣁳仔",
      "kai",
      env as never,
    );

    // exactly two grid cells (grid-cell rects use the #F9F6F6 fill; the SVG
    // also has one unrelated #F0F0F0 canvas-background rect)
    expect((svg.match(/#F9F6F6/g) || []).length).toBe(2);

    // looked up the real code point, never the lone surrogate halves
    expect(requested).toEqual(["TW-Kai/U+23073.svg", "TW-Kai/U+4ED4.svg"]);

    // 𣁳 has no R2 glyph anywhere, so the <text> fallback fired and must
    // reference the bundled Tauhu Oo font by its real internal family name
    // ("Tauhu Oo 20.05" — resvg matches fontBuffers by the font's own name
    // table, not any CSS @font-face alias)
    expect(usedFallbackGlyph).toBe(true);
    expect(svg).toContain('font-family="Tauhu Oo 20.05, serif"');
    expect(svg).toContain(">𣁳</text>");
  });

  it("does not flag usedFallbackGlyph when every character resolves via R2", async () => {
    const env = makeFontsEnv({ "TW-Kai/U+840C.svg": '<svg><path d="M0 0 L1 1"/></svg>' });
    const { usedFallbackGlyph, svg } = await generateTextSVGWithR2Fonts("萌", "kai", env as never);
    expect(usedFallbackGlyph).toBe(false);
    expect(svg).not.toContain("Tauhu Oo");
  });

  it("counts grid cells by code point for a mixed astral/BMP headword (regression guard)", async () => {
    const word = "𣁳仔𣁳仔字";
    const chars = Array.from(word);
    expect(chars.length).toBe(5); // word.length (UTF-16 units) would be 7

    const env = makeFontsEnv({}); // nothing resolves; only cell *count* matters here
    const { svg } = await generateTextSVGWithR2Fonts(word, "kai", env as never);
    expect((svg.match(/#F9F6F6/g) || []).length).toBe(chars.length);
  });
});
