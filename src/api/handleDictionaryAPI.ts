import { CACHE_CONTROL, dictTagsForLang } from './cache';
import { dedupeHeteronyms } from '../utils/heteronym-dedup';
import { stripLangPrefix, tryDecodeURIComponent, type DictionaryLang } from '../utils/dictionary-route';

type SubRouteType = DictionaryLang | 'raw' | 'uni' | 'pua';

interface DictionaryObjectLike {
  text(): Promise<string>;
}

interface DictionaryBucketLike {
  get(key: string): Promise<DictionaryObjectLike | null>;
}

interface DictionaryEnv {
  DICTIONARY: DictionaryBucketLike;
}

interface ErrorResponse {
  error: string;
  message: string;
  terms?: string[];
}

interface DictionaryEntry {
  [key: string]: unknown;
  h?: Array<{ b?: string; d?: Array<{ f?: string; l?: string }> }>;
}

interface DictionaryAPIResponse {
  [key: string]: unknown;
  xrefs?: Array<{ lang: DictionaryLang; words: string[] }>;
  xrefsByHeteronym?: Array<{ lang: DictionaryLang; byId: Record<string, string[]> }>;
}

interface XRefData {
  [targetLang: string]: Record<string, string | string[]>;
}

interface XRefByIdData {
  [targetLang: string]: Record<string, Record<string, string[]>>;
}

interface ConvertedDictionaryData {
  title?: unknown;
  heteronyms?: Array<Record<string, unknown>>;
  radical?: unknown;
  stroke_count?: unknown;
  non_radical_stroke_count?: unknown;
}

const KEY_MAP: Record<string, string> = {
  h: 'heteronyms',
  b: 'bopomofo',
  p: 'pinyin',
  d: 'definitions',
  c: 'stroke_count',
  n: 'non_radical_stroke_count',
  f: 'def',
  t: 'title',
  r: 'radical',
  e: 'example',
  l: 'link',
  s: 'synonyms',
  a: 'antonyms',
  q: 'quote',
  _: 'id',
  '=': 'audio_id',
  E: 'english',
  T: 'trs',
  A: 'alt',
  V: 'vernacular',
  C: 'combined',
  D: 'dialects',
  S: 'specific_to',
};

const PUA_TO_IDS_MAP: Record<string, string> = {
  [String.fromCodePoint(0xf90fd)]: '⿺辶局',
  [String.fromCodePoint(0xf8ff0)]: '⿰亻壯',
  [String.fromCodePoint(0xf9ad7)]: '⿰扌層',
  [String.fromCodePoint(0xf9868)]: '⿱禾千',
};

export async function handleDictionaryAPI(
  request: Request,
  url: URL,
  env: DictionaryEnv,
): Promise<Response> {
  if (url.pathname.includes('com.chrome.devtools') || url.pathname.includes('.well-known')) {
    return new Response('Not Found', { status: 404 });
  }

  const subRoute = parseSubRoute(url.pathname);
  if (subRoute) {
    return handleSubRouteAPI(request, subRoute.routeType, subRoute.text, env);
  }

  const { lang, cleanText } = parseTextFromUrl(url.pathname);

  try {
    if (cleanText.startsWith('@')) {
      return await handleRadicalLookup(request, cleanText, lang, env);
    }

    if (cleanText.startsWith('=')) {
      return await handleListLookup(request, cleanText, lang, env);
    }

    const processedEntry = await lookupDictionaryEntry(cleanText, lang, env);
    if (!processedEntry) {
      const terms = await performFuzzySearch(cleanText);
      const status = 404;
      if (terms.length === 0) {
        const errorResponse: ErrorResponse = {
          error: 'Not Found',
          message: `找不到詞彙: ${cleanText}`,
          terms: [],
        };
        return jsonResponse(request, errorResponse, status);
      }
      return jsonResponse(request, { terms }, status);
    }

    return jsonResponse(request, processedEntry, 200);
  } catch (error) {
    const errorResponse: ErrorResponse = {
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to process dictionary request',
    };
    return jsonResponse(request, errorResponse, 500);
  }
}

export function parseSubRoute(pathname: string): { routeType: SubRouteType; text: string } | null {
  // .json is optional: README.md's documented examples for these 7 legacy
  // endpoints (https://www.moedict.tw/raw/萌) omit it, while real external
  // consumers found in the wild (blog posts, tutorials) use
  // https://www.moedict.tw/a/萌.json. Both forms return the same payload.
  const match = pathname.match(/^\/(a|t|h|c|raw|uni|pua)\/(.+?)(?:\.json)?$/);
  if (!match) return null;
  const [, routeType, encodedText] = match;
  return {
    routeType: routeType as SubRouteType,
    text: tryDecodeURIComponent(encodedText) ?? encodedText,
  };
}

async function handleSubRouteAPI(
  request: Request,
  routeType: SubRouteType,
  text: string,
  env: DictionaryEnv,
): Promise<Response> {
  try {
    if (routeType === 'a' || routeType === 't' || routeType === 'h' || routeType === 'c') {
      return await handleLanguageSubRoute(request, routeType, text, env);
    }
    if (routeType === 'raw') {
      return await handleRawRoute(request, text, env);
    }
    if (routeType === 'uni') {
      return await handleUniRoute(request, text, env);
    }
    return await handlePuaRoute(request, text, env);
  } catch (error) {
    const errorResponse: ErrorResponse = {
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to process sub-route request',
    };
    return jsonResponse(request, errorResponse, 500);
  }
}

async function handleLanguageSubRoute(
  request: Request,
  lang: DictionaryLang,
  text: string,
  env: DictionaryEnv,
): Promise<Response> {
  if (text === 'index') {
    const indexObject = await env.DICTIONARY.get(`${lang}/index.json`);
    if (!indexObject) {
      return jsonResponse(
        request,
        { error: 'Not Found', message: `找不到索引檔：${lang}/index.json`, terms: [] } satisfies ErrorResponse,
        404,
        false,
      );
    }
    // 以 pretty 格式回傳（每個詞彙獨立一行，逗號後換行），方便閱讀
    return jsonResponse(request, JSON.parse(await indexObject.text()), 200);
  }

  if (text.startsWith('@')) {
    const radicalPath = `${lang}/${text}.json`;
    let radicalObject = await env.DICTIONARY.get(radicalPath);
    if (!radicalObject && text === '@青') {
      radicalObject = await env.DICTIONARY.get(`${lang}/@靑.json`);
    } else if (!radicalObject && text === '@靑') {
      radicalObject = await env.DICTIONARY.get(`${lang}/@青.json`);
    }
    if (!radicalObject) {
      return jsonResponse(
        request,
        { error: 'Not Found', message: `找不到部首: ${text}`, terms: [] } satisfies ErrorResponse,
        404,
        false,
      );
    }
    const fileData = await radicalObject.text();
    return jsonResponse(request, JSON.parse(fileData), 200, false);
  }

  if (text.startsWith('=')) {
    const listObject = await env.DICTIONARY.get(`${lang}/${text}.json`);
    if (!listObject) {
      return jsonResponse(
        request,
        { error: 'Not Found', message: `找不到列表: ${text}`, terms: [] } satisfies ErrorResponse,
        404,
        false,
      );
    }
    const listData = await listObject.text();
    return jsonResponse(request, JSON.parse(listData), 200, false);
  }

  const bucket = bucketOf(text, lang);
  const bucketResult = await fillBucket(text, bucket, lang, env);
  if (bucketResult.err || !bucketResult.data) {
    return jsonResponse(
      request,
      { error: 'Not Found', message: `找不到詞彙: ${text}`, terms: [] } satisfies ErrorResponse,
      404,
      false,
    );
  }
  return jsonResponse(request, bucketResult.data, 200, false);
}

async function handleRawRoute(request: Request, text: string, env: DictionaryEnv): Promise<Response> {
  const source = await lookupRawSource(text, env);
  if (!source) {
    return jsonResponse(
      request,
      { error: 'Not Found', message: `找不到詞彙: ${text}`, terms: [] } satisfies ErrorResponse,
      404,
    );
  }
  return jsonResponse(request, convertToRawFormat(source), 200);
}

async function handleUniRoute(request: Request, text: string, env: DictionaryEnv): Promise<Response> {
  const source = await lookupRawSource(text, env);
  if (!source) {
    return jsonResponse(
      request,
      { error: 'Not Found', message: `找不到詞彙: ${text}`, terms: [] } satisfies ErrorResponse,
      404,
    );
  }
  return jsonResponse(request, convertToUniFormat(source), 200);
}

async function handlePuaRoute(request: Request, text: string, env: DictionaryEnv): Promise<Response> {
  const source = await lookupRawSource(text, env);
  if (!source) {
    return jsonResponse(
      request,
      { error: 'Not Found', message: `找不到詞彙: ${text}`, terms: [] } satisfies ErrorResponse,
      404,
    );
  }
  return jsonResponse(request, convertToPuaFormat(source), 200);
}

async function lookupRawSource(text: string, env: DictionaryEnv): Promise<DictionaryEntry | null> {
  const bucket = bucketOf(text, 'a');
  const bucketResult = await fillBucket(text, bucket, 'a', env);
  return bucketResult.err ? null : bucketResult.data;
}

export function parseTextFromUrl(pathname: string): { lang: DictionaryLang; cleanText: string } {
  const noSuffix = pathname.replace('/api/', '').replace(/\.json$/, '');
  const noLeadingSlash = noSuffix.replace(/^\//, '');
  // 壞的 percent-encoding 不得往上冒成 500 —— fallback 用未解碼字串
  // （查無此詞 → 走既有 404-with-terms 路徑）
  const decoded = tryDecodeURIComponent(noLeadingSlash) ?? noLeadingSlash;

  const slashParts = decoded.split('/').filter(Boolean);
  if (slashParts.length >= 2 && isDictionaryLang(slashParts[0])) {
    return {
      lang: slashParts[0],
      cleanText: slashParts.slice(1).join('/'),
    };
  }

  const { lang, rest: cleanText } = stripLangPrefix(decoded, { '!': 't' });
  return { lang, cleanText };
}

function isDictionaryLang(input: string): input is DictionaryLang {
  return input === 'a' || input === 't' || input === 'h' || input === 'c';
}


function getCORSHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function resolveDictCacheTags(request: Request): string {
  const pathname = new URL(request.url).pathname;
  const sub = parseSubRoute(pathname);
  if (sub && (sub.routeType === 'a' || sub.routeType === 't' || sub.routeType === 'h' || sub.routeType === 'c')) {
    return dictTagsForLang(sub.routeType);
  }
  const pathForParse = pathname.replace(/^\/api(?=\/|$)/, '');
  const { lang } = parseTextFromUrl(pathForParse);
  return dictTagsForLang(lang);
}

function jsonResponse(request: Request, payload: unknown, status = 200, pretty = true): Response {
  const body = pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
  const headers = new Headers({
    'Content-Type': 'application/json',
    ...getCORSHeaders(),
  });

  // Long-cache only successful public GET/HEAD payloads — never 404/500.
  if ((request.method === 'GET' || request.method === 'HEAD') && status === 200) {
    headers.set('Cache-Control', CACHE_CONTROL.dict);
    headers.set('Cache-Tag', resolveDictCacheTags(request));
  }

  return new Response(body, {
    status,
    headers,
  });
}

export function bucketOf(text: string, lang: DictionaryLang): string {
  if (/^[=@]/.test(text)) {
    return text[0];
  }

  let code = text.charCodeAt(0);
  if (code >= 0xd800 && code <= 0xdbff) {
    code = text.charCodeAt(1) - 0xdc00;
  }

  const bucketSize = lang === 'a' ? 1024 : 128;
  return String(code % bucketSize);
}

async function fillBucket(
  id: string,
  bucket: string,
  lang: DictionaryLang,
  env: DictionaryEnv,
): Promise<{ data: DictionaryEntry | null; err: boolean }> {
  try {
    const bucketPath = `p${lang}ck/${bucket}.txt`;
    const bucketObject = await env.DICTIONARY.get(bucketPath);
    if (!bucketObject) {
      return { data: null, err: true };
    }

    const bucketData = await bucketObject.text();
    const responseData = JSON.parse(bucketData) as Record<string, DictionaryEntry>;
    const key = escape(id);
    const part = responseData[key];

    if (!part) {
      return { data: null, err: true };
    }

    return { data: part, err: false };
  } catch {
    return { data: null, err: true };
  }
}

async function handleRadicalLookup(
  request: Request,
  text: string,
  lang: DictionaryLang,
  env: DictionaryEnv,
): Promise<Response> {
  const radicalPath = `${lang}/${text}.json`;
  let radicalObject = await env.DICTIONARY.get(radicalPath);

  if (!radicalObject && text === '@青') {
    radicalObject = await env.DICTIONARY.get(`${lang}/@靑.json`);
  } else if (!radicalObject && text === '@靑') {
    radicalObject = await env.DICTIONARY.get(`${lang}/@青.json`);
  }

  if (!radicalObject) {
    return jsonResponse(
      request,
      { error: 'Not Found', message: `找不到部首: ${text}`, terms: [] } satisfies ErrorResponse,
      404,
    );
  }

  const radicalData = await radicalObject.text();
  return jsonResponse(request, JSON.parse(radicalData), 200);
}

async function handleListLookup(
  request: Request,
  text: string,
  lang: DictionaryLang,
  env: DictionaryEnv,
): Promise<Response> {
  const listPath = `${lang}/${text}.json`;
  const listObject = await env.DICTIONARY.get(listPath);

  if (!listObject) {
    return jsonResponse(
      request,
      { error: 'Not Found', message: `找不到列表: ${text}`, terms: [] } satisfies ErrorResponse,
      404,
    );
  }

  const listData = await listObject.text();
  return jsonResponse(request, JSON.parse(listData), 200);
}

export async function lookupDictionaryEntry(
  text: string,
  lang: DictionaryLang,
  env: DictionaryEnv,
): Promise<DictionaryAPIResponse | null> {
  if (text.startsWith('@') || text.startsWith('=')) {
    return null;
  }

  const bucket = bucketOf(text, lang);
  const bucketResult = await fillBucket(text, bucket, lang, env);
  if (bucketResult.err || !bucketResult.data) {
    return null;
  }

  const entry = bucketResult.data;
  const processedEntry = processDictionaryEntry(entry, lang);
  processedEntry.xrefs = await getCrossReferences(text, lang, env);
  processedEntry.xrefsByHeteronym = await getCrossReferencesById(text, lang, env);
  return processedEntry;
}

function processDictionaryEntry(entry: DictionaryEntry, lang: DictionaryLang): DictionaryAPIResponse {
  const decoded = decodeLangPart(lang, JSON.stringify(entry));
  const parsedEntry = JSON.parse(decoded) as Record<string, unknown>;

  const result: DictionaryAPIResponse = {};
  if (parsedEntry.Deutsch) result.Deutsch = parsedEntry.Deutsch;
  if (parsedEntry.English || parsedEntry.english) result.English = parsedEntry.English || parsedEntry.english;
  if (parsedEntry.francais) result.francais = parsedEntry.francais;
  if (Array.isArray(parsedEntry.heteronyms)) {
    result.heteronyms = dedupeHeteronyms(parsedEntry.heteronyms as Array<Record<string, unknown>>);
  }
  if (parsedEntry.radical) result.radical = parsedEntry.radical;
  if (parsedEntry.stroke_count) result.stroke_count = parsedEntry.stroke_count;
  if (parsedEntry.non_radical_stroke_count) result.non_radical_stroke_count = parsedEntry.non_radical_stroke_count;
  if (parsedEntry.title) result.title = parsedEntry.title;
  if (parsedEntry.translation) result.translation = parsedEntry.translation;

  return result;
}

function decodeLangPart(lang: DictionaryLang, part = ''): string {
  while (part.match(/"`辨~\u20DE&nbsp`似~\u20DE"[^}]*},{"f":"([^（]+)[^"]*"/)) {
    part = part.replace(
      /"`辨~\u20DE&nbsp`似~\u20DE"[^}]*},{"f":"([^（]+)[^"]*"/,
      '"辨\u20DE 似\u20DE $1"',
    );
  }

  part = part.replace(/"`(.)~\u20DE"[^}]*},{"f":"([^（]+)[^"]*"/g, '"$1\u20DE $2"');
  part = part.replace(/"([hbpdcnftrelsaqETAVCDS_=])":/g, (_m, k: string) => `"${KEY_MAP[k]}":`);

  const HASH_OF: Record<DictionaryLang, string> = { a: '#', t: "#'", h: '#:', c: '#~' };
  const h = `./#${HASH_OF[lang]}`;

  part = part.replace(
    /([「【『（《])`([^~]+)~([。，、；：？！─…．·－」』》〉]+)/g,
    '<span class=\\"punct\\">$1<a href=\\"' + h + '$2\\">$2</a>$3</span>',
  );
  part = part.replace(
    /([「【『（《])`([^~]+)~/g,
    '<span class=\\"punct\\">$1<a href=\\"' + h + '$2\\">$2</a></span>',
  );
  part = part.replace(
    /`([^~]+)~([。，、；：？！─…．·－」』》〉]+)/g,
    '<span class=\\"punct\\"><a href=\\"' + h + '$1\\">$1</a>$2</span>',
  );
  part = part.replace(/`([^~]+)~/g, '<a href=\\"' + h + '$1\\">$1</a>');

  part = part.replace(/([\u4e00-\u9fff])\u20DD/g, '<span class=\\"regional part-of-speech\\">$1</span> ');
  part = part.replace(/([)）])/g, '$1\u200B');
  part = part.replace(/\.\/##/g, './#');
  return part;
}

function convertDictionaryStructure(entry: unknown): ConvertedDictionaryData {
  function convertObject(obj: unknown): unknown {
    if (Array.isArray(obj)) {
      return obj.map(convertObject);
    }
    if (obj && typeof obj === 'object') {
      const converted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        converted[KEY_MAP[key] || key] = convertObject(value);
      }
      return converted;
    }
    return obj;
  }

  const result = convertObject(entry);
  if (!result || typeof result !== 'object') return {};
  return result as ConvertedDictionaryData;
}

function cleanRawData(data: unknown): unknown {
  function cleanObject(obj: unknown): unknown {
    if (Array.isArray(obj)) {
      return obj.map(cleanObject);
    }
    if (obj && typeof obj === 'object') {
      const cleaned: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        cleaned[key] = cleanObject(value);
      }
      return cleaned;
    }
    if (typeof obj === 'string') {
      const noTags = obj.replace(/<[^>]*>/g, '');
      const noMarkers = noTags.replace(/[`~]/g, '');
      return noMarkers.replace(/\s+/g, ' ').trim();
    }
    return obj;
  }

  return cleanObject(data);
}

export function convertPuaToIDS(data: unknown): unknown {
  function convertObject(obj: unknown): unknown {
    if (Array.isArray(obj)) {
      return obj.map(convertObject);
    }
    if (obj && typeof obj === 'object') {
      const converted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        converted[key] = convertObject(value);
      }
      return converted;
    }
    if (typeof obj === 'string') {
      let result = obj;
      for (const [pua, ids] of Object.entries(PUA_TO_IDS_MAP)) {
        result = result.split(pua).join(ids);
      }
      return result;
    }
    return obj;
  }

  return convertObject(data);
}

export function convertPuaToCharCode(data: unknown): unknown {
  function convertString(value: string): string {
    let output = '';
    for (const char of value) {
      const codePoint = char.codePointAt(0);
      if (codePoint && codePoint >= 0xf0000 && codePoint <= 0xfffff) {
        output += `{[${(codePoint - 0xf0000).toString(16)}]}`;
      } else {
        output += char;
      }
    }
    return output;
  }

  function convertObject(obj: unknown): unknown {
    if (Array.isArray(obj)) {
      return obj.map(convertObject);
    }
    if (obj && typeof obj === 'object') {
      const converted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        converted[key] = convertObject(value);
      }
      return converted;
    }
    if (typeof obj === 'string') {
      return convertString(obj);
    }
    return obj;
  }

  return convertObject(data);
}

export function addBopomofo2(heteronyms: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  function applyTone(syllable: string, tone: string): string {
    if (!tone || tone === '˙') return syllable;
    const toneMap: Record<string, Record<string, string>> = {
      '': { a: 'ā', o: 'ō', e: 'ē', i: 'ī', u: 'ū', ü: 'ǖ' },
      'ˊ': { a: 'á', o: 'ó', e: 'é', i: 'í', u: 'ú', ü: 'ǘ' },
      'ˇ': { a: 'ǎ', o: 'ǒ', e: 'ě', i: 'ǐ', u: 'ǔ', ü: 'ǚ' },
      'ˋ': { a: 'à', o: 'ò', e: 'è', i: 'ì', u: 'ù', ü: 'ǜ' },
    };
    if (syllable.includes('a')) return syllable.replace('a', toneMap[tone].a);
    if (syllable.includes('o')) return syllable.replace('o', toneMap[tone].o);
    if (syllable.includes('e')) return syllable.replace('e', toneMap[tone].e);
    if (syllable.includes('iu')) return syllable.replace('u', toneMap[tone].u);
    if (syllable.includes('ui')) return syllable.replace('i', toneMap[tone].i);
    if (syllable.includes('u')) return syllable.replace('u', toneMap[tone].u);
    if (syllable.includes('i')) return syllable.replace('i', toneMap[tone].i);
    if (syllable.includes('ü')) return syllable.replace('ü', toneMap[tone].ü);
    return syllable;
  }

  return heteronyms.map((heteronym) => {
    const bopomofoValue = heteronym.bopomofo;
    if (typeof bopomofoValue !== 'string' || bopomofoValue.length === 0) {
      return heteronym;
    }
    const syllables = bopomofoValue.split(/\s+/);
    const converted = syllables.map((syl) => {
      if (!syl) return '';
      let tone = '';
      if (syl.includes('ˊ')) tone = 'ˊ';
      else if (syl.includes('ˇ')) tone = 'ˇ';
      else if (syl.includes('ˋ')) tone = 'ˋ';
      else if (syl.includes('˙')) tone = '˙';

      let base = syl.replace(/[ˊˇˋ˙]/g, '');
      base = base
        .replace(/ㄅ/g, 'b').replace(/ㄆ/g, 'p').replace(/ㄇ/g, 'm').replace(/ㄈ/g, 'f')
        .replace(/ㄉ/g, 'd').replace(/ㄊ/g, 't').replace(/ㄋ/g, 'n').replace(/ㄌ/g, 'l')
        .replace(/ㄍ/g, 'g').replace(/ㄎ/g, 'k').replace(/ㄏ/g, 'h')
        .replace(/ㄐ/g, 'j').replace(/ㄑ/g, 'q').replace(/ㄒ/g, 'sh')
        .replace(/ㄓ/g, 'zh').replace(/ㄔ/g, 'ch').replace(/ㄕ/g, 'sh').replace(/ㄖ/g, 'r')
        .replace(/ㄗ/g, 'z').replace(/ㄘ/g, 'c').replace(/ㄙ/g, 's');
      base = base
        .replace(/ㄧㄡ/g, 'iou').replace(/ㄧㄠ/g, 'iao')
        .replace(/ㄧㄢ/g, 'ian').replace(/ㄧㄣ/g, 'in')
        .replace(/ㄧㄤ/g, 'iang').replace(/ㄧㄥ/g, 'ing')
        .replace(/ㄨㄚ/g, 'ua').replace(/ㄨㄛ/g, 'uo').replace(/ㄨㄞ/g, 'uai')
        .replace(/ㄨㄟ/g, 'uei').replace(/ㄨㄢ/g, 'uan').replace(/ㄨㄣ/g, 'un')
        .replace(/ㄨㄤ/g, 'uang').replace(/ㄨㄥ/g, 'ong')
        .replace(/ㄩㄝ/g, 'üe').replace(/ㄩㄢ/g, 'üan').replace(/ㄩㄣ/g, 'ün')
        .replace(/ㄚ/g, 'a').replace(/ㄛ/g, 'o').replace(/ㄜ/g, 'e').replace(/ㄝ/g, 'e')
        .replace(/ㄞ/g, 'ai').replace(/ㄟ/g, 'ei').replace(/ㄠ/g, 'ao').replace(/ㄡ/g, 'ou')
        .replace(/ㄢ/g, 'an').replace(/ㄣ/g, 'en').replace(/ㄤ/g, 'ang').replace(/ㄥ/g, 'eng')
        .replace(/ㄦ/g, 'er')
        .replace(/ㄧ/g, 'i').replace(/ㄨ/g, 'u').replace(/ㄩ/g, 'ü');

      if (base.endsWith('ao')) {
        base = base.replace(/ao$/, 'au');
      }
      if (base.startsWith('shiou')) {
        base = base.replace('iou', 'iōu');
      }

      return applyTone(base, tone);
    });

    return {
      ...heteronym,
      bopomofo2: converted.join(' '),
    };
  });
}

/** Response shape for the /raw, /uni, /pua legacy endpoints (README.md §API). */
export interface RawFormatResponse {
  title?: unknown;
  heteronyms: Array<Record<string, unknown>>;
  radical?: unknown;
  stroke_count?: unknown;
  non_radical_stroke_count?: unknown;
}

export function stripAudioIdAndShape(data: unknown): RawFormatResponse {
  if (!data || typeof data !== 'object') {
    return { heteronyms: [] };
  }
  const converted = data as ConvertedDictionaryData;
  const heteronyms = Array.isArray(converted.heteronyms) ? converted.heteronyms : [];
  const result: RawFormatResponse = {
    title: converted.title,
    heteronyms: heteronyms.map((heteronym) => {
      const withoutAudio = { ...heteronym };
      delete withoutAudio.audio_id;
      return withoutAudio;
    }),
  };
  if (converted.radical !== undefined) result.radical = converted.radical;
  if (converted.stroke_count !== undefined) result.stroke_count = converted.stroke_count;
  if (converted.non_radical_stroke_count !== undefined) {
    result.non_radical_stroke_count = converted.non_radical_stroke_count;
  }
  return result;
}

function convertToRawFormat(data: DictionaryEntry): RawFormatResponse {
  const convertedData = convertDictionaryStructure(data);
  if (Array.isArray(convertedData.heteronyms)) {
    convertedData.heteronyms = addBopomofo2(convertedData.heteronyms);
  }
  const cleanedData = cleanRawData(convertedData);
  const withRawCharCode = convertPuaToCharCode(cleanedData);
  return stripAudioIdAndShape(withRawCharCode);
}

function convertToUniFormat(data: DictionaryEntry): RawFormatResponse {
  const convertedData = convertDictionaryStructure(data);
  if (Array.isArray(convertedData.heteronyms)) {
    convertedData.heteronyms = addBopomofo2(convertedData.heteronyms);
  }
  const cleanedData = cleanRawData(convertedData);
  const withIds = convertPuaToIDS(cleanedData);
  return stripAudioIdAndShape(withIds);
}

function convertToPuaFormat(data: DictionaryEntry): RawFormatResponse {
  const convertedData = convertDictionaryStructure(data);
  if (Array.isArray(convertedData.heteronyms)) {
    convertedData.heteronyms = addBopomofo2(convertedData.heteronyms);
  }
  const cleanedData = cleanRawData(convertedData);
  const rawString = JSON.stringify(cleanedData);
  const puaString = rawString
    .replace(/\{\[9264\]\}/g, String.fromCodePoint(0xf9264))
    .replace(/\{\[9064\]\}/g, String.fromCodePoint(0xf9064));
  const parsed = JSON.parse(puaString);
  return stripAudioIdAndShape(parsed);
}

async function getCrossReferences(
  text: string,
  lang: DictionaryLang,
  env: DictionaryEnv,
): Promise<Array<{ lang: DictionaryLang; words: string[] }>> {
  try {
    const xrefPath = `${lang}/xref.json`;
    const xrefObject = await env.DICTIONARY.get(xrefPath);
    if (!xrefObject) {
      return [];
    }

    const xrefData = await xrefObject.text();
    const xref = JSON.parse(xrefData) as XRefData;
    const result: Array<{ lang: DictionaryLang; words: string[] }> = [];

    for (const [targetLang, words] of Object.entries(xref)) {
      const wordData = words[text];
      if (!wordData) continue;
      const wordList = Array.isArray(wordData)
        ? wordData
        : wordData
            .split(',')
            .map((w) => w.trim())
            .filter(Boolean);
      if (wordList.length > 0 && isDictionaryLang(targetLang)) {
        result.push({ lang: targetLang, words: wordList });
      }
    }

    return result;
  } catch {
    return [];
  }
}

async function getCrossReferencesById(
  text: string,
  lang: DictionaryLang,
  env: DictionaryEnv,
): Promise<Array<{ lang: DictionaryLang; byId: Record<string, string[]> }>> {
  try {
    const xrefPath = `${lang}/xref-by-id.json`;
    const xrefObject = await env.DICTIONARY.get(xrefPath);
    if (!xrefObject) {
      return [];
    }

    const xrefData = await xrefObject.text();
    const xref = JSON.parse(xrefData) as XRefByIdData;
    const result: Array<{ lang: DictionaryLang; byId: Record<string, string[]> }> = [];

    for (const [targetLang, byTitle] of Object.entries(xref)) {
      const idMap = byTitle[text];
      if (!idMap) continue;
      if (isDictionaryLang(targetLang)) {
        result.push({ lang: targetLang, byId: idMap });
      }
    }

    return result;
  } catch {
    return [];
  }
}

export async function performFuzzySearch(text: string): Promise<string[]> {
  const cleanText = text.replace(/[`~]/g, '');
  const terms = Array.from(cleanText).filter((char) => char.trim());
  return terms.length > 0 ? terms : cleanText ? [cleanText] : [];
}
