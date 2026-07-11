/**
 * GET /embed/<word> — the standalone, iframe-friendly page referenced by
 * the oEmbed API's `html` field (see handle-oembed-api.ts). Renders
 * directly from the already-packed dictionary entry; ships zero JS so the
 * iframe is cheap and safe to embed on third-party pages before any
 * script runs.
 */

import { lookupDictionaryEntry } from "../api/handleDictionaryAPI";
import { dictTagsForLang } from "../api/cache";
import { buildDictionaryPathname, parseDictionaryRoute } from "../utils/dictionary-route";
import { renderEmbedDocument, renderEmbedNotFound } from "./render-embed-document";
import type { EmbedDictionaryEntry } from "./types";

const SITE_ORIGIN = "https://www.moedict.tw";
const EMBED_CACHE_CONTROL = "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800";

interface EmbedPageEnv {
  DICTIONARY: {
    get(key: string): Promise<{ text(): Promise<string> } | null>;
  };
}

function htmlResponse(method: string, body: string, status: number, cacheTag?: string): Response {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  if (status === 200 && cacheTag) {
    headers.set("Cache-Control", EMBED_CACHE_CONTROL);
    headers.set("Cache-Tag", cacheTag);
  } else {
    headers.set("Cache-Control", "no-store");
  }
  return new Response(method === "HEAD" ? null : body, { status, headers });
}

function methodNotAllowed(): Response {
  return new Response(null, {
    status: 405,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      Allow: "GET, HEAD",
      "Cache-Control": "no-store",
    },
  });
}

export async function handleEmbedPage(
  request: Request,
  url: URL,
  env: EmbedPageEnv,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed();
  }

  const remainder = url.pathname.replace(/^\/embed/, "") || "/";
  const route = parseDictionaryRoute(remainder);
  if (!route || !route.text) {
    return htmlResponse(request.method, renderEmbedNotFound(""), 404);
  }

  const entry = (await lookupDictionaryEntry(
    route.text,
    route.lang,
    env,
  )) as EmbedDictionaryEntry | null;
  if (!entry || !Array.isArray(entry.heteronyms) || entry.heteronyms.length === 0) {
    return htmlResponse(request.method, renderEmbedNotFound(route.text), 404);
  }

  const canonicalUrl = `${SITE_ORIGIN}${buildDictionaryPathname(route.lang, route.text)}`;
  const html = renderEmbedDocument({ word: route.text, lang: route.lang, entry, canonicalUrl });
  return htmlResponse(request.method, html, 200, dictTagsForLang(route.lang));
}
