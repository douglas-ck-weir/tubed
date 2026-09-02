// Mutation harness for Tubed.
// Run with: node tests/mutations.test.mjs
// Exits 0 when every mutation was caught, 1 when any SURVIVED.
//
// WHY THIS EXISTS
// ---------------
// A green suite proves the tests ran, not that they would notice a break. On
// 2026-09-01 a test for the stale-✓ fix passed against code that still had the
// bug, because the test hand-set state that is never set at init(). It looked
// like proof and wasn't.
//
// So: deliberately break the code, one edit at a time, and check the suite
// goes red. A mutation that SURVIVES is a hole — the behaviour it breaks is
// not actually covered by anything.
//
// Each entry names the minimal test file that should catch it, so the run
// stays quick enough to sit in CI.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// name  — what is being broken, in plain terms
// tests — the test file(s) that MUST go red
// find/replace — a surgical, unambiguous edit (must match exactly once)
const MUTATIONS = [
  // ── the timezone fix ─────────────────────────────────────────────────────
  {
    name: 'todayKey() reads the device day instead of London',
    tests: ['day_keys.test.mjs'],
    find: 'function todayKey(d) { return londonDateParts(d).dateStr; }',
    replace: 'function todayKey(d) { const x = d || new Date(); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`; }',
  },
  {
    name: 'yesterdayKey() goes back to subtracting 24h (breaks on DST)',
    tests: ['day_keys.test.mjs'],
    find: '  const { y, mo, da } = londonDateParts(d);\n  const prev = new Date(Date.UTC(y, mo - 1, da) - 86400000);',
    replace: '  const prev = new Date((d ? d.getTime() : Date.now()) - 86400000);\n  return londonDateParts(prev).dateStr; /*',
    close: '*/',
  },
  {
    name: '_toDayKey() reads the legacy day with the wrong field',
    tests: ['day_keys.test.mjs'],
    find: "      return `${m[3]}-${String(mon + 1).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;",
    replace: "      return `${m[3]}-${String(mon + 1).padStart(2, '0')}-${String(+m[2] + 1).padStart(2, '0')}`;",
  },
  {
    name: 'migration no longer clamps a future device day',
    tests: ['day_keys.test.mjs'],
    find: "  const clamp = v => (/^\\d{4}-\\d{2}-\\d{2}$/.test(v || '') && v > today) ? today : v;",
    replace: '  const clamp = v => v;',
  },
  {
    name: '_toDayKey() goes back to relying on Date.parse for legacy values',
    tests: ['day_keys.test.mjs'],
    find: "  const m = /^[A-Za-z]{3} ([A-Za-z]{3}) (\\d{1,2}) (\\d{4})$/.exec(s.trim());",
    replace: '  const m = null;',
  },
  {
    name: '_dayLabel() formats in local time (shifts the day west of GMT)',
    tests: ['day_keys.test.mjs'],
    find: '  return `${_DAY_ABBR[d.getUTCDay()]} ${d.getUTCDate()} ${_MON_ABBR[d.getUTCMonth()]} ${d.getUTCFullYear()}`;',
    replace: '  return `${_DAY_ABBR[d.getDay()]} ${d.getDate()} ${_MON_ABBR[d.getMonth()]} ${d.getFullYear()}`;',
  },

  // ── the stale-result guard ───────────────────────────────────────────────
  {
    name: '_storedSubmissionMatches() always says yes',
    tests: ['day_keys.test.mjs'],
    find: 'function _storedSubmissionMatches(s, puzzleDataForMode) {\n  if (!s || !s.submittedRoute',
    replace: 'function _storedSubmissionMatches(s, puzzleDataForMode) {\n  if (s && s.submittedRoute && s.submittedRoute.length) return true;\n  if (!s || !s.submittedRoute',
  },
  {
    name: 'the unstamped-legacy fallback stops checking the destination',
    tests: ['day_keys.test.mjs'],
    find: "  return !!last && (last.station || last) === puzzleDataForMode.end;",
    replace: '  return !!last;',
  },

  // ── the stale ✓ / wrong default tab ──────────────────────────────────────
  {
    name: '_modeSolvedToday() trusts lastPlayed alone',
    tests: ['day_keys.test.mjs'],
    find: '  const pd = _puzzleForMode(mode);\n  if (!pd) return true;',
    replace: '  const pd = null;\n  if (!pd) return true;',
  },
  {
    name: '_puzzleForMode() never resolves an unwarmed mode',
    tests: ['day_keys.test.mjs'],
    find: '  if (!_LOOKUP_SETTLED) return null;',
    replace: '  return null;',
  },

  // ── streaks ──────────────────────────────────────────────────────────────
  {
    name: 'streak continues only on an exact yesterday (loses the migration case)',
    tests: ['day_keys.test.mjs'],
    find: "lastPlayed >= yesterdayKey();",
    replace: 'lastPlayed === yesterdayKey();',
  },
  {
    name: 'streak day gate ignores which puzzle the submission answered',
    tests: ['day_keys.test.mjs'],
    find: '  return !(store.lastPlayed === today && _storedSubmissionMatches(store, puzzleDataForMode));',
    replace: '  return store.lastPlayed !== today;',
  },
  {
    name: 'a garbage lastPlayed silently continues a streak',
    tests: ['day_keys.test.mjs'],
    find: "  const cont = lastPlayed && /^\\d{4}-\\d{2}-\\d{2}$/.test(lastPlayed) && lastPlayed >= yesterdayKey();",
    replace: '  const cont = lastPlayed && lastPlayed >= yesterdayKey();',
  },

  {
    name: 'the submission is attached AFTER the tab refresh (the vanished ✓)',
    tests: ['day_keys.test.mjs'],
    find: '  store.submittedRoute     = userRoute.slice();',
    replace: '  /* written later, as it used to be */',
  },

  {
    name: 'the pre-migration store is never stashed (rollback loses streaks)',
    tests: ['day_keys.test.mjs'],
    find: '          if (rawV6 && !localStorage.getItem(PRE_DAYKEYS_BACKUP_KEY)) {',
    replace: '          if (false) {',
  },

  // ── pre-existing suite: prove those tests bite too ───────────────────────
  {
    name: 'default wait time changed 3 → 4',
    // Note: wait_times.test.mjs does NOT catch this despite the name — it
    // asserts the shape and lookups of the data, not its effect on cost.
    // scoring_invariants does, because the change moves route totals.
    tests: ['scoring_invariants.test.mjs'],
    find: 'const WAIT_MINS_DEFAULT = 3;',
    replace: 'const WAIT_MINS_DEFAULT = 4;',
  },
  {
    name: 'pickOptimal publishes the second-best route',
    tests: ['dijkstra_optimal.test.mjs', 'scoring_invariants.test.mjs'],
    find: '  const routes = [], seen = new Set();',
    replace: '  const routes = [], seen = new Set(); candidates.reverse();',
  },
];

const tmp = mkdtempSync(path.join(tmpdir(), 'tubed-mut-'));
const results = [];

// BASELINE FIRST. Without this the whole run is worthless: if a test file is
// already failing for an unrelated reason, every mutation it "catches" is a
// false pass, and the harness cheerfully reports 17/17. That happened on
// 2026-09-01 (a missing export), so it is checked rather than assumed.
const needed = [...new Set(MUTATIONS.flatMap(m => m.tests))];
const baselineFailures = [];
for (const t of needed) {
  const r = spawnSync(process.execPath, [path.join(__dirname, t)], {
    env: { ...process.env, TUBED_HTML: path.join(ROOT, 'index.html') },
    encoding: 'utf8', timeout: 300000,
  });
  if (r.status !== 0) baselineFailures.push(t);
}
if (baselineFailures.length) {
  console.log('BASELINE FAILING — fix these before the mutation run means anything:');
  for (const t of baselineFailures) console.log(`  ✗ ${t} fails against unmutated index.html`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
console.log(`baseline: ${needed.length} test file(s) green against unmutated source\n`);

for (const m of MUTATIONS) {
  const n = SRC.split(m.find).length - 1;
  if (n !== 1) {
    results.push({ name: m.name, status: 'STALE', detail: `anchor matched ${n} times, expected 1` });
    continue;
  }
  const mutated = SRC.replace(m.find, m.replace + (m.close || ''));
  const file = path.join(tmp, m.name.replace(/[^a-z0-9]+/gi, '_') + '.html');
  writeFileSync(file, mutated);

  let caughtBy = null;
  for (const t of m.tests) {
    const r = spawnSync(process.execPath, [path.join(__dirname, t)], {
      env: { ...process.env, TUBED_HTML: file },
      encoding: 'utf8',
      timeout: 300000,
    });
    if (r.status !== 0) { caughtBy = t; break; }
  }
  results.push(caughtBy
    ? { name: m.name, status: 'caught', detail: caughtBy }
    : { name: m.name, status: 'SURVIVED', detail: m.tests.join(', ') });
}

rmSync(tmp, { recursive: true, force: true });

for (const r of results) {
  const mark = r.status === 'caught' ? '✓' : '✗';
  const label = r.status === 'caught' ? `caught by ${r.detail}` : `${r.status} (${r.detail})`;
  console.log(`  ${mark} ${r.name}\n      ${label}`);
}
const bad = results.filter(r => r.status !== 'caught');
console.log(`\n${results.length - bad.length}/${results.length} mutations caught`);
if (bad.length) {
  console.log('\nSURVIVING MUTATIONS ARE COVERAGE HOLES — the suite would not notice these breaks.');
}
process.exit(bad.length === 0 ? 0 : 1);
