/**
 * Only targets `data/assets/*.css` (see package.json's `lint:css` script) —
 * currently just the legacy vendor bundle `data/assets/styles.css`
 * (normalize.css + Bootstrap 3 + Font Awesome 3 + moedict's own theme CSS).
 * Every rule disabled below is a legacy-bundle accommodation (vendor
 * prefixes, old selector/value notation, intentional cascade-order
 * overrides), NOT a general style preference. If `lint:css`'s glob is ever
 * widened to include hand-written CSS (e.g. `src/**\/*.css`), split this
 * into a base config + an `overrides` block scoped to `data/assets/*.css`
 * so these accommodations don't silently hide real bugs in new CSS.
 */
export default {
  extends: "stylelint-config-standard",
  rules: {
    // Legacy bundle repeats selectors at different cascade positions and
    // has selectors of varying specificity by design — see
    // data/assets/styles.css's own header comment, "EDITING RULES" §1.
    "no-descending-specificity": null,
    "no-duplicate-selectors": null,
    // Duplicate declarations are often intentional fallbacks (e.g. a plain
    // color before an rgba() override) — flag them, never auto-merge.
    "declaration-block-no-duplicate-properties": [
      true,
      {
        ignore: ["consecutive-duplicates-with-different-syntaxes"],
        severity: "warning",
      },
    ],
    // Vendor-prefixed properties/selectors/at-rules/media-features are
    // intentional cross-browser compatibility in this decade-old bundle.
    "property-no-vendor-prefix": null,
    "selector-no-vendor-prefix": null,
    "media-feature-name-no-vendor-prefix": null,
    "at-rule-no-vendor-prefix": null,
    // Old (but valid) CSS syntax this bundle predates the modern form of.
    "media-feature-range-notation": null,
    "selector-pseudo-element-colon-notation": null, // :before vs ::before
    "selector-not-notation": null, // simple :not(.x) vs complex form
    "alpha-value-notation": null,
    "color-function-notation": null,
    "color-function-alias-notation": null,
    "selector-attribute-quotes": null,
    "function-url-quotes": null,
    "number-max-precision": null, // Bootstrap's 1.428571429 line-heights etc.
    "declaration-block-no-redundant-longhand-properties": null,
    // Legacy/vendor naming this repo doesn't own (Bootstrap classes, CJK
    // font-family names, deliberately-repeated generic font fallbacks).
    "selector-class-pattern": null,
    "value-keyword-case": null,
    "font-family-name-quotes": null,
    "font-family-no-duplicate-names": null,
    "font-family-no-missing-generic-family-keyword": null,
    "property-no-deprecated": null,
    "declaration-property-value-keyword-no-deprecated": null,
    // moedict's own custom elements (ruby/annotation markup), not unknown.
    "selector-type-no-unknown": [true, { ignoreTypes: ["hruby", "ru", "zhuyin", "diao", "yin"] }],
  },
};
