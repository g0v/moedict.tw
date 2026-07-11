import { describe, expect, it } from 'vitest';
import {
  formatBopomofo,
  formatPinyin,
  removeBopomofo,
  decorateRuby,
} from '../../src/utils/bopomofo-pinyin-utils';
import { rightAngle } from '../../src/utils/ruby2hruby';

describe('removeBopomofo', () => {
  it('strips the zhuyin block (U+3105-312F) and modifiers', () => {
    expect(removeBopomofo('萌ㄇㄥˊ')).toBe('萌');
    expect(removeBopomofo('ㄓㄥ字 ')).toBe('字 ');
  });

  it('keeps non-bopomofo characters', () => {
    expect(removeBopomofo('hello')).toBe('hello');
    expect(removeBopomofo('')).toBe('');
  });

  it('removes Hokkien-style tone marks (˙ˊˇˋ)', () => {
    expect(removeBopomofo('ㄓˊ')).toBe('');
  });
});

describe('formatBopomofo', () => {
  it('wraps tone marks in <span class="tone">…</span>', () => {
    expect(formatBopomofo('ㄇㄥˊ')).toBe('ㄇㄥ<span class="tone">ˊ</span>');
  });

  it('handles empty input', () => {
    expect(formatBopomofo('')).toBe('');
  });
});

describe('formatPinyin', () => {
  it('wraps Hanyu tone vowels in span.tone', () => {
    expect(formatPinyin('méng')).toBe('m<span class="tone">é</span>ng');
  });

  it('returns empty string for empty input (early-return branch)', () => {
    expect(formatPinyin('')).toBe('');
  });
});

describe('decorateRuby', () => {
  it("builds a ruby structure for 'a' lang from a title + bopomofo", () => {
    const result = decorateRuby({
      LANG: 'a',
      title: '萌',
      bopomofo: 'ㄇㄥˊ',
      pinyin: 'méng',
    });
    expect(result.ruby).toContain('<rb>');
    expect(result.ruby).toContain('萌');
    expect(result.ruby).toContain('ㄇㄥ');
    expect(result.ruby).toContain('méng');
    expect(result.bopomofo).toContain('ㄇㄥ');
    expect(result.pinyin).toContain('méng');
  });

  it('marks chinese-specific pronunciation (陸)', () => {
    const result = decorateRuby({
      LANG: 'c',
      title: '萌',
      bopomofo: 'ㄇㄥˊ<br>陸 ㄇㄥ',
      pinyin: 'méng<br>陸 meng',
    });
    expect(result.cnSpecific).toBe('cn-specific');
  });

  it('handles Taiwanese (t) with trs input', () => {
    const result = decorateRuby({
      LANG: 't',
      title: '食',
      trs: 'tsia̍h',
    });
    expect(result.ruby).toContain('食');
    expect(result.bopomofo.length).toBeGreaterThanOrEqual(0);
  });

  it('handles missing input gracefully (no crash)', () => {
    expect(() => decorateRuby({ LANG: 'a' })).not.toThrow();
  });

  it('clears bopomofo for Hakka (LANG=h)', () => {
    const result = decorateRuby({
      LANG: 'h',
      title: '字',
      bopomofo: 'ㄘˋ',
      pinyin: 'cii^',
    });
    // Hakka pipeline always blanks bopomofo (the zhuyin column isn't shown
    // for Hakka entries in the UI).
    expect(result.bopomofo).toBe('');
  });

  it('clears both bopomofo and pinyin for LANG=c without <br>', () => {
    const result = decorateRuby({
      LANG: 'c',
      title: '萌',
      bopomofo: 'ㄇㄥˊ',
      pinyin: 'méng',
    });
    // 兩岸詞典 only shows pronunciation for entries whose data carries a
    // Mainland-specific form (the `<br>陸…` block). Plain entries get blanked.
    expect(result.bopomofo).toBe('');
    expect(result.pinyin).toBe('');
  });

  it('extracts the Mainland pronunciation after <br> for LANG=c', () => {
    const result = decorateRuby({
      LANG: 'c',
      title: '萌',
      bopomofo: 'ㄇㄥˊ<br>陸 ㄇㄥ',
      pinyin: 'méng<br>陸 meng',
    });
    // The Mainland-form branch keeps content *after* <br>, stripped of the 陸
    // marker — non-empty output proves we took the `if (processedBopomofo.match(/<br>/))`
    // branch rather than the blanking else.
    expect(result.bopomofo.length).toBeGreaterThan(0);
    expect(result.pinyin.length).toBeGreaterThan(0);
    expect(result.bopomofo).not.toContain('<br>');
    expect(result.pinyin).not.toContain('<br>');
    expect(result.cnSpecific).toBe('cn-specific');
  });

  it('computes rbspan for Taiwanese (LANG=t) hyphenated trs', () => {
    // tsia̍h has no hyphen; use a compound like "tsia̍h-pn̄g" to exercise the
    // rbspan counting branch for LANG=t.
    const result = decorateRuby({
      LANG: 't',
      title: '食飯',
      trs: 'tsia̍h-pn̄g',
    });
    expect(result.ruby).toMatch(/rbspan="\d+"/);
  });

  it('keeps punctuation out of ruby bases so Taiwanese readings stay aligned after semicolons', () => {
    const result = decorateRuby({
      LANG: 't',
      title: '嚴官府出厚賊；嚴爸母出阿里不達。',
      trs: 'Giâm kuann-hú tshut kāu tsha̍t; giâm pē-bú tshut a-lí-put-ta̍t. ',
    });

    expect(result.ruby).toContain('<rb><a href="./#%E8%B3%8A">賊</a></rb>；<rb><a href="./#%E5%9A%B4">嚴</a></rb>');
    expect(result.ruby).not.toContain('<rb><a href="./#%EF%BC%9B">；</a></rb>');
    expect(result.ruby).not.toContain('<rb><a href="./#%E3%80%82">。</a></rb>');
    expect(result.ruby.match(/<rb/g) || []).toHaveLength(14);

    const rendered = rightAngle(result.ruby);
    expect(rendered).toMatch(/<rb><a href=".\/#%E8%B3%8A">賊<\/a><\/rb>[\s\S]*<rt[^>]*>tsha̍t<\/rt>[\s\S]*；[\s\S]*annotation="giâm"[\s\S]*<rb><a href=".\/#%E5%9A%B4">嚴<\/a><\/rb>/);
  });
});

// The following describe blocks fill the remaining coverage gaps in
// decorateRuby (rbspan calculation, cn-specific rewrite, parallel-pinyin
// secondary rtc, 變/又音/語音/讀音 alt-pronunciation branches) and the
// buildRubyBases DOMParser catch fallback.

describe('decorateRuby — Taiwanese rbspan branch', () => {
  it('sets rbspan to hyphen-count + 1 for a 2-syllable hyphenated trs', () => {
    // One hyphen ⇒ rbspan="2".
    const result = decorateRuby({
      LANG: 't',
      title: '家裡',
      trs: 'ka-lí',
    });
    expect(result.ruby).toMatch(/rbspan="2"/);
  });

  it('sets rbspan to hyphen-count + 1 for a 3-syllable hyphenated trs', () => {
    // Two hyphens (a-b-c) ⇒ single match of /[-\u2011]+/ collapses adjacent
    // hyphens, but here they are separated, so two matches ⇒ rbspan="3".
    const result = decorateRuby({
      LANG: 't',
      title: '甲乙丙',
      trs: 'kah-it-pia',
    });
    expect(result.ruby).toMatch(/rbspan="3"/);
  });
});

describe('decorateRuby — cn-specific bopomofo rewrite (huar case)', () => {
  it('rewrites b and sets bAlt when cnSpecificBpmf is present and pinyin ends in r', () => {
    // LANG='c' is the only path that preserves `<br>陸…` through the
    // HTML-strip step (lines 87-90), so the `cnSpecificBpmf` capture at
    // line 139 can fire. Pair it with a pinyin that ends in `r` (e.g. huar)
    // to enter the line 165-172 rewrite branch.
    const result = decorateRuby({
      LANG: 'c',
      title: '花兒',
      bopomofo: 'ㄏㄨㄚㄦ<br>陸 ㄏㄨㄚㄦ',
      pinyin: 'huār',
    });
    // pinyin ending in r ⇒ rbspan="2" from the non-t r-suffix branch.
    expect(result.ruby).toContain('rbspan="2"');
    // bAlt must have been assigned inside the cnSpecificBpmf branch.
    expect(result.bAlt.length).toBeGreaterThan(0);
    expect(result.bAlt).toContain('ㄏㄨㄚ');
    expect(result.bAlt).toContain('ㄦ');
    // cn-specific flag survives into the final result.
    expect(result.cnSpecific).toBe('cn-specific');
  });
});

describe('decorateRuby — parallel-pinyin secondary rtc', () => {
  it('appends a second <rtc class="romanization"> block under HanYu-TongYong', () => {
    window.localStorage.setItem('pinyin_a', 'HanYu-TongYong');
    const result = decorateRuby({
      LANG: 'a',
      title: '中',
      bopomofo: 'ㄓㄨㄥ',
      pinyin: 'zhōng',
    });
    const romanizationMatches = result.ruby.match(/<rtc class="romanization"/g) || [];
    expect(romanizationMatches.length).toBe(2);
  });

  it('appends a second <rtc class="romanization"> block under TL-DT for Taiwanese', () => {
    window.localStorage.setItem('pinyin_t', 'TL-DT');
    const result = decorateRuby({
      LANG: 't',
      title: '食',
      trs: 'tsia̍h',
    });
    const romanizationMatches = result.ruby.match(/<rtc class="romanization"/g) || [];
    expect(romanizationMatches.length).toBe(2);
  });
});

describe('decorateRuby — 語音/讀音/又音 youyin branch', () => {
  it('captures 語音 when bopomofo starts with （語音）', () => {
    const result = decorateRuby({
      LANG: 'a',
      title: '識',
      bopomofo: '（語音）ㄕˋ',
      pinyin: 'shì',
    });
    expect(result.youyin).toBe('語音');
  });

  it('captures 讀音 when bopomofo starts with （讀音）', () => {
    const result = decorateRuby({
      LANG: 'a',
      title: '識',
      bopomofo: '（讀音）ㄕˊ',
      pinyin: 'shí',
    });
    expect(result.youyin).toBe('讀音');
  });

  it('captures 又音 when bopomofo starts with （又音）', () => {
    const result = decorateRuby({
      LANG: 'a',
      title: '識',
      bopomofo: '（又音）ㄓˋ',
      pinyin: 'zhì',
    });
    expect(result.youyin).toBe('又音');
  });

  it('derives bAlt/pAlt from a mid-string （又音） split', () => {
    // The mid-string branch is gated by /.+（又音）.+/ (content both before
    // and after the marker). When pinyin has >2 space-separated tokens the
    // pyArray.shift() loop body (line 116) fires and populates pAlt with the
    // tail of the array.
    const result = decorateRuby({
      LANG: 'a',
      title: '識字',
      bopomofo: 'ㄕˊㄗˋ（又音）ㄓˋㄗˋ',
      pinyin: 'shí zì zhì zì',
    });
    expect(result.bAlt).toContain('ㄓ');
    expect(result.pAlt.length).toBeGreaterThan(0);
    // The shift loop drops the first half, leaving the alt pronunciation.
    expect(result.pAlt).toContain('zhì');
  });
});

describe('decorateRuby — 變/slash alt markers', () => {
  it('populates bAlt when bopomofo contains 變', () => {
    const result = decorateRuby({
      LANG: 'a',
      title: '一',
      bopomofo: 'ㄧ(變)ㄧˋ',
      pinyin: 'yī',
    });
    expect(result.bAlt.length).toBeGreaterThan(0);
  });

  it('populates pAlt when pinyin contains a slash-split alternate', () => {
    const result = decorateRuby({
      LANG: 'a',
      title: '一',
      bopomofo: 'ㄧ/ㄧˋ',
      pinyin: 'yī/yì',
    });
    expect(result.pAlt).toBe('yì');
    expect(result.bAlt).toContain('ㄧ');
  });
});

describe('buildRubyBases — DOMParser catch fallback', () => {
  it('falls back to a plain <rb>-per-char structure when DOMParser is missing', () => {
    const original = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
    // @ts-expect-error — simulate a non-DOM runtime to force the catch path.
    delete globalThis.DOMParser;
    try {
      const result = decorateRuby({
        LANG: 'a',
        title: '萌典',
        bopomofo: 'ㄇㄥˊㄉㄧㄢˇ',
        pinyin: 'méng diǎn',
      });
      // Fallback wraps each character individually in <rb>…</rb>, *without*
      // the anchor tag that the DOMParser path would normally add.
      expect(result.ruby).toContain('<rb>萌</rb>');
      expect(result.ruby).toContain('<rb>典</rb>');
      expect(result.ruby).not.toContain('href=');
    } finally {
      if (original) {
        (globalThis as { DOMParser?: typeof DOMParser }).DOMParser = original;
      }
    }
  });

  it('strips HTML tags on the fallback path so only text survives', () => {
    const original = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
    // @ts-expect-error — force the catch branch.
    delete globalThis.DOMParser;
    try {
      const result = decorateRuby({
        LANG: 'a',
        title: '<span>字</span>',
        bopomofo: 'ㄗˋ',
        pinyin: 'zì',
      });
      expect(result.ruby).toContain('<rb>字</rb>');
      expect(result.ruby).not.toContain('<span>');
    } finally {
      if (original) {
        (globalThis as { DOMParser?: typeof DOMParser }).DOMParser = original;
      }
    }
  });
});

describe('buildRubyBases — DOMParser happy-path edge cases', () => {
  it('returns an empty ruby string when parseFromString cannot find the wrap element', () => {
    const original = globalThis.DOMParser;
    class NoWrapDOMParser {
      parseFromString() {
        return {
          getElementById() {
            return null;
          },
        } as unknown as Document;
      }
    }
    globalThis.DOMParser = NoWrapDOMParser as unknown as typeof DOMParser;
    try {
      const result = decorateRuby({
        LANG: 'a',
        title: '萌',
        bopomofo: 'ㄇㄥˊ',
        pinyin: 'méng',
      });
      expect(result.ruby).toContain('<rtc class="zhuyin"');
      expect(result.ruby).not.toContain('<rb>');
    } finally {
      globalThis.DOMParser = original;
    }
  });

  it('builds rb anchors for plain text titles on the DOMParser path', () => {
    const result = decorateRuby({
      LANG: 'a',
      title: ' 萌 典 ',
      bopomofo: 'ㄇㄥˊㄉㄧㄢˇ',
      pinyin: 'méng diǎn',
    });
    expect(result.ruby).toContain('<rb><a href="./#%E8%90%8C">萌</a></rb>');
    expect(result.ruby).toContain('<rb><a href="./#%E5%85%B8">典</a></rb>');
  });

  it('handles an empty text node by falling back to an empty string', () => {
    const original = globalThis.DOMParser;
    class EmptyTextNodeDOMParser {
      parseFromString() {
        return {
          getElementById() {
            return {
              childNodes: [
                {
                  nodeType: Node.TEXT_NODE,
                  textContent: '',
                },
              ],
            };
          },
        } as unknown as Document;
      }
    }
    globalThis.DOMParser = EmptyTextNodeDOMParser as unknown as typeof DOMParser;
    try {
      const result = decorateRuby({
        LANG: 'a',
        title: '萌',
        bopomofo: 'ㄇㄥˊ',
        pinyin: 'méng',
      });
      expect(result.ruby).not.toContain('<rb><a');
      expect(result.ruby).toContain('<rtc class="zhuyin"');
    } finally {
      globalThis.DOMParser = original;
    }
  });
});

describe('buildRubyBases — element branches via rich title HTML', () => {
  it('preserves <a href="…"> elements in the title and wraps each char in <rb><a>', () => {
    // An explicit <a> element hits the `element.tagName.toLowerCase() === 'a'`
    // branch (lines 52-58). A href containing a single quote also exercises
    // the escapeAttr `'` → `&#39;` replacement on line 27.
    const result = decorateRuby({
      LANG: 'a',
      title: "<a href=\"./#'字\">字典</a>",
      bopomofo: 'ㄗˋㄉㄧㄢˇ',
      pinyin: 'zì diǎn',
    });
    expect(result.ruby).toContain('<rb><a href="./#&#39;字">字</a></rb>');
    expect(result.ruby).toContain('<rb><a href="./#&#39;字">典</a></rb>');
  });

  it('wraps characters of a non-<a> element into <rb>…</rb> without a link', () => {
    // A <span> element (or any non-<a>) takes the fall-through branch at
    // lines 61-64: text content is preserved but not linkified.
    const result = decorateRuby({
      LANG: 'a',
      title: '<span>字</span>',
      bopomofo: 'ㄗˋ',
      pinyin: 'zì',
    });
    expect(result.ruby).toContain('<rb>字</rb>');
    // Must not add an <a> for non-anchor elements on the happy path either.
    expect(result.ruby).not.toContain('<rb><a');
  });

  it('handles <a> without href by falling back to empty string (line 53 branch)', () => {
    // The `element.getAttribute('href') || ''` fallback fires when the <a>
    // tag is missing the href attribute entirely.
    const result = decorateRuby({
      LANG: 'a',
      title: '<a>字</a>',
      bopomofo: 'ㄗˋ',
      pinyin: 'zì',
    });
    expect(result.ruby).toContain('<rb><a href="">字</a></rb>');
  });

  it('survives an empty <a></a> and empty <span></span> (textContent || "" fallback)', () => {
    const result = decorateRuby({
      LANG: 'a',
      title: '<a href="#"></a><span></span>字',
      bopomofo: 'ㄗˋ',
      pinyin: 'zì',
    });
    // Still produces the <rb> for the text-node "字"; empty elements emit
    // nothing but don't crash the pipeline.
    expect(result.ruby).toContain('字');
  });

  it('ignores HTML comment nodes (hits nodeType !== ELEMENT_NODE guard)', () => {
    // The comment is neither a TEXT_NODE nor an ELEMENT_NODE, so the
    // `if (node.nodeType !== Node.ELEMENT_NODE) return;` guard (line 50)
    // kicks in and the comment produces no <rb>.
    const result = decorateRuby({
      LANG: 'a',
      title: '<!-- skip -->字',
      bopomofo: 'ㄗˋ',
      pinyin: 'zì',
    });
    expect(result.ruby).toContain('<rb>');
    expect(result.ruby).toContain('字');
    expect(result.ruby).not.toContain('skip');
  });

  it('handles an empty title (hits the text || "" / titleHtml || "" fallbacks)', () => {
    // An empty title routes through the happy-path but produces no <rb>
    // children; the `text || ''` and `titleHtml || ''` defensive fallbacks
    // still get evaluated.
    const result = decorateRuby({
      LANG: 'a',
      title: '',
      bopomofo: 'ㄇㄥˊ',
      pinyin: 'méng',
    });
    // Still emits the <rtc> scaffolding even without a title.
    expect(result.ruby).toContain('<rtc');
  });

  it('hits the catch fallback with an empty title too', () => {
    const original = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
    // @ts-expect-error — force the catch branch.
    delete globalThis.DOMParser;
    try {
      const result = decorateRuby({
        LANG: 'a',
        title: '',
        bopomofo: 'ㄇㄥˊ',
        pinyin: 'méng',
      });
      // No characters to emit; ruby still contains the zhuyin / romanization
      // scaffolding from decorateRuby itself.
      expect(result.ruby).toContain('<rtc');
    } finally {
      if (original) {
        (globalThis as { DOMParser?: typeof DOMParser }).DOMParser = original;
      }
    }
  });
});

describe('decorateRuby — r-suffix branch without cn-specific override', () => {
  it('applies rbspan="2" to an r-suffix pinyin when no <br>陸 is present', () => {
    // This exercises the `else` arm of the `if (cnSpecificBpmf)` check at
    // line 166: pinyin ends in r but no Mainland-specific alt is stored,
    // so b is left untouched and only the rbspan attribute is set.
    const result = decorateRuby({
      LANG: 'a',
      title: '花兒',
      bopomofo: 'ㄏㄨㄚㄦ',
      pinyin: 'huār',
    });
    expect(result.ruby).toContain('rbspan="2"');
    // With no <br>陸 the cn-specific flag must remain off.
    expect(result.cnSpecific).toBe('');
    // bAlt is not rewritten on this path.
    expect(result.bAlt).toBe('');
  });
});

describe('decorateRuby — hard-to-hit rbspan ternary branches', () => {
  it('covers the hyphenated Taiwanese rbspan null branch via a temporary match shim', () => {
    const originalMatch = String.prototype.match;
    const calls: Record<string, number> = {};

    String.prototype.match = function (pattern: RegExp) {
      const key = pattern.source;
      calls[key] = (calls[key] || 0) + 1;
      if (key === '[-\\u2011]' && calls[key] === 1) {
        return ['-'];
      }
      if (key === '[-\\u2011]+' && calls[key] === 1) {
        return null;
      }
      return originalMatch.call(this, pattern);
    };

    try {
      const result = decorateRuby({
        LANG: 't',
        title: '家裡',
        trs: 'ka-lí',
      });
      expect(result.ruby).toContain('rbspan="1"');
    } finally {
      String.prototype.match = originalMatch;
    }
  });

  it('covers the vowel-count rbspan null branch via a temporary match shim', () => {
    const originalMatch = String.prototype.match;
    const calls: Record<string, number> = {};

    String.prototype.match = function (pattern: RegExp) {
      const key = pattern.source;
      calls[key] = (calls[key] || 0) + 1;
      if (key === '[aāáǎàeēéěèiīíǐìoōóǒòuūúǔùüǖǘǚǜ]+' && calls[key] === 1) {
        return ['é', 'a'];
      }
      if (key === '[aāáǎàeēéěèiīíǐìoōóǒòuūúǔùüǖǘǚǜ]+' && calls[key] === 2) {
        return null;
      }
      return originalMatch.call(this, pattern);
    };

    try {
      const result = decorateRuby({
        LANG: 'a',
        title: '咖啡',
        bopomofo: 'ㄎㄚㄈㄟ',
        pinyin: 'kā fēi',
      });
      expect(result.ruby).toContain('rbspan="1"');
    } finally {
      String.prototype.match = originalMatch;
    }
  });
});

// Regression coverage for g0v/moedict-webkit#299: xiehouyu (歇後語) example
// sentences use a doubled U+2500 BOX DRAWINGS LIGHT HORIZONTAL ("──") as a
// riddle/punchline dash. U+2500 is Unicode category "So" (Symbol), not "P"
// (Punctuation), so it used to be wrongly treated as its own lookupable ruby
// base — inflating the <rb> count and shifting every zhuyin <rt> after the
// dash onto the wrong character. Fixed via RUBY_BASE_PUNCTUATION_RE. Real
// ptck examples, not synthetic: 反種, 挵硞得, 媠面 all use "X──Y" phrasing.
describe('decorateRuby + rightAngle — #299 xiehouyu dash regression', () => {
  it.each([
    [
      '反種',
      '<a href="/\'茄">茄</a><a href="/\'仔">仔</a><a href="/\'開">開</a><a href="/\'黃">黃</a><a href="/\'花">花</a>──<a href="/\'反種">反種</a>。',
      'Kio\u0302-a\u0301 khui n\u0302g-hue\u2500\u2500hua\u0301n-tsi\u0301ng. ',
    ],
    [
      '挵硞得',
      '<a href="/\'豆腐">豆腐</a><a href="/\'佮">佮</a><a href="/\'石頭">石頭</a>──<a href="/\'袂磕得">袂磕得</a>。',
      'Ta\u0304u-hu\u0304 kah tsio\u030dh-tha\u0302u\u2500\u2500be\u0304-kha\u030dp--tit. ',
    ],
    [
      '媠面',
      '<a href="/\'紅龜">紅龜</a><a href="/\'抹">抹</a><a href="/\'油">油</a>──<a href="/\'媠面">媠面</a>。',
      'A\u0302ng-ku buah-iu\u0302\u2500\u2500sui\u0301-bi\u0304n.',
    ],
  ])('%s: the dash never becomes its own <rb>, and every <rb> gets a zhuyin <ru>', (_name, han, trs) => {
    const { ruby } = decorateRuby({ LANG: 't', title: han, py: trs });
    const hruby = rightAngle(ruby);

    // The dash survives as literal text between ruby groups, not as a ruby
    // base needing its own dictionary lookup link.
    expect(hruby).toContain('──');
    expect(hruby).not.toContain('href="./#%E2%94%80"');

    // ruby2hruby pairs zhuyin <rt> to <rb> strictly by array position (no
    // rbspan tolerance), so every <rb> must end up wrapped in a zhuyin <ru> —
    // one unwrapped <rb> is exactly how #299 desynced every character after
    // the dash onto the wrong reading.
    const rbCount = (hruby.match(/<rb>/g) || []).length;
    const wrappedCount = (hruby.match(/<ru zhuyin=""/g) || []).length;
    expect(rbCount).toBeGreaterThan(0);
    expect(wrappedCount).toBe(rbCount);
  });
});

// Regression coverage for g0v/moedict-webkit#300: bAlt (the alt-reading
// text extracted from a "/"-joined T field, rendered via formatBopomofo in
// TitlePronunciation.tsx — never passed through ruby2hruby) used to keep the
// legacy U+0358 combining dot, which renders skewed/detached in many fonts.
// Real ptck T field, not synthetic: 虱目魚 "sat-ba̍k-hî/sat-ba̍k-hû".
describe('decorateRuby — #300 bAlt tone-8 marker regression (虱目魚)', () => {
  it('bAlt never contains the legacy U+0358 and uses U+0307 instead', () => {
    const { bAlt } = decorateRuby({ LANG: 't', trs: 'sat-ba\u030dk-hi\u0302/sat-ba\u030dk-hu\u0302' });
    expect(bAlt).not.toContain('\u0358');
    expect(bAlt).toContain('\u0307');
  });
});
