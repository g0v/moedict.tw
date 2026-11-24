import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  addStarWord,
  addToLRU,
  buildStarKey,
  clearLRUWords,
  clearStarredWords,
  exportStarredWords,
  getLRUStorageKey,
  getStarredStorageKey,
  hasStarWord,
  importStarredWords,
  lookupHeadwordForHistory,
  normalizeRecordedWord,
  parseImportedWords,
  parseLRUWords,
  parseStarredWords,
  readLRUWords,
  readLastLookup,
  readStarredWords,
  removeLRUWord,
  removeStarWord,
  shouldRecordWord,
  writeLastLookup,
} from "../../src/utils/word-record-utils";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("storage key helpers", () => {
  it("returns namespaced keys per lang", () => {
    expect(getStarredStorageKey("a")).toBe("starred-a");
    expect(getStarredStorageKey("t")).toBe("starred-t");
    expect(getStarredStorageKey("h")).toBe("starred-h");
    expect(getStarredStorageKey("c")).toBe("starred-c");
    expect(getLRUStorageKey("a")).toBe("lru-a");
    expect(getLRUStorageKey("t")).toBe("lru-t");
  });

  it("buildStarKey wraps word in quotes with \\n suffix", () => {
    const key = buildStarKey("萌");
    expect(key).toBe('"萌"\\n');
  });
});

describe("starred words CRUD", () => {
  it("hasStarWord returns false for empty storage", () => {
    expect(hasStarWord("a", "萌")).toBe(false);
  });

  it("addStarWord adds a word and hasStarWord reports true", () => {
    addStarWord("a", "萌");
    expect(hasStarWord("a", "萌")).toBe(true);
  });

  it("addStarWord is idempotent (no duplicates)", () => {
    addStarWord("a", "萌");
    addStarWord("a", "萌");
    expect(readStarredWords("a")).toEqual(["萌"]);
  });

  it("addStarWord prepends newer words before older", () => {
    addStarWord("a", "old");
    addStarWord("a", "new");
    expect(readStarredWords("a")).toEqual(["new", "old"]);
  });

  it("removeStarWord removes a specific entry", () => {
    addStarWord("a", "one");
    addStarWord("a", "two");
    removeStarWord("a", "one");
    expect(readStarredWords("a")).toEqual(["two"]);
    expect(hasStarWord("a", "one")).toBe(false);
  });

  it("removeStarWord is a no-op when the bucket is missing", () => {
    removeStarWord("a", "missing");
    expect(readStarredWords("a")).toEqual([]);
  });

  it("normalizes percent-encoded input on write AND read", () => {
    addStarWord("a", "%E8%90%8C"); // decodes to 萌
    expect(hasStarWord("a", "萌")).toBe(true);
    expect(readStarredWords("a")).toContain("萌");
  });

  it("starred entries are language-scoped", () => {
    addStarWord("a", "萌");
    expect(hasStarWord("t", "萌")).toBe(false);
    expect(readStarredWords("t")).toEqual([]);
  });

  it("clearStarredWords removes the language bucket", () => {
    addStarWord("a", "萌");
    clearStarredWords("a");
    expect(readStarredWords("a")).toEqual([]);
  });

  it("empty word is a no-op on add/remove/has", () => {
    expect(hasStarWord("a", "")).toBe(false);
    addStarWord("a", "");
    removeStarWord("a", "");
    expect(readStarredWords("a")).toEqual([]);
  });
});

describe("parseStarredWords", () => {
  it("extracts quoted words, dedupes", () => {
    expect(parseStarredWords('"a"\\n"b"\\n"a"\\n')).toEqual(["a", "b"]);
  });

  it("returns empty for empty / non-string input", () => {
    expect(parseStarredWords("")).toEqual([]);
    expect(parseStarredWords(null as unknown as string)).toEqual([]);
  });
});

describe("LRU list", () => {
  it("addToLRU appends latest word at front", () => {
    addToLRU("one", "a");
    addToLRU("two", "a");
    expect(readLRUWords("a")).toEqual(["two", "one"]);
  });

  it("falls back to an empty bucket when storage reads fail", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("boom");
    });

    expect(readStarredWords("a")).toEqual([]);
  });

  it("drops words when trimming throws during normalization", () => {
    vi.spyOn(String.prototype, "trim").mockImplementation(() => {
      throw new Error("trim failed");
    });

    addStarWord("a", "萌");
    expect(readStarredWords("a")).toEqual([]);
  });

  it("addToLRU dedupes existing word (promotes to front)", () => {
    addToLRU("one", "a");
    addToLRU("two", "a");
    addToLRU("one", "a");
    expect(readLRUWords("a")).toEqual(["one", "two"]);
  });

  it("caps the list at 50 entries", () => {
    for (let i = 0; i < 60; i += 1) {
      addToLRU(`w${i}`, "a");
    }
    const words = readLRUWords("a");
    expect(words.length).toBe(50);
    expect(words[0]).toBe("w59");
    expect(words[49]).toBe("w10");
  });

  it("dedupes percent-encoded variants against their decoded form", () => {
    addToLRU("萌", "a");
    addToLRU("%E8%90%8C", "a");
    expect(readLRUWords("a")).toEqual(["萌"]);
  });

  it("keeps existing entries when legacy JSON parsing fails", () => {
    window.localStorage.setItem("lru-a", "{bad json");

    addToLRU("new", "a");

    expect(readLRUWords("a")).toEqual(["new"]);
  });

  it("parseLRUWords fallback dedupes repeated quoted words", () => {
    expect(parseLRUWords('"a"\\n"a"\\n"b"\\n')).toEqual(["a", "b"]);
  });

  it("keeps undecodable legacy entries while still prepending the new word", () => {
    window.localStorage.setItem("lru-a", JSON.stringify(["%E0%A4%A", "old"]));

    addToLRU("new", "a");

    expect(readLRUWords("a")).toEqual(["new", "%E0%A4%A", "old"]);
  });

  it("ignores non-recordable words at the addToLRU gate", () => {
    addToLRU("about", "a");
    addToLRU("a/b", "a");
    expect(readLRUWords("a")).toEqual([]);
  });

  it('skips the "=*" placeholder (starred landing)', () => {
    addToLRU("=*", "a");
    expect(readLRUWords("a")).toEqual([]);
  });

  it("is language-scoped", () => {
    addToLRU("萌", "a");
    expect(readLRUWords("t")).toEqual([]);
  });

  it("clearLRUWords removes the bucket", () => {
    addToLRU("萌", "a");
    clearLRUWords("a");
    expect(readLRUWords("a")).toEqual([]);
  });

  it("removeLRUWord removes a specific entry while keeping the rest", () => {
    addToLRU("one", "a");
    addToLRU("two", "a");
    addToLRU("three", "a");
    removeLRUWord("a", "two");
    expect(readLRUWords("a")).toEqual(["three", "one"]);
  });

  it("removeLRUWord matches percent-encoded stored entries", () => {
    window.localStorage.setItem(getLRUStorageKey("a"), JSON.stringify(["%E8%90%8C"]));
    removeLRUWord("a", "萌");
    expect(readLRUWords("a")).toEqual([]);
  });

  it("removeLRUWord falls back to legacy regex parsing instead of wiping the bucket", () => {
    window.localStorage.setItem(getLRUStorageKey("a"), '"one"\\n"two"\\n"three"\\n');
    removeLRUWord("a", "two");
    expect(readLRUWords("a")).toEqual(["one", "three"]);
  });

  it("removeLRUWord keeps undecodable legacy entries while removing the target word", () => {
    window.localStorage.setItem(getLRUStorageKey("a"), JSON.stringify(["%E0%A4%A", "two"]));
    removeLRUWord("a", "two");
    expect(readLRUWords("a")).toEqual(["%E0%A4%A"]);
  });

  it("removeLRUWord is a no-op for an empty word", () => {
    addToLRU("one", "a");
    removeLRUWord("a", "");
    expect(readLRUWords("a")).toEqual(["one"]);
  });

  it("removeLRUWord is language-scoped", () => {
    addToLRU("萌", "a");
    removeLRUWord("t", "萌");
    expect(readLRUWords("a")).toEqual(["萌"]);
  });

  it("removeLRUWord is a no-op when the bucket is missing", () => {
    removeLRUWord("a", "missing");
    expect(readLRUWords("a")).toEqual([]);
  });

  it("parseLRUWords handles legacy string (fall-back to regex)", () => {
    expect(parseLRUWords('"a"\\n"b"\\n')).toEqual(["a", "b"]);
  });

  it("parseLRUWords prefers JSON array format", () => {
    expect(parseLRUWords(JSON.stringify(["a", "b"]))).toEqual(["a", "b"]);
  });

  it("parseLRUWords filters non-string entries", () => {
    expect(parseLRUWords(JSON.stringify(["a", null, 42, "b"]))).toEqual(["a", "b"]);
  });

  it("drops bare route prefixes and normalizes @/'/: /~ /! forms on read", () => {
    expect(
      parseLRUWords(JSON.stringify(["@", "@玉", "萌", "'水", ":理", "~萌", "!台", "玉"])),
    ).toEqual(["玉", "萌", "水", "理", "台"]);
  });

  it("normalizes a stored radical cross-ref when a real headword is added", () => {
    window.localStorage.setItem(getLRUStorageKey("a"), JSON.stringify(["@", "@玉", "萌"]));
    addToLRU("理", "a");
    expect(readLRUWords("a")).toEqual(["理", "玉", "萌"]);
  });
});

describe("recorded headwords", () => {
  it("strips route prefixes and corpus title markup", () => {
    expect(normalizeRecordedWord("@玉")).toBe("玉");
    expect(normalizeRecordedWord("'@玉")).toBe("玉");
    expect(normalizeRecordedWord(":@理")).toBe("理");
    expect(normalizeRecordedWord("~水")).toBe("水");
    expect(normalizeRecordedWord("!台")).toBe("台");
    expect(normalizeRecordedWord("`萌~")).toBe("萌");
    expect(normalizeRecordedWord("@")).toBe("");
    expect(normalizeRecordedWord("'")).toBe("");
  });

  it("records /@玉 as 玉 and never a bare prefix", () => {
    addToLRU("@玉", "a");
    addToLRU("@", "a");
    addToLRU("'", "t");
    addToLRU(":", "h");
    addToLRU("~", "c");
    expect(readLRUWords("a")).toEqual(["玉"]);
    expect(readLRUWords("t")).toEqual([]);
    expect(readLRUWords("h")).toEqual([]);
    expect(readLRUWords("c")).toEqual([]);
  });

  it("stores the per-language headword without the route prefix", () => {
    addToLRU("'水", "t");
    addToLRU(":理", "h");
    addToLRU("~萌", "c");
    expect(readLRUWords("t")).toEqual(["水"]);
    expect(readLRUWords("h")).toEqual(["理"]);
    expect(readLRUWords("c")).toEqual(["萌"]);
  });

  it("does not record a query against a different entry's title", () => {
    // Stale「萌」still on screen while the box holds「萌理」.
    expect(lookupHeadwordForHistory("萌理", "`萌~")).toBeNull();
    expect(lookupHeadwordForHistory("萌理", "<a>萌</a>")).toBeNull();
    expect(lookupHeadwordForHistory("@", "@")).toBeNull();
    expect(lookupHeadwordForHistory("@玉", "`玉~")).toBe("玉");
    expect(lookupHeadwordForHistory("理", "`理~")).toBe("理");
    expect(lookupHeadwordForHistory("'水", "`水~")).toBe("水");
  });

  it("normalizes last-lookup away from route tokens", () => {
    writeLastLookup("@玉", "a");
    expect(readLastLookup()).toEqual({ word: "玉", lang: "a" });
    writeLastLookup("@", "a");
    expect(readLastLookup()).toEqual({ word: "玉", lang: "a" });
  });

  it("rejects route junk in shouldRecordWord", () => {
    expect(shouldRecordWord("@")).toBe(false);
    expect(shouldRecordWord("'")).toBe(false);
    expect(shouldRecordWord(":@")).toBe(false);
    expect(shouldRecordWord("@玉")).toBe(true);
    expect(shouldRecordWord("理")).toBe(true);
  });
});

describe("shouldRecordWord", () => {
  it("accepts plain Chinese words", () => {
    expect(shouldRecordWord("萌")).toBe(true);
    expect(shouldRecordWord("上訴")).toBe(true);
  });

  it("handles boxed-empty string input as non-recordable", () => {
    expect(shouldRecordWord(new String("") as unknown as string)).toBe(false);
  });

  it("rejects control placeholders", () => {
    expect(shouldRecordWord("")).toBe(false);
    expect(shouldRecordWord("#")).toBe(false);
    expect(shouldRecordWord("=*")).toBe(false);
    expect(shouldRecordWord("=近義詞")).toBe(false);
    expect(shouldRecordWord("about")).toBe(false);
    expect(shouldRecordWord("about.html")).toBe(false);
  });

  it("rejects asset-like filenames", () => {
    expect(shouldRecordWord("萌.png")).toBe(false);
    expect(shouldRecordWord("萌.JSON")).toBe(false);
    expect(shouldRecordWord("萌.svg")).toBe(false);
    expect(shouldRecordWord("a/b")).toBe(false);
  });
});

describe("last-lookup", () => {
  it("round-trips word + lang", () => {
    writeLastLookup("萌", "a");
    expect(readLastLookup()).toEqual({ word: "萌", lang: "a" });
  });

  it('defaults lang to "a" for unknown codes', () => {
    window.localStorage.setItem("prev-id", "萌");
    window.localStorage.setItem("lang", "q");
    expect(readLastLookup()).toEqual({ word: "萌", lang: "a" });
  });

  it('defaults lang to "a" when the lang key is missing', () => {
    window.localStorage.setItem("prev-id", "萌");
    expect(readLastLookup()).toEqual({ word: "萌", lang: "a" });
  });

  it("returns null when no entry", () => {
    expect(readLastLookup()).toBeNull();
  });

  it("ignores non-recordable words (about, =*, assets)", () => {
    writeLastLookup("about", "a");
    expect(readLastLookup()).toBeNull();
    writeLastLookup("=*", "a");
    expect(readLastLookup()).toBeNull();
    writeLastLookup("x.png", "a");
    expect(readLastLookup()).toBeNull();
  });

  it("preserves pre-existing recordable word from storage", () => {
    window.localStorage.setItem("prev-id", "萌");
    window.localStorage.setItem("lang", "c");
    expect(readLastLookup()).toEqual({ word: "萌", lang: "c" });
  });
});

describe("exportStarredWords (#219)", () => {
  it("returns empty string for lang with no stars", () => {
    expect(exportStarredWords("a")).toBe("");
  });

  it("joins current storage order with newlines, no trailing metadata", () => {
    addStarWord("a", "萌");
    addStarWord("a", "典");
    // addStarWord prepends, so most-recently-starred word is first.
    expect(exportStarredWords("a")).toBe("典\n萌");
  });

  it("is scoped to the given lang only", () => {
    addStarWord("a", "萌");
    addStarWord("t", "食");
    expect(exportStarredWords("a")).toBe("萌");
    expect(exportStarredWords("t")).toBe("食");
  });
});

describe("parseImportedWords (#219)", () => {
  it("dedupes by first occurrence, preserving order", () => {
    expect(parseImportedWords("萌\n典\n萌\n")).toEqual(["萌", "典"]);
  });

  it("trims whitespace and drops blank lines", () => {
    expect(parseImportedWords("  萌  \n\n\n  典\n")).toEqual(["萌", "典"]);
  });

  it("splits on CRLF, CR, and LF line endings", () => {
    expect(parseImportedWords("萌\r\n典\r字\n詞")).toEqual(["萌", "典", "字", "詞"]);
  });

  it("rejects lines failing shouldRecordWord", () => {
    expect(parseImportedWords("萌\n#\nabout\n=*\na/b\n萌.png\n典")).toEqual(["萌", "典"]);
  });

  it("returns empty for empty / whitespace-only / non-string input", () => {
    expect(parseImportedWords("")).toEqual([]);
    expect(parseImportedWords("   \n  \n")).toEqual([]);
    expect(parseImportedWords(null as unknown as string)).toEqual([]);
  });
});

describe("importStarredWords (#219)", () => {
  it("imports fresh words into an empty starred set, preserving pasted order", () => {
    const result = importStarredWords("a", "萌\n典\n字");
    expect(result).toEqual({ imported: ["萌", "典", "字"], skipped: 0, total: 3 });
    // addStarWord prepends on each call; importStarredWords must counteract
    // that so storage read-back matches pasted order, not reversed order.
    expect(readStarredWords("a")).toEqual(["萌", "典", "字"]);
  });

  it("merges imported-new words ahead of untouched existing words", () => {
    addStarWord("a", "舊詞");
    const result = importStarredWords("a", "萌\n典");
    expect(result.imported).toEqual(["萌", "典"]);
    expect(readStarredWords("a")).toEqual(["萌", "典", "舊詞"]);
  });

  it("skipped counts invalid, in-paste duplicate, and already-existing lines", () => {
    addStarWord("a", "已收藏");
    const result = importStarredWords("a", "新詞\n已收藏\n新詞\n#\n");
    // total nonempty lines: 新詞, 已收藏, 新詞, # = 4
    // imported: only 新詞 (already-existing 已收藏 filtered, dup 新詞 filtered, # invalid)
    expect(result).toEqual({ imported: ["新詞"], skipped: 3, total: 4 });
    expect(readStarredWords("a")).toEqual(["新詞", "已收藏"]);
  });

  it("is a no-op (all skipped, no write) when every line fails shouldRecordWord", () => {
    const before = readStarredWords("a");
    const result = importStarredWords("a", "#\nabout\n=*");
    expect(result).toEqual({ imported: [], skipped: 3, total: 3 });
    expect(readStarredWords("a")).toEqual(before);
  });

  it("does not write when input is empty or whitespace-only", () => {
    expect(importStarredWords("a", "")).toEqual({ imported: [], skipped: 0, total: 0 });
    expect(importStarredWords("a", "   \n  ")).toEqual({ imported: [], skipped: 0, total: 0 });
    expect(window.localStorage.getItem(getStarredStorageKey("a"))).toBeNull();
  });

  it("does not touch sibling-language storage keys", () => {
    addStarWord("t", "既有");
    importStarredWords("a", "萌\n典");
    expect(readStarredWords("t")).toEqual(["既有"]);
    expect(window.localStorage.getItem(getStarredStorageKey("t"))).toBe(buildStarKey("既有"));
  });

  it("reports actually-persisted words only — a setItem failure mid-import is skipped, not falsely imported", () => {
    const setItemSpy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    const result = importStarredWords("a", "萌");
    expect(result).toEqual({ imported: [], skipped: 1, total: 1 });
    expect(window.localStorage.getItem(getStarredStorageKey("a"))).toBeNull();

    setItemSpy.mockRestore();
  });
});
