/**
 * 字典發音音檔工具
 * 複刻原專案 DictionaryViews 的 getAudioUrl 與 playAudio 行為
 */

import { AUDIO_CDN_MAP } from './media-cdn';

export type DictionaryLang = 'a' | 't' | 'h' | 'c';

function normalizeAudioIdByLang(lang: DictionaryLang, audioId: string): string {
  const normalized = String(audioId || '').trim();
  if (!normalized) return '';
  if (lang !== 't') return normalized;
  // 台語音檔路徑採 5 碼數字，資料若為 4 碼需補 0（例：8778 -> 08778）
  if (/^\d{1,4}$/.test(normalized)) return normalized.padStart(5, '0');
  return normalized;
}

/**
 * 根據語言與 audio_id 取得音檔 URL
 */
export function getAudioUrl(lang: DictionaryLang, audioId: string): string {
  const base = AUDIO_CDN_MAP[lang] ?? AUDIO_CDN_MAP.a;
  const normalizedAudioId = normalizeAudioIdByLang(lang, audioId);
  return `${base}/${normalizedAudioId}.ogg`;
}

let currentAudio: HTMLAudioElement | null = null;
let currentToken = 0;
let currentRequestKey: string | null = null;

function buildAudioCandidates(url: string): string[] {
  const match = url.match(/^(.*)\.(\w+)(\?.*)?$/);
  if (!match) return [url];
  const base = match[1];
  const query = match[3] || '';
  // iPad Safari 對 ogg 支援不穩，先嘗試 mp3，再退回 ogg
  return [`${base}.mp3${query}`, `${base}.ogg${query}`];
}

/**
 * 播放音檔 URL（使用 HTML5 Audio）
 * 點擊同一按鈕可停止播放
 */
export function playAudioUrl(url: string, onStateChange?: (playing: boolean) => void): void {
  if (typeof window === 'undefined') return;
  const token = ++currentToken;
  const requestKey = url;

  const stop = () => {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      currentAudio = null;
    }
    currentRequestKey = null;
    onStateChange?.(false);
  };

  if (currentAudio && currentRequestKey === requestKey) {
    stop();
    return;
  }

  stop();
  const audio = new Audio();
  // iOS Safari 友善設定
  audio.preload = 'none';
  audio.setAttribute('playsinline', 'true');
  audio.setAttribute('webkit-playsinline', 'true');
  currentAudio = audio;
  currentRequestKey = requestKey;

  audio.addEventListener('ended', () => {
    if (currentAudio === audio) {
      currentAudio = null;
      onStateChange?.(false);
    }
  });

  audio.addEventListener('error', () => {
    if (currentAudio === audio) {
      currentAudio = null;
      onStateChange?.(false);
    }
  });

  const candidates = buildAudioCandidates(url);
  void (async () => {
    for (const candidate of candidates) {
      if (currentToken !== token || currentAudio !== audio) return;
      try {
        audio.src = candidate;
        audio.load();
        await audio.play();
        if (currentToken !== token || currentAudio !== audio) return;
        onStateChange?.(true);
        return;
      } catch (err) {
        console.warn('[Audio] 播放失敗，嘗試下一種格式:', candidate, err);
      }
    }
    if (currentToken === token && currentAudio === audio) {
      currentAudio = null;
      currentRequestKey = null;
      onStateChange?.(false);
    }
  })();
}

/**
 * 停止目前播放中的音檔
 */
export function stopAudio(): void {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
  currentRequestKey = null;
}
