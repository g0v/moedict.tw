/**
 * Regression for closed issues #39 / #81: the About page's "Fork me on
 * GitHub" banner and inline source link must point at the g0v/moedict.tw
 * repo, not a fork. Also guards the page title (#47).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vite-plus/test";
import { About } from "../../src/pages/About";
import { resolveHeadByPath } from "../../src/ssr/head";

function render(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <About assetBaseUrl="https://r2-assets.test.local" />
    </MemoryRouter>,
  );
}

describe("About page links", () => {
  it("includes the canonical g0v/moedict.tw GitHub link (inline)", () => {
    const html = render();
    expect(html).toContain('href="https://github.com/g0v/moedict.tw"');
  });

  it("does not link to the old moedict/moedict-webkit repo", () => {
    const html = render();
    expect(html).not.toMatch(/moedict\/moedict-webkit/);
    expect(html).not.toMatch(/audreyt\/moedict-webkit/);
  });
});

describe("About page title (#47)", () => {
  it("/about resolves to a 關於 title via resolveHeadByPath", () => {
    const head = resolveHeadByPath("/about");
    expect(head.title).toMatch(/關於/);
  });
});

describe("About page usage guide (#95)", () => {
  it("has a prominent link near the top that jumps to the #how-to-use section", () => {
    const html = render();
    expect(html).toContain('href="#how-to-use"');
    expect(html).toContain("萌典功能使用說明");
  });

  it("renders the same-page 使用說明 section (no extra route)", () => {
    const html = render();
    expect(html).toContain('id="how-to-use"');
    expect(html).toMatch(/<h2[^>]*>\s*使用說明\s*<\/h2>/);
  });

  it("lists the key features described in the issue", () => {
    const html = render();
    for (const feature of [
      "字詞發音",
      "多重表記",
      "部首查詢",
      "部首表",
      "筆順動畫",
      "字詞記錄簿",
      "萬用字元查詢",
      "多語檢索",
      "發音檢索",
      "字圖生成與鏤空描寫模式",
      "匯出閱讀器可用的字典格式",
    ]) {
      expect(html).toContain(feature);
    }
  });

  it("uses real in-site routes as live examples instead of adding a new route", () => {
    const html = render();
    // 部首表 / 字詞記錄簿 / 字圖生成 皆為實際可導覽的站內路由
    expect(html).toContain('href="/@"');
    expect(html).toContain('href="/=*"');
    expect(html).toContain('href="/萌典是什麼"');
  });

  it("does not link search-box-only examples to non-existent entry routes", () => {
    const html = render();
    // 萬用字元 / 多語檢索 / 發音檢索 屬搜尋框功能，直接導覽會落到查無此字／字圖頁，故不附連結
    for (const fakeHref of ['href="/休."', 'href="/休.."', 'href="/cat"', 'href="/di"']) {
      expect(html).not.toContain(fakeHref);
    }
    // 仍以純文字呈現範例字串
    expect(html).toContain("「休.」");
    expect(html).toContain("「cat」");
    expect(html).toContain("「di」");
  });

  it("has a prominent link near the top that jumps to the #api section (#159)", () => {
    const html = render();
    expect(html).toContain('href="#api"');
    expect(html).toContain("API 串接說明");
  });

  it("embeds the guide screenshots as clickable thumbnails (#95)", () => {
    const html = render();
    // 每張截圖都是可點擊放大的縮圖按鈕
    expect(html).toContain('class="guide-figure-button"');
    const thumbCount = (html.match(/guide-figure-button/g) ?? []).length;
    expect(thumbCount).toBe(13);
    // 中文檔名以 encodeURIComponent 編碼後出現在 /images/guide/ 之下
    for (const name of [
      "萬用字元_resized.jpg",
      "多語檢索_resized.jpg",
      "發音_客語_resized.jpg",
      "字圖生成與鏤空描寫模式_resized.jpg",
    ]) {
      expect(html).toContain("/images/guide/" + encodeURIComponent(name));
    }
    // 截圖一律走 public 靜態資產（非 R2 /assets/ 代理）
    expect(html).not.toContain("/assets/images/guide/");
  });
});

describe("About page API documentation (#159)", () => {
  it("renders the same-page API 串接說明 section (no extra route)", () => {
    const html = render();
    expect(html).toContain('id="api"');
    expect(html).toMatch(/<h2[^>]*>\s*API 串接說明\s*<\/h2>/);
  });

  it("documents the JSON dictionary endpoints for all four dictionaries", () => {
    const html = render();
    // 各語系 JSON 端點的可點擊範例（華語/台語/客語/兩岸）
    expect(html).toContain("https://www.moedict.tw/a/萌.json");
    expect(html).toContain("https://www.moedict.tw/t/水.json");
    expect(html).toContain("https://www.moedict.tw/h/日頭.json");
    expect(html).toContain("https://www.moedict.tw/c/計算機.json");
    // 純文字格式端點
    expect(html).toContain("https://www.moedict.tw/raw/萌.json");
    expect(html).toContain("https://www.moedict.tw/uni/萌.json");
  });

  it("documents the character-image PNG endpoint and its parameters", () => {
    const html = render();
    expect(html).toContain("https://www.moedict.tw/萌.png");
    expect(html).toContain("font=ebas");
    // romanize 參數（HTML 實體編碼後的 & 會是 &amp;）
    expect(html).toContain("romanize=1");
  });

  it("includes a JSON data example with recognisable fields", () => {
    const html = render();
    for (const field of ["heteronyms", "bopomofo", "definitions", "stroke_count"]) {
      expect(html).toContain(field);
    }
  });
});
