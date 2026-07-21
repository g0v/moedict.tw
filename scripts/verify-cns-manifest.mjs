#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const manifestPath = process.env.CNS_MANIFEST
  ? path.resolve(process.env.CNS_MANIFEST)
  : path.join(root, "data/sources/cns-data-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const out = process.env.CNS_ROOT
  ? path.resolve(process.env.CNS_ROOT)
  : path.join(root, "data/dictionary/cns/by-codepoint");
if (!fs.existsSync(out)) throw new Error("CNS output missing");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pinFor = (name) => manifest.source_sha256?.[name];
const normalizePin = (name, pin) => {
  if (typeof pin === "string") return { sha256: pin };
  if (pin && typeof pin === "object") return pin;
  throw new Error(`CNS ${name} source pin must be a SHA-256 hex string or object`);
};
const verifySource = (name, file) => {
  const bytes = fs.readFileSync(file);
  const pin = pinFor(name);
  const expectedName = manifest.source_archive_names?.[name];
  if (expectedName && path.basename(file) !== expectedName)
    throw new Error(`CNS ${name} archive name mismatch: expected ${expectedName}`);
  if (!pin) return { bytes: bytes.length, sha256: sha256(bytes), status: "unvalidated-unpinned" };
  const normalized = normalizePin(name, pin);
  if (normalized.name && path.basename(file) !== normalized.name)
    throw new Error(`CNS ${name} archive name mismatch: expected ${normalized.name}`);
  if (normalized.bytes !== undefined && normalized.bytes !== bytes.length)
    throw new Error(`CNS ${name} source size mismatch: ${bytes.length} != ${normalized.bytes}`);
  if (normalized.size !== undefined && normalized.size !== bytes.length)
    throw new Error(`CNS ${name} source size mismatch: ${bytes.length} != ${normalized.size}`);
  if (typeof normalized.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(normalized.sha256))
    throw new Error(`CNS ${name} source pin is not a valid SHA-256 hex digest`);
  const actual = sha256(bytes);
  if (actual.toLowerCase() !== normalized.sha256.toLowerCase())
    throw new Error(`CNS ${name} source hash mismatch`);
  return { bytes: bytes.length, sha256: actual, status: "validated" };
};

const sources = {};
for (const [name, file] of Object.entries({
  properties: process.env.CNS_PROPERTIES,
  mapping: process.env.CNS_MAPPING,
})) {
  if (!file) continue;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile())
    throw new Error(`CNS ${name} archive missing: ${file}`);
  sources[name] = verifySource(name, path.resolve(file));
}

const files = [];
const walk = (p) => {
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const q = path.join(p, e.name);
    if (e.isDirectory()) walk(q);
    else files.push(q);
  }
};
walk(out);
const json = files.filter((f) => f.endsWith(".json"));
if (json.length !== manifest.expected_emitted)
  throw new Error(`CNS count ${json.length} != ${manifest.expected_emitted}`);
if (manifest.output_checksum?.sha256) {
  const lines =
    json
      .map((f) => `${sha256(fs.readFileSync(f))}  ${path.relative(out, f)}`)
      .sort()
      .join("\n") + "\n";
  if (sha256(lines) !== manifest.output_checksum.sha256)
    throw new Error("CNS output checksum mismatch");
}
for (const f of json) JSON.parse(fs.readFileSync(f, "utf8"));
console.log(
  `[cns] manifest verified: ${json.length} JSON outputs; sources ${Object.keys(sources).length ? JSON.stringify(sources) : "unpinned/not supplied"}`,
);
