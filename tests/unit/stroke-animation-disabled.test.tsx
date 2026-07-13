/**
 * Regression for issue #132: 缺筆順資料（stroke-json 404）的單字詞條，
 * 筆順動畫觸發按鈕（.radical 內的鉛筆圖示 + 標題可點字）應停用，
 * 而不是任由使用者點下去只看到一片淡到 50% 透明度的空白畫布。
 *
 * 對照：有筆順資料（200）的詞條，按鈕維持可用，點擊後正常展開 #strokes。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DictionaryPage } from "../../src/pages/DictionaryPage";

let container: HTMLDivElement;
let root: Root;

function dictionaryFixture(title: string): unknown {
  return {
    title,
    radical: "火",
    stroke_count: 13,
    non_radical_stroke_count: 9,
    heteronyms: [
      {
        bopomofo: "ㄅㄧㄚㆶ",
        definitions: [{ type: "動", def: "測試定義" }],
      },
    ],
  };
}

function mockFetch(strokeStatus: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("/api/config")) {
        return new Response(JSON.stringify({ assetBaseUrl: "/assets" }), { status: 200 });
      }
      if (url.includes("/api/stroke-json/")) {
        return new Response(null, { status: strokeStatus });
      }
      const match = /^\/api\/(.+)\.json$/.exec(url);
      if (match) {
        // requestDictionary() 會把語言前綴（如台語的 '）拼進 token 裡再送出，
        // 詞條本身的 title 欄位不應包含前綴字元。
        const token = decodeURIComponent(match[1]);
        const title = token.replace(/^['~:]/, "");
        return new Response(JSON.stringify(dictionaryFixture(title)), { status: 200 });
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

function renderEntry(word: string): void {
  act(() => {
    flushSync(() => {
      root.render(
        <MemoryRouter>
          <DictionaryPage word={word} lang="t" />
        </MemoryRouter>,
      );
    });
  });
}

function pencilButton(): HTMLElement | null {
  return container.querySelector("a.iconic-circle.stroke");
}

function clickEl(el: HTMLElement): void {
  act(() => {
    el.click();
  });
}

describe("StrokeAnimation trigger disabled state (#132)", () => {
  it("disables the pencil button when stroke data is unavailable (404)", async () => {
    mockFetch(404);
    renderEntry("煏");

    await vi.waitFor(() => {
      const btn = pencilButton();
      expect(btn).not.toBeNull();
      expect(btn?.getAttribute("aria-disabled")).toBe("true");
    });
    const btn = pencilButton();
    expect(btn?.getAttribute("tabindex")).toBe("-1");
    expect(btn?.getAttribute("title")).toBe("此字尚無筆順動畫資料");
  });

  it("clicking the disabled pencil button never reveals the blank #strokes canvas", async () => {
    mockFetch(404);
    renderEntry("煏");

    await vi.waitFor(() => {
      expect(pencilButton()?.getAttribute("aria-disabled")).toBe("true");
    });

    clickEl(pencilButton() as HTMLElement);
    // 停用狀態下 onClick 完全沒有掛上 handler，點擊不應觸發任何非同步流程；
    // 用短暫等待確認狀態穩定，而非只驗證「當下」。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.querySelector("#strokes")).toBeNull();
  });

  it("keeps the pencil button enabled when stroke data is available (200)", async () => {
    mockFetch(200);
    renderEntry("江");

    await vi.waitFor(() => {
      const btn = pencilButton();
      expect(btn).not.toBeNull();
      expect(btn?.getAttribute("tabindex")).toBe("0");
    });
    const btn = pencilButton();
    expect(btn?.getAttribute("aria-disabled")).toBeNull();
    expect(btn?.getAttribute("title")).toBe("筆順動畫");
  });

  it("clicking the enabled pencil button opens #strokes", async () => {
    mockFetch(200);
    renderEntry("江");

    await vi.waitFor(() => {
      expect(pencilButton()?.getAttribute("tabindex")).toBe("0");
    });

    clickEl(pencilButton() as HTMLElement);
    await vi.waitFor(() => {
      expect(container.querySelector("#strokes")).not.toBeNull();
    });
  });

  it("disables the single-char title trigger alongside the pencil button", async () => {
    mockFetch(404);
    renderEntry("煏");

    await vi.waitFor(() => {
      const titleTrigger = container.querySelector(".single-char-stroke-trigger");
      expect(titleTrigger).not.toBeNull();
      expect(titleTrigger?.getAttribute("aria-disabled")).toBe("true");
    });
    const titleTrigger = container.querySelector(".single-char-stroke-trigger");
    expect(titleTrigger?.getAttribute("tabindex")).toBeNull();
  });

  it("leaves the title trigger enabled (no aria-disabled) when stroke data is available", async () => {
    mockFetch(200);
    renderEntry("江");

    await vi.waitFor(() => {
      const titleTrigger = container.querySelector(".single-char-stroke-trigger");
      expect(titleTrigger).not.toBeNull();
      expect(titleTrigger?.getAttribute("tabindex")).toBe("0");
    });
    const titleTrigger = container.querySelector(".single-char-stroke-trigger");
    expect(titleTrigger?.getAttribute("aria-disabled")).toBeNull();
  });
});
