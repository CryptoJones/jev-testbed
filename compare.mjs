#!/usr/bin/env node
/**
 * compare.mjs — run LibraryRetriever's heuristic selector and the Jev selector
 * over the same fixture cases and show, side by side, what each one picks.
 *
 *   node compare.mjs                 # run both (calls the Jev API)
 *   node compare.mjs --baseline-only # heuristic only, no API calls
 *   node compare.mjs --verbose       # also print Jev's per-candidate probabilities
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselineSelect } from './src/baseline-select.mjs';
import { jevSelect, makeClient } from './src/jev-select.mjs';
import { filterEnglish } from '../LibraryRetriever/lib/zlib-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const baselineOnly = argv.includes('--baseline-only');
const verbose = argv.includes('--verbose');
const MAX_SIZE_MB = 150;

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cases.json'), 'utf8'));

function parseSizeMb(raw) {
  const m = String(raw || '').match(/([\d.]+)\s*(KB|MB|GB)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  return unit === 'KB' ? n / 1024 : unit === 'GB' ? n * 1024 : n;
}

// The same metadata pre-filters the production scraper applies (size cap +
// English preference). Given to Jev too, because language/size are exact rules
// that belong in code — Jev is left to do only the fuzzy is-this-the-book work.
function prefilter(candidates) {
  const sized = candidates.filter((c) => {
    const mb = parseSizeMb(c.size);
    return !(mb !== null && mb > MAX_SIZE_MB);
  });
  return filterEnglish(sized);
}

function matchExpect(chosen, expect) {
  if (expect === null) return chosen === null;
  if (!chosen) return false;
  const title = String(chosen.title || '').toLowerCase();
  if (expect.titleIncludes && !title.includes(expect.titleIncludes.toLowerCase())) return false;
  if (expect.titleExcludes && title.includes(expect.titleExcludes.toLowerCase())) return false;
  if (expect.ext && String(chosen.ext).toLowerCase() !== expect.ext.toLowerCase()) return false;
  return true;
}

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const pick = (c) => (c ? `[${c.ext}] ${trunc(c.title, 30)}` : '∅ none');
const mark = (ok) => (ok ? '✓' : '✗');

async function run() {
  const client = baselineOnly ? null : makeClient();

  const W = { name: 24, res: 42 };
  console.log('');
  console.log(
    pad('case', W.name) + pad('baseline (heuristic)', W.res) + (baselineOnly ? '' : 'jev (TypeSafe)')
  );
  console.log('─'.repeat(baselineOnly ? W.name + W.res : W.name + W.res * 2));

  let baseOk = 0;
  let jevOk = 0;
  let tokens = 0;

  for (const c of cases) {
    const raw = c.candidates;

    const basePick = baselineSelect(c.wanted, raw, { maxSizeMb: MAX_SIZE_MB });
    const baseHit = matchExpect(basePick, c.expect);
    if (baseHit) baseOk++;

    let jevCell = '';
    let jevRes = null;
    if (!baselineOnly) {
      try {
        jevRes = await jevSelect(client, c.wanted, prefilter(raw));
        const jevHit = matchExpect(jevRes.chosen, c.expect);
        if (jevHit) jevOk++;
        if (jevRes.usage) tokens += (jevRes.usage.input_tokens || 0) + (jevRes.usage.output_tokens || 0);
        jevCell = `${mark(jevHit)} ${pick(jevRes.chosen)}`;
      } catch (err) {
        jevCell = `! error: ${err.message}`;
      }
    }

    console.log(
      pad(c.name, W.name) + pad(`${mark(baseHit)} ${pick(basePick)}`, W.res) + jevCell
    );

    if (verbose && jevRes) {
      for (const j of jevRes.judgments) {
        console.log(
          '    ' +
            pad(`[${j.ext}] ${trunc(j.title, 42)}`, 50) +
            `match=${j.match.toFixed(2)}  companion=${j.companion.toFixed(2)}`
        );
      }
    }
  }

  console.log('─'.repeat(baselineOnly ? W.name + W.res : W.name + W.res * 2));
  const n = cases.length;
  console.log(`\nbaseline: ${baseOk}/${n} expected picks`);
  if (!baselineOnly) {
    console.log(`jev:      ${jevOk}/${n} expected picks   (${tokens} tokens used)`);
  }
  console.log('');
}

run().catch((err) => {
  console.error('fatal:', err.message);
  process.exit(1);
});
