/// <reference types="node" />
/**
 * Behavioral tests for commands/upload_dictionary.sh.
 *
 * Exercises the shell script directly with a fake `rclone` stub so no real
 * R2 calls are made. The stub records every invocation to a log file and can
 * be configured to fail N-1 times before succeeding (to test exponential retry).
 *
 * Strategy for count-gate tests: override CNS_EXPECTED_COUNT to a small
 * value (e.g. 3) and create that many actual files — avoids creating 77,208
 * files in a test while still exercising the real `find … | wc -l` gate.
 *
 * Contracts verified:
 *  1. UPLOAD_SCOPE=cns exits non-zero when by-codepoint/ dir is absent.
 *  2. UPLOAD_SCOPE=cns exits non-zero when JSON count < expected (wrong count).
 *  3. UPLOAD_SCOPE=cns exits non-zero when JSON count > expected (off-by-one).
 *  4. UPLOAD_SCOPE=cns with correct count: only rclone sync to cns/ — no
 *     pack/lang/search-index/translation-data paths.
 *  5. UPLOAD_SCOPE=all with missing pack dirs exits before any rclone call.
 *  6. RCLONE_TRANSFERS=99 is REJECTED (fail-closed, not clamped) per explicit policy.
 *  7. RCLONE_TRANSFERS=0, -1, "abc" are REJECTED (fail-closed).
 *  8. RCLONE_TRANSFERS=4 passes through (valid [1,8]).
 *  9. Static: shell constant CNS_EXPECTED_COUNT=77208 == JS EXPECTED_EMITTED.
 * 10. Behavioral: fake rclone failing N-1 times then succeeding → exponential
 *     retry wrapper makes exactly N attempts, final exit 0, no long sleeps
 *     (RCLONE_RETRY_INITIAL_MS=0 injected for test speed).
 * 11. Behavioral: fake rclone failing all 5 attempts → exit non-zero, exactly 5
 *     invocations recorded.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { EXPECTED_EMITTED } from "../../scripts/lib/cns-gen-utils.mjs";

const REPO_ROOT = join(__dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "commands", "upload_dictionary.sh");

// ── Test infrastructure ──────────────────────────────────────────────────────

let tempRoot: string;
let fakeRcloneLog: string;
let fakeVpLog: string;
let fakeBin: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "moedict-upload-test-"));
  fakeRcloneLog = join(tempRoot, "rclone-calls.log");
  fakeBin = join(tempRoot, "bin");
  mkdirSync(fakeBin, { recursive: true });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

/**
 * Build a synthetic CNS corpus with exactly `count` JSON files.
 * Layout: <root>/<2-char-shard>/<4-char-hex>.json
 */
function buildCnsCorpus(root: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const hex = i.toString(16).toUpperCase().padStart(4, "0");
    const shard = hex.slice(0, 2);
    mkdirSync(join(root, shard), { recursive: true });
    writeFileSync(join(root, shard, `${hex}.json`), `{"n":${i}}`);
  }
}

/**
 * Write a fake rclone stub that optionally fails the first `failFirst` invocations
 * before succeeding. Records every call to fakeRcloneLog.
 */
function writeFakeRclone(failFirst: number = 0): void {
  const script = `#!/bin/bash
echo "$@" >> "${fakeRcloneLog}"
# Track attempt count via a counter file
COUNT_FILE="${fakeRcloneLog}.count"
ATTEMPT=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
ATTEMPT=$((ATTEMPT + 1))
echo "$ATTEMPT" > "$COUNT_FILE"
if [ "$ATTEMPT" -le ${failFirst} ]; then
  echo "fake rclone: failing attempt $ATTEMPT (of ${failFirst} planned failures)" >&2
  exit 1
fi
exit 0
`;
  writeFileSync(join(fakeBin, "rclone"), script, { mode: 0o755 });
}

function writeFakeVp(): void {
  const script = `#!/bin/bash
echo "$@" >> "${fakeVpLog}"
if [ "\${VP_CHECK_FAIL:-0}" = "1" ]; then exit 1; fi
exit 0
`;
  writeFileSync(join(fakeBin, "vp"), script, { mode: 0o755 });
}

/**
 * Run the upload script with a controlled environment.
 */
function runScript(opts: {
  env?: Record<string, string>;
  cwd?: string;
  input?: string;
  cnsExpectedCount?: number;
  failFirst?: number;
}): {
  status: number | null;
  stdout: string;
  stderr: string;
  rcloneCalls: string[];
  vpCalls: string[];
} {
  const cwd = opts.cwd ?? tempRoot;
  fakeVpLog = join(tempRoot, "vp-calls.log");
  const env: Record<string, string> = {
    PATH: `${fakeBin}:/usr/bin:/bin:/usr/local/bin`,
    HOME: tempRoot,
    TERM: "dumb",
    R2_REMOTE: "fake-r2",
    R2_BUCKET: "fake-bucket",
    ...(opts.env ?? {}),
  };
  writeFakeRclone(opts.failFirst ?? 0);
  writeFakeVp();
  const scriptSrc = readFileSync(SCRIPT, "utf-8");
  const patchedCount = opts.cnsExpectedCount ?? EXPECTED_EMITTED;
  const patched = scriptSrc
    .replace(/^CNS_EXPECTED_COUNT=\d+/m, `CNS_EXPECTED_COUNT=${patchedCount}`)
    .replaceAll(
      "node scripts/verify-cns-manifest.mjs",
      `node ${join(REPO_ROOT, "scripts/verify-cns-manifest.mjs")}`,
    );
  const patchedScript = join(tempRoot, "upload_dictionary_patched.sh");
  writeFileSync(patchedScript, patched, { mode: 0o755 });
  const cnsManifest = join(tempRoot, "cns-manifest.json");
  writeFileSync(cnsManifest, JSON.stringify({ expected_emitted: patchedCount }));
  env.CNS_MANIFEST = cnsManifest;
  env.CNS_ROOT = join(cwd, "data", "dictionary", "cns", "by-codepoint");
  const result = spawnSync("bash", [patchedScript], {
    cwd,
    env,
    input: opts.input ?? "",
    encoding: "utf-8",
    timeout: 15_000,
  });
  const readLog = (p: string) =>
    existsSync(p)
      ? readFileSync(p, "utf-8")
          .split("\n")
          .filter((l) => l.trim().length > 0)
      : [];
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    rcloneCalls: readLog(fakeRcloneLog),
    vpCalls: readLog(fakeVpLog),
  };
}

// ── UPLOAD_SCOPE=cns — preflight count gate ───────────────────────────────────

describe("upload_dictionary.sh UPLOAD_SCOPE=cns — preflight count gate", () => {
  it("exits 1 when by-codepoint/ dir is absent — no rclone invoked", () => {
    mkdirSync(join(tempRoot, "data", "dictionary", "cns"), { recursive: true });
    const { status, stdout, rcloneCalls } = runScript({
      env: { UPLOAD_SCOPE: "cns" },
      input: "N\n",
      cnsExpectedCount: 3,
    });
    expect(status).toBe(1);
    expect(stdout).toMatch(/by-codepoint/);
    expect(rcloneCalls).toHaveLength(0);
  });

  it("exits 1 when JSON count is wrong (too few) — no rclone invoked", () => {
    const byCodepoint = join(tempRoot, "data", "dictionary", "cns", "by-codepoint");
    buildCnsCorpus(byCodepoint, 2); // expected is 3
    const { status, stdout, rcloneCalls } = runScript({
      env: { UPLOAD_SCOPE: "cns" },
      input: "N\n",
      cnsExpectedCount: 3,
    });
    expect(status).toBe(1);
    expect(stdout).toMatch(/3|期望/i);
    expect(stdout).toMatch(/2|實際/i);
    expect(rcloneCalls).toHaveLength(0);
  });

  it("exits 1 when JSON count is one less than expected — off-by-one fail closed", () => {
    const byCodepoint = join(tempRoot, "data", "dictionary", "cns", "by-codepoint");
    buildCnsCorpus(byCodepoint, 4); // expected is 5
    const { status, rcloneCalls } = runScript({
      env: { UPLOAD_SCOPE: "cns" },
      input: "N\n",
      cnsExpectedCount: 5,
    });
    expect(status).toBe(1);
    expect(rcloneCalls).toHaveLength(0);
  });

  it("exits 1 when JSON count is one more than expected — off-by-one fail closed", () => {
    const byCodepoint = join(tempRoot, "data", "dictionary", "cns", "by-codepoint");
    buildCnsCorpus(byCodepoint, 6); // expected is 5
    const { status, rcloneCalls } = runScript({
      env: { UPLOAD_SCOPE: "cns" },
      input: "N\n",
      cnsExpectedCount: 5,
    });
    expect(status).toBe(1);
    expect(rcloneCalls).toHaveLength(0);
  });
});

// ── UPLOAD_SCOPE=cns — scope isolation (correct count, cancel) ───────────────

describe("upload_dictionary.sh UPLOAD_SCOPE=cns — scope isolation", () => {
  it("correct count, cancel ('N'): dry-run rclone targets cns/ only — no pack/lang paths", () => {
    const byCodepoint = join(tempRoot, "data", "dictionary", "cns", "by-codepoint");
    buildCnsCorpus(byCodepoint, 5);
    const { status, stdout, rcloneCalls } = runScript({
      env: { UPLOAD_SCOPE: "cns" },
      input: "N\n",
      cnsExpectedCount: 5,
    });
    // "N" → cancelled, exit 0
    expect(status).toBe(0);
    expect(stdout).toMatch(/取消|cancelled/i);
    // Dry-run rclone call happened
    expect(rcloneCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of rcloneCalls) {
      expect(call).toContain("cns");
      expect(call).not.toMatch(/\bpack\b|\bpcck\b|\bphck\b|\bptck\b/);
      expect(call).not.toMatch(/\bsearch-index\b|\btranslation-data\b|\blookup\/pinyin\b/);
      // Must not target lang buckets a/c/h/t at root level
      expect(call).not.toMatch(/fake-bucket\/[acht](\s|$)/);
    }
  });

  it("correct count, confirm ('y'): dry-run + real upload both target cns/ only", () => {
    const byCodepoint = join(tempRoot, "data", "dictionary", "cns", "by-codepoint");
    buildCnsCorpus(byCodepoint, 5);
    const { status, rcloneCalls } = runScript({
      env: { UPLOAD_SCOPE: "cns" },
      input: "y\n",
      cnsExpectedCount: 5,
    });
    expect(status).toBe(0);
    // dry-run + real upload = 2 rclone calls
    expect(rcloneCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of rcloneCalls) {
      expect(call).toContain("cns");
      expect(call).not.toMatch(/\bpack\b|\bpcck\b|\bphck\b|\bptck\b/);
    }
  });

  it("correct count: preflight output contains ✅ count verification message", () => {
    const byCodepoint = join(tempRoot, "data", "dictionary", "cns", "by-codepoint");
    buildCnsCorpus(byCodepoint, 5);
    const { stdout } = runScript({
      env: { UPLOAD_SCOPE: "cns" },
      input: "N\n",
      cnsExpectedCount: 5,
    });
    expect(stdout).toMatch(/✅.*5|5.*✅/);
  });
  it("CNS scope omits canonical vp and uses only CNS manifest gate", () => {
    const byCodepoint = join(tempRoot, "data", "dictionary", "cns", "by-codepoint");
    buildCnsCorpus(byCodepoint, 2);
    const result = runScript({
      env: { UPLOAD_SCOPE: "cns", VP_CHECK_FAIL: "1" },
      cnsExpectedCount: 2,
      input: "N\n",
    });
    expect(result.status).toBe(0);
    expect(result.vpCalls).toHaveLength(0);
    expect(result.rcloneCalls.length).toBeGreaterThan(0);
  });
});

// ── UPLOAD_SCOPE=all — preflight directory checks ────────────────────────────

describe("upload_dictionary.sh UPLOAD_SCOPE=all — preflight directory checks", () => {
  it("exits 1 when data/dictionary dir is missing entirely — no rclone invoked", () => {
    const { status, rcloneCalls } = runScript({
      env: { UPLOAD_SCOPE: "all" },
      input: "N\n",
    });
    expect(status).toBe(1);
    expect(rcloneCalls).toHaveLength(0);
  });
  it("canonical vp check runs before all-scope preflight and blocks rclone on failure", () => {
    for (const dir of [
      "pack",
      "pcck",
      "phck",
      "ptck",
      "a",
      "c",
      "h",
      "t",
      "search-index",
      "translation-data",
      "lookup/pinyin",
    ]) {
      mkdirSync(join(tempRoot, "data", "dictionary", dir), { recursive: true });
    }
    const blocked = runScript({ env: { UPLOAD_SCOPE: "all", VP_CHECK_FAIL: "1" } });
    expect(blocked.status).not.toBe(0);
    expect(blocked.vpCalls.some((call) => call.includes("run check:data"))).toBe(true);
    expect(blocked.rcloneCalls).toHaveLength(0);
  });

  it("exits 1 when pack/ dir is missing — no rclone invoked", () => {
    mkdirSync(join(tempRoot, "data", "dictionary"), { recursive: true });
    const { status, rcloneCalls } = runScript({
      env: { UPLOAD_SCOPE: "all" },
      input: "N\n",
    });
    expect(status).toBe(1);
    expect(rcloneCalls).toHaveLength(0);
  });
});

// ── Concurrency validation (fail-closed for invalid values) ──────────────────

describe("upload_dictionary.sh — concurrency validation (fail-closed)", () => {
  it("RCLONE_TRANSFERS=99 is REJECTED (fail-closed, not clamped) — exits 1, no rclone", () => {
    const byCodepoint = join(tempRoot, "data", "dictionary", "cns", "by-codepoint");
    buildCnsCorpus(byCodepoint, 3);
    const { status, stdout, rcloneCalls } = runScript({
      env: { UPLOAD_SCOPE: "cns", RCLONE_TRANSFERS: "99" },
      input: "N\n",
      cnsExpectedCount: 3,
    });
    expect(status).toBe(1);
    expect(stdout).toMatch(/超出|允許範圍|fail-closed/i);
    expect(rcloneCalls).toHaveLength(0);
  });

  it("RCLONE_TRANSFERS=0 is REJECTED — exits 1, no rclone", () => {
    const byCodepoint = join(tempRoot, "data", "dictionary", "cns", "by-codepoint");
    buildCnsCorpus(byCodepoint, 3);
    const { status, rcloneCalls } = runScript({
      env: { UPLOAD_SCOPE: "cns", RCLONE_TRANSFERS: "0" },
      input: "N\n",
      cnsExpectedCount: 3,
    });
    expect(status).toBe(1);
    expect(rcloneCalls).toHaveLength(0);
  });

  it("RCLONE_TRANSFERS=-1 is REJECTED — exits 1, no rclone", () => {
    const byCodepoint = join(tempRoot, "data", "dictionary", "cns", "by-codepoint");
    buildCnsCorpus(byCodepoint, 3);
    const { status, rcloneCalls } = runScript({
      env: { UPLOAD_SCOPE: "cns", RCLONE_TRANSFERS: "-1" },
      input: "N\n",
      cnsExpectedCount: 3,
    });
    expect(status).toBe(1);
    expect(rcloneCalls).toHaveLength(0);
  });

  it("RCLONE_TRANSFERS=abc (non-numeric) is REJECTED — exits 1, no rclone", () => {
    const byCodepoint = join(tempRoot, "data", "dictionary", "cns", "by-codepoint");
    buildCnsCorpus(byCodepoint, 3);
    const { status, rcloneCalls } = runScript({
      env: { UPLOAD_SCOPE: "cns", RCLONE_TRANSFERS: "abc" },
      input: "N\n",
      cnsExpectedCount: 3,
    });
    expect(status).toBe(1);
    expect(rcloneCalls).toHaveLength(0);
  });

  it("RCLONE_CHECKERS=99 is REJECTED — exits 1, no rclone", () => {
    const byCodepoint = join(tempRoot, "data", "dictionary", "cns", "by-codepoint");
    buildCnsCorpus(byCodepoint, 3);
    const { status, rcloneCalls } = runScript({
      env: { UPLOAD_SCOPE: "cns", RCLONE_CHECKERS: "99" },
      input: "N\n",
      cnsExpectedCount: 3,
    });
    expect(status).toBe(1);
    expect(rcloneCalls).toHaveLength(0);
  });

  it("RCLONE_TRANSFERS=4 passes through: no rejection, rclone uses --transfers=4", () => {
    const byCodepoint = join(tempRoot, "data", "dictionary", "cns", "by-codepoint");
    buildCnsCorpus(byCodepoint, 3);
    const { status, stdout, rcloneCalls } = runScript({
      env: { UPLOAD_SCOPE: "cns", RCLONE_TRANSFERS: "4" },
      input: "N\n",
      cnsExpectedCount: 3,
    });
    expect(status).toBe(0);
    expect(stdout).not.toMatch(/超出|允許範圍|fail-closed|❌/i);
    for (const call of rcloneCalls) {
      if (call.includes("--transfers")) {
        expect(call).toContain("--transfers=4");
      }
    }
  });

  it("RCLONE_TRANSFERS=8 (max allowed) passes through", () => {
    const byCodepoint = join(tempRoot, "data", "dictionary", "cns", "by-codepoint");
    buildCnsCorpus(byCodepoint, 3);
    const { status, rcloneCalls } = runScript({
      env: { UPLOAD_SCOPE: "cns", RCLONE_TRANSFERS: "8" },
      input: "N\n",
      cnsExpectedCount: 3,
    });
    expect(status).toBe(0);
    for (const call of rcloneCalls) {
      if (call.includes("--transfers")) {
        expect(call).toContain("--transfers=8");
      }
    }
  });
});

// ── Exponential retry behavior ───────────────────────────────────────────────

describe("upload_dictionary.sh — exponential retry behavior", () => {
  it("fake rclone failing 2 times then succeeding: 3 attempts, final exit 0", () => {
    const byCodepoint = join(tempRoot, "data", "dictionary", "cns", "by-codepoint");
    buildCnsCorpus(byCodepoint, 3);
    // Use RCLONE_RETRY_INITIAL_MS=0 so sleeps are skipped (no long waits in test).
    const { status, rcloneCalls } = runScript({
      env: { UPLOAD_SCOPE: "cns", RCLONE_RETRY_INITIAL_MS: "0" },
      input: "y\n",
      cnsExpectedCount: 3,
      failFirst: 2, // dry-run fails twice (3 attempts), real sync succeeds first try
    });
    expect(status).toBe(0);
    // Dry-run: 3 attempts (2 fail + 1 succeed). Real sync: 1 attempt.
    // Total rclone invocations: 4.
    expect(rcloneCalls.length).toBe(4);
  });

  it("fake rclone failing all 5 attempts (dry-run): exits before real upload", () => {
    const byCodepoint = join(tempRoot, "data", "dictionary", "cns", "by-codepoint");
    buildCnsCorpus(byCodepoint, 3);
    const { status, rcloneCalls } = runScript({
      env: { UPLOAD_SCOPE: "cns", RCLONE_RETRY_INITIAL_MS: "0" },
      input: "y\n",
      cnsExpectedCount: 3,
      failFirst: 99,
    });
    expect(status).toBe(1);
    expect(rcloneCalls).toHaveLength(5);
  });
});

// ── Static constant agreement ─────────────────────────────────────────────────

describe("upload_dictionary.sh — static constant agreement", () => {
  it("shell CNS_EXPECTED_COUNT=77208 matches JS EXPECTED_EMITTED", () => {
    expect(EXPECTED_EMITTED).toBe(77208);
    const src = readFileSync(SCRIPT, "utf-8");
    expect(src).toContain("CNS_EXPECTED_COUNT=77208");
  });

  it("shell script hardcaps _MAX_CONCURRENCY=8 matching AGENTS.md rate-limit policy", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    expect(src).toContain("_MAX_CONCURRENCY=8");
  });

  it("all rclone calls in CNS scope block are `rclone sync` not `rclone copy`", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    // The CNS scope block uses _rclone_sync_with_retry, not bare rclone sync.
    // Verify the wrapper function uses rclone sync.
    const wrapperMatch = src.match(/_rclone_sync_with_retry\(\s*\)/);
    expect(wrapperMatch).not.toBeNull();
    // Verify the CNS block calls _rclone_sync_with_retry, not bare rclone.
    const cnsSectionMatch = src.match(/if \[ "\$UPLOAD_SCOPE" = "cns" \]([\s\S]+?)^fi$/m);
    expect(cnsSectionMatch).not.toBeNull();
    const cnsSection = cnsSectionMatch![1];
    // The wrapper uses `rclone sync` internally.
    expect(src).toMatch(/rclone sync "\$_src" "\$_dst"/);
    // No bare `rclone sync` calls in the CNS scope block (all go through wrapper).
    const bareRcloneInCns = cnsSection.match(/^\s*rclone sync\b/gm);
    expect(bareRcloneInCns).toBeNull();
  });

  it("upload script uses bounded exponential retry wrapper (not fixed --retries)", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    // The wrapper function exists with max 5 attempts, exponential backoff.
    expect(src).toContain("_rclone_sync_with_retry");
    expect(src).toMatch(/_max_attempts=5/);
    expect(src).toMatch(/_delay_ms=\$\(\(_delay_ms \* 2\)\)/);
    expect(src).toMatch(/_delay_ms="\$_cap_ms"/);
    expect(src).toMatch(/RCLONE_RETRY_INITIAL_MS/);
    // rclone --retries is set to 1 inside the wrapper (high-level retry handled by shell wrapper).
    expect(src).toMatch(/--retries=1/);
    // --low-level-retries is retained for HTTP pacer (429/971).
    expect(src).toMatch(/--low-level-retries=10/);
  });
});
