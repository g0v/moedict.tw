#!/bin/bash

# 上傳字典資料到 R2 Storage 的腳本
# 使用 rclone sync 上傳 pack/pcck/phck/ptck（字詞資料）
# 以及 a/t/h/c（索引、部首、分類、xref 等）、search-index、translation-data 到 moedict-dictionary

set -e  # 遇到錯誤時退出

echo "🚀 開始上傳字典資料到 R2 Storage..."

# 檢查 rclone 是否安裝
if ! command -v rclone &> /dev/null; then
    echo "❌ 錯誤: rclone 未安裝，請先安裝 rclone"
    exit 1
fi

# 檢查字典資料夾是否存在
DICTIONARY_DIR="./data/dictionary"
if [ ! -d "$DICTIONARY_DIR" ]; then
    echo "❌ 錯誤: dictionary 資料夾不存在"
    exit 1
fi

# R2 Storage 配置 (override: R2_BUCKET=moedict-dictionary)
R2_REMOTE="${R2_REMOTE:-r2}"
R2_BUCKET="${R2_BUCKET:-moedict-dictionary-preview}" # prod: moedict-dictionary

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

echo ""
echo "🔄 開始同步上傳..."

show_preflight_checklist() {
    echo ""
    echo "🧭 正式上傳前檢查清單"
    echo "  1) 確認目標 bucket 是否正確：$R2_REMOTE:$R2_BUCKET"
    echo "  2) 先跑 dry-run，確認只會變更預期檔案"
    echo "  3) 特別留意「刪除」項目（delete），若出現非預期刪除請中止"
    echo "  4) 特別留意「新增/更新」路徑是否集中在本次變更範圍"
    echo ""
    echo "🔎 dry-run 判讀重點"
    echo "  - 若看到 delete 且不是你預期要清掉的檔案：請按 n 取消"
    echo "  - 若只看到預期新增/更新，且路徑正確：可按 y 繼續正式上傳"
}

rclone_upload() {
    local src="$1"
    local dst="$2"
    rclone sync "$src" "$dst" \
        --progress \
        --transfers=32 \
        --checkers=64 \
        --buffer-size=1M \
        --fast-list \
        --retries=3 \
        --low-level-retries=10 \
        --retries-sleep=2s
}

rclone_upload_dry_run() {
    local src="$1"
    local dst="$2"
    rclone sync "$src" "$dst" \
        --dry-run \
        --progress \
        --transfers=32 \
        --checkers=64 \
        --buffer-size=1M \
        --fast-list \
        --retries=3 \
        --low-level-retries=10 \
        --retries-sleep=2s
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
