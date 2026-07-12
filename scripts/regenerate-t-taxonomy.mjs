#!/usr/bin/env node
/**
 * Build t/@*.json radical tables (臺灣台語萌典部首表) and the t/@.json
 * table-of-contents from ptck/*.txt (the Taiwanese Hokkien pack source,
 * same envelope as pack/*.txt for "a") + t/index.json.
 *
 * g0v/moedict-webkit#122: 台語及客語萌典增加部首檢索. ptck/*.txt carries an
 * authoritative "r" (radical) + "n" (non_radical_stroke_count) field per
 * single-character entry (128/129 files, same schema pack/*.txt uses for
 * "a") — so unlike Hakka (phck/*.txt has ZERO "r" occurrences, a genuine
 * upstream data gap), Taiwanese radical data already exists and only
 * needed a build step + frontend route. See regenerate-a-taxonomy.mjs,
 * whose shape/algorithm this mirrors 1:1 for the "t" bucket.
 *
 * Radical array shape (matches a/@*.json and legacy webkit files):
 *   [0] = [radical, ...titles with residual stroke 0]
 *   [n] = titles with non_radical_stroke_count n  (n >= 1)
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packDir = join(root, "data/dictionary/ptck");
const tDir = join(root, "data/dictionary/t");
const aTocPath = join(root, "data/dictionary/a/@.json");

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
  const index = JSON.parse(readFileSync(join(tDir, "index.json"), "utf8"));
  const indexSet = new Set(index);

  const all = [];
  for (const f of readdirSync(packDir)) {
    if (!f.endsWith(".txt")) continue;
    all.push(...parsePack(readFileSync(join(packDir, f), "utf8")));
  }
  const inIndex = all.filter((e) => indexSet.has(e.t));
  console.log(`ptck entries parsed=${all.length} inIndex=${inIndex.length}`);

  /** @type {Map<string, Map<number, string[]>>} */
  const byRadical = new Map();
  let withRadical = 0;
  let without = 0;
  for (const e of inIndex) {
    if (!e.r || e.n === undefined) {
      without++;
      continue;
    }
    withRadical++;
    let map = byRadical.get(e.r);
    if (!map) {
      map = new Map();
      byRadical.set(e.r, map);
    }
    const stroke = e.n;
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

  // Canonical 214 Kangxi radicals, grouped by the radical's own stroke
  // count — same universal set "a" and "c" already use (radical
  // assignment is a property of the Han character, not the topolect).
  const aToc = JSON.parse(readFileSync(aTocPath, "utf8"));

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
  const populatedByStroke = [];
  for (const row of aToc) {
    if (!Array.isArray(row)) {
      populatedByStroke.push([]);
      continue;
    }
    const populatedRow = [];
    for (const radical of row) {
      const map = byRadical.get(radical);
      if (!map) continue;
      writeFileSync(
        join(tDir, `@${radical}.json`),
        JSON.stringify(buildRadicalArray(radical, map)),
      );
      written++;
      populatedRow.push(radical);
    }
    populatedByStroke.push(populatedRow);
  }
  writeFileSync(join(tDir, "@.json"), JSON.stringify(populatedByStroke));
  console.log(
    `wrote ${written} radical files + t/@.json TOC (${byRadical.size} radicals populated out of 214 Kangxi radicals)`,
  );
}

main();
