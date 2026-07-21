/// <reference types="node" />
/**
 * Unit tests for scripts/lib/stroke-corpus-preflight.mjs — the deploy-time
 * corpus readiness gate.
 *
 * LIGHTWEIGHT contract under test: authenticated GET of the pointer +
 * manifest ONLY (delegates to `verifyCorpusReadiness`), strict schema
 * validation, pointer<->manifest fileCount/totalBytes/corpusDigest
 * consistency, exact 6,063 count, and a manifest content self-digest
 * check — and, critically, EXACTLY those two reads: never a single one
 * of the 6,063 corpus objects, and never any write.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { runStrokeCorpusPreflight } from "../../scripts/lib/stroke-corpus-preflight.mjs";
import { STROKE_CORPUS_POINTER_KEY } from "../../src/utils/stroke-corpus";

const STAGING_CONFIG = {
  name: "cf-moedict-webkit-neo-staging",
  targetEnvironment: "staging",
  r2_buckets: [{ binding: "ASSETS", bucket_name: "moedict-assets-preview" }],
};

/**
 * Content-addressed digest matching computeCorpusDigest in
 * commands/sync-moe-stroke-corpus.mjs — sha256 of sorted "hex:sha256" pairs.
 * verifyCorpusReadiness recomputes this from manifest.files[] as its
 * "manifest content self-digest" check, so any valid fixture MUST use the
 * real computed digest, not an arbitrary placeholder.
 */
function computeDigest(files: Array<{ hex: string; sha256: string }>): string {
  const sorted = [...files].sort((a, b) => (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0));
  const material = sorted.map((e) => `${e.hex}:${e.sha256}`).join("\n");
  return createHash("sha256").update(material).digest("hex");
}

/** Build a minimal fake R2 store with a full valid atomic corpus (padded to 6,063 files). */
function buildValidCorpusStore(): Map<string, Buffer> {
  const store = new Map<string, Buffer>();
  const files: Array<{ path: string; sha256: string; bytes: number }> = [];
  const hexes: Array<{ hex: string; sha256: string }> = [];
  for (let i = 0; i < 6063; i++) {
    const hex = (0x4e00 + i).toString(16);
    const body = Buffer.from("[]");
    const sha256 = createHash("sha256").update(body).digest("hex");
    files.push({ path: `stroke-json/${hex}.json`, sha256, bytes: body.byteLength });
    hexes.push({ hex, sha256 });
  }
  const digest = computeDigest(hexes);
  for (const f of files) {
    const hex = f.path.replace(/^stroke-json\//, "").replace(/\.json$/i, "");
    store.set(`stroke-corpora/${digest}/stroke-json/${hex}.json`, Buffer.from("[]"));
  }
  const totalBytes = files.reduce((s, f) => s + f.bytes, 0);
  const manifest = { schema: 1, corpusDigest: digest, fileCount: files.length, totalBytes, files };
  const manifestKey = `stroke-corpora/${digest}/manifest.json`;
  store.set(manifestKey, Buffer.from(JSON.stringify(manifest)));
  const pointer = {
    schema: 1,
    corpusDigest: digest,
    manifestKey,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
  };
  store.set(STROKE_CORPUS_POINTER_KEY, Buffer.from(JSON.stringify(pointer)));
  return store;
}

function makeFakeRunner(store: Map<string, Buffer>) {
  const calls: string[][] = [];
  const runner = async (argv: string[]) => {
    calls.push(argv);
    const op = argv[5]; // ["vp","exec","wrangler","r2","object","get"|"put",...]
    if (op === "put") {
      throw new Error("preflight must never write — a put() call was attempted");
    }
    if (op === "get") {
      const target = argv[6]; // "bucket/key"
      const key = target.split("/").slice(1).join("/");
      const bytes = store.get(key);
      if (!bytes) return { exitCode: 1, stdout: "", stderr: `NoSuchKey: ${key}` };
      const fileArg = argv.find((a) => a.startsWith("--file="))!.slice("--file=".length);
      writeFileSync(fileArg, bytes);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unsupported op: ${op}`);
  };
  return { runner, calls };
}

/** Every call must be a GET of either the pointer key or a manifest.json — never a stroke-json object. */
function assertOnlyPointerAndManifestReads(calls: string[][]): void {
  expect(calls.length).toBe(2);
  for (const call of calls) {
    expect(call[5]).toBe("get");
    const target = call[6] as string;
    const isPointer = target.endsWith(STROKE_CORPUS_POINTER_KEY);
    const isManifest = target.endsWith("/manifest.json");
    expect(isPointer || isManifest).toBe(true);
  }
}

describe("runStrokeCorpusPreflight — lightweight (pointer+manifest only)", () => {
  it("succeeds with EXACTLY 2 reads (pointer + manifest) — zero object reads — for a valid corpus", async () => {
    const store = buildValidCorpusStore();
    const { runner, calls } = makeFakeRunner(store);
    const result = await runStrokeCorpusPreflight("staging", {
      config: STAGING_CONFIG,
      runner,
      sleep: async () => {},
      log: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.bucketName).toBe("moedict-assets-preview");
    expect(result.corpusDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.fileCount).toBe(6063);
    assertOnlyPointerAndManifestReads(calls);
  });

  it("throws (fails closed) with a clear message when the pointer is missing — exactly 1 read, never writes", async () => {
    const store = new Map<string, Buffer>(); // empty bucket
    const { runner, calls } = makeFakeRunner(store);
    await expect(
      runStrokeCorpusPreflight("staging", {
        config: STAGING_CONFIG,
        runner,
        sleep: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/FAILED for env=staging/);
    expect(calls).toHaveLength(1);
    expect(calls.every((c) => c[5] === "get")).toBe(true);
  });

  it("throws with the env/bucket named in the error for operator triage", async () => {
    const store = new Map<string, Buffer>();
    const { runner } = makeFakeRunner(store);
    await expect(
      runStrokeCorpusPreflight("staging", {
        config: STAGING_CONFIG,
        runner,
        sleep: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/env=staging bucket=moedict-assets-preview/);
  });

  it("throws when the generated config is missing/invalid, before attempting any R2 read", async () => {
    let runnerCalled = false;
    const runner = async () => {
      runnerCalled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await expect(
      runStrokeCorpusPreflight("staging", {
        config: { name: "wrong", r2_buckets: [] },
        runner,
        log: () => {},
      }),
    ).rejects.toThrow(/cannot resolve ASSETS bucket/);
    expect(runnerCalled).toBe(false);
  });

  it("throws on a malformed manifest (schema-invalid) without ever reading a corpus object", async () => {
    const store = buildValidCorpusStore();
    const pointerRaw = JSON.parse(store.get(STROKE_CORPUS_POINTER_KEY)!.toString("utf8"));
    const digest = pointerRaw.corpusDigest as string;
    store.set(
      `stroke-corpora/${digest}/manifest.json`,
      Buffer.from(JSON.stringify({ bogus: true })),
    );
    const { runner, calls } = makeFakeRunner(store);
    await expect(
      runStrokeCorpusPreflight("staging", {
        config: STAGING_CONFIG,
        runner,
        sleep: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/FAILED for env=staging/);
    assertOnlyPointerAndManifestReads(calls);
  });

  it("throws when pointer.totalBytes disagrees with manifest.totalBytes (no object reads needed to catch this)", async () => {
    const store = buildValidCorpusStore();
    const pointerRaw = JSON.parse(store.get(STROKE_CORPUS_POINTER_KEY)!.toString("utf8"));
    pointerRaw.totalBytes = pointerRaw.totalBytes + 1;
    store.set(STROKE_CORPUS_POINTER_KEY, Buffer.from(JSON.stringify(pointerRaw)));
    const { runner, calls } = makeFakeRunner(store);
    await expect(
      runStrokeCorpusPreflight("staging", {
        config: STAGING_CONFIG,
        runner,
        sleep: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/totalBytes/);
    assertOnlyPointerAndManifestReads(calls);
  });

  it("throws when the manifest's own totalBytes does not match the sum of its file bytes", async () => {
    const store = buildValidCorpusStore();
    const pointerRaw = JSON.parse(store.get(STROKE_CORPUS_POINTER_KEY)!.toString("utf8"));
    const digest = pointerRaw.corpusDigest as string;
    const manifestRaw = JSON.parse(
      store.get(`stroke-corpora/${digest}/manifest.json`)!.toString("utf8"),
    );
    manifestRaw.totalBytes = manifestRaw.totalBytes + 100;
    store.set(`stroke-corpora/${digest}/manifest.json`, Buffer.from(JSON.stringify(manifestRaw)));
    // Keep the pointer's totalBytes in sync with the tampered manifest so the
    // pointer<->manifest check passes and this exercises the self-sum check.
    pointerRaw.totalBytes = manifestRaw.totalBytes;
    store.set(STROKE_CORPUS_POINTER_KEY, Buffer.from(JSON.stringify(pointerRaw)));
    const { runner, calls } = makeFakeRunner(store);
    await expect(
      runStrokeCorpusPreflight("staging", {
        config: STAGING_CONFIG,
        runner,
        sleep: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/sum of its own file bytes/);
    assertOnlyPointerAndManifestReads(calls);
  });

  it("throws on a manifest content self-digest mismatch (corpusDigest inconsistent with files[]) — zero object reads", async () => {
    const store = buildValidCorpusStore();
    const pointerRaw = JSON.parse(store.get(STROKE_CORPUS_POINTER_KEY)!.toString("utf8"));
    const digest = pointerRaw.corpusDigest as string;
    const manifestRaw = JSON.parse(
      store.get(`stroke-corpora/${digest}/manifest.json`)!.toString("utf8"),
    );
    // Corrupt one file's recorded sha256 without touching corpusDigest —
    // the manifest is still schema-valid and pointer-consistent, but its
    // own corpusDigest no longer matches what its files[] recompute to.
    manifestRaw.files[0].sha256 = "f".repeat(64);
    store.set(`stroke-corpora/${digest}/manifest.json`, Buffer.from(JSON.stringify(manifestRaw)));
    const { runner, calls } = makeFakeRunner(store);
    await expect(
      runStrokeCorpusPreflight("staging", {
        config: STAGING_CONFIG,
        runner,
        sleep: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/self-digest mismatch/);
    assertOnlyPointerAndManifestReads(calls);
  });

  it("rejects an unsupported env before doing any work", async () => {
    await expect(runStrokeCorpusPreflight("bogus" as never, {})).rejects.toThrow(
      /Unsupported stroke-corpus preflight env/,
    );
  });
});
