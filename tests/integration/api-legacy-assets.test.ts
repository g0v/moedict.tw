/**
 * Regression: the Worker must serve the local-edited stroke-animation loader
 * (not proxy through to a stale R2 copy) and that JS must embed the inline
 * SVG spinner instead of the FontAwesome <i class="icon-spinner"> webfont.
 *
 * Background: in production the asset is stored in R2 and last-modified stamps
 * drift from the checked-in source. A regression here (stale R2 upload) is
 * what motivated this suite.
 *
 * Also covers the Task 1 R2 release-fallback paths:
 * - HTML shell: SITE_ASSETS non-OK/throw → tagged R2 → 503
 * - Immutable asset: SITE_ASSETS non-OK/throw → global immutable R2
 * - Tag-absent → skip R2 → 503
 * - HEAD / If-None-Match 304 on R2-served objects
 */

import { afterAll, describe, expect, it } from "vite-plus/test";
import { fetchFromServer } from "./_harness";
import { startTestServer, type TestServer } from "../helpers/miniflare-server";

describe("/assets/js/jquery.strokeWords.js", () => {
  it("serves the local-edited loader JS via the ASSETS binding", async () => {
    const res = await fetchFromServer("/assets/js/jquery.strokeWords.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/javascript/);
  });

  it("embeds the inline SVG spinner (moe-stroke-loader-spinner)", async () => {
    const res = await fetchFromServer("/assets/js/jquery.strokeWords.js");
    const body = await res.text();
    expect(body).toMatch(/<svg[^>]*class=\\"moe-stroke-loader-spinner/);
    expect(body).toContain('viewBox=\\"0 0 1568 1792\\"');
  });

  it('never falls back to the webfont <i class="icon-spinner"> markup', async () => {
    const res = await fetchFromServer("/assets/js/jquery.strokeWords.js");
    const body = await res.text();
    expect(body).not.toMatch(/class=\\"icon-spinner/);
    expect(body).not.toMatch(/\bicon-spin\b/);
  });
});

// ── Task 1: R2 release fallback integration tests ─────────────────────
//
// These tests spin up a local Miniflare with CF_VERSION_METADATA bound so
// the fallback code can construct `releases/<tag>/...` R2 keys. The global
// integration server has no version_metadata binding (tag-absent path).

const TEST_TAG = "test-release-001";
const TEST_VERSION_ID = "v-uuid-abc123";
const SHELL_HTML =
  '<!doctype html><html><head><title>萌典</title></head><body><div id="app"></div></body></html>';
const IMMUTABLE_JS = "console.log('immutable-bundle');";

let taggedServer: TestServer | null = null;

async function getTaggedServer(): Promise<TestServer> {
  if (taggedServer) return taggedServer;
  const server = await startTestServer({
    versionMetadata: { id: TEST_VERSION_ID, tag: TEST_TAG, timestamp: "2026-07-12T00:00:00Z" },
  });
  // Seed R2 with release-scoped index.html and an immutable hashed asset.
  const bucket = (await server.mf.getR2Bucket("ASSETS")) as unknown as {
    put(
      key: string,
      value: ArrayBuffer,
      options?: { httpMetadata?: { contentType?: string } },
    ): Promise<unknown>;
  };
  await bucket.put(`releases/${TEST_TAG}/index.html`, new TextEncoder().encode(SHELL_HTML).buffer, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  await bucket.put(
    "immutable/assets/index-AbCdEfGh.js",
    new TextEncoder().encode(IMMUTABLE_JS).buffer,
    { httpMetadata: { contentType: "application/javascript; charset=utf-8" } },
  );
  taggedServer = server;
  return server;
}

// Clean up after all tests in this describe block.
afterAll(async () => {
  if (taggedServer) {
    await taggedServer.stop();
    taggedServer = null;
  }
});

async function fetchFromTaggedServer(path: string, init?: RequestInit): Promise<Response> {
  const server = await getTaggedServer();
  return fetch(`${server.url.toString().replace(/\/+$/, "")}${path}`, init);
}

describe("R2 shell fallback (tagged release)", () => {
  it("serves index.html from tagged R2 when SITE_ASSETS is unavailable", async () => {
    // No SITE_ASSETS binding → falls through to R2 releases/<tag>/index.html
    const res = await fetchFromTaggedServer("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("X-Moedict-Shell-Source")).toBe("r2-release");
    expect(res.headers.get("X-Moedict-Version")).toBe(TEST_VERSION_ID);
    expect(res.headers.get("X-Moedict-Release")).toBe(TEST_TAG);
    const body = await res.text();
    expect(body).toContain("萌典");
  });

  it("returns 503 recovery when tag is absent (global server has no CF_VERSION_METADATA)", async () => {
    // The global integration server has no version_metadata binding.
    const res = await fetchFromServer("/");
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Moedict-Shell-Source")).toBe("recovery");
    expect(res.headers.get("X-Moedict-Version")).toBe("unknown");
    expect(res.headers.get("X-Moedict-Release")).toBeNull();
    expect(res.headers.get("Retry-After")).toBe("5");
    const body = await res.text();
    expect(body).toContain("萌典");
    expect(body).toMatch(/refresh.*5/);
  });

  it("serves HEAD request from tagged R2 with empty body", async () => {
    const res = await fetchFromTaggedServer("/", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Moedict-Shell-Source")).toBe("r2-release");
    expect(await res.text()).toBe("");
  });

  it("returns 304 when If-None-Match matches the R2 ETag", async () => {
    // First request to get the ETag
    const res1 = await fetchFromTaggedServer("/");
    const etag = res1.headers.get("etag");
    expect(etag).toBeTruthy();

    // Second request with If-None-Match should return 304
    const res2 = await fetchFromTaggedServer("/", {
      headers: { "If-None-Match": etag! },
    });
    expect(res2.status).toBe(304);
    expect(res2.headers.get("X-Moedict-Shell-Source")).toBe("r2-release");
  });
});

describe("R2 immutable asset fallback", () => {
  it("serves hashed /assets/* from global immutable R2 when SITE_ASSETS is unavailable", async () => {
    // /assets/index-AbCdEfGh.js matches isImmutableAsset (8+ char hash)
    // and should be served from immutable/assets/index-AbCdEfGh.js
    const res = await fetchFromTaggedServer("/assets/index-AbCdEfGh.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Moedict-Asset-Source")).toBe("r2-immutable");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    const body = await res.text();
    expect(body).toBe(IMMUTABLE_JS);
  });

  it("returns HEAD for immutable asset with empty body", async () => {
    const res = await fetchFromTaggedServer("/assets/index-AbCdEfGh.js", {
      method: "HEAD",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Moedict-Asset-Source")).toBe("r2-immutable");
    expect(await res.text()).toBe("");
  });
});
