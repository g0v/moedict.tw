import { build } from "esbuild";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const OUT_DIR = path.join(REPO_ROOT, "tests", ".build");
const OUT_FILE = path.join(OUT_DIR, "worker.mjs");
const ENTRY = path.join(REPO_ROOT, "worker", "index.ts");
const RESVG_STUB = path.join(REPO_ROOT, "tests", "helpers", "stubs", "resvg.ts");

function sourceNewerThanOutput(): boolean {
  if (!existsSync(OUT_FILE)) return true;
  const outMtime = statSync(OUT_FILE).mtimeMs;

  const walk = (dir: string): number => {
    let mx = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        mx = Math.max(mx, walk(full));
      } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
        mx = Math.max(mx, statSync(full).mtimeMs);
      }
    }
    return mx;
  };

  const srcMtime = Math.max(
    walk(path.join(REPO_ROOT, "worker")),
    walk(path.join(REPO_ROOT, "src", "api")),
    walk(path.join(REPO_ROOT, "src", "ssr")),
    walk(path.join(REPO_ROOT, "src", "utils")),
  );
  return srcMtime > outMtime;
}

export async function buildWorker(options: { force?: boolean } = {}): Promise<string> {
  if (!options.force && !sourceNewerThanOutput()) {
    return OUT_FILE;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "esnext",
    outfile: OUT_FILE,
    // Sourcemaps are always-on here: scripts/merge-coverage.mjs consumes
    // them to attribute workerd V8 coverage back to src/**/*.ts. The file
    // only lives under tests/.build/ and isn't shipped anywhere.
    sourcemap: true,
    sourcesContent: true,
    alias: {
      "@cf-wasm/resvg": RESVG_STUB,
    },
    logLevel: "warning",
  });
  return OUT_FILE;
}

export const WORKER_OUTPUT = OUT_FILE;
