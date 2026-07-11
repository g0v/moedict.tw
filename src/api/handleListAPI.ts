import { CACHE_CONTROL, listTagsForLang } from "./cache";
import {
  stripLangPrefix,
  tryDecodeURIComponent,
  type DictionaryLang as Lang,
} from "../utils/dictionary-route";
/**
 * 分類詞彙列表 API
 * 處理 /api/={類名}、/api/'={類名}、/api/:={類名}、/api/~={類名} 的請求
 * 從 R2 讀取對應 JSON 陣列並回傳
 */

interface ListEnv {
  DICTIONARY: {
    get(key: string): Promise<{ text(): Promise<string> } | null>;
  };
}

interface ParsedList {
  lang: Lang;
  category: string;
}

/**
 * 從 /api/ 後的路徑段解析語言和分類名稱。
 * 路徑格式（`.json` 副檔名為選配，README 文件化的兩種形式都接受）：
 *   =成語 / =成語.json        → lang='a', category='成語'
 *   '=諺語 / '=諺語.json      → lang='t', category='諺語'
 *   :=諺語                    → lang='h', category='諺語'
 *   ~=同實異名                → lang='c', category='同實異名'
 * 壞的 percent-encoding（decodeURIComponent 會丟例外）fail-closed 回 null，
 * 不得讓例外往上冒成 500。語言前綴規則統一委派 stripLangPrefix
 * （此路由不接受 legacy `!` 別名，維持既有行為）。
 */
export function parseListPath(pathname: string): ParsedList | null {
  const raw = tryDecodeURIComponent(pathname.replace(/^\/api\//, ""));
  if (raw === null) return null;
  const { lang, rest } = stripLangPrefix(raw);

  if (!rest.startsWith("=")) return null;

  const category = rest.slice(1).replace(/\.json$/, "");
  if (!category) return null;

  return { lang, category };
}

/**
 * Worker dispatch 的列表路由閘門：去掉語言前綴後以 `=` 開頭即視為列表
 * 路由——含格式錯誤的（空分類、壞 percent-encoding 如 /api/=%），一律
 * 交給 handleListAPI 回 400，而不是漏到其他路由。解不開的路徑改用
 * 未解碼原字串判斷前綴形狀。
 */
export function isListPath(pathname: string): boolean {
  const seg = pathname.replace(/^\/api\//, "");
  const candidate = tryDecodeURIComponent(seg) ?? seg;
  return stripLangPrefix(candidate).rest.startsWith("=");
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

export async function handleListAPI(request: Request, url: URL, env: ListEnv): Promise<Response> {
  const parsed = parseListPath(url.pathname);

  if (!parsed) {
    return jsonResponse({ error: "Bad Request", message: "路徑格式錯誤" }, 400);
  }

  const { lang, category } = parsed;

  // R2 key 格式：{lang}/={category}.json，例如 a/=成語.json
  const key = `${lang}/=${category}.json`;

  console.log(`[ListAPI] 查詢 R2 key: ${key}`);

  const obj = await env.DICTIONARY.get(key);

  if (!obj) {
    return jsonResponse({ error: "Not Found", message: `找不到分類：${category}` }, 404);
  }

  const data = await obj.text();

  // 驗證資料為 JSON 陣列
  let parsed_data: unknown;
  try {
    parsed_data = JSON.parse(data);
  } catch {
    return jsonResponse({ error: "Internal Error", message: "資料格式異常" }, 500);
  }

  if (!Array.isArray(parsed_data)) {
    return jsonResponse({ error: "Internal Error", message: "資料非陣列格式" }, 500);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(),
  };
  if (request.method === "GET" || request.method === "HEAD") {
    headers["Cache-Control"] = CACHE_CONTROL.list;
    headers["Cache-Tag"] = listTagsForLang(lang);
  }

  return new Response(data, {
    status: 200,
    headers,
  });
}
