import { describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  calculatePinAge,
  getPinAgeSummary,
  isValidIsoDate,
  validatePinnedManifest,
  verifyEntryHtml,
  verifySearchHtml,
} from "../../scripts/lib/twblg-pins.mjs";
import { verifySinglePin } from "../../commands/verify-twblg-pins-upstream.mjs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../fixtures/twblg-upstream");

function loadFixture(filename: string): string {
  return readFileSync(path.join(FIXTURES_DIR, filename), "utf8");
}

describe("twblg-pins provenance and date validation", () => {
  it("validates ISO YYYY-MM-DD dates correctly", () => {
    expect(isValidIsoDate("2026-07-17")).toBe(true);
    expect(isValidIsoDate("2026-02-28")).toBe(true);
    expect(isValidIsoDate("2026-02-29")).toBe(false); // 2026 is not a leap year
    expect(isValidIsoDate("2026-13-01")).toBe(false);
    expect(isValidIsoDate("2026-00-10")).toBe(false);
    expect(isValidIsoDate("2026-07-32")).toBe(false);
    expect(isValidIsoDate("invalid-date")).toBe(false);
    expect(isValidIsoDate("")).toBe(false);
    expect(isValidIsoDate(null)).toBe(false);
    expect(isValidIsoDate(undefined)).toBe(false);
  });

  it("validates pinned manifest structure and required fields", () => {
    const validManifest = {
      entries: [
        {
          title: "長褲",
          T: "tn̂g-khòo",
          source_entry_url: "https://sutian.moe.edu.tw/entry",
          source_search_url: "https://sutian.moe.edu.tw/search",
          source_note: "教育部臺灣閩南語常用詞辭典",
          verified: "2026-07-17",
        },
      ],
    };

    const { valid, errors } = validatePinnedManifest(validManifest);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it("fails validation if required fields are missing or date is invalid", () => {
    const invalidManifest = {
      entries: [
        {
          title: "長褲",
          T: "tn̂g-khòo",
          // missing source_entry_url, source_search_url, source_note
          verified: "2026-99-99",
        },
      ],
    };

    const { valid, errors } = validatePinnedManifest(invalidManifest);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });

  it("calculates pin age correctly", () => {
    const refDate = new Date("2026-08-14T12:00:00Z");
    const ageDays = calculatePinAge("2026-07-17", refDate);
    expect(ageDays).toBe(28);

    const summary = getPinAgeSummary(
      {
        entries: [
          {
            title: "長褲",
            T: "tn̂g-khòo",
            source_entry_url: "url1",
            source_search_url: "url2",
            source_note: "note",
            verified: "2026-07-17",
          },
          {
            title: "芭蕾",
            T: "pa-lê",
            source_entry_url: "url1",
            source_search_url: "url2",
            source_note: "note",
            verified: "2026-08-01",
          },
        ],
      },
      refDate,
    );

    expect(summary.count).toBe(2);
    expect(summary.oldestDate).toBe("2026-07-17");
    expect(summary.oldestTitle).toBe("長褲");
    expect(summary.oldestAgeDays).toBe(28);
  });
});

describe("verifyEntryHtml pure logic", () => {
  it("returns ok when headword, reading, and no-definition hold", () => {
    const html = loadFixture("entry-valid-no-def.html");
    const result = verifyEntryHtml(html, "長褲", "tn̂g-khòo");
    expect(result.status).toBe("ok");
    expect(result.mismatches).toHaveLength(0);
  });

  it("handles multi-reading alternate entries (e.g. pa-lê/pa-lé)", () => {
    const html = loadFixture("entry-valid-multi-reading.html");
    const result = verifyEntryHtml(html, "芭蕾", "pa-lê/pa-lé");
    expect(result.status).toBe("ok");
    expect(result.mismatches).toHaveLength(0);
  });

  it("detects content drift when a definition appears", () => {
    const html = loadFixture("entry-drift-with-definition.html");
    const result = verifyEntryHtml(html, "長褲", "tn̂g-khòo");
    expect(result.status).toBe("content_drift");
    expect(result.mismatches.some((m) => m.includes("Definition appeared"))).toBe(true);
  });

  it("detects content drift when readings change/disappear", () => {
    const html = loadFixture("entry-drift-reading-changed.html");
    const result = verifyEntryHtml(html, "芭蕾", "pa-lê/pa-lé");
    expect(result.status).toBe("content_drift");
    expect(result.mismatches.some((m) => m.includes("Reading missing"))).toBe(true);
  });

  it("detects content drift when headword mismatches", () => {
    const html = loadFixture("entry-drift-headword-mismatch.html");
    const result = verifyEntryHtml(html, "長褲", "tn̂g-khòo");
    expect(result.status).toBe("content_drift");
    expect(result.mismatches.some((m) => m.includes("Headword mismatch"))).toBe(true);
  });

  it("distinguishes page structure changes (e.g. missing <h1>)", () => {
    const html = loadFixture("entry-structure-missing-h1.html");
    const result = verifyEntryHtml(html, "長褲", "tn̂g-khòo");
    expect(result.status).toBe("structure_changed");
    expect(result.mismatches.some((m) => m.includes("structure changed"))).toBe(true);
  });
});

describe("verifySearchHtml pure logic", () => {
  it("returns ok when exactly 1 match is found", () => {
    const html = loadFixture("search-valid-one-match.html");
    const result = verifySearchHtml(html, "長褲");
    expect(result.status).toBe("ok");
    expect(result.mismatches).toHaveLength(0);
  });

  it("detects content drift when 0 matches found", () => {
    const html = loadFixture("search-drift-zero-matches.html");
    const result = verifySearchHtml(html, "長褲");
    expect(result.status).toBe("content_drift");
    expect(result.mismatches.some((m) => m.includes("expected exactly 1"))).toBe(true);
  });

  it("detects content drift when multiple matches found", () => {
    const html = loadFixture("search-drift-multiple-matches.html");
    const result = verifySearchHtml(html, "長褲");
    expect(result.status).toBe("content_drift");
    expect(result.mismatches.some((m) => m.includes("expected exactly 1"))).toBe(true);
  });

  it("distinguishes page structure changes when summary pattern is missing", () => {
    const html = loadFixture("search-structure-changed.html");
    const result = verifySearchHtml(html, "長褲");
    expect(result.status).toBe("structure_changed");
    expect(result.mismatches.some((m) => m.includes("Search page structure changed"))).toBe(true);
  });
});

describe("verifySinglePin with mock fetch", () => {
  it("orchestrates passing entry and search verification", async () => {
    const entryHtml = loadFixture("entry-valid-no-def.html");
    const searchHtml = loadFixture("search-valid-one-match.html");

    const mockFetch = async (input: string | URL | Request) => {
      const urlStr =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (urlStr.includes("entry")) {
        return { ok: true, status: 200, text: async () => entryHtml } as unknown as Response;
      }
      return { ok: true, status: 200, text: async () => searchHtml } as unknown as Response;
    };

    const entry = {
      title: "長褲",
      T: "tn̂g-khòo",
      source_entry_url: "https://sutian.moe.edu.tw/entry",
      source_search_url: "https://sutian.moe.edu.tw/search",
      source_note: "教育部臺灣閩南語常用詞辭典",
      verified: "2026-07-17",
    };

    const report = await verifySinglePin(entry, mockFetch as unknown as typeof fetch);
    expect(report.status).toBe("ok");
    expect(report.details).toHaveLength(0);
  });

  it("handles fetch errors gracefully", async () => {
    const mockFetch = async () => {
      throw new Error("Network unreachable");
    };

    const entry = {
      title: "長褲",
      T: "tn̂g-khòo",
      source_entry_url: "https://sutian.moe.edu.tw/entry",
      source_search_url: "https://sutian.moe.edu.tw/search",
      source_note: "教育部臺灣閩南語常用詞辭典",
      verified: "2026-07-17",
    };

    const report = await verifySinglePin(entry, mockFetch as unknown as typeof fetch);
    expect(report.status).toBe("fetch_error");
    expect(report.details.some((d) => d.includes("Network unreachable"))).toBe(true);
  });
});
