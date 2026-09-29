// Tube adjacent-hop travel times for Tubed, verified against TfL.
//   node tests/tube_hop_times.test.mjs
//   TUBED_HTML=backups/some.bak node tests/tube_hop_times.test.mjs
//
// WHY THIS FILE EXISTS
//
// build_times.py reads ONE service-interval pattern per line:
//
//     best_interval = station_intervals[0]
//
// The `min()` reduction over all_times[key] further down was meant to keep the
// fastest observed run, but it never sees the other patterns, so whichever
// pattern sits at index 0 wins. On lines with fast and slow patterns that can
// bank the SLOWEST run as the game's travel time.
//
// The report in build_times.py cannot catch it either: compare() only flags
// `abs(tfl - cur) > 1`, so a one-minute error of exactly this kind is
// invisible by design.
//
// This file pins the hops where that has been measured and corrected, with the
// evidence in each comment. Add a row whenever another is verified — the 2026
// audit found 25 entries above the median of their observed patterns and 8
// above every observed train, so this list is expected to grow.

import { loadEngine } from './lib/engine.mjs';

const T = loadEngine(process.env.TUBED_HTML || 'index.html');

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: e.message }); }
}
function eq(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

// ── Verified hops ──────────────────────────────────────────────────────────
//
// Each row: [from, to, branchLine, expected, evidence]
const VERIFIED = [
  // Reported by a player on puzzle #178 (2026-09-27, Kilburn Park -> Finchley
  // Road): the non-stop Metropolitan run read SLOWER than the Jubilee's
  // three-stop run over the same corridor.
  //
  // TfL timetable patterns for this hop: [5, 6, 6, 7, 7] (five patterns, from
  // Amersham/Uxbridge/Chesham origins). Journey Planner returns 6 min for the
  // Metropolitan AND 6 for the Jubilee. The game had banked 7, the slowest.
  //
  // The Jubilee side of the same corridor is already correct and is asserted
  // below: its three hops are each the median of their own patterns and sum
  // to 6, so before this fix the corridor was scored median-versus-max.
  //
  // NOTE the remaining 1 min of that puzzle's 2-min gap is the Baker Street
  // boarding wait (Met 2, Jubilee 1) and is CORRECT — the Jubilee really is
  // more frequent off-peak. Do not "fix" that half.
  ['Finchley Road', 'Baker Street', 'Metropolitan_Amersham_Aldgate', 6,
   'TfL patterns [5,6,6,7,7]; Journey Planner 6'],
];

test('verified tube hop times match TfL', () => {
  const bad = [];
  for (const [a, b, line, expected, evidence] of VERIFIED) {
    const actual = T.getTime(a, b, line);
    if (actual !== expected) {
      bad.push(`${a} -> ${b} [${line}]: expected ${expected}, got ${actual}  (${evidence})`);
    }
  }
  if (bad.length) throw new Error('hop times disagree with TfL:\n  ' + bad.join('\n  '));
});

// All four Metropolitan branches run the same physical non-stop track here, so
// none of them may disagree. A per-branch override would be a silent way to
// reintroduce the bug on one pattern only.
test('every Metropolitan branch prices Finchley Road -> Baker Street alike', () => {
  const branches = [
    'Metropolitan_Amersham_Aldgate', 'Metropolitan_Chesham_Aldgate',
    'Metropolitan_Uxbridge_Aldgate', 'Metropolitan_Watford_Aldgate',
  ];
  const seen = new Map();
  for (const br of branches) {
    seen.set(br, T.getTime('Finchley Road', 'Baker Street', br));
  }
  const vals = [...new Set(seen.values())];
  if (vals.length !== 1) {
    throw new Error('branches disagree:\n  ' +
      [...seen].map(([k, v]) => `${k} = ${v}`).join('\n  '));
  }
  eq('all Metropolitan branches', vals[0], 6);
});

// The corridor invariant this whole fix is about: a non-stop run must not cost
// MORE travel time than a parallel run that makes two intermediate stops.
// Stated as travel time only, deliberately — the wait difference is separate
// and legitimate, so folding it in here would make the test pass for the
// wrong reason.
test('non-stop Met is not slower than the stopping Jubilee, Baker St -> Finchley Rd', () => {
  const met = T.getTime('Finchley Road', 'Baker Street', 'Metropolitan_Amersham_Aldgate');
  const jub = T.getTime('Baker Street', "St. John's Wood", 'Jubilee')
            + T.getTime("St. John's Wood", 'Swiss Cottage', 'Jubilee')
            + T.getTime('Swiss Cottage', 'Finchley Road', 'Jubilee');
  eq('Jubilee three-hop total (TfL medians 3+1+2)', jub, 6);
  if (met > jub) {
    throw new Error(
      `the non-stop Metropolitan run (${met}) costs more travel time than the ` +
      `Jubilee's two-stop run (${jub}) over the same corridor`);
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
