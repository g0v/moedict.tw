import { CACHE_CONTROL } from "./cache";
import { tryDecodeURIComponent } from "../utils/dictionary-route";
import {
  STROKE_CORPUS_POINTER_KEY,
  STROKE_CORPUS_EXPECTED_COUNT,
  strokeCorpusObjectKey,
  isStrokeCorpusPointer,
  isStrokeCorpusManifest,
  type StrokeCorpusPointer,
  type StrokeCorpusManifest,
} from "../utils/stroke-corpus";

/**
 * Narrow R2 surfaces used by the stroke API. Mirrors the DictionaryBucketLike
 * pattern in handleDictionaryAPI.ts so this file typechecks under
 * tsconfig.app.json (which does not pull in worker-configuration.d.ts).
 */
interface StrokeObjectLike {
  httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
}

interface StrokeObjectBodyLike extends StrokeObjectLike {
  body: ReadableStream;
  text(): Promise<string>;
}

export interface StrokeBucketLike {
  head(key: string): Promise<StrokeObjectLike | null>;
  get(
    key: string,
    options?: { onlyIf?: Headers | object },
  ): Promise<StrokeObjectBodyLike | StrokeObjectLike | null>;
}

/**
 * Minimal env surface for the stroke API. Accepts the full Worker Env or a
 * narrow test double — only `ASSETS` is required.
 */
export interface StrokeEnv {
  ASSETS: StrokeBucketLike;
}

// ---------------------------------------------------------------------------
// Per-isolate pointer/manifest cache
// ---------------------------------------------------------------------------
//
// Every request needs the current corpus pointer + manifest to resolve a
// codepoint into a versioned object key. Re-reading those two small objects
// on every request would double the R2 Class B GETs for zero benefit — the
// pointer only changes when an operator promotes a new corpus (rare, see
// commands/sync-moe-stroke-corpus.mjs promoteCorpusPointer). Mirrors the
// WeakMap-per-binding LRU/TTL pattern in src/api/r2-json-cache.ts and
// src/utils/image-generation.ts: keyed on the ASSETS binding object so unit
// tests (each constructing their own mock binding) stay isolated for free,
// and production reuses one binding per isolate for the cache's lifetime.
//
// Resolution failures (missing/invalid pointer or manifest) are cached too
// (as `null`) with a short TTL — a misconfigured bucket must not turn into
// an R2 hot loop of repeat authenticated reads on every request.

interface ResolvedCorpus {
  pointer: StrokeCorpusPointer;
  manifest: StrokeCorpusManifest;
  /** hex codepoint (lowercase) -> { sha256, bytes } for O(1) allowlist checks. */
  filesByHex: Map<string, { sha256: string; bytes: number }>;
}

interface ResolvedCorpusCacheEntry {
  value: ResolvedCorpus | null;
  storedAt: number;
}

export const STROKE_RESOLVE_CACHE_TTL_MS = 600_000;

const resolvedCorpusCache = new WeakMap<StrokeBucketLike, ResolvedCorpusCacheEntry>();

/** Bounded per-isolate negative memo for missing/disallowed codepoints — stops repeat R2 Class B billing for crawlers walking absent keys. */
export const STROKE_NEGATIVE_CACHE_TTL_MS = 300_000;
export const STROKE_NEGATIVE_CACHE_MAX_ENTRIES = 512;

interface NegativeCacheEntry {
  storedAt: number;
}

const negativeCodepointCache = new WeakMap<StrokeBucketLike, Map<string, NegativeCacheEntry>>();

function rememberNegative(bucket: StrokeBucketLike, key: string, now: () => number): void {
  let cache = negativeCodepointCache.get(bucket);
  if (!cache) {
    cache = new Map();
    negativeCodepointCache.set(bucket, cache);
  }
  cache.delete(key);
  cache.set(key, { storedAt: now() });
  // Insertion-order iteration (Map guarantee) doubles as oldest-first
  // eviction order. Deleting the CURRENT key mid-iteration is well-defined
  // for Map iterators (the iterator has already captured it; deletion
  // does not disturb the walk to the next entry) — this avoids the
  // `.next().value === undefined` guard the while-loop equivalent needs,
  // since `cache.size` is checked before ever touching `oldest`.
  for (const oldest of cache.keys()) {
    if (cache.size <= STROKE_NEGATIVE_CACHE_MAX_ENTRIES) break;
    cache.delete(oldest);
  }
}

function isRememberedNegative(bucket: StrokeBucketLike, key: string, now: () => number): boolean {
  const cache = negativeCodepointCache.get(bucket);
  const hit = cache?.get(key);
  if (!hit) return false;
  if (now() - hit.storedAt >= STROKE_NEGATIVE_CACHE_TTL_MS) {
    cache?.delete(key);
    return false;
  }
  return true;
}

/**
 * Resolve the current corpus pointer + manifest, validating both against
 * the schemas in src/utils/stroke-corpus.ts and the expected 6,063-file
 * count. Cached per-ASSETS-binding for STROKE_RESOLVE_CACHE_TTL_MS,
 * including negative results (`null`) so a broken/missing pointer doesn't
 * cause a resolve attempt on every single request.
 */
async function resolveCorpus(
  bucket: StrokeBucketLike,
  now: () => number,
): Promise<ResolvedCorpus | null> {
  const cached = resolvedCorpusCache.get(bucket);
  if (cached && now() - cached.storedAt < STROKE_RESOLVE_CACHE_TTL_MS) {
    return cached.value;
  }

  const value = await resolveCorpusUncached(bucket);
  resolvedCorpusCache.set(bucket, { value, storedAt: now() });
  return value;
}

/**
 * Peek the current corpus digest WITHOUT serving a request — used by
 * worker/index.ts's `dispatch()` to derive an edge-cache key that is
 * namespaced by `corpusDigest` for `/api/stroke-json/*` routes, so a
 * pointer promotion (new corpusDigest) automatically creates a distinct
 * `caches.default` key instead of relying on the unavailable
 * `CACHE_PURGE_TOKEN` secret to invalidate stale entries at the edge.
 *
 * Reuses the exact same {@link resolveCorpus} call (same WeakMap,
 * same per-isolate TTL) that `handleStrokeAPI` itself uses — this is
 * NOT a second independent resolution path. When `handleStrokeAPI` runs
 * moments later for the same request, it hits the already-warmed
 * `resolvedCorpusCache` entry and performs zero additional R2 reads.
 *
 * Returns `null` when the pointer/manifest is missing, malformed, or
 * fails cross-validation — callers MUST treat `null` as "bypass the edge
 * cache entirely and let the request fall through to `handleStrokeAPI`",
 * which then returns its own fail-closed 503 (never cached, since 503
 * responses are `no-store` and non-200).
 */
export async function peekStrokeCorpusDigest(
  bucket: StrokeBucketLike,
  now: () => number = Date.now,
): Promise<string | null> {
  const resolved = await resolveCorpus(bucket, now);
  return resolved ? resolved.pointer.corpusDigest : null;
}

async function resolveCorpusUncached(bucket: StrokeBucketLike): Promise<ResolvedCorpus | null> {
  try {
    const pointerObj = await bucket.get(STROKE_CORPUS_POINTER_KEY);
    if (!pointerObj || !("text" in pointerObj)) return null;
    const pointerRaw: unknown = JSON.parse(await pointerObj.text());
    if (!isStrokeCorpusPointer(pointerRaw)) return null;
    const pointer = pointerRaw;

    const manifestObj = await bucket.get(pointer.manifestKey);
    if (!manifestObj || !("text" in manifestObj)) return null;
    const manifestRaw: unknown = JSON.parse(await manifestObj.text());
    if (!isStrokeCorpusManifest(manifestRaw)) return null;
    const manifest = manifestRaw;

    if (manifest.corpusDigest !== pointer.corpusDigest) return null;
    if (manifest.fileCount !== STROKE_CORPUS_EXPECTED_COUNT) return null;
    // manifest.files.length is not re-checked here: isStrokeCorpusManifest
    // (src/utils/stroke-corpus.ts) already enforces fileCount === files.length
    // as part of schema validation above, so a separate files.length check
    // against STROKE_CORPUS_EXPECTED_COUNT can never differ from the
    // fileCount check just above once both have passed — dead code.

    const filesByHex = new Map<string, { sha256: string; bytes: number }>();
    for (const file of manifest.files) {
      const hex = file.path.replace(/^stroke-json\//, "").replace(/\.json$/i, "");
      filesByHex.set(hex, { sha256: file.sha256, bytes: file.bytes });
    }
    if (filesByHex.size !== STROKE_CORPUS_EXPECTED_COUNT) return null;

    return { pointer, manifest, filesByHex };
  } catch {
    return null;
  }
}

function serviceUnavailable(corsHeaders: Record<string, string>): Response {
  return new Response(
    JSON.stringify({ error: "Service Unavailable", message: "筆畫語料尚未就緒或校驗失敗" }),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...corsHeaders,
      },
    },
  );
}

/**
 * 筆順 JSON API — 直接讀取 R2 ASSETS 綁定（atomic corpus model）
 *
 * 路由：GET|HEAD /api/stroke-json/{codepoint}.json
 *
 * 每個請求先解析當前語料指標 `stroke-corpus/current.json`（見
 * src/utils/stroke-corpus.ts、commands/sync-moe-stroke-corpus.mjs 的
 * `promoteCorpusPointer`），再讀取指標指向的 manifest.json，驗證
 * schema／6,063 筆數／pointer↔manifest digest 一致，然後只允許 manifest
 * 白名單內的 codepoint（含 sha256／bytes 校驗中繼資料）通過，最後讀取
 * `stroke-corpora/<digest>/stroke-json/<hex>.json` 版本化物件並串流回應。
 * 指標／manifest 每個 isolate 最多快取 10 分鐘（含 pointer/manifest 缺失或
 * 校驗失敗的 negative 結果），避免每次請求都重複打 R2。
 *
 * 支援：
 * - HEAD（R2 head()，不讀 body）
 * - ETag / If-None-Match 條件式 GET（R2 onlyIf 傳入 request headers）
 * - GET body streaming（R2 ReadableStream 直接接進 Response，不緩衝）
 * - CORS（caller 傳入 corsHeaders，含 ETag 的 Access-Control-Expose-Headers）
 * - Cache-Control（CACHE_CONTROL.stroke）
 *
 * Pointer／manifest／物件缺失或校驗失敗一律回 503 no-store（fail-closed,
 * 絕不回退到扁平 `stroke-json/<hex>.json` key）。無效或不在白名單內的
 * codepoint 有 bounded per-isolate negative memo，停止對同一 miss
 * 重複計費的 R2 讀取（不進 edge cache，只在 isolate 記憶體內）。
 *
 * 無 legacy 公開 URL fallback：staging 讀 preview 桶、production 讀正式桶，
 * 各自環境隔離，不跨環境回退，否則 staging 驗證無意義。
 */
export async function handleStrokeAPI(
  request: Request,
  url: URL,
  env: StrokeEnv,
  corsHeaders: Record<string, string>,
  now: () => number = Date.now,
): Promise<Response> {
  const routePrefix = "/api/stroke-json/";
  // 取出 codepoint 部分，例如 /api/stroke-json/840b.json → 840b.json
  const cp = tryDecodeURIComponent(url.pathname.slice(routePrefix.length)) ?? "";

  // 僅接受單一路徑段，避免多段路徑造成重複請求或錯誤路由
  if (!cp || cp.includes("/") || !/^[0-9a-f]{4,6}\.json$/i.test(cp)) {
    return new Response(
      JSON.stringify({ error: "Bad Request", message: "無效的 codepoint 格式" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders },
      },
    );
  }

  // Normalise to lowercase so allowlist/key lookups stay canonical even if
  // the client requests uppercase hex (regex above is case-insensitive).
  const hex = cp.replace(/\.json$/i, "").toLowerCase();

  try {
    const resolved = await resolveCorpus(env.ASSETS, now);
    if (!resolved) {
      return serviceUnavailable(corsHeaders);
    }

    const negativeKey = hex;
    if (isRememberedNegative(env.ASSETS, negativeKey, now)) {
      return new Response(
        JSON.stringify({ error: "Not Found", message: `找不到筆畫資料：${hex}` }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...corsHeaders,
          },
        },
      );
    }

    const allowlisted = resolved.filesByHex.get(hex);
    if (!allowlisted) {
      // Not in the manifest at all — a legitimate, stable absence. Safe to
      // memo (bounded, isolate-local only — never edge-cached).
      rememberNegative(env.ASSETS, negativeKey, now);
      return new Response(
        JSON.stringify({ error: "Not Found", message: `找不到筆畫資料：${hex}` }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...corsHeaders,
          },
        },
      );
    }

    const versionedKey = strokeCorpusObjectKey(resolved.pointer.corpusDigest, hex);

    // HEAD: metadata only
    if (request.method === "HEAD") {
      const obj = await env.ASSETS.head(versionedKey);
      if (!obj) {
        // Manifest claims this hash/bytes exists but the versioned object
        // itself is missing — a corpus INTEGRITY failure, not a legitimate
        // absence. Fail closed (503) and do NOT memo: memoing would pin a
        // transient upload gap as "not found" for the negative-cache TTL
        // even after an operator repairs the object.
        return serviceUnavailable(corsHeaders);
      }
      const headers = buildStrokeHeaders(obj, corsHeaders);
      return new Response(null, { status: 200, headers });
    }

    // GET: pass request headers so R2 evaluates If-None-Match natively
    const obj = await env.ASSETS.get(versionedKey, { onlyIf: request.headers });

    if (!obj) {
      // Same integrity-failure reasoning as the HEAD branch above.
      return serviceUnavailable(corsHeaders);
    }

    // onlyIf not satisfied → R2 returns R2Object (no body) → 304
    if (!("body" in obj) || obj.body == null) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: obj.httpEtag,
          "Cache-Control": CACHE_CONTROL.stroke,
          "Cache-Tag": "stroke",
          "Access-Control-Expose-Headers": "ETag",
          ...corsHeaders,
        },
      });
    }

    // Full body — stream, never buffer
    const headers = buildStrokeHeaders(obj, corsHeaders);
    return new Response(obj.body, { status: 200, headers });
  } catch (err) {
    console.error("[handleStrokeAPI] R2 讀取失敗:", err);
    return new Response(JSON.stringify({ error: "Internal Error", message: "筆畫資料讀取失敗" }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders },
    });
  }
}

function buildStrokeHeaders(obj: StrokeObjectLike, corsHeaders: Record<string, string>): Headers {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": CACHE_CONTROL.stroke,
    "Cache-Tag": "stroke",
    ETag: obj.httpEtag,
    "Access-Control-Expose-Headers": "ETag",
    ...corsHeaders,
  });
  // Preserve any stored content-type / cache-control from the object, then
  // re-assert our canonical values so missing R2 metadata cannot weaken them.
  obj.writeHttpMetadata(headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", CACHE_CONTROL.stroke);
  headers.set("Cache-Tag", "stroke");
  headers.set("ETag", obj.httpEtag);
  headers.set("Access-Control-Expose-Headers", "ETag");
  for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
  return headers;
}
