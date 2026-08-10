# 本專案靜態 CDN 資源清單

本文記錄目前專案程式碼中實際使用的靜態 CDN 資源（含硬編碼與環境變數設定）。

## 一、Cloudflare R2 公開端點

### 1) 筆畫 JSON 與四本字典發音音檔（`src/utils/media-cdn.ts`）

- CDN：`https://r2-assets.moedict.tw`（R2 bucket `moedict-assets`，同 `ASSET_BASE_URL`）
- Key 版面：**MP3 是現行遷移與播放的 canonical 格式**；`playAudioUrl()` 會先試
  `.mp3`，只有 MP3 播放失敗才退回 `.ogg`，見 `audio-utils.ts` 的
  `buildAudioCandidates()`。因此新增/補遷移只需要 MP3；歷史上已存在的 OGG
  物件可以保留，但 OGG 不再是完成或部署的 gate：
  - 筆畫 JSON：**atomic corpus model**（`stroke-corpus/current.json` pointer →
    `stroke-corpora/<corpusDigest>/manifest.json` → `stroke-corpora/<corpusDigest>/stroke-json/{codepoint-hex}.json`，
    4–6 碼小寫十六進位 Unicode codepoint）；不再是扁平 `stroke-json/{hex}.json` key，詳見下方「三、教育部筆順語料管線」
  - 華語／兩岸音檔：`audio/a/{audioId}.mp3`（`c` 沿用同一路由，兩岸詞典無自己的音檔）
  - 台語音檔：`audio/t/{audioId}.mp3`（1–4 碼純數字 id 會補零到 5 碼，見 `normalizeAudioIdByLang`）
  - 客語音檔：`audio/h/{variant}-{audioId}.mp3`（`variant` 為腔調序號 1–6，對應
    `四海大平安南`；客語**沒有**不帶腔調前綴的純 `{audioId}.mp3`，見下方「資料完整性」）
- 使用位置：`src/api/handleStrokeAPI.ts`（Worker 每請求解析 pointer→manifest
  →版本化物件、per-isolate LRU/TTL 快取、白名單+hash 校驗、503 fail-closed；
  解 CORS，ETag 經 `Access-Control-Expose-Headers` 公開；**不再**代理公開
  CDN URL，以利 staging preview 桶隔離）、`src/utils/audio-utils.ts`、
  `src/pages/DictionaryPage.tsx`（`getHakkaVariantAudioUrl`）、
  `src/offline-api.ts`（僅 Capacitor 才啟用；stroke-json GET／HEAD 與 legacy XHR
  請求只改寫到 app 內建的 `/stroke-json/{cp}.json`，本機缺檔即 503 unavailable，
  絕不回退任何遠端 host）、`vite.config.ts`（dev-time 筆畫 JSON proxy，
  仍走公開 CDN `STROKE_JSON_BASE_URL`——僅限本機 `vp dev` 開發用途，與
  Worker/Capacitor 的 runtime 路徑無關）
- **單一定義點**：dev-proxy 用的 `STROKE_JSON_BASE_URL` 仍從
  `src/utils/media-cdn.ts` import；Worker 筆順路由改走 pointer/manifest +
  `env.ASSETS`，Capacitor 離線路由只讀 app 內建檔案，兩者皆不依賴
  `STROKE_JSON_BASE_URL`。

### 2) 前端資產（fonts / JS / CSS）

- 變數：`ASSET_BASE_URL`
- 目前設定（本機）：`https://pub-1808868ac1e14b13abe9e2800cace884.r2.dev`
  （正式站另有自訂網域 `https://r2-assets.moedict.tw`，見上）
- 用途：當 Worker 內建資產找不到時，回退代理 `/assets/*` 請求到此端點；
  來源為 `data/assets/`，經 `commands/upload_assets.sh`（rclone）同步
- 使用位置：`wrangler.jsonc`、`worker/index.ts`

### 2.1) R2 公開 bucket CORS（moedict-assets）

- 命令：
  - 讀取：`bun run wrangler r2 bucket cors list moedict-assets`
  - 寫入：`bun run wrangler r2 bucket cors set moedict-assets --file <path>`
- 目前來源檔：`commands/r2-assets-cors.json`

- 要讓 staging（`ASSET_BASE_URL=https://r2-assets.moedict.tw`）與 production 共用同一套公開 CDN，
  `staging` origin（`https://cf-moedict-webkit-neo-staging.audreyt.workers.dev`）必須被
  `moedict-assets` 的 CORS 白名單允許，才能直接跨來源取用 `r2-assets.moedict.tw` 上的舊版資產。
- R2 CORS 規則變更**不會**令已快取的回應失效。若需清除 `r2-assets.moedict.tw` 自訂網域上的
  CDN 快取，須透過 Cloudflare zone 的「按 URL / hostname 清除快取」功能（需對應 zone 的
  Cache Purge 權限）；**`/api/cache/purge` 不涵蓋此 CDN**——該端點僅清除 Worker
  allowlist 內的 cache tag（`dict-*`、`list`、`search` 等），與 R2 公開 CDN 無關。
  舊快取亦可等待 edge TTL 自然過期。
- 關鍵 title 字型別名 `/assets/fonts/MOEDICT.*?v=20260713-cors` 走 staging Worker 同源路徑
  （`/assets/*` Worker 代理），與 R2 CORS 狀態及 CDN 快取無關。

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
   `stroke-json/<小寫 hex>.json`（本機檔案，未加 digest 前綴），並寫本機
   `manifest.json`（含 sha256／筆畫數）。
3. **Atomic 上傳**（可選，`runAtomicCorpusUpload`）：
   1. 依全部 6,063 個 `hex:sha256` pair 排序後算出 `corpusDigest`
      （sha256）；
   2. 6,063 物件全數 PUT 到
      `stroke-corpora/<corpusDigest>/stroke-json/<hex>.json`（重用
      `scripts/lib/r2-upload.mjs` 的 `uploadWithConcurrency`，≤4 並發；
      upload 路徑 `maxRetries` 預設 5，含 429／code 971／5xx／
      `fetch failed` 等暫態錯誤退避——分類硬化於 commit `42a730f`）與
      `scripts/lib/generated-config.mjs` 的 `getAssetsBucketName`，
      staging → `moedict-assets-preview`、production → `moedict-assets`；
      **絕不覆寫**既有 `corpusDigest` prefix（內容或檔案集一變就是全新
      prefix），無 GC；
   3. 物件全數成功後才寫 `stroke-corpora/<corpusDigest>/manifest.json`
      （full per-file manifest：每檔 `path`／`sha256`／`bytes`）；
   4. authenticated re-GET + sha256／bytes 全量驗證 manifest 本身與每個
      物件（驗證路徑使用 verify-specific 預設
      `DEFAULT_VERIFY_MAX_RETRIES=8`——commit `a8d3262` 起；高於 upload
      的 5，可注入 `opts.maxRetries` 覆寫）；
   5. 只有驗證通過才推進 `stroke-corpus/current.json` pointer——推進前
      先讀舊 pointer（如有）寫入 `scripts/lib/stroke-corpus-state.mjs`
      的本機 rollback history（append-only、atomic temp-then-rename、
      per-env namespaced，供人工查詢舊 digest 以便回滾；**上限
      `MAX_POINTER_HISTORY = 20` 筆**，超出砍最舊、順序不變）。任何步驟
      失敗，pointer **絕不**被觸碰。`readCorpusPointer` 現在與
      `readCorpusManifest`／物件下載共用同一套
      `retryWithBackoff`／`DEFAULT_VERIFY_MAX_RETRIES=8`（NoSuchKey/404
      仍零重試直接視為合法「不存在」）。
      `--upload=staging|production` 時拒絕 `--limit`／`--allow-partial`／
      `--skip-verify`（full-only）。
4. **`--verify-only=staging|production`**（`verifyCorpusOnly`）：**唯一**
   會做全量 6,063 物件 authenticated 重新下載＋hash 驗證的唯讀路徑；讀取
   pointer→manifest→全部物件，重試同上，**無任何寫入**，可安全對正式站桶
   執行。約需 53 分鐘／6,063 物件，**只**由 operator 明確執行——§「部署
   前置閘門」用的是**不同的**輕量檢查（`verifyCorpusReadiness`，只讀
   pointer+manifest，見下）。
5. **上傳必須 operator 序列化（誠實記錄，非 R2 CAS）**：`wrangler r2
object put` 沒有條件式寫入（`--if-match`／ETag-conditional）旗標，R2
   物件 PUT API 本身也沒有等效能力——**絕不能**對同一環境／桶同時跑兩個
   `--upload=<env>`。`runAtomicCorpusUpload` 會在上傳物件開始前先讀一次
   pointer 當基準，`promoteCorpusPointer` 即將 PUT 新 pointer 前再讀一次
   比對 `corpusDigest`；不一致（代表這次上傳期間有另一流程搶先推進了
   pointer）就直接 throw 中止，不寫 rollback history、不 PUT pointer。
   這是**盡力而為的樂觀鎖**：能抓到「另一推進已在上傳期間完成」，抓不到
   「最後一次讀取之後、PUT 之前」那個極短窗口內發生的新推進——那個窗口
   仍是 last-writer-wins。不要把它當成消除競態的保證，operator 序列化
   仍是唯一真正的防線。

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

# 唯讀驗證現行 pointer 指向的語料（不寫入，可對正式站執行）
node commands/sync-moe-stroke-corpus.mjs --verify-only=production \
  --config dist/cf_moedict_webkit_neo/wrangler.json

# 單一國字除錯
node commands/fetch-moe-stroke.mjs 町 汛 --out .moe-stroke-fetch
```

**Worker 讀取路徑**：`/api/stroke-json/{cp}.json` 由 `handleStrokeAPI.ts`
每請求解析 `stroke-corpus/current.json` pointer → 對應
`stroke-corpora/<corpusDigest>/manifest.json`（10 分鐘 per-isolate 快取），
驗證白名單／hash／bytes 後讀取
`stroke-corpora/<corpusDigest>/stroke-json/{cp}.json` 版本化物件並串流
回應——**不再**是扁平 `stroke-json/{hex}.json` key，也**不再**代理公開
`STROKE_JSON_BASE_URL`。pointer／manifest／物件缺失或校驗失敗一律 503
no-store fail-closed。因此 staging Worker 會讀到 preview 桶、production
讀正式桶——上傳到 preview 後可透過 staging 端對端驗證，不會被
`vars.ASSET_BASE_URL` 仍指向正式站公開網域的設定蓋掉。

**邊緣快取 namespace（`worker/index.ts` `dispatch()`）**：`CACHE_PURGE_TOKEN`
是 Worker secret，`promoteCorpusPointer` 以本機 operator CLI 執行、永遠
拿不到它，因此邊緣快取失效不能靠主動清除。改為在來源端固定快取身分：
`/api/stroke-json/*` 的 GET 用內部查詢參數
`__moedict_stroke_digest=<corpusDigest>` 命名 `caches.default` key（僅存在
於傳給 `.match`/`.put` 的合成 `Request`，從不出現在公開 URL／回應／任何
對外標頭），digest 透過 `peekStrokeCorpusDigest`（重用 `handleStrokeAPI`
自己的 per-isolate resolver，零額外 R2 讀取）取得。Pointer 推進＝新
digest＝新的快取 namespace，舊 bare-URL 快取項目在新版 Worker 上線後永遠
讀不到，靠自己的 `s-maxage` 自然過期。Pointer/manifest 解析失敗時直接
略過整個邊緣快取層（不讀不寫），交給 `handleStrokeAPI` 自己的 fail-closed
503（本來就不可快取）。HEAD／`If-None-Match` 條件式語意不受影響，這層
只處理 GET。

**部署前置閘門（LIGHTWEIGHT，不同於 `--verify-only`）**：`bun run
deploy`／`deploy:staging` 鏈中，`release-publish.mjs`（鏈中第一個會
mutate R2 的呼叫）與 `release-deploy.mjs` 在任何 mutating Wrangler 呼叫
之前都各自跑一次語料就緒檢查（`scripts/lib/stroke-corpus-preflight.mjs`
→ `verifyCorpusReadiness`）——**只** authenticated GET pointer＋manifest
兩個物件，**零**筆順物件讀取（整條 deploy 鏈共 4 次讀取），取代逐一
重新下載＋hash 驗證全部 6,063 物件（那需要約 53 分鐘，若 publish 與
deploy 各跑一次則接近 106 分鐘／每次部署，不可行）。驗證內容：
pointer／manifest schema、pointer↔manifest 的 corpusDigest／fileCount／
totalBytes 一致、manifest 自身 totalBytes 與 files[] 加總一致、以及用
manifest 的 files[]（hex＋sha256）重新算一次 corpusDigest 確認自我一致
（manifest 沒有獨立 checksum／ETag 欄位，這個重算值就是它的
self-digest）。語料缺失或任何一項校驗失敗直接 throw，兩腳本內任何
R2/Wrangler mutation 都尚未執行，現行正式站/staging 保持原狀、安全。
**這不是**物件層級完整性驗證的替代品：R2 上每個 stroke-json 物件是否
仍與紀錄的 sha256/bytes 相符，只在 (a) 上傳流程本身（pointer 推進前）
與 (b) operator 明確執行的 `--verify-only` 兩處才會被驗證。

本機產出目錄 `.moe-stroke-corpus/` / `.moe-stroke-fetch/` 已加入 `.gitignore`，
不可 commit 生成的 6063 JSON／zip／manifest。

### 出貨現況（2026-07-13，歷史記錄——扁平 key 模型，已被 atomic corpus model 取代）

> **注意**：以下記錄的是 2026-07-13 當時扁平 `stroke-json/<hex>.json` key
> 模型的出貨事實。當前 runtime 已改為 atomic corpus model（見上方「三、
> 教育部筆順語料管線」），下次語料 pipeline 執行後會產生新的
> `corpusDigest`／pointer／版本化物件記錄，取代本節內容。保留本節僅供
> 歷史追溯。

6,063 字全集已寫入 **兩個** ASSETS 桶的 `stroke-json/<hex>.json`（扁平 key，
歷史記錄），並以 authenticated re-GET + sha256／byte-length 全量驗證：

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

**驗證注意（2026-07-13 當時行為，歷史記錄）：** 當時 `--upload` 模式會在
PUT 完成後**從頭**跑完整 6,063 物件 re-GET 驗證；當時**沒有** verify-only
模式，也**沒有**驗證進度 checkpoint／resume。2026-07-13 production 第一輪
驗證曾因長時間網路中斷（`fetch failed` 重試耗盡於當時預設 5）中止；物件
本身已在桶內且抽樣 hash 正確，第二輪以同一 `manifest.json` 對
`moedict-assets` 重跑全量後 6,063／6,063 通過（約 53 分鐘，concurrency
≤4）。script-only follow-up `a8d3262` 已將 verify 預設 `maxRetries` 提高
到 8（upload 維持 5）。**現況更新**：`--verify-only=staging|production`
（`verifyCorpusOnly`）已實作，見上方「三、教育部筆順語料管線」——唯讀
讀取 pointer→manifest→全部物件並 authenticated 驗證，無任何寫入。仍
沒有 checkpoint／resume（大量重跑仍是從頭開始）。`release-publish.mjs`／
`release-deploy.mjs` 的部署前置閘門改用**輕量**版
`verifyCorpusReadiness`（只讀 pointer+manifest，不下載任何 stroke-json
物件），不再呼叫 `verifyCorpusOnly` 本身——後者只保留給 operator
明確執行的 `--verify-only`（見「部署前置閘門」段落）。

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
