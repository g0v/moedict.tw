/**
 * Offline API handler for Capacitor apps (Android / iOS / macOS).
 *
 * Monkey-patches window.fetch and XMLHttpRequest.open to intercept /api/*
 * requests and serve dictionary data from locally bundled files.
 *
 * When NOT running inside Capacitor (i.e. on the web), this module is a
 * complete no-op — the guard at the top bails out immediately.
 */

import { handleDictionaryAPI } from "./api/handleDictionaryAPI.ts";
import { handleCnsAPI } from "./api/handleCnsAPI.ts";
import { handleLookupAPI } from "./api/handleLookupAPI.ts";

const shouldUseOfflineApi =
  typeof window !== "undefined" && Boolean((window as Window & { Capacitor?: unknown }).Capacitor);

if (shouldUseOfflineApi) {
  // Keep the original fetch for loading local files and external requests
  const originalFetch = window.fetch.bind(window);

  const offlineDictionary = {
    async get(key: string): Promise<{ text(): Promise<string> } | null> {
      const loadText = async (path: string): Promise<string | null> => {
        try {
          const response = await originalFetch(path);
          if (!response.ok) return null;
          return await response.text();
        } catch {
          return null;
        }
      };

      if (key.startsWith("cns/")) {
        const localPath = `/cns/${key.slice("cns/".length)}`;
        const localText = await loadText(localPath);
        if (localText !== null) {
          return { text: () => Promise.resolve(localText) };
        }
      }

      const fallbackText = await loadText(`/dictionary/${key}`);
      if (fallbackText !== null) {
        return { text: () => Promise.resolve(fallbackText) };
      }
      return null;
    },
  };

  const offlineEnv = { DICTIONARY: offlineDictionary };

  async function handleOfflineApiRequest(url: string, init?: RequestInit): Promise<Response> {
    const parsedUrl = new URL(url, window.location.origin);
    const pathname = parsedUrl.pathname;

    if (pathname === "/api/config") {
      return Response.json({
        assetBaseUrl: "/assets-legacy",
        dictionaryBaseUrl: "",
      });
    }

    const searchIndexMatch = pathname.match(/^\/api\/search-index\/([athc])\.json$/);
    if (searchIndexMatch) {
      return originalFetch(`/search-index/${searchIndexMatch[1]}.json`, init);
    }

    const indexMatch = pathname.match(/^\/api\/index\/([athc])\.json$/);
    if (indexMatch) {
      return originalFetch(`/dictionary/${indexMatch[1]}/index.json`, init);
    }

    const xrefMatch = pathname.match(/^\/api\/xref\/([athc])\.json$/);
    if (xrefMatch) {
      const resp = await originalFetch(`/dictionary/${xrefMatch[1]}/xref.json`, init);
      if (resp.ok) return resp;
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (pathname.startsWith("/api/lookup/pinyin/") || pathname.startsWith("/lookup/trs/")) {
      const request = new Request(parsedUrl.href, init);
      const response = await handleLookupAPI(request, parsedUrl, offlineEnv);
      if (response) return response;
    }

    if (pathname.startsWith("/api/stroke-json/")) {
      const cp = decodeURIComponent(pathname.slice("/api/stroke-json/".length));
      if (!cp || !/^[0-9a-f]{4,6}\.json$/i.test(cp)) {
        return Response.json({ error: "Bad Request" }, { status: 400 });
      }
      // In Capacitor apps, stroke-json files are locally bundled under /stroke-json/{cp}.
      // Serve stroke-json exclusively from local files without any remote network fallback.
      try {
        const resp = await originalFetch(`/stroke-json/${cp}`, init);
        if (resp.ok) return resp;
        return Response.json(
          { error: "Offline", message: "Stroke data unavailable" },
          { status: 503 },
        );
      } catch {
        return Response.json(
          { error: "Offline", message: "Stroke data unavailable" },
          { status: 503 },
        );
      }
    }

    // CNS11643 属性後備（/api/cns/{char}.json）— 鏡射 Worker 路由；
    // 終端 handleDictionaryAPI fallback 無法識別 cns 路徑，故須明確處理
    if (pathname.startsWith("/api/cns/") && pathname.endsWith(".json")) {
      const request = new Request(parsedUrl.href, init);
      return handleCnsAPI(request, parsedUrl, offlineEnv);
    }

    const request = new Request(parsedUrl.href, init);
    return handleDictionaryAPI(request, parsedUrl, offlineEnv);
  }

  // Monkey-patch XMLHttpRequest for legacy jQuery $.ajax stroke requests
  // oxlint-disable-next-line typescript/unbound-method -- saved for `.call(this, …)` invocation below, never called unbound
  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async_?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    const urlStr = typeof url === "string" ? url : url.href;
    if (urlStr.startsWith("/api/stroke-json/")) {
      // Capacitor apps serve stroke-json exclusively from local bundled files
      // under /stroke-json/{cp}. Legacy jQuery.strokeWords $.ajax calls
      // (which use XHR, not fetch) rewrite to the local bundle path directly.
      const cp = urlStr.slice("/api/stroke-json/".length);
      return originalXHROpen.call(
        this,
        method,
        `/stroke-json/${cp}`,
        async_ ?? true,
        username,
        password,
      );
    }
    return originalXHROpen.call(this, method, url, async_ ?? true, username, password);
  };

  // Monkey-patch fetch to intercept /api/ requests
  const offlineFetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let url: string;
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else {
      url = input.url;
    }

    const isOfflineRequest =
      url.startsWith("/api/") ||
      url.startsWith("/lookup/trs/") ||
      (url.startsWith(window.location.origin) &&
        (() => {
          const pathname = new URL(url).pathname;
          return pathname.startsWith("/api/") || pathname.startsWith("/lookup/trs/");
        })());

    if (isOfflineRequest) {
      return handleOfflineApiRequest(url, init);
    }

    return originalFetch(input, init);
  };
  window.fetch = Object.assign(offlineFetch, window.fetch) as typeof window.fetch;
} // end Capacitor guard
