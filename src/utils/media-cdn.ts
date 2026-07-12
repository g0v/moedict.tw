/**
 * 舊版 moedict-webkit CDN 資產（筆畫 JSON、四本字典發音音檔）現在的公開端點。
 *
 * 這批資料原本託管在 Rackspace Cloud Files（*.rackcdn.com，2013 年上傳，
 * 帳號無法再列出物件清單）。已透過 commands/migrate-legacy-cdn-to-r2.mjs
 * 一次性遷移進 Cloudflare R2 moedict-assets 桶，由既有的 ASSET_BASE_URL 公開
 * 網域（見 wrangler.jsonc、README_CDN.md）提供服務。
 *
 * 音檔與筆畫 JSON 都是瀏覽器（或 dev-time Vite proxy）直接打這個公開網域，
 * 不經過 Worker 的 ASSETS R2 binding——維持遷移前「直連外部 CDN」的行為，
 * 只是把外部 CDN 換成我們自己的 R2。
 *
 * 若未來調整網域，這是唯一該改的地方；handleStrokeAPI.ts、audio-utils.ts、
 * DictionaryPage.tsx、offline-api.ts、vite.config.ts 都從這裡 import。
 */
export const ASSET_CDN_BASE = 'https://r2-assets.moedict.tw';

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
export const LEGACY_STYLESHEET_VERSION = '20260711';

/** 筆畫 JSON：`${STROKE_JSON_BASE_URL}/{codepoint-hex}.json` */
export const STROKE_JSON_BASE_URL = `${ASSET_CDN_BASE}/stroke-json`;

/**
 * 四本字典的發音音檔 base URL：`${AUDIO_CDN_MAP[lang]}/{audioId}.ogg`。
 * `c`（兩岸詞典）沒有自己的音檔，沿用 `a`（華語）路由。
 * 客語（`h`）另有腔調組合音檔 `${AUDIO_CDN_MAP.h}/{variant}-{audioId}.ogg`
 * （見 DictionaryPage.tsx 的 getHakkaVariantAudioUrl / parseHakkaReadings）。
 */
export const AUDIO_CDN_MAP: Record<'a' | 't' | 'h' | 'c', string> = {
  a: `${ASSET_CDN_BASE}/audio/a`,
  t: `${ASSET_CDN_BASE}/audio/t`,
  h: `${ASSET_CDN_BASE}/audio/h`,
  c: `${ASSET_CDN_BASE}/audio/a`,
};
