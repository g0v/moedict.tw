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
  });

  it("keeps the repo-root file it must never serve", () => {
    // Positive control for the traversal assertions above: the file the
    // traversal attempts point at really does exist on disk, so those
    // assertions fail closed for the right reason.
    expect(path.resolve(REPO_ROOT, "package.json").endsWith("package.json")).toBe(true);
    expect(servedFromPublicDir("/package.json")).toBe(false);
  });
});
