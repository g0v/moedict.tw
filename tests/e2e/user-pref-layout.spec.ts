import { expect, test } from "./_fixtures";
import { waitForAppReady } from "./readiness";

// Regression test for #99 / PR #101: when the preferences panel is opened
// on a short or narrow viewport, it must sit flush beneath the navbar and
// stay inside the viewport (scrolling internally) instead of spilling down
// past the bottom edge or riding up over the navbar.

// Navbar height thresholds match the CSS in InlineStyles.tsx:
//   desktop (>767px width): 45px
//   mobile  (≤767px width): 50px
const DESKTOP_NAVBAR = 45;
const MOBILE_NAVBAR = 50;
// Headless Chromium reports env(safe-area-inset-*) as 0, which matches the
// fallback written into the CSS, so we don't need to mock notch insets.
const SAFE_AREA = 0;

async function openPrefPanel(page: import("@playwright/test").Page): Promise<void> {
  // #user-pref is a sibling of #nav-fulltext-search under Layout.tsx's
  // chrome; "preferences" readiness's `#nav-fulltext-search, #user-pref`
  // OR-selector with `.first()` can resolve on whichever attaches first in
  // DOM order, not necessarily #user-pref itself. Wait for the exact
  // element this function needs before touching it, rather than relying on
  // callers having used a readiness kind that happens to cover it.
  await page.locator("#user-pref").waitFor({ state: "attached", timeout: 15_000 });
  // Bypass the slideToggle() animation path and just reveal the panel. The
  // CSS under test is independent of how the panel was shown.
  await page.evaluate(() => {
    const panel = document.getElementById("user-pref");
    if (!panel) throw new Error("user-pref element not found in DOM");
    panel.style.display = "block";
  });
  // One frame for layout to settle after the display flip.
  await page.waitForFunction(() => {
    const el = document.getElementById("user-pref");
    return el !== null && el.offsetHeight > 0;
  });
}

test.describe("#user-pref panel fits the viewport below the navbar", () => {
  test("narrow mobile viewport: panel pinned 50px below top, max-height clamped, scrolls", async ({
    page,
  }) => {
    // iPhone SE-sized viewport — short enough that the panel would overflow
    // without max-height + overflow:auto.
    await page.setViewportSize({ width: 375, height: 568 });
    await page.goto("/%E8%90%8C");
    // openPrefPanel throws if #user-pref isn't in the DOM yet -- "shell"
    // (default) only waits for `body` visible, which races Layout.tsx's
    // chrome mount. "preferences" explicitly waits for #user-pref attached.
    await waitForAppReady(page, "preferences");

    await openPrefPanel(page);

    const box = await page.locator("#user-pref").boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const computed = await page.locator("#user-pref").evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        position: cs.position,
        zIndex: Number(cs.zIndex),
        overflowY: cs.overflowY,
        top: cs.top,
        maxHeightPx: Math.round(parseFloat(cs.maxHeight) || 0),
      };
    });

    expect(computed.position).toBe("fixed");
    expect(computed.zIndex).toBeGreaterThanOrEqual(1050);
    expect(["auto", "scroll"]).toContain(computed.overflowY);

    // Top edge sits at navbar height + safe-area-inset-top.
    expect(box.y).toBe(MOBILE_NAVBAR + SAFE_AREA);
    // Bottom edge never exceeds the viewport height.
    expect(box.y + box.height).toBeLessThanOrEqual(568);
    // max-height leaves room for the navbar above and safe-area-bottom below.
    expect(computed.maxHeightPx).toBe(568 - MOBILE_NAVBAR - SAFE_AREA * 2);
  });

  test("desktop viewport: panel pinned 45px below top", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/%E8%90%8C");
    // Same #user-pref mount race as the sibling test above.
    await waitForAppReady(page, "preferences");

    await openPrefPanel(page);

    const box = await page.locator("#user-pref").boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const computed = await page.locator("#user-pref").evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return { position: cs.position, maxHeightPx: Math.round(parseFloat(cs.maxHeight) || 0) };
    });
    expect(computed.position).toBe("fixed");
    expect(box.y).toBe(DESKTOP_NAVBAR + SAFE_AREA);
    expect(computed.maxHeightPx).toBe(768 - DESKTOP_NAVBAR - SAFE_AREA * 2);
  });
});
