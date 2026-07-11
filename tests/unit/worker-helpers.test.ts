/**
 * Direct-call tests for `shouldRenderHtmlShell` in `worker/index.ts` —
 * the `/api/` and `.json` defensive guards that `dispatch`'s
 * integration-shaped tests can't reach through normal flows (dispatch's
 * earlier branches already catch these paths, so these are in-function
 * safety-net cases).
 *
 * `stripTags` / `parseDictionaryRoute` / `buildDefinitionDescription` were
 * extracted to src/utils/dictionary-route.ts and are covered by
 * tests/unit/dictionary-route.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { shouldRenderHtmlShell } from '../../worker/index';

describe('shouldRenderHtmlShell', () => {
  const url = (pathname: string) => new URL(`http://localhost${pathname}`);
  const req = (method = 'GET') => new Request('http://localhost/', { method });

  it('returns false for /api/ paths (line 127 defensive guard)', () => {
    expect(shouldRenderHtmlShell(req(), url('/api/config'))).toBe(false);
  });

  it('returns false for .json paths (line 128 defensive guard)', () => {
    expect(shouldRenderHtmlShell(req(), url('/something.json'))).toBe(false);
  });

  it('returns false for /assets/ paths', () => {
    expect(shouldRenderHtmlShell(req(), url('/assets/foo.css'))).toBe(false);
  });

  it('returns false for Vite-internal requests', () => {
    expect(shouldRenderHtmlShell(req(), url('/@vite/client'))).toBe(false);
    expect(shouldRenderHtmlShell(req(), url('/node_modules/x'))).toBe(false);
    expect(shouldRenderHtmlShell(req(), url('/foo?import'))).toBe(false);
    expect(shouldRenderHtmlShell(req(), url('/foo?raw'))).toBe(false);
    expect(shouldRenderHtmlShell(req(), url('/foo?url'))).toBe(false);
    expect(shouldRenderHtmlShell(req(), url('/foo?worker_file'))).toBe(false);
    expect(shouldRenderHtmlShell(req(), url('/foo?html-proxy'))).toBe(false);
  });

  it('does not treat /@<radical> app routes as Vite-internal (regression: g0v/moedict.tw#131 follow-up)', () => {
    // /@vite/, /@fs/, /@id/, /@react-refresh are the real Vite dev-server
    // namespaces; a bare /@ prefix also matches moedict's own radical
    // routes and must render the HTML shell, not be excluded.
    expect(shouldRenderHtmlShell(req(), url('/@vite/client'))).toBe(false);
    expect(shouldRenderHtmlShell(req(), url('/@fs/etc/passwd'))).toBe(false);
    expect(shouldRenderHtmlShell(req(), url('/@id/some-module'))).toBe(false);
    expect(shouldRenderHtmlShell(req(), url('/@react-refresh'))).toBe(false);
    expect(shouldRenderHtmlShell(req(), url('/@木'))).toBe(true);
    expect(shouldRenderHtmlShell(req(), url('/@'))).toBe(true);
    expect(shouldRenderHtmlShell(req(), url('/~@木'))).toBe(true);
  });

  it('returns false for non-GET/HEAD methods', () => {
    expect(shouldRenderHtmlShell(req('POST'), url('/about'))).toBe(false);
    expect(shouldRenderHtmlShell(req('DELETE'), url('/about'))).toBe(false);
  });

  it('returns false for file-extension paths (except .html)', () => {
    expect(shouldRenderHtmlShell(req(), url('/foo.txt'))).toBe(false);
    expect(shouldRenderHtmlShell(req(), url('/bundle.css'))).toBe(false);
  });

  it('returns true for /about.html and /index.html', () => {
    expect(shouldRenderHtmlShell(req(), url('/about.html'))).toBe(true);
    expect(shouldRenderHtmlShell(req(), url('/index.html'))).toBe(true);
  });

  it('returns true for bare paths (dictionary words, about route, root)', () => {
    expect(shouldRenderHtmlShell(req(), url('/'))).toBe(true);
    expect(shouldRenderHtmlShell(req(), url('/about'))).toBe(true);
    expect(shouldRenderHtmlShell(req(), url('/萌'))).toBe(true);
  });

  it('returns true for HEAD on a shell route', () => {
    expect(shouldRenderHtmlShell(req('HEAD'), url('/about'))).toBe(true);
  });
});
