#!/bin/bash

# 上傳字典資料到 R2 Storage 的腳本
# 使用 rclone sync 上傳 pack/pcck/phck/ptck（字詞資料）
# 以及 a/t/h/c（索引、部首、分類、xref 等）、search-index、translation-data 到 moedict-dictionary
#
# UPLOAD_SCOPE=cns  模式：僅上傳 CNS11643 全字庫屬性後備（data/dictionary/cns/ →
#   R2 cns/），跳過所有 pack/lang/search-index/translation-data 的前置檢查與上傳。
#   上傳前強制驗證本地確有恰好 77,208 個 JSON 檔案，驗證失敗時拒絕任何 rclone 呼叫。
#
# 速率限制（AGENTS.md §「R2 buckets 與資料上傳」第 188-191 行）：
#   Cloudflare API 對 R2 物件操作全帳號限制約 1100 req/5min。
#   並發上限 ≤8（--transfers / --checkers），對 429（error code 971）指數退避重試。
#   --transfers / --checkers 可用環境變數覆寫，但必須是 [1,8] 的整數，否則 fail-closed。

set -e  # 遇到錯誤時退出

echo "🚀 開始上傳字典資料到 R2 Storage..."

# ── 速率限制並發設定（AGENTS.md §R2 rate-limit policy）────────────────────────
# 硬上限 8（與 AGENTS.md 第 189 行「並發（≤8）」一致）；可用環境變數調低，不可調高。
# 必須是 [1,8] 的十進位整數；非數字、零、負數一律 fail-closed（不靜默回退）。
_MAX_CONCURRENCY=8

_validate_concurrency() {
    local _name="$1"
    local _val="$2"
    # Accept only decimal integers (no leading +, no spaces, no hex).
    case "$_val" in
        ''|*[!0-9]*)
            echo "❌ 錯誤: ${_name}=${_val} 不是有效的十進位整數（fail-closed）"
            exit 1
            ;;
    esac
    if [ "$_val" -lt 1 ] || [ "$_val" -gt "$_MAX_CONCURRENCY" ]; then
        echo "❌ 錯誤: ${_name}=${_val} 超出允許範圍 [1, $_MAX_CONCURRENCY]（fail-closed）"
        exit 1
    fi
}

_TRANSFERS="${RCLONE_TRANSFERS:-8}"
_CHECKERS="${RCLONE_CHECKERS:-8}"
_validate_concurrency "RCLONE_TRANSFERS" "$_TRANSFERS"
_validate_concurrency "RCLONE_CHECKERS" "$_CHECKERS"

# CNS 全字庫預期 JSON 檔案數（對應 generate-cns-data.mjs EXPECTED_EMITTED）
CNS_EXPECTED_COUNT=77208

# ── 模式判斷 ───────────────────────────────────────────────────────────────────
UPLOAD_SCOPE="${UPLOAD_SCOPE:-all}"

# 檢查 rclone 是否安裝
if ! command -v rclone &> /dev/null; then
    echo "❌ 錯誤: rclone 未安裝，請先安裝 rclone"
    exit 1
fi

# 字典根目錄
DICTIONARY_DIR="./data/dictionary"
if [ ! -d "$DICTIONARY_DIR" ]; then
    echo "❌ 錯誤: dictionary 資料夾不存在"
    exit 1
fi

# R2 Storage 配置 (override: R2_BUCKET=moedict-dictionary)
R2_REMOTE="${R2_REMOTE:-r2}"
R2_BUCKET="${R2_BUCKET:-moedict-dictionary-preview}" # prod: moedict-dictionary

CNS_DATA_DIR="$DICTIONARY_DIR/cns"

# ── Bounded exponential retry wrapper for whole rclone sync calls ────────────
# Per AGENTS.md §R2 rate-limit: rclone --retries + --retries-sleep provide a FIXED
# interval between high-level retries (not exponential). --low-level-retries
# handles individual HTTP request retries with internal exponential backoff for
# 429/971, but a high-level sync failure needs a shell-level exponential wrapper.
#
# This function wraps a full rclone sync call with bounded exponential backoff:
# max 5 attempts, initial delay 1s, doubling, capped at 60s.
# Override initial delay via RCLONE_RETRY_INITIAL_MS (milliseconds; default 1000).
# Production default is 1s; tests may set RCLONE_RETRY_INITIAL_MS=0 to skip sleeps.
_rclone_sync_with_retry() {
    local _src="$1"
    local _dst="$2"
    local _extra_flags="$3"  # e.g. "--dry-run"
    local _max_attempts=5
    local _initial_ms="${RCLONE_RETRY_INITIAL_MS:-1000}"
    local _delay_ms="$_initial_ms"
    local _cap_ms=60000
    local _attempt=1

    while [ "$_attempt" -le "$_max_attempts" ]; do
        echo "   📤 rclone sync attempt $_attempt/$_max_attempts → $_dst"
        if rclone sync "$_src" "$_dst" \
            $_extra_flags \
            --progress \
            --transfers="$_TRANSFERS" \
            --checkers="$_CHECKERS" \
            --buffer-size=1M \
            --fast-list \
            --retries=1 \
            --low-level-retries=10 \
            --retries-sleep=2s; then
            echo "   ✅ rclone sync succeeded (attempt $_attempt)"
            return 0
        fi
        if [ "$_attempt" -eq "$_max_attempts" ]; then
            echo "   ❌ rclone sync failed after $_max_attempts attempts"
            return 1
        fi
        echo "   ⏳ retry in $((_delay_ms / 1000)).$(((_delay_ms % 1000) / 100))s (exponential backoff)…"
        # sleep accepts fractional seconds on macOS (built-in) and GNU coreutils.
        sleep "$((_delay_ms / 1000)).$(((_delay_ms % 1000) / 100))"
        _delay_ms=$((_delay_ms * 2))
        if [ "$_delay_ms" -gt "$_cap_ms" ]; then
            _delay_ms="$_cap_ms"
        fi
        _attempt=$((_attempt + 1))
    done
    return 1
}

# ── CNS-only scope ─────────────────────────────────────────────────────────────
if [ "$UPLOAD_SCOPE" = "cns" ]; then
    echo "📦 UPLOAD_SCOPE=cns: 僅上傳 CNS11643 全字庫屬性後備"
    echo "   目標: $R2_REMOTE:$R2_BUCKET/cns"
    echo ""

    # Fail closed: by-codepoint directory must exist
    if [ ! -d "$CNS_DATA_DIR/by-codepoint" ]; then
        echo "❌ 錯誤: $CNS_DATA_DIR/by-codepoint 不存在"
        echo "   請先執行: node scripts/generate-cns-data.mjs"
        exit 1
    fi

    # Count only files under by-codepoint/ (the generated corpus location).
    # The rclone sync source is cns/ so R2 keys remain cns/by-codepoint/{shard}/{hex}.json.
    actual_count=$(find "$CNS_DATA_DIR/by-codepoint" -name "*.json" | wc -l | tr -d ' ')
    if [ "$actual_count" -ne "$CNS_EXPECTED_COUNT" ]; then
        echo "❌ 錯誤: CNS JSON 檔案數不符"
        echo "   期望: $CNS_EXPECTED_COUNT"
        echo "   實際: $actual_count"
        echo "   請確認 generate-cns-data.mjs 已成功完成完整生成（非 --limit / --dry-run）"
        exit 1
    fi
    echo "✅ 檔案數驗證通過: $actual_count 個 JSON 檔案"
    echo ""

    show_cns_preflight() {
        echo "🧭 正式上傳前檢查清單（CNS scope）"
        echo "  1) 目標 bucket: $R2_REMOTE:$R2_BUCKET"
        echo "  2) 本地來源:    $CNS_DATA_DIR → cns/"
        echo "  3) 並發上限:    transfers=$_TRANSFERS checkers=$_CHECKERS（≤8，AGENTS.md §R2 rate-limit）"
        echo "  4) dry-run 先確認只有 cns/ 路徑的新增/更新，無非預期刪除"
        echo "  5) 指數退避:    最多 5 次重試，初始 1s 倍增上限 60s（429/971 適用）"
        echo ""
        echo "🔎 dry-run 判讀重點"
        echo "  - 若看到 delete 且不是你預期要清掉的檔案：請按 n 取消"
        echo "  - 若只看到預期 cns/ 新增/更新：可按 y 繼續正式上傳"
    }

    show_cns_preflight
    echo ""
    echo "🧪 dry-run cns/..."
    _rclone_sync_with_retry "$CNS_DATA_DIR" "$R2_REMOTE:$R2_BUCKET/cns" "--dry-run" || exit 1

    echo ""
    read -r -p "⚠️ CNS dry-run 完成，是否繼續正式上傳？(y/N): " confirm_upload
    case "$confirm_upload" in
        y|Y)
            echo "✅ 已確認，開始正式上傳 cns/..."
            ;;
        *)
            echo "🛑 已取消（未對 R2 做任何實際變更）"
            exit 0
            ;;
    esac

    _rclone_sync_with_retry "$CNS_DATA_DIR" "$R2_REMOTE:$R2_BUCKET/cns" "" || exit 1
    # 429 / error code 971: bounded exponential wrapper (5 attempts, 1s→2s→4s→8s→16s, cap 60s)
    # provides whole-rclone-sync retry; --low-level-retries=10 handles individual HTTP 429s.
    # 詳見 AGENTS.md §「R2 buckets 與資料上傳」第 188-191 行。

    echo ""
    echo "✅ cns/ 上傳完成（$actual_count 個 JSON 檔案）"
    echo "🔗 R2 路徑: $R2_REMOTE:$R2_BUCKET/cns"

    if [ -n "${CACHE_PURGE_TOKEN:-}" ]; then
        PURGE_URL="${CACHE_PURGE_URL:-https://moedict.tw/api/cache/purge}"
        echo ""
        echo "🧹 Purging Workers Cache via $PURGE_URL ..."
        purge_status=$(curl -sS -o /tmp/moedict-cache-purge.json -w '%{http_code}' \
            -X POST "$PURGE_URL" \
            -H "Authorization: Bearer ${CACHE_PURGE_TOKEN}" \
            -H 'Content-Type: application/json' \
            -d '{"allDictionaryTags":true}') || true
        if [ "$purge_status" = "200" ]; then
            echo "✅ Cache purge ok: $(cat /tmp/moedict-cache-purge.json)"
        else
            echo "❌ Cache purge failed (HTTP ${purge_status:-curl-error})"
            exit 1
        fi
    else
        echo "⚠️  CACHE_PURGE_TOKEN unset — skipped Workers Cache purge."
    fi

    exit 0
fi

# ── All-data scope (default) ───────────────────────────────────────────────────

# pack 資料夾（字詞 bucket 資料）
PACK_FOLDERS=("pack" "pcck" "phck" "ptck")

# 語言子目錄（含 index.json, xref.json, @.json, =.json 等）
LANG_FOLDERS=("a" "c" "h" "t")
SEARCH_INDEX_DIR="$DICTIONARY_DIR/search-index"
TRANSLATION_DATA_DIR="$DICTIONARY_DIR/translation-data"
PINYIN_LOOKUP_DIR="$DICTIONARY_DIR/lookup/pinyin"

# 檢查所有 pack 資料夾是否存在
for folder in "${PACK_FOLDERS[@]}"; do
    if [ ! -d "$DICTIONARY_DIR/$folder" ]; then
        echo "❌ 錯誤: $DICTIONARY_DIR/$folder 資料夾不存在"
        exit 1
    fi
done

# 檢查所有語言子目錄是否存在
for folder in "${LANG_FOLDERS[@]}"; do
    if [ ! -d "$DICTIONARY_DIR/$folder" ]; then
        echo "❌ 錯誤: $DICTIONARY_DIR/$folder 資料夾不存在"
        exit 1
    fi
done

# 檢查全文索引資料夾是否存在
if [ ! -d "$SEARCH_INDEX_DIR" ]; then
    echo "❌ 錯誤: $SEARCH_INDEX_DIR 資料夾不存在，請先執行 vp run build-search-index"
    exit 1
fi

# 檢查翻譯資料資料夾是否存在
if [ ! -d "$TRANSLATION_DATA_DIR" ]; then
    echo "❌ 錯誤: $TRANSLATION_DATA_DIR 資料夾不存在"
    exit 1
fi

# 檢查台語羅馬拼音索引資料夾是否存在
if [ ! -d "$PINYIN_LOOKUP_DIR" ]; then
    echo "❌ 錯誤: $PINYIN_LOOKUP_DIR 資料夾不存在，請先執行 vp run build-pinyin-lookup"
    exit 1
fi

echo "📁 準備上傳以下資料夾:"
for folder in "${PACK_FOLDERS[@]}"; do
    file_count=$(find "$DICTIONARY_DIR/$folder" -name "*.txt" | wc -l)
    echo "  - $folder ($file_count 個 .txt 檔案)"
done
for folder in "${LANG_FOLDERS[@]}"; do
    file_count=$(find "$DICTIONARY_DIR/$folder" -name "*.json" | wc -l)
    echo "  - $folder ($file_count 個 .json 檔案，含 xref.json, index.json, @, = 等)"
done
search_index_count=$(find "$SEARCH_INDEX_DIR" -name "*.json" | wc -l)
echo "  - search-index ($search_index_count 個 .json 檔案)"
translation_data_count=$(find "$TRANSLATION_DATA_DIR" -name "*.xml" | wc -l)
echo "  - translation-data ($translation_data_count 個 .xml 檔案)"
pinyin_lookup_count=$(find "$PINYIN_LOOKUP_DIR" -name "*.json" | wc -l)
echo "  - lookup/pinyin ($pinyin_lookup_count 個 .json 檔案)"
if [ -d "$CNS_DATA_DIR" ]; then
    cns_count=$(find "$CNS_DATA_DIR/by-codepoint" -name "*.json" 2>/dev/null | wc -l)
    echo "  - cns/ ($cns_count 個 .json 檔案，全字庫屬性後備)"
fi

echo ""
echo "🔄 開始同步上傳..."

show_preflight_checklist() {
    echo ""
    echo "🧭 正式上傳前檢查清單"
    echo "  1) 確認目標 bucket 是否正確：$R2_REMOTE:$R2_BUCKET"
    echo "  2) 先跑 dry-run，確認只會變更預期檔案"
    echo "  3) 特別留意「刪除」項目（delete），若出現非預期刪除請中止"
    echo "  4) 特別留意「新增/更新」路徑是否集中在本次變更範圍"
    echo "  5) 並發上限: transfers=$_TRANSFERS checkers=$_CHECKERS（≤8，AGENTS.md §R2 rate-limit）"
    echo "  6) 指數退避: 最多 5 次重試，初始 1s 倍增上限 60s（429/971 適用）"
    echo ""
    echo "🔎 dry-run 判讀重點"
    echo "  - 若看到 delete 且不是你預期要清掉的檔案：請按 n 取消"
    echo "  - 若只看到預期新增/更新，且路徑正確：可按 y 繼續正式上傳"
}

rclone_upload() {
    local src="$1"
    local dst="$2"
    _rclone_sync_with_retry "$src" "$dst" ""
}

rclone_upload_dry_run() {
    local src="$1"
    local dst="$2"
    _rclone_sync_with_retry "$src" "$dst" "--dry-run"
}

show_preflight_checklist
echo ""
echo "🧪 開始 dry-run（不會真的上傳）..."

# dry-run：pack 資料夾
for folder in "${PACK_FOLDERS[@]}"; do
    echo ""
    echo "🧪 dry-run $folder..."
    rclone_upload_dry_run "$DICTIONARY_DIR/$folder" "$R2_REMOTE:$R2_BUCKET/$folder"
done

# dry-run：語言子目錄
for folder in "${LANG_FOLDERS[@]}"; do
    echo ""
    echo "🧪 dry-run $folder/ (xref, index, 部首, 分類...)..."
    rclone_upload_dry_run "$DICTIONARY_DIR/$folder" "$R2_REMOTE:$R2_BUCKET/$folder"
done

# dry-run：全文檢索索引
echo ""
echo "🧪 dry-run search-index/ (全文檢索索引)..."
rclone_upload_dry_run "$SEARCH_INDEX_DIR" "$R2_REMOTE:$R2_BUCKET/search-index"

# dry-run：翻譯資料
echo ""
echo "🧪 dry-run translation-data/ (翻譯語料)..."
rclone_upload_dry_run "$TRANSLATION_DATA_DIR" "$R2_REMOTE:$R2_BUCKET/translation-data"

# dry-run：台語羅馬拼音索引
echo ""
echo "🧪 dry-run lookup/pinyin/ (台語羅馬拼音索引)..."
rclone_upload_dry_run "$PINYIN_LOOKUP_DIR" "$R2_REMOTE:$R2_BUCKET/lookup/pinyin"

# dry-run：全字庫屬性後備（可選，僅當 cns/ 目錄存在時執行）
if [ -d "$CNS_DATA_DIR" ]; then
    echo ""
    echo "🧪 dry-run cns/ (全字庫屬性後備)..."
    rclone_upload_dry_run "$CNS_DATA_DIR" "$R2_REMOTE:$R2_BUCKET/cns"
fi

echo ""
read -r -p "⚠️ 以上 dry-run 完成，是否繼續正式上傳？(y/N): " confirm_upload
case "$confirm_upload" in
    y|Y)
        echo "✅ 已確認，開始正式上傳..."
        ;;
    *)
        echo "🛑 已取消正式上傳（未對 R2 做任何實際變更）"
        exit 0
        ;;
esac

# 上傳 pack 資料夾
for folder in "${PACK_FOLDERS[@]}"; do
    echo ""
    echo "📤 正在上傳 $folder..."
    rclone_upload "$DICTIONARY_DIR/$folder" "$R2_REMOTE:$R2_BUCKET/$folder"
    echo "✅ $folder 上傳完成"
done

# 上傳語言子目錄（含 xref.json, index.json, @.json, =.json 等）
for folder in "${LANG_FOLDERS[@]}"; do
    echo ""
    echo "📤 正在上傳 $folder/ (xref, index, 部首, 分類...)..."
    rclone_upload "$DICTIONARY_DIR/$folder" "$R2_REMOTE:$R2_BUCKET/$folder"
    echo "✅ $folder/ 上傳完成"
done

# 上傳全文檢索索引
echo ""
echo "📤 正在上傳 search-index/ (全文檢索索引)..."
rclone_upload "$SEARCH_INDEX_DIR" "$R2_REMOTE:$R2_BUCKET/search-index"
echo "✅ search-index/ 上傳完成"

# 上傳翻譯資料
echo ""
echo "📤 正在上傳 translation-data/ (翻譯語料)..."
rclone_upload "$TRANSLATION_DATA_DIR" "$R2_REMOTE:$R2_BUCKET/translation-data"
echo "✅ translation-data/ 上傳完成"

# 上傳台語羅馬拼音索引
echo ""
echo "📤 正在上傳 lookup/pinyin/ (台語羅馬拼音索引)..."
rclone_upload "$PINYIN_LOOKUP_DIR" "$R2_REMOTE:$R2_BUCKET/lookup/pinyin"
echo "✅ lookup/pinyin/ 上傳完成"

# 上傳全字庫屬性後備（可選，僅當 cns/ 目錄存在時執行）
if [ -d "$CNS_DATA_DIR" ]; then
    echo ""
    echo "📤 正在上傳 cns/ (全字庫屬性後備)..."
    rclone_upload "$CNS_DATA_DIR" "$R2_REMOTE:$R2_BUCKET/cns"
    echo "✅ cns/ 上傳完成"
fi

echo ""
echo "🎉 所有字典資料上傳完成！"
echo ""
echo "📊 上傳摘要:"
for folder in "${PACK_FOLDERS[@]}"; do
    file_count=$(find "$DICTIONARY_DIR/$folder" -name "*.txt" | wc -l)
    echo "  - $folder: $file_count 個檔案"
done
for folder in "${LANG_FOLDERS[@]}"; do
    file_count=$(find "$DICTIONARY_DIR/$folder" -name "*.json" | wc -l)
    echo "  - $folder/: $file_count 個 JSON 檔案"
done
search_index_count=$(find "$SEARCH_INDEX_DIR" -name "*.json" | wc -l)
echo "  - search-index/: $search_index_count 個 JSON 檔案"
translation_data_count=$(find "$TRANSLATION_DATA_DIR" -name "*.xml" | wc -l)
echo "  - translation-data/: $translation_data_count 個 XML 檔案"
pinyin_lookup_count=$(find "$PINYIN_LOOKUP_DIR" -name "*.json" | wc -l)
echo "  - lookup/pinyin/: $pinyin_lookup_count 個 JSON 檔案"
if [ -d "$CNS_DATA_DIR" ]; then
    cns_count=$(find "$CNS_DATA_DIR/by-codepoint" -name "*.json" 2>/dev/null | wc -l)
    echo "  - cns/: $cns_count 個 JSON 檔案（全字庫屬性後備）"
fi

echo ""
echo "🔗 R2 Storage 路徑: $R2_REMOTE:$R2_BUCKET"

# Purge Workers Cache so front-of-Worker hits do not serve stale dictionary JSON.
# Requires:
#   CACHE_PURGE_TOKEN  — same secret as Worker env CACHE_PURGE_TOKEN
#   CACHE_PURGE_URL    — optional, default https://moedict.tw/api/cache/purge
if [ -n "${CACHE_PURGE_TOKEN:-}" ]; then
  PURGE_URL="${CACHE_PURGE_URL:-https://moedict.tw/api/cache/purge}"
  echo ""
  echo "🧹 Purging Workers Cache via $PURGE_URL ..."
  purge_status=$(curl -sS -o /tmp/moedict-cache-purge.json -w '%{http_code}' \
    -X POST "$PURGE_URL" \
    -H "Authorization: Bearer ${CACHE_PURGE_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d '{"allDictionaryTags":true}') || true
  if [ "$purge_status" = "200" ]; then
    echo "✅ Cache purge ok: $(cat /tmp/moedict-cache-purge.json)"
  else
    echo "❌ Cache purge failed (HTTP ${purge_status:-curl-error}): $(cat /tmp/moedict-cache-purge.json 2>/dev/null || true)"
    echo "   R2 upload succeeded, but front cache may still be stale until TTL/redeploy."
    exit 1
  fi
else
  echo ""
  echo "⚠️  CACHE_PURGE_TOKEN unset — skipped Workers Cache purge after upload."
  echo "   Set CACHE_PURGE_TOKEN (and optional CACHE_PURGE_URL) to invalidate dict/list/search-index tags."
fi