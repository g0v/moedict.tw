/**
 * Minimal JSONC (JSON with Comments) reader for `wrangler.jsonc`.
 *
 * Wrangler configs allow `//` line comments, `/* *\/` block comments, and
 * trailing commas — none of which `JSON.parse` accepts. This is NOT a
 * general-purpose JSONC library: it only needs to survive this project's
 * own `wrangler.jsonc`, so it favors a correct, string-literal-aware
 * character scan over pulling in a dependency for one file.
 *
 * String-literal awareness matters here specifically because this config's
 * string VALUES contain `//` (e.g. `"https://r2-assets.moedict.tw"`) —
 * blindly stripping everything after `//` on a line would corrupt them.
 */

/**
 * Strip `//` line comments and `\/* *\/` block comments from JSONC source,
 * without touching `//` or `/*` that appear inside a JSON string literal,
 * then remove trailing commas before `}`/`]`.
 * @param {string} text
 * @returns {string} valid JSON text
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
  // Trailing commas: a comma followed only by whitespace/newlines then a
  // closing `}` or `]` is invalid JSON but valid JSONC.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Parse JSONC text (comments + trailing commas tolerated) into a plain
 * object.
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonc(text) {
  return JSON.parse(stripJsoncComments(text));
}
