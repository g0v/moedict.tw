# 本專案靜態 CDN 資源清單

本文記錄目前專案程式碼中實際使用的靜態 CDN 資源（含硬編碼與環境變數設定）。

## 一、Cloudflare R2 公開端點

### 1) 筆畫 JSON 與四本字典發音音檔（`src/utils/media-cdn.ts`）

- 筆畫 JSON CDN：`https://r2-assets.moedict.tw`（R2 bucket `moedict-assets`，同 `ASSET_BASE_URL`）
- 發音音檔 CDN：仍使用下方「Rackspace 音檔」表列的 legacy `*.rackcdn.com` 主機；
  R2 `audio/` 物件尚未完整遷移，不能切換播放來源。
- Key 版面（音檔有 `.ogg`（2013 年原始上傳）與 `.mp3`（2019 年補上，
  iPad Safari 對 ogg 支援不穩時的備援）兩種候選格式；部分 `.mp3` 尚未覆蓋，
  `playAudioUrl()` 一律先試 `.mp3`，失敗（含 `error` event）再退回 `.ogg`，
  見 `audio-utils.ts` 的 `buildAudioCandidates()`）：
  - 筆畫 JSON：`stroke-json/{codepoint-hex}.json`（4–6 碼小寫十六進位 Unicode codepoint，僅 JSON）
  - 華語／兩岸音檔：legacy a host 的 `{audioId}.{ogg,mp3}`（`c` 沿用同一路由）
  - 台語音檔：legacy t host 的 `{audioId}.{ogg,mp3}`（1–4 碼純數字 id 會補零到 5 碼，見 `normalizeAudioIdByLang`）
  - 客語音檔：legacy h host 的 `{variant}-{audioId}.{ogg,mp3}`（`variant` 為腔調序號 1–6，對應
    `四海大平安南`；客語**沒有**不帶腔調前綴的純 `{audioId}.{ogg,mp3}`，見下方「資料完整性」）
- 使用位置：`src/api/handleStrokeAPI.ts`（Worker 代理，解 CORS）、
  `src/utils/audio-utils.ts`、`src/pages/DictionaryPage.tsx`
  （`getHakkaVariantAudioUrl`）、`src/offline-api.ts`（Capacitor 離線 fallback）、
  `vite.config.ts`（dev-time 筆畫 JSON proxy）
- **單一定義點**：所有上述位置都從 `src/utils/media-cdn.ts` import
  `STROKE_JSON_BASE_URL` / `AUDIO_CDN_MAP`；調整網域只需要改這一個檔案。

### 2) 前端資產（fonts / JS / CSS）

- 變數：`ASSET_BASE_URL`
- 目前設定（本機）：`https://pub-1808868ac1e14b13abe9e2800cace884.r2.dev`
  （正式站另有自訂網域 `https://r2-assets.moedict.tw`，見上）
- 用途：當 Worker 內建資產找不到時，回退代理 `/assets/*` 請求到此端點；
  來源為 `data/assets/`，經 `commands/upload_assets.sh`（rclone）同步
- 使用位置：`wrangler.jsonc`、`worker/index.ts`

### 3) 字典資料端點

- 變數：`DICTIONARY_BASE_URL`
- 目前設定（本機）：`https://pub-7e5ed83262e5403d85cb5a04ff841cf4.r2.dev`
- 用途：透過 `/api/config` 回傳給前端作為字典資料來源設定
- 使用位置：`wrangler.jsonc`、`worker/index.ts`

## 二、資料完整性（新增詞條的音檔/筆畫從哪裡來）

R2 上的筆畫 JSON 是**一次性遷移**的結果；發音音檔仍由 legacy Rackspace CDN
提供。`data/dictionary/{pack,ptck,phck,pcck}` 若因上游（moedict-data／twblg）
同步新增了帶 `audio_id` 的詞條，其對應音檔不會自動出現在 R2——除非重新執行
遷移腳本並先以完整性檢查確認所有 `.ogg`／`.mp3` 物件都已存在。現階段播放
路由不依賴 R2 `audio/`，因此新詞條音檔仍需先確認 legacy 來源可用：

```bash
node commands/migrate-legacy-cdn-to-r2.mjs
```

此腳本會重新從 `data/dictionary` 推導完整 key 集合，跳過已存在
（`.migration-state/legacy-cdn-progress.ndjson` 記錄的 `ok`/`404`）的物件，
只嘗試新增的部分——但只在舊版 Rackspace 來源仍可連線時有效。若 Rackspace
帳號已完全關閉，新詞條的音檔／筆畫資料需要另尋來源（通常是原始
moedict-webkit 音檔庫或重新錄製）。

客語（`h`）的「純」`{audioId}.{ogg,mp3}`（不帶腔調前綴）在上游從未存在
——`DictionaryPage.tsx` 對 `lang==='h'` 一律不顯示該按鈕，實際播放的是
`{variant}-{audioId}.{ogg,mp3}`，因此遷移腳本刻意不處理這個分類。

## 三、Rackspace 音檔仍為現行路由（R2 遷移暫停）

以下 4 個 Rackspace Cloud Files 容器（2013 年由 moedict-webkit 上傳，`http-map`
定義於原專案 `main.ls`/`view.ls`）的音檔目前仍由 `src/utils/media-cdn.ts`
直接使用。曾嘗試透過 `commands/migrate-legacy-cdn-to-r2.mjs` 遷移至 R2，
但 `audio/` 物件尚未完整，故不能宣稱 Rackspace 已停用；下表保留來源與
對應語言，待完整遷移及逐項驗證後再切換。

### Rackspace host 對照與遷移記錄

| 用途             | Host（`*.rackcdn.com`）                                         | 對應語言                       |
| ---------------- | --------------------------------------------------------------- | ------------------------------ |
| 舊筆畫 JSON host | `829091573dd46381a321-9e8a43b8d3436eaf4353af683c892840.ssl.cf1` | 全部（a/t/h/c 詞條標題）       |
| 音檔             | `203146b5091e8f0aafda-15d41c68795720c6e932125f5ace0c70.ssl.cf1` | `a` 華語（`c` 兩岸沿用）       |
| 音檔             | `1763c5ee9859e0316ed6-db85b55a6a3fbe33f09b9245992383bd.ssl.cf1` | `t` 臺灣台語                   |
| 音檔             | `a7ff62cf9d5b13408e72-351edcddf20c69da65316dd74d25951e.ssl.cf1` | `h` 臺灣客語（含腔調組合音檔） |

（舊版本文件曾把最後一列誤標為「閩南語」——臺灣的語言代碼對應請一律以
`AGENTS.md` 開頭的語言代碼表為準：`t`=臺灣台語、`h`=臺灣客語。）

遷移只處理「網站實際會請求」的物件（從 pack 資料推導 key 集合直接下載/上傳，
未對 Rackspace 帳號做 bucket listing——當時已無可用的帳號/API 認證）。抽樣結果：
筆畫 JSON 命中率約 36%（多數 Han 字元無筆順資料，如實反映在遷移結果，未強行
補資料）、`a`/客語腔調組合 `.ogg` 命中率 ~100%、台語需先做
`normalizeAudioIdByLang` 補零才能命中；`.mp3`（2019 年後補資料）命中率略低，
台語約 ~53%，華語/客語腔調組合仍接近 100%。

## 補充

- 若未來調整 R2 網域，只需要改 `src/utils/media-cdn.ts` 一處。
- `moedict-app`（Capacitor）透過 `src/offline-api.ts` 共用同一組常數。
