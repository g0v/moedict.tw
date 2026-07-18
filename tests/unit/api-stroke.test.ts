import { describe, expect, it } from "vite-plus/test";
import { handleStrokeAPI, type StrokeEnv } from "../../src/api/handleStrokeAPI";
/**
 * Minimal R2 doubles for direct-call unit tests. Integration tests exercise
 * the real Miniflare ASSETS binding with the seeded 840c.json fixture.
 *
 * Store entries keep the body as a string so each get() can mint a fresh
 * ReadableStream (R2 bodies are single-use).
 */

interface StoredObject {
  body: string;
  httpEtag: string;
}

function streamOf(text: string): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function makeBucket(store: Map<string, StoredObject>): StrokeEnv["ASSETS"] {
  return {
    async head(key: string) {
      const obj = store.get(key);
      if (!obj) return null;
      return {
        httpEtag: obj.httpEtag,
        writeHttpMetadata(headers: Headers) {
          headers.set("content-type", "application/json");
        },
      };
    },
    async get(key: string, options?: { onlyIf?: Headers | object }) {
      const obj = store.get(key);
      if (!obj) return null;
      // Simulate R2 onlyIf: If-None-Match match → bodyless R2Object (304 path)
      if (options?.onlyIf instanceof Headers) {
        const inm = options.onlyIf.get("If-None-Match");
        if (inm && inm === obj.httpEtag) {
          return {
            httpEtag: obj.httpEtag,
            writeHttpMetadata(headers: Headers) {
              headers.set("content-type", "application/json");
            },
          };
        }
      }
      return {
        httpEtag: obj.httpEtag,
        body: streamOf(obj.body),
        writeHttpMetadata(headers: Headers) {
          headers.set("content-type", "application/json");
        },
      };
    },
  } as unknown as StrokeEnv["ASSETS"];
}

const corsHeaders = { "Access-Control-Allow-Origin": "*" };

const SAMPLE_JSON = JSON.stringify([
  {
    outline: [{ type: "M", x: 1, y: 2 }],
    track: [{ x: 1, y: 2 }],
  },
]);

describe("handleStrokeAPI validation", () => {
  it.each([
    "/api/stroke-json/../etc/passwd.json",
    "/api/stroke-json/xyz.json",
    "/api/stroke-json/1234567.json", // 7 hex chars exceeds 4-6
    "/api/stroke-json/123.json", // 3 hex chars
    "/api/stroke-json/840c", // no .json
    "/api/stroke-json/nested/840c.json",
    "/api/stroke-json/%", // 壞 percent-encoding：tryDecode fail-closed → 400，不可 500
  ])("returns 400 for invalid codepoint %s", async (path) => {
    const env = { ASSETS: makeBucket(new Map()) };
    const url = new URL(`http://localhost${path}`);
    const response = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ error: "Bad Request" });
  });
});

describe("handleStrokeAPI R2 reads", () => {
  it("streams stroke-json from env.ASSETS for a valid 4-hex codepoint", async () => {
    const store = new Map<string, StoredObject>([
      ["stroke-json/840c.json", { body: SAMPLE_JSON, httpEtag: '"etag-840c"' }],
    ]);
    const env = { ASSETS: makeBucket(store) };
    const url = new URL("http://localhost/api/stroke-json/840c.json");

    const response = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/json/);
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=86400");
    expect(response.headers.get("Cache-Control")).toContain("max-age=3600");
    expect(response.headers.get("Cache-Tag")).toBe("stroke");
    expect(response.headers.get("ETag")).toBe('"etag-840c"');
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.json()).toEqual(JSON.parse(SAMPLE_JSON));
  });

  it("accepts 5 and 6 hex codepoints and normalises uppercase to lowercase keys", async () => {
    const store = new Map<string, StoredObject>([
      ["stroke-json/840c.json", { body: "[]", httpEtag: '"a"' }],
      ["stroke-json/20000.json", { body: "[]", httpEtag: '"b"' }],
      ["stroke-json/2a700.json", { body: "[]", httpEtag: '"c"' }],
    ]);
    const env = { ASSETS: makeBucket(store) };
    for (const cp of ["840C.json", "20000.json", "2A700.json"]) {
      const url = new URL(`http://localhost/api/stroke-json/${cp}`);
      const response = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
      expect(response.status).toBe(200);
    }
  });

  it("returns 404 when the object is absent from ASSETS", async () => {
    const env = { ASSETS: makeBucket(new Map()) };
    const url = new URL("http://localhost/api/stroke-json/ffff.json");
    const response = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("Not Found");
  });

  it("returns 404 for HEAD when the object is absent from ASSETS (head() path)", async () => {
    const env = { ASSETS: makeBucket(new Map()) };
    const url = new URL("http://localhost/api/stroke-json/ffff.json");
    const request = new Request(url.toString(), { method: "HEAD" });
    const response = await handleStrokeAPI(request, url, env, corsHeaders);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("returns 404 (not 500) for 6c5b.json when 汛 is not yet uploaded", async () => {
    // Until the full 6,063 corpus lands in the env's ASSETS bucket, missing
    // characters must keep failing closed with 404 so the client badge UX
    // (jquery.strokeWords.js) can render 「尚無筆順資料」.
    const env = { ASSETS: makeBucket(new Map()) };
    const url = new URL("http://localhost/api/stroke-json/6c5b.json");
    const response = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("Not Found");
  });

  it("serves HEAD with ETag and no body", async () => {
    const store = new Map<string, StoredObject>([
      ["stroke-json/840c.json", { body: SAMPLE_JSON, httpEtag: '"head-etag"' }],
    ]);
    const env = { ASSETS: makeBucket(store) };
    const url = new URL("http://localhost/api/stroke-json/840c.json");
    const request = new Request(url.toString(), { method: "HEAD" });
    const response = await handleStrokeAPI(request, url, env, corsHeaders);
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe('"head-etag"');
    expect(response.headers.get("Cache-Tag")).toBe("stroke");
    expect(await response.text()).toBe("");
  });

  it("returns 304 when If-None-Match matches the stored ETag", async () => {
    const store = new Map<string, StoredObject>([
      ["stroke-json/840c.json", { body: SAMPLE_JSON, httpEtag: '"match-me"' }],
    ]);
    const env = { ASSETS: makeBucket(store) };
    const url = new URL("http://localhost/api/stroke-json/840c.json");
    const request = new Request(url.toString(), {
      headers: { "If-None-Match": '"match-me"' },
    });
    const response = await handleStrokeAPI(request, url, env, corsHeaders);
    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe('"match-me"');
    expect(await response.text()).toBe("");
  });

  it("returns 500 when R2 throws (not a silent proxy error)", async () => {
    const env = {
      ASSETS: {
        async get() {
          throw new Error("R2 unavailable");
        },
        async head() {
          throw new Error("R2 unavailable");
        },
      } as unknown as StrokeEnv["ASSETS"],
    };
    const url = new URL("http://localhost/api/stroke-json/840c.json");
    const response = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("Internal Error");
  });
});
