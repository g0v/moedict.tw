// Offline API handler must be imported before any fetch calls
import './offline-api.ts'

// Register the m3e-theme custom element used by the static wrapper in index.html
import '@m3e/web/theme'

// Material Symbols glyphs rendered via <m3e-icon name="..."> across the M3
// chrome (top app bar, settings dialog, dictionary entry actions). Icon
// modules self-register on import — see src/components/SvgIcon.tsx for the
// legacy FontAwesome-derived glyphs still used for external brand marks
// (Apple/Android/Google Play) where Material Symbols has no equivalent.
import '@m3e/icons/outlined/book'
import '@m3e/icons/outlined/bookmark'
import '@m3e/icons/outlined/settings'
import '@m3e/icons/outlined/download'
import '@m3e/icons/outlined/info'
import '@m3e/icons/outlined/edit'
import '@m3e/icons/outlined/star'
import '@m3e/icons/outlined/text_decrease'
import '@m3e/icons/outlined/text_increase'
import '@m3e/icons/outlined/close'
import '@m3e/icons/outlined/arrow_back'
import '@m3e/icons/outlined/add_circle'
import '@m3e/icons/outlined/remove'
import '@m3e/icons/outlined/share'
import '@m3e/icons/outlined/print'
import '@m3e/icons/outlined/search'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyHeadByPath } from './ssr/head'

/**
 * 在應用啟動前修正 URL，避免編碼字元顯示
 * 這必須在 React Router 初始化之前執行
 */
function fixInitialURL() {
  const currentPath = window.location.pathname;
  
  // 如果路徑包含編碼字元，立即解碼
  if (currentPath.includes('%')) {
    try {
      const decoded = decodeURIComponent(currentPath);
      if (decoded !== currentPath) {
        // 使用 replaceState 立即修正 URL，不觸發頁面重新載入
        window.history.replaceState(null, '', decoded);
      }
    } catch (e) {
      console.warn('初始 URL 解碼失敗:', e);
    }
  }
}

/**
 * 攔截 history API，確保所有導航操作都使用未編碼的 URL
 */
function setupHistoryInterceptor() {
  const originalPushState = window.history.pushState;
  const originalReplaceState = window.history.replaceState;

  window.history.pushState = function(state, title, url) {
    if (typeof url === 'string' && url.includes('%')) {
      try {
        const decoded = decodeURIComponent(url);
        return originalPushState.call(this, state, title, decoded);
      } catch {
        // 解碼失敗時使用原始 URL
      }
    }
    return originalPushState.call(this, state, title, url);
  };

  window.history.replaceState = function(state, title, url) {
    if (typeof url === 'string' && url.includes('%')) {
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
  document.documentElement.classList.toggle('moe-android', /\bAndroid\b/i.test(ua));
  document.documentElement.classList.toggle('moe-ios', /\b(iPhone|iPad|iPod)\b/i.test(ua));
}

// 在渲染前先修正 URL 和設置攔截器
applyPlatformClasses();
fixInitialURL();
setupHistoryInterceptor();
applyHeadByPath(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
