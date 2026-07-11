/**
 * Direct-call unit tests for the three API handlers that, until now, were
 * only exercised through the Miniflare integration harness. workerd runs in
 * a separate V8 isolate so vitest's v8 coverage collector can't see into it,
 * which is why these files previously hovered around 28-29% at unit level
 * despite being heavily used.
 *
 * The handlers take a plain `Request` + `URL` + `env` triple — no Cloudflare
 * runtime required — so we can invoke them directly with a mock R2 bucket
 * and get proper attribution without duplicating the Miniflare wiring.
 */

import { describe, expect, it } from 'vitest';
import { handleDictionaryAPI, lookupDictionaryEntry } from '../../src/api/handleDictionaryAPI';
import { handleLookupAPI } from '../../src/api/handleLookupAPI';
import { handleListAPI } from '../../src/api/handleListAPI';

interface R2Stub {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

function makeR2(entries: Record<string, string>): R2Stub {
  return {
    async get(key) {
      const payload = entries[key];
      if (payload === undefined) return null;
      return { text: async () => payload };
    },
  };
}

function makeRequest(pathname: string, init?: RequestInit): { request: Request; url: URL } {
  const url = new URL(`http://localhost${pathname}`);
  return { request: new Request(url.toString(), init), url };
}

describe('handleDictionaryAPI — top-level routing', () => {
  it('short-circuits devtools + .well-known probes with 404', async () => {
    const env = { DICTIONARY: makeR2({}) };
    const { request, url } = makeRequest('/api/com.chrome.devtools/.json');
    const res = await handleDictionaryAPI(request, url, env);
    expect(res.status).toBe(404);
  });

  it('routes /a/萌.json to the sub-route handler and returns the packed entry', async () => {
    const bucket = {
      萌: { t: '萌', h: [{ b: 'ㄇㄥˊ', d: [{ f: '草木初生的芽' }] }] },
    };
    const env = {
      DICTIONARY: makeR2({
        'pack/12.txt': JSON.stringify({ [escape('萌')]: bucket.萌 }),
      }),
    };
    const { request, url } = makeRequest('/a/%E8%90%8C.json');
    const res = await handleDictionaryAPI(request, url, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeTruthy();
  });

  it('uses fixed-star CORS and 200-only cache headers on dictionary GETs', async () => {
    const env = {
      DICTIONARY: makeR2({
        'pack/12.txt': JSON.stringify({
          [escape('萌')]: { t: '萌', h: [{ b: 'ㄇㄥˊ', d: [{ f: '草木初生的芽' }] }] },
        }),
      }),
    };
    const { request, url } = makeRequest('/a/%E8%90%8C.json');
    request.headers.set('Origin', 'https://evil.example');
    const res = await handleDictionaryAPI(request, url, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('vary')).toBeNull();
    expect(res.headers.get('cache-control')).toContain('public');
    expect(res.headers.get('cache-control')).toContain('max-age=300');
    expect(res.headers.get('cache-control')).toContain('s-maxage=86400');
    expect(res.headers.get('cache-tag')).toMatch(/\bdict\b/);
    expect(res.headers.get('cache-tag')).toMatch(/\bdict-a\b/);
  });

  it('sets 200-only cache headers on HEAD dictionary requests too', async () => {
    const env = {
      DICTIONARY: makeR2({
        'pack/12.txt': JSON.stringify({
          [escape('萌')]: { t: '萌', h: [{ b: 'ㄇㄥˊ', d: [{ f: '草木初生的芽' }] }] },
        }),
      }),
    };
    const { request, url } = makeRequest('/a/%E8%90%8C.json', { method: 'HEAD' });
    const res = await handleDictionaryAPI(request, url, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('s-maxage=86400');
    expect(res.headers.get('cache-tag')).toMatch(/\bdict-a\b/);
  });

  it('does not long-cache dictionary 404 responses', async () => {
    const env = { DICTIONARY: makeR2({}) };
    const { request, url } = makeRequest('/api/%E4%B8%8D%E5%AD%98.json');
    const res = await handleDictionaryAPI(request, url, env);
    expect(res.status).toBe(404);
    const cacheControl = res.headers.get('cache-control');
    if (cacheControl) {
      expect(cacheControl).toMatch(/no-store|max-age=0|private/i);
      expect(cacheControl).not.toMatch(/s-maxage=[1-9]/);
    }
    expect(res.headers.get('cache-tag')).toBeNull();
  });

  it('404s with a terms array when the word is unknown', async () => {
    const env = { DICTIONARY: makeR2({}) };
    const { request, url } = makeRequest('/api/%E4%B8%8D%E5%AD%98.json');
    const res = await handleDictionaryAPI(request, url, env);
    expect(res.status).toBe(404);
    const body = await res.json() as { terms?: string[] };
    expect(Array.isArray(body.terms)).toBe(true);
  });

  it('delegates @radical lookup to the radical JSON file', async () => {
    const env = {
      DICTIONARY: makeR2({
        'a/@子.json': JSON.stringify([['孜', '孟']]),
      }),
    };
    const { request, url } = makeRequest('/api/%40%E5%AD%90.json');
    const res = await handleDictionaryAPI(request, url, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([['孜', '孟']]);
  });

  it('falls back to the variant radical for 青/靑', async () => {
    const env = {
      DICTIONARY: makeR2({
        'a/@靑.json': JSON.stringify([['青']]),
      }),
    };
    const { request, url } = makeRequest('/api/%40%E9%9D%92.json');
    const res = await handleDictionaryAPI(request, url, env);
    expect(res.status).toBe(200);
  });

  it('delegates =<category> to the list JSON file', async () => {
    const env = {
      DICTIONARY: makeR2({
        'a/=近義詞.json': JSON.stringify(['一致', '相仿']),
      }),
    };
    const { request, url } = makeRequest('/api/=%E8%BF%91%E7%BE%A9%E8%A9%9E.json');
    const res = await handleDictionaryAPI(request, url, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(['一致', '相仿']);
  });

  it('serves /{lang}/index.json as the word list (issue #124)', async () => {
    const env = {
      DICTIONARY: makeR2({
        'c/index.json': JSON.stringify(['一', '一一', '一下']),
      }),
    };
    const { request, url } = makeRequest('/c/index.json');
    const res = await handleDictionaryAPI(request, url, env);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(['一', '一一', '一下']);
    // 排版：逗號後換行，每個詞彙獨立一行
    expect(text).toContain(',\n');
  });

  it('404s /{lang}/index.json when the index file is missing', async () => {
    const env = { DICTIONARY: makeR2({}) };
    const { request, url } = makeRequest('/h/index.json');
    const res = await handleDictionaryAPI(request, url, env);
    expect(res.status).toBe(404);
  });

  it('returns 500 when the R2 backend throws unexpectedly', async () => {
    const env: { DICTIONARY: R2Stub } = {
      DICTIONARY: {
        async get() {
          throw new Error('synthetic R2 failure');
        },
      },
    };
    const { request, url } = makeRequest('/api/%40%E5%AD%90.json');
    const res = await handleDictionaryAPI(request, url, env);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('Internal Server Error');
    expect(body.message).toMatch(/synthetic/);
  });

  it('normalises raw routes even when the bucket entry is a primitive', async () => {
    const env = {
      DICTIONARY: makeR2({
        'pack/12.txt': JSON.stringify({
          [escape('萌')]: 'raw-text',
        }),
      }),
    };
    const { request, url } = makeRequest('/raw/%E8%90%8C.json');
    const res = await handleDictionaryAPI(request, url, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ heteronyms: [] });
  });
});

describe('lookupDictionaryEntry', () => {
  it('returns null for @ and = prefixed inputs (handled elsewhere)', async () => {
    const env = { DICTIONARY: makeR2({}) };
    expect(await lookupDictionaryEntry('@子', 'a', env)).toBeNull();
    expect(await lookupDictionaryEntry('=近義詞', 'a', env)).toBeNull();
  });

  it('returns the processed entry with xrefs when present', async () => {
    const env = {
      DICTIONARY: makeR2({
        'pack/12.txt': JSON.stringify({
          [escape('萌')]: {
            t: '萌',
            h: [{ b: 'ㄇㄥˊ', d: [{ f: '草木初生的芽' }] }],
          },
        }),
        'a/xref.json': JSON.stringify({ t: { 萌: '發穎' } }),
      }),
    };
    const result = await lookupDictionaryEntry('萌', 'a', env);
    expect(result).toBeTruthy();
    expect(result?.xrefs).toEqual([{ lang: 't', words: ['發穎'] }]);
  });

  it('returns null when the bucket file is missing', async () => {
    const env = { DICTIONARY: makeR2({}) };
    expect(await lookupDictionaryEntry('萌', 'a', env)).toBeNull();
  });

  it('swallows malformed xref JSON and returns empty xrefs', async () => {
    const env = {
      DICTIONARY: makeR2({
        'pack/12.txt': JSON.stringify({ [escape('萌')]: { t: '萌' } }),
        'a/xref.json': 'not valid JSON',
      }),
    };
    const result = await lookupDictionaryEntry('萌', 'a', env);
    expect(result?.xrefs).toEqual([]);
  });
});

describe('handleLookupAPI', () => {
  it('returns null (no match) for paths that are not lookup routes', async () => {
    const env = { DICTIONARY: makeR2({}) };
    const { request, url } = makeRequest('/api/%E8%90%8C.json');
    expect(await handleLookupAPI(request, url, env)).toBeNull();
  });

  it('serves the pinyin JSON lookup with cache headers', async () => {
    const env = {
      DICTIONARY: makeR2({
        'lookup/pinyin/t/TL/tsiah.json': JSON.stringify(['食', '蝕']),
      }),
    };
    const { request, url } = makeRequest('/api/lookup/pinyin/t/TL/tsiah.json');
    const res = await handleLookupAPI(request, url, env);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get('content-type')).toMatch(/json/);
    expect(res!.headers.get('cache-control')).toContain('max-age');
    expect(await res!.json()).toEqual(['食', '蝕']);
  });

  it('reflects allowlisted origins on lookup responses', async () => {
    const env = {
      DICTIONARY: makeR2({
        'lookup/pinyin/t/TL/tsiah.json': JSON.stringify(['食']),
      }),
    };
    const request = {
      headers: {
        get(name: string) {
          return name === 'Origin' ? 'https://moedict.tw' : null;
        },
      },
    } as Request;
    const url = new URL('http://localhost/api/lookup/pinyin/t/TL/tsiah.json');
    const res = await handleLookupAPI(request, url, env);
    expect(res!.headers.get('access-control-allow-origin')).toBe('https://moedict.tw');
    expect(res!.headers.get('vary')).toBe('Origin');
  });

  it('returns empty array for an unknown pinyin term', async () => {
    const env = { DICTIONARY: makeR2({}) };
    const { request, url } = makeRequest('/api/lookup/pinyin/t/TL/nothing.json');
    const res = await handleLookupAPI(request, url, env);
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual([]);
  });

  it('returns empty array when the stored pinyin payload is not an array', async () => {
    const env = {
      DICTIONARY: makeR2({
        'lookup/pinyin/t/TL/object.json': JSON.stringify({ word: '食' }),
      }),
    };
    const { request, url } = makeRequest('/api/lookup/pinyin/t/TL/object.json');
    const res = await handleLookupAPI(request, url, env);
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual([]);
  });

  it('returns empty array when the stored pinyin payload is malformed JSON', async () => {
    const env = {
      DICTIONARY: makeR2({
        'lookup/pinyin/t/TL/broken.json': 'not valid JSON',
      }),
    };
    const { request, url } = makeRequest('/api/lookup/pinyin/t/TL/broken.json');
    const res = await handleLookupAPI(request, url, env);
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual([]);
  });

  it('returns null when a pinyin term normalises to empty', async () => {
    const env = { DICTIONARY: makeR2({}) };
    const { request, url } = makeRequest('/api/lookup/pinyin/t/TL/1234.json');
    expect(await handleLookupAPI(request, url, env)).toBeNull();
  });

  it('serves /api/lookup/trs/<term> as pipe-joined text', async () => {
    const env = {
      DICTIONARY: makeR2({
        'lookup/pinyin/t/TL/tsiah.json': JSON.stringify(['食', '蝕']),
      }),
    };
    const { request, url } = makeRequest('/api/lookup/trs/tsiah');
    const res = await handleLookupAPI(request, url, env);
    expect(res!.status).toBe(200);
    expect(res!.headers.get('content-type')).toMatch(/text\/plain/);
    expect(await res!.text()).toBe('食|蝕');
  });

  it('also serves the legacy /lookup/trs/<term> (no /api prefix)', async () => {
    const env = {
      DICTIONARY: makeR2({
        'lookup/pinyin/t/TL/tsiah.json': JSON.stringify(['食']),
      }),
    };
    const { request, url } = makeRequest('/lookup/trs/tsiah');
    const res = await handleLookupAPI(request, url, env);
    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe('食');
  });

  it('returns null when a legacy TRS term normalises to empty', async () => {
    const env = { DICTIONARY: makeR2({}) };
    const { request, url } = makeRequest('/lookup/trs/1234');
    expect(await handleLookupAPI(request, url, env)).toBeNull();
  });

  it('falls back to the h-language title map when per-term JSON is missing', async () => {
    const env = {
      DICTIONARY: makeR2({
        'lookup/pinyin/h/TH.json': JSON.stringify({ voi: ['會'] }),
      }),
    };
    const { request, url } = makeRequest('/api/lookup/pinyin/h/TH/voi.json');
    const res = await handleLookupAPI(request, url, env);
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual(['會']);
  });

  it('returns empty array when the h-language title map is missing', async () => {
    const env = { DICTIONARY: makeR2({}) };
    const { request, url } = makeRequest('/api/lookup/pinyin/h/TM/voi.json');
    const res = await handleLookupAPI(request, url, env);
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual([]);
  });

  it('returns empty array when the h-language title map payload is not an object', async () => {
    const env = {
      DICTIONARY: makeR2({
        'lookup/pinyin/h/TN.json': JSON.stringify([]),
      }),
    };
    const { request, url } = makeRequest('/api/lookup/pinyin/h/TN/voi.json');
    const res = await handleLookupAPI(request, url, env);
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual([]);
  });

  it('returns empty array when the h-language title map JSON is malformed', async () => {
    const env = {
      DICTIONARY: makeR2({
        'lookup/pinyin/h/TO.json': 'not valid JSON',
      }),
    };
    const { request, url } = makeRequest('/api/lookup/pinyin/h/TO/voi.json');
    const res = await handleLookupAPI(request, url, env);
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual([]);
  });

  it('skips non-array entries in the h-language title map', async () => {
    const env = {
      DICTIONARY: makeR2({
        'lookup/pinyin/h/TP.json': JSON.stringify({
          voi: ['會'],
          ignore: 'not-an-array',
        }),
      }),
    };
    const { request, url } = makeRequest('/api/lookup/pinyin/h/TP/voi.json');
    const res = await handleLookupAPI(request, url, env);
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual(['會']);
  });

  it('reuses the cached h-language title map on a second lookup', async () => {
    const env = {
      DICTIONARY: makeR2({
        'lookup/pinyin/h/TH.json': JSON.stringify({ voi: ['會'] }),
      }),
    };
    const first = makeRequest('/api/lookup/pinyin/h/TH/voi.json');
    const second = makeRequest('/api/lookup/pinyin/h/TH/voi.json');
    const firstRes = await handleLookupAPI(first.request, first.url, env);
    const secondRes = await handleLookupAPI(second.request, second.url, env);
    expect(await firstRes!.json()).toEqual(['會']);
    expect(await secondRes!.json()).toEqual(['會']);
  });

});

describe('handleListAPI', () => {
  it('400s on a malformed path', async () => {
    const env = { DICTIONARY: makeR2({}) };
    const { request, url } = makeRequest("/api/'=");
    const res = await handleListAPI(request, url, env);
    expect(res.status).toBe(400);
  });

  it('400s when the list path is not category-shaped', async () => {
    const env = { DICTIONARY: makeR2({}) };
    const { request, url } = makeRequest('/api/not-a-list');
    const res = await handleListAPI(request, url, env);
    expect(res.status).toBe(400);
  });

  it('400s when the category is empty', async () => {
    const env = { DICTIONARY: makeR2({}) };
    const { request, url } = makeRequest('/api/=');
    const res = await handleListAPI(request, url, env);
    expect(res.status).toBe(400);
  });

  it('serves the 華語 list happy path', async () => {
    const env = {
      DICTIONARY: makeR2({
        'a/=成語.json': JSON.stringify(['守株待兔', '畫蛇添足']),
      }),
    };
    const { request, url } = makeRequest('/api/=%E6%88%90%E8%AA%9E');
    const res = await handleListAPI(request, url, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(['守株待兔', '畫蛇添足']);
  });

  it('uses fixed-star CORS and cache tags on list 200s', async () => {
    const env = {
      DICTIONARY: makeR2({
        'a/=成語.json': JSON.stringify(['守株待兔', '畫蛇添足']),
      }),
    };
    const { request, url } = makeRequest('/api/=%E6%88%90%E8%AA%9E');
    request.headers.set('Origin', 'https://evil.example');
    const res = await handleListAPI(request, url, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('vary')).toBeNull();
    expect(res.headers.get('cache-control')).toContain('public');
    expect(res.headers.get('cache-control')).toContain('max-age=300');
    expect(res.headers.get('cache-control')).toContain('s-maxage=3600');
    expect(res.headers.get('cache-tag')).toMatch(/\blist\b/);
    expect(res.headers.get('cache-tag')).toMatch(/\blist-a\b/);
  });

  it('sets list cache headers on HEAD requests too', async () => {
    const env = {
      DICTIONARY: makeR2({
        'a/=成語.json': JSON.stringify(['守株待兔', '畫蛇添足']),
      }),
    };
    const { request, url } = makeRequest('/api/=%E6%88%90%E8%AA%9E', { method: 'HEAD' });
    const res = await handleListAPI(request, url, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('s-maxage=3600');
    expect(res.headers.get('cache-tag')).toMatch(/\blist-a\b/);
  });

  it('omits cache headers on non-GET/HEAD list requests', async () => {
    const env = {
      DICTIONARY: makeR2({
        'a/=成語.json': JSON.stringify(['守株待兔', '畫蛇添足']),
      }),
    };
    const { request, url } = makeRequest('/api/=%E6%88%90%E8%AA%9E', { method: 'POST' });
    const res = await handleListAPI(request, url, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBeNull();
    expect(res.headers.get('cache-tag')).toBeNull();
  });

  it('404s when the category is unknown', async () => {
    const env = { DICTIONARY: makeR2({}) };
    const { request, url } = makeRequest('/api/=unknown');
    const res = await handleListAPI(request, url, env);
    expect(res.status).toBe(404);
  });

  it('500s when the stored JSON is not an array', async () => {
    const env = {
      DICTIONARY: makeR2({
        'a/=broken.json': JSON.stringify({ not: 'an array' }),
      }),
    };
    const { request, url } = makeRequest('/api/=broken');
    const res = await handleListAPI(request, url, env);
    expect(res.status).toBe(500);
    const body = await res.json() as { message: string };
    expect(body.message).toMatch(/非陣列/);
  });

  it('500s when the stored JSON is not valid JSON', async () => {
    const env = {
      DICTIONARY: makeR2({
        'a/=broken.json': 'not JSON at all',
      }),
    };
    const { request, url } = makeRequest('/api/=broken');
    const res = await handleListAPI(request, url, env);
    expect(res.status).toBe(500);
    const body = await res.json() as { message: string };
    expect(body.message).toMatch(/格式異常/);
  });

  it('maps prefixed paths to the right lang', async () => {
    const env = {
      DICTIONARY: makeR2({
        't/=X.json': JSON.stringify(['a']),
        'h/=X.json': JSON.stringify(['b']),
        'c/=X.json': JSON.stringify(['c']),
      }),
    };
    for (const [prefix, expected] of [["'", ['a']], [':', ['b']], ['~', ['c']]] as const) {
      const { request, url } = makeRequest(`/api/${encodeURIComponent(prefix)}=X`);
      const res = await handleListAPI(request, url, env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(expected);
    }
  });

  // CORS origin mirroring is covered in tests/integration/api-list.test.ts;
  // happy-dom's Request drops the Origin header, so a direct-call unit test
  // can't exercise the `origin || '*'` branch here.
});
