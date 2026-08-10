/**
 * Regression for issue #230 (moedict-webkit): 陳盈銘 asked for a way to
 * click on the stroke-order grid to restart ("重寫") the animation instead
 * of having to fully close and reopen the panel to watch it again.
 *
 * moedict.tw's #strokes container previously had no interaction of its
 * own — the only way to replay was to toggle the outer "筆順動畫" button
 * off then on (see tests/e2e/stroke-animation.spec.ts, which shows a
 * second click on that toggle *hides* the panel, not replays it). This
 * test verifies the #strokes container itself is now a keyboard- and
 * mouse-accessible replay control, and that each activation forces a
 * fresh draw run (rather than a no-op).
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vite-plus/test";
import { StrokeAnimation } from "../../src/components/StrokeAnimation";

interface StrokeWordsCall {
  words: string;
  options: {
    url: string;
    dataType: string;
    svg: boolean;
    delays?: unknown;
    updatesPerStep?: unknown;
  };
}

/** Marks the stroke-animation dependency scripts as already loaded, so
 * loadScript()'s existing-`<script src>` short-circuit resolves them
 * synchronously instead of hanging on a real network fetch in happy-dom. */
function stubStrokeScriptsAsLoaded(): void {
  for (const name of ["raf.min.js", "gl-matrix-min.js", "sax.js", "jquery.strokeWords.js"]) {
    const el = document.createElement("script");
    el.setAttribute("src", `/assets/js/${name}`);
    document.head.appendChild(el);
  }
}

/** Stubs window.jQuery so `$(container).strokeWords(words, options)` records
 * each call instead of touching a real jQuery/canvas implementation. */
function stubStrokeWordsJQuery(calls: StrokeWordsCall[]): void {
  const jq = ((_target: unknown) => ({
    strokeWords: (words: string, options: StrokeWordsCall["options"]) => {
      calls.push({ words, options });
    },
  })) as unknown as ((target: unknown) => unknown) & { fn: { strokeWords: unknown } };
  jq.fn = { strokeWords: () => {} };
  (window as unknown as { jQuery: unknown }).jQuery = jq;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // Suppress React 19 act() warning — known false positive with
  // createRoot + useEffect + happy-dom (effects fire after act returns).
  const originalConsoleError = console.error.bind(console);
  vi.spyOn(console, "error").mockImplementation((msg: unknown, ...rest: unknown[]) => {
    if (typeof msg === "string" && msg.includes("not wrapped in act")) return;
    originalConsoleError(msg, ...rest);
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ assetBaseUrl: "/assets" }),
    })),
  );
});

afterEach(() => {
  root.unmount();
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderStroke(title = "萌"): void {
  act(() => {
    flushSync(() => {
      root.render(<StrokeAnimation title={title} visible={true} lang="a" />);
    });
  });
}

/** Let the fetchR2Endpoint() microtask chain (fetch → json → setState) settle. */
async function flushAsync(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    // oxlint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function countInitRuns(debugSpy: MockInstance): number {
  return debugSpy.mock.calls.filter((call) => call[0] === "[StrokeAnimation] init run").length;
}

describe("StrokeAnimation click-to-replay (moedict-webkit#230)", () => {
  it("renders #strokes as a labelled, keyboard-reachable control once visible", async () => {
    renderStroke();
    await flushAsync();

    const strokes = container.querySelector("#strokes");
    expect(strokes).not.toBeNull();
    expect(strokes?.getAttribute("role")).toBe("button");
    expect(strokes?.getAttribute("tabindex")).toBe("0");
    expect(strokes?.getAttribute("title")).toBe("點擊重播筆順動畫");
    expect(strokes?.getAttribute("aria-label")).toBe("點擊重播筆順動畫");
  });

  it("clicking #strokes starts a fresh draw run instead of no-op", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    renderStroke();
    await flushAsync();

    expect(countInitRuns(debugSpy)).toBe(1);

    const strokes = container.querySelector("#strokes") as HTMLElement;
    act(() => {
      strokes.click();
    });
    await flushAsync(2);

    expect(countInitRuns(debugSpy)).toBe(2);
  });

  it("pressing Enter on #strokes also triggers a replay run", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    renderStroke();
    await flushAsync();
    expect(countInitRuns(debugSpy)).toBe(1);

    const strokes = container.querySelector("#strokes") as HTMLElement;
    act(() => {
      strokes.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    await flushAsync(2);

    expect(countInitRuns(debugSpy)).toBe(2);
  });

  it("pressing Space on #strokes also triggers a replay run", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    renderStroke();
    await flushAsync();
    expect(countInitRuns(debugSpy)).toBe(1);

    const strokes = container.querySelector("#strokes") as HTMLElement;
    act(() => {
      strokes.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
      );
    });
    await flushAsync(2);

    expect(countInitRuns(debugSpy)).toBe(2);
  });

  it("keys other than Enter/Space do not trigger a replay run", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    renderStroke();
    await flushAsync();
    expect(countInitRuns(debugSpy)).toBe(1);

    const strokes = container.querySelector("#strokes") as HTMLElement;
    act(() => {
      strokes.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      );
    });
    await flushAsync(2);

    expect(countInitRuns(debugSpy)).toBe(1);
  });

  it("does not render #strokes at all when not visible", () => {
    act(() => {
      flushSync(() => {
        root.render(<StrokeAnimation title="萌" visible={false} lang="a" />);
      });
    });
    expect(container.querySelector("#strokes")).toBeNull();
  });
});

describe("StrokeAnimation stroke-speed options (issue #98)", () => {
  afterEach(() => {
    delete (window as unknown as { jQuery?: unknown }).jQuery;
    for (const name of ["raf.min.js", "gl-matrix-min.js", "sax.js", "jquery.strokeWords.js"]) {
      document.head
        .querySelectorAll(`script[src="/assets/js/${name}"]`)
        .forEach((el) => el.remove());
    }
  });

  it("passes the byte-identical normal defaults when no pref is stored", async () => {
    const calls: StrokeWordsCall[] = [];
    stubStrokeScriptsAsLoaded();
    stubStrokeWordsJQuery(calls);

    renderStroke();
    await flushAsync();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toEqual({
      url: "/api/stroke-json/",
      dataType: "json",
      svg: false,
      delays: { stroke: 0.5, word: 0.5 },
      updatesPerStep: 10,
    });
  });

  it("passes slow options when stroke-speed=slow is stored", async () => {
    window.localStorage.setItem("stroke-speed", "slow");
    const calls: StrokeWordsCall[] = [];
    stubStrokeScriptsAsLoaded();
    stubStrokeWordsJQuery(calls);

    renderStroke();
    await flushAsync();

    expect(calls[0]?.options.delays).toEqual({ stroke: 0.8, word: 0.8 });
    expect(calls[0]?.options.updatesPerStep).toBe(6);
  });

  it("passes fast options when stroke-speed=fast is stored", async () => {
    window.localStorage.setItem("stroke-speed", "fast");
    const calls: StrokeWordsCall[] = [];
    stubStrokeScriptsAsLoaded();
    stubStrokeWordsJQuery(calls);

    renderStroke();
    await flushAsync();

    expect(calls[0]?.options.delays).toEqual({ stroke: 0.3, word: 0.3 });
    expect(calls[0]?.options.updatesPerStep).toBe(14);
  });

  it("re-reads the pref fresh on replay: a mid-animation change only applies to the next draw run", async () => {
    const calls: StrokeWordsCall[] = [];
    stubStrokeScriptsAsLoaded();
    stubStrokeWordsJQuery(calls);

    renderStroke();
    await flushAsync();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.updatesPerStep).toBe(10); // normal default

    // Change the stored pref without unmounting/replaying — the effect that
    // already drew must NOT react to this (it is not in the effect deps).
    window.localStorage.setItem("stroke-speed", "fast");
    expect(calls).toHaveLength(1);

    // Replay (click #strokes) picks up the new pref on this fresh draw run.
    const strokes = container.querySelector("#strokes") as HTMLElement;
    act(() => {
      strokes.click();
    });
    await flushAsync(2);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.options.delays).toEqual({ stroke: 0.3, word: 0.3 });
    expect(calls[1]?.options.updatesPerStep).toBe(14);
  });
});

describe("StrokeAnimation pause and step controls", () => {
  afterEach(() => {
    delete (window as unknown as { jQuery?: unknown }).jQuery;
    for (const name of ["raf.min.js", "gl-matrix-min.js", "sax.js", "jquery.strokeWords.js"]) {
      document.head
        .querySelectorAll(`script[src="/assets/js/${name}"]`)
        .forEach((el) => el.remove());
    }
  });

  it("renders pause and step control buttons with accessibility attributes", async () => {
    renderStroke();
    await flushAsync();

    const pauseBtn = container.querySelector("#stroke-pause-resume");
    const stepBtn = container.querySelector("#stroke-step-forward");

    expect(pauseBtn).not.toBeNull();
    expect(pauseBtn?.getAttribute("role")).toBe("button");
    expect(pauseBtn?.getAttribute("tabindex")).toBe("0");
    expect(pauseBtn?.getAttribute("aria-label")).toBe("暫停筆順動畫");
    expect(pauseBtn?.textContent).toBe("暫停");

    expect(stepBtn).not.toBeNull();
    expect(stepBtn?.getAttribute("role")).toBe("button");
    expect(stepBtn?.getAttribute("tabindex")).toBe("0");
    expect(stepBtn?.getAttribute("aria-label")).toBe("下一畫筆順動畫");
    expect(stepBtn?.textContent).toBe("下一畫");
  });

  it("clicking pause toggles pause state and invokes controller", async () => {
    let togglePauseCalled = false;
    const stubJQuery = vi.fn((_sel: unknown) => ({
      data: (key: string) => {
        if (key === "strokeWords") {
          return {
            togglePause: () => {
              togglePauseCalled = true;
              return true;
            },
            step: () => {},
          };
        }
        return undefined;
      },
      strokeWords: () => {},
    }));
    (window as unknown as { jQuery?: unknown }).jQuery = stubJQuery;
    stubStrokeScriptsAsLoaded();

    renderStroke();
    await flushAsync();

    const pauseBtn = container.querySelector("#stroke-pause-resume") as HTMLElement;
    act(() => {
      pauseBtn.click();
    });
    await flushAsync();

    expect(togglePauseCalled).toBe(true);
    expect(pauseBtn.textContent).toBe("繼續");
    expect(pauseBtn.getAttribute("aria-label")).toBe("繼續筆順動畫");
  });

  it("clicking step forward invokes step controller and sets paused state", async () => {
    let stepCalled = false;
    const stubJQuery = vi.fn((_sel: unknown) => ({
      data: (key: string) => {
        if (key === "strokeWords") {
          return {
            togglePause: () => false,
            step: () => {
              stepCalled = true;
            },
          };
        }
        return undefined;
      },
      strokeWords: () => {},
    }));
    (window as unknown as { jQuery?: unknown }).jQuery = stubJQuery;
    stubStrokeScriptsAsLoaded();

    renderStroke();
    await flushAsync();

    const stepBtn = container.querySelector("#stroke-step-forward") as HTMLElement;
    act(() => {
      stepBtn.click();
    });
    await flushAsync();

    expect(stepCalled).toBe(true);
    const pauseBtn = container.querySelector("#stroke-pause-resume") as HTMLElement;
    expect(pauseBtn.textContent).toBe("繼續");
  });

  it("supports Enter for pause/resume and Space for next stroke", async () => {
    let togglePauseCalls = 0;
    let stepCalls = 0;
    const stubJQuery = vi.fn((_sel: unknown) => ({
      data: (key: string) => {
        if (key !== "strokeWords") return undefined;
        return {
          togglePause: () => {
            togglePauseCalls += 1;
            return true;
          },
          step: () => {
            stepCalls += 1;
          },
        };
      },
      strokeWords: () => {},
    }));
    (window as unknown as { jQuery?: unknown }).jQuery = stubJQuery;
    stubStrokeScriptsAsLoaded();

    renderStroke();
    await flushAsync();

    const pauseBtn = container.querySelector("#stroke-pause-resume") as HTMLElement;
    const stepBtn = container.querySelector("#stroke-step-forward") as HTMLElement;
    act(() => {
      pauseBtn.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      stepBtn.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
      );
    });
    await flushAsync();

    expect(togglePauseCalls).toBe(1);
    expect(stepCalls).toBe(1);
  });
});
