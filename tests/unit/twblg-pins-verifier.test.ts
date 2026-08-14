import { describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  calculatePinAge,
  getPinAgeSummary,
  isValidIsoDate,
  normalizeWhitespace,
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
    expect(isValidIsoDate("2026-04-31")).toBe(false); // April has 30 days
    expect(isValidIsoDate("not-a-date")).toBe(false);
    expect(isValidIsoDate("")).toBe(false);
    expect(isValidIsoDate(null)).toBe(false);
    expect(isValidIsoDate(123)).toBe(false);
  });

  it("validates pinned manifest structure and required fields", () => {
    const validManifest = {
      entries: [
        {
          title: "長褲",
          T: "tn̂g-khòo",
          source_entry_url: "https://sutian.moe.edu.tw/zh-hant/su/25638/",
          source_search_url:
            "https://sutian.moe.edu.tw/zh-hant/tshiau/?lui=tai_su&tsha=%E9%95%B7%E8%A4%B2",
          source_note: "MOE 臺灣台語常用詞辭典 su/25638",
          verified: "2026-07-17",
        },
      ],
    };

    const result = validatePinnedManifest(validManifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails validation if required fields are missing or date is invalid", () => {
    const invalidManifest = {
      entries: [
        {
          title: "長褲",
          // missing T, source_entry_url, source_search_url, source_note
          verified: "2026-99-99",
        },
      ],
    };

    const result = validatePinnedManifest(invalidManifest);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
    expect(result.errors.some((e) => e.includes("missing or empty required string field"))).toBe(
      true,
    );
    expect(result.errors.some((e) => e.includes("is not a valid ISO YYYY-MM-DD date"))).toBe(true);
  });

  it("calculates pin age correctly", () => {
    const fakeNow = new Date("2026-08-14T00:00:00Z");
    const age = calculatePinAge("2026-07-17", fakeNow);
    expect(age).toBe(28);

    const summary = getPinAgeSummary(
      {
        entries: [
          {
            title: "長褲",
            T: "tn̂g-khòo",
            source_entry_url: "https://sutian.moe.edu.tw/zh-hant/su/25638/",
            source_search_url:
              "https://sutian.moe.edu.tw/zh-hant/tshiau/?lui=tai_su&tsha=%E9%95%B7%E8%A4%B2",
            source_note: "MOE 臺灣台語常用詞辭典",
            verified: "2026-07-17",
          },
          {
            title: "芭蕾",
            T: "pa-lê",
            source_entry_url: "https://sutian.moe.edu.tw/zh-hant/su/23071/",
            source_search_url: "https://sutian.moe.edu.tw/zh-hant/tshiau/?lui=tai_su&tsha=...",
            source_note: "MOE 臺灣台語常用詞辭典",
            verified: "2026-08-14",
          },
        ],
      },
      fakeNow,
    );

    expect(summary.count).toBe(2);
    expect(summary.oldestDate).toBe("2026-07-17");
    expect(summary.oldestAgeDays).toBe(28);
    expect(summary.oldestTitle).toBe("長褲");
  });

  it("normalizes whitespace and Unicode form cleanly", () => {
    expect(normalizeWhitespace(" （臺華共同詞 ，無義項） ")).toBe("（臺華共同詞 ，無義項）");
  });
});

describe("verifyEntryHtml pure logic", () => {
  it("returns ok when headword, reading, and negative no-definition hold", () => {
    const html = loadFixture("entry-valid-no-def.html");
    const result = verifyEntryHtml(html, "長褲", "tn̂g-khòo");
    expect(result.status).toBe("ok");
    expect(result.mismatches).toHaveLength(0);
  });

  it("handles multi-reading alternate entries (e.g. NFD pa-lê/pa-lé vs NFC HTML)", () => {
    const html = loadFixture("entry-valid-multi-reading.html");
    // Pass T in NFD to test normalization
    const result = verifyEntryHtml(html, "芭蕾", "pa-le\u0302/pa-le\u0301");
    expect(result.status).toBe("ok");
    expect(result.mismatches).toHaveLength(0);
  });

  it("fails when main reading is absent from pronunciation header even if present elsewhere in document", () => {
    const html = loadFixture("entry-drift-main-reading-only-in-body.html");
    const result = verifyEntryHtml(html, "長褲", "tn̂g-khòo");
    expect(result.status).toBe("content_drift");
    expect(
      result.mismatches.some((m) => m.includes("Main reading missing from pronunciation header")),
    ).toBe(true);
  });

  it("detects content drift when expected alternate reading is missing because 又唸作 section is gone", () => {
    const html = loadFixture("entry-drift-alt-reading-missing-section.html");
    const result = verifyEntryHtml(html, "芭蕾", "pa-le\u0302/pa-le\u0301");
    expect(result.status).toBe("content_drift");
    expect(
      result.mismatches.some((m) => m.includes('Alternate reading section ("又唸作") not found')),
    ).toBe(true);
  });

  it("detects content drift when expected alternate reading in 又唸作 section does not match", () => {
    const html = loadFixture("entry-drift-alt-reading-mismatched.html");
    const result = verifyEntryHtml(html, "芭蕾", "pa-le\u0302/pa-le\u0301");
    expect(result.status).toBe("content_drift");
    expect(
      result.mismatches.some((m) => m.includes('Alternate reading missing from "又唸作" section')),
    ).toBe(true);
  });

  it("detects content drift when a definition section appears on the entry page", () => {
    const html = loadFixture("entry-drift-with-definition.html");
    const result = verifyEntryHtml(html, "長褲", "tn̂g-khòo");
    expect(result.status).toBe("content_drift");
    expect(result.mismatches.some((m) => m.includes("Definition section appeared"))).toBe(true);
  });

  it("detects content drift when headword mismatches", () => {
    const html = loadFixture("entry-drift-headword-mismatch.html");
    const result = verifyEntryHtml(html, "長褲", "tn̂g-khòo");
    expect(result.status).toBe("content_drift");
    expect(result.mismatches.some((m) => m.includes("Headword mismatch"))).toBe(true);
  });

  it("distinguishes page structure changes (missing <h1>)", () => {
    const html = loadFixture("entry-structure-missing-h1.html");
    const result = verifyEntryHtml(html, "長褲", "tn̂g-khòo");
    expect(result.status).toBe("structure_changed");
    expect(result.mismatches.some((m) => m.includes("missing <main> or <h1>"))).toBe(true);
  });

  it("distinguishes page structure changes (missing pronunciation header list)", () => {
    const html = loadFixture("entry-structure-missing-reading-header.html");
    const result = verifyEntryHtml(html, "長褲", "tn̂g-khòo");
    expect(result.status).toBe("structure_changed");
    expect(
      result.mismatches.some((m) => m.includes("could not locate pronunciation header list")),
    ).toBe(true);
  });
});

describe("verifySearchHtml pure logic", () => {
  it("returns ok when exactly 1 exact match and no-definition marker are found (ignoring partial match counts)", () => {
    const html = loadFixture("search-valid-one-match.html");
    const result = verifySearchHtml(html, "長褲");
    expect(result.status).toBe("ok");
    expect(result.mismatches).toHaveLength(0);
  });

  it("detects content drift when search definition row carries actual definition text instead of no-definition marker", () => {
    const html = loadFixture("search-drift-def-appeared.html");
    const result = verifySearchHtml(html, "長褲");
    expect(result.status).toBe("content_drift");
    expect(result.mismatches.some((m) => m.includes("does not carry no-definition marker"))).toBe(
      true,
    );
  });

  it("detects content drift when 0 exact matches are found", () => {
    const html = loadFixture("search-drift-zero-matches.html");
    const result = verifySearchHtml(html, "長褲");
    expect(result.status).toBe("content_drift");
    expect(result.mismatches.some((m) => m.includes("expected exactly 1"))).toBe(true);
  });

  it("detects content drift when multiple exact matches are found", () => {
    const html = loadFixture("search-drift-multiple-matches.html");
    const result = verifySearchHtml(html, "長褲");
    expect(result.status).toBe("content_drift");
    expect(result.mismatches.some((m) => m.includes("expected exactly 1"))).toBe(true);
  });

  it("distinguishes page structure changes when summary count pattern is missing", () => {
    const html = loadFixture("search-structure-missing-count.html");
    const result = verifySearchHtml(html, "長褲");
    expect(result.status).toBe("structure_changed");
    expect(result.mismatches.some((m) => m.includes("could not find '完全符合 ... 有 X 筆'"))).toBe(
      true,
    );
  });

  it("distinguishes page structure changes when definition row is missing from search table", () => {
    const html = loadFixture("search-structure-missing-def-row.html");
    const result = verifySearchHtml(html, "長褲");
    expect(result.status).toBe("structure_changed");
    expect(result.mismatches.some((m) => m.includes("could not find definition row"))).toBe(true);
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
