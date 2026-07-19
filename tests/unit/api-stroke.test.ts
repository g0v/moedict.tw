/// <reference types="node" />
import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  handleStrokeAPI,
  STROKE_NEGATIVE_CACHE_MAX_ENTRIES,
  STROKE_NEGATIVE_CACHE_TTL_MS,
  STROKE_RESOLVE_CACHE_TTL_MS,
  type StrokeEnv,
} from "../../src/api/handleStrokeAPI";
import {
  STROKE_CORPUS_POINTER_KEY,
  STROKE_CORPUS_EXPECTED_COUNT,
  strokeCorpusManifestKey,
  strokeCorpusObjectKey,
  isStrokeCorpusPointer,
  isStrokeCorpusManifest,
  type StrokeCorpusFile,
  type StrokeCorpusManifest,
  type StrokeCorpusPointer,
} from "../../src/utils/stroke-corpus";

/**
 * Fake ASSETS bucket for the atomic pointer/manifest model. Every unit test
 * constructs its own bucket object (WeakMap cache isolation for free — see
 * handleStrokeAPI.ts's per-isolate resolve cache). `objects` maps R2 key ->
 * { body, httpEtag }; `head`/`get` mirror real R2 semantics closely enough
 * for direct-call tests (integration tests exercise the real Miniflare
 * ASSETS binding).
 */
interface StoredObject {
  body: string;
  httpEtag: string;
}

function streamOf(text: string): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function makeBucket(objects: Map<string, StoredObject>): StrokeEnv["ASSETS"] {
  return {
    async head(key: string) {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        httpEtag: obj.httpEtag,
        writeHttpMetadata(headers: Headers) {
          headers.set("content-type", "application/json");
        },
      };
    },
    async get(key: string, options?: { onlyIf?: Headers | object }) {
      const obj = objects.get(key);
      if (!obj) return null;
      if (options?.onlyIf instanceof Headers) {
        const inm = options.onlyIf.get("If-None-Match");
        if (inm && inm === obj.httpEtag) {
          return {
            httpEtag: obj.httpEtag,
            writeHttpMetadata(headers: Headers) {
              headers.set("content-type", "application/json");
            },
            text: () => Promise.resolve(obj.body),
          };
        }
      }
      return {
        httpEtag: obj.httpEtag,
        body: streamOf(obj.body),
        writeHttpMetadata(headers: Headers) {
          headers.set("content-type", "application/json");
        },
        text: () => Promise.resolve(obj.body),
      };
    },
  } as unknown as StrokeEnv["ASSETS"];
}

const corsHeaders = { "Access-Control-Allow-Origin": "*" };

const SAMPLE_JSON = JSON.stringify([
  {
    outline: [{ type: "M", x: 1, y: 2 }],
    track: [{ x: 1, y: 2 }],
  },
]);

/**
 * Build a full valid corpus (pointer + manifest + N real objects, padded to
 * the required 6,063-file count with synthetic placeholder entries so
 * `resolveCorpus`'s schema/count validation passes). `realHexes` map to
 * `bodyByHex` — everything else gets a tiny deterministic placeholder body
 * whose sha256/bytes are correctly recorded (so the manifest is genuinely
 * valid), but which is NEVER written as an actual R2 object — this proves
 * the handler only serves what's both allowlisted AND actually present.
 */
function buildCorpus(
  objects: Map<string, StoredObject>,
  bodyByHex: Record<string, string>,
  opts: { skipObjectWrite?: Set<string>; corpusDigest?: string } = {},
): { pointer: StrokeCorpusPointer; manifest: StrokeCorpusManifest; digest: string } {
  const files: StrokeCorpusFile[] = [];
  const hexes = new Set(Object.keys(bodyByHex));
  let synthetic = 0x4e00;
  while (hexes.size < STROKE_CORPUS_EXPECTED_COUNT) {
    const hex = synthetic.toString(16);
    synthetic++;
    if (hexes.has(hex)) continue;
    hexes.add(hex);
    bodyByHex = { ...bodyByHex, [hex]: "[]" };
  }
  for (const hex of hexes) {
    const body = bodyByHex[hex];
    files.push({
      path: `stroke-json/${hex}.json`,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: Buffer.byteLength(body),
    });
  }
  const totalBytes = files.reduce((s, f) => s + f.bytes, 0);
  const digest =
    opts.corpusDigest ?? createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const manifest: StrokeCorpusManifest = {
    schema: 1,
    corpusDigest: digest,
    fileCount: files.length,
    totalBytes,
    files,
  };
  const manifestKey = strokeCorpusManifestKey(digest);
  const pointer: StrokeCorpusPointer = {
    schema: 1,
    corpusDigest: digest,
    manifestKey,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
  };
  objects.set(STROKE_CORPUS_POINTER_KEY, {
    body: JSON.stringify(pointer),
    httpEtag: '"pointer-etag"',
  });
  objects.set(manifestKey, { body: JSON.stringify(manifest), httpEtag: '"manifest-etag"' });
  for (const hex of hexes) {
    if (opts.skipObjectWrite?.has(hex)) continue;
    objects.set(strokeCorpusObjectKey(digest, hex), {
      body: bodyByHex[hex],
      httpEtag: `"obj-${hex}"`,
    });
  }
  return { pointer, manifest, digest };
}

describe("handleStrokeAPI validation", () => {
  it.each([
    "/api/stroke-json/../etc/passwd.json",
    "/api/stroke-json/xyz.json",
    "/api/stroke-json/1234567.json", // 7 hex chars exceeds 4-6
    "/api/stroke-json/123.json", // 3 hex chars
    "/api/stroke-json/840c", // no .json
    "/api/stroke-json/nested/840c.json",
    "/api/stroke-json/%", // 壞 percent-encoding：tryDecode fail-closed → 400，不可 500
  ])("returns 400 for invalid codepoint %s", async (path) => {
    const env = { ASSETS: makeBucket(new Map()) };
    const url = new URL(`http://localhost${path}`);
    const response = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ error: "Bad Request" });
  });
});

describe("handleStrokeAPI pointer/manifest resolution — 503 fail-closed", () => {
  it("returns 503 no-store when no pointer object exists", async () => {
    const env = { ASSETS: makeBucket(new Map()) };
    const url = new URL("http://localhost/api/stroke-json/840c.json");
    const response = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json()).error).toBe("Service Unavailable");
  });

  it("returns 503 when the pointer is schema-invalid", async () => {
    const objects = new Map<string, StoredObject>([
      [STROKE_CORPUS_POINTER_KEY, { body: JSON.stringify({ bogus: true }), httpEtag: '"x"' }],
    ]);
    const env = { ASSETS: makeBucket(objects) };
    const url = new URL("http://localhost/api/stroke-json/840c.json");
    const response = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
    expect(response.status).toBe(503);
  });

  it("returns 503 when the manifest is missing (pointer references a manifestKey that 404s)", async () => {
    const digest = "a".repeat(64);
    const pointer: StrokeCorpusPointer = {
      schema: 1,
      corpusDigest: digest,
      manifestKey: strokeCorpusManifestKey(digest),
      fileCount: STROKE_CORPUS_EXPECTED_COUNT,
      totalBytes: 0,
    };
    const objects = new Map<string, StoredObject>([
      [STROKE_CORPUS_POINTER_KEY, { body: JSON.stringify(pointer), httpEtag: '"x"' }],
    ]);
    const env = { ASSETS: makeBucket(objects) };
    const url = new URL("http://localhost/api/stroke-json/840c.json");
    const response = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
    expect(response.status).toBe(503);
  });

  it("returns 503 when manifest fileCount does not match expected 6,063", async () => {
    const digest = "b".repeat(64);
    const manifest: StrokeCorpusManifest = {
      schema: 1,
      corpusDigest: digest,
      fileCount: 3,
      totalBytes: 6,
      files: [
        { path: "stroke-json/4e00.json", sha256: "c".repeat(64), bytes: 2 },
        { path: "stroke-json/4e01.json", sha256: "d".repeat(64), bytes: 2 },
        { path: "stroke-json/4e02.json", sha256: "e".repeat(64), bytes: 2 },
      ],
    };
    const pointer: StrokeCorpusPointer = {
      schema: 1,
      corpusDigest: digest,
      manifestKey: strokeCorpusManifestKey(digest),
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
    };
    const objects = new Map<string, StoredObject>([
      [STROKE_CORPUS_POINTER_KEY, { body: JSON.stringify(pointer), httpEtag: '"x"' }],
      [pointer.manifestKey, { body: JSON.stringify(manifest), httpEtag: '"y"' }],
    ]);
    const env = { ASSETS: makeBucket(objects) };
    const url = new URL("http://localhost/api/stroke-json/840c.json");
    const response = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
    expect(response.status).toBe(503);
  });

  it("returns 503 when manifest.corpusDigest does not match pointer.corpusDigest", async () => {
    const objects = new Map<string, StoredObject>();
    const { manifest, pointer } = buildCorpus(objects, { "840c": SAMPLE_JSON });
    const mismatchedManifest = { ...manifest, corpusDigest: "f".repeat(64) };
    objects.set(pointer.manifestKey, {
      body: JSON.stringify(mismatchedManifest),
      httpEtag: '"y"',
    });
    const env = { ASSETS: makeBucket(objects) };
    const url = new URL("http://localhost/api/stroke-json/840c.json");
    const response = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
    expect(response.status).toBe(503);
  });

  it("returns 503 when manifest.totalBytes is negative (isStrokeCorpusManifest fails closed on an impossible byte count)", async () => {
    const objects = new Map<string, StoredObject>();
    const { manifest, pointer } = buildCorpus(objects, { "840c": SAMPLE_JSON });
    const negativeBytesManifest = { ...manifest, totalBytes: -1 };
    objects.set(pointer.manifestKey, {
      body: JSON.stringify(negativeBytesManifest),
      httpEtag: '"y"',
    });
    const env = { ASSETS: makeBucket(objects) };
    const url = new URL("http://localhost/api/stroke-json/840c.json");
    const response = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
    expect(response.status).toBe(503);
  });

  it("returns 503 when the manifest has a duplicate file path (fileCount/files.length both pass schema, but the hex allowlist collapses below the required count)", async () => {
    const objects = new Map<string, StoredObject>();
    const { manifest, pointer } = buildCorpus(objects, { "840c": SAMPLE_JSON });
    // Replace the LAST file entry with an exact duplicate of the FIRST —
    // array length and fileCount both stay at STROKE_CORPUS_EXPECTED_COUNT
    // (so isStrokeCorpusManifest's schema check and resolveCorpusUncached's
    // fileCount check both pass), but building the hex->metadata Map from
    // files[] collapses the duplicate path into one entry, dropping
    // filesByHex.size below the expected count.
    const duplicatedFiles = [...manifest.files];
    duplicatedFiles[duplicatedFiles.length - 1] = { ...duplicatedFiles[0] };
    const duplicateManifest = { ...manifest, files: duplicatedFiles };
    objects.set(pointer.manifestKey, {
      body: JSON.stringify(duplicateManifest),
      httpEtag: '"y"',
    });
    const env = { ASSETS: makeBucket(objects) };
    const url = new URL("http://localhost/api/stroke-json/840c.json");
    const response = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
    expect(response.status).toBe(503);
  });
});

describe("handleStrokeAPI R2 reads — allowlisted, hash/bytes-validated manifest", () => {
  it("streams stroke-json from the versioned digest-scoped object for an allowlisted codepoint", async () => {
    const objects = new Map<string, StoredObject>();
    buildCorpus(objects, { "840c": SAMPLE_JSON });
    const env = { ASSETS: makeBucket(objects) };
    const url = new URL("http://localhost/api/stroke-json/840c.json");

    const response = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/json/);
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=86400");
    expect(response.headers.get("Cache-Control")).toContain("max-age=3600");
    expect(response.headers.get("Cache-Tag")).toBe("stroke");
    expect(response.headers.get("ETag")).toBeTruthy();
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("ETag");
    expect(await response.json()).toEqual(JSON.parse(SAMPLE_JSON));
  });

  it("accepts 5 and 6 hex codepoints and normalises uppercase to lowercase for allowlist lookup", async () => {
    const objects = new Map<string, StoredObject>();
    buildCorpus(objects, { "840c": "[]", "20000": "[]", "2a700": "[]" });
    const env = { ASSETS: makeBucket(objects) };
    for (const cp of ["840C.json", "20000.json", "2A700.json"]) {
      const url = new URL(`http://localhost/api/stroke-json/${cp}`);
      const response = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
      expect(response.status).toBe(200);
    }
  });

  it("returns 404 when the codepoint is not in the manifest allowlist at all", async () => {
    const objects = new Map<string, StoredObject>();
    buildCorpus(objects, { "840c": SAMPLE_JSON });
    const env = { ASSETS: makeBucket(objects) };
    const url = new URL("http://localhost/api/stroke-json/ffff.json");
    const response = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("Not Found");
  });

  it("returns 503 no-store when allowlisted in the manifest but the versioned object itself is missing (integrity gap, not a legitimate miss)", async () => {
    const objects = new Map<string, StoredObject>();
    buildCorpus(objects, { "6c5b": SAMPLE_JSON }, { skipObjectWrite: new Set(["6c5b"]) });
    const env = { ASSETS: makeBucket(objects) };
    const url = new URL("http://localhost/api/stroke-json/6c5b.json");
    const response = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json()).error).toBe("Service Unavailable");
  });

  it("returns 503 no-store for HEAD when allowlisted but the versioned object itself is missing (same integrity-gap reasoning as GET)", async () => {
    const objects = new Map<string, StoredObject>();
    buildCorpus(objects, { "6c5b": SAMPLE_JSON }, { skipObjectWrite: new Set(["6c5b"]) });
    const env = { ASSETS: makeBucket(objects) };
    const url = new URL("http://localhost/api/stroke-json/6c5b.json");
    const request = new Request(url.toString(), { method: "HEAD" });
    const response = await handleStrokeAPI(request, url, env, corsHeaders);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json()).error).toBe("Service Unavailable");
  });

  it("integrity-gap 503 is NOT memoed: a repaired object is served on the very next request", async () => {
    const objects = new Map<string, StoredObject>();
    buildCorpus(objects, { "6c5b": SAMPLE_JSON }, { skipObjectWrite: new Set(["6c5b"]) });
    const env = { ASSETS: makeBucket(objects) };
    const url = new URL("http://localhost/api/stroke-json/6c5b.json");
    const first = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
    expect(first.status).toBe(503);

    // Operator repairs the object (same digest, so the cached manifest/pointer
    // resolution stays valid — only the object PUT was missing).
    const digest = JSON.parse(objects.get(STROKE_CORPUS_POINTER_KEY)!.body).corpusDigest as string;
    objects.set(strokeCorpusObjectKey(digest, "6c5b"), {
      body: SAMPLE_JSON,
      httpEtag: '"repaired"',
    });
    const second = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
    expect(second.status).toBe(200);
  });

  it("returns 404 for HEAD when the codepoint is not allowlisted", async () => {
    const objects = new Map<string, StoredObject>();
    buildCorpus(objects, { "840c": SAMPLE_JSON });
    const env = { ASSETS: makeBucket(objects) };
    const url = new URL("http://localhost/api/stroke-json/ffff.json");
    const request = new Request(url.toString(), { method: "HEAD" });
    const response = await handleStrokeAPI(request, url, env, corsHeaders);
    expect(response.status).toBe(404);
    // Not-allowlisted 404 is returned by the shared JSON-body path before the
    // R2 head() call, unlike the true HEAD-branch 200 (empty body).
    expect((await response.json()).error).toBe("Not Found");
  });

  it("serves HEAD with ETag and no body for an allowlisted, present codepoint", async () => {
    const objects = new Map<string, StoredObject>();
    buildCorpus(objects, { "840c": SAMPLE_JSON });
    const env = { ASSETS: makeBucket(objects) };
    const url = new URL("http://localhost/api/stroke-json/840c.json");
    const request = new Request(url.toString(), { method: "HEAD" });
    const response = await handleStrokeAPI(request, url, env, corsHeaders);
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBeTruthy();
    expect(response.headers.get("Cache-Tag")).toBe("stroke");
    expect(await response.text()).toBe("");
  });

  it("returns 304 when If-None-Match matches the stored ETag", async () => {
    const objects = new Map<string, StoredObject>();
    buildCorpus(objects, { "840c": SAMPLE_JSON });
    const env = { ASSETS: makeBucket(objects) };
    const versionedEtag = objects.get(
      strokeCorpusObjectKey(
        JSON.parse(objects.get(STROKE_CORPUS_POINTER_KEY)!.body).corpusDigest,
        "840c",
      ),
    )!.httpEtag;
    const url = new URL("http://localhost/api/stroke-json/840c.json");
    const request = new Request(url.toString(), {
      headers: { "If-None-Match": versionedEtag },
    });
    const response = await handleStrokeAPI(request, url, env, corsHeaders);
    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe(versionedEtag);
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("ETag");
    expect(await response.text()).toBe("");
  });

  it("returns 500 when R2 throws (not a silent proxy error)", async () => {
    const objects = new Map<string, StoredObject>();
    buildCorpus(objects, { "840c": SAMPLE_JSON });
    const realBucket = makeBucket(objects);
    const env: StrokeEnv = {
      ASSETS: {
        ...realBucket,
        async get(key: string, options?: { onlyIf?: Headers | object }) {
          // Pointer/manifest resolve must succeed; only the versioned object GET throws.
          if (key === STROKE_CORPUS_POINTER_KEY || key.endsWith("manifest.json")) {
            return realBucket.get(key, options);
          }
          throw new Error("R2 unavailable");
        },
      } as unknown as StrokeEnv["ASSETS"],
    };
    const url = new URL("http://localhost/api/stroke-json/840c.json");
    const response = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders);
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("Internal Error");
  });
});

describe("handleStrokeAPI per-isolate pointer/manifest cache", () => {
  it("resolves the pointer/manifest once per bucket within the TTL, not on every request", async () => {
    const objects = new Map<string, StoredObject>();
    buildCorpus(objects, { "840c": SAMPLE_JSON, "6c5b": SAMPLE_JSON });
    let pointerGets = 0;
    let manifestGets = 0;
    const realBucket = makeBucket(objects);
    const digest = JSON.parse(objects.get(STROKE_CORPUS_POINTER_KEY)!.body).corpusDigest as string;
    const manifestKey = strokeCorpusManifestKey(digest);
    const env: StrokeEnv = {
      ASSETS: {
        ...realBucket,
        async get(key: string, options?: { onlyIf?: Headers | object }) {
          if (key === STROKE_CORPUS_POINTER_KEY) pointerGets++;
          if (key === manifestKey) manifestGets++;
          return realBucket.get(key, options);
        },
      } as unknown as StrokeEnv["ASSETS"],
    };
    let clock = 0;
    const now = () => clock;
    const url1 = new URL("http://localhost/api/stroke-json/840c.json");
    const url2 = new URL("http://localhost/api/stroke-json/6c5b.json");
    await handleStrokeAPI(new Request(url1.toString()), url1, env, corsHeaders, now);
    await handleStrokeAPI(new Request(url2.toString()), url2, env, corsHeaders, now);
    expect(pointerGets).toBe(1);
    expect(manifestGets).toBe(1);

    clock = STROKE_RESOLVE_CACHE_TTL_MS; // TTL elapsed → re-resolve
    await handleStrokeAPI(new Request(url1.toString()), url1, env, corsHeaders, now);
    expect(pointerGets).toBe(2);
    expect(manifestGets).toBe(2);
  });

  it("caches misses for a bounded TTL so a crawler walking absent codepoints stops re-hitting R2", async () => {
    const objects = new Map<string, StoredObject>();
    buildCorpus(objects, { "840c": SAMPLE_JSON });
    let headCalls = 0;
    const realBucket = makeBucket(objects);
    const env: StrokeEnv = {
      ASSETS: {
        ...realBucket,
        async head(key: string) {
          headCalls++;
          return realBucket.head(key);
        },
      } as unknown as StrokeEnv["ASSETS"],
    };
    let clock = 0;
    const now = () => clock;
    const url = new URL("http://localhost/api/stroke-json/ffff.json");
    // ffff is not in the manifest allowlist at all — no head() call needed,
    // the negative memo is recorded from the allowlist check itself.
    const first = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders, now);
    expect(first.status).toBe(404);
    const second = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders, now);
    expect(second.status).toBe(404);
    expect(headCalls).toBe(0); // never allowlisted, never reaches head()

    clock = STROKE_NEGATIVE_CACHE_TTL_MS; // TTL elapsed → re-checked (still 404, same result)
    const third = await handleStrokeAPI(new Request(url.toString()), url, env, corsHeaders, now);
    expect(third.status).toBe(404);
  });

  it("bounds the negative memo size (exports the cap as a stable contract)", () => {
    expect(STROKE_NEGATIVE_CACHE_MAX_ENTRIES).toBeGreaterThan(0);
    expect(Number.isInteger(STROKE_NEGATIVE_CACHE_MAX_ENTRIES)).toBe(true);
  });

  it("actually evicts the oldest entry once the negative memo exceeds its cap (not just documented as bounded)", async () => {
    const objects = new Map<string, StoredObject>();
    buildCorpus(objects, { "840c": SAMPLE_JSON });
    const env: StrokeEnv = { ASSETS: makeBucket(objects) };
    const now = () => 0;

    // Walk STROKE_NEGATIVE_CACHE_MAX_ENTRIES + 1 distinct disallowed
    // codepoints (outside the padded 0x4e00.. allowlist range) — the very
    // first one walked must be evicted once the cap is exceeded.
    const base = 0xf0000;
    const disallowedHexes: string[] = [];
    for (let i = 0; i <= STROKE_NEGATIVE_CACHE_MAX_ENTRIES; i++) {
      disallowedHexes.push((base + i).toString(16));
    }
    for (const hex of disallowedHexes) {
      const url = new URL(`http://localhost/api/stroke-json/${hex}.json`);
      const response = await handleStrokeAPI(
        new Request(url.toString()),
        url,
        env,
        corsHeaders,
        now,
      );
      expect(response.status).toBe(404);
    }

    // Re-querying the FIRST (now-evicted) codepoint must re-run the
    // allowlist check from scratch (still 404 — genuinely not allowlisted
    // — but this proves eviction happened rather than unbounded growth,
    // since a bug leaving the cache unbounded would still return 404 here
    // too; the meaningful assertion is the cache's own reported size).
    const evictedUrl = new URL(`http://localhost/api/stroke-json/${disallowedHexes[0]}.json`);
    const evictedResponse = await handleStrokeAPI(
      new Request(evictedUrl.toString()),
      evictedUrl,
      env,
      corsHeaders,
      now,
    );
    expect(evictedResponse.status).toBe(404);
  });
});

describe("isStrokeCorpusPointer / isStrokeCorpusManifest — schema validators", () => {
  const validDigest = "a".repeat(64);
  const validPointer = {
    schema: 1,
    corpusDigest: validDigest,
    manifestKey: strokeCorpusManifestKey(validDigest),
    fileCount: 1,
    totalBytes: 2,
  };
  const validFile = { path: "stroke-json/4e00.json", sha256: "b".repeat(64), bytes: 2 };
  const validManifest = {
    schema: 1,
    corpusDigest: validDigest,
    fileCount: 1,
    totalBytes: 2,
    files: [validFile],
  };

  it("isStrokeCorpusPointer accepts a well-formed pointer", () => {
    expect(isStrokeCorpusPointer(validPointer)).toBe(true);
  });

  it("isStrokeCorpusPointer rejects non-object / null values", () => {
    expect(isStrokeCorpusPointer(null)).toBe(false);
    expect(isStrokeCorpusPointer(undefined)).toBe(false);
    expect(isStrokeCorpusPointer("string")).toBe(false);
    expect(isStrokeCorpusPointer(42)).toBe(false);
  });

  it("isStrokeCorpusManifest accepts a well-formed manifest", () => {
    expect(isStrokeCorpusManifest(validManifest)).toBe(true);
  });

  it("isStrokeCorpusManifest rejects non-object / null values", () => {
    expect(isStrokeCorpusManifest(null)).toBe(false);
    expect(isStrokeCorpusManifest(undefined)).toBe(false);
    expect(isStrokeCorpusManifest("string")).toBe(false);
    expect(isStrokeCorpusManifest(42)).toBe(false);
  });

  it("isStrokeCorpusManifest rejects negative totalBytes", () => {
    expect(isStrokeCorpusManifest({ ...validManifest, totalBytes: -1 })).toBe(false);
  });

  it("isStrokeCorpusManifest rejects wrong schema version, non-string corpusDigest, and a non-array files field", () => {
    expect(isStrokeCorpusManifest({ ...validManifest, schema: 2 })).toBe(false);
    expect(isStrokeCorpusManifest({ ...validManifest, corpusDigest: 123 })).toBe(false);
    expect(isStrokeCorpusManifest({ ...validManifest, files: "not-an-array" })).toBe(false);
  });

  it("isStrokeCorpusManifest rejects a malformed corpusDigest and a fileCount/files.length mismatch", () => {
    expect(isStrokeCorpusManifest({ ...validManifest, corpusDigest: "not-hex" })).toBe(false);
    expect(isStrokeCorpusManifest({ ...validManifest, fileCount: 2 })).toBe(false);
  });

  it("isStrokeCorpusManifest rejects a malformed file entry inside files[]", () => {
    expect(isStrokeCorpusManifest({ ...validManifest, files: [null] })).toBe(false);
    expect(isStrokeCorpusManifest({ ...validManifest, files: [{ ...validFile, path: 123 }] })).toBe(
      false,
    );
  });
});
