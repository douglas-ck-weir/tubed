// Dijkstra admissibility regression test for Tubed.
// Run with: node tests/dijkstra_optimal.test.mjs
// Exits 0 on success, 1 on any failure.
//
// WHY THIS EXISTS
// ---------------
// dijkstra() is a bounded k-shortest-paths search: it keeps at most MAX_PATHS
// candidate paths per (station, line) so that equal-cost routes via different
// interchanges all survive to the results stage. If MAX_PATHS is too small,
// the search under-explores long, branch-dense corridors (District/Circle in
// West London are the worst) and can EVICT the genuinely-optimal path before
// it reaches the destination. When that happens the game publishes a too-slow
// "optimal" that players beat with a faster real route — while scoreUserRoute
// (which scores the player's typed route with no cap) reports the true, lower
// time. The two engines disagree and the "OPTIMAL!" badge is wrong.
//
// This actually shipped: puzzle #104 (Chancery Lane -> Richmond) reported a
// 51-min optimal while a real 48-min route existed. Root cause was MAX_PATHS=8;
// it was raised to 16.
//
// THE INVARIANT
// -------------
// Re-run dijkstra at a strictly larger cap. If the larger search ever finds a
// CHEAPER optimal than the shipped cap, the shipped cap is under-exploring and
// the published optimal is beatable. We check this on the puzzles most likely
// to trip the cap (the longest optimal routes) plus a named guard for #104.
//
// This is intentionally scoped to the longest routes so the test stays fast
// enough for routine runs (the larger cap re-runs the slow pq.sort() search).

import { readFileSync } from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, '..', 'index.html');
const LOOKUP_PATH = path.join(__dirname, '..', 'puzzle-lookup.json');
const html = readFileSync(HTML_PATH, 'utf8');

// The cap shipped in index.html. Kept in sync via the assertion below so this
// test fails loudly if someone changes MAX_PATHS without revisiting it.
const SHIPPED_CAP = 16;
// A strictly larger cap to probe whether the shipped cap under-explores. The
// empirical cap-8-vs-64 sweep found every published puzzle converges by ~24,
// so 32 sits comfortably above the convergence point: if 16 ever disagrees
// with 32 we know 16 is under-exploring. Note this proves "16 == 32", not
// "16 is truly optimal" — the guarantee rests on 32 being past convergence.
const PROBE_CAP = 32;
// How many of the longest-optimal puzzles to stress. Longer routes are the
// ones that thread branch-dense corridors and trip the cap. 30 keeps runtime
// near ~80s at PROBE_CAP=32; the #104 route sits ~rank 28 by distance so it
// stays in the set, and is independently covered by the named guard below.
const STRESS_N = 30;

// ── Sandbox loader ──────────────────────────────────────────────────────────
// Loads index.html into a stubbed-DOM sandbox, optionally rewriting MAX_PATHS
// so we can run the same dijkstra at two different caps.
function loadTubed(maxPaths) {
  let src = html;
  if (maxPaths !== SHIPPED_CAP) {
    const needle = `const MAX_PATHS = ${SHIPPED_CAP};`;
    if (!src.includes(needle)) {
      console.error(`FATAL: could not find "${needle}" in index.html. ` +
        `Has the shipped cap changed? Update SHIPPED_CAP in this test.`);
      process.exit(1);
    }
    src = src.replace(needle, `const MAX_PATHS = ${maxPaths};`);
  }
  const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const exportSuffix = `;globalThis.__TUBED__ = { buildGraph, dijkstra, COORDS };`;
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

// Assert index.html still uses the cap this test was written against. If this
// fails, someone changed MAX_PATHS — re-read the WHY block above and update
// SHIPPED_CAP (and confirm the new value is still admissible).
test(`index.html MAX_PATHS is the expected shipped cap (${SHIPPED_CAP})`, () => {
  if (!html.includes(`const MAX_PATHS = ${SHIPPED_CAP};`)) {
    throw new Error(`Expected "const MAX_PATHS = ${SHIPPED_CAP};" in index.html but did not find it.`);
  }
});

const Tship = loadTubed(SHIPPED_CAP);
const Tprobe = loadTubed(PROBE_CAP);
const gShip = Tship.buildGraph();
const gProbe = Tprobe.buildGraph();

function optMins(T, g, start, end) {
  const r = T.dijkstra(g, start, end);
  return r.length ? r[0].mins : null;
}

// Build the stress set. We want the puzzles most likely to trip the cap: the
// longest routes, which thread the most branch-dense corridors. Ranking by the
// true optimal would mean a full dijkstra pass over all 256 puzzles (slow), so
// we rank by great-circle distance between endpoints instead — a cheap proxy
// that reliably surfaces the long cross-London routes. We then run BOTH caps
// only on the top STRESS_N candidates.
const { COORDS } = Tship;
function geoDist(a, b) {
  const ca = COORDS[a], cb = COORDS[b];
  if (!ca || !cb) return -1; // unknown endpoints sort last
  const [latA, lonA] = ca, [latB, lonB] = cb;
  const dLat = latA - latB, dLon = (lonA - lonB) * Math.cos((latA + latB) / 2 * Math.PI / 180);
  return Math.hypot(dLat, dLon);
}

const lookup = JSON.parse(readFileSync(LOOKUP_PATH, 'utf8'));
const puzzles = [];
for (const [date, entry] of Object.entries(lookup)) {
  for (const mode of ['easy', 'hard']) {
    const p = entry[mode];
    if (p) puzzles.push({ date, mode, num: entry.puzzleNum, start: p.start, end: p.end });
  }
}
const stress = puzzles
  .map(p => ({ ...p, dist: geoDist(p.start, p.end) }))
  .sort((a, b) => b.dist - a.dist)
  .slice(0, STRESS_N);

// Core invariant: on the longest routes, the shipped cap must not be beaten by
// a deeper search. If the probe cap finds a cheaper optimal, the shipped cap is
// under-exploring and the published optimal is beatable.
test(`shipped cap (${SHIPPED_CAP}) is admissible on the ${STRESS_N} longest puzzles (probe cap ${PROBE_CAP})`, () => {
  const beatable = [];
  for (const p of stress) {
    const shipMins = optMins(Tship, gShip, p.start, p.end);
    const probeMins = optMins(Tprobe, gProbe, p.start, p.end);
    if (probeMins == null) continue; // deeper search found nothing either — not a cap symptom
    // shipMins == null while the deeper search DID find a route is the most
    // severe under-exploration: the shipped cap fails to find any route at all
    // and would publish no/blank optimal. Treat as beatable (Infinity).
    const shipCost = shipMins == null ? Infinity : shipMins;
    if (probeMins < shipCost) {
      beatable.push(`#${p.num} ${p.date} ${p.mode}: ${p.start} -> ${p.end}  ` +
        `shipped=${shipMins == null ? 'NONE' : shipMins} deeperSearch=${probeMins} ` +
        `(beatable by ${shipMins == null ? '∞' : shipMins - probeMins}min)`);
    }
  }
  if (beatable.length) {
    throw new Error(
      `dijkstra at MAX_PATHS=${SHIPPED_CAP} under-explores; a deeper search ` +
      `(MAX_PATHS=${PROBE_CAP}) found cheaper optimals for ${beatable.length} puzzle(s), ` +
      `meaning the published "optimal" is beatable:\n  ` + beatable.join('\n  ') +
      `\nRaise MAX_PATHS in index.html until this passes.`
    );
  }
});

// Named regression guard for the puzzle that surfaced the bug. Chancery Lane ->
// Richmond must resolve to the true 47-min optimal (Oxford Circus -> Victoria ->
// District), not the 51-min route the old cap published.
test('regression: Chancery Lane -> Richmond optimal is not the too-slow route (#104)', () => {
  const ship = optMins(Tship, gShip, 'Chancery Lane', 'Richmond');
  const probe = optMins(Tprobe, gProbe, 'Chancery Lane', 'Richmond');
  if (probe == null) throw new Error('no route found Chancery Lane -> Richmond (deeper search)');
  // ship == null (cap finds no route) or ship > probe (cap finds a slower one)
  // are both the #104 regression: the shipped cap under-explores this route.
  if (ship == null || ship > probe) {
    throw new Error(`Chancery Lane -> Richmond: shipped cap gives ${ship == null ? 'NONE' : ship} ` +
      `but a deeper search finds ${probe}. This is the #104 regression.`);
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
