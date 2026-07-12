import type { Page } from "@playwright/test";
import { expect, test } from "./_fixtures";

// Regression coverage for g0v/moedict-webkit#245 ("CSS: 支援深色模式").
//
// Three activation paths are exercised:
//   1. Pure OS preference (`prefers-color-scheme: dark`), no localStorage —
//      must work even before src/main.tsx has run.
//   2. An explicit "dark"/"light" override in localStorage, which must win
//      over the OS preference either way.
//   3. Live toggling via the #user-pref "外觀模式" control, which must not
//      require a reload (unlike the phonetics/pinyin prefs).

const ENTRY_PATH = "/%E8%90%8C"; // 萌

async function resultBackground(page: Page): Promise<string> {
  return page.locator(".result").first().evaluate((el) => getComputedStyle(el).backgroundColor);
}

async function bodyBackground(page: Page): Promise<string> {
  return page.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor);
}

async function colorScheme(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
}

async function openPrefPanel(page: Page): Promise<void> {
  await page.evaluate(() => {
    const panel = document.getElementById("user-pref");
    if (!panel) throw new Error("user-pref element not found in DOM");
    panel.style.display = "block";
  });
  await page.waitForFunction(() => {
    const el = document.getElementById("user-pref");
    return el !== null && el.offsetHeight > 0;
  });
}

test.describe("system prefers-color-scheme: dark (no manual override)", () => {
  test.use({ colorScheme: "dark" });

  test("entry cards and page background render dark, not the light Bootstrap default", async ({
    page,
  }) => {
    const response = await page.goto(ENTRY_PATH);
    expect(response?.status()).toBe(200);
    await page.waitForLoadState("networkidle");

    expect(await colorScheme(page)).toBe("dark");
    // Legacy default is rgb(255, 255, 255); dark vars replace it with #1c1c1c / #121212.
    expect(await resultBackground(page)).not.toBe("rgb(255, 255, 255)");
    expect(await bodyBackground(page)).not.toBe("rgb(255, 255, 255)");

    const linkColor = await page
      .locator(".result a")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    // Legacy `.result a { color: #000 }` is unreadable on a dark card.
    expect(linkColor).not.toBe("rgb(0, 0, 0)");
  });
});

test.describe("system prefers light, no manual override", () => {
  test.use({ colorScheme: "light" });

  test("renders unchanged from the pre-#245 light appearance", async ({ page }) => {
    const response = await page.goto(ENTRY_PATH);
    expect(response?.status()).toBe(200);
    await page.waitForLoadState("networkidle");

    expect(await colorScheme(page)).toBe("light");
    expect(await resultBackground(page)).toBe("rgb(255, 255, 255)");
  });
});

test.describe("manual override wins over the OS preference", () => {
  test("dark override on a light system", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => {
      window.localStorage.setItem("theme", "dark");
    });
    await page.goto(ENTRY_PATH);
    await page.waitForLoadState("networkidle");

    expect(await colorScheme(page)).toBe("dark");
    expect(await resultBackground(page)).not.toBe("rgb(255, 255, 255)");
  });

  test("light override on a dark system", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(() => {
      window.localStorage.setItem("theme", "light");
    });
    await page.goto(ENTRY_PATH);
    await page.waitForLoadState("networkidle");

    expect(await colorScheme(page)).toBe("light");
    expect(await resultBackground(page)).toBe("rgb(255, 255, 255)");
  });
});

test.describe("#user-pref 外觀模式 control", () => {
  test("switching to 深色 applies immediately, no reload, and persists", async ({ page }) => {
    await page.goto(ENTRY_PATH);
    await page.waitForLoadState("networkidle");
    expect(await resultBackground(page)).toBe("rgb(255, 255, 255)");

    await openPrefPanel(page);
    await page.selectOption("#pref-select-theme", "dark");

    await expect
      .poll(() => resultBackground(page), { timeout: 5_000 })
      .not.toBe("rgb(255, 255, 255)");
    expect(await colorScheme(page)).toBe("dark");
    expect(await page.evaluate(() => window.localStorage.getItem("theme"))).toBe("dark");
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe(
      "dark",
    );

    // Switching back to 淺色 restores the original light appearance.
    await page.selectOption("#pref-select-theme", "light");
    await expect.poll(() => resultBackground(page), { timeout: 5_000 }).toBe("rgb(255, 255, 255)");
  });
});
