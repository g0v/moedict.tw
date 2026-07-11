import { PINYIN_MAP } from './pinyin-map';

type Lang = string;

function readLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function getPreferredSystem(lang: Lang): string {
  if (lang === 'a') return readLocalStorage('pinyin_a') || 'HanYu';
  if (lang === 't') return readLocalStorage('pinyin_t') || 'TL';
  if (lang === 'h') return readLocalStorage('pinyin_h') || 'TH';
  return '';
}

export function isParallelPinyin(lang: Lang): boolean {
  const system = getPreferredSystem(lang);
  if (lang === 'a') return /^HanYu-/.test(system);
  if (lang === 't') return /^TL-/.test(system);
  return false;
}

const DT_TONES: Record<string, string> = {
  '\u0300': '\u0332',
  '\u0301': '\u0300',
  '\u0302': '\u0306',
  '\u0304': '\u0304',
  '\u0305': '\u0305',
  '\u0306': '\u0301',
  '\u0307': '\u200B',
  '\u030D': '\u200B',
};

const DT_TONES_SANDHI: Record<string, string> = {
  '\u0300': '',
  '\u0332': '\u0300',
  '\u0306': '\u0304',
  '\u0304': '\u0332',
};

const PFS_TONE_MARK_MAP: Record<string, string> = {
  '\u00B2\u2074': '\u0302',
  '\u00B9\u00B9': '\u0300',
  '\u00B3\u00B9': '\u0301',
  '\u2075\u2075': '',
  '\u00B2': '',
  '\u2075': '\u030D',
};

function toneSandhi(segment: string): string {
  if (!/\w/.test(segment)) return segment;
  if (/[aeiou]r?[hptk]/i.test(segment)) {
    return segment.replace(/([aioue])/i, '$1\u0332');
  }
  if (!/[\u0300\u0332\u0306\u0304]/.test(segment)) {
    if (!/[aioue]/i.test(segment)) {
      return segment.replace(/([nm])/i, '$1\u0304');
    }
    return segment.replace(/([aioue])/i, '$1\u0304');
  }
  if (/[aeiou]\u0304r?[ptk]/i.test(segment)) {
    return segment.replace(/\u0304/g, '');
  }
  if (/[aeiou]\u0304r?h/i.test(segment)) {
    return segment.replace(/\u0304/g, '\u0300');
  }
  return segment.replace(/([\u0300\u0332\u0306\u0304])/g, (tone) => DT_TONES_SANDHI[tone]);
}

function tonePoj(segment: string): string {
  const toneMatch = segment.match(/([\u0300-\u0302\u0304\u0306\u0307\u030D])/);
  if (!toneMatch) return segment;

  const tone = toneMatch[1];
  let noTone = segment.replace(/[\u0300-\u0302\u0304\u0306\u0307\u030D]/g, '');
  if (/oa[inht]/i.test(noTone)) return noTone.replace(/(oa)([inht])/i, `$1${tone}$2`);
  if (/oeh/i.test(noTone)) return noTone.replace(/(oe)(h)/i, `$1${tone}$2`);
  if (/o/i.test(noTone)) return noTone.replace(/(o)/i, `$1${tone}`);
  if (/e/i.test(noTone)) return noTone.replace(/(e)/i, `$1${tone}`);
  if (/a/i.test(noTone)) return noTone.replace(/(a)/i, `$1${tone}`);
  if (/u/i.test(noTone)) return noTone.replace(/(u)/i, `$1${tone}`);
  if (/i/i.test(noTone)) return noTone.replace(/(i)/i, `$1${tone}`);
  if (/ng/i.test(noTone)) return noTone.replace(/(n)(g)/i, `$1${tone}$2`);
  if (/m/i.test(noTone)) return noTone.replace(/(m)/i, `$1${tone}`);
  noTone += tone;
  return noTone;
}

function toneToPfs(segment: string): string {
  const parts = segment.split(/([\u00B9\u00B2\u00B3\u2074\u2075]+)/);
  if (parts.length < 2) return segment;
  const syllable = parts[0];
  const tone = parts[1];
  const mark = PFS_TONE_MARK_MAP[tone];
  if (mark === undefined) return segment;

  const vowels = ['o', 'e', 'a', 'u', 'i', '\u1E73', 'n', 'm'];
  for (const vowel of vowels) {
    const pos = syllable.indexOf(vowel);
    if (pos >= 0) {
      const before = syllable.slice(0, pos + 1);
      const after = syllable.slice(pos + 1);
      return `${before}${mark}${after} `;
    }
  }
  return segment;
}

function thToPfs(input: string): string {
  const normalized = input
    .replace(/t/g, 'th')
    .replace(/p/g, 'ph')
    .replace(/k/g, 'kh')
    .replace(/c/g, 'chh')
    .replace(/b/g, 'p')
    .replace(/d/g, 't')
    .replace(/g/g, 'k')
    .replace(/nk/g, 'ng')
    .replace(/j/g, 'ch')
    .replace(/q/g, 'chh')
    .replace(/x/g, 's')
    .replace(/z/g, 'ch')
    .replace(/ii/g, '\u1E73')
    .replace(/ua/g, 'oa')
    .replace(/ue/g, 'oe')
    .replace(/\bi/g, 'y')
    .replace(/\by(\b|[ptk])h?/g, 'yi$1')
    .replace(/(i[ptk])h/g, '$1')
    .replace(/y([mn])/g, 'yi$1');

  const segs = normalized.split(/([^\u00B9\u00B2\u00B3\u2074\u2075]+[\u00B9\u00B2\u00B3\u2074\u2075]+)/);
  let result = '';
  for (const seg of segs) {
    if (!seg) continue;
    result += toneToPfs(seg);
  }
  return result.trim();
}

function convertPinyinT(yin: string, isBody = true): string {
  const system = getPreferredSystem('t');
  if (system === 'TL') return yin;

  if (/DT$/.test(system)) {
    let converted = yin
      .replace(/ph(\w)/g, 'PH$1')
      .replace(/b(\w)/g, 'bh$1')
      .replace(/p(\w)/g, 'b$1')
      .replace(/PH(\w)/g, 'p$1')
      .replace(/tsh/g, 'c')
      .replace(/ts/g, 'z')
      .replace(/th(\w)/g, 'TH$1')
      .replace(/t(\w)/g, 'd$1')
      .replace(/TH(\w)/g, 't$1')
      .replace(/kh(\w)/g, 'KH$1')
      .replace(/g(\w)/g, 'gh$1')
      .replace(/k(\w)/g, 'g$1')
      .replace(/KH(\w)/g, 'k$1')
      .replace(/j/g, 'r')
      .replace(/Ph(\w)/g, 'pH$1')
      .replace(/B(\w)/g, 'Bh$1')
      .replace(/P(\w)/g, 'B$1')
      .replace(/pH(\w)/g, 'P$1')
      .replace(/Tsh/g, 'C')
      .replace(/Ts/g, 'Z')
      .replace(/Th(\w)/g, 'tH$1')
      .replace(/T(\w)/g, 'D$1')
      .replace(/tH(\w)/g, 'T$1')
      .replace(/Kh(\w)/g, 'kH$1')
      .replace(/G(\w)/g, 'Gh$1')
      .replace(/K(\w)/g, 'G$1')
      .replace(/kH(\w)/g, 'K$1')
      .replace(/J/g, 'R')
      .replace(/o([^.!?,\w\s\u2011]*)o/g, 'O$1O')
      .replace(/o([^.!?,\w\s\u2011]*)(?![^\w\s\u2011]*[knm])/g, 'o$1r')
      .replace(/O([^\w\s\u2011]*)O/g, 'o$1')
      .replace(/O([^.!?,\w\s\u2011]*)o([^.!?,\w\s\u2011]*)r?/g, 'O$1$2')
      .replace(/([\u0300-\u0302\u0304\u0307\u030D])/g, (tone) => DT_TONES[tone])
      .replace(/([aeiou])(r?[ptkh])/g, '$1\u0304$2')
      .replace(/\u200B/g, '')
      .replace(/[-\u2011][-\u2011]([aeiou])(?![\u0300\u0332\u0306\u0304])/g, '$1\u030A')
      .replace(/[-\u2011][-\u2011](\u0101|a\u0304)/g, '\u2011\u2011a\u030A')
      .replace(/[-\u2011][-\u2011](\u014D|o\u0304)/g, '\u2011\u2011o\u030A')
      .replace(/[-\u2011][-\u2011](\u012B|i\u0304)/g, '\u2011\u2011i\u030A')
      .replace(/[-\u2011][-\u2011](\u0113|e\u0304)/g, '\u2011\u2011e\u030A')
      .replace(/[-\u2011][-\u2011](\u016B|u\u0304)/g, '\u2011\u2011u\u030A')
      .replace(/nn($|[-\s])/g, '\u207F$1');

    if (isBody) {
      converted = converted.replace(
        /((?:[^.,!?]*(?:\w[^-.,!?\w\s\u2011]*)[- \u2011])+)(\w)/g,
        (_, prefix: string, tail: string) => prefix.split(/([- \u2011.,!?])/).map((seg) => toneSandhi(seg)).join('') + tail,
      );
    } else {
      converted = converted.replace(
        /((?:\S*(?:\w[^\w\s\u2011]*)\u2011)+)(\w)/g,
        (_, prefix: string, tail: string) => prefix.split('\u2011').map((seg) => toneSandhi(seg)).join('\u2011') + tail,
      );
    }

    converted = converted.replace(/\u0332(\w*[ \u2011]a(?:[ -\u2011]|\u0300(?![-\w\u2011])))/g, '\u0304$1');
    converted = converted.replace(/\u0300(\w*[ \u2011]a(?:[ -\u2011]|\u0300(?![-\w\u2011])))/g, '$1');
    return converted;
  }

  const poj = yin
    .replace(/(o)([^.!?,\w\s\u2011]*)o/gi, '$1$2\u0358')
    .replace(/ts/g, 'ch')
    .replace(/Ts/g, 'Ch')
    .replace(/u([^\w\s\u2011.!?,-]*)a/g, 'o$1a')
    .replace(/u([^\w\s\u2011.!?,-]*)e/g, 'o$1e')
    .replace(/i([^\w\s\u2011.!?,-]*)k($|[-\u2011\s])/g, 'e$1k$2')
    .replace(/i([^\w\s\u2011.!?,-]*)ng/g, 'e$1ng')
    .replace(/nn($|[-\u2011\s])/g, '\u207F$1')
    .replace(/nnh($|[-\u2011\s])/g, 'h\u207F$1')
    .replace(/([ie])r/g, '$1\u0358')
    .replace(/\u030B/g, '\u0306');

  return poj.split(/([- \u2011.,!?])/).map((seg) => tonePoj(seg)).join('');
}

function convertPinyinH(yin: string): string {
  const system = getPreferredSystem('h');
  if (system === 'PFS') return thToPfs(yin);
  return yin;
}

function convertPinyinA(yin: string): string {
  const system = getPreferredSystem('a');
  const mapName = system.replace(/^HanYu-/, '');
  const map = PINYIN_MAP[mapName as keyof typeof PINYIN_MAP];
  if (!map) return yin;
  if (/\s/.test(yin)) {
    return yin
      .split(/\s+/)
      .map((token) => convertPinyinA(token))
      .join(' ');
  }

  let tone = 5;
  if (/[āōēīūǖ]/.test(yin)) tone = 1;
  if (/[áóéíúǘ]/.test(yin)) tone = 2;
  if (/[ǎǒěǐǔǚ]/.test(yin)) tone = 3;
  if (/[àòèìùǜ]/.test(yin)) tone = 4;

  let base = yin
    .replace(/[āáǎà]/g, 'a')
    .replace(/[ōóǒò]/g, 'o')
    .replace(/[ēéěè]/g, 'e')
    .replace(/[īíǐì]/g, 'i')
    .replace(/[ūúǔù]/g, 'u')
    .replace(/[üǖǘǚǜ]/g, 'v');

  let rSuffix = '';
  if (/^[^eēéěè].*r/.test(base)) {
    rSuffix = 'r';
    base = base.replace(/r$/, '');
  }

  base = map[base.replace(/\u200B/g, '') as keyof typeof map] || base;

  if (/a/.test(base)) base = base.replace(/a/, 'aāáǎàa'[tone]);
  else if (/o/.test(base)) base = base.replace(/o/, 'oōóǒòo'[tone]);
  else if (/e/.test(base)) base = base.replace(/e/, 'eēéěèe'[tone]);
  else if (/ui/.test(base)) base = base.replace(/i/, 'iīíǐìi'[tone]);
  else if (/u/.test(base)) base = base.replace(/u/, 'uūúǔùu'[tone]);
  else if (/ü/.test(base)) base = base.replace(/ü/, 'üǖǘǚǜü'[tone]);
  else base = base.replace(/i/, 'iīíǐìi'[tone]);

  return `${base}${rSuffix}`;
}

export function convertPinyinByLang(lang: Lang, source: string, isBody = true): string {
  const yin = String(source || '').replace(/-/g, '\u2011');
  if (!yin) return '';
  if (lang === 't') return convertPinyinT(yin, isBody);
  if (lang === 'h') return convertPinyinH(yin);
  if (lang === 'a') return convertPinyinA(yin);
  return yin;
}

const TAIWANESE_CONSONANTS: Record<string, string> = {
  p: 'ㄅ', b: 'ㆠ', ph: 'ㄆ', m: 'ㄇ',
  t: 'ㄉ', th: 'ㄊ', n: 'ㄋ', l: 'ㄌ',
  k: 'ㄍ', g: 'ㆣ', kh: 'ㄎ', ng: 'ㄫ',
  h: 'ㄏ', tsi: 'ㄐ', ji: 'ㆢ', tshi: 'ㄑ',
  si: 'ㄒ', ts: 'ㄗ', j: 'ㆡ', tsh: 'ㄘ', s: 'ㄙ',
};

const TAIWANESE_VOWELS: Record<string, string> = {
  a: 'ㄚ', an: 'ㄢ', ang: 'ㄤ', ann: 'ㆩ',
  oo: 'ㆦ', onn: 'ㆧ', o: 'ㄜ', e: 'ㆤ',
  enn: 'ㆥ', ai: 'ㄞ', ainn: 'ㆮ', au: 'ㄠ',
  aunn: 'ㆯ', am: 'ㆰ', om: 'ㆱ', m: 'ㆬ',
  ong: 'ㆲ', ng: 'ㆭ', i: 'ㄧ', inn: 'ㆪ',
  u: 'ㄨ', unn: 'ㆫ', ing: 'ㄧㄥ', in: 'ㄧㄣ', un: 'ㄨㄣ',
};

const TAIWANESE_TONES: Record<string, string> = {
  p: 'ㆴ', t: 'ㆵ', k: 'ㆶ', h: 'ㆷ',
  // Tone 8 (checked, high-level) is marked with U+0307 COMBINING DOT ABOVE —
  // not U+030D (the Tai-lo input mark) or U+0358 (a legacy output choice
  // that renders skewed/detached in many fonts; g0v/moedict-webkit#300).
  // This is the single source of truth: every consumer (ruby, bAlt/pAlt
  // alt-reading text) reads this table, so fixing it here fixes all of them.
  'p$': 'ㆴ\u0307', 't$': 'ㆵ\u0307', 'k$': 'ㆶ\u0307', 'h$': 'ㆷ\u0307',
  '\u0300': '˪', '\u0301': 'ˋ', '\u0302': 'ˊ', '\u0304': '˫', '\u030D': '$',
  // "Tone 9" (U+030B COMBINING DOUBLE ACUTE ACCENT) marks a 合音 (hi̍p-im,
  // fused/contracted-syllable) reading — e.g. 查某 tsa-bóo contracting to
  // tsa̋u — flattened into the T-field slash-alt-reading format by the
  // moedict-process twblg merge (AGENTS.md「又音.csv」的類型 2/3). It isn't
  // one of the standard 7 lexical tones and legacy view.ls's own trs2bpmf
  // never handled it either (only its POJ path remaps U+030B->U+0306) — so
  // there's no prior bopomofo convention to match. Passed through as-is
  // rather than mapped to a fabricated standard tone. The trailing \uFFFD
  // is the same "toneless syllable boundary" sentinel tone-1 uses below —
  // required because U+030B is a combining mark, not one of the spacing
  // tone letters (ˇˊˋ˪˫) or checked finals (ㆴㆵㆶㆷ) that
  // bopomofo-pinyin-utils.ts's decorateRuby spacing regex inserts a
  // syllable-boundary space after; without it this syllable's bopomofo
  // fuses into the next one and desyncs the ruby <rb>/<rt> token count.
  '\u030B': '\u030B\uFFFD',
};

const V_RE = new RegExp(Object.keys(TAIWANESE_VOWELS).sort((a, b) => b.length - a.length).join('|'), 'g');
const CV_RE = new RegExp(`^(${Object.keys(TAIWANESE_CONSONANTS).sort((a, b) => b.length - a.length).join('|')})((?:${Object.keys(TAIWANESE_VOWELS).sort((a, b) => b.length - a.length).join('|')})+[ptkh]?)$`);

// TL combining tone marks. Tone 1 (open) and tone 4 (checked) are unmarked.
const TL_TONE_RE = /[\u0300\u0301\u0302\u0304\u030B\u030D]/;
const TL_TONE_RE_GLOBAL = /[\u0300\u0301\u0302\u0304\u030B\u030D]/g;

// Citation -> sandhi tone mapping for open syllables, in TL combining marks:
//   tone 1 (no mark)  -> tone 7 (U+0304 macron)
//   tone 2 (U+0301)   -> tone 1 (no mark)
//   tone 3 (U+0300)   -> tone 2 (U+0301)
//   tone 5 (U+0302)   -> tone 7 (U+0304) [Taiwan southern variety; MoE convention]
//   tone 7 (U+0304)   -> tone 3 (U+0300)
// Tone 9 / 合音 (U+030B) has no defined sandhi rule and is deliberately
// absent here: applyTaigiSandhiToSyllable's `newTone === undefined` branch
// leaves it as citation form unconditionally (same fallback already used
// for a bare tone-8 U+030D on a non-checked syllable — see the "leaves an
// open-syllable carrying tone-8 mark... unchanged" test).
const TL_OPEN_SANDHI: Record<string, string> = {
  '': '\u0304',
  '\u0301': '',
  '\u0300': '\u0301',
  '\u0302': '\u0304',
  '\u0304': '\u0300',
};

// Additional tone-group boundaries beyond sentence punctuation, verified
// exhaustively against the full ptck corpus (see scripts/check-trs-bpmf.mjs):
//   /  — separates a heteronym's alternate T-field readings (AGENTS.md「T
//        欄的斜線慣例」), e.g. "tsi̍t-ji̍t/tsi̍t-li̍t". Each side is an
//        independent citation-form pronunciation and needs its own sandhi.
//   、 — ideographic comma used the same way as ，within a few T fields.
//   ── — doubled U+2500 BOX DRAWINGS LIGHT HORIZONTAL, used as a xiehouyu
//        (歇後語) riddle/punchline dash in example sentences and T fields
//        (e.g. 反種 "Kiô-á khui n̂g-hue──huán-tsíng."). Without this, the
//        tokenizer below merges the syllable before and after the dash into
//        one corrupted token, dropping or misplacing tone-8 marks
//        (g0v/moedict-webkit#300) across the dash (g0v/moedict-webkit#299).
// Unlike the "--" (doubled ASCII hyphen) light-tone-particle marker handled
// in sandhiToneGroup, each side of these boundaries gets full independent
// sandhi treatment — they are not a "freeze the remainder" marker.

const PHRASE_BOUNDARY_RE = /(──|[/、.!?;:,\uFF0C\u3002\uFF01\uFF1F\uFF1B\uFF1A])/;

// Place a TL combining tone mark using TL placement priority: a > o > e >
// second of an i/u cluster > i/u > ng (mark sits between n and g). Lone
// syllabic m or n falls through to the trailing-append branch \u2014 for those
// shapes `insertAt(0)` and `syllable + mark` produce the same string, so a
// single fall-through covers them. Bopomofo conversion only inspects the
// mark's identity, but correct placement keeps the helper usable for
// romanization-level rendering. Caller passes a syllable without TL tone
// marks and a non-empty mark.
function placeTlToneMark(syllable: string, mark: string): string {
  const insertAt = (pos: number) => `${syllable.slice(0, pos + 1)}${mark}${syllable.slice(pos + 1)}`;
  const a = syllable.search(/[aA]/);
  if (a >= 0) return insertAt(a);
  const o = syllable.search(/[oO]/);
  if (o >= 0) return insertAt(o);
  const e = syllable.search(/[eE]/);
  if (e >= 0) return insertAt(e);
  const cluster = syllable.search(/[iIuU][iIuU]/);
  if (cluster >= 0) return insertAt(cluster + 1);
  const iu = syllable.search(/[iIuU]/);
  if (iu >= 0) return insertAt(iu);
  const ng = syllable.search(/[nN][gG]/);
  if (ng >= 0) return insertAt(ng);
  return syllable + mark;
}

function applyTaigiSandhiToSyllable(segment: string): string {
  // Caller (sandhiTokenSequence) guarantees the segment contains an ASCII letter.
  const toneMatch = segment.match(TL_TONE_RE);
  const tone = toneMatch ? toneMatch[0] : '';
  const checkedMatch = segment.match(/[ptkhPTKH]$/);

  if (checkedMatch) {
    const ending = checkedMatch[0].toLowerCase();
    if (ending === 'h') {
      // Tone 4 (-h) -> tone 2 open: drop -h, place U+0301 acute on the vowel.
      if (tone === '') return placeTlToneMark(segment.slice(0, -1), '\u0301');
      // Tone 8 (U+030D + -h) -> tone 3 open: drop -h, replace U+030D with U+0300 grave.
      if (tone === '\u030D') {
        const stripped = segment.replace(TL_TONE_RE_GLOBAL, '').slice(0, -1);
        return placeTlToneMark(stripped, '\u0300');
      }
      return segment;
    }
    // -p / -t / -k endings.
    if (tone === '') return placeTlToneMark(segment, '\u030D'); // tone 4 -> tone 8
    if (tone === '\u030D') return segment.replace(TL_TONE_RE_GLOBAL, ''); // tone 8 -> tone 4
    return segment;
  }

  // Open syllable.
  const newTone = TL_OPEN_SANDHI[tone];
  if (newTone === undefined) return segment;
  if (tone === '') return placeTlToneMark(segment, newTone);
  // For tone 2 (newTone === ''), this collapses to stripping the U+0301 mark.
  return segment.replace(tone, newTone);
}

function sandhiTokenSequence(phrase: string): string {
  // Tokens alternate between word chunks and single-character separators
  // (ASCII hyphen / U+2011 non-breaking hyphen / space). Splitting on a
  // single-char class means consecutive separators emit empty word chunks
  // between them; downstream filters short-circuit on those.
  const tokens = phrase.split(/([- \u2011])/);
  // Find the index of the last alphabetic token (the tone group's "head" \u2014
  // the only syllable that keeps its citation tone). The sentinel
  // `tokens.length` marks "no alphabetic token in this phrase".
  let lastAlpha = tokens.length;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (/[a-zA-Z]/.test(tokens[i])) {
      lastAlpha = i;
      break;
    }
  }
  return tokens
    .map((tok, idx) => {
      if (idx >= lastAlpha) return tok;
      if (!/[a-zA-Z]/.test(tok)) return tok;
      return applyTaigiSandhiToSyllable(tok);
    })
    .join('');
}

function sandhiToneGroup(group: string): string {
  // A double hyphen ends the main tone group; the syllable directly before "--"
  // keeps its citation tone, and trailing light-tone particles after "--" do not
  // undergo sandhi either.
  const dashIdx = group.search(/[-\u2011][-\u2011]/);
  if (dashIdx >= 0) {
    return sandhiTokenSequence(group.slice(0, dashIdx)) + group.slice(dashIdx);
  }
  return sandhiTokenSequence(group);
}

export function applyTaigiSandhi(trs: string): string {
  if (!trs) return trs;
  // PHRASE_BOUNDARY_RE is a capture-group split, so odd indices are the
  // captured boundary tokens (single-char punctuation, "/", "、", or the
  // two-char "──" xiehouyu dash). Even indices are tone-group bodies.
  // Stryker disable next-line ConditionalExpression: the boundary tokens
  // captured at odd indices (punctuation, "/", "、", "──") have no
  // alphabetic content, so calling sandhiToneGroup on them is observationally
  // a no-op. The "always sandhi" mutant is therefore equivalent.
  return trs
    .normalize('NFD')
    .split(PHRASE_BOUNDARY_RE)
    .map((part, idx) => (idx % 2 === 0 ? sandhiToneGroup(part) : part))
    .join('');
}

export function trsToBpmf(lang: Lang, trs: string): string {
  if (lang === 'h') return ' ';
  if (lang === 'a' || lang === 'c') return trs;

  const input = String(trs || '');
  const sandhiPref = readLocalStorage('bopomofo_sandhi_t');
  const source = sandhiPref === 'off' ? input : applyTaigiSandhi(input);

  return source
    .replace(/(?:[A-Za-z]|[\u0300-\u030D])+/gu, (chunk) => {
      let tone = '';
      let token = chunk.toLowerCase();
      token = token.replace(/([\u0300-\u0302\u0304\u030B\u030D])/g, (mark) => {
        tone = TAIWANESE_TONES[mark];
        return '';
      });
      token = token.replace(/^(tsh?|[sj])i/, '$1ii');
      token = token.replace(/ok$/, 'ook');
      token = token.replace(/op$/, 'oop');
      token = token.replace(CV_RE, (_, consonant: string, rest: string) => `${TAIWANESE_CONSONANTS[consonant]}${rest}`);
      token = token.replace(/[ptkh]$/, (ending) => {
        tone = TAIWANESE_TONES[`${ending}${tone}`] || tone;
        return '';
      });
      token = token.replace(V_RE, (vowel) => TAIWANESE_VOWELS[vowel]);
      return token + (tone || '\uFFFD');
    })
    .replace(/[-\s]/g, '')
    .replace(/\uFFFD/g, ' ')
    .replace(/[.?!,] ?/g, '');
}
