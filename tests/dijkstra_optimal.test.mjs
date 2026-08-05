// Dijkstra correctness regression test for Tubed.
// Run with: node tests/dijkstra_optimal.test.mjs
// Exits 0 on success, 1 on any failure.
//
// WHY THIS EXISTS
// ---------------
// dijkstra() publishes the "OPTIMAL!" route and is the baseline every player is
// scored against. It used to be a CAPPED beam search (MAX_PATHS): on branch-
// dense corridors it evicted the genuinely-optimal path before it reached the
// destination and published a too-slow "optimal" that players beat. Raising the
// cap only moved the ceiling (8->16 fixed #104 but NOT e.g. Aldgate East ->
// Kilburn, where even cap-128 missed the true route).
//
// 2026-08-01: dijkstra was rewritten as an ADMISSIBLE, uncapped, heap-based
// search — so the published optimal is provably the true shortest. The old
// "re-run at a bigger cap and compare" test is therefore obsolete (there is no
// cap to bump). This test now pins the properties that MUST hold of an
// admissible engine, and that would have caught the original bug:
//
//   1. NO-INVERSION: dijkstra's optimal is never slower than the best 1-change
//      (or 2-change) route. bestOneChangeMins/bestTwoChangeMins are derived from
//      the SAME engine + cost model now, so a disagreement means a real bug. A
//      capped/incorrect dijkstra fails this (it returns a 2-change route while a
//      faster 1-change route exists).
//   2. STRUCTURAL CONTIGUITY: every returned route's legs join up (each leg
//      starts where the previous ended, or at a real OSI-walk / interchange
//      pair). Catches teleports from a bad search/reconstruction.
//   3. NAMED REGRESSIONS: the specific pairs that surfaced the bug resolve to
//      their true optimal.

import { readFileSync } from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Which build to test. Defaults to the live index.html; set TUBED_HTML to run
// the same assertions against a candidate build (e.g. TUBED_HTML=tubed-v2.html).
const HTML_PATH = path.isAbsolute(process.env.TUBED_HTML || '')
  ? process.env.TUBED_HTML
  : path.join(__dirname, '..', process.env.TUBED_HTML || 'index.html');
const LOOKUP_PATH = path.join(__dirname, '..', 'puzzle-lookup.json');
const html = readFileSync(HTML_PATH, 'utf8');

// ── Sandbox loader ──────────────────────────────────────────────────────────
// Loads index.html into a stubbed-DOM sandbox and exports the puzzle engine.
// Optional kOverride rewrites dijkstra's per-state label cap K so the
// K-sensitivity test can prove K is high enough (a deeper K finds no cheaper
// optimal). Rewriting a value that isn't present is a hard failure so the test
// can't silently pass against an unchanged engine.
function loadTubed(kOverride) {
  let src = html;
  if (kOverride != null) {
    // Match any value so the override survives a build that ships a different K.
    if (!/const K = \d+;/.test(src)) {
      console.error('FATAL: could not find "const K = <n>;" to override K. Did K change shape?');
      process.exit(1);
    }
    src = src.replace(/const K = \d+;/, `const K = ${kOverride};`);
  }
  const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const exportSuffix = `;globalThis.__TUBED__ = { buildGraph, dijkstra, pickOptimal, COORDS, bestOneChangeMins, bestTwoChangeMins, osiTime, _stationName, countDistinctChanges, todayPuzzle, londonDateParts };`;
  const fullScript = scripts.join('\n;\n') + exportSuffix;

  function makeStub(name = 'stub') {
    const fn = function () { return makeStub(name); };
    return new Proxy(fn, {
      get(_t, p) {
        if (p === Symbol.toPrimitive) return () => '';
        if (p === 'then') return undefined;
        if (p === 'length') return 0;
        if (p === 'forEach' || p === 'map' || p === 'filter') return () => [];
        return makeStub(name);
      },
      apply() { return makeStub(name); },
      has() { return true; },
    });
  }
  const ctx = {
    console, Date, Math, Object, Array, Set, Map, JSON, Number, String, Boolean, RegExp,
    parseInt, parseFloat, isNaN, isFinite,
    document: makeStub('document'), window: makeStub('window'), navigator: makeStub('navigator'),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: makeStub('location'), alert: () => {}, confirm: () => false, prompt: () => null,
    fetch: () => Promise.resolve(makeStub('fetch')),
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    IntersectionObserver: class { observe(){} disconnect(){} },
    MutationObserver: class { observe(){} disconnect(){} },
    ResizeObserver: class { observe(){} disconnect(){} },
    performance: { now: () => 0 },
    URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams, Promise: globalThis.Promise,
    Error, TypeError, RangeError, Symbol, Map, WeakMap, WeakSet,
  };
  vm.createContext(ctx);
  try { vm.runInContext(fullScript, ctx, { filename: 'index.html' }); }
  catch (e) { if (!ctx.__TUBED__) { console.error('FATAL: sandbox eval failed:', e.message); process.exit(1); } }
  return ctx.__TUBED__;
}

// ── Test framework (minimal, matches network.test.mjs) ──────────────────────
const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: e.message }); }
}

// Guard: the cap is gone. If someone reintroduces a MAX_PATHS beam cap in
// dijkstra, this fails loudly — the whole point of the 2026-08-01 rewrite is
// that the search is admissible (uncapped).
test('dijkstra has no MAX_PATHS beam cap (admissible engine)', () => {
  if (/const\s+MAX_PATHS\s*=/.test(html)) {
    throw new Error('Found "const MAX_PATHS =" in index.html — the capped beam ' +
      'search was reintroduced. dijkstra must stay admissible/uncapped.');
  }
});

const T = loadTubed();
const g = T.buildGraph();
const { bestOneChangeMins, bestTwoChangeMins, osiTime, _stationName } = T;

// The PUBLISHED optimal — pickOptimal's walk-free choice — not routes[0].
// routes[0] is the cheapest candidate including walk-assisted ones, which is
// not what any player is graded against and not what the generator gates on.
// Asserting on it made this suite fail for a route nobody ever sees.
function optRoute(start, end) { const r = T.dijkstra(g, start, end); return r.length ? (T.pickOptimal(r, {start, end}) || r[0]) : null; }
function optMins(start, end) { const r = optRoute(start, end); return r ? r.mins : null; }

const lookup = JSON.parse(readFileSync(LOOKUP_PATH, 'utf8'));
const puzzles = [];
for (const [date, entry] of Object.entries(lookup)) {
  for (const mode of ['easy', 'hard']) {
    const p = entry[mode];
    if (p) puzzles.push({ date, mode, num: entry.puzzleNum, start: p.start, end: p.end });
  }
}

// ── Invariant 1: NO-INVERSION ────────────────────────────────────────────────
// dijkstra's optimal must never be slower than the best 1-change (or 2-change)
// route. Since bestOneChangeMins/bestTwoChangeMins now derive from the same
// engine + cost model as dijkstra, dijkstra (searching ALL change counts) must
// be <= either. A violation means the search missed a route it should have
// found — the exact class of bug (Aldgate East -> Kilburn) that motivated the
// rewrite. Checked across every lookup puzzle.
test('no-inversion: dijkstra optimal <= best 1-change and 2-change route (all lookup puzzles)', () => {
  const bad = [];
  for (const p of puzzles) {
    const opt = optMins(p.start, p.end);
    if (opt == null) continue;
    const one = bestOneChangeMins(p.start, p.end);
    const two = bestTwoChangeMins(p.start, p.end);
    if (Number.isFinite(one) && opt > one + 1e-9) bad.push(`#${p.num} ${p.date} ${p.mode}: ${p.start} -> ${p.end}  opt=${opt} > 1chg=${one}`);
    if (Number.isFinite(two) && opt > two + 1e-9) bad.push(`#${p.num} ${p.date} ${p.mode}: ${p.start} -> ${p.end}  opt=${opt} > 2chg=${two}`);
  }
  if (bad.length) {
    throw new Error(`dijkstra optimal is beaten by a lower-change route (search missed ` +
      `the faster route) for ${bad.length} case(s):\n  ` + bad.slice(0, 40).join('\n  '));
  }
});

// ── Invariant 1b: K IS HIGH ENOUGH ───────────────────────────────────────────
// dijkstra keeps only the K cheapest labels per (station,line,justTransferred)
// state. That eviction is normally harmless (it drops dominated intermediate
// labels, not whole paths), but a future network-data change could make some
// state genuinely need more than K labels — silently under-exploring, exactly
// the failure mode the rewrite killed. Guard it: a deeper K must never find a
// cheaper optimal. If this fails, raise K in index.html.
test('shipped K is high enough: a deeper label cap finds no cheaper optimal', () => {
  const Tdeep = loadTubed(32);
  const gDeep = Tdeep.buildGraph();
  const worse = [];
  for (const p of puzzles) {
    const ship = optMins(p.start, p.end);
    const rDeep = Tdeep.dijkstra(gDeep, p.start, p.end);
    const oDeep = rDeep.length ? (Tdeep.pickOptimal(rDeep, {start: p.start, end: p.end}) || rDeep[0]) : null;
    const deep = oDeep ? oDeep.mins : null;
    if (deep == null) continue;
    if (ship == null || ship > deep + 1e-9) {
      worse.push(`#${p.num} ${p.date} ${p.mode}: ${p.start} -> ${p.end}  K=6=${ship == null ? 'NONE' : ship} K=32=${deep}`);
    }
  }
  if (worse.length) {
    throw new Error(`dijkstra's label cap K under-explores: a deeper K found a cheaper ` +
      `optimal for ${worse.length} puzzle(s). Raise K in index.html:\n  ` + worse.slice(0, 20).join('\n  '));
  }
});

// ── Invariant 2: STRUCTURAL CONTIGUITY ───────────────────────────────────────
// Every returned route's legs must join up: leg[i].from is leg[i-1].to, OR an
// OSI-walk pair, OR a cross-complex interchange (Bank<->Monument). A gap means a
// teleport — a broken search or path reconstruction that under-counts cost.
function hasInterchangeEdge(fromName, toName) {
  const node = g[fromName]; if (!node) return false;
  for (const line of Object.keys(node)) for (const e of node[line]) {
    if (e.type === 'interchange' && _stationName(e.station) === toName) return true;
  }
  return false;
}
function firstGap(legs) {
  for (let i = 1; i < legs.length; i++) {
    const prevTo = legs[i - 1].to, curFrom = legs[i].from;
    if (prevTo === curFrom) continue;
    if (osiTime(prevTo, curFrom) != null) continue;
    if (hasInterchangeEdge(prevTo, curFrom)) continue;
    return { at: i, prevTo, curFrom };
  }
  return null;
}
test('structural: every returned route is contiguous (no teleports) across all lookup puzzles', () => {
  const bad = [];
  for (const p of puzzles) {
    const routes = T.dijkstra(g, p.start, p.end);
    for (const r of routes) {
      const gap = firstGap(r.legs);
      if (gap) bad.push(`#${p.num} ${p.date} ${p.mode}: ${p.start} -> ${p.end} leg ${gap.at} jumps ${gap.prevTo} -> ${gap.curFrom}`);
    }
  }
  if (bad.length) throw new Error(`${bad.length} non-contiguous route(s):\n  ` + bad.slice(0, 30).join('\n  '));
});

// ── Invariant 3: NAMED REGRESSIONS ───────────────────────────────────────────
// The specific pairs that surfaced the cap bug must resolve to their true
// optimal (found only by the uncapped search).
test('regression: Chancery Lane -> Richmond resolves to the true optimal (#104)', () => {
  // The bug this guards is the capped search HIDING the true optimal, so the
  // assertion is "the shipped cap finds what an uncapped search finds" — not a
  // hardcoded minute count. A fixed threshold here encodes the cost model of
  // whichever build wrote it: this pair legitimately costs more once boarding
  // charges the Richmond-branch frequency at Earl's Court rather than the
  // District trunk frequency, and a literal 49 would fail a correct build for
  // the wrong reason.
  const m = optMins('Chancery Lane', 'Richmond');
  if (m == null) throw new Error('no route Chancery Lane -> Richmond');
  const Tdeep = loadTubed(64);
  const gDeep = Tdeep.buildGraph();
  const rDeep = Tdeep.dijkstra(gDeep, 'Chancery Lane', 'Richmond');
  const oDeep = rDeep.length ? (Tdeep.pickOptimal(rDeep, {start:'Chancery Lane', end:'Richmond'}) || rDeep[0]) : null;
  if (!oDeep) throw new Error('uncapped search found no route Chancery Lane -> Richmond');
  if (m > oDeep.mins + 1e-9) {
    throw new Error(`Chancery Lane -> Richmond: shipped cap gives ${m}, uncapped finds ${oDeep.mins}.`);
  }
});
test('regression: Aldgate East -> Kilburn optimal is the 1-change route the cap missed', () => {
  const r = optRoute('Aldgate East', 'Kilburn');
  if (!r) throw new Error('no route Aldgate East -> Kilburn');
  const changes = T.countDistinctChanges(r);
  // The cap returned a 31-min 2-change route; the true optimal is a 30-min
  // 1-change route (District -> Westminster -> Jubilee).
  if (!(r.mins <= 31 && changes <= 1)) {
    throw new Error(`Aldgate East -> Kilburn optimal is ${r.mins}min/${changes}chg, ` +
      `expected the ~30min 1-change route.`);
  }
});
test('regression: Wembley Central -> Limehouse optimal is the clean 2-change route the cap missed', () => {
  const r = optRoute('Wembley Central', 'Limehouse');
  if (!r) throw new Error('no route Wembley Central -> Limehouse');
  // Cap-16/64/128 all returned a 56-min walk-heavy route; true optimal is a
  // 54-min Bakerloo -> Central -> DLR route.
  if (r.mins > 54) throw new Error(`Wembley Central -> Limehouse optimal is ${r.mins}, expected <=54.`);
});

// pickOptimal() is the single chokepoint every todayPuzzle return path uses to
// turn ranked routes into the published optimal. Invariant: the optimal is
// non-empty and pure-tube (no Walk legs). These unit checks pin that contract
// so a refactor can't silently reintroduce a walk/empty optimal.
test('pickOptimal: prefers the cheapest pure-tube route over a cheaper walk route', () => {
  const walk = { mins: 10, legs: [{ line: 'Walk', from: 'A', to: 'B' }, { line: 'Victoria', from: 'B', to: 'C' }] };
  const tube = { mins: 12, legs: [{ line: 'Central', from: 'A', to: 'B' }, { line: 'Victoria', from: 'B', to: 'C' }] };
  const r = T.pickOptimal([walk, tube], { start: 'A', end: 'C' });
  if (!r || r.mins !== 12) throw new Error(`expected the 12-min tube route, got ${r ? r.mins : 'null'}`);
  if (r.legs.some(l => l.line === 'Walk')) throw new Error('picked a route containing a Walk leg');
});
test('pickOptimal: returns null for empty/degenerate input (no throw)', () => {
  if (T.pickOptimal([], {}) !== null) throw new Error('empty list should give null');
  if (T.pickOptimal(null, {}) !== null) throw new Error('null should give null');
  if (T.pickOptimal([{ mins: 0, legs: [] }], {}) !== null) throw new Error('all-empty routes should give null');
});
test('pickOptimal: falls back to a walk route only when no tube route exists', () => {
  const walk = { mins: 10, legs: [{ line: 'Walk', from: 'A', to: 'B' }, { line: 'Victoria', from: 'B', to: 'C' }] };
  const r = T.pickOptimal([walk], { start: 'A', end: 'C' });
  if (!r || r.mins !== 10) throw new Error('should fall back to the only (walk) route so the game still runs');
});

// End-to-end invariant: every TODAY-OR-FUTURE published optimal is non-empty
// and pure-tube. This is the real user-facing guarantee — a walk or empty
// optimal reaching the card/hints/share is the bug class pickOptimal exists to
// prevent. Past dates are excluded on purpose: those puzzles are already played
// and their pairs are immutable history (regenerating them would rewrite player
// results and desync from what Reddit posted). Regenerate the FUTURE lookup via
// build-lookup.mjs whenever this test names an upcoming date.
test('every today-or-future lookup puzzle publishes a non-empty, walk-free optimal', () => {
  const todayIso = new Date().toISOString().slice(0, 10);
  const bad = [];
  for (const p of puzzles) {
    if (p.date < todayIso) continue; // immutable past — see note above
    const routes = T.dijkstra(g, p.start, p.end);
    const opt = T.pickOptimal(routes, { start: p.start, end: p.end });
    if (!opt || opt.legs.length === 0) {
      bad.push(`#${p.num} ${p.date} ${p.mode}: ${p.start} -> ${p.end} (empty/null optimal)`);
    } else if (opt.legs.some(l => l.line === 'Walk')) {
      bad.push(`#${p.num} ${p.date} ${p.mode}: ${p.start} -> ${p.end} (optimal contains a Walk leg)`);
    }
  }
  if (bad.length) {
    throw new Error(`${bad.length} upcoming lookup puzzle(s) publish an invalid optimal ` +
      `(regenerate the future lookup via build-lookup.mjs):\n  ` + bad.join('\n  '));
  }
});

// ── Invariant 4: THE LOAD RACE STAYS FIXED (source-level guards) ──────────────
// The lookup is the source of truth shared with Reddit. On a cold load the
// seeded in-browser generator diverges from it (the lookup has a per-station
// cooldown the generator lacks), so the first render MUST wait for the lookup
// before calling todayPuzzle() — otherwise the site caches a generator pair that
// disagrees with Reddit until localStorage is cleared. That fix lives in the
// page's async load path, which the DOM-stub sandbox above can't exercise
// faithfully (Date/window/localStorage are baked into the vm context at eval
// time). So we assert the fix at the source level: the pieces that make the
// oracle win must be present. If someone removes them, the race returns.
test('load-race fix present: init awaits the lookup and the cache is guarded', () => {
  const missing = [];
  // 1. init() is async (so it can await the lookup).
  if (!/async\s+function\s+init\s*\(/.test(html)) missing.push('init() is no longer async');
  // 2. init() awaits the lookup-ready promise before the first render.
  if (!/await\s+_lookupReady/.test(html)) missing.push('init() no longer awaits _lookupReady');
  // 3. _preloadPuzzleLookup returns a promise init can await (Promise.race with a timeout).
  if (!/_lookupReady\s*=\s*_preloadPuzzleLookup\(\)/.test(html)) missing.push('_lookupReady is not wired to _preloadPuzzleLookup()');
  if (!/Promise\.race/.test(html)) missing.push('_preloadPuzzleLookup no longer races a timeout (page could block)');
  // 4. the generator does not persist a pair while the lookup is still pending.
  if (!/_LOOKUP_SETTLED/.test(html) || !/lookupPending/.test(html)) missing.push('the lookup-pending cache guard was removed');
  if (missing.length) {
    throw new Error('The lookup-vs-generator load-race fix has regressed:\n  - ' + missing.join('\n  - '));
  }
});

// ── Report ──────────────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok);
console.log(`\n${passed}/${results.length} tests passed`);
for (const f of failed) {
  console.log(`\n❌ ${f.name}`);
  console.log(`   ${f.error}`);
}
if (failed.length) process.exit(1);
console.log('\n✓ All tests passed');
