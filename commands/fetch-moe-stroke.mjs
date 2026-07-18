#!/usr/bin/env node
/**
 * 從教育部《國字標準字體筆順學習網》2025 新版網站取得單一國字的官方筆順資料，
 * 轉成 moedict.tw 既有 `/api/stroke-json/{codepoint-hex}.json` 代理所預期的
 * JSON 格式（與 g0v/zh-stroke-data 的 `json/*.json`、R2 `stroke-json/*.json`
 * 完全相同的 schema：`Array<{ outline: PathCmd[], track: TrackPoint[] }>`）。
 *
 * 背景（g0v/moedict-webkit#227「町字筆順錯誤」調查所得）：
 *
 * - moedict.tw 現行 R2 `stroke-json/` 物件是從 Rackspace legacy CDN 一次性遷移
 *   （見 commands/migrate-legacy-cdn-to-r2.mjs、README_CDN.md）；該 CDN 內容
 *   源自 g0v/zh-stroke-data，而 zh-stroke-data 的 `fetch.go` 是呼叫教育部舊版
 *   `provideStrokeInfo.do?big5=<hex>` 端點抓取，僅涵蓋教育部 71 年公告的
 *   4808 個常用字。
 * - 教育部筆順學習網已於 2024-12-27／2025-01-02 全面改版：舊版
 *   `home.do`／`provideStrokeInfo.do?big5=` 端點已完全停用（含最基本的
 *   `一` 字查詢也回 404，非個別字缺漏，是整個端點退役），改用
 *   `dictView.jsp?ID=<十進位 Unicode 碼位>` 呈現，並將收字範圍擴充到
 *   6,063 字（2020 年參考《國語辭典簡編本》擴充至 6,057 字，2024 年再參考
 *   《國語小字典》擴充至 6,063 字）。「町」（U+753A）不在原始 4808 常用字
 *   之列，但已收錄在擴充後的新版網站——這是 zh-stroke-data／R2 鏡像從未
 *   涵蓋「町」的真正原因：不是教育部「沒有」筆順資料，而是 moedict.tw 的
 *   資料管線源頭（zh-stroke-data）從未針對新版擴充字集重新同步過。
 * - 新版頁面把完整筆順 XML（與舊版 `provideStrokeInfo.do` 回傳格式逐位元組
 *   相同：`<Word><Stroke><Outline><MoveTo/LineTo/QuadTo/CubicTo/></Outline>
 *   <Track><MoveTo/></Track></Stroke>...</Word>`）內嵌在頁面的
 *   `xml[<ID>]="...";` JS 字串常值中，此腳本即解析該內嵌字串。
 *
 * 授權依據（沿用 g0v/zh-stroke-data README 的立場，非新主張）：教育部網站
 * 標示的「創用 CC 姓名標示-非商業性-禁止改作 3.0 台灣」授權是網站對外的
 * 「使用建議」，而非本資料重製行為的唯一依據；zh-stroke-data 的既有全部
 * 4844 字語料即是依著作權法第 50 條「以中央或地方機關名義公開發表之著作，
 * 在合理範圍內，得重製、公開播送或公開傳輸」取得並以 CC0 釋出工具鏈，本
 * 腳本僅是用同一份法源、同一個政府網站，改用新版網址格式重新取得「町」等
 * 新版擴充字，屬於同一套既有、已被本專案採用多年的資料來源與取得方式，
 * 並非另立新的資料重製主張。
 *
 * 本腳本只讀取教育部網站、只寫入本機檔案，**不會**上傳到 Cloudflare R2、
 * 不會呼叫 wrangler、不會對任何遠端服務寫入——把資料實際同步進
 * `stroke-json/{hex}.json`（R2 `moedict-assets` bucket）是後續需要生產環境
 * 憑證的部署步驟，不在本腳本範圍內；腳本結尾會印出對應的
 * `wrangler r2 object put` 指令供人工複查後執行。
 *
 * 用法：
 *   node commands/fetch-moe-stroke.mjs 町
 *   node commands/fetch-moe-stroke.mjs 町 汛 --out .moe-stroke-fetch
 *
 * 輸出（預設寫到 `.moe-stroke-fetch/`，未加入版本控制）：
 *   {hex}.xml  — 教育部原始 XML（含來源網址／擷取時間註記）
 *   {hex}.json — 轉成 moedict.tw stroke-json 代理預期格式的 JSON
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MOE_ORIGIN = "https://stroke-order.learningweb.moe.edu.tw";

/** 教育部網站以十進位 Unicode 碼位當作 dictView.jsp 的 ID 參數。 */
export function toDecimalCodepoint(char) {
  const cp = char.codePointAt(0);
  if (cp === undefined) throw new Error(`empty input: ${JSON.stringify(char)}`);
  return cp;
}

/** 十進位碼位轉回 moedict.tw stroke-json 慣用的小寫十六進位（同 handleStrokeAPI.ts 的 {cp}.json）。 */
export function toHexCodepoint(char) {
  return toDecimalCodepoint(char).toString(16);
}

/**
 * 反轉 JS 字串常值跳脫（頁面內 `xml[ID]="...";` 是用 JSON.stringify 風格跳脫
 * 出來的雙引號字串，`\"`、`\n`、`\\` 等），還原成真正的 XML 文字。
 */
function unescapeJsStringLiteral(escaped) {
  return escaped.replace(/\\(["\\/nrt])/g, (_, c) => {
    switch (c) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return c; // \" -> "  \\ -> \  \/ -> /
    }
  });
}

/**
 * 從 dictView.jsp 的完整 HTML 中取出內嵌的筆順 XML 字串（`xml[<id>]="...";`），
 * 並確認 XML 內的 `unicode="..."` 屬性與預期字元一致（避免頁面改版或抓錯 ID
 * 時靜默吃進錯字的資料）。
 */
export function extractInlineStrokeXml(html, expectedChar) {
  const decimalId = toDecimalCodepoint(expectedChar);
  const re = new RegExp(`xml\\[${decimalId}\\]\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const match = re.exec(html);
  if (!match) return null;
  const xml = unescapeJsStringLiteral(match[1]);
  const unicodeAttr = /unicode="([^"]*)"/.exec(xml);
  if (!unicodeAttr || unicodeAttr[1] !== expectedChar) {
    throw new Error(
      `stroke XML unicode attribute mismatch: expected ${JSON.stringify(expectedChar)}, got ${JSON.stringify(unicodeAttr && unicodeAttr[1])}`,
    );
  }
  return xml;
}

function parseAttrs(attrText) {
  const attrs = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(attrText))) attrs[m[1]] = m[2];
  return attrs;
}

/**
 * 把單一 `<Outline>...</Outline>` 區塊內的自封閉標籤轉成 moedict.tw stroke-json
 * 的 path-command 物件，欄位形狀與 jquery.strokeWords.js 的 `jsonFromXml`
 * （SAX 版本）逐一對應，確保產出與既有 4844 個 R2 stroke-json 物件同構。
 */
function parseOutlineTag(tag, attrs) {
  switch (tag) {
    case "MoveTo":
      return { type: "M", x: parseFloat(attrs.x), y: parseFloat(attrs.y) };
    case "LineTo":
      return { type: "L", x: parseFloat(attrs.x), y: parseFloat(attrs.y) };
    case "CubicTo":
      return {
        type: "C",
        begin: { x: parseFloat(attrs.x1), y: parseFloat(attrs.y1) },
        mid: { x: parseFloat(attrs.x2), y: parseFloat(attrs.y2) },
        end: { x: parseFloat(attrs.x3), y: parseFloat(attrs.y3) },
      };
    case "QuadTo":
      return {
        type: "Q",
        begin: { x: parseFloat(attrs.x1), y: parseFloat(attrs.y1) },
        end: { x: parseFloat(attrs.x2), y: parseFloat(attrs.y2) },
      };
    default:
      return null;
  }
}

const SELF_CLOSING_TAG_RE = /<(MoveTo|LineTo|QuadTo|CubicTo)\b([^>]*)\/>/g;

/**
 * 教育部筆順 XML（`<Word><Stroke><Outline>...</Outline><Track>...</Track>
 * </Stroke>...</Word>`）轉成 moedict.tw stroke-json 陣列格式。純函式、
 * 不依賴瀏覽器 DOM／`sax` 套件（本專案未依賴 `sax`，只有瀏覽器端的
 * jquery.strokeWords.js 用得到），僅用正規表示式掃描——來源 XML 結構固定、
 * 全為自封閉標籤，等價於 SAX 版本的逐標籤轉換。
 */
export function parseMoeStrokeXml(xml) {
  const strokeBlocks = [...xml.matchAll(/<Stroke>([\s\S]*?)<\/Stroke>/g)];
  if (strokeBlocks.length === 0) {
    throw new Error("no <Stroke> elements found in stroke XML");
  }
  return strokeBlocks.map(([, block]) => {
    const outlineMatch = /<Outline>([\s\S]*?)<\/Outline>/.exec(block);
    const trackMatch = /<Track>([\s\S]*?)<\/Track>/.exec(block);
    if (!outlineMatch || !trackMatch) {
      throw new Error("malformed <Stroke>: missing <Outline> or <Track>");
    }

    const outline = [];
    for (const [, tag, attrText] of outlineMatch[1].matchAll(SELF_CLOSING_TAG_RE)) {
      const cmd = parseOutlineTag(tag, parseAttrs(attrText));
      if (cmd) outline.push(cmd);
    }

    const track = [];
    for (const [, tag, attrText] of trackMatch[1].matchAll(SELF_CLOSING_TAG_RE)) {
      if (tag !== "MoveTo") continue;
      const attrs = parseAttrs(attrText);
      const point = { x: parseFloat(attrs.x), y: parseFloat(attrs.y) };
      if (attrs.size !== undefined) point.size = parseFloat(attrs.size);
      track.push(point);
    }

    return { outline, track };
  });
}

/** 向教育部新版網站取得單一國字的 dictView.jsp 頁面（唯讀 GET，不寫入任何遠端狀態）。 */
export async function fetchMoeDictViewHtml(char) {
  const id = toDecimalCodepoint(char);
  const url = `${MOE_ORIGIN}/dictView.jsp?ID=${id}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "moedict.tw stroke-data provenance check (issue #227)" },
  });
  if (!res.ok) {
    throw new Error(`dictView.jsp?ID=${id} → HTTP ${res.status}`);
  }
  return { url, html: await res.text() };
}

/** 端對端：抓頁面 → 取內嵌 XML → 轉 JSON。回傳 null 代表新版網站也沒有這個字（非端點層級失敗）。 */
export async function fetchAndConvertMoeStroke(char) {
  const { url, html } = await fetchMoeDictViewHtml(char);
  const xml = extractInlineStrokeXml(html, char);
  if (!xml) return null;
  return { sourceUrl: url, xml, json: parseMoeStrokeXml(xml) };
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 ? args[outIdx + 1] : ".moe-stroke-fetch";
  const chars = args.filter((a, i) => a !== "--out" && (outIdx < 0 || i !== outIdx + 1));

  if (chars.length === 0) {
    console.error("用法: node commands/fetch-moe-stroke.mjs <國字> [<國字> ...] [--out <目錄>]");
    process.exitCode = 1;
    return;
  }

  mkdirSync(outDir, { recursive: true });

  for (const char of chars) {
    const hex = toHexCodepoint(char);
    try {
      const result = await fetchAndConvertMoeStroke(char);
      if (!result) {
        console.log(`[${char} / ${hex}] 新版教育部網站也沒有這個字的筆順資料`);
        continue;
      }
      const strokeCount = result.json.length;
      const provenance = `<!-- 來源: ${result.sourceUrl} | 擷取時間: ${new Date().toISOString()} | 授權: 見 commands/fetch-moe-stroke.mjs 檔頭說明 -->\n`;
      writeFileSync(join(outDir, `${hex}.xml`), provenance + result.xml, "utf-8");
      writeFileSync(join(outDir, `${hex}.json`), JSON.stringify(result.json), "utf-8");
      console.log(`[${char} / ${hex}] OK，${strokeCount} 畫 → ${join(outDir, `${hex}.json`)}`);
      console.log(
        `  上傳指令（人工複查後執行，本腳本不會自動執行）: wrangler r2 object put moedict-assets/stroke-json/${hex}.json --file=${join(outDir, `${hex}.json`)} --content-type=application/json`,
      );
    } catch (err) {
      console.error(`[${char} / ${hex}] 失敗: ${err.message}`);
    }
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
