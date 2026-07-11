import { useEffect, useState, type JSX, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRadicalTooltip } from '../hooks/useRadicalTooltip';
import { fetchRadicalRows, type RadicalLang } from '../utils/radical-page-utils';
import { addToLRU } from '../utils/word-record-utils';

interface RadicalViewProps {
  lang: RadicalLang;
}

interface RadicalState {
  loading: boolean;
  rows: string[][];
  error: string | null;
}

export function RadicalView({ lang }: RadicalViewProps) {
  const navigate = useNavigate();
  const [state, setState] = useState<RadicalState>({
    loading: true,
    rows: [],
    error: null,
  });

  useRadicalTooltip();

  useEffect(() => {
    addToLRU('@', lang);
  }, [lang]);

  useEffect(() => {
    let active = true;
    setState({ loading: true, rows: [], error: null });

    fetchRadicalRows(lang, '@')
      .then((rows) => {
        if (!active) return;
        setState({ loading: false, rows, error: null });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : '部首表載入失敗';
        setState({ loading: false, rows: [], error: message });
      });

    return () => {
      active = false;
    };
  }, [lang]);

  const onNavigate = (event: MouseEvent<HTMLAnchorElement>, to: string): void => {
    event.preventDefault();
    navigate(to);
  };

  const prefix = lang === 'c' ? '/~@' : '/@';
  const tooltipPrefix = lang === 'c' ? '~@' : '@';

  let resultContent: JSX.Element | null = null;
  if (state.loading) {
    resultContent = <div className="def">載入中…</div>
  } else if (state.error) {
    resultContent = <div className="def">{state.error}</div>
  } else {
    resultContent = (
      <div className="entry-item list radical-index">
        {state.rows.map((row, stroke) => (
          <div key={stroke} className="stroke-row">
            <span className="stroke-count">{stroke}</span>
            <span className="stroke-list">
              {row.map((radical) => {
                const to = `${prefix}${radical}`;
                return (
                  <a
                    key={`${stroke}-${radical}`}
                    className="stroke-char"
                    href={to}
                    data-radical-id={`${tooltipPrefix}${radical}`}
                    onClick={(event) => onNavigate(event, to)}
                  >
                    {radical}
                  </a>
                );
              })}
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="result">
      <h1 className="title radical-page-title">部首表</h1>
      <div className="entry">{resultContent}</div>
    </div>
  );
}
