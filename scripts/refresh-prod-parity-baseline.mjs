#!/usr/bin/env node
/**
 * scripts/refresh-prod-parity-baseline.mjs
 *
 * Refreshes tests/e2e/prod-parity-allowlist.json's `recorded_value`/
 * `recorded_ratio` fields against LIVE production (https://www.moedict.tw
 * by default). Uses scripts/lib/prod-parity-measure.mjs's measureEntry()
 * — the SAME measurement code path tests/e2e/prod-parity.spec.ts uses to
 * measure staging — so the baseline this script writes and the value the
 * spec later compares against are captured by IDENTICAL selector-eval /
 * aggregate / readiness-wait logic. See that module's doc comment and the
 * allowlist JSON's top-level `provisional`/`provisional_note` fields for
 * the full rationale.
 *
 * Does NOT add or remove entries — entry lifecycle (add when a surface is
 * newly confirmed byte-identical, remove when a PR intentionally changes
 * it) is a manual, reviewed JSON edit as part of that PR, documented in
 * AGENTS.md's UI 慣例與結構性防護 section. This script only refreshes
 * VALUES for entries that already exist in the file.
 *
 * NOTE (sandbox limitation, see AGENTS.md): this repo's default dev
 * sandbox cannot launch Playwright's bundled Chromium (icudtl.dat EPERM).
 * This script follows the SAME `chromium` import used by
 * scripts/audit-dark-contrast.mjs and is written to run correctly on any
 * machine where Playwright's browser CAN launch (a real operator machine
 * or CI) — it is not runnable inside that specific restricted sandbox.
 *
 * Run: `vp run refresh:prod-parity` (or `PROD_PARITY_BASE_URL=... node
 * scripts/refresh-prod-parity-baseline.mjs` to point at a mirror, e.g.
 * during a moedict.org migration).
 *
 * IMPORTANT — font-environment parity (see the allowlist's
 * provisional_note and tests/e2e/visual-invariants.spec.ts R6): for the
 * refreshed values to be trustworthy as a hard CI gate (provisional:false),
 * this script MUST be run in an environment with font availability
 * matching the e2e CI job's own runner (ubuntu-latest, or a container
 * pinned to match it) — running it ad-hoc on a machine with real CJK
 * fonts installed (e.g. a maintainer's macOS laptop) can silently bake in
 * numbers that only hold under that machine's own font substitution
 * chain, not CI's. See AGENTS.md for the recommended refresh-workflow
 * wiring.
 */

import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { measureEntry, VIEWPORTS } from "./lib/prod-parity-measure.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const ALLOWLIST_PATH = path.join(REPO_ROOT, "tests", "e2e", "prod-parity-allowlist.json");

const BASE_URL = process.env.PROD_PARITY_BASE_URL || "https://www.moedict.tw";

function viewportFor(entry) {
  if (entry.viewport?.width && entry.viewport?.height) return entry.viewport;
  return VIEWPORTS.desktop;
}

function extractValue(entry, measured) {
  if ((entry.aggregate ?? "first") === "count") return { count: measured.count };
  if (entry.measurement === "ratio") return measured.ratio;
  const prop = entry.properties[0];
  return measured.values ? { [prop]: measured.values[prop] } : null;
}
function deltaOf(entry, oldValue, newValue) {
  if (oldValue == null || newValue == null) return null;
  if (entry.measurement === "ratio") return Math.abs(newValue - oldValue);
  const prop = entry.properties[0];
  if ((entry.aggregate ?? "first") === "count") {
    return Math.abs((newValue.count ?? 0) - (oldValue.count ?? 0));
  }
  return Math.abs(newValue[prop] - oldValue[prop]);
}

async function main() {
  const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf-8"));
  const browser = await chromium.launch();

  const refreshed = [];
  const errored = [];
  const moved = [];

  for (const entry of raw.entries) {
    const viewport = viewportFor(entry);
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    try {
      const measured = await measureEntry(page, BASE_URL, entry);
      const newValue = extractValue(entry, measured);
      if (newValue == null) {
        errored.push({ id: entry.id, error: `selector matched 0 elements: ${entry.selector}` });
        continue;
      }
      const oldValue = entry.measurement === "ratio" ? entry.recorded_ratio : entry.recorded_value;
      const delta = deltaOf(entry, oldValue, newValue);
      const tolerance =
        entry.measurement === "ratio"
          ? (entry.tolerance_pct ?? 5) / 100
          : (entry.tolerance_px ?? 2);
      if (delta != null && delta > tolerance) {
        moved.push({ id: entry.id, oldValue, newValue, delta });
      }
      if (entry.measurement === "ratio") {
        entry.recorded_ratio = newValue;
      } else {
        entry.recorded_value = newValue;
      }
      refreshed.push(entry.id);
    } catch (err) {
      errored.push({ id: entry.id, error: err instanceof Error ? err.message : String(err) });
    } finally {
      await context.close();
    }
  }

  await browser.close();

  raw.generated_at = new Date().toISOString();
  raw.generated_from = `${BASE_URL} (refresh run — see console output for x-moedict-release if captured separately)`;

  writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");

  console.log(`\n=== prod-parity baseline refresh ===`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Entries refreshed: ${refreshed.length}/${raw.entries.length}`);

  if (moved.length > 0) {
    console.log(`\n⚠️  prod itself moved (beyond tolerance) — review before committing:`);
    for (const m of moved) {
      console.log(
        `  [${m.id}] old=${JSON.stringify(m.oldValue)} new=${JSON.stringify(m.newValue)} delta=${m.delta}`,
      );
    }
  }

  if (errored.length > 0) {
    console.error(`\n❌ Entries that errored (selector not found — needs a maintainer decision):`);
    for (const e of errored) {
      console.error(`  [${e.id}] ${e.error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nDone. Review \`git diff ${path.relative(REPO_ROOT, ALLOWLIST_PATH)}\` and commit as part of a normal PR.\n`,
  );
}

main().catch((err) => {
  console.error("Fatal error in refresh-prod-parity-baseline.mjs:", err);
  process.exitCode = 2;
});
