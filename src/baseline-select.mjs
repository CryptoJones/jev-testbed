// Faithful copy of LibraryRetriever's current heuristic selection, so the
// comparison is apples-to-apples. The matching/scoring logic below is lifted
// verbatim from ../LibraryRetriever/batch-retrieve.mjs (evaluateCandidates,
// getSearchQuery, parseSizeMb, and the extractCandidates pre-filters). Only the
// shared helpers are imported from the untouched LibraryRetriever repo.
import {
  normalize,
  tokenize,
  splitTitle,
  titleMatches,
  authorSurnames,
  stripAuthorNoise,
  isCompanionVolume,
  wantsCompanionVolume,
  filterEnglish
} from '../../LibraryRetriever/lib/zlib-common.mjs';

// --- verbatim from batch-retrieve.mjs -------------------------------------
function parseSizeMb(raw) {
  const m = String(raw || '').match(/([\d.]+)\s*(KB|MB|GB)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  return unit === 'KB' ? n / 1024 : unit === 'GB' ? n * 1024 : n;
}

export function getSearchQuery(item) {
  const coreTitle = splitTitle(item.title).core
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const [firstAuthor = ''] = stripAuthorNoise(item.author).split(/,|\band\b|&|;/i);
  const authorLast = firstAuthor.trim().split(/\s+/).pop() || '';
  return `${coreTitle} ${authorLast}`.trim();
}

function evaluateCandidates(candidates, item, queryTokens) {
  const want = splitTitle(item.title);
  const coreTokens = tokenize(want.core);
  const wantEdition = normalize(want.edition);
  const companionWanted = wantsCompanionVolume(`${item.title} ${item.meta}`);
  const authors = authorSurnames(item.author);

  const valid = [];

  for (const cand of candidates) {
    const candTitle = normalize(cand.title);
    const candAuthor = normalize(cand.author);
    const candAll = `${candTitle} ${candAuthor} ${normalize(cand.publisher)}`;

    if (!titleMatches(item.title, cand.title)) continue;
    if (!companionWanted && isCompanionVolume(cand.title)) continue;
    if (authors.length > 0 && !authors.some((a) => candAll.includes(a))) continue;

    let titleMatchCount = 0;
    for (const t of coreTokens) {
      if (candTitle.includes(t)) titleMatchCount++;
    }
    const titleRatio = coreTokens.length ? titleMatchCount / coreTokens.length : 1;

    let queryMatches = 0;
    for (const token of queryTokens) {
      if (candAll.includes(normalize(token))) queryMatches++;
    }
    const queryRatio = queryTokens.length ? queryMatches / queryTokens.length : 0;

    const candEdition = normalize(splitTitle(cand.title).edition);
    const editionBonus = wantEdition && candEdition === wantEdition ? 0.05 : 0;

    valid.push({
      ...cand,
      titleRatio,
      queryRatio,
      editionBonus,
      score: titleRatio * 0.6 + queryRatio * 0.4 + editionBonus
    });
  }

  if (!valid.length) return null;

  valid.sort((a, b) => b.score - a.score);
  const bestScore = valid[0].score;
  const pool = valid.filter((v) => v.score >= bestScore * 0.85);

  return pool.find((r) => r.ext === 'epub') || pool.find((r) => r.ext === 'pdf') || pool[0];
}
// --------------------------------------------------------------------------

/**
 * Run the production selection path against an already-scraped candidate list:
 * the same size cap + English filter extractCandidates applies, then the
 * evaluateCandidates scorer.
 */
export function baselineSelect(item, candidates, { maxSizeMb = 150 } = {}) {
  const sized = candidates.filter((r) => {
    const mb = parseSizeMb(r.size);
    return !(mb !== null && mb > maxSizeMb);
  });
  const pool = filterEnglish(sized);
  const chosen = evaluateCandidates(pool, item, tokenize(getSearchQuery(item)));
  return chosen || null;
}
