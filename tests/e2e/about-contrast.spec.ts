import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./_fixtures";
import { waitForAppReady } from "./readiness";

// ---------------------------------------------------------------------------
// About page (/about) WCAG AA contrast regression, three real failures found
// by a systematic crawler (all pre-existing, About-scoped):
//
//   G. `.about-page .how-to-use-link a.btn.btn-info` — white text on the
//      Bootstrap `.btn-info` teal (#5bc0de / hover #46b8da). Ratio 2.09:1 /
//      2.30:1, fails in BOTH themes (the button background never changed
//      with the theme, so this was never a dark-mode-only bug).
//   H. `#how-to-use .guide-figures figcaption` — #888 on white. Ratio
//      3.54:1, fails in light mode only (dark mode's #1c1c1c surface
//      happened to push #888 to 4.81:1, just barely passing).
//   I. About page body/nav/external links — Bootstrap `#337ab7` on the dark
//      surface `#1c1c1c`. Ratio 3.74:1, fails in dark mode only (45
//      occurrences of `.about-page .content a` across the page).
//
// Fixed entirely in src/pages/About.css (About-scoped selectors only, no
// edits to src/index.css / data/assets/styles.css):
//   - `.about-page .content a` / `.about-page .content h2.cc0 a` now read
//     `var(--moe-link, #337ab7)` (the same custom property + fallback
//     convention `src/index.css` already uses for `.result a`), instead of
//     a hardcoded `#337ab7`. Light mode is byte-identical (fallback value
//     unchanged); dark mode picks up `--moe-link: #7fd0ff` (~10:1 on
//     `--moe-surface`).
//   - `.about-page .btn-info` (renamed from the theme-independent, global
//     `.btn-info` — this button's background never varies by theme, so no
//     `--moe-*` var is involved) darkens the background along the same hue
//     to `#1c728c` / hover+focus `#175e73`, both ≥4.5:1 against white text
//     in either theme.
//   - `.about-page .guide-figure figcaption` now reads
//     `var(--moe-text-secondary, #666)` — light-mode fallback darkened from
//     #888 (3.54:1) to #666 (5.74:1); dark mode already had
//     `--moe-text-secondary: #aaa` defined (7.34:1 on `--moe-surface`).
// ---------------------------------------------------------------------------

const ABOUT_PATH = "/about";

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

/**
 * Returns `{fg, bg}` for the first element matched by `loc`, where `bg` is
 * the nearest non-transparent painted background (self or ancestor).
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

/** Computed `{color, backgroundColor}` of the element itself (for a self-painted CTA button). */
async function ownColors(loc: Locator): Promise<{ color: string; backgroundColor: string }> {
  return loc.first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return { color: cs.color, backgroundColor: cs.backgroundColor };
  });
}

async function gotoAbout(page: Page): Promise<void> {
  const response = await page.goto(ABOUT_PATH);
  expect(response?.status()).toBe(200);
  // "shell" (default) only waits for `body` visible, which can resolve
  // before About.tsx's body-class effect / legacy-stylesheet loads settle
  // -- see readiness.ts's "about" kind for the exact race this closes.
  await waitForAppReady(page, "about");
}

// ---------------------------------------------------------------------------
// G. CTA button: 萌典功能使用說明 (.how-to-use-link .btn.btn-info)
// ---------------------------------------------------------------------------

test.describe("About page CTA button contrast (.how-to-use-link .btn-info)", () => {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`${colorScheme} mode: base state meets WCAG AA (was white/#5bc0de, 2.09:1)`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await gotoAbout(page);

      // #159 新增了第二顆共用 .btn-info 樣式的「API 串接說明」按鈕，故以
      // 文字鎖定「萌典功能使用說明」這顆；兩顆樣式相同，對比保證一致。
      const cta = page.locator(".how-to-use-link a.btn.btn-info", {
        hasText: "萌典功能使用說明",
      });
      await expect(cta).toHaveCount(1);
      await expect(cta).toHaveText(/萌典功能使用說明/);

      const { color, backgroundColor } = await ownColors(cta);
      expect(color).toBe("rgb(255, 255, 255)");
      expect(backgroundColor).toBe("rgb(28, 114, 140)"); // #1c728c, theme-independent
      expect(contrastRatio(color, backgroundColor)).toBeGreaterThanOrEqual(4.5);
    });

    test(`${colorScheme} mode: hover state meets WCAG AA (was white/#46b8da, 2.30:1)`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await gotoAbout(page);

      const cta = page.locator(".how-to-use-link a.btn.btn-info", {
        hasText: "萌典功能使用說明",
      });
      await cta.hover();

      const { color, backgroundColor } = await ownColors(cta);
      expect(color).toBe("rgb(255, 255, 255)");
      expect(backgroundColor).toBe("rgb(23, 94, 115)"); // #175e73
      expect(contrastRatio(color, backgroundColor)).toBeGreaterThanOrEqual(4.5);
    });

    test(`${colorScheme} mode: keyboard focus state meets WCAG AA`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await gotoAbout(page);

      const cta = page.locator(".how-to-use-link a.btn.btn-info", {
        hasText: "萌典功能使用說明",
      });
      await cta.focus();
      await expect(cta).toBeFocused();

      const { color, backgroundColor } = await ownColors(cta);
      expect(color).toBe("rgb(255, 255, 255)");
      expect(backgroundColor).toBe("rgb(23, 94, 115)"); // shares :hover, :focus-visible styling
      expect(contrastRatio(color, backgroundColor)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

// ---------------------------------------------------------------------------
// H. figcaption under 使用說明 screenshot thumbnails (light-only failure)
// ---------------------------------------------------------------------------

test.describe("About page guide-figure figcaption contrast", () => {
  test("light mode: figcaption meets WCAG AA (was #888/white, 3.54:1)", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await gotoAbout(page);

    const caption = page.locator(".about-page .guide-figure figcaption").first();
    await expect(caption).toHaveCount(1);

    const { fg, bg } = await locatorContrast(caption);
    expect(fg).toBe("rgb(102, 102, 102)"); // #666 fallback
    expect(bg).toBe("rgb(255, 255, 255)");
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test("dark mode: figcaption meets WCAG AA via --moe-text-secondary (was #888/#1c1c1c, 4.81:1 — already technically passing, now uses the themed var consistently)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await gotoAbout(page);

    const caption = page.locator(".about-page .guide-figure figcaption").first();
    await expect(caption).toHaveCount(1);

    const { fg, bg } = await locatorContrast(caption);
    expect(fg).toBe("rgb(170, 170, 170)"); // --moe-text-secondary: #aaa
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

// ---------------------------------------------------------------------------
// I. Body/external content links (.about-page .content a) — dark-only failure
// ---------------------------------------------------------------------------

test.describe("About page body link contrast (.about-page .content a:not(.btn))", () => {
  // `.about-page .content a` also matches the CTA button (.how-to-use-link
  // a.btn.btn-info, covered separately above as finding G) since that link
  // lives inside the same `.content` wrapper. Exclude `.btn` links here so
  // this describe block only exercises plain body/external content links —
  // finding I's actual target.
  const BODY_LINK_SELECTOR = ".about-page .content a:not(.btn)";

  test("light mode: links keep the original #337ab7 (fix does not alter light mode)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await gotoAbout(page);

    const links = page.locator(BODY_LINK_SELECTOR);
    const count = await links.count();
    expect(count).toBeGreaterThan(40); // crawler counted 45 occurrences

    const color = await links.first().evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(51, 122, 183)"); // #337ab7, byte-identical fallback

    const { fg, bg } = await locatorContrast(links.first());
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test("dark mode: links meet WCAG AA via --moe-link (was #337ab7/#1c1c1c, 3.74:1)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await gotoAbout(page);

    const links = page.locator(BODY_LINK_SELECTOR);
    const count = await links.count();
    expect(count).toBeGreaterThan(40);

    // Spot-check the first link and the CC0 heading link — both consumed by
    // the same fix (`.content a` and `.content h2.cc0 a`).
    const color = await links.first().evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(127, 208, 255)"); // --moe-link: #7fd0ff

    const { fg, bg } = await locatorContrast(links.first());
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);

    const cc0Link = page.locator(".about-page .content h2.cc0 a");
    await expect(cc0Link).toHaveCount(1);
    const { fg: cc0Fg, bg: cc0Bg } = await locatorContrast(cc0Link);
    expect(cc0Fg).toBe("rgb(127, 208, 255)");
    expect(contrastRatio(cc0Fg, cc0Bg)).toBeGreaterThanOrEqual(4.5);
  });

  test("dark mode: every .about-page .content a:not(.btn) meets WCAG AA (full ~45-occurrence sweep)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await gotoAbout(page);

    const links = page.locator(BODY_LINK_SELECTOR);
    const count = await links.count();
    expect(count).toBeGreaterThan(40);

    const ratios = await links.evaluateAll((els) =>
      els.map((el) => {
        let cur: Element | null = el;
        let bg = "rgb(255, 255, 255)";
        while (cur) {
          const c = getComputedStyle(cur).backgroundColor;
          if (c !== "rgba(0, 0, 0, 0)" && c !== "transparent") {
            bg = c;
            break;
          }
          cur = cur.parentElement;
        }
        return { fg: getComputedStyle(el).color, bg };
      }),
    );

    for (const { fg, bg } of ratios) {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("dark mode: link hover keeps sufficient contrast (color unchanged on :hover, only underline added)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await gotoAbout(page);

    const link = page.locator(BODY_LINK_SELECTOR).first();
    await link.hover();

    const { fg, bg } = await locatorContrast(link);
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    const textDecoration = await link.evaluate((el) => getComputedStyle(el).textDecorationLine);
    expect(textDecoration).toBe("underline");
  });
});
