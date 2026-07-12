import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_THEME_PREF,
  applyTheme,
  readThemePref,
  resolveTheme,
  writeThemePref,
} from "../../src/utils/theme-utils";

function mockMatchMedia(matches: boolean): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) =>
    ({
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

describe("readThemePref / writeThemePref", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns the default when nothing is stored", () => {
    expect(readThemePref()).toBe(DEFAULT_THEME_PREF);
    expect(DEFAULT_THEME_PREF).toBe("system");
  });

  it("round-trips a valid preference", () => {
    expect(writeThemePref("dark")).toBe("dark");
    expect(readThemePref()).toBe("dark");
  });

  it("falls back to the default when storage contains an invalid value", () => {
    window.localStorage.setItem("theme", "solarized");
    expect(readThemePref()).toBe(DEFAULT_THEME_PREF);
  });

  it("falls back to the default when writing an invalid value", () => {
    // @ts-expect-error exercising runtime guard against a bad caller
    expect(writeThemePref("solarized")).toBe(DEFAULT_THEME_PREF);
  });

  it("returns the default when localStorage.getItem throws", () => {
    const original = window.localStorage.getItem.bind(window.localStorage);
    window.localStorage.getItem = () => {
      throw new Error("denied");
    };
    try {
      expect(readThemePref()).toBe(DEFAULT_THEME_PREF);
    } finally {
      window.localStorage.getItem = original;
    }
  });

  it("still returns the value when localStorage.setItem throws", () => {
    const original = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = () => {
      throw new Error("quota");
    };
    try {
      expect(writeThemePref("light")).toBe("light");
    } finally {
      window.localStorage.setItem = original;
    }
  });
});

describe("resolveTheme", () => {
  it("passes explicit light/dark through unchanged", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("resolves system to dark when the OS prefers dark", () => {
    const restore = mockMatchMedia(true);
    try {
      expect(resolveTheme("system")).toBe("dark");
    } finally {
      restore();
    }
  });

  it("resolves system to light when the OS prefers light", () => {
    const restore = mockMatchMedia(false);
    try {
      expect(resolveTheme("system")).toBe("light");
    } finally {
      restore();
    }
  });

  it("falls back to light when matchMedia is unavailable", () => {
    const original = window.matchMedia;
    // @ts-expect-error simulating an environment without matchMedia
    window.matchMedia = undefined;
    try {
      expect(resolveTheme("system")).toBe("light");
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("applyTheme", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
  });

  it("sets data-theme and a matching color-scheme for an explicit dark override", () => {
    expect(applyTheme("dark")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("sets data-theme and a matching color-scheme for an explicit light override", () => {
    expect(applyTheme("light")).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("clears data-theme and uses a dual color-scheme for system", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light dark");
  });
});
