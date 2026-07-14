# AGENTS.md — cf-moedict-webkit-neo（moedict.tw）

萌典（moedict）字典查詢網站的現行主站程式碼：React + TypeScript + Vite 前端、
Cloudflare Workers 後端、R2 儲存。本檔是給 AI agent 與新進開發者的工作手冊——
內容以「未來 session 直接可用」為準，改動架構時請同步更新。

## 專案定位（多個 surface，別搞混）

| Surface            | 是什麼                                                   | 原始碼                           |
| ------------------ | -------------------------------------------------------- | -------------------------------- |
| **www.moedict.tw** | 現行主站：本 repo 的 Worker `cf-moedict-webkit-neo` + R2 | 本 repo                          |
| www.moedict.org    | 凍結的舊版靜態前端（GitHub Pages），只收安全性修正       | `~/w/moedict-webkit`（gh-pages） |
| 行動 App           | Capacitor 離線版，資料由本 repo `data/dictionary` 供給   | `~/w/moedict-app`                |

- 裸網域 `moedict.tw` 會 301 到 `www.moedict.tw`——線上驗證一律打 `www`。
- 舊版 `~/w/moedict-webkit` 的 `view.ls` 是 UI 行為的 ground truth：
  移植或修 UI 迴歸時先讀它，不要憑猜測（例：`h1.title` 內的 DOM 順序）。

## 語言代碼（四本字典）

| 代碼 | 字典               | Hash 前綴 | 路由 | pack 目錄 |
| ---- | ------------------ | --------- | ---- | --------- |
| `a`  | 華語（國語辭典）   | `#`       | `/`  | `pack/`   |
| `t`  | 臺灣台語（閩南語） | `#'`      | `/'` | `ptck/`   |
| `h`  | 臺灣客語           | `#:`      | `/:` | `phck/`   |
| `c`  | 兩岸詞典           | `#~`      | `/~` | `pcck/`   |

（舊版 CLAUDE.md 此表有誤，以上為正確對應。）

## 技術棧與目錄結構

- 前端：React 19、TypeScript、Vite+（Vite 8）、react-router-dom v7
- 後端：Cloudflare Workers（`worker/index.ts`，經 `@cloudflare/vite-plugin` 建置）
- 儲存：R2（`FONTS` / `ASSETS` / `DICTIONARY` 三個 binding）
- 工具鏈：**Vite+** 統一 dev/build/test/lint/format/runtime/package-manager 入口；
  `vite.config.ts` 同時持有 Vite、Vitest projects、Oxlint 與 Oxfmt 設定。
- 套件管理：Vite+ 管理的 **Bun**（`vp install`、`vp run <script>`；lockfile
  是 `bun.lock`）。

```
src/
  pages/        # DictionaryPage（核心詞條頁）、Dictionary-a/c/h/t、ListView、
                # RadicalView、RadicalDetailView、StarredPage、About、Privacy
  components/   # Layout、navbar、searchbox、sidebar、StrokeAnimation、
                # CharacterImageView、AssetLoader、InlineStyles、user-pref
  api/          # Worker 端 API handler（handleDictionaryAPI、handleLookupAPI、
                # handleListAPI、cache.ts 快取政策）
  oembed/       # /embed/<詞> 卡片 + /api/oembed
  ssr/          # head.ts（伺服端 <head> 注入）
  hooks/ utils/ # decorateRuby、pinyin 轉換、dictionary-route 等
worker/
  index.ts      # Worker 入口 + dispatch() 路由表
data/
  dictionary/   # 字典資料（真實來源，上傳至 R2；見「字典資料格式」）
  assets/       # 舊版前端資產（styles.css、字型、JS；上傳至 R2）
scripts/        # build-search-index、build-pinyin-lookup、merge-coverage 等
commands/       # upload_dictionary.sh、upload_assets.sh、fetch-moe-stroke.mjs、sync-moe-stroke-corpus.mjs
tests/          # unit / integration / e2e 三層
memory/MEMORY.md  # 跨 session 的架構筆記（與本檔互補）
```

## 常用指令

```bash
vp install                    # 依 devEngines.packageManager 安裝相依
vp run dev                    # predev 重建索引，再啟動 Vite + Miniflare
vp run build                  # prebuild 重建索引、tsc -b，再執行 vp build
vp check                      # Oxfmt + type-aware Oxlint + TS diagnostics
vp run typecheck              # canonical tsc -b --noEmit project build

vp test                       # unit + integration 兩個 Vitest project
vp run test:unit              # happy-dom unit tests
vp run test:integration       # Miniflare 實體 Worker API 測試
vp run test:e2e               # Playwright：chromium project（全部）+ webkit-romanization project（@romanization 聚焦測試）
vp run test:e2e:visual        # 視覺回歸（chromium only；baseline 僅 commit linux 版）
vp run test                   # unit + integration + e2e 三層全跑
vp run test:coverage          # 三層 coverage 合併至 coverage/combined/
```

`vp dev` / `vp build` 是不可覆寫的 Vite+ built-in，不會執行本專案的
`predev` / `prebuild` 與額外的 `tsc -b`；日常開發、正式 build 與部署一律用
`vp run dev` / `vp run build`。Vitest 可直接用 `vp test`；要限定層級則用
`vp run test:unit` / `vp run test:integration`。不要用裸 `bun test`——它不讀
`vite.config.ts` 的 happy-dom、setup、alias 與 project 設定。

## 部署（零停機兩階段 rollout，這是規範不是建議）

**沒有裸 `wrangler deploy` 這條路。** 標準指令一律走安全 orchestrator：

```bash
bun run deploy:staging   # 先 staging：build → 發布 R2 → 兩階段 rollout
# → 自動於 https://cf-moedict-webkit-neo-staging.audreyt.workers.dev 做 0%/100% smoke + 120 秒 probe
bun run deploy           # staging 通過後才部署 production；同樣 build → 發布 R2 → rollout
```

`deploy`/`deploy:staging` 都是「同一次 build 產物」貫穿到底的三段 `&&` 鏈：
`env -u CLOUDFLARE_ENV vp run build && env -u CLOUDFLARE_ENV node scripts/release-publish.mjs && env -u CLOUDFLARE_ENV node scripts/release-deploy.mjs`
（production 每段都用 `env -u CLOUDFLARE_ENV` 明確清掉環境變數，讓 production
絕不會被外層 shell/CI 殘留的 `CLOUDFLARE_ENV=staging` 汙染，fail-closed 而非
沿用繼承值；staging 則是三段各自帶 `CLOUDFLARE_ENV=staging` 前綴。兩者都是
因為 `&&` 串接的每個子命令是各自獨立的行程，環境變數前綴不會跨命令繼承）。
**絕不能在 publish
與 rollout 之間夾第二次 build**——那會讓 `release-deploy.mjs` 內部重新算出的
release manifest／digest 與剛剛實際發布到 R2 的那份不一致。完整協定見
[`notes/零停機部署筆記.md`](./notes/零停機部署筆記.md)。

- **兩階段 rollout**：`release-deploy.mjs` 用 `wrangler versions upload/deploy`
  做 new0%/old100% → 30 秒初始 propagation sleep → override smoke（若只看見
  已知舊版 release，逐路由最多再 poll 6 次、每次 10 秒；非 200、缺/異常標頭或
  第三個 release 立即 fail-closed）→ new100%/old0% → 30 秒初始 propagation
  sleep → ≥120 秒 continuous probe。continuous probe 只允許「已知舊版 release」在
  單一 60 秒 settling grace 內短暫出現；任何舊版 sighting 都會把健康 soak 歸零，
  之後仍必須重新累積完整 ≥120 秒新版健康結果。60 秒 grace 到期後仍看見舊版、或
  遇到非 200、缺/空標頭、第三個 release、網路/timeout，皆立即 fail-closed 並自動
  rollback 回舊版本 100%；通過後 finalize new100%。任一階段失敗絕不留下未 smoke
  的新版一次切到 100%。
- **`CF_VERSION_METADATA` binding**（`wrangler.jsonc` top-level 與
  `env.staging` 都要有、且都不可加 `"type"`）：`.id` 是 Cloudflare 產生的
  version UUID；`.tag` 才是我們自訂的 release ID（`<git-short-sha>-<manifest-digest 前12碼>`），
  兩者不可混用。`X-Moedict-Version` 回應標頭是 `.id`；`X-Moedict-Release`
  是非空 `.tag`。
- **release ID／R2 fallback**：`release-publish.mjs` 把 `dist/client/**` 上傳到
  `releases/<release-id>/`，hashed `assets/**` 另複製一份到全域
  `immutable/assets/`。Worker 的 HTML shell 走
  `SITE_ASSETS → R2 releases/<tag>/index.html → 503 no-store`（絕不回 404）；
  資產走 `SITE_ASSETS → R2 release → R2 immutable → 既有 legacy fallback`。
- **staging → production gate（自動）**：staging 的 `deploy:staging` 在 final
  smoke 通過「當下」自動寫入共用的 staging-approval 狀態
  （git SHA + client manifest digest）；不存在也不需要任何手動
  「儲存 approval」步驟或旗標。production 的 `deploy` 在任何 mutating
  Wrangler 呼叫之前，會核對這個 approval：同一 git SHA、同一 digest、且
  production 自己重建的 digest也要相符，三者缺一失敗，線上不變。
- **`deploy:rollback` / `deploy:rollback:staging`**：真正可執行的緊急復原
  （`scripts/release-rollback.mjs`），不是 stub。用法：
  `CLOUDFLARE_ENV=<env> bun run deploy:rollback -- <known-good-version-uuid>`
  ——**必須明確帶目標 version UUID**，不會自動猜「上一版」。流程：讀目前
  唯一 100% version → 在 `versions list` 找到目標 UUID 的
  `annotations["workers/tag"]` → 部署 `target@100%/current@0%` → 等 30 秒
  edge propagation（過早 probe 會誤判失敗、自動 restore 回壞版本）→ 對固定
  核心路由（`/`、`/api/config`、`/api/%E8%90%8C.json`，刻意不含 hashed
  `/assets/*`，因為 rollback 不依賴任何 build manifest）做 bounded final
  smoke → 通過才 finalize `target@100%` 單獨部署並寫入 env-namespaced
  state；失敗則自動 restore 回 `current@100%/target@0%`，若 restore 也失敗，
  兩個錯誤都會回報。人工緊急指令另見
  [`docs/superpowers/recovery.md`](./docs/superpowers/recovery.md)。
- **`deploy:publish-only` / `deploy:publish-only:staging`**：只 build 一次再
  發布 R2（不做 version rollout），用於單獨驗證 R2 發布或分階段操作。
- Staging 是獨立 Worker（`cf-moedict-webkit-neo-staging`），只有 _.workers.dev
  網址、綁 `moedict-_-preview`R2 桶——**Worker 與 R2 bindings 隔離，但`vars.ASSET_BASE_URL`/`DICTIONARY_BASE_URL` 仍指向正式站公開網址**
（`r2-assets.moedict.tw` 等；`/api/config`與`/assets/\*`fallback 會用到），
所以 staging 無法驗證 preview-assets 桶的公開資產。設定在`wrangler.jsonc`的`env.staging`區塊。
  但目前`moedict-assets`的 CORS 已將
 `https://cf-moedict-webkit-neo-staging.audreyt.workers.dev` 納入白名單（見
  `commands/r2-assets-cors.json`），以允許 staging 直接跨來源取用 `r2-assets.moedict.tw`
  的舊版資產（styles.css 等）。關鍵 title 字型別名走 staging Worker 同源路徑（`/assets/*`
  代理），與 R2 CORS 無關。
- **環境選擇發生在建置期**：`@cloudflare/vite-plugin` 讀 `CLOUDFLARE_ENV`
  環境變數（build 時），不是 `wrangler deploy --env`。這也是為什麼
  `release-publish.mjs`／`release-deploy.mjs` 各自獨立讀
  `process.env.CLOUDFLARE_ENV`，而不是依賴 build 期的 config 重導向。
- **陷阱：generated config 是 build-time 產物**——`release-publish.mjs` 與
  `release-deploy.mjs` 都讀 `dist/cf_moedict_webkit_neo/wrangler.json`
  （由該次 `vp run build` 產生的 flattened config，決定 ASSETS bucket／
  worker name／`targetEnvironment`）。若在兩次不同環境的 build 之間插入其他
  操作、或跳過 build 直接手動跑 `release-publish.mjs`／`release-deploy.mjs`，
  讀到的會是上一次 build 殘留的 config，環境判斷（`getAssetsBucketName`）
  會 fail closed 報錯，而不是靜默用錯 bucket——這是設計如此，出現此錯誤
  代表建置順序有誤，先重新從頭跑 `bun run deploy`/`deploy:staging`。
- Cloudflare 具名環境的繼承規則：`assets`/`cache`/`observability` 可繼承；
  `vars`/`r2_buckets`/`kv_namespaces`/`durable_objects`/`services`/
  `version_metadata` **不可繼承**，必須在 `env.staging` 內重新宣告，否則
  部署出去就是缺 binding（曾因此全站 404）。
- 正式站 Worker secrets：`CACHE_PURGE_TOKEN`、`CLOUDFLARE_API_TOKEN`
  （`wrangler secret list` 可確認存在；值不可讀）。

## R2 buckets 與資料上傳

| Binding    | Production         | Staging/Preview            |
| ---------- | ------------------ | -------------------------- |
| DICTIONARY | moedict-dictionary | moedict-dictionary-preview |
| ASSETS     | moedict-assets     | moedict-assets-preview     |
| FONTS      | moedict-fonts      | moedict-fonts-preview      |

- 正式上傳入口：`sh commands/upload_dictionary.sh`（rclone sync；預設上傳到
  **preview** 桶，正式站要 `R2_BUCKET=moedict-dictionary`）。需要事先設定
  rclone 的 r2 remote；若機器上沒有 rclone 設定，可改用
  `wrangler r2 object put <bucket>/<key> --file=… --remote` 逐檔上傳。
- **速率限制**：Cloudflare API 對 R2 物件操作有全帳號限制（實測約 1100
  req/5min）。大量上傳請控制並發（≤8）、對 429（error code 971）指數退避重試；
  上傳後的驗證 GET 同樣會被限流，驗證程式也要有重試，否則會把 429 誤判成
  內容不一致。
- 只改資料（`data/dictionary/**`）→ 上傳 R2 即可，不必重佈 Worker；
  改到 `src/`、`worker/` 任何程式 → 必須 `bun run deploy` 才會上線（見上方
  「部署」一節的安全 rollout 鏈，不要單獨呼叫 `wrangler deploy`）。
- `data/dictionary/lookup/pinyin/**` 與 `search-index/**` 是**衍生物**，
  由 `scripts/build-pinyin-lookup.mjs`、`build-search-index.mjs` 從 pack 檔重建
  （`predev`/`prebuild` 自動跑）。改 pack 資料後不要手改衍生檔，重建再一起上傳。

## 筆順 JSON（`/api/stroke-json`）與 6,063 字語料管線

- **Runtime 讀取**：`GET`/`HEAD` `/api/stroke-json/<cp>.json` 由
  `src/api/handleStrokeAPI.ts` **直接**讀環境的 `ASSETS` R2 binding key
  `stroke-json/<小寫 hex codepoint>.json`（4–6 碼，含 astral），**不再**代理
  公開 CDN URL。支援 ETag／`If-None-Match` → 304。staging Worker 綁
  `moedict-assets-preview`、production 綁 `moedict-assets`——preview 與 prod
  資料隔離，不會被 `vars.ASSET_BASE_URL` 指到正式站公開網域的設定蓋掉。
- **語料來源**：教育部《國字標準字體筆順學習網》2025 新版
  （`stroke-order.learningweb.moe.edu.tw`）。權威字集是官方
  `全字筆順提示下載` zip（`/download/6063png.zip`）——以 PNG 檔名為準得到
  **恰好 6,063** 個不重複字元；**禁止**猜 ID／Big5 範圍。舊版
  `provideStrokeInfo.do?big5=` 已退役。
- **管線腳本**：
  - `commands/fetch-moe-stroke.mjs` — 單字唯讀：`dictView.jsp?ID=<十進位碼位>`
    → 內嵌 XML → moedict stroke-json schema。
  - `commands/sync-moe-stroke-corpus.mjs` — 全量發現／轉換／manifest／上傳／驗證。
    上傳前必須有對應環境的 flattened generated config
    （`vp run build` 或 `CLOUDFLARE_ENV=staging vp run build` →
    `dist/cf_moedict_webkit_neo/wrangler.json` 的 `ASSETS.bucket_name`）。
- **上傳與驗證守門**：`--upload=staging|production` 時拒絕
  `--limit`／`--allow-partial`／`--skip-verify`（full-only）；上傳後強制
  authenticated re-GET + sha256／bytes 全量比對。並發 ≤4。
  **upload** 暫態重試預設 `maxRetries=5`（`retryWithBackoff`）；**verify**
  預設 `DEFAULT_VERIFY_MAX_RETRIES=8`（長時間 re-GET 較易遇網路 flake）。
  目前**沒有** verify-only／checkpoint resume（建議後續 operator 優化）。
- **本機產物**：`.moe-stroke-corpus/`、`.moe-stroke-fetch/` 已 gitignore，
  **不可** commit 生成 JSON／zip／manifest。細節見 `README_CDN.md` §三。
- **出貨順序**：先 staging 上傳 preview 桶 + `bun run deploy:staging` 驗證 →
  再 production 上傳 `moedict-assets` + `bun run deploy`（approval gate：
  同一 git SHA + client manifest digest）。
- **現行已部署 runtime**（2026-07-13）：release `23b7e89-1d1f2400cb1d`，
  source HEAD `23b7e89`；staging version `0f23b628-9373-45d5-8ee9-b7d20b14933b`
  @100%、production version `2be488db-8ad7-4384-bc2a-c539b4196445` @100%；
  兩桶皆有 6,063 筆 `stroke-json/*` 且全量 hash 驗證 OK。後續 **script-only**
  pipeline 硬化（如 verify maxRetries=8）不需再佈 Worker；完整事實見
  `notes/零停機部署筆記.md` 與 `README_CDN.md`。

## 邊緣快取（src/api/cache.ts）

| 內容              | browser / edge TTL         |
| ----------------- | -------------------------- |
| 詞條 JSON（dict） | 300s / **86400s** + SWR 7d |
| index / lookup    | 60s / 300s                 |
| /api/config       | 60s / 300s（原 no-store）  |
| search-index      | 3600s / 7d                 |
| HTML shell        | 0 / 60s                    |
| 字圖 PNG          | 1d / 1y                    |

- **edge cache 自 2026-07 起才真正生效**：Cloudflare 不會自動快取 Worker 產生的
  回應——`dispatch()`（worker/index.ts）現在對「GET、200、s-maxage>0、非
  text/html、非 no-store/private/Set-Cookie」的回應寫入 `caches.default`，
  命中時帶 `X-Moedict-Edge-Cache: hit` 標頭。在此之前上表的 edge TTL 全是
  裝飾。HTML shell 刻意不進 edge cache（release fallback 正確性依賴現渲染）。
  deploy/rollback probe 一律帶 `_probe` cache-buster，不受影響。
- **R2 讀取另有 per-isolate memo**（帳單稽核 2026-07 後新增）：
  `src/api/r2-json-cache.ts` 對 pack bucket 與 xref/xref-by-id 做 10 分鐘
  LRU memo（WeakMap 以 R2 binding 為 key，單元測試天然隔離）；
  `src/utils/image-generation.ts` 對字型 probe、逐字 glyph SVG（含 negative
  cache——R2 miss 也計費）與 Tauhu fallback 字型做同樣的 per-isolate 快取。
  **資料上傳後**除了 edge TTL 還會多最長 10 分鐘的 memo 延遲。
- 上傳新字典資料後，已被快取的詞條最長 **24 小時**才會自然更新。
- 立即清除：`POST /api/cache/purge`，帶 `CACHE_PURGE_TOKEN`（Bearer 或
  `X-Cache-Purge-Token`），body 用 allowlist 內的 cache tags（如
  `{"tags":["dict-t"]}`）。token 只存在 Worker secret，本機沒有就等 TTL。
- 部署後 60–90 秒內看到舊回應是正常的 edge 殘留（htmlShell s-maxage=60），
  用 cache-buster query 驗證，別急著當成部署失敗。

## 舊版樣式（data/assets/styles.css）

- **已重新格式化為可讀版本**（2026-07；231KB 一行 minified → 分行、加註解）。
  內容是 normalize.css v3.0.2 + Bootstrap 3.4.1（客製化：14pt 基準字級、
  border-radius:0、#6B0000 主色）+ Font Awesome 3.2.1 + moedict 自製
  theme/result/radical/stroke-animation/widget CSS，原始 build 於
  moedict-webkit 的 Gulp pipeline——該 repo 已於 2015-06-22 起把 styles.css
  加進 `.gitignore`（純建置產物、無單一可對應的 commit），且其
  devDependencies（autoprefixer-core@5、css-mqpacker@3、csswring@3）是十年
  未更新的廢棄套件。**故意不從 sass 重建**，改為原地格式化、當作本 repo
  自維護的 vendor 檔案；完整理由見檔案自身開頭的 header comment。
- **重新排版的安全規則**：只能改空白/換行/加註解，**永遠不能重排、合併或
  刪除任何規則/宣告**——cascade 順序是 load-bearing（同一 selector 在檔案
  不同位置出現多次時，後者覆蓋前者是刻意設計，不是重複，見 `src/index.css`
  裡「後載入，需較高特異性」類註解）。改這個檔案前後跑
  `vp run check:css-equivalence [ref]`（預設 `ref=HEAD`）：對 git 某版本做
  **順序敏感**的 AST 結構比對，規則/宣告順序或內容有任何差異就報錯（comment
  不算，不影響渲染）。這是驗證「排版沒動到語意」的工具，不是每次內容修改都要
  跑的 CI gate。
- **CSS lint**：`vp run lint:css`（stylelint + `stylelint.config.mjs`）會原樣列出
  16 個已知、刻意保留的內容層級瑕疵（見檔案 header comment 的完整清單：IE
  `filter:alpha(...)`、殘留的 LESS `fadein()` 呼叫、`speak:none`、
  `background-image:#ddd`、`visibility:visibility`——十年歷史遺留，不影響
  現代瀏覽器渲染，故意不修）+ 2 個重複屬性警告（可能是刻意 fallback，不自動
  合併），所以直接指令預期 exit 2。CI 改跑 `vp run check:css-lint`：只接受
  **恰好**這 16 errors + 2 warnings 的 rule/severity 基準；任何新增、減少、
  rule 或 severity 變動都會 fail，不再用 `continue-on-error` 製造假紅 annotation。
- **這個檔案怎麼載入、以及既有測試為什麼看不到它**：`AssetLoader.tsx`（掛在
  `Layout.tsx`，每頁都跑）優先打 `/api/config` 拿到的絕對網址（正式站是
  `https://r2-assets.moedict.tw`），**直接對該網域發 `<link>` 請求，完全繞過
  本 Worker**；`About.tsx` 自己另一份載入邏輯固定打相對路徑
  `/assets/styles.css`（Worker 代理 fallback）。兩者的 `loadCSS()` 都不會在
  失敗時重試另一條路徑。兩條路徑都附加 `?v=20260711` 查詢參數
  （`LEGACY_STYLESHEET_VERSION`，定義在 `src/utils/media-cdn.ts`）——這是
  一次性快取命名空間，用來繞過 pre-existing 未版本化的 `styles.css` 物件
  （edge 快取 `max-age=86400` / 24h）。**例行後續 data-only 上傳**只需重傳
  R2 物件並設 `Cache-Control: public, max-age=300`（5 分鐘 edge TTL），
  不必重佈 Worker、不必 bump 版本；bump `?v=` 僅用於緊急立即 bust 任何過時
  edge 快取的 stylesheet key（原始未版本化物件的 24h，或前一個 `?v=` 版本
  仍快取在 5 分鐘 TTL）。**既有 Playwright e2e/visual 套件大多測不到這個
  檔案**：測試環境的 `ASSET_BASE_URL` 是假網域 `r2-assets.test.local`，被
  `tests/e2e/_fixtures.ts` 全域擋成 404，`tests/helpers/fixtures.ts` 的
  `collectAssetFixtures()` 也沒把 styles.css 種進 Miniflare 的 ASSETS
  bucket——所以 `visual-snapshots.spec.ts` 的 baseline 全部是在「legacy
  CSS 沒套用」的狀態下拍的。**例外**：`legacy-styles-regression.spec.ts`
  用 `page.route()` 攔截 styles.css（含 `?v=` 查詢版本）並灌入真實 CSS 做差分
  比對；`console-load-errors.spec.ts` 同樣攔截並驗證載入。這兩個 spec 不受上述
  404 限制。其餘既有落差不是本次改動造成，暫不處理（屬於獨立的測試基礎設施
  工作，範圍超出單一 CSS 檔案整理）。
- **驗證新/舊版 styles.css 是否零視覺差異，用
  `tests/e2e/legacy-styles-regression.spec.ts`**（新增，2026-07）：對每個代表
  頁面，用 `page.route()` 攔截上述兩條 styles.css 請求路徑（含 `?v=` 查詢版本），先灌
  `git show <ref>:data/assets/styles.css`、再灌 working tree 版本，比對兩次
  導覽後的 `getComputedStyle`（含 `::before`/`::after`，因為 Font
  Awesome/glyph 類選擇器幾乎全靠 `:before{content}` 呈現——純 PNG 截圖 diff
  對這類內容改動是盲的，且 headless Chromium 截圖在字型抗鋸齒上有已知的微小
  不確定性）。**踩過的坑**：`getComputedStyle(el).cssText` 在 Chromium 對
  computed style 一律回傳空字串（規格如此，只有 inline style 的 `.cssText`
  才有值）——序列化必須用 `for (i < cs.length) cs.getPropertyValue(cs[i])`
  逐一列舉屬性，否則 digest 全程比對到空字串、測試永遠「假通過」（靠正/負
  control 兩組互相驗證才抓到，測試檔內有完整記錄）。跑法：
  `LEGACY_CSS_BASELINE_REF=HEAD E2E_SKIP_BUILD=1 vp exec playwright test
--project=chromium tests/e2e/legacy-styles-regression.spec.ts`（先手動
  `vp run build`，或拿掉 `E2E_SKIP_BUILD=1` 讓它自動 build）。

## 字典資料格式（pack 檔）

- 每個 pack 檔（如 `ptck/100.txt`）是**一行一詞條**的 JSON：首行 `{"key":{…}`、
  後續行 `,"key":{…}`、末行 `}`。程式改寫時保持此格式（`JSON.stringify` 每值
  compact、一 key 一行），可做到 byte-identical round-trip。
- Key 是 JS `escape()` 過的詞目（`%uXXXX`）。分桶公式（`bucketOf`）：
  `a` → `charCodeAt(0) % 1024`；`t/h/c` → `% 128`；astral 字元用低代理減
  `0xDC00`；`@`/`=` 開頭回傳該字元本身（部首表/分類表檔）。
- 欄位是單字母縮寫，對照表在 `src/api/handleDictionaryAPI.ts` 的 `KEY_MAP`：
  `t`=title、`h`=heteronyms、`T`=trs（羅馬字）、`_`=id、`=`=audio_id、
  `d`=definitions、`f`=def、`e`=example、`r`=radical、`c`=stroke_count、
  `n`=non_radical_stroke_count、`D`=dialects（十地區方言音）、`s`/`a`=同/反義。
- **`T` 欄的斜線慣例**：一個 heteronym 的多個讀音以 `/` 相連
  （如 `"tshi̍h/ji̍h"`、`"tsi̍t-ji̍t/tsi̍t-li̍t"`），前端 `decorateRuby()` 會拆出
  主讀音與又音（`bAlt`/`pAlt`）。
- **`ptck` 的 `T` 欄（台語羅馬字）以 NFD 為常態**（分解式，`ê` = `e`+U+0302），
  但上游 twblg CSV 常是 NFC。合併/去重該欄位時一律先 `normalize('NFC')` 做
  canonical 比對，寫回時存 NFD。**此規則由 CI 強制**：`vp run check:data`
  會驗證所有 pack 檔可 JSON.parse、ptck `T` 無 NFC-canonical 重複讀音、
  且每個 segment 都是 NFD。**規則僅限該欄位**：詞目 key、釋義或其他欄位
  未驗證過 normalization 狀態，不要做全域 normalize（會破壞 key 對應）。
- 各 pack 目錄的 `=.txt` 是分類表（2026-07 已修復三份曾為 malformed JSON 的
  檔案；`check:data` 從此把關全部 pack 檔的可解析性）。

## 上游資料管線與現況

```
moedict-data（MOE 原始 dump）→ moedict-process（pack 產生器）
  → data/dictionary/{pack,pcck,phck,ptck,a,c,h,t}/ （commit 進本 repo）
  → scripts/build-{search-index,pinyin-lookup}.mjs → upload_dictionary.sh → R2
```

台語（twblg）補充資料 `moedict-data-twblg/uni/*.csv` 的整合現況（2026-07）：

- `詞目總檔.csv` — **屬性 `2` 的無義項音讀已整合**：若詞目已有 pack 條目，
  追加 `{T, d: [], reading?}` heteronym；`T` 寫成 NFD，不複製 `主編碼`（前端會把
  台語 `_` 當音檔 ID）。主站用文/白/俗/替 badge 標示，並顯示「本音讀無義項」；
  只有無義項、沒有既有 pack 條目的詞目仍只收入 `t/index.json`。
- `又音.csv` — **已整合**（以 `主編碼` 對 heteronym `_` id，append 進 `T` 斜線；
  1365 個 id 中 30 個在 pack 裡無對應詞條，為上游孤兒）。類型 2（俗唸作）、
  3（合音唸作）被扁平化為同一斜線格式，未保留類型標籤。
- `語音方言差.csv` — **部分整合**：42 個詞條已有 `D` 欄，但該表共 406 個字目，
  且 **`D`/dialects 目前沒有任何 UI 會渲染**（暗資料）。補完需要資料合併 + 新 UI。
- `詞彙方言差.csv` — 未整合（整詞的地區替代詞，如 醫院→病院/醫生館，
  以 `詞目` 為鍵，是獨立的新功能）。

## 測試架構重點

- **三層各有職責**：unit（純函式/handler direct-call）、integration
  （Miniflare 真 workerd + 從 `data/dictionary` 播種的 R2 fixtures）、
  e2e（Playwright 真瀏覽器）。**e2e 會抓到 mock 抓不到的錯**
  （binding 名稱、路由、真實 CSS 衝突）——改 Worker 路由或 wrangler 設定時必跑。
- workerd isolate 無法被 vitest 收 coverage，所以 `src/api/**` 與
  `worker/index.ts` 的覆蓋率靠 direct-call unit tests
  （`tests/unit/api-handlers-direct.test.ts`、`worker-dispatch*.test.ts`）。
  **新增 handler 分支時必須同步加 direct-call 測試**，integration 不會動到數字。
- Coverage ratchet：`vite.config.ts` 的 `test.coverage.thresholds` 是**只升不降
  的地板**（目前 100%/100%/100%/100%，全綠）。`/* v8 ignore */` 總數上限
  20（`scripts/check-v8-ignore-count.mjs`）。
- 視覺回歸 baseline 只 commit `*-chromium-linux.png`；darwin/win32 是本機自生。
- `DictionaryPage.tsx`（~950 行）與 `MiddlePoint.tsx` **沒有 unit test**
  （e2e-only 慣例）。變數遮蔽已由 oxlint `no-shadow`（error 級）把關。
- Playwright 的 retries/workers/forbidOnly 跟著 `CI` 環境變數走；只有
  `webServer.reuseExistingServer` 可用 `PW_REUSE_EXISTING_SERVER=1` 單獨
  覆寫（開發 shell 誤設 `CI=1` 時的解法）。
- CI（`.github/workflows/ci.yml`）push 觸發分支是 `main`。static job 依序跑
  lint、typecheck、check-v8-ignore-count、`check:data`、`check:css-ids`、build。

## UI 慣例與結構性防護

以下「地雷」已改為結構性防護——單一定義點 + 測試/CI 把關。動到相關區域時
沿用這些機制，不要繞過：

- **`h1.title` 的 DOM 順序**（ruby → youyin → audioBlock → alternative，
  依 legacy `view.ls:132-158`）：由 `src/components/TitlePronunciation.tsx`
  單點持有（ruby 以 children slot 傳入），順序由
  `tests/unit/title-pronunciation.test.tsx` 鎖定。改順序＝改該元件＋測試。
- **URL 前綴文法**（`'`=t、`:`=h、`~`=c、`@`/`=`/`=*` 家族、`/<數字>` idx）：
  唯一定義在 `src/utils/dictionary-route.ts` 的 `classifyRoute`（頁面/head 分類）
  與 `stripLangPrefix`（語言前綴，API 端加 `{'!': 't'}` legacy 別名）。
  `resolveHeadByPath`、`parseDictionaryRoute`、`parseTextFromUrl`（兩處）與
  client 路由的 `resolveMiddlePointTarget`（`src/utils/middle-point-target.ts`，
  MiddlePoint 的純對應層）都是它的消費者。**新的 parser 一律消費這兩個
  函式，禁止自建 if-chain。**
- **request 路徑的 percent-decode 一律用 `tryDecodeURIComponent`**
  （`dictionary-route.ts`，回 null 不丟例外）——裸呼 `decodeURIComponent`
  遇到 `/api/%` 這類壞編碼會把 URIError 冒成 500（曾在 prod 實測到）。
  呼叫端自選 fallback：fail-closed（回 null/400）或改用未解碼原字串。
- **legacy 遠端樣式 `data/assets/styles.css`** 的 `#id` 選擇器會蓋掉新元件
  （含 Shadow DOM `:host` 預設）：`vp run check:css-ids` 在 CI 把關——
  src 內新增的 id 若撞上 legacy `#id` 選擇器且不在 allowlist 內會 fail；
  要沿用 legacy 樣式就有意識地把 id 加進 allowlist（附註解）。該檔案的完整
  背景（格式化、載入路徑、測試涵蓋範圍）見前面「舊版樣式」一節。
- **標題羅馬拼音選取架構**：可見字形由 `ru[annotation]::before { content: attr(annotation) }`
  以自訂字型繪製（CSS 生成內容，瀏覽器不納入文字選取）；正確 Unicode 文字放在
  `<span class="romanization-selectable" aria-hidden="true">` 疊在同一位置，
  `position: absolute; color: transparent; user-select: text`，讓使用者拖曳即可複製乾淨的
  `huáng`/`tsia̍h`。**`<rt>` 絕對不能在這裡復原**：WebKit 的排版引擎在 ruby-text box
  生成時強制將 `<rt>` 設為 `position: static`，即使作者標記 `!important` 也被覆蓋，
  使 `<rt>` 留在正常 ruby 排版流中，導致 `h1` 高度撐至約 164px，音訊按鈕與羅馬拼音向下
  位移，`huáng` 出現在音訊按鈕之後（Safari #186 regression）。
  普通 `<span>` 則正確繼承 `position: absolute`。`複製羅馬拼音` 按鈕已故意移除（#256）；
  `aria-hidden` 防止螢幕閱讀器重複播報（`ru[annotation]::before` 已被 AT 納入 accessible name 計算）。
  zhuyin/none phonetics 偏好設定下以 CSS `display: none` 隱藏 span，防止不可見字形被意外選取。
  守護測試：`tests/e2e/dictionary.spec.ts` 的三個 `@romanization` describe blocks
  （Taigi selection/copy、Mandarin selection、overlay geometry regression）同時跑
  Chromium（chromium project）與 WebKit（webkit-romanization project，
  `playwright test --project=webkit-romanization`）；
  包含真實指標拖曳、caretRangeFromPoint、ARIA 播報、幾何不變量與 phonetics 偏好測試。
- 詞條頁資料流：client 打 `/api/{前綴}{詞}.json` → Worker `fillBucket` 讀
  R2 `p{lang}ck/{bucket}.txt` → 取單一 key 回傳。`/{a,t,h,c,raw,uni,pua}/<詞>.json`
  是對外公開 API（README 有文件），改格式要顧慮外部消費者。

## 開發慣例

- **這個 repo 常有多個 agent/人並行工作**。working tree 出現非自己的變更是常態：
  視為他人工作、不要動；commit 時**只 stage 自己改的路徑**，永遠不要 `git add -A`。
- Commit 前綴慣例 `fix:`/`feat:`。`main` 設有 branch protection（要求 PR 與
  簽章）；除非使用者明確指示直接推送且你的憑證可過，否則走 PR。
  大改動先在 worktree 分支做完再合。
- Commit message 含反引號時用 `git commit -F <file>`（heredoc 會觸發指令替換）。
- git 對非 ASCII 檔名輸出八進位跳脫——grep CJK 檔名會 silent miss，
  用 `git -c core.quotePath=false` 或 `-z`。
- **typescript 在 7.x（Go 原生編譯器）**，lint 走 Vite+ 內建 Oxlint；
  設定集中在 `vite.config.ts` 的 `lint` block，舊 `.oxlintrc.json` 已移除。
  背景：TypeScript 7 已於 2026-07 GA，但 typescript-eslint 的
  typescript-estree 仍卡在 peer `typescript <6.1.0`，裝上 7.x 會直接崩潰
  （`Cannot read properties of undefined (reading 'Cjs')`）——兩者不能並存，
  這也是 2026-07 從 eslint 遷移到 Oxlint 的直接原因。`vp check` 會對所有 lint
  範圍執行 type-aware Oxlint 與實驗性 TypeScript diagnostics；正式 project
  reference 的 canonical build check 仍獨立走 `vp run typecheck`
  （`tsc -b --noEmit`）。Oxfmt 也由 `vp check` 執行；`fmt.ignorePatterns` 排除
  `data/**`、build/coverage 輸出與 worktrees，因此 legacy/vendor 資產不會被
  formatter 重寫。
- Oxlint 零設定預設值已涵蓋原本 `js.configs.recommended` +
  `tseslint.configs.recommended` 的完整規則集；`vite.config.ts` 的 `lint.rules`
  只列出預設關閉、需要手動打開的規則（含 no-var/prefer-const/
  no-explicit-any 等），加上兩條本專案自訂規則（`no-shadow`、`_`-prefix
  `no-unused-vars`）與 React 對應項（`react/rules-of-hooks`、
  `react/exhaustive-deps`、`react/only-export-components`）。跨 plugin 同名規則
  一律用 `<plugin>/<rule>` 前綴消歧義。既有的 `// eslint-disable-next-line
<rule>` 註解 Oxlint 會自動識別並比對；新寫的一律用
  `// oxlint-disable-next-line <rule>`（多行說明時，disable 指令必須是緊接在
  程式碼前的最後一行註解，見 `scripts/build-pinyin-lookup.mjs` 範例）。
- **Type-aware lint（`oxlint-tsgolint`，需 TS 7+）預設啟用**：
  `vite.config.ts` 的 `lint.options.typeAware` 與 `typeCheck` 都是 `true`，
  所以 `vp lint`／`vp check` 會同時檢查 `src`、`worker`、tests、scripts 與
  Playwright 設定。啟用時已修完 tests/tooling 的 TypeScript diagnostics；
  tests 雖不屬於 `tsc -b` leaf project，仍由 Vite+ 的逐檔 diagnostics 把關。
  2026-07 已把當時約 43 個建議級（warn）發現逐條判斷修完，`vp lint` 現在乾淨：
  navigation 的 fire-and-forget `navigate()` 補上明確 `void`、`AssetLoader`
  補上真正的 `.catch`、兩處 `getCORSHeaders` 回傳型別收斂為
  `Record<string, string>`、`no-base-to-string` 的來源改用明確型別窄化（有
  對應單元測試涵蓋新分支），monkey-patch 的 unbound-method 則附理由的
  `oxlint-disable-next-line`。往後新出現的 type-aware 發現仍須逐條判斷，
  不能批次加 `void` 或 disable 掩蓋。

## 授權紅線

- **本 repo 程式碼**：CC0 1.0（見 `LICENSE`）。
- **辭典內容**（MOE 資料）：**CC BY-ND 3.0 TW**——禁止改作。內容修正只能
  回報上游（dict.revised.moe.edu.tw／sutian.moe.edu.tw），不能在資料層自行改寫釋義。
- **`revised-dict.woff`**（教育部 PUA 變體字頭字型）：MOE **未另行公布字型授權**；
  本專案在 owner 明確承擔風險下**原封不動**託管（見 `src/index.css:39-50` 與
  `public/fonts/revised-dict.LICENSE.txt`）。專案政策：**不可 subset、不可轉 WOFF2**、
  不可任何再編碼——保持原檔 byte-identical。
- 字圖 PNG 產生器的 fallback 字型 Tauhu Oo（豆腐烏，**SIL OFL 1.1**，
  `data/assets/fonts/`）授權乾淨，可自由處理。

## 延伸參考

- `memory/MEMORY.md` — 跨 session 架構筆記（新舊版對照、CDN 位址等）
- `README.md` — 對外文件（公開 API 端點列表）
- `README_CDN.md` — R2／CDN 版面、筆順 6,063 字語料管線與出貨現況
- `notes/零停機部署筆記.md` — 零停機部署操作手冊與出貨 checklist
- `~/w/moedict-webkit/view.ls` — 舊版 UI 行為的 ground truth
- `台語羅馬拼音索引施工計畫.md` — pinyin lookup 索引的設計文件
