#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const cDictionaryDir = path.join(projectRoot, "data", "dictionary", "c");
const crossStraitPackDir = path.join(projectRoot, "data", "dictionary", "pcck");
const categoryListFile = path.join(cDictionaryDir, "=.json");
const outputFile = path.join(projectRoot, "data", "dictionary", "c", "index.json");

async function readJsonArray(filePath) {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`檔案不是陣列格式：${filePath}`);
  }
  return parsed;
}

async function readJsonObject(filePath) {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`檔案不是物件格式：${filePath}`);
  }
  return parsed;
}

function normalizeWord(word) {
  return String(word || "").trim();
}

function appendWords(target, seen, words) {
  for (const word of words) {
    const normalized = normalizeWord(word);
    if (!normalized || normalized.startsWith(";") || seen.has(normalized)) continue;
    seen.add(normalized);
    target.push(normalized);
  }
}

async function collectCrossStraitHeadwords() {
  const entries = await readdir(crossStraitPackDir, { withFileTypes: true });
  const numericFiles = entries
    .filter((entry) => entry.isFile() && /^[0-9]+\.txt$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

  const words = [];
  const seen = new Set();

  for (const fileName of numericFiles) {
    const sourceFile = path.join(crossStraitPackDir, fileName);
    const bucket = await readJsonObject(sourceFile);
    appendWords(
      words,
      seen,
      Object.keys(bucket).map((key) => unescape(key)),
    );
  }

  return words;
}

async function main() {
  const merged = await collectCrossStraitHeadwords();
  const seen = new Set(merged);
  const categories = await readJsonArray(categoryListFile);

  for (const category of categories) {
    const categoryName = String(category || "").trim();
    if (!categoryName) continue;

    const sourceFile = path.join(cDictionaryDir, `=${categoryName}.json`);
    const words = await readJsonArray(sourceFile);
    appendWords(merged, seen, words);
  }

  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  console.log(`已輸出 ${merged.length} 筆到 ${path.relative(projectRoot, outputFile)}`);
}

main().catch((error) => {
  console.error("[generateCIndex] failed:", error);
  process.exitCode = 1;
});
