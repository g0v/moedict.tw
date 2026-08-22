/**
 * Regression for the audited 似/反 rendering gaps:
 *
 * R1: 台語條目的反義詞掛在 heteronym 層（API 回傳
 * `"antonyms":"<a href=\"./#'月光環'\">月光環</a>"`），舊版 UI 完全沒有 render
 * path——現在應像 legacy 一樣在 sense 區塊之後、華語 xref 之前渲染 .antonyms 反區塊。
 *
 * R2: 華語條目 definition 層的 同義詞/反義詞 舊版經 untag() 把 autolink 的
 * `<a href="./#…">` 錨點剝成純文字；現在應保留錨點（sanitizeLookupHtml 只留
 * `./#` lookup 錨點的 href），點擊由 .result 的 onContentClick 統一攔截導頁。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DictionaryPage } from "../../src/pages/DictionaryPage";

let container: HTMLDivElement;
let root: Root;

function RouteProbe(): React.ReactElement {
  const location = useLocation();
  return <span id="route-probe">{location.pathname}</span>;
}

function mockFetch(entry: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("/api/config")) {
        return new Response(JSON.stringify({ assetBaseUrl: "/assets" }), { status: 200 });
      }
      // xref/cns/stroke 端點先擋掉，避免被下面的通用詞條 regex 吃掉。
      if (/^\/api\/xref\//.test(url)) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (/^\/api\/cns\//.test(url) || url.includes("/api/stroke-json/")) {
        return new Response(null, { status: 404 });
      }
      const match = /^\/api\/(.+)\.json$/.exec(url);
      if (match) {
        return new Response(JSON.stringify(entry), { status: 200 });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }),
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // Suppress React 19 act() warning — known false positive with
  // createRoot + useEffect + happy-dom (effects fire after act returns)
  const originalConsoleError = console.error.bind(console);
  vi.spyOn(console, "error").mockImplementation((msg: unknown, ...rest: unknown[]) => {
    if (typeof msg === "string" && msg.includes("not wrapped in act")) return;
    originalConsoleError(msg, ...rest);
  });
});

afterEach(() => {
  root.unmount();
  container.remove();
  vi.unstubAllGlobals();
});

function renderEntry(word: string, lang: "a" | "t"): void {
  act(() => {
    flushSync(() => {
      root.render(
        <MemoryRouter initialEntries={[`/${lang}${word}`]}>
          <DictionaryPage word={word} lang={lang} />
          <RouteProbe />
        </MemoryRouter>,
      );
    });
  });
}

describe("heteronym-level antonyms (t-dict 反 block)", () => {
  it("renders a .antonyms block with the hyperlinked term", async () => {
    mockFetch({
      title: "月暗暝",
      heteronyms: [
        {
          id: "1",
          bopomofo: "ㄍㄜㆷ͘ ㄢ˫ ㄅㄧㄥˊ",
          antonyms: "<a href=\"./#'月光環'\">月光環</a>",
          definitions: [{ type: "名", def: "測試定義" }],
        },
      ],
    });
    renderEntry("月暗暝", "t");

    const block = await vi.waitFor(() => {
      const el = container.querySelector(".entry > .antonyms");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(block.querySelector(".part-of-speech")?.textContent).toBe("反");
    // 舊版（無 render path）連反區塊都不會出現；新版須保留 autolink 錨點。
    const anchor = block.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("./#'月光環'");
    expect(anchor?.textContent).toBe("月光環");
  });

  it("splits comma-separated antonym terms and strips non-lookup markup", async () => {
    mockFetch({
      title: "測試詞",
      heteronyms: [
        {
          id: "1",
          bopomofo: "ㄘㄜˋ",
          antonyms:
            '<a href="./#\'A\'">A</a>,<em data-x="1"><a href="https://evil.example/">B</a></em>',
          definitions: [{ type: "名", def: "測試定義" }],
        },
      ],
    });
    renderEntry("測試詞", "t");

    const block = await vi.waitFor(() => {
      const el = container.querySelector(".entry > .antonyms");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // 兩個詞以 、 分隔，各自由 sanitizeLookupHtml 清過。
    expect(block.textContent).toContain("A、B");
    const html = block.innerHTML;
    expect(html).toContain("<a href=\"./#'A'\">");
    // 外層非白名單標籤被剝掉，只留文字；外來 http 錨點不保留。
    expect(html).not.toContain("<em");
    expect(html).not.toContain("data-x");
    expect(html).not.toContain("https://evil.example/");
  });

  it("does not render the heteronym antonyms block for non-t languages", async () => {
    mockFetch({
      title: "測試詞",
      heteronyms: [
        {
          antonyms: "<a href=\"./#'A'\">A</a>",
          definitions: [{ type: "名", def: "測試定義" }],
        },
      ],
    });
    renderEntry("測試詞", "a");

    // 先等詞條本體渲染完成，再確認 lang='a' 不會出現 heteronym 層反區塊。
    await vi.waitFor(() => {
      expect(container.querySelector(".entry > .definition, .entry-item")).not.toBeNull();
    });
    expect(container.querySelector(".entry > .antonyms")).toBeNull();
  });
});

describe("def-level synonyms/antonyms keep lookup anchors (似/反)", () => {
  // 每個 fixture 用不同的詞：requestDictionary 的 RESPONSE_CACHE 是模組級的，
  // 同 (word, lang) 在測試間會吃到上一個案例的快取回應。
  const aDictWord = "範例詞";
  const aDictEntry = {
    title: aDictWord,
    heteronyms: [
      {
        bopomofo: "ㄘㄜˋ",
        definitions: [
          {
            type: "名",
            def: "測試定義",
            synonyms:
              "<a href=\"./#'同義詞甲'\">同義詞甲</a>、<a href=\"./#'同義詞乙'\">同義詞乙</a>",
            antonyms: "<a href=\"./#'反義詞丙'\">反義詞丙</a>",
          },
        ],
      },
    ],
  };

  it("preserves anchors in the 似 block instead of untagging them", async () => {
    mockFetch(aDictEntry);
    renderEntry(aDictWord, "a");

    const block = await vi.waitFor(() => {
      const el = container.querySelector(".entry-item .synonyms");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(block.querySelector(".part-of-speech")?.textContent).toBe("似");
    // 舊版 untag() 後只剩純文字「同義詞甲、同義詞乙」。
    const anchors = Array.from(block.querySelectorAll("a"));
    expect(anchors.map((a) => [a.getAttribute("href"), a.textContent])).toEqual([
      ["./#'同義詞甲'", "同義詞甲"],
      ["./#'同義詞乙'", "同義詞乙"],
    ]);
  });

  it("preserves anchors in the 反 block instead of untagging them", async () => {
    mockFetch(aDictEntry);
    renderEntry(aDictWord, "a");

    const block = await vi.waitFor(() => {
      const el = container.querySelector(".entry-item .antonyms");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(block.querySelector(".part-of-speech")?.textContent).toBe("反");
    const anchor = block.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("./#'反義詞丙'");
    expect(anchor?.textContent).toBe("反義詞丙");
  });

  it("navigates via the app's SPA link handling when clicked", async () => {
    mockFetch(aDictEntry);
    renderEntry(aDictWord, "a");

    const anchor = await vi.waitFor(() => {
      const el = container.querySelector(".entry-item .synonyms a");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    act(() => {
      anchor.click();
    });
    expect(document.getElementById("route-probe")?.textContent).toBe("/'同義詞甲'");
  });
});
