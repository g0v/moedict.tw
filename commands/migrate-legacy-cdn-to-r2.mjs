#!/usr/bin/env node
/**
 * 一次性資料遷移：把 Rackspace Cloud Files 上的筆畫 JSON 與發音音檔遷移到
 * Cloudflare R2（moedict-assets bucket），取代舊版 rackcdn.com CDN。
 *
 * 背景：這批資料原生於 moedict-webkit（main.ls http-map），從未進到本 repo
 * 的 R2 pipeline，見 README_CDN.md、memory/MEMORY.md。
 *
 * 物件 key 集合直接從 data/dictionary/{pack,ptck,phck,pcck} 現有 pack 資料
 * 推導（複刻 src/components/StrokeAnimation.tsx 的 extractStrokeWords()、
 * src/utils/audio-utils.ts 的 normalizeAudioIdByLang()、
 * src/pages/DictionaryPage.tsx 的 parseHakkaReadings() 邏輯），只遷移「網站
 * 實際會請求」的物件，不對 Rackspace 做未授權的 bucket listing。
 *
 * 注意一：`h`（客語）字典的「純」audio_id（不帶腔調前綴）在 Rackspace 上不存在
 * ——DictionaryPage.tsx 對 lang==='h' 一律把 pronunAudioId 設為 undefined，
 * 實際播放的是 `{variant}-{audioId}.ogg`/`.mp3`（見 getHakkaVariantAudioUrl /
 * parseHakkaReadings）。經抽樣驗證（0/20 純 h 命中 vs 30/30 腔調組合命中），
 * 純 h audio_id 這個分類故意不遷移。
 *
 * 注意二：每個音檔 id 有 .ogg（2013）與 .mp3（2019 補上）兩種副檔名，
 * playAudioUrl() 一律先試 .mp3 再退回 .ogg（見 audio-utils.ts
 * buildAudioCandidates()），兩種都要遷移。
 *
 * 用法：
 *   node commands/migrate-legacy-cdn-to-r2.mjs [--report-only] [--limit=N]
 *     [--concurrency=8] [--categories=stroke,audio-a-ogg,audio-a-mp3,
 *       audio-t-ogg,audio-t-mp3,audio-h-variant-ogg,audio-h-variant-mp3]
 *     [--rate-limit=900] [--rate-window-ms=300000]
 *
 * 可重複執行（idempotent）：進度記錄在
 * .migration-state/legacy-cdn-progress.ndjson，已成功或已確認 404 的 key
 * 會被跳過；因暫時性錯誤失敗的 key 下次執行會重試。
 */
import { readdirSync, readFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE_DIR = join(REPO_ROOT, '.migration-state');
const PROGRESS_FILE = join(STATE_DIR, 'legacy-cdn-progress.ndjson');
const BUCKET = 'moedict-assets';
const WRANGLER_BIN = join(REPO_ROOT, 'node_modules/.bin/wrangler');

const HOSTS = {
  stroke: 'https://829091573dd46381a321-9e8a43b8d3436eaf4353af683c892840.ssl.cf1.rackcdn.com',
  a: 'https://203146b5091e8f0aafda-15d41c68795720c6e932125f5ace0c70.ssl.cf1.rackcdn.com',
  t: 'https://1763c5ee9859e0316ed6-db85b55a6a3fbe33f09b9245992383bd.ssl.cf1.rackcdn.com',
  h: 'https://a7ff62cf9d5b13408e72-351edcddf20c69da65316dd74d25951e.ssl.cf1.rackcdn.com',
};

const LANG_DIRS = { a: 'pack', t: 'ptck', h: 'phck', c: 'pcck' };

// ---- CLI args ----
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const CONCURRENCY = args.concurrency ? Number(args.concurrency) : 8;
const REPORT_ONLY = !!args['report-only'];
const CATEGORY_FILTER = args.categories ? String(args.categories).split(',') : null;
const RATE_LIMIT = args['rate-limit'] ? Number(args['rate-limit']) : 900;
const RATE_WINDOW_MS = args['rate-window-ms'] ? Number(args['rate-window-ms']) : 5 * 60 * 1000;

// ---- 複刻 src/components/StrokeAnimation.tsx 的 extractStrokeWords() ----
function extractStrokeWords(input) {
  const plain = String(input || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  const withoutParen = plain.replace(/[（(].*/, '').trim();
  return Array.from(withoutParen)
    .filter((ch) => /\p{Script=Han}/u.test(ch))
    .join('');
}

// ---- 複刻 src/utils/audio-utils.ts 的 normalizeAudioIdByLang() ----
function normalizeAudioIdByLang(lang, audioId) {
  const normalized = String(audioId || '').trim();
  if (!normalized) return '';
  if (lang !== 't') return normalized;
  if (/^\d{1,4}$/.test(normalized)) return normalized.padStart(5, '0');
  return normalized;
}

// ---- 複刻 src/pages/DictionaryPage.tsx 的 parseHakkaReadings() 腔調解析 ----
const DIALECT_ORDER = '四海大平安南';
const hakkaMatcher = () => /([四海大平安南])[\u20DE\u20DF](\S+)/g;

function buildManifest() {
  const strokeCps = new Set();
  const audioIds = { a: new Set(), t: new Set(), h: new Set() };
  const hakkaVariantKeys = new Set();

  for (const [lang, dir] of Object.entries(LANG_DIRS)) {
    const fullDir = join(REPO_ROOT, 'data/dictionary', dir);
    const files = readdirSync(fullDir).filter((f) => f.endsWith('.txt'));
    for (const f of files) {
      const text = readFileSync(join(fullDir, f), 'utf8');
      const obj = JSON.parse(text);
      for (const key of Object.keys(obj)) {
        const entry = obj[key];
        if (entry && typeof entry.t === 'string') {
          for (const ch of extractStrokeWords(entry.t)) strokeCps.add(ch.codePointAt(0).toString(16));
        }
        const heteronyms = Array.isArray(entry?.h) ? entry.h : [];
        for (const het of heteronyms) {
          const rawAudioId = het && het['='] ? String(het['=']) : '';
          if (!rawAudioId) continue;
          if (lang === 'a' || lang === 't' || lang === 'h') {
            audioIds[lang].add(normalizeAudioIdByLang(lang, rawAudioId));
          }
          if (lang === 'h') {
            const trs = String((het && (het['p'] ?? het['T'])) || '');
            const m = hakkaMatcher();
            let mm;
            while ((mm = m.exec(trs))) {
              const variant = DIALECT_ORDER.indexOf(mm[1]) + 1;
              if (variant > 0) hakkaVariantKeys.add(`${variant}-${rawAudioId}`);
            }
          }
        }
      }
    }
  }

  // 每個 lang host 對同一個 audioId 同時提供 .ogg（2013 年原始上傳）與 .mp3
  // （2019 年補上，iPad Safari ogg 支援不穩定時的備援，見 audio-utils.ts
  // buildAudioCandidates() 的註解）。playAudioUrl() 一律先試 .mp3 再退回
  // .ogg，所以兩種副檔名都要遷移，缺一個就會讓部分裝置播放失敗。
  // 佇列順序刻意依「client 端優先嘗試順序」與「流量權重」排列：
  // stroke（全語言共用，資料量小）→ a（華語/兩岸共用，流量最大）→
  // t（台語）→ h（客語腔調組合）；每個語言內先 mp3 後 ogg（對應
  // buildAudioCandidates() 的嘗試順序）。這讓「先跑到一半就要部署」時，
  // 覆蓋率集中在使用者實際會撞到的路徑，而不是雨露均霑但每個語言都殘缺。
  const AUDIO_EXTENSIONS = [
    { ext: 'mp3', contentType: 'audio/mpeg' },
    { ext: 'ogg', contentType: 'audio/ogg' },
  ];
  const AUDIO_LANGS = [
    { ids: audioIds.a, host: HOSTS.a, prefix: 'audio/a', catBase: 'audio-a' },
    { ids: audioIds.t, host: HOSTS.t, prefix: 'audio/t', catBase: 'audio-t' },
    { ids: hakkaVariantKeys, host: HOSTS.h, prefix: 'audio/h', catBase: 'audio-h-variant' },
  ];

  const tasks = [];
  for (const cp of strokeCps) {
    tasks.push({ cat: 'stroke', key: cp, url: `${HOSTS.stroke}/${cp}.json`, r2Key: `stroke-json/${cp}.json`, contentType: 'application/json' });
  }
  for (const { ids, host, prefix, catBase } of AUDIO_LANGS) {
    for (const { ext, contentType } of AUDIO_EXTENSIONS) {
      for (const id of ids) {
        tasks.push({ cat: `${catBase}-${ext}`, key: id, url: `${host}/${id}.${ext}`, r2Key: `${prefix}/${id}.${ext}`, contentType });
      }
    }
  }
  return tasks;
}

// ---- 進度紀錄（可重複執行）----
function loadProgress() {
  const done = new Set();
  if (existsSync(PROGRESS_FILE)) {
    const lines = readFileSync(PROGRESS_FILE, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec.status === 'ok' || rec.status === '404') done.add(`${rec.cat}:${rec.key}`);
      } catch {
        /* 忽略壞行 */
      }
    }
  }
  return done;
}

mkdirSync(STATE_DIR, { recursive: true });
function recordProgress(rec) {
  appendFileSync(PROGRESS_FILE, JSON.stringify(rec) + '\n');
}

// ---- R2 寫入限流：平滑最小間隔，而非「配額用完就整批卡住」----
// （視窗計數版本在高並發+快速上游時會整批衝進配額，接著所有 worker 一起卡在
// 「等最舊時間戳過期」上，卡到近 5 分鐘沒有任何進度、看起來像卡死——見
// repair-audio-from-moe.mjs 同款修法的註解，這裡是同一個 bug。）
// 呼應 AGENTS.md 記載的 ~1100 req/5min 帳號限制。
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
const MIN_WRITE_INTERVAL_MS = RATE_WINDOW_MS / RATE_LIMIT;
let nextWriteSlot = 0;
async function throttleR2Write() {
  const myLot = Math.max(nextWriteSlot, Date.now());
  nextWriteSlot = myLot + MIN_WRITE_INTERVAL_MS;
  const wait = myLot - Date.now();
  if (wait > 0) await sleep(wait);
}

// ---- wrangler r2 object put（stdin pipe，不落地暫存檔）----
let globalCooldownUntil = 0;
function putToR2(r2Key, bytes, contentType) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      WRANGLER_BIN,
      [
        'r2', 'object', 'put', `${BUCKET}/${r2Key}`,
        '--pipe', '--remote',
        `--content-type=${contentType}`,
        '--cache-control=public, max-age=31536000, immutable',
      ],
      { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, code, stderr, stdout });
    });
    child.stdin.write(bytes);
    child.stdin.end();
  });
}

function isRateLimited(text) {
  return /429|rate.?limit|Too Many Requests|error code:?\s*971/i.test(text || '');
}

async function fetchWithRetry(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) {
        // 上游偶爾對真實存在的物件回傳暫時性 404（實測案例：327200018.mp3
        // 首次 404，800ms 後重試穩定回 200）。連續兩次 404 才視為確認不存在，
        // 避免把暫時性錯誤誤記為物件不存在，漏遷移真實資料。
        await sleep(800);
        const confirmRes = await fetch(url);
        if (confirmRes.status === 404) return { status: 404 };
        if (!confirmRes.ok) throw new Error(`HTTP ${confirmRes.status}`);
        const buf = Buffer.from(await confirmRes.arrayBuffer());
        return { status: 200, buf };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return { status: 200, buf };
    } catch (e) {
      lastErr = e;
      await sleep(500 * 2 ** i);
    }
  }
  throw lastErr;
}

async function processTask(task, stats) {
  let dl;
  try {
    dl = await fetchWithRetry(task.url);
  } catch (e) {
    recordProgress({ cat: task.cat, key: task.key, status: 'failed', error: String(e) });
    stats.failed++;
    return;
  }
  if (dl.status === 404) {
    recordProgress({ cat: task.cat, key: task.key, status: '404' });
    stats.notFound++;
    return;
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    const now = Date.now();
    if (now < globalCooldownUntil) await sleep(globalCooldownUntil - now);
    await throttleR2Write();
    const put = await putToR2(task.r2Key, dl.buf, task.contentType);
    if (put.ok) {
      recordProgress({ cat: task.cat, key: task.key, status: 'ok', bytes: dl.buf.length });
      stats.uploaded++;
      stats.bytes += dl.buf.length;
      return;
    }
    if (isRateLimited(put.stderr) || isRateLimited(put.stdout)) {
      const cooldown = Math.min(30000 * 2 ** attempt, 5 * 60 * 1000);
      globalCooldownUntil = Date.now() + cooldown;
      stats.rateLimitHits++;
      console.error(`[rate-limit] backing off ${cooldown}ms after ${task.cat}:${task.key}`);
      continue;
    }
    console.error(`[r2-put-error] ${task.cat}:${task.key} attempt=${attempt} code=${put.code} stderr=${put.stderr.slice(0, 300)}`);
    await sleep(1000 * 2 ** attempt);
  }
  recordProgress({ cat: task.cat, key: task.key, status: 'failed', error: 'r2 put exhausted retries' });
  stats.failed++;
}

async function main() {
  console.log('Deriving manifest from data/dictionary ...');
  let tasks = buildManifest();
  const byCat = {};
  for (const t of tasks) byCat[t.cat] = (byCat[t.cat] || 0) + 1;
  console.log(`Manifest: ${tasks.length} candidate objects`, byCat);

  if (CATEGORY_FILTER) tasks = tasks.filter((t) => CATEGORY_FILTER.includes(t.cat));
  const done = loadProgress();
  const before = tasks.length;
  tasks = tasks.filter((t) => !done.has(`${t.cat}:${t.key}`));
  console.log(`Skipping ${before - tasks.length} already-processed; ${tasks.length} remaining`);
  if (Number.isFinite(LIMIT)) tasks = tasks.slice(0, LIMIT);

  if (REPORT_ONLY) {
    console.log('Report-only mode, exiting without network calls.');
    return;
  }

  const stats = { uploaded: 0, notFound: 0, failed: 0, bytes: 0, rateLimitHits: 0 };
  let idx = 0;
  const startTime = Date.now();

  async function worker() {
    while (idx < tasks.length) {
      const task = tasks[idx++];
      await processTask(task, stats);
      const totalDone = stats.uploaded + stats.notFound + stats.failed;
      if (totalDone % 200 === 0) {
        const elapsedS = (Date.now() - startTime) / 1000;
        console.log(
          `[progress] ${totalDone}/${tasks.length} | ok=${stats.uploaded} 404=${stats.notFound} failed=${stats.failed} | ${(stats.bytes / 1e6).toFixed(1)}MB | ${(totalDone / elapsedS).toFixed(2)}/s | rateLimitHits=${stats.rateLimitHits}`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log('=== DONE ===');
  console.log(stats);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
