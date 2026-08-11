import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { SvgIcon } from "../components/SvgIcon";
import { writeTextToClipboard } from "../utils/clipboard";
import {
  addStarWord,
  clearLRUWords,
  clearStarredWords,
  exportStarredWords,
  getLRUStorageKey,
  getStarredStorageKey,
  hasStarWord,
  importStarredWords,
  readLRUWords,
  readStarredWords,
  removeLRUWord,
  removeStarWord,
  type ImportStarredWordsResult,
} from "../utils/word-record-utils";
import { useRadicalTooltip } from "../hooks/useRadicalTooltip";

type Lang = "a" | "t" | "h" | "c";

interface StarredPageProps {
  lang: Lang;
  entry?: string;
}

// Fixed dictionary-table order (AGENTS.md 語言代碼): a/t/h/c.
const ALL_LANGS: readonly Lang[] = ["a", "t", "h", "c"];
const LANG_LABELS: Record<Lang, string> = {
  a: "華語",
  t: "臺灣台語",
  h: "臺灣客語",
  c: "兩岸詞典",
};

function getLangPrefix(lang: Lang): string {
  if (lang === "t") return "'";
  if (lang === "h") return ":";
  if (lang === "c") return "~";
  return "";
}

function buildWordPath(word: string, prefix: string): string {
  if (word.startsWith("@")) {
    const radical = word.slice(1);
    const radicalBase = prefix === "~" || prefix === "'" || prefix === ":" ? `/${prefix}@` : "/@";
    return `${radicalBase}${encodeURIComponent(radical)}`;
  }
  return `/${prefix}${encodeURIComponent(word)}`;
}

function buildTooltipId(word: string, path: string, prefix: string): string {
  if (word.startsWith("@")) {
    return prefix === "~" || prefix === "'" || prefix === ":" ? `${prefix}${word}` : word;
  }
  return `entry:${path}`;
}

interface WordRowProps {
  word: string;
  lang: Lang;
  prefix: string;
  isStarred: boolean;
  onWordClick: (event: ReactMouseEvent<HTMLAnchorElement>, word: string, lang: Lang) => void;
  onToggleStar: (lang: Lang, word: string) => void;
  onRemove: (lang: Lang, word: string) => void;
  removeAriaLabel: string;
  starAriaLabelSuffix?: string;
}

// Shared row markup for the current-language starred/recent sections AND the
// #88 cross-language overview — a single rendering convention parameterized
// by `lang`/`prefix` instead of two near-duplicate JSX blocks.
function WordRow({
  word,
  lang: wordLang,
  prefix,
  isStarred,
  onWordClick,
  onToggleStar,
  onRemove,
  removeAriaLabel,
  starAriaLabelSuffix = "",
}: WordRowProps) {
  const path = buildWordPath(word, prefix);
  const tooltipId = buildTooltipId(word, path, prefix);
  const starLabel = `${isStarred ? "取消收藏" : "收藏"}「${word}」${starAriaLabelSuffix}`;
  return (
    <div style={{ clear: "both", display: "block" }}>
      <button
        type="button"
        className="btn-star-word"
        aria-label={starLabel}
        title={starLabel}
        onClick={() => onToggleStar(wordLang, word)}
      >
        <SvgIcon name={isStarred ? "star" : "starEmpty"} size="0.9em" aria-hidden="true" />
      </button>
      <a
        href={path}
        data-radical-id={tooltipId}
        onClick={(event) => onWordClick(event, word, wordLang)}
      >
        {word}
      </a>
      <button
        type="button"
        className="btn-remove-word"
        aria-label={removeAriaLabel}
        title={removeAriaLabel}
        onClick={() => onRemove(wordLang, word)}
      >
        <SvgIcon name="removeCircle" size="0.9em" aria-hidden="true" />
      </button>
    </div>
  );
}

export function StarredPage({ lang }: StarredPageProps) {
  const navigate = useNavigate();
  const [starredWords, setStarredWords] = useState<string[]>([]);
  const [recentWords, setRecentWords] = useState<string[]>([]);
  const prefix = useMemo(() => getLangPrefix(lang), [lang]);
  useRadicalTooltip();

  const loadWords = useCallback(() => {
    setStarredWords(readStarredWords(lang));
    setRecentWords(readLRUWords(lang));
  }, [lang]);

  useEffect(() => {
    loadWords();
  }, [loadWords]);

  // #88: cross-language overview. Only computed once the user opts in, so
  // the default single-language page load does zero extra localStorage
  // reads (allLangWords stays null until first toggled open).
  const [showAllLangs, setShowAllLangs] = useState(false);
  const [allLangWords, setAllLangWords] = useState<Record<Lang, string[]> | null>(null);

  const refreshAllLangs = useCallback(() => {
    const next = {} as Record<Lang, string[]>;
    for (const l of ALL_LANGS) next[l] = readStarredWords(l);
    setAllLangWords(next);
  }, []);

  const handleToggleAllLangs = useCallback(() => {
    setShowAllLangs((prev) => {
      const next = !prev;
      if (next) refreshAllLangs();
      return next;
    });
  }, [refreshAllLangs]);

  // Single re-sync point for every starred-word mutation (toggle/remove/
  // import), whether it targets the page's own `lang` or another language
  // via the aggregate view. Keeps the aggregate honest without a second
  // "did this touch my lang" branch at every call site.
  const syncAfterMutation = useCallback(
    (targetLang: Lang) => {
      if (targetLang === lang) loadWords();
      if (showAllLangs) refreshAllLangs();
    },
    [lang, showAllLangs, loadWords, refreshAllLangs],
  );

  // Cross-tab / storage-event refresh: another tab starring or importing
  // words should update this page without a manual reload.
  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key == null) {
        loadWords();
        if (showAllLangs) refreshAllLangs();
        return;
      }
      if (event.key === getStarredStorageKey(lang) || event.key === getLRUStorageKey(lang)) {
        loadWords();
      }
      if (showAllLangs && event.key.startsWith("starred-")) {
        refreshAllLangs();
      }
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [lang, showAllLangs, loadWords, refreshAllLangs]);

  const handleWordClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>, word: string, wordLang: Lang) => {
      if (event.defaultPrevented) return;
      if (event.button !== 0) return;
      if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      void navigate(buildWordPath(word, getLangPrefix(wordLang)));
    },
    [navigate],
  );

  const handleClearRecent = useCallback(() => {
    if (!window.confirm("確定要清除瀏覽紀錄？")) return;
    clearLRUWords(lang);
    setRecentWords([]);
  }, [lang]);

  const handleClearStarred = useCallback(() => {
    if (!window.confirm("確定要清除收藏字詞？")) return;
    clearStarredWords(lang);
    setStarredWords([]);
    if (showAllLangs) refreshAllLangs();
  }, [lang, showAllLangs, refreshAllLangs]);

  const handleRemoveStarredFor = useCallback(
    (targetLang: Lang, word: string) => {
      removeStarWord(targetLang, word);
      syncAfterMutation(targetLang);
    },
    [syncAfterMutation],
  );

  const handleRemoveRecent = useCallback(
    (word: string) => {
      removeLRUWord(lang, word);
      setRecentWords((prev) => prev.filter((existing) => existing !== word));
    },
    [lang],
  );

  const starredSet = useMemo(() => new Set(starredWords), [starredWords]);

  const handleToggleStarFor = useCallback(
    (targetLang: Lang, word: string) => {
      if (hasStarWord(targetLang, word)) {
        removeStarWord(targetLang, word);
      } else {
        addStarWord(targetLang, word);
      }
      syncAfterMutation(targetLang);
    },
    [syncAfterMutation],
  );

  // #219: bounded manual plain-text export/import of the CURRENT language's
  // starred words only (no LRU/history, no cloud/App backup).
  const [importText, setImportText] = useState("");
  const [showImportPanel, setShowImportPanel] = useState(false);
  const [importResult, setImportResult] = useState<ImportStarredWordsResult | null>(null);
  const [copyStatus, setCopyStatus] = useState<{ ok: boolean } | null>(null);
  const copyStatusTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyStatusTimerRef.current != null) {
        window.clearTimeout(copyStatusTimerRef.current);
      }
    },
    [],
  );

  const handleDownloadExport = useCallback(() => {
    const text = exportStarredWords(lang);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `moedict-starred-${lang}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [lang]);

  const handleCopyExport = useCallback(async () => {
    const text = exportStarredWords(lang);
    const ok = await writeTextToClipboard(text);
    if (copyStatusTimerRef.current != null) {
      window.clearTimeout(copyStatusTimerRef.current);
    }
    setCopyStatus({ ok });
    copyStatusTimerRef.current = window.setTimeout(() => {
      setCopyStatus(null);
      copyStatusTimerRef.current = null;
    }, 3000);
  }, [lang]);

  const handleToggleImportPanel = useCallback(() => {
    setShowImportPanel((prev) => {
      const next = !prev;
      if (!next) setImportResult(null);
      return next;
    });
  }, []);

  const handleImportSubmit = useCallback(() => {
    if (!importText.trim()) return;
    const result = importStarredWords(lang, importText);
    setImportResult(result);
    if (result.imported.length > 0) {
      syncAfterMutation(lang);
    }
  }, [lang, importText, syncAfterMutation]);

  const visibleLangGroups = useMemo(
    () => ALL_LANGS.filter((l) => (allLangWords?.[l]?.length ?? 0) > 0),
    [allLangWords],
  );

  return (
    <div className="result">
      <h1 className="title">字詞紀錄簿</h1>

      <div className="all-langs-section">
        <button
          type="button"
          id="btn-toggle-all-langs"
          className="btn-default btn btn-tiny"
          aria-expanded={showAllLangs}
          aria-controls="all-langs-content"
          onClick={handleToggleAllLangs}
        >
          {showAllLangs ? "隱藏全部語言" : "顯示全部語言"}
        </button>
        {showAllLangs && (
          <div id="all-langs-content" className="word-list">
            {visibleLangGroups.length === 0 ? (
              <p className="bg-info">（尚未在任何語言收藏字詞。）</p>
            ) : (
              visibleLangGroups.map((l) => {
                const words = allLangWords?.[l] ?? [];
                const groupPrefix = getLangPrefix(l);
                return (
                  <div key={`lang-group-${l}`} className="lang-group">
                    <h4 className="lang-group-heading">
                      {LANG_LABELS[l]}
                      {l === lang && <span className="lang-group-current">（目前語言）</span>}
                    </h4>
                    {words.map((word) => (
                      <WordRow
                        key={`all-${l}-${word}`}
                        word={word}
                        lang={l}
                        prefix={groupPrefix}
                        isStarred
                        onWordClick={handleWordClick}
                        onToggleStar={handleToggleStarFor}
                        onRemove={handleRemoveStarredFor}
                        removeAriaLabel={`移除收藏「${word}」（${LANG_LABELS[l]}）`}
                        starAriaLabelSuffix={`（${LANG_LABELS[l]}）`}
                      />
                    ))}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      <div className="starred-section">
        <h3>
          收藏字詞
          <input
            id="btn-clear-starred"
            type="button"
            className="btn-default btn btn-tiny"
            value="清除"
            style={{ marginLeft: "10px", display: starredWords.length > 0 ? "" : "none" }}
            onClick={handleClearStarred}
          />
        </h3>
        <div className="word-list">
          {starredWords.length === 0 ? (
            <p className="bg-info">
              （請按詞條旁的{" "}
              <SvgIcon
                name="starEmpty"
                size="1em"
                style={{ margin: "0 0.15em", verticalAlign: "-0.125em" }}
                aria-hidden="true"
              />{" "}
              按鈕，即可將字詞加到這裡。）
            </p>
          ) : (
            starredWords.map((word) => (
              <WordRow
                key={`starred-${word}`}
                word={word}
                lang={lang}
                prefix={prefix}
                isStarred
                onWordClick={handleWordClick}
                onToggleStar={handleToggleStarFor}
                onRemove={handleRemoveStarredFor}
                removeAriaLabel={`移除收藏「${word}」`}
              />
            ))
          )}
        </div>

        <div className="export-import-section">
          <h4>匯出／匯入</h4>
          <div className="export-import-controls">
            <button
              type="button"
              id="btn-download-starred"
              className="btn-default btn btn-tiny"
              disabled={starredWords.length === 0}
              onClick={handleDownloadExport}
            >
              <SvgIcon name="download" size="0.9em" style={{ marginRight: 4 }} aria-hidden="true" />
              下載文字檔
            </button>
            <button
              type="button"
              id="btn-copy-starred"
              className="btn-default btn btn-tiny"
              disabled={starredWords.length === 0}
              onClick={() => {
                void handleCopyExport();
              }}
            >
              複製到剪貼簿
            </button>
            <button
              type="button"
              id="btn-toggle-import"
              className="btn-default btn btn-tiny"
              aria-expanded={showImportPanel}
              aria-controls="import-starred-panel"
              onClick={handleToggleImportPanel}
            >
              匯入
            </button>
          </div>
          {copyStatus && (
            <p className="bg-info" role="status" aria-live="polite">
              {copyStatus.ok ? "已複製收藏字詞清單" : "複製失敗，請改用「下載文字檔」"}
            </p>
          )}
          {showImportPanel && (
            <div id="import-starred-panel">
              <label htmlFor="import-starred-textarea">貼上要匯入的收藏字詞，一行一個</label>
              <textarea
                id="import-starred-textarea"
                aria-label="貼上要匯入的收藏字詞，一行一個"
                value={importText}
                onChange={(event) => {
                  setImportText(event.target.value);
                  setImportResult(null);
                }}
                rows={6}
              />
              <div>
                <button
                  type="button"
                  id="btn-confirm-import"
                  className="btn-default btn btn-tiny"
                  disabled={!importText.trim()}
                  onClick={handleImportSubmit}
                >
                  確認匯入
                </button>
              </div>
              {importResult && (
                <p className="bg-info" role="status" aria-live="polite">
                  已匯入 {importResult.imported.length} 筆，略過 {importResult.skipped}{" "}
                  筆重複或無效字詞。
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="recent-section">
        <br />
        <h3 id="lru">
          最近查閱過的字詞
          <input
            id="btn-clear-lru"
            type="button"
            className="btn-default btn btn-tiny"
            value="清除"
            style={{ marginLeft: "10px", display: recentWords.length > 0 ? "" : "none" }}
            onClick={handleClearRecent}
          />
        </h3>
        <div className="word-list">
          {recentWords.map((word) => (
            <WordRow
              key={`recent-${word}`}
              word={word}
              lang={lang}
              prefix={prefix}
              isStarred={starredSet.has(word)}
              onWordClick={handleWordClick}
              onToggleStar={handleToggleStarFor}
              onRemove={(_targetLang, w) => handleRemoveRecent(w)}
              removeAriaLabel={`移除紀錄「${word}」`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
