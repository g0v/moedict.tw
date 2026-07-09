import { describe, expect, it } from 'vitest';
import { fetchFromServer, fetchJson } from './_harness';

describe('server smoke', () => {
  it('/api/config returns configured URLs', async () => {
    const { status, body } = await fetchJson<{ assetBaseUrl?: string; dictionaryBaseUrl?: string }>(
      '/api/config',
    );
    expect(status).toBe(200);
    expect(body.assetBaseUrl).toBe('https://r2-assets.test.local');
    expect(body.dictionaryBaseUrl).toBe('https://r2-dictionary.test.local');
  });

  it('OPTIONS preflight returns 204 with CORS headers', async () => {
    const res = await fetchFromServer('/api/config', {
      method: 'OPTIONS',
      headers: { Origin: 'https://www.moedict.tw' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });
});
