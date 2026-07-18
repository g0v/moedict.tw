/**
 * 深色模式偏好設定 (g0v/moedict-webkit#245)
 *
 * 三態偏好："system"（跟隨作業系統 prefers-color-scheme，預設）、"light"、
 * "dark"。持久化於 localStorage `theme`，套用方式為在 <html> 設置
 * `data-theme` 屬性 —— 對應的 CSS 變數定義在 src/index.css。
 */

export type ThemePref = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "theme";
const VALID_PREFS: readonly ThemePref[] = ["system", "light", "dark"];

export const DEFAULT_THEME_PREF: ThemePref = "system";

function isThemePref(value: string | null): value is ThemePref {
  return value != null && (VALID_PREFS as readonly string[]).includes(value);
}

export function readThemePref(): ThemePref {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isThemePref(raw) ? raw : DEFAULT_THEME_PREF;
  } catch {
    return DEFAULT_THEME_PREF;
  }
}

export function writeThemePref(pref: ThemePref): ThemePref {
  const next = isThemePref(pref) ? pref : DEFAULT_THEME_PREF;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Private-mode Safari and similar throw on setItem; ignore.
  }
  return next;
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref !== "system") return pref;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/**
 * Reflects `pref` onto <html>: sets/clears `data-theme` (consumed by the CSS
 * custom properties in src/index.css) and the native `color-scheme` so
 * unstyled form controls / scrollbars follow the same choice. Returns the
 * resolved theme for callers that want to display it.
 */
export function applyTheme(pref: ThemePref): ResolvedTheme {
  const root = document.documentElement;
  if (pref === "system") {
    root.removeAttribute("data-theme");
    root.style.colorScheme = "light dark";
  } else {
    root.setAttribute("data-theme", pref);
    root.style.colorScheme = pref;
  }
  return resolveTheme(pref);
}
