/**
 * 語言切換工具
 * 復刻原 moedict-webkit 的 press-lang 行為：
 * - a ↔ c：同一詞，只加/去 ~ 前綴
 * - 其他跨語言切換：從 xref.json 查對應詞，找不到用 LRU 或預設詞
 */

import type { DictionaryLang } from "./word-record-utils";
import { readLRUWords } from "./word-record-utils";

interface XrefEntry {
  lang: DictionaryLang;
  words: string[];
}

// xref.json 結構：{ [targetLang]: { [sourceWord]: "word1,word2" } }
type XrefData = Record<string, Record<string, string>>;

const DEFAULTS: Record<DictionaryLang, string> = {
  a: "萌",
  t: "發穎",
  h: "發芽",
  c: "萌",
};

export const LANG_PREFIX: Record<DictionaryLang, string> = {
  a: "",
  t: "'",
  h: ":",
  c: "~",
};

// 模組級快取：每個語言的 xref.json 資料
const XREF_CACHE: Partial<Record<DictionaryLang, XrefData>> = {};
const XREF_LOADING: Set<DictionaryLang> = new Set();
const XREF_LOADED: Set<DictionaryLang> = new Set();

// 當前條目資訊（來自 API entry.xrefs 的備用）
let _word = "";
let _lang: DictionaryLang = "a";
let _xrefs: XrefEntry[] = [];

function normalizeWordToken(word: string): string {
  return String(word || "")
    .trim()
    .replace(/^`+/, "")
    .replace(/~+$/, "");
}

/** 從 /api/xref/{lang}.json 載入並快取該語言的 xref 資料 */
async function loadXrefForLang(lang: DictionaryLang): Promise<void> {
  if (XREF_LOADED.has(lang) || XREF_LOADING.has(lang)) return;
  XREF_LOADING.add(lang);
  try {
    const res = await fetch(`/api/xref/${lang}.json`);
    if (res.ok) {
      const data = (await res.json()) as XrefData;
      XREF_CACHE[lang] = data;
      XREF_LOADED.add(lang);
    }
  } catch {
    // Background preload failures are non-fatal; lookup falls back to entry data.
  } finally {
    XREF_LOADING.delete(lang);
  }
}

/** DictionaryPage 載入詞條後呼叫，觸發預載入 xref 並儲存 entry.xrefs 備用 */
export function setCurrentXrefs(word: string, lang: DictionaryLang, xrefs: XrefEntry[]): void {
  _word = normalizeWordToken(word);
  _lang = lang;
  _xrefs = (xrefs ?? []).map((xref) => ({
    ...xref,
    words: (xref.words ?? []).map((w) => normalizeWordToken(w)).filter(Boolean),
  }));
  // 背景預載入目前語言的 xref，讓使用者點選語言切換時已有快取
  void loadXrefForLang(lang);
}

/**
 * 查詢 fromWord 在 fromLang 的 xref 資料中，對應 toLang 的詞
 * 優先用客戶端載入的 xref.json，其次用 entry.xrefs（API 回傳）
 */
function lookupXref(fromLang: DictionaryLang, toLang: DictionaryLang, fromWord: string): string {
  const normalizedFromWord = normalizeWordToken(fromWord);

  // 1. 從客戶端載入的 xref.json 查
  const xrefData = XREF_CACHE[fromLang];
  if (xrefData) {
    const toLangMap = xrefData[toLang];
    if (toLangMap) {
      const candidates = [normalizedFromWord, `\`${normalizedFromWord}`];
      let raw = "";
      for (const key of candidates) {
        raw = toLangMap[key] ?? "";
        if (raw) break;
      }
      if (raw && normalizedFromWord) {
        const words = raw
          .split(",")
          .map((w) => w.trim())
          .filter(Boolean);
        if (words.length > 0) {
          return normalizeWordToken(words[0]);
        }
      }
    }
  }

  // 2. Fallback：從 entry.xrefs（API 回傳）查
  if (_word === fromWord && _lang === fromLang) {
    for (const xref of _xrefs) {
      if (xref.lang === toLang && xref.words.length > 0) {
        return normalizeWordToken(xref.words[0]);
      }
    }
  }

  return "";
}

/** 將可能被 URL 編碼的詞解碼，避免 xref 查詢與 entry.xrefs 比對失敗 */
function decodeWord(word: string): string {
  try {
    return normalizeWordToken(decodeURIComponent(word));
  } catch {
    return normalizeWordToken(word);
  }
}

/**
 * 計算語言切換後的目標路徑（同步）
 * 呼叫前建議先確保 xref 已預載（由 setCurrentXrefs 觸發）
 */
export function computeLangSwitchPath(
  fromLang: DictionaryLang,
  toLang: DictionaryLang,
  fromWord: string,
): string {
  fromWord = decodeWord(fromWord);

  if (fromLang === toLang) {
    const path = `/${LANG_PREFIX[toLang]}${fromWord}`;
    return path;
  }

  // 華語 ↔ 兩岸：同一詞，只換前綴
  if ((fromLang === "a" && toLang === "c") || (fromLang === "c" && toLang === "a")) {
    const path = `/${LANG_PREFIX[toLang]}${fromWord}`;
    return path;
  }

  // 跨語言：從 xref 查對應條目名稱，再處理前綴
  let targetWord = lookupXref(fromLang, toLang, fromWord);

  // 台語/客語 → 兩岸：若 xref 沒有 c，改查華語對應詞再套 ~ 前綴
  if (!targetWord && (fromLang === "t" || fromLang === "h") && toLang === "c") {
    targetWord = lookupXref(fromLang, "a", fromWord);
    if (targetWord) {
      const path = `/${LANG_PREFIX.c}${targetWord}`;
      return path;
    }
  }

  // Fallback：目標語言的 LRU
  if (!targetWord) {
    const lru = readLRUWords(toLang);
    targetWord = lru[0] ?? "";
  }

  // Fallback：預設詞
  if (!targetWord) {
    targetWord = DEFAULTS[toLang];
  }

  const path = `/${LANG_PREFIX[toLang]}${targetWord}`;
  return path;
}

/**
 * 非同步版：確保 xref 已載入後再查詢（首次切換可能有短暫延遲）
 */
export async function computeLangSwitchPathAsync(
  fromLang: DictionaryLang,
  toLang: DictionaryLang,
  fromWord: string,
): Promise<string> {
  if (!XREF_LOADED.has(fromLang)) {
    await loadXrefForLang(fromLang);
  }
  return computeLangSwitchPath(fromLang, toLang, fromWord);
}
