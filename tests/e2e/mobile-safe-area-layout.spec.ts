import { expect, test } from "./_fixtures";
import { waitForAppReady } from "./readiness";

async function measureMobileLayout(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`${selector} not found`);
      const { y, height } = element.getBoundingClientRect();
      return { y, height };
    };

    return {
      queryBox: rect("#query-box"),
      heading: rect("h1.title"),
      mainMarginTop: window.getComputedStyle(document.querySelector("#main-content")!).marginTop,
    };
  });
}

test.describe("mobile safe-area layout", () => {
  test("keeps dictionary content near the search box while the mobile search input is empty", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto("/%E8%90%8C");
    // measureMobileLayout reads h1.title's geometry -- "shell" (default)
    // only waits for `body` visible, which can resolve before the entry's
    // async fetch has rendered h1.title, throwing "h1.title not found"
    // inside the page.evaluate. Wait for the dictionary content contract
    // instead of the generic shell.
    await waitForAppReady(page, "dictionary");

    await page.evaluate(() => {
      document.documentElement.style.setProperty("--moe-safe-area-top", "59px");
    });

    await page.locator("#query").fill("");
    await page.locator("#query").focus();

    const boxes = await measureMobileLayout(page);

    expect(boxes.mainMarginTop).toBe("124px");
    expect(boxes.heading.y).toBeGreaterThanOrEqual(boxes.queryBox.y + boxes.queryBox.height);
  });

  test("pushes dictionary content below mobile search suggestions once the user types", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto("/%E8%90%8C");
    // Same h1.title race as the sibling test above.
    await waitForAppReady(page, "dictionary");

    await page.evaluate(() => {
      document.documentElement.style.setProperty("--moe-safe-area-top", "59px");
    });

    await page.locator("#query").fill("");
    await page.locator("#query").fill("萌");

    const boxes = await measureMobileLayout(page);

    expect(boxes.mainMarginTop).toBe("179px");
    expect(boxes.heading.y).toBeGreaterThanOrEqual(boxes.queryBox.y + boxes.queryBox.height);
  });
});
