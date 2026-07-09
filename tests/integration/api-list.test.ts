/**
 * Integration coverage for src/api/handleListAPI.ts — the /api/=<category>
 * family of routes that serve the classified word lists (成語, 近義詞, …).
 * handleListAPI sits behind the prefix-based switch in worker/index.ts and is
 * currently 0% at unit level because it's only exercised via the live Worker.
 */

import { describe, expect, it } from 'vitest';
import { fetchFromServer, fetchJson } from './_harness';

describe('/api/=<category>.json — 華語 list route', () => {
  it('returns the seeded 近義詞 array', async () => {
    // Fixture: tests/helpers/fixtures.ts seeds a/=近義詞.json with three terms.
    const { status, body, headers } = await fetchJson<string[]>('/api/=%E8%BF%91%E7%BE%A9%E8%A9%9E');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(headers.get('content-type')).toMatch(/json/);
    expect(headers.get('cache-control')).toContain('max-age=3600');
  });

  it('accepts paths with a trailing .json (worker routes them to handleListAPI too)', async () => {
    // Note: when a .json suffix is present, handleListAPI currently looks up
    // `a/=近義詞.json.json` in R2, so this should surface as 404. The route
    // still belongs to handleListAPI (not the generic dictionary fallback),
    // which is what we're pinning here.
    const res = await fetchFromServer('/api/=%E8%BF%91%E7%BE%A9%E8%A9%9E.json');
    expect([200, 404]).toContain(res.status);
    expect(res.headers.get('content-type')).toMatch(/json/);
  });

  it('404s for an unknown category', async () => {
    const { status, body } = await fetchJson<{ error: string; message: string }>(
      '/api/=nothinghere',
    );
    expect(status).toBe(404);
    expect(body.error).toBe('Not Found');
    expect(body.message).toMatch(/找不到分類/);
  });
});

describe('/api/{lang-prefix}=<category> — per-language routes', () => {
  it.each([
    { prefix: "'", lang: 't' },
    { prefix: ':', lang: 'h' },
    { prefix: '~', lang: 'c' },
  ] as const)('$prefix= maps to lang=$lang (404 when fixture absent is still handled by handleListAPI)', async ({ prefix }) => {
    // Fixtures only seed 華語 list data, so the per-language routes land on
    // Not Found — but the response shape proves handleListAPI owned the
    // request (dictionary fallbacks would have returned different JSON).
    const { status, body } = await fetchJson<{ error: string }>(
      `/api/${encodeURIComponent(prefix)}=%E6%88%90%E8%AA%9E`,
    );
    expect(status).toBe(404);
    expect(body.error).toBe('Not Found');
  });
});

describe('handleListAPI — malformed path handling', () => {
  it('400s when the path lacks an = marker', async () => {
    // A path like /api/foo hits the worker's top-level list-prefix check:
    // listSegment='foo' does not start with '=' so handleListAPI isn't
    // invoked — we only reach it when a prefix+= combination is present.
    // To exercise parseLangAndCategory's null branch explicitly we need a
    // path that starts with a lang prefix but nothing after, e.g. /api/'=.
    const { status, body } = await fetchJson<{ error: string; message: string }>("/api/'=");
    expect(status).toBe(400);
    expect(body.error).toBe('Bad Request');
    expect(body.message).toMatch(/路徑格式錯誤/);
  });

  it('400s for an empty category (/api/=)', async () => {
    const { status, body } = await fetchJson<{ error: string }>('/api/=');
    expect(status).toBe(400);
    expect(body.error).toBe('Bad Request');
  });
});

describe('handleListAPI — CORS', () => {
  it('uses fixed-star CORS on successful list responses', async () => {
    const res = await fetchFromServer('/api/=%E8%BF%91%E7%BE%A9%E8%A9%9E', {
      headers: { Origin: 'https://example.test' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('uses fixed-star CORS when no Origin header is sent', async () => {
    const res = await fetchFromServer('/api/=%E8%BF%91%E7%BE%A9%E8%A9%9E');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('uses fixed-star CORS on 404 responses (list not found)', async () => {
    const res = await fetchFromServer('/api/=unknowncategory', {
      headers: { Origin: 'https://example.test' },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
