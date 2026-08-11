import {
  classifyRoute,
  buildDictionaryPathname,
  type DictionaryLang,
} from "../utils/dictionary-route";

export type { DictionaryLang } from "../utils/dictionary-route";

export interface PageHead {
  title: string;
  description: string;
  ogTitle: string;
  ogDescription: string;
  ogUrl: string;
  ogImage: string;
  ogImageType: string;
  ogImageWidth: string;
  ogImageHeight: string;
  twitterImage: string;
  twitterSite: string;
  twitterCreator: string;
}

/* c8 ignore start */
const DEFAULT_DESCRIPTION = [
  "共收錄十六萬筆國語、兩萬筆臺語、一萬四千筆客語條目，每個字詞都可以輕按連到說明，並提供 Android 及 iOS 離線 App。",
].join("");
/* c8 ignore stop */

const ABOUT_DESCRIPTION =
  "萌典資料來源、授權與專案協作說明。包含教育部辭典資料、字體來源與平台版本資訊。";

const SITE_ORIGIN = "https://www.moedict.tw";
const DEFAULT_IMAGE = `${SITE_ORIGIN}/assets/images/icon.png`;
const DEFAULT_IMAGE_TYPE = "image/png";
const DEFAULT_IMAGE_WIDTH = "375";
const DEFAULT_IMAGE_HEIGHT = "375";
const TWITTER_SITE = "@moedict";
const TWITTER_CREATOR = "@audreyt";

function stripTags(input: string): string {
  return String(input || "").replace(/<[^>]*>/g, "");
}

function normalizeWord(input: string): string {
  return stripTags(String(input || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function safeDecode(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

function toPathname(pathname: string): string {
  const cleanPath = String(pathname || "")
    .split("?")[0]
    .replace(/\/+$/, "");
  if (!cleanPath || cleanPath === "/") return "/";
  return cleanPath.startsWith("/") ? cleanPath : `/${cleanPath}`;
}

function toCanonicalUrl(pathname: string): string {
  const clean = toPathname(pathname);
  if (clean === "/") return SITE_ORIGIN;
  // `clean` may already be percent-encoded (callers pass raw `url.pathname`
  // straight through) or may be plain (the `buildDictionaryPath` fallback
  // embeds raw Unicode). Decode first so encodeURI always applies exactly
  // once — otherwise an already-encoded path becomes double-encoded
  // (`/%E8%90%8C` → `/%25E8%2590%258C`), which is exactly what shipped
  // unnoticed while server-side head injection was dead (g0v/moedict.tw#131).
  return `${SITE_ORIGIN}${encodeURI(safeDecode(clean))}`;
}

function toWordImageUrl(word: string): string {
  const normalized = normalizeWord(word);
  if (!normalized) return DEFAULT_IMAGE;
  return `${SITE_ORIGIN}/${encodeURIComponent(normalized)}.png`;
}

function getLangBrand(lang: DictionaryLang): string {
  if (lang === "t") return "台語萌典";
  if (lang === "h") return "客語萌典";
  if (lang === "c") return "兩岸萌典";
  return "萌典";
}

function getLangDescription(lang: DictionaryLang): string {
  if (lang === "t") return "台語詞條查詢、例句與語音，來自萌典整理資料。";
  if (lang === "h") return "客語詞條查詢、拼音與語音，來自萌典整理資料。";
  if (lang === "c") return "兩岸詞條查詢與對照資訊，來自萌典整理資料。";
  return DEFAULT_DESCRIPTION;
}

function createHead(
  title: string,
  description: string,
  pathname: string,
  imageWord?: string,
): PageHead {
  const resolvedImage = toWordImageUrl(imageWord ?? "");
  return {
    title,
    description,
    ogTitle: title,
    ogDescription: description,
    ogUrl: toCanonicalUrl(pathname),
    ogImage: resolvedImage,
    ogImageType: DEFAULT_IMAGE_TYPE,
    ogImageWidth: DEFAULT_IMAGE_WIDTH,
    ogImageHeight: DEFAULT_IMAGE_HEIGHT,
    twitterImage: resolvedImage,
    twitterSite: TWITTER_SITE,
    twitterCreator: TWITTER_CREATOR,
  };
}

function buildDictionaryPath(word: string, lang: DictionaryLang): string {
  // 前綴規則統一委派給 dictionary-route 的 buildDictionaryPathname；此處只補
  // 空詞目的 '萌' fallback。回傳值會經 toCanonicalUrl 的 decode→encodeURI，
  // 所以 encodeURIComponent 過的路徑與原始 Unicode 路徑產生相同 og:url。
  return buildDictionaryPathname(lang, normalizeWord(word) || "萌");
}

export function getDictionaryHead(word: string, lang: DictionaryLang, pathname?: string): PageHead {
  const normalizedWord = normalizeWord(word);
  const brand = getLangBrand(lang);
  const title = normalizedWord ? `${normalizedWord} - ${brand}` : brand;
  const headPath = pathname ?? buildDictionaryPath(normalizedWord, lang);
  return createHead(title, getLangDescription(lang), headPath, normalizedWord || "萌");
}

function getGroupHead(category: string, lang: DictionaryLang, pathname: string): PageHead {
  const normalizedCategory = normalizeWord(category);
  const brand = getLangBrand(lang);
  const title = normalizedCategory
    ? `${normalizedCategory} - 分類索引 - ${brand}`
    : `分類索引 - ${brand}`;
  return createHead(title, getLangDescription(lang), pathname);
}

function getStarredHead(lang: DictionaryLang, pathname: string): PageHead {
  const brand = getLangBrand(lang);
  return createHead(`字詞紀錄簿 - ${brand}`, getLangDescription(lang), pathname);
}

function getRadicalHead(radical: string, lang: DictionaryLang, pathname: string): PageHead {
  const clean = normalizeWord(radical);
  const brand = getLangBrand(lang);
  const title = clean ? `${clean} 部 - ${brand}` : `部首表 - ${brand}`;
  const description =
    lang === "c"
      ? "兩岸萌典部首索引與部件檢索。"
      : lang === "t"
        ? "臺灣台語萌典部首索引與部件檢索。"
        : lang === "h"
          ? "臺灣客語萌典部首索引，依 CNS11643 全字庫總筆畫分組。"
          : "萌典部首索引與部件檢索。";
  return createHead(title, description, pathname);
}

function getDefaultHead(pathname: string): PageHead {
  return createHead("萌典", DEFAULT_DESCRIPTION, pathname);
}

export function resolveHeadByPath(pathname: string): PageHead {
  const normalizedPath = toPathname(pathname);
  const route = classifyRoute(pathname);
  switch (route.kind) {
    case "default":
      return getDefaultHead(normalizedPath);
    case "about":
      return createHead("關於本站 - 萌典", ABOUT_DESCRIPTION, normalizedPath);
    case "radical":
      return getRadicalHead(route.radical, route.lang, normalizedPath);
    case "starred":
      return getStarredHead(route.lang, normalizedPath);
    case "group":
      return getGroupHead(route.category, route.lang, normalizedPath);
    case "entry":
      return getDictionaryHead(route.text, route.lang, normalizedPath);
    case "invalid-encoding":
      // classifyRoute could not decode the percent-encoding — reproduce the
      // legacy toSegment/safeDecode behavior: use the raw undecoded string as
      // a bare (lang a) dictionary head so the page still renders something
      // sensible rather than 500ing on malformed input.
      return getDictionaryHead(route.raw, "a", normalizedPath);
  }
}

function setMetaByName(name: string, content: string): void {
  const doc = (
    globalThis as {
      document?: {
        head?: {
          querySelector: (
            selector: string,
          ) => { setAttribute: (k: string, v: string) => void } | null;
        };
      };
    }
  ).document;
  if (!doc?.head) return;
  const selector = `meta[name="${name}"]`;
  const el = doc.head.querySelector(selector);
  if (el) el.setAttribute("content", content);
}

function setMetaByProperty(property: string, content: string): void {
  const doc = (
    globalThis as {
      document?: {
        head?: {
          querySelector: (
            selector: string,
          ) => { setAttribute: (k: string, v: string) => void } | null;
        };
      };
    }
  ).document;
  if (!doc?.head) return;
  const selector = `meta[property="${property}"]`;
  const el = doc.head.querySelector(selector);
  if (el) el.setAttribute("content", content);
}

export function applyHeadToDocument(head: PageHead): void {
  const doc = (globalThis as { document?: { title: string } }).document;
  if (!doc) return;
  doc.title = head.title;
  setMetaByName("description", head.description);
  setMetaByProperty("og:title", head.ogTitle);
  setMetaByProperty("og:description", head.ogDescription);
  setMetaByProperty("og:url", head.ogUrl);
  setMetaByProperty("og:image", head.ogImage);
  setMetaByProperty("og:image:type", head.ogImageType);
  setMetaByProperty("og:image:width", head.ogImageWidth);
  setMetaByProperty("og:image:height", head.ogImageHeight);
  setMetaByName("twitter:title", head.ogTitle);
  setMetaByName("twitter:description", head.ogDescription);
  setMetaByName("twitter:image", head.twitterImage);
  setMetaByName("twitter:site", head.twitterSite);
  setMetaByName("twitter:creator", head.twitterCreator);
}

export function applyHeadByPath(pathname: string): void {
  applyHeadToDocument(resolveHeadByPath(pathname));
}

export function escapeHeadContent(content: string): string {
  return String(content || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
