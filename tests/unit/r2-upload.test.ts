/// <reference types="node" />
/**
 * Unit tests for R2 upload library (scripts/lib/r2-upload.mjs).
 *
 * Tests use injectable subprocess/sleep adapters for deterministic behavior.
 * Verifies: ≤4 concurrency, 429/971/5xx/network backoff, manifest-last invariant,
 * correct MIME/cache-control/remote args, argv (not shell string) execution,
 * immutable promotion via shared isImmutableAsset, shared releaseKey/immutableKey.
 */
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vite-plus/test";
import {
  runWrangler,
  uploadObject,
  uploadReleaseToR2,
  uploadWithConcurrency,
  retryWithBackoff,
  isRetryableError,
  isNotFoundStderr,
} from "../../scripts/lib/r2-upload.mjs";

// ── isNotFoundStderr ─────────────────────────────────────────────────

describe("isNotFoundStderr", () => {
  it("matches real, non-piped wrangler's ANSI-wrapped 'does not exist' banner verbatim", () => {
    // Captured live from `wrangler r2 object get <bucket>/<missing-key> --remote`
    // run in a real (non-piped) TTY -- this is the exact byte sequence that
    // broke the first staging corpus upload: readCorpusPointer's old
    // /not found|NoSuchKey|404/i regex matched none of it (ANSI codes
    // between every token, and the phrase itself contains none of those
    // three substrings), so a legitimate empty-bucket "no prior pointer"
    // was retried 8x and thrown as fatal instead of returning null.
    // Deliberately contains NEITHER "NoSuchKey" NOR "404" NOR the bare
    // phrase "not found" -- only the real "does not exist" wording -- so
    // this assertion fails against the pre-fix regex.
    const real =
      "\x1B[31m\u2718 \x1B[41;31m[\x1B[41;97mERROR\x1B[41;31m]\x1B[0m \x1B[1mThe specified key does not exist.\x1B[0m\n";
    expect(isNotFoundStderr(real)).toBe(true);
  });

  it("matches the plain-text (piped/non-TTY) 'does not exist' phrasing with no ANSI codes", () => {
    expect(isNotFoundStderr("The specified key does not exist.")).toBe(true);
  });

  it("still matches legacy NoSuchKey / 'not found' / 404 phrasings (back-compat with fake-runner tests)", () => {
    expect(isNotFoundStderr("NoSuchKey: object not found")).toBe(true);
    expect(isNotFoundStderr("HTTP 404 Not Found")).toBe(true);
    expect(isNotFoundStderr("key not found")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isNotFoundStderr("THE SPECIFIED KEY DOES NOT EXIST.")).toBe(true);
  });

  it("returns false for empty/falsy stderr", () => {
    expect(isNotFoundStderr("")).toBe(false);
  });

  it("returns false for unrelated transient/permanent failures -- never conflates them with absence", () => {
    expect(isNotFoundStderr("\u2718 [ERROR] fetch failed")).toBe(false);
    expect(isNotFoundStderr("500: Internal Server Error")).toBe(false);
    expect(isNotFoundStderr("rate limited, code 971")).toBe(false);
  });
});

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

    expect(args[0]).toBe("vp");
    expect(args.slice(0, 3)).toEqual(["vp", "exec", "wrangler"]);
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

  it("rejects when the child emits an error", async () => {
    await expect(
      runWrangler(["vp", "exec", "wrangler", "--help"], (_file, _args, _opts) => {
        const listeners: Record<string, (value?: unknown) => void> = {};
        const stream = {
          on: (event: string, cb: (value: unknown) => void) => (listeners[event] = cb),
        };
        const child = {
          stdout: stream,
          stderr: stream,
          once: (event: string, cb: (value?: unknown) => void) => {
            listeners[event] = cb;
            if (event === "error") queueMicrotask(() => cb(new Error("ENOENT")));
          },
        };
        return child;
      }),
    ).rejects.toThrow("ENOENT");
  });

  it("treats a null close code as a failed command", async () => {
    const result = await runWrangler(
      ["vp", "exec", "wrangler", "--help"],
      (_file, _args, _opts) => {
        const listeners: Record<string, (value?: unknown) => void> = {};
        const stream = {
          on: (event: string, cb: (value: unknown) => void) => (listeners[event] = cb),
        };
        const child = {
          stdout: stream,
          stderr: stream,
          once: (event: string, cb: (value?: unknown) => void) => {
            listeners[event] = cb;
            if (event === "close") queueMicrotask(() => cb(null));
          },
        };
        return child;
      },
    );
    expect(result.exitCode).toBe(1);
  });

  it("default runner executes without an injected runner", async () => {
    const result = await runWrangler([process.execPath, "-e", "process.stdout.write('ok')"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("omits CLOUDFLARE_ENV from child env even when set in parent process", async () => {
    const capturedOpts: Record<string, unknown>[] = [];
    const prev = process.env.CLOUDFLARE_ENV;
    process.env.CLOUDFLARE_ENV = "staging";
    try {
      await runWrangler(["vp", "exec", "wrangler", "--help"], (file, args, opts) => {
        capturedOpts.push(opts as Record<string, unknown>);
        const listeners: Record<string, (value?: unknown) => void> = {};
        const stream = {
          on: (event: string, cb: (value: unknown) => void) => (listeners[event] = cb),
        };
        const child = {
          stdout: stream,
          stderr: stream,
          once: (event: string, cb: (value?: unknown) => void) => {
            listeners[event] = cb;
            if (event === "close") queueMicrotask(() => cb(0));
          },
        };
        return child;
      });
    } finally {
      if (prev === undefined) delete process.env.CLOUDFLARE_ENV;
      else process.env.CLOUDFLARE_ENV = prev;
    }
    expect(capturedOpts).toHaveLength(1);
    const env = capturedOpts[0].env as Record<string, string | undefined>;
    expect(env).toBeDefined();
    expect("CLOUDFLARE_ENV" in env).toBe(false);
    // Other env vars survive (PATH is universally present in test environments)
    expect(typeof env.PATH).toBe("string");
  });

  it("child env lacks CLOUDFLARE_ENV when absent in parent too", async () => {
    const capturedOpts: Record<string, unknown>[] = [];
    const prev = process.env.CLOUDFLARE_ENV;
    delete process.env.CLOUDFLARE_ENV;
    try {
      await runWrangler(["vp", "exec", "wrangler", "--help"], (file, args, opts) => {
        capturedOpts.push(opts as Record<string, unknown>);
        const listeners: Record<string, (value?: unknown) => void> = {};
        const stream = {
          on: (event: string, cb: (value: unknown) => void) => (listeners[event] = cb),
        };
        const child = {
          stdout: stream,
          stderr: stream,
          once: (event: string, cb: (value?: unknown) => void) => {
            listeners[event] = cb;
            if (event === "close") queueMicrotask(() => cb(0));
          },
        };
        return child;
      });
    } finally {
      if (prev !== undefined) process.env.CLOUDFLARE_ENV = prev;
    }
    const env = capturedOpts[0].env as Record<string, string | undefined>;
    expect("CLOUDFLARE_ENV" in env).toBe(false);
  });

  it("default runner does not pass CLOUDFLARE_ENV to the real subprocess", async () => {
    const prev = process.env.CLOUDFLARE_ENV;
    process.env.CLOUDFLARE_ENV = "staging";
    try {
      const result = await runWrangler([
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify(Object.keys(process.env)))",
      ]);
      expect(result.exitCode).toBe(0);
      const keys: string[] = JSON.parse(result.stdout);
      expect(keys).not.toContain("CLOUDFLARE_ENV");
      expect(keys).toContain("PATH");
    } finally {
      if (prev === undefined) delete process.env.CLOUDFLARE_ENV;
      else process.env.CLOUDFLARE_ENV = prev;
    }
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

  it("retries an uploadObject rate-limit error in the bounded pool", async () => {
    let calls = 0;
    const runner = async () => {
      calls++;
      if (calls === 1) return { exitCode: 1, stdout: "", stderr: "error code 971: throttled" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await uploadWithConcurrency(
      [{ key: "key", filePath: "/f", contentType: "text/plain", cacheControl: "public" }],
      "bucket",
      { runner, sleep: () => Promise.resolve() },
    );
    expect(calls).toBe(2);
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

  it("does not retry on permanent non-transient errors", async () => {
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

  it("recognizes only anchored Wrangler/Cloudflare rate-limit output", async () => {
    for (const stderr of [
      "HTTP 429 Too Many Requests",
      "status 429",
      "status: 429",
      "status code: 429",
      "Too Many Requests",
      "[code: 971]",
      "error code 971",
      "code: 971",
    ]) {
      let calls = 0;
      const result = await retryWithBackoff(
        async () => {
          calls++;
          if (calls === 1) throw { stderr };
          return "ok";
        },
        { sleep: () => Promise.resolve() },
      );
      expect(result).toBe("ok");
      expect(calls).toBe(2);
    }
  });

  it("does not treat unrelated key/text digits as rate limits", async () => {
    for (const error of [
      new Error("upload key contains 429"),
      { stderr: "object key 971 is present" },
      { message: "request id 429971" },
    ]) {
      let calls = 0;
      await expect(
        retryWithBackoff(
          async () => {
            calls++;
            throw error;
          },
          { sleep: () => Promise.resolve() },
        ),
      ).rejects.toEqual(error);

      expect(calls).toBe(1);
    }
  });

  it("retries Wrangler R2 HTTP 500 Internal Server Error", async () => {
    let calls = 0;
    const sleepDelays: number[] = [];
    const sleep = (ms: number) => {
      sleepDelays.push(ms);
      return Promise.resolve();
    };
    // Exact shape observed during 2026-07-13 staging corpus upload
    const wrangler500 =
      "Upload failed for moedict-assets-preview/stroke-json/80cc.json (exit 1): " +
      "Failed to fetch /accounts/…/r2/buckets/moedict-assets-preview/objects/stroke-json/80cc.json - 500: Internal Server Error;\n" +
      '  {"success":false,"errors":[{"code":10001,"message":"We encountered an internal error. Please try again."}],"messages":[],"result":null}';
    const fn = async () => {
      calls++;
      if (calls < 3) throw new Error(wrangler500);
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

  it("retries transient network system errors", async () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"]) {
      let calls = 0;
      const result = await retryWithBackoff(
        async () => {
          calls++;
          if (calls === 1) {
            const err = new Error(`connect ${code}`);
            // @ts-expect-error - system error shape
            err.code = code;
            throw err;
          }
          return "ok";
        },
        { sleep: () => Promise.resolve() },
      );
      expect(result).toBe("ok");
      expect(calls).toBe(2);
    }
  });

  it("retries nested network cause codes", async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        if (calls === 1) {
          const cause = new Error("socket closed");
          // @ts-expect-error - system error shape
          cause.code = "ECONNRESET";
          throw new Error("fetch failed", { cause });
        }
        return "ok";
      },
      { sleep: () => Promise.resolve() },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("fail-fast on permanent 4xx (except 429)", async () => {
    for (const stderr of [
      "HTTP 400 Bad Request",
      "status 403 Forbidden",
      "status code: 404",
      "The specified key does not exist",
      "Authentication error [code: 10000]",
    ]) {
      let calls = 0;
      await expect(
        retryWithBackoff(
          async () => {
            calls++;
            throw { stderr, message: `Upload failed: ${stderr}` };
          },
          { sleep: () => Promise.resolve(), maxRetries: 5 },
        ),
      ).rejects.toBeTruthy();
      expect(calls).toBe(1);
    }
  });

  it("retries uploadObject pool on Wrangler 500 then succeeds", async () => {
    let calls = 0;
    const runner = async () => {
      calls++;
      if (calls === 1) {
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            "Failed to fetch /accounts/x/r2/buckets/b/objects/k - 500: Internal Server Error;\n" +
            '{"success":false,"errors":[{"code":10001,"message":"We encountered an internal error. Please try again."}]}',
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await uploadWithConcurrency(
      [{ key: "key", filePath: "/f", contentType: "text/plain", cacheControl: "public" }],
      "bucket",
      { runner, sleep: () => Promise.resolve() },
    );
    expect(calls).toBe(2);
  });

  it("isRetryableError classifies rate-limit, 5xx, network, and permanent 4xx", () => {
    expect(isRetryableError({ code: 971 })).toBe(true);
    expect(isRetryableError({ code: 429 })).toBe(true);
    expect(isRetryableError({ code: "ECONNRESET" })).toBe(true);
    expect(
      isRetryableError({
        message:
          "…/objects/stroke-json/80cc.json - 500: Internal Server Error; We encountered an internal error",
      }),
    ).toBe(true);
    expect(isRetryableError({ stderr: "HTTP 502 Bad Gateway" })).toBe(true);
    expect(isRetryableError({ stderr: "HTTP 503 Service Unavailable" })).toBe(true);
    expect(isRetryableError({ message: "socket hang up" })).toBe(true);
    expect(isRetryableError({ message: "fetch failed" })).toBe(true);

    // permanent / non-transient
    expect(isRetryableError({ stderr: "HTTP 400 Bad Request" })).toBe(false);
    expect(isRetryableError({ stderr: "status 403" })).toBe(false);
    expect(isRetryableError({ message: "The specified key does not exist" })).toBe(false);
    expect(isRetryableError(new Error("upload key contains 500"))).toBe(false);
    expect(isRetryableError({ stderr: "object key 500 is present" })).toBe(false);
    expect(isRetryableError({ message: "request id 50010001" })).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError("string")).toBe(false);
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
  it("removes manifest temp directory after a successful upload", async () => {
    let manifestPath = "";
    const runner = async (argv: string[]) => {
      const keyArg = argv.find((a) => a.startsWith("bucket/")) ?? "";
      if (keyArg.includes("release-manifest.json")) {
        manifestPath = (argv.find((a) => a.startsWith("--file=")) ?? "").slice("--file=".length);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await uploadReleaseToR2("cleanup-success", "dist/client", "bucket", {
      runner,
      fs: makeMemFs(new Map([["index.html", Buffer.from("x")]])),
      manifestJson: "{}",
    });
    expect(manifestPath).toMatch(/release-manifest\.json$/);
    expect(existsSync(dirname(manifestPath))).toBe(false);
  });

  it("removes manifest temp directory after a failed manifest upload", async () => {
    let manifestPath = "";
    const runner = async (argv: string[]) => {
      const keyArg = argv.find((a) => a.startsWith("bucket/")) ?? "";
      if (keyArg.includes("release-manifest.json")) {
        manifestPath = (argv.find((a) => a.startsWith("--file=")) ?? "").slice("--file=".length);
        return { exitCode: 1, stdout: "", stderr: "manifest failure" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await expect(
      uploadReleaseToR2("cleanup-failure", "dist/client", "bucket", {
        runner,
        fs: makeMemFs(new Map([["index.html", Buffer.from("x")]])),
        manifestJson: "{}",
      }),
    ).rejects.toThrow();
    expect(manifestPath).toMatch(/release-manifest\.json$/);
    expect(existsSync(dirname(manifestPath))).toBe(false);
  });
  it("rejects symbolic links instead of publishing files outside the release directory", async () => {
    const dir = mkdtempSync(join("/tmp", "r2-upload-symlink-"));
    try {
      writeFileSync(join(dir, "outside.txt"), "outside");
      try {
        symlinkSync(join(dir, "outside.txt"), join(dir, "linked.txt"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }
      await expect(
        uploadReleaseToR2("symlink-release", dir, "bucket", {
          runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          manifestJson: "{}",
        }),
      ).rejects.toThrow(/symbolic link.*linked\.txt/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    isSymbolicLink(): boolean;
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
      const entries: Array<{
        name: string;
        isDirectory(): boolean;
        isSymbolicLink(): boolean;
      }> = [];
      const seen = new Set<string>();
      for (const key of files.keys()) {
        const rel =
          prefix === "" ? key : key.startsWith(prefix + "/") ? key.slice(prefix.length + 1) : null;
        if (rel === null) continue;
        const slashIdx = rel.indexOf("/");
        if (slashIdx === -1) {
          if (!seen.has(rel)) {
            seen.add(rel);
            entries.push({ name: rel, isDirectory: () => false, isSymbolicLink: () => false });
          }
        } else {
          const dirName = rel.slice(0, slashIdx);
          if (!seen.has(dirName)) {
            seen.add(dirName);
            entries.push({ name: dirName, isDirectory: () => true, isSymbolicLink: () => false });
          }
        }
      }
      return entries;
    },
  };
}
