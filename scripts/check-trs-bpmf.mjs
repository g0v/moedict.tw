#!/usr/bin/env bun
/**
 * Exhaustive completeness gate for the Taiwanese (ptck) romanization ->
 * bopomofo pipeline (src/utils/pinyin-preference-utils.ts's trsToBpmf /
 * applyTaigiSandhi, and bopomofo-pinyin-utils.ts's decorateRuby /
 * isRubyBasePunctuation).
 *
 * Hand-written phonology tables (TAIWANESE_VOWELS/CONSONANTS/TONES,
 * PHRASE_BOUNDARY_RE, RUBY_BASE_PUNCTUATION_RE, RUBY_ANNOTATION_PUNCTUATION_RE)
 * have no built-in completeness guarantee — a missing vowel or an
 * unrecognized boundary/punctuation character silently produces broken
 * output instead of an error. This script runs the REAL production
 * functions (no reimplementation) against every romanization string in the
 * full ptck corpus and fails CI if any of them:
 *
 *  A. Can't be converted at all — leftover Latin letters in the bopomofo
 *     output prove some vowel/consonant/syllable shape has no table entry
 *     (the class of bug behind g0v/moedict-webkit#301, the missing `op`
 *     vowel).
 *  B. Convert to a structurally wrong shape — a tone-diacritic combining
 *     mark orphaned at the start of a space-delimited annotation token
 *     means it detached from its base character, usually because a
 *     boundary character (e.g. "/", "──") wasn't recognized by the sandhi
 *     tokenizer or a downstream spacing regex (the class of bug behind
 *     g0v/moedict-webkit#300, the misplaced tone-8 dot).
 *  C. The rendered ruby's zhuyin <rtc> doesn't have exactly one <rt> per
 *     syllable of the main reading. ruby2hruby pairs zhuyin <rt> to <rb>
 *     STRICTLY by array position (rbs[idx] <-> rts[idx], no rbspan
 *     tolerance — see ruby2hruby.ts), so one extra or missing <rt>
 *     shifts every following syllable's annotation onto the wrong
 *     character. This is g0v/moedict-webkit#299's actual mechanism —
 *     caught a second, independent instance during development (a
 *     straight double-quote around quoted dialogue wasn't a recognized
 *     annotation-token boundary).
 *  D. RUBY_BASE_PUNCTUATION_RE misclassifies a character actually present
 *     in example-sentence hanzi text, cross-checked against an independent
 *     Unicode Punctuation/Symbol/Separator test — a mismatch means some
 *     character will get (or wrongly skip) its own <rb> ruby base, corrupting
 *     the positional <rb>/<rt> pairing the same way as check C.
 *
 * This is check:data's philosophy applied to the phonology tables: turn
 * "can't convert / converts to the wrong shape" into a CI error instead of
 * a silently broken page.
 *
 * Run: `bun run check:trs` / `bun scripts/check-trs-bpmf.mjs`
 * CI:  static job.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decorateRuby, isRubyBasePunctuation } from '../src/utils/bopomofo-pinyin-utils.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PTCK_DIR = path.join(REPO_ROOT, 'data', 'dictionary', 'ptck');

// --- Known upstream data-quality issues in example-sentence romanization,
// each confirmed against live upstream (sutian.moe.edu.tw) or plainly a
// stray trailing character. This is dictionary CONTENT (CC BY-ND 3.0 TW —
// this repo may not rewrite it; see AGENTS.md「授權紅線」); the fix belongs
// in moedict-process's next twblg re-sync, the same class as #297 (咸的解釋
// 有一項錯誤). Keyed on source -> a short sha256 hash of the exact `trs`
// string (hash, not the raw string, because these strings are combining-
// character-heavy Tai-lo text — see computeTrsHash below for why matching
// the raw text is fragile). This still expires automatically: once the
// pack file is regenerated with corrected text, the hash no longer matches
// and the check runs (and should pass) as normal — no manual
// re-verification of this list is needed.
function computeTrsHash(trs) {
  return new Bun.CryptoHasher('sha256').update(trs).digest('hex').slice(0, 12);
}

const KNOWN_DATA_ISSUES = new Map([
  [
    // 攏總 (su/12790): upstream https://sutian.moe.edu.tw/zh-hant/su/12790/
    // confirms "lóng-tsóng"; this example has "lóng-tsóg" (missing "n").
    'data/dictionary/ptck/15.txt#%u650F%u7E3D d[0].e[0]',
    '20d917aec1f7',
  ],
  [
    // 好客 (su/2341): upstream https://sutian.moe.edu.tw/zh-hant/su/2341/
    // confirms "hònn-kheh"; this example has "hòonn-kheh" (extra "o").
    'data/dictionary/ptck/4.txt#%u5E84%u982D d[0].e[0]',
    '7dfd88dd755d',
  ],
  [
    // 代誌 (su/1370): upstream https://sutian.moe.edu.tw/zh-hant/su/1370/
    // confirms "tāi-tsì"; this example has "tāi-ts" (truncated).
    'data/dictionary/ptck/67.txt#%u5FC3%u706B d[0].e[0]',
    '153720d1943b',
  ],
  [
    // 深 example: stray trailing "2" (footnote-marker-shaped artifact) with
    // no corresponding syllable — not a reading error, just orphaned text.
    'data/dictionary/ptck/113.txt#%u6DF1 d[1].e[1]',
    'd01113d3143a',
  ],
  [
    // 做議量 example: stray trailing "(" with nothing after it — an
    // unclosed/orphaned parenthesis, not a reading error.
    'data/dictionary/ptck/90.txt#%u505A%u8B70%u91CF d[0].e[0]',
    '290fbc797cdf',
  ],
]);

let failures = 0;
let allowlisted = 0;

function fail(source, trs, message) {
  if (KNOWN_DATA_ISSUES.get(source) === computeTrsHash(trs)) {
    allowlisted++;
    console.warn(`[check-trs-bpmf] KNOWN DATA ISSUE (allowlisted, see script header): ${message}`);
    return;
  }
  console.error(`[check-trs-bpmf] FAIL: ${message}`);
  failures++;
}

function listTxtFiles(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.txt'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// Matches the same ￹han￺trs￻mandarin interlinear-annotation triplets that
// DictionaryPage.tsx's convertTaiwaneseRubyMarkers consumes at render time.
const IAA_RE = /\uFFF9([\s\S]*?)\uFFFA([\s\S]*?)(?:\uFFFB([\s\S]*?))?(?=\uFFF9|$)/g;

// --- Single pass over the corpus: gather (1) every romanization string that
// flows through trsToBpmf in production (T fields + embedded example/quote/
// link trs segments), and (2) every distinct character appearing in
// example-sentence hanzi text, for the check categories below. ---
const conversionJobs = []; // { source, trs }
const hanCharsFirstSeen = new Map(); // ch -> source

let totalFiles = 0;
let totalParsed = 0;

for (const file of listTxtFiles(PTCK_DIR)) {
  totalFiles++;
  const rel = path.relative(REPO_ROOT, file);
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`[check-trs-bpmf] FAIL: ${rel}: JSON.parse failed — ${e.message}`);
    failures++;
    continue;
  }
  totalParsed++;
  if (!data || typeof data !== 'object') continue;

  for (const [key, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.h)) continue;

    for (const het of entry.h) {
      if (!het || typeof het !== 'object') continue;

      if (typeof het.T === 'string' && het.T) {
        conversionJobs.push({ source: `${rel}#${key} T`, trs: het.T });
      }

      if (!Array.isArray(het.d)) continue;
      for (const [di, d] of het.d.entries()) {
        if (!d || typeof d !== 'object') continue;
        for (const field of ['e', 'quote', 'link']) {
          const raw = d[field];
          if (!raw) continue;
          const items = Array.isArray(raw) ? raw : [raw];
          for (const [ii, item] of items.entries()) {
            if (typeof item !== 'string') continue;
            for (const m of item.matchAll(IAA_RE)) {
              const han = m[1] || '';
              const trs = m[2] || '';
              const source = `${rel}#${key} d[${di}].${field}[${ii}]`;
              if (trs) conversionJobs.push({ source, trs });
              for (const ch of han.replace(/[`~]/g, '')) {
                if (/\s/.test(ch)) continue;
                if (!hanCharsFirstSeen.has(ch)) hanCharsFirstSeen.set(ch, source);
              }
            }
          }
        }
      }
    }
  }
}

// --- Checks A/B/C: run every romanization string through the real
// decorateRuby pipeline (which calls trsToBpmf/applyTaigiSandhi internally)
// and validate what users actually see. ---
const LEFTOVER_LATIN_RE = /[A-Za-z]/;
const ORPHANED_MARK_RE = /(^|\s)[\u0300-\u036F]/;
// Mirrors trsToBpmf's own chunk-boundary regex — an independent syllable
// count derived straight from the input, not from anything the pipeline
// under test computed. NFD-normalized first: trsToBpmf/applyTaigiSandhi
// always operate on NFD text (applyTaigiSandhi normalizes internally), so a
// precomposed input character (e.g. NFC "ó") must be decomposed here too or
// it silently fails to match [A-Za-z], undercounting syllables.
const SYLLABLE_RE = /(?:[A-Za-z]|[\u0300-\u036F])+/gu;
const ZHUYIN_RTC_RE = /<rtc class="zhuyin"[^>]*>([\s\S]*?)<\/rtc>/;

for (const { source, trs } of conversionJobs) {
  let result;
  try {
    result = decorateRuby({ LANG: 't', trs });
  } catch (e) {
    fail(source, trs, `${source}: decorateRuby threw on ${JSON.stringify(trs)} — ${e.message}`);
    continue;
  }

  if (trs.trim() && !result.bopomofo.trim()) {
    fail(source, trs, `${source}: empty bopomofo output for non-empty input ${JSON.stringify(trs)}`);
  }

  for (const field of ['bopomofo', 'bAlt']) {
    const value = result[field];
    if (value && LEFTOVER_LATIN_RE.test(value)) {
      fail(
        source,
        trs,
        `${source}: leftover Latin letters in ${field} — unmapped syllable shape. ` +
          `input=${JSON.stringify(trs)} ${field}=${JSON.stringify(value)}`,
      );
    }
  }

  for (const field of ['bopomofo', 'bAlt', 'pinyin', 'pAlt']) {
    const value = result[field];
    if (value && ORPHANED_MARK_RE.test(value)) {
      fail(
        source,
        trs,
        `${source}: orphaned combining mark (detached from its base character) in ${field}. ` +
          `input=${JSON.stringify(trs)} ${field}=${JSON.stringify(value)}`,
      );
    }
  }

  // decorateRuby truncates `title`/`ruby` construction to the MAIN reading
  // only (bAlt/pAlt are extracted separately and never rendered as ruby),
  // so the expected count is scoped to trs.split('/')[0] too.
  const mainTrs = trs.split('/')[0].normalize('NFD');
  const expectedSyllables = (mainTrs.match(SYLLABLE_RE) || []).length;
  if (expectedSyllables > 0) {
    const rtcMatch = result.ruby.match(ZHUYIN_RTC_RE);
    const actualRtCount = rtcMatch ? (rtcMatch[1].match(/<rt(?:\s|>)/g) || []).length : 0;
    if (actualRtCount !== expectedSyllables) {
      fail(
        source,
        trs,
        `${source}: zhuyin <rtc> has ${actualRtCount} <rt> but the main reading has ` +
          `${expectedSyllables} syllable(s) — ruby2hruby pairs zhuyin <rt> to <rb> strictly by ` +
          `position, so this shifts every following syllable's annotation onto the wrong ` +
          `character. input=${JSON.stringify(trs)} ruby=${JSON.stringify(result.ruby)}`,
      );
    }
  }
}

// --- Check D: cross-check isRubyBasePunctuation against an independent
// Unicode-category classification for every character actually observed in
// example-sentence hanzi text. ---
const INDEPENDENT_PUNCT_LIKE_RE = /[\p{P}\p{S}\p{Z}]/u;

for (const [ch, source] of hanCharsFirstSeen) {
  const independentPunctLike = INDEPENDENT_PUNCT_LIKE_RE.test(ch);
  const currentlyExcluded = isRubyBasePunctuation(ch);
  if (independentPunctLike !== currentlyExcluded) {
    const codePoint = `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    console.error(
      `[check-trs-bpmf] FAIL: isRubyBasePunctuation disagrees with Unicode Punctuation/Symbol/` +
        `Separator for ${JSON.stringify(ch)} (${codePoint}, first seen ${source}): ` +
        `independent=${independentPunctLike} isRubyBasePunctuation=${currentlyExcluded}`,
    );
    failures++;
  }
}

console.log(
  `[check-trs-bpmf] ${totalParsed}/${totalFiles} pack files parsed, ` +
    `${conversionJobs.length} romanization strings converted, ` +
    `${hanCharsFirstSeen.size} distinct hanzi-portion characters cross-checked, ` +
    `${allowlisted} known data issue(s) allowlisted`,
);

if (failures > 0) {
  console.error(`\n[check-trs-bpmf] ${failures} failure(s).`);
  process.exit(1);
}
console.log('[check-trs-bpmf] OK');
