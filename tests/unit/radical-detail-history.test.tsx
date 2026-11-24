import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { RadicalDetailView } from "../../src/pages/RadicalDetailView";
import { readLRUWords } from "../../src/utils/word-record-utils";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
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

async function renderRadical(radical: string): Promise<void> {
  await act(async () => {
    flushSync(() => {
      root.render(
        <MemoryRouter>
          <RadicalDetailView lang="a" radical={radical} />
        </MemoryRouter>,
      );
    });
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("RadicalDetailView history", () => {
  it("records the normalized radical only when the lookup has rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([["玉"]]), { status: 200 })),
    );

    await renderRadical("靑");

    expect(container.querySelector("a.stroke-char")?.textContent).toBe("玉");
    expect(readLRUWords("a")).toEqual(["青"]);
  });

  it("does not record a radical that has no rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
    );

    await renderRadical("不");
    await renderRadical("abc");

    expect(readLRUWords("a")).toEqual([]);
  });

  it("does not record when the radical request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network");
      }),
    );

    await renderRadical("玉");

    expect(container.textContent).toContain("network");
    expect(readLRUWords("a")).toEqual([]);
  });

  it("does not record after the view unmounts", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    await renderRadical("玉");
    root.unmount();
    resolveFetch(new Response(JSON.stringify([["玉"]]), { status: 200 }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readLRUWords("a")).toEqual([]);
  });
});
