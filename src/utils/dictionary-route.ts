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

export type DictionaryLang = "a" | "t" | "h" | "c";

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
  return String(input || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * decodeURIComponent 的不丟例外版本：壞的 percent-encoding（如路徑含裸 `%`）
 * 回傳 null，呼叫端自行決定 fallback（fail-closed 或改用未解碼原字串）。
 * 所有處理 request 路徑的 decode 一律用這個，禁止裸呼 decodeURIComponent
 * ——例外往上冒就是 500。
 */
export function tryDecodeURIComponent(input: string): string | null {
  try {
    return decodeURIComponent(input);
  } catch {
    return null;
  }
}

/**
 * Legacy hashbang 相容（g0v/moedict-webkit#131）：詞條內文的互相參照、
 * 部首標籤、注音／台羅 ruby 連結至今仍沿用 2014 版 hashbang 慣例，產生
 * `./#'word` 形式的 href（見 handleDictionaryAPI.ts 的 HASH_OF、
 * useRadicalTooltip.ts、DictionaryPage.tsx 的部首連結、
 * bopomofo-pinyin-utils.ts）。本站所有路由都是單一路徑段，`./` 一律解析
 * 回站台根目錄，因此瀏覽器最終落在 pathname `/` + hash `#'word`。一般
 * 點擊由 DictionaryPage 的 onContentClick 攔截並用 normalizeHref 正確
 * 導頁，但瀏覽器不經過 click handler 的情境——開新分頁
 * （middle-click／⌘-click 會略過 preventDefault）、右鍵複製連結網址、
 * 直接輸入或分享網址——只會把 pathname `/` 送給伺服器；`#` 之後的內容
 * 從不隨 HTTP 請求送出，伺服器端無從得知，只能回傳首頁。這正是回報者
 * 看到「連到 #'煏 而非 '煏」的根因，且比 2014 年版更嚴重：原版是
 * hashbang-only SPA，雜湊本來就是唯一路由來源；現在雜湊只是殘留格式，
 * 路由已改用真實 pathname，雜湊落地無人處理。
 *
 * 純函式：給定目前 `pathname`／`hash`，若符合「首頁 + 舊式雜湊路由」，
 * 回傳應該 `replaceState` 過去的新 pathname；否則回傳 null——刻意只在
 * pathname 為 "/" 時處理，避免誤吃版面內真正的同頁錨點（navbar 選單的
 * `href="#"`、About 頁 `#how-to-use`，這些從不落在 "/" 但仍保守排除
 * 空 hash 本身）。呼叫端（main.tsx）在 React Router 掛載前執行一次；
 * 之後的路由分類全部交回 classifyRoute，這裡不自建前綴 if-chain。
 */
export function resolveLegacyHashRoute(pathname: string, hash: string): string | null {
  if (pathname !== "/") return null;
  const token = hash.replace(/^#/, "");
  if (!token) return null;
  const decoded = tryDecodeURIComponent(token);
  if (!decoded) return null;
  return `/${decoded}`;
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
  if (head === "'") return { lang: "t", rest: text.slice(1) };
  if (head === ":") return { lang: "h", rest: text.slice(1) };
  if (head === "~") return { lang: "c", rest: text.slice(1) };
  if (head !== undefined && extra && extra[head]) return { lang: extra[head], rest: text.slice(1) };
  return { lang: "a", rest: text };
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
 *   about (exact) → `@`/`'@`/`:@`/`~@` exact+prefix → `*=*` starred family →
 *   `*=` group family → entry prefixes (`'`/`:`/`~`/bare).
 *
 * `pathname` is expected percent-encoded (e.g. `url.pathname`); the
 * `?…` query string is stripped before decoding so callers that pass a
 * full path+query (as head.ts historically did) keep working.
 */
export type ClassifiedRoute =
  | { kind: "default" }
  | { kind: "about" }
  | { kind: "radical"; lang: DictionaryLang; radical: string }
  | { kind: "starred"; lang: DictionaryLang; entry: string }
  | { kind: "group"; lang: DictionaryLang; category: string }
  | { kind: "entry"; lang: DictionaryLang; text: string; idx?: number }
  | { kind: "invalid-encoding"; raw: string };

export function classifyRoute(pathname: string): ClassifiedRoute {
  const cleanPath = String(pathname || "")
    .split("?")[0]
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  let decoded = tryDecodeURIComponent(cleanPath);
  if (decoded === null) return { kind: "invalid-encoding", raw: cleanPath };
  if (!decoded) return { kind: "default" };

  let idx: number | undefined;
  const idxMatch = decoded.match(/^(.+)\/(\d+)$/);
  if (idxMatch) {
    decoded = idxMatch[1];
    idx = Number(idxMatch[2]);
  }

  if (decoded === "about" || decoded === "about.html") return { kind: "about" };

  if (decoded === "@") return { kind: "radical", lang: "a", radical: "" };
  if (decoded === "~@") return { kind: "radical", lang: "c", radical: "" };
  if (decoded === "'@") return { kind: "radical", lang: "t", radical: "" };
  if (decoded === ":@") return { kind: "radical", lang: "h", radical: "" };
  if (decoded.startsWith("@")) return { kind: "radical", lang: "a", radical: decoded.slice(1) };
  if (decoded.startsWith("~@")) return { kind: "radical", lang: "c", radical: decoded.slice(2) };
  if (decoded.startsWith("'@")) return { kind: "radical", lang: "t", radical: decoded.slice(2) };
  if (decoded.startsWith(":@")) return { kind: "radical", lang: "h", radical: decoded.slice(2) };

  if (decoded.startsWith("'=*")) return { kind: "starred", lang: "t", entry: decoded.slice(3) };
  if (decoded.startsWith(":=*")) return { kind: "starred", lang: "h", entry: decoded.slice(3) };
  if (decoded.startsWith("~=*")) return { kind: "starred", lang: "c", entry: decoded.slice(3) };
  if (decoded.startsWith("=*")) return { kind: "starred", lang: "a", entry: decoded.slice(2) };

  if (decoded.startsWith("'=")) return { kind: "group", lang: "t", category: decoded.slice(2) };
  if (decoded.startsWith(":=")) return { kind: "group", lang: "h", category: decoded.slice(2) };
  if (decoded.startsWith("~=")) return { kind: "group", lang: "c", category: decoded.slice(2) };
  if (decoded.startsWith("=")) return { kind: "group", lang: "a", category: decoded.slice(1) };

  const { lang, rest } = stripLangPrefix(decoded);
  return { kind: "entry", lang, text: rest, idx };
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
  if (route.kind === "entry") {
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
      const clean = stripTags(definition.def || "");
      if (!clean) continue;
      defs.push(clean.replace(/[。．\s]+$/g, ""));
      if (defs.length >= 4) break;
    }
    if (defs.length >= 4) break;
  }
  if (defs.length === 0) return null;
  const sentence = `${defs.join("。")}。`;
  return sentence.length > 180 ? `${sentence.slice(0, 179)}…` : sentence;
}

/**
 * Inverse of parseDictionaryRoute: `/word` (a) → `/word`, `/'word` (t),
 * `/:word` (h), `/~word` (c). Shared by the two oEmbed handlers so the
 * canonical-URL scheme has one definition instead of drifting between
 * handle-embed-page.ts and handle-oembed-api.ts.
 */
export function buildDictionaryPathname(lang: DictionaryLang, word: string): string {
  const prefix = lang === "t" ? "'" : lang === "h" ? ":" : lang === "c" ? "~" : "";
  return `/${prefix}${encodeURIComponent(word)}`;
}
