import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_STROKE_SPEED_LEVEL,
  STROKE_SPEED_LABELS,
  readStrokeSpeedPref,
  resolveStrokeSpeedOptions,
  writeStrokeSpeedPref,
} from "../../src/utils/stroke-speed-utils";

describe("readStrokeSpeedPref / writeStrokeSpeedPref", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to normal when nothing is stored", () => {
    expect(readStrokeSpeedPref()).toBe("normal");
    expect(DEFAULT_STROKE_SPEED_LEVEL).toBe("normal");
  });

  it("round-trips a valid preference", () => {
    writeStrokeSpeedPref("fast");
    expect(readStrokeSpeedPref()).toBe("fast");
    expect(window.localStorage.getItem("stroke-speed")).toBe("fast");
  });

  it("falls back to normal when storage contains an invalid value", () => {
    window.localStorage.setItem("stroke-speed", "ludicrous");
    expect(readStrokeSpeedPref()).toBe("normal");
  });

  it("falls back to normal when writing an invalid value", () => {
    // @ts-expect-error exercising runtime guard against a bad caller
    expect(writeStrokeSpeedPref("ludicrous")).toBe("normal");
  });

  it("returns the default when localStorage.getItem throws", () => {
    const original = window.localStorage.getItem.bind(window.localStorage);
    window.localStorage.getItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(readStrokeSpeedPref()).toBe("normal");
    } finally {
      window.localStorage.getItem = original;
    }
  });

  it("still returns the value when localStorage.setItem throws", () => {
    const original = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(writeStrokeSpeedPref("slow")).toBe("slow");
    } finally {
      window.localStorage.setItem = original;
    }
  });
});

describe("resolveStrokeSpeedOptions", () => {
  it("maps slow to delays 0.8/0.8 and updatesPerStep 6", () => {
    expect(resolveStrokeSpeedOptions("slow")).toEqual({
      delays: { stroke: 0.8, word: 0.8 },
      updatesPerStep: 6,
    });
  });

  it("maps normal to the byte-identical jquery.strokeWords.js hardcoded defaults", () => {
    expect(resolveStrokeSpeedOptions("normal")).toEqual({
      delays: { stroke: 0.5, word: 0.5 },
      updatesPerStep: 10,
    });
  });

  it("maps fast to delays 0.3/0.3 and updatesPerStep 14", () => {
    expect(resolveStrokeSpeedOptions("fast")).toEqual({
      delays: { stroke: 0.3, word: 0.3 },
      updatesPerStep: 14,
    });
  });

  it("falls back to normal options for an invalid level", () => {
    // @ts-expect-error exercising runtime guard against a bad caller
    expect(resolveStrokeSpeedOptions("bogus")).toEqual({
      delays: { stroke: 0.5, word: 0.5 },
      updatesPerStep: 10,
    });
  });

  it("returns a fresh object each call so callers cannot mutate shared state", () => {
    const a = resolveStrokeSpeedOptions("fast");
    const b = resolveStrokeSpeedOptions("fast");
    expect(a).not.toBe(b);
    expect(a.delays).not.toBe(b.delays);
  });
});

describe("STROKE_SPEED_LABELS", () => {
  it("has the locked Chinese labels for each level", () => {
    expect(STROKE_SPEED_LABELS.slow).toBe("慢速");
    expect(STROKE_SPEED_LABELS.normal).toBe("正常速度");
    expect(STROKE_SPEED_LABELS.fast).toBe("快速");
  });
});
