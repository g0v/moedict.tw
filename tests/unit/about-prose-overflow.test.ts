import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const css = readFileSync("src/pages/About.css", "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`));
  expect(match, selector).not.toBeNull();
  return match?.[0] ?? "";
}

describe("About page overflow", () => {
  it("lets inline API prose wrap instead of widening the page", () => {
    const prose = rule(".about-page .api-docs code");
    expect(prose).toContain("white-space: normal");
    expect(prose).toContain("overflow-wrap: anywhere");
    expect(prose).not.toContain("nowrap");
  });

  it("keeps code inside the scrolling API table on one line", () => {
    expect(rule(".about-page .api-table code")).toContain("white-space: nowrap");
  });
});
