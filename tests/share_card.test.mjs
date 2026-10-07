// Share-snippet and result-card leaderboard tests for Tubed.
// Run with: node tests/share_card.test.mjs
// Exits 0 on success, 1 on any failure.
//
// WHY THIS EXISTS
// ---------------
// The podium line ("🏆 1st in the World!") is rendered TWICE from the same
// facts: once into the result card in the page, once into the plain-text
// snippet the player pastes into Reddit or a group chat. Those two started as
// independent copies of the same condition, which is exactly the shape that
// drifts — change the gate on one surface and a player sees a trophy on
// screen and none in the text they share, or the reverse.
//
// So the invariant these tests defend is not "the string is right" but
// "the two surfaces agree". _lbShowPodium() decides WHETHER for both and
// _lbPodiumLine() decides WHAT for both; section 5 asserts that neither
// surface can be changed without the other following, across the whole
// boundary matrix rather than a couple of happy-path examples.
//
// The two golden snippets in section 1 are the exact text signed off on
// 2026-09-27, byte for byte including emoji and spacing. They are the
// contract with the player, so they are pinned literally rather than
// assembled from the same pieces the code uses — a test that rebuilds the
// expected string the way the code builds it passes no matter what either
// does.

import { loadEngine } from './lib/engine.mjs';

const EXTRA = [
  'buildShareText', 'buildShareBlocks', 'renderLeaderboardBlock',
  '_lbShowPodium', '_lbPodiumLine', '_lbShowPct', '_lbAnchorLine',
  '_leaderboardStatsCache', '_LB_SHARE_DEFAULT',
  'LB_MIN_PLAYERS', 'LB_MAX_PCT', 'LB_MIN_OPTIMAL',
  'getModeStore', 'getStore', 'timerFmt',
];

// currentMode and puzzleData are top-level `let`, so they are unreachable
// from the host side — see the `append` note in lib/engine.mjs. Everything
// else the snippet reads is driven through its real path: the streak comes
// out of localStorage via getModeStore(), and the stats come out of the same
// cache object loadLeaderboardStats() writes to.
const T = loadEngine(process.env.TUBED_HTML || 'index.html', {
  extraExports: EXTRA,
  append: `globalThis.__setUI = (mode, pd) => { currentMode = mode; puzzleData = pd; };`,
});

const DATE = '2026-09-27';
const PUZZLE = { puzzleNum: 178, date: DATE };

// Seed the real store so getModeStore(mode).streak returns what we want.
// NOT hand-set on the module: streak 0 satisfies `streak % 5 === 0` and would
// silently add a "🔥 0 day streak" line to every golden snippet below.
function setUI(mode, { streak = 1 } = {}) {
  const empty = { streak: 0, lastPlayed: null, history: [] };
  T._localStorage.setItem('tubepzl_v6', JSON.stringify({
    easy: mode === 'easy' ? { ...empty, streak } : empty,
    hard: mode === 'hard' ? { ...empty, streak } : empty,
  }));
  T._ctx.__setUI(mode, PUZZLE);
}

// Put stats where buildShareText will look for them, or clear them.
function setStats(mode, stats) {
  const key = `${mode}:${DATE}`;
  if (stats === null) delete T._leaderboardStatsCache[key];
  else T._leaderboardStatsCache[key] = stats;
}

// A full stats row. Overrides on top of a board big and deep enough to pass
// every gate, so each test changes exactly the one field under examination.
const stats = (o = {}) => ({
  total_players: 120, top_pct: 1, is_top3: true, my_rank: 1,
  median_optimal_secs: null, optimal_count: 0, ...o,
});

function share(mode, opts, statsRow, { diff = 0, hints = 0, secs = 13 } = {}) {
  setUI(mode, opts);
  setStats(mode, statsRow);
  return T.buildShareText(diff, hints, 0, secs);
}

function card(statsRow) {
  const slot = { innerHTML: '' };
  T.renderLeaderboardBlock(slot, statsRow);
  return slot.innerHTML;
}

// ── Test framework ─────────────────────────────────────────────────────────
const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: e.message }); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'eq'}:\n      expected ${JSON.stringify(b)}\n      got      ${JSON.stringify(a)}`);
}
function truthy(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function falsy(v, msg)  { if (v)  throw new Error(msg || 'expected falsy'); }

// ── 0. Guard: the harness reaches the state it claims to ───────────────────
test('harness: setUI drives the real globals and the real store', () => {
  setUI('hard', { streak: 3 });
  eq(T.getModeStore('hard').streak, 3, 'streak did not come back through getStore');
  // If __setUI silently failed, mode would still be the 'easy' default and
  // every "Hard" assertion below would be testing nothing.
  truthy(T.buildShareText(0, 0, 0, 13).includes('🔥 Hard'),
    'currentMode was not actually set inside the sandbox');
  truthy(T.buildShareText(0, 0, 0, 13).includes('#178'),
    'puzzleData was not actually set inside the sandbox');
});

// ── 1. The two signed-off snippets, byte for byte ──────────────────────────
{
  test('Hard, 1st in the World — exact snippet', () => {
    eq(share('hard', { streak: 1 }, stats({ top_pct: 1, my_rank: 1 }), { secs: 13 }),
      [
        '🚇 Tubed #178 · 🔥 Hard · solved in 0:13',
        '🟩🟩🟩🟩🟩  Optimal route!',
        '✨ No hints used',
        '🏆 1st in the World!',
        '⁉️ Can anyone match this?',
        '➡️ playtubed.co.uk',
      ].join('\n'));
  });

  test('Easy, outside the top 3 — exact snippet', () => {
    eq(share('easy', { streak: 1 }, stats({ top_pct: 39, is_top3: false, my_rank: 47 }), { secs: 433 }),
      [
        '🚇 Tubed #178 · 🟢 Easy · solved in 7:13',
        '🟩🟩🟩🟩🟩  Optimal route!',
        '✨ No hints used',
        '📊 Top 39% today',
        '⁉️ Can anyone match this?',
        '➡️ playtubed.co.uk',
      ].join('\n'));
  });
}

// ── 2. The podium line itself ──────────────────────────────────────────────
{
  test('rank 1 takes the trophy', () => eq(T._lbPodiumLine(stats({ my_rank: 1 })), '🏆 1st in the World!'));
  test('rank 2 takes silver',     () => eq(T._lbPodiumLine(stats({ my_rank: 2 })), '🥈 2nd in the World!'));
  test('rank 3 takes bronze',     () => eq(T._lbPodiumLine(stats({ my_rank: 3 })), '🥉 3rd in the World!'));

  test('the three placements are distinguishable from each other', () => {
    const lines = [1, 2, 3].map(r => T._lbPodiumLine(stats({ my_rank: r })));
    eq(new Set(lines).size, 3, 'two placements render identically');
  });
}

// ── 3. The gate ────────────────────────────────────────────────────────────
{
  test('no stats at all is not a podium', () => {
    falsy(T._lbShowPodium(undefined));
    falsy(T._lbShowPodium(null));
  });

  test(`a board of ${T.LB_MIN_PLAYERS - 1} is too small even for #1`, () => {
    falsy(T._lbShowPodium(stats({ total_players: T.LB_MIN_PLAYERS - 1, my_rank: 1 })));
  });

  test(`a board of ${T.LB_MIN_PLAYERS} is enough`, () => {
    truthy(T._lbShowPodium(stats({ total_players: T.LB_MIN_PLAYERS, top_pct: 20, my_rank: 1 })));
  });

  test('4th place is not a podium however good the percentile', () => {
    falsy(T._lbShowPodium(stats({ is_top3: false, my_rank: 4, top_pct: 4 })));
  });

  // Server and client disagreeing is a real possibility (is_top3 is computed
  // in SQL, the rank range here is not). Neither alone may promote a player.
  test('is_top3 without a top-3 rank is refused', () => {
    falsy(T._lbShowPodium(stats({ is_top3: true, my_rank: 9 })));
  });
  test('a top-3 rank without is_top3 is refused', () => {
    falsy(T._lbShowPodium(stats({ is_top3: false, my_rank: 2 })));
  });

  test('a below-median percentile suppresses the podium with everything else', () => {
    falsy(T._lbShowPodium(stats({ top_pct: T.LB_MAX_PCT + 10 })),
      'the podium must not outlive the percentile gate it rides on');
  });
}

// ── 4. Placement: replaced in the snippet, added on the card ───────────────
{
  test('the snippet prints the podium INSTEAD of the percentile', () => {
    const txt = share('hard', { streak: 1 }, stats({ top_pct: 1, my_rank: 1 }));
    truthy(txt.includes('🏆 1st in the World!'), 'podium line missing');
    falsy(txt.includes('📊'), 'the percentile line is still there alongside the podium');
  });

  test('the snippet carries exactly one ranking line, whoever you are', () => {
    const rows = [
      stats({ my_rank: 1, top_pct: 1 }),
      stats({ my_rank: 3, top_pct: 3 }),
      stats({ is_top3: false, my_rank: 40, top_pct: 33 }),
    ];
    for (const r of rows) {
      const n = share('hard', { streak: 1 }, r).split('\n')
        .filter(l => l.includes('in the World!') || l.startsWith('📊')).length;
      eq(n, 1, `rank ${r.my_rank} produced ${n} ranking lines`);
    }
  });

  test('the card keeps BOTH — band above, podium under it', () => {
    const html = card(stats({ top_pct: 1, my_rank: 1 }));
    truthy(html.includes('📊 TOP 1% TODAY'), 'percentile band missing from the card');
    truthy(html.includes('🏆 1st in the World!'), 'podium line missing from the card');
    truthy(html.indexOf('TOP 1% TODAY') < html.indexOf('in the World!'),
      'the podium must sit under the band, not above it');
  });

  test('the card no longer uses the old "You\'re #N today" wording', () => {
    falsy(card(stats({ my_rank: 1 })).includes("You're #"),
      'card still renders the pre-alignment wording');
  });

  test('no ranking line at all when there is nothing to brag about', () => {
    const txt = share('hard', { streak: 1 }, null);
    falsy(txt.includes('📊'));
    falsy(txt.includes('in the World!'));
  });
}

// ── 5. The invariant: the card and the snippet never disagree ──────────────
// This is the section that would have caught the drift the shared helper was
// introduced to prevent. It walks the boundary matrix rather than examples.
{
  const MATRIX = [];
  for (const total of [T.LB_MIN_PLAYERS - 1, T.LB_MIN_PLAYERS, 120]) {
    for (const rank of [1, 2, 3, 4, 40]) {
      for (const pct of [1, 10, T.LB_MAX_PCT, T.LB_MAX_PCT + 1]) {
        MATRIX.push(stats({ total_players: total, my_rank: rank, top_pct: pct, is_top3: rank <= 3 }));
      }
    }
  }

  test(`card and snippet agree on WHETHER, across ${MATRIX.length} combinations`, () => {
    for (const s of MATRIX) {
      const inCard = card(s).includes('in the World!');
      const inShare = share('hard', { streak: 1 }, s).includes('in the World!');
      eq(inCard, inShare,
        `disagreement at players=${s.total_players} rank=${s.my_rank} pct=${s.top_pct}: card=${inCard} share=${inShare}`);
    }
  });

  test('card and snippet agree on WHAT, wherever both show it', () => {
    let checked = 0;
    for (const s of MATRIX) {
      if (!T._lbShowPodium(s)) continue;
      const line = T._lbPodiumLine(s);
      truthy(card(s).includes(line), `card text differs at rank ${s.my_rank}`);
      truthy(share('hard', { streak: 1 }, s).includes(line), `snippet text differs at rank ${s.my_rank}`);
      checked++;
    }
    truthy(checked > 0, 'the matrix produced no podium cases — this test proved nothing');
  });
}

// ── 6. Things the podium must not have disturbed ───────────────────────────
{
  test('a non-optimal run keeps its own challenge line', () => {
    const txt = share('easy', { streak: 1 }, stats({ is_top3: false, my_rank: 53, top_pct: 44 }),
      { diff: 7, hints: 2, secs: 500 });
    truthy(txt.includes('🤔 Think you know the Tube better?'));
    falsy(txt.includes('⁉️'));
    truthy(txt.includes('💡 2 hints used'));
    truthy(txt.includes('🟩🟩🟨🟨⬜  7 min off optimal route'));
  });

  test('the streak line still lands on multiples of 5', () => {
    truthy(share('hard', { streak: 5 }, null).includes('🔥 5 day streak'));
    falsy(share('hard', { streak: 4 }, null).includes('day streak'));
  });

  test('every snippet ends on the URL', () => {
    for (const s of [null, stats(), stats({ is_top3: false, my_rank: 40, top_pct: 33 })]) {
      const lines = share('hard', { streak: 1 }, s).split('\n');
      eq(lines[lines.length - 1], '➡️ playtubed.co.uk');
    }
  });

  test('the anchor line is unaffected by the podium', () => {
    const html = card(stats({ median_optimal_secs: 425, optimal_count: T.LB_MIN_OPTIMAL }));
    truthy(html.includes('⏱ Typical optimal solve: 7:05'), 'anchor line missing or reworded');
    truthy(html.includes('in the World!'), 'podium and anchor must coexist');
  });
}

// ── Report ─────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
for (const r of results) {
  console.log(r.ok ? `  ✓ ${r.name}` : `  ✗ ${r.name}\n      ${r.error}`);
}
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
