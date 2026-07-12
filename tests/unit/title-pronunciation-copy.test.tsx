/**
 * Interactive coverage for the "複製羅馬拼音" (copy romanization) button
 * added to TitlePronunciation for g0v/moedict-webkit#256.
 *
 * Live-verified bug: on www.moedict.tw, selecting a Mandarin/Taiwanese
 * entry title (e.g. /萌, /'水) yields a garbled run like "萌ㄇㄥˊméng" —
 * the visible zhuyin text plus the hidden-but-selectable romanization
 * <rt>, smashed together with the hanzi. Hakka entries don't have this
 * problem because their pinyin is plain, separately selectable text. This
 * test mounts a real DOM h1 (mirroring DictionaryPage's structure) and
 * asserts that clicking the new button copies *only* the clean
 * romanization to the clipboard, regardless of what a raw text selection
 * would produce.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { TitlePronunciation } from "../../src/components/TitlePronunciation";
import { rightAngle } from "../../src/utils/ruby2hruby";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // Suppress React 19 act() warning — known false positive with
  // createRoot + useEffect/async-state + happy-dom (the copy handler's
  // clipboard.then() resolves after act() returns); see
  // tests/unit/starred-page.test.tsx for the same established pattern.
  vi.spyOn(console, "error").mockImplementation((msg: unknown, ...rest: unknown[]) => {
    if (typeof msg === "string" && msg.includes("not wrapped in act")) return;
    console.error(msg, ...rest);
  });
});

afterEach(() => {
  root.unmount();
  container.remove();
  vi.unstubAllGlobals();
});

function renderTitle(hrubyHtml: string, overrides: Record<string, unknown> = {}) {
  const props = {
    lang: "a" as const,
    isPlaying: false,
    onToggleAudio: () => {},
    hasRomanization: true,
    ...overrides,
  };
  act(() => {
    flushSync(() => {
      root.render(
        <h1 className="title">
          <TitlePronunciation {...props}>
            <span dangerouslySetInnerHTML={{ __html: hrubyHtml }} />
          </TitlePronunciation>
        </h1>,
      );
    });
  });
}

describe("TitlePronunciation copy button — g0v/moedict-webkit#256", () => {
  it("copies clean single-syllable romanization, not the garbled hanzi+zhuyin+pinyin selection text", () => {
    const hruby = rightAngle(
      '<rb>萌</rb><rtc class="zhuyin"><rt>ㄇㄥˊ</rt></rtc><rtc class="romanization"><rt>méng</rt></rtc>',
    );
    // Sanity-check the bug this button routes around: naive text content of
    // the rendered title is the garbled run a plain selection would copy.
    expect(container.textContent).toBe("");
    renderTitle(hruby);
    const titleText = container.querySelector("h1")!.textContent;
    expect(titleText).toBe("萌ㄇㄥˊméng");

    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const button = container.querySelector(".copyRomanization") as HTMLElement;
    expect(button).toBeTruthy();
    act(() => {
      button.click();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("méng");
  });

  it("copies space-joined multi-syllable romanization in DOM order", () => {
    const hruby = rightAngle(
      "<rb>電</rb><rb>腦</rb>" +
        '<rtc class="zhuyin"><rt>ㄉㄧㄢˋ</rt><rt>ㄋㄠˇ</rt></rtc>' +
        '<rtc class="romanization"><rt>diàn</rt><rt>nǎo</rt></rtc>',
    );
    renderTitle(hruby);

    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    act(() => {
      (container.querySelector(".copyRomanization") as HTMLElement).click();
    });

    expect(writeText).toHaveBeenCalledWith("diàn nǎo");
  });

  it("does nothing when the clipboard API is unavailable (no throw)", () => {
    const hruby = rightAngle(
      '<rb>萌</rb><rtc class="zhuyin"><rt>ㄇㄥˊ</rt></rtc><rtc class="romanization"><rt>méng</rt></rtc>',
    );
    renderTitle(hruby);
    vi.stubGlobal("navigator", {});

    expect(() => {
      act(() => {
        (container.querySelector(".copyRomanization") as HTMLElement).click();
      });
    }).not.toThrow();
  });

  it("does not render the copy button for Hakka (lang=h), which already has plain selectable pinyin", () => {
    renderTitle("<span>人</span>", { lang: "h" });
    expect(container.querySelector(".copyRomanization")).toBeNull();
  });

  it("does not render the copy button when hasRomanization is false", () => {
    const hruby = rightAngle('<rb>字</rb><rtc class="zhuyin"><rt>ㄗˋ</rt></rtc>');
    renderTitle(hruby, { hasRomanization: false });
    expect(container.querySelector(".copyRomanization")).toBeNull();
  });

  it("triggers the same copy action via Enter/Space on the keyboard", () => {
    const hruby = rightAngle(
      '<rb>萌</rb><rtc class="zhuyin"><rt>ㄇㄥˊ</rt></rtc><rtc class="romanization"><rt>méng</rt></rtc>',
    );
    renderTitle(hruby);

    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const button = container.querySelector(".copyRomanization") as HTMLElement;
    act(() => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(writeText).toHaveBeenCalledWith("méng");
  });
});
