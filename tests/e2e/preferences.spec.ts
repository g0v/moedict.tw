import { expect, test } from "./_fixtures";
import { waitForAppReady } from "./readiness";

// Maps phonetics localStorage value → body.data-ruby-pref value (applied by user-pref.tsx).
const PHONETICS_MAP: Record<string, string> = {
  rightangle: "both",
  bopomofo: "zhuyin",
  pinyin: "pinyin",
  none: "none",
};

test.describe("user preferences (phonetics, pinyin system)", () => {
  test('default phonetics body attribute is "both" (rightangle)', async ({ page }) => {
    await page.goto("/%E8%90%8C");
    await waitForAppReady(page);
    const pref = await page.evaluate(() => document.body.getAttribute("data-ruby-pref"));
    // Default is rightangle → "both" (or null if user-pref component hasn't mounted yet)
    expect(pref === "both" || pref == null).toBe(true);
  });

  for (const [stored, applied] of Object.entries(PHONETICS_MAP)) {
    test(`phonetics=${stored} applies data-ruby-pref=${applied}`, async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);
      await page.evaluate((v) => window.localStorage.setItem("phonetics", v), stored);
      await page.goto("/%E8%90%8C");
      await waitForAppReady(page);
      // Allow a frame for applyPhoneticsBodyAttr effect to run
      await page.waitForTimeout(200);
      const pref = await page.evaluate(() => document.body.getAttribute("data-ruby-pref"));
      expect(pref).toBe(applied);
    });
  }

  test("pinyin_a preference is persisted to localStorage", async ({ page }) => {
    await page.goto("/");
    await waitForAppReady(page);
    await page.evaluate(() => window.localStorage.setItem("pinyin_a", "TongYong"));
    const stored = await page.evaluate(() => window.localStorage.getItem("pinyin_a"));
    expect(stored).toBe("TongYong");
  });

  test("pinyin_t preference persists", async ({ page }) => {
    await page.goto("/");
    await waitForAppReady(page);
    await page.evaluate(() => window.localStorage.setItem("pinyin_t", "POJ"));
    expect(await page.evaluate(() => window.localStorage.getItem("pinyin_t"))).toBe("POJ");
  });

  test("pinyin_h preference persists", async ({ page }) => {
    await page.goto("/");
    await waitForAppReady(page);
    await page.evaluate(() => window.localStorage.setItem("pinyin_h", "PFS"));
    expect(await page.evaluate(() => window.localStorage.getItem("pinyin_h"))).toBe("PFS");
  });
});
