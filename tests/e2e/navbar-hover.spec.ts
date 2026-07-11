import { expect, test } from './_fixtures';

test('desktop pointer crosses from 分類索引 to 同實異名 without closing the submenu', async ({ page }) => {
  await page.goto('/~%E8%90%8C');

  await page.locator('.navbar-nav > li').first().locator('a').first().click();
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

test('desktop dropdown geometry stays intrinsic and inside the viewport', async ({ page }) => {
  await page.goto('/~%E8%90%8C');
  const trigger = page.locator('.navbar-nav > li').first().locator('a').first();
  await trigger.click();
  const categoryIndex = page.locator('a.taxonomy.c', { hasText: '…分類索引' });
  await categoryIndex.hover();

  const geometry = await page.evaluate(() => {
    const visible = [...document.querySelectorAll('ul')].filter((el) => {
      const c = getComputedStyle(el);
      return (el.className as string).includes('dropdownMenu') && c.display !== 'none';
    });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      triggerBottom: document.querySelector('.navbar-nav > li > a')?.getBoundingClientRect().bottom ?? 0,
      menus: visible.map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width };
      }),
    };
  });

  expect(geometry.menus.length).toBeGreaterThan(0);
  expect(geometry.menus[0].width).toBeGreaterThan(120);
  expect(geometry.menus[0].width).toBeLessThan(400);
  expect(geometry.menus[0].top).toBeGreaterThanOrEqual(geometry.triggerBottom - 1);
  for (const menu of geometry.menus) {
    expect(menu.left).toBeGreaterThanOrEqual(0);
    expect(menu.top).toBeGreaterThanOrEqual(0);
    expect(menu.right).toBeLessThanOrEqual(geometry.viewport.width);
    expect(menu.bottom).toBeLessThanOrEqual(geometry.viewport.height);
  }
});

test('mobile dropdown opens below trigger and stays inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto('/~%E8%90%8C');
  const trigger = page.locator('.navbar-nav > li').first().locator('a').first();
  await trigger.click();

  const geometry = await page.evaluate(() => {
    const trigger = document.querySelector('.navbar-nav > li > a');
    const root = [...document.querySelectorAll('ul')].find((el) => {
      const c = getComputedStyle(el);
      return (el.className as string).includes('dropdownMenuRoot') && c.display !== 'none';
    });
    if (!trigger || !root) throw new Error('mobile menu geometry not found');
    const t = trigger.getBoundingClientRect();
    const r = root.getBoundingClientRect();
    return { triggerBottom: t.bottom, top: r.top, left: r.left, right: r.right, bottom: r.bottom };
  });

  expect(geometry.top).toBeGreaterThanOrEqual(geometry.triggerBottom - 1);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(393);
  expect(geometry.bottom).toBeLessThanOrEqual(852);
});
