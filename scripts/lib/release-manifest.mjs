/**
 * Deterministic release manifest generation.
 *
 * Enumerates dist/client/** (NOT Vite manifest), computes SHA-256 of raw
 * bytes, builds a sorted {path, sha256, size} array, and derives a
 * deterministic release ID from git short SHA + first 12 hex chars of the
 * SHA-256 of the canonical manifest JSON.
 *
 * Key design requirements:
 * - Manifest hashes raw bytes (Buffer, not text).
 * - Deterministic digest sorts entries internally — caller order does not
 *   matter. Canonical JSON keys (sorted recursively).
 * - release-manifest.json is excluded from enumeration even if present
 *   under the input directory.
 * - Release ID = validated git short SHA + first 12 of full SHA-256 digest.
 * - createdAt may vary but MUST NOT influence ID.
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * @typedef {Object} ClientManifestEntry
 * @property {string} path
 * @property {string} sha256
 * @property {number} size
 */

/**
 * @typedef {Object} ReleaseManifest
 * @property {string} id
 * @property {string} gitSha
 * @property {string} clientManifestDigest
 * @property {string} createdAt
 * @property {ClientManifestEntry[]} files
 */

/**
 * @typedef {Object} FsAdapter
 * @property {(path: string) => Buffer} readFileSync
 * @property {(path: string, opts: { withFileTypes: true }) => Array<{ name: string; isDirectory(): boolean }>} readdirSync
 */

/**
 * @typedef {Object} GitAdapter
 * @property {() => string} getGitShortSha
 * @property {(sha: string) => void} validateGitShortSha
 */

const RELEASE_MANIFEST_FILENAME = "release-manifest.json";

/**
 * Validate a git short SHA: 7–40 hex chars.
 * @param {string} sha
 */
export function validateGitShortSha(sha) {
  if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new Error(`Invalid git short SHA: ${sha}`);
  }
}

/**
 * Recursively enumerate all files under a directory, returning absolute paths.
 * @param {string} dir
 * @param {FsAdapter} fs
 * @returns {string[]}
 */
function enumerateFiles(dir, fs) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...enumerateFiles(full, fs));
    } else {
      results.push(full);
    }
  }
  return results;
}

/**
 * Build client manifest by enumerating dist/client/** — NOT relying on Vite
 * manifest. Returns sorted {path, sha256, size} records.
 *
 * release-manifest.json is excluded even if present under the input directory.
 *
 * @param {string} distClientDir
 * @param {{ fs?: FsAdapter }} [opts]
 * @returns {ClientManifestEntry[]}
 */
export function buildClientManifest(distClientDir, opts = {}) {
  const fs = opts.fs ?? defaultFs;
  const files = enumerateFiles(distClientDir, fs)
    .map((abs) => relative(distClientDir, abs).split(sep).join("/"))
    .filter((p) => p !== RELEASE_MANIFEST_FILENAME)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return files.map((path) => {
    const content = fs.readFileSync(join(distClientDir, path));
    return {
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: content.byteLength,
    };
  });
}

/**
 * Deterministic JSON stringification: no spaces, sorted keys recursively.
 * Arrays preserve element order (entries are pre-sorted by path).
 * @param {unknown} obj
 * @returns {string}
 */
export function deterministicStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(deterministicStringify).join(",") + "]";
  }
  const objRec = /** @type {Record<string, unknown>} */ (obj);
  const keys = Object.keys(objRec).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + deterministicStringify(objRec[k])).join(",") +
    "}"
  );
}

/**
 * Compute SHA-256 of sorted manifest JSON, first 12 hex chars.
 *
 * Entries are sorted internally by path — caller order does not affect the
 * digest. Object keys are canonicalized (sorted recursively).
 * @param {ClientManifestEntry[]} entries
 * @returns {string}
 */
export function computeClientManifestDigest(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const stable = deterministicStringify(sorted);
  return createHash("sha256").update(stable).digest("hex").slice(0, 12);
}

/**
 * Get git short SHA via `git rev-parse --short HEAD`.
 * @returns {string}
 */
export function getGitShortSha() {
  return execSync("git rev-parse --short HEAD").toString().trim();
}

/**
 * Compute release ID: <git-short-sha>-<first12-of-manifest-digest>.
 * @param {string} gitShortSha
 * @param {string} clientManifestDigest
 * @returns {string}
 */
export function computeReleaseId(gitShortSha, clientManifestDigest) {
  validateGitShortSha(gitShortSha);
  if (!clientManifestDigest || !/^[0-9a-f]{12}$/.test(clientManifestDigest)) {
    throw new Error(`Invalid client manifest digest: ${clientManifestDigest}`);
  }
  return `${gitShortSha}-${clientManifestDigest}`;
}

/**
 * Build the full release manifest object.
 *
 * The release-manifest.json file itself is NOT included in the manifest
 * enumeration or digest computation. createdAt is included for human
 * inspection but does NOT influence the ID.
 * @param {string} distClientDir
 * @param {{ fs?: FsAdapter; git?: GitAdapter }} [opts]
 * @returns {ReleaseManifest}
 */
export function buildReleaseManifest(distClientDir, opts = {}) {
  const fs = opts.fs ?? defaultFs;
  const git = opts.git ?? defaultGit;

  const files = buildClientManifest(distClientDir, { fs });
  const clientManifestDigest = computeClientManifestDigest(files);
  const gitSha = git.getGitShortSha();
  git.validateGitShortSha(gitSha);
  const id = computeReleaseId(gitSha, clientManifestDigest);

  return {
    id,
    gitSha,
    clientManifestDigest,
    createdAt: new Date().toISOString(),
    files,
  };
}

// Default adapters using real Node.js fs and git
const defaultFs = {
  readFileSync: (p) => readFileSync(p),
  readdirSync: (p, opts) =>
    /** @type {Array<{ name: string; isDirectory(): boolean }>} */ (readdirSync(p, opts)),
};

const defaultGit = {
  getGitShortSha,
  validateGitShortSha,
};
