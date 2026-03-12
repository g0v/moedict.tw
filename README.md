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

- `npx tsc -b --pretty false`
- `npm run lint`

## 使用自己的 Cloudflare R2 開發（必看）

本專案啟動前，**必須先將靜態資源與字典資料上傳到自己的 R2**。  
若未上傳，頁面會出現樣式缺失、查詢不到資料或 API 404。

### 1. 前置需求

- Node.js（建議 `>= 20.19`）
- npm
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
npm run build-search-index
```

接著上傳：

```bash
rclone sync data/dictionary/ r2:<your-dictionary-bucket>/ \
  --progress --transfers=16 --checkers=32 --fast-list
```

說明：
- `search-index/` 不是原始資料的一部分，而是由 `npm run build-search-index` 根據 `data/dictionary/*ck/*.txt` 動態產生。
- 專案會使用 `pack/pcck/phck/ptck`，也會讀取 `a/`、`c/` 與根目錄下 `@*.json`、`=*.json` 等檔案。
- 若未先產生 `search-index/` 就直接同步 `data/dictionary/`，正式環境的右上角全文搜尋會缺資料。
- 只上傳部分目錄會導致部首表、分類索引或搜尋功能不完整。
- 全文檢索索引現在會產生在 `data/dictionary/search-index/`，並由 Worker 透過 `/api/search-index/*.json` 從 `DICTIONARY` bucket 讀取。
- 因此部署前除了字典資料本體，也必須把 `search-index/` 一起上傳到 `DICTIONARY` bucket；若漏傳，右上角全文搜尋會失效。

### 5. 建立 `wrangler.jsonc`

本 repo 的範本檔名是 `wrangler.jsonc.examaple`（注意拼字）。

```bash
cp wrangler.jsonc.examaple wrangler.jsonc
```

接著修改以下欄位：

1. `r2_buckets[*].bucket_name`
2. `r2_buckets[*].preview_bucket_name`
3. `vars.ASSET_BASE_URL`
4. `vars.DICTIONARY_BASE_URL`

範例：

```jsonc
{
  "r2_buckets": [
    {
      "binding": "MOEDICT_ASSETS",
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

```bash
npm install
wrangler auth login
npm run dev
```

補充：
- `npm run dev` 與 `npm run build` 會先根據 `data/dictionary/*ck/*.txt` 自動產生 `data/dictionary/search-index/*.json`。
- 這些索引檔不會打包進 Workers assets，避免單一檔案超過 Cloudflare Workers 靜態資產 25 MiB 限制。
- 正式部署前若字典資料有更新，請先執行 `npm run build-search-index`，再執行 `sh commands/upload_dictionary.sh` 上傳最新的 `search-index/`。

部署：

```bash
npm run deploy
# 或
npx wrangler deploy
```

## 補充：現有上傳腳本

- `commands/upload_assets.sh`
- `commands/upload_dictionary.sh`

這兩支腳本可作為參考，但若你使用自訂 bucket 名稱，請先調整腳本中的 bucket 設定，或直接使用上面的 `rclone sync` 指令。
其中 `commands/upload_dictionary.sh` 目前也會一併上傳 `data/dictionary/search-index/`；若沒有先產生該目錄，腳本會提示先執行 `npm run build-search-index`。

## 資料更新提示

若未來要從教育部同步最新資料，建議先閱讀下列三個專案的 `README.md`，確認資料來源、處理流程與產物格式後再進行更新：

- https://github.com/g0v/moedict-webkit
- https://github.com/g0v/moedict-process
- https://github.com/g0v/moedict-data

建議更新順序可先從 `moedict-data`（原始/整理資料）→ `moedict-process`（資料轉換流程）→ `moedict-webkit`（前端與打包整合）開始檢查。
