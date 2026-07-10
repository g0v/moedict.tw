import fs from 'node:fs/promises';
import path from 'node:path';
import { analyzePinyinField } from './hanyu-pinyin-tokens.mjs';

export { analyzePinyinField, sortDocs, insertIndex };

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const DICTIONARY_DIR = path.join(ROOT_DIR, 'data', 'dictionary');
const OUTPUT_ROOT = path.join(DICTIONARY_DIR, 'lookup', 'pinyin');

const TAIWANESE_SOURCE_DIR = path.join(DICTIONARY_DIR, 'ptck');
const TAIWANESE_TYPES = ['TL', 'DT', 'POJ'];

const HAKKA_SOURCE_DIR = path.join(DICTIONARY_DIR, 'phck');
const HAKKA_TYPES = ['TH', 'PFS'];

const MANDARIN_SOURCE_DIR = path.join(DICTIONARY_DIR, 'pack');
const CROSS_STRAIT_SOURCE_DIR = path.join(DICTIONARY_DIR, 'pcck');
const HANYU_TYPE = 'HanYu';

const HAKKA_DIALECT_MARKER_RE = /([四海大平安南])[\u20DE\u20DF](\S+)/g;
const HAKKA_SYLLABLE_RE = /[A-Za-z\u00C0-\u024F\u1E00-\u1EFF\u0300-\u036F]+[¹²³⁴⁵]+/g;

function normalizeTitle(input) {
	return String(input ?? '')
		.replace(/[`~]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function normalizeLookupTerm(input) {
	return String(input ?? '')
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{Mark}/gu, '')
		.replace(/ⁿ/g, 'nn')
		.replace(/ɑ/g, 'a')
		.replace(/[^a-z]/g, '');
}

function decodePackedKey(input) {
	return String(input ?? '')
		.replace(/%u([0-9a-fA-F]{4})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
		.replace(/%([0-9a-fA-F]{2})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function extractTitle(packedKey, entry) {
	const fromEntry = normalizeTitle(entry?.t);
	if (fromEntry) return fromEntry;
	return normalizeTitle(decodePackedKey(packedKey));
}

function sortDocs(termDocs) {
	return Array.from(termDocs.entries())
		.map(([title, [firstPos, frequency]]) => ({ title, firstPos, frequency }))
		.sort((left, right) => {
			return (
				left.title.length - right.title.length ||
				left.firstPos - right.firstPos ||
				right.frequency - left.frequency ||
				left.title.localeCompare(right.title, 'zh-Hant')
			);
		})
		.map((row) => row.title);
}

function insertIndex(index, title, terms) {
	const posMap = new Map();
	const freqMap = new Map();

	for (const [position, term] of terms.entries()) {
		const normalized = normalizeLookupTerm(term);
		if (!normalized) continue;

		if (!posMap.has(normalized)) {
			posMap.set(normalized, position);
		}
		freqMap.set(normalized, (freqMap.get(normalized) ?? 0) + 1);
	}

	for (const [term, frequency] of freqMap.entries()) {
		let docs = index.get(term);
		if (!docs) {
			docs = new Map();
			index.set(term, docs);
		}

		const existing = docs.get(title);
		if (!existing) {
			docs.set(title, [posMap.get(term) ?? 0, frequency]);
			continue;
		}

		existing[1] += frequency;
	}
}

async function getBucketFiles(sourceDir) {
	const files = await fs.readdir(sourceDir);
	return files
		.filter((name) => /^\d+\.txt$/.test(name))
		.sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));
}

async function resetOutputDir(dir) {
	await fs.rm(dir, { recursive: true, force: true });
	await fs.mkdir(dir, { recursive: true });
}

async function ensureOutputDirs(lang, types) {
	const langRoot = path.join(OUTPUT_ROOT, lang);
	await resetOutputDir(langRoot);
	for (const type of types) {
		await fs.mkdir(path.join(langRoot, type), { recursive: true });
	}
}

async function writeIndexes(lang, types, indexByType) {
	for (const type of types) {
		const typeDir = path.join(OUTPUT_ROOT, lang, type);
		const typeIndex = indexByType.get(type);
		let count = 0;

		for (const [term, docs] of typeIndex.entries()) {
			const filePath = path.join(typeDir, `${encodeURIComponent(term)}.json`);
			const payload = JSON.stringify(sortDocs(docs));
			await fs.writeFile(filePath, payload);
			count += 1;
		}

		console.log(`[build-pinyin-lookup] wrote ${lang}/${type}: ${count} terms`);
	}
}

async function writeHakkaLookupMaps(indexByType) {
	const hakkaRoot = path.join(OUTPUT_ROOT, 'h');
	await resetOutputDir(hakkaRoot);

	for (const type of HAKKA_TYPES) {
		const typeIndex = indexByType.get(type);
		const payload = Object.fromEntries(
			Array.from(typeIndex.entries()).map(([term, docs]) => [term, sortDocs(docs)])
		);
		await fs.writeFile(path.join(hakkaRoot, `${type}.json`), `${JSON.stringify(payload)}\n`);
		console.log(`[build-pinyin-lookup] wrote h/${type}: ${Object.keys(payload).length} terms`);
	}
}

function extractTlRawTokens(romanization) {
	return String(romanization ?? '').match(/[A-Za-z\u00C0-\u024F\u1E00-\u1EFF\u0300-\u036F\u207F]+/g) ?? [];
}

function convertTlTokenToDt(rawToken) {
	return String(rawToken ?? '')
		.toLowerCase()
		.replace(/ph(\w)/g, 'PH$1')
		.replace(/b(\w)/g, 'bh$1')
		.replace(/p(\w)/g, 'b$1')
		.replace(/PH(\w)/g, 'p$1')
		.replace(/tsh/g, 'c')
		.replace(/ts/g, 'z')
		.replace(/th(\w)/g, 'TH$1')
		.replace(/t(\w)/g, 'd$1')
		.replace(/TH(\w)/g, 't$1')
		.replace(/kh(\w)/g, 'KH$1')
		.replace(/g(\w)/g, 'gh$1')
		.replace(/k(\w)/g, 'g$1')
		.replace(/KH(\w)/g, 'k$1')
		.replace(/j/g, 'r')
		.replace(/([aeiou])(r?[ptkh])$/g, '$1$2')
		.replace(/nn$/g, 'n')
		.toLowerCase();
}

function convertTlTokenToPoj(rawToken) {
	return String(rawToken ?? '')
		.toLowerCase()
		.replace(/ts/g, 'ch')
		.replace(/u([^\w]*)a/g, 'o$1a')
		.replace(/u([^\w]*)e/g, 'o$1e')
		.replace(/i([^\w]*)k$/g, 'e$1k')
		.replace(/i([^\w]*)ng/g, 'e$1ng')
		.replace(/nnh$/g, 'hnn')
		.replace(/nn$/g, 'n')
		.replace(/([ie])r/g, '$1');
}

function collectTaiwaneseTermsByType(trsValue) {
	const tlRawTokens = extractTlRawTokens(trsValue);

	const tl = [];
	const dt = [];
	const poj = [];

	for (const token of tlRawTokens) {
		const tlToken = normalizeLookupTerm(token);
		if (tlToken) tl.push(tlToken);

		const dtToken = normalizeLookupTerm(convertTlTokenToDt(token));
		if (dtToken) dt.push(dtToken);

		const pojToken = normalizeLookupTerm(convertTlTokenToPoj(token));
		if (pojToken) poj.push(pojToken);
	}

	return { TL: tl, DT: dt, POJ: poj };
}

const PFS_TONE_MARK_MAP = {
	'\u00B2\u2074': '\u0302',
	'\u00B9\u00B9': '\u0300',
	'\u00B3\u00B9': '\u0301',
	'\u2075\u2075': '',
	'\u00B2': '',
	'\u2075': '\u030D',
};

function toneToPfs(segment) {
	const parts = segment.split(/([\u00B9\u00B2\u00B3\u2074\u2075]+)/);
	if (parts.length < 2) return segment;
	const syllable = parts[0];
	const tone = parts[1];
	const mark = PFS_TONE_MARK_MAP[tone];
	if (mark === undefined) return segment;

	const vowels = ['o', 'e', 'a', 'u', 'i', '\u1E73', 'n', 'm'];
	for (const vowel of vowels) {
		const pos = syllable.indexOf(vowel);
		if (pos >= 0) {
			const before = syllable.slice(0, pos + 1);
			const after = syllable.slice(pos + 1);
			return `${before}${mark}${after}`;
		}
	}
	return segment;
}

function thToPfs(input) {
	const normalized = String(input ?? '')
		.replace(/t/g, 'th')
		.replace(/p/g, 'ph')
		.replace(/k/g, 'kh')
		.replace(/c/g, 'chh')
		.replace(/b/g, 'p')
		.replace(/d/g, 't')
		.replace(/g/g, 'k')
		.replace(/nk/g, 'ng')
		.replace(/j/g, 'ch')
		.replace(/q/g, 'chh')
		.replace(/x/g, 's')
		.replace(/z/g, 'ch')
		.replace(/ii/g, '\u1E73')
		.replace(/ua/g, 'oa')
		.replace(/ue/g, 'oe')
		.replace(/\bi/g, 'y')
		.replace(/\by(\b|[ptk])h?/g, 'yi$1')
		.replace(/(i[ptk])h/g, '$1')
		.replace(/y([mn])/g, 'yi$1');

	return toneToPfs(normalized);
}

function parseHakkaDialectReadings(rawPinyin) {
	const source = String(rawPinyin ?? '');
	if (!source) {
		return [];
	}

	const readings = [];
	let match = HAKKA_DIALECT_MARKER_RE.exec(source);
	while (match) {
		const dialect = match[1] || '';
		const reading = match[2] || '';
		if (dialect && reading) {
			readings.push({ dialect, reading });
		}
		match = HAKKA_DIALECT_MARKER_RE.exec(source);
	}
	HAKKA_DIALECT_MARKER_RE.lastIndex = 0;
	return readings;
}

function extractHakkaSyllables(reading) {
	const matches = String(reading ?? '').match(HAKKA_SYLLABLE_RE);
	if (matches && matches.length > 0) {
		return matches;
	}

	const fallback = normalizeLookupTerm(reading);
	return fallback ? [reading] : [];
}

function buildFirstSyllableTerms(tokens) {
	const first = normalizeLookupTerm(tokens[0]);
	return first ? [first] : [];
}

function collectHakkaTermsByType(rawPinyin) {
	const th = [];
	const pfs = [];

	for (const { dialect, reading } of parseHakkaDialectReadings(rawPinyin)) {
		const syllables = extractHakkaSyllables(reading);
		if (syllables.length === 0) continue;

		th.push(...buildFirstSyllableTerms(syllables));

		if (dialect === '四') {
			pfs.push(...buildFirstSyllableTerms(syllables.map((syllable) => thToPfs(syllable))));
		}
	}

	return { TH: th, PFS: pfs };
}

async function buildTaiwaneseLookupIndex() {
	const bucketFiles = await getBucketFiles(TAIWANESE_SOURCE_DIR);
	if (bucketFiles.length === 0) {
		throw new Error(`找不到台語詞典資料：${TAIWANESE_SOURCE_DIR}`);
	}

	const indexByType = new Map(TAIWANESE_TYPES.map((type) => [type, new Map()]));

	for (const bucketFile of bucketFiles) {
		const bucketPath = path.join(TAIWANESE_SOURCE_DIR, bucketFile);
		const bucketRaw = await fs.readFile(bucketPath, 'utf8');
		const bucket = JSON.parse(bucketRaw);

		for (const [packedKey, entry] of Object.entries(bucket)) {
			const title = extractTitle(packedKey, entry);
			if (!title) continue;

			const heteronyms = Array.isArray(entry?.h) ? entry.h : [];
			for (const heteronym of heteronyms) {
				const trs = heteronym?.T;
				if (typeof trs !== 'string' || trs.trim().length === 0) continue;

				const termsByType = collectTaiwaneseTermsByType(trs);
				for (const type of TAIWANESE_TYPES) {
					insertIndex(indexByType.get(type), title, termsByType[type]);
				}
			}
		}
	}

	await ensureOutputDirs('t', TAIWANESE_TYPES);
	await writeIndexes('t', TAIWANESE_TYPES, indexByType);
}

async function buildHanYuLookupIndex(lang, sourceDir) {
	const bucketFiles = await getBucketFiles(sourceDir);
	if (bucketFiles.length === 0) {
		throw new Error(`找不到華語詞典資料：${sourceDir}`);
	}

	const indexByType = new Map([[HANYU_TYPE, new Map()]]);

	for (const bucketFile of bucketFiles) {
		const bucketPath = path.join(sourceDir, bucketFile);
		const bucketRaw = await fs.readFile(bucketPath, 'utf8');
		const bucket = JSON.parse(bucketRaw);

		for (const [packedKey, entry] of Object.entries(bucket)) {
			const title = extractTitle(packedKey, entry);
			if (!title) continue;

			const heteronyms = Array.isArray(entry?.h) ? entry.h : [];
			for (const heteronym of heteronyms) {
				const rawPinyin = heteronym?.p;
				if (typeof rawPinyin !== 'string' || rawPinyin.trim().length === 0) continue;

				const tokens = analyzePinyinField(rawPinyin, lang);
				if (tokens.length === 0) continue;

				insertIndex(indexByType.get(HANYU_TYPE), title, tokens);
			}
		}
	}

	await ensureOutputDirs(lang, [HANYU_TYPE]);
	await writeIndexes(lang, [HANYU_TYPE], indexByType);
}

async function buildHakkaLookupIndex() {
	const bucketFiles = await getBucketFiles(HAKKA_SOURCE_DIR);
	if (bucketFiles.length === 0) {
		throw new Error(`找不到客語詞典資料：${HAKKA_SOURCE_DIR}`);
	}

	const indexByType = new Map(HAKKA_TYPES.map((type) => [type, new Map()]));

	for (const bucketFile of bucketFiles) {
		const bucketPath = path.join(HAKKA_SOURCE_DIR, bucketFile);
		const bucketRaw = await fs.readFile(bucketPath, 'utf8');
		const bucket = JSON.parse(bucketRaw);

		for (const [packedKey, entry] of Object.entries(bucket)) {
			const title = extractTitle(packedKey, entry);
			if (!title) continue;

			const heteronyms = Array.isArray(entry?.h) ? entry.h : [];
			for (const heteronym of heteronyms) {
				const rawPinyin = heteronym?.p;
				if (typeof rawPinyin !== 'string' || rawPinyin.trim().length === 0) continue;

				const termsByType = collectHakkaTermsByType(rawPinyin);
				for (const type of HAKKA_TYPES) {
					insertIndex(indexByType.get(type), title, termsByType[type]);
				}
			}
		}
	}

	await writeHakkaLookupMaps(indexByType);
}

async function main() {
	await buildTaiwaneseLookupIndex();
	await buildHakkaLookupIndex();
	await buildHanYuLookupIndex('a', MANDARIN_SOURCE_DIR);
	await buildHanYuLookupIndex('c', CROSS_STRAIT_SOURCE_DIR);
}

main().catch((error) => {
	console.error('[build-pinyin-lookup] failed', error);
	process.exitCode = 1;
});
