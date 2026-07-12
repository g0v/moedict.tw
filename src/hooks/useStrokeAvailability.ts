/**
 * 筆順動畫資料可用性 hook（issue #132：缺筆順資料時應停用相關按鈕）
 *
 * 背景：筆順動畫實際繪製邏輯在 jquery.strokeWords.js（見
 * StrokeAnimation.tsx），其 `drawElementWithWord` 對 /api/stroke-json/{cp}.json
 * 404 的處理方式是「照樣畫一個空白畫布、只是整體淡到 50% 透明度」——沒有任何
 * 文字說明或可視提示。對使用者而言，點下筆順動畫按鈕後看到的就是一片空白，
 * 完全無法分辨是「資料不存在」還是「載入失敗／當機」（issue #132 原始回報：
 * 點擊 煏 的筆順動畫顯示空白區域）。
 *
 * 修法：在按鈕渲染前先以 HEAD 探測該字的筆順 JSON 是否存在，讓呼叫端能提前
 * 停用（disable）觸發筆順動畫的按鈕，而不是任由使用者點下去才發現是空的。
 *
 * 範圍刻意只涵蓋「單一漢字」詞條：多字詞組沿用原本「盡量畫、個別字失敗就淡出」
 * 的設計（jquery.strokeWords.js 的 pool loader 本就允許部分成功），不在此
 * hook 的判定範圍內，避免只因詞組中某一字缺資料就整組停用、誤傷其餘可正常
 * 顯示的字。
 */
import { useEffect, useState } from "react";

// 模組層級快取：同一個 codepoint 在本次瀏覽 session 內只探測一次（HEAD 本身
// 也會命中 Worker/R2 的 Cache-Control，但仍避免重覆 fetch 呼叫與重複的
// pending state）。
const availabilityCache = new Map<string, Promise<boolean>>();

function toCodepointHex(char: string): string | null {
  const cp = char.codePointAt(0);
  return cp ? cp.toString(16) : null;
}

async function checkStrokeAvailability(cp: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/stroke-json/${cp}.json`, { method: "HEAD" });
    return res.ok;
  } catch {
    // 探測本身失敗（離線、逾時等）時採樂觀假設＝可用，避免因探測異常而
    // 誤停用原本正常的功能；使用者點下去仍會走原本的成功/淡出流程。
    return true;
  }
}

/**
 * @param char 欲檢查的單一漢字；非單字（詞組）情境請傳 `null`，一律視為
 *   「可用」（不停用，維持原行為）。
 * @returns `true`＝已知可用、`false`＝已知不可用（stroke-json 404）、
 *   `null`＝尚未查明（探測中，或本來就不適用）。呼叫端應只在明確拿到
 *   `false` 時才停用按鈕，避免探測完成前出現不必要的停用閃爍。
 */
export function useStrokeAvailability(char: string | null): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    if (!char || !/\p{Script=Han}/u.test(char)) {
      setAvailable(null);
      return;
    }
    const cp = toCodepointHex(char);
    if (!cp) {
      setAvailable(null);
      return;
    }

    let cancelled = false;
    setAvailable(null);

    let promise = availabilityCache.get(cp);
    if (!promise) {
      promise = checkStrokeAvailability(cp);
      availabilityCache.set(cp, promise);
    }
    void promise.then((ok) => {
      if (!cancelled) setAvailable(ok);
    });

    return () => {
      cancelled = true;
    };
  }, [char]);

  return available;
}
