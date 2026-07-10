export type HanYuLookupLang = 'a' | 'c';

export function getHanYuPinyinLookupBase(lang: HanYuLookupLang): string {
	return `/api/lookup/pinyin/${lang}/HanYu`;
}
