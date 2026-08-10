import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi, type Mock } from "vite-plus/test";
import { Resvg as ResvgWasm, initWasm } from "@resvg/resvg-wasm";

let resvgWasmInitPromise: Promise<void> | null = null;
async function ensureResvgWasm() {
  if (!resvgWasmInitPromise) {
    const wasmPath = path.resolve(__dirname, "../../node_modules/@resvg/resvg-wasm/index_bg.wasm");
    const wasmBuf = fs.readFileSync(wasmPath);
    resvgWasmInitPromise = initWasm(wasmBuf);
  }
  await resvgWasmInitPromise;
}
import {
  parseTextFromUrl,
  getFontName,
  getCORSHeaders,
  generateTextSVGWithR2Fonts,
  fetchWholeWordRomanization,
  getTwKaiShardKey,
  loadTwKaiShardBuffer,
} from "../../src/utils/image-generation";
import { isTauhuOoCodepoint } from "../../src/utils/tauhu-oo-ranges";

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
  ])("parses %s", (urlPath, expected) => {
    expect(parseTextFromUrl(urlPath)).toEqual(expected);
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
describe("getTwKaiShardKey", () => {
  it("maps codepoint boundaries correctly to TW-Kai 8-shard asset keys", () => {
    expect(getTwKaiShardKey(0x0020)).toBe("fonts/TW-Kai-shard-0.ttf");
    expect(getTwKaiShardKey(0x4d09)).toBe("fonts/TW-Kai-shard-0.ttf"); // 䴉
    expect(getTwKaiShardKey(0x4fff)).toBe("fonts/TW-Kai-shard-0.ttf");

    expect(getTwKaiShardKey(0x5000)).toBe("fonts/TW-Kai-shard-1.ttf");
    expect(getTwKaiShardKey(0x7fff)).toBe("fonts/TW-Kai-shard-1.ttf");

    expect(getTwKaiShardKey(0x8000)).toBe("fonts/TW-Kai-shard-2.ttf");
    expect(getTwKaiShardKey(0x840c)).toBe("fonts/TW-Kai-shard-2.ttf"); // 萌
    expect(getTwKaiShardKey(0xffff)).toBe("fonts/TW-Kai-shard-2.ttf");

    expect(getTwKaiShardKey(0x20000)).toBe("fonts/TW-Kai-shard-3.ttf"); // 𠀀
    expect(getTwKaiShardKey(0x22fff)).toBe("fonts/TW-Kai-shard-3.ttf");

    expect(getTwKaiShardKey(0x23000)).toBe("fonts/TW-Kai-shard-4.ttf"); // 𣁳
    expect(getTwKaiShardKey(0x24fff)).toBe("fonts/TW-Kai-shard-4.ttf");

    expect(getTwKaiShardKey(0x25000)).toBe("fonts/TW-Kai-shard-5.ttf");
    expect(getTwKaiShardKey(0x27fff)).toBe("fonts/TW-Kai-shard-5.ttf");

    expect(getTwKaiShardKey(0x28000)).toBe("fonts/TW-Kai-shard-6.ttf");
    expect(getTwKaiShardKey(0x2a6df)).toBe("fonts/TW-Kai-shard-6.ttf");

    expect(getTwKaiShardKey(0x2a700)).toBe("fonts/TW-Kai-shard-7.ttf"); // 𪜀
    expect(getTwKaiShardKey(0x2ffff)).toBe("fonts/TW-Kai-shard-7.ttf");
  });

  it("returns null for unmapped codepoints such as Ext-I (U+319E5)", () => {
    expect(getTwKaiShardKey(0x319e5)).toBeNull(); // 𱧥 (residual 1/77208 missing point)
    expect(getTwKaiShardKey(0x10ffff)).toBeNull();
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
    expect(svg).toContain('font-family="Tauhu Oo 20.05, TW-MOE-Std-Kai, serif"');
    expect(svg).toContain('dy="0.35em"'); // 𣁳 is in Tauhu Oo, retains dy=0.35em (regression guard)
    expect(svg).toContain(">𣁳</text>");
  });

  it("uses dy=0.28em for TW-Kai fallback codepoints and dy=0.35em for Tauhu Oo codepoints", async () => {
    const env = makeFontsEnv({});
    const { svg: svgKai } = await generateTextSVGWithR2Fonts("䴉", "kai", env as never);
    expect(svgKai).toContain('dy="0.28em"');
    expect(svgKai).toContain(">䴉</text>");

    const { svg: svgTauhu } = await generateTextSVGWithR2Fonts("𣁳", "kai", env as never);
    expect(svgTauhu).toContain('dy="0.35em"');
    expect(svgTauhu).toContain(">𣁳</text>");
  });

  it("verifies optical vertical centering of ink bounding box for TW-Kai fallback using test font fixture", async () => {
    await ensureResvgWasm();
    const testFontPath = path.resolve(__dirname, "../fixtures/TW-Kai-4D09-Test.ttf");
    expect(fs.existsSync(testFontPath)).toBe(true);
    const testFontBytes = new Uint8Array(fs.readFileSync(testFontPath));

    const env = makeFontsEnv({});
    const { svg: svgKai } = await generateTextSVGWithR2Fonts("䴉", "kai", env as never);
    const resvgKai = new ResvgWasm(svgKai, { font: { fontBuffers: [testFontBytes] } });
    const renderedImage = resvgKai.render();

    // Helper to measure ink pixels directly from resvg rendered RGBA pixels
    const measureResvgInk = (img: { width: number; height: number; pixels: Uint8Array }) => {
      const { width, height, pixels } = img;
      let minX = width,
        minY = height,
        maxX = 0,
        maxY = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          const r = pixels[idx],
            g = pixels[idx + 1],
            b = pixels[idx + 2],
            a = pixels[idx + 3];
          if (a > 200 && r < 50 && g < 50 && b < 50) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      const inkHeight = maxY - minY + 1;
      const topMargin = minY;
      const bottomMargin = height - 1 - maxY;
      const verticalOffset = minY + inkHeight / 2 - height / 2;
      return { topMargin, bottomMargin, verticalOffset };
    };

    const metrics = measureResvgInk(renderedImage);
    // Assert 䴉 ink bounding box top margin is normalized (40px) and vertically centered (+4px offset)
    expect(metrics.topMargin).toBeGreaterThanOrEqual(35);
    expect(metrics.topMargin).toBeLessThanOrEqual(45);
    expect(metrics.bottomMargin).toBeGreaterThanOrEqual(27);
    expect(metrics.bottomMargin).toBeLessThanOrEqual(37);
    expect(metrics.verticalOffset).toBeGreaterThanOrEqual(0);
    expect(metrics.verticalOffset).toBeLessThanOrEqual(8);
  });
  it("correctly identifies Tauhu Oo codepoints via isTauhuOoCodepoint", () => {
    expect(isTauhuOoCodepoint(0x23073)).toBe(true); // 𣁳
    expect(isTauhuOoCodepoint(0x840c)).toBe(true); // 萌
    expect(isTauhuOoCodepoint(0x4d09)).toBe(false); // 䴉
    expect(isTauhuOoCodepoint(0x20000)).toBe(false); // 𠀀
    expect(isTauhuOoCodepoint(0x2a700)).toBe(false); // 𪜀
  });

  it("tracks missingCodepoints and deduplicates shards for multi-codepoint headwords", async () => {
    const env = makeFontsEnv({});
    const { missingCodepoints } = await generateTextSVGWithR2Fonts("䴉𠀀𪜀", "kai", env as never);
    expect(missingCodepoints).toEqual([0x4d09, 0x20000, 0x2a700]);

    const shards = Array.from(
      new Set(missingCodepoints.map((cp) => getTwKaiShardKey(cp)).filter(Boolean)),
    );
    expect(shards).toEqual([
      "fonts/TW-Kai-shard-0.ttf",
      "fonts/TW-Kai-shard-3.ttf",
      "fonts/TW-Kai-shard-7.ttf",
    ]);

    // Shards capped at MAX_SHARDS_PER_REQUEST = 2
    expect(shards.slice(0, 2)).toEqual(["fonts/TW-Kai-shard-0.ttf", "fonts/TW-Kai-shard-3.ttf"]);
  });

  it("evicts oldest LRU entry in loadTwKaiShardBuffer when cache size reaches 2", async () => {
    const fetched: string[] = [];
    const assets = {
      async get(key: string) {
        fetched.push(key);
        return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
      },
    };
    const env = { FONTS: {} as never, ASSETS: assets as never };

    await loadTwKaiShardBuffer(env, "fonts/TW-Kai-shard-0.ttf");
    await loadTwKaiShardBuffer(env, "fonts/TW-Kai-shard-1.ttf");
    expect(fetched).toEqual(["fonts/TW-Kai-shard-0.ttf", "fonts/TW-Kai-shard-1.ttf"]);

    // Third shard triggers LRU eviction of shard-0
    await loadTwKaiShardBuffer(env, "fonts/TW-Kai-shard-2.ttf");
    expect(fetched).toEqual([
      "fonts/TW-Kai-shard-0.ttf",
      "fonts/TW-Kai-shard-1.ttf",
      "fonts/TW-Kai-shard-2.ttf",
    ]);

    // Requesting shard-0 again fetches from ASSETS because it was evicted
    await loadTwKaiShardBuffer(env, "fonts/TW-Kai-shard-0.ttf");
    expect(fetched).toEqual([
      "fonts/TW-Kai-shard-0.ttf",
      "fonts/TW-Kai-shard-1.ttf",
      "fonts/TW-Kai-shard-2.ttf",
      "fonts/TW-Kai-shard-0.ttf",
    ]);
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

describe("generateTextSVGWithR2Fonts — romanize caption (RESCOPE #169)", () => {
  it("produces byte-identical output when the romanization arg is omitted vs. an explicit empty string", async () => {
    const env = makeFontsEnv({ "TW-Kai/U+840C.svg": '<svg><path d="M0 0 L1 1"/></svg>' });
    const omitted = await generateTextSVGWithR2Fonts("萌", "kai", env as never);
    const explicitEmpty = await generateTextSVGWithR2Fonts("萌", "kai", env as never, "");
    expect(omitted.svg).toBe(explicitEmpty.svg);
    expect(omitted.hasCaption).toBe(false);
    expect(explicitEmpty.hasCaption).toBe(false);
    // No caption band: SVG stays square (height === width), matching the
    // pre-#169 formula exactly — no <text> caption element anywhere.
    const [, w, h] = omitted.svg.match(/width="(\d+)" height="(\d+)"/) ?? [];
    expect(h).toBe(w);
    expect((omitted.svg.match(/<text/g) || []).length).toBe(0);
  });

  it("adds exactly one caption <text> and a 120px height delta when romanization is non-empty", async () => {
    const env = makeFontsEnv({ "TW-Kai/U+840C.svg": '<svg><path d="M0 0 L1 1"/></svg>' });
    const bare = await generateTextSVGWithR2Fonts("萌", "kai", env as never);
    const captioned = await generateTextSVGWithR2Fonts("萌", "kai", env as never, "méng");

    expect(captioned.hasCaption).toBe(true);
    const [, , bareHeight] = bare.svg.match(/width="(\d+)" height="(\d+)"/) ?? [];
    const [, , captionedHeight] = captioned.svg.match(/width="(\d+)" height="(\d+)"/) ?? [];
    expect(Number(captionedHeight) - Number(bareHeight)).toBe(120);

    // Exactly one <text> element total: the per-glyph rendering used the R2
    // path SVG (no fallback <text>), so the sole <text> is the caption.
    expect((captioned.svg.match(/<text/g) || []).length).toBe(1);
    expect(captioned.svg).toContain('font-family="Fira Sans OT, serif"');
    expect(captioned.svg).toContain(">méng<");
  });

  it("caps the caption at 40 code points and appends an ellipsis", async () => {
    const env = makeFontsEnv({ "TW-Kai/U+5B57.svg": '<svg><path d="M0 0 L1 1"/></svg>' });
    const longReading = "a".repeat(45);
    const { svg } = await generateTextSVGWithR2Fonts("字", "kai", env as never, longReading);
    const match = svg.match(/font-family="Fira Sans OT, serif"[^>]*>([^<]*)<\/text>/);
    expect(match?.[1]).toBe(`${"a".repeat(40)}…`);
  });

  it("does not truncate or append an ellipsis when romanization is exactly 40 code points", async () => {
    const env = makeFontsEnv({ "TW-Kai/U+5B57.svg": '<svg><path d="M0 0 L1 1"/></svg>' });
    const exactReading = "b".repeat(40);
    const { svg } = await generateTextSVGWithR2Fonts("字", "kai", env as never, exactReading);
    const match = svg.match(/font-family="Fira Sans OT, serif"[^>]*>([^<]*)<\/text>/);
    expect(match?.[1]).toBe(exactReading);
  });

  it("XML-escapes special characters before SVG interpolation", async () => {
    const env = makeFontsEnv({});
    const { svg } = await generateTextSVGWithR2Fonts("字", "kai", env as never, `<a>&"'</a>`);
    expect(svg).toContain("&lt;a&gt;&amp;&quot;&apos;&lt;/a&gt;");
    expect(svg).not.toContain("<a>&\"'</a>");
  });

  it("whitespace-only romanization produces no caption (trimmed to empty)", async () => {
    const env = makeFontsEnv({ "TW-Kai/U+5B57.svg": '<svg><path d="M0 0 L1 1"/></svg>' });
    const { svg, hasCaption } = await generateTextSVGWithR2Fonts("字", "kai", env as never, "   ");
    expect(hasCaption).toBe(false);
    expect((svg.match(/<text/g) || []).length).toBe(0);
  });
});

describe("fetchWholeWordRomanization (RESCOPE #169)", () => {
  function makeDictionaryEnv(bucketBody: string | null): { DICTIONARY: { get: Mock } } {
    const get = vi.fn(async () => (bucketBody === null ? null : { text: async () => bucketBody }));
    return { DICTIONARY: { get } };
  }

  it("issues exactly one R2 GET per render for lang='a'", async () => {
    const env = makeDictionaryEnv(JSON.stringify({ "%u840C": { h: [{ p: "méng" }] } }));
    const result = await fetchWholeWordRomanization("萌", "a", env as never);
    expect(result).toBe("méng");
    expect(env.DICTIONARY.get).toHaveBeenCalledTimes(1);
    expect(env.DICTIONARY.get).toHaveBeenCalledWith("pack/12.txt");
  });

  it("falls back from p to T when p is absent (Taiwanese lang='t')", async () => {
    const env = makeDictionaryEnv(JSON.stringify({ "%u98DF": { h: [{ T: "tsia̍h" }] } }));
    const result = await fetchWholeWordRomanization("食", "t", env as never);
    expect(result).toBe("tsia̍h");
    expect(env.DICTIONARY.get).toHaveBeenCalledTimes(1);
  });

  it("short-circuits to '' for lang='h' before any R2 fetch (documented Hakka exclusion)", async () => {
    const env = makeDictionaryEnv(JSON.stringify({ "%u5B57": { h: [{ p: "whatever" }] } }));
    const result = await fetchWholeWordRomanization("字", "h", env as never);
    expect(result).toBe("");
    expect(env.DICTIONARY.get).not.toHaveBeenCalled();
  });

  it("returns '' when DICTIONARY is not provided on env", async () => {
    const result = await fetchWholeWordRomanization("萌", "a", {} as never);
    expect(result).toBe("");
  });

  it("returns '' when the bucket lookup misses (null R2 object)", async () => {
    const env = makeDictionaryEnv(null);
    const result = await fetchWholeWordRomanization("萌", "a", env as never);
    expect(result).toBe("");
  });

  it("returns '' when the word key is absent from the bucket", async () => {
    const env = makeDictionaryEnv(JSON.stringify({ "%uOTHER": { h: [{ p: "x" }] } }));
    const result = await fetchWholeWordRomanization("萌", "a", env as never);
    expect(result).toBe("");
  });

  it("returns '' when the entry has no heteronyms", async () => {
    const env = makeDictionaryEnv(JSON.stringify({ "%u840C": {} }));
    const result = await fetchWholeWordRomanization("萌", "a", env as never);
    expect(result).toBe("");
  });

  it("uses only the first heteronym even when later ones have romanization", async () => {
    const env = makeDictionaryEnv(JSON.stringify({ "%u840C": { h: [{}, { p: "second" }] } }));
    const result = await fetchWholeWordRomanization("萌", "a", env as never);
    expect(result).toBe("");
  });

  it("returns '' when the R2 get throws", async () => {
    const env = {
      DICTIONARY: {
        get: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    };
    const result = await fetchWholeWordRomanization("萌", "a", env as never);
    expect(result).toBe("");
  });
});
