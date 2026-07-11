/**
 * Minimal types for the oEmbed subtree.
 *
 * Deliberately NOT shared with src/pages/DictionaryPage.tsx or
 * src/hooks/useRadicalTooltip.ts: those render an interactive, JS-driven
 * UI inside the trusted first-party app. This subtree renders a static,
 * script-free HTML document served to arbitrary third-party embedders, so
 * it only names the handful of fields it actually reads and keeps its own
 * escaping (see html-escape.ts) rather than pulling in client-rendering
 * code whose trust/navigation assumptions don't apply here.
 */

export type DictionaryLang = "a" | "t" | "h" | "c";

export interface EmbedDefinition {
  type?: string;
  def?: string;
}

export interface EmbedHeteronym {
  bopomofo?: string;
  pinyin?: string;
  trs?: string;
  definitions?: EmbedDefinition[];
}

export interface EmbedDictionaryEntry {
  title?: string;
  heteronyms?: EmbedHeteronym[];
}
