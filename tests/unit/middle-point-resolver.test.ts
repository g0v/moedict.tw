/**
 * resolveMiddlePointTarget — the pure pathname→page mapping behind the
 * client-side `path="*"` router. The prefix grammar itself lives in
 * classifyRoute (dictionary-route.test.ts); these tests lock the
 * page-mapping policy INCLUDING the preserved legacy edge behaviors
 * (multi-slash → home, empty radical/category → dictionary fallbacks).
 */
import { describe, expect, it } from "vite-plus/test";
import { resolveMiddlePointTarget } from "../../src/utils/middle-point-target";

describe("resolveMiddlePointTarget", () => {
  it("maps the four dictionary-entry prefixes", () => {
    expect(resolveMiddlePointTarget("/萌")).toEqual({
      page: "dict",
      lang: "a",
      word: "萌",
      idx: undefined,
    });
    expect(resolveMiddlePointTarget("/'食")).toEqual({
      page: "dict",
      lang: "t",
      word: "食",
      idx: undefined,
    });
    expect(resolveMiddlePointTarget("/:字")).toEqual({
      page: "dict",
      lang: "h",
      word: "字",
      idx: undefined,
    });
    expect(resolveMiddlePointTarget("/~上訴")).toEqual({
      page: "dict",
      lang: "c",
      word: "上訴",
      idx: undefined,
    });
  });

  it("carries the /N definition-index permalink to dictionary pages", () => {
    expect(resolveMiddlePointTarget("/萌/3")).toEqual({
      page: "dict",
      lang: "a",
      word: "萌",
      idx: 3,
    });
    expect(resolveMiddlePointTarget("/'%E6%8F%A4/2")).toEqual({
      page: "dict",
      lang: "t",
      word: "揤",
      idx: 2,
    });
  });

  it("maps radical detail routes", () => {
    expect(resolveMiddlePointTarget("/@木")).toEqual({ page: "radical", lang: "a", radical: "木" });
    expect(resolveMiddlePointTarget("/~@水")).toEqual({
      page: "radical",
      lang: "c",
      radical: "水",
    });
    expect(resolveMiddlePointTarget("/'@木")).toEqual({
      page: "radical",
      lang: "t",
      radical: "木",
    });
    expect(resolveMiddlePointTarget("/:@木")).toEqual({
      page: "radical",
      lang: "h",
      radical: "木",
    });
  });

  it("maps starred routes with optional entry suffix", () => {
    expect(resolveMiddlePointTarget("/=*")).toEqual({
      page: "starred",
      lang: "a",
      entry: undefined,
    });
    expect(resolveMiddlePointTarget("/'=*")).toEqual({
      page: "starred",
      lang: "t",
      entry: undefined,
    });
    expect(resolveMiddlePointTarget("/=*萌")).toEqual({ page: "starred", lang: "a", entry: "萌" });
    expect(resolveMiddlePointTarget("/:=*字")).toEqual({ page: "starred", lang: "h", entry: "字" });
  });

  it("maps group/category list routes", () => {
    expect(resolveMiddlePointTarget("/=成語")).toEqual({
      page: "list",
      lang: "a",
      category: "成語",
    });
    expect(resolveMiddlePointTarget("/'=動物")).toEqual({
      page: "list",
      lang: "t",
      category: "動物",
    });
    expect(resolveMiddlePointTarget("/~=同實異名")).toEqual({
      page: "list",
      lang: "c",
      category: "同實異名",
    });
  });

  it("sends multi-slash payloads home (single-segment policy)", () => {
    expect(resolveMiddlePointTarget("/foo/bar")).toEqual({ page: "home" });
    expect(resolveMiddlePointTarget("/a/b/2")).toEqual({ page: "home" });
    expect(resolveMiddlePointTarget("/@木/foo")).toEqual({ page: "home" });
    expect(resolveMiddlePointTarget("/=成/語")).toEqual({ page: "home" });
    expect(resolveMiddlePointTarget("/=*a/b")).toEqual({ page: "home" });
  });

  it("sends empty and undecodable paths home", () => {
    expect(resolveMiddlePointTarget("/")).toEqual({ page: "home" });
    expect(resolveMiddlePointTarget("")).toEqual({ page: "home" });
    expect(resolveMiddlePointTarget("/%")).toEqual({ page: "home" });
  });

  it('preserves the legacy empty-radical fallback (bare @ → dictionary "@")', () => {
    expect(resolveMiddlePointTarget("/@")).toEqual({ page: "dict", lang: "a", word: "@" });
    expect(resolveMiddlePointTarget("/~@")).toEqual({ page: "dict", lang: "c", word: "@" });
    expect(resolveMiddlePointTarget("/'@")).toEqual({ page: "dict", lang: "t", word: "@" });
    expect(resolveMiddlePointTarget("/:@")).toEqual({ page: "dict", lang: "h", word: "@" });
  });

  it('preserves the legacy empty-category fallback (bare = → dictionary "=")', () => {
    expect(resolveMiddlePointTarget("/=")).toEqual({ page: "dict", lang: "a", word: "=" });
    expect(resolveMiddlePointTarget("/'=")).toEqual({ page: "dict", lang: "t", word: "=" });
  });

  it("routes about to the about page", () => {
    expect(resolveMiddlePointTarget("/about")).toEqual({ page: "about" });
  });
});
