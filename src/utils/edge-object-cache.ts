/**
 * Edge Object Cache（L2 colo 快取）
 *
 * 在 R2 物件讀取前面加一層 colo 級（跨 isolate）的 Cache API。它坐在既有的
 * per-isolate 記憶體 memo（L1）後面：L1 只擋得住同一個 isolate 的重複讀取，
 * 冷 isolate 一律回打 R2，實測 `moedict-fonts` 每天 0.6–1.7M 次 GetObject
 * （逐字 glyph SVG，共 492,900 個物件）就是這樣來的。
 *
 * 設計要點：
 * 1. 讀取順序 L1（呼叫端自己的 memo）→ L2（本層）→ R2。
 * 2. Negative cache：R2 miss 同樣計費，所以 404 也寫入 sentinel。
 * 3. 失效方式**只有一種**：把 `EdgeObjectCacheOptions.version` 加一。快取 key 是
 *    合成 URL，不會外洩給用戶端，也沒有任何 purge 路徑。
 * 4. 快取層永不改變行為：`caches` 不存在（單元測試／plain Node）或 Cache API
 *    拋錯時，一律 fallback 直讀 R2。
 */

export const EDGE_OBJECT_CACHE_ORIGIN = "https://edge-object-cache.moedict.invalid";

export interface EdgeObjectCacheOptions {
  /** logical bucket/namespace segment, e.g. "fonts" */
  namespace: string;
  /** cache-busting version segment; bump to invalidate every key in the namespace */
  version: string;
  /** colo cache TTL in seconds (written as s-maxage) */
  sMaxAgeSeconds: number;
}

/** Structural subset of `caches.default` used here (mock-friendly). */
interface WorkerCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/** Bridges one payload shape to/from a cached `Response`. */
interface EdgeObjectCodec<T> {
  contentType: string;
  decode(response: Response): Promise<T>;
  encode(value: T): BodyInit;
}

const TEXT_CODEC: EdgeObjectCodec<string> = {
  contentType: "text/plain; charset=utf-8",
  decode: (response) => response.text(),
  encode: (value) => value,
};

const BYTES_CODEC: EdgeObjectCodec<Uint8Array> = {
  contentType: "application/octet-stream",
  decode: async (response) => new Uint8Array(await response.arrayBuffer()),
  encode: (value) => value as unknown as BodyInit,
};

interface GlobalCachesWithDefault {
  default?: WorkerCache;
}

/**
 * `caches.default`, or null when unavailable. NEVER throws — a missing or
 * broken cache layer must degrade to a plain R2 read, not an error.
 */
function resolveDefaultCache(): WorkerCache | null {
  try {
    if (typeof caches === "undefined" || caches === null) return null;
    if (typeof caches === "object" && "default" in caches) {
      const holder = caches as GlobalCachesWithDefault;
      return holder.default ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Synthetic GET cache key:
 * `EDGE_OBJECT_CACHE_ORIGIN/<namespace>/<version>/<encodeURIComponent(key)>`.
 *
 * The R2 key is percent-encoded into a SINGLE path segment so keys containing
 * `/`, `+`, `?` or CJK cannot collide across namespaces or escape the version
 * segment.
 */
export function buildEdgeObjectCacheKey(opts: EdgeObjectCacheOptions, key: string): Request {
  return new Request(
    `${EDGE_OBJECT_CACHE_ORIGIN}/${opts.namespace}/${opts.version}/${encodeURIComponent(key)}`,
  );
}

/**
 * `null` = no usable entry (miss, unexpected status, or cache failure);
 * `{ value }` = authoritative answer, where `value === null` is the 404 sentinel.
 */
async function matchEdgeObject<T>(
  cache: WorkerCache,
  cacheKey: Request,
  codec: EdgeObjectCodec<T>,
): Promise<{ value: T | null } | null> {
  try {
    const hit = await cache.match(cacheKey);
    if (!hit) return null;
    if (hit.status === 404) return { value: null };
    if (hit.status === 200) return { value: await codec.decode(hit) };
    return null;
  } catch {
    return null;
  }
}

async function putEdgeObject(
  cache: WorkerCache,
  cacheKey: Request,
  response: Response,
): Promise<void> {
  try {
    await cache.put(cacheKey, response);
  } catch {
    // Best-effort: a failed write only costs a future R2 read.
  }
}

/**
 * L2-cached read. `load` performs the underlying R2 read and resolves to null
 * when the object is absent; its errors propagate unchanged.
 */
async function cachedObject<T>(
  load: () => Promise<T | null>,
  key: string,
  opts: EdgeObjectCacheOptions,
  codec: EdgeObjectCodec<T>,
): Promise<T | null> {
  const cache = resolveDefaultCache();
  if (!cache) return load();

  const cacheKey = buildEdgeObjectCacheKey(opts, key);
  const hit = await matchEdgeObject(cache, cacheKey, codec);
  if (hit) return hit.value;

  const value = await load();
  const cacheControl = `public, s-maxage=${opts.sMaxAgeSeconds}`;
  await putEdgeObject(
    cache,
    cacheKey,
    value === null
      ? new Response(null, { status: 404, headers: { "Cache-Control": cacheControl } })
      : new Response(codec.encode(value), {
          status: 200,
          headers: { "Content-Type": codec.contentType, "Cache-Control": cacheControl },
        }),
  );
  return value;
}

/** Read a text R2 object through the L2 colo cache. */
export function cachedObjectText(
  bucket: { get(key: string): Promise<{ text(): Promise<string> } | null> },
  key: string,
  opts: EdgeObjectCacheOptions,
): Promise<string | null> {
  return cachedObject(
    async () => {
      const object = await bucket.get(key);
      return object ? await object.text() : null;
    },
    key,
    opts,
    TEXT_CODEC,
  );
}

/** Read a binary R2 object through the L2 colo cache. */
export function cachedObjectBytes(
  bucket: { get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> },
  key: string,
  opts: EdgeObjectCacheOptions,
): Promise<Uint8Array | null> {
  return cachedObject(
    async () => {
      const object = await bucket.get(key);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
    key,
    opts,
    BYTES_CODEC,
  );
}
