/**
 * Curated R2 fixture set used by integration + E2E tests.
 *
 * Sources live under `data/dictionary/` (checked into git), `data/assets/`, and
 * `tests/fixtures/`. Every key listed here is loaded in-process into Miniflare
 * so the Worker can serve real content without touching production R2 or the
 * Cloudflare network.
 *
 * Canonical test words:
 *   - 萌 (U+840C)  — lang=a, pack bucket 12
 *   - 食 (U+98DF)  — lang=t, ptck bucket 31
 *   - 字 (U+5B57)  — lang=h, phck bucket 87
 *   - 上訴         — lang=c, pcck bucket 10 (first char 上 = U+4E0A)
 */

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DATA_DICT = path.join(REPO_ROOT, "data", "dictionary");
const DATA_ASSETS = path.join(REPO_ROOT, "data", "assets");
const FIXTURES_DIR = path.join(REPO_ROOT, "tests", "fixtures");

export const CANONICAL_WORDS = {
  a: "萌",
  t: "食",
  h: "字",
  c: "上訴",
} as const;

export type FixtureBucket = "DICTIONARY" | "ASSETS" | "FONTS";

export interface FixtureEntry {
  bucket: FixtureBucket;
  key: string;
  body: Uint8Array;
  httpMetadata?: { contentType?: string };
}

function tryReadFile(p: string): Uint8Array | null {
  if (!existsSync(p)) return null;
  return new Uint8Array(readFileSync(p));
}

function required(p: string, key: string): Uint8Array {
  const body = tryReadFile(p);
  if (!body) {
    throw new Error(`Fixture missing: ${key} (expected at ${p})`);
  }
  return body;
}

function optional(p: string, key: string): Uint8Array | null {
  const body = tryReadFile(p);
  if (!body) {
    console.warn(`[fixtures] optional key skipped: ${key} (not found: ${p})`);
  }
  return body;
}

function bucketOf(word: string, lang: "a" | "t" | "h" | "c"): string {
  let code = word.charCodeAt(0);
  if (code >= 0xd800 && code <= 0xdbff) {
    code = word.charCodeAt(1) - 0xdc00;
  }
  const size = lang === "a" ? 1024 : 128;
  return String(code % size);
}

export function collectDictionaryFixtures(): FixtureEntry[] {
  const entries: FixtureEntry[] = [];

  for (const [lang, word] of Object.entries(CANONICAL_WORDS) as Array<
    ["a" | "t" | "h" | "c", string]
  >) {
    const packDir = lang === "a" ? "pack" : `p${lang}ck`;
    const bucket = bucketOf(word, lang);
    const key = `${packDir}/${bucket}.txt`;
    entries.push({
      bucket: "DICTIONARY",
      key,
      body: required(path.join(DATA_DICT, packDir, `${bucket}.txt`), key),
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
  }

  for (const lang of ["a", "t", "h", "c"] as const) {
    for (const name of ["index.json", "xref.json", "xref-by-id.json"]) {
      const key = `${lang}/${name}`;
      const body = optional(path.join(DATA_DICT, lang, name), key);
      if (body) {
        entries.push({
          bucket: "DICTIONARY",
          key,
          body,
          httpMetadata: { contentType: "application/json; charset=utf-8" },
        });
      }
    }
  }

  const radicalFixture = "@子.json";
  for (const lang of ["a", "t", "h", "c"] as const) {
    const key = `${lang}/${radicalFixture}`;
    const body = optional(path.join(DATA_DICT, lang, radicalFixture), key);
    if (body) {
      entries.push({
        bucket: "DICTIONARY",
        key,
        body,
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
    }
  }

  const listFixture = "=近義詞.json";
  const listAPath = path.join(DATA_DICT, "a", listFixture);
  if (existsSync(listAPath)) {
    entries.push({
      bucket: "DICTIONARY",
      key: `a/${listFixture}`,
      body: readFileSync(listAPath),
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  } else {
    entries.push({
      bucket: "DICTIONARY",
      key: `a/=近義詞.json`,
      body: new TextEncoder().encode(JSON.stringify(["一致", "相仿", "雷同"])),
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  }

  const crossStraitListFixture = "=同實異名.json";
  const crossStraitListPath = path.join(DATA_DICT, "c", crossStraitListFixture);
  if (existsSync(crossStraitListPath)) {
    entries.push({
      bucket: "DICTIONARY",
      key: `c/${crossStraitListFixture}`,
      body: readFileSync(crossStraitListPath),
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  } else {
    entries.push({
      bucket: "DICTIONARY",
      key: `c/=同實異名.json`,
      body: new TextEncoder().encode(
        JSON.stringify([";三角皮帶;三角帶", ";人工智慧;人工智能", ";一卡通;交通卡"]),
      ),
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  }

  for (const lang of ["a", "c", "h", "t"] as const) {
    const key = `search-index/${lang}.json`;
    const body = optional(path.join(DATA_DICT, "search-index", `${lang}.json`), key);
    if (body) {
      entries.push({
        bucket: "DICTIONARY",
        key,
        body,
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
    }
  }

  const tlTerm = "tsiah";
  const tlKey = `lookup/pinyin/t/TL/${tlTerm}.json`;
  const tlPath = path.join(DATA_DICT, "lookup", "pinyin", "t", "TL", `${tlTerm}.json`);
  if (existsSync(tlPath)) {
    entries.push({
      bucket: "DICTIONARY",
      key: tlKey,
      body: readFileSync(tlPath),
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  } else {
    entries.push({
      bucket: "DICTIONARY",
      key: tlKey,
      body: new TextEncoder().encode(JSON.stringify(["食", "蝕"])),
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  }

  for (const name of ["cfdict.txt", "cfdict.xml"]) {
    const key = `translation-data/${name}`;
    const fullPath = path.join(DATA_DICT, "translation-data", name);
    const body = optional(fullPath, key);
    if (body) {
      entries.push({
        bucket: "DICTIONARY",
        key,
        body,
        httpMetadata: {
          contentType: name.endsWith(".xml")
            ? "application/xml; charset=utf-8"
            : "text/plain; charset=utf-8",
        },
      });
    }
  }

  return entries;
}

export function collectAssetFixtures(): FixtureEntry[] {
  const entries: FixtureEntry[] = [];

  // Stroke animation loader JS — tests need this to verify the Worker serves
  // the inline-SVG spinner markup (see tests/integration/api-legacy-assets.test.ts).
  const strokeWordsJs = path.join(DATA_ASSETS, "js", "jquery.strokeWords.js");
  if (existsSync(strokeWordsJs)) {
    entries.push({
      bucket: "ASSETS",
      key: "js/jquery.strokeWords.js",
      body: readFileSync(strokeWordsJs),
      httpMetadata: { contentType: "application/javascript; charset=utf-8" },
    });
  }

  const downloadBadge = path.join(
    DATA_ASSETS,
    "css",
    "Download_on_the_App_Store_Badge_HK_TW_135x40.png",
  );
  if (existsSync(downloadBadge)) {
    entries.push({
      bucket: "ASSETS",
      key: "Download_on_the_App_Store_Badge_HK_TW_135x40.png",
      body: readFileSync(downloadBadge),
      httpMetadata: { contentType: "image/png" },
    });
  }

  const manifest = path.join(FIXTURES_DIR, "manifest.appcache");
  if (existsSync(manifest)) {
    entries.push({
      bucket: "ASSETS",
      key: "manifest.appcache",
      body: readFileSync(manifest),
      httpMetadata: { contentType: "text/cache-manifest; charset=utf-8" },
    });
  } else {
    entries.push({
      bucket: "ASSETS",
      key: "manifest.appcache",
      body: new TextEncoder().encode("CACHE MANIFEST\n# moedict test fixture\n"),
      httpMetadata: { contentType: "text/cache-manifest; charset=utf-8" },
    });
  }

  return entries;
}

export function collectFontFixtures(): FixtureEntry[] {
  const entries: FixtureEntry[] = [];
  const stub = path.join(FIXTURES_DIR, "font-stub.svg");
  const svgBody = existsSync(stub)
    ? readFileSync(stub)
    : Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><path d="M0 0L1000 1000"/></svg>',
      );

  for (const codepoint of [0x840c, 0x98df, 0x5b57, 0x4e0a, 0x8a34]) {
    const hex = codepoint.toString(16).toUpperCase().padStart(4, "0");
    entries.push({
      bucket: "FONTS",
      key: `TW-Kai/U+${hex}.svg`,
      body: new Uint8Array(svgBody),
      httpMetadata: { contentType: "image/svg+xml" },
    });
  }

  return entries;
}

export function collectAllFixtures(): FixtureEntry[] {
  return [...collectDictionaryFixtures(), ...collectAssetFixtures(), ...collectFontFixtures()];
}
