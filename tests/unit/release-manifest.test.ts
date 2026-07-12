/// <reference types="node" />
/**
 * Unit tests for release manifest generation (scripts/lib/release-manifest.mjs).
 *
 * Tests are behavior-focused: deterministic digest, sorted entries, release
 * ID format, manifest-excluded-from-digest invariant. File enumeration uses
 * small in-memory fixtures via injectable fs/git adapters.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  buildClientManifest,
  buildReleaseManifest,
  computeClientManifestDigest,
  computeReleaseId,
  deterministicStringify,
} from "../../scripts/lib/release-manifest.mjs";

// ── buildClientManifest ───────────────────────────────────────────────

describe("buildClientManifest", () => {
  it("enumerates files recursively and returns sorted {path, sha256, size} records", () => {
    const files = new Map<string, Buffer>([
      ["index.html", Buffer.from("<html></html>")],
      ["assets/index-AbCdEf12.js", Buffer.from("console.log(1)")],
      ["assets/style-12345678.css", Buffer.from("body{}")],
    ]);
    const fs = makeMemFs(files);
    const manifest = buildClientManifest("dist/client", { fs });

    // Sorted by path
    expect(manifest.map((e) => e.path)).toEqual([
      "assets/index-AbCdEf12.js",
      "assets/style-12345678.css",
      "index.html",
    ]);
    // Each entry has correct shape
    for (const entry of manifest) {
      expect(typeof entry.path).toBe("string");
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof entry.size).toBe("number");
    }
    // sha256 matches content
    expect(manifest[2].sha256).toBe(createHash("sha256").update("<html></html>").digest("hex"));
    expect(manifest[2].size).toBe(13);
  });

  it("hashes raw bytes — non-UTF8 content produces correct hash", () => {
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x42]);
    const fs = makeMemFs(new Map([["bin.dat", binary]]));
    const manifest = buildClientManifest("dist/client", { fs });
    expect(manifest[0].sha256).toBe(createHash("sha256").update(binary).digest("hex"));
    expect(manifest[0].size).toBe(5);
  });

  it("excludes release-manifest.json even if present under input directory", () => {
    const files = new Map<string, Buffer>([
      ["index.html", Buffer.from("x")],
      ["release-manifest.json", Buffer.from('{"id":"fake"}')],
    ]);
    const fs = makeMemFs(files);
    const manifest = buildClientManifest("dist/client", { fs });
    expect(manifest.map((e) => e.path)).toEqual(["index.html"]);
  });

  it("same files in different insertion order → same sorted manifest", () => {
    const filesA = new Map<string, Buffer>([
      ["b.txt", Buffer.from("b")],
      ["a.txt", Buffer.from("a")],
    ]);
    const filesB = new Map<string, Buffer>([
      ["a.txt", Buffer.from("a")],
      ["b.txt", Buffer.from("b")],
    ]);
    const manifestA = buildClientManifest("d", { fs: makeMemFs(filesA) });
    const manifestB = buildClientManifest("d", { fs: makeMemFs(filesB) });
    expect(manifestA).toEqual(manifestB);
  });
});

// ── computeClientManifestDigest ──────────────────────────────────────

describe("computeClientManifestDigest", () => {
  it("produces deterministic 12-hex-char digest of sorted manifest JSON", () => {
    const entries = [
      { path: "z.txt", sha256: "0".repeat(64), size: 1 },
      { path: "a.txt", sha256: "1".repeat(64), size: 2 },
    ];
    const digest = computeClientManifestDigest(entries);
    expect(digest).toMatch(/^[0-9a-f]{12}$/);
  });

  it("sorts entries internally — caller order does not affect digest", () => {
    const a = [
      { path: "b.txt", sha256: "0".repeat(64), size: 1 },
      { path: "a.txt", sha256: "1".repeat(64), size: 2 },
    ];
    const b = [
      { path: "a.txt", sha256: "1".repeat(64), size: 2 },
      { path: "b.txt", sha256: "0".repeat(64), size: 1 },
    ];
    expect(computeClientManifestDigest(a)).toBe(computeClientManifestDigest(b));
  });

  it("canonical JSON keys — key order in objects does not affect digest", () => {
    const a = [{ path: "x", sha256: "f".repeat(64), size: 1 }];
    const b = [{ size: 1, sha256: "f".repeat(64), path: "x" }];
    expect(computeClientManifestDigest(a)).toBe(computeClientManifestDigest(b));
  });

  it("different content → different digest", () => {
    const a = [{ path: "x", sha256: "0".repeat(64), size: 1 }];
    const b = [{ path: "x", sha256: "1".repeat(64), size: 1 }];
    expect(computeClientManifestDigest(a)).not.toBe(computeClientManifestDigest(b));
  });
});

// ── computeReleaseId ──────────────────────────────────────────────────

describe("computeReleaseId", () => {
  it("produces <git-short-sha>-<first12-of-manifest-digest>", () => {
    expect(computeReleaseId("abc1234", "def456789012")).toBe("abc1234-def456789012");
  });

  it("rejects empty git SHA", () => {
    expect(() => computeReleaseId("", "def456789012")).toThrow();
  });

  it("rejects empty digest", () => {
    expect(() => computeReleaseId("abc1234", "")).toThrow();
  });
});

// ── buildReleaseManifest ──────────────────────────────────────────────

describe("buildReleaseManifest", () => {
  it("includes id, gitSha, clientManifestDigest, createdAt, files", () => {
    const files = new Map<string, Buffer>([["index.html", Buffer.from("<html></html>")]]);
    const fs = makeMemFs(files);
    const git = makeFakeGit("abc1234");
    const manifest = buildReleaseManifest("dist/client", { fs, git });

    expect(manifest.id).toMatch(/^abc1234-[0-9a-f]{12}$/);
    expect(manifest.gitSha).toBe("abc1234");
    expect(manifest.clientManifestDigest).toMatch(/^[0-9a-f]{12}$/);
    expect(typeof manifest.createdAt).toBe("string");
    expect(manifest.files.length).toBe(1);
    expect(manifest.files[0].path).toBe("index.html");
  });

  it("release-manifest.json is NOT included in manifest enumeration or digest", () => {
    const files = new Map<string, Buffer>([
      ["index.html", Buffer.from("x")],
      ["release-manifest.json", Buffer.from('{"id":"fake"}')],
    ]);
    const fs = makeMemFs(files);
    const git = makeFakeGit("abc1234");
    const manifest = buildReleaseManifest("dist/client", { fs, git });

    expect(manifest.files.map((f) => f.path)).not.toContain("release-manifest.json");
    // Digest is computed from files WITHOUT release-manifest.json
    const withoutManifest = new Map(files);
    withoutManifest.delete("release-manifest.json");
    const expectedDigest = computeClientManifestDigest(
      buildClientManifest("d", { fs: makeMemFs(withoutManifest) }),
    );
    expect(manifest.clientManifestDigest).toBe(expectedDigest);
  });

  it("createdAt may vary but does NOT influence ID", () => {
    const files = new Map<string, Buffer>([["index.html", Buffer.from("x")]]);

    // Build twice with different createdAt but same content
    const fs1 = makeMemFs(files);
    const git1 = makeFakeGit("abc1234");
    const m1 = buildReleaseManifest("d", { fs: fs1, git: git1 });

    const fs2 = makeMemFs(files);
    const git2 = makeFakeGit("abc1234");
    const m2 = buildReleaseManifest("d", { fs: fs2, git: git2 });

    expect(m1.id).toBe(m2.id);
    // createdAt may differ (timestamps), but id is stable
    expect(m1.clientManifestDigest).toBe(m2.clientManifestDigest);
  });

  it("ID uses validated git short SHA + first 12 of full SHA-256 digest", () => {
    const files = new Map<string, Buffer>([["index.html", Buffer.from("hello")]]);
    const fs = makeMemFs(files);
    const git = makeFakeGit("deadbee");
    const manifest = buildReleaseManifest("d", { fs, git });

    // ID starts with the git short SHA
    expect(manifest.id.startsWith("deadbee-")).toBe(true);
    // The digest portion is exactly 12 hex chars
    const digestPart = manifest.id.slice("deadbee-".length);
    expect(digestPart).toMatch(/^[0-9a-f]{12}$/);
    // The digest is the first 12 chars of the full SHA-256 of deterministic JSON
    const fullHash = createHash("sha256")
      .update(deterministicStringify(manifest.files))
      .digest("hex");
    expect(fullHash.startsWith(digestPart)).toBe(true);
  });
});

// ── deterministicStringify ────────────────────────────────────────────

describe("deterministicStringify", () => {
  it("produces compact JSON with sorted keys", () => {
    expect(deterministicStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts nested object keys", () => {
    expect(deterministicStringify({ outer: { y: 1, x: 2 } })).toBe('{"outer":{"x":2,"y":1}}');
  });

  it("handles arrays preserving order", () => {
    expect(deterministicStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  it("handles primitives", () => {
    expect(deterministicStringify(null)).toBe("null");
    expect(deterministicStringify(42)).toBe("42");
    expect(deterministicStringify("hi")).toBe('"hi"');
    expect(deterministicStringify(true)).toBe("true");
  });
});

// ── Test helpers ─────────────────────────────────────────────────────

interface FsAdapter {
  readFileSync(path: string): Buffer;
  statSync(path: string): { size: number; isDirectory(): boolean };
  readdirSync(
    path: string,
    opts: { withFileTypes: true },
  ): Array<{
    name: string;
    isDirectory(): boolean;
  }>;
}

function makeMemFs(files: Map<string, Buffer>): FsAdapter {
  // Files are stored as relative paths (e.g. "index.html", "assets/x.js").
  // The adapter maps any base dir to the virtual root by tracking the
  // first dir passed to readdirSync, then resolving subsequent paths
  // relative to that base.
  let baseDir = "";

  function toVirtual(p: string): string {
    let normalized = p.replace(/\\/g, "/");
    if (baseDir && normalized.startsWith(baseDir + "/")) {
      normalized = normalized.slice(baseDir.length + 1);
    } else if (baseDir && normalized === baseDir) {
      normalized = "";
    }
    return normalized;
  }

  return {
    readFileSync(p: string): Buffer {
      const key = toVirtual(p);
      const buf = files.get(key);
      if (!buf) throw new Error(`ENOENT: ${p}`);
      return buf;
    },
    statSync(p: string) {
      const key = toVirtual(p);
      if (files.has(key)) {
        return { size: files.get(key)!.length, isDirectory: () => false };
      }
      for (const k of files.keys()) {
        if (k.startsWith(key + "/")) {
          return { size: 0, isDirectory: () => true };
        }
      }
      throw new Error(`ENOENT: ${p}`);
    },
    readdirSync(p: string, _opts) {
      // On first call, record the base directory
      if (!baseDir) {
        baseDir = p.replace(/\\/g, "/");
      }
      const prefix = toVirtual(p);
      const entries: Array<{ name: string; isDirectory(): boolean }> = [];
      const seen = new Set<string>();
      for (const key of files.keys()) {
        const rel =
          prefix === "" ? key : key.startsWith(prefix + "/") ? key.slice(prefix.length + 1) : null;
        if (rel === null) continue;
        const slashIdx = rel.indexOf("/");
        if (slashIdx === -1) {
          if (!seen.has(rel)) {
            seen.add(rel);
            entries.push({ name: rel, isDirectory: () => false });
          }
        } else {
          const dirName = rel.slice(0, slashIdx);
          if (!seen.has(dirName)) {
            seen.add(dirName);
            entries.push({ name: dirName, isDirectory: () => true });
          }
        }
      }
      return entries;
    },
  };
}

function makeFakeGit(shortSha: string) {
  return {
    getGitShortSha: () => shortSha,
    validateGitShortSha: (sha: string) => {
      if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) {
        throw new Error(`Invalid git short SHA: ${sha}`);
      }
    },
  };
}
