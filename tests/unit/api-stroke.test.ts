import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleStrokeAPI } from '../../src/api/handleStrokeAPI';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeRequest(pathname: string): { request: Request; url: URL } {
  const url = new URL(`http://localhost${pathname}`);
  const request = new Request(url.toString());
  return { request, url };
}

const corsHeaders = { 'Access-Control-Allow-Origin': '*' };

describe('handleStrokeAPI validation', () => {
  it.each([
    '/api/stroke-json/../etc/passwd.json',
    '/api/stroke-json/xyz.json',
    '/api/stroke-json/1234567.json', // 7 hex chars exceeds 4-6
    '/api/stroke-json/123.json',     // 3 hex chars
    '/api/stroke-json/840c',         // no .json
    '/api/stroke-json/nested/840c.json',
  ])('returns 400 for invalid codepoint %s', async (path) => {
    const { request, url } = makeRequest(path);
    const response = await handleStrokeAPI(request, url, corsHeaders);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ error: 'Bad Request' });
  });

  it('calls upstream CDN for valid 4-hex codepoint', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"strokes":[]}', { status: 200 })) as typeof fetch;

    const { request, url } = makeRequest('/api/stroke-json/840c.json');
    const response = await handleStrokeAPI(request, url, corsHeaders);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toMatch(/json/);
    expect(response.headers.get('Cache-Control')).toContain('s-maxage=86400');
    expect(response.headers.get('Cache-Control')).toContain('max-age=3600');
    expect(response.headers.get('Cache-Tag')).toBe('stroke');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/840c.json'),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('accepts 5 and 6 hex codepoints', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
    for (const cp of ['840c.json', '20000.json', '2a700.json']) {
      const { request, url } = makeRequest(`/api/stroke-json/${cp}`);
      const response = await handleStrokeAPI(request, url, corsHeaders);
      expect(response.status).toBe(200);
    }
  });

  it('returns 404 when upstream returns non-OK', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 404 })) as typeof fetch;
    const { request, url } = makeRequest('/api/stroke-json/ffff.json');
    const response = await handleStrokeAPI(request, url, corsHeaders);
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Not Found');
  });

  it('returns 502 on fetch rejection', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const { request, url } = makeRequest('/api/stroke-json/840c.json');
    const response = await handleStrokeAPI(request, url, corsHeaders);
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe('Proxy Error');
  });
});
