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
async function routeStylesCss(page: Page): Promise<void> {
  const css = readFileSync(STYLES_CSS_PATH, 'utf-8');
  const handler = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/css; charset=utf-8',
      headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
      body: css,
    });
  await page.route('https://r2-assets.test.local/styles.css', handler);
  await page.route('**/assets/styles.css', handler);
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

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await blockCssSubresources(page);
    await routeStylesCss(page);

    // Intercept (but don't block) EduKai and BiauKai requests to record them
    // without letting them 502/DNS-fail — fulfill with 404 so the browser
    // logs the error we're testing for, but networkidle still fires.
    await page.route(EDUKAI_URL_PATTERN, (route) => {
      edukaiRequests.push(route.request().url());
      return route.fulfill({ status: 404, contentType: 'text/plain', body: '' });
    });
    await page.route(BIAUKAI_URL_PATTERN, (route) => {
      biaukaiRequests.push(route.request().url());
      return route.fulfill({ status: 404, contentType: 'text/plain', body: '' });
    });

    // Ensure NO window.Capacitor (normal web)
    await page.addInitScript(() => {
      // @ts-expect-error -- deliberately delete for normal-web simulation
      delete window.Capacitor;
    });

    await page.goto('/%E8%90%8C');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);

    // --- EduKai assertions ---
    expect(edukaiRequests, 'normal web load must NOT request the EduKai font').toEqual([]);
    expect(consoleErrors, 'normal web load must have zero console.error').toEqual([]);
    expect(pageErrors, 'normal web load must have zero pageerror').toEqual([]);
    expect(biaukaiRequests, 'normal web load must NOT request the 0-byte BiauKai URL').toEqual([]);

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
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await blockCssSubresources(page);
    await routeStylesCss(page);

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
