export type RadicalLang = "a" | "c" | "t";

/**
 * 部首表語言前綴：`'`=t(臺灣台語)、`~`=c(兩岸)、無前綴=a(華語)。與
 * dictionary-route.ts 的 stripLangPrefix 同一張對照表（h 目前無部首表，
 * 見 g0v/moedict-webkit#122：phck pack 來源完全沒有 r 欄位，屬資料缺口，
 * 非本表可修）。
 */
const RADICAL_LANG_PREFIXES: Record<RadicalLang, string> = { a: "", c: "~", t: "'" };

export function getRadicalLangPrefix(lang: RadicalLang): string {
  return RADICAL_LANG_PREFIXES[lang];
}

export interface DictionaryDefinition {
  type?: string;
  def?: string;
}

export interface DictionaryHeteronym {
  bopomofo?: string;
  pinyin?: string;
  trs?: string;
  alt?: string;
  definitions?: DictionaryDefinition[];
}

export interface DictionaryEntryResponse {
  title?: string;
  heteronyms?: DictionaryHeteronym[];
}

function decodeSafe(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

export function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function stripTags(input: string): string {
  return String(input || "").replace(/<[^>]*>/g, "");
}

export function normalizeRadicalVariant(input: string): string {
  return input === "靑" ? "青" : input;
}

export function normalizeRows(raw: unknown): string[][] {
  try {
    if (!raw) return [];

    if (typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((key) => /^\d+$/.test(key))
        .map((key) => Number.parseInt(key, 10));
      const max = keys.length > 0 ? Math.max(...keys) : -1;
      const rows: string[][] = [];
      for (let i = 0; i <= max; i += 1) {
        const row = obj[String(i)];
        rows[i] = Array.isArray(row)
          ? row.filter(Boolean).map((item) => normalizeRadicalVariant(String(item)))
          : [];
      }
      return rows;
    }

    if (Array.isArray(raw) && raw.every((row) => Array.isArray(row) || row == null)) {
      return raw.map((row) =>
        Array.isArray(row)
          ? row.filter(Boolean).map((item) => normalizeRadicalVariant(String(item)))
          : [],
      );
    }

    if (Array.isArray(raw)) {
      return [raw.filter(Boolean).map((item) => normalizeRadicalVariant(String(item)))];
    }

    return [];
  } catch {
    return [];
  }
}

export function normalizeTooltipId(rawId: string): string {
  const decoded = decodeSafe(String(rawId || ""));
  const normalized = decoded
    .replace(/^\.(?:\/)?/, "")
    .replace(/^\//, "")
    .replace(/^#/, "")
    .trim();
  return normalized.replace(/^([~':!]?)[`]+/, "$1").replace(/~+$/, "");
}

export function getTokenByLang(lang: RadicalLang, token: string): string {
  return `${RADICAL_LANG_PREFIXES[lang]}${token}`;
}

export async function fetchJsonByToken<T>(token: string): Promise<T | null> {
  const safeToken = String(token || "").trim();
  if (!safeToken) return null;
  const response = await fetch(`/api/${encodeURIComponent(safeToken)}.json`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return null;
  return (await response.json()) as T;
}

export async function fetchRadicalRows(
  lang: RadicalLang,
  token: "@" | `@${string}`,
): Promise<string[][]> {
  const apiToken = getTokenByLang(lang, token);
  const raw = await fetchJsonByToken<unknown>(apiToken);
  return normalizeRows(raw);
}
