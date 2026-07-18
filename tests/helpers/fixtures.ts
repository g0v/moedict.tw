/// <reference types="node" />

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
 *   - 蛇 (U+86C7)  — lang=t, ptck bucket 71（文讀 siâ 無義項）
 *   - 長褲          — lang=t, ptck bucket 119（pinned whole-record 無義項，
 *     g0v/moedict-webkit#271; source-attributed manifest at
 *     data/sources/twblg-overrides/pinned-no-definition.json）
 *
 * Extra explicit fixtures (geometry / font tests):
 *   - 黃 (U+9EC3)  — lang=a, pack bucket 707; ㄏㄨㄤˊ length=3 tone-node geometry
 *   - MOEDICT.woff2 — ASSETS key fonts/MOEDICT.woff2; same-origin font route test
 *   - TauhuOo2005-Regular.otf / FiraSansOT-Regular.otf — ASSETS keys
 *     fonts/TauhuOo2005-Regular.otf / fonts/FiraSansOT-Regular.otf; glyph
 *     fallback + romanize=1 caption font render tests (RESCOPE #169)
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

  const taiwaneseReadingOnlyWord = "蛇";
  const taiwaneseReadingOnlyBucket = bucketOf(taiwaneseReadingOnlyWord, "t");
  const taiwaneseReadingOnlyKey = `ptck/${taiwaneseReadingOnlyBucket}.txt`;
  entries.push({
    bucket: "DICTIONARY",
    key: taiwaneseReadingOnlyKey,
    body: required(
      path.join(DATA_DICT, "ptck", `${taiwaneseReadingOnlyBucket}.txt`),
      taiwaneseReadingOnlyKey,
    ),
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });

  // 長褲 (pinned no-definition entry, g0v/moedict-webkit#271): lang=t,
  // ptck bucket 119. Whole-record no-definition (no `_`/audio id, no
  // `reading` badge) — distinct fixture from 蛇's per-heteronym reading-only
  // shape above. Source-attributed manifest:
  // data/sources/twblg-overrides/pinned-no-definition.json.
  const pinnedNoDefinitionWord = "長褲";
  const pinnedNoDefinitionBucket = bucketOf(pinnedNoDefinitionWord, "t");
  const pinnedNoDefinitionKey = `ptck/${pinnedNoDefinitionBucket}.txt`;
  entries.push({
    bucket: "DICTIONARY",
    key: pinnedNoDefinitionKey,
    body: required(
      path.join(DATA_DICT, "ptck", `${pinnedNoDefinitionBucket}.txt`),
      pinnedNoDefinitionKey,
    ),
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });

  // 異用字 (alternate-character) test fixtures (g0v/moedict-webkit#281):
  // 你 (U+4F60, bucket 96, heteronym id=2881 → variants 汝)
  // 囝 (U+56DD, bucket 93, heteronym id=2134 → variants 子)
  // Both ptck buckets must be seeded so e2e tests can verify the
  // .twblg-variants UI against real generated pack data.
  for (const variantWord of ["你", "囝"] as const) {
    const variantBucket = bucketOf(variantWord, "t");
    const variantKey = `ptck/${variantBucket}.txt`;
    entries.push({
      bucket: "DICTIONARY",
      key: variantKey,
      body: required(path.join(DATA_DICT, "ptck", `${variantBucket}.txt`), variantKey),
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
  }

  // 黃 (U+9EC3) — lang=a, pack bucket 707; ㄏㄨㄤˊ has length=3 zhuyin which
  // exercises the length=3 tone-node geometry and the same-origin font route.
  const huangBucket = bucketOf("黃", "a");
  const huangKey = `pack/${huangBucket}.txt`;
  entries.push({
    bucket: "DICTIONARY",
    key: huangKey,
    body: required(path.join(DATA_DICT, "pack", `${huangBucket}.txt`), huangKey),
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });

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

  // @口.json — seeded for the /@口 duplicate-radical-key regression test
  // (tests/e2e/dictionary.spec.ts "special routes"): 口's own stroke-0 row
  // lists the radical character itself twice in the raw upstream data,
  // exercising normalizeRows' per-row dedup (radical-page-utils.ts).
  const radicalDupFixture = "@口.json";
  for (const lang of ["a", "t", "h", "c"] as const) {
    const key = `${lang}/${radicalDupFixture}`;
    const body = optional(path.join(DATA_DICT, lang, radicalDupFixture), key);
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

  // =成語.json is needed by tests/e2e/scroll-restoration.spec.ts which scrolls
  // to y=4200 on the list page — requires a large real entry array.
  // Synthesise 200 fake entries when the real file is absent so the list page
  // renders enough rows to reach that scroll depth.
  const chengYuFixture = "=成語.json";
  const chengYuPath = path.join(DATA_DICT, "a", chengYuFixture);
  if (existsSync(chengYuPath)) {
    entries.push({
      bucket: "DICTIONARY",
      key: `a/${chengYuFixture}`,
      body: readFileSync(chengYuPath),
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  } else {
    // Synthesise 200 entries — enough rows to push document height past
    // the 4200 px target the scroll-restoration test scrolls to.
    const fakeChengYu = Array.from({ length: 200 }, (_, i) => `成語${String(i).padStart(3, "0")}`);
    entries.push({
      bucket: "DICTIONARY",
      key: `a/${chengYuFixture}`,
      body: new TextEncoder().encode(JSON.stringify(fakeChengYu)),
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

  // 兩岸辭典 bucket 9 — contains 䴉 (U+4D09, 19721 % 128 = 9);
  // seeded explicitly so /c/䴉.json returns a real dictionary entry
  // and the CNS non-shadowing contract can be asserted definitively.
  const ibisKey = "pcck/9.txt";
  entries.push({
    bucket: "DICTIONARY",
    key: ibisKey,
    body: required(path.join(DATA_DICT, "pcck", "9.txt"), ibisKey),
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });

  // CNS11643 golden fixture: 䴉 (U+4D09, CNS 4-6C51) — shard 4D, key 4D09.json
  const cnsGoldenKey = "cns/by-codepoint/4D/4D09.json";
  const cnsGoldenPath = path.join(DATA_DICT, "cns", "by-codepoint", "4D", "4D09.json");
  if (existsSync(cnsGoldenPath)) {
    entries.push({
      bucket: "DICTIONARY",
      key: cnsGoldenKey,
      body: readFileSync(cnsGoldenPath),
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  } else {
    // Inline minimal golden record matching neuralese evidence
    entries.push({
      bucket: "DICTIONARY",
      key: cnsGoldenKey,
      body: new TextEncoder().encode(
        JSON.stringify({
          char: "䴉",
          unicode: "U+4D09",
          codepoint: 19721,
          cns: "4-6C51",
          plane: 4,
          cell: "6C51",
          pua: false,
          attributes: {
            phonetic: ["ㄒㄩㄢˊ"],
            radical: { id: 196, char: "鳥" },
            stroke: 24,
            cangjie: ["WVHAF"],
            strokeSequence: "252211251353432511154444",
            source: "罕用國字標準字體表",
          },
          provenance: {
            generator: "scripts/generate-cns-data.mjs",
            sourceFiles: ["Properties.zip", "MapingTables.zip"],
            license: "OGDL-1.0",
            attribution:
              "數位發展部，CNS11643中文標準交換碼全字庫網站，https://www.cns11643.gov.tw",
          },
        }),
      ),
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
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

  // Real stroke-json for 萌 (U+840C) from tests/fixtures/stroke-json/840c.json.
  // Serves two purposes: (1) useStrokeAvailability HEAD probe returns 200 so the
  // pencil button stays enabled; (2) jquery.strokeWords.js can actually render
  // 12 strokes in #strokes, giving the container non-zero width so Playwright's
  // actionability check passes for the replay-click test.
  const strokeJson840c = path.join(FIXTURES_DIR, "stroke-json", "840c.json");
  if (existsSync(strokeJson840c)) {
    entries.push({
      bucket: "ASSETS",
      key: "stroke-json/840c.json",
      body: readFileSync(strokeJson840c),
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  }

  // Real MOEDICT.woff2 from data/assets/fonts/ — seeded under ASSETS key
  // fonts/MOEDICT.woff2 so the Worker's same-origin font route (/assets/fonts/MOEDICT.woff2)
  // returns 200 with real font bytes. This lets e2e tests assert the correct
  // HTTP status, content-type, and FontFace load status for the "MOEDICT Same-Origin"
  // @font-face alias added in src/index.css.
  const moedictWoff2Path = path.join(DATA_ASSETS, "fonts", "MOEDICT.woff2");
  if (existsSync(moedictWoff2Path)) {
    entries.push({
      bucket: "ASSETS",
      key: "fonts/MOEDICT.woff2",
      body: readFileSync(moedictWoff2Path),
      httpMetadata: { contentType: "font/woff2" },
    });
  }

  // Real Tauhu Oo 補完字型 and Fira Sans OT (romanize=1 caption font, RESCOPE
  // #169) from data/assets/fonts/ — seeded under the ASSETS keys
  // src/utils/image-generation.ts reads via loadFallbackFontBuffer /
  // loadCaptionFontBuffer, so integration tests can exercise the real
  // <text>-fallback and romanize=1 caption render paths (not just the
  // 404/503 "font missing" arms).
  const tauhuOoPath = path.join(DATA_ASSETS, "fonts", "TauhuOo2005-Regular.otf");
  if (existsSync(tauhuOoPath)) {
    entries.push({
      bucket: "ASSETS",
      key: "fonts/TauhuOo2005-Regular.otf",
      body: readFileSync(tauhuOoPath),
      httpMetadata: { contentType: "font/otf" },
    });
  }

  const firaSansOtPath = path.join(DATA_ASSETS, "fonts", "FiraSansOT-Regular.otf");
  if (existsSync(firaSansOtPath)) {
    entries.push({
      bucket: "ASSETS",
      key: "fonts/FiraSansOT-Regular.otf",
      body: readFileSync(firaSansOtPath),
      httpMetadata: { contentType: "font/otf" },
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
