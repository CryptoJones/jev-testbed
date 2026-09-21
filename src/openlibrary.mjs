// Candidate source for the real-world test: Open Library's public search API.
// Catalogue metadata only — there is nothing to download here. Each response is
// cached on disk so both selectors judge the exact same candidate list, and a
// re-run never re-hits the API.
import fs from 'node:fs';
import path from 'node:path';

const FIELDS = 'key,title,subtitle,author_name,first_publish_year,publisher,language,edition_count';
const USER_AGENT = 'jev-testbed/0.1 (book-selector research harness)';
const MIN_GAP_MS = 1000;

// Open Library uses MARC codes; the selectors' English filter looks for "english".
const LANG = { eng: 'english', spa: 'spanish', fre: 'french', ger: 'german', ita: 'italian', por: 'portuguese', rus: 'russian', chi: 'chinese', jpn: 'japanese' };

let lastCall = 0;
async function throttle() {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  lastCall = Math.max(Date.now(), lastCall + MIN_GAP_MS);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

function toCandidate(doc) {
  const langs = doc.language || [];
  const language = !langs.length ? '' : langs.includes('eng') ? 'english' : LANG[langs[0]] || langs[0];
  return {
    id: doc.key,
    title: doc.subtitle ? `${doc.title}: ${doc.subtitle}` : doc.title || '',
    author: (doc.author_name || []).join(', '),
    year: doc.first_publish_year ? String(doc.first_publish_year) : '',
    ext: '',
    size: '',
    language,
    publisher: (doc.publisher || []).slice(0, 3).join('; '),
    editions: doc.edition_count || 0
  };
}

export async function searchCandidates(query, { cacheDir, limit = 10, retries = 3 } = {}) {
  const cacheFile = cacheDir ? path.join(cacheDir, `${slug(query)}.json`) : null;
  if (cacheFile && fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));

  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=${limit}&fields=${FIELDS}`;
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    await throttle();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(45000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const candidates = ((await res.json()).docs || []).map(toCandidate);
      if (cacheFile) {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(candidates, null, 2));
      }
      return candidates;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  throw lastErr;
}
