// End-to-end snapshot tests for Tubed wait-times release.
// Run with: node tests/wait_times_e2e.test.mjs
//
// These exercise renderResultCard() with real dijkstra/buildUserLegs output
// and a real (Node-memory) localStorage mock, asserting that:
//   - First render writes a current-version snapshot (covers #3 v1→v2)
//   - Second render reads from the snapshot (totals stable across refresh)
//   - Bumping SCORING_VERSION triggers a recompute + new snapshot
//   - v1-shape snapshot is treated as missing/stale and recomputed
//   - The result-card HTML reflects walk + wait breakdowns (covers #2/#4)
//   - Circle teardrop pivots produce correct per-direction waits in the
//     rendered output (covers #1/#2)
//
// No DOM is required — renderResultCard() is a pure function that returns
// an HTML string, and getModeStore/setModeStore go through localStorage.

import { readFileSync } from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, '..', 'index.html');
const html = readFileSync(HTML_PATH, 'utf8');

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

// Need to also write a mutable SCORING_VERSION for the bump test, so we
// export a setter helper alongside everything else.
const exportSuffix = `
;globalThis.__TUBED__ = {
  NETWORK, COORDS,
  displayLine, getTime, interchangeTime,
  buildGraph, dijkstra, buildUserLegs,
  waitTime, firstHopOnLeg,
  renderResultCard, renderRouteLegsHtml,
  getModeStore, setModeStore, emptyModeStore,
  get SCORING_VERSION() { return SCORING_VERSION; },
};`;
const fullScript = scripts.join('\n;\n') + exportSuffix;

function makeStub(name = 'stub') {
  const fn = function(){ return makeStub(name + '()'); };
  return new Proxy(fn, {
    get(_t, p) {
      if (p === Symbol.toPrimitive) return () => '';
      if (p === 'then') return undefined;
      if (p === 'length') return 0;
      if (p === 'forEach' || p === 'map' || p === 'filter') return () => [];
      return makeStub(`${name}.${String(p)}`);
    },
    apply() { return makeStub(name + '()'); },
    has() { return true },
  });
}

// Real in-memory localStorage — needed for snapshot round-trip.
function makeStorage() {
  const data = {};
  return {
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
    clear: () => { Object.keys(data).forEach(k => delete data[k]); },
    get length() { return Object.keys(data).length; },
    key: i => Object.keys(data)[i] ?? null,
    _raw: data,
  };
}
const localStorage = makeStorage();

const ctx = {
  console,
  Date, Math, Object, Array, Set, Map, JSON, Number, String, Boolean, RegExp,
  parseInt, parseFloat, isNaN, isFinite,
  document: makeStub('document'),
  window:   makeStub('window'),
  navigator: makeStub('navigator'),
  localStorage,
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  location: makeStub('location'),
  alert: () => {},
  confirm: () => false,
  prompt: () => null,
  fetch: () => Promise.resolve(makeStub('fetch')),
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  IntersectionObserver: class { observe(){} disconnect(){} },
  MutationObserver: class { observe(){} disconnect(){} },
  ResizeObserver: class { observe(){} disconnect(){} },
  performance: { now: () => 0 },
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  Promise: globalThis.Promise,
  Error, TypeError, RangeError,
  Symbol, Map, WeakMap, WeakSet,
};
vm.createContext(ctx);

try {
  vm.runInContext(fullScript, ctx);
} catch (e) {
  if (!ctx.__TUBED__) {
    console.error('FATAL: required functions not defined after eval');
    console.error('  error:', e.message);
    process.exit(1);
  }
}

const T = ctx.__TUBED__;
const {
  buildGraph, dijkstra, buildUserLegs,
  renderResultCard,
  getModeStore, setModeStore, emptyModeStore,
} = T;

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
function contains(haystack, needle, msg) {
  if (!haystack.includes(needle)) {
    throw new Error(`${msg || 'contains'}: expected to find ${JSON.stringify(needle)} in output`);
  }
}
function notContains(haystack, needle, msg) {
  if (haystack.includes(needle)) {
    throw new Error(`${msg || 'notContains'}: did not expect to find ${JSON.stringify(needle)} in output`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
const GRAPH = buildGraph();

function optimal(from, to) {
  const routes = dijkstra(GRAPH, from, to);
  if (!routes || routes.length === 0) throw new Error(`no route ${from} → ${to}`);
  return routes[0];
}

function makePuzzle(start, end) {
  return {
    start, end,
    optimal: optimal(start, end),
    routes: [optimal(start, end)],
    date: '2026-06-22',
    puzzleNum: 1,
    graph: GRAPH,
    mode: 'hard',
  };
}

// Convert a user route (start + waypoint list) into the userLegsData shape
// renderResultCard expects.
function makeUserLegsData(start, waypoints) {
  return buildUserLegs(start, waypoints);
}

// Fresh mode store between tests.
function resetStore(mode = 'hard') {
  localStorage.clear();
  setModeStore(mode, emptyModeStore());
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('e2e: renderResultCard produces an HTML string', () => {
  resetStore();
  const pd = makePuzzle('Victoria', 'Ladbroke Grove');
  const userLegsData = makeUserLegsData('Victoria', [
    {station: 'Paddington', line: 'Circle'},
    {station: 'Ladbroke Grove', line: 'Circle'},
  ]);
  const html = renderResultCard({
    puzzleData: pd, userLegsData, hintsUsed: 0, completionSecs: 60, mode: 'hard',
  });
  truthy(typeof html === 'string' && html.length > 100, 'should return non-trivial HTML');
  contains(html, 'result-card');
});

test('e2e: first render writes a snapshot at current SCORING_VERSION', () => {
  resetStore();
  const pd = makePuzzle('Victoria', 'Ladbroke Grove');
  const userLegsData = makeUserLegsData('Victoria', [
    {station: 'Paddington', line: 'Circle'},
    {station: 'Ladbroke Grove', line: 'Circle'},
  ]);
  // Pre-render: no snapshot.
  const before = getModeStore('hard');
  falsy(before.submittedScoring, 'no snapshot before render');
  // Render.
  renderResultCard({ puzzleData: pd, userLegsData, hintsUsed: 0, completionSecs: 60, mode: 'hard' });
  // Post-render: snapshot present at current version.
  const after = getModeStore('hard');
  truthy(after.submittedScoring, 'snapshot written after first render');
  eq(after.submittedScoring.version, T.SCORING_VERSION, 'snapshot has current version');
  truthy(typeof after.submittedScoring.userMins === 'number', 'snapshot has userMins');
  truthy(after.submittedScoring.optLegs, 'snapshot has optLegs (covers #4)');
  truthy(after.submittedScoring.optInterchanges, 'snapshot has optInterchanges (covers #4)');
  truthy(after.submittedScoring.userLegs, 'snapshot has userLegs (covers #4)');
});

test('e2e: second render is byte-identical to first (snapshot stable)', () => {
  resetStore();
  const pd = makePuzzle('Victoria', 'Ladbroke Grove');
  const userLegsData = makeUserLegsData('Victoria', [
    {station: 'Paddington', line: 'Circle'},
    {station: 'Ladbroke Grove', line: 'Circle'},
  ]);
  const first  = renderResultCard({ puzzleData: pd, userLegsData, hintsUsed: 0, completionSecs: 60, mode: 'hard' });
  const second = renderResultCard({ puzzleData: pd, userLegsData, hintsUsed: 0, completionSecs: 60, mode: 'hard' });
  eq(first, second, 'rendered HTML must not drift across renders');
});

test('e2e: v1-shape snapshot (missing version) is replaced with current-version snapshot', () => {
  resetStore();
  // Plant a v1-style snapshot — has fields but no version, or version=1.
  const store = emptyModeStore();
  store.submittedScoring = {
    // No `version` field at all, like a hypothetical v1 record.
    userMins: 99, optimalMins: 50, diff: 49,
    medal: '🚇', medalColor: 'gray', medalTitle: 'Old', medalSubtitle: 'Old',
  };
  setModeStore('hard', store);

  const pd = makePuzzle('Victoria', 'Ladbroke Grove');
  const userLegsData = makeUserLegsData('Victoria', [
    {station: 'Paddington', line: 'Circle'},
    {station: 'Ladbroke Grove', line: 'Circle'},
  ]);
  renderResultCard({ puzzleData: pd, userLegsData, hintsUsed: 0, completionSecs: 60, mode: 'hard' });

  const after = getModeStore('hard');
  eq(after.submittedScoring.version, T.SCORING_VERSION, 'v1 snapshot upgraded to current version');
  // Should reflect recomputed values, not the planted v1 nonsense.
  truthy(after.submittedScoring.userMins !== 99, 'userMins was recomputed (no longer 99)');
});

test('e2e: explicit v1-version snapshot also triggers recompute', () => {
  resetStore();
  const store = emptyModeStore();
  store.submittedScoring = {
    version: 1, userMins: 99, optimalMins: 50, diff: 49,
    medal: '🚇', medalColor: 'gray', medalTitle: 'Old', medalSubtitle: 'Old',
  };
  setModeStore('hard', store);

  const pd = makePuzzle('Victoria', 'Ladbroke Grove');
  const userLegsData = makeUserLegsData('Victoria', [
    {station: 'Paddington', line: 'Circle'},
    {station: 'Ladbroke Grove', line: 'Circle'},
  ]);
  renderResultCard({ puzzleData: pd, userLegsData, hintsUsed: 0, completionSecs: 60, mode: 'hard' });

  const after = getModeStore('hard');
  eq(after.submittedScoring.version, T.SCORING_VERSION);
  truthy(after.submittedScoring.userMins !== 99);
});

test('e2e: rendered HTML is invariant to underlying data changes once snapshot exists', () => {
  resetStore();
  const pd = makePuzzle('Victoria', 'Ladbroke Grove');
  const userLegsData = makeUserLegsData('Victoria', [
    {station: 'Paddington', line: 'Circle'},
    {station: 'Ladbroke Grove', line: 'Circle'},
  ]);
  // First render writes a snapshot AND produces HTML showing real numbers.
  const html1 = renderResultCard({ puzzleData: pd, userLegsData, hintsUsed: 0, completionSecs: 60, mode: 'hard' });
  const snap1 = JSON.stringify(getModeStore('hard').submittedScoring);

  // Simulate scoring data changing under the player's feet: totalMins
  // becomes 999 in the recomputed userLegsData. The snapshot read path
  // must short-circuit, ignoring the new value entirely. If the read path
  // is bypassed OR the write path overwrites the snapshot, we fail.
  const fakeUserLegsData = JSON.parse(JSON.stringify(userLegsData));
  fakeUserLegsData.totalMins = 999;
  // Mutate every leg's mins too so any path that recomputes from legs
  // would produce a visibly-different result.
  fakeUserLegsData.legs.forEach(l => { l.mins = 333; });
  fakeUserLegsData.interchanges.forEach(ic => { if (ic) { ic.mins = 444; ic.walkMins = 222; ic.waitMins = 222; } });

  const html2 = renderResultCard({ puzzleData: pd, userLegsData: fakeUserLegsData, hintsUsed: 0, completionSecs: 60, mode: 'hard' });
  const snap2 = JSON.stringify(getModeStore('hard').submittedScoring);

  eq(snap1, snap2, 'snapshot must not be overwritten by recomputed values');
  // The HTML output must NOT show the doctored 999/333/444 numbers.
  notContains(html2, '999', 'rendered HTML must not show recomputed totalMins=999');
  notContains(html2, '>333<', 'rendered HTML must not show recomputed leg mins=333');
  notContains(html2, '+444 min', 'rendered HTML must not show recomputed interchange mins=444');
  eq(html1, html2, 'HTML output must be byte-identical when snapshot is active');
});

test('e2e: rendered HTML displays walk+wait breakdown for the change at Paddington', () => {
  resetStore();
  const pd = makePuzzle('Victoria', 'Ladbroke Grove');
  const userLegsData = makeUserLegsData('Victoria', [
    {station: 'Paddington', line: 'Circle'},
    {station: 'Ladbroke Grove', line: 'Circle'},
  ]);
  const html = renderResultCard({
    puzzleData: pd, userLegsData, hintsUsed: 0, completionSecs: 60, mode: 'hard',
  });
  contains(html, 'Change at Paddington', 'should mention the change station');
  // Format: "+12 min (7 walk + 5 wait)" - assert the breakdown words.
  contains(html, 'walk +', 'should show walk breakdown');
  contains(html, 'wait)', 'should show wait breakdown');
});

test('e2e: Paddington pivot wait reflects Circle headway (covers #1 direction-sensitive)', () => {
  resetStore();
  // User route: Victoria → Paddington → Ladbroke Grove on Circle.
  // The interchange at Paddington should show waitMins=5 (Circle teardrop
  // pivot, floored half of the ~10-min median Circle headway). If waitTime
  // were poisoned across directions or routing the wrong "to" through
  // firstHopOnLeg, we'd get a different value.
  const userLegsData = makeUserLegsData('Victoria', [
    {station: 'Paddington', line: 'Circle'},
    {station: 'Ladbroke Grove', line: 'Circle'},
  ]);
  const interchange = userLegsData.interchanges.find(x => x && x.at === 'Paddington');
  truthy(interchange, 'should have a Paddington interchange');
  eq(interchange.walkMins, 7, '7-min cross-platform walk between Circle teardrops');
  eq(interchange.waitMins, 5, 'Circle floored half-headway wait');
  eq(interchange.mins, 12);
});

test('e2e: Edgware Road pivot wait resolves per-pivot (direction sanity)', () => {
  resetStore();
  // At Edgware Road on Circle the wait is 5 (combined shared-platform
  // frequency). This catches a regression where waitTime might return the
  // wrong headway for the Circle at this specific pivot.
  const userLegsData = makeUserLegsData('Victoria', [
    {station: 'Edgware Road', line: 'Circle'},
    {station: 'Ladbroke Grove', line: 'Circle'},
  ]);
  const interchange = userLegsData.interchanges.find(x => x && x.at === 'Edgware Road');
  truthy(interchange, 'should have an Edgware Road interchange');
  eq(interchange.waitMins, 5, 'Circle wait at Edgware Road (shared-platform frequency)');
});

test('e2e: snapshot survives a localStorage round-trip (full serialise/parse)', () => {
  resetStore();
  const pd = makePuzzle('Victoria', 'Ladbroke Grove');
  const userLegsData = makeUserLegsData('Victoria', [
    {station: 'Paddington', line: 'Circle'},
    {station: 'Ladbroke Grove', line: 'Circle'},
  ]);
  const html1 = renderResultCard({ puzzleData: pd, userLegsData, hintsUsed: 0, completionSecs: 60, mode: 'hard' });

  // Simulate page reload: nothing should be in memory, only localStorage.
  // (Our mock storage is already what `getStore` reads from.) Read the raw
  // serialised value and re-parse it, then render again. The result must
  // match.
  const raw = localStorage.getItem('tubepzl_v6');
  truthy(raw, 'snapshot should be persisted in tubepzl_v6');
  const parsed = JSON.parse(raw);
  truthy(parsed.hard.submittedScoring, 'snapshot in serialised form');

  // Second render reads the snapshot back.
  const html2 = renderResultCard({ puzzleData: pd, userLegsData, hintsUsed: 0, completionSecs: 60, mode: 'hard' });
  eq(html1, html2, 'render output stable across simulated reload');
});

test('e2e: result-card numbers add up (userMins == sum of legs + interchanges)', () => {
  resetStore();
  // A solved puzzle where the player took the optimal route. The visible
  // totals at the top should equal the sum of the per-leg + per-interchange
  // numbers shown below — otherwise players see arithmetic that does not
  // add up.
  const pd = makePuzzle('Victoria', 'Ladbroke Grove');
  const userLegsData = makeUserLegsData('Victoria', [
    {station: 'Paddington', line: 'Circle'},
    {station: 'Ladbroke Grove', line: 'Circle'},
  ]);
  let sum = userLegsData.legs.reduce((s, l) => s + l.mins, 0);
  sum += userLegsData.interchanges.reduce((s, ic) => s + (ic ? ic.mins : 0), 0);
  eq(sum, userLegsData.totalMins, `legs+interchanges (${sum}) must equal totalMins (${userLegsData.totalMins})`);
});

test('e2e: optimal route from dijkstra carries branchLine on every non-walk leg', () => {
  // renderResultCard needs branchLine on every non-walk optimal leg to
  // compute correct wait. If pathToLegs ever stops populating it, the
  // result-card wait values silently default to WAIT_MINS_DEFAULT.
  const pd = makePuzzle('Victoria', 'Stratford');  // multi-change route
  for (const leg of pd.optimal.legs) {
    if (leg.line === 'Walk') continue;
    truthy(leg.branchLine, `leg ${leg.from}→${leg.to} on ${leg.line} must have branchLine`);
  }
});

test('e2e: snapshot is DATE-SCOPED - solving date D1 does not leak into date D2 render', () => {
  // Regression test for the bug that caused the 2026-06-22 launch revert:
  // submittedScoring was stored per-mode but not per-date. Solving date D1
  // wrote a snapshot; rendering date D2 (e.g. via test-mode date jump or
  // simply because the date rolled over) saw a matching version and
  // returned D1's stale numbers on top of D2's puzzle. Wrong puzzle, wrong
  // medal.
  resetStore();

  // Solve date D1 (Victoria → Ladbroke Grove on Circle).
  const pdD1 = makePuzzle('Victoria', 'Ladbroke Grove');
  pdD1.date = '2026-06-22';
  const userLegsD1 = makeUserLegsData('Victoria', [
    {station: 'Paddington', line: 'Circle'},
    {station: 'Ladbroke Grove', line: 'Circle'},
  ]);
  const htmlD1 = renderResultCard({ puzzleData: pdD1, userLegsData: userLegsD1, hintsUsed: 0, completionSecs: 60, mode: 'hard' });
  const snapAfterD1 = getModeStore('hard').submittedScoring;
  truthy(snapAfterD1, 'D1 snapshot was written');
  eq(snapAfterD1.date, '2026-06-22', 'snapshot must carry the date it was solved on');

  // Now render date D2 (a completely different puzzle).
  const pdD2 = makePuzzle('Victoria', 'Stratford');  // different end, different optimal
  pdD2.date = '2026-06-23';
  const userLegsD2 = makeUserLegsData('Victoria', [
    {station: 'Green Park', line: 'Victoria'},
    {station: 'Oxford Circus', line: 'Victoria'},
    {station: 'Stratford', line: 'Central'},
  ]);
  const htmlD2 = renderResultCard({ puzzleData: pdD2, userLegsData: userLegsD2, hintsUsed: 0, completionSecs: 90, mode: 'hard' });

  // Critical asserts:
  // 1. HTML must reflect D2's puzzle, NOT D1's snapshotted numbers.
  truthy(!htmlD2.includes('Ladbroke Grove'), 'D2 HTML must not show D1 destination Ladbroke Grove');
  contains(htmlD2, 'Stratford', 'D2 HTML must show D2 destination Stratford');
  // 2. D1 snapshot should still be intact (we don't OVERWRITE other dates' snapshots,
  //    but the current store only holds one snapshot at a time - so it'll have been
  //    REPLACED by D2's. That's a simplification we accept - the important thing is
  //    that D2 didn't render with D1's data).
  const snapAfterD2 = getModeStore('hard').submittedScoring;
  eq(snapAfterD2.date, '2026-06-23', 'snapshot date must now be D2');
  truthy(snapAfterD2.userMins !== snapAfterD1.userMins
      || snapAfterD2.optimalMins !== snapAfterD1.optimalMins,
      'D2 snapshot must contain D2 numbers, not D1 numbers');
});

test('e2e: re-rendering the SAME date keeps the snapshot stable (no date-scope regression)', () => {
  // Sanity: the date-scoping fix should NOT break the "refresh same puzzle"
  // case. Solve date D, render, render again - HTML must be identical, snapshot unchanged.
  resetStore();
  const pd = makePuzzle('Victoria', 'Ladbroke Grove');
  pd.date = '2026-06-22';
  const userLegsData = makeUserLegsData('Victoria', [
    {station: 'Paddington', line: 'Circle'},
    {station: 'Ladbroke Grove', line: 'Circle'},
  ]);
  const html1 = renderResultCard({ puzzleData: pd, userLegsData, hintsUsed: 0, completionSecs: 60, mode: 'hard' });
  const snap1 = JSON.stringify(getModeStore('hard').submittedScoring);
  const html2 = renderResultCard({ puzzleData: pd, userLegsData, hintsUsed: 0, completionSecs: 60, mode: 'hard' });
  const snap2 = JSON.stringify(getModeStore('hard').submittedScoring);
  eq(html1, html2, 'same date re-render must produce identical HTML');
  eq(snap1, snap2, 'same date re-render must not modify the snapshot');
});

// ── Run + report ──────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
const passed = results.filter(r => r.ok);
console.log('');
for (const r of results) {
  console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}`);
  if (!r.ok) console.log(`      ${r.error}`);
}
console.log('');
console.log(`${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
