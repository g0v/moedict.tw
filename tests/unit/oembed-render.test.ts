/**
 * Direct-call tests for src/oembed/render-embed-document.ts — the pure,
 * script-free HTML renderer behind GET /embed/<word>.
 */

import { describe, expect, it } from "vite-plus/test";
import { renderEmbedDocument, renderEmbedNotFound } from "../../src/oembed/render-embed-document";
import type { EmbedDictionaryEntry } from "../../src/oembed/types";

describe("renderEmbedDocument", () => {
  it("renders title, pronunciation, and grouped definitions for lang=a", () => {
    const entry: EmbedDictionaryEntry = {
      title: "萌",
      heteronyms: [
        {
          bopomofo: "ㄇㄥˊ",
          pinyin: "méng",
          definitions: [
            { type: "名", def: "草木初生的芽。" },
            { type: "名", def: "事物發生的開端。" },
            { type: "動", def: "發芽。" },
          ],
        },
      ],
    };
    const html = renderEmbedDocument({
      word: "萌",
      lang: "a",
      entry,
      canonicalUrl: "https://www.moedict.tw/萌",
    });
    expect(html).toContain("<title>萌 - 萌典</title>");
    expect(html).toContain("<h1>萌</h1>");
    expect(html).toContain("ㄇㄥˊ");
    expect(html).toContain("méng");
    expect(html).toContain("草木初生的芽。");
    expect(html).toContain("事物發生的開端。");
    expect(html).toContain("發芽。");
    expect(html).toContain('<span class="pos">名</span>');
    expect(html).toContain('<span class="pos">動</span>');
    expect(html).toContain('href="https://www.moedict.tw/萌"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    // No JS anywhere — the whole point of a script-free embed.
    expect(html).not.toContain("<script");
  });

  it("falls back to the pinyin/trs field for pronunciation when bopomofo is absent", () => {
    const entry: EmbedDictionaryEntry = {
      title: "食",
      heteronyms: [{ trs: "tsia̍h", definitions: [{ type: "動", def: "吃。" }] }],
    };
    const html = renderEmbedDocument({
      word: "食",
      lang: "t",
      entry,
      canonicalUrl: "https://www.moedict.tw/'食",
    });
    expect(html).toContain("tsia̍h");
    expect(html).toContain("吃。");
  });

  it("skips the pronunciation line entirely for lang=h", () => {
    const entry: EmbedDictionaryEntry = {
      title: "字",
      heteronyms: [
        {
          bopomofo: "should-not-appear",
          pinyin: "ii",
          definitions: [{ type: "名", def: "文字。" }],
        },
      ],
    };
    const html = renderEmbedDocument({
      word: "字",
      lang: "h",
      entry,
      canonicalUrl: "https://www.moedict.tw/:字",
    });
    expect(html).not.toContain("should-not-appear");
    expect(html).not.toContain('class="pron"');
    expect(html).toContain("文字。");
  });

  it("omits the pronunciation block when both bopomofo and pinyin/trs are absent", () => {
    const entry: EmbedDictionaryEntry = {
      title: "萌",
      heteronyms: [{ definitions: [{ type: "名", def: "草木初生的芽。" }] }],
    };
    const html = renderEmbedDocument({
      word: "萌",
      lang: "a",
      entry,
      canonicalUrl: "https://www.moedict.tw/萌",
    });
    expect(html).not.toContain('class="pron"');
    expect(html).toContain("草木初生的芽。");
  });

  it('groups definitions with an empty type without a <span class="pos">', () => {
    const entry: EmbedDictionaryEntry = {
      title: "萌",
      heteronyms: [{ definitions: [{ def: "無詞性定義。" }] }],
    };
    const html = renderEmbedDocument({
      word: "萌",
      lang: "a",
      entry,
      canonicalUrl: "https://www.moedict.tw/萌",
    });
    expect(html).toContain("無詞性定義。");
    expect(html).not.toContain('<span class="pos">');
  });

  it("drops definitions whose def text is empty after stripping tags", () => {
    const entry: EmbedDictionaryEntry = {
      title: "萌",
      heteronyms: [
        {
          definitions: [
            { type: "名", def: "<br>" },
            { type: "名", def: "   " },
          ],
        },
      ],
    };
    const html = renderEmbedDocument({
      word: "萌",
      lang: "a",
      entry,
      canonicalUrl: "https://www.moedict.tw/萌",
    });
    // Both defs strip to empty, so the whole heteronym section (no
    // pronunciation either) is dropped and the "not found" message shows.
    expect(html).toContain("找不到這個詞條的說明。");
  });

  it("caps heteronyms at 3 and definitions per heteronym at 5", () => {
    const definitions = Array.from({ length: 8 }, (_, i) => ({ type: "名", def: `定義${i}` }));
    const heteronyms = Array.from({ length: 5 }, (_, i) => ({ bopomofo: `第${i}音`, definitions }));
    const entry: EmbedDictionaryEntry = { title: "多音字", heteronyms };
    const html = renderEmbedDocument({
      word: "多音字",
      lang: "a",
      entry,
      canonicalUrl: "https://www.moedict.tw/多音字",
    });
    expect(html).toContain("第0音");
    expect(html).toContain("第2音");
    expect(html).not.toContain("第3音");
    expect(html).toContain("定義0");
    expect(html).toContain("定義4");
    expect(html).not.toContain("定義5");
  });

  it("falls back to word when entry.title is missing, and to heteronyms=[] when not an array", () => {
    const entry = { heteronyms: "not-an-array" as unknown as EmbedDictionaryEntry["heteronyms"] };
    const html = renderEmbedDocument({
      word: "萌",
      lang: "a",
      entry,
      canonicalUrl: "https://www.moedict.tw/萌",
    });
    expect(html).toContain("<h1>萌</h1>");
    expect(html).toContain("找不到這個詞條的說明。");
  });

  it("strips markup from the title instead of rendering it live, and escapes stray non-tag markup in definitions", () => {
    const entry: EmbedDictionaryEntry = {
      title: "<b>萌</b>",
      heteronyms: [
        { definitions: [{ type: "名", def: "<img src=x onerror=alert(1)>惡意 & 危險 < 5" }] },
      ],
    };
    const html = renderEmbedDocument({
      word: "萌",
      lang: "a",
      entry,
      canonicalUrl: "https://www.moedict.tw/萌",
    });
    // stripTags removes the <b> wrapper entirely — the title renders as
    // plain "萌", not visibly-escaped markup.
    expect(html).toContain("<h1>萌</h1>");
    expect(html).not.toContain("<b>");
    // The <img onerror> tag is stripped (never reaches the DOM as an
    // element); the leftover literal "&" and "<" are HTML-escaped so they
    // render as text, not entities that could reopen markup.
    expect(html).not.toContain("<img");
    expect(html).toContain("惡意 &amp; 危險 &lt; 5");
  });

  it("drops a definition item that has no def field at all (item.def undefined)", () => {
    const entry: EmbedDictionaryEntry = {
      title: "萌",
      heteronyms: [{ definitions: [{ type: "名" }, { type: "名", def: "有值。" }] }],
    };
    const html = renderEmbedDocument({
      word: "萌",
      lang: "a",
      entry,
      canonicalUrl: "https://www.moedict.tw/萌",
    });
    expect(html).toContain("有值。");
  });

  it("treats a heteronym with no definitions field as having none (falls back to Array.isArray guard)", () => {
    const entry: EmbedDictionaryEntry = {
      title: "萌",
      heteronyms: [{ bopomofo: "ㄇㄥˊ" }],
    };
    const html = renderEmbedDocument({
      word: "萌",
      lang: "a",
      entry,
      canonicalUrl: "https://www.moedict.tw/萌",
    });
    expect(html).toContain("ㄇㄥˊ");
    expect(html).not.toContain("找不到這個詞條的說明。");
  });

  it("falls back to word when entry.title is present but strips down to nothing", () => {
    const entry: EmbedDictionaryEntry = {
      title: "   ",
      heteronyms: [{ definitions: [{ type: "名", def: "定義" }] }],
    };
    const html = renderEmbedDocument({
      word: "萌",
      lang: "a",
      entry,
      canonicalUrl: "https://www.moedict.tw/萌",
    });
    expect(html).toContain("<h1>萌</h1>");
  });
});

describe("renderEmbedNotFound", () => {
  it("shows the requested word when provided", () => {
    const html = renderEmbedNotFound("煏豬油");
    expect(html).toContain("煏豬油");
    expect(html).toContain("找不到這個詞條。");
  });

  it("falls back to a generic title when word is empty", () => {
    const html = renderEmbedNotFound("");
    expect(html).toContain("<title>找不到條目 - 萌典</title>");
  });
});
