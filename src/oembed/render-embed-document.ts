/**
 * Renders the standalone, script-free HTML document served at
 * GET /embed/<word> — the iframe target referenced by the oEmbed API's
 * `html` field. No JS, no external stylesheet: the whole document is
 * self-contained so it stays robust regardless of the main SPA's markup
 * or CSS changing underneath it, and so it can never be an XSS vector
 * even if a definition contains stray markup.
 */

import { escapeHtml, stripTags } from "./html-escape";
import type {
  DictionaryLang,
  EmbedDefinition,
  EmbedDictionaryEntry,
  EmbedHeteronym,
} from "./types";

const MAX_HETERONYMS = 3;
const MAX_DEFS_PER_HETERONYM = 5;

const EMBED_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "PingFang TC", "Microsoft JhengHei", "Heiti TC", sans-serif;
  color: #222;
  background: #fff;
}
.card { display: flex; flex-direction: column; height: 100%; min-height: 100vh; }
header { padding: 10px 14px 4px; border-bottom: 1px solid #eee; }
header h1 { margin: 0; font-size: 22px; font-weight: 600; color: #1a1a1a; }
.body { flex: 1 1 auto; overflow-y: auto; padding: 8px 14px; }
.heteronym + .heteronym { margin-top: 10px; padding-top: 10px; border-top: 1px dashed #e5e5e5; }
.pron { margin: 2px 0 8px; font-size: 14px; color: #646cff; }
.pron .bopomofo { margin-right: 8px; }
.pos-group { margin: 6px 0; }
.pos { display: inline-block; font-size: 11px; color: #fff; background: #8f8f93; border-radius: 3px; padding: 1px 6px; margin-bottom: 4px; }
.pos-group ol { margin: 4px 0 0; padding-left: 20px; }
.pos-group li { margin: 2px 0; font-size: 14px; line-height: 1.5; }
.empty { color: #8f8f93; font-size: 14px; }
footer { padding: 6px 14px 10px; border-top: 1px solid #eee; text-align: right; }
footer a { font-size: 12px; color: #646cff; text-decoration: none; }
footer a:hover { text-decoration: underline; }
`.trim();

function renderPronunciation(heteronym: EmbedHeteronym, lang: DictionaryLang): string {
  // Hakka pronunciation spans multiple 腔 accents behind a dedicated parser
  // on the full DictionaryPage; out of scope for this compact preview, so
  // — matching the same simplification already made by the tooltip card —
  // the pronunciation line is skipped entirely for lang 'h'.
  if (lang === "h") return "";
  const bopomofo = heteronym.bopomofo ? escapeHtml(stripTags(heteronym.bopomofo)) : "";
  const romanization = heteronym.pinyin || heteronym.trs || "";
  const pinyin = romanization ? escapeHtml(stripTags(romanization)) : "";
  if (!bopomofo && !pinyin) return "";
  const bopomofoHtml = bopomofo ? `<span class="bopomofo">${bopomofo}</span>` : "";
  const pinyinHtml = pinyin ? `<span class="pinyin">${pinyin}</span>` : "";
  return `<p class="pron">${bopomofoHtml}${pinyinHtml}</p>`;
}

function groupDefinitionsByType(definitions: EmbedDefinition[]): Map<string, EmbedDefinition[]> {
  const grouped = new Map<string, EmbedDefinition[]>();
  for (const definition of definitions) {
    const key = String(definition.type || "").trim();
    const list = grouped.get(key) ?? [];
    list.push(definition);
    grouped.set(key, list);
  }
  return grouped;
}

function renderDefinitionGroups(definitions: EmbedDefinition[]): string {
  const grouped = groupDefinitionsByType(definitions.slice(0, MAX_DEFS_PER_HETERONYM));
  const groups: string[] = [];
  for (const [type, items] of grouped) {
    const posHtml = type ? `<span class="pos">${escapeHtml(type)}</span>` : "";
    const itemsHtml = items
      .map((item) => stripTags(String(item.def || "")))
      .filter(Boolean)
      .map((text) => `<li>${escapeHtml(text)}</li>`)
      .join("");
    if (!itemsHtml) continue;
    groups.push(`<div class="pos-group">${posHtml}<ol>${itemsHtml}</ol></div>`);
  }
  return groups.join("");
}

function renderHeteronymSection(heteronym: EmbedHeteronym, lang: DictionaryLang): string {
  const pronunciationHtml = renderPronunciation(heteronym, lang);
  const definitions = Array.isArray(heteronym.definitions) ? heteronym.definitions : [];
  const definitionsHtml = renderDefinitionGroups(definitions);
  if (!pronunciationHtml && !definitionsHtml) return "";
  return `<section class="heteronym">${pronunciationHtml}${definitionsHtml}</section>`;
}

function renderDocument(title: string, bodyHtml: string, canonicalUrl: string): string {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} - 萌典</title>
<style>${EMBED_CSS}</style>
</head>
<body>
<div class="card">
<header><h1>${escapeHtml(title)}</h1></header>
<div class="body">${bodyHtml}</div>
<footer><a href="${escapeHtml(canonicalUrl)}" target="_blank" rel="noopener noreferrer">在萌典查看完整條目 ↗</a></footer>
</div>
</body>
</html>`;
}

export interface RenderEmbedDocumentParams {
  word: string;
  lang: DictionaryLang;
  entry: EmbedDictionaryEntry;
  canonicalUrl: string;
}

export function renderEmbedDocument({
  word,
  lang,
  entry,
  canonicalUrl,
}: RenderEmbedDocumentParams): string {
  const title = stripTags(String(entry.title || word)) || word;
  const heteronyms = Array.isArray(entry.heteronyms)
    ? entry.heteronyms.slice(0, MAX_HETERONYMS)
    : [];
  const sections = heteronyms
    .map((heteronym) => renderHeteronymSection(heteronym, lang))
    .filter(Boolean);
  const bodyHtml =
    sections.length > 0 ? sections.join("") : '<p class="empty">找不到這個詞條的說明。</p>';
  return renderDocument(title, bodyHtml, canonicalUrl);
}

export function renderEmbedNotFound(word: string): string {
  const title = word ? stripTags(word) : "找不到條目";
  const bodyHtml = '<p class="empty">找不到這個詞條。</p>';
  return renderDocument(title, bodyHtml, "https://www.moedict.tw/");
}
