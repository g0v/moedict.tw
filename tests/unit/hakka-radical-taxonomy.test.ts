import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vite-plus/test";

const REPO_ROOT = join(__dirname, "..", "..");
const H_DIR = join(REPO_ROOT, "data", "dictionary", "h");
const PHCK_DIR = join(REPO_ROOT, "data", "dictionary", "phck");
const GENERATOR = join(REPO_ROOT, "scripts", "regenerate-h-taxonomy.mjs");
const tempDirs: string[] = [];

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function hashFiles(paths: string[]): string {
  const hash = createHash("sha256");
  for (const path of paths.sort()) {
    hash.update(path);
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

function generatedFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => /^@.*\.json$/u.test(name))
    .sort();
}

function generatedSnapshot(dir: string): Map<string, string> {
  return new Map(generatedFiles(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]));
}

function makeCnsRecord(root: string, char: string, radicalId: number, stroke: number): void {
  const hex = char.codePointAt(0)!.toString(16).toUpperCase();
  const shard = hex.length <= 4 ? hex.slice(0, 2) : hex.slice(0, 3);
  const dir = join(root, shard);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${hex}.json`),
    JSON.stringify({ char, attributes: { radical: { id: radicalId, char }, stroke } }),
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("generated Hakka radical taxonomy", () => {
  it("indexes all 3,544 single-character Hakka headwords into exactly 207 radical files", () => {
    const index = readJson<string[]>(join(H_DIR, "index.json"));
    const singleHan = index.filter(
      (title) => Array.from(title).length === 1 && /^\p{Script=Han}$/u.test(title),
    );
    const files = generatedFiles(H_DIR);
    const radicalFiles = files.filter((name) => name !== "@.json");
    const indexedTitles = radicalFiles.flatMap((name) => {
      const rows = readJson<Array<string[] | null>>(join(H_DIR, name));
      return rows.flatMap((row) => row ?? []);
    });

    expect(singleHan).toHaveLength(3_544);
    expect(radicalFiles).toHaveLength(207);
    expect(indexedTitles).toHaveLength(3_544);
    expect(new Set(indexedTitles).size).toBe(3_544);
    expect([...indexedTitles].sort((a, b) => a.localeCompare(b, "zh-Hant"))).toEqual(
      [...singleHan].sort((a, b) => a.localeCompare(b, "zh-Hant")),
    );
  });

  it("populates the canonical 207 radicals and groups sample characters by exact CNS total strokes", () => {
    const canonical = readJson<string[][]>(join(REPO_ROOT, "data", "dictionary", "a", "@.json"));
    const populated = readJson<string[][]>(join(H_DIR, "@.json"));
    const allCanonical = canonical.flat();
    const allPopulated = populated.flat();
    const absent = allCanonical.filter((radical) => !allPopulated.includes(radical));

    expect(allPopulated).toHaveLength(207);
    expect(absent).toEqual(["夂", "隶", "鬯", "鬲", "黹", "黽", "龠"]);
    expect(readJson<Array<string[] | null>>(join(H_DIR, "@刀.json"))[14]).toContain("㓾");
    expect(readJson<Array<string[] | null>>(join(H_DIR, "@人.json"))[10]).toContain("𠊎");
  });

  it("is deterministic, leaves dictionary data byte-identical, and skips a missing CNS character", () => {
    const temp = mkdtempSync(join(tmpdir(), "hakka-radical-"));
    tempDirs.push(temp);
    const indexPath = join(temp, "index.json");
    const tocPath = join(REPO_ROOT, "data", "dictionary", "a", "@.json");
    const cnsRoot = join(temp, "cns");
    const outDir = join(temp, "out");
    writeFileSync(indexPath, JSON.stringify(["一", "𬠖", "一個"]));
    makeCnsRecord(cnsRoot, "一", 1, 1);

    const protectedFiles = [
      join(H_DIR, "index.json"),
      ...readdirSync(PHCK_DIR)
        .filter((name) => name.endsWith(".txt"))
        .map((name) => join(PHCK_DIR, name)),
    ];
    const beforeHash = hashFiles(protectedFiles);
    const args = [
      GENERATOR,
      `--index=${indexPath}`,
      `--toc=${tocPath}`,
      `--cns-root=${cnsRoot}`,
      `--out=${outDir}`,
      "--allow-incomplete=true",
    ];

    const first = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: "utf8" });
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("indexed=1 skipped=1");
    expect(first.stderr).toContain("Skipped 𬠖: missing CNS record");
    const firstSnapshot = generatedSnapshot(outDir);

    const second = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: "utf8" });
    expect(second.status, second.stderr).toBe(0);
    expect(generatedSnapshot(outDir)).toEqual(firstSnapshot);
    expect(readJson<Array<string[] | null>>(join(outDir, "@一.json"))[1]).toEqual(["一"]);
    expect(hashFiles(protectedFiles)).toBe(beforeHash);
  });
});
