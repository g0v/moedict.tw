import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import { expect, test } from './_fixtures';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STYLES_CSS_PATH = path.join(REPO_ROOT, 'data', 'assets', 'styles.css');
const BASELINE_REF = process.env.LEGACY_CSS_BASELINE_REF ?? 'HEAD';

function readGitStylesCss(ref: string): string {
  return execSync(`git show ${ref}:data/assets/styles.css`, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
}
function readWorkingTreeStylesCss(): string {
  return readFileSync(STYLES_CSS_PATH, 'utf-8');
}

// Registered AFTER _fixtures.ts's blanket r2-*.test.local blocker (which
// fulfills ALL r2-[a-z]+.test.local requests with a 404). Playwright tries
// most-recently-registered routes first, so this wins for styles.css
// specifically while other r2-*.test.local requests stay blocked as before.
// getCss is a thunk (not a fixed string) so ONE route registration can serve
// different content across two navigations within the same test.
async function routeStylesCss(page: Page, getCss: () => string): Promise<void> {
  const handler = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/css; charset=utf-8',
      headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
      body: getCss(),
    });
  // Production appends ?v=<LEGACY_STYLESHEET_VERSION> (e.g. ?v=20260711) to
  // bust the pre-existing unversioned edge-cached object. Register both the
  // exact no-query URL and the query-bearing URL so the differential test
  // intercepts the real production request instead of falling through to
  // _fixtures.ts's blanket r2-*.test.local 404 (which would make both
  // navigations identically unstyled → vacuously passing).
  await page.route('https://r2-assets.test.local/styles.css', handler);
  await page.route('https://r2-assets.test.local/styles.css?*', handler);
  await page.route('**/assets/styles.css', handler); // About.tsx's own loader always uses this relative path
  await page.route('**/assets/styles.css?*', handler);
}

// The CSS has relative url() references (fonts/, images/) that, when the
// stylesheet is loaded from /assets/styles.css (About.tsx's own loader),
// resolve to /assets/fonts/* and /assets/images/*. These don't exist as
// static assets in dist/client, so the Worker proxies them to
// r2-assets.test.local → DNS fail → 502. The cascade of ~22 failed requests
// prevents networkidle from ever firing on the about page. Block them at the
// browser level so they never reach the Worker. (When the CSS is loaded from
// https://r2-assets.test.local/styles.css via AssetLoader, its relative
// URLs resolve to r2-assets.test.local/fonts/* which is already blocked by
// _fixtures.ts's blanket 404 — so this only affects the /assets/ path.)
async function blockCssSubresources(page: Page): Promise<void> {
  const notFound = (route: Route) =>
    route.fulfill({ status: 404, contentType: 'text/plain; charset=utf-8', body: '' });
  await page.route('**/assets/fonts/**', notFound);
  await page.route('**/assets/images/leather_x2.jpg', notFound);
  await page.route('**/assets/images/subtle_stripes_x2.png', notFound);
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  // Let any pending layout/RAF callbacks flush so back-to-back screenshots
  // of identical content are byte-identical.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

async function shot(page: Page): Promise<Buffer> {
  return page.screenshot({ fullPage: true, animations: 'disabled' });
}

// Deterministic alternative/companion to screenshot diffing: dumps every
// element's *computed* style (post-cascade, resolved values) as one big
// string. Unlike a PNG screenshot, this has zero font-hinting/subpixel-AA
// nondeterminism — two navigations with byte-identical CSS produce a
// byte-identical digest, and ANY rendering-relevant CSS change (however
// small) shows up as a text diff. This is the primary zero-regression
// assertion below; the screenshot is kept only as a debugging aid.
async function computedStyleDigest(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [];
    document.querySelectorAll('*').forEach((el, i) => {
      const tag = `<${el.tagName.toLowerCase()} class="${el.className}">`;
      // getComputedStyle(el).cssText is spec'd to return '' for computed
      // (as opposed to inline-style) declarations — confirmed empty in
      // this Chromium build via a throwaway diagnostic. Enumerate every
      // property name explicitly and read its value instead.
      const cs = getComputedStyle(el);
      let styleDump = '';
      for (let p = 0; p < cs.length; p++) {
        const name = cs[p];
        styleDump += `${name}:${cs.getPropertyValue(name)};`;
      }
      parts.push(`[${i}] ${tag}\n${styleDump}`);
      // getComputedStyle(el) alone never sees ::before/::after — this file
      // is majority icon-font (Font Awesome ~400 classes) and diacritic
      // glyph classes, ALL implemented as `::before { content: "\fXXX" }`.
      // A content/font-family regression there would be entirely invisible
      // without probing the pseudo-elements explicitly.
      const before = getComputedStyle(el, '::before');
      if (before.content !== 'none' && before.content !== '') {
        parts.push(`[${i}] ${tag}::before\ncontent:${before.content};font-family:${before.fontFamily};color:${before.color}`);
      }
      const after = getComputedStyle(el, '::after');
      if (after.content !== 'none' && after.content !== '') {
        parts.push(`[${i}] ${tag}::after\ncontent:${after.content};font-family:${after.fontFamily};color:${after.color}`);
      }
    });
    return parts.join('\n---\n');
  });
}

const PAGES: Array<{ name: string; goto: (page: Page) => Promise<void> }> = [
  { name: 'home', goto: (p) => p.goto('/%E8%90%8C') },
  { name: 'dict-t', goto: (p) => p.goto("/'%E9%A3%9F") },
  { name: 'dict-h', goto: (p) => p.goto('/%3A%E5%AD%97') },
  { name: 'dict-c', goto: (p) => p.goto('/~%E4%B8%8A%E8%A8%B4') },
  { name: 'radical', goto: (p) => p.goto('/@') },
  { name: 'about', goto: (p) => p.goto('/about') },
  {
    name: 'starred',
    goto: async (p) => {
      await p.goto('/');
      await p.evaluate(() => {
        window.localStorage.setItem('starred-a', '"\u840c"\n"\u6c34"\n"\u706b"\n');
        window.localStorage.setItem('lru-a', JSON.stringify(['\u840c', '\u6c34', '\u706b']));
      });
      await p.goto('/=*');
    },
  },
];

test.describe('legacy styles.css \u2014 zero-regression differential', () => {
  test.beforeEach(async ({ page }) => {
    // The about page loads ~13 guide images plus CSS sub-resources; two
    // navigations within one test need headroom beyond the default 30s.
    test.setTimeout(60_000);
    await page.addInitScript(() => {
      const style = document.createElement('style');
      style.textContent = `*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }`;
      document.documentElement.appendChild(style);
    });
  });

  for (const { name, goto } of PAGES) {
    test(`${name}: working tree styles.css renders identically to ${BASELINE_REF}`, async ({ page }) => {
      await blockCssSubresources(page);
      let css = readGitStylesCss(BASELINE_REF);
      await routeStylesCss(page, () => css);
      await goto(page);
      await settle(page);
      const before = await computedStyleDigest(page);
      expect(before.length, `${name}: computed-style digest must not be empty (sanity check on the digest mechanism itself)`).toBeGreaterThan(1000);

      css = readWorkingTreeStylesCss();
      await goto(page); // fresh navigation forces re-fetch of the <link>
      await settle(page);
      const after = await computedStyleDigest(page);

      expect(after, `${name}: working-tree styles.css must produce an IDENTICAL computed-style digest to ${BASELINE_REF} (post-cascade resolved values for every element, incl. ::before/::after content) — any diff means some rule's effective value changed`).toBe(before);
    });
  }
});

test.describe('legacy styles.css \u2014 harness self-verification (controls)', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
      const style = document.createElement('style');
      style.textContent = `*, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }`;
      document.documentElement.appendChild(style);
    });
  });

  test('positive control: legacy CSS measurably changes computed styles vs. no CSS at all', async ({ page }) => {
    // Capture a broad snapshot of computed styles under two conditions
    // (blank CSS vs. real working-tree CSS) and assert at least one property
    // differs. This proves the route interception actually reaches the page —
    // a vacuous pass (both renders equally unstyled) would fail here.
    // NOTE: body/html background-color/font-family/margin and several
    // .iconic-circle properties are ALSO set by the modern src/index.css
    // (loaded synchronously, before styles.css) and were empirically found
    // NOT to differ between blank and real styles.css on the home page —
    // do not rely on those as the sole signal. `.navbar` minHeight and
    // `.navbar-brand` height were empirically verified (via a throwaway
    // diagnostic spec, since removed) to reliably flip from 0px/20px
    // (unstyled) to 50px/50px (styled) — Bootstrap's navbar sizing has no
    // modern-CSS equivalent, so these are the primary signal here.
    const snapshot = async (targetPage: Page): Promise<Record<string, string>> => {
      return targetPage.evaluate(() => {
        const result: Record<string, string> = {};
        const navbar = document.querySelector('.navbar.navbar-inverse');
        if (navbar) {
          const ns = window.getComputedStyle(navbar);
          result['navbar.min-height'] = ns.minHeight;
          result['navbar.position'] = ns.position;
        }
        const brand = document.querySelector('.navbar-brand');
        if (brand) {
          result['navbar-brand.height'] = window.getComputedStyle(brand).height;
        }
        return result;
      });
    };

    await blockCssSubresources(page);
    let css = '';
    await routeStylesCss(page, () => css);
    await page.goto('/%E8%90%8C');
    await settle(page);
    const blank = await snapshot(page);
    const blankDigest = await computedStyleDigest(page);

    css = readWorkingTreeStylesCss();
    await page.goto('/%E8%90%8C');
    await settle(page);
    const styled = await snapshot(page);
    const styledDigest = await computedStyleDigest(page);

    const diffs: string[] = [];
    for (const key of Object.keys(blank)) {
      if (blank[key] !== styled[key]) diffs.push(`${key}: ${blank[key]} -> ${styled[key]}`);
    }
    console.log(`[positive-control] ${diffs.length} named-property diffs:\n${diffs.map((d) => '  ' + d).join('\n')}`);
    expect(diffs.length, `legacy CSS must measurably change at least one named computed style vs. blank CSS. diffs: ${diffs.join(', ')}`).toBeGreaterThan(0);
    // Broader companion check using the same digest the main assertion
    // relies on — proves that mechanism, too, is sensitive on a real page.
    expect(styledDigest, 'the full computed-style digest must also differ between blank and real CSS').not.toBe(blankDigest);
  });

  test('negative control: a deliberately mutated stylesheet changes both the screenshot and the computed-style digest', async ({ page }) => {
    await blockCssSubresources(page);
    let css = readWorkingTreeStylesCss();
    await routeStylesCss(page, () => css);
    await page.goto('/%E8%90%8C');
    await settle(page);
    const original = await shot(page);
    const originalDigest = await computedStyleDigest(page);

    css = readWorkingTreeStylesCss() + '\nbody{background:#ff0000 !important;}';
    await page.goto('/%E8%90%8C');
    await settle(page);
    const mutated = await shot(page);
    const mutatedDigest = await computedStyleDigest(page);

    expect(!mutated.equals(original), 'mutated stylesheet (red body bg) must produce a visibly different screenshot than the original').toBe(true);
    // Same-mechanism check: the computed-style digest (what the main
    // per-page assertions actually gate on) must ALSO catch this mutation —
    // otherwise a broken/vacuous digest could pass the real tests above
    // while never detecting a genuine regression.
    expect(mutatedDigest, 'the computed-style digest must also change for a mutated stylesheet').not.toBe(originalDigest);
  });
});
