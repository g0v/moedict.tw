/**
 * Atomic deployment state under `.wrangler/releases/` (base dir configurable
 * per call for testability — default matches the gitignored `.wrangler`
 * tree, never committed).
 *
 * Files:
 * - `current.json` — the currently-finalized deployment
 *   `{ workerName, versionId, tag, percentage, deployedAt }`
 * - `versions.json` — append-only history array of
 *   `{ versionId, tag, uploadedAt, status }`
 * - `staging-approval.json` — `{ gitSha, clientManifestDigest, approvedAt }`,
 *   written only after a staging deploy's final smoke passes; read by the
 *   production gate.
 *
 * Safety guarantees:
 * - All writes go through a temp-file-then-rename in the same directory.
 *   `rename` is atomic on POSIX same-filesystem, so `current.json` etc. are
 *   NEVER observed partially written — a crash mid-write leaves either the
 *   old complete content or the new complete content, never corruption. The
 *   temp file is removed on any write failure.
 * - Every read schema-validates; a corrupt or malformed file THROWS rather
 *   than being silently treated as "no state" (which could let the
 *   orchestrator proceed as if this were a fresh, ungated deploy). Only a
 *   genuinely absent file returns `null`.
 * - `saveVersionEntry` is fully synchronous (sync `readFileSync` +
 *   atomic write, no `await` anywhere in the call). Node's run-to-completion
 *   semantics mean two calls issued back-to-back — even without an `await`
 *   between them — can never interleave, so the read-modify-write append
 *   cannot lose an update within one process. This is why the module uses
 *   synchronous fs calls throughout, matching `release-manifest.mjs` /
 *   `generated-config.mjs` conventions, rather than a manual lock.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * @typedef {Object} FsAdapter
 * @property {(path: string) => boolean} existsSync
 * @property {(path: string, opts: { recursive: boolean }) => void} mkdirSync
 * @property {(path: string, encoding: string) => string} readFileSync
 * @property {(from: string, to: string) => void} renameSync
 * @property {(path: string, opts: { force: boolean }) => void} rmSync
 * @property {(path: string, data: string, encoding: string) => void} writeFileSync
 */

/**
 * @typedef {Object} CurrentDeploymentState
 * @property {string} workerName
 * @property {string} versionId
 * @property {string} tag
 * @property {number} percentage
 * @property {string} deployedAt
 */

/**
 * @typedef {Object} VersionHistoryEntry
 * @property {string} versionId
 * @property {string} tag
 * @property {string} uploadedAt
 * @property {string} status
 */

/**
 * @typedef {Object} StagingApprovalState
 * @property {string} gitSha
 * @property {string} clientManifestDigest
 * @property {string} approvedAt
 */

export const DEFAULT_BASE_DIR = ".wrangler/releases";

/** Controlled vocabulary for `VersionHistoryEntry.status`. */
export const VERSION_STATUS = Object.freeze({
  UPLOADED: "uploaded",
  CONFIRM_FAILED: "confirm-failed",
  SMOKE_FAILED: "smoke-failed",
  RESTORE_FAILED: "restore-failed",
  PROMOTED: "promoted",
  PROBE_FAILED: "probe-failed",
  ROLLED_BACK: "rolled-back",
  ROLLBACK_FAILED: "rollback-failed",
  FINALIZED: "finalized",
});
const VALID_STATUSES = new Set(Object.values(VERSION_STATUS));

/** @type {FsAdapter} */
const defaultFs = { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync };

/** @param {{ baseDir?: string }} [opts] */
function resolveBaseDir(opts) {
  return opts?.baseDir ?? DEFAULT_BASE_DIR;
}

/** @param {{ fs?: FsAdapter }} [opts] */
function resolveFs(opts) {
  return opts?.fs ?? defaultFs;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isIsoDateString(value) {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

/**
 * Write `data` as JSON to `filePath` atomically: write to a uniquely-named
 * temp file in the same directory, then rename over the target. Cleans up
 * the temp file on any failure.
 * @param {string} filePath
 * @param {unknown} data
 * @param {FsAdapter} fs
 */
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

/**
 * Read and JSON.parse a state file, returning `null` if it does not exist.
 * A present-but-corrupt file THROWS (fail closed — never silently "no state").
 * @param {string} filePath
 * @param {FsAdapter} fs
 * @param {string} label
 */
function readJsonOrNull(filePath, fs, label) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Corrupt ${label} (invalid JSON): ${filePath}`);
  }
}

/** @param {unknown} state */
function validateCurrentDeploymentState(state) {
  if (!state || typeof state !== "object") {
    throw new Error(`current.json: not an object: ${JSON.stringify(state)}`);
  }
  const s = /** @type {Record<string, unknown>} */ (state);
  if (!nonEmptyString(s.workerName))
    throw new Error("current.json: workerName must be a non-empty string");
  if (!nonEmptyString(s.versionId))
    throw new Error("current.json: versionId must be a non-empty string");
  if (!nonEmptyString(s.tag)) throw new Error("current.json: tag must be a non-empty string");
  if (
    !Number.isInteger(s.percentage) ||
    /** @type {number} */ (s.percentage) < 0 ||
    /** @type {number} */ (s.percentage) > 100
  ) {
    throw new Error("current.json: percentage must be an integer 0-100");
  }
  if (!isIsoDateString(/** @type {string} */ (s.deployedAt))) {
    throw new Error("current.json: deployedAt must be a valid ISO date string");
  }
  return /** @type {CurrentDeploymentState} */ (state);
}

/** @param {unknown} entry */
function validateVersionEntry(entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error(`version entry: not an object: ${JSON.stringify(entry)}`);
  }
  const e = /** @type {Record<string, unknown>} */ (entry);
  if (!nonEmptyString(e.versionId))
    throw new Error("version entry: versionId must be a non-empty string");
  if (!nonEmptyString(e.tag)) throw new Error("version entry: tag must be a non-empty string");
  if (!isIsoDateString(/** @type {string} */ (e.uploadedAt))) {
    throw new Error("version entry: uploadedAt must be a valid ISO date string");
  }
  if (!VALID_STATUSES.has(/** @type {string} */ (e.status))) {
    throw new Error(`version entry: status must be one of ${[...VALID_STATUSES].join(", ")}`);
  }
  return /** @type {VersionHistoryEntry} */ (entry);
}

/** @param {unknown} state */
function validateStagingApprovalState(state) {
  if (!state || typeof state !== "object") {
    throw new Error(`staging-approval.json: not an object: ${JSON.stringify(state)}`);
  }
  const s = /** @type {Record<string, unknown>} */ (state);
  if (!nonEmptyString(s.gitSha))
    throw new Error("staging-approval.json: gitSha must be a non-empty string");
  if (!nonEmptyString(s.clientManifestDigest)) {
    throw new Error("staging-approval.json: clientManifestDigest must be a non-empty string");
  }
  if (!isIsoDateString(/** @type {string} */ (s.approvedAt))) {
    throw new Error("staging-approval.json: approvedAt must be a valid ISO date string");
  }
  return /** @type {StagingApprovalState} */ (state);
}

/**
 * @param {CurrentDeploymentState} state
 * @param {{ baseDir?: string; fs?: FsAdapter }} [opts]
 */
export function saveCurrentDeployment(state, opts = {}) {
  validateCurrentDeploymentState(state);
  const fs = resolveFs(opts);
  atomicWriteJson(join(resolveBaseDir(opts), "current.json"), state, fs);
}

/**
 * @param {{ baseDir?: string; fs?: FsAdapter }} [opts]
 * @returns {CurrentDeploymentState | null}
 */
export function readCurrentDeployment(opts = {}) {
  const fs = resolveFs(opts);
  const filePath = join(resolveBaseDir(opts), "current.json");
  const parsed = readJsonOrNull(filePath, fs, "current deployment state");
  if (parsed === null) return null;
  return validateCurrentDeploymentState(parsed);
}

/**
 * Append a version history entry. Fully synchronous — see module header for
 * why this guarantees no lost update within one process.
 * @param {VersionHistoryEntry} entry
 * @param {{ baseDir?: string; fs?: FsAdapter }} [opts]
 * @returns {VersionHistoryEntry[]} the full history after appending
 */
export function saveVersionEntry(entry, opts = {}) {
  validateVersionEntry(entry);
  const fs = resolveFs(opts);
  const filePath = join(resolveBaseDir(opts), "versions.json");
  const existing = readJsonOrNull(filePath, fs, "versions history");
  const history = existing === null ? [] : existing;
  if (!Array.isArray(history)) {
    throw new Error(`Corrupt versions history (expected array): ${filePath}`);
  }
  const next = [...history, entry];
  atomicWriteJson(filePath, next, fs);
  return next;
}

/**
 * Read the full version history (empty array if the file does not exist).
 * A present-but-corrupt file THROWS (fails closed).
 * @param {{ baseDir?: string; fs?: FsAdapter }} [opts]
 * @returns {VersionHistoryEntry[]}
 */
export function readVersionHistory(opts = {}) {
  const fs = resolveFs(opts);
  const filePath = join(resolveBaseDir(opts), "versions.json");
  const parsed = readJsonOrNull(filePath, fs, "versions history");
  if (parsed === null) return [];
  if (!Array.isArray(parsed)) {
    throw new Error(`Corrupt versions history (expected array): ${filePath}`);
  }
  return parsed.map((entry) => validateVersionEntry(entry));
}

/**
 * @param {StagingApprovalState} state
 * @param {{ baseDir?: string; fs?: FsAdapter }} [opts]
 */
export function saveStagingApproval(state, opts = {}) {
  validateStagingApprovalState(state);
  const fs = resolveFs(opts);
  atomicWriteJson(join(resolveBaseDir(opts), "staging-approval.json"), state, fs);
}

/**
 * @param {{ baseDir?: string; fs?: FsAdapter }} [opts]
 * @returns {StagingApprovalState | null}
 */
export function readStagingApproval(opts = {}) {
  const fs = resolveFs(opts);
  const filePath = join(resolveBaseDir(opts), "staging-approval.json");
  const parsed = readJsonOrNull(filePath, fs, "staging approval state");
  if (parsed === null) return null;
  return validateStagingApprovalState(parsed);
}

/**
 * Gate check: production may proceed only if a staging approval exists for
 * the exact same git SHA AND the same client manifest digest.
 * @param {string} prodGitSha
 * @param {string} prodDigest
 * @param {StagingApprovalState | null} stagingState
 * @returns {boolean}
 */
export function checkStagingApprovalGate(prodGitSha, prodDigest, stagingState) {
  if (!nonEmptyString(prodGitSha))
    throw new Error("checkStagingApprovalGate: prodGitSha is required");
  if (!nonEmptyString(prodDigest))
    throw new Error("checkStagingApprovalGate: prodDigest is required");
  if (!stagingState) return false;
  return stagingState.gitSha === prodGitSha && stagingState.clientManifestDigest === prodDigest;
}
