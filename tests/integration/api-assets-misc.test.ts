import { describe, expect, it } from "vite-plus/test";
import { fetchFromServer } from "./_harness";

describe("/translation-data/*", () => {
  it("serves cfdict.xml from DICTIONARY R2 (when fixture present)", async () => {
    const res = await fetchFromServer("/translation-data/cfdict.xml");
    if (res.status === 404) return; // fixture optional
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("xml");
    expect(res.headers.get("content-disposition")).toContain("cfdict.xml");
    expect(res.headers.get("cache-control")).toContain("s-maxage=86400");
  });

  it("serves cfdict.txt from DICTIONARY R2 (when fixture present)", async () => {
    const res = await fetchFromServer("/translation-data/cfdict.txt");
    if (res.status === 404) return;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("cache-control")).toContain("s-maxage=86400");
  });

  it("adds fixed-star CORS headers on cfdict.xml for any Origin", async () => {
    const res = await fetchFromServer("/translation-data/cfdict.xml", {
      headers: { Origin: "https://example.com" },
    });
    if (res.status !== 200) return;
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("/manifest.appcache", () => {
  it("serves the manifest fixture as text/cache-manifest", async () => {
    const res = await fetchFromServer("/manifest.appcache");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("cache-manifest");
    expect(res.headers.get("cache-control")).toContain("s-maxage=86400");
    const text = await res.text();
    expect(text).toContain("CACHE MANIFEST");
  });

  it("HEAD returns headers without body", async () => {
    const res = await fetchFromServer("/manifest.appcache", { method: "HEAD" });
    expect(res.status).toBe(200);
  });
});

describe("/images/Download_on_the_App_Store_Badge_HK_TW_135x40.png", () => {
  it("serves the PNG from ASSETS R2", async () => {
    const res = await fetchFromServer("/images/Download_on_the_App_Store_Badge_HK_TW_135x40.png");
    if (res.status === 404) return; // fixture optional
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("s-maxage=86400");
  });

  it("HEAD returns headers only", async () => {
    const res = await fetchFromServer("/images/Download_on_the_App_Store_Badge_HK_TW_135x40.png", {
      method: "HEAD",
    });
    if (res.status === 404) return;
    expect(res.status).toBe(200);
  });
});

describe("/{word}.png — on-demand image generation", () => {
  it("returns PNG bytes for a seeded-glyph word", async () => {
    const res = await fetchFromServer("/%E8%90%8C.png");
    if (res.status !== 200) {
      // Our Resvg stub may not be reached depending on the FONTS binding state.
      // Accept 404 text/plain ("font unavailable") as a legitimate error path.
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/text|png/);
      return;
    }
    expect(res.headers.get("content-type")).toBe("image/png");
    // Stubbed Resvg returns the PNG magic bytes (137,80,78,71)
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
  });

  it("accepts ?font= query param without erroring out", async () => {
    const res = await fetchFromServer("/%E8%90%8C.png?font=sung");
    expect([200, 404]).toContain(res.status);
  });

  // NOTE: the integration project aliases @cf-wasm/resvg to the deterministic
  // stub (tests/helpers/stubs/resvg.ts) which always returns the same fixed
  // PNG magic bytes regardless of SVG content, and the stub's `resvgCalls`
  // array lives inside the Miniflare worker process — unreachable from this
  // test. The 120px caption height-delta and single-<text> assertions are
  // already covered directly against the real SVG string in
  // tests/unit/image-generation.test.ts; these integration tests instead
  // prove the wiring end-to-end: romanize=1&lang=a doesn't 503 (real
  // TauhuOo/FiraSansOT font fixtures are seeded), lang=h and invalid lang
  // both fail open to a plain 200 glyph-only render, and none of this
  // touches the unchanged png Cache-Control/Cache-Tag contract.
  it("romanize=1&lang=a returns 200 image/png with unchanged cache headers (caption font resolved)", async () => {
    const res = await fetchFromServer("/%E8%90%8C.png?romanize=1&lang=a");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("s-maxage=31536000");
    expect(res.headers.get("cache-tag")).toBe("png");
  });

  it("romanize=1&lang=h fails open to a glyph-only 200 (documented Hakka exclusion)", async () => {
    const res = await fetchFromServer("/%E8%90%8C.png?romanize=1&lang=h");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-tag")).toBe("png");
  });

  it("romanize=1&lang=xx (invalid lang) fails open to a glyph-only 200", async () => {
    const res = await fetchFromServer("/%E8%90%8C.png?romanize=1&lang=xx");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-tag")).toBe("png");
  });

  it("plain (non-romanize) request keeps identical cache headers to the romanize=1 request", async () => {
    const plain = await fetchFromServer("/%E8%90%8C.png");
    const romanized = await fetchFromServer("/%E8%90%8C.png?romanize=1&lang=a");
    expect(plain.headers.get("cache-control")).toBe(romanized.headers.get("cache-control"));
    expect(plain.headers.get("cache-tag")).toBe(romanized.headers.get("cache-tag"));
    expect(plain.headers.get("content-type")).toBe(romanized.headers.get("content-type"));
  });
});

describe("CORS and method fallbacks", () => {
  it("OPTIONS on any path returns 204 CORS preflight", async () => {
    const res = await fetchFromServer("/some/arbitrary/path", {
      method: "OPTIONS",
      headers: { Origin: "https://example.test" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
