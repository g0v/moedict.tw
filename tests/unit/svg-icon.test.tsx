/**
 * Coverage test for SvgIcon — locks the pixel-alignment work from recent
 * commits (e6b2677 / cf3b09f / 07fb998 / ce19331) so future edits to icon
 * metrics, names, or glyph data can't silently regress.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { SvgIcon, type SvgIconName } from "../../src/components/SvgIcon";

const ICON_NAMES: SvgIconName[] = [
  "android",
  "apple",
  "arrowLeft",
  "book",
  "bookmarkEmpty",
  "cogs",
  "copy",
  "download",
  "info",
  "pencil",
  "play",
  "plusCircle",
  "print",
  "removeCircle",
  "resizeFull",
  "resizeSmall",
  "search",
  "share",
  "spinner",
  "star",
  "starEmpty",
  "stop",
];

describe("SvgIcon rendering", () => {
  it.each(ICON_NAMES)("renders %s with a non-empty glyph path", (name) => {
    const html = renderToStaticMarkup(<SvgIcon name={name} />);
    expect(html).toContain("<svg");
    // path d attribute must be non-empty
    const d = html.match(/\bd="([^"]+)"/)?.[1];
    expect(d).toBeDefined();
    expect(d!.length).toBeGreaterThan(10);
    expect(html).toContain('viewBox="0 0 ');
  });

  it.each(ICON_NAMES)("applies ascent-shift transform on %s", (name) => {
    // The transform `translate(0 1536) scale(1 -1)` flips the FontAwesome path
    // into top-down SVG space. If a refactor drops this, icons fall off the
    // baseline — which is exactly what commits cf3b09f / 07fb998 fixed.
    const html = renderToStaticMarkup(<SvgIcon name={name} />);
    expect(html).toContain('transform="translate(0 1536) scale(1 -1)"');
  });

  it.each(ICON_NAMES)("paints %s with currentColor", (name) => {
    const html = renderToStaticMarkup(<SvgIcon name={name} />);
    expect(html).toContain('fill="currentColor"');
  });

  it("sizes via numeric size prop (square height, aspect-scaled width)", () => {
    const html = renderToStaticMarkup(<SvgIcon name="star" size={24} />);
    // star glyph width is 1664, FA height is 1792 → ratio 1664/1792 ≈ 0.9286
    // So at size=24, width = 24 * 1664/1792 ≈ 22.286px
    expect(html).toMatch(/height:\s*24px/);
    expect(html).toMatch(/width:\s*22\.\d+px/);
  });

  it("sizes via string size prop using calc() for width", () => {
    const html = renderToStaticMarkup(<SvgIcon name="info" size="1em" />);
    expect(html).toMatch(/height:\s*1em/);
    // info glyph width is 640 → ratio 640/1792 ≈ 0.357
    expect(html).toMatch(/width:\s*calc\(1em \* 0\.\d+\)/);
  });

  it("keeps the default 1em size when size prop is omitted", () => {
    const html = renderToStaticMarkup(<SvgIcon name="cogs" />);
    expect(html).toMatch(/height:\s*1em/);
    expect(html).toMatch(/width:\s*calc\(1em \*/);
  });

  it("tags the svg with the moe-icon class and forwards className", () => {
    const html = renderToStaticMarkup(<SvgIcon name="star" className="navbar-btn" />);
    expect(html).toMatch(/class="moe-icon navbar-btn"/);
  });

  it("marks svg aria-hidden when no title is given", () => {
    const html = renderToStaticMarkup(<SvgIcon name="star" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('role="presentation"');
    expect(html).not.toContain("<title>");
  });

  it("exposes an accessible name via <title> when title prop is set", () => {
    const html = renderToStaticMarkup(<SvgIcon name="star" title="加入收藏" />);
    expect(html).toContain("<title>加入收藏</title>");
    expect(html).toContain('role="img"');
    expect(html).not.toContain('aria-hidden="true"');
  });
});
