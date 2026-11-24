import { describe, expect, it } from "vite-plus/test";
import { TAIWANESE_ROMAN_INPUT_RE } from "../../src/components/searchbox";

describe("Taiwanese romanization search input", () => {
  it("accepts tone marks that normalizeTaiwaneseLookupTerm strips", () => {
    for (const term of ["tsia̍h", "pn̄g", "chhiū", "tsiah"]) {
      expect(TAIWANESE_ROMAN_INPUT_RE.test(term), term).toBe(true);
    }
  });

  it("still rejects input that is not Latin romanization", () => {
    for (const term of ["", "食", "123", "tsiah!", "tsiah。"]) {
      expect(TAIWANESE_ROMAN_INPUT_RE.test(term), term).toBe(false);
    }
  });
});
