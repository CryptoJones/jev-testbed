---
title: "Jev vs. the Regex Tower: Replacing an Inflexible Script with Typed Judgments"
date: 2026-09-20
tags: [jev, typesafe, llm, heuristics, tooling]
description: "I swapped a brittle string-matching scorer for two yes/no questions to a model, then ran both over 500 real catalogue searches. The script got 96% right. Jev got 99.4% — and the 20 cases in between are the interesting part."
---

I have a tool that searches a book catalogue and has to decide which search hit
is *the book I asked for*. For a long time that decision was made by a script:
normalize the titles, tokenize, count overlapping words, check the author's
surname appears somewhere, run a regex to throw out solutions manuals, then
blend it all into a score (`titleRatio * 0.6 + queryRatio * 0.4`, plus a 0.05
edition bonus, because of course).

It works. Mostly. And every time it doesn't, the fix is another regex.

The code for everything below is at
**[github.com/CryptoJones/jev-testbed](https://github.com/CryptoJones/jev-testbed)**.

## The problem with the script

The script isn't wrong so much as *inflexible*. It answers a question about
meaning — "is this the same work?" — using only string mechanics. A title that
ends in "…Solutions" slips past a regex that only knows "Solutions Manual". A
correct book with a blank author field gets rejected because the surname check
fails. I could patch both. I've patched things like them before. But each patch
is a new special case that will misfire on some other book next month.

## What I did instead

I put **Jev** (TypeSafe's System One model) in the loop — but only for the part
that is actually fuzzy. For each candidate, Jev gets two typed yes/no questions
in a single parallel request:

```js
questions[`match_${i}`] = noul(
  `Is \`candidates[${i}]\` the same work as the requested book \`wanted\`? ` +
  `A different edition, year, publisher, or format is STILL the same work.`,
  { true: 'The same work, in any edition or format',
    false: 'A different book, or only a companion volume' }
);
questions[`companion_${i}`] = noul(
  `Is \`candidates[${i}]\` a companion volume — a solutions manual, ` +
  `study guide, answer key — rather than the main text itself?`,
  { true: 'A companion / supplementary volume', false: 'The main text itself' }
);
```

Each answer comes back as a probability between 0 and 1. Not prose, not JSON I
have to parse and pray over — a number.

Everything that was already an exact rule **stays in code**: the language
filter, the size cap, the format preference, the thresholds (`match ≥ 0.6`,
`companion < 0.5`). The model doesn't get to have opinions about policy. It
only supplies the judgment the regexes were faking.

## The experiment: 500 real searches

Seven hand-built fixtures went 5/7 for the script and 7/7 for Jev, which proves
nothing except that I can write fixtures. So I built a real test.

- **The list:** 500 famous YA novels, from *Harry Potter* to *Iron Widow*. YA is
  a nice stress test: it is wall-to-wall series, box sets, movie tie-ins,
  graphic-novel adaptations, study guides and UK/US title changes.
- **The candidates:** for each book, the top 10 results from
  [Open Library's](https://openlibrary.org/developers/api) public search API,
  queried with the exact string the production tool builds. This is catalogue
  metadata only — nothing gets downloaded, because the question is *which hit
  would you pick*, and you don't need the file to answer that.
- **The pairing:** results are cached, so both selectors judge byte-identical
  candidate lists. Every disagreement was then adjudicated by hand.

## Results

```
same pick 433 · both nothing 10 · only Jev 8 · only script 6 · different 43

correct outcome:   script 480/500 (96.0%)    Jev 497/500 (99.4%)
discordant pairs:  Jev right 20, script right 3    (McNemar exact p ≈ 0.0005)
```

Thirty-four of the 43 "different picks" turned out to be duplicate catalogue
records of the same book — both right. What's left is 23 cases where exactly
one selector was correct, and they sort into neat piles.

**The script loves a box set (7).** Ask for *The Last Olympian* and it picks a
record titled *The Lightning Thief / The Sea of Monsters / The Titan's Curse /
The Battle of the Labyrinth / The Last Olympian* — the wanted title is right
there in the string, after all. Same for *The Hammer of Thor*, *Daughter of
Smoke & Bone* and *The Summer I Turned Pretty*. For *The Golden Compass* it
chose *The Golden Compass Graphic Novel, Volume 2*. Jev picked the actual
novel every time — in that last case a record called *Northern Lights*, which
shares zero words with the request and is exactly the right book.

**The script can't see through a title change (8).** *Harry Potter and the
Sorcerer's Stone* is catalogued as *Philosopher's Stone*. *Point Blank* is
*Point Blanc*. *Days of Blood & Starlight* is spelled with an "and". *Blue Lily,
Lily Blue* was typo'd as "Blue Lilly, Lilly Blue". Cornelia Funke's *Inkheart*
is filed under *Tintenherz*. The script returned nothing for all eight. Jev
matched every one.

**The script doesn't know when to walk away (5).** This was the pile I didn't
expect. Sometimes the book simply isn't in the results — and the script picks
*something* anyway:

| wanted | script picked | Jev's score for it |
|---|---|---|
| The 5th Wave | a three-book "Collection #1-3" | 0.26 |
| A Wind in the Door | *The Time Trilogy* omnibus | 0.37 |
| Octavian Nothing (vol. I) | Volume II | 0.24 |
| The Absolutely True Diary of a Part-Time Indian | an academic thesis *about* the novel | 0.04 |

Jev returned nothing for all of them, which is the right answer. A calibrated
"no" turns out to be worth as much as a confident "yes".

### Where Jev lost (3)

It's not a clean sweep, and the losses are instructive:

- ***Four* by Veronica Roth.** The right record — *Four: A Divergent
  Collection* — scored 0.38, under my 0.6 threshold. A one-word title plus the
  word "Collection" made Jev hedge. The script matched it fine.
- ***A Monster Calls* and *The Knife of Never Letting Go*.** Jev scored the
  English records 0.93–0.94 and a bilingual Spanish-edition record 0.96–0.97,
  and my code took the top score. That's not a judgment error — all of them
  *are* the same work, which is what I asked. It's a hole in **my** tie-break
  policy, which only knew how to prefer file formats. The fix is a few lines of
  code, not a prompt tweak — which is exactly the division of labour I wanted.
  (I've since made it: within a tie, English records beat foreign-looking ones.
  Because every probability is stored, I could replay all 500 decisions without
  a single API call — exactly those two picks changed, putting Jev at 499/500.
  That number is in-sample, since I wrote the rule after seeing the misses, so
  the headline stays at the as-run 497.)

One more bug surfaced that belongs to neither selector: six searches returned
zero results because the query builder turns `Tyrant's` into `Tyrant s`.
Running 500 real queries finds things seven fixtures never will.

## What it cost

1.18 million tokens for 500 lookups — about 2,400 per book, judging up to ten
candidates each with two questions. That's the honest trade: the script is free
and 96% right; Jev costs a little and is 99.4% right. The obvious hybrid is to
let the script handle the easy exact matches and only call Jev when the script
is unsure or about to pick something with "Collection" in the title.

## The takeaway

I didn't replace the script with a model. I replaced the *one part of the
script that was pretending to understand language*, and kept the rest. On 500
real searches that took the error count from 20 to 3, and every one of the
remaining three points at a concrete, fixable thing.

Caveats, because there are always caveats: this is one genre with unusually
clean metadata, Open Library's records carry no file formats so the
format-preference logic never fired, and the adjudication was a single pass
that nobody has independently double-checked. The harness, the list, and every
candidate with its probabilities are in the
[repo](https://github.com/CryptoJones/jev-testbed) (`results/ya-500.jsonl`) if
you want to check my work.

## Thanks

A big thank-you to the team at [TypeSafe](https://typesafe.io) for giving me
early access to Jev. None of this experiment would exist without it.
