import { describe, expect, it, vi } from "vite-plus/test";

// Exercise the fallback contract at the parser boundary. htmlparser2 currently
// fills these properties, but keeping the fallback behavior protects callers
// if a parser replacement or version change omits one of them.
vi.mock("htmlparser2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("htmlparser2")>();
  return {
    ...actual,
    parseDocument(html: string, options?: Parameters<typeof actual.parseDocument>[1]) {
      if (html === "__parser_contract_missing_fields__") {
        return {
          children: [
            { type: "text", data: undefined },
            { type: "tag", name: "span", children: undefined, attribs: undefined },
          ],
        } as unknown as ReturnType<typeof actual.parseDocument>;
      }
      return actual.parseDocument(html, options);
    },
  };
});

import { sanitizeDictionaryHtml } from "../../src/utils/sanitize-dictionary-html";

describe("sanitizeDictionaryHtml parser boundary", () => {
  it("handles missing text, children, and attributes without leaking markup", () => {
    expect(sanitizeDictionaryHtml("__parser_contract_missing_fields__")).toBe("<span></span>");
    expect(sanitizeDictionaryHtml("<b>詞</b>")).toBe("<b>詞</b>");
  });
});
