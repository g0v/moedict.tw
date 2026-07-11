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

  // Stay on the trigger row while crossing the gap, then step inside the submenu.
  await page.mouse.move(source!.x + source!.width - 2, source!.y + source!.height / 2);
  await page.mouse.move(destination!.x + 2, source!.y + source!.height / 2, { steps: 15 });
  await page.mouse.move(destination!.x + 2, destination!.y + destination!.height / 2, { steps: 15 });

  await expect(target).toBeVisible();
  await target.click();
  await expect(page).toHaveURL(/~=%E5%90%8C%E5%AF%A6%E7%95%B0%E5%90%8D/);
});

test('desktop hover bridge does not intercept adjacent sibling category items', async ({ page }) => {
  await page.goto('/~%E8%90%8C');

  await page.locator('nav .navbar-nav > li').first().locator('a').first().click();
  const categoryIndex = page.locator('a.taxonomy.c', { hasText: '…分類索引' });
  // Language sibling above the open Cross-Strait 分類索引 row.
  const sibling = page.locator('a.lang-option.c[href="/~"]', { hasText: '兩岸詞典' });
  const submenuTarget = page.locator('a.lang-option.c[href="/~=同實異名"]');

  await categoryIndex.hover();
  await expect(submenuTarget).toBeVisible();

  const siblingBox = await sibling.boundingBox();
  expect(siblingBox).not.toBeNull();

  // Probe the sibling's right-edge path that a full-height bridge would cover.
  const probeX = siblingBox!.x + siblingBox!.width - 2;
  const probeY = siblingBox!.y + siblingBox!.height / 2;
  const hit = await page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!(el instanceof Element)) return null;
      const anchor = el.closest('a');
      return {
        tag: el.tagName,
        href: anchor?.getAttribute('href') ?? null,
        text: (anchor?.textContent ?? el.textContent ?? '').trim(),
      };
    },
    { x: probeX, y: probeY },
  );

  expect(hit).not.toBeNull();
  expect(hit?.href).toBe('/~');
  expect(hit?.text).toContain('兩岸詞典');

  await page.mouse.move(probeX, probeY);
  await expect(submenuTarget).toBeHidden();
});
