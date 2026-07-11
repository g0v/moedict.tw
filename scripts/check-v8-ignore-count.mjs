#!/usr/bin/env node
/**
 * Caps the total number of `v8 ignore` / `istanbul ignore` escape-hatch
 * comments in src/**. The point isn't to ban them — defensive code for
 * genuinely-unreachable paths (impossible null, unreachable default, etc.)
 * is fine — but to prevent the cap from being a growing source of silent
 * coverage debt.
 *
 * Raise MAX_IGNORED deliberately in a PR when a new ignore is legitimately
 * justified; never raise it just to make the check pass.
 *
 * Run: `bun scripts/check-v8-ignore-count.mjs`
 * CI:  static job.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SRC = path.join(REPO_ROOT, "src");
const WORKER = path.join(REPO_ROOT, "worker");

// The hard cap. Start low; raise deliberately.
const MAX_IGNORED = 20;

// Matches any v8/istanbul coverage-ignore directive used by vitest + nyc.
const IGNORE_REGEX = /\/\*\s*(v8|c8|istanbul|node:coverage)\s+ignore\b/g;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* walk(full);
    } else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

function countIgnoresIn(dir) {
  try {
    statSync(dir);
  } catch {
    return [];
  }
  const hits = [];
  for (const file of walk(dir)) {
    const text = readFileSync(file, "utf-8");
    const matches = text.match(IGNORE_REGEX);
    if (matches && matches.length > 0) {
      hits.push({ file: path.relative(REPO_ROOT, file), count: matches.length });
    }
  }
  return hits;
}

const hits = [...countIgnoresIn(SRC), ...countIgnoresIn(WORKER)];
const total = hits.reduce((acc, h) => acc + h.count, 0);

console.log(
  `[check-v8-ignore-count] found ${total} coverage-ignore directive(s) (cap: ${MAX_IGNORED})`,
);
if (hits.length > 0) {
  for (const h of hits.sort((a, b) => b.count - a.count)) {
    console.log(`  ${h.count.toString().padStart(3)}  ${h.file}`);
  }
}

if (total > MAX_IGNORED) {
  console.error(`\n[check-v8-ignore-count] FAIL: ${total} ignores exceeds cap of ${MAX_IGNORED}.`);
  console.error(
    "Either add a real test for the ignored branch, or raise MAX_IGNORED deliberately in this script with a comment explaining why.",
  );
  process.exit(1);
}
