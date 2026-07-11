import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  addStarWord,
  addToLRU,
  buildStarKey,
  clearLRUWords,
  clearStarredWords,
  getLRUStorageKey,
  getStarredStorageKey,
  hasStarWord,
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
