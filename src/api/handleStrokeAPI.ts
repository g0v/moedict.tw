import { CACHE_CONTROL } from "./cache";
import { tryDecodeURIComponent } from "../utils/dictionary-route";

/**
 * Narrow R2 surfaces used by the stroke API. Mirrors the DictionaryBucketLike
 * pattern in handleDictionaryAPI.ts so this file typechecks under
 * tsconfig.app.json (which does not pull in worker-configuration.d.ts).
 */
interface StrokeObjectLike {
  httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
}

interface StrokeObjectBodyLike extends StrokeObjectLike {
  body: ReadableStream;
}

interface StrokeBucketLike {
  head(key: string): Promise<StrokeObjectLike | null>;
  get(
    key: string,
    options?: { onlyIf?: Headers | object },
  ): Promise<StrokeObjectBodyLike | StrokeObjectLike | null>;
}

/**
 * Minimal env surface for the stroke API. Accepts the full Worker Env or a
 * narrow test double — only `ASSETS` is required.
 */
export interface StrokeEnv {
  ASSETS: StrokeBucketLike;
}

/**
 * 筆順 JSON API — 直接讀取 R2 ASSETS 綁定
 *
 * 路由：GET|HEAD /api/stroke-json/{codepoint}.json
 *
 * 與原本的公開 URL 代理版本相比，改用 Worker 的 ASSETS R2 binding 直接讀取，
 * 達成環境隔離：staging 讀 moedict-assets-preview（上傳試驗語料的目標桶），
 * production 讀 moedict-assets（現有語料 + 補充 6,063 字全集）。
 *
 * 支援：
 * - HEAD（R2 head()，不讀 body）
 * - ETag / If-None-Match 條件式 GET（R2 onlyIf 傳入 request headers）
 * - GET body streaming（R2 ReadableStream 直接接進 Response，不緩衝）
 * - CORS（caller 傳入 corsHeaders）
 * - Cache-Control（CACHE_CONTROL.stroke）
 *
 * 無 legacy 公開 URL fallback：新版 full-6,063 語料上傳到各環境的 ASSETS 桶後，
 * 每個環境都應完整讀到自己的桶，不跨環境回退，否則 staging 驗證無意義。
 *
 * R2 key 版面：`stroke-json/{lowercase-hex}.json`（與 media-cdn / migrate 腳本一致）。
 */
export async function handleStrokeAPI(
  request: Request,
  url: URL,
  env: StrokeEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const routePrefix = "/api/stroke-json/";
  // 取出 codepoint 部分，例如 /api/stroke-json/840b.json → 840b.json
  const cp = tryDecodeURIComponent(url.pathname.slice(routePrefix.length)) ?? "";

  // 僅接受單一路徑段，避免多段路徑造成重複請求或錯誤路由
  if (!cp || cp.includes("/") || !/^[0-9a-f]{4,6}\.json$/i.test(cp)) {
    return new Response(
      JSON.stringify({ error: "Bad Request", message: "無效的 codepoint 格式" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders },
      },
    );
  }

  // Normalise to lowercase so R2 keys stay canonical even if the client
  // requests uppercase hex (regex above is case-insensitive).
  const key = `stroke-json/${cp.toLowerCase()}`;

  try {
    // HEAD: metadata only
    if (request.method === "HEAD") {
      const obj = await env.ASSETS.head(key);
      if (!obj) {
        return new Response(null, {
          status: 404,
          headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders },
        });
      }
      const headers = buildStrokeHeaders(obj, corsHeaders);
      return new Response(null, { status: 200, headers });
    }

    // GET: pass request headers so R2 evaluates If-None-Match natively
    const obj = await env.ASSETS.get(key, { onlyIf: request.headers });

    if (!obj) {
      return new Response(
        JSON.stringify({ error: "Not Found", message: `找不到筆畫資料：${cp}` }),
        {
          status: 404,
          headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders },
        },
      );
    }

    // onlyIf not satisfied → R2 returns R2Object (no body) → 304
    if (!("body" in obj) || obj.body == null) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: obj.httpEtag,
          "Cache-Control": CACHE_CONTROL.stroke,
          "Cache-Tag": "stroke",
          ...corsHeaders,
        },
      });
    }

    // Full body — stream, never buffer
    const headers = buildStrokeHeaders(obj, corsHeaders);
    return new Response(obj.body, { status: 200, headers });
  } catch (err) {
    console.error("[handleStrokeAPI] R2 讀取失敗:", err);
    return new Response(JSON.stringify({ error: "Internal Error", message: "筆畫資料讀取失敗" }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders },
    });
  }
}

function buildStrokeHeaders(obj: StrokeObjectLike, corsHeaders: Record<string, string>): Headers {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": CACHE_CONTROL.stroke,
    "Cache-Tag": "stroke",
    ETag: obj.httpEtag,
    ...corsHeaders,
  });
  // Preserve any stored content-type / cache-control from the object, then
  // re-assert our canonical values so missing R2 metadata cannot weaken them.
  obj.writeHttpMetadata(headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", CACHE_CONTROL.stroke);
  headers.set("Cache-Tag", "stroke");
  headers.set("ETag", obj.httpEtag);
  for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
  return headers;
}
