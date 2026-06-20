import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SOURCE_ROOT = path.join(ROOT_DIR, 'data', 'dictionary');
const OUTPUT_ROOT = path.join(ROOT_DIR, 'build', 'stardict');
const KINDLE_OUTPUT_ROOT = path.join(ROOT_DIR, 'build', 'kindle');
const CALIBRE_CONFIG_DIR = path.join(KINDLE_OUTPUT_ROOT, '.calibre-config');

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

const LANG_METADATA = {
	a: {
		title: '萌典（國語）',
		language: 'zh-Hant-TW',
	},
	t: {
		title: '萌典（台語）',
		language: 'nan-Hant-TW',
	},
	h: {
		title: '萌典（客語）',
		language: 'hak-Hant-TW',
	},
	c: {
		title: '萌典（兩岸）',
		language: 'zh-Hant-TW',
	},
};

const BOOK_PREFIX = 'moedict';
const MOBI_CONVERTER = process.env.MOBI_CONVERTER || '';
const SKIP_MOBI = process.env.SKIP_MOBI === '1';
const MOBI_RECORDS_PER_CHUNK = Number.parseInt(process.env.MOBI_RECORDS_PER_CHUNK || '1000', 10);
const SELECTED_LANGS = (process.env.READER_FORMAT_LANGS || '')
	.split(',')
	.map((lang) => lang.trim())
	.filter(Boolean);

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
	text = text.replaceAll('`', '');
	text = text.replaceAll('~', '');
	text = text.replace(/\r?\n/g, '<br>');
	return text.trim();
}

function renderXhtmlFragment(input) {
	return input.replace(/<br>/g, '<br />');
}

function nonEmptyHtml(input) {
	const rendered = renderMarkedHtml(input);
	return rendered ? rendered : '';
}

function asciiLowerBytes(buffer) {
	const folded = Buffer.from(buffer);
	for (let index = 0; index < folded.length; index += 1) {
		const byte = folded[index];
		if (byte >= 0x41 && byte <= 0x5a) folded[index] = byte + 0x20;
	}
	return folded;
}

function stardictCompare(left, right) {
	// StarDict binary-search order: g_ascii_strcasecmp then strcmp. For UTF-8
	// that is byte order, i.e. Unicode code-point order.
	const leftBuffer = Buffer.from(left, 'utf8');
	const rightBuffer = Buffer.from(right, 'utf8');
	const foldedCompare = Buffer.compare(asciiLowerBytes(leftBuffer), asciiLowerBytes(rightBuffer));
	return foldedCompare !== 0 ? foldedCompare : Buffer.compare(leftBuffer, rightBuffer);
}

function encodeIdxEntry(word, offset, size) {
	const wordBuffer = Buffer.from(word, 'utf8');
	const idxBuffer = Buffer.alloc(wordBuffer.length + 1 + 8);
	wordBuffer.copy(idxBuffer, 0);
	idxBuffer[wordBuffer.length] = 0;
	idxBuffer.writeUInt32BE(offset, wordBuffer.length + 1);
	idxBuffer.writeUInt32BE(size, wordBuffer.length + 5);
	return idxBuffer;
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

function renderTranslationField(arrayValue, fallbackValue) {
	const list = Array.isArray(arrayValue)
		? arrayValue
		: (fallbackValue != null && fallbackValue !== '' ? [fallbackValue] : []);
	return list.map(nonEmptyHtml).filter(Boolean).join('; ');
}

function renderEntryHtml(headword, lang, entry) {
	const title = nonEmptyHtml(entry?.t) || nonEmptyHtml(headword);
	const heteronyms = Array.isArray(entry?.h) ? entry.h : [];
	const translation = entry?.translation && typeof entry.translation === 'object' && !Array.isArray(entry.translation)
		? entry.translation
		: {};
	const translations = [
		['English', renderTranslationField(translation.English ?? translation.english, entry?.English ?? entry?.english)],
		['Français', renderTranslationField(translation.francais, entry?.francais)],
		['Deutsch', renderTranslationField(translation.Deutsch, entry?.Deutsch)],
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
	const langEntries = SELECTED_LANGS.length > 0
		? Object.entries(LANG_SOURCE_DIRS).filter(([lang]) => SELECTED_LANGS.includes(lang))
		: Object.entries(LANG_SOURCE_DIRS);

	if (langEntries.length === 0) {
		throw new Error(`沒有可產生的語系：${SELECTED_LANGS.join(', ')}`);
	}

	for (const [lang, sourceDirName] of langEntries) {
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

		recordsByLang[lang].sort((left, right) => stardictCompare(left.word, right.word));
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

	const metadata = LANG_METADATA[lang];
	const bookName = `${BOOK_PREFIX}-${lang}-html`;
	const dictPath = path.join(outputDir, `${bookName}.dict`);
	const idxPath = path.join(outputDir, `${bookName}.idx`);
	const ifoPath = path.join(outputDir, `${bookName}.ifo`);

	const dictStream = fs.createWriteStream(dictPath);
	const idxChunks = [];
	let offset = 0;

	for (const record of records) {
		const articleBuffer = Buffer.from(record.article, 'utf8');
		idxChunks.push(encodeIdxEntry(record.word, offset, articleBuffer.length));
		await writeChunk(dictStream, articleBuffer);
		offset += articleBuffer.length;
	}

	await finalizeStream(dictStream);

	const idxBuffer = Buffer.concat(idxChunks);
	await fsp.writeFile(idxPath, idxBuffer);

	const ifoContent = [
		"StarDict's dict ifo file",
		'version=2.4.2',
		`bookname=${metadata.title}`,
		`wordcount=${records.length}`,
		`idxfilesize=${idxBuffer.length}`,
		'sametypesequence=h',
		`description=Generated from moedict.tw ${metadata.title} data with simplified HTML formatting.`,
		`lang=${metadata.language}`,
		`date=${new Date().toISOString().slice(0, 10)}`,
		'',
	].join('\n');
	await fsp.writeFile(ifoPath, ifoContent, 'utf8');

	console.log(`[build-reader-formats] wrote: ${path.relative(ROOT_DIR, dictPath)}`);
	console.log(`[build-reader-formats] wrote: ${path.relative(ROOT_DIR, idxPath)}`);
	console.log(`[build-reader-formats] wrote: ${path.relative(ROOT_DIR, ifoPath)}`);
}

function executeCommand(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				CALIBRE_CONFIG_DIRECTORY: CALIBRE_CONFIG_DIR,
			},
		});
		let stdout = '';
		let stderr = '';
		const label = options.label || path.basename(command);
		const startedAt = Date.now();
		const heartbeat = setInterval(() => {
			const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
			console.log(`[build-reader-formats] still running ${label} (${elapsedSeconds}s)`);
		}, 30_000);

		child.stdout.on('data', (chunk) => {
			const text = String(chunk);
			stdout += text;
			process.stdout.write(text);
		});
		child.stderr.on('data', (chunk) => {
			const text = String(chunk);
			stderr += text;
			process.stderr.write(text);
		});
		child.on('error', (error) => {
			clearInterval(heartbeat);
			reject(error);
		});
		child.on('close', (code) => {
			clearInterval(heartbeat);
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}
			reject(new Error(`${label} exited with code ${code}\n${stderr || stdout}`));
		});
	});
}

async function findExecutableFromPath(name) {
	const envPath = process.env.PATH || '';
	const extensions = process.platform === 'win32'
		? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean).map((ext) => ext.toLowerCase())
		: [''];
	for (const dir of envPath.split(path.delimiter)) {
		if (!dir) continue;
		for (const extension of extensions) {
			const candidate = path.join(dir, name + extension);
			try {
				await fsp.access(candidate, fs.constants.X_OK);
				return candidate;
			} catch {
				// Continue scanning.
			}
		}
	}
	return null;
}

async function resolveMobiConverter() {
	if (MOBI_CONVERTER) {
		const baseName = path.basename(MOBI_CONVERTER).replace(/\.(exe|cmd|bat|com)$/i, '');
		return { type: baseName, command: MOBI_CONVERTER };
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

function renderMobiChunkHtml(lang, records, chunkIndex, chunkCount) {
	const title = LANG_METADATA[lang].title;
	const items = records
		.map((record) => `<hr /><h2>${escapeHtml(record.word)}</h2><p>${renderXhtmlFragment(record.article)}</p>`)
		.join('\n');

	return [
		'<?xml version="1.0" encoding="utf-8"?>',
		'<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">',
		'<html xmlns="http://www.w3.org/1999/xhtml">',
		'<head>',
		`<title>${escapeHtml(title)}</title>`,
		'</head>',
		'<body>',
		`<h1>${escapeHtml(title)} ${chunkIndex + 1}/${chunkCount}</h1>`,
		items,
		'</body>',
		'</html>',
	].join('\n');
}

function renderOpf(lang, baseName, chunkFiles) {
	const metadata = LANG_METADATA[lang];
	const title = metadata.title;
	const manifestItems = chunkFiles
		.map((file, index) => `<item id="chunk-${index}" href="${file}" media-type="application/xhtml+xml" />`)
		.join('\n    ');
	const spineItems = chunkFiles
		.map((_file, index) => `<itemref idref="chunk-${index}" />`)
		.join('\n    ');

	return [
		'<?xml version="1.0" encoding="utf-8"?>',
		'<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">',
		'  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">',
		`    <dc:title>${escapeHtml(title)}</dc:title>`,
		`    <dc:language>${metadata.language}</dc:language>`,
		`    <dc:identifier id="bookid">urn:moedict:${baseName}</dc:identifier>`,
		'  </metadata>',
		'  <manifest>',
		`    ${manifestItems}`,
		'  </manifest>',
		'  <spine>',
		`    ${spineItems}`,
		'  </spine>',
		'</package>',
	].join('\n');
}

async function writeMobiFiles(lang, records, converter) {
	const outputDir = path.join(KINDLE_OUTPUT_ROOT, lang);
	await fsp.mkdir(outputDir, { recursive: true });
	await fsp.mkdir(CALIBRE_CONFIG_DIR, { recursive: true });

	const baseName = `${BOOK_PREFIX}-${lang}-kindle`;
	const sourceDir = path.join(outputDir, 'source');
	const opfPath = path.join(sourceDir, `${baseName}.opf`);
	const mobiPath = path.join(outputDir, `${baseName}.mobi`);
	const recordsPerChunk = Number.isFinite(MOBI_RECORDS_PER_CHUNK) && MOBI_RECORDS_PER_CHUNK > 0
		? MOBI_RECORDS_PER_CHUNK
		: 1000;
	const chunkCount = Math.ceil(records.length / recordsPerChunk);
	const chunkFiles = [];

	await fsp.rm(sourceDir, { recursive: true, force: true });
	await fsp.mkdir(sourceDir, { recursive: true });
	console.log(
		`[build-reader-formats] preparing Kindle source for ${lang}: ${records.length} entries, ${chunkCount} XHTML chunks`,
	);

	for (let index = 0; index < chunkCount; index += 1) {
		const chunkRecords = records.slice(index * recordsPerChunk, (index + 1) * recordsPerChunk);
		const chunkFile = `chunk-${String(index + 1).padStart(4, '0')}.xhtml`;
		chunkFiles.push(chunkFile);
		await fsp.writeFile(
			path.join(sourceDir, chunkFile),
			renderMobiChunkHtml(lang, chunkRecords, index, chunkCount),
			'utf8',
		);
	}

	await fsp.writeFile(opfPath, renderOpf(lang, baseName, chunkFiles), 'utf8');
	console.log(`[build-reader-formats] converting Kindle mobi for ${lang} with ${converter.type}`);

	if (converter.type === 'ebook-convert') {
		await executeCommand(
			converter.command,
			[opfPath, mobiPath, '--title', LANG_METADATA[lang].title],
			{ label: `${converter.type} (${lang})` },
		);
	} else if (converter.type === 'kindlegen') {
		await executeCommand(converter.command, [opfPath, '-o', `${baseName}.mobi`], { label: `${converter.type} (${lang})` });
	} else {
		await executeCommand(converter.command, [opfPath, mobiPath], { label: `${converter.type} (${lang})` });
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
	const langs = SELECTED_LANGS.length > 0
		? SELECTED_LANGS.filter((lang) => Object.hasOwn(LANG_SOURCE_DIRS, lang))
		: Object.keys(LANG_SOURCE_DIRS);
	for (const lang of langs) {
		await writeStarDictFiles(lang, recordsByLang[lang]);
		if (converter) {
			await writeMobiFiles(lang, recordsByLang[lang], converter);
		}
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error('[build-reader-formats] failed:', error);
		process.exitCode = 1;
	});
}

export {
	decodePackedKey,
	renderMarkedHtml,
	renderDefinition,
	renderHeteronym,
	renderEntryHtml,
	renderTranslationField,
	stardictCompare,
	encodeIdxEntry,
};
