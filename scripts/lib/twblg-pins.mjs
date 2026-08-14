import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../..");
export const DEFAULT_PINNED_MANIFEST_PATH = path.join(
  REPO_ROOT,
  "data",
  "sources",
  "twblg-overrides",
  "pinned-no-definition.json",
);

/**
 * Validates ISO YYYY-MM-DD date format and sanity checks month/day/year.
 * @param {unknown} dateStr
 * @returns {boolean}
 */
export function isValidIsoDate(dateStr) {
  if (typeof dateStr !== "string") return false;
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(dateStr);
  if (!match) return false;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * @param {unknown} manifest
 * @returns {{ valid: boolean, errors: string[], manifest?: any }}
 */
export function validatePinnedManifest(manifest) {
  const errors = [];
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return { valid: false, errors: ["Manifest root must be an object"] };
  }
  const entries = manifest.entries;
  if (!Array.isArray(entries)) {
    return { valid: false, errors: ['Manifest "entries" must be an array'] };
  }

  const validatedEntries = [];
  entries.forEach((entry, idx) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`Entry #${idx} is not an object`);
      return;
    }
    const e = entry;
    const requiredFields = [
      "title",
      "T",
      "source_entry_url",
      "source_search_url",
      "source_note",
      "verified",
    ];

    for (const field of requiredFields) {
      if (typeof e[field] !== "string" || !e[field].trim()) {
        errors.push(
          `Entry #${idx} (${e.title ?? "unknown"}) missing or empty required string field "${field}"`,
        );
      }
    }

    if (typeof e.verified === "string" && e.verified.trim()) {
      if (!isValidIsoDate(e.verified)) {
        errors.push(
          `Entry #${idx} (${e.title ?? "unknown"}) "verified" date "${e.verified}" is not a valid ISO YYYY-MM-DD date`,
        );
      }
    }

    if (errors.length === 0) {
      validatedEntries.push(e);
    }
  });

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    manifest: manifest,
  };
}

export function calculatePinAge(verifiedDateStr, now = new Date()) {
  const verified = new Date(`${verifiedDateStr}T00:00:00Z`);
  const diffTime = now.getTime() - verified.getTime();
  return Math.max(0, Math.floor(diffTime / (1000 * 60 * 60 * 24)));
}

export function getPinAgeSummary(manifest, now = new Date()) {
  if (!manifest.entries || manifest.entries.length === 0) {
    return { count: 0, oldestDate: null, oldestAgeDays: null, oldestTitle: null };
  }

  let oldestEntry = null;
  let oldestDays = -1;

  for (const entry of manifest.entries) {
    if (entry.verified && isValidIsoDate(entry.verified)) {
      const age = calculatePinAge(entry.verified, now);
      if (age > oldestDays) {
        oldestDays = age;
        oldestEntry = entry;
      }
    }
  }

  if (!oldestEntry) {
    return {
      count: manifest.entries.length,
      oldestDate: null,
      oldestAgeDays: null,
      oldestTitle: null,
    };
  }

  return {
    count: manifest.entries.length,
    oldestDate: oldestEntry.verified,
    oldestAgeDays: oldestDays,
    oldestTitle: oldestEntry.title,
  };
}

export function normalizeWhitespace(s) {
  return s.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * Checks an entry HTML page against expected title, reading(s), and no-definition condition.
 * @param {string} html
 * @param {string} expectedTitle
 * @param {string} expectedT
 * @returns {{ status: "ok" | "content_drift" | "structure_changed", mismatches: string[] }}
 */
export function verifyEntryHtml(html, expectedTitle, expectedT) {
  const mismatches = [];
  const normHtml = html.normalize("NFC");
  const normTitle = expectedTitle.normalize("NFC");

  // 1. Structure check: <main> and <h1> must be present
  const hasMain = /<main\b/i.test(normHtml);
  const h1Match = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(normHtml);
  if (!hasMain || !h1Match) {
    return {
      status: "structure_changed",
      mismatches: ["Entry page structure changed: missing <main> or <h1> element"],
    };
  }

  // 2. Headword match
  const h1Text = h1Match[1].replace(/<[^>]+>/g, "").trim();
  if (h1Text !== normTitle) {
    mismatches.push(`Headword mismatch: expected "${normTitle}", got "${h1Text}"`);
  }

  // 3. Pronunciation list header structure check
  const readingBlockMatch = normHtml.match(
    /<header[\s\S]*?<ul\b[^>]*class="[^"]*list-inline[^"]*"[\s\S]*?<\/header>/i,
  );
  if (!readingBlockMatch) {
    return {
      status: "structure_changed",
      mismatches: ["Entry page structure changed: could not locate pronunciation header list"],
    };
  }

  // 4. Check all expected readings (NFC normalized)
  const expectedReadings = expectedT.split("/").map((r) => r.trim().normalize("NFC"));
  for (const reading of expectedReadings) {
    if (!normHtml.includes(reading)) {
      mismatches.push(`Reading missing from entry page: expected reading "${reading}" not found`);
    }
  }

  // 5. Negative assertion: entry page must NOT contain a definition section
  const hasDefinitionSection =
    /id=["']釋義["']/i.test(normHtml) ||
    /<h2\b[^>]*>\s*釋義\s*<\/h2>/i.test(normHtml) ||
    /class="[^"]*subok-pt[^"]*"[^>]*>\s*釋義\s*<\/h2>/i.test(normHtml);

  if (hasDefinitionSection) {
    mismatches.push('Definition section appeared on entry page (section "釋義" found)');
  }

  if (mismatches.length > 0) {
    return { status: "content_drift", mismatches };
  }

  return { status: "ok", mismatches: [] };
}

/**
 * Checks a search result HTML page against expected exact match count (1) and positive no-definition marker.
 * @param {string} html
 * @param {string} expectedTitle
 * @returns {{ status: "ok" | "content_drift" | "structure_changed", mismatches: string[] }}
 */
export function verifySearchHtml(html, expectedTitle) {
  const mismatches = [];
  const normHtml = html.normalize("NFC");
  const normTitle = expectedTitle.normalize("NFC");

  // 1. Structure check: exact match count
  const countMatch = normHtml.match(/完全符合\s*「?([^」"'\s]+)」?\s*有\s*(\d+)\s*筆/);
  if (!countMatch) {
    return {
      status: "structure_changed",
      mismatches: [
        "Search page structure changed: could not find '完全符合 ... 有 X 筆' summary pattern",
      ],
    };
  }

  const reportedTitle = countMatch[1].trim();
  const count = parseInt(countMatch[2], 10);

  if (reportedTitle !== normTitle) {
    mismatches.push(
      `Search target title mismatch: expected "${normTitle}", found "${reportedTitle}" in search header`,
    );
  }
  if (count !== 1) {
    mismatches.push(
      `Search match count changed: expected exactly 1 "完全符合" result for "${normTitle}", got ${count}`,
    );
  }

  // 2. Positive assertion: definition row in search result table
  const defRowMatch = normHtml.match(
    /<tr>\s*<th>\s*釋義\s*<\/th>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/i,
  );
  if (!defRowMatch) {
    return {
      status: "structure_changed",
      mismatches: [
        "Search page structure changed: could not find definition row (<tr><th>釋義</th><td>...) in search result table",
      ],
    };
  }

  const defText = normalizeWhitespace(defRowMatch[1].replace(/<[^>]+>/g, ""));
  if (!defText.includes("無義項")) {
    mismatches.push(
      `Search page definition row does not carry no-definition marker: got "${defText}"`,
    );
  }

  if (mismatches.length > 0) {
    return { status: "content_drift", mismatches };
  }

  return { status: "ok", mismatches: [] };
}
