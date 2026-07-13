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
 */

import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

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

// ── PUA classifier (numeric range, never file-based) ───────────────────────

function isPUA(cp) {
  return (
    (cp >= 0xe000 && cp <= 0xf8ff) || // BMP PUA
    (cp >= 0xf0000 && cp <= 0xfffff) || // PUA-A (Unicode 15 rows are all here)
    (cp >= 0x100000 && cp <= 0x10ffff) // PUA-B
  );
}

function isValidScalar(cp) {
  return cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
}

// ── Shard formula ───────────────────────────────────────────────────────────

function shardOf(cp) {
  const hex = cp.toString(16).toUpperCase();
  return hex.length <= 4 ? hex.slice(0, 2) : hex.slice(0, 3);
}

function hexOf(cp) {
  return cp.toString(16).toUpperCase();
}

// ── Zip extraction helper (uses unzipper if available, else shell unzip) ────

async function readZipMember(zipPath, memberName) {
  // Try unzipper (npm package) first, else fall back to shell
  try {
    const unzipper = await import("unzipper");
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
    // fallback: shell unzip -p
    const { execSync } = await import("node:child_process");
    return execSync(`unzip -p "${zipPath}" "${memberName}"`, {
      maxBuffer: 200 * 1024 * 1024,
    }).toString("utf-8");
  }
}

// ── TSV parser (tab-separated, no quoting, strip BOM) ──────────────────────

function parseTsv(content) {
  const lines = content.replace(/^\uFEFF/, "").split("\n");
  return lines
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .map((l) => l.split("\t"));
}

// ── Main pipeline ────────────────────────────────────────────────────────────

async function main() {
  console.log("📦 CNS11643 data generator");
  console.log(`   Properties: ${PROPERTIES_ZIP}`);
  console.log(`   Mapping:    ${MAPPING_ZIP}`);
  console.log(`   Output:     ${OUT_DIR}`);
  if (DRY_RUN) console.log("   [DRY RUN — no files written]");

  // ── 1. Load Unicode mapping (CNS → Unicode hex) ──────────────────────────
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

  // ── 2. Load CNS_stroke (universe key) ────────────────────────────────────
  console.log("\n📏 Loading CNS_stroke (universe)…");
  const strokeContent = await readZipMember(PROPERTIES_ZIP, "CNS_stroke.txt");
  /** @type {Map<string, number>} */
  const strokeMap = new Map();
  for (const row of parseTsv(strokeContent)) {
    if (row.length < 2) continue;
    const [cns, strokeStr] = row;
    if (!cns || !strokeStr) continue;
    const n = parseInt(strokeStr, 10);
    if (!Number.isFinite(n)) continue;
    strokeMap.set(cns, n);
  }
  console.log(`   ${strokeMap.size} CNS codes in stroke universe`);

  // ── 3. Load phonetic (multi-row) ─────────────────────────────────────────
  console.log("\n🔤 Loading CNS_phonetic…");
  const phoneticContent = await readZipMember(PROPERTIES_ZIP, "CNS_phonetic.txt");
  /** @type {Map<string, string[]>} */
  const phoneticMap = new Map();
  for (const row of parseTsv(phoneticContent)) {
    if (row.length < 2) continue;
    const [cns, bpmf] = row;
    if (!cns || !bpmf) continue;
    const arr = phoneticMap.get(cns) ?? [];
    if (!arr.includes(bpmf)) arr.push(bpmf);
    phoneticMap.set(cns, arr);
  }

  // ── 4. Load radical ───────────────────────────────────────────────────────
  console.log("🌿 Loading CNS_radical…");
  const radicalContent = await readZipMember(PROPERTIES_ZIP, "CNS_radical.txt");
  /** @type {Map<string, number>} */
  const radicalMap = new Map();
  for (const row of parseTsv(radicalContent)) {
    if (row.length < 2) continue;
    const [cns, rid] = row;
    if (!cns || !rid) continue;
    radicalMap.set(cns, parseInt(rid, 10));
  }

  // ── 5. Load radical_word (id → char) ─────────────────────────────────────
  console.log("📖 Loading CNS_radical_word…");
  const radicalWordContent = await readZipMember(PROPERTIES_ZIP, "CNS_radical_word.txt");
  /** @type {Map<number, string>} */
  const radicalWordMap = new Map();
  for (const row of parseTsv(radicalWordContent)) {
    if (row.length < 2) continue;
    const [id, char] = row;
    if (!id || !char) continue;
    radicalWordMap.set(parseInt(id, 10), char);
  }

  // ── 6. Load cangjie (multi-row) ──────────────────────────────────────────
  console.log("🔡 Loading CNS_cangjie…");
  const cangjieContent = await readZipMember(PROPERTIES_ZIP, "CNS_cangjie.txt");
  /** @type {Map<string, string[]>} */
  const cangjieMap = new Map();
  for (const row of parseTsv(cangjieContent)) {
    if (row.length < 2) continue;
    const [cns, cj] = row;
    if (!cns || !cj) continue;
    const arr = cangjieMap.get(cns) ?? [];
    if (!arr.includes(cj)) arr.push(cj);
    cangjieMap.set(cns, arr);
  }

  // ── 7. Load strokes_sequence (singleton) ──────────────────────────────────
  console.log("✏️  Loading CNS_strokes_sequence…");
  const strokeSeqContent = await readZipMember(PROPERTIES_ZIP, "CNS_strokes_sequence.txt");
  /** @type {Map<string, string>} */
  const strokeSeqMap = new Map();
  for (const row of parseTsv(strokeSeqContent)) {
    if (row.length < 2) continue;
    const [cns, seq] = row;
    if (!cns || !seq) continue;
    strokeSeqMap.set(cns, seq);
  }

  // ── 8. Load source ────────────────────────────────────────────────────────
  console.log("📜 Loading CNS_source…");
  const sourceContent = await readZipMember(PROPERTIES_ZIP, "CNS_source.txt");
  /** @type {Map<string, string>} */
  const sourceMap = new Map();
  for (const row of parseTsv(sourceContent)) {
    if (row.length < 2) continue;
    const [cns, src] = row;
    if (!cns || !src) continue;
    sourceMap.set(cns, src);
  }

  // ── 9. Emit per-character JSON ────────────────────────────────────────────
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
    const char = String.fromCodePoint(cp);
    const hex = hexOf(cp);
    const shard = shardOf(cp);

    // Parse CNS plane/cell
    const cnsParts = cns.split("-");
    const plane = parseInt(cnsParts[0], 10);
    const cell = cnsParts[1] ?? "";

    // Build record
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
      const outDir = path.join(OUT_DIR, shard);
      await mkdir(outDir, { recursive: true });
      await writeFile(path.join(outDir, `${hex}.json`), JSON.stringify(record, null, 2), "utf-8");
    }

    emitted++;
    if (emitted % 5000 === 0) {
      process.stdout.write(`   ${emitted} written…\r`);
    }
  }

  console.log(`\n✅ Done.`);
  console.log(`   Emitted:         ${emitted}`);
  console.log(`   Skipped PUA:     ${skippedPUA}`);
  console.log(`   Skipped no-map:  ${skippedNoMapping}`);
  if (emitted + skippedPUA + skippedNoMapping < strokeMap.size) {
    console.log(`   Skipped (limit): ${strokeMap.size - emitted - skippedPUA - skippedNoMapping}`);
  }
}

main().catch((err) => {
  console.error("❌ Generator failed:", err);
  process.exit(1);
});
