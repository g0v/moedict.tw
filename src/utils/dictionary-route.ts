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
 * Parses a pathname into { lang, text, idx? }, or null when it isn't a
 * single dictionary-entry route (about page, radical table, category/
 * starred lists). `pathname` is expected percent-encoded (e.g.
 * `url.pathname`); malformed `%` escapes decode-fail closed to null rather
 * than throwing — this is reachable with arbitrary caller-supplied input
 * via the oEmbed `url=` query parameter, not just internal navigation.
 *
 * A trailing `/<digits>` segment (`/萌/2`) is the legacy definition-index
 * permalink (g0v/moedict-webkit's `/:text/:idx` — deep-links to the idx-th
 * definition across all of a word's heteronyms, 1-based). It's stripped
 * before the lang/text checks below so every existing route shape keeps
 * working unchanged; `idx` is only meaningful to word-entry consumers
 * (DictionaryPage) and is silently ignored by anything else that doesn't
 * ask for it (radical/list/starred routes, oEmbed, OG head text).
 */
export function parseDictionaryRoute(
  pathname: string,
): { lang: DictionaryLang; text: string; idx?: number } | null {
  let raw: string;
  try {
    raw = decodeURIComponent(String(pathname || '').replace(/^\/+/, '').replace(/\/+$/, ''));
  } catch {
    return null;
  }
  if (!raw) return null;

  let idx: number | undefined;
  const idxMatch = raw.match(/^(.+)\/(\d+)$/);
  if (idxMatch) {
    raw = idxMatch[1];
    idx = Number(idxMatch[2]);
  }

  if (raw === 'about' || raw === 'about.html') return null;
  if (raw.startsWith('@') || raw.startsWith('~@')) return null;
  if (raw.startsWith('=')) return null;
  if (raw.startsWith("'=*") || raw.startsWith(':=*') || raw.startsWith('~=*') || raw.startsWith('=*')) return null;
  if (raw.startsWith("'=") || raw.startsWith(':=') || raw.startsWith('~=')) return null;
  if (raw.startsWith("'")) return { lang: 't', text: raw.slice(1), idx };
  if (raw.startsWith(':')) return { lang: 'h', text: raw.slice(1), idx };
  if (raw.startsWith('~')) return { lang: 'c', text: raw.slice(1), idx };
  return { lang: 'a', text: raw, idx };
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
