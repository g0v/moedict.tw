#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dict = process.env.DICTIONARY_ROOT
  ? path.resolve(process.env.DICTIONARY_ROOT)
  : path.join(root, "data", "dictionary");
const manifestPath = process.env.DICTIONARY_INVENTORY_MANIFEST
  ? path.resolve(process.env.DICTIONARY_INVENTORY_MANIFEST)
  : path.join(root, "data", "sources", "dictionary-path-inventory.json");
const update = process.argv.includes("--update");
const relFiles = (dir) => {
  const out = [];
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) walk(q);
      else out.push(path.relative(dict, q).replace(/^/, "data/dictionary/"));
    }
  };
  walk(dir);
  return out.sort((a, b) => a.localeCompare(b));
};
const expected = [];
for (const [dir, max] of [
  ["pack", 1023],
  ["pcck", 127],
  ["phck", 127],
  ["ptck", 127],
])
  for (const i of Array.from({ length: max + 1 }, (_, index) => index))
    expected.push(`data/dictionary/${dir}/${i}.txt`);
for (const lang of ["a", "c", "h", "t"])
  for (const name of ["index.json", "xref.json", "xref-by-id.json"])
    expected.push(`data/dictionary/${lang}/${name}`);
for (const lang of ["a", "c", "h", "t"]) {
  const d = path.join(dict, lang);
  if (fs.existsSync(d))
    for (const p of relFiles(d))
      if (/\/[@=].*\.json$|\/(?:@|=)[^/]*\.json$/.test(p)) expected.push(p);
}
for (const lang of ["a", "c", "h", "t"]) expected.push(`data/dictionary/search-index/${lang}.json`);
expected.push("data/dictionary/translation-data/cfdict.txt");
const lookup = path.join(dict, "lookup", "pinyin");
if (fs.existsSync(lookup)) for (const p of relFiles(lookup)) expected.push(p);
const actual = relFiles(dict).filter((p) => !p.startsWith("data/dictionary/cns/"));
const norm = (a) => [...new Set(a)].sort((x, y) => x.localeCompare(y));
const failures = [];
const inventory = {
  version: 1,
  generatedBy: "vp run dictionary:inventory:update",
  paths: norm(actual),
  counts: { scopes: {} },
};
const missingRequired = norm(expected).filter((p) => !actual.includes(p));
if (missingRequired.length)
  failures.push(`required paths missing: ${missingRequired.slice(0, 20).join(", ")}`);
for (const scope of [
  "pack",
  "pcck",
  "phck",
  "ptck",
  "a",
  "c",
  "h",
  "t",
  "search-index",
  "translation-data",
  "lookup/pinyin",
])
  inventory.counts.scopes[scope] = actual.filter((p) =>
    p.startsWith(`data/dictionary/${scope}/`),
  ).length;
if (update) {
  await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
  await fsp.writeFile(manifestPath, JSON.stringify(inventory, null, 2) + "\n");
  console.log(`wrote ${manifestPath} (${inventory.paths.length} paths)`);
  process.exit(0);
}
if (!fs.existsSync(manifestPath))
  failures.push(
    "missing generated path inventory manifest (run vp run dictionary:inventory:update)",
  );
else {
  const pinned = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const missing = norm(pinned.paths).filter((p) => !inventory.paths.includes(p));
  const extra = inventory.paths.filter((p) => !norm(pinned.paths).includes(p));
  if (missing.length || extra.length)
    failures.push(
      `inventory drift: missing=${missing.slice(0, 10).join(",")} extra=${extra.slice(0, 10).join(",")}`,
    );
}
for (const lang of ["a", "c", "h", "t"]) {
  for (const n of ["index.json", "xref.json", "xref-by-id.json"]) {
    const p = path.join(dict, lang, n);
    if (fs.existsSync(p)) {
      try {
        const j = JSON.parse(fs.readFileSync(p));
        if (!j || typeof j !== "object" || (n !== "index.json" && Array.isArray(j)))
          failures.push(`${lang}/${n}: invalid JSON shape`);
      } catch {
        failures.push(`${lang}/${n}: invalid JSON`);
      }
    }
  }
}
for (const [dir, max] of [
  ["pack", 1023],
  ["pcck", 127],
  ["phck", 127],
  ["ptck", 127],
]) {
  const found = actual
    .filter((p) => p.startsWith(`data/dictionary/${dir}/`) && /\/\d+\.txt$/.test(p))
    .map((p) => Number(path.basename(p, ".txt")))
    .sort((a, b) => a - b);
  const want = Array.from({ length: max + 1 }, (_, i) => i);
  if (found.length !== want.length || found.some((x, i) => x !== want[i]))
    failures.push(`${dir}: numeric shard set is not exactly 0..${max}`);
}
const cfdict = path.join(dict, "translation-data", "cfdict.txt");
if (!fs.existsSync(cfdict)) failures.push("translation-data/cfdict.txt missing");
if (failures.length) {
  for (const f of failures) console.error(`[inventory] FAIL ${f}`);
  process.exit(1);
}
console.log(
  `[inventory] OK ${inventory.paths.length} tracked paths; scopes ${JSON.stringify(inventory.counts.scopes)}`,
);
