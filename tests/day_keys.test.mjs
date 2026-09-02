// Timezone / day-key regression tests for Tubed.
// Run with: node tests/day_keys.test.mjs
// Exits 0 on success, 1 on any failure.
//
// WHY THIS EXISTS
// ---------------
// todayPuzzle() keys the puzzle off Europe/London, but every "has this player
// done today's puzzle" check used to read `new Date().toDateString()` — the
// DEVICE's calendar day. The two disagree for the whole offset between the
// player's timezone and London: a 9-hour window every morning in Sydney, a
// matching evening window in the Americas. UK players never saw it, which is
// why it survived to production.
//
// Reported 2026-08-30 from Sydney. At 07:48 Sydney (21:48 London Aug 29) the
// player correctly got puzzle #149, Hendon Central -> Mansion House, and
// solved it in 36 min. At 09:00 Sydney London rolled to Aug 30. On the next
// load, lastPlayed still matched the LOCAL date, so the game restored their
// result card against the NEW puzzle: renderStoredResultFor replayed their
// stored stops from Euston, got 17 min, compared it to the Euston -> Mile End
// optimal of 24, and told them they had matched the fastest possible route on
// a journey that never reaches Mile End.
//
// These tests pin the three fixes:
//   1. todayKey()/yesterdayKey() — one London clock for puzzle AND progress.
//   2. _toDayKey()/_migrateDayKeys() — legacy toDateString values re-encoded,
//      so existing players don't get one last duplicate row on the changeover.
//   3. _storedSubmissionMatches() — a submission is never re-scored against a
//      puzzle it didn't answer, stamped or not.

// Pin the process timezone BEFORE any Date work so the legacy-conversion
// assertions are deterministic on any machine. Sydney is the reported case and
// is east of London, which is the direction that exposes _toDayKey to the
// getUTC*-vs-local trap.
process.env.TZ = 'Australia/Sydney';

import { loadEngine, ROOT } from './lib/engine.mjs';
import { readFileSync } from 'fs';
import path from 'path';

const EXTRA = [
  'todayKey', 'yesterdayKey', '_toDayKey', '_dayLabel',
  '_migrateDayKeys', '_storedSubmissionMatches',
  'renderStoredResultFor', 'getModeStore', '_modeSolvedToday', 'modeState',
  '_puzzleForMode', 'pickDefaultMode', '_isNewStreakDay', '_nextStreakValue',
  '_applySubmissionToStore', 'PRE_DAYKEYS_BACKUP_KEY', 'getStore',
];

// Load the engine with `now` pinned to a fixed instant, so London-vs-device
// windows can be exercised deterministically.
//
// NOTE: the pin only applies INSIDE the sandbox. `new Date()` in this file is
// the real wall clock, so every reference value below is built from an
// explicit instant rather than from "now".
function engineAt(isoInstant, preCtx = {}) {
  const fixed = new Date(isoInstant).getTime();
  class FakeDate extends Date {
    constructor(...args) { if (args.length === 0) super(fixed); else super(...args); }
    static now() { return fixed; }
  }
  return loadEngine(process.env.TUBED_HTML || 'index.html', {
    preCtx: { Date: FakeDate, ...preCtx },
    extraExports: EXTRA,
  });
}

// ── Test framework ─────────────────────────────────────────────────────────
const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: e.message }); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function truthy(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function falsy(v, msg)  { if (v)  throw new Error(msg || 'expected falsy'); }

// The device-day read this whole fix removed. Kept here as the counter-example
// the assertions below measure against.
const deviceDay = d => d.toDateString();

// ── 0. Guard: the TZ pin actually took effect ──────────────────────────────
test('harness: process TZ is pinned to Australia/Sydney', () => {
  // August is Sydney winter: AEST, UTC+10, so getTimezoneOffset() is -600.
  eq(new Date('2026-08-30T00:00:00').getTimezoneOffset(), -600,
    'TZ pin did not take effect — these assertions would not be meaningful');
});

// ── 1. todayKey follows London, not the device ─────────────────────────────
{
  // The exact reported instant: 07:48 Sydney Aug 30 = 21:48 UTC Aug 29
  // = 22:48 London Aug 29 (BST).
  const INSTANT = '2026-08-29T21:48:00Z';
  const T = engineAt(INSTANT);

  test('todayKey is the LONDON day inside the Sydney morning window', () => {
    eq(T.todayKey(), '2026-08-29');
  });

  test('the device day really does disagree in that window (bug is reproduced)', () => {
    // If this ever stops differing the test above proves nothing, so assert it.
    eq(deviceDay(new Date(INSTANT)), 'Sun Aug 30 2026');
    truthy(T.todayKey() !== T._toDayKey(deviceDay(new Date(INSTANT))),
      'London and device days must differ here or the window is not being exercised');
  });

  test('todayKey agrees with the puzzle date todayPuzzle() would publish', () => {
    eq(T.todayKey(), T.londonDateParts(new Date(INSTANT)).dateStr);
  });
}

// ── 2. yesterdayKey is calendar arithmetic, not now-minus-24h ──────────────
{
  // 23:30 UTC on 2026-03-29 is 00:30 BST on the 30th: London has just skipped
  // an hour, so the 29th was only 23 hours long. Subtracting 86400000ms and
  // formatting in London lands on the 28th — a whole day skipped, which would
  // silently break the streak of every player who plays in that hour.
  const INSTANT = '2026-03-29T23:30:00Z';
  const T = engineAt(INSTANT);

  test('yesterdayKey survives the BST spring-forward boundary', () => {
    eq(T.todayKey(), '2026-03-30');
    eq(T.yesterdayKey(), '2026-03-29');
  });

  test('the now-minus-24h shortcut would have got that wrong', () => {
    const naive = T.londonDateParts(new Date(new Date(INSTANT).getTime() - 86400000)).dateStr;
    eq(naive, '2026-03-28', 'expected the naive method to skip a day here');
    truthy(naive !== T.yesterdayKey(), 'calendar arithmetic must not match the naive result');
  });
}
{
  // Autumn: the 25th is 25 hours long. Nothing should skip or repeat.
  const T = engineAt('2026-10-25T12:00:00Z');
  test('yesterdayKey survives the GMT fall-back boundary', () => {
    eq(T.todayKey(), '2026-10-25');
    eq(T.yesterdayKey(), '2026-10-24');
  });
}

// ── 3-5. Everything else can share one engine ──────────────────────────────
const T = engineAt('2026-08-29T21:48:00Z');

// ── 3. Legacy day values re-encode correctly ───────────────────────────────
test('_toDayKey converts a legacy toDateString value', () => {
  eq(T._toDayKey('Sun Aug 30 2026'), '2026-08-30');
});

test('_toDayKey reads the LOCAL calendar day, not the UTC one', () => {
  // 'Sun Aug 30 2026' parses as local midnight; in Sydney that is 14:00 UTC on
  // the 29th. Reading it back with getUTC* would shift every Sydney player's
  // history back a day.
  eq(new Date('Sun Aug 30 2026').getUTCDate(), 29, 'precondition: local midnight is the previous UTC day');
  eq(T._toDayKey('Sun Aug 30 2026'), '2026-08-30');
});

test('_toDayKey does not depend on Date.parse handling toDateString', () => {
  // ECMA-262 only requires Date.parse to read back toString, toUTCString and
  // toISOString. toDateString is NOT on that list, so an engine is free to
  // return NaN for 'Sun Aug 30 2026'. If it did, the legacy value would pass
  // through unmigrated and cost that player a streak and a duplicate row.
  // Load an engine whose Date REFUSES that format and check we cope anyway.
  const fixed = new Date('2026-08-29T21:48:00Z').getTime();
  class StrictDate extends Date {
    constructor(...a) {
      if (a.length === 0) { super(fixed); return; }
      if (a.length === 1 && typeof a[0] === 'string' && !/^\d{4}-\d{2}-\d{2}/.test(a[0])) { super(NaN); return; }
      super(...a);
    }
    static now() { return fixed; }
  }
  const S = loadEngine(process.env.TUBED_HTML || 'index.html', {
    preCtx: { Date: StrictDate }, extraExports: EXTRA,
  });
  eq(isNaN(new StrictDate('Sun Aug 30 2026').getTime()), true, 'precondition: this engine cannot parse it');
  eq(S._toDayKey('Sun Aug 30 2026'), '2026-08-30');
  eq(S._toDayKey('Sat Aug 29 2026'), '2026-08-29');
  eq(S._toDayKey('Thu Jan 1 2026'), '2026-01-01');
  eq(S._toDayKey('Wed Dec 31 2025'), '2025-12-31');
});

test('_toDayKey is idempotent on already-migrated values', () => {
  eq(T._toDayKey('2026-08-30'), '2026-08-30');
});

test('_toDayKey passes through empty and unparseable values', () => {
  eq(T._toDayKey(null), null);
  eq(T._toDayKey(''), '');
  eq(T._toDayKey('not a date'), 'not a date');
});

test('_dayLabel renders a key without shifting the day', () => {
  eq(T._dayLabel('2026-08-30'), 'Sun 30 Aug 2026');
  eq(T._dayLabel('2026-01-01'), 'Thu 1 Jan 2026');
  eq(T._dayLabel('legacy string'), 'legacy string');
});

test('_dayLabel does not shift the day WEST of Greenwich', () => {
  // The label is built from a UTC midnight date. Read back with LOCAL getters
  // it renders the previous day anywhere west of GMT — invisible from Sydney,
  // which is why this assertion has to leave the file's pinned timezone.
  // (Caught as a surviving mutation by tests/mutations.test.mjs.)
  const saved = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    eq(new Date(Date.UTC(2026, 7, 30)).getDate(), 29, 'precondition: local reads the previous day here');
    eq(T._dayLabel('2026-08-30'), 'Sun 30 Aug 2026');
    eq(T._dayLabel('2026-01-01'), 'Thu 1 Jan 2026');
  } finally {
    process.env.TZ = saved;
  }
});

// ── 4. Store migration ─────────────────────────────────────────────────────
function legacyStore() {
  return {
    easy: {
      streak: 4,
      lastPlayed: 'Sun Aug 30 2026',
      history: [
        { start: 'Hendon Central', end: 'Mansion House', userMins: 36, optimalMins: 36, date: 'Sat Aug 29 2026' },
        { start: 'Hendon Central', end: 'Mansion House', userMins: 36, optimalMins: 36, date: 'Sun Aug 30 2026' },
      ],
    },
    hard: { streak: 0, lastPlayed: null, history: [] },
  };
}

test('_migrateDayKeys converts lastPlayed and every history date', () => {
  // Engine clock is pinned to London 2026-08-29, so the 'Sun Aug 30' values
  // are in the FUTURE and get clamped — see the next test for why.
  const s = legacyStore();
  truthy(T._migrateDayKeys(s), 'expected the migration to report a change');
  eq(s.easy.lastPlayed, '2026-08-29');
  eq(s.easy.history[0].date, '2026-08-29');
  eq(s.easy.history[1].date, '2026-08-29');
});

test('a future device day is clamped, so deploy-day solvers keep their solved state', () => {
  // The deploy-moment case: a Sydney player solved the London 29th at 07:48
  // their time, which the old code stamped 'Sun Aug 30 2026'. Without the
  // clamp that never equals todayKey(), the mode unlocks, and they are handed
  // a replay of the puzzle they just finished.
  const s = legacyStore();
  T._migrateDayKeys(s);
  eq(s.easy.lastPlayed, T.todayKey(), 'must still read as solved-today after migration');
});

test('past day values are NOT clamped', () => {
  // A past value is indistinguishable from an ordinary old play, so it is left
  // exactly as stored. Only future values carry proof of a device clock.
  const s = { easy: { streak: 1, lastPlayed: 'Mon Aug 24 2026',
                      history: [{ date: 'Mon Aug 24 2026', userMins: 20 }] }, hard: {} };
  T._migrateDayKeys(s);
  eq(s.easy.lastPlayed, '2026-08-24');
  eq(s.easy.history[0].date, '2026-08-24');
});

test('clamp ignores values that are not day keys', () => {
  const s = { easy: { streak: 1, lastPlayed: 'not a date', history: [] }, hard: {} };
  T._migrateDayKeys(s);
  eq(s.easy.lastPlayed, 'not a date', 'unparseable values must pass through untouched');
});

test('_migrateDayKeys is idempotent and reports no change on a second run', () => {
  const s = legacyStore();
  T._migrateDayKeys(s);
  falsy(T._migrateDayKeys(s), 'second run must not report a change (it would write to localStorage every load)');
});

test('_migrateDayKeys tolerates a missing/empty mode bucket', () => {
  falsy(T._migrateDayKeys({ easy: { streak: 0, lastPlayed: null }, hard: null }));
  falsy(T._migrateDayKeys(null));
});

test('migrated lastPlayed compares equal to todayKey for a same-day player', () => {
  // A player who solved the London 29th keeps their solved state across the fix.
  const s = { easy: { streak: 1, lastPlayed: 'Sat Aug 29 2026', history: [] }, hard: {} };
  T._migrateDayKeys(s);
  eq(s.easy.lastPlayed, T.todayKey());
});

// ── 5. The stored-submission identity guard ────────────────────────────────
// The reported bug, as data: stops that answered Hendon Central -> Mansion
// House, about to meet the Euston -> Mile End puzzle.
const STORED_STOPS = [
  { station: 'Embankment',   line: 'Northern' },
  { station: 'Mansion House', line: 'District' },
];
const AUG29 = { date: '2026-08-29', start: 'Hendon Central', end: 'Mansion House' };
const AUG30 = { date: '2026-08-30', start: 'Euston',         end: 'Mile End' };

test('stamped submission matches its own puzzle', () => {
  truthy(T._storedSubmissionMatches(
    { submittedRoute: STORED_STOPS, submittedPuzzle: AUG29 }, AUG29));
});

test('stamped submission is REJECTED against the next day\'s puzzle', () => {
  falsy(T._storedSubmissionMatches(
    { submittedRoute: STORED_STOPS, submittedPuzzle: AUG29 }, AUG30),
    'this is the reported bug: it must not be replayable');
});

test('stamp rejects a same-pair puzzle from a different date', () => {
  falsy(T._storedSubmissionMatches(
    { submittedRoute: STORED_STOPS, submittedPuzzle: AUG29 },
    { ...AUG29, date: '2026-08-22' }));
});

test('UNSTAMPED legacy submission is rejected when it ends somewhere else', () => {
  // Players who submitted before the stamp existed still get caught, because a
  // route always ends at its destination.
  falsy(T._storedSubmissionMatches({ submittedRoute: STORED_STOPS }, AUG30));
});

test('UNSTAMPED legacy submission is accepted when it ends at the destination', () => {
  truthy(T._storedSubmissionMatches({ submittedRoute: STORED_STOPS }, AUG29));
});

test('missing or empty submissions are rejected', () => {
  falsy(T._storedSubmissionMatches(null, AUG30));
  falsy(T._storedSubmissionMatches({}, AUG30));
  falsy(T._storedSubmissionMatches({ submittedRoute: [] }, AUG30));
  falsy(T._storedSubmissionMatches({ submittedRoute: STORED_STOPS }, null));
});

// ── 6. The numbers the guard exists to prevent ─────────────────────────────
test('replaying the stored stops from the wrong start reproduces the 17 min card', () => {
  // Pinned so the guard has a documented reason to exist: without it these are
  // the exact figures the player was shown.
  eq(T.buildUserLegs('Hendon Central', STORED_STOPS).totalMins, 36, 'their real answer');
  eq(T.buildUserLegs('Euston', STORED_STOPS).totalMins, 17, 'the bogus replay');
});

// ── 7. Integration: the real restore path, through localStorage ────────────
// The predicate tests above are unit-level. This drives renderStoredResultFor
// exactly as maybeShowSolvedResult(), showSavedResults() and switchMode() do:
// a persisted store on one side, a live puzzleData on the other.
function seedStore(T, submitted) {
  T._localStorage.setItem('tubepzl_v6', JSON.stringify({
    easy: { streak: 3, lastPlayed: '2026-08-29', history: [], ...submitted },
    hard: { streak: 0, lastPlayed: null, history: [] },
  }));
}

// A live puzzleData needs the fields renderResultCard reads, not just the
// three the guard checks.
function livePuzzle(start, end, date, puzzleNum) {
  const routes = T.dijkstra(T.buildGraph(), start, end);
  return { start, end, date, puzzleNum, mode: 'easy',
           optimal: T.pickOptimal(routes, { start, end }), routes };
}

test('restore path REFUSES a stale submission against the new puzzle', () => {
  seedStore(T, {
    submittedRoute: STORED_STOPS,
    submittedPuzzle: AUG29,
    completionSecs: 27,
    submittedHintsUsed: 0,
  });
  const html = T.renderStoredResultFor('easy', livePuzzle('Euston', 'Mile End', '2026-08-30', 150));
  eq(html, null, 'a mismatched submission must not render a result card');
});

test('restore path still rebuilds the card for the puzzle it answered', () => {
  seedStore(T, {
    submittedRoute: STORED_STOPS,
    submittedPuzzle: AUG29,
    completionSecs: 27,
    submittedHintsUsed: 0,
  });
  const html = T.renderStoredResultFor('easy', livePuzzle('Hendon Central', 'Mansion House', '2026-08-29', 149));
  truthy(typeof html === 'string' && html.length > 0, 'the legitimate restore must still work');
  truthy(html.includes('Mansion House'), 'card should name the real destination');
});

// ── 8. The stale ✓ ─────────────────────────────────────────────────────────
// lastPlayed can EQUAL today's London key while pointing at a different
// puzzle: a Sydney player who solved the 29th at 07:48 their time had it
// stamped 2026-08-30 by the old code, which becomes "today" a few hours
// later. The tab tick, the default tab, the streak and the history row all
// used to trust that alone.
function seedHard(T, mode) {
  T._localStorage.setItem('tubepzl_v6', JSON.stringify({
    easy: { streak: 0, lastPlayed: null, history: [] },
    hard: { streak: 3, lastPlayed: T.todayKey(), history: [],
            submittedRoute: STORED_STOPS, submittedPuzzle: AUG29 },
  }));
}

test('a stale lastPlayed does NOT count as solved once the puzzle is known', () => {
  seedHard(T);
  T.modeState.hard = { puzzleData: { ...AUG30, date: T.todayKey() } };
  falsy(T._modeSolvedToday('hard'),
    'submission answers a different puzzle, so today is unplayed');
});

test('a genuine solve still counts as solved', () => {
  seedHard(T);
  T.modeState.hard = { puzzleData: AUG29 };
  truthy(T._modeSolvedToday('hard'));
});

test('falls back to lastPlayed while the puzzle is still unresolved', () => {
  seedHard(T);
  T.modeState.hard = null;
  truthy(T._modeSolvedToday('hard'),
    'early in init there is nothing to check against; trust lastPlayed');
});

test('a lastPlayed from another day is never solved-today', () => {
  T._localStorage.setItem('tubepzl_v6', JSON.stringify({
    easy: { streak: 0, lastPlayed: null, history: [] },
    hard: { streak: 3, lastPlayed: '2026-08-20', history: [],
            submittedRoute: STORED_STOPS, submittedPuzzle: AUG29 },
  }));
  T.modeState.hard = { puzzleData: AUG29 };
  falsy(T._modeSolvedToday('hard'));
});

// ── 9. The stale ✓, from init()'s ACTUAL starting state ────────────────────
// Section 8 hand-set modeState, which hid a hole: at init() nothing is warm.
// pickDefaultMode() runs before any puzzle exists, flips currentMode to hard,
// and modeState.easy stays null until a deferred warm-up — so the easy tab had
// no puzzle to check against and kept its tick. This drives the real thing:
// a legacy store, an unwarmed engine, and the lookup loaded the way the fetch
// loads it.
{
  const LOOKUP = JSON.parse(readFileSync(path.join(ROOT, 'puzzle-lookup.json'), 'utf8'));
  const win = { addEventListener(){}, removeEventListener(){}, location: { search: '' } };
  // 23:30 UTC on the 29th: London has ticked over to the 30th, Sydney has not.
  const T9 = engineAt('2026-08-29T23:30:00Z', { window: win });
  // The real fetch resolves after the script evaluates; mirror that.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  T9._ctx.window.PUZZLE_LOOKUP = LOOKUP;

  // Exactly what the old build wrote for a Sydney player who solved the 29th
  // at 07:48 local: their own date, and no puzzle stamp.
  T9._localStorage.setItem('tubepzl_v6', JSON.stringify({
    easy: { streak: 3, lastPlayed: 'Sun Aug 30 2026', history: [],
            submittedRoute: STORED_STOPS, completionSecs: 27, submittedHintsUsed: 0 },
    hard: { streak: 0, lastPlayed: null, history: [] },
  }));

  test('nothing is warm, exactly as at init()', () => {
    eq(T9.modeState.easy, null, 'modeState must be cold or this test proves nothing');
  });

  test('_puzzleForMode resolves the easy puzzle without a warm snapshot', () => {
    const pd = T9._puzzleForMode('easy');
    truthy(pd, 'must resolve once the lookup has settled');
    eq(`${pd.start} -> ${pd.end}`, 'Euston -> Mile End');
  });

  test('the stale ✓ is gone: a legacy stamp does not mark easy solved', () => {
    // lastPlayed migrates to 2026-08-30, which IS todayKey here — the trap.
    eq(T9.getModeStore('easy').lastPlayed, T9.todayKey(), 'precondition: the stamp looks like today');
    falsy(T9._modeSolvedToday('easy'),
      'the submission ends at Mansion House, today ends at Mile End');
  });

  test('and the player lands on Easy, not Hard', () => {
    eq(T9.pickDefaultMode ? T9.pickDefaultMode() : 'easy', 'easy');
  });
}

// ── 10. Streaks ────────────────────────────────────────────────────────────
// Engine clock is London 2026-08-29, so today = 2026-08-29, yesterday =
// 2026-08-28. Every transition submitRoute can make is enumerated here.
{
  const TODAY = '2026-08-29', YESTERDAY = '2026-08-28';

  test('streak baseline: today and yesterday are what we think', () => {
    eq(T.todayKey(), TODAY);
    eq(T.yesterdayKey(), YESTERDAY);
  });

  test('first ever play starts the streak at 1', () => {
    eq(T._nextStreakValue(0, null), 1);
    eq(T._nextStreakValue(undefined, undefined), 1);
  });

  test('played yesterday continues the streak', () => {
    eq(T._nextStreakValue(7, YESTERDAY), 8);
  });

  test('played two days ago resets to 1', () => {
    eq(T._nextStreakValue(7, '2026-08-27'), 1);
    eq(T._nextStreakValue(7, '2026-01-01'), 1);
  });

  test('a stale stamp equal to today continues rather than resets', () => {
    // The migration case: the stamp says today because it came from a device
    // clock, but the play it refers to was yesterday in London. Continue.
    eq(T._nextStreakValue(7, TODAY), 8);
  });

  test('a non-key value never silently continues a streak', () => {
    // '>' on a raw string would sort ahead of the date and fake a continuation.
    eq(T._nextStreakValue(7, 'not a date'), 1);
    eq(T._nextStreakValue(7, ''), 1);
  });

  // ── the gate that decides whether _nextStreakValue is called at all ──
  const solvedToday = { lastPlayed: TODAY, submittedRoute: STORED_STOPS, submittedPuzzle: AUG29 };

  test('a genuine second submit today does NOT log another streak day', () => {
    falsy(T._isNewStreakDay(solvedToday, TODAY, AUG29),
      'already logged: the submission matches the puzzle on screen');
  });

  test('a stale stamp for a DIFFERENT puzzle does log a new streak day', () => {
    // Without this the player solves today and earns nothing.
    truthy(T._isNewStreakDay(
      { lastPlayed: TODAY, submittedRoute: STORED_STOPS, submittedPuzzle: { date: '2026-08-28', start: 'Hendon Central', end: 'Mansion House' } },
      TODAY, AUG29));
  });

  test('a legacy (unstamped) submission for another puzzle logs a new day', () => {
    truthy(T._isNewStreakDay(
      { lastPlayed: TODAY, submittedRoute: STORED_STOPS },
      TODAY, { date: TODAY, start: 'Euston', end: 'Mile End' }));
  });

  test('a legacy submission that DOES match today does not double-log', () => {
    falsy(T._isNewStreakDay({ lastPlayed: TODAY, submittedRoute: STORED_STOPS }, TODAY, AUG29));
  });

  test('yesterday\'s player logs a new day', () => {
    truthy(T._isNewStreakDay({ lastPlayed: YESTERDAY, submittedRoute: STORED_STOPS, submittedPuzzle: AUG29 }, TODAY, AUG29));
  });

  test('end to end: a 4-day streak survives the migration unchanged', () => {
    // UK player who solved today under the OLD code: legacy stamp, no
    // submittedPuzzle, lastPlayed is today's calendar day.
    const store = { easy: { streak: 4, lastPlayed: 'Sat Aug 29 2026', history: [],
                            submittedRoute: STORED_STOPS }, hard: {} };
    T._migrateDayKeys(store);
    eq(store.easy.lastPlayed, TODAY, 'migrated in place');
    // They reload; their submission still answers today's puzzle, so nothing
    // is re-logged and the streak is untouched.
    falsy(T._isNewStreakDay(store.easy, TODAY, AUG29));
    eq(store.easy.streak, 4);
  });

  test('end to end: a Sydney player mid-window keeps their streak and gains one', () => {
    // Solved the London 29th at 07:48 Sydney; old code stamped 30 Aug.
    const store = { easy: { streak: 4, lastPlayed: 'Sun Aug 30 2026', history: [],
                            submittedRoute: STORED_STOPS }, hard: {} };
    T._migrateDayKeys(store);
    eq(store.easy.lastPlayed, TODAY, 'future stamp clamped to today');
    // Still reads as solved for the puzzle they answered — no free replay.
    falsy(T._isNewStreakDay(store.easy, TODAY, AUG29));
    eq(store.easy.streak, 4, 'streak not touched on reload');
    // Tomorrow they solve the 30th: one increment, not two, not zero.
    eq(T._nextStreakValue(store.easy.streak, store.easy.lastPlayed), 5);
  });
}

// ── 11. Submitting a solve ─────────────────────────────────────────────────
// The ✓ on a freshly solved puzzle disappeared because submitRoute wrote the
// streak and lastPlayed, refreshed the tabs, and only THEN attached
// submittedRoute and the puzzle stamp. In that window the store claimed
// "played today" with nothing to prove it, so _modeSolvedToday refused to
// tick. These pin the whole update as one step.
{
  const TODAY = '2026-08-29';
  const PD = { date: TODAY, start: 'Hendon Central', end: 'Mansion House' };
  const legs = T.buildUserLegs('Hendon Central', STORED_STOPS);
  const submit = (store, over = {}) => T._applySubmissionToStore(store, {
    today: TODAY, puzzleData: PD, userRoute: STORED_STOPS, userLegsData: legs,
    userMins: 36, optimalMins: 36, medal: '🥇', mode: 'easy',
    completionSecs: 27, hintsUsed: 0, ...over,
  });

  test('after a submit the store immediately proves the puzzle was solved', () => {
    // THE REGRESSION: this is exactly what the ✓ asks for.
    const store = { streak: 4, lastPlayed: '2026-08-28', history: [] };
    submit(store);
    truthy(T._storedSubmissionMatches(store, PD),
      'the tick needs this true the instant submitRoute saves');
  });

  test('a submit records the day, the streak and one history row', () => {
    const store = { streak: 4, lastPlayed: '2026-08-28', history: [] };
    submit(store);
    eq(store.lastPlayed, TODAY);
    eq(store.streak, 5);
    eq(store.history.length, 1);
    eq(store.history[0].start, 'Hendon Central');
    eq(store.submittedPuzzle.date, TODAY);
    eq(store.submittedRoute.length, 2);
  });

  test('re-submitting the same puzzle does not double the streak or the row', () => {
    const store = { streak: 4, lastPlayed: '2026-08-28', history: [] };
    submit(store);
    submit(store);
    eq(store.streak, 5, 'one streak day per puzzle per day');
    eq(store.history.length, 1);
  });

  test('a better time replaces the row, a worse one does not', () => {
    const store = { streak: 0, lastPlayed: null, history: [] };
    submit(store, { userMins: 40 });
    submit(store, { userMins: 33 });
    eq(store.history.length, 1);
    eq(store.history[0].userMins, 33);
    submit(store, { userMins: 50 });
    eq(store.history[0].userMins, 33, 'a slower resubmit must not overwrite');
  });

  test('a stale row for a DIFFERENT puzzle on the same day is not overwritten', () => {
    const store = { streak: 4, lastPlayed: TODAY, history: [
      { date: TODAY, start: 'Oval', end: 'East Ham', userMins: 40 },
    ] };
    submit(store);
    eq(store.history.length, 2, 'the other puzzle keeps its row');
  });

  test('history stays capped at 60 rows', () => {
    const store = { streak: 0, lastPlayed: null, history:
      Array.from({length: 60}, (_, i) => ({ date: `2026-06-${String((i % 28) + 1).padStart(2,'0')}`, userMins: 20, start:'A', end:'B' })) };
    submit(store);
    eq(store.history.length, 60);
    truthy(store.history.some(e => e.start === 'Hendon Central'), 'the new row survives the cap');
  });
}

// ── 12. Rollback safety ────────────────────────────────────────────────────
// The migration cannot be undone by reverting the code, so the pre-migration
// store is stashed once, on the load that converts it.
{
  const LEGACY = JSON.stringify({
    easy: { streak: 4, lastPlayed: 'Sun Aug 30 2026',
            history: [{ date: 'Sat Aug 29 2026', userMins: 36, start: 'A', end: 'B' }] },
    hard: { streak: 0, lastPlayed: null, history: [] },
  });

  test('migrating stashes the untouched pre-migration store', () => {
    T._localStorage.setItem('tubepzl_v6', LEGACY);
    T._localStorage.removeItem(T.PRE_DAYKEYS_BACKUP_KEY);
    T.getStore();
    const backup = T._localStorage.getItem(T.PRE_DAYKEYS_BACKUP_KEY);
    eq(backup, LEGACY, 'the backup must be the ORIGINAL, not the migrated copy');
    // ...and the live store really was migrated.
    eq(JSON.parse(T._localStorage.getItem('tubepzl_v6')).easy.lastPlayed, T.todayKey());
  });

  test('the backup is never overwritten by later loads', () => {
    T._localStorage.setItem('tubepzl_v6', LEGACY);
    T._localStorage.removeItem(T.PRE_DAYKEYS_BACKUP_KEY);
    T.getStore();
    // A second migration-triggering load must not clobber the first backup.
    T._localStorage.setItem('tubepzl_v6', JSON.stringify({
      easy: { streak: 9, lastPlayed: 'Mon Aug 31 2026', history: [] },
      hard: { streak: 0, lastPlayed: null, history: [] },
    }));
    T.getStore();
    eq(T._localStorage.getItem(T.PRE_DAYKEYS_BACKUP_KEY), LEGACY);
  });

  test('an already-migrated store writes no backup at all', () => {
    T._localStorage.setItem('tubepzl_v6', JSON.stringify({
      easy: { streak: 4, lastPlayed: '2026-08-29', history: [] },
      hard: { streak: 0, lastPlayed: null, history: [] },
    }));
    T._localStorage.removeItem(T.PRE_DAYKEYS_BACKUP_KEY);
    T.getStore();
    eq(T._localStorage.getItem(T.PRE_DAYKEYS_BACKUP_KEY), null,
      'nothing was converted, so there is nothing to roll back to');
  });
}

// ── Report ─────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
for (const r of results) {
  console.log(r.ok ? `  ✓ ${r.name}` : `  ✗ ${r.name}\n      ${r.error}`);
}
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
