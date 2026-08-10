import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi, type Mock } from "vite-plus/test";

const STROKE_WORDS_PATH = path.resolve(
  import.meta.dirname,
  "../../data/assets/js/jquery.strokeWords.js",
);

describe("stroke loader spinner markup", () => {
  const source = readFileSync(STROKE_WORDS_PATH, "utf8");

  it("emits inline SVG spinner (no FontAwesome webfont)", () => {
    expect(source).toMatch(/<svg\b[^>]*class=\\?"moe-stroke-loader-spinner\\?"/);
  });

  it('does not regress to <i class="icon-spinner icon-spin"> webfont markup', () => {
    expect(source).not.toMatch(/class=\\?"icon-spinner\b/);
    expect(source).not.toMatch(/\bicon-spin\b/);
  });

  it("SVG spinner carries aria-hidden for assistive tech", () => {
    expect(source).toMatch(/class=\\?"moe-stroke-loader-spinner[^>]*aria-hidden=\\?"true/);
  });
});

interface FakeStrokeContext {
  arc: Mock;
  beginPath: Mock;
  bezierCurveTo: Mock;
  clip: Mock;
  fill: Mock;
  fillRect: Mock;
  lineTo: Mock;
  moveTo: Mock;
  quadraticCurveTo: Mock;
  restore: Mock;
  save: Mock;
  setTransform: Mock;
  stroke: Mock;
}

interface LegacyWord {
  animFrameId: number | null;
  currentStroke: number;
  draw(strokes: unknown[], canvas: unknown): unknown;
  pause(): void;
  paused: boolean;
  resume(): void;
  step(): void;
}

interface LegacyWordConstructor {
  new (options?: Record<string, unknown>): LegacyWord;
}

function makeStrokeContext(): FakeStrokeContext {
  return {
    arc: vi.fn(),
    beginPath: vi.fn(),
    bezierCurveTo: vi.fn(),
    clip: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
  };
}

function loadLegacyWord(): {
  Word: LegacyWordConstructor;
  cancelAnimationFrame: Mock;
  context2d: FakeStrokeContext;
  requestAnimationFrame: Mock;
} {
  const source = readFileSync(STROKE_WORDS_PATH, "utf8");
  const context2d = makeStrokeContext();
  const canvas = {
    getContext: () => context2d,
    getAttribute: () => "",
    height: 0,
    width: 0,
  };
  const jq = Object.assign(
    (arg: unknown) => {
      if (typeof arg === "function") {
        arg();
      }
      return {
        append: () => undefined,
        css: () => undefined,
        data: () => undefined,
        each: () => undefined,
      };
    },
    {
      Deferred: () => ({ resolve: vi.fn() }),
      extend: (...values: Array<Record<string, unknown> | undefined>) =>
        Object.assign({}, ...values.filter(Boolean)),
      fn: {
        extend(methods: Record<string, unknown>) {
          Object.assign(this, methods);
        },
      },
    },
  );
  const requestAnimationFrame = vi.fn(() => 17);
  const cancelAnimationFrame = vi.fn();
  const sandbox: Record<string, unknown> = {
    $: jq,
    cancelAnimationFrame,
    clearTimeout,
    console,
    document: { createElement: () => canvas },
    glMatrix: {},
    jQuery: jq,
    requestAnimationFrame,
    sax: {},
    setTimeout: (callback: () => void) => {
      callback();
      return 1;
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox);
  const wordStroker = (sandbox.WordStroker ?? {}) as {
    canvas?: { Word?: LegacyWordConstructor };
  };
  if (!wordStroker.canvas?.Word) throw new Error("legacy Word controller did not initialize");
  return { Word: wordStroker.canvas.Word, cancelAnimationFrame, context2d, requestAnimationFrame };
}

describe("legacy stroke animation playback controls", () => {
  const strokes = [
    {
      outline: [],
      track: [
        { x: 0, y: 0, size: 10 },
        { x: 10, y: 10, size: 10 },
      ],
    },
  ];

  it("preserves a controller pause applied during draw initialization", () => {
    const { Word, requestAnimationFrame } = loadLegacyWord();
    const canvas = { getContext: () => makeStrokeContext() };
    const word = new Word({
      _setActiveStroker: (active: LegacyWord) => active.pause(),
    });

    word.draw(strokes, canvas);

    expect(word.paused).toBe(true);
    expect(word.animFrameId).toBeNull();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("tracks the initial frame, pauses/resumes it, and steps exactly one stroke", () => {
    const { Word, cancelAnimationFrame, context2d, requestAnimationFrame } = loadLegacyWord();
    const canvas = { getContext: () => context2d };
    const word = new Word();

    word.draw(strokes, canvas);
    expect(word.animFrameId).toBe(17);

    word.pause();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(17);
    expect(word.animFrameId).toBeNull();

    word.resume();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);

    word.step();
    expect(word.paused).toBe(true);
    expect(word.currentStroke).toBe(1);
    expect(context2d.arc).toHaveBeenCalled();
  });
});
