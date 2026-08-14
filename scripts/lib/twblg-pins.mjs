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

/**
 * Checks an entry HTML page against expected title, reading(s), and no-definition condition.
 * @param {string} html
 * @param {string} expectedTitle
 * @param {string} expectedT
 * @returns {{ status: "ok" | "content_drift" | "structure_changed", mismatches: string[] }}
 */
export function verifyEntryHtml(html, expectedTitle, expectedT) {
  const mismatches = [];

  const hasH1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.test(html);
  const hasMain = /<main\b/i.test(html) || /class="[^"]*container/i.test(html);
  if (!hasH1 || !hasMain) {
    return {
      status: "structure_changed",
      mismatches: ["Entry page structure changed: missing <h1...>" + (!hasH1 ? " and <main>" : "")],
    };
  }

  const h1Match = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const h1Text = h1Match ? h1Match[1].replace(/<[^>]+>/g, "").trim() : "";
  if (h1Text !== expectedTitle) {
    mismatches.push(`Headword mismatch: expected "${expectedTitle}", got "${h1Text}"`);
  }

  const expectedReadings = expectedT.split("/").map((r) => r.trim().normalize("NFC"));

  for (const reading of expectedReadings) {
    const normHtml = html.normalize("NFC");
    if (!normHtml.includes(reading)) {
      mismatches.push(`Reading missing from page: expected reading "${reading}" not found`);
    }
  }

  const hasDefinitionSection =
    /id=["']釋義["']/i.test(html) ||
    /<h2\b[^>]*>\s*釋義\s*<\/h2>/i.test(html) ||
    /class="[^"]*subok-pt[^"]*"[^>]*>\s*釋義\s*<\/h2>/i.test(html);

  if (hasDefinitionSection) {
    mismatches.push("Definition appeared on page (section '釋義' found)");
  }

  if (mismatches.length > 0) {
    return { status: "content_drift", mismatches };
  }

  return { status: "ok", mismatches: [] };
}

/**
 * Checks a search result HTML page against expected exact match count (1).
 * @param {string} html
 * @param {string} expectedTitle
 * @returns {{ status: "ok" | "content_drift" | "structure_changed", mismatches: string[] }}
 */
export function verifySearchHtml(html, expectedTitle) {
  const normHtml = html.normalize("NFC");
  const normTitle = expectedTitle.normalize("NFC");

  const matchCount = normHtml.match(/完全符合\s*「?([^」"'\s]+)」?\s*有\s*(\d+)\s*筆/);
  if (!matchCount) {
    return {
      status: "structure_changed",
      mismatches: [
        `Search page structure changed: could not find "完全符合 ... 有 X 筆" summary pattern`,
      ],
    };
  }

  const reportedTitle = matchCount[1].trim();
  const count = parseInt(matchCount[2], 10);

  const mismatches = [];
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

  if (mismatches.length > 0) {
    return { status: "content_drift", mismatches };
  }

  return { status: "ok", mismatches: [] };
}
