/**
 * TWBLG（教育部台灣閩南語常用詞辭典）單字異讀分類標記。
 *
 * 台語單字條目（lang='t'）的每個 heteronym 可能帶有 `reading` 欄位，標示
 * 該讀音屬於「文言音」「白話音」「俗音」或「替代用字（訓用字）」——
 * 資料本身在上游 ptck pack（data/dictionary/ptck/*.txt）已經齊全，只是
 * 現行前端從未讀取／顯示這個欄位（g0v/moedict-webkit#96、#233）。
 *
 * 單字元分類代碼 → 完整中文標籤的對照表。呼叫端需自行用 stripTags 把
 * API 回傳的 `<a href="...">文</a>` 之類的 autolink 包裝去掉，取出純文
 * 字分類代碼後再查表；查不到的代碼由呼叫端自行 fallback 回原始代碼，
 * 避免教育部未來新增分類時靜默丟失資訊。
 */
export const READING_TYPE_LABELS: Record<string, string> = {
  文: "文讀音（文言音）",
  白: "白讀音（白話音）",
  俗: "俗讀音",
  替: "替代字讀音（訓用字）",
};
