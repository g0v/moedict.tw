import type { Page, Route } from "@playwright/test";
import { expect, test } from "./_fixtures";

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
  await page.waitForLoadState("networkidle");
  await expect(page.locator("body")).toContainText(titleFragment, { timeout: 15_000 });
}

async function gotoFirstTitleEntry(
  page: Page,
  candidates: Array<{ path: string; title: string }>,
): Promise<{ path: string; title: string }> {
  for (const candidate of candidates) {
    const response = await page.goto(candidate.path);
    expect(response?.status()).toBe(200);
    await page.waitForLoadState("networkidle");
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

  test("'食 (t) — 台語萌典", async ({ page }) => {
    const response = await page.goto("/'%E9%A3%9F");
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "食");
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
  });

  test(":字 (h) — 客語萌典", async ({ page }) => {
    const response = await page.goto("/%3A%E5%AD%97");
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "字");
  });

  test("~上訴 (c) — 兩岸萌典", async ({ page }) => {
    const response = await page.goto("/~%E4%B8%8A%E8%A8%B4");
    expect(response?.status()).toBe(200);
    await waitForEntryHydration(page, "上訴");
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
  test("單字條目顯示連結到教育部異體字字典查詢頁", async ({ page }) => {
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
  });

  test("多字詞條（非單字）不顯示異體字字典連結", async ({ page }) => {
    await page.goto("/~%E4%B8%8A%E8%A8%B4");
    await waitForEntryHydration(page, "上訴");
    await expect(page.locator("a.variants-link")).toHaveCount(0);
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
      await page.waitForLoadState("networkidle");
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
    await page.waitForLoadState("networkidle");
    // The radical view has a root container; look for any CJK chars in links/buttons
    await expect(page.locator("body")).toContainText(/[一二人入]/, { timeout: 10_000 });
  });

  test("/~@ renders radical view with 兩岸 brand", async ({ page }) => {
    const response = await page.goto("/~@");
    expect(response?.status()).toBe(200);
    await page.waitForLoadState("networkidle");
  });

  test("/'@ renders radical view for 台語 (g0v/moedict-webkit#122)", async ({ page }) => {
    const response = await page.goto("/'@");
    expect(response?.status()).toBe(200);
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveTitle(/台語萌典/);
    await expect(page.locator("body")).toContainText(/[一二人入]/, { timeout: 10_000 });
  });

  test("/about shows about content", async ({ page }) => {
    const response = await page.goto("/about");
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/關於本站/);
    await page.waitForLoadState("networkidle");
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
