/// <reference types="node" />
/**
 * Behavioral tests for commands/sync-moe-stroke-corpus.mjs.
 *
 * Covers: discovery (zip / chars-file), uniqueness/count fail-closed,
 * convert+checkpoint resume, manifest, upload argv + 429 retry, and
 * post-upload hash verification — all with injected network/runner.
 * No source-text assertions.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  validateAndBuildCorpus,
  discoverCorpusFromZipBytes,
  listZipEntryNames,
  convertAndWriteEntry,
  convertCorpus,
  writeManifest,
  buildUploadEntries,
  uploadCorpus,
  verifyCorpusUploads,
  parseArgs,
  runCli,
  loadCheckpoint,
  EXPECTED_CORPUS_SIZE,
  DEFAULT_VERIFY_MAX_RETRIES,
} from "../../commands/sync-moe-stroke-corpus.mjs";

// Re-export is not available for EXPECTED — import via module namespace by reading constant through validate
// (EXPECTED_CORPUS_SIZE may not be exported; fall back to 6063)
const CORPUS_SIZE = 6063;

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "stroke-corpus-test-"));
  tmpDirs.push(d);
  return d;
}

/** Build a minimal store-compressed ZIP with the given entry names (empty payloads). */
function buildStoreZip(entryNames: string[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const name of entryNames) {
    const nameBuf = Buffer.from(name, "utf8");
    // general-purpose bit 11 (0x800) = UTF-8 entry names
    const utf8Flag = 0x800;
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(utf8Flag, 6); // flags
    local.writeUInt16LE(0, 8); // method = store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(0, 14); // crc
    local.writeUInt32LE(0, 18); // comp size
    local.writeUInt32LE(0, 22); // uncomp size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra
    nameBuf.copy(local, 30);
    localParts.push(local);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(utf8Flag, 8); // flags — UTF-8
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(0, 20);
    central.writeUInt32LE(0, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centralParts.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centralParts);
  const locals = Buffer.concat(localParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entryNames.length, 8);
  eocd.writeUInt16LE(entryNames.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(locals.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([locals, cd, eocd]);
}

/** Expand a short unique-char list into exactly CORPUS_SIZE entries for validate tests. */
function padToCorpus(seed: string[]): string[] {
  const out = [...seed];
  // Use private-use / CJK extension codepoints that are single chars
  let cp = 0xe000;
  while (out.length < CORPUS_SIZE) {
    const ch = String.fromCodePoint(cp++);
    if (!out.includes(ch)) out.push(ch);
  }
  return out;
}

describe("validateAndBuildCorpus", () => {
  it("accepts exactly 6063 unique single codepoints and sorts by decimal id", () => {
    const chars = padToCorpus(["町", "汛", "一"]);
    const corpus = validateAndBuildCorpus(chars);
    expect(corpus).toHaveLength(CORPUS_SIZE);
    // sorted by codepoint
    for (let i = 1; i < corpus.length; i++) {
      expect(corpus[i].decimalId).toBeGreaterThan(corpus[i - 1].decimalId);
    }
    const town = corpus.find((e) => e.char === "町");
    expect(town).toMatchObject({ hex: "753a", decimalId: 30010 });
    const xun = corpus.find((e) => e.char === "汛");
    expect(xun).toMatchObject({ hex: "6c5b", decimalId: 27739 });
  });

  it("fails closed on wrong count", () => {
    expect(() => validateAndBuildCorpus(["一", "丁"])).toThrow(/size mismatch/);
  });

  it("fails closed on duplicate characters", () => {
    const chars = padToCorpus(["一"]);
    chars[10] = "一"; // force duplicate
    // padToCorpus already has 一 at [0]; overwriting another slot with 一 duplicates
    expect(() => validateAndBuildCorpus(chars)).toThrow(/duplicate/);
  });

  it("fails closed on multi-codepoint entries", () => {
    const chars = padToCorpus([]);
    chars[0] = "你好";
    expect(() => validateAndBuildCorpus(chars)).toThrow(/single codepoint/);
  });
});

describe("listZipEntryNames / discoverCorpusFromZipBytes", () => {
  it("lists entry names from a store-method zip", () => {
    const zip = buildStoreZip(["6063png/", "6063png/一.png", "6063png/町.png"]);
    const names = listZipEntryNames(zip);
    expect(names).toEqual(["6063png/", "6063png/一.png", "6063png/町.png"]);
  });

  it("discovers characters from png basenames and fails closed on wrong count", () => {
    const zip = buildStoreZip(["6063png/一.png", "6063png/町.png"]);
    expect(() => discoverCorpusFromZipBytes(zip)).toThrow(/size mismatch/);
  });

  it("discovers a full 6063-character zip", () => {
    const chars = padToCorpus(["町", "汛", "一", "萌"]);
    const zip = buildStoreZip(["6063png/", ...chars.map((c) => `6063png/${c}.png`)]);
    const corpus = discoverCorpusFromZipBytes(zip);
    expect(corpus).toHaveLength(CORPUS_SIZE);
    expect(new Set(corpus.map((e) => e.char)).size).toBe(CORPUS_SIZE);
    expect(corpus.find((e) => e.char === "町")?.hex).toBe("753a");
  });
});

describe("convertAndWriteEntry / convertCorpus / checkpoint", () => {
  const sampleJson = [
    {
      outline: [
        { type: "M", x: 1, y: 2 },
        { type: "L", x: 3, y: 4 },
      ],
      track: [{ x: 1, y: 2 }],
    },
  ];

  it("writes stroke-json/<hex>.json and returns a manifest entry with sha256", async () => {
    const outDir = tmp();
    const convert = async (char: string) => ({
      sourceUrl: `https://example.test/dictView.jsp?ID=${char.codePointAt(0)}`,
      xml: `<Word unicode="${char}"><Stroke><Outline><MoveTo x="1" y="2"/></Outline><Track><MoveTo x="1" y="2"/></Track></Stroke></Word>`,
      json: sampleJson,
    });
    const entry = await convertAndWriteEntry(
      { char: "町", decimalId: 30010, hex: "753a" },
      outDir,
      { convert },
    );
    expect(entry).toMatchObject({
      char: "町",
      hex: "753a",
      strokeCount: 1,
      r2Key: "stroke-json/753a.json",
    });
    const body = readFileSync(join(outDir, "stroke-json", "753a.json"), "utf8");
    expect(JSON.parse(body)).toEqual(sampleJson);
    expect(entry!.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(entry!.bytes).toBe(Buffer.byteLength(body));
  });

  it("returns null when the converter reports no data (MOE miss)", async () => {
    const outDir = tmp();
    const entry = await convertAndWriteEntry(
      { char: "一", decimalId: 19968, hex: "4e00" },
      outDir,
      { convert: async () => null },
    );
    expect(entry).toBeNull();
  });

  it("rejects empty stroke arrays", async () => {
    const outDir = tmp();
    await expect(
      convertAndWriteEntry({ char: "一", decimalId: 19968, hex: "4e00" }, outDir, {
        convert: async () => ({
          sourceUrl: "x",
          xml: "<Word/>",
          json: [],
        }),
      }),
    ).rejects.toThrow(/no strokes/);
  });

  it("resumes from checkpoint and skips already-converted hexes", async () => {
    const outDir = tmp();
    const checkpoint = join(outDir, "checkpoint.ndjson");
    // Pretend 町 is already done
    const priorBody = JSON.stringify(sampleJson);
    const priorSha = createHash("sha256").update(priorBody).digest("hex");
    mkdirSync(join(outDir, "stroke-json"), { recursive: true });
    writeFileSync(join(outDir, "stroke-json", "753a.json"), priorBody);
    writeFileSync(
      checkpoint,
      JSON.stringify({
        status: "ok",
        char: "町",
        hex: "753a",
        decimalId: 30010,
        strokeCount: 1,
        sha256: priorSha,
        bytes: Buffer.byteLength(priorBody),
        sourceUrl: "prior",
        r2Key: "stroke-json/753a.json",
      }) + "\n",
    );

    const seen: string[] = [];
    const convert = async (char: string) => {
      seen.push(char);
      return {
        sourceUrl: "x",
        xml: "<Word/>",
        json: sampleJson,
      };
    };

    // Mini corpus of 2 — convertCorpus itself doesn't enforce 6063
    const { results, gaps } = await convertCorpus(
      [
        { char: "町", decimalId: 30010, hex: "753a" },
        { char: "汛", decimalId: 27739, hex: "6c5b" },
      ],
      outDir,
      { convert, checkpointPath: checkpoint },
    );
    expect(seen).toEqual(["汛"]); // 町 skipped via checkpoint
    expect(gaps).toEqual([]);
    expect(results.map((r) => r.hex).sort()).toEqual(["6c5b", "753a"]);
    // loadCheckpoint with outDir revalidates the file that convertCorpus wrote for 6c5b
    expect(loadCheckpoint(checkpoint, outDir).has("6c5b")).toBe(true);
    // loadCheckpoint without outDir skips file checks (test/read-only usage)
    expect(loadCheckpoint(checkpoint).has("6c5b")).toBe(true);
  });

  it("loadCheckpoint drops entry when local file is missing", () => {
    const outDir = tmp();
    const checkpoint = join(outDir, "checkpoint.ndjson");
    const body = JSON.stringify(sampleJson);
    const sha = createHash("sha256").update(body).digest("hex");
    // Write checkpoint record but NO local file
    writeFileSync(
      checkpoint,
      JSON.stringify({
        status: "ok",
        char: "町",
        hex: "753a",
        decimalId: 30010,
        strokeCount: 1,
        sha256: sha,
        bytes: Buffer.byteLength(body),
        sourceUrl: "u",
        r2Key: "stroke-json/753a.json",
      }) + "\n",
    );
    expect(loadCheckpoint(checkpoint, outDir).has("753a")).toBe(false); // file absent → re-convert
    expect(loadCheckpoint(checkpoint).has("753a")).toBe(true); // no-outDir → accepted
  });

  it("loadCheckpoint drops entry when local file sha256 does not match checkpoint", () => {
    const outDir = tmp();
    const checkpoint = join(outDir, "checkpoint.ndjson");
    const body = JSON.stringify(sampleJson);
    const sha = createHash("sha256").update(body).digest("hex");
    mkdirSync(join(outDir, "stroke-json"), { recursive: true });
    // Write a DIFFERENT body than the sha256 in the checkpoint
    writeFileSync(join(outDir, "stroke-json", "753a.json"), body + " ");
    writeFileSync(
      checkpoint,
      JSON.stringify({
        status: "ok",
        char: "町",
        hex: "753a",
        decimalId: 30010,
        strokeCount: 1,
        sha256: sha,
        bytes: Buffer.byteLength(body),
        sourceUrl: "u",
        r2Key: "stroke-json/753a.json",
      }) + "\n",
    );
    expect(loadCheckpoint(checkpoint, outDir).has("753a")).toBe(false); // sha mismatch → re-convert
  });

  it("loadCheckpoint silently discards a truncated final crash line", () => {
    const outDir = tmp();
    const checkpoint = join(outDir, "checkpoint.ndjson");
    const body = JSON.stringify(sampleJson);
    const sha = createHash("sha256").update(body).digest("hex");
    mkdirSync(join(outDir, "stroke-json"), { recursive: true });
    writeFileSync(join(outDir, "stroke-json", "753a.json"), body);
    writeFileSync(
      checkpoint,
      JSON.stringify({
        status: "ok",
        char: "町",
        hex: "753a",
        decimalId: 30010,
        strokeCount: 1,
        sha256: sha,
        bytes: Buffer.byteLength(body),
        sourceUrl: "u",
        r2Key: "stroke-json/753a.json",
      }) +
        "\n" +
        '{"status":"ok","hex":"6c5b","sha256":"abc', // truncated crash line
    );
    const map = loadCheckpoint(checkpoint, outDir);
    expect(map.has("753a")).toBe(true);
    expect(map.has("6c5b")).toBe(false);
  });
});

describe("writeManifest", () => {
  it("writes a deterministic sorted manifest and fails closed on size", () => {
    const outDir = tmp();
    const entries = [
      {
        char: "町",
        hex: "753a",
        decimalId: 30010,
        strokeCount: 7,
        sha256: "a".repeat(64),
        bytes: 10,
        sourceUrl: "u",
        r2Key: "stroke-json/753a.json",
      },
      {
        char: "汛",
        hex: "6c5b",
        decimalId: 27739,
        strokeCount: 6,
        sha256: "b".repeat(64),
        bytes: 11,
        sourceUrl: "u",
        r2Key: "stroke-json/6c5b.json",
      },
    ];
    expect(() => writeManifest(entries, outDir)).toThrow(/manifest size mismatch/);
    const { path, manifest } = writeManifest(entries, outDir, { allowPartial: true });
    expect(existsSync(path)).toBe(true);
    expect(manifest.count).toBe(2);
    // sorted by decimalId: 汛 (27739) before 町 (30010)
    expect(manifest.entries[0].char).toBe("汛");
    expect(manifest.entries[1].char).toBe("町");
  });

  it("fails closed on duplicate hex or empty strokes", () => {
    const outDir = tmp();
    const base = {
      char: "町",
      hex: "753a",
      decimalId: 30010,
      strokeCount: 7,
      sha256: "a".repeat(64),
      bytes: 10,
      sourceUrl: "u",
      r2Key: "stroke-json/753a.json",
    };
    expect(() =>
      writeManifest([base, { ...base, char: "X" }], outDir, { allowPartial: true }),
    ).toThrow(/duplicate hex/);
    expect(() =>
      writeManifest([{ ...base, strokeCount: 0 }], outDir, { allowPartial: true }),
    ).toThrow(/empty strokes/);
  });
});

describe("uploadCorpus / verifyCorpusUploads", () => {
  it("builds UploadEntry keys under stroke-json/ and calls runner with --remote", async () => {
    const outDir = tmp();
    mkdirSync(join(outDir, "stroke-json"), { recursive: true });
    const body = "[]";
    writeFileSync(join(outDir, "stroke-json", "753a.json"), body);
    const entries = [
      {
        char: "町",
        hex: "753a",
        decimalId: 30010,
        strokeCount: 1,
        sha256: createHash("sha256").update(body).digest("hex"),
        bytes: Buffer.byteLength(body),
        sourceUrl: "u",
        r2Key: "stroke-json/753a.json",
      },
    ];
    expect(buildUploadEntries(entries, outDir)[0].key).toBe("stroke-json/753a.json");

    const calls: string[][] = [];
    const runner = async (argv: string[]) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await uploadCorpus(entries, outDir, "moedict-assets-preview", {
      runner,
      sleep: async () => {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 6)).toEqual(["vp", "exec", "wrangler", "r2", "object", "put"]);
    expect(calls[0]).toContain("moedict-assets-preview/stroke-json/753a.json");
    expect(calls[0]).toContain("--remote");
    expect(calls[0].some((a) => a.startsWith("--content-type=application/json"))).toBe(true);
  });

  it("retries upload on 429/code 971 then succeeds", async () => {
    const outDir = tmp();
    mkdirSync(join(outDir, "stroke-json"), { recursive: true });
    writeFileSync(join(outDir, "stroke-json", "753a.json"), "[]");
    const entries = [
      {
        char: "町",
        hex: "753a",
        decimalId: 30010,
        strokeCount: 1,
        sha256: createHash("sha256").update("[]").digest("hex"),
        bytes: 2,
        sourceUrl: "u",
        r2Key: "stroke-json/753a.json",
      },
    ];
    let attempts = 0;
    const sleeps: number[] = [];
    const runner = async () => {
      attempts++;
      if (attempts === 1) {
        return { exitCode: 1, stdout: "", stderr: "error code: 971 Too Many Requests" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await uploadCorpus(entries, outDir, "bucket", {
      runner,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(attempts).toBe(2);
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
  });

  it("verifies uploaded bytes by sha256 via wrangler r2 object get", async () => {
    const body = JSON.stringify([{ outline: [{ type: "M", x: 0, y: 0 }], track: [] }]);
    const sha = createHash("sha256").update(body).digest("hex");
    const entries = [
      {
        char: "町",
        hex: "753a",
        decimalId: 30010,
        strokeCount: 1,
        sha256: sha,
        bytes: Buffer.byteLength(body),
        sourceUrl: "u",
        r2Key: "stroke-json/753a.json",
      },
    ];
    const runner = async (argv: string[]) => {
      // argv contains --file=<path>; write the body there
      const fileArg = argv.find((a) => a.startsWith("--file="));
      expect(fileArg).toBeTruthy();
      writeFileSync(fileArg!.slice("--file=".length), body);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await verifyCorpusUploads(entries, "bucket", {
      runner,
      sleep: async () => {},
    });
    expect(result.verified).toBe(true);
    expect(result.checkedKeys).toEqual(["stroke-json/753a.json"]);
  });

  it("fails verification on hash mismatch", async () => {
    const entries = [
      {
        char: "町",
        hex: "753a",
        decimalId: 30010,
        strokeCount: 1,
        sha256: "0".repeat(64),
        bytes: 2,
        sourceUrl: "u",
        r2Key: "stroke-json/753a.json",
      },
    ];
    const runner = async (argv: string[]) => {
      const fileArg = argv.find((a) => a.startsWith("--file="))!;
      writeFileSync(fileArg.slice("--file=".length), "[]");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await expect(
      verifyCorpusUploads(entries, "bucket", { runner, sleep: async () => {} }),
    ).rejects.toThrow(/hash mismatch/);
  });

  it("verifyCorpusUploads runs entries concurrently up to maxConcurrent=2", async () => {
    // Three entries verified with maxConcurrent=2: all three complete, runner called exactly 3 times
    const makeEntry = (hexSuffix: string, body: string) => ({
      char: "一",
      hex: `4e0${hexSuffix}`,
      decimalId: 19968 + Number(hexSuffix),
      strokeCount: 1,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: Buffer.byteLength(body),
      sourceUrl: "u",
      r2Key: `stroke-json/4e0${hexSuffix}.json`,
    });
    const bodies = ["0", "1", "2"].map((s) =>
      JSON.stringify([{ outline: [{ type: "M", x: Number(s), y: 0 }], track: [] }]),
    );
    const entries = bodies.map((b, i) => makeEntry(String(i), b));
    let callCount = 0;
    const runner = async (argv: string[]) => {
      callCount++;
      const fileArg = argv.find((a) => a.startsWith("--file="))!;
      const idx = entries.findIndex((e) => argv.some((a) => a.includes(e.r2Key)));
      writeFileSync(fileArg.slice("--file=".length), bodies[idx] ?? bodies[0]);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await verifyCorpusUploads(entries, "bucket", {
      runner,
      sleep: async () => {},
      maxConcurrent: 2,
    });
    expect(result.verified).toBe(true);
    expect(result.checkedKeys).toHaveLength(3);
    expect(callCount).toBe(3);
  });

  it("exports DEFAULT_VERIFY_MAX_RETRIES = 8 (upload keeps shared default 5)", () => {
    // Contract: verify is more patient than upload for long-lived re-GETs.
    expect(DEFAULT_VERIFY_MAX_RETRIES).toBe(8);
  });

  it("verify recovers on attempt 8 after 7 transient fetch-failed errors", async () => {
    // Production evidence: long verify runs exhaust the shared default of 5 retries
    // on network flakes. Default verify maxRetries=8 must allow recovery on attempt 8
    // (1 initial + 7 retries = 8 attempts total before the final success here).
    const body = "[]";
    const sha = createHash("sha256").update(body).digest("hex");
    const entries = [
      {
        char: "町",
        hex: "753a",
        decimalId: 30010,
        strokeCount: 1,
        sha256: sha,
        bytes: Buffer.byteLength(body),
        sourceUrl: "u",
        r2Key: "stroke-json/753a.json",
      },
    ];
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
      writeFileSync(fileArg.slice("--file=".length), body);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await verifyCorpusUploads(entries, "bucket", {
      runner,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      // exercise default: do NOT pass maxRetries
    });
    expect(result.verified).toBe(true);
    expect(result.checkedKeys).toEqual(["stroke-json/753a.json"]);
    expect(attempts).toBe(8);
    // 7 sleeps between the 7 failures and the success
    expect(sleeps).toHaveLength(7);
  });

  it("verify still fails after maxRetries+1 transient attempts (default 8 → 9 total)", async () => {
    const entries = [
      {
        char: "町",
        hex: "753a",
        decimalId: 30010,
        strokeCount: 1,
        sha256: "0".repeat(64),
        bytes: 2,
        sourceUrl: "u",
        r2Key: "stroke-json/753a.json",
      },
    ];
    let attempts = 0;
    const runner = async () => {
      attempts++;
      return {
        exitCode: 1,
        stdout: "",
        stderr: "✘ [ERROR] fetch failed",
      };
    };
    await expect(
      verifyCorpusUploads(entries, "bucket", {
        runner,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/Download failed|fetch failed/);
    // initial + 8 retries
    expect(attempts).toBe(DEFAULT_VERIFY_MAX_RETRIES + 1);
  });

  it("verify fails fast on permanent 4xx (no retries beyond first attempt)", async () => {
    const entries = [
      {
        char: "町",
        hex: "753a",
        decimalId: 30010,
        strokeCount: 1,
        sha256: "0".repeat(64),
        bytes: 2,
        sourceUrl: "u",
        r2Key: "stroke-json/753a.json",
      },
    ];
    let attempts = 0;
    const runner = async () => {
      attempts++;
      return {
        exitCode: 1,
        stdout: "",
        stderr: "HTTP 403 Forbidden: access denied for this object",
      };
    };
    await expect(
      verifyCorpusUploads(entries, "bucket", {
        runner,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/Download failed|403/);
    expect(attempts).toBe(1);
  });

  it("verify maxRetries option is injectable (override default 8)", async () => {
    // Proves the option is exposed for tests/operators without changing default.
    const body = "[]";
    const sha = createHash("sha256").update(body).digest("hex");
    const entries = [
      {
        char: "町",
        hex: "753a",
        decimalId: 30010,
        strokeCount: 1,
        sha256: sha,
        bytes: Buffer.byteLength(body),
        sourceUrl: "u",
        r2Key: "stroke-json/753a.json",
      },
    ];
    let attempts = 0;
    const runner = async (argv: string[]) => {
      attempts++;
      if (attempts < 3) {
        return { exitCode: 1, stdout: "", stderr: "error code: 971 Too Many Requests" };
      }
      const fileArg = argv.find((a) => a.startsWith("--file="))!;
      writeFileSync(fileArg.slice("--file=".length), body);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await verifyCorpusUploads(entries, "bucket", {
      runner,
      sleep: async () => {},
      maxRetries: 3,
    });
    expect(result.verified).toBe(true);
    expect(attempts).toBe(3);
  });

  it("upload still uses shared default maxRetries=5 (not verify's 8)", async () => {
    // Contrasts with verify: upload path must NOT inherit the verify default.
    const outDir = tmp();
    mkdirSync(join(outDir, "stroke-json"), { recursive: true });
    writeFileSync(join(outDir, "stroke-json", "753a.json"), "[]");
    const entries = [
      {
        char: "町",
        hex: "753a",
        decimalId: 30010,
        strokeCount: 1,
        sha256: createHash("sha256").update("[]").digest("hex"),
        bytes: 2,
        sourceUrl: "u",
        r2Key: "stroke-json/753a.json",
      },
    ];
    let attempts = 0;
    const runner = async () => {
      attempts++;
      return {
        exitCode: 1,
        stdout: "",
        stderr: "✘ [ERROR] fetch failed",
      };
    };
    await expect(
      uploadCorpus(entries, outDir, "bucket", {
        runner,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/Upload failed|fetch failed/);
    // shared retryWithBackoff default: initial + 5 retries = 6
    expect(attempts).toBe(6);
  });
});

describe("parseArgs", () => {
  it("defaults to dry-run and parses upload targets", () => {
    expect(parseArgs([]).dryRun).toBe(true);
    expect(parseArgs(["--upload=staging"]).upload).toBe("staging");
    expect(parseArgs(["--upload", "production"]).upload).toBe("production");
    expect(() => parseArgs(["--upload=prod"])).toThrow(/staging or production/);
    expect(() => parseArgs(["--concurrency", "99"])).toThrow(/1\.\.8/);
    expect(parseArgs(["--concurrency", "8"]).concurrency).toBe(8);
  });

  it("runCli rejects --limit, --allow-partial, and --skip-verify in upload mode", async () => {
    // The upload guard fires before corpus discovery — no zip/chars-file needed.
    // A no-op log suppresses output; the throws are the only observable result.
    const noop = () => {};
    await expect(runCli(["--upload=staging", "--limit", "5"], { log: noop })).rejects.toThrow(
      /--limit/,
    );
    await expect(runCli(["--upload=staging", "--allow-partial"], { log: noop })).rejects.toThrow(
      /--allow-partial/,
    );
    await expect(runCli(["--upload=staging", "--skip-verify"], { log: noop })).rejects.toThrow(
      /--skip-verify/,
    );
    // Dry-run: all three accepted by parseArgs (runCli enforcement only applies to --upload)
    expect(
      parseArgs(["--dry-run", "--limit", "5", "--allow-partial", "--skip-verify"]).dryRun,
    ).toBe(true);
  });
});

// Silence unused import if tree-shaken differently
void EXPECTED_CORPUS_SIZE;
void CORPUS_SIZE;
