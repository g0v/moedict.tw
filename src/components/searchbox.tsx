/**
 * 左側欄搜尋框組件
 * 復刻原專案 moedict-webkit 的 query-box 功能
 * 使用 React Router 進行路由
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { prefetchDictionaryEntry } from "../utils/dictionary-cache";
import { removeBopomofo } from "../utils/bopomofo-pinyin-utils";
import { collectLegacyMatchedTerms, hasLegacyPatternOperators } from "../utils/legacy-search-utils";
import { getHanYuPinyinLookupBase } from "../utils/hanyu-pinyin-lookup";

type Lang = "a" | "t" | "h" | "c";

interface SearchBoxProps {
  currentLang?: Lang;
}

interface SuggestionItem {
  label: string;
  value: string;
  lang: Lang;
}

const PREFETCH_RESULT_LIMIT = 3;
const PREFETCH_MIN_TERM_LENGTH = 2;
const PREFETCH_DELAY_MS = 120;
const MOBILE_BREAKPOINT_QUERY = "(max-width: 767px)";
const MOBILE_TOGGLE_BLUR_GUARD_MS = 350;
const MOBILE_SEARCH_HISTORY_LIMIT = 50;
const MOBILE_SEARCH_HAS_QUERY_CLASS = "document-mobile-search-has-query";
const INDEX_CACHE = new Map<Lang, string[]>();
const INDEX_PROMISE_CACHE = new Map<Lang, Promise<string[]>>();
const TAIWANESE_PINYIN_CACHE = new Map<string, string[]>();
const TAIWANESE_PINYIN_PROMISE_CACHE = new Map<string, Promise<string[]>>();
const TAIWANESE_PINYIN_CACHE_MAX_ENTRIES = 400;
const TAIWANESE_PINYIN_TYPES = new Set(["TL", "DT", "POJ"]);
const TAIWANESE_ROMAN_INPUT_RE = /^(?=.*[A-Za-z])[A-Za-z0-9\s\-']+$/;
const HAKKA_PINYIN_CACHE = new Map<string, string[]>();
const HAKKA_PINYIN_PROMISE_CACHE = new Map<string, Promise<string[]>>();
const HAKKA_PINYIN_CACHE_MAX_ENTRIES = 400;
const HAKKA_PINYIN_TYPES = new Set(["TH", "PFS"]);
const HAKKA_ROMAN_INPUT_RE = /^(?=.*\p{Script=Latin})[\p{Script=Latin}\p{Mark}0-9\s\-']+$/u;
const INDEX_SET_CACHE = new Map<Lang, Set<string>>();
const INDEX_FALLBACK_ORDER: Record<Lang, Lang[]> = {
  a: ["a"],
  t: ["t"],
  h: ["h"],
  c: ["c"],
};
const HANYU_ROMANIZATION_QUERY_RE = /^[\p{Script=Latin}\d' -]+$/u;

/**
 * 從字詞提取語言前綴和清理後的字詞
 */
function parseSearchTerm(term: string): { lang: Lang; cleanTerm: string } {
  const trimmed = term.trim();
  if (trimmed.startsWith("'") || trimmed.startsWith("!")) {
    return { lang: "t", cleanTerm: trimmed.slice(1) };
  }
  if (trimmed.startsWith(":")) {
    return { lang: "h", cleanTerm: trimmed.slice(1) };
  }
  if (trimmed.startsWith("~")) {
    return { lang: "c", cleanTerm: trimmed.slice(1) };
  }
  return { lang: "a", cleanTerm: trimmed };
}

/**
 * 格式化字詞為完整路由路徑（包含語言前綴）
 */
function formatSearchTerm(term: string, lang: Lang): string {
  if (!term || !term.trim()) {
    return "/";
  }
  const prefix = lang === "a" ? "" : lang === "t" ? "/'" : lang === "h" ? "/:" : "/~";
  return `${prefix}${term.trim()}`;
}

/**
 * 從當前路徑推斷語言
 */
function inferLangFromPath(pathname: string): Lang {
  if (pathname.startsWith("/'")) return "t";
  if (pathname.startsWith("/:")) return "h";
  if (pathname.startsWith("/~")) return "c";
  return "a";
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readTaiwanesePinyinType(): string {
  if (typeof window === "undefined") {
    return "TL";
  }

  try {
    const raw = window.localStorage.getItem("pinyin_t") || "TL";
    return TAIWANESE_PINYIN_TYPES.has(raw) ? raw : "TL";
  } catch {
    return "TL";
  }
}

function readHakkaPinyinType(): string {
  if (typeof window === "undefined") {
    return "TH";
  }

  try {
    const raw = window.localStorage.getItem("pinyin_h") || "TH";
    return HAKKA_PINYIN_TYPES.has(raw) ? raw : "TH";
  } catch {
    return "TH";
  }
}

function isTaiwaneseRomanizedInput(input: string): boolean {
  return TAIWANESE_ROMAN_INPUT_RE.test(input);
}

function isHakkaRomanizedInput(input: string): boolean {
  return HAKKA_ROMAN_INPUT_RE.test(input);
}

function normalizeTaiwaneseLookupTerm(input: string): string {
  return String(input ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Mark}/gu, "")
    .replace(/ⁿ/g, "nn")
    .replace(/ɑ/g, "a")
    .replace(/[^a-z]/g, "");
}

function touchTaiwanesePinyinCache(key: string, list: string[]): void {
  if (TAIWANESE_PINYIN_CACHE.has(key)) {
    TAIWANESE_PINYIN_CACHE.delete(key);
  }
  TAIWANESE_PINYIN_CACHE.set(key, list);

  if (TAIWANESE_PINYIN_CACHE.size <= TAIWANESE_PINYIN_CACHE_MAX_ENTRIES) {
    return;
  }

  const oldestKey = TAIWANESE_PINYIN_CACHE.keys().next().value;
  if (oldestKey) {
    TAIWANESE_PINYIN_CACHE.delete(oldestKey);
  }
}

function normalizeHakkaLookupTerm(input: string): string {
  return String(input ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Mark}/gu, "")
    .replace(/ⁿ/g, "nn")
    .replace(/ɑ/g, "a")
    .replace(/[^a-z]/g, "");
}

function touchHakkaPinyinCache(key: string, list: string[]): void {
  if (HAKKA_PINYIN_CACHE.has(key)) {
    HAKKA_PINYIN_CACHE.delete(key);
  }
  HAKKA_PINYIN_CACHE.set(key, list);

  if (HAKKA_PINYIN_CACHE.size <= HAKKA_PINYIN_CACHE_MAX_ENTRIES) {
    return;
  }

  const oldestKey = HAKKA_PINYIN_CACHE.keys().next().value;
  if (oldestKey) {
    HAKKA_PINYIN_CACHE.delete(oldestKey);
  }
}

/**
 * 從路徑提取搜尋詞
 */
function extractTermFromPath(pathname: string): string {
  if (pathname === "/" || pathname === "") return "";

  const rawPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (!rawPath) return "";

  const decodedPath = safeDecode(rawPath);
  if (decodedPath.includes("/")) return "";

  if (decodedPath.startsWith("'")) {
    const term = decodedPath.slice(1);
    return term.startsWith("=") ? "" : term;
  }

  if (decodedPath.startsWith(":")) {
    const term = decodedPath.slice(1);
    return term.startsWith("=") ? "" : term;
  }

  if (decodedPath.startsWith("~")) {
    const term = decodedPath.slice(1);
    if (!term || term.startsWith("@") || term.startsWith("=")) return "";
    return term;
  }

  if (decodedPath.startsWith("@") || decodedPath.startsWith("=")) {
    return "";
  }

  return decodedPath;
}

function resolveSearchInput(
  input: string,
  fallbackLang: Lang,
): { lang: Lang; term: string } | null {
  const trimmed = removeBopomofo(input.trim());
  if (!trimmed) return null;

  const { lang: parsedLang, cleanTerm } = parseSearchTerm(trimmed);
  const hasLangPrefix = cleanTerm !== trimmed;
  const term = cleanTerm.trim();
  if (!term) return null;

  return {
    lang: hasLangPrefix ? parsedLang : fallbackLang,
    term,
  };
}

async function fetchIndexForLang(lang: Lang): Promise<string[]> {
  const cached = INDEX_CACHE.get(lang);
  if (cached) {
    if (!INDEX_SET_CACHE.has(lang)) {
      INDEX_SET_CACHE.set(lang, new Set(cached));
    }
    return cached;
  }

  const pending = INDEX_PROMISE_CACHE.get(lang);
  if (pending) {
    return pending;
  }

  const request = fetch(`/api/index/${lang}.json`, {
    headers: { Accept: "application/json" },
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`索引讀取失敗: ${response.status}`);
      }
      const data = (await response.json()) as unknown;
      if (!Array.isArray(data)) {
        return [];
      }
      return data.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      );
    })
    .catch(() => [])
    .then((list) => {
      INDEX_CACHE.set(lang, list);
      INDEX_SET_CACHE.set(lang, new Set(list));
      return list;
    })
    .finally(() => {
      INDEX_PROMISE_CACHE.delete(lang);
    });

  INDEX_PROMISE_CACHE.set(lang, request);
  return request;
}

async function loadIndexByLang(lang: Lang): Promise<string[]> {
  const fallbackOrder = INDEX_FALLBACK_ORDER[lang] ?? [lang];
  for (const targetLang of fallbackOrder) {
    const list = await fetchIndexForLang(targetLang);
    if (list.length > 0 || targetLang === fallbackOrder[fallbackOrder.length - 1]) {
      return list;
    }
  }
  return [];
}

async function fetchTaiwanesePinyinSuggestions(term: string, type: string): Promise<string[]> {
  const normalizedTerm = normalizeTaiwaneseLookupTerm(term);
  const cacheKey = `${type}:${normalizedTerm}`;
  const cached = TAIWANESE_PINYIN_CACHE.get(cacheKey);
  if (cached) {
    touchTaiwanesePinyinCache(cacheKey, cached);
    return cached;
  }

  const pending = TAIWANESE_PINYIN_PROMISE_CACHE.get(cacheKey);
  if (pending) {
    return pending;
  }

  const request = fetch(
    `/api/lookup/pinyin/t/${encodeURIComponent(type)}/${encodeURIComponent(term)}.json`,
    {
      headers: { Accept: "application/json" },
    },
  )
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`羅馬字索引讀取失敗: ${response.status}`);
      }

      const data = (await response.json()) as unknown;
      if (!Array.isArray(data)) {
        return [];
      }

      return data.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      );
    })
    .then((list) => {
      touchTaiwanesePinyinCache(cacheKey, list);
      return list;
    })
    .finally(() => {
      TAIWANESE_PINYIN_PROMISE_CACHE.delete(cacheKey);
    });

  TAIWANESE_PINYIN_PROMISE_CACHE.set(cacheKey, request);
  return request;
}

async function fetchHakkaPinyinSuggestions(term: string, type: string): Promise<string[]> {
  const normalizedTerm = normalizeHakkaLookupTerm(term);
  const cacheKey = `${type}:${normalizedTerm}`;
  const cached = HAKKA_PINYIN_CACHE.get(cacheKey);
  if (cached) {
    touchHakkaPinyinCache(cacheKey, cached);
    return cached;
  }

  const pending = HAKKA_PINYIN_PROMISE_CACHE.get(cacheKey);
  if (pending) {
    return pending;
  }

  const request = fetch(
    `/api/lookup/pinyin/h/${encodeURIComponent(type)}/${encodeURIComponent(term)}.json`,
    {
      headers: { Accept: "application/json" },
    },
  )
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`客語拼音索引讀取失敗: ${response.status}`);
      }

      const data = (await response.json()) as unknown;
      if (!Array.isArray(data)) {
        return [];
      }

      return data.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      );
    })
    .then((list) => {
      touchHakkaPinyinCache(cacheKey, list);
      return list;
    })
    .finally(() => {
      HAKKA_PINYIN_PROMISE_CACHE.delete(cacheKey);
    });

  HAKKA_PINYIN_PROMISE_CACHE.set(cacheKey, request);
  return request;
}

function getIndexSetForLang(lang: Lang): Set<string> {
  const cached = INDEX_SET_CACHE.get(lang);
  if (cached) {
    return cached;
  }

  const list = INDEX_CACHE.get(lang);
  if (!list) {
    return new Set();
  }

  const next = new Set(list);
  INDEX_SET_CACHE.set(lang, next);
  return next;
}

function isHanYuRomanizationQuery(keyword: string, lang: Lang): boolean {
  if (lang !== "a" && lang !== "c") {
    return false;
  }

  const normalizedKeyword = keyword.trim();
  if (!normalizedKeyword || hasLegacyPatternOperators(normalizedKeyword)) {
    return false;
  }

  return HANYU_ROMANIZATION_QUERY_RE.test(normalizedKeyword);
}

function parseRomanizationLookupResponse(payload: string): string[] {
  const normalizedPayload = payload.trim();
  if (!normalizedPayload || normalizedPayload.startsWith("<")) {
    return [];
  }

  return Array.from(
    new Set(
      normalizedPayload
        .split("|")
        .map((term) => term.trim())
        .filter(Boolean),
    ),
  );
}

function normalizeHanYuRomanizationToken(token: string): string {
  return token
    .normalize("NFD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase();
}

function tokenizeHanYuRomanization(keyword: string): string[] {
  const normalizedKeyword = keyword.trim();
  if (!normalizedKeyword) {
    return [];
  }

  const tokens = normalizedKeyword
    .split(/[\s']+/)
    .map((token) => normalizeHanYuRomanizationToken(token))
    .filter(Boolean);

  if (tokens.length === 0 || tokens.some((token) => !/^[a-z0-9-]+$/.test(token))) {
    return [];
  }

  return tokens;
}

function intersectRomanizationResults(resultGroups: string[][]): string[] {
  if (resultGroups.length === 0) {
    return [];
  }

  const [firstGroup, ...restGroups] = resultGroups;
  const remainingSets = restGroups.map((group) => new Set(group));
  return firstGroup.filter((term) => remainingSets.every((group) => group.has(term)));
}

function buildExactCharacterSets(resultGroups: string[][]): Set<string>[] {
  return resultGroups.map(
    (group) => new Set(group.filter((term) => Array.from(term).length === 1)),
  );
}

function filterPositionalRomanizationTerms(
  terms: string[],
  exactCharacterSets: Set<string>[],
): string[] {
  if (exactCharacterSets.length === 0) {
    return terms;
  }

  return terms.filter((term) => {
    const chars = Array.from(term);
    if (chars.length < exactCharacterSets.length) {
      return false;
    }

    return exactCharacterSets.every((charSet, index) => {
      if (charSet.size === 0) {
        return true;
      }
      return charSet.has(chars[index]);
    });
  });
}

function shouldKeepHanYuRomanizationTerm(term: string, lang: Lang, indexSet: Set<string>): boolean {
  if (lang === "c") {
    return true;
  }

  if (indexSet.has(term)) {
    return true;
  }

  return false;
}

async function fetchHanYuPinyinLookupTerms(keyword: string, lang: Lang): Promise<string[]> {
  if (lang !== "a" && lang !== "c") {
    return [];
  }

  const lookupBase = getHanYuPinyinLookupBase(lang);

  const tokens = tokenizeHanYuRomanization(keyword);
  if (tokens.length === 0) {
    return [];
  }

  try {
    const responses = await Promise.all(
      tokens.map(async (token) => {
        const response = await fetch(`${lookupBase}/${encodeURIComponent(token)}.json`, {
          headers: { Accept: "application/json" },
        });
        if (!response.ok) {
          return [];
        }

        const payload = (await response.json()) as unknown;
        if (!Array.isArray(payload)) {
          return [];
        }

        return payload.filter(
          (term): term is string => typeof term === "string" && term.trim().length > 0,
        );
      }),
    );

    if (responses.some((group) => group.length === 0)) {
      return [];
    }

    const intersected = intersectRomanizationResults(responses);
    if (lang !== "c") {
      return intersected;
    }

    return filterPositionalRomanizationTerms(intersected, buildExactCharacterSets(responses));
  } catch {
    return [];
  }
}

async function fetchHanYuRomanizationTerms(keyword: string, lang: Lang): Promise<string[]> {
  const normalizedKeyword = keyword.trim();
  if (!normalizedKeyword) {
    return [];
  }

  const pinyinLookupTerms = await fetchHanYuPinyinLookupTerms(normalizedKeyword, lang);
  if (pinyinLookupTerms.length > 0) {
    return pinyinLookupTerms;
  }

  try {
    const response = await fetch(`/lookup/trs/${encodeURIComponent(normalizedKeyword)}`, {
      headers: { Accept: "text/plain, application/json;q=0.9, */*;q=0.8" },
    });
    if (!response.ok) {
      return [];
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as { terms?: unknown };
      if (!Array.isArray(payload.terms)) {
        return [];
      }
      return payload.terms.filter(
        (term): term is string => typeof term === "string" && term.trim().length > 0,
      );
    }

    return parseRomanizationLookupResponse(await response.text());
  } catch {
    return [];
  }
}

/**
 * 搜尋框組件
 */
export function SearchBox({ currentLang }: SearchBoxProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const requestIdRef = useRef(0);
  const blurTimerRef = useRef<number | null>(null);
  const mobileToggleGuardTimerRef = useRef<number | null>(null);
  const mobileToggleInteractionRef = useRef(false);
  const isComposingRef = useRef(false);
  const compositionStartValueRef = useRef("");
  const preserveSuggestionsOnNextNavigationRef = useRef(false);
  const searchHistoryRef = useRef<string[]>([]);
  const [searchValue, setSearchValue] = useState("");
  const [suggestionQueryOverride, setSuggestionQueryOverride] =
    useState<ReturnType<typeof resolveSearchInput>>(null);
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
  });
  const [showMobileResults, setShowMobileResults] = useState(false);
  const [isContainerActive, setIsContainerActive] = useState(false);
  const resolvedLang = currentLang || inferLangFromPath(location.pathname);

  // 從路由更新輸入框值
  useEffect(() => {
    const term = extractTermFromPath(location.pathname);
    setSearchValue(term);
    if (!preserveSuggestionsOnNextNavigationRef.current) {
      setSuggestionQueryOverride(null);
    }
    preserveSuggestionsOnNextNavigationRef.current = false;
  }, [location.pathname]);

  // 監聽 viewport，切換桌機/手機搜尋結果行為
  useEffect(() => {
    if (typeof window === "undefined") return;

    const mediaQuery = window.matchMedia(MOBILE_BREAKPOINT_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsMobileViewport(event.matches);
    };

    setIsMobileViewport(mediaQuery.matches);

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => {
        mediaQuery.removeEventListener("change", handleChange);
      };
    }

    mediaQuery.addListener(handleChange);
    return () => {
      mediaQuery.removeListener(handleChange);
    };
  }, []);

  const routeSearch = useMemo(
    () => resolveSearchInput(searchValue, resolvedLang),
    [searchValue, resolvedLang],
  );
  const activeSearch = suggestionQueryOverride ?? routeSearch;
  const activeSearchLang = activeSearch?.lang ?? resolvedLang;
  const activeSearchTerm = activeSearch?.term ?? "";
  const hasActiveSearch = activeSearchTerm.length > 0;
  const activeTaiwanesePinyinType = useMemo(() => readTaiwanesePinyinType(), []);
  const activeHakkaPinyinType = useMemo(() => readHakkaPinyinType(), []);
  const isTaiwaneseRomanSearch = useMemo(() => {
    return (
      activeSearchLang === "t" && hasActiveSearch && isTaiwaneseRomanizedInput(activeSearchTerm)
    );
  }, [activeSearchLang, activeSearchTerm, hasActiveSearch]);
  const isHakkaRomanSearch = useMemo(() => {
    return activeSearchLang === "h" && hasActiveSearch && isHakkaRomanizedInput(activeSearchTerm);
  }, [activeSearchLang, activeSearchTerm, hasActiveSearch]);
  const usesPatternSearch = hasLegacyPatternOperators(activeSearchTerm);
  const usesHanYuRomanizationLookup = isHanYuRomanizationQuery(activeSearchTerm, activeSearchLang);

  // Search 字詞變更時，手機結果面板預設收合
  useEffect(() => {
    setShowMobileResults(false);
  }, [activeSearchLang, activeSearchTerm, isMobileViewport]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const hasQuery = isMobileViewport && searchValue.trim().length > 0;
    document.documentElement.classList.toggle(MOBILE_SEARCH_HAS_QUERY_CLASS, hasQuery);

    return () => {
      document.documentElement.classList.remove(MOBILE_SEARCH_HAS_QUERY_CLASS);
    };
  }, [isMobileViewport, searchValue]);

  // 清理 blur timer
  useEffect(() => {
    return () => {
      if (blurTimerRef.current !== null) {
        window.clearTimeout(blurTimerRef.current);
      }
      if (mobileToggleGuardTimerRef.current !== null) {
        window.clearTimeout(mobileToggleGuardTimerRef.current);
      }
    };
  }, []);

  // 手機版結果面板由按鈕展開後，改用外點事件收合，避免依賴 iOS WebView 不穩定的 blur 順序。
  useEffect(() => {
    if (!isMobileViewport || !showMobileResults) return;
    if (typeof document === "undefined") return;

    const handleOutsidePress = (event: PointerEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (containerRef.current?.contains(target)) return;

      setShowMobileResults(false);
      setIsContainerActive(false);
      setSuggestionQueryOverride(null);
      preserveSuggestionsOnNextNavigationRef.current = false;
    };

    document.addEventListener("pointerdown", handleOutsidePress, true);
    document.addEventListener("touchstart", handleOutsidePress, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePress, true);
      document.removeEventListener("touchstart", handleOutsidePress, true);
    };
  }, [isMobileViewport, showMobileResults]);

  // 從 index.json 載入搜尋結果
  useEffect(() => {
    if (!hasActiveSearch) {
      setLoadingSuggestions(false);
      setSuggestions([]);
      return;
    }

    const requestId = ++requestIdRef.current;
    setLoadingSuggestions(true);

    const timer = window.setTimeout(() => {
      const loadSuggestions = async () => {
        const indexTermsPromise = loadIndexByLang(activeSearchLang);
        let matchedTerms: string[] = [];

        if (isTaiwaneseRomanSearch) {
          matchedTerms = await fetchTaiwanesePinyinSuggestions(
            activeSearchTerm,
            activeTaiwanesePinyinType,
          );
        } else if (isHakkaRomanSearch) {
          matchedTerms = await fetchHakkaPinyinSuggestions(activeSearchTerm, activeHakkaPinyinType);
        } else if (usesHanYuRomanizationLookup) {
          const [romanizationTerms, indexTerms] = await Promise.all([
            fetchHanYuRomanizationTerms(activeSearchTerm, activeSearchLang),
            indexTermsPromise,
          ]);
          const indexSet = getIndexSetForLang(activeSearchLang);
          matchedTerms = romanizationTerms.filter((term) =>
            shouldKeepHanYuRomanizationTerm(term, activeSearchLang, indexSet),
          );
          if (matchedTerms.length === 0) {
            matchedTerms = collectLegacyMatchedTerms(indexTerms, activeSearchTerm);
          }
        } else {
          const indexTerms = await indexTermsPromise;
          matchedTerms = collectLegacyMatchedTerms(indexTerms, activeSearchTerm);
        }

        if (requestId !== requestIdRef.current) return;
        setSuggestions(
          matchedTerms.map((term) => ({
            label: term,
            value: term,
            lang: activeSearchLang,
          })),
        );
      };

      loadSuggestions()
        .then(() => {
          if (requestId !== requestIdRef.current) return;
        })
        .catch(() => {
          if (requestId !== requestIdRef.current) return;
          setSuggestions([]);
        })
        .finally(() => {
          if (requestId === requestIdRef.current) {
            setLoadingSuggestions(false);
          }
        });
    }, 100);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    activeHakkaPinyinType,
    activeSearchLang,
    activeSearchTerm,
    activeTaiwanesePinyinType,
    hasActiveSearch,
    isHakkaRomanSearch,
    isTaiwaneseRomanSearch,
    usesHanYuRomanizationLookup,
  ]);

  // 預先抓取前幾筆候選詞條，減少點選後等待時間
  useEffect(() => {
    if (!hasActiveSearch) return;
    if (loadingSuggestions) return;
    if (activeSearchTerm.length < PREFETCH_MIN_TERM_LENGTH) return;
    if (suggestions.length === 0) return;

    const timer = window.setTimeout(() => {
      suggestions.slice(0, PREFETCH_RESULT_LIMIT).forEach((suggestion) => {
        prefetchDictionaryEntry(suggestion.value, suggestion.lang);
      });
    }, PREFETCH_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeSearchTerm, hasActiveSearch, loadingSuggestions, suggestions]);

  const syncRouteWithInput = useCallback(
    (rawValue: string, replace: boolean) => {
      const resolved = resolveSearchInput(rawValue, resolvedLang);
      if (!resolved) return;
      if (hasLegacyPatternOperators(resolved.term)) return;
      if (resolved.lang === "t" && isTaiwaneseRomanizedInput(resolved.term)) return;
      if (resolved.lang === "h" && isHakkaRomanizedInput(resolved.term)) return;
      if (isHanYuRomanizationQuery(resolved.term, resolved.lang)) return;

      const nextPath = formatSearchTerm(resolved.term, resolved.lang);
      if (nextPath === location.pathname) return;
      navigate(nextPath, { replace });
    },
    [location.pathname, navigate, resolvedLang],
  );

  const rememberSearchValue = useCallback((value: string) => {
    const history = searchHistoryRef.current;
    if (history[history.length - 1] === value) return;

    history.push(value);
    if (history.length > MOBILE_SEARCH_HISTORY_LIMIT) {
      history.shift();
    }
  }, []);

  // 處理輸入變化：同步更新路由
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.currentTarget.value;
      const nativeEvent = e.nativeEvent as InputEvent;
      const isComposingInput =
        isComposingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.inputType === "insertCompositionText";

      if (isComposingInput) {
        setSearchValue(value);
        return;
      }

      if (value !== searchValue) {
        rememberSearchValue(searchValue);
      }
      preserveSuggestionsOnNextNavigationRef.current = false;
      setSuggestionQueryOverride(null);
      setSearchValue(value);
      syncRouteWithInput(value, true);
    },
    [rememberSearchValue, searchValue, syncRouteWithInput],
  );

  // 處理輸入法開始
  const handleInputCompositionStart = useCallback(() => {
    isComposingRef.current = true;
    compositionStartValueRef.current = searchValue;
  }, [searchValue]);

  // 處理輸入法結束
  const handleInputCompositionEnd = useCallback(
    (e: React.CompositionEvent<HTMLInputElement>) => {
      isComposingRef.current = false;
      const value = e.currentTarget.value;
      const previousValue = compositionStartValueRef.current;
      compositionStartValueRef.current = value;

      if (value !== previousValue) {
        rememberSearchValue(previousValue);
      }

      preserveSuggestionsOnNextNavigationRef.current = false;
      setSuggestionQueryOverride(null);
      setSearchValue(value);
      syncRouteWithInput(value, true);
    },
    [rememberSearchValue, syncRouteWithInput],
  );

  // container 取得 focus（任何子元素 focus 都算）
  const handleContainerFocus = useCallback(() => {
    if (blurTimerRef.current !== null) {
      window.clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
    setIsContainerActive(true);
  }, []);

  // container 失去 focus（延遲確認 focus 沒有移到 container 內其他元素）
  const handleContainerBlur = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    if (mobileToggleInteractionRef.current) {
      if (blurTimerRef.current !== null) {
        window.clearTimeout(blurTimerRef.current);
        blurTimerRef.current = null;
      }
      setIsContainerActive(true);
      return;
    }

    if (e.currentTarget.contains(e.relatedTarget as Node)) {
      return;
    }
    blurTimerRef.current = window.setTimeout(() => {
      setIsContainerActive(false);
      setSuggestionQueryOverride(null);
      preserveSuggestionsOnNextNavigationRef.current = false;
      blurTimerRef.current = null;
    }, 200);
  }, []);

  // 處理選擇建議
  const handleSelectSuggestion = useCallback(
    (suggestion: SuggestionItem) => {
      if (blurTimerRef.current !== null) {
        window.clearTimeout(blurTimerRef.current);
        blurTimerRef.current = null;
      }

      if (!isMobileViewport && activeSearch) {
        preserveSuggestionsOnNextNavigationRef.current = true;
        setSuggestionQueryOverride(activeSearch);
      } else {
        preserveSuggestionsOnNextNavigationRef.current = false;
        setSuggestionQueryOverride(null);
      }

      if (suggestion.value !== searchValue) {
        rememberSearchValue(searchValue);
      }

      setSearchValue(suggestion.value);
      if (isMobileViewport) {
        setShowMobileResults(false);
        setIsContainerActive(false);
      } else {
        setIsContainerActive(true);
        window.requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      }

      const path = formatSearchTerm(suggestion.value, suggestion.lang);
      navigate(path);
    },
    [activeSearch, isMobileViewport, navigate, rememberSearchValue, searchValue],
  );

  const submitSearch = useCallback(() => {
    const resolved = resolveSearchInput(searchValue, resolvedLang);
    if (!resolved) return;

    preserveSuggestionsOnNextNavigationRef.current = false;
    setSuggestionQueryOverride(null);
    setIsContainerActive(true);
    if (isMobileViewport) {
      setShowMobileResults(true);
    }

    if (hasLegacyPatternOperators(resolved.term)) return;
    if (resolved.lang === "t" && isTaiwaneseRomanizedInput(resolved.term)) return;
    if (resolved.lang === "h" && isHakkaRomanizedInput(resolved.term)) return;
    if (isHanYuRomanizationQuery(resolved.term, resolved.lang)) return;

    const path = formatSearchTerm(resolved.term, resolved.lang);
    if (path !== location.pathname) {
      navigate(path);
    }
  }, [isMobileViewport, location.pathname, navigate, resolvedLang, searchValue]);

  // 處理提交
  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      submitSearch();
    },
    [submitSearch],
  );

  const focusSuggestionByIndex = useCallback((index: number) => {
    const target = suggestionRefs.current[index];
    if (target) {
      target.focus();
    }
  }, []);

  const handleSuggestionKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLAnchorElement>, index: number, suggestion: SuggestionItem) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (suggestions.length === 0) return;
        const nextIndex = index >= suggestions.length - 1 ? 0 : index + 1;
        focusSuggestionByIndex(nextIndex);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (suggestions.length === 0) return;
        const nextIndex = index <= 0 ? suggestions.length - 1 : index - 1;
        focusSuggestionByIndex(nextIndex);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setShowMobileResults(false);
        setIsContainerActive(false);
        setSuggestionQueryOverride(null);
        preserveSuggestionsOnNextNavigationRef.current = false;
        inputRef.current?.blur();
        return;
      }

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleSelectSuggestion(suggestion);
      }
    },
    [focusSuggestionByIndex, handleSelectSuggestion, suggestions.length],
  );

  const armMobileToggleBlurGuard = useCallback(() => {
    mobileToggleInteractionRef.current = true;

    if (mobileToggleGuardTimerRef.current !== null) {
      window.clearTimeout(mobileToggleGuardTimerRef.current);
    }
    mobileToggleGuardTimerRef.current = window.setTimeout(() => {
      mobileToggleInteractionRef.current = false;
      mobileToggleGuardTimerRef.current = null;
    }, MOBILE_TOGGLE_BLUR_GUARD_MS);

    if (blurTimerRef.current !== null) {
      window.clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
    setIsContainerActive(true);
  }, []);

  const handleMobileTogglePointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      armMobileToggleBlurGuard();
    },
    [armMobileToggleBlurGuard],
  );

  const handleMobileToggleTouchStart = useCallback(() => {
    armMobileToggleBlurGuard();
  }, [armMobileToggleBlurGuard]);

  const handleMobileBack = useCallback(() => {
    setShowMobileResults(false);
    setIsContainerActive(false);
    setSuggestionQueryOverride(null);
    preserveSuggestionsOnNextNavigationRef.current = false;

    let previousValue = searchHistoryRef.current.pop();
    while (previousValue === searchValue) {
      previousValue = searchHistoryRef.current.pop();
    }

    if (previousValue !== undefined) {
      setSearchValue(previousValue);
      if (previousValue.trim().length > 0) {
        syncRouteWithInput(previousValue, true);
      }
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      return;
    }

    inputRef.current?.focus();
  }, [searchValue, syncRouteWithInput]);

  const handleMobileClear = useCallback(() => {
    if (searchValue.length > 0) {
      rememberSearchValue(searchValue);
    }
    preserveSuggestionsOnNextNavigationRef.current = false;
    setSuggestionQueryOverride(null);
    setSearchValue("");
    setShowMobileResults(false);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [rememberSearchValue, searchValue]);

  const handleMobileControlPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
    },
    [],
  );

  // 輸入框鍵盤事件
  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const nativeEvent = e.nativeEvent as KeyboardEvent;
      const isImeNavigating =
        isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;
      if (isImeNavigating) return;

      if (e.key === "ArrowDown" && !isMobileViewport) {
        if (!loadingSuggestions && suggestions.length > 0) {
          e.preventDefault();
          focusSuggestionByIndex(0);
        }
        return;
      }

      if (e.key === "ArrowUp" && !isMobileViewport) {
        if (!loadingSuggestions && suggestions.length > 0) {
          e.preventDefault();
          focusSuggestionByIndex(suggestions.length - 1);
        }
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        submitSearch();
        return;
      } else if (e.key === "Escape") {
        preserveSuggestionsOnNextNavigationRef.current = false;
        setSuggestionQueryOverride(null);
        setShowMobileResults(false);
        setIsContainerActive(false);
        inputRef.current?.blur();
      }
    },
    [focusSuggestionByIndex, isMobileViewport, loadingSuggestions, submitSearch, suggestions],
  );

  const shouldShowMobileToggle = isMobileViewport && hasActiveSearch;
  const shouldRenderResultList =
    hasActiveSearch && (!isMobileViewport ? isContainerActive : showMobileResults);
  const shouldShowSearchClear = searchValue.length > 0;

  return (
    <div
      ref={containerRef}
      className="search-container"
      style={{ position: "relative" }}
      onFocus={handleContainerFocus}
      onBlur={handleContainerBlur}
    >
      <div className="mobile-search-bar">
        <button
          type="button"
          className="mobile-search-back"
          aria-label="回到上一個搜尋"
          onPointerDown={handleMobileControlPointerDown}
          onClick={handleMobileBack}
        >
          <span className="mobile-search-back-chevron" aria-hidden="true" />
        </button>
        <form onSubmit={handleSubmit} className="search-form">
          <div className="search-input-wrap">
            <input
              ref={inputRef}
              id="query"
              type="search"
              className="query"
              autoComplete="off"
              placeholder="請輸入欲查詢的字詞"
              value={searchValue}
              onChange={handleInputChange}
              onCompositionStart={handleInputCompositionStart}
              onCompositionEnd={handleInputCompositionEnd}
              onKeyDown={handleInputKeyDown}
            />
            {shouldShowSearchClear && (
              <button
                type="button"
                className="mobile-search-clear"
                aria-label="清除搜尋字詞"
                onPointerDown={handleMobileControlPointerDown}
                onClick={handleMobileClear}
              >
                <span aria-hidden="true">×</span>
              </button>
            )}
          </div>
        </form>
      </div>
      {shouldShowMobileToggle && (
        <button
          type="button"
          className="mobile-search-toggle"
          aria-expanded={showMobileResults}
          onPointerDown={handleMobileTogglePointerDown}
          onTouchStart={handleMobileToggleTouchStart}
          onClick={() => setShowMobileResults((prev) => !prev)}
        >
          <span className="mobile-search-toggle-arrow" aria-hidden="true">
            {showMobileResults ? "↓" : "→"}
          </span>
          <span className="mobile-search-toggle-label">
            {usesPatternSearch
              ? `列出符合「${activeSearchTerm}」的詞`
              : `列出所有含有「${activeSearchTerm}」的詞`}
          </span>
        </button>
      )}
      {shouldRenderResultList && (
        <ul
          className="ui-autocomplete ui-front ui-menu ui-widget ui-widget-content ui-corner-all invisible search-results"
          id="sidebar-search-results"
          role="listbox"
          style={{ position: "fixed", zIndex: isMobileViewport ? 2200 : 1200 }}
        >
          {loadingSuggestions && (
            <li className="ui-menu-item is-status" role="presentation">
              <span className="ui-corner-all">搜尋中…</span>
            </li>
          )}
          {!loadingSuggestions && suggestions.length === 0 && (
            <li className="ui-menu-item is-status" role="presentation">
              <span className="ui-corner-all">沒有符合結果</span>
            </li>
          )}
          {!loadingSuggestions &&
            suggestions.map((suggestion, idx) => (
              <li
                key={`${suggestion.lang}:${suggestion.value}:${idx}`}
                className="ui-menu-item"
                role="presentation"
              >
                <a
                  className="ui-corner-all"
                  tabIndex={-1}
                  role="button"
                  ref={(node) => {
                    suggestionRefs.current[idx] = node;
                  }}
                  onMouseDown={(event) => {
                    if (!isMobileViewport) {
                      event.preventDefault();
                    }
                  }}
                  onClick={() => handleSelectSuggestion(suggestion)}
                  onKeyDown={(event) => handleSuggestionKeyDown(event, idx, suggestion)}
                >
                  {suggestion.label}
                </a>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
