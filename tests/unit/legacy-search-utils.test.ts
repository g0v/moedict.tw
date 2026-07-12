import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  collectLegacyMatchedTerms,
  hasLegacyPatternOperators,
  normalizeLegacySearchKeyword,
} from "../../src/utils/legacy-search-utils";

const SAMPLE = ["萌", "萌芽", "萌發", "芽", "發芽", "發", "日月"];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("normalizeLegacySearchKeyword", () => {
  it("converts * to %, ellipsis to ..., and normalizes CJK punctuation", () => {
    expect(normalizeLegacySearchKeyword("ab*cd")).toBe("ab%cd");
    expect(normalizeLegacySearchKeyword("a…b")).toBe("a...b");
    expect(normalizeLegacySearchKeyword("a-b")).toBe("a－b");
    expect(normalizeLegacySearchKeyword("a,b;c")).toBe("a，b；c");
  });
});

describe("hasLegacyPatternOperators", () => {
  it.each([
    ["萌%", true],
    ["萌?", true],
    ["萌.", true],
    ["^萌", true],
    ["萌$", true],
    ["萌*", true],
    ["萌_", true],
    ["萌", false],
    ["發芽", false],
  ])("operators in %s → %s", (input, expected) => {
    expect(hasLegacyPatternOperators(input)).toBe(expected);
  });
});

describe("collectLegacyMatchedTerms", () => {
  it("returns empty array for empty keyword", () => {
    expect(collectLegacyMatchedTerms(SAMPLE, "")).toEqual([]);
    expect(collectLegacyMatchedTerms(SAMPLE, "   ")).toEqual([]);
  });

  it("plain keyword: exact then prefix then contains", () => {
    expect(collectLegacyMatchedTerms(SAMPLE, "萌")).toEqual(["萌", "萌芽", "萌發"]);
  });

  it("plain keyword keeps exact matches ahead of contains matches even without prefixes", () => {
    expect(collectLegacyMatchedTerms(SAMPLE, "芽")).toEqual(["芽", "萌芽", "發芽"]);
  });

  it("surrounding whitespace disables priority sorting and uses the raw matcher order", () => {
    expect(collectLegacyMatchedTerms(SAMPLE, " 萌")).toEqual(["萌"]);
    expect(collectLegacyMatchedTerms(SAMPLE, "萌 ")).toEqual(["萌", "萌芽", "萌發"]);
  });

  it("wildcard % matches any sequence", () => {
    const result = collectLegacyMatchedTerms(SAMPLE, "萌%");
    expect(result).toEqual(expect.arrayContaining(["萌", "萌芽", "萌發"]));
    expect(result).not.toContain("芽");
    expect(result).not.toContain("發芽");
  });

  it("single-char wildcard ? matches one", () => {
    const result = collectLegacyMatchedTerms(SAMPLE, "萌?");
    expect(result).toContain("萌芽");
    expect(result).toContain("萌發");
    expect(result).not.toContain("萌");
  });

  it("anchor $ matches end", () => {
    const result = collectLegacyMatchedTerms(SAMPLE, "芽$");
    expect(result).toEqual(expect.arrayContaining(["芽", "萌芽", "發芽"]));
  });

  it("anchor ^ matches start", () => {
    const result = collectLegacyMatchedTerms(SAMPLE, "^萌");
    expect(result).toEqual(expect.arrayContaining(["萌", "萌芽", "萌發"]));
  });

  it("returns empty array when RegExp construction throws", () => {
    const OriginalRegExp = globalThis.RegExp;
    vi.stubGlobal("RegExp", function BrokenRegExp() {
      throw new SyntaxError("synthetic regex failure");
    } as unknown as typeof RegExp);

    expect(collectLegacyMatchedTerms(SAMPLE, "萌%")).toEqual([]);
    vi.stubGlobal("RegExp", OriginalRegExp);
  });

  it("covers the internal empty-priority fallback without changing public behavior", () => {
    // Intentional monkey-patching of String.prototype.trim for unit tests.
    // oxlint-disable-next-line typescript/unbound-method
    const originalTrim = String.prototype.trim;
    let trimmedSpacesCalls = 0;
    vi.spyOn(String.prototype, "trim").mockImplementation(function mockedTrim(this: string) {
      if (String(this) === "   ") {
        trimmedSpacesCalls += 1;
        return trimmedSpacesCalls === 1 ? "synthetic-non-empty" : "";
      }
      return originalTrim.call(this);
    });

    expect(collectLegacyMatchedTerms(SAMPLE, "   ")).toEqual([]);
  });
});
