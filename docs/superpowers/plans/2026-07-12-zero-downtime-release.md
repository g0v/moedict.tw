# Zero-Downtime Release — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement two-phase zero-downtime deployment (A: gradual version upload with probes/rollback) plus durable R2 release fallback (B: structural elimination of shell→null→404), replacing the unsafe atomic `wrangler deploy` cutover.

**Architecture:** A uses Cloudflare Workers Versions API (`wrangler versions upload/deploy`) for traffic splitting with automatic rollback on probe failure. B adds an R2-backed fallback layer in the Worker: when `SITE_ASSETS.fetch('/')` fails, serve `index.html` from `releases/<tag>/` in the environment's `ASSETS` R2 bucket; if both fail, return a self-contained 503 (never 404). Content-hashed assets are also copied to a global `immutable/assets/` R2 path so a new Worker can satisfy old hashed URLs without knowing the old release ID.

**Tech Stack:** Cloudflare Workers, R2, Workers Versions API, Wrangler CLI, TypeScript, Vitest (unit/integration), Playwright (e2e), Bun, Vite+

**Specification:** `docs/superpowers/specs/2026-07-12-zero-downtime-release-design.md`

## Global Constraints

- The approved specification is `docs/superpowers/specs/2026-07-12-zero-downtime-release-design.md`. All implementation must conform to it.
- **No `cross_version_cache`** — do not implement any cross-version cache coordination.
- **No automatic R2 GC in v1** — retain immutable assets and release trees indefinitely. Document future lifecycle assessment, do NOT deliver a TODO.
- **Never return 404 for HTML shell routes** — both `SITE_ASSETS` and R2 failure must produce a self-contained 503 with `Retry-After` and auto-refresh.
- **Never use staging public `ASSET_BASE_URL` for release fallback** — R2 release fallback uses the environment's own `ASSETS` binding (preview bucket for staging, prod bucket for production), discovered from the generated wrangler config.
- **Release ID is not embedded in the client bundle** — it is computed from build outputs and passed via `CF_VERSION_METADATA` binding at deploy time.
- **Staging and prod build separately** — `CLOUDFLARE_ENV` is build-time. Production requires staging approval (same git SHA + client manifest digest equality) plus re-built prod digest equality.
- **Coverage remains 100%** and `/* v8 ignore */` cap remains 20.
- **TDD Red/Green per task** — write failing tests first, then implement to pass.
- **No `wrangler deploy`** — the existing `deploy`/`deploy:staging` scripts must be replaced with the safe orchestrator or become guard failures. No unsafe legacy deploy path left under standard commands.
- **Preserve legacy behavior** — existing asset fallback (R2 `ASSETS` for badge/appcache, `ASSET_BASE_URL` proxy for `/assets/*`) must continue to work. New R2 release fallback is an additional layer, not a replacement.
- **Stream R2 bodies** — never `await object.text()` for asset responses. Shell HTML (~3KB) may use `.text()` for head injection.
- **No secret data in logs** — structured shell-miss log contains only pathname, CF-Ray, version/release, SITE_ASSETS result, R2 key/result, final source/status.

---

### Task 1: Runtime R2 Fallback + Metadata (Worker)

**Files:**

- Modify: `worker/index.ts` (shell flow, asset flow, version headers, 503 recovery, structured logging)
- Modify: `src/api/cache.ts` (new cache control constants for immutable assets, 503 recovery)
- Modify: `wrangler.jsonc` (add `version_metadata` binding)
- Create: `src/api/release-fallback.ts` (R2 fallback logic, extracted for testability)
- Create: `tests/unit/release-fallback.test.ts` (direct-call unit tests)
- Modify: `tests/unit/worker-dispatch.test.ts` (new dispatch paths, version headers, 503)
- Modify: `tests/integration/api-legacy-assets.test.ts` (R2 fallback with Miniflare R2)

**Interfaces:**

- Consumes: `env.SITE_ASSETS` (Fetcher), `env.ASSETS` (R2Bucket), `env.CF_VERSION_METADATA` (version_metadata binding: `{ id: string; tag: string; timestamp: string }` or undefined)
- Produces: HTML shell responses with `X-Moedict-Version`, `X-Moedict-Release`, `X-Moedict-Shell-Source` headers; 503 recovery response when all sources fail; R2 asset fallback with `X-Moedict-Asset-Source` header

- [ ] **Step 1: Write failing tests for version metadata guard**

Create `tests/unit/release-fallback.test.ts`. Write tests for:

```typescript
describe("getVersionTag", () => {
  it("returns tag when CF_VERSION_METADATA is present with non-empty tag", () => {
    // env.CF_VERSION_METADATA = { id: "uuid-123", tag: "abc123-def456", timestamp: "..." }
    // expect getVersionTag(env) === "abc123-def456"
  });
  it("returns 'unknown' when CF_VERSION_METADATA is undefined", () => {
    // env.CF_VERSION_METADATA = undefined
    // expect getVersionTag(env) === "unknown"
  });
  it("returns 'unknown' when CF_VERSION_METADATA.tag is empty string", () => {
    // env.CF_VERSION_METADATA = { id: "x", tag: "", timestamp: "..." }
    // expect getVersionTag(env) === "unknown"
  });
  it("returns 'unknown' when CF_VERSION_METADATA is null", () => {
    // env.CF_VERSION_METADATA = null
    // expect getVersionTag(env) === "unknown"
  });
});
```

**RED expectation:** Import fails (module doesn't exist yet).  
**Test command:** `bun run test:unit -- tests/unit/release-fallback.test.ts`

- [ ] **Step 2: Implement `getVersionTag` and `getVersionHeaders`**

Create `src/api/release-fallback.ts`:

```typescript
export interface VersionMetadata {
  id: string;
  tag: string;
  timestamp: string;
}

export function getVersionTag(metadata: VersionMetadata | undefined | null): string {
  if (!metadata || typeof metadata.tag !== "string" || metadata.tag === "") {
    return "unknown";
  }
  return metadata.tag;
}

export function getVersionHeaders(
  metadata: VersionMetadata | undefined | null,
): Record<string, string> {
  const tag = getVersionTag(metadata);
  return {
    "X-Moedict-Version": tag,
    "X-Moedict-Release": tag,
  };
}
```

**GREEN expectation:** All 4 tests pass.  
**Test command:** `bun run test:unit -- tests/unit/release-fallback.test.ts`

- [ ] **Step 3: Write failing tests for R2 shell fallback**

```typescript
describe("renderHtmlShellWithFallback", () => {
  it("serves from SITE_ASSETS when OK, source=site-assets", async () => {
    // SITE_ASSETS.fetch("/") returns 200 with HTML
    // expect response.status === 200
    // expect response.headers.get("X-Moedict-Shell-Source") === "site-assets"
  });
  it("falls back to R2 when SITE_ASSETS returns non-OK, source=r2-release", async () => {
    // SITE_ASSETS.fetch("/") returns 500
    // env.ASSETS.get("releases/<tag>/index.html") returns R2 object with HTML
    // expect response.status === 200
    // expect response.headers.get("X-Moedict-Shell-Source") === "r2-release"
  });
  it("falls back to R2 when SITE_ASSETS throws, source=r2-release", async () => {
    // SITE_ASSETS.fetch throws
    // env.ASSETS.get("releases/<tag>/index.html") returns R2 object
    // expect response.status === 200, source === "r2-release"
  });
  it("falls back to R2 when SITE_ASSETS fetcher is null, source=r2-release", async () => {
    // env.SITE_ASSETS = undefined
    // env.ASSETS.get returns R2 object
    // expect source === "r2-release"
  });
  it("returns 503 recovery when both SITE_ASSETS and R2 fail", async () => {
    // SITE_ASSETS returns 500, R2 returns null
    // expect response.status === 503
    // expect response.headers.get("Cache-Control") === "no-store"
    // expect response.headers.get("Retry-After") === "5"
    // expect response.headers.get("X-Moedict-Shell-Source") === "recovery"
    // expect body contains "<meta http-equiv=\"refresh\" content=\"5\">"
  });
  it("returns 503 recovery when R2 throws", async () => {
    // SITE_ASSETS returns 500, R2.get throws
    // expect response.status === 503, source === "recovery"
  });
  it("injects head metadata into R2-served shell", async () => {
    // R2 shell HTML has <title>placeholder</title>
    // After injection, title matches resolveHeadByPath for pathname
  });
  it("handles HEAD request for R2 shell fallback", async () => {
    // request.method = "HEAD"
    // expect response.status === 200, body is null
  });
  it("uses 'unknown' as R2 key when version tag is undefined", async () => {
    // env.CF_VERSION_METADATA = undefined
    // SITE_ASSETS returns 500
    // R2.get("releases/unknown/index.html") returns object
    // expect source === "r2-release"
  });
});
```

**RED expectation:** Import of `renderHtmlShellWithFallback` fails.  
**Test command:** `bun run test:unit -- tests/unit/release-fallback.test.ts`

- [ ] **Step 4: Implement `renderHtmlShellWithFallback`**

In `src/api/release-fallback.ts`, implement the full shell fallback flow:

1. Try `SITE_ASSETS.fetch("/")` → if OK, inject head metadata, set `X-Moedict-Shell-Source: site-assets`, return.
2. On non-OK/throw, try `env.ASSETS.get("releases/<tag>/index.html")` → if found, inject head metadata, set `X-Moedict-Shell-Source: r2-release`, return.
3. Both fail → return 503 recovery with `no-store`, `Retry-After: 5`, auto-refresh meta, `X-Moedict-Shell-Source: recovery`.
4. Log structured shell-miss event on SITE_ASSETS failure.
5. Set `X-Moedict-Version` and `X-Moedict-Release` on all responses.

Extract from `worker/index.ts` the existing `injectHeadMetadata` function (or import it). Use `CACHE_CONTROL.htmlShell` for R2-served shell.

**GREEN expectation:** All shell fallback tests pass.  
**Test command:** `bun run test:unit -- tests/unit/release-fallback.test.ts`

- [ ] **Step 5: Write failing tests for R2 asset fallback**

```typescript
describe("serveAssetWithFallback", () => {
  it("serves from SITE_ASSETS when OK (unchanged fast path)", async () => {
    // SITE_ASSETS.fetch returns 200
    // expect response.status === 200
  });
  it("falls back to R2 current release for non-hashed /assets/* path", async () => {
    // SITE_ASSETS returns 404
    // env.ASSETS.get("releases/<tag>/assets/styles.css") returns object
    // expect X-Moedict-Asset-Source === "r2-release"
  });
  it("falls back to R2 global immutable for hashed /assets/* path", async () => {
    // SITE_ASSETS returns 404
    // env.ASSETS.get("releases/<tag>/assets/index-XXXX.js") returns null
    // env.ASSETS.get("immutable/assets/assets/index-XXXX.js") returns object
    // expect X-Moedict-Asset-Source === "r2-immutable"
  });
  it("falls back to legacy ASSET_BASE_URL proxy when all R2 fails", async () => {
    // SITE_ASSETS returns 404
    // R2 current release returns null
    // R2 immutable returns null
    // fetch(ASSET_BASE_URL/...) returns 200
    // expect response.status === 200 (legacy behavior preserved)
  });
  it("returns 304 on If-None-Match match for R2 object", async () => {
    // request.headers["If-None-Match"] = R2 object's httpEtag
    // expect response.status === 304
  });
  it("handles HEAD request for R2 asset", async () => {
    // request.method = "HEAD"
    // expect response.status === 200, body is null
  });
  it("sets immutable cache for hashed assets from R2", async () => {
    // R2 immutable object served
    // expect Cache-Control contains "immutable"
  });
  it("sets no-store for R2 misses", async () => {
    // R2 returns null, falls to legacy proxy
    // legacy proxy also fails
    // expect Cache-Control === "no-store" on miss response
  });
});
```

**RED expectation:** Import of `serveAssetWithFallback` fails.  
**Test command:** `bun run test:unit -- tests/unit/release-fallback.test.ts`

- [ ] **Step 6: Implement `serveAssetWithFallback`**

In `src/api/release-fallback.ts`, implement the asset fallback chain:

1. `SITE_ASSETS.fetch(request)` → if OK, return (fast path, unchanged).
2. R2 current release: `env.ASSETS.get("releases/<tag>/<relative-path>")` → if found, serve with `X-Moedict-Asset-Source: r2-release`.
3. R2 global immutable (for `/assets/*` hashed paths only): `env.ASSETS.get("immutable/assets/<relative-path>")` → if found, serve with immutable cache + `X-Moedict-Asset-Source: r2-immutable`.
4. Legacy fallback: existing `ASSET_BASE_URL` proxy (unchanged).
5. R2 responses: `writeHttpMetadata`, ETag/If-None-Match 304, HEAD, CORS, cache headers.
6. Stream bodies: `new Response(object.body, ...)` — never `await object.text()` for assets.

**GREEN expectation:** All asset fallback tests pass.  
**Test command:** `bun run test:unit -- tests/unit/release-fallback.test.ts`

- [ ] **Step 7: Write failing tests for 503 recovery response**

```typescript
describe("createRecoveryResponse", () => {
  it("returns 503 with no-store, Retry-After, and auto-refresh meta", () => {
    // const res = createRecoveryResponse("unknown");
    // expect res.status === 503
    // expect res.headers.get("Cache-Control") === "no-store"
    // expect res.headers.get("Retry-After") === "5"
    // expect res.headers.get("X-Moedict-Shell-Source") === "recovery"
    // expect await res.text() contains "<meta http-equiv=\"refresh\" content=\"5\">"
  });
  it("includes version headers", () => {
    // const res = createRecoveryResponse("abc123-def456");
    // expect res.headers.get("X-Moedict-Version") === "abc123-def456"
  });
  it("body is self-contained HTML (no external deps)", () => {
    // body does not contain "<link" or "<script src"
  });
});
```

**RED expectation:** `createRecoveryResponse` not exported.  
**Test command:** `bun run test:unit -- tests/unit/release-fallback.test.ts`

- [ ] **Step 8: Implement `createRecoveryResponse`**

```typescript
export function createRecoveryResponse(versionTag: string): Response {
  const html = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>萌典 — 服務暫時無法使用</title><style>body{font-family:system-ui,sans-serif;text-align:center;padding:3rem;color:#333}h1{font-size:1.5rem}p{color:#666}</style></head><body><h1>萌典服務暫時無法使用</h1><p>正在自動重試，請稍候…</p></body></html>`;
  return new Response(html, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "5",
      "X-Moedict-Shell-Source": "recovery",
      "X-Moedict-Version": versionTag,
      "X-Moedict-Release": versionTag,
    },
  });
}
```

**GREEN expectation:** All recovery tests pass.  
**Test command:** `bun run test:unit -- tests/unit/release-fallback.test.ts`

- [ ] **Step 9: Write failing tests for structured shell-miss logging**

```typescript
describe("shell-miss structured logging", () => {
  it("logs JSON with event, pathname, version, siteAssetsResult, r2Result, finalSource", async () => {
    // const logs: string[] = [];
    // vi.spyOn(console, "log").mockImplementation((msg) => logs.push(msg));
    // Trigger shell miss (SITE_ASSETS 500, R2 hit)
    // const logEntry = JSON.parse(logs.find(l => l.includes('"shell-miss"'))!);
    // expect logEntry.event === "shell-miss"
    // expect logEntry.pathname === "/"
    // expect logEntry.version === "abc123-def456"
    // expect logEntry.siteAssetsResult === "non-ok"
    // expect logEntry.r2Result === "hit"
    // expect logEntry.finalSource === "r2-release"
  });
  it("does not log when SITE_ASSETS succeeds", async () => {
    // SITE_ASSETS returns 200
    // expect no log entry with "shell-miss"
  });
  it("logs siteAssetsResult='throw' when SITE_ASSETS throws", async () => {
    // SITE_ASSETS.fetch throws
    // expect logEntry.siteAssetsResult === "throw"
  });
  it("logs r2Result='miss' when R2 returns null", async () => {
    // R2 returns null
    // expect logEntry.r2Result === "miss"
    // expect logEntry.finalSource === "recovery"
  });
});
```

**RED expectation:** No structured log is emitted.  
**Test command:** `bun run test:unit -- tests/unit/release-fallback.test.ts`

- [ ] **Step 10: Implement structured shell-miss logging**

In `renderHtmlShellWithFallback`, when `SITE_ASSETS` fails, emit:

```typescript
console.log(
  JSON.stringify({
    event: "shell-miss",
    pathname,
    cfRay: request.headers.get("cf-ray") ?? "",
    version: versionTag,
    release: versionTag,
    siteAssetsResult: siteAssetsOk ? "ok" : siteAssetsThrew ? "throw" : "non-ok",
    siteAssetsStatus: siteAssetsStatus,
    r2Key: `releases/${versionTag}/index.html`,
    r2Result: r2Object ? "hit" : r2Threw ? "throw" : "miss",
    finalSource: finalSource,
    finalStatus: finalStatus,
  }),
);
```

No secret data in logs.

**GREEN expectation:** All logging tests pass.  
**Test command:** `bun run test:unit -- tests/unit/release-fallback.test.ts`

- [ ] **Step 11: Wire fallback into `worker/index.ts` dispatch**

Modify `worker/index.ts`:

1. Add `CF_VERSION_METADATA` to the `Env` interface:
   ```typescript
   CF_VERSION_METADATA?: VersionMetadata;
   ```
2. Replace `renderHtmlShell` call in `dispatch()` with `renderHtmlShellWithFallback`.
3. Replace `passThroughAssets` with `serveAssetWithFallback` for the asset flow.
4. Add version headers to all Worker responses (API, static, shell, 503).
5. Remove the old `renderHtmlShell` function (replaced by `renderHtmlShellWithFallback`).
6. Remove the old `passThroughAssets` and `getAssetFromBucket` functions (replaced by `serveAssetWithFallback`).
7. Preserve all existing legacy behavior (badge, appcache, ASSET_BASE_URL proxy, PNG generation).

**Test command:** `bun run test:unit -- tests/unit/worker-dispatch.test.ts tests/unit/release-fallback.test.ts`

- [ ] **Step 12: Add `version_metadata` binding to `wrangler.jsonc`**

Add to the top level of `wrangler.jsonc` (not inside `env`):

```jsonc
"version_metadata": {
  "binding": "CF_VERSION_METADATA",
  "type": "json"
}
```

Also add to `env.staging` (version_metadata does NOT inherit per Cloudflare rules).

- [ ] **Step 13: Update existing dispatch tests for new headers**

Modify `tests/unit/worker-dispatch.test.ts`:

1. Add `CF_VERSION_METADATA: { id: "test-uuid", tag: "test-tag", timestamp: "2026-07-12T00:00:00Z" }` to `makeEnv`.
2. Verify `X-Moedict-Version` header on all responses.
3. Verify `X-Moedict-Shell-Source` on shell responses.
4. Verify 503 recovery when both SITE_ASSETS and R2 fail (new test).
5. Verify legacy behavior still works (existing tests should pass with updated env).

**Test command:** `bun run test:unit -- tests/unit/worker-dispatch.test.ts`

- [ ] **Step 14: Add integration tests for R2 fallback**

Modify `tests/integration/api-legacy-assets.test.ts` (or create new):

1. Seed R2 `ASSETS` bucket with `releases/<tag>/index.html` in test setup.
2. Test: SITE_ASSETS miss → R2 shell served with correct headers.
3. Test: R2 asset fallback for `/assets/*` path.
4. Test: 304 If-None-Match with real R2 ETag.
5. Test: HEAD request with R2.

**Test command:** `bun run test:integration -- tests/integration/api-legacy-assets.test.ts`

- [ ] **Step 15: Run full test suite and verify coverage**

```bash
bun run lint
bun run typecheck
bun run build
bun run test:unit
bun run test:integration
```

Verify coverage is 100% and no new `/* v8 ignore */` is needed (or within cap of 20).

- [ ] **Step 16: Commit Task 1**

```bash
git add -A
git commit -m "feat: runtime R2 fallback + version metadata (Task 1)"
```

---

### Task 2: Deterministic Release Publication / Verification Library + CLI

**Files:**

- Create: `scripts/lib/release-manifest.mjs` (manifest generation, deterministic SHA-256, release ID)
- Create: `scripts/lib/generated-config.mjs` (parse generated wrangler config, bucket selection)
- Create: `scripts/lib/r2-upload.mjs` (R2 upload with ≤4 concurrency, 429 backoff)
- Create: `scripts/release-publish.mjs` (publish CLI: upload all files, manifest last)
- Create: `scripts/release-verify.mjs` (verify CLI: re-GET every object, compare hash)
- Create: `tests/unit/release-manifest.test.ts`
- Create: `tests/unit/generated-config.test.ts`
- Create: `tests/unit/r2-upload.test.ts`

**Interfaces:**

- Consumes: `dist/client/**` (build output), `dist/cf_moedict_webkit_neo/.vite/manifest.json` (Vite manifest), `dist/cf_moedict_webkit_neo/wrangler.json` (generated config), `CLOUDFLARE_ENV` env var
- Produces: R2 objects under `releases/<id>/` and `immutable/assets/`, `release-manifest.json`

- [ ] **Step 1: Write failing tests for release manifest generation**

Create `tests/unit/release-manifest.test.ts`:

```typescript
describe("computeReleaseId", () => {
  it("produces <git-short-sha>-<first12-of-manifest-sha256>", () => {
    // Mock git short SHA as "abc1234"
    // Mock manifest JSON as { "b": {...}, "a": {...} }
    // Deterministic sorted: JSON.stringify({ a: ..., b: ... }, sortedKeys)
    // SHA-256 of that, first 12 hex chars
    // expect result === "abc1234-<first12hex>"
  });
  it("sorts manifest keys deterministically before hashing", () => {
    // Same manifest with different key order → same digest
  });
  it("uses stable JSON stringification (no spaces, sorted keys recursively)", () => {
    // Nested objects are also sorted
  });
});

describe("buildReleaseManifest", () => {
  it("lists all files under dist/client/ with relative paths", () => {
    // Mock fs with dist/client/index.html, dist/client/assets/index-XX.js
    // expect manifest.files contains "index.html", "assets/index-XX.js"
  });
  it("includes id, gitSha, clientManifestDigest, createdAt", () => {
    // expect manifest has all required fields
  });
});
```

**RED expectation:** Module doesn't exist.  
**Test command:** `bun run test:unit -- tests/unit/release-manifest.test.ts`

- [ ] **Step 2: Implement `release-manifest.mjs`**

```javascript
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

export function deterministicStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(deterministicStringify).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return (
    "{" + keys.map((k) => JSON.stringify(k) + ":" + deterministicStringify(obj[k])).join(",") + "}"
  );
}

export function computeClientManifestDigest(manifestJson) {
  const parsed = JSON.parse(manifestJson);
  const stable = deterministicStringify(parsed);
  return createHash("sha256").update(stable).digest("hex").slice(0, 12);
}

export function getGitShortSha() {
  return execSync("git rev-parse --short HEAD").toString().trim();
}

export function computeReleaseId(gitShortSha, clientManifestDigest) {
  return `${gitShortSha}-${clientManifestDigest}`;
}
```

**GREEN expectation:** All manifest tests pass.  
**Test command:** `bun run test:unit -- tests/unit/release-manifest.test.ts`

- [ ] **Step 3: Write failing tests for generated config parsing**

```typescript
describe("parseGeneratedConfig", () => {
  it("reads dist/cf_moedict_webkit_neo/wrangler.json", () => {
    // Mock fs with generated config
    // expect parsed.name === "cf-moedict-webkit-neo"
  });
  it("extracts ASSETS bucket name for production", () => {
    // CLOUDFLARE_ENV not set → production
    // expect bucketName === "moedict-assets"
  });
  it("extracts ASSETS preview bucket name for staging", () => {
    // CLOUDFLARE_ENV=staging
    // expect bucketName === "moedict-assets-preview"
  });
  it("extracts worker name", () => {
    // expect workerName === "cf-moedict-webkit-neo"
  });
  it("throws if generated config not found", () => {
    // expect throws with clear message
  });
});
```

**RED expectation:** Module doesn't exist.  
**Test command:** `bun run test:unit -- tests/unit/generated-config.test.ts`

- [ ] **Step 4: Implement `generated-config.mjs`**

```javascript
import { readFileSync } from "node:fs";

export function parseGeneratedConfig(configPath) {
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw);
}

export function getAssetsBucketName(config, env) {
  const binding = config.r2_buckets?.find((b) => b.binding === "ASSETS");
  if (!binding) throw new Error("ASSETS binding not found in generated config");
  if (env === "staging") return binding.preview_bucket_name ?? binding.bucket_name;
  return binding.bucket_name;
}

export function getWorkerName(config) {
  return config.name;
}
```

**GREEN expectation:** All config tests pass.  
**Test command:** `bun run test:unit -- tests/unit/generated-config.test.ts`

- [ ] **Step 5: Write failing tests for R2 upload with concurrency and backoff**

```typescript
describe("uploadWithConcurrency", () => {
  it("uploads all files with max 4 concurrent", async () => {
    // Mock subprocess adapter: track max concurrent calls
    // Upload 10 files
    // expect maxConcurrent <= 4
  });
  it("retries on 429 with exponential backoff", async () => {
    // Mock: first 2 calls return 429, third succeeds
    // expect retry called with 1s, 2s delays
    // expect final result success
  });
  it("aborts after 5 retries on persistent 429", async () => {
    // All calls return 429
    // expect throws after 5 retries
  });
  it("uploads with correct --content-type, --cache-control, --remote flags", async () => {
    // Mock subprocess: capture command args
    // expect command includes --remote, --content-type, --cache-control
  });
  it("uploads manifest last only after all objects succeed", async () => {
    // If any object fails, manifest is not uploaded
    // expect manifest upload not called
  });
});
```

**RED expectation:** Module doesn't exist.  
**Test command:** `bun run test:unit -- tests/unit/r2-upload.test.ts`

- [ ] **Step 6: Implement `r2-upload.mjs`**

Implement:

- `uploadObject(bucketName, key, filePath, metadata)` — calls `wrangler r2 object put <bucket>/<key> --file=<path> --remote --content-type=<ct> --cache-control=<cc>`
- `uploadWithConcurrency(files, bucketName, maxConcurrent=4)` — bounded concurrency pool
- `retryWithBackoff(fn, maxRetries=5, initialDelay=1000, maxDelay=60000)` — exponential backoff on 429
- `uploadReleaseToR2(releaseId, distClientDir, bucketName, immutableAssetsDir)` — uploads all files, manifest last

**GREEN expectation:** All upload tests pass.  
**Test command:** `bun run test:unit -- tests/unit/r2-upload.test.ts`

- [ ] **Step 7: Write failing tests for verification**

```typescript
describe("verifyRelease", () => {
  it("re-GETs every object and compares SHA-256 hash", async () => {
    // Mock fetch: return matching hash for all objects
    // expect verification passes
  });
  it("aborts on hash mismatch", async () => {
    // Mock fetch: return different hash for one object
    // expect throws with key name in error
  });
  it("aborts on missing object (404)", async () => {
    // Mock fetch: return 404 for one object
    // expect throws
  });
  it("verifies manifest.json exists and parses", async () => {
    // expect manifest fetch and parse succeeds
  });
  it("verifies all files listed in manifest exist", async () => {
    // Manifest lists 5 files, only 4 exist
    // expect throws with missing file name
  });
});
```

**RED expectation:** Module doesn't exist.  
**Test command:** `bun run test:unit -- tests/unit/r2-upload.test.ts` (or new test file)

- [ ] **Step 8: Implement `release-verify.mjs`**

```javascript
export async function verifyRelease(bucketName, releaseId, manifest) {
  for (const file of manifest.files) {
    const key = `releases/${releaseId}/${file.path}`;
    const response = await fetchR2Object(bucketName, key);
    if (!response.ok) throw new Error(`Missing object: ${key}`);
    const hash = createHash("sha256")
      .update(await response.text())
      .digest("hex");
    if (hash !== file.sha256) throw new Error(`Hash mismatch: ${key}`);
  }
  // Verify manifest itself
  const manifestKey = `releases/${releaseId}/release-manifest.json`;
  const manifestResp = await fetchR2Object(bucketName, manifestKey);
  if (!manifestResp.ok) throw new Error(`Missing manifest: ${manifestKey}`);
}
```

**GREEN expectation:** All verification tests pass.  
**Test command:** `bun run test:unit -- tests/unit/r2-upload.test.ts`

- [ ] **Step 9: Implement `release-publish.mjs` CLI**

Create `scripts/release-publish.mjs`:

```bash
# Usage: node scripts/release-publish.mjs
# Reads CLOUDFLARE_ENV, builds release ID, uploads to R2, verifies
```

Steps:

1. Read `CLOUDFLARE_ENV` (default: production).
2. Read generated config from `dist/cf_moedict_webkit_neo/wrangler.json`.
3. Compute release ID from git SHA + client manifest digest.
4. Upload all `dist/client/**` to `releases/<id>/<relative-path>`.
5. Copy content-hashed `dist/client/assets/**` to `immutable/assets/<relative-path>`.
6. Upload `release-manifest.json` last.
7. Verify all objects.

- [ ] **Step 10: Run full test suite**

```bash
bun run lint
bun run typecheck
bun run build
bun run test:unit
bun run test:integration
```

- [ ] **Step 11: Commit Task 2**

```bash
git add -A
git commit -m "feat: deterministic release publication and verification (Task 2)"
```

---

### Task 3: Two-Phase Deployment Orchestrator / Safety Gates

**Files:**

- Create: `scripts/lib/wrangler-versions.mjs` (wrangler versions API wrapper)
- Create: `scripts/lib/deployment-state.mjs` (`.wrangler/releases/` state)
- Create: `scripts/lib/smoke-probe.mjs` (version-override smoke + continuous probe)
- Create: `scripts/release-deploy.mjs` (orchestrator CLI)
- Create: `tests/unit/wrangler-versions.test.ts`
- Create: `tests/unit/deployment-state.test.ts`
- Create: `tests/unit/smoke-probe.test.ts`
- Create: `tests/unit/release-deploy.test.ts`

**Interfaces:**

- Consumes: `wrangler versions upload/deploy/list --json`, `wrangler deployments list --json`, `Cloudflare-Workers-Version-Overrides` request header, `.wrangler/releases/` state files
- Produces: Two-phase deployment with 0% smoke → 100% promote → continuous probes → rollback on failure

- [ ] **Step 1: Write failing tests for wrangler versions wrapper**

```typescript
describe("uploadVersion", () => {
  it("calls wrangler versions upload with --config, --tag, correct path", async () => {
    // Mock subprocess: capture command
    // expect command: wrangler versions upload --config <generated> --tag <release-id>
  });
  it("returns version UUID from JSON output", async () => {
    // Mock subprocess: return JSON with id field
    // expect returned UUID matches
  });
  it("aborts if wrangler rejects version_metadata binding", async () => {
    // Mock subprocess: return error about unknown binding
    // expect throws with clear "bootstrap experiment" message
  });
});

describe("deployVersionSplit", () => {
  it("calls wrangler versions deploy with --version-tag and --percentage", async () => {
    // expect command: wrangler versions deploy --config <generated> --version-tag <tag> --percentage 0
  });
  it("deploys new@0 old@100 for phase 1", async () => {
    // expect percentage=0 for new version
  });
  it("deploys new@100 for phase 2 promotion", async () => {
    // expect percentage=100 for new version
  });
  it("rolls back with old@100 on probe failure", async () => {
    // expect command: wrangler versions deploy --version-id <old-uuid> --percentage 100
  });
});

describe("listVersions", () => {
  it("calls wrangler versions list --json and parses result", async () => {
    // Mock subprocess: return JSON array
    // expect parsed array of version objects
  });
  it("finds current 100% version from deployments list", async () => {
    // Mock: deployment with one version at 100%
    // expect found version UUID
  });
  it("aborts if not exactly one version at 100%", async () => {
    // Mock: deployment with split traffic (50/50)
    // expect throws "cannot safely deploy from split state"
  });
});
```

**RED expectation:** Module doesn't exist.  
**Test command:** `bun run test:unit -- tests/unit/wrangler-versions.test.ts`

- [ ] **Step 2: Implement `wrangler-versions.mjs`**

Functions:

- `uploadVersion(configPath, tag)` → `wrangler versions upload --config <configPath> --tag <tag> --json`
- `deployVersionSplit(configPath, versionTag, percentage)` → `wrangler versions deploy --config <configPath> --version-tag <versionTag> --percentage <percentage> -y`
- `rollbackToVersion(configPath, versionId)` → `wrangler versions deploy --config <configPath> --version-id <versionId> --percentage 100 -y`
- `listVersions(configPath, workerName)` → `wrangler versions list --config <configPath> --name <workerName> --json`
- `getCurrentDeployment(configPath, workerName)` → `wrangler deployments list --config <configPath> --name <workerName> --json`
- `requireSingleVersion100(deployments)` → throws if not exactly one version at 100%

**GREEN expectation:** All version wrapper tests pass.  
**Test command:** `bun run test:unit -- tests/unit/wrangler-versions.test.ts`

- [ ] **Step 3: Write failing tests for deployment state**

```typescript
describe("deployment-state", () => {
  it("writes current deployment state to .wrangler/releases/current.json", () => {
    // saveCurrentDeployment({ workerName, versionId, tag, percentage, deployedAt })
    // expect file exists and parses
  });
  it("reads current deployment state", () => {
    // expect readCurrentDeployment() returns saved state
  });
  it("appends to versions history", () => {
    // saveVersionEntry({ versionId, tag, uploadedAt, status })
    // expect versions.json contains entry
  });
  it("returns null when state file does not exist", () => {
    // expect readCurrentDeployment() === null
  });
  it("records staging approval state", () => {
    // saveStagingApproval({ gitSha, clientManifestDigest, approvedAt })
    // expect readStagingApproval() returns saved state
  });
  it("checks staging approval gate: same git SHA + digest equality", () => {
    // expect checkStagingApprovalGate(prodState, stagingState) === true/false
  });
});
```

**RED expectation:** Module doesn't exist.  
**Test command:** `bun run test:unit -- tests/unit/deployment-state.test.ts`

- [ ] **Step 4: Implement `deployment-state.mjs`**

Functions:

- `saveCurrentDeployment(state)` → write `.wrangler/releases/current.json`
- `readCurrentDeployment()` → read `.wrangler/releases/current.json`
- `saveVersionEntry(entry)` → append to `.wrangler/releases/versions.json`
- `saveStagingApproval(state)` → write `.wrangler/releases/staging-approval.json`
- `readStagingApproval()` → read `.wrangler/releases/staging-approval.json`
- `checkStagingApprovalGate(prodGitSha, prodDigest, stagingState)` → boolean

**GREEN expectation:** All state tests pass.  
**Test command:** `bun run test:unit -- tests/unit/deployment-state.test.ts`

- [ ] **Step 5: Write failing tests for smoke probe with version override**

```typescript
describe("smokeWithVersionOverride", () => {
  it("sends Cloudflare-Workers-Version-Overrides header with exact worker name and UUID", async () => {
    // Mock fetch: capture request headers
    // expect header: "cf-moedict-webkit-neo=\"<uuid>\""
  });
  it("requires 200 response status", async () => {
    // Mock: return 500
    // expect probe fails
  });
  it("requires X-Moedict-Version header matching release tag", async () => {
    // Mock: return 200 but missing X-Moedict-Version
    // expect probe fails
  });
  it("probes all critical routes: /, /api/config, /api/<word>.json, /assets/*", async () => {
    // Mock: all return 200 with version header
    // expect all probes pass
  });
  it("aborts on any route failure", async () => {
    // Mock: one route returns 500
    // expect smoke fails with route name in error
  });
});

describe("continuousProbe", () => {
  it("probes every 5 seconds", async () => {
    // Mock: track call intervals
    // expect ~5s between probes
  });
  it("returns failure on first non-200", async () => {
    // Mock: first 3 probes OK, 4th returns 500
    // expect failure
  });
  it("returns failure on first thrown error", async () => {
    // Mock: 2nd probe throws
    // expect failure
  });
  it("returns success after duration elapses with all probes OK", async () => {
    // Mock: all probes return 200
    // expect success after 120s (mocked)
  });
});
```

**RED expectation:** Module doesn't exist.  
**Test command:** `bun run test:unit -- tests/unit/smoke-probe.test.ts`

- [ ] **Step 6: Implement `smoke-probe.mjs`**

Functions:

- `smokeWithVersionOverride(url, workerName, versionUuid, routes)` — probe all routes with `Cloudflare-Workers-Version-Overrides` header, require 200 + `X-Moedict-Version` on each
- `continuousProbe(url, routes, durationMs, intervalMs=5000)` — probe continuously, return on first failure or after duration

**GREEN expectation:** All smoke probe tests pass.  
**Test command:** `bun run test:unit -- tests/unit/smoke-probe.test.ts`

- [ ] **Step 7: Write failing tests for deployment orchestrator**

```typescript
describe("releaseDeployOrchestrator", () => {
  it("requires one old version at 100% before starting", async () => {
    // Mock: deployments list shows split traffic
    // expect aborts
  });
  it("uploads new version with --tag <release-id>", async () => {
    // Mock: capture upload command
    // expect --tag matches release ID
  });
  it("deploys new@0 old@100 for phase 1", async () => {
    // Mock: capture deploy command
    // expect percentage=0
  });
  it("smokes with version override header before promotion", async () => {
    // Mock: smoke probe called with correct header
  });
  it("aborts promotion if smoke fails", async () => {
    // Mock: smoke returns failure
    // expect no promotion deploy
  });
  it("promotes to new@100 for phase 2", async () => {
    // Mock: capture deploy command
    // expect percentage=100
  });
  it("rolls back on continuous probe failure", async () => {
    // Mock: probe returns failure
    // expect rollback deploy with old UUID at 100%
  });
  it("soaks for 120s after promotion", async () => {
    // Mock: track time
    // expect soak duration >= 120s
  });
  it("checks staging approval gate before prod deploy", async () => {
    // Mock: staging approval with different git SHA
    // expect abort
  });
  it("checks client manifest digest equality before prod deploy", async () => {
    // Mock: staging digest != prod digest
    // expect abort
  });
});
```

**RED expectation:** Module doesn't exist.  
**Test command:** `bun run test:unit -- tests/unit/release-deploy.test.ts`

- [ ] **Step 8: Implement `release-deploy.mjs`**

Full orchestrator flow:

1. Parse `CLOUDFLARE_ENV` (default: production).
2. Read generated config, get worker name, bucket name.
3. Compute release ID.
4. For production: check staging approval gate (git SHA + digest equality).
5. Get current deployment, require one version at 100%.
6. Upload new version with `--tag <release-id>`.
7. Deploy new@0 old@100.
8. Get new version UUID from `versions list`.
9. Smoke with version override header on all routes.
10. If smoke fails: abort (version stays at 0%).
11. Promote: deploy new@100.
12. Continuous probe for 120s.
13. If probe fails: rollback old@100, abort.
14. Final browser smoke.
15. Save deployment state.

**GREEN expectation:** All orchestrator tests pass.  
**Test command:** `bun run test:unit -- tests/unit/release-deploy.test.ts`

- [ ] **Step 9: Run full test suite**

```bash
bun run lint
bun run typecheck
bun run build
bun run test:unit
bun run test:integration
```

- [ ] **Step 10: Commit Task 3**

```bash
git add -A
git commit -m "feat: two-phase deployment orchestrator with safety gates (Task 3)"
```

---

### Task 4: Config / Scripts / Docs + Full Integration

**Files:**

- Modify: `package.json` (replace `deploy`/`deploy:staging` with orchestrator)
- Modify: `wrangler.jsonc` (verify `version_metadata` binding, staging env)
- Modify: `AGENTS.md` (document new deploy protocol)
- Modify: `README.md` (update deploy instructions)
- Create: `docs/superpowers/recovery.md` (manual recovery commands)

- [ ] **Step 1: Replace legacy deploy scripts in `package.json`**

Replace:

```json
"deploy": "vp run build && wrangler deploy",
"deploy:staging": "CLOUDFLARE_ENV=staging vp run build && wrangler deploy",
```

With:

```json
"deploy": "vp run build && node scripts/release-deploy.mjs",
"deploy:staging": "CLOUDFLARE_ENV=staging vp run build && node scripts/release-deploy.mjs",
"deploy:rollback": "node scripts/release-rollback.mjs",
"deploy:publish-only": "vp run build && node scripts/release-publish.mjs",
```

No `wrangler deploy` accessible under standard commands.

- [ ] **Step 2: Verify `wrangler.jsonc` has `version_metadata` binding**

Verify top-level and `env.staging` both have:

```jsonc
"version_metadata": {
  "binding": "CF_VERSION_METADATA",
  "type": "json"
}
```

- [ ] **Step 3: Update `AGENTS.md` deploy section**

Replace the staging-first deploy section with the new protocol:

- Document the two-phase deployment (upload → 0% → smoke → promote → probe → soak).
- Document the R2 release fallback.
- Document the `CF_VERSION_METADATA` binding.
- Document the release ID format.
- Document the staging → production gate.
- Document manual recovery commands (link to `docs/superpowers/recovery.md`).
- Remove documentation of `wrangler deploy` as a valid deploy path.

- [ ] **Step 4: Update `README.md` deploy section**

Update the deploy instructions to use the new orchestrator. Remove `wrangler deploy` references.

- [ ] **Step 5: Create `docs/superpowers/recovery.md`**

Document manual recovery commands:

```bash
# List current versions
vp exec wrangler versions list --json

# Rollback to a specific version at 100%
vp exec wrangler versions deploy --config <generated> --version-id <uuid> --percentage 100

# List deployments
vp exec wrangler deployments list --json

# Check R2 release objects
vp exec wrangler r2 object get <bucket>/releases/<id>/release-manifest.json --remote
```

- [ ] **Step 6: Run full test suite**

```bash
bun run lint
bun run typecheck
bun run build
bun run test
```

Verify all 1310+ tests pass, coverage 100%, v8-ignore cap 20.

- [ ] **Step 7: Commit Task 4**

```bash
git add -A
git commit -m "feat: config, scripts, docs integration for zero-downtime release (Task 4)"
```

---

### Task 5: Merge / Main / Staging / Prod Shipment

**No files created in worktree** — this task operates on merged main.

- [ ] **Step 1: Merge through PR/main per repo policy**

Push the `feat/zero-downtime-release` branch and create a PR to `main`. Follow the repo's standard review and merge process.

- [ ] **Step 2: Run full suite on actual main**

After merge, on main:

```bash
bun install
bun run lint
bun run typecheck
bun run build
bun run test
```

All must pass on actual main (not the worktree).

- [ ] **Step 3: Build and publish staging**

```bash
CLOUDFLARE_ENV=staging vp run build
node scripts/release-publish.mjs   # uploads to preview R2 bucket
```

- [ ] **Step 4: Deploy staging with new protocol**

```bash
bun run deploy:staging
```

This runs the full orchestrator: upload version → 0% → smoke → promote → probe → soak.

- [ ] **Step 5: Exercise fallback in automated local/integration tests**

Run integration tests that exercise the R2 fallback:

```bash
bun run test:integration
```

Verify R2 shell fallback, asset fallback, 503 recovery all work.

- [ ] **Step 6: Functional staging browser smoke**

Manually browse `https://cf-moedict-webkit-neo-staging.audreyt.workers.dev`:

- HTML shell loads
- Dictionary API works
- Static assets load
- Version headers present

- [ ] **Step 7: Save staging approval state**

Record staging-approved git SHA and client manifest digest:

```bash
node scripts/release-deploy.mjs --save-staging-approval
```

- [ ] **Step 8: Build and publish production**

```bash
vp run build   # CLOUDFLARE_ENV defaults to production
node scripts/release-publish.mjs
```

- [ ] **Step 9: Deploy production with new protocol**

```bash
bun run deploy
```

This checks staging approval gate, then runs the full orchestrator for production.

- [ ] **Step 10: Continuous probes and final browser smoke**

Orchestrator runs continuous probes for 120s after promotion. Then final browser smoke against `https://www.moedict.tw`.

- [ ] **Step 11: Never deploy from feature worktree after merge**

All production deploys are from main, never from the feature worktree.

---

## Test Commands Summary

| Task | Test Command                                                              | RED Expectation             |
| ---- | ------------------------------------------------------------------------- | --------------------------- |
| 1    | `bun run test:unit -- tests/unit/release-fallback.test.ts`                | Import fails                |
| 1    | `bun run test:unit -- tests/unit/worker-dispatch.test.ts`                 | New dispatch paths fail     |
| 1    | `bun run test:integration -- tests/integration/api-legacy-assets.test.ts` | R2 fallback not implemented |
| 2    | `bun run test:unit -- tests/unit/release-manifest.test.ts`                | Module doesn't exist        |
| 2    | `bun run test:unit -- tests/unit/generated-config.test.ts`                | Module doesn't exist        |
| 2    | `bun run test:unit -- tests/unit/r2-upload.test.ts`                       | Module doesn't exist        |
| 3    | `bun run test:unit -- tests/unit/wrangler-versions.test.ts`               | Module doesn't exist        |
| 3    | `bun run test:unit -- tests/unit/deployment-state.test.ts`                | Module doesn't exist        |
| 3    | `bun run test:unit -- tests/unit/smoke-probe.test.ts`                     | Module doesn't exist        |
| 3    | `bun run test:unit -- tests/unit/release-deploy.test.ts`                  | Module doesn't exist        |
| 4    | `bun run test`                                                            | Full suite passes           |
| 5    | N/A (operates on merged main)                                             | N/A                         |

## Coverage Requirements

- All new code must maintain 100% coverage (vite.config.ts thresholds).
- `/* v8 ignore */` total must remain ≤ 20 (enforced by `scripts/check-v8-ignore-count.mjs`).
- Worker direct-call unit tests cover shell/asset fallback, exceptions, HEAD/304, source/version headers, 503 recovery, legacy precedence.
- Script unit tests use injected subprocess/fetch/fs adapters for deterministic testing.
- Integration tests use Miniflare R2 for real bucket behavior.
- E2E tests only for observable routes.
