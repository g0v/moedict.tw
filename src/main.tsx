// Offline API handler must be imported before any fetch calls
import "./offline-api.ts";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { applyHeadByPath } from "./ssr/head";
import { resolveLegacyHashRoute } from "./utils/dictionary-route";

/**
 * 在應用啟動前修正 URL，避免編碼字元顯示
 * 這必須在 React Router 初始化之前執行
 */
function fixInitialURL() {
  const currentPath = window.location.pathname;

  // 如果路徑包含編碼字元，立即解碼
  if (currentPath.includes("%")) {
    try {
      const decoded = decodeURIComponent(currentPath);
      if (decoded !== currentPath) {
        // 使用 replaceState 立即修正 URL，不觸發頁面重新載入
        window.history.replaceState(null, "", decoded);
      }
    } catch (e) {
      console.warn("初始 URL 解碼失敗:", e);
    }
  }
}

/**
 * 修正 g0v/moedict-webkit#131：詞條內文連結仍以 `./#'word` 舊式 hashbang
 * 形式產生（見 dictionary-route.ts 的 resolveLegacyHashRoute 註解），
 * 開新分頁／複製連結／直接輸入網址都不經過 App 內的 click handler，
 * 瀏覽器只會落在 pathname "/" + 殘留 hash。必須在 React Router 掛載前
 * 用 replaceState 修正，否則使用者會看到首頁而非目標詞條。
 */
function fixLegacyHashRoute() {
  const target = resolveLegacyHashRoute(window.location.pathname, window.location.hash);
  if (target) {
    window.history.replaceState(null, "", target);
  }
}

/**
 * 攔截 history API，確保所有導航操作都使用未編碼的 URL
 */
function setupHistoryInterceptor() {
  // oxlint-disable-next-line typescript/unbound-method -- saved for `.call(this, …)` invocation below, never called unbound
  const originalPushState = window.history.pushState;
  // oxlint-disable-next-line typescript/unbound-method -- saved for `.call(this, …)` invocation below, never called unbound
  const originalReplaceState = window.history.replaceState;

  window.history.pushState = function (state, title, url) {
    if (typeof url === "string" && url.includes("%")) {
      try {
        const decoded = decodeURIComponent(url);
        return originalPushState.call(this, state, title, decoded);
      } catch {
        // 解碼失敗時使用原始 URL
      }
    }
    return originalPushState.call(this, state, title, url);
  };

  window.history.replaceState = function (state, title, url) {
    if (typeof url === "string" && url.includes("%")) {
      try {
        const decoded = decodeURIComponent(url);
        return originalReplaceState.call(this, state, title, decoded);
      } catch {
        // 解碼失敗時使用原始 URL
      }
    }
    return originalReplaceState.call(this, state, title, url);
  };
}

function applyPlatformClasses() {
  const ua = navigator.userAgent;
  document.documentElement.classList.toggle("moe-android", /\bAndroid\b/i.test(ua));
  document.documentElement.classList.toggle("moe-ios", /\b(iPhone|iPad|iPod)\b/i.test(ua));
  document.documentElement.classList.toggle(
    "moe-capacitor",
    Boolean((window as Window & { Capacitor?: unknown }).Capacitor),
  );
}

// 在渲染前先修正 URL 和設置攔截器
applyPlatformClasses();
fixLegacyHashRoute();
fixInitialURL();
setupHistoryInterceptor();
applyHeadByPath(window.location.pathname);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
