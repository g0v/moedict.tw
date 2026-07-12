/**
 * resolveMiddlePointTarget：client 端 `path="*"` 路由（MiddlePoint）的
 * 純 pathname → 頁面目標對應。路徑文法唯一定義在 classifyRoute()；
 * 這裡只做「分類結果 → 頁面」的政策決定，不得自建前綴 if-chain。
 */

import { classifyRoute, type DictionaryLang } from "./dictionary-route";

export type MiddlePointTarget =
  | { page: "home" }
  | { page: "about" }
  | { page: "radical"; lang: "a" | "c"; radical: string }
  | { page: "starred"; lang: DictionaryLang; entry?: string }
  | { page: "list"; lang: DictionaryLang; category: string }
  | { page: "dict"; lang: DictionaryLang; word: string; idx?: number };

/**
 * 保留 MiddlePoint 歷來的邊界行為：
 * - 多層路徑（payload 內含 `/`，非 `/N` idx 形式）一律回首頁。
 * - 空部首（`@`、`~@`）與空分類（`=`、`'=` 等）沿用舊版行為，
 *   fallback 成該語言的字典頁（word 為殘餘字串）——這些是無人連結的
 *   legacy 奇例，保留只為不改變可觀察行為。
 */
export function resolveMiddlePointTarget(pathname: string): MiddlePointTarget {
  const route = classifyRoute(pathname);

  switch (route.kind) {
    case "default":
    case "invalid-encoding":
      return { page: "home" };
    case "about":
      return { page: "about" };
    case "radical": {
      if (route.radical.includes("/")) return { page: "home" };
      if (!route.radical) {
        // 舊版：裸 '@' / '~@' 落到字典頁（App.tsx 的靜態路由通常先攔走）
        return { page: "dict", lang: route.lang, word: "@" };
      }
      return { page: "radical", lang: route.lang, radical: route.radical };
    }
    case "starred": {
      if (route.entry.includes("/")) return { page: "home" };
      return { page: "starred", lang: route.lang, entry: route.entry || undefined };
    }
    case "group": {
      if (route.category.includes("/")) return { page: "home" };
      if (!route.category) {
        // 舊版：空分類（如 "'="）落到該語言字典頁，word 為 '='
        return { page: "dict", lang: route.lang, word: "=" };
      }
      return { page: "list", lang: route.lang, category: route.category };
    }
    case "entry": {
      if (route.text.includes("/")) return { page: "home" };
      return { page: "dict", lang: route.lang, word: route.text, idx: route.idx };
    }
  }
}
