import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SOURCE_ROOT = path.join(ROOT_DIR, 'data', 'dictionary');
const OUTPUT_ROOT = path.join(ROOT_DIR, 'build', 'stardict');
const KINDLE_OUTPUT_ROOT = path.join(ROOT_DIR, 'build', 'kindle');

const LANG_SOURCE_DIRS = {
	a: 'pack',
	t: 'ptck',
	h: 'phck',
	c: 'pcck',
};

const LANG_LABELS = {
	a: '國語',
	t: '台語',
	h: '客語',
	c: '兩岸',
};

const BOOK_PREFIX = 'moedict';
const MOBI_CONVERTER = process.env.MOBI_CONVERTER || '';
const SKIP_MOBI = process.env.SKIP_MOBI === '1';

function decodePackedKey(input) {
	return input
		.replace(/%u([0-9a-fA-F]{4})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
		.replace(/%([0-9a-fA-F]{2})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function escapeHtml(input) {
	return String(input)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function renderMarkedHtml(input) {
	if (input == null) return '';
	let text = String(input);
	text = text.replace(/[\uFFF9\uFFFA\uFFFB]/g, '');
	text = escapeHtml(text);
	text = text.replace(/`([^~`]+)~/g, '<b>$1</b>');
	text = text.replaceAll('`', '');
	text = text.replaceAll('~', '');
	text = text.replace(/\r?\n/g, '<br>');
	return text.trim();
}

function nonEmptyHtml(input) {
	const rendered = renderMarkedHtml(input);
	return rendered ? rendered : '';
}

function renderDefinition(definition) {
	const blocks = [];
	const typeText = nonEmptyHtml(definition?.type);
	const bodyText = nonEmptyHtml(definition?.f);
	const examples = Array.isArray(definition?.e) ? definition.e.map(nonEmptyHtml).filter(Boolean) : [];
	const quotes = Array.isArray(definition?.q) ? definition.q.map(nonEmptyHtml).filter(Boolean) : [];
	const links = Array.isArray(definition?.l) ? definition.l.map(nonEmptyHtml).filter(Boolean) : [];

	if (typeText || bodyText) {
		blocks.push(`${typeText ? `[${typeText}] ` : ''}${bodyText}`);
	}

	if (examples.length > 0) {
		blocks.push(`例：${examples.join(' / ')}`);
	}

	if (quotes.length > 0) {
		blocks.push(`引：${quotes.join(' / ')}`);
	}

	if (links.length > 0) {
		blocks.push(`參：${links.join(' / ')}`);
	}

	return blocks.join('<br>');
}

function renderHeteronym(heteronym, index) {
	const parts = [];
	const readings = [
		['注音', nonEmptyHtml(heteronym?.b)],
		['拼音', nonEmptyHtml(heteronym?.p)],
		['台羅', nonEmptyHtml(heteronym?.T)],
		['替代', nonEmptyHtml(heteronym?.A)],
		['音檔', nonEmptyHtml(heteronym?.['='])],
	].filter(([, value]) => value);

	parts.push(`<b>讀音 ${index + 1}</b>`);
	if (readings.length > 0) {
		parts.push(readings.map(([label, value]) => `${label}：${value}`).join('　'));
	}

	const definitions = Array.isArray(heteronym?.d) ? heteronym.d : [];
	if (definitions.length > 0) {
		const items = definitions.map((definition, definitionIndex) => `${definitionIndex + 1}. ${renderDefinition(definition)}`);
		parts.push(items.join('<br>'));
	}

	const extras = [
		['同義', nonEmptyHtml(heteronym?.s)],
		['反義', nonEmptyHtml(heteronym?.a)],
		['英譯', nonEmptyHtml(heteronym?.E)],
		['俗寫', nonEmptyHtml(heteronym?.V)],
		['綜合', nonEmptyHtml(heteronym?.C)],
		['方言', nonEmptyHtml(heteronym?.D)],
		['限定', nonEmptyHtml(heteronym?.S)],
	].filter(([, value]) => value);

	if (extras.length > 0) {
		parts.push(extras.map(([label, value]) => `${label}：${value}`).join('　'));
	}

	return parts.join('<br>');
}

function renderEntryHtml(headword, lang, entry) {
	const title = nonEmptyHtml(entry?.t) || nonEmptyHtml(headword);
	const heteronyms = Array.isArray(entry?.h) ? entry.h : [];
	const translations = [
		['English', nonEmptyHtml(entry?.English ?? entry?.english)],
		['Français', nonEmptyHtml(entry?.francais)],
		['Deutsch', nonEmptyHtml(entry?.Deutsch)],
		['翻譯', nonEmptyHtml(entry?.translation)],
	].filter(([, value]) => value);

	const blocks = [];
	blocks.push(`<b>${escapeHtml(LANG_LABELS[lang])}</b>｜${title}`);

	if (heteronyms.length > 0) {
		blocks.push(heteronyms.map((heteronym, index) => renderHeteronym(heteronym, index)).join('<br><br>'));
	}

	if (translations.length > 0) {
		blocks.push(translations.map(([label, value]) => `${label}：${value}`).join('<br>'));
	}

	return blocks.join('<br>');
}

async function getBucketFiles(dirPath) {
	const files = await fsp.readdir(dirPath);
	return files
		.filter((name) => /^\d+\.txt$/.test(name))
		.sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));
}

async function collectRecords() {
	const recordsByLang = {
		a: [],
		t: [],
		h: [],
		c: [],
	};

	for (const [lang, sourceDirName] of Object.entries(LANG_SOURCE_DIRS)) {
		const sourceDir = path.join(SOURCE_ROOT, sourceDirName);
		const bucketFiles = await getBucketFiles(sourceDir);
		console.log(`[build-reader-formats] loading ${lang}: ${bucketFiles.length} buckets`);

		for (const bucketFile of bucketFiles) {
			const raw = await fsp.readFile(path.join(sourceDir, bucketFile), 'utf8');
			const bucket = JSON.parse(raw);

			for (const [packedKey, entry] of Object.entries(bucket)) {
				const headword = decodePackedKey(packedKey);
				const articleHtml = renderEntryHtml(headword, lang, entry);
				if (!articleHtml) continue;
				recordsByLang[lang].push({ word: headword, article: articleHtml });
			}
		}

		recordsByLang[lang].sort((left, right) => left.word.localeCompare(right.word, 'zh-Hant'));
		console.log(`[build-reader-formats] ${lang} entries: ${recordsByLang[lang].length}`);
	}

	return recordsByLang;
}

function writeChunk(stream, chunk) {
	return new Promise((resolve, reject) => {
		stream.write(chunk, (error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

function finalizeStream(stream) {
	return new Promise((resolve, reject) => {
		stream.on('finish', resolve);
		stream.on('error', reject);
		stream.end();
	});
}

async function writeStarDictFiles(lang, records) {
	const outputDir = path.join(OUTPUT_ROOT, lang);
	await fsp.mkdir(outputDir, { recursive: true });

	const bookName = `${BOOK_PREFIX}-${lang}-html`;
	const dictPath = path.join(outputDir, `${bookName}.dict`);
	const idxPath = path.join(outputDir, `${bookName}.idx`);
	const ifoPath = path.join(outputDir, `${bookName}.ifo`);

	const dictStream = fs.createWriteStream(dictPath);
	const idxChunks = [];
	let offset = 0;

	for (const record of records) {
		const wordBuffer = Buffer.from(record.word, 'utf8');
		const articleBuffer = Buffer.from(record.article, 'utf8');
		const idxBuffer = Buffer.alloc(wordBuffer.length + 1 + 8);

		wordBuffer.copy(idxBuffer, 0);
		idxBuffer[wordBuffer.length] = 0;
		idxBuffer.writeUInt32BE(offset, wordBuffer.length + 1);
		idxBuffer.writeUInt32BE(articleBuffer.length, wordBuffer.length + 5);

		idxChunks.push(idxBuffer);
		await writeChunk(dictStream, articleBuffer);
		offset += articleBuffer.length;
	}

	await finalizeStream(dictStream);

	const idxBuffer = Buffer.concat(idxChunks);
	await fsp.writeFile(idxPath, idxBuffer);

	const ifoContent = [
		"StarDict's dict ifo file",
		'version=2.4.2',
		`bookname=${bookName}`,
		`wordcount=${records.length}`,
		`idxfilesize=${idxBuffer.length}`,
		'sametypesequence=h',
		`description=Generated from moedict.tw ${LANG_LABELS[lang]} data (CC0) with simplified HTML formatting.`,
		`date=${new Date().toISOString().slice(0, 10)}`,
		'',
	].join('\n');
	await fsp.writeFile(ifoPath, ifoContent, 'utf8');

	console.log(`[build-reader-formats] wrote: ${path.relative(ROOT_DIR, dictPath)}`);
	console.log(`[build-reader-formats] wrote: ${path.relative(ROOT_DIR, idxPath)}`);
	console.log(`[build-reader-formats] wrote: ${path.relative(ROOT_DIR, ifoPath)}`);
}

function executeCommand(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';

		child.stdout.on('data', (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on('data', (chunk) => {
			stderr += String(chunk);
		});
		child.on('error', (error) => reject(error));
		child.on('close', (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}
			reject(new Error(`${command} exited with code ${code}\n${stderr || stdout}`));
		});
	});
}

async function findExecutableFromPath(name) {
	const envPath = process.env.PATH || '';
	for (const dir of envPath.split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, name);
		try {
			await fsp.access(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// Continue scanning.
		}
	}
	return null;
}

async function resolveMobiConverter() {
	if (MOBI_CONVERTER) {
		return { type: path.basename(MOBI_CONVERTER), command: MOBI_CONVERTER };
	}

	const ebookConvertPath = await findExecutableFromPath('ebook-convert');
	if (ebookConvertPath) {
		return { type: 'ebook-convert', command: ebookConvertPath };
	}

	const kindlegenPath = await findExecutableFromPath('kindlegen');
	if (kindlegenPath) {
		return { type: 'kindlegen', command: kindlegenPath };
	}

	return null;
}

function renderMobiHtml(lang, records) {
	const title = `${LANG_LABELS[lang]}字典`;
	const items = records
		.map((record) => `<hr><h2>${escapeHtml(record.word)}</h2><p>${record.article}</p>`)
		.join('\n');

	return [
		'<!doctype html>',
		'<html>',
		'<head>',
		'<meta charset="utf-8">',
		`<title>${escapeHtml(title)}</title>`,
		'</head>',
		'<body>',
		`<h1>${escapeHtml(title)}</h1>`,
		items,
		'</body>',
		'</html>',
	].join('\n');
}

async function writeMobiFiles(lang, records, converter) {
	const outputDir = path.join(KINDLE_OUTPUT_ROOT, lang);
	await fsp.mkdir(outputDir, { recursive: true });

	const baseName = `${BOOK_PREFIX}-${lang}-kindle`;
	const htmlPath = path.join(outputDir, `${baseName}.html`);
	const mobiPath = path.join(outputDir, `${baseName}.mobi`);

	await fsp.writeFile(htmlPath, renderMobiHtml(lang, records), 'utf8');

	if (converter.type === 'ebook-convert') {
		await executeCommand(converter.command, [htmlPath, mobiPath, '--title', `${LANG_LABELS[lang]}字典`]);
	} else if (converter.type === 'kindlegen') {
		await executeCommand(converter.command, [htmlPath, '-o', `${baseName}.mobi`]);
	} else {
		await executeCommand(converter.command, [htmlPath, mobiPath]);
	}

	console.log(`[build-reader-formats] wrote: ${path.relative(ROOT_DIR, mobiPath)}`);
}

async function main() {
	const converter = SKIP_MOBI ? null : await resolveMobiConverter();

	if (!SKIP_MOBI && !converter) {
		throw new Error(
			'找不到 .mobi 轉檔工具。請先安裝 calibre 的 `ebook-convert` 或 Amazon `kindlegen`，或設定 `MOBI_CONVERTER=/path/to/converter`。',
		);
	}

	const recordsByLang = await collectRecords();
	for (const lang of Object.keys(LANG_SOURCE_DIRS)) {
		await writeStarDictFiles(lang, recordsByLang[lang]);
		if (converter) {
			await writeMobiFiles(lang, recordsByLang[lang], converter);
		}
	}
}

main().catch((error) => {
	console.error('[build-reader-formats] failed:', error);
	process.exitCode = 1;
});
