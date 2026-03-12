/// <reference lib="webworker" />

import Fuse from 'fuse.js';
import type { FuseResult, IFuseOptions } from 'fuse.js';

type Lang = 'a' | 't' | 'h' | 'c';

interface SearchDoc {
	t: string;
	c: string;
}

interface SearchState {
	fuse: Fuse<SearchDoc>;
}

interface WarmupMessage {
	type: 'warmup';
	lang: Lang;
}

interface SearchMessage {
	type: 'search';
	lang: Lang;
	query: string;
	limit: number;
	requestId: number;
}

type WorkerMessage = WarmupMessage | SearchMessage;

const SEARCH_OPTIONS: IFuseOptions<SearchDoc> = {
	includeMatches: true,
	ignoreLocation: true,
	minMatchCharLength: 2,
	threshold: 0.35,
	keys: [
		{ name: 't', weight: 0.7 },
		{ name: 'c', weight: 0.3 },
	],
};

const searchStatePromises = new Map<Lang, Promise<SearchState>>();

function trimSnippet(content: string, start = 0, end = 90): string {
	const safeStart = Math.max(0, start);
	const safeEnd = Math.min(content.length, end);
	let snippet = content.slice(safeStart, safeEnd).trim();

	if (safeStart > 0 && snippet) {
		snippet = `…${snippet}`;
	}

	if (safeEnd < content.length && snippet) {
		snippet = `${snippet}…`;
	}

	return snippet;
}

function buildSnippet(result: FuseResult<SearchDoc>): string {
	const content = result.item.c.trim();
	if (!content) {
		return '';
	}

	const contentMatch = result.matches?.find((match) => match.key === 'c' && match.indices.length > 0);
	if (!contentMatch) {
		return trimSnippet(content);
	}

	const [matchStart, matchEnd] = contentMatch.indices[0];
	return trimSnippet(content, matchStart - 18, matchEnd + 42);
}

async function loadSearchState(lang: Lang): Promise<SearchState> {
	const response = await fetch(`/api/search-index/${lang}.json`, {
		headers: { Accept: 'application/json' },
	});

	if (!response.ok) {
		throw new Error(`全文索引讀取失敗：${response.status}`);
	}

	const docs = (await response.json()) as SearchDoc[];
	return {
		fuse: new Fuse(docs, SEARCH_OPTIONS),
	};
}

function getSearchState(lang: Lang): Promise<SearchState> {
	const cached = searchStatePromises.get(lang);
	if (cached) {
		return cached;
	}

	const pending = loadSearchState(lang).catch((error) => {
		searchStatePromises.delete(lang);
		throw error;
	});

	searchStatePromises.set(lang, pending);
	return pending;
}

self.addEventListener('message', async (event: MessageEvent<WorkerMessage>) => {
	const message = event.data;

	try {
		const state = await getSearchState(message.lang);

		if (message.type === 'warmup') {
			self.postMessage({ type: 'ready', lang: message.lang });
			return;
		}

		const results = state.fuse.search(message.query.trim(), { limit: message.limit }).map((result) => ({
			title: result.item.t,
			snippet: buildSnippet(result),
		}));

		self.postMessage({
			type: 'results',
			lang: message.lang,
			requestId: message.requestId,
			results,
		});
	} catch (error) {
		self.postMessage({
			type: 'error',
			lang: message.lang,
			requestId: message.type === 'search' ? message.requestId : undefined,
			message: error instanceof Error ? error.message : '全文索引載入失敗',
		});
	}
});
