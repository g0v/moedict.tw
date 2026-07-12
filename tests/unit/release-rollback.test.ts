/// <reference types="node" />
/**
 * Unit tests for the emergency single-target rollback CLI
 * (scripts/release-rollback.mjs). Fully dependency-injected: mocked
 * wrangler runner, mocked fetch, real temp state dir (exercises the real
 * atomic deployment-state read/write path). No real Wrangler CLI, network,
 * `dist/client` build output, or `.wrangler/releases/` writes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { CORE_ROUTES, runReleaseRollback } from "../../scripts/release-rollback.mjs";
import {
  readCurrentDeployment,
  readVersionHistory,
  VERSION_STATUS,
} from "../../scripts/lib/deployment-state.mjs";

const TARGET_UUID = "44444444-4444-4444-8444-444444444444";
const CURRENT_UUID = "55555555-5555-4555-8555-555555555555";
const OTHER_UUID = "66666666-6666-4666-8666-666666666666";
const TARGET_TAG = "abc1234-target123456";

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

function versionsListOk(
  entries: Array<{ id: string; tag?: string }> = [{ id: TARGET_UUID, tag: TARGET_TAG }],
) {
  return {
    exitCode: 0,
    stdout: JSON.stringify(
      entries.map((e) => ({ id: e.id, annotations: e.tag ? { "workers/tag": e.tag } : {} })),
    ),
    stderr: "",
  };
}

const DEFAULT_RESPONSES: Record<string, { exitCode: number; stdout: string; stderr: string }> = {
  "deployments-list": deploymentsListOk([{ version_id: CURRENT_UUID, percentage: 100 }]),
  "versions-list": versionsListOk(),
  "deploy-target100-current0": { exitCode: 0, stdout: "", stderr: "" },
  "finalize-target100": { exitCode: 0, stdout: "", stderr: "" },
  "restore-current100-target0": { exitCode: 0, stdout: "", stderr: "" },
};

function phaseOf(argv: string[]): string {
  if (argv.includes("deployments") && argv.includes("list")) return "deployments-list";
  if (argv.includes("versions") && argv.includes("list")) return "versions-list";
  const specTokens = argv.filter((a) => a.includes("@") && a.endsWith("%"));
  if (specTokens.length === 1 && specTokens[0] === `${TARGET_UUID}@100%`)
    return "finalize-target100";
  if (specTokens[0] === `${TARGET_UUID}@100%` && specTokens[1] === `${CURRENT_UUID}@0%`)
    return "deploy-target100-current0";
  if (specTokens[0] === `${CURRENT_UUID}@100%` && specTokens[1] === `${TARGET_UUID}@0%`)
    return "restore-current100-target0";
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

function buildFetch(handler?: (ctx: { url: string; index: number }) => Response | undefined) {
  const calls: Array<{ url: string }> = [];
  const fetchImpl = async (url: string) => {
    calls.push({ url });
    const custom = handler?.({ url, index: calls.length - 1 });
    return (
      custom ?? new Response("ok", { status: 200, headers: { "X-Moedict-Release": TARGET_TAG } })
    );
  };
  return { fetchImpl, calls };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "moedict-release-rollback-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeCounterNowIso() {
  let n = 0;
  return () => new Date(Date.UTC(2026, 6, 12, 1, 0, n++)).toISOString();
}

function baseOpts(env: "production" | "staging", overrides: Record<string, unknown> = {}) {
  return {
    env,
    config: env === "production" ? PROD_CONFIG : STAGING_CONFIG,
    baseUrl: "https://probe.test",
    nowIso: makeCounterNowIso(),
    stateBaseDir: dir,
    ...overrides,
  };
}

it("is import-safe: runReleaseRollback is exported as a plain function with no side effects on import", () => {
  expect(typeof runReleaseRollback).toBe("function");
});

it("exposes CORE_ROUTES as exactly the three fixed, non-hashed routes", () => {
  expect(CORE_ROUTES).toEqual(["/", "/api/config", "/api/%E8%90%8C.json"]);
});

describe("input validation", () => {
  it("throws when no target UUID is provided", async () => {
    await expect(
      runReleaseRollback(undefined as unknown as string, baseOpts("staging")),
    ).rejects.toThrow(/explicit target version UUID/);
  });

  it("throws when the target UUID is empty", async () => {
    await expect(runReleaseRollback("", baseOpts("staging"))).rejects.toThrow(
      /explicit target version UUID/,
    );
  });

  it("throws on a malformed (non-UUID) target argument before any wrangler call", async () => {
    const { runner, calls } = buildRunner();
    await expect(runReleaseRollback("not-a-uuid", baseOpts("staging", { runner }))).rejects.toThrow(
      /Invalid version UUID/,
    );
    expect(calls).toHaveLength(0);
  });

  it("throws on an unsupported CLOUDFLARE_ENV", async () => {
    await expect(
      runReleaseRollback(TARGET_UUID, baseOpts("staging", { env: "bogus" })),
    ).rejects.toThrow(/Unsupported CLOUDFLARE_ENV/);
  });

  it("falls back to a real Date-based nowIso when none is injected", async () => {
    const { runner } = buildRunner();
    const { fetchImpl } = buildFetch();
    const before = Date.now();
    const result = await runReleaseRollback(TARGET_UUID, {
      ...baseOpts("staging", { runner, fetch: fetchImpl }),
      nowIso: undefined,
    });
    expect(Date.parse(result.deployedAt)).toBeGreaterThanOrEqual(before);
  });

  it("defaults to production when env is omitted", async () => {
    const { runner } = buildRunner();
    const { fetchImpl } = buildFetch();
    const result = await runReleaseRollback(TARGET_UUID, {
      config: PROD_CONFIG,
      baseUrl: "https://probe.test",
      nowIso: makeCounterNowIso(),
      stateBaseDir: dir,
      runner,
      fetch: fetchImpl,
    });
    expect(result.env).toBe("production");
  });

  it("surfaces a non-Error rejection (e.g. a thrown string) via String(err), not err.message", async () => {
    const { runner } = buildRunner();
    const rejectingFetch = () => Promise.reject("boom, not an Error instance");
    await expect(
      runReleaseRollback(TARGET_UUID, baseOpts("staging", { runner, fetch: rejectingFetch })),
    ).rejects.toThrow(/boom, not an Error instance/);
  });
});

describe("fails clearly when the generated config is missing", () => {
  it("wraps the parse error with build-output guidance", async () => {
    const { runner } = buildRunner();
    await expect(
      runReleaseRollback(TARGET_UUID, {
        ...baseOpts("staging", { runner }),
        config: undefined,
        configPath: join(dir, "does-not-exist.json"),
      }),
    ).rejects.toThrow(/Generated Wrangler config unavailable/);
  });
});

describe("refuses unsafe rollback preconditions", () => {
  it("refuses when the current deployment is a split state, before any versions-list call", async () => {
    const { runner, calls } = buildRunner({
      "deployments-list": deploymentsListOk([
        { version_id: CURRENT_UUID, percentage: 50 },
        { version_id: TARGET_UUID, percentage: 50 },
      ]),
    });
    await expect(runReleaseRollback(TARGET_UUID, baseOpts("staging", { runner }))).rejects.toThrow(
      /split state/,
    );
    expect(calls.some((c) => phaseOf(c) === "versions-list")).toBe(false);
  });

  it("refuses target === current with no mutating call", async () => {
    const { runner, calls } = buildRunner({
      "deployments-list": deploymentsListOk([{ version_id: TARGET_UUID, percentage: 100 }]),
    });
    await expect(runReleaseRollback(TARGET_UUID, baseOpts("staging", { runner }))).rejects.toThrow(
      /already the current 100% version/,
    );
    expect(calls.some((c) => phaseOf(c) === "versions-list")).toBe(false);
    expect(calls.some((c) => phaseOf(c) === "deploy-target100-current0")).toBe(false);
  });

  it("refuses an unknown target UUID absent from versions list", async () => {
    const { runner, calls } = buildRunner({
      "versions-list": versionsListOk([{ id: OTHER_UUID, tag: "other-tag" }]),
    });
    await expect(runReleaseRollback(TARGET_UUID, baseOpts("staging", { runner }))).rejects.toThrow(
      `No version found with UUID ${TARGET_UUID}`,
    );
    expect(calls.some((c) => phaseOf(c) === "deploy-target100-current0")).toBe(false);
  });

  it("refuses a target UUID with no annotations['workers/tag']", async () => {
    const { runner, calls } = buildRunner({
      "versions-list": versionsListOk([{ id: TARGET_UUID }]),
    });
    await expect(runReleaseRollback(TARGET_UUID, baseOpts("staging", { runner }))).rejects.toThrow(
      /has no annotations\["workers\/tag"\]/,
    );
    expect(calls.some((c) => phaseOf(c) === "deploy-target100-current0")).toBe(false);
  });
});

describe("successful rollback", () => {
  it("deploys target@100/current@0 using positional specs, then finalizes target@100 alone", async () => {
    const { runner, calls } = buildRunner();
    const { fetchImpl } = buildFetch();
    const result = await runReleaseRollback(
      TARGET_UUID,
      baseOpts("staging", { runner, fetch: fetchImpl }),
    );

    const deploy = calls.find((c) => phaseOf(c) === "deploy-target100-current0");
    expect(deploy).toContain(`${TARGET_UUID}@100%`);
    expect(deploy).toContain(`${CURRENT_UUID}@0%`);
    expect(deploy).toContain("-y");
    expect(deploy?.some((a) => a.includes("--version-tag") || a.includes("--percentage"))).toBe(
      false,
    );

    const finalize = calls.find((c) => phaseOf(c) === "finalize-target100");
    expect(finalize).toEqual(
      expect.arrayContaining(["versions", "deploy", `${TARGET_UUID}@100%`, "-y"]),
    );
    expect(finalize?.some((a) => a.includes(CURRENT_UUID))).toBe(false);

    expect(result).toEqual({
      releaseId: TARGET_TAG,
      workerName: "cf-moedict-webkit-neo-staging",
      versionId: TARGET_UUID,
      env: "staging",
      deployedAt: expect.any(String),
    });
  });

  it("smokes only the fixed non-hashed core routes, without a version-override header", async () => {
    const { runner } = buildRunner();
    const { fetchImpl, calls } = buildFetch();
    await runReleaseRollback(TARGET_UUID, baseOpts("staging", { runner, fetch: fetchImpl }));
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/",
      "/api/config",
      "/api/%E8%90%8C.json",
    ]);
  });

  it("persists env-namespaced current deployment and version history only after finalize", async () => {
    const { runner } = buildRunner();
    const { fetchImpl } = buildFetch();
    const result = await runReleaseRollback(
      TARGET_UUID,
      baseOpts("production", { runner, fetch: fetchImpl }),
    );
    const current = readCurrentDeployment({ baseDir: join(dir, "production") });
    expect(current).toEqual({
      workerName: "cf-moedict-webkit-neo",
      versionId: TARGET_UUID,
      tag: TARGET_TAG,
      percentage: 100,
      deployedAt: result.deployedAt,
    });
    const history = readVersionHistory({ baseDir: join(dir, "production") });
    expect(history.at(-1)).toMatchObject({
      versionId: TARGET_UUID,
      tag: TARGET_TAG,
      status: VERSION_STATUS.FINALIZED,
    });
    // Never touches the default (un-namespaced) or the other env's state dir.
    expect(readCurrentDeployment({ baseDir: dir })).toBeNull();
    expect(readCurrentDeployment({ baseDir: join(dir, "staging") })).toBeNull();
  });

  it("executes phases in the exact required order", async () => {
    const timeline: string[] = [];
    const { runner } = buildRunner({}, (phase) => timeline.push(`runner:${phase}`));
    const { fetchImpl } = buildFetch(({ url }) => {
      timeline.push(`fetch:${new URL(url).pathname}`);
      return undefined;
    });
    await runReleaseRollback(TARGET_UUID, baseOpts("staging", { runner, fetch: fetchImpl }));
    expect(timeline).toEqual([
      "runner:deployments-list",
      "runner:versions-list",
      "runner:deploy-target100-current0",
      "fetch:/",
      "fetch:/api/config",
      "fetch:/api/%E8%90%8C.json",
      "runner:finalize-target100",
    ]);
  });
});

describe("smoke failure restores the prior state", () => {
  it("restores current@100/target@0 and reports the smoke error when smoke fails", async () => {
    const { runner, calls } = buildRunner();
    const { fetchImpl } = buildFetch(() => new Response("err", { status: 500 }));
    await expect(
      runReleaseRollback(TARGET_UUID, baseOpts("staging", { runner, fetch: fetchImpl })),
    ).rejects.toThrow(/expected 200, got 500/);
    const restore = calls.find((c) => phaseOf(c) === "restore-current100-target0");
    expect(restore).toContain(`${CURRENT_UUID}@100%`);
    expect(restore).toContain(`${TARGET_UUID}@0%`);
    // Never claims success: no current-deployment state exists.
    expect(readCurrentDeployment({ baseDir: join(dir, "staging") })).toBeNull();
    const history = readVersionHistory({ baseDir: join(dir, "staging") });
    expect(history.at(-1)).toMatchObject({
      versionId: TARGET_UUID,
      tag: TARGET_TAG,
      status: VERSION_STATUS.ROLLED_BACK,
    });
  });

  it("reports both the smoke error and the restore error when restore also fails", async () => {
    const { runner } = buildRunner({
      "restore-current100-target0": { exitCode: 1, stdout: "", stderr: "network error" },
    });
    const { fetchImpl } = buildFetch(() => new Response("err", { status: 500 }));
    await expect(
      runReleaseRollback(TARGET_UUID, baseOpts("staging", { runner, fetch: fetchImpl })),
    ).rejects.toThrow(/RESTORE ALSO FAILED/);
    const history = readVersionHistory({ baseDir: join(dir, "staging") });
    expect(history.at(-1)).toMatchObject({
      versionId: TARGET_UUID,
      tag: TARGET_TAG,
      status: VERSION_STATUS.ROLLBACK_FAILED,
    });
  });

  it("restores and fails when the release header on the live (non-override) smoke does not match the target tag", async () => {
    const { runner, calls } = buildRunner();
    const { fetchImpl } = buildFetch(
      () => new Response("ok", { status: 200, headers: { "X-Moedict-Release": "stale-tag" } }),
    );
    await expect(
      runReleaseRollback(TARGET_UUID, baseOpts("staging", { runner, fetch: fetchImpl })),
    ).rejects.toThrow(/X-Moedict-Release mismatch/);
    expect(calls.some((c) => phaseOf(c) === "restore-current100-target0")).toBe(true);
    expect(calls.some((c) => phaseOf(c) === "finalize-target100")).toBe(false);
  });
});

describe("probe timeout (bounded, no real waiting)", () => {
  it("bounds a hung smoke request with the injected timeout instead of hanging forever", async () => {
    const { runner } = buildRunner();
    const hangingFetch = (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (signal?.aborted) return Promise.reject(new Error("aborted"));
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
    // Fires the abort callback synchronously, like a real setTimeout would
    // eventually do, without any real wall-clock wait.
    const setTimeoutFn = ((fn: () => void) => {
      fn();
      return 1 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;
    const clearTimeoutFn = (() => {}) as typeof clearTimeout;

    await expect(
      runReleaseRollback(TARGET_UUID, {
        ...baseOpts("staging", { runner, fetch: hangingFetch }),
        probeTimeoutMs: 10,
        setTimeoutFn,
        clearTimeoutFn,
      }),
    ).rejects.toThrow(/Probe timed out for route \//);
  });
});
