import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin, lazyPlugins } from "vite-plus";
import react from "@vitejs/plugin-react";

import { cloudflare } from "@cloudflare/vite-plugin";
import { STROKE_JSON_BASE_URL } from "./src/utils/media-cdn";

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

async function proxyStrokeJson(cp: string, res: import("http").ServerResponse): Promise<void> {
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

function localDataAssetsPlugin(): Plugin {
  return {
    name: "moedict-local-data-assets",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
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
    console.warn("⚠️ [build] Could not compute git rev-parse HEAD:data/dictionary; falling back to 'unknown-data-version':", err);
  }
  return "unknown-data-version";
}

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  const remoteDev = process.env.VITE_CLOUDFLARE_REMOTE_DEV === "1";
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
          target: "https://www.moedict.tw",
          changeOrigin: true,
        },
      },
    },
    plugins: lazyPlugins(() => [
      react(),
      command === "serve" ? (remoteDev ? cloudflare() : localDataAssetsPlugin()) : cloudflare(),
    ]),
  };
});
