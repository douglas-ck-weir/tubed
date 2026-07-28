# Deploy checklist — platform-component wait fix

## What this change is
Reworked the wait-time model so lines only share a wait when they share a
physical platform (TfL per-platform data), fixing the "same route, different
score by line name" bug (Circle vs H&C at Edgware Road, and ~30 wrong merges the
earlier station-NaPTAN gate made).

## ⚠️ Deploy these files TOGETHER (atomically)
These are generated from the same code and must stay in sync on the site:

- `index.html`            (inlined WAIT_MINS + SCORING_VERSION=4 + PUZZLE_CACHE_KEY=v9)
- `puzzle-lookup.json`    (regenerated — 22 future puzzle pairs changed, see below)
- `today.json`

**Do NOT deploy `index.html` without `puzzle-lookup.json`** (or vice versa). They
were produced by the same `build-lookup.mjs` run, so together they are
consistent; split apart, the website's in-browser `todayPuzzle()` and the Reddit
bot (which fetches the live lookup) could disagree.

## Reddit bot impact (`~/daily-puzzle-e`)
- **No bot code change needed.** The bot fetches `puzzle-lookup.json` live from
  `https://www.playtubed.co.uk/puzzle-lookup.json` at post time.
- Once the new lookup is live on the site, the bot automatically posts the
  corrected pairs. Site + bot read the same file, so they stay in sync.
- The only failure mode is deploying `index.html` but serving a STALE
  `puzzle-lookup.json` from the site/CDN — then bot vs in-browser puzzle diverge.
  Confirm the CDN/cron actually serves the new lookup after deploy.

## Puzzle changes (why the lookup differs)
Re-scoring shifted which candidate pairs pass the difficulty filters:
- **22 of 134 future dates** now have different easy/hard start→end pairs.
- **Today (2026-07-28) and tomorrow (07-29) are UNCHANGED.**
- First changed date: **2026-07-30** — deploy before then to avoid a same-day
  swap that players/bot would notice mid-cycle.

## Post-deploy verification
1. `curl https://www.playtubed.co.uk/puzzle-lookup.json` → confirm it matches the
   repo's `puzzle-lookup.json` (spot-check 2026-07-30 hard = Dalston Kingsland →
   Royal Oak).
2. Load the live site, hard-refresh, confirm a route through Edgware Road scores
   Circle == H&C.
3. Bot: next scheduled post (or manual "Post today's Tubed puzzle") should match
   the site's puzzle for that day.
