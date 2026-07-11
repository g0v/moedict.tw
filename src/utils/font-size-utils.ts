const STORAGE_KEY = "font-size";
const MIN_PT = 10;
const MAX_PT = 42;

export const DEFAULT_FONT_SIZE_PT = 14;
export const FONT_SIZE_MIN_PT = MIN_PT;
export const FONT_SIZE_MAX_PT = MAX_PT;

export function clampFontSize(pt: number): number {
  if (!Number.isFinite(pt)) return DEFAULT_FONT_SIZE_PT;
  return Math.max(MIN_PT, Math.min(MAX_PT, Math.round(pt)));
}

export function readFontSize(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw == null ? DEFAULT_FONT_SIZE_PT : clampFontSize(Number.parseInt(raw, 10));
  } catch {
    return DEFAULT_FONT_SIZE_PT;
  }
}

export function writeFontSize(pt: number): number {
  const clamped = clampFontSize(pt);
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clamped));
  } catch {
    // Private-mode Safari and similar throw on setItem; ignore.
  }
  return clamped;
}

export function applyFontSize(pt: number): void {
  document.body.style.fontSize = `${clampFontSize(pt)}pt`;
}
