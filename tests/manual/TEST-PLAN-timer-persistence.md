# Manual test plan — timer persistence (reload cannot reset the clock)

Covers the 2026-10-05 change: elapsed seconds are banked to `localStorage` per
mode per London day, so a mid-puzzle reload resumes the clock instead of
zeroing it. Previously a player could grind the route out slowly, reload,
redraw it from memory and submit a fake fast time — and `completion_secs` is
the leaderboard's first tiebreaker among everyone who matched the optimal
route, so that decided the podium.

`tests/timer_persistence.test.mjs` already pins the logic (30 assertions, all
proven to go red against `backups/index.html.pre-timer-persistence.2026-09-29.bak`
and against a mutant with `clearInterval` removed). A headless Chrome run also
confirmed the end-to-end exploit is closed: the old build submitted `0:03` for
10 seconds of play, the fixed build submits `0:10`.

**Do not repeat any of that here.** This plan is only for what a headless test
cannot see: whether the number on screen looks right to a human at real page
load speeds, how it behaves on a real phone, what happens with two tabs open,
and whether the midnight rollover does the right thing in a live page.

---

## Setup

```sh
cd "/Users/douglasweir/Desktop/Tubed Project"
python3 -m http.server 8000
```

Open **http://localhost:8000/index.html** — `file://` will not do. The
`today.json` and `puzzle-lookup.json` fetches are blocked there, and
`localStorage` on `file://` is not a dependable origin in Chrome, which is the
whole subject of this plan.

Use the dedicated browser described in the box below — its separate
`--user-data-dir` keeps your real streak and history out of the test, and it
cannot write to the live leaderboard. Note that a fresh profile starts with an
empty bank, which is itself one of the cases below (D4).

Avoid plain incognito for this plan: a new incognito session gets a new
`player_id`, so the UNIQUE constraint will not even deduplicate your test
submissions — every one creates another live row.

> ### The trap: submitting posts a REAL row to the production board
>
> Any Submit you press on a local server inserts into live Supabase —
> `puzzle_date` is today, which the RLS policy accepts, and `submitScore()`
> has no localhost guard. The `UNIQUE (puzzle_date, mode, player_id)`
> constraint then makes that row permanent. This is not hypothetical: the
> automated browser harness tripped it on 2026-10-05 and put a fake
> 10-second optimal solve on the live board.
>
> **`leaderboard-stub.js` is NOT sufficient for this plan.** The stub lives in
> page memory and is wiped by every reload — and this plan reloads constantly,
> including inside A4 itself. Pasting it before a submit that follows a reload
> protects nothing.
>
> **Use a browser that cannot reach Supabase at all.** Launch a dedicated
> instance with its own profile and the host blocked at the resolver:
>
> ```sh
> open -na "Google Chrome" --args \
>   --user-data-dir=/tmp/tubed-manual-test \
>   --host-resolver-rules="MAP *.supabase.co ~NOTFOUND" \
>   --no-first-run --no-default-browser-check \
>   "http://localhost:8000/index.html"
> ```
>
> Verify it before trusting it — in that browser's console:
>
> ```js
> fetch(SUPABASE_URL + '/rest/v1/scores', {method:'POST'})
>   .then(r => console.log('NOT BLOCKED', r.status))
>   .catch(e => console.log('blocked:', e.message))
> ```
>
> Its own `--user-data-dir` also keeps your real streak and history out of the
> test, so incognito is not needed on top.
>
> **Consequence to expect:** the leaderboard block on the result card will not
> render, and the share text falls back to its generic wording. That is the
> block working, not a bug. If you specifically want to test leaderboard
> *rendering*, that is what `leaderboard-stub.js` and the other `TEST-PLAN.md`
> are for — a separate session, without reloads.

### Console helpers

Paste these to inspect state at any point:

```js
JSON.parse(localStorage.getItem('tubed_timer_v1'))   // the bank: {day, easy, hard}
timerSeconds                                          // the live clock
timerDay                                              // the London day it belongs to
document.getElementById('timer-disp').textContent     // what the header shows
```

**Bank reset** — wipe the clock only, keeping today's submission and the
"how-to seen" flag that would otherwise re-open the modal:

```js
localStorage.removeItem('tubed_timer_v1'); location.reload();
```

**Full reset** — also forget today's submission, so the puzzle is playable
again. Needed after any step that presses Submit, because a solved mode shows
the locked read-only view instead of a live clock:

```js
localStorage.removeItem('tubed_timer_v1');
localStorage.removeItem('tubepzl_v6');
location.reload();
```

> Watch the order of the parts below. **A4 and C4 leave a mode solved.** Each
> part states the state it needs; when it asks for a full reset, do it, or you
> will be testing the locked view and concluding the clock is broken.

### A prerequisite for Part C

Part C uses the `?at=` dev hook near the top of `index.html` (the block
commented *"Remove this block before merging to production"*). If that block
has been stripped, Part C cannot be run as written — you would have to change
your system clock instead.

---

## Part A — the core fix

### A1. The clock runs

- [ ] Load the puzzle. Watch the header timer for ~30s.
- [ ] **Expect:** it counts up one second at a time, smoothly, no stalls or jumps.
- [ ] Console: `JSON.parse(localStorage.getItem('tubed_timer_v1'))`
- [ ] **Expect:** `{day: "<today>", easy: <≈ the number on screen>, hard: 0}`, and the
      `easy` value rises each time you re-run it.

### A2. A mid-puzzle reload resumes it

This is the exploit. Do it properly: actually work on the puzzle first.

- [ ] Let the clock reach at least **2:00**. Add a couple of stops to the route.
- [ ] Note the exact time on screen.
- [ ] Press **Cmd-R**.
- [ ] **Expect:** the timer continues from where it was (±1s). It must not show `0:00`.
- [ ] **Expect:** your route is empty again — routes are not persisted. That is
      current, intended behaviour, not a bug (see Part E).
- [ ] Reload five more times in quick succession.
- [ ] **Expect:** the clock never drops. Each reload costs you at most a second,
      never resets.

### A3. No misleading `0:00` on load

The bank is painted at `DOMContentLoaded`, before `init()` waits up to 3s on
the puzzle lookup. Force that slow path to make the window real:

- [ ] With a clock of at least **5:00** banked, open DevTools → Network →
      check **Offline** (or right-click `puzzle-lookup.json` → Block request URL).
- [ ] Reload and **watch the header from the first frame**.
- [ ] **Expect:** the banked time appears essentially immediately and stays.
      You should never see `0:00` sitting there for a beat, and never see it
      flick from `0:00` up to your real time.
- [ ] Turn Offline back off.

### A4. Submitting after a reload reports the FULL time

**Needs:** an unsolved Easy puzzle, in the Supabase-blocked browser from Setup.

- [ ] Full reset. Play for about **90 seconds** without submitting.
- [ ] Reload. Confirm the clock resumed (A2).
- [ ] Play on for another **30 seconds**, complete a route, press **Submit**.
- [ ] **Expect:** "Time taken" on the result card reads about **2:00** — the whole
      session — not ~0:30 since the reload.
- [ ] Press **Copy to clipboard** and paste somewhere.
- [ ] **Expect:** the share text's `solved in X:XX` matches the card exactly.
- [ ] Console: `JSON.parse(localStorage.getItem('tubepzl_v6')).easy.completionSecs`
- [ ] **Expect:** ~120, matching both of the above.

---

## Part B — scope: per mode, per day

### B0. A solved puzzle shows its frozen time after a reload

**Needs:** Easy solved — so run this immediately after A4, before any reset.

- [ ] **Reload.**
- [ ] **Expect:** you land on your result card, and the header shows the time you
      actually submitted — not a running clock, not `0:00`.
- [ ] Click **Back to the puzzle**.
- [ ] **Expect:** the read-only view of your submitted route, timer still frozen
      at your submitted time.
- [ ] Reload twice more.
- [ ] **Expect:** the frozen time is stable and never starts counting again.

### B1. Easy and Hard bank separately

**Needs:** both modes unsolved.

- [ ] Full reset. Play **Easy** for ~40s.
- [ ] Click the **Hard** tab. Play there for ~15s.
- [ ] Console: `JSON.parse(localStorage.getItem('tubed_timer_v1'))`
- [ ] **Expect:** `easy` ≈ 40 and `hard` ≈ 15, as two independent numbers.
- [ ] **Expect:** the header timer showed Hard's ~0:15 when you switched, not Easy's 0:40.

### B2. A tab switch after a reload does not reset either clock

This was a second door into the same exploit — the inactive mode's warm
snapshot used to carry a zero.

- [ ] Continuing from B1, **reload**.
- [ ] **Expect:** the header resumes on whichever mode you land on.
- [ ] Click across to the other mode.
- [ ] **Expect:** that mode resumes its own banked time too. Neither shows `0:00`.
- [ ] Switch back and forth four or five times.
- [ ] **Expect:** both clocks keep climbing, neither resets, and neither suddenly
      runs fast (two intervals counting would show as roughly double speed).

---

## Part C — the midnight rollover

The bank is keyed to the London day. A tab left open across midnight used to
re-stamp yesterday's seconds under today's key, so the next puzzle began nine
minutes in the hole. This was found in review, reproduced at **541s**, and fixed.

London is BST until 25 Oct 2026, so London midnight is `23:00Z`. Loading at
`?at=2026-10-07T22:58:00Z` puts you at **23:58 London** with the clock still
running forward, so midnight arrives on its own after two minutes.

> Uses **tonight's** rollover (7→8 Oct), verified against `Europe/London` and
> `todayKey()` either side: `22:59:30Z → 2026-10-07`, `23:00:30Z → 2026-10-08`.
> If you run this on a later date, move both instants forward — an instant more
> than a day old also fails the Supabase RLS window, which would make C4 fail
> for a reason that has nothing to do with the timer.

### C1. Play before midnight

**Needs:** the 7 Oct puzzle unsolved. If you submitted it in Part A, do a full
reset first — under `?at=` a solved mode still shows its locked view.

- [ ] Open **http://localhost:8000/index.html?at=2026-10-07T22:58:00Z**
- [ ] **Expect:** the dev banner appears, printing the London day as `2026-10-07`.
- [ ] Play for about **60 seconds**.
- [ ] Console: `JSON.parse(localStorage.getItem('tubed_timer_v1'))`
- [ ] **Expect:** `{day: "2026-10-07", easy: ~60, ...}`.

### C2. The clock keeps running past midnight

- [ ] Keep the tab open and do nothing for another **90 seconds** (crossing 00:00).
- [ ] Console: `todayKey()`
- [ ] **Expect:** `"2026-10-08"` — the day really has rolled.
- [ ] **Expect:** the header timer is still counting, around 2:30. It must not
      freeze or reset: you are still looking at the 5 Oct puzzle.
- [ ] Console: `JSON.parse(localStorage.getItem('tubed_timer_v1'))`
- [ ] **Expect:** still `day: "2026-10-07"` with `easy` frozen near 60. The bank
      stopped accepting writes at the rollover. **This is the fix.** If `day`
      reads `2026-10-08` with a large `easy`, the fix has regressed.

### C3. The new day's puzzle starts from zero

> `?at=` recomputes its offset on **every** page load, so reloading with the
> same `?at=2026-10-07T22:58:00Z` would drop you back to 23:58 on 7 Oct. To
> land after midnight you must load a *later* instant.

- [ ] Open **http://localhost:8000/index.html?at=2026-10-07T23:05:00Z**
      (= 00:05 London on 8 Oct), leaving the bank from C1/C2 in place.
- [ ] **Expect:** the dev banner now prints the London day as `2026-10-08`.
- [ ] **Expect:** a different puzzle (the 8 Oct one), and the timer at **0:00** —
      not the ~60s that C1 banked under 7 Oct. A non-zero start here is the
      regression this fix exists to prevent.
- [ ] Console: `JSON.parse(localStorage.getItem('tubed_timer_v1'))`
- [ ] **Expect:** `day: "2026-10-08"`, counting up from 0, with 7 Oct's value gone.

### C4. A post-midnight submission of yesterday's puzzle is still scored truly

`submitRoute()` reads the live clock, not the bank, so this should be unaffected.

**Needs:** the Supabase-blocked browser from Setup.

- [ ] Repeat C1 and C2 (play before midnight, cross it with the tab open).
- [ ] Without reloading, finish the route and **Submit**.
- [ ] **Expect:** "Time taken" is your true elapsed time (~2:30), not ~60s and
      not `0:00`.

---

## Part D — edges the automated tests cannot reach

### D1. A first-ever visit

On a first visit the how-to modal opens and the clock is deliberately not
started until you dismiss it.

- [ ] Console: `localStorage.clear(); location.reload();`
- [ ] **Expect:** the how-to modal appears and the timer sits at `0:00` behind it.
- [ ] Reload **while the modal is still open**, twice.
- [ ] **Expect:** still `0:00`, and `localStorage.getItem('tubed_timer_v1')` is
      `null` or zero. Reading the how-to should not cost you time.
- [ ] Dismiss the modal.
- [ ] **Expect:** the clock starts from `0:00` and begins banking.

### D2. Two tabs open on the same puzzle

Not covered by any automated test, and the one case I would most expect to
misbehave. Both tabs tick and both write to the same key.

- [ ] Open the puzzle in **two** tabs of the same window.
- [ ] Let **tab 1** sit in the foreground for ~60s while tab 2 is hidden behind it.
- [ ] Switch to **tab 2**. Watch its clock for 20s.
- [ ] Now switch back to **tab 1** and watch *its* clock.
- [ ] Reload tab 1.
- [ ] **What to look for:** does the clock ever go **backwards**? A tab that has
      been throttled in the background holds a lower count, and whichever tab
      writes last wins the bank — so a stale tab could in principle rewind it.
- [ ] **If you see a rewind, write down the numbers and tell me.** I have not
      tested this path and am not claiming an outcome for it.

### D3. A real phone

- [ ] Find your Mac's LAN IP (`ipconfig getifaddr en0`) and open
      `http://<ip>:8000/index.html` on your phone, on the same wifi.
- [ ] Play for a minute, then switch to another app and come back.
- [ ] **Expect:** the clock has not reset.
- [ ] Pull-to-refresh mid-puzzle.
- [ ] **Expect:** it resumes, exactly as on desktop.
- [ ] On **iOS Safari** specifically: background the browser for several minutes,
      then return. iOS is aggressive about discarding tabs; the interesting
      question is whether you come back to a *resumed* clock (good — the bank did
      its job) or a reset one (worth telling me about).
- [ ] If you use the home-screen web app, repeat there — it is a separate storage
      context from Safari proper and worth one pass.

### D4. A private window starts clean

- [ ] Open the page in a brand-new private window.
- [ ] **Expect:** timer `0:00`, no banked value, no streak.
- [ ] **This is expected and accepted**, not a finding. See Part E.

---

## Part E — known behaviours. Please do NOT report these as bugs

1. **A reload loses your in-progress route but keeps your time.** Routes have
   never been persisted. The old timer reset was accidentally compensating for
   that; now it does not. Persisting the route is separate, unstarted work.

2. **A background tab's clock runs slow.** Measured: 95s backgrounded advanced
   the clock only 60s, and it gets worse the longer you are away. You were asked
   and chose to leave this as it is, so it is a recorded decision. The fix, if
   ever wanted, is to accumulate real elapsed time per wake rather than +1 per wake.

3. **Over an hour shows as `500:00`, not `8:20:00`.** `timerFmt` has no hours
   field — review finding 4, not yet fixed. Related: `completion_secs` over
   21600 (6h) fails the database CHECK, so the leaderboard row is silently
   dropped.

4. **A solved player's frozen clock can show in live-clock red for up to 3s**
   on load, before the result card lands — review finding 6, not yet fixed.

5. **Clearing `localStorage` or using a private window gives a fresh clock.**
   Client-side times are forgeable; you accepted this. Trustworthy times need
   a server-side clock.

6. **No upper bound on a hand-edited banked value** — a crafted number renders
   on the result card. Review finding 5, not yet fixed.

---

## Teardown

- [ ] Stop the server (Ctrl-C).
- [ ] If you submitted anything **without** the stub installed, you have a real
      row on today's production board for that mode. It cannot be overwritten
      — the UNIQUE constraint is the anti-cheat lever. Make a note of it so a
      surprising rank later is not mistaken for a bug.
- [ ] Close the incognito window to discard the test `localStorage`.
