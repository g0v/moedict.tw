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
 *  5. `data/dictionary/{a,t,h,c}/xref-by-id.json` must all exist and parse
 *     as a JSON object (not array). `commands/upload_dictionary.sh` rclone
 *     **sync**s each `{lang}/` folder to R2, which deletes remote keys with
 *     no local counterpart — a locally-absent sidecar would silently delete
 *     the live R2 object. `t` must additionally be non-empty: production
 *     ships real cross-lang by-heteronym-ID data there, recovered
 *     byte-for-byte from `wrangler r2 object get
 *     moedict-dictionary/t/xref-by-id.json --remote` and cross-checked
 *     against the public API response (2026-07-18). `a/h/c` R2 keys are
 *     confirmed ABSENT via the same command ("The specified key does not
 *     exist"); their local `{}` pins the Worker's own missing-object API
 *     fallback response (not a byte-for-byte R2 object).
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
const INVENTORY_CHECKER = path.join(REPO_ROOT, "scripts", "check-dictionary-inventory.mjs");
try {
  execFileSync(process.execPath, [INVENTORY_CHECKER], { cwd: REPO_ROOT, stdio: "inherit" });
} catch {
  process.exit(1);
}
const VARIANT_SOURCE = path.join(REPO_ROOT, "data", "sources", "twblg-overrides", "x-異用字.json");
const VARIANT_INJECTOR = path.join(REPO_ROOT, "scripts", "inject-twblg-variants.py");
try {
  execFileSync(
    "python3",
    [VARIANT_INJECTOR, VARIANT_SOURCE, path.join(DICT_DIR, "ptck"), "--check"],
    {
      cwd: REPO_ROOT,
      stdio: "inherit",
    },
  );
} catch {
  process.exit(1);
}
const DERIVED_CHECKER = path.join(REPO_ROOT, "scripts", "check-derived-data.mjs");
try {
  execFileSync(process.execPath, [DERIVED_CHECKER], { cwd: REPO_ROOT, stdio: "inherit" });
} catch {
  process.exit(1);
}

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

// --- Check 5: xref-by-id.json sidecars (a/t/h/c) must exist with a valid
// shape. `commands/upload_dictionary.sh` rclone-**sync**s the `{lang}/`
// folders to R2 — `sync` deletes any remote key with no local counterpart,
// so a locally-absent `xref-by-id.json` would silently DELETE the live R2
// sidecar. `t/xref-by-id.json` is recovered byte-for-byte from the real R2
// object (confirmed via `wrangler r2 object get
// moedict-dictionary/t/xref-by-id.json --remote`, cross-checked against the
// public `/api/xref-by-id/t.json` API response, 2026-07-18). `a/h/c` R2
// keys are confirmed ABSENT (same `wrangler r2 object get --remote` command
// returns "The specified key does not exist") — their local `{}` pins the
// Worker's own missing-object API fallback response (not a byte-for-byte R2
// object), which prevents local-dev 404s and stops rclone sync from ever
// having a key to delete. This check only enforces presence + that the
// top level parses to a plain object (not array/null) — it does NOT walk
// or assert the deeper `{sourceLang: {title: {id: [word...]}}}` nesting,
// so a shape violation below the top level is not caught here. It also
// does NOT assert `t`'s exact content so future legitimate re-uploads
// aren't blocked, but DOES require `t` stay non-empty so an accidental
// overwrite with `{}` is caught before it reaches R2.
const XREF_BY_ID_LANGS = ["a", "t", "h", "c"];
let xrefByIdCheckedCount = 0;
for (const lang of XREF_BY_ID_LANGS) {
  const file = path.join(DICT_DIR, lang, "xref-by-id.json");
  const rel = path.relative(REPO_ROOT, file);
  if (!existsSync(file)) {
    fail(
      `${rel} is missing — commands/upload_dictionary.sh's rclone sync would ` +
        `DELETE the live R2 sidecar at this key on next upload`,
    );
    continue;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    fail(`${rel} is not valid JSON: ${e.message}`);
    continue;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(
      `${rel} must be a JSON object at the top level (expected shape: ` +
        `{sourceLang: {title: {id: [word...]}}}, not validated below the ` +
        `top level here), got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
    );
    continue;
  }
  if (lang === "t" && Object.keys(parsed).length === 0) {
    fail(
      `${rel} is an empty object — production has real 台語→華語 xref-by-id ` +
        `data (532,761 bytes as of 2026-07-18); an empty file here means the ` +
        `real sidecar was lost and the next rclone sync would delete it from R2`,
    );
    continue;
  }
  xrefByIdCheckedCount++;
}
// --- Check 6: Warn loudly if data/dictionary has uncommitted working-tree changes.
try {
  const status = execFileSync("git", ["status", "--porcelain", "--", "data/dictionary"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  if (status) {
    const dirtyCount = status.split("\n").filter(Boolean).length;
    console.warn(
      `\n⚠️  [check-dictionary-data] WARNING: data/dictionary has ${dirtyCount} uncommitted working-tree change(s)!\n` +
        `   upload_dictionary.sh will REFUSE to upload while dirty.\n` +
        `   Commit first (\`git commit -- data/dictionary\`), then upload to R2.\n` +
        `   Pointer write (dictionary-corpus/current.json LAST) only cache-busts Worker edge/pack memo;\n` +
        `   flat R2 keys are overwritten in place (not atomic; not rollback-by-pointer).`,
    );
  }
} catch {
  /* non-fatal if git is unavailable */
}

console.log(
  `[check-dictionary-data] ${totalParsed}/${totalFiles} files parsed, ` +
    `${heteronymsWithT} ptck heteronyms with T, ` +
    `${dupViolations} canonical-duplicate violation(s), ` +
    `${nfdViolations} non-NFD segment(s), ` +
    `${pinnedCheckedCount} pinned no-definition entr${pinnedCheckedCount === 1 ? "y" : "ies"} checked, ` +
    `${xrefByIdCheckedCount}/${XREF_BY_ID_LANGS.length} xref-by-id sidecars valid`,
);

if (failures > 0) {
  console.error(`\n[check-dictionary-data] ${failures} failure(s).`);
  process.exit(1);
}
