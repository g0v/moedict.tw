/**
 * Unit tests for shared R2 key derivation (src/utils/release-keys.ts).
 *
 * These functions are the SINGLE source of truth for R2 key construction,
 * imported by both the Worker (production runtime) and Bun deployment
 * scripts. The publisher↔Worker round-trip equality is the critical
 * invariant: a file published as `assets/index-XYZ.js` (relative path)
 * must be retrievable by a Worker request to `/assets/index-XYZ.js` via
 * the same key derivation logic.
 */

import { describe, expect, it } from "vite-plus/test";
import { immutableKey, isImmutableAsset, releaseKey } from "../../src/utils/release-keys";

// ── releaseKey ─────────────────────────────────────────────────────────

describe("releaseKey", () => {
  it("constructs releases/<tag>/<relative-path>", () => {
    expect(releaseKey("abc123", "index.html")).toBe("releases/abc123/index.html");
    expect(releaseKey("abc123", "assets/index-BU7Lztf4.js")).toBe(
      "releases/abc123/assets/index-BU7Lztf4.js",
    );
  });

  it("normalizes one leading slash on the relative path", () => {
    expect(releaseKey("abc123", "/index.html")).toBe("releases/abc123/index.html");
    expect(releaseKey("abc123", "/assets/index-BU7Lztf4.js")).toBe(
      "releases/abc123/assets/index-BU7Lztf4.js",
    );
  });

  it("rejects empty tag", () => {
    expect(() => releaseKey("", "index.html")).toThrow();
  });

  it("rejects empty relative path", () => {
    expect(() => releaseKey("abc123", "")).toThrow();
  });

  it("rejects path traversal segments", () => {
    expect(() => releaseKey("abc123", "../escape")).toThrow();
    expect(() => releaseKey("abc123", "foo/../../bar")).toThrow();
    expect(() => releaseKey("abc123", "/../escape")).toThrow();
  });

  it("rejects backslash segments", () => {
    expect(() => releaseKey("abc123", "foo\\bar")).toThrow();
  });

  it("rejects encoded path traversal", () => {
    expect(() => releaseKey("abc123", "%2e%2e/escape")).toThrow();
    expect(() => releaseKey("abc123", "%2E%2E/escape")).toThrow();
    expect(() => releaseKey("abc123", "foo/%2e%2e/bar")).toThrow();
  });

  it("rejects empty segments (double slashes)", () => {
    expect(() => releaseKey("abc123", "foo//bar")).toThrow();
    expect(() => releaseKey("abc123", "//foo")).toThrow();
  });
});

// ── Release tag validation ────────────────────────────────────────────

describe("releaseKey — tag safety (one safe segment)", () => {
  it("rejects tag containing a slash", () => {
    expect(() => releaseKey("foo/bar", "index.html")).toThrow();
  });

  it("rejects tag containing a backslash", () => {
    expect(() => releaseKey("foo\\bar", "index.html")).toThrow();
  });

  it("rejects tag that is exactly '..'", () => {
    expect(() => releaseKey("..", "index.html")).toThrow();
  });

  it("rejects tag with dot prefix (e.g. '.hidden')", () => {
    expect(() => releaseKey(".env", "index.html")).toThrow();
  });

  it("rejects percent-encoded traversal in tag", () => {
    expect(() => releaseKey("%2e%2e", "index.html")).toThrow();
    expect(() => releaseKey("%2f", "index.html")).toThrow();
    expect(() => releaseKey("%5c", "index.html")).toThrow();
  });

  it("accepts a normal git-sha + manifest-digest tag", () => {
    expect(() => releaseKey("a1b2c3d-BU7Lztf4abc", "index.html")).not.toThrow();
  });
});

// ── immutableKey ───────────────────────────────────────────────────────

describe("immutableKey", () => {
  it("maps /assets/index-BU7Lztf4.js to immutable/assets/index-BU7Lztf4.js", () => {
    expect(immutableKey("/assets/index-BU7Lztf4.js")).toBe("immutable/assets/index-BU7Lztf4.js");
  });

  it("maps assets/index-BU7Lztf4.js (no leading slash) correctly", () => {
    expect(immutableKey("assets/index-BU7Lztf4.js")).toBe("immutable/assets/index-BU7Lztf4.js");
  });

  it("never produces doubled assets/ prefix", () => {
    expect(immutableKey("/assets/index-BU7Lztf4.js")).not.toContain("assets/assets");
    expect(immutableKey("assets/index-BU7Lztf4.js")).not.toContain("assets/assets");
  });

  it("rejects paths not starting with assets/", () => {
    expect(() => immutableKey("/fonts/foo.woff2")).toThrow();
    expect(() => immutableKey("index.html")).toThrow();
  });

  it("rejects empty path", () => {
    expect(() => immutableKey("")).toThrow();
    expect(() => immutableKey("/")).toThrow();
  });

  it("rejects path traversal", () => {
    expect(() => immutableKey("/assets/../escape")).toThrow();
    expect(() => immutableKey("/assets/%2e%2e/escape")).toThrow();
  });

  it("rejects backslash segments", () => {
    expect(() => immutableKey("/assets/foo\\bar")).toThrow();
  });

  it("rejects empty segments", () => {
    expect(() => immutableKey("/assets//foo")).toThrow();
  });
});

// ── isImmutableAsset ────────────────────────────────────────────────────

describe("isImmutableAsset", () => {
  // Real Vite patterns from dist/client/assets/
  it("returns true for content-hashed index JS", () => {
    expect(isImmutableAsset("assets/index-BU7Lztf4.js")).toBe(true);
    expect(isImmutableAsset("/assets/index-BU7Lztf4.js")).toBe(true);
  });

  it("returns true for content-hashed index CSS", () => {
    expect(isImmutableAsset("assets/index-BKH8HGTI.css")).toBe(true);
  });

  it("returns true for content-hashed worker JS", () => {
    expect(isImmutableAsset("assets/full-text-search.worker-Bo12SZ58.js")).toBe(true);
  });

  it("returns true for nested hashed media", () => {
    expect(isImmutableAsset("assets/images/icon-a1b2c3d4.png")).toBe(true);
    expect(isImmutableAsset("/assets/images/bg-H5k9mN12.webp")).toBe(true);
  });

  // Explicit non-hashed false cases
  it("returns false for non-hashed font under assets/", () => {
    expect(isImmutableAsset("assets/fonts/main.woff2")).toBe(false);
  });

  it("returns false for numeric chunk without hash", () => {
    expect(isImmutableAsset("assets/0.js")).toBe(false);
    expect(isImmutableAsset("assets/123.js")).toBe(false);
  });

  it("returns false for .vite/deps (dependency pre-bundles)", () => {
    expect(isImmutableAsset("assets/.vite/deps/react.js")).toBe(false);
    expect(isImmutableAsset("assets/.vite/deps/react-D8a3fN12.js")).toBe(false);
  });

  it("returns false for traversal attempt under assets/", () => {
    expect(isImmutableAsset("assets/../escape.js")).toBe(false);
  });

  it("returns false for paths not under assets/", () => {
    expect(isImmutableAsset("index.html")).toBe(false);
    expect(isImmutableAsset("fonts/foo.woff2")).toBe(false);
    expect(isImmutableAsset("/fonts/foo.woff2")).toBe(false);
  });

  it("returns false for empty path", () => {
    expect(isImmutableAsset("")).toBe(false);
  });
});

// ── Publisher ↔ Worker round-trip equality ────────────────────────────

describe("publisher ↔ Worker round-trip equality", () => {
  // Representative real Vite patterns from dist/client/** — the publisher
  // enumerates with relative paths (no leading slash); the Worker receives
  // request paths with a leading slash. Both must derive the same R2 key.
  const cases: Array<{ rel: string; immutable: boolean }> = [
    { rel: "assets/index-BU7Lztf4.js", immutable: true },
    { rel: "assets/index-BKH8HGTI.css", immutable: true },
    { rel: "assets/full-text-search.worker-Bo12SZ58.js", immutable: true },
    { rel: "assets/images/icon-a1b2c3d4.png", immutable: true },
    { rel: "assets/fonts/main.woff2", immutable: false },
    { rel: "assets/0.js", immutable: false },
    { rel: "assets/.vite/deps/react.js", immutable: false },
    { rel: "index.html", immutable: false },
    { rel: "favicon.ico", immutable: false },
    { rel: "fonts/revised-dict.woff", immutable: false },
  ];

  for (const { rel, immutable } of cases) {
    it(`releaseKey: publisher "${rel}" ↔ Worker "/${rel}" produce same key`, () => {
      const tag = "abc123def456";
      const publisherKey = releaseKey(tag, rel);
      const workerKey = releaseKey(tag, `/${rel}`);
      expect(publisherKey).toBe(workerKey);
    });

    if (immutable) {
      it(`immutableKey: publisher "${rel}" ↔ Worker "/${rel}" produce same key`, () => {
        const publisherKey = immutableKey(rel);
        const workerKey = immutableKey(`/${rel}`);
        expect(publisherKey).toBe(workerKey);
      });
    }
  }

  it("isImmutableAsset agrees for publisher and Worker path forms", () => {
    for (const { rel, immutable } of cases) {
      expect(isImmutableAsset(rel)).toBe(immutable);
      expect(isImmutableAsset(`/${rel}`)).toBe(immutable);
    }
  });
});
