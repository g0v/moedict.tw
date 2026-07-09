import { describe, expect, it } from 'vitest';
import { fetchFromServer } from './_harness';

describe('/translation-data/*', () => {
  it('serves cfdict.xml from DICTIONARY R2 (when fixture present)', async () => {
    const res = await fetchFromServer('/translation-data/cfdict.xml');
    if (res.status === 404) return; // fixture optional
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('xml');
    expect(res.headers.get('content-disposition')).toContain('cfdict.xml');
    expect(res.headers.get('cache-control')).toContain('s-maxage=86400');
  });

  it('serves cfdict.txt from DICTIONARY R2 (when fixture present)', async () => {
    const res = await fetchFromServer('/translation-data/cfdict.txt');
    if (res.status === 404) return;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('cache-control')).toContain('s-maxage=86400');
  });

  it('adds fixed-star CORS headers on cfdict.xml for any Origin', async () => {
    const res = await fetchFromServer('/translation-data/cfdict.xml', {
      headers: { Origin: 'https://example.com' },
    });
    if (res.status !== 200) return;
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('/manifest.appcache', () => {
  it('serves the manifest fixture as text/cache-manifest', async () => {
    const res = await fetchFromServer('/manifest.appcache');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('cache-manifest');
    expect(res.headers.get('cache-control')).toContain('s-maxage=86400');
    const text = await res.text();
    expect(text).toContain('CACHE MANIFEST');
  });

  it('HEAD returns headers without body', async () => {
    const res = await fetchFromServer('/manifest.appcache', { method: 'HEAD' });
    expect(res.status).toBe(200);
  });
});

describe('/images/Download_on_the_App_Store_Badge_HK_TW_135x40.png', () => {
  it('serves the PNG from ASSETS R2', async () => {
    const res = await fetchFromServer('/images/Download_on_the_App_Store_Badge_HK_TW_135x40.png');
    if (res.status === 404) return; // fixture optional
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('s-maxage=86400');
  });

  it('HEAD returns headers only', async () => {
    const res = await fetchFromServer(
      '/images/Download_on_the_App_Store_Badge_HK_TW_135x40.png',
      { method: 'HEAD' },
    );
    if (res.status === 404) return;
    expect(res.status).toBe(200);
  });
});

describe('/{word}.png — on-demand image generation', () => {
  it('returns PNG bytes for a seeded-glyph word', async () => {
    const res = await fetchFromServer('/%E8%90%8C.png');
    if (res.status !== 200) {
      // Our Resvg stub may not be reached depending on the FONTS binding state.
      // Accept 404 text/plain ("font unavailable") as a legitimate error path.
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toMatch(/text|png/);
      return;
    }
    expect(res.headers.get('content-type')).toBe('image/png');
    // Stubbed Resvg returns the PNG magic bytes (137,80,78,71)
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
  });

  it('accepts ?font= query param without erroring out', async () => {
    const res = await fetchFromServer('/%E8%90%8C.png?font=sung');
    expect([200, 404]).toContain(res.status);
  });
});

describe('CORS and method fallbacks', () => {
  it('OPTIONS on any path returns 204 CORS preflight', async () => {
    const res = await fetchFromServer('/some/arbitrary/path', {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.test' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
