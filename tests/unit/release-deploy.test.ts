/// <reference types="node" />
/**
 * Unit tests for the two-phase deployment orchestrator
 * (scripts/release-deploy.mjs). Fully dependency-injected: mocked wrangler
 * runner, mocked fetch, fake sleep, real temp state dir (exercises the real
 * atomic deployment-state read/write path). No real Wrangler CLI, network,
 * or `.wrangler/releases/` writes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  deriveProbeRoutes,
  resolveBaseUrl,
  runReleaseDeploy,
} from "../../scripts/release-deploy.mjs";
import {
  readCurrentDeployment,
  readStagingApproval,
  saveStagingApproval,
} from "../../scripts/lib/deployment-state.mjs";

const NEW_UUID = "11111111-1111-4111-8111-111111111111";
const OLD_UUID = "22222222-2222-4222-8222-222222222222";
const RELEASE_ID = "abc1234-def012345678";
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
    stdout: JSON.stringify([{ id: NEW_UUID, annotations: { "workers/tag": RELEASE_ID } }]),
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
  const runner = async (argv: string[]) => {
    calls.push(argv);
    const phase = phaseOf(argv);
    onCall?.(phase, argv);
    const override = overrides[phase];
    if (override) {
      return typeof override === "function" ? override(argv, calls.length) : override;
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
});

it("is import-safe: runReleaseDeploy is exported as a plain function with no side effects on import", () => {
  expect(typeof runReleaseDeploy).toBe("function");
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

// ── state persistence ──────────────────────────────────────────────

describe("state persistence", () => {
  it("saves version history, current deployment, and staging approval only after final smoke passes (staging)", async () => {
    const { runner } = buildRunner();
    const { fetchImpl } = buildFetch();
    const result = await runReleaseDeploy(baseOpts("staging", { runner, fetch: fetchImpl }));
    const current = readCurrentDeployment({ baseDir: dir });
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
    expect(readCurrentDeployment({ baseDir: dir })).toBeNull();
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
  it("propagates malformed versions-list JSON from the confirm-tag step", async () => {
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
