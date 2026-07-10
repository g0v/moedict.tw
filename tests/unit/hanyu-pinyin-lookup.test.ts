import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzePinyinField } from '../../scripts/hanyu-pinyin-tokens.mjs';
import {
	buildHanYuLookupIndex,
	insertIndex,
	sortDocs,
} from '../../scripts/build-pinyin-lookup.mjs';
import { getHanYuPinyinLookupBase } from '../../src/utils/hanyu-pinyin-lookup';

describe('analyzePinyinField', () => {
	it('NFD-strips tone marks from lowercase latin runs for Mandarin', () => {
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

	it('drops uppercase-leading latin runs, matching legacy Perl grep /^[a-z]/', () => {
		// build-pinyin-lookup.pl:28 splits case-insensitively but filters
		// case-sensitively; capitalized runs never reach the index. Parity
		// with the deployed lookup files requires preserving that behavior.
		expect(analyzePinyinField('Huá zhī', 'a')).toEqual(['zhi']);
	});
});

describe('getHanYuPinyinLookupBase', () => {
	it('targets the local worker lookup route', () => {
		expect(getHanYuPinyinLookupBase('a')).toBe('/api/lookup/pinyin/a/HanYu');
		expect(getHanYuPinyinLookupBase('c')).toBe('/api/lookup/pinyin/c/HanYu');
	});
});

describe('sortDocs', () => {
	it('ranks a one-codepoint astral title ahead of a two-codepoint BMP title', () => {
		// Legacy Perl length() counts characters; JS String.length counts
		// UTF-16 code units and would rank 𠀁 (U+20001, one codepoint, two
		// code units) as a tie with two-character titles.
		const docs = new Map();
		insertIndex(docs, '一二', ['yi']);
		insertIndex(docs, '\u{20001}', ['yi']);
		const sorted = sortDocs(docs.get('yi'));
		expect(sorted).toEqual(['\u{20001}', '一二']);
	});
});

describe('HanYu per-token lookup emission', () => {
	it('builds per-token JSON from a synthetic bucket, codepoint-length order first', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hanyu-lookup-'));
		const sourceDir = path.join(root, 'pack');
		const outputRoot = path.join(root, 'lookup');
		await fs.mkdir(sourceDir, { recursive: true });
		// Minified bucket shape: keys are (escaped) titles, payloads carry
		// heteronyms under "h" with "p" = tone-marked HanYu pinyin.
		const bucket = {
			'你好': { t: '你好', h: [{ p: 'nǐ hǎo' }] },
			'\u{20001}': { t: '\u{20001}', h: [{ p: 'nǐ' }] },
		};
		await fs.writeFile(path.join(sourceDir, '0.txt'), JSON.stringify(bucket));

		await buildHanYuLookupIndex('a', sourceDir, outputRoot);

		const ni = JSON.parse(
			await fs.readFile(path.join(outputRoot, 'a', 'HanYu', 'ni.json'), 'utf8'),
		) as string[];
		// 𠀁 (one codepoint, two UTF-16 units) must rank ahead of 你好 —
		// exercises codePointLength through the real write path.
		expect(ni).toEqual(['\u{20001}', '你好']);

		const hao = JSON.parse(
			await fs.readFile(path.join(outputRoot, 'a', 'HanYu', 'hao.json'), 'utf8'),
		) as string[];
		expect(hao).toEqual(['你好']);

		await fs.rm(root, { recursive: true, force: true });
	});
});
