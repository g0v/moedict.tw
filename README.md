# moedict.tw

萌典（moedict）前端重構專案，使用 React + TypeScript + Vite，部署於 Cloudflare Workers。

## 社群協作（最需要）

目前最需要的協助是幫忙實測、發現 bug、提出 issue。  
字典牽涉四種語系與多種複雜功能，很多問題必須靠實際跑流才會發現。  
所以想參與協作，不一定要先建立完整開發環境；像啄木鳥一樣持續實測與提報錯誤，也非常有幫助。

- 線上實測頁面：https://dev.moedict.tw/
- 錯誤回報頁面：https://github.com/g0v/moedict.tw/issues

### 回報問題

- 請先確認是否已有相同 issue。
- 問題描述請包含：重現步驟、預期結果、實際結果、截圖（可選）、瀏覽器與作業系統版本。
- 資料相關問題（如部首、詞條、分類）請盡量附上對應詞條與 URL。

### 提交程式碼

- 建議流程：
  1. Fork 專案並開新分支（例如：`fix/radical-qing`、`feat/sidebar-keyboard`）。
  2. 完成修改後送出 Pull Request。
  3. PR 內容請包含：變更摘要、測試方式、風險/相容性說明。

### PR 最低檢查

- `bun run typecheck`
- `bun run lint`

## 使用自己的 Cloudflare R2 開發（必看）

本專案啟動前，**必須先將靜態資源與字典資料上傳到自己的 R2**。  
若未上傳，頁面會出現樣式缺失、查詢不到資料或 API 404。

### 1. 前置需求

- Node.js（建議 `>= 20.19`）
- Bun（含 `bunx`）
- Wrangler CLI
- rclone
- Cloudflare 帳號（可建立 R2 bucket 與 Worker）

### 2. 建立 R2 Buckets

可自訂名稱，以下為範例：

```bash
wrangler r2 bucket create <your-fonts-bucket>
wrangler r2 bucket create <your-fonts-bucket-preview>
wrangler r2 bucket create <your-assets-bucket>
wrangler r2 bucket create <your-assets-bucket-preview>
wrangler r2 bucket create <your-dictionary-bucket>
wrangler r2 bucket create <your-dictionary-bucket-preview>
```

### 3. 設定 rclone（remote 名稱建議 `r2`）

```bash
rclone config
```

完成後可先確認：

```bash
rclone listremotes
```

### 4. 先上傳資料（必要步驟）

#### 4.1 上傳所有靜態資源

```bash
rclone sync data/assets/ r2:<your-assets-bucket>/ \
  --progress --transfers=8 --checkers=16 --fast-list
```

#### 4.2 上傳所有字典資料

請先產生全文檢索索引，再同步整個 `data/dictionary`（不是只傳 `pack`）：

```bash
bun run build-search-index
```

接著上傳：

```bash
rclone sync data/dictionary/ r2:<your-dictionary-bucket>/ \
  --progress --transfers=16 --checkers=32 --fast-list
```

說明：
- `search-index/` 不是原始資料的一部分，而是由 `bun run build-search-index` 根據 `data/dictionary/*ck/*.txt` 動態產生。
- 專案會使用 `pack/pcck/phck/ptck`，也會讀取 `a/`、`c/` 與根目錄下 `@*.json`、`=*.json` 等檔案。
- 若未先產生 `search-index/` 就直接同步 `data/dictionary/`，正式環境的右上角全文搜尋會缺資料。
- 只上傳部分目錄會導致部首表、分類索引或搜尋功能不完整。
- 全文檢索索引現在會產生在 `data/dictionary/search-index/`，並由 Worker 透過 `/api/search-index/*.json` 從 `DICTIONARY` bucket 讀取。
- 因此部署前除了字典資料本體，也必須把 `search-index/` 一起上傳到 `DICTIONARY` bucket；若漏傳，右上角全文搜尋會失效。

### 5. 設定 `wrangler.jsonc`

專案根目錄已附帶 `wrangler.jsonc`，clone 後**不必**再從範本複製。預設已對應 g0v 萌典慣用的 bucket 名稱與公開網域；若你要用**自己的** R2 與網域，請只編輯該檔內：

1. `r2_buckets[*].bucket_name` 與 `preview_bucket_name`（含 `FONTS`、`ASSETS`、`DICTIONARY`）
2. `vars.ASSET_BASE_URL`
3. `vars.DICTIONARY_BASE_URL`

範例（僅示意需替換的欄位；完整結構以 repo 內檔案為準）：

```jsonc
{
  "r2_buckets": [
    {
      "binding": "FONTS",
      "bucket_name": "<your-fonts-bucket>",
      "preview_bucket_name": "<your-fonts-bucket-preview>",
      "remote": true
    },
    {
      "binding": "ASSETS",
      "bucket_name": "<your-assets-bucket>",
      "preview_bucket_name": "<your-assets-bucket-preview>",
      "remote": true
    },
    {
      "binding": "DICTIONARY",
      "bucket_name": "<your-dictionary-bucket>",
      "preview_bucket_name": "<your-dictionary-bucket-preview>",
      "remote": true
    }
  ],
  "vars": {
    "ASSET_BASE_URL": "https://<your-assets-public-domain>",
    "DICTIONARY_BASE_URL": "https://<your-dictionary-public-domain>"
  }
}
```

### 6. 本機啟動與部署

一般前端/互動測試可直接使用本機資料啟動，不必先登入 Cloudflare：

```bash
bun install
bun run dev
```


補充：
- `bun run dev` 會以本機檔案系統提供 `data/assets/`、`data/dictionary/` 與 `data/dictionary/search-index/`，適合日常 UI 與互動除錯。
- 若你需要完整 Cloudflare Worker / R2 預覽環境，再執行：

```bash
wrangler auth login
bun run dev:remote
```

或完整worker預覽：
```bash
wrangler auth login
bun preview
```

- `bun run dev`、`bun run dev:remote` 與 `bun run build` 都會先根據 `data/dictionary/*ck/*.txt` 自動產生 `data/dictionary/search-index/*.json`。
- 這些索引檔不會打包進 Workers assets，避免單一檔案超過 Cloudflare Workers 靜態資產 25 MiB 限制。
- 正式部署前若字典資料有更新，請先執行 `bun run build-search-index`，再執行 `sh commands/upload_dictionary.sh` 上傳最新的 `search-index/`。

部署：

```bash
bun run deploy
# 或
bunx wrangler deploy
```

## 補充：現有上傳腳本

- `commands/upload_assets.sh`
- `commands/upload_dictionary.sh`

這兩支腳本可作為參考，但若你使用自訂 bucket 名稱，請先調整腳本中的 bucket 設定，或直接使用上面的 `rclone sync` 指令。
其中 `commands/upload_dictionary.sh` 目前也會一併上傳 `data/dictionary/search-index/`；若沒有先產生該目錄，腳本會提示先執行 `bun run build-search-index`。

## 資料更新提示

若未來要從教育部同步最新資料，建議先閱讀下列三個專案的 `README.md`，確認資料來源、處理流程與產物格式後再進行更新：

- https://github.com/g0v/moedict-webkit
- https://github.com/g0v/moedict-process
- https://github.com/g0v/moedict-data

建議更新順序可先從 `moedict-data`（原始/整理資料）→ `moedict-process`（資料轉換流程）→ `moedict-webkit`（前端與打包整合）開始檢查。


## 自動測試

```bash
bun run test:unit
```

或用以下程序執行完整測試：

1. 先安裝playwright： 
```bash
bunx playwright install
```

2. 執行：
```bash
bun run test
```

## 匯出閱讀器字典檔（多格式、分語系）

請先區分程式與資料授權：
- 本專案根目錄 `LICENSE` 為 **CC0 1.0 Universal**，適用於本專案自行撰寫的程式碼、腳本與整理流程。
- 字典資料來自上游資料源，不應視為 CC0。特別是中華民國教育部《重編國語辭典修訂本》採 **CC BY-ND 3.0 TW** 創用 CC 授權，散布時需標示來源，且不得局部改作條目。

本腳本的用途是把既有字典資料轉為不同閱讀器可用的格式（如 StarDict 格式 與 Kindle `.mobi`）。若要對外散布產出檔，請依各上游資料來源的授權條款處理；這不是法律意見，若要商業大量散布，建議再由法律專業確認。

### 1) 安裝依賴

```bash
bun install
```

如果只要產生分語系 StarDict 格式：
```SKIP_MOBI=1 bun run build-stardict-html```

如同步要產生 Kindle 格式，另外需安裝其中一種 `.mobi` 轉檔工具：
- `ebook-convert`（Calibre）
- `kindlegen`

安裝方式（擇一）：

```bash
# macOS（Homebrew）
brew install --cask calibre

# Windows（winget）
winget install calibre.calibre

# Windows（Chocolatey）
choco install calibre

# Ubuntu / Debian
sudo apt update
sudo apt install -y calibre
```

安裝後，重開終端機，先確認：

```bash
ebook-convert --version
```

補充：
- `kindlegen` 已停止維護，通常需自行下載舊版二進位檔；若無特殊需求，建議優先使用 `ebook-convert`。
- 若工具不在系統 PATH，可在執行時指定：

```bash
MOBI_CONVERTER=/path/to/ebook-convert bun run build-reader-formats
```

### 2) 產生字典檔（同一腳本輸出多格式）

```bash
bun run build-reader-formats
```

產出路徑（已在 `.gitignore` 排除）：
- StarDict 格式（每語系各三檔）：
  - `build/stardict/a/moedict-a-html.dict`
  - `build/stardict/a/moedict-a-html.idx`
  - `build/stardict/a/moedict-a-html.ifo`
  - `build/stardict/t/moedict-t-html.dict`
  - `build/stardict/t/moedict-t-html.idx`
  - `build/stardict/t/moedict-t-html.ifo`
  - `build/stardict/h/moedict-h-html.dict`
  - `build/stardict/h/moedict-h-html.idx`
  - `build/stardict/h/moedict-h-html.ifo`
  - `build/stardict/c/moedict-c-html.dict`
  - `build/stardict/c/moedict-c-html.idx`
  - `build/stardict/c/moedict-c-html.ifo`
- Kindle 格式 `.mobi`（每語系各一檔）：
  - `build/kindle/a/moedict-a-kindle.mobi`
  - `build/kindle/t/moedict-t-kindle.mobi`
  - `build/kindle/h/moedict-h-kindle.mobi`
  - `build/kindle/c/moedict-c-kindle.mobi`

### 3) 匯入閱讀器

- 有些相容StarDict格式之閱讀器，需要同一組檔案同目錄放置（至少 `.dict + .idx + .ifo`），請依需求選單一語系匯入（`a`/`t`/`h`/`c`）。
- Kindle 請直接使用對應語系的 `.mobi` 檔案匯入。
若目標裝置要求壓縮版，可再自行把 `.dict` 轉為 `.dict.dz`（不影響 `.idx/.ifo` 結構）。