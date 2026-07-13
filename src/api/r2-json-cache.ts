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
 */

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

const cachesBySource = new WeakMap<R2JsonSource, Map<string, CacheEntry>>();

/**
 * Read + JSON.parse an R2 object through the per-binding memo.
 *
 * Missing objects are cached as `null` — repeat misses are billed Class B
 * operations too. JSON parse errors propagate to the caller and are NOT
 * cached (the next read retries). `now` is injectable for TTL tests.
 */
export async function readR2JsonCached(
  source: R2JsonSource,
  key: string,
  now: () => number = Date.now,
): Promise<unknown> {
  let cache = cachesBySource.get(source);
  if (!cache) {
    cache = new Map();
    cachesBySource.set(source, cache);
  }
  const hit = cache.get(key);
  if (hit && now() - hit.storedAt < R2_JSON_CACHE_TTL_MS) {
    // Refresh recency: Map preserves insertion order, so re-inserting moves
    // this key to the tail and eviction below always drops the oldest.
    cache.delete(key);
    cache.set(key, hit);
    return hit.value;
  }
  const object = await source.get(key);
  const value: unknown = object === null ? null : JSON.parse(await object.text());
  cache.delete(key);
  cache.set(key, { value, storedAt: now() });
  while (cache.size > R2_JSON_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    /* v8 ignore next -- Map with size>0 always yields a key; defensive only */
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return value;
}
