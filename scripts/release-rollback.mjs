/**
 * Emergency single-target rollback CLI (Task 4).
 *
 * Usage: node scripts/release-rollback.mjs <target-version-uuid>
 *   (CLOUDFLARE_ENV=staging|production, default production)
 *
 * Unlike `release-deploy.mjs` (which uploads and gradually promotes a NEW
 * version), this script restores a version that ALREADY EXISTS on Cloudflare
 * — typically the version `release-deploy.mjs` just promoted, when a defect
 * surfaces after the fact. It deliberately does NOT read `dist/client` or
 * the release manifest: an emergency rollback must work even when the
 * current build is broken, so it depends only on the generated Wrangler
 * config (worker name / env identity) and Cloudflare's own versions API.
 *
 * Protocol:
 *   1. Require an explicit target UUID argument (no default, no "latest").
 *   2. Parse/validate the generated config for `env`; resolve worker name.
 *   3. Read the current deployment; require it to be a single safe 100%
 *      version (refuses an already-split deployment).
 *   4. Refuse if target === current (nothing to roll back).
 *   5. Resolve the target's `annotations["workers/tag"]` from `versions
 *      list` — refuses an unknown UUID or a UUID with no tag.
 *   6. Deploy target@100 / current@0 (positional specs, both remain live).
 *   7. Bounded final smoke (no version-override header — target is now
 *      actually serving) on fixed, non-hashed core routes only: `/`,
 *      `/api/config`, `/api/%E8%90%8C.json`. Never derived from a build
 *      manifest — the whole point of this script is to work without one.
 *   8. On smoke failure: restore current@100/target@0 and throw, reporting
 *      BOTH the smoke error and the restore error if restore also fails.
 *   9. On success: finalize target@100 alone and persist env-namespaced
 *      current/history state, reusing the exact same state module and
 *      layout as `release-deploy.mjs` (`<stateBaseDir>/<env>/`).
 *
 * Every real Wrangler call goes through the shared `runWrangler` (imported
 * transitively via wrangler-versions.mjs) — no duplicate subprocess runner,
 * no shell string interpolation, only positional UUID@percentage specs.
 *
 * `runReleaseRollback` is the fully dependency-injected, unit-testable
 * core. `main()` supplies real adapters and only runs when this file is
 * the CLI entrypoint — import-safe like the other release-*.mjs scripts.
 */

import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  parseGeneratedConfig,
  getAssetsBucketName,
  getWorkerName,
} from "./lib/generated-config.mjs";
import { runWrangler } from "./lib/r2-upload.mjs";
import {
  deployVersionSplit,
  rollbackToVersion,
  listVersions,
  findTagByVersionId,
  getCurrentDeployment,
  requireSingleVersion100,
  validateVersionUuid,
} from "./lib/wrangler-versions.mjs";
import { finalSmoke } from "./lib/smoke-probe.mjs";
import { resolveBaseUrl } from "./release-deploy.mjs";
import {
  saveCurrentDeployment,
  saveVersionEntry,
  VERSION_STATUS,
  DEFAULT_BASE_DIR,
} from "./lib/deployment-state.mjs";

const DEFAULT_CONFIG_PATH = "dist/cf_moedict_webkit_neo/wrangler.json";

/**
 * Fixed, non-hashed core routes for the bounded final smoke. Deliberately
 * NOT derived from a release manifest (this script must work even when the
 * current build is broken or belongs to a different release than the
 * rollback target) and deliberately excludes hashed `/assets/*` paths,
 * whose filenames belong to whichever release built them and are not known
 * here.
 */
export const CORE_ROUTES = Object.freeze(["/", "/api/config", "/api/%E8%90%8C.json"]);

function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * @typedef {import("./lib/r2-upload.mjs").Runner} Runner
 * @typedef {(input: string, init?: RequestInit) => Promise<Response>} FetchFn
 */

/**
 * The full dependency-injected rollback core. No adapter defaults to a real
 * subprocess/network/fs call unless the caller omits it.
 *
 * @param {string} targetUuid Required. The known-good version UUID to roll
 *   traffic back to. There is no default — an emergency rollback must never
 *   guess a target.
 * @param {{
 *   env?: "production" | "staging";
 *   configPath?: string;
 *   config?: string | Record<string, unknown>;
 *   baseUrl?: string;
 *   runner?: Runner;
 *   fetch?: FetchFn;
 *   nowIso?: () => string;
 *   stateBaseDir?: string;
 *   stateFs?: import("./lib/deployment-state.mjs").FsAdapter;
 *   probeTimeoutMs?: number;
 *   setTimeoutFn?: typeof setTimeout;
 *   clearTimeoutFn?: typeof clearTimeout;
 * }} [opts]
 */
export async function runReleaseRollback(targetUuid, opts = {}) {
  if (typeof targetUuid !== "string" || targetUuid.length === 0) {
    throw new Error(
      "release-rollback requires an explicit target version UUID argument — usage: " +
        "node scripts/release-rollback.mjs <target-version-uuid>",
    );
  }
  validateVersionUuid(targetUuid);

  const env = opts.env ?? "production";
  if (env !== "production" && env !== "staging") {
    throw new Error(`Unsupported CLOUDFLARE_ENV: ${String(env)}`);
  }
  const runner =
    opts.runner ??
    runWrangler; /* v8 ignore next -- default spawns a real wrangler subprocess; unsafe to exercise in unit tests */
  const fetchImpl = opts.fetch ?? fetch;
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const probeTimeoutOpts = {
    timeoutMs: opts.probeTimeoutMs,
    setTimeoutFn: opts.setTimeoutFn,
    clearTimeoutFn: opts.clearTimeoutFn,
  };
  const stateRootDir = opts.stateBaseDir ?? DEFAULT_BASE_DIR;
  const stateOpts = { baseDir: join(stateRootDir, env), fs: opts.stateFs };
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;

  // 1. Validate the generated Wrangler config — fail clearly if absent.
  let config;
  try {
    config = parseGeneratedConfig(opts.config ?? configPath);
  } catch (err) {
    throw new Error(
      `Generated Wrangler config unavailable (run \`vp run build\` at least once so ${configPath} ` +
        `exists — rollback reads worker identity from it, not from the current release build): ${errMessage(err)}`,
    );
  }
  const workerName = getWorkerName(config);
  getAssetsBucketName(config, env); // fail closed on env/config mismatch
  const baseUrl = resolveBaseUrl(env, workerName, opts.baseUrl);

  // 2. Require exactly one safe current version at 100% (read-only query).
  const currentDeployment = await getCurrentDeployment(configPath, workerName, { runner });
  const currentUuid = requireSingleVersion100(currentDeployment);

  // 3. Refuse a no-op rollback.
  if (targetUuid === currentUuid) {
    throw new Error(
      `Target version ${targetUuid} is already the current 100% version — nothing to roll back.`,
    );
  }

  // 4. Resolve the target's release tag; refuses unknown UUID or missing tag.
  const versions = await listVersions(configPath, workerName, { runner });
  const targetTag = findTagByVersionId(versions, targetUuid);

  // 5. Deploy target@100 / current@0 — both remain live during the smoke.
  await deployVersionSplit(
    configPath,
    [
      { uuid: targetUuid, percentage: 100 },
      { uuid: currentUuid, percentage: 0 },
    ],
    { runner },
  );

  // 6. Bounded final smoke (no override header — target is actually live).
  //    On failure, restore current@100/target@0 and report both errors.
  try {
    await finalSmoke(baseUrl, [...CORE_ROUTES], targetTag, {
      fetch: fetchImpl,
      ...probeTimeoutOpts,
    });
  } catch (smokeErr) {
    let restoreErr;
    try {
      await rollbackToVersion(configPath, currentUuid, targetUuid, { runner });
    } catch (err) {
      restoreErr = err;
    }
    saveVersionEntry(
      {
        versionId: targetUuid,
        tag: targetTag,
        uploadedAt: nowIso(),
        status: restoreErr ? VERSION_STATUS.ROLLBACK_FAILED : VERSION_STATUS.ROLLED_BACK,
      },
      stateOpts,
    );
    if (restoreErr) {
      throw new Error(`${errMessage(smokeErr)}; RESTORE ALSO FAILED: ${errMessage(restoreErr)}`);
    }
    throw new Error(
      `${errMessage(smokeErr)}; restored ${currentUuid}@100% alone, rollback target ${targetUuid} was not promoted`,
    );
  }

  // 7. Finalize: target@100 alone.
  await deployVersionSplit(configPath, [{ uuid: targetUuid, percentage: 100 }], { runner });

  // 8. Persist env-namespaced current/history state.
  const deployedAt = nowIso();
  saveVersionEntry(
    {
      versionId: targetUuid,
      tag: targetTag,
      uploadedAt: deployedAt,
      status: VERSION_STATUS.FINALIZED,
    },
    stateOpts,
  );
  saveCurrentDeployment(
    { workerName, versionId: targetUuid, tag: targetTag, percentage: 100, deployedAt },
    stateOpts,
  );

  return { releaseId: targetTag, workerName, versionId: targetUuid, env, deployedAt };
}

/* v8 ignore start -- real CLI entrypoint: performs an actual production/staging rollback against the live Cloudflare account. Never safe to invoke from a unit test; exercised via manual `bun run deploy:rollback` instead. */
async function main() {
  const env = /** @type {"production" | "staging"} */ (process.env.CLOUDFLARE_ENV ?? "production");
  const targetUuid = process.argv[2];
  if (!targetUuid) {
    throw new Error(
      "Usage: node scripts/release-rollback.mjs <target-version-uuid> (CLOUDFLARE_ENV=staging|production)",
    );
  }
  console.log(`[release-rollback] env=${env} target=${targetUuid}`);
  const result = await runReleaseRollback(targetUuid, { env });
  console.log(
    `[release-rollback] OK — rolled back to release ${result.releaseId} (${result.versionId}) on ${result.workerName} at ${result.deployedAt}`,
  );
}
/* v8 ignore stop */

// Import-safe: run only when invoked directly, never when unit tests import.
const invokedDirectly = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    /* v8 ignore next -- defensive: process.argv[1]/import.meta.url access does not throw in any real Node runtime */
    return false;
  }
})();
/* v8 ignore start -- only true when this file is the CLI entrypoint; never true when a unit test imports the module */
if (invokedDirectly) {
  main().catch((error) => {
    console.error("[release-rollback] FAILED", error);
    process.exit(1);
  });
}
/* v8 ignore stop */
