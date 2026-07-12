/// <reference types="node" />
/**
 * Unit tests for release verification (scripts/release-verify.mjs).
 *
 * Verification MUST hash binary bytes (arrayBuffer/downloaded file buffer),
 * never response.text(). Buckets are private: use injectable
 * `wrangler r2 object get ... --remote --file`/runner, not unauthenticated
 * public URLs. Re-download and hash EVERY uploaded object: release-scoped
 * files, immutable copies, and parse/validate the separately uploaded
 * manifest. Missing/mismatch aborts naming exact key. Verify manifest
 * identity/digest/files before success. Use shared releaseKey/immutableKey.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { verifyRelease } from "../../scripts/release-verify.mjs";

// ── verifyRelease ────────────────────────────────────────────────────

describe("verifyRelease", () => {
  it("re-downloads and hashes EVERY uploaded object — binary bytes not text", async () => {
    // Binary content with non-UTF8 bytes
    const binaryContent = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x42]);
    const expectedHash = createHash("sha256").update(binaryContent).digest("hex");

    const manifest = {
      id: "abc1234-def56789012",
      gitSha: "abc1234",
      clientManifestDigest: "def56789012",
      createdAt: "2026-07-12T00:00:00.000Z",
      files: [{ path: "bin.dat", sha256: expectedHash, size: 5 }],
    };

    const downloadedFiles = new Map<string, Buffer>([
      ["releases/abc1234-def56789012/bin.dat", binaryContent],
      ["releases/abc1234-def56789012/release-manifest.json", Buffer.from(JSON.stringify(manifest))],
    ]);

    const runner = makeDownloadRunner(downloadedFiles);
    const result = await verifyRelease("bucket", "abc1234-def56789012", manifest, { runner });
    expect(result.verified).toBe(true);
  });

  it("aborts on hash mismatch — names exact key", async () => {
    const manifest = {
      id: "rel-1",
      gitSha: "abc1234",
      clientManifestDigest: "def56789012",
      createdAt: "2026-07-12T00:00:00.000Z",
      files: [{ path: "index.html", sha256: "0".repeat(64), size: 6 }],
    };

    const downloadedFiles = new Map<string, Buffer>([
      ["releases/rel-1/index.html", Buffer.from("<html>")], // hash won't match "0"*64
      ["releases/rel-1/release-manifest.json", Buffer.from(JSON.stringify(manifest))],
    ]);

    const runner = makeDownloadRunner(downloadedFiles);
    await expect(verifyRelease("bucket", "rel-1", manifest, { runner })).rejects.toThrow(
      /Hash mismatch.*releases\/rel-1\/index\.html/,
    );
  });

  it("aborts on missing object — names exact key", async () => {
    const manifest = {
      id: "rel-2",
      gitSha: "abc1234",
      clientManifestDigest: "def56789012",
      createdAt: "2026-07-12T00:00:00.000Z",
      files: [{ path: "missing.txt", sha256: "x".repeat(64), size: 3 }],
    };

    // Object not in downloadedFiles → 404
    const downloadedFiles = new Map<string, Buffer>([
      ["releases/rel-2/release-manifest.json", Buffer.from(JSON.stringify(manifest))],
    ]);

    const runner = makeDownloadRunner(downloadedFiles);
    await expect(verifyRelease("bucket", "rel-2", manifest, { runner })).rejects.toThrow(
      /Missing.*releases\/rel-2\/missing\.txt/,
    );
  });

  it("aborts on malformed/tampered manifest — identity mismatch", async () => {
    const content = Buffer.from("<html>");
    const hash = createHash("sha256").update(content).digest("hex");

    const manifest = {
      id: "rel-3",
      gitSha: "abc1234",
      clientManifestDigest: "def56789012",
      createdAt: "2026-07-12T00:00:00.000Z",
      files: [{ path: "index.html", sha256: hash, size: 6 }],
    };

    // Tampered manifest on R2 — different id
    const tamperedManifest = { ...manifest, id: "TAMPERED" };
    const downloadedFiles = new Map<string, Buffer>([
      ["releases/rel-3/index.html", content],
      ["releases/rel-3/release-manifest.json", Buffer.from(JSON.stringify(tamperedManifest))],
    ]);

    const runner = makeDownloadRunner(downloadedFiles);
    await expect(verifyRelease("bucket", "rel-3", manifest, { runner })).rejects.toThrow(
      /manifest.*id.*mismatch|tampered|identity/i,
    );
  });

  it("aborts on tampered manifest — digest mismatch", async () => {
    // Manifest files list claims a hash, but the actual file has different content
    const realContent = Buffer.from("actual content");
    const realHash = createHash("sha256").update(realContent).digest("hex");

    const manifest = {
      id: "rel-4",
      gitSha: "abc1234",
      clientManifestDigest: "def56789012",
      createdAt: "2026-07-12T00:00:00.000Z",
      files: [{ path: "file.txt", sha256: realHash, size: realContent.length }],
    };

    // Manifest on R2 claims a DIFFERENT digest than what we expect
    const tamperedManifest = { ...manifest, clientManifestDigest: "000000000000" };
    const downloadedFiles = new Map<string, Buffer>([
      ["releases/rel-4/file.txt", realContent],
      ["releases/rel-4/release-manifest.json", Buffer.from(JSON.stringify(tamperedManifest))],
    ]);

    const runner = makeDownloadRunner(downloadedFiles);
    await expect(verifyRelease("bucket", "rel-4", manifest, { runner })).rejects.toThrow(/digest/i);
  });

  it("verifies immutable copies — re-downloads and hashes", async () => {
    const content = Buffer.from("console.log(1)");
    const hash = createHash("sha256").update(content).digest("hex");

    const manifest = {
      id: "rel-5",
      gitSha: "abc1234",
      clientManifestDigest: "def56789012",
      createdAt: "2026-07-12T00:00:00.000Z",
      files: [{ path: "assets/index-AbCdEf12.js", sha256: hash, size: 13 }],
    };

    const downloadedFiles = new Map<string, Buffer>([
      ["releases/rel-5/assets/index-AbCdEf12.js", content],
      ["immutable/assets/index-AbCdEf12.js", content], // immutable copy
      ["releases/rel-5/release-manifest.json", Buffer.from(JSON.stringify(manifest))],
    ]);

    const runner = makeDownloadRunner(downloadedFiles);
    const result = await verifyRelease("bucket", "rel-5", manifest, { runner });
    expect(result.verified).toBe(true);
    expect(result.checkedKeys).toContain("releases/rel-5/assets/index-AbCdEf12.js");
    expect(result.checkedKeys).toContain("immutable/assets/index-AbCdEf12.js");
  });

  it("aborts if immutable copy missing — names exact key", async () => {
    const content = Buffer.from("code");
    const hash = createHash("sha256").update(content).digest("hex");

    const manifest = {
      id: "rel-6",
      gitSha: "abc1234",
      clientManifestDigest: "def56789012",
      createdAt: "2026-07-12T00:00:00.000Z",
      files: [{ path: "assets/index-AbCdEf12.js", sha256: hash, size: 4 }],
    };

    // Release-scoped copy exists, but immutable copy is missing
    const downloadedFiles = new Map<string, Buffer>([
      ["releases/rel-6/assets/index-AbCdEf12.js", content],
      ["releases/rel-6/release-manifest.json", Buffer.from(JSON.stringify(manifest))],
      // immutable/assets/index-AbCdEf12.js MISSING
    ]);

    const runner = makeDownloadRunner(downloadedFiles);
    await expect(verifyRelease("bucket", "rel-6", manifest, { runner })).rejects.toThrow(
      /Missing.*immutable\/assets\/index-AbCdEf12\.js/,
    );
  });

  it("aborts if immutable copy hash mismatch — names exact key", async () => {
    const content = Buffer.from("code");
    const hash = createHash("sha256").update(content).digest("hex");

    const manifest = {
      id: "rel-7",
      gitSha: "abc1234",
      clientManifestDigest: "def56789012",
      createdAt: "2026-07-12T00:00:00.000Z",
      files: [{ path: "assets/index-AbCdEf12.js", sha256: hash, size: 4 }],
    };

    // Immutable copy has different content
    const downloadedFiles = new Map<string, Buffer>([
      ["releases/rel-7/assets/index-AbCdEf12.js", content],
      ["immutable/assets/index-AbCdEf12.js", Buffer.from("TAMPERED")],
      ["releases/rel-7/release-manifest.json", Buffer.from(JSON.stringify(manifest))],
    ]);

    const runner = makeDownloadRunner(downloadedFiles);
    await expect(verifyRelease("bucket", "rel-7", manifest, { runner })).rejects.toThrow(
      /Hash mismatch.*immutable\/assets\/index-AbCdEf12\.js/,
    );
  });

  it("manifest last invariant — verifies manifest exists and parses", async () => {
    const content = Buffer.from("x");
    const hash = createHash("sha256").update(content).digest("hex");

    const manifest = {
      id: "rel-8",
      gitSha: "abc1234",
      clientManifestDigest: "def56789012",
      createdAt: "2026-07-12T00:00:00.000Z",
      files: [{ path: "f.txt", sha256: hash, size: 1 }],
    };

    // Manifest missing from R2
    const downloadedFiles = new Map<string, Buffer>([
      ["releases/rel-8/f.txt", content],
      // release-manifest.json MISSING
    ]);

    const runner = makeDownloadRunner(downloadedFiles);
    await expect(verifyRelease("bucket", "rel-8", manifest, { runner })).rejects.toThrow(
      /Missing.*manifest|manifest.*not found/i,
    );
  });

  it("aborts on malformed manifest JSON on R2", async () => {
    const content = Buffer.from("x");
    const hash = createHash("sha256").update(content).digest("hex");

    const manifest = {
      id: "rel-9",
      gitSha: "abc1234",
      clientManifestDigest: "def56789012",
      createdAt: "2026-07-12T00:00:00.000Z",
      files: [{ path: "f.txt", sha256: hash, size: 1 }],
    };

    const downloadedFiles = new Map<string, Buffer>([
      ["releases/rel-9/f.txt", content],
      ["releases/rel-9/release-manifest.json", Buffer.from("NOT JSON{")],
    ]);

    const runner = makeDownloadRunner(downloadedFiles);
    await expect(verifyRelease("bucket", "rel-9", manifest, { runner })).rejects.toThrow();
  });

  it("retries download on R2 429 / code 971 then succeeds", async () => {
    const content = Buffer.from("hello");
    const hash = createHash("sha256").update(content).digest("hex");

    const manifest = {
      id: "rel-10",
      gitSha: "abc1234",
      clientManifestDigest: "def56789012",
      createdAt: "2026-07-12T00:00:00.000Z",
      files: [{ path: "f.txt", sha256: hash, size: 5 }],
    };

    let downloadCalls = 0;
    const sleepDelays: number[] = [];
    const sleep = (ms: number) => {
      sleepDelays.push(ms);
      return Promise.resolve();
    };

    const downloadedFiles = new Map<string, Buffer>([
      ["releases/rel-10/f.txt", content],
      ["releases/rel-10/release-manifest.json", Buffer.from(JSON.stringify(manifest))],
    ]);

    const baseRunner = makeDownloadRunner(downloadedFiles);
    const runner = async (argv: string[]) => {
      downloadCalls++;
      // First download attempt for f.txt returns 429
      if (downloadCalls === 1 && argv.includes("bucket/releases/rel-10/f.txt")) {
        return { exitCode: 1, stdout: "", stderr: "error code 971: rate limited" };
      }
      return baseRunner(argv);
    };

    const result = await verifyRelease("bucket", "rel-10", manifest, { runner, sleep });
    expect(result.verified).toBe(true);
    // Confirmed retry happened (at least 2 calls for the throttled key)
    expect(downloadCalls).toBeGreaterThanOrEqual(2);
    // Exponential backoff was applied
    expect(sleepDelays.length).toBeGreaterThanOrEqual(1);
    expect(sleepDelays[0]).toBe(1000); // initialDelay
  });

  it("reports persistent non-429 error distinctly from missing object", async () => {
    const content = Buffer.from("hello");
    const hash = createHash("sha256").update(content).digest("hex");

    const manifest = {
      id: "rel-11",
      gitSha: "abc1234",
      clientManifestDigest: "def56789012",
      createdAt: "2026-07-12T00:00:00.000Z",
      files: [{ path: "f.txt", sha256: hash, size: 5 }],
    };

    const sleep = () => Promise.resolve();

    // Runner that always returns a non-429 non-404 error (e.g. 500)
    const runner = async (argv: string[]) => {
      const keyArg = argv.find((a) => a.includes("bucket/"));
      const key = keyArg?.replace("bucket/", "") ?? "";
      if (key === "releases/rel-11/f.txt") {
        return { exitCode: 1, stdout: "", stderr: "Internal server error" };
      }
      // manifest download succeeds
      const fileArg = argv.find((a) => a.startsWith("--file=")) ?? "";
      const filePath = fileArg.slice("--file=".length);
      if (filePath) writeFileSync(filePath, Buffer.from(JSON.stringify(manifest)));
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await expect(verifyRelease("bucket", "rel-11", manifest, { runner, sleep })).rejects.toThrow(
      /Download failed.*releases\/rel-11\/f\.txt/,
    );
  });
});

// ── Test helpers ─────────────────────────────────────────────────────

/**
 * Make a download runner that simulates `wrangler r2 object get ... --remote --file`.
 * Returns the object content as a Buffer. If key not found, returns exit code 1.
 */
function makeDownloadRunner(downloadedFiles: Map<string, Buffer>) {
  return async (argv: string[]) => {
    // argv: ["wrangler", "r2", "object", "get", "bucket/key", "--remote", "--file=path"]
    const keyArg = argv.find((a) => a.includes("bucket/"));
    if (!keyArg) return { exitCode: 1, stdout: "", stderr: "no bucket key" };
    const key = keyArg.replace("bucket/", "");
    const content = downloadedFiles.get(key);
    if (!content) {
      return { exitCode: 1, stdout: "", stderr: `Object not found: ${key}` };
    }
    // Simulate wrangler writing to the --file path
    const fileArg = argv.find((a) => a.startsWith("--file=")) ?? "";
    const filePath = fileArg.slice("--file=".length);
    if (filePath) {
      writeFileSync(filePath, content);
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}
