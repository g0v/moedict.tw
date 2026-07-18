/**
 * Unit tests for src/utils/scroll-position.ts — the per-history-entry
 * sessionStorage scroll-position cache backing g0v/moedict-webkit#102's fix
 * (poll-until-tall-enough restore instead of the browser's one-shot
 * scrollRestoration attempt).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  getSavedScrollPosition,
  restoreScrollPosition,
  saveScrollPosition,
} from "../../src/utils/scroll-position";

const STORAGE_KEY = "moedict:scroll-positions";

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("saveScrollPosition / getSavedScrollPosition", () => {
  it("round-trips a saved position under its history-entry key", () => {
    saveScrollPosition("entry-1", 240);
    expect(getSavedScrollPosition("entry-1")).toBe(240);
  });

  it("returns undefined for a key that was never saved", () => {
    expect(getSavedScrollPosition("never-saved")).toBeUndefined();
  });

  it("returns undefined when sessionStorage holds no record at all", () => {
    expect(getSavedScrollPosition("anything")).toBeUndefined();
  });

  it("treats corrupted (non-JSON) sessionStorage content as no record", () => {
    window.sessionStorage.setItem(STORAGE_KEY, "{not valid json");
    expect(getSavedScrollPosition("entry-1")).toBeUndefined();
  });

  it("treats a JSON array payload as no record (positions must be an object)", () => {
    window.sessionStorage.setItem(STORAGE_KEY, "[1,2,3]");
    expect(getSavedScrollPosition("entry-1")).toBeUndefined();
  });

  it("treats a JSON null payload as no record", () => {
    window.sessionStorage.setItem(STORAGE_KEY, "null");
    expect(getSavedScrollPosition("entry-1")).toBeUndefined();
  });

  it("drops entries whose stored value is not a finite non-negative number", () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        good: 10,
        negative: -5,
        notANumber: "120",
        infinite: Number.POSITIVE_INFINITY,
        nan: Number.NaN,
      }),
    );
    expect(getSavedScrollPosition("good")).toBe(10);
    expect(getSavedScrollPosition("negative")).toBeUndefined();
    expect(getSavedScrollPosition("notANumber")).toBeUndefined();
    expect(getSavedScrollPosition("infinite")).toBeUndefined();
    expect(getSavedScrollPosition("nan")).toBeUndefined();
  });

  it("evicts the oldest entries once the count exceeds MAX_ENTRIES (50)", () => {
    for (let i = 0; i < 51; i++) {
      saveScrollPosition(`entry-${i}`, i);
    }
    // The very first inserted key must have been evicted...
    expect(getSavedScrollPosition("entry-0")).toBeUndefined();
    // ...while the most recent 50 remain.
    expect(getSavedScrollPosition("entry-50")).toBe(50);
    expect(getSavedScrollPosition("entry-1")).toBe(1);
  });

  it("silently no-ops when sessionStorage.getItem throws", () => {
    const original = window.sessionStorage.getItem.bind(window.sessionStorage);
    window.sessionStorage.getItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(getSavedScrollPosition("entry-1")).toBeUndefined();
    } finally {
      window.sessionStorage.getItem = original;
    }
  });

  it("silently no-ops when sessionStorage.setItem throws (Safari private mode)", () => {
    const original = window.sessionStorage.setItem.bind(window.sessionStorage);
    window.sessionStorage.setItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(() => saveScrollPosition("entry-1", 100)).not.toThrow();
    } finally {
      window.sessionStorage.setItem = original;
    }
  });
});

describe("restoreScrollPosition", () => {
  function stubRaf(): { flush: () => void } {
    const queue: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      queue.push(cb);
      return queue.length;
    });
    return {
      flush: () => {
        // Drain iteratively since each callback may enqueue the next frame.
        while (queue.length > 0) {
          const cb = queue.shift();
          cb?.();
        }
      },
    };
  }

  it("restores immediately once the page is already tall enough", () => {
    const raf = stubRaf();
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(2000);
    vi.stubGlobal("innerHeight", 800);
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);

    const onSettled = vi.fn();
    restoreScrollPosition(500, onSettled);
    raf.flush();

    expect(scrollTo).toHaveBeenCalledWith(0, 500);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("polls across frames until the content grows tall enough, then restores", () => {
    const raf = stubRaf();
    let scrollHeight = 400; // maxScroll = 400 - 800 clamped to 0, well under target
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockImplementation(() => {
      scrollHeight += 300;
      return scrollHeight;
    });
    vi.stubGlobal("innerHeight", 800);
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);

    const onSettled = vi.fn();
    restoreScrollPosition(500, onSettled);
    raf.flush();

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, 500);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("gives up after RESTORE_MAX_ATTEMPTS (30) frames and clamps to the max reachable scroll", () => {
    const raf = stubRaf();
    // Content never grows tall enough: maxScroll stays fixed below target.
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(300);
    vi.stubGlobal("innerHeight", 800);
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);

    const onSettled = vi.fn();
    restoreScrollPosition(9999, onSettled);
    raf.flush();

    // maxScroll = max(300 - 800, 0) = 0, so it clamps to 0 after 30 attempts.
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});

describe("disableNativeScrollRestoration", () => {
  // The function keeps a module-level one-shot guard (`nativeRestorationDisabled`)
  // with no reset hook, so each test needs a fresh module instance via
  // vi.resetModules() + dynamic import (pattern from dictionary-cache.test.ts)
  // to actually exercise the guarded body rather than the early-return.
  async function importFresh(): Promise<typeof import("../../src/utils/scroll-position")> {
    vi.resetModules();
    return import("../../src/utils/scroll-position");
  }

  it("sets history.scrollRestoration to manual when supported", async () => {
    const mod = await importFresh();
    const original = window.history.scrollRestoration;
    try {
      window.history.scrollRestoration = "auto";
      mod.disableNativeScrollRestoration();
      expect(window.history.scrollRestoration).toBe("manual");
    } finally {
      window.history.scrollRestoration = original;
    }
  });

  it("is idempotent: a second call on the same module instance is a no-op", async () => {
    const mod = await importFresh();
    const original = window.history.scrollRestoration;
    try {
      window.history.scrollRestoration = "auto";
      mod.disableNativeScrollRestoration();
      window.history.scrollRestoration = "auto"; // simulate something resetting it back
      mod.disableNativeScrollRestoration();
      // Guard short-circuits before touching history again, so the manual
      // manual re-set above from "auto" is left untouched by the 2nd call.
      expect(window.history.scrollRestoration).toBe("auto");
    } finally {
      window.history.scrollRestoration = original;
    }
  });

  it("silently no-ops when window.history throws while accessing scrollRestoration", async () => {
    const mod = await importFresh();
    const original = Object.getOwnPropertyDescriptor(window.history, "scrollRestoration");
    Object.defineProperty(window.history, "scrollRestoration", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
      set() {
        throw new Error("blocked");
      },
    });
    try {
      expect(() => mod.disableNativeScrollRestoration()).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window.history, "scrollRestoration", original);
    }
  });

  it("skips the assignment when 'scrollRestoration' is absent from window.history (unsupported browsers)", async () => {
    const mod = await importFresh();
    const originalHistory = window.history;
    // Simulate a browser without the History.scrollRestoration extension:
    // a plain object exposing only what the function actually touches, with
    // no "scrollRestoration" property at all so the `in` check is false.
    const fakeHistory = {};
    Object.defineProperty(window, "history", {
      configurable: true,
      value: fakeHistory,
    });
    try {
      expect(() => mod.disableNativeScrollRestoration()).not.toThrow();
      expect("scrollRestoration" in fakeHistory).toBe(false);
    } finally {
      Object.defineProperty(window, "history", {
        configurable: true,
        value: originalHistory,
      });
    }
  });
});
