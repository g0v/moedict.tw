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
  // A shared document-wide anchor-name collides once both levels are open.
  await page.goto('/%E8%90%8C');

  await page.locator('nav .navbar-nav > li').first().locator('a').first().click();
  const categoryIndex = page.locator('a.taxonomy.a', { hasText: '…分類索引' });
  const nestedCategory = page.locator('a.taxonomy.a', { hasText: '外來語' });
  const nestedLeaf = page.locator('a.lang-option.a[href="/=\u97f3\u8b6f"]');

  await categoryIndex.hover();
  await expect(nestedCategory).toBeVisible();
  await nestedCategory.hover();
  await expect(nestedLeaf).toBeVisible();

  // With both levels open, each trigger must carry a distinct anchor-name and
  // each level's ::before must stay row-scoped to its own trigger (not rebound
  // to a descendant via a shared document-wide name).
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
    const ancestorSubmenu = ancestorLi?.querySelector(':scope > ul');
    const nestedSubmenu = nestedLi?.querySelector(':scope > ul');
    if (!(ancestorSubmenu instanceof HTMLElement) || !(nestedSubmenu instanceof HTMLElement)) {
      return null;
    }

    const ancestorBox = ancestorTrigger.getBoundingClientRect();
    const nestedBox = nestedTrigger.getBoundingClientRect();
    const ancestorBridge = getComputedStyle(ancestorSubmenu, '::before');
    const nestedBridge = getComputedStyle(nestedSubmenu, '::before');
    const ancestorTriggerStyle = getComputedStyle(ancestorTrigger);
    const nestedTriggerStyle = getComputedStyle(nestedTrigger);
    const vh = window.innerHeight;

    const bridgeBottomY = (style: CSSStyleDeclaration) => {
      const bottomCss = parseFloat(style.bottom);
      return Number.isFinite(bottomCss) ? vh - bottomCss : NaN;
    };

    return {
      ancestorTop: ancestorBox.top,
      ancestorBottom: ancestorBox.bottom,
      ancestorRight: ancestorBox.right,
      nestedTop: nestedBox.top,
      nestedBottom: nestedBox.bottom,
      ancestorAnchorName: ancestorTriggerStyle.getPropertyValue('anchor-name').trim(),
      nestedAnchorName: nestedTriggerStyle.getPropertyValue('anchor-name').trim(),
      ancestorPositionAnchor: ancestorBridge.getPropertyValue('position-anchor').trim(),
      nestedPositionAnchor: nestedBridge.getPropertyValue('position-anchor').trim(),
      ancestorBridgeTop: parseFloat(ancestorBridge.top),
      ancestorBridgeBottomY: bridgeBottomY(ancestorBridge),
      ancestorBridgeLeft: parseFloat(ancestorBridge.left),
      ancestorBridgeWidth: parseFloat(ancestorBridge.width),
      nestedBridgeTop: parseFloat(nestedBridge.top),
      nestedBridgeBottomY: bridgeBottomY(nestedBridge),
      nestedBridgeWidth: parseFloat(nestedBridge.width),
    };
  });

  expect(geometry).not.toBeNull();

  // Nested row is vertically offset from the ancestor row while both are open.
  expect(Math.abs(geometry!.nestedTop - geometry!.ancestorTop)).toBeGreaterThan(8);

  // Root cause of the multi-level regression: a single shared anchor-name cannot
  // pair each open level to its own trigger. Each open level must use a unique name.
  expect(geometry!.ancestorAnchorName).not.toBe('');
  expect(geometry!.ancestorAnchorName).not.toBe('none');
  expect(geometry!.nestedAnchorName).not.toBe('');
  expect(geometry!.nestedAnchorName).not.toBe('none');
  expect(geometry!.ancestorAnchorName).not.toBe(geometry!.nestedAnchorName);
  expect(geometry!.ancestorPositionAnchor).toBe(geometry!.ancestorAnchorName);
  expect(geometry!.nestedPositionAnchor).toBe(geometry!.nestedAnchorName);

  // Each bridge stays row-scoped to its own trigger.
  expect(geometry!.ancestorBridgeWidth).toBeGreaterThan(0);
  expect(geometry!.nestedBridgeWidth).toBeGreaterThan(0);
  expect(Math.abs(geometry!.ancestorBridgeTop - geometry!.ancestorTop)).toBeLessThan(2);
  expect(Math.abs(geometry!.ancestorBridgeBottomY - geometry!.ancestorBottom)).toBeLessThan(2);
  expect(Math.abs(geometry!.nestedBridgeTop - geometry!.nestedTop)).toBeLessThan(2);
  expect(Math.abs(geometry!.nestedBridgeBottomY - geometry!.nestedBottom)).toBeLessThan(2);
  expect(Math.abs(geometry!.ancestorBridgeTop - geometry!.nestedTop)).toBeGreaterThan(8);

  // Slow-move across the ancestor-level gap at the ancestor row height must keep
  // the first-level submenu open (bridge still covers that path).
  const midY = (geometry!.ancestorTop + geometry!.ancestorBottom) / 2;
  await page.mouse.move(geometry!.ancestorRight - 2, midY);
  await page.mouse.move(geometry!.ancestorRight + 4, midY, { steps: 12 });
  await expect(nestedCategory).toBeVisible();
});
