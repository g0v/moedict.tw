import { tryDecodeURIComponent } from '../utils/dictionary-route';

type LookupLang = 'a' | 't' | 'h' | 'c';

interface LookupObjectLike {
	text(): Promise<string>;
}

interface LookupBucketLike {
	get(key: string): Promise<LookupObjectLike | null>;
}

interface LookupEnv {
	DICTIONARY: LookupBucketLike;
}

const LOOKUP_LANG_SET = new Set<LookupLang>(['a', 't', 'h', 'c']);
const LOOKUP_CORS_ALLOWLIST = new Set(['https://moedict.tw', 'https://old.moedict.tw', 'http://old.moedict.tw', 'https://www.moedict.org', 'http://www.moedict.org', 'https://moedict.org', 'http://moedict.org']);
const PINYIN_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=1800';
const TRS_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=1800';
const LOOKUP_MAP_TTL_MS = 300_000;
interface LookupMapCacheEntry {
	expiresAt: number;
	pending: Promise<Record<string, string[]>>;
}
const LOOKUP_MAP_CACHE = new WeakMap<LookupEnv, Map<string, LookupMapCacheEntry>>();

function buildLookupCORSHeaders(request: Request): Record<string, string> {
	const origin = request.headers.get('Origin');
	if (origin && LOOKUP_CORS_ALLOWLIST.has(origin)) {
		return {
			'Access-Control-Allow-Origin': origin,
			'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
			Vary: 'Origin',
		};
	}
	return {};
}

function createJsonResponse(request: Request, payload: unknown, cacheControl: string): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': cacheControl,
			...buildLookupCORSHeaders(request),
		},
	});
}

function createTextResponse(request: Request, payload: string, cacheControl: string): Response {
	return new Response(payload, {
		status: 200,
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': cacheControl,
			...buildLookupCORSHeaders(request),
		},
	});
}

export function normalizeLookupTerm(input: string): string {
	return String(input || '')
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{Mark}/gu, '')
		.replace(/ⁿ/g, 'nn')
		.replace(/ɑ/g, 'a')
		.replace(/[^a-z]/g, '');
}

export function parsePinyinLookupPath(pathname: string): { lang: LookupLang; type: string; term: string } | null {
	const match = pathname.match(/^\/api\/lookup\/pinyin\/([athc])\/([^/]+)\/(.+)\.json$/);
	if (!match) return null;
	const [, lang, rawType, rawTerm] = match;
	const type = tryDecodeURIComponent(rawType) ?? '';
	const term = normalizeLookupTerm(tryDecodeURIComponent(rawTerm) ?? '');
	if (!type || !term || !LOOKUP_LANG_SET.has(lang as LookupLang)) return null;
	return {
		lang: lang as LookupLang,
		type,
		term,
	};
}

export function parseTrsLookupPath(pathname: string): { term: string } | null {
	const noApi = pathname.match(/^\/api\/lookup\/trs\/(.+)$/);
	if (noApi) {
		const term = normalizeLookupTerm(tryDecodeURIComponent(noApi[1]) ?? '');
		return term ? { term } : null;
	}

	const legacy = pathname.match(/^\/lookup\/trs\/(.+)$/);
	if (legacy) {
		const term = normalizeLookupTerm(tryDecodeURIComponent(legacy[1]) ?? '');
		return term ? { term } : null;
	}

	return null;
}

async function readPerTermTitles(
	env: LookupEnv,
	lang: LookupLang,
	type: string,
	term: string
): Promise<string[]> {
	const key = `lookup/pinyin/${lang}/${type}/${encodeURIComponent(term)}.json`;
	const obj = await env.DICTIONARY.get(key);
	if (!obj) return [];

	try {
		const parsed = JSON.parse(await obj.text()) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
	} catch {
		return [];
	}
}

function getOwnLookupTitles(lookupMap: Record<string, string[]>, term: string): string[] {
	return Object.prototype.hasOwnProperty.call(lookupMap, term) ? lookupMap[term] : [];
}

async function readLookupTitles(env: LookupEnv, lang: LookupLang, type: string, term: string): Promise<string[]> {
	const perTerm = await readPerTermTitles(env, lang, type, term);
	if (lang === 't') {
		const wholeWord = getOwnLookupTitles(await readLookupTitleMap(env, lang, type), term);
		return Array.from(new Set([...wholeWord, ...perTerm]));
	}
	if (perTerm.length > 0 || lang !== 'h') return perTerm;
	const lookupMap = await readLookupTitleMap(env, lang, type);
	return getOwnLookupTitles(lookupMap, term);
}

async function readLookupTitleMap(env: LookupEnv, lang: LookupLang, type: string): Promise<Record<string, string[]>> {
	const cacheKey = `${lang}:${type}`;
	let envCache = LOOKUP_MAP_CACHE.get(env);
	if (!envCache) {
		envCache = new Map();
		LOOKUP_MAP_CACHE.set(env, envCache);
	}
	const cached = envCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) return cached.pending;
	if (cached) envCache.delete(cacheKey);

	const pending = (async () => {
		const key = `lookup/pinyin/${lang}/${type}.json`;
		const obj = await env.DICTIONARY.get(key);
		if (!obj) return {};

		try {
			const raw = await obj.text();
			const parsed = JSON.parse(raw) as unknown;
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return {};
			}

			const result: Record<string, string[]> = {};
			for (const [term, titles] of Object.entries(parsed)) {
				if (!Array.isArray(titles)) continue;
				result[term] = titles.filter((item): item is string => typeof item === 'string' && item.length > 0);
			}
			return result;
		} catch {
			return {};
		}
	})();

	envCache.set(cacheKey, { expiresAt: Date.now() + LOOKUP_MAP_TTL_MS, pending });
	try {
		return await pending;
	} catch (error) {
		envCache.delete(cacheKey);
		throw error;
	}
}

export async function handleLookupAPI(request: Request, url: URL, env: LookupEnv): Promise<Response | null> {
	const pinyinPath = parsePinyinLookupPath(url.pathname);
	if (pinyinPath) {
		const titles = await readLookupTitles(env, pinyinPath.lang, pinyinPath.type, pinyinPath.term);
		return createJsonResponse(request, titles, PINYIN_CACHE_CONTROL);
	}

	const trsPath = parseTrsLookupPath(url.pathname);
	if (trsPath) {
		const titles = await readLookupTitles(env, 't', 'TL', trsPath.term);
		const payload = titles.join('|');
		return createTextResponse(request, payload, TRS_CACHE_CONTROL);
	}

	return null;
}
