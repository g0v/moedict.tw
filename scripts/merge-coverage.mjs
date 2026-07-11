#!/usr/bin/env node
/**
 * Merges coverage from the three test tiers into one Istanbul report:
 *
 *   - Unit (vitest v8):      coverage/unit/coverage-final.json
 *   - Integration (vitest):  coverage/integration/coverage-final.json (optional)
 *   - E2E (playwright V8):   coverage/playwright/*.json  (raw entries,
 *                            mapped back to src via Vite sourcemaps)
 *
 * Emits:
 *   - coverage/combined/coverage-final.json   (istanbul JSON)
 *   - coverage/combined/lcov.info              (for codecov etc.)
 *   - coverage/combined/text summary           (printed to stdout)
 *
 * Run with `vp run test:coverage`. Each tier can be absent — the script
 * reports what it found, merges what's there, and exits 0 either way.
 */

import { createRequire } from "node:module";
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";

const require = createRequire(import.meta.url);
// v8-to-istanbul ships CJS — require it here to avoid the named-export
// churn of the ESM interop.
const v8ToIstanbul = require("v8-to-istanbul");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const COVERAGE_DIR = path.join(REPO_ROOT, "coverage");
const PLAYWRIGHT_DIR = path.join(COVERAGE_DIR, "playwright");
const UNIT_FILE = path.join(COVERAGE_DIR, "unit", "coverage-final.json");
const INTEGRATION_FILE = path.join(COVERAGE_DIR, "integration", "coverage-final.json");
const OUT_DIR = path.join(COVERAGE_DIR, "combined");
const DIST_CLIENT = path.join(REPO_ROOT, "dist", "client");

const coverageMap = libCoverage.createCoverageMap({});
let contributingTiers = 0;

function ingestIstanbulFile(label, file) {
  if (!existsSync(file)) {
    console.log(`[merge-coverage] ${label}: skipped (no ${path.relative(REPO_ROOT, file)})`);
    return 0;
  }
  const raw = JSON.parse(readFileSync(file, "utf-8"));
  coverageMap.merge(raw);
  const files = Object.keys(raw).length;
  console.log(`[merge-coverage] ${label}: merged ${files} file(s)`);
  contributingTiers += 1;
  return files;
}

async function ingestPlaywrightDir(dir) {
  if (!existsSync(dir)) {
    console.log("[merge-coverage] playwright: skipped (no coverage/playwright/)");
    return 0;
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.log("[merge-coverage] playwright: skipped (empty coverage/playwright/)");
    return 0;
  }

  let converted = 0;
  for (const file of files) {
    const entries = JSON.parse(readFileSync(path.join(dir, file), "utf-8"));
    for (const entry of entries) {
      if (!entry || !entry.url || !Array.isArray(entry.functions)) continue;
      const pathname = new URL(entry.url).pathname;
      const onDisk = path.join(DIST_CLIENT, pathname);
      if (!existsSync(onDisk)) continue;

      // v8-to-istanbul reads the `//# sourceMappingURL=` comment in the
      // bundled JS and fetches the adjacent .map to attribute ranges to
      // src/**/*.ts. Requires Vite to have built with sourcemap:true.
      const converter = v8ToIstanbul(onDisk, 0, undefined, (filePath) => {
        // Reject entries that don't point to our source tree — Vite's
        // sourcemap sometimes leaks node_modules references which would
        // skew the "% coverage" report.
        const rel = path.relative(REPO_ROOT, filePath);
        return rel.startsWith("..") || rel.startsWith("node_modules");
      });
      try {
        await converter.load();
        converter.applyCoverage(entry.functions);
        const istanbul = converter.toIstanbul();
        coverageMap.merge(istanbul);
        converted += 1;
      } catch (err) {
        console.warn(`[merge-coverage] playwright: failed to convert ${pathname}: ${err.message}`);
      } finally {
        converter.destroy();
      }
    }
  }

  console.log(
    `[merge-coverage] playwright: merged ${converted} script(s) from ${files.length} test file(s)`,
  );
  if (converted > 0) contributingTiers += 1;
  return converted;
}

async function main() {
  ingestIstanbulFile("unit", UNIT_FILE);
  ingestIstanbulFile("integration", INTEGRATION_FILE);
  await ingestPlaywrightDir(PLAYWRIGHT_DIR);

  if (contributingTiers === 0) {
    console.error(
      "[merge-coverage] nothing to merge — run at least one of vp run test:unit / test:integration / test:e2e with coverage enabled first.",
    );
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, "coverage-final.json"), JSON.stringify(coverageMap.toJSON()));

  const context = libReport.createContext({
    dir: OUT_DIR,
    coverageMap,
    defaultSummarizer: "pkg",
  });
  reports.create("lcovonly", { file: "lcov.info" }).execute(context);
  reports.create("text-summary").execute(context);
  reports.create("text", { maxCols: 120, skipEmpty: true, skipFull: false }).execute(context);

  console.log(
    `[merge-coverage] wrote ${path.relative(REPO_ROOT, OUT_DIR)}/coverage-final.json + lcov.info`,
  );
}

main().catch((err) => {
  console.error("[merge-coverage] failed:", err);
  process.exit(1);
});
