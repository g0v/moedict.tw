import { expect, test } from './_fixtures';

test.describe('cross-strait comparison category', () => {
  test('renders Taiwan and Mainland terms as separate table links', async ({ page }) => {
    await page.goto('/~=%E5%90%8C%E5%AF%A6%E7%95%B0%E5%90%8D');
    const table = page.getByRole('table', { name: '臺灣及大陸用語對照' });

    await expect(table).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /臺灣用語/ })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /大陸用語/ })).toBeVisible();
    await expect(table.getByRole('link', { name: '三角皮帶', exact: true })).toHaveAttribute('href', '/~三角皮帶');
    await expect(table.getByRole('link', { name: '三角帶', exact: true })).toHaveAttribute('href', '/~三角帶');
  });

  test('fits the comparison table inside a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/~=%E5%90%8C%E5%AF%A6%E7%95%B0%E5%90%8D');
    const table = page.getByRole('table', { name: '臺灣及大陸用語對照' });

    await expect(table).toBeVisible();
    const overflows = await table.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < 0 || rect.right > document.documentElement.clientWidth;
    });
    expect(overflows).toBe(false);
  });
});
