/**
 * Minimal JSONC (JSON with Comments) reader for `wrangler.jsonc`.
 *
 * Wrangler configs allow `//` line comments, `/* *\/` block comments, and
 * trailing commas — none of which `JSON.parse` accepts. This is NOT a
 * general-purpose JSONC library: it only needs to survive this project's
 * own `wrangler.jsonc`, so it favors a correct, string-literal-aware
 * character scan over pulling in a dependency for one file.
 *
 * String-literal awareness matters for BOTH passes below, not just comment
 * stripping:
 * - This config's string VALUES contain `//` (e.g.
 *   `"https://r2-assets.moedict.tw"`) — blindly stripping everything after
 *   `//` on a line would corrupt them.
 * - A string value could, in principle, contain a literal `,}`/`,]`
 *   sequence (e.g. a code snippet or JSON-shaped example string) — a
 *   whole-text regex trailing-comma strip run AFTER comment removal would
 *   corrupt that content too, since it has no notion of string boundaries.
 *   Both passes are therefore implemented as their own string-aware
 *   character scan; neither ever touches a character while `inString`.
 */

/**
 * Strip `//` line comments and `\/* *\/` block comments from JSONC source,
 * without touching `//` or `/*` that appear inside a JSON string literal.
 * Does NOT touch trailing commas — see `removeTrailingCommas` for that,
 * kept as a separate pass/function so each concern has its own minimal,
 * independently-testable string-aware scan.
 * @param {string} text
 * @returns {string}
 */
export function stripJsoncComments(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  let inString = false;
  let stringQuote = "";
  while (i < n) {
    const ch = text[i];
    const next = i + 1 < n ? text[i + 1] : "";
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < n) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === stringQuote) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringQuote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      // Line comment: skip to (but not including) the newline.
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      // Block comment: skip past the closing */.
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Remove trailing commas before a closing `}`/`]` — a comma followed only
 * by whitespace/newlines then a closing brace/bracket is invalid JSON but
 * valid JSONC. String-aware: a comma is only ever treated as a candidate
 * trailing comma while scanning OUTSIDE a string literal, so a literal
 * `,}`/`,]` sequence inside a string value is never touched. Assumes
 * comments have already been stripped (e.g. via `stripJsoncComments`) —
 * this pass has no comment awareness of its own.
 * @param {string} text
 * @returns {string}
 */
export function removeTrailingCommas(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  let inString = false;
  let stringQuote = "";
  while (i < n) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < n) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === stringQuote) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringQuote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === ",") {
      // Look ahead (still outside any string, since we're not inString
      // right now, and a `,` outside a string is always a structural
      // separator, never the start of one): whitespace-only run to a
      // closing `}`/`]` means this comma is a trailing comma — drop it.
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j += 1;
      if (j < n && (text[j] === "}" || text[j] === "]")) {
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Parse JSONC text (comments + trailing commas tolerated) into a plain
 * object.
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonc(text) {
  return JSON.parse(removeTrailingCommas(stripJsoncComments(text)));
}
