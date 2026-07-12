/// <reference types="node" />
/**
 * Unit tests for R2 upload library (scripts/lib/r2-upload.mjs).
 *
 * Tests use injectable subprocess/sleep adapters for deterministic behavior.
 * Verifies: ≤4 concurrency, 429/971 backoff, manifest-last invariant,
 * correct MIME/cache-control/remote args, argv (not shell string) execution,
 * immutable promotion via shared isImmutableAsset, shared releaseKey/immutableKey.
 */

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vite-plus/test";
import {
  uploadObject,
  uploadReleaseToR2,
  uploadWithConcurrency,
  retryWithBackoff,
} from "../../scripts/lib/r2-upload.mjs";

// ── uploadObject ─────────────────────────────────────────────────────

describe("uploadObject", () => {
  it("calls wrangler r2 object put with argv (not shell string), --remote, --content-type, --cache-control", async () => {
    const calls: string[][] = [];
    const runner = async (argv: string[]) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await uploadObject("my-bucket", "releases/abc/index.html", "/path/index.html", {
      contentType: "text/html; charset=utf-8",
      cacheControl: "public, max-age=0, s-maxage=60",
      runner,
    });

    const args = calls[0];
    expect(args[0]).toBe("wrangler");
    expect(args).toContain("r2");
    expect(args).toContain("object");
    expect(args).toContain("put");
    expect(args).toContain("my-bucket/releases/abc/index.html");
    expect(args).toContain("--file=/path/index.html");
    expect(args).toContain("--remote");
    expect(args).toContain("--content-type=text/html; charset=utf-8");
    expect(args).toContain("--cache-control=public, max-age=0, s-maxage=60");
    // No shell string — argv array
    expect(Array.isArray(args)).toBe(true);
  });

  it("throws on non-zero exit code", async () => {
    const runner = async () => ({ exitCode: 1, stdout: "", stderr: "fail" });
    await expect(uploadObject("b", "k", "/f", { runner })).rejects.toThrow();
  });
});

// ── uploadWithConcurrency ─────────────────────────────────────────────

describe("uploadWithConcurrency", () => {
  it("uploads all files with max 4 concurrent", async () => {
    let active = 0;
    let maxActive = 0;
    const runner = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      // Use a deterministic microtask yield, not a real timer
      await Promise.resolve();
      active--;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const files = Array.from({ length: 10 }, (_, i) => ({
      key: `key-${i}`,
      filePath: `/path/file-${i}`,
      contentType: "application/octet-stream",
      cacheControl: "public, max-age=300",
    }));
    await uploadWithConcurrency(files, "bucket", { runner, maxConcurrent: 4 });
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(maxActive).toBe(4);
  });

  it("rejects if any upload fails", async () => {
    const runner = async (_argv: string[]) => {
      if (_argv.includes("bucket/key-3")) return { exitCode: 1, stdout: "", stderr: "fail" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const files = Array.from({ length: 5 }, (_, i) => ({
      key: `key-${i}`,
      filePath: `/f-${i}`,
      contentType: "application/octet-stream",
      cacheControl: "public, max-age=300",
    }));
    await expect(uploadWithConcurrency(files, "bucket", { runner })).rejects.toThrow();
  });
});

// ── retryWithBackoff ─────────────────────────────────────────────────

describe("retryWithBackoff", () => {
  it("retries on 429 (exit code from stderr) with exponential backoff", async () => {
    let calls = 0;
    const sleepDelays: number[] = [];
    const sleep = (ms: number) => {
      sleepDelays.push(ms);
      return Promise.resolve();
    };
    const fn = async () => {
      calls++;
      if (calls < 3) throw { code: 971, stderr: "rate limited" };
      return "ok";
    };
    const result = await retryWithBackoff(fn, {
      sleep,
      maxRetries: 5,
      initialDelay: 1000,
      maxDelay: 60000,
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(sleepDelays).toEqual([1000, 2000]);
  });

  it("aborts after max retries on persistent 429", async () => {
    let calls = 0;
    const sleep = () => Promise.resolve();
    const fn = async () => {
      calls++;
      throw { code: 971, stderr: "rate limited" };
    };
    await expect(
      retryWithBackoff(fn, { sleep, maxRetries: 5, initialDelay: 1000, maxDelay: 60000 }),
    ).rejects.toThrow();
    expect(calls).toBe(6); // initial + 5 retries
  });

  it("does not retry on non-429 errors", async () => {
    let calls = 0;
    const sleep = () => Promise.resolve();
    const fn = async () => {
      calls++;
      throw new Error("not a rate limit");
    };
    await expect(
      retryWithBackoff(fn, { sleep, maxRetries: 5, initialDelay: 1000, maxDelay: 60000 }),
    ).rejects.toThrow("not a rate limit");
    expect(calls).toBe(1);
  });

  it("caps delay at maxDelay", async () => {
    const sleepDelays: number[] = [];
    const sleep = (ms: number) => {
      sleepDelays.push(ms);
      return Promise.resolve();
    };
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls <= 7) throw { code: 971, stderr: "rate" };
      return "ok";
    };
    await retryWithBackoff(fn, { sleep, maxRetries: 7, initialDelay: 1000, maxDelay: 8000 });
    // Delays: 1s, 2s, 4s, 8s(cap), 8s, 8s, 8s
    expect(sleepDelays).toEqual([1000, 2000, 4000, 8000, 8000, 8000, 8000]);
  });
});

// ── uploadReleaseToR2 ────────────────────────────────────────────────

describe("uploadReleaseToR2", () => {
  it("uploads every client file release-scoped, hashed assets global immutable, manifest LAST", async () => {
    const uploadOrder: string[] = [];
    const runner = async (argv: string[]) => {
      const keyArg = argv.find((a) => a.startsWith("bucket/")) ?? "";
      uploadOrder.push(keyArg.replace("bucket/", ""));
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const sleep = () => Promise.resolve();

    // Files: index.html (non-hashed), assets/index-AbCdEf12.js (hashed)
    const files = new Map<string, Buffer>([
      ["index.html", Buffer.from("<html>")],
      ["assets/index-AbCdEf12.js", Buffer.from("console.log(1)")],
    ]);
    const fs = makeMemFs(files);

    const manifest = {
      id: "abc1234-def56789012",
      gitSha: "abc1234",
      clientManifestDigest: "def56789012",
      createdAt: "2026-07-12T00:00:00.000Z",
      files: [
        { path: "assets/index-AbCdEf12.js", sha256: "x".repeat(64), size: 13 },
        { path: "index.html", sha256: "y".repeat(64), size: 6 },
      ],
    };

    const manifestJson = JSON.stringify(manifest);
    await uploadReleaseToR2("abc1234-def56789012", "dist/client", "bucket", {
      runner,
      sleep,
      fs,
      manifestJson,
    });

    // Every file uploaded release-scoped
    expect(uploadOrder).toContain("releases/abc1234-def56789012/index.html");
    expect(uploadOrder).toContain("releases/abc1234-def56789012/assets/index-AbCdEf12.js");

    // Hashed asset ALSO uploaded to immutable
    expect(uploadOrder).toContain("immutable/assets/index-AbCdEf12.js");

    // Manifest uploaded LAST
    const manifestKey = "releases/abc1234-def56789012/release-manifest.json";
    expect(uploadOrder[uploadOrder.length - 1]).toBe(manifestKey);

    // Non-hashed file NOT uploaded to immutable
    expect(uploadOrder).not.toContain("immutable/index.html");
  });

  it("does NOT upload manifest if any object upload fails", async () => {
    const uploaded: string[] = [];
    const runner = async (argv: string[]) => {
      const keyArg = argv.find((a) => a.startsWith("bucket/")) ?? "";
      const key = keyArg.replace("bucket/", "");
      uploaded.push(key);
      // Fail on index.html upload
      if (key === "releases/fail-test/index.html") {
        return { exitCode: 1, stdout: "", stderr: "upload failed" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const sleep = () => Promise.resolve();

    const files = new Map<string, Buffer>([
      ["index.html", Buffer.from("<html>")],
      ["assets/index-AbCdEf12.js", Buffer.from("code")],
    ]);
    const fs = makeMemFs(files);

    await expect(
      uploadReleaseToR2("fail-test", "dist/client", "bucket", {
        runner,
        sleep,
        fs,
        manifestJson: '{"id":"fail-test"}',
      }),
    ).rejects.toThrow();

    // Manifest was NOT uploaded
    expect(uploaded).not.toContain("releases/fail-test/release-manifest.json");
  });

  it("uses shared releaseKey/immutableKey — no duplicate key construction", async () => {
    // Verify keys match the shared module's output by checking exact key format
    const keys: string[] = [];
    const runner = async (argv: string[]) => {
      const keyArg = argv.find((a) => a.startsWith("bucket/")) ?? "";
      keys.push(keyArg.replace("bucket/", ""));
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const sleep = () => Promise.resolve();

    const files = new Map<string, Buffer>([["assets/index-AbCdEf12.js", Buffer.from("code")]]);
    const fs = makeMemFs(files);

    await uploadReleaseToR2("rel-123", "dist/client", "bucket", {
      runner,
      sleep,
      fs,
      manifestJson: '{"id":"rel-123"}',
    });

    // Release key: releases/<tag>/<relative-path>
    expect(keys).toContain("releases/rel-123/assets/index-AbCdEf12.js");
    // Immutable key: immutable/assets/<relative-path> (never immutable/assets/assets/...)
    expect(keys).toContain("immutable/assets/index-AbCdEf12.js");
    // No doubled assets/
    expect(keys).not.toContain("immutable/assets/assets/index-AbCdEf12.js");
  });
  it("manifest upload uses a real file path, not JSON content as --file argument", async () => {
    const manifestArgs: string[][] = [];
    const runner = async (argv: string[]) => {
      const keyArg = argv.find((a) => a.startsWith("bucket/")) ?? "";
      if (keyArg.includes("release-manifest.json")) {
        manifestArgs.push(argv);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const sleep = () => Promise.resolve();

    const files = new Map<string, Buffer>([["index.html", Buffer.from("<html>")]]);
    const fs = makeMemFs(files);

    const manifestJson = '{"id":"path-test"}';
    await uploadReleaseToR2("path-test", "dist/client", "bucket", {
      runner,
      sleep,
      fs,
      manifestJson,
    });

    expect(manifestArgs.length).toBe(1);
    const fileArg = manifestArgs[0].find((a) => a.startsWith("--file=")) ?? "";
    const filePath = fileArg.slice("--file=".length);
    // --file must be a real path, not the JSON content itself
    expect(filePath).not.toBe(manifestJson);
    expect(filePath).toMatch(/release-manifest\.json$/);
  });
});

// ── Test helpers ─────────────────────────────────────────────────────

interface FsAdapter {
  readFileSync(path: string): Buffer;
  statSync(path: string): { size: number; isDirectory(): boolean };
  readdirSync(
    path: string,
    opts: { withFileTypes: true },
  ): Array<{
    name: string;
    isDirectory(): boolean;
  }>;
}

function makeMemFs(files: Map<string, Buffer>): FsAdapter {
  let baseDir = "";

  function toVirtual(p: string): string {
    let normalized = p.replace(/\\/g, "/");
    if (baseDir && normalized.startsWith(baseDir + "/")) {
      normalized = normalized.slice(baseDir.length + 1);
    } else if (baseDir && normalized === baseDir) {
      normalized = "";
    }
    return normalized;
  }

  return {
    readFileSync(p: string): Buffer {
      const key = toVirtual(p);
      const buf = files.get(key);
      if (!buf) throw new Error(`ENOENT: ${p}`);
      return buf;
    },
    statSync(p: string) {
      const key = toVirtual(p);
      if (files.has(key)) {
        return { size: files.get(key)!.length, isDirectory: () => false };
      }
      for (const k of files.keys()) {
        if (k.startsWith(key + "/")) {
          return { size: 0, isDirectory: () => true };
        }
      }
      throw new Error(`ENOENT: ${p}`);
    },
    readdirSync(p: string, _opts) {
      if (!baseDir) baseDir = p.replace(/\\/g, "/");
      const prefix = toVirtual(p);
      const entries: Array<{ name: string; isDirectory(): boolean }> = [];
      const seen = new Set<string>();
      for (const key of files.keys()) {
        const rel =
          prefix === "" ? key : key.startsWith(prefix + "/") ? key.slice(prefix.length + 1) : null;
        if (rel === null) continue;
        const slashIdx = rel.indexOf("/");
        if (slashIdx === -1) {
          if (!seen.has(rel)) {
            seen.add(rel);
            entries.push({ name: rel, isDirectory: () => false });
          }
        } else {
          const dirName = rel.slice(0, slashIdx);
          if (!seen.has(dirName)) {
            seen.add(dirName);
            entries.push({ name: dirName, isDirectory: () => true });
          }
        }
      }
      return entries;
    },
  };
}
