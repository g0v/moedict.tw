import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchDictionaryEntry, type DictionaryLang } from '../utils/dictionary-cache';

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
}

function mergeEnglishTerms(terms: string[]): string[] {
  const merged: string[] = [];
  for (const term of terms) {
    const token = String(term || '');
    if (!token) continue;
    if (/^[A-Za-z]+$/.test(token) && merged.length > 0 && /^[A-Za-z]+$/.test(merged[merged.length - 1])) {
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
        `${String.fromCharCode(0x327f + parseInt(num))}${char ? `${char}\u20DE` : ''}`,
    )
    .replace(/<(\d)>/g, (_, num: string) => String.fromCharCode(0x327f + parseInt(num)))
    .replace(/\{(\d)\}/g, (_, num: string) => String.fromCharCode(0x2775 + parseInt(num)))
    .replace(/[（(](\d)[)）]/g, (_, num: string) => String.fromCharCode(0x2789 + parseInt(num)))
    .replace(/\(/g, '（')
    .replace(/\)/g, '）')
    .replace(/<[^>]*>/g, '');
}

function extractDef(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const entry = data as Record<string, unknown>;
  const heteronyms = entry.heteronyms as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(heteronyms)) return '';

  let result = '';
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

export function CharacterImageView({ queryWord, terms, lang, langTokenPrefix }: CharacterImageViewProps) {
  const navigate = useNavigate();
  const [segments, setSegments] = useState<TermSegment[]>([]);
  const [shareSupported] = useState(() => typeof navigator !== 'undefined' && !!navigator.share);
  const mergedTerms = useMemo(() => mergeEnglishTerms(terms), [terms]);

  useEffect(() => {
    let cancelled = false;

    async function loadSegments() {
      const results: TermSegment[] = [];
      for (const part of mergedTerms) {
        try {
          const response = await fetchDictionaryEntry(part, lang);
          if (cancelled) return;
          const def = response.ok ? extractDef(response.data) : '';
          const href = response.ok ? `/${langTokenPrefix}${part}` : null;
          results.push({ part, href, def });
        } catch {
          if (cancelled) return;
          results.push({ part, href: null, def: '' });
        }
      }
      if (!cancelled) setSegments(results);
    }

    loadSegments();
    return () => { cancelled = true; };
  }, [mergedTerms, lang, langTokenPrefix]);

  const handleShare = useCallback(async () => {
    const url = window.location.href;
    const cleanWord = queryWord.replace(/^['!~:]/, '');
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
      navigate(href);
    },
    [navigate],
  );

  return (
    <div className="result charimg-result">
      <center>
        <img src={`https://www.moedict.tw/${queryWord}.png`}
          alt={queryWord}
          style={{ width: queryWord.length > 1 ? 160 : 240 }}
        />

        <div className="charimg-share" style={{ margin: 15 }}>
          <button
            className="btn btn-default charimg-share-btn"
            title={shareSupported ? '分享' : '複製連結'}
            onClick={handleShare}
          >
            <span className="icon-share" />
            {' '}
            {shareSupported ? '分享' : '複製連結'}
          </button>
        </div>

        <table
          className="moetext"
          style={{
            maxWidth: '90%',
            background: '#eee',
            border: '24px #f9f9f9 solid',
            boxShadow: '#d4d4d4 0 3px 3px',
            borderCollapse: 'separate',
            borderSpacing: 0,
          }}
        >
          <tbody>
            {segments.map((segment) => (
              <tr key={segment.part}>
                <td style={{ verticalAlign: 'top', padding: 4 }}>
                  {segment.href ? (
                    <a
                      href={segment.href}
                      onClick={(e) => handleTermClick(e, segment.href!)}
                    >
                      <img src={`https://www.moedict.tw/${segment.part}.png`}
                        alt={segment.part}
                        style={{ width: 160, height: 160 }}
                      />
                    </a>
                  ) : (
                    <img src={`https://www.moedict.tw/${segment.part}.png`}
                      alt={segment.part}
                      style={{ width: 160, height: 160 }}
                    />
                  )}
                </td>
                <td
                  style={{
                    verticalAlign: 'top',
                    padding: '16px 12px',
                    color: '#006',
                    textAlign: 'left',
                    lineHeight: 1.6,
                    fontSize: '1.05em',
                    wordBreak: 'break-word',
                  }}
                >
                  {segment.href ? (
                    <a
                      href={segment.href}
                      style={{ color: '#006' }}
                      onClick={(e) => handleTermClick(e, segment.href!)}
                    >
                      {segment.def || segment.part}
                    </a>
                  ) : (
                    <span style={{ color: '#999' }}>{segment.part}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </center>
    </div>
  );
}
