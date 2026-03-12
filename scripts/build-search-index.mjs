import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SOURCE_ROOT = path.join(ROOT_DIR, 'data', 'dictionary');
const OUTPUT_ROOT = path.join(ROOT_DIR, 'data', 'dictionary', 'search-index');
const LEGACY_PUBLIC_OUTPUT_ROOT = path.join(ROOT_DIR, 'public', 'search-index');

const LANG_SOURCE_DIRS = {
	a: 'pack',
	c: 'pcck',
	h: 'phck',
	t: 'ptck',
};

const SEARCHABLE_KEYS = new Set([
	't',
	'f',
	'e',
	's',
	'a',
	'l',
	'English',
	'english',
	'francais',
	'Deutsch',
	'translation',
]);

function decodePackedKey(input) {
	return input
		.replace(/%u([0-9a-fA-F]{4})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
		.replace(/%([0-9a-fA-F]{2})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function normalizeSearchText(input) {
	return String(input ?? '')
		.replace(/<br\s*\/?>/gi, ' ')
		.replace(/<[^>]*>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/[\uFFF9\uFFFA\uFFFB]/g, ' ')
		.replace(/[`~]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function collectSearchStrings(value, activeKey = '') {
	if (value == null) {
		return [];
	}

	if (typeof value === 'string') {
		if (activeKey && !SEARCHABLE_KEYS.has(activeKey)) {
			return [];
		}

		const normalized = normalizeSearchText(value);
		if (!normalized || /^\d+$/.test(normalized)) {
			return [];
		}

		return [normalized];
	}

	if (Array.isArray(value)) {
		return value.flatMap((item) => collectSearchStrings(item, activeKey));
	}

	if (typeof value === 'object') {
		return Object.entries(value).flatMap(([key, child]) => collectSearchStrings(child, key));
	}

	return [];
}

function dedupeStrings(parts) {
	return Array.from(new Set(parts.filter(Boolean)));
}

function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function getBucketFiles(dirPath) {
	const files = await fs.readdir(dirPath);
	return files
		.filter((name) => /^\d+\.txt$/.test(name))
		.sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));
}

async function getLatestSourceMtime(sourceDir, files) {
	let latest = 0;
	for (const file of files) {
		const stat = await fs.stat(path.join(sourceDir, file));
		latest = Math.max(latest, stat.mtimeMs);
	}
	return latest;
}

async function shouldRebuild(outputPath, sourceDir, files) {
	try {
		const [outputStat, latestSourceMtime] = await Promise.all([
			fs.stat(outputPath),
			getLatestSourceMtime(sourceDir, files),
		]);
		return outputStat.mtimeMs < latestSourceMtime;
	} catch {
		return true;
	}
}

async function buildLangIndex(lang, sourceDirName) {
	const sourceDir = path.join(SOURCE_ROOT, sourceDirName);
	const outputPath = path.join(OUTPUT_ROOT, `${lang}.json`);
	const bucketFiles = await getBucketFiles(sourceDir);

	if (bucketFiles.length === 0) {
		throw new Error(`找不到 ${lang} 的打包詞典：${sourceDir}`);
	}

	if (!(await shouldRebuild(outputPath, sourceDir, bucketFiles))) {
		const stat = await fs.stat(outputPath);
		console.log(`[build-search-index] skip ${lang} (${formatBytes(stat.size)})`);
		return;
	}

	const items = [];
	for (const bucketFile of bucketFiles) {
		const raw = await fs.readFile(path.join(sourceDir, bucketFile), 'utf8');
		const bucket = JSON.parse(raw);

		for (const [packedKey, entry] of Object.entries(bucket)) {
			const title = normalizeSearchText(decodePackedKey(packedKey));
			const content = dedupeStrings(collectSearchStrings(entry).filter((part) => part !== title)).join(' ');
			items.push({ t: title, c: content });
		}
	}

	const payload = JSON.stringify(items);
	await fs.writeFile(outputPath, payload);
	console.log(`[build-search-index] wrote ${lang}: ${items.length} entries (${formatBytes(Buffer.byteLength(payload))})`);
}

async function main() {
	await fs.rm(LEGACY_PUBLIC_OUTPUT_ROOT, { recursive: true, force: true });
	await fs.mkdir(OUTPUT_ROOT, { recursive: true });
	for (const [lang, sourceDirName] of Object.entries(LANG_SOURCE_DIRS)) {
		await buildLangIndex(lang, sourceDirName);
	}
}

main().catch((error) => {
	console.error('[build-search-index] failed', error);
	process.exitCode = 1;
});
