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
import { uploadWithConcurrency, retryWithBackoff, runWrangler } from "../scripts/lib/r2-upload.mjs";
import { parseGeneratedConfig, getAssetsBucketName } from "../scripts/lib/generated-config.mjs";

export const EXPECTED_CORPUS_SIZE = 6063;
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
  const done = loadCheckpoint(checkpointPath);
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
 * @param {string} path
 * @returns {Map<string, ManifestEntry>}
 */
export function loadCheckpoint(path) {
  /** @type {Map<string, ManifestEntry>} */
  const map = new Map();
  if (!existsSync(path)) return map;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.status === "ok" && rec.hex && rec.sha256) {
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
    } catch {
      // skip corrupt lines
    }
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
 * @param {ManifestEntry[]} entries
 * @param {string} bucketName
 * @param {{ runner?: Function, sleep?: (ms: number) => Promise<void> }} [opts]
 */
export async function verifyCorpusUploads(entries, bucketName, opts = {}) {
  const runner = opts.runner ?? runWrangler;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const checked = [];
  for (const entry of entries) {
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
            if (/not found|NoSuchKey|404/i.test(stderr)) {
              throw new Error(`Missing object after upload: ${entry.r2Key}`);
            }
            // surface 429 as retryable via message patterns recognised by is429Error
            const err = new Error(
              `Download failed: ${entry.r2Key} (exit ${result.exitCode}): ${stderr}`,
            );
            /** @type {any} */ (err).stderr = stderr;
            throw err;
          }
        },
        { sleep },
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
  --out <dir>  --dry-run  --upload=staging|production  --limit <n>
  --concurrency <n>  --zip-url <url>  --zip-path <path>  --chars-file <path>
  --checkpoint <path>  --skip-verify  --allow-partial  --config <path>`);
    return { ok: true, mode: "help" };
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
  log(`[upload] target=${uploadTarget} bucket=${bucketName} objects=${results.length}`);
  await uploadCorpus(results, outDir, bucketName, {
    runner: deps.runner,
    sleep: deps.sleep,
  });
  log(`[upload] complete`);

  // 5. Verify
  if (!args.skipVerify) {
    log(`[verify] re-downloading and hashing ${results.length} objects …`);
    const verification = await verifyCorpusUploads(results, bucketName, {
      runner: deps.runner,
      sleep: deps.sleep,
    });
    log(`[verify] ok — ${verification.checkedKeys.length} keys match sha256`);
  } else {
    log(`[verify] skipped (--skip-verify)`);
  }

  return {
    ok: true,
    mode: "upload",
    target: uploadTarget,
    bucketName,
    count: results.length,
    gaps,
    manifestPath,
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
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (out.upload && out.upload !== "staging" && out.upload !== "production") {
    throw new Error(`--upload must be staging or production, got ${String(out.upload)}`);
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
