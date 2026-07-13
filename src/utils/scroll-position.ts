/**
 * 記錄並還原每個歷史紀錄項目（history entry）的捲動位置。
 *
 * 瀏覽器原生的 `history.scrollRestoration = "auto"` 只會在 popstate 當下嘗試
 * 還原一次；萌典的詞語列表頁（例如 /=成語）內容量大，重新渲染到完整高度需要
 * 一段時間，若還原嘗試發生在內容還沒撐開之前，捲動位置就會被夾在當下可捲動的
 * 最大值，之後即使內容長高了也不會再重試（見 g0v/moedict-webkit#102）。
 *
 * 因此改為自行管理：捲動時把位置存進 sessionStorage（依 history entry 的
 * `location.key` 做區隔），POP 導航（瀏覽器上一頁/下一頁）時輪詢等待內容長到
 * 足夠高度再還原，並將 `history.scrollRestoration` 設為 `"manual"` 避免瀏覽器
 * 自己的一次性嘗試與此機制互相干擾。
 */

const STORAGE_KEY = "moedict:scroll-positions";
const MAX_ENTRIES = 50;
const RESTORE_MAX_ATTEMPTS = 30;

function safeGetItem(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // noop（例如 Safari 私密瀏覽模式會拋錯）
  }
}

function loadPositions(): Record<string, number> {
  const raw = safeGetItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const positions: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        positions[key] = value;
      }
    }
    return positions;
  } catch {
    // 忽略壞掉的資料，視為沒有記錄
  }
  return {};
}

export function saveScrollPosition(key: string, y: number): void {
  const positions = loadPositions();
  positions[key] = y;
  const entries = Object.entries(positions);
  if (entries.length > MAX_ENTRIES) {
    // 超過上限時，捨棄最早加入的項目，避免 sessionStorage 無限增長。
    for (const [staleKey] of entries.slice(0, entries.length - MAX_ENTRIES)) {
      delete positions[staleKey];
    }
  }
  safeSetItem(STORAGE_KEY, JSON.stringify(positions));
}

export function getSavedScrollPosition(key: string): number | undefined {
  return loadPositions()[key];
}

/**
 * 輪詢等待頁面內容長到能容納目標捲動位置後才還原，避免被過早夾住。
 * 最多重試 {@link RESTORE_MAX_ATTEMPTS} 個動畫影格，逾時則還原到目前可捲動的
 * 最大位置。還原期間（呼叫到 `onSettled` 之前）呼叫端應暫停捲動位置的儲存，
 * 否則舊頁面殘留的 `scrollY` 可能在還原完成前被誤存進新頁面的紀錄，蓋掉正確
 * 的已存位置。
 */
export function restoreScrollPosition(targetY: number, onSettled: () => void): void {
  let attempts = 0;
  const tryRestore = () => {
    attempts += 1;
    const maxScroll = Math.max(document.documentElement.scrollHeight - window.innerHeight, 0);
    if (maxScroll >= targetY || attempts >= RESTORE_MAX_ATTEMPTS) {
      window.scrollTo(0, Math.min(targetY, maxScroll));
      onSettled();
      return;
    }
    requestAnimationFrame(tryRestore);
  };
  requestAnimationFrame(tryRestore);
}

let nativeRestorationDisabled = false;

/** 關閉瀏覽器原生的一次性還原嘗試，改由本模組全權接管。只需執行一次。 */
export function disableNativeScrollRestoration(): void {
  if (nativeRestorationDisabled) return;
  try {
    if ("scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
  } catch {
    // noop
  }
  nativeRestorationDisabled = true;
}
