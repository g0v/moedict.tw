import { useEffect, useMemo, useState, type JSX, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useRadicalTooltip } from "../hooks/useRadicalTooltip";
import {
  fetchRadicalRows,
  getRadicalLangPrefix,
  type RadicalLang,
} from "../utils/radical-page-utils";
import { addToLRU } from "../utils/word-record-utils";

interface RadicalDetailViewProps {
  lang: RadicalLang;
  radical?: string;
}

interface RadicalDetailState {
  loading: boolean;
  rows: string[][];
  error: string | null;
}

export function RadicalDetailView({ lang, radical }: RadicalDetailViewProps) {
  const navigate = useNavigate();
  const cleanRadical = useMemo(() => (radical ?? "").trim(), [radical]);
  const [state, setState] = useState<RadicalDetailState>({
    loading: true,
    rows: [],
    error: null,
  });

  useRadicalTooltip();

  useEffect(() => {
    if (!cleanRadical) return;
    addToLRU(`@${cleanRadical}`, lang);
  }, [cleanRadical, lang]);

  useEffect(() => {
    if (!cleanRadical) {
      setState({ loading: false, rows: [], error: "未提供部首" });
      return;
    }

    let active = true;
    setState({ loading: true, rows: [], error: null });

    fetchRadicalRows(lang, `@${cleanRadical}`)
      .then((rows) => {
        if (!active) return;
        setState({ loading: false, rows, error: null });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : "部首內容載入失敗";
        setState({ loading: false, rows: [], error: message });
      });

    return () => {
      active = false;
    };
  }, [lang, cleanRadical]);

  const onNavigate = (event: MouseEvent<HTMLAnchorElement>, to: string): void => {
    event.preventDefault();
    void navigate(to);
  };

  const langPrefix = getRadicalLangPrefix(lang);
  const backHref = `/${langPrefix}@`;
  const backTooltip = `${langPrefix}@`;
  const charPrefix = `/${langPrefix}`;

  let resultContent: JSX.Element | null = null;
  if (state.loading) {
    resultContent = <div className="def">載入中…</div>;
  } else if (state.error) {
    resultContent = <div className="def">{state.error}</div>;
  } else {
    resultContent = (
      <div className="entry-item list">
        {state.rows.map((row, stroke) => {
          if (lang === "h" && row.length === 0) return null;
          return (
            <div key={stroke} style={{ margin: "8px 0" }}>
              <span className="stroke-count" style={{ marginRight: "8px" }}>
                {lang === "h" ? `總筆畫 ${stroke}` : stroke}
              </span>
              <span className="stroke-list">
                {row.map((char) => {
                  const to = `${charPrefix}${char}`;
                  return (
                    <a
                      key={`${stroke}-${char}`}
                      className="stroke-char"
                      href={to}
                      data-radical-id={`entry:${to}`}
                      style={{ marginRight: "6px" }}
                      onClick={(event) => onNavigate(event, to)}
                    >
                      {char}
                    </a>
                  );
                })}
              </span>
              <hr style={{ margin: "0", padding: "0", height: "0" }} />
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="result">
      <h1 className="title" style={{ marginTop: "0" }}>
        {cleanRadical} 部
      </h1>
      {lang === "h" && (
        <p className="radical-stroke-note">
          客語字表依 CNS11643 全字庫總筆畫分組；其他詞典依部首外筆畫分組。
        </p>
      )}
      <p>
        <a
          className="xref"
          href={backHref}
          data-radical-id={backTooltip}
          onClick={(event) => onNavigate(event, backHref)}
        >
          回部首表
        </a>
      </p>
      <div className="entry">{resultContent}</div>
    </div>
  );
}
