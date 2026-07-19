import { describe, expect, it } from "vite-plus/test";
import {
  WCAG_LARGE_RATIO,
  WCAG_NORMAL_RATIO,
  classifyActionFailure,
  classifyUnknownBackground,
  contrastRatio,
  isTransparentColor,
} from "../../scripts/lib/contrast-audit.mjs";

describe("contrast audit policy", () => {
  it("uses WCAG normal and large-text thresholds", () => {
    expect(WCAG_NORMAL_RATIO).toBe(4.5);
    expect(WCAG_LARGE_RATIO).toBe(3);
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 5);
  });

  it("classifies realistic cssPath terminal tokens, not ancestor or near-name matches", () => {
    expect(classifyUnknownBackground({ selector: "html > body.lang-a" })).toBe(
      "expected-textured-background",
    );
    expect(classifyUnknownBackground({ selector: "html > body > div.result" })).toBe(
      "expected-textured-background",
    );
    expect(classifyUnknownBackground({ selector: "html > div.result:nth-of-type(2)" })).toBe(
      "expected-textured-background",
    );
    expect(classifyUnknownBackground({ selector: "html > div.query-box" })).toBe(
      "expected-textured-background",
    );
    expect(classifyUnknownBackground({ selector: "main.about-page" })).toBe(
      "expected-textured-background",
    );
    expect(classifyUnknownBackground({ selector: "div.result-like" })).toBe("unexpected");
    expect(classifyUnknownBackground({ selector: "div.result > span.child" })).toBe("unexpected");
    expect(classifyUnknownBackground({ selector: "html > div.query-box-wrapper" })).toBe(
      "unexpected",
    );
  });
  it("classifies .navbar-inverse-textured backgrounds via ancestor match, using the exact cssPath shape the audit produces", () => {
    // Real cssPath()-shaped selectors from a live audit run against
    // data/assets/styles.css's `.navbar-inverse { background-image:
    // url(images/leather_x2.jpg) }` (layered over `background-color: #222`)
    // -- both text-bearing terminal elements sit several ancestor levels
    // below .navbar-inverse itself, so only the ancestor-chain match (not
    // the terminal-token match used by EXPECTED_TEXTURED_SELECTORS) can
    // classify them as expected.
    expect(
      classifyUnknownBackground({
        selector:
          "div#root > div.app-shell > nav.navbar.navbar-inverse.navbar-fixed-top > div.navbar-header > a.navbar-brand.brand.ebas",
      }),
    ).toBe("expected-textured-background");
    expect(
      classifyUnknownBackground({
        selector:
          "div.app-shell > nav.navbar.navbar-inverse.navbar-fixed-top > ul.nav.navbar-nav:nth-of-type(1) > li:nth-of-type(1) > a > span.lang-active",
      }),
    ).toBe("expected-textured-background");
    // .navbar-inverse as the terminal element itself (not just an ancestor)
    // must also match.
    expect(
      classifyUnknownBackground({ selector: "nav.navbar.navbar-inverse.navbar-fixed-top" }),
    ).toBe("expected-textured-background");

    // Near-name negatives: a class merely containing "navbar-inverse" as a
    // substring (superset name, or a different class with it as a
    // suffix/prefix) must NOT match -- classifyUnknownBackground tokenizes
    // exact class names via the same `\.([a-zA-Z0-9_-]+)` pattern used
    // elsewhere in this file, not a substring/regex search over the raw
    // selector string.
    expect(classifyUnknownBackground({ selector: "nav.navbar-inverse-child > span.text" })).toBe(
      "unexpected",
    );
    expect(classifyUnknownBackground({ selector: "nav.my-navbar-inverse > span.text" })).toBe(
      "unexpected",
    );

    // Descendant negative: an element with no .navbar-inverse (or any other
    // EXPECTED_TEXTURED_ANCESTORS/EXPECTED_TEXTURED_SELECTORS class)
    // anywhere in its ancestor chain must stay unexpected -- confirms
    // matchesAncestor doesn't degrade into "any unknown-bg is fine".
    expect(
      classifyUnknownBackground({ selector: "div.entry-actions > button.entry-copy-button" }),
    ).toBe("unexpected");

    // Terminal negative, navbar-adjacent: EXPECTED_TEXTURED_SELECTORS'
    // terminal-only members (.result etc.) still must NOT match when they
    // appear only as an ancestor of an unrelated terminal element sitting
    // under a DIFFERENT (non-textured) container -- distinguishes
    // matchesAncestor (only checks EXPECTED_TEXTURED_ANCESTORS) from a
    // hypothetical "any known class anywhere" rule that would also cover
    // EXPECTED_TEXTURED_SELECTORS members as ancestors.
    expect(classifyUnknownBackground({ selector: "div.result > div.card > span.unrelated" })).toBe(
      "unexpected",
    );
  });

  it("classifies transparent text as intentionally hidden", () => {
    expect(isTransparentColor("rgba(1, 2, 3, 0)")).toBe(true);
    expect(isTransparentColor("rgba(1, 2, 3, 0.5)")).toBe(false);
    expect(isTransparentColor("rgb(1, 2, 3)")).toBe(false);
  });

  it("distinguishes unavailable controls from real action failures", () => {
    expect(classifyActionFailure({ kind: "element-missing", selector: "#btn-toggle-import" })).toBe(
      "unavailable-action",
    );
    expect(
      classifyActionFailure({ kind: "element-missing", selector: "#new-required-control" }),
    ).toBe("unexpected");
    expect(classifyActionFailure({ kind: "action-failed", selector: "#btn-toggle-import" })).toBe(
      "unexpected",
    );
  });
});
