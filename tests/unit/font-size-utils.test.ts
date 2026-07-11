import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_FONT_SIZE_PT,
  FONT_SIZE_MAX_PT,
  FONT_SIZE_MIN_PT,
  applyFontSize,
  clampFontSize,
  readFontSize,
  writeFontSize,
} from "../../src/utils/font-size-utils";

describe("clampFontSize", () => {
  it("returns the input unchanged when within range", () => {
    expect(clampFontSize(14)).toBe(14);
    expect(clampFontSize(FONT_SIZE_MIN_PT)).toBe(FONT_SIZE_MIN_PT);
    expect(clampFontSize(FONT_SIZE_MAX_PT)).toBe(FONT_SIZE_MAX_PT);
  });

  it("floors below the minimum", () => {
    expect(clampFontSize(0)).toBe(FONT_SIZE_MIN_PT);
    expect(clampFontSize(-5)).toBe(FONT_SIZE_MIN_PT);
    expect(clampFontSize(FONT_SIZE_MIN_PT - 1)).toBe(FONT_SIZE_MIN_PT);
  });

  it("caps above the maximum", () => {
    expect(clampFontSize(100)).toBe(FONT_SIZE_MAX_PT);
    expect(clampFontSize(FONT_SIZE_MAX_PT + 1)).toBe(FONT_SIZE_MAX_PT);
  });

  it("rounds non-integer values", () => {
    expect(clampFontSize(14.4)).toBe(14);
    expect(clampFontSize(14.6)).toBe(15);
  });

  it("falls back to the default for NaN / Infinity", () => {
    expect(clampFontSize(Number.NaN)).toBe(DEFAULT_FONT_SIZE_PT);
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_FONT_SIZE_PT);
  });
});

describe("readFontSize / writeFontSize", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns the default when nothing is stored", () => {
    expect(readFontSize()).toBe(DEFAULT_FONT_SIZE_PT);
  });

  it("round-trips a value", () => {
    expect(writeFontSize(18)).toBe(18);
    expect(readFontSize()).toBe(18);
  });

  it("clamps out-of-range values on write", () => {
    expect(writeFontSize(5)).toBe(FONT_SIZE_MIN_PT);
    expect(writeFontSize(999)).toBe(FONT_SIZE_MAX_PT);
  });

  it("clamps corrupted storage on read", () => {
    window.localStorage.setItem("font-size", "999");
    expect(readFontSize()).toBe(FONT_SIZE_MAX_PT);
  });

  it("returns the default when storage contains non-numeric junk", () => {
    window.localStorage.setItem("font-size", "not-a-number");
    expect(readFontSize()).toBe(DEFAULT_FONT_SIZE_PT);
  });

  it("returns the default when localStorage.getItem throws", () => {
    const original = window.localStorage.getItem.bind(window.localStorage);
    window.localStorage.getItem = () => {
      throw new Error("denied");
    };
    try {
      expect(readFontSize()).toBe(DEFAULT_FONT_SIZE_PT);
    } finally {
      window.localStorage.getItem = original;
    }
  });

  it("still returns a clamped value when localStorage.setItem throws", () => {
    const original = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = () => {
      throw new Error("quota");
    };
    try {
      expect(writeFontSize(30)).toBe(30);
    } finally {
      window.localStorage.setItem = original;
    }
  });
});

describe("applyFontSize", () => {
  it("writes the pt value to document.body.style.fontSize", () => {
    applyFontSize(20);
    expect(document.body.style.fontSize).toBe("20pt");
  });

  it("clamps before applying", () => {
    applyFontSize(500);
    expect(document.body.style.fontSize).toBe(`${FONT_SIZE_MAX_PT}pt`);
  });
});
