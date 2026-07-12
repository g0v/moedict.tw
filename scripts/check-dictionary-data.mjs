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
 *
 * Run: `vp run check:data` / `vp node scripts/check-dictionary-data.mjs`
 * CI:  static job.
 */

import { readdirSync, readFileSync } from "node:fs";
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

console.log(
  `[check-dictionary-data] ${totalParsed}/${totalFiles} files parsed, ` +
    `${heteronymsWithT} ptck heteronyms with T, ` +
    `${dupViolations} canonical-duplicate violation(s), ` +
    `${nfdViolations} non-NFD segment(s)`,
);

if (failures > 0) {
  console.error(`\n[check-dictionary-data] ${failures} failure(s).`);
  process.exit(1);
}
