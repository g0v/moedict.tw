import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CharacterImageView,
  renderFormattedPhonetics,
} from "../../src/components/CharacterImageView";

describe("CharacterImage phonetic caption rendering", () => {
  it("renders hostile formatter input as literal text without markup", () => {
    const hostile = "<img src=x onerror=alert(1)> <script>alert(1)</script>";
    const html = renderToStaticMarkup(renderFormattedPhonetics(hostile));
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
  });
});

describe("CharacterImage share permalink", () => {
  let container: HTMLDivElement;
  let root: Root;
  const share = vi.fn(async (_data: { url: string }) => {});
  const writeText = vi.fn(async () => {});

  beforeEach(() => {
    window.history.pushState({}, "", "/~%E8%90%8C?from=app");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    share.mockClear();
    writeText.mockClear();
    Object.defineProperty(navigator, "share", { configurable: true, writable: true, value: share });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.spyOn(console, "error").mockImplementation((msg: unknown, ...rest: unknown[]) => {
      if (typeof msg === "string" && msg.includes("not wrapped in act")) return;
      console.warn(msg, ...rest);
    });
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, "share");
  });

  async function renderCard(): Promise<void> {
    await act(async () => {
      flushSync(() => {
        root.render(
          <MemoryRouter>
            <CharacterImageView lang="a" langTokenPrefix="" queryWord="萌" terms={[]} />
          </MemoryRouter>,
        );
      });
    });
  }

  async function clickShare(): Promise<void> {
    const button = container.querySelector<HTMLButtonElement>(".charimg-share-btn");
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("shares the public moedict.tw path from the offline app", async () => {
    vi.stubEnv("VITE_MOEDICT_OFFLINE_APP", "1");
    await renderCard();
    await clickShare();

    expect(share.mock.calls[0]?.[0]?.url).toBe(`https://www.moedict.tw${window.location.pathname}`);
    expect(share.mock.calls[0]?.[0]?.url ?? "").not.toMatch(/localhost|capacitor:/);
  });

  it("copies the public permalink when the webview has no share sheet", async () => {
    vi.stubEnv("VITE_MOEDICT_OFFLINE_APP", "1");
    Object.defineProperty(navigator, "share", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    await renderCard();
    await clickShare();

    expect(writeText).toHaveBeenCalledWith(`https://www.moedict.tw${window.location.pathname}`);
  });

  it("keeps the current page URL when sharing from the website", async () => {
    vi.stubEnv("VITE_MOEDICT_OFFLINE_APP", "");
    await renderCard();
    await clickShare();

    expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: window.location.href }));
  });
});

describe("CharacterImage print button", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.spyOn(console, "error").mockImplementation((msg: unknown, ...rest: unknown[]) => {
      if (typeof msg === "string" && msg.includes("not wrapped in act")) return;
      console.warn(msg, ...rest);
    });
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function renderCard(): Promise<void> {
    await act(async () => {
      flushSync(() => {
        root.render(
          <MemoryRouter>
            <CharacterImageView lang="a" langTokenPrefix="" queryWord="萌" terms={[]} />
          </MemoryRouter>,
        );
      });
    });
  }

  it("hides 列印字卡 in the offline app", async () => {
    vi.stubEnv("VITE_MOEDICT_OFFLINE_APP", "1");
    await renderCard();
    expect(container.querySelector(".charimg-print-btn")).toBeNull();
    expect(container.textContent).not.toContain("列印字卡");
  });

  it("keeps 列印字卡 on the website", async () => {
    vi.stubEnv("VITE_MOEDICT_OFFLINE_APP", "");
    await renderCard();
    expect(container.querySelector(".charimg-print-btn")?.textContent).toContain("列印字卡");
  });
});
