/**
 * MiddlePoint
 * 用途：集中處理所有非靜態（含特殊字元）的路由，將其分流到正確頁面。
 * 路徑文法唯一定義在 src/utils/dictionary-route.ts 的 classifyRoute()；
 * 「分類結果 → 頁面」的對應在 src/utils/middle-point-target.ts
 * （resolveMiddlePointTarget，純函式、有完整單元測試）。本檔只負責
 * 把目標轉成 JSX，不得自建前綴 if-chain。
 */

import { Navigate, useLocation } from 'react-router-dom';
import { DictionaryA } from './pages/Dictionary-a';
import { DictionaryT } from './pages/Dictionary-t';
import { DictionaryH } from './pages/Dictionary-h';
import { DictionaryC } from './pages/Dictionary-c';
import { StarredPage } from './pages/StarredPage';
import { ListView } from './pages/ListView';
import { RadicalDetailView } from './pages/RadicalDetailView';
import { resolveMiddlePointTarget } from './utils/middle-point-target';

const DICT_PAGES = {
  a: DictionaryA,
  t: DictionaryT,
  h: DictionaryH,
  c: DictionaryC,
} as const;

export function MiddlePoint() {
  const location = useLocation();
  const target = resolveMiddlePointTarget(location.pathname);

  switch (target.page) {
    case 'home':
      return <Navigate to='/' replace />;
    case 'about':
      return <Navigate to='/about' replace />;
    case 'radical':
      return <RadicalDetailView lang={target.lang} radical={target.radical} />;
    case 'starred':
      return <StarredPage lang={target.lang} entry={target.entry} />;
    case 'list':
      return <ListView lang={target.lang} category={target.category} />;
    case 'dict': {
      const Page = DICT_PAGES[target.lang];
      return <Page word={target.word} idx={target.idx} />;
    }
  }
}
