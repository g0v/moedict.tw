import { expect, test } from "./_fixtures";

// Regression guard for #152's CSS-module port: the top-level
// `.dropdownMenuRoot` ul lacked `list-style: none` (only the nested
// `.dropdownMenu` had it), so the dictionary dropdown (華語辭典 ▾) rendered
// browser-default bullets with looser spacing than production. See
// navbar-normal.module.css `.dropdownMenuRoot`.
test.describe("dictionary dropdown — list-style reset (#152 regression)", () => {
  test("every ul in the open dropdown subtree has list-style-type none", async ({ page }) => {
    await page.goto("/~%E8%90%8C");

    await page.locator("nav .navbar-nav > li").first().locator("a").first().click();
    const root = page.locator("nav ul[role=navigation]");
    await expect(root).toBeVisible();

    const listStyles = await root.evaluate((rootEl) => {
      const uls = [rootEl, ...Array.from(rootEl.querySelectorAll("ul"))];
      return uls.map((ul) => getComputedStyle(ul).listStyleType);
    });

    expect(listStyles.length).toBeGreaterThan(1); // root + at least one nested .dropdownMenu
    for (const listStyleType of listStyles) {
      expect(listStyleType).toBe("none");
    }
  });

  test("dropdown root ul box metrics match production (tight bullet-free spacing)", async ({
    page,
  }) => {
    await page.goto("/~%E8%90%8C");

    await page.locator("nav .navbar-nav > li").first().locator("a").first().click();
    const root = page.locator("nav ul[role=navigation]");
    await expect(root).toBeVisible();

    const metrics = await root.evaluate((rootEl) => {
      const style = getComputedStyle(rootEl);
      const firstItem = rootEl.children[0] as HTMLElement;
      return {
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        marginTop: style.marginTop,
        firstItemHeight: firstItem.getBoundingClientRect().height,
      };
    });

    // Production computed values (Bootstrap 3.4.1 .dropdown-menu reset):
    // padding: 5px 8px 5px 0px; margin: 0.
    expect(metrics.paddingTop).toBe("5px");
    expect(metrics.paddingBottom).toBe("5px");
    // padding-left must be 0 — the UA default (40px, reserving bullet-marker
    // room) is exactly what caused the reported visual regression.
    expect(metrics.paddingLeft).toBe("0px");
    expect(metrics.marginTop).toBe("0px");
    // Sanity bound: a bulleted/looser dropdown item is visibly taller than a
    // tight one; production's own metric is font-size(19px)*line-height-ratio
    // + 6px padding \u2248 33px. Assert a tight upper bound rather than pixel-matching
    // the ratio (which depends on whether legacy styles.css's line-height is
    // loaded in this fixture environment).
    expect(metrics.firstItemHeight).toBeLessThan(36);
  });
});
