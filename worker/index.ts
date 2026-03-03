import { handleDictionaryAPI } from '../src/api/handleDictionaryAPI';
import { handleListAPI } from '../src/api/handleListAPI';
import { handleStrokeAPI } from '../src/api/handleStrokeAPI';

interface Env {
	ASSET_BASE_URL?: string;
	DICTIONARY_BASE_URL?: string;
	DICTIONARY: R2Bucket;
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

    // 代理 R2 靜態資源請求（字體、CSS、圖片等）
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

		return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
