/**
 * Wrangler Versions API wrapper — argv-based, no shell, centralized runner.
 *
 * Wraps `wrangler versions upload/deploy/list` and `wrangler deployments
 * list`. Every real command goes through the shared `runWrangler` imported
 * from r2-upload.mjs — no duplicate subprocess runner anywhere in this file.
 *
 * Ground-truth CLI behavior (verified against installed wrangler 4.110.0 via
 * `--help` on each subcommand, plus a live read-only `--json` call against
 * this project's account):
 *
 * - `versions upload` has NO --json flag — passing it is a hard argv-parse
 *   failure (`Unknown argument: json`). On success it prints plain text
 *   containing a `Worker Version ID: <uuid>` line; we parse that line and
 *   never attempt to parse its stdout as JSON.
 * - `versions list --json` / `deployments list --json` DO support --json.
 *   Version entries are `{ id, number, metadata: {...}, annotations?: {
 *   "workers/tag"?: string, "workers/message"?: string, ... } }` — the tag
 *   passed via `--tag` at upload time surfaces as
 *   `annotations["workers/tag"]`. There is NO top-level `tag` field.
 * - `deployments list --json` entries are `{ id, source, strategy,
 *   annotations?, versions: [{ version_id, percentage }, ...], created_on }`.
 *   The array is not guaranteed sorted the way callers expect; we sort by
 *   `created_on` ourselves and take the most recent as "current".
 * - `versions deploy` accepts ONLY positional `<uuid>@<percentage>` specs
 *   here. `--version-tag`/`--percentage` exist on the real CLI but are
 *   deliberately never used — tag-resolution ambiguity is avoided by always
 *   deploying exact UUIDs we already validated ourselves.
 */

import { runWrangler } from "./r2-upload.mjs";
import { validateReleaseTag } from "../../src/utils/release-keys.ts";

/**
 * @typedef {import("./r2-upload.mjs").RunnerResult} RunnerResult
 * @typedef {import("./r2-upload.mjs").Runner} Runner
 */

/**
 * @typedef {Object} VersionSpec
 * @property {string} uuid
 * @property {number} percentage
 */

/**
 * @typedef {Object} DeploymentVersionEntry
 * @property {string} version_id
 * @property {number} percentage
 */

/**
 * @typedef {Object} Deployment
 * @property {string} id
 * @property {DeploymentVersionEntry[]} versions
 * @property {string} created_on
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

/** @param {string} name */
export function validateWorkerName(name) {
  if (typeof name !== "string" || !WORKER_NAME_RE.test(name)) {
    throw new Error(`Invalid worker name: ${JSON.stringify(name)}`);
  }
}

/** @param {string} configPath */
export function validateConfigPath(configPath) {
  if (typeof configPath !== "string" || configPath.length === 0) {
    throw new Error(`Invalid config path: ${JSON.stringify(configPath)}`);
  }
}

/** @param {string} uuid */
export function validateVersionUuid(uuid) {
  if (typeof uuid !== "string" || !UUID_RE.test(uuid)) {
    throw new Error(`Invalid version UUID: ${JSON.stringify(uuid)}`);
  }
}

/** @param {number} percentage */
export function validatePercentage(percentage) {
  if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) {
    throw new Error(`Invalid percentage (must be an integer 0-100): ${JSON.stringify(percentage)}`);
  }
}

/**
 * Validate a full set of `<uuid>@<percentage>` specs: each entry
 * individually valid, AND percentages summing to exactly 100.
 * @param {VersionSpec[]} specs
 */
export function validateSpecs(specs) {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error("deployVersionSplit requires at least one {uuid, percentage} spec");
  }
  let sum = 0;
  for (const spec of specs) {
    if (!spec || typeof spec !== "object") {
      throw new Error(`Invalid version spec: ${JSON.stringify(spec)}`);
    }
    validateVersionUuid(spec.uuid);
    validatePercentage(spec.percentage);
    sum += spec.percentage;
  }
  if (sum !== 100) {
    throw new Error(`Version spec percentages must sum to 100, got ${sum}`);
  }
}

// Detects Cloudflare rejecting the version_metadata binding itself (account
// or Worker doesn't support it yet) vs. an ordinary upload failure. This is
// a bootstrap experiment per the design spec — it must abort with a clear,
// distinguishable message rather than a generic upload error.
const VERSION_METADATA_REJECTION_RE = /version[_ ]metadata/i;
const REJECTION_REASON_RE =
  /(not supported|not enabled|not available|unknown binding|invalid binding|unsupported)/i;

/** @param {string} stderr */
function isVersionMetadataRejection(stderr) {
  return (
    typeof stderr === "string" &&
    VERSION_METADATA_REJECTION_RE.test(stderr) &&
    REJECTION_REASON_RE.test(stderr)
  );
}

const WORKER_VERSION_ID_RE = /Worker Version ID:\s*(\S+)/;

/**
 * Upload a new Worker version tagged with the release ID. Does not activate
 * any traffic. Parses the real plain-text `Worker Version ID: <uuid>` line
 * — `versions upload` has no --json flag on this wrangler version.
 * @param {string} configPath
 * @param {string} tag
 * @param {{ runner?: Runner }} [opts]
 * @returns {Promise<string>} the new version's Cloudflare UUID
 */
export async function uploadVersion(configPath, tag, opts = {}) {
  validateConfigPath(configPath);
  validateReleaseTag(tag);
  const runner = opts.runner ?? runWrangler;

  const argv = [
    "vp",
    "exec",
    "wrangler",
    "versions",
    "upload",
    "--config",
    configPath,
    "--tag",
    tag,
  ];
  const result = await runner(argv);
  if (result.exitCode !== 0) {
    if (isVersionMetadataRejection(result.stderr)) {
      throw new Error(
        `Cloudflare rejected the version_metadata binding for this Worker/account. This is a ` +
          `bootstrap experiment that must degrade gracefully when unsupported — aborting instead ` +
          `of deploying without version headers. Raw error: ${result.stderr}`,
      );
    }
    throw new Error(`versions upload failed (exit ${result.exitCode}): ${result.stderr}`);
  }

  const match = WORKER_VERSION_ID_RE.exec(result.stdout);
  if (!match) {
    throw new Error(
      `versions upload succeeded but no "Worker Version ID:" line found in output: ${result.stdout}`,
    );
  }
  validateVersionUuid(match[1]);
  return match[1];
}

/**
 * Deploy a traffic split via positional `<uuid>@<percentage>` specs. Never
 * emits `--version-tag`/`--percentage`.
 * @param {string} configPath
 * @param {VersionSpec[]} specs
 * @param {{ runner?: Runner }} [opts]
 * @returns {Promise<RunnerResult>}
 */
export async function deployVersionSplit(configPath, specs, opts = {}) {
  validateConfigPath(configPath);
  validateSpecs(specs);
  const runner = opts.runner ?? runWrangler;

  const argv = [
    "vp",
    "exec",
    "wrangler",
    "versions",
    "deploy",
    "--config",
    configPath,
    ...specs.map((s) => `${s.uuid}@${s.percentage}%`),
    "-y",
  ];
  const result = await runner(argv);
  if (result.exitCode !== 0) {
    throw new Error(`versions deploy failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  return result;
}

/**
 * Roll back to the old version at 100%, new version at 0%.
 * @param {string} configPath
 * @param {string} oldUuid
 * @param {string} newUuid
 * @param {{ runner?: Runner }} [opts]
 */
export async function rollbackToVersion(configPath, oldUuid, newUuid, opts = {}) {
  return deployVersionSplit(
    configPath,
    [
      { uuid: oldUuid, percentage: 100 },
      { uuid: newUuid, percentage: 0 },
    ],
    opts,
  );
}

/**
 * List recent Worker versions via `wrangler versions list --json`.
 * @param {string} configPath
 * @param {string} workerName
 * @param {{ runner?: Runner }} [opts]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function listVersions(configPath, workerName, opts = {}) {
  validateConfigPath(configPath);
  validateWorkerName(workerName);
  const runner = opts.runner ?? runWrangler;
  const argv = [
    "vp",
    "exec",
    "wrangler",
    "versions",
    "list",
    "--config",
    configPath,
    "--name",
    workerName,
    "--json",
  ];
  const result = await runner(argv);
  if (result.exitCode !== 0) {
    throw new Error(`versions list failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`versions list returned malformed JSON: ${result.stdout}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`versions list JSON: expected an array, got ${typeof parsed}`);
  }
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      throw new Error(`versions list JSON: malformed entry ${JSON.stringify(entry)}`);
    }
  }
  return parsed;
}

/**
 * Resolve the version UUID whose `annotations["workers/tag"]` equals `tag`.
 * Used to independently confirm the UUID parsed from `versions upload`'s
 * text output against the authoritative `--json` listing.
 * @param {Array<Record<string, unknown>>} versions
 * @param {string} tag
 * @returns {string}
 */
export function findVersionByTag(versions, tag) {
  if (!Array.isArray(versions)) {
    throw new Error("findVersionByTag: versions must be an array");
  }
  const matches = versions.filter((v) => {
    const annotations = /** @type {Record<string, unknown> | undefined} */ (v?.annotations);
    return annotations?.["workers/tag"] === tag;
  });
  if (matches.length === 0) {
    throw new Error(`No version found with tag ${tag}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous: ${matches.length} versions found with tag ${tag}`);
  }
  const id = /** @type {{ id: unknown }} */ (matches[0]).id;
  validateVersionUuid(/** @type {string} */ (id));
  return /** @type {string} */ (id);
}

/**
 * Get the current (most recent by `created_on`) deployment via
 * `wrangler deployments list --json`.
 * @param {string} configPath
 * @param {string} workerName
 * @param {{ runner?: Runner }} [opts]
 * @returns {Promise<Deployment>}
 */
export async function getCurrentDeployment(configPath, workerName, opts = {}) {
  validateConfigPath(configPath);
  validateWorkerName(workerName);
  const runner = opts.runner ?? runWrangler;
  const argv = [
    "vp",
    "exec",
    "wrangler",
    "deployments",
    "list",
    "--config",
    configPath,
    "--name",
    workerName,
    "--json",
  ];
  const result = await runner(argv);
  if (result.exitCode !== 0) {
    throw new Error(`deployments list failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`deployments list returned malformed JSON: ${result.stdout}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `deployments list JSON: expected a non-empty array, got ${JSON.stringify(parsed)}`,
    );
  }
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || typeof entry.created_on !== "string") {
      throw new Error(`deployments list JSON: malformed entry ${JSON.stringify(entry)}`);
    }
  }
  const sorted = [...parsed].sort((a, b) =>
    String(b.created_on).localeCompare(String(a.created_on)),
  );
  return /** @type {Deployment} */ (sorted[0]);
}

/**
 * Require the current deployment to be a single safe 100% version.
 *
 * Design decision: entries at exactly 0% are TOLERATED and IGNORED as
 * residue from an interrupted two-phase run (the orchestrator's own smoke-
 * failure and finalize steps explicitly collapse back to a single-entry
 * deployment on success, so residue is transient, not a steady state we
 * need to actively clean here). Any other state — more than one positive
 * entry, a single entry with 1-99% (partial split), zero positive entries,
 * or malformed shape — aborts as unsafe to deploy from.
 * @param {Deployment} deployment
 * @returns {string} the current 100% version's UUID
 */
export function requireSingleVersion100(deployment) {
  const versions = deployment?.versions;
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error("Cannot safely deploy: current deployment has no versions");
  }
  const positive = [];
  for (const v of versions) {
    if (!v || typeof v.version_id !== "string" || !Number.isInteger(v.percentage)) {
      throw new Error(`Cannot safely deploy: malformed version entry ${JSON.stringify(v)}`);
    }
    if (v.percentage < 0 || v.percentage > 100) {
      throw new Error(
        `Cannot safely deploy: version entry percentage out of range ${JSON.stringify(v)}`,
      );
    }
    if (v.percentage > 0) positive.push(v);
  }
  if (positive.length !== 1 || positive[0].percentage !== 100) {
    throw new Error(
      `Cannot safely deploy from split state: expected exactly one version at 100%, got ${JSON.stringify(versions)}`,
    );
  }
  validateVersionUuid(positive[0].version_id);
  return positive[0].version_id;
}
