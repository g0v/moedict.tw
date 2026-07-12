/**
 * Regression for issue #265 (「汛」筆順示意圖破損).
 *
 * Root cause: U+6C5B (汛) has no stroke-path entry in the upstream
 * g0v/zh-stroke-data corpus that both the legacy Rackspace CDN and its R2
 * migration serve from (confirmed 404 on the original rackcdn host, R2
 * directly, and the /api/stroke-json/ Worker proxy — this predates the R2
 * migration, so it is a genuine upstream data gap, not a migration
 * regression). `data/assets/js/jquery.strokeWords.js`'s
 * `drawElementWithWord` used to swallow that 404 silently: its fail
 * callback resolved with a `draw()` that only faded the still-blank canvas
 * to 50% opacity, while the shared success/fail chain in the outer
 * `strokeWords` plugin (`.then(word => word.drawBackground())`) still painted
 * the red 田字格 grid regardless — producing exactly the empty, "破損"
 * -looking grid box from the issue screenshot, with no indication to the
 * user that this specific character simply has no data.
 *
 * This is the same fail-path gap as #76 (筆順 not-found messaging); the fix
 * shares #76's markup contract (`stroke-missing` class + `role="img"` +
 * `aria-label` on `.word`, a `.stroke-missing-badge` with "？" mark and
 * "尚無筆順資料" text, canvas hidden rather than faded) so the two issues
 * resolve to one consistent UX instead of diverging fixes.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

const STROKE_WORDS_PATH = path.resolve(
  import.meta.dirname,
  "../../data/assets/js/jquery.strokeWords.js",
);

describe("jquery.strokeWords.js missing-stroke-data fail path (#265)", () => {
  const source = readFileSync(STROKE_WORDS_PATH, "utf8");

  it("no longer silently fades an empty canvas to 50% opacity on fetch failure", () => {
    // Old #265 bug: fail callback's draw() was just fadeTo("fast", 0.5, …)
    // with no visible indication the data is missing.
    expect(source).not.toMatch(/fadeTo\(\s*"fast",\s*0\.5/);
  });

  it("marks the failed word with a stroke-missing class carrying an accessible name", () => {
    expect(source).toMatch(/\$word\.addClass\("stroke-missing"\)/);
    expect(source).toMatch(/role:\s*"img"/);
    expect(source).toMatch(/"aria-label":\s*"「"\s*\+\s*word\.text\s*\+\s*"」尚無筆順資料"/);
  });

  it("hides the blank canvas outright instead of fading it", () => {
    expect(source).toMatch(/\$\(stroker\.canvas\)\.css\("visibility",\s*"hidden"\)/);
  });

  it("renders a stroke-missing-badge with the ？ mark and 尚無筆順資料 text", () => {
    expect(source).toMatch(/class=\\"stroke-missing-badge\\"/);
    expect(source).toMatch(/stroke-missing-mark\\">？/);
    expect(source).toMatch(/stroke-missing-text\\">尚無筆順資料/);
  });

  it("cleans up the badge alongside the canvas on remove()", () => {
    expect(source).toMatch(/\$word\.find\("\.stroke-missing-badge"\)\.remove\(\)/);
  });
});

describe("src/index.css stroke-missing badge rules (#265)", () => {
  const CSS_PATH = path.resolve(import.meta.dirname, "../../src/index.css");
  const css = readFileSync(CSS_PATH, "utf8");

  it("hides the canvas for .word.stroke-missing", () => {
    expect(css).toMatch(/#strokes \.word\.stroke-missing canvas\s*\{\s*visibility:\s*hidden;/);
  });

  it("defines the badge, mark, and text classes referenced by the JS fail path", () => {
    expect(css).toMatch(/#strokes \.stroke-missing-badge\s*\{/);
    expect(css).toMatch(/#strokes \.stroke-missing-mark\s*\{/);
    expect(css).toMatch(/#strokes \.stroke-missing-text\s*\{/);
  });
});
