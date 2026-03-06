# cf-moedict-webkit-neo

萌典（moedict）前端重構專案，使用 React + TypeScript + Vite，部署於 Cloudflare Workers。

## 社群協作（最需要）

目前最需要的協助是幫忙實測、發現 bug、提出 issue。  
字典牽涉四種語系與多種複雜功能，很多問題必須靠實際跑流才會發現。  
所以想參與協作，不一定要先建立完整開發環境；像啄木鳥一樣持續實測與提報錯誤，也非常有幫助。

- 線上實測頁面：https://dev.moedict.tw/
- 錯誤回報頁面：https://github.com/g0v/cf-moedict-webkit-neo/issues

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

請同步整個 `data/dictionary`（不是只傳 `pack`）：

```bash
rclone sync data/dictionary/ r2:<your-dictionary-bucket>/ \
  --progress --transfers=16 --checkers=32 --fast-list
```

說明：
- 專案會使用 `pack/pcck/phck/ptck`，也會讀取 `a/`、`c/` 與根目錄下 `@*.json`、`=*.json` 等檔案。
- 只上傳部分目錄會導致部首表、分類索引或搜尋功能不完整。

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
