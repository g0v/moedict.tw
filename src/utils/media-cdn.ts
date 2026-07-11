/**
 * 舊版 moedict-webkit CDN 資產的公開端點。
 *
 * 筆畫 JSON 已遷移至 Cloudflare R2 moedict-assets，由 ASSET_CDN_BASE
 * 提供服務。發音音檔仍保留在原 Rackspace Cloud Files CDN：R2 的
 * audio/ 物件尚未完整遷移，不能在所有音檔具備前切換播放來源。
 *
 * 音檔與筆畫 JSON 都是瀏覽器（或 dev-time Vite proxy）直接請求公開網域，
 * 不經過 Worker 的 ASSETS R2 binding。
 *
 * 若未來完成音檔遷移，應先驗證四本字典的 .ogg 與 .mp3 物件完整，再只改
 * AUDIO_CDN_MAP；STROKE_JSON_BASE_URL 維持 R2 路由。
 */
export const ASSET_CDN_BASE = "https://r2-assets.moedict.tw";

/**
 * Stable cache-bust version for the legacy `data/assets/styles.css` stylesheet.
 *
 * `?v=<version>` is a one-time cache namespace that bypasses the pre-existing
 * unversioned `styles.css` object (edge-cached at `max-age=86400` / 24h).
 * Routine future data-only uploads remain R2-only and rely on the object's
 * own `Cache-Control: public, max-age=300` metadata (set by Task 3 on re-upload)
 * for a short 5-minute edge TTL — no Worker redeploy needed for CSS-only edits.
 * Bump this query version only for an emergency immediate bust of any stale
 * edge-cached stylesheet key (the original unversioned object at 24h, or a
 * prior `?v=` version still cached at the 5-minute TTL).
 */
export const LEGACY_STYLESHEET_VERSION = "20260711";

/** 筆畫 JSON：`${STROKE_JSON_BASE_URL}/{codepoint-hex}.json` */
export const STROKE_JSON_BASE_URL = `${ASSET_CDN_BASE}/stroke-json`;

/**
 * 四本字典的發音音檔 base URL：`${AUDIO_CDN_MAP[lang]}/{audioId}.ogg`。
 * `c`（兩岸詞典）沒有自己的音檔，沿用 `a`（華語）路由。
 * 客語（`h`）另有腔調組合音檔 `${AUDIO_CDN_MAP.h}/{variant}-{audioId}.ogg`
 * （見 DictionaryPage.tsx 的 getHakkaVariantAudioUrl / parseHakkaReadings）。
 */
export const AUDIO_CDN_MAP: Record<"a" | "t" | "h" | "c", string> = {
  a: "https://203146b5091e8f0aafda-15d41c68795720c6e932125f5ace0c70.ssl.cf1.rackcdn.com",
  t: "https://1763c5ee9859e0316ed6-db85b55a6a3fbe33f09b9245992383bd.ssl.cf1.rackcdn.com",
  h: "https://a7ff62cf9d5b13408e72-351edcddf20c69da65316dd74d25951e.ssl.cf1.rackcdn.com",
  c: "https://203146b5091e8f0aafda-15d41c68795720c6e932125f5ace0c70.ssl.cf1.rackcdn.com",
};
