#!/usr/bin/env node
/**
 * real-test.mjs — run both selectors over REAL candidate lists for a WANTED.md
 * style list, and report where they agree and where they differ.
 *
 * Candidates come from Open Library's search API (catalogue metadata only —
 * nothing is downloaded), queried with the exact string LibraryRetriever's
 * getSearchQuery() would build. Lists are cached, so both selectors always see
 * identical input.
 *
 *   node real-test.mjs                    # run everything not yet in the results file
 *   node real-test.mjs --limit 25         # first 25 items only
 *   node real-test.mjs --baseline-only    # no Jev API calls
 *   node real-test.mjs --report           # summarize the results file, run nothing
 *   node real-test.mjs --replay           # re-apply the current selection policy to the
 *                                         # stored Jev probabilities (no API calls), then report
 *   node real-test.mjs --list wanted/x.md --out results/x.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselineSelect, getSearchQuery } from './src/baseline-select.mjs';
import { jevSelect, makeClient, choose } from './src/jev-select.mjs';
import { searchCandidates } from './src/openlibrary.mjs';
import { filterEnglish } from '../LibraryRetriever/lib/zlib-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);

const listFile = path.resolve(__dirname, opt('--list', 'wanted/ya-500.md'));
const outFile = path.resolve(__dirname, opt('--out', 'results/ya-500.jsonl'));
const cacheDir = path.join(__dirname, 'cache', 'openlibrary');
const limit = parseInt(opt('--limit', '500'), 10);
const concurrency = parseInt(opt('--concurrency', '4'), 10);
const baselineOnly = flag('--baseline-only');

// Same strict line format as LibraryRetriever's WANTED.md parser.
const ITEM_RE = /^- \[[ x]\] \*\*(.+?)\*\* — (.+?)(?:\s+\((.*)\))?$/;

function parseWanted(file) {
  const seen = new Set();
  const items = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(ITEM_RE);
    if (!m) continue;
    const key = `${m[1]}|${m[2]}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ title: m[1], author: m[2], meta: m[3] || '' });
  }
  return items;
}

// Latest row per item wins, so a retried error never double-counts.
function readResults() {
  if (!fs.existsSync(outFile)) return [];
  const latest = new Map();
  for (const line of fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    latest.set(`${r.wanted.title}|${r.wanted.author}`, r);
  }
  return [...latest.values()];
}

const slim = (c) => (c ? { id: c.id, title: c.title, author: c.author, year: c.year } : null);

async function withRetry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

async function runOne(client, item) {
  const query = getSearchQuery(item);
  const candidates = await searchCandidates(query, { cacheDir });
  const base = baselineSelect(item, candidates);

  const row = { wanted: item, query, nCandidates: candidates.length, baseline: slim(base) };
  if (!baselineOnly) {
    try {
      const res = await withRetry(() => jevSelect(client, item, filterEnglish(candidates)));
      row.jev = slim(res.chosen);
      row.judgments = res.judgments.map((j) => ({
        id: j.id, title: j.title, author: j.author,
        match: +j.match.toFixed(3), companion: +j.companion.toFixed(3)
      }));
      row.tokens = res.usage ? (res.usage.input_tokens || 0) + (res.usage.output_tokens || 0) : 0;
    } catch (err) {
      row.jevError = err.message;
    }
  }
  return row;
}

function report(rows) {
  const judged = rows.filter((r) => 'jev' in r);
  const same = judged.filter((r) => r.baseline && r.jev && r.baseline.id === r.jev.id);
  const bothNone = judged.filter((r) => !r.baseline && !r.jev);
  const onlyJev = judged.filter((r) => !r.baseline && r.jev);
  const onlyBase = judged.filter((r) => r.baseline && !r.jev);
  const differ = judged.filter((r) => r.baseline && r.jev && r.baseline.id !== r.jev.id);
  const errors = rows.filter((r) => r.jevError);
  const tokens = rows.reduce((n, r) => n + (r.tokens || 0), 0);

  console.log(`\nitems: ${rows.length}   judged by both: ${judged.length}   jev errors: ${errors.length}   tokens: ${tokens}`);
  console.log(`  same pick:            ${same.length}`);
  console.log(`  both picked nothing:  ${bothNone.length}`);
  console.log(`  only jev picked:      ${onlyJev.length}`);
  console.log(`  only baseline picked: ${onlyBase.length}`);
  console.log(`  different picks:      ${differ.length}`);

  const show = (label, list) => {
    if (!list.length) return;
    console.log(`\n── ${label} ──`);
    for (const r of list) {
      const p = (c) => (c ? `"${c.title}" — ${c.author || '?'} (${c.year || '?'})` : '∅');
      console.log(`${r.wanted.title} — ${r.wanted.author}`);
      console.log(`    baseline: ${p(r.baseline)}`);
      console.log(`    jev:      ${p(r.jev)}`);
    }
  };
  show('only jev picked', onlyJev);
  show('only baseline picked', onlyBase);
  show('different picks', differ);
  show('both picked nothing', bothNone);
}

async function main() {
  if (flag('--report')) return report(readResults().filter((r) => !r.searchError));
  if (flag('--replay')) {
    const rows = readResults().filter((r) => !r.searchError && r.judgments);
    let changed = 0;
    for (const r of rows) {
      const now = slim(choose(r.judgments));
      if ((now && now.id) !== (r.jev && r.jev.id)) {
        changed++;
        console.log(`changed: ${r.wanted.title}
    was: ${r.jev ? r.jev.title : '∅'}
    now: ${now ? now.title : '∅'}`);
      }
      r.jev = now;
    }
    console.log(`
${changed} pick(s) changed by the current policy`);
    return report(rows);
  }

  const items = parseWanted(listFile).slice(0, limit);
  const done = new Set(readResults().filter((r) => !r.jevError && !r.searchError).map((r) => `${r.wanted.title}|${r.wanted.author}`));
  const todo = items.filter((it) => !done.has(`${it.title}|${it.author}`));
  console.log(`${items.length} items in list, ${todo.length} to run`);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const client = baselineOnly ? null : makeClient();

  let next = 0;
  let finished = 0;
  async function worker() {
    while (next < todo.length) {
      const item = todo[next++];
      let row;
      try {
        row = await runOne(client, item);
      } catch (err) {
        row = { wanted: item, searchError: err.message };
      }
      fs.appendFileSync(outFile, JSON.stringify(row) + '\n');
      finished++;
      if (finished % 25 === 0 || finished === todo.length) console.log(`  ${finished}/${todo.length}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  report(readResults().filter((r) => !r.searchError));
}

main().catch((err) => {
  console.error('fatal:', err.message);
  process.exit(1);
});
