#!/usr/bin/env node
/**
 * Detects collisions between `#id` selectors in the legacy Bootstrap-era
 * stylesheet (`data/assets/styles.css`, still loaded at runtime) and `id`
 * literals in `src/` .tsx and .ts files. A new component reusing a legacy #id gets
 * silently mangled — e.g. a `<m3e-dialog id="user-pref">` was once rendered
 * permanently invisible by `#user-pref{display:none}`.
 *
 * The ALLOWLIST below seeds the CURRENT intersection: these are deliberate
 * legacy-styled elements. The check FAILs when a src id hits a legacy #id
 * selector that is not allowlisted, telling the developer to either rename
 * the id or consciously extend the allowlist.
 *
 * Run: `vp run check:css-ids` / `vp node scripts/check-legacy-css-ids.mjs`
 * CI:  static job.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SRC = path.join(REPO_ROOT, "src");
const CSS_FILE = path.join(REPO_ROOT, "data", "assets", "styles.css");

// --- ALLOWLIST: src ids that deliberately match a legacy CSS #id selector. ---
// Each entry is a legacy-styled element that predates the component rewrite
// and is intentionally styled by data/assets/styles.css. Extend this list
// only after confirming the collision is desired.
const ALLOWLIST = new Set([
  "btn-pref", // navbar preferences toggle — legacy #btn-pref styling
  "btn-starred", // navbar starred toggle — legacy #btn-starred styling
  "moedict", // About page app container — legacy #moedict layout
  "query-box", // sidebar search input — legacy #query-box styling
  "strokes", // StrokeAnimation canvas — legacy #strokes styling
  "user-pref", // user-pref dialog — legacy #user-pref styling (deliberate)
]);

// --- Extract #id selectors from CSS (outside {} blocks, comments stripped) ---
function extractCssIds(cssPath) {
  const css = readFileSync(cssPath, "utf8");
  // Strip comments first so selectors inside comments don't count.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const ids = new Set();
  // Split on { and }; even indices are selector text, odd are rule bodies.
  const parts = stripped.split(/[{}]/);
  for (let i = 0; i < parts.length; i += 2) {
    const selectorText = parts[i] || "";
    const matches = selectorText.match(/#[A-Za-z][\w-]*/g);
    if (matches) {
      for (const m of matches) {
        ids.add(m.slice(1)); // strip leading #
      }
    }
  }
  return ids;
}

// --- Extract id literals from src/**/*.{tsx,ts} ---
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* walk(full);
    } else if (/\.(tsx|ts)$/.test(entry.name)) {
      yield full;
    }
  }
}

function extractSrcIds() {
  // id -> Set of relative file paths
  const ids = new Map();
  // Match: id="..."  id='...'  id={`...`}
  const re = /id\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g;
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    const rel = path.relative(REPO_ROOT, file);
    let m;
    while ((m = re.exec(text)) !== null) {
      const id = m[1] || m[2] || m[3];
      if (id && /^[A-Za-z][\w-]*$/.test(id)) {
        if (!ids.has(id)) ids.set(id, new Set());
        ids.get(id).add(rel);
      }
    }
  }
  return ids;
}

const cssIds = extractCssIds(CSS_FILE);
const srcIds = extractSrcIds();

// Compute intersection: src ids that collide with a CSS #id selector
const collisions = [...srcIds.keys()]
  .filter((id) => cssIds.has(id))
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const unallowed = collisions.filter((id) => !ALLOWLIST.has(id));

console.log(
  `[check-legacy-css-ids] ${cssIds.size} CSS #id selectors, ` +
    `${srcIds.size} src id literals, ${collisions.length} collision(s) ` +
    `(${unallowed.length} unallowed)`,
);

if (collisions.length > 0) {
  console.log("  Collisions:");
  for (const id of collisions) {
    const allowed = ALLOWLIST.has(id) ? " (allowlisted)" : " (UNALLOWED)";
    const files = [...srcIds.get(id)].join(", ");
    console.log(`  #${id}${allowed}  <- ${files}`);
  }
}

if (unallowed.length > 0) {
  console.error(
    `\n[check-legacy-css-ids] FAIL: ${unallowed.length} src id(s) collide with ` +
      `legacy CSS #id selectors and are not allowlisted.`,
  );
  for (const id of unallowed) {
    console.error(`  #${id} <- ${[...srcIds.get(id)].join(", ")}`);
  }
  console.error(
    "Either rename the id to avoid the legacy CSS selector, or consciously " +
      "extend ALLOWLIST in scripts/check-legacy-css-ids.mjs with a comment.",
  );
  process.exit(1);
}
