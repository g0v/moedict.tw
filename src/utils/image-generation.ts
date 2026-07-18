import { Resvg, type ResvgRenderOptions } from "@cf-wasm/resvg";
import { CACHE_CONTROL } from "../api/cache";
import { stripLangPrefix, tryDecodeURIComponent, type DictionaryLang } from "./dictionary-route";
import { bucketOf } from "../api/handleDictionaryAPI";
import { readR2JsonCached, type R2JsonSource } from "../api/r2-json-cache";

interface FontSvgObject {
  size: number;
  text(): Promise<string>;
}

interface FontBucket {
  get(key: string): Promise<FontSvgObject | null>;
}

interface AssetObject {
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface AssetBucket {
  get(key: string): Promise<AssetObject | null>;
}

interface Env {
  FONTS: FontBucket;
  /** R2-backed static asset bucket；用來讀取 Tauhu Oo 補完字型（見 loadFallbackFontBuffer）、
   *  以及 romanize=1 caption 用的 Fira Sans OT 字型（見 loadCaptionFontBuffer）。 */
  ASSETS?: AssetBucket;
  /** R2-backed dictionary bucket；romanize=1 時讀取整詞羅馬拼音（見
   *  fetchWholeWordRomanization）。一般字圖請求（無 romanize、lang 不合法、
   *  或未提供）完全用不到，也不會多打 R2（見該函式的 fail-open 短路）。 */
  DICTIONARY?: R2JsonSource;
}

interface LayoutDimensions {
  width: number;
  height: number;
  rows: number;
  cols: number;
}

const WT2FONT: Record<string, string> = {
  wt071: "HanWangShinSuMedium",
  wt024: "HanWangFangSongMedium",
  wt021: "HanWangLiSuMedium",
  wt001: "HanWangMingLight",
  wt002: "HanWangMingMedium",
  wt003: "HanWangMingBold",
  wt005: "HanWangMingBlack",
  wt004: "HanWangMingHeavy",
  wt006: "HanWangYenLight",
  wt009: "HanWangYenHeavy",
  wt011: "HanWangHeiLight",
  wt014: "HanWangHeiHeavy",
  wt064: "HanWangYanKai",
  wt028: "HanWangKanDaYan",
  wt034: "HanWangKanTan",
  wt040: "HanWangZonYi",
  wtcc02: "HanWangCC02",
  wtcc15: "HanWangCC15",
  wthc06: "HanWangGB06",
};

/**
 * Tauhu Oo（豆腐烏，tauhu-tw/tauhu-oo，SIL OFL 1.1）是本土語言（台語/客語）漢字、
 * 羅馬字的補完字型，修改自 Source Han Sans，已隨附於 ASSETS R2 bucket。涵蓋現行
 * 萌典台語（ptck）+ 客語（phck）pack 內全部 86 個增補平面罕見字（含 𣁳 U+23073），
 * 比萌典舊有的 MOEDICT.ttf 補完字更完整、授權也明確（MOEDICT.ttf 授權未確認）。
 * resvg 的字型比對是看字型檔案內部 name table 的家族名稱，不是 CSS @font-face
 * 別名，這份字型內部登記的家族名稱是 "Tauhu Oo 20.05"，所以 fallback <text> 一定
 * 要標 font-family="Tauhu Oo 20.05" 才會命中並畫出正確字形（否則 resvg 在 Workers
 * 環境沒有系統字型可用，只會留白）。
 */
const FALLBACK_FONT_ASSET_KEY = "fonts/TauhuOo2005-Regular.otf";
const FALLBACK_FONT_FAMILY = "Tauhu Oo 20.05";

/**
 * 解析 URL 路徑，提取語言和文字
 */
export function parseTextFromUrl(pathname: string): {
  text: string;
  lang: DictionaryLang;
  cleanText: string;
} {
  console.log("🔍 [ParseTextFromUrl] 開始解析 URL 路徑:", pathname);

  // 移除 .json, .png, .html 等副檔名
  let text = pathname.replace(/\.(json|png|html)$/, "");
  console.log("🔍 [ParseTextFromUrl] 移除副檔名後:", text);

  // 移除開頭的斜線
  text = text.replace(/^\//, "");
  console.log("🔍 [ParseTextFromUrl] 移除開頭斜線後:", text);

  // 防呆：若上游未改寫 /_json/ 前綴，這裡統一去除
  if (text.startsWith("_json/")) {
    text = text.substring("_json/".length);
    console.log("🔍 [ParseTextFromUrl] 移除 _json 前綴後:", text);
  }

  // URL 解碼（壞編碼 fallback 未解碼原字串，不冒 500）
  text = tryDecodeURIComponent(text) ?? text;
  console.log("🔍 [ParseTextFromUrl] URL 解碼後:", text);

  // 處理特殊重定向
  if (text.match(/^[~:!]?=\*/)) {
    text = text.replace(/^[~:!]?=\*/, "");
    console.log("🔍 [ParseTextFromUrl] 處理特殊重定向後:", text);
  }

  // 解析語言前綴（統一委派給 dictionary-route 的 stripLangPrefix；`!` 為
  // legacy hash-bang 時代對 t 的別名，僅 API/字圖端接受）
  const { lang, rest: cleanText } = stripLangPrefix(text, { "!": "t" });
  console.log("🔍 [ParseTextFromUrl] 語言前綴解析:", { lang, cleanText });

  console.log("🔍 [ParseTextFromUrl] 最終解析結果:", { text, lang, cleanText });
  return { text, lang, cleanText };
}

/**
 * 生成 CORS 標頭
 */
export function getCORSHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

/**
 * 處理圖片生成請求
 * 對應原本的 @get '/:text.png' 路由
 * 使用 R2 中的字體 SVG 檔案 + resvg 生成 PNG 圖片
 */
export async function handleImageGeneration(url: URL, env: Env): Promise<Response> {
  const { cleanText } = parseTextFromUrl(url.pathname);
  const fontParam = url.searchParams.get("font") || "kai";
  // romanize=1&lang=<a|t|h|c>：字圖下方加註整詞羅馬拼音（RESCOPE #169）。lang
  // 需驗證屬於四本字典之一，缺失或不合法一律視為未帶（fail-open，只產生純
  // 字形圖，不視為錯誤）；未帶 romanize=1 時完全不觸發 DICTIONARY 讀取，維持
  // 與功能加入前逐位元組相同的預設輸出。
  const romanizeParam = url.searchParams.get("romanize");
  const langParam = url.searchParams.get("lang");
  const captionLang = isDictionaryLangValue(langParam) ? langParam : null;

  try {
    // 限制文字長度
    // 以 Unicode 碼點（而非 UTF-16 code unit）截斷，避免切斷增補平面字元的 surrogate pair
    const displayText = Array.from(cleanText).slice(0, 50).join("");

    // 檢查字體是否在 R2 中可用
    const fontName = getFontName(fontParam);
    const isFontAvailable = await checkFontAvailability(fontName, env);

    if (!isFontAvailable) {
      // 如果字體不可用，返回純文字錯誤說明
      const errorMessage = `目前R2中尚無${fontName}字體，待更新`;

      return new Response(errorMessage, {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store", // font missing is env-specific
          ...getCORSHeaders(),
        },
      });
    }

    // romanize=1 且 lang 合法時，查詢整詞羅馬拼音（見 fetchWholeWordRomanization
    // 的 fail-open 短路：查無資料、lang='h'、或 DICTIONARY 未提供時一律回傳
    // 空字串，圖片照樣正常產生，只是不帶 caption）。
    const romanization =
      romanizeParam === "1" && captionLang !== null
        ? await fetchWholeWordRomanization(cleanText, captionLang, env)
        : "";

    // 生成 SVG 圖片，使用 R2 中的字體 SVG 檔案
    const { svg, usedFallbackGlyph, hasCaption } = await generateTextSVGWithR2Fonts(
      displayText,
      fontParam,
      env,
      romanization,
    );

    // 若有字元在 R2 找不到逐字 SVG（例如增補平面的罕見字/方言用字），必須改用內建
    // Tauhu Oo 補完字型讓 resvg 畫出真正字形；若 hasCaption，還需要額外載入 Fira
    // Sans OT 讓 caption 文字有字型可畫。resvg 在 Workers 環境沒有系統字型，兩者
    // 缺一都只會留白——絕不能把這種殘缺結果當成 200 成功回應快取一整年（png 的
    // s-maxage 是 31536000），不然字型之後就算修好，殘缺圖仍會卡在 edge cache
    // 裡。任一字型載入失敗都直接回 503 + no-store，讓下一次請求重試。兩個字型
    // buffer 一起 push 進同一個 fontBuffers 陣列，互不覆蓋。
    const resvgOptions: ResvgRenderOptions = {};
    const fontBuffers: Uint8Array[] = [];
    if (usedFallbackGlyph) {
      const fallbackFontBuffer = await loadFallbackFontBuffer(env);
      if (!fallbackFontBuffer) {
        return new Response("目前無法載入補完字型，請稍後再試", {
          status: 503,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            ...getCORSHeaders(),
          },
        });
      }
      fontBuffers.push(fallbackFontBuffer);
    }
    if (hasCaption) {
      const captionFontBuffer = await loadCaptionFontBuffer(env);
      if (!captionFontBuffer) {
        return new Response("目前無法載入羅馬拼音字型，請稍後再試", {
          status: 503,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            ...getCORSHeaders(),
          },
        });
      }
      fontBuffers.push(captionFontBuffer);
    }
    if (fontBuffers.length > 0) {
      resvgOptions.font = { fontBuffers };
    }

    // 使用 resvg 將 SVG 轉換為 PNG
    const resvg = new Resvg(svg, resvgOptions);
    const pngData = resvg.render();
    const pngBuffer = pngData.asPng();

    return new Response(Uint8Array.from(pngBuffer), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": CACHE_CONTROL.png,
        "Cache-Tag": "png",
        ...getCORSHeaders(),
      },
    });
  } catch (error) {
    console.error("Image generation error:", error);

    // 返回錯誤圖片
    const errorSVG = generateErrorSVG("圖片生成失敗");

    // 嘗試將錯誤 SVG 也轉換為 PNG
    try {
      const resvg = new Resvg(errorSVG);
      const pngData = resvg.render();
      const pngBuffer = pngData.asPng();

      return new Response(Uint8Array.from(pngBuffer), {
        status: 500,
        headers: {
          "Content-Type": "image/png",
          ...getCORSHeaders(),
        },
      });
    } catch {
      // 如果 PNG 轉換失敗，返回 SVG
      return new Response(errorSVG, {
        status: 500,
        headers: {
          "Content-Type": "image/svg+xml",
          ...getCORSHeaders(),
        },
      });
    }
  }
}

/**
 * 根據字體參數獲取字體名稱
 * 複製原本 moedict-webkit 的 font-of 函數邏輯
 */
export function getFontName(fontParam: string): string {
  // 全字庫字體
  if (/sung/i.test(fontParam)) return "TW-Sung";
  if (/ebas/i.test(fontParam)) return "EBAS";
  if (/shuowen/i.test(fontParam)) return "ShuoWen";

  // cwTeX Q 字體
  if (/cwming/i.test(fontParam)) return "cwTeXQMing";
  if (/cwhei/i.test(fontParam)) return "cwTeXQHei";
  if (/cwyuan/i.test(fontParam)) return "cwTeXQYuan";
  if (/cwkai/i.test(fontParam)) return "cwTeXQKai";
  if (/cwfangsong/i.test(fontParam)) return "cwTeXQFangsong";

  // 思源黑體
  if (/srcx/i.test(fontParam)) return "SourceHanSansTCExtraLight";
  if (/srcl/i.test(fontParam)) return "SourceHanSansTCLight";
  if (/srcn/i.test(fontParam)) return "SourceHanSansTCNormal";
  if (/srcr/i.test(fontParam)) return "SourceHanSansTCRegular";
  if (/srcm/i.test(fontParam)) return "SourceHanSansTCMedium";
  if (/srcb/i.test(fontParam)) return "SourceHanSansTCBold";
  if (/srch/i.test(fontParam)) return "SourceHanSansTCHeavy";

  // 思源宋體
  if (/shsx/i.test(fontParam)) return "SourceHanSerifTCExtraLight";
  if (/shsl/i.test(fontParam)) return "SourceHanSerifTCLight";
  if (/shsm/i.test(fontParam)) return "SourceHanSerifTCMedium";
  if (/shsr/i.test(fontParam)) return "SourceHanSerifTCRegular";
  if (/shss/i.test(fontParam)) return "SourceHanSerifTCSemiBold";
  if (/shsb/i.test(fontParam)) return "SourceHanSerifTCBold";
  if (/shsh/i.test(fontParam)) return "SourceHanSerifTCHeavy";

  // 源雲明體
  if (/gwmel/i.test(fontParam)) return "GenWanMinTWEL";
  if (/gwml/i.test(fontParam)) return "GenWanMinTWL";
  if (/gwmr/i.test(fontParam)) return "GenWanMinTWR";
  if (/gwmm/i.test(fontParam)) return "GenWanMinTWM";
  if (/gwmsb/i.test(fontParam)) return "GenWanMinTWSB";

  // 其他
  if (/rxkt/i.test(fontParam)) return "Typography";
  if (/openhuninn/i.test(fontParam)) return "jf-openhuninn-2.1";

  // 王漢宗字體
  if (WT2FONT[fontParam]) return WT2FONT[fontParam];

  // 預設字體
  return "TW-Kai";
}

/**
 * Per-isolate caches for the PNG render path, keyed on the R2 binding object
 * (WeakMap → unit-test isolation for free; production reuses one binding per
 * isolate). Billing audit 2026-07: this path generated ~100M R2 Class B GETs
 * per cycle — one availability probe per render, one GET per character
 * (misses included — those are billed too), and one fallback-font GET per
 * fallback render. All three are immutable-ish objects; memoize them.
 */
const fontAvailabilityCache = new WeakMap<object, Map<string, boolean>>();
const glyphSvgCache = new WeakMap<object, Map<string, string | null>>();
const GLYPH_CACHE_MAX_ENTRIES = 2048;
const fallbackFontCache = new WeakMap<object, Promise<Uint8Array | null>>();
const captionFontCache = new WeakMap<object, Promise<Uint8Array | null>>();

/**
 * 檢查字體是否在 R2 中可用
 * 通過檢查一個測試字符的 SVG 檔案是否存在（結果依 FONTS binding 記憶，
 * 每個 isolate 每種字型最多探測一次；probe 錯誤不快取，下次重試）
 */
async function checkFontAvailability(fontName: string, env: Env): Promise<boolean> {
  let cache = fontAvailabilityCache.get(env.FONTS);
  if (!cache) {
    cache = new Map();
    fontAvailabilityCache.set(env.FONTS, cache);
  }
  const cached = cache.get(fontName);
  if (cached !== undefined) {
    return cached;
  }
  try {
    // 使用 "萌" 字 (U+840C) 作為測試字符
    const testUnicode = 0x840c;
    const svgPath = `${fontName}/U+${testUnicode.toString(16).toUpperCase().padStart(4, "0")}.svg`;

    console.log(`[DEBUG] Checking font availability: ${fontName}, test path: ${svgPath}`);

    const svgObject = await env.FONTS.get(svgPath);
    const isAvailable = svgObject !== null;

    console.log(`[DEBUG] Font ${fontName} availability: ${isAvailable}`);
    cache.set(fontName, isAvailable);
    return isAvailable;
  } catch (error) {
    console.error(`[DEBUG] Error checking font availability for ${fontName}:`, error);
    return false;
  }
}

/**
 * 讀取單一字符的 SVG 內容，經 per-isolate LRU 快取（含 negative 快取——
 * R2 miss 也是計費的 Class B 操作）。回傳 SVG 全文或 null（不存在）。
 */
async function fetchGlyphSvg(fonts: Env["FONTS"], svgPath: string): Promise<string | null> {
  let cache = glyphSvgCache.get(fonts);
  if (!cache) {
    cache = new Map();
    glyphSvgCache.set(fonts, cache);
  }
  if (cache.has(svgPath)) {
    const cached = cache.get(svgPath) ?? null;
    // 更新 LRU 順序（Map 保留插入順序；重插移至尾端）
    cache.delete(svgPath);
    cache.set(svgPath, cached);
    return cached;
  }
  const svgObject = await fonts.get(svgPath);
  const content = svgObject ? await svgObject.text() : null;
  cache.set(svgPath, content);
  while (cache.size > GLYPH_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return content;
}

/**
 * 載入 Tauhu Oo 作為 resvg 的補完字型（fontBuffers）。只在某字元於 R2 找不到
 * 逐字 SVG、必須改用 <text> fallback 時才呼叫，避免每次產圖都多打一次 R2。
 */
async function loadFallbackFontBuffer(env: Env): Promise<Uint8Array | null> {
  const assets = env.ASSETS; // capture: narrowing does not flow into the closure
  if (!assets) return null;
  const cached = fallbackFontCache.get(assets);
  if (cached) return cached;
  const loading = (async (): Promise<Uint8Array | null> => {
    try {
      const asset = await assets.get(FALLBACK_FONT_ASSET_KEY);
      if (!asset) {
        console.log(`[DEBUG] Fallback font asset not found at ${FALLBACK_FONT_ASSET_KEY}`);
        return null;
      }
      return new Uint8Array(await asset.arrayBuffer());
    } catch (error) {
      console.error("[DEBUG] Failed to load fallback font buffer:", error);
      return null;
    }
  })();
  fallbackFontCache.set(assets, loading);
  return loading;
}

/**
 * romanize=1 字圖標註（RESCOPE #169）用的專屬字型：Fira Sans OT
 * （SIL OFL 1.1，隨附於 ASSETS R2 bucket，鍵值 fonts/FiraSansOT-Regular.otf）。
 * 內部 name table 家族名稱就是 "Fira Sans OT"（fonttools 驗證過），resvg 依此
 * 比對，所以 <text> 一定要標 font-family="Fira Sans OT, serif" 才會命中。與
 * FALLBACK_FONT_ASSET_KEY（Tauhu Oo）各自獨立、互不覆蓋——見 handleImageGeneration
 * 把兩者的 buffer 一起 push 進同一個 fontBuffers 陣列的寫法。
 */
const CAPTION_FONT_ASSET_KEY = "fonts/FiraSansOT-Regular.otf";
const CAPTION_FONT_FAMILY = "Fira Sans OT";

/**
 * 載入 romanize=1 caption 用的 Fira Sans OT 字型（fontBuffers）。與
 * loadFallbackFontBuffer 機制相同、各自快取；只在確定要畫 caption
 * （generateTextSVGWithR2Fonts 回傳 hasCaption=true）時才呼叫，一般字圖
 * 請求（無 romanize、lang 不合法、或查無羅馬拼音資料）完全不會多打這次 R2 GET。
 */
async function loadCaptionFontBuffer(env: Env): Promise<Uint8Array | null> {
  const assets = env.ASSETS; // capture: narrowing does not flow into the closure
  if (!assets) return null;
  const cached = captionFontCache.get(assets);
  if (cached) return cached;
  const loading = (async (): Promise<Uint8Array | null> => {
    try {
      const asset = await assets.get(CAPTION_FONT_ASSET_KEY);
      if (!asset) {
        console.log(`[DEBUG] Caption font asset not found at ${CAPTION_FONT_ASSET_KEY}`);
        return null;
      }
      return new Uint8Array(await asset.arrayBuffer());
    } catch (error) {
      console.error("[DEBUG] Failed to load caption font buffer:", error);
      return null;
    }
  })();
  captionFontCache.set(assets, loading);
  return loading;
}

/** `?lang=` 白名單驗證：缺失或不合法一律視為未帶（fail-open，只產生純字形圖）。 */
function isDictionaryLangValue(input: string | null): input is DictionaryLang {
  return input === "a" || input === "t" || input === "h" || input === "c";
}

/** SVG 屬性/文字節點內插前的最小 XML 跳脫（&/</>/"/'）。 */
function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 讀取整詞（非逐字）羅馬拼音／台羅／拼音，供 romanize=1 字圖標註使用
 * （RESCOPE #169）。只取第一個 heteronym（h[0]），且每次 render 最多打一次
 * DICTIONARY R2 GET（readR2JsonCached 本身另有 10 分鐘 per-isolate memo，
 * 見 src/api/r2-json-cache.ts）。原始 pack 資料的欄位是單字母代碼：'p' 是
 * 拼音（lang a/c 皆用漢語拼音），'T' 是台羅（lang t）；用 ?? 依序嘗試兩者，
 * 三種語言共用同一段邏輯（同 src/oembed/render-embed-document.ts 的
 * `heteronym.pinyin || heteronym.trs` 慣例，只是這裡讀的是尚未經
 * KEY_MAP 轉換的原始鍵）。
 *
 * lang='h' 客語資料的 p 欄位是逐字標調的四縣/海陸/大埔/饒平/詔安/南四縣
 * 多腔並列格式（例："四⃞sii⁵⁵ 海⃞sii³³…"），與其他語言乾淨的單一羅馬拼音
 * 字串形態不同，直接顯示會破版，因此在打 DICTIONARY 之前就短路回傳空字串
 * （documented Hakka exclusion）。
 */
export async function fetchWholeWordRomanization(
  word: string,
  lang: DictionaryLang,
  env: Env,
): Promise<string> {
  if (lang === "h") return "";
  const dictionary = env.DICTIONARY;
  if (!dictionary) return "";
  try {
    const bucketPath = `p${lang}ck/${bucketOf(word, lang)}.txt`;
    const responseData = (await readR2JsonCached(dictionary, bucketPath)) as Record<
      string,
      { h?: Array<{ p?: unknown; T?: unknown }> }
    > | null;
    if (!responseData) return "";
    const entry = responseData[escape(word)];
    const heteronyms = entry?.h;
    if (!Array.isArray(heteronyms) || heteronyms.length === 0) return "";
    const romanization = heteronyms[0]?.p ?? heteronyms[0]?.T ?? "";
    return typeof romanization === "string" ? romanization : "";
  } catch {
    return "";
  }
}

/**
 * 使用 R2 中的字體 SVG 檔案生成文字 SVG。
 * 依 Unicode 碼點（而非 UTF-16 code unit）逐字處理，避免超出 BMP 的增補平面字元
 * （如 𣁳 U+23073）被拆成兩個 surrogate half，多算格數、也查不到正確的字體 SVG。
 * 回傳的 usedFallbackGlyph 讓呼叫端知道是否要另外載入補完字型給 resvg 使用。
 */
export async function generateTextSVGWithR2Fonts(
  text: string,
  font: string,
  env: Env,
  romanization?: string,
): Promise<{ svg: string; usedFallbackGlyph: boolean; hasCaption: boolean }> {
  const chars = Array.from(text);
  const { width, height } = calculateLayout(chars.length);
  const cellSize = 375;
  const charWidth = 360; // 九宮格間距
  const gridSize = 360; // 九宮格大小

  // 計算 SVG 尺寸 - 使用原本的正方形邏輯
  const svgWidth = width * 375; // 原本的邏輯：w * 375
  const svgHeight = width * 375; // 原本的邏輯：w * 375（正方形）

  // 計算 padding，讓內容在正方形中垂直居中
  const padding = (width - height) / 2;

  // 計算 margin，讓左右留白一致（原本的邏輯）
  const margin = (width * 15) / 2;

  // 生成九宮格背景
  const gridElements = [];
  for (let i = 0; i < width * height; i++) {
    const row = Math.floor(i / width);
    const col = i % width;
    // 計算九宮格位置：使用原本的邏輯
    const x = margin + col * charWidth;
    const y = 10 + (padding + row) * cellSize;

    const char = chars[i];

    if (!char || char === " ") {
      continue;
    } else {
      gridElements.push(`
				<rect x="${x}" y="${y}" width="${gridSize}" height="${gridSize}"
					fill="#F9F6F6" stroke="#A33" stroke-width="5"/>
				<line x1="${x}" y1="${y + 118}" x2="${x + gridSize}" y2="${y + 118}" stroke="#A33" stroke-width="2"/>
				<line x1="${x}" y1="${y + 236}" x2="${x + gridSize}" y2="${y + 236}" stroke="#A33" stroke-width="2"/>
				<line x1="${x + 118}" y1="${y}" x2="${x + 118}" y2="${y + gridSize}" stroke="#A33" stroke-width="2"/>
				<line x1="${x + 236}" y1="${y}" x2="${x + 236}" y2="${y + gridSize}" stroke="#A33" stroke-width="2"/>
			`);
    }
  }

  // 生成文字元素 - 使用 R2 中的 SVG 檔案
  const textElements = [];
  let usedFallbackGlyph = false;
  console.log(`[DEBUG] Processing text: "${text}", length: ${chars.length}`);

  for (let i = 0; i < chars.length && i < width * height; i++) {
    const char = chars[i];
    const row = Math.floor(i / width);
    const col = i % width;

    // 計算文字位置：使用原本的邏輯
    const x = margin + col * charWidth + charWidth / 2;
    const y = 10 + (padding + row) * cellSize + cellSize / 2;

    // 獲取字符的 Unicode 編碼
    const unicode = char.codePointAt(0);
    if (!unicode) {
      console.log(`[DEBUG] No unicode for character: ${char}`);
      continue;
    }

    // 獲取字體名稱
    const fontName = getFontName(font);

    // 構建 SVG 檔案路徑
    const svgPath = `${fontName}/U+${unicode.toString(16).toUpperCase().padStart(4, "0")}.svg`;
    console.log(
      `[DEBUG] Character: ${char}, Unicode: U+${unicode.toString(16).toUpperCase()}, Font: ${fontName}, SVG Path: ${svgPath}`,
    );

    try {
      // 從 R2 讀取 SVG 檔案（經 per-isolate LRU；重複字符與重複 miss 不再打 R2）
      console.log(`[DEBUG] Fetching SVG (cached): ${svgPath}`);
      const svgContent = await fetchGlyphSvg(env.FONTS, svgPath);

      if (svgContent !== null) {
        console.log(`[DEBUG] SVG content length: ${svgContent.length} characters`);

        // 解析 SVG 內容，提取 path 元素
        const pathMatch = svgContent.match(/<path[^>]*d="([^"]*)"[^>]*>/);

        if (pathMatch) {
          const pathData = pathMatch[1];
          console.log(`[DEBUG] Path data found for ${char}, length: ${pathData.length} characters`);

          const initRatio = 360 / 1024;
          // 動態計算縮放比例 - 根據字體類型調整
          let scale = initRatio; // 預設縮放比例（楷體等，1024x1024）

          // 篆體字需要較小的縮放比例，因為其 SVG 尺寸較大
          // 楷體 SVG: 1024x1024, 篆體 SVG: 4096x4096 (4倍)
          // 楷體縮放 initRatio，篆體應該縮放 initRatio / 4
          if (fontName.includes("EBAS")) {
            scale = initRatio / 4; // 篆體使用較小的縮放比例，基於尺寸比例計算
            console.log(`[DEBUG] Using EBAS (seal script) scale: ${scale}`);
          }

          // 思源宋體的 SVG 尺寸為 1000x1000
          // 所有7個字重：ExtraLight, Light, Regular, Medium, SemiBold, Bold, Heavy
          else if (fontName.includes("SourceHanSerif")) {
            scale = (initRatio * 1024) / 1000; // 思源宋體使用 1000x1000 的縮放比例
            console.log(`[DEBUG] Using SourceHanSerif scale: ${scale}`);
          }
          // 思源黑體的 SVG 尺寸為 1000x1000
          else if (fontName.includes("SourceHanSans")) {
            scale = (initRatio * 1024) / 1000; // 思源黑體使用 1000x1000 的縮放比例
            console.log(`[DEBUG] Using SourceHanSans scale: ${scale}`);
          } else if (fontName.includes("jf-openhuninn-2.1")) {
            scale = initRatio; // jf-openhuninn-2.1使用 1024x1024 的縮放比例，與楷體相同
            console.log(`[DEBUG] Using jf-openhuninn-2.1 scale: ${scale}`);
          }
          // Typography 的 SVG 尺寸為 1024x1024, 與楷體相同
          else if (fontName.includes("Typography")) {
            scale = initRatio; // Typography使用 1024x1024 的縮放比例
            console.log(`[DEBUG] Using Typography scale: ${scale}`);
          }

          // ShuoWen 的 SVG 尺寸為 1024x1024，與楷體相同
          else if (fontName.includes("ShuoWen")) {
            scale = initRatio; // ShuoWen 使用與楷體相同的縮放比例
            console.log(`[DEBUG] Using ShuoWen scale: ${scale}`);
          }

          // HanWang 的 SVG 尺寸為 1024x1024，與楷體相同
          else if (fontName.includes("HanWang")) {
            scale = initRatio; // HanWang 使用與楷體相同的縮放比例
            console.log(`[DEBUG] Using HanWang scale: ${scale}`);
          }

          // 半形字（ASCII 可顯示範圍）在視覺上偏窄，向右再位移一些以達到置中視覺
          const isHalfWidth = /[\x20-\x7E]/.test(char);
          let halfWidthAdjustX = isHalfWidth ? 85 : 0; // 約半個半形字寬的視覺調整

          // 源雲明體的半形字寬度調整要再減30px
          if (fontName.includes("GenWanMin")) {
            halfWidthAdjustX = isHalfWidth ? 55 : 0;
            console.log(`[DEBUG] Using GenWanMin halfWidthAdjustX: ${halfWidthAdjustX}`);
          } else if (fontName.includes("jf-openhuninn-2.1")) {
            halfWidthAdjustX = isHalfWidth ? 65 : 0;
            console.log(`[DEBUG] Using jf-openhuninn-2.1 halfWidthAdjustX: ${halfWidthAdjustX}`);
          }

          // 動態計算位置：根據字符在九宮格中的位置，依 scale 調整
          // 基準縮放比例為 initRatio，其他縮放比例按比例調整偏移量
          const baseScale = initRatio;
          const scaleRatio = scale / baseScale;

          let offsetX = x + halfWidthAdjustX - (1024 * scale) / 2 - 180 * (1 - scaleRatio); // X 位置依 scale 比例調整
          // 思源宋體的X偏移量要多50px
          if (fontName.includes("SourceHanSerif")) {
            offsetX += 50;
            console.log(`[DEBUG] Using SourceHanSerif offsetX: ${offsetX}`);
          }
          // 思源黑體的X偏移量也要多50px
          else if (fontName.includes("SourceHanSans")) {
            offsetX += 50;
            console.log(`[DEBUG] Using SourceHanSans offsetX: ${offsetX}`);
          }
          // 源雲明體的X偏移量也要多50px
          else if (fontName.includes("GenWanMin")) {
            offsetX += 50;
            console.log(`[DEBUG] Using GenWanMin offsetX: ${offsetX}`);
          }
          // jf-openhuninn-2.1 的X偏移量也要多45px
          else if (fontName.includes("jf-openhuninn-2.1")) {
            offsetX += 45;
            console.log(`[DEBUG] Using jf-openhuninn-2.1 offsetX: ${offsetX}`);
          }
          // Typography 的X偏移量也要多25px
          else if (fontName.includes("Typography")) {
            offsetX += 23;
            console.log(`[DEBUG] Using Typography offsetX: ${offsetX}`);
          }
          // ShuoWen 的X偏移量要多50px，與篆體類似
          else if (fontName.includes("ShuoWen")) {
            offsetX += 50;
            console.log(`[DEBUG] Using ShuoWen offsetX: ${offsetX}`);
          }
          // cwTeXQMing, cwTeXQKai, cwTeXQFangsong 全形字的X偏移量要多25px or 20px，但半形字不要
          else if (
            (fontName.includes("cwTeXQMing") ||
              fontName.includes("cwTeXQKai") ||
              fontName.includes("cwTeXQFangsong")) &&
            !isHalfWidth
          ) {
            offsetX +=
              fontName.includes("cwTeXQKai") || fontName.includes("cwTeXQFangsong") ? 20 : 25;
            console.log(
              `[DEBUG] Using cwTeXQMing or cwTeXQKai or cwTeXQFangsong full-width offsetX: ${offsetX}`,
            );
          }

          let offsetY = y - (1024 * scale) / 2 - 180 * (1 - scaleRatio) + 280; // Y 位置依 scale 比例調整

          // cwTexQYuan, cwTeXQHei, cwTeXQKai, cwTeXQFangsong 的 y,p,q,g 的y偏移量要少25px
          if (
            (fontName.includes("cwTeXQYuan") ||
              fontName.includes("cwTeXQHei") ||
              fontName.includes("cwTeXQKai") ||
              fontName.includes("cwTeXQFangsong")) &&
            (char === "y" || char === "p" || char === "q" || char === "g")
          ) {
            offsetY -= 25;
            console.log(
              `[DEBUG] Using cwTeXQYuan, cwTeXQHei, cwTeXQKai, cwTeXQFangsong offsetY: ${offsetY}`,
            );
          }

          // ShuoWen 全形字的Y偏移量要多50px，但半形字不要多
          if (fontName.includes("ShuoWen") && !isHalfWidth) {
            offsetY += 50;
            console.log(`[DEBUG] Using ShuoWen full-width offsetY: ${offsetY}`);
          }

          // ShuoWen 半形字的Y偏移量要減10px，X偏移量要減50px
          if (fontName.includes("ShuoWen") && isHalfWidth) {
            offsetY -= 10;
            offsetX -= 50;
            console.log(
              `[DEBUG] Using ShuoWen half-width offsetX: ${offsetX}, offsetY: ${offsetY}`,
            );
          }

          if (fontName.includes("HanWang") && isHalfWidth) {
            offsetX += 20;
            console.log(
              `[DEBUG] Using ShuoWen half-width offsetX: ${offsetX}, offsetY: ${offsetY}`,
            );
          }

          // HanWangKanDaYan, HanWangKanTan, HanWangZonYi 的半形字X偏移量要減20px
          if (
            (fontName.includes("HanWangKanDaYan") ||
              fontName.includes("HanWangKanTan") ||
              fontName.includes("HanWangZonYi")) &&
            isHalfWidth
          ) {
            offsetX -= 20;
            console.log(
              `[DEBUG] Using HanWangKanDaYan or HanWangKanTan or HanWangZonYi half-width offsetX: ${offsetX}, offsetY: ${offsetY}`,
            );
          }

          console.log(
            `[DEBUG] Character ${char} position: font=${fontName}, isHalfWidth=${isHalfWidth}, adjustX=${halfWidthAdjustX}, offsetX=${offsetX}, offsetY=${offsetY}, scale=${scale}`,
          );

          // 簡單的 transform
          const combinedTransform = `translate(${offsetX}, ${offsetY}) scale(${scale})`;

          textElements.push(`
						<g transform="${combinedTransform}">
							<path d="${pathData}" fill="#000"/>
						</g>
					`);
        } else {
          console.log(`[DEBUG] No path element found in SVG for ${char}`);
          // 如果找不到 path 元素，使用 fallback 文字
          usedFallbackGlyph = true;
          textElements.push(`
						<text x="${x}" y="${y}" dy="0.35em" font-family="${FALLBACK_FONT_FAMILY}, serif" font-size="355px" fill="#000" text-anchor="middle">${char}</text>
					`);
        }
      } else {
        console.log(`[DEBUG] SVG object not found for ${char} at path: ${svgPath}`);
        // 如果找不到 SVG 檔案，使用 fallback 文字
        usedFallbackGlyph = true;
        textElements.push(`
					<text x="${x}" y="${y}" dy="0.35em" font-family="${FALLBACK_FONT_FAMILY}, serif" font-size="355px" fill="#000" text-anchor="middle">${char}</text>
				`);
      }
    } catch (error) {
      console.error(
        `[DEBUG] Error loading SVG for character ${char} (U+${unicode.toString(16)}):`,
        error,
      );
      // 使用 fallback 文字
      usedFallbackGlyph = true;
      textElements.push(`
				<text x="${x}" y="${y}" dy="0.35em" font-family="${FALLBACK_FONT_FAMILY}, serif" font-size="355px" fill="#000" text-anchor="middle">${char}</text>
			`);
    }
  }

  console.log(`[DEBUG] Total text elements generated: ${textElements.length}`);

  // romanize=1 字圖標註（RESCOPE #169）：呼叫端已完成 lang 驗證與整詞羅馬拼音
  // 查詢（見 fetchWholeWordRomanization），這裡只負責裁切、跳脫與版面。空字串
  // （未帶 romanization、或查無資料）完全不影響輸出——finalHeight 等於原本的
  // svgHeight，captionElement 是空字串，緊接在 textElements 之後不留任何多餘
  // 空白，維持與 romanize 功能加入前逐位元組相同的輸出（byte-identical）。
  const CAPTION_MAX_CODEPOINTS = 40;
  const CAPTION_BAND_HEIGHT = 120;
  const trimmedRomanization = String(romanization ?? "").trim();
  const cappedRomanization = (() => {
    if (!trimmedRomanization) return "";
    const codepoints = Array.from(trimmedRomanization);
    return codepoints.length > CAPTION_MAX_CODEPOINTS
      ? `${codepoints.slice(0, CAPTION_MAX_CODEPOINTS).join("")}…`
      : trimmedRomanization;
  })();
  const hasCaption = cappedRomanization.length > 0;
  const finalHeight = svgHeight + (hasCaption ? CAPTION_BAND_HEIGHT : 0);
  const captionElement = hasCaption
    ? `<text x="${svgWidth / 2}" y="${svgHeight + CAPTION_BAND_HEIGHT / 2}" dy="0.35em" font-family="${CAPTION_FONT_FAMILY}, serif" font-size="56px" fill="#000" text-anchor="middle">${escapeXmlText(cappedRomanization)}</text>`
    : "";

  const finalSVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${svgWidth}" height="${finalHeight}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${finalHeight}">
	<rect width="${svgWidth}" height="${finalHeight}" fill="#F0F0F0"/>
	${gridElements.join("")}
	${textElements.join("")}${captionElement}
</svg>`;

  console.log(
    `[DEBUG] Final SVG generated, grid elements: ${gridElements.length}, text elements: ${textElements.length}`,
  );
  console.log(`[DEBUG] SVG dimensions: ${svgWidth}x${finalHeight}`);
  console.log(`[DEBUG] Text element content: ${textElements[0] || "No text elements"}`);

  return { svg: finalSVG, usedFallbackGlyph, hasCaption };
}

/**
 * 生成簡單的文字 SVG（保留作為 fallback）
 */
export function generateSimpleTextSVG(text: string, font: string): string {
  void font;
  const chars = Array.from(text);
  const { width, height } = calculateLayout(chars.length);
  const cellSize = 375;
  const charWidth = 360; // 九宮格間距
  const gridSize = 355; // 九宮格大小

  // 計算 SVG 尺寸 - 使用原本的正方形邏輯
  const svgWidth = width * 375; // 原本的邏輯：w * 375
  const svgHeight = width * 375; // 原本的邏輯：w * 375（正方形）

  // 計算 padding，讓內容在正方形中垂直居中
  const padding = (width - height) / 2;

  // 計算 margin，讓左右留白一致（原本的邏輯）
  const margin = (width * 15) / 2;

  // 生成九宮格背景
  const gridElements = [];
  for (let i = 0; i < width * height; i++) {
    const row = Math.floor(i / width);
    const col = i % width;
    // 計算九宮格位置：使用原本的邏輯，考慮 padding
    const x = margin + col * charWidth - (i % width) * 10;
    const y = 10 + (padding + row) * cellSize;

    const char = chars[i];

    if (!char || char === " ") {
      continue;
    } else {
      gridElements.push(`
				<rect x="${x}" y="${y}" width="${gridSize}" height="${gridSize}"
					fill="#F9F6F6" stroke="#A33" stroke-width="5"/>
				<line x1="${x}" y1="${y + 118}" x2="${x + gridSize}" y2="${y + 118}" stroke="#A33" stroke-width="2"/>
				<line x1="${x}" y1="${y + 236}" x2="${x + gridSize}" y2="${y + 236}" stroke="#A33" stroke-width="2"/>
				<line x1="${x + 118}" y1="${y}" x2="${x + 118}" y2="${y + gridSize}" stroke="#A33" stroke-width="2"/>
				<line x1="${x + 236}" y1="${y}" x2="${x + 236}" y2="${y + gridSize}" stroke="#A33" stroke-width="2"/>
			`);
    }
  }

  // 生成文字元素 - 使用 <text> 元素
  const textElements = [];
  for (let i = 0; i < chars.length && i < width * height; i++) {
    const char = chars[i];
    const row = Math.floor(i / width);
    const col = i % width;
    // 計算文字位置：使用原本的邏輯，考慮 padding
    const x = margin + col * charWidth + charWidth / 2 - (i % width) * 10;
    const y = 10 + (padding + row) * cellSize + cellSize / 2 - 30;

    textElements.push(`
			<text x="${x}" y="${y}" dy="0.35em">${char}</text>
		`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">
	<defs>
		<style>
			text {
				font-family: serif, Times, Times New Roman, Arial, sans-serif;
				font-size: 355px;
				fill: #000;
				text-anchor: middle;
				/* Safari 特殊處理 */
				-webkit-font-smoothing: antialiased;
				-moz-osx-font-smoothing: grayscale;
			}
		</style>
	</defs>
	<rect width="${svgWidth}" height="${svgHeight}" fill="#F0F0F0"/>
	${gridElements.join("")}
	${textElements.join("")}
</svg>`;
}

/**
 * 生成錯誤 SVG
 */
function generateErrorSVG(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="400" height="200" xmlns="http://www.w3.org/2000/svg">
	<rect width="400" height="200" fill="#f0f0f0" stroke="#ccc" stroke-width="2"/>
	<text x="200" y="100" text-anchor="middle" font-size="16" font-family="Arial" fill="#666">${message}</text>
</svg>`;
}

/**
 * 計算佈局尺寸
 * 複製原本 moedict-webkit 的邏輯
 * @param charCount Unicode 碼點數（呼叫端需以 Array.from(text).length 計算，
 *   避免增補平面字元的 surrogate pair 被誤算成 2 個字）
 */
function calculateLayout(charCount: number): LayoutDimensions {
  const len = Math.min(charCount, 50);

  // 原本的邏輯：4個字符以內排成一行
  let width = len;

  // 超過4個字符才開始計算換行
  if (width > 4) {
    width = Math.ceil(len / Math.sqrt(len * 0.5));
  }

  const height = Math.ceil(len / width);

  // 確保高度不超過寬度（原本的邏輯）
  const finalHeight = Math.min(height, width);

  return { width, height: finalHeight, rows: finalHeight, cols: width };
}
