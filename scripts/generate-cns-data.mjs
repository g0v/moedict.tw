#!/usr/bin/env node
/**
 * scripts/generate-cns-data.mjs
 *
 * Generates per-character JSON under data/dictionary/cns/by-codepoint/{shard}/{HEX}.json
 * from CNS11643 open-data archives (Properties.zip + MapingTables.zip).
 *
 * Source: https://www.cns11643.gov.tw/pageView.jsp?ID=59
 * License: OGDL-1.0 (政府資料開放授權條款-第1版)
 * Attribution: 數位發展部，CNS11643中文標準交換碼全字庫網站，https://www.cns11643.gov.tw
 *
 * Usage:
 *   node scripts/generate-cns-data.mjs [--properties=<path>] [--mapping=<path>] [--out=<dir>]
 *                                       [--dry-run] [--limit=<n>]
 *
 * Defaults:
 *   --properties  /tmp/Properties.zip
 *   --mapping     /tmp/MapingTables.zip
 *   --out         data/dictionary/cns/by-codepoint
 *
 * Phase 1: Excludes PUA characters (U+E000–U+F8FF BMP PUA, U+F0000–U+FFFFF PUA-A,
 *          U+100000–U+10FFFF PUA-B). Only standard Unicode scalars are emitted.
 *
 * Shard formula (from neuralese bucket.cns.proposal.v1):
 *   hex = codepoint.toString(16).toUpperCase()
 *   shard = hex.length <= 4 ? hex.slice(0, 2) : hex.slice(0, 3)
 *   key = cns/by-codepoint/${shard}/${hex}.json
 *
 * Golden sample: 䴉 (CNS 4-6C51 = U+4D09) → phonetic ㄒㄩㄢˊ, stroke 24,
 *   radical 196 (鳥), cangjie WVHAF, strokeSeq 252211251353432511154444
 *
 * Safety guarantees:
 *   - Full (non-limited, non-dry-run) generation writes to a unique sibling temp
 *     directory, validates the complete corpus, then atomically renames into OUT_DIR.
 *     OUT_DIR is never partially written; old content survives any failure.
 *   - Duplicate Unicode output-key detection: two CNS codes resolving to the same
 *     Unicode codepoint cause an immediate fatal error before any swap.
 *   - For full runs: exact count gates and unique-file count gate enforced before swap.
 *   - Golden U+4D09 record validated semantically before swap; tracked bytes restored
 *     after swap so git status stays clean.
 *   - Dry-run runs write nothing. Limited runs (--limit=N) require an explicit
 *     --out directory that does NOT already exist (prevents partial overwrite of
 *     an existing corpus); they write N files in-place without atomic swap or count
 *     gates (intended for debugging/sampling only). Full runs retain atomic
 *     temp/swap with count gates and golden validation.
 *   - Unsafe OUT_DIR values rejected before any I/O.
 *
 * Pure utility functions (testable without opening zip files) live in
 * scripts/lib/cns-gen-utils.mjs and are re-exported from here for callers.
 */

import { createReadStream } from "node:fs";
import { execSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat as statFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_EMITTED,
  EXPECTED_SKIPPED_NOMAP,
  EXPECTED_SKIPPED_PUA,
  GOLDEN_RELATIVE,
  REPO_ROOT,
  assertSafeOutDir,
  countJsonFiles,
  hexOf,
  isPUA,
  isValidScalar,
  shardOf,
  validateGoldenRecord,
} from "./lib/cns-gen-utils.mjs";

// Re-export so callers who import from this entrypoint still get them.
export {
  EXPECTED_EMITTED,
  EXPECTED_SKIPPED_NOMAP,
  EXPECTED_SKIPPED_PUA,
  GOLDEN_RELATIVE,
  REPO_ROOT,
  assertSafeOutDir,
  countJsonFiles,
  hexOf,
  isPUA,
  isValidScalar,
  shardOf,
  validateGoldenRecord,
} from "./lib/cns-gen-utils.mjs";
export { expectedKey, EXPECTED_UNIQUE_FILES } from "./lib/cns-gen-utils.mjs";

// ── Parse CLI args ──────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  }),
);

const PROPERTIES_ZIP = args["properties"] ?? "/tmp/Properties.zip";
const MAPPING_ZIP = args["mapping"] ?? "/tmp/MapingTables.zip";
const OUT_DIR = path.resolve(REPO_ROOT, args["out"] ?? "data/dictionary/cns/by-codepoint");
const DRY_RUN = args["dry-run"] === "true" || args["dry-run"] === "";
const LIMIT = args["limit"] ? parseInt(args["limit"], 10) : Infinity;
const IS_FULL_RUN = LIMIT === Infinity && !DRY_RUN;

// ── Zip extraction helper ────────────────────────────────────────────────────

// Specifier in a variable prevents Vite's import-analysis plugin from trying
// to resolve `unzipper` at bundle time. The package is optional: if absent,
// the catch branch falls back to the shell `unzip` binary.
const _unzipperSpecifier = "unzipper";

async function readZipMember(zipPath, memberName) {
  try {
    // Dynamic import: `unzipper` is optional — may not be installed.
    // _unzipperSpecifier is a module-level variable so Vite cannot statically
    // resolve it; the catch branch falls back to shell `unzip`.
    const unzipper = await import(_unzipperSpecifier);
    return await new Promise((resolve, reject) => {
      const chunks = [];
      createReadStream(zipPath)
        .pipe(unzipper.Parse())
        .on("entry", (entry) => {
          if (entry.path === memberName) {
            entry.on("data", (c) => chunks.push(c));
            entry.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
          } else {
            entry.autodrain();
          }
        })
        .on("finish", () => {
          if (chunks.length === 0)
            reject(new Error(`Member not found: ${memberName} in ${zipPath}`));
        })
        .on("error", reject);
    });
  } catch {
    return execSync(`unzip -p "${zipPath}" "${memberName}"`, {
      maxBuffer: 200 * 1024 * 1024,
    }).toString("utf-8");
  }
}

// ── TSV parser ──────────────────────────────────────────────────────────────

function parseTsv(content) {
  return content
    .replace(/^\uFEFF/, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .map((l) => l.split("\t"));
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function main() {
  console.log("📦 CNS11643 data generator");
  console.log(`   Properties: ${PROPERTIES_ZIP}`);
  console.log(`   Mapping:    ${MAPPING_ZIP}`);
  console.log(`   Output:     ${OUT_DIR}`);
  if (DRY_RUN) console.log("   [DRY RUN — no files written]");
  if (LIMIT !== Infinity) console.log(`   [LIMITED to ${LIMIT} records — no swap]`);
  if (IS_FULL_RUN) console.log("   [FULL RUN — atomic swap, count gates enforced]");

  assertSafeOutDir(OUT_DIR);

  // Snapshot the tracked golden bytes before any write, so we can restore them
  // after the swap (generator output may differ in whitespace formatting).
  let trackedGoldenBytes = null;
  if (IS_FULL_RUN) {
    const goldenPath = path.join(OUT_DIR, GOLDEN_RELATIVE);
    try {
      trackedGoldenBytes = await readFile(goldenPath, "utf-8");
    } catch {
      // Golden absent (first run) — field-level validation only; no byte-restore.
    }
  }

  // ── Load all data tables ────────────────────────────────────────────────

  console.log("\n🗺  Loading Unicode mapping tables…");
  const mapFiles = [
    "Unicode/CNS2UNICODE_Unicode BMP.txt",
    "Unicode/CNS2UNICODE_Unicode 2.txt",
    "Unicode/CNS2UNICODE_Unicode 3.txt",
    "Unicode/CNS2UNICODE_Unicode 15.txt",
  ];
  /** @type {Map<string, {unicodeHex:string, isPUA:boolean}>} */
  const cnsToUnicode = new Map();
  for (const mf of mapFiles) {
    const content = await readZipMember(MAPPING_ZIP, mf);
    for (const row of parseTsv(content)) {
      if (row.length < 2) continue;
      const [cns, unicodeHex] = row;
      if (!cns || !unicodeHex) continue;
      const cp = parseInt(unicodeHex, 16);
      if (!isValidScalar(cp)) continue;
      if (!cnsToUnicode.has(cns)) {
        cnsToUnicode.set(cns, { unicodeHex: unicodeHex.toUpperCase(), isPUA: isPUA(cp) });
      }
    }
  }
  console.log(`   Loaded ${cnsToUnicode.size} CNS→Unicode mappings`);

  console.log("\n📏 Loading CNS_stroke (universe)…");
  const strokeMap = new Map();
  for (const row of parseTsv(await readZipMember(PROPERTIES_ZIP, "CNS_stroke.txt"))) {
    if (row.length < 2) continue;
    const [cns, strokeStr] = row;
    if (!cns || !strokeStr) continue;
    const n = parseInt(strokeStr, 10);
    if (Number.isFinite(n)) strokeMap.set(cns, n);
  }
  console.log(`   ${strokeMap.size} CNS codes in stroke universe`);

  console.log("\n🔤 Loading CNS_phonetic…");
  const phoneticMap = new Map();
  for (const row of parseTsv(await readZipMember(PROPERTIES_ZIP, "CNS_phonetic.txt"))) {
    if (row.length < 2) continue;
    const [cns, bpmf] = row;
    if (!cns || !bpmf) continue;
    const arr = phoneticMap.get(cns) ?? [];
    if (!arr.includes(bpmf)) arr.push(bpmf);
    phoneticMap.set(cns, arr);
  }

  console.log("🌿 Loading CNS_radical…");
  const radicalMap = new Map();
  for (const row of parseTsv(await readZipMember(PROPERTIES_ZIP, "CNS_radical.txt"))) {
    if (row.length < 2) continue;
    const [cns, rid] = row;
    if (!cns || !rid) continue;
    radicalMap.set(cns, parseInt(rid, 10));
  }

  console.log("📖 Loading CNS_radical_word…");
  const radicalWordMap = new Map();
  for (const row of parseTsv(await readZipMember(PROPERTIES_ZIP, "CNS_radical_word.txt"))) {
    if (row.length < 2) continue;
    const [id, char] = row;
    if (!id || !char) continue;
    radicalWordMap.set(parseInt(id, 10), char);
  }

  console.log("🔡 Loading CNS_cangjie…");
  const cangjieMap = new Map();
  for (const row of parseTsv(await readZipMember(PROPERTIES_ZIP, "CNS_cangjie.txt"))) {
    if (row.length < 2) continue;
    const [cns, cj] = row;
    if (!cns || !cj) continue;
    const arr = cangjieMap.get(cns) ?? [];
    if (!arr.includes(cj)) arr.push(cj);
    cangjieMap.set(cns, arr);
  }

  console.log("✏️  Loading CNS_strokes_sequence…");
  const strokeSeqMap = new Map();
  for (const row of parseTsv(await readZipMember(PROPERTIES_ZIP, "CNS_strokes_sequence.txt"))) {
    if (row.length < 2) continue;
    const [cns, seq] = row;
    if (!cns || !seq) continue;
    strokeSeqMap.set(cns, seq);
  }

  console.log("📜 Loading CNS_source…");
  const sourceMap = new Map();
  for (const row of parseTsv(await readZipMember(PROPERTIES_ZIP, "CNS_source.txt"))) {
    if (row.length < 2) continue;
    const [cns, src] = row;
    if (!cns || !src) continue;
    sourceMap.set(cns, src);
  }

  // ── Emit per-character JSON ───────────────────────────────────────────────

  console.log("\n💾 Emitting per-character JSON…");

  const provenance = {
    generator: "scripts/generate-cns-data.mjs",
    sourceFiles: ["Properties.zip", "MapingTables.zip"],
    license: "OGDL-1.0",
    attribution: "數位發展部，CNS11643中文標準交換碼全字庫網站，https://www.cns11643.gov.tw",
  };

  let emitted = 0;
  let skippedPUA = 0;
  let skippedNoMapping = 0;

  // Full runs write to a unique temp sibling, then atomically install on success.
  // Dry-run writes nothing. Limited runs require an explicit --out that does NOT
  // already exist — this prevents partially overwriting an existing corpus.
  let writeDir = OUT_DIR;
  let tmpDir = null;
  let oldDir = null; // tracks the .old backup during swap; separate from tmpDir

  if (!IS_FULL_RUN && !DRY_RUN && LIMIT !== Infinity) {
    // Limited run: refuse to write to an existing directory to prevent partial
    // overwrite of an existing corpus. The user must supply a fresh --out path.
    try {
      await statFile(OUT_DIR);
      // If statFile resolves, the directory exists — fail closed.
      throw new Error(
        `Limited run --out=${OUT_DIR} already exists. ` +
          `Use a fresh --out path (e.g. /tmp/cns-sample) to avoid partial overwrite.`,
      );
    } catch (err) {
      // Re-throw our own error; ENOENT means the dir is absent (safe to write).
      if (err instanceof Error && err.message.includes("already exists")) throw err;
      // ENOENT — directory doesn't exist, proceed to write.
    }
  }

  if (IS_FULL_RUN) {
    const parentDir = path.dirname(OUT_DIR);
    await mkdir(parentDir, { recursive: true });
    // Prefix matches gitignore pattern "data/dictionary/cns/.cns-gen-tmp-*"
    tmpDir = await mkdtemp(path.join(parentDir, ".cns-gen-tmp-"));
    writeDir = tmpDir;
    console.log(`   [temp dir: ${path.basename(tmpDir)}]`);
  }

  // Duplicate Unicode output-key detector.
  // CNS11643 cross-plane unification can map two CNS codes to the same Unicode
  // codepoint, producing the same output filename. We treat this as fatal:
  // silent last-write-wins produces a corpus where the emitted count exceeds
  // the unique-file count and the losing CNS code's data is silently discarded.
  /** @type {Map<string, string>} hex → first CNS code seen */
  const seenHex = new Map();

  try {
    for (const [cns, stroke] of strokeMap) {
      if (emitted >= LIMIT) break;

      const mapping = cnsToUnicode.get(cns);
      if (!mapping) {
        skippedNoMapping++;
        continue;
      }
      if (mapping.isPUA) {
        skippedPUA++;
        continue;
      }

      const cp = parseInt(mapping.unicodeHex, 16);

      // Per-record invariant: valid scalar, not PUA (belt-and-suspenders)
      if (!isValidScalar(cp)) {
        throw new Error(`Invalid scalar U+${hexOf(cp)} for CNS ${cns}`);
      }
      if (isPUA(cp)) {
        throw new Error(`PUA codepoint U+${hexOf(cp)} for CNS ${cns} slipped past filter`);
      }

      const hex = hexOf(cp);

      // Duplicate output-key detection (fatal)
      if (seenHex.has(hex)) {
        throw new Error(
          `Duplicate output key ${hex}.json: CNS ${seenHex.get(hex)} and CNS ${cns} ` +
            `both resolve to U+${hex}. Resolve cross-plane collision before uploading.`,
        );
      }
      seenHex.set(hex, cns);

      const char = String.fromCodePoint(cp);
      const shard = shardOf(cp);
      const cnsParts = cns.split("-");
      const plane = parseInt(cnsParts[0], 10);
      const cell = cnsParts[1] ?? "";
      const radicalId = radicalMap.get(cns);
      const radicalChar = radicalId != null ? (radicalWordMap.get(radicalId) ?? null) : null;

      const record = {
        char,
        unicode: `U+${hex}`,
        codepoint: cp,
        cns,
        plane,
        cell,
        pua: false,
        attributes: {
          phonetic: phoneticMap.get(cns) ?? [],
          ...(radicalId != null ? { radical: { id: radicalId, char: radicalChar } } : {}),
          stroke,
          ...(cangjieMap.has(cns) ? { cangjie: cangjieMap.get(cns) } : {}),
          ...(strokeSeqMap.has(cns) ? { strokeSequence: strokeSeqMap.get(cns) } : {}),
          ...(sourceMap.has(cns) ? { source: sourceMap.get(cns) } : {}),
        },
        provenance,
      };

      if (!DRY_RUN) {
        const outDir = path.join(writeDir, shard);
        await mkdir(outDir, { recursive: true });
        await writeFile(path.join(outDir, `${hex}.json`), JSON.stringify(record, null, 2), "utf-8");
      }

      emitted++;
      if (emitted % 5000 === 0) process.stdout.write(`   ${emitted} written…\r`);
    }

    // ── Full-run post-generation validation (before swap) ────────────────

    if (IS_FULL_RUN) {
      console.log("\n🔍 Validating full corpus before swap…");

      if (emitted !== EXPECTED_EMITTED) {
        throw new Error(`Count gate: emitted ${emitted}, expected ${EXPECTED_EMITTED}`);
      }
      if (skippedPUA !== EXPECTED_SKIPPED_PUA) {
        throw new Error(`Count gate: skipped PUA ${skippedPUA}, expected ${EXPECTED_SKIPPED_PUA}`);
      }
      if (skippedNoMapping !== EXPECTED_SKIPPED_NOMAP) {
        throw new Error(
          `Count gate: skipped no-map ${skippedNoMapping}, expected ${EXPECTED_SKIPPED_NOMAP}`,
        );
      }

      const actualFiles = await countJsonFiles(tmpDir);
      if (actualFiles !== EXPECTED_EMITTED) {
        throw new Error(
          `File count gate: ${actualFiles} JSON files on disk, expected ${EXPECTED_EMITTED}`,
        );
      }
      console.log(`   ✓ emitted=${emitted}, skippedPUA=${skippedPUA}, files=${actualFiles}`);

      if (trackedGoldenBytes !== null) {
        await validateGoldenRecord(tmpDir, trackedGoldenBytes);
      } else {
        // First-run fallback: validate key fields directly
        const genRaw = await readFile(path.join(tmpDir, GOLDEN_RELATIVE), "utf-8");
        const r = JSON.parse(genRaw);
        if (
          r.char !== "䴉" ||
          r.cns !== "4-6C51" ||
          r.pua !== false ||
          r.attributes?.stroke !== 24
        ) {
          throw new Error(`Golden U+4D09 field validation failed: ${JSON.stringify(r)}`);
        }
      }
      console.log("   ✓ golden U+4D09 (䴉) semantically validated");

      // ── Atomic swap (safe 3-step, advisory 2026-07-15) ───────────────────
      // Step 1: rename OUT_DIR → .old  (tolerate absent; prefix is gitignored)
      // Step 2: rename tmpDir  → OUT_DIR
      // Step 3: rm .old        (best-effort)
      //
      // If step 2 throws, old content survives in .old; the catch block only
      // cleans tmpDir. tmpDir is nulled only after step 2 succeeds, so
      // `catch (err) { if (tmpDir) rm(tmpDir) }` never deletes OUT_DIR.
      console.log(`\n🔄 Installing corpus → ${OUT_DIR}…`);
      const outParent = path.dirname(OUT_DIR);
      // Step 1: move aside (gitignored .cns-gen-old- prefix)
      oldDir = path.join(outParent, `.cns-gen-old-${process.pid}`);
      try {
        await rename(OUT_DIR, oldDir);
      } catch (err) {
        // Only tolerate ENOENT (OUT_DIR absent — first run, nothing to preserve).
        // Other errors (EACCES, EBUSY, ENOSPC) must propagate so the caller knows
        // the swap failed and tmpDir is cleaned up without losing OUT_DIR content.
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
          oldDir = null;
        } else {
          throw err;
        }
      }
      // Step 2: install (if this throws, old content is alive in oldDir)
      await rename(tmpDir, OUT_DIR);
      tmpDir = null; // prevent catch from deleting newly-installed OUT_DIR

      // ── Restore tracked golden bytes ──────────────────────────────────────
      // The generator uses JSON.stringify(record, null, 2); the committed golden
      // uses compact inline arrays. Restore tracked bytes so git status is clean.
      // If this fails, roll back: remove the new (incomplete) OUT_DIR and rename
      // oldDir back so the pre-run corpus survives. If rollback also fails, report
      // both errors and never delete oldDir.
      if (trackedGoldenBytes !== null) {
        try {
          await writeFile(path.join(OUT_DIR, GOLDEN_RELATIVE), trackedGoldenBytes, "utf-8");
          console.log("   ✓ tracked golden bytes restored");
        } catch (goldenErr) {
          const goldenMsg = goldenErr instanceof Error ? goldenErr.message : String(goldenErr);
          console.error(`\n❌ Golden restore failed: ${goldenMsg}`);
          if (oldDir !== null) {
            console.error(
              `   Rolling back: removing new OUT_DIR, restoring old corpus from ${path.basename(oldDir)}…`,
            );
            try {
              await rm(OUT_DIR, { recursive: true, force: true });
              await rename(oldDir, OUT_DIR);
              oldDir = null; // successfully rolled back
              console.error("   ✓ Rollback succeeded — pre-run corpus restored.");
            } catch (rollbackErr) {
              const rollbackMsg =
                rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
              console.error(`   ❌ ROLLBACK FAILED: ${rollbackMsg}`);
              console.error(`   Old corpus preserved at ${oldDir} — rename back manually.`);
              console.error(`   New (incomplete) corpus left at ${OUT_DIR} — remove manually.`);
              // NEVER delete oldDir — it's the only surviving copy.
              throw new Error(
                `Golden restore failed (${goldenMsg}) ` +
                  `AND rollback failed (${rollbackMsg}). ` +
                  `Old corpus at ${oldDir}, incomplete corpus at ${OUT_DIR}.`,
              );
            }
          }
          throw goldenErr;
        }
      }

      // Step 3: remove old backup (best-effort; failure leaves a gitignored dir)
      if (oldDir !== null) {
        await rm(oldDir, { recursive: true, force: true }).catch(() => {});
        oldDir = null;
      }

      console.log("   ✓ swap complete");
    }
  } catch (err) {
    // Clean up tmpDir only — never touch oldDir (it preserves the pre-run corpus).
    if (tmpDir) {
      console.error(`\n❌ Failure — cleaning up temp dir`);
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
    if (oldDir !== null) {
      console.error(
        `   Pre-run corpus preserved at ${path.basename(oldDir)} — rename back if needed`,
      );
    }
    throw err;
  }

  console.log(`\n✅ Done.`);
  console.log(`   Emitted:         ${emitted}`);
  console.log(`   Skipped PUA:     ${skippedPUA}`);
  console.log(`   Skipped no-map:  ${skippedNoMapping}`);
  if (emitted + skippedPUA + skippedNoMapping < strokeMap.size) {
    console.log(`   Skipped (limit): ${strokeMap.size - emitted - skippedPUA - skippedNoMapping}`);
  }
  if (DRY_RUN) console.log("   [DRY RUN — no files written]");
  else if (!IS_FULL_RUN) console.log("   [LIMITED RUN — no swap]");
}

/* v8 ignore start -- real CLI entrypoint */
const invokedDirectly = (() => {
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
/* v8 ignore stop */
