import { describe, expect, it } from "vite-plus/test";
import {
  normalizeLegacyGlyphsForLookup,
  replaceLegacyGlyphsForDisplay,
} from "../../src/utils/legacy-glyph-utils";

const PUA = "\u{F8FF0}";

describe("replaceLegacyGlyphsForDisplay", () => {
  it("expands the ⿰亻壯 PUA codepoint into its IDS form", () => {
    expect(replaceLegacyGlyphsForDisplay(PUA)).toBe("⿰亻壯");
  });

  it("replaces every occurrence, not just the first", () => {
    expect(replaceLegacyGlyphsForDisplay(`${PUA}x${PUA}`)).toBe("⿰亻壯x⿰亻壯");
  });

  it("passes non-mapped strings through unchanged", () => {
    expect(replaceLegacyGlyphsForDisplay("萌典")).toBe("萌典");
    expect(replaceLegacyGlyphsForDisplay("")).toBe("");
  });

  it("coerces nullish / non-string input to empty string", () => {
    // Treating function as permissive about input type matches the impl's
    // `String(input || '')` guard.
    expect(replaceLegacyGlyphsForDisplay(undefined as unknown as string)).toBe("");
    expect(replaceLegacyGlyphsForDisplay(null as unknown as string)).toBe("");
  });
});

describe("normalizeLegacyGlyphsForLookup", () => {
  it("collapses ⿰亻壯 PUA to its base character for index lookup", () => {
    expect(normalizeLegacyGlyphsForLookup(PUA)).toBe("壯");
  });

  it("leaves already-normalized input untouched", () => {
    expect(normalizeLegacyGlyphsForLookup("壯")).toBe("壯");
    expect(normalizeLegacyGlyphsForLookup("")).toBe("");
  });

  it("normalizes inline occurrences", () => {
    expect(normalizeLegacyGlyphsForLookup(`X${PUA}Y`)).toBe("X壯Y");
  });
});
