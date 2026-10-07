# Manual test plan — leaderboard podium (share snippet + result card)

Covers the 2026-09-29 change: top-3 players get `🏆 1st in the World!` /
`🥈 2nd` / `🥉 3rd` from a single helper, rendered into both the result card
and the share snippet.

`tests/share_card.test.mjs` already pins the logic (25 tests, 7 mutations
proven to go red). **Do not repeat that here.** This plan is only for the
things a headless test cannot see: how the glyphs render on real platforms,
how the line wraps on a real phone, and whether the live Supabase path
behaves the way the stub assumes.

---

## Setup

```sh
cd "/Users/douglasweir/Desktop/Tubed Project"
python3 -m http.server 8000
```

Open **http://localhost:8000/index.html** — `file://` will not do, the
`today.json` and `puzzle-lookup.json` fetches are blocked there.

**Use a private/incognito window.** Progress lives in `localStorage`, and
testing means replaying today's puzzle repeatedly; incognito keeps your real
streak and history out of it.

Then paste the whole of `tests/manual/leaderboard-stub.js` into the console.

> ### Why the stub, and the trap it avoids
>
> Playing locally posts a **real row to the production board** — `puzzle_date`
> is today, which the RLS policy accepts. The `UNIQUE (puzzle_date, mode,
> player_id)` constraint then makes that row permanent, so your second test
> solve silently no-ops and you spend an hour wondering why the rank never
> moves.
>
> The stub swallows score POSTs from the moment it loads and invents the
> stats response. Everything else is real: `submitScore` →
> `loadLeaderboardStats` → `_leaderboardStatsCache` → `renderLeaderboardBlock`
> and `buildShareText`.
>
> **Install it before you press Submit.** Anything submitted earlier has
> already reached the live board.

---

## Run

Solve the puzzle once (any route — `diff` doesn't affect the podium) and
submit. Then drive the scenarios from the console without re-solving:

```js
lb({ my_rank: 2, top_pct: 2 })   // set scenario, repaints the card
lb.text()                        // prints the real snippet, your actual time
```

On desktop the Share button is hidden and **Copy to clipboard** is shown, so
the end-to-end check is: press Copy, paste somewhere. `lb.text()` is the
faster loop; the button is the thing that ships.

### Scenarios

Gates are `LB_MIN_PLAYERS = 5` and `LB_MAX_PCT = 50`. The anchor line
(`⏱ Typical optimal solve`) is independent of both and survives on its own
when the band is suppressed — so "no band" is not "empty card".

Expected values below were generated from the real code, not predicted.

| # | Console | Expected card | Expected snippet |
|---|---------|---------------|------------------|
| 1 | `lb()` | `📊 TOP 1% TODAY` · `🏆 1st in the World!` · anchor | `🏆 1st in the World!`, **no** `📊` line |
| 2 | `lb({my_rank:2, top_pct:2})` | `📊 TOP 2% TODAY` · `🥈 2nd in the World!` · anchor | `🥈 2nd in the World!` |
| 3 | `lb({my_rank:3, top_pct:3})` | `📊 TOP 3% TODAY` · `🥉 3rd in the World!` · anchor | `🥉 3rd in the World!` |
| 4 | `lb({my_rank:4, is_top3:false, top_pct:4})` | `📊 TOP 4% TODAY` · anchor, no podium | `📊 Top 4% today` |
| 5 | `lb({total_players:4, my_rank:1, top_pct:25})` | **anchor only** — board too small | no ranking line |
| 6 | `lb({total_players:5, my_rank:3, top_pct:60})` | **anchor only** | no ranking line |
| 7 | `lb({my_rank:60, is_top3:false, top_pct:51})` | **anchor only** — one point past the gate | no ranking line |
| 8 | `lb({total_players:5, my_rank:1, top_pct:50})` | `📊 TOP 50% TODAY` · `🏆 1st in the World!` · anchor | `🏆 1st in the World!` |
| 9 | `lb({optimal_count:2})` | band + podium, **anchor gone** (needs ≥3) | `🏆 1st in the World!` |
| 10 | `lb({is_top3:true, my_rank:9})` | band + anchor, **no podium** | `📊 Top 1% today` |

Three of these are worth pausing on:

- **#6 is a real board, not a contrived one.** On a 5-player day, 3rd place
  computes to `top_pct` 60, which is past `LB_MAX_PCT`, so a genuine podium
  finisher gets nothing. That is the existing percentile rule reaching
  through to the new line, and it is the most likely thing to get reported as
  a bug. Decide whether you are happy with it.
- **#8 is artificial.** The server derives `top_pct` as roughly
  `100 × rank / total`, so "1st of 5" would really be 20%, not 50%. The stub
  will happily set impossible combinations; this one exists to prove the
  boundary is inclusive, and `📊 TOP 50% TODAY` above `🏆 1st in the World!`
  is not a pairing a real board can produce.
- **#10 is the server/client disagreement case.** `is_top3` is computed in
  SQL, the rank range is checked in the client, and neither alone may promote
  a player.

To replay the puzzle from scratch: `lb.reset()` then reload (`lb.restore()`
puts your progress back). To stop: `lb.off()` — **live writes resume.**

---

## What to actually look at

The logic is already covered. These are the five things that are not:

1. **Glyph rendering in real paste targets.** Copy a top-3 snippet and paste
   into Reddit, WhatsApp, iMessage, Slack and X. `⁉️` (U+2049 U+FE0F) is the
   risk — the variation selector is what makes it an emoji, and some
   platforms drop it and render a flat text `⁉`. `🥈` and `🥉` are new to this
   snippet too. If `⁉️` looks wrong anywhere, that is a real finding: it is on
   every optimal share, not just podium ones.

2. **Wrapping on a narrow phone.** `🏆 1st in the World!` is longer than the
   `🏆 You're #1 today` it replaced, and `.lb-rank` is 12px inside the band.
   Check at 320px (iPhone SE) in device emulation — a two-line podium under a
   one-line band looks broken.

3. **Mobile share sheet.** On a real phone `navigator.share` is used instead
   of the clipboard. Confirm the line breaks survive it — some targets
   collapse `\n`.

4. **Both themes.** The band is tier-coloured (`tier-elite` at ≤1%); check the
   podium line's contrast against gold in dark and light.

5. **The known label mismatch.** With `lb()` active the button reads *"Copy
   your Top 1%"* while the snippet now says *1st in the World*. Still open —
   worth deciding once you see the two together.

---

## Then check the live path once

The stub proves everything except that the real RPC returns the shape the
client expects. With the stub **off**, in a normal (non-incognito) window,
solve and submit for real, then in DevTools → Network find `get_leaderboard_stats` and confirm the response
JSON carries `total_players`, `my_rank`, `top_pct`, `is_top3`,
`optimal_count`, `median_optimal_secs`. You will not see a podium (the real
board is small and you will not be top 3 on demand) — this step is only
confirming the contract, and it is the one thing the stub cannot vouch for.
