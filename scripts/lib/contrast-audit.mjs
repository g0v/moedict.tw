export const WCAG_NORMAL_RATIO = 4.5;
export const WCAG_LARGE_RATIO = 3;

export function relativeLuminance({ r, g, b }) {
  const channel = (value) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(first, second) {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function classifyActionFailure(failure) {
  if (failure.kind !== "element-missing") return "unexpected";
  const unavailable = new Set([
    'a.iconic-circle.stroke[title="筆順動畫"]',
    ".entry-actions",
    ".result a[href]",
    "#btn-toggle-all-langs",
    "#btn-toggle-import",
  ]);
  return unavailable.has(failure.selector) ? "unavailable-action" : "unexpected";
}

// Elements whose EFFECTIVE background is a verified-safe texture/image, so
// "can't compute contrast against an image" is expected here, not a defect.
// These match only the terminal (text-bearing) element's OWN classes -- a
// class appearing higher up the ancestor chain does NOT count (a `span`
// nested arbitrarily deep inside `.result` isn't automatically covered just
// because `.result` happens to be an ancestor; if that span reports
// unknown-bg, the actual background-image is on the span itself or some
// OTHER, unaccounted-for ancestor, which is exactly the kind of thing this
// classifier exists to catch).
//   - body: data/assets/styles.css `body { background-image:
//     url(images/subtle_stripes_x2.png) }` -- app shell base texture.
//   - .about-page / .result / .query-box: app-specific panel backgrounds
//     (src/index.css / InlineStyles.tsx).
export const EXPECTED_TEXTURED_SELECTORS = new Set([
  "body",
  ".about-page",
  ".result",
  ".query-box",
]);

// Unlike EXPECTED_TEXTURED_SELECTORS above, these DO match anywhere in the
// ancestor chain, not just the terminal element -- their texture is
// deliberately inherited by every descendant text node, since
// collectFindingsInPage's effectiveBackground() stops walking at the FIRST
// ancestor with a background-image (which is these containers themselves,
// not the text-bearing terminal element several levels below them).
//   - .navbar-inverse: legacy Bootstrap navbar `background-image:
//     url(images/leather_x2.jpg)` (data/assets/styles.css) layered over
//     `background-color: #222`. Verified safe: the actual leather_x2.jpg
//     samples RGB(14,14,14)-(35,35,35) across every pixel (measured via
//     PIL), and its lightest-styled descendant text (.navbar-brand, #999 /
//     153,153,153) still clears WCAG AA against the LIGHTEST sampled
//     texture pixel (35,35,35): ~5.52:1 vs the 4.5:1 threshold for this
//     18px/500-weight (normal, non-large) text.
const EXPECTED_TEXTURED_ANCESTORS = new Set([".navbar-inverse"]);

function terminalSelectorToken(selector) {
  return selector.split(">").at(-1)?.trim().split(/\s+/)[0] ?? "";
}

export function classifyUnknownBackground(finding) {
  const terminal = terminalSelectorToken(finding.selector);
  const isBody = /^body(?:[.#]|$)/.test(terminal);
  const terminalClasses = new Set(
    terminal.match(/\.([a-zA-Z0-9_-]+)/g)?.map((name) => name.slice(1)) ?? [],
  );
  const expectedTerminalClasses = new Set(
    [...EXPECTED_TEXTURED_SELECTORS]
      .filter((selector) => selector.startsWith("."))
      .map((selector) => selector.slice(1)),
  );
  const matchesTerminal = [...terminalClasses].some((name) => expectedTerminalClasses.has(name));

  const ancestorClasses = new Set(
    finding.selector.match(/\.([a-zA-Z0-9_-]+)/g)?.map((name) => name.slice(1)) ?? [],
  );
  const expectedAncestorClasses = new Set(
    [...EXPECTED_TEXTURED_ANCESTORS].map((selector) => selector.slice(1)),
  );
  const matchesAncestor = [...ancestorClasses].some((name) => expectedAncestorClasses.has(name));

  const expected = isBody || matchesTerminal || matchesAncestor;
  return expected ? "expected-textured-background" : "unexpected";
}
export function isTransparentColor(css) {
  const match = css.match(/rgba?\([^)]*\)/i);
  if (!match) return false;
  const parts = match[0]
    .replace(/rgba?\(|\)/g, "")
    .split(",")
    .map((value) => Number(value.trim()));
  return (parts.length === 4 ? parts[3] : 1) === 0;
}
