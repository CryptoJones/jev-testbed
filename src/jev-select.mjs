import { TypeSafeClient, noul } from '@typesafe-ai/sdk';
import { loadApiKey } from './secret.mjs';

const DEFAULT_MODEL = process.env.JEV_MODEL || 'jev-latest';

// A candidate is "the book" if this is high AND it's not a companion volume.
const MATCH_THRESHOLD = 0.6;
const COMPANION_THRESHOLD = 0.5;
// Among matches, treat anything within this of the best as a tie so the
// EPUB > PDF format preference can pick within the tie (mirrors the baseline).
const TIE_BAND = 0.1;

export function makeClient() {
  if (!process.env.TYPESAFE_API_KEY) process.env.TYPESAFE_API_KEY = loadApiKey();
  return new TypeSafeClient();
}

/**
 * Ask Jev, in ONE parallel request over shared state, two yes/no judgments per
 * candidate: is it the same work as the wanted book, and is it a companion
 * volume. Code owns the policy (thresholds, format preference); the model only
 * supplies the semantic judgments the string heuristics were faking.
 */
export async function jevSelect(client, item, candidates, opts = {}) {
  const {
    model = DEFAULT_MODEL,
    matchThreshold = MATCH_THRESHOLD,
    companionThreshold = COMPANION_THRESHOLD
  } = opts;

  if (!candidates.length) return { chosen: null, judgments: [], usage: null };

  const state = {
    wanted: { title: item.title, author: item.author, note: item.meta || '' },
    candidates: candidates.map((c, i) => ({
      index: i,
      title: c.title,
      author: c.author,
      year: c.year || '',
      format: c.ext || '',
      publisher: c.publisher || '',
      language: c.language || ''
    }))
  };

  const questions = {};
  candidates.forEach((_, i) => {
    questions[`match_${i}`] = noul(
      `Is \`candidates[${i}]\` the same work as the requested book \`wanted\` — the same title by the same author? ` +
        `A different edition, year, publisher, translation, or file format is STILL the same work. ` +
        `A book that merely shares words in its title, or a companion/related volume, is NOT the same work.`,
      {
        true: 'The same work as `wanted`, in any edition or format',
        false: 'A different book, or only a companion/related volume'
      }
    );
    questions[`companion_${i}`] = noul(
      `Is \`candidates[${i}]\` a companion volume — a solutions manual, instructor's manual, answer key, ` +
        `student solutions, study guide, workbook, or teacher's edition — rather than the main text itself?`,
      {
        true: 'A companion / supplementary volume',
        false: 'The main text itself'
      }
    );
  });

  const res = await client.systemOne({ model, state, questions });

  const judgments = candidates.map((c, i) => ({
    ...c,
    match: res.answers[`match_${i}`].noul,
    companion: res.answers[`companion_${i}`].noul
  }));

  return { chosen: choose(judgments, { matchThreshold, companionThreshold }), judgments, usage: res.usage };
}

// A foreign-language edition IS the same work, so Jev rightly scores it as high
// as the English one — a 0.02 edge must not let it win. These catch editions
// whose catalogue language field is blank or wrong.
const FOREIGN_EDITION_RE = /\b(spanish|french|german|italian|portuguese|dutch|russian|chinese|japanese)\s+(edition|translation)\b|\bedici[oó]n\b|\b(en|em)\s+espa[nñ]ol\b/i;
// "Monstruo viene a verme / A Monster Calls" — a bilingual record title.
const BILINGUAL_TITLE_RE = /\s\/\s/;

export const looksForeign = (c) =>
  (!!c.language && !c.language.includes('english')) ||
  FOREIGN_EDITION_RE.test(c.title || '') ||
  BILINGUAL_TITLE_RE.test(c.title || '');

/**
 * The policy half, kept pure so stored judgments can be replayed without the
 * API. Within the tie band the scores are indistinguishable, so exact rules
 * decide: English before foreign-looking, EPUB before PDF, then best score.
 */
export function choose(judgments, opts = {}) {
  const { matchThreshold = MATCH_THRESHOLD, companionThreshold = COMPANION_THRESHOLD } = opts;

  const eligible = judgments
    .filter((j) => j.match >= matchThreshold && j.companion < companionThreshold)
    .sort((a, b) => b.match - a.match);
  if (!eligible.length) return null;

  const best = eligible[0].match;
  const tie = eligible.filter((j) => j.match >= best - TIE_BAND);
  const pool = tie.some((j) => !looksForeign(j)) ? tie.filter((j) => !looksForeign(j)) : tie;

  return pool.find((j) => j.ext === 'epub') || pool.find((j) => j.ext === 'pdf') || pool[0];
}
