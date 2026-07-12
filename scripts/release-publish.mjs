/**
 * Release publish CLI.
 *
 * Usage: node scripts/release-publish.mjs
 *
 * Reads CLOUDFLARE_ENV (default: production), builds release ID from
 * git SHA + client manifest digest, uploads all dist/client/** to R2
 * (release-scoped + immutable copies for hashed assets), uploads
 * release-manifest.json LAST, then verifies all objects.
 *
 * Import-safe: main guard at bottom. CLI fails nonzero. No hidden deployment.
 */

import { fileURLToPath } from "node:url";
import { parseGeneratedConfig, getAssetsBucketName } from "./lib/generated-config.mjs";
import { buildReleaseManifest, deterministicStringify } from "./lib/release-manifest.mjs";
import { uploadReleaseToR2 } from "./lib/r2-upload.mjs";
import { verifyRelease } from "./release-verify.mjs";

async function main() {
  const env = process.env.CLOUDFLARE_ENV ?? "production";
  const configPath = "dist/cf_moedict_webkit_neo/wrangler.json";
  const distClientDir = "dist/client";

  // 1. Parse generated config to determine bucket
  const config = parseGeneratedConfig(configPath);
  const bucketName = getAssetsBucketName(config, env);

  // 2. Build release manifest (deterministic ID from git SHA + digest)
  const manifest = buildReleaseManifest(distClientDir);
  const manifestJson = deterministicStringify(manifest);

  console.log(`[release-publish] Release ID: ${manifest.id}`);
  console.log(`[release-publish] Bucket: ${bucketName} (env=${env})`);
  console.log(`[release-publish] Files: ${manifest.files.length}`);

  // 3. Upload all files (release-scoped + immutable copies), manifest LAST
  await uploadReleaseToR2(manifest.id, distClientDir, bucketName, {
    manifestJson,
  });
  console.log(`[release-publish] Upload complete`);

  // 4. Verify all objects
  const result = await verifyRelease(bucketName, manifest.id, manifest);
  if (result.verified) {
    console.log(`[release-publish] Verified ${result.checkedKeys.length} objects`);
    console.log(`[release-publish] OK`);
  }
}

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
