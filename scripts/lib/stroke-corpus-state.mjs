/**
 * Local rollback-state tracking for the atomic stroke-corpus pointer
 * (`stroke-corpus/current.json` in R2 — see src/utils/stroke-corpus.ts).
 *
 * Every time `promoteCorpusPointer` in commands/sync-moe-stroke-corpus.mjs
 * successfully writes a NEW pointer to R2, it first reads the OLD pointer
 * (if any) and records it here so an operator can manually roll back to a
 * known-good corpus digest without re-deriving it from R2 object history.
 * This module never talks to R2 itself — it is pure local bookkeeping,
 * mirroring scripts/lib/deployment-state.mjs's atomic
 * temp-file-then-rename write pattern (same safety guarantees: a crash
 * mid-write leaves either the old or new complete content, never
 * corruption; a present-but-corrupt file THROWS rather than being treated
 * as absent).
 *
 * State layout (namespaced per environment so staging/production never
 * clobber each other): `<baseDir>/<env>/pointer-history.json` — an
 * append-only array of `{ corpusDigest, manifestKey, fileCount,
 * totalBytes, promotedAt }`, newest last. The previous entry (before the
 * latest) is the rollback target.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const DEFAULT_STROKE_CORPUS_STATE_DIR = ".wrangler/stroke-corpus";

/**
 * P2 fix: pointer-history.json was previously unbounded/append-forever —
 * every corpus promotion ever made for an environment stayed in the file
 * permanently. Bounded to a boring constant (matching the existing
 * per-isolate negative-cache precedent, `STROKE_NEGATIVE_CACHE_MAX_ENTRIES`
 * in src/api/handleStrokeAPI.ts) so the file cannot grow unboundedly over
 * years of operator re-promotions. Only the newest `MAX_POINTER_HISTORY`
 * entries are retained (oldest trimmed first) — `readPriorCorpusPointer`'s
 * "one before the latest" contract is unaffected as long as at least 2
 * promotions have happened, which the bound trivially preserves.
 */
export const MAX_POINTER_HISTORY = 20;

/** @type {{ existsSync: typeof existsSync; mkdirSync: typeof mkdirSync; readFileSync: typeof readFileSync; renameSync: typeof renameSync; rmSync: typeof rmSync; writeFileSync: typeof writeFileSync }} */
const defaultFs = { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync };

function resolveFs(opts) {
  return opts?.fs ?? defaultFs;
}

function resolveBaseDir(opts) {
  return opts?.baseDir ?? DEFAULT_STROKE_CORPUS_STATE_DIR;
}

function historyPath(env, opts) {
  if (env !== "staging" && env !== "production") {
    throw new Error(`Unsupported stroke-corpus env: ${String(env)}`);
  }
  return join(resolveBaseDir(opts), env, "pointer-history.json");
}

/** Atomic write: temp file in the same dir, then rename. */
function atomicWriteJson(filePath, data, fs) {
  const dir = dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.${basename(filePath)}.tmp-${randomBytes(6).toString("hex")}`);
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup only
    }
    throw err;
  }
}

function validateHistoryEntry(entry) {
  if (!entry || typeof entry !== "object")
    throw new Error("pointer-history: entry is not an object");
  const e = /** @type {Record<string, unknown>} */ (entry);
  if (typeof e.corpusDigest !== "string" || !/^[a-f0-9]{64}$/i.test(e.corpusDigest)) {
    throw new Error("pointer-history: invalid corpusDigest");
  }
  if (typeof e.manifestKey !== "string" || !e.manifestKey) {
    throw new Error("pointer-history: invalid manifestKey");
  }
  if (!Number.isInteger(e.fileCount) || e.fileCount < 0) {
    throw new Error("pointer-history: invalid fileCount");
  }
  if (!Number.isInteger(e.totalBytes) || e.totalBytes < 0) {
    throw new Error("pointer-history: invalid totalBytes");
  }
  if (typeof e.promotedAt !== "string" || Number.isNaN(Date.parse(e.promotedAt))) {
    throw new Error("pointer-history: invalid promotedAt");
  }
  return entry;
}

/**
 * Read the full pointer promotion history for an environment (oldest
 * first). Empty array when no state exists yet. Throws on corrupt state.
 * @param {"staging"|"production"} env
 * @param {{ baseDir?: string, fs?: object }} [opts]
 * @returns {Array<{ corpusDigest: string, manifestKey: string, fileCount: number, totalBytes: number, promotedAt: string }>}
 */
export function readCorpusPointerHistory(env, opts = {}) {
  const fs = resolveFs(opts);
  const filePath = historyPath(env, opts);
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Corrupt stroke-corpus pointer history (invalid JSON): ${filePath}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Corrupt stroke-corpus pointer history (not an array): ${filePath}`);
  }
  return parsed.map(validateHistoryEntry);
}

/**
 * Append a newly-promoted pointer to the history (fully synchronous
 * read-modify-write, matching deployment-state.mjs's saveVersionEntry —
 * safe against interleaving because Node has no await between the read
 * and the write here).
 * @param {"staging"|"production"} env
 * @param {{ corpusDigest: string, manifestKey: string, fileCount: number, totalBytes: number, promotedAt: string }} entry
 * @param {{ baseDir?: string, fs?: object }} [opts]
 */
export function appendCorpusPointerHistory(env, entry, opts = {}) {
  validateHistoryEntry(entry);
  const fs = resolveFs(opts);
  const filePath = historyPath(env, opts);
  const existing = readCorpusPointerHistory(env, opts);
  // Bound to the newest MAX_POINTER_HISTORY entries (oldest trimmed
  // first) — order (oldest-first, newest-last) is preserved.
  const bounded = [...existing, entry].slice(-MAX_POINTER_HISTORY);
  atomicWriteJson(filePath, bounded, fs);
}

/**
 * The pointer that was live immediately BEFORE the latest promotion —
 * i.e. the rollback target. `null` when fewer than two promotions have
 * been recorded (nothing to roll back to).
 * @param {"staging"|"production"} env
 * @param {{ baseDir?: string, fs?: object }} [opts]
 */
export function readPriorCorpusPointer(env, opts = {}) {
  const history = readCorpusPointerHistory(env, opts);
  if (history.length < 2) return null;
  return history[history.length - 2];
}
