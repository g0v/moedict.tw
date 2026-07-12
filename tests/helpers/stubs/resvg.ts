export interface ResvgCall {
  svg: string;
  options?: unknown;
}

/** Every `new Resvg(...)` call this test run has made, in order. Tests that
 * care about the options (e.g. fallback-font `fontBuffers` wiring) should
 * read `resvgCalls.at(-1)`; the shared `beforeEach` in worker-dispatch-edges
 * clears this array between tests. */
export const resvgCalls: ResvgCall[] = [];

export class Resvg {
  // svg input is intentionally unused for rendering: in tests we never
  // produce a real PNG, but it — and options — are recorded for assertions.
  constructor(
    public svg: string,
    public options?: unknown,
  ) {
    resvgCalls.push({ svg, options });
  }
  render() {
    return { asPng: () => new Uint8Array([137, 80, 78, 71]) }; // minimal PNG magic
  }
}
