/**
 * 滑動手勢導航 hook
 * 偵測「從螢幕邊緣起手的快速水平甩動」，往右滑回到上一頁，往左滑前往下一頁。
 *
 * 為了避免在 iOS 上「長按選取文字再拖曳」被誤判成換頁，這裡用多重條件
 * 來區分「滑動換頁」與「選字拖曳」：
 *  - 必須從螢幕左／右邊緣起手（內容中間的拖曳＝選字，完全不觸發換頁）
 *  - 選取中（touchend 時仍有文字被選取）一律不換頁
 *  - 多指手勢（縮放等）不算滑動
 *  - 在可編輯欄位（input / textarea / contenteditable）上不觸發
 *  - 換頁滑動必須是「快速一甩」：時間夠短且速度夠快，慢慢拖曳不算
 *
 * 此 hook 回傳一個 callback ref，請直接掛在要監聽的元素上（例如 <main ref={swipeRef}>）。
 * 用 callback ref 而非 useEffect + RefObject，是為了在元素「掛載當下」就立即綁定 listener；
 * 否則冷啟動時 <main> 還沒 render（Layout 仍在 loading 分支），effect 先跑一次拿到 null，
 * 之後 <main> 掛上時 deps 沒變、effect 不會重跑，導致要先點一次才會生效。
 */
import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

const SWIPE_THRESHOLD = 60; // 最小滑動距離（px）
const MAX_VERTICAL_RATIO = 0.3; // 最大允許垂直偏移比例
const MAX_DURATION = 500; // 最長手勢時間（ms）；超過視為慢速拖曳（多半在選字）
const MIN_VELOCITY = 0.3; // 最小水平速度（px/ms）；過慢視為選字而非甩動
const EDGE_ZONE = 60; // 邊緣起手感應區寬度（px）：只有從左／右緣起手才換頁

/** 此次觸控是否落在可編輯／可選取互動元素內 */
function isEditableTarget(target: EventTarget | null): boolean {
  const el =
    target instanceof Element
      ? target.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')
      : null;
  return el != null;
}

/** 目前是否有非空的文字選取 */
function hasActiveSelection(): boolean {
  const selection = window.getSelection();
  return selection != null && !selection.isCollapsed && selection.toString().trim().length > 0;
}

export function useSwipeNavigation(): (el: HTMLElement | null) => void {
  const navigate = useNavigate();
  // 用 ref 保存最新的 navigate，讓 listener 不必在每次換頁（navigate 身分改變）時重綁。
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  const touchStart = useRef<{ x: number; y: number; time: number } | null>(null);
  const detach = useRef<(() => void) | null>(null);

  return useCallback((el: HTMLElement | null) => {
    // 先卸除前一個元素上的 listener（元素替換或卸載時）
    if (detach.current) {
      detach.current();
      detach.current = null;
    }
    if (!el) return;

    const handleTouchStart = (e: TouchEvent) => {
      // 多指手勢（縮放等）或落在可編輯元素上：不視為換頁滑動
      if (e.touches.length > 1 || isEditableTarget(e.target)) {
        touchStart.current = null;
        return;
      }
      const touch = e.touches[0];
      if (!touch) return;
      touchStart.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    };

    const handleTouchMove = (e: TouchEvent) => {
      // 中途出現第二指（縮放）：取消此次滑動判定
      if (e.touches.length > 1) {
        touchStart.current = null;
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      const start = touchStart.current;
      if (!start) return;
      touchStart.current = null;

      const touch = e.changedTouches[0];
      if (!touch) return;

      // 使用者正在選取文字（想複製）：不換頁
      if (hasActiveSelection()) return;

      const deltaX = touch.clientX - start.x;
      const deltaY = touch.clientY - start.y;
      const duration = Date.now() - start.time;

      // 檢查是否為水平滑動：垂直偏移不可超過水平距離的 30%
      if (Math.abs(deltaY) > Math.abs(deltaX) * MAX_VERTICAL_RATIO) return;
      // 檢查滑動距離是否超過門檻
      if (Math.abs(deltaX) < SWIPE_THRESHOLD) return;
      // 必須是「快速一甩」：時間夠短、速度夠快，過濾掉慢速選字拖曳
      if (duration > MAX_DURATION) return;
      if (Math.abs(deltaX) / duration < MIN_VELOCITY) return;

      const viewportWidth = window.innerWidth;
      if (deltaX > 0) {
        // 往右滑 → 上一頁：必須從「左邊緣」起手
        if (start.x > EDGE_ZONE) return;
        navigateRef.current(-1);
      } else {
        // 往左滑 → 下一頁：必須從「右邊緣」起手
        if (start.x < viewportWidth - EDGE_ZONE) return;
        navigateRef.current(1);
      }
    };

    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: true });
    el.addEventListener("touchend", handleTouchEnd, { passive: true });

    detach.current = () => {
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", handleTouchEnd);
    };
  }, []);
}
