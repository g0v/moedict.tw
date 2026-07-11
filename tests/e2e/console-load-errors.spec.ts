import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import { expect, test } from './_fixtures';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STYLES_CSS_PATH = path.join(REPO_ROOT, 'data', 'assets', 'styles.css');

const EDUKAI_URL_PATTERN = '**/assets-legacy/fonts/edukai-*.ttf';
const BIAUKAI_URL_PATTERN = '**/BiauKai.ttf*';

// Intercept legacy styles.css the same way legacy-styles-regression.spec.ts does,
// serving the current working-tree data/assets/styles.css so the MOEDICT-IOS-KAI
// @font-face is present and exercises the BiauKai src URL.
// Returns a thunk that reports whether the intercepted CSS was actually requested,
// so callers can prove the BiauKai no-request assertion is non-vacuous.
async function routeStylesCss(page: Page): Promise<() => boolean> {
  const css = readFileSync(STYLES_CSS_PATH, 'utf-8');
  let loaded = false;
  const handler = (route: Route) => {
    loaded = true;
    return route.fulfill({
      status: 200,
      contentType: 'text/css; charset=utf-8',
      headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
      body: css,
    });
  };
  await page.route('https://r2-assets.test.local/styles.css', handler);
  await page.route('**/assets/styles.css', handler);
  // When window.Capacitor is set, offline-api.ts intercepts /api/config and
  // returns assetBaseUrl: '/assets-legacy', so AssetLoader loads CSS from
  // /assets-legacy/styles.css — intercept that path too.
  await page.route('**/assets-legacy/styles.css', handler);
  return () => loaded;
}

// Collect console.error messages, excluding noise from the fixture's intentional
// r2-*.test.local 404 blocker (those 404s are harness artifacts, not the
// EduKai/BiauKai behavior under test). App-origin errors (127.0.0.1, localhost,
// or any non-r2 host) are always retained.
function collectConsoleErrors(page: Page, consoleErrors: string[]): void {
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const loc = msg.location();
    const locUrl = loc.url ?? '';
    if (locUrl) {
      try {
        if (new URL(locUrl).hostname === 'r2-assets.test.local') return;
      } catch {
        // Not a parseable URL — keep the message (could be a JS runtime error).
      }
    }
    consoleErrors.push(msg.text());
  });
}

// Block CSS sub-resources that would DNS-fail (same as legacy-styles-regression
// blockCssSubresources) so networkidle can fire.
async function blockCssSubresources(page: Page): Promise<void> {
  const notFound = (route: Route) =>
    route.fulfill({ status: 404, contentType: 'text/plain; charset=utf-8', body: '' });
  await page.route('**/assets/fonts/**', notFound);
  await page.route('**/assets/images/leather_x2.jpg', notFound);
  await page.route('**/assets/images/subtle_stripes_x2.png', notFound);
}

test.describe('console load errors — EduKai 404 and BiauKai decode', () => {
  test('normal web load: no EduKai fetch, no console.error, no BiauKai decode', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const edukaiRequests: string[] = [];
    const biaukaiRequests: string[] = [];

    collectConsoleErrors(page, consoleErrors);
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await blockCssSubresources(page);
    const stylesCssLoaded = await routeStylesCss(page);

    // Intercept EduKai requests (record without DNS-fail) — fulfill with 404
    // so the browser logs the error we're testing for, but networkidle fires.
    await page.route(EDUKAI_URL_PATTERN, (route) => {
      edukaiRequests.push(route.request().url());
      return route.fulfill({ status: 404, contentType: 'text/plain', body: '' });
    });
    // Intercept BiauKai requests — fulfill as 0-byte font/ttf to reproduce
    // the production R2 behavior (R2 serves a 0-byte body with font/ttf
    // content-type, causing "Failed to decode downloaded font" warnings).
    await page.route(BIAUKAI_URL_PATTERN, (route) => {
      biaukaiRequests.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: 'font/ttf',
        body: Buffer.alloc(0),
      });
    });

    // Ensure NO window.Capacitor (normal web)
    await page.addInitScript(() => {
      // @ts-expect-error -- deliberately delete for normal-web simulation
      delete window.Capacitor;
    });

    await page.goto('/%E8%90%8C');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);

    // Sanity: the intercepted legacy styles.css must have actually loaded —
    // otherwise the BiauKai no-request assertion is vacuous (the @font-face
    // that triggers the fetch lives in that stylesheet).
    expect(stylesCssLoaded(), 'legacy styles.css must be loaded to exercise BiauKai @font-face').toBe(true);

    // Deterministically exercise the MOEDICT-IOS-KAI @font-face (whose src
    // is the 0-byte BiauKai URL) via document.fonts.load. The title font
    // stack lists Biaukai (local) before MOEDICT-IOS-KAI, so on macOS the
    // browser may resolve Biaukai locally and never attempt the URL —
    // document.fonts.load forces the browser to evaluate the named face
    // directly, guaranteeing a URL fetch if the @font-face has a url() src.
    // Also append a probe element whose sole family is MOEDICT-IOS-KAI.
    await page.evaluate(async () => {
      const probe = document.createElement('span');
      probe.style.fontFamily = 'MOEDICT-IOS-KAI';
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.textContent = '字';
      document.body.appendChild(probe);
      // Force the browser to attempt loading the MOEDICT-IOS-KAI face.
      try {
        await document.fonts.load('16px "MOEDICT-IOS-KAI"', '字');
      } catch {
        // load() rejects on decode failure — expected for 0-byte font.
      }
      await document.fonts.ready;
    });

    // --- BiauKai assertion (non-vacuous: document.fonts.load exercised the face) ---
    // RED evidence: in the pre-fix state, biaukaiRequests MUST be non-empty
    // (the @font-face src is a url(), so document.fonts.load triggers a
    // network fetch). If this is empty, the assertion is vacuous — the
    // @font-face was never exercised. After Task 2 changes src to
    // local(BiauKai), no URL request is made and this passes.
    // Use expect.soft so both BiauKai and EduKai failures are reported
    // in a single RED run (both are independent root causes).
    expect.soft(biaukaiRequests, 'normal web load must NOT request the 0-byte BiauKai URL').toEqual([]);

    // --- EduKai assertions ---
    expect.soft(edukaiRequests, 'normal web load must NOT request the EduKai font').toEqual([]);
    expect(consoleErrors, 'normal web load must have zero console.error').toEqual([]);
    expect(pageErrors, 'normal web load must have zero pageerror').toEqual([]);

    // Computed font-family on .result .entry .title must NOT start with
    // "MOE EduKai Android" — it should fall through to system Kaiti.
    const titleFontFamily = await page.evaluate(() => {
      const el = document.querySelector('.result .entry .title');
      return el ? getComputedStyle(el).fontFamily : null;
    });
    expect(titleFontFamily, 'title element must exist on the page').not.toBeNull();
    expect(titleFontFamily, 'title font-family must NOT include MOE EduKai Android on web')
      .not.toContain('MOE EduKai Android');
  });

  test('Capacitor-simulated load: moe-capacitor class present, EduKai in font stack', async ({ page }) => {
    const consoleErrors: string[] = [];
    collectConsoleErrors(page, consoleErrors);

    await blockCssSubresources(page);
    const stylesCssLoaded = await routeStylesCss(page);

    // Simulate Capacitor runtime BEFORE the app's main.tsx runs
    await page.addInitScript(() => {
      // @ts-expect-error -- simulating Capacitor webview runtime
      window.Capacitor = { isNative: true, getPlatform: () => 'ios' };
    });

    await page.goto('/%E8%90%8C');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);

    // moe-capacitor class must be present on <html>
    const hasCapacitorClass = await page.evaluate(() =>
      document.documentElement.classList.contains('moe-capacitor')
    );
    // Sanity: the intercepted legacy styles.css must have actually loaded —
    // otherwise the font-family assertions are vacuous (the @font-face and
    // legacy font stacks live in that stylesheet).
    expect(stylesCssLoaded(), 'legacy styles.css must be loaded to exercise font stacks').toBe(true);
    expect(hasCapacitorClass, 'html must have moe-capacitor class when window.Capacitor is set').toBe(true);

    // Computed font-family on .result .entry .title MUST include "MOE EduKai Android"
    const titleFontFamily = await page.evaluate(() => {
      const el = document.querySelector('.result .entry .title');
      return el ? getComputedStyle(el).fontFamily : null;
    });
    expect(titleFontFamily, 'title element must exist').not.toBeNull();
    expect(titleFontFamily, 'Capacitor load must include MOE EduKai Android in computed font-family')
      .toContain('MOE EduKai Android');

    // No console errors from the Capacitor load either (the @font-face is
    // present but the font file at /assets-legacy/ is intercepted by the
    // test server; in real Capacitor it would be bundled locally).
    // Note: we don't assert zero console errors here because the test server
    // 404s the font file — the assertion is about the CSS stack, not the
    // actual font fetch in the test environment.
  });
});
