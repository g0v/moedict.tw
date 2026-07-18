/// <reference types="node" />
/**
 * Unit tests for the two-phase deployment orchestrator
 * (scripts/release-deploy.mjs). Fully dependency-injected: mocked wrangler
 * runner, mocked fetch, fake sleep, real temp state dir (exercises the real
 * atomic deployment-state read/write path). No real Wrangler CLI, network,
 * or `.wrangler/releases/` writes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  deriveProbeRoutes,
  resolveBaseUrl,
  runReleaseDeploy,
} from "../../scripts/release-deploy.mjs";
import {
  readCurrentDeployment,
  readStagingApproval,
  readVersionHistory,
  saveStagingApproval,
  VERSION_STATUS,
} from "../../scripts/lib/deployment-state.mjs";
import { buildReleaseManifest } from "../../scripts/lib/release-manifest.mjs";

const NEW_UUID = "11111111-1111-4111-8111-111111111111";
const OLD_UUID = "22222222-2222-4222-8222-222222222222";
const OTHER_UUID = "33333333-3333-4333-8333-333333333333";
const RELEASE_ID = "abc1234-def012345678";
const OLD_RELEASE_ID = "old5678-abcdef123456";
const GIT_SHA = "abc1234";
const DIGEST = "def012345678";

const MANIFEST = {
  id: RELEASE_ID,
  gitSha: GIT_SHA,
  clientManifestDigest: DIGEST,
  createdAt: "2026-07-12T00:00:00.000Z",
  files: [
    { path: "index.html", sha256: "a".repeat(64), size: 10 },
    { path: "assets/index-AbCdEf12.js", sha256: "b".repeat(64), size: 20 },
    { path: "assets/style-12345678.css", sha256: "c".repeat(64), size: 30 },
  ],
};

const PROD_CONFIG = {
  name: "cf-moedict-webkit-neo",
  r2_buckets: [
    {
      binding: "ASSETS",
      bucket_name: "moedict-assets",
      preview_bucket_name: "moedict-assets-preview",
    },
  ],
};
const STAGING_CONFIG = {
  name: "cf-moedict-webkit-neo-staging",
  targetEnvironment: "staging",
  r2_buckets: [{ binding: "ASSETS", bucket_name: "moedict-assets-preview" }],
};

function deploymentsListOk(versions: Array<{ version_id: string; percentage: number }>) {
  return {
    exitCode: 0,
    stdout: JSON.stringify([{ id: "d1", versions, created_on: "2026-07-11T00:00:00Z" }]),
    stderr: "",
  };
}

const DEFAULT_RESPONSES: Record<string, { exitCode: number; stdout: string; stderr: string }> = {
  "deployments-list": deploymentsListOk([{ version_id: OLD_UUID, percentage: 100 }]),
  upload: { exitCode: 0, stdout: `Worker Version ID: ${NEW_UUID}\n`, stderr: "" },
  "versions-list": {
    exitCode: 0,
    stdout: JSON.stringify([
      { id: OLD_UUID, annotations: { "workers/tag": OLD_RELEASE_ID } },
      { id: NEW_UUID, annotations: { "workers/tag": RELEASE_ID } },
    ]),
    stderr: "",
  },
  "deploy-phase1": { exitCode: 0, stdout: "", stderr: "" },
  "deploy-promote": { exitCode: 0, stdout: "", stderr: "" },
  finalize: { exitCode: 0, stdout: "", stderr: "" },
  "deploy-rollback": { exitCode: 0, stdout: "", stderr: "" },
  "restore-old-alone": { exitCode: 0, stdout: "", stderr: "" },
};

function phaseOf(argv: string[]): string {
  if (argv.includes("upload")) return "upload";
  if (argv.includes("deployments") && argv.includes("list")) return "deployments-list";
  if (argv.includes("versions") && argv.includes("list")) return "versions-list";
  const specTokens = argv.filter((a) => a.includes("@") && a.endsWith("%"));
  if (specTokens.length === 1 && specTokens[0] === `${NEW_UUID}@100%`) return "finalize";
  if (specTokens.length === 1 && specTokens[0] === `${OLD_UUID}@100%`) return "restore-old-alone";
  if (specTokens[0] === `${NEW_UUID}@0%` && specTokens[1] === `${OLD_UUID}@100%`)
    return "deploy-phase1";
  if (specTokens[0] === `${NEW_UUID}@100%` && specTokens[1] === `${OLD_UUID}@0%`)
    return "deploy-promote";
  if (specTokens[0] === `${OLD_UUID}@100%` && specTokens[1] === `${NEW_UUID}@0%`)
    return "deploy-rollback";
  return "unknown";
}

type RunnerOverride =
  | { exitCode: number; stdout: string; stderr: string }
  | ((argv: string[], callIndex: number) => { exitCode: number; stdout: string; stderr: string });

function buildRunner(
  overrides: Record<string, RunnerOverride> = {},
  onCall?: (phase: string, argv: string[]) => void,
) {
  const calls: string[][] = [];
  let versionsListCalls = 0;
  const runner = async (argv: string[]) => {
    calls.push(argv);
    const phase = phaseOf(argv);
    onCall?.(phase, argv);
    const override = overrides[phase];
    if (override) {
      return typeof override === "function" ? override(argv, calls.length) : override;
    }
    if (phase === "versions-list") {
      versionsListCalls += 1;
      // Default (no override): the FIRST versions-list call is always the
      // orchestrator's pre-upload existence check (step 5) and, by
      // default, finds nothing tagged yet — the common "fresh release, no
      // prior upload" case every unmodified test below represents. Any
      // LATER call is the post-upload confirm and finds the freshly
      // uploaded version, matching the pre-existing fixture.
      return versionsListCalls === 1
        ? {
            exitCode: 0,
            stdout: JSON.stringify([
              { id: OLD_UUID, annotations: { "workers/tag": OLD_RELEASE_ID } },
            ]),
            stderr: "",
          }
        : DEFAULT_RESPONSES["versions-list"];
    }
    const fallback = DEFAULT_RESPONSES[phase];
    if (!fallback) throw new Error(`unmocked wrangler phase: ${phase} (argv: ${argv.join(" ")})`);
    return fallback;
  };
  return { runner, calls };
}
function buildFetch(
  handler?: (ctx: {
    url: string;
    override: string | undefined;
    index: number;
  }) => Response | undefined,
) {
  const calls: Array<{ url: string; override: string | undefined }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const override = headers["Cloudflare-Workers-Version-Overrides"];
    calls.push({ url, override });
    const custom = handler?.({ url, override, index: calls.length - 1 });
    return (
      custom ?? new Response("ok", { status: 200, headers: { "X-Moedict-Release": RELEASE_ID } })
    );
  };
  return { fetchImpl, calls };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "moedict-release-deploy-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeCounterNowIso() {
  let n = 0;
  return () => new Date(Date.UTC(2026, 6, 12, 0, 0, n++)).toISOString();
}

function baseOpts(env: "production" | "staging", overrides: Record<string, unknown> = {}) {
  return {
    env,
    config: env === "production" ? PROD_CONFIG : STAGING_CONFIG,
    manifest: MANIFEST,
    baseUrl: "https://probe.test",
    sleep: async () => {},
    propagationSleepMs: 0,
    nowIso: makeCounterNowIso(),
    soakIntervalMs: 1,
    soakDurationMs: 1,
    stateBaseDir: dir,
    ...overrides,
  };
}

// ── helpers unit tests ───────────────────────────────────────────────

describe("deriveProbeRoutes", () => {
  it("derives / , /api/config, dictionary API, and the current hashed JS/CSS assets from the manifest", () => {
    const routes = deriveProbeRoutes(MANIFEST);
    expect(routes).toContain("/");
    expect(routes).toContain("/api/config");
    expect(routes).toContain("/api/%E8%90%8C.json");
    expect(routes).toContain("/assets/index-AbCdEf12.js");
    expect(routes).toContain("/assets/style-12345678.css");
  });

  it("throws when the manifest has no hashed JS or CSS asset (never falls back to a stale hardcoded path)", () => {
    expect(() => deriveProbeRoutes({ files: [{ path: "index.html" }] })).toThrow(/hashed JS asset/);
  });

  it("throws when the manifest has a hashed JS asset but no hashed CSS asset", () => {
    expect(() => deriveProbeRoutes({ files: [{ path: "assets/index-AbCdEf12.js" }] })).toThrow(
      /hashed CSS asset/,
    );
  });

  it("throws when the manifest itself is missing or has no files array", () => {
    expect(() => deriveProbeRoutes(null as never)).toThrow(/manifest.files is required/);
    expect(() => deriveProbeRoutes({} as never)).toThrow(/manifest.files is required/);
  });
});

describe("resolveBaseUrl", () => {
  it("uses the custom domain for production", () => {
    expect(resolveBaseUrl("production", "cf-moedict-webkit-neo", undefined)).toBe(
      "https://www.moedict.tw",
    );
  });
  it("uses <workerName>.audreyt.workers.dev for staging", () => {
    expect(resolveBaseUrl("staging", "cf-moedict-webkit-neo-staging", undefined)).toBe(
      "https://cf-moedict-webkit-neo-staging.audreyt.workers.dev",
    );
  });
  it("honors an explicit override", () => {
    expect(resolveBaseUrl("production", "x", "https://custom.test")).toBe("https://custom.test");
  });
  it("throws on an unsupported env", () => {
    expect(() => resolveBaseUrl("bogus" as never, "x", undefined)).toThrow(
      /Unsupported CLOUDFLARE_ENV/,
    );
  });
});

it("is import-safe: runReleaseDeploy is exported as a plain function with no side effects on import", () => {
  expect(typeof runReleaseDeploy).toBe("function");
});

describe("runReleaseDeploy input validation and real-adapter defaults", () => {
  it("throws on an unsupported CLOUDFLARE_ENV before touching config/manifest", async () => {
    await expect(runReleaseDeploy({ env: "bogus" as never })).rejects.toThrow(
      /Unsupported CLOUDFLARE_ENV/,
    );
  });

  it("falls back to a real Date-based nowIso when none is injected", async () => {
    const { runner } = buildRunner();
    const { fetchImpl } = buildFetch();
    const before = Date.now();
    const result = await runReleaseDeploy({
      ...baseOpts("staging", { runner, fetch: fetchImpl }),
      nowIso: undefined,
    });
    const parsed = Date.parse(result.deployedAt);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThanOrEqual(before);
  });

  it("falls back to the real setTimeout-based sleep when no sleep is injected", async () => {
    const { runner } = buildRunner();
    const { fetchImpl } = buildFetch();
    const result = await runReleaseDeploy({
      ...baseOpts("staging", { runner, fetch: fetchImpl }),
      sleep: undefined,
      propagationSleepMs: 0,
      soakIntervalMs: 1,
      soakDurationMs: 1,
    });
    expect(result.releaseId).toBe(RELEASE_ID);
  });

  it("falls back to a real buildReleaseManifest(distClientDir) call when no manifest is injected", async () => {
    const clientDir = mkdtempSync(join(dir, "client-"));
    mkdirSync(join(clientDir, "assets"), { recursive: true });
    writeFileSync(join(clientDir, "index.html"), "<html></html>", "utf-8");
    writeFileSync(join(clientDir, "assets", "index-AbCdEf12.js"), "console.log(1)", "utf-8");
    writeFileSync(join(clientDir, "assets", "style-12345678.css"), "body{}", "utf-8");
    // Precompute the same deterministic manifest the orchestrator will derive
    // internally (same dir, same git HEAD, same content -> identical id), so
    // the mocked upload/versions-list/fetch responses can be tagged to match
    // it without the test needing to duplicate the orchestrator's own logic.
    const realManifest = buildReleaseManifest(clientDir);
    const { runner } = buildRunner({
      upload: { exitCode: 0, stdout: `Worker Version ID: ${NEW_UUID}\n`, stderr: "" },
      "versions-list": {
        exitCode: 0,
        stdout: JSON.stringify([
          { id: OLD_UUID, annotations: { "workers/tag": OLD_RELEASE_ID } },
          { id: NEW_UUID, annotations: { "workers/tag": realManifest.id } },
        ]),
        stderr: "",
      },
    });
    const { fetchImpl, calls: fetchCalls } = buildFetch(
      () => new Response("ok", { status: 200, headers: { "X-Moedict-Release": realManifest.id } }),
    );
    // No staging-approval needed: staging env never checks the gate.
    const result = await runReleaseDeploy({
      ...baseOpts("staging", { runner, fetch: fetchImpl }),
      manifest: undefined,
      distClientDir: clientDir,
    });
    expect(result.releaseId).toBe(realManifest.id);
    expect(fetchCalls.some((c) => c.url.includes("/assets/index-AbCdEf12.js"))).toBe(true);
    expect(fetchCalls.some((c) => c.url.includes("/assets/style-12345678.css"))).toBe(true);
  });

  it("wraps a non-Error manifest failure via String(err) and defaults distClientDir to dist/client", async () => {
    const { runner } = buildRunner();
    const { fetchImpl } = buildFetch();
    await expect(
      runReleaseDeploy({
        ...baseOpts("staging", { runner, fetch: fetchImpl }),
        manifest: undefined,
        // distClientDir deliberately omitted → the "dist/client" default arm.
        // The injected fs throws a string primitive, not an Error — the
        // orchestrator must surface it via String(err), not err.message.
        manifestOpts: {
          fs: {
            readdirSync: () => {
              throw "boom, not an Error instance";
            },
          },
        },
      }),
    ).rejects.toThrow(/Release manifest unavailable.*boom, not an Error instance/);
  });
});

// ── prod gate / current-state validation (no mutation) ──────────────

describe("production approval gate", () => {
  it("blocks with no wrangler calls at all when no staging approval exists", async () => {
    const { runner, calls } = buildRunner();
    const { fetchImpl } = buildFetch();
    await expect(
      runReleaseDeploy(baseOpts("production", { runner, fetch: fetchImpl })),
    ).rejects.toThrow(/Production deploy blocked/);
    expect(calls).toHaveLength(0);
  });

  it("blocks on client manifest digest mismatch even when git SHA matches, with no mutation", async () => {
    saveStagingApproval(
      {
        gitSha: GIT_SHA,
        clientManifestDigest: "different-digest",
        approvedAt: "2026-07-12T00:00:00Z",
      },
      {
        baseDir: dir,
      },
    );
    const { runner, calls } = buildRunner();
    const { fetchImpl } = buildFetch();
    await expect(
      runReleaseDeploy(baseOpts("production", { runner, fetch: fetchImpl })),
    ).rejects.toThrow(/Production deploy blocked/);
    expect(calls).toHaveLength(0);
  });

  it("proceeds when staging approval matches git SHA + digest", async () => {
    saveStagingApproval(
      { gitSha: GIT_SHA, clientManifestDigest: DIGEST, approvedAt: "2026-07-12T00:00:00Z" },
      { baseDir: dir },
    );
    const { runner } = buildRunner();
    const { fetchImpl } = buildFetch();
    const result = await runReleaseDeploy(baseOpts("production", { runner, fetch: fetchImpl }));
    expect(result.releaseId).toBe(RELEASE_ID);
  });

  it("defaults env to production when omitted (gate checked, prod worker deployed)", async () => {
    saveStagingApproval(
      { gitSha: GIT_SHA, clientManifestDigest: DIGEST, approvedAt: "2026-07-12T00:00:00Z" },
      { baseDir: dir },
    );
    const { runner } = buildRunner();
    const { fetchImpl } = buildFetch();
    const { env: _env, ...opts } = baseOpts("production", { runner, fetch: fetchImpl });
    const result = await runReleaseDeploy(opts);
    expect(result).toMatchObject({ env: "production", releaseId: RELEASE_ID, versionId: NEW_UUID });
  });
});

describe("environment namespacing", () => {
  it("reads deployment state from the default releases directory when no baseDir is provided", () => {
    const prevCwd = process.cwd();
    try {
      process.chdir(dir);
      expect(readCurrentDeployment()).toBeNull();
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("keeps staging and production current/version-history state under separate <root>/<env>/ dirs", async () => {
    saveStagingApproval(
      { gitSha: GIT_SHA, clientManifestDigest: DIGEST, approvedAt: "2026-07-12T00:00:00Z" },
      { baseDir: dir },
    );
    const staging = buildRunner();
    await runReleaseDeploy(
      baseOpts("staging", { runner: staging.runner, fetch: buildFetch().fetchImpl }),
    );
    const prod = buildRunner();
    await runReleaseDeploy(
      baseOpts("production", { runner: prod.runner, fetch: buildFetch().fetchImpl }),
    );

    const stagingCurrent = readCurrentDeployment({ baseDir: join(dir, "staging") });
    const prodCurrent = readCurrentDeployment({ baseDir: join(dir, "production") });
    expect(stagingCurrent?.workerName).toBe("cf-moedict-webkit-neo-staging");
    expect(prodCurrent?.workerName).toBe("cf-moedict-webkit-neo");
    // Neither run clobbered the other's current.json.
    expect(stagingCurrent).not.toBeNull();
    expect(prodCurrent).not.toBeNull();

    const stagingHistory = readVersionHistory({ baseDir: join(dir, "staging") });
    const prodHistory = readVersionHistory({ baseDir: join(dir, "production") });
    expect(stagingHistory.length).toBeGreaterThan(0);
    expect(prodHistory.length).toBeGreaterThan(0);

    // Staging approval itself stays shared (unnamespaced) so production can read it.
    expect(readStagingApproval({ baseDir: dir })).not.toBeNull();
    expect(readCurrentDeployment({ baseDir: dir })).toBeNull();
  });

  it("honors a custom stateBaseDir root for both the per-env state and the shared staging approval", async () => {
    const customRoot = join(dir, "custom-root");
    saveStagingApproval(
      { gitSha: GIT_SHA, clientManifestDigest: DIGEST, approvedAt: "2026-07-12T00:00:00Z" },
      { baseDir: customRoot },
    );
    const { runner } = buildRunner();
    const { fetchImpl } = buildFetch();
    await runReleaseDeploy(
      baseOpts("production", { runner, fetch: fetchImpl, stateBaseDir: customRoot }),
    );
    expect(readCurrentDeployment({ baseDir: join(customRoot, "production") })?.versionId).toBe(
      NEW_UUID,
    );
    // The default (un-namespaced) root never received anything.
    expect(readCurrentDeployment({ baseDir: join(dir, "production") })).toBeNull();
  });
});

describe("requires a safe old version before starting", () => {
  it("aborts with no upload call when the current deployment is a split state", async () => {
    const { runner, calls } = buildRunner({
      "deployments-list": deploymentsListOk([
        { version_id: OLD_UUID, percentage: 50 },
        { version_id: NEW_UUID, percentage: 50 },
      ]),
    });
    const { fetchImpl } = buildFetch();
    await expect(
      runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl })),
    ).rejects.toThrow(/split state/);
    expect(calls.some((c) => c.includes("upload"))).toBe(false);
  });
});
describe("upload confirmation (upload UUID vs versions-list tag lookup)", () => {
  it("aborts before any deploy call when the uploaded UUID mismatches the unique versions-list tag match", async () => {
    // Pre-upload existence check (call 1) finds nothing tagged yet; the
    // post-upload confirm (call 2) disagrees with what `upload` itself
    // reported — this is the CLI's own text-vs-JSON cross-check, distinct
    // from the idempotent-reuse path exercised below.
    let versionsListCall = 0;
    const { runner, calls } = buildRunner({
      "versions-list": () => {
        versionsListCall += 1;
        return versionsListCall === 1
          ? {
              exitCode: 0,
              stdout: JSON.stringify([
                { id: OLD_UUID, annotations: { "workers/tag": OLD_RELEASE_ID } },
              ]),
              stderr: "",
            }
          : {
              exitCode: 0,
              stdout: JSON.stringify([
                { id: OLD_UUID, annotations: { "workers/tag": OLD_RELEASE_ID } },
                { id: OTHER_UUID, annotations: { "workers/tag": RELEASE_ID } },
              ]),
              stderr: "",
            };
      },
    });
    const { fetchImpl } = buildFetch();
    await expect(
      runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl })),
    ).rejects.toThrow(
      `Version UUID mismatch: upload output reported ${NEW_UUID}, but versions list confirms ${OTHER_UUID} for tag ${RELEASE_ID}`,
    );
    // No traffic mutation: no mutating deploy/finalize/restore call fired (the
    // read-only "deployments-list" query from step 4 legitimately happened).
    const mutatingPhases: Record<string, true> = {
      "deploy-phase1": true,
      "deploy-promote": true,
      "deploy-rollback": true,
      "restore-old-alone": true,
      finalize: true,
    };
    expect(calls.some((c) => mutatingPhases[phaseOf(c)])).toBe(false);
    const history = readVersionHistory({ baseDir: join(dir, "staging") });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      versionId: NEW_UUID,
      tag: RELEASE_ID,
      status: VERSION_STATUS.CONFIRM_FAILED,
    });
    // Never claims success: no current-deployment state exists.
    expect(readCurrentDeployment({ baseDir: join(dir, "staging") })).toBeNull();
  });
});

// ── idempotent tag resolution (retry-safe: deterministic release IDs) ──
//
// Cloudflare version tags are reusable, not unique. Since the release ID
// is deterministic (same git SHA + client manifest digest -> same tag),
// retrying the exact same build after ANY prior partial run must reuse an
// already-uploaded version instead of uploading a duplicate — a second
// upload with the same tag would make every future lookup permanently
// ambiguous. These tests exercise the list-before-upload resolution added
// to step 5, independent of the pre-existing post-upload confirm checked
// above.
describe("idempotent tag resolution", () => {
  it("retry after a prior upload (no finalize yet): reuses the existing tagged version, never re-uploads, proceeds through new0/old100 normally", async () => {
    const { runner, calls } = buildRunner({
      "versions-list": {
        exitCode: 0,
        stdout: JSON.stringify([
          { id: OLD_UUID, annotations: { "workers/tag": OLD_RELEASE_ID } },
          { id: NEW_UUID, annotations: { "workers/tag": RELEASE_ID } },
        ]),
        stderr: "",
      },
    });
    const { fetchImpl } = buildFetch();
    const result = await runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl }));
    expect(result.versionId).toBe(NEW_UUID);
    expect(calls.some((c) => c.includes("upload"))).toBe(false);
    const phase1 = calls.find((c) => phaseOf(c) === "deploy-phase1");
    expect(phase1).toContain(`${NEW_UUID}@0%`);
    expect(phase1).toContain(`${OLD_UUID}@100%`);
    const history = readVersionHistory({ baseDir: join(dir, "staging") });
    expect(history[0]).toMatchObject({
      versionId: NEW_UUID,
      tag: RELEASE_ID,
      status: VERSION_STATUS.REUSED,
    });
  });

  it("retry after a phase-1 smoke failure: the abandoned uploaded version (rolled out of the deployment but never deleted) is found and reused, not re-uploaded", async () => {
    // Simulates a second `runReleaseDeploy` invocation after a prior run's
    // override smoke failed and restored old@100 alone: the current
    // deployment is back to a clean old@100 (from step 4's perspective),
    // but `versions list` still carries the abandoned NEW_UUID upload.
    const { runner, calls } = buildRunner({
      "versions-list": {
        exitCode: 0,
        stdout: JSON.stringify([
          { id: OLD_UUID, annotations: { "workers/tag": OLD_RELEASE_ID } },
          { id: NEW_UUID, annotations: { "workers/tag": RELEASE_ID } },
        ]),
        stderr: "",
      },
    });
    const { fetchImpl } = buildFetch();
    await runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl }));
    expect(calls.some((c) => c.includes("upload"))).toBe(false);
    expect(calls.some((c) => phaseOf(c) === "deploy-promote")).toBe(true);
    expect(calls.some((c) => phaseOf(c) === "finalize")).toBe(true);
  });

  it("current-already-release idempotency: when the sole matching tagged version is already live at 100%, returns success with zero mutating calls beyond the read-only pre-check", async () => {
    const { runner, calls } = buildRunner({
      // OLD_UUID (already the sole live version per the default
      // deployments-list fixture) is ALSO the version carrying this
      // release's tag — e.g. a CLI retry after finalize + final smoke
      // already succeeded but the process exited before returning.
      "versions-list": {
        exitCode: 0,
        stdout: JSON.stringify([{ id: OLD_UUID, annotations: { "workers/tag": RELEASE_ID } }]),
        stderr: "",
      },
    });
    const { fetchImpl, calls: fetchCalls } = buildFetch();
    const result = await runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl }));
    expect(result).toMatchObject({ versionId: OLD_UUID, alreadyCurrent: true });
    // No mutating call at all: only the read-only deployments-list and
    // versions-list queries, plus the bounded no-override final smoke.
    const mutatingPhases: Record<string, true> = {
      upload: true,
      "deploy-phase1": true,
      "deploy-promote": true,
      "deploy-rollback": true,
      "restore-old-alone": true,
      finalize: true,
    };
    expect(calls.some((c) => mutatingPhases[phaseOf(c)])).toBe(false);
    // The bounded final smoke ran WITHOUT the override header.
    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(fetchCalls.every((c) => c.override === undefined)).toBe(true);
    const current = readCurrentDeployment({ baseDir: join(dir, "staging") });
    expect(current?.versionId).toBe(OLD_UUID);
    expect(current?.percentage).toBe(100);
  });

  it("current-already-release idempotency also refreshes staging approval so production's gate sees a fresh approvedAt", async () => {
    const { runner } = buildRunner({
      "versions-list": {
        exitCode: 0,
        stdout: JSON.stringify([{ id: OLD_UUID, annotations: { "workers/tag": RELEASE_ID } }]),
        stderr: "",
      },
    });
    const { fetchImpl } = buildFetch();
    const result = await runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl }));
    const approval = readStagingApproval({ baseDir: dir });
    expect(approval).toEqual({
      gitSha: GIT_SHA,
      clientManifestDigest: DIGEST,
      approvedAt: result.deployedAt,
    });
  });

  it("current-already-release idempotency for PRODUCTION: passes the approval gate, short-circuits with zero mutation, and never writes a staging approval", async () => {
    saveStagingApproval(
      { gitSha: GIT_SHA, clientManifestDigest: DIGEST, approvedAt: "2026-07-12T00:00:00Z" },
      { baseDir: dir },
    );
    const { runner, calls } = buildRunner({
      "versions-list": {
        exitCode: 0,
        stdout: JSON.stringify([{ id: OLD_UUID, annotations: { "workers/tag": RELEASE_ID } }]),
        stderr: "",
      },
    });
    const { fetchImpl } = buildFetch();
    const result = await runReleaseDeploy(baseOpts("production", { runner, fetch: fetchImpl }));
    expect(result).toMatchObject({ versionId: OLD_UUID, alreadyCurrent: true, env: "production" });
    const mutatingPhases: Record<string, true> = {
      upload: true,
      "deploy-phase1": true,
      "deploy-promote": true,
      "deploy-rollback": true,
      "restore-old-alone": true,
      finalize: true,
    };
    expect(calls.some((c) => mutatingPhases[phaseOf(c)])).toBe(false);
    // Production idempotent short-circuit never writes a staging approval —
    // the pre-seeded one is left byte-for-byte unchanged.
    expect(readStagingApproval({ baseDir: dir })).toEqual({
      gitSha: GIT_SHA,
      clientManifestDigest: DIGEST,
      approvedAt: "2026-07-12T00:00:00Z",
    });
    const current = readCurrentDeployment({ baseDir: join(dir, "production") });
    expect(current?.versionId).toBe(OLD_UUID);
    expect(current?.percentage).toBe(100);
  });

  it("current-already-release idempotency still rolls back to nothing (throws, no false success) when the bounded final smoke fails", async () => {
    const { runner } = buildRunner({
      "versions-list": {
        exitCode: 0,
        stdout: JSON.stringify([{ id: OLD_UUID, annotations: { "workers/tag": RELEASE_ID } }]),
        stderr: "",
      },
    });
    const { fetchImpl } = buildFetch(() => new Response("err", { status: 500 }));
    await expect(
      runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl })),
    ).rejects.toThrow();
    expect(readCurrentDeployment({ baseDir: join(dir, "staging") })).toBeNull();
  });

  it("ambiguity before mutation: multiple existing versions already carry the release tag before any upload — fails closed, names both UUIDs, never mutates", async () => {
    const { runner, calls } = buildRunner({
      "versions-list": {
        exitCode: 0,
        stdout: JSON.stringify([
          { id: OLD_UUID, annotations: { "workers/tag": OLD_RELEASE_ID } },
          { id: NEW_UUID, annotations: { "workers/tag": RELEASE_ID } },
          { id: OTHER_UUID, annotations: { "workers/tag": RELEASE_ID } },
        ]),
        stderr: "",
      },
    });
    const { fetchImpl } = buildFetch();
    await expect(
      runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl })),
    ).rejects.toThrow(new RegExp(`Ambiguous.*${NEW_UUID}.*${OTHER_UUID}`, "s"));
    // Zero mutating calls: not even `upload` fired, since ambiguity is
    // detected strictly before any mutation.
    const mutatingPhases: Record<string, true> = {
      upload: true,
      "deploy-phase1": true,
      "deploy-promote": true,
      "deploy-rollback": true,
      "restore-old-alone": true,
      finalize: true,
    };
    expect(calls.some((c) => mutatingPhases[phaseOf(c)])).toBe(false);
    expect(readVersionHistory({ baseDir: join(dir, "staging") })).toHaveLength(0);
    expect(readCurrentDeployment({ baseDir: join(dir, "staging") })).toBeNull();
  });

  it("race duplicate after upload: a concurrent run tags a second version between this run's pre-check and its own upload — the post-upload confirm still catches the now-ambiguous tag and aborts before any deploy call", async () => {
    let versionsListCall = 0;
    const { runner, calls } = buildRunner({
      "versions-list": () => {
        versionsListCall += 1;
        return versionsListCall === 1
          ? {
              exitCode: 0,
              stdout: JSON.stringify([
                { id: OLD_UUID, annotations: { "workers/tag": OLD_RELEASE_ID } },
              ]),
              stderr: "",
            }
          : {
              // post-upload confirm: a concurrent run's upload landed too
              exitCode: 0,
              stdout: JSON.stringify([
                { id: OLD_UUID, annotations: { "workers/tag": OLD_RELEASE_ID } },
                { id: NEW_UUID, annotations: { "workers/tag": RELEASE_ID } },
                { id: OTHER_UUID, annotations: { "workers/tag": RELEASE_ID } },
              ]),
              stderr: "",
            };
      },
    });
    const { fetchImpl } = buildFetch();
    await expect(
      runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl })),
    ).rejects.toThrow(/Ambiguous: 2 versions found with tag/);
    const mutatingPhases: Record<string, true> = {
      "deploy-phase1": true,
      "deploy-promote": true,
      "deploy-rollback": true,
      "restore-old-alone": true,
      finalize: true,
    };
    expect(calls.some((c) => mutatingPhases[phaseOf(c)])).toBe(false);
  });
});

// ── upload / phase1 / smoke ───────────────────────────────────────────

describe("upload and phase 1", () => {
  it("uploads with --tag <release-id> and deploys new@0/old@100", async () => {
    const { runner, calls } = buildRunner();
    const { fetchImpl } = buildFetch();
    await runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl }));
    const uploadCall = calls.find((c) => c.includes("upload"));
    expect(uploadCall).toContain("--tag");
    expect(uploadCall).toContain(RELEASE_ID);
    const phase1 = calls.find((c) => c.includes(`${NEW_UUID}@0%`));
    expect(phase1).toContain(`${OLD_UUID}@100%`);
  });

  it("smokes with the exact version-override header before promotion", async () => {
    const { runner } = buildRunner();
    const { fetchImpl, calls: fetchCalls } = buildFetch();
    await runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl }));
    const overrideCalls = fetchCalls.filter((c) => c.override !== undefined);
    expect(overrideCalls.length).toBeGreaterThan(0);
    for (const c of overrideCalls) {
      expect(c.override).toBe(`cf-moedict-webkit-neo-staging="${NEW_UUID}"`);
    }
  });

  it("passes the old release tag into override smoke so only prior-release propagation is retried", async () => {
    const { runner, calls } = buildRunner();
    let overrideFetches = 0;
    const { fetchImpl } = buildFetch(({ override }) => {
      if (!override) return undefined;
      overrideFetches += 1;
      return overrideFetches === 1
        ? new Response("ok", { status: 200, headers: { "X-Moedict-Release": OLD_RELEASE_ID } })
        : undefined;
    });
    const sleepCalls: number[] = [];
    await runReleaseDeploy(
      baseOpts("staging", {
        runner,
        fetch: fetchImpl,
        sleep: async (ms: number) => {
          sleepCalls.push(ms);
        },
        overrideRetryAttempts: 2,
        overrideRetryIntervalMs: 13,
        log: () => {},
      }),
    );

    expect(overrideFetches).toBeGreaterThan(1);
    expect(sleepCalls[0]).toBe(13);
    expect(calls.some((c) => phaseOf(c) === "restore-old-alone")).toBe(false);
    expect(calls.some((c) => phaseOf(c) === "deploy-promote")).toBe(true);
  });

  it("aborts promotion and restores old@100 alone (not new@0/old@100) when smoke fails", async () => {
    const { runner, calls } = buildRunner();
    const { fetchImpl } = buildFetch(({ override }) =>
      override ? new Response("err", { status: 500 }) : undefined,
    );
    await expect(
      runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl })),
    ).rejects.toThrow(/restored .* alone/);
    expect(calls.some((c) => phaseOf(c) === "deploy-promote")).toBe(false);
    const restoreCall = calls.find((c) => phaseOf(c) === "restore-old-alone");
    expect(restoreCall).toBeTruthy();
    expect(restoreCall).toContain(`${OLD_UUID}@100%`);
    const history = readVersionHistory({ baseDir: join(dir, "staging") });
    expect(history.at(-1)).toMatchObject({ status: VERSION_STATUS.SMOKE_FAILED });
  });

  it("records RESTORE_FAILED and reports both the smoke and restore errors when the old-only restore itself also fails", async () => {
    const { runner } = buildRunner({
      "restore-old-alone": { exitCode: 1, stdout: "", stderr: "restore network error" },
    });
    const { fetchImpl } = buildFetch(({ override }) =>
      override ? new Response("err", { status: 500 }) : undefined,
    );
    await expect(
      runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl })),
    ).rejects.toThrow(/RESTORE ALSO FAILED/);
    const history = readVersionHistory({ baseDir: join(dir, "staging") });
    expect(history.at(-1)).toMatchObject({ status: VERSION_STATUS.RESTORE_FAILED });
    // Never claims success.
    expect(readCurrentDeployment({ baseDir: join(dir, "staging") })).toBeNull();
  });
});

// ── promote / probe / rollback / finalize ────────────────────────────

describe("promote, probe, rollback, finalize", () => {
  it("promotes new@100/old@0 (both live) after smoke passes", async () => {
    const { runner, calls } = buildRunner();
    const { fetchImpl } = buildFetch();
    await runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl }));
    const promote = calls.find((c) => phaseOf(c) === "deploy-promote");
    expect(promote).toContain(`${NEW_UUID}@100%`);
    expect(promote).toContain(`${OLD_UUID}@0%`);
  });

  it("rolls back to old@100/new@0 when the continuous probe fails", async () => {
    let promoted = false;
    const { runner, calls } = buildRunner({
      "deploy-promote": () => {
        promoted = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const { fetchImpl } = buildFetch(({ override }) =>
      !override && promoted ? new Response("err", { status: 500 }) : undefined,
    );
    await expect(
      runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl })),
    ).rejects.toThrow(/rolled back/);
    const rollback = calls.find((c) => phaseOf(c) === "deploy-rollback");
    expect(rollback).toContain(`${OLD_UUID}@100%`);
    expect(rollback).toContain(`${NEW_UUID}@0%`);
  });

  it("passes old release settling options into continuous probe and rolls back when old responses exhaust grace", async () => {
    let promoted = false;
    const { runner, calls } = buildRunner({
      "deploy-promote": () => {
        promoted = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const { fetchImpl } = buildFetch(({ override }) => {
      if (override || !promoted) return undefined;
      return new Response("ok", { status: 200, headers: { "X-Moedict-Release": OLD_RELEASE_ID } });
    });
    const sleepCalls: number[] = [];

    await expect(
      runReleaseDeploy(
        baseOpts("staging", {
          runner,
          fetch: fetchImpl,
          sleep: async (ms: number) => {
            sleepCalls.push(ms);
          },
          propagationGraceMs: 10,
          propagationRetryIntervalMs: 5,
          log: () => {},
        }),
      ),
    ).rejects.toThrow(/still served prior release.*rolled back/s);

    expect(sleepCalls).toEqual([5, 5]);
    const rollback = calls.find((c) => phaseOf(c) === "deploy-rollback");
    expect(rollback).toContain(`${OLD_UUID}@100%`);
    expect(rollback).toContain(`${NEW_UUID}@0%`);
  });

  it("reports both the original failure and the rollback failure when rollback itself also fails", async () => {
    let promoted = false;
    const { runner } = buildRunner({
      "deploy-promote": () => {
        promoted = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      "deploy-rollback": { exitCode: 1, stdout: "", stderr: "rollback network error" },
    });
    const { fetchImpl } = buildFetch(({ override }) =>
      !override && promoted ? new Response("err", { status: 500 }) : undefined,
    );
    await expect(
      runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl })),
    ).rejects.toThrow(/ROLLBACK ALSO FAILED/);
  });

  it("finalizes new@100 alone after the soak passes", async () => {
    const { runner, calls } = buildRunner();
    const { fetchImpl } = buildFetch();
    await runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl }));
    const finalize = calls.find((c) => phaseOf(c) === "finalize");
    expect(finalize).toEqual(
      expect.arrayContaining(["versions", "deploy", `${NEW_UUID}@100%`, "-y"]),
    );
    expect(finalize?.some((a) => a.includes(OLD_UUID))).toBe(false);
  });

  it("rolls back when finalize itself fails", async () => {
    const { runner, calls } = buildRunner({
      finalize: { exitCode: 1, stdout: "", stderr: "finalize error" },
    });
    const { fetchImpl } = buildFetch();
    await expect(
      runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl })),
    ).rejects.toThrow(/rolled back/);
    expect(calls.some((c) => phaseOf(c) === "deploy-rollback")).toBe(true);
  });

  it("final smoke (no override header) still requires the release header; failure triggers rollback", async () => {
    let finalizeCalled = false;
    const { runner, calls } = buildRunner({
      finalize: () => {
        finalizeCalled = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const { fetchImpl } = buildFetch(({ override }) =>
      !override && finalizeCalled
        ? new Response("ok", { status: 200, headers: { "X-Moedict-Release": "stale" } })
        : undefined,
    );
    await expect(
      runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl })),
    ).rejects.toThrow(/X-Moedict-Release.*rolled back/s);
    expect(calls.some((c) => phaseOf(c) === "deploy-rollback")).toBe(true);
  });
});

// ── soak duration ──────────────────────────────────────────────────

it("soaks for at least 120s by default (24 sleeps of 5000ms) when soak options are not overridden", async () => {
  const { runner } = buildRunner();
  const { fetchImpl } = buildFetch();
  const sleepCalls: number[] = [];
  await runReleaseDeploy({
    ...baseOpts("staging", { runner, fetch: fetchImpl }),
    soakIntervalMs: undefined,
    soakDurationMs: undefined,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
    },
  });
  expect(sleepCalls).toHaveLength(24);
  expect(sleepCalls.every((ms) => ms === 5000)).toBe(true);
});

it("sleeps propagationSleepMs (default 30s) after each versions-deploy before the next probe phase", async () => {
  const timeline: string[] = [];
  const { runner } = buildRunner({}, (phase) => timeline.push(`runner:${phase}`));
  const { fetchImpl } = buildFetch(({ override }) => {
    timeline.push(override ? "fetch:override" : "fetch:plain");
    return undefined;
  });
  const sleepCalls: number[] = [];
  await runReleaseDeploy({
    ...baseOpts("staging", { runner, fetch: fetchImpl }),
    propagationSleepMs: 7000,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
    },
  });
  // Three propagation sleeps: after phase1, after promote, after finalize.
  // Interleaved with soak sleeps (soakIntervalMs=1 from baseOpts → one 1ms sleep).
  expect(sleepCalls.filter((ms) => ms === 7000)).toHaveLength(3);
  expect(sleepCalls[0]).toBe(7000); // first is always post-phase1, before override smoke
  const firstOverrideFetch = timeline.indexOf("fetch:override");
  expect(timeline.indexOf("runner:deploy-phase1")).toBeLessThan(firstOverrideFetch);
  // Soak sleeps remain the short interval, not the propagation value.
  expect(sleepCalls.some((ms) => ms === 1)).toBe(true);
  expect(sleepCalls.every((ms) => ms === 7000 || ms === 1)).toBe(true);
});

it("defaults the propagation wait to 30s (three sleeps: post-phase1, post-promote, post-finalize)", async () => {
  const { runner } = buildRunner();
  const { fetchImpl } = buildFetch();
  const sleepCalls: number[] = [];
  await runReleaseDeploy({
    ...baseOpts("staging", { runner, fetch: fetchImpl }),
    propagationSleepMs: undefined,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
    },
  });
  expect(sleepCalls.filter((ms) => ms === 30000)).toHaveLength(3);
});

it("uses the real global fetch when none is injected", async () => {
  const { runner } = buildRunner();
  const fetchCalls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    fetchCalls.push(String(url));
    return new Response("ok", { status: 200, headers: { "X-Moedict-Release": RELEASE_ID } });
  });
  try {
    const result = await runReleaseDeploy(baseOpts("staging", { runner }));
    expect(result.versionId).toBe(NEW_UUID);
    expect(fetchCalls.length).toBeGreaterThan(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("defaults stateBaseDir to cwd-relative .wrangler/releases", async () => {
  const { runner } = buildRunner();
  const { fetchImpl } = buildFetch();
  const scratch = mkdtempSync(join(tmpdir(), "moedict-release-cwd-"));
  const prevCwd = process.cwd();
  try {
    process.chdir(scratch);
    const result = await runReleaseDeploy({
      ...baseOpts("staging", { runner, fetch: fetchImpl }),
      stateBaseDir: undefined,
    });
    expect(result.versionId).toBe(NEW_UUID);
  } finally {
    process.chdir(prevCwd);
  }
  const current = readCurrentDeployment({
    baseDir: join(scratch, ".wrangler", "releases", "staging"),
  });
  expect(current?.versionId).toBe(NEW_UUID);
  const approval = readStagingApproval({ baseDir: join(scratch, ".wrangler", "releases") });
  expect(approval?.gitSha).toBe(GIT_SHA);
  rmSync(scratch, { recursive: true, force: true });
});

// ── state persistence ──────────────────────────────────────────────

describe("state persistence", () => {
  it("saves version history, current deployment, and staging approval only after final smoke passes (staging)", async () => {
    const { runner } = buildRunner();
    const { fetchImpl } = buildFetch();
    const result = await runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl }));
    const current = readCurrentDeployment({ baseDir: join(dir, "staging") });
    expect(current?.versionId).toBe(NEW_UUID);
    expect(current?.percentage).toBe(100);
    const approval = readStagingApproval({ baseDir: dir });
    expect(approval).toEqual({
      gitSha: GIT_SHA,
      clientManifestDigest: DIGEST,
      approvedAt: result.deployedAt,
    });
  });

  it("does not save current deployment or staging approval when the final smoke fails (no false success)", async () => {
    let finalizeCalled = false;
    const { runner } = buildRunner({
      finalize: () => {
        finalizeCalled = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const { fetchImpl } = buildFetch(({ override }) =>
      !override && finalizeCalled ? new Response("err", { status: 500 }) : undefined,
    );
    await expect(
      runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl })),
    ).rejects.toThrow();
    expect(readCurrentDeployment({ baseDir: join(dir, "staging") })).toBeNull();
    expect(readStagingApproval({ baseDir: dir })).toBeNull();
  });

  it("does not save a production current-deployment as staging approval", async () => {
    saveStagingApproval(
      { gitSha: GIT_SHA, clientManifestDigest: DIGEST, approvedAt: "2026-07-12T00:00:00Z" },
      { baseDir: dir },
    );
    const { runner } = buildRunner();
    const { fetchImpl } = buildFetch();
    await runReleaseDeploy(baseOpts("production", { runner, fetch: fetchImpl }));
    const approval = readStagingApproval({ baseDir: dir });
    // Unchanged from the pre-seeded staging approval — production never writes it.
    expect(approval?.approvedAt).toBe("2026-07-12T00:00:00Z");
  });
});

// ── fail-clear on missing Task 2 output ──────────────────────────────

describe("fails clearly when Task 2 build output is absent", () => {
  it("fails clearly when the generated Wrangler config is absent", async () => {
    const { runner } = buildRunner();
    const { fetchImpl } = buildFetch();
    await expect(
      runReleaseDeploy({
        ...baseOpts("staging", { runner, fetch: fetchImpl }),
        config: undefined,
        configPath: join(dir, "does-not-exist.json"),
      }),
    ).rejects.toThrow(/Task 2 build output required/);
  });

  it("fails clearly when the release manifest / dist/client build output is absent", async () => {
    const { runner } = buildRunner();
    const { fetchImpl } = buildFetch();
    await expect(
      runReleaseDeploy({
        ...baseOpts("staging", { runner, fetch: fetchImpl }),
        manifest: undefined,
        distClientDir: join(dir, "does-not-exist"),
      }),
    ).rejects.toThrow(/Task 2 build\/publish output required/);
  });
});

// ── malformed CLI JSON / runner failure propagation ───────────────────

describe("malformed CLI output and runner failures", () => {
  it("propagates malformed versions-list JSON (fires on the pre-upload existence check, the first call to this phase)", async () => {
    const { runner } = buildRunner({
      "versions-list": { exitCode: 0, stdout: "not json", stderr: "" },
    });
    const { fetchImpl } = buildFetch();
    await expect(
      runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl })),
    ).rejects.toThrow(/malformed JSON/);
  });

  it("propagates a runner rejection (e.g. ENOENT / signal failure) from any wrangler call", async () => {
    const { runner } = buildRunner({
      "deployments-list": () => {
        throw new Error("ENOENT");
      },
    });
    const { fetchImpl } = buildFetch();
    await expect(
      runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl })),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("probe timeout (bounded per-request, no real waiting)", () => {
  function instantTimer() {
    const setTimeoutFn = ((cb: () => void) => {
      cb();
      return 1;
    }) as unknown as typeof setTimeout;
    const clearTimeoutFn = (() => {}) as unknown as typeof clearTimeout;
    return { setTimeoutFn, clearTimeoutFn };
  }

  function buildHangingFetch(shouldHang: (ctx: { override?: string }) => boolean) {
    const calls: Array<{ url: string; override: string | undefined }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const override = headers["Cloudflare-Workers-Version-Overrides"];
      calls.push({ url, override });
      if (shouldHang({ override })) {
        if (init?.signal?.aborted) return Promise.reject(new Error("aborted"));
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return new Response("ok", { status: 200, headers: { "X-Moedict-Release": RELEASE_ID } });
    };
    return { fetchImpl, calls };
  }

  it("a hanging phase-1 (version-override) smoke probe times out naming the route and restores old@100 alone", async () => {
    const { runner, calls } = buildRunner();
    const timer = instantTimer();
    const { fetchImpl } = buildHangingFetch(({ override }) => override !== undefined);
    await expect(
      runReleaseDeploy(
        baseOpts("staging", {
          runner,
          fetch: fetchImpl,
          setTimeoutFn: timer.setTimeoutFn,
          clearTimeoutFn: timer.clearTimeoutFn,
        }),
      ),
    ).rejects.toThrow(/Probe timed out for route \/.*restored .* alone/s);
    expect(calls.some((c) => phaseOf(c) === "restore-old-alone")).toBe(true);
    expect(calls.some((c) => phaseOf(c) === "deploy-promote")).toBe(false);
  });

  it("a hanging continuous probe fetch times out naming the route and rolls back", async () => {
    const { runner, calls } = buildRunner();
    const timer = instantTimer();
    const { fetchImpl } = buildHangingFetch(({ override }) => override === undefined);
    await expect(
      runReleaseDeploy(
        baseOpts("staging", {
          runner,
          fetch: fetchImpl,
          setTimeoutFn: timer.setTimeoutFn,
          clearTimeoutFn: timer.clearTimeoutFn,
        }),
      ),
    ).rejects.toThrow(/Probe timed out for route \/.*rolled back/s);
    expect(calls.some((c) => phaseOf(c) === "deploy-rollback")).toBe(true);
    expect(calls.some((c) => phaseOf(c) === "finalize")).toBe(false);
  });

  it("a hanging final smoke fetch (post-finalize, no override) times out naming the route and rolls back", async () => {
    let finalizeCalled = false;
    const { runner, calls } = buildRunner({
      finalize: () => {
        finalizeCalled = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const timer = instantTimer();
    const { fetchImpl } = buildHangingFetch(({ override }) => !override && finalizeCalled);
    await expect(
      runReleaseDeploy(
        baseOpts("staging", {
          runner,
          fetch: fetchImpl,
          setTimeoutFn: timer.setTimeoutFn,
          clearTimeoutFn: timer.clearTimeoutFn,
        }),
      ),
    ).rejects.toThrow(/Probe timed out for route \/.*rolled back/s);
    expect(calls.some((c) => phaseOf(c) === "finalize")).toBe(true);
    expect(calls.some((c) => phaseOf(c) === "deploy-rollback")).toBe(true);
  });
});

// ── exact call order ──────────────────────────────────────────────────

it("executes phases in the exact required order for a full success run", async () => {
  const timeline: string[] = [];
  const { runner } = buildRunner({}, (phase) => timeline.push(`runner:${phase}`));
  const { fetchImpl } = buildFetch(({ override }) => {
    timeline.push(override ? "fetch:override" : "fetch:plain");
    return undefined;
  });
  await runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl }));
  expect(timeline).toEqual([
    "runner:deployments-list",
    "runner:versions-list",
    "runner:upload",
    "runner:versions-list",
    "runner:deploy-phase1",
    "fetch:override",
    "fetch:override",
    "fetch:override",
    "fetch:override",
    "fetch:override",
    "runner:deploy-promote",
    "fetch:plain",
    "fetch:plain",
    "fetch:plain",
    "fetch:plain",
    "fetch:plain",
    "fetch:plain",
    "fetch:plain",
    "fetch:plain",
    "fetch:plain",
    "fetch:plain",
    "runner:finalize",
    "fetch:plain",
    "fetch:plain",
    "fetch:plain",
    "fetch:plain",
    "fetch:plain",
  ]);
});
