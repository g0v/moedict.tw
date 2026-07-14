# cf-moedict-webkit-neo 專案記憶

## 專案關係

`cf-moedict-webkit-neo` 是 `../moedict-webkit`（原始萌典）的現代化移植版本。

| 原始 (moedict-webkit)                    | Neo (cf-moedict-webkit-neo)                                 |
| ---------------------------------------- | ----------------------------------------------------------- |
| LiveScript + React 0.14 + Gulp + ZappaJS | TypeScript + React 19 + Vite+（Vite 8）+ Cloudflare Workers |
| `main.ls`                                | `src/main.tsx`                                              |
| `view.ls` (767行)                        | `src/pages/` + `src/components/`                            |
| `scripts/Nav.jsx`                        | `src/components/navbar-normal.tsx` ✅ 已移植                |
| `scripts/Links.jsx`                      | 待移植                                                      |
| `scripts/UserPref.jsx`                   | 待移植                                                      |
| `a/`, `t/`, `h/`, `c/` pack 資料         | Cloudflare R2 buckets                                       |

## Vite+ 工具鏈（2026-07）

- `vp` 是 runtime、Bun package manager、Vite/Vitest/Oxlint/Oxfmt 與 task runner
  的統一入口；設定集中在 `vite.config.ts`，lockfile 仍是 `bun.lock`。
- `vp test` 跑 unit + integration 兩個 Vitest project；`vp run test` 再加
  Playwright e2e。unit/integration 的獨立 `vitest.*.config.ts` 已移除。
- 專案的索引重建、`tsc -b` 與 deploy 前置流程仍由 package scripts 保證，
  因此開發/正式 build 用 `vp run dev` / `vp run build`，不要改用不執行
  `predev` / `prebuild` 的 built-in `vp dev` / `vp build`。
- `vp check` 會跑 Oxfmt、全範圍 type-aware Oxlint 與 TypeScript diagnostics；
  `data/**` 等 legacy/vendor 路徑由 formatter 排除，canonical project build
  check 另跑 `vp run typecheck`。

## 參考路徑

- 原始專案：`/Users/bestian/Documents/GitHub/moedict-webkit/`
- Neo 專案：`/Users/bestian/Documents/GitHub/cf-moedict-webkit-neo/`

## 原始專案架構重點

- `main.ls` — 入口，LANG 偵測、HASH-OF 對應（`a:#`, `t:#'`, `h:#:`, `c:#~`）
- `view.ls` — React 視圖，含 Result/Term/Heteronym/Translations/XRefs/Star/List 等元件
- `scripts/Nav.jsx` — 已轉為 JSX 的原始導航列（Bootstrap navbar-inverse）
- `scripts/Links.jsx`, `scripts/UserPref.jsx` — 連結與偏好設定元件

## 語言對應

| lang key | 辭典     | hash prefix | 路由 |
| -------- | -------- | ----------- | ---- |
| `a`      | 華語辭典 | `#`         | `/`  |
| `t`      | 臺灣台語 | `#'`        | `/'` |
| `h`      | 臺灣客語 | `#:`        | `/:` |
| `c`      | 兩岸詞典 | `#~`        | `/~` |

## 目前 neo 元件完成狀態

- `navbar-normal.tsx` — 完整移植，含多層 dropdown、React Router 整合
- `navbar-about.tsx` — 關於頁面 navbar
- `searchbox.tsx` — 搜尋框
- `sidebar.tsx` — 側邊欄
- `ListView.tsx` — 列表視圖（已串接）
- `StrokeAnimation.tsx` — 筆順動畫（已完成）：鉛筆按鈕、canvas 動畫、歷代書體
- Pages: Dictionary-a/c/h/t, About, RadicalView, RadicalDetailView, StarredPage

## 筆順動畫技術細節

- 筆畫 JSON 資料 CDN：已於 2026-07 遷移至 R2（`https://r2-assets.moedict.tw/stroke-json/`），
  見 `src/utils/media-cdn.ts`、`README_CDN.md`。原 Rackspace CDN
  （`stroke-json.moedict.tw` DNS 早已失效）僅存於 README_CDN.md 的歷史記錄。
- 歷代書體 API: `https://www.moedict.tw/api/web/word/{char}` 返回 `.data.strokes[].{key, gif}`
- JS 相依套件（均已在 R2 assets）: jquery.strokeWords.js, raf.min.js, gl-matrix-min.js, sax.js
- 鉛筆按鈕 CSS class: `iconic-circle stroke icon-pencil`，顏色由 `body.lang-{a|c|h|t}` 控制

## data/assets/styles.css 現代化（2026-07）

- 231KB 一行 minified → 重新格式化為 ~13K 行、含 section 註解與 provenance
  header，內容/順序完全不變（每條 rule/at-rule/declaration 逐一驗證過，見
  `vp run check:css-equivalence`）。詳細規則、載入路徑、既有測試盲點見
  AGENTS.md「舊版樣式」一節——不重複記在這裡。
- 決策重點：**沒有**從 `moedict-webkit/sass/*.scss` 重新編譯，因為那條
  pipeline（autoprefixer-core@5、css-mqpacker@3、csswring@3）已凍結十年，
  且 moedict-webkit 自 2015-06-22 起就把 styles.css 排除在 git 之外持續
  獨立改動——重新編譯不會更「現代」，只會重新引入舊工具鏈依賴、且無法保證
  逐條規則對應。改採「原地格式化、原檔即為 source of truth」。
- 新增 `tests/e2e/legacy-styles-regression.spec.ts` 作為視覺零回歸驗證：用
  `page.route()` 讓 CSS 內容可控，比對改動前後的 `getComputedStyle`（逐一
  列舉屬性，不能用 `.cssText`——Chromium 對 computed style 一律回傳空字串）。

## 2026-07-14 共用 checkout / 備份 / patch-id 記錄

- 共用 checkout `/Users/au/w/moedict.tw`（branch `main`，HEAD `af42ebf`）目前仍是 working tree 髒狀態：`13 modified + 5 untracked`。經 `git hash-object` + `git log --find-object` 掃 integration 全歷史做 blob-containment 檢查後，18 個路徑裡有 12 個 `NO_MATCH`；其中包含 `src/api/handleDictionaryAPI.ts`（`KEY_MAP` 新增 `B: "variants"`、direct bucket fill 重構）與 `src/pages/DictionaryPage.tsx`（heteronym `variants?: string[]`、stroke-availability 變更）等未收錄於任何 commit 的獨特內容。這是進行中工作，**不可 stash/reset/clean**。
- 零變動 forensic backup 已放在 `/Users/au/w/backups/moedict-main-dirty-20260714/`：`tracked.patch`（`git diff --binary`）、`untracked/` 五個檔案 byte-exact 副本、`MANIFEST.json`（HEAD sha、porcelain status、每檔 sha256、12 個 `NO_MATCH` 路徑清單）、`README.md`。備份完成後再次驗證 repo `git status --porcelain`，結果 byte-identical 未變。
- `main` 本地 ahead-1 commit `af42ebf` 與 integration 內容 patch-id 等價；`git cherry` 已確認以 `-` 前綴標示，代表 committed 歷史無風險，只有 working tree 保有獨特位元組。
- 處置建議：integration branch 走 PR 合併 `origin/main`，不需要本地 `main` 乾淨；若確認髒工作已放棄，先 commit 到 rescue branch（例如 `wip/cns-variants`）再動 `main`。
