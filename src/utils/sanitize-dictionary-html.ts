import { parseDocument } from "htmlparser2";

// The corpus uses these elements for definitions, cross-references, ruby, and
// pronunciation. Rebuild the output from parsed nodes so unknown markup and
// attributes never cross an HTML sink unchanged.
const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "diao",
  "div",
  "em",
  "font",
  "hruby",
  "i",
  "li",
  "ol",
  "p",
  "rb",
  "rt",
  "rtc",
  "ru",
  "ruby",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "yin",
  "zhuyin",
]);
const BLOCKED_SUBTREES = new Set([
  "audio",
  "base",
  "embed",
  "form",
  "iframe",
  "img",
  "link",
  "math",
  "meta",
  "noscript",
  "object",
  "option",
  "script",
  "select",
  "style",
  "svg",
  "template",
  "textarea",
  "video",
  "xmp",
]);
const VOID_TAGS = new Set(["br"]);
const GLOBAL_ATTRIBUTES = new Set(["class", "lang", "title"]);
const TAG_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  a: new Set(["href"]),
  div: new Set(["data-title"]),
  font: new Set(["color"]),
  hruby: new Set(["rightangle"]),
  ru: new Set(["annotation", "diao", "form", "length", "order", "span", "zhuyin"]),
  span: new Set(["aria-hidden", "style"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
};

interface HtmlNode {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: HtmlNode[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isSameOriginHref(href: string): boolean {
  if (!href.trim()) return false;
  try {
    const origin = new URL(href, "https://www.moedict.tw/").origin;
    return origin === "https://www.moedict.tw" || origin === "https://moedict.tw";
  } catch {
    return false;
  }
}

function renderNode(node: HtmlNode, lookupOnly: boolean, depth: number): string {
  if (node.type === "text") return escapeHtml(node.data || "");
  if (depth >= 50 || !node.name) return "";

  const tag = node.name.toLowerCase();
  if (BLOCKED_SUBTREES.has(tag)) return "";
  const children = (node.children || [])
    .map((child) => renderNode(child, lookupOnly, depth + 1))
    .join("");
  if (!ALLOWED_TAGS.has(tag) || (lookupOnly && tag !== "a")) return children;

  const attributes = node.attribs || {};
  if (tag === "a") {
    const href = attributes.href || "";
    if (!isSameOriginHref(href) || (lookupOnly && !href.startsWith("./#"))) return children;
  }

  const renderedAttributes: string[] = [];
  for (const [name, value] of Object.entries(attributes)) {
    if (lookupOnly && name !== "href") continue;
    if (!GLOBAL_ATTRIBUTES.has(name) && !TAG_ATTRIBUTES[tag]?.has(name)) continue;
    if (name === "aria-hidden" && value !== "true") continue;
    if (name === "style") {
      // rightAngle() emits this one fixed, defensive style for its selectable
      // reading. All corpus-supplied styles are discarded.
      if (
        tag !== "span" ||
        !attributes.class?.split(/\s+/).includes("romanization-selectable") ||
        value !== "text-indent: -9999px; color: transparent"
      )
        continue;
      renderedAttributes.push('style="text-indent:-9999px;color:transparent"');
      continue;
    }
    renderedAttributes.push(`${name}="${escapeHtml(value)}"`);
  }
  const openTag = `<${tag}${renderedAttributes.length ? ` ${renderedAttributes.join(" ")}` : ""}`;
  return VOID_TAGS.has(tag) ? `${openTag}>` : `${openTag}>${children}</${tag}>`;
}

export function sanitizeDictionaryHtml(html: string, lookupOnly = false): string {
  const document = parseDocument(String(html), { decodeEntities: true });
  return document.children.map((node) => renderNode(node as HtmlNode, lookupOnly, 0)).join("");
}
