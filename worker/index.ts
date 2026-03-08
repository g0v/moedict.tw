import { handleDictionaryAPI } from '../src/api/handleDictionaryAPI';
import { lookupDictionaryEntry } from '../src/api/handleDictionaryAPI';
import { handleListAPI } from '../src/api/handleListAPI';
import { handleStrokeAPI } from '../src/api/handleStrokeAPI';
import { escapeHeadContent, resolveHeadByPath } from '../src/ssr/head';

interface Env {
	ASSET_BASE_URL?: string;
	DICTIONARY_BASE_URL?: string;
	DICTIONARY: R2Bucket;
  ASSETS?: Fetcher;
}

type DictionaryLang = 'a' | 't' | 'h' | 'c';

interface DictionaryDefinition {
  def?: string;
}

interface DictionaryHeteronym {
  definitions?: DictionaryDefinition[];
}

interface DictionaryEntryLike {
  heteronyms?: DictionaryHeteronym[];
}

function stripTags(input: string): string {
  return String(input || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function parseDictionaryRoute(pathname: string): { lang: DictionaryLang; text: string } | null {
  const raw = decodeURIComponent(String(pathname || '').replace(/^\/+/, '').replace(/\/+$/, ''));
  if (!raw) return null;
  if (raw === 'about' || raw === 'about.html') return null;
  if (raw.startsWith('@') || raw.startsWith('~@')) return null;
  if (raw.startsWith('=')) return null;
  if (raw.startsWith("'=*") || raw.startsWith(':=*') || raw.startsWith('~=*') || raw.startsWith('=*')) return null;
  if (raw.startsWith("'=") || raw.startsWith(':=') || raw.startsWith('~=')) return null;
  if (raw.startsWith("'")) return { lang: 't', text: raw.slice(1) };
  if (raw.startsWith(':')) return { lang: 'h', text: raw.slice(1) };
  if (raw.startsWith('~')) return { lang: 'c', text: raw.slice(1) };
  return { lang: 'a', text: raw };
}

function buildDefinitionDescription(entry: DictionaryEntryLike | null): string | null {
  if (!entry?.heteronyms || entry.heteronyms.length === 0) return null;
  const defs: string[] = [];
  for (const heteronym of entry.heteronyms) {
    const definitions = Array.isArray(heteronym.definitions) ? heteronym.definitions : [];
    for (const definition of definitions) {
      const clean = stripTags(definition.def || '');
      if (!clean) continue;
      defs.push(clean.replace(/[。．\s]+$/g, ''));
      if (defs.length >= 4) break;
    }
    if (defs.length >= 4) break;
  }
  if (defs.length === 0) return null;
  const sentence = `${defs.join('。')}。`;
  return sentence.length > 180 ? `${sentence.slice(0, 179)}…` : sentence;
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
    .replace(/<meta\s+name=["']twitter:creator["'][^>]*>/i, `<meta name="twitter:creator" content="${twitterCreator}" />`);
}

function isViteInternalRequest(url: URL): boolean {
  const { pathname, searchParams } = url;
  if (pathname.startsWith('/@') || pathname.startsWith('/node_modules/')) return true;
  return (
    searchParams.has('html-proxy') ||
    searchParams.has('import') ||
    searchParams.has('raw') ||
    searchParams.has('url') ||
    searchParams.has('worker_file')
  );
}

function shouldRenderHtmlShell(request: Request, url: URL): boolean {
  const { pathname } = url;
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (pathname.startsWith('/api/')) return false;
  if (pathname.startsWith('/assets/')) return false;
  if (isViteInternalRequest(url)) return false;
  if (/\.[a-zA-Z0-9]+$/.test(pathname) && pathname !== '/about.html' && pathname !== '/index.html') return false;
  return true;
}

async function passThroughAssets(request: Request, env: Env): Promise<Response | null> {
  if (!env.ASSETS) return null;
  return env.ASSETS.fetch(request);
}

async function renderHtmlShell(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (!env.ASSETS) return null;
  const shellUrl = new URL('/', request.url);
  const shellResponse = await env.ASSETS.fetch(new Request(shellUrl.toString(), request));
  if (!shellResponse.ok) return null;

  if (request.method === 'HEAD') {
    const headers = new Headers(shellResponse.headers);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(null, { status: shellResponse.status, headers });
  }

  const html = await shellResponse.text();
  const rewritten = await injectHeadMetadata(html, pathname, env);
  const headers = new Headers(shellResponse.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(rewritten, { status: shellResponse.status, headers });
}

export default {
  async fetch(request, env: Env) {
    console.log('🔍 [Index] 開始處理請求:', request.url);
    const url = new URL(request.url);
    console.log(url.pathname);

    // 處理 OPTIONS 預檢請求（CORS preflight）
    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin');
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin || '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }


    if (url.pathname.startsWith('/api/')) {
      console.log('🔍 [Index] 處理 API 請求:', url.pathname);
      const origin = request.headers.get('Origin');
      const corsHeaders = {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      };

      // 提供配置資訊 API
      if (url.pathname === '/api/config') {
        console.log('🔍 [Index] 提供配置資訊');
        return Response.json({
          assetBaseUrl: env.ASSET_BASE_URL || '',
          dictionaryBaseUrl: env.DICTIONARY_BASE_URL || '',
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
            'Cache-Control': 'public, max-age=300',
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
              'Cache-Control': 'public, max-age=3600',
              ...corsHeaders,
            },
          });
        }

        const content = await obj.text();
        return new Response(content, {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
            ...corsHeaders,
          },
        });
      }

      // 筆順 JSON 代理（/api/stroke-json/{codepoint}.json）
      if (url.pathname.startsWith('/api/stroke-json/')) {
        return handleStrokeAPI(request, url, corsHeaders);
      }

      // 分類詞彙列表 API（=成語、'=諺語、:=諺語、~=同實異名 等）
      const listSegment = decodeURIComponent(url.pathname.replace('/api/', ''));
      if (
        listSegment.startsWith('=') ||
        listSegment.startsWith("'=") ||
        listSegment.startsWith(':=') ||
        listSegment.startsWith('~=')
      ) {
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

    // ASSETS 找不到時，才回退到 R2 代理舊版靜態資源（字體、圖片等）
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
        // 複製回應並添加 CORS headers
        const newHeaders = new Headers(response.headers);
        const origin = request.headers.get('Origin');

        // 允許請求的來源
        if (origin) {
          newHeaders.set('Access-Control-Allow-Origin', origin);
          newHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
          newHeaders.set('Access-Control-Allow-Headers', 'Content-Type');
          newHeaders.set('Access-Control-Allow-Credentials', 'true');
        } else {
          // 如果沒有 Origin header，允許所有來源（開發環境）
          newHeaders.set('Access-Control-Allow-Origin', '*');
        }

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      }).catch((error) => {
        console.error('代理請求失敗:', error);
        return new Response('代理請求失敗', { status: 502 });
      });
    }

    if (staticResponse) return staticResponse;

		return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
