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
 * After dictionary corpus pointer promotion, memo keys are namespaced by the
 * resolved 64-hex dictionaryDigest so a warm isolate cannot re-serve old pack
 * bytes under a new edge-cache key.
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
  source: R2JsonSource,
  key: string,
  now: () => number = Date.now,
  digestOverride?: string | null,
): Promise<unknown> {
  let cache = cachesBySource.get(source);
  if (!cache) {
    cache = new Map();
    cachesBySource.set(source, cache);
  }
  const digest =
    digestOverride !== undefined ? digestOverride : await peekDictionaryCorpusDigest(source, now);
  const scopedKey = digest ? `${digest}:${key}` : key;
  const hit = cache.get(scopedKey);
  if (hit && now() - hit.storedAt < R2_JSON_CACHE_TTL_MS) {
    // Refresh recency: Map preserves insertion order, so re-inserting moves
    // this key to the tail and eviction below always drops the oldest.
    cache.delete(scopedKey);
    cache.set(scopedKey, hit);
    return hit.value;
  }
  const object = await source.get(key);
  const value: unknown = object === null ? null : JSON.parse(await object.text());
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
