/// <reference types="node" />
/**
 * Unit tests for atomic deployment state under `.wrangler/releases/`
 * (scripts/lib/deployment-state.mjs).
 *
 * Uses real temp directories (mkdtempSync) rather than an in-memory fs
 * adapter so the atomic temp-write+rename behavior is exercised against a
 * real filesystem, matching the r2-upload.test.ts / release-manifest.test.ts
 * convention of real fs for filesystem-shaped modules.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  VERSION_STATUS,
  checkStagingApprovalGate,
  readCurrentDeployment,
  readStagingApproval,
  readVersionHistory,
  saveCurrentDeployment,
  saveStagingApproval,
  saveVersionEntry,
} from "../../scripts/lib/deployment-state.mjs";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "moedict-release-state-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CURRENT = {
  workerName: "cf-moedict-webkit-neo",
  versionId: "11111111-1111-4111-8111-111111111111",
  tag: "abc1234-def012345678",
  percentage: 100,
  deployedAt: "2026-07-12T00:00:00.000Z",
};

// ── saveCurrentDeployment / readCurrentDeployment ───────────────────

describe("saveCurrentDeployment / readCurrentDeployment", () => {
  it("writes current deployment state to <baseDir>/current.json", () => {
    saveCurrentDeployment(CURRENT, { baseDir: dir });
    const filePath = join(dir, "current.json");
    expect(existsSync(filePath)).toBe(true);
    expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual(CURRENT);
  });

  it("reads back the saved current deployment state", () => {
    saveCurrentDeployment(CURRENT, { baseDir: dir });
    expect(readCurrentDeployment({ baseDir: dir })).toEqual(CURRENT);
  });

  it("returns null when the state file does not exist", () => {
    expect(readCurrentDeployment({ baseDir: dir })).toBeNull();
  });

  it("writes atomically via temp-file-then-rename, leaving no temp file behind", () => {
    saveCurrentDeployment(CURRENT, { baseDir: dir });
    const entries = readdirSync(dir);
    expect(entries).toEqual(["current.json"]);
    expect(entries.some((f) => f.includes(".tmp-"))).toBe(false);
  });

  it("never overwrites current.json with a corrupt write: rejects invalid state before touching disk", () => {
    expect(() =>
      saveCurrentDeployment({ ...CURRENT, percentage: 150 }, { baseDir: dir }),
    ).toThrow();
    expect(existsSync(join(dir, "current.json"))).toBe(false);
  });

  it("throws (fails closed) on a corrupt current.json rather than treating it as absent", () => {
    saveCurrentDeployment(CURRENT, { baseDir: dir });
    writeFileSync(join(dir, "current.json"), "{not valid json", "utf-8");
    expect(() => readCurrentDeployment({ baseDir: dir })).toThrow(/Corrupt/);
  });

  it("throws on a schema-invalid current.json (fails closed)", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "current.json"), JSON.stringify({ workerName: "x" }), "utf-8");
    expect(() => readCurrentDeployment({ baseDir: dir })).toThrow();
  });
});

// ── saveVersionEntry ─────────────────────────────────────────────────

describe("saveVersionEntry", () => {
  const entry1 = {
    versionId: "11111111-1111-4111-8111-111111111111",
    tag: "abc1234-def012345678",
    uploadedAt: "2026-07-12T00:00:00.000Z",
    status: VERSION_STATUS.UPLOADED,
  };
  const entry2 = {
    versionId: "11111111-1111-4111-8111-111111111111",
    tag: "abc1234-def012345678",
    uploadedAt: "2026-07-12T00:05:00.000Z",
    status: VERSION_STATUS.FINALIZED,
  };

  it("appends to <baseDir>/versions.json", () => {
    saveVersionEntry(entry1, { baseDir: dir });
    const history = JSON.parse(readFileSync(join(dir, "versions.json"), "utf-8"));
    expect(history).toEqual([entry1]);
  });

  it("appends a second entry without losing the first", () => {
    saveVersionEntry(entry1, { baseDir: dir });
    saveVersionEntry(entry2, { baseDir: dir });
    const history = JSON.parse(readFileSync(join(dir, "versions.json"), "utf-8"));
    expect(history).toEqual([entry1, entry2]);
  });

  it("does not lose an update when two appends are issued without awaiting between them", async () => {
    // saveVersionEntry is fully synchronous — Node's run-to-completion
    // semantics mean these two calls, even fired inside Promise.all with no
    // await between them, execute strictly one after the other.
    await Promise.all([
      Promise.resolve().then(() => saveVersionEntry(entry1, { baseDir: dir })),
      Promise.resolve().then(() => saveVersionEntry(entry2, { baseDir: dir })),
    ]);
    const history = JSON.parse(readFileSync(join(dir, "versions.json"), "utf-8"));
    expect(history).toHaveLength(2);
    expect(history.map((e: { versionId: string }) => e.versionId)).toEqual([
      entry1.versionId,
      entry2.versionId,
    ]);
  });

  it("rejects an entry with an invalid status", () => {
    expect(() => saveVersionEntry({ ...entry1, status: "bogus" }, { baseDir: dir })).toThrow(
      /status/,
    );
  });

  it("readVersionHistory returns [] when versions.json does not exist", () => {
    expect(readVersionHistory({ baseDir: dir })).toEqual([]);
  });

  it("readVersionHistory returns the full appended history in order", () => {
    saveVersionEntry(entry1, { baseDir: dir });
    saveVersionEntry(entry2, { baseDir: dir });
    expect(readVersionHistory({ baseDir: dir })).toEqual([entry1, entry2]);
  });

  it("readVersionHistory throws (fails closed) on corrupt JSON", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "versions.json"), "not json", "utf-8");
    expect(() => readVersionHistory({ baseDir: dir })).toThrow(/Corrupt/);
  });

  it("readVersionHistory throws on a schema-invalid entry", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "versions.json"), JSON.stringify([{ versionId: "x" }]), "utf-8");
    expect(() => readVersionHistory({ baseDir: dir })).toThrow();
  });

  it("throws (fails closed) when versions.json is corrupt", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "versions.json"), "not json", "utf-8");
    expect(() => saveVersionEntry(entry1, { baseDir: dir })).toThrow(/Corrupt/);
  });

  it("throws when versions.json parses but is not an array", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "versions.json"), JSON.stringify({ not: "array" }), "utf-8");
    expect(() => saveVersionEntry(entry1, { baseDir: dir })).toThrow(/expected array/);
  });

  it("rejects a non-object entry, and an entry missing versionId/tag/uploadedAt individually", () => {
    expect(() => saveVersionEntry(null as never, { baseDir: dir })).toThrow(/not an object/);
    expect(() =>
      saveVersionEntry({ tag: entry1.tag, status: entry1.status } as never, { baseDir: dir }),
    ).toThrow(/versionId must be a non-empty string/);
    expect(() =>
      saveVersionEntry({ versionId: entry1.versionId, status: entry1.status } as never, {
        baseDir: dir,
      }),
    ).toThrow(/tag must be a non-empty string/);
    expect(() =>
      saveVersionEntry({ ...entry1, uploadedAt: "not-a-date" }, { baseDir: dir }),
    ).toThrow(/uploadedAt must be a valid ISO date string/);
  });

  it("cleans up the temp file and rethrows the original error when the atomic write itself fails", () => {
    const fs = {
      existsSync: () => false,
      mkdirSync: () => {},
      readFileSync: () => "",
      renameSync: () => {},
      rmSync: (_p: string, _o: unknown) => {},
      writeFileSync: () => {
        throw new Error("disk full");
      },
    };
    expect(() => saveVersionEntry(entry1, { baseDir: dir, fs })).toThrow(/disk full/);
  });

  it("readVersionHistory throws when versions.json parses but is not an array", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "versions.json"), JSON.stringify({ not: "array" }), "utf-8");
    expect(() => readVersionHistory({ baseDir: dir })).toThrow(/expected array/);
  });
});

describe("field-level schema validation (fail-closed)", () => {
  it("saveCurrentDeployment rejects a non-object state, a state missing workerName, and an invalid deployedAt", () => {
    expect(() => saveCurrentDeployment(null as never, { baseDir: dir })).toThrow(/not an object/);
    expect(() => saveCurrentDeployment({} as never, { baseDir: dir })).toThrow(
      /workerName must be a non-empty string/,
    );
    expect(() => saveCurrentDeployment({ ...CURRENT, tag: "" }, { baseDir: dir })).toThrow(
      /tag must be a non-empty string/,
    );
    expect(() =>
      saveCurrentDeployment({ ...CURRENT, deployedAt: "not-a-date" }, { baseDir: dir }),
    ).toThrow(/deployedAt must be a valid ISO date string/);
  });

  it("saveStagingApproval rejects a non-object state, a state missing gitSha, missing clientManifestDigest, and an invalid approvedAt", () => {
    const approval = {
      gitSha: "abc1234",
      clientManifestDigest: "def0123456789abc",
      approvedAt: "2026-07-12T00:00:00.000Z",
    };
    expect(() => saveStagingApproval(null as never, { baseDir: dir })).toThrow(/not an object/);
    expect(() => saveStagingApproval({} as never, { baseDir: dir })).toThrow(
      /gitSha must be a non-empty string/,
    );
    expect(() =>
      saveStagingApproval({ gitSha: approval.gitSha } as never, { baseDir: dir }),
    ).toThrow(/clientManifestDigest must be a non-empty string/);
    expect(() =>
      saveStagingApproval({ ...approval, approvedAt: "not-a-date" }, { baseDir: dir }),
    ).toThrow(/approvedAt must be a valid ISO date string/);
  });

  it("checkStagingApprovalGate requires non-empty prodGitSha and prodDigest arguments", () => {
    expect(() => checkStagingApprovalGate("", "digest", null)).toThrow(/prodGitSha is required/);
    expect(() => checkStagingApprovalGate("sha", "", null)).toThrow(/prodDigest is required/);
  });

  it("readCurrentDeployment / readStagingApproval / readVersionHistory default to the real .wrangler/releases/ dir (absent in this repo, so a safe read-only null/empty result)", () => {
    expect(readCurrentDeployment()).toBeNull();
    expect(readStagingApproval()).toBeNull();
    expect(readVersionHistory()).toEqual([]);
  });
});

// ── staging approval + gate ──────────────────────────────────────────

describe("staging approval", () => {
  const approval = {
    gitSha: "abc1234",
    clientManifestDigest: "def0123456789abc",
    approvedAt: "2026-07-12T00:00:00.000Z",
  };

  it("records and reads back staging approval state", () => {
    saveStagingApproval(approval, { baseDir: dir });
    expect(readStagingApproval({ baseDir: dir })).toEqual(approval);
  });

  it("returns null when no staging approval exists", () => {
    expect(readStagingApproval({ baseDir: dir })).toBeNull();
  });

  it("checkStagingApprovalGate passes only on matching gitSha AND digest", () => {
    expect(checkStagingApprovalGate(approval.gitSha, approval.clientManifestDigest, approval)).toBe(
      true,
    );
    expect(checkStagingApprovalGate("different-sha", approval.clientManifestDigest, approval)).toBe(
      false,
    );
    expect(checkStagingApprovalGate(approval.gitSha, "different-digest", approval)).toBe(false);
  });

  it("checkStagingApprovalGate fails closed when no staging state exists", () => {
    expect(checkStagingApprovalGate(approval.gitSha, approval.clientManifestDigest, null)).toBe(
      false,
    );
  });
});
