#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..");
const outputs = [
  path.join(root, "data/dictionary/search-index"),
  path.join(root, "data/dictionary/lookup/pinyin"),
];
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "moedict-derived-"));
const pauseAfterRemovalMs = Number.parseInt(
  process.env.CHECK_DERIVED_DATA_PAUSE_AFTER_REMOVAL_MS ?? "0",
  10,
);
const pauseAfterRemoval =
  Number.isFinite(pauseAfterRemovalMs) && pauseAfterRemovalMs > 0
    ? () => {
        console.log("CHECK_DERIVED_DATA_REMOVAL_PAUSE_READY");
        return new Promise((resolve) => setTimeout(resolve, pauseAfterRemovalMs));
      }
    : async () => {};
const pauseDuringBuildMs = Number.parseInt(
  process.env.CHECK_DERIVED_DATA_PAUSE_DURING_BUILD_MS ?? "0",
  10,
);

const backups = [];
let restorePromise;
const doRestore = async () => {
  for (const [out, b] of backups) {
    if (fs.existsSync(b)) {
      await fsp.rm(out, { recursive: true, force: true });
      await fsp.cp(b, out, { recursive: true });
    }
  }
  await fsp.rm(tmp, { recursive: true, force: true });
};
const restore = () => (restorePromise ??= doRestore());
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await restore();
    process.exit(128 + (signal === "SIGINT" ? 2 : 15));
  });
}
const digest = async (dir) => {
  const files = [];
  const walk = async (p) => {
    for (const e of await fsp.readdir(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) await walk(q);
      else files.push(path.relative(dir, q));
    }
  };
  await walk(dir);
  files.sort((a, b) => a.localeCompare(b));
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f);
    h.update(await fsp.readFile(path.join(dir, f)));
  }
  return h.digest("hex");
};
try {
  for (const [i, out] of outputs.entries()) {
    const b = path.join(tmp, String(i));
    backups.push([out, b]);
    if (fs.existsSync(out)) await fsp.cp(out, b, { recursive: true });
  }
  const before = [];
  for (const [out, b] of backups) {
    if (!fs.existsSync(b)) throw new Error(`missing derived output: ${path.relative(root, out)}`);
    before.push(await digest(b));
    await fsp.rm(out, { recursive: true, force: true });
  }
  await pauseAfterRemoval();

  if (Number.isFinite(pauseDuringBuildMs) && pauseDuringBuildMs > 0) {
    console.log("CHECK_DERIVED_DATA_BUILD_PAUSE_READY");
    const r = spawnSync(process.execPath, ["-e", `setTimeout(() => {}, ${pauseDuringBuildMs})`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status !== 0) throw new Error(`build hook failed\n${r.stderr}`);
  }
  for (const script of ["scripts/build-search-index.mjs", "scripts/build-pinyin-lookup.mjs"]) {
    const r = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${script} failed\n${r.stderr}`);
  }
  for (let i = 0; i < backups.length; i++) {
    const [out] = backups[i];
    if (!fs.existsSync(out) || (await digest(out)) !== before[i])
      throw new Error(`stale derived output: ${path.relative(root, out)}`);
  }
} finally {
  await restore();
}
