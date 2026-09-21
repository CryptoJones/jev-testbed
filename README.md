# jev-testbed

A sandbox for putting **Jev** (TypeSafe's System One model) into existing tooling,
starting with **LibraryRetriever's book-candidate selection** — and comparing it,
head to head, against the current heuristic scorer.

`LibraryRetriever` is **not modified**. This repo imports its shared helpers
(`../LibraryRetriever/lib/zlib-common.mjs`) read-only and re-implements its exact
`evaluateCandidates` logic as the baseline, so the comparison is apples-to-apples.

## The problem being tested

LibraryRetriever searches Z-Library, then `evaluateCandidates()` decides which
search hit is the requested book. That decision is a tower of regexes and token
overlap that keeps misfiring on questions that are really about *meaning*:

- companion volumes (solutions manuals, study guides) that slip past the regex
- correct books rejected because the catalogue's author field is blank/garbled
- one-word titles matching unrelated art/photography books
- author credits ("Foreword by…") hijacking the match

Jev replaces those string heuristics with two typed yes/no judgments per candidate
(`match` = same work? / `companion` = solutions manual?), each returning a
calibrated probability. **Code keeps the exact rules** (English + size filters,
EPUB-over-PDF preference, thresholds); Jev supplies only the semantic call.

## Layout

| File | Role |
|---|---|
| `src/jev-select.mjs` | Jev selector — one parallel `systemOne` request, a `match` + `companion` Noul per candidate, then code applies the format/threshold policy |
| `src/baseline-select.mjs` | LibraryRetriever's current heuristic, copied verbatim (helpers imported from the untouched repo) |
| `src/secret.mjs` | Reads `TYPESAFE_API_KEY` from the env, else from gopass (`pass show -o typesafe/api-key`) via Git Bash |
| `fixtures/cases.json` | Test cases modeling the documented failure modes (2 baseline misfires + 5 regression guards) |
| `compare.mjs` | Runs both selectors over the fixtures and prints a side-by-side table |
| `real-test.mjs` | Runs both selectors over a WANTED.md-style list using real Open Library search results (metadata only) |
| `src/openlibrary.mjs` | Open Library search client — throttled, disk-cached candidate lists |
| `wanted/ya-500.md` | The 500-YA-novel test list |
| `results/ya-500.jsonl` | Per-book picks and every per-candidate Jev probability from the 500 run |

## Run it

```sh
npm install                     # once

node compare.mjs                # run both (calls the Jev API)
node compare.mjs --verbose      # also print Jev's per-candidate probabilities
node compare.mjs --baseline-only  # heuristic only, no API calls
```

The API key is read from the gopass store entry `typesafe/api-key` (see the note
in `src/secret.mjs`); it is never hard-coded or written into the repo. Reads work
from **Git Bash** on this Windows host.

## Latest result

```
baseline: 5/7 expected picks
jev:      7/7 expected picks   (5515 tokens used)
```

Jev fixes both baseline failures — the companion-volume slip and the
missing-author rejection — with no regressions on the sanity cases.

## Real-world test — 500 YA novels (2026-09-20)

Write-up: [Jev vs. the Regex Tower](https://cryptojones.dev/jev-vs-the-regex-tower/) on cryptojones.dev.

`real-test.mjs` runs both selectors over `wanted/ya-500.md` using real candidate
lists from Open Library's search API (metadata only — nothing is downloaded),
queried with the exact string `getSearchQuery()` builds. Lists are cached in
`cache/`, rows land in `results/ya-500.jsonl`; `--report` re-prints the summary.

```
same pick 433 · both nothing 10 · only jev 8 · only baseline 6 · different 43
hand-adjudicated:  baseline 480/500 (96.0%)   jev 497/500 (99.4%)   1.18M tokens
discordant pairs:  jev right 20, baseline right 3   (McNemar exact p ≈ 0.0005)
```

- **Jev wins (20):** box sets / omnibuses / graphic-novel adaptations picked by
  the heuristic (7); alternate titles and spellings it can't see through —
  *Philosopher's Stone*, *Point Blanc*, `&` vs `and`, a catalogue typo, Funke's
  original-language records (8); and 5 lists where the book simply wasn't present
  and the heuristic grabbed an omnibus, a Volume II, or an academic thesis.
- **Baseline wins (3):** *Four* (Jev scored the right record 0.38, under the 0.6
  threshold), and two where Jev's top score went to a Spanish-edition record by
  0.02 — a tie-break policy gap in `jev-select.mjs`, not a judgment error.
  **Fixed since:** within the tie band, English records now beat foreign-looking
  ones. `node real-test.mjs --replay` re-applies the policy to the stored
  probabilities (no API calls): exactly those two picks change → Jev 499/500
  (in-sample, so the as-run 497 stays the headline).
- 34 of the 43 "different picks" are duplicate catalogue records of the same
  book — both right. 6 of the 10 "both nothing" got zero search results because
  the query builder turns `Tyrant's` into `Tyrant s`.

## Next

If the judgments hold up on real scraped candidate lists (not just fixtures), the
Jev selector can be dropped into `batch-retrieve.mjs` in place of
`evaluateCandidates` — behind a flag, so the heuristic stays as a fallback.
