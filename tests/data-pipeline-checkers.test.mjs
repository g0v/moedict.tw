import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..");
const inv = path.join(root, "scripts/check-dictionary-inventory.mjs");
const run = (file, args, env) =>
  spawnSync(process.execPath, [file, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "dict-fixture-"));
const d = path.join(tmp, "dictionary");
for (const [n, max] of [
  ["pack", 1023],
  ["pcck", 127],
  ["phck", 127],
  ["ptck", 127],
]) {
  await fsp.mkdir(path.join(d, n), { recursive: true });
  for (let i = 0; i <= max; i++) await fsp.writeFile(path.join(d, n, `${i}.txt`), "{}");
}
for (const l of ["a", "c", "h", "t"]) {
  await fsp.mkdir(path.join(d, l), { recursive: true });
  for (const n of ["index.json", "xref.json", "xref-by-id.json", "@x.json", "=x.json"])
    await fsp.writeFile(path.join(d, l, n), n === "index.json" ? "[]" : "{}");
}
for (const l of ["a", "c", "h", "t"]) {
  await fsp.mkdir(path.join(d, "search-index"), { recursive: true });
  await fsp.writeFile(path.join(d, "search-index", `${l}.json`), "[]");
}
await fsp.mkdir(path.join(d, "translation-data"), { recursive: true });
await fsp.writeFile(path.join(d, "translation-data/cfdict.txt"), "x");
await fsp.mkdir(path.join(d, "lookup/pinyin"), { recursive: true });
await fsp.writeFile(path.join(d, "lookup/pinyin/x.json"), "{}");
const inventoryManifest = path.join(tmp, "manifest.json");
const inventoryEnv = { DICTIONARY_ROOT: d, DICTIONARY_INVENTORY_MANIFEST: inventoryManifest };
assert.equal(run(inv, ["--update"], inventoryEnv).status, 0);
assert.equal(run(inv, [], inventoryEnv).status, 0);
for (const rel of [
  "a/index.json",
  "a/xref.json",
  "a/xref-by-id.json",
  "a/@x.json",
  "a/=x.json",
  "translation-data/cfdict.txt",
]) {
  const p = path.join(d, rel);
  const b = fs.readFileSync(p);
  fs.rmSync(p);
  assert.notEqual(run(inv, [], inventoryEnv).status, 0);
  fs.writeFileSync(p, b);
}
fs.rmSync(path.join(d, "pack/7.txt"));
assert.notEqual(run(inv, [], inventoryEnv).status, 0);
const inventory = JSON.parse(fs.readFileSync(inventoryManifest));
inventory.paths.push("data/dictionary/extra.json");
fs.writeFileSync(inventoryManifest, JSON.stringify(inventory));
assert.notEqual(run(inv, [], inventoryEnv).status, 0);
const cnsRoot = path.join(tmp, "cns");
await fsp.mkdir(cnsRoot, { recursive: true });
await fsp.writeFile(path.join(cnsRoot, "A.json"), "{}");
await fsp.writeFile(path.join(cnsRoot, "B.json"), "{}");
const cm = path.join(tmp, "cns.json");
await fsp.writeFile(cm, JSON.stringify({ expected_emitted: 2 }));
const vr = path.join(root, "scripts/verify-cns-manifest.mjs");
const ce = { CNS_ROOT: cnsRoot, CNS_MANIFEST: cm };
assert.equal(run(vr, [], ce).status, 0);
fs.rmSync(path.join(cnsRoot, "B.json"));
assert.notEqual(run(vr, [], ce).status, 0);
fs.writeFileSync(path.join(cnsRoot, "B.json"), "{}");

const propertiesZip = path.join(tmp, "Properties.zip");
const mappingZip = path.join(tmp, "MapingTables.zip");
fs.writeFileSync(propertiesZip, "properties-fixture");
fs.writeFileSync(mappingZip, "mapping-fixture");
const digestFile = (file) => ({
  sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
  bytes: fs.statSync(file).size,
});
const selfPinnedManifest = {
  expected_emitted: 2,
  source_archive_names: { properties: "Properties.zip", mapping: "MapingTables.zip" },
  source_sha256: { properties: digestFile(propertiesZip), mapping: digestFile(mappingZip) },
};
fs.writeFileSync(cm, JSON.stringify(selfPinnedManifest));
assert.equal(
  run(vr, [], {
    CNS_ROOT: cnsRoot,
    CNS_MANIFEST: cm,
    CNS_PROPERTIES: propertiesZip,
    CNS_MAPPING: mappingZip,
  }).status,
  0,
);
const expectSourceFailure = (sourceManifest, extraEnv = {}) => {
  fs.writeFileSync(cm, JSON.stringify({ ...selfPinnedManifest, ...sourceManifest }));
  assert.notEqual(
    run(vr, [], {
      CNS_ROOT: cnsRoot,
      CNS_MANIFEST: cm,
      CNS_PROPERTIES: propertiesZip,
      CNS_MAPPING: mappingZip,
      ...extraEnv,
    }).status,
    0,
  );
};
expectSourceFailure({
  source_sha256: {
    properties: { sha256: "0".repeat(64), bytes: digestFile(propertiesZip).bytes },
    mapping: digestFile(mappingZip),
  },
});
expectSourceFailure({
  source_sha256: {
    properties: {
      sha256: digestFile(propertiesZip).sha256,
      bytes: digestFile(propertiesZip).bytes + 1,
    },
    mapping: digestFile(mappingZip),
  },
});
fs.writeFileSync(path.join(tmp, "wrong-name.zip"), "properties-fixture");
expectSourceFailure(selfPinnedManifest, { CNS_PROPERTIES: path.join(tmp, "wrong-name.zip") });
expectSourceFailure({
  source_sha256: {
    properties: { sha256: "not-hex", bytes: digestFile(propertiesZip).bytes },
    mapping: digestFile(mappingZip),
  },
});
console.log("data pipeline checker fixtures passed");
const derived = path.join(root, "data/dictionary/search-index/a.json");
const original = fs.readFileSync(derived);
fs.appendFileSync(derived, "X");
const tampered = fs.readFileSync(derived);
const dr = run(path.join(root, "scripts/check-derived-data.mjs"), [], {});
assert.notEqual(dr.status, 0);
assert.deepEqual(fs.readFileSync(derived), tampered);
fs.writeFileSync(derived, original);

const treeDigest = async (dir) => {
  const files = [];
  const walk = async (current) => {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(path.relative(dir, full));
    }
  };
  await walk(dir);
  files.sort((a, b) => a.localeCompare(b));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update(await fsp.readFile(path.join(dir, file)));
  }
  return hash.digest("hex");
};

for (const signal of ["SIGINT", "SIGTERM"]) {
  const outputs = [
    path.join(root, "data/dictionary/search-index"),
    path.join(root, "data/dictionary/lookup/pinyin"),
  ];
  const before = await Promise.all(outputs.map(treeDigest));
  const child = spawn(process.execPath, [path.join(root, "scripts/check-derived-data.mjs")], {
    cwd: root,
    env: { ...process.env, CHECK_DERIVED_DATA_PAUSE_AFTER_REMOVAL_MS: "30000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, sig) => resolve({ code, sig }));
  });
  const ready = new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("CHECK_DERIVED_DATA_REMOVAL_PAUSE_READY")) resolve();
    });
    child.once("error", reject);
  });
  await ready;
  child.kill(signal);
  const result = await exit;
  assert.equal(result.code, signal === "SIGINT" ? 130 : 143);
  assert.equal(result.sig, null);
  assert.deepEqual(await Promise.all(outputs.map(treeDigest)), before);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  const outputs = [
    path.join(root, "data/dictionary/search-index"),
    path.join(root, "data/dictionary/lookup/pinyin"),
  ];
  const before = await Promise.all(outputs.map(treeDigest));
  const child = spawn(process.execPath, [path.join(root, "scripts/check-derived-data.mjs")], {
    cwd: root,
    env: { ...process.env, CHECK_DERIVED_DATA_PAUSE_DURING_BUILD_MS: "30000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, sig) => resolve({ code, sig }));
  });
  const ready = new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("CHECK_DERIVED_DATA_BUILD_PAUSE_READY")) resolve();
    });
    child.once("error", reject);
  });
  await ready;
  child.kill(signal);
  const result = await exit;
  assert.equal(result.code, signal === "SIGINT" ? 130 : 143);
  assert.equal(result.sig, null);
  assert.deepEqual(await Promise.all(outputs.map(treeDigest)), before);
}
