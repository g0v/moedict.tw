/**
 * 筆順動畫速度控制 (issue #98)
 *
 * 三段速度偏好："slow"（慢速）、"normal"（正常速度，預設 —— 與
 * jquery.strokeWords.js 內建的 hardcoded 預設值（delays.stroke/word=0.5、
 * updatesPerStep=10）逐位元相同，維持既有動畫觀感不變）、"fast"（快速）。
 * 持久化於 localStorage `stroke-speed`；套用方式為在呼叫
 * `$(container).strokeWords(words, options)` 時把
 * `resolveStrokeSpeedOptions()` 的結果併入 options（見
 * src/components/StrokeAnimation.tsx）。
 */

export type StrokeSpeedLevel = "slow" | "normal" | "fast";

export interface StrokeSpeedOptions {
  delays: { stroke: number; word: number };
  updatesPerStep: number;
}

interface StrokeSpeedLevelDef extends StrokeSpeedOptions {
  label: string;
}

const STORAGE_KEY = "stroke-speed";
const VALID_LEVELS: readonly StrokeSpeedLevel[] = ["slow", "normal", "fast"];

export const DEFAULT_STROKE_SPEED_LEVEL: StrokeSpeedLevel = "normal";

// updatesPerStep/delays 逐級遞增（慢速較慢、較少更新次數；快速較快、較多更新
// 次數），numbers 取自 jquery.strokeWords.js 既有 hardcoded 預設（normal）
// 上下各推一級。
const STROKE_SPEED_LEVELS: Record<StrokeSpeedLevel, StrokeSpeedLevelDef> = {
  slow: {
    delays: { stroke: 0.8, word: 0.8 },
    updatesPerStep: 6,
    label: "慢速",
  },
  normal: {
    delays: { stroke: 0.5, word: 0.5 },
    updatesPerStep: 10,
    label: "正常速度",
  },
  fast: {
    delays: { stroke: 0.3, word: 0.3 },
    updatesPerStep: 14,
    label: "快速",
  },
};

export const STROKE_SPEED_LABELS: Record<StrokeSpeedLevel, string> = {
  slow: STROKE_SPEED_LEVELS.slow.label,
  normal: STROKE_SPEED_LEVELS.normal.label,
  fast: STROKE_SPEED_LEVELS.fast.label,
};

function isStrokeSpeedLevel(value: string | null): value is StrokeSpeedLevel {
  return value != null && (VALID_LEVELS as readonly string[]).includes(value);
}

/** 讀取偏好；缺失或不合法值一律回傳預設值 "normal"。 */
export function readStrokeSpeedPref(): StrokeSpeedLevel {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isStrokeSpeedLevel(raw) ? raw : DEFAULT_STROKE_SPEED_LEVEL;
  } catch {
    return DEFAULT_STROKE_SPEED_LEVEL;
  }
}

export function writeStrokeSpeedPref(level: StrokeSpeedLevel): StrokeSpeedLevel {
  const next = isStrokeSpeedLevel(level) ? level : DEFAULT_STROKE_SPEED_LEVEL;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Private-mode Safari and similar throw on setItem; ignore.
  }
  return next;
}

/** 將速度等級映射為 strokeWords() 接受的 {delays, updatesPerStep} 選項。 */
export function resolveStrokeSpeedOptions(level: StrokeSpeedLevel): StrokeSpeedOptions {
  const def = isStrokeSpeedLevel(level) ? STROKE_SPEED_LEVELS[level] : STROKE_SPEED_LEVELS.normal;
  return { delays: { ...def.delays }, updatesPerStep: def.updatesPerStep };
}
