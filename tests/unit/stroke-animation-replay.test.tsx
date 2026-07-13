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
