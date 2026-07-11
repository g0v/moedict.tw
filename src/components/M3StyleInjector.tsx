/**
 * 注入 Material Design 3 視覺重製樣式表
 *
 * 掛載順序刻意排在 Layout 樹的最後（UserPref 之後），確保這份 <style> 是
 * document 中最晚出現的樣式節點，在同優先度的情況下自然贏過舊版
 * Bootstrap 3 主題（data/assets/styles.css，遠端載入）與 InlineStyles.tsx
 * 的執行期注入樣式，不需要對每條規則硬加 !important。
 */

import m3ThemeCss from '../styles/m3-theme.css?raw';

export function M3StyleInjector() {
	return <style data-source="m3-theme" dangerouslySetInnerHTML={{ __html: m3ThemeCss }} />;
}
