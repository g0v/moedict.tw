/**
 * Parse the generated wrangler config (dist/cf_moedict_webkit_neo/wrangler.json)
 * and select the ASSETS binding's effective bucket_name.
 *
 * The generated config is FLATTENED by @cloudflare/vite-plugin:
 * - Production: ASSETS has bucket_name="moedict-assets" + preview_bucket_name
 * - Staging: ASSETS has bucket_name="moedict-assets-preview" and NO
 *   preview_bucket_name (flattening already resolved the env-specific bucket)
 *
 * Therefore we ALWAYS read bucket_name — never assume preview_bucket_name
 * survives flattening. Fail closed on wrong/missing env/binding/name.
 */

/**
 * Parse a generated wrangler config. Accepts either a file path (string)
 * or an already-parsed config object.
 * @param {string | Record<string, unknown>} input
 * @returns {Record<string, unknown>}
 */
export function parseGeneratedConfig(input) {
  if (typeof input === "string") {
    // Defer import to avoid pulling fs into unit tests that pass objects
    const { readFileSync } = require("node:fs");
    const raw = readFileSync(input, "utf-8");
    return JSON.parse(raw);
  }
  if (input && typeof input === "object") {
    return input;
  }
  throw new Error("parseGeneratedConfig: expected file path or config object");
}

// require shim for ESM — only used when input is a string path
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

/**
 * Get the ASSETS binding's effective bucket_name from the generated config.
 *
 * Always reads bucket_name (the flattened effective value). Does NOT fall
 * back to preview_bucket_name — it does not survive flattening for staging.
 *
 * @param {Record<string, unknown>} config
 * @param {string | undefined} env
 * @returns {string}
 */
export function getAssetsBucketName(config, env) {
  const normalizedEnv = env ?? "production";
  if (normalizedEnv !== "production" && normalizedEnv !== "staging") {
    throw new Error(`Unsupported CLOUDFLARE_ENV: ${normalizedEnv}`);
  }
  const targetEnvironment = config.targetEnvironment;
  const targetLabel = typeof targetEnvironment === "string" ? targetEnvironment : "<absent>";
  if (
    (normalizedEnv === "staging" && targetEnvironment !== "staging") ||
    (normalizedEnv === "production" &&
      targetEnvironment !== undefined &&
      targetEnvironment !== "production")
  ) {
    throw new Error(
      `Generated config targetEnvironment mismatch: expected ${normalizedEnv}, got ${targetLabel}`,
    );
  }
  const buckets = /** @type {Array<Record<string, unknown>> | undefined} */ (config.r2_buckets);
  if (!Array.isArray(buckets)) {
    throw new Error("ASSETS binding not found: r2_buckets missing in generated config");
  }
  const binding = buckets.find((b) => b.binding === "ASSETS");
  if (!binding) throw new Error("ASSETS binding not found in generated config");
  const bucketName = binding.bucket_name;
  if (typeof bucketName !== "string" || !bucketName) {
    throw new Error(`ASSETS binding has no bucket_name in generated config (env=${normalizedEnv})`);
  }
  const name = config.name;
  if (typeof name !== "string" || !name) {
    throw new Error("Worker name not found in generated config");
  }
  const stagingShape = normalizedEnv === "staging";
  if (
    stagingShape !== name.endsWith("-staging") ||
    stagingShape !== bucketName.endsWith("-preview")
  ) {
    throw new Error(`Generated config worker/bucket shape mismatch for ${normalizedEnv}`);
  }
  return bucketName;
}

/**
 * Get the worker name from the generated config.
 * @param {Record<string, unknown>} config
 * @returns {string}
 */
export function getWorkerName(config) {
  const name = config.name;
  if (typeof name !== "string" || !name) {
    throw new Error("Worker name not found in generated config");
  }
  return name;
}
