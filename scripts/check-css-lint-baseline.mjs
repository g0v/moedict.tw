#!/usr/bin/env node
/**
 * Runs Stylelint against the legacy CSS bundle and accepts only its exact,
 * documented defect baseline. This keeps CI green for the preserved vendor
 * defects without hiding new findings behind `continue-on-error`.
 */

import stylelint from "stylelint";

const EXPECTED_FINDINGS = new Map([
  ["error:declaration-property-value-no-unknown", 16],
  ["warning:declaration-block-no-duplicate-properties", 2],
]);

const files = process.argv.length > 2 ? process.argv.slice(2) : ["data/assets/*.css"];

const lintResult = await stylelint.lint({
  files,
  formatter: "string",
});

process.stdout.write(lintResult.report);

const infrastructureProblems = lintResult.results.flatMap((result) => [
  ...result.deprecations.map((message) => `${result.source}: deprecation: ${message.text}`),
  ...result.invalidOptionWarnings.map(
    (message) => `${result.source}: invalid option: ${message.text}`,
  ),
  ...result.parseErrors.map((message) => `${result.source}: parse error: ${message.text}`),
]);

if (infrastructureProblems.length > 0) {
  console.error("\n[check-css-lint-baseline] Stylelint infrastructure errors:");
  for (const problem of infrastructureProblems) console.error(`  ${problem}`);
  process.exit(1);
}

const actualFindings = new Map();
for (const result of lintResult.results) {
  for (const warning of result.warnings) {
    const key = `${warning.severity}:${warning.rule}`;
    actualFindings.set(key, (actualFindings.get(key) ?? 0) + 1);
  }
}

const allFindingKeys = new Set([...EXPECTED_FINDINGS.keys(), ...actualFindings.keys()]);
const mismatches = [...allFindingKeys]
  .sort((a, b) => a.localeCompare(b))
  .filter((key) => actualFindings.get(key) !== EXPECTED_FINDINGS.get(key));

if (mismatches.length > 0) {
  console.error("\n[check-css-lint-baseline] Finding baseline changed:");
  for (const key of mismatches) {
    console.error(
      `  ${key}: expected ${EXPECTED_FINDINGS.get(key) ?? 0}, found ${actualFindings.get(key) ?? 0}`,
    );
  }
  console.error("Review the CSS change, then update the baseline deliberately if it is correct.");
  process.exit(1);
}

console.log("\n[check-css-lint-baseline] PASS: exact baseline matched (16 errors, 2 warnings).");
