/**
 * Boot-time legacy-hash → path-route shim（R3 回歸）。
 *
 * 2014 版 moedict.org 的對外分享／書籤網址是 hashbang 形式（`#萌`、
 * `#a=萌`、`#'月暗暝`、`#dict/a萌`、`#a::萌`…）。雜湊不隨 HTTP 請求送出，
 * 這些網址一律落在 pathname "/"，React Router 掛載後無人解析殘留 hash，
 * 使用者只會看到空的 SPA 首頁。本模組必須在 React Router 初始化前執行
 * 一次：命中舊式形式就以 `history.replaceState` 改寫成對應路徑——不留
 * 瀏覽記錄、hash 一併清除，讓 Router 直接看到乾淨的 pathname。
 *
 * 形式判定與路徑對照全部委派 dictionary-route.ts 的 resolveLegacyHashRoute；
 * 本檔只負責 DOM 存取（該檔同時被無 DOM lib 的 worker tsconfig 引用）。
 */

import { resolveLegacyHashRoute } from "./dictionary-route";

export function applyLegacyHashRewrite(): boolean {
  if (typeof window === "undefined") return false;
  const target = resolveLegacyHashRoute(window.location.pathname, window.location.hash);
  if (!target) return false;
  window.history.replaceState(null, "", target);
  return true;
}
