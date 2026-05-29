/**
 * 滑動手勢導航 hook
 * 偵測水平滑動，往右滑回到上一頁，往左滑前往下一頁
 */
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

const SWIPE_THRESHOLD = 50;       // 最小滑動距離（px）
const MAX_VERTICAL_RATIO = 0.3;   // 最大允許垂直偏移比例

export function useSwipeNavigation(elementRef: React.RefObject<HTMLElement | null>) {
  const navigate = useNavigate();
  const touchStart = useRef<{ x: number; y: number; time: number } | null>(null);

  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;

    const handleTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      touchStart.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    };

    const handleTouchEnd = (e: TouchEvent) => {
      const start = touchStart.current;
      if (!start) return;
      touchStart.current = null;

      const touch = e.changedTouches[0];
      if (!touch) return;

      const deltaX = touch.clientX - start.x;
      const deltaY = touch.clientY - start.y;

      // 檢查是否為水平滑動：垂直偏移不可超過水平距離的 30%
      if (Math.abs(deltaY) > Math.abs(deltaX) * MAX_VERTICAL_RATIO) return;
      // 檢查滑動距離是否超過門檻
      if (Math.abs(deltaX) < SWIPE_THRESHOLD) return;

      if (deltaX > 0) {
        // 往右滑 → 上一頁
        navigate(-1);
      } else {
        // 往左滑 → 下一頁
        navigate(1);
      }
    };

    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchend', handleTouchEnd);
    };
  }, [elementRef, navigate]);
}
