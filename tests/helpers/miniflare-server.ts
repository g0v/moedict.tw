import { Miniflare, Response as MFResponse } from "miniflare";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildWorker } from "./build-worker";
import { collectAllFixtures, type FixtureEntry, type FixtureBucket } from "./fixtures";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DIST_CLIENT = path.join(REPO_ROOT, "dist", "client");

export interface TestServer {
  mf: Miniflare;
  url: URL;
  dispatchFetch: Miniflare["dispatchFetch"];
  stop: () => Promise<void>;
}

export interface StartOptions {
  includeAssets?: boolean;
  port?: number;
  /** When set, binds `CF_VERSION_METADATA` to this value. */
  versionMetadata?: { id: string; tag: string; timestamp: string };
}

interface SeedableR2Bucket {
  put(
    key: string,
    value: ArrayBuffer,
    options: { httpMetadata?: FixtureEntry["httpMetadata"] },
  ): Promise<unknown>;
}

async function seedBucket(
  mf: Miniflare,
  binding: FixtureBucket,
  entries: FixtureEntry[],
): Promise<void> {
  const bucket = (await mf.getR2Bucket(binding)) as unknown as SeedableR2Bucket;
  for (const entry of entries) {
    if (entry.bucket !== binding) continue;
    // Miniflare proxies R2 ops over a worker boundary; pass a primitive ArrayBuffer
    // to avoid devalue serialization issues with typed-array views/offsets.
    const ab = new Uint8Array(entry.body).buffer;
    await bucket.put(entry.key, ab, { httpMetadata: entry.httpMetadata });
  }
}

export async function startTestServer(options: StartOptions = {}): Promise<TestServer> {
  const workerPath = await buildWorker();
  const script = readFileSync(workerPath, "utf-8");
  const wantAssets = options.includeAssets ?? false;

  if (wantAssets && !existsSync(DIST_CLIENT)) {
    throw new Error(
      `includeAssets=true but ${DIST_CLIENT} is missing — run \`vp run build\` first.`,
    );
  }

  const mfConfig: ConstructorParameters<typeof Miniflare>[0] = {
    modules: true,
    script,
    scriptPath: workerPath,
    compatibilityDate: "2025-11-05",
    compatibilityFlags: ["nodejs_compat"],
    r2Buckets: ["DICTIONARY", "ASSETS", "FONTS"],
    bindings: {
      ASSET_BASE_URL: "https://r2-assets.test.local",
      DICTIONARY_BASE_URL: "https://r2-dictionary.test.local",
      ...(options.versionMetadata ? { CF_VERSION_METADATA: options.versionMetadata } : {}),
    },
    // Every outbound `fetch()` the worker script issues (legacy ASSET_BASE_URL
    // proxy misses, the Cloudflare zone-purge API, etc.) is dispatched
    // in-process here instead of hitting real DNS. Without this, a request to
    // the fake `r2-assets.test.local`/`r2-dictionary.test.local` hosts pays a
    // real OS DNS-failure timeout (~5s) before the worker's own catch clause
    // turns it into a 502 -- under concurrent test load this was the dominant
    // source of intermittent /assets/* 502s. Immediate 404 here is
    // indistinguishable from a real upstream miss from the worker's
    // perspective (its existing catch/fallback logic already handles both).
    outboundService: () => new MFResponse(null, { status: 404 }),
    verbose: false,
  };

  if (options.port != null) {
    mfConfig.port = options.port;
  }

  if (wantAssets) {
    mfConfig.assets = {
      binding: "SITE_ASSETS",
      directory: DIST_CLIENT,
      routerConfig: {
        has_user_worker: true,
        invoke_user_worker_ahead_of_assets: false,
        static_routing: {
          user_worker: ["/*", "!/fonts/*", "!/manifest.json"],
        },
      },
    };
  }

  const mf = new Miniflare(mfConfig);

  const url = await mf.ready;

  // The TCP port is already open and accepting requests as soon as
  // `mf.ready` resolves above -- workerd binds the socket before we get a
  // chance to seed any R2 fixture data, so there is an inherent window
  // where a request can race ahead of seeding. Playwright's webServer
  // readiness probe (playwright.config.ts) polls `/api/<word>.json`, which
  // only resolves once the DICTIONARY bucket is seeded -- so DICTIONARY is
  // seeded LAST here, after ASSETS and FONTS, so that a 200 from the probe
  // is a reliable proxy for "every fixture bucket is seeded", not just
  // DICTIONARY. Do not reorder without updating the readiness probe target.
  const fixtures = collectAllFixtures();
  await Promise.all([seedBucket(mf, "ASSETS", fixtures), seedBucket(mf, "FONTS", fixtures)]);
  await seedBucket(mf, "DICTIONARY", fixtures);

  const stop = async () => {
    await mf.dispose();
  };

  return { mf, url, dispatchFetch: mf.dispatchFetch.bind(mf), stop };
}

// Re-export Miniflare types/helpers the integration tests need.
export { MFResponse };
