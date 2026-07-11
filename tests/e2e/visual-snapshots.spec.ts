/**
 * Visual regression suite.
 *
 * Takes pixel-level screenshots of canonical pages + states. Baselines are
 * generated once (usually in CI or via `vp run test:e2e:update`) and diffed
 * on subsequent runs. Set `expect.toHaveScreenshot.maxDiffPixels` in
 * playwright.config.ts to tune sensitivity.
 *
 * These tests are in the default run; when no baseline exists Playwright
 * creates one and fails the test (by design). Regenerate with:
 *   vp run test:e2e:update
 */

import { expect, test } from './_fixtures';

test.describe('visual regressions', () => {
  test.beforeEach(async ({ page }) => {
    // Pre-load fonts; disable animations via CSS; wait for layout to settle.
    await page.addInitScript(() => {
      const style = document.createElement('style');
      style.textContent = `
        *, *::before, *::after {
          transition-duration: 0s !important;
          animation-duration: 0s !important;
        }
      `;
      document.documentElement.appendChild(style);
    });
  });

  test('home page (/萌)', async ({ page }) => {
    await page.goto('/%E8%90%8C');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('home-meng.png', { fullPage: true });
  });

  test('dictionary t (/\'食)', async ({ page }) => {
    await page.goto("/'%E9%A3%9F");
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('dict-t-shit.png', { fullPage: true });
  });

  test('dictionary h (/:字)', async ({ page }) => {
    await page.goto('/%3A%E5%AD%97');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('dict-h-zi.png', { fullPage: true });
  });

  test('dictionary c (/~上訴)', async ({ page }) => {
    await page.goto('/~%E4%B8%8A%E8%A8%B4');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('dict-c-shangsu.png', { fullPage: true });
  });

  test('radical view (/@)', async ({ page }) => {
    await page.goto('/@');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('radical-view.png', { fullPage: true });
  });

  test('about page', async ({ page }) => {
    await page.goto('/about');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('about.png', { fullPage: true });
  });

  test('starred landing (/=*) with seeded state', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => {
      window.localStorage.setItem('starred-a', '"萌"\\n"水"\\n"火"\\n');
      window.localStorage.setItem('lru-a', JSON.stringify(['萌', '水', '火']));
    });
    await page.goto('/=*');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('starred.png', { fullPage: true });
  });
});

/**
 * Mobile viewport baselines — guard against the recurring class of bug where
 * the navbar settings/search controls overlap at narrow widths (#80 / #93 /
 * #96). 375px matches iPhone SE / 13 mini portrait.
 */
test.describe('visual regressions — mobile 375px', () => {
  test.use({ viewport: { width: 375, height: 700 } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const style = document.createElement('style');
      style.textContent = `
        *, *::before, *::after {
          transition-duration: 0s !important;
          animation-duration: 0s !important;
        }
      `;
      document.documentElement.appendChild(style);
    });
  });

  test('mobile home (/萌)', async ({ page }) => {
    await page.goto('/%E8%90%8C');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('mobile-home-meng.png', { fullPage: true });
  });

  test('mobile navbar region above the fold', async ({ page }) => {
    await page.goto('/%E8%90%8C');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    // Crop to the first 120px so diffs concentrate on the navbar — the exact
    // region where #96 / #93 / #80 all landed.
    await expect(page).toHaveScreenshot('mobile-navbar.png', {
      clip: { x: 0, y: 0, width: 375, height: 120 },
    });
  });

  test('mobile about page', async ({ page }) => {
    await page.goto('/about');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('mobile-about.png', { fullPage: true });
  });
});

/**
 * Print-mode baseline — guards the 字卡 / hollow-font / inline-flex work
 * from #92 and #94 that only manifests under `@media print`.
 */
test.describe('visual regressions — print mode', () => {
  test('dictionary entry in print CSS', async ({ page }) => {
    await page.goto('/%E8%90%8C');
    await page.waitForLoadState('networkidle');
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot('print-dict-meng.png', { fullPage: true });
  });
});
