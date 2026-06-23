// Generates a 90-day puzzle lookup table by running the exact same
// todayPuzzle() logic the browser uses, but for arbitrary future dates.
// Output: puzzle-lookup.json — consumed by the Devvit Reddit bot.
//
// How it works:
//   1. Reads index.html and slices out the JS region containing all puzzle
//      generation code (constants, NETWORK, dijkstra, todayPuzzle, etc.).
//   2. Wraps it in a sandbox with stubs for browser APIs (localStorage,
//      document) and a Date override so `new Date()` returns a fixed date.
//   3. For each day in the range, sets the override, calls todayPuzzle()
//      for both modes, captures {start, end}.
//
// Run: node build-lookup.mjs
import { readFileSync, writeFileSync } from 'fs';
import vm from 'vm';

const html = readFileSync('index.html', 'utf8');

// Find the <script> region that contains the puzzle logic. We grab from the
// LINE COLOURS constant through the end of todayPuzzle(). Using string markers
// to stay resilient to small line-number shifts.
const startMarker = 'const LINE_COLOURS = {';
const endMarker = '// ═══════════════════════════════════════════════════════════════════════════════\n// STATE';
const startIdx = html.indexOf(startMarker);
const endIdx = html.indexOf(endMarker);
if (startIdx === -1 || endIdx === -1) {
  throw new Error(`Could not find puzzle code region (start=${startIdx}, end=${endIdx})`);
}
const code = html.slice(startIdx, endIdx);

// Sandbox: provide stubs for browser APIs used inside the code region.
// Date is overridden so `new Date()` and `Date.now()` return our fixed date.
let FIXED_DATE = new Date();
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) {
      super(FIXED_DATE.getTime());
    } else {
      super(...args);
    }
  }
  static now() {
    return FIXED_DATE.getTime();
  }
}

const sandbox = {
  console,
  Math,
  JSON,
  Set,
  Map,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Error,
  Date: FakeDate,
  // Browser stubs
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  document: undefined,
  window: undefined,
};
vm.createContext(sandbox);

// Load the puzzle code into the sandbox.
vm.runInContext(code, sandbox);

// Generate the lookup for the next N days.
// Use 12:00 (midday) local time so puzzleNum's UTC-anchored epoch comparison
// stays on the right calendar day regardless of timezone — midnight-anchored
// dates can slip across the day boundary when compared to a UTC epoch.
const DAYS = 90;
const today = new Date();
today.setHours(12, 0, 0, 0);

// No-repeat window: a pair drawn in either mode is rejected from any later
// day's draw within the lookup horizon. We pass a Set of `start|end` strings
// into todayPuzzle() so its inner attempt loop skips collisions. Both
// directions are inserted because the generator may draw the reverse.
//
// IMPORTANT: We also seed this Set with recently-published pairs from the
// previous on-disk lookup BEFORE the generation loop runs. Without this,
// day 0 (today) of every cron run starts with empty recentPairs and can
// pick a pair that was published yesterday — the no-repeat window only
// protected against future-vs-future collisions, not against the recent
// past. This was a latent bug from the day recentPairs was introduced;
// it surfaced on 2026-06-23 when 22nd's and 23rd's seeded RNGs both
// produced Willesden Junction → Arsenal as their first acceptable pair.
const HISTORY_WINDOW_DAYS = 30;
const recentPairs = new Set();
function record(pair) {
  recentPairs.add(`${pair.start}|${pair.end}`);
  recentPairs.add(`${pair.end}|${pair.start}`);
}

// Seed recentPairs from the previous on-disk lookup. We keep a rolling
// HISTORY_WINDOW_DAYS of past pairs so the generator can't reuse anything
// from roughly the last month. Larger window = stronger no-repeat
// guarantee, but eventually exhausts the acceptable-pair pool, so we cap.
try {
  const prevLookup = JSON.parse(readFileSync('puzzle-lookup.json', 'utf8'));
  const todayStr = (() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  })();
  // Take every entry STRICTLY before today. Cap at HISTORY_WINDOW_DAYS most
  // recent. Dates are ISO YYYY-MM-DD so lexicographic sort = chronological.
  const pastEntries = Object.entries(prevLookup)
    .filter(([d]) => d < todayStr)
    .sort(([a], [b]) => b.localeCompare(a))  // newest first
    .slice(0, HISTORY_WINDOW_DAYS);
  let seeded = 0;
  for (const [, entry] of pastEntries) {
    if (entry.easy) { record(entry.easy); seeded++; }
    if (entry.hard) { record(entry.hard); seeded++; }
  }
  console.log(`Seeded recentPairs with ${seeded} pairs from ${pastEntries.length} past lookup days.`);
} catch (e) {
  // First-ever run: no previous lookup exists. That's fine — recentPairs
  // stays empty for the very first generation. Future runs will seed from
  // the lookup this run is about to write.
  console.warn('No previous puzzle-lookup.json to seed recentPairs from (first run?):', e.message);
}

// Preserve past entries from the previous lookup so the no-repeat history
// stays on disk. Without this, every regen drops yesterday's pair and
// loses the data we just seeded recentPairs from — meaning tomorrow's
// cron has nothing to seed from. We cap to a HISTORY_KEEP_DAYS rolling
// window so the file doesn't grow unbounded.
const HISTORY_KEEP_DAYS = 60;
const lookup = {};
try {
  const prev = JSON.parse(readFileSync('puzzle-lookup.json', 'utf8'));
  const todayStr = (() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  })();
  const past = Object.entries(prev)
    .filter(([d]) => d < todayStr)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, HISTORY_KEEP_DAYS);
  for (const [d, entry] of past) lookup[d] = entry;
} catch (e) { /* first run: no previous to preserve */ }

for (let i = 0; i < DAYS; i++) {
  const d = new Date(today);
  d.setDate(today.getDate() + i);
  FIXED_DATE = d;
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const easy = sandbox.todayPuzzle('easy', { recentPairs });
  // Only record real generator output. If the day fell through to the hardcoded
  // fallback pair (e.g. filters exhausted maxAttempts), recording it would
  // poison recentPairs and force later fallback days to publish duplicates.
  // Warn loudly so we don't silently ship fallback puzzles.
  if (easy.usedFallback) console.warn(`[build-lookup] WARN ${dateStr} easy used fallback ${easy.start} → ${easy.end}`);
  else record(easy);
  const hard = sandbox.todayPuzzle('hard', { recentPairs });
  if (hard.usedFallback) console.warn(`[build-lookup] WARN ${dateStr} hard used fallback ${hard.start} → ${hard.end}`);
  else record(hard);
  lookup[dateStr] = {
    puzzleNum: easy.puzzleNum,
    easy: { start: easy.start, end: easy.end },
    hard: { start: hard.start, end: hard.end },
  };
}

writeFileSync('puzzle-lookup.json', JSON.stringify(lookup, null, 2));
console.log(`Wrote ${Object.keys(lookup).length} days to puzzle-lookup.json`);
console.log('First 3 entries:', Object.fromEntries(Object.entries(lookup).slice(0, 3)));
