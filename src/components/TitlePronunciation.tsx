import type { ReactNode } from 'react';
import { formatBopomofo, formatPinyin } from '../utils/bopomofo-pinyin-utils';
import { SvgIcon } from './SvgIcon';

/**
 * 順序不變量（order invariant）
 *
 * <h1 className="title"> 內，ruby/title 之後的 sibling 順序固定為：
 *   children（ruby/title span）→ small.youyin → span.audioBlock → small.alternative
 *
 * 依 legacy `~/w/moedict-webkit/view.ls:132-158` 的 ground truth：
 *   list ++= small { className: \youyin } youyin if youyin
 *   …audioBlock（play button）…
 *   list ++= small { className: \alternative }, …
 *
 * `.alternative` 內的 `.pinyin`/`.bopomofo` 是 block-level（遠端 legacy CSS），
 * 插錯位置會把播放鍵擠下去——已踩過一次（commit 把 .alternative 插到
 * .audioBlock 之前，造成視覺回歸）。本元件把順序固化在唯一可測試的地方，
 * 並由 tests/unit/title-pronunciation.test.tsx 守住。
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
 */
interface TitlePronunciationProps {
  children: ReactNode;
  lang: 'a' | 't' | 'h' | 'c';
  youyin?: string;
  bAlt?: string;
  pAlt?: string;
  pronunAudioId?: string;
  isPlaying: boolean;
  onToggleAudio: () => void;
}

export function TitlePronunciation({
  children,
  lang,
  youyin,
  bAlt,
  pAlt,
  pronunAudioId,
  isPlaying,
  onToggleAudio,
}: TitlePronunciationProps) {
  return (
    <>
      {children}
      {youyin && <small className="youyin">{youyin}</small>}
      {lang !== 'h' && pronunAudioId && (
        <span className="audioBlock">
          <span
            role="button"
            tabIndex={0}
            aria-label={isPlaying ? '停止播放' : '播放發音'}
            className="playAudio part-of-speech"
            title={isPlaying ? '停止播放' : '播放發音'}
            onClick={(event) => {
              event.stopPropagation();
              onToggleAudio();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onToggleAudio();
              }
            }}
          >
            <SvgIcon name={isPlaying ? 'stop' : 'play'} size="1em" aria-hidden="true" />
          </span>
        </span>
      )}
      {(bAlt || pAlt) && (
        <small className="alternative">
          {lang !== 'h' && pAlt && (
            <span className="pinyin" dangerouslySetInnerHTML={{ __html: formatPinyin(pAlt) }} />
          )}
          {bAlt && (
            <span className="bopomofo" dangerouslySetInnerHTML={{ __html: formatBopomofo(bAlt) }} />
          )}
        </small>
      )}
    </>
  );
}
