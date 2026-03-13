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

# R2 Storage 配置
R2_REMOTE="r2"
R2_BUCKET="moedict-dictionary-preview" # or "moedict-dictionary"

# pack 資料夾（字詞 bucket 資料）
PACK_FOLDERS=("pack" "pcck" "phck" "ptck")

# 語言子目錄（含 index.json, xref.json, @.json, =.json 等）
LANG_FOLDERS=("a" "c" "h" "t")
SEARCH_INDEX_DIR="$DICTIONARY_DIR/search-index"
TRANSLATION_DATA_DIR="$DICTIONARY_DIR/translation-data"


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
    echo "❌ 錯誤: $SEARCH_INDEX_DIR 資料夾不存在，請先執行 npm run build-search-index"
    exit 1
fi

# 檢查翻譯資料資料夾是否存在
if [ ! -d "$TRANSLATION_DATA_DIR" ]; then
    echo "❌ 錯誤: $TRANSLATION_DATA_DIR 資料夾不存在"
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

echo ""
echo "🔄 開始同步上傳..."

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

echo ""
echo "🔗 R2 Storage 路徑: $R2_REMOTE:$R2_BUCKET"
