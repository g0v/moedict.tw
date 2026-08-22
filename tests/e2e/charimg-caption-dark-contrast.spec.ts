import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./_fixtures";

// Regression guard: CharacterImageView's .moetext table has a fixed light
// `background: "#eee"` inline style (never theme-aware — the tile PNG stays
// light by design). .charimg-caption text had no color override, so it
// inherited --moe-text (#e6e3df, near-white in dark mode) on the light
// tile — ~1.1:1 contrast, unreadable. Fixed by pinning an explicit dark-safe
// color (#333) on .charimg-caption that stays constant in both themes
// (matching the fixed-background convention used for div.cn-specific,
// see dark-mode.spec.ts "audit-dark-contrast E").

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

/** Computed foreground color and nearest painted ancestor background. */
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

// data/dictionary/pack/12.txt and 707.txt (萌, 黃) both have real dictionary
// entries with pinyin+bopomofo but no combined 萌黃 entry, so DictionaryPage
// falls back to CharacterImageView's per-character segment view — matches
// the fixture already used in dictionary.spec.ts's romanize checkbox tests.
const FALLBACK_PATH = "/%E8%90%8C%E9%BB%83";

async function openCaption(page: Page): Promise<Locator> {
  const response = await page.goto(FALLBACK_PATH);
  // No combined 萌黃 entry ⇒ R4 answers 404 with the SPA shell body intact,
  // which is precisely the CharacterImageView surface this audit measures.
  expect(response?.status()).toBe(404);
  await page.locator(".charimg-result").waitFor({ state: "visible", timeout: 15_000 });
  await page
    .locator("img.charimg-glyph-segment")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });

  const checkbox = page.locator("#charimg-romanize");
  await checkbox.check();
  const caption = page.locator(".charimg-caption").first();
  await expect(caption).toBeVisible();
  return caption;
}

test.describe("audit-dark-contrast: CharacterImageView .charimg-caption on fixed-light tile", () => {
  test("dark mode: caption pinyin/bopomofo text meets WCAG AA against the fixed #eee tile background", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const caption = await openCaption(page);

    const table = page.locator("table.moetext").first();
    const tableBg = await table.evaluate((el) => getComputedStyle(el).backgroundColor);
    // The tile background is a fixed inline style — must stay light in dark mode.
    expect(tableBg).toBe("rgb(238, 238, 238)");

    // Assert the nested .pinyin/.bopomofo spans directly — .bopomofo carries
    // its own global dark-mode override (index.css audit-dark-contrast B)
    // that would win over an inherited container color if not pinned.
    const pinyin = caption.locator(".pinyin").first();
    await expect(pinyin).toBeVisible();
    const { fg: pinyinFg, bg: pinyinBg } = await locatorContrast(pinyin);
    expect(contrastRatio(pinyinFg, pinyinBg)).toBeGreaterThanOrEqual(4.5);

    const bopomofo = caption.locator(".bopomofo").first();
    await expect(bopomofo).toBeVisible();
    const { fg: bopomofoFg, bg: bopomofoBg } = await locatorContrast(bopomofo);
    expect(contrastRatio(bopomofoFg, bopomofoBg)).toBeGreaterThanOrEqual(4.5);
  });

  test("light mode: caption pinyin/bopomofo keep their original readable color (fix does not alter light mode)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    const caption = await openCaption(page);

    const pinyin = caption.locator(".pinyin").first();
    await expect(pinyin).toBeVisible();
    const { fg: pinyinFg, bg: pinyinBg } = await locatorContrast(pinyin);
    expect(contrastRatio(pinyinFg, pinyinBg)).toBeGreaterThanOrEqual(4.5);

    const bopomofo = caption.locator(".bopomofo").first();
    await expect(bopomofo).toBeVisible();
    const { fg: bopomofoFg, bg: bopomofoBg } = await locatorContrast(bopomofo);
    expect(contrastRatio(bopomofoFg, bopomofoBg)).toBeGreaterThanOrEqual(4.5);
  });
});
