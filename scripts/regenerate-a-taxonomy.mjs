#!/usr/bin/env node
/**
 * Rebuild a/@*.json radical tables and a/=*.json category lists from
 * current pack/*.txt + a/index.json (+ moedict-data/dict-cat.json).
 *
 * Radical array shape matches legacy webkit files:
 *   [0] = [radical, ...titles with residual stroke 0]
 *   [1] = null (legacy placeholder)
 *   [n] = titles with non_radical_stroke_count n  (n >= 2)
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packDir = join(root, "data/dictionary/pack");
const aDir = join(root, "data/dictionary/a");
const dictCatCandidates = [
  join(root, "../moedict-data/dict-cat.json"),
  join(root, "moedict-data/dict-cat.json"),
  "/Users/au/w/moedict-data/dict-cat.json",
];

function unescapeMoedict(s) {
  let t = String(s ?? "").replace(/[`~]/g, "");
  try {
    t = JSON.parse(`"${t}"`);
  } catch {
    /* keep */
  }
  return t;
}

/** Parse one pack/*.txt file into {t,r,n} entries. */
function parsePack(text) {
  const entries = [];
  if (!text.startsWith("{")) return entries;
  const parts = text.split(/\n,"/);
  for (let i = 0; i < parts.length; i++) {
    let chunk = parts[i];
    const idx = chunk.indexOf(":{");
    if (idx < 0) continue;
    chunk = chunk.slice(idx + 1);
    chunk = chunk.replace(/\n}\s*$/, "}");
    if (!chunk.endsWith("}")) {
      const last = chunk.lastIndexOf("}");
      if (last >= 0) chunk = chunk.slice(0, last + 1);
    }
    try {
      const obj = JSON.parse(chunk);
      const t = unescapeMoedict(obj.t);
      if (!t) continue;
      const r = obj.r != null ? unescapeMoedict(obj.r).replace(/\s+/g, "") : "";
      const n = typeof obj.n === "number" ? obj.n : undefined;
      entries.push({ t, r: r || undefined, n });
    } catch {
      /* skip */
    }
  }
  return entries;
}

function main() {
  const index = JSON.parse(readFileSync(join(aDir, "index.json"), "utf8"));
  const indexSet = new Set(index);

  const all = [];
  for (const f of readdirSync(packDir)) {
    if (!f.endsWith(".txt") || f === "=.txt" || f === "@.txt") continue;
    all.push(...parsePack(readFileSync(join(packDir, f), "utf8")));
  }
  const inIndex = all.filter((e) => indexSet.has(e.t));
  console.log(`pack entries parsed=${all.length} inIndex=${inIndex.length}`);

  /** @type {Map<string, Map<number, string[]>>} */
  const byRadical = new Map();
  let withRadical = 0;
  let without = 0;
  for (const e of inIndex) {
    if (!e.r) {
      without++;
      continue;
    }
    withRadical++;
    let map = byRadical.get(e.r);
    if (!map) {
      map = new Map();
      byRadical.set(e.r, map);
    }
    const stroke = e.n ?? 0;
    let list = map.get(stroke);
    if (!list) {
      list = [];
      map.set(stroke, list);
    }
    if (!list.includes(e.t)) list.push(e.t);
  }
  for (const map of byRadical.values()) {
    for (const [k, list] of map) {
      list.sort((a, b) => a.localeCompare(b, "zh-Hant"));
      map.set(k, list);
    }
  }
  console.log(`radicals=${byRadical.size} withRadical=${withRadical} without=${without}`);

  const oldToc = JSON.parse(readFileSync(join(aDir, "@.json"), "utf8"));
  const tocRadicals = [];
  for (const row of oldToc) {
    if (Array.isArray(row)) {
      for (const r of row) if (typeof r === "string") tocRadicals.push(r);
    }
  }

  function buildRadicalArray(radical, map) {
    const max = Math.max(0, ...map.keys());
    const arr = new Array(max + 1).fill(null);
    const zero = map.get(0) ?? [];
    arr[0] = [radical, ...zero];
    for (const [stroke, titles] of map) {
      if (stroke === 0) continue;
      arr[stroke] = titles;
    }
    return arr;
  }

  let written = 0;
  for (const radical of tocRadicals) {
    const map = byRadical.get(radical);
    if (!map) continue;
    writeFileSync(join(aDir, `@${radical}.json`), JSON.stringify(buildRadicalArray(radical, map)));
    written++;
  }
  console.log(`wrote ${written} radical files from TOC (${tocRadicals.length} TOC radicals)`);

  // Categories from dict-cat.json, filtered to live index
  const catPath = dictCatCandidates.find((p) => existsSync(p));
  if (!catPath) {
    console.warn("dict-cat.json not found; skipping =*.json regen");
    return;
  }
  const cats = JSON.parse(readFileSync(catPath, "utf8"));
  let catWritten = 0;
  for (const { name, entries } of cats) {
    const filtered = entries.filter((t) => indexSet.has(t));
    writeFileSync(join(aDir, `=${name}.json`), JSON.stringify(filtered));
    catWritten++;
    if (name === "成語") {
      console.log(
        `成語 ${entries.length} -> ${filtered.length} (removed ${entries.length - filtered.length})`,
      );
    }
  }
  console.log(`wrote ${catWritten} category files from ${catPath}`);

  // Spot-check 人 / 成語 missing counts
  const ren = JSON.parse(readFileSync(join(aDir, "@人.json"), "utf8"));
  const flat = [];
  for (const cell of ren) {
    if (Array.isArray(cell)) for (const x of cell) if (typeof x === "string") flat.push(x);
  }
  const missingRen = flat.filter((t) => t !== "人" && !indexSet.has(t));
  console.log(
    `@人 flat=${flat.length} missingFromIndex=${missingRen.length}`,
    missingRen.slice(0, 5),
  );
  const cheng = JSON.parse(readFileSync(join(aDir, "=成語.json"), "utf8"));
  const missingCheng = cheng.filter((t) => !indexSet.has(t));
  console.log(`=成語 ${cheng.length} missingFromIndex=${missingCheng.length}`);
}

main();
