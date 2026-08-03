import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "./_fixtures";
import { waitForAppReady } from "./readiness";

// Regression coverage for g0v/moedict-webkit#245 ("CSS: 支援深色模式").
//
// Three activation paths are exercised:
//   1. Pure OS preference (`prefers-color-scheme: dark`), no localStorage —
//      must work even before src/main.tsx has run.
//   2. An explicit "dark"/"light" override in localStorage, which must win
//      over the OS preference either way.
//   3. Live toggling via the #user-pref "外觀模式" control, which must not
//      require a reload (unlike the phonetics/pinyin prefs).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const STYLES_CSS_PATH = path.join(REPO_ROOT, "data", "assets", "styles.css");

/** Reads the working-tree legacy stylesheet (see tests/e2e/legacy-styles-regression.spec.ts). */
function readWorkingTreeStylesCss(): string {
  return readFileSync(STYLES_CSS_PATH, "utf-8");
}

// Legacy data/assets/styles.css is not seeded in this test server's ASSETS
// fixture (AGENTS.md 舊版樣式 — the harness's ASSET_BASE_URL is a fake
// r2-assets.test.local host, blocked 404 by _fixtures.ts). Registered AFTER
// that blanket blocker so Playwright's most-recently-registered-route-wins
// order lets this intercept win for styles.css specifically. Mirrors the
// identical helper in legacy-styles-regression.spec.ts (kept local rather
// than shared to avoid coupling two independent spec files' internals).
async function routeStylesCss(page: Page, getCss: () => string): Promise<void> {
  const handler = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "text/css; charset=utf-8",
      headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: getCss(),
    });
  await page.route("https://r2-assets.test.local/styles.css", handler);
  await page.route("https://r2-assets.test.local/styles.css?*", handler);
  await page.route("**/assets/styles.css", handler);
  await page.route("**/assets/styles.css?*", handler);
}

// The real stylesheet's relative url() font/image references don't exist as
// static assets in this test build; block them so networkidle can still fire
// (see legacy-styles-regression.spec.ts for the full rationale).
async function blockCssSubresources(page: Page): Promise<void> {
  const notFound = (route: Route) =>
    route.fulfill({ status: 404, contentType: "text/plain; charset=utf-8", body: "" });
  await page.route("**/assets/fonts/**", (route) => {
    if (new URL(route.request().url()).pathname.includes("/MOEDICT.")) {
      return route.fallback();
    }
    return notFound(route);
  });
  await page.route("**/assets/images/leather_x2.jpg", notFound);
  await page.route("**/assets/images/subtle_stripes_x2.png", notFound);
}
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
    await waitForAppReady(page, "dictionary");

    expect(await colorScheme(page)).toBe("dark");
    expect(await resultBackground(page)).not.toBe("rgb(255, 255, 255)");
  });

  test("light override on a dark system", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(() => {
      window.localStorage.setItem("theme", "light");
    });
    await page.goto(ENTRY_PATH);
    await waitForAppReady(page, "dictionary");

    expect(await colorScheme(page)).toBe("light");
    expect(await resultBackground(page)).toBe("rgb(255, 255, 255)");
  });
});

test.describe("#user-pref 外觀模式 control", () => {
  test("switching to 深色 applies immediately, no reload, and persists", async ({ page }) => {
    await page.goto(ENTRY_PATH);
    await waitForAppReady(page, "dictionary");
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
    await waitForAppReady(page, "dictionary");

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
    await waitForAppReady(page, "dictionary");

    const exampleCount = await page.locator("body.lang-t .example").count();
    expect(exampleCount).toBeGreaterThan(0);

    const { bg } = await exampleCardColors(page);
    // In light mode the card stays at the legacy #eee — this confirms the
    // dark-mode fix does not alter light-mode appearance.
    expect(bg).toBe("rgb(238, 238, 238)");
  });
});

// ---------------------------------------------------------------------------
// Cross-reference hover tooltip (useRadicalTooltip.ts) — /萌 hovering 生.
// Regression for two bugs reported against dark mode (and reproduced in
// light mode's own geometry defect too):
//   1. `body .ui-tooltip { background: #fffcfc !important }` (legacy
//      styles.css) stayed white in dark mode while its content adopted
//      dark-mode text colors (--moe-text etc.), producing near-invisible
//      definition text. Fixed in src/index.css with a themed override.
//   2. `.romanization-selectable` (the invisible-but-selectable pinyin/
//      zhuyin span) is only `position: absolute` when scoped under
//      `.result .entry .title` — the tooltip's title falls back to the
//      legacy in-flow default, inflating the `<ru>` box and shifting the
//      `::before`-painted pinyin glyph to the right of the character.
// ---------------------------------------------------------------------------

const HOVER_ENTRY_PATH = "/%E8%90%8C"; // 萌 — definition text contains 生

// The tooltip fetches /api/<title>.json itself (src/utils/radical-page-utils.ts
// fetchJsonByToken), independent of whatever xref happens to resolve on the
// page. Intercepting it decouples the test from fixture link topology and
// guarantees the tooltip renders a real `hruby.rightangle` ruby title (with
// bopomofo+pinyin) regardless of what data is seeded for 生 upstream.
const HOVER_TARGET_API_PATTERN = /\/api\/%E7%94%9F\.json/; // /api/生.json

async function routeHoverTargetEntry(page: Page): Promise<void> {
  await page.route(HOVER_TARGET_API_PATTERN, (route) =>
    route.fulfill({
      json: {
        title: "生",
        heteronyms: [
          {
            bopomofo: "ㄕㄥ",
            pinyin: "shēng",
            definitions: [{ def: "長出、生長。", type: "動" }],
          },
        ],
      },
    }),
  );
}

/** Hover the 生 cross-reference link inside /萌's definitions and wait for the tooltip. */
async function openRadicalHoverTooltip(page: Page): Promise<Locator> {
  await routeHoverTargetEntry(page);
  const response = await page.goto(HOVER_ENTRY_PATH);
  expect(response?.status()).toBe(200);
  await waitForAppReady(page, "dictionary");

  const target = page.locator(".result a[href]", { hasText: "生" }).first();
  await target.hover();
  const tooltip = page.locator(".ui-tooltip");
  await expect(tooltip).toBeVisible({ timeout: 3000 });
  // Wait for the async tooltip content fetch (loading placeholder → real entry).
  await expect(tooltip.locator(".title hruby.rightangle ru[annotation]").first()).toBeVisible({
    timeout: 3000,
  });
  return tooltip;
}

test.describe("cross-reference hover tooltip: dark mode contrast", () => {
  test.use({ colorScheme: "dark" });

  test("dark mode: tooltip background is dark and definition text meets WCAG AA", async ({
    page,
  }) => {
    const tooltip = await openRadicalHoverTooltip(page);

    const tooltipBg = await tooltip.evaluate((el) => getComputedStyle(el).backgroundColor);
    // Exact expected computed value: --moe-surface (#1c1c1c) from src/index.css,
    // overriding the legacy `#fffcfc !important` background. Legacy
    // styles.css is not seeded in this test's ASSETS fixture (see
    // legacy-styles-regression.spec.ts), so the `!important` override has no
    // opponent here — the light-mode negative-control test below injects the
    // real legacy CSS to prove the override actually wins against it.
    expect(tooltipBg).toBe("rgb(28, 28, 28)");

    const { fg: defFg, bg: defBg } = await locatorContrast(tooltip.locator(".def").first());
    expect(contrastRatio(defFg, defBg)).toBeGreaterThanOrEqual(4.5);

    const titleColor = await tooltip
      .locator(".title .h1")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    // --moe-text (#e6e3df) from InlineStyles.tsx's themed override, no longer
    // hardcoded #000.
    expect(titleColor).toBe("rgb(230, 227, 223)");

    // Part-of-speech badge (名/動) keeps its always-legible white-on-#6b0000
    // treatment in both themes — assert it stayed that way, not accidentally
    // themed into unreadable territory.
    const badge = tooltip.locator(".part-of-speech").first();
    await expect(badge).toBeVisible();
    const { fg: badgeFg, bg: badgeBg } = await locatorContrast(badge);
    expect(contrastRatio(badgeFg, badgeBg)).toBeGreaterThanOrEqual(4.5);
  });
});

test.describe("cross-reference hover tooltip: light mode (negative control, real legacy CSS)", () => {
  test.use({ colorScheme: "light" });

  test("light mode: tooltip keeps original white background and black title against the real legacy stylesheet (fix does not alter light mode)", async ({
    page,
  }) => {
    // Inject the real data/assets/styles.css (not seeded by default in this
    // harness — see AGENTS.md 舊版樣式) so this control actually exercises
    // the legacy `body .ui-tooltip { background: #fffcfc !important }` rule
    // the dark-mode override in src/index.css is written to beat.
    await routeStylesCss(page, readWorkingTreeStylesCss);
    await blockCssSubresources(page);
    const tooltip = await openRadicalHoverTooltip(page);

    const tooltipBg = await tooltip.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(tooltipBg).toBe("rgb(255, 252, 252)");

    const titleColor = await tooltip
      .locator(".title .h1")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    expect(titleColor).toBe("rgb(0, 0, 0)");
  });
});

test.describe("cross-reference hover tooltip: pinyin/zhuyin geometry", () => {
  /**
   * Returns the `<ru annotation>` box width for the tooltip title's ruby —
   * a proxy for whether `.romanization-selectable` collapsed to
   * `position: absolute` (narrow box, matching the rendered character width)
   * or stayed in-flow (wide box, inflated by the full "shēng"-length text,
   * which shifts the `::before`-painted pinyin glyph rightward since its
   * `left`/`width` are percentages of this box).
   */
  async function tooltipRuWidth(tooltip: Locator): Promise<number> {
    return tooltip
      .locator(".title hruby.rightangle ru[annotation]")
      .first()
      .evaluate((el) => el.getBoundingClientRect().width);
  }

  for (const [name, scheme] of [
    ["dark", "dark"],
    ["light", "light"],
  ] as const) {
    test(`${name} mode: pinyin stays centered under the character (ru box not inflated by in-flow selectable span)`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const tooltip = await openRadicalHoverTooltip(page);

      const ruWidth = await tooltipRuWidth(tooltip);
      // The rendered "生" character box only needs to hold the single glyph
      // (~46-90px depending on font-fallback metrics in this test
      // environment vs. a browser with the real Biaodian Pro Serif CNS font
      // loaded). Before the fix, the in-flow `.romanization-selectable`
      // span ("shēng") inflated this box to ~2.7x the glyph-only width
      // (measured 127.8px vs 46.5px with the real font loaded), which
      // pushed the percentage-positioned `::before` pinyin glyph well to
      // the right of the character. Bound generously above the single-glyph
      // width but well below the ~2.7x-inflated regression to stay robust
      // to font-fallback differences while still catching the regression.
      expect(ruWidth).toBeGreaterThan(20);
      expect(ruWidth).toBeLessThan(120);

      const selPosition = await tooltip
        .locator(".title hruby.rightangle ru[annotation] > .romanization-selectable")
        .first()
        .evaluate((el) => getComputedStyle(el).position);
      expect(selPosition).toBe("absolute");
    });
  }
});

// ---------------------------------------------------------------------------
// InlineStyles.tsx injected-CSS layer — a THIRD styling surface distinct
// from src/index.css and the legacy data/assets/styles.css, used for
// jQuery-UI/audio-button parity rules. Discovered via a local-vs-prod visual
// sweep to have zero dark-mode awareness: several rules hardcoded their
// light-mode color with no `var(--moe-*, …)` fallback, producing
// near-invisible text/icons against the dark surface:
//   - `.part-of-speech.playAudio` / `.playAudio` (audio button icon):
//     #6B0000 on --moe-surface (#1c1c1c) ≈ 1.45:1
//   - `.reading-only-note` (TWBLG 本音讀無義項提示): #666 on --moe-surface
//     ≈ 2.97:1
//   - `.ui-autocomplete.search-results .ui-menu-item` text/status/hover
//     (sidebar #query autocomplete dropdown): #333/#666 text on the
//     already-dark-aware container ≈ 1.35:1 / 2.97:1
// Also covers `.fulltext-search-status` / `.fulltext-search-result-snippet`
// in src/index.css, which had the identical gap (dark-aware container
// background but a hardcoded #666 status/snippet color).
// ---------------------------------------------------------------------------

test.describe("audio play-button icon contrast (InlineStyles.tsx .playAudio)", () => {
  test("dark mode: .playAudio meets WCAG AA against the dark surface (was #6B0000, ~1.45:1)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const response = await page.goto(ENTRY_PATH);
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "dictionary");

    const button = page.locator(".playAudio.part-of-speech").first();
    await expect(button).toHaveCount(1);

    const { fg, bg } = await locatorContrast(button);
    // Exact expected value: --moe-audio-accent (#ffa8a8) from src/index.css,
    // replacing the hardcoded #6B0000.
    expect(fg).toBe("rgb(255, 168, 168)");
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test("light mode: .playAudio keeps the original #6B0000 (fix does not alter light mode)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    const response = await page.goto(ENTRY_PATH);
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "dictionary");

    const button = page.locator(".playAudio.part-of-speech").first();
    await expect(button).toHaveCount(1);
    const color = await button.evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(107, 0, 0)");
  });
});

test.describe("reading-only-note contrast (InlineStyles.tsx .reading-only-note)", () => {
  // 長褲 (t): pinned no-definition/no-audio-id fixture — carries
  // .reading-only-note but no .playAudio button (distinct from the
  // per-heteronym reading-only shape covered elsewhere in dictionary.spec.ts).
  const PINNED_NO_DEFINITION_PATH = "/'%E9%95%B7%E8%A4%B2"; // 長褲

  test("dark mode: .reading-only-note meets WCAG AA (was #666, ~2.97:1)", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const response = await page.goto(PINNED_NO_DEFINITION_PATH);
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "dictionary");

    const note = page.locator(".reading-only-note").first();
    await expect(note).toHaveCount(1);
    await expect(note).toHaveText("本音讀無義項。");

    const { fg, bg } = await locatorContrast(note);
    // Exact expected value: --moe-text-secondary (#aaa).
    expect(fg).toBe("rgb(170, 170, 170)");
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test("light mode: .reading-only-note keeps the original #666 (fix does not alter light mode)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    const response = await page.goto(PINNED_NO_DEFINITION_PATH);
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "dictionary");

    const note = page.locator(".reading-only-note").first();
    await expect(note).toHaveCount(1);
    const color = await note.evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(102, 102, 102)");
  });
});

test.describe("full-text search status/snippet contrast (src/index.css)", () => {
  test("dark mode: .fulltext-search-status meets WCAG AA against the themed panel (was #666, ~2.97:1)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const response = await page.goto(ENTRY_PATH);
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "dictionary");

    const input = page.locator("#nav-fulltext-search").first();
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.click();
    await input.fill("萌");

    const panel = page.locator(".fulltext-search-panel");
    await expect(panel).toBeVisible({ timeout: 5_000 });
    const panelBg = await panel.evaluate((el) => getComputedStyle(el).backgroundColor);
    // --moe-surface (#1c1c1c) — the panel background was already dark-aware
    // before this fix; only its status/snippet text color was not.
    expect(panelBg).toBe("rgb(28, 28, 28)");

    const status = page.locator(".fulltext-search-status").first();
    await expect(status).toHaveCount(1);
    const { fg, bg } = await locatorContrast(status);
    // Exact expected value: --moe-text-secondary (#aaa).
    expect(fg).toBe("rgb(170, 170, 170)");
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test("light mode: .fulltext-search-status keeps the original #666 (fix does not alter light mode)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    const response = await page.goto(ENTRY_PATH);
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "dictionary");

    const input = page.locator("#nav-fulltext-search").first();
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.click();
    await input.fill("萌");

    const status = page.locator(".fulltext-search-status").first();
    await expect(status).toBeVisible({ timeout: 5_000 });
    const color = await status.evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(102, 102, 102)");
  });
});

test.describe("sidebar autocomplete dropdown contrast (InlineStyles.tsx .ui-autocomplete)", () => {
  test("dark mode: suggestion item text and status row meet WCAG AA against the themed panel", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const response = await page.goto(ENTRY_PATH);
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "dictionary");

    const input = page.locator("#query");
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.click();
    await input.fill("萌");

    const list = page.locator("#sidebar-search-results");
    await expect(list).toBeVisible({ timeout: 10_000 });
    const panelBg = await list.evaluate((el) => getComputedStyle(el).backgroundColor);
    // --moe-surface (#1c1c1c) — already dark-aware via `html .ui-widget-content`
    // in src/index.css.
    expect(panelBg).toBe("rgb(28, 28, 28)");

    const suggestion = list.locator('a[role="button"]').first();
    await expect(suggestion).toBeVisible({ timeout: 10_000 });
    const { fg: suggestionFg, bg: suggestionBg } = await locatorContrast(suggestion);
    // Exact expected value: --moe-text (#e6e3df), replacing the hardcoded #333.
    expect(suggestionFg).toBe("rgb(230, 227, 223)");
    expect(contrastRatio(suggestionFg, suggestionBg)).toBeGreaterThanOrEqual(4.5);
  });

  test('dark mode: is-status row ("找不到符合結果" / "搜尋中…") meets WCAG AA', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const response = await page.goto(ENTRY_PATH);
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "dictionary");

    const input = page.locator("#query");
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.click();
    // A query unlikely to match any seeded fixture entry — forces the
    // "沒有符合結果" .is-status row instead of a real suggestion.
    await input.fill("ㄅㄆㄇㄈ無此詞彙測試字串");

    const status = page.locator("#sidebar-search-results .ui-menu-item.is-status").first();
    await expect(status).toBeVisible({ timeout: 10_000 });
    const { fg, bg } = await locatorContrast(status);
    // Exact expected value: --moe-text-secondary (#aaa), replacing the
    // hardcoded #666.
    expect(fg).toBe("rgb(170, 170, 170)");
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test("light mode: suggestion item text keeps the original #333 (fix does not alter light mode)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    const response = await page.goto(ENTRY_PATH);
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "dictionary");

    const input = page.locator("#query");
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.click();
    await input.fill("萌");

    const suggestion = page.locator('#sidebar-search-results a[role="button"]').first();
    await expect(suggestion).toBeVisible({ timeout: 10_000 });
    const color = await suggestion.evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(51, 51, 51)");
  });
});

test.describe("mobile dark-mode search results & controls (490×1376, real mobile viewport)", () => {
  // Regression coverage for the reported bug: at a real mobile viewport with
  // dark mode active, `.ui-autocomplete.search-results` rows rendered as
  // light-gray pills with near-white text. Root cause: the legacy
  // `.query-box li a { background-color: rgba(255,255,255,.8) }` rule
  // (data/assets/styles.css) has higher specificity (1 class + 2 type) than
  // `.ui-autocomplete.search-results .ui-menu-item a` had *no* background
  // rule of its own to compete with it — so the semi-transparent white pill
  // painted straight over the (correctly) dark `--moe-surface` container,
  // and `--moe-text` (#e6e3df) read as ~1.2:1 against it. Fixed in
  // InlineStyles.tsx by giving the anchor its own `background: var(--moe-surface,
  // rgba(255,255,255,.8))` rule at equal-or-higher specificity.
  test.use({ viewport: { width: 490, height: 1376 } });

  async function openMobileResults(page: Page, term: string): Promise<void> {
    const input = page.locator("#query");
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill(term);
    await input.press("Enter");
  }

  test("dark mode: suggestion row is no longer a light-gray pill with near-white text", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "shell");

    await openMobileResults(page, "萌");

    const list = page.locator("#sidebar-search-results");
    await expect(list).toBeVisible({ timeout: 10_000 });
    const containerBg = await list.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(containerBg).toBe("rgb(28, 28, 28)"); // --moe-surface

    const li = list.locator(".ui-menu-item:not(.is-status)").first();
    await expect(li).toBeVisible({ timeout: 10_000 });
    const liBorder = await li.evaluate((el) => getComputedStyle(el).borderBottomColor);
    expect(liBorder).toBe("rgb(61, 61, 61)"); // --moe-border, replacing hardcoded #eee streak

    const anchor = li.locator('a[role="button"]').first();
    await expect(anchor).toBeVisible();
    const anchorStyle = await anchor.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        backgroundColor: cs.backgroundColor,
        backgroundImage: cs.backgroundImage,
        color: cs.color,
      };
    });
    // Was rgba(255, 255, 255, 0.8) (near-white pill, from legacy
    // `.query-box li a`) — now matches the dark container background exactly,
    // so the row is visually seamless rather than a pale rectangle.
    expect(anchorStyle.backgroundColor).toBe("rgb(28, 28, 28)");
    expect(anchorStyle.backgroundImage).toBe("none");
    expect(anchorStyle.color).toBe("rgb(230, 227, 223)"); // --moe-text
    expect(contrastRatio(anchorStyle.color, anchorStyle.backgroundColor)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  test("dark mode: hover/focus row uses the themed accent, not the legacy light-blue jQuery UI gradient", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "shell");

    await openMobileResults(page, "萌");

    const anchor = page
      .locator('#sidebar-search-results .ui-menu-item:not(.is-status) a[role="button"]')
      .first();
    await expect(anchor).toBeVisible({ timeout: 10_000 });
    await anchor.hover();

    const hoverStyle = await anchor.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        backgroundColor: cs.backgroundColor,
        backgroundImage: cs.backgroundImage,
        color: cs.color,
      };
    });
    // Was #e4f1fb / #0070a3 (hardcoded light-blue jQuery UI cupertino
    // palette) unconditionally, even in dark mode. Now themed via
    // --moe-surface-alt / --moe-link, with the legacy
    // `.ui-state-hover` gradient explicitly cleared.
    expect(hoverStyle.backgroundColor).toBe("rgb(42, 42, 42)"); // --moe-surface-alt
    expect(hoverStyle.backgroundImage).toBe("none");
    expect(hoverStyle.color).toBe("rgb(127, 208, 255)"); // --moe-link
    expect(contrastRatio(hoverStyle.color, hoverStyle.backgroundColor)).toBeGreaterThanOrEqual(4.5);
  });

  test("dark mode: mobile overlay controls (#query, clear ×, back arrow, contain-list toggle) are all readable", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const response = await page.goto(ENTRY_PATH);
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "dictionary");

    const input = page.locator("#query");
    await expect(input).toHaveValue("萌", { timeout: 15_000 });

    // #query: native dark-themed form control (browser-painted, not a fixed
    // --moe-* value) — assert contrast rather than an exact rgb so this
    // stays stable across browser/engine UA-stylesheet differences.
    const { fg: queryFg, bg: queryBg } = await locatorContrast(input);
    expect(contrastRatio(queryFg, queryBg)).toBeGreaterThanOrEqual(4.5);

    // × clear button: was #bfc0c2 bg / #fff text (1.82:1, fails AA) in every
    // theme. Now --moe-surface-alt in dark mode.
    const clearBtn = page.getByRole("button", { name: "清除搜尋字詞" });
    await expect(clearBtn).toBeVisible();
    const clearStyle = await clearBtn.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { backgroundColor: cs.backgroundColor, color: cs.color };
    });
    expect(clearStyle.backgroundColor).toBe("rgb(42, 42, 42)"); // --moe-surface-alt
    expect(clearStyle.color).toBe("rgb(255, 255, 255)");
    expect(contrastRatio(clearStyle.color, clearStyle.backgroundColor)).toBeGreaterThanOrEqual(4.5);

    // Back arrow chevron: was hardcoded #990012 (brand red) in every theme —
    // 1.97:1 against the dark query-box background, well under the 3:1 floor
    // for non-text UI components. Now --moe-audio-accent in dark mode.
    const chevron = page.locator(".mobile-search-back-chevron");
    await expect(chevron).toBeVisible();
    const chevronBorder = await chevron.evaluate((el) => getComputedStyle(el).borderLeftColor);
    expect(chevronBorder).toBe("rgb(255, 168, 168)"); // --moe-audio-accent

    // Contain-list toggle: submit to render it, then check its themed panel.
    await input.press("Enter");
    const toggle = page.getByRole("button", { name: /列出所有含有「萌」的詞/ });
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    const toggleStyle = await toggle.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { backgroundColor: cs.backgroundColor, color: cs.color };
    });
    expect(toggleStyle.backgroundColor).toBe("rgb(42, 42, 42)"); // --moe-surface-alt
    expect(toggleStyle.color).toBe("rgb(230, 227, 223)"); // --moe-text
    expect(contrastRatio(toggleStyle.color, toggleStyle.backgroundColor)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  test("light mode (negative control): mobile results row and controls keep their original colors unchanged", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "shell");

    await openMobileResults(page, "萌");

    const anchor = page
      .locator('#sidebar-search-results .ui-menu-item:not(.is-status) a[role="button"]')
      .first();
    await expect(anchor).toBeVisible({ timeout: 10_000 });
    const baseStyle = await anchor.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(baseStyle).toBe("rgba(255, 255, 255, 0.8)"); // legacy `.query-box li a`, untouched

    await anchor.hover();
    const hoverStyle = await anchor.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { backgroundColor: cs.backgroundColor, color: cs.color };
    });
    expect(hoverStyle.backgroundColor).toBe("rgb(228, 241, 251)"); // original #e4f1fb
    expect(hoverStyle.color).toBe("rgb(0, 112, 163)"); // original #0070a3

    const clearBtn = page.getByRole("button", { name: "清除搜尋字詞" });
    await expect(clearBtn).toBeVisible();
    const clearStyle = await clearBtn.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(clearStyle).toBe("rgb(191, 192, 194)"); // original #bfc0c2, unchanged

    const chevronBorder = await page
      .locator(".mobile-search-back-chevron")
      .evaluate((el) => getComputedStyle(el).borderLeftColor);
    expect(chevronBorder).toBe("rgb(153, 0, 18)"); // original #990012, unchanged
  });
});

// ---------------------------------------------------------------------------
// scripts/audit-dark-contrast.mjs findings A–E/J/K (2026-07-18 crawl).
// All fixes read through --moe-* vars (A/B/E/K) or a flat theme-independent
// color (C/D/J); every dark assertion below injects the REAL legacy
// data/assets/styles.css (routeStylesCss + blockCssSubresources) so the
// measured ratio is against the actual competing rule, not a vacuum.
// ---------------------------------------------------------------------------

const HAKKA_PATH = "/%3A%E5%AD%97"; // :字
const CN_XREF_PATH = "/~%E4%B8%8A%E8%A8%B4"; // ~上訴 (seeded lang-c fixture)
const CN_API_PATTERN = /\/api\/~[^?]*\.json/;

/** Intercept the ~上訴 JSON API to inject a synthetic `alt` field — no seeded
 * lang-c fixture carries `A`/`alt` (簡體字), the source field
 * `div.cn-specific` renders from. */
async function routeCnSpecificAlt(page: Page): Promise<void> {
  await page.route(CN_API_PATTERN, async (route) => {
    const resp = await route.fetch();
    const json = await resp.json();
    const heteronyms = json.heteronyms as Record<string, unknown>[];
    if (heteronyms?.[0]) heteronyms[0].alt = "东西";
    await route.fulfill({ json });
  });
}

test.describe("audit-dark-contrast A: title zhuyin yin/diao (was #666 on #1c1c1c, 2.97:1)", () => {
  test("dark mode: yin/diao meet WCAG AA large-text (≥3.0) against the real legacy #666 rule", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await routeStylesCss(page, readWorkingTreeStylesCss);
    await blockCssSubresources(page);
    const response = await page.goto(ENTRY_PATH);
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "dictionary");

    const yin = page
      .locator(".result .entry .title hruby.rightangle ru[zhuyin] zhuyin yin")
      .first();
    const diao = page
      .locator(".result .entry .title hruby.rightangle ru[zhuyin] zhuyin diao")
      .first();
    await expect(yin).toHaveCount(1);
    await expect(diao).toHaveCount(1);

    const { fg: yinFg, bg: yinBg } = await locatorContrast(yin);
    const { fg: diaoFg, bg: diaoBg } = await locatorContrast(diao);
    // Exact expected value: --moe-zhuyin-secondary (#aaa), replacing legacy #666.
    expect(yinFg).toBe("rgb(170, 170, 170)");
    expect(diaoFg).toBe("rgb(170, 170, 170)");
    expect(contrastRatio(yinFg, yinBg)).toBeGreaterThanOrEqual(3.0);
    expect(contrastRatio(diaoFg, diaoBg)).toBeGreaterThanOrEqual(3.0);
  });

  test("light mode: yin/diao keep the original #666 (fix does not alter light mode)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await routeStylesCss(page, readWorkingTreeStylesCss);
    await blockCssSubresources(page);
    const response = await page.goto(ENTRY_PATH);
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "dictionary");

    const yin = page
      .locator(".result .entry .title hruby.rightangle ru[zhuyin] zhuyin yin")
      .first();
    const color = await yin.evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(102, 102, 102)");
  });
});

test.describe("audit-dark-contrast B: Hakka .bopomofo reading spans/sup (was #666 on #1c1c1c, 2.97:1)", () => {
  test("dark mode: reading span and tone sup meet WCAG AA against the real legacy #666 rule", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await routeStylesCss(page, readWorkingTreeStylesCss);
    await blockCssSubresources(page);
    const response = await page.goto(HAKKA_PATH);
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "dictionary");

    const readingSpans = page.locator("div.bopomofo span.pinyin > span > span:not(.audioBlock)");
    await expect(readingSpans.first()).toHaveCount(1);
    const { fg, bg } = await locatorContrast(readingSpans.first());
    // Exact expected value: --moe-text-secondary (#aaa), replacing legacy #666.
    expect(fg).toBe("rgb(170, 170, 170)");
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);

    const sup = readingSpans.first().locator("sup").first();
    await expect(sup).toHaveCount(1);
    const { fg: supFg, bg: supBg } = await locatorContrast(sup);
    expect(supFg).toBe("rgb(170, 170, 170)");
    expect(contrastRatio(supFg, supBg)).toBeGreaterThanOrEqual(4.5);
  });

  test("light mode: reading span keeps the original #666 (fix does not alter light mode)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await routeStylesCss(page, readWorkingTreeStylesCss);
    await blockCssSubresources(page);
    const response = await page.goto(HAKKA_PATH);
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "dictionary");

    const readingSpans = page.locator("div.bopomofo span.pinyin > span > span:not(.audioBlock)");
    const color = await readingSpans.first().evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(102, 102, 102)");
  });
});

test.describe("audit-dark-contrast C: #user-pref close button (was white on Bootstrap #428bca, 3.63:1, both themes)", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`${theme} mode: .btn-primary.btn-close meets WCAG AA against the real legacy Bootstrap rule`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await routeStylesCss(page, readWorkingTreeStylesCss);
      await blockCssSubresources(page);
      const response = await page.goto(ENTRY_PATH);
      expect(response?.status()).toBe(200);
      await waitForAppReady(page, "dictionary");
      await openPrefPanel(page);

      const btn = page.locator("#user-pref .btn.btn-primary.btn-block");
      await expect(btn).toHaveCount(1);
      const style = await btn.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { color: cs.color, background: cs.backgroundColor };
      });
      expect(style.color).toBe("rgb(255, 255, 255)");
      // Exact expected value: scoped #2f6da3, replacing Bootstrap's #428bca.
      expect(style.background).toBe("rgb(47, 109, 163)");
      expect(contrastRatio(style.color, style.background)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

test.describe("audit-dark-contrast D: .radical .glyph a.xref hover (was white on #ddd, 1.36:1, both themes)", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`${theme} mode: hover/focus keeps white text on the themed red badge, not the legacy #ddd`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await routeStylesCss(page, readWorkingTreeStylesCss);
      await blockCssSubresources(page);
      const response = await page.goto(ENTRY_PATH);
      expect(response?.status()).toBe(200);
      await waitForAppReady(page, "dictionary");

      const link = page.locator(".radical .glyph a.xref").first();
      await expect(link).toHaveCount(1);
      await link.hover();
      const style = await link.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { color: cs.color, background: cs.backgroundColor };
      });
      expect(style.color).toBe("rgb(255, 255, 255)");
      expect(style.background).toBe("rgb(107, 0, 0)");
      expect(contrastRatio(style.color, style.background)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

test.describe("audit-dark-contrast E: div.cn-specific xref label (was --moe-text on hardcoded #eef, 1.12:1 dark-only)", () => {
  test("dark mode: second xref label meets WCAG AA against the themed background", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await routeStylesCss(page, readWorkingTreeStylesCss);
    await blockCssSubresources(page);
    await routeCnSpecificAlt(page);
    const response = await page.goto(CN_XREF_PATH);
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "dictionary");

    const label = page.locator("div.cn-specific span.xref").nth(1);
    await expect(label).toHaveCount(1);
    const { fg, bg } = await locatorContrast(label);
    // Exact expected value: --moe-example-bg (#252525), replacing hardcoded #eef.
    expect(bg).toBe("rgb(37, 37, 37)");
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test("light mode: cn-specific keeps the original #eef background (fix does not alter light mode)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await routeStylesCss(page, readWorkingTreeStylesCss);
    await blockCssSubresources(page);
    await routeCnSpecificAlt(page);
    const response = await page.goto(CN_XREF_PATH);
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "dictionary");

    const cn = page.locator("div.cn-specific").first();
    const bg = await cn.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgb(238, 238, 255)");
  });
});

test.describe("audit-dark-contrast J: .result a:hover/:focus (was #0070a3 on #ddd, 4.02:1, both themes)", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`${theme} mode: hover/focus text meets WCAG AA against the real legacy #ddd hover background`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await routeStylesCss(page, readWorkingTreeStylesCss);
      await blockCssSubresources(page);
      const response = await page.goto("/@%E5%8F%A3"); // radical detail page — has .result p > a.xref
      expect(response?.status()).toBe(200);
      await waitForAppReady(page, "static");

      const link = page.locator(".result p > a.xref").first();
      await expect(link).toHaveCount(1);
      await link.hover();
      const style = await link.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { color: cs.color, background: cs.backgroundColor };
      });
      // Exact expected value: scoped #005f8c, replacing legacy #0070a3.
      expect(style.color).toBe("rgb(0, 95, 140)");
      expect(style.background).toBe("rgb(221, 221, 221)");
      expect(contrastRatio(style.color, style.background)).toBeGreaterThanOrEqual(4.5);

      // Badges keep their own higher-specificity rules — unaffected by this change.
      const badge = page.locator(".part-of-speech, .specific").first();
      if (await badge.count()) {
        const badgeBg = await badge.evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(badgeBg).toBe("rgb(107, 0, 0)");
      }
    });
  }
});

test.describe("audit-dark-contrast K: StarredPage .lang-group-current (was undefined --moe-text-muted → #767676, 3.75:1 dark)", () => {
  test("dark mode: current-language label meets WCAG AA", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(() => {
      window.localStorage.setItem("starred-a", '"萌"\n');
    });
    const response = await page.goto("/=*");
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "starred");

    await page.locator("#btn-toggle-all-langs").click();
    const current = page.locator(".lang-group-current").first();
    await expect(current).toBeVisible({ timeout: 5_000 });
    const { fg, bg } = await locatorContrast(current);
    // Exact expected value: --moe-text-secondary (#aaa), replacing the
    // never-defined --moe-text-muted (which always fell back to #767676).
    expect(fg).toBe("rgb(170, 170, 170)");
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test("light mode: current-language label keeps the original #767676 (fix does not alter light mode)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => {
      window.localStorage.setItem("starred-a", '"萌"\n');
    });
    const response = await page.goto("/=*");
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "starred");

    await page.locator("#btn-toggle-all-langs").click();
    const current = page.locator(".lang-group-current").first();
    await expect(current).toBeVisible({ timeout: 5_000 });
    const color = await current.evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(118, 118, 118)");
  });
});

test.describe("About JSON sample code contrast with real legacy CSS", () => {
  for (const [theme, expectedColor] of [
    ["dark", "rgb(230, 227, 223)"], // --moe-text: #e6e3df
    ["light", "rgb(51, 51, 51)"], // original #333
  ] as const) {
    test(`${theme} mode: JSON code uses the expected text color`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await routeStylesCss(page, readWorkingTreeStylesCss);
      await blockCssSubresources(page);
      const response = await page.goto("/about");
      expect(response?.status()).toBe(200);
      await waitForAppReady(page, "about");

      const code = page.locator(".about-page pre.api-code code");
      await expect(code).toHaveCount(1);
      const color = await code.evaluate((el) => getComputedStyle(el).color);
      expect(color).toBe(expectedColor);
    });
  }
});
