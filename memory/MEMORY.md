# cf-moedict-webkit-neo 專案記憶

## 專案關係

`cf-moedict-webkit-neo` 是 `../moedict-webkit`（原始萌典）的現代化移植版本。

| 原始 (moedict-webkit) | Neo (cf-moedict-webkit-neo) |
|---|---|
| LiveScript + React 0.14 + Gulp + ZappaJS | TypeScript + React 19 + Vite + Cloudflare Workers |
| `main.ls` | `src/main.tsx` |
| `view.ls` (767行) | `src/pages/` + `src/components/` |
| `scripts/Nav.jsx` | `src/components/navbar-normal.tsx` ✅ 已移植 |
| `scripts/Links.jsx` | 待移植 |
| `scripts/UserPref.jsx` | 待移植 |
| `a/`, `t/`, `h/`, `c/` pack 資料 | Cloudflare R2 buckets |

## 參考路徑

- 原始專案：`/Users/bestian/Documents/GitHub/moedict-webkit/`
- Neo 專案：`/Users/bestian/Documents/GitHub/cf-moedict-webkit-neo/`

## 原始專案架構重點

- `main.ls` — 入口，LANG 偵測、HASH-OF 對應（`a:#`, `t:#'`, `h:#:`, `c:#~`）
- `view.ls` — React 視圖，含 Result/Term/Heteronym/Translations/XRefs/Star/List 等元件
- `scripts/Nav.jsx` — 已轉為 JSX 的原始導航列（Bootstrap navbar-inverse）
- `scripts/Links.jsx`, `scripts/UserPref.jsx` — 連結與偏好設定元件

## 語言對應

| lang key | 辭典 | hash prefix | 路由 |
|---|---|---|---|
| `a` | 華語辭典 | `#` | `/` |
| `t` | 臺灣台語 | `#'` | `/'` |
| `h` | 臺灣客語 | `#:` | `/:` |
| `c` | 兩岸詞典 | `#~` | `/~` |

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
  `bun run check:css-equivalence`）。詳細規則、載入路徑、既有測試盲點見
  AGENTS.md「舊版樣式」一節——不重複記在這裡。
- 決策重點：**沒有**從 `moedict-webkit/sass/*.scss` 重新編譯，因為那條
  pipeline（autoprefixer-core@5、css-mqpacker@3、csswring@3）已凍結十年，
  且 moedict-webkit 自 2015-06-22 起就把 styles.css 排除在 git 之外持續
  獨立改動——重新編譯不會更「現代」，只會重新引入舊工具鏈依賴、且無法保證
  逐條規則對應。改採「原地格式化、原檔即為 source of truth」。
- 新增 `tests/e2e/legacy-styles-regression.spec.ts` 作為視覺零回歸驗證：用
  `page.route()` 讓 CSS 內容可控，比對改動前後的 `getComputedStyle`（逐一
  列舉屬性，不能用 `.cssText`——Chromium 對 computed style 一律回傳空字串）。
