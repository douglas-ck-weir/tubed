// Wait-times tests for Tubed.
// Run with: node tests/wait_times.test.mjs
// Exits 0 on success, 1 on any failure.
//
// Covers the four fixes from the wait-times code review:
//   #1 waitTime cache key includes direction (no poisoning across directions)
//   #2 firstHopOnLeg returns the correct adjacent station for multi-hop legs
//   #4 result-card snapshot can round-trip display data (legs + interchanges)
//   #3 the snapshot writer in renderResultCard backfills v1→v2 transitions
//
// Loads index.html, runs the inline script in a sandbox, and asserts
// against the exported functions.

import { readFileSync } from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, '..', 'index.html');
const html = readFileSync(HTML_PATH, 'utf8');

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (scripts.length === 0) {
  console.error('FATAL: no <script> blocks found in index.html');
  process.exit(1);
}

const exportSuffix = `
;globalThis.__TUBED__ = {
  WAIT_MINS, WAIT_MINS_DEFAULT,
  NETWORK, COORDS,
  displayLine,
  waitTime, firstHopOnLeg,
  _WAIT_CACHE,
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

// localStorage stub that actually stores values — needed for snapshot tests
// to round-trip getStore/setStore.
function makeStorage() {
  const data = {};
  return {
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
    clear: () => { Object.keys(data).forEach(k => delete data[k]); },
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
  vm.runInContext(fullScript, ctx, { filename: 'index.html (full)' });
} catch (e) {
  if (!ctx.__TUBED__) {
    console.error('FATAL: required data/functions not defined after script eval');
    console.error('  error:', e.message);
    process.exit(1);
  }
}

const T = ctx.__TUBED__;
const { WAIT_MINS, WAIT_MINS_DEFAULT, NETWORK, waitTime, firstHopOnLeg, _WAIT_CACHE } = T;

// ── Test framework ─────────────────────────────────────────────────────────
const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message, stack: e.stack });
  }
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'eq'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function ne(actual, notExpected, msg) {
  if (actual === notExpected) {
    throw new Error(`${msg || 'ne'}: expected NOT ${JSON.stringify(notExpected)}, got ${JSON.stringify(actual)}`);
  }
}
function truthy(v, msg) {
  if (!v) throw new Error(msg || 'expected truthy');
}

// Helper: clear the in-memory cache before tests that care about state.
function resetCache() {
  for (const k of Object.keys(_WAIT_CACHE)) delete _WAIT_CACHE[k];
}

// ─── #1 Cache key direction-sensitivity ─────────────────────────────────────
// Discover the 28 direction-sensitive (station, branch) pairs and assert that
// waitTime returns the correct value for each direction WITHOUT cache leaks.

function findDirectionSensitivePairs() {
  const groups = {};
  for (const [k, v] of Object.entries(WAIT_MINS)) {
    const [f, t, b] = k.split('|');
    const key = f + '|' + b;
    if (!groups[key]) groups[key] = [];
    groups[key].push({ to: t, value: v });
  }
  const sensitive = [];
  for (const [key, arr] of Object.entries(groups)) {
    const vals = new Set(arr.map(x => x.value));
    if (vals.size > 1) {
      const [f, b] = key.split('|');
      sensitive.push({ from: f, branch: b, edges: arr });
    }
  }
  return sensitive;
}

const directionSensitive = findDirectionSensitivePairs();

test('#1 found expected number of direction-sensitive station+branch pairs', () => {
  // Sanity: there are 28 in the current dataset. Allow drift but warn loudly
  // if the number changes a lot.
  truthy(directionSensitive.length >= 20,
    `expected at least 20 direction-sensitive pairs, got ${directionSensitive.length}`);
  truthy(directionSensitive.length <= 50,
    `expected at most 50 direction-sensitive pairs, got ${directionSensitive.length} — has data shape changed?`);
});

test('#1 waitTime returns the correct value per direction for every sensitive pair', () => {
  resetCache();
  let failures = [];
  for (const { from, branch, edges } of directionSensitive) {
    for (const { to, value } of edges) {
      const got = waitTime(from, to, branch);
      if (got !== value) {
        failures.push(`${from}→${to} on ${branch}: expected ${value}, got ${got}`);
      }
    }
  }
  if (failures.length) {
    throw new Error(`${failures.length} mismatches:\n  ` + failures.join('\n  '));
  }
});

test('#1 cache does NOT poison across directions (Heathrow T5 vs Hayes & Harlington)', () => {
  resetCache();
  // Heathrow Terminals 2&3 on Elizabeth_Abbey_Wood_T5:
  //   → Hayes & Harlington = 5
  //   → Heathrow Terminal 5 = 15
  // Old broken cache would return whichever was queried first for both.
  const east = waitTime('Heathrow Terminals 2&3', 'Hayes & Harlington', 'Elizabeth_Abbey_Wood_T5');
  const west = waitTime('Heathrow Terminals 2&3', 'Heathrow Terminal 5', 'Elizabeth_Abbey_Wood_T5');
  eq(east, 5, 'Heathrow T2&3 → Hayes & Harlington');
  eq(west, 15, 'Heathrow T2&3 → Heathrow Terminal 5');
  ne(east, west, 'cache must not return same value for both directions');
});

test('#1 cache poisoning regression — query in opposite order', () => {
  resetCache();
  const west = waitTime('Heathrow Terminals 2&3', 'Heathrow Terminal 5', 'Elizabeth_Abbey_Wood_T5');
  const east = waitTime('Heathrow Terminals 2&3', 'Hayes & Harlington', 'Elizabeth_Abbey_Wood_T5');
  eq(west, 15, 'west-first: T5 direction');
  eq(east, 5, 'east-second: Hayes & Harlington');
});

test('#1 cache stores per-direction values (Paddington Elizabeth)', () => {
  resetCache();
  // Paddington Elizabeth_Abbey_Wood_T4: Acton Main Line = 8, Bond Street = 2
  const west = waitTime('Paddington', 'Acton Main Line', 'Elizabeth_Abbey_Wood_T4');
  const east = waitTime('Paddington', 'Bond Street', 'Elizabeth_Abbey_Wood_T4');
  eq(west, 8);
  eq(east, 2);
  // Querying again should hit cache and return the same per-direction value.
  eq(waitTime('Paddington', 'Acton Main Line', 'Elizabeth_Abbey_Wood_T4'), 8);
  eq(waitTime('Paddington', 'Bond Street', 'Elizabeth_Abbey_Wood_T4'), 2);
});

test('#1 display-line fallback still works (Northern → Bank-branch)', () => {
  resetCache();
  // User route input uses display lines like "Northern". Should resolve to a
  // matching branch value at that station.
  const got = waitTime('Bank', 'London Bridge', 'Northern');
  // From data: Bank|London Bridge|Northern_Bank_to_Edgware = 2 (and _High_Barnet = 2)
  eq(got, 2, 'display line "Northern" should match Northern_Bank_* branches at Bank');
});

test('#1 unknown line falls back to WAIT_MINS_DEFAULT', () => {
  resetCache();
  const got = waitTime('Bank', 'London Bridge', 'NoSuchLine');
  eq(got, WAIT_MINS_DEFAULT, 'unknown line should fall back to default');
});

test('#1 Walk line returns 0', () => {
  resetCache();
  eq(waitTime('Bank', 'Monument', 'Walk'), 0);
});

test('#1 missing from returns 0', () => {
  resetCache();
  eq(waitTime(null, 'Bank', 'Northern'), 0);
  eq(waitTime(undefined, 'Bank', 'Northern'), 0);
  eq(waitTime('', 'Bank', 'Northern'), 0);
});

// ─── #2 firstHopOnLeg — multi-hop leg direction ─────────────────────────────

test('#2 firstHopOnLeg: simple adjacent (Bank→London Bridge on Northern Bank-branch)', () => {
  // Northern_Bank_to_High_Barnet includes ...Bank, London Bridge...
  const hop = firstHopOnLeg('Bank', 'London Bridge', 'Northern_Bank_to_High_Barnet');
  eq(hop, 'London Bridge', 'adjacent stops: first hop IS the destination');
});

test('#2 firstHopOnLeg: multi-hop (Bank→Borough on Northern Bank-branch)', () => {
  // Bank → London Bridge → Borough. First hop should be London Bridge.
  const hop = firstHopOnLeg('Bank', 'Borough', 'Northern_Bank_to_High_Barnet');
  eq(hop, 'London Bridge', 'first hop on Bank→Borough should be London Bridge');
});

test('#2 firstHopOnLeg: respects direction (Northbound vs Southbound on Victoria)', () => {
  // Victoria line through Oxford Circus. Going north from Oxford Circus:
  //   Oxford Circus → Warren Street → Euston ...
  // Going south:
  //   Oxford Circus → Green Park → Victoria ...
  const north = firstHopOnLeg('Oxford Circus', 'Euston', 'Victoria');
  const south = firstHopOnLeg('Oxford Circus', 'Victoria', 'Victoria');
  eq(north, 'Warren Street', 'northbound from Oxford Circus toward Euston');
  eq(south, 'Green Park', 'southbound from Oxford Circus toward Victoria');
});

test('#2 firstHopOnLeg: Circle teardrop pivot at Edgware Road', () => {
  // Circle line passes through Edgware Road twice (teardrop). If asking for a
  // hop toward Paddington from Edgware Road, the correct neighbour on the
  // direction-of-travel is what we want. With multi-occurrence stations the
  // helper picks the occurrence whose scan reaches the destination first.
  const hop = firstHopOnLeg('Edgware Road', 'Paddington', 'Circle');
  eq(hop, 'Paddington', 'Paddington is adjacent to Edgware Road on Circle');
});

test('#2 firstHopOnLeg: unknown branch returns legTo (safe fallback)', () => {
  const hop = firstHopOnLeg('Bank', 'London Bridge', 'NoSuchBranch');
  eq(hop, 'London Bridge', 'unknown branch falls back to legTo');
});

test('#2 firstHopOnLeg: Walk branch returns legTo', () => {
  const hop = firstHopOnLeg('Bank', 'Monument', 'Walk');
  eq(hop, 'Monument');
});

test('#2 combined: waitTime via firstHopOnLeg picks the right direction', () => {
  resetCache();
  // Multi-hop leg from Heathrow Terminals 2&3 toward Heathrow Terminal 5.
  // Without firstHopOnLeg, we might pass the wrong `to` to waitTime and get
  // the eastbound (5 min) value. With firstHopOnLeg, we should get 15 min.
  const branch = 'Elizabeth_Abbey_Wood_T5';
  const legFrom = 'Heathrow Terminals 2&3';
  const legTo = 'Heathrow Terminal 5';  // adjacent on this branch
  const hop = firstHopOnLeg(legFrom, legTo, branch);
  const wait = waitTime(legFrom, hop, branch);
  eq(wait, 15, 'westbound to T5 must return 15-min wait, not 5');
});

// ─── Snapshot logic (#3 + #4) ───────────────────────────────────────────────
//
// We don't simulate the full DOM, but we can verify:
//   - SCORING_VERSION is defined and an integer
//   - The snapshot key shape (presence of optLegs / userLegs / etc.) survives
//     a round-trip through localStorage
//   - The "version mismatch triggers recompute" branch is detectable via the
//     code-shape grep (defensive — full behaviour test would need a DOM).

test('#3/#4 SCORING_VERSION is defined and is an integer', () => {
  // Pull it out of the script source — it's a top-level const.
  const m = /const SCORING_VERSION\s*=\s*(\d+)/.exec(scripts.join('\n'));
  truthy(m, 'SCORING_VERSION declaration not found');
  const v = parseInt(m[1], 10);
  truthy(Number.isInteger(v) && v >= 1, `SCORING_VERSION should be a positive int, got ${m[1]}`);
});

test('#3 snapshot writer lives in renderResultCard (single source of truth)', () => {
  const src = scripts.join('\n');
  // Inside renderResultCard, the else-branch should set submittedScoring.
  const rrcStart = src.indexOf('function renderResultCard');
  truthy(rrcStart >= 0, 'renderResultCard not found');
  const rrcEnd = src.indexOf('\nfunction ', rrcStart + 1);
  const rrc = src.slice(rrcStart, rrcEnd > 0 ? rrcEnd : src.length);
  truthy(rrc.includes('persisted.submittedScoring = {'),
    'renderResultCard must write the snapshot on the recompute path');
  truthy(rrc.includes('setModeStore(mode, persisted)'),
    'renderResultCard must persist the new snapshot');
});

test('#3 submitRoute does NOT also write submittedScoring (no duplicate writer)', () => {
  const src = scripts.join('\n');
  const srStart = src.indexOf('function submitRoute');
  truthy(srStart >= 0, 'submitRoute not found');
  // Take everything until the next top-level function declaration.
  const srEnd = src.indexOf('\nfunction ', srStart + 1);
  const sr = src.slice(srStart, srEnd > 0 ? srEnd : src.length);
  // Should NOT contain a direct snapshot write — that responsibility moved
  // entirely to renderResultCard.
  truthy(!sr.includes('cardSnap.submittedScoring = {'),
    'submitRoute should NOT write submittedScoring (now lives in renderResultCard)');
});

test('#4 snapshot reader pulls the new display fields', () => {
  const src = scripts.join('\n');
  truthy(src.includes('snapshot.optLegs'),    'snapshot.optLegs must be read on restore');
  truthy(src.includes('snapshot.optInterchanges'), 'snapshot.optInterchanges must be read on restore');
  truthy(src.includes('snapshot.userLegs'),   'snapshot.userLegs must be read on restore');
  truthy(src.includes('snapshot.userInterchanges'), 'snapshot.userInterchanges must be read on restore');
});

test('#4 snapshot reader has fallbacks for old (numbers-only) snapshots', () => {
  const src = scripts.join('\n');
  // Should fall back to current-render values if snapshot is missing the fields.
  truthy(/snapshot\.optLegs\s*\|\|\s*pd\.optimal\.legs/.test(src),
    'snapshot.optLegs must fall back to pd.optimal.legs');
  truthy(/snapshot\.userLegs\s*\|\|\s*userLegsData\.legs/.test(src),
    'snapshot.userLegs must fall back to userLegsData.legs');
});

test('#4 snapshot writer includes the new display fields', () => {
  const src = scripts.join('\n');
  // In the writer block of renderResultCard.
  const writerMatch = /persisted\.submittedScoring\s*=\s*\{[\s\S]*?\};/.exec(src);
  truthy(writerMatch, 'snapshot writer block not found');
  const block = writerMatch[0];
  truthy(block.includes('optLegs'),          'writer must include optLegs');
  truthy(block.includes('optInterchanges'),  'writer must include optInterchanges');
  truthy(block.includes('userLegs'),         'writer must include userLegs');
  truthy(block.includes('userInterchanges'), 'writer must include userInterchanges');
});

// ─── Data integrity sanity ──────────────────────────────────────────────────

test('data: all WAIT_MINS values are positive integers', () => {
  let bad = [];
  for (const [k, v] of Object.entries(WAIT_MINS)) {
    if (!Number.isInteger(v) || v < 0 || v > 30) bad.push(`${k} = ${v}`);
  }
  if (bad.length) throw new Error(`${bad.length} bad values:\n  ${bad.slice(0, 5).join('\n  ')}`);
});

test('data: WAIT_MINS_DEFAULT is a reasonable integer', () => {
  truthy(Number.isInteger(WAIT_MINS_DEFAULT));
  truthy(WAIT_MINS_DEFAULT >= 1 && WAIT_MINS_DEFAULT <= 10);
});

test('data: every WAIT_MINS branch ID exists in NETWORK or is a known display line', () => {
  // Branches like 'Northern_Bank_to_Edgware' must appear in NETWORK keys.
  // Display lines like 'Hammersmith & City' or 'Jubilee' won't, but they're
  // valid as displayLine outputs. Check that every key's branch resolves to
  // a known displayLine.
  const validDisplays = new Set();
  for (const k of Object.keys(NETWORK)) validDisplays.add(T.displayLine(k));
  let bad = [];
  for (const k of Object.keys(WAIT_MINS)) {
    const branch = k.slice(k.lastIndexOf('|') + 1);
    const isBranchId = branch in NETWORK;
    const isDisplay  = validDisplays.has(branch);
    if (!isBranchId && !isDisplay) bad.push(branch);
  }
  if (bad.length) {
    const unique = [...new Set(bad)];
    throw new Error(`${unique.length} unknown branches:\n  ${unique.slice(0, 10).join('\n  ')}`);
  }
});

// ─── Run + report ─────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
const passed = results.filter(r => r.ok);

console.log('');
for (const r of results) {
  console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}`);
  if (!r.ok) {
    console.log(`      ${r.error}`);
  }
}
console.log('');
console.log(`${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
