import { useState } from "react";
import type { ReactNode } from "react";
import { formatBopomofo, formatPinyin } from "../utils/bopomofo-pinyin-utils";
import { collectRubyRomanization } from "../utils/ruby2hruby";
import { READING_TYPE_LABELS } from "../utils/reading-type-labels";
import { SvgIcon } from "./SvgIcon";

/**
 * 順序不變量（order invariant）
 *
 * <h1 className="title"> 內，ruby/title 之後的 sibling 順序固定為：
 *   children（ruby/title span）→ small.youyin → span.audioBlock →
 *   span.copyBlock → small.alternative → small.reading-type
 * 依 legacy `~/w/moedict-webkit/view.ls:132-158` 的 ground truth：
 *   list ++= small { className: \youyin } youyin if youyin
 *   …audioBlock（play button）…
 *   list ++= small { className: \alternative }, …
 * `copyBlock` 是本次新增（g0v/moedict-webkit#256），插在 audioBlock 之後、
 * alternative 之前，沿用同一個「先窄範圍互動元件、後 block-level 替代讀音」
 * 的順序慣例，不打亂 legacy ground truth。
 *
 * `small.reading-type` 是新增的元素（g0v/moedict-webkit#96、#233：TWBLG
 * 單字文/白/俗/替讀音分類），legacy 沒有對應節點；為了不干擾既有四個
 * 節點間已鎖定的相對順序，固定加在最後面。
 *
 * `.alternative` 內的 `.pinyin`/`.bopomofo` 是 block-level（遠端 legacy CSS），
 * 插錯位置會把播放鍵擠下去——已踩過一次（commit 把 .alternative 插到
 * .audioBlock 之前，造成視覺回歸）。本元件把順序固化在唯一可測試的地方，
 * 並由 tests/unit/title-pronunciation.test.tsx 守住。
 *
 * `small.reading-type` 是 TWBLG 文/白/俗/替分類；legacy 沒有對應節點。
 * 固定放在最後，避免干擾前四個節點的既有相對順序。
 *
 * Props:
 * - children: ruby/title span（由 DictionaryPage 透傳，內容不變）
 * - lang: 字典語言代碼
 * - youyin: 又音字串（falsy 則不渲染 small.youyin）
 * - bAlt: bopomofo 替代讀音（falsy 則不渲染該 span）
 * - pAlt: pinyin 替代讀音（lang='h' 時不渲染該 span）
 * - pronunAudioId: 音檔 id（falsy 則不渲染 span.audioBlock）
 * - isPlaying: 是否正在播放此音檔（控制 play/stop 圖示與 aria-label/title）
 * - onToggleAudio: 點擊/鍵盤啟動時呼叫（播放或停止由上層邏輯決定）
 * - hasRomanization: 是否有羅馬拼音可複製（falsy 則不渲染 span.copyBlock）。
 *   lang='h'（客語）一律不渲染，因為客語拼音本身就是可直接選取/複製的一般
 *   文字，不需要這個按鈕（g0v/moedict-webkit#256 只回報中文/閩南語）。
 * - readingType: TWBLG 文/白/俗/替分類（falsy 則不渲染）
 * - readingType: TWBLG 異讀分類純文字代碼（文/白/俗/替；falsy 則不渲染）
 */
interface TitlePronunciationProps {
  children: ReactNode;
  lang: "a" | "t" | "h" | "c";
  youyin?: string;
  bAlt?: string;
  pAlt?: string;
  pronunAudioId?: string;
  isPlaying: boolean;
  onToggleAudio: () => void;
  hasRomanization?: boolean;
  readingType?: string;
}

const COPIED_FEEDBACK_MS = 1200;

export function TitlePronunciation({
  children,
  lang,
  youyin,
  bAlt,
  pAlt,
  pronunAudioId,
  isPlaying,
  onToggleAudio,
  hasRomanization,
  readingType,
}: TitlePronunciationProps) {
  const readingTypeLabel = readingType ? (READING_TYPE_LABELS[readingType] ?? readingType) : "";
  const [copied, setCopied] = useState(false);

  function copyRomanization(currentTarget: HTMLElement) {
    const hruby = currentTarget.closest("h1")?.querySelector("hruby");
    if (!hruby) return;
    const text = collectRubyRomanization(hruby);
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    });
  }

  return (
    <>
      {children}
      {youyin && <small className="youyin">{youyin}</small>}
      {lang !== "h" && pronunAudioId && (
        <span className="audioBlock">
          <span
            role="button"
            tabIndex={0}
            aria-label={isPlaying ? "停止播放" : "播放發音"}
            className="playAudio part-of-speech"
            title={isPlaying ? "停止播放" : "播放發音"}
            onClick={(event) => {
              event.stopPropagation();
              onToggleAudio();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onToggleAudio();
              }
            }}
          >
            <SvgIcon name={isPlaying ? "stop" : "play"} size="1em" aria-hidden="true" />
          </span>
        </span>
      )}
      {lang !== "h" && hasRomanization && (
        <span className="copyBlock">
          <span
            role="button"
            tabIndex={0}
            aria-label={copied ? "已複製" : "複製羅馬拼音"}
            className="copyRomanization part-of-speech"
            title={copied ? "已複製" : "複製羅馬拼音"}
            onClick={(event) => {
              event.stopPropagation();
              copyRomanization(event.currentTarget);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                copyRomanization(event.currentTarget);
              }
            }}
          >
            <SvgIcon name="copy" size="1em" aria-hidden="true" />
          </span>
        </span>
      )}
      {(bAlt || pAlt) && (
        <small className="alternative">
          {lang !== "h" && pAlt && (
            <span className="pinyin" dangerouslySetInnerHTML={{ __html: formatPinyin(pAlt) }} />
          )}
          {bAlt && (
            <span className="bopomofo" dangerouslySetInnerHTML={{ __html: formatBopomofo(bAlt) }} />
          )}
        </small>
      )}
      {lang === "t" && readingType && (
        <small className="reading-type" title={readingTypeLabel} aria-label={readingTypeLabel}>
          {readingType}
        </small>
      )}
    </>
  );
}
