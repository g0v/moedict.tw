import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CACHE_CONTROL,
  DICTIONARY_CACHE_TAGS,
  filterAllowedTags,
  handleCachePurge,
  listTagsForLang,
  dictTagsForLang,
} from "../../src/api/cache";

const purgeMock = vi.fn(async () => ({ success: true }));

afterEach(() => {
  purgeMock.mockClear();
});

describe("cache policy constants", () => {
  it("splits browser max-age shorter than edge s-maxage for dict", () => {
    expect(CACHE_CONTROL.dict).toContain("max-age=300");
    expect(CACHE_CONTROL.dict).toContain("s-maxage=86400");
    expect(CACHE_CONTROL.searchIndex).toContain("max-age=3600");
    expect(CACHE_CONTROL.searchIndex).toContain("s-maxage=604800");
    expect(CACHE_CONTROL.png).toContain("max-age=86400");
    expect(CACHE_CONTROL.png).toContain("s-maxage=31536000");
  });

  it("builds ASCII language tags", () => {
    expect(dictTagsForLang("a")).toBe("dict,dict-a");
    expect(listTagsForLang("t")).toBe("list,list-t");
    expect(DICTIONARY_CACHE_TAGS).toContain("search-index-a");
    expect(DICTIONARY_CACHE_TAGS).toContain("translation-cfdict");
  });
});

describe("filterAllowedTags", () => {
  it("drops unknown and duplicate tags", () => {
    expect(filterAllowedTags(["dict", "dict", "evil", "list-a", ""])).toEqual(["dict", "list-a"]);
  });
});

describe("handleCachePurge", () => {
  it("rejects non-POST", async () => {
    const res = await handleCachePurge(new Request("http://localhost/api/cache/purge"), {
      env: { CACHE_PURGE_TOKEN: "secret" },
      purge: purgeMock,
    });
    expect(res.status).toBe(405);
    expect(purgeMock).not.toHaveBeenCalled();
  });

  it("fails closed when secret is not configured", async () => {
    const res = await handleCachePurge(
      new Request("http://localhost/api/cache/purge", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        body: "{}",
      }),
      { env: {}, purge: purgeMock },
    );
    expect(res.status).toBe(403);
    expect(purgeMock).not.toHaveBeenCalled();
  });

  it("rejects bad bearer token", async () => {
    const res = await handleCachePurge(
      new Request("http://localhost/api/cache/purge", {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
        body: JSON.stringify({ tags: ["dict"] }),
      }),
      { env: { CACHE_PURGE_TOKEN: "secret" }, purge: purgeMock },
    );
    expect(res.status).toBe(403);
    expect(purgeMock).not.toHaveBeenCalled();
  });

  it("accepts X-Cache-Purge-Token and purges allowed tags only", async () => {
    const res = await handleCachePurge(
      new Request("http://localhost/api/cache/purge", {
        method: "POST",
        headers: {
          "X-Cache-Purge-Token": "secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tags: ["dict", "nope", "search-index-a"] }),
      }),
      { env: { CACHE_PURGE_TOKEN: "secret" }, purge: purgeMock },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; purgedTags: string[] };
    expect(body.ok).toBe(true);
    expect(body.purgedTags).toEqual(["dict", "search-index-a"]);
    expect(purgeMock).toHaveBeenCalledWith({ tags: ["dict", "search-index-a"] });
  });

  it("purges full dictionary tag set when body is empty", async () => {
    const res = await handleCachePurge(
      new Request("http://localhost/api/cache/purge", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        body: "{}",
      }),
      { env: { CACHE_PURGE_TOKEN: "secret" }, purge: purgeMock },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { purgedTags: string[] };
    expect(body.purgedTags).toEqual([...DICTIONARY_CACHE_TAGS]);
    expect(purgeMock).toHaveBeenCalledWith({ tags: [...DICTIONARY_CACHE_TAGS] });
  });

  it("400s when only disallowed tags are supplied", async () => {
    const res = await handleCachePurge(
      new Request("http://localhost/api/cache/purge", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        body: JSON.stringify({ tags: ["evil"] }),
      }),
      { env: { CACHE_PURGE_TOKEN: "secret" }, purge: purgeMock },
    );
    expect(res.status).toBe(400);
    expect(purgeMock).not.toHaveBeenCalled();
  });

  it("400s on an invalid JSON body", async () => {
    const res = await handleCachePurge(
      new Request("http://localhost/api/cache/purge", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        body: "not-json",
      }),
      { env: { CACHE_PURGE_TOKEN: "secret" }, purge: purgeMock },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe("invalid JSON");
    expect(purgeMock).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only body as empty and purges the full tag set", async () => {
    const res = await handleCachePurge(
      new Request("http://localhost/api/cache/purge", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        body: "   ",
      }),
      { env: { CACHE_PURGE_TOKEN: "secret" }, purge: purgeMock },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { purgedTags: string[] };
    expect(body.purgedTags).toEqual([...DICTIONARY_CACHE_TAGS]);
  });

  it("falls through a non-Bearer Authorization header to X-Cache-Purge-Token", async () => {
    const res = await handleCachePurge(
      new Request("http://localhost/api/cache/purge", {
        method: "POST",
        headers: { Authorization: "Basic zzz", "X-Cache-Purge-Token": "secret" },
        body: "{}",
      }),
      { env: { CACHE_PURGE_TOKEN: "secret" }, purge: purgeMock },
    );
    expect(res.status).toBe(200);
  });

  it("403s when X-Cache-Purge-Token is whitespace only", async () => {
    const res = await handleCachePurge(
      new Request("http://localhost/api/cache/purge", {
        method: "POST",
        headers: { "X-Cache-Purge-Token": "   " },
        body: "{}",
      }),
      { env: { CACHE_PURGE_TOKEN: "secret" }, purge: purgeMock },
    );
    expect(res.status).toBe(403);
    expect(purgeMock).not.toHaveBeenCalled();
  });

  it("deletes supplied URLs from caches.default when present", async () => {
    const deleteMock = vi.fn(async () => true);
    Reflect.set(globalThis, "caches", {
      default: {
        delete: deleteMock,
      },
    });

    const res = await handleCachePurge(
      new Request("http://localhost/api/cache/purge", {
        method: "POST",
        headers: { "X-Cache-Purge-Token": "secret" },
        body: JSON.stringify({ urls: ["https://www.moedict.tw/api/%E9%B3%A5.json"] }),
      }),
      { env: { CACHE_PURGE_TOKEN: "secret" }, purge: purgeMock },
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; purgedUrls?: string[] };
    expect(data.ok).toBe(true);
    expect(data.purgedUrls).toEqual(["https://www.moedict.tw/api/%E9%B3%A5.json"]);
    expect(deleteMock).toHaveBeenCalled();

    Reflect.deleteProperty(globalThis, "caches");
  });

  it("skips non-string and blank URL entries without aborting the rest of the batch", async () => {
    const deleted: string[] = [];
    Reflect.set(globalThis, "caches", {
      default: {
        delete: async (req: Request) => {
          deleted.push(req.url);
          return true;
        },
      },
    });

    const res = await handleCachePurge(
      new Request("http://localhost/api/cache/purge", {
        method: "POST",
        headers: { "X-Cache-Purge-Token": "secret" },
        body: JSON.stringify({
          urls: [42, "   ", "https://www.moedict.tw/api/%E9%B3%A5.json"],
        }),
      }),
      { env: { CACHE_PURGE_TOKEN: "secret" }, purge: purgeMock },
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as { purgedUrls?: string[] };
    expect(data.purgedUrls).toEqual(["https://www.moedict.tw/api/%E9%B3%A5.json"]);
    expect(deleted).toEqual(["https://www.moedict.tw/api/%E9%B3%A5.json"]);

    Reflect.deleteProperty(globalThis, "caches");
  });

  it("also deletes the derived (version-namespaced) cache key when it differs", async () => {
    const deleted: string[] = [];
    Reflect.set(globalThis, "caches", {
      default: {
        delete: async (req: Request) => {
          deleted.push(req.url);
          return true;
        },
      },
    });

    const res = await handleCachePurge(
      new Request("http://localhost/api/cache/purge", {
        method: "POST",
        headers: { "X-Cache-Purge-Token": "secret" },
        body: JSON.stringify({ urls: ["https://www.moedict.tw/api/%E9%B3%A5.json"] }),
      }),
      {
        env: { CACHE_PURGE_TOKEN: "secret" },
        purge: purgeMock,
        deriveCacheKey: (req) => Promise.resolve(new Request(`${req.url}?__moedict_ver=abc`)),
      },
    );

    expect(res.status).toBe(200);
    expect(deleted).toEqual([
      "https://www.moedict.tw/api/%E9%B3%A5.json",
      "https://www.moedict.tw/api/%E9%B3%A5.json?__moedict_ver=abc",
    ]);

    Reflect.deleteProperty(globalThis, "caches");
  });

  it("deletes only the raw key when the derived key is null or identical", async () => {
    const deleted: string[] = [];
    Reflect.set(globalThis, "caches", {
      default: {
        delete: async (req: Request) => {
          deleted.push(req.url);
          return true;
        },
      },
    });
    const call = (deriveCacheKey: (req: Request) => Promise<Request | null>) =>
      handleCachePurge(
        new Request("http://localhost/api/cache/purge", {
          method: "POST",
          headers: { "X-Cache-Purge-Token": "secret" },
          body: JSON.stringify({ urls: ["https://www.moedict.tw/api/config"] }),
        }),
        { env: { CACHE_PURGE_TOKEN: "secret" }, purge: purgeMock, deriveCacheKey },
      );

    expect((await call(() => Promise.resolve(null))).status).toBe(200);
    expect((await call((req) => Promise.resolve(new Request(req.url)))).status).toBe(200);
    expect(deleted).toEqual([
      "https://www.moedict.tw/api/config",
      "https://www.moedict.tw/api/config",
    ]);

    Reflect.deleteProperty(globalThis, "caches");
  });
});
