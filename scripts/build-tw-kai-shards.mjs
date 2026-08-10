#!/usr/bin/env node
/**
 * scripts/build-tw-kai-shards.mjs
 *
 * Deterministic build and verification script for TW-Kai font shards.
 *
 * Downloads upstream CNS11643 open-data zip archives, verifies checksums,
 * extracts source TTF fonts, regenerates the eight TW-Kai font shards,
 * and verifies that the regenerated shards match the tracked manifest
 * and existing local disk files byte-for-byte.
 *
 * Usage:
 *   node scripts/build-tw-kai-shards.mjs [options]
 *
 * Options:
 *   --manifest=<path>  Manifest path (default: data/assets/fonts/tw-kai-shards.manifest.json)
 *   --out-dir=<dir>    Output directory for generated shards (default: temporary directory)
 *   --cache-dir=<dir>  Cache directory for downloaded zips (default: /tmp/cns-font-cache)
 *   --overwrite        Allow writing generated shards into data/assets/fonts/
 *   --verify-r2        Also fetch live R2 URLs and perform 3-way checksum comparison
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  }),
);

const MANIFEST_PATH = path.resolve(
  REPO_ROOT,
  args["manifest"] ?? "data/assets/fonts/tw-kai-shards.manifest.json",
);
const OVERWRITE = args["overwrite"] === "true" || args["overwrite"] === "";
const VERIFY_R2 = args["verify-r2"] === "true" || args["verify-r2"] === "" || true; // Default true per instructions
const CACHE_DIR = args["cache-dir"] ?? "/tmp/cns-font-cache";
let OUT_DIR = args["out-dir"] ? path.resolve(REPO_ROOT, args["out-dir"]) : null;

if (!OUT_DIR) {
  OUT_DIR = mkdtempSync(path.join(os.tmpdir(), "tw-kai-shards-build-"));
}

const PROTECTED_FONTS_DIR = path.resolve(REPO_ROOT, "data/assets/fonts");

if (OUT_DIR === PROTECTED_FONTS_DIR && !OVERWRITE) {
  console.error("❌ ERROR: Refusing to write directly to data/assets/fonts/ without --overwrite.");
  process.exit(1);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

async function fetchBuffer(url) {
  // Using python for robust SSL bypass on Taiwan government ePKI certificates on macOS
  const pyCode = `
import urllib.request, ssl, sys
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
req = urllib.request.Request("${url}", headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req, context=ctx) as resp:
    sys.stdout.buffer.write(resp.read())
`;
  const buf = execSync(`python3 -c '${pyCode}'`, { maxBuffer: 100 * 1024 * 1024 });
  return buf;
}

async function main() {
  console.log("🛠  TW-Kai Font Shards Deterministic Builder");
  console.log(`   Manifest:  ${MANIFEST_PATH}`);
  console.log(`   Output:    ${OUT_DIR}`);
  console.log(`   Cache:     ${CACHE_DIR}`);

  if (!existsSync(MANIFEST_PATH)) {
    console.error(`❌ Manifest not found at ${MANIFEST_PATH}`);
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
  ensureDir(CACHE_DIR);
  ensureDir(OUT_DIR);

  // 1. Download & Verify Upstream Zips
  const fontsZipPath = path.join(CACHE_DIR, "Fonts_Kai.zip");
  const mappingZipPath = path.join(CACHE_DIR, "MapingTables.zip");
  const propsZipPath = path.join(CACHE_DIR, "Properties.zip");

  // Download & Verify Main Fonts Zip
  if (!existsSync(fontsZipPath)) {
    console.log(`⬇️  Downloading Fonts_Kai.zip from ${manifest.upstream.url}...`);
    const buf = await fetchBuffer(manifest.upstream.url);
    writeFileSync(fontsZipPath, buf);
  }
  const fontsBuf = readFileSync(fontsZipPath);
  const fontsHash = sha256(fontsBuf);
  if (fontsHash !== manifest.upstream.sha256) {
    console.error(`❌ FATAL CHECKSUM MISMATCH for Fonts_Kai.zip!`);
    console.error(`   Expected: ${manifest.upstream.sha256}`);
    console.error(`   Actual:   ${fontsHash}`);
    process.exit(1);
  }
  console.log(`✅ Fonts_Kai.zip verified (SHA-256: ${fontsHash.slice(0, 16)}...)`);

  // Download & Log Supporting Datasets Provenance
  const provMap = manifest.upstream.supporting_datasets_provenance;
  if (provMap) {
    for (const [key, info] of Object.entries(provMap)) {
      const destPath = path.join(CACHE_DIR, `${key}.zip`);
      if (!existsSync(destPath)) {
        console.log(`⬇️  Downloading supporting dataset provenance ${key} from ${info.url}...`);
        try {
          const buf = await fetchBuffer(info.url);
          writeFileSync(destPath, buf);
        } catch (e) {
          console.warn(`⚠️  Warning: Failed to fetch supporting dataset ${key}:`, e.message);
        }
      }
      if (existsSync(destPath)) {
        const hash = sha256(readFileSync(destPath));
        const match = hash === info.observed_sha256;
        console.log(`ℹ️  Supporting dataset ${key}: observed SHA-256 ${hash.slice(0, 16)}... (${match ? "matches recorded provenance" : "upstream hash drift detected, using manifest codepoint ranges"})`);
      }
    }
  }

  // 2. Extract & Verify Inner TTFs
  console.log("\n📦 Extracting and verifying inner TTF fonts...");
  const pyExtract = `
import zipfile, sys
with zipfile.ZipFile("${fontsZipPath}") as zf:
    sys.stdout.buffer.write(zf.read(sys.argv[1]))
`;

  for (const [fontName, info] of Object.entries(manifest.upstream.inner_fonts)) {
    if (fontName.endsWith(".ttf") && info.role.includes("used for shards")) {
      const buf = execSync(`python3 -c '${pyExtract}' "${fontName}"`, { maxBuffer: 100 * 1024 * 1024 });
      const hash = sha256(buf);
      if (hash !== info.sha256) {
        console.error(`❌ CHECKSUM MISMATCH for inner font ${fontName}!`);
        console.error(`   Expected: ${info.sha256}`);
        console.error(`   Actual:   ${hash}`);
        process.exit(1);
      }
      console.log(`✅ Inner font ${fontName} verified (SHA-256: ${hash.slice(0, 16)}...)`);
    }
  }

  // 3. Regenerate all 8 shards via fontTools
  console.log("\n⚡️ Regenerating 8 font shards via fontTools.subset...");
  const pyBuildShards = `
import zipfile, io, hashlib, os, sys, json
from fontTools import subset
from fontTools.ttLib import TTFont

out_dir = "${OUT_DIR}"
fonts_zip = "${fontsZipPath}"
manifest_path = "${MANIFEST_PATH}"

with open(manifest_path, "r") as f:
    manifest = json.load(f)

def parse_ranges(r_list):
    cps = set()
    for item in r_list:
        if "-" in item:
            parts = item.split("-")
            cps.update(range(int(parts[0], 16), int(parts[1], 16) + 1))
        else:
            cps.add(int(item, 16))
    return cps

with zipfile.ZipFile(fonts_zip) as zf:
    font98_data = zf.read("TW-Kai-98_1.ttf")
    font_extb_data = zf.read("TW-Kai-Ext-B-98_1.ttf")

results = []
for shard_info in manifest["shards"]:
    i = shard_info["index"]
    filename = shard_info["filename"]
    
    in_bytes = font98_data if i in (0, 1, 2) else font_extb_data
    target_cps = parse_ranges(shard_info["codepoint_ranges"])
    font = TTFont(io.BytesIO(in_bytes))
    options = subset.Options()
    options.notdef_outline = True
    options.ignore_missing_glyphs = True
    
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=target_cps)
    subsetter.subset(font)
    
    font.recalcTimestamp = False
    font["head"].created = shard_info["pinned_created_epoch"]
    font["head"].modified = shard_info["pinned_modified_epoch"]
    
    buf = io.BytesIO()
    font.save(buf)
    gen_bytes = buf.getvalue()
    
    out_path = os.path.join(out_dir, filename)
    with open(out_path, "wb") as f:
        f.write(gen_bytes)
        
    sha256_hex = hashlib.sha256(gen_bytes).hexdigest()
    results.append({"filename": filename, "sha256": sha256_hex, "size": len(gen_bytes)})

print(json.dumps(results))
`;

  const pyRes = execSync(`python3 -c '${pyBuildShards}'`, { maxBuffer: 100 * 1024 * 1024 });
  const genResults = JSON.parse(pyRes.toString("utf-8"));

  // 4. Verify regenerated shards against manifest & local disk
  console.log("\n🔍 Verification & Checksum Comparison Table:");
  console.log("=" .repeat(225));
  console.log(
    `${"Filename".padEnd(20)} | ${"Manifest SHA-256".padEnd(64)} | ${"Regenerated SHA-256".padEnd(64)} | ${"Local Disk SHA-256".padEnd(64)} | ${"Status"}`,
  );
  console.log("=" .repeat(225));

  let allMatch = true;
  for (let i = 0; i < 8; i++) {
    const shardInfo = manifest.shards[i];
    const genInfo = genResults[i];
    const localPath = path.join(PROTECTED_FONTS_DIR, shardInfo.filename);
    const localExists = existsSync(localPath);
    const localSha256 = localExists ? sha256(readFileSync(localPath)) : "ABSENT (loss recovery)";

    const matchManifest = genInfo.sha256 === shardInfo.sha256;
    const matchLocal = localExists ? genInfo.sha256 === localSha256 : true;
    const pass = matchManifest && matchLocal;

    if (!pass) allMatch = false;

    console.log(
      `${shardInfo.filename.padEnd(20)} | ${shardInfo.sha256.padEnd(64)} | ${genInfo.sha256.padEnd(64)} | ${localSha256.padEnd(64)} | ${pass ? "✅ MATCH" : "❌ MISMATCH"}`,
    );
  }
  console.log("=" .repeat(225));

  // 5. Check R2 live URLs if requested
  if (VERIFY_R2) {
    console.log("\n🌐 Fetching live R2 shard URLs for 3-way verification...");
    const pyFetchR2 = `
import urllib.request, ssl, hashlib, json

results = []
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

for i in range(8):
    url = f"https://r2-assets.moedict.tw/fonts/TW-Kai-shard-{i}.ttf"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, context=ctx) as resp:
        data = resp.read()
    results.append({"index": i, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
print(json.dumps(results))
`;
    const r2ResBuf = execSync(`python3 -c '${pyFetchR2}'`, { maxBuffer: 100 * 1024 * 1024 });
    const r2Results = JSON.parse(r2ResBuf.toString("utf-8"));

    console.log("\n🌐 R2 Live vs Local Disk vs Manifest 3-Way Comparison:");
    console.log("=" .repeat(235));
    console.log(
      `${"Filename".padEnd(20)} | ${"Manifest SHA-256".padEnd(64)} | ${"Local Disk SHA-256".padEnd(64)} | ${"R2 Live SHA-256".padEnd(64)} | ${"Size (B)".padEnd(10)} | ${"Status"}`,
    );
    console.log("=" .repeat(235));

    let r2Match = true;
    for (let i = 0; i < 8; i++) {
      const shardInfo = manifest.shards[i];
      const r2Info = r2Results[i];
      const localPath = path.join(PROTECTED_FONTS_DIR, shardInfo.filename);
      const localExists = existsSync(localPath);
      const localSha256 = localExists ? sha256(readFileSync(localPath)) : "ABSENT (loss recovery)";

      const pass = r2Info.sha256 === shardInfo.sha256 && (!localExists || r2Info.sha256 === localSha256) && r2Info.size === shardInfo.bytes;
      if (!pass) r2Match = false;

      console.log(
        `${shardInfo.filename.padEnd(20)} | ${shardInfo.sha256.padEnd(64)} | ${localSha256.padEnd(64)} | ${r2Info.sha256.padEnd(64)} | ${r2Info.size.toString().padEnd(10)} | ${pass ? "✅ 3-WAY MATCH" : "❌ MISMATCH"}`,
      );
    }
    console.log("=" .repeat(235));
    if (!r2Match) {
      console.error("❌ Three-way mismatch detected on R2 live fonts!");
      process.exit(1);
    }
  }

  if (!allMatch) {
    console.error("\n❌ BUILD FAILED: Regenerated shards differ from manifest/disk!");
    process.exit(1);
  }

  console.log("\n🎉 SUCCESS: All 8 TW-Kai font shards are 100% byte-identical and deterministically reproduced!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
