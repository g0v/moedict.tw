import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

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
