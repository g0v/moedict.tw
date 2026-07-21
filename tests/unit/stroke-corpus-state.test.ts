/// <reference types="node" />
/**
 * Unit tests for scripts/lib/stroke-corpus-state.mjs — local rollback-state
 * tracking for the stroke-corpus pointer. Verifies: atomic append-only
 * history, per-env namespacing, schema validation (fail-closed on corrupt
 * state), and prior-pointer retrieval semantics.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  appendCorpusPointerHistory,
  readCorpusPointerHistory,
  readPriorCorpusPointer,
  MAX_POINTER_HISTORY,
} from "../../scripts/lib/stroke-corpus-state.mjs";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stroke-corpus-state-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function entry(digestChar: string, promotedAt: string) {
  return {
    corpusDigest: digestChar.repeat(64),
    manifestKey: `stroke-corpora/${digestChar.repeat(64)}/manifest.json`,
    fileCount: 6063,
    totalBytes: 100000,
    promotedAt,
  };
}

describe("readCorpusPointerHistory / appendCorpusPointerHistory", () => {
  it("returns an empty array when no history exists yet", () => {
    expect(readCorpusPointerHistory("staging", { baseDir: dir })).toEqual([]);
  });

  it("appends entries in order (oldest first)", () => {
    appendCorpusPointerHistory("staging", entry("a", "2026-07-19T00:00:00.000Z"), {
      baseDir: dir,
    });
    appendCorpusPointerHistory("staging", entry("b", "2026-07-19T01:00:00.000Z"), {
      baseDir: dir,
    });
    const history = readCorpusPointerHistory("staging", { baseDir: dir });
    expect(history).toHaveLength(2);
    expect(history[0].corpusDigest).toBe("a".repeat(64));
    expect(history[1].corpusDigest).toBe("b".repeat(64));
  });

  it("writes atomically via temp-file-then-rename, leaving no temp file behind", () => {
    appendCorpusPointerHistory("staging", entry("a", "2026-07-19T00:00:00.000Z"), {
      baseDir: dir,
    });
    const entries = readdirSync(join(dir, "staging"));
    expect(entries).toEqual(["pointer-history.json"]);
    expect(entries.some((f) => f.includes(".tmp-"))).toBe(false);
  });

  it("namespaces history per environment — staging and production never share or clobber each other", () => {
    appendCorpusPointerHistory("staging", entry("a", "2026-07-19T00:00:00.000Z"), {
      baseDir: dir,
    });
    appendCorpusPointerHistory("production", entry("b", "2026-07-19T00:00:00.000Z"), {
      baseDir: dir,
    });
    const staging = readCorpusPointerHistory("staging", { baseDir: dir });
    const production = readCorpusPointerHistory("production", { baseDir: dir });
    expect(staging).toHaveLength(1);
    expect(production).toHaveLength(1);
    expect(staging[0].corpusDigest).toBe("a".repeat(64));
    expect(production[0].corpusDigest).toBe("b".repeat(64));
  });

  it("rejects an unsupported env", () => {
    expect(() => readCorpusPointerHistory("bogus" as never, { baseDir: dir })).toThrow(
      /Unsupported stroke-corpus env/,
    );
  });

  it("throws (fails closed) on a corrupt (non-JSON) history file", () => {
    mkdirSync(join(dir, "staging"), { recursive: true });
    writeFileSync(join(dir, "staging", "pointer-history.json"), "{not valid json", "utf-8");
    expect(() => readCorpusPointerHistory("staging", { baseDir: dir })).toThrow(/invalid JSON/);
  });

  it("throws (fails closed) when the history file is valid JSON but not an array", () => {
    mkdirSync(join(dir, "staging"), { recursive: true });
    writeFileSync(join(dir, "staging", "pointer-history.json"), JSON.stringify({ oops: true }));
    expect(() => readCorpusPointerHistory("staging", { baseDir: dir })).toThrow(/not an array/);
  });

  it("throws on a schema-invalid entry (bad corpusDigest format)", () => {
    mkdirSync(join(dir, "staging"), { recursive: true });
    writeFileSync(
      join(dir, "staging", "pointer-history.json"),
      JSON.stringify([
        {
          corpusDigest: "not-hex",
          manifestKey: "x",
          fileCount: 1,
          totalBytes: 1,
          promotedAt: "2026-07-19T00:00:00.000Z",
        },
      ]),
    );
    expect(() => readCorpusPointerHistory("staging", { baseDir: dir })).toThrow(
      /invalid corpusDigest/,
    );
  });

  it("bounds history to MAX_POINTER_HISTORY entries, dropping the oldest first, preserving newest-last order", () => {
    // digestOf(i) -> distinct 64-hex-char digest per index, so entries
    // stay individually distinguishable (entry()'s single-repeated-char
    // helper would collide past 16 entries).
    function digestOf(i: number): string {
      return i.toString(16).padStart(2, "0").repeat(32);
    }
    const total = MAX_POINTER_HISTORY + 5;
    for (let i = 0; i < total; i++) {
      appendCorpusPointerHistory(
        "staging",
        {
          corpusDigest: digestOf(i),
          manifestKey: `stroke-corpora/${digestOf(i)}/manifest.json`,
          fileCount: 6063,
          totalBytes: 100000,
          promotedAt: `2026-07-19T${String(i).padStart(2, "0")}:00:00.000Z`,
        },
        { baseDir: dir },
      );
    }
    const history = readCorpusPointerHistory("staging", { baseDir: dir });
    expect(history).toHaveLength(MAX_POINTER_HISTORY);
    // Oldest 5 (indices 0..4) were trimmed; newest-last order preserved —
    // the surviving entries are exactly indices [5 .. total-1] in order.
    expect(history[0].corpusDigest).toBe(digestOf(total - MAX_POINTER_HISTORY));
    expect(history[history.length - 1].corpusDigest).toBe(digestOf(total - 1));
    for (let i = 0; i < MAX_POINTER_HISTORY; i++) {
      expect(history[i].corpusDigest).toBe(digestOf(total - MAX_POINTER_HISTORY + i));
    }
  });

  it("throws on a schema-invalid entry (bad promotedAt)", () => {
    expect(() =>
      appendCorpusPointerHistory("staging", { ...entry("a", "not-a-date") }, { baseDir: dir }),
    ).toThrow(/invalid promotedAt/);
    // Nothing was written since validation happens before the read-modify-write.
    expect(existsSync(join(dir, "staging", "pointer-history.json"))).toBe(false);
  });
});

describe("readPriorCorpusPointer", () => {
  it("returns null when fewer than two promotions have been recorded", () => {
    expect(readPriorCorpusPointer("staging", { baseDir: dir })).toBeNull();
    appendCorpusPointerHistory("staging", entry("a", "2026-07-19T00:00:00.000Z"), {
      baseDir: dir,
    });
    expect(readPriorCorpusPointer("staging", { baseDir: dir })).toBeNull();
  });

  it("returns the entry immediately before the latest promotion (rollback target)", () => {
    appendCorpusPointerHistory("staging", entry("a", "2026-07-19T00:00:00.000Z"), {
      baseDir: dir,
    });
    appendCorpusPointerHistory("staging", entry("b", "2026-07-19T01:00:00.000Z"), {
      baseDir: dir,
    });
    appendCorpusPointerHistory("staging", entry("c", "2026-07-19T02:00:00.000Z"), {
      baseDir: dir,
    });
    const prior = readPriorCorpusPointer("staging", { baseDir: dir });
    expect(prior).not.toBeNull();
    expect(prior!.corpusDigest).toBe("b".repeat(64)); // second-to-last, not first
  });
});
