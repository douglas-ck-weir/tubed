// Paddington split-platform regression tests for Tubed.
// Run with: node tests/paddington_split_platforms.test.mjs
// Exits 0 on success, 1 on any failure.
//
// WHY THIS EXISTS
// ---------------
// Paddington's sub-surface platforms are TWO physically separate groups:
//
//   Praed Street  (940GZZLUPAC areas 3/4) — Circle + District
//   Bishop's Road (940GZZLUPAH areas 1/2) — Circle + Hammersmith & City
//
// TfL's own Stop Structure footpath between them is 14 minutes, and
// INTERCHANGE_MINS already charges exactly that for District|Hammersmith & City.
//
// The bug: build_interchanges declares BOTH {Circle,District} and
// {Circle,H&C} as same-platform 1-min pairs. Each is true of ONE group, but
// the game models "Circle" as a single line, so the 1 leaked onto Circle legs
// that actually depart the far platforms. interchangeTime() took no direction
// argument and so could not tell the two groups apart — even though buildGraph
// already splits the Circle into two synthetic occurrence nodes here, and
// resolveLegBranch already knows Paddington appears twice on the teardrop.
//
// Player-visible effect: two trains on the SAME platform bound for the SAME
// place were priced 13 minutes apart purely by line name, and the cheap one
// was the impossible one. It shipped in a live puzzle (2026-09-10 hard,
// Bayswater -> Seven Sisters, published optimal 32 min, built on a 1-min
// change that is really the 14-min crossing).
//
// Reported by a player 2026-09-08 as "different change times from District at
// Edgware Rd to Circle than H&C line". Edgware Road station itself is fine —
// all three lines genuinely share its island platforms. The player was naming
// the District's Edgware Road BRANCH; the change was at Paddington.
//
// TfL Journey Planner corroborates: for Earl's Court -> Westbourne Park it
// never changes at Paddington. It rides past to Edgware Road and doubles back.

import { loadEngine } from './lib/engine.mjs';

const T = loadEngine(process.env.TUBED_HTML || 'index.html');

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${expected}, got ${actual}`);
}

// Cost of the change at Paddington in a two-leg user route.
function changeAtPaddington(start, mid, midLine, end, endLine) {
  const r = T.buildUserLegs(start, [
    {station: mid, line: midLine},
    {station: end, line: endLine},
  ]);
  const ic = r.interchanges.find(x => x && x.at === 'Paddington');
  return ic ? ic.walkMins : null;
}

console.log('\n-- Same platform, same destination, must cost the same --');
// Royal Oak is reachable ONLY from Bishop's Road. A Circle train and an H&C
// train to Royal Oak leave the SAME face of the SAME platform, so arriving on
// the District at Praed Street must cost the identical crossing either way.
const circleToRoyalOak = changeAtPaddington('Bayswater', 'Paddington', 'District', 'Royal Oak', 'Circle');
const hcToRoyalOak     = changeAtPaddington('Bayswater', 'Paddington', 'District', 'Royal Oak', 'Hammersmith & City');
check('District -> H&C   toward Royal Oak is the 14-min crossing', hcToRoyalOak, 14);
check('District -> Circle toward Royal Oak is the 14-min crossing', circleToRoyalOak, 14);
check('the two agree (same platform, same train)', circleToRoyalOak, hcToRoyalOak);

console.log('\n-- The live puzzle that shipped the bug --');
// Kings Cross sits at Circle index 13; Paddington's two occurrences are at 8
// (Bishop's Road) and 35 (Praed Street). Only #8 reaches Kings Cross, so this
// change is the crossing, not a same-platform step.
check('District -> Circle toward Kings Cross is the 14-min crossing',
  changeAtPaddington('Bayswater', 'Paddington', 'District', 'Kings Cross St. Pancras', 'Circle'), 14);

console.log('\n-- No over-correction: the genuine same-platform change stays cheap --');
// Notting Hill Gate is reached via Bayswater, i.e. Praed Street — the platform
// the District already arrived on. This one really is a 1-minute step across.
// Arrive on the District from Edgware Road, so the leg alights on the Praed
// Street face, then take the Circle onward toward Bayswater / Notting Hill
// Gate (Circle index 33-34, nearest Paddington occurrence is 35 = Praed
// Street). Same platforms, so this must stay a 1-minute step.
check('District -> Circle toward Notting Hill Gate stays same-platform',
  changeAtPaddington('Edgware Road', 'Paddington', 'District', 'Notting Hill Gate', 'Circle'), 1);

console.log('\n-- Search and scorer must agree --');
// If dijkstra prices the change differently from scoreLegs, the published
// optimal becomes beatable. Score the search's own legs and compare.
for (const [s, e] of [['Bayswater', 'Seven Sisters'], ["Earl's Court", 'Westbourne Park']]) {
  const best = T.dijkstra(T.buildGraph(), s, e)[0];
  const scored = T.scoreLegs(best.legs, s);
  check(`${s} -> ${e}: dijkstra total matches scoreLegs`, scored.totalMins, best.mins);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
