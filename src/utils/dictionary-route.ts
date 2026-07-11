/**
 * Shared dictionary URL-scheme helpers.
 *
 * Canonical mapping between a moedict.tw pathname and { lang, text } —
 * the single source of truth for the `'`/`:`/`~` language-prefix scheme
 * used by page routing (App.tsx / MiddlePoint.tsx), HTML-shell head
 * injection (worker/index.ts), and the oEmbed feature (src/oembed/*).
 * Extracted from worker/index.ts so all three stay in lockstep instead of
 * re-deriving the prefix rules.
 */

export type DictionaryLang = 'a' | 't' | 'h' | 'c';

export interface DictionaryDefinition {
  def?: string;
}

export interface DictionaryHeteronym {
  definitions?: DictionaryDefinition[];
}

export interface DictionaryEntryLike {
  heteronyms?: DictionaryHeteronym[];
}

export function stripTags(input: string): string {
  return String(input || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * 語言前綴 → 語言代碼的唯一對照表：`'`=t(臺灣台語)、`:`=h(臺灣客語)、
 * `~`=c(兩岸)、無前綴=a(華語)。API 端另接受 legacy `!` 作為 t 的別名
 * （舊 hash-bang 時代），頁面路由不接受。所有需要「去掉語言前綴」的
 * parser 一律呼叫 stripLangPrefix，不得自建 if-chain。
 */
export function stripLangPrefix(
  text: string,
  extra?: Record<string, DictionaryLang>,
): { lang: DictionaryLang; rest: string } {
  const head = text[0];
  if (head === "'") return { lang: 't', rest: text.slice(1) };
  if (head === ':') return { lang: 'h', rest: text.slice(1) };
  if (head === '~') return { lang: 'c', rest: text.slice(1) };
  if (head !== undefined && extra && extra[head]) return { lang: extra[head], rest: text.slice(1) };
  return { lang: 'a', rest: text };
}

/**
 * Classifies a pathname into a discriminated route kind — the single
 * source of truth for the moedict.tw URL prefix grammar.
 *
 * Owns: leading/trailing slash strip, query-string strip (`?…`),
 * decodeURIComponent (on failure → `{ kind: 'invalid-encoding'; raw }`
 * so callers own their fallback), trailing `/<digits>` idx strip (captured
 * as `idx` on `entry` kinds; silently dropped on non-entry kinds, matching
 * the legacy behavior where idx never bypasses a non-word route), and the
 * ONE canonical prefix-precedence chain:
 *
 *   about (exact) → `@`/`~@` exact+prefix → `*=*` starred family →
 *   `*=` group family → entry prefixes (`'`/`:`/`~`/bare).
 *
 * `pathname` is expected percent-encoded (e.g. `url.pathname`); the
 * `?…` query string is stripped before decoding so callers that pass a
 * full path+query (as head.ts historically did) keep working.
 */
export type ClassifiedRoute =
  | { kind: 'default' }
  | { kind: 'about' }
  | { kind: 'radical'; lang: 'a' | 'c'; radical: string }
  | { kind: 'starred'; lang: DictionaryLang; entry: string }
  | { kind: 'group'; lang: DictionaryLang; category: string }
  | { kind: 'entry'; lang: DictionaryLang; text: string; idx?: number }
  | { kind: 'invalid-encoding'; raw: string };

export function classifyRoute(pathname: string): ClassifiedRoute {
  const cleanPath = String(pathname || '').split('?')[0].replace(/^\/+/, '').replace(/\/+$/, '');
  let decoded: string;
  try {
    decoded = decodeURIComponent(cleanPath);
  } catch {
    return { kind: 'invalid-encoding', raw: cleanPath };
  }
  if (!decoded) return { kind: 'default' };

  let idx: number | undefined;
  const idxMatch = decoded.match(/^(.+)\/(\d+)$/);
  if (idxMatch) {
    decoded = idxMatch[1];
    idx = Number(idxMatch[2]);
  }

  if (decoded === 'about' || decoded === 'about.html') return { kind: 'about' };

  if (decoded === '@') return { kind: 'radical', lang: 'a', radical: '' };
  if (decoded === '~@') return { kind: 'radical', lang: 'c', radical: '' };
  if (decoded.startsWith('@')) return { kind: 'radical', lang: 'a', radical: decoded.slice(1) };
  if (decoded.startsWith('~@')) return { kind: 'radical', lang: 'c', radical: decoded.slice(2) };

  if (decoded.startsWith("'=*")) return { kind: 'starred', lang: 't', entry: decoded.slice(3) };
  if (decoded.startsWith(':=*')) return { kind: 'starred', lang: 'h', entry: decoded.slice(3) };
  if (decoded.startsWith('~=*')) return { kind: 'starred', lang: 'c', entry: decoded.slice(3) };
  if (decoded.startsWith('=*')) return { kind: 'starred', lang: 'a', entry: decoded.slice(2) };

  if (decoded.startsWith("'=")) return { kind: 'group', lang: 't', category: decoded.slice(2) };
  if (decoded.startsWith(':=')) return { kind: 'group', lang: 'h', category: decoded.slice(2) };
  if (decoded.startsWith('~=')) return { kind: 'group', lang: 'c', category: decoded.slice(2) };
  if (decoded.startsWith('=')) return { kind: 'group', lang: 'a', category: decoded.slice(1) };

  const { lang, rest } = stripLangPrefix(decoded);
  return { kind: 'entry', lang, text: rest, idx };
}

/**
 * Parses a pathname into { lang, text, idx? }, or null when it isn't a
 * single dictionary-entry route (about page, radical table, category/
 * starred lists, invalid encoding). Thin wrapper over `classifyRoute` —
 * the single source of truth for the prefix grammar.
 *
 * Malformed `%` escapes produce `classifyRoute`'s `invalid-encoding` kind,
 * which this wrapper maps to null (fail-closed) — reachable with arbitrary
 * caller-supplied input via the oEmbed `url=` query parameter.
 */
export function parseDictionaryRoute(
  pathname: string,
): { lang: DictionaryLang; text: string; idx?: number } | null {
  const route = classifyRoute(pathname);
  if (route.kind === 'entry') {
    const { lang, text, idx } = route;
    return { lang, text, idx };
  }
  return null;
}

export function buildDefinitionDescription(entry: DictionaryEntryLike | null): string | null {
  if (!entry?.heteronyms || entry.heteronyms.length === 0) return null;
  const defs: string[] = [];
  for (const heteronym of entry.heteronyms) {
    const definitions = Array.isArray(heteronym.definitions) ? heteronym.definitions : [];
    for (const definition of definitions) {
      const clean = stripTags(definition.def || '');
      if (!clean) continue;
      defs.push(clean.replace(/[。．\s]+$/g, ''));
      if (defs.length >= 4) break;
    }
    if (defs.length >= 4) break;
  }
  if (defs.length === 0) return null;
  const sentence = `${defs.join('。')}。`;
  return sentence.length > 180 ? `${sentence.slice(0, 179)}…` : sentence;
}

/**
 * Inverse of parseDictionaryRoute: `/word` (a) → `/word`, `/'word` (t),
 * `/:word` (h), `/~word` (c). Shared by the two oEmbed handlers so the
 * canonical-URL scheme has one definition instead of drifting between
 * handle-embed-page.ts and handle-oembed-api.ts.
 */
export function buildDictionaryPathname(lang: DictionaryLang, word: string): string {
  const prefix = lang === 't' ? "'" : lang === 'h' ? ':' : lang === 'c' ? '~' : '';
  return `/${prefix}${encodeURIComponent(word)}`;
}
