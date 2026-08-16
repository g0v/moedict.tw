import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Route } from "@playwright/test";
import { expect, test } from "./_fixtures";
import { waitForAppReady } from "./readiness";

const ANDROID_WEBVIEW_UA =
  "Mozilla/5.0 (Linux; Android 15; sdk_gphone64_arm64) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36";

const MANDARIN_VERTICAL_ZHUYIN_SAMPLES = [
  { path: "/%E8%90%8C", title: "萌" },
  { path: "/%E6%95%96", title: "敖" },
  { path: "/%E9%BB%83", title: "黃" }, // length=3 ㄏㄨㄤˊ; tone-node geometry regression target
];
const TAIGI_TITLE_CANDIDATES = [
  { path: "/'%E9%A3%9F", title: "食" },
  { path: "/'%E7%AE%A1%E7%90%86", title: "管理" },
  { path: "/'%E6%84%8F%E6%84%9B", title: "意愛" },
];

async function waitForEntryHydration(page: Page, titleFragment: string): Promise<void> {
  // DictionaryPage renders long-form definition text after /api/{word}.json resolves.
  // Wait for either definition text OR the "全文檢索" header (which always renders)
  // and then assert the body contains the word title.
  await waitForAppReady(page, "dictionary");
  await expect(page.locator("body")).toContainText(titleFragment, { timeout: 15_000 });
}

interface TitleZhuyinMetrics {
  bopomofo: string;
  vowelCenter: number;
  diaoCenter: number;
  vowelLeft: number;
  diaoLeft: number;
}

async function measureTitleZhuyin(page: Page, annotation: string): Promise<TitleZhuyinMetrics> {
  return page.evaluate((targetAnnotation) => {
    const annotationRuby = Array.from(document.querySelectorAll("h1.title ru[annotation]")).find(
      (ruby) =>
        ruby.getAttribute("annotation") === targetAnnotation ||
        ruby.querySelector(":scope > .romanization-selectable")?.textContent === targetAnnotation,
    );
    const zhuyin = annotationRuby?.querySelector("ru[zhuyin]");
    const yin = zhuyin?.querySelector("yin");
    const diao = zhuyin?.querySelector("diao");
    const yinText = yin?.firstChild;
    const diaoText = diao?.firstChild;
    if (!(yinText instanceof Text) || !(diaoText instanceof Text)) {
      throw new Error(`${targetAnnotation} title zhuyin text nodes not found`);
    }

    const charRect = (text: Text, index: number): DOMRect => {
      const range = document.createRange();
      range.setStart(text, index);
      range.setEnd(text, index + 1);
      return range.getBoundingClientRect();
    };

    const vowelRect = charRect(yinText, yinText.data.length - 1);
    const diaoRect = charRect(diaoText, 0);
    return {
      bopomofo: `${yinText.data}${diaoText.data}`,
      vowelCenter: vowelRect.top + vowelRect.height / 2,
      diaoCenter: diaoRect.top + diaoRect.height / 2,
      vowelLeft: vowelRect.left,
      diaoLeft: diaoRect.left,
    };
  }, annotation);
}

async function gotoFirstTitleEntry(
  page: Page,
  candidates: Array<{ path: string; title: string }>,
): Promise<{ path: string; title: string }> {
  for (const candidate of candidates) {
    const response = await page.goto(candidate.path);
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "dictionary");
    await page.evaluate(() => document.fonts.ready);
    if ((await page.locator("h1.title").count()) > 0) {
      return candidate;
    }
  }
  throw new Error("No candidate rendered dictionary title");
}

test.describe("dictionary pages per language", () => {
  test("萌 (a) — default 萌典", async ({ page }) => {
    const response = await page.goto("/%E8%90%8C");
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/萌/);
    await waitForEntryHydration(page, "萌");
    const body = await page.locator("body").innerText();
    expect(body.length).toBeGreaterThan(100); // definition text loaded
  });

  test("star action toggles persistence with Enter and Space", async ({ page }) => {
    await page.goto("/%E8%90%8C");
    await waitForEntryHydration(page, "萌");
    const star = page.locator(".entry-actions .star");
    await star.focus();
    await expect(star).toHaveAttribute("aria-label", "加入字詞記錄簿");
    await page.keyboard.press("Enter");
    await expect(star).toHaveAttribute("aria-label", "已加入記錄簿");
    expect(await page.evaluate(() => localStorage.getItem("starred-a"))).toContain("萌");
    await page.keyboard.press(" ");
    await expect(star).toHaveAttribute("aria-label", "加入字詞記錄簿");
    expect(await page.evaluate(() => localStorage.getItem("starred-a"))).not.toContain("萌");
  });

  test("star state follows a second page StorageEvent without reload", async ({
    page,
    context,
  }) => {
    await page.goto("/%E8%90%8C");
    await waitForEntryHydration(page, "萌");
    const otherPage = await context.newPage();
    await otherPage.goto("/%E8%90%8C");
    await waitForEntryHydration(otherPage, "萌");
    const star = page.locator(".entry-actions .star");
    await expect(star).toHaveAttribute("aria-pressed", "false");
    await otherPage.locator(".entry-actions .star").click();
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await otherPage.close();
  });

  test("'食 (t) — 台語萌典", async ({ page }) => {
    const response = await page.goto("/'%E9%A3%9F");
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "食");
  });
  test.describe("g0v/moedict-webkit#301", () => {
    test.use({ viewport: { width: 545, height: 316 } });

    test("Taigi lop checked final aligns with the vowel in title zhuyin", async ({ page }) => {
      const response = await page.goto("/'%E6%A9%90");
      expect(response?.status()).toBe(200);
      await waitForEntryHydration(page, "橐");
      await page.addStyleTag({ path: "data/assets/styles.css" });

      const metrics = await measureTitleZhuyin(page, "lop");

      expect(metrics.bopomofo).toBe("ㄌㆦㆴ");
      expect(Math.abs(metrics.diaoCenter - metrics.vowelCenter)).toBeLessThan(3);
    });

    test("Taigi it checked final aligns in both ruby layouts", async ({ page }) => {
      const response = await page.goto("/'%E4%B8%80");
      expect(response?.status()).toBe(200);
      await waitForEntryHydration(page, "一");
      await page.addStyleTag({ path: "data/assets/styles.css" });

      const metrics = await measureTitleZhuyin(page, "it");
      expect(metrics.bopomofo).toBe("ㄧㆵ");
      expect(Math.abs(metrics.diaoCenter - metrics.vowelCenter)).toBeLessThan(1);
    });

    test("Taigi it checked final aligns in zhuyin-only layout", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("phonetics", "bopomofo"));
      const response = await page.goto("/'%E4%B8%80");
      expect(response?.status()).toBe(200);
      await waitForEntryHydration(page, "一");
      await page.addStyleTag({ path: "data/assets/styles.css" });

      const metrics = await measureTitleZhuyin(page, "it");
      expect(metrics.bopomofo).toBe("ㄧㆵ");
      expect(Math.abs(metrics.diaoCenter - metrics.vowelCenter)).toBeLessThan(1);
    });

    test("Taigi tsia̍h length-3 checked final aligns with the last zhuyin symbol", async ({
      page,
    }) => {
      const response = await page.goto("/'%E9%A3%9F");
      expect(response?.status()).toBe(200);
      await waitForEntryHydration(page, "食");
      await page.addStyleTag({ path: "data/assets/styles.css" });

      const metrics = await measureTitleZhuyin(page, "tsia̍h");
      expect(metrics.bopomofo).toBe("ㄐㄧㄚㆷ̇");
      expect(Math.abs(metrics.diaoCenter - metrics.vowelCenter)).toBeLessThan(1);
      expect(metrics.diaoLeft).toBeGreaterThan(metrics.vowelLeft);
    });

    test("Taigi tsia̍h length-3 checked final aligns in zhuyin-only layout", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("phonetics", "bopomofo"));
      const response = await page.goto("/'%E9%A3%9F");
      expect(response?.status()).toBe(200);
      await waitForEntryHydration(page, "食");
      await page.addStyleTag({ path: "data/assets/styles.css" });

      const metrics = await measureTitleZhuyin(page, "tsia̍h");
      expect(metrics.bopomofo).toBe("ㄐㄧㄚㆷ̇");
      expect(Math.abs(metrics.diaoCenter - metrics.vowelCenter)).toBeLessThan(1);
      expect(metrics.diaoLeft).toBeGreaterThan(metrics.vowelLeft);
    });

    test("Mandarin length-2 tone mark keeps its raised position", async ({ page }) => {
      const response = await page.goto("/%E8%90%8C");
      expect(response?.status()).toBe(200);
      await waitForEntryHydration(page, "萌");
      await page.addStyleTag({ path: "data/assets/styles.css" });

      const metrics = await measureTitleZhuyin(page, "méng");
      expect(metrics.bopomofo).toBe("ㄇㄥˊ");
      expect(metrics.diaoCenter).toBeLessThan(metrics.vowelCenter - 5);
    });

    test("Mandarin length-1 tone mark keeps its zhuyin-only position", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("phonetics", "bopomofo"));
      const response = await page.goto("/%E8%80%8C");
      expect(response?.status()).toBe(200);
      await waitForEntryHydration(page, "而");
      await page.addStyleTag({ path: "data/assets/styles.css" });

      const metrics = await measureTitleZhuyin(page, "ér");
      expect(metrics.bopomofo).toBe("ㄦˊ");
      expect(Math.abs(metrics.diaoCenter - metrics.vowelCenter)).toBeLessThan(3);
    });
  });

  test("'蛇 (t) — reading-only siâ is labeled and has no broken audio control", async ({
    page,
  }) => {
    const response = await page.goto("/'%E8%9B%87");
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "蛇");

    const readingOnlyEntry = page.locator('.entry:has(.reading-type[aria-label^="文讀音"])');
    await expect(readingOnlyEntry).toHaveCount(1);
    await expect(readingOnlyEntry.locator(".reading-type")).toHaveText("文");
    await expect(readingOnlyEntry.locator(".reading-only-note")).toHaveText("本音讀無義項。");
    await expect(readingOnlyEntry.locator(".audioBlock")).toHaveCount(0);

    // 蛇 has TWO heteronyms: 白讀 tsuâ has a real definition, 文讀 siâ is
    // reading-only. hasEntryDefinitions is true for the word overall (at
    // least one heteronym has definitions), so the shared action row shows
    // copy + variants-link + star (single-char) as usual. .entry-copy-status
    // is the FIRST child (see the right-edge-alignment guard test below) so
    // its min-width reservation sits left of the visible icons, not right.
    await expect(page.locator(".entry-actions .star")).toHaveCount(1);
    await expect(page.locator(".entry-actions a.variants-link")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "複製解釋" })).toHaveCount(1);
    await expect(page.locator(".entry-actions").locator(":scope > :nth-child(1)")).toHaveClass(
      /entry-copy-status/,
    );
    await expect(page.locator(".entry-actions").locator(":scope > :nth-child(2)")).toHaveClass(
      /entry-copy-button/,
    );
    await expect(page.locator(".entry-actions").locator(":scope > :nth-child(3)")).toHaveClass(
      /variants-link/,
    );
    await expect(page.locator(".entry-actions .star")).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".entry-actions .entry-copy-status")).toHaveAttribute(
      "aria-atomic",
      "true",
    );
    await expect(
      page.locator(".entry-actions").locator(":scope > :nth-child(2) svg"),
    ).toHaveAttribute("aria-hidden", "true");
  });

  test("'長褲 (t) — pinned no-definition entry renders 本音讀無義項 without a reading badge (g0v/moedict-webkit#271)", async ({
    page,
  }) => {
    const response = await page.goto("/'%E9%95%B7%E8%A4%B2");
    expect(response?.status()).toBe(200);
    await page.locator("h1.title").waitFor({ state: "visible", timeout: 15_000 });
    const titleCharacters = page.locator("h1.title a");
    await expect(titleCharacters).toHaveCount(2);
    await expect(titleCharacters).toHaveText(["長", "褲"]);
    const romanization = page.locator("h1.title .romanization-selectable");
    await expect(romanization).toHaveCount(1);
    await expect
      .poll(async () =>
        (await romanization.allTextContents())
          .join("")
          .replace(/\u2011/g, "-")
          .normalize("NFC"),
      )
      .toBe("tn̂g-khòo");

    const entry = page.locator(".entry");
    await expect(entry).toHaveCount(1);
    await expect(entry.locator(".reading-only-note")).toHaveText("本音讀無義項。");
    await expect(entry.locator(".reading-type")).toHaveCount(0);
    await expect(entry.locator(".audioBlock")).toHaveCount(0);

    // 長褲 is a genuinely no-definition pinned entry (single heteronym,
    // reading-only) — the action row still reserves the copy-status region,
    // while no copy button or variants link is rendered for this 2-char title.
    await expect(page.locator(".entry-actions .star")).toHaveCount(1);
    await expect(page.locator(".entry-actions a.variants-link")).toHaveCount(0);
    await expect(page.locator(".entry-actions .entry-copy-button")).toHaveCount(0);
    await expect(page.locator(".entry-copy-status")).toHaveCount(1);
    await expect(page.locator(".entry-copy-status")).toHaveText("\u00a0");
  });

  test(":字 (h) — 客語萌典", async ({ page }) => {
    const response = await page.goto("/%3A%E5%AD%97");
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "字");

    // 字 has multi-dialect Hakka readings (四/海/大/平/安/南) rendered in
    // .bopomofo, each a "<dialect-label><romanization>" pair (e.g.
    // "四sii⁵⁵") — this whole pronunciation block must never leak into the
    // 複製解釋 payload; only the actual definition text should. Romanized
    // reading text (Latin letters) is used as the negative signal rather
    // than the single-Han-character dialect labels alone, since a bare
    // 四/海/大/南 could coincidentally appear inside real Chinese prose.
    const readingTexts = await page.locator(".bopomofo .pinyin > span").allInnerTexts();
    expect(readingTexts.length).toBeGreaterThan(0);
    const defText = (await page.locator(".entry .definition .def").first().innerText()).trim();
    expect(defText.length).toBeGreaterThan(0);

    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) =>
            ((window as Window & { __copied?: string }).__copied = value),
        },
      });
    });
    await page.getByRole("button", { name: "複製解釋" }).click();
    await expect(page.locator(".entry-copy-status")).toHaveText("已複製");
    const copied = await page.evaluate(
      () => (window as Window & { __copied?: string }).__copied ?? "",
    );
    expect(copied).toContain(defText);
    for (const readingText of readingTexts) {
      expect(copied).not.toContain(readingText.trim());
    }
  });

  test("~上訴 (c) — 兩岸萌典", async ({ page }) => {
    const response = await page.goto("/~%E4%B8%8A%E8%A8%B4");
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "上訴");
  });
  test("'食 copy excludes duplicate romanization-selectable overlay text", async ({ page }) => {
    await page.goto("/'%E9%A3%9F");
    await waitForEntryHydration(page, "食");
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) =>
            ((window as Window & { __copied?: string }).__copied = value),
        },
      });
    });
    const overlays = await page.locator(".entry-item .romanization-selectable").allInnerTexts();
    await expect(page.getByRole("button", { name: "複製解釋" })).toHaveCount(1);
    await page.getByRole("button", { name: "複製解釋" }).click();
    const copied = await page.evaluate(
      () => (window as Window & { __copied?: string }).__copied ?? "",
    );
    for (const overlay of overlays) {
      const value = overlay.trim();
      if (value)
        expect(
          copied.match(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length ?? 0,
        ).toBeLessThanOrEqual(1);
    }
  });
});

// g0v/moedict-webkit#186: 「讓台語萌典的主要拼音(注音)可選取複製」——標題主
// 讀音（羅馬拼音）過去只用 `ru[annotation]::before { content: attr(annotation) }`
// 畫出可見字形，CSS generated content 任何瀏覽器都無法選取/複製；真正可選取
// 的 `<span class="romanization-selectable">` 節點疊在可見字形的實際畫面座標
// 上，使用者在那個位置能選到正確、乾淨的 Unicode 文字（而不是畫面用的 PUA
// 連字字形），且觸發此動作不會被單字筆順動畫的 click handler 打斷。
// 改用 <span> 而非 <rt> 的原因：WebKit 的 layout engine 會把 <rt> 強制設為
// position:static，使 position:absolute !important 失效；<span> 則正確接受。
const LEGACY_RUBY_CSS = `
  hruby { display: inline; line-height: 2; }
  hruby ru { position: relative; display: inline-block; text-indent: 0; }
  hruby ru:before,
  hruby zhuyin {
    transform: scale(.55);
    font-style: normal;
    font-weight: 400;
    line-height: normal;
    text-indent: 0;
    position: absolute;
    display: inline-block;
  }
  hruby ru[annotation] { text-align: center; }
  hruby ru[annotation]:before {
    left: -265%;
    top: -.5em;
    height: 1em;
    width: 600%;
    content: attr(annotation);
    line-height: 1;
    text-align: center;
    text-indent: 0;
  }
  hruby[rightangle] ru[annotation]:before { left: -250%; }
  hruby ru[annotation] > .romanization-selectable {
    display: inline-block;
    height: 0;
    width: 0;
    font: 0/0 hidden-text;
  }
`;

async function routeLegacyStylesCss(page: Page): Promise<void> {
  const handler = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "text/css; charset=utf-8",
      headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: LEGACY_RUBY_CSS,
    });
  await page.route("https://r2-assets.test.local/styles.css", handler);
  await page.route("https://r2-assets.test.local/styles.css?*", handler);
}

test.describe("@romanization Taigi title pronunciation selection/copy (g0v/moedict-webkit#186)", () => {
  test("the visible romanization glyph position selects the real Unicode text, not the painted PUA ligature", async ({
    page,
  }) => {
    await routeLegacyStylesCss(page);
    const active = await gotoFirstTitleEntry(page, TAIGI_TITLE_CANDIDATES);
    await expect(page.locator("h1.title").first()).toContainText(active.title[0], {
      timeout: 8_000,
    });
    await page.evaluate(() => document.fonts.ready);

    const result = await page.evaluate(() => {
      const ru = document.querySelector("h1.title hruby.rightangle ru[annotation]");
      if (!ru) throw new Error("annotation ru not found");
      const span = ru.querySelector(":scope > .romanization-selectable");
      if (!span || !span.firstChild) throw new Error(".romanization-selectable span not found");

      const before = window.getComputedStyle(ru, "::before");
      const glyphRange = document.createRange();
      glyphRange.selectNodeContents(span.firstChild);
      const glyphRect = glyphRange.getClientRects()[0];
      if (!glyphRect) throw new Error("span has no rendered glyph rect");

      // The regression this guards against: overlay clipped to a 1x1px box
      // positioned away from the visible glyph (screen-reader-only pattern)
      // means no real mouse/touch action at the visible pinyin can ever
      // reach it.
      const spanBoxRect = span.getBoundingClientRect();

      const y = glyphRect.y + glyphRect.height / 2;
      const startCaret = document.caretRangeFromPoint(glyphRect.x + 1, y);
      const endCaret = document.caretRangeFromPoint(glyphRect.x + glyphRect.width - 1, y);
      const caretsInSpan =
        startCaret?.startContainer.parentElement === span &&
        endCaret?.startContainer.parentElement === span;

      let selectedText = "";
      if (startCaret && endCaret) {
        const selRange = document.createRange();
        selRange.setStart(startCaret.startContainer, startCaret.startOffset);
        selRange.setEnd(endCaret.startContainer, endCaret.startOffset);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(selRange);
        selectedText = sel?.toString() ?? "";
      }

      return {
        annotation: ru.getAttribute("annotation"),
        spanText: span.textContent,
        spanBoxWidth: spanBoxRect.width,
        spanBoxHeight: spanBoxRect.height,
        beforeContent: before.content,
        caretsInSpan,
        selectedText,
      };
    });

    // Painted glyph (generated content) still renders — visual output is
    // unchanged; we only made the underlying text reachable.
    expect(result.beforeContent).toBe(JSON.stringify(result.annotation));
    // No longer clipped to a 1x1px screen-reader-only box.
    expect(result.spanBoxWidth).toBeGreaterThan(5);
    expect(result.spanBoxHeight).toBeGreaterThan(5);
    // The pixel the user sees the romanization at now resolves into the
    // .romanization-selectable text node, and selecting it copies the plain,
    // clean Unicode romanization — never the custom-font PUA ligature used only
    // for diacritic rendering in the painted glyph.
    expect(result.caretsInSpan).toBe(true);
    expect(result.selectedText).toBe(result.spanText);
    // The custom-font ligature glyph the painted `::before` uses to fix
    // stacked-diacritic rendering lives in the Supplementary Private Use
    // Area (astral, codepoint > 0xFFFF, e.g. U+F0061) — plain Latin text
    // with combining diacritics never needs a surrogate pair. Checking for
    // "no astral codepoints" (instead of a character-class regex) confirms
    // the copied text is the clean, portable Unicode form.
    expect(Array.from(result.selectedText).some((ch) => ch.codePointAt(0)! > 0xffff)).toBe(false);
  });

  test("an active selection suppresses the single-character stroke-animation click", async ({
    page,
  }) => {
    await routeLegacyStylesCss(page);
    const response = await page.goto("/'%E9%A3%9F"); // 食 — single-char Taigi entry
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "食");

    const outcome = await page.evaluate(() => {
      const trigger = document.querySelector(".single-char-stroke-trigger");
      const span = document.querySelector(
        "h1.title hruby.rightangle ru[annotation] > .romanization-selectable",
      );
      if (!trigger || !span || !span.firstChild) throw new Error("title nodes not found");

      // Simulate the browser Selection state a real drag/double-click over
      // the visible romanization would leave behind, then dispatch the
      // click the mouseup of that same gesture also produces.
      const range = document.createRange();
      range.selectNodeContents(span.firstChild);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);

      const before = !!document.querySelector("#strokes");
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      const after = !!document.querySelector("#strokes");
      return {
        before,
        after,
        selectionSurvived: (window.getSelection()?.toString() ?? "") === "tsia̍h",
      };
    });

    // The stroke-animation panel's visibility must not flip when the click
    // arrives with a non-empty selection — otherwise every attempt to copy
    // the romanization also yanks the stroke-order panel open/closed.
    expect(outcome.after).toBe(outcome.before);
    expect(outcome.selectionSurvived).toBe(true);
  });
});

// g0v/moedict-webkit#256 (button removed): 「複製羅馬拼音」按鈕已移除。
// 羅馬拼音現在可透過 #186 CSS 疊加層直接選取，不需要按鈕。
// 同時驗證 Mandarin 標題的相同疊加層機制（#186 只有 Taigi e2e 測試）。

/**
 * Obtain the bounding rect of the first title `.romanization-selectable` span
 * rendered at the visible romanization glyph position.  Returns the serialisable
 * DOMRect fields so the caller can drive page.mouse without entering
 * page.evaluate again.
 */
async function getRtGlyphRect(
  page: Page,
): Promise<{ x: number; y: number; w: number; h: number; rtText: string } | null> {
  return page.evaluate(() => {
    const span = document.querySelector(
      "h1.title hruby.rightangle ru[annotation] > .romanization-selectable",
    );
    if (!span?.firstChild) return null;
    const range = document.createRange();
    range.selectNodeContents(span.firstChild);
    const rect = range.getClientRects()[0];
    if (!rect || rect.width < 2 || rect.height < 2) return null;
    return {
      x: rect.x,
      y: rect.y,
      w: rect.width,
      h: rect.height,
      rtText: span.textContent ?? "",
    };
  });
}

/**
 * Simulate a real pointer drag across the romanization row using
 * page.mouse, then return window.getSelection().toString() NFC-normalised.
 * The drag is confined to the vertical extent of the glyph rect so it
 * cannot accidentally sweep the Han character row beneath.
 */
async function dragSelectRomanization(
  page: Page,
  glyph: { x: number; y: number; w: number; h: number },
): Promise<string> {
  const midY = glyph.y + glyph.h / 2;
  // Start one pixel inside the left edge, end one pixel inside the right edge.
  await page.mouse.move(glyph.x + 1, midY);
  await page.mouse.down();
  await page.mouse.move(glyph.x + glyph.w - 1, midY, { steps: 12 });
  await page.mouse.up();
  return page.evaluate(() => (window.getSelection()?.toString() ?? "").normalize("NFC"));
}

test.describe("@romanization Mandarin title pronunciation selection (g0v/moedict-webkit#186 + #256)", () => {
  test("no copy button rendered — 複製羅馬拼音 button must not appear", async ({ page }) => {
    await routeLegacyStylesCss(page);
    await page.goto("/%E9%BB%83"); // 黃
    await waitForEntryHydration(page, "黃");
    // The button must not exist at all — selecting romanization works natively
    await expect(page.locator(".copyBlock")).toHaveCount(0);
    await expect(page.locator(".copyRomanization")).toHaveCount(0);
  });

  test("hit-testing: caretRangeFromPoint at visible romanization resolves to .romanization-selectable span text node (Mandarin)", async ({
    page,
  }) => {
    await routeLegacyStylesCss(page);
    await page.goto("/%E9%BB%83"); // 黃 huáng
    await waitForEntryHydration(page, "黃");
    await page.evaluate(() => document.fonts.ready);

    const result = await page.evaluate(() => {
      const ru = document.querySelector("h1.title hruby.rightangle ru[annotation]");
      if (!ru) throw new Error("annotation ru not found");
      const span = ru.querySelector(":scope > .romanization-selectable");
      if (!span || !span.firstChild) throw new Error(".romanization-selectable span not found");

      const before = window.getComputedStyle(ru, "::before");
      const glyphRange = document.createRange();
      glyphRange.selectNodeContents(span.firstChild);
      const glyphRect = glyphRange.getClientRects()[0];
      if (!glyphRect) throw new Error("span has no rendered glyph rect");

      const spanBoxRect = span.getBoundingClientRect();

      const y = glyphRect.y + glyphRect.height / 2;
      const startCaret = document.caretRangeFromPoint(glyphRect.x + 1, y);
      const endCaret = document.caretRangeFromPoint(glyphRect.x + glyphRect.width - 1, y);
      const caretsInSpan =
        startCaret?.startContainer.parentElement === span &&
        endCaret?.startContainer.parentElement === span;

      const spanUserSelect = window.getComputedStyle(span).userSelect;

      return {
        annotation: ru.getAttribute("annotation"),
        spanText: span.textContent,
        spanBoxWidth: spanBoxRect.width,
        spanBoxHeight: spanBoxRect.height,
        beforeContent: before.content,
        caretsInSpan,
        spanUserSelect,
      };
    });

    // Painted glyph (generated content) still renders — visual output unchanged.
    expect(result.beforeContent).toBe(JSON.stringify(result.annotation));
    // No longer clipped to a 1×1px box — span is positioned at glyph coordinates.
    expect(result.spanBoxWidth).toBeGreaterThan(5);
    expect(result.spanBoxHeight).toBeGreaterThan(5);
    // Caret resolution at visible glyph position hits the .romanization-selectable text node.
    expect(result.caretsInSpan).toBe(true);
    // user-select must not be none (would silently block browser drag-selection)
    expect(result.spanUserSelect).not.toBe("none");
  });

  test("real pointer drag across visible romanization row selects huáng only — Mandarin (page.mouse)", async ({
    page,
  }) => {
    await routeLegacyStylesCss(page);
    await page.goto("/%E9%BB%83"); // 黃 huáng
    await waitForEntryHydration(page, "黃");
    await page.evaluate(() => document.fonts.ready);

    const glyph = await getRtGlyphRect(page);
    if (!glyph) throw new Error("could not get rt glyph rect for 黃");

    const selected = await dragSelectRomanization(page, glyph);

    // Must be exactly the romanization, NFC-normalised.
    expect(selected).toBe("huáng");
    // No surrogates — confirms plain Unicode, not the PUA font ligature.
    expect(Array.from(selected).some((ch) => ch.codePointAt(0)! > 0xffff)).toBe(false);
    // No CJK or Zhuyin — the Han character and bopomofo sit below and must
    // not be swept up by a horizontal drag confined to the romanization row.
    expect(/[\u4e00-\u9fff\u3100-\u312f\u31a0-\u31bf]/.test(selected)).toBe(false);
  });

  test("real pointer drag across visible romanization row selects tsia̍h only — Taigi (page.mouse)", async ({
    page,
  }) => {
    await routeLegacyStylesCss(page);
    const response = await page.goto("/'%E9%A3%9F"); // 食 tsia̍h
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "食");
    await page.evaluate(() => document.fonts.ready);

    const glyph = await getRtGlyphRect(page);
    if (!glyph) throw new Error("could not get rt glyph rect for 食");

    const selected = await dragSelectRomanization(page, glyph);

    // Must be exactly the clean POJ romanization, NFC-normalised.
    expect(selected.normalize("NFC")).toBe("tsia\u030dh".normalize("NFC"));
    // No surrogates.
    expect(Array.from(selected).some((ch) => ch.codePointAt(0)! > 0xffff)).toBe(false);
    // No CJK or Zhuyin.
    expect(/[\u4e00-\u9fff\u3100-\u312f\u31a0-\u31bf]/.test(selected)).toBe(false);
    // Vertical layout confirmation: romanization row sits above the Han character.
    const gap = await page.evaluate(() => {
      const span = document.querySelector(
        "h1.title hruby.rightangle ru[annotation] > .romanization-selectable",
      );
      const rb = document.querySelector("h1.title hruby.rightangle ru rb");
      if (!span?.firstChild || !rb) return null;
      const range = document.createRange();
      range.selectNodeContents(span.firstChild);
      const glyphRect = range.getClientRects()[0];
      if (!glyphRect) return null;
      return Math.round(rb.getBoundingClientRect().top - (glyphRect.y + glyphRect.height));
    });
    if (gap !== null) expect(gap).toBeGreaterThan(0);
  });

  test("ARIA: title announces romanization exactly once — aria-hidden on .romanization-selectable suppresses duplicate", async ({
    page,
  }) => {
    await routeLegacyStylesCss(page);
    await page.goto("/%E9%BB%83"); // 黃 huáng
    await waitForEntryHydration(page, "黃");
    await page.evaluate(() => document.fonts.ready);

    // Secondary invariant: the implementation attribute is present.
    const ariaHidden = await page.evaluate(
      () =>
        document
          .querySelector("h1.title hruby.rightangle ru[annotation] > .romanization-selectable")
          ?.getAttribute("aria-hidden") ?? null,
    );
    expect(ariaHidden).toBe("true");

    // Primary observable contract: the Playwright accessibility snapshot of
    // the heading must contain the romanization text in exactly one leaf text
    // node.  Chromium surfaces ::before generated content as a leaf text entry
    // in the accessibility tree.  With aria-hidden on .romanization-selectable,
    // the selectable span is excluded from the a11y tree, so "huáng" must appear
    // as exactly one "- text: huáng" line — not two.  (Computed accessible names
    // children, so the heading name and button name also contain "huáng"; we
    // count only the bare leaf `- text:` lines, which represent the actual
    // node-level announcements a screen reader would traverse.)
    const snap = await page.locator("h1.title").ariaSnapshot();
    // Extract lines of the form "- text: <value>" to count leaf text nodes.
    const leafLines = snap
      .normalize("NFC")
      .split("\n")
      .filter((l) => l.trimStart().startsWith("- text:"));
    const huangLeaves = leafLines.filter((l) => l.normalize("NFC").includes("hu\u00e1ng")).length;
    // Must appear exactly once: the ::before generated content leaf.
    // aria-hidden on .romanization-selectable prevents a second "- text: huáng" leaf.
    expect(huangLeaves).toBe(1);
  });

  test("computed -webkit-touch-callout is not none on title hruby (iOS long-press must not be blocked)", async ({
    page,
  }) => {
    await routeLegacyStylesCss(page);
    await page.goto("/%E9%BB%83");
    await waitForEntryHydration(page, "黃");

    const callout = await page.evaluate(() => {
      const hruby = document.querySelector("h1.title hruby.rightangle");
      if (!hruby) return null;
      // webkit-touch-callout is only meaningful on WebKit; on Chromium it may
      // return "" or "auto" — either is acceptable (not "none").
      return window.getComputedStyle(hruby).getPropertyValue("-webkit-touch-callout");
    });

    // Must not be "none" — that would silently suppress the iOS long-press
    // text selection callout that lets users copy the romanization.
    expect(callout).not.toBe("none");
  });
});

/**
 * Romanization overlay layout regression suite (g0v/moedict-webkit#186 Safari fix).
 *
 * Root cause: WebKit's layout engine hard-forces <rt> elements to
 * position:static regardless of author !important CSS rules.  Replacing <rt>
 * with a <span class="romanization-selectable"> allows position:absolute to
 * take effect cross-engine, keeping the overlay compact and adjacent to the
 * Han character row.
 *
 * Tag prefix "@romanization" in every describe title enables:
 *   --project=chromium    (chromium project, no grep filter — runs all tests)
 *   --project=webkit-romanization  (grep: /@romanization/, WebKit engine)
 * Invariants are relative geometry checks, not fixed pixel values, so they
 * detect the broken-WebKit layout (large vertical gap, displaced audio) and
 * confirm the fix on both engines.
 */
test.describe("@romanization romanization overlay geometry regression (g0v/moedict-webkit#186)", () => {
  /**
   * Helper: collect overlay + rb + h1 + audio geometry.  Used by several tests below.
   * Returns relative invariants so results are viewport/font-size agnostic.
   */
  async function collectOverlayMetrics(page: Page) {
    return page.evaluate(() => {
      const ru = document.querySelector("h1.title hruby.rightangle ru[annotation]");
      if (!ru) throw new Error("annotation ru not found");
      const span = ru.querySelector(":scope > .romanization-selectable");
      if (!span) throw new Error(".romanization-selectable span not found");
      const rb = document.querySelector("h1.title hruby.rightangle ru rb");
      if (!rb) throw new Error("rb not found");
      const h1 = document.querySelector("h1.title");
      if (!h1) throw new Error("h1.title not found");
      const audioBlock = document.querySelector(".audioBlock");
      if (!audioBlock) throw new Error(".audioBlock not found");

      const cs = window.getComputedStyle(span);
      const fontSize = parseFloat(window.getComputedStyle(h1).fontSize) || 1;
      const spanRect = span.getBoundingClientRect();
      const rbRect = rb.getBoundingClientRect();
      const h1Rect = h1.getBoundingClientRect();
      const audioY = audioBlock.getBoundingClientRect().top;

      return {
        spanPosition: cs.position,
        spanY: spanRect.top,
        rbY: rbRect.top,
        h1Y: h1Rect.top,
        h1Height: h1Rect.height,
        audioY,
        // Relative: h1 height expressed in line-height multiples (font-size proxy).
        // Compact layout: romanization + Han char = ~2–3 line heights.
        // Broken WebKit: h1 alone was ~164px with a typical 24px font ≈ 6.8 lines.
        h1HeightToFontRatio: h1Rect.height / fontSize,
      };
    });
  }

  test("overlay span is geometrically above rb row and display is not static", async ({ page }) => {
    await routeLegacyStylesCss(page);
    await page.goto("/%E9%BB%83"); // 黃 huáng
    await waitForEntryHydration(page, "黃");
    await page.evaluate(() => document.fonts.ready);

    const metrics = await collectOverlayMetrics(page);

    // 1. Overlay is NOT static — position:absolute must survive on the span.
    expect(metrics.spanPosition).not.toBe("static");

    // 2. Overlay top is ABOVE rb top (romanization sits above the Han character).
    expect(metrics.spanY).toBeLessThan(metrics.rbY);

    // 3. h1 height is compact relative to the font size.
    //    Compact layout ≈ 2–3 line-heights; broken WebKit was ~6–7 line-heights.
    //    Threshold of 4× catches the regression with generous margin for zoom/DPI.
    expect(metrics.h1HeightToFontRatio).toBeLessThan(4);

    // 4. audioBlock sits within or immediately after h1 (not displaced far below).
    //    Required: .audioBlock must be present — collectOverlayMetrics throws if absent.
    expect(metrics.audioY).toBeGreaterThanOrEqual(metrics.h1Y);
    expect(metrics.audioY).toBeLessThan(metrics.h1Y + metrics.h1Height * 1.5);
  });

  test("computed position on overlay is absolute on all engines (CSS regression guard)", async ({
    page,
  }) => {
    await routeLegacyStylesCss(page);
    await page.goto("/%E9%BB%83");
    await waitForEntryHydration(page, "黃");

    const cs = await page.evaluate(() => {
      const span = document.querySelector(
        "h1.title hruby.rightangle ru[annotation] > .romanization-selectable",
      );
      if (!span) throw new Error(".romanization-selectable span not found");
      // getComputedStyle returns the ACTUALLY applied position value after layout.
      // If WebKit forces 'static', this fails even when the CSS rule says 'absolute'.
      return window.getComputedStyle(span).position;
    });

    // Must be "absolute" — not "static" (WebKit bug) nor anything else.
    expect(cs).toBe("absolute");
  });

  test("Taigi entry: overlay span geometry matches Mandarin invariants", async ({ page }) => {
    await routeLegacyStylesCss(page);
    const response = await page.goto("/'%E9%A3%9F"); // 食 tsia̍h
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "食");
    await page.evaluate(() => document.fonts.ready);

    const metrics = await collectOverlayMetrics(page);
    expect(metrics.spanPosition).not.toBe("static");
    expect(metrics.spanY).toBeLessThan(metrics.rbY);
    expect(metrics.h1HeightToFontRatio).toBeLessThan(4);
  });

  test("dark theme: overlay geometry remains compact (regression guard for colour-scheme reflow)", async ({
    page,
  }) => {
    // Dark mode sets background/colour but must not trigger a layout reflow that
    // re-introduces the position:static gap.
    await page.emulateMedia({ colorScheme: "dark" });
    await routeLegacyStylesCss(page);
    await page.goto("/%E9%BB%83"); // 黃 huáng
    await waitForEntryHydration(page, "黃");
    await page.evaluate(() => document.fonts.ready);

    const metrics = await collectOverlayMetrics(page);
    expect(metrics.spanPosition).not.toBe("static");
    expect(metrics.spanY).toBeLessThan(metrics.rbY);
    expect(metrics.h1HeightToFontRatio).toBeLessThan(4);
  });

  test("mobile viewport (393×852): overlay stays compact and span remains above rb", async ({
    page,
  }) => {
    // iPhone 15 / typical narrow viewport — verifies no viewport-triggered reflow.
    await page.setViewportSize({ width: 393, height: 852 });
    await routeLegacyStylesCss(page);
    await page.goto("/%E9%BB%83"); // 黃 huáng
    await waitForEntryHydration(page, "黃");
    await page.evaluate(() => document.fonts.ready);

    const metrics = await collectOverlayMetrics(page);
    expect(metrics.spanPosition).not.toBe("static");
    expect(metrics.spanY).toBeLessThan(metrics.rbY);
    expect(metrics.h1HeightToFontRatio).toBeLessThan(4);
  });

  test("phonetics=bopomofo: .romanization-selectable has computed display none (no hit target)", async ({
    page,
  }) => {
    // When the user preference is bopomofo-only, the romanization overlay is
    // suppressed via `body[data-ruby-pref="zhuyin"] … > .romanization-selectable
    // { display: none !important }` in index.css.  The span must not be a
    // hit target or accidentally selectable when no visible glyph is present.
    await page.addInitScript(() => {
      localStorage.setItem("phonetics", "bopomofo");
    });
    await routeLegacyStylesCss(page);
    await page.goto("/%E9%BB%83"); // 黃 huáng
    await waitForEntryHydration(page, "黃");

    const display = await page.evaluate(() => {
      const span = document.querySelector(
        "h1.title hruby.rightangle ru[annotation] > .romanization-selectable",
      );
      // The span must be present in the DOM (ruby2hruby always creates it) and
      // its computed display must be "none" — null would mean the span is absent
      // entirely, which would make this test vacuous.
      if (!span) throw new Error(".romanization-selectable span not found");
      return window.getComputedStyle(span).display;
    });
    expect(display).toBe("none");
  });

  test("phonetics=none: .romanization-selectable has computed display none (no hit target)", async ({
    page,
  }) => {
    // Same as bopomofo test but for the 'none' preference (no phonetics at all).
    await page.addInitScript(() => {
      localStorage.setItem("phonetics", "none");
    });
    await routeLegacyStylesCss(page);
    await page.goto("/%E9%BB%83"); // 黃 huáng
    await waitForEntryHydration(page, "黃");

    const display = await page.evaluate(() => {
      const span = document.querySelector(
        "h1.title hruby.rightangle ru[annotation] > .romanization-selectable",
      );
      // The span must be present in the DOM (ruby2hruby always creates it) and
      // its computed display must be "none" — null would mean the span is absent
      // entirely, which would make this test vacuous.
      if (!span) throw new Error(".romanization-selectable span not found");
      return window.getComputedStyle(span).display;
    });
    expect(display).toBe("none");
  });
});

test.describe("教育部《異體字字典》連結 (g0v/moedict-webkit#3)", () => {
  test("單字條目顯示連結到教育部異體字字典查詢頁，且位於動作列而非標題列", async ({ page }) => {
    await page.goto("/%E8%90%8C");
    await waitForEntryHydration(page, "萌");
    const link = page.locator("a.variants-link").first();
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute(
      "href",
      "https://dict.variants.moe.edu.tw/search.jsp?QTP=0&WORD=%E8%90%8C",
    );
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");

    // The link now lives in the single .entry-actions row alongside the
    // star/favorite toggle and the copy-explanation button, not inside the
    // title row's .radical corner.
    const actionsRow = page.locator(".entry-actions");
    await expect(actionsRow).toHaveCount(1);
    await expect(actionsRow.locator("a.variants-link")).toHaveCount(1);
    await expect(page.locator(".radical a.variants-link")).toHaveCount(0);
    await expect(page.locator("h1.title a.variants-link")).toHaveCount(0);
    await expect(actionsRow.locator(".star")).toHaveCount(1);
    await expect(actionsRow.locator(".entry-copy-button")).toHaveCount(1);
  });

  test("多字詞條（非單字）不顯示異體字字典連結", async ({ page }) => {
    await page.goto("/~%E4%B8%8A%E8%A8%B4");
    await waitForEntryHydration(page, "上訴");
    await expect(page.locator("a.variants-link")).toHaveCount(0);
    // Star and copy actions still render for multi-character entries.
    const actionsRow = page.locator(".entry-actions");
    await expect(actionsRow.locator(".star")).toHaveCount(1);
    await expect(actionsRow.locator(".entry-copy-button")).toHaveCount(1);
  });
});

test.describe("mobile Android Taigi ruby layout", () => {
  test.use({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2.75, isMobile: true });

  test("bopomofo-only mode compacts hidden TL-DT rows and keeps POS text aligned", async ({
    page,
  }) => {
    await page.addInitScript((ua) => {
      Object.defineProperty(navigator, "userAgent", {
        get: () => ua,
      });
      localStorage.setItem("phonetics", "bopomofo");
      localStorage.setItem("pinyin_t", "TL-DT");
    }, ANDROID_WEBVIEW_UA);

    const active = await gotoFirstTitleEntry(page, TAIGI_TITLE_CANDIDATES);
    await expect(page.locator("h1.title").first()).toContainText(active.title[0], {
      timeout: 8_000,
    });

    const metrics = await page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`${selector} not found`);
        const { top, height } = element.getBoundingClientRect();
        return { top, height };
      };
      const annotation = document.querySelector("h1.title hruby.rightangle ru[annotation]");
      if (!annotation) throw new Error("right-angle annotation not found");
      const annotationStyle = window.getComputedStyle(annotation, "::before");
      const yinCenters = [...document.querySelectorAll("h1.title hruby.rightangle ru[zhuyin]")].map(
        (ru) => {
          const yin = ru.querySelector("yin");
          if (!yin) throw new Error("yin not found");
          const ruRect = ru.getBoundingClientRect();
          const yinRect = yin.getBoundingClientRect();

          return {
            marginTop: window.getComputedStyle(ru.querySelector("zhuyin")!).marginTop,
            delta: Math.abs((yinRect.top + yinRect.bottom - ruRect.top - ruRect.bottom) / 2),
          };
        },
      );
      const titleElement = document.querySelector("h1.title");
      if (!titleElement) throw new Error("title not found");
      const entryItem = document.querySelector(".entry-item");
      if (!entryItem) throw new Error("entry item not found");
      const partOfSpeech = entryItem.querySelector(":scope > .part-of-speech");
      const definition = entryItem.querySelector(".def");
      if (!partOfSpeech || !definition) throw new Error("entry text nodes not found");

      return {
        isAndroid: document.documentElement.classList.contains("moe-android"),
        titleFontFamily: window.getComputedStyle(titleElement).fontFamily,
        yinCenters,
        title: rect("h1.title"),
        pos: partOfSpeech.getBoundingClientRect().top,
        definition: definition.getBoundingClientRect().top,
        entryItem: rect(".entry-item"),
        annotationContent: annotationStyle.content,
        annotationDisplay: annotationStyle.display,
      };
    });

    expect(metrics.isAndroid).toBe(true);
    expect(metrics.titleFontFamily).toContain("MOE");
    expect(metrics.yinCenters.length).toBeGreaterThan(0);
    for (const center of metrics.yinCenters) {
      expect(center.marginTop).toBe("0px");
      expect(center.delta).toBeLessThan(3.5);
    }
    expect(metrics.annotationContent).toBe("none");
    expect(metrics.annotationDisplay).toBe("none");
    expect(metrics.title.height).toBeLessThan(240);
    expect(Math.abs(metrics.definition - metrics.pos)).toBeLessThan(30);
  });

  test("bopomofo-only mode keeps available title ruby centered", async ({ page }) => {
    await page.addInitScript((ua) => {
      Object.defineProperty(navigator, "userAgent", { get: () => ua });
      localStorage.setItem("phonetics", "bopomofo");
      localStorage.setItem("pinyin_t", "TL-DT");
    }, ANDROID_WEBVIEW_UA);

    let checked = 0;
    for (const sample of TAIGI_TITLE_CANDIDATES) {
      const response = await page.goto(sample.path);
      expect(response?.status()).toBe(200);
      await waitForAppReady(page, "dictionary");
      await page.evaluate(() => document.fonts.ready);
      if ((await page.locator("h1.title").count()) === 0) {
        continue;
      }
      await expect(page.locator("h1.title").first()).toContainText(sample.title[0], {
        timeout: 8_000,
      });
      checked += 1;

      const metrics = await page.evaluate(() => {
        return [...document.querySelectorAll("h1.title hruby.rightangle ru[zhuyin]")].map((ru) => {
          const zhuyin = ru.querySelector("zhuyin");
          const yin = ru.querySelector("yin");
          const diao = ru.querySelector("diao");
          if (!zhuyin || !yin || !diao) throw new Error("title ruby node missing");
          const ruRect = ru.getBoundingClientRect();
          const yinRect = yin.getBoundingClientRect();
          const diaoRect = diao.textContent ? diao.getBoundingClientRect() : null;
          const center = (ruRect.top + ruRect.bottom) / 2;

          return {
            length: ru.getAttribute("length"),
            text: zhuyin.textContent,
            yinCenterDelta: (yinRect.top + yinRect.bottom) / 2 - center,
            zhuyinHeight: zhuyin.getBoundingClientRect().height,
            diaoCenterDelta: diaoRect ? (diaoRect.top + diaoRect.bottom) / 2 - center : null,
            marginTop: window.getComputedStyle(zhuyin).marginTop,
          };
        });
      });

      expect(metrics.length).toBeGreaterThan(0);
      for (const item of metrics) {
        expect(item.marginTop).toBe("0px");
        expect(Math.abs(item.yinCenterDelta), `${sample.title} ${item.text}`).toBeLessThan(3.5);
        if (item.length === "1") expect(item.zhuyinHeight).toBeLessThan(24);
        if (item.diaoCenterDelta !== null) {
          expect(item.diaoCenterDelta).toBeGreaterThan(-10);
          expect(item.diaoCenterDelta).toBeLessThan(10);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  for (const pinyin of ["TL", "DT", "TL-DT"]) {
    test(`${pinyin} right-angle title rows stay visible and compact`, async ({ page }) => {
      await page.addInitScript(
        ({ ua, pinyinPref }) => {
          Object.defineProperty(navigator, "userAgent", { get: () => ua });
          localStorage.setItem("phonetics", "rightangle");
          localStorage.setItem("pinyin_t", pinyinPref);
        },
        { ua: ANDROID_WEBVIEW_UA, pinyinPref: pinyin },
      );

      const active = await gotoFirstTitleEntry(page, TAIGI_TITLE_CANDIDATES);
      await expect(page.locator("h1.title").first()).toContainText(active.title[0], {
        timeout: 8_000,
      });

      const metrics = await page.evaluate(() => {
        const title = document.querySelector("h1.title");
        if (!title) throw new Error("title not found");
        const annotations = [...title.querySelectorAll("ru[annotation]")].map((ru) => {
          const before = window.getComputedStyle(ru, "::before");
          return {
            annotation: ru.getAttribute("annotation"),
            content: before.content,
            display: before.display,
          };
        });

        return {
          bodyPref: document.body.getAttribute("data-ruby-pref"),
          titleHeight: title.getBoundingClientRect().height,
          annotations,
        };
      });

      expect(metrics.bodyPref).toBe("both");
      expect(metrics.titleHeight).toBeLessThan(240);
      expect(metrics.annotations.length).toBeGreaterThan(0);
      for (const annotation of metrics.annotations) {
        expect(annotation.annotation).toBeTruthy();
      }
    });
  }
});

test.describe("Mandarin MOE vertical zhuyin proportions", () => {
  test.use({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2.75, isMobile: true });

  for (const platform of [
    { name: "non-Android", ua: undefined },
    { name: "Android", ua: ANDROID_WEBVIEW_UA },
  ]) {
    test(`${platform.name} title ruby fits the MOE 30:30 / 30:15 vertical grid`, async ({
      page,
    }) => {
      await page.addInitScript(
        ({ ua }) => {
          if (ua) Object.defineProperty(navigator, "userAgent", { get: () => ua });
          localStorage.setItem("phonetics", "bopomofo");
          localStorage.setItem("pinyin_a", "HanYu");
        },
        { ua: platform.ua },
      );

      const checkedTitles = new Set<string>();
      for (const sample of MANDARIN_VERTICAL_ZHUYIN_SAMPLES) {
        const response = await page.goto(sample.path);
        expect(response?.status()).toBe(200);
        await page.waitForLoadState("domcontentloaded");
        await page
          .locator(".result .entry h1.title hruby.rightangle, .charimg-result")
          .first()
          .waitFor({ state: "visible", timeout: 15_000 });
        await page.evaluate(() => document.fonts.ready);
        if ((await page.locator(".result .entry h1.title hruby.rightangle").count()) === 0) {
          continue;
        }
        await expect(page.locator(".result .entry h1.title hruby.rightangle").first()).toBeVisible({
          timeout: 8_000,
        });

        const metrics = await page.evaluate((titleText) => {
          const title = [...document.querySelectorAll(".result .entry h1.title")].find(
            (element) => {
              const baseText = [...element.querySelectorAll("hruby.rightangle rb")]
                .map((rb) => rb.textContent?.trim() ?? "")
                .join("");
              return baseText === titleText;
            },
          );
          if (!title) throw new Error("right-angle title not found");
          const fontSize = Number.parseFloat(window.getComputedStyle(title).fontSize);
          const rect = (element: Element) => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return {
              x: x / fontSize,
              y: y / fontSize,
              width: width / fontSize,
              height: height / fontSize,
              right: (x + width) / fontSize,
              bottom: (y + height) / fontSize,
              centerY: (y + height / 2) / fontSize,
            };
          };

          return [...title.querySelectorAll("ru[zhuyin]")].map((ru) => {
            const rb = ru.querySelector("rb");
            const zhuyin = ru.querySelector("zhuyin");
            const yin = ru.querySelector("yin");
            const diao = ru.querySelector("diao");
            if (!rb || !zhuyin || !yin || !diao) throw new Error("title ruby node missing");
            const ruRect = rect(ru);
            const rbRect = rect(rb);
            const zhuyinRect = rect(zhuyin);
            const yinRect = rect(yin);
            const diaoRect = diao.textContent ? rect(diao) : null;

            return {
              length: ru.getAttribute("length"),
              text: zhuyin.textContent,
              rbWidth: rbRect.width,
              ruWidth: ruRect.width,
              zhuyinColumnWidth: zhuyinRect.width,
              zhuyinLeft: zhuyinRect.x - rbRect.x,
              zhuyinRight: zhuyinRect.right - rbRect.x,
              zhuyinTopInRu: zhuyinRect.y - ruRect.y,
              zhuyinBottomInRu: zhuyinRect.bottom - ruRect.y,
              yinCenterDelta: yinRect.centerY - rbRect.centerY,
              toneLeft: diaoRect ? diaoRect.x - rbRect.x : null,
              toneRight: diaoRect ? diaoRect.right - rbRect.x : null,
              toneTopInRu: diaoRect ? diaoRect.y - ruRect.y : null,
              toneBottomInRu: diaoRect ? diaoRect.bottom - ruRect.y : null,
            };
          });
        }, sample.title);

        for (const item of metrics) {
          // Length-3 initials (e.g. ㄏㄨㄤ for 黃) have a wider phonetic column than
          // length 1/2; keep tight bounds for 1/2 so a real regression on those is caught.
          const isLen3 = item.length === "3";
          const ruWidthMax = isLen3 ? 5.1 : 5.0;
          const zhuyinColMax = isLen3 ? 4.1 : 3.5;
          const zhuyinRightMax = isLen3 ? 5.1 : 4.5;
          const toneRightMax = isLen3 ? 5.1 : 5.0;

          expect(item.rbWidth, `${sample.title} ${item.text} Han square`).toBeGreaterThan(0.5);
          expect(item.rbWidth, `${sample.title} ${item.text} Han square`).toBeLessThan(1.6);
          expect(item.ruWidth, `${sample.title} ${item.text} annotated unit`).toBeGreaterThan(1.0);
          expect(item.ruWidth, `${sample.title} ${item.text} annotated unit`).toBeLessThan(
            ruWidthMax,
          );
          expect(
            item.zhuyinColumnWidth,
            `${sample.title} ${item.text} zhuyin column`,
          ).toBeGreaterThan(0.1);
          expect(item.zhuyinColumnWidth, `${sample.title} ${item.text} zhuyin column`).toBeLessThan(
            zhuyinColMax,
          );
          expect(
            item.zhuyinLeft,
            `${sample.title} ${item.text} zhuyin starts beside Han`,
          ).toBeGreaterThan(0);
          expect(
            item.zhuyinRight,
            `${sample.title} ${item.text} zhuyin stays in phonetic column`,
          ).toBeLessThan(zhuyinRightMax);
          expect(
            item.zhuyinTopInRu,
            `${sample.title} ${item.text} zhuyin top fits`,
          ).toBeGreaterThanOrEqual(-0.5);
          expect(
            item.zhuyinBottomInRu,
            `${sample.title} ${item.text} zhuyin bottom fits`,
          ).toBeLessThan(4.5);
          expect(
            Math.abs(item.yinCenterDelta),
            `${sample.title} ${item.text} zhuyin vertical center`,
          ).toBeLessThan(1.2);

          if (
            item.toneLeft !== null &&
            item.toneRight !== null &&
            item.toneTopInRu !== null &&
            item.toneBottomInRu !== null
          ) {
            expect(
              item.toneLeft,
              `${sample.title} ${item.text} tone column starts`,
            ).toBeGreaterThan(0);
            expect(item.toneRight, `${sample.title} ${item.text} tone column ends`).toBeLessThan(
              toneRightMax,
            );
            expect(
              item.toneTopInRu,
              `${sample.title} ${item.text} tone top fits`,
            ).toBeGreaterThanOrEqual(-0.5);
            expect(
              item.toneBottomInRu,
              `${sample.title} ${item.text} tone bottom fits`,
            ).toBeLessThan(4.5);
          }
        }
        // Only mark checked after metrics are exercised.
        checkedTitles.add(sample.title);
      }
      // 黃 (length=3) must have been checked; at least one other sample too.
      expect(checkedTitles.has("黃"), "黃 (length=3 sample) was checked").toBe(true);
      expect(
        checkedTitles.size,
        "at least two distinct samples rendered right-angle ruby",
      ).toBeGreaterThanOrEqual(2);
    });
  }
});

// Same-origin font route, FontFace load status, and 黃 (ㄏㄨㄤˊ, length=3) tone-node geometry.
// Rationale: r2-assets.moedict.tw CORS headers may be missing on stale edge PoPs, causing
// browser font-load failures for cross-origin requests and breaking title/Zhuyin geometry.
// The "MOEDICT Same-Origin" @font-face alias serves identical bytes via same-origin
// /assets/fonts/* paths — immune to CORS cache state.  This test asserts:
//   1. The Worker returns 200 font/woff2 for /assets/fonts/MOEDICT.woff2?v=20260713-cors
//      from the same origin as the page (not cross-origin r2-assets).
//   2. After explicit document.fonts.load(), the FontFace status is "loaded" and
//      document.fonts.check() returns true for the alias family.
//   3. The computed font-family on the diao element includes "MOEDICT Same-Origin".
//   4. 黃 renders a right-angle title with ru[zhuyin][length="3"], and the diao
//      tone node fits the vertical grid (would fail under wrong fallback font metrics).
//   Secondary: the @font-face rule src is same-origin via CSS OM.
test.describe("MOEDICT Same-Origin font and 黃 length-3 tone geometry", () => {
  test.use({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2.75, isMobile: true });

  test("same-origin font is 2xx font/woff2, FontFace loads, alias in computed stack; 黃 diao fits grid", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("phonetics", "bopomofo");
      localStorage.setItem("pinyin_a", "HanYu");
    });

    // Install response watcher before navigation so we catch early font loads.
    // The MOEDICT Same-Origin @font-face src is /assets/fonts/MOEDICT.woff2?v=20260713-cors.
    const fontResponsePromise = page.waitForResponse(
      (r) => r.url().includes("/assets/fonts/MOEDICT.woff2") && r.url().includes("v=20260713-cors"),
      { timeout: 20_000 },
    );

    const pageResponse = await page.goto("/%E9%BB%83");
    expect(pageResponse?.status(), "黃 page loads 200").toBe(200);
    await page.waitForLoadState("domcontentloaded");

    // 黃 must render a right-angle ruby title — pack/707.txt is now seeded in fixtures.
    await expect(
      page.locator(".result .entry h1.title hruby.rightangle"),
      "黃 renders right-angle title (pack/707 fixture seeded)",
    ).toBeVisible({ timeout: 15_000 });

    // Explicitly load the alias to trigger the font fetch if not yet triggered.
    await page.evaluate(async () => {
      await document.fonts.ready;
      await document.fonts.load('37px "MOEDICT Same-Origin"', "黃ㄏㄨㄤˊ");
    });

    // 1. The font request was served by the Worker at the same origin (not cross-origin R2).
    const fontResp = await fontResponsePromise;
    expect(fontResp.status(), "MOEDICT.woff2 response is 2xx").toBeGreaterThanOrEqual(200);
    expect(fontResp.status(), "MOEDICT.woff2 response is 2xx").toBeLessThan(300);
    const fontRespUrl = new URL(fontResp.url());
    const pageUrl = new URL(page.url());
    expect(
      fontRespUrl.origin,
      "font served from same origin as page (not cross-origin r2-assets)",
    ).toBe(pageUrl.origin);
    expect(fontRespUrl.pathname, "font path is /assets/fonts/MOEDICT.woff2").toBe(
      "/assets/fonts/MOEDICT.woff2",
    );
    const ct = fontResp.headers()["content-type"] ?? "";
    expect(ct, "content-type is font/woff2").toContain("font/woff2");

    // 2. FontFace status is "loaded" and document.fonts.check() returns true.
    const fontLoadResult = await page.evaluate(async () => {
      const faces = await document.fonts.load('37px "MOEDICT Same-Origin"', "黃ㄏㄨㄤˊ");
      return {
        loadedCount: faces.length,
        statuses: faces.map((f) => f.status),
        checkResult: document.fonts.check('37px "MOEDICT Same-Origin"', "黃ㄏㄨㄤˊ"),
      };
    });
    expect(
      fontLoadResult.loadedCount,
      '"MOEDICT Same-Origin" FontFace resolved (load returned ≥1 face)',
    ).toBeGreaterThan(0);
    expect(
      fontLoadResult.statuses.every((s) => s === "loaded"),
      "all resolved FontFace objects have status loaded",
    ).toBe(true);
    expect(
      fontLoadResult.checkResult,
      'document.fonts.check returns true for "MOEDICT Same-Origin"',
    ).toBe(true);

    // 3. The computed font-family on the diao node includes "MOEDICT Same-Origin".
    const diaoFontFamily = await page.evaluate(() => {
      const diao = document.querySelector(
        ".result .entry h1.title hruby.rightangle ru[zhuyin][length='3'] diao",
      );
      if (!diao) throw new Error("diao in length=3 ru not found for 黃");
      return window.getComputedStyle(diao).fontFamily;
    });
    expect(
      diaoFontFamily,
      'computed font-family on 黃 diao includes "MOEDICT Same-Origin"',
    ).toMatch(/MOEDICT Same-Origin/i);

    // Secondary: @font-face src is same-origin via CSS OM.
    const fontFaceSrc = await page.evaluate(() => {
      for (const sheet of [...document.styleSheets]) {
        try {
          for (const rule of [...sheet.cssRules]) {
            if (rule instanceof CSSFontFaceRule) {
              const family = rule.style.getPropertyValue("font-family").replace(/['"]/g, "").trim();
              if (family === "MOEDICT Same-Origin") return rule.style.getPropertyValue("src");
            }
          }
        } catch {
          // Cross-origin sheet — skip
        }
      }
      return null;
    });
    expect(fontFaceSrc, '"MOEDICT Same-Origin" @font-face rule in stylesheet').not.toBeNull();
    expect(fontFaceSrc, "src references /assets/fonts/MOEDICT (same-origin)").toContain(
      "/assets/fonts/MOEDICT",
    );
    expect(fontFaceSrc, "src does not reference cross-origin r2-assets").not.toContain("r2-assets");

    // 4. 黃 (ㄏㄨㄤˊ, length=3) diao tone node fits the vertical grid.
    // Would fail if tone mark escapes column due to wrong font metrics from a failed font load.
    const ru3 = page.locator(".result .entry h1.title hruby.rightangle ru[zhuyin][length='3']");
    await expect(ru3, "黃 title has ru[zhuyin][length='3']").toBeVisible();
    const diaoMetrics = await page.evaluate(() => {
      const title = [...document.querySelectorAll(".result .entry h1.title")].find(
        (el) =>
          [...el.querySelectorAll("hruby.rightangle rb")]
            .map((rb) => rb.textContent?.trim() ?? "")
            .join("") === "黃",
      );
      if (!title) throw new Error("黃 right-angle title not found");
      const fontSize = Number.parseFloat(window.getComputedStyle(title).fontSize);
      const ruEl = title.querySelector("ru[zhuyin][length='3']");
      if (!ruEl) throw new Error("ru[zhuyin][length='3'] not found in 黃 title");
      const diaoEl = ruEl.querySelector("diao");
      if (!diaoEl || !diaoEl.textContent)
        throw new Error("diao node missing or empty in length=3 ru");
      const ruRect = ruEl.getBoundingClientRect();
      const diaoRect = diaoEl.getBoundingClientRect();
      return {
        toneTopInRu: (diaoRect.top - ruRect.top) / fontSize,
        toneBottomInRu: (diaoRect.bottom - ruRect.top) / fontSize,
        toneLeft: (diaoRect.left - ruRect.left) / fontSize,
        toneRight: (diaoRect.right - ruRect.left) / fontSize,
      };
    });
    expect(
      diaoMetrics.toneTopInRu,
      "黃 length=3 diao top fits vertical grid",
    ).toBeGreaterThanOrEqual(-0.5);
    expect(diaoMetrics.toneBottomInRu, "黃 length=3 diao bottom fits vertical grid").toBeLessThan(
      4.5,
    );
    expect(diaoMetrics.toneLeft, "黃 length=3 diao stays in phonetic column").toBeGreaterThan(0);
    expect(diaoMetrics.toneRight, "黃 length=3 diao right edge in phonetic column").toBeLessThan(
      5.1,
    );
  });
});

test.describe("special routes", () => {
  test("/@ radical view renders grid", async ({ page }) => {
    const response = await page.goto("/@");
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "static");
    // The radical view has a root container; look for any CJK chars in links/buttons
    await expect(page.locator("body")).toContainText(/[一二人入]/, { timeout: 10_000 });
  });

  test("/~@ renders radical view with 兩岸 brand", async ({ page }) => {
    const response = await page.goto("/~@");
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "static");
  });

  test("/'@ renders radical view for 台語 (g0v/moedict-webkit#122)", async ({ page }) => {
    const response = await page.goto("/'@");
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "static");
    await expect(page).toHaveTitle(/台語萌典/);
    await expect(page.locator("body")).toContainText(/[一二人入]/, { timeout: 10_000 });
  });

  test("/:@ renders Hakka radicals and labels exact CNS total strokes", async ({ page }) => {
    const tocResponse = await page.goto("/:@");
    expect(tocResponse?.status()).toBe(200);
    await waitForAppReady(page, "static");
    await expect(page).toHaveTitle(/客語萌典/);
    await expect(page.locator('a.stroke-char[href="/:@子"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".result .def")).toHaveCount(0);

    const detailResponse = await page.goto("/:@%E5%AD%90");
    expect(detailResponse?.status()).toBe(200);
    await expect(page.locator("a.stroke-char").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".radical-stroke-note")).toContainText(
      "客語字表依 CNS11643 全字庫總筆畫分組",
    );
    await expect(page.locator(".stroke-count").filter({ hasText: "總筆畫 3" })).toBeVisible();
    await expect(page.locator("a.stroke-char").filter({ hasText: "子" })).toHaveAttribute(
      "href",
      "/:子",
    );
  });

  test("/@口 radical detail page has no duplicate a.stroke-char hrefs (g0v/moedict-webkit radical-key dedup)", async ({
    page,
  }) => {
    // Regression for a duplicate-React-key bug: 口's own stroke-0 row listed
    // the radical character itself twice, producing key collision `0-口` in
    // both RadicalView.tsx and RadicalDetailView.tsx (`${stroke}-${char}`)
    // and a real duplicated <a> link in the rendered DOM (confirmed live on
    // production, not just a local dev-mode console warning — production
    // React silently strips the key-uniqueness warning but the underlying
    // DOM duplication is real there too). Fixed at the data-normalization
    // source (normalizeRows in radical-page-utils.ts) so every consumer
    // (RadicalView, RadicalDetailView, and the useRadicalTooltip hover
    // preview) is covered by one fix.
    const response = await page.goto("/@%E5%8F%A3");
    expect(response?.status()).toBe(200);
    await waitForAppReady(page, "static");
    // RadicalDetailView fetches /api/@口.json and renders "載入中…" until it
    // resolves -- "static" readiness only waits for `body` to be visible,
    // which is true well before that fetch settles. Bridge the async gap by
    // waiting for the first stroke-char link to actually mount (same pattern
    // as the /@ and /'@ sibling tests' toContainText bridge below) before
    // reading the full href list, so this doesn't race the fetch.
    await expect(page.locator("a.stroke-char").first()).toBeVisible({ timeout: 10_000 });

    const hrefs = await page
      .locator("a.stroke-char")
      .evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).getAttribute("href")));
    expect(hrefs.length).toBeGreaterThan(0);
    expect(new Set(hrefs).size).toBe(hrefs.length);

    // The radical character itself must still appear exactly once, not zero
    // (over-eager dedup) or two-plus (the original bug).
    const selfLinks = hrefs.filter((href) => href === "/口");
    expect(selfLinks).toHaveLength(1);
  });

  test("/about shows about content", async ({ page }) => {
    const response = await page.goto("/about");
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/關於本站/);
    await waitForAppReady(page, "static");
    await expect(page.locator("body")).toContainText(/萌典/, { timeout: 20_000 });

    // About.css must be loaded — .about-page has a distinctive computed style
    // (position: relative, min-height: 100vh) that proves the stylesheet is
    // bundled and applied. Without import './About.css' these are default
    // (position: static, min-height: auto) and the page layout breaks.
    const aboutStyle = await page.evaluate(() => {
      const el = document.querySelector(".about-page");
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { position: cs.position, minHeight: cs.minHeight };
    });
    expect(aboutStyle, ".about-page element must exist on /about").not.toBeNull();
    expect(aboutStyle!.position, ".about-page must have position: relative from About.css").toBe(
      "relative",
    );
    // min-height resolves to viewport pixels (800px at 1280×800 viewport);
    // the key assertion is that it's not 'auto' (default without About.css).
    expect(
      aboutStyle!.minHeight,
      ".about-page must have non-auto min-height from About.css",
    ).not.toBe("auto");
  });

  test("/privacy shows privacy content", async ({ page }) => {
    const response = await page.goto("/privacy");
    expect(response?.status()).toBe(200);
    await expect(page.locator("body")).toContainText(/隱私|privacy/i);
  });
});

test.describe("404 / fallback paths", () => {
  test("unknown word falls back to SPA (not worker 404)", async ({ page }) => {
    // React router catch-all still serves index.html
    const response = await page.goto("/%E4%B8%8D%E5%AD%98%E5%9C%A8%E7%9A%84%E8%A9%9E");
    expect(response?.status()).toBe(200);
  });
});

test.describe("definition-index permalink (/word/N, g0v/moedict.tw#131)", () => {
  // 萌 (a): 1 草木初生的芽 / 2 事物發生的開端或徵兆 / 3 人民 / 4 姓 / 5 發芽 / 6 發生
  test("/萌/3 renders the entry and highlights the 3rd definition (人民)", async ({ page }) => {
    const response = await page.goto("/%E8%90%8C/3");
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "萌");
    const highlighted = page.locator(".idx-permalink-target");
    await expect(highlighted).toHaveCount(1);
    await expect(highlighted).toContainText("人民");
  });

  test("/萌/1 highlights the 1st definition, not the 3rd", async ({ page }) => {
    const response = await page.goto("/%E8%90%8C/1");
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "萌");
    const highlighted = page.locator(".idx-permalink-target");
    await expect(highlighted).toHaveCount(1);
    await expect(highlighted).toContainText("草木初生的芽");
    await expect(highlighted).not.toContainText("人民");
  });

  test("/萌 (no idx) renders with no highlighted definition", async ({ page }) => {
    const response = await page.goto("/%E8%90%8C");
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "萌");
    await expect(page.locator(".idx-permalink-target")).toHaveCount(0);
  });

  test("/萌/999 (out-of-range idx) still renders the entry, highlighting nothing", async ({
    page,
  }) => {
    const response = await page.goto("/%E8%90%8C/999");
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "萌");
    await expect(page.locator(".idx-permalink-target")).toHaveCount(0);
  });

  test("/'食/1 (t lang) also resolves and does not misparse the idx as part of the word", async ({
    page,
  }) => {
    const response = await page.goto("/'%E9%A3%9F/1");
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "食");
    await expect(page).not.toHaveTitle(/食\/1/);
  });
});

test.describe("台語異用字顯示 (g0v/moedict-webkit#281)", () => {
  // 你 (/ˈlí/) has id=2881 in the ptck pack and maps to 汝 in x-異用字.json.
  test("正面測試：你 (Taigi) 顯示異用字「汝」", async ({ page }) => {
    const response = await page.goto("/'%E4%BD%A0"); // /'你
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "你");

    const block = page.locator(".twblg-variants").first();
    await expect(block).toBeVisible({ timeout: 10_000 });
    await expect(block).toContainText("異用字");
    await expect(block).toContainText("汝");
    // Must not appear for other langs: this is the /' route (lang=t)
    await expect(block.locator(".xref").first()).toContainText("異用字");
  });

  // 囝 (kiánn) has id=2134 and maps to 子.
  test("正面測試：囝 (Taigi) 顯示異用字「子」", async ({ page }) => {
    const response = await page.goto("/'%E5%9B%9D"); // /'囝
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "囝");

    const block = page.locator(".twblg-variants").first();
    await expect(block).toBeVisible({ timeout: 10_000 });
    await expect(block).toContainText("子");
  });

  // 蛇 (bucket 71) has no B field on any heteronym — must not render .twblg-variants.
  test("負面測試：無異用字條目不顯示 .twblg-variants", async ({ page }) => {
    const response = await page.goto("/'%E8%9B%87"); // /'蛇
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "蛇");
    await expect(page.locator(".twblg-variants")).toHaveCount(0);
  });

  // Mandarin entry (lang=a) must not show .twblg-variants — B field only
  // exists on lang=t.  萌 is the canonical Mandarin fixture (bucket 12, seeded).
  test("非台語條目不顯示 .twblg-variants（lang=a 萌）", async ({ page }) => {
    const response = await page.goto("/%E8%90%8C"); // /萌 (Mandarin)
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "萌");
    await expect(page.locator(".twblg-variants")).toHaveCount(0);
  });
});

test.describe("entry copy-explanation action (RESCOPE #258, single action-row button)", () => {
  test("renders exactly one keyboard-accessible copy button per entry, no per-definition controls", async ({
    page,
  }) => {
    await page.goto("/%E8%90%8C");
    await waitForEntryHydration(page, "萌");
    const buttons = page.getByRole("button", { name: "複製解釋" });
    await expect(buttons).toHaveCount(1);
    await expect(buttons).toHaveAttribute("aria-label", "複製解釋");
    await expect(page.locator(".definition-copy-controls")).toHaveCount(0);
    await expect(page.locator("li .entry-copy-button")).toHaveCount(0);
    // Lives in the shared action row, alongside star/variants.
    await expect(page.locator(".entry-actions .entry-copy-button")).toHaveCount(1);
  });

  test("copies every visible definition in order; header carries the romanization exactly once, body stays romanization-free", async ({
    page,
  }) => {
    await page.goto("/%E8%90%8C");
    await waitForEntryHydration(page, "萌");

    // 萌 (bucket 12 seeded fixture) has two visible definitions for its
    // single heteronym; both must appear in the copied payload, in order.
    const defTexts = await page.locator(".entry .definition .def").allInnerTexts();
    expect(defTexts.length).toBeGreaterThanOrEqual(2);

    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) =>
            ((window as Window & { __copied?: string }).__copied = value),
        },
      });
    });

    await page.getByRole("button", { name: "複製解釋" }).click();
    await expect(page.locator(".entry-copy-status")).toHaveText("已複製");
    const copied = await page.evaluate(
      () => (window as Window & { __copied?: string }).__copied ?? "",
    );

    // Header is unconditional (fix/heteronym-order-sutian): every
    // heteronym section — even a single-heteronym page like /萌 — starts
    // with an exact `headword（reading）` line. This is the ONE
    // deliberate, intentional appearance of the romanization in the whole
    // payload; it must be the literal first line, not embedded/duplicated
    // elsewhere.
    const lines = copied.split("\n");
    expect(lines[0]).toBe("萌（méng）");
    expect(lines[1]).toBe("");

    // Everything AFTER the header line is the body: the pre-existing
    // "romanization never leaks into the copied Chinese definitions"
    // guard now applies there specifically, not to the whole payload —
    // the header line is excluded by construction (checked separately
    // above), so this scoped check can never trivially pass by accident.
    const body = lines.slice(2).join("\n");
    expect(body).not.toContain("méng");

    let cursor = -1;
    for (const text of defTexts) {
      const idx = body.indexOf(text.trim());
      expect(idx).toBeGreaterThan(cursor);
      cursor = idx;
    }

    // No UI chrome / action labels leak into the payload.
    expect(copied).not.toContain("複製解釋");
    expect(copied).not.toContain("已複製");
    expect(copied).not.toContain("加入字詞記錄簿");
  });

  test("keyboard Enter on the focused button copies and shows the success status", async ({
    page,
  }) => {
    await page.goto("/%E8%90%8C");
    await waitForEntryHydration(page, "萌");
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) =>
            ((window as Window & { __copied?: string }).__copied = value),
        },
      });
    });
    const button = page.getByRole("button", { name: "複製解釋" });
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".entry-copy-status")).toHaveText("已複製");
    const copied = await page.evaluate(
      () => (window as Window & { __copied?: string }).__copied ?? "",
    );
    expect(copied.length).toBeGreaterThan(0);
  });

  test("clipboard rejection uses the real textarea fallback", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => Promise.reject(new Error("denied")) },
      });
      document.execCommand = ((command: string) =>
        command === "copy") as typeof document.execCommand;
    });
    await page.goto("/%E8%90%8C");
    await waitForEntryHydration(page, "萌");
    await page.getByRole("button", { name: "複製解釋" }).click();
    await expect(page.locator(".entry-copy-status")).toHaveText("已複製");
  });

  test("shows the failure status when both clipboard APIs are unavailable", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => Promise.reject(new Error("denied")) },
      });
      document.execCommand = (() => false) as typeof document.execCommand;
    });
    await page.goto("/%E8%90%8C");
    await waitForEntryHydration(page, "萌");
    await page.getByRole("button", { name: "複製解釋" }).click();
    await expect(page.locator(".entry-copy-status")).toHaveText("複製失敗，請手動選取文字");
  });

  test("multi-heteronym entries: one button copies every heteronym's definitions in order, newline-separated", async ({
    page,
  }) => {
    await page.goto("/'%E9%A3%9F");
    await waitForEntryHydration(page, "食");
    const entries = page.locator(".entry");
    const entryCount = await entries.count();
    expect(entryCount).toBeGreaterThan(1);
    // Exactly one copy button total — not one per heteronym.
    await expect(page.getByRole("button", { name: "複製解釋" })).toHaveCount(1);

    const firstDef = (await entries.nth(0).locator(".definition .def").first().innerText()).trim();
    const lastDef = (
      await entries
        .nth(entryCount - 1)
        .locator(".definition .def")
        .first()
        .innerText()
    ).trim();

    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) =>
            ((window as Window & { __copied?: string }).__copied = value),
        },
      });
    });
    await page.getByRole("button", { name: "複製解釋" }).click();
    await expect(page.locator(".entry-copy-status")).toHaveText("已複製");
    const copied = await page.evaluate(
      () => (window as Window & { __copied?: string }).__copied ?? "",
    );
    const firstIdx = copied.indexOf(firstDef);
    const lastIdx = copied.indexOf(lastDef);
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(lastIdx).toBeGreaterThan(firstIdx);
    // Heteronym blocks are newline-separated (at least one newline per
    // heteronym boundary).
    expect(copied.split("\n").length).toBeGreaterThanOrEqual(entryCount);
  });

  test("'廿一 (t): single-heteronym entry still gets a `headword（reading）` header — untagged, no per-character autolink markup", async ({
    page,
  }) => {
    // 廿一 (ptck bucket 127, seeded in tests/helpers/fixtures.ts):
    // single-heteronym multi-character taigi record — the header is
    // unconditional now (fix/heteronym-order-sutian scope addition), so
    // even a single-heteronym page must carry it. Multi-character titles
    // come back from the API as per-character `<a href="...">X</a>`
    // autolink HTML (data-title on h1.title) — the header must be
    // untag()-stripped plain text, not leak raw markup into the payload.
    //
    // NOTE: does not use waitForEntryHydration(page, "廿一") — for
    // multi-char taigi (lang=t) titles the rendered ruby markup interleaves
    // zhuyin/romanization glyphs BETWEEN each character in body.innerText
    // (e.g. "廿ㆢㄧㄚㆴ̇一ㄧㆵ..."), so the literal contiguous substring
    // "廿一" never appears there — the same reason the existing /'長褲
    // test above waits on `h1.title` visibility instead of a body text
    // match. Waiting on the copy button (definitions loaded + rendered)
    // is an equally strong hydration signal for this test's purposes.
    const response = await page.goto("/'%E5%BB%BF%E4%B8%80");
    expect(response?.status()).toBe(200);
    await page.locator("h1.title").waitFor({ state: "visible", timeout: 15_000 });

    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) =>
            ((window as Window & { __copied?: string }).__copied = value),
        },
      });
    });
    await expect(page.getByRole("button", { name: "複製解釋" })).toHaveCount(1);
    await page.getByRole("button", { name: "複製解釋" }).click();
    await expect(page.locator(".entry-copy-status")).toHaveText("已複製");
    const copied = await page.evaluate(
      () => (window as Window & { __copied?: string }).__copied ?? "",
    );

    const lines = copied.split("\n");
    expect(lines[0]).toBe("廿一（jia̍p-it/lia̍p-it）");
    expect(copied).not.toContain("<a ");
    expect(copied).not.toContain("href=");
  });

  test("'一 (t): whole-entry copy labels BOTH heteronym sections, keeps group labels, and strips zhuyin from examples", async ({
    page,
  }) => {
    // 一 (ptck bucket 0, seeded in tests/helpers/fixtures.ts): real
    // multi-heteronym record, tsi̍t and it, each with 數/形/副 groups and
    // taigi examples carrying real <zhuyin>/<yin>/<diao> text nodes (unlike
    // the CSS-generated-content romanization overlay). User-reported
    // regression: the payload looked like the `it` reading was entirely
    // missing (it wasn't — both heteronyms' groups were already
    // serialized, just with no label distinguishing which reading each
    // section belonged to) and example sentences leaked raw zhuyin glyphs.
    // Display order is it THEN tsi̍t (fix/heteronym-order-sutian):
    // sutian.moe.edu.tw's own /tshiau/ lists the real-headword reading
    // (it, 異用字 壹) before the 替字 substitution reading (tsi̍t, real
    // char 蜀) — see src/utils/heteronym-order.ts.
    const response = await page.goto("/'%E4%B8%80");
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "一");

    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) =>
            ((window as Window & { __copied?: string }).__copied = value),
        },
      });
    });
    await expect(page.getByRole("button", { name: "複製解釋" })).toHaveCount(1);
    await page.getByRole("button", { name: "複製解釋" }).click();
    await expect(page.locator(".entry-copy-status")).toHaveText("已複製");
    const copied = await page.evaluate(
      () => (window as Window & { __copied?: string }).__copied ?? "",
    );

    // Both heteronym sections are present and labeled with their actual
    // displayed reading, in DISPLAY order: real headword (it) first, then
    // the 替 substitution reading (tsi̍t) — see heteronym-order.ts.
    const itIdx = copied.indexOf("一（it）");
    const tsitIdx = copied.indexOf("一（tsi̍t）");
    expect(itIdx).toBeGreaterThanOrEqual(0);
    expect(tsitIdx).toBeGreaterThan(itIdx);

    // Group labels (part-of-speech badges) survive as their own lines,
    // once per heteronym section (數/形/副 each appear in both).
    expect(copied.match(/^數$/gm)?.length).toBe(2);
    expect(copied.match(/^形$/gm)?.length).toBe(2);
    expect(copied.match(/^副$/gm)?.length).toBe(2);

    // No zhuyin glyphs anywhere in the payload — <zhuyin>/<yin>/<diao> text
    // nodes must be fully stripped from every example, in both sections.
    // eslint-disable-next-line no-control-regex -- Bopomofo/zhuyin block, not a control character.
    const zhuyinPattern = /[\u3100-\u312F\u31A0-\u31BF]/;
    expect(copied).not.toMatch(zhuyinPattern);
    expect(copied).not.toContain("ㄐㄧㆵ̇");

    // Example sentence + translation formatting: base taigi text, sentence-
    // final punctuation kept before the paren, translation in parens.
    expect(copied).toContain("例：一蕊花（一朵花）");
    expect(copied).toContain("例：紅嬰仔哭甲一身軀汗。（小嬰兒哭得滿身大汗。）");
    // No-translation example: no trailing empty parens.
    expect(copied).toContain("例：一流");
    expect(copied).not.toContain("一流（）");

    // No UI chrome leaks into the payload.
    expect(copied).not.toContain("複製解釋");
    expect(copied).not.toContain("已複製");
  });

  test("'一 (t): heteronym sections render real-headword (it) before the 替 substitution reading (tsi̍t), matching sutian.moe.edu.tw /tshiau/ ordering", async ({
    page,
  }) => {
    // sutian.moe.edu.tw's own 詞目查詢 (/zh-hant/tshiau/?lui=tai_su&tsha=一)
    // lists 一's real-headword reading (it, 異用字 壹, https://sutian.moe.
    // edu.tw/zh-hant/su/2/) before its 替字 substitution reading (tsi̍t,
    // real character 蜀, 異用字 蜀, https://sutian.moe.edu.tw/zh-hant/su/1/).
    // Our ptck pack stores heteronyms in su/N id order — [tsi̍t(id=1),
    // it(id=2)] — the OPPOSITE of sutian's real-headword-first convention;
    // this is display-order-only (src/utils/heteronym-order.ts), no pack
    // byte changes.
    const response = await page.goto("/'%E4%B8%80");
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "一");

    const entries = page.locator(".entry");
    await expect(entries).toHaveCount(2);
    await expect(entries.nth(0)).toHaveAttribute("data-reading", "it");
    await expect(entries.nth(1)).toHaveAttribute("data-reading", "tsi̍t");

    // The 替 badge (g0v/moedict-webkit#96/#233) renders on the tsi̍t
    // (substitution) section only — the real-headword (it) section has no
    // reading-type classification in the pack, so no badge.
    await expect(entries.nth(0).locator(".reading-type")).toHaveCount(0);
    await expect(entries.nth(1).locator(".reading-type")).toHaveText("替");
    await expect(entries.nth(1).locator(".reading-type")).toHaveAttribute(
      "title",
      "替代字讀音（訓用字）",
    );
  });

  test("entry actions expose themed hover contrast and visible focus rings", async ({ page }) => {
    await page.goto("/%E8%90%8C");
    await waitForEntryHydration(page, "萌");
    const row = page.locator(".entry-actions").first();
    for (const selector of [".entry-copy-button", "a.variants-link", ".star"]) {
      const control = row.locator(selector);
      await control.hover();
      await control.focus();
      await expect
        .poll(() => control.evaluate((el) => getComputedStyle(el).outlineWidth))
        .toBe("2px");
    }
    const colors = await row.locator(".entry-copy-button").evaluate((el) => {
      const style = getComputedStyle(el);
      return { background: style.backgroundColor, color: style.color };
    });
    expect(colors.background).not.toBe(colors.color);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    const darkColors = await row.locator(".star").evaluate((el) => {
      const style = getComputedStyle(el);
      return { background: style.backgroundColor, color: style.color };
    });
    expect(darkColors.background).toBe("rgb(42, 42, 42)");
    expect(darkColors.color).toBe("rgb(230, 227, 223)");
  });
  test("desktop: action row is right-aligned below the radical/stroke row", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/%E8%90%8C");
    await waitForEntryHydration(page, "萌");
    const row = page.locator(".entry-actions").first();
    const radical = page.locator(".radical").first();
    await expect(row).toBeVisible();
    const star = row.locator(".star");
    const copyBtn = row.locator(".entry-copy-button");
    const variantsLink = row.locator("a.variants-link");
    const [rowBox, radicalBox, starBox, copyBox, variantsBox] = await Promise.all([
      row.boundingBox(),
      radical.boundingBox(),
      star.boundingBox(),
      copyBtn.boundingBox(),
      variantsLink.boundingBox(),
    ]);
    expect(rowBox && radicalBox && starBox && copyBox && variantsBox).toBeTruthy();
    if (!rowBox || !radicalBox || !starBox || !copyBox || !variantsBox) return;

    expect(
      Math.abs(rowBox.x + rowBox.width - (radicalBox.x + radicalBox.width)),
    ).toBeLessThanOrEqual(2);
    expect(rowBox.y).toBeGreaterThanOrEqual(radicalBox.y + radicalBox.height - 2);
    expect(copyBox.x + copyBox.width).toBeLessThanOrEqual(variantsBox.x + 1);

    expect(variantsBox.x + variantsBox.width).toBeLessThanOrEqual(starBox.x + 1);
    expect(copyBox.width).toBeCloseTo(variantsBox.width, 5);
    expect(variantsBox.width).toBeCloseTo(starBox.width, 5);
    expect(copyBox.height).toBeCloseTo(variantsBox.height, 5);
    expect(variantsBox.height).toBeCloseTo(starBox.height, 5);
    for (const box of [starBox, copyBox, variantsBox]) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(1280 + 1);
    }
  });
  test("action dimensions stay equal at 200% zoom", async ({ page }) => {
    await page.goto("/%E8%90%8C");
    await waitForEntryHydration(page, "萌");
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    const sizes = await page.locator(".entry-actions").evaluate((row) =>
      [".entry-copy-button", "a.variants-link", ".star"].map((selector) => {
        const rect = row.querySelector(selector)!.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    );
    expect(sizes[0].width).toBeCloseTo(sizes[1].width, 5);
    expect(sizes[1].width).toBeCloseTo(sizes[2].width, 5);
    expect(sizes[0].height).toBeCloseTo(sizes[1].height, 5);
    expect(sizes[1].height).toBeCloseTo(sizes[2].height, 5);
  });

  test("mobile: action row remains right-aligned below radical without overlap", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/%E8%90%8C");
    await waitForEntryHydration(page, "萌");
    const row = page.locator(".entry-actions").first();
    const radical = page.locator(".radical").first();
    await expect(row).toBeVisible();
    const star = row.locator(".star");
    const copyBtn = row.locator(".entry-copy-button");
    const variantsLink = row.locator("a.variants-link");
    const [rowBox, radicalBox, starBox, copyBox, variantsBox] = await Promise.all([
      row.boundingBox(),
      radical.boundingBox(),
      star.boundingBox(),
      copyBtn.boundingBox(),
      variantsLink.boundingBox(),
    ]);
    expect(rowBox && radicalBox && starBox && copyBox && variantsBox).toBeTruthy();
    if (!rowBox || !radicalBox || !starBox || !copyBox || !variantsBox) return;
    for (const box of [copyBox, variantsBox, starBox]) {
      expect(box.width).toBe(44);
      expect(box.height).toBe(44);
    }

    expect(
      Math.abs(rowBox.x + rowBox.width - (radicalBox.x + radicalBox.width)),
    ).toBeLessThanOrEqual(2);
    expect(rowBox.y).toBeGreaterThanOrEqual(radicalBox.y + radicalBox.height - 2);
    const boxes = [starBox, copyBox, variantsBox];
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(375 + 1);
    }
    const overlaps = (a: typeof starBox, b: typeof starBox) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    expect(overlaps(starBox, copyBox)).toBe(false);
    expect(overlaps(copyBox, variantsBox)).toBe(false);
    expect(copyBox.x + copyBox.width).toBeLessThanOrEqual(variantsBox.x + 1);
    expect(variantsBox.x + variantsBox.width).toBeLessThanOrEqual(starBox.x + 1);
  });
  test("mobile: extra action buttons wrap below the title instead of stealing heading width", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 333, height: 700 });
    // 萌芽 is in the seeded 萌 pack bucket; 韓非子 is a production headword
    // that the curated e2e fixtures do not load (falls through to 字卡).
    await page.goto("/%E8%90%8C%E8%8A%BD");
    await waitForEntryHydration(page, "萌芽");
    const titleLocator = page.locator("h1.title").first();
    await expect(titleLocator).toBeVisible();
    const radical = page.locator(".radical").first();
    const actions = page.locator(".entry-actions").first();
    const heading = page.locator(".entry-heading").first();
    const [titleBox, radicalBox, actionsBox, headingBox] = await Promise.all([
      titleLocator.boundingBox(),
      radical.boundingBox(),
      actions.boundingBox(),
      heading.boundingBox(),
    ]);
    expect(titleBox && radicalBox && actionsBox && headingBox).toBeTruthy();
    if (!titleBox || !radicalBox || !actionsBox || !headingBox) return;
    expect(actionsBox.y).toBeGreaterThanOrEqual(radicalBox.y + radicalBox.height - 2);
    expect(
      Math.abs(actionsBox.x + actionsBox.width - (radicalBox.x + radicalBox.width)),
    ).toBeLessThanOrEqual(2);
    // Title keeps the leftover column beside the compact radical (~37px),
    // not beside the 8rem status + icon cluster (~180px).
    expect(titleBox.width).toBeGreaterThan(headingBox.width * 0.7);
    expect(radicalBox.width).toBeLessThan(80);
  });
  test("mobile: enlarged long title reserves controls and preserves Hakka adjacency", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 700 });
    await page.goto("/%E8%90%8C%E8%8A%BD");
    await waitForEntryHydration(page, "萌芽");
    await page
      .locator("h1.title")
      .first()
      .evaluate((element) => {
        element.setAttribute("style", "font-size: 64px; line-height: 1.2");
      });
    const heading = page.locator(".entry-heading").first();
    const radical = page.locator(".radical").first();
    const actions = page.locator(".entry-actions").first();
    const titleLocator = page.locator("h1.title").first();
    const firstItem = page.locator(".entry-item").first();
    const [headingBox, radicalBox, actionsBox, titleBox, itemBox] = await Promise.all([
      heading.boundingBox(),
      radical.boundingBox(),
      actions.boundingBox(),
      titleLocator.boundingBox(),
      firstItem.boundingBox(),
    ]);
    expect(headingBox && radicalBox && actionsBox && titleBox && itemBox).toBeTruthy();
    if (!headingBox || !radicalBox || !actionsBox || !titleBox || !itemBox) return;
    expect(radicalBox.x).toBeGreaterThanOrEqual(0);
    expect(radicalBox.x + radicalBox.width).toBeLessThanOrEqual(375 + 1);
    expect(actionsBox.x).toBeGreaterThanOrEqual(0);
    expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(375 + 1);
    expect(actionsBox.y).toBeGreaterThanOrEqual(radicalBox.y + radicalBox.height - 2);
    const titleRects = await titleLocator.evaluate((title) => {
      const range = document.createRange();
      const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
      const rects: Array<{ left: number; right: number; top: number; bottom: number }> = [];
      let node: Node | null;
      while ((node = walker.nextNode())) {
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.width > 0 && rect.height > 0) {
            rects.push({
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            });
          }
        }
      }
      return rects;
    });
    const tolerance = 1;
    const separatedFrom = (
      rect: { left: number; right: number; top: number; bottom: number },
      box: { x: number; y: number; width: number; height: number },
    ) =>
      rect.right <= box.x + tolerance ||
      rect.left >= box.x + box.width - tolerance ||
      rect.bottom <= box.y + tolerance ||
      rect.top >= box.y + box.height - tolerance;
    for (const rect of titleRects) {
      expect(separatedFrom(rect, radicalBox)).toBe(true);
      expect(separatedFrom(rect, actionsBox)).toBe(true);
    }
    expect(itemBox.y).toBeGreaterThanOrEqual(
      Math.max(titleBox.y + titleBox.height, actionsBox.y + actionsBox.height) - 1,
    );
    await page.goto("/%3A%E5%AD%97");
    await expect(page.locator("h1.title").first()).toContainText("字", { timeout: 15_000 });
    const adjacency = await page
      .locator("h1.title")
      .first()
      .evaluate((title) => {
        const next = title.nextElementSibling;
        return {
          className: next?.className ?? "",
          display: next ? getComputedStyle(next).display : "",
        };
      });
    expect(adjacency.className).toContain("bopomofo");
    expect(adjacency.display).not.toBe("none");
  });
});

test.describe("copy accessibility and serialization contracts", () => {
  test("copy button activates with Space and keeps status geometry stable", async ({ page }) => {
    await page.goto("/%E8%90%8C");
    await waitForEntryHydration(page, "萌");
    const copy = page.getByRole("button", { name: "複製解釋" });
    const status = page.locator(".entry-copy-status");
    await expect(status).toHaveText("\u00a0");
    const boxesBefore = await page
      .locator(".entry-copy-button, .variants-link, .star")
      .evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
        }),
      );
    await copy.focus();
    await page.keyboard.press(" ");
    await expect(status).toHaveText("已複製");
    const boxesDuring = await page
      .locator(".entry-copy-button, .variants-link, .star")
      .evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
        }),
      );
    expect(boxesDuring).toEqual(boxesBefore);
    await expect(status).toHaveText("\u00a0", { timeout: 4_000 });
    const boxesAfter = await page
      .locator(".entry-copy-button, .variants-link, .star")
      .evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
        }),
      );
    expect(boxesAfter).toEqual(boxesBefore);
    await page.goto("/'%E9%A3%9F");
    await expect(page.locator(".entry-copy-status")).toHaveText("\u00a0");
  });

  test("action row right edge aligns with the radical-box row above it (not shifted left by the reserved status placeholder)", async ({
    page,
  }) => {
    // Regression guard: .entry-copy-status (min-width: 8rem reservation for
    // the zero-layout-shift contract above) must be the FIRST child of
    // .entry-actions, not the last -- under justify-content: flex-end, a
    // trailing reservation occupies the rightmost slot and pushes every
    // visible icon ~8rem+gap left of where the radical-box row above ends,
    // breaking the visual right-alignment between the two stacked rows.
    await page.goto("/%E8%90%8C");
    await waitForEntryHydration(page, "萌");

    const domOrder = await page
      .locator(".entry-actions")
      .evaluate((el) => Array.from(el.children).map((c) => c.className));
    expect(domOrder[0]).toContain("entry-copy-status");

    const stackRight = await page
      .locator(".entry-control-stack")
      .evaluate((el) => el.getBoundingClientRect().right);
    const radicalRight = await page
      .locator(".entry-control-stack .radical")
      .evaluate((el) => el.getBoundingClientRect().right);
    const starRight = await page
      .locator(".entry-actions .star")
      .evaluate((el) => el.getBoundingClientRect().right);
    const pencilRight = await page
      .locator(".entry-control-stack .radical .iconic-circle.stroke")
      .evaluate((el) => el.getBoundingClientRect().right);

    const tolerance = 1;
    expect(Math.abs(stackRight - radicalRight)).toBeLessThanOrEqual(tolerance);
    // The star (last visible action icon) must align with the pencil (last
    // radical-row icon) -- the exact alignment the user-reported regression
    // broke.
    expect(Math.abs(starRight - pencilRight)).toBeLessThanOrEqual(tolerance);
  });

  test("ordered copy payload keeps numbering and definition separation", async ({ page }) => {
    await page.goto("/%E8%90%8C");
    await waitForEntryHydration(page, "萌");
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) =>
            ((window as Window & { __copied?: string }).__copied = value),
        },
      });
    });
    const copy = page.getByRole("button", { name: "複製解釋" });
    await expect(copy).toHaveCount(1);
    await copy.click();
    const copied = await page.evaluate(
      () => (window as Window & { __copied?: string }).__copied ?? "",
    );
    expect(copied).toMatch(/1\./);
    expect(copied).toMatch(/2\./);
    expect(copied).toMatch(/1\.[\s\S]*\n[\s\S]*2\./);
    expect(copied.indexOf("1.")).toBeLessThan(copied.indexOf("2."));
  });
  test("c-language copy excludes the visible 简 badge", async ({ page }) => {
    await page.goto("/~%E4%B8%8A%E8%A8%B4");
    await waitForEntryHydration(page, "上訴");
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) =>
            ((window as Window & { __copied?: string }).__copied = value),
        },
      });
    });
    await expect(page.getByRole("button", { name: "複製解釋" })).toHaveCount(1);
    await page.getByRole("button", { name: "複製解釋" }).click();
    const copied = await page.evaluate(
      () => (window as Window & { __copied?: string }).__copied ?? "",
    );
    expect(copied).toContain(
      (await page.locator(".entry .definition .def").first().innerText()).trim(),
    );
    expect(copied).not.toContain("简");
  });
});

test.describe("charimg-result romanize checkbox (RESCOPE #169)", () => {
  // 萌黃 has no whole-word dictionary entry (confirmed: not a key in
  test.describe("CharacterImage safety and Hakka no-op", () => {
    test("Hakka romanize is disabled and never adds romanize URL parameters", async ({ page }) => {
      await page.addInitScript(() => window.localStorage.setItem("charimg-romanize", "1"));
      await page.goto("/:%E8%90%8C%E9%BB%83");
      const result = page.locator(".charimg-result");
      await result.waitFor({ state: "visible", timeout: 15_000 });
      await expect(page.locator("#charimg-romanize")).toBeDisabled();
      const srcs = await page
        .locator("img.charimg-glyph")
        .evaluateAll((els) => els.map((el) => (el as HTMLImageElement).src));
      expect(srcs.every((src) => !src.includes("romanize=1"))).toBe(true);
      await expect(page.locator("#charimg-romanize")).toHaveAttribute("disabled", "");
      await expect(page.getByText("客語字圖目前不提供羅馬拼音")).toBeVisible();
      await expect(result.locator("script, img[onerror], svg[onload]")).toHaveCount(0);
    });
  });

  // data/dictionary/pack/12.txt), so DictionaryPage's whole-word lookup 404s
  // and falls back to per-character fuzzy search (state.terms = ["萌","黃"]),
  // rendering CharacterImageView instead of the normal .result entry view.
  // Both individual characters have real dictionary entries with pinyin +
  // bopomofo (data/dictionary/pack/12.txt / 707.txt), so loadSegments()
  // resolves real romanization data once the checkbox is checked.
  const FALLBACK_PATH = "/%E8%90%8C%E9%BB%83";

  test("toggling the checkbox updates img src (romanize=1&lang=a), shows the caption, and persists to localStorage", async ({
    page,
  }) => {
    const response = await page.goto(FALLBACK_PATH);
    expect(response?.status()).toBe(200);
    await page.locator(".charimg-result").waitFor({ state: "visible", timeout: 15_000 });

    // Segment rows render after loadSegments() resolves — wait for the first
    // segment glyph image instead of the "載入中..." placeholder row.
    const segmentImg = page.locator("img.charimg-glyph-segment").first();
    await segmentImg.waitFor({ state: "visible", timeout: 15_000 });

    const checkbox = page.locator("#charimg-romanize");
    await expect(checkbox).not.toBeChecked();

    // Before toggling: no romanize/lang query params, no caption.
    const srcBefore = await segmentImg.getAttribute("src");
    expect(srcBefore).not.toContain("romanize=1");
    expect(srcBefore).not.toContain("lang=");
    await expect(page.locator(".charimg-caption")).toHaveCount(0);

    await checkbox.check();
    await expect(checkbox).toBeChecked();

    // After toggling: img src carries romanize=1&lang=a (page is lang=a, no
    // route prefix), and the on-page caption renders real pinyin/bopomofo
    // reused from the same loadSegments() fetch — not fetched again.
    await expect(async () => {
      const src = await segmentImg.getAttribute("src");
      expect(src).toContain("romanize=1");
      expect(src).toContain("lang=a");
    }).toPass({ timeout: 5_000 });

    const caption = page.locator(".charimg-caption").first();
    await expect(caption).toBeVisible();
    await expect(caption.locator(".pinyin")).toBeVisible();
    await expect(caption.locator(".bopomofo")).toBeVisible();
    const pinyinText = await caption.locator(".pinyin").innerText();
    expect(pinyinText.length).toBeGreaterThan(0);

    expect(await page.evaluate(() => window.localStorage.getItem("charimg-romanize"))).toBe("1");

    // Reload: the checked state and img src both persist from localStorage.
    await page.reload();
    await page.locator(".charimg-result").waitFor({ state: "visible", timeout: 15_000 });
    await page.locator("img.charimg-glyph-segment").first().waitFor({ state: "visible" });
    await expect(page.locator("#charimg-romanize")).toBeChecked();
    const srcAfterReload = await page
      .locator("img.charimg-glyph-segment")
      .first()
      .getAttribute("src");
    expect(srcAfterReload).toContain("romanize=1");

    // Unchecking removes the caption and the query params again, and persists "0".
    await page.locator("#charimg-romanize").uncheck();
    await expect(page.locator(".charimg-caption")).toHaveCount(0);
    expect(await page.evaluate(() => window.localStorage.getItem("charimg-romanize"))).toBe("0");
  });

  test("og:image / twitter:image never carry romanize=1 regardless of the stored checkbox preference", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("charimg-romanize", "1");
    });
    const response = await page.goto(FALLBACK_PATH);
    expect(response?.status()).toBe(200);
    await page.locator(".charimg-result").waitFor({ state: "visible", timeout: 15_000 });
    await waitForAppReady(page, "dictionary");

    const ogImage = await page.locator('meta[property="og:image"]').getAttribute("content");
    const twitterImage = await page.locator('meta[name="twitter:image"]').getAttribute("content");
    expect(ogImage).not.toBeNull();
    expect(twitterImage).not.toBeNull();
    expect(ogImage).not.toContain("romanize");
    expect(twitterImage).not.toContain("romanize");
    expect(ogImage).toMatch(/\.png$/);
    expect(twitterImage).toMatch(/\.png$/);
  });
});

// Guards the CSS cascade on desktop WebKit: with the real legacy stylesheet
// injected, search/query inputs must not compute a Biaodian family. This
// cannot detect a missing system font on a device.
test.describe("@romanization search input font-family cascade on desktop WebKit", () => {
  test("desktop WebKit computed font-family with real legacy CSS has no Biaodian", async ({
    page,
  }) => {
    const stylesCss = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "assets", "styles.css"),
      "utf-8",
    );
    const fulfillLegacyCss = (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: "text/css; charset=utf-8",
        headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        body: stylesCss,
      });
    await page.route("https://r2-assets.test.local/styles.css", fulfillLegacyCss);
    await page.route("https://r2-assets.test.local/styles.css?*", fulfillLegacyCss);
    await page.route("**/assets/styles.css", fulfillLegacyCss);
    await page.route("**/assets/styles.css?*", fulfillLegacyCss);

    await page.goto("/%E8%90%8C");
    await waitForAppReady(page, "dictionary");
    await page.waitForFunction(() => {
      const link = document.querySelector<HTMLLinkElement>('link[data-asset-id="styles-css"]');
      return link?.sheet != null;
    });

    const assertSafeInputStack = async (
      selector: string,
      expected: { value: string; placeholder: string },
    ) => {
      const inputs = page.locator(selector);
      const count = await inputs.count();
      expect(count, `${selector} must exist`).toBeGreaterThan(0);
      for (let i = 0; i < count; i += 1) {
        const snapshot = await inputs.nth(i).evaluate((el) => {
          const inputEl = el as HTMLInputElement;
          return {
            fontFamily: getComputedStyle(inputEl).fontFamily,
            value: inputEl.value,
            placeholder: inputEl.getAttribute("placeholder"),
          };
        });
        expect(snapshot.fontFamily, `${selector}[${i}] computed font-family`).not.toMatch(
          /Biaodian/i,
        );
        expect(
          snapshot.fontFamily,
          `${selector}[${i}] includes a CJK system face or generic`,
        ).toMatch(/PingFang TC|Heiti TC|Microsoft JhengHei|sans-serif/i);
        expect(snapshot.value, `${selector}[${i}] value`).toBe(expected.value);
        expect(snapshot.placeholder, `${selector}[${i}] placeholder`).toBe(expected.placeholder);
      }
    };

    await assertSafeInputStack("#nav-fulltext-search", { value: "", placeholder: "多語檢索" });
    await assertSafeInputStack("#query", { value: "萌", placeholder: "請輸入欲查詢的字詞" });

    await page.evaluate(() => {
      document.documentElement.classList.add("moe-capacitor", "moe-ios");
    });
    await assertSafeInputStack("#nav-fulltext-search", { value: "", placeholder: "多語檢索" });
    await assertSafeInputStack("#query", { value: "萌", placeholder: "請輸入欲查詢的字詞" });
  });
});
