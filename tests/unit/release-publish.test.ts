/// <reference types="node" />
/**
 * Unit tests for the release-publish CLI (scripts/release-publish.mjs).
 *
 * Focus: the stroke-corpus readiness preflight runs BEFORE the R2 upload —
 * release-publish.mjs's `uploadReleaseToR2` call is the actual FIRST
 * mutating Wrangler call in the standard `bun run deploy` / `deploy:staging`
 * chains (build → release-publish → release-deploy), so this is where the
 * "no mutation on missing/invalid corpus" guarantee must be proven for the
 * publish phase (release-deploy.test.ts covers its own mutating calls).
 */
import { describe, expect, it, vi } from "vite-plus/test";
import { runReleasePublish } from "../../scripts/release-publish.mjs";

const CONFIG = {
  name: "cf-moedict-webkit-neo-staging",
  targetEnvironment: "staging",
  r2_buckets: [{ binding: "ASSETS", bucket_name: "moedict-assets-preview" }],
};

const MANIFEST = {
  id: "abc1234-def012345678",
  gitSha: "abc1234",
  clientManifestDigest: "def012345678",
  createdAt: "2026-07-12T00:00:00.000Z",
  files: [{ path: "index.html", sha256: "a".repeat(64), size: 10 }],
};

describe("runReleasePublish — stroke-corpus preflight gate (before any mutating call)", () => {
  it("never calls uploadReleaseToR2 when the corpus preflight rejects", async () => {
    const uploadRelease = vi.fn(async () => {
      throw new Error("uploadReleaseToR2 should never be invoked");
    });
    const verify = vi.fn(async () => ({ verified: true, checkedKeys: [] }));
    const preflight = vi.fn(async () => {
      throw new Error("[stroke-corpus-preflight] FAILED: pointer missing");
    });

    await expect(
      runReleasePublish({
        env: "staging",
        config: CONFIG,
        manifest: MANIFEST,
        preflight,
        uploadRelease,
        verify,
        log: () => {},
      }),
    ).rejects.toThrow(/pointer missing/);

    expect(preflight).toHaveBeenCalledTimes(1);
    expect(uploadRelease).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it("calls the preflight with the resolved env before touching config/manifest for upload", async () => {
    const order: string[] = [];
    const preflight = vi.fn(async () => {
      order.push("preflight");
      return {
        ok: true,
        bucketName: "moedict-assets-preview",
        corpusDigest: "a".repeat(64),
        checkedKeys: 6063,
      };
    });
    const uploadRelease = vi.fn(async () => {
      order.push("upload");
    });
    const verify = vi.fn(async () => {
      order.push("verify");
      return { verified: true, checkedKeys: ["k"] };
    });

    const result = await runReleasePublish({
      env: "staging",
      config: CONFIG,
      manifest: MANIFEST,
      preflight,
      uploadRelease,
      verify,
      log: () => {},
    });

    expect(order).toEqual(["preflight", "upload", "verify"]);
    expect(result).toMatchObject({
      releaseId: MANIFEST.id,
      bucketName: "moedict-assets-preview",
      env: "staging",
      verified: true,
    });
  });

  it("propagates a non-Error preflight rejection without swallowing it", async () => {
    const preflight = vi.fn(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "boom, not an Error instance";
    });
    const uploadRelease = vi.fn();
    await expect(
      runReleasePublish({
        env: "staging",
        config: CONFIG,
        manifest: MANIFEST,
        preflight,
        uploadRelease,
        log: () => {},
      }),
    ).rejects.toBe("boom, not an Error instance");
    expect(uploadRelease).not.toHaveBeenCalled();
  });

  it("defaults env to production when CLOUDFLARE_ENV is unset and still gates on the preflight", async () => {
    const prodConfig = {
      name: "cf-moedict-webkit-neo",
      r2_buckets: [{ binding: "ASSETS", bucket_name: "moedict-assets" }],
    };
    const preflight = vi.fn(async (env: string) => {
      expect(env).toBe("production");
      throw new Error("blocked in production too");
    });
    const uploadRelease = vi.fn();
    const prevEnv = process.env.CLOUDFLARE_ENV;
    delete process.env.CLOUDFLARE_ENV;
    try {
      await expect(
        runReleasePublish({
          config: prodConfig,
          manifest: { ...MANIFEST, id: "prod-release" },
          preflight,
          uploadRelease,
          log: () => {},
        }),
      ).rejects.toThrow(/blocked in production too/);
    } finally {
      if (prevEnv !== undefined) process.env.CLOUDFLARE_ENV = prevEnv;
    }
    expect(uploadRelease).not.toHaveBeenCalled();
  });
});
