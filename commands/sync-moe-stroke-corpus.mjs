#!/usr/bin/env node
/**
 * Full official MOE stroke-order corpus pipeline (6,063 characters).
 *
 * Authoritative discovery source: 教育部《國字標準字體筆順學習網》
 *   https://stroke-order.learningweb.moe.edu.tw/download/6063png.zip
 *   (`全字筆順提示下載` — one PNG per character, basenames = exact corpus).
 *
 * For each character:
 *   1. GET dictView.jsp?ID=<decimal-unicode> (via fetch-moe-stroke.mjs)
 *   2. Extract inline stroke XML → moedict stroke-json schema
 *   3. Write stroke-json/<lowercase-hex>.json locally
 *   4. Record sha256 + stroke count in a manifest
 *
 * Upload modes reuse scripts/lib/r2-upload.mjs `uploadWithConcurrency`
 * (≤4 concurrent, 429/971 backoff) and scripts/lib/generated-config.mjs
 * `getAssetsBucketName` so staging → moedict-assets-preview and production
 * → moedict-assets. Never deletes or overwrites unrelated R2 keys.
 *
 * Fail-closed:
 *   - discovery count ≠ 6,063
 *   - duplicate characters / codepoints
 *   - any conversion gap after fetch (unless --allow-partial for resume debugging)
 *
 * Usage:
 *   # dry-run: discover + fetch + convert + write local, no R2
 *   node commands/sync-moe-stroke-corpus.mjs --dry-run --out .moe-stroke-corpus
 *
 *   # upload to staging ASSETS bucket (requires build-time generated config)
 *   CLOUDFLARE_ENV=staging node commands/sync-moe-stroke-corpus.mjs \
 *     --upload=staging --out .moe-stroke-corpus
 *
 *   # production (after staging verification)
 *   node commands/sync-moe-stroke-corpus.mjs --upload=production --out .moe-stroke-corpus
 *
 * Options:
 *   --out <dir>              local output directory (default: .moe-stroke-corpus)
 *   --dry-run                discover+fetch+convert only (default when no --upload)
 *   --upload=staging|production
 *   --limit <n>              process only first n characters (debug)
 *   --concurrency <n>        MOE fetch concurrency (default 4, max 8)
 *   --zip-url <url>          override discovery zip URL
 *   --zip-path <path>        use a local zip instead of downloading
 *   --chars-file <path>      inject a newline-separated character list (tests)
 *   --checkpoint <path>      progress ndjson path (default: <out>/checkpoint.ndjson)
 *   --skip-verify            skip post-upload byte/hash verification
 *   --allow-partial          do not fail closed on conversion gaps (debug only)
 *   --config <path>          generated wrangler.json (default: dist/cf_moedict_webkit_neo/wrangler.json)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import {
  fetchAndConvertMoeStroke,
  toHexCodepoint,
  toDecimalCodepoint,
} from "./fetch-moe-stroke.mjs";
import {
  uploadWithConcurrency,
  retryWithBackoff,
  runWrangler,
  isNotFoundStderr,
} from "../scripts/lib/r2-upload.mjs";
import { parseGeneratedConfig, getAssetsBucketName } from "../scripts/lib/generated-config.mjs";
import {
  STROKE_CORPUS_POINTER_KEY,
  STROKE_CORPUS_EXPECTED_COUNT,
  strokeCorpusManifestKey,
  strokeCorpusObjectKey,
  isStrokeCorpusPointer,
  isStrokeCorpusManifest,
} from "../src/utils/stroke-corpus.ts";
import { appendCorpusPointerHistory } from "../scripts/lib/stroke-corpus-state.mjs";

export const EXPECTED_CORPUS_SIZE = 6063;
/**
 * Default maxRetries for post-upload verify downloads.
 * Higher than upload's shared default (5) because 6,063 sequential
 * authenticated re-GETs are long-lived and more exposed to transient
 * network flakes (`fetch failed`). Upload path keeps retryWithBackoff's
 * default of 5.
 */
export const DEFAULT_VERIFY_MAX_RETRIES = 8;
const DEFAULT_ZIP_URL = "https://stroke-order.learningweb.moe.edu.tw/download/6063png.zip";
const DEFAULT_OUT = ".moe-stroke-corpus";
const DEFAULT_CONFIG = "dist/cf_moedict_webkit_neo/wrangler.json";
const STROKE_CACHE_CONTROL = "public, max-age=86400";
const STROKE_CONTENT_TYPE = "application/json; charset=utf-8";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Extract the exact character list from the official 6063png.zip.
 * Basenames of `*.png` entries (without extension) are the corpus characters.
 *
 * Fail-closed: count must be exactly 6063, all unique single codepoints.
 *
 * @param {Buffer} zipBytes
 * @returns {{ char: string, decimalId: number, hex: string }[]}
 */
export function discoverCorpusFromZipBytes(zipBytes) {
  // Lazy-load unzip via Node's built-in experimental? Prefer `yauzl`/`jszip`
  // if present; otherwise use a minimal central-directory parser for stored
  // entries (the official zip uses store compression for PNGs).
  const names = listZipEntryNames(zipBytes);
  const chars = [];
  for (const name of names) {
    if (name.endsWith("/")) continue;
    const base = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
    if (!base.toLowerCase().endsWith(".png")) continue;
    const char = base.slice(0, -4); // strip .png
    if (!char) {
      throw new Error(`empty character basename in zip entry: ${name}`);
    }
    chars.push(char);
  }
  return validateAndBuildCorpus(chars);
}

/**
 * Build a validated corpus from an explicit character list (for tests / --chars-file).
 * @param {string[]} chars
 */
export function validateAndBuildCorpus(chars) {
  if (!Array.isArray(chars) || chars.length === 0) {
    throw new Error("corpus character list is empty");
  }
  if (chars.length !== EXPECTED_CORPUS_SIZE) {
    throw new Error(`corpus size mismatch: expected ${EXPECTED_CORPUS_SIZE}, got ${chars.length}`);
  }
  const seenChars = new Set();
  const seenHex = new Set();
  /** @type {{ char: string, decimalId: number, hex: string }[]} */
  const corpus = [];
  for (const char of chars) {
    if (typeof char !== "string" || char.length === 0) {
      throw new Error(`corpus entry is not a single codepoint: ${JSON.stringify(char)}`);
    }
    const cp = char.codePointAt(0);
    if (cp === undefined) {
      throw new Error(`corpus entry is not a single codepoint: ${JSON.stringify(char)}`);
    }
    // One codepoint occupies 1 UTF-16 unit (BMP) or 2 (astral). Any other
    // length means multiple characters or a lone surrogate.
    const expectedUnits = cp > 0xffff ? 2 : 1;
    if (char.length !== expectedUnits) {
      throw new Error(`corpus entry is not a single codepoint: ${JSON.stringify(char)}`);
    }
    if (seenChars.has(char)) {
      throw new Error(`duplicate character in corpus: ${char}`);
    }
    const decimalId = toDecimalCodepoint(char);
    const hex = toHexCodepoint(char);
    if (seenHex.has(hex)) {
      throw new Error(`duplicate codepoint in corpus: U+${hex.toUpperCase()} (${char})`);
    }
    seenChars.add(char);
    seenHex.add(hex);
    corpus.push({ char, decimalId, hex });
  }
  // Stable order by codepoint for deterministic manifests
  corpus.sort((a, b) => a.decimalId - b.decimalId);
  return corpus;
}

/**
 * Decode a ZIP entry name.
 *
 * The official 6063png.zip marks only ~16 entries with the UTF-8
 * general-purpose bit (0x800); the rest store Big5 (cp950) basenames.
 * Many Big5 two-byte sequences are also well-formed UTF-8 (e.g. C9 AB is
 * both Big5「伎」and UTF-8 U+026B), so we MUST NOT "prefer UTF-8 when valid"
 * for unflagged entries — that silently corrupts ~200 characters.
 *
 * @param {Buffer} raw
 * @param {number} flag
 */
export function decodeZipEntryName(raw, flag) {
  if (flag & 0x800) return raw.toString("utf8");
  return new TextDecoder("big5").decode(raw);
}
/**
 * Minimal ZIP central-directory name lister (store + deflate entries both OK —
 * we only need filenames, not payload bytes).
 * @param {Buffer} buf
 * @returns {string[]}
 */
export function listZipEntryNames(buf) {
  // Find End of Central Directory record (signature 0x06054b50)
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 0x10015; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP: End of Central Directory not found");
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > buf.length) {
    throw new Error("ZIP: central directory extends past end of file");
  }
  const names = [];
  let pos = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error(`ZIP: bad central directory signature at ${pos}`);
    }
    const flag = buf.readUInt16LE(pos + 8);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const rawName = buf.subarray(pos + 46, pos + 46 + nameLen);
    names.push(decodeZipEntryName(rawName, flag));
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/**
 * Download the discovery zip (or read a local path). Injectable fetch for tests.
 * @param {{ zipUrl?: string, zipPath?: string, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<Buffer>}
 */
export async function loadDiscoveryZip(opts = {}) {
  if (opts.zipPath) {
    return readFileSync(opts.zipPath);
  }
  const url = opts.zipUrl ?? DEFAULT_ZIP_URL;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl(url, {
    headers: { "User-Agent": "moedict.tw stroke-corpus pipeline" },
  });
  if (!res.ok) {
    throw new Error(`failed to download discovery zip: HTTP ${res.status} from ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Load characters from a newline-separated UTF-8 file (one character per line).
 * @param {string} path
 * @returns {string[]}
 */
export function loadCharsFile(path) {
  const text = readFileSync(path, "utf8");
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

// ---------------------------------------------------------------------------
// Conversion + local write
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CorpusEntry
 * @property {string} char
 * @property {number} decimalId
 * @property {string} hex
 */

/**
 * @typedef {Object} ManifestEntry
 * @property {string} char
 * @property {string} hex
 * @property {number} decimalId
 * @property {number} strokeCount
 * @property {string} sha256
 * @property {number} bytes
 * @property {string} sourceUrl
 * @property {string} r2Key
 */

/**
 * Convert one character and write local JSON. Injectable converter for tests.
 * @param {CorpusEntry} entry
 * @param {string} outDir
 * @param {{ convert?: typeof fetchAndConvertMoeStroke }} [opts]
 * @returns {Promise<ManifestEntry | null>}
 */
export async function convertAndWriteEntry(entry, outDir, opts = {}) {
  const convert = opts.convert ?? fetchAndConvertMoeStroke;
  const result = await convert(entry.char);
  if (!result) return null;
  if (!Array.isArray(result.json) || result.json.length === 0) {
    throw new Error(`${entry.char} (U+${entry.hex}): converted JSON has no strokes`);
  }
  // Validate schema lightly: every stroke needs outline + track arrays
  for (const stroke of result.json) {
    if (!stroke || !Array.isArray(stroke.outline) || !Array.isArray(stroke.track)) {
      throw new Error(`${entry.char} (U+${entry.hex}): malformed stroke object`);
    }
    if (stroke.outline.length === 0) {
      throw new Error(`${entry.char} (U+${entry.hex}): empty outline`);
    }
  }
  const body = JSON.stringify(result.json);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const jsonDir = join(outDir, "stroke-json");
  mkdirSync(jsonDir, { recursive: true });
  const filePath = join(jsonDir, `${entry.hex}.json`);
  writeFileSync(filePath, body, "utf8");
  // Optional provenance XML for debugging (not uploaded)
  if (result.xml) {
    const xmlDir = join(outDir, "xml");
    mkdirSync(xmlDir, { recursive: true });
    writeFileSync(
      join(xmlDir, `${entry.hex}.xml`),
      `<!-- source: ${result.sourceUrl} -->\n${result.xml}`,
      "utf8",
    );
  }
  return {
    char: entry.char,
    hex: entry.hex,
    decimalId: entry.decimalId,
    strokeCount: result.json.length,
    sha256,
    bytes: Buffer.byteLength(body),
    sourceUrl: result.sourceUrl,
    r2Key: `stroke-json/${entry.hex}.json`,
  };
}

/**
 * Run conversion over a corpus with bounded concurrency + checkpoint resume.
 * @param {CorpusEntry[]} corpus
 * @param {string} outDir
 * @param {{
 *   concurrency?: number,
 *   checkpointPath?: string,
 *   convert?: typeof fetchAndConvertMoeStroke,
 *   limit?: number,
 *   onProgress?: (done: number, total: number, entry: ManifestEntry | null, char: string) => void,
 * }} [opts]
 */
export async function convertCorpus(corpus, outDir, opts = {}) {
  const concurrency = Math.min(Math.max(opts.concurrency ?? 4, 1), 8);
  const checkpointPath = opts.checkpointPath ?? join(outDir, "checkpoint.ndjson");
  mkdirSync(outDir, { recursive: true });

  /** @type {Map<string, ManifestEntry>} */
  const done = loadCheckpoint(checkpointPath, outDir);
  let work = corpus.filter((e) => !done.has(e.hex));
  if (Number.isFinite(opts.limit) && opts.limit >= 0) {
    work = work.slice(0, opts.limit);
  }

  let idx = 0;
  /** @type {ManifestEntry[]} */
  const results = [...done.values()];
  /** @type {string[]} */
  const gaps = [];

  async function worker() {
    while (idx < work.length) {
      const current = work[idx++];
      try {
        const entry = await convertAndWriteEntry(current, outDir, { convert: opts.convert });
        if (!entry) {
          gaps.push(current.char);
          appendFileSync(
            checkpointPath,
            JSON.stringify({ hex: current.hex, char: current.char, status: "missing" }) + "\n",
          );
          opts.onProgress?.(results.length + gaps.length, corpus.length, null, current.char);
          continue;
        }
        results.push(entry);
        appendFileSync(checkpointPath, JSON.stringify({ ...entry, status: "ok" }) + "\n");
        opts.onProgress?.(results.length + gaps.length, corpus.length, entry, current.char);
      } catch (err) {
        appendFileSync(
          checkpointPath,
          JSON.stringify({
            hex: current.hex,
            char: current.char,
            status: "error",
            error: String(
              err && /** @type {Error} */ (err).message ? /** @type {Error} */ (err).message : err,
            ),
          }) + "\n",
        );
        throw err;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(work.length, 1)) }, () => worker()),
  );
  return { results, gaps, checkpointPath };
}

/**
 * Load and revalidate a checkpoint file.
 *
 * For each "ok" record we:
 *   1. Verify the local stroke-json/<hex>.json file exists.
 *   2. Re-hash its contents and compare against the stored sha256.
 *   3. Re-parse the JSON to confirm it is a non-empty stroke array.
 *
 * Records that fail any check are dropped so the entry re-converts from
 * scratch.  A truncated final crash line is silently discarded.
 *
 * Note: the checkpoint does NOT store a fingerprint of the upstream MOE
 * source.  If MOE updates a character's stroke data between runs the
 * checkpoint will report that character as done.  Pass a fresh --out
 * directory (or delete checkpoint.ndjson) to force re-fetch of all entries.
 *
 * @param {string} checkpointPath
 * @param {string} [outDir]  — required for local file revalidation
 * @returns {Map<string, ManifestEntry>}
 */
export function loadCheckpoint(checkpointPath, outDir) {
  /** @type {Map<string, ManifestEntry>} */
  const map = new Map();
  if (!existsSync(checkpointPath)) return map;
  const text = readFileSync(checkpointPath, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // Truncated final line from a hard crash — discard and continue
      continue;
    }
    if (rec.status !== "ok" || !rec.hex || !rec.sha256) continue;
    if (!/^[0-9a-f]{4,6}$/.test(rec.hex)) continue;
    if (!/^[0-9a-f]{64}$/.test(rec.sha256)) continue;

    // Revalidate the local file when outDir is provided (normal convertCorpus path)
    if (outDir) {
      const filePath = join(outDir, "stroke-json", `${rec.hex}.json`);
      if (!existsSync(filePath)) continue; // file deleted since checkpoint — re-convert
      let fileBytes;
      try {
        fileBytes = readFileSync(filePath);
      } catch {
        continue; // unreadable — re-convert
      }
      const actualSha = createHash("sha256").update(fileBytes).digest("hex");
      if (actualSha !== rec.sha256) continue; // file modified or corrupted — re-convert
      // Light schema check: must be a non-empty JSON array of stroke objects
      try {
        const json = JSON.parse(fileBytes.toString("utf8"));
        if (!Array.isArray(json) || json.length === 0) continue;
        if (!json[0] || !Array.isArray(json[0].outline) || !Array.isArray(json[0].track)) continue;
      } catch {
        continue;
      }
    }

    map.set(rec.hex, {
      char: rec.char,
      hex: rec.hex,
      decimalId: rec.decimalId,
      strokeCount: rec.strokeCount,
      sha256: rec.sha256,
      bytes: rec.bytes,
      sourceUrl: rec.sourceUrl,
      r2Key: rec.r2Key ?? `stroke-json/${rec.hex}.json`,
    });
  }
  return map;
}

/**
 * Build and write the corpus manifest. Fail-closed on size unless allowPartial.
 * @param {ManifestEntry[]} entries
 * @param {string} outDir
 * @param {{ allowPartial?: boolean, expectedSize?: number }} [opts]
 */
export function writeManifest(entries, outDir, opts = {}) {
  const expected = opts.expectedSize ?? EXPECTED_CORPUS_SIZE;
  if (!opts.allowPartial && entries.length !== expected) {
    throw new Error(
      `manifest size mismatch: expected ${expected} converted entries, got ${entries.length}`,
    );
  }
  // Uniqueness
  const hexes = new Set();
  for (const e of entries) {
    if (hexes.has(e.hex)) throw new Error(`duplicate hex in manifest: ${e.hex}`);
    hexes.add(e.hex);
    if (!e.sha256 || !/^[0-9a-f]{64}$/.test(e.sha256)) {
      throw new Error(`invalid sha256 for ${e.hex}`);
    }
    if (!e.strokeCount || e.strokeCount < 1) {
      throw new Error(`empty strokes for ${e.hex}`);
    }
  }
  const sorted = [...entries].sort((a, b) => a.decimalId - b.decimalId);
  const manifest = {
    version: 1,
    source: "MOE 國字標準字體筆順學習網",
    discovery: DEFAULT_ZIP_URL,
    expectedCount: expected,
    count: sorted.length,
    generatedAt: new Date().toISOString(),
    entries: sorted,
  };
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, "manifest.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { path, manifest };
}

// ---------------------------------------------------------------------------
// Upload + verify (reuse r2-upload helpers)
// ---------------------------------------------------------------------------

/**
 * Build UploadEntry list from a completed local corpus directory.
 * @param {ManifestEntry[]} entries
 * @param {string} outDir
 */
export function buildUploadEntries(entries, outDir) {
  return entries.map((e) => ({
    key: e.r2Key,
    filePath: join(outDir, "stroke-json", `${e.hex}.json`),
    contentType: STROKE_CONTENT_TYPE,
    cacheControl: STROKE_CACHE_CONTROL,
  }));
}

/**
 * Upload stroke-json objects via shared uploadWithConcurrency.
 * Does NOT delete or list unrelated keys — only PUT of our keys.
 * @param {ManifestEntry[]} entries
 * @param {string} outDir
 * @param {string} bucketName
 * @param {{ runner?: import("../scripts/lib/r2-upload.mjs").Runner, sleep?: (ms: number) => Promise<void>, maxConcurrent?: number }} [opts]
 */
export async function uploadCorpus(entries, outDir, bucketName, opts = {}) {
  const files = buildUploadEntries(entries, outDir);
  // Defensive: refuse missing local files before touching R2
  for (const f of files) {
    if (!existsSync(f.filePath)) {
      throw new Error(`missing local file for upload: ${f.filePath}`);
    }
  }
  await uploadWithConcurrency(files, bucketName, {
    maxConcurrent: opts.maxConcurrent ?? 4,
    runner: opts.runner,
    sleep: opts.sleep,
  });
}

/**
 * Post-upload byte/hash verification via wrangler r2 object get --remote.
 * Mirrors scripts/release-verify.mjs: hash binary bytes, never response.text().
 *
 * Uses bounded concurrency (≤4, matching uploadWithConcurrency) to keep
 * verification time proportional to upload time instead of spawning 6,063
 * sequential Wrangler processes. Each download retries on 429/code 971/5xx/
 * network flakes with a verify-specific default of {@link DEFAULT_VERIFY_MAX_RETRIES}
 * (8) — higher than upload's shared default of 5. Inject `maxRetries` to override.
 *
 * @param {ManifestEntry[]} entries
 * @param {string} bucketName
 * @param {{ runner?: Function, sleep?: (ms: number) => Promise<void>, maxConcurrent?: number, maxRetries?: number }} [opts]
 */
export async function verifyCorpusUploads(entries, bucketName, opts = {}) {
  const runner = opts.runner ?? runWrangler;
  const sleep =
    opts.sleep ??
    ((ms) => {
      const { promise, resolve } = Promise.withResolvers();
      setTimeout(() => resolve(), ms);
      return promise;
    });
  const maxConcurrent = Math.min(opts.maxConcurrent ?? 4, 4);
  const maxRetries = opts.maxRetries ?? DEFAULT_VERIFY_MAX_RETRIES;

  /** @type {string[]} */
  const checked = [];
  let idx = 0;

  async function verifyWorker() {
    while (idx < entries.length) {
      const entry = entries[idx++];
      const tmpDir = mkdtempSync(join(tmpdir(), "stroke-verify-"));
      try {
        const filePath = join(tmpDir, "object.bin");
        const argv = [
          "vp",
          "exec",
          "wrangler",
          "r2",
          "object",
          "get",
          `${bucketName}/${entry.r2Key}`,
          "--remote",
          `--file=${filePath}`,
        ];
        await retryWithBackoff(
          async () => {
            const result = await runner(argv);
            if (result.exitCode !== 0) {
              const stderr = result.stderr ?? "";
              if (isNotFoundStderr(stderr)) {
                throw new Error(`Missing object after upload: ${entry.r2Key}`);
              }
              // surface 429/5xx/network as retryable via isRetryableError patterns
              const err = new Error(
                `Download failed: ${entry.r2Key} (exit ${result.exitCode}): ${stderr}`,
              );
              /** @type {any} */ (err).stderr = stderr;
              throw err;
            }
          },
          { sleep, maxRetries },
        );
        const bytes = readFileSync(filePath);
        const sha = createHash("sha256").update(bytes).digest("hex");
        if (sha !== entry.sha256) {
          throw new Error(`hash mismatch for ${entry.r2Key}: expected ${entry.sha256}, got ${sha}`);
        }
        if (bytes.length !== entry.bytes) {
          throw new Error(
            `size mismatch for ${entry.r2Key}: expected ${entry.bytes}, got ${bytes.length}`,
          );
        }
        checked.push(entry.r2Key);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrent, Math.max(entries.length, 1)) }, () =>
    verifyWorker(),
  );
  await Promise.all(workers);
  return { verified: true, checkedKeys: checked };
}

/**
 * Resolve the ASSETS bucket for an upload target via generated wrangler config.
 * @param {string} target
 * @param {string} [configPath]
 */
export function resolveAssetsBucket(target, configPath = DEFAULT_CONFIG) {
  if (target !== "staging" && target !== "production") {
    throw new Error(`unsupported upload target: ${String(target)}`);
  }
  const abs = configPath.startsWith("/") ? configPath : join(REPO_ROOT, configPath);
  if (!existsSync(abs)) {
    throw new Error(
      `generated config not found: ${abs} — run a ${target} build first so dist/cf_moedict_webkit_neo/wrangler.json is flattened for the target env`,
    );
  }
  const config = parseGeneratedConfig(abs);
  return getAssetsBucketName(config, target);
}

// ---------------------------------------------------------------------------
// Atomic corpus model (immutable digest-scoped storage + pointer)
// ---------------------------------------------------------------------------
//
// Layout:
//   stroke-corpora/<corpusDigest>/stroke-json/<hex>.json  — immutable objects
//   stroke-corpora/<corpusDigest>/manifest.json           — full per-file manifest
//   stroke-corpus/current.json                            — pointer (promoted LAST)
//
// Sequencing (never violated):
//   1. Upload all 6,063 objects under the digest-scoped prefix.
//   2. Write the manifest AFTER every object succeeds.
//   3. Authenticated re-GET + sha256/bytes verification of every object
//      AND the manifest itself.
//   4. Only then promote the pointer — and only after recording the prior
//      pointer (if any) in local rollback state.
// A digest prefix is NEVER overwritten: `corpusDigest` is a content hash of
// every file's sha256, so a changed corpus always gets a new prefix. No GC —
// old digest prefixes are left in place for rollback.

/**
 * Deterministic content-addressed digest for a full corpus: sha256 of the
 * newline-joined `hex:sha256` pairs, sorted by hex. Any change to any
 * file's content (or the file set) changes the digest, so a digest is
 * never reused for different content and the prefix it names is safe to
 * treat as immutable.
 * @param {ManifestEntry[]} entries
 * @returns {string}
 */
export function computeCorpusDigest(entries) {
  const sorted = [...entries].sort((a, b) => (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0));
  const material = sorted.map((e) => `${e.hex}:${e.sha256}`).join("\n");
  return createHash("sha256").update(material).digest("hex");
}

/**
 * Build the full per-file atomic manifest (src/utils/stroke-corpus.ts
 * `StrokeCorpusManifest` shape) for a completed, digest-addressed corpus.
 * @param {ManifestEntry[]} entries
 * @param {string} corpusDigest
 */
export function buildAtomicCorpusManifest(entries, corpusDigest) {
  if (entries.length !== STROKE_CORPUS_EXPECTED_COUNT) {
    throw new Error(
      `atomic manifest size mismatch: expected ${STROKE_CORPUS_EXPECTED_COUNT}, got ${entries.length}`,
    );
  }
  const sorted = [...entries].sort((a, b) => (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0));
  const files = sorted.map((e) => ({
    path: `stroke-json/${e.hex}.json`,
    sha256: e.sha256,
    bytes: e.bytes,
  }));
  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  /** @type {import("../src/utils/stroke-corpus.ts").StrokeCorpusManifest} */
  const manifest = {
    schema: 1,
    corpusDigest,
    fileCount: files.length,
    totalBytes,
    files,
  };
  if (!isStrokeCorpusManifest(manifest)) {
    throw new Error("built atomic manifest failed its own schema validation");
  }
  return manifest;
}

/**
 * Build UploadEntry list for the digest-scoped immutable object prefix.
 * Cache-Control is `immutable` — the digest prefix, once fully uploaded
 * and verified, never changes.
 * @param {ManifestEntry[]} entries
 * @param {string} outDir
 * @param {string} corpusDigest
 */
export function buildAtomicUploadEntries(entries, outDir, corpusDigest) {
  return entries.map((e) => ({
    key: strokeCorpusObjectKey(corpusDigest, e.hex),
    filePath: join(outDir, "stroke-json", `${e.hex}.json`),
    contentType: STROKE_CONTENT_TYPE,
    cacheControl: "public, max-age=31536000, immutable",
  }));
}

/**
 * Upload every object under the digest-scoped prefix. Never touches the
 * manifest or pointer keys — pure object PUTs, safe to retry.
 * @param {ManifestEntry[]} entries
 * @param {string} outDir
 * @param {string} bucketName
 * @param {string} corpusDigest
 * @param {{ runner?: import("../scripts/lib/r2-upload.mjs").Runner, sleep?: (ms: number) => Promise<void>, maxConcurrent?: number }} [opts]
 */
export async function uploadAtomicCorpusObjects(
  entries,
  outDir,
  bucketName,
  corpusDigest,
  opts = {},
) {
  const files = buildAtomicUploadEntries(entries, outDir, corpusDigest);
  for (const f of files) {
    if (!existsSync(f.filePath)) {
      throw new Error(`missing local file for atomic upload: ${f.filePath}`);
    }
  }
  await uploadWithConcurrency(files, bucketName, {
    maxConcurrent: opts.maxConcurrent ?? 4,
    runner: opts.runner,
    sleep: opts.sleep,
  });
}

/**
 * Write the digest-scoped manifest.json to R2. Must only be called AFTER
 * every object in the digest prefix has been uploaded — the manifest is
 * the caller-visible "this digest is complete" signal.
 * @param {import("../src/utils/stroke-corpus.ts").StrokeCorpusManifest} manifest
 * @param {string} bucketName
 * @param {{ runner?: import("../scripts/lib/r2-upload.mjs").Runner }} [opts]
 */
export async function uploadAtomicCorpusManifest(manifest, bucketName, opts = {}) {
  const runner = opts.runner ?? runWrangler;
  const tmpDir = mkdtempSync(join(tmpdir(), "stroke-manifest-"));
  try {
    const filePath = join(tmpDir, "manifest.json");
    const body = JSON.stringify(manifest);
    writeFileSync(filePath, body, "utf8");
    const key = strokeCorpusManifestKey(manifest.corpusDigest);
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
      "--content-type=application/json; charset=utf-8",
      "--cache-control=public, max-age=31536000, immutable",
    ];
    await retryWithBackoff(async () => {
      const result = await runner(argv);
      if (result.exitCode !== 0) {
        throw new Error(
          `manifest upload failed for ${key} (exit ${result.exitCode}): ${result.stderr}`,
        );
      }
    }, opts);
    return { key, bytes: Buffer.byteLength(body) };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Authenticated re-download + sha256/bytes verification of every object
 * under a digest prefix AND the manifest.json itself. Read-only — never
 * writes. Bounded concurrency (≤4) with the verify-specific retry default.
 * @param {import("../src/utils/stroke-corpus.ts").StrokeCorpusManifest} manifest
 * @param {string} bucketName
 * @param {{ runner?: Function, sleep?: (ms: number) => Promise<void>, maxConcurrent?: number, maxRetries?: number }} [opts]
 */
export async function verifyAtomicCorpusUploads(manifest, bucketName, opts = {}) {
  const runner = opts.runner ?? runWrangler;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxConcurrent = Math.min(opts.maxConcurrent ?? 4, 4);
  const maxRetries = opts.maxRetries ?? DEFAULT_VERIFY_MAX_RETRIES;

  /** @param {string} key @param {string} expectedSha @param {number} expectedBytes */
  async function downloadAndCheck(key, expectedSha, expectedBytes) {
    const tmpDir = mkdtempSync(join(tmpdir(), "stroke-corpus-verify-"));
    try {
      const filePath = join(tmpDir, "object.bin");
      const argv = [
        "vp",
        "exec",
        "wrangler",
        "r2",
        "object",
        "get",
        `${bucketName}/${key}`,
        "--remote",
        `--file=${filePath}`,
      ];
      await retryWithBackoff(
        async () => {
          const result = await runner(argv);
          if (result.exitCode !== 0) {
            const stderr = result.stderr ?? "";
            if (isNotFoundStderr(stderr)) {
              throw new Error(`Missing object during verify: ${key}`);
            }
            const err = new Error(`Download failed: ${key} (exit ${result.exitCode}): ${stderr}`);
            /** @type {any} */ (err).stderr = stderr;
            throw err;
          }
        },
        { sleep, maxRetries },
      );
      const bytes = readFileSync(filePath);
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (sha !== expectedSha) {
        throw new Error(`hash mismatch for ${key}: expected ${expectedSha}, got ${sha}`);
      }
      if (bytes.length !== expectedBytes) {
        throw new Error(`size mismatch for ${key}: expected ${expectedBytes}, got ${bytes.length}`);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // Manifest itself first — fail fast if the digest prefix was never
  // completed rather than spending time on 6,063 object downloads.
  const manifestKey = strokeCorpusManifestKey(manifest.corpusDigest);
  const manifestBody = JSON.stringify(manifest);
  await downloadAndCheck(
    manifestKey,
    createHash("sha256").update(manifestBody).digest("hex"),
    Buffer.byteLength(manifestBody),
  );

  /** @type {string[]} */
  const checked = [];
  let idx = 0;
  async function worker() {
    while (idx < manifest.files.length) {
      const file = manifest.files[idx++];
      const hex = file.path.replace(/^stroke-json\//, "").replace(/\.json$/, "");
      const key = strokeCorpusObjectKey(manifest.corpusDigest, hex);
      await downloadAndCheck(key, file.sha256, file.bytes);
      checked.push(key);
    }
  }
  const workers = Array.from(
    { length: Math.min(maxConcurrent, Math.max(manifest.files.length, 1)) },
    () => worker(),
  );
  await Promise.all(workers);
  return { verified: true, checkedKeys: checked, manifestKey };
}

/**
 * Sentinel thrown internally to distinguish "object genuinely absent"
 * (never retried, mapped to `null`) from a transient/permanent download
 * failure (retried per `isRetryableError`, then rethrown as-is). Never
 * escapes {@link readCorpusPointer} itself.
 */
class CorpusPointerNotFoundError extends Error {}

/**
 * Authenticated read of the pointer object (`stroke-corpus/current.json`).
 * Returns `null` when the pointer object does not exist (fresh bucket, no
 * prior corpus). Throws on any other failure or on schema-invalid content
 * — never silently treats a corrupt pointer as absent.
 *
 * Wrapped in the same `retryWithBackoff` used by {@link readCorpusManifest}
 * and {@link verifyAtomicCorpusUploads} (verify-specific default
 * `DEFAULT_VERIFY_MAX_RETRIES=8`) — a transient network blip on this read
 * previously hard-failed the deploy preflight (`verifyCorpusReadiness`)
 * and `promoteCorpusPointer`'s prior-pointer read (right after a
 * multi-minute 6,063-object upload) with zero retries, unlike every other
 * read on the same critical path.
 * @param {string} bucketName
 * @param {{ runner?: Function, sleep?: (ms: number) => Promise<void>, maxRetries?: number }} [opts]
 * @returns {Promise<import("../src/utils/stroke-corpus.ts").StrokeCorpusPointer | null>}
 */
export async function readCorpusPointer(bucketName, opts = {}) {
  const runner = opts.runner ?? runWrangler;
  const tmpDir = mkdtempSync(join(tmpdir(), "stroke-pointer-"));
  try {
    const filePath = join(tmpDir, "current.json");
    const argv = [
      "vp",
      "exec",
      "wrangler",
      "r2",
      "object",
      "get",
      `${bucketName}/${STROKE_CORPUS_POINTER_KEY}`,
      "--remote",
      `--file=${filePath}`,
    ];
    let result;
    try {
      result = await retryWithBackoff(
        async () => {
          const attemptResult = await runner(argv);
          if (attemptResult.exitCode !== 0) {
            const stderr = attemptResult.stderr ?? "";
            if (isNotFoundStderr(stderr)) {
              // Not found is a legitimate, stable outcome — never retried,
              // never surfaced as a thrown failure to the caller. A
              // curated message (not raw stderr) so it can never
              // coincidentally match isRetryableError's transient-pattern
              // scan the way `verifyAtomicCorpusUploads`'s "Missing
              // object" error is deliberately curated for the same reason.
              throw new CorpusPointerNotFoundError("corpus pointer object not found");
            }
            const err = new Error(
              `Failed to read corpus pointer (exit ${attemptResult.exitCode}): ${stderr}`,
            );
            /** @type {any} */ (err).stderr = stderr;
            throw err;
          }
          return attemptResult;
        },
        { sleep: opts.sleep, maxRetries: opts.maxRetries ?? DEFAULT_VERIFY_MAX_RETRIES },
      );
    } catch (err) {
      if (err instanceof CorpusPointerNotFoundError) return null;
      throw err;
    }
    void result;
    const raw = readFileSync(filePath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Corpus pointer at ${bucketName}/${STROKE_CORPUS_POINTER_KEY} is not valid JSON`,
      );
    }
    if (!isStrokeCorpusPointer(parsed)) {
      throw new Error(
        `Corpus pointer at ${bucketName}/${STROKE_CORPUS_POINTER_KEY} failed schema validation`,
      );
    }
    return parsed;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * P2 residual-risk note (read before touching pointer promotion):
 * R2 has NO compare-and-swap / conditional PUT — `wrangler r2 object put
 * --help` exposes no `--if-match`/ETag-conditional flag, and the
 * Cloudflare R2 API itself has no equivalent for the plain object PUT
 * operation used here. Uploads therefore MUST be operator-serialized:
 * never run two concurrent `--upload=<env>` invocations against the same
 * environment/bucket. {@link promoteCorpusPointer}'s optimistic re-read
 * (below) narrows — but does NOT eliminate — the race window: it detects
 * a concurrent promotion that completed BEFORE this process's own final
 * pointer PUT, but a race landing in the gap between that re-read and the
 * PUT itself is still possible and unprotected (last-writer-wins, same as
 * before this fix). This is a best-effort mitigation, not a correctness
 * guarantee — do not present it as one.
 */

/**
 * Promote a new corpus pointer LAST — after every object and the manifest
 * have been uploaded and authenticated-verified. Reads the prior pointer
 * first (if any) and records it in local rollback state BEFORE writing
 * the new one, so an operator can always recover the last-known-good
 * digest even if this process crashes immediately after the R2 write.
 *
 * Optimistic concurrency check: when `opts.expectedPriorPointer` is
 * provided (passed by {@link runAtomicCorpusUpload} from a pointer read
 * taken BEFORE the — potentially multi-minute — object upload started),
 * this re-read of the pointer (taken immediately before the PUT below) is
 * compared against it by `corpusDigest`. A mismatch means a concurrent
 * operator run promoted a DIFFERENT corpus while this process's own
 * upload was in flight — the promotion is aborted (thrown) BEFORE any
 * rollback-history write or pointer PUT, leaving R2 and local state
 * completely untouched. See the residual-risk note above: this reduces
 * but does not eliminate the race (no R2 CAS/conditional PUT exists).
 * Callers that omit `expectedPriorPointer` (e.g. a direct/manual
 * `promoteCorpusPointer` call, or the existing rollback-history unit
 * tests) skip this check entirely — behavior is unchanged for them.
 * @param {string} bucketName
 * @param {"staging"|"production"} env
 * @param {import("../src/utils/stroke-corpus.ts").StrokeCorpusManifest} manifest
 * @param {{ runner?: Function, sleep?: (ms: number) => Promise<void>, maxRetries?: number, nowIso?: () => string, stateBaseDir?: string, stateFs?: object, expectedPriorPointer?: import("../src/utils/stroke-corpus.ts").StrokeCorpusPointer | null }} [opts]
 */
export async function promoteCorpusPointer(bucketName, env, manifest, opts = {}) {
  const runner = opts.runner ?? runWrangler;
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());

  // Record the prior pointer (if any) BEFORE mutating — rollback state
  // must reflect what was live immediately before this promotion. This
  // same read doubles as the optimistic re-read for the concurrency
  // check just below (it happens right before pointer marshaling + PUT,
  // with no R2 I/O in between).
  const priorPointer = await readCorpusPointer(bucketName, {
    runner,
    sleep: opts.sleep,
    maxRetries: opts.maxRetries,
  });

  if (opts.expectedPriorPointer !== undefined) {
    const expectedDigest = opts.expectedPriorPointer
      ? opts.expectedPriorPointer.corpusDigest
      : null;
    const actualDigest = priorPointer ? priorPointer.corpusDigest : null;
    if (expectedDigest !== actualDigest) {
      throw new Error(
        `Aborting pointer promotion: corpus pointer changed since the pre-upload read ` +
          `(expected corpusDigest=${expectedDigest ?? "<none>"}, found ${actualDigest ?? "<none>"}) — ` +
          `a concurrent operator run likely promoted a different corpus while this upload was in flight. ` +
          `Uploads must be operator-serialized (see the residual-risk note above this function); ` +
          `re-run \`node commands/sync-moe-stroke-corpus.mjs --upload=${env}\` to promote against the current pointer.`,
      );
    }
  }

  if (priorPointer) {
    appendCorpusPointerHistory(
      env,
      {
        corpusDigest: priorPointer.corpusDigest,
        manifestKey: priorPointer.manifestKey,
        fileCount: priorPointer.fileCount,
        totalBytes: priorPointer.totalBytes,
        promotedAt: nowIso(),
      },
      { baseDir: opts.stateBaseDir, fs: opts.stateFs },
    );
  }

  /** @type {import("../src/utils/stroke-corpus.ts").StrokeCorpusPointer} */
  const pointer = {
    schema: 1,
    corpusDigest: manifest.corpusDigest,
    manifestKey: strokeCorpusManifestKey(manifest.corpusDigest),
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
  };
  if (!isStrokeCorpusPointer(pointer)) {
    throw new Error("built corpus pointer failed its own schema validation");
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "stroke-pointer-promote-"));
  try {
    const filePath = join(tmpDir, "current.json");
    const body = JSON.stringify(pointer);
    writeFileSync(filePath, body, "utf8");
    const argv = [
      "vp",
      "exec",
      "wrangler",
      "r2",
      "object",
      "put",
      `${bucketName}/${STROKE_CORPUS_POINTER_KEY}`,
      `--file=${filePath}`,
      "--remote",
      "--content-type=application/json; charset=utf-8",
      "--cache-control=no-store",
    ];
    await retryWithBackoff(async () => {
      const result = await runner(argv);
      if (result.exitCode !== 0) {
        throw new Error(`pointer promotion failed (exit ${result.exitCode}): ${result.stderr}`);
      }
    }, opts);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // Record the NEW pointer too, so the next promotion's "prior" lookup
  // (and any operator inspecting history) always has the full chain.
  appendCorpusPointerHistory(
    env,
    { ...pointer, promotedAt: nowIso() },
    { baseDir: opts.stateBaseDir, fs: opts.stateFs },
  );

  return pointer;
}

/**
 * Full atomic upload pipeline: upload objects → write manifest → verify
 * everything (authenticated) → promote pointer last. On any failure
 * BEFORE promotion, the pointer is left untouched (fail-closed: a
 * partially-uploaded digest prefix is orphaned but never made live).
 *
 * Captures the pointer BEFORE step 1 (object upload — potentially
 * multi-minute for the full 6,063-object corpus) and passes it to
 * `promoteCorpusPointer` as `expectedPriorPointer`, so promotion aborts
 * (before any write) if a concurrent operator run promoted a different
 * corpus while this upload was in flight. See `promoteCorpusPointer`'s
 * doc comment for the residual-race caveat — this narrows, but does not
 * eliminate, the window (R2 has no compare-and-swap / conditional PUT).
 * @param {ManifestEntry[]} entries
 * @param {string} outDir
 * @param {string} bucketName
 * @param {"staging"|"production"} env
 * @param {{ runner?: Function, sleep?: (ms: number) => Promise<void>, maxConcurrent?: number, maxRetries?: number, nowIso?: () => string, stateBaseDir?: string, stateFs?: object }} [opts]
 */
export async function runAtomicCorpusUpload(entries, outDir, bucketName, env, opts = {}) {
  const corpusDigest = computeCorpusDigest(entries);
  const manifest = buildAtomicCorpusManifest(entries, corpusDigest);
  const runner = opts.runner ?? runWrangler;

  // 0. Baseline read BEFORE any upload work starts — the concurrency
  // check's reference point (see promoteCorpusPointer's doc comment).
  const preUploadPointer = await readCorpusPointer(bucketName, {
    runner,
    sleep: opts.sleep,
    maxRetries: opts.maxRetries,
  });

  // 1. Upload every object under the digest-scoped immutable prefix.
  await uploadAtomicCorpusObjects(entries, outDir, bucketName, corpusDigest, opts);

  // 2. Manifest AFTER every object has landed.
  await uploadAtomicCorpusManifest(manifest, bucketName, opts);

  // 3. Authenticated re-GET + sha256/bytes verification of everything.
  const verification = await verifyAtomicCorpusUploads(manifest, bucketName, opts);

  // 4. Pointer promoted LAST, only after verification passes. Aborts
  // (throws, no write) if the pointer changed since step 0.
  const pointer = await promoteCorpusPointer(bucketName, env, manifest, {
    ...opts,
    expectedPriorPointer: preUploadPointer,
  });

  return { corpusDigest, manifest, verification, pointer };
}

/**
 * Read + schema-validate the corpus manifest at `pointer.manifestKey`,
 * cross-checked against the pointer's own `corpusDigest`/`fileCount`.
 * Shared by `verifyCorpusOnly` (full re-download+hash verification of
 * every object) and the lightweight deploy-preflight
 * `verifyCorpusReadiness` (pointer+manifest only, zero object reads) so
 * both apply IDENTICAL schema/consistency rules to the manifest bytes —
 * one manifest-GET, one set of checks, two very different callers.
 * @param {string} bucketName
 * @param {import("../src/utils/stroke-corpus.ts").StrokeCorpusPointer} pointer
 * @param {{ runner?: Function, sleep?: (ms: number) => Promise<void>, maxRetries?: number }} [opts]
 * @returns {Promise<import("../src/utils/stroke-corpus.ts").StrokeCorpusManifest>}
 */
export async function readCorpusManifest(bucketName, pointer, opts = {}) {
  const runner = opts.runner ?? runWrangler;
  const tmpDir = mkdtempSync(join(tmpdir(), "stroke-corpus-manifest-"));
  try {
    const filePath = join(tmpDir, "manifest.json");
    const argv = [
      "vp",
      "exec",
      "wrangler",
      "r2",
      "object",
      "get",
      `${bucketName}/${pointer.manifestKey}`,
      "--remote",
      `--file=${filePath}`,
    ];
    const result = await retryWithBackoff(() => runner(argv), {
      sleep: opts.sleep,
      maxRetries: opts.maxRetries ?? DEFAULT_VERIFY_MAX_RETRIES,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to read manifest ${pointer.manifestKey} (exit ${result.exitCode}): ${result.stderr}`,
      );
    }
    const raw = readFileSync(filePath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Manifest at ${pointer.manifestKey} is not valid JSON`);
    }
    if (!isStrokeCorpusManifest(parsed)) {
      throw new Error(`Manifest at ${pointer.manifestKey} failed schema validation`);
    }
    if (parsed.corpusDigest !== pointer.corpusDigest) {
      throw new Error(
        `Manifest corpusDigest ${parsed.corpusDigest} does not match pointer corpusDigest ${pointer.corpusDigest}`,
      );
    }
    if (parsed.fileCount !== STROKE_CORPUS_EXPECTED_COUNT) {
      throw new Error(
        `Manifest fileCount ${parsed.fileCount} does not match expected ${STROKE_CORPUS_EXPECTED_COUNT}`,
      );
    }
    return parsed;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * `--verify-only=staging|production`: read the pointer, read its manifest,
 * authenticated re-GET + verify every object. No writes of any kind —
 * safe to run anytime, including against a live production bucket.
 * @param {string} bucketName
 * @param {{ runner?: Function, sleep?: (ms: number) => Promise<void>, maxConcurrent?: number, maxRetries?: number }} [opts]
 */
export async function verifyCorpusOnly(bucketName, opts = {}) {
  const runner = opts.runner ?? runWrangler;
  const pointer = await readCorpusPointer(bucketName, { runner });
  if (!pointer) {
    throw new Error(`No corpus pointer found at ${bucketName}/${STROKE_CORPUS_POINTER_KEY}`);
  }
  const manifest = await readCorpusManifest(bucketName, pointer, opts);
  const verification = await verifyAtomicCorpusUploads(manifest, bucketName, opts);
  return { pointer, manifest, verification };
}

/**
 * Lightweight deploy-time readiness check: authenticated GET of the
 * pointer + manifest ONLY — never any corpus object (zero R2 Class B
 * reads for the 6,063 stroke-json bodies). Used by
 * `scripts/lib/stroke-corpus-preflight.mjs` before every mutating
 * Wrangler call in `bun run deploy` / `deploy:staging` — running the full
 * 6,063-object `verifyCorpusOnly` on EVERY publish+deploy invocation would
 * cost ~53 minutes of Class B re-download+hash per run for a corpus that,
 * once uploaded, is immutable and already fully verified before its
 * pointer was ever promoted (see `runAtomicCorpusUpload`).
 *
 * Validates the same strict pointer/manifest schemas as the full
 * pipeline (via {@link readCorpusManifest}), plus:
 *   - pointer<->manifest `fileCount`/`totalBytes` agreement
 *   - manifest `totalBytes` against the sum of its own per-file `bytes`
 *     (catches a tampered/stale `totalBytes` field with zero extra reads)
 *   - independently RECOMPUTES `corpusDigest` from the manifest's own
 *     hex/sha256 pairs (same algorithm as {@link computeCorpusDigest}) to
 *     confirm the digest is self-consistent with the manifest content it
 *     claims to summarize — this schema has no separate stored
 *     ETag/checksum field, so `corpusDigest` recomputed from `files[]` IS
 *     the manifest's self-digest.
 *
 * NOT a substitute for full corpus integrity verification: it proves the
 * pointer+manifest are well-formed and mutually self-consistent, not that
 * every stroke-json body in R2 still matches its recorded sha256/bytes —
 * a corrupted or missing object would NOT be caught here. Full
 * byte-for-byte verification of every object remains exclusively:
 *   (a) `verifyAtomicCorpusUploads`, inside the upload path, BEFORE the
 *       pointer is promoted (see `runAtomicCorpusUpload`), and
 *   (b) explicit operator `--verify-only=<env>` (`verifyCorpusOnly`).
 *
 * Fails closed (throws) before any mutation on a missing/malformed/
 * mismatched pointer or manifest — never returns partial success.
 * @param {string} bucketName
 * @param {{ runner?: Function, sleep?: (ms: number) => Promise<void>, maxRetries?: number }} [opts]
 * @returns {Promise<{ pointer: import("../src/utils/stroke-corpus.ts").StrokeCorpusPointer, manifest: import("../src/utils/stroke-corpus.ts").StrokeCorpusManifest }>}
 */
export async function verifyCorpusReadiness(bucketName, opts = {}) {
  const runner = opts.runner ?? runWrangler;
  const pointer = await readCorpusPointer(bucketName, { runner });
  if (!pointer) {
    throw new Error(`No corpus pointer found at ${bucketName}/${STROKE_CORPUS_POINTER_KEY}`);
  }
  const manifest = await readCorpusManifest(bucketName, pointer, opts);

  if (pointer.fileCount !== manifest.fileCount) {
    throw new Error(
      `Pointer fileCount ${pointer.fileCount} does not match manifest fileCount ${manifest.fileCount}`,
    );
  }
  if (pointer.totalBytes !== manifest.totalBytes) {
    throw new Error(
      `Pointer totalBytes ${pointer.totalBytes} does not match manifest totalBytes ${manifest.totalBytes}`,
    );
  }
  const summedBytes = manifest.files.reduce((sum, f) => sum + f.bytes, 0);
  if (summedBytes !== manifest.totalBytes) {
    throw new Error(
      `Manifest totalBytes ${manifest.totalBytes} does not match sum of its own file bytes ${summedBytes}`,
    );
  }

  const recomputedDigest = computeCorpusDigest(
    manifest.files.map((f) => ({
      hex: f.path.replace(/^stroke-json\//, "").replace(/\.json$/i, ""),
      sha256: f.sha256,
    })),
  );
  if (recomputedDigest !== manifest.corpusDigest) {
    throw new Error(
      `Manifest content self-digest mismatch: recomputed ${recomputedDigest} from files[], ` +
        `but manifest.corpusDigest is ${manifest.corpusDigest}`,
    );
  }

  return { pointer, manifest };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   convert?: typeof fetchAndConvertMoeStroke,
 *   runner?: Function,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (...args: unknown[]) => void,
 * }} [deps]
 */
export async function runCli(argv, deps = {}) {
  const log = deps.log ?? console.log;
  const args = parseArgs(argv);

  if (args.help) {
    log(`Usage: node commands/sync-moe-stroke-corpus.mjs [options]
  --out <dir>  --dry-run  --upload=staging|production  --verify-only=staging|production
  --concurrency <n>  --zip-url <url>  --zip-path <path>  --chars-file <path>
  --checkpoint <path>  --config <path>
  (--limit, --allow-partial, --skip-verify are dry-run only)`);
    return { ok: true, mode: "help" };
  }

  // --verify-only: read pointer/manifest/all objects, retry, NO writes of
  // any kind. Short-circuits before any discovery/conversion/upload logic.
  if (args.verifyOnly) {
    const bucketName = resolveAssetsBucket(args.verifyOnly, args.config);
    log(`[verify-only] target=${args.verifyOnly} bucket=${bucketName}`);
    const result = await verifyCorpusOnly(bucketName, {
      runner: deps.runner,
      sleep: deps.sleep,
    });
    log(
      `[verify-only] ok — corpusDigest=${result.pointer.corpusDigest} ${result.verification.checkedKeys.length} keys match sha256`,
    );
    return {
      ok: true,
      mode: "verify-only",
      target: args.verifyOnly,
      bucketName,
      corpusDigest: result.pointer.corpusDigest,
      checkedKeys: result.verification.checkedKeys,
    };
  }

  // Enforce safe defaults for upload mode.  --limit, --allow-partial, and
  // --skip-verify are debug/dry-run-only flags; allowing them in upload mode
  // would let partial or unverified data land in R2 without detection.
  if (args.upload) {
    if (Number.isFinite(args.limit)) {
      throw new Error(
        "--limit is not allowed with --upload; the full 6,063-character corpus is required",
      );
    }
    if (args.allowPartial) {
      throw new Error(
        "--allow-partial is not allowed with --upload; all characters must convert successfully",
      );
    }
    if (args.skipVerify) {
      throw new Error(
        "--skip-verify is not allowed with --upload; post-upload byte verification is mandatory",
      );
    }
  }
  const outDir = args.out ?? DEFAULT_OUT;
  mkdirSync(outDir, { recursive: true });

  // 1. Discover corpus
  /** @type {CorpusEntry[]} */
  let corpus;
  if (args.charsFile) {
    log(`[discover] loading characters from ${args.charsFile}`);
    corpus = validateAndBuildCorpus(loadCharsFile(args.charsFile));
  } else {
    log(`[discover] loading official 6063png.zip …`);
    const zipBytes = await loadDiscoveryZip({
      zipUrl: args.zipUrl,
      zipPath: args.zipPath,
      fetchImpl: deps.fetchImpl,
    });
    corpus = discoverCorpusFromZipBytes(zipBytes);
  }
  log(`[discover] ${corpus.length} unique characters (expected ${EXPECTED_CORPUS_SIZE})`);

  // 2. Convert (with checkpoint resume)
  log(`[convert] writing to ${outDir}/stroke-json/ (concurrency=${args.concurrency ?? 4})`);
  const { results, gaps, checkpointPath } = await convertCorpus(corpus, outDir, {
    concurrency: args.concurrency,
    checkpointPath: args.checkpoint,
    convert: deps.convert,
    limit: args.limit,
    onProgress: (done, total, entry, char) => {
      if (done % 100 === 0 || done === total) {
        log(
          `[convert] ${done}/${total} last=${char}${entry ? ` strokes=${entry.strokeCount}` : " MISSING"}`,
        );
      }
    },
  });

  if (gaps.length > 0) {
    log(
      `[convert] ${gaps.length} characters had no stroke data on MOE site: ${gaps.slice(0, 20).join("")}${gaps.length > 20 ? "…" : ""}`,
    );
    if (!args.allowPartial) {
      throw new Error(
        `conversion gaps: ${gaps.length} characters missing stroke data (use --allow-partial to continue)`,
      );
    }
  }

  // 3. Manifest
  const { path: manifestPath, manifest } = writeManifest(results, outDir, {
    allowPartial: args.allowPartial || Number.isFinite(args.limit),
    expectedSize: Number.isFinite(args.limit) ? results.length : EXPECTED_CORPUS_SIZE,
  });
  log(`[manifest] wrote ${manifestPath} (${manifest.count} entries)`);

  // 4. Upload?
  const uploadTarget = args.upload;
  if (!uploadTarget) {
    log(`[dry-run] no --upload; local corpus ready at ${outDir}`);
    return { ok: true, mode: "dry-run", count: results.length, gaps, manifestPath, checkpointPath };
  }

  const bucketName = resolveAssetsBucket(uploadTarget, args.config);
  log(
    `[upload] target=${uploadTarget} bucket=${bucketName} objects=${results.length} (atomic digest-scoped)`,
  );
  const atomicResult = await runAtomicCorpusUpload(results, outDir, bucketName, uploadTarget, {
    runner: deps.runner,
    sleep: deps.sleep,
  });
  log(`[upload] complete — corpusDigest=${atomicResult.corpusDigest}`);
  log(
    `[verify] ok — ${atomicResult.verification.checkedKeys.length} keys match sha256 (incl. manifest)`,
  );
  log(`[pointer] promoted stroke-corpus/current.json → ${atomicResult.corpusDigest}`);

  return {
    ok: true,
    mode: "upload",
    target: uploadTarget,
    bucketName,
    count: results.length,
    gaps,
    manifestPath,
    corpusDigest: atomicResult.corpusDigest,
  };
}

/**
 * @typedef {Object} CliArgs
 * @property {boolean} dryRun
 * @property {boolean} skipVerify
 * @property {boolean} allowPartial
 * @property {boolean} help
 * @property {string} [out]
 * @property {string} [zipUrl]
 * @property {string} [zipPath]
 * @property {string} [charsFile]
 * @property {string} [checkpoint]
 * @property {string} [config]
 * @property {number} [limit]
 * @property {number} [concurrency]
 * @property {"staging"|"production"} [upload]
 * @property {"staging"|"production"} [verifyOnly]
 */

/**
 * @param {string[]} argv
 * @returns {CliArgs}
 */
export function parseArgs(argv) {
  /** @type {CliArgs} */
  const out = {
    dryRun: true,
    skipVerify: false,
    allowPartial: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--skip-verify") out.skipVerify = true;
    else if (a === "--allow-partial") out.allowPartial = true;
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--zip-url") out.zipUrl = argv[++i];
    else if (a === "--zip-path") out.zipPath = argv[++i];
    else if (a === "--chars-file") out.charsFile = argv[++i];
    else if (a === "--checkpoint") out.checkpoint = argv[++i];
    else if (a === "--config") out.config = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (a.startsWith("--upload=")) {
      out.upload = /** @type {"staging"|"production"} */ (a.slice("--upload=".length));
      out.dryRun = false;
    } else if (a === "--upload") {
      out.upload = /** @type {"staging"|"production"} */ (argv[++i]);
      out.dryRun = false;
    } else if (a.startsWith("--verify-only=")) {
      out.verifyOnly = /** @type {"staging"|"production"} */ (a.slice("--verify-only=".length));
      out.dryRun = false;
    } else if (a === "--verify-only") {
      out.verifyOnly = /** @type {"staging"|"production"} */ (argv[++i]);
      out.dryRun = false;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (out.upload && out.upload !== "staging" && out.upload !== "production") {
    throw new Error(`--upload must be staging or production, got ${String(out.upload)}`);
  }
  if (out.verifyOnly && out.verifyOnly !== "staging" && out.verifyOnly !== "production") {
    throw new Error(`--verify-only must be staging or production, got ${String(out.verifyOnly)}`);
  }
  if (out.upload && out.verifyOnly) {
    throw new Error("--upload and --verify-only are mutually exclusive");
  }
  if (out.concurrency != null) {
    const c = out.concurrency;
    if (!Number.isInteger(c) || c < 1 || c > 8) {
      throw new Error(`--concurrency must be an integer 1..8, got ${String(out.concurrency)}`);
    }
  }
  return out;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]);

if (isMain) {
  runCli(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
