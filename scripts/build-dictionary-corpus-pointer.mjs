#!/usr/bin/env node
/**
 * Build a deterministic dictionary inventory digest + pointer for R2.
 *
 * Enumerates the exact paths that `commands/upload_dictionary.sh` uploads
 * (pack/pcck/phck/ptck, a/t/h/c, search-index, translation-data, lookup/pinyin),
 * hashes each file's raw bytes, sorts by path, and computes:
 *   dictionaryDigest = sha256(canonical JSON of {path,sha256,bytes}[])
 *
 * Writes:
 *   - dictionary-corpus-manifest.json  (inventory only — not a versioned corpus)
 *   - dictionary-corpus-current.json   (pointer written LAST after flat uploads)
 *
 * This supports upload-driven cache busting only. Flat object keys remain the
 * read path; the versioned prefix stores the manifest, not object bytes.
 *
 * Usage:
 *   node scripts/build-dictionary-corpus-pointer.mjs [--out-dir=/tmp/...]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DICT_DIR = join(REPO_ROOT, "data", "dictionary");

const PACK_FOLDERS = ["pack", "pcck", "phck", "ptck"];
const LANG_FOLDERS = ["a", "c", "h", "t"];

function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] ?? "";
  }
  return out;
}

function walkFiles(rootDir) {
  /** @type {string[]} */
  const files = [];
  function walk(dir) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith(".")) continue;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile()) files.push(abs);
    }
  }
  if (existsSync(rootDir)) walk(rootDir);
  return files;
}

function sha256File(absPath) {
  const buf = readFileSync(absPath);
  return {
    sha256: createHash("sha256").update(buf).digest("hex"),
    bytes: buf.length,
  };
}

function collectUploadPaths() {
  /** @type {string[]} */
  const roots = [];
  for (const f of PACK_FOLDERS) roots.push(join(DICT_DIR, f));
  for (const f of LANG_FOLDERS) roots.push(join(DICT_DIR, f));
  roots.push(join(DICT_DIR, "search-index"));
  roots.push(join(DICT_DIR, "translation-data"));
  roots.push(join(DICT_DIR, "lookup", "pinyin"));

  /** @type {Array<{ path: string; sha256: string; bytes: number }>} */
  const entries = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const abs of walkFiles(root)) {
      // Skip CNS by-codepoint bulk (optional / separate upload scope)
      const relFromDict = relative(DICT_DIR, abs).split(sep).join("/");
      if (relFromDict.startsWith("cns/")) continue;
      const { sha256, bytes } = sha256File(abs);
      entries.push({ path: relFromDict, sha256, bytes });
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args["out-dir"]
    ? isAbsolute(args["out-dir"])
      ? args["out-dir"]
      : join(REPO_ROOT, args["out-dir"])
    : join(REPO_ROOT, ".tmp-dictionary-corpus");
  mkdirSync(outDir, { recursive: true });

  const files = collectUploadPaths();
  if (files.length === 0) {
    console.error("[build-dictionary-corpus-pointer] no files found under data/dictionary upload roots");
    process.exit(1);
  }

  const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
  const canonical = JSON.stringify(files);
  const dictionaryDigest = createHash("sha256").update(canonical).digest("hex");

  const manifest = {
    schema: 1,
    dictionaryDigest,
    fileCount: files.length,
    totalBytes,
    files,
  };
  const pointer = {
    schema: 1,
    dictionaryDigest,
    manifestKey: `dictionary-corpora/${dictionaryDigest}/manifest.json`,
    fileCount: files.length,
    totalBytes,
  };

  const manifestPath = join(outDir, "dictionary-corpus-manifest.json");
  const pointerPath = join(outDir, "dictionary-corpus-current.json");
  writeFileSync(manifestPath, JSON.stringify(manifest) + "\n");
  writeFileSync(pointerPath, JSON.stringify(pointer) + "\n");

  console.log(`[build-dictionary-corpus-pointer] files=${files.length} totalBytes=${totalBytes}`);
  console.log(`[build-dictionary-corpus-pointer] dictionaryDigest=${dictionaryDigest}`);
  console.log(`[build-dictionary-corpus-pointer] wrote ${manifestPath}`);
  console.log(`[build-dictionary-corpus-pointer] wrote ${pointerPath}`);
}

main();
