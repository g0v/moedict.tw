/**
 * R2 upload library with bounded concurrency and transient-error backoff.
 *
 * Uses shared releaseKey/immutableKey from src/utils/release-keys.ts —
 * NO duplicate key construction. Upload order: all client files first
 * (release-scoped + immutable copies for hashed assets), then
 * release-manifest.json LAST only after all other uploads succeed.
 *
 * Concurrency default/max ≤4. Exponential backoff for true 429 /
 * Cloudflare code 971, transient HTTP 5xx, and transient network
 * failures; permanent 4xx (except 429) fail-fast. Bounded attempts/delay.
 * Injectable sleep/runner for deterministic tests. No shell command
 * strings — argv subprocess execution to prevent injection.
 */

import { extname, join, relative, sep } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { releaseKey, immutableKey, isImmutableAsset } from "../../src/utils/release-keys.ts";

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
 * @typedef {Object} UploadEntry
 * @property {string} key
 * @property {string} filePath
 * @property {string} contentType
 * @property {string} cacheControl
 */

/**
 * @typedef {Object} FsAdapter
 * @property {(path: string) => Buffer} readFileSync
 * @property {(path: string, opts: { withFileTypes: true }) => Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>} readdirSync
 */

// Production runner uses the project-local Wrangler through `vp exec`; argv
// is kept separate throughout (no shell interpolation).
import { spawn } from "node:child_process";

/**
 * Execute a command through Wrangler's project-local vp entrypoint.
 * Child errors reject; null/signal closes are failures (never success).
 *
 * Wrangler reads CLOUDFLARE_ENV from the environment and maps it to --env,
 * which conflicts with the already-flattened generated configs (they have no
 * [env.*] sections). Always strip CLOUDFLARE_ENV from the child env so the
 * wrangler subprocess never sees it. Some callers (wrangler-versions.mjs)
 * pass --config with the flattened generated config for the target
 * environment; the R2 object put/get callers in this file and in
 * release-verify.mjs pass the target bucket name directly in the object
 * path instead and rely on top-level wrangler.jsonc/account discovery, so
 * they never pass --config.
 *
 * @param {string[]} argv
 * @param {(file: string, args: string[], opts: object) => object} [spawnImpl]
 * @returns {Promise<RunnerResult>}
 */
export function runWrangler(argv, spawnImpl = spawn) {
  // Build a clean child env: inherit everything except CLOUDFLARE_ENV.
  // eslint-disable-next-line no-unused-vars
  const { CLOUDFLARE_ENV: _omit, ...childEnv } = process.env;
  return new Promise((resolve, reject) => {
    const proc = spawnImpl(argv[0], argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.once("error", reject);
    proc.once("close", (code) => {
      resolve({ exitCode: typeof code === "number" ? code : 1, stdout, stderr });
    });
  });
}

/**
 * Default sleep: real setTimeout. Tests inject a fake.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(() => resolve(), ms);
  return promise;
}

/**
 * Content-Type lookup for common web file extensions.
 * @param {string} filePath
 * @returns {string}
 */
export function contentTypeFor(filePath) {
  const ext = extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
    ".wasm": "application/wasm",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
  };
  return types[ext] ?? "application/octet-stream";
}

/**
 * Cache-Control policy: immutable for hashed assets, short TTL for everything else.
 * @param {string} key
 * @returns {string}
 */
export function cacheControlFor(key) {
  // Content-hashed assets get immutable cache
  if (isImmutableAsset(key)) {
    return "public, max-age=31536000, immutable";
  }
  // HTML shell: short edge TTL
  if (key.endsWith("index.html") || key.endsWith("release-manifest.json")) {
    return "public, max-age=0, s-maxage=60";
  }
  // Default: 5 min edge TTL
  return "public, max-age=300";
}

/**
 * Upload a single object to R2 via `vp exec wrangler r2 object put`.
 * Uses argv (not shell string) to prevent injection.
 * @param {string} bucketName
 * @param {string} key
 * @param {string} filePath
 * @param {{ contentType?: string; cacheControl?: string; runner?: Runner }} [opts]
 */
export async function uploadObject(bucketName, key, filePath, opts = {}) {
  const runner = opts.runner ?? runWrangler;
  const contentType = opts.contentType ?? contentTypeFor(filePath);
  const cacheControl = opts.cacheControl ?? cacheControlFor(key);

  const argv = [
    "vp",
    "exec",
    "wrangler",
    "r2",
    "object",
    "put",
    `${bucketName}/${key}`,
    `--file=${filePath}`,
    "--remote",
    `--content-type=${contentType}`,
    `--cache-control=${cacheControl}`,
  ];

  const result = await runner(argv);
  if (result.exitCode !== 0) {
    throw new Error(
      `Upload failed for ${bucketName}/${key} (exit ${result.exitCode}): ${result.stderr}`,
    );
  }
  return result;
}

/**
 * Retry with exponential backoff for transient failures only:
 * rate limits (429 / Cloudflare 971), HTTP 5xx, and network errors.
 * Permanent 4xx (except 429) and other non-transient errors fail-fast.
 * Bounded attempts and delay. Injectable sleep for deterministic tests.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ maxRetries?: number; initialDelay?: number; maxDelay?: number; sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<T>}
 */
export async function retryWithBackoff(fn, opts = {}) {
  const maxRetries = opts.maxRetries ?? 5;
  const initialDelay = opts.initialDelay ?? 1000;
  const maxDelay = opts.maxDelay ?? 60000;
  const sleep = opts.sleep ?? defaultSleep;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // Only retry transient rate-limit / 5xx / network failures
      if (!isRetryableError(err) || attempt === maxRetries) {
        throw err;
      }
      const delay = Math.min(initialDelay * 2 ** attempt, maxDelay);
      await sleep(delay);
    }
  }
  throw lastError;
}

/** Node system error codes that represent transient network failures. */
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "ECONNABORTED",
]);

/**
 * True when an error is a transient failure worth retrying:
 * - rate limits (HTTP 429 / Cloudflare code 971)
 * - HTTP 5xx / Cloudflare internal errors
 * - transient network/socket failures
 *
 * Permanent 4xx (except 429) and non-transient errors return false.
 * Patterns are anchored so bare digits in object keys / request ids
 * (e.g. "object key 500", "request id 429971") are NOT treated as
 * retryable.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRetryableError(err) {
  if (!err || typeof err !== "object") return false;
  const e = /** @type {Record<string, unknown>} */ (err);

  // Numeric rate-limit codes (injected by tests / structured errors)
  if (e.code === 971 || e.code === 429) return true;

  // Node system error codes for transient network failures
  if (typeof e.code === "string" && TRANSIENT_NETWORK_CODES.has(e.code)) {
    return true;
  }
  // Nested cause (e.g. undici/fetch wrapping a system error)
  if (e.cause && typeof e.cause === "object") {
    const cause = /** @type {Record<string, unknown>} */ (e.cause);
    if (typeof cause.code === "string" && TRANSIENT_NETWORK_CODES.has(cause.code)) {
      return true;
    }
  }

  const text = [e.stderr, e.message, e.stdout].filter((v) => typeof v === "string").join("\n");
  if (!text) return false;

  // Rate limits — anchored status/code framing only
  if (
    /\b(?:error\s+)?code\s*[:=]?\s*971\b/i.test(text) ||
    /\bstatus(?:\s+code)?\s*[:=]?\s*429\b/i.test(text) ||
    /\bHTTP\s+429\b/i.test(text) ||
    /\bToo Many Requests\b/i.test(text)
  ) {
    return true;
  }

  // Transient HTTP 5xx / Cloudflare internal errors.
  // Wrangler R2 format observed in production:
  //   "…/objects/stroke-json/80cc.json - 500: Internal Server Error;"
  // plus JSON body: {"errors":[{"code":10001,"message":"We encountered an internal error…"}]}
  if (
    /\bstatus(?:\s+code)?\s*[:=]?\s*5\d{2}\b/i.test(text) ||
    /\bHTTP\s+5\d{2}\b/i.test(text) ||
    /[-:]\s*5\d{2}\s*:\s*Internal Server Error\b/i.test(text) ||
    /\b5\d{2}\s+Internal Server Error\b/i.test(text) ||
    /\bInternal Server Error\b/i.test(text) ||
    /\bBad Gateway\b/i.test(text) ||
    /\bService Unavailable\b/i.test(text) ||
    /\bGateway Timeout\b/i.test(text) ||
    /\bWe encountered an internal error\b/i.test(text) ||
    /\bsocket hang up\b/i.test(text) ||
    /\bfetch failed\b/i.test(text) ||
    /\bnetwork\s+(?:error|failure|timeout)\b/i.test(text)
  ) {
    return true;
  }

  return false;
}

/**
 * Upload multiple files with bounded concurrency (default/max ≤4).
 * @param {UploadEntry[]} files
 * @param {string} bucketName
 * @param {{ maxConcurrent?: number; runner?: Runner; sleep?: (ms: number) => Promise<void> }} [opts]
 */
export async function uploadWithConcurrency(files, bucketName, opts = {}) {
  const requestedConcurrency = opts.maxConcurrent ?? 4;
  if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1) {
    throw new Error(`maxConcurrent must be a positive integer: ${requestedConcurrency}`);
  }
  const maxConcurrent = Math.min(requestedConcurrency, 4);
  const runner = opts.runner ?? runWrangler;
  const sleep = opts.sleep ?? defaultSleep;

  let index = 0;

  async function worker() {
    while (index < files.length) {
      const current = files[index++];
      await retryWithBackoff(
        () =>
          uploadObject(bucketName, current.key, current.filePath, {
            contentType: current.contentType,
            cacheControl: current.cacheControl,
            runner,
          }),
        { sleep },
      );
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrent, files.length) }, () => worker());
  await Promise.all(workers);
}

/**
 * Enumerate files recursively under a directory.
 * @param {string} dir
 * @param {FsAdapter} fs
 * @returns {string[]}
 */
function enumerateFiles(dir, fs) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link outside release directory: ${full}`);
    }
    if (entry.isDirectory()) {
      results.push(...enumerateFiles(full, fs));
    } else {
      results.push(full);
    }
  }
  return results;
}

/**
 * Upload a full release to R2:
 * 1. Upload all dist/client/** files to releases/<id>/<relative-path>
 * 2. Upload content-hashed dist/client/assets/** to immutable/assets/<relative-path>
 * 3. Upload release-manifest.json LAST (only after all other uploads succeed)
 *
 * Uses shared releaseKey/immutableKey — NO duplicate key construction.
 * @param {string} releaseId
 * @param {string} distClientDir
 * @param {string} bucketName
 * @param {{ runner?: Runner; sleep?: (ms: number) => Promise<void>; fs?: FsAdapter; manifestJson?: string }} [opts]
 */
export async function uploadReleaseToR2(releaseId, distClientDir, bucketName, opts = {}) {
  const runner = opts.runner ?? runWrangler;
  const sleep = opts.sleep ?? defaultSleep;
  const fs = opts.fs ?? defaultFs;
  const manifestJson = opts.manifestJson ?? "{}";

  // 1. Enumerate all files (excluding release-manifest.json)
  const allFiles = enumerateFiles(distClientDir, fs)
    .map((abs) => relative(distClientDir, abs).split(sep).join("/"))
    .filter((p) => p !== "release-manifest.json")
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // 2. Build upload list: release-scoped + immutable copies for hashed assets
  /** @type {UploadEntry[]} */
  const uploadEntries = [];
  for (const relPath of allFiles) {
    const absPath = join(distClientDir, relPath);
    const ct = contentTypeFor(absPath);
    const cc = cacheControlFor(relPath);

    // Release-scoped upload
    uploadEntries.push({
      key: releaseKey(releaseId, relPath),
      filePath: absPath,
      contentType: ct,
      cacheControl: cc,
    });

    // Immutable copy for content-hashed assets
    if (isImmutableAsset(relPath)) {
      uploadEntries.push({
        key: immutableKey(relPath),
        filePath: absPath,
        contentType: ct,
        cacheControl: "public, max-age=31536000, immutable",
      });
    }
  }

  // 3. Upload all files (NOT manifest yet).
  await uploadWithConcurrency(uploadEntries, bucketName, { runner, sleep });

  // 4. Upload release-manifest.json LAST (only after all other uploads succeed).
  // A failed object may leave already-started idempotent uploads running; the
  // manifest remains withheld, which preserves the publication invariant.
  const manifestKey = releaseKey(releaseId, "release-manifest.json");
  const tmpDir = mkdtempSync(join(tmpdir(), "r2-manifest-"));
  try {
    const manifestPath = join(tmpDir, "release-manifest.json");
    writeFileSync(manifestPath, manifestJson);
    await retryWithBackoff(
      () =>
        uploadObject(bucketName, manifestKey, manifestPath, {
          contentType: "application/json; charset=utf-8",
          cacheControl: "public, max-age=0, s-maxage=60",
          runner,
        }),
      { sleep },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Default fs adapter using real Node.js fs
import { readFileSync, statSync, readdirSync as realReaddirSync } from "node:fs";

const defaultFs = {
  readFileSync: (p) => readFileSync(p),
  statSync: (p) => statSync(p),
  readdirSync: (p, opts) =>
    /** @type {Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>} */ (
      realReaddirSync(p, opts)
    ),
};
