import type { Page } from "@playwright/test";
import { expect, test } from "./_fixtures";
import { waitForAppReady } from "./readiness";

// g0v/moedict-webkit#102 — 按 back 希望能回到之前的 scrolling position。
//
// 詞語列表頁（例如 /=成語）內容量大，切回列表頁時重新渲染到完整高度需要一段
// 時間；瀏覽器原生的 history 還原若在內容還沒撐開前就嘗試一次，捲動位置會被
// 夾在當下可捲動的高度、之後不再重試。ScrollToTop 自行記錄／還原捲動位置，
// 並輪詢等待內容夠高後才還原，藉此修好這個問題（src/App.tsx、
// src/utils/scroll-position.ts）。

async function scrollToAndWait(page: Page, y: number): Promise<void> {
  // The document must actually be tall enough to reach targetY before
  // scrollTo can succeed -- under heavy parallel CPU contention the list's
  // full-height layout can still be settling a beat after networkidle.
  // Wait for a reachable scrollHeight first so the scrollTo below isn't
  // racing layout, then poll for the actual scroll position (a single
  // scrollTo call can be coalesced/dropped by the browser under load, so
  // retry it inside the poll rather than firing it once and hoping).
  await page.waitForFunction(
    (targetY) =>
      document.scrollingElement != null &&
      document.scrollingElement.scrollHeight - window.innerHeight >= targetY,
    y,
    { timeout: 10_000 },
  );
  await expect
    .poll(
      async () => {
        await page.evaluate((targetY) => window.scrollTo(0, targetY), y);
        return page.evaluate(() => window.scrollY);
      },
      { timeout: 10_000 },
    )
    .toBe(y);
}

async function clickFirstVisibleResultLink(page: Page): Promise<string> {
  const href = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("#result a"));
    const target = links.find((a) => {
      const rect = a.getBoundingClientRect();
      return rect.top >= 0 && rect.top < window.innerHeight && a.textContent!.trim().length >= 2;
    });
    if (!target) return null;
    target.click();
    return target.getAttribute("href");
  });
  expect(href).not.toBeNull();
  return href!;
}

test.describe("back-navigation scroll restoration", () => {
  test("restores the previous scroll position after navigating into an entry and back", async ({
    page,
  }) => {
    await page.goto("/=%E6%88%90%E8%AA%9E");
    await waitForAppReady(page);

    const targetY = 4200;
    await scrollToAndWait(page, targetY);

    const href = await clickFirstVisibleResultLink(page);
    await page.waitForURL((url) => decodeURIComponent(url.pathname) === decodeURIComponent(href));
    await waitForAppReady(page);
    // Forward (PUSH) navigation into a new entry always resets to the top.
    await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 5_000 }).toBe(0);

    await page.goBack();
    await page.waitForURL((url) => decodeURIComponent(url.pathname) === "/=成語");

    // The list needs time to re-render to its full height before the target
    // scroll position is even reachable; poll instead of a fixed sleep.
    await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 5_000 }).toBe(targetY);
  });

  test("restores distinct scroll positions across repeated back/forward cycles", async ({
    page,
  }) => {
    await page.goto("/=%E6%88%90%E8%AA%9E");
    await waitForAppReady(page);

    for (const targetY of [1500, 2700, 3900]) {
      await scrollToAndWait(page, targetY);
      const href = await clickFirstVisibleResultLink(page);
      await page.waitForURL((url) => decodeURIComponent(url.pathname) === decodeURIComponent(href));
      await waitForAppReady(page);

      await page.goBack();
      await page.waitForURL((url) => decodeURIComponent(url.pathname) === "/=成語");
      await expect
        .poll(() => page.evaluate(() => window.scrollY), { timeout: 5_000 })
        .toBe(targetY);
    }
  });
});
