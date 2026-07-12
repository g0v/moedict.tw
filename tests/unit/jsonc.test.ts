/// <reference types="node" />
/**
 * Unit tests for the minimal JSONC reader (scripts/lib/jsonc.mjs), used to
 * parse `wrangler.jsonc` for the deploy-safety static guard. Covers real
 * comments, real trailing commas, AND the string-literal-awareness that
 * both passes need — a string value containing a literal `,}`/`,]`
 * sequence (or `//`/`/* *\/`) must survive byte-for-byte.
 */
import { describe, expect, it } from "vite-plus/test";
import { parseJsonc, stripJsoncComments } from "../../scripts/lib/jsonc.mjs";

describe("parseJsonc — real comments and trailing commas", () => {
  it("strips // line comments", () => {
    expect(parseJsonc('{\n  // a comment\n  "a": 1\n}')).toEqual({ a: 1 });
  });

  it("strips /* */ block comments, including multi-line", () => {
    expect(parseJsonc('{\n  /* block\n   comment */\n  "a": 1\n}')).toEqual({ a: 1 });
  });

  it("strips a trailing comment after a value on the same line", () => {
    expect(parseJsonc('{ "a": 1 // trailing\n}')).toEqual({ a: 1 });
  });

  it("removes a trailing comma before a closing }", () => {
    expect(parseJsonc('{ "a": 1, }')).toEqual({ a: 1 });
  });

  it("removes a trailing comma before a closing ]", () => {
    expect(parseJsonc('{ "a": [1, 2, ] }')).toEqual({ a: [1, 2] });
  });

  it("removes a trailing comma with newlines/whitespace before the closer", () => {
    expect(parseJsonc('{\n  "a": 1,\n\n}')).toEqual({ a: 1 });
  });

  it("removes nested trailing commas in both objects and arrays together", () => {
    expect(parseJsonc('{\n  "a": [1, 2,],\n  "b": { "c": 3, },\n}')).toEqual({
      a: [1, 2],
      b: { c: 3 },
    });
  });
});

describe("parseJsonc — string-literal awareness (the actual regression this guards)", () => {
  it("preserves a URL string containing // untouched", () => {
    expect(parseJsonc('{ "url": "https://r2-assets.moedict.tw" }')).toEqual({
      url: "https://r2-assets.moedict.tw",
    });
  });

  it("preserves a string value containing a literal ,} sequence", () => {
    expect(parseJsonc('{ "snippet": "foo(a,}bar)" }')).toEqual({ snippet: "foo(a,}bar)" });
  });

  it("preserves a string value containing a literal ,] sequence", () => {
    expect(parseJsonc('{ "snippet": "[1,2,]" }')).toEqual({ snippet: "[1,2,]" });
  });

  it("preserves a string containing ,} immediately followed by a real trailing comma outside the string", () => {
    // The string's own `,}` must survive; the REAL trailing comma after the
    // string (before the object's closing `}`) must still be stripped.
    expect(parseJsonc('{ "a": "x,}y", }')).toEqual({ a: "x,}y" });
  });

  it("preserves an escaped quote inside a string without breaking string-boundary tracking", () => {
    expect(parseJsonc('{ "a": "she said \\"hi,}\\" today" }')).toEqual({
      a: 'she said "hi,}" today',
    });
  });

  it("preserves a string containing /* and */ literally (not treated as a block comment)", () => {
    expect(parseJsonc('{ "a": "/* not a comment */" }')).toEqual({ a: "/* not a comment */" });
  });

  it("real-world shape: wrangler.jsonc-style config with URL vars, comments, and trailing commas together", () => {
    const src = `{
      // top-level comment
      "vars": {
        "ASSET_BASE_URL": "https://r2-assets.moedict.tw", // trailing comment
        "DICTIONARY_BASE_URL": "https://r2-dictionary.moedict.tw",
      },
      "version_metadata": { "binding": "CF_VERSION_METADATA" },
    }`;
    expect(parseJsonc(src)).toEqual({
      vars: {
        ASSET_BASE_URL: "https://r2-assets.moedict.tw",
        DICTIONARY_BASE_URL: "https://r2-dictionary.moedict.tw",
      },
      version_metadata: { binding: "CF_VERSION_METADATA" },
    });
  });
});

describe("stripJsoncComments — comment stripping alone (pre-trailing-comma-removal stage)", () => {
  it("is string-aware for // inside string values", () => {
    expect(stripJsoncComments('{ "url": "https://x" }')).toContain('"https://x"');
  });

  it("does not touch trailing commas by itself (that is a separate, later pass)", () => {
    expect(stripJsoncComments('{ "a": 1, }')).toContain(",");
  });
});
