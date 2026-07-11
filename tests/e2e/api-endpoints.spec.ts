import { expect, test } from "./_fixtures";

test.describe("worker API endpoints (browser-side fetch)", () => {
  test("/api/config JSON shape", async ({ request }) => {
    const response = await request.get("/api/config");
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(typeof body.assetBaseUrl).toBe("string");
    expect(typeof body.dictionaryBaseUrl).toBe("string");
  });

  test("/a/萌.json returns a dictionary entry", async ({ request }) => {
    const response = await request.get("/a/%E8%90%8C.json");
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toBeDefined();
    // compact key OR expanded key should be present
    const hasTitle = "t" in body || "title" in body;
    const hasHet = "h" in body || "heteronyms" in body;
    expect(hasTitle || hasHet).toBe(true);
  });

  test("/raw/萌.json includes bopomofo2 derived field when bopomofo present", async ({
    request,
  }) => {
    const response = await request.get("/raw/%E8%90%8C.json");
    expect(response.status()).toBe(200);
    const body = await response.json();
    const heteronym = body.heteronyms?.[0];
    if (heteronym?.bopomofo) {
      expect(heteronym.bopomofo2).toBeDefined();
    }
  });

  test("/api/lookup/pinyin/t/TL/tsiah.json returns an array", async ({ request }) => {
    const response = await request.get("/api/lookup/pinyin/t/TL/tsiah.json");
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test("/萌.png returns a PNG image", async ({ request }) => {
    const response = await request.get("/%E8%90%8C.png");
    expect([200, 404]).toContain(response.status());
    if (response.status() === 200) {
      expect(response.headers()["content-type"]).toBe("image/png");
    }
  });

  test("/manifest.appcache has the right content-type", async ({ request }) => {
    const response = await request.get("/manifest.appcache");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("cache-manifest");
  });
});
