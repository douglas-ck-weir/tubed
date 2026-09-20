// Baker Street interchange regression tests for Tubed.
// Run with: node tests/baker_street_interchange.test.mjs
// Exits 0 on success, 1 on any failure.
//
// WHY THIS EXISTS
// ---------------
// Reported by a player 2026-09-08: "The change from Jubilee to Hammersmith and
// City/Circle at Baker Street is not a 9 minute walk!! It is 3-4 minutes."
//
// They were right, and the 9 was real TfL data. INTERCHANGE_MINS is generated
// from the Stop Structure API, whose footpath record for this pair is a literal
// `<footpathInfo duration="9">` itemised as STAIRS 36m, STAIRS 31m, ESCALATOR
// 86m, ESCALATOR 24m, LEVEL 38m. Journey Planner's interChangeDuration agrees
// (9 one way, 10 the other, zero spread over 212 sampled connections).
//
// The catch is the PACE. Across all 36,889 cached footpaths TfL's durations
// imply a median 0.64 m/s against a normal walking 1.3-1.4. TfL publishes a
// planning allowance, not a walk. The straight-line platform gap here is 152 m
// and TfL's own route is 216 m; nine minutes for that is 0.4 m/s.
//
// Three independent sources put the real walk far lower: the player at 3-4,
// Google Maps at 2 (it splits the same 8-minute gap as 2 walk + 6 wait, where
// TfL splits it 9 walk + 1 wait), and the geometry at ~4-5. We take 4.
//
// This is NOT a wait double-count. interChangeDuration excludes waiting: over
// 212 Baker Street connections the gap between arrival and next departure minus
// icDur was never negative, median +1. The wait is charged separately by
// waitTime(), as it always was.
//
// The values live in build_interchanges/overrides.py MANUAL_OVERRIDES. Without
// that entry the next `--apply` run silently restores TfL's numbers, exactly as
// the Blackhorse Road entry warns.
//
// NOT FIXED NETWORK-WIDE ON PURPOSE. The same inflation affects 46 of 271
// cells, but recalibrating all of them from geometry breaks Canary Wharf:
// DLR|Jubilee 11 -> 6 flips Green Park -> Mudchute off the Heron Quays walk
// that is verified correct. Baker Street is 216 m over 5 levels and really ~4
// min; Canary Wharf is 298 m over 4 levels and really ~11. More distance, fewer
// levels, three times the transfer. No formula over those inputs gives both.

import { loadEngine } from './lib/engine.mjs';

const T = loadEngine(process.env.TUBED_HTML || 'index.html');

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${expected}, got ${actual}`);
}

console.log('\n-- The reported pair --');
// The whole point of the fix. 9 was TfL's allowance; 4 is the walk.
check('Jubilee -> Hammersmith & City is 4, not TfL\'s 9',
  T.interchangeTime('Baker Street', 'Jubilee', 'Hammersmith & City'), 4);
check('Jubilee -> Circle is 4, not TfL\'s 9',
  T.interchangeTime('Baker Street', 'Jubilee', 'Circle'), 4);
check('symmetric: Circle -> Jubilee',
  T.interchangeTime('Baker Street', 'Circle', 'Jubilee'), 4);

console.log('\n-- The rest of the station, recalibrated coherently --');
// Bakerloo|Circle carried the same inflation (7 for a 177 m path) and had to
// move with it, or Baker Street would price a SHORTER walk above a longer one.
for (const [a, b, want] of [
  ['Bakerloo', 'Circle', 4],
  ['Bakerloo', 'Hammersmith & City', 4],
  ['Bakerloo', 'Metropolitan', 2],
  ['Circle', 'Metropolitan', 2],
  ['Hammersmith & City', 'Metropolitan', 2],
  ['Jubilee', 'Metropolitan', 3],
]) {
  check(`${a} -> ${b} is ${want}`, T.interchangeTime('Baker Street', a, b), want);
}

console.log('\n-- Unchanged, and must stay that way --');
// Bakerloo|Jubilee was already right: a single 38 m LEVEL passage, no stairs.
check('Bakerloo -> Jubilee stays 2', T.interchangeTime('Baker Street', 'Bakerloo', 'Jubilee'), 2);
// Circle and H&C genuinely share platforms 5/6 here.
check('Circle -> Hammersmith & City stays 1',
  T.interchangeTime('Baker Street', 'Circle', 'Hammersmith & City'), 1);

console.log('\n-- No shortcut through the Bakerloo platform --');
// TfL's own 9 was composed as Circle->Bakerloo 7 + Bakerloo->Jubilee 2, and its
// footpath literally routes via the Bakerloo platform area. So the direct value
// must never exceed the two-hop pivot, or the table would say the detour beats
// the route it is a detour OF. This is the Paddington failure mode generalised.
const direct = T.interchangeTime('Baker Street', 'Circle', 'Jubilee');
const pivot = T.interchangeTime('Baker Street', 'Circle', 'Bakerloo')
            + T.interchangeTime('Baker Street', 'Bakerloo', 'Jubilee');
check(`direct (${direct}) does not exceed the Bakerloo pivot (${pivot})`, direct <= pivot, true);

console.log('\n-- Player-visible effect --');
// The published optimal a player actually sees. 27 before the fix, 22 after.
const g = T.buildGraph();
const opt = T.pickOptimal(T.dijkstra(g, 'Latimer Road', 'Swiss Cottage'),
  { date: '2026-11-18', mode: 'easy' });
check('Latimer Road -> Swiss Cottage optimal is 22', opt ? opt.mins : null, 22);

console.log('\n-- Search and scorer must agree --');
// Cheaper interchanges are exactly how a beatable optimal gets created: if
// dijkstra prices the change differently from scoreLegs, the published number
// is one a player can undercut.
for (const [s, e] of [['Latimer Road', 'Swiss Cottage'],
                      ['Canada Water', 'Great Portland Street'],
                      ['New Cross Gate', 'Latimer Road']]) {
  const best = T.dijkstra(T.buildGraph(), s, e)[0];
  const scored = T.scoreLegs(best.legs, s);
  check(`${s} -> ${e}: dijkstra total matches scoreLegs`, scored.totalMins, best.mins);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
