/**
 * 注音符號（Zhuyin）查詢工具
 *
 * 對應 issue g0v/moedict-webkit#92「非漢字搜尋」第二項需求：
 * 「注音符號搜尋」。第一項需求（台語羅馬字／客語羅馬字搜尋）已由
 * searchbox.tsx 的 TL/DT/POJ、TH/PFS 專用查詢管道涵蓋；本檔只補上
 * 標準（華語）注音符號輸入的支援。
 *
 * 策略：把使用者輸入的注音符號序列轉換成對應的（無聲調）漢語拼音字串，
 * 之後直接餵給既有的 `/api/lookup/pinyin/a/HanYu` 查詢管線
 * （見 searchbox.tsx 的 fetchHanYuPinyinLookupTerms）。這樣完全不需要
 * 新增伺服器端資料或索引——拼音索引本來就是由每筆詞條的 `p`
 * （拼音）欄位建置，而 `b`（注音）欄位是同一批資料的另一種表示法，
 * 兩者一一對應，所以「注音→拼音」轉換走的是既有、已驗證過的查詢路徑。
 *
 * 轉換規則對照教育部標準注音符號／漢語拼音拼寫規則（介音+韻母的特殊
 * 拼法，如 ㄨㄥ 接聲母時拼作 ong 而非 uong、ㄩㄥ 拼作 iong 等）。
 */

const INITIAL_MAP: Record<string, string> = {
  ㄅ: "b",
  ㄆ: "p",
  ㄇ: "m",
  ㄈ: "f",
  ㄉ: "d",
  ㄊ: "t",
  ㄋ: "n",
  ㄌ: "l",
  ㄍ: "g",
  ㄎ: "k",
  ㄏ: "h",
  ㄐ: "j",
  ㄑ: "q",
  ㄒ: "x",
  ㄓ: "zh",
  ㄔ: "ch",
  ㄕ: "sh",
  ㄖ: "r",
  ㄗ: "z",
  ㄘ: "c",
  ㄙ: "s",
};

// 零聲母的捲舌／舌尖聲母：無介音、無韻母時對應「空韻」（-i），
// 如 ㄓ→zhi、ㄙ→si。
const EMPTY_RIME_INITIALS: Record<string, true> = {
  ㄓ: true,
  ㄔ: true,
  ㄕ: true,
  ㄖ: true,
  ㄗ: true,
  ㄘ: true,
  ㄙ: true,
};

// 無聲母、無介音的單獨韻母（如 ㄚ→a、ㄦ→er）；有聲母但無介音時
// 直接把聲母拼音接上這裡的值即可（如 ㄍ+ㄢ→gan）。
const BARE_FINAL_MAP: Record<string, string> = {
  ㄚ: "a",
  ㄛ: "o",
  ㄜ: "e",
  ㄝ: "e",
  ㄞ: "ai",
  ㄟ: "ei",
  ㄠ: "ao",
  ㄡ: "ou",
  ㄢ: "an",
  ㄣ: "en",
  ㄤ: "ang",
  ㄥ: "eng",
  ㄦ: "er",
};

// 有聲母時，介音＋韻母的特殊拼法（''鍵＝介音單獨作韻母使用）。
const WITH_INITIAL_MEDIAL_TABLE: Record<string, Record<string, string>> = {
  ㄧ: {
    "": "i",
    ㄚ: "ia",
    ㄛ: "io",
    ㄝ: "ie",
    ㄠ: "iao",
    ㄡ: "iu",
    ㄢ: "ian",
    ㄣ: "in",
    ㄤ: "iang",
    ㄥ: "ing",
  },
  ㄨ: {
    "": "u",
    ㄚ: "ua",
    ㄛ: "uo",
    ㄞ: "uai",
    ㄟ: "ui",
    ㄢ: "uan",
    ㄣ: "un",
    ㄤ: "uang",
    ㄥ: "ong",
  },
  ㄩ: {
    "": "u",
    ㄝ: "ue",
    ㄢ: "uan",
    ㄣ: "un",
    ㄥ: "iong",
  },
};

// 無聲母（介音本身即為聲母角色）時的完整拼法。
const STANDALONE_MEDIAL_TABLE: Record<string, Record<string, string>> = {
  ㄧ: {
    "": "yi",
    ㄚ: "ya",
    ㄛ: "yo",
    ㄝ: "ye",
    ㄞ: "yai",
    ㄠ: "yao",
    ㄡ: "you",
    ㄢ: "yan",
    ㄣ: "yin",
    ㄤ: "yang",
    ㄥ: "ying",
  },
  ㄨ: {
    "": "wu",
    ㄚ: "wa",
    ㄛ: "wo",
    ㄞ: "wai",
    ㄟ: "wei",
    ㄢ: "wan",
    ㄣ: "wen",
    ㄤ: "wang",
    ㄥ: "weng",
  },
  ㄩ: {
    "": "yu",
    ㄝ: "yue",
    ㄢ: "yuan",
    ㄣ: "yun",
    ㄥ: "yong",
  },
};

const INITIAL_RE_SOURCE = "[\u3105-\u3119]";
const MEDIAL_RE_SOURCE = "[\u3127-\u3129]";
// \u312D = ㄭ，注音鍵盤上顯式輸入的「空韻」符號（罕見，如純打 zi/si 的空韻）。
const FINAL_RE_SOURCE = "[\u311A-\u3126\u312D]";
const NEUTRAL_TONE = "\u02D9"; // ˙
const TONE_MARK_RE_SOURCE = "[\u02CA\u02C7\u02CB]"; // ˊˇˋ（一聲不標調）

// 逐音節掃描：˙?（聲母 介音? 韻母?｜介音 韻母?｜韻母）調號?
const SYLLABLE_RE = new RegExp(
  `${NEUTRAL_TONE}?(?:${INITIAL_RE_SOURCE}${MEDIAL_RE_SOURCE}?${FINAL_RE_SOURCE}?|${MEDIAL_RE_SOURCE}${FINAL_RE_SOURCE.replace("\u312D", "")}?|${FINAL_RE_SOURCE})${TONE_MARK_RE_SOURCE}?`,
  "gu",
);

// 輸入整體檢查：僅允許標準注音符號（\u3105-\u3129）、空韻符號（ㄭ）、
// 調號與空白；台語/客語方音符號（\u31A0-\u31BF 擴充區）刻意不在此列，
// 因為那套系統的聲介韻組合規則不同，且台語/客語羅馬字搜尋已由
// searchbox.tsx 既有的 TL/DT/POJ、TH/PFS 管道處理。
const PURE_BOPOMOFO_RE = /^[\u02D9\u02CA\u02C7\u02CB\u3105-\u3129\u312D\s]+$/u;
const HAS_PHONETIC_SYMBOL_RE = /[\u3105-\u3129\u312D]/u;

/**
 * 判斷輸入是否為「純注音符號」查詢（可含調號與空白，但不可混雜漢字、
 * 拉丁字母等其他字元）。
 */
export function isPureBopomofoQuery(input: string): boolean {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return false;
  return PURE_BOPOMOFO_RE.test(trimmed) && HAS_PHONETIC_SYMBOL_RE.test(trimmed);
}

function splitSyllable(core: string): { initial: string; medial: string; final: string } | null {
  let rest = core;
  let initial = "";
  if (rest && INITIAL_MAP[rest[0]]) {
    initial = rest[0];
    rest = rest.slice(1);
  }

  let medial = "";
  if (rest && (rest[0] === "ㄧ" || rest[0] === "ㄨ" || rest[0] === "ㄩ")) {
    medial = rest[0];
    rest = rest.slice(1);
  }

  if (rest.length > 1) return null;
  const final = rest;
  return { initial, medial, final };
}

/**
 * 把單一注音音節（已去除調號，如 "ㄓㄨㄥ"、"ㄅㄚ"、"ㄕ"）轉成對應的
 * （無聲調）漢語拼音字串；輸入不合法的組合回傳 null。
 */
export function bopomofoSyllableToPinyin(syllableCore: string): string | null {
  const parsed = splitSyllable(syllableCore);
  if (!parsed) return null;
  const { initial, medial, final } = parsed;

  if (medial) {
    const table = initial ? WITH_INITIAL_MEDIAL_TABLE[medial] : STANDALONE_MEDIAL_TABLE[medial];
    const rime = table[final];
    if (!rime) return null;
    return initial ? INITIAL_MAP[initial] + rime : rime;
  }

  if (!final || final === "ㄭ") {
    if (initial && EMPTY_RIME_INITIALS[initial]) {
      return INITIAL_MAP[initial] + "i";
    }
    return null;
  }

  const rime = BARE_FINAL_MAP[final];
  if (!rime) return null;
  return initial ? INITIAL_MAP[initial] + rime : rime;
}

/**
 * 把一段注音符號查詢（可含多個音節、調號、空白）轉換成以空白分隔的
 * 無聲調漢語拼音字串（如 "ㄌㄠˇ˙ㄕ" → "lao shi"），可直接餵給既有的
 * HanYu 拼音查詢管線。輸入不是合法的純注音查詢，或任何一個音節無法
 * 對應到有效拼音，則回傳 null。
 */
export function convertBopomofoQueryToPinyin(input: string): string | null {
  if (!isPureBopomofoQuery(input)) return null;

  const words = String(input).trim().split(/\s+/).filter(Boolean);
  const syllables: string[] = [];

  for (const word of words) {
    let consumed = 0;
    SYLLABLE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SYLLABLE_RE.exec(word))) {
      if (match.index !== consumed || match[0].length === 0) return null;
      consumed += match[0].length;

      const core = match[0].replace(NEUTRAL_TONE, "").replace(new RegExp(TONE_MARK_RE_SOURCE), "");
      const pinyin = bopomofoSyllableToPinyin(core);
      if (!pinyin) return null;
      syllables.push(pinyin);
    }
    if (consumed !== word.length) return null;
  }

  return syllables.length > 0 ? syllables.join(" ") : null;
}
