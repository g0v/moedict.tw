/// <reference types="node" />
/**
 * Behavioral tests locking the exact safe deploy chain in `package.json` and
 * the `version_metadata` binding shape in `wrangler.jsonc` (Task 4).
 *
 * These read the REAL repo files (not fixtures) — the point is to fail the
 * instant either file regresses, not to test a mock. `scripts/check-
 * deploy-scripts-safety.mjs` runs the same two checks as a fast CI guard;
 * this file additionally locks the EXACT script strings so env propagation
 * and command ordering can never silently drift.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parseJsonc } from "../../scripts/lib/jsonc.mjs";
import {
  checkNoBareWranglerDeploy,
  checkVersionMetadataBindings,
} from "../../scripts/check-deploy-scripts-safety.mjs";

const REPO_ROOT = join(__dirname, "..", "..");
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
const wranglerConfig = parseJsonc(
  readFileSync(join(REPO_ROOT, "wrangler.jsonc"), "utf-8"),
) as Record<string, unknown>;

describe("package.json deploy chain — exact safe ordering", () => {
  it("deploy: builds once, then publishes to R2, then rolls out — no rebuild between publish and rollout, immune to an inherited CLOUDFLARE_ENV", () => {
    expect(pkg.scripts.deploy).toBe(
      "env -u CLOUDFLARE_ENV vp run build && " +
        "env -u CLOUDFLARE_ENV node scripts/release-publish.mjs && " +
        "env -u CLOUDFLARE_ENV node scripts/release-deploy.mjs",
    );
  });

  it("deploy:staging: applies CLOUDFLARE_ENV=staging to EACH chained command, same one-build order", () => {
    expect(pkg.scripts["deploy:staging"]).toBe(
      "CLOUDFLARE_ENV=staging vp run build && " +
        "CLOUDFLARE_ENV=staging node scripts/release-publish.mjs && " +
        "CLOUDFLARE_ENV=staging node scripts/release-deploy.mjs",
    );
  });

  it("deploy:publish-only: builds once then publishes, immune to an inherited CLOUDFLARE_ENV", () => {
    expect(pkg.scripts["deploy:publish-only"]).toBe(
      "env -u CLOUDFLARE_ENV vp run build && env -u CLOUDFLARE_ENV node scripts/release-publish.mjs",
    );
  });

  it("deploy:publish-only:staging: builds once then publishes, CLOUDFLARE_ENV=staging on each command", () => {
    expect(pkg.scripts["deploy:publish-only:staging"]).toBe(
      "CLOUDFLARE_ENV=staging vp run build && CLOUDFLARE_ENV=staging node scripts/release-publish.mjs",
    );
  });

  it("deploy:rollback is a real script invoking scripts/release-rollback.mjs, immune to an inherited CLOUDFLARE_ENV", () => {
    expect(pkg.scripts["deploy:rollback"]).toBe(
      "env -u CLOUDFLARE_ENV node scripts/release-rollback.mjs",
    );
  });

  it("deploy:rollback:staging applies CLOUDFLARE_ENV=staging", () => {
    expect(pkg.scripts["deploy:rollback:staging"]).toBe(
      "CLOUDFLARE_ENV=staging node scripts/release-rollback.mjs",
    );
  });

  it("every production deploy/publish-only/rollback chain segment is prefixed with `env -u CLOUDFLARE_ENV` — fail-closed against an inherited staging env", () => {
    const productionScripts = ["deploy", "deploy:publish-only", "deploy:rollback"];
    for (const name of productionScripts) {
      const value = pkg.scripts[name] as string;
      const segments = value.split("&&").map((s: string) => s.trim());
      for (const segment of segments) {
        expect(segment.startsWith("env -u CLOUDFLARE_ENV ")).toBe(true);
      }
    }
  });

  it("no standard script contains a bare `wrangler deploy` atomic-cutover call", () => {
    expect(checkNoBareWranglerDeploy(pkg)).toEqual([]);
  });

  it("every deploy/publish/rollback script value references a real scripts/*.mjs file, never a shell one-liner stub", () => {
    const deployScriptNames = Object.keys(pkg.scripts).filter((name) => name.startsWith("deploy"));
    expect(deployScriptNames.length).toBeGreaterThan(0);
    for (const name of deployScriptNames) {
      const value = pkg.scripts[name] as string;
      expect(value).toMatch(/node scripts\/release-(publish|deploy|rollback)\.mjs/);
    }
  });
});

describe("checkNoBareWranglerDeploy — direct unit coverage of the guard function", () => {
  it("flags a bare `wrangler deploy` script", () => {
    expect(
      checkNoBareWranglerDeploy({ scripts: { deploy: "vp run build && wrangler deploy" } }),
    ).toEqual([expect.stringContaining("scripts.deploy contains bare")]);
  });

  it("flags `wrangler deploy` even with a global --env flag before it (token logic, not adjacent regex)", () => {
    expect(
      checkNoBareWranglerDeploy({
        scripts: { deploy: "wrangler --env production deploy" },
      }),
    ).toEqual([expect.stringContaining("scripts.deploy contains bare")]);
  });

  it("flags `wrangler deploy` wrapped through `vp exec` with a --config flag before it", () => {
    expect(
      checkNoBareWranglerDeploy({
        scripts: { deploy: "vp exec wrangler --config x deploy" },
      }),
    ).toEqual([expect.stringContaining("scripts.deploy contains bare")]);
  });

  it("flags bare `wrangler deploy` inside an && chain, whichever segment it's in", () => {
    expect(
      checkNoBareWranglerDeploy({
        scripts: { deploy: "vp run build && wrangler --env production deploy" },
      }),
    ).toEqual([expect.stringContaining("scripts.deploy contains bare")]);
  });

  it("does not flag `wrangler versions deploy` (a different, safe positional subcommand)", () => {
    expect(
      checkNoBareWranglerDeploy({
        scripts: { deploy: "node scripts/release-deploy.mjs" },
      }),
    ).toEqual([]);
  });

  it("does not flag `wrangler versions deploy` even with --config and -y flags interspersed", () => {
    expect(
      checkNoBareWranglerDeploy({
        scripts: {
          rollout: "wrangler versions deploy --config dist/wrangler.json abc123@100% -y",
        },
      }),
    ).toEqual([]);
  });

  it("does not flag `wrangler versions deploy` wrapped through `vp exec` with a --config flag before the subcommand", () => {
    expect(
      checkNoBareWranglerDeploy({
        scripts: { rollout: "vp exec wrangler --config x versions deploy abc123@100% -y" },
      }),
    ).toEqual([]);
  });

  it("does not flag unrelated wrangler subcommands (dev, types, r2 object get)", () => {
    expect(
      checkNoBareWranglerDeploy({
        scripts: {
          preview: "vp run build && wrangler dev",
          typegen: "wrangler types",
          fetch: "wrangler r2 object get bucket/key --remote",
        },
      }),
    ).toEqual([]);
  });

  it("does not flag a script with no wrangler invocation at all", () => {
    expect(checkNoBareWranglerDeploy({ scripts: { build: "vp run build" } })).toEqual([]);
  });

  it("reports a missing scripts object", () => {
    expect(checkNoBareWranglerDeploy({})).toEqual([expect.stringContaining("no scripts object")]);
  });

  it("ignores non-string script values", () => {
    expect(checkNoBareWranglerDeploy({ scripts: { deploy: 123 } })).toEqual([]);
  });
});

describe("wrangler.jsonc version_metadata binding shape", () => {
  it("top-level and env.staging both carry the binding, no type property", () => {
    expect(checkVersionMetadataBindings(wranglerConfig)).toEqual([]);
  });

  it("top-level version_metadata is exactly { binding: CF_VERSION_METADATA }, no extra keys", () => {
    expect(wranglerConfig.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
  });

  it("env.staging.version_metadata is exactly { binding: CF_VERSION_METADATA }, no extra keys", () => {
    const env = wranglerConfig.env as Record<string, unknown>;
    const staging = env.staging as Record<string, unknown>;
    expect(staging.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
  });
});

describe("checkVersionMetadataBindings — direct unit coverage of the guard function", () => {
  it("flags a missing top-level binding", () => {
    expect(
      checkVersionMetadataBindings({
        env: { staging: { version_metadata: { binding: "CF_VERSION_METADATA" } } },
      }),
    ).toEqual([expect.stringContaining('top-level: missing "version_metadata"')]);
  });

  it("flags a `type` property alongside binding", () => {
    const problems = checkVersionMetadataBindings({
      version_metadata: { binding: "CF_VERSION_METADATA", type: "plain_text" },
      env: { staging: { version_metadata: { binding: "CF_VERSION_METADATA" } } },
    });
    expect(problems).toEqual([expect.stringContaining('must NOT have a "type" property')]);
  });

  it("flags a wrong binding name", () => {
    const problems = checkVersionMetadataBindings({
      version_metadata: { binding: "WRONG_NAME" },
      env: { staging: { version_metadata: { binding: "CF_VERSION_METADATA" } } },
    });
    expect(problems).toEqual([expect.stringContaining("must be")]);
  });

  it("flags a missing env.staging entirely", () => {
    const problems = checkVersionMetadataBindings({
      version_metadata: { binding: "CF_VERSION_METADATA" },
    });
    expect(problems).toEqual([expect.stringContaining("env.staging is missing")]);
  });

  it("flags env.staging missing its own version_metadata (no inheritance assumed)", () => {
    const problems = checkVersionMetadataBindings({
      version_metadata: { binding: "CF_VERSION_METADATA" },
      env: { staging: {} },
    });
    expect(problems).toEqual([expect.stringContaining('env.staging: missing "version_metadata"')]);
  });

  it("flags an unexpected extra key on version_metadata", () => {
    const problems = checkVersionMetadataBindings({
      version_metadata: { binding: "CF_VERSION_METADATA", extra: true },
      env: { staging: { version_metadata: { binding: "CF_VERSION_METADATA" } } },
    });
    expect(problems).toEqual([expect.stringContaining('unexpected key "extra"')]);
  });
});
