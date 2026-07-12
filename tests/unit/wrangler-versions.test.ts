/// <reference types="node" />
/**
 * Unit tests for the Wrangler Versions API wrapper (scripts/lib/wrangler-versions.mjs).
 *
 * Tests use an injected subprocess runner for deterministic behavior — no
 * real Wrangler CLI or network calls. Fixture JSON shapes match real
 * `wrangler versions list --json` / `wrangler deployments list --json`
 * output verified against a live account during implementation (entries use
 * `annotations["workers/tag"]`, not a top-level `tag` field; `versions
 * upload` has no --json flag and is parsed from its plain-text
 * `Worker Version ID:` line).
 */
import { describe, expect, it } from "vite-plus/test";
import {
  deployVersionSplit,
  findTagByVersionId,
  findVersionByTag,
  getCurrentDeployment,
  listVersions,
  requireSingleVersion100,
  rollbackToVersion,
  uploadVersion,
  validateConfigPath,
  validatePercentage,
  validateSpecs,
  validateVersionUuid,
  validateWorkerName,
} from "../../scripts/lib/wrangler-versions.mjs";

const CONFIG_PATH = "dist/cf_moedict_webkit_neo/wrangler.json";
const WORKER_NAME = "cf-moedict-webkit-neo";
const NEW_UUID = "11111111-1111-4111-8111-111111111111";
const OLD_UUID = "22222222-2222-4222-8222-222222222222";
const TAG = "abc1234-def012345678";

function mockRunner(response: { exitCode: number; stdout: string; stderr: string }) {
  const calls: string[][] = [];
  const runner = async (argv: string[]) => {
    calls.push(argv);
    return response;
  };
  return { runner, calls };
}

// ── validators ───────────────────────────────────────────────────────

describe("validators", () => {
  it("validateWorkerName accepts safe names, rejects empty/unsafe", () => {
    expect(() => validateWorkerName("cf-moedict-webkit-neo")).not.toThrow();
    expect(() => validateWorkerName("")).toThrow();
    expect(() => validateWorkerName("-leading-hyphen")).toThrow();
    // @ts-expect-error deliberately wrong type
    expect(() => validateWorkerName(undefined)).toThrow();
  });

  it("validateConfigPath rejects empty/non-string", () => {
    expect(() => validateConfigPath(CONFIG_PATH)).not.toThrow();
    expect(() => validateConfigPath("")).toThrow();
  });

  it("validateVersionUuid requires 8-4-4-4-12 hex format", () => {
    expect(() => validateVersionUuid(NEW_UUID)).not.toThrow();
    expect(() => validateVersionUuid("not-a-uuid")).toThrow();
    expect(() => validateVersionUuid("11111111111141118111111111111111")).toThrow();
  });

  it("validatePercentage requires an integer 0-100", () => {
    expect(() => validatePercentage(0)).not.toThrow();
    expect(() => validatePercentage(100)).not.toThrow();
    expect(() => validatePercentage(50.5)).toThrow();
    expect(() => validatePercentage(-1)).toThrow();
    expect(() => validatePercentage(101)).toThrow();
  });

  it("validateSpecs requires each entry valid AND percentages summing to 100", () => {
    expect(() =>
      validateSpecs([
        { uuid: NEW_UUID, percentage: 0 },
        { uuid: OLD_UUID, percentage: 100 },
      ]),
    ).not.toThrow();
    expect(() => validateSpecs([{ uuid: NEW_UUID, percentage: 50 }])).toThrow(/sum to 100/);
    expect(() => validateSpecs([])).toThrow();
    expect(() => validateSpecs([{ uuid: "bad", percentage: 100 }])).toThrow();
    expect(() => validateSpecs([null as never])).toThrow(/Invalid version spec/);
  });
});

// ── uploadVersion ────────────────────────────────────────────────────

describe("uploadVersion", () => {
  it("calls wrangler versions upload with --config, --tag, no --json, correct path", async () => {
    const { runner, calls } = mockRunner({
      exitCode: 0,
      stdout: `Total Upload: 123.45 KiB / gzip: 45.67 KiB\nUploaded ${WORKER_NAME} (1.23 sec)\nWorker Version ID: ${NEW_UUID}\n`,
      stderr: "",
    });
    const uuid = await uploadVersion(CONFIG_PATH, TAG, { runner });
    expect(uuid).toBe(NEW_UUID);
    const args = calls[0];
    expect(args.slice(0, 3)).toEqual(["vp", "exec", "wrangler"]);
    expect(args).toContain("versions");
    expect(args).toContain("upload");
    expect(args).toContain("--config");
    expect(args).toContain(CONFIG_PATH);
    expect(args).toContain("--tag");
    expect(args).toContain(TAG);
    // versions upload has NO --json flag on this wrangler version — never emit it.
    expect(args).not.toContain("--json");
  });

  it("throws with clear bootstrap message when wrangler rejects the version_metadata binding", async () => {
    const { runner } = mockRunner({
      exitCode: 1,
      stdout: "",
      stderr: "Unknown binding type: version_metadata is not supported for this account",
    });
    await expect(uploadVersion(CONFIG_PATH, TAG, { runner })).rejects.toThrow(
      /bootstrap experiment/,
    );
  });

  it("throws a generic error on other non-zero exit codes", async () => {
    const { runner } = mockRunner({ exitCode: 1, stdout: "", stderr: "network error" });
    await expect(uploadVersion(CONFIG_PATH, TAG, { runner })).rejects.toThrow(
      /versions upload failed/,
    );
  });

  it("throws when no Worker Version ID line is found in successful output", async () => {
    const { runner } = mockRunner({ exitCode: 0, stdout: "Uploaded ok\n", stderr: "" });
    await expect(uploadVersion(CONFIG_PATH, TAG, { runner })).rejects.toThrow(
      /no "Worker Version ID:" line/,
    );
  });

  it("rejects an unsafe tag before ever calling the runner", async () => {
    const { runner, calls } = mockRunner({ exitCode: 0, stdout: "", stderr: "" });
    await expect(uploadVersion(CONFIG_PATH, "../escape", { runner })).rejects.toThrow();
    expect(calls.length).toBe(0);
  });
});

// ── deployVersionSplit / rollbackToVersion ──────────────────────────

describe("deployVersionSplit", () => {
  it("deploys new@0/old@100 for phase 1 using positional specs, -y, never --version-tag/--percentage", async () => {
    const { runner, calls } = mockRunner({ exitCode: 0, stdout: "", stderr: "" });
    await deployVersionSplit(
      CONFIG_PATH,
      [
        { uuid: NEW_UUID, percentage: 0 },
        { uuid: OLD_UUID, percentage: 100 },
      ],
      { runner },
    );
    const args = calls[0];
    expect(args.slice(0, 3)).toEqual(["vp", "exec", "wrangler"]);
    expect(args).toEqual([
      "vp",
      "exec",
      "wrangler",
      "versions",
      "deploy",
      "--config",
      CONFIG_PATH,
      `${NEW_UUID}@0%`,
      `${OLD_UUID}@100%`,
      "-y",
    ]);
    expect(args).not.toContain("--version-tag");
    expect(args).not.toContain("--percentage");
  });

  it("promotes new@100/old@0 for phase 2 step 1", async () => {
    const { runner, calls } = mockRunner({ exitCode: 0, stdout: "", stderr: "" });
    await deployVersionSplit(
      CONFIG_PATH,
      [
        { uuid: NEW_UUID, percentage: 100 },
        { uuid: OLD_UUID, percentage: 0 },
      ],
      { runner },
    );
    expect(calls[0]).toContain(`${NEW_UUID}@100%`);
    expect(calls[0]).toContain(`${OLD_UUID}@0%`);
  });

  it("finalizes new@100 alone after soak", async () => {
    const { runner, calls } = mockRunner({ exitCode: 0, stdout: "", stderr: "" });
    await deployVersionSplit(CONFIG_PATH, [{ uuid: NEW_UUID, percentage: 100 }], { runner });
    expect(calls[0]).toEqual([
      "vp",
      "exec",
      "wrangler",
      "versions",
      "deploy",
      "--config",
      CONFIG_PATH,
      `${NEW_UUID}@100%`,
      "-y",
    ]);
  });

  it("throws on non-zero exit code", async () => {
    const { runner } = mockRunner({ exitCode: 1, stdout: "", stderr: "boom" });
    await expect(
      deployVersionSplit(CONFIG_PATH, [{ uuid: NEW_UUID, percentage: 100 }], { runner }),
    ).rejects.toThrow(/versions deploy failed/);
  });

  it("rejects specs that do not sum to 100 before calling the runner", async () => {
    const { runner, calls } = mockRunner({ exitCode: 0, stdout: "", stderr: "" });
    await expect(
      deployVersionSplit(CONFIG_PATH, [{ uuid: NEW_UUID, percentage: 50 }], { runner }),
    ).rejects.toThrow(/sum to 100/);
    expect(calls.length).toBe(0);
  });
});

describe("rollbackToVersion", () => {
  it("deploys old@100/new@0", async () => {
    const { runner, calls } = mockRunner({ exitCode: 0, stdout: "", stderr: "" });
    await rollbackToVersion(CONFIG_PATH, OLD_UUID, NEW_UUID, { runner });
    expect(calls[0]).toEqual([
      "vp",
      "exec",
      "wrangler",
      "versions",
      "deploy",
      "--config",
      CONFIG_PATH,
      `${OLD_UUID}@100%`,
      `${NEW_UUID}@0%`,
      "-y",
    ]);
  });
});

// ── listVersions / findVersionByTag ─────────────────────────────────

describe("listVersions", () => {
  it("calls wrangler versions list --json --name and parses the real annotations-based shape", async () => {
    const stdout = JSON.stringify([
      {
        id: NEW_UUID,
        number: 42,
        metadata: { created_on: "2026-07-12T00:00:00Z", source: "wrangler" },
        annotations: { "workers/tag": TAG },
      },
    ]);
    const { runner, calls } = mockRunner({ exitCode: 0, stdout, stderr: "" });
    const versions = await listVersions(CONFIG_PATH, WORKER_NAME, { runner });
    expect(versions).toHaveLength(1);
    expect(versions[0].id).toBe(NEW_UUID);
    const args = calls[0];
    expect(args).toContain("--json");
    expect(args).toContain("--name");
    expect(args).toContain(WORKER_NAME);
  });

  it("throws on malformed JSON", async () => {
    const { runner } = mockRunner({ exitCode: 0, stdout: "not json", stderr: "" });
    await expect(listVersions(CONFIG_PATH, WORKER_NAME, { runner })).rejects.toThrow(
      /malformed JSON/,
    );
  });

  it("throws when the JSON is not an array", async () => {
    const { runner } = mockRunner({ exitCode: 0, stdout: JSON.stringify({}), stderr: "" });
    await expect(listVersions(CONFIG_PATH, WORKER_NAME, { runner })).rejects.toThrow(
      /expected an array/,
    );
  });

  it("throws on a malformed entry (missing id)", async () => {
    const { runner } = mockRunner({
      exitCode: 0,
      stdout: JSON.stringify([{ number: 1 }]),
      stderr: "",
    });
    await expect(listVersions(CONFIG_PATH, WORKER_NAME, { runner })).rejects.toThrow(
      /malformed entry/,
    );
  });

  it("throws on non-zero exit code", async () => {
    const { runner } = mockRunner({ exitCode: 1, stdout: "", stderr: "auth error" });
    await expect(listVersions(CONFIG_PATH, WORKER_NAME, { runner })).rejects.toThrow(
      /versions list failed/,
    );
  });
});

describe("findVersionByTag", () => {
  it("finds the version whose annotations[workers/tag] matches", () => {
    const versions = [
      { id: OLD_UUID, annotations: { "workers/tag": "other-tag" } },
      { id: NEW_UUID, annotations: { "workers/tag": TAG } },
    ];
    expect(findVersionByTag(versions, TAG)).toBe(NEW_UUID);
  });

  it("throws when no version matches the tag", () => {
    expect(() => findVersionByTag([{ id: OLD_UUID, annotations: {} }], TAG)).toThrow(
      /No version found/,
    );
  });

  it("throws when versions is not an array", () => {
    expect(() => findVersionByTag(null as never, TAG)).toThrow(/must be an array/);
  });

  it("throws when multiple versions match the tag (ambiguous)", () => {
    const versions = [
      { id: OLD_UUID, annotations: { "workers/tag": TAG } },
      { id: NEW_UUID, annotations: { "workers/tag": TAG } },
    ];
    expect(() => findVersionByTag(versions, TAG)).toThrow(/Ambiguous/);
  });
});

describe("findTagByVersionId", () => {
  it("resolves the release tag for a known UUID (inverse of findVersionByTag)", () => {
    const versions = [
      { id: OLD_UUID, annotations: { "workers/tag": "other-tag" } },
      { id: NEW_UUID, annotations: { "workers/tag": TAG } },
    ];
    expect(findTagByVersionId(versions, NEW_UUID)).toBe(TAG);
  });

  it("throws when no version matches the UUID", () => {
    expect(() => findTagByVersionId([{ id: OLD_UUID, annotations: {} }], NEW_UUID)).toThrow(
      `No version found with UUID ${NEW_UUID}`,
    );
  });

  it("throws when versions is not an array", () => {
    expect(() => findTagByVersionId(null as never, NEW_UUID)).toThrow(/must be an array/);
  });

  it("throws when multiple versions share the same UUID (ambiguous)", () => {
    const versions = [
      { id: NEW_UUID, annotations: { "workers/tag": TAG } },
      { id: NEW_UUID, annotations: { "workers/tag": "dup-tag" } },
    ];
    expect(() => findTagByVersionId(versions, NEW_UUID)).toThrow(/Ambiguous/);
  });

  it("throws when the matched version has no annotations[workers/tag] (predates tagged releases)", () => {
    expect(() => findTagByVersionId([{ id: NEW_UUID, annotations: {} }], NEW_UUID)).toThrow(
      /has no annotations\["workers\/tag"\]/,
    );
  });

  it("throws when the matched version has an empty-string tag", () => {
    expect(() =>
      findTagByVersionId([{ id: NEW_UUID, annotations: { "workers/tag": "" } }], NEW_UUID),
    ).toThrow(/has no annotations\["workers\/tag"\]/);
  });

  it("validates the UUID argument before searching", () => {
    expect(() => findTagByVersionId([], "not-a-uuid")).toThrow(/Invalid version UUID/);
  });
});

// ── getCurrentDeployment / requireSingleVersion100 ──────────────────

describe("getCurrentDeployment", () => {
  it("parses deployments list --json and picks the most recent by created_on", async () => {
    const stdout = JSON.stringify([
      {
        id: "d1",
        versions: [{ version_id: OLD_UUID, percentage: 100 }],
        created_on: "2026-07-11T00:00:00Z",
      },
      {
        id: "d2",
        versions: [{ version_id: NEW_UUID, percentage: 100 }],
        created_on: "2026-07-12T00:00:00Z",
      },
    ]);
    const { runner, calls } = mockRunner({ exitCode: 0, stdout, stderr: "" });
    const current = await getCurrentDeployment(CONFIG_PATH, WORKER_NAME, { runner });
    expect(current.id).toBe("d2");
    const args = calls[0];
    expect(args).toContain("deployments");
    expect(args).toContain("list");
    expect(args).toContain("--json");
  });

  it("throws on an empty deployments array", async () => {
    const { runner } = mockRunner({ exitCode: 0, stdout: "[]", stderr: "" });
    await expect(getCurrentDeployment(CONFIG_PATH, WORKER_NAME, { runner })).rejects.toThrow(
      /non-empty array/,
    );
  });

  it("throws on a malformed entry (missing created_on)", async () => {
    const { runner } = mockRunner({
      exitCode: 0,
      stdout: JSON.stringify([{ id: "d1" }]),
      stderr: "",
    });
    await expect(getCurrentDeployment(CONFIG_PATH, WORKER_NAME, { runner })).rejects.toThrow(
      /malformed entry/,
    );
  });

  it("throws on malformed (non-JSON) output", async () => {
    const { runner } = mockRunner({ exitCode: 0, stdout: "not json", stderr: "" });
    await expect(getCurrentDeployment(CONFIG_PATH, WORKER_NAME, { runner })).rejects.toThrow(
      /malformed JSON/,
    );
  });

  it("throws on non-zero exit code", async () => {
    const { runner } = mockRunner({ exitCode: 1, stdout: "", stderr: "boom" });
    await expect(getCurrentDeployment(CONFIG_PATH, WORKER_NAME, { runner })).rejects.toThrow(
      /deployments list failed/,
    );
  });
});

describe("requireSingleVersion100", () => {
  it("returns the UUID when exactly one version is at 100%", () => {
    const deployment = {
      id: "d",
      versions: [{ version_id: OLD_UUID, percentage: 100 }],
      created_on: "x",
    };
    expect(requireSingleVersion100(deployment)).toBe(OLD_UUID);
  });

  it("tolerates 0% residue alongside a single 100% version", () => {
    const deployment = {
      id: "d",
      versions: [
        { version_id: NEW_UUID, percentage: 0 },
        { version_id: OLD_UUID, percentage: 100 },
      ],
      created_on: "x",
    };
    expect(requireSingleVersion100(deployment)).toBe(OLD_UUID);
  });

  it("rejects a positive split (ambiguous traffic)", () => {
    const deployment = {
      id: "d",
      versions: [
        { version_id: NEW_UUID, percentage: 50 },
        { version_id: OLD_UUID, percentage: 50 },
      ],
      created_on: "x",
    };
    expect(() => requireSingleVersion100(deployment)).toThrow(/split state/);
  });

  it("rejects zero positive-traffic versions", () => {
    const deployment = {
      id: "d",
      versions: [{ version_id: OLD_UUID, percentage: 0 }],
      created_on: "x",
    };
    expect(() => requireSingleVersion100(deployment)).toThrow(/split state/);
  });

  it("rejects a malformed version entry", () => {
    const deployment = { id: "d", versions: [{ percentage: 100 }], created_on: "x" };
    expect(() => requireSingleVersion100(deployment as never)).toThrow(/malformed version entry/);
  });

  it("rejects an out-of-range percentage", () => {
    const deployment = {
      id: "d",
      versions: [{ version_id: OLD_UUID, percentage: 150 }],
      created_on: "x",
    };
    expect(() => requireSingleVersion100(deployment)).toThrow(/out of range/);
  });

  it("rejects an empty versions array", () => {
    expect(() => requireSingleVersion100({ id: "d", versions: [], created_on: "x" })).toThrow(
      /no versions/,
    );
  });
});
