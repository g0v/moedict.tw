import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CharacterImageView,
  GlyphImage,
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

describe("GlyphImage offline fallback", () => {
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderGlyph(
    text: string,
    size: number,
    src = "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
  ): void {
    act(() => {
      flushSync(() => {
        root.render(
          <GlyphImage
            className="charimg-glyph charimg-glyph-main"
            src={src}
            alt={text}
            text={text}
            size={size}
          />,
        );
      });
    });
  }

  async function failImage(): Promise<void> {
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    await act(async () => {
      img?.dispatchEvent(new Event("error"));
    });
  }

  it("shows the image until it fails, then a sized text glyph", async () => {
    renderGlyph("測試詞條", 160);
    expect(container.querySelector("img")?.getAttribute("src")).toContain("data:image/gif");

    await failImage();

    const fallback = container.querySelector<HTMLElement>(".charimg-glyph-fallback");
    expect(container.querySelector("img")).toBeNull();
    expect(fallback?.getAttribute("role")).toBe("img");
    expect(fallback?.getAttribute("aria-label")).toBe("測試詞條");
    expect(fallback?.className).toContain("charimg-glyph charimg-glyph-main");
    expect(fallback?.textContent).toBe("測試詞條");
    expect(fallback?.style.fontSize).toBe("32px");
    expect(fallback?.style.lineHeight).toBe("1");
    expect(fallback?.style.fontFamily).toContain("TW-Kai");
    expect(fallback?.style.color).toBe("#000");
    expect(fallback?.style.backgroundColor).toBe("#fff");
    expect(fallback?.style.overflow).toBe("hidden");
    expect(fallback?.style.width).toBe("160px");
    expect(fallback?.style.height).toBe("160px");
  });

  it("caps the divisor at four characters and keeps a single-character glyph large", async () => {
    renderGlyph("萌", 240);
    await failImage();
    expect(container.querySelector<HTMLElement>(".charimg-glyph-fallback")?.style.fontSize).toBe(
      "192px",
    );

    renderGlyph(
      "萌典測試字",
      160,
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
    );
    await failImage();
    expect(container.querySelector<HTMLElement>(".charimg-glyph-fallback")?.style.fontSize).toBe(
      "32px",
    );
  });

  it("uses the headword without a route prefix, and the segment text, in the card", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    vi.spyOn(console, "error").mockImplementation((msg: unknown, ...rest: unknown[]) => {
      if (typeof msg === "string" && msg.includes("not wrapped in act")) return;
      console.warn(msg, ...rest);
    });

    await act(async () => {
      flushSync(() => {
        root.render(
          <MemoryRouter>
            <CharacterImageView lang="t" langTokenPrefix="'" queryWord="'水" terms={["玉"]} />
          </MemoryRouter>,
        );
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const main = container.querySelector<HTMLImageElement>("img.charimg-glyph-main");
    const segment = container.querySelector<HTMLImageElement>("img.charimg-glyph-segment");
    expect(main).not.toBeNull();
    expect(segment).not.toBeNull();

    await act(async () => {
      main?.dispatchEvent(new Event("error"));
      segment?.dispatchEvent(new Event("error"));
    });

    const mainFallback = container.querySelector<HTMLElement>(
      ".charimg-glyph-main.charimg-glyph-fallback",
    );
    const segmentFallback = container.querySelector<HTMLElement>(
      ".charimg-glyph-segment.charimg-glyph-fallback",
    );
    expect(mainFallback?.textContent).toBe("水");
    expect(mainFallback?.getAttribute("aria-label")).toBe("'水");
    expect(segmentFallback?.textContent).toBe("玉");
  });
});
