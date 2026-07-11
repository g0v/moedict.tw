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

test('desktop nested submenu keeps ancestor hover bridge on its own trigger row', async ({ page }) => {
  // Lang `a` nests DropdownSubmenu 2+ levels (…分類索引 → 外來語 → leaves).
  // The relative/absolute bridge must stay row-scoped per open trigger, not
  // bleed across nesting levels.
  await page.goto('/%E8%90%8C');

  await page.locator('nav .navbar-nav > li').first().locator('a').first().click();
  const categoryIndex = page.locator('a.taxonomy.a', { hasText: '…分類索引' });
  const nestedCategory = page.locator('a.taxonomy.a', { hasText: '外來語' });
  const nestedLeaf = page.locator('a.lang-option.a[href="/=\u97f3\u8b6f"]');

  await categoryIndex.hover();
  await expect(nestedCategory).toBeVisible();
  await nestedCategory.hover();
  await expect(nestedLeaf).toBeVisible();

  // With both levels open, each open trigger's ::before bridge must cover only
  // that trigger's own row (ancestor vs nested are vertically offset).
  const geometry = await page.evaluate(() => {
    const ancestorTrigger = Array.from(document.querySelectorAll('a.taxonomy.a')).find(
      (el) => (el.textContent ?? '').trim() === '…分類索引',
    );
    const nestedTrigger = Array.from(document.querySelectorAll('a.taxonomy.a')).find(
      (el) => (el.textContent ?? '').trim() === '外來語',
    );
    if (!(ancestorTrigger instanceof HTMLElement) || !(nestedTrigger instanceof HTMLElement)) {
      return null;
    }

    const ancestorLi = ancestorTrigger.closest('li');
    const nestedLi = nestedTrigger.closest('li');
    if (!(ancestorLi instanceof HTMLElement) || !(nestedLi instanceof HTMLElement)) {
      return null;
    }

    const bridgeRect = (li: HTMLElement) => {
      const box = li.getBoundingClientRect();
      const style = getComputedStyle(li, '::before');
      const topOffset = parseFloat(style.top);
      const bottomOffset = parseFloat(style.bottom);
      const leftOffset = parseFloat(style.left);
      const width = parseFloat(style.width);
      if (![topOffset, bottomOffset, leftOffset, width].every(Number.isFinite)) {
        return null;
      }
      // Reconstruct the absolute bridge box from the relatively-positioned trigger
      // and the absolute ::before offsets (top/bottom/left/width).
      return {
        top: box.top + topOffset,
        bottom: box.bottom - bottomOffset,
        left: box.left + leftOffset,
        width,
        position: style.position,
        content: style.content,
      };
    };

    const ancestorBox = ancestorLi.getBoundingClientRect();
    const nestedBox = nestedLi.getBoundingClientRect();
    const ancestorBridge = bridgeRect(ancestorLi);
    const nestedBridge = bridgeRect(nestedLi);
    if (!ancestorBridge || !nestedBridge) {
      return null;
    }

    return {
      ancestorTop: ancestorBox.top,
      ancestorBottom: ancestorBox.bottom,
      ancestorRight: ancestorBox.right,
      nestedTop: nestedBox.top,
      nestedBottom: nestedBox.bottom,
      nestedRight: nestedBox.right,
      ancestorBridgeTop: ancestorBridge.top,
      ancestorBridgeBottom: ancestorBridge.bottom,
      ancestorBridgeLeft: ancestorBridge.left,
      ancestorBridgeWidth: ancestorBridge.width,
      ancestorBridgePosition: ancestorBridge.position,
      ancestorBridgeContent: ancestorBridge.content,
      nestedBridgeTop: nestedBridge.top,
      nestedBridgeBottom: nestedBridge.bottom,
      nestedBridgeLeft: nestedBridge.left,
      nestedBridgeWidth: nestedBridge.width,
      nestedBridgePosition: nestedBridge.position,
      nestedBridgeContent: nestedBridge.content,
    };
  });

  expect(geometry).not.toBeNull();

  // Nested row is vertically offset from the ancestor row while both are open.
  expect(Math.abs(geometry!.nestedTop - geometry!.ancestorTop)).toBeGreaterThan(8);

  // Bridge is a real absolute pseudo-element on each open trigger row.
  expect(geometry!.ancestorBridgePosition).toBe('absolute');
  expect(geometry!.nestedBridgePosition).toBe('absolute');
  expect(geometry!.ancestorBridgeContent).not.toBe('none');
  expect(geometry!.nestedBridgeContent).not.toBe('none');
  expect(geometry!.ancestorBridgeWidth).toBeGreaterThan(0);
  expect(geometry!.nestedBridgeWidth).toBeGreaterThan(0);

  // Each bridge spans exactly its own trigger row, not the other level's row.
  expect(Math.abs(geometry!.ancestorBridgeTop - geometry!.ancestorTop)).toBeLessThan(2);
  expect(Math.abs(geometry!.ancestorBridgeBottom - geometry!.ancestorBottom)).toBeLessThan(2);
  expect(Math.abs(geometry!.nestedBridgeTop - geometry!.nestedTop)).toBeLessThan(2);
  expect(Math.abs(geometry!.nestedBridgeBottom - geometry!.nestedBottom)).toBeLessThan(2);
  expect(Math.abs(geometry!.ancestorBridgeTop - geometry!.nestedTop)).toBeGreaterThan(8);
  expect(Math.abs(geometry!.nestedBridgeTop - geometry!.ancestorTop)).toBeGreaterThan(8);
  // Bridge sits just past the trigger's right edge (left: 100%).
  expect(Math.abs(geometry!.ancestorBridgeLeft - geometry!.ancestorRight)).toBeLessThan(2);
  expect(Math.abs(geometry!.nestedBridgeLeft - geometry!.nestedRight)).toBeLessThan(2);

  // Slow-move across the ancestor-level gap at the ancestor row height must keep
  // the first-level submenu open (bridge still covers that path).
  const midY = (geometry!.ancestorTop + geometry!.ancestorBottom) / 2;
  await page.mouse.move(geometry!.ancestorRight - 2, midY);
  await page.mouse.move(geometry!.ancestorRight + 4, midY, { steps: 12 });
  await expect(nestedCategory).toBeVisible();
});
