/**
 * Direct-call tests for src/utils/dictionary-route.ts — the shared
 * `'`/`:`/`~` language-prefix URL-scheme helpers used by worker/index.ts's
 * HTML-shell head injection and by the src/oembed/* handlers.
 *
 * Moved out of tests/unit/worker-helpers.test.ts when these functions were
 * extracted from worker/index.ts so the oEmbed feature could reuse them
 * without a worker → src/oembed → worker import cycle.
 */

import { describe, expect, it } from 'vitest';
import {
  buildDefinitionDescription,
  buildDictionaryPathname,
  parseDictionaryRoute,
  stripTags,
} from '../../src/utils/dictionary-route';

describe('stripTags', () => {
  it('coerces null/undefined to empty string', () => {
    expect(stripTags(null as unknown as string)).toBe('');
    expect(stripTags(undefined as unknown as string)).toBe('');
    expect(stripTags('' as string)).toBe('');
  });

  it('removes HTML tags and collapses whitespace', () => {
    expect(stripTags('<b>hello</b>  world')).toBe('hello world');
    expect(stripTags('  <p>line\n\nbreak</p>  ')).toBe('line break');
  });
});

describe('parseDictionaryRoute', () => {
  it('returns null for empty or slash-only paths', () => {
    expect(parseDictionaryRoute('/')).toBeNull();
    expect(parseDictionaryRoute('')).toBeNull();
    expect(parseDictionaryRoute('///')).toBeNull();
  });

  it('coerces falsy pathname via String(... || "")', () => {
    expect(parseDictionaryRoute(null as unknown as string)).toBeNull();
    expect(parseDictionaryRoute(undefined as unknown as string)).toBeNull();
  });

  it('returns null for about, radicals, lists, and "=*" meta routes', () => {
    expect(parseDictionaryRoute('/about')).toBeNull();
    expect(parseDictionaryRoute('/about.html')).toBeNull();
    expect(parseDictionaryRoute('/@部首')).toBeNull();
    expect(parseDictionaryRoute('/~@部首')).toBeNull();
    expect(parseDictionaryRoute('/=成語')).toBeNull();
    expect(parseDictionaryRoute("/'=諺語")).toBeNull();
    expect(parseDictionaryRoute('/:=諺語')).toBeNull();
    expect(parseDictionaryRoute('/~=異名')).toBeNull();
    expect(parseDictionaryRoute("/'=*star")).toBeNull();
    expect(parseDictionaryRoute('/:=*star')).toBeNull();
    expect(parseDictionaryRoute('/~=*star')).toBeNull();
    expect(parseDictionaryRoute('/=*star')).toBeNull();
  });

  it('extracts lang and text from prefixed paths', () => {
    expect(parseDictionaryRoute("/'食")).toEqual({ lang: 't', text: '食' });
    expect(parseDictionaryRoute('/:字')).toEqual({ lang: 'h', text: '字' });
    expect(parseDictionaryRoute('/~萌')).toEqual({ lang: 'c', text: '萌' });
    expect(parseDictionaryRoute('/萌')).toEqual({ lang: 'a', text: '萌' });
  });

  it('parses a trailing /<digits> as the legacy definition-index permalink (g0v/moedict.tw#131)', () => {
    expect(parseDictionaryRoute('/萌/2')).toEqual({ lang: 'a', text: '萌', idx: 2 });
    expect(parseDictionaryRoute("/'食/1")).toEqual({ lang: 't', text: '食', idx: 1 });
    expect(parseDictionaryRoute('/:字/10')).toEqual({ lang: 'h', text: '字', idx: 10 });
    expect(parseDictionaryRoute('/~萌/3')).toEqual({ lang: 'c', text: '萌', idx: 3 });
  });

  it('idx is undefined (not present) when there is no trailing /<digits>', () => {
    const result = parseDictionaryRoute('/萌');
    expect(result?.idx).toBeUndefined();
  });

  it('still rejects non-word routes even with a trailing /<digits> — idx is ignored, not a bypass', () => {
    expect(parseDictionaryRoute('/about/2')).toBeNull();
    expect(parseDictionaryRoute('/@木/2')).toBeNull();
    expect(parseDictionaryRoute('/=成語/2')).toBeNull();
  });

  it('a word that is itself all-digits is not misparsed as text+idx (no separating slash)', () => {
    expect(parseDictionaryRoute('/123')).toEqual({ lang: 'a', text: '123' });
  });

  it('decode-fails closed to null instead of throwing on malformed % escapes', () => {
    // A lone `%` (or any invalid percent-escape) makes decodeURIComponent
    // throw URIError. This path is reachable with fully attacker-supplied
    // input via the oEmbed `?url=` query parameter, so it must not 500.
    expect(parseDictionaryRoute('/%')).toBeNull();
    expect(parseDictionaryRoute('/%E8%90')).toBeNull();
    expect(parseDictionaryRoute("/'%")).toBeNull();
  });
});

describe('buildDefinitionDescription', () => {
  it('returns null when entry is null or has no heteronyms', () => {
    expect(buildDefinitionDescription(null)).toBeNull();
    expect(buildDefinitionDescription({})).toBeNull();
    expect(buildDefinitionDescription({ heteronyms: [] })).toBeNull();
  });

  it('skips heteronyms whose definitions is not an array', () => {
    const entry = {
      heteronyms: [
        { definitions: 'not-an-array' as unknown as Array<{ def?: string }> },
        { definitions: [{ def: '有效定義' }] },
      ],
    };
    expect(buildDefinitionDescription(entry)).toBe('有效定義。');
  });

  it('treats missing/empty def as falsy and filters them out', () => {
    const entry = {
      heteronyms: [
        { definitions: [{ def: '' }, { def: '實際定義' }, {}] },
      ],
    };
    expect(buildDefinitionDescription(entry)).toBe('實際定義。');
  });

  it('returns null when every definition is empty after stripping', () => {
    const entry = {
      heteronyms: [
        { definitions: [{ def: '<br>' }, { def: '   ' }, { def: '' }] },
      ],
    };
    expect(buildDefinitionDescription(entry)).toBeNull();
  });

  it('breaks after the 4th def in a single heteronym', () => {
    const entry = {
      heteronyms: [
        {
          definitions: [
            { def: '一' }, { def: '二' }, { def: '三' }, { def: '四' }, { def: '五' },
          ],
        },
      ],
    };
    expect(buildDefinitionDescription(entry)).toBe('一。二。三。四。');
  });

  it('breaks the outer heteronym loop once 4 defs accumulated', () => {
    const entry = {
      heteronyms: [
        { definitions: [{ def: '一' }, { def: '二' }] },
        { definitions: [{ def: '三' }, { def: '四' }] },
        { definitions: [{ def: '五' }] },
      ],
    };
    expect(buildDefinitionDescription(entry)).toBe('一。二。三。四。');
  });

  it('truncates sentences longer than 180 chars with an ellipsis', () => {
    const longDef = 'あ'.repeat(200);
    const entry = { heteronyms: [{ definitions: [{ def: longDef }] }] };
    const out = buildDefinitionDescription(entry);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(180);
    expect(out!.endsWith('…')).toBe(true);
  });

  it('short sentences pass through untruncated', () => {
    const entry = { heteronyms: [{ definitions: [{ def: '短定義' }] }] };
    expect(buildDefinitionDescription(entry)).toBe('短定義。');
  });
});

describe('buildDictionaryPathname', () => {
  it('is the inverse of parseDictionaryRoute for each lang prefix', () => {
    expect(buildDictionaryPathname('a', '萌')).toBe('/%E8%90%8C');
    expect(buildDictionaryPathname('t', '食')).toBe("/'%E9%A3%9F");
    expect(buildDictionaryPathname('h', '字')).toBe('/:%E5%AD%97');
    expect(buildDictionaryPathname('c', '萌')).toBe('/~%E8%90%8C');
    // Round-trips back through parseDictionaryRoute (which decodes).
    expect(parseDictionaryRoute(buildDictionaryPathname('t', '食'))).toEqual({ lang: 't', text: '食' });
  });

  it('percent-encodes the word', () => {
    expect(buildDictionaryPathname('a', 'a b')).toBe('/a%20b');
  });
});
