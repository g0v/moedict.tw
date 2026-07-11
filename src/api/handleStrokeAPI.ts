import { CACHE_CONTROL } from './cache';
import { tryDecodeURIComponent } from '../utils/dictionary-route';
import { STROKE_JSON_BASE_URL } from '../utils/media-cdn';
/**
 * 筆順 JSON 代理 API
 *
 * 路由：GET /api/stroke-json/{codepoint}.json
 * 作用：代理 R2 上的筆畫資料，解決瀏覽器 CORS 限制
 *
 * 資料來源（原為 moedict-webkit main.ls http-map['stroke-json'] 指向的
 * Rackspace CDN，已由 commands/migrate-legacy-cdn-to-r2.mjs 遷移進 R2）：
 * 見 src/utils/media-cdn.ts。
 */

export async function handleStrokeAPI(
  request: Request,
  url: URL,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const routePrefix = '/api/stroke-json/';
  // 取出 codepoint 部分，例如 /api/stroke-json/840b.json → 840b.json
  const cp = tryDecodeURIComponent(url.pathname.slice(routePrefix.length)) ?? '';

  // 僅接受單一路徑段，避免多段路徑造成重複請求或錯誤路由
  if (!cp || cp.includes('/') || !/^[0-9a-f]{4,6}\.json$/i.test(cp)) {
    return new Response(
      JSON.stringify({ error: 'Bad Request', message: '無效的 codepoint 格式' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
      }
    );
  }

  const upstream = `${STROKE_JSON_BASE_URL}/${cp}`;

  try {
    const upstreamRes = await fetch(upstream, {
      method: 'GET',
      headers: { 'User-Agent': request.headers.get('User-Agent') || 'Cloudflare-Worker' },
    });

    if (!upstreamRes.ok) {
      return new Response(
        JSON.stringify({ error: 'Not Found', message: `找不到筆畫資料：${cp}` }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
        }
      );
    }

    return new Response(upstreamRes.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': CACHE_CONTROL.stroke,
        'Cache-Tag': 'stroke',
        ...corsHeaders,
      },
    });
  } catch (err) {
    console.error('[handleStrokeAPI] 代理失敗:', err);
    return new Response(
      JSON.stringify({ error: 'Proxy Error', message: '筆畫資料代理失敗' }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
      }
    );
  }
}
