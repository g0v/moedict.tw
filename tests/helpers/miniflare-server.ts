import { Miniflare, Response as MFResponse } from 'miniflare';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildWorker } from './build-worker';
import { collectAllFixtures, type FixtureEntry, type FixtureBucket } from './fixtures';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_CLIENT = path.join(REPO_ROOT, 'dist', 'client');

export interface TestServer {
  mf: Miniflare;
  url: URL;
  dispatchFetch: Miniflare['dispatchFetch'];
  stop: () => Promise<void>;
}

export interface StartOptions {
  includeAssets?: boolean;
  port?: number;
}

async function seedBucket(mf: Miniflare, binding: FixtureBucket, entries: FixtureEntry[]): Promise<void> {
  const bucket = await mf.getR2Bucket(binding);
  for (const entry of entries) {
    if (entry.bucket !== binding) continue;
    // Miniflare proxies R2 ops over a worker boundary; pass a primitive ArrayBuffer
    // to avoid devalue serialization issues with typed-array views/offsets.
    const ab = entry.body.buffer.slice(entry.body.byteOffset, entry.body.byteOffset + entry.body.byteLength);
    await bucket.put(entry.key, ab, { httpMetadata: entry.httpMetadata });
  }
}

export async function startTestServer(options: StartOptions = {}): Promise<TestServer> {
  const workerPath = await buildWorker();
  const script = readFileSync(workerPath, 'utf-8');
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
    compatibilityDate: '2025-11-05',
    compatibilityFlags: ['nodejs_compat'],
    r2Buckets: ['DICTIONARY', 'ASSETS', 'FONTS'],
    bindings: {
      ASSET_BASE_URL: 'https://r2-assets.test.local',
      DICTIONARY_BASE_URL: 'https://r2-dictionary.test.local',
    },
    verbose: false,
  };

  if (options.port != null) {
    mfConfig.port = options.port;
  }

  if (wantAssets) {
    mfConfig.assets = {
      binding: 'SITE_ASSETS',
      directory: DIST_CLIENT,
      routerConfig: {
        has_user_worker: true,
        invoke_user_worker_ahead_of_assets: false,
        static_routing: {
          user_worker: ['/*', '!/fonts/*', '!/manifest.json'],
        },
      },
    };
  }

  const mf = new Miniflare(mfConfig);

  const url = await mf.ready;

  const fixtures = collectAllFixtures();
  await Promise.all([
    seedBucket(mf, 'DICTIONARY', fixtures),
    seedBucket(mf, 'ASSETS', fixtures),
    seedBucket(mf, 'FONTS', fixtures),
  ]);

  const stop = async () => {
    await mf.dispose();
  };

  return { mf, url, dispatchFetch: mf.dispatchFetch.bind(mf), stop };
}

// Re-export Miniflare types/helpers the integration tests need.
export { MFResponse };
