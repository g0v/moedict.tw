/**
 * scripts/lib/prod-parity-measure.mjs
 *
 * Shared prod-parity geometry measurement module — the ONE code path
 * scripts/refresh-prod-parity-baseline.mjs (captures live prod's values,
 * Playwright chromium), tests/e2e/prod-parity.spec.ts (captures staging's
 * values, Playwright against the local Miniflare fixture), AND this
 * session's own xd://browser (Puppeteer) seed-capture run through
 * unmodified. This exists because baseline capture and CI assertion
 * sharing the exact same selector-eval / aggregate / readiness-wait code
 * path is what makes a `recorded_value` trustworthy as "what the spec will
 * actually compare against" — two independent reimplementations (even both
 * "obviously correct" in isolation) could silently diverge in rounding,
 * aggregate order, or readiness timing and turn the gate into noise
 * unrelated to any real prod-vs-staging divergence.
 *
 * Deliberately restricted to the lowest-common-denominator Page API both
 * Playwright and Puppeteer implement identically — `goto`, `evaluate`,
 * `waitForFunction` — with NO `page.locator()` (Playwright-only surface;
 * Puppeteer's own `Locator` type is a different, incompatible API) and NO
 * `page.setViewport(Size)` (name/shape differs: Puppeteer `setViewport`,
 * Playwright `setViewportSize`) — callers apply `VIEWPORTS` via their own
 * runtime's idiom before calling `measureEntry`. This is what let this
 * session run the IDENTICAL file, unmodified, against real Chromium via
 * Playwright (local fixture measurements) and via Puppeteer (xd://browser
 * live-prod measurements) for the seed data below — not two hand-written
 * "equivalent" implementations that could have quietly drifted.
 *
 * Plain ESM, no TypeScript syntax: imported under bare `node` by
 * refresh-prod-parity-baseline.mjs (matching scripts/audit-dark-contrast.mjs's
 * own invocation convention) AND from tests/e2e/prod-parity.spec.ts (Vite/
 * tsx's bundler module resolution loads a plain `.mjs` from a `.ts` file
 * without issue — same pattern as tests/unit/contrast-audit.test.ts
 * importing scripts/lib/contrast-audit.mjs).
 */

export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
};

export const DEFAULT_TOLERANCE_PX = 2;
export const DEFAULT_TOLERANCE_PCT = 5;

/**
 * Runs inside the page via page.evaluate — self-contained (no outer-scope
 * closures survive serialization across the browser boundary). True once
 * DictionaryPage.tsx's two-stage hydration contract has settled (the
 * result container, or an error/alert state, is present AND body carries
 * its final `lang-X` class — both commit in the same React effect, but a
 * container-only check can observe the DOM one tick before that effect
 * has actually run) AND AssetLoader.tsx's legacy `data/assets/styles.css`
 * `<link>` has actually finished loading (`.sheet != null` — mirrors
 * tests/e2e/readiness.ts's "about" kind's identical check for its own
 * two-stylesheet race). Every allowlisted surface's geometry is
 * legacy-CSS-cascade-dependent (confirmed live this session: the
 * unstyled .example container measures 898px vs the real-cascade
 * 538.171875px — nearly double), so gating on the container/lang-class
 * alone would let a measurement race AssetLoader's async `fetch("/api/
 * config")` → `<link>` injection and silently capture the wrong, unstyled
 * number. Mirrors readiness.ts's "dictionary-lang" kind plus this
 * stylesheet-loaded check; kept as a standalone predicate (not imported)
 * because this module must also run under plain `node`, which cannot
 * parse readiness.ts's TypeScript. Keep both in sync if either changes.
 */
function isDictionaryReady() {
  const hasContainer = document.querySelector(
    'h1.title, .dictionary-error, [role="alert"], .result',
  );
  const stylesLink = document.querySelector('link[data-asset-id="styles-css"]');
  return (
    Boolean(hasContainer) &&
    /\blang-[a-z]+\b/.test(document.body.className) &&
    stylesLink?.sheet != null
  );
}

/** Polls isDictionaryReady() via the one wait primitive both Playwright's
 * and Puppeteer's Page implement with an identical no-arg call shape. */
export async function waitForDictionaryReady(page) {
  await page.waitForFunction(isDictionaryReady);
}

const AGGREGATE_KINDS = new Set(["first", "max", "nth", "count"]);
const MEASUREMENT_KINDS = new Set(["absolute-px", "ratio"]);

function assertEntryShape(entry) {
  if (!entry.id || !entry.page || !entry.selector) {
    throw new Error(
      `[prod-parity-measure] malformed entry (missing id/page/selector): ${JSON.stringify(entry)}`,
    );
  }
  const aggregate = entry.aggregate ?? "first";
  if (!AGGREGATE_KINDS.has(aggregate)) {
    throw new Error(`[prod-parity-measure] entry ${entry.id}: unknown aggregate "${aggregate}"`);
  }
  if (aggregate === "nth" && !Number.isInteger(entry.matchIndex)) {
    throw new Error(
      `[prod-parity-measure] entry ${entry.id}: aggregate "nth" requires an integer matchIndex`,
    );
  }
  if (!MEASUREMENT_KINDS.has(entry.measurement)) {
    throw new Error(
      `[prod-parity-measure] entry ${entry.id}: measurement must be "absolute-px" or "ratio", got "${entry.measurement}"`,
    );
  }
  if (
    entry.measurement === "ratio" &&
    (!entry.phonetics_pref || !entry.ratio_reference?.phonetics_pref)
  ) {
    throw new Error(
      `[prod-parity-measure] entry ${entry.id}: ratio measurement requires phonetics_pref + ratio_reference.phonetics_pref`,
    );
  }
}

/**
 * Runs inside the page via page.evaluate — self-contained. Aggregates
 * every selector match's own getBoundingClientRect() per requested
 * property, NEVER getComputedStyle().width/height (reports "auto" for
 * many inline/flow boxes — would not match this harness's live-captured
 * seed data, all measured via boundingClientRect).
 *   - "first": first match's own value.
 *   - "max": max across all matches (mirrors visual-invariants.spec.ts
 *     R6's Math.max(...titles) fix for multi-heteronym pages).
 *   - "nth": the match at `matchIndex` (0-based, document order across the
 *     WHOLE page — not scoped per-ancestor) — for a selector whose
 *     interesting instance isn't the first (e.g. the illustrative example
 *     sentence used for this harness's own seed data is document-order
 *     match index 1 of `.entry-item .example` page-wide). Prefer a
 *     selector specific enough to need no index before reaching for this;
 *     it exists because CSS has no reliable "Nth `.entry-item` ancestor"
 *     selector when siblings aren't uniformly typed (`:nth-of-type` counts
 *     same-tag siblings only, which silently picks the wrong element when
 *     `.entry-item` divs are interleaved with other div-tagged siblings).
 *   - "count": returns only the match count; `properties` is ignored.
 */
function collectGeometryInPage({ selector, aggregate, matchIndex, properties }) {
  const els = Array.from(document.querySelectorAll(selector));
  if (aggregate === "count") return { count: els.length, values: null };
  if (els.length === 0) return { count: 0, values: null };
  if (aggregate === "nth" && (matchIndex == null || !els[matchIndex])) {
    return { count: els.length, values: null };
  }
  const values = {};
  for (const prop of properties) {
    if (aggregate === "nth") {
      values[prop] = els[matchIndex].getBoundingClientRect()[prop];
      continue;
    }
    const nums = els.map((el) => el.getBoundingClientRect()[prop]);
    values[prop] = aggregate === "max" ? Math.max(...nums) : nums[0];
  }
  return { count: els.length, values };
}

/**
 * Navigates to `entry.page` (resolved against `baseUrl`), waits for
 * dictionary-lang readiness, evaluates `entry.selector` through
 * collectGeometryInPage. Caller must have already applied any request
 * interception (legacy CSS routing, font blocking) and viewport sizing on
 * `page` before calling this — both persist across the navigation
 * performed here.
 */
async function measureAbsolute(page, baseUrl, entry) {
  const url = new URL(entry.page, baseUrl).toString();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForDictionaryReady(page);
  const aggregate = entry.aggregate ?? "first";
  return page.evaluate(collectGeometryInPage, {
    selector: entry.selector,
    aggregate,
    matchIndex: entry.matchIndex ?? null,
    properties: entry.properties ?? [],
  });
}

/**
 * Ratio entries reuse the SAME selector/aggregate/properties[0] at two
 * different `phonetics` localStorage prefs on the SAME page (the R6
 * bopomofo-vs-none title-height pattern) — each pref requires a real
 * reload because PrefList's phonetics state is read once at mount via
 * `useState(() => getStoredPref("phonetics", ...))`, not reactively from
 * localStorage.
 */
async function measureRatio(page, baseUrl, entry) {
  const url = new URL(entry.page, baseUrl).toString();
  const aggregate = entry.aggregate ?? "first";
  const prop = entry.properties[0];

  async function loadWithPref(pref) {
    // Two navigations: the first lets a mounted app write localStorage in
    // page context; the second is the real, freshly-mounted measurement
    // pass that actually reads the pref this call just set.
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await waitForDictionaryReady(page);
    await page.evaluate((p) => window.localStorage.setItem("phonetics", p), pref);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await waitForDictionaryReady(page);
    return page.evaluate(collectGeometryInPage, {
      selector: entry.selector,
      aggregate,
      matchIndex: entry.matchIndex ?? null,
      properties: entry.properties,
    });
  }

  const numerator = await loadWithPref(entry.phonetics_pref);
  const denominator = await loadWithPref(entry.ratio_reference.phonetics_pref);
  if (!numerator.values || !denominator.values) {
    return {
      count: Math.min(numerator.count, denominator.count),
      ratio: null,
      numerator,
      denominator,
    };
  }
  return {
    count: numerator.count,
    ratio: numerator.values[prop] / denominator.values[prop],
    numerator,
    denominator,
  };
}

/**
 * Measures ONE allowlist entry against `page`. This is the single call
 * site the refresh script, the CI spec, AND this session's own seed
 * capture all invoke — see module doc.
 */
export async function measureEntry(page, baseUrl, entry) {
  assertEntryShape(entry);
  return entry.measurement === "ratio"
    ? measureRatio(page, baseUrl, entry)
    : measureAbsolute(page, baseUrl, entry);
}

/**
 * Compares a measureEntry() result against `entry`'s recorded baseline.
 * Returns `selectorMatched: false` (always a failure, regardless of
 * `provisional`) when the selector matched zero elements for a
 * non-"count" aggregate — a vanished selector means the entry itself is
 * broken (markup changed, route 404s, etc.), not a legitimate geometry
 * divergence, and must never be silently swallowed by the soft-fail path.
 */
export function compareEntry(measured, entry) {
  const aggregate = entry.aggregate ?? "first";

  if (aggregate === "count") {
    const value = measured.count;
    const recorded = entry.recorded_value.count;
    const tolerance = entry.tolerance_px ?? 0;
    const delta = Math.abs(value - recorded);
    return {
      selectorMatched: true, // zero matches IS a valid measurement for a count aggregate
      pass: delta <= tolerance,
      delta,
      message: `[${entry.id}] count=${value}, recorded=${recorded}, tolerance=${tolerance}, delta=${delta}`,
    };
  }

  if (measured.values === null || (entry.measurement === "ratio" && measured.ratio === null)) {
    return {
      selectorMatched: false,
      pass: false,
      delta: null,
      message: `[${entry.id}] selector matched 0 elements: ${entry.selector}`,
    };
  }

  if (entry.measurement === "absolute-px") {
    const prop = entry.properties[0];
    const value = measured.values[prop];
    const recorded = entry.recorded_value[prop];
    const tolerance = entry.tolerance_px ?? DEFAULT_TOLERANCE_PX;
    const delta = Math.abs(value - recorded);
    return {
      selectorMatched: true,
      pass: delta <= tolerance,
      delta,
      message: `[${entry.id}] ${prop}=${value.toFixed(3)}px, recorded=${recorded}px, tolerance=${tolerance}px, delta=${delta.toFixed(3)}px`,
    };
  }

  // ratio
  const tolerancePct = entry.tolerance_pct ?? DEFAULT_TOLERANCE_PCT;
  const recorded = entry.recorded_ratio;
  const deltaPct = (Math.abs(measured.ratio - recorded) / recorded) * 100;
  return {
    selectorMatched: true,
    pass: deltaPct <= tolerancePct,
    delta: deltaPct,
    message: `[${entry.id}] ratio=${measured.ratio.toFixed(4)}, recorded=${recorded}, tolerance=${tolerancePct}%, delta=${deltaPct.toFixed(2)}%`,
  };
}
