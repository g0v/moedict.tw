/**
 * Per-R2-binding memo of parsed JSON objects.
 *
 * WHY: the 2026-07 billing audit showed the dictionary Worker re-reading the
 * same R2 objects on every request — 27M+ Class B GETs per cycle, dominated
 * by `p{lang}ck/<bucket>.txt` shards and the per-lang `xref.json` /
 * `xref-by-id.json` sidecars (the sidecars are read TWICE per entry lookup).
 * These objects change only when dictionary data is re-uploaded (rare), so a
 * short per-isolate memo removes the repeat GETs without meaningfully
 * delaying data propagation — entry responses are edge-cached for 24h anyway
 * (src/api/cache.ts), so a 10-minute memo is never the freshness bottleneck.
 *
 * Scoping: the memo is keyed on the R2 binding OBJECT via WeakMap. Each unit
 * test constructs its own mock binding, so tests stay isolated for free;
 * production reuses one binding per isolate, which is exactly the intended
 * cache lifetime. Entries evict LRU beyond a small cap so a crawler walking
 * distinct buckets cannot grow isolate memory unboundedly.
 *
 * After dictionary pointer promotion, memo keys are namespaced by the resolved
 * 64-hex dictionaryDigest so a warm isolate cannot re-serve old pack bytes under
 * a new edge-cache key. Reads still use bare flat keys (`source.get(key)`); only
 * the memo identity is versioned — this is cache busting, not atomic corpora.
 */

import {
  DICTIONARY_CORPUS_POINTER_KEY,
  isDictionaryCorpusPointer,
  type DictionaryCorpusPointer,
} from "../utils/dictionary-corpus";

interface CacheEntry {
  value: unknown;
  storedAt: number;
}

/** Structural subset of an R2 bucket binding used here (mock-friendly). */
export interface R2JsonSource {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

export const R2_JSON_CACHE_TTL_MS = 600_000;
export const R2_JSON_CACHE_MAX_ENTRIES = 24;
export const DICTIONARY_CORPUS_CACHE_TTL_MS = 600_000;

export type DictionaryPointerState =
  | { kind: "valid"; digest: string }
  | { kind: "missing" }
  | { kind: "error" };

interface PointerCacheEntry {
  state: DictionaryPointerState;
  storedAt: number;
}

const cachesBySource = new WeakMap<R2JsonSource, Map<string, CacheEntry>>();
const pointerCacheBySource = new WeakMap<R2JsonSource, PointerCacheEntry>();

/**
 * Resolve the current dictionary corpus pointer state from R2.
 *
 * Three states (not collapsed to null):
 * - valid: pointer present and schema-valid → use 64-hex digest
 * - missing: object absent → rollout fallback to build-time version is OK
 * - error: read/parse failure → callers MUST bypass caches.default so
 *   repeated failures cannot serve indefinitely-stale edge entries
 *
 * Memoized per R2 binding with a TTL so warm requests incur zero extra GETs.
 */
export async function resolveDictionaryPointerState(
  source: R2JsonSource | null | undefined,
  now: () => number = Date.now,
): Promise<DictionaryPointerState> {
  if (!source) return { kind: "missing" };
  const cached = pointerCacheBySource.get(source);
  if (cached && now() - cached.storedAt < DICTIONARY_CORPUS_CACHE_TTL_MS) {
    return cached.state;
  }

  try {
    const obj = await source.get(DICTIONARY_CORPUS_POINTER_KEY);
    if (!obj) {
      const state: DictionaryPointerState = { kind: "missing" };
      pointerCacheBySource.set(source, { state, storedAt: now() });
      return state;
    }
    const parsed: unknown = JSON.parse(await obj.text());
    if (!isDictionaryCorpusPointer(parsed)) {
      const state: DictionaryPointerState = { kind: "error" };
      pointerCacheBySource.set(source, { state, storedAt: now() });
      return state;
    }
    const pointer = parsed as DictionaryCorpusPointer;
    const state: DictionaryPointerState = {
      kind: "valid",
      digest: pointer.dictionaryDigest.toLowerCase(),
    };
    pointerCacheBySource.set(source, { state, storedAt: now() });
    return state;
  } catch {
    const state: DictionaryPointerState = { kind: "error" };
    pointerCacheBySource.set(source, { state, storedAt: now() });
    return state;
  }
}

/** Convenience: digest string when valid, else null (missing/error). */
export async function peekDictionaryCorpusDigest(
  source: R2JsonSource | null | undefined,
  now: () => number = Date.now,
): Promise<string | null> {
  const state = await resolveDictionaryPointerState(source, now);
  return state.kind === "valid" ? state.digest : null;
}

export interface DictionaryObjectFetchEnv {
  DICTIONARY: R2JsonSource;
  DICTIONARY_BASE_URL?: string;
  /**
   * Opt-in gate for reading dictionary objects through the PUBLIC R2 custom
   * domain instead of the binding. Set to "1" in production vars only.
   *
   * `DICTIONARY_BASE_URL` alone is NOT a sufficient gate: the `staging` env in
   * wrangler.jsonc binds the `-preview` buckets but still advertises the
   * production `https://r2-dictionary.moedict.tw` (because /api/config echoes
   * it), so gating on the URL would make staging silently serve PRODUCTION
   * dictionary bytes and break the prod/staging isolation documented in
   * AGENTS.md.
   */
  DICTIONARY_PUBLIC_READS?: string;
}

type R2JsonSourceOrEnv = R2JsonSource | DictionaryObjectFetchEnv;

/**
 * Read text content of a dictionary R2 object, routing through the public
 * CDN zone cache when DICTIONARY_BASE_URL is configured.
 *
 * WHY: Direct R2 binding GETs (`env.DICTIONARY.get()`) are billed as Class B
 * operations per isolate per colo. Requesting objects via the public custom
 * domain (`DICTIONARY_BASE_URL`) with `cf: { cacheEverything: true, cacheTtl: 86400 }`
 * and a corpus digest query parameter (`?v=<digest>`) allows Cloudflare's
 * zone CDN to cache the response at the edge colo across isolates.
 * When the corpus is promoted, the digest changes, busting the zone cache.
 *
 * A missing or unreadable pointer falls back to the binding: without a digest,
 * a public-domain request could not be safely cache-busted after promotion.
 *
 * NOTE: This function provides edge caching for raw object subrequests. It does
 * NOT replace the `caches.default` digest-namespaced dispatch response caching
 * layer in `worker/index.ts`.
 */
export async function fetchDictionaryObjectText(
  env: DictionaryObjectFetchEnv,
  key: string,
  knownDigest?: string | null,
): Promise<string | null> {
  const { DICTIONARY: binding, DICTIONARY_BASE_URL: baseUrl } = env;
  const publicReads = env.DICTIONARY_PUBLIC_READS === "1";

  const readFromBinding = async (): Promise<string | null> => {
    if (!binding) return null;
    const obj = await binding.get(key);
    return obj ? await obj.text() : null;
  };

  const normalizedBaseUrl = baseUrl?.trim();
  if (!publicReads || !normalizedBaseUrl || typeof fetch === "undefined") {
    return readFromBinding();
  }

  let digest: string | null = null;
  if (knownDigest !== undefined) {
    digest = knownDigest;
  } else {
    const pointerState = await resolveDictionaryPointerState(binding);
    if (pointerState.kind === "valid") {
      digest = pointerState.digest;
    }
  }

  if (!digest) {
    return readFromBinding();
  }

  const cleanBase = normalizedBaseUrl.replace(/\/+$/, "");
  const cleanKey = key.replace(/^\/+/, "");
  const url = `${cleanBase}/${cleanKey}?v=${encodeURIComponent(digest)}`;
  try {
    const res = await fetch(url, {
      cf: {
        cacheEverything: true,
        cacheTtl: 86400,
      },
    } as RequestInit);

    if (res.status === 200) {
      return await res.text();
    }
    if (res.status === 404) {
      return null;
    }
    return readFromBinding();
  } catch {
    return readFromBinding();
  }
}

/**
 * Read + JSON.parse an R2 object through the per-binding memo.
 *
 * Missing objects are cached as `null` — repeat misses are billed Class B
 * operations too. JSON parse errors propagate to the caller and are NOT
 * cached (the next read retries). `now` is injectable for TTL tests.
 *
 * When a dictionary corpus digest is available (via pointer or override),
 * the memo key is `${digest}:${key}` so a pointer promotion cannot re-serve
 * a warm old pack under the new edge-cache identity.
 */
export async function readR2JsonCached(
  sourceOrEnv: R2JsonSourceOrEnv,
  key: string,
  now: () => number = Date.now,
  digestOverride?: string | null,
): Promise<unknown> {
  const binding = "DICTIONARY" in sourceOrEnv ? sourceOrEnv.DICTIONARY : sourceOrEnv;

  let cache = cachesBySource.get(binding);
  if (!cache) {
    cache = new Map();
    cachesBySource.set(binding, cache);
  }
  const digest =
    digestOverride !== undefined ? digestOverride : await peekDictionaryCorpusDigest(binding, now);
  const scopedKey = digest ? `${digest}:${key}` : key;
  const hit = cache.get(scopedKey);
  if (hit && now() - hit.storedAt < R2_JSON_CACHE_TTL_MS) {
    // Refresh recency: Map preserves insertion order, so re-inserting moves
    // this key to the tail and eviction below always drops the oldest.
    cache.delete(scopedKey);
    cache.set(scopedKey, hit);
    return hit.value;
  }
  const objectText =
    "DICTIONARY" in sourceOrEnv
      ? await fetchDictionaryObjectText(sourceOrEnv, key, digest)
      : await sourceOrEnv.get(key).then((object) => (object ? object.text() : null));
  const value: unknown = objectText === null ? null : JSON.parse(objectText);
  cache.delete(scopedKey);
  cache.set(scopedKey, { value, storedAt: now() });
  while (cache.size > R2_JSON_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    /* v8 ignore next -- Map with size>0 always yields a key; defensive only */
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return value;
}
