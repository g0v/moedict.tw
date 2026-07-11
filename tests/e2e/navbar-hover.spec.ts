import { expect, test } from './_fixtures';

test('desktop pointer crosses from 分類索引 to 同實異名 without closing the submenu', async ({ page }) => {
  await page.goto('/~%E8%90%8C');

  await page.locator('nav .navbar-nav > li').first().locator('a').first().click();
  const categoryIndex = page.locator('a.taxonomy.c', { hasText: '…分類索引' });
  const target = page.locator('a.lang-option.c[href="/~=同實異名"]');

  await categoryIndex.hover();
  await expect(target).toBeVisible();

  const source = await categoryIndex.boundingBox();
  const destination = await target.boundingBox();
  expect(source).not.toBeNull();
  expect(destination).not.toBeNull();

  await page.mouse.move(source!.x + source!.width - 2, destination!.y + destination!.height / 2);
  await page.mouse.move(destination!.x + 2, destination!.y + destination!.height / 2, { steps: 15 });

  await expect(target).toBeVisible();
  await target.click();
  await expect(page).toHaveURL(/~=%E5%90%8C%E5%AF%A6%E7%95%B0%E5%90%8D/);
});
