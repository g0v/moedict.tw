import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { useRadicalTooltip } from "../hooks/useRadicalTooltip";
import { useStrokeAvailability } from "../hooks/useStrokeAvailability";
import { cleanTextForTTS, speakText } from "../utils/tts-utils";
import { getAudioUrl, playAudioUrl } from "../utils/audio-utils";
import { AUDIO_CDN_MAP } from "../utils/media-cdn";
import { rightAngle } from "../utils/ruby2hruby";
import { decorateRuby } from "../utils/bopomofo-pinyin-utils";
import { convertPinyinByLang } from "../utils/pinyin-preference-utils";
import {
  addStarWord,
  addToLRU,
  getStarredStorageKey,
  hasStarWord,
  removeStarWord,
  writeLastLookup,
} from "../utils/word-record-utils";
import { fetchDictionaryEntry, readCachedDictionaryEntry } from "../utils/dictionary-cache";
import { writeTextToClipboard } from "../utils/clipboard";
import { setCurrentXrefs } from "../utils/xref-switch-utils";
import { StrokeAnimation } from "../components/StrokeAnimation";
import { applyHeadToDocument, getDictionaryHead } from "../ssr/head";
import { CharacterImageView } from "../components/CharacterImageView";
import { SvgIcon } from "../components/SvgIcon";
import { TitlePronunciation } from "../components/TitlePronunciation";
import { dedupeHeteronyms } from "../utils/heteronym-dedup";
import { sortHeteronymsBySubstitutionReading } from "../utils/heteronym-order";

export type DictionaryLang = "a" | "t" | "h" | "c";

interface Definition {
  type?: string;
  def?: string;
  example?: string[] | string;
  quote?: string[] | string;
  link?: string[] | string;
  synonyms?: string[] | string;
  antonyms?: string[] | string;
}

interface Heteronym {
  id?: string;
  bopomofo?: string;
  pinyin?: string;
  trs?: string;
  alt?: string;
  variants?: string[];
  audio_id?: string;
  synonyms?: string[] | string;
  /** TWBLG 文/白/俗/替讀音分類（g0v/moedict-webkit#96、#233），僅 lang='t' 有值；
   *  API 回傳時已包成 autolink 的 `<a href="...">文</a>`，渲染前需 untag。 */
  reading?: string;
  definitions?: Definition[];
}

interface DictionaryAPIResponse {
  title?: string;
  heteronyms?: Heteronym[];
  radical?: string;
  stroke_count?: number;
  non_radical_stroke_count?: number;
  translation?: Record<string, string | string[]>;
  English?: string | string[];
  Deutsch?: string | string[];
  francais?: string | string[];
  xrefs?: Array<{ lang: DictionaryLang; words: string[] }>;
  xrefsByHeteronym?: Array<{ lang: DictionaryLang; byId: Record<string, string[]> }>;
}

interface DictionaryErrorResponse {
  message?: string;
  terms?: string[];
}

interface DictionaryState {
  loading: boolean;
  entry: DictionaryAPIResponse | null;
  terms: string[];
  error: string | null;
}

interface CnsAttributes {
  phonetic?: string[];
  radical?: { id: number; char: string | null };
  stroke?: number;
  cangjie?: string[];
  strokeSequence?: string;
  source?: string;
}

interface CnsRecord {
  char: string;
  unicode: string;
  codepoint: number;
  cns: string;
  pua: boolean;
  attributes: CnsAttributes;
}

interface CnsFallbackState {
  loading: boolean;
  record: CnsRecord | null;
  error: boolean;
}

interface DictionaryPageProps {
  word?: string;
  lang: DictionaryLang;
  /** 1-based index into the flat (ungrouped, cross-heteronym) definitions
   *  list — legacy /word/N definition-index permalink (g0v/moedict.tw#131). */
  idx?: number;
}

// 內容中「可查字」的逐字連結。必須與 InlineStyles.tsx 的長按選字 CSS 選擇器保持一致。
const CONTENT_LOOKUP_LINK_SELECTOR =
  ".def a, .definition a, .example a, .mandarin a, .quote a, .link a";
const LONG_PRESS_MIN_DURATION_MS = 320;
const LONG_PRESS_SUPPRESS_CLICK_MS = 450;

function groupDefinitions(definitions: Definition[]): Map<string, Definition[]> {
  const grouped = new Map<string, Definition[]>();
  for (const definition of definitions) {
    const key = String(definition.type || "");
    const list = grouped.get(key) ?? [];
    list.push(definition);
    grouped.set(key, list);
  }
  return grouped;
}

function splitPartOfSpeech(typeText: string): string[] {
  if (!typeText) return [];
  return typeText
    .split(",")
    .map((tag) => untag(tag).trim())
    .filter(Boolean);
}

function toStringArray(value: string[] | string | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
}

function splitCommaSeparatedItems(value: string[] | string | undefined): string[] {
  return toStringArray(value)
    .flatMap((item) => String(item || "").split(/,+/))
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeHref(rawHref: string): string | null {
  const href = rawHref.trim();
  if (!href) return null;
  if (/^(?:https?:|mailto:|tel:)/i.test(href)) return null;
  if (href.startsWith("/")) return href;

  let token = href;
  token = token.replace(/^\.\//, "");
  token = token.replace(/^#/, "");
  token = token.trim();
  if (!token) return null;
  return `/${token}`;
}

function hasActiveSelection(): boolean {
  const selection = window.getSelection();
  return selection != null && !selection.isCollapsed && selection.toString().trim().length > 0;
}

function isContentLookupAnchor(anchor: HTMLAnchorElement): boolean {
  return anchor.matches(CONTENT_LOOKUP_LINK_SELECTOR);
}

function untag(input: string): string {
  return input.replace(/<[^>]*>/g, "");
}

function escapeHtml(input: string): string {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTranslation(value: string[] | string): string {
  return untag(Array.isArray(value) ? value.join(", ") : value);
}

function formatExampleIcon(input: string): string {
  return input.replace("例⃝", '<span class="specific">例</span>');
}

function previewDebugText(input: string, max = 120): string {
  const normalized = String(input || "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function convertTaiwaneseRubyMarkers(input: string): string {
  const source = String(input || "");
  if (!source.includes("\uFFF9")) return source;

  let markerCount = 0;
  const converted = source.replace(
    /\uFFF9([\s\S]*?)\uFFFA([\s\S]*?)(?:\uFFFB([\s\S]*?))?(?=\uFFF9|$)/g,
    (_match, han, trs, mandarin) => {
      markerCount += 1;
      const mandarinPart = mandarin ? `<br><span class="rt mandarin">${mandarin}</span>` : "";
      return `<span class="ruby"><span class="rb"><span class="ruby"><span class="rb">${han}</span><br><span class="rt trs pinyin">${trs}</span></span></span></span>${mandarinPart}`;
    },
  );
  console.debug("[taiwanese-ruby] marker conversion", {
    markerCount,
    sourcePreview: previewDebugText(source),
    convertedPreview: previewDebugText(converted),
  });
  return converted;
}

function parseTaiwaneseRubyLine(
  rawHtml: string,
): { headingHtml: string; mandarinHtml: string | null } | null {
  const convertedHtml = convertTaiwaneseRubyMarkers(rawHtml);
  if (!convertedHtml || !/class\s*=\s*["'][^"']*\bruby\b/i.test(convertedHtml)) {
    console.debug("[taiwanese-ruby] no ruby node detected", {
      rawPreview: previewDebugText(rawHtml),
      convertedPreview: previewDebugText(convertedHtml),
    });
    return null;
  }
  if (typeof DOMParser === "undefined") return null;

  try {
    const sanitized = convertedHtml.replace(/<\/?b>/g, "");
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div id="wrap">${sanitized}</div>`, "text/html");
    const wrap = doc.getElementById("wrap");
    if (!wrap) return null;

    const titleHtml = wrap.querySelector(".ruby .ruby .rb")?.innerHTML?.trim() || "";
    const bopomofo = wrap.querySelector(".trs.pinyin")?.getAttribute("title") || "";
    const py = (
      wrap.querySelector(".upper")?.textContent ||
      wrap.querySelector(".trs.pinyin")?.textContent ||
      ""
    ).trim();
    if (!titleHtml) return null;

    const { ruby } = decorateRuby({
      LANG: "t",
      title: titleHtml,
      bopomofo: bopomofo || undefined,
      py: py || undefined,
    });
    const headingHtml = rightAngle(ruby);
    const mandarinHtml = wrap.querySelector(".mandarin")?.innerHTML?.trim() || null;
    console.debug("[taiwanese-ruby] parsed values", {
      titleHtml,
      py,
      bopomofo,
      mandarinHtml,
      rawPreview: previewDebugText(rawHtml),
    });
    return { headingHtml, mandarinHtml };
  } catch {
    console.debug("[taiwanese-ruby] parse failed", { rawPreview: previewDebugText(rawHtml) });
    return null;
  }
}

function getLangTokenPrefix(lang: DictionaryLang): string {
  if (lang === "t") return "'";
  if (lang === "h") return ":";
  if (lang === "c") return "~";
  return "";
}

function getLangName(lang: DictionaryLang): string {
  if (lang === "t") return "台語";
  if (lang === "h") return "客語";
  if (lang === "c") return "兩岸";
  return "華語";
}

function isSingleCharTerm(input: string): boolean {
  const plain = untag(String(input || ""))
    .replace(/\s+/g, "")
    .trim();
  return Array.from(plain).length === 1;
}

function normalizeXrefWord(word: string): string {
  return String(word || "")
    .trim()
    .replace(/[`~]/g, "");
}

interface HakkaReading {
  dialect: string;
  readingHtml: string;
  variant: number;
}

function formatHakkaReadingHtml(reading: string, convertForSi: boolean): string {
  const source = convertForSi ? convertPinyinByLang("h", reading, false) : reading;
  return escapeHtml(source)
    .replace(/¹/g, "<sup>1</sup>")
    .replace(/²/g, "<sup>2</sup>")
    .replace(/³/g, "<sup>3</sup>")
    .replace(/⁴/g, "<sup>4</sup>")
    .replace(/⁵/g, "<sup>5</sup>");
}

function parseHakkaReadings(rawPinyin: string, audioId?: string): HakkaReading[] {
  if (!audioId) return [];
  const source = String(rawPinyin || "");
  if (!source) return [];

  const readings: HakkaReading[] = [];
  const dialectOrder = "四海大平安南";
  const matcher = /([四海大平安南])[\u20DE\u20DF](\S+)/g;
  let match: RegExpExecArray | null = matcher.exec(source);

  while (match) {
    const dialect = match[1] || "";
    const reading = match[2] || "";
    const variant = dialectOrder.indexOf(dialect) + 1;
    if (dialect && reading && variant > 0) {
      readings.push({
        dialect,
        readingHtml: formatHakkaReadingHtml(reading, dialect === "四"),
        variant,
      });
    }
    match = matcher.exec(source);
  }

  return readings;
}

function getHakkaVariantAudioUrl(variant: number, audioId: string): string {
  return `${AUDIO_CDN_MAP.h}/${variant}-${audioId}.ogg`;
}

type TTSLabel = "英" | "德" | "法";

function XrefTranslationLine({ label, value }: { label: TTSLabel; value: string | string[] }) {
  const cleaned = cleanTextForTTS(value);
  const handleClick = (event: MouseEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    if (cleaned.trim()) speakText(label, cleaned);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (cleaned.trim()) speakText(label, cleaned);
    }
  };

  return (
    <div className="xref-line">
      <span className="fw_lang">{label}</span>
      <span
        className="fw_def"
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        {formatTranslation(value)}
      </span>
    </div>
  );
}

const CJK_RADICALS =
  "⼀一⼁丨⼂丶⼃丿⼄乙⼅亅⼆二⼇亠⼈人⼉儿⼊入⼋八⼌冂⼍冖⼎冫⼏几⼐凵⼑刀⼒力⼓勹⼔匕⼕匚⼖匸⼗十⼘卜⼙卩⼚厂⼛厶⼜又⼝口⼞囗⼟土⼠士⼡夂⼢夊⼣夕⼤大⼥女⼦子⼧宀⼨寸⼩小⼪尢⼫尸⼬屮⼭山⼮巛⼯工⼰己⼱巾⼲干⼳幺⼴广⼵廴⼶廾⼷弋⼸弓⼹彐⼺彡⼻彳⼼心⼽戈⼾戶⼿手⽀支⽁攴⽂文⽃斗⽄斤⽅方⽆无⽇日⽈曰⽉月⽊木⽋欠⽌止⽍歹⽎殳⽏毋⽐比⽑毛⽒氏⽓气⽔水⽕火⽖爪⽗父⽘爻⽙爿⺦丬⽚片⽛牙⽜牛⽝犬⽞玄⽟玉⽠瓜⽡瓦⽢甘⽣生⽤用⽥田⽦疋⽧疒⽨癶⽩白⽪皮⽫皿⽬目⽭矛⽮矢⽯石⽰示⽱禸⽲禾⽳穴⽴立⽵竹⽶米⽷糸⺰纟⽸缶⽹网⽺羊⽻羽⽼老⽽而⽾耒⽿耳⾀聿⾁肉⾂臣⾃自⾄至⾅臼⾆舌⾇舛⾈舟⾉艮⾊色⾋艸⾌虍⾍虫⾎血⾏行⾐衣⾑襾⾒見⻅见⾓角⾔言⻈讠⾕谷⾖豆⾗豕⾘豸⾙貝⻉贝⾚赤⾛走⾜足⾝身⾞車⻋车⾟辛⾠辰⾡辵⻌辶⾢邑⾣酉⾤釆⾥里⾦金⻐钅⾧長⻓长⾨門⻔门⾩阜⾪隶⾫隹⾬雨⾭靑⾮非⾯面⾰革⾱韋⻙韦⾲韭⾳音⾴頁⻚页⾵風⻛风⾶飛⻜飞⾷食⻠饣⾸首⾹香⾺馬⻢马⾻骨⾼高⾽髟⾾鬥⾿鬯⿀鬲⿁鬼⿂魚⻥鱼⻦鸟⿃鳥⿄鹵⻧卤⿅鹿⿆麥⻨麦⿇麻⿈黃⻩黄⿉黍⿊黑⿋黹⿌黽⻪黾⿍鼎⿎鼓⿏鼠⿐鼻⿑齊⻬齐⿒齒⻮齿⿓龍⻰龙⿔龜⻳龟⿕龠";

function normalizeRadicalChar(input: string): string {
  try {
    if (!input) return "";
    const raw = input.replace(/<[^>]*>/g, "");
    const idx = CJK_RADICALS.indexOf(raw);
    if (idx >= 0 && idx % 2 === 0) {
      const normalized = CJK_RADICALS.charAt(idx + 1) || raw;
      return normalized === "靑" ? "青" : normalized;
    }
    return raw === "靑" ? "青" : raw;
  } catch {
    return input === "靑" ? "青" : input || "";
  }
}

function RadicalGlyph({ char, lang }: { char: string; lang: DictionaryLang }) {
  const ch = normalizeRadicalChar(char);
  const radicalPrefix = lang === "c" ? "~" : lang === "t" ? "'" : "";
  const radicalToken = `${radicalPrefix}@${ch}`;
  return (
    <span className="glyph">
      <a
        title="部首檢索"
        className="xref"
        href={`./#${radicalToken}`}
        data-radical-id={radicalToken}
        style={{ color: "white" }}
      >
        {" "}
        {ch}
      </a>
    </span>
  );
}

/** 全字庫屬性後備卡 — 四部辭典皆無時顯示於 no-match 頁 */
function CnsAttributesPanel({ record }: { record: CnsRecord }) {
  const { attributes } = record;
  return (
    <div className="entry cns-attributes" data-source="cns11643">
      <div className="entry-item">
        <div className="cns-badge">全字庫屬性・無辭典釋義</div>
        <table className="cns-attr-table">
          <tbody>
            <tr>
              <th>字元</th>
              <td>
                {record.char}{" "}
                <span className="cns-meta">
                  {record.unicode}・CNS {record.cns}
                </span>
              </td>
            </tr>
            {attributes.phonetic && attributes.phonetic.length > 0 && (
              <tr>
                <th>注音</th>
                <td>{attributes.phonetic.join("、")}</td>
              </tr>
            )}
            {attributes.radical && (
              <tr>
                <th>部首</th>
                <td>
                  {attributes.radical.id}・{attributes.radical.char ?? ""}
                </td>
              </tr>
            )}
            {attributes.stroke != null && (
              <tr>
                <th>筆畫</th>
                <td>{attributes.stroke}</td>
              </tr>
            )}
            {attributes.cangjie && attributes.cangjie.length > 0 && (
              <tr>
                <th>倉頡</th>
                <td>{attributes.cangjie.join("、")}</td>
              </tr>
            )}
            {attributes.strokeSequence && (
              <tr>
                <th>筆順</th>
                <td className="cns-stroke-seq">{attributes.strokeSequence}</td>
              </tr>
            )}
            {attributes.source && (
              <tr>
                <th>來源</th>
                <td>{attributes.source}</td>
              </tr>
            )}
          </tbody>
        </table>
        <p className="cns-attribution">
          資料來源：
          <a href="https://www.cns11643.gov.tw" target="_blank" rel="noopener noreferrer">
            數位發展部 CNS11643 全字庫
          </a>
          ，政府資料開放授權條款第 1 版（OGDL-1.0）。
        </p>
      </div>
    </div>
  );
}
/**
 * Formats a `.example`/`.quote`/`.link` node whose taigi ruby line was
 * successfully parsed by `parseTaiwaneseRubyLine` (DOM shape:
 * `<div class="example"><span class="h1">…</span><span class="mandarin">…
 * </span></div>`, see the render logic below). The `.h1` span carries the
 * taigi hruby.rightangle structure (base characters + zhuyin/romanization
 * annotations); `.mandarin`, when present, is the plain-text Chinese
 * translation. `visibleText` already strips both `.romanization-selectable`
 * and `<zhuyin>` from `.h1`, leaving only the base characters (plus any
 * bare sentence-final punctuation, which lives as a text node directly
 * inside `.h1`'s `<hruby>`, not inside any `<ru>` — so it's kept exactly
 * where it appears, before the translation parenthesis).
 * Only `.example` gets the "例：" prefix — `.quote`/`.link` text already
 * carries its own citation/cross-reference framing in the source data.
 */
function formatExampleLikeNode(el: Element): string {
  const h1 = el.querySelector(":scope > .h1");
  if (!h1) return "";
  const headText = visibleText(h1).replace(/\s+/g, " ").trim();
  const mandarin = el.querySelector(":scope > .mandarin");
  const prefix = el.classList.contains("example") ? "例：" : "";
  if (!mandarin) return `${prefix}${headText}`;
  const translationText = visibleText(mandarin).replace(/\s+/g, " ").trim();
  return `${prefix}${headText}（${translationText}）`;
}

function visibleText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element)) return "";
  if (node.classList.contains("romanization-selectable")) return "";
  // <zhuyin> (wrapping <yin>/<diao>) carries real DOM text nodes for the
  // CJK-native phonetic annotation overlay -- unlike .romanization-
  // selectable (a CSS-generated-content stand-in with display:none
  // available per phonetics pref), <zhuyin> has no such class to key off
  // and always renders real text. Skip its subtree entirely; the sibling
  // <rb> (base character) is untouched.
  if (node.tagName === "ZHUYIN") return "";
  // Taiwanese example/quote/link nodes whose ruby line was parsed (see
  // parseTaiwaneseRubyLine below) get dedicated heading+translation
  // formatting instead of the generic recursive walk -- otherwise the
  // stripped .h1 taigi text and the separate .mandarin translation run
  // together with no visual separation between the two languages.
  if (
    (node.classList.contains("example") ||
      node.classList.contains("quote") ||
      node.classList.contains("link")) &&
    node.querySelector(":scope > .h1")
  ) {
    return `\n${formatExampleLikeNode(node)}`;
  }
  return Array.from(node.childNodes)
    .map((child) => {
      const text = visibleText(child);
      const isBlock =
        child instanceof Element && ["P", "DIV", "UL", "OL", "LI"].includes(child.tagName);
      return `${isBlock ? "\n" : ""}${text}`;
    })
    .join("");
}

/**
 * Whole-entry copy payload (#258 contract: ONE button, the whole visible
 * entry -- not per-heteronym buttons). Serializes EVERY heteronym on the
 * page (every `.entry` direct child of `.result`, e.g. it AND tsi̍t for
 * /'一) -- both heteronyms' groups were already in the payload pre-fix,
 * just unlabeled, which read as if the second reading were missing.
 * A `headword（reading）` header line is added UNCONDITIONALLY, once per
 * heteronym section -- single-heteronym entries (e.g. /萌 -> `萌（méng）`)
 * get it too, not just multi-heteronym pages. This is a deliberate,
 * single controlled leak of the romanization into the payload: it lives
 * ONLY in the header line, never inside the body (`reading` is never
 * read again below this point) -- the "romanization never leaks into the
 * copied Chinese DEFINITION text" contract from dictionary.spec.ts
 * "excluding controls and title romanization" still holds for the body,
 * scoped past the header line.
 */
function serializeDefinitionText(container: HTMLElement): string {
  const entries = Array.from(container.querySelectorAll(":scope > .entry"));
  return entries
    .map((entryEl) => {
      const titleEl = entryEl.querySelector<HTMLElement>(
        ":scope > .entry-heading h1.title[data-title]",
      );
      const headword = untag(titleEl?.dataset.title?.trim() || "");
      const reading = (entryEl as HTMLElement).dataset.reading?.trim() || "";
      const header = headword ? (reading ? `${headword}（${reading}）` : headword) : "";

      const groups = Array.from(entryEl.querySelectorAll(":scope > .entry-item"));
      const body = groups
        .map((group) => {
          const labels = Array.from(group.querySelectorAll(":scope > .part-of-speech"))
            .map((node) => visibleText(node).replace(/\s+/g, " ").trim())
            .filter(Boolean)
            .join(" ");
          const items = Array.from(group.querySelectorAll(":scope > ol > li")).map(
            (item, index) => {
              const itemBody = visibleText(item)
                .replace(/[ \t]+/g, " ")
                .replace(/\n+/g, "\n")
                .trim();
              return `${index + 1}. ${itemBody}`;
            },
          );
          return [labels, ...items].filter(Boolean).join("\n");
        })
        .filter(Boolean)
        .join("\n\n");

      return [header, body].filter(Boolean).join("\n\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

export function DictionaryPage({ word, lang, idx: targetDefIdx }: DictionaryPageProps) {
  const navigate = useNavigate();
  const touchAnchorStartAtRef = useRef<number | null>(null);
  const suppressAnchorClickUntilRef = useRef(0);
  const queryWord = useMemo(() => (word ?? "").trim(), [word]);
  const langTokenPrefix = getLangTokenPrefix(lang);
  const [state, setState] = useState<DictionaryState>({
    loading: false,
    entry: null,
    terms: [],
    error: null,
  });
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<{ ok: boolean } | null>(null);
  const copyStatusTimerRef = useRef<number | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  useEffect(
    () => () => {
      if (copyStatusTimerRef.current != null) {
        window.clearTimeout(copyStatusTimerRef.current);
        copyStatusTimerRef.current = null;
      }
    },
    [],
  );
  useEffect(() => {
    setCopyStatus(null);
    if (copyStatusTimerRef.current != null) {
      window.clearTimeout(copyStatusTimerRef.current);
      copyStatusTimerRef.current = null;
    }
  }, [queryWord, lang]);
  const [isStarred, setIsStarred] = useState(false);
  const [strokesVisible, setStrokesVisible] = useState(false);
  const [cnsFallback, setCnsFallback] = useState<CnsFallbackState>({
    loading: false,
    record: null,
    error: false,
  });
  const storageWord = useMemo(
    () => untag((state.entry?.title || queryWord || "").trim()),
    [state.entry?.title, queryWord],
  );
  // issue #132：單字詞條若已知缺筆順資料（stroke-json 404），停用筆順動畫
  // 觸發按鈕，避免使用者點下去只看到一片空白、淡到 50% 透明度的畫布。
  const strokeCandidateChar = useMemo(
    () => (isSingleCharTerm(storageWord) ? storageWord : null),
    [storageWord],
  );
  const strokeAvailable = useStrokeAvailability(strokeCandidateChar);
  const strokeAnimationDisabled = strokeAvailable === false;

  // 舊版 /word/N「指定義項」永久連結：1-based，跨該詞所有音項合併計數，
  // 不受 UI 依詞性分組顯示順序影響 — 對照的是同一份 definition 物件參照。
  const heteronyms = useMemo(() => {
    const raw = state.entry?.heteronyms;
    return dedupeHeteronyms(Array.isArray(raw) ? raw : []);
  }, [state.entry]);
  // 顯示順序（僅 lang='t'）：sutian.moe.edu.tw 自己的 `/tshiau/` 詞目查詢把
  // 真正的詞目（headword）音項排在「替」（替代字）音項之前 —— 例如「一」
  // 的 it 音（真詞目，異用字壹）排在 tsi̍t 音（替字，本字蜀，異用字蜀）
  // 之前。pack 內的 heteronym 順序跟隨 `詞目總檔.csv`/sutian su/N id
  // （對「一」恰好是 [tsi̍t(id=1), it(id=2)]，跟 sutian 的「真詞目優先」
  // 慣例相反）——這不是新的回歸，只是排序更明顯而已。純顯示層 stable
  // partition（見 sortHeteronymsBySubstitutionReading 註解），完全不動
  // pack 資料；`heteronyms`（pack 順序）保留給下面的 /word/N 永久連結
  // 計數與 definitionIndexMap 使用，兩者刻意不隨顯示順序改變。
  const displayHeteronyms = useMemo(() => {
    if (lang !== "t") return heteronyms;
    return sortHeteronymsBySubstitutionReading(heteronyms, (h) =>
      untag(h.reading ?? "").trim(),
    );
  }, [heteronyms, lang]);
  // groupDefinitions() keys by String(type||""), so any non-empty definitions
  // array always yields at least one group/.entry-item — this is equivalent
  // to "does at least one heteronym have a rendered definition group" without
  // duplicating the grouping logic here.
  const hasEntryDefinitions = useMemo(
    () => heteronyms.some((h) => Array.isArray(h.definitions) && h.definitions.length > 0),
    [heteronyms],
  );
  const definitionIndexMap = useMemo(() => {
    const map = new Map<Definition, number>();
    let counter = 0;
    for (const heteronym of heteronyms) {
      for (const definition of heteronym.definitions ?? []) {
        counter += 1;
        map.set(definition, counter);
      }
    }
    return map;
  }, [heteronyms]);
  const highlightedDefRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (targetDefIdx == null) return;
    highlightedDefRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [targetDefIdx, state.entry]);

  // 設定 body 語言 class（同原 $('body').addClass("lang-#LANG")）
  useEffect(() => {
    const langClass = `lang-${lang}`;
    document.body.classList.add(langClass);
    return () => {
      document.body.classList.remove(langClass);
    };
  }, [lang]);

  useEffect(() => {
    const titleWord = state.entry?.title || queryWord;
    applyHeadToDocument(getDictionaryHead(titleWord, lang));
  }, [state.entry?.title, queryWord, lang]);

  useRadicalTooltip();

  useEffect(() => {
    if (!queryWord) {
      setStrokesVisible(false);
      setState({ loading: false, entry: null, terms: [], error: "未提供字詞" });
      return;
    }

    // 切字或切語言時先關閉筆順，避免重渲染時重複初始化動畫
    setStrokesVisible(false);

    const applyResponse = (result: { ok: boolean; status: number; data: unknown }) => {
      const payload = result.data as DictionaryAPIResponse | DictionaryErrorResponse;

      if (result.ok) {
        setState({
          loading: false,
          entry: payload as DictionaryAPIResponse,
          terms: [],
          error: null,
        });
        return;
      }

      const terms = Array.isArray((payload as DictionaryErrorResponse).terms)
        ? ((payload as DictionaryErrorResponse).terms ?? [])
        : [];
      const message = (payload as DictionaryErrorResponse).message ?? `查詢失敗 (${result.status})`;
      setState({ loading: false, entry: null, terms, error: terms.length > 0 ? null : message });
    };

    const cached = readCachedDictionaryEntry(queryWord, lang);
    if (cached) {
      setPlayingAudioId(null);
      applyResponse(cached);
      return;
    }

    const controller = new AbortController();
    setState((previous) => ({
      ...previous,
      loading: true,
      terms: [],
      error: null,
    }));
    setPlayingAudioId(null);

    fetchDictionaryEntry(queryWord, lang, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        applyResponse(result);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "查詢失敗";
        setState({ loading: false, entry: null, terms: [], error: message });
      });

    return () => {
      controller.abort();
    };
  }, [lang, queryWord]);

  // CNS11643 屬性後備：僅在四部辭典皆無（error 或 terms 非空）且查詢為恰好一個
  // Unicode 字元時，才發出 CNS 請求。字典命中（state.entry 有值）時絕不觸發。
  useEffect(() => {
    const isSingleScalar = Array.from(queryWord).length === 1;
    const dictHit = Boolean(state.entry);
    const dictNoMatch =
      !state.loading && !dictHit && (state.error !== null || state.terms.length > 0);
    if (!isSingleScalar || !dictNoMatch) {
      setCnsFallback({ loading: false, record: null, error: false });
      return;
    }
    const controller = new AbortController();
    setCnsFallback({ loading: true, record: null, error: false });
    fetch(`/api/cns/${encodeURIComponent(queryWord)}.json`, { signal: controller.signal })
      .then(async (cnsRes) => {
        if (controller.signal.aborted) return;
        if (cnsRes.ok) {
          const data = (await cnsRes.json()) as CnsRecord;
          setCnsFallback({ loading: false, record: data, error: false });
        } else {
          setCnsFallback({ loading: false, record: null, error: false });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setCnsFallback({ loading: false, record: null, error: true });
        }
      });
    return () => {
      controller.abort();
    };
  }, [queryWord, state.entry, state.error, state.terms.length, state.loading]);

  useEffect(() => {
    if (!state.entry) return;
    addToLRU(queryWord, lang);
    writeLastLookup(queryWord, lang);
    setCurrentXrefs(queryWord, lang, state.entry.xrefs ?? []);
  }, [state.entry, queryWord, lang]);

  useEffect(() => {
    if (!state.entry || !storageWord) {
      setIsStarred(false);
      return;
    }
    setIsStarred(hasStarWord(lang, storageWord));
  }, [state.entry, storageWord, lang]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === getStarredStorageKey(lang) && storageWord) {
        setIsStarred(hasStarWord(lang, storageWord));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [lang, storageWord]);

  const toggleStar = useCallback(() => {
    if (!storageWord) return;
    const current = hasStarWord(lang, storageWord);
    if (current) {
      removeStarWord(lang, storageWord);
    } else {
      addStarWord(lang, storageWord);
    }
    setIsStarred(!current);
  }, [lang, storageWord]);

  const toggleStrokeAnimation = useCallback(
    (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
      // g0v/moedict-webkit#186: 主要拼音/注音現在可以直接在可見字形上拖曳選
      // 取複製；拖曳放開時瀏覽器仍會在同一個元素上送出一個 click（mousedown
      // /mouseup 落在同一元素），若不擋下就會在使用者複製拼音的當下意外開
      // 合筆順動畫，蓋掉剛選好的文字。只在滑鼠事件、且確實有非空選取時才略
      // 過；鍵盤 Enter/Space 觸發（KeyboardEvent）不受影響。
      if (event.type === "click" && hasActiveSelection()) return;
      event.preventDefault();
      event.stopPropagation();
      if (strokeAnimationDisabled) return;
      setStrokesVisible((v) => !v);
    },
    [strokeAnimationDisabled],
  );

  const copyEntryDefinitions = useCallback(async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const container = resultRef.current;
    if (!container) return;
    const text = serializeDefinitionText(container);
    const ok = await writeTextToClipboard(text);
    if (copyStatusTimerRef.current != null) {
      window.clearTimeout(copyStatusTimerRef.current);
      copyStatusTimerRef.current = null;
    }
    setCopyStatus({ ok });
    copyStatusTimerRef.current = window.setTimeout(() => {
      setCopyStatus(null);
      copyStatusTimerRef.current = null;
    }, 3000);
  }, []);

  const onContentClick = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const anchor = target.closest("a");
    if (!anchor) return;
    const isLookupAnchor = isContentLookupAnchor(anchor);
    if (
      isLookupAnchor &&
      (hasActiveSelection() || Date.now() < suppressAnchorClickUntilRef.current)
    ) {
      event.preventDefault();
      return;
    }
    const href = anchor.getAttribute("href");
    if (!href) return;

    const normalized = normalizeHref(href);
    if (!normalized) return;
    event.preventDefault();
    // 換頁前先收掉殘留的 tooltip：hideTooltip 為同步（直接設 display:none），
    // 派發事件當下即生效，因此可立即跳轉、不需延遲。
    document.dispatchEvent(new Event("moedict:dismiss-tooltip"));
    void navigate(normalized);
  };

  const onContentTouchStartCapture = (event: ReactTouchEvent<HTMLDivElement>): void => {
    touchAnchorStartAtRef.current = null;
    if (event.touches.length !== 1) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const anchor = target.closest("a");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (!isContentLookupAnchor(anchor)) return;
    touchAnchorStartAtRef.current = Date.now();
  };

  const onContentTouchEndCapture = (): void => {
    const startedAt = touchAnchorStartAtRef.current;
    touchAnchorStartAtRef.current = null;
    if (!startedAt) return;
    if (Date.now() - startedAt >= LONG_PRESS_MIN_DURATION_MS) {
      suppressAnchorClickUntilRef.current = Date.now() + LONG_PRESS_SUPPRESS_CLICK_MS;
    }
  };

  const onContentTouchCancelCapture = (): void => {
    touchAnchorStartAtRef.current = null;
  };

  if (state.error) {
    return (
      <div className="result">
        <h1 className="title">找不到：{queryWord}</h1>
        <div className="entry">
          <div className="entry-item">
            <p className="def">{state.error}</p>
          </div>
        </div>
        {cnsFallback.record && <CnsAttributesPanel record={cnsFallback.record} />}
      </div>
    );
  }

  if (state.terms.length > 0) {
    return (
      <>
        <CharacterImageView
          queryWord={queryWord}
          terms={state.terms}
          lang={lang}
          langTokenPrefix={langTokenPrefix}
        />
        {cnsFallback.record && (
          <div className="result">
            <CnsAttributesPanel record={cnsFallback.record} />
          </div>
        )}
      </>
    );
  }

  const entry = state.entry;
  if (!entry) return null;

  const title = entry.title || queryWord;
  const isSingleCharTitle = isSingleCharTerm(title);
  const translation = entry.translation ?? {};
  const english = translation.English ?? entry.English;
  const deutsch = translation.Deutsch ?? entry.Deutsch;
  const francais = translation.francais ?? entry.francais;

  // Build a per-heteronym-ID xref lookup from the ID-aware sidecar data.
  // Only the current entry's language is relevant here; xrefsByHeteronym
  // maps each target language to { heteronymId: [words] }.
  const xrefsByHeteronymId = entry.xrefsByHeteronym ?? [];
  const xrefLangsWithById = new Set(xrefsByHeteronymId.map((x) => x.lang));
  // Flat xrefs for languages that have ID-aware data are rendered per-heteronym
  // inside each heteronym block; the rest remain at the bottom.
  const flatXrefs = (entry.xrefs ?? []).filter((x) => !xrefLangsWithById.has(x.lang));

  return (
    <div
      ref={resultRef}
      className="result"
      onClick={onContentClick}
      onTouchStartCapture={onContentTouchStartCapture}
      onTouchEndCapture={onContentTouchEndCapture}
      onTouchCancelCapture={onContentTouchCancelCapture}
      aria-busy={state.loading}
    >
      {/* 筆順動畫區域（同原 index.html #strokes 位於 .results 頂部） */}
      <StrokeAnimation title={title} visible={strokesVisible} lang={lang} />

      {displayHeteronyms.map((heteronym, idx) => {
        const pronunAudioId = heteronym.audio_id || (lang === "t" ? heteronym.id : undefined);
        const rubyData =
          lang === "h"
            ? {
                ruby: "",
                youyin: "",
                bAlt: "",
                pAlt: "",
                cnSpecific: "",
                pinyin: "",
                bopomofo: "",
              }
            : decorateRuby({
                LANG: lang,
                title,
                bopomofo: heteronym.bopomofo,
                pinyin: heteronym.pinyin,
                trs: heteronym.trs,
              });
        const hakkaReadings =
          lang === "h"
            ? parseHakkaReadings(heteronym.pinyin || heteronym.trs || "", heteronym.audio_id)
            : [];
        const dialectSynonyms =
          lang === "t" || lang === "h" ? splitCommaSeparatedItems(heteronym.synonyms) : [];
        // TWBLG 文/白/俗/替讀音分類（g0v/moedict-webkit#96、#233）：資料只在
        // lang='t' 的 ptck pack 出現，其餘語言的 heteronym 沒有這個欄位。
        const definitions = Array.isArray(heteronym.definitions) ? heteronym.definitions : [];
        const groups = groupDefinitions(definitions);
        const readingType = lang === "t" ? untag(heteronym.reading ?? "").trim() : "";
        const isReadingOnly =
          lang === "t" && definitions.length === 0 && Boolean(heteronym.trs?.trim());
        // Displayed reading for the whole-entry copy payload's per-heteronym
        // header (see serializeDefinitionText below). rubyData.pinyin is
        // already the exact processed/displayed reading text for a/t/c
        // (decorateRuby strips HTML, handles the trs fallback, and the c-lang
        // <br> split) — reusing it keeps this pref-independent (unlike
        // scraping .romanization-selectable, which is display:none under
        // zhuyin/none phonetics prefs) and avoids re-deriving format logic.
        // lang=h has no single-string reading (decorateRuby is stubbed empty
        // for h; the real display is the multi-dialect hakkaReadings stack
        // below) — omitted rather than reconstructed.
        const displayReading = lang === "h" ? "" : rubyData.pinyin;

        return (
          <div key={`${title}-${idx}`} className="entry" data-reading={displayReading || undefined}>
            <div className="entry-heading">
              <div className="entry-control-stack">
                <div className="radical">
                  {(entry.radical || entry.stroke_count || entry.non_radical_stroke_count) && (
                    <>
                      {entry.radical && <RadicalGlyph char={entry.radical} lang={lang} />}
                      <span className="count">
                        <span className="sym">+</span>
                        {entry.non_radical_stroke_count ?? 0}
                      </span>
                      <span className="count"> = {entry.stroke_count ?? ""}</span>
                      {"\u00A0"}
                    </>
                  )}
                  <a
                    className="iconic-circle stroke"
                    title={strokeAnimationDisabled ? "此字尚無筆順動畫資料" : "筆順動畫"}
                    role="button"
                    tabIndex={strokeAnimationDisabled ? -1 : 0}
                    aria-disabled={strokeAnimationDisabled || undefined}
                    aria-label={strokeAnimationDisabled ? "筆順動畫（此字尚無資料）" : undefined}
                    onClick={strokeAnimationDisabled ? undefined : toggleStrokeAnimation}
                    onKeyDown={
                      strokeAnimationDisabled
                        ? undefined
                        : (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              toggleStrokeAnimation(e);
                            }
                          }
                    }
                  >
                    <SvgIcon name="pencil" size="1em" aria-hidden="true" />
                  </a>
                </div>
                {idx === 0 && (
                  <div className="entry-actions">
                    <span
                      className="entry-copy-status"
                      role="status"
                      aria-live="polite"
                      aria-atomic="true"
                    >
                      {hasEntryDefinitions && copyStatus
                        ? copyStatus.ok
                          ? "已複製"
                          : "複製失敗，請手動選取文字"
                        : "\u00a0"}
                    </span>
                    {hasEntryDefinitions && (
                      <button
                        type="button"
                        className="entry-copy-button"
                        aria-label="複製解釋"
                        title="複製解釋"
                        onClick={(event) => {
                          void copyEntryDefinitions(event);
                        }}
                      >
                        <SvgIcon name="copy" size="1em" aria-hidden="true" />
                      </button>
                    )}
                    {isSingleCharTitle && (
                      <a
                        className="iconic-circle stroke variants-link"
                        aria-label="查詢此單字的教育部《異體字字典》資料"
                        title="查詢此單字的教育部《異體字字典》資料"
                        target="_blank"
                        rel="noopener noreferrer"
                        href={`https://dict.variants.moe.edu.tw/search.jsp?QTP=0&WORD=${encodeURIComponent(title)}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <SvgIcon name="book" size="1em" aria-hidden="true" />
                      </a>
                    )}
                    <button
                      type="button"
                      className="star iconic-color"
                      title={isStarred ? "已加入記錄簿" : "加入字詞記錄簿"}
                      data-word={title}
                      data-lang={lang}
                      aria-label={isStarred ? "已加入記錄簿" : "加入字詞記錄簿"}
                      aria-pressed={isStarred}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleStar();
                      }}
                    >
                      <SvgIcon
                        name={isStarred ? "star" : "starEmpty"}
                        size="1em"
                        style={isStarred ? undefined : { transform: "scale(1.12)" }}
                        aria-hidden="true"
                      />
                    </button>
                  </div>
                )}
              </div>
              <h1 className="title" data-title={title}>
                <TitlePronunciation
                  lang={lang}
                  youyin={rubyData.youyin}
                  bAlt={rubyData.bAlt}
                  pAlt={rubyData.pAlt}
                  pronunAudioId={lang !== "h" ? pronunAudioId : undefined}
                  readingType={readingType}
                  isPlaying={playingAudioId === pronunAudioId}
                  onToggleAudio={() => {
                    if (!pronunAudioId) return;
                    const audioId = pronunAudioId;
                    playAudioUrl(getAudioUrl(lang, audioId), (playing) => {
                      setPlayingAudioId(playing ? audioId : null);
                    });
                  }}
                >
                  <span
                    className={isSingleCharTitle ? "single-char-stroke-trigger" : undefined}
                    role={isSingleCharTitle ? "button" : undefined}
                    tabIndex={isSingleCharTitle && !strokeAnimationDisabled ? 0 : undefined}
                    aria-disabled={isSingleCharTitle && strokeAnimationDisabled ? true : undefined}
                    onClick={
                      isSingleCharTitle && !strokeAnimationDisabled
                        ? toggleStrokeAnimation
                        : undefined
                    }
                    onKeyDown={
                      isSingleCharTitle && !strokeAnimationDisabled
                        ? (event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              toggleStrokeAnimation(event);
                            }
                          }
                        : undefined
                    }
                  >
                    {(() => {
                      if (lang === "h") return <span dangerouslySetInnerHTML={{ __html: title }} />;
                      const htmlRuby = rubyData.ruby || "";
                      if (!htmlRuby) return <span dangerouslySetInnerHTML={{ __html: title }} />;
                      const hruby = rightAngle(htmlRuby);
                      return <span dangerouslySetInnerHTML={{ __html: hruby }} />;
                    })()}
                  </span>
                </TitlePronunciation>
              </h1>
              {hakkaReadings.length > 0 && (
                <div className="bopomofo">
                  <span className="pinyin">
                    {hakkaReadings.map((item) => {
                      const audioKey = `${heteronym.audio_id}:${item.variant}`;
                      return (
                        <span key={`${title}-${idx}-${item.variant}`}>
                          <span className="audioBlock">
                            <span
                              role="button"
                              tabIndex={0}
                              aria-label={playingAudioId === audioKey ? "停止播放" : "播放發音"}
                              className="part-of-speech"
                              title={playingAudioId === audioKey ? "停止播放" : "播放發音"}
                              style={{
                                cursor: "pointer",
                                fontSize: "1.4em",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                              }}
                              onClick={(event) => {
                                event.stopPropagation();
                                playAudioUrl(
                                  getHakkaVariantAudioUrl(item.variant, heteronym.audio_id!),
                                  (playing) => {
                                    setPlayingAudioId(playing ? audioKey : null);
                                  },
                                );
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  playAudioUrl(
                                    getHakkaVariantAudioUrl(item.variant, heteronym.audio_id!),
                                    (playing) => {
                                      setPlayingAudioId(playing ? audioKey : null);
                                    },
                                  );
                                }
                              }}
                            >
                              <SvgIcon
                                name={playingAudioId === audioKey ? "stop" : "play"}
                                size="1em"
                                aria-hidden="true"
                              />
                              {item.dialect}
                            </span>
                          </span>
                          <span dangerouslySetInnerHTML={{ __html: item.readingHtml }} />
                        </span>
                      );
                    })}
                  </span>
                </div>
              )}
            </div>

            {heteronym.alt && (
              <div className="cn-specific" lang="zh-Hans">
                <span className="xref part-of-speech">简</span>
                <span className="xref">{untag(heteronym.alt)}</span>
              </div>
            )}

            {lang === "t" && heteronym.variants && heteronym.variants.length > 0 && (
              <div className="twblg-variants">
                <span className="xref part-of-speech">異用字</span>
                <span className="xref">{heteronym.variants.join("、")}</span>
              </div>
            )}

            {Array.from(groups.entries()).map(([type, items], groupIdx) => {
              const posTags = splitPartOfSpeech(type);
              return (
                <div key={`${type}-${groupIdx}`} className="entry-item">
                  {posTags.map((tag) => (
                    <span key={`${type}-${tag}`} className="part-of-speech">
                      {tag}
                    </span>
                  ))}
                  <ol className={posTags.length > 0 ? "margin-modified" : undefined}>
                    {items.map((def, defIdx) => {
                      const parallelIdx = def.def ? def.def.indexOf("∥") : -1;
                      const mainDef = parallelIdx >= 0 ? def.def!.slice(0, parallelIdx) : def.def;
                      const afterParallel = parallelIdx >= 0 ? def.def!.slice(parallelIdx) : null;
                      const flatDefIdx = definitionIndexMap.get(def);
                      const isTargetDefinition =
                        targetDefIdx != null && flatDefIdx === targetDefIdx;
                      return (
                        <li
                          key={`${type}-${defIdx}`}
                          ref={isTargetDefinition ? highlightedDefRef : undefined}
                          className={isTargetDefinition ? "idx-permalink-target" : undefined}
                        >
                          {mainDef ? (
                            <p className="definition">
                              <span className="def" dangerouslySetInnerHTML={{ __html: mainDef }} />
                            </p>
                          ) : null}
                          {toStringArray(def.example).map((text, exampleIdx) =>
                            (() => {
                              const html = formatExampleIcon(text);
                              const parsedRubyLine =
                                lang === "t" ? parseTaiwaneseRubyLine(html) : null;
                              if (!parsedRubyLine) {
                                return (
                                  <div
                                    key={`example-${exampleIdx}`}
                                    className="example"
                                    dangerouslySetInnerHTML={{ __html: html }}
                                  />
                                );
                              }
                              return (
                                <div key={`example-${exampleIdx}`} className="example">
                                  <span
                                    className="h1"
                                    dangerouslySetInnerHTML={{ __html: parsedRubyLine.headingHtml }}
                                  />
                                  {parsedRubyLine.mandarinHtml && (
                                    <span
                                      className="mandarin"
                                      dangerouslySetInnerHTML={{
                                        __html: parsedRubyLine.mandarinHtml,
                                      }}
                                    />
                                  )}
                                </div>
                              );
                            })(),
                          )}
                          {toStringArray(def.quote).map((text, quoteIdx) => {
                            const parsedRubyLine =
                              lang === "t" ? parseTaiwaneseRubyLine(text) : null;
                            if (!parsedRubyLine) {
                              return (
                                <div
                                  key={`quote-${quoteIdx}`}
                                  className="quote"
                                  dangerouslySetInnerHTML={{ __html: text }}
                                />
                              );
                            }
                            return (
                              <div key={`quote-${quoteIdx}`} className="quote">
                                <span
                                  className="h1"
                                  dangerouslySetInnerHTML={{ __html: parsedRubyLine.headingHtml }}
                                />
                                {parsedRubyLine.mandarinHtml && (
                                  <span
                                    className="mandarin"
                                    dangerouslySetInnerHTML={{
                                      __html: parsedRubyLine.mandarinHtml,
                                    }}
                                  />
                                )}
                              </div>
                            );
                          })}
                          {toStringArray(def.link).map((text, linkIdx) => {
                            const parsedRubyLine =
                              lang === "t" ? parseTaiwaneseRubyLine(text) : null;
                            if (!parsedRubyLine) {
                              return (
                                <div
                                  key={`link-${linkIdx}`}
                                  className="link"
                                  dangerouslySetInnerHTML={{ __html: text }}
                                />
                              );
                            }
                            return (
                              <div key={`link-${linkIdx}`} className="link">
                                <span
                                  className="h1"
                                  dangerouslySetInnerHTML={{ __html: parsedRubyLine.headingHtml }}
                                />
                                {parsedRubyLine.mandarinHtml && (
                                  <span
                                    className="mandarin"
                                    dangerouslySetInnerHTML={{
                                      __html: parsedRubyLine.mandarinHtml,
                                    }}
                                  />
                                )}
                              </div>
                            );
                          })}
                          {toStringArray(def.synonyms).length > 0 && (
                            <div className="synonyms">
                              <span className="part-of-speech">似</span>
                              <span>
                                {untag(toStringArray(def.synonyms).join("、").replace(/,/g, "、"))}
                              </span>
                            </div>
                          )}
                          {toStringArray(def.antonyms).length > 0 && (
                            <div className="antonyms">
                              <span className="part-of-speech">反</span>
                              <span>
                                {untag(toStringArray(def.antonyms).join("、").replace(/,/g, "、"))}
                              </span>
                            </div>
                          )}
                          {afterParallel && (
                            <div
                              style={{ margin: "0 0 22px -44px" }}
                              dangerouslySetInnerHTML={{ __html: afterParallel }}
                            />
                          )}
                        </li>
                      );
                    })}
                  </ol>
                </div>
              );
            })}
            {isReadingOnly && (
              <p className="reading-only-note" role="note">
                本音讀無義項。
              </p>
            )}
            {dialectSynonyms.length > 0 && (
              <div className="synonyms">
                <span className="part-of-speech">似</span>
                <span>
                  {dialectSynonyms.map((item, synIdx) => (
                    <span key={`t-synonym-${synIdx}`}>
                      {synIdx > 0 ? "、" : ""}
                      <span dangerouslySetInnerHTML={{ __html: item }} />
                    </span>
                  ))}
                </span>
              </div>
            )}
            {xrefsByHeteronymId.length > 0 &&
              heteronym.id &&
              (() => {
                const xrefLinks: React.ReactNode[] = [];
                for (const xref of xrefsByHeteronymId) {
                  const words = xref.byId[heteronym.id];
                  if (!words || words.length === 0) continue;
                  xrefLinks.push(
                    <div key={`xref-by-id-${xref.lang}-${heteronym.id}`} className="xref-line">
                      <span className="xref part-of-speech">{getLangName(xref.lang)}</span>
                      <span className="xref">
                        {words.map((xrefWord, wIdx) => {
                          const normalizedXrefWord = normalizeXrefWord(xrefWord);
                          const to = `/${getLangTokenPrefix(xref.lang)}${normalizedXrefWord}`;
                          return (
                            <span key={`xref-by-id-${xref.lang}-${heteronym.id}-${wIdx}`}>
                              {wIdx > 0 ? "、" : ""}
                              <a
                                href={to}
                                data-radical-id={`entry:${to}`}
                                onClick={(event) => {
                                  event.preventDefault();
                                  void navigate(to);
                                }}
                              >
                                {normalizedXrefWord}
                              </a>
                            </span>
                          );
                        })}
                      </span>
                    </div>,
                  );
                }
                return xrefLinks.length > 0 ? <div className="xrefs">{xrefLinks}</div> : null;
              })()}
          </div>
        );
      })}

      {(english || deutsch || francais) && (
        <div className="xrefs">
          {english && <XrefTranslationLine label="英" value={english} />}
          {deutsch && <XrefTranslationLine label="德" value={deutsch} />}
          {francais && <XrefTranslationLine label="法" value={francais} />}
        </div>
      )}

      {flatXrefs.length > 0 && (
        <div className="xrefs">
          {flatXrefs.map((xref) => (
            <div key={xref.lang} className="xref-line">
              <span className="xref part-of-speech">{getLangName(xref.lang)}</span>
              <span className="xref">
                {xref.words.map((xrefWord, idx) => {
                  const normalizedXrefWord = normalizeXrefWord(xrefWord);
                  const to = `/${getLangTokenPrefix(xref.lang)}${normalizedXrefWord}`;
                  return (
                    <span key={`${xref.lang}-${normalizedXrefWord}-${idx}`}>
                      {idx > 0 ? "、" : ""}
                      <a
                        href={to}
                        data-radical-id={`entry:${to}`}
                        onClick={(event) => {
                          event.preventDefault();
                          void navigate(to);
                        }}
                      >
                        {normalizedXrefWord}
                      </a>
                    </span>
                  );
                })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
