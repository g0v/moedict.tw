/**
 * Coverage for collectRubyRomanization() in src/utils/ruby2hruby.ts —
 * the DOM query that powers the "複製羅馬拼音" (copy romanization) button
 * added for g0v/moedict-webkit#256.
 *
 * Root cause of #256: the visible corner pinyin is CSS generated content
 * (`content: attr(annotation)`), which browsers never include in a
 * selection/copy. The only *real* text node carrying the romanization is
 * the `<rt>` that ruby2hruby() hides via `text-indent: -9999px`, and on the
 * main title it sits inline right after the visible `<zhuyin>` text, so a
 * plain user text-selection yields a garbled run like "萌ㄇㄥˊméng" instead
 * of clean romanization. collectRubyRomanization() reads exactly that
 * hidden `<rt>` — bypassing the garbled visible selection entirely — so the
 * copy button's output is always in sync with what ruby2hruby() rendered.
 */

import { describe, expect, it } from "vite-plus/test";
import { collectRubyRomanization, rightAngle } from "../../src/utils/ruby2hruby";

function parseHruby(html: string): Element {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const hruby = doc.querySelector("hruby");
  if (!hruby) throw new Error("expected a <hruby> root in parsed fixture");
  return hruby;
}

describe("collectRubyRomanization", () => {
  it("reads the single hidden <rt> for a one-character title", () => {
    const hruby = parseHruby(
      rightAngle(
        '<rb>萌</rb><rtc class="zhuyin"><rt>ㄇㄥˊ</rt></rtc><rtc class="romanization"><rt>méng</rt></rtc>',
      ),
    );
    expect(collectRubyRomanization(hruby)).toBe("méng");
  });

  it("joins per-syllable <rt> text with a single space, in DOM order, for multi-character titles", () => {
    const hruby = parseHruby(
      rightAngle(
        "<rb>電</rb><rb>腦</rb>" +
          '<rtc class="zhuyin"><rt>ㄉㄧㄢˋ</rt><rt>ㄋㄠˇ</rt></rtc>' +
          '<rtc class="romanization"><rt>diàn</rt><rt>nǎo</rt></rtc>',
      ),
    );
    expect(collectRubyRomanization(hruby)).toBe("diàn nǎo");
  });

  it("never returns the annotation attribute's PUA-mapped text for combining-mark syllables", () => {
    // normalizeAnnotation() maps a+combining-dot-above to a PUA codepoint for
    // font rendering; collectRubyRomanization must return the plain,
    // pasteable rt text instead, not the annotation attribute's value.
    const hruby = parseHruby(
      rightAngle(
        '<rb>鴨</rb><rtc class="zhuyin"><rt>ㄚ</rt></rtc><rtc class="romanization"><rt>a\u0307</rt></rtc>',
      ),
    );
    const outerRu = hruby.querySelector("ru[annotation]");
    expect(outerRu?.getAttribute("annotation")).not.toBe("a\u0307");
    expect(collectRubyRomanization(hruby)).toBe("a\u0307");
  });

  it("drops empty syllables instead of inserting a blank token", () => {
    const hruby = parseHruby(
      rightAngle(
        "<rb>電</rb><rb>腦</rb>" +
          '<rtc class="zhuyin"><rt>ㄉㄧㄢˋ</rt><rt>ㄋㄠˇ</rt></rtc>' +
          '<rtc class="romanization"><rt>diàn</rt><rt></rt></rtc>',
      ),
    );
    expect(collectRubyRomanization(hruby)).toBe("diàn");
  });

  it("returns an empty string when there is no romanization at all", () => {
    const hruby = parseHruby(rightAngle('<rb>字</rb><rtc class="zhuyin"><rt>ㄗˋ</rt></rtc>'));
    expect(collectRubyRomanization(hruby)).toBe("");
  });

  it("falls back to a full-tree <rt> scan when direct children aren't ru[annotation] (parse-failure shape)", () => {
    // Simulates the ruby2hruby() catch-branch: the caller still wraps in
    // <hruby>, but the inner content stays untouched raw ruby markup
    // (rb/rtc/rt), so the direct-children fast path finds nothing and the
    // function must still recover the romanization from the raw <rt>s.
    const doc = new DOMParser().parseFromString(
      '<hruby class="rightangle"><rb>萌</rb><rtc class="zhuyin"><rt>ㄇㄥˊ</rt></rtc>' +
        '<rtc class="romanization"><rt>méng</rt></rtc></hruby>',
      "text/html",
    );
    const hruby = doc.querySelector("hruby");
    if (!hruby) throw new Error("expected a <hruby> root");
    // The fallback scans every <rt> in the subtree indiscriminately, so an
    // untouched raw shape yields both the zhuyin rt and the romanization rt
    // — a degraded but non-empty result, matching the direct-children path's
    // "prefer something over nothing" contract documented on the function.
    expect(collectRubyRomanization(hruby)).toBe("ㄇㄥˊ méng");
  });
});
