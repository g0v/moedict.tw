import { describe, expect, it } from "vite-plus/test";
import {
  bopomofoSyllableToPinyin,
  convertBopomofoQueryToPinyin,
  isPureBopomofoQuery,
} from "../../src/utils/bopomofo-query-utils";

describe("isPureBopomofoQuery", () => {
  it("accepts standard zhuyin symbols with tone marks", () => {
    expect(isPureBopomofoQuery("ㄅㄚ")).toBe(true);
    expect(isPureBopomofoQuery("ㄅㄚˋ")).toBe(true);
    expect(isPureBopomofoQuery("ㄌㄠˇ˙ㄕ")).toBe(true);
    expect(isPureBopomofoQuery("ㄌㄠˇ ㄕˊ")).toBe(true);
  });

  it("rejects empty, whitespace-only, or tone-mark-only input", () => {
    expect(isPureBopomofoQuery("")).toBe(false);
    expect(isPureBopomofoQuery("   ")).toBe(false);
    expect(isPureBopomofoQuery("ˇ")).toBe(false);
  });

  it("rejects input mixed with Han characters or Latin letters", () => {
    expect(isPureBopomofoQuery("萌ㄇㄥˊ")).toBe(false);
    expect(isPureBopomofoQuery("ba1")).toBe(false);
    expect(isPureBopomofoQuery("ㄅㄚpa")).toBe(false);
  });

  it("rejects Taiwanese/Hakka extended phonetic-symbol block (U+31A0-31BF)", () => {
    // ㆠ (U+31A0) 屬台語方音符號擴充區，不在標準注音（Mandarin zhuyin）範圍內。
    expect(isPureBopomofoQuery("\u31A0")).toBe(false);
  });
});

describe("bopomofoSyllableToPinyin", () => {
  it("converts empty-rime initials (zh/ch/sh/r/z/c/s with no medial/final)", () => {
    expect(bopomofoSyllableToPinyin("ㄓ")).toBe("zhi");
    expect(bopomofoSyllableToPinyin("ㄔ")).toBe("chi");
    expect(bopomofoSyllableToPinyin("ㄕ")).toBe("shi");
    expect(bopomofoSyllableToPinyin("ㄖ")).toBe("ri");
    expect(bopomofoSyllableToPinyin("ㄗ")).toBe("zi");
    expect(bopomofoSyllableToPinyin("ㄘ")).toBe("ci");
    expect(bopomofoSyllableToPinyin("ㄙ")).toBe("si");
  });

  it("rejects a bare non-empty-rime initial with no medial/final", () => {
    expect(bopomofoSyllableToPinyin("ㄅ")).toBeNull();
    expect(bopomofoSyllableToPinyin("ㄍ")).toBeNull();
  });

  it("converts initial + bare final (no medial)", () => {
    expect(bopomofoSyllableToPinyin("ㄅㄚ")).toBe("ba");
    expect(bopomofoSyllableToPinyin("ㄍㄢ")).toBe("gan");
    expect(bopomofoSyllableToPinyin("ㄇㄣ")).toBe("men");
  });

  it("converts standalone bare finals (no initial, no medial)", () => {
    expect(bopomofoSyllableToPinyin("ㄚ")).toBe("a");
    expect(bopomofoSyllableToPinyin("ㄦ")).toBe("er");
    expect(bopomofoSyllableToPinyin("ㄣ")).toBe("en");
  });

  it("applies special with-initial medial+final spellings (not naive concatenation)", () => {
    // ㄨㄥ 接聲母拼作 ong，不是 uong
    expect(bopomofoSyllableToPinyin("ㄎㄨㄥ")).toBe("kong");
    // ㄩㄥ 接聲母拼作 iong
    expect(bopomofoSyllableToPinyin("ㄒㄩㄥ")).toBe("xiong");
    // ㄧㄡ 接聲母拼作 iu，不是 iou
    expect(bopomofoSyllableToPinyin("ㄐㄧㄡ")).toBe("jiu");
    // ㄨㄟ 接聲母拼作 ui，不是 uei
    expect(bopomofoSyllableToPinyin("ㄍㄨㄟ")).toBe("gui");
    // ㄨㄣ 接聲母拼作 un，不是 uen
    expect(bopomofoSyllableToPinyin("ㄍㄨㄣ")).toBe("gun");
    // ㄩㄝ 有聲母時（如 ㄐㄩㄝ jue）拼作 ue；無聲母時（獨立音節，如 約 yuē）拼作 yue。
    expect(bopomofoSyllableToPinyin("ㄐㄩㄝ")).toBe("jue");
    expect(bopomofoSyllableToPinyin("ㄩㄝ")).toBe("yue");
  });

  it("applies standalone (no-initial) medial spellings with y/w glide", () => {
    expect(bopomofoSyllableToPinyin("ㄧ")).toBe("yi");
    expect(bopomofoSyllableToPinyin("ㄨ")).toBe("wu");
    expect(bopomofoSyllableToPinyin("ㄩ")).toBe("yu");
    expect(bopomofoSyllableToPinyin("ㄧㄢ")).toBe("yan");
    expect(bopomofoSyllableToPinyin("ㄨㄥ")).toBe("weng");
    expect(bopomofoSyllableToPinyin("ㄩㄥ")).toBe("yong");
  });

  it("returns null for structurally invalid syllable cores", () => {
    expect(bopomofoSyllableToPinyin("ㄅㄍ")).toBeNull();
    expect(bopomofoSyllableToPinyin("ㄅㄚㄢ")).toBeNull();
  });
});

describe("convertBopomofoQueryToPinyin", () => {
  it("converts a single-syllable query", () => {
    expect(convertBopomofoQueryToPinyin("ㄅㄚ")).toBe("ba");
    expect(convertBopomofoQueryToPinyin("ㄅㄚˋ")).toBe("ba");
  });

  it("converts a multi-syllable query typed without spaces, including a neutral-tone syllable", () => {
    // 老實 (lǎo shi)：ㄌㄠˇ˙ㄕ — 輕聲點在音節前。
    expect(convertBopomofoQueryToPinyin("ㄌㄠˇ˙ㄕ")).toBe("lao shi");
  });

  it("converts a multi-syllable query typed with spaces between syllables", () => {
    expect(convertBopomofoQueryToPinyin("ㄓㄨㄥ ㄍㄨㄛˊ")).toBe("zhong guo");
  });

  it("returns null for non-bopomofo or mixed input", () => {
    expect(convertBopomofoQueryToPinyin("")).toBeNull();
    expect(convertBopomofoQueryToPinyin("中")).toBeNull();
    expect(convertBopomofoQueryToPinyin("ba")).toBeNull();
    expect(convertBopomofoQueryToPinyin("萌ㄇㄥˊ")).toBeNull();
  });

  it("returns null for a syllable sequence that cannot be fully segmented", () => {
    // 兩個聲母相鄰，不構成合法音節序列。
    expect(convertBopomofoQueryToPinyin("ㄅㄍ")).toBeNull();
  });
});
