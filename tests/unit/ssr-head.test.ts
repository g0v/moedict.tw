import { describe, expect, it } from "vite-plus/test";
import {
  resolveHeadByPath,
  applyHeadToDocument,
  applyHeadByPath,
  getDictionaryHead,
  escapeHeadContent,
} from "../../src/ssr/head";

const DEFAULT_DESCRIPTION =
  "共收錄十六萬筆國語、兩萬筆臺語、一萬四千筆客語條目，每個字詞都可以輕按連到說明，並提供 Android 及 iOS 離線 App。";
const DEFAULT_IMAGE = "https://www.moedict.tw/assets/images/icon.png";

describe("resolveHeadByPath", () => {
  describe("default / home route", () => {
    it("returns default head for /", () => {
      const head = resolveHeadByPath("/");
      expect(head.title).toBe("萌典");
      expect(head.description).toBe(DEFAULT_DESCRIPTION);
      expect(head.ogUrl).toBe("https://www.moedict.tw");
      expect(head.ogImage).toBe(DEFAULT_IMAGE);
      expect(head.twitterSite).toBe("@moedict");
      expect(head.twitterCreator).toBe("@audreyt");
    });

    it("returns default head for empty pathname", () => {
      expect(resolveHeadByPath("").title).toBe("萌典");
    });

    it("strips query string before routing", () => {
      expect(resolveHeadByPath("/?foo=bar").title).toBe("萌典");
    });

    it("strips trailing slashes", () => {
      expect(resolveHeadByPath("///").title).toBe("萌典");
    });
  });

  describe("about / privacy routes", () => {
    it("returns about head for /about", () => {
      const head = resolveHeadByPath("/about");
      expect(head.title).toBe("關於本站 - 萌典");
      expect(head.description).toContain("萌典資料來源");
      expect(head.ogUrl).toBe("https://www.moedict.tw/about");
    });

    it("returns about head for /about.html (legacy alias)", () => {
      expect(resolveHeadByPath("/about.html").title).toBe("關於本站 - 萌典");
    });

    it("returns privacy head for /privacy (not a 'privacy' headword lookup)", () => {
      const head = resolveHeadByPath("/privacy");
      expect(head.title).toBe("隱私權政策 - 萌典");
      expect(head.description).toContain("不蒐集任何個人資料");
      expect(head.ogUrl).toBe("https://www.moedict.tw/privacy");
    });
  });

  describe("radical routes", () => {
    it("returns empty-radical head for /@", () => {
      const head = resolveHeadByPath("/@");
      expect(head.title).toBe("部首表 - 萌典");
      expect(head.description).toContain("部首索引");
    });

    it("returns empty-radical head for /~@ with 兩岸 brand", () => {
      const head = resolveHeadByPath("/~@");
      expect(head.title).toBe("部首表 - 兩岸萌典");
      expect(head.description).toContain("兩岸");
    });

    it("resolves specific radical /@木 to 木 部", () => {
      const head = resolveHeadByPath("/@木");
      expect(head.title).toBe("木 部 - 萌典");
    });

    it("resolves radical with 兩岸 brand /~@水", () => {
      const head = resolveHeadByPath("/~@水");
      expect(head.title).toBe("水 部 - 兩岸萌典");
    });

    it("returns empty-radical head for /'@ with 台語 brand", () => {
      const head = resolveHeadByPath("/'@");
      expect(head.title).toBe("部首表 - 台語萌典");
      expect(head.description).toContain("臺灣台語");
    });

    it("resolves radical with 台語萌典 brand /'@木", () => {
      const head = resolveHeadByPath("/'@木");
      expect(head.title).toBe("木 部 - 台語萌典");
    });

    it("uses the Hakka brand and explains CNS total-stroke grouping", () => {
      const head = resolveHeadByPath("/:@木");
      expect(head.title).toBe("木 部 - 客語萌典");
      expect(head.description).toContain("CNS11643");
      expect(head.description).toContain("總筆畫");
    });

    it("decodes percent-encoded radical", () => {
      expect(resolveHeadByPath("/@%E6%9C%A8").title).toBe("木 部 - 萌典");
    });
  });

  describe("starred routes", () => {
    it("routes /=* to starred page (a)", () => {
      expect(resolveHeadByPath("/=*").title).toBe("字詞紀錄簿 - 萌典");
    });

    it("routes /'=* to starred page (t)", () => {
      expect(resolveHeadByPath("/'=*").title).toBe("字詞紀錄簿 - 台語萌典");
    });

    it("routes /:=* to starred page (h)", () => {
      expect(resolveHeadByPath("/:=*").title).toBe("字詞紀錄簿 - 客語萌典");
    });

    it("routes /~=* to starred page (c)", () => {
      expect(resolveHeadByPath("/~=*").title).toBe("字詞紀錄簿 - 兩岸萌典");
    });
  });

  describe("group / category routes", () => {
    it("routes /=近義詞 as group list", () => {
      expect(resolveHeadByPath("/=近義詞").title).toBe("近義詞 - 分類索引 - 萌典");
    });

    it("routes /'=台諺語 as group list (t)", () => {
      expect(resolveHeadByPath("/'=台諺語").title).toBe("台諺語 - 分類索引 - 台語萌典");
    });

    it("routes /~=成語 as group list (c)", () => {
      expect(resolveHeadByPath("/~=成語").title).toBe("成語 - 分類索引 - 兩岸萌典");
    });

    it("handles empty category (=)", () => {
      expect(resolveHeadByPath("/=").title).toBe("分類索引 - 萌典");
    });

    it("handles empty category (:=) for Hakka", () => {
      expect(resolveHeadByPath("/:=").title).toBe("分類索引 - 客語萌典");
    });
  });

  describe("dictionary routes", () => {
    it("routes /萌 to 萌 - 萌典", () => {
      const head = resolveHeadByPath("/萌");
      expect(head.title).toBe("萌 - 萌典");
      expect(head.ogImage).toBe("https://www.moedict.tw/%E8%90%8C.png");
      expect(head.twitterImage).toBe(head.ogImage);
    });

    it("routes /'食 to Taiwanese dictionary head", () => {
      const head = resolveHeadByPath("/'食");
      expect(head.title).toBe("食 - 台語萌典");
      expect(head.description).toContain("台語");
    });

    it("routes /:字 to Hakka dictionary head", () => {
      expect(resolveHeadByPath("/:字").title).toBe("字 - 客語萌典");
    });

    it("routes /~上訴 to 兩岸 dictionary head", () => {
      expect(resolveHeadByPath("/~上訴").title).toBe("上訴 - 兩岸萌典");
    });

    it("decodes percent-encoded word in path", () => {
      expect(resolveHeadByPath("/%E8%90%8C").title).toBe("萌 - 萌典");
    });

    it("strips a trailing /<digits> definition-index permalink before resolving the word (live prod regression)", () => {
      // Shipped live with a wrong title before this fix: resolveHeadByPath
      // has its own independent toSegment()/parseDictionaryRoute-shaped
      // logic (src/utils/dictionary-route.ts's idx-stripping fix does NOT
      // cover this file at all), so /萌/3 rendered <title>萌/3 - 萌典</title>
      // server-side even though the client-side title was already correct
      // post-hydration (masking the bug from e2e title assertions).
      const head = resolveHeadByPath("/萌/3");
      expect(head.title).toBe("萌 - 萌典");
      const tHead = resolveHeadByPath("/'食/1");
      expect(tHead.title).toBe("食 - 台語萌典");
    });

    it("preserves the exact permalink path (including /<digits>) in og:url, unlike the title", () => {
      // The permalink IS a distinct shareable resource (definition-index
      // deep link) even though its title collapses to the base word.
      const head = resolveHeadByPath("/萌/3");
      expect(head.ogUrl).toBe("https://www.moedict.tw/%E8%90%8C/3");
    });

    it("ignores a trailing /<digits> on non-word routes rather than rejecting the route", () => {
      expect(resolveHeadByPath("/about/2").title).toBe("關於本站 - 萌典");
      expect(resolveHeadByPath("/@木/2").title).toBe("木 部 - 萌典");
    });

    it("a word that is itself all-digits is not misparsed as word+idx (no separating slash)", () => {
      expect(resolveHeadByPath("/123").title).toBe("123 - 萌典");
    });

    it("normalizes routes without a leading slash", () => {
      const head = resolveHeadByPath("about");
      expect(head.title).toBe("關於本站 - 萌典");
      expect(head.ogUrl).toBe("https://www.moedict.tw/about");
    });

    it("falls back to brand-only title for /' with no Taiwanese word", () => {
      const head = resolveHeadByPath("/'");
      expect(head.title).toBe("台語萌典");
      expect(head.ogUrl).toBe("https://www.moedict.tw/'");
    });

    it("falls back to brand-only title for /: with no Hakka word", () => {
      const head = resolveHeadByPath("/:");
      expect(head.title).toBe("客語萌典");
      expect(head.ogUrl).toBe("https://www.moedict.tw/:");
    });

    it("falls back to brand-only title for /~ with no cross-strait word", () => {
      const head = resolveHeadByPath("/~");
      expect(head.title).toBe("兩岸萌典");
      expect(head.ogUrl).toBe("https://www.moedict.tw/~");
    });

    it("canonical URL is percent-encoded even though segment is decoded", () => {
      const head = resolveHeadByPath("/萌");
      expect(head.ogUrl).toMatch(/^https:\/\/www\.moedict\.tw\//);
      expect(head.ogUrl).toContain(encodeURI("/萌"));
    });

    it("does not double-encode when given an already percent-encoded pathname (real url.pathname shape)", () => {
      // The Worker always calls resolveHeadByPath with `url.pathname`,
      // which is percent-encoded (e.g. `/%E8%90%8C` for 萌) — unlike the
      // plain-Unicode `/萌` used above. toCanonicalUrl used to re-encode
      // this blindly, producing `/%25E8%2590%258C` (g0v/moedict.tw#131).
      const head = resolveHeadByPath("/%E8%90%8C");
      expect(head.ogUrl).toBe("https://www.moedict.tw/%E8%90%8C");
      const tPrefixed = resolveHeadByPath("/%27%E9%A3%9F"); // /'食
      expect(tPrefixed.ogUrl).toBe("https://www.moedict.tw/'%E9%A3%9F");
    });

    it("ignores invalid percent-encoding gracefully (does not throw)", () => {
      const head = resolveHeadByPath("/%E8");
      expect(head.title.endsWith("- 萌典")).toBe(true);
    });
  });

  describe("getDictionaryHead direct API", () => {
    it("produces the same head as router for a plain word", () => {
      const fromRoute = resolveHeadByPath("/萌");
      const direct = getDictionaryHead("萌", "a", "/萌");
      expect(direct).toEqual(fromRoute);
    });

    it("falls back to 萌 image when word is blank", () => {
      const head = getDictionaryHead("", "a");
      expect(head.title).toBe("萌典");
      expect(head.ogImage).toBe("https://www.moedict.tw/%E8%90%8C.png");
    });

    it("builds fallback dictionary paths for all language prefixes", () => {
      expect(getDictionaryHead("", "t").ogUrl).toBe("https://www.moedict.tw/'%E8%90%8C");
      expect(getDictionaryHead("", "h").ogUrl).toBe("https://www.moedict.tw/:%E8%90%8C");
      expect(getDictionaryHead("", "c").ogUrl).toBe("https://www.moedict.tw/~%E8%90%8C");
    });

    it("strips HTML tags from word input", () => {
      const head = getDictionaryHead("<b>萌</b>", "a");
      expect(head.title).toBe("萌 - 萌典");
    });

    it("collapses excess whitespace before building the title", () => {
      const head = getDictionaryHead("  萌\n典  ", "a");
      expect(head.title).toBe("萌 典 - 萌典");
    });
  });

  describe("escapeHeadContent", () => {
    it("escapes HTML metacharacters", () => {
      expect(escapeHeadContent('<a href="x">&\'</a>')).toBe(
        "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
      );
    });

    it("handles null/undefined safely", () => {
      expect(escapeHeadContent("")).toBe("");
      expect(escapeHeadContent(null as unknown as string)).toBe("");
    });
  });
});

describe("applyHeadToDocument / applyHeadByPath", () => {
  function resetDocument() {
    document.head.innerHTML = `
      <meta name="description" content="" />
      <meta property="og:title" content="" />
      <meta property="og:description" content="" />
      <meta property="og:url" content="" />
      <meta property="og:image" content="" />
      <meta property="og:image:type" content="" />
      <meta property="og:image:width" content="" />
      <meta property="og:image:height" content="" />
      <meta name="twitter:title" content="" />
      <meta name="twitter:description" content="" />
      <meta name="twitter:image" content="" />
      <meta name="twitter:site" content="" />
      <meta name="twitter:creator" content="" />
    `;
    document.title = "";
  }

  it("writes every meta tag when applying a dictionary head", () => {
    resetDocument();
    applyHeadByPath("/萌");
    expect(document.title).toBe("萌 - 萌典");
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(
      DEFAULT_DESCRIPTION,
    );
    expect(document.head.querySelector('meta[property="og:image"]')?.getAttribute("content")).toBe(
      "https://www.moedict.tw/%E8%90%8C.png",
    );
    expect(document.head.querySelector('meta[name="twitter:site"]')?.getAttribute("content")).toBe(
      "@moedict",
    );
  });

  it("updates existing tags in place without appending duplicates", () => {
    resetDocument();
    applyHeadByPath("/萌");
    applyHeadByPath("/about");
    const descriptions = document.head.querySelectorAll('meta[name="description"]');
    expect(descriptions.length).toBe(1);
    expect(descriptions[0].getAttribute("content")).toContain("萌典資料來源");
  });

  it("applyHeadToDocument does nothing when document is missing", () => {
    const saved = globalThis.document;
    // @ts-expect-error – deliberately deleting document for test
    delete globalThis.document;
    expect(() =>
      applyHeadToDocument({
        title: "x",
        description: "x",
        ogTitle: "x",
        ogDescription: "x",
        ogUrl: "x",
        ogImage: "x",
        ogImageType: "x",
        ogImageWidth: "x",
        ogImageHeight: "x",
        twitterImage: "x",
        twitterSite: "x",
        twitterCreator: "x",
      }),
    ).not.toThrow();
    globalThis.document = saved;
  });

  it("skips missing meta tags without throwing", () => {
    const saved = globalThis.document;
    const fakeDocument = {
      title: "",
      head: {
        querySelector: () => null,
      },
    } as unknown as Document;
    globalThis.document = fakeDocument;

    expect(() =>
      applyHeadToDocument({
        title: "x",
        description: "x",
        ogTitle: "x",
        ogDescription: "x",
        ogUrl: "x",
        ogImage: "x",
        ogImageType: "x",
        ogImageWidth: "x",
        ogImageHeight: "x",
        twitterImage: "x",
        twitterSite: "x",
        twitterCreator: "x",
      }),
    ).not.toThrow();
    expect(globalThis.document.title).toBe("x");

    globalThis.document = saved;
  });

  it("returns early when document.head is missing", () => {
    const saved = globalThis.document;
    const fakeDocument = { title: "" } as unknown as Document;
    globalThis.document = fakeDocument;

    expect(() =>
      applyHeadToDocument({
        title: "y",
        description: "y",
        ogTitle: "y",
        ogDescription: "y",
        ogUrl: "y",
        ogImage: "y",
        ogImageType: "y",
        ogImageWidth: "y",
        ogImageHeight: "y",
        twitterImage: "y",
        twitterSite: "y",
        twitterCreator: "y",
      }),
    ).not.toThrow();
    expect(globalThis.document.title).toBe("y");

    globalThis.document = saved;
  });
});
