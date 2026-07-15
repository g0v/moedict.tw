import type { Locator, Page } from "@playwright/test";
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
  return page
    .locator(".result")
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
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
    await page.waitForLoadState("domcontentloaded");

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
    await page.waitForLoadState("domcontentloaded");

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

// ---------------------------------------------------------------------------
// Phrase/example card contrast — Taiwanese dictionary /'食 (fixture word)
// Regression for the white-on-white issue (#245 follow-up) where legacy
// `body.lang-t .example { background: #eee }` was not overridden in dark mode,
// producing contrast 1.10 between the near-white (#e6e3df) foreground text
// and the near-white (#eee) card background.
//
// Uses the seeded fixture word 食 (`'%E9%A3%9F`) so the test server can
// serve real dictionary data without network access.  The comment refers to
// /'你 as the canonical staging URL where the bug was first observed.
//
// Child selector coverage: the dark test intercepts the /'食 JSON API route to
// inject one synthetic definition whose plain-HTML example contains a <b> and
// an <a class="mark"> element — the two child selectors fixed by the dark-mode
// overrides that do not appear in any seeded ptck bucket.  All other child
// classes (`.mandarin`, `.example a`, `hruby ru zhuyin`) are present in the
// real fixture data and asserted without injection.
// ---------------------------------------------------------------------------

/** WCAG relative luminance for three sRGB components in [0,255]. */
function wcagLuminance(r: number, g: number, b: number): number {
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Parse `rgb(r, g, b)` or `rgba(r, g, b, a)` → {r,g,b} */
function parseRgb(css: string): { r: number; g: number; b: number } | null {
  const m = css.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return null;
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

/** WCAG contrast ratio between two CSS color strings (≥ 1.0, 0 on parse failure). */
function contrastRatio(fg: string, bg: string): number {
  const fgRgb = parseRgb(fg);
  const bgRgb = parseRgb(bg);
  if (!fgRgb || !bgRgb) return 0;
  const L1 = wcagLuminance(fgRgb.r, fgRgb.g, fgRgb.b);
  const L2 = wcagLuminance(bgRgb.r, bgRgb.g, bgRgb.b);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

// Seeded fixture word for Taiwanese (lang-t): 食 — matches CANONICAL_WORDS.t in
// tests/helpers/fixtures.ts so the local test server has data for this URL.
const TAIWAN_PATH = "/'%E9%A3%9F"; // /'食

// The raw API URL pattern that the React app fetches for /'食.
// Intercepted in the dark-mode child-selector test to inject b/a.mark elements.
const TAIWAN_API_PATTERN = /\/api\/'[^?]*\.json/;

/** Computed background and foreground of the first .example card. */
async function exampleCardColors(
  page: Page,
): Promise<{ bg: string; fg: string; borderColor: string }> {
  return page
    .locator("body.lang-t .example")
    .first()
    .evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, fg: cs.color, borderColor: cs.borderColor };
    });
}

/**
 * Returns `{fg, bg}` for the first element matched by `loc`, where `bg` is
 * the nearest non-transparent painted background (self or ancestor).  Works
 * for any element: transparent children (mandarin, links, zhuyin) resolve to
 * their card ancestor; elements with their own opaque background (b, a.mark)
 * resolve to that background directly.
 */
async function locatorContrast(loc: Locator): Promise<{ fg: string; bg: string }> {
  return loc.first().evaluate((el) => {
    let cur: Element | null = el;
    while (cur) {
      const bg = getComputedStyle(cur).backgroundColor;
      if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
        return { fg: getComputedStyle(el).color, bg };
      }
      cur = cur.parentElement;
    }
    return { fg: getComputedStyle(el).color, bg: "rgb(255, 255, 255)" };
  });
}

test.describe("phrase card contrast: Taiwanese example cards in dark mode", () => {
  test.use({ colorScheme: "dark" });

  test("dark mode: card bg dark; mandarin/link/zhuyin/b/a.mark all meet WCAG AA (≥4.5) vs painted background", async ({
    page,
  }) => {
    // Intercept the /'食 JSON API to append one synthetic definition whose
    // plain-HTML example contains <b> and <a class="mark"> — these child
    // selectors never appear in any seeded ptck bucket.
    await page.route(TAIWAN_API_PATTERN, async (route) => {
      const resp = await route.fetch();
      const json = await resp.json();
      // Append a synthetic heteronym with a plain-HTML example that carries
      // every child selector the dark-mode rules target.
      const syntheticHtml = '<b>食</b>果子 <a class="mark" href="./#\'食">食</a>燒酒';
      (json.heteronyms as Record<string, unknown>[]).push({
        trs: "tsia̍h",
        id: "dark-mode-test-fixture",
        definitions: [
          {
            def: "【測試用】",
            type: "",
            example: [syntheticHtml],
          },
        ],
      });
      await route.fulfill({ json });
    });

    const response = await page.goto(TAIWAN_PATH);
    expect(response?.status()).toBe(200);
    await page.waitForLoadState("networkidle");

    const hasLangT = await page.evaluate(() => document.body.classList.contains("lang-t"));
    expect(hasLangT).toBe(true);

    // ── 1. Card background is dark (not the legacy light #eee) ──────────
    const exampleCount = await page.locator("body.lang-t .example").count();
    expect(exampleCount).toBeGreaterThan(0);

    const { bg: cardBg, fg: cardFg } = await exampleCardColors(page);
    expect(cardBg).not.toBe("rgb(238, 238, 238)");
    const bgRgb = parseRgb(cardBg)!;
    expect(bgRgb.r).toBeLessThan(128);
    expect(bgRgb.g).toBeLessThan(128);
    expect(bgRgb.b).toBeLessThan(128);

    // WCAG AA body text vs card background
    expect(contrastRatio(cardFg, cardBg)).toBeGreaterThanOrEqual(4.5);

    // ── 2. .mandarin — present in real fixture (14/15 cards) ────────────
    const mandarinCount = await page.locator(".example .mandarin").count();
    expect(mandarinCount).toBeGreaterThan(0);
    const { fg: mFg, bg: mBg } = await locatorContrast(page.locator(".example .mandarin"));
    expect(contrastRatio(mFg, mBg)).toBeGreaterThanOrEqual(4.5);

    // ── 3. .example a (cyan links) — 111 in real fixture ────────────────
    const linkCount = await page.locator(".example a").count();
    expect(linkCount).toBeGreaterThan(0);
    const { fg: lFg, bg: lBg } = await locatorContrast(page.locator(".example a"));
    expect(contrastRatio(lFg, lBg)).toBeGreaterThanOrEqual(4.5);

    // ── 4. hruby ru zhuyin (tone marks) — 53 in real fixture ────────────
    const zhuyinCount = await page.locator(".example hruby ru zhuyin").count();
    expect(zhuyinCount).toBeGreaterThan(0);
    const { fg: zFg, bg: zBg } = await locatorContrast(page.locator(".example hruby ru zhuyin"));
    expect(contrastRatio(zFg, zBg)).toBeGreaterThanOrEqual(4.5);

    // ── 5. .example b — injected via route intercept ─────────────────────
    // b carries --moe-mark-bg as its own opaque background; locatorContrast
    // stops at that background rather than walking up to the card ancestor.
    const bCount = await page.locator(".example b").count();
    expect(bCount).toBeGreaterThan(0);
    const { fg: bFg, bg: bBg } = await locatorContrast(page.locator(".example b"));
    expect(contrastRatio(bFg, bBg)).toBeGreaterThanOrEqual(4.5);

    // ── 6. .example a.mark — injected via route intercept ────────────────
    const markCount = await page.locator(".example a.mark").count();
    expect(markCount).toBeGreaterThan(0);
    const { fg: aFg, bg: aBg } = await locatorContrast(page.locator(".example a.mark"));
    expect(contrastRatio(aFg, aBg)).toBeGreaterThanOrEqual(4.5);
  });
});

test.describe("phrase card contrast: Taiwanese example cards in light mode (negative control)", () => {
  test.use({ colorScheme: "light" });

  test("light mode: example card retains original light #eee background (fix does not alter light mode)", async ({
    page,
  }) => {
    const response = await page.goto(TAIWAN_PATH);
    expect(response?.status()).toBe(200);
    await page.waitForLoadState("networkidle");

    const exampleCount = await page.locator("body.lang-t .example").count();
    expect(exampleCount).toBeGreaterThan(0);

    const { bg } = await exampleCardColors(page);
    // In light mode the card stays at the legacy #eee — this confirms the
    // dark-mode fix does not alter light-mode appearance.
    expect(bg).toBe("rgb(238, 238, 238)");
  });
});
