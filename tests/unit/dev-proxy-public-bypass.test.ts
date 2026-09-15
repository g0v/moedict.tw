// @vitest-environment node
// (vite.config.ts resolves `projectRoot` from `import.meta.url`, which is not
// a file: URL under the project-wide happy-dom environment.)
/**
 * `servedFromPublicDir` decides whether plain `vp run dev` serves a request
 * locally instead of proxying it to the live Worker (vite.config.ts
 * `workerProxyConfig`). It runs inside Vite's proxy `bypass` hook, so a throw
 * here fails the request rather than the file lookup — every failure mode must
 * answer "not a public file".
 *
 * Guards the review finding on PR #170: a bare `decodeURIComponent` on a
 * request path raises URIError for `/assets/%`, and the repo rule
 * (src/utils/dictionary-route.ts) is that request paths decode only through
 * `tryDecodeURIComponent`.
 */

import { describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { servedFromPublicDir } from "../../vite.config";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("dev proxy public/ bypass", () => {
  it("serves a real file under public/ locally", () => {
    // Committed fixture: public/assets/images/icon.png is why the /assets
    // proxy needs a bypass at all.
    expect(servedFromPublicDir("/assets/images/icon.png")).toBe(true);
    expect(servedFromPublicDir("/assets/images/icon.png?v=1")).toBe(true);
    expect(servedFromPublicDir("/manifest.json")).toBe(true);
  });

  it("proxies anything that is not a file in public/", () => {
    expect(servedFromPublicDir("/assets/styles.css")).toBe(false);
    expect(servedFromPublicDir("/api/%E8%90%8C.json")).toBe(false);
    // A directory is not a file, so it must not shadow the Worker.
    expect(servedFromPublicDir("/assets/images")).toBe(false);
    expect(servedFromPublicDir("/assets/images/")).toBe(false);
    expect(servedFromPublicDir(undefined)).toBe(false);
    expect(servedFromPublicDir("")).toBe(false);
  });

  it("answers false instead of throwing on malformed percent-encoding", () => {
    // Bare decodeURIComponent raises URIError on each of these.
    for (const url of ["/assets/%", "/assets/%zz", "/api/%E0%A4%A", "/%C0%80"]) {
      expect(servedFromPublicDir(url)).toBe(false);
    }
  });

  it("refuses traversal and NUL bytes rather than resolving outside public/", () => {
    // package.json exists at the repo root but is not public/ content.
    expect(servedFromPublicDir("/../package.json")).toBe(false);
    expect(servedFromPublicDir("/assets/../../package.json")).toBe(false);
    expect(servedFromPublicDir("/%2e%2e/package.json")).toBe(false);
    expect(servedFromPublicDir("/assets/icon%00.png")).toBe(false);

    // Encoded separators are decoded only after new URL(), so these cases
    // exercise the explicit pre-normalization traversal guard. Without it,
    // normalize() erases `..` and the encoded-slash requests map to the real
    // public/manifest.json. Encoded backslash covers Windows path semantics.
    expect(servedFromPublicDir("/api/%2e%2e%2fmanifest.json")).toBe(false);
    expect(servedFromPublicDir("/assets/%2e%2e%2fmanifest.json")).toBe(false);
    expect(servedFromPublicDir("/assets/%2e%2e%5cmanifest.json")).toBe(false);
  });

  it("keeps real traversal targets as positive controls", () => {
    // Prove both targets used above exist. package.json checks attempted
    // escape from public/; manifest.json catches traversal that normalizes
    // back onto a real public file and could otherwise trigger the bypass.
    expect(fs.statSync(path.resolve(REPO_ROOT, "package.json")).isFile()).toBe(true);
    expect(fs.statSync(path.resolve(REPO_ROOT, "public", "manifest.json")).isFile()).toBe(true);
    expect(servedFromPublicDir("/package.json")).toBe(false);
  });
});
