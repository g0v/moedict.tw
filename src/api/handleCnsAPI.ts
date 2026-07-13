/**
 * Worker handler for GET/HEAD /api/cns/{char}.json
 *
 * Reads per-character CNS11643 attribute JSON from DICTIONARY R2 under
 * the key cns/by-codepoint/{shard}/{HEX}.json, where:
 *   hex   = codepoint.toString(16).toUpperCase()
 *   shard = hex.length <= 4 ? hex.slice(0,2) : hex.slice(0,3)
 *
 * Route MUST be inserted BEFORE the generic .json catch-all in worker/index.ts.
 * Cache-Tag: cns,cns-record — never routes through resolveDictCacheTags to
 * avoid polluting dict-a purge scope (see neuralese touchpoint.resolveDictCacheTags).
 *
 * Source data: CNS11643 OGDL-1.0
 * Attribution: 數位發展部，CNS11643中文標準交換碼全字庫網站，https://www.cns11643.gov.tw
 */

import { CACHE_CONTROL } from "./cache";
import { tryDecodeURIComponent } from "../utils/dictionary-route";

interface CnsDictionaryObjectLike {
  text(): Promise<string>;
  httpEtag?: string;
}

interface CnsDictionaryBucketLike {
  get(key: string): Promise<CnsDictionaryObjectLike | null>;
}

export interface CnsEnv {
  DICTIONARY: CnsDictionaryBucketLike;
}

/** CORS headers identical to the rest of the public API. */
const CNS_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * Shard formula: hex = cp.toString(16).toUpperCase()
 * shard = hex.length <= 4 ? hex.slice(0,2) : hex.slice(0,3)
 * R2 key: cns/by-codepoint/${shard}/${hex}.json
 */
function cnsR2Key(cp: number): string {
  const hex = cp.toString(16).toUpperCase();
  const shard = hex.length <= 4 ? hex.slice(0, 2) : hex.slice(0, 3);
  return `cns/by-codepoint/${shard}/${hex}.json`;
}

/**
 * Returns true when the Unicode scalar is a PUA character (phase 1 exclusion).
 * Classification is by numeric range only (never by filename or position).
 */
function isPUA(cp: number): boolean {
  return (
    (cp >= 0xe000 && cp <= 0xf8ff) || // BMP PUA
    (cp >= 0xf0000 && cp <= 0xfffff) || // PUA-A
    (cp >= 0x100000 && cp <= 0x10ffff) // PUA-B
  );
}

/**
 * Returns true when the codepoint is a valid Unicode scalar value (not a
 * lone surrogate, not a control character in the C0/C1 range that would
 * never appear in a normal dictionary path).
 *
 * Rejects: surrogates (U+D800–U+DFFF), out-of-range, empty.
 */
function isAcceptableScalar(cp: number): boolean {
  return (
    Number.isInteger(cp) &&
    cp > 0x1f && // reject control chars including NUL
    cp !== 0x7f && // DEL
    !(cp >= 0xd800 && cp <= 0xdfff) && // surrogates
    cp <= 0x10ffff
  );
}

function jsonErr(
  status: number,
  error: string,
  message: string,
  corsHeaders: Record<string, string>,
): Response {
  const body = JSON.stringify({ error, message, terms: [] });
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders,
    },
  });
}

/**
 * Handle GET/HEAD /api/cns/{encodedChar}.json
 *
 * State machine:
 *   VALIDATE_METHOD → DECODE_CHAR → VALIDATE_SCALAR → LOAD_CNS_OBJECT → RESPOND
 */
export async function handleCnsAPI(request: Request, url: URL, env: CnsEnv): Promise<Response> {
  const corsHeaders = CNS_CORS_HEADERS;

  // ── VALIDATE_METHOD ─────────────────────────────────────────────────────
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Allow: "GET, HEAD",
        ...corsHeaders,
      },
    });
  }

  // ── DECODE_CHAR ─────────────────────────────────────────────────────────
  // Path: /api/cns/{encodedChar}.json
  const rawSegment = url.pathname.slice("/api/cns/".length).replace(/\.json$/, "");
  if (!rawSegment) {
    return jsonErr(400, "Bad Request", "invalid CNS character", corsHeaders);
  }
  const decoded = tryDecodeURIComponent(rawSegment);
  if (decoded === null) {
    return jsonErr(400, "Bad Request", "invalid CNS character", corsHeaders);
  }

  // ── VALIDATE_SCALAR ─────────────────────────────────────────────────────
  // Accept exactly one Unicode scalar value; reject multi-scalar, slashes, dots
  if (decoded.includes("/") || decoded.includes("\\") || decoded.includes(".")) {
    return jsonErr(400, "Bad Request", "invalid CNS character", corsHeaders);
  }
  // Count Unicode scalars using spread (correct for astral codepoints)
  const scalars = Array.from(decoded);
  if (scalars.length !== 1) {
    return jsonErr(400, "Bad Request", "invalid CNS character", corsHeaders);
  }
  const cp = decoded.codePointAt(0);
  if (cp === undefined || !isAcceptableScalar(cp)) {
    return jsonErr(400, "Bad Request", "invalid CNS character", corsHeaders);
  }
  // Phase 1: PUA characters return 404 (not in dataset)
  if (isPUA(cp)) {
    return jsonErr(404, "Not Found", `找不到全字庫屬性: ${decoded}`, corsHeaders);
  }

  // ── LOAD_CNS_OBJECT ──────────────────────────────────────────────────────
  // Construct R2 key only from computed hex, never from raw path segment
  const r2Key = cnsR2Key(cp);

  let obj: CnsDictionaryObjectLike | null;
  try {
    obj = await env.DICTIONARY.get(r2Key);
  } catch (err) {
    console.error("[handleCnsAPI] R2 error:", err);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...corsHeaders,
      },
    });
  }

  if (!obj) {
    return jsonErr(404, "Not Found", `找不到全字庫屬性: ${decoded}`, corsHeaders);
  }

  // ── RESPOND_200 ──────────────────────────────────────────────────────────
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": CACHE_CONTROL.dict,
    "Cache-Tag": "cns,cns-record",
    ...corsHeaders,
  });
  if (obj.httpEtag) {
    headers.set("ETag", obj.httpEtag);
  }

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  let content: string;
  try {
    content = await obj.text();
  } catch (err) {
    console.error("[handleCnsAPI] R2 parse error:", err);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...corsHeaders,
      },
    });
  }

  return new Response(content, { status: 200, headers });
}
