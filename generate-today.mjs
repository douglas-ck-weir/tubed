// Runs at midnight UK time via GitHub Actions.
// Reads the canonical entry for today from puzzle-lookup.json (built by
// build-lookup.mjs running the real todayPuzzle() from index.html) and
// writes today.json for the Devvit Reddit bot to consume.
//
// Single source of truth: the browser's todayPuzzle() → puzzle-lookup.json →
// today.json. No parallel station-picking logic to drift.
import { readFileSync, writeFileSync } from 'fs';

// London-time YYYY-MM-DD — matches the date string the browser computes via
// londonDateParts() in index.html, so every player worldwide sees the same
// puzzle on a given calendar day.
function londonDateStr(d) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d || new Date());
  const get = t => Number(parts.find(p => p.type === t).value);
  const y = get('year'), mo = get('month'), da = get('day');
  return `${y}-${String(mo).padStart(2,'0')}-${String(da).padStart(2,'0')}`;
}

const dateStr = londonDateStr();
const lookup = JSON.parse(readFileSync('puzzle-lookup.json', 'utf8'));
const entry = lookup[dateStr];
if (!entry) {
  throw new Error(`No entry for ${dateStr} in puzzle-lookup.json — run \`node build-lookup.mjs\` to regenerate.`);
}

const output = {
  date: dateStr,
  puzzleNum: entry.puzzleNum,
  easy: { start: entry.easy.start, end: entry.easy.end },
  hard: { start: entry.hard.start, end: entry.hard.end },
};

writeFileSync('today.json', JSON.stringify(output, null, 2));
console.log('today.json written:', output);
