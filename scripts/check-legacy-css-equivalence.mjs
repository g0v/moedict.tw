#!/usr/bin/env node
/**
 * Proves that the working-tree `data/assets/styles.css` is a lossless,
 * order-preserving reformat of a given git ref's version: every rule/
 * at-rule/declaration must appear in the SAME order with the SAME content
 * (selector text, and property+value+`!important` per declaration, in
 * original order). Comments are ignored (never affect rendering).
 *
 * This file is a legacy, hand-maintained CSS bundle (normalize.css +
 * Bootstrap 3 + Font Awesome 3 + moedict's own theme/result/radical rules)
 * where cascade ORDER is load-bearing — see the file's own header comment.
 * Reordering, merging "duplicate" selectors/declarations, or deleting
 * anything changes what actually renders even when it looks like a safe
 * cleanup. This check catches exactly that class of mistake; it does NOT
 * catch content additions/removals that were never meant to be no-ops (use
 * this to verify a *reformat*, not to gate every edit to this file).
 *
 * Run: `bun run check:css-equivalence [ref]` (ref defaults to HEAD)
 * Not wired into CI — this is a point-in-time proof tool for whoever next
 * reformats/reorganizes this file, not an every-PR gate (most edits to
 * legacy CSS are legitimate content changes, not reformats).
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CSS_PATH = path.join(REPO_ROOT, 'data', 'assets', 'styles.css');
const ref = process.argv[2] ?? 'HEAD';

function readGitVersion(gitRef) {
  return execSync(`git show ${gitRef}:data/assets/styles.css`, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

function normSel(sel) {
  return sel.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).join(',');
}
function declKey(d) {
  return `${d.prop.toLowerCase()}\u0000${d.value.replace(/\s+/g, ' ').trim()}\u0000${d.important ? '1' : '0'}`;
}

function flatten(container, path_, out) {
  let seq = 0;
  for (const node of container.nodes) {
    if (node.type === 'comment') continue;
    const here = `${path_}>${node.type}#${seq++}`;
    if (node.type === 'decl') {
      out.push({ path: here, kind: 'decl', key: declKey(node) });
    } else if (node.type === 'rule') {
      out.push({ path: here, kind: 'rule-open', key: normSel(node.selector) });
      flatten(node, here, out);
      out.push({ path: here, kind: 'rule-close', key: normSel(node.selector) });
    } else if (node.type === 'atrule') {
      const key = `${node.name}\u0000${(node.params || '').replace(/\s+/g, ' ').trim()}`;
      out.push({ path: here, kind: 'atrule-open', key });
      if (node.nodes) flatten(node, here, out);
      out.push({ path: here, kind: 'atrule-close', key });
    } else {
      throw new Error(`unhandled node type during flatten: ${node.type}`);
    }
  }
}

let oldCss;
try {
  oldCss = readGitVersion(ref);
} catch (err) {
  console.error(`[check-css-equivalence] could not read data/assets/styles.css at ref '${ref}': ${err.message}`);
  process.exit(1);
}
const newCss = readFileSync(CSS_PATH, 'utf-8');

const oldRoot = postcss.parse(oldCss, { from: `${ref}:data/assets/styles.css` });
const newRoot = postcss.parse(newCss, { from: CSS_PATH });

const oldSeq = [];
const newSeq = [];
flatten(oldRoot, '', oldSeq);
flatten(newRoot, '', newSeq);

let firstDivergence = -1;
const minLen = Math.min(oldSeq.length, newSeq.length);
for (let i = 0; i < minLen; i++) {
  if (oldSeq[i].kind !== newSeq[i].kind || oldSeq[i].key !== newSeq[i].key) {
    firstDivergence = i;
    break;
  }
}
if (firstDivergence === -1 && oldSeq.length !== newSeq.length) firstDivergence = minLen;

console.log(`[check-css-equivalence] ${ref}: ${oldSeq.length} semantic nodes; working tree: ${newSeq.length} semantic nodes`);

if (firstDivergence === -1) {
  console.log('[check-css-equivalence] PASS — every rule/at-rule/declaration matches in the same order with the same content.');
  process.exit(0);
}

console.error(`\n[check-css-equivalence] FAIL — divergence at semantic index ${firstDivergence}`);
const ctx = (seq, i) =>
  seq
    .slice(Math.max(0, i - 3), i + 4)
    .map((n, j) => `  [${i - 3 + j}] ${n.kind} ${JSON.stringify(n.key).slice(0, 120)}`)
    .join('\n');
console.error(`${ref} context:\n${ctx(oldSeq, firstDivergence)}`);
console.error(`working tree context:\n${ctx(newSeq, firstDivergence)}`);
process.exit(1);
