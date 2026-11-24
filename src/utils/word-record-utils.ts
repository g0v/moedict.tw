export type DictionaryLang = "a" | "t" | "h" | "c";

const STARRED_KEY_PREFIX = "starred-";
const LRU_KEY_PREFIX = "lru-";
const LAST_LANG_KEY = "lang";
const LAST_WORD_KEY = "prev-id";
const STARRED_SLASH = decodeURIComponent("%5C");
const STARRED_SUFFIX = `${STARRED_SLASH}n`;

function safeGetItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // noop
  }
}

function safeRemoveItem(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // noop
  }
}

function normalizeWord(word: string): string {
  if (!word) return "";
  let next = word;
  try {
    const decoded = decodeURIComponent(next);
    if (decoded) next = decoded;
  } catch {
    // noop
  }
  try {
    next = String(next).trim();
  } catch {
    return "";
  }
  return next;
}

/**
 * Route marks and corpus title markup are not part of a headword.
 * `'`, `:`, `~`, `!` (legacy 台語) and `@` (部首 / cross-ref) are prefixes;
 * `` ` `` and `~` also wrap each character in packed titles (`字~`).
 * A bare prefix collapses to "" so it is never stored.
 */
const HEADWORD_PREFIXES = "'!:@";

export function normalizeRecordedWord(raw: string): string {
  let word = normalizeWord(raw).replace(/<[^>]*>/g, "");
  if (!word) return "";
  word = word.replace(/[`~]/g, "").trim();
  let guard = 0;
  while (word && HEADWORD_PREFIXES.includes(word[0]) && guard < 4) {
    word = word.slice(1).trim();
    guard += 1;
  }
  return word;
}

/**
 * History may be written only for the entry that was actually loaded.
 * While a new lookup is in flight the previous entry is still on screen;
 * recording `queryWord` then stores intermediate search text
 * (stale「萌」+ typed「理」→「萌理」) or a route token (`@`, `@玉`).
 * Returns the normalized headword, or null when this pair must not be stored.
 */
export function lookupHeadwordForHistory(queryWord: string, entryTitle?: string): string | null {
  const query = normalizeRecordedWord(queryWord);
  if (!query || !shouldRecordWord(query)) return null;
  if (typeof entryTitle === "string" && entryTitle.trim()) {
    const title = normalizeRecordedWord(entryTitle);
    if (title && title !== query) return null;
  }
  return query;
}

function normalizeLang(lang: string): DictionaryLang {
  if (lang === "t" || lang === "h" || lang === "c") return lang;
  return "a";
}

export function getStarredStorageKey(lang: DictionaryLang): string {
  return `${STARRED_KEY_PREFIX}${lang}`;
}

export function getLRUStorageKey(lang: DictionaryLang): string {
  return `${LRU_KEY_PREFIX}${lang}`;
}

export function buildStarKey(word: string): string {
  return `"${word}"${STARRED_SUFFIX}`;
}

function ensureStarred(lang: DictionaryLang): string {
  const key = getStarredStorageKey(lang);
  let value = safeGetItem(key);
  if (value == null) {
    safeSetItem(key, "");
    value = "";
  }
  return value;
}

export function hasStarWord(lang: DictionaryLang, rawWord: string): boolean {
  const word = normalizeWord(rawWord);
  if (!word) return false;
  const data = ensureStarred(lang) || "";
  return data.indexOf(buildStarKey(word)) >= 0;
}

export function addStarWord(lang: DictionaryLang, rawWord: string): void {
  const word = normalizeWord(rawWord);
  if (!word) return;
  const key = getStarredStorageKey(lang);
  const current = ensureStarred(lang) || "";
  if (current.indexOf(buildStarKey(word)) >= 0) return;
  safeSetItem(key, buildStarKey(word) + current);
}

export function removeStarWord(lang: DictionaryLang, rawWord: string): void {
  const word = normalizeWord(rawWord);
  if (!word) return;
  const key = getStarredStorageKey(lang);
  const current = ensureStarred(lang) || "";
  const next = current.split(buildStarKey(word)).join("");
  safeSetItem(key, next);
}

export function parseStarredWords(raw: string): string[] {
  const list: string[] = [];
  if (typeof raw !== "string" || !raw) return list;
  const seen: Record<string, 1> = Object.create(null) as Record<string, 1>;
  const re = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const word = match[1];
    if (!word || seen[word]) continue;
    seen[word] = 1;
    list.push(word);
  }
  return list;
}

function pushSanitizedHeadword(list: string[], seen: Record<string, 1>, value: string): void {
  const word = normalizeRecordedWord(value);
  if (!word || seen[word] || !shouldRecordWord(word)) return;
  seen[word] = 1;
  list.push(word);
}

export function parseLRUWords(raw: string): string[] {
  const list: string[] = [];
  if (!raw) return list;
  const seen: Record<string, 1> = Object.create(null) as Record<string, 1>;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const value of parsed) {
        if (typeof value === "string" && value) pushSanitizedHeadword(list, seen, value);
      }
      return list;
    }
  } catch {
    // noop
  }

  const re = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const word = match[1];
    // `[^"]+` never captures an empty token. pushSanitizedHeadword still
    // drops a blank after normalization.
    pushSanitizedHeadword(list, seen, word);
  }
  return list;
}

export function readStarredWords(lang: DictionaryLang): string[] {
  const raw = safeGetItem(getStarredStorageKey(lang)) || "";
  return parseStarredWords(raw);
}

export function readLRUWords(lang: DictionaryLang): string[] {
  const raw = safeGetItem(getLRUStorageKey(lang)) || "";
  return parseLRUWords(raw);
}

export function clearLRUWords(lang: DictionaryLang): void {
  safeRemoveItem(getLRUStorageKey(lang));
}

export function clearStarredWords(lang: DictionaryLang): void {
  safeRemoveItem(getStarredStorageKey(lang));
}

export function shouldRecordWord(rawWord: string): boolean {
  const word = normalizeRecordedWord(rawWord);
  if (!word) return false;
  if (word === "#") return false;
  if (word === "about.html" || word.startsWith("about")) return false;
  if (word === "=*" || word.startsWith("=")) return false;
  if (word.includes("/")) return false;
  if (/\.(html|json|png|jpg|jpeg|gif|svg|css|js)$/i.test(word)) return false;
  return true;
}

export function addToLRU(rawWord: string, lang: DictionaryLang): void {
  const word = normalizeRecordedWord(rawWord);
  if (!shouldRecordWord(word)) return;

  const key = getLRUStorageKey(lang);
  // parseLRUWords drops already-stored junk (bare `@`, `@玉` → 玉) so the
  // next write compacts the bucket instead of preserving it.
  const stored = parseLRUWords(safeGetItem(key) || "").filter((existing) => existing !== word);
  stored.unshift(word);
  const words = stored.length > 50 ? stored.slice(0, 50) : stored;
  safeSetItem(key, JSON.stringify(words));
}

export function removeLRUWord(lang: DictionaryLang, rawWord: string): void {
  const word = normalizeRecordedWord(rawWord);
  if (!word) return;

  const key = getLRUStorageKey(lang);
  const raw = safeGetItem(key);
  if (!raw) return;

  // Reuse parseLRUWords so a legacy quoted-string bucket (pre-JSON-array
  // format) falls back to regex extraction instead of being wiped to `[]`
  // when JSON.parse throws — a single per-item delete must not destroy the
  // rest of an old-format list. Normalization also drops stored route junk.
  const words = parseLRUWords(raw);
  const next = words.filter((existing) => existing !== word);

  safeSetItem(key, JSON.stringify(next));
}

export function writeLastLookup(rawWord: string, lang: DictionaryLang): void {
  const word = normalizeRecordedWord(rawWord);
  if (!shouldRecordWord(word)) return;
  safeSetItem(LAST_LANG_KEY, normalizeLang(lang));
  safeSetItem(LAST_WORD_KEY, word);
}

export function readLastLookup(): { lang: DictionaryLang; word: string } | null {
  const word = normalizeRecordedWord(safeGetItem(LAST_WORD_KEY) || "");
  if (!shouldRecordWord(word)) return null;
  const lang = normalizeLang(safeGetItem(LAST_LANG_KEY) || "a");
  return { lang, word };
}

export interface ImportStarredWordsResult {
  imported: string[];
  skipped: number;
  total: number;
}

/**
 * #219: bounded manual plain-text export. One starred word per line, current
 * storage order (most-recently-starred first, matching addStarWord's own
 * prepend semantics), no trailing metadata/blank line.
 */
export function exportStarredWords(lang: DictionaryLang): string {
  return readStarredWords(lang).join("\n");
}

/**
 * Pure parse/validate/dedupe step for pasted plain text. Splits on
 * CRLF/CR/LF, trims each line, drops blank lines, rejects anything
 * `shouldRecordWord` would reject, and dedupes by first occurrence
 * (matching the seen-map idiom already used by `parseStarredWords` /
 * `parseLRUWords`). Does not consult existing storage — that diff is done
 * by `importStarredWords`, which also needs the raw nonempty-line count to
 * report `skipped`.
 */
export function parseImportedWords(raw: string): string[] {
  const list: string[] = [];
  if (typeof raw !== "string" || !raw.trim()) return list;
  const seen: Record<string, 1> = Object.create(null) as Record<string, 1>;
  const lines = raw.split(/\r\n|\r|\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const word = normalizeRecordedWord(trimmed);
    if (!word || !shouldRecordWord(word) || seen[word]) continue;
    seen[word] = 1;
    list.push(word);
  }
  return list;
}

/**
 * #219: bounded manual plain-text import, current-language starred words
 * only. Merges newly-imported words ahead of untouched existing words,
 * preserving pasted order. `skipped` counts every nonempty line that was
 * invalid, an in-paste duplicate, already starred, or (rare) failed to
 * persist — i.e. `total - imported.length`. Empty/whitespace-only input is
 * a no-op (no storage write). Writes go exclusively through `addStarWord`,
 * so the existing starred-<lang> key/writer stays the single source of
 * truth. `imported` is verified post-write via `hasStarWord` rather than
 * trusted from the pre-write candidate list, so a `localStorage.setItem`
 * failure (quota, private-mode Safari, etc. — swallowed by `safeSetItem`)
 * is reported as skipped instead of falsely claimed as imported.
 */
export function importStarredWords(lang: DictionaryLang, raw: string): ImportStarredWordsResult {
  if (typeof raw !== "string" || !raw.trim()) {
    return { imported: [], skipped: 0, total: 0 };
  }

  const total = raw.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0).length;
  const parsed = parseImportedWords(raw);
  const candidates = parsed.filter((word) => !hasStarWord(lang, word));

  // addStarWord prepends the word to the front of current storage, so a
  // forward loop would reverse pasted order. Iterate in reverse instead:
  // the last call (candidates[0]) lands closest to the front, which
  // preserves pasted order in the final stored sequence.
  for (let i = candidates.length - 1; i >= 0; i--) {
    addStarWord(lang, candidates[i]);
  }

  // Re-verify against storage: safeSetItem silently swallows write
  // failures, so a candidate is only reported as imported if it actually
  // landed.
  const imported = candidates.filter((word) => hasStarWord(lang, word));
  const skipped = total - imported.length;

  return { imported, skipped, total };
}
