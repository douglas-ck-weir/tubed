// Timer-persistence regression tests for Tubed.
// Run with: node tests/timer_persistence.test.mjs
// Exits 0 on success, 1 on any failure.
//
// WHY THIS EXISTS
// ---------------
// startTimer() used to open with `timerSeconds = 0`, and nothing about the
// clock was persisted. So a refresh handed the player a fresh 0:00 on a puzzle
// they had already been staring at: read the stations, work the route out at
// leisure (paper, another tab, a map), reload, key it in, submit a time you
// never played. Every submitted time was therefore only as honest as the
// player, and the leaderboard would have inherited that.
//
// The fix stores accumulated seconds per mode per LONDON day under its own
// key, and startTimer() resumes from it. Deliberately not a start timestamp:
// closing the tab pauses the clock rather than charging the hours until the
// player comes back.
//
// These tests pin:
//   1. A reload resumes the clock instead of zeroing it (the bug).
//   2. The first tab switch after a reload resumes it too (freshSnapshotFor
//      warms the inactive mode's slot, and a 0 there reopens the same hole one
//      click later).
//   3. The value is per mode, expires with the London day, and survives
//      garbage in storage.
//   4. resetTimer() — the one genuine "start over" — clears the saved value,
//      and stopTimer() persists the submitted time.
//
// To watch these go red against the pre-fix build:
//   TUBED_HTML=backups/index.html.pre-timer-persistence.2026-09-29.bak \
//     node tests/timer_persistence.test.mjs

import { loadEngine } from './lib/engine.mjs';

const HTML = process.env.TUBED_HTML || 'index.html';

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

// ── Harness ────────────────────────────────────────────────────────────────
const EXTRA = [
  'TIMER_KEY', 'savedTimerSecs', '_writeTimerSecs', 'clearSavedTimer',
  '_readTimerStore', 'startTimer', 'stopTimer', 'resetTimer',
  'freshSnapshotFor', 'todayKey', '_peekTimer', '_earlyPaintTimer', '_startTicking',
];

// A localStorage the test owns, so two loads of the build can share one
// browser profile — which is what a page refresh actually is. The loader
// builds its own storage per load, so this has to come in via preCtx.
function makeStorage(seed = {}) {
  const data = { ...seed };
  return {
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
    clear: () => { Object.keys(data).forEach(k => delete data[k]); },
    _raw: data,
  };
}

// Load the build with `now` pinned, a shared localStorage, and a setInterval
// the test can drive by hand. The build's only setInterval is the timer tick,
// so the last callback registered is always the ticker.
function loadPage(storage, isoInstant = '2026-09-29T12:00:00Z', ctxOverrides = {}) {
  const fixed = new Date(isoInstant).getTime();
  class FakeDate extends Date {
    constructor(...args) { if (args.length === 0) super(fixed); else super(...args); }
    static now() { return fixed; }
  }
  // Model intervals the way the browser does: setInterval hands back an id,
  // clearInterval cancels THAT id, and a tick fires every interval still live.
  // The previous stubs (no-op clearInterval, drive-only-the-newest-callback)
  // could not see a leaked interval at all — a build that never cancels the
  // old timer double-counts in a real browser and still passed every
  // assertion here. See the single-clock test below.
  const liveIntervals = new Map();
  let nextIntervalId = 1;
  const T = loadEngine(HTML, {
    preCtx: {
      Date: FakeDate,
      localStorage: storage,
      setInterval: (fn) => { const id = nextIntervalId++; liveIntervals.set(id, fn); return id; },
      clearInterval: (id) => { liveIntervals.delete(id); },
      ...ctxOverrides,
    },
    extraExports: EXTRA,
    // The only way to read a `let` global from the host side: a closure
    // defined in the build's own top-level scope.
    append: 'function _peekTimer() { return { secs: timerSeconds, stopped: timerStopped, mode: currentMode }; }',
  });
  // Advance by `n` whole seconds, firing every interval that is still live —
  // so a leaked one shows up as the clock running fast.
  T._tick = (n) => {
    for (let i = 0; i < n; i++) for (const fn of [...liveIntervals.values()]) fn();
  };
  // How many intervals are currently live. Exactly one clock may ever tick.
  T._liveIntervals = () => liveIntervals.size;
  T._storage = storage;
  return T;
}

// A clock the test can advance mid-run. loadPage's default Date is pinned to a
// single instant, which cannot express "this tab was left open across
// midnight" — the case that matters for day-keyed banking.
function mutableClock(startIso) {
  const clock = { now: new Date(startIso).getTime() };
  class FakeDate extends Date {
    constructor(...args) { if (args.length === 0) super(clock.now); else super(...args); }
    static now() { return clock.now; }
  }
  clock.set = iso => { clock.now = new Date(iso).getTime(); };
  clock.Date = FakeDate;
  return clock;
}

// ── 0. Guard: the peek hook and the tick hook actually work ────────────────
{
  const T = loadPage(makeStorage());
  test('harness: the build exposes a readable timer clock', () => {
    truthy(typeof T._peekTimer === 'function', '_peekTimer did not land in the sandbox');
    eq(T._peekTimer().secs, 0, 'clock should start at 0 before startTimer');
  });
  test('harness: the captured setInterval really drives the clock', () => {
    T.startTimer();
    T._tick(3);
    eq(T._peekTimer().secs, 3, 'hand-driven ticks must move timerSeconds or nothing below is meaningful');
  });
  test('the build has a persisted clock at all', () => {
    for (const n of ['TIMER_KEY', 'savedTimerSecs', '_writeTimerSecs', 'clearSavedTimer'])
      truthy(T[n] !== undefined, `${n} is missing — this build does not persist the timer`);
  });
}

// ── 1. THE BUG: a refresh must not zero the clock ──────────────────────────
{
  const storage = makeStorage();
  const first = loadPage(storage);
  first.startTimer();
  first._tick(137);          // 2:17 of honest thinking

  test('the clock ran before the reload (bug is set up)', () => {
    eq(first._peekTimer().secs, 137);
  });

  // Same browser profile, new page: exactly a refresh.
  const second = loadPage(storage);
  second.startTimer();

  test('a refresh RESUMES the clock rather than restarting at 0:00', () => {
    eq(second._peekTimer().secs, 137,
      'reload reset the timer — a player can reload and post a time they never played');
  });

  test('the resumed clock keeps counting from where it was', () => {
    second._tick(10);
    eq(second._peekTimer().secs, 147);
  });

  test('the resumed clock is running, not frozen', () => {
    eq(second._peekTimer().stopped, false);
  });
}

// ── 2. The same hole one tab click later ───────────────────────────────────
// freshSnapshotFor() is built at init() for the mode the player is NOT on, and
// restoreMode() splats it in wholesale on the first tab switch. A 0 in that
// snapshot hands back the reset via the Easy/Hard tab.
{
  const storage = makeStorage();
  const T = loadPage(storage);

  test('the inactive mode\'s warm snapshot carries its saved clock', () => {
    // Stand in for "the player already spent 4 minutes on Hard today".
    storage.setItem(T.TIMER_KEY, JSON.stringify({ day: T.todayKey(), easy: 0, hard: 240 }));
    const snap = T.freshSnapshotFor('hard');
    eq(snap.timerSeconds, 240,
      'switching tabs after a reload zeroes the clock — same exploit, one click later');
  });
}

// ── 3. Scope: per mode, per London day, and junk-tolerant ──────────────────
{
  const storage = makeStorage();
  const T = loadPage(storage);

  test('easy and hard keep separate clocks', () => {
    T._writeTimerSecs('easy', 61);
    T._writeTimerSecs('hard', 999);
    eq(T.savedTimerSecs('easy'), 61);
    eq(T.savedTimerSecs('hard'), 999);
  });

  test('a saved clock written by one load is read back by the next', () => {
    storage.setItem(T.TIMER_KEY, JSON.stringify({ day: T.todayKey(), easy: 88, hard: 0 }));
    eq(loadPage(storage).savedTimerSecs('easy'), 88);
  });

  test('the saved clock is stamped with the London day, not the device day', () => {
    eq(T._readTimerStore().day, T.todayKey());
  });

  test('yesterday\'s clock does not leak into today\'s puzzle', () => {
    storage.setItem(T.TIMER_KEY, JSON.stringify({ day: '2026-09-28', easy: 500, hard: 500 }));
    eq(T.savedTimerSecs('easy'), 0);
    eq(T.savedTimerSecs('hard'), 0);
  });

  test('garbage in storage reads as 0, never NaN', () => {
    const day = T.todayKey();
    for (const bad of [undefined, null, 'abc', -5, NaN, Infinity, {}, []]) {
      storage.setItem(T.TIMER_KEY, JSON.stringify({ day, easy: bad, hard: bad }));
      eq(T.savedTimerSecs('easy'), 0, `easy from ${JSON.stringify(bad)}`);
    }
    storage.setItem(T.TIMER_KEY, '{not json');
    eq(T.savedTimerSecs('easy'), 0, 'unparseable payload');
    storage.removeItem(T.TIMER_KEY);
    eq(T.savedTimerSecs('easy'), 0, 'absent payload');
  });

  test('a fractional saved value is floored, so the display stays whole', () => {
    T._writeTimerSecs('easy', 42.9);
    eq(T.savedTimerSecs('easy'), 42);
  });
}

// ── 4. The two writes that are allowed to change the saved clock ───────────
{
  const storage = makeStorage();
  const T = loadPage(storage);

  test('stopTimer persists the submitted time', () => {
    T.startTimer();
    T._tick(300);
    T.stopTimer();
    eq(T.savedTimerSecs('easy'), 300, 'submit must leave the clock it scored behind it');
    eq(T._peekTimer().stopped, true);
  });

  test('a stopped clock does not keep counting', () => {
    T._tick(50);
    eq(T._peekTimer().secs, 300);
    eq(T.savedTimerSecs('easy'), 300);
  });

  test('resetTimer — the genuine start-over — clears the saved clock', () => {
    T.resetTimer();
    eq(T._peekTimer().secs, 0);
    eq(T.savedTimerSecs('easy'), 0,
      'resetTimer left the old seconds saved, so the next reload would jump back up');
  });

  test('startTimer claims the slot immediately, before the first tick', () => {
    const s2 = makeStorage();
    const T2 = loadPage(s2);
    T2.startTimer();
    truthy(s2.getItem(T2.TIMER_KEY) !== null,
      'a reload inside the first second would find nothing saved');
  });
}

// ── 5. The early paint picks the mode the player will actually land on ─────
// _earlyPaintTimer runs at DOMContentLoaded, before init() has resolved a
// puzzle, so it chooses a mode from localStorage alone. The browser run proves
// it paints; this pins WHICH clock it paints, which is the one branch in it.
{
  // A document fake just real enough to record what got written to the timer,
  // and to absorb the top-level addEventListener hook.
  function fakeDoc() {
    const painted = [];
    const el = { get textContent() { return painted[painted.length - 1]; },
                 set textContent(v) { painted.push(v); },
                 classList: { add(){}, remove(){}, toggle(){} }, style: {} };
    return {
      _painted: painted,
      readyState: 'loading',
      getElementById: () => el,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add(){}, remove(){} }, appendChild(){}, setAttribute(){} }),
      body: { appendChild(){} },
    };
  }

  const today = '2026-09-29';   // matches the instant loadPage pins

  test('with only Easy banked, the early paint shows Easy\'s clock', () => {
    const doc = fakeDoc();
    const storage = makeStorage({
      [ 'tubed_timer_v1' ]: JSON.stringify({ day: today, easy: 95, hard: 0 }),
    });
    const T = loadPage(storage, '2026-09-29T12:00:00Z', { document: doc });
    T._earlyPaintTimer();
    eq(doc._painted[doc._painted.length - 1], '1:35', 'early paint should show banked Easy time');
  });

  test('when Easy is already submitted today, the early paint shows Hard\'s clock', () => {
    const doc = fakeDoc();
    const storage = makeStorage({
      tubed_timer_v1: JSON.stringify({ day: today, easy: 95, hard: 240 }),
      tubepzl_v6: JSON.stringify({
        easy: { streak: 1, lastPlayed: today, history: [], submittedRoute: [{ station: 'Bank', line: 'Central' }] },
        hard: { streak: 0, lastPlayed: null, history: [] },
      }),
    });
    const T = loadPage(storage, '2026-09-29T12:00:00Z', { document: doc });
    T._earlyPaintTimer();
    eq(doc._painted[doc._painted.length - 1], '4:00',
      'a player who has finished Easy lands on Hard, so Hard is the clock to show');
  });

  test('with nothing banked the early paint leaves the static 0:00 alone', () => {
    const doc = fakeDoc();
    const T = loadPage(makeStorage(), '2026-09-29T12:00:00Z', { document: doc });
    T._earlyPaintTimer();
    eq(doc._painted.length, 0, 'nothing banked: no repaint needed, 0:00 is already correct');
  });
}

// ── 6. A tab left open across London midnight ──────────────────────────────
// The bank is keyed to today. _writeTimerSecs reads the store, mutates one
// field and writes it back — and _readTimerStore re-stamps itself to the
// current day on the way through. So a tick firing after midnight writes
// YESTERDAY's seconds under TODAY's key, which both defeats the day-expiry
// guard and hands the new puzzle a head start.
{
  const clock = mutableClock('2026-09-29T22:00:00Z');   // 23:00 London (BST)
  const storage = makeStorage();
  const T = loadPage(storage, undefined, { Date: clock.Date });

  test('midnight: the pre-midnight day is what gets banked (setup)', () => {
    eq(T.todayKey(), '2026-09-29', 'fixture should start the evening before');
    T.startTimer();
    T._tick(540);                                        // nine minutes of play
    eq(T.savedTimerSecs('easy'), 540);
  });

  test('midnight: a tick after it does not re-stamp those seconds onto the new day', () => {
    clock.set('2026-09-29T23:30:00Z');                   // 00:30 London, Sep 30
    eq(T.todayKey(), '2026-09-30', 'the fixture must actually cross midnight');
    T._tick(1);
    const raw = JSON.parse(storage.getItem(T.TIMER_KEY));
    eq(raw.day, '2026-09-29',
      'the bank was re-stamped to the new day, so yesterday\'s seconds now belong to today');
  });

  test('midnight: the next day\'s puzzle starts from zero', () => {
    eq(T.savedTimerSecs('easy'), 0,
      'a reload after midnight gives the NEW puzzle a head start it never earned');
  });

  test('midnight: the visible clock keeps running for the puzzle still on screen', () => {
    // The player is still looking at yesterday's puzzle until they reload, so
    // their clock must neither freeze nor jump. Only the BANKING stops.
    const before = T._peekTimer().secs;
    T._tick(5);
    eq(T._peekTimer().secs, before + 5);
    eq(T._peekTimer().stopped, false);
  });

  test('midnight: a fresh load on the new day banks normally again', () => {
    const T2 = loadPage(storage, undefined, { Date: clock.Date });
    T2.startTimer();
    T2._tick(7);
    eq(T2.savedTimerSecs('easy'), 7);
    eq(JSON.parse(storage.getItem(T2.TIMER_KEY)).day, '2026-09-30');
  });
}

// ── 7. Exactly one clock may ever be live ──────────────────────────────────
// _startTicking() cancels before it starts. Every caller today also cancels
// first, so that clearInterval is belt-and-braces — which is precisely why it
// is worth pinning: a leaked interval does not fail loudly, it just makes
// every player's clock run fast, and the submitted time is what the
// leaderboard ranks on.
{
  test('starting the clock twice leaves only one interval running', () => {
    const T = loadPage(makeStorage());
    T.startTimer();
    T.startTimer();
    eq(T._liveIntervals(), 1, 'a second startTimer left the first interval alive');
  });

  test('a double start does not make the clock run fast', () => {
    const T = loadPage(makeStorage());
    T.startTimer();
    T.startTimer();
    T._tick(10);
    eq(T._peekTimer().secs, 10,
      'two live intervals count two seconds per second, so submitted times are inflated');
  });

  test('re-entering the ticking helper does not stack intervals', () => {
    // switchMode()'s restore branch calls _startTicking() directly on every
    // tab switch, so this is that path. switchMode itself is not callable
    // here: it reaches into Leaflet, which the sandbox has no `L` for.
    const T = loadPage(makeStorage());
    T.startTimer();
    T._startTicking();
    T._startTicking();
    eq(T._liveIntervals(), 1, 'each tab switch would leave another interval counting');
  });

  test('stopping the clock cancels its interval outright', () => {
    const T = loadPage(makeStorage());
    T.startTimer();
    eq(T._liveIntervals(), 1);
    T.stopTimer();
    eq(T._liveIntervals(), 0, 'stopTimer left an interval live; only timerStopped was hiding it');
  });
}

// ── Report ─────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.name}${r.ok ? '' : `\n         ${r.error}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed  (${HTML})`);
process.exit(failed.length ? 1 : 0);
