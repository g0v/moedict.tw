import { handleDictionaryAPI } from "../src/api/handleDictionaryAPI";
import { lookupDictionaryEntry } from "../src/api/handleDictionaryAPI";
import { handleListAPI, isListPath } from "../src/api/handleListAPI";
import { handleLookupAPI } from "../src/api/handleLookupAPI";
import { handleStrokeAPI, peekStrokeCorpusDigest } from "../src/api/handleStrokeAPI";
import { handleOEmbedAPI } from "../src/oembed/handle-oembed-api";
import { handleEmbedPage } from "../src/oembed/handle-embed-page";
import { escapeHeadContent, resolveHeadByPath } from "../src/ssr/head";
import { handleImageGeneration } from "../src/utils/image-generation";
import { CACHE_CONTROL, handleCachePurge } from "../src/api/cache";
import { handleCnsAPI } from "../src/api/handleCnsAPI";
import type { CachePurger } from "../src/api/cache";
import {
  buildDefinitionDescription,
  parseDictionaryRoute,
  type DictionaryEntryLike,
} from "../src/utils/dictionary-route";
import {
  getVersionHeaders,
  renderHtmlShellWithFallback,
  serveAssetWithFallback,
} from "../src/api/release-fallback";

export interface ZoneCachePurgerEnv {
  /** Cloudflare API token with Zone Cache Purge permission. */
  CLOUDFLARE_API_TOKEN?: string;
}

interface Env extends ZoneCachePurgerEnv {
  /** wrangler vars：靜態資源公開端；見 /api/config.assetBaseUrl、/assets/* 代理 */
  ASSET_BASE_URL?: string;
  /** wrangler vars：僅注入 /api/config.dictionaryBaseUrl；目前無前端使用 */
  DICTIONARY_BASE_URL?: string;
  /** Secret for POST /api/cache/purge (Bearer or X-Cache-Purge-Token). */
  CACHE_PURGE_TOKEN?: string;
  DICTIONARY: R2Bucket;
  /** R2 bucket for legacy /assets/* proxying, the App-Store badge, and manifest.appcache. */
  ASSETS: R2Bucket;
  /**
   * Cloudflare's managed static-assets Fetcher (the SPA bundle in dist/client) —
   * see wrangler.jsonc `assets.binding`. MUST be a distinct name from ASSETS
   * above: wrangler only creates a static-assets env binding when
   * `assets.binding` is explicitly set, and it was never set here, so no
   * Fetcher named ASSETS ever existed in production — `env.ASSETS` was
   * always just the R2 bucket. getAssetsFetcher() therefore always
   * returned null, so renderHtmlShell()/injectHeadMetadata() never ran no
   * matter how the route reached the Worker (g0v/moedict.tw#131).
   */
  SITE_ASSETS?: Fetcher;
  FONTS: R2Bucket;
  /**
   * Cloudflare Workers version metadata binding (`version_metadata` in
   * wrangler.jsonc). Provides {id, tag, timestamp} where `id` is the
   * Cloudflare version UUID and `tag` is the release ID we set via
   * `wrangler versions upload --tag <release>`.
   */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}

async function injectHeadMetadata(html: string, pathname: string, env: Env): Promise<string> {
  const head = resolveHeadByPath(pathname);
  const dictionaryRoute = parseDictionaryRoute(pathname);
  if (dictionaryRoute?.text) {
    const entry = await lookupDictionaryEntry(dictionaryRoute.text, dictionaryRoute.lang, env);
    const richDescription = buildDefinitionDescription(entry as DictionaryEntryLike | null);
    if (richDescription) {
      head.description = richDescription;
      head.ogDescription = richDescription;
    }
  }

  const title = escapeHeadContent(head.title);
  const description = escapeHeadContent(head.description);
  const ogTitle = escapeHeadContent(head.ogTitle);
  const ogDescription = escapeHeadContent(head.ogDescription);
  const ogUrl = escapeHeadContent(head.ogUrl);
  const ogImage = escapeHeadContent(head.ogImage);
  const ogImageType = escapeHeadContent(head.ogImageType);
  const ogImageWidth = escapeHeadContent(head.ogImageWidth);
  const ogImageHeight = escapeHeadContent(head.ogImageHeight);
  const twitterImage = escapeHeadContent(head.twitterImage);
  const twitterSite = escapeHeadContent(head.twitterSite);
  const twitterCreator = escapeHeadContent(head.twitterCreator);

  const oembedApiUrl = `https://www.moedict.tw/api/oembed?url=${encodeURIComponent(head.ogUrl)}&format=json`;
  const oembedLink = dictionaryRoute?.text
    ? `<link rel="alternate" type="application/json+oembed" href="${escapeHeadContent(oembedApiUrl)}" title="${title}" />\n  </head>`
    : "</head>";

  return html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`)
    .replace(
      /<meta\s+name=["']description["'][^>]*>/i,
      `<meta name="description" content="${description}" />`,
    )
    .replace(
      /<meta\s+property=["']og:title["'][^>]*>/i,
      `<meta property="og:title" content="${ogTitle}" />`,
    )
    .replace(
      /<meta\s+property=["']og:description["'][^>]*>/i,
      `<meta property="og:description" content="${ogDescription}" />`,
    )
    .replace(
      /<meta\s+property=["']og:url["'][^>]*>/i,
      `<meta property="og:url" content="${ogUrl}" />`,
    )
    .replace(
      /<meta\s+property=["']og:image["'][^>]*>/i,
      `<meta property="og:image" content="${ogImage}" />`,
    )
    .replace(
      /<meta\s+property=["']og:image:type["'][^>]*>/i,
      `<meta property="og:image:type" content="${ogImageType}" />`,
    )
    .replace(
      /<meta\s+property=["']og:image:width["'][^>]*>/i,
      `<meta property="og:image:width" content="${ogImageWidth}" />`,
    )
    .replace(
      /<meta\s+property=["']og:image:height["'][^>]*>/i,
      `<meta property="og:image:height" content="${ogImageHeight}" />`,
    )
    .replace(
      /<meta\s+name=["']twitter:title["'][^>]*>/i,
      `<meta name="twitter:title" content="${ogTitle}" />`,
    )
    .replace(
      /<meta\s+name=["']twitter:description["'][^>]*>/i,
      `<meta name="twitter:description" content="${ogDescription}" />`,
    )
    .replace(
      /<meta\s+name=["']twitter:image["'][^>]*>/i,
      `<meta name="twitter:image" content="${twitterImage}" />`,
    )
    .replace(
      /<meta\s+name=["']twitter:site["'][^>]*>/i,
      `<meta name="twitter:site" content="${twitterSite}" />`,
    )
    .replace(
      /<meta\s+name=["']twitter:creator["'][^>]*>/i,
      `<meta name="twitter:creator" content="${twitterCreator}" />`,
    )
    .replace("</head>", oembedLink);
}

function isViteInternalRequest(url: URL): boolean {
  const { pathname, searchParams } = url;
  // Real Vite dev-server internal paths are always namespaced
  // (/@vite/client, /@vite/env, /@fs/…, /@id/…, /@react-refresh) — a bare
  // `/@`-prefixed check here would also swallow moedict's own /@<radical>
  // and /~@<radical> app routes, which is exactly what happened once
  // run_worker_first started routing those through the Worker instead of
  // letting the platform's static-assets layer serve them directly.
  if (
    pathname.startsWith("/@vite/") ||
    pathname.startsWith("/@fs/") ||
    pathname.startsWith("/@id/") ||
    pathname === "/@react-refresh" ||
    pathname.startsWith("/node_modules/")
  )
    return true;
  return (
    searchParams.has("html-proxy") ||
    searchParams.has("import") ||
    searchParams.has("raw") ||
    searchParams.has("url") ||
    searchParams.has("worker_file")
  );
}

export function shouldRenderHtmlShell(request: Request, url: URL): boolean {
  const { pathname } = url;
  console.log("🔍 [Index] 判斷是否需要渲染 HTML 殼:", pathname);
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (pathname.startsWith("/api/")) return false;
  if (pathname.endsWith(".json")) return false;
  if (pathname.startsWith("/assets/")) return false;
  if (isViteInternalRequest(url)) return false;
  if (/\.[a-zA-Z0-9]+$/.test(pathname) && pathname !== "/about.html" && pathname !== "/index.html")
    return false;
  console.log("🔍 [Index] 需要渲染 HTML 殼:", pathname);
  return true;
}

function getAssetsBucket(env: Env): R2Bucket | null {
  const candidate = env.ASSETS;
  if (!candidate || typeof candidate !== "object" || !("get" in candidate)) return null;
  if (typeof candidate.get !== "function") return null; /* v8 ignore next */
  return candidate as R2Bucket;
}

const CONFIG_API_CACHE_CONTROL = "public, max-age=60, s-maxage=300";

/** Fixed CORS for public config / dictionary / static GETs under Workers Cache. */
const PUBLIC_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function respondWithConfigApi(
  _request: Request,
  env: Env,
  _ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  // Env-backed but effectively static per deploy (values only change with a
  // release). This was `no-store` and /api/config was the single most
  // requested path on the zone (~3.5M/week), each hit invoking the Worker.
  // Short TTLs are safe: deploy/rollback probes always cache-bust
  // (scripts/lib/smoke-probe.mjs `_probe` param), so rollout verification
  // never reads a stale cached config.
  return new Response(
    JSON.stringify({
      assetBaseUrl: env.ASSET_BASE_URL || "",
      dictionaryBaseUrl: env.DICTIONARY_BASE_URL || "",
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": CONFIG_API_CACHE_CONTROL,
        ...PUBLIC_CORS_HEADERS,
      },
    },
  );
}

/**
 * Pure-function worker entry point — same body as the default export's
 * fetch handler, extracted so unit tests can call it with a mock env
 * (vitest's v8 coverage collector can't see into Miniflare's workerd
 * isolate, but it *can* instrument this function when imported directly).
 * The default export below is a one-line wrapper that preserves the
 * `ExportedHandler<Env>` contract for the real deployment.
 */
async function dispatchCore(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  console.log("🔍 [Index] 開始處理請求:", request.url);
  const url = new URL(request.url);
  console.log(url.pathname);

  // 處理 OPTIONS 預檢請求（CORS preflight）
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...PUBLIC_CORS_HEADERS,
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  if (url.pathname === "/robots.txt" && (request.method === "GET" || request.method === "HEAD")) {
    const body = [
      "User-agent: *",
      "Disallow: /api/",
      "Disallow: /*.json$",
      "Disallow: /*.png$",
      "Allow: /",
    ].join("\n");
    const headers = new Headers({
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    });
    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }
    return new Response(body, { status: 200, headers });
  }

  // 特殊路由：moetris 方塊遊戲已搬遷至 dodo 子網域，302 重導向（#123）
  if (url.pathname === "/moetris" || url.pathname === "/moetris/") {
    return new Response(null, {
      status: 302,
      headers: {
        Location: "https://dodo.moedict.tw/moetris.html",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  // 特殊路由：oEmbed 嵌入頁（/embed/<word>）— 見 src/oembed/handle-embed-page.ts
  if (url.pathname === "/embed" || url.pathname.startsWith("/embed/")) {
    return handleEmbedPage(request, url, env);
  }

  // 舊版 7 端點相容（/a /t /h /c /raw /uni /pua，README.md「目前 API 已有
  // 7 個端點」文件範例網址不帶 .json；已支援的 .json 版本見下方 handleDictionaryAPI
  // 的 parseSubRoute）。只攔截真的匹配這 7 個字首的兩段式路徑，避免影響單段
  // 詞條路由（例如查詢字面詞彙「a」本身仍走 /:text 一般流程）。
  if (/^\/(?:a|t|h|c|raw|uni|pua)\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith(".json")) {
    return handleDictionaryAPI(request, url, env);
  }

  // lookup API（台語羅馬拼音索引 / 舊站 trs 相容）
  const lookupResponse = await handleLookupAPI(request, url, env);
  if (lookupResponse) {
    return lookupResponse;
  }

  // 特殊路由：App Store 下載圖片（從 R2 ASSETS 讀取）
  if (url.pathname === "/images/Download_on_the_App_Store_Badge_HK_TW_135x40.png") {
    console.log("🔍 [Index] 處理圖片請求:", url.pathname);
    const bucket = env.ASSETS;
    const key = url.pathname.replace("/assets/", "").replace("/images/", "");
    const obj = await (bucket as R2Bucket).get(key);
    if (!obj) {
      return new Response("Not Found", { status: 404 });
    }
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("Content-Type", "image/png");
    headers.set("Cache-Control", CACHE_CONTROL.staticDay);
    headers.set("Cache-Tag", "assets");
    headers.set("etag", obj.httpEtag);
    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }
    return new Response(obj.body, { status: 200, headers });
  }
  // 特殊路由：Manifest AppCache（從 R2 ASSETS 讀取）
  if (url.pathname === "/manifest.appcache") {
    const bucket = env.ASSETS;
    const key = "manifest.appcache";
    const obj = await (bucket as R2Bucket).get(key);
    if (!obj) {
      return new Response("Not Found", { status: 404 });
    }
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("Content-Type", "text/cache-manifest; charset=utf-8");
    headers.set("Cache-Control", CACHE_CONTROL.staticDay);
    headers.set("Cache-Tag", "appcache");
    headers.set("etag", obj.httpEtag);
    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }
    return new Response(obj.body, { status: 200, headers });
  }

  // 特殊路由：CFDict XML（從字典 R2 讀取）
  if (url.pathname === "/translation-data/cfdict.xml") {
    const corsHeaders = PUBLIC_CORS_HEADERS;
    const bucket = env.DICTIONARY;
    const key = "translation-data/cfdict.xml";
    const obj = await bucket.get(key);
    if (!obj) {
      return new Response("Not Found", {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          ...corsHeaders,
        },
      });
    }
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("Content-Type", "application/xml; charset=utf-8");
    headers.set("Content-Disposition", 'attachment; filename="cfdict.xml"');
    headers.set("Cache-Control", CACHE_CONTROL.translation);
    headers.set("Cache-Tag", "translation,translation-cfdict");
    headers.set("etag", obj.httpEtag);
    Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }
    return new Response(obj.body, { status: 200, headers });
  }

  // 特殊路由：CFDict TXT（從字典 R2 讀取，強制 UTF-8）
  if (url.pathname === "/translation-data/cfdict.txt") {
    const corsHeaders = PUBLIC_CORS_HEADERS;
    const bucket = env.DICTIONARY;
    const key = "translation-data/cfdict.txt";
    const obj = await bucket.get(key);
    if (!obj) {
      return new Response("Not Found", {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          ...corsHeaders,
        },
      });
    }
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("Content-Type", "text/plain; charset=utf-8");
    headers.set("Cache-Control", CACHE_CONTROL.translation);
    headers.set("Cache-Tag", "translation,translation-cfdict");
    headers.set("etag", obj.httpEtag);
    Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }
    return new Response(obj.body, { status: 200, headers });
  }

  if (url.pathname.startsWith("/api/") || url.pathname.endsWith(".json")) {
    console.log("🔍 [Index] 處理 API 請求:", url.pathname);
    const corsHeaders = PUBLIC_CORS_HEADERS;
    if (url.pathname === "/api/cache/purge") {
      const purge = createZoneCachePurger(env);
      return handleCachePurge(request, { env, purge });
    }

    // 提供配置資訊 API（vars → JSON；ASSET 前端有讀取，DICTIONARY 目前僅回傳未使用）
    if (url.pathname === "/api/config") {
      console.log("🔍 [Index] 提供配置資訊");
      return respondWithConfigApi(request, env, ctx);
    }

    // Tokenless oEmbed API（/api/oembed?url=...）— 見 src/oembed/handle-oembed-api.ts
    if (url.pathname === "/api/oembed") {
      return handleOEmbedAPI(request, url, env);
    }

    // 全文檢索索引 API（從 DICTIONARY R2 讀取 search-index/{lang}.json）
    const searchIndexMatch = url.pathname.match(/^\/api\/search-index\/([athc])\.json$/);
    if (searchIndexMatch) {
      const lang = searchIndexMatch[1];
      const key = `search-index/${lang}.json`;
      const obj = await env.DICTIONARY.get(key);
      if (!obj) {
        return new Response(
          JSON.stringify({ error: "Not Found", message: `找不到全文索引：${key}` }),
          {
            status: 404,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              ...corsHeaders,
            },
          },
        );
      }
      const content = await obj.text();
      return new Response(content, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": CACHE_CONTROL.searchIndex,
          "Cache-Tag": `search-index,search-index-${lang}`,
          ...corsHeaders,
        },
      });
    }

    // Sidebar 搜尋索引 API（從 DICTIONARY R2 讀取各語系 index.json）
    const indexMatch = url.pathname.match(/^\/api\/index\/([athc])\.json$/);
    if (indexMatch) {
      const lang = indexMatch[1];
      const key = `${lang}/index.json`;
      const obj = await env.DICTIONARY.get(key);

      if (!obj) {
        return new Response(
          JSON.stringify({ error: "Not Found", message: `找不到索引檔：${key}` }),
          {
            status: 404,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              ...corsHeaders,
            },
          },
        );
      }

      const content = await obj.text();
      return new Response(content, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": CACHE_CONTROL.index,
          "Cache-Tag": `index,index-${lang}`,
          ...corsHeaders,
        },
      });
    }

    // 跨語言 xref 索引 API（從 DICTIONARY R2 讀取各語系 xref.json）
    const xrefMatch = url.pathname.match(/^\/api\/xref\/([athc])\.json$/);
    if (xrefMatch) {
      const lang = xrefMatch[1];
      const key = `${lang}/xref.json`;
      const obj = await env.DICTIONARY.get(key);

      if (!obj) {
        return new Response("{}", {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": CACHE_CONTROL.xref,
            "Cache-Tag": `xref,xref-${lang}`,
            ...corsHeaders,
          },
        });
      }

      const content = await obj.text();
      return new Response(content, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": CACHE_CONTROL.xref,
          "Cache-Tag": `xref,xref-${lang}`,
          ...corsHeaders,
        },
      });
    }

    // ID-aware xref sidecar（目前只有台語 t/xref-by-id.json）
    const xrefByIdMatch = url.pathname.match(/^\/api\/xref-by-id\/([athc])\.json$/);
    if (xrefByIdMatch) {
      const lang = xrefByIdMatch[1];
      const key = `${lang}/xref-by-id.json`;
      const obj = await env.DICTIONARY.get(key);

      if (!obj) {
        return new Response("{}", {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": CACHE_CONTROL.xref,
            "Cache-Tag": `xref,xref-${lang}`,
            ...corsHeaders,
          },
        });
      }

      const content = await obj.text();
      return new Response(content, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": CACHE_CONTROL.xref,
          "Cache-Tag": `xref,xref-${lang}`,
          ...corsHeaders,
        },
      });
    }

    // 筆順 JSON（/api/stroke-json/{codepoint}.json）— 直接從 ASSETS R2 讀取
    if (url.pathname.startsWith("/api/stroke-json/")) {
      return handleStrokeAPI(request, url, env, corsHeaders);
    }

    // CNS11643 屬性後備 API（/api/cns/{char}.json）——
    // 必須在通用 .json catch-all 之前，否則永遠不會到達
    if (url.pathname.startsWith("/api/cns/") && url.pathname.endsWith(".json")) {
      return handleCnsAPI(request, url, env);
    }

    // 分類詞彙列表 API（=成語、'=諺語、:=諺語、~=同實異名，選配 .json）——
    // 判斷與解析統一在 handleListAPI 的 isListPath/parseListPath（安全 decode）
    if (isListPath(url.pathname)) {
      console.log("🔍 [Index] 處理列表 API 請求:", url.pathname);
      return handleListAPI(request, url, env);
    }

    // 字典 JSON API 路由
    if (url.pathname.endsWith(".json") && !url.pathname.startsWith("/assets/")) {
      console.log("🔍 [Index] 處理字典 API 請求:", url.pathname);
      const response = await handleDictionaryAPI(request, url, env);
      if (response) {
        return response;
      } else {
        console.warn("⚠️ [Index] 字典 API 處理失敗，返回 404:", url.pathname);
        return new Response("Not Found", { status: 404 });
      }
    }

    return Response.json({
      name: "Cloudflare",
    });
  }

  if (shouldRenderHtmlShell(request, url)) {
    return await renderHtmlShellWithFallback(request, env, url.pathname, injectHeadMetadata);
  }

  const staticResponse = await serveAssetWithFallback(request, env);
  if (staticResponse) {
    return staticResponse;
  }

  // ASSETS 找不到時，才回退到 R2 代理舊版靜態資源（字體、圖片等）；URL 來自 vars.ASSET_BASE_URL
  if (env.ASSET_BASE_URL && url.pathname.startsWith("/assets/")) {
    const assetPath = url.pathname.replace("/assets/", "");
    const assetUrl = `${env.ASSET_BASE_URL}/${assetPath}${url.search}`;

    console.log("🔍 [Index] 代理靜態資源請求:", assetUrl);

    return fetch(assetUrl, {
      method: request.method,
      headers: {
        // 只傳遞必要的 headers
        "User-Agent": request.headers.get("User-Agent") || "Cloudflare-Worker",
      },
    })
      .then((response) => {
        const newHeaders = new Headers(response.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        newHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        newHeaders.set("Access-Control-Allow-Headers", "Content-Type");
        newHeaders.delete("Access-Control-Allow-Credentials");
        // A miss here is either the upstream legacy bucket genuinely
        // lacking the file, or (for a freshly-deployed hashed bundle
        // asset) a brief SITE_ASSETS propagation race — neither should be
        // edge-cacheable, or a transient 404 can outlive its transience.
        if (!response.ok) {
          newHeaders.set("Cache-Control", "no-store");
        }

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      })
      .catch((error) => {
        console.error("代理請求失敗:", error);
        return new Response("代理請求失敗", {
          status: 502,
          headers: { "Cache-Control": "no-store" },
        });
      });
  }

  const isPngRequest = url.pathname.endsWith(".png");
  if (isPngRequest) {
    return await handleImageGeneration(url, {
      FONTS: env.FONTS,
      ASSETS: getAssetsBucket(env) ?? undefined,
      DICTIONARY: env.DICTIONARY,
    });
  }

  return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}

/**
 * Edge-cacheability predicate for Worker-generated responses.
 *
 * Cloudflare does NOT edge-cache Worker responses on its own — every
 * `s-maxage` in src/api/cache.ts was decorative until dispatch() started
 * writing through `caches.default` (2026-07 billing audit: bots re-rendered
 * identical PNGs and re-read identical dictionary shards on every hit).
 * Opt-in is response-driven: any GET 200 whose Cache-Control carries a
 * positive s-maxage, except HTML shells (release-fallback correctness
 * depends on fresh shell rendering) and anything no-store/private or
 * carrying Set-Cookie.
 */
export function isEdgeCacheable(request: Request, response: Response): boolean {
  if (request.method !== "GET" || response.status !== 200) return false;
  const cacheControl = response.headers.get("Cache-Control") ?? "";
  if (/\b(?:no-store|private)\b/i.test(cacheControl)) return false;
  if (!/\bs-maxage=[1-9]/i.test(cacheControl)) return false;
  if (response.headers.has("Set-Cookie")) return false;
  const contentType = response.headers.get("Content-Type") ?? "";
  return !contentType.includes("text/html");
}

/**
 * Internal query param namespacing the `/api/stroke-json/*` edge-cache key
 * by the current atomic corpusDigest (src/utils/stroke-corpus.ts). Never
 * appears on the public request URL, response body, or any client-visible
 * header — it exists ONLY inside the synthetic `Request` object passed to
 * `caches.default.match`/`.put`.
 */
const STROKE_EDGE_CACHE_DIGEST_PARAM = "__moedict_stroke_digest";

/**
 * Build the `caches.default` lookup/write key for a GET request.
 *
 * Every route except `/api/stroke-json/*.json` keeps the request itself as
 * its cache key — unchanged from before this fix.
 *
 * For stroke-json, `CACHE_PURGE_TOKEN` (the only mechanism that could
 * otherwise invalidate a stale edge entry) is a Worker secret that is not
 * available to the corpus-upload pipeline (`promoteCorpusPointer` runs as
 * a local operator CLI, never as the Worker), so cache identity is fixed
 * at the source instead: this key carries the CURRENT atomic
 * `corpusDigest`, resolved via {@link peekStrokeCorpusDigest} — the exact
 * same per-isolate WeakMap-cached resolver `handleStrokeAPI` itself uses,
 * so a warm request performs zero additional R2 reads here. A pointer
 * promotion changes the digest, which changes this key, which means the
 * OLD bare-URL cache entry can NEVER be read again by a post-promotion
 * Worker — it simply ages out on its own `s-maxage` TTL, never served.
 *
 * Returns `null` when the pointer/manifest fails to resolve (missing,
 * malformed, or hash-mismatched) — the caller MUST bypass the edge cache
 * entirely in that case (no read, no write) and let the request fall
 * through to `handleStrokeAPI`, which returns its own fail-closed 503
 * (already `no-store` and non-200, so never edge-cacheable regardless).
 * The only extra latency this adds on the cold/TTL-expired path is
 * `resolveCorpus`'s own pointer+manifest reads — the same cost
 * `handleStrokeAPI` already pays on every cold resolution, not a second
 * one (see the shared WeakMap note above).
 */
async function deriveStrokeJsonEdgeCacheKey(request: Request, env: Env): Promise<Request | null> {
  const bucket = getAssetsBucket(env);
  if (!bucket) return null;
  const digest = await peekStrokeCorpusDigest(bucket);
  if (!digest) return null;
  const keyUrl = new URL(request.url);
  keyUrl.searchParams.set(STROKE_EDGE_CACHE_DIGEST_PARAM, digest);
  return new Request(keyUrl.toString(), request);
}

/**
 * Dispatch boundary: edge-cache read-through, then version-header
 * decoration on every response (API, compatibility, and fallback routes all
 * expose the same metadata without per-route branching), then a best-effort
 * edge-cache write for responses that opt in via `isEdgeCacheable`.
 */
export async function dispatch(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  // Serve straight from the edge cache when a previous dispatch stored this
  // exact cache key. Deploy/rollback probes always carry a unique `_probe`
  // cache-buster, so rollout verification never reads a cached entry. The
  // `caches` global is absent in plain-Node unit tests — the layer degrades
  // to a no-op there (and on *.workers.dev, where cache.put is a no-op).
  //
  // `/api/stroke-json/*` uses a digest-namespaced cache key (see
  // deriveStrokeJsonEdgeCacheKey) instead of the bare request — every other
  // route's cache key is the request itself, unchanged. HEAD requests never
  // enter this layer at all (method !== "GET"), so HEAD/If-None-Match
  // conditional semantics are handled entirely by handleStrokeAPI on a
  // cache miss, exactly as before this fix.
  const edgeCache = typeof caches !== "undefined" ? caches.default : undefined;
  const url = new URL(request.url);
  let cacheKey: Request | null = request;
  if (edgeCache && request.method === "GET") {
    if (url.pathname.startsWith("/api/stroke-json/")) {
      // deriveStrokeJsonEdgeCacheKey's only internal R2 access
      // (peekStrokeCorpusDigest -> resolveCorpus -> resolveCorpusUncached)
      // already catches every failure itself and resolves to `null`
      // rather than throwing — never wrap this in a try/catch here, it
      // would be unreachable dead code.
      cacheKey = await deriveStrokeJsonEdgeCacheKey(request, env);
    }
    if (cacheKey) {
      try {
        const hit = await edgeCache.match(cacheKey);
        if (hit) {
          const headers = new Headers(hit.headers);
          headers.set("X-Moedict-Edge-Cache", "hit");
          return new Response(hit.body, {
            status: hit.status,
            statusText: hit.statusText,
            headers,
          });
        }
      } catch {
        // A cache lookup failure must never take down rendering.
      }
    }
  }
  const response = await dispatchCore(request, env, ctx);
  const headers = new Headers(response.headers);
  const versionHeaders = getVersionHeaders(env.CF_VERSION_METADATA);
  headers.set("X-Moedict-Version", versionHeaders["X-Moedict-Version"]);
  const release = versionHeaders["X-Moedict-Release"];
  if (release) {
    headers.set("X-Moedict-Release", release);
  } else {
    headers.delete("X-Moedict-Release");
  }
  const decorated = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  if (edgeCache && cacheKey && isEdgeCacheable(request, decorated)) {
    // Promise.resolve guards non-conformant Cache stubs (tests stub put as a plain spy).
    const putPromise = Promise.resolve(edgeCache.put(cacheKey, decorated.clone())).catch(() => {
      // Best-effort: a failed put only means the next request re-renders.
    });
    if (ctx) {
      ctx.waitUntil(putPromise);
    } else {
      void putPromise;
    }
  }
  return decorated;
}

/**
 * Zone Cache Purge via the Cloudflare REST API.
 *
 * ctx.cache.purge does not exist on ExecutionContext — the old dispatch
 * path always threw 'ctx.cache.purge unavailable'. This helper calls the
 * real API: POST /zones/{zoneId}/purge_cache with cache tags.
 *
 * Requires env.CLOUDFLARE_API_TOKEN (a token with Zone Cache Purge
 * permission for the moedict.tw zone). The zone ID is the account's only
 * zone; we hardcode it since there is exactly one.
 */
const MOEDICT_TW_ZONE_ID = "208ed37cabff643b306011964e52ad25";

export function createZoneCachePurger(env: ZoneCachePurgerEnv): CachePurger {
  return async (options) => {
    const token = env.CLOUDFLARE_API_TOKEN?.trim();
    if (!token) {
      throw new Error("CLOUDFLARE_API_TOKEN not configured");
    }
    const body: Record<string, unknown> = {};
    if ("purgeEverything" in options && options.purgeEverything === true) {
      body.purge_everything = true;
    } else if ("tags" in options && options.tags && options.tags.length > 0) {
      body.tags = options.tags;
    } else {
      // No-op: nothing to purge
      return;
    }
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${MOEDICT_TW_ZONE_ID}/purge_cache`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Zone purge failed (${resp.status}): ${text.slice(0, 200)}`);
    }
  };
}

export default {
  fetch: (request, env, ctx) => dispatch(request, env, ctx),
} satisfies ExportedHandler<Env>;
