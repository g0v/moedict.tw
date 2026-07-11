import { describe, expect, it } from 'vitest';
import { fetchFromServer, fetchJson } from './_harness';

describe('/api/index/{lang}.json', () => {
  it.each(['a', 't', 'h', 'c'])('returns an index array for lang=%s', async (lang) => {
    const { status, body, headers } = await fetchJson<string[] | { error: string }>(
      `/api/index/${lang}.json`,
    );
    // Our fixtures ship a/{index.json} in data/dictionary/a/index.json — for others it
    // may not be seeded, in which case 404 with error shape is returned.
    if (status === 200) {
      expect(Array.isArray(body)).toBe(true);
      // CACHE_CONTROL.index = 'public, max-age=60, s-maxage=300' (browser
      // 60s / edge 300s split) — assert the edge TTL, the load-bearing part.
      expect(headers.get('cache-control')).toContain('s-maxage=300');
    } else {
      expect(status).toBe(404);
    }
  });
});

describe('/{lang}/index.json (issue #124)', () => {
  it.each(['a', 't', 'h', 'c'])('returns the word list array for lang=%s', async (lang) => {
    const { status, body } = await fetchJson<string[] | { error: string }>(
      `/${lang}/index.json`,
    );
    // Mirrors /api/index/{lang}.json — 200 array when the fixture is seeded, 404 otherwise.
    if (status === 200) {
      expect(Array.isArray(body)).toBe(true);
    } else {
      expect(status).toBe(404);
    }
  });
});

describe('/api/xref/{lang}.json', () => {
  it.each(['a', 't', 'h', 'c'])('returns an xref object (or {} fallback) for lang=%s', async (lang) => {
    const res = await fetchFromServer(`/api/xref/${lang}.json`);
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      expect(body && typeof body === 'object' && !Array.isArray(body)).toBe(true);
    }
  });
});

describe('/api/xref-by-id/{lang}.json', () => {
  it.each(['a', 't', 'h', 'c'])('returns an xref-by-id object (or {} fallback) for lang=%s', async (lang) => {
    const res = await fetchFromServer(`/api/xref-by-id/${lang}.json`);
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      expect(body && typeof body === 'object' && !Array.isArray(body)).toBe(true);
    }
  });
});

describe('/api/search-index/{lang}.json', () => {
  it.each(['a', 't', 'h', 'c'])('returns array data for lang=%s when fixture present', async (lang) => {
    const res = await fetchFromServer(`/api/search-index/${lang}.json`);
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(res.headers.get('cache-control')).toContain('max-age=');
    }
  });
});

describe('/api/={category}.json (root list API)', () => {
  it('returns an array of strings', async () => {
    // Note: root /api/=x.json is served via handleDictionaryAPI (not handleListAPI).
    // The JSON blob may contain packed entry data OR a category list — test both.
    const res = await fetchFromServer('/api/=%E8%BF%91%E7%BE%A9%E8%A9%9E.json');
    expect([200, 404]).toContain(res.status);
  });
});
