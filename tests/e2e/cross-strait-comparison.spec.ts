import { expect, test } from "./_fixtures";
import { waitForAppReady } from "./readiness";

test.describe("cross-strait Mainland pronunciation (兩岸辭典 大陸音)", () => {
  // Regression for g0v/moedict.tw#156: the API rewrites the legacy 陸⃝ Mainland
  // marker into `<span class="regional part-of-speech">陸</span>`, which used to
  // slip past decorateRuby's reading-splitter and render a mangled `span>`
  // fragment with the tone marks floating off to the side.
  test("renders 測度's Mainland reading in a 陸 block without a mangled span", async ({ page }) => {
    await page.goto("/~%E6%B8%AC%E5%BA%A6");
    await waitForAppReady(page, "dictionary");

    const cnSpecific = page.locator(".result .entry-heading small.alternative.cn-specific");
    await expect(cnSpecific).toBeVisible();

    // The clean Mainland reading is present (度 tone is ˊ / ó, vs Taiwan ˋ / ò).
    await expect(cnSpecific.locator(".pinyin")).toContainText("cèduó");
    await expect(cnSpecific.locator(".bopomofo")).toContainText("ㄉㄨㄛ");

    // No leaked markup text anywhere in the heading (the #156 symptom).
    const headingText = await page.locator(".result .entry-heading").innerText();
    expect(headingText).not.toContain("span>");
    expect(headingText).not.toContain("part-of-speech");
  });
});

test.describe("cross-strait comparison category", () => {
  test("renders Taiwan and Mainland terms as separate table links", async ({ page }) => {
    await page.goto("/~=%E5%90%8C%E5%AF%A6%E7%95%B0%E5%90%8D");
    const table = page.getByRole("table", { name: "臺灣及大陸用語對照" });

    await expect(table).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /臺灣用語/ })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /大陸用語/ })).toBeVisible();
    await expect(table.getByRole("link", { name: "三角皮帶", exact: true })).toHaveAttribute(
      "href",
      "/~三角皮帶",
    );
    await expect(table.getByRole("link", { name: "三角帶", exact: true })).toHaveAttribute(
      "href",
      "/~三角帶",
    );
  });

  test("fits the comparison table inside a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/~=%E5%90%8C%E5%AF%A6%E7%95%B0%E5%90%8D");
    const table = page.getByRole("table", { name: "臺灣及大陸用語對照" });

    await expect(table).toBeVisible();
    const overflows = await table.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < 0 || rect.right > document.documentElement.clientWidth;
    });
    expect(overflows).toBe(false);
  });
});
