import { describe, expect, it } from 'vitest';
import {
  normalizeLookupTerm,
  parsePinyinLookupPath,
  parseTrsLookupPath,
} from '../../src/api/handleLookupAPI';

describe('normalizeLookupTerm', () => {
  it('lowercases and strips diacritics via NFD', () => {
    expect(normalizeLookupTerm('ZHŌNG')).toBe('zhong');
    expect(normalizeLookupTerm('méng')).toBe('meng');
  });

  it('keeps letters only, drops digits and punctuation', () => {
    expect(normalizeLookupTerm('a-b.c 4')).toBe('abc');
    expect(normalizeLookupTerm('tsia̍h!')).toBe('tsiah');
  });

  it('maps superscript n → nn', () => {
    expect(normalizeLookupTerm('aⁿ')).toBe('ann');
  });

  it('normalises alternative α/ɑ to a', () => {
    expect(normalizeLookupTerm('hɑi')).toBe('hai');
  });

  it('handles empty / null', () => {
    expect(normalizeLookupTerm('')).toBe('');
    expect(normalizeLookupTerm(null as unknown as string)).toBe('');
  });
});

describe('parsePinyinLookupPath', () => {
  it.each([
    ['/api/lookup/pinyin/a/HanYu/meng.json', { lang: 'a', type: 'HanYu', term: 'meng' }],
    ['/api/lookup/pinyin/t/TL/tsiah.json', { lang: 't', type: 'TL', term: 'tsiah' }],
    ['/api/lookup/pinyin/h/TH/ngai.json', { lang: 'h', type: 'TH', term: 'ngai' }],
    ['/api/lookup/pinyin/c/HanYu/meng.json', { lang: 'c', type: 'HanYu', term: 'meng' }],
  ])('parses %s', (path, expected) => {
    expect(parsePinyinLookupPath(path)).toEqual(expected);
  });

  it('normalises diacritics inside the term segment', () => {
    const res = parsePinyinLookupPath('/api/lookup/pinyin/a/HanYu/ZHŌNG.json');
    expect(res?.term).toBe('zhong');
  });

  it('decodes percent-encoded type', () => {
    const res = parsePinyinLookupPath('/api/lookup/pinyin/t/TL-DT/tsiah.json');
    expect(res?.type).toBe('TL-DT');
  });

  it('rejects unknown lang', () => {
    expect(parsePinyinLookupPath('/api/lookup/pinyin/x/HanYu/meng.json')).toBeNull();
  });

  it('rejects missing segments', () => {
    expect(parsePinyinLookupPath('/api/lookup/pinyin/a//meng.json')).toBeNull();
    expect(parsePinyinLookupPath('/api/lookup/pinyin/a/HanYu/.json')).toBeNull();
    expect(parsePinyinLookupPath('/api/lookup/pinyin/a/HanYu/meng')).toBeNull();
  });
});

describe('parseTrsLookupPath', () => {
  it('parses /api/lookup/trs/<term>', () => {
    expect(parseTrsLookupPath('/api/lookup/trs/tsiah')).toEqual({ term: 'tsiah' });
  });

  it('parses legacy /lookup/trs/<term>', () => {
    expect(parseTrsLookupPath('/lookup/trs/tsiah')).toEqual({ term: 'tsiah' });
  });

  it('normalises diacritics from the term', () => {
    expect(parseTrsLookupPath('/api/lookup/trs/TSIA%CC%8AH')).toEqual({ term: 'tsiah' });
  });

  it('returns null for unrelated paths', () => {
    expect(parseTrsLookupPath('/foo')).toBeNull();
    expect(parseTrsLookupPath('/api/lookup/pinyin/a/HanYu/meng.json')).toBeNull();
  });

  it('returns null when term normalises to empty', () => {
    expect(parseTrsLookupPath('/api/lookup/trs/4321')).toBeNull();
  });
});

describe('malformed percent-encoding fails closed (no throw)', () => {
  it('parsePinyinLookupPath returns null for undecodable term or type', () => {
    expect(parsePinyinLookupPath('/api/lookup/pinyin/t/TL/%.json')).toBeNull();
    expect(parsePinyinLookupPath('/api/lookup/pinyin/t/%/tsiah.json')).toBeNull();
  });

  it('parseTrsLookupPath returns null for undecodable terms on both route shapes', () => {
    expect(parseTrsLookupPath('/api/lookup/trs/%')).toBeNull();
    expect(parseTrsLookupPath('/lookup/trs/%')).toBeNull();
  });
});
