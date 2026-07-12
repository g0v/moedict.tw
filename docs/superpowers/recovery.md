# 零停機部署 — 人工復原手冊

> **適用對象：** 值班操作者。**適用時機：** `bun run deploy` / `deploy:staging` /
> `deploy:rollback` 自動流程本身失敗、卡住，或需要在自動流程之外先行診斷。
> **原則：** 先讀（唯讀指令），後動（mutating 指令）。每一步先確認證據，
> 再決定下一步；不要用猜測代替 `versions list` / `deployments list` 的真實輸出。
>
> 本文所有 `<...>` 都是**明確 placeholder**，執行前必須替換成實際值。
> **絕不**在此文件、shell history 或 log 中寫入 token、account ID 或任何 secret。
> **絕不**建議或執行裸 `wrangler deploy`——那是 atomic cutover，沒有本協議的
> 安全 gate。一律用專案 wrapper `vp exec wrangler`，並使用**建置後的
> generated config**（`dist/cf_moedict_webkit_neo/wrangler.json`），不要用
> 手寫的 `wrangler.jsonc` 路徑（會少掉 flatten 後的實際 bucket/環境值）。

## 0. 先試自動路徑

`scripts/release-rollback.mjs`（`bun run deploy:rollback` /
`bun run deploy:rollback:staging`）已經是真正可執行、有 smoke + 自動 restore
的復原指令，不是 stub——多數情況應先用它，而不是跳過去手動操作：

```bash
# 需要明確帶目標 version UUID（不會自動猜「上一版」）。deploy:rollback 內部
# 對每段指令前綴 `env -u CLOUDFLARE_ENV`，即使呼叫者的 shell 殘留
# CLOUDFLARE_ENV=staging 也一定作用在 production，fail-closed，不需要（也不應該）
# 再手動加 CLOUDFLARE_ENV=production。
bun run deploy:rollback -- <known-good-version-uuid>

# staging 明確帶 CLOUDFLARE_ENV=staging（deploy:rollback:staging 已內建）：
bun run deploy:rollback:staging -- <known-good-version-uuid>
```

它會：讀目前唯一 100% version → 在 `versions list` 找到目標 UUID 的
`annotations["workers/tag"]`（找不到或非唯一則直接拒絕）→ 部署
`target@100%/current@0%` → 對 `/`、`/api/config`、`/api/%E8%90%8C.json` 三條
固定核心路由（刻意不含 hashed `/assets/*`，因為 rollback 不依賴任何 build
manifest）做 bounded final smoke → 通過才 finalize `target@100%` 單獨部署；
失敗則自動 restore 回 `current@100%/target@0%`，兩個錯誤（smoke + restore）
都會回報。**只有在這個自動路徑本身也失敗、或找不到已知安全的 target UUID
時**，才進入以下人工步驟。

## 1. 唯讀診斷（不改變任何線上狀態）

### 1.1 確認登入身份與目前 version/deployment

```bash
vp exec wrangler whoami
vp exec wrangler versions list --config <generated-config> --name <worker-name> --json
vp exec wrangler deployments list --config <generated-config> --name <worker-name> --json
```

- `<generated-config>` = `dist/cf_moedict_webkit_neo/wrangler.json`（該次
  `vp run build` 的產物；若不存在，先 `vp run build` 一次再回來讀，不要
  跳過這步直接猜 bucket/worker 名稱）。
- `<worker-name>` production 是 `cf-moedict-webkit-neo`，staging 是
  `cf-moedict-webkit-neo-staging`。
- `deployments list --json` 的每個 entry 是
  `{ version_id, percentage }` 陣列；**正常狀態應該正好一筆 100%**。若看到
  兩筆都非 0%（split 狀態），先不要動，往下看第 2 節判斷成因。
- `versions list --json` 的每筆 entry 有 `id`（version UUID）與
  `annotations["workers/tag"]`（我們自訂的 release ID）——**沒有頂層 `tag`
  欄位**，release ID 只在 `annotations` 裡；不要用 `id` 當成 release ID
  對照文件或 log。

### 1.2 用回應標頭確認目前線上實際狀態

```bash
curl -sS -D - -o /dev/null 'https://www.moedict.tw/?release-debug=1'
```

- `X-Moedict-Version`：目前 Cloudflare version UUID，應與
  `deployments list` 顯示的 100% version 一致。
- `X-Moedict-Release`：目前 release ID（`annotations["workers/tag"]`）；
  缺失代表該 version 沒帶 `CF_VERSION_METADATA` 的 tag（可能是舊 version，
  或 metadata binding 本身有問題）。
- 若這裡看到的 version UUID 跟 `deployments list` 對不上，先信任
  `deployments list`（Wrangler API 的即時狀態），`curl` 結果可能受 edge
  快取（`s-maxage=60`）影響而落後 60 秒內。

### 1.3 R2 release 物件是否存在（rollback 目標版本需要）

```bash
vp exec wrangler r2 object get <bucket>/releases/<release-id>/release-manifest.json \
  --remote --file=/tmp/release-manifest.json
vp exec wrangler r2 object get <bucket>/releases/<release-id>/index.html \
  --remote --file=/tmp/release-index.html
```

- `<bucket>` 必須是 generated config 裡 `ASSETS` binding 的
  `bucket_name`（production `moedict-assets`，staging
  `moedict-assets-preview`）——**不要**用 `wrangler.jsonc` 手寫檔的值，
  也不要把 production bucket 寫入 staging 指令或反過來。
- `<release-id>` 就是 1.1 節從 `annotations["workers/tag"]` 讀到的值，
  不是 version UUID。
- 物件不存在代表該 release 從未成功發布過 R2（`release-publish.mjs` 沒跑
  完，或 manifest 上傳失敗被中止）；這種 release ID 不能拿來 rollback。

## 2. 判斷失效階段（決定下一步之前先分類）

| 觀察到的狀態                                                | 可能原因                                                                                               | 下一步                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `deployments list` 正好一筆 100%                            | 正常，可安全用 §0 自動 rollback                                                                        | 用 §0                                                         |
| `deployments list` 有兩筆非 0%                              | 上次 rollout 中途中斷（split state）                                                                   | 先判斷哪個 UUID 是「已知良好」，見 §3                         |
| `X-Moedict-Version`/`X-Moedict-Release` 與期待不符          | 先查 override 是否指到正確 Worker name/UUID，`annotations["workers/tag"]` 是否正確；**不要先歸咎快取** | 修正指令後重跑，或見 §3                                       |
| shell 回 503（`Cache-Control: no-store`、`Retry-After: 5`） | `SITE_ASSETS` 與 R2 release 都失敗，或 tag 缺失被跳過 R2                                               | 看 `shell-miss` 結構化 log（見 §4），不要清除診斷標頭就重部署 |
| 資產 miss                                                   | 依 `X-Moedict-Asset-Source` 判斷命中層（`site-assets`/`r2-release`/`r2-immutable`/`r2-legacy`）        | 對應層的 R2 key/bucket/上傳狀態                               |

## 3. 人工 positional 復原指令（§0 自動路徑也失敗時才用）

**一律用 positional `<uuid>@<percentage>%`，不要用 `--version-id`、
`--percentage` 或 `--version-tag`**——這些旗標在目前 Wrangler 版本上要嘛不存在
要嘛語意不同，唯一驗證過的語法是位置參數 + `%` 後綴 + `-y`。

```bash
# 將已知良好的 old UUID 恢復 100%（single-spec，最單純的收斂）
vp exec wrangler versions deploy --config <generated-config> \
  <known-good-uuid>@100% -y

# 若要明確清掉仍在 deployment 中的壞 UUID，改用兩個 spec（總和必須是 100）
vp exec wrangler versions deploy --config <generated-config> \
  <known-good-uuid>@100% <bad-uuid>@0% -y
```

- 兩個 spec 的百分比總和必須恰好 100；不要留下總和不是 100 的中間狀態。
- 執行前務必已經從 §1.1 的 `versions list` 確認 `<known-good-uuid>` 存在，
  且從 §1.1/§1.3 確認它有對應的 release ID 與 R2 release 物件（否則新版
  Worker 收到 0% 流量後的 shell/asset fallback 會找不到東西）。

## 4. 復原後確認（每次人工操作後都要做，不可省略）

```bash
# 唯讀：deployment 是否收斂到單一 100%
vp exec wrangler deployments list --config <generated-config> --name <worker-name> --json

# 標頭：release ID 是否符合預期
curl -sS -D - -o /dev/null 'https://<worker-url>/?release-debug=1'

# 至少兩條核心路由都要 200 + 正確 X-Moedict-Release
curl -sS -o /dev/null -w '%{http_code}\n' 'https://<worker-url>/api/config?release-debug=1'
curl -sS -o /dev/null -w '%{http_code}\n' 'https://<worker-url>/api/%E8%90%8C.json?release-debug=1'
```

- `<worker-url>` production 是 `https://www.moedict.tw`，staging 是
  `https://cf-moedict-webkit-neo-staging.audreyt.workers.dev`。
- 確認 `deployments list` 只剩**一筆** 100%、UUID 與剛剛部署的
  `<known-good-uuid>` 一致，且沒有殘留的非 0% 第二筆。
- 若 60–90 秒內仍看到舊回應，先用 `?release-debug=1`（或任何 cache-buster
  query）重試——這通常是 edge 快取自然殘留（`s-maxage=60`），不代表復原
  失敗；但若標頭持續錯誤超過這個窗口，回到 §1 重新診斷，不要重複盲目重跑
  同一個 mutating 指令。

## 5. 結構化 log 判讀（shell-miss / asset-miss）

`shell-miss` log event 欄位：`pathname`、`cfRay`、`versionId`、
`releaseTag`、`siteAssetsResult`（`non-ok`/`throw`/`no-fetcher`）、
`siteAssetsStatus`、`r2Attempted`、`r2Key`、`r2Result`
（`hit`/`miss`/`throw`/`skipped`）、`finalSource`、`finalStatus`。不含
secrets，可安全貼給其他人協助診斷。

- `siteAssetsResult=non-ok|throw` 且 `r2Result=hit`、`finalSource=r2-release`：
  是 `SITE_ASSETS`／edge propagation gap，R2 本身正常，通常會自然收斂。
- `r2Result=miss|throw` 且 `finalSource=recovery`：R2 key／bucket／publish／
  binding 需查（回到 §1.3）；若 `releaseTag` 也是空的，是 metadata/bootstrap
  問題，不是 R2 問題。
- 資產 log 看到 `r2-immutable`：新 Worker 正在服務舊 tab 的 hashed URL，是
  預期中的相容路徑，不是異常。

## 6. 絕對不要做的事

- 不要在 `.superpowers/`、log、commit message 或 shell history 裡寫入
  Cloudflare API token、account ID，或任何實際 secret 值。
- 不要用裸 `wrangler deploy`（無論是否加 `--env`）——它是 atomic 100% cutover，
  沒有本協議的 smoke／probe／rollback 保護。
- 不要把 production bucket 名稱套用到 staging 指令，或反過來。
- 不要在沒有先跑過 §1 唯讀診斷、確認目標 UUID 存在且有對應 R2 release 物件
  的情況下，直接執行 §3 的 mutating 指令。
- 不要清除 `X-Moedict-*` 診斷標頭或 503 recovery 回應的 `Cache-Control`/
  `Retry-After` 來「讓它看起來正常」——這些是刻意設計的可觀測性訊號。
