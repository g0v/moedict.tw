/**
 * Direct-call tests for the two src/oembed/* HTTP handlers, mirroring the
 * R2-stub pattern from tests/unit/api-handlers-direct.test.ts so
 * lookupDictionaryEntry resolves through the same pack-file shape as
 * production (no Miniflare / real R2 required).
 */

import { describe, expect, it } from "vite-plus/test";
import { handleOEmbedAPI } from "../../src/oembed/handle-oembed-api";
import { handleEmbedPage } from "../../src/oembed/handle-embed-page";

interface R2Stub {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

function makeR2(entries: Record<string, string>): R2Stub {
  return {
    async get(key) {
      const payload = entries[key];
      if (payload === undefined) return null;
      return { text: async () => payload };
    },
  };
}

// 萌 → U+840C → charCode 33804 → 33804 % 1024 = 12 → pack/12.txt, matching
// the fixture already established in tests/unit/worker-dispatch-edges.test.ts.
function makeMengEnv(): { DICTIONARY: R2Stub } {
  return {
    DICTIONARY: makeR2({
      "pack/12.txt": JSON.stringify({
        [escape("萌")]: {
          t: "萌",
          h: [
            {
              b: "ㄇㄥˊ",
              p: "méng",
              d: [{ f: "草木初生的芽。", type: "名" }],
            },
          ],
        },
      }),
    }),
  };
}

function makeRequest(pathname: string, init?: RequestInit): { request: Request; url: URL } {
  const url = new URL(`http://localhost${pathname}`);
  return { request: new Request(url.toString(), init), url };
}

describe("handleOEmbedAPI", () => {
  it("405s for non-GET/HEAD methods", async () => {
    const env = makeMengEnv();
    const { request, url } = makeRequest("/api/oembed?url=https://www.moedict.tw/萌", {
      method: "POST",
    });
    const res = await handleOEmbedAPI(request, url, env);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("400s when url is missing", async () => {
    const env = makeMengEnv();
    const { request, url } = makeRequest("/api/oembed");
    const res = await handleOEmbedAPI(request, url, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  it("400s when url is not a parseable URL", async () => {
    const env = makeMengEnv();
    const { request, url } = makeRequest("/api/oembed?url=not-a-url");
    const res = await handleOEmbedAPI(request, url, env);
    expect(res.status).toBe(400);
  });

  it("404s for a url on a disallowed host", async () => {
    const env = makeMengEnv();
    const { request, url } = makeRequest(
      `/api/oembed?url=${encodeURIComponent("https://evil.example.com/萌")}`,
    );
    const res = await handleOEmbedAPI(request, url, env);
    expect(res.status).toBe(404);
  });

  it("404s for a non-http(s) scheme like ftp:", async () => {
    const env = makeMengEnv();
    const { request, url } = makeRequest(
      `/api/oembed?url=${encodeURIComponent("ftp://moedict.tw/萌")}`,
    );
    const res = await handleOEmbedAPI(request, url, env);
    expect(res.status).toBe(404);
  });

  it("404s for a non-default explicit port", async () => {
    const env = makeMengEnv();
    const { request, url } = makeRequest(
      `/api/oembed?url=${encodeURIComponent("https://www.moedict.tw:8443/萌")}`,
    );
    const res = await handleOEmbedAPI(request, url, env);
    expect(res.status).toBe(404);
  });

  it("404s for a moedict.tw url that is not an embeddable entry (e.g. /about)", async () => {
    const env = makeMengEnv();
    const { request, url } = makeRequest(
      `/api/oembed?url=${encodeURIComponent("https://www.moedict.tw/about")}`,
    );
    const res = await handleOEmbedAPI(request, url, env);
    expect(res.status).toBe(404);
  });

  it("404s when the entry has no packed data", async () => {
    const env = { DICTIONARY: makeR2({}) };
    const { request, url } = makeRequest(
      `/api/oembed?url=${encodeURIComponent("https://www.moedict.tw/萌")}`,
    );
    const res = await handleOEmbedAPI(request, url, env);
    expect(res.status).toBe(404);
  });

  it("501s for format=xml (unsupported, per oEmbed spec)", async () => {
    const env = makeMengEnv();
    const { request, url } = makeRequest(
      `/api/oembed?url=${encodeURIComponent("https://www.moedict.tw/萌")}&format=xml`,
    );
    const res = await handleOEmbedAPI(request, url, env);
    expect(res.status).toBe(501);
  });

  it("returns a tokenless oEmbed 1.0 rich payload for www.moedict.tw and moedict.tw hosts", async () => {
    for (const host of ["www.moedict.tw", "moedict.tw"]) {
      const env = makeMengEnv();
      const { request, url } = makeRequest(
        `/api/oembed?url=${encodeURIComponent(`https://${host}/萌`)}`,
      );
      const res = await handleOEmbedAPI(request, url, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.version).toBe("1.0");
      expect(body.type).toBe("rich");
      expect(body.title).toBe("萌");
      expect(body.provider_name).toContain("萌典");
      expect(body.width).toBe(400);
      expect(body.height).toBe(280);
      expect(body.html).toContain("<iframe");
      expect(body.html).toContain('src="https://www.moedict.tw/embed/%E8%90%8C"');
      expect(body.html).toContain('sandbox="allow-popups allow-popups-to-escape-sandbox"');
      expect(body.thumbnail_url).toBe("https://www.moedict.tw/%E8%90%8C.png");
    }
  });

  it("clamps maxwidth/maxheight into the supported range", async () => {
    const env = makeMengEnv();
    const { request, url } = makeRequest(
      `/api/oembed?url=${encodeURIComponent("https://www.moedict.tw/萌")}&maxwidth=50&maxheight=5000`,
    );
    const res = await handleOEmbedAPI(request, url, env);
    const body = (await res.json()) as { width: number; height: number };
    expect(body.width).toBe(220); // MIN_WIDTH floor
    expect(body.height).toBe(1000); // MAX_HEIGHT ceiling
  });

  it("honors in-range maxwidth/maxheight", async () => {
    const env = makeMengEnv();
    const { request, url } = makeRequest(
      `/api/oembed?url=${encodeURIComponent("https://www.moedict.tw/萌")}&maxwidth=500&maxheight=300`,
    );
    const res = await handleOEmbedAPI(request, url, env);
    const body = (await res.json()) as { width: number; height: number };
    expect(body.width).toBe(500);
    expect(body.height).toBe(300);
  });

  it("returns an empty body for HEAD requests", async () => {
    const env = makeMengEnv();
    const { request, url } = makeRequest(
      `/api/oembed?url=${encodeURIComponent("https://www.moedict.tw/萌")}`,
      { method: "HEAD" },
    );
    const res = await handleOEmbedAPI(request, url, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("falls back to route.text as the title when the entry has no title field", async () => {
    const env = {
      DICTIONARY: makeR2({
        "pack/12.txt": JSON.stringify({
          [escape("萌")]: { h: [{ d: [{ f: "無題定義。", type: "名" }] }] },
        }),
      }),
    };
    const { request, url } = makeRequest(
      `/api/oembed?url=${encodeURIComponent("https://www.moedict.tw/萌")}`,
    );
    const res = await handleOEmbedAPI(request, url, env);
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe("萌");
  });

  it("falls back to route.text when the entry title is present but strips down to nothing", async () => {
    const env = {
      DICTIONARY: makeR2({
        "pack/12.txt": JSON.stringify({
          [escape("萌")]: { t: "   ", h: [{ d: [{ f: "空白標題。", type: "名" }] }] },
        }),
      }),
    };
    const { request, url } = makeRequest(
      `/api/oembed?url=${encodeURIComponent("https://www.moedict.tw/萌")}`,
    );
    const res = await handleOEmbedAPI(request, url, env);
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe("萌");
  });
});

describe("handleEmbedPage", () => {
  it("405s for non-GET/HEAD methods", async () => {
    const env = makeMengEnv();
    const { request, url } = makeRequest("/embed/萌", { method: "DELETE" });
    const res = await handleEmbedPage(request, url, env);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
  });

  it("404s for /embed with no word", async () => {
    const env = makeMengEnv();
    const { request, url } = makeRequest("/embed");
    const res = await handleEmbedPage(request, url, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("404s for a non-embeddable route like /embed/about", async () => {
    const env = makeMengEnv();
    const { request, url } = makeRequest("/embed/about");
    const res = await handleEmbedPage(request, url, env);
    expect(res.status).toBe(404);
  });

  it('404s with a "not found" card when the entry has no packed data', async () => {
    const env = { DICTIONARY: makeR2({}) };
    const { request, url } = makeRequest("/embed/%E8%90%8C");
    const res = await handleEmbedPage(request, url, env);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("找不到這個詞條。");
  });

  it("renders the entry card and long-caches on success", async () => {
    const env = makeMengEnv();
    const { request, url } = makeRequest("/embed/%E8%90%8C");
    const res = await handleEmbedPage(request, url, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Tag")).toBe("dict,dict-a");
    const body = await res.text();
    expect(body).toContain("<h1>萌</h1>");
    expect(body).toContain("草木初生的芽。");
    expect(body).toContain('href="https://www.moedict.tw/%E8%90%8C"');
  });

  it("returns an empty body for HEAD requests", async () => {
    const env = makeMengEnv();
    const { request, url } = makeRequest("/embed/%E8%90%8C", { method: "HEAD" });
    const res = await handleEmbedPage(request, url, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});
