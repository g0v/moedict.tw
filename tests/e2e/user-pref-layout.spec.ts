import { expect, test } from "./_fixtures";

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
    await page.waitForLoadState("networkidle");

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
    await page.waitForLoadState("networkidle");

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
