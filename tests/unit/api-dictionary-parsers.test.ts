import { describe, expect, it } from 'vitest';
import {
  addBopomofo2,
  bucketOf,
  convertPuaToCharCode,
  convertPuaToIDS,
  parseSubRoute,
  parseTextFromUrl,
  performFuzzySearch,
} from '../../src/api/handleDictionaryAPI';

describe('parseSubRoute', () => {
  it.each([
    ['/a/萌.json', 'a', '萌'],
    ['/t/食.json', 't', '食'],
    ['/h/字.json', 'h', '字'],
    ['/c/上訴.json', 'c', '上訴'],
    ['/raw/萌.json', 'raw', '萌'],
    ['/uni/萌.json', 'uni', '萌'],
    ['/pua/萌.json', 'pua', '萌'],
  ])('parses %s', (path, routeType, text) => {
    expect(parseSubRoute(path)).toEqual({ routeType, text });
  });

  it('decodes percent-encoded word in path', () => {
    expect(parseSubRoute('/a/%E8%90%8C.json')).toEqual({ routeType: 'a', text: '萌' });
  });

  it.each([
    ['/a/萌', 'a', '萌'],
    ['/t/食', 't', '食'],
    ['/h/字', 'h', '字'],
    ['/c/上訴', 'c', '上訴'],
    ['/raw/萌', 'raw', '萌'],
    ['/uni/萌', 'uni', '萌'],
    ['/pua/萌', 'pua', '萌'],
  ])('also parses the README-documented bare form (no .json): %s', (path, routeType, text) => {
    // README.md's own example URLs (e.g. https://www.moedict.tw/raw/萌) omit
    // .json; both forms must resolve to the same routeType/text.
    expect(parseSubRoute(path)).toEqual({ routeType, text });
  });

  it('returns null for non-matching paths', () => {
    expect(parseSubRoute('/萌.json')).toBeNull();
    expect(parseSubRoute('/api/萌.json')).toBeNull();
    expect(parseSubRoute('/x/萌.json')).toBeNull(); // unsupported lang
    expect(parseSubRoute('/x/萌')).toBeNull(); // unsupported lang, bare form
  });
});

describe('parseTextFromUrl', () => {
  it('handles /api/<word>.json form', () => {
    expect(parseTextFromUrl('/api/萌.json')).toEqual({ lang: 'a', cleanText: '萌' });
  });

  it("handles /'<word> → t", () => {
    expect(parseTextFromUrl('/api/%27食.json')).toEqual({ lang: 't', cleanText: '食' });
  });

  it('handles /:word → h', () => {
    expect(parseTextFromUrl('/api/%3A字.json')).toEqual({ lang: 'h', cleanText: '字' });
  });

  it('handles /~word → c', () => {
    expect(parseTextFromUrl('/api/~上訴.json')).toEqual({ lang: 'c', cleanText: '上訴' });
  });

  it('handles legacy /!word → t (hash-bang era alias)', () => {
    expect(parseTextFromUrl('/api/!食.json')).toEqual({ lang: 't', cleanText: '食' });
  });

  it('handles /<lang>/<word>.json slash-separated form', () => {
    expect(parseTextFromUrl('/api/a/萌.json')).toEqual({ lang: 'a', cleanText: '萌' });
    expect(parseTextFromUrl('/api/t/食.json')).toEqual({ lang: 't', cleanText: '食' });
  });

  it('handles legacy ! → t prefix', () => {
    expect(parseTextFromUrl('/api/!食.json')).toEqual({ lang: 't', cleanText: '食' });
  });

  it('passes @ and = segments through (routing done upstream)', () => {
    expect(parseTextFromUrl('/api/@木.json')).toEqual({ lang: 'a', cleanText: '@木' });
    expect(parseTextFromUrl('/api/=近義詞.json')).toEqual({ lang: 'a', cleanText: '=近義詞' });
  });
});

describe('bucketOf', () => {
  it('returns literal segment for @ and = prefixes', () => {
    expect(bucketOf('@木', 'a')).toBe('@');
    expect(bucketOf('=近義詞', 'a')).toBe('=');
  });

  it('computes modulo 1024 for lang "a"', () => {
    const code = '萌'.charCodeAt(0); // 0x840C = 33804
    expect(bucketOf('萌', 'a')).toBe(String(code % 1024));
  });

  it('computes modulo 128 for non-a langs', () => {
    const code = '食'.charCodeAt(0);
    expect(bucketOf('食', 't')).toBe(String(code % 128));
    expect(bucketOf('食', 'h')).toBe(String(code % 128));
    expect(bucketOf('食', 'c')).toBe(String(code % 128));
  });

  it('handles surrogate-pair (astral) codepoints', () => {
    const astral = String.fromCodePoint(0x1F600); // emoji
    const result = bucketOf(astral, 'a');
    expect(/^\d+$/.test(result)).toBe(true);
  });
});

describe('performFuzzySearch', () => {
  it('splits a multi-character string into individual characters', async () => {
    expect(await performFuzzySearch('萌芽')).toEqual(['萌', '芽']);
  });

  it('strips backtick and tilde markers before splitting', async () => {
    expect(await performFuzzySearch('`萌~芽')).toEqual(['萌', '芽']);
  });

  it('drops whitespace chars', async () => {
    expect(await performFuzzySearch('萌 芽')).toEqual(['萌', '芽']);
  });

  it('returns single-element array if only whitespace differs', async () => {
    expect(await performFuzzySearch('萌')).toEqual(['萌']);
  });

  it('returns [] for empty input', async () => {
    expect(await performFuzzySearch('')).toEqual([]);
  });
});

describe('convertPuaToIDS', () => {
  it('replaces known PUA codepoints inside strings', () => {
    const input = {
      heteronyms: [
        { definitions: [{ def: `前${String.fromCodePoint(0xf90fd)}後` }] },
      ],
    };
    const result = convertPuaToIDS(input) as typeof input;
    expect(result.heteronyms[0].definitions[0].def).toBe('前⿺辶局後');
  });

  it('leaves non-PUA strings unchanged', () => {
    expect(convertPuaToIDS('萌')).toBe('萌');
  });

  it('walks arrays and objects recursively', () => {
    expect(convertPuaToIDS([{ a: 'x' }, ['y']])).toEqual([{ a: 'x' }, ['y']]);
  });
});

describe('convertPuaToCharCode', () => {
  it('replaces PUA chars with {[<hex>]} notation', () => {
    const input = String.fromCodePoint(0xf9264); // codePoint - 0xf0000 = 0x9264
    expect(convertPuaToCharCode(input)).toBe('{[9264]}');
  });

  it('leaves non-PUA strings unchanged', () => {
    expect(convertPuaToCharCode('萌')).toBe('萌');
  });

  it('walks nested structures', () => {
    const pua = String.fromCodePoint(0xf9064);
    const result = convertPuaToCharCode({ defs: [pua, '萌'] });
    expect(result).toEqual({ defs: ['{[9064]}', '萌'] });
  });
});

describe('addBopomofo2', () => {
  it('adds bopomofo2 field derived from bopomofo', () => {
    const result = addBopomofo2([{ bopomofo: 'ㄇㄥˊ' }]);
    expect(result[0]).toHaveProperty('bopomofo2');
    expect(typeof result[0].bopomofo2).toBe('string');
    expect((result[0].bopomofo2 as string).length).toBeGreaterThan(0);
  });

  it('encodes tone marks onto the main vowel', () => {
    const result = addBopomofo2([{ bopomofo: 'ㄇㄚˊ' }]);
    expect(result[0].bopomofo2).toBe('má');
  });

  it('passes heteronyms without bopomofo through unchanged', () => {
    const input = [{ definitions: [{ def: 'x' }] }];
    const result = addBopomofo2(input);
    expect(result[0]).not.toHaveProperty('bopomofo2');
    expect(result[0]).toEqual(input[0]);
  });

  it('keeps other fields intact', () => {
    const result = addBopomofo2([{ bopomofo: 'ㄓㄨㄤ', definitions: [{ def: '壯' }] }]);
    expect(result[0].definitions).toEqual([{ def: '壯' }]);
  });
});
