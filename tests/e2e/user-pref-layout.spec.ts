import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';

// Regression coverage for the Material 3 redesign: #user-pref is now a real
// <m3e-dialog> (modal, centered, scrim-backed) instead of the legacy fixed
// panel pinned 45/50px beneath the navbar (the shape asserted by the old
// version of this spec, from #99 / PR #101). The dialog manages its own
// responsive sizing/scrolling internally, so instead of asserting an exact
// pinned offset we assert the modal actually opens, never spills outside
// the viewport on constrained screens, and is dismissible.

async function openPrefPanel(page: Page): Promise<void> {
  const gearButton = page.getByRole('button', { name: '偏好設定' });
  await gearButton.click();
  await page.waitForFunction(() => {
    const el = document.getElementById('user-pref');
    return el !== null && el.hasAttribute('open');
  });
}

test.describe('#user-pref settings dialog', () => {
  test('narrow mobile viewport: dialog opens and stays within the viewport', async ({ page }) => {
    // iPhone SE-sized viewport — short enough that the dialog would overflow
    // without its own internal max-height + scroll handling.
    await page.setViewportSize({ width: 375, height: 568 });
    await page.goto('/%E8%90%8C');
    await page.waitForLoadState('networkidle');

    await openPrefPanel(page);

    const dialog = page.locator('#user-pref');
    await expect(dialog).toBeVisible();

    // The <m3e-dialog> host is `display: contents` (it renders no box of
    // its own); the actual visual surface is the internal native <dialog>
    // in its shadow root, exposed to Playwright via its implicit role.
    const surface = page.getByRole('dialog');
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(box.y + box.height).toBeLessThanOrEqual(568);
  });

  test('desktop viewport: dialog opens and stays within the viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/%E8%90%8C');
    await page.waitForLoadState('networkidle');

    await openPrefPanel(page);

    const dialog = page.locator('#user-pref');
    await expect(dialog).toBeVisible();

    const surface = page.getByRole('dialog');
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1024);
    expect(box.y + box.height).toBeLessThanOrEqual(768);
  });

  test('dismissible: Escape key closes the dialog', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/%E8%90%8C');
    await page.waitForLoadState('networkidle');

    await openPrefPanel(page);
    await expect(page.locator('#user-pref')).toBeVisible();

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => {
      const el = document.getElementById('user-pref');
      return el !== null && !el.hasAttribute('open');
    });
  });

  test('dismissible: built-in close button closes the dialog', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/%E8%90%8C');
    await page.waitForLoadState('networkidle');

    await openPrefPanel(page);

    // m3e-dialog's `dismissible` close affordance lives in its shadow DOM;
    // Playwright pierces shadow roots for role-based locators by default.
    await page.getByRole('button', { name: /close/i }).click();
    await page.waitForFunction(() => {
      const el = document.getElementById('user-pref');
      return el !== null && !el.hasAttribute('open');
    });
  });
});
