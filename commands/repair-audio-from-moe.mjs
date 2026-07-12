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
 *   node commands/repair-audio-from-moe.mjs --all --mp3-only        # 全部缺 = 的 t 詞條
 *   node commands/repair-audio-from-moe.mjs --all --mp3-only --limit=200
 *                                                                    # 小批量測速/命中率
 *
 * MP3-only 是現行模式：MOE 只需下載/上傳 MP3；歷史 OGG fallback 不再轉檔或寫入。
 * 刻意保守：MOE 是小型政府網站不是 CDN，請用適度 concurrency 與 R2 rate limit，
 * 不對它做無界並發轟炸。
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
const CONCURRENCY = args.concurrency ? Number(args.concurrency) : 5;
const DELAY_MS = args['delay-ms'] ? Number(args['delay-ms']) : 300;
const MP3_ONLY = !!args['mp3-only'];
// 這支腳本跟主遷移腳本（migrate-legacy-cdn-to-r2.mjs）共用同一個 Cloudflare
// 帳號的 R2 write 額度；MP3-only 模式避免無必要的第二次 OGG PUT。
const R2_RATE_LIMIT = args['r2-rate-limit'] ? Number(args['r2-rate-limit']) : 300;
const R2_RATE_WINDOW_MS = 300000;

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

/** 帶 timeout 的 fetch，避免單一卡住的請求把整個 worker 卡死。 */
async function fetchWithTimeout(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function searchSutian(word) {
  const url = `${SUTIAN_BASE}/zh-hant/tshiau/?lui=tai_su&tsha=${encodeURIComponent(word)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`sutian search HTTP ${res.status}`);
  const html = await res.text();
  return extractAudioPathForExactMatch(html, word);
}

// 平滑限流：用最小間隔而非「視窗內配額用完才擋」，避免大量並發時整批衝進
// 配額、接著所有 worker 一起卡在同一個「等最舊時間戳過期」上（實測會卡到
// 近 5 分鐘沒有任何進度，看起來像卡死，其實只是限流器設計不好）。
const MIN_R2_WRITE_INTERVAL_MS = R2_RATE_WINDOW_MS / R2_RATE_LIMIT;
let nextR2WriteSlot = 0;
async function throttleR2Write() {
  const myLot = Math.max(nextR2WriteSlot, Date.now());
  nextR2WriteSlot = myLot + MIN_R2_WRITE_INTERVAL_MS;
  const wait = myLot - Date.now();
  if (wait > 0) await sleep(wait);
}

function isRateLimited(text) {
  return /429|rate.?limit|Too Many Requests|error code:?\s*971/i.test(text || '');
}

let globalCooldownUntil = 0;

function putToR2Once(r2Key, bytes, contentType) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      WRANGLER_BIN,
      ['r2', 'object', 'put', `${BUCKET}/${r2Key}`, '--pipe', '--remote', `--content-type=${contentType}`, '--cache-control=public, max-age=31536000, immutable'],
      { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 30000);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => { clearTimeout(killTimer); reject(e); });
    child.on('close', (code) => { clearTimeout(killTimer); resolve(code === 0 ? { ok: true } : { ok: false, stderr }); });
    child.stdin.write(bytes);
    child.stdin.end();
  });
}

/** 帶限流與 429 退避重試的 R2 上傳；呼應主遷移腳本同款邏輯。 */
async function putToR2(r2Key, bytes, contentType) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const now = Date.now();
    if (now < globalCooldownUntil) await sleep(globalCooldownUntil - now);
    await throttleR2Write();
    const res = await putToR2Once(r2Key, bytes, contentType);
    if (res.ok) return res;
    if (isRateLimited(res.stderr)) {
      const cooldown = Math.min(30000 * 2 ** attempt, 5 * 60 * 1000);
      globalCooldownUntil = Date.now() + cooldown;
      console.error(`[rate-limit] R2 429，退避 ${cooldown}ms（${r2Key}）`);
      continue;
    }
    if (attempt === 4) return res;
    await sleep(1000 * 2 ** attempt);
  }
}

function transcodeToOgg(mp3Buf) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '2', '-c:a', 'vorbis', '-strict', '-2', '-q:a', '4', '-f', 'ogg', 'pipe:1'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 20000);
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => { clearTimeout(killTimer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 300)}`));
    });
    child.stdin.write(mp3Buf);
    child.stdin.end();
  });
}

async function processOne(target, idx, total, stats) {
  try {
    const audioPath = await searchSutian(target.title);
    if (!audioPath) {
      recordProgress({ id: target.id, title: target.title, status: 'not-found-on-moe' });
      stats.notFoundOnMoe++;
      console.log(`[${idx + 1}/${total}] ${target.title} (${target.id}): MOE 也沒有`);
      return;
    }
    const audioRes = await fetchWithTimeout(`${SUTIAN_BASE}${audioPath}`);
    if (!audioRes.ok) throw new Error(`audio fetch HTTP ${audioRes.status}`);
    const buf = Buffer.from(await audioRes.arrayBuffer());

    // mp3 上傳跟 ogg 轉檔+上傳互不依賴（都只需要 buf），平行跑省一次 R2
    const mp3Task = putToR2(`audio/t/${target.id}.mp3`, buf, 'audio/mpeg');
    let put;
    let oggResult = { ok: true, bytes: 0 };
    if (MP3_ONLY) {
      put = await mp3Task;
    } else {
      const oggTask = transcodeToOgg(buf)
        .then((oggBuf) => putToR2(`audio/t/${target.id}.ogg`, oggBuf, 'audio/ogg').then((r) => ({ ...r, bytes: oggBuf.length })))
        .catch((oggErr) => ({ ok: false, stderr: String(oggErr) }));
      [put, oggResult] = await Promise.all([mp3Task, oggTask]);
    }
    if (!put.ok) throw new Error(`R2 put failed: ${put.stderr?.slice(0, 200)}`);
    const oggBytes = oggResult.ok ? oggResult.bytes : 0;
    if (!oggResult.ok) console.error(`  (ogg 失敗，mp3 已成功: ${oggResult.stderr?.slice(0, 150)})`);

    recordProgress({ id: target.id, title: target.title, status: 'uploaded', moePath: audioPath, bytes: buf.length, oggBytes });
    stats.uploaded++;
    console.log(`[${idx + 1}/${total}] ${target.title} (${target.id}): 已修補，來源=${audioPath}，mp3=${buf.length}B ogg=${oggBytes}B`);
  } catch (e) {
    recordProgress({ id: target.id, title: target.title, status: 'failed', error: String(e) });
    stats.failed++;
    console.error(`[${idx + 1}/${total}] ${target.title} (${target.id}): 失敗 ${e}`);
  }
  await sleep(DELAY_MS);
}

async function main() {
  if (!ALL && wordArgs.length === 0) {
    console.error('用法: node commands/repair-audio-from-moe.mjs <詞目...> 或 --all [--limit=N] [--concurrency=5]');
    process.exit(1);
  }
  let targets = findMissingAudioIdEntries(ALL ? null : wordArgs);
  console.log(`候選：${targets.length} 個缺 audio_id 的 t 詞條`);

  const done = loadProgress();
  targets = targets.filter((t) => !done.has(t.id));
  console.log(`跳過已處理 ${done.size} 筆；剩餘 ${targets.length} 筆（concurrency=${CONCURRENCY}, R2 rate=${R2_RATE_LIMIT}/${R2_RATE_WINDOW_MS}ms）`);
  if (Number.isFinite(LIMIT)) targets = targets.slice(0, LIMIT);

  const stats = { uploaded: 0, notFoundOnMoe: 0, failed: 0 };
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const idx = cursor++;
      await processOne(targets[idx], idx, targets.length, stats);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log('=== 完成 ===', stats);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
