/**
 * 復刻 moedict-webkit 舊版搜尋框的萬用字元語意：
 * - `*`/`%`：任意長度
 * - `?`/`.`/`_`：單一字元
 * - `^`/`$`：開頭／結尾
 */

function escapeRegex(text: string): string {
  return text.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

export function normalizeLegacySearchKeyword(keyword: string): string {
  return (
    keyword
      .replace(/\*/g, "%")
      // iOS/Safari 可能將連續三個句點自動替換成單一省略號字元（…）
      .replace(/…/g, "...")
      .replace(/[-—]/g, "－")
      .replace(/[,﹐]/g, "，")
      .replace(/[;﹔]/g, "；")
      .replace(/[﹒．]/g, "。")
  );
}

export function hasLegacyPatternOperators(keyword: string): boolean {
  const normalizedKeyword = normalizeLegacySearchKeyword(keyword);
  return /[%?._^$*]/.test(normalizedKeyword);
}

function getPlainSearchPriorityNeedle(keyword: string): string | null {
  const normalizedKeyword = normalizeLegacySearchKeyword(keyword);
  if (!normalizedKeyword.trim()) {
    return null;
  }
  if (normalizedKeyword !== normalizedKeyword.trim()) {
    return null;
  }
  if (/[%?._^$*]/.test(normalizedKeyword)) {
    return null;
  }

  return normalizedKeyword.replace(/\s/g, "");
}

function buildLegacySearchMatcher(keyword: string): ((word: string) => boolean) | null {
  const normalizedKeyword = normalizeLegacySearchKeyword(keyword);
  if (!normalizedKeyword.trim()) {
    return null;
  }

  const hasWildcard = /[%?._]/.test(normalizedKeyword);
  const anchorStart = /\s$/.test(normalizedKeyword) || /\^/.test(normalizedKeyword);
  const anchorEnd = /^\s/.test(normalizedKeyword) || /\$/.test(normalizedKeyword);
  const bareKeyword = normalizedKeyword.replace(/\^/g, "").replace(/\$/g, "").replace(/\s/g, "");

  let source = "";
  for (const char of Array.from(bareKeyword)) {
    if (char === "%") {
      source += ".*";
      continue;
    }
    if (char === "?" || char === "." || char === "_") {
      source += ".";
      continue;
    }
    source += escapeRegex(char);
  }

  if (hasWildcard) {
    source = `^${source}$`;
  } else {
    if (anchorStart) {
      source = `^${source}`;
    }
    if (anchorEnd) {
      source = `${source}$`;
    }
  }

  try {
    const matcher = new RegExp(source);
    return (word: string) => matcher.test(word);
  } catch {
    return null;
  }
}

export function collectLegacyMatchedTerms(list: string[], keyword: string): string[] {
  const matcher = buildLegacySearchMatcher(keyword);
  if (!matcher) {
    return [];
  }

  const priorityNeedle = getPlainSearchPriorityNeedle(keyword);
  if (!priorityNeedle) {
    const matched: string[] = [];
    for (const term of list) {
      if (!matcher(term)) continue;
      matched.push(term);
    }
    return matched;
  }

  const exactMatches: string[] = [];
  const prefixMatches: string[] = [];
  const containsMatches: string[] = [];
  for (const term of list) {
    if (!matcher(term)) continue;
    if (term === priorityNeedle) {
      exactMatches.push(term);
      continue;
    }
    if (term.startsWith(priorityNeedle)) {
      prefixMatches.push(term);
      continue;
    }
    containsMatches.push(term);
  }

  return [...exactMatches, ...prefixMatches, ...containsMatches];
}
