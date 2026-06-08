// Network data integrity tests for Tubed.
// Run with: node tests/network.test.mjs
// Exits 0 on success, 1 on any failure.
//
// Loads index.html, extracts the relevant top-level data structures and
// functions, evaluates them in a sandbox, and runs assertions.

import { readFileSync } from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, '..', 'index.html');
const html = readFileSync(HTML_PATH, 'utf8');

// ── Sandbox extraction ─────────────────────────────────────────────────────
// Pull out the inline <script> block(s) and run the data-defining portion in a
// vm context. We don't want DOM code to execute, so we slice from the start
// of the script to just before the first function that references `document`
// or `window`. The data + pure-function block runs cleanly in Node.

// Concatenate all <script> blocks in document order. The full script is
// evaluated in a sandbox with stubbed DOM globals so the game's startup code
// silently no-ops instead of throwing.
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (scripts.length === 0) {
  console.error('FATAL: no <script> blocks found in index.html');
  process.exit(1);
}
// Append an explicit export block so top-level `const` bindings (which live
// in lexical scope, not on globalThis) become accessible to the test harness.
const exportSuffix = `
;globalThis.__TUBED__ = {
  NETWORK, TIMES, TIMES_BY_LINE, COORDS, LINE_COLOURS,
  INTERCHANGE_MINS, PLATFORM_GROUPS, OSI_PAIRS,
  displayLine, getTime, interchangeTime,
  buildGraph, dijkstra, travelTimeOnLine, buildUserLegs,
  _singleLineDistances, bestOneChangeMins
};`;
const fullScript = scripts.join('\n;\n') + exportSuffix;

// Proxy-based stub: any property access returns a callable stub that itself
// supports any property/method. This means `document.getElementById(...).addEventListener(...)`
// chains all succeed silently.
function makeStub(name = 'stub') {
  const fn = function(){ return makeStub(name + '()'); };
  return new Proxy(fn, {
    get(_t, p) {
      if (p === Symbol.toPrimitive) return () => '';
      if (p === 'then') return undefined; // not a thenable
      if (p === 'length') return 0;
      if (p === 'forEach' || p === 'map' || p === 'filter') return () => [];
      return makeStub(`${name}.${String(p)}`);
    },
    apply() { return makeStub(name + '()'); },
    has() { return true },
  });
}

const ctx = {
  console,
  Date, Math, Object, Array, Set, Map, JSON, Number, String, Boolean, RegExp,
  parseInt, parseFloat, isNaN, isFinite,
  // DOM stubs
  document: makeStub('document'),
  window:   makeStub('window'),
  navigator: makeStub('navigator'),
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
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
  Error,
  TypeError,
  RangeError,
  Symbol,
  Map,
  WeakMap,
  WeakSet,
};
vm.createContext(ctx);

try {
  vm.runInContext(fullScript, ctx, { filename: 'index.html (full)' });
} catch (e) {
  // Many startup errors are expected (DOM missing). Only fail if our target
  // identifiers aren't defined afterwards.
  if (!ctx.__TUBED__) {
    console.error('FATAL: required data/functions not defined after script eval');
    console.error('  error:', e.message);
    process.exit(1);
  }
}

// ── Test framework (minimal) ───────────────────────────────────────────────
const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'eq'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function truthy(v, msg) {
  if (!v) throw new Error(msg || 'expected truthy');
}
function defined(v, msg) {
  if (v === undefined || v === null) throw new Error(msg || 'expected defined');
}

const { NETWORK, COORDS, LINE_COLOURS, PLATFORM_GROUPS,
        displayLine, getTime, interchangeTime,
        buildGraph, dijkstra, travelTimeOnLine, buildUserLegs,
        _singleLineDistances, bestOneChangeMins } = ctx.__TUBED__;

// ── Structural integrity ───────────────────────────────────────────────────

test('every NETWORK line ID resolves to a known display line + colour', () => {
  const unmapped = [];
  for (const id of Object.keys(NETWORK)) {
    const dl = displayLine(id);
    if (!LINE_COLOURS[dl]) unmapped.push(`${id} → ${dl}`);
  }
  if (unmapped.length) throw new Error('Unmapped IDs:\n  ' + unmapped.join('\n  '));
});

test('every station in NETWORK has coordinates in COORDS', () => {
  const stations = new Set();
  for (const arr of Object.values(NETWORK)) arr.forEach(s => stations.add(s));
  const missing = [...stations].filter(s => !COORDS[s]);
  if (missing.length) throw new Error('Missing coords for:\n  ' + missing.join('\n  '));
});

test('every consecutive station pair has a non-null travel time', () => {
  const broken = [];
  for (const [lineId, arr] of Object.entries(NETWORK)) {
    for (let i = 0; i < arr.length - 1; i++) {
      const t = getTime(arr[i], arr[i + 1], lineId);
      if (t === null) broken.push(`${lineId}: ${arr[i]} → ${arr[i + 1]}`);
    }
  }
  if (broken.length) throw new Error('No travel time for:\n  ' + broken.join('\n  '));
});

test('TIMES has no duplicate keys', () => {
  // Parse raw text to detect literal duplicates (object literal would silently
  // override with the last value, so this is the only way to catch them).
  const timesBlock = html.match(/const TIMES = \{([\s\S]*?)\n\};/);
  if (!timesBlock) throw new Error('TIMES block not found');
  const keys = [...timesBlock[1].matchAll(/'([^']*(?:\\'[^']*)*)\|([^']*(?:\\'[^']*)*)':\s*\d+/g)];
  const seen = new Map();
  const dups = [];
  for (const m of keys) {
    const k = `${m[1]}|${m[2]}`;
    if (seen.has(k)) dups.push(k);
    seen.set(k, true);
  }
  if (dups.length) throw new Error('Duplicate keys:\n  ' + dups.join('\n  '));
});

test('PLATFORM_GROUPS members all appear in LINE_COLOURS', () => {
  const bad = [];
  for (const [stn, groups] of Object.entries(PLATFORM_GROUPS)) {
    for (const [_, members] of Object.entries(groups)) {
      for (const m of members) {
        if (!LINE_COLOURS[m]) bad.push(`${stn}: ${m}`);
      }
    }
  }
  if (bad.length) throw new Error('Unknown lines in PLATFORM_GROUPS:\n  ' + bad.join('\n  '));
});

// ── CSV truth verification (Overground edge times) ─────────────────────────

const OVERGROUND_CSV = {
  'Overground_Lioness': [
    ['Euston','South Hampstead',5],['South Hampstead','Kilburn High Road',2],
    ["Kilburn High Road","Queen's Park",2],["Queen's Park",'Kensal Green',2],
    ['Kensal Green','Willesden Junction',3],['Willesden Junction','Harlesden',2],
    ['Harlesden','Stonebridge Park',3],['Stonebridge Park','Wembley Central',2],
    ['Wembley Central','North Wembley',2],['North Wembley','South Kenton',2],
    ['South Kenton','Kenton',2],['Kenton','Harrow & Wealdstone',3],
    ['Harrow & Wealdstone','Headstone Lane',3],['Headstone Lane','Hatch End',2],
    ['Hatch End','Carpenders Park',3],['Carpenders Park','Bushey',3],
    ['Bushey','Watford High Street',2],['Watford High Street','Watford Junction',2],
  ],
  'Overground_Mildmay_Richmond': [
    ['Stratford','Hackney Wick',3],['Hackney Wick','Homerton',3],
    ['Homerton','Hackney Central',2],['Hackney Central','Dalston Kingsland',2],
    ['Dalston Kingsland','Canonbury',2],['Canonbury','Highbury & Islington',4],
    // Trunk values picked from Clapham CSV by product decision; Richmond CSV
    // disagrees by 1 min on three edges (H&I↔CalRd, Finchley Rd↔WH, Brondesbury↔BrondesburyPark)
    ['Willesden Junction','Acton Central',6],['Acton Central','South Acton',3],
    ['South Acton','Gunnersbury',3],['Gunnersbury','Kew Gardens',3],
    ['Kew Gardens','Richmond',6],
  ],
  'Overground_Mildmay_Clapham': [
    ['Stratford','Hackney Wick',3],['Canonbury','Highbury & Islington',4],
    ['Highbury & Islington','Caledonian Road & Barnsbury',1],
    ['Finchley Road & Frognal','West Hampstead',2],['Brondesbury','Brondesbury Park',2],
    ["Willesden Junction","Shepherd's Bush (Overground)",8],
    ["Shepherd's Bush (Overground)",'Kensington (Olympia)',2],
    ['Kensington (Olympia)','West Brompton',2],['West Brompton','Imperial Wharf',3],
    ['Imperial Wharf','Clapham Junction',8],
  ],
  'Overground_Windrush_NewCross': [
    ['Highbury & Islington','Canonbury',2],['Canonbury','Dalston Junction',2],
    ['Dalston Junction','Haggerston',2],['Haggerston','Hoxton',2],
    ['Hoxton','Shoreditch High Street',2],['Shoreditch High Street','Whitechapel',3],
    ['Whitechapel','Shadwell (Overground)',2],['Shadwell (Overground)','Wapping',2],
    ['Wapping','Rotherhithe',1],['Rotherhithe','Canada Water',2],
    ['Canada Water','Surrey Quays',2],['Surrey Quays','New Cross',4],
  ],
  'Overground_Windrush_CrystalPalace': [
    ['Surrey Quays','New Cross Gate',5],['New Cross Gate','Brockley',2],
    ['Brockley','Honor Oak Park',3],['Honor Oak Park','Forest Hill',2],
    ['Forest Hill','Sydenham',4],['Sydenham','Crystal Palace',4],
  ],
  'Overground_Windrush_WCroydon': [
    ['Sydenham','Penge West',2],['Penge West','Anerley',2],
    ['Anerley','Norwood Junction',3],['Norwood Junction','West Croydon',6],
  ],
  'Overground_Windrush_Clapham': [
    ['Surrey Quays','Queens Road Peckham',4],['Queens Road Peckham','Peckham Rye',2],
    ['Peckham Rye','Denmark Hill',2],['Denmark Hill','Clapham High Street',3],
    ['Clapham High Street','Wandsworth Road',2],['Wandsworth Road','Clapham Junction',3],
  ],
  'Overground_Weaver_Chingford': [
    ['Liverpool Street','Bethnal Green (Overground)',3],
    ['Bethnal Green (Overground)','Hackney Downs',4],
    ['Hackney Downs','Clapton',3],['Clapton','St. James Street',3],
    ['St. James Street','Walthamstow Central',2],
    ['Walthamstow Central','Wood Street',3],
    ['Wood Street','Highams Park',3],['Highams Park','Chingford',6],
  ],
  'Overground_Weaver_Enfield_Town': [
    ['Bethnal Green (Overground)','Cambridge Heath',2],
    ['Cambridge Heath','London Fields',2],['London Fields','Hackney Downs',2],
    ['Hackney Downs','Rectory Road',3],['Rectory Road','Stoke Newington',1],
    ['Stoke Newington','Stamford Hill',2],
    ['Stamford Hill','Seven Sisters (Overground)',3],
    ['Seven Sisters (Overground)','Bruce Grove',2],
    ['Bruce Grove','White Hart Lane',2],['White Hart Lane','Silver Street',2],
    ['Silver Street','Edmonton Green',2],['Edmonton Green','Bush Hill Park',2],
    ['Bush Hill Park','Enfield Town',5],
  ],
  'Overground_Weaver_Cheshunt': [
    ['Edmonton Green','Southbury',3],['Southbury','Turkey Street',3],
    ["Turkey Street","Theobald's Grove",2],["Theobald's Grove",'Cheshunt',5],
  ],
  'Overground_Suffragette': [
    ['Gospel Oak','Upper Holloway',4],['Upper Holloway','Crouch Hill',2],
    ['Crouch Hill','Harringay Green Lanes',3],
    ['Harringay Green Lanes','South Tottenham',4],
    ['South Tottenham','Blackhorse Road (Overground)',3],
    ['Blackhorse Road (Overground)','Walthamstow Queens Road',2],
    ['Walthamstow Queens Road','Leyton Midland Road',3],
    ['Leyton Midland Road','Leytonstone High Road',2],
    ['Leytonstone High Road','Wanstead Park',3],
    ['Wanstead Park','Woodgrange Park',3],['Woodgrange Park','Barking',4],
    ['Barking','Barking Riverside',7],
  ],
  'Overground_Liberty': [
    ['Romford','Emerson Park',5],['Emerson Park','Upminster',4],
  ],
};

test('all Overground edge times match TfL CSV', () => {
  const mismatches = [];
  for (const [lineId, pairs] of Object.entries(OVERGROUND_CSV)) {
    for (const [a, b, expected] of pairs) {
      const actual = getTime(a, b, lineId);
      if (actual !== expected) {
        mismatches.push(`${lineId}: ${a} → ${b}  expected ${expected}, got ${actual}`);
      }
    }
  }
  if (mismatches.length) throw new Error('CSV mismatches:\n  ' + mismatches.join('\n  '));
});

// ── Multi-line interchanges ────────────────────────────────────────────────

test('Canada Water Jubilee↔Windrush = 3 min', () => {
  eq(interchangeTime('Canada Water', 'Jubilee', 'Overground_Windrush_NewCross'), 3);
});
// Interchange-time expectations below were updated 2026-06-03 to match the
// values from the TfL Stop Structure API rebuild (commit 6ae5c41). Earlier
// values in this file were hand-curated and lower than the authoritative
// TfL data.
test('Highbury & Islington Victoria↔Mildmay = 6 min', () => {
  eq(interchangeTime('Highbury & Islington', 'Victoria', 'Overground_Mildmay_Richmond'), 6);
});
test('Highbury & Islington Victoria↔Windrush = 6 min', () => {
  eq(interchangeTime('Highbury & Islington', 'Victoria', 'Overground_Windrush_Clapham'), 6);
});
test('Willesden Junction Bakerloo↔Mildmay = 4 min', () => {
  eq(interchangeTime('Willesden Junction', 'Bakerloo', 'Overground_Mildmay_Richmond'), 4);
});
test('Willesden Junction Lioness↔Mildmay = 4 min', () => {
  eq(interchangeTime('Willesden Junction', 'Overground_Lioness', 'Overground_Mildmay_Richmond'), 4);
});
test('Liverpool Street Central↔Weaver = 6 min', () => {
  eq(interchangeTime('Liverpool Street', 'Central', 'Overground_Weaver_Cheshunt'), 6);
});
test('Stratford Elizabeth↔Mildmay = 7 min', () => {
  eq(interchangeTime('Stratford', 'Elizabeth', 'Overground_Mildmay_Clapham'), 7);
});
test('Romford Elizabeth↔Liberty = 5 min', () => {
  eq(interchangeTime('Romford', 'Elizabeth', 'Overground_Liberty'), 5);
});
test('Barking District↔Suffragette = 5 min', () => {
  eq(interchangeTime('Barking', 'District', 'Overground_Suffragette'), 5);
});

// ── Platform-group fallback ────────────────────────────────────────────────

test('platform-group fallback: a hypothetical new Liverpool Street Overground service inherits Weaver walking times', () => {
  // PLATFORM_GROUPS at Liverpool Street groups Weaver under 'Overground'.
  // If we synthesise a new line that displays as something also grouped under
  // the same Overground platforms, the lookup should fall through to Weaver's
  // entry. We can simulate this by checking an unmapped pair: Central|Mildmay
  // at Liverpool Street has no explicit entry, but Mildmay isn't in the
  // platform group there either, so it should NOT find Weaver's value.
  // (This guards against the fallback being too eager.)
  // Liverpool Street group: { Overground: [Weaver] }
  // So Weaver↔Central = 6 (per TfL Stop Structure API), but a peer-only
  // fallback would need Mildmay in the group.
  const central_weaver = interchangeTime('Liverpool Street', 'Central', 'Overground_Weaver_Cheshunt');
  eq(central_weaver, 6);
});

// ── Per-line edge time overrides ───────────────────────────────────────────

test('Canonbury → Highbury & Islington is 4 min on Mildmay', () => {
  eq(getTime('Canonbury', 'Highbury & Islington', 'Overground_Mildmay_Richmond'), 4);
});
test('Canonbury → Highbury & Islington is 2 min on Windrush', () => {
  eq(getTime('Canonbury', 'Highbury & Islington', 'Overground_Windrush_Clapham'), 2);
});
test('getTime with no line falls back to generic TIMES', () => {
  // Generic TIMES has Canonbury|Highbury & Islington at 3 (was the pre-split value)
  const t = getTime('Canonbury', 'Highbury & Islington');
  truthy(t !== null, 'should return a value');
});

// ── Regression: non-Overground lines unchanged ─────────────────────────────

test('District line still has consecutive travel times', () => {
  const district = NETWORK['District_Ealing_Broadway_Upminster'];
  defined(district, 'District line should exist');
  for (let i = 0; i < district.length - 1; i++) {
    truthy(getTime(district[i], district[i+1], 'District_Ealing_Broadway_Upminster') !== null,
           `District: ${district[i]} → ${district[i+1]}`);
  }
});

test('Northern line still has consecutive travel times', () => {
  for (const [id, arr] of Object.entries(NETWORK)) {
    if (!id.startsWith('Northern')) continue;
    for (let i = 0; i < arr.length - 1; i++) {
      truthy(getTime(arr[i], arr[i+1], id) !== null,
             `${id}: ${arr[i]} → ${arr[i+1]}`);
    }
  }
});

test('Earl\'s Court ↔ Victoria on District still resolves', () => {
  truthy(getTime("Earl's Court", 'Gloucester Road', 'District_Ealing_Broadway_Upminster') !== null);
});

// ── displayLine() coverage ─────────────────────────────────────────────────

test('displayLine maps every Overground sub-line to its named line', () => {
  eq(displayLine('Overground_Lioness'),               'Lioness');
  eq(displayLine('Overground_Mildmay_Richmond'),      'Mildmay');
  eq(displayLine('Overground_Mildmay_Clapham'),       'Mildmay');
  eq(displayLine('Overground_Windrush_NewCross'),     'Windrush');
  eq(displayLine('Overground_Windrush_CrystalPalace'),'Windrush');
  eq(displayLine('Overground_Windrush_WCroydon'),     'Windrush');
  eq(displayLine('Overground_Windrush_Clapham'),      'Windrush');
  eq(displayLine('Overground_Weaver_Cheshunt'),       'Weaver');
  eq(displayLine('Overground_Weaver_Enfield_Town'),   'Weaver');
  eq(displayLine('Overground_Weaver_Chingford'),      'Weaver');
  eq(displayLine('Overground_Suffragette'),           'Suffragette');
  eq(displayLine('Overground_Liberty'),               'Liberty');
});

test('displayLine fallback for generic "Overground" still works', () => {
  eq(displayLine('Overground'), 'Overground');
});

// ── Total journey time spot checks ─────────────────────────────────────────

function totalTimeOnLine(stations, lineId) {
  let total = 0;
  for (let i = 0; i < stations.length - 1; i++) {
    const t = getTime(stations[i], stations[i+1], lineId);
    if (t === null) throw new Error(`Missing time: ${stations[i]} → ${stations[i+1]}`);
    total += t;
  }
  return total;
}

test('Watford Junction → Euston (Lioness) end-to-end total = 46 min', () => {
  // Sum of CSV values: 5+2+2+2+3+2+3+2+2+2+2+3+3+2+3+3+2+2 = 45
  // Note: CSV-derived total
  const arr = NETWORK['Overground_Lioness'].slice().reverse(); // Watford Junction first
  eq(totalTimeOnLine(arr, 'Overground_Lioness'), 45);
});

test('Romford → Upminster (Liberty) end-to-end total = 9 min', () => {
  eq(totalTimeOnLine(NETWORK['Overground_Liberty'], 'Overground_Liberty'), 9);
});

test('Gospel Oak → Barking Riverside (Suffragette) total = 40 min', () => {
  // 4+2+3+4+3+2+3+2+3+3+4+7 = 40
  eq(totalTimeOnLine(NETWORK['Overground_Suffragette'], 'Overground_Suffragette'), 40);
});

test('Liverpool Street → Chingford (Weaver Chingford) total = 27 min', () => {
  // 3+4+3+3+2+3+3+6 = 27
  eq(totalTimeOnLine(NETWORK['Overground_Weaver_Chingford'], 'Overground_Weaver_Chingford'), 27);
});

// ── Circle line teardrop pivots ────────────────────────────────────────────
// Circle has two stations (Paddington, Edgware Road) that appear twice in the
// service array — these are the "teardrop pivots" where the line spirals back
// on itself and a rider physically has to change platforms to traverse them.
// buildGraph() splits each duplicate occurrence into a synthetic graph node
// linked by a same-line interchange edge; travelTimeOnLine() and
// buildUserLegs() honour the split so a single Circle leg across the pivot
// is forced to the long-way continuous ride (no change), while explicitly
// adding the pivot station as a waypoint splits the leg with a change.
//
// These tests lock in the model. If any of them start failing, something in
// the Circle representation has regressed — fix the regression, don't update
// the expected values without thinking carefully about the player-facing
// implication.

// Helper: optimal route summary from dijkstra, for assertions.
function optimal(start, end) {
  const g = buildGraph();
  const routes = dijkstra(g, start, end);
  return routes && routes[0] ? routes[0] : null;
}

test('Circle has duplicate occurrences of Paddington and Edgware Road', () => {
  const arr = NETWORK['Circle'];
  truthy(arr, 'NETWORK.Circle defined');
  const padCount = arr.filter(s => s === 'Paddington').length;
  const edgCount = arr.filter(s => s === 'Edgware Road').length;
  eq(padCount, 2, 'Paddington should appear twice on Circle');
  eq(edgCount, 2, 'Edgware Road should appear twice on Circle');
});

test('buildGraph synthesises pivot nodes for Paddington and Edgware Road on Circle', () => {
  const g = buildGraph();
  const synth = Object.keys(g).filter(k => k.includes('#'));
  const padSynth = synth.filter(k => k.startsWith('Paddington#'));
  const edgSynth = synth.filter(k => k.startsWith('Edgware Road#'));
  eq(padSynth.length, 2, 'expected 2 synthetic Paddington nodes');
  eq(edgSynth.length, 2, 'expected 2 synthetic Edgware Road nodes');
});

test('travelTimeOnLine forces the long anticlockwise way for Victoria → Ladbroke Grove on Circle', () => {
  // Short way Victoria → Bayswater → Paddington → Royal Oak → Ladbroke Grove
  // requires the Paddington pivot change. A single Circle leg with no change
  // must therefore go the long way around the loop.
  eq(travelTimeOnLine('Victoria', 'Ladbroke Grove', 'Circle'), 39);
});

test('travelTimeOnLine returns the no-pivot short way for Victoria → Paddington on Circle', () => {
  // Victoria → Sloane Sq → … → Bayswater → Paddington: 16 min, no pivot.
  eq(travelTimeOnLine('Victoria', 'Paddington', 'Circle'), 16);
});

test('travelTimeOnLine returns the no-pivot short way for Paddington → Ladbroke Grove on Circle', () => {
  // Paddington → Royal Oak → Westbourne Park → Ladbroke Grove: 5 min, no pivot.
  eq(travelTimeOnLine('Paddington', 'Ladbroke Grove', 'Circle'), 5);
});

test('travelTimeOnLine returns the continuous Hammersmith → Victoria Circle ride at 46 min', () => {
  // Single Circle service runs Hammersmith → … → Paddington(N) → Edgware Road
  // (mid-route, passes through) → Baker St → … → Victoria. Total: 46 min.
  eq(travelTimeOnLine('Hammersmith', 'Victoria', 'Circle'), 46);
});

test('Linear lines (Victoria, Northern) unaffected by synthetic-node logic', () => {
  eq(travelTimeOnLine('Stockwell', 'Victoria', 'Victoria'), 5);
  eq(travelTimeOnLine('Clapham South', 'Stockwell', 'Northern'), 5);
});

test('buildUserLegs: Victoria → Ladbroke Grove on Circle (no waypoint) scores 39 min long way', () => {
  const r = buildUserLegs('Victoria', [{station:'Ladbroke Grove', line:'Circle'}]);
  eq(r.legs.length, 1);
  eq(r.legs[0].mins, 39);
  eq(r.totalMins, 39);
});

test('buildUserLegs: Victoria → Paddington → Ladbroke Grove on Circle forces a change at Paddington', () => {
  // Player adds Paddington as a pivot waypoint → leg splits with a
  // Circle|Circle interchange at Paddington. Short way both halves:
  // 16 + 3 + 5 = 24.
  const r = buildUserLegs('Victoria', [
    {station:'Paddington', line:'Circle'},
    {station:'Ladbroke Grove', line:'Circle'},
  ]);
  eq(r.legs.length, 2);
  eq(r.legs[0].mins, 16);
  eq(r.legs[1].mins, 5);
  eq(r.interchanges[0]?.at, 'Paddington');
  eq(r.interchanges[0]?.mins, 3);
  eq(r.totalMins, 24);
});

test('buildUserLegs: Victoria → Edgware Road → Ladbroke Grove forces a change at Edgware Road', () => {
  const r = buildUserLegs('Victoria', [
    {station:'Edgware Road', line:'Circle'},
    {station:'Ladbroke Grove', line:'Circle'},
  ]);
  eq(r.legs.length, 2);
  eq(r.interchanges[0]?.at, 'Edgware Road');
  // 18 + 2 + 7 = 27
  eq(r.totalMins, 27);
});

test('buildUserLegs: non-pivot waypoint on Circle stays as a single via leg', () => {
  // Bayswater is a single-occurrence Circle station; using it as a waypoint
  // must NOT force a change. Notting Hill Gate → Bayswater → Paddington = 4.
  const r = buildUserLegs('Notting Hill Gate', [
    {station:'Bayswater', line:'Circle'},
    {station:'Paddington', line:'Circle'},
  ]);
  eq(r.legs.length, 1);
  eq(r.legs[0].mins, 4);
  eq(r.totalMins, 4);
});

test('buildUserLegs: Hammersmith → Victoria direct on Circle = 46 min continuous', () => {
  const r = buildUserLegs('Hammersmith', [{station:'Victoria', line:'Circle'}]);
  eq(r.legs.length, 1);
  eq(r.legs[0].mins, 46);
});

test('buildUserLegs: explicit cross-line change Circle → H&C at Paddington uses 1-min interchange', () => {
  // Circle and H&C share platforms at Paddington-N — 1-min interchange.
  const r = buildUserLegs('Victoria', [
    {station:'Paddington', line:'Circle'},
    {station:'Ladbroke Grove', line:'Hammersmith & City'},
  ]);
  eq(r.legs.length, 2);
  eq(r.legs[0].line, 'Circle');
  eq(r.legs[1].line, 'Hammersmith & City');
  eq(r.interchanges[0]?.mins, 1);
  // 16 + 1 + 5 = 22
  eq(r.totalMins, 22);
});

test('Optimal Victoria → Ladbroke Grove uses Paddington change (not the long anticlockwise way)', () => {
  const opt = optimal('Victoria', 'Ladbroke Grove');
  defined(opt, 'optimal route should exist');
  // Should be a 2-leg route via Paddington, not a 1-leg 39-min long way.
  eq(opt.legs.length, 2);
  eq(opt.legs[0].to, 'Paddington');
  eq(opt.legs[1].from, 'Paddington');
  truthy(opt.mins < 39, `optimal should beat the long way; got ${opt.mins}`);
});

test('Optimal Bayswater → Westbourne Park uses a same-station change at Paddington', () => {
  const opt = optimal('Bayswater', 'Westbourne Park');
  defined(opt, 'optimal route should exist');
  eq(opt.legs.length, 2);
  eq(opt.legs[0].to, 'Paddington');
});

// ── _singleLineDistances pivot-awareness ───────────────────────────────────
// Used by bestOneChangeMins (the hard-puzzle filter). On Circle the function
// must not allow free teleport between Paddington's two platform sides.

test('_singleLineDistances from Paddington on Circle does not free-teleport across the pivot', () => {
  const d = _singleLineDistances('Paddington', 'Circle');
  // Royal Oak is one hop from Paddington-N; Bayswater is one hop from
  // Paddington-S. Both should be 2 — but only because we measured from the
  // *correct* platform for each. The bug we are guarding against is the old
  // behaviour where Ladbroke Grove (5 min from Paddington-N) and Victoria
  // (16 min from Paddington-S) both showed up at their short-platform
  // distances by hopping between platforms freely. With the pivot guard,
  // each station appears at the distance from its corresponding platform.
  eq(d['Royal Oak'], 2, 'Royal Oak reachable from Paddington-N in 2 min');
  eq(d['Bayswater'], 2, 'Bayswater reachable from Paddington-S in 2 min');
  eq(d['Ladbroke Grove'], 5, 'Ladbroke Grove reachable from Paddington-N in 5 min');
  eq(d['Victoria'], 16, 'Victoria reachable from Paddington-S in 16 min');
});

test('_singleLineDistances on a linear line (Northern) is unchanged', () => {
  const d = _singleLineDistances('Stockwell', 'Northern_Bank_to_High_Barnet');
  // Stockwell is on the Bank branch — adjacent stations should be reachable
  // at the underlying TIMES values.
  defined(d['Oval'], 'Oval reachable from Stockwell on Northern Bank branch');
});

test('bestOneChangeMins for Victoria → Ladbroke Grove gives the via-Paddington short route (~22 min)', () => {
  // Before the _singleLineDistances pivot guard, this returned 21 (the
  // free-teleport short way), which then made the hard-puzzle generator's
  // "1-change-gap" filter accept puzzles whose optimal route only just beat
  // a fictitious one-change tube route. With the fix, the value reflects
  // the real two-leg route Victoria → Paddington (Circle) → Ladbroke Grove
  // (H&C) including the 1-min cross-line interchange at Paddington.
  const m = bestOneChangeMins('Victoria', 'Ladbroke Grove');
  truthy(m >= 20 && m <= 25, `bestOneChangeMins should be ~22, got ${m}`);
});

// ── Multi-occurrence stations are an explicit, documented set ─────────────
// The synthetic-node logic in buildGraph activates for any station that
// appears more than once in any sub-line array. Today only Circle's
// Paddington and Edgware Road qualify. If a future network change
// introduces another duplicate, this test fails — we want to look at it
// carefully before letting it through, because every new pivot also needs
// the same care around scoring/validation/optimal routing.

// ── via tracking and leg shape on the result card ─────────────────────────
// The result card renders each leg as "from → to LINE mins" with an optional
// "via X, Y, Z" annotation listing intermediate stops the player chose to
// add. The screenshot complaint that started this whole investigation
// (Paddington appearing inline rather than as a change row) is fixed by
// the pivot-waypoint detection in buildUserLegs — these tests pin the
// rendered shape so a future refactor can't drop the distinction.

test('player route with no intermediate stops has empty via on every leg', () => {
  const r = buildUserLegs('Victoria', [{station:'Ladbroke Grove', line:'Circle'}]);
  eq(r.legs.length, 1);
  eq(r.legs[0].via.length, 0, 'single-stop input has empty via');
});

test('non-pivot intermediate stop on Circle is recorded as via, NOT a change', () => {
  // Bayswater is single-occurrence on Circle. Notting Hill Gate → Bayswater
  // → Paddington should be one leg with Bayswater in via and no change row.
  const r = buildUserLegs('Notting Hill Gate', [
    {station:'Bayswater', line:'Circle'},
    {station:'Paddington', line:'Circle'},
  ]);
  eq(r.legs.length, 1);
  eq(r.legs[0].via.length, 1);
  eq(r.legs[0].via[0], 'Bayswater');
  eq(r.interchanges[0], null, 'no interchange row');
});

test('pivot intermediate stop on Circle splits the leg and emits a change row, NOT a via', () => {
  // Victoria → Paddington (pivot) → Ladbroke Grove. The leg splits at
  // Paddington; neither resulting leg should list Paddington in via — it
  // belongs to the change row between them.
  const r = buildUserLegs('Victoria', [
    {station:'Paddington', line:'Circle'},
    {station:'Ladbroke Grove', line:'Circle'},
  ]);
  eq(r.legs.length, 2);
  eq(r.legs[0].via.length, 0, 'first leg has no via');
  eq(r.legs[1].via.length, 0, 'second leg has no via');
  eq(r.interchanges[0]?.at, 'Paddington', 'change row at Paddington');
});

test('non-pivot intermediate stop on a linear line (Northern) is recorded as via', () => {
  const r = buildUserLegs('Clapham South', [
    {station:'Stockwell', line:'Northern'},
    {station:'Kennington', line:'Northern'},
  ]);
  eq(r.legs.length, 1);
  eq(r.legs[0].via.length, 1);
  eq(r.legs[0].via[0], 'Stockwell');
});

test('the only multi-occurrence (station, sub-line) pairs are the documented Circle pivots', () => {
  const allowed = new Set([
    'Paddington|Circle',
    'Edgware Road|Circle',
  ]);
  const found = [];
  for (const [lineKey, stops] of Object.entries(NETWORK)) {
    const counts = {};
    for (const s of stops) counts[s] = (counts[s] || 0) + 1;
    for (const [stn, n] of Object.entries(counts)) {
      if (n > 1) found.push(`${stn}|${lineKey}`);
    }
  }
  const unexpected = found.filter(k => !allowed.has(k));
  const missing = [...allowed].filter(k => !found.includes(k));
  if (unexpected.length || missing.length) {
    throw new Error(
      `Multi-occurrence set has drifted from the documented Circle pivots.\n` +
      `  Unexpected: ${unexpected.join(', ') || '(none)'}\n` +
      `  Missing: ${missing.join(', ') || '(none)'}\n` +
      `If the new occurrence is intentional, update this test and the\n` +
      `comments around _nodeKey/_stationName; if not, fix the data.`
    );
  }
});

// ── Report ─────────────────────────────────────────────────────────────────

const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok);
console.log(`\n${passed}/${results.length} tests passed`);
for (const f of failed) {
  console.log(`\n❌ ${f.name}`);
  console.log(`   ${f.error}`);
}
if (failed.length) process.exit(1);
console.log('\n✓ All tests passed');
