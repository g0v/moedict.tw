/**
 * Regression for closed issue #76 (搜尋框注音選字時按上下鍵會讓選字失效).
 *
 * The fix lives at src/components/searchbox.tsx:926-928 and layers three
 * independent guards — if any of the following are true, the keydown handler
 * must return before running ArrowDown / ArrowUp / Enter logic, so the
 * browser's IME candidate UI can consume the arrow key natively:
 *
 *   1. isComposingRef.current   (set by onCompositionStart / onCompositionEnd)
 *   2. nativeEvent.isComposing  (DOM KeyboardEvent.isComposing)
 *   3. nativeEvent.keyCode === 229  (legacy "IME in progress" keyCode)
 *
 * We can't drive the real macOS IME from Playwright, but we can exercise the
 * app-layer contract for each guard independently. Observable: ArrowDown
 * *without* IME moves focus onto the first suggestion (focusSuggestionByIndex
 * fires); ArrowDown *while composing* must leave focus on the input.
 */

import type { Page } from "@playwright/test";
import { expect, test } from "./_fixtures";

async function typeQueryAndWaitForSuggestions(page: Page, value: string): Promise<void> {
  const input = page.locator("#query");
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.click();
  await input.fill(value);
  // Suggestions render as <a role="button"> inside #sidebar-search-results.
  await expect(page.locator('#sidebar-search-results a[role="button"]').first()).toBeVisible({
    timeout: 10_000,
  });
}

async function getActiveElementInfo(page: Page): Promise<{ id: string; tag: string }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { id: el?.id ?? "", tag: el?.tagName?.toLowerCase() ?? "" };
  });
}

test.describe("searchbox IME navigation guards (#76)", () => {
  test("baseline: ArrowDown without IME moves focus onto first suggestion", async ({ page }) => {
    await page.goto("/%E8%90%8C");
    await page.waitForLoadState("networkidle");
    await typeQueryAndWaitForSuggestions(page, "萌");

    const before = await getActiveElementInfo(page);
    expect(before.id).toBe("query");

    await page.keyboard.press("ArrowDown");

    const after = await getActiveElementInfo(page);
    // Focus left the input — it landed on a suggestion anchor (tag=a, no id).
    expect(after.id).not.toBe("query");
    expect(after.tag).toBe("a");
  });

  test("guard 1 — compositionstart ref: ArrowDown while composing keeps focus on input", async ({
    page,
  }) => {
    await page.goto("/%E8%90%8C");
    await page.waitForLoadState("networkidle");
    await typeQueryAndWaitForSuggestions(page, "萌");

    // Flip the ref via a real React composition event.
    await page.locator("#query").evaluate((el) => {
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    });

    await page.keyboard.press("ArrowDown");

    const after = await getActiveElementInfo(page);
    expect(after.id).toBe("query");

    // End composition — arrow keys should work again.
    await page.locator("#query").evaluate((el) => {
      el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
    });
    await page.keyboard.press("ArrowDown");
    const recovered = await getActiveElementInfo(page);
    expect(recovered.id).not.toBe("query");
    expect(recovered.tag).toBe("a");
  });

  test("guard 2 — nativeEvent.isComposing: synthetic event is ignored", async ({ page }) => {
    await page.goto("/%E8%90%8C");
    await page.waitForLoadState("networkidle");
    await typeQueryAndWaitForSuggestions(page, "萌");

    // Dispatch a KeyboardEvent with isComposing=true directly — the ref is
    // NOT set (no compositionstart), so this specifically exercises the
    // second guard (`nativeEvent.isComposing`).
    await page.locator("#query").evaluate((el) => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          code: "ArrowDown",
          bubbles: true,
          cancelable: true,
          isComposing: true,
        }),
      );
    });

    const after = await getActiveElementInfo(page);
    expect(after.id).toBe("query");
  });

  test("guard 3 — keyCode 229: synthetic event is ignored", async ({ page }) => {
    await page.goto("/%E8%90%8C");
    await page.waitForLoadState("networkidle");
    await typeQueryAndWaitForSuggestions(page, "萌");

    await page.locator("#query").evaluate((el) => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          code: "ArrowDown",
          bubbles: true,
          cancelable: true,
          keyCode: 229,
        }),
      );
    });

    const after = await getActiveElementInfo(page);
    expect(after.id).toBe("query");
  });
});
