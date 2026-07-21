import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Route } from "@playwright/test";
import { expect, test } from "./_fixtures";
import { waitForAppReady } from "./readiness";

// Adversarial visual-regression guard suite (parity-sweep-2 ranked spec,
// R4-R12). R1 (charimg-caption-dark-contrast.spec.ts) and R2
// (navbar-dropdown-list-style.spec.ts) already have dedicated guard files —
// verified present, not duplicated here. R3(a) (the dual styles.css
// load on /about) is documented longstanding architecture, not a
// regression — see readiness.ts's "about" kind and AGENTS.md; only R3(b)
// (graceful degradation when styles.css is blocked entirely) is covered
// below.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const STYLES_CSS_PATH = path.join(REPO_ROOT, "data", "assets", "styles.css");

function readWorkingTreeStylesCss(): string {
  return readFileSync(STYLES_CSS_PATH, "utf-8");
}

// Same interception pair as tests/e2e/legacy-styles-regression.spec.ts:31-80
// (kept local per that file's own convention — see dark-mode.spec.ts's
// identical local copy — rather than exporting, to avoid coupling two
// independent spec files' internals). Registered AFTER _fixtures.ts's
// blanket r2-*.test.local blocker so Playwright's most-recently-registered-
// route-wins order lets this intercept win for styles.css specifically.
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

async function blockStylesCssEntirely(page: Page): Promise<void> {
  const abort = (route: Route) => route.abort("failed");
  await page.route("https://r2-assets.test.local/styles.css", abort);
  await page.route("https://r2-assets.test.local/styles.css?*", abort);
  await page.route("**/assets/styles.css", abort);
  await page.route("**/assets/styles.css?*", abort);
}

// Fixture-seeded canonical words (tests/helpers/fixtures.ts CANONICAL_WORDS)
// — the ticket's illustrative /:客 does not exist in the seeded R2 fixture
// (only 字 is seeded for lang h), so every route below uses the real
// fixture set to stay green under both this harness and CI.
const ENTRY_ROUTES: Array<{ lang: "a" | "t" | "h" | "c"; path: string; word: string }> = [
  { lang: "a", path: "/%E8%90%8C", word: "萌" },
  { lang: "t", path: "/'%E9%A3%9F", word: "食" },
  { lang: "h", path: "/%3A%E5%AD%97", word: "字" },
  { lang: "c", path: "/~%E4%B8%8A%E8%A8%B4", word: "上訴" },
];

// ---------------------------------------------------------------------------
// R3(b): legacy styles.css blocked entirely — app must still render, never a
// blank body. The dual-load architecture itself (AssetLoader's absolute R2
// path + About.tsx's own relative path) is documented longstanding design
// (AGENTS.md, readiness.ts's "about" kind comment) — not asserted here.
// ---------------------------------------------------------------------------
test.describe("R3(b): graceful degradation when legacy styles.css is blocked", () => {
  test("entry page still renders .result content (not blank) with styles.css blocked", async ({
    page,
  }) => {
    await blockStylesCssEntirely(page);
    await page.goto("/%E8%90%8C");
    await waitForAppReady(page, "dictionary");
    const result = page.locator(".result");
    await expect(result).toBeVisible();
    const text = await result.innerText();
    expect(text.trim().length).toBeGreaterThan(0);
  });

  test("home page still renders a non-empty body with styles.css blocked", async ({ page }) => {
    await blockStylesCssEntirely(page);
    await page.goto("/");
    await waitForAppReady(page, "dictionary");
    const bodyText = await page.locator("body").innerText();
    expect(bodyText.trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// R4: percent-encoded route edge cases.
// ---------------------------------------------------------------------------
test.describe("R4: percent-encoded route edge cases", () => {
  // Pre-existing (predates #152 — main.tsx's fixInitialURL dates to 05ff1a1,
  // 2025-11-21) cascading over-decode bug: main.tsx's fixInitialURL (runs
  // before React mounts) AND its setupHistoryInterceptor both independently
  // call decodeURIComponent() and replaceState whenever the path still
  // contains "%", and App.tsx's URLDecoder component re-runs the same check
  // on every route change. classifyRoute() itself only ever decodes once,
  // but by the time it sees the URL, these three uncoordinated decode
  // passes have already cascaded /%2520 -> /%20 -> "/ " (a literal space)
  // -> home (empty word), losing the intended single-decoded "%20" word
  // entirely. Verified live via xd://browser against this harness's fixture
  // server: the final render is the home "找不到：" / "未提供字詞" empty
  // state, not a literal-"%20" .result title. Not a #152 regression (the
  // decode loops are far older); flagged here as a genuine spec violation
  // rather than silently asserting the buggy outcome.
  test.fixme("/%2520 renders .result with a literal %20 title (single decode)", async ({
    page,
  }) => {
    const response = await page.goto("/%2520");
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "dictionary");
    const title = page.locator("h1.title, .result .title").first();
    await expect(title).toBeVisible();
    await expect(title).toContainText("%20");
  });

  test("/%E0%A4%A (malformed truncated escape) renders home gracefully, never a blank body", async ({
    page,
  }) => {
    const response = await page.goto("/%E0%A4%A");
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "dictionary");
    const result = page.locator(".result");
    await expect(result).toBeVisible();
    const text = await result.innerText();
    expect(text.trim().length).toBeGreaterThan(0);
  });

  test("/foo%27bar (literal apostrophe inside a word) renders as a lang-a entry route", async ({
    page,
  }) => {
    const response = await page.goto("/foo%27bar");
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "dictionary");
    await expect(page.locator(".result")).toBeVisible();
    expect(await page.evaluate(() => document.body.className)).toContain("lang-a");
  });
});

// ---------------------------------------------------------------------------
// R5: z-index precedence across simultaneously-open overlays.
// ---------------------------------------------------------------------------
test.describe("R5: z-index precedence — dropdown / user-pref / radical tooltip / star", () => {
  test("ui-tooltip beats user-pref beats dropdown beats navbar; .star stays position:static", async ({
    page,
  }) => {
    await page.goto("/%E8%90%8C");
    await waitForAppReady(page, "dictionary");
    await page.locator(".entry-actions .star").waitFor({ state: "visible" });
    await page.locator(".radical .glyph a.xref").waitFor({ state: "visible" });

    // Open the dictionary-picker dropdown.
    await page.locator("nav .navbar-nav > li").first().locator("a").first().click();
    await page.locator("nav ul[role=navigation]").waitFor({ state: "visible" });

    // Open #user-pref on top of it.
    await page.locator("#btn-pref > a").click();
    await page.locator("#user-pref").waitFor({ state: "visible" });

    // Trigger the radical .ui-tooltip via real hover.
    await page.locator(".radical .glyph a.xref").hover();
    await page.locator(".ui-tooltip").waitFor({ state: "visible", timeout: 5_000 });

    const precedence = await page.evaluate(() => {
      function overlapCenter(a: Element | null, b: Element | null) {
        if (!a || !b) return null;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const left = Math.max(ra.left, rb.left);
        const right = Math.min(ra.right, rb.right);
        const top = Math.max(ra.top, rb.top);
        const bottom = Math.min(ra.bottom, rb.bottom);
        if (left >= right || top >= bottom) return null;
        return { x: (left + right) / 2, y: (top + bottom) / 2 };
      }
      const dropdown = document.querySelector("nav ul[role=navigation]");
      const pref = document.getElementById("user-pref");
      const tooltip = document.querySelector(".ui-tooltip");
      const nav = document.querySelector("nav.navbar");
      const star = document.querySelector(".entry-actions .star");

      const dpCenter = overlapCenter(dropdown, pref);
      const dtCenter = overlapCenter(dropdown, tooltip);
      const ptCenter = overlapCenter(pref, tooltip);
      const stCenter = overlapCenter(star, tooltip);

      const topElAt = (c: { x: number; y: number } | null) => {
        if (!c) return null;
        const el = document.elementFromPoint(c.x, c.y);
        return el;
      };

      const dpTop = topElAt(dpCenter);
      const dtTop = topElAt(dtCenter);
      const ptTop = topElAt(ptCenter);
      const stTop = topElAt(stCenter);

      return {
        dpOverlaps: dpCenter != null,
        dpWinnerIsPref: dpTop != null && pref != null && pref.contains(dpTop),
        dtOverlaps: dtCenter != null,
        dtWinnerIsTooltip: dtTop != null && tooltip != null && tooltip.contains(dtTop),
        ptOverlaps: ptCenter != null,
        ptWinnerIsTooltip: ptTop != null && tooltip != null && tooltip.contains(ptTop),
        stOverlaps: stCenter != null,
        stWinnerIsTooltip: stTop != null && tooltip != null && tooltip.contains(stTop),
        tooltipZ: tooltip ? Number(getComputedStyle(tooltip).zIndex) : null,
        prefZ: pref ? Number(getComputedStyle(pref).zIndex) : null,
        dropdownZ: dropdown ? Number(getComputedStyle(dropdown).zIndex) : null,
        navZ: nav ? Number(getComputedStyle(nav).zIndex) : null,
        dropdownIsNavChild: !!(nav && dropdown && nav.contains(dropdown)),
        starPosition: star ? getComputedStyle(star).position : null,
      };
    });

    // Computed z-index contract: tooltip(9999) > user-pref(1050) >
    // navbar-context(1030, dropdown child capped at 1000).
    expect(precedence.tooltipZ).toBe(9999);
    expect(precedence.prefZ).toBe(1050);
    expect(precedence.navZ).toBe(1030);
    expect(precedence.dropdownZ).toBe(1000);
    expect(precedence.dropdownIsNavChild).toBe(true);
    expect(precedence.tooltipZ).toBeGreaterThan(precedence.prefZ ?? 0);
    expect(precedence.prefZ).toBeGreaterThan(precedence.navZ ?? 0);
    expect(precedence.navZ).toBeGreaterThan(precedence.dropdownZ ?? 0);

    // Runtime pairwise elementFromPoint precedence, wherever the overlays
    // actually overlap on screen (order-independent of the static z-index
    // contract above — this is the deterministic geometry oracle).
    if (precedence.dpOverlaps) expect(precedence.dpWinnerIsPref).toBe(true);
    if (precedence.dtOverlaps) expect(precedence.dtWinnerIsTooltip).toBe(true);
    if (precedence.ptOverlaps) expect(precedence.ptWinnerIsTooltip).toBe(true);
    if (precedence.stOverlaps) expect(precedence.stWinnerIsTooltip).toBe(true);

    // .star never re-enters absolute/fixed positioning that would compete
    // for a separate stacking context (src/index.css:737-741).
    expect(precedence.starPosition).toBe("static");
  });
});

// ---------------------------------------------------------------------------
// R6: ruby/rt title geometry across 4 entries x 4 phonetic prefs x 2 widths.
// ---------------------------------------------------------------------------
const PHONETICS_PREFS = ["rightangle", "bopomofo", "pinyin", "none"] as const;

test.describe("R6: ruby geometry — zero native <rt>, absolute overlay, bounded height ratio", () => {
  for (const viewportWidth of [1280, 390]) {
    for (const entry of ENTRY_ROUTES) {
      test(`${entry.lang} @ ${viewportWidth}px: no native <rt>, overlay is absolute, height ratio < 2.35 across all phonetics prefs`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: viewportWidth, height: 900 });
        // Ratio bound is calibrated against two measured real-cascade
        // baselines, not an arbitrary threshold. Without routing
        // styles.css, .result/h1.title are unstyled (legacy data/assets/
        // styles.css is 404'd by _fixtures.ts's blanket blocker per
        // AGENTS.md's default e2e contract) and the ratio is meaningless
        // (2.7-2.8) — so route the real stylesheet below in all cases.
        //
        // The remaining ratio spread is real, prod-anchored geometry, not
        // harness noise: which condition applies depends on whether the
        // OS has the local 'Biaodian Pro Serif CNS' font installed —
        // Biaodian's only url() source is a PUA-range revised-dict.woff
        // that never covers normal CJK, and we cannot ship Biaodian
        // ourselves (not in repo, licensing), so Linux/Windows users (and
        // this CI runner) always fall back to the next family in the
        // stack. Verified staging==prod byte-identical under BOTH
        // conditions:
        //   - mac/local Biaodian present (worst case 1.417/1.417/1.0/1.438
        //     for a/t/h/c): ratio <= 1.44.
        //   - fallback font, CI == every Linux/Windows user == prod-equal
        //     (worst case a=2.028, c=2.114): ratio <= 2.114.
        // 2.35 comfortably covers both real conditions with headroom while
        // still catching the historical g0v/moedict-webkit#186 regression
        // this guards (164px/~60px ~= 2.7, well above 2.35).
        //
        // Unlike R8, this doesn't call blockCssSubresources() — that only
        // 404s background images and non-title fonts, neither of which
        // affects the h1.title/ruby glyph metrics measured here.
        await routeStylesCss(page, readWorkingTreeStylesCss);

        const heights: number[] = [];
        for (const pref of PHONETICS_PREFS) {
          await page.goto(entry.path);
          await waitForAppReady(page, "dictionary-lang");
          await page.evaluate((p) => window.localStorage.setItem("phonetics", p), pref);
          await page.goto(entry.path);
          await waitForAppReady(page, "dictionary-lang");
          await page.locator("h1.title").first().waitFor({ state: "visible", timeout: 15_000 });

          const metrics = await page.evaluate(() => {
            const titles = Array.from(document.querySelectorAll("h1.title"));
            const rtCount = titles.reduce((sum, t) => sum + t.querySelectorAll("rt").length, 0);
            const selectables = titles.flatMap((t) =>
              Array.from(t.querySelectorAll<HTMLElement>(".romanization-selectable")),
            );
            const positions = selectables.map((el) => getComputedStyle(el).position);
            const height = Math.max(...titles.map((t) => t.getBoundingClientRect().height));
            return { rtCount, positions, height };
          });

          expect(metrics.rtCount).toBe(0);
          for (const position of metrics.positions) {
            expect(position).toBe("absolute");
          }
          heights.push(metrics.height);
        }

        const maxHeight = Math.max(...heights);
        const minHeight = Math.min(...heights);
        expect(maxHeight / minHeight).toBeLessThan(2.35);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// R7: font-fallback degradation.
// ---------------------------------------------------------------------------
test.describe("R7: font fallback — navbar-brand stays visible when title fonts fail to load", () => {
  test("blocking EBAS/MOEDICT/FiraSansOT still renders a visible non-empty navbar-brand", async ({
    page,
  }) => {
    await page.route(/\/fonts\/EBAS/, (route) => route.abort("failed"));
    await page.route(/\/fonts\/MOEDICT\./, (route) => route.abort("failed"));
    await page.route(/\/fonts\/FiraSansOT/, (route) => route.abort("failed"));

    await page.goto("/%E8%90%8C");
    await waitForAppReady(page, "dictionary");
    await page.evaluate(() => document.fonts.ready);

    const brand = page.locator(".navbar-brand").first();
    await expect(brand).toBeVisible();
    const box = await brand.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
    const text = await brand.innerText();
    expect(text.trim().length).toBeGreaterThan(0);

    // h1.title must not combine a fixed width/height with overflow:hidden —
    // that combination would clip a fallback-font glyph run instead of
    // letting the box grow/shrink with the substituted metrics.
    const titleOverflowRisk = await page.evaluate(() => {
      const title = document.querySelector("h1.title");
      if (!title) return null;
      const cs = getComputedStyle(title);
      const hasFixedWidth = cs.width !== "auto" && !cs.width.includes("%");
      const hasFixedHeight = cs.height !== "auto" && !cs.height.includes("%");
      return { hasFixedWidthAndHeight: hasFixedWidth && hasFixedHeight, overflow: cs.overflow };
    });
    if (titleOverflowRisk) {
      expect(
        titleOverflowRisk.hasFixedWidthAndHeight && titleOverflowRisk.overflow === "hidden",
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// R8: narrow-width stress (390 and 320) on the taigi entry (multi-heteronym,
// longest status string).
// ---------------------------------------------------------------------------
test.describe("R8: narrow-width stress — entry-copy-status reserved box + no document overflow", () => {
  for (const width of [390, 320]) {
    test(`${width}px: .entry-copy-status count 1, reserved min-width/min-height, no horizontal overflow`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      // The overlay-clipping `.result { overflow-x: hidden }` rule that
      // production relies on lives only in legacy data/assets/styles.css
      // (404'd by _fixtures.ts's blanket blocker per AGENTS.md's default
      // e2e contract) — the document-overflow oracle is only meaningful
      // with the real cascade loaded, so intercept it here.
      await blockCssSubresources(page);
      await routeStylesCss(page, readWorkingTreeStylesCss);

      await page.goto("/'%E9%A3%9F");
      await waitForAppReady(page, "dictionary-lang");

      const status = page.locator(".entry-copy-status");
      await expect(status).toHaveCount(1);
      const dims = await status.evaluate((el) => {
        const cs = getComputedStyle(el);
        const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
        return { minWidth: parseFloat(cs.minWidth), minHeight: parseFloat(cs.minHeight), rootPx };
      });
      // src/index.css .entry-copy-status: min-width: 8rem, min-height: 1.5rem
      // — resolved against the ROOT font-size at measurement time, which the
      // legacy stylesheet loaded above overrides to 62.5% (10px root, not
      // the browser-default 16px), so the expected px values are computed
      // from the live root font-size rather than hardcoded.
      expect(dims.minWidth).toBeGreaterThanOrEqual(8 * dims.rootPx);
      expect(dims.minHeight).toBeGreaterThanOrEqual(1.5 * dims.rootPx);

      const overflowBefore = await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      );
      expect(overflowBefore).toBe(true);

      // Icon-rect stability across the status-text change is already
      // covered by dictionary.spec.ts:1929-1965 (boxesBefore/During/After
      // toEqual across a real copy click) — not duplicated here. Only the
      // reserved-box geometry and document-overflow invariants are new.
      const copyButton = page.locator(".entry-copy-button");
      if ((await copyButton.count()) > 0) {
        // Deny clipboard permission (cheap, deterministic) to reach the
        // longest status string ("複製失敗，請手動選取文字") via a real click.
        await page.context().clearPermissions();
        await page.addInitScript(() => {
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText: () => Promise.reject(new Error("denied")) },
          });
          document.execCommand = () => false;
        });
        await page.goto("/'%E9%A3%9F");
        await waitForAppReady(page, "dictionary-lang");
        await page.getByRole("button", { name: "複製解釋" }).click();
        await expect(page.locator(".entry-copy-status")).toHaveText("複製失敗，請手動選取文字");

        const overflowAfter = await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        );
        expect(overflowAfter).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// R9: focus rings via real keyboard Tab (never .focus() — it does not
// trigger :focus-visible and produces false-negative readings).
// ---------------------------------------------------------------------------
test.describe("R9: focus rings on entry-actions controls — real keyboard Tab only", () => {
  test("Tab-walking to .entry-copy-button/.variants-link/.star yields a visible 2px solid outline", async ({
    page,
  }) => {
    await page.goto("/%E8%90%8C");
    await waitForAppReady(page, "dictionary");
    await page.locator(".entry-actions .star").waitFor({ state: "visible" });

    const targets = [".entry-copy-button", "a.variants-link", ".star"];
    for (const selector of targets) {
      const target = page.locator(selector).first();
      if ((await target.count()) === 0) continue;

      // Real keyboard Tab walk from a known start (document body) until
      // document.activeElement matches the target — never element.focus().
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      let matched = false;
      for (let i = 0; i < 40 && !matched; i++) {
        await page.keyboard.press("Tab");
        matched = await target.evaluate((el) => el === document.activeElement);
      }
      expect(matched).toBe(true);

      const outline = await target.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth };
      });
      expect(outline.outlineStyle).toBe("solid");
      expect(outline.outlineWidth).toBe("2px");
    }
  });
});

// ---------------------------------------------------------------------------
// R10: radical cross-reference hover contrast in dark mode (regression guard
// — already fixed in #152, see index.css:625-636 "#322/audit-dark-contrast D").
// ---------------------------------------------------------------------------
test.describe("R10: xref hover dark contrast", () => {
  test("hovering .radical .glyph a.xref in dark mode keeps brand-red bg + white text", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/%E8%90%8C");
    await waitForAppReady(page, "dictionary");
    const xref = page.locator(".radical .glyph a.xref").first();
    await expect(xref).toBeVisible();
    await xref.hover();
    const colors = await xref.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { background: cs.backgroundColor, color: cs.color };
    });
    expect(colors.background).toBe("rgb(107, 0, 0)");
    expect(colors.color).toBe("rgb(255, 255, 255)");
  });
});

// ---------------------------------------------------------------------------
// R11: query-box dark-mode background (regression guard — already hardened
// via a higher-specificity override chain, see index.css:457-474).
// ---------------------------------------------------------------------------
test.describe("R11: query-box dark background", () => {
  test("dark mode: .query-box background is not the raw light hsl(0,0%,97%) value", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/%E8%90%8C");
    await waitForAppReady(page, "dictionary");
    const queryBox = page.locator(".query-box").first();
    await expect(queryBox).toBeVisible();
    const background = await queryBox.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(background).not.toBe("rgb(247, 247, 247)");
    // Per-language dark tint: --moe-query-a #241616 = rgb(36, 22, 22) (lang
    // a is the default/no-prefix route used above); the other three langs'
    // tints follow the same html body.lang-X #query-box override chain.
    expect(background).toBe("rgb(36, 22, 22)");
  });
});

// ---------------------------------------------------------------------------
// R12: spinner reduced-motion — pre-existing (pre-#152) gap, not fixed here.
// ---------------------------------------------------------------------------
test.describe("R12: stroke-loader spinner respects prefers-reduced-motion", () => {
  // Pre-existing gap (predates #152 entirely — introduced by an older
  // commit converting the stroke loader spinner from a webfont icon to an
  // inline SVG; confirmed via `git log -S moe-stroke-loader-spin`). The
  // `@keyframes moe-stroke-loader-spin` animation at src/index.css has no
  // `@media (prefers-reduced-motion: reduce)` guard anywhere in scope,
  // unlike the #152-introduced `.entry-actions button:active` transform
  // (correctly guarded at src/index.css ~919-926 for contrast). Intentionally
  // NOT fixed in this PR — flagged as a follow-up a11y hardening item.
  test.fixme("stroke-loader spinner animation is paused/instant under prefers-reduced-motion", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/%E8%90%8C");
    await waitForAppReady(page, "dictionary");
    await page.locator(".single-char-stroke-trigger, a.iconic-circle.stroke").first().click();
    const spinner = page.locator("#strokes .loader .moe-stroke-loader-spinner");
    await spinner.waitFor({ state: "visible", timeout: 5_000 });
    const style = await spinner.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { animationDuration: cs.animationDuration, animationPlayState: cs.animationPlayState };
    });
    expect(style.animationDuration === "0s" || style.animationPlayState === "paused").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R13: .romanization-selectable is universally position:absolute (and
// display:none under zhuyin/none prefs) at EVERY rightAngle() mount point —
// title, examples — not just the entry title. Regression: example sentences
// (.entry-item .example, via parseTaiwaneseRubyLine → rightAngle) had no
// matching CSS rule at all, so the span stayed in-flow (position: static),
// ballooning .example/ru box widths, and stayed visible+selectable even
// when the user's phonetics preference hid all other romanization.
// ---------------------------------------------------------------------------
test.describe("R13: romanization-selectable universal position/pref invariant (title + examples)", () => {
  // 一 (U+4E00, ptck bucket 0) has two heteronyms (tsi̍t/it) with multiple
  // examples each — real multi-heteronym, multi-example fixture.
  const MULTI_EXAMPLE_PATH = "/'%E4%B8%80";

  test("rightangle/pinyin: every .romanization-selectable on the page is position:absolute", async ({
    page,
  }) => {
    await routeStylesCss(page, readWorkingTreeStylesCss);
    for (const pref of ["rightangle", "pinyin"] as const) {
      await page.goto(MULTI_EXAMPLE_PATH);
      await waitForAppReady(page, "dictionary-lang");
      await page.evaluate((p) => window.localStorage.setItem("phonetics", p), pref);
      await page.goto(MULTI_EXAMPLE_PATH);
      await waitForAppReady(page, "dictionary-lang");
      await page
        .locator(".entry-item .example hruby.rightangle ru[annotation]")
        .first()
        .waitFor({ state: "visible", timeout: 15_000 });

      const result = await page.evaluate(() => {
        const selectables = Array.from(
          document.querySelectorAll<HTMLElement>(
            "hruby.rightangle ru[annotation] > .romanization-selectable",
          ),
        );
        return {
          count: selectables.length,
          positions: selectables.map((el) => getComputedStyle(el).position),
        };
      });
      // At least one from the title and several from the multi-heteronym
      // multi-example page — confirms the selector actually matches
      // real mount points, not vacuously passing on an empty list.
      expect(result.count).toBeGreaterThan(5);
      for (const position of result.positions) {
        expect(position).toBe("absolute");
      }
    }
  });

  test("bopomofo/none: every .romanization-selectable on the page is display:none", async ({
    page,
  }) => {
    await routeStylesCss(page, readWorkingTreeStylesCss);
    // "zhuyin" is data-ruby-pref's value, not a valid localStorage
    // "phonetics" key -- the app's PrefList options are
    // rightangle/bopomofo/pinyin/none (applyPhoneticsBodyAttr maps
    // bopomofo -> data-ruby-pref="zhuyin"). Reuses R6's PHONETICS_PREFS
    // naming for the same reason.
    for (const pref of ["bopomofo", "none"] as const) {
      await page.goto(MULTI_EXAMPLE_PATH);
      await waitForAppReady(page, "dictionary-lang");
      await page.evaluate((p) => window.localStorage.setItem("phonetics", p), pref);
      await page.goto(MULTI_EXAMPLE_PATH);
      await waitForAppReady(page, "dictionary-lang");
      await page
        .locator(".entry-item .example hruby.rightangle ru[annotation]")
        .first()
        .waitFor({ state: "visible", timeout: 15_000 });

      const result = await page.evaluate(() => {
        const selectables = Array.from(
          document.querySelectorAll<HTMLElement>(
            "hruby.rightangle ru[annotation] > .romanization-selectable",
          ),
        );
        return {
          count: selectables.length,
          displays: selectables.map((el) => getComputedStyle(el).display),
        };
      });
      expect(result.count).toBeGreaterThan(5);
      for (const display of result.displays) {
        expect(display).toBe("none");
      }
    }
  });

  test("example sentence box width collapses to the character-only width, not the full romanization text width", async ({
    page,
  }) => {
    await routeStylesCss(page, readWorkingTreeStylesCss);
    await page.goto(MULTI_EXAMPLE_PATH);
    await waitForAppReady(page, "dictionary-lang");

    const ruWidth = await page
      .locator(".entry-item .example hruby.rightangle ru[annotation]")
      .first()
      .evaluate((el) => el.getBoundingClientRect().width);
    // Regression measured 188.9px (in-flow, inflated by "tsi̍t" romanization
    // text) pre-fix vs 53.5px post-fix (character-only, matching prod's
    // native-<rt> rendering exactly). Bound generously above the
    // character-only width but well below the inflated regression.
    expect(ruWidth).toBeLessThan(120);
  });
});
