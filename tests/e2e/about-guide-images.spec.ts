import type { Page } from "@playwright/test";
import { expect, test } from "./_fixtures";
import { waitForAppReady } from "./readiness";

/**
 * Regression for #153: `/images/guide/<CJK-filename>_resized.jpg` (13
 * screenshots referenced by /about's 使用說明 section, see
 * src/pages/About.tsx's `guideSrc()`) intermittently 404'd on staging
 * because the R2 release-fallback chain (src/api/release-fallback.ts)
 * derived its lookup key from the still percent-encoded `url.pathname`
 * instead of decoding it first -- the uploaded R2 key
 * (scripts/lib/r2-upload.mjs) always uses the raw UTF-8 filesystem path, so
 * the two never matched and a SITE_ASSETS miss had no working fallback.
 * Fixed by decoding once via tryDecodeURIComponent before every
 * releaseKey/immutableKey/legacy R2 lookup.
 *
 * This fixture's SITE_ASSETS binding always serves these images directly
 * (see tests/helpers/miniflare-server.ts), so it does not itself exercise
 * the R2-fallback code path -- that is covered by the Miniflare-integration
 * tests in tests/integration/api-legacy-assets.test.ts and the direct-call
 * unit tests in tests/unit/release-fallback.test.ts. This spec instead
 * guards the end-to-end contract: every `guideSrc()` in About.tsx must
 * resolve to a real, correctly percent-encoded, 200-serving image URL.
 */

async function gotoAbout(page: Page): Promise<void> {
  const response = await page.goto("/about");
  expect(response?.status()).toBe(200);
  await waitForAppReady(page, "about");
}

test.describe("About page guide images (#153)", () => {
  test("all guide-figure <img> srcs return 200", async ({ page, request }) => {
    await gotoAbout(page);

    const srcs = await page
      .locator(".about-page .guide-figure img")
      .evaluateAll((imgs) => imgs.map((img) => (img as HTMLImageElement).getAttribute("src")));

    // 13 screenshots as of #95 -- fail loudly if the count regresses instead
    // of silently checking zero images.
    expect(srcs.length).toBe(13);

    for (const src of srcs) {
      expect(src).toBeTruthy();
      expect(src).toMatch(/^\/images\/guide\/%[0-9A-F]{2}/);
      const res = await request.get(new URL(src!, page.url()).toString());
      expect(res.status(), `expected 200 for ${src}`).toBe(200);
      expect(res.headers()["content-type"]).toMatch(/image\/jpeg/);
    }
  });

  test("each guide image also resolves when requested with a raw (unencoded) UTF-8 path", async ({
    page,
    request,
  }) => {
    await gotoAbout(page);

    const srcs = await page
      .locator(".about-page .guide-figure img")
      .evaluateAll((imgs) => imgs.map((img) => (img as HTMLImageElement).getAttribute("src")));
    expect(srcs.length).toBe(13);

    for (const src of srcs) {
      const decoded = decodeURIComponent(src!);
      const res = await request.get(new URL(decoded, page.url()).toString());
      expect(res.status(), `expected 200 for raw path ${decoded}`).toBe(200);
    }
  });
});
