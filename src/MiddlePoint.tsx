/**
 * MiddlePoint
 * 用途：集中處理所有非靜態（含特殊字元）的路由，將其分流到正確頁面
 * 規則：每個 segment 不允許混合靜態字串與 :param，故改以此中繼頁解析完整路徑
 */

import { Navigate, useLocation } from 'react-router-dom';
import { DictionaryA } from './pages/Dictionary-a';
import { DictionaryT } from './pages/Dictionary-t';
import { DictionaryH } from './pages/Dictionary-h';
import { DictionaryC } from './pages/Dictionary-c';
import { StarredPage } from './pages/StarredPage';
import { ListView } from './pages/ListView';
import { RadicalDetailView } from './pages/RadicalDetailView';

type Lang = 'a' | 't' | 'h' | 'c';

interface PatternConfig {
  marker: string;
  lang: Lang;
}

const STARRED_PATTERNS: PatternConfig[] = [
  { marker: '=*', lang: 'a' },
  { marker: "'=*", lang: 't' },
  { marker: ':=*', lang: 'h' },
  { marker: '~=*', lang: 'c' },
];

const GROUP_PATTERNS: PatternConfig[] = [
  { marker: '=', lang: 'a' },
  { marker: "'=", lang: 't' },
  { marker: ':=', lang: 'h' },
  { marker: '~=', lang: 'c' },
];

export function MiddlePoint() {
  const location = useLocation();
  const rawPath = location.pathname.slice(1); // 移除開頭 '/'
  const trimmed = rawPath.replace(/\/+$/, '');
  if (!trimmed) {
    return <Navigate to='/' replace />;
  }

  let segment: string;
  let idx: number | undefined;
  try {
    const decoded = decodeURIComponent(trimmed);
    const parts = decoded.split('/');
    // 允許 /word/N 舊版「指定義項」永久連結（1-based，跨該詞所有音項合併計數）；
    // N 僅在真正落到字典頁分支時才會被使用，部首/分類/記錄簿分支會忽略它。
    if (parts.length === 2 && parts[0] && /^\d+$/.test(parts[1])) {
      segment = parts[0];
      idx = Number(parts[1]);
    } else if (parts.length === 1 && parts[0]) {
      segment = parts[0];
    } else {
      return <Navigate to='/' replace />;
    }
  } catch {
    return <Navigate to='/' replace />;
  }

  // 部首展開（兩岸）
  if (segment.startsWith('~@') && segment.length > 2) {
    return <RadicalDetailView lang='c' radical={segment.slice(2)} />;
  }

  // 部首展開（華語）
  if (segment.startsWith('@') && segment.length > 1) {
    return <RadicalDetailView lang='a' radical={segment.slice(1)} />;
  }

  // 字詞記錄簿（= 前綴且等號後為 *）
  for (const pattern of STARRED_PATTERNS) {
    if (segment.startsWith(pattern.marker)) {
      const entry = segment.slice(pattern.marker.length) || undefined;
      return <StarredPage lang={pattern.lang} entry={entry} />;
    }
  }

  // 分類索引（= 前綴且等號後為類別名稱）
  for (const pattern of GROUP_PATTERNS) {
    if (segment.startsWith(pattern.marker)) {
      const category = segment.slice(pattern.marker.length);
      if (category) {
        return <ListView lang={pattern.lang} category={category} />;
      }
    }
  }

  // 字典頁（依照開頭字元決定語言）
  if (segment.startsWith("'")) {
    return <DictionaryT word={segment.slice(1)} idx={idx} />;
  }

  if (segment.startsWith(':')) {
    return <DictionaryH word={segment.slice(1)} idx={idx} />;
  }

  if (segment.startsWith('~')) {
    return <DictionaryC word={segment.slice(1)} idx={idx} />;
  }

  // 預設：華語字典
  return <DictionaryA word={segment} idx={idx} />;
}

