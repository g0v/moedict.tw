/**
 * Release publish CLI.
 *
 * Usage: node scripts/release-publish.mjs
 *
 * Reads CLOUDFLARE_ENV (default: production). BEFORE any mutating Wrangler
 * call, runs the LIGHTWEIGHT stroke-corpus readiness preflight (see
 * scripts/lib/stroke-corpus-preflight.mjs — authenticated pointer+manifest
 * GET only, zero corpus-object reads) against the target env's ASSETS
 * bucket — this is the actual first mutation in the `bun run deploy` /
 * `deploy:staging` chains (`env -u CLOUDFLARE_ENV vp run build && … &&
 * node scripts/release-publish.mjs && … node scripts/release-deploy.mjs`),
 * so gating release-deploy.mjs alone would leave this upload unprotected.
 * A missing/invalid/hash-mismatched corpus throws here and NOTHING is
 * uploaded — current production/staging remain untouched and safe. Full
 * 6,063-object verification is NOT run here — see
 * scripts/lib/stroke-corpus-preflight.mjs's doc comment for why, and for
 * where full verification still happens.
 *
 * Only once the preflight passes: builds release ID from git SHA + client
 * manifest digest, uploads all dist/client/** to R2 (release-scoped +
 * immutable copies for hashed assets), uploads release-manifest.json LAST,
 * then verifies all objects.
 *
 * Import-safe: main guard at bottom. CLI fails nonzero. No hidden deployment.
 */

import { fileURLToPath } from "node:url";
import { parseGeneratedConfig, getAssetsBucketName } from "./lib/generated-config.mjs";
import { buildReleaseManifest, deterministicStringify } from "./lib/release-manifest.mjs";
import { uploadReleaseToR2 } from "./lib/r2-upload.mjs";
import { verifyRelease } from "./release-verify.mjs";
import { runStrokeCorpusPreflight } from "./lib/stroke-corpus-preflight.mjs";

const DEFAULT_CONFIG_PATH = "dist/cf_moedict_webkit_neo/wrangler.json";
const DEFAULT_DIST_CLIENT_DIR = "dist/client";

/**
 * Dependency-injected core, matching the pattern in release-deploy.mjs /
 * release-verify.mjs. `main()` below supplies real adapters and is only
 * invoked when this file is run directly.
 *
 * @param {{
 *   env?: "production" | "staging",
 *   configPath?: string,
 *   distClientDir?: string,
 *   config?: string | Record<string, unknown>,
 *   manifest?: Record<string, unknown>,
 *   manifestOpts?: Record<string, unknown>,
 *   preflight?: (env: "production" | "staging", opts?: Record<string, unknown>) => Promise<unknown>,
 *   uploadRelease?: typeof uploadReleaseToR2,
 *   verify?: typeof verifyRelease,
 *   runner?: Function,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (...args: unknown[]) => void,
 * }} [opts]
 */
export async function runReleasePublish(opts = {}) {
  const log = opts.log ?? console.log;
  const env = opts.env ?? process.env.CLOUDFLARE_ENV ?? "production";
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;
  const distClientDir = opts.distClientDir ?? DEFAULT_DIST_CLIENT_DIR;

  // 0. Stroke-corpus readiness preflight — BEFORE any mutating Wrangler
  //    call. Throws (propagates, uncaught) on a missing/invalid corpus;
  //    nothing below this line has run yet, so no R2 write has occurred.
  const preflight = opts.preflight ?? runStrokeCorpusPreflight;
  await preflight(env, {
    configPath,
    config: opts.config,
    runner: opts.runner,
    sleep: opts.sleep,
    log,
  });

  // 1. Parse generated config to determine bucket
  const config = parseGeneratedConfig(opts.config ?? configPath);
  const bucketName = getAssetsBucketName(config, env);

  // 2. Build release manifest (deterministic ID from git SHA + digest)
  const manifest = opts.manifest ?? buildReleaseManifest(distClientDir, opts.manifestOpts ?? {});
  const manifestJson = deterministicStringify(manifest);
  const releaseId = /** @type {string} */ (manifest.id);
  const files = /** @type {Array<unknown>} */ (manifest.files);

  log(`[release-publish] Release ID: ${releaseId}`);
  log(`[release-publish] Bucket: ${bucketName} (env=${env})`);
  log(`[release-publish] Files: ${files.length}`);

  // 3. Upload all files (release-scoped + immutable copies), manifest LAST
  const uploadRelease = opts.uploadRelease ?? uploadReleaseToR2;
  await uploadRelease(releaseId, distClientDir, bucketName, {
    manifestJson,
    runner: opts.runner,
    sleep: opts.sleep,
  });
  log(`[release-publish] Upload complete`);

  // 4. Verify all objects
  const verify = opts.verify ?? verifyRelease;
  const result = await verify(bucketName, releaseId, manifest, {
    runner: opts.runner,
    sleep: opts.sleep,
  });
  if (result.verified) {
    log(`[release-publish] Verified ${result.checkedKeys.length} objects`);
    log(`[release-publish] OK`);
  }
  return { releaseId, bucketName, env, verified: result.verified };
}

/* v8 ignore start -- real CLI entrypoint: performs an actual R2 publish against the live Cloudflare account. Never safe to invoke from a unit test; exercised via manual `vp run deploy`/`deploy:staging` instead. */
async function main() {
  await runReleasePublish();
}
/* v8 ignore stop */

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
    console.error("[release-publish] FAILED", error);
    process.exit(1);
  });
}
