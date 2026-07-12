/**
 * Release verification CLI library.
 *
 * Re-downloads and hashes EVERY uploaded object: release-scoped files,
 * immutable copies, and the separately uploaded manifest. Verification
 * MUST hash binary bytes (downloaded file buffer via arrayBuffer), never
 * response.text(). Buckets are private: use injectable
 * `wrangler r2 object get ... --remote --file`/runner, not unauthenticated
 * public URLs. Missing/mismatch aborts naming exact key. Verify manifest
 * identity/digest/files before success. Use shared releaseKey/immutableKey.
 *
 * Import-safe: main guard at bottom. CLI fails nonzero.
 */

import { createHash } from "node:crypto";
import { readFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { releaseKey, immutableKey, isImmutableAsset } from "../src/utils/release-keys.ts";
import { retryWithBackoff } from "./lib/r2-upload.mjs";

/**
 * @typedef {Object} RunnerResult
 * @property {number} exitCode
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {(argv: string[]) => Promise<RunnerResult>} Runner
 */

/**
 * @typedef {Object} VerifyResult
 * @property {boolean} verified
 * @property {string[]} checkedKeys
 */

// Default runner uses child_process spawn (argv, no shell)
import { spawn } from "node:child_process";

/**
 * Default runner: executes wrangler via argv (no shell string).
 * @param {string[]} argv
 * @returns {Promise<RunnerResult>}
 */
async function defaultRunner(argv) {
  return new Promise((resolve) => {
    const proc = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

/**
 * Default sleep: real setTimeout. Tests inject a fake.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Download an R2 object to a temp file and return its binary content.
 * Uses `wrangler r2 object get <bucket>/<key> --remote --file=<path>`.
 *
 * Retries on true R2 429 / Cloudflare code 971 with bounded exponential
 * backoff (same as uploads — verification GETs are equally rate-limited).
 * Non-429 errors are reported distinctly from missing object (404).
 *
 * @param {string} bucketName
 * @param {string} key
 * @param {{ runner?: Runner; sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<Buffer>}
 */
async function downloadR2Object(bucketName, key, opts = {}) {
  const runner = opts.runner ?? defaultRunner;
  const sleep = opts.sleep ?? defaultSleep;
  const tmpDir = mkdtempSync(join(tmpdir(), "r2-verify-"));
  const filePath = join(tmpDir, "object.bin");

  const argv = [
    "wrangler",
    "r2",
    "object",
    "get",
    `${bucketName}/${key}`,
    "--remote",
    `--file=${filePath}`,
  ];

  try {
    await retryWithBackoff(
      async () => {
        const result = await runner(argv);
        if (result.exitCode !== 0) {
          // Distinguish missing object (404) from other download errors.
          // Both get thrown; retryWithBackoff only retries 429/971.
          const stderr = result.stderr ?? "";
          if (
            stderr.includes("not found") ||
            stderr.includes("NoSuchKey") ||
            stderr.includes("404")
          ) {
            throw new Error(`Missing object: ${key} (exit ${result.exitCode}): ${stderr}`);
          }
          // Non-429 non-404 error (429/971 will be retried by retryWithBackoff)
          throw new Error(`Download failed: ${key} (exit ${result.exitCode}): ${stderr}`);
        }
      },
      { sleep },
    );
    return readFileSync(filePath);
  } finally {
    try {
      unlinkSync(filePath);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(tmpDir);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Verify a release by re-downloading and hashing every uploaded object.
 *
 * Checks:
 * 1. Every file in manifest.files: download from releases/<id>/<path>, hash, compare
 * 2. Immutable copies for hashed assets: download from immutable/assets/<path>, hash, compare
 * 3. Manifest itself: download, parse, verify identity/digest/files match
 *
 * Any missing/mismatch aborts naming exact key.
 * @param {string} bucketName
 * @param {string} releaseId
 * @param {{ id: string; gitSha: string; clientManifestDigest: string; createdAt: string; files: Array<{ path: string; sha256: string; size: number }> }} manifest
 * @param {{ runner?: Runner; sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<VerifyResult>}
 */
export async function verifyRelease(bucketName, releaseId, manifest, opts = {}) {
  const runner = opts.runner ?? defaultRunner;
  const sleep = opts.sleep ?? defaultSleep;
  const checkedKeys = [];

  // 1. Verify every file in manifest.files
  const files = /** @type {Array<{ path: string; sha256: string; size: number }>} */ (
    manifest.files
  );

  for (const file of files) {
    const key = releaseKey(releaseId, file.path);
    const content = await downloadR2Object(bucketName, key, { runner, sleep });
    checkedKeys.push(key);

    // Hash binary bytes, never text
    const hash = createHash("sha256").update(content).digest("hex");
    if (hash !== file.sha256) {
      throw new Error(`Hash mismatch: ${key} (expected ${file.sha256}, got ${hash})`);
    }
  }

  // 2. Verify immutable copies for content-hashed assets
  for (const file of files) {
    if (!isImmutableAsset(file.path)) continue;
    const immKey = immutableKey(file.path);
    const content = await downloadR2Object(bucketName, immKey, { runner, sleep });
    checkedKeys.push(immKey);

    const hash = createHash("sha256").update(content).digest("hex");
    if (hash !== file.sha256) {
      throw new Error(`Hash mismatch: ${immKey} (expected ${file.sha256}, got ${hash})`);
    }
  }

  // 3. Verify manifest itself: download, parse, validate identity/digest/files
  const manifestKey = releaseKey(releaseId, "release-manifest.json");
  let manifestContent;
  try {
    manifestContent = await downloadR2Object(bucketName, manifestKey, { runner, sleep });
  } catch (err) {
    // Preserve rate-limit errors distinctly; only report "Missing manifest"
    // for actual missing-object (404) errors.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("Missing object:")) {
      throw new Error(`Missing manifest: ${manifestKey}`);
    }
    throw err;
  }
  checkedKeys.push(manifestKey);

  /** @type {{ id: string; clientManifestDigest: string; files: Array<{ path: string }> }} */
  let parsedManifest;
  try {
    parsedManifest = JSON.parse(manifestContent.toString("utf-8"));
  } catch {
    throw new Error(`Malformed manifest JSON: ${manifestKey}`);
  }

  // The caller's locally-built manifest is the authentication reference. The
  // release path and every manifest field must agree with that reference.
  if (manifest.id !== releaseId) {
    throw new Error(
      `Release identity mismatch: ${manifestKey} (expected releaseId=${releaseId}, got id=${manifest.id})`,
    );
  }
  if (parsedManifest.id !== manifest.id) {
    throw new Error(
      `Manifest identity mismatch: ${manifestKey} (expected id=${manifest.id}, got id=${parsedManifest.id})`,
    );
  }
  if (parsedManifest.gitSha !== manifest.gitSha) {
    throw new Error(
      `Manifest git SHA mismatch: ${manifestKey} (expected ${manifest.gitSha}, got ${parsedManifest.gitSha})`,
    );
  }
  if (parsedManifest.clientManifestDigest !== manifest.clientManifestDigest) {
    throw new Error(
      `Manifest digest mismatch: ${manifestKey} (expected ${manifest.clientManifestDigest}, got ${parsedManifest.clientManifestDigest})`,
    );
  }

  // Verify the complete file records, not merely paths: a tampered hash or
  // size field must never be accepted even when the payload still matches the
  // locally-built release.
  const parsedFiles = parsedManifest.files;
  if (!Array.isArray(parsedFiles) || parsedFiles.length !== files.length) {
    throw new Error(`Manifest files list mismatch: ${manifestKey}`);
  }
  for (let i = 0; i < files.length; i++) {
    const expected = files[i];
    const actual = parsedFiles[i];
    if (
      actual?.path !== expected.path ||
      actual?.sha256 !== expected.sha256 ||
      actual?.size !== expected.size
    ) {
      throw new Error(`Manifest file record mismatch at index ${i}: ${manifestKey}`);
    }
  }

  return { verified: true, checkedKeys };
}

// Main guard — import-safe CLI entry point
import { fileURLToPath } from "node:url";
import { parseGeneratedConfig, getAssetsBucketName } from "./lib/generated-config.mjs";
import { buildReleaseManifest } from "./lib/release-manifest.mjs";

async function main() {
  const configPath = "dist/cf_moedict_webkit_neo/wrangler.json";
  const env = process.env.CLOUDFLARE_ENV ?? "production";
  const config = parseGeneratedConfig(configPath);
  const bucketName = getAssetsBucketName(config, env);
  const distClientDir = "dist/client";
  const manifest = buildReleaseManifest(distClientDir);

  console.log(`[release-verify] Verifying release ${manifest.id} in bucket ${bucketName}`);
  const result = await verifyRelease(bucketName, manifest.id, manifest);
  if (result.verified) {
    console.log(`[release-verify] OK — verified ${result.checkedKeys.length} objects`);
  }
}

// Import-safe: run only when invoked directly, never when unit tests import.
const invokedDirectly = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((error) => {
    console.error("[release-verify] FAILED", error);
    process.exit(1);
  });
}
