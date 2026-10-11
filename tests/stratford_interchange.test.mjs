// Stratford Central/Elizabeth interchange regression test for Tubed.
// Run with: node tests/stratford_interchange.test.mjs
// Exits 0 on success, 1 on any failure.
//
// WHY THIS EXISTS
// ---------------
// Reported by a player 2026-10-11: "Central line to Elizabeth line at
// Stratford is cross platform interchange, 30 seconds not 4 minutes. Going
// between the westbound Central and Elizabeth line platforms takes 10
// seconds, as they back onto each other (same as Central/District at Mile
// End)."
//
// The 4 was real TfL data, but measured over the wrong route. The Stop
// Structure footpath (ICS 1000226) for Central|Elizabeth is a literal
// `<footpathInfo duration="5">` routed STAIRS+STAIRS via the main ticket
// hall (area 1) — the concourse route, not platform to platform.
//
// TfL's own station literature confirms the player: Platform 3 (Central
// westbound) and Platform 5 (Elizabeth westbound) share a platform, as do
// Platform 6 (Central eastbound) and Platform 8 (Elizabeth eastbound) — "the
// only cross-platform interchange on the whole Elizabeth line." Same
// treatment as Mile End Central|District (CROSS_PLATFORM_INTERCHANGES): 1.
//
// The value lives in build_interchanges/overrides.py MANUAL_OVERRIDES.
// Without that entry the next `--apply` run silently restores TfL's 5.

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
check('Central -> Elizabeth is 1, not TfL\'s 5',
  T.interchangeTime('Stratford', 'Central', 'Elizabeth'), 1);
check('symmetric: Elizabeth -> Central',
  T.interchangeTime('Stratford', 'Elizabeth', 'Central'), 1);

console.log('\n-- Unrelated Stratford pairs, must stay as they were --');
for (const [a, b, want] of [
  ['Central', 'DLR', 4],
  ['Central', 'Jubilee', 4],
  ['DLR', 'Elizabeth', 4],
  ['Elizabeth', 'Jubilee', 3],
]) {
  check(`${a} -> ${b} stays ${want}`, T.interchangeTime('Stratford', a, b), want);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
