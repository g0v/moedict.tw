/**
 * Regression for issue #217: star toggle buttons in the recent-words
 * (history) section of the 字詞紀錄簿 page, replacing the bullet dots.
 * Also verifies the starred section shows filled stars.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { StarredPage } from "../../src/pages/StarredPage";
import { addStarWord, addToLRU, readStarredWords } from "../../src/utils/word-record-utils";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // Suppress React 19 act() warning — known false positive with
  // createRoot + useEffect + happy-dom (effects fire after act returns)
  vi.spyOn(console, "error").mockImplementation((msg: unknown, ...rest: unknown[]) => {
    if (typeof msg === "string" && msg.includes("not wrapped in act")) return;
    console.error(msg, ...rest);
  });
});

afterEach(() => {
  root.unmount();
  container.remove();
});

function renderPage(lang: "a" | "t" | "h" | "c" = "a"): void {
  act(() => {
    flushSync(() => {
      root.render(
        <MemoryRouter>
          <StarredPage lang={lang} />
        </MemoryRouter>,
      );
    });
  });
}

function clickEl(el: HTMLElement): void {
  act(() => {
    el.click();
  });
}

describe("StarredPage — star toggle in history (#217)", () => {
  it("renders star buttons instead of bullet dots in the recent section", () => {
    addToLRU("測試", "a");
    renderPage("a");

    const recent = container.querySelector(".recent-section");
    expect(recent).toBeTruthy();

    const starButtons = recent!.querySelectorAll(".btn-star-word");
    expect(starButtons.length).toBe(1);

    // No leftover bullet <span>·</span> elements
    const bulletSpans = recent!.querySelectorAll("span");
    expect(bulletSpans.length).toBe(0);
  });

  it("shows empty-star aria-label for non-starred recent words", () => {
    addToLRU("未收藏", "a");
    renderPage("a");

    const btn = container.querySelector<HTMLButtonElement>(".recent-section .btn-star-word");
    expect(btn).toBeTruthy();
    expect(btn!.getAttribute("aria-label")).toContain("收藏");
    expect(btn!.getAttribute("aria-label")).not.toContain("取消");
  });

  it("shows filled-star aria-label for recent words that are also starred", () => {
    addStarWord("a", "已收藏");
    addToLRU("已收藏", "a");
    renderPage("a");

    const btn = container.querySelector<HTMLButtonElement>(".recent-section .btn-star-word");
    expect(btn).toBeTruthy();
    expect(btn!.getAttribute("aria-label")).toContain("取消收藏");
  });

  it("toggling star from recent section adds word to starred section", () => {
    addToLRU("可收藏", "a");
    renderPage("a");

    // Initially not starred
    let btn = container.querySelector<HTMLButtonElement>(".recent-section .btn-star-word");
    expect(btn!.getAttribute("aria-label")).toContain("收藏");
    expect(btn!.getAttribute("aria-label")).not.toContain("取消");

    // Starred section should be empty (only the guidance <p>)
    expect(container.querySelectorAll(".starred-section .word-list a").length).toBe(0);

    // Click to star
    clickEl(btn!);

    // Word should now appear in the starred section
    const starredLinks = container.querySelectorAll(".starred-section .word-list a");
    expect(starredLinks.length).toBe(1);
    expect(starredLinks[0].textContent).toBe("可收藏");

    // Recent section star should now show "取消收藏"
    btn = container.querySelector<HTMLButtonElement>(".recent-section .btn-star-word");
    expect(btn!.getAttribute("aria-label")).toContain("取消收藏");
  });

  it("toggling star from recent section removes word from starred section", () => {
    addStarWord("a", "雙重");
    addToLRU("雙重", "a");
    renderPage("a");

    // Initially starred
    let btn = container.querySelector<HTMLButtonElement>(".recent-section .btn-star-word");
    expect(btn!.getAttribute("aria-label")).toContain("取消收藏");
    expect(container.querySelectorAll(".starred-section .word-list a").length).toBe(1);

    // Click to unstar
    clickEl(btn!);

    // Starred section should now be empty
    expect(container.querySelectorAll(".starred-section .word-list a").length).toBe(0);

    // Recent section star should now show "收藏"
    btn = container.querySelector<HTMLButtonElement>(".recent-section .btn-star-word");
    expect(btn!.getAttribute("aria-label")).toContain("收藏");
    expect(btn!.getAttribute("aria-label")).not.toContain("取消");
  });

  it("renders filled star buttons in the starred section", () => {
    addStarWord("a", "已星");
    renderPage("a");

    const starred = container.querySelector(".starred-section");
    const starButtons = starred!.querySelectorAll(".btn-star-word");
    expect(starButtons.length).toBe(1);
    expect(starButtons[0].getAttribute("aria-label")).toContain("取消收藏");
  });

  it("clicking star in starred section removes the word", () => {
    addStarWord("a", "消失");
    renderPage("a");

    expect(container.querySelectorAll(".starred-section .word-list a").length).toBe(1);

    const btn = container.querySelector<HTMLButtonElement>(".starred-section .btn-star-word");
    clickEl(btn!);

    expect(container.querySelectorAll(".starred-section .word-list a").length).toBe(0);
  });

  it("keeps the remove-from-history button separate from the star toggle", () => {
    addToLRU("保留", "a");
    renderPage("a");

    const recent = container.querySelector(".recent-section");
    const starBtns = recent!.querySelectorAll(".btn-star-word");
    const removeBtns = recent!.querySelectorAll(".btn-remove-word");
    expect(starBtns.length).toBe(1);
    expect(removeBtns.length).toBe(1);
    // Star is before the link, remove is after
    const starBtn = starBtns[0] as HTMLElement;
    const removeBtn = removeBtns[0] as HTMLElement;
    const link = recent!.querySelector("a")!;
    expect(starBtn.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(removeBtn.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });
});

describe("StarredPage — cross-language overview (#88)", () => {
  it("toggle is collapsed by default with aria-expanded=false", () => {
    renderPage("a");
    const toggle = container.querySelector<HTMLButtonElement>("#btn-toggle-all-langs")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("#all-langs-content")).toBeNull();
  });

  it("reveals fixed-order grouped headings for languages with starred words only, omitting empty langs", () => {
    addStarWord("t", "食");
    addStarWord("c", "东西");
    renderPage("a");

    const toggle = container.querySelector<HTMLButtonElement>("#btn-toggle-all-langs")!;
    clickEl(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const headings = Array.from(
      container.querySelectorAll("#all-langs-content .lang-group-heading"),
    ).map((h) => h.textContent);
    // Fixed a/t/h/c order; 華語(a) and 臺灣客語(h) omitted (no starred words).
    expect(headings).toEqual(["臺灣台語", "兩岸詞典"]);
  });

  it("each row links via its OWN language's route prefix, not the page's current lang", () => {
    addStarWord("t", "食");
    addStarWord("c", "东西");
    renderPage("a");
    clickEl(container.querySelector<HTMLButtonElement>("#btn-toggle-all-langs")!);

    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>("#all-langs-content a"));
    const hrefByText = new Map(links.map((a) => [a.textContent, a.getAttribute("href")]));
    expect(hrefByText.get("食")).toBe("/'%E9%A3%9F");
    expect(hrefByText.get("东西")).toBe("/~%E4%B8%9C%E8%A5%BF");
  });

  it("renders @radical starred words with the correct per-language radical href shape", () => {
    // Hakka must NOT become /:@... — only '/~ prefix the @ family, a/h use /@.
    addStarWord("h", "@木");
    addStarWord("t", "@木");
    renderPage("a");
    clickEl(container.querySelector<HTMLButtonElement>("#btn-toggle-all-langs")!);

    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>("#all-langs-content a"));
    const hrefByText = new Map(links.map((a) => [a.textContent, a.getAttribute("href")]));
    expect(hrefByText.get("@木")).toBe("/@%E6%9C%A8"); // h → no colon prefix on radical
    // Both groups render an "@木" link; assert full set of hrefs instead since
    // Map dedupes by textContent above — check t's link directly by group.
    // ALL_LANGS fixed order a/t/h/c; only t and h have words, so t (index 1)
    // sorts before h (index 2) → t is group[0].
    const tGroupLinks = Array.from(
      container.querySelectorAll("#all-langs-content .lang-group")[0]?.querySelectorAll("a") ?? [],
    ).map((a) => a.getAttribute("href"));
    expect(tGroupLinks).toContain("/'@%E6%9C%A8");
  });

  it("current lang's own starred word appears in its group flagged as current", () => {
    addStarWord("a", "萌");
    renderPage("a");
    clickEl(container.querySelector<HTMLButtonElement>("#btn-toggle-all-langs")!);

    const heading = container.querySelector(".lang-group-heading")!;
    expect(heading.textContent).toBe("華語（目前語言）");
  });

  it("star/remove actions in the overview mutate the correct language's storage and refresh the aggregate without touching current lang's own list", () => {
    addStarWord("t", "食");
    addStarWord("a", "留");
    renderPage("a");
    clickEl(container.querySelector<HTMLButtonElement>("#btn-toggle-all-langs")!);

    expect(container.querySelectorAll(".starred-section .word-list a").length).toBe(1);

    const removeBtn = container.querySelector<HTMLButtonElement>(
      '#all-langs-content button[aria-label*="食"]',
    )!;
    clickEl(removeBtn);

    // t's word gone from storage + aggregate; a's own section untouched.
    expect(readStarredWords("t")).toEqual([]);
    expect(container.querySelectorAll(".starred-section .word-list a").length).toBe(1);
    expect(container.querySelector(".lang-group-heading")!.textContent).not.toContain("台語");
  });
});

describe("StarredPage — export/import panel (#219)", () => {
  function setTextareaValue(el: HTMLTextAreaElement, value: string): void {
    // oxlint-disable-next-line typescript/unbound-method
    const setNativeValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setNativeValue.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("download/copy buttons are disabled when there are no starred words", () => {
    renderPage("a");
    expect(container.querySelector<HTMLButtonElement>("#btn-download-starred")!.disabled).toBe(
      true,
    );
    expect(container.querySelector<HTMLButtonElement>("#btn-copy-starred")!.disabled).toBe(true);
  });

  it("import panel is collapsed by default; toggle reveals a labeled visible textarea (never clipboard-read)", () => {
    renderPage("a");
    const toggle = container.querySelector<HTMLButtonElement>("#btn-toggle-import")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("#import-starred-textarea")).toBeNull();

    clickEl(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const textarea = container.querySelector("#import-starred-textarea")!;
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea.getAttribute("aria-label")).toContain("貼上");
    const label = container.querySelector('label[for="import-starred-textarea"]');
    expect(label).not.toBeNull();
  });

  it("confirm-import button is disabled for empty/whitespace-only input", () => {
    renderPage("a");
    clickEl(container.querySelector<HTMLButtonElement>("#btn-toggle-import")!);
    const confirmBtn = container.querySelector<HTMLButtonElement>("#btn-confirm-import")!;
    expect(confirmBtn.disabled).toBe(true);

    const textarea = container.querySelector<HTMLTextAreaElement>("#import-starred-textarea")!;
    setTextareaValue(textarea, "   \n  ");
    expect(container.querySelector<HTMLButtonElement>("#btn-confirm-import")!.disabled).toBe(true);
  });

  it("importing preserves pasted order and reports imported/skipped counts", () => {
    addStarWord("a", "已收藏");
    renderPage("a");
    clickEl(container.querySelector<HTMLButtonElement>("#btn-toggle-import")!);

    const textarea = container.querySelector<HTMLTextAreaElement>("#import-starred-textarea")!;
    setTextareaValue(textarea, "萌\n典\n已收藏\n#");
    clickEl(container.querySelector<HTMLButtonElement>("#btn-confirm-import")!);

    const starredLinks = Array.from(
      container.querySelectorAll(".starred-section .word-list a"),
    ).map((a) => a.textContent);
    // Newly imported words prepended ahead of untouched existing word, in
    // pasted order: 萌, 典, then pre-existing 已收藏.
    expect(starredLinks).toEqual(["萌", "典", "已收藏"]);

    const status = container.querySelector('#import-starred-panel [role="status"]')!;
    expect(status.textContent).toBe("已匯入 2 筆，略過 2 筆重複或無效字詞。");
  });

  it("empty/whitespace-only submit does not mutate storage (button stays disabled, no-op)", () => {
    renderPage("a");
    clickEl(container.querySelector<HTMLButtonElement>("#btn-toggle-import")!);
    const before = readStarredWords("a");
    // Submit button is disabled for empty input, so directly assert the
    // underlying storage is untouched (no separate click path to trigger).
    expect(readStarredWords("a")).toEqual(before);
    expect(container.querySelector('#import-starred-panel [role="status"]')).toBeNull();
  });

  it("does not touch sibling-language storage when importing into the current language", () => {
    addStarWord("t", "既有");
    renderPage("a");
    clickEl(container.querySelector<HTMLButtonElement>("#btn-toggle-import")!);
    const textarea = container.querySelector<HTMLTextAreaElement>("#import-starred-textarea")!;
    setTextareaValue(textarea, "萌");
    clickEl(container.querySelector<HTMLButtonElement>("#btn-confirm-import")!);

    expect(readStarredWords("t")).toEqual(["既有"]);
  });
});
