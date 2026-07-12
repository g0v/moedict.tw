import type { Locator } from "@playwright/test";
import { expect, test } from "./_fixtures";

async function setInputValueWithEvent(input: Locator, value: string): Promise<void> {
  await input.evaluate((element, nextValue) => {
    const inputElement = element as HTMLInputElement;
    // Intentional descriptor setter reference for native input event simulation.
    // oxlint-disable-next-line typescript/unbound-method
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(inputElement, nextValue);
    inputElement.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        data: nextValue,
        inputType: "insertCompositionText",
        isComposing: true,
      }),
    );
  }, value);
}

async function clickWithPointerEvent(button: Locator): Promise<void> {
  await button.evaluate((element) => {
    element.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerType: "touch",
      }),
    );
    element.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

test.describe("mobile sidebar search toggle", () => {
  test.use({
    viewport: { width: 375, height: 700 },
  });

  test("keeps the contain-list toggle available after landing on a word page", async ({ page }) => {
    await page.goto("/%E8%90%8C");

    await expect(page.locator("#query")).toHaveValue("萌", { timeout: 15_000 });
    await expect(page.getByRole("button", { name: /列出所有含有「萌」的詞/ })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("expands the contain-list results when submitting the mobile search", async ({ page }) => {
    await page.goto("/");

    const input = page.locator("#query");
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill("萌");
    await input.press("Enter");

    await expect(page.locator("#sidebar-search-results")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: /列出所有含有「萌」的詞/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  test("keeps the results toggle from blurring the searchbox first (#108)", async ({ page }) => {
    await page.goto("/%E8%90%8C");

    const input = page.locator("#query");
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.focus();

    const toggle = page.getByRole("button", { name: /列出所有含有「萌」的詞/ });
    await expect(toggle).toBeVisible({ timeout: 10_000 });

    const pointerDownDefaultPrevented = await toggle.evaluate((button) => {
      const event = new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerType: "touch",
      });
      button.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(pointerDownDefaultPrevented).toBe(true);

    await input.evaluate((element) => {
      element.dispatchEvent(
        new FocusEvent("focusout", {
          bubbles: true,
          relatedTarget: null,
        }),
      );
    });
    await toggle.evaluate((button) => {
      button.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    await expect(page.locator("#sidebar-search-results")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(300);
    await expect(page.locator("#sidebar-search-results")).toBeVisible();
  });

  test("closes expanded results when pressing outside without relying on blur", async ({
    page,
  }) => {
    await page.goto("/%E8%90%8C");

    const input = page.locator("#query");
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.focus();

    const toggle = page.getByRole("button", { name: /列出所有含有「萌」的詞/ });
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    await toggle.evaluate((button) => {
      button.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          pointerType: "touch",
        }),
      );
      button.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    const results = page.locator("#sidebar-search-results");
    await expect(results).toBeVisible({ timeout: 10_000 });

    await page.locator("#main-content").dispatchEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerType: "touch",
    });
    await expect(results).toBeHidden();
  });

  test("clears the current mobile search from the right-side button", async ({ page }) => {
    await page.goto("/%E8%90%8C");

    const input = page.locator("#query");
    await expect(input).toHaveValue("萌", { timeout: 15_000 });

    await clickWithPointerEvent(page.getByRole("button", { name: "清除搜尋字詞" }));

    await expect(input).toHaveValue("");
    await expect(page).toHaveURL(/\/%E8%90%8C$/);
    await expect(page.getByRole("button", { name: "清除搜尋字詞" })).toBeHidden();
  });

  test("does not use browser history for the left-side mobile back button", async ({ page }) => {
    await page.goto("/%E4%B8%80");
    await page.goto("/%E8%90%8C");

    await expect(page.locator("#query")).toHaveValue("萌", { timeout: 15_000 });

    await clickWithPointerEvent(page.getByRole("button", { name: "回到上一個搜尋" }));

    await expect(page.locator("#query")).toHaveValue("萌");
    await expect(page).toHaveURL(/\/%E8%90%8C$/);
  });

  test("steps back through mobile search input history before browser history", async ({
    page,
  }) => {
    await page.goto("/");

    const input = page.locator("#query");
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill("萌");
    await expect(page).toHaveURL(/\/%E8%90%8C$/);

    await input.fill("夢");
    await expect(page).toHaveURL(/\/%E5%A4%A2$/);

    await clickWithPointerEvent(page.getByRole("button", { name: "回到上一個搜尋" }));

    await expect(input).toHaveValue("萌");
    await expect(page).toHaveURL(/\/%E8%90%8C$/);
  });

  test("does not count unfinished IME composition text in mobile search history", async ({
    page,
  }) => {
    await page.goto("/%E8%90%8C");

    const input = page.locator("#query");
    await expect(input).toHaveValue("萌", { timeout: 15_000 });
    await input.focus();

    await input.evaluate((element) => {
      element.dispatchEvent(
        new CompositionEvent("compositionstart", {
          bubbles: true,
          cancelable: true,
          data: "",
        }),
      );
    });
    await setInputValueWithEvent(input, "未完成");
    await expect(input).toHaveValue("未完成");

    await input.evaluate((element) => {
      const inputElement = element as HTMLInputElement;
      // Intentional descriptor setter reference for native input event simulation.
      // oxlint-disable-next-line typescript/unbound-method
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(inputElement, "夢");
      inputElement.dispatchEvent(
        new CompositionEvent("compositionend", {
          bubbles: true,
          cancelable: true,
          data: "夢",
        }),
      );
    });
    await expect(page).toHaveURL(/\/%E5%A4%A2$/);

    await clickWithPointerEvent(page.getByRole("button", { name: "回到上一個搜尋" }));

    await expect(input).toHaveValue("萌");
    await expect(page).toHaveURL(/\/%E8%90%8C$/);
  });
});

test.describe("desktop sidebar search controls", () => {
  test.use({
    viewport: { width: 1024, height: 768 },
  });

  test("steps back through completed search terms without leaving the sidebar layout", async ({
    page,
  }) => {
    await page.goto("/");

    const input = page.locator("#query");
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill("植");
    await expect(page).toHaveURL(/\/%E6%A4%8D$/);

    await input.fill("植物");
    await expect(page).toHaveURL(/\/%E6%A4%8D%E7%89%A9$/);

    await page.getByRole("button", { name: "回到上一個搜尋" }).click();

    await expect(input).toHaveValue("植");
    await expect(page).toHaveURL(/\/%E6%A4%8D$/);

    const controlsFitInSidebar = await page.evaluate(() => {
      const queryBox = document.querySelector("#query-box")?.getBoundingClientRect();
      const bar = document.querySelector(".mobile-search-bar")?.getBoundingClientRect();
      if (!queryBox || !bar) return false;
      return bar.left >= queryBox.left && bar.right <= queryBox.right;
    });
    expect(controlsFitInSidebar).toBe(true);
  });

  test("clears only the desktop sidebar search text", async ({ page }) => {
    await page.goto("/%E6%A4%8D%E7%89%A9");

    const input = page.locator("#query");
    await expect(input).toHaveValue("植物", { timeout: 15_000 });

    await page.getByRole("button", { name: "清除搜尋字詞" }).click();

    await expect(input).toHaveValue("");
    await expect(page).toHaveURL(/\/%E6%A4%8D%E7%89%A9$/);
  });
});
