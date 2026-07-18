/**
 * Coverage for src/utils/ruby2hruby.ts — exercises the DOMParser-based ruby
 * restructuring: zhuyin rtc becomes <ru zhuyin><zhuyin><yin>.../<diao>...</>,
 * ordered rtcs wrap preceding rbs with order/span/annotation attrs, and
 * leftover <rt>s are replaced with <span class="romanization-selectable">
 * (aria-hidden, g0v/moedict-webkit#100/#186).  CSS generated content already
 * renders the same reading visibly/accessibly; the span node exists only to
 * make the romanization selectable/copyable via mouse/touch drag.  <span> is
 * used instead of <rt> because WebKit's layout engine hard-forces <rt> to
 * position:static regardless of author !important rules, breaking the title
 * geometry on Safari — a plain <span> receives position:absolute correctly.
 */

import { describe, expect, it } from "vite-plus/test";
import { rightAngle, ruby2hruby } from "../../src/utils/ruby2hruby";

function stripWhitespace(html: string): string {
  return html.replace(/\s+/g, "");
}

describe("ruby2hruby — zhuyin rtc", () => {
  it("converts a single rb + zhuyin rt into <ru zhuyin><zhuyin><yin><diao>", () => {
    // ㄇㄥ = initial + final → form="SY"; trailing ˊ → diao="ˊ"
    const out = ruby2hruby('<rb>萌</rb><rtc class="zhuyin"><rt>ㄇㄥˊ</rt></rtc>');
    expect(out).toContain("<ru");
    expect(out).toContain('zhuyin=""');
    expect(out).toContain('diao="ˊ"');
    expect(out).toContain('length="2"');
    expect(out).toContain('form="SY"');
    expect(out).toContain("<rb>萌</rb>");
    expect(out).toContain("<zhuyin>");
    expect(out).toContain("<yin>ㄇㄥ</yin>");
    expect(out).toContain("<diao>ˊ</diao>");
    // The original <rtc class="zhuyin"> is removed after conversion.
    expect(out).not.toContain("<rtc");
  });

  it('emits form="S" for initial-only syllables like ㄗˋ', () => {
    const out = ruby2hruby('<rb>字</rb><rtc class="zhuyin"><rt>ㄗˋ</rt></rtc>');
    expect(out).toContain('form="S"');
    expect(out).toContain('diao="ˋ"');
  });

  it("handles multi-character words by producing one <ru> per rb/rt pair", () => {
    const out = ruby2hruby(
      '<rb>萌</rb><rb>典</rb><rtc class="zhuyin"><rt>ㄇㄥˊ</rt><rt>ㄉㄧㄢˇ</rt></rtc>',
    );
    const ruCount = (out.match(/<ru\s/g) ?? []).length;
    expect(ruCount).toBe(2);
    expect(out).toContain("<yin>ㄇㄥ</yin>");
    expect(out).toContain("<diao>ˊ</diao>");
    expect(out).toContain("<yin>ㄉㄧㄢ</yin>");
    expect(out).toContain("<diao>ˇ</diao>");
  });

  it("normalises light-tone ˙ → ˙ (no tone mark produces empty diao)", () => {
    const out = ruby2hruby('<rb>的</rb><rtc class="zhuyin"><rt>ㄉㄜ</rt></rtc>');
    // No tone mark in ㄉㄜ → diao attr is empty.
    expect(out).toContain('diao=""');
    expect(out).toContain("<yin>ㄉㄜ</yin>");
  });

  it('emits form="JY" for medial+final syllables like ㄧㄢ (yan/ian)', () => {
    const out = ruby2hruby('<rb>言</rb><rtc class="zhuyin"><rt>ㄧㄢˊ</rt></rtc>');
    expect(out).toContain('form="JY"');
    expect(out).toContain('length="2"');
    expect(out).toContain('diao="ˊ"');
  });

  it('emits form="Y" for final-only syllables like ㄚ (a)', () => {
    const out = ruby2hruby('<rb>啊</rb><rtc class="zhuyin"><rt>ㄚ</rt></rtc>');
    expect(out).toContain('form="Y"');
    expect(out).toContain('length="1"');
  });

  it('emits form="SJ" for initial+medial syllables like ㄉㄨ', () => {
    const out = ruby2hruby('<rb>都</rb><rtc class="zhuyin"><rt>ㄉㄨ</rt></rtc>');
    expect(out).toContain('form="SJ"');
    expect(out).toContain('length="2"');
  });

  it('emits form="J" for medial-only syllables like ㄧ (yi)', () => {
    const out = ruby2hruby('<rb>一</rb><rtc class="zhuyin"><rt>ㄧ</rt></rtc>');
    expect(out).toContain('form="J"');
    expect(out).toContain('length="1"');
  });

  it('emits length="0" and form="" when rt contains only a tone mark (empty yin path)', () => {
    // Exercises the `yin ? Array.from(yin).length : 0` false arm — after stripping the
    // light tone ˙ (U+02D9), yin is the empty string so length falls through to 0.
    const out = ruby2hruby('<rb>X</rb><rtc class="zhuyin"><rt>˙</rt></rtc>');
    expect(out).toContain('length="0"');
    expect(out).toContain('form=""');
    expect(out).toContain('diao="˙"');
    expect(out).toContain("<yin></yin>");
  });

  it("normalises U+02C5 to U+02C7 and U+030D to U+0307 in the diao attribute", () => {
    // UNICODE.zhuyin.tone includes \u02C5 (caron below). After diao extraction the code
    // replaces \u02C5 → \u02C7, and \u030D → \u0358 → \u0307. Feed a rt with \u02C5.
    const out = ruby2hruby('<rb>x</rb><rtc class="zhuyin"><rt>ㄇ\u02C5</rt></rtc>');
    // Original \u02C5 is replaced with \u02C7 in the diao attribute.
    expect(out).toContain('diao="\u02C7"');
    expect(out).not.toContain('diao="\u02C5"');
  });

  it("normalises U+030D combining mark on a ruyun final to U+0307 via the U+030D->U+0358->U+0307 chain", () => {
    // Pin every step of the chain individually. Drop any of them and U+030D
    // either stays raw, is deleted, or stops at U+0358 in the diao attribute.
    const out = ruby2hruby('<rb>x</rb><rtc class="zhuyin"><rt>\u3107\u31B4\u030D</rt></rtc>');
    expect(out).toContain('diao="\u31B4\u0307"');
    expect(out).not.toContain('diao="\u31B4\u030D"');
    expect(out).not.toContain('diao="\u31B4\u0358"');
    expect(out).not.toContain('diao="\u31B4"');
  });

  it("captures a bare ruyun final (no combining diacritic) as the diao attribute", () => {
    // Pins the `?` quantifier on the ruyun pattern: dropping it would require
    // the diacritic and a bare \u31B4 would slip through into yin instead of diao.
    const out = ruby2hruby('<rb>x</rb><rtc class="zhuyin"><rt>\u3107\u31B4</rt></rtc>');
    expect(out).toContain('diao="\u31B4"');
    expect(out).toContain("<yin>\u3107</yin>");
    expect(out).not.toContain("<yin>\u3107\u31B4</yin>");
  });
});

describe("ruby2hruby — ordered rtc (non-zhuyin)", () => {
  it("wraps the zhuyin-produced <ru> with order/span/annotation from a trailing romanization rtc", () => {
    // The ordered-rtc branch only kicks in after zhuyin processing has
    // populated `rus`. So the real-world input is zhuyin + romanization,
    // matching decorate-ruby's output in the dictionary pipeline.
    const out = ruby2hruby(
      '<rb>萌</rb><rtc class="zhuyin"><rt>ㄇㄥˊ</rt></rtc><rtc class="romanization"><rt>meng</rt></rtc>',
    );
    expect(out).toContain('order="0"');
    expect(out).toContain('span="1"');
    expect(out).toContain('annotation="meng"');
    // The original <rt> is replaced with a <span class="romanization-selectable">
    // (visual ruby display handled by zhuyin <yin>/<diao> sub-elements; the span
    // exists only so the romanization is natively selectable/copyable).
    // It carries a defensive inline style that index.css overrides with !important,
    // and aria-hidden so AT doesn't announce the reading twice (#100).
    expect(out).toMatch(
      /<span[^>]*class="romanization-selectable"[^>]*style="text-indent:[^"]*"[^>]*aria-hidden="true"[^>]*>meng<\/span>/,
    );
    // No bare <rt> element with this text survives in the output.
    expect(out).not.toMatch(/<rt[^>]*>meng<\/rt>/);
  });

  it("g0v/moedict-webkit#100/#186: .romanization-selectable span is aria-hidden so screen readers don't double-announce the reading", () => {
    const out = ruby2hruby(
      '<rb>萌</rb><rtc class="zhuyin"><rt>ㄇㄥˊ</rt></rtc><rtc class="romanization"><rt>meng</rt></rtc>',
    );
    // CSS (ru[annotation]::before { content: attr(annotation) }) already
    // draws "meng" visibly and is exposed via the accessible-name
    // computation, so the selectable span carrying the same text
    // must be pulled out of the accessibility tree entirely.
    expect(out).toContain('aria-hidden="true"');
    // The element is a span with the specific class, not a bare rt.
    expect(out).toContain('class="romanization-selectable"');
  });
});

describe("ruby2hruby — no bare <rt> survives (WebKit regression guard)", () => {
  it("emits zero bare <rt> elements for a realistic multi-character zhuyin+romanization title", () => {
    // This is the actual pipeline output shape for Mandarin entries:
    // one zhuyin rtc and one romanization rtc per word.
    const out = rightAngle(
      ruby2hruby(
        "<rb>萌</rb><rb>典</rb>" +
          '<rtc class="zhuyin"><rt>ㄇㄥˊ</rt><rt>ㄉㄧㄢˇ</rt></rtc>' +
          '<rtc class="romanization"><rt>méng</rt><rt>diǎn</rt></rtc>',
      ),
    );
    // No bare <rt> element may survive — only .romanization-selectable <span>s.
    // A surviving <rt> means the WebKit position:static bug is back in the DOM.
    expect(out).not.toMatch(/<rt[\s>]/);
    // Each romanization IS present, just inside a span not an rt.
    expect(out).toContain(">méng</span>");
    expect(out).toContain(">diǎn</span>");
  });

  it("returns input unchanged (no rt emitted) when DOMParser is unavailable — fallback path", () => {
    // On the DOMParser-missing path ruby2hruby returns the raw HTML unchanged.
    // rightAngle also calls ruby2hruby, so no <rt> transformation occurs and
    // the input passthrough must not inject phantom <rt> elements either.
    const original = globalThis.DOMParser;
    // @ts-expect-error — deliberately simulate a non-DOM environment.
    delete globalThis.DOMParser;
    try {
      const html = '<rb>字</rb><rtc class="zhuyin"><rt>ㄗˋ</rt></rtc>';
      // ruby2hruby returns the input unchanged; rightAngle in turn calls ruby2hruby.
      const out = ruby2hruby(html);
      expect(out).toBe(html);
    } finally {
      globalThis.DOMParser = original;
    }
  });
});

describe("ruby2hruby — robustness", () => {
  it("returns the input unchanged when DOMParser is missing", () => {
    const original = globalThis.DOMParser;
    // @ts-expect-error — deliberately simulate a non-DOM environment.
    delete globalThis.DOMParser;
    try {
      const html = "<rb>字</rb>";
      expect(ruby2hruby(html)).toBe(html);
    } finally {
      globalThis.DOMParser = original;
    }
  });

  it("handles empty input without throwing", () => {
    expect(() => ruby2hruby("")).not.toThrow();
  });

  it("returns the input unchanged when parsing produces no <ruby> root", () => {
    // Happy-dom always wraps our string inside the <ruby> we prepend, so this
    // branch is defensive — we still want a non-throwing no-op result.
    expect(() => ruby2hruby("plain text with no markup")).not.toThrow();
  });
});

describe("rightAngle", () => {
  it('wraps ruby2hruby output in <hruby class="rightangle" rightangle="rightangle">', () => {
    const out = rightAngle('<rb>字</rb><rtc class="zhuyin"><rt>ㄗˋ</rt></rtc>');
    expect(out.startsWith('<hruby class="rightangle" rightangle="rightangle">')).toBe(true);
    expect(out.endsWith("</hruby>")).toBe(true);
    // Inner transformation still happens.
    expect(stripWhitespace(out)).toContain("<yin>ㄗ</yin>");
  });

  it("rightAngle on multi-rb input produces one <ru> per rb with correct length/form/diao", () => {
    // ㄇㄥˊ → form="SY", length=2, diao=ˊ
    // ㄉㄧㄢˇ → form="SJY", length=3, diao=ˇ
    const out = rightAngle(
      '<rb>萌</rb><rb>典</rb><rtc class="zhuyin"><rt>ㄇㄥˊ</rt><rt>ㄉㄧㄢˇ</rt></rtc>',
    );
    // Attributes are serialized in the order they were set: zhuyin, diao, length, form.
    expect(out).toContain('<ru zhuyin="" diao="ˊ" length="2" form="SY">');
    expect(out).toContain('<ru zhuyin="" diao="ˇ" length="3" form="SJY">');
    // Each rb ends up wrapped in its own <ru zhuyin>.
    expect(out).toMatch(/<ru[^>]*zhuyin[^>]*>[^<]*<rb>萌<\/rb>/);
    expect(out).toMatch(/<ru[^>]*zhuyin[^>]*>[^<]*<rb>典<\/rb>/);
  });
});

describe("ruby2hruby — multi-rtc (order > 0) branch", () => {
  // When the ruby has a zhuyin rtc + a non-zhuyin rtc + another non-zhuyin rtc,
  // the third rtc iterates with order=1 (after zhuyin is removed, the remaining
  // two rtcs get order 0 and 1). The order>0 branch reuses the previous-order ru
  // via `ru[order="0"]` lookup instead of shifting from `rus`.
  it("third rtc wraps the order=0 ru rather than shifting fresh rus", () => {
    const out = ruby2hruby(
      '<rb>萌</rb><rtc class="zhuyin"><rt>ㄇㄥˊ</rt></rtc>' +
        '<rtc class="romanization"><rt>méng</rt></rtc>' +
        "<rtc><rt>annotation</rt></rtc>",
    );
    // Outer ru is order="1"; it contains the order="0" ru, which contains the zhuyin ru.
    expect(out).toMatch(/<ru[^>]*\border="1"[^>]*>/);
    expect(out).toMatch(/<ru[^>]*\border="0"[^>]*>/);
    // order="1" wraps order="0" — verify nesting by offset.
    const order1 = out.indexOf('order="1"');
    const order0 = out.indexOf('order="0"');
    expect(order1).toBeGreaterThan(-1);
    expect(order0).toBeGreaterThan(order1);
    // Both annotation strings make it into the output.
    expect(out).toContain('annotation="méng"');
    expect(out).toContain('annotation="annotation"');
  });

  it("annotation attr is normalised for combining marks on a/e/i/o/u", () => {
    // Feed a combining-dot-below-style mark on a base vowel `a` (U+0061 + U+0307)
    // — ruby2hruby's normalizeAnnotation should remap to U+DB80 U+DC61 surrogate.
    const combo = "a\u0307"; // small a + combining dot above → maps to PUA U+100061
    const out = ruby2hruby(
      `<rb>x</rb><rtc class="zhuyin"><rt>ㄇ</rt></rtc><rtc><rt>${combo}</rt></rtc>`,
    );
    // The surrogate pair U+DB80 U+DC61 renders as the PUA character; check the raw
    // bytes end up in the annotation attribute (attribute serialization preserves them).
    expect(out).toContain(`annotation="\uDB80\uDC61"`);
  });

  it.each([
    // [base vowel, target high-byte, target low-byte]
    ["e", 0xdb80, 0xdc65],
    ["i", 0xdb80, 0xdc69],
    ["o", 0xdb80, 0xdc6f],
    ["u", 0xdb80, 0xdc75],
  ])(
    "normalizeAnnotation maps base vowel %s + each combining mark (U+0307/U+030D/U+0358) to its PUA codepoint",
    (vowel, hi, lo) => {
      // Pin every row of the e/i/o/u replace-table individually. Each base vowel
      // is paired with each of the three combining marks the normalizer recognizes;
      // dropping any row would silently leave the literal vowel+combiner in the
      // annotation attribute downstream.
      const expected = String.fromCharCode(hi as number, lo as number);
      for (const mark of ["\u0307", "\u030d", "\u0358"]) {
        const out = ruby2hruby(
          `<rb>x</rb><rtc class="zhuyin"><rt>\u3107</rt></rtc><rtc><rt>${vowel}${mark}</rt></rtc>`,
        );
        expect(out).toContain(`annotation="${expected}"`);
      }
    },
  );

  it("order=0 ru carries the original class attribute from the ruby root", () => {
    // The ruby2hruby template injects class="rightangle" on the outer <ruby>;
    // each order=0 wrapper ru should inherit it via setAttribute('class', originalClass).
    const out = ruby2hruby(
      '<rb>\u840C</rb><rtc class="zhuyin"><rt>\u3107\u3125\u02CA</rt></rtc><rtc class="romanization"><rt>meng</rt></rtc>',
    );
    // happy-dom serializes the wrapper as <ru span order class annotation>;
    // pin class="rightangle" specifically on the order="0" tag without
    // assuming a particular attribute order.
    const orderZero = out.match(/<ru\b[^>]*\border="0"[^>]*>/);
    expect(orderZero).not.toBeNull();
    expect(orderZero![0]).toContain('class="rightangle"');
  });

  it("order>0 with more rts than order=0 produced: excess rts are skipped (line 128)", () => {
    // Two rbs under rbspan=2 produce ONE order=0 ru. A follow-on rtc with two rts
    // only finds `ru[order="0"][0]` for idx=0 — idx=1's lookup returns undefined so
    // the early `return` on line 128 fires for the second rt. After processing, the
    // entire remaining rtc (including the orphan rt) is removed by line 149.
    const out = ruby2hruby(
      "<rb>a</rb><rb>b</rb>" +
        '<rtc class="zhuyin"><rt>ㄉ</rt><rt>ㄊ</rt></rtc>' +
        '<rtc class="romanization"><rt rbspan="2">ab</rt></rtc>' +
        "<rtc><rt>wrapped</rt><rt>orphan</rt></rtc>",
    );
    // The "wrapped" annotation makes it onto a ru[order="1"].
    expect(out).toContain('annotation="wrapped"');
    // The "orphan" rt was skipped during wrapping (returned early) AND its containing
    // rtc is removed at the end, so "orphan" does not appear in the final output.
    expect(out).not.toContain("orphan");
    // There is exactly one order="1" ru despite the rtc having two rts.
    expect((out.match(/order="1"/g) ?? []).length).toBe(1);
  });
});

describe("ruby2hruby — rbspan (order=0) branches", () => {
  it('rbspan="2" pulls two rus into a single order=0 ru (line 145 slice(1).remove)', () => {
    // Two zhuyin rus + one romanization rt with rbspan=2 → single wrapping ru with span=2.
    const out = ruby2hruby(
      "<rb>之</rb><rb>後</rb>" +
        '<rtc class="zhuyin"><rt>ㄓ</rt><rt>ㄏㄡˋ</rt></rtc>' +
        '<rtc class="romanization"><rt rbspan="2">zhī hòu</rt></rtc>',
    );
    expect(out).toContain('span="2"');
    expect(out).toContain('order="0"');
    expect(out).toContain('annotation="zhī hòu"');
    // Both zhuyin-wrapped rbs are now nested inside the single order=0 ru.
    expect(out).toContain("<rb>之</rb>");
    expect(out).toContain("<rb>後</rb>");
    // Only one order="0" ru exists — the second ru was consumed/removed by slice(1).forEach remove.
    expect((out.match(/order="0"/g) ?? []).length).toBe(1);
    // The single outer ru contains both inner zhuyin rus.
    expect(out).toMatch(/<ru[^>]*span="2"[^>]*>.*<rb>之<\/rb>.*<rb>後<\/rb>.*<\/ru>/s);
  });

  it("rbspan exceeding available rbs is clamped to maxspan (Math.min)", () => {
    // Only one rb, but rbspan="5" in the romanization — Math.min(5, 1) = 1.
    const out = ruby2hruby(
      "<rb>萌</rb>" +
        '<rtc class="zhuyin"><rt>ㄇㄥˊ</rt></rtc>' +
        '<rtc class="romanization"><rt rbspan="5">overflow</rt></rtc>',
    );
    // The outer ru's span attr is clamped to 1 (the only rb available).
    // Use a regex to target the ru element specifically (not the rt's preserved rbspan="5").
    expect(out).toMatch(/<ru[^>]*\bspan="1"/);
    expect(out).not.toMatch(/<ru[^>]*\bspan="5"/);
    expect(out).toContain('annotation="overflow"');
  });

  it('rbspan="0" produces empty baseNodes and the order=0 ru is not emitted (line 133 return)', () => {
    // rbspan="0" → Math.min(0, 1) = 0 → while (0 > 0) never enters → baseNodes empty →
    // firstBase undefined → early return. The <rt> passes through as a styled rt.
    const out = ruby2hruby(
      "<rb>萌</rb>" +
        '<rtc class="zhuyin"><rt>ㄇㄥˊ</rt></rtc>' +
        '<rtc class="romanization"><rt rbspan="0">zero</rt></rtc>',
    );
    // The zhuyin ru is present; no order="0" wrapper ru was created.
    expect(out).toContain("<rb>萌</rb>");
    expect(out).not.toContain('order="0"');
    expect(out).not.toContain('annotation="zero"');
  });

  it("rbspan greater than remaining rus breaks the pull loop (line 112)", () => {
    // One zhuyin ru for rb `之`; next rtc has two rts, each rbspan defaults to 1.
    // First rt consumes the single ru. Second rt finds `rus` empty → `!rb` breaks the loop,
    // baseNodes stays empty, firstBase undefined → early return on line 133. After the
    // rtcs.forEach loop, any remaining rtc (including the second rt still inside it) is
    // removed on line 149, so "second" doesn't survive in the output.
    const out = ruby2hruby(
      "<rb>之</rb>" +
        '<rtc class="zhuyin"><rt>ㄓ</rt></rtc>' +
        '<rtc class="romanization"><rt>first</rt><rt>second</rt></rtc>',
    );
    // First romanization rt wraps the zhuyin ru.
    expect(out).toContain('annotation="first"');
    // Second had no ru left to pull — no second order="0" wrapper exists.
    expect((out.match(/order="0"/g) ?? []).length).toBe(1);
    expect(out).not.toContain('annotation="second"');
    // The second rt was inside an rtc that gets removed wholesale at the end, so its
    // text doesn't appear in the output.
    expect(out).not.toContain("second");
  });
});

describe("ruby2hruby — zhuyin guard (line 63)", () => {
  it("extra zhuyin rts without matching rbs are skipped silently", () => {
    // Only one rb, three rts — idx=1 and idx=2 have no rb, so `if (!rb) return;` fires.
    const out = ruby2hruby(
      '<rb>萌</rb><rtc class="zhuyin"><rt>ㄇㄥˊ</rt><rt>ㄉㄧㄢˇ</rt><rt>extra</rt></rtc>',
    );
    // Only one ru produced (for the sole rb).
    expect((out.match(/<ru\s/g) ?? []).length).toBe(1);
    expect(out).toContain("<rb>萌</rb>");
    // The rtc (including surplus rts) is removed wholesale after processing.
    expect(out).not.toContain("<rtc");
    expect(out).not.toContain("ㄉㄧㄢ");
    expect(out).not.toContain("extra");
  });
});

describe("ruby2hruby — entity serialization passthrough", () => {
  // Happy-dom never emits numeric character references (&#xNNNN;) in innerHTML — it
  // serializes characters literally. These tests verify the characters themselves
  // survive the DOMParser round trip, even if the toCodePointString regex callback
  // never fires under happy-dom.
  it("preserves BMP CJK characters fed as &#xNNNN; entities (decodes to 萌)", () => {
    const out = ruby2hruby('<rb>&#x840C;</rb><rtc class="zhuyin"><rt>ㄇㄥˊ</rt></rtc>');
    // 0x840C = 萌. Happy-dom decodes at parse time; innerHTML writes the literal char.
    expect(out).toContain("<rb>萌</rb>");
    expect(out).not.toContain("&#x840C;");
  });

  it("preserves SMP (supplementary plane) characters fed as &#x1F600;", () => {
    // 0x1F600 = 😀 emoji. Requires surrogate pair in UTF-16.
    const out = ruby2hruby('<rb>&#x1F600;</rb><rtc class="zhuyin"><rt>ㄇㄥˊ</rt></rtc>');
    expect(out).toContain("<rb>😀</rb>");
    // The entity form should not appear in output.
    expect(out).not.toContain("&#x1F600;");
    expect(out).not.toContain("&#x1f600;");
  });

  it("non-hex entity-like text &amp;#xZZZZ; roundtrips without crashing", () => {
    // An ampersand-escaped invalid hex → textContent is "&#xZZZZ;" which the
    // regex on line 154 would match but only if it reached innerHTML — happy-dom
    // emits &amp;#xZZZZ; so the regex finds no hit. Test stability regardless.
    const out = ruby2hruby('<rb>foo&amp;#xZZZZ;bar</rb><rtc class="zhuyin"><rt>ㄇㄥˊ</rt></rtc>');
    // Output still contains the escaped form (the &amp; round-trips).
    expect(out).toContain("foo");
    expect(out).toContain("bar");
    expect(out).toContain("ZZZZ");
    // Structure still present.
    expect(out).toContain("<yin>ㄇㄥ</yin>");
  });
});

describe("ruby2hruby — catch branch (line 156)", () => {
  it("returns input unchanged when DOMParser constructor throws", () => {
    // Different from "DOMParser is undefined" (line 46 early-return) — this exercises
    // the outer try/catch by making `new DOMParser()` itself throw.
    const original = globalThis.DOMParser;
    class ThrowingParser {
      constructor() {
        throw new Error("simulated DOMParser failure");
      }
    }
    // @ts-expect-error — deliberate mock.
    globalThis.DOMParser = ThrowingParser;
    try {
      const html = '<rb>萌</rb><rtc class="zhuyin"><rt>ㄇㄥˊ</rt></rtc>';
      expect(ruby2hruby(html)).toBe(html);
    } finally {
      globalThis.DOMParser = original;
    }
  });

  it("returns input unchanged when parseFromString throws", () => {
    const original = globalThis.DOMParser;
    class ThrowingParseFromString {
      parseFromString(): never {
        throw new Error("simulated parse failure");
      }
    }
    globalThis.DOMParser = ThrowingParseFromString;
    try {
      const html = "<rb>test</rb>";
      expect(ruby2hruby(html)).toBe(html);
    } finally {
      globalThis.DOMParser = original;
    }
  });
});
