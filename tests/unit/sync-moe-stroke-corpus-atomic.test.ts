/// <reference types="node" />
/**
 * Behavioral tests for the atomic stroke-corpus model in
 * commands/sync-moe-stroke-corpus.mjs: digest computation, manifest build,
 * atomic upload (objects → manifest → verify → pointer-last), pointer
 * rollback-state retention, and --verify-only (read-only, no writes).
 *
 * All R2 interaction is injected via a fake `runner`/fake filesystem for
 * the local rollback-state module — no real Wrangler or R2 calls.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  computeCorpusDigest,
  buildAtomicCorpusManifest,
  buildAtomicUploadEntries,
  uploadAtomicCorpusObjects,
  uploadAtomicCorpusManifest,
  verifyAtomicCorpusUploads,
  readCorpusPointer,
  promoteCorpusPointer,
  runAtomicCorpusUpload,
  verifyCorpusOnly,
  DEFAULT_VERIFY_MAX_RETRIES,
  type ManifestEntry,
} from "../../commands/sync-moe-stroke-corpus.mjs";
import {
  STROKE_CORPUS_POINTER_KEY,
  strokeCorpusManifestKey,
  strokeCorpusObjectKey,
} from "../../src/utils/stroke-corpus";
import {
  readCorpusPointerHistory,
  readPriorCorpusPointer,
} from "../../scripts/lib/stroke-corpus-state.mjs";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "stroke-corpus-atomic-test-"));
  tmpDirs.push(d);
  return d;
}

/** In-memory fake R2 keyed by "bucket/key" -> Buffer, standing in for `--remote` object storage. */
function makeFakeR2() {
  const store = new Map<string, Buffer>();
  const runner = async (argv: string[]) => {
    const op = argv[5]; // ["vp","exec","wrangler","r2","object", "put"|"get", ...]
    if (op === "put") {
      const target = argv[6]; // "bucket/key"
      const fileArg = argv.find((a) => a.startsWith("--file="))!.slice("--file=".length);
      store.set(target, readFileSync(fileArg));
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (op === "get") {
      const target = argv[6];
      const fileArg = argv.find((a) => a.startsWith("--file="))!.slice("--file=".length);
      const bytes = store.get(target);
      if (!bytes) {
        return { exitCode: 1, stdout: "", stderr: `NoSuchKey: ${target} not found` };
      }
      writeFileSync(fileArg, bytes);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unsupported fake R2 op: ${op}`);
  };
  return { store, runner };
}

/** Build a minimal N-entry set of ManifestEntry-shaped objects with local files written to outDir. */
function buildEntries(outDir: string, n: number): ManifestEntry[] {
  mkdirSync(join(outDir, "stroke-json"), { recursive: true });
  const entries: ManifestEntry[] = [];
  for (let i = 0; i < n; i++) {
    const hex = (0x4e00 + i).toString(16);
    const body = JSON.stringify([{ outline: [{ type: "M", x: i, y: 0 }], track: [] }]);
    writeFileSync(join(outDir, "stroke-json", `${hex}.json`), body);
    entries.push({
      char: String.fromCodePoint(0x4e00 + i),
      hex,
      decimalId: 0x4e00 + i,
      strokeCount: 1,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: Buffer.byteLength(body),
      sourceUrl: "u",
      r2Key: `stroke-json/${hex}.json`,
    });
  }
  return entries;
}

// In-memory fake fs adapter for stroke-corpus-state.mjs (rollback history).
function makeFakeStateFs() {
  const files = new Map<string, string>();
  return {
    existsSync: (p: string) => files.has(p),
    mkdirSync: () => {},
    readFileSync: (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    renameSync: (from: string, to: string) => {
      const v = files.get(from);
      files.delete(from);
      if (v !== undefined) files.set(to, v);
    },
    rmSync: (p: string) => {
      files.delete(p);
    },
    writeFileSync: (p: string, data: string) => {
      files.set(p, data);
    },
  };
}

describe("computeCorpusDigest", () => {
  it("is deterministic and order-independent", () => {
    const outDir = tmp();
    const entries = buildEntries(outDir, 5);
    const d1 = computeCorpusDigest(entries);
    const d2 = computeCorpusDigest([...entries].reverse());
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when any file's content (sha256) changes", () => {
    const outDir = tmp();
    const entries = buildEntries(outDir, 3);
    const d1 = computeCorpusDigest(entries);
    const mutated = entries.map((e, i) => (i === 0 ? { ...e, sha256: "f".repeat(64) } : e));
    const d2 = computeCorpusDigest(mutated);
    expect(d2).not.toBe(d1);
  });
});

describe("buildAtomicCorpusManifest", () => {
  it("fails closed on wrong count (not 6063)", () => {
    const outDir = tmp();
    const entries = buildEntries(outDir, 3);
    expect(() => buildAtomicCorpusManifest(entries, computeCorpusDigest(entries))).toThrow(
      /size mismatch/,
    );
  });

  it("builds a schema-valid manifest with stroke-json/<hex>.json paths and correct totalBytes", () => {
    const outDir = tmp();
    const entries = buildEntries(outDir, 6063);
    const digest = computeCorpusDigest(entries);
    const manifest = buildAtomicCorpusManifest(entries, digest);
    expect(manifest.schema).toBe(1);
    expect(manifest.corpusDigest).toBe(digest);
    expect(manifest.fileCount).toBe(6063);
    expect(manifest.files).toHaveLength(6063);
    expect(manifest.files[0].path).toMatch(/^stroke-json\/[0-9a-f]{4,6}\.json$/);
    const expectedTotal = entries.reduce((s, e) => s + e.bytes, 0);
    expect(manifest.totalBytes).toBe(expectedTotal);
  });
});

describe("buildAtomicUploadEntries / uploadAtomicCorpusObjects", () => {
  it("keys objects under stroke-corpora/<digest>/stroke-json/<hex>.json with immutable Cache-Control", () => {
    const outDir = tmp();
    const entries = buildEntries(outDir, 3);
    const digest = "a".repeat(64);
    const files = buildAtomicUploadEntries(entries, outDir, digest);
    expect(files[0].key).toBe(strokeCorpusObjectKey(digest, entries[0].hex));
    expect(files[0].key).toMatch(new RegExp(`^stroke-corpora/${digest}/stroke-json/`));
    expect(files[0].cacheControl).toContain("immutable");
  });

  it("uploads every object via the injected runner", async () => {
    const outDir = tmp();
    const entries = buildEntries(outDir, 4);
    const digest = computeCorpusDigest(entries);
    const { store, runner } = makeFakeR2();
    await uploadAtomicCorpusObjects(entries, outDir, "bucket", digest, {
      runner,
      sleep: async () => {},
    });
    for (const e of entries) {
      expect(store.has(`bucket/${strokeCorpusObjectKey(digest, e.hex)}`)).toBe(true);
    }
  });

  it("refuses upload when a local file is missing (defensive pre-check)", async () => {
    const outDir = tmp();
    const entries = buildEntries(outDir, 2);
    rmSync(join(outDir, "stroke-json", `${entries[0].hex}.json`));
    const { runner } = makeFakeR2();
    await expect(
      uploadAtomicCorpusObjects(entries, outDir, "bucket", computeCorpusDigest(entries), {
        runner,
      }),
    ).rejects.toThrow(/missing local file/);
  });
});

describe("full atomic pipeline: runAtomicCorpusUpload", () => {
  it("uploads objects, then manifest, then verifies, then promotes pointer LAST", async () => {
    const outDir = tmp();
    const entries = buildEntries(outDir, 6063);
    const { store, runner } = makeFakeR2();
    const stateFs = makeFakeStateFs();
    const order: string[] = [];
    const tracedRunner = async (argv: string[]) => {
      const op = argv[5];
      const target = argv[6];
      if (op === "put" && target.endsWith(STROKE_CORPUS_POINTER_KEY)) order.push("pointer-put");
      else if (op === "put" && target.includes("/manifest.json")) order.push("manifest-put");
      else if (op === "put") order.push("object-put");
      else if (op === "get" && target.includes("/manifest.json")) order.push("manifest-get");
      else if (op === "get" && target.endsWith(STROKE_CORPUS_POINTER_KEY))
        order.push("pointer-get");
      else if (op === "get") order.push("object-get");
      return runner(argv);
    };

    const result = await runAtomicCorpusUpload(
      entries,
      outDir,
      "moedict-assets-preview",
      "staging",
      {
        runner: tracedRunner,
        sleep: async () => {},
        stateFs,
        stateBaseDir: "/fake-state",
        nowIso: () => "2026-07-19T00:00:00.000Z",
      },
    );

    expect(result.corpusDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifest.fileCount).toBe(6063);
    expect(result.verification.verified).toBe(true);
    // Manifest is written only after all 6063 objects have PUT.
    const manifestPutIdx = order.indexOf("manifest-put");
    const lastObjectPutIdx = order.lastIndexOf("object-put");
    expect(manifestPutIdx).toBeGreaterThan(lastObjectPutIdx);
    // Pointer PUT happens only after verification (manifest-get + object-gets) completes.
    const pointerPutIdx = order.indexOf("pointer-put");
    const lastObjectGetIdx = order.lastIndexOf("object-get");
    expect(pointerPutIdx).toBeGreaterThan(lastObjectGetIdx);
    expect(pointerPutIdx).toBeGreaterThan(order.indexOf("manifest-get"));

    // Pointer object is present and schema-correct.
    const pointerBytes = store.get(`moedict-assets-preview/${STROKE_CORPUS_POINTER_KEY}`);
    expect(pointerBytes).toBeDefined();
    const pointer = JSON.parse(pointerBytes!.toString("utf8"));
    expect(pointer.corpusDigest).toBe(result.corpusDigest);
    expect(pointer.manifestKey).toBe(strokeCorpusManifestKey(result.corpusDigest));

    // No prior pointer existed, so no rollback-history entry from "before" —
    // but the NEW pointer is recorded so a future promotion can roll back to it.
    const history = readCorpusPointerHistory("staging", { baseDir: "/fake-state", fs: stateFs });
    expect(history).toHaveLength(1);
    expect(history[0].corpusDigest).toBe(result.corpusDigest);
  });

  it("never writes the pointer when object upload fails partway (fail-closed before promotion)", async () => {
    const outDir = tmp();
    const entries = buildEntries(outDir, 6063);
    const { store, runner } = makeFakeR2();
    let calls = 0;
    const flakyRunner = async (argv: string[]) => {
      calls++;
      if (argv[5] === "put" && calls === 50) {
        return { exitCode: 1, stdout: "", stderr: "HTTP 403 Forbidden: access denied" };
      }
      return runner(argv);
    };
    const stateFs = makeFakeStateFs();
    await expect(
      runAtomicCorpusUpload(entries, outDir, "bucket", "staging", {
        runner: flakyRunner,
        sleep: async () => {},
        stateFs,
        stateBaseDir: "/fake-state",
      }),
    ).rejects.toThrow();
    expect(store.has(`bucket/${STROKE_CORPUS_POINTER_KEY}`)).toBe(false);
    expect(readCorpusPointerHistory("staging", { baseDir: "/fake-state", fs: stateFs })).toEqual(
      [],
    );
  });

  it("records the prior pointer in rollback state before promoting a new one", async () => {
    const outDir1 = tmp();
    const entriesA = buildEntries(outDir1, 6063);
    const { runner } = makeFakeR2();
    const stateFs = makeFakeStateFs();

    const first = await runAtomicCorpusUpload(entriesA, outDir1, "bucket", "production", {
      runner,
      sleep: async () => {},
      stateFs,
      stateBaseDir: "/fake-state",
      nowIso: () => "2026-07-19T00:00:00.000Z",
    });

    // Re-promote a manifest with a distinct corpusDigest directly (unit-level:
    // exercises promoteCorpusPointer's rollback-history recording without
    // re-running the full 6063-object upload+verify pipeline twice).
    const secondManifest = { ...first.manifest, corpusDigest: "c".repeat(64) };
    const second = await promoteCorpusPointer("bucket", "production", secondManifest, {
      runner,
      stateFs,
      stateBaseDir: "/fake-state",
      nowIso: () => "2026-07-19T01:00:00.000Z",
    });

    expect(second.corpusDigest).toBe("c".repeat(64));
    expect(second.corpusDigest).not.toBe(first.corpusDigest);
    const history = readCorpusPointerHistory("production", { baseDir: "/fake-state", fs: stateFs });
    expect(history.length).toBeGreaterThanOrEqual(2);
    const prior = readPriorCorpusPointer("production", { baseDir: "/fake-state", fs: stateFs });
    expect(prior).not.toBeNull();
    expect(prior!.corpusDigest).toBe(first.corpusDigest);
  });

  // P2 fix: R2 has no compare-and-swap / conditional PUT (`wrangler r2
  // object put --help` exposes no --if-match flag), so uploads MUST be
  // operator-serialized. This test proves the lightweight optimistic
  // re-read mitigation actually catches the concurrent-promotion case
  // through the REAL runAtomicCorpusUpload pipeline (not by calling
  // promoteCorpusPointer directly with a hand-built expectedPriorPointer,
  // which would only prove the check itself works, not that the pipeline
  // wires it up).
  it("aborts a promotion when a concurrent process changed the pointer during this upload — no pointer mutation, no history write", async () => {
    const outDir = tmp();
    const entries = buildEntries(outDir, 6063);
    const { store, runner: baseRunner } = makeFakeR2();
    const stateFs = makeFakeStateFs();

    // Seed an existing pointer for a PRIOR corpus (digest 1×64) — the
    // baseline this upload's pre-upload read (step 0) captures.
    const priorDigest = "1".repeat(64);
    const priorPointer = {
      schema: 1,
      corpusDigest: priorDigest,
      manifestKey: `stroke-corpora/${priorDigest}/manifest.json`,
      fileCount: 1,
      totalBytes: 2,
    };
    store.set(`bucket/${STROKE_CORPUS_POINTER_KEY}`, Buffer.from(JSON.stringify(priorPointer)));

    // Simulate a concurrent, unserialized second operator run: right
    // after THIS upload's own manifest PUT lands (step 2 — meaning its
    // objects+manifest are fully uploaded, right before verification),
    // swap the live pointer to an unrelated digest, as if that second
    // process just promoted its own corpus while this one was mid-flight.
    const concurrentDigest = "2".repeat(64);
    const concurrentPointer = {
      schema: 1,
      corpusDigest: concurrentDigest,
      manifestKey: `stroke-corpora/${concurrentDigest}/manifest.json`,
      fileCount: 1,
      totalBytes: 2,
    };
    let manifestPutSeen = false;
    const runner = async (argv: string[]) => {
      const op = argv[5];
      const target = argv[6];
      if (op === "put" && typeof target === "string" && target.includes("/manifest.json")) {
        manifestPutSeen = true;
        const result = await baseRunner(argv);
        store.set(
          `bucket/${STROKE_CORPUS_POINTER_KEY}`,
          Buffer.from(JSON.stringify(concurrentPointer)),
        );
        return result;
      }
      return baseRunner(argv);
    };

    await expect(
      runAtomicCorpusUpload(entries, outDir, "bucket", "staging", {
        runner,
        sleep: async () => {},
        stateFs,
        stateBaseDir: "/fake-state",
      }),
    ).rejects.toThrow(/Aborting pointer promotion.*pointer changed/);

    expect(manifestPutSeen).toBe(true);
    // The pointer object still holds the CONCURRENT process's own
    // pointer — the aborted process never wrote to it (no last-writer
    // clobber of the winning promotion).
    const storedPointer = JSON.parse(
      store.get(`bucket/${STROKE_CORPUS_POINTER_KEY}`)!.toString("utf8"),
    );
    expect(storedPointer.corpusDigest).toBe(concurrentDigest);
    // No rollback-history entry was written by the aborted process.
    expect(readCorpusPointerHistory("staging", { baseDir: "/fake-state", fs: stateFs })).toEqual(
      [],
    );
  });
});

describe("readCorpusPointer", () => {
  it("returns null when no pointer object exists yet", async () => {
    const { runner } = makeFakeR2();
    const pointer = await readCorpusPointer("bucket", { runner });
    expect(pointer).toBeNull();
  });

  it("throws (fails closed) on a schema-invalid pointer rather than treating it as absent", async () => {
    const { store, runner } = makeFakeR2();
    store.set(`bucket/${STROKE_CORPUS_POINTER_KEY}`, Buffer.from(JSON.stringify({ bogus: true })));
    await expect(readCorpusPointer("bucket", { runner })).rejects.toThrow(/schema validation/);
  });

  it("throws on corrupt (non-JSON) pointer content", async () => {
    const { store, runner } = makeFakeR2();
    store.set(`bucket/${STROKE_CORPUS_POINTER_KEY}`, Buffer.from("{not json"));
    await expect(readCorpusPointer("bucket", { runner })).rejects.toThrow(/not valid JSON/);
  });

  // P1 fix: readCorpusPointer previously called runner() exactly once with
  // zero retry, unlike the neighboring readCorpusManifest /
  // verifyAtomicCorpusUploads reads on the same critical path (deploy
  // preflight, promoteCorpusPointer's prior-pointer read right after a
  // multi-minute 6,063-object upload). A single transient network blip
  // used to hard-fail both. Now wrapped in the same retryWithBackoff /
  // DEFAULT_VERIFY_MAX_RETRIES=8 default as readCorpusManifest.
  it("recovers on attempt 8 after 7 transient fetch-failed errors (same default as readCorpusManifest)", async () => {
    const digest = "a".repeat(64);
    const pointer = {
      schema: 1,
      corpusDigest: digest,
      manifestKey: `stroke-corpora/${digest}/manifest.json`,
      fileCount: 1,
      totalBytes: 2,
    };
    let attempts = 0;
    const sleeps: number[] = [];
    const runner = async (argv: string[]) => {
      attempts++;
      if (attempts < 8) {
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            "✘ [ERROR] fetch failed\nA fetch request failed, likely due to a connectivity issue.",
        };
      }
      const fileArg = argv.find((a) => a.startsWith("--file="))!;
      writeFileSync(fileArg.slice("--file=".length), JSON.stringify(pointer));
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await readCorpusPointer("bucket", {
      runner,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      // exercise default: do NOT pass maxRetries
    });
    expect(result?.corpusDigest).toBe(digest);
    expect(attempts).toBe(8);
    // 7 sleeps between the 7 failures and the success
    expect(sleeps).toHaveLength(7);
  });

  it("still fails after maxRetries+1 transient attempts (default 8 → 9 total)", async () => {
    let attempts = 0;
    const runner = async () => {
      attempts++;
      return { exitCode: 1, stdout: "", stderr: "✘ [ERROR] fetch failed" };
    };
    await expect(readCorpusPointer("bucket", { runner, sleep: async () => {} })).rejects.toThrow(
      /Failed to read corpus pointer|fetch failed/,
    );
    // initial + 8 retries
    expect(attempts).toBe(DEFAULT_VERIFY_MAX_RETRIES + 1);
  });

  it("never retries a genuine not-found (NoSuchKey) — returns null after exactly 1 attempt", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const runner = async () => {
      attempts++;
      return { exitCode: 1, stdout: "", stderr: "NoSuchKey: the specified key does not exist" };
    };
    const result = await readCorpusPointer("bucket", {
      runner,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result).toBeNull();
    expect(attempts).toBe(1);
    expect(sleeps).toHaveLength(0);
  });
});

describe("promoteCorpusPointer never overwrites the object prefix", () => {
  it("two distinct corpora promote to two distinct prefixes; both remain readable (no GC)", async () => {
    const { store, runner } = makeFakeR2();
    const stateFs = makeFakeStateFs();
    const outDir = tmp();
    const entries = buildEntries(outDir, 6063);
    const digest = computeCorpusDigest(entries);
    const manifest = buildAtomicCorpusManifest(entries, digest);
    await uploadAtomicCorpusObjects(entries, outDir, "bucket", digest, { runner });
    await uploadAtomicCorpusManifest(manifest, "bucket", { runner });
    await promoteCorpusPointer("bucket", "staging", manifest, {
      runner,
      stateFs,
      stateBaseDir: "/fake-state",
      nowIso: () => "2026-07-19T00:00:00.000Z",
    });

    // First digest's objects remain in the store untouched.
    expect(store.has(`bucket/${strokeCorpusObjectKey(digest, entries[0].hex)}`)).toBe(true);

    // Promote a pointer for a fresh digest (simulated by re-deriving with a
    // different corpusDigest string — proves the key builder never collides).
    const manifest2 = { ...manifest, corpusDigest: "b".repeat(64) };
    // Manifest2's objects live under a DIFFERENT prefix; we don't need to
    // actually upload them to prove promoteCorpusPointer records rollback
    // history and writes a pointer scoped to the new digest without
    // touching the old prefix's keys.
    await promoteCorpusPointer("bucket", "staging", manifest2, {
      runner,
      stateFs,
      stateBaseDir: "/fake-state",
      nowIso: () => "2026-07-19T01:00:00.000Z",
    });

    // Old prefix objects still present (never overwritten/deleted).
    expect(store.has(`bucket/${strokeCorpusObjectKey(digest, entries[0].hex)}`)).toBe(true);
    // Pointer now points at the new digest.
    const pointerBytes = store.get(`bucket/${STROKE_CORPUS_POINTER_KEY}`)!;
    expect(JSON.parse(pointerBytes.toString("utf8")).corpusDigest).toBe("b".repeat(64));
    // Prior pointer (first digest) is retrievable for rollback.
    const prior = readPriorCorpusPointer("staging", { baseDir: "/fake-state", fs: stateFs });
    expect(prior!.corpusDigest).toBe(digest);
  });
});

describe("verifyCorpusOnly — read-only, no writes", () => {
  it("reads pointer + manifest + all objects and reports success with zero mutating calls", async () => {
    const outDir = tmp();
    const entries = buildEntries(outDir, 6063);
    const { store, runner } = makeFakeR2();
    const stateFs = makeFakeStateFs();
    await runAtomicCorpusUpload(entries, outDir, "bucket", "production", {
      runner,
      sleep: async () => {},
      stateFs,
      stateBaseDir: "/fake-state",
    });

    let putCalls = 0;
    const readOnlyRunner = async (argv: string[]) => {
      if (argv[5] === "put") putCalls++;
      return runner(argv);
    };

    const result = await verifyCorpusOnly("bucket", {
      runner: readOnlyRunner,
      sleep: async () => {},
    });
    expect(result.verification.verified).toBe(true);
    expect(result.verification.checkedKeys.length).toBe(6063);
    expect(putCalls).toBe(0); // strictly read-only
    void store;
  });

  it("throws when no pointer exists (nothing to verify)", async () => {
    const { runner } = makeFakeR2();
    await expect(verifyCorpusOnly("bucket", { runner })).rejects.toThrow(/No corpus pointer/);
  });

  it("throws on hash mismatch without performing any write", async () => {
    const outDir = tmp();
    const entries = buildEntries(outDir, 6063);
    const { store, runner } = makeFakeR2();
    const stateFs = makeFakeStateFs();
    const uploadResult = await runAtomicCorpusUpload(entries, outDir, "bucket", "production", {
      runner,
      sleep: async () => {},
      stateFs,
      stateBaseDir: "/fake-state",
    });
    // Corrupt one object in the fake store after upload.
    const corruptedKey = `bucket/${strokeCorpusObjectKey(uploadResult.corpusDigest, entries[0].hex)}`;
    store.set(corruptedKey, Buffer.from("[]"));

    let putCalls = 0;
    const readOnlyRunner = async (argv: string[]) => {
      if (argv[5] === "put") putCalls++;
      return runner(argv);
    };
    await expect(
      verifyCorpusOnly("bucket", { runner: readOnlyRunner, sleep: async () => {} }),
    ).rejects.toThrow(/hash mismatch/);
    expect(putCalls).toBe(0);
  });
});

describe("verifyAtomicCorpusUploads retry semantics", () => {
  it("verifies the manifest object itself, failing closed if it is missing", async () => {
    const outDir = tmp();
    const entries = buildEntries(outDir, 6063);
    const digest = computeCorpusDigest(entries);
    const manifest = buildAtomicCorpusManifest(entries, digest);
    const { runner } = makeFakeR2();
    // Upload objects but never the manifest.
    await uploadAtomicCorpusObjects(entries, outDir, "bucket", digest, { runner });
    await expect(
      verifyAtomicCorpusUploads(manifest, "bucket", { runner, sleep: async () => {} }),
    ).rejects.toThrow(/Missing object during verify/);
  });
});
