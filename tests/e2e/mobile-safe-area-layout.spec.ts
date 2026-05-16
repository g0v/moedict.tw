import { expect, test } from './_fixtures';

test.describe('mobile safe-area layout', () => {
  test('dictionary heading sits below the fixed mobile search box on notched screens', async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto('/%E8%90%8C');
    await page.waitForLoadState('networkidle');

    await page.evaluate(() => {
      document.documentElement.style.setProperty('--moe-safe-area-top', '59px');
    });

    const boxes = await page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`${selector} not found`);
        const { y, height } = element.getBoundingClientRect();
        return { y, height };
      };

      return {
        queryBox: rect('#query-box'),
        heading: rect('h1.title'),
        mainMarginTop: window.getComputedStyle(document.querySelector('#main-content')!).marginTop,
      };
    });

    expect(boxes.mainMarginTop).toBe('179px');
    expect(boxes.heading.y).toBeGreaterThanOrEqual(boxes.queryBox.y + boxes.queryBox.height);
  });
});
