#!/usr/bin/env node
/**
 * 修補 moedict-webkit#270：台語（t）詞條缺少真正 audio_id（`=`）時，前端會退回
 * 用詞條自己的資料庫 id（`_`）當作猜測的音檔檔名（DictionaryPage.tsx:618），
 * 但這個猜測從未對應到 Rackspace 上的真實檔案（見 README_CDN.md「資料完整性」）。
 *
 * 本工具改從教育部臺灣台語常用詞辭典（sutian.moe.edu.tw，現行上游，比 2013/2019
 * 的 Rackspace 快照新）搜尋詞目、取得真正音檔，上傳到「前端本來就會嘗試」的同一個
 * R2 key（audio/t/{該詞條的 _ id}.mp3）——不需要改任何前端程式碼，音檔一到位
 * 現有的 fallback 邏輯就會自動撿到。
 *
 * sutian 的內部 id 與 pack 資料裡的 `_`（twblg n_no）是兩套不同編號，不能重用，
 * 必須用詞目文字搜尋比對。
 *
 * 用法：
 *   node commands/repair-audio-from-moe.mjs 花眉 王梨酥 靴管        # 指定詞目
 *   node commands/repair-audio-from-moe.mjs --all                  # 全部缺 = 的 t 詞條（19k+，會很久，未經速率測試，預設不做）
 *   node commands/repair-audio-from-moe.mjs --all --limit=200      # 全部裡的前 200 筆，用於抓速率/命中率
 *
 * 刻意保守：MOE 是小型政府網站不是 CDN，預設序列（concurrency=1）+ 每筆間隔，
 * 不對它做並發轟炸。
 */
import { readdirSync, readFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE_DIR = join(REPO_ROOT, '.migration-state');
const PROGRESS_FILE = join(STATE_DIR, 'moe-audio-repair-progress.ndjson');
const BUCKET = 'moedict-assets';
const WRANGLER_BIN = join(REPO_ROOT, 'node_modules/.bin/wrangler');
const SUTIAN_BASE = 'https://sutian.moe.edu.tw';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const wordArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ALL = !!args.all;
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const DELAY_MS = args['delay-ms'] ? Number(args['delay-ms']) : 1200;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findMissingAudioIdEntries(onlyWords) {
  const fullDir = join(REPO_ROOT, 'data/dictionary/ptck');
  const files = readdirSync(fullDir).filter((f) => f.endsWith('.txt'));
  const wordSet = onlyWords ? new Set(onlyWords) : null;
  const out = [];
  for (const f of files) {
    const text = readFileSync(join(fullDir, f), 'utf8');
    let obj;
    try { obj = JSON.parse(text); } catch { continue; }
    for (const key of Object.keys(obj)) {
      const entry = obj[key];
      const plainTitle = String(entry?.t || '').replace(/[`~]/g, '');
      if (wordSet && !wordSet.has(plainTitle)) continue;
      const het = Array.isArray(entry?.h) ? entry.h : [];
      for (const h of het) {
        if (h['=']) continue; // 已有真正 audio_id，不需要修補
        if (!h['_']) continue;
        out.push({ title: plainTitle, id: String(h['_']) });
      }
    }
  }
  return out;
}

function loadProgress() {
  const done = new Set();
  if (existsSync(PROGRESS_FILE)) {
    for (const line of readFileSync(PROGRESS_FILE, 'utf8').split('\n').filter(Boolean)) {
      try {
        const rec = JSON.parse(line);
        if (rec.status === 'uploaded' || rec.status === 'not-found-on-moe') done.add(rec.id);
      } catch { /* skip */ }
    }
  }
  return done;
}
mkdirSync(STATE_DIR, { recursive: true });
function recordProgress(rec) {
  appendFileSync(PROGRESS_FILE, JSON.stringify(rec) + '\n');
}

/** 從 sutian 搜尋結果 HTML 抓「完全符合」詞目對應的第一個 data-src 音檔路徑。 */
function extractAudioPathForExactMatch(html, word) {
  // 逐一掃描 <a href="/zh-hant/su/{id}/">{word}</a> ... 後面最近一個 data-src="[...]"
  const linkRe = new RegExp(`<a href="/zh-hant/su/(\\d+)/">\\s*${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</a>`, 'g');
  const linkMatch = linkRe.exec(html);
  if (!linkMatch) return null;
  const afterLink = html.slice(linkMatch.index);
  const dataSrcMatch = afterLink.match(/data-src="(\[?&quot;)?([^"&]+\.mp3)/);
  if (!dataSrcMatch) return null;
  return dataSrcMatch[2];
}

async function searchSutian(word) {
  const url = `${SUTIAN_BASE}/zh-hant/tshiau/?lui=tai_su&tsha=${encodeURIComponent(word)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sutian search HTTP ${res.status}`);
  const html = await res.text();
  return extractAudioPathForExactMatch(html, word);
}

function putToR2(r2Key, bytes, contentType) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      WRANGLER_BIN,
      ['r2', 'object', 'put', `${BUCKET}/${r2Key}`, '--pipe', '--remote', `--content-type=${contentType}`, '--cache-control=public, max-age=31536000, immutable'],
      { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ ok: true }) : resolve({ ok: false, stderr })));
    child.stdin.write(bytes);
    child.stdin.end();
  });
}

async function main() {
  if (!ALL && wordArgs.length === 0) {
    console.error('用法: node commands/repair-audio-from-moe.mjs <詞目...> 或 --all [--limit=N]');
    process.exit(1);
  }
  let targets = findMissingAudioIdEntries(ALL ? null : wordArgs);
  console.log(`候選：${targets.length} 個缺 audio_id 的 t 詞條`);

  const done = loadProgress();
  targets = targets.filter((t) => !done.has(t.id));
  console.log(`跳過已處理 ${done.size} 筆；剩餘 ${targets.length} 筆`);
  if (Number.isFinite(LIMIT)) targets = targets.slice(0, LIMIT);

  const stats = { uploaded: 0, notFoundOnMoe: 0, failed: 0 };
  for (const [i, target] of targets.entries()) {
    try {
      const audioPath = await searchSutian(target.title);
      if (!audioPath) {
        recordProgress({ id: target.id, title: target.title, status: 'not-found-on-moe' });
        stats.notFoundOnMoe++;
        console.log(`[${i + 1}/${targets.length}] ${target.title} (${target.id}): MOE 也沒有`);
      } else {
        const audioRes = await fetch(`${SUTIAN_BASE}${audioPath}`);
        if (!audioRes.ok) throw new Error(`audio fetch HTTP ${audioRes.status}`);
        const buf = Buffer.from(await audioRes.arrayBuffer());
        const put = await putToR2(`audio/t/${target.id}.mp3`, buf, 'audio/mpeg');
        if (!put.ok) throw new Error(`R2 put failed: ${put.stderr.slice(0, 200)}`);
        recordProgress({ id: target.id, title: target.title, status: 'uploaded', moePath: audioPath, bytes: buf.length });
        stats.uploaded++;
        console.log(`[${i + 1}/${targets.length}] ${target.title} (${target.id}): 已修補，來源=${audioPath}，${buf.length} bytes`);
      }
    } catch (e) {
      recordProgress({ id: target.id, title: target.title, status: 'failed', error: String(e) });
      stats.failed++;
      console.error(`[${i + 1}/${targets.length}] ${target.title} (${target.id}): 失敗 ${e}`);
    }
    await sleep(DELAY_MS);
  }
  console.log('=== 完成 ===', stats);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
