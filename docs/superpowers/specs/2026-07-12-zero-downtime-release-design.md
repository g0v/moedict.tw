# Zero-Downtime Release — Design Specification

> **Status:** Approved (A+B). Implementation authorized.  
> **Date:** 2026-07-12  
> **Branch:** `feat/zero-downtime-release`  
> **Base SHA:** `0fd3c49` on `main`  
> **Worktree:** `.worktrees/zero-downtime-release`

## 1. Problem Statement

The current deployment path (`vp run deploy` → `wrangler deploy`) is an atomic
cutover: the new Worker version replaces the old one instantly. If the new
version has a runtime defect (e.g., a shell-rendering regression, a broken R2
binding, or an unhandled edge case), every user sees it immediately with no
automatic recovery. The only rollback is a re-deploy of the old code, which
itself takes 60–90s of edge-cache propagation.

Two specific risks motivate this work:

1. **HTML shell fallthrough to 404.** `renderHtmlShell` in `worker/index.ts`
   calls `SITE_ASSETS.fetch('/')` and converts any non-OK response to `null`,
   which `dispatch()` then falls through to a bare `404`. There is no recovery
   layer between the platform static-assets fetcher and the user.

2. **No gradual traffic shifting.** A broken deploy affects 100% of traffic
   from the moment `wrangler deploy` returns. There is no way to test a new
   version at 0% → 1% → 100% with automatic rollback on probe failure.

## 2. Approved Design (A+B)

### A — Two-Phase Version Upload with Probes and Automatic Rollback

Use Cloudflare's **Workers Versions** API (`wrangler versions upload` /
`wrangler versions deploy`) to upload a new Worker version without activating
it, then gradually shift traffic from old→new while continuously probing. If
any probe fails, automatically roll back to the old version at 100%.

**Phase 1 — Upload & Smoke (new0 / old100):**

1. Upload the new Worker version via `wrangler versions upload --tag <release-id>`.
2. Deploy traffic split: new version at 0%, old version at 100%
   (`wrangler versions deploy <new-uuid>@0% <old-uuid>@100% -y`).
3. Smoke-test the new version using the
   `Cloudflare-Workers-Version-Overrides: <exact-worker-name>="<new-UUID>"`
   request header on every page/asset route. Require a matching
   `X-Moedict-Release` response header on every probe. Any non-200 or missing
   header aborts before promotion.

**Phase 2 — Promote & Probe (new100 / old0):**

1. Deploy traffic split: new@100, old@0
   (`wrangler versions deploy <new-uuid>@100% <old-uuid>@0% -y`) so both
   versions remain in the deployment during the probe/soak.
2. Continuously probe critical routes (HTML shell, `/api/config`, dictionary
   API, static assets) against the custom domain (now serving the new
   version at 100%).
3. If any probe returns non-200 or throws, immediately roll back:
   `wrangler versions deploy <old-uuid>@100% <new-uuid>@0% -y`.
4. Soak for at least 2 × HTML-shell TTL (2 × 60s = 120s) to let edge caches
   expire.
5. Finalize: `wrangler versions deploy <new-uuid>@100% -y` (new alone at 100%).
6. Final browser smoke against the custom domain.

### B — Durable R2 Release Fallback

Structurally eliminate the `renderHtmlShell` → `null` → `404` fallthrough by
adding a durable R2-backed fallback layer. When `SITE_ASSETS.fetch('/')`
returns non-OK or throws, the Worker reads the current release's `index.html`
from a well-known R2 key in the environment's `ASSETS` bucket, injects head
metadata, and serves it. If both `SITE_ASSETS` and R2 fail, the Worker returns
a self-contained `503` (never `404`) with `Retry-After` and an auto-refresh
meta tag.

### Explicitly Excluded

- **`cross_version_cache`**: NOT included. The design does not attempt to
  coordinate edge cache across old/new Worker versions. The 120s soak at 2×
  shell TTL handles cache expiry naturally.
- **Cold cache / platform gap as proven failure**: The design does NOT claim
  cold cache or platform propagation gaps as the proven failure path. The
  proven local failure path is `renderHtmlShell` converting
  `SITE_ASSETS.fetch('/')` non-OK to `null` → final `404`. B structurally
  removes that fallthrough. Diagnostics will identify cold-cache/platform
  issues next time they occur.

## 3. Release Identity

### Format

```
<git-short-sha>-<first12 of deterministic sorted client-manifest SHA256>
```

- **git-short-sha**: 7-character `git rev-parse --short HEAD` at build time.
- **client-manifest SHA256**: SHA-256 of the deterministic, sorted JSON
  serialization of our own client manifest (see below), first 12 hex characters.

### Client Manifest (Self-Defined)

The current build does not guarantee `dist/.../.vite/manifest.json` exists or
has a stable shape. We define our own client manifest by recursively
enumerating `dist/client/**` (excluding nothing — every file is included):

```typescript
interface ClientManifestEntry {
  path: string; // relative path from dist/client/ (e.g. "assets/index-BU7Lztf4.js")
  sha256: string; // hex SHA-256 of file content
  size: number; // file size in bytes
}
```

The manifest is a sorted array of these records (sorted by `path`), serialized
as deterministic JSON (no spaces, sorted keys), then SHA-256 hashed. The first
12 hex characters of that hash is the client manifest digest.

The `release-manifest.json` uploaded to R2 contains this manifest plus metadata
(`id`, `gitSha`, `clientManifestDigest`, `createdAt`, `files`). The
`release-manifest.json` itself is uploaded separately and is NOT included in
the manifest enumeration or digest computation.

### No Circular Embedding

The release ID is computed from build outputs only. It is NOT embedded in
the client bundle (which would change the manifest hash, creating a circular
dependency). The release ID is passed to the Worker via the
`CF_VERSION_METADATA` binding's `tag` field at deploy time and written to R2
`releases/<id>/release-manifest.json`.

### Staging and Prod Build Separately

`CLOUDFLARE_ENV` is a build-time variable (read by
`@cloudflare/vite-plugin`). Staging and production are built independently.
Production deployment requires:

1. Same git SHA as the staging-approved state.
2. Client manifest digest equality (staging digest == prod digest).
3. Re-built prod client digest equality (the prod build's own digest matches
   the recorded staging digest).

If any of these fail, production deployment aborts.

## 4. R2 Layout

### Environment Bucket Discovery

The R2 environment bucket is discovered from the **generated** wrangler
config's `ASSETS` binding — not the source `wrangler.jsonc`. The generated
config is at `dist/cf_moedict_webkit_neo/wrangler.json`. For staging, the
`ASSETS` binding points to `moedict-assets-preview`; for production, to
`moedict-assets`. The publish script reads the generated config to determine
which bucket to upload to.

**Never** use the staging public `ASSET_BASE_URL` (which points to prod
`r2-assets.moedict.tw`) for release fallback uploads. The release fallback
goes to the environment's own R2 bucket.

### Key Layout

```
releases/<id>/index.html
releases/<id>/release-manifest.json
releases/<id>/<relative-path>          ← all current release files (dist/client/**)
immutable/assets/<relative-path>        ← content-hashed dist/client/assets/** (global)
```

### Key Mapping Example

For a request to `/assets/index-BU7Lztf4.js`:

1. Current release key: `releases/<tag>/assets/index-BU7Lztf4.js`
2. Global immutable key: `immutable/assets/index-BU7Lztf4.js`

The relative path from `dist/client/` is preserved verbatim under both
prefixes. A request to `/assets/foo-hash.js` maps exactly to
`immutable/assets/foo-hash.js` — no path transformation.

- `releases/<id>/index.html`: The SPA shell HTML, same as
  `dist/client/index.html`.
- `releases/<id>/release-manifest.json`: Metadata about the release
  (`{ id, gitSha, clientManifestDigest, createdAt, files: [...] }`).
- `releases/<id>/<relative-path>`: Every file from `dist/client/` under the
  release prefix (e.g., `releases/<id>/assets/index-BU7Lztf4.js`).
- `immutable/assets/<relative-path>`: Content-hashed files from
  `dist/client/assets/**` copied to a global, release-independent path. This
  allows a new Worker to satisfy an old hashed URL without knowing the old
  release ID.

### Why Global Immutable Assets

A new Worker version may reference different hashed asset filenames. But
old tabs (still running the old Worker's HTML) will request old hashed URLs.
If those URLs are only under `releases/<old-id>/`, the new Worker doesn't
know `<old-id>`. The global `immutable/assets/` path solves this: all
content-hashed assets are copied there, and the Worker's asset fallback
checks the global path after the current release path.

### Shared Key Derivation Module

R2 key derivation has ONE shared pure TypeScript implementation at
`src/utils/release-keys.ts`, imported by both the Worker (production) and
Bun deployment scripts. No duplicate string concatenation anywhere.

```typescript
/** R2 key for a file under a specific release: releases/<tag>/<relative-path> */
export function releaseKey(tag: string, relativePath: string): string;

/** R2 key for a content-hashed asset: immutable/assets/<relative-path>
 *  Request '/assets/index-XYZ.js' → 'immutable/assets/index-XYZ.js'
 *  Never produces 'immutable/assets/assets/...' — leading slash is stripped. */
export function immutableKey(requestPath: string): string;

/** Check if a relative path is under assets/ (for publisher use) */
export function isImmutableAsset(relativePath: string): boolean;
```

**Safety guarantees:**

- Normalize one optional leading slash (`/assets/foo.js` → `assets/foo.js`).
- Reject empty paths, `..` traversal (literal or `%2e%2e` encoded), backslash
  segments, and empty segments.
- `immutableKey` rejects paths not starting with `assets/`.
- Only content-hashed files under `assets/` are promoted to `immutable/`;
  non-hashed files remain release-scoped only.
- Publisher↔Worker key equality: the publisher's relative path
  (`assets/index-XYZ.js`) and the Worker's request path (`/assets/index-XYZ.js`)
  map to the same R2 key. Round-trip tests verify this with real
  representative Vite paths.

### No Automatic GC in v1

Retain all immutable assets and release trees indefinitely. This protects
old tabs and enables rollback. A future lifecycle assessment will determine
when and how to garbage-collect stale releases. This is a documented
future concern, NOT a delivered TODO.

## 5. `CF_VERSION_METADATA` Binding

### Type

```typescript
interface VersionMetadata {
  id: string; // Cloudflare-generated version UUID (NOT the release ID)
  tag: string; // Release ID: <git-short-sha>-<manifest-digest-12> (our --tag value)
  timestamp: string; // ISO 8601 deployment timestamp
}
```

The `id` field is the **Cloudflare version UUID** assigned by the platform
when a version is uploaded via `wrangler versions upload`. It is NOT the
release ID. The `tag` field is the value passed via `--tag` to
`wrangler versions upload`, which we set to our release ID.

### Wrangler Config

Add to `wrangler.jsonc`:

```jsonc
"version_metadata": {
  "binding": "CF_VERSION_METADATA"
}
```

The `version_metadata` binding accepts only `{ "binding": "<name>" }` — no
`"type"` property. It is available in modern wrangler (≥ 3.x).

### Environment Inheritance

The `version_metadata` binding appears in both `RawConfig` (top-level) and
`RawEnvironment` (per-env) in the wrangler config schema. Whether it is
inherited from top-level into `env.staging` is ambiguous in the schema. Per
the non-inheritable bindings precedent (`vars`, `r2_buckets`,
`durable_objects`, `services` are all non-inherited and must be redeclared
per environment), we **redeclare `version_metadata` in `env.staging`** to
guarantee the binding is present in staging. If it is also inherited, the
redeclaration is harmless (same value); if it is not inherited, the
redeclaration is required.

```jsonc
// Top-level
"version_metadata": { "binding": "CF_VERSION_METADATA" }
// env.staging (redeclared to guarantee presence)
"env": {
  "staging": {
    "version_metadata": { "binding": "CF_VERSION_METADATA" }
  }
}
```

### Guard Undefined/Empty Tag

The new version may coexist at 0% with an old version that lacks the
`CF_VERSION_METADATA` binding (because it was deployed before this feature).
The Worker MUST guard against `env.CF_VERSION_METADATA` being `undefined` or
having an empty `tag` string.

When metadata or tag is absent/empty:

- **Do NOT** construct `releases/unknown/...` R2 keys. There is no release
  tree for an unknown tag.
- **Skip the R2 release fallback** entirely. After `SITE_ASSETS` failure,
  proceed directly to the diagnostic 503 recovery response.
- `X-Moedict-Version` header: use the Cloudflare version UUID (`id`) if
  present, otherwise `"unknown"`.
- `X-Moedict-Release` header: emit only when `tag` is non-empty. Omit the
  header entirely if tag is absent/empty.

### Bootstrap Safety

If Cloudflare rejects the `version_metadata` binding (because the feature is
not yet available for this account or Worker), the deploy MUST abort safely
with a clear error message. This is a bootstrap experiment — the design
degrades gracefully if the binding is rejected.

## 6. Worker Shell Flow

### Current Flow (Before)

```
shouldRenderHtmlShell?
  → renderHtmlShell(request, env, pathname)
    → getAssetsFetcher(env)  [SITE_ASSETS]
    → if !fetcher: return null
    → fetcher(new Request("/", request))
    → if !response.ok: return null        ← THE PROVEN FAILURE PATH
    → inject head metadata
    → return Response(html)
  → if shellResponse: return shellResponse
  → passThroughAssets(request, env)
  → ... 404
```

### New Flow (After)

```
shouldRenderHtmlShell?
  → renderHtmlShell(request, env, pathname)
    → try SITE_ASSETS.fetch("/")  [fast path]
      → if OK: inject head metadata, set source=site-assets, return Response
      → if non-OK or throw: fall through to R2 (if tag present) or 503
    → if tag present: R2 fallback: env.ASSETS.get("releases/<tag>/index.html")
      → if found: inject head metadata, set source=r2-release, return Response
    → Both fail (or tag absent): return self-contained 503
      → Cache-Control: no-store
      → Retry-After: 5
      → <meta http-equiv="refresh" content="5"> in body
      → X-Moedict-Shell-Source: recovery
  → if shellResponse: return shellResponse
```

**No fallthrough to null.** The 503 recovery is the ONLY both-stores-fail
outcome for HTML routes. The function returns a Response, never `null`, when
`shouldRenderHtmlShell` is true. This is the structural guarantee of design B:
no HTML shell route can produce a 404 from the shell flow.

### Asset Flow (After SITE_ASSETS Miss)

```
passThroughAssets(request, env)
  → SITE_ASSETS.fetch(request)  [fast path — unchanged]
  → if non-OK or null: fall through to R2
  → R2 current release: env.ASSETS.get("releases/<tag>/<relative-path>")
    → if found: return with proper headers, source=r2-release
  → R2 global immutable: env.ASSETS.get("immutable/assets/<relative-path>")
    → for /assets/* hashed paths only
    → if found: return with immutable cache headers, source=r2-immutable
  → Legacy fallback: existing ASSET_BASE_URL proxy (unchanged)
    → for /assets/* non-hashed paths
  → existing legacy root/public compatibility (unchanged)
```

### 503 Recovery Response

Never return 404 for an HTML shell route. When both `SITE_ASSETS` and R2
fail (or when R2 fallback is skipped because tag is absent):

```typescript
const headers: HeadersInit = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Retry-After": "5",
  "X-Moedict-Shell-Source": "recovery",
};
// Version header: use Cloudflare UUID if present, else "unknown"
headers["X-Moedict-Version"] = versionMetadata?.id ?? "unknown";
// Release header: emit ONLY when tag is non-empty
if (versionMetadata?.tag) {
  headers["X-Moedict-Release"] = versionMetadata.tag;
}
new Response(recoveryHtml, { status: 503, headers });
```

The recovery HTML is a minimal self-contained page with
`<meta http-equiv="refresh" content="5">` and a user-friendly message.

### Preserve Legacy Behavior

All existing asset fallback behavior (R2 `ASSETS` bucket for
`/images/Download_on_the_App_Store_Badge_HK_TW_135x40.png`,
`/manifest.appcache`, `/assets/*` proxy to `ASSET_BASE_URL`) is preserved.
The new R2 release fallback is an additional layer, not a replacement.

## 7. R2 Response Handling

### Standard R2 Response Pattern

```typescript
function serveR2Object(
  object: R2ObjectBody,
  request: Request,
  options: {
    cacheControl?: string;
    cacheTag?: string;
    cors?: boolean;
    immutable?: boolean;
  },
): Response {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);

  // ETag / If-None-Match → 304
  if (request.headers.get("If-None-Match") === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  // CORS
  if (options.cors) {
    Object.entries(PUBLIC_CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));
  }

  // Cache-Control
  if (options.cacheControl) {
    headers.set("Cache-Control", options.cacheControl);
  }
  if (options.cacheTag) {
    headers.set("Cache-Tag", options.cacheTag);
  }

  // HEAD
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(object.body, { status: 200, headers });
}
```

### Cache Policy

| Content                                  | Cache-Control                                          |
| ---------------------------------------- | ------------------------------------------------------ |
| Content-hashed `/assets/*` (R2 fallback) | `public, max-age=31536000, immutable`                  |
| `index.html` (R2 release fallback)       | `public, max-age=0, s-maxage=60` (same as `htmlShell`) |
| R2 miss / error                          | `no-store`                                             |

### No Allocations / Copies

Stream R2 object bodies directly: `new Response(object.body, ...)`. Never
`await object.text()` for shell or asset responses (only for metadata
extraction if needed). The existing `renderHtmlShell` does
`await shellResponse.text()` for head injection — this is acceptable for the
shell (bounded ~3KB HTML) but NOT for assets.

## 8. Observability Headers

### Response Headers on All Worker Responses

| Header                   | Value                                                                   | Source                   |
| ------------------------ | ----------------------------------------------------------------------- | ------------------------ |
| `X-Moedict-Version`      | `CF_VERSION_METADATA.id` (Cloudflare UUID) or `"unknown"`               | Version metadata binding |
| `X-Moedict-Release`      | `CF_VERSION_METADATA.tag` (release ID); **omitted if tag absent/empty** | Version metadata binding |
| `X-Moedict-Shell-Source` | `site-assets` \| `r2-release` \| `recovery`                             | Shell flow only          |
| `X-Moedict-Asset-Source` | `site-assets` \| `r2-release` \| `r2-immutable` \| `legacy-proxy`       | Asset fallback flow only |

### Structured Shell-Miss Log

When `SITE_ASSETS.fetch("/")` fails and the Worker falls through to R2 (or
skips R2 if tag absent):

```json
{
  "event": "shell-miss",
  "pathname": "/",
  "cfRay": "<cf-ray header>",
  "versionId": "<CF_VERSION_METADATA.id or unknown>",
  "releaseTag": "<CF_VERSION_METADATA.tag or null>",
  "siteAssetsResult": "non-ok" | "throw" | "no-fetcher",
  "siteAssetsStatus": 500,
  "r2Attempted": true | false,
  "r2Key": "releases/<tag>/index.html",
  "r2Result": "hit" | "miss" | "throw" | "skipped",
  "finalSource": "r2-release" | "recovery",
  "finalStatus": 200 | 503
}

No secret data in logs. Use `console.log(JSON.stringify(...))` for
structured logging (Cloudflare observability captures `console.log`).

## 9. Prepublish / Verification Scripts

### Authenticated Wrangler CLI Path

All R2 object operations use the installed Wrangler CLI via
`vp exec wrangler r2 object put <bucket>/<key> --file=<path> --remote
--content-type=<ct> --cache-control=<cc>`. Authentication is via
`wrangler login` (interactive) or `CLOUDFLARE_API_TOKEN` environment
variable (CI).

### Concurrency and Rate Limiting

- Maximum 4 concurrent uploads (Cloudflare R2 API rate limit ~1100 req/5min).
- Exponential backoff on 429 (error code 971): initial 1s, ×2, max 60s, 5
  retries.

### Upload Order

1. Upload all `dist/client/**` files to `releases/<id>/<relative-path>` with
   correct `Content-Type`, `Cache-Control`, and `Cache-Tag` metadata.
2. Upload content-hashed `dist/client/assets/**` to
   `immutable/assets/<relative-path>` (same metadata).
3. Upload `release-manifest.json` **last**, only after all objects succeed.
4. Verify: re-GET every object and compare SHA-256 hash with the local file.
   Any mismatch aborts.
5. Verify: GET `release-manifest.json` and parse; confirm all listed files
   exist and match.

### Generated Config / Bucket Selection

The publish script reads `dist/cf_moedict_webkit_neo/wrangler.json` (the
generated config) to determine the `ASSETS` binding's `bucket_name` (prod)
or `preview_bucket_name` (staging, when `CLOUDFLARE_ENV=staging`). It uses
this bucket name for all R2 uploads.

## 10. Deployment Orchestrator

### State Persistence

Deployment state is persisted under `.wrangler/releases/` (already
gitignored via `.wrangler` in `.gitignore`).

```

.wrangler/releases/
current.json ← { workerName, versionId, tag, percentage, deployedAt }
versions.json ← [{ versionId, tag, uploadedAt, status }]

````

### Parse Current Deployment

Before any deployment:

1. Run `wrangler deployments list --json` to get the current deployment.
2. Require exactly one old version at 100% traffic. If the state is not
   "one version at 100%", abort (cannot safely do gradual deployment from a
   split state).

### Phase 1: Upload & 0% Deploy

```bash
# Upload new version (does not activate)
wrangler versions upload --config <generated-config> --tag <release-id>

# Deploy new at 0%, old at 100% (using UUID IDs from versions list)
wrangler versions deploy --config <generated-config> \
  <new-uuid>@0% <old-uuid>@100% -y
````

Note: `versions deploy` uses positional `<uuid>@<percentage>` specs, NOT
`--version-tag` with `--percentage`. The `--tag` is only for `versions
upload`. Never mix `--version-tag` with positional ID specs.

### Phase 1 Smoke (Version Override)

```bash
# Get the new version's UUID from `wrangler versions list --json`
# Smoke every route with the version override header:
curl -H 'Cloudflare-Workers-Version-Overrides: cf-moedict-webkit-neo="<new-uuid>"' \
  https://www.moedict.tw/
# Require: response status 200 AND X-Moedict-Release header matches <release-id>
```

The override header key is the exact Worker name (`cf-moedict-webkit-neo` for
prod, staging Worker name for staging). The value is the new version's UUID
(from `versions list --json`), quoted. Every page and asset route is probed.
Any non-200 or missing/mismatched release header aborts before promotion.

### Phase 2: Promote & Probe

Promotion is a two-step process so both versions remain in the deployment
during the 120s probe/soak, and the old version can be explicitly restored
on any probe failure:

```bash
# Step 1: Deploy new@100, old@0 (both remain in deployment)
wrangler versions deploy --config <generated-config> \
  <new-uuid>@100% <old-uuid>@0% -y

# ... continuous probes for 120s (see below) ...

# Step 2 (only after soak passes): Finalize new@100 alone
wrangler versions deploy --config <generated-config> \
  <new-uuid>@100% -y
```

### Continuous Probes

After the new@100/old@0 deploy, continuously probe critical routes against
the custom domain (now serving 100% new version):

- `/` (HTML shell)
- `/api/config`
- `/api/%E8%90%8C.json` (dictionary API)
- `/assets/index-BU7Lztf4.js` (or current hashed asset)

Probe every 5s. If any probe returns non-200 or throws, immediately:

```bash
# Rollback: old version back to 100%, new to 0%
wrangler versions deploy --config <generated-config> \
  <old-uuid>@100% <new-uuid>@0% -y
```

### Soak

Soak for at least 120s (2 × 60s HTML-shell TTL) after the new@100/old@0
deploy, with continuous probing. If all probes pass, finalize with
new@100 alone. Then final browser smoke.

### Staging → Production Gate

Production requires:

1. A staging-approved state for the same git SHA.
2. Client manifest digest equality (staging digest == prod digest).
3. Re-built prod client digest equality.

Both staging and prod are built separately because `CLOUDFLARE_ENV` is
build-time. The orchestrator records the staging-approved state (git SHA +
client manifest digest) and checks it against the prod build before
proceeding.

## 11. Script Safety — Legacy Deploy Cutover

### Existing Scripts

The existing `deploy` and `deploy:staging` scripts in `package.json`:

```json
"deploy": "vp run build && wrangler deploy",
"deploy:staging": "CLOUDFLARE_ENV=staging vp run build && wrangler deploy",
```

These are **unsafe** because `wrangler deploy` is an atomic cutover with no
gradual rollout or rollback.

### Cutover

Replace with safe orchestrator commands:

```json
"deploy": "node scripts/release-deploy.mjs",
"deploy:staging": "CLOUDFLARE_ENV=staging node scripts/release-deploy.mjs",
```

The orchestrator (`scripts/release-deploy.mjs`) runs the full safe
protocol: build → publish → upload version → 0% deploy → smoke → promote →
probe → soak → final smoke.

### Guard Failures

If someone tries to run `wrangler deploy` directly, the orchestrator should
detect this and fail with a clear message pointing to the safe command. This
can be a simple wrapper or a CI check. The existing `deploy` / `deploy:staging`
scripts MUST NOT leave an unsafe `wrangler deploy` path accessible under
standard commands.

### Recovery Commands

Document (but don't automate) manual recovery commands:

```bash
# List current versions
vp exec wrangler versions list --json

# Rollback to a specific version at 100% (using positional UUID@percentage)
vp exec wrangler versions deploy --config <generated> <uuid>@100% -y

# List deployments
vp exec wrangler deployments list --json
```

## 12. Test Strategy

### TDD Red/Green Per Task

Every task follows TDD: write failing tests first (RED), then implement to
pass (GREEN).

### Worker Direct Unit Tests

Coverage for:

- **Shared key derivation** (`src/utils/release-keys.ts`):
  - `releaseKey(tag, "index.html")` → `releases/<tag>/index.html`
  - `releaseKey(tag, "/assets/index-XYZ.js")` → `releases/<tag>/assets/index-XYZ.js`
  - `immutableKey("/assets/index-XYZ.js")` → `immutable/assets/index-XYZ.js` (never `immutable/assets/assets/...`)
  - `immutableKey("assets/index-XYZ.js")` === `immutableKey("/assets/index-XYZ.js")` (leading slash normalized)
  - Rejects empty path, `..` traversal, `%2e%2e` encoded traversal, backslash, empty segments
  - `immutableKey` rejects paths not starting with `assets/`
  - Publisher↔Worker key equality: publisher relative `assets/index-XYZ.js` and Worker request `/assets/index-XYZ.js` map to same key
  - Round-trip with real representative Vite paths (e.g., `assets/index-BU7Lztf4.js`, `assets/g0v-萌典-DC5dDw0x.css`)
- Shell fallback: `SITE_ASSETS` OK → `site-assets` source
- Shell fallback: `SITE_ASSETS` non-OK → R2 hit → `r2-release` source
- Shell fallback: `SITE_ASSETS` throws → R2 hit → `r2-release` source
- Shell fallback: both fail → 503 recovery, `recovery` source, `Retry-After`
- Shell fallback: no `SITE_ASSETS` fetcher → R2 fallback (if tag present)
- Shell fallback: `CF_VERSION_METADATA` undefined → skip R2, 503 recovery
- Shell fallback: `CF_VERSION_METADATA` tag empty → skip R2, 503 recovery
- Asset fallback: `SITE_ASSETS` miss → R2 current release hit
- Asset fallback: R2 current release miss → R2 global immutable hit
- Asset fallback: all R2 miss → legacy proxy (unchanged)
- HEAD requests for all R2 fallback paths
- 304 If-None-Match for R2 objects
- `X-Moedict-Version` header = `CF_VERSION_METADATA.id` (UUID) or `"unknown"`
- `X-Moedict-Release` header = `CF_VERSION_METADATA.tag`; omitted if absent/empty
- `X-Moedict-Shell-Source` / `X-Moedict-Asset-Source` headers
- 503 response: `no-store`, `Retry-After: 5`, auto-refresh meta
- Legacy precedence preserved (existing routes unchanged)

### Script Unit Tests (with Adapters)

Tests with injected `subprocess` / `fetch` / `fs` adapters for deterministic
testing:

- Manifest generation: deterministic sorted JSON, SHA-256, release ID format
- Generated config parsing: bucket name selection (staging vs prod)
- Upload-before-manifest ordering: manifest last
- Upload abort on object failure
- Exact command syntax for `wrangler versions upload` (`--tag <release-id>`)
- Exact command syntax for `wrangler versions deploy` (`<uuid>@<percentage>` positional, `-y`)
- Exact `Cloudflare-Workers-Version-Overrides` header syntax (key = exact Worker name, value = new UUID)
- 0% smoke gate: all probes must return 200 + `X-Moedict-Release` header
- Rollback on probe failure: `<old-uuid>@100% <new-uuid>@0% -y`
- Staging approval gate: git SHA + digest equality
- Prod digest mismatch abort

### Integration Tests (Miniflare R2)

- R2-backed shell fallback with real Miniflare R2 bucket
- R2 object metadata (Content-Type, Cache-Control, ETag)
- 304 If-None-Match with real R2 ETag
- HEAD requests with R2
- Asset fallback chain: SITE_ASSETS → R2 release → R2 immutable → legacy

### E2E Tests

Only for observable routes (not internal plumbing):

- HTML shell serves 200 with correct headers
- Dictionary API serves 200
- Static asset serves 200
- Version headers present on responses

### Coverage

- Coverage remains 100% (vite.config.ts thresholds).
- `/* v8 ignore */` cap remains 20.
- New code must maintain 100% coverage or use `/* v8 ignore */` within cap.

## 13. Task Decomposition

### Task 1: Runtime R2 Fallback + Metadata (Worker)

**Scope:** Create the shared R2 key derivation module, modify `worker/index.ts`
and `src/api/cache.ts` to implement the R2 shell/asset fallback,
`CF_VERSION_METADATA` binding, observability headers, 503 recovery, and
structured shell-miss logging.

**Files:**

- Create: `src/utils/release-keys.ts` (shared R2 key derivation: `releaseKey`, `immutableKey`, `isImmutableAsset`)
- Create: `tests/unit/release-keys.test.ts` (key derivation, safety, publisher↔Worker round-trip equality)
- Modify: `worker/index.ts` (shell flow, asset flow, headers, 503)
- Modify: `src/api/cache.ts` (new cache control constants)
- Modify: `wrangler.jsonc` (add `version_metadata` binding top-level + `env.staging`)
- Create: `src/api/release-fallback.ts` (R2 fallback logic, version metadata helpers, extracted)
- Create: `tests/unit/release-fallback.test.ts` (direct-call unit tests)
- Modify: `tests/unit/worker-dispatch.test.ts` (new dispatch paths)
- Modify: `tests/integration/api-legacy-assets.test.ts` (R2 fallback)

### Task 2: Deterministic Release Publication / Verification Library + CLI

**Scope:** Create the publish/verify library and CLI scripts for R2
upload, manifest generation (self-defined, not Vite manifest), and
verification. Consumes `src/utils/release-keys.ts` from Task 1 for all R2
key derivation — no duplicate string concatenation.

**Files:**

- Create: `scripts/release-publish.mjs` (publish library + CLI)
- Create: `scripts/release-verify.mjs` (verification library + CLI)
- Create: `scripts/lib/release-manifest.mjs` (manifest generation, SHA-256)
- Create: `scripts/lib/r2-upload.mjs` (R2 upload with concurrency/backoff)
- Create: `scripts/lib/generated-config.mjs` (parse generated wrangler config)
- Create: `tests/unit/release-manifest.test.ts`
- Create: `tests/unit/r2-upload.test.ts`
- Create: `tests/unit/generated-config.test.ts`

### Task 3: Two-Phase Deployment Orchestrator / Safety Gates

**Scope:** Create the deployment orchestrator that runs the full safe
protocol: upload version, 0% deploy, smoke, promote, probe, soak, rollback.

**Files:**

- Create: `scripts/release-deploy.mjs` (orchestrator CLI)
- Create: `scripts/lib/wrangler-versions.mjs` (wrangler versions API wrapper)
- Create: `scripts/lib/deployment-state.mjs` (`.wrangler/releases/` state)
- Create: `scripts/lib/smoke-probe.mjs` (version-override smoke + continuous probe)
- Create: `tests/unit/release-deploy.test.ts`
- Create: `tests/unit/wrangler-versions.test.ts`
- Create: `tests/unit/deployment-state.test.ts`
- Create: `tests/unit/smoke-probe.test.ts`

### Task 4: Config / Scripts / Docs + Full Integration

**Scope:** Replace legacy deploy scripts, update `wrangler.jsonc`, update
docs, wire everything together, run full test suite.

**Files:**

- Modify: `package.json` (deploy scripts → orchestrator)
- Modify: `wrangler.jsonc` (version_metadata binding, any new config)
- Modify: `AGENTS.md` (document new deploy protocol)
- Modify: `README.md` (update deploy instructions)
- Create: `docs/superpowers/recovery.md` (manual recovery commands)
- Modify: `.github/workflows/ci.yml` (if needed for new checks)

### Task 5: Merge / Main / Staging / Prod Shipment

**Scope:** Merge through PR/main per repo policy, run full suite on actual
main, build/publish/deploy staging, exercise fallback in automated
local/integration tests, functional staging browser smoke, then production
protocol + continuous probes and final browser smoke.

**No files created in worktree** — this task operates on merged main.

## 14. Design Contradictions Found

During self-review and user verification, the following contradictions were
identified and resolved:

1. **`version_metadata` binding config syntax**: The wrangler config schema
   confirms `version_metadata` accepts only `{ "binding": "<name>" }` — no
   `"type"` property. Resolved: use `"version_metadata": { "binding":
"CF_VERSION_METADATA" }` without `"type"`.

2. **`CF_VERSION_METADATA.id` vs release ID**: The `id` field is the
   Cloudflare-generated version UUID, NOT our release ID. The `tag` field is
   our release ID (set via `--tag` at upload). Resolved: `X-Moedict-Version`
   uses `.id` (UUID); `X-Moedict-Release` uses `.tag` (release ID); R2 keys
   use `.tag`.

3. **Absent tag → no `releases/unknown/...` keys**: When metadata/tag is
   absent/empty, do NOT construct `releases/unknown/...` R2 keys. Resolved:
   skip R2 release fallback entirely and return diagnostic 503 after
   SITE_ASSETS failure.

4. **Client manifest path**: The build does not guarantee
   `dist/.../.vite/manifest.json`. Resolved: define our own client manifest
   by recursively enumerating `dist/client/**`, sorted `{path, sha256, size}`
   records, deterministic JSON, SHA-256 of that JSON. No Vite manifest
   dependency.

5. **`versions deploy` command syntax**: Uses positional
   `<uuid>@<percentage>` specs, NOT `--version-tag` with `--percentage`.
   Resolved: `versions deploy <new-uuid>@0% <old-uuid>@100% -y`. Never mix
   `--version-tag` with positional ID specs.

6. **Promotion state**: Deploy new@100/old@0 first so both remain in
   deployment during 120s probe/soak; only after soak passes, finalize
   new@100 alone. Any probe failure executes explicit old@100 deployment.
   Resolved: two-step promotion with both versions live during soak.

7. **R2 bucket for staging fallback**: The staging `ASSET_BASE_URL` var
   points to prod `r2-assets.moedict.tw`. Resolved: the R2 release
   fallback uses the environment's own `ASSETS` R2 binding (preview bucket
   for staging, prod bucket for production), discovered from the generated
   config. Never use `ASSET_BASE_URL` for release fallback.

8. **Asset streaming vs. head injection**: `renderHtmlShell` does
   `await response.text()` for head metadata injection. Resolved: this is
   acceptable for the shell (bounded ~3KB HTML). Assets are streamed
   directly (`object.body`) without text conversion.

9. **Release ID and circular embedding**: The release ID includes the
   client manifest digest. If the release ID were embedded in the client
   bundle, it would change the manifest digest. Resolved: the release ID
   is computed from build outputs only and passed via the
   `CF_VERSION_METADATA` binding at deploy time. It is NOT in the client
   bundle.

10. **Staging and prod built separately**: `CLOUDFLARE_ENV` is build-time.
    Resolved: staging and prod are built independently. Production requires
    staging approval (same git SHA + client manifest digest equality) plus
    re-built prod digest equality.

11. **`version_metadata` env inheritance**: The binding appears in both
    `RawConfig` and `RawEnvironment` in the schema; inheritance is
    ambiguous. Resolved: redeclare in `env.staging` to guarantee presence
    (non-inheritable bindings precedent).

12. **R2 immutable key mapping**: Request `/assets/foo-hash.js` maps exactly
    to `immutable/assets/foo-hash.js`; current release key is
    `releases/<tag>/assets/foo-hash.js`. Verified: the relative path from
    `dist/client/` is preserved verbatim under both prefixes.

## 15. Future Concerns (Documented, Not Delivered)

- **R2 lifecycle management**: No automatic GC in v1. Retain immutable
  assets and release trees indefinitely. A future assessment will determine
  when and how to garbage-collect stale releases. This is NOT a TODO in the
  code; it is a documented future concern.

- **Cold cache / platform gap diagnostics**: The design does not claim
  cold cache or platform propagation as the proven failure path. The
  proven path is `renderHtmlShell` → `null` → `404`. B structurally removes
  it. Future diagnostics will identify cold-cache issues if they occur.
