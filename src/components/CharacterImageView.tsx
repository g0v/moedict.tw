import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SvgIcon } from "./SvgIcon";
import { fetchDictionaryEntry, type DictionaryLang } from "../utils/dictionary-cache";
import { formatBopomofo, formatPinyin } from "../utils/bopomofo-pinyin-utils";

// eslint-disable-next-line react-refresh/only-export-components
export function renderFormattedPhonetics(markup: string) {
  const parts = markup.split(/(<span class="tone">|<\/span>)/);
  return parts.map((part, index) =>
    part === '<span class="tone">' || part === "</span>" ? null : (
      <span key={index} className={parts[index - 1] === '<span class="tone">' ? "tone" : undefined}>
        {part}
      </span>
    ),
  );
}

interface FontGroup {
  label: string;
  fonts: { value: string; label: string }[];
}

const FONT_GROUPS: FontGroup[] = [
  {
    label: "全字庫",
    fonts: [
      { value: "kai", label: "楷書" },
      { value: "sung", label: "宋體" },
      { value: "ebas", label: "篆文" },
    ],
  },
  {
    label: "源雲明體",
    fonts: [
      { value: "gwmel", label: "特細" },
      { value: "gwml", label: "細體" },
      { value: "gwmr", label: "標準" },
      { value: "gwmm", label: "正明" },
      { value: "gwmsb", label: "中明" },
    ],
  },
  { label: "Justfont", fonts: [{ value: "openhuninn", label: "Open 粉圓" }] },
  { label: "逢甲大學", fonts: [{ value: "shuowen", label: "說文標篆" }] },
  {
    label: "cwTeX Q",
    fonts: [
      { value: "cwming", label: "明體" },
      { value: "cwhei", label: "黑體" },
      { value: "cwyuan", label: "圓體" },
      { value: "cwkai", label: "楷書" },
      { value: "cwfangsong", label: "仿宋" },
    ],
  },
  {
    label: "思源宋體",
    fonts: [
      { value: "shsx", label: "特細" },
      { value: "shsl", label: "細體" },
      { value: "shsr", label: "標準" },
      { value: "shsm", label: "正宋" },
      { value: "shss", label: "中宋" },
      { value: "shsb", label: "粗體" },
      { value: "shsh", label: "特粗" },
    ],
  },
  {
    label: "思源黑體",
    fonts: [
      { value: "srcx", label: "特細" },
      { value: "srcl", label: "細體" },
      { value: "srcn", label: "標準" },
      { value: "srcr", label: "正黑" },
      { value: "srcm", label: "中黑" },
      { value: "srcb", label: "粗體" },
      { value: "srch", label: "特粗" },
    ],
  },
  {
    label: "王漢宗",
    fonts: [
      { value: "wt071", label: "中行書" },
      { value: "wt024", label: "中仿宋" },
      { value: "wt021", label: "中隸書" },
      { value: "wt001", label: "細明體" },
      { value: "wt002", label: "中明體" },
      { value: "wt003", label: "粗明體" },
      { value: "wt005", label: "超明體" },
      { value: "wt004", label: "特明體" },
      { value: "wt006", label: "細圓體" },
      { value: "wt009", label: "特圓體" },
      { value: "wt011", label: "細黑體" },
      { value: "wt014", label: "特黑體" },
      { value: "wt064", label: "顏楷體" },
      { value: "wt028", label: "空疊圓" },
      { value: "wt034", label: "勘亭流" },
      { value: "wt040", label: "綜藝體" },
      { value: "wtcc02", label: "酷儷海報" },
      { value: "wtcc15", label: "酷正海報" },
      { value: "wthc06", label: "鋼筆行楷" },
    ],
  },
];

function getStoredFont(): string {
  try {
    return window.localStorage.getItem("charimg-font") || "kai";
  } catch {
    return "kai";
  }
}

function setStoredFont(value: string): void {
  try {
    window.localStorage.setItem("charimg-font", value);
  } catch {
    /* ignore */
  }
}

/** romanize=1 字圖標註 checkbox 的持久化（RESCOPE #169）；預設關閉，維持
 *  既有字圖預設輸出不變（fail-open：讀取/寫入失敗一律視為未開啟）。 */
function getStoredRomanize(): boolean {
  try {
    return window.localStorage.getItem("charimg-romanize") === "1";
  } catch {
    return false;
  }
}

function setStoredRomanize(value: boolean): void {
  try {
    window.localStorage.setItem("charimg-romanize", value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function charImgUrl(word: string, font: string, lang: DictionaryLang, romanize: boolean): string {
  const base = `https://www.moedict.tw/${encodeURIComponent(word)}.png`;
  const params = new URLSearchParams();
  if (font !== "kai") params.set("font", font);
  if (romanize) {
    params.set("romanize", "1");
    params.set("lang", lang);
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

interface CharacterImageViewProps {
  queryWord: string;
  terms: string[];
  lang: DictionaryLang;
  langTokenPrefix: string;
}

interface TermSegment {
  part: string;
  href: string | null;
  def: string;
  /** 整詞羅馬拼音／台羅／拼音（第一個 heteronym；lang='h' 一律為空字串，
   *  documented Hakka exclusion，同 fetchWholeWordRomanization）。 */
  pinyin: string;
  /** 注音符號（僅 lang='a'/'c' 有意義；t/h 一律為空字串）。 */
  bopomofo: string;
}

interface DrawState {
  drawing: boolean;
  input: "pointer" | "touch" | "mouse";
  pointerId: number | null;
  lastX: number;
  lastY: number;
}

const SEGMENT_IMAGE_SIZE = 160;

function setDrawingStyle(
  context: CanvasRenderingContext2D,
  ratio: number,
  width: number,
  height: number,
): void {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width * ratio, height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = 3.6;
  context.strokeStyle = "rgba(27, 56, 89, 0.85)";
  context.fillStyle = "rgba(27, 56, 89, 0.85)";
}

function resetPracticeCanvas(canvas: HTMLCanvasElement, width: number, height: number): void {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.dataset.width = String(width);
  canvas.dataset.height = String(height);

  const context = canvas.getContext("2d");
  if (!context) return;
  setDrawingStyle(context, ratio, width, height);
}

function getCanvasPoint(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

function isTouchPointerEvent(event: React.PointerEvent<HTMLCanvasElement>): boolean {
  return event.pointerType === "touch" && typeof window !== "undefined" && "TouchEvent" in window;
}

function trySetPointerCapture(canvas: HTMLCanvasElement, pointerId: number): void {
  try {
    canvas.setPointerCapture?.(pointerId);
  } catch {
    // iOS WKWebView can reject pointer capture even when PointerEvent exists.
  }
}

function tryReleasePointerCapture(canvas: HTMLCanvasElement, pointerId: number): void {
  try {
    if (canvas.hasPointerCapture?.(pointerId)) {
      canvas.releasePointerCapture?.(pointerId);
    }
  } catch {
    // Ignore platform-specific capture state mismatches.
  }
}

function mergeEnglishTerms(terms: string[]): string[] {
  const merged: string[] = [];
  for (const term of terms) {
    const token = String(term || "");
    if (!token) continue;
    if (
      /^[A-Za-z]+$/.test(token) &&
      merged.length > 0 &&
      /^[A-Za-z]+$/.test(merged[merged.length - 1])
    ) {
      merged[merged.length - 1] += token;
      continue;
    }
    merged.push(token);
  }
  return merged;
}

function expandDef(def: string): string {
  return def
    .replace(
      /^\s*<(\d)>\s*([介代副助動名歎嘆形連]?)/,
      (_, num: string, char: string) =>
        `${String.fromCharCode(0x327f + parseInt(num))}${char ? `${char}\u20DE` : ""}`,
    )
    .replace(/<(\d)>/g, (_, num: string) => String.fromCharCode(0x327f + parseInt(num)))
    .replace(/\{(\d)\}/g, (_, num: string) => String.fromCharCode(0x2775 + parseInt(num)))
    .replace(/[（(](\d)[)）]/g, (_, num: string) => String.fromCharCode(0x2789 + parseInt(num)))
    .replace(/\(/g, "（")
    .replace(/\)/g, "）")
    .replace(/<[^>]*>/g, "");
}

function extractDef(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const entry = data as Record<string, unknown>;
  const heteronyms = entry.heteronyms as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(heteronyms)) return "";

  let result = "";
  for (const h of heteronyms) {
    const defs = h.definitions as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(defs)) continue;
    for (const d of defs) {
      const f = d.def as string | undefined;
      const l = d.link as string | undefined;
      if (f) result += f;
      else if (l) result += l;
    }
  }
  return expandDef(result);
}

/** 第一個 heteronym 的整詞羅馬拼音（RESCOPE #169：與 src/utils/image-generation.ts
 *  的 fetchWholeWordRomanization 相同慣例——lang='h' 一律回傳空字串；'pinyin'
 *  欄位缺席時退回 'trs'，兩者皆由伺服端資料直接提供，不在前端推導）。 */
function extractRomanization(data: unknown, lang: DictionaryLang): string {
  if (lang === "h") return "";
  if (!data || typeof data !== "object") return "";
  const entry = data as Record<string, unknown>;
  const heteronyms = entry.heteronyms as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(heteronyms) || heteronyms.length === 0) return "";
  const first = heteronyms[0];
  const pinyin = first.pinyin;
  if (typeof pinyin === "string" && pinyin) return pinyin;
  const trs = first.trs;
  return typeof trs === "string" ? trs : "";
}

/** 第一個 heteronym 的注音符號（僅 lang='a'/'c' 有意義）。 */
function extractBopomofo(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const entry = data as Record<string, unknown>;
  const heteronyms = entry.heteronyms as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(heteronyms) || heteronyms.length === 0) return "";
  const bopomofo = heteronyms[0].bopomofo;
  return typeof bopomofo === "string" ? bopomofo : "";
}

export function CharacterImageView({
  queryWord,
  terms,
  lang,
  langTokenPrefix,
}: CharacterImageViewProps) {
  const navigate = useNavigate();
  const [segments, setSegments] = useState<TermSegment[]>([]);
  const [segmentsLoading, setSegmentsLoading] = useState(true);
  const [shareSupported] = useState(() => typeof navigator !== "undefined" && !!navigator.share);
  const [font, setFont] = useState(getStoredFont);
  const [hollowMode, setHollowMode] = useState(true);
  const [romanize, setRomanize] = useState(getStoredRomanize);
  const canvasRefs = useRef<Record<string, HTMLCanvasElement>>({});
  const drawStates = useRef<Record<string, DrawState>>({});
  const mergedTerms = useMemo(() => mergeEnglishTerms(terms), [terms]);
  const romanizeActive = romanize && lang !== "h";
  const mainImageSize = queryWord.length > 1 ? SEGMENT_IMAGE_SIZE : 240;

  const handleFontChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value;
    setFont(next);
    setStoredFont(next);
  }, []);

  const handleRomanizeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.checked;
    setRomanize(next);
    setStoredRomanize(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSegmentsLoading(true);
    setSegments([]);

    async function loadSegments() {
      const results: TermSegment[] = [];
      for (const part of mergedTerms) {
        try {
          const response = await fetchDictionaryEntry(part, lang);
          if (cancelled) return;
          const def = response.ok ? extractDef(response.data) : "";
          const href = response.ok ? `/${langTokenPrefix}${part}` : null;
          const pinyin = response.ok ? extractRomanization(response.data, lang) : "";
          const bopomofo = response.ok ? extractBopomofo(response.data) : "";
          results.push({ part, href, def, pinyin, bopomofo });
        } catch {
          if (cancelled) return;
          results.push({ part, href: null, def: "", pinyin: "", bopomofo: "" });
        }
      }
      if (!cancelled) {
        setSegments(results);
        setSegmentsLoading(false);
      }
    }

    void loadSegments();
    return () => {
      cancelled = true;
    };
  }, [mergedTerms, lang, langTokenPrefix]);

  const handleShare = useCallback(async () => {
    const url = window.location.href;
    const cleanWord = queryWord.replace(/^['!~:]/, "");
    const title = `${cleanWord} - 萌典`;

    if (navigator.share) {
      try {
        await navigator.share({ title, text: cleanWord, url });
      } catch {
        // User cancelled or share failed
      }
    } else {
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        // Clipboard fallback failed
      }
    }
  }, [queryWord]);

  const handleTermClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
      event.preventDefault();
      void navigate(href);
    },
    [navigate],
  );

  const registerCanvas = useCallback(
    (key: string, width: number, height: number) => (node: HTMLCanvasElement | null) => {
      if (!node) {
        delete canvasRefs.current[key];
        delete drawStates.current[key];
        return;
      }
      canvasRefs.current[key] = node;
      resetPracticeCanvas(node, width, height);
    },
    [],
  );

  const beginDrawing = useCallback(
    (
      key: string,
      input: DrawState["input"],
      pointerId: number | null,
      clientX: number,
      clientY: number,
    ) => {
      const canvas = canvasRefs.current[key];
      if (!canvas) return;

      const context = canvas.getContext("2d");
      if (!context) return;

      const { x, y } = getCanvasPoint(canvas, clientX, clientY);
      drawStates.current[key] = {
        drawing: true,
        input,
        pointerId,
        lastX: x,
        lastY: y,
      };

      context.beginPath();
      context.arc(x, y, 1.4, 0, Math.PI * 2);
      context.fill();
    },
    [],
  );

  const drawPoint = useCallback(
    (
      key: string,
      input: DrawState["input"],
      pointerId: number | null,
      clientX: number,
      clientY: number,
    ) => {
      const canvas = canvasRefs.current[key];
      if (!canvas) return;
      const state = drawStates.current[key];
      if (!state?.drawing || state.input !== input || state.pointerId !== pointerId) return;

      const context = canvas.getContext("2d");
      if (!context) return;

      const { x, y } = getCanvasPoint(canvas, clientX, clientY);
      context.beginPath();
      context.moveTo(state.lastX, state.lastY);
      context.lineTo(x, y);
      context.stroke();
      state.lastX = x;
      state.lastY = y;
    },
    [],
  );

  const finishDrawingState = useCallback(
    (key: string, input: DrawState["input"], pointerId: number | null) => {
      const state = drawStates.current[key];
      if (!state || !state.drawing || state.input !== input || state.pointerId !== pointerId)
        return;
      state.drawing = false;
      state.pointerId = null;
    },
    [],
  );

  const handleCanvasPointerDown = useCallback(
    (key: string, event: React.PointerEvent<HTMLCanvasElement>) => {
      if (isTouchPointerEvent(event)) return;
      const canvas = canvasRefs.current[key];
      if (!canvas) return;
      event.preventDefault();
      trySetPointerCapture(canvas, event.pointerId);
      beginDrawing(key, "pointer", event.pointerId, event.clientX, event.clientY);
    },
    [beginDrawing],
  );

  const handleCanvasPointerMove = useCallback(
    (key: string, event: React.PointerEvent<HTMLCanvasElement>) => {
      if (isTouchPointerEvent(event)) return;
      event.preventDefault();
      drawPoint(key, "pointer", event.pointerId, event.clientX, event.clientY);
    },
    [drawPoint],
  );

  const finishPointerDrawing = useCallback(
    (key: string, event: React.PointerEvent<HTMLCanvasElement>) => {
      if (isTouchPointerEvent(event)) return;
      const canvas = canvasRefs.current[key];
      finishDrawingState(key, "pointer", event.pointerId);
      if (canvas) tryReleasePointerCapture(canvas, event.pointerId);
    },
    [finishDrawingState],
  );

  const handleCanvasTouchStart = useCallback(
    (key: string, event: React.TouchEvent<HTMLCanvasElement>) => {
      const touch = event.changedTouches[0];
      if (!touch) return;
      event.preventDefault();
      beginDrawing(key, "touch", touch.identifier, touch.clientX, touch.clientY);
    },
    [beginDrawing],
  );

  const handleCanvasTouchMove = useCallback(
    (key: string, event: React.TouchEvent<HTMLCanvasElement>) => {
      const state = drawStates.current[key];
      if (!state || state.input !== "touch" || state.pointerId === null) return;
      const touch = Array.from(event.touches).find((item) => item.identifier === state.pointerId);
      if (!touch) return;
      event.preventDefault();
      drawPoint(key, "touch", touch.identifier, touch.clientX, touch.clientY);
    },
    [drawPoint],
  );

  const finishTouchDrawing = useCallback(
    (key: string, event: React.TouchEvent<HTMLCanvasElement>) => {
      const state = drawStates.current[key];
      if (!state || state.input !== "touch" || state.pointerId === null) return;
      const touch = Array.from(event.changedTouches).find(
        (item) => item.identifier === state.pointerId,
      );
      if (!touch) return;
      event.preventDefault();
      finishDrawingState(key, "touch", touch.identifier);
    },
    [finishDrawingState],
  );

  const handleCanvasMouseDown = useCallback(
    (key: string, event: React.MouseEvent<HTMLCanvasElement>) => {
      if (typeof window !== "undefined" && "PointerEvent" in window) return;
      event.preventDefault();
      beginDrawing(key, "mouse", null, event.clientX, event.clientY);
    },
    [beginDrawing],
  );

  const handleCanvasMouseMove = useCallback(
    (key: string, event: React.MouseEvent<HTMLCanvasElement>) => {
      if (typeof window !== "undefined" && "PointerEvent" in window) return;
      event.preventDefault();
      drawPoint(key, "mouse", null, event.clientX, event.clientY);
    },
    [drawPoint],
  );

  const finishMouseDrawing = useCallback(
    (key: string, event: React.MouseEvent<HTMLCanvasElement>) => {
      if (typeof window !== "undefined" && "PointerEvent" in window) return;
      event.preventDefault();
      finishDrawingState(key, "mouse", null);
    },
    [finishDrawingState],
  );

  const preventCanvasGesture = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault();
  }, []);

  const handleClearDrawings = useCallback(() => {
    for (const canvas of Object.values(canvasRefs.current)) {
      const width = Number(canvas.dataset.width || SEGMENT_IMAGE_SIZE);
      const height = Number(canvas.dataset.height || SEGMENT_IMAGE_SIZE);
      resetPracticeCanvas(canvas, width, height);
    }
  }, []);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  const renderPracticeCanvas = useCallback(
    (key: string, width: number, height: number) => (
      <canvas
        className="charimg-draw-canvas"
        ref={registerCanvas(key, width, height)}
        onContextMenu={preventCanvasGesture}
        onPointerDown={(event) => handleCanvasPointerDown(key, event)}
        onPointerMove={(event) => handleCanvasPointerMove(key, event)}
        onPointerUp={(event) => finishPointerDrawing(key, event)}
        onPointerLeave={(event) => finishPointerDrawing(key, event)}
        onPointerCancel={(event) => finishPointerDrawing(key, event)}
        onTouchStart={(event) => handleCanvasTouchStart(key, event)}
        onTouchMove={(event) => handleCanvasTouchMove(key, event)}
        onTouchEnd={(event) => finishTouchDrawing(key, event)}
        onTouchCancel={(event) => finishTouchDrawing(key, event)}
        onMouseDown={(event) => handleCanvasMouseDown(key, event)}
        onMouseMove={(event) => handleCanvasMouseMove(key, event)}
        onMouseUp={(event) => finishMouseDrawing(key, event)}
        onMouseLeave={(event) => finishMouseDrawing(key, event)}
      />
    ),
    [
      finishMouseDrawing,
      finishPointerDrawing,
      finishTouchDrawing,
      handleCanvasMouseDown,
      handleCanvasMouseMove,
      handleCanvasPointerDown,
      handleCanvasPointerMove,
      handleCanvasTouchMove,
      handleCanvasTouchStart,
      preventCanvasGesture,
      registerCanvas,
    ],
  );

  return (
    <div className={`result charimg-result${hollowMode ? " charimg-hollow" : ""}`}>
      <style>
        {`
          .charimg-result .charimg-controls {
            margin: 15px 0;
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            align-items: center;
            justify-content: center;
          }

          .charimg-result .charimg-practice-box {
            position: relative;
            display: inline-block;
            line-height: 0;
            user-select: none;
            -webkit-user-select: none;
            -webkit-touch-callout: none;
          }

          .charimg-result .charimg-draw-canvas {
            position: absolute;
            inset: 0;
            background: transparent;
            touch-action: none;
            cursor: crosshair;
            user-select: none;
            -webkit-user-select: none;
            -webkit-touch-callout: none;
            -webkit-tap-highlight-color: transparent;
          }

          .charimg-result .charimg-glyph {
            user-select: none;
            -webkit-user-select: none;
            -webkit-touch-callout: none;
            -webkit-user-drag: none;
            user-drag: none;
          }

          .charimg-result.charimg-hollow img.charimg-glyph-segment {
            filter: invert(100%) grayscale(100%);
            -webkit-filter: invert(100%) grayscale(100%);
            -moz-filter: invert(100%) grayscale(100%);
            -ms-filter: invert(100%) grayscale(100%);
            -o-filter: invert(100%) grayscale(100%);
            opacity: .32;
          }

          .charimg-result .charimg-caption {
            margin-top: 6px;
            text-align: center;
            font-size: 0.85em;
            line-height: 1.3;
          }

          .charimg-result .charimg-caption .bopomofo {
            display: inline-block;
          }

          @media print {
            .charimg-result .charimg-controls {
              display: none !important;
            }
            .charimg-result .charimg-draw-canvas {
              display: none !important;
            }
            .charimg-result table.moetext {
              display: block;
              max-width: 100% !important;
              background: transparent !important;
              border: 0 !important;
              box-shadow: none !important;
            }
            .charimg-result table.moetext > tbody {
              display: inline-flex;
              flex-wrap: wrap;
              align-items: flex-start;
              gap: 8px;
            }
            .charimg-result table.moetext > tbody > tr {
              display: inline-flex;
              align-items: flex-start;
              border: 1px solid #ddd;
              padding: 4px;
              break-inside: avoid;
              page-break-inside: avoid;
            }
            .charimg-result table.moetext > tbody > tr > td {
              padding: 0 !important;
            }
            .charimg-result table.moetext > tbody > tr > td:last-child {
              padding-left: 8px !important;
              max-width: 180px;
            }
          }
        `}
      </style>
      <center>
        <div
          className="charimg-practice-box"
          style={{ width: mainImageSize, height: mainImageSize }}
        >
          <img
            className="charimg-glyph charimg-glyph-main"
            src={charImgUrl(queryWord, font, lang, romanizeActive)}
            alt={queryWord}
            style={{ width: mainImageSize, height: mainImageSize }}
          />
          {renderPracticeCanvas(`main:${queryWord}`, mainImageSize, mainImageSize)}
        </div>

        <div className="charimg-controls">
          <select
            id="font"
            value={font}
            onChange={handleFontChange}
            style={{ marginRight: 8, padding: "4px 8px", fontSize: "0.95em" }}
          >
            {FONT_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.fonts.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button
            className="btn btn-default charimg-share-btn"
            title={shareSupported ? "分享" : "複製連結"}
            onClick={handleShare}
          >
            <SvgIcon name="share" size={16} aria-hidden="true" />
            {shareSupported ? "分享" : "複製連結"}
          </button>
          <button
            className="btn btn-default charimg-print-btn"
            title="列印目前字圖"
            onClick={handlePrint}
          >
            <SvgIcon name="print" size={16} aria-hidden="true" />
            列印字卡
          </button>
          <button
            className="btn btn-default charimg-clear-btn"
            title="清空描寫筆跡"
            onClick={handleClearDrawings}
          >
            清除描寫
          </button>
          <label
            style={{
              marginBottom: 0,
              display: "inline-flex",
              gap: 4,
              alignItems: "center",
              fontWeight: "normal",
            }}
          >
            <input
              type="checkbox"
              checked={hollowMode}
              onChange={(event) => setHollowMode(event.target.checked)}
            />
            鏤空描寫模式
          </label>
          <label
            style={{
              marginBottom: 0,
              display: "inline-flex",
              gap: 4,
              alignItems: "center",
              fontWeight: "normal",
            }}
          >
            <input
              id="charimg-romanize"
              type="checkbox"
              checked={romanize}
              disabled={lang === "h"}
              onChange={handleRomanizeChange}
            />
            <span>
              顯示羅馬拼音
              {lang === "h" ? "（客語字圖目前不提供羅馬拼音）" : ""}
            </span>
          </label>
        </div>

        <table
          className="moetext"
          style={{
            maxWidth: "90%",
            background: "#eee",
            border: "24px #f9f9f9 solid",
            boxShadow: "#d4d4d4 0 3px 3px",
            borderCollapse: "separate",
            borderSpacing: 0,
          }}
        >
          <tbody>
            {segmentsLoading ? (
              <tr>
                <td
                  colSpan={2}
                  style={{
                    padding: "16px 24px",
                    textAlign: "center",
                    color: "#666",
                    fontSize: "1.05em",
                  }}
                >
                  載入中...
                </td>
              </tr>
            ) : (
              segments.map((segment) => (
                <tr key={segment.part}>
                  <td style={{ verticalAlign: "top", padding: 4 }}>
                    <div
                      className="charimg-practice-box"
                      style={{ width: SEGMENT_IMAGE_SIZE, height: SEGMENT_IMAGE_SIZE }}
                    >
                      <img
                        className="charimg-glyph charimg-glyph-segment"
                        src={charImgUrl(segment.part, font, lang, romanizeActive)}
                        alt={segment.pinyin ? `${segment.part} ${segment.pinyin}` : segment.part}
                        style={{ width: SEGMENT_IMAGE_SIZE, height: SEGMENT_IMAGE_SIZE }}
                      />
                      {renderPracticeCanvas(
                        `segment:${segment.part}`,
                        SEGMENT_IMAGE_SIZE,
                        SEGMENT_IMAGE_SIZE,
                      )}
                    </div>
                    {romanizeActive && (segment.pinyin || segment.bopomofo) && (
                      <div className="charimg-caption">
                        {segment.pinyin && (
                          <span className="pinyin">
                            {renderFormattedPhonetics(formatPinyin(segment.pinyin))}
                          </span>
                        )}
                        {segment.bopomofo && (
                          <span className="bopomofo">
                            {renderFormattedPhonetics(formatBopomofo(segment.bopomofo))}
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td
                    style={{
                      verticalAlign: "top",
                      padding: "16px 12px",
                      color: "#006",
                      textAlign: "left",
                      lineHeight: 1.6,
                      fontSize: "1.05em",
                      wordBreak: "break-word",
                    }}
                  >
                    {segment.href ? (
                      <a
                        href={segment.href}
                        style={{ color: "#006" }}
                        onClick={(e) => handleTermClick(e, segment.href!)}
                      >
                        {segment.def || segment.part}
                      </a>
                    ) : (
                      <span style={{ color: "#666" }}>{segment.part}</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </center>
    </div>
  );
}
