# 本專案靜態 CDN 資源清單

本文記錄目前專案程式碼中實際使用的靜態 CDN 資源（含硬編碼與環境變數設定）。

## 一、Cloudflare R2 公開端點

### 1) 筆畫 JSON 與四本字典發音音檔（`src/utils/media-cdn.ts`）

- CDN：`https://r2-assets.moedict.tw`（R2 bucket `moedict-assets`，同 `ASSET_BASE_URL`）
- Key 版面：**MP3 是現行遷移與播放的 canonical 格式**；`playAudioUrl()` 會先試
  `.mp3`，只有 MP3 播放失敗才退回 `.ogg`，見 `audio-utils.ts` 的
  `buildAudioCandidates()`。因此新增/補遷移只需要 MP3；歷史上已存在的 OGG
  物件可以保留，但 OGG 不再是完成或部署的 gate：
  - 筆畫 JSON：`stroke-json/{codepoint-hex}.json`（4–6 碼小寫十六進位 Unicode codepoint，僅 JSON）
  - 華語／兩岸音檔：`audio/a/{audioId}.mp3`（`c` 沿用同一路由，兩岸詞典無自己的音檔）
  - 台語音檔：`audio/t/{audioId}.mp3`（1–4 碼純數字 id 會補零到 5 碼，見 `normalizeAudioIdByLang`）
  - 客語音檔：`audio/h/{variant}-{audioId}.mp3`（`variant` 為腔調序號 1–6，對應
    `四海大平安南`；客語**沒有**不帶腔調前綴的純 `{audioId}.mp3`，見下方「資料完整性」）
- 使用位置：`src/api/handleStrokeAPI.ts`（Worker 直接讀 ASSETS R2 binding，
  解 CORS；**不再**代理公開 CDN URL，以利 staging preview 桶隔離）、
  `src/utils/audio-utils.ts`、`src/pages/DictionaryPage.tsx`
  （`getHakkaVariantAudioUrl`）、`src/offline-api.ts`（Capacitor 離線 fallback）、
  `vite.config.ts`（dev-time 筆畫 JSON proxy）
- **單一定義點**：音檔 CDN 與離線 fallback 的 `STROKE_JSON_BASE_URL` 仍從
  `src/utils/media-cdn.ts` import；Worker 筆順路由改走 `env.ASSETS`。

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

R2 上的筆畫 JSON 與 MP3 音檔是**一次性遷移**的結果（見下方「已停用」一節），
不是從 pack 資料自動推導/重建。`data/dictionary/{pack,ptck,phck,pcck}` 若因
上游（moedict-data／twblg）同步新增了帶 `audio_id` 的詞條，其對應的
`audio/{lang}/{audioId}.mp3`（或客語的 `audio/h/{variant}-{audioId}.mp3`）
物件**不會自動出現在 R2**——除非重新執行 MP3-only 遷移：

```bash
node commands/migrate-legacy-cdn-to-r2.mjs --extensions=mp3
```

此腳本會重新從 `data/dictionary` 推導 MP3 key 集合，跳過已存在
（`.migration-state/legacy-cdn-progress.ndjson` 記錄的 `ok`/`404`）的物件，
只嘗試新增的部分。歷史 OGG 物件可以繼續留在 R2，但不再為新增資料轉檔或上傳。

客語（`h`）的「純」`{audioId}.mp3`（不帶腔調前綴）在上游從未存在
——`DictionaryPage.tsx` 對 `lang==='h'` 一律不顯示該按鈕，實際播放的是
`{variant}-{audioId}.mp3`，因此遷移腳本刻意不處理這個分類。

筆畫 JSON 的 6,063 字全集回填見下方「教育部筆順語料管線」。

## 三、教育部筆順語料管線（6,063 字）

`stroke-json/` 遷移抽樣結果約 36% 命中（見下方第四節）。這不是隨機資料缺漏，
而是遷移來源（Rackspace CDN，內容承自 g0v/zh-stroke-data）本身只涵蓋教育部
民國 71 年公告的 4808 個常用字。教育部筆順學習網已於 2024-12-27／2025-01-02
全面改版：舊版 `provideStrokeInfo.do?big5=` 端點完全停用，新版網站
（`https://stroke-order.learningweb.moe.edu.tw/`）收字範圍擴充到 6,063 字，
改用 `dictView.jsp?ID=<十進位 Unicode 碼位>`，並把完整筆順 XML 內嵌在頁面的
`xml[<ID>]="...";` JS 字串常值中。

`commands/fetch-moe-stroke.mjs` 提供單一國字的唯讀取得＋轉換工具；
`commands/sync-moe-stroke-corpus.mjs` 是完整 6,063 字語料管線：

1. **發現**：下載官方 `全字筆順提示下載` zip
   （`/download/6063png.zip`），以 PNG 檔名為準取得恰好 6,063 個不重複
   字元（fail-closed：數量／重複／非單一碼位一律中止；**禁止**猜 ID 範圍）。
2. **轉換**：對每個字 `dictView.jsp?ID=<十進位碼位>` → 內嵌 XML →
   `stroke-json/<小寫 hex>.json`，並寫 `manifest.json`（含 sha256／筆畫數）。
3. **上傳**（可選）：重用 `scripts/lib/r2-upload.mjs` 的
   `uploadWithConcurrency`（≤4 並發；upload 路徑 `maxRetries` 預設 5，
   含 429／code 971／5xx／`fetch failed` 等暫態錯誤退避——分類硬化於
   commit `42a730f`）與 `scripts/lib/generated-config.mjs` 的
   `getAssetsBucketName`，staging → `moedict-assets-preview`、
   production → `moedict-assets`。只 PUT `stroke-json/*`，不刪除、
   不覆寫其他 key。
4. **驗證**：上傳後以 `wrangler r2 object get --remote` 逐檔下載並比對
   sha256（二進位 hash，與 `release-verify.mjs` 同款）。**上傳模式禁止
   `--skip-verify`**。驗證路徑使用 verify-specific 預設
   `DEFAULT_VERIFY_MAX_RETRIES=8`（commit `a8d3262` 起；高於 upload 的 5），
   可注入 `opts.maxRetries` 覆寫。

```bash
# 本機 dry-run（不碰 R2）
node commands/sync-moe-stroke-corpus.mjs --dry-run --out .moe-stroke-corpus

# 上傳到 staging preview 桶（需先有 staging build 產生的 generated config）
CLOUDFLARE_ENV=staging node commands/sync-moe-stroke-corpus.mjs \
  --upload=staging --out .moe-stroke-corpus \
  --config dist/cf_moedict_webkit_neo/wrangler.json

# 上傳到 production 桶（需先有 production build 產生的 flattened config，
# bucket_name 必須是 moedict-assets；禁止把 staging config 誤用到 production）
env -u CLOUDFLARE_ENV node commands/sync-moe-stroke-corpus.mjs \
  --upload=production --out .moe-stroke-corpus \
  --config dist/cf_moedict_webkit_neo/wrangler.json

# 單一國字除錯
node commands/fetch-moe-stroke.mjs 町 汛 --out .moe-stroke-fetch
```

**Worker 讀取路徑**：`/api/stroke-json/{cp}.json` 直接讀環境的 `ASSETS` R2
binding（`handleStrokeAPI.ts`），**不再**代理公開 `STROKE_JSON_BASE_URL`。
因此 staging Worker 會讀到 preview 桶、production 讀正式桶——上傳到
preview 後可透過 staging 端對端驗證，不會被 `vars.ASSET_BASE_URL` 仍指向
正式站公開網域的設定蓋掉。

本機產出目錄 `.moe-stroke-corpus/` / `.moe-stroke-fetch/` 已加入 `.gitignore`，
不可 commit 生成的 6063 JSON／zip／manifest。

### 出貨現況（2026-07-13）

6,063 字全集已寫入 **兩個** ASSETS 桶的 `stroke-json/<hex>.json`，並以
authenticated re-GET + sha256／byte-length 全量驗證：

| 環境       | R2 bucket                | 物件數 | 驗證                                   |
| ---------- | ------------------------ | ------ | -------------------------------------- |
| staging    | `moedict-assets-preview` | 6,063  | sha256+bytes 全量 OK                   |
| production | `moedict-assets`         | 6,063  | sha256+bytes 全量 OK（第二輪；見下方） |

對應 runtime 出貨（**已部署 runtime source HEAD `23b7e89`**；本機 pipeline
後續 HEAD 見 git log，含 script-only `a8d3262` 等，**不需再部署 Worker**）：

| 環境       | Worker                          | release                | version UUID                           | %   | finalized                  |
| ---------- | ------------------------------- | ---------------------- | -------------------------------------- | --- | -------------------------- |
| staging    | `cf-moedict-webkit-neo-staging` | `23b7e89-1d1f2400cb1d` | `0f23b628-9373-45d5-8ee9-b7d20b14933b` | 100 | `2026-07-13T04:00:28.202Z` |
| production | `cf-moedict-webkit-neo`         | `23b7e89-1d1f2400cb1d` | `2be488db-8ad7-4384-bc2a-c539b4196445` | 100 | `2026-07-13T06:45:16.967Z` |

Production 部署路徑：`bun run deploy`（`env -u CLOUDFLARE_ENV vp run build &&
release-publish.mjs && release-deploy.mjs`），通過 shared staging-approval
gate（`gitSha=23b7e89`、`clientManifestDigest=1d1f2400cb1d`）。單次
publish→rollout 成功，無 rollback。

**驗證注意（現行行為）：** `--upload` 模式會在 PUT 完成後**從頭**跑完整
6,063 物件 re-GET 驗證；**目前沒有** verify-only 模式，也**沒有**驗證進度
checkpoint／resume。2026-07-13 production 第一輪驗證曾因長時間網路中斷
（`fetch failed` 重試耗盡於當時預設 5）中止；物件本身已在桶內且抽樣 hash
正確，第二輪以同一 `manifest.json` 對 `moedict-assets` 重跑全量後
6,063／6,063 通過（約 53 分鐘，concurrency ≤4）。script-only follow-up
`a8d3262` 已將 verify 預設 `maxRetries` 提高到 8（upload 維持 5）；
**建議後續**（尚未實作，僅 operator 優化）：為 `verifyCorpusUploads` 增加
checkpoint.ndjson 進度與 verify-only／resume 入口，避免網路 flake 時必須
重跑全量。

**不要混淆：** 已部署 runtime source 是 HEAD `23b7e89`；`42a730f`（upload
retry 硬化）與 `a8d3262`（verify maxRetries=8）是其祖先／後續 pipeline
script commits，不是另一個獨立 Worker release。

## 四、已停用：Rackspace CDN（歷史記錄，2026-07 遷移）

### 筆畫 JSON 命中率偏低（~36%）的根因與新版教育部網站再抓取工具

`stroke-json/` 遷移抽樣結果約 36% 命中（見下方第四節）。這不是隨機資料缺漏，
而是遷移來源（`829091573dd46381a321-...rackcdn.com`，內容承自
g0v/zh-stroke-data）本身只涵蓋教育部民國 71 年公告的 4808 個常用字：
g0v/zh-stroke-data 的 `fetch.go` 是呼叫教育部舊版
`provideStrokeInfo.do?big5=<hex>` 端點取得資料，而該端點已隨教育部網站於
2024-12-27／2025-01-02 全面改版而完全停用（連 `一` 這種最基本常用字查詢
也回 404，屬於整個端點退役，並非個別字缺漏）。新版網站
（`https://stroke-order.learningweb.moe.edu.tw/`）收字範圍已擴充到 6,063 字
（2020 年依《國語辭典簡編本》擴充至 6,057，2024 年再依《國語小字典》擴充至
6,063），改用 `dictView.jsp?ID=<十進位 Unicode 碼位>` 呈現，並把完整筆順
XML（格式與舊版逐位元組相同）內嵌在頁面的 `xml[<ID>]="...";` JS 字串常值中。

換言之，這 64% 缺口裡有一部分字（例如「町」U+753A、g0v/moedict-webkit#227；
「汛」U+6C5B、g0v/moedict-webkit#265）其實教育部新版網站**已經有**官方筆順
資料，只是 zh-stroke-data／R2 鏡像從未針對新版擴充字集重新同步過，屬於
資料管線落後於上游改版，而不是教育部完全沒有這些字的資料。

`commands/fetch-moe-stroke.mjs` 提供從新版網站重新取得＋轉換單一國字筆順
資料的工具（唯讀存取教育部網站，只寫本機檔案，**不會**寫入 R2／呼叫
wrangler）：

```bash
node commands/fetch-moe-stroke.mjs 町 汛 --out .moe-stroke-fetch
```

輸出的 `{hex}.json` 與現有 R2 `stroke-json/{hex}.json` schema 完全相同，
可直接餵給 `wrangler r2 object put`（腳本執行後會印出對應指令，但不會自動
執行——實際上傳需要生產環境 R2 憑證，是後續部署步驟，不在此腳本範圍）。
要大規模回填，需要先取得目前 R2 上實際缺漏的字集清單（例如比對
`data/dictionary` 推導出的完整字集 vs. 現有 `stroke-json/` 物件），逐一重跑
本工具，再統一上傳並更新 `.migration-state/`－風格的進度紀錄；本次只針對
「町」「汛」兩字驗證工具本身可行，未執行大規模回填。

以下 4 個 Rackspace Cloud Files 容器（2013 年由 moedict-webkit 上傳，`http-map`
定義於原專案 `main.ls`/`view.ls`）已於 2026-07 透過
`commands/migrate-legacy-cdn-to-r2.mjs` 一次性遷移進上方的 R2 端點，程式碼中
**不再有任何引用**。保留此記錄供未來追查資料來源／重新遷移使用。

| 用途      | 舊 CDN（`*.rackcdn.com`）                                       | 對應語言                       |
| --------- | --------------------------------------------------------------- | ------------------------------ |
| 筆畫 JSON | `829091573dd46381a321-9e8a43b8d3436eaf4353af683c892840.ssl.cf1` | 全部（a/t/h/c 詞條標題）       |
| 音檔      | `203146b5091e8f0aafda-15d41c68795720c6e932125f5ace0c70.ssl.cf1` | `a` 華語（`c` 兩岸沿用）       |
| 音檔      | `1763c5ee9859e0316ed6-db85b55a6a3fbe33f09b9245992383bd.ssl.cf1` | `t` 臺灣台語                   |
| 音檔      | `a7ff62cf9d5b13408e72-351edcddf20c69da65316dd74d25951e.ssl.cf1` | `h` 臺灣客語（含腔調組合音檔） |

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
