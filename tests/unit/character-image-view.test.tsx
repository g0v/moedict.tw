import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { renderFormattedPhonetics } from "../../src/components/CharacterImageView";

describe("CharacterImage phonetic caption rendering", () => {
  it("renders hostile formatter input as literal text without markup", () => {
    const hostile = "<img src=x onerror=alert(1)> <script>alert(1)</script>";
    const html = renderToStaticMarkup(renderFormattedPhonetics(hostile));
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
  });
});
