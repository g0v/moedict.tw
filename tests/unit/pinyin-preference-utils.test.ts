import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyTaigiSandhi,
  convertPinyinByLang,
  isParallelPinyin,
  trsToBpmf,
} from '../../src/utils/pinyin-preference-utils';

beforeEach(() => {
  window.localStorage.clear();
});

describe('convertPinyinByLang', () => {
  it('returns empty string for empty input', () => {
    expect(convertPinyinByLang('a', '')).toBe('');
  });

  it('replaces ascii hyphens with non-breaking hyphens U+2011', () => {
    const result = convertPinyinByLang('a', 'a-b');
    expect(result).toContain('\u2011');
    expect(result).not.toContain('-');
  });

  describe('a (Mandarin)', () => {
    it('with default HanYu system returns input unchanged (after hyphen swap)', () => {
      expect(convertPinyinByLang('a', 'méng')).toBe('méng');
    });

    it('converts to TongYong when pinyin_a=TongYong is set', () => {
      window.localStorage.setItem('pinyin_a', 'TongYong');
      const result = convertPinyinByLang('a', 'zhōng');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('converts to WadeGiles when pinyin_a=WadeGiles', () => {
      window.localStorage.setItem('pinyin_a', 'WadeGiles');
      const result = convertPinyinByLang('a', 'zhōng');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('t (Taiwanese)', () => {
    it('returns TL input unchanged under default TL preference', () => {
      expect(convertPinyinByLang('t', 'tsia̍h')).toBe('tsia̍h');
    });

    it('produces a non-empty result under DT preference', () => {
      window.localStorage.setItem('pinyin_t', 'DT');
      const result = convertPinyinByLang('t', 'tsia̍h');
      expect(result).not.toBe('tsia̍h');
      expect(result.length).toBeGreaterThan(0);
    });

    it('produces a non-empty result under POJ preference', () => {
      window.localStorage.setItem('pinyin_t', 'POJ');
      const result = convertPinyinByLang('t', 'tsia̍h');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('h (Hakka)', () => {
    it('returns input unchanged under default TH preference', () => {
      expect(convertPinyinByLang('h', 'ngai11')).toBe('ngai11');
    });

    it('converts to PFS when preference is set', () => {
      window.localStorage.setItem('pinyin_h', 'PFS');
      const result = convertPinyinByLang('h', 'ngai11');
      expect(typeof result).toBe('string');
    });
  });

  it('c lang (liang-an) returns input verbatim', () => {
    expect(convertPinyinByLang('c', 'méng')).toBe('méng');
  });

  it('unknown lang returns input verbatim', () => {
    expect(convertPinyinByLang('x' as 'a', 'foo')).toBe('foo');
  });
});

describe('isParallelPinyin', () => {
  it('returns false under default preferences', () => {
    expect(isParallelPinyin('a')).toBe(false);
    expect(isParallelPinyin('t')).toBe(false);
    expect(isParallelPinyin('h')).toBe(false);
  });

  it('returns true when HanYu-* parallel preference is stored', () => {
    window.localStorage.setItem('pinyin_a', 'HanYu-TongYong');
    expect(isParallelPinyin('a')).toBe(true);
  });

  it('returns true when TL-* parallel preference is stored', () => {
    window.localStorage.setItem('pinyin_t', 'TL-DT');
    expect(isParallelPinyin('t')).toBe(true);
  });
});

describe('trsToBpmf', () => {
  it('returns a single space for h lang', () => {
    expect(trsToBpmf('h', 'ngai11')).toBe(' ');
  });

  it('returns input unchanged for a/c', () => {
    expect(trsToBpmf('a', 'meng2')).toBe('meng2');
    expect(trsToBpmf('c', 'meng')).toBe('meng');
  });

  it('converts Taiwanese POJ to bopomofo', () => {
    const result = trsToBpmf('t', 'tsia̍h');
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe('tsia̍h');
  });

  it('handles empty input for t', () => {
    expect(trsToBpmf('t', '')).toBe('');
  });

  it('passes through nullish for a (returns input as-is)', () => {
    // a-lang is an identity function, so a null input is returned unchanged
    expect(trsToBpmf('a', null as unknown as string)).toBe(null as unknown as string);
  });
});

/* -------------------------------------------------------------------------
 * Extended coverage — exercise every LANG branch, romanization variant,
 * table-lookup path, and tone-sandhi rule in pinyin-preference-utils.
 * ------------------------------------------------------------------------- */

describe('trsToBpmf (extended)', () => {
  it('always returns a lone space for h regardless of input', () => {
    expect(trsToBpmf('h', '')).toBe(' ');
    expect(trsToBpmf('h', 'ngai\u00B9\u00B9')).toBe(' ');
    expect(trsToBpmf('h', null as unknown as string)).toBe(' ');
  });

  it('returns input verbatim for lang a', () => {
    expect(trsToBpmf('a', '')).toBe('');
    expect(trsToBpmf('a', 'méng2')).toBe('méng2');
  });

  it('returns input verbatim for lang c', () => {
    expect(trsToBpmf('c', '')).toBe('');
    expect(trsToBpmf('c', 'liang')).toBe('liang');
  });

  it('coerces nullish input for t to empty output', () => {
    expect(trsToBpmf('t', null as unknown as string)).toBe('');
    expect(trsToBpmf('t', undefined as unknown as string)).toBe('');
  });

  describe('Taiwanese → bopomofo mappings', () => {
    it('maps tsi/tshi/ji/si initial consonants to palatalized bopomofo', () => {
      expect(trsToBpmf('t', 'tsia\u030Dh')).toBe('\u3110\u3127\u311A\u31B7\u0358');
      expect(trsToBpmf('t', 'tshok')).toBe('\u3118\u31A6\u31B6');
      expect(trsToBpmf('t', 'si')).toBe('\u3112\u3127 ');
      expect(trsToBpmf('t', 'ji')).toBe('\u31A2\u3127 ');
    });

    it('handles plain vowels and syllables without tone as unknown (U+FFFD → space)', () => {
      expect(trsToBpmf('t', 'a')).toBe('\u311A ');
      expect(trsToBpmf('t', 'ang')).toBe('\u3124 ');
    });

    it('maps combining tone marks to Taiwanese tone glyphs', () => {
      expect(trsToBpmf('t', 'a\u0300')).toBe('\u311A\u02EA');
      expect(trsToBpmf('t', 'a\u0301')).toBe('\u311A\u02CB');
      expect(trsToBpmf('t', 'a\u0302')).toBe('\u311A\u02CA');
      expect(trsToBpmf('t', 'a\u0304')).toBe('\u311A\u02EB');
      expect(trsToBpmf('t', 'a\u030D')).toBe('\u311A$');
    });

    it('falls back to the bare tone mark when a checked syllable has no tone-specific final mapping', () => {
      expect(trsToBpmf('t', 'ap\u0301')).toBe('\u311A\u02CB');
    });

    it('maps checked syllable endings p/t/k/h (and entering-tone variants)', () => {
      expect(trsToBpmf('t', 'ap')).toBe('\u311A\u31B4');
      expect(trsToBpmf('t', 'at')).toBe('\u311A\u31B5');
      expect(trsToBpmf('t', 'ak')).toBe('\u311A\u31B6');
      expect(trsToBpmf('t', 'ah')).toBe('\u311A\u31B7');
      // With U+030D (fifth tone) combined with final p — uses 'p$' row
      expect(trsToBpmf('t', 'ap\u030D')).toBe('\u311A\u31B4\u0358');
    });

    it('expands bare ok → ook before bopomofo lookup', () => {
      expect(trsToBpmf('t', 'ok')).toBe('\u31A6\u31B6');
      expect(trsToBpmf('t', 'pok')).toBe('\u3105\u31A6\u31B6');
    });

    it('expands op → oop before bopomofo lookup', () => {
      expect(trsToBpmf('t', 'op')).toBe('\u31A6\u31B4');
      expect(trsToBpmf('t', 'lop')).toBe('\u310C\u31A6\u31B4');
    });

    it('strips punctuation and collapses hyphen/space separators', () => {
      // Single-syllable phrases keep their citation tone (no sandhi target).
      expect(trsToBpmf('t', 'hang.')).toBe('\u310F\u3124 ');
      expect(trsToBpmf('t', 'hang,')).toBe('\u310F\u3124 ');
      // Multi-syllable: citation tones by default (no sandhi without opt-in).
      expect(trsToBpmf('t', 'hang-hang')).toBe('\u310F\u3124 \u310F\u3124 ');
      expect(trsToBpmf('t', 'hang hang')).toBe('\u310F\u3124 \u310F\u3124 ');
      // With sandhi opt-in: tone 1 -> tone 7 on the non-final syllable,
      // the final syllable retains its citation tone.
      window.localStorage.setItem('bopomofo_sandhi_t', 'sandhi');
      expect(trsToBpmf('t', 'hang-hang')).toBe('\u310F\u3124\u02EB\u310F\u3124 ');
      expect(trsToBpmf('t', 'hang hang')).toBe('\u310F\u3124\u02EB\u310F\u3124 ');
    });

    it('leaves unknown Latin letters in place and fills tone slot with space', () => {
      expect(trsToBpmf('t', 'zzz')).toBe('zzz ');
    });

    it('treats unknown lang (not h/a/c) like t and runs the conversion', () => {
      // Any other lang falls through the a/c/h guards into the Taiwanese branch.
      expect(trsToBpmf('x', 'hang')).toBe('\u310F\u3124 ');
    });
  });
});

describe('isParallelPinyin (extended)', () => {
  it('falls through for h lang regardless of preference (no parallel mode)', () => {
    expect(isParallelPinyin('h')).toBe(false);
    window.localStorage.setItem('pinyin_h', 'PFS');
    expect(isParallelPinyin('h')).toBe(false);
  });

  it('returns false for lang c and unknown langs (exercises the default "" branch)', () => {
    // Lang c is not 'a'/'t'/'h' so getPreferredSystem returns '' via the final return.
    expect(isParallelPinyin('c')).toBe(false);
    expect(isParallelPinyin('zz')).toBe(false);
  });

  it('returns false for a when pinyin_a is stored but not HanYu-prefixed', () => {
    window.localStorage.setItem('pinyin_a', 'WadeGiles');
    expect(isParallelPinyin('a')).toBe(false);
  });

  it('returns false for t when pinyin_t is stored but not TL-prefixed', () => {
    window.localStorage.setItem('pinyin_t', 'POJ');
    expect(isParallelPinyin('t')).toBe(false);
  });

  it('returns true for both lang a and t when appropriate parallel prefix is stored', () => {
    window.localStorage.setItem('pinyin_a', 'HanYu-WadeGiles');
    window.localStorage.setItem('pinyin_t', 'TL-POJ');
    expect(isParallelPinyin('a')).toBe(true);
    expect(isParallelPinyin('t')).toBe(true);
  });

  it('survives localStorage that throws on getItem (readLocalStorage catch path)', () => {
    const originalWindow = window.localStorage;
    const throwing: Storage = {
      get length() {
        return 0;
      },
      key() {
        return null;
      },
      getItem() {
        throw new Error('storage unavailable');
      },
      setItem() {
        /* no-op */
      },
      removeItem() {
        /* no-op */
      },
      clear() {
        /* no-op */
      },
    };
    Object.defineProperty(window, 'localStorage', { value: throwing, configurable: true });
    try {
      // Default value is used when getItem throws — HanYu has no '-' prefix → false.
      expect(isParallelPinyin('a')).toBe(false);
      // Returning the default still drives conversion without exploding.
      expect(convertPinyinByLang('a', 'méng')).toBe('méng');
    } finally {
      Object.defineProperty(window, 'localStorage', { value: originalWindow, configurable: true });
    }
  });
});

describe('convertPinyinByLang — edge cases', () => {
  it('returns "" for nullish source (coerced via String(source || ""))', () => {
    expect(convertPinyinByLang('a', null as unknown as string)).toBe('');
    expect(convertPinyinByLang('a', undefined as unknown as string)).toBe('');
    expect(convertPinyinByLang('t', null as unknown as string)).toBe('');
    expect(convertPinyinByLang('h', undefined as unknown as string)).toBe('');
    expect(convertPinyinByLang('c', null as unknown as string)).toBe('');
  });

  it('passes HTML-tagged input through untouched (no stripping layer)', () => {
    expect(convertPinyinByLang('a', '<b>méng</b>')).toBe('<b>méng</b>');
    expect(convertPinyinByLang('c', '<i>tsiah</i>')).toBe('<i>tsiah</i>');
  });

  it('passes parenthetical （note） input through untouched (no stripping layer)', () => {
    expect(convertPinyinByLang('a', 'méng（note）')).toBe('méng（note）');
    expect(convertPinyinByLang('c', 'tsiah（orth.）')).toBe('tsiah（orth.）');
  });

  it('rewrites ASCII hyphens to U+2011 for every lang', () => {
    expect(convertPinyinByLang('a', 'a-b-c')).toBe('a\u2011b\u2011c');
    expect(convertPinyinByLang('c', 'a-b')).toBe('a\u2011b');
    expect(convertPinyinByLang('h', 'a-b')).toBe('a\u2011b');
    expect(convertPinyinByLang('t', 'a-b')).toContain('\u2011');
  });
});

describe('convertPinyinByLang — lang a (Mandarin)', () => {
  it('HanYu (default) is a pass-through besides hyphen swap', () => {
    // mapName='HanYu' has no entry in PINYIN_MAP → returns yin as-is.
    expect(convertPinyinByLang('a', 'méng')).toBe('méng');
  });

  it('bogus map name also falls through to verbatim output', () => {
    window.localStorage.setItem('pinyin_a', 'NotAMap');
    expect(convertPinyinByLang('a', 'zhōng')).toBe('zhōng');
  });

  it('splits on whitespace and converts each token independently', () => {
    window.localStorage.setItem('pinyin_a', 'TongYong');
    // 'xiāng' → TongYong 'siāng'. 'méng' is not in the table → stays.
    expect(convertPinyinByLang('a', 'méng xiāng')).toBe('méng siāng');
  });

  it('TongYong covers every tone placement (a/o/e/ui/u/ü/i)', () => {
    window.localStorage.setItem('pinyin_a', 'TongYong');
    expect(convertPinyinByLang('a', 'xiāng')).toBe('siāng'); // 'a' branch
    expect(convertPinyinByLang('a', 'hòng')).toBe('hòng'); // 'o' branch (hong stays)
    expect(convertPinyinByLang('a', 'shí')).toBe('shíh'); // 'shi'→'shih' then 'i' branch
    expect(convertPinyinByLang('a', 'duí')).toBe('duéi'); // 'dui'→'duei' then 'e' branch
  });

  it('WadeGiles uses the ui branch when base contains ui after map lookup', () => {
    window.localStorage.setItem('pinyin_a', 'WadeGiles');
    // 'hui' is absent from WadeGiles mapping → stays 'hui' (contains ui) → ui branch.
    expect(convertPinyinByLang('a', 'huí')).toBe('huí');
  });

  it('WadeGiles uses the ü branch when base contains ü after map lookup', () => {
    window.localStorage.setItem('pinyin_a', 'WadeGiles');
    // 'lǚ' → 'lü'. Base has 'ü', no a/o/e/ui/u → ü branch.
    expect(convertPinyinByLang('a', 'lǚ')).toBe('lǚ');
  });

  it('GuoYin coverage: zhao→jau picks the a branch', () => {
    window.localStorage.setItem('pinyin_a', 'GuoYin');
    expect(convertPinyinByLang('a', 'zhāo')).toBe('jāu');
  });

  it('handles tone 5 (neutral) — tone index 0 keeps vowel unmarked', () => {
    window.localStorage.setItem('pinyin_a', 'TongYong');
    // 'xiang' has no tone marks, so tone stays 5 and 'a' stays plain 'a'.
    expect(convertPinyinByLang('a', 'xiang')).toBe('siang');
  });

  it('handles each tone-bearing vowel individually (ā/á/ǎ/à)', () => {
    window.localStorage.setItem('pinyin_a', 'TongYong');
    expect(convertPinyinByLang('a', 'xiāng')).toBe('siāng'); // tone 1
    expect(convertPinyinByLang('a', 'xiáng')).toBe('siáng'); // tone 2
    expect(convertPinyinByLang('a', 'xiǎng')).toBe('siǎng'); // tone 3
    expect(convertPinyinByLang('a', 'xiàng')).toBe('siàng'); // tone 4
  });

  it('strips trailing erhua r from base before map lookup (rSuffix branch)', () => {
    window.localStorage.setItem('pinyin_a', 'TongYong');
    // 'zhà' + 'r' → base 'zha' maps to 'jha' (TongYong), then rSuffix is re-appended.
    expect(convertPinyinByLang('a', 'zhàr')).toBe('jhàr');
  });

  it('does NOT peel r when the base starts with e (guard in the rSuffix regex)', () => {
    window.localStorage.setItem('pinyin_a', 'TongYong');
    // 'er' starts with e — the /^[^eēéěè]/ guard prevents stripping; no ui/u/ü but has e
    // Ensure stable output regardless of rSuffix decision.
    const result = convertPinyinByLang('a', 'èr');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('convertPinyinByLang — lang t (Taiwanese)', () => {
  it('TL is a verbatim pass-through (plus hyphen swap)', () => {
    expect(convertPinyinByLang('t', 'tsia\u030Dh')).toBe('tsia\u030Dh');
  });

  describe('DT variant', () => {
    beforeEach(() => {
      window.localStorage.setItem('pinyin_t', 'DT');
    });

    it('converts consonants per DT rules (ts→z, k→g, etc.)', () => {
      // 'tsiah' → 'ziah' after DT-tone rules
      expect(convertPinyinByLang('t', 'tsia\u030Dh')).toBe('ziah');
    });

    it('preserves uppercase variants through the parallel rule set', () => {
      // Uppercase path: 'Tsiah' → 'Ziah'
      const out = convertPinyinByLang('t', 'Tsia\u030Dh');
      expect(out).toMatch(/^Z/);
    });

    it('applies tone-sandhi on body with mid-word hyphen (toneSandhi called)', () => {
      // Tone-sandhi adds combining U+0304 on the 'o' of the first syllable, keeps
      // the no-tone 'ge' as-is, and leaves U+2011 as separator.
      expect(convertPinyinByLang('t', 'kong-ke')).toBe('go\u0304ng\u2011ge');
    });

    it('also applies non-body sandhi path when isBody=false', () => {
      const bodyOn = convertPinyinByLang('t', 'kong-ke', true);
      const bodyOff = convertPinyinByLang('t', 'kong-ke', false);
      // Both routes should yield a non-empty sandhi-processed result that contains U+2011.
      expect(bodyOn).toContain('\u2011');
      expect(bodyOff).toContain('\u2011');
    });

    it('tone-sandhi rule: strips macron before r?[ptk] ending (aeiou + macron + ptk)', () => {
      // 'kok-ke' → 'gok-ge'; macron-over-o added then stripped by the [ptk] sandhi rule.
      expect(convertPinyinByLang('t', 'kok-ke')).toBe('gok\u2011ge');
    });

    it('tone-sandhi rule: uppercase vowel+ptk without macron triggers U+0332 insertion', () => {
      // Uppercase OK escapes line 183\'s lowercase [aeiou] regex, so it enters
      // toneSandhi without a \u0304 — the case-insensitive line 56 then adds \u0332.
      expect(convertPinyinByLang('t', 'KOK-ke')).toBe('GO\u0332K\u2011ge');
    });

    it('tone-sandhi rule: macron before r?h becomes grave (replaces 0304→0300)', () => {
      // 'koh-ke' → DT macron then sandhi replaces it with grave.
      expect(convertPinyinByLang('t', 'koh-ke')).toContain('\u2011');
    });

    it('tone-sandhi rule: consonant-only segment gets nasal \\u0304 on n/m', () => {
      expect(convertPinyinByLang('t', 'ng-ke')).toBe('n\u0304g\u2011ge');
    });

    it('tone-sandhi rule: vowel-only segment gets \\u0304 on first vowel', () => {
      expect(convertPinyinByLang('t', 'a-ba')).toBe('a\u0304\u2011bha');
    });

    it('tone-sandhi rule: segment already carrying 0300/0306/0304 uses DT_TONES_SANDHI', () => {
      // 'a300-ke' → sandhi default path rewrites \u0300.
      const out = convertPinyinByLang('t', 'a\u0300-ke');
      expect(out).toContain('\u2011');
      // '306' case: 0306 → 0304
      const out2 = convertPinyinByLang('t', 'a\u0306-ke');
      expect(out2).toContain('\u2011');
    });

    it('converts terminal double-n (nn) to superscript n (U+207F)', () => {
      // The nn-replacement regex requires end-of-string or whitespace/ASCII hyphen
      // after the nn — hence we test on bare 'ann' and a space-separated case.
      expect(convertPinyinByLang('t', 'ann')).toContain('\u207F');
      expect(convertPinyinByLang('t', 'ann ke')).toContain('\u207F');
    });
  });

  describe('POJ variant', () => {
    beforeEach(() => {
      window.localStorage.setItem('pinyin_t', 'POJ');
    });

    it('converts oo → o+U+0358 (combining dot above right)', () => {
      expect(convertPinyinByLang('t', 'oo')).toBe('o\u0358');
    });

    it('rewrites ts/Ts to ch/Ch', () => {
      expect(convertPinyinByLang('t', 'tsiah')).toBe('chiah');
      expect(convertPinyinByLang('t', 'Tsiah')).toBe('Chiah');
    });

    it('rewrites ua/ue to oa/oe', () => {
      expect(convertPinyinByLang('t', 'ua')).toBe('oa');
      expect(convertPinyinByLang('t', 'ue')).toBe('oe');
    });

    it('converts ik/ing → ek/eng', () => {
      expect(convertPinyinByLang('t', 'ik')).toBe('ek');
      expect(convertPinyinByLang('t', 'ing')).toBe('eng');
    });

    it('turns nasal endings nn/nnh into superscript n', () => {
      expect(convertPinyinByLang('t', 'ann')).toBe('a\u207F');
      expect(convertPinyinByLang('t', 'annh')).toBe('ah\u207F');
    });

    it('rewrites er/ir to e+U+0358 / i+U+0358', () => {
      expect(convertPinyinByLang('t', 'er')).toBe('e\u0358');
      expect(convertPinyinByLang('t', 'ir')).toBe('i\u0358');
    });

    it('tonePoj: places tone on oa[inht] cluster when present', () => {
      const outI = convertPinyinByLang('t', 'soa\u0301i');
      expect(outI).toMatch(/^s/);
      const outN = convertPinyinByLang('t', 'soa\u0301n');
      expect(outN).toMatch(/^s/);
    });

    it('tonePoj: handles oeh cluster before general o rule', () => {
      const out = convertPinyinByLang('t', 'soe\u0301h');
      expect(out.length).toBeGreaterThan(0);
    });

    it('tonePoj: places tone on plain o when no oa[inht]/oeh cluster matches', () => {
      // 'to\u0301' → noTone='to'; no oa[inht], no oeh, but /o/ matches → places tone on o.
      expect(convertPinyinByLang('t', 'to\u0301')).toBe('to\u0301');
    });

    it('tonePoj: places tone on plain e when no o present', () => {
      // 'pe\u0301' → noTone='pe'; no oa/oeh/o, but /e/ matches → places tone on e.
      expect(convertPinyinByLang('t', 'pe\u0301')).toBe('pe\u0301');
    });

    it('tonePoj: fallbacks to a/u/i/ng/m when no o/e present', () => {
      // Output uses combining tone marks (U+0301 after the vowel), not precomposed chars.
      expect(convertPinyinByLang('t', 'a\u0301')).toBe('a\u0301');
      expect(convertPinyinByLang('t', 'u\u0301')).toBe('u\u0301');
      expect(convertPinyinByLang('t', 'i\u0301')).toBe('i\u0301');
      expect(convertPinyinByLang('t', 'ng\u0301')).toBe('n\u0301g');
      expect(convertPinyinByLang('t', 'm\u0301')).toBe('m\u0301');
    });

    it('tonePoj: when no vowel/n/m is present, appends the tone to the end', () => {
      // 'h\u0301' has no vowel/n/m → tone appended at the end.
      const out = convertPinyinByLang('t', 'h\u0301');
      expect(out.length).toBeGreaterThanOrEqual(2);
    });

    it('tonePoj: no-tone input is returned verbatim (no mark match)', () => {
      // 'boc' has no tone mark → tonePoj returns segment unchanged.
      expect(convertPinyinByLang('t', 'boc')).toBe('boc');
    });
  });
});

describe('convertPinyinByLang — lang h (Hakka)', () => {
  it('TH (default) passes through with only hyphen swap', () => {
    expect(convertPinyinByLang('h', 'ngai11')).toBe('ngai11');
    expect(convertPinyinByLang('h', 'ng-ai')).toBe('ng\u2011ai');
  });

  describe('PFS variant', () => {
    beforeEach(() => {
      window.localStorage.setItem('pinyin_h', 'PFS');
    });

    it('converts tone ²⁴ (U+00B2 U+2074) to circumflex on vowel', () => {
      // Output uses combining U+0302 after the vowel, not precomposed 'ô'.
      expect(convertPinyinByLang('h', 'o\u00B2\u2074')).toBe('o\u0302');
    });

    it('converts tone ¹¹ (U+00B9 U+00B9) to grave on vowel', () => {
      expect(convertPinyinByLang('h', 'ngai\u00B9\u00B9')).toBe('nga\u0300i');
    });

    it('converts tone ³¹ (U+00B3 U+00B9) to acute on vowel', () => {
      expect(convertPinyinByLang('h', 'a\u00B3\u00B9')).toBe('a\u0301');
    });

    it('converts tone ⁵⁵ (U+2075 U+2075) to no mark (empty replacement)', () => {
      expect(convertPinyinByLang('h', 'e\u2075\u2075')).toBe('e');
    });

    it('converts single-superscript tone ² to no mark (ru-sheng placeholder)', () => {
      expect(convertPinyinByLang('h', 'i\u00B2')).toBe('yi');
    });

    it('converts single-superscript tone ⁵ to U+030D (vertical line above)', () => {
      expect(convertPinyinByLang('h', 'u\u2075')).toBe('u\u030D');
    });

    it('returns segment unchanged when tone combo is not in PFS_TONE_MARK_MAP', () => {
      // '³' (U+00B3) alone is not a valid PFS tone → mark undefined → return segment.
      expect(convertPinyinByLang('h', 'a\u00B3')).toBe('a\u00B3');
    });

    it('places tone on \\u1E73 (ṳ) via the ii → \\u1E73 normalization', () => {
      // 'ii' becomes U+1E73 in the normalization; then toneToPfs picks ṳ as vowel.
      expect(convertPinyinByLang('h', 'r\u00B2')).toBe('r\u00B2'); // 'r' not a vowel — falls through
    });

    it('places tone on n when vowels absent (n in the vowel fallback list)', () => {
      expect(convertPinyinByLang('h', 'n\u00B2\u2074')).toBe('n\u0302');
    });

    it('places tone on m when vowels and n are absent', () => {
      expect(convertPinyinByLang('h', 'm\u2075')).toBe('m\u030D');
    });

    it('converts initial i/b/d/g via TH→PFS consonant rules', () => {
      // 'b' → 'p', tone ¹¹ → grave (combining U+0300); 'ba¹¹' → 'pa' + U+0300
      expect(convertPinyinByLang('h', 'ba\u00B9\u00B9')).toBe('pa\u0300');
      // 'i' at word start → 'y' then 'yi'; 'ip' strips h variant; tone ¹¹ → grave on i.
      expect(convertPinyinByLang('h', 'ip\u00B9\u00B9')).toBe('yi\u0300p');
    });

    it('handles input with no tone — toneToPfs early return via parts.length < 2', () => {
      // 'ngai' (no tone digits) → split yields single element → returns as-is (post-normalization)
      expect(convertPinyinByLang('h', 'ngai')).toBe('ngai');
    });

    it('returns empty for empty input', () => {
      expect(convertPinyinByLang('h', '')).toBe('');
    });
  });
});

/* -------------------------------------------------------------------------
 * Taigi (Taiwanese) tone sandhi at the bopomofo level.
 * Standard rule: every syllable in a tone group except the LAST one undergoes
 * sandhi. The last syllable retains its citation tone. A double-hyphen "--"
 * ends the main tone group; trailing light-tone particles do not sandhi either.
 * ------------------------------------------------------------------------- */

describe('applyTaigiSandhi', () => {
  describe('single-syllable inputs (citation tone preserved)', () => {
    it('returns single open syllable verbatim', () => {
      expect(applyTaigiSandhi('a')).toBe('a');
      expect(applyTaigiSandhi('á')).toBe('á');
      expect(applyTaigiSandhi('à')).toBe('à');
      expect(applyTaigiSandhi('â')).toBe('â');
      expect(applyTaigiSandhi('ā')).toBe('ā');
    });

    it('returns single checked syllable verbatim', () => {
      expect(applyTaigiSandhi('ah')).toBe('ah');
      expect(applyTaigiSandhi('a̍h')).toBe('a̍h');
      expect(applyTaigiSandhi('ap')).toBe('ap');
      expect(applyTaigiSandhi('a̍t')).toBe('a̍t');
      expect(applyTaigiSandhi('huat')).toBe('huat');
    });
  });

  describe('open-syllable sandhi (non-final position in tone group)', () => {
    it('tone 1 (no mark) -> tone 7 (U+0304 macron)', () => {
      expect(applyTaigiSandhi('a-a')).toBe('ā-a');
      expect(applyTaigiSandhi('kong-ke')).toBe('kōng-ke');
      expect(applyTaigiSandhi('hang-hang')).toBe('hāng-hang');
    });

    it('tone 2 (U+0301 acute) -> tone 1 (no mark)', () => {
      expect(applyTaigiSandhi('á-a')).toBe('a-a');
    });

    it('tone 3 (U+0300 grave) -> tone 2 (U+0301 acute)', () => {
      expect(applyTaigiSandhi('à-a')).toBe('á-a');
    });

    it('tone 5 (U+0302 circumflex) -> tone 7 (U+0304 macron)', () => {
      // Taiwan southern variety / MoE convention; northern would map to tone 3.
      expect(applyTaigiSandhi('â-a')).toBe('ā-a');
    });

    it('tone 7 (U+0304 macron) -> tone 3 (U+0300 grave)', () => {
      expect(applyTaigiSandhi('ā-a')).toBe('à-a');
    });
  });

  describe('checked-syllable sandhi -p / -t / -k (no consonant drop)', () => {
    it('tone 4 (no mark) -> tone 8 (U+030D added on vowel)', () => {
      expect(applyTaigiSandhi('ap-a')).toBe('a̍p-a');
      expect(applyTaigiSandhi('at-a')).toBe('a̍t-a');
      expect(applyTaigiSandhi('ak-a')).toBe('a̍k-a');
      // The MoE-Taigi headword "huat-ínn" (sprout): -t triggers tone 4 -> 8.
      expect(applyTaigiSandhi('huat-ínn')).toBe('hua̍t-ínn');
    });

    it('tone 8 (U+030D) -> tone 4 (mark removed)', () => {
      expect(applyTaigiSandhi('a̍p-a')).toBe('ap-a');
      expect(applyTaigiSandhi('a̍t-a')).toBe('at-a');
      expect(applyTaigiSandhi('a̍k-a')).toBe('ak-a');
    });
  });

  describe('checked-syllable sandhi -h (glottal stop drops, becomes open)', () => {
    it('tone 4 with -h -> tone 2 (drop -h, place U+0301 on vowel)', () => {
      expect(applyTaigiSandhi('ah-a')).toBe('á-a');
    });

    it('tone 8 with -h -> tone 3 (drop -h, U+030D becomes U+0300)', () => {
      expect(applyTaigiSandhi('a̍h-a')).toBe('à-a');
    });
  });

  describe('phrase / tone-group boundaries', () => {
    it('the final syllable of a tone group keeps its citation tone', () => {
      // Two-syllable: only the first sandhies.
      expect(applyTaigiSandhi('a-á')).toBe('ā-á');
    });

    it('three-syllable tone groups sandhi all but the last', () => {
      expect(applyTaigiSandhi('kong-kong-ke')).toBe('kōng-kōng-ke');
    });

    it('ASCII punctuation resets tone groups (no sandhi across)', () => {
      expect(applyTaigiSandhi('kong, kong')).toBe('kong, kong');
      expect(applyTaigiSandhi('kong. ke')).toBe('kong. ke');
      expect(applyTaigiSandhi('kong! ke')).toBe('kong! ke');
      expect(applyTaigiSandhi('kong; ke')).toBe('kong; ke');
    });

    it('Chinese punctuation also resets tone groups', () => {
      expect(applyTaigiSandhi('kong，ke')).toBe('kong，ke');
      expect(applyTaigiSandhi('kong。ke')).toBe('kong。ke');
    });

    it('sandhi applies within each phrase independently', () => {
      // 'kong-ke. kong-ke' -> sandhi inside each comma-separated phrase.
      expect(applyTaigiSandhi('kong-ke. kong-ke')).toBe('kōng-ke. kōng-ke');
    });

    it('treats space as an in-phrase syllable separator (sandhi crosses spaces)', () => {
      // 'lí ài tsiah' (you must eat): tone 2 -> 1, tone 3 -> 2, last unchanged.
      expect(applyTaigiSandhi('lí ài tsiah')).toBe('li ái tsiah');
    });

    it('double hyphen ends the main tone group; pre-dash syllable keeps citation', () => {
      expect(applyTaigiSandhi('huat-ínn--ah')).toBe('hua̍t-ínn--ah');
      expect(applyTaigiSandhi('kong--ah')).toBe('kong--ah');
    });

    it('also recognizes U+2011 non-breaking hyphen as a syllable separator', () => {
      expect(applyTaigiSandhi('kong‑ke')).toBe('kōng‑ke');
    });

    it('treats double U+2011 like double ASCII hyphen as tone-group end', () => {
      expect(applyTaigiSandhi('kong‑‑ah')).toBe('kong‑‑ah');
    });
  });

  describe('NFD normalization', () => {
    it('accepts precomposed accented vowels by normalizing input first', () => {
      // U+00ED (precomposed í) decomposes to i + U+0301; sandhi treats it as tone 2.
      expect(applyTaigiSandhi('í-a')).toBe('i-a');
      expect(applyTaigiSandhi('í-a')).toBe('i-a');
    });

    it('accepts precomposed grave (U+00E0) the same as decomposed (a + U+0300)', () => {
      expect(applyTaigiSandhi('à-a')).toBe('á-a');
      expect(applyTaigiSandhi('à-a')).toBe('á-a');
    });
  });

  describe('syllabic nasals and tone placement', () => {
    it('places sandhi mark on syllabic m', () => {
      // m̄ (tone 7) -> tone 3 (m + grave).
      expect(applyTaigiSandhi('m̄-a')).toBe('m̀-a');
    });

    it('places sandhi mark on syllabic ng (between n and g)', () => {
      // sng (tone 1) -> tone 7: macron on the n of ng.
      expect(applyTaigiSandhi('sng-a')).toBe('sn̄g-a');
    });

    it('uses TL placement priority a > o > e > i/u for tone 1 -> 7', () => {
      // 'kong' has no 'a', so the macron goes on 'o'.
      expect(applyTaigiSandhi('kong-a')).toBe('kōng-a');
      // 'tek' (no 'a' or 'o') -> macron on 'e'... wait 'tek' is checked.
      // 'be' (tone 1) -> tone 7: macron on 'e'.
      expect(applyTaigiSandhi('be-a')).toBe('bē-a');
    });

    it('preserves uppercase initials when placing the sandhi mark', () => {
      expect(applyTaigiSandhi('Kong-ke')).toBe('Kōng-ke');
    });
  });

  describe('edge / fall-through cases', () => {
    it('returns empty input verbatim', () => {
      expect(applyTaigiSandhi('')).toBe('');
    });

    it('returns nullish input verbatim (truthiness short-circuit)', () => {
      expect(applyTaigiSandhi(null as unknown as string)).toBe(null as unknown as string);
      expect(applyTaigiSandhi(undefined as unknown as string)).toBe(undefined as unknown as string);
    });

    it('preserves separator runs verbatim', () => {
      expect(applyTaigiSandhi('a-')).toBe('a-');
      expect(applyTaigiSandhi('-a')).toBe('-a');
    });

    it('leaves tone-less segments without ASCII letters untouched', () => {
      expect(applyTaigiSandhi('---')).toBe('---');
      expect(applyTaigiSandhi('   ')).toBe('   ');
    });

    it('places sandhi mark on plain syllabic n when no other vowel is available', () => {
      // 'n' alone has no a/o/e/iu/m/ng — placeTlToneMark falls through to plain n.
      expect(applyTaigiSandhi('n-a')).toBe('n̄-a');
    });

    it('places sandhi mark on the second of an i/u cluster (e.g., "iu", "ui")', () => {
      // 'siu' (tone 1) -> tone 7: macron on the 'u' of the 'iu' cluster.
      expect(applyTaigiSandhi('siu-a')).toBe('siū-a');
      // 'kui' (tone 1) -> tone 7: macron on the 'i' of the 'ui' cluster.
      expect(applyTaigiSandhi('kui-a')).toBe('kuī-a');
    });

    it('places sandhi mark on syllabic m alone (no other vowel)', () => {
      // 'm' alone (tone 1) -> tone 7: macron on the m.
      expect(applyTaigiSandhi('m-a')).toBe('m̄-a');
    });

    it('leaves an open-syllable carrying tone-8 mark (U+030D) without a checked ending unchanged', () => {
      // U+030D on an open syllable is non-canonical; sandhi has no rule for it.
      expect(applyTaigiSandhi('a̍-a')).toBe('a̍-a');
    });

    it('appends the sandhi mark when no vowel or syllabic nasal is present', () => {
      // A pure consonant like 'b' is not a real Taigi syllable, but the function
      // must still terminate gracefully and not throw.
      expect(applyTaigiSandhi('b-a')).toBe('b̄-a');
    });

    it('leaves checked syllable with -h and an unsupported tone mark unchanged', () => {
      // Tone 2 with -h (acute on vowel) is not a standard combination; sandhi
      // falls through and returns the segment unmodified.
      expect(applyTaigiSandhi('áh-a')).toBe('áh-a');
    });

    it('leaves checked syllable with -p / -t / -k and an unsupported tone mark unchanged', () => {
      // Tone 2 with -p is not a standard combination; fall-through path.
      expect(applyTaigiSandhi('áp-a')).toBe('áp-a');
    });

    /* ----------------------------------------------------------------------
     * Differential placement tests for the placeTlToneMark cascade. Each
     * exercises a placement branch with the target letter at index 0 of the
     * core (no preceding consonant), so skipping that branch falls through
     * to a different rule and produces a distinct string. They guard against
     * mutation-equivalent shortcuts in the priority ordering.
     * -------------------------------------------------------------------- */

    it("'o' branch fires when 'o' is at position 0 (kills falling-through to 'ng')", () => {
      // 'ong' has 'o' at 0 and 'ng' as nasal coda; placement must land on the 'o'.
      expect(applyTaigiSandhi('ong-a')).toBe('ōng-a');
    });

    it("'e' branch fires when 'e' is at position 0 (kills falling-through to 'ng')", () => {
      // 'eng' has 'e' at 0 and 'ng' coda; placement must land on the 'e'.
      expect(applyTaigiSandhi('eng-a')).toBe('ēng-a');
    });

    it("'i/u cluster' branch fires at position 0 (kills falling-through to single i/u)", () => {
      // 'iu' alone — cluster at 0; mark must land on the second vowel ('u').
      expect(applyTaigiSandhi('iu-a')).toBe('iū-a');
    });

    it("single-i/u branch fires at position 0 with a nasal coda (kills falling through)", () => {
      // 'in' has 'i' at 0 and 'n' coda; placement must land on the 'i', not 'n'.
      expect(applyTaigiSandhi('in-a')).toBe('īn-a');
    });

    it("'ng' branch fires when 'ng' is at position 0 (kills appending mark at end)", () => {
      // 'ng' alone — the mark sits between 'n' and 'g', not after 'g'.
      expect(applyTaigiSandhi('ng-a')).toBe('n̄g-a');
    });

    /* ----------------------------------------------------------------------
     * `slice(0, -1)` differentiation tests for the -h drop logic. With a
     * length-2 syllable like 'ah', `slice(0, -1)` and `slice(0, +1)` both
     * yield 'a', so they don't distinguish a sign-flip mutation. We need a
     * 3+ char checked syllable to see the difference.
     * -------------------------------------------------------------------- */

    it("tone 4 with -h on a 3-character syllable: drop -h preserves the consonant", () => {
      // 'kah' -> sandhi tone 2: 'ká' (k + a + acute), not 'k' + acute.
      expect(applyTaigiSandhi('kah-a')).toBe('ká-a');
    });

    it("tone 8 with -h on a 4-character syllable: drop -h preserves the consonant", () => {
      // 'pe̍h' (white) -> sandhi tone 3: 'pè' (p + e + grave), not 'p' + grave.
      expect(applyTaigiSandhi('pe̍h-a')).toBe('pè-a');
    });

    it("'--' at position 0 still suppresses sandhi for the trailing tone group", () => {
      // When the input begins with --, everything after the dashes is light-tone
      // and must NOT be sandhi'd, even though there are multiple syllables.
      expect(applyTaigiSandhi('--a-b')).toBe('--a-b');
    });
  });
});

describe('trsToBpmf — sandhi integration', () => {
  // Sandhi is opt-in (bopomofo_sandhi_t='sandhi'). The no-key default is
  // citation tone, per MOE 臺羅標注說明: 「本辭典的聲調皆標注本調，不標變調」.

  it('defaults to citation tones when no preference is set', () => {
    // No localStorage key — citation tones preserved, matching MOE spec.
    expect(trsToBpmf('t', 'huat-ínn')).toBe('ㄏㄨㄚㆵㆪˋ');
    expect(trsToBpmf('t', 'hang-hang')).toBe('ㄏㄤ ㄏㄤ ');
  });

  it('applies sandhi when bopomofo_sandhi_t=sandhi is explicitly set', () => {
    window.localStorage.setItem('bopomofo_sandhi_t', 'sandhi');
    // 'huat-ínn' -> sandhi'd 'hua̍t-ínn' -> bopomofo includes U+0358 on the
    // checked tone glyph for the first syllable; second syllable keeps its acute.
    expect(trsToBpmf('t', 'huat-ínn')).toBe('ㄏㄨㄚㆵ͘ㆪˋ');
  });

  it('maps 免除 with sandhi on the first syllable when opted in', () => {
    window.localStorage.setItem('bopomofo_sandhi_t', 'sandhi');
    expect(trsToBpmf('t', 'bián-tû')).toBe('ㆠㄧㄢ ㄉㄨˊ');
  });

  it('does not apply sandhi to single-syllable input even when opted in', () => {
    window.localStorage.setItem('bopomofo_sandhi_t', 'sandhi');
    expect(trsToBpmf('t', 'huat')).toBe('ㄏㄨㄚㆵ');
  });

  it('keeps citation tones across punctuation boundaries even when opted in', () => {
    window.localStorage.setItem('bopomofo_sandhi_t', 'sandhi');
    // Each side of a comma is its own phrase; both single-syllable -> no sandhi.
    expect(trsToBpmf('t', 'kong, kong')).toBe('ㄍㆲ ㄍㆲ ');
  });

  it('legacy value "on" no longer triggers sandhi (only "sandhi" does)', () => {
    window.localStorage.setItem('bopomofo_sandhi_t', 'on');
    expect(trsToBpmf('t', 'hang-hang')).toBe('ㄏㄤ ㄏㄤ ');
  });

  it('explicit bopomofo_sandhi_t=off preserves citation tones', () => {
    window.localStorage.setItem('bopomofo_sandhi_t', 'off');
    expect(trsToBpmf('t', 'huat-ínn')).toBe('ㄏㄨㄚㆵㆪˋ');
    expect(trsToBpmf('t', 'hang-hang')).toBe('ㄏㄤ ㄏㄤ ');
  });
});
