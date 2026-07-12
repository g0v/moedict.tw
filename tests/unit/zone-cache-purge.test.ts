import { describe, expect, it, vi } from "vite-plus/test";
import { createZoneCachePurger } from "../../worker/index";

// Mock Env with just the fields createZoneCachePurger needs
type PurgerEnv = { CLOUDFLARE_API_TOKEN?: string };

describe("createZoneCachePurger", () => {
  it("throws when CLOUDFLARE_API_TOKEN is not configured", async () => {
    const purge = createZoneCachePurger({} as PurgerEnv);
    await expect(purge({ tags: ["dict"] })).rejects.toThrow("CLOUDFLARE_API_TOKEN not configured");
  });

  it("throws when token is empty string", async () => {
    const purge = createZoneCachePurger({ CLOUDFLARE_API_TOKEN: "  " } as PurgerEnv);
    await expect(purge({ tags: ["dict"] })).rejects.toThrow("CLOUDFLARE_API_TOKEN not configured");
  });

  it("sends a tag-based purge request to the Zone API", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"success":true}', { status: 200 }));
    const purge = createZoneCachePurger({ CLOUDFLARE_API_TOKEN: "test-token" } as PurgerEnv);
    await purge({ tags: ["dict", "dict-a"] });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("/zones/208ed37cabff643b306011964e52ad25/purge_cache");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-token" });
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({ tags: ["dict", "dict-a"] });
    fetchSpy.mockRestore();
  });

  it("sends purge_everything when option is purgeEverything", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"success":true}', { status: 200 }));
    const purge = createZoneCachePurger({ CLOUDFLARE_API_TOKEN: "test-token" } as PurgerEnv);
    await purge({ purgeEverything: true });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({ purge_everything: true });
    fetchSpy.mockRestore();
  });

  it("is a no-op when no tags and no purgeEverything", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"success":true}', { status: 200 }));
    const purge = createZoneCachePurger({ CLOUDFLARE_API_TOKEN: "test-token" } as PurgerEnv);
    await purge({ tags: [] });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("throws on non-2xx API response", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}',
          { status: 403 },
        ),
      );
    const purge = createZoneCachePurger({ CLOUDFLARE_API_TOKEN: "bad-token" } as PurgerEnv);
    await expect(purge({ tags: ["dict"] })).rejects.toThrow("Zone purge failed (403)");
    fetchSpy.mockRestore();
  });

  it("degrades to an empty snippet when the error response text() rejects", async () => {
    const resp = new Response("ignored", { status: 500 });
    vi.spyOn(resp, "text").mockRejectedValue(new Error("stream broke"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(resp);
    const purge = createZoneCachePurger({ CLOUDFLARE_API_TOKEN: "test-token" } as PurgerEnv);
    await expect(purge({ tags: ["dict"] })).rejects.toThrow("Zone purge failed (500): ");
    fetchSpy.mockRestore();
  });
});
