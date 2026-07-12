/**
 * GET /api/oembed?url=<content-url>&format=json&maxwidth=&maxheight=
 *
 * Tokenless oEmbed 1.0 endpoint (https://oembed.com/) for moedict.tw
 * dictionary entries — no access token, no App Review-style approval,
 * matching the tokenless posture Meta shipped for its oEmbed APIs. The
 * `html` field points at a dedicated /embed/<word> document (see
 * handle-embed-page.ts) rather than the full SPA, so third-party
 * embedders get a small, script-free iframe instead of the whole app.
 */

import { lookupDictionaryEntry } from "../api/handleDictionaryAPI";
import { dictTagsForLang } from "../api/cache";
import { buildDictionaryPathname, parseDictionaryRoute } from "../utils/dictionary-route";
import { escapeHtml, stripTags } from "./html-escape";
import type { EmbedDictionaryEntry } from "./types";

const SITE_ORIGIN = "https://www.moedict.tw";
const PROVIDER_NAME = "萌典 Moedict";
const OEMBED_ALLOWED_HOSTS: ReadonlySet<string> = new Set(["www.moedict.tw", "moedict.tw"]);

const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 280;
const MIN_WIDTH = 220;
const MAX_WIDTH = 900;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 1000;
const OEMBED_CACHE_CONTROL = "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800";

interface OEmbedEnv {
  DICTIONARY: {
    get(key: string): Promise<{ text(): Promise<string> } | null>;
  };
}

function clampToRange(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function oembedResponse(
  method: string,
  payload: unknown,
  status: number,
  cacheTag?: string,
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  });
  if (status === 200 && cacheTag) {
    headers.set("Cache-Control", OEMBED_CACHE_CONTROL);
    headers.set("Cache-Tag", cacheTag);
  } else {
    headers.set("Cache-Control", "no-store");
  }
  const body = method === "HEAD" ? null : JSON.stringify(payload, null, 2);
  return new Response(body, { status, headers });
}

function methodNotAllowed(): Response {
  return new Response(null, {
    status: 405,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Allow: "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

export async function handleOEmbedAPI(
  request: Request,
  url: URL,
  env: OEmbedEnv,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed();
  }

  const format = (url.searchParams.get("format") || "json").toLowerCase();
  if (format !== "json") {
    return oembedResponse(
      request.method,
      { error: "not_implemented", message: `format=${format} 尚未支援，僅提供 json。` },
      501,
    );
  }

  const targetUrlParam = url.searchParams.get("url");
  if (!targetUrlParam) {
    return oembedResponse(
      request.method,
      { error: "bad_request", message: "缺少必要參數 url。" },
      400,
    );
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(targetUrlParam);
  } catch {
    return oembedResponse(
      request.method,
      { error: "bad_request", message: "url 參數不是合法網址。" },
      400,
    );
  }

  if (
    (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") ||
    targetUrl.port !== "" ||
    !OEMBED_ALLOWED_HOSTS.has(targetUrl.hostname.toLowerCase())
  ) {
    return oembedResponse(
      request.method,
      { error: "not_found", message: "僅支援 moedict.tw 詞條網址。" },
      404,
    );
  }

  const route = parseDictionaryRoute(targetUrl.pathname);
  if (!route || !route.text) {
    return oembedResponse(
      request.method,
      { error: "not_found", message: "此網址不是可嵌入的詞條頁面。" },
      404,
    );
  }

  const entry = (await lookupDictionaryEntry(
    route.text,
    route.lang,
    env,
  )) as EmbedDictionaryEntry | null;
  if (!entry || !Array.isArray(entry.heteronyms) || entry.heteronyms.length === 0) {
    return oembedResponse(request.method, { error: "not_found", message: "找不到這個詞條。" }, 404);
  }

  const title = stripTags(String(entry.title || route.text)) || route.text;
  const width = clampToRange(url.searchParams.get("maxwidth"), DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH);
  const height = clampToRange(
    url.searchParams.get("maxheight"),
    DEFAULT_HEIGHT,
    MIN_HEIGHT,
    MAX_HEIGHT,
  );
  const entryPathname = buildDictionaryPathname(route.lang, route.text);
  const embedSrc = `${SITE_ORIGIN}/embed${entryPathname}`;
  const thumbnailUrl = `${SITE_ORIGIN}/${encodeURIComponent(title)}.png`;
  const iframeTitle = escapeHtml(`${title} - 萌典`);

  const html = `<iframe src="${escapeHtml(embedSrc)}" width="${width}" height="${height}" style="border:0;max-width:100%;" sandbox="allow-popups allow-popups-to-escape-sandbox" title="${iframeTitle}" loading="lazy"></iframe>`;

  const payload = {
    version: "1.0",
    type: "rich",
    provider_name: PROVIDER_NAME,
    provider_url: SITE_ORIGIN,
    title,
    author_name: "教育部辭典",
    author_url: `${SITE_ORIGIN}/about`,
    html,
    width,
    height,
    cache_age: 86400,
    thumbnail_url: thumbnailUrl,
    thumbnail_width: 375,
    thumbnail_height: 375,
  };

  return oembedResponse(request.method, payload, 200, dictTagsForLang(route.lang));
}
