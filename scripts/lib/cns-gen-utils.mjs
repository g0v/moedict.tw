/**
 * Pure utility exports for scripts/generate-cns-data.mjs.
 *
 * Split into a separate lib file so unit tests can import them without
 * pulling in the CLI entrypoint's shebang line (which confuses Vite's
 * SSR transform when it prepends the /@vite/client injection).
 *
 * All functions here are deterministic and have no side effects.
 */

import os from "node:os";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..");

// ── Expected counts for full corpus (Phase 1, standard Unicode only) ─────────
//
// Derived from CNS11643 2024 release (Properties.zip + MapingTables.zip,
// downloaded 2026-07-13 from https://www.cns11643.gov.tw/pageView.jsp?ID=59).
// After generation, verified by:
//   find data/dictionary/cns/by-codepoint -name '*.json' | wc -l
//
// EXPECTED_EMITTED       — strokeMap entries passing PUA+nomap filters.
// EXPECTED_SKIPPED_PUA   — strokeMap entries whose Unicode mapping is PUA.
// EXPECTED_SKIPPED_NOMAP — strokeMap entries with no Unicode mapping; 0 means
//                          every CNS stroke entry has a Unicode mapping.
// EXPECTED_UNIQUE_FILES  — actual on-disk file count after generation. Equals
//                          EXPECTED_EMITTED because the duplicate-key detector
//                          throws before any silent collision can occur.
export const EXPECTED_EMITTED = 77208;
export const EXPECTED_SKIPPED_PUA = 20152;
export const EXPECTED_SKIPPED_NOMAP = 0;
export const EXPECTED_UNIQUE_FILES = 77208;

// Relative path of the tracked golden fixture within the by-codepoint dir.
export const GOLDEN_RELATIVE = path.join("4D", "4D09.json");

// ── Safety: reject dangerous OUT_DIR values ───────────────────────────────────

/**
 * Reject OUT_DIR values that could cause accidental mass deletion.
 * Protected: filesystem root, OS home, OS tmpdir, repo root,
 * and anything fewer than 2 path components below the repo root.
 * @param {string} dir — absolute resolved path
 */
export function assertSafeOutDir(dir) {
  const dangerous = ["/", os.homedir(), os.tmpdir(), REPO_ROOT];
  for (const d of dangerous) {
    if (dir === d) {
      throw new Error(
        `Unsafe OUT_DIR rejected: "${dir}" matches protected path "${d}". ` +
          `Supply a specific subdirectory, e.g. data/dictionary/cns/by-codepoint`,
      );
    }
  }
  const rel = path.relative(REPO_ROOT, dir);
  // Only apply the depth gate to paths INSIDE the repo root.
  // Paths outside the repo (rel starts with "..") are allowed as long as they
  // are not in the exact protected list above.
  if (!rel.startsWith("..") && rel.split(path.sep).length < 2) {
    throw new Error(
      `Unsafe OUT_DIR rejected: "${dir}" is too shallow (< 2 components below repo root). ` +
        `Minimum: data/dictionary/cns/by-codepoint`,
    );
  }
}

// ── PUA classifier (numeric range, never file-based) ───────────────────────

export function isPUA(cp) {
  return (
    (cp >= 0xe000 && cp <= 0xf8ff) || // BMP PUA
    (cp >= 0xf0000 && cp <= 0xfffff) || // PUA-A (Unicode 15 rows are all here)
    (cp >= 0x100000 && cp <= 0x10ffff) // PUA-B
  );
}

export function isValidScalar(cp) {
  return cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
}

// ── Shard / hex formula ─────────────────────────────────────────────────────

export function shardOf(cp) {
  const hex = cp.toString(16).toUpperCase();
  return hex.length <= 4 ? hex.slice(0, 2) : hex.slice(0, 3);
}

export function hexOf(cp) {
  return cp.toString(16).toUpperCase();
}

/**
 * Expected R2 key for a codepoint — must match handleCnsAPI shard formula.
 * @param {number} cp
 * @returns {string}
 */
export function expectedKey(cp) {
  return `cns/by-codepoint/${shardOf(cp)}/${hexOf(cp)}.json`;
}

// ── File counter ────────────────────────────────────────────────────────────

export async function countJsonFiles(dir) {
  let count = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      count += await countJsonFiles(path.join(dir, e.name));
    } else if (e.name.endsWith(".json")) {
      count++;
    }
  }
  return count;
}

// ── Golden record semantic validator ────────────────────────────────────────

/**
 * Validates the generated U+4D09 (䴉, CNS 4-6C51) record by deep-comparing
 * its parsed content against the tracked golden fixture bytes.
 *
 * Semantic check (parsed JSON equality) is intentional: the generator uses
 * JSON.stringify(record, null, 2) which may differ in whitespace from the
 * hand-formatted committed file. After the swap the caller restores the
 * tracked golden bytes so git status stays clean.
 *
 * @param {string} generatedDir — directory being validated (temp dir)
 * @param {string} trackedGoldenBytes — raw bytes of the committed golden file
 */
export async function validateGoldenRecord(generatedDir, trackedGoldenBytes) {
  const genPath = path.join(generatedDir, GOLDEN_RELATIVE);
  let genRaw;
  try {
    genRaw = await readFile(genPath, "utf-8");
  } catch {
    throw new Error(`Golden record missing from generated corpus: ${genPath}`);
  }

  const generated = JSON.parse(genRaw);
  const tracked = JSON.parse(trackedGoldenBytes);

  const genStr = JSON.stringify(generated);
  const trkStr = JSON.stringify(tracked);
  if (genStr !== trkStr) {
    throw new Error(
      `Golden U+4D09 semantic mismatch.\n` + `Generated: ${genStr}\n` + `Tracked:   ${trkStr}`,
    );
  }
}
