import { describe, expect, it } from "vite-plus/test";
import { fetchFromServer, fetchJson } from "./_harness";

describe("server smoke", () => {
  it("/api/config returns configured URLs", async () => {
    const { status, body } = await fetchJson<{ assetBaseUrl?: string; dictionaryBaseUrl?: string }>(
      "/api/config",
    );
    expect(status).toBe(200);
    expect(body.assetBaseUrl).toBe("https://r2-assets.test.local");
    expect(body.dictionaryBaseUrl).toBe("https://r2-dictionary.test.local");
  });

  it("OPTIONS preflight returns 204 with CORS headers", async () => {
    const res = await fetchFromServer("/api/config", {
      method: "OPTIONS",
      headers: { Origin: "https://www.moedict.tw" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });
});

describe("unknown path statuses (R4)", () => {
  it("GET /garbage returns a real 404 instead of a soft-200 SPA shell", async () => {
    const res = await fetchFromServer("/garbage");
    expect(res.status).toBe(404);
  });

  it("keeps non-404 shell behavior for a valid entry path (/萌)", async () => {
    // Shell availability depends on bindings (this server has neither
    // SITE_ASSETS nor a release tag, so the render itself recovers to 503);
    // the R4 contract is only that a real headword is never 404'd.
    const res = await fetchFromServer("/%E8%90%8C");
    expect(res.status).not.toBe(404);
  });
});
