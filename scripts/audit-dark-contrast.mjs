#!/usr/bin/env node
/**
 * scripts/audit-dark-contrast.mjs
 *
 * Systematic dark/light-mode WCAG contrast audit for moedict.tw. Crawls a
 * fixed route list at desktop + mobile viewports, in explicit light and dark
 * theme, drives the interactive states that reveal state-dependent contrast
 * bugs (mobile search dropdown, full-text search, #user-pref panel, radical
 * hover tooltip, stroke-animation toggle, StarredPage 顯示全部語言／匯入
 * panels), and reports every distinct low-contrast finding as deduped JSON.
 *
 * Each interactive state is captured on its OWN fresh page load (fresh
 * navigation to the base route, theme re-applied) rather than chained onto
 * the previous action's page — chaining would let e.g. an un-dismissed
 * #user-pref overlay intercept a later hover, or #query's live-navigate-as-
 * you-type behavior silently carry every later state onto a different
 * route. Isolating states trades some navigations for correctness: every
 * snapshot reflects exactly the state its label claims.
 *
 * This is a read-only auditor: it navigates and inspects a running dev/
 * preview server, never modifies application source. Point it at any
 * BASE_URL (default http://127.0.0.1:5173) via env var:
 *
 *   BASE_URL=http://127.0.0.1:5277 node scripts/audit-dark-contrast.mjs
 *
 * Output: full findings + action-failure log written to
 * /tmp/contrast-audit.json, plus a console summary grouped by severity.
 */

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:5173";
const OUTPUT_PATH = process.env.CONTRAST_AUDIT_OUTPUT || "/tmp/contrast-audit.json";

// AGENTS.md 語言代碼: a=# (/), t=#' (/'), h=#: (/:), c=#~ (/~)
const ROUTES = ["/萌", "/生", "/'食", "/'長褲", "/:客", "/~東西", "/=*", "/@", "/@口", "/about"];

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];

const THEMES = ["light", "dark"];

// WCAG 2.x contrast thresholds. "Large text" = >=24px, or >=18.66px (14pt)
// and bold (per the spec's 18.66px/14pt bold large-text carve-out).
const NORMAL_RATIO = 4.5;
const LARGE_RATIO = 3.0;
const LARGE_TEXT_PX = 24;
const LARGE_BOLD_TEXT_PX = 18.66;
const LARGE_BOLD_WEIGHT = 700;

// ---------------------------------------------------------------------------
// In-page evaluation: enumerate text-bearing leaves + effective fg/bg
// ---------------------------------------------------------------------------

/**
 * Runs inside the page. Walks every element, keeps those that directly own
 * visible, non-whitespace text (i.e. a text-node child, not merely text
 * inherited from descendants), excludes decorative/hidden/disabled/
 * transparent-text elements, and computes the effective background by
 * walking ancestors until a non-transparent `background-color` is found (or
 * `background-image !== 'none'` short-circuits as `unknown-bg`).
 */
function collectFindingsInPage({
  normalRatio,
  largeRatio,
  largeTextPx,
  largeBoldTextPx,
  largeBoldWeight,
}) {
  function isVisible(el) {
    const rects = el.getClientRects();
    if (rects.length === 0) return false;
    let hasArea = false;
    for (const r of rects) {
      // Excludes the standard `.sr-only` visually-hidden pattern (1x1px,
      // clipped via `clip`/`overflow:hidden`, positioned off-screen via
      // negative margin) — deliberately non-visual, not a contrast bug.
      if (r.width > 1 && r.height > 1) {
        hasArea = true;
        break;
      }
    }
    if (!hasArea) return false;
    const style = getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    ) {
      return false;
    }
    if (Number(style.opacity) === 0) return false;
    return true;
  }

  function isAriaHiddenOrDisabled(el) {
    let node = el;
    while (node) {
      if (node.getAttribute && node.getAttribute("aria-hidden") === "true") return true;
      if (node.disabled === true) return true;
      if (node.getAttribute && node.getAttribute("aria-disabled") === "true") return true;
      node = node.parentElement;
    }
    return false;
  }

  /** True if `el` has at least one direct text-node child with non-whitespace content. */
  function hasOwnVisibleText(el) {
    for (const child of el.childNodes) {
      if (
        child.nodeType === Node.TEXT_NODE &&
        child.textContent &&
        child.textContent.trim().length > 0
      ) {
        return true;
      }
    }
    return false;
  }

  /** Effective foreground alpha check: a fully transparent text color is a deliberate hide trick (e.g. .romanization-selectable) — exclude, not a bug. */
  function isTransparentColor(css) {
    const m = css.match(/rgba?\([^)]*\)/i);
    if (!m) return false;
    const parts = m[0]
      .replace(/rgba?\(|\)/g, "")
      .split(",")
      .map((s) => Number(s.trim()));
    const alpha = parts.length === 4 ? parts[3] : 1;
    return alpha === 0;
  }

  function parseColorLocal(css) {
    if (!css) return null;
    const m = css.match(
      /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)/i,
    );
    if (!m) return null;
    return {
      r: Number(m[1]),
      g: Number(m[2]),
      b: Number(m[3]),
      a: m[4] === undefined ? 1 : Number(m[4]),
    };
  }

  function compositeOver(fg, bgOpaque) {
    if (fg.a >= 1) return { r: fg.r, g: fg.g, b: fg.b };
    const a = fg.a;
    return {
      r: fg.r * a + bgOpaque.r * (1 - a),
      g: fg.g * a + bgOpaque.g * (1 - a),
      b: fg.b * a + bgOpaque.b * (1 - a),
    };
  }

  /**
   * Walks ancestors (starting at `el` itself) to find the first
   * non-transparent effective background, compositing any translucent
   * layers along the way. Returns `{ color }` on success, or
   * `{ unknownBg: true }` if a `background-image !== none` is encountered
   * before an opaque color resolves (can't safely infer contrast against an
   * image/gradient).
   */
  function effectiveBackground(el) {
    let node = el;
    let acc = null; // accumulated translucent-layer color, closest-to-text first
    while (node) {
      const style = getComputedStyle(node);
      if (style.backgroundImage && style.backgroundImage !== "none") {
        return { unknownBg: true };
      }
      const bg = parseColorLocal(style.backgroundColor);
      if (bg && bg.a > 0) {
        if (bg.a >= 1) {
          let result = { r: bg.r, g: bg.g, b: bg.b };
          if (acc) result = compositeOver(acc, result);
          return { color: result };
        }
        const layerOpaque = { r: bg.r, g: bg.g, b: bg.b };
        const composited = acc ? compositeOver(acc, layerOpaque) : layerOpaque;
        acc = { r: composited.r, g: composited.g, b: composited.b, a: bg.a };
      }
      node = node.parentElement;
    }
    // Reached <html> with nothing opaque found — browsers render an opaque
    // white canvas beneath everything by default.
    const fallback = { r: 255, g: 255, b: 255 };
    return { color: acc ? compositeOver(acc, fallback) : fallback };
  }

  /** Structural selector: id short-circuits; otherwise tag.class chain with
   *  nth-of-type only where siblings of the same tag exist, up to 6 ancestors.
   *  Deliberately position/content-agnostic so the SAME underlying CSS rule
   *  collapses to one selector-signature across different routes/words. */
  function cssPath(el) {
    if (el.id) return `#${el.id}`;
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === Node.ELEMENT_NODE && depth < 6) {
      let selector = node.tagName.toLowerCase();
      if (node.id) {
        selector += `#${node.id}`;
        parts.unshift(selector);
        break;
      }
      if (node.className && typeof node.className === "string") {
        const cls = node.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".");
        if (cls) selector += `.${cls}`;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          selector += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(selector);
      node = node.parentElement;
      depth++;
    }
    return parts.join(" > ");
  }

  const results = [];
  const failures = [];
  const all = document.querySelectorAll("body *");
  for (const el of all) {
    try {
      if (!hasOwnVisibleText(el)) continue;
      if (!isVisible(el)) continue;
      if (isAriaHiddenOrDisabled(el)) continue;

      const style = getComputedStyle(el);
      const fgCss = style.color;
      if (isTransparentColor(fgCss)) continue; // deliberate hide trick, not a bug

      const fg = parseColorLocal(fgCss);
      if (!fg || fg.a === 0) continue;

      const bgResult = effectiveBackground(el);
      const text = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .filter(Boolean)
        .join(" ")
        .slice(0, 80);

      const fontSizePx = Number.parseFloat(style.fontSize) || 16;
      const fontWeightRaw = style.fontWeight;
      const fontWeight = fontWeightRaw === "bold" ? 700 : Number.parseInt(fontWeightRaw, 10) || 400;
      const isBoldLarge = fontSizePx >= largeBoldTextPx && fontWeight >= largeBoldWeight;
      const isLarge = fontSizePx >= largeTextPx || isBoldLarge;
      const required = isLarge ? largeRatio : normalRatio;

      const base = {
        selector: cssPath(el),
        tag: el.tagName.toLowerCase(),
        text,
        fontSizePx,
        fontWeight,
        isLargeText: isLarge,
        requiredRatio: required,
        fg: fgCss,
      };

      if (bgResult.unknownBg) {
        results.push({ ...base, kind: "unknown-bg", bg: null, ratio: null, pass: null });
        continue;
      }

      const bg = bgResult.color;
      const bgCss = `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`;
      const ratio = (function contrast(a, bColor) {
        function lum(c) {
          function chan(v) {
            const x = v / 255;
            return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
          }
          return 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
        }
        const l1 = lum(a);
        const l2 = lum(bColor);
        const lighter = Math.max(l1, l2);
        const darker = Math.min(l1, l2);
        return (lighter + 0.05) / (darker + 0.05);
      })(fg, bg);

      results.push({
        ...base,
        kind: "measured",
        bg: bgCss,
        ratio: Math.round(ratio * 100) / 100,
        pass: ratio >= required,
      });
    } catch (err) {
      failures.push({
        selector: (() => {
          try {
            return cssPath(el);
          } catch {
            return "?";
          }
        })(),
        error: String(err),
      });
    }
  }
  return { results, failures };
}

// ---------------------------------------------------------------------------
// Crawl orchestration
// ---------------------------------------------------------------------------

const STATE_INITIAL = "initial";
const STATE_MOBILE_QUERY_FOCUS_TYPE = "mobile-query-focus-type";
const STATE_FULLTEXT_FOCUS_TYPE = "fulltext-search-focus-type";
const STATE_USER_PREF_OPEN = "user-pref-open";
const STATE_HOVER_TOOLTIP = "hover-result-tooltip";
const STATE_ENTRY_ACTIONS = "entry-actions-interactive";
const STATE_STROKE_ANIMATION = "stroke-animation-open";
const STATE_STARRED_ALL_LANGS = "starred-all-langs-open";
const STATE_STARRED_IMPORT = "starred-import-panel-open";

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    try {
      window.localStorage.setItem("theme", t);
    } catch {
      /* ignore */
    }
    document.documentElement.setAttribute("data-theme", t);
    document.documentElement.style.colorScheme = t;
  }, theme);
}

async function seedStarredWords(page) {
  // Seeds one starred word per dictionary language that StarredPage.tsx's
  // ALL_LANGS actually walks (a/t/c — h has no seeded fixture data here),
  // using the same on-disk format as word-record-utils.ts buildStarKey():
  // `"${word}"\n` prepended to storage key `starred-<lang>`.
  await page.evaluate(() => {
    const STARRED_SUFFIX = "\n";
    function buildStarKey(word) {
      return `"${word}"${STARRED_SUFFIX}`;
    }
    try {
      window.localStorage.setItem("starred-a", buildStarKey("萌"));
      window.localStorage.setItem("starred-t", buildStarKey("食"));
      window.localStorage.setItem("starred-c", buildStarKey("東西"));
    } catch {
      /* ignore */
    }
  });
}

/** Fresh context+page navigated to `route` with `theme` applied and (for /=*) starred seed data. Caller must close the context. */
async function freshPage(browser, viewport, theme, route) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: theme,
    locale: "zh-TW",
  });
  const page = await context.newPage();
  await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await setTheme(page, theme);
  if (route === "/=*") await seedStarredWords(page);
  const response = await page.goto(BASE_URL + encodeURI(route), {
    waitUntil: "networkidle",
    timeout: 20000,
  });
  await setTheme(page, theme);
  await page.waitForTimeout(200);
  return { context, page, response };
}

function selectorSignature(text) {
  // Selector-signature = the structural selector, already position/
  // content-agnostic (see cssPath in collectFindingsInPage). Kept as its own
  // named pass-through so the dedupe key construction below reads clearly.
  return text;
}

function dedupeKey(f) {
  // Per spec: dedupe by selector-signature / colors / state. Route, viewport
  // and theme are NOT part of the identity — the same underlying CSS rule
  // producing the same broken color pair in the same interaction state is
  // ONE finding, however many routes/viewports/themes it recurs on; those
  // recurrences are recorded as evidence arrays on the finding instead.
  return JSON.stringify([selectorSignature(f.selector), f.kind, f.fg, f.bg, f.state]);
}

function recordFinding(store, ctx, r, category) {
  const f = { ...r, state: ctx.state, category };
  const key = dedupeKey(f);
  let entry = store.get(key);
  if (!entry) {
    entry = {
      ...f,
      routes: new Set(),
      viewports: new Set(),
      themes: new Set(),
    };
    store.set(key, entry);
  }
  entry.routes.add(ctx.route);
  entry.viewports.add(ctx.viewport);
  entry.themes.add(ctx.theme);
}

async function snapshot(page, ctx, findingStore, actionFailures, collectOpts) {
  try {
    const { results, failures } = await page.evaluate(collectFindingsInPage, collectOpts);
    for (const r of results) {
      if (r.kind === "unknown-bg") {
        recordFinding(findingStore, ctx, { ...r, bg: "unknown-bg" }, "unknown-bg");
      } else if (!r.pass) {
        recordFinding(findingStore, ctx, r, "contrast-fail");
      }
    }
    for (const f of failures) {
      actionFailures.push({ ...ctx, kind: "collect-error", ...f });
    }
  } catch (err) {
    actionFailures.push({ ...ctx, kind: "snapshot-failed", error: String(err) });
  }
}

async function withIsolatedState(
  browser,
  viewport,
  theme,
  route,
  state,
  findingStore,
  actionFailures,
  collectOpts,
  action,
) {
  const ctx = { route, viewport: viewport.name, theme, state };
  let context;
  try {
    const fresh = await freshPage(browser, viewport, theme, route);
    context = fresh.context;
    const { page, response } = fresh;
    if (!response || response.status() >= 400) {
      actionFailures.push({
        ...ctx,
        kind: "navigation-failed",
        status: response ? response.status() : null,
      });
      return;
    }
    const ok = await action(page);
    if (ok === false) return; // action() already logged an element-missing/action-failed entry
    await snapshot(page, ctx, findingStore, actionFailures, collectOpts);
  } catch (err) {
    actionFailures.push({ ...ctx, kind: "route-failed", error: String(err) });
  } finally {
    if (context) await context.close();
  }
}

async function auditCombo(
  browser,
  { route, viewport, theme },
  findingStore,
  actionFailures,
  collectOpts,
) {
  // 1. initial — no interaction.
  await withIsolatedState(
    browser,
    viewport,
    theme,
    route,
    STATE_INITIAL,
    findingStore,
    actionFailures,
    collectOpts,
    async () => true,
  );

  // 2. Mobile query dropdown: focus + type 萌 in #query (mobile-only affordance).
  if (viewport.name === "mobile") {
    await withIsolatedState(
      browser,
      viewport,
      theme,
      route,
      STATE_MOBILE_QUERY_FOCUS_TYPE,
      findingStore,
      actionFailures,
      collectOpts,
      async (page) => {
        const query = page.locator("#query");
        if ((await query.count()) === 0) {
          actionFailures.push({
            route,
            viewport: viewport.name,
            theme,
            state: STATE_MOBILE_QUERY_FOCUS_TYPE,
            kind: "element-missing",
            selector: "#query",
          });
          return false;
        }
        await query.click({ timeout: 5000 });
        await query.fill("");
        await query.type("萌", { delay: 30 });
        await page.waitForTimeout(400);
        return true;
      },
    ).catch((err) =>
      actionFailures.push({
        route,
        viewport: viewport.name,
        theme,
        state: STATE_MOBILE_QUERY_FOCUS_TYPE,
        kind: "action-failed",
        error: String(err),
      }),
    );
  }

  // 3. Full-text search: focus + type in #nav-fulltext-search. Two instances
  // exist in the DOM (desktop-visible + mobile-visible siblings, toggled via
  // CSS breakpoints, not removed) — scope to the one Playwright's own
  // `:visible` pseudo-class resolves for the current viewport.
  await withIsolatedState(
    browser,
    viewport,
    theme,
    route,
    STATE_FULLTEXT_FOCUS_TYPE,
    findingStore,
    actionFailures,
    collectOpts,
    async (page) => {
      const fulltext = page.locator("#nav-fulltext-search:visible");
      if ((await fulltext.count()) === 0) {
        actionFailures.push({
          route,
          viewport: viewport.name,
          theme,
          state: STATE_FULLTEXT_FOCUS_TYPE,
          kind: "element-missing",
          selector: "#nav-fulltext-search",
        });
        return false;
      }
      await fulltext.first().click({ timeout: 5000 });
      await fulltext.first().fill("");
      await fulltext.first().type("萌", { delay: 30 });
      await page.waitForTimeout(500);
      return true;
    },
  ).catch((err) =>
    actionFailures.push({
      route,
      viewport: viewport.name,
      theme,
      state: STATE_FULLTEXT_FOCUS_TYPE,
      kind: "action-failed",
      error: String(err),
    }),
  );

  // 4. Open #user-pref panel.
  await withIsolatedState(
    browser,
    viewport,
    theme,
    route,
    STATE_USER_PREF_OPEN,
    findingStore,
    actionFailures,
    collectOpts,
    async (page) => {
      const prefBtn = page.locator("#btn-pref a");
      if ((await prefBtn.count()) === 0) {
        actionFailures.push({
          route,
          viewport: viewport.name,
          theme,
          state: STATE_USER_PREF_OPEN,
          kind: "element-missing",
          selector: "#btn-pref a",
        });
        return false;
      }
      await prefBtn.click({ timeout: 5000 });
      await page.waitForTimeout(300);
      return true;
    },
  ).catch((err) =>
    actionFailures.push({
      route,
      viewport: viewport.name,
      theme,
      state: STATE_USER_PREF_OPEN,
      kind: "action-failed",
      error: String(err),
    }),
  );

  // 5. Exercise every entry action's hover/focus state.
  await withIsolatedState(
    browser,
    viewport,
    theme,
    route,
    STATE_ENTRY_ACTIONS,
    findingStore,
    actionFailures,
    collectOpts,
    async (page) => {
      const actions = page.locator(".entry-actions").first();
      if ((await actions.count()) === 0) return false;
      for (const selector of [".entry-copy-button", "a.variants-link", '[role="button"].star']) {
        const control = actions.locator(selector).first();
        if ((await control.count()) > 0) {
          await control.hover({ timeout: 5000 });
          await control.focus();
          await page.waitForTimeout(100);
        }
      }
      return true;
    },
  ).catch((err) =>
    actionFailures.push({
      route,
      viewport: viewport.name,
      theme,
      state: STATE_ENTRY_ACTIONS,
      kind: "action-failed",
      error: String(err),
    }),
  );

  // 5. Hover first .result a[href] and wait for .ui-tooltip.
  await withIsolatedState(
    browser,
    viewport,
    theme,
    route,
    STATE_HOVER_TOOLTIP,
    findingStore,
    actionFailures,
    collectOpts,
    async (page) => {
      const link = page.locator(".result a[href]").first();
      if ((await link.count()) === 0) {
        actionFailures.push({
          route,
          viewport: viewport.name,
          theme,
          state: STATE_HOVER_TOOLTIP,
          kind: "element-missing",
          selector: ".result a[href]",
        });
        return false;
      }
      await link.hover({ timeout: 5000 });
      const tooltip = page.locator(".ui-tooltip");
      await tooltip.waitFor({ state: "visible", timeout: 3000 });
      await page.waitForTimeout(300);
      return true;
    },
  ).catch((err) =>
    actionFailures.push({
      route,
      viewport: viewport.name,
      theme,
      state: STATE_HOVER_TOOLTIP,
      kind: "action-failed",
      error: String(err),
    }),
  );

  // 6. Click stroke icon a.iconic-circle.stroke[title="筆順動畫"].
  await withIsolatedState(
    browser,
    viewport,
    theme,
    route,
    STATE_STROKE_ANIMATION,
    findingStore,
    actionFailures,
    collectOpts,
    async (page) => {
      const strokeIcon = page.locator('a.iconic-circle.stroke[title="筆順動畫"]:visible').first();
      if ((await strokeIcon.count()) === 0) {
        actionFailures.push({
          route,
          viewport: viewport.name,
          theme,
          state: STATE_STROKE_ANIMATION,
          kind: "element-missing",
          selector: 'a.iconic-circle.stroke[title="筆順動畫"]',
        });
        return false;
      }
      await strokeIcon.click({ timeout: 5000 });
      await page.waitForTimeout(500);
      return true;
    },
  ).catch((err) =>
    actionFailures.push({
      route,
      viewport: viewport.name,
      theme,
      state: STATE_STROKE_ANIMATION,
      kind: "action-failed",
      error: String(err),
    }),
  );

  // 7/8. /=*-specific: 顯示全部語言 + 匯入 panel (separate isolated states).
  if (route === "/=*") {
    await withIsolatedState(
      browser,
      viewport,
      theme,
      route,
      STATE_STARRED_ALL_LANGS,
      findingStore,
      actionFailures,
      collectOpts,
      async (page) => {
        const allLangsBtn = page.locator("#btn-toggle-all-langs");
        if ((await allLangsBtn.count()) === 0) {
          actionFailures.push({
            route,
            viewport: viewport.name,
            theme,
            state: STATE_STARRED_ALL_LANGS,
            kind: "element-missing",
            selector: "#btn-toggle-all-langs",
          });
          return false;
        }
        await allLangsBtn.click({ timeout: 5000 });
        await page.waitForTimeout(300);
        return true;
      },
    ).catch((err) =>
      actionFailures.push({
        route,
        viewport: viewport.name,
        theme,
        state: STATE_STARRED_ALL_LANGS,
        kind: "action-failed",
        error: String(err),
      }),
    );

    await withIsolatedState(
      browser,
      viewport,
      theme,
      route,
      STATE_STARRED_IMPORT,
      findingStore,
      actionFailures,
      collectOpts,
      async (page) => {
        const importBtn = page.locator("#btn-toggle-import");
        if ((await importBtn.count()) === 0) {
          actionFailures.push({
            route,
            viewport: viewport.name,
            theme,
            state: STATE_STARRED_IMPORT,
            kind: "element-missing",
            selector: "#btn-toggle-import",
          });
          return false;
        }
        await importBtn.click({ timeout: 5000 });
        await page.waitForTimeout(300);
        return true;
      },
    ).catch((err) =>
      actionFailures.push({
        route,
        viewport: viewport.name,
        theme,
        state: STATE_STARRED_IMPORT,
        kind: "action-failed",
        error: String(err),
      }),
    );
  }
}

async function main() {
  const browser = await chromium.launch();
  /** @type {Map<string, object>} dedupeKey -> finding (with Set-valued routes/viewports/themes) */
  const findingStore = new Map();
  const actionFailures = [];

  const collectOpts = {
    normalRatio: NORMAL_RATIO,
    largeRatio: LARGE_RATIO,
    largeTextPx: LARGE_TEXT_PX,
    largeBoldTextPx: LARGE_BOLD_TEXT_PX,
    largeBoldWeight: LARGE_BOLD_WEIGHT,
  };

  for (const route of ROUTES) {
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        await auditCombo(
          browser,
          { route, viewport, theme },
          findingStore,
          actionFailures,
          collectOpts,
        );
      }
    }
  }

  await browser.close();

  const byLocale = (a, b) => a.localeCompare(b);
  const allFindings = Array.from(findingStore.values()).map((f) => ({
    ...f,
    routes: Array.from(f.routes).sort(byLocale),
    viewports: Array.from(f.viewports).sort(byLocale),
    themes: Array.from(f.themes).sort(byLocale),
  }));

  const contrastFailures = allFindings.filter((f) => f.category === "contrast-fail");
  const unknownBg = allFindings.filter((f) => f.category === "unknown-bg");

  const output = {
    baseUrl: BASE_URL,
    generatedAt: new Date().toISOString(),
    routes: ROUTES,
    viewports: VIEWPORTS.map((v) => v.name),
    themes: THEMES,
    summary: {
      totalFindings: allFindings.length,
      contrastFailures: contrastFailures.length,
      unknownBg: unknownBg.length,
      actionFailures: actionFailures.length,
    },
    findings: allFindings,
    actionFailures,
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");

  console.log(`\n=== Dark/Light Contrast Audit ===`);
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`Routes: ${ROUTES.join(", ")}`);
  console.log(
    `Viewports: ${VIEWPORTS.map((v) => v.name).join(", ")} | Themes: ${THEMES.join(", ")}`,
  );
  console.log(`\nContrast failures (deduped by selector/colors/state): ${contrastFailures.length}`);
  console.log(`Unknown-background elements (deduped): ${unknownBg.length}`);
  console.log(`Action failures: ${actionFailures.length}`);

  if (contrastFailures.length > 0) {
    console.log(`\n--- Contrast failures ---`);
    for (const f of contrastFailures) {
      console.log(
        `[${f.state} | themes=${f.themes.join(",")} | viewports=${f.viewports.join(",")} | routes=${f.routes.join(",")}]\n` +
          `  ${f.selector} "${f.text}" ratio=${f.ratio} required=${f.requiredRatio} fg=${f.fg} bg=${f.bg}`,
      );
    }
  }
  if (unknownBg.length > 0) {
    console.log(`\n--- Unknown background (background-image, not evaluated) ---`);
    for (const f of unknownBg) {
      console.log(`[${f.state} | routes=${f.routes.join(",")}] ${f.selector} "${f.text}"`);
    }
  }
  if (actionFailures.length > 0) {
    console.log(`\n--- Action failures ---`);
    for (const f of actionFailures) {
      console.log(
        `[${f.route} | ${f.viewport} | ${f.theme} | ${f.state}] ${f.kind}: ${f.selector || f.error || f.status}`,
      );
    }
  }

  console.log(`\nFull report: ${OUTPUT_PATH}\n`);

  // Non-zero exit when real contrast failures are found, so this can be
  // wired into CI later without extra plumbing (not currently gated on).
  if (contrastFailures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Fatal error in audit-dark-contrast.mjs:", err);
  process.exitCode = 2;
});
