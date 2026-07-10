/**
 * 分類詞彙列表頁面
 * 用途：顯示特定分類下的字詞列表（如成語、天文、諺語等）
 * 路由：/={類名}, /'={類名}, /:={類名}, /~={類名}
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useRadicalTooltip } from '../hooks/useRadicalTooltip';
import styled from './ListView.module.css';

type Lang = 'a' | 't' | 'h' | 'c';

interface ListViewProps {
  lang: Lang;
  category: string;
}

const LANG_PREFIX: Record<Lang, string> = {
  a: '',
  t: "'",
  h: ':',
  c: '~',
};
const KEYWORD_SEARCH_THRESHOLD = 30;

type CrossStraitPair = {
  taiwanTerm: string;
  mainlandTerm: string;
};

function parseCrossStraitPair(value: string): CrossStraitPair | null {
  // moedict-data-csld/兩岸同實異名.csv: 臺灣詞,,,大陸詞,,,差異別
  const fields = value.split(';');
  if (fields.length !== 3 || fields[0] !== '' || !fields[1] || !fields[2]) return null;
  return { taiwanTerm: fields[1], mainlandTerm: fields[2] };
}

function wordPath(lang: Lang, word: string): string {
  return `/${LANG_PREFIX[lang]}${word}`;
}

export function ListView({ lang, category }: ListViewProps) {
  const [words, setWords] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useRadicalTooltip();

  useEffect(() => {
    setLoading(true);
    setError(null);
    setWords([]);

    const prefix = LANG_PREFIX[lang];
    const apiUrl = `/api/${prefix}=${encodeURIComponent(category)}`;

    fetch(apiUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`找不到分類：${category}`);
        return res.json();
      })
      .then((data: unknown) => {
        // console.log(data);
        if (Array.isArray(data)) {
          setWords(data as string[]);
        } else {
          setError('資料格式錯誤');
        }
      })
      .catch((err: Error) => {
        setError(err.message);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [lang, category]);

  useEffect(() => {
    setKeyword('');
  }, [lang, category]);

  const isCrossStraitComparison = lang === 'c' && category === '同實異名';
  const pairs = useMemo(
    () => (isCrossStraitComparison ? words.map(parseCrossStraitPair).filter((pair): pair is CrossStraitPair => pair !== null) : []),
    [isCrossStraitComparison, words],
  );
  const ordinaryWords = useMemo(
    () => (isCrossStraitComparison ? words.filter((word) => parseCrossStraitPair(word) === null) : words),
    [isCrossStraitComparison, words],
  );

  const shouldShowKeywordSearch = words.length >= KEYWORD_SEARCH_THRESHOLD;
  const normalizedKeyword = keyword.trim();
  const filteredPairs = useMemo(() => {
    if (!normalizedKeyword) return pairs;
    return pairs.filter(
      ({ taiwanTerm, mainlandTerm }) =>
        taiwanTerm.includes(normalizedKeyword) || mainlandTerm.includes(normalizedKeyword),
    );
  }, [normalizedKeyword, pairs]);
  const filteredWords = useMemo(() => {
    if (!normalizedKeyword) return ordinaryWords;
    return ordinaryWords.filter((word) => word.includes(normalizedKeyword));
  }, [normalizedKeyword, ordinaryWords]);

  if (loading) {
    return (
      <div id="result" className="result prefer-pinyin-true">
        <div style={{ display: 'inline' }}>
          <h1 itemProp="name" style={{ visibility: 'visible' }}>{category}</h1>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div id="result" className="result prefer-pinyin-true">
        <div style={{ display: 'inline' }}>
          <h1 itemProp="name" style={{ visibility: 'visible' }}>{category}</h1>
          <span style={{ clear: 'both', display: 'block' }}>{error}</span>
        </div>
      </div>
    );
  }

  return (
    <div id="result" className="result prefer-pinyin-true">
      <div style={{ display: 'inline' }}>
        <h1 itemProp="name" style={{ visibility: 'visible' }}>{category}</h1>
        {shouldShowKeywordSearch && (
          <div style={{ clear: 'both', display: 'block', margin: '8px 0 12px' }}>
            <input
              type="search"
              className="query"
              autoComplete="off"
              placeholder={`在 ${category} 中檢索關鍵字`}
              aria-label={`在 ${category} 中檢索關鍵字`}
              value={keyword}
              onChange={(event) => setKeyword(event.currentTarget.value)}
            />
          </div>
        )}
        {shouldShowKeywordSearch
          && (isCrossStraitComparison ? filteredPairs.length === 0 && filteredWords.length === 0 : filteredWords.length === 0)
          && (
          <span style={{ clear: 'both', display: 'block' }}>
            沒有符合「{normalizedKeyword}」的結果
          </span>
        )}
        {isCrossStraitComparison ? (
          <>
            <div className={styled.comparisonTableWrapper}>
              <table
                aria-label="臺灣及大陸用語對照"
                className={styled.comparisonTable}
              >
                <thead>
                  <tr>
                    <th scope="col"><span aria-hidden="true">🇹🇼</span> 臺灣用語</th>
                    <th scope="col"><span aria-hidden="true">🇨🇳</span> 大陸用語</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPairs.map(({ taiwanTerm, mainlandTerm }) => (
                    <tr key={`${taiwanTerm}\u0000${mainlandTerm}`}>
                      <td><Link to={wordPath('c', taiwanTerm)}>{taiwanTerm}</Link></td>
                      <td><Link to={wordPath('c', mainlandTerm)}>{mainlandTerm}</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filteredWords.map((word) => (
              <span key={word} style={{ clear: 'both', display: 'block' }}>
                <span>·</span>
                <Link to={wordPath(lang, word)}>{word}</Link>
              </span>
            ))}
          </>
        ) : (
          filteredWords.map((word) => (
            <span key={word} style={{ clear: 'both', display: 'block' }}>
              <span>·</span>
              <Link to={wordPath(lang, word)}>{word}</Link>
            </span>
          ))
        )}
      </div>
    </div>
  );
}
