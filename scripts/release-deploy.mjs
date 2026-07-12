/**
 * Two-phase deployment orchestrator with safety gates (Task 3).
 *
 * Usage: node scripts/release-deploy.mjs  (CLOUDFLARE_ENV=staging|production, default production)
 *
 * Runs the full safe protocol: prod approval gate → require old@100 →
 * upload tagged version → deploy new@0/old@100 → version-override smoke →
 * promote new@100/old@0 → 120s continuous probe → finalize new@100 alone →
 * final smoke → save state → (staging only) record approval for prod.
 *
 * `runReleaseDeploy` is the fully dependency-injected, unit-testable core.
 * `main()` supplies real adapters (process env, real Wrangler subprocess,
 * real fetch/sleep, real fs) and is only invoked when this file is run
 * directly — import-safe like release-publish.mjs / release-verify.mjs.
 *
 * Task 3 assumes Task 2's build/publish output (dist/client, the generated
 * Wrangler config) already exists; it fails clearly, not silently, if
 * either is absent. This file does not change package.json scripts — the
 * `deploy`/`deploy:staging` cutover is Task 4's responsibility.
 */

import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  parseGeneratedConfig,
  getAssetsBucketName,
  getWorkerName,
} from "./lib/generated-config.mjs";
import { buildReleaseManifest } from "./lib/release-manifest.mjs";
import { runWrangler } from "./lib/r2-upload.mjs";
import {
  uploadVersion,
  deployVersionSplit,
  rollbackToVersion,
  listVersions,
  findVersionByTag,
  getCurrentDeployment,
  requireSingleVersion100,
} from "./lib/wrangler-versions.mjs";
import { smokeWithVersionOverride, finalSmoke, continuousProbe } from "./lib/smoke-probe.mjs";
import {
  saveCurrentDeployment,
  saveVersionEntry,
  saveStagingApproval,
  readStagingApproval,
  checkStagingApprovalGate,
  VERSION_STATUS,
  DEFAULT_BASE_DIR,
} from "./lib/deployment-state.mjs";

const DEFAULT_CONFIG_PATH = "dist/cf_moedict_webkit_neo/wrangler.json";
const DEFAULT_DIST_CLIENT_DIR = "dist/client";

/**
 * Derive the probe route set from the current release manifest — always the
 * live hashed JS/CSS asset paths, never a hardcoded/stale filename.
 * @param {{ files: Array<{ path: string }> }} manifest
 * @returns {string[]}
 */
export function deriveProbeRoutes(manifest) {
  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error("deriveProbeRoutes: manifest.files is required");
  }
  const jsAsset = manifest.files.find(
    (f) => f.path.startsWith("assets/") && f.path.endsWith(".js"),
  );
  const cssAsset = manifest.files.find(
    (f) => f.path.startsWith("assets/") && f.path.endsWith(".css"),
  );
  if (!jsAsset) throw new Error("deriveProbeRoutes: no hashed JS asset found in manifest.files");
  if (!cssAsset) throw new Error("deriveProbeRoutes: no hashed CSS asset found in manifest.files");
  return ["/", "/api/config", "/api/%E8%90%8C.json", `/${jsAsset.path}`, `/${cssAsset.path}`];
}

/**
 * Resolve the base URL to probe against. Staging Workers only ever get a
 * `*.workers.dev` URL (no custom domain); production is the custom domain.
 * @param {"production" | "staging"} env
 * @param {string} workerName
 * @param {string | undefined} override
 * @returns {string}
 */
export function resolveBaseUrl(env, workerName, override) {
  if (override) return override;
  if (env === "production") return "https://www.moedict.tw";
  if (env === "staging") return `https://${workerName}.audreyt.workers.dev`;
  throw new Error(`Unsupported CLOUDFLARE_ENV: ${String(env)}`);
}

function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * @typedef {import("./lib/r2-upload.mjs").Runner} Runner
 * @typedef {(input: string, init?: RequestInit) => Promise<Response>} FetchFn
 */

/**
 * The full dependency-injected orchestrator. No adapter defaults to a real
 * subprocess/network/fs call unless the caller omits it — every collaborator
 * can be mocked, making this fully unit-testable without touching Wrangler,
 * the network, or the real `.wrangler/releases/` state directory. Current
 * deployment/version-history state is namespaced under
 * `<stateBaseDir>/<env>/`; staging approval lives at the shared
 * `<stateBaseDir>/staging-approval.json` so production can read it.
 *
 * @param {{
 *   env?: "production" | "staging";
 *   configPath?: string;
 *   config?: string | Record<string, unknown>;
 *   distClientDir?: string;
 *   manifest?: Record<string, unknown>;
 *   manifestOpts?: Record<string, unknown>;
 *   baseUrl?: string;
 *   runner?: Runner;
 *   fetch?: FetchFn;
 *   sleep?: (ms: number) => Promise<void>;
 *   nowIso?: () => string;
 *   soakIntervalMs?: number;
 *   soakDurationMs?: number;
 *   stateBaseDir?: string;
 *   stateFs?: import("./lib/deployment-state.mjs").FsAdapter;
 *   probeTimeoutMs?: number;
 *   setTimeoutFn?: typeof setTimeout;
 *   clearTimeoutFn?: typeof clearTimeout;
 * }} [opts]
 */
export async function runReleaseDeploy(opts = {}) {
  const env = opts.env ?? "production";
  if (env !== "production" && env !== "staging") {
    throw new Error(`Unsupported CLOUDFLARE_ENV: ${String(env)}`);
  }
  const runner =
    opts.runner ??
    runWrangler; /* v8 ignore next -- default spawns a real wrangler subprocess; unsafe to exercise in unit tests */
  const fetchImpl = opts.fetch ?? fetch;
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const soakIntervalMs = opts.soakIntervalMs ?? 5000;
  const soakDurationMs = opts.soakDurationMs ?? 120000;
  const probeTimeoutOpts = {
    timeoutMs: opts.probeTimeoutMs,
    setTimeoutFn: opts.setTimeoutFn,
    clearTimeoutFn: opts.clearTimeoutFn,
  };
  // Current-deployment/version-history state is namespaced per environment
  // so a staging run and a production run never share or clobber each
  // other's current.json/versions.json. Staging approval is intentionally
  // NOT namespaced — it lives at the shared root so production can read the
  // approval a staging run recorded.
  const stateRootDir = opts.stateBaseDir ?? DEFAULT_BASE_DIR;
  const stateOpts = { baseDir: join(stateRootDir, env), fs: opts.stateFs };
  const approvalOpts = { baseDir: stateRootDir, fs: opts.stateFs };
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;

  // 1. Validate the generated Wrangler config — fail clearly if absent.
  let config;
  try {
    config = parseGeneratedConfig(opts.config ?? configPath);
  } catch (err) {
    throw new Error(
      `Generated Wrangler config unavailable (Task 2 build output required — run \`vp run build\` first): ${errMessage(err)}`,
    );
  }
  const workerName = getWorkerName(config);
  getAssetsBucketName(config, env); // fail closed on env/config mismatch

  // 2. Validate the release manifest — fail clearly if absent.
  let manifest;
  try {
    manifest =
      opts.manifest ??
      buildReleaseManifest(opts.distClientDir ?? DEFAULT_DIST_CLIENT_DIR, opts.manifestOpts ?? {});
  } catch (err) {
    throw new Error(
      `Release manifest unavailable (Task 2 build/publish output required — run \`vp run build\` first): ${errMessage(err)}`,
    );
  }
  const releaseId = /** @type {string} */ (manifest.id);
  const gitSha = /** @type {string} */ (manifest.gitSha);
  const clientManifestDigest = /** @type {string} */ (manifest.clientManifestDigest);
  const routes = deriveProbeRoutes(/** @type {{ files: Array<{ path: string }> }} */ (manifest));
  const baseUrl = resolveBaseUrl(env, workerName, opts.baseUrl);

  // 3. Production approval gate — before ANY mutating Wrangler call.
  if (env === "production") {
    const stagingApproval = readStagingApproval(approvalOpts);
    if (!checkStagingApprovalGate(gitSha, clientManifestDigest, stagingApproval)) {
      throw new Error(
        `Production deploy blocked: no staging approval matches git SHA ${gitSha} + client manifest digest ` +
          `${clientManifestDigest}. Run \`vp run deploy:staging\` and verify it first.`,
      );
    }
  }

  // 4. Require exactly one safe old version at 100% (read-only query).
  const oldDeployment = await getCurrentDeployment(configPath, workerName, { runner });
  const oldVersionUuid = requireSingleVersion100(oldDeployment);

  // 5. Upload the new tagged version (first mutating call), confirmed via versions list.
  const uploadedUuid = await uploadVersion(configPath, releaseId, { runner });
  const versions = await listVersions(configPath, workerName, { runner });
  const confirmedUuid = findVersionByTag(versions, releaseId);
  if (confirmedUuid !== uploadedUuid) {
    saveVersionEntry(
      {
        versionId: uploadedUuid,
        tag: releaseId,
        uploadedAt: nowIso(),
        status: VERSION_STATUS.CONFIRM_FAILED,
      },
      stateOpts,
    );
    throw new Error(
      `Version UUID mismatch: upload output reported ${uploadedUuid}, but versions list confirms ` +
        `${confirmedUuid} for tag ${releaseId}`,
    );
  }
  const newVersionUuid = confirmedUuid;
  saveVersionEntry(
    {
      versionId: newVersionUuid,
      tag: releaseId,
      uploadedAt: nowIso(),
      status: VERSION_STATUS.UPLOADED,
    },
    stateOpts,
  );

  // 6. Deploy new@0 / old@100.
  await deployVersionSplit(
    configPath,
    [
      { uuid: newVersionUuid, percentage: 0 },
      { uuid: oldVersionUuid, percentage: 100 },
    ],
    { runner },
  );

  // 7. Smoke the new version at 0% via version override. On failure, restore
  //    old@100 ALONE (not new@0/old@100) so the next run is not poisoned.
  try {
    await smokeWithVersionOverride(baseUrl, workerName, newVersionUuid, routes, releaseId, {
      fetch: fetchImpl,
      ...probeTimeoutOpts,
    });
  } catch (smokeErr) {
    let restoreErr;
    try {
      await deployVersionSplit(configPath, [{ uuid: oldVersionUuid, percentage: 100 }], { runner });
    } catch (err) {
      restoreErr = err;
    }
    saveVersionEntry(
      {
        versionId: newVersionUuid,
        tag: releaseId,
        uploadedAt: nowIso(),
        status: restoreErr ? VERSION_STATUS.RESTORE_FAILED : VERSION_STATUS.SMOKE_FAILED,
      },
      stateOpts,
    );
    if (restoreErr) {
      throw new Error(`${errMessage(smokeErr)}; RESTORE ALSO FAILED: ${errMessage(restoreErr)}`);
    }
    throw new Error(
      `${errMessage(smokeErr)}; restored ${oldVersionUuid}@100% alone so the next run is not poisoned`,
    );
  }

  // 8. Promote: new@100 / old@0 — both remain live during the soak.
  await deployVersionSplit(
    configPath,
    [
      { uuid: newVersionUuid, percentage: 100 },
      { uuid: oldVersionUuid, percentage: 0 },
    ],
    { runner },
  );
  saveVersionEntry(
    {
      versionId: newVersionUuid,
      tag: releaseId,
      uploadedAt: nowIso(),
      status: VERSION_STATUS.PROMOTED,
    },
    stateOpts,
  );

  /** Roll back to old@100/new@0 and re-throw, reporting both errors if rollback itself fails. */
  const rollbackOnFailure = async (originalErr) => {
    let rollbackErr;
    try {
      await rollbackToVersion(configPath, oldVersionUuid, newVersionUuid, { runner });
    } catch (err) {
      rollbackErr = err;
    }
    saveVersionEntry(
      {
        versionId: newVersionUuid,
        tag: releaseId,
        uploadedAt: nowIso(),
        status: rollbackErr ? VERSION_STATUS.ROLLBACK_FAILED : VERSION_STATUS.ROLLED_BACK,
      },
      stateOpts,
    );
    if (rollbackErr) {
      throw new Error(
        `${errMessage(originalErr)}; ROLLBACK ALSO FAILED: ${errMessage(rollbackErr)}`,
      );
    }
    throw new Error(`${errMessage(originalErr)}; rolled back to ${oldVersionUuid}@100%`);
  };

  // 9. Continuous probe for >=120s against live traffic (now serving new@100).
  try {
    await continuousProbe(baseUrl, routes, releaseId, {
      fetch: fetchImpl,
      sleep: opts.sleep,
      intervalMs: soakIntervalMs,
      durationMs: soakDurationMs,
      ...probeTimeoutOpts,
    });
  } catch (probeErr) {
    await rollbackOnFailure(probeErr);
  }

  // 10. Finalize: new@100 alone.
  try {
    await deployVersionSplit(configPath, [{ uuid: newVersionUuid, percentage: 100 }], { runner });
  } catch (finalizeErr) {
    await rollbackOnFailure(finalizeErr);
  }

  // 11. Final smoke — no override header, but still requires the release ID header.
  try {
    await finalSmoke(baseUrl, routes, releaseId, { fetch: fetchImpl, ...probeTimeoutOpts });
  } catch (finalSmokeErr) {
    await rollbackOnFailure(finalSmokeErr);
  }

  // 12. Only now — strictly after the final smoke passes — persist success state.
  const deployedAt = nowIso();
  saveVersionEntry(
    {
      versionId: newVersionUuid,
      tag: releaseId,
      uploadedAt: deployedAt,
      status: VERSION_STATUS.FINALIZED,
    },
    stateOpts,
  );
  saveCurrentDeployment(
    { workerName, versionId: newVersionUuid, tag: releaseId, percentage: 100, deployedAt },
    stateOpts,
  );
  if (env === "staging") {
    saveStagingApproval({ gitSha, clientManifestDigest, approvedAt: deployedAt }, approvalOpts);
  }

  return { releaseId, workerName, versionId: newVersionUuid, env, deployedAt };
}

/* v8 ignore start -- real CLI entrypoint: performs an actual two-phase deployment against the live Cloudflare account. Never safe to invoke from a unit test; exercised via manual `vp run deploy`/`deploy:staging` instead. */
async function main() {
  const env = /** @type {"production" | "staging"} */ (process.env.CLOUDFLARE_ENV ?? "production");
  console.log(`[release-deploy] env=${env}`);
  const result = await runReleaseDeploy({ env });
  console.log(
    `[release-deploy] OK — release ${result.releaseId} finalized on ${result.workerName} at ${result.deployedAt}`,
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
    console.error("[release-deploy] FAILED", error);
    process.exit(1);
  });
}
/* v8 ignore stop */
