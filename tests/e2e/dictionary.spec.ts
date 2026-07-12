import type { Page } from "@playwright/test";
import { expect, test } from "./_fixtures";

const ANDROID_WEBVIEW_UA =
  "Mozilla/5.0 (Linux; Android 15; sdk_gphone64_arm64) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36";

const MANDARIN_VERTICAL_ZHUYIN_SAMPLES = [
  { path: "/%E8%90%8C", title: "萌" },
  { path: "/%E6%95%96", title: "敖" },
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

      let checked = 0;
      for (const sample of MANDARIN_VERTICAL_ZHUYIN_SAMPLES) {
        const response = await page.goto(sample.path);
        expect(response?.status()).toBe(200);
        await page.waitForLoadState("networkidle");
        await page.evaluate(() => document.fonts.ready);
        if ((await page.locator(".result .entry h1.title hruby.rightangle").count()) === 0) {
          continue;
        }
        checked += 1;
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
          expect(item.rbWidth, `${sample.title} ${item.text} Han square`).toBeGreaterThan(0.5);
          expect(item.rbWidth, `${sample.title} ${item.text} Han square`).toBeLessThan(1.6);
          expect(item.ruWidth, `${sample.title} ${item.text} annotated unit`).toBeGreaterThan(1.0);
          expect(item.ruWidth, `${sample.title} ${item.text} annotated unit`).toBeLessThan(5.0);
          expect(
            item.zhuyinColumnWidth,
            `${sample.title} ${item.text} zhuyin column`,
          ).toBeGreaterThan(0.1);
          expect(item.zhuyinColumnWidth, `${sample.title} ${item.text} zhuyin column`).toBeLessThan(
            3.5,
          );
          expect(
            item.zhuyinLeft,
            `${sample.title} ${item.text} zhuyin starts beside Han`,
          ).toBeGreaterThan(0);
          expect(
            item.zhuyinRight,
            `${sample.title} ${item.text} zhuyin stays in phonetic column`,
          ).toBeLessThan(4.5);
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
            expect(item.toneRight, `${sample.title} ${item.text} tone column ends`).toBeLessThan(5);
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
      }
      expect(checked).toBeGreaterThan(0);
    });
  }
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
