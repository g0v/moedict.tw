/**
 * Edge-case coverage for `worker/index.ts` `dispatch` — the leftover branches
 * that `worker-dispatch.test.ts` doesn't exercise:
 *
 *   - the trailing `/*.png` → `handleImageGeneration` fallback
 *   - the final null-body 404 return
 *   - the `/assets/*` path when `ASSET_BASE_URL` is undefined (skips proxy,
 *     falls through to the trailing 404)
 *   - the HTML shell branch when `ASSETS.fetch` returns non-OK for `/`
 *   - `handleRadicalLookup`'s 青/靑 variant fallback when neither key seeds
 *   - the HTML-shell metadata-injection dictionary-lookup branch (hits
 *     `parseDictionaryRoute` language prefixes, `stripTags`,
 *     `buildDefinitionDescription`, and the `injectHeadMetadata` dict path)
 *   - `/assets/*` via ASSET_BASE_URL proxy (legacy compatibility) HEAD + GET + invalid method
 *   - the `handleLookupAPI` 200 return branch
 *   - `handleListAPI` delegation via `/api/=category`
 *   - the fixed-star CORS block inside the ASSET_BASE_URL proxy
 *   - HEAD variants of the App-Store-badge image route
 *   - the cfdict.txt 404 (mirrors the xml 404)
 *
 * Reuses the `makeEnv` / `r2Obj` / `makeBucket` stub shapes verbatim from
 * `worker-dispatch.test.ts` — intentionally no new invention so both files
 * share the same contract with `dispatch`. The `@cf-wasm/resvg` dependency
 * is aliased to `tests/helpers/stubs/resvg.ts` by the unit project in `vite.config.ts`,
 * so PNG rendering is deterministic and dependency-free.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Mock } from "vite-plus/test";
import workerDefault, { dispatch } from "../../worker/index";
import * as dictionaryAPI from "../../src/api/handleDictionaryAPI";
import { resvgCalls } from "../helpers/stubs/resvg";

type AnyEnv = Parameters<typeof dispatch>[1];

interface R2Obj {
  body: ReadableStream<Uint8Array>;
  httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  size?: number;
}

function r2Obj(body: string, contentType = "application/octet-stream"): R2Obj {
  return {
    body: new Response(body).body!,
    httpEtag: '"etag-stub"',
    writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", contentType),
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    size: body.length,
  };
}

function makeBucket(
  entries: Record<string, { body: string; contentType?: string }> = {},
): AnyEnv["DICTIONARY"] {
  return {
    async get(key: string) {
      const e = entries[key];
      return e ? r2Obj(e.body, e.contentType) : null;
    },
  } as unknown as AnyEnv["DICTIONARY"];
}

function makeEnv(overrides: Partial<AnyEnv> = {}): AnyEnv {
  return {
    ASSET_BASE_URL: "https://r2-assets.test.local",
    DICTIONARY_BASE_URL: "https://r2-dictionary.test.local",
    DICTIONARY: makeBucket(),
    ASSETS: makeBucket(),
    FONTS: makeBucket(),
    ...overrides,
  } as AnyEnv;
}

function req(pathname: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${pathname}`, init);
}

// happy-dom strips Origin from Request constructors but preserves it when set
// via `headers.set(...)` post-construction. Used for exercising the Origin-
// mirroring branch in the ASSET_BASE_URL proxy.
function reqWithOrigin(pathname: string, origin: string, init: RequestInit = {}): Request {
  const r = new Request(`http://localhost${pathname}`, init);
  r.headers.set("Origin", origin);
  return r;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
beforeEach(() => {
  vi.restoreAllMocks();
  resvgCalls.length = 0;
});

// A minimal shell template with every meta tag the worker's
// `injectHeadMetadata` regex-rewrites, so we can verify the dictionary-
// lookup branch produced a rich description.
const SHELL_HTML = `<!doctype html><html><head>
  <title>loading</title>
  <meta name="description" content="old" />
  <meta property="og:title" content="old" />
  <meta property="og:description" content="old" />
  <meta property="og:url" content="old" />
  <meta property="og:image" content="old" />
  <meta property="og:image:type" content="old" />
  <meta property="og:image:width" content="old" />
  <meta property="og:image:height" content="old" />
  <meta name="twitter:title" content="old" />
  <meta name="twitter:description" content="old" />
  <meta name="twitter:image" content="old" />
  <meta name="twitter:site" content="old" />
  <meta name="twitter:creator" content="old" />
</head><body></body></html>`;

// 萌 → charCode 0x840C → 33804 % 1024 = 12 → pack path pack/12.txt
// (bucketPath template is `p${lang}ck/${bucket}.txt` → "pack" for lang=a).
// Dictionary stores `escape('萌')` = '%u840C' as the bucket key. Shared by
// the metadata-injection, /embed, and /api/oembed dispatch test blocks.
const DICT_ENTRY_FOR_MENG = {
  "%u840C": {
    heteronyms: [
      {
        definitions: [{ def: "植物發芽的樣子。" }, { def: "比喻事物的初始狀態" }],
      },
    ],
  },
};

function shellFetcher(): { fetch: Mock } {
  return {
    fetch: vi.fn(
      async () => new Response(SHELL_HTML, { headers: { "Content-Type": "text/html" } }),
    ),
  };
}

describe("dispatch — *.png image generation fallback", () => {
  it("returns an image/png response when a .png path has no matching asset", async () => {
    // Seed FONTS with the test-character glyph (U+840C = 萌) so
    // `checkFontAvailability` returns true and `generateTextSVGWithR2Fonts`
    // finds a path element. The resvg stub (tests/helpers/stubs/resvg.ts)
    // produces a fixed PNG byte sequence.
    const pathSvg = '<svg><path d="M0 0 L10 10"/></svg>';
    const env = makeEnv({
      FONTS: makeBucket({
        "TW-Kai/U+840C.svg": { body: pathSvg, contentType: "image/svg+xml" },
      }),
    });
    const res = await dispatch(req("/%E8%90%8C.png"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // The resvg stub emits the PNG magic [137,80,78,71]; assert the first
    // byte to prove the body came from the rendering pipeline.
    expect(bytes[0]).toBe(137);
  });

  it("still generates a PNG when ASSETS (R2 bucket) is undefined (getAssetsBucket null-candidate branch)", async () => {
    const pathSvg = '<svg><path d="M0 0 L10 10"/></svg>';
    const env = makeEnv({
      ASSETS: undefined,
      FONTS: makeBucket({
        "TW-Kai/U+840C.svg": { body: pathSvg, contentType: "image/svg+xml" },
      }),
    });
    const res = await dispatch(req("/%E8%90%8C.png"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("still generates a PNG when ASSETS.get is not a function (getAssetsBucket malformed-candidate branch)", async () => {
    const pathSvg = '<svg><path d="M0 0 L10 10"/></svg>';
    const env = makeEnv({
      // Present but shaped wrong: has a `get` key, but it's not callable —
      // exercises the `typeof candidate.get !== "function"` guard distinct
      // from the `!candidate` guard covered above.
      ASSETS: { get: "not-a-function" } as unknown as AnyEnv["ASSETS"],
      FONTS: makeBucket({
        "TW-Kai/U+840C.svg": { body: pathSvg, contentType: "image/svg+xml" },
      }),
    });
    const res = await dispatch(req("/%E8%90%8C.png"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("still takes the .png branch when the ASSETS fetcher 404s on the path", async () => {
    // Confirms the `(!staticResponse || staticResponse.status === 404)`
    // disjunction covers the 404 arm.
    const fetcher = { fetch: vi.fn(async () => new Response("", { status: 404 })) };
    const env = makeEnv({
      SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"],
      FONTS: makeBucket({
        "TW-Kai/U+840C.svg": { body: '<svg><path d="M0 0"/></svg>' }, // checkFontAvailability probe
        "TW-Kai/U+0066.svg": { body: '<svg><path d="M0 0"/></svg>' }, // f
        "TW-Kai/U+006F.svg": { body: '<svg><path d="M0 0"/></svg>' }, // o
      }),
    });
    // /foo.png bypasses the ASSET_BASE_URL proxy (proxy checks /assets/*)
    // and the fetcher's 404 is enough to unlock handleImageGeneration.
    const res = await dispatch(req("/foo.png"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });
});

describe("dispatch — *.png fallback font wiring (Tauhu Oo via ASSETS)", () => {
  // 𣁳仔 — 𣁳 (U+23073) has no precomputed glyph SVG in R2 for any font (confirmed
  // against the live moedict-fonts bucket), so it always takes the <text> fallback
  // path and needs the bundled Tauhu Oo font loaded from ASSETS to render correctly.
  const pngPath = `/${encodeURIComponent("'𣁳仔")}.png`;

  it("loads Tauhu Oo from ASSETS and wires it into resvg as fontBuffers when a glyph is missing from FONTS", async () => {
    const env = makeEnv({
      FONTS: makeBucket({
        "TW-Kai/U+840C.svg": { body: '<svg><path d="M0 0 L1 1"/></svg>' }, // checkFontAvailability probe
        "TW-Kai/U+4ED4.svg": { body: '<svg><path d="M0 0 L1 1"/></svg>' }, // 仔 only; 𣁳 absent
      }),
      ASSETS: makeBucket({
        "fonts/TauhuOo2005-Regular.otf": { body: "fake-otf-bytes" },
        "fonts/TW-Kai-shard-4.ttf": { body: "fake-shard-bytes" },
      }),
    });

    const res = await dispatch(req(pngPath), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");

    const call = resvgCalls.at(-1);
    const options = call?.options as { font?: { fontBuffers?: Uint8Array[] } } | undefined;
    expect(options?.font?.fontBuffers).toHaveLength(2);
    expect(new TextDecoder().decode(options!.font!.fontBuffers![0])).toBe("fake-otf-bytes");
    expect(new TextDecoder().decode(options!.font!.fontBuffers![1])).toBe("fake-shard-bytes");
  });
  it("returns 503 no-store (never a year-long cacheable broken render) when the fallback font is unavailable", async () => {
    const env = makeEnv({
      FONTS: makeBucket({
        "TW-Kai/U+840C.svg": { body: '<svg><path d="M0 0 L1 1"/></svg>' }, // checkFontAvailability probe
        "TW-Kai/U+4ED4.svg": { body: '<svg><path d="M0 0 L1 1"/></svg>' },
      }),
      ASSETS: makeBucket(), // no fonts/TauhuOo2005-Regular.otf entry seeded
    });

    const res = await dispatch(req(pngPath), env);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("never fetches the fallback font when every character already resolves via R2", async () => {
    const assetsGet = vi.fn(async () => null);
    const env = makeEnv({
      FONTS: makeBucket({
        "TW-Kai/U+840C.svg": { body: '<svg><path d="M0 0 L1 1"/></svg>' },
      }),
      ASSETS: { get: assetsGet } as unknown as AnyEnv["ASSETS"],
    });

    const res = await dispatch(req("/%E8%90%8C.png"), env); // 萌, fully covered by FONTS
    expect(res.status).toBe(200);
    expect(assetsGet).not.toHaveBeenCalled();
  });
});

describe("dispatch — *.png romanize=1 caption font wiring (Fira Sans OT via ASSETS, RESCOPE #169)", () => {
  const meng = {
    "%u840C": { h: [{ b: "ㄇㄥˊ", p: "méng", d: [{ f: "草木初生的芽。" }] }] },
  };

  it("loads Fira Sans OT from ASSETS and wires it into resvg as fontBuffers when romanize=1&lang=a resolves a reading", async () => {
    const env = makeEnv({
      FONTS: makeBucket({
        "TW-Kai/U+840C.svg": { body: '<svg><path d="M0 0 L1 1"/></svg>' },
      }),
      DICTIONARY: makeBucket({
        "pack/12.txt": { body: JSON.stringify(meng) },
      }),
      ASSETS: makeBucket({
        "fonts/FiraSansOT-Regular.otf": { body: "fake-fira-bytes" },
      }),
    });

    const res = await dispatch(req("/%E8%90%8C.png?romanize=1&lang=a"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");

    const call = resvgCalls.at(-1);
    const options = call?.options as { font?: { fontBuffers?: Uint8Array[] } } | undefined;
    expect(options?.font?.fontBuffers).toHaveLength(1);
    expect(new TextDecoder().decode(options!.font!.fontBuffers![0])).toBe("fake-fira-bytes");
  });

  it("merges the Tauhu Oo fallback buffer and the Fira Sans OT caption buffer into the same fontBuffers array without overwriting either", async () => {
    // 'ㄋ*𣁳仔 reuses the missing-glyph fixture (𣁳 has no FONTS entry, forcing
    // the Tauhu Oo <text> fallback) while ALSO requesting romanize=1&lang=t so
    // fetchWholeWordRomanization resolves a non-empty reading and the caption
    // path also needs Fira Sans OT — both font buffers must be present.
    const pngPath = `/${encodeURIComponent("'𣁳仔")}.png?romanize=1&lang=t`;
    const env = makeEnv({
      FONTS: makeBucket({
        "TW-Kai/U+840C.svg": { body: '<svg><path d="M0 0 L1 1"/></svg>' }, // checkFontAvailability probe
        "TW-Kai/U+4ED4.svg": { body: '<svg><path d="M0 0 L1 1"/></svg>' }, // 仔 only; 𣁳 absent
      }),
      DICTIONARY: makeBucket({
        "ptck/115.txt": {
          body: JSON.stringify({ "%uD84C%uDC73%u4ED4": { h: [{ T: "tsi̍h-á" }] } }),
        },
      }),
      ASSETS: makeBucket({
        "fonts/TauhuOo2005-Regular.otf": { body: "fake-otf-bytes" },
        "fonts/FiraSansOT-Regular.otf": { body: "fake-fira-bytes" },
      }),
    });

    const res = await dispatch(req(pngPath), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");

    const call = resvgCalls.at(-1);
    const options = call?.options as { font?: { fontBuffers?: Uint8Array[] } } | undefined;
    const decoded = (options?.font?.fontBuffers ?? []).map((buf) => new TextDecoder().decode(buf));
    expect(decoded).toEqual(["fake-otf-bytes", "fake-fira-bytes"]);
  });

  it("returns 503 no-store (never a year-long cacheable broken caption) when the Fira Sans OT font is unavailable", async () => {
    const env = makeEnv({
      FONTS: makeBucket({
        "TW-Kai/U+840C.svg": { body: '<svg><path d="M0 0 L1 1"/></svg>' },
      }),
      DICTIONARY: makeBucket({
        "pack/12.txt": { body: JSON.stringify(meng) },
      }),
      ASSETS: makeBucket(), // no fonts/FiraSansOT-Regular.otf entry seeded
    });

    const res = await dispatch(req("/%E8%90%8C.png?romanize=1&lang=a"), env);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("never fetches the caption font when romanize=1 is present but lang is invalid (fail-open, glyph-only)", async () => {
    const assetsGet = vi.fn(async () => null);
    const env = makeEnv({
      FONTS: makeBucket({
        "TW-Kai/U+840C.svg": { body: '<svg><path d="M0 0 L1 1"/></svg>' },
      }),
      DICTIONARY: makeBucket({
        "pack/12.txt": { body: JSON.stringify(meng) },
      }),
      ASSETS: { get: assetsGet } as unknown as AnyEnv["ASSETS"],
    });

    const res = await dispatch(req("/%E8%90%8C.png?romanize=1&lang=xx"), env);
    expect(res.status).toBe(200);
    expect(assetsGet).not.toHaveBeenCalled();
  });
});

describe("dispatch — final null-body 404", () => {
  it("returns 404 with empty body and no Content-Type for an unmatched non-asset, non-png path", async () => {
    // /random/thing.bin: not /api, not /assets, not .png, not HTML-shell-
    // eligible (the .bin extension disqualifies shouldRenderHtmlShell).
    // serveAssetWithFallback returns null (non-hashed, no tag), no
    // ASSET_BASE_URL proxy for .bin, and dispatch falls to the trailing 404.
    const res = await dispatch(req("/random/thing.bin"), makeEnv());
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    // `new Response(null, { status: 404 })` sets no Content-Type; happy-dom
    // doesn't synthesize one either.
    expect(res.headers.get("content-type")).toBeNull();
    // A future broken deploy's error must not be edge-cacheable and
    // outlive the fix — see g0v/moedict.tw#131's outage postmortem.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("dispatch — /assets/* when ASSET_BASE_URL is undefined", () => {
  it("skips the ASSET_BASE_URL proxy branch and returns 404", async () => {
    // With ASSET_BASE_URL cleared, the `if (env.ASSET_BASE_URL && ...)`
    // guard is false. serveAssetWithFallback returns null (SITE_ASSETS
    // returns 404, no tag, non-hashed path), the proxy branch is skipped,
    // and control flows to the trailing `return new Response(null, { status: 404 })`.
    const fetcher = { fetch: vi.fn(async () => new Response("", { status: 404 })) };
    const env = makeEnv({
      ASSET_BASE_URL: undefined,
      SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"],
    });
    const res = await dispatch(req("/assets/foo.woff2"), env);
    expect(res.status).toBe(404);
  });
});

describe("dispatch — HTML shell fetch returns non-OK", () => {
  it("returns 503 recovery when the shell fetch 500s (no release tag)", async () => {
    // With the zero-downtime fallback, a SITE_ASSETS 500 no longer
    // falls through to passThroughAssets. Instead, renderHtmlShellWithFallback
    // tries SITE_ASSETS (500), finds no release tag (CF_VERSION_METADATA
    // absent), skips R2, and returns a self-contained 503 recovery page.
    const fetcher = {
      fetch: vi.fn(async () => new Response("upstream error", { status: 500 })),
    };
    const env = makeEnv({ SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"] });
    const res = await dispatch(req("/about"), env);
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Moedict-Shell-Source")).toBe("recovery");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("5");
    // Body is the recovery HTML, NOT the upstream error.
    const body = await res.text();
    expect(body).toContain("萌典");
    expect(body).not.toBe("upstream error");
  });

  it("returns 503 recovery when the shell fetch 404s (no release tag)", async () => {
    // Same as above but with 404 — the 503 recovery is the ONLY
    // both-stores-fail outcome for HTML routes.
    const fetcher = {
      fetch: vi.fn(async () => new Response("missing", { status: 404 })),
    };
    const env = makeEnv({ SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"] });
    // "/" is a non-entry (default) route — it reaches renderHtmlShellWithFallback
    // untouched and surfaces the recovery shell when SITE_ASSETS fails.
    // (Entry-shaped word paths now hard-404 on a definitive dictionary miss,
    // so they no longer exercise the recovery branch.)
    const res = await dispatch(req("/"), env);
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Moedict-Shell-Source")).toBe("recovery");
  });
});

describe("dispatch — radical 青/靑 variant fallback with neither seeded", () => {
  it('returns 404 with error:"Not Found" for /@青.json when NEITHER 青 nor 靑 exists', async () => {
    // /@青.json doesn't match parseSubRoute (no lang prefix in URL); it
    // flows through handleDictionaryAPI → handleRadicalLookup, which does:
    //   a/@青.json → null → fallback a/@靑.json → null → 404.
    const env = makeEnv({ DICTIONARY: makeBucket() });
    const res = await dispatch(req("/@%E9%9D%92.json"), env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Not Found");
  });

  it('returns 404 with error:"Not Found" for /@靑.json when NEITHER 靑 nor 青 exists', async () => {
    const env = makeEnv({ DICTIONARY: makeBucket() });
    const res = await dispatch(req("/@%E9%9D%91.json"), env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Not Found");
  });

  it("returns 404 for /a/@青.json (sub-route variant) with neither seeded", async () => {
    // Parallel branch inside handleLanguageSubRoute — identical fallback
    // logic; tested alongside so both call sites' NEITHER arms are exercised.
    const env = makeEnv({ DICTIONARY: makeBucket() });
    const res = await dispatch(req("/a/@%E9%9D%92.json"), env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Not Found");
  });

  it("returns 404 for /a/@靑.json (sub-route variant) with neither seeded", async () => {
    const env = makeEnv({ DICTIONARY: makeBucket() });
    const res = await dispatch(req("/a/@%E9%9D%91.json"), env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Not Found");
  });
});

describe("dispatch — HTML shell metadata injection with dictionary lookup", () => {
  // When the SPA shell is served for a path that parseDictionaryRoute can
  // resolve, dispatch calls lookupDictionaryEntry and builds a rich
  // description from heteronym definitions. This exercises stripTags,
  // buildDefinitionDescription, and the dictionary-lookup arm of
  // injectHeadMetadata that bare /about never reaches. DICT_ENTRY_FOR_MENG
  // and shellFetcher are module-scoped above (reused by the /embed and
  // /api/oembed dispatch test blocks further down).

  it("injects heteronym definitions into the og:description for /萌 (lang=a, line 48)", async () => {
    const fetcher = shellFetcher();
    const env = makeEnv({
      SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"],
      DICTIONARY: makeBucket({
        "pack/12.txt": { body: JSON.stringify(DICT_ENTRY_FOR_MENG) },
      }),
    });
    const res = await dispatch(req("/%E8%90%8C"), env);
    expect(res.status).toBe(200);
    const body = await res.text();
    // The rich description replaces the placeholder "old" content. It's
    // built from the definitions via buildDefinitionDescription.
    expect(body).toMatch(/name="description" content="[^"]*植物發芽/);
    expect(body).toMatch(/property="og:description" content="[^"]*植物發芽/);
  });

  // R4: with an empty DICTIONARY the probe finds no headword, so these bare
  // entry-shaped paths now return 404 — but the shell render (and its
  // injectHeadMetadata prefix-parsing branch) still ran first, and the shell
  // BODY is preserved under the corrected status.
  it("lang=t prefix `/'食` renders the shell, then 404s on the dictionary miss", async () => {
    const fetcher = shellFetcher();
    const env = makeEnv({ SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"] });
    const res = await dispatch(req("/%27%E9%A3%9F"), env);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<html");
  });

  it("lang=h prefix `/:字` renders the shell, then 404s on the dictionary miss", async () => {
    const fetcher = shellFetcher();
    const env = makeEnv({ SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"] });
    const res = await dispatch(req("/%3A%E5%AD%97"), env);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("<html");
  });

  it("lang=c prefix `/~萌` renders the shell, then 404s on the dictionary miss", async () => {
    const fetcher = shellFetcher();
    const env = makeEnv({ SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"] });
    const res = await dispatch(req("/~%E8%90%8C"), env);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("<html");
  });

  it("returns null from parseDictionaryRoute for `/=成語` (line 42 — starts with =)", async () => {
    const fetcher = shellFetcher();
    const env = makeEnv({ SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"] });
    const res = await dispatch(req("/=%E6%88%90%E8%AA%9E"), env);
    // Shell still renders — injectHeadMetadata runs but skips the dict
    // lookup because parseDictionaryRoute returns null.
    expect(res.status).toBe(200);
  });

  it("returns null from parseDictionaryRoute for `/~@部首` (line 41 — starts with ~@)", async () => {
    const fetcher = shellFetcher();
    const env = makeEnv({ SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"] });
    const res = await dispatch(req("/~@%E9%83%A8"), env);
    expect(res.status).toBe(200);
  });

  it("returns null from parseDictionaryRoute for `/'=*星` (line 43)", async () => {
    const fetcher = shellFetcher();
    const env = makeEnv({ SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"] });
    const res = await dispatch(req("/'=*%E6%98%9F"), env);
    expect(res.status).toBe(200);
  });

  it("returns null from parseDictionaryRoute for `/'=星` (line 44 — no *)", async () => {
    const fetcher = shellFetcher();
    const env = makeEnv({ SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"] });
    const res = await dispatch(req("/'=%E6%98%9F"), env);
    expect(res.status).toBe(200);
  });

  it("skips description injection when the dict entry has no definitions (buildDefinitionDescription returns null)", async () => {
    // Empty heteronyms → buildDefinitionDescription returns null → head
    // description stays at the default from resolveHeadByPath.
    const fetcher = shellFetcher();
    const env = makeEnv({
      SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"],
      DICTIONARY: makeBucket({
        "pack/12.txt": { body: JSON.stringify({ "%u840C": { heteronyms: [] } }) },
      }),
    });
    const res = await dispatch(req("/%E8%90%8C"), env);
    expect(res.status).toBe(200);
    // Rich description absent, but shell still renders.
    const body = await res.text();
    expect(body).not.toContain("植物發芽");
  });
});

describe("dispatch — GET /embed/<word> (oEmbed iframe target)", () => {
  it("renders the entry card for /embed/萌", async () => {
    const env = makeEnv({
      DICTIONARY: makeBucket({
        "pack/12.txt": { body: JSON.stringify(DICT_ENTRY_FOR_MENG) },
      }),
    });
    const res = await dispatch(req("/embed/%E8%90%8C"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("<h1>萌</h1>");
    expect(body).toContain("植物發芽的樣子。");
  });

  it("404s for /embed/<unknown word>", async () => {
    const env = makeEnv({ DICTIONARY: makeBucket() });
    const res = await dispatch(req("/embed/%E8%90%8C"), env);
    expect(res.status).toBe(404);
  });

  it("never falls through to the SPA shell for /embed paths", async () => {
    // Regression guard: /embed must be intercepted before
    // shouldRenderHtmlShell, or it would serve the full app shell instead
    // of the lightweight card.
    const fetcher = shellFetcher();
    const env = makeEnv({
      SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"],
      DICTIONARY: makeBucket({ "pack/12.txt": { body: JSON.stringify(DICT_ENTRY_FOR_MENG) } }),
    });
    await dispatch(req("/embed/%E8%90%8C"), env);
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });
});

describe("dispatch — GET /api/oembed (tokenless oEmbed API)", () => {
  it("returns a rich oEmbed payload for a known entry", async () => {
    const env = makeEnv({
      DICTIONARY: makeBucket({
        "pack/12.txt": { body: JSON.stringify(DICT_ENTRY_FOR_MENG) },
      }),
    });
    const res = await dispatch(
      req(`/api/oembed?url=${encodeURIComponent("https://www.moedict.tw/萌")}`),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: string; html: string };
    expect(body.type).toBe("rich");
    expect(body.html).toContain("/embed/%E8%90%8C");
  });

  it("400s when url is missing", async () => {
    const env = makeEnv({ DICTIONARY: makeBucket() });
    const res = await dispatch(req("/api/oembed"), env);
    expect(res.status).toBe(400);
  });
});

describe("dispatch — oEmbed discovery <link> in the HTML shell", () => {
  it('adds a discovery <link rel="alternate" type="application/json+oembed"> for a dictionary entry route', async () => {
    const fetcher = shellFetcher();
    const env = makeEnv({ SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"] });
    const res = await dispatch(req("/%E8%90%8C"), env);
    const body = await res.text();
    expect(body).toContain('rel="alternate" type="application/json+oembed"');
    expect(body).toContain("/api/oembed?url=");
  });

  it("omits the discovery <link> for non-entry routes like /about", async () => {
    const fetcher = shellFetcher();
    const env = makeEnv({ SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"] });
    const res = await dispatch(req("/about"), env);
    const body = await res.text();
    expect(body).not.toContain("application/json+oembed");
  });
});

describe("dispatch — /assets/* via ASSET_BASE_URL proxy (legacy compatibility)", () => {
  it("serves an /assets/* GET via the ASSET_BASE_URL proxy when R2 fallback misses", async () => {
    // serveAssetWithFallback tries SITE_ASSETS (absent), R2 current release
    // (no tag → skip), R2 global immutable (non-hashed path → skip), returns
    // null. The ASSET_BASE_URL proxy then serves the asset from the legacy
    // upstream.
    globalThis.fetch = vi.fn(
      async () =>
        new Response("woff bytes", { status: 200, headers: { "Content-Type": "font/woff2" } }),
    ) as typeof fetch;
    const env = makeEnv({
      ASSETS: makeBucket({ "font.woff2": { body: "woff bytes", contentType: "font/woff2" } }),
    });
    const res = await dispatch(req("/assets/font.woff2"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("woff bytes");
  });

  it("serves an /assets/* HEAD via the ASSET_BASE_URL proxy", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("woff bytes", { status: 200, headers: { "Content-Type": "font/woff2" } }),
    ) as typeof fetch;
    const env = makeEnv({
      ASSETS: makeBucket({ "font.woff2": { body: "woff bytes", contentType: "font/woff2" } }),
    });
    const res = await dispatch(req("/assets/font.woff2", { method: "HEAD" }), env);
    expect(res.status).toBe(200);
  });

  it("returns 404 from the proxy when the /assets/* key is missing upstream", async () => {
    // serveAssetWithFallback returns null (no tag, non-hashed), proxy
    // engages and gets 404 from the upstream.
    globalThis.fetch = vi.fn(async () => new Response("", { status: 404 })) as typeof fetch;
    const env = makeEnv({ ASSETS: makeBucket() });
    const res = await dispatch(req("/assets/missing.woff2"), env);
    expect(res.status).toBe(404);
  });

  it("PUT on /assets/* with no ASSET_BASE_URL falls to 404", async () => {
    // serveAssetWithFallback returns null, proxy is skipped (no
    // ASSET_BASE_URL), .png branch skips, lands on the final 404.
    const env = makeEnv({
      ASSET_BASE_URL: undefined,
      ASSETS: makeBucket({ "foo.bin": { body: "bytes" } }),
    });
    const res = await dispatch(req("/assets/foo.bin", { method: "PUT" }), env);
    expect(res.status).toBe(404);
  });

  it("returns null when pathname is empty after stripping /assets/", async () => {
    // A bare /assets/ request: serveAssetWithFallback returns null, proxy
    // engages because pathname starts with /assets/.
    globalThis.fetch = vi.fn(
      async () => new Response("empty-key upstream", { status: 200 }),
    ) as typeof fetch;
    const env = makeEnv({ ASSETS: makeBucket() });
    const res = await dispatch(req("/assets/"), env);
    expect(res.status).toBe(200);
  });
});

describe("dispatch — ASSET_BASE_URL proxy fixed-star CORS", () => {
  it("uses fixed-star CORS without credentials even when Origin is present", async () => {
    // happy-dom strips Origin from Request constructors; set post-construction.
    globalThis.fetch = vi.fn(
      async () =>
        new Response("proxied ok", { status: 200, headers: { "Content-Type": "text/plain" } }),
    ) as typeof fetch;
    const env = makeEnv({ ASSETS: makeBucket() });
    const r = reqWithOrigin("/assets/x.js", "https://origin.test");
    const res = await dispatch(r, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });
});

describe("dispatch — /images/Download_on_the_App_Store_Badge HEAD branch", () => {
  it("HEAD on the App-Store badge returns 200 with empty body (line 251)", async () => {
    const env = makeEnv({
      ASSETS: makeBucket({
        "Download_on_the_App_Store_Badge_HK_TW_135x40.png": {
          body: "PNG",
          contentType: "image/png",
        },
      }),
    });
    const res = await dispatch(
      req("/images/Download_on_the_App_Store_Badge_HK_TW_135x40.png", { method: "HEAD" }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("");
  });
});

describe("dispatch — cfdict.txt 404 branch", () => {
  it("404s cfdict.txt when absent, with CORS + text/plain headers", async () => {
    const res = await dispatch(req("/translation-data/cfdict.txt"), makeEnv());
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("dispatch — ASSETS helper guard branches", () => {
  it("returns 503 recovery for an HTML-shell route when SITE_ASSETS has no fetcher", async () => {
    // Without SITE_ASSETS, renderHtmlShellWithFallback skips the fast path,
    // finds no release tag (CF_VERSION_METADATA absent), skips R2, and
    // returns the self-contained 503 recovery page.
    const env = makeEnv({
      SITE_ASSETS: undefined,
    });
    const res = await dispatch(req("/about"), env);
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Moedict-Shell-Source")).toBe("recovery");
  });

  it("treats SITE_ASSETS.fetch as absent when it is not callable", async () => {
    const env = makeEnv({ SITE_ASSETS: { fetch: true } as unknown as AnyEnv["SITE_ASSETS"] });
    const res = await dispatch(req("/plain.txt"), env);
    expect(res.status).toBe(404);
  });

  it("treats ASSETS.get as absent when it is not callable", async () => {
    const env = makeEnv({
      ASSETS: { get: true } as unknown as AnyEnv["ASSETS"],
    });
    const res = await dispatch(req("/plain.txt"), env);
    expect(res.status).toBe(404);
  });

  it("returns the static response directly when serveAssetWithFallback finds a non-404 fetcher response", async () => {
    const env = makeEnv({
      SITE_ASSETS: {
        fetch: vi.fn(
          async () =>
            new Response("static-ok", { status: 200, headers: { "Content-Type": "text/plain" } }),
        ),
      } as unknown as AnyEnv["SITE_ASSETS"],
    });
    const res = await dispatch(req("/plain.txt"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("static-ok");
  });
});

describe("dispatch — /api/lookup/pinyin/* (lookupResponse return, line 232)", () => {
  it("delegates to handleLookupAPI and returns its response verbatim", async () => {
    // Empty DICTIONARY means lookupResponse returns []; still non-null,
    // which satisfies the `if (lookupResponse)` guard and causes dispatch
    // to short-circuit at line 232 before the rest of the router runs.
    const res = await dispatch(req("/api/lookup/pinyin/a/TL/abc.json"), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("dispatch — /api/=category (handleListAPI delegation, lines 459-460)", () => {
  it("delegates to handleListAPI and returns 404 when the list file is absent", async () => {
    // `listSegment.startsWith('=')` matches and we call handleListAPI; the
    // missing a/=成語.json yields a 404 Not Found.
    const res = await dispatch(req("/api/=%E6%88%90%E8%AA%9E"), makeEnv());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Not Found");
  });

  it("also handles the lang-prefixed form /api/'=諺語", async () => {
    // Covers the `listSegment.startsWith("'=")` arm; another missing file
    // so we know we entered handleListAPI (not the generic fallback).
    const res = await dispatch(req("/api/'=%E8%AB%BA%E8%AA%9E"), makeEnv());
    expect(res.status).toBe(404);
  });
});

describe("dispatch — dictionary API null fallback (lines 473-474)", () => {
  it("returns a trailing 404 when handleDictionaryAPI yields no response", async () => {
    const spy = vi.spyOn(dictionaryAPI, "handleDictionaryAPI").mockResolvedValueOnce(null as never);
    const res = await dispatch(req("/api/%E8%90%8C.json"), makeEnv());
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("dispatch — default export fetch wrapper (line 544)", () => {
  it("delegates to dispatch via the default export", async () => {
    // The default export at the bottom of worker/index.ts is a one-line
    // wrapper: `fetch: (request, env) => dispatch(request, env)`. It isn't
    // exercised by direct-call tests that import `dispatch`, so cover it
    // explicitly to keep the line from hanging uncovered forever.
    const res = await workerDefault.fetch(req("/api/config"), makeEnv(), {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as Parameters<typeof workerDefault.fetch>[2]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assetBaseUrl: string };
    expect(body.assetBaseUrl).toBe("https://r2-assets.test.local");
  });
});

describe("dispatch — bare-URL legacy sub-routes (/a /t /h /c /raw /uni /pua, no .json)", () => {
  // 萌 → charCode 0x840C → 33804 % 1024 (lang a) or % 128 (t/h/c) → bucket 12
  // either way (33804 % 128 = 12 too) → p{a,t,h,c}ck/12.txt, key escape('萌') = '%u840C'.
  const packEntry = {
    "%u840C": { t: "萌", c: 12, r: "艸", h: [{ b: "ㄇㄥˊ", d: [{ f: "草木初生的芽。" }] }] },
  };
  const dictionaryWithAllLangBuckets = makeBucket({
    "pack/12.txt": { body: JSON.stringify(packEntry) },
    "ptck/12.txt": { body: JSON.stringify(packEntry) },
    "phck/12.txt": { body: JSON.stringify(packEntry) },
    "pcck/12.txt": { body: JSON.stringify(packEntry) },
  });

  it("routes /a/<word> (no .json) to handleDictionaryAPI's compact pack format, matching README.md's documented example", async () => {
    const env = makeEnv({ DICTIONARY: dictionaryWithAllLangBuckets });
    const res = await dispatch(req("/a/%E8%90%8C"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    // /a /t /h /c serve the compact packed shape (short keys, t not title) —
    // NOT the same as /raw /uni /pua, which decode to long keys.
    const body = (await res.json()) as { t?: unknown };
    expect(body.t).toBe("萌");
  });

  it.each(["t", "h", "c"])(
    "routes /%s/<word> (no .json) to the compact pack format too",
    async (prefix) => {
      const env = makeEnv({ DICTIONARY: dictionaryWithAllLangBuckets });
      const res = await dispatch(req(`/${prefix}/%E8%90%8C`), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { t?: unknown };
      expect(body.t).toBe("萌");
    },
  );

  it.each(["raw", "uni", "pua"])(
    "routes /%s/<word> (no .json) to the decoded format",
    async (prefix) => {
      const env = makeEnv({ DICTIONARY: dictionaryWithAllLangBuckets });
      const res = await dispatch(req(`/${prefix}/%E8%90%8C`), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { title?: unknown };
      expect(body.title).toBe("萌");
    },
  );

  it('does not intercept a bare single-segment lookup of the literal word "a" — falls through to the normal SPA shell', async () => {
    // /a alone (one segment) must stay on the normal /:text dictionary/SPA
    // route, not be swallowed by the two-segment /a/<word> sub-route check.
    const fetcher = shellFetcher();
    const env = makeEnv({ SITE_ASSETS: fetcher as unknown as AnyEnv["SITE_ASSETS"] });
    const res = await dispatch(req("/a"), env);
    expect(fetcher.fetch).toHaveBeenCalled();
    expect(res.headers.get("content-type")).not.toContain("application/json");
  });

  it("still requires .json for the top-level /:text.json route (unaffected by the bare-URL addition)", async () => {
    const env = makeEnv({ DICTIONARY: dictionaryWithAllLangBuckets });
    const res = await dispatch(req("/%E8%90%8C.json"), env);
    expect(res.status).toBe(200);
  });
});
