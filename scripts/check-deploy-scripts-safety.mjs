#!/usr/bin/env node
/**
 * Static CI guard for the zero-downtime deploy protocol (Task 4).
 *
 * Prevents two specific regressions from silently reappearing:
 *
 *   1. A standard `package.json` script reintroducing the unsafe atomic
 *      `wrangler deploy` cutover (no gradual rollout, no rollback).
 *   2. `wrangler.jsonc`'s `version_metadata` binding losing its required
 *      shape (`{ "binding": "CF_VERSION_METADATA" }`, no `"type"` key) at
 *      either the top level or in `env.staging`.
 *
 * This is a fast, dependency-free companion to the behavioral coverage in
 * `tests/unit/package-deploy-scripts.test.ts` (which locks the EXACT deploy
 * chains/env propagation) — this script is what CI's static job runs
 * directly, mirroring `check-v8-ignore-count.mjs`'s style.
 *
 * Run: `node scripts/check-deploy-scripts-safety.mjs`
 * CI:  static job.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./lib/jsonc.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// Every VALUE-taking flag under Wrangler 4.110's `GLOBAL FLAGS` block (the
// section shown identically by `wrangler deploy --help` and `wrangler
// versions deploy --help` — confirmed by running both against the
// installed 4.110.0 binary). Deliberately the COMPLETE help-derived set,
// not a heuristic guess: `-c/--config`, `-e/--env`, `--cwd`, `--profile`,
// `--env-file`. `-h/--help`, `-v/--version`, and `--install-skills` are
// also global flags but are booleans (no separate value token) so need no
// entry here. An unknown flag not in this set is always skipped as
// exactly one token, which can only make detection MORE conservative
// (never silently swallows a real "deploy" subcommand token) — so this
// set only needs to be complete for KNOWN value-taking global flags, never
// exhaustive over Wrangler's entire flag surface.
const WRANGLER_VALUE_FLAGS = new Set([
  "--config",
  "-c",
  "--env",
  "-e",
  "--cwd",
  "--profile",
  "--env-file",
]);

/**
 * Split an npm-script string into shell command segments on `&&`, `||`,
 * `;`, and `|` — the operators that separate independently-invoked
 * commands. Token/segment logic, not a single adjacent-word regex, so a
 * global flag (and its value) between `wrangler` and `deploy` can never
 * hide the unsafe subcommand.
 * @param {string} script
 * @returns {string[]}
 */
function splitShellSegments(script) {
  return script.split(/&&|\|\||;|\|/);
}

/**
 * Tokenize a single shell segment into words, keeping quoted substrings
 * together and stripping their surrounding quotes.
 * @param {string} segment
 * @returns {string[]}
 */
function tokenize(segment) {
  const matches = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((token) =>
    (token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))
      ? token.slice(1, -1)
      : token,
  );
}

/**
 * Does this single shell segment invoke `wrangler deploy` as the ATOMIC,
 * unsafe subcommand (as opposed to the safe positional `wrangler versions
 * deploy`)? Walks tokens after the `wrangler` invocation, skipping flags
 * (and known value-flags' values) to find the ordered positional
 * subcommand words — catches `wrangler deploy`, `wrangler --env prod
 * deploy`, `vp exec wrangler --config x deploy`, etc., while never
 * flagging `wrangler versions deploy <specs> -y` regardless of where its
 * flags land.
 * @param {string} segment
 * @returns {boolean}
 */
function segmentInvokesBareWranglerDeploy(segment) {
  const tokens = tokenize(segment);
  const wranglerIndex = tokens.indexOf("wrangler");
  if (wranglerIndex === -1) return false;

  const positionals = [];
  for (let i = wranglerIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.startsWith("-")) {
      const flagName = token.split("=")[0];
      if (WRANGLER_VALUE_FLAGS.has(flagName) && !token.includes("=")) {
        i += 1; // also skip this flag's separate value token
      }
      continue;
    }
    positionals.push(token);
  }

  if (positionals[0] === "deploy") return true;
  return false;
}

/**
 * Does this npm-script VALUE contain a bare, atomic `wrangler deploy`
 * invocation in any of its `&&`/`||`/`;`/`|`-separated segments?
 * @param {string} scriptValue
 * @returns {boolean}
 */
export function containsBareWranglerDeploy(scriptValue) {
  return splitShellSegments(scriptValue).some(segmentInvokesBareWranglerDeploy);
}

/**
 * @param {Record<string, unknown>} pkg
 * @returns {string[]} problems found, empty if clean
 */
export function checkNoBareWranglerDeploy(pkg) {
  const problems = [];
  const scripts = /** @type {Record<string, unknown> | undefined} */ (pkg.scripts);
  if (!scripts || typeof scripts !== "object") {
    problems.push("package.json has no scripts object");
    return problems;
  }
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value !== "string") continue;
    if (containsBareWranglerDeploy(value)) {
      problems.push(
        `scripts.${name} contains bare "wrangler deploy" (unsafe atomic cutover): ${JSON.stringify(value)}`,
      );
    }
  }
  return problems;
}

/**
 * @param {Record<string, unknown>} value
 * @param {string} label
 * @returns {string[]} problems found, empty if clean
 */
function checkVersionMetadataShape(value, label) {
  const problems = [];
  const vm = /** @type {Record<string, unknown> | undefined} */ (value.version_metadata);
  if (!vm || typeof vm !== "object") {
    problems.push(`${label}: missing "version_metadata" binding`);
    return problems;
  }
  if (vm.binding !== "CF_VERSION_METADATA") {
    problems.push(
      `${label}: version_metadata.binding must be "CF_VERSION_METADATA", got ${JSON.stringify(vm.binding)}`,
    );
  }
  const allowedKeys = new Set(["binding"]);
  for (const key of Object.keys(vm)) {
    if (allowedKeys.has(key)) continue;
    if (key === "type") {
      problems.push(
        `${label}: version_metadata must NOT have a "type" property (got ${JSON.stringify(vm.type)}) — ` +
          `the version_metadata binding accepts only { "binding": "<name>" }`,
      );
      continue;
    }
    problems.push(`${label}: version_metadata has unexpected key "${key}"`);
  }
  return problems;
}

/**
 * @param {Record<string, unknown>} config
 * @returns {string[]} problems found, empty if clean
 */
export function checkVersionMetadataBindings(config) {
  const problems = [...checkVersionMetadataShape(config, "top-level")];
  const env = /** @type {Record<string, unknown> | undefined} */ (config.env);
  const staging = /** @type {Record<string, unknown> | undefined} */ (env?.staging);
  if (!staging || typeof staging !== "object") {
    problems.push("env.staging is missing entirely — cannot verify its version_metadata binding");
  } else {
    problems.push(...checkVersionMetadataShape(staging, "env.staging"));
  }
  return problems;
}

/* v8 ignore start -- real CLI entrypoint: reads the repo's own package.json/wrangler.jsonc from disk; exercised via the pure checkNoBareWranglerDeploy/checkVersionMetadataBindings functions in unit tests instead. */
function main() {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"));
  const config = parseJsonc(readFileSync(path.join(REPO_ROOT, "wrangler.jsonc"), "utf-8"));

  const problems = [
    ...checkNoBareWranglerDeploy(pkg),
    ...checkVersionMetadataBindings(/** @type {Record<string, unknown>} */ (config)),
  ];

  if (problems.length > 0) {
    console.error("[check-deploy-scripts-safety] FAIL:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    "[check-deploy-scripts-safety] OK — no bare `wrangler deploy` in package.json scripts; " +
      "version_metadata binding shape correct top-level and in env.staging",
  );
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main();
}
/* v8 ignore stop */
