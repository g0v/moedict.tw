import { describe, expect, it } from "vite-plus/test";
import {
  decodePackedKey,
  renderMarkedHtml,
  renderEntryHtml,
  renderHeteronym,
  stardictCompare,
  encodeIdxEntry,
} from "../../scripts/build-reader-formats.mjs";

describe("decodePackedKey", () => {
  it("decodes %uXXXX and %XX escapes", () => {
    expect(decodePackedKey("%u4FDE")).toBe("俞");
    expect(decodePackedKey("a%20b")).toBe("a b");
  });
});

describe("renderMarkedHtml", () => {
  it("strips segmentation markers without bolding", () => {
    expect(renderMarkedHtml("`國~`名~。")).toBe("國名。");
  });

  it("escapes html, drops interlinear chars, converts newlines", () => {
    expect(renderMarkedHtml("a<b>&\nx\uFFF9")).toBe("a&lt;b&gt;&amp;<br>x");
  });
});

describe("renderEntryHtml translations", () => {
  const heteronym = { b: "ㄩˊ", d: [{ type: "`動~", f: "`挖~`空~。" }] };

  it("renders the translation object arrays, never [object Object]", () => {
    const html = renderEntryHtml("俞", "a", {
      t: "俞",
      h: [heteronym],
      English: "surname Yu",
      translation: { English: ["surname Yu", "to assent"], francais: ["(nom de famille)"] },
    });
    expect(html).not.toContain("[object Object]");
    expect(html).not.toContain("翻譯");
    expect(html).toContain("English：surname Yu; to assent");
    expect(html).toContain("Français：(nom de famille)");
  });

  it("falls back to top-level strings when there is no translation object", () => {
    const html = renderEntryHtml("x", "a", { t: "x", h: [heteronym], English: "foo" });
    expect(html).toContain("English：foo");
  });

  it("renders cross-strait entries whose glosses live only in translation", () => {
    const html = renderEntryHtml("依", "c", {
      t: "依",
      h: [heteronym],
      translation: { English: ["to depend on"], Deutsch: ["abhängig sein von etw."] },
    });
    expect(html).not.toContain("[object Object]");
    expect(html).toContain("English：to depend on");
    expect(html).toContain("Deutsch：abhängig sein von etw.");
  });
});

describe("renderHeteronym", () => {
  it("does not surface the raw audio id", () => {
    const html = renderHeteronym({ b: "ㄩˊ", "=": "6450", d: [] }, 0);
    expect(html).not.toContain("音檔");
    expect(html).not.toContain("6450");
  });
});

describe("stardictCompare", () => {
  it("orders by utf-8 byte order (code point), not locale", () => {
    const words = ["俞", "一", "㐀", "𠀀", "人"];
    expect([...words].sort(stardictCompare)).toEqual(["㐀", "一", "人", "俞", "𠀀"]);
  });

  it("is ascii case-insensitive then byte-wise", () => {
    expect(stardictCompare("A", "a")).toBeLessThan(0);
    expect(stardictCompare("abc", "ABC")).toBeGreaterThan(0);
    expect(stardictCompare("foo", "foo")).toBe(0);
  });
});

describe("encodeIdxEntry", () => {
  it("packs word + NUL + offset(BE32) + size(BE32)", () => {
    const wordBytes = Buffer.from("俞", "utf8");
    const buffer = encodeIdxEntry("俞", 0x10203040, 7);
    expect(buffer.subarray(0, wordBytes.length).equals(wordBytes)).toBe(true);
    expect(buffer[wordBytes.length]).toBe(0);
    expect(buffer.readUInt32BE(wordBytes.length + 1)).toBe(0x10203040);
    expect(buffer.readUInt32BE(wordBytes.length + 5)).toBe(7);
    expect(buffer.length).toBe(wordBytes.length + 1 + 8);
  });
});
