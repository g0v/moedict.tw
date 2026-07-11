import { describe, expect, it } from 'vitest';
import { fetchFromServer, fetchJson } from './_harness';

/**
 * End-to-end check of the tokenless oEmbed feature against the real
 * Miniflare-backed worker (real dispatch(), real R2-shaped fixtures) —
 * complements the mocked direct-call tests in
 * tests/unit/oembed-handlers.test.ts and tests/unit/worker-dispatch-edges.test.ts.
 */

interface OEmbedPayload {
  version: string;
  type: string;
  provider_name: string;
  title: string;
  html: string;
  width: number;
  height: number;
  thumbnail_url: string;
}

describe('GET /api/oembed', () => {
  it('returns a tokenless oEmbed 1.0 rich payload for a real dictionary entry', async () => {
    const { status, body, headers } = await fetchJson<OEmbedPayload>(
      `/api/oembed?url=${encodeURIComponent('https://www.moedict.tw/萌')}`,
    );
    expect(status).toBe(200);
    expect(headers.get('access-control-allow-origin')).toBe('*');
    expect(body.version).toBe('1.0');
    expect(body.type).toBe('rich');
    expect(body.title).toBe('萌');
    expect(body.html).toContain('<iframe');
    expect(body.html).toContain('src="https://www.moedict.tw/embed/%E8%90%8C"');
  });

  it('works for the t/h/c language prefixes too', async () => {
    const cases: Array<[string, string]> = [
      ["https://www.moedict.tw/'食", '食'],
      ['https://www.moedict.tw/:字', '字'],
      ['https://www.moedict.tw/~上訴', '上訴'],
    ];
    for (const [url, expectedTitle] of cases) {
      const { status, body } = await fetchJson<OEmbedPayload>(`/api/oembed?url=${encodeURIComponent(url)}`);
      expect(status).toBe(200);
      expect(body.title).toBe(expectedTitle);
    }
  });

  it('404s for an unknown entry, and for a non-entry route like /about', async () => {
    const missing = await fetchJson<{ error: string }>(
      `/api/oembed?url=${encodeURIComponent('https://www.moedict.tw/不存在詞')}`,
    );
    expect(missing.status).toBe(404);

    const about = await fetchJson<{ error: string }>(
      `/api/oembed?url=${encodeURIComponent('https://www.moedict.tw/about')}`,
    );
    expect(about.status).toBe(404);
  });

  it('400s without a url param, 404s for a disallowed host', async () => {
    const noUrl = await fetchFromServer('/api/oembed');
    expect(noUrl.status).toBe(400);

    const badHost = await fetchFromServer(`/api/oembed?url=${encodeURIComponent('https://evil.example.com/萌')}`);
    expect(badHost.status).toBe(404);
  });
});

describe('GET /embed/<word>', () => {
  it('serves a self-contained HTML card for a real dictionary entry', async () => {
    const res = await fetchFromServer('/embed/%E8%90%8C');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<h1>萌</h1>');
    // No app bundle, no client JS — the whole point of a dedicated
    // embed subtree instead of pointing the iframe at the full SPA.
    expect(html).not.toContain('<script');
    expect(html).toContain('target="_blank"');
  });

  it('404s for an unknown word with a "not found" card, not the SPA shell', async () => {
    const res = await fetchFromServer('/embed/%E4%B8%8D%E5%AD%98%E5%9C%A8%E8%A9%9E');
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('找不到這個詞條。');
  });
});
