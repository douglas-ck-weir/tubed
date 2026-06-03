// Three-way agreement test for the daily puzzle.
// Run with: node tests/puzzle-sources.test.mjs
// Exits 0 on success, 1 on any failure.
//
// Invariants checked:
//   1. today.json content matches puzzle-lookup.json[today.json.date].
//   2. Both easy.{start,end} and hard.{start,end} in today.json exist in
//      the PUZZLE_STATIONS list embedded in index.html.
//   3. build-lookup.mjs is deterministic: running it twice produces byte-
//      identical output (catches accidental non-determinism in the picker).
//
// Catches the class of bug where the site, the published JSON, and the
// Reddit bot's bundled lookup disagree on what today's puzzle is.

import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TODAY_JSON  = path.join(ROOT, 'today.json');
const LOOKUP_JSON = path.join(ROOT, 'puzzle-lookup.json');
const INDEX_HTML  = path.join(ROOT, 'index.html');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

const today  = JSON.parse(readFileSync(TODAY_JSON,  'utf8'));
const lookup = JSON.parse(readFileSync(LOOKUP_JSON, 'utf8'));

// Extract PUZZLE_STATIONS from index.html. The array is a literal at the
// top of one of the inline scripts; we parse it out rather than evaluate
// the whole script (the network.test.mjs harness already covers that path).
const html = readFileSync(INDEX_HTML, 'utf8');
const stationsMatch = html.match(/const\s+PUZZLE_STATIONS\s*=\s*\[([\s\S]*?)\];/);
if (!stationsMatch) {
  console.error('FATAL: could not find PUZZLE_STATIONS literal in index.html');
  process.exit(1);
}
const PUZZLE_STATIONS = new Set(
  [...stationsMatch[1].matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)].map(m => m[2].replace(/\\'/g, "'"))
);
assert(PUZZLE_STATIONS.size > 50, `PUZZLE_STATIONS parsed too small (${PUZZLE_STATIONS.size}) — parser likely broken`);

// ── Invariant 1: today.json matches puzzle-lookup.json[today.date] ─────────

test('today.json.date is present in puzzle-lookup.json', () => {
  assert(lookup[today.date], `puzzle-lookup.json has no entry for ${today.date}. Regenerate with: node build-lookup.mjs`);
});

test('today.json.puzzleNum matches lookup[date].puzzleNum', () => {
  assertEq(today.puzzleNum, lookup[today.date].puzzleNum, `puzzleNum mismatch for ${today.date}`);
});

test('today.json.easy matches lookup[date].easy', () => {
  assertEq(today.easy.start, lookup[today.date].easy.start, `easy.start mismatch for ${today.date}`);
  assertEq(today.easy.end,   lookup[today.date].easy.end,   `easy.end mismatch for ${today.date}`);
});

test('today.json.hard matches lookup[date].hard', () => {
  assertEq(today.hard.start, lookup[today.date].hard.start, `hard.start mismatch for ${today.date}`);
  assertEq(today.hard.end,   lookup[today.date].hard.end,   `hard.end mismatch for ${today.date}`);
});

// ── Invariant 2: stations exist in PUZZLE_STATIONS ─────────────────────────

test('today.json easy stations exist in PUZZLE_STATIONS', () => {
  assert(PUZZLE_STATIONS.has(today.easy.start), `easy.start "${today.easy.start}" not in PUZZLE_STATIONS`);
  assert(PUZZLE_STATIONS.has(today.easy.end),   `easy.end "${today.easy.end}" not in PUZZLE_STATIONS`);
});

test('today.json hard stations exist in PUZZLE_STATIONS', () => {
  assert(PUZZLE_STATIONS.has(today.hard.start), `hard.start "${today.hard.start}" not in PUZZLE_STATIONS`);
  assert(PUZZLE_STATIONS.has(today.hard.end),   `hard.end "${today.hard.end}" not in PUZZLE_STATIONS`);
});

// ── Invariant 3: build-lookup.mjs is deterministic ─────────────────────────
// We rebuild into a temp file, compare to the committed file. This also
// implicitly tests that the picker's output for "today" still matches what's
// in the committed lookup (drift catcher).

test('build-lookup.mjs is deterministic and matches committed lookup', () => {
  const backup = path.join(ROOT, 'puzzle-lookup.json.test-backup');
  copyFileSync(LOOKUP_JSON, backup);
  try {
    execSync('node build-lookup.mjs', { cwd: ROOT, stdio: 'pipe' });
    const rebuilt = readFileSync(LOOKUP_JSON, 'utf8');
    const original = readFileSync(backup, 'utf8');
    if (rebuilt !== original) {
      // Find first differing day so the failure message is useful.
      const a = JSON.parse(original), b = JSON.parse(rebuilt);
      const days = Object.keys(b).sort();
      let firstDiff = null;
      for (const d of days) {
        if (JSON.stringify(a[d]) !== JSON.stringify(b[d])) { firstDiff = d; break; }
      }
      throw new Error(
        `build-lookup.mjs output drifted from committed puzzle-lookup.json.\n` +
        `  First differing date: ${firstDiff}\n` +
        `  Committed: ${JSON.stringify(a[firstDiff])}\n` +
        `  Rebuilt:   ${JSON.stringify(b[firstDiff])}\n` +
        `  If the picker logic changed intentionally, commit the regenerated lookup.`
      );
    }
  } finally {
    // Always restore the committed version, even on failure, so the file on
    // disk is exactly what's in git after the test runs.
    copyFileSync(backup, LOOKUP_JSON);
    unlinkSync(backup);
  }
});

// ── Report ─────────────────────────────────────────────────────────────────

const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok);
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n      ${r.error.replace(/\n/g, '\n      ')}`}`);
}
console.log(`\n${passed}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
