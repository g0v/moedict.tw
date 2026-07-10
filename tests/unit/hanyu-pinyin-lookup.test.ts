import { describe, expect, it } from 'vitest';
import { analyzePinyinField } from '../../scripts/hanyu-pinyin-tokens.mjs';
import { getHanYuPinyinLookupBase } from '../../src/utils/hanyu-pinyin-lookup';

describe('analyzePinyinField', () => {
	it('NFD-strips tone marks and lowercases latin runs for Mandarin', () => {
		expect(analyzePinyinField('huá zhī', 'a')).toEqual(['hua', 'zhi']);
		expect(analyzePinyinField('zhōng', 'a')).toEqual(['zhong']);
	});

	it('maps ɑ to a before tokenizing', () => {
		expect(analyzePinyinField('hɑi', 'a')).toEqual(['hai']);
	});

	it('maps ü spellings to lu/nu syllables like legacy (no lv token)', () => {
		expect(analyzePinyinField('lǜ', 'a')).toEqual(['lu']);
		expect(analyzePinyinField('nǚ', 'a')).toEqual(['nu']);
	});

	it('splits cross-strait readings with the known-syllable regex', () => {
		expect(analyzePinyinField('zhōng guó', 'c')).toEqual(['zhong', 'guo']);
		expect(analyzePinyinField('yīyī', 'c')).toEqual(['yi', 'yi']);
	});
});

describe('getHanYuPinyinLookupBase', () => {
	it('targets the local worker lookup route', () => {
		expect(getHanYuPinyinLookupBase('a')).toBe('/api/lookup/pinyin/a/HanYu');
		expect(getHanYuPinyinLookupBase('c')).toBe('/api/lookup/pinyin/c/HanYu');
	});
});

describe('HanYu per-token lookup emission', () => {
	it('writes JSON arrays of titles sorted shortest-first', async () => {
		const fs = await import('node:fs/promises');
		const path = await import('node:path');
		const aiPath = path.join(
			process.cwd(),
			'data/dictionary/lookup/pinyin/a/HanYu/ai.json',
		);
		const payload = JSON.parse(await fs.readFile(aiPath, 'utf8')) as string[];
		expect(Array.isArray(payload)).toBe(true);
		expect(payload.length).toBeGreaterThan(0);
		expect(payload.every((term) => typeof term === 'string')).toBe(true);
		const lengths = payload.map((term) => Array.from(term).length);
		expect([...lengths].sort((a, b) => a - b)).toEqual(lengths);
	});
});
