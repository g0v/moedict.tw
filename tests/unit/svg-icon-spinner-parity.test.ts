/**
 * Parity check: the stroke-loader spinner inlined in
 * data/assets/js/jquery.strokeWords.js must ship the exact same glyph path as
 * the one in SvgIcon's FONT_AWESOME_GLYPHS. If someone edits one and forgets
 * the other, the stroke overlay's spinner visibly diverges from the rest of
 * the icon set.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

const STROKE_WORDS_PATH = path.resolve(
  import.meta.dirname,
  "../../data/assets/js/jquery.strokeWords.js",
);
const SVG_ICON_PATH = path.resolve(import.meta.dirname, "../../src/components/SvgIcon.tsx");

function extractSpinnerPathFromSvgIcon(source: string): string {
  // Match: spinner: { width: 1568, path: '…' },
  const match = source.match(/spinner:\s*\{\s*width:\s*\d+,\s*path:\s*'([^']+)'/);
  if (!match) throw new Error("Could not locate FONT_AWESOME_GLYPHS.spinner in SvgIcon.tsx");
  return match[1];
}

function extractSpinnerPathFromStrokeJs(source: string): string {
  // Match: <path … d=\"<path data>\"/> inside the loader string literal.
  const match = source.match(/class=\\"moe-stroke-loader-spinner[\s\S]*?d=\\"([^"\\]+)\\"/);
  if (!match) throw new Error("Could not locate inline spinner SVG in jquery.strokeWords.js");
  return match[1];
}

describe("stroke loader spinner parity with SvgIcon", () => {
  const svgIconSource = readFileSync(SVG_ICON_PATH, "utf8");
  const strokeJsSource = readFileSync(STROKE_WORDS_PATH, "utf8");

  it("inline stroke spinner path === FONT_AWESOME_GLYPHS.spinner.path", () => {
    // SVG path whitespace is only significant as a number separator, so
    // normalise before comparing: any run of whitespace around a command
    // letter (M/L/Q/C/Z/t/z/…) is semantically equivalent to none.
    const normalise = (d: string) =>
      d.replace(/\s+/g, "").replace(/([a-zA-Z])(?=-?\d|[a-zA-Z])/g, "$1");
    const canonical = extractSpinnerPathFromSvgIcon(svgIconSource);
    const inline = extractSpinnerPathFromStrokeJs(strokeJsSource);
    expect(normalise(inline)).toBe(normalise(canonical));
  });

  it("inline spinner uses the same viewBox width as the glyph definition", () => {
    // FA spinner glyph is 1568 wide — verify the stroke-JS viewBox matches.
    const widthMatch = svgIconSource.match(/spinner:\s*\{\s*width:\s*(\d+)/);
    expect(widthMatch).not.toBeNull();
    const canonicalWidth = widthMatch![1];
    expect(strokeJsSource).toContain(`viewBox=\\"0 0 ${canonicalWidth} 1792\\"`);
  });

  it("inline spinner uses the ascent-shift transform", () => {
    expect(strokeJsSource).toContain('transform=\\"translate(0 1536) scale(1 -1)\\"');
  });
});
