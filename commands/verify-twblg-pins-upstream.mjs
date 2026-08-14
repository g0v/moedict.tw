#!/usr/bin/env node
/**
 * Network verifier for hand-curated Taiwanese dictionary pins (twblg-overrides/pinned-no-definition.json).
 *
 * Verifies that upstream MOE dictionary pages (sutian.moe.edu.tw) still hold the claimed assertions:
 *  1. Headword still present
 *  2. Every recorded reading still present (including slash-separated alternates)
 *  3. No-definition marker still holds (no "釋義" section has appeared)
 *  4. Search returns exactly one "完全符合" result
 *
 * Distinguishes three distinct outcomes:
 *  (a) claim still holds (ok)
 *  (b) upstream CONTENT drifted (data wrong; pin needs update/removal)
 *  (c) page STRUCTURE changed (verifier itself needs updating; NEVER report as ok)
 *
 * Usage:
 *   vp run twblg-pins:verify-upstream
 *   vp run twblg-pins:verify-upstream --update-verified
 *
 * EXPLICIT RULE: This network script is NEVER run in PR or push CI. It is for manual/scheduled invocation.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_PINNED_MANIFEST_PATH,
  REPO_ROOT,
  validatePinnedManifest,
  verifyEntryHtml,
  verifySearchHtml,
} from "../scripts/lib/twblg-pins.mjs";

const USER_AGENT = "moedict-twblg-pins-verifier/1.0 (+https://github.com/g0v/moedict.tw)";

export async function fetchUrl(url, fetchFn = globalThis.fetch) {
  try {
    const res = await fetchFn(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) {
      return { ok: false, status: res.status, text: "", error: `HTTP ${res.status}` };
    }
    const text = await res.text();
    return { ok: true, status: res.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: "", error: err.message || String(err) };
  }
}

export async function verifySinglePin(entry, fetchFn = globalThis.fetch) {
  const details = [];

  // Fetch entry URL
  const entryRes = await fetchUrl(entry.source_entry_url, fetchFn);
  if (!entryRes.ok) {
    return {
      title: entry.title,
      entryUrl: entry.source_entry_url,
      searchUrl: entry.source_search_url,
      status: "fetch_error",
      details: [`Failed to fetch source entry URL (${entry.source_entry_url}): ${entryRes.error}`],
    };
  }

  // Fetch search URL
  const searchRes = await fetchUrl(entry.source_search_url, fetchFn);
  if (!searchRes.ok) {
    return {
      title: entry.title,
      entryUrl: entry.source_entry_url,
      searchUrl: entry.source_search_url,
      status: "fetch_error",
      details: [
        `Failed to fetch source search URL (${entry.source_search_url}): ${searchRes.error}`,
      ],
    };
  }

  // Check entry HTML
  const entryCheck = verifyEntryHtml(entryRes.text, entry.title, entry.T);
  if (entryCheck.status === "structure_changed") {
    return {
      title: entry.title,
      entryUrl: entry.source_entry_url,
      searchUrl: entry.source_search_url,
      status: "structure_changed",
      details: entryCheck.mismatches,
    };
  }
  if (entryCheck.status === "content_drift") {
    details.push(...entryCheck.mismatches);
  }

  // Check search HTML
  const searchCheck = verifySearchHtml(searchRes.text, entry.title);
  if (searchCheck.status === "structure_changed") {
    return {
      title: entry.title,
      entryUrl: entry.source_entry_url,
      searchUrl: entry.source_search_url,
      status: "structure_changed",
      details: [...details, ...searchCheck.mismatches],
    };
  }
  if (searchCheck.status === "content_drift") {
    details.push(...searchCheck.mismatches);
  }

  if (details.length > 0) {
    return {
      title: entry.title,
      entryUrl: entry.source_entry_url,
      searchUrl: entry.source_search_url,
      status: "content_drift",
      details,
    };
  }

  return {
    title: entry.title,
    entryUrl: entry.source_entry_url,
    searchUrl: entry.source_search_url,
    status: "ok",
    details: [],
  };
}

async function main() {
  const args = process.argv.slice(2);
  const updateVerified = args.includes("--update-verified");
  const manifestPath = DEFAULT_PINNED_MANIFEST_PATH;

  console.log(`Loading manifest from ${path.relative(REPO_ROOT, manifestPath)}...`);
  let rawJson;
  try {
    rawJson = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    console.error(`ERROR: Failed to read/parse manifest: ${err.message}`);
    process.exit(1);
  }

  const { valid, errors, manifest } = validatePinnedManifest(rawJson);
  if (!valid || !manifest) {
    console.error(`ERROR: Manifest validation failed:`);
    errors.forEach((err) => console.error(`  - ${err}`));
    process.exit(1);
  }

  console.log(
    `Verifying ${manifest.entries.length} pinned entry/entries against upstream source...`,
  );

  const reports = [];
  let hasStructureChanged = false;
  let hasContentDrift = false;
  let hasFetchError = false;

  for (const entry of manifest.entries) {
    console.log(`\nVerifying pin: ${entry.title} (${entry.T})...`);
    const report = await verifySinglePin(entry);
    reports.push(report);

    if (report.status === "ok") {
      console.log(
        `  [OK] Claim holds. Headword, readings, no-definition, and 1 search result verified.`,
      );
    } else if (report.status === "structure_changed") {
      hasStructureChanged = true;
      console.error(`  [STRUCTURE CHANGED] Verifier logic could not evaluate page structure:`);
      report.details.forEach((d) => console.error(`    - ${d}`));
    } else if (report.status === "content_drift") {
      hasContentDrift = true;
      console.error(`  [CONTENT DRIFT] Upstream data changed:`);
      report.details.forEach((d) => console.error(`    - ${d}`));
    } else if (report.status === "fetch_error") {
      hasFetchError = true;
      console.error(`  [FETCH ERROR] Failed to retrieve page:`);
      report.details.forEach((d) => console.error(`    - ${d}`));
    }
  }

  console.log("\n==========================================");
  console.log("SUMMARY OF UPSTREAM PIN VERIFICATION");
  console.log("==========================================");
  console.log(`Total pins checked: ${reports.length}`);
  console.log(`  Passed (claims hold):       ${reports.filter((r) => r.status === "ok").length}`);
  console.log(
    `  Content drift (data wrong): ${reports.filter((r) => r.status === "content_drift").length}`,
  );
  console.log(
    `  Structure changed:          ${reports.filter((r) => r.status === "structure_changed").length}`,
  );
  console.log(
    `  Fetch errors:               ${reports.filter((r) => r.status === "fetch_error").length}`,
  );

  const allPassed = !hasStructureChanged && !hasContentDrift && !hasFetchError;

  if (updateVerified) {
    if (allPassed) {
      const todayIso = new Date().toISOString().slice(0, 10);
      console.log(`\nAll pins passed. Updating 'verified' dates to ${todayIso}...`);
      manifest.entries.forEach((e) => {
        e.verified = todayIso;
      });
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
      console.log(`Updated verified dates in ${path.relative(REPO_ROOT, manifestPath)}.`);
    } else {
      console.error(
        `\n--update-verified requested, but verification FAILED. Verified dates were NOT updated.`,
      );
    }
  }

  if (!allPassed) {
    console.error("\n[VERIFICATION FAILED]");
    if (hasStructureChanged) {
      console.error(
        "  -> Outcome (c): Upstream page structure changed. The verifier script itself needs updating.",
      );
    }
    if (hasContentDrift) {
      console.error(
        "  -> Outcome (b): Upstream content drifted. Our dictionary data is wrong and needs correction or pin removal.",
      );
    }
    if (hasFetchError) {
      console.error("  -> Network/HTTP error accessing upstream MOE dictionary.");
    }
    process.exit(1);
  }

  console.log("\nAll pinned entries successfully verified against upstream MOE dictionary.");
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
