#!/usr/bin/env node
/**
 * Validates the integrity of the raw dictionary data files under
 * `data/dictionary/{pack,pcck,phck,ptck}/*.txt`.
 *
 * Checks:
 *  1. Every `*.txt` in the four dictionary dirs must JSON.parse.
 *  2. For every ptck heteronym with a string `T` (slash-separated
 *     reading list): FAIL if two segments are equal after
 *     `.normalize('NFC')` — canonical-duplicate readings. This exact
 *     bug shipped once: "beh-nî/bueh-nî/bueh-nî" with NFC/NFD mixed
 *     forms that looked different but were canonically identical.
 *  3. Every ptck T segment must already be in NFD form
 *     (`s === s.normalize('NFD')`) — hard gate. The corpus was verified
 *     100% NFD (2026-07); any non-NFD segment is a regression, typically
 *     an NFC string merged from upstream CSV without normalize('NFD').
 *  4. Every entry pinned in
 *     `data/sources/twblg-overrides/pinned-no-definition.json` (see
 *     scripts/inject-twblg-pinned-entries.py, g0v/moedict-webkit#271) must
 *     be present in its ptck bucket with the EXACT expected value —
 *     delegated to `inject-twblg-pinned-entries.py --check` (non-mutating)
 *     so the expected-value derivation (NFD, title markup, bucket/key
 *     encoding) has one implementation, not a second reimplementation here
 *     that could silently drift from the injector.
 *
 * Run: `vp run check:data` / `vp node scripts/check-dictionary-data.mjs`
 * CI:  static job.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DICT_DIR = path.join(REPO_ROOT, "data", "dictionary");

const SUBDIRS = ["pack", "pcck", "phck", "ptck"];

let failures = 0;

function fail(message) {
  console.error(`[check-dictionary-data] FAIL: ${message}`);
  failures++;
}

function listTxtFiles(subdir) {
  const dir = path.join(DICT_DIR, subdir);
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".txt"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// --- Check 1: every txt must JSON.parse ---
let totalFiles = 0;
let totalParsed = 0;
const ptckData = []; // [{ file, data }] for checks 2 & 3

for (const subdir of SUBDIRS) {
  const files = listTxtFiles(subdir);
  for (const file of files) {
    totalFiles++;
    const rel = path.relative(REPO_ROOT, file);
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      fail(`${rel}: cannot read file — ${e.message}`);
      continue;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      fail(`${rel}: JSON.parse failed — ${e.message}`);
      continue;
    }
    totalParsed++;
    if (subdir === "ptck") {
      ptckData.push({ rel, data });
    }
  }
}

// --- Check 2 & 3: ptck T-field integrity ---
let heteronymsWithT = 0;
let dupViolations = 0;
let nfdViolations = 0;

for (const { rel, data } of ptckData) {
  if (!data || typeof data !== "object") continue;
  for (const [key, entry] of Object.entries(data)) {
    if (!entry || !Array.isArray(entry.h)) continue;
    for (const het of entry.h) {
      if (!het || typeof het.T !== "string") continue;
      heteronymsWithT++;
      const segs = het.T.split("/");
      const normed = segs.map((s) => s.normalize("NFC"));

      // Check 2: canonical-duplicate readings
      const seen = new Set();
      for (const n of normed) {
        if (seen.has(n)) {
          dupViolations++;
          fail(
            `${rel}: entry "${key}" has canonical-duplicate reading "${n}" ` + `in T="${het.T}"`,
          );
        }
        seen.add(n);
      }

      // Check 3: NFD form — hard gate. Current data was verified 100% NFD
      // (2026-07); any non-NFD segment is a regression (typically an NFC
      // string merged from upstream CSV without normalize('NFD')).
      for (const s of segs) {
        if (s !== s.normalize("NFD")) {
          nfdViolations++;
          fail(`${rel}: entry "${key}" T segment "${s}" is not in NFD form`);
        }
      }
    }
  }
}

// --- Check 4: pinned no-definition entries (g0v/moedict-webkit#271) ---
// Delegates to the injector's own --check mode (single source of truth for
// how an expected pack entry is derived from a manifest row) rather than
// re-deriving NFD/bucket/title-markup rules a second time in JS.
const PINNED_MANIFEST = path.join(
  REPO_ROOT,
  "data",
  "sources",
  "twblg-overrides",
  "pinned-no-definition.json",
);
const PTCK_DIR = path.join(DICT_DIR, "ptck");
const INJECTOR = path.join(REPO_ROOT, "scripts", "inject-twblg-pinned-entries.py");
let pinnedCheckedCount = 0;
if (!existsSync(PINNED_MANIFEST)) {
  fail(
    `pinned no-definition manifest missing at ${path.relative(REPO_ROOT, PINNED_MANIFEST)} ` +
      `— g0v/moedict-webkit#271 provenance would silently stop being verified`,
  );
} else {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(PINNED_MANIFEST, "utf8"));
  } catch (e) {
    fail(`pinned no-definition manifest is not valid JSON: ${e.message}`);
  }
  if (manifest) {
    pinnedCheckedCount = Array.isArray(manifest.entries) ? manifest.entries.length : 0;
    if (pinnedCheckedCount === 0) {
      fail(
        "pinned no-definition manifest has zero entries — expected at least " +
          "the 長褲 (g0v/moedict-webkit#271) pin shipped with this repo",
      );
    } else {
      try {
        execFileSync("python3", [INJECTOR, PINNED_MANIFEST, PTCK_DIR, "--check"], {
          cwd: REPO_ROOT,
          stdio: "pipe",
          encoding: "utf8",
        });
      } catch (e) {
        const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
        fail(`pinned no-definition manifest check failed:\n${output || e.message}`);
      }
    }
  }
}

console.log(
  `[check-dictionary-data] ${totalParsed}/${totalFiles} files parsed, ` +
    `${heteronymsWithT} ptck heteronyms with T, ` +
    `${dupViolations} canonical-duplicate violation(s), ` +
    `${nfdViolations} non-NFD segment(s), ` +
    `${pinnedCheckedCount} pinned no-definition entr${pinnedCheckedCount === 1 ? "y" : "ies"} checked`,
);

if (failures > 0) {
  console.error(`\n[check-dictionary-data] ${failures} failure(s).`);
  process.exit(1);
}
