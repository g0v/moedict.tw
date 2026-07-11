# AGENTS.md — cf-moedict-webkit-neo（moedict.tw）

萌典（moedict）字典查詢網站的現行主站程式碼：React + TypeScript + Vite 前端、
Cloudflare Workers 後端、R2 儲存。本檔是給 AI agent 與新進開發者的工作手冊——
內容以「未來 session 直接可用」為準，改動架構時請同步更新。

## 專案定位（多個 surface，別搞混）

| Surface | 是什麼 | 原始碼 |
|---|---|---|
| **www.moedict.tw** | 現行主站：本 repo 的 Worker `cf-moedict-webkit-neo` + R2 | 本 repo |
| www.moedict.org | 凍結的舊版靜態前端（GitHub Pages），只收安全性修正 | `~/w/moedict-webkit`（gh-pages） |
| 行動 App | Capacitor 離線版，資料由本 repo `data/dictionary` 供給 | `~/w/moedict-app` |

- 裸網域 `moedict.tw` 會 301 到 `www.moedict.tw`——線上驗證一律打 `www`。
- 舊版 `~/w/moedict-webkit` 的 `view.ls` 是 UI 行為的 ground truth：
  移植或修 UI 迴歸時先讀它，不要憑猜測（例：`h1.title` 內的 DOM 順序）。

## 語言代碼（四本字典）

| 代碼 | 字典 | Hash 前綴 | 路由 | pack 目錄 |
|---|---|---|---|---|
| `a` | 華語（國語辭典） | `#`  | `/`  | `pack/` |
| `t` | 臺灣台語（閩南語） | `#'` | `/'` | `ptck/` |
| `h` | 臺灣客語 | `#:` | `/:` | `phck/` |
| `c` | 兩岸詞典 | `#~` | `/~` | `pcck/` |

（舊版 CLAUDE.md 此表有誤，以上為正確對應。）

## 技術棧與目錄結構

- 前端：React 19、TypeScript、Vite、react-router-dom v7
- 後端：Cloudflare Workers（`worker/index.ts`，經 `@cloudflare/vite-plugin` 建置）
- 儲存：R2（`FONTS` / `ASSETS` / `DICTIONARY` 三個 binding）
- 套件管理：**Bun**（`bun install`、`bun run <script>`；lockfile 是 `bun.lock`）

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
commands/       # upload_dictionary.sh、upload_assets.sh
tests/          # unit / integration / e2e 三層
memory/MEMORY.md  # 跨 session 的架構筆記（與本檔互補）
```

## 常用指令

```bash
bun install                # 安裝相依
bun run dev                # 本地開發（vite + miniflare；predev 會先重建索引）
bun run build              # tsc -b && vite build（prebuild 會重建索引）
bun run typecheck          # tsc -b --noEmit
bun run lint               # ESLint（見「已知問題」——目前可能整庫崩潰）

bun run test:unit          # Vitest + happy-dom
bun run test:integration   # Miniflare 實體 worker API 測試（fixtures 來自 data/dictionary）
bun run test:e2e           # Playwright（chromium project）
bun run test:e2e:visual    # 視覺回歸（baseline 僅 commit linux 版）
bun run test               # 三層全跑
bun run test:coverage      # 三層 coverage 合併至 coverage/combined/
```

**測試一定走 `bun run test:unit`（Vitest），不能用裸 `bun test`**——後者沒有
happy-dom 環境（`window is not defined`）也沒有本專案的 alias/setup。
`bun test` 遷移被 oven-sh/bun#16140（缺 `vi.resetModules`）擋住。

## 部署（staging-first，這是規範不是建議）

```bash
bun run deploy:staging   # CLOUDFLARE_ENV=staging bun run build && wrangler deploy
# → 在 https://cf-moedict-webkit-neo-staging.audreyt.workers.dev 驗證
bun run deploy           # 驗證通過後才部署 production
```

- Staging 是獨立 Worker（`cf-moedict-webkit-neo-staging`），只有 *.workers.dev
  網址、綁 `moedict-*-preview` R2 桶——**Worker 與 R2 bindings 隔離，但
  `vars.ASSET_BASE_URL`/`DICTIONARY_BASE_URL` 仍指向正式站公開網址**
  （`r2-assets.moedict.tw` 等；`/api/config` 與 `/assets/*` fallback 會用到），
  所以 staging 無法驗證 preview-assets 桶的公開資產。設定在 `wrangler.jsonc`
  的 `env.staging` 區塊。
- **環境選擇發生在建置期**：`@cloudflare/vite-plugin` 讀 `CLOUDFLARE_ENV`
  環境變數（build 時），不是 `wrangler deploy --env`。
- **陷阱**：`.wrangler/deploy/config.json` 重導向永遠指向「最後一次 build」的
  產物。跑完 `deploy:staging` 後直接裸打 `wrangler deploy` 會**再部署一次
  staging**，不是 prod。所以一律用 `bun run deploy` / `bun run deploy:staging`
  （它們都會先重新 build，把重導向翻回正確環境）。
- Cloudflare 具名環境的繼承規則：`assets`/`cache`/`observability` 可繼承；
  `vars`/`r2_buckets`/`kv_namespaces`/`durable_objects`/`services` **不可繼承**，
  必須在 `env.staging` 內重新宣告，否則部署出去就是缺 binding（曾因此全站 404）。
- 正式站 Worker secrets：`CACHE_PURGE_TOKEN`、`CLOUDFLARE_API_TOKEN`
  （`wrangler secret list` 可確認存在；值不可讀）。

## R2 buckets 與資料上傳

| Binding | Production | Staging/Preview |
|---|---|---|
| DICTIONARY | moedict-dictionary | moedict-dictionary-preview |
| ASSETS | moedict-assets | moedict-assets-preview |
| FONTS | moedict-fonts | moedict-fonts-preview |

- 正式上傳入口：`sh commands/upload_dictionary.sh`（rclone sync；預設上傳到
  **preview** 桶，正式站要 `R2_BUCKET=moedict-dictionary`）。需要事先設定
  rclone 的 r2 remote；若機器上沒有 rclone 設定，可改用
  `wrangler r2 object put <bucket>/<key> --file=… --remote` 逐檔上傳。
- **速率限制**：Cloudflare API 對 R2 物件操作有全帳號限制（實測約 1100
  req/5min）。大量上傳請控制並發（≤8）、對 429（error code 971）指數退避重試；
  上傳後的驗證 GET 同樣會被限流，驗證程式也要有重試，否則會把 429 誤判成
  內容不一致。
- 只改資料（`data/dictionary/**`）→ 上傳 R2 即可，不必重佈 Worker；
  改到 `src/`、`worker/` 任何程式 → 必須 `bun run deploy` 才會上線。
- `data/dictionary/lookup/pinyin/**` 與 `search-index/**` 是**衍生物**，
  由 `scripts/build-pinyin-lookup.mjs`、`build-search-index.mjs` 從 pack 檔重建
  （`predev`/`prebuild` 自動跑）。改 pack 資料後不要手改衍生檔，重建再一起上傳。

## 邊緣快取（src/api/cache.ts）

| 內容 | browser / edge TTL |
|---|---|
| 詞條 JSON（dict） | 300s / **86400s** + SWR 7d |
| index / lookup | 60s / 300s |
| search-index | 3600s / 7d |
| HTML shell | 0 / 60s |
| 字圖 PNG | 1d / 1y |

- 上傳新字典資料後，已被快取的詞條最長 **24 小時**才會自然更新。
- 立即清除：`POST /api/cache/purge`，帶 `CACHE_PURGE_TOKEN`（Bearer 或
  `X-Cache-Purge-Token`），body 用 allowlist 內的 cache tags（如
  `{"tags":["dict-t"]}`）。token 只存在 Worker secret，本機沒有就等 TTL。
- 部署後 60–90 秒內看到舊回應是正常的 edge 殘留（htmlShell s-maxage=60），
  用 cache-buster query 驗證，別急著當成部署失敗。

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
- **`ptck` 的 `T` 欄（台語羅馬字）以 NFD 為常態**（分解式，`ê` = `e`+U+0302；
  已實測 1.7 萬筆），但上游 twblg CSV 常是 NFC。合併/去重該欄位時一律先
  `normalize('NFC')` 做 canonical 比對，寫回時配合既有內容存 NFD——否則會產生
  「看起來一樣其實 byte 不同」的重複讀音，並污染 pinyin lookup 索引。
  **此規則僅限該欄位**：詞目 key、釋義或其他字典欄位未驗證過 normalization
  狀態，不要做全域 normalize（會破壞 key 對應與 byte-level diff）。
- 各 pack 目錄的 `=.txt` 是分類表；其中 `pack/`、`pcck/`、`ptck/` 的檔案
  JSON 格式異常（`{,"key"…` 開頭，`phck/` 的正常）——批次解析 pack 檔時要容錯跳過。

## 上游資料管線與現況

```
moedict-data（MOE 原始 dump）→ moedict-process（pack 產生器）
  → data/dictionary/{pack,pcck,phck,ptck,a,c,h,t}/ （commit 進本 repo）
  → scripts/build-{search-index,pinyin-lookup}.mjs → upload_dictionary.sh → R2
```

台語（twblg）補充資料 `moedict-data-twblg/uni/*.csv` 的整合現況（2026-07）：

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
- Coverage ratchet：`vitest.unit.config.ts` 的 thresholds 是**只升不降的地板**。
  `/* v8 ignore */` 總數上限 20（`scripts/check-v8-ignore-count.mjs`）。
- 視覺回歸 baseline 只 commit `*-chromium-linux.png`；darwin/win32 是本機自生。
- `DictionaryPage.tsx`（~950 行）與 `MiddlePoint.tsx` **沒有 unit test**
  （e2e-only 慣例）——在大型 render 函式內改動時特別小心變數遮蔽
  （曾有 prop 被同名 `map((x, idx)` 參數遮蔽的實例）。
- Shell 環境若已設 `CI=1`，Playwright 會關掉 reuseExistingServer——
  本機看到大量 e2e 失敗先檢查這個，再懷疑程式。

## UI 慣例與已知地雷

- **`h1.title` 內的 DOM 順序固定為**：ruby → `small.youyin` → `span.audioBlock`
  → `small.alternative`（依 legacy `view.ls:132-158`）。`.alternative` 內的
  `.pinyin`/`.bopomofo` 是 block-level（遠端 legacy CSS），插錯位置會把
  播放鍵擠下去——已踩過一次。
- 全站仍載入**遠端 legacy 樣式** `data/assets/styles.css`（Bootstrap 3 時代）。
  它會用 id/class 選擇器蓋掉你的元件樣式（含 Shadow DOM `:host` 預設）。
  **新元件不要沿用舊版元素的 id**，改樣式前先 grep 這支檔案。
- **同一 URL 規則有兩個獨立 parser**：`src/utils/dictionary-route.ts`
  （`parseDictionaryRoute`，client + worker 路由）與 `src/ssr/head.ts`
  （`resolveHeadByPath` 的 `toSegment`，伺服端 `<head>`）。改路由語意時
  **兩處都要改**，並 grep 其他 parser 形狀的函式（`parseX`/`resolveX`/`toSegment`）。
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
- `bun run lint` 目前整庫崩潰（typescript 7 beta 與 typescript-eslint 相容性，
  `TypeError … 'Cjs'`）——不是你弄壞的；靜態檢查用 `bun run typecheck` 頂替，
  等相依版本和解後移除本條。

## 授權紅線

- **本 repo 程式碼**：CC0 1.0（見 `LICENSE`）。
- **辭典內容**（MOE 資料）：**CC BY-ND 3.0 TW**——禁止改作。內容修正只能
  回報上游（dict.revised.moe.edu.tw／sutian.moe.edu.tw），不能在資料層自行改寫釋義。
- **`revised-dict.woff`**（教育部 PUA 變體字頭字型）：MOE **未另行公布字型授權**；
  本專案在 owner 明確承擔風險下**原封不動**託管（見 `src/index.css:39-50` 與
  `revised-dict.LICENSE.txt`）。專案政策：**不可 subset、不可轉 WOFF2**、
  不可任何再編碼——保持原檔 byte-identical。
- 字圖 PNG 產生器的 fallback 字型 Tauhu Oo（豆腐烏，**SIL OFL 1.1**，
  `data/assets/fonts/`）授權乾淨，可自由處理。

## 延伸參考

- `memory/MEMORY.md` — 跨 session 架構筆記（新舊版對照、CDN 位址等）
- `README.md` — 對外文件（公開 API 端點列表）
- `~/w/moedict-webkit/view.ls` — 舊版 UI 行為的 ground truth
- `台語羅馬拼音索引施工計畫.md` — pinyin lookup 索引的設計文件
