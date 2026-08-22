import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin, type ProxyOptions, lazyPlugins } from "vite-plus";
import react from "@vitejs/plugin-react";

import { cloudflare } from "@cloudflare/vite-plugin";
import { tryDecodeURIComponent } from "./src/utils/dictionary-route";
import { STROKE_JSON_BASE_URL } from "./src/utils/media-cdn";
import { handleDictionaryAPI } from "./src/api/handleDictionaryAPI";
import { handleListAPI, isListPath } from "./src/api/handleListAPI";

interface LocalStaticMount {
  prefix: string;
  root: string;
}

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const testResvgAlias = path.resolve(projectRoot, "tests/helpers/stubs/resvg.ts");

const localStaticMounts: LocalStaticMount[] = [
  { prefix: "/assets-legacy/", root: path.resolve(projectRoot, "data/assets") },
  { prefix: "/dictionary/", root: path.resolve(projectRoot, "data/dictionary") },
  { prefix: "/search-index/", root: path.resolve(projectRoot, "data/dictionary/search-index") },
];

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".xml":
      return "application/xml; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    case ".eot":
      return "application/vnd.ms-fontobject";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

async function proxyStrokeJson(cp: string, res: ServerResponse): Promise<void> {
  if (!/^[0-9a-f]{4,6}\.json$/i.test(cp)) {
    res.statusCode = 400;
    res.end("Bad Request");
    return;
  }
  try {
    const upstream = await fetch(`${STROKE_JSON_BASE_URL}/${cp}`);
    if (!upstream.ok) {
      res.statusCode = upstream.status;
      res.end("Not Found");
      return;
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Access-Control-Allow-Origin", "*");
    const text = await upstream.text();
    res.end(text);
  } catch {
    res.statusCode = 502;
    res.end("Proxy Error");
  }
}

/**
 * Dev-only proxy for every path the Cloudflare Worker owns in production.
 *
 * WHY: `vp dev` (without VITE_CLOUDFLARE_REMOTE_DEV=1) runs plain Vite with no
 * Worker at all, so `/api/*` and `/assets/*` used to fall through to Vite's SPA
 * fallback and return `index.html` — the browser then reported
 * `JSON.parse: unexpected character` for /api/config and refused
 * `/assets/styles.css` because its MIME type was `text/html`.
 *
 * Forwarding those prefixes to a live Worker origin (default: production
 * www.moedict.tw, override with VITE_DEV_API_ORIGIN) keeps plain `vp dev`
 * fully functional without Cloudflare credentials, mirroring the existing
 * `/lookup/trs` dev proxy. Files that genuinely live in `public/`
 * (e.g. /assets/images/icon.png) are served locally and never proxied.
 */
const WORKER_PROXY_PREFIXES = ["/api", "/assets"] as const;
const publicDir = path.resolve(projectRoot, "public");

/**
 * True when the request maps to a real file under `public/`, which must win
 * over the remote Worker.
 *
 * Exported for tests. Every failure mode answers "not a public file" rather
 * than throwing: this runs inside Vite's proxy `bypass` hook, so an exception
 * fails the request instead of the lookup. Percent-decoding goes through
 * `tryDecodeURIComponent` because AGENTS.md makes that the single decode path
 * for request paths (a bare `decodeURIComponent` raises URIError on
 * `/assets/%`), and one `statSync` in a try/catch replaces existsSync+statSync,
 * which had a TOCTOU window and could still throw (EACCES, ELOOP).
 */
export function servedFromPublicDir(requestUrl: string | undefined): boolean {
  if (!requestUrl) return false;
  let pathname: string;
  try {
    pathname = new URL(requestUrl, "http://localhost").pathname;
  } catch {
    return false;
  }
  const decoded = tryDecodeURIComponent(pathname);
  if (decoded === null) return false;
  const relative = path.posix.normalize(decoded).replace(/^\/+/, "");
  if (relative.length === 0 || relative.startsWith("..") || relative.includes("\0")) return false;
  const resolved = path.resolve(publicDir, relative);
  if (path.relative(publicDir, resolved).startsWith("..")) return false;
  try {
    return fs.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

function workerProxyConfig(origin: string): Record<string, ProxyOptions> {
  return Object.fromEntries(
    WORKER_PROXY_PREFIXES.map((prefix): [string, ProxyOptions] => [
      prefix,
      {
        target: origin,
        changeOrigin: true,
        // `public/` wins over the remote Worker: returning the request URL
        // tells Vite's proxy to skip this request and continue the chain.
        bypass: (req) => (servedFromPublicDir(req.url) ? req.url : undefined),
      },
    ]),
  );
}

/**
 * Filesystem-backed stand-in for the production `env.DICTIONARY` R2 binding.
 * Every key the Worker reads (`p{lang}ck/{bucket}.txt` pack shards,
 * `{lang}/index.json`, `{lang}/xref*.json`, `{lang}/@{radical}.json`,
 * `{lang}/={list}.json`, `search-index/{lang}.json`) maps 1:1 onto a path
 * under data/dictionary/, so dev serve can reuse the real handlers
 * (handleDictionaryAPI / handleListAPI) and return identical response shapes
 * instead of re-implementing the entry conversion pipeline.
 *
 * One shared instance per server process: r2-json-cache memoizes parsed JSON
 * per binding object via WeakMap, so reusing the binding keeps pack shards
 * warm across requests exactly like a warm Worker isolate does.
 */
const localDictionaryRoot = path.resolve(projectRoot, "data/dictionary");
const localDictionaryEnv = {
  DICTIONARY: {
    async get(key: string): Promise<{ text(): Promise<string> } | null> {
      const normalizedKey = path.posix.normalize(key.replace(/^\/+/, ""));
      if (
        normalizedKey.length === 0 ||
        normalizedKey === "." ||
        normalizedKey.startsWith("..") ||
        normalizedKey.includes("\0")
      ) {
        return null;
      }
      const resolvedPath = path.resolve(localDictionaryRoot, normalizedKey);
      if (path.relative(localDictionaryRoot, resolvedPath).startsWith("..")) {
        return null;
      }
      try {
        const content = await fs.promises.readFile(resolvedPath, "utf8");
        return { text: () => Promise.resolve(content) };
      } catch {
        return null;
      }
    },
  },
};

/** Mirrors the production Worker's JSON routes onto local files/handlers. */
const localApiFileRoutes: Array<{ pattern: RegExp; keyTemplate: string }> = [
  // Sidebar 搜尋索引 API → {lang}/index.json
  { pattern: /^\/api\/index\/([athc])\.json$/, keyTemplate: "$1/index.json" },
  // 全文檢索索引 API → search-index/{lang}.json
  { pattern: /^\/api\/search-index\/([athc])\.json$/, keyTemplate: "search-index/$1.json" },
  // 跨語言 xref 索引 API → {lang}/xref.json
  { pattern: /^\/api\/xref\/([athc])\.json$/, keyTemplate: "$1/xref.json" },
  // ID-aware xref sidecar → {lang}/xref-by-id.json
  { pattern: /^\/api\/xref-by-id\/([athc])\.json$/, keyTemplate: "$1/xref-by-id.json" },
];

async function pipeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  const contentType = response.headers.get("Content-Type") ?? "application/json; charset=utf-8";
  res.statusCode = response.status;
  res.setHeader("Content-Type", contentType);
  // Dev server never caches; prod Cache-Control/Cache-Tag are meaningless locally.
  res.setHeader("Cache-Control", "no-store");
  res.end(response.status === 204 ? undefined : await response.text());
}

/**
 * Serve /api/*.json from local data/dictionary/ during `vp run dev`,
 * dispatching through the same handlers as worker/index.ts:
 *   - /api/index, /api/search-index, /api/xref, /api/xref-by-id → flat file reads
 *   - list routes (=成語、'=諺語…)                                → handleListAPI
 *   - every other .json route (entries, @radicals, =lists, raw/uni/pua)
 *                                                                → handleDictionaryAPI
 * Returns false when the path is not a locally-served API route or the
 * underlying data file is absent — the caller falls through (Vite's SPA
 * fallback or the next middleware), matching "don't fake missing data".
 */
async function serveLocalDictionaryApi(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? "", "http://localhost");
  } catch {
    return false;
  }
  const pathname = url.pathname;

  for (const { pattern, keyTemplate } of localApiFileRoutes) {
    const match = pathname.match(pattern);
    if (!match) continue;
    const object = await localDictionaryEnv.DICTIONARY.get(keyTemplate.replace("$1", match[1]));
    if (!object) return false;
    await pipeWebResponse(
      new Response(await object.text(), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }),
      res,
    );
    return true;
  }

  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const request = new Request(url.href, { method: req.method });
  // Mirror worker/index.ts dispatch order: lists gate first (`.json` optional),
  // then the .json catch-all. stroke-json is proxied earlier in this plugin;
  // cns/config/cache-purge/oembed have no local data and keep falling through.
  if (pathname.startsWith("/api/") && isListPath(pathname)) {
    await pipeWebResponse(await handleListAPI(request, url, localDictionaryEnv), res);
    return true;
  }
  if (
    pathname.endsWith(".json") &&
    !pathname.startsWith("/api/stroke-json/") &&
    !pathname.startsWith("/api/cns/")
  ) {
    const response = await handleDictionaryAPI(request, url, localDictionaryEnv);
    if (!response) return false;
    await pipeWebResponse(response, res);
    return true;
  }
  return false;
}

function localDataAssetsPlugin(): Plugin {
  return {
    name: "moedict-local-data-assets",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = req.url;
        if (!requestUrl) {
          next();
          return;
        }

        const pathname = new URL(requestUrl, "http://localhost").pathname;

        // Proxy /api/stroke-json/{cp}.json and /stroke-json/{cp}.json to Rackspace CDN,
        // mirroring the production Worker; otherwise Vite's SPA fallback returns HTML
        // and jQuery fails to parse it as stroke JSON.
        const strokeMatch = pathname.match(/^\/(?:api\/)?stroke-json\/([^/]+)$/);
        if (strokeMatch) {
          void proxyStrokeJson(strokeMatch[1], res);
          return;
        }

        if (await serveLocalDictionaryApi(req, res)) {
          return;
        }

        const mount = localStaticMounts.find(({ prefix }) => pathname.startsWith(prefix));
        if (!mount) {
          next();
          return;
        }

        const rawRelativePath = decodeURIComponent(pathname.slice(mount.prefix.length)).replace(
          /^\/+/,
          "",
        );
        const normalizedRelativePath = path.posix.normalize(rawRelativePath);
        if (
          normalizedRelativePath.length === 0 ||
          normalizedRelativePath === "." ||
          normalizedRelativePath.startsWith("..") ||
          normalizedRelativePath.includes("\0")
        ) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }

        const resolvedPath = path.resolve(mount.root, normalizedRelativePath);
        const relativeToRoot = path.relative(mount.root, resolvedPath);
        if (
          relativeToRoot.startsWith("..") ||
          path.isAbsolute(relativeToRoot) ||
          !fs.existsSync(resolvedPath) ||
          !fs.statSync(resolvedPath).isFile()
        ) {
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }

        res.setHeader("Content-Type", contentTypeFor(resolvedPath));
        res.setHeader("Cache-Control", "no-store");
        fs.createReadStream(resolvedPath).pipe(res);
      });
    },
  };
}

function getDictionaryDataVersion(): string {
  try {
    const version = execSync("git rev-parse HEAD:data/dictionary", { encoding: "utf-8" }).trim();
    if (version && /^[0-9a-f]{40}$/.test(version)) {
      return version;
    }
  } catch (err) {
    console.warn(
      "⚠️ [build] Could not compute git rev-parse HEAD:data/dictionary; falling back to 'unknown-data-version':",
      err,
    );
  }
  return "unknown-data-version";
}

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  const remoteDev = process.env.VITE_CLOUDFLARE_REMOTE_DEV === "1";
  // Live Worker origin backing plain `vp dev` (no Cloudflare credentials needed).
  const devWorkerOrigin = process.env.VITE_DEV_API_ORIGIN ?? "https://www.moedict.tw";
  // Emit source maps only when explicitly building for coverage — the
  // coverage merge script (scripts/merge-coverage.mjs) reads them to map
  // bundled Chromium V8 coverage back to src/**/*.ts. Regular `npm run
  // build` deploys ship without maps (smaller payload).
  const needsSourcemaps = process.env.E2E_COVERAGE === "1";
  const dictionaryDataVersion = getDictionaryDataVersion();

  return {
    define: {
      __DICTIONARY_DATA_VERSION__: JSON.stringify(dictionaryDataVersion),
    },
    staged: {
      "*": "vp check --fix",
    },
    fmt: {
      ignorePatterns: ["data/**", "dist/**", "coverage/**", ".worktrees/**"],
    },
    lint: {
      plugins: ["typescript", "react"],
      env: {
        builtin: true,
        browser: true,
      },
      ignorePatterns: ["dist", "data", "coverage", "worker-configuration.d.ts", ".worktrees/**"],
      rules: {
        "no-shadow": "error",
        "no-unused-vars": [
          "error",
          {
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
          },
        ],
        "no-case-declarations": "error",
        "no-empty": "error",
        "no-fallthrough": "error",
        "no-prototype-builtins": "error",
        "no-regex-spaces": "error",
        "no-unexpected-multiline": "error",
        "no-var": "error",
        "prefer-const": "error",
        "prefer-rest-params": "error",
        "prefer-spread": "error",
        "no-array-constructor": "error",
        "typescript/ban-ts-comment": "error",
        "typescript/no-empty-object-type": "error",
        "typescript/no-explicit-any": "error",
        "typescript/no-namespace": "error",
        "typescript/no-require-imports": "error",
        "typescript/no-unnecessary-type-constraint": "error",
        "typescript/no-unsafe-function-type": "error",
        "react/rules-of-hooks": "error",
        "react/exhaustive-deps": "warn",
        "react/only-export-components": [
          "error",
          {
            allowConstantExport: true,
          },
        ],
        "vite-plus/prefer-vite-plus-imports": "error",
      },
      // Run semantic Oxlint rules and TypeScript diagnostics across every
      // linted file; `vp run typecheck` remains the canonical project build check.
      options: {
        typeAware: true,
        typeCheck: true,
      },
      jsPlugins: [
        {
          name: "vite-plus",
          specifier: "vite-plus/oxlint-plugin",
        },
      ],
    },
    test: {
      reporters: process.env.CI ? ["default", "junit"] : ["default"],
      outputFile: {
        junit: "unit-report.xml",
      },
      projects: [
        {
          plugins: [react()],
          resolve: {
            alias: {
              "@cf-wasm/resvg": testResvgAlias,
            },
          },
          test: {
            name: "unit",
            environment: "happy-dom",
            include: ["tests/unit/**/*.test.{ts,tsx}"],
            setupFiles: ["tests/unit/_setup.ts"],
            globals: false,
          },
        },
        {
          resolve: {
            alias: {
              "@cf-wasm/resvg": testResvgAlias,
            },
          },
          test: {
            name: "integration",
            include: ["tests/integration/**/*.test.ts"],
            environment: "node",
            globalSetup: ["tests/integration/_global-setup.ts"],
            testTimeout: 30_000,
            hookTimeout: 60_000,
            maxConcurrency: 1,
            pool: "forks",
            fileParallelism: false,
          },
        },
      ],
      coverage: {
        provider: "v8",
        reporter: ["text", "json", "lcov"],
        reportsDirectory: "coverage/unit",
        include: [
          "src/ssr/**/*.ts",
          "src/utils/**/*.ts",
          "src/api/**/*.ts",
          "src/oembed/**/*.ts",
          "worker/**/*.ts",
        ],
        exclude: ["src/utils/image-generation.ts"],
        // Ratchet gate: raise these floors when coverage increases; never lower them.
        thresholds: {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
    build: {
      sourcemap: needsSourcemaps,
    },
    server: {
      proxy: {
        "/lookup/trs": {
          target: devWorkerOrigin,
          changeOrigin: true,
        },
        // Only when the Cloudflare plugin is not mounted (plain `vp dev`);
        // with VITE_CLOUDFLARE_REMOTE_DEV=1 the real Worker serves these.
        ...(command === "serve" && !remoteDev ? workerProxyConfig(devWorkerOrigin) : {}),
      },
    },
    plugins: lazyPlugins(() => [
      react(),
      command === "serve" ? (remoteDev ? cloudflare() : localDataAssetsPlugin()) : cloudflare(),
    ]),
  };
});
