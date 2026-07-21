import { describe, expect, it } from "vite-plus/test";
import { sortHeteronymsBySubstitutionReading } from "../../src/utils/heteronym-order";

describe("sortHeteronymsBySubstitutionReading", () => {
  const byReadingType = (h: { reading: string }) => h.reading;

  it("moves a single 替 heteronym to the end, real-headword heteronym first (一: tsi̍t/替 after it)", () => {
    // Real pack order for 一 (ptck bucket 0): [tsi̍t(id=1, 替), it(id=2, no
    // reading field)] — sutian's own /tshiau/ lists it (real headword)
    // before tsi̍t (替字, real char 蜀). id order does NOT track this: su/1
    // IS the 替 page, so sorting by id would be backwards.
    const tsit = { id: "1", reading: "替" };
    const itReading = { id: "2", reading: "" };

    const result = sortHeteronymsBySubstitutionReading([tsit, itReading], byReadingType);

    expect(result).toEqual([itReading, tsit]);
  });

  it("is a no-op when no heteronym is 替", () => {
    const wen = { id: "1", reading: "文" };
    const bai = { id: "2", reading: "白" };

    const result = sortHeteronymsBySubstitutionReading([wen, bai], byReadingType);

    expect(result).toEqual([wen, bai]);
  });

  it("is a no-op when every heteronym is 替 (nothing to partition against)", () => {
    const a = { id: "1", reading: "替" };
    const b = { id: "2", reading: "替" };

    const result = sortHeteronymsBySubstitutionReading([a, b], byReadingType);

    expect(result).toEqual([a, b]);
  });

  it("does not reorder within either group — stable on both sides of the partition", () => {
    // 文/白/俗 are register variants of the real headword, not
    // substitutions; their relative order must be untouched by this sort,
    // only 替 heteronyms move (to the end, keeping their own relative order).
    const bai = { id: "1", reading: "白" };
    const su = { id: "2", reading: "俗" };
    const ti1 = { id: "3", reading: "替" };
    const wen = { id: "4", reading: "文" };
    const ti2 = { id: "5", reading: "替" };

    const result = sortHeteronymsBySubstitutionReading([bai, su, ti1, wen, ti2], byReadingType);

    expect(result).toEqual([bai, su, wen, ti1, ti2]);
  });

  it("treats an empty/undefined reading classification as non-替 (kept in original position)", () => {
    const noReading = { id: "1", reading: "" };
    const ti = { id: "2", reading: "替" };

    const result = sortHeteronymsBySubstitutionReading([noReading, ti], byReadingType);

    expect(result).toEqual([noReading, ti]);
  });

  it("returns a new array, never mutating the input", () => {
    const ti = { id: "1", reading: "替" };
    const real = { id: "2", reading: "" };
    const input = [ti, real];
    const inputCopy = [...input];

    const result = sortHeteronymsBySubstitutionReading(input, byReadingType);

    expect(input).toEqual(inputCopy);
    expect(result).not.toBe(input);
  });

  it("only matches the exact 替 code, not readingType strings that merely contain it", () => {
    const weird = { id: "1", reading: "替代字" };
    const ti = { id: "2", reading: "替" };

    const result = sortHeteronymsBySubstitutionReading([weird, ti], byReadingType);

    // "替代字" !== "替" exactly, so it is NOT treated as a substitution
    // reading here — this sort only recognizes the canonical single-glyph
    // TWBLG classification code, matching TitlePronunciation's own
    // READING_TYPE_LABELS lookup convention (exact-code keyed).
    expect(result).toEqual([weird, ti]);
  });
});
