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
const LOOKUP_MAP_CACHE = new Map<string, Promise<Record<string, string[]>>>();

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

async function readLookupTitles(env: LookupEnv, lang: LookupLang, type: string, term: string): Promise<string[]> {
	const key = `lookup/pinyin/${lang}/${type}/${encodeURIComponent(term)}.json`;
	const obj = await env.DICTIONARY.get(key);
	if (!obj) {
		if (lang !== 'h') return [];
		const lookupMap = await readLookupTitleMap(env, lang, type);
		return lookupMap[term] ?? [];
	}

	try {
		const raw = await obj.text();
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
	} catch {
		return [];
	}
}

async function readLookupTitleMap(env: LookupEnv, lang: LookupLang, type: string): Promise<Record<string, string[]>> {
	const cacheKey = `${lang}:${type}`;
	const cached = LOOKUP_MAP_CACHE.get(cacheKey);
	if (cached) {
		return cached;
	}

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

	LOOKUP_MAP_CACHE.set(cacheKey, pending);
	return pending;
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
