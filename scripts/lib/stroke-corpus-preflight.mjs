/**
 * Deploy preflight gate: LIGHTWEIGHT stroke-corpus readiness check against
 * the target environment's generated ASSETS bucket, run BEFORE any
 * mutating Wrangler call in the standard `bun run deploy` /
 * `bun run deploy:staging` chains (both `release-publish.mjs` and
 * `release-deploy.mjs` each call this once — two authenticated reads per
 * script, four total per full deploy chain).
 *
 * Rationale: `handleStrokeAPI.ts` fails closed (503) whenever the
 * `stroke-corpus/current.json` pointer, its manifest, or any allowlisted
 * object is missing/invalid/hash-mismatched. If a deploy ships a Worker
 * build against a target bucket whose corpus was never prepared (or was
 * corrupted since), every `/api/stroke-json/*` request would start
 * returning 503 the moment that Worker version goes live — a regression
 * introduced by the *deploy*, not by the corpus pipeline. This preflight
 * catches that class of failure BEFORE any mutation, fail-closed.
 *
 * DELIBERATELY LIGHTWEIGHT — an authenticated GET of the pointer +
 * manifest ONLY (`verifyCorpusReadiness`), never a single one of the
 * 6,063 corpus objects. Re-downloading and re-hashing all 6,063
 * class-B stroke-json bodies (~53 minutes) on EVERY publish AND EVERY
 * deploy would make routine deploys unusably slow for a corpus that,
 * once uploaded, is immutable and was already fully verified
 * byte-for-byte BEFORE its pointer was ever promoted (see
 * `runAtomicCorpusUpload` → `verifyAtomicCorpusUploads` in
 * commands/sync-moe-stroke-corpus.mjs). Full 6,063-object verification
 * remains available, but ONLY via:
 *   (a) the upload path itself, before pointer promotion, and
 *   (b) an explicit operator run of
 *       `node commands/sync-moe-stroke-corpus.mjs --verify-only=<env>`
 *       (`verifyCorpusOnly`) — never invoked automatically by a deploy.
 *
 * This keeps current production/staging exactly as they are (old release
 * stays live and safe) until an operator runs the corpus pipeline
 * successfully for that target; only THEN does a deploy proceed.
 */

import { verifyCorpusReadiness } from "../../commands/sync-moe-stroke-corpus.mjs";
import { parseGeneratedConfig, getAssetsBucketName } from "./generated-config.mjs";

/**
 * Run the LIGHTWEIGHT corpus readiness preflight for `env` against the
 * bucket resolved from the generated Wrangler config: authenticated GET
 * of the pointer + manifest only (zero corpus-object reads), strict
 * schema validation, pointer↔manifest digest/fileCount/totalBytes
 * consistency, exact 6,063 count, and a manifest content self-digest
 * check (`corpusDigest` recomputed from the manifest's own file
 * hex/sha256 pairs). Throws (never returns) when the corpus is missing,
 * malformed, or internally inconsistent — callers MUST run this before
 * any mutating Wrangler call and propagate the failure without catching
 * it into a "proceed anyway" path.
 *
 * NOT a substitute for full corpus integrity verification — see
 * `verifyCorpusReadiness`'s own doc comment for exactly what is and is
 * not covered.
 *
 * @param {"staging"|"production"} env
 * @param {{
 *   configPath?: string,
 *   config?: string | Record<string, unknown>,
 *   runner?: Function,
 *   sleep?: (ms: number) => Promise<void>,
 *   maxRetries?: number,
 *   log?: (...args: unknown[]) => void,
 * }} [opts]
 * @returns {Promise<{ ok: true, bucketName: string, corpusDigest: string, fileCount: number }>}
 */
export async function runStrokeCorpusPreflight(env, opts = {}) {
  const log = opts.log ?? console.log;
  if (env !== "staging" && env !== "production") {
    throw new Error(`Unsupported stroke-corpus preflight env: ${String(env)}`);
  }

  let bucketName;
  try {
    const config = parseGeneratedConfig(
      opts.config ?? opts.configPath ?? "dist/cf_moedict_webkit_neo/wrangler.json",
    );
    bucketName = getAssetsBucketName(config, env);
  } catch (err) {
    throw new Error(
      `[stroke-corpus-preflight] cannot resolve ASSETS bucket for env=${env} (generated config required — run \`vp run build\` first): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  log(
    `[stroke-corpus-preflight] checking corpus readiness (pointer+manifest only): env=${env} bucket=${bucketName}`,
  );
  let result;
  try {
    result = await verifyCorpusReadiness(bucketName, {
      runner: opts.runner,
      sleep: opts.sleep,
      maxRetries: opts.maxRetries,
    });
  } catch (err) {
    throw new Error(
      `[stroke-corpus-preflight] FAILED for env=${env} bucket=${bucketName} — deploy blocked before any mutating call. ` +
        `Prepare the corpus first (\`node commands/sync-moe-stroke-corpus.mjs --upload=${env}\`) then retry. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  log(
    `[stroke-corpus-preflight] OK — corpusDigest=${result.pointer.corpusDigest} fileCount=${result.manifest.fileCount} (pointer+manifest only, no object reads)`,
  );
  return {
    ok: true,
    bucketName,
    corpusDigest: result.pointer.corpusDigest,
    fileCount: result.manifest.fileCount,
  };
}
