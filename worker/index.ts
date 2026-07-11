import { handleDictionaryAPI } from '../src/api/handleDictionaryAPI';
import { lookupDictionaryEntry } from '../src/api/handleDictionaryAPI';
import { handleListAPI, isListPath } from '../src/api/handleListAPI';
import { handleLookupAPI } from '../src/api/handleLookupAPI';
import { handleStrokeAPI } from '../src/api/handleStrokeAPI';
import { handleOEmbedAPI } from '../src/oembed/handle-oembed-api';
import { handleEmbedPage } from '../src/oembed/handle-embed-page';
import { escapeHeadContent, resolveHeadByPath } from '../src/ssr/head';
import { handleImageGeneration } from '../src/utils/image-generation';
import { CACHE_CONTROL, handleCachePurge } from '../src/api/cache';
import {
  buildDefinitionDescription,
  parseDictionaryRoute,
  type DictionaryEntryLike,
} from '../src/utils/dictionary-route';

interface Env {
	/** wrangler vars：靜態資源公開端；見 /api/config.assetBaseUrl、/assets/* 代理 */
	ASSET_BASE_URL?: string;
	/** wrangler vars：僅注入 /api/config.dictionaryBaseUrl；目前無前端使用 */
	DICTIONARY_BASE_URL?: string;
	/** Secret for POST /api/cache/purge (Bearer or X-Cache-Purge-Token). */
	CACHE_PURGE_TOKEN?: string;
	/** Cloudflare API token with Zone Cache Purge permission (used by the purge helper). */
	CLOUDFLARE_API_TOKEN?: string;
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
    : '</head>';

  return html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`)
    .replace(/<meta\s+name=["']description["'][^>]*>/i, `<meta name="description" content="${description}" />`)
    .replace(/<meta\s+property=["']og:title["'][^>]*>/i, `<meta property="og:title" content="${ogTitle}" />`)
    .replace(/<meta\s+property=["']og:description["'][^>]*>/i, `<meta property="og:description" content="${ogDescription}" />`)
    .replace(/<meta\s+property=["']og:url["'][^>]*>/i, `<meta property="og:url" content="${ogUrl}" />`)
    .replace(/<meta\s+property=["']og:image["'][^>]*>/i, `<meta property="og:image" content="${ogImage}" />`)
    .replace(/<meta\s+property=["']og:image:type["'][^>]*>/i, `<meta property="og:image:type" content="${ogImageType}" />`)
    .replace(/<meta\s+property=["']og:image:width["'][^>]*>/i, `<meta property="og:image:width" content="${ogImageWidth}" />`)
    .replace(/<meta\s+property=["']og:image:height["'][^>]*>/i, `<meta property="og:image:height" content="${ogImageHeight}" />`)
    .replace(/<meta\s+name=["']twitter:title["'][^>]*>/i, `<meta name="twitter:title" content="${ogTitle}" />`)
    .replace(/<meta\s+name=["']twitter:description["'][^>]*>/i, `<meta name="twitter:description" content="${ogDescription}" />`)
    .replace(/<meta\s+name=["']twitter:image["'][^>]*>/i, `<meta name="twitter:image" content="${twitterImage}" />`)
    .replace(/<meta\s+name=["']twitter:site["'][^>]*>/i, `<meta name="twitter:site" content="${twitterSite}" />`)
    .replace(/<meta\s+name=["']twitter:creator["'][^>]*>/i, `<meta name="twitter:creator" content="${twitterCreator}" />`)
    .replace('</head>', oembedLink);
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
    pathname.startsWith('/@vite/') ||
    pathname.startsWith('/@fs/') ||
    pathname.startsWith('/@id/') ||
    pathname === '/@react-refresh' ||
    pathname.startsWith('/node_modules/')
  ) return true;
  return (
    searchParams.has('html-proxy') ||
    searchParams.has('import') ||
    searchParams.has('raw') ||
    searchParams.has('url') ||
    searchParams.has('worker_file')
  );
}

export function shouldRenderHtmlShell(request: Request, url: URL): boolean {
  const { pathname } = url;
  console.log('🔍 [Index] 判斷是否需要渲染 HTML 殼:', pathname);
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (pathname.startsWith('/api/')) return false;
  if (pathname.endsWith('.json')) return false;
  if (pathname.startsWith('/assets/')) return false;
  if (isViteInternalRequest(url)) return false;
  if (/\.[a-zA-Z0-9]+$/.test(pathname) && pathname !== '/about.html' && pathname !== '/index.html') return false;
  console.log('🔍 [Index] 需要渲染 HTML 殼:', pathname);
  return true;
}

async function passThroughAssets(request: Request, env: Env): Promise<Response | null> {
  const fetcher = getAssetsFetcher(env);
  if (fetcher) {
    return fetcher(request);
  }
  return getAssetFromBucket(request, env);
}

async function renderHtmlShell(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const fetcher = getAssetsFetcher(env);
  if (!fetcher) return null;
  const shellUrl = new URL('/', request.url);
  const shellResponse = await fetcher(new Request(shellUrl.toString(), request));
  if (!shellResponse.ok) return null;

  if (request.method === 'HEAD') {
    const headers = new Headers(shellResponse.headers);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    headers.set('Cache-Control', CACHE_CONTROL.htmlShell);
    return new Response(null, { status: shellResponse.status, headers });
  }

  const html = await shellResponse.text();
  const rewritten = await injectHeadMetadata(html, pathname, env);
  const headers = new Headers(shellResponse.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  // Path-specific head injection — keep edge TTL short.
  headers.set('Cache-Control', CACHE_CONTROL.htmlShell);
  return new Response(rewritten, { status: shellResponse.status, headers });
}

function getAssetsFetcher(env: Env): ((request: Request) => Promise<Response>) | null {
  const candidate = env.SITE_ASSETS;
  if (!candidate || typeof candidate !== 'object' || !('fetch' in candidate)) return null;
  if (typeof candidate.fetch !== 'function') return null;
  return candidate.fetch.bind(candidate);
}

function getAssetsBucket(env: Env): R2Bucket | null {
  const candidate = env.ASSETS;
  if (!candidate || typeof candidate !== 'object' || !('get' in candidate)) return null;
  if (typeof candidate.get !== 'function') return null;
  return candidate as R2Bucket;
}

async function getAssetFromBucket(request: Request, env: Env): Promise<Response | null> {
  const bucket = getAssetsBucket(env);
  if (!bucket) return null;

  const url = new URL(request.url);
  if (!url.pathname.startsWith('/assets/')) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;

  const key = url.pathname.replace(/^\/assets\//, '');
  if (!key) return null;

  const object = await bucket.get(key);
  if (!object) return new Response('Not Found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);

  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers });
}
const CONFIG_API_CACHE_CONTROL = 'no-store';

/** Fixed CORS for public config / dictionary / static GETs under Workers Cache. */
const PUBLIC_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function respondWithConfigApi(
  _request: Request,
  env: Env,
  _ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response> {
  // Env-backed; must not be edge-pinned via Workers Cache or Cache API.
  return new Response(
    JSON.stringify({
      assetBaseUrl: env.ASSET_BASE_URL || '',
      dictionaryBaseUrl: env.DICTIONARY_BASE_URL || '',
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': CONFIG_API_CACHE_CONTROL,
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
export async function dispatch(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
    console.log('🔍 [Index] 開始處理請求:', request.url);
    const url = new URL(request.url);
    console.log(url.pathname);

    // 處理 OPTIONS 預檢請求（CORS preflight）
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...PUBLIC_CORS_HEADERS,
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (url.pathname === '/robots.txt' && (request.method === 'GET' || request.method === 'HEAD')) {
      const body = [
        'User-agent: *',
        'Disallow: /api/',
        'Disallow: /*.json$',
        'Disallow: /*.png$',
        'Allow: /',
      ].join('\n');
      const headers = new Headers({
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      });
      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers });
      }
      return new Response(body, { status: 200, headers });
    }

    // 特殊路由：moetris 方塊遊戲已搬遷至 dodo 子網域，302 重導向（#123）
    if (url.pathname === '/moetris' || url.pathname === '/moetris/') {
      return new Response(null, {
        status: 302,
        headers: {
          'Location': 'https://dodo.moedict.tw/moetris.html',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    // 特殊路由：oEmbed 嵌入頁（/embed/<word>）— 見 src/oembed/handle-embed-page.ts
    if (url.pathname === '/embed' || url.pathname.startsWith('/embed/')) {
      return handleEmbedPage(request, url, env);
    }

    // 舊版 7 端點相容（/a /t /h /c /raw /uni /pua，README.md「目前 API 已有
    // 7 個端點」文件範例網址不帶 .json；已支援的 .json 版本見下方 handleDictionaryAPI
    // 的 parseSubRoute）。只攔截真的匹配這 7 個字首的兩段式路徑，避免影響單段
    // 詞條路由（例如查詢字面詞彙「a」本身仍走 /:text 一般流程）。
    if (/^\/(?:a|t|h|c|raw|uni|pua)\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith('.json')) {
      return handleDictionaryAPI(request, url, env);
    }

    // lookup API（台語羅馬拼音索引 / 舊站 trs 相容）
    const lookupResponse = await handleLookupAPI(request, url, env);
    if (lookupResponse) {
      return lookupResponse;
    }

    // 特殊路由：App Store 下載圖片（從 R2 ASSETS 讀取）
    if (url.pathname === '/images/Download_on_the_App_Store_Badge_HK_TW_135x40.png'
    ) {
      console.log('🔍 [Index] 處理圖片請求:', url.pathname);
      const bucket = env.ASSETS;
      const key = url.pathname.replace('/assets/', '').replace('/images/', '');
      const obj = await (bucket as R2Bucket).get(key);
      if (!obj) {
        return new Response('Not Found', { status: 404 });
      }
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('Content-Type', 'image/png');
      headers.set('Cache-Control', CACHE_CONTROL.staticDay);
      headers.set('Cache-Tag', 'assets');
      headers.set('etag', obj.httpEtag);
      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers });
      }
      return new Response(obj.body, { status: 200, headers });
    }
    // 特殊路由：Manifest AppCache（從 R2 ASSETS 讀取）
    if (url.pathname === '/manifest.appcache') {
      const bucket = env.ASSETS;
      const key = 'manifest.appcache';
      const obj = await (bucket as R2Bucket).get(key);
      if (!obj) {
        return new Response('Not Found', { status: 404 });
      }
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('Content-Type', 'text/cache-manifest; charset=utf-8');
      headers.set('Cache-Control', CACHE_CONTROL.staticDay);
      headers.set('Cache-Tag', 'appcache');
      headers.set('etag', obj.httpEtag);
      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers });
      }
      return new Response(obj.body, { status: 200, headers });
    }

    // 特殊路由：CFDict XML（從字典 R2 讀取）
    if (url.pathname === '/translation-data/cfdict.xml') {
      const corsHeaders = PUBLIC_CORS_HEADERS;
      const bucket = env.DICTIONARY;
      const key = 'translation-data/cfdict.xml';
      const obj = await bucket.get(key);
      if (!obj) {
        return new Response('Not Found', {
          status: 404,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            ...corsHeaders,
          },
        });
      }
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('Content-Type', 'application/xml; charset=utf-8');
      headers.set('Content-Disposition', 'attachment; filename="cfdict.xml"');
      headers.set('Cache-Control', CACHE_CONTROL.translation);
      headers.set('Cache-Tag', 'translation,translation-cfdict');
      headers.set('etag', obj.httpEtag);
      Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers });
      }
      return new Response(obj.body, { status: 200, headers });
    }

    // 特殊路由：CFDict TXT（從字典 R2 讀取，強制 UTF-8）
    if (url.pathname === '/translation-data/cfdict.txt') {
      const corsHeaders = PUBLIC_CORS_HEADERS;
      const bucket = env.DICTIONARY;
      const key = 'translation-data/cfdict.txt';
      const obj = await bucket.get(key);
      if (!obj) {
        return new Response('Not Found', {
          status: 404,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            ...corsHeaders,
          },
        });
      }
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('Content-Type', 'text/plain; charset=utf-8');
      headers.set('Cache-Control', CACHE_CONTROL.translation);
      headers.set('Cache-Tag', 'translation,translation-cfdict');
      headers.set('etag', obj.httpEtag);
      Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers });
      }
      return new Response(obj.body, { status: 200, headers });
    }

    if (url.pathname.startsWith('/api/') || url.pathname.endsWith('.json')) {
      console.log('🔍 [Index] 處理 API 請求:', url.pathname);
      const corsHeaders = PUBLIC_CORS_HEADERS;
      if (url.pathname === '/api/cache/purge') {
        const purge = createZoneCachePurger(env);
        return handleCachePurge(request, { env, purge });
      }

      // 提供配置資訊 API（vars → JSON；ASSET 前端有讀取，DICTIONARY 目前僅回傳未使用）
      if (url.pathname === '/api/config') {
        console.log('🔍 [Index] 提供配置資訊');
        return respondWithConfigApi(request, env, ctx);
      }

      // Tokenless oEmbed API（/api/oembed?url=...）— 見 src/oembed/handle-oembed-api.ts
      if (url.pathname === '/api/oembed') {
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
            JSON.stringify({ error: 'Not Found', message: `找不到全文索引：${key}` }),
            {
              status: 404,
              headers: {
                'Content-Type': 'application/json; charset=utf-8',
                ...corsHeaders,
              },
            },
          );
        }
        const content = await obj.text();
        return new Response(content, {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': CACHE_CONTROL.searchIndex,
            'Cache-Tag': `search-index,search-index-${lang}`,
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
            JSON.stringify({ error: 'Not Found', message: `找不到索引檔：${key}` }),
            {
              status: 404,
              headers: {
                'Content-Type': 'application/json; charset=utf-8',
                ...corsHeaders,
              },
            }
          );
        }

        const content = await obj.text();
        return new Response(content, {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': CACHE_CONTROL.index,
            'Cache-Tag': `index,index-${lang}`,
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
          return new Response('{}', {
            status: 200,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': CACHE_CONTROL.xref,
              'Cache-Tag': `xref,xref-${lang}`,
              ...corsHeaders,
            },
          });
        }

        const content = await obj.text();
        return new Response(content, {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': CACHE_CONTROL.xref,
            'Cache-Tag': `xref,xref-${lang}`,
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
          return new Response('{}', {
            status: 200,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': CACHE_CONTROL.xref,
              'Cache-Tag': `xref,xref-${lang}`,
              ...corsHeaders,
            },
          });
        }

        const content = await obj.text();
        return new Response(content, {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': CACHE_CONTROL.xref,
            'Cache-Tag': `xref,xref-${lang}`,
            ...corsHeaders,
          },
        });
      }

      // 筆順 JSON 代理（/api/stroke-json/{codepoint}.json）
      if (url.pathname.startsWith('/api/stroke-json/')) {
        return handleStrokeAPI(request, url, corsHeaders);
      }

      // 分類詞彙列表 API（=成語、'=諺語、:=諺語、~=同實異名，選配 .json）——
      // 判斷與解析統一在 handleListAPI 的 isListPath/parseListPath（安全 decode）
      if (isListPath(url.pathname)) {
        console.log('🔍 [Index] 處理列表 API 請求:', url.pathname);
        return handleListAPI(request, url, env);
      }

      // 字典 JSON API 路由
      if (
        url.pathname.endsWith('.json') &&
        !url.pathname.startsWith('/assets/')
      ) {
        console.log('🔍 [Index] 處理字典 API 請求:', url.pathname);
        const response = await handleDictionaryAPI(request, url, env);
        if (response) {
          return response;
        } else {
          console.warn('⚠️ [Index] 字典 API 處理失敗，返回 404:', url.pathname);
          return new Response('Not Found', { status: 404 });
        }
      }

      return Response.json({
        name: 'Cloudflare',
      });
    }

    if (shouldRenderHtmlShell(request, url)) {
      const shellResponse = await renderHtmlShell(request, env, url.pathname);
      if (shellResponse) return shellResponse;
    }

    const staticResponse = await passThroughAssets(request, env);
    if (staticResponse && staticResponse.status !== 404) {
      return staticResponse;
    }

    // ASSETS 找不到時，才回退到 R2 代理舊版靜態資源（字體、圖片等）；URL 來自 vars.ASSET_BASE_URL
    if (env.ASSET_BASE_URL && url.pathname.startsWith('/assets/')) {
      const assetPath = url.pathname.replace('/assets/', '');
      const assetUrl = `${env.ASSET_BASE_URL}/${assetPath}${url.search}`;

      console.log('🔍 [Index] 代理靜態資源請求:', assetUrl);

      return fetch(assetUrl, {
        method: request.method,
        headers: {
          // 只傳遞必要的 headers
          'User-Agent': request.headers.get('User-Agent') || 'Cloudflare-Worker',
        },
      }).then((response) => {
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Access-Control-Allow-Origin', '*');
        newHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        newHeaders.set('Access-Control-Allow-Headers', 'Content-Type');
        newHeaders.delete('Access-Control-Allow-Credentials');
        // A miss here is either the upstream legacy bucket genuinely
        // lacking the file, or (for a freshly-deployed hashed bundle
        // asset) a brief SITE_ASSETS propagation race — neither should be
        // edge-cacheable, or a transient 404 can outlive its transience.
        if (!response.ok) {
          newHeaders.set('Cache-Control', 'no-store');
        }

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      }).catch((error) => {
        console.error('代理請求失敗:', error);
        return new Response('代理請求失敗', { status: 502, headers: { 'Cache-Control': 'no-store' } });
      });
    }

    const isPngRequest = url.pathname.endsWith('.png');
    if (isPngRequest && (!staticResponse || staticResponse.status === 404)) {
      return await handleImageGeneration(url, { FONTS: env.FONTS, ASSETS: getAssetsBucket(env) ?? undefined });
    }

		return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
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
const MOEDICT_TW_ZONE_ID = '208ed37cabff643b306011964e52ad25';

export function createZoneCachePurger(env: Env): import('../src/api/cache').CachePurger {
  return async (options) => {
    const token = env.CLOUDFLARE_API_TOKEN?.trim();
    if (!token) {
      throw new Error('CLOUDFLARE_API_TOKEN not configured');
    }
    const body: Record<string, unknown> = {};
    if ('purgeEverything' in options && options.purgeEverything === true) {
      body.purge_everything = true;
    } else if ('tags' in options && options.tags && options.tags.length > 0) {
      body.tags = options.tags;
    } else {
      // No-op: nothing to purge
      return;
    }
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${MOEDICT_TW_ZONE_ID}/purge_cache`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Zone purge failed (${resp.status}): ${text.slice(0, 200)}`);
    }
  };
}

export default {
  fetch: (request, env, ctx) => dispatch(request, env, ctx),
} satisfies ExportedHandler<Env>;
