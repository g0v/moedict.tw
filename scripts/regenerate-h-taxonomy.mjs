#!/usr/bin/env node
/**
 * Build h/@*.json radical tables (臺灣客語萌典部首表) and h/@.json from the
 * shipped Hakka headword list plus independently licensed CNS11643 attributes.
 * Hakka dictionary entries are never read or rewritten.
 *
 * Sources:
 *   - Headwords: data/dictionary/h/index.json (MOE 臺灣客語辭典, CC BY-ND 3.0 TW)
 *   - Radical + total strokes: CNS11643 per-codepoint corpus (MODA, OGDL-1.0)
 *
 * The existing a/t radical files group by MOE's editorial
 * non_radical_stroke_count (`n`). Hakka publishes no `r`/`n` fields, while CNS
 * states a radical and TOTAL strokes only. Therefore Hakka rows deliberately use
 * exact CNS total strokes:
 *
 *   [totalStrokeCount] = single-character Hakka titles
 *
 * Row 0 is null. The Hakka UI labels every populated row `總筆畫 N`; it must not
 * present total-minus-canonical-radical arithmetic as residual strokes. Unicode
 * kRSUnicode was evaluated but is not a drop-in substitute: it is a new data and
 * licence dependency, disagrees with CNS's radical for six shipped Hakka
 * characters, and gives conflicting residual values for seven more. Mandarin's
 * and Taiwanese's `n` values come from their MOE source columns, not Unihan.
 *
 * Usage:
 *   node scripts/regenerate-h-taxonomy.mjs --cns-root=/path/to/by-codepoint
 *
 * Optional:
 *   --index=/path/to/index.json --toc=/path/to/a/@.json --out=/path/to/h
 *   --allow-incomplete=true (fixture/debug runs only; production has a fail-safe)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.+)$/);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    args[match[1]] = match[2];
  }
  return args;
}

function cnsRecordPath(cnsRoot, char) {
  const hex = char.codePointAt(0).toString(16).toUpperCase();
  const shard = hex.length <= 4 ? hex.slice(0, 2) : hex.slice(0, 3);
  return path.join(cnsRoot, shard, `${hex}.json`);
}

function isSingleHanTitle(title) {
  return Array.from(title).length === 1 && /^\p{Script=Han}$/u.test(title);
}

function readCnsFact(cnsRoot, title) {
  const recordPath = cnsRecordPath(cnsRoot, title);
  if (!existsSync(recordPath)) return { error: "missing CNS record" };

  try {
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    const radicalId = record?.attributes?.radical?.id;
    const totalStrokes = record?.attributes?.stroke;
    if (!Number.isInteger(radicalId) || radicalId < 1 || radicalId > 214) {
      return { error: "missing CNS radical" };
    }
    if (!Number.isInteger(totalStrokes) || totalStrokes < 1) {
      return { error: "missing CNS total strokes" };
    }
    return { radicalId, totalStrokes };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "invalid CNS record" };
  }
}

function canonicalRadicals(toc) {
  const radicals = toc.flatMap((row) => (Array.isArray(row) ? row : []));
  if (radicals.length !== 214 || radicals.some((radical) => typeof radical !== "string")) {
    throw new Error(`Expected the canonical 214-radical TOC, found ${radicals.length}`);
  }
  return radicals;
}

function buildTaxonomy({ index, toc, cnsRoot }) {
  const radicals = canonicalRadicals(toc);
  const singleTitles = index.filter(
    (title) => typeof title === "string" && isSingleHanTitle(title),
  );
  const byRadical = new Map();
  const skipped = [];

  for (const title of singleTitles) {
    const fact = readCnsFact(cnsRoot, title);
    if (fact.error) {
      skipped.push({ title, reason: fact.error });
      continue;
    }
    const radical = radicals[fact.radicalId - 1];
    let byStroke = byRadical.get(radical);
    if (!byStroke) {
      byStroke = new Map();
      byRadical.set(radical, byStroke);
    }
    let titles = byStroke.get(fact.totalStrokes);
    if (!titles) {
      titles = [];
      byStroke.set(fact.totalStrokes, titles);
    }
    if (!titles.includes(title)) titles.push(title);
  }

  for (const byStroke of byRadical.values()) {
    for (const titles of byStroke.values()) {
      titles.sort((a, b) => a.localeCompare(b, "zh-Hant"));
    }
  }

  const files = new Map();
  const populatedToc = toc.map((row) =>
    Array.isArray(row) ? row.filter((radical) => byRadical.has(radical)) : [],
  );
  files.set("@.json", JSON.stringify(populatedToc));

  for (const radical of radicals) {
    const byStroke = byRadical.get(radical);
    if (!byStroke) continue;
    const maxStroke = Math.max(...byStroke.keys());
    const rows = new Array(maxStroke + 1).fill(null);
    for (const [totalStrokes, titles] of byStroke) rows[totalStrokes] = titles;
    files.set(`@${radical}.json`, JSON.stringify(rows));
  }

  return {
    files,
    skipped,
    singleTitleCount: singleTitles.length,
    indexedTitleCount: singleTitles.length - skipped.length,
    radicalCount: byRadical.size,
  };
}

function writeTaxonomy(outDir, files) {
  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(outDir)) {
    if (/^@.*\.json$/u.test(name) && !files.has(name)) {
      rmSync(path.join(outDir, name));
    }
  }
  for (const [name, contents] of files) {
    writeFileSync(path.join(outDir, name), contents);
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const indexPath = path.resolve(
    args.index ?? path.join(REPO_ROOT, "data/dictionary/h/index.json"),
  );
  const tocPath = path.resolve(args.toc ?? path.join(REPO_ROOT, "data/dictionary/a/@.json"));
  const outDir = path.resolve(args.out ?? path.join(REPO_ROOT, "data/dictionary/h"));
  const cnsRoot = path.resolve(
    args["cns-root"] ??
      process.env.CNS_ROOT ??
      path.join(REPO_ROOT, "data/dictionary/cns/by-codepoint"),
  );

  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const toc = JSON.parse(readFileSync(tocPath, "utf8"));
  if (!Array.isArray(index) || !Array.isArray(toc)) {
    throw new Error("Hakka index and radical TOC must both be JSON arrays");
  }

  const result = buildTaxonomy({ index, toc, cnsRoot });
  const maxProductionSkips = Math.max(1, Math.floor(result.singleTitleCount * 0.01));
  if (
    args["allow-incomplete"] !== "true" &&
    (result.indexedTitleCount === 0 || result.skipped.length > maxProductionSkips)
  ) {
    throw new Error(
      `Refusing to replace Hakka taxonomy: indexed=${result.indexedTitleCount}, skipped=${result.skipped.length}. ` +
        "Pass the complete CNS corpus or use --allow-incomplete=true for an intentional fixture run.",
    );
  }
  writeTaxonomy(outDir, result.files);

  console.log(
    `Hakka single-character titles=${result.singleTitleCount} indexed=${result.indexedTitleCount} skipped=${result.skipped.length}`,
  );
  console.log(
    `Wrote ${result.files.size} files (${result.radicalCount} populated radicals + h/@.json)`,
  );
  for (const item of result.skipped) console.warn(`Skipped ${item.title}: ${item.reason}`);
  return result;
}

export {
  buildTaxonomy,
  cnsRecordPath,
  isSingleHanTitle,
  main,
  parseArgs,
  readCnsFact,
  writeTaxonomy,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
