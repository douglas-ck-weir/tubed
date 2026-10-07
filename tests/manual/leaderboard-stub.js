// Live-server test stub for the leaderboard podium.
// Paste this whole file into the browser console on a locally served Tubed.
// See TEST-PLAN.md for the run order.
//
// WHY A STUB IS NEEDED
// --------------------
// The podium only appears at total_players >= 5 with you in the top 3, and
// there is no way to arrange that on a real board on demand. Worse, playing
// locally posts a REAL row to the production Supabase table: puzzle_date is
// today, which the RLS insert policy accepts, and the UNIQUE constraint on
// (puzzle_date, mode, player_id) then makes that row permanent — a second
// test solve silently no-ops instead of updating.
//
// So this fakes the network and nothing else. Every line of the real path
// still runs: submitScore -> loadLeaderboardStats -> _leaderboardStatsCache
// -> renderLeaderboardBlock and buildShareText. Only the two Supabase
// responses are invented.
//
// INSTALL IT BEFORE YOU PRESS SUBMIT. Score POSTs are swallowed from the
// moment it loads; anything submitted earlier has already reached the live
// board.

(() => {
  if (window.lb) { console.warn('[stub] already installed — call lb.off() first'); return; }

  const REAL = window.fetch.bind(window);
  const RPC = '/rpc/get_leaderboard_stats';
  const SCORES = '/rest/v1/scores';

  // A board big and deep enough to clear every gate. Overridden per call.
  const BASE = {
    total_players: 120, my_rank: 1, top_pct: 1, is_top3: true,
    optimal_count: 9, median_optimal_secs: 425,
  };
  let scenario = { ...BASE };

  const json = o => Promise.resolve(new Response(JSON.stringify(o), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }));

  window.fetch = (input, init) => {
    const u = String(input && input.url ? input.url : input);
    // Swallowed unconditionally: this is the safety property, and it must not
    // depend on whether a scenario happens to be set.
    if (u.includes(SCORES)) {
      console.log('[stub] swallowed a score POST — nothing written to the live board');
      return Promise.resolve(new Response('', { status: 201 }));
    }
    if (u.includes(RPC)) {
      console.log('[stub] answering stats with', scenario);
      return json(scenario);
    }
    return REAL(input, init);   // today.json, puzzle-lookup.json, feedback
  };

  // Set the scenario and repaint both surfaces, if a result card is up.
  // Pushed through loadLeaderboardStats rather than straight into the cache
  // because the cache is a top-level `const` and unreachable from here — and
  // going the long way is the point: it exercises the real write path.
  window.lb = (o = {}) => {
    scenario = { ...BASE, ...o };
    if (document.getElementById('leaderboard-stats')) {
      // Mode is a top-level `let`, so it can't be read from the console.
      // Filling both keys costs nothing; loadLeaderboardStats only paints
      // the one matching the card on screen.
      for (const m of ['easy', 'hard']) loadLeaderboardStats(todayKey(), m);
    } else {
      console.warn('[stub] no result card on screen yet — solve first, or this only takes effect on submit');
    }
    return scenario;
  };

  // The genuine snippet, with the player's real diff/hints/changes/time
  // lifted off the share button rather than invented.
  window.lb.text = () => {
    const b = document.getElementById('share-btn');
    const m = b && (b.getAttribute('onclick') || '').match(/shareResult\((-?\d+),(-?\d+),(-?\d+),(-?\d+)\)/);
    if (!m) { console.warn('[stub] no result card on screen'); return; }
    const t = buildShareText(+m[1], +m[2], +m[3], +m[4]);
    console.log('\n' + t);
    return t;
  };

  // Clear today's progress so the puzzle can be replayed. Backs up first —
  // on a browser you actually play in, this is your real streak and history.
  window.lb.reset = () => {
    const raw = localStorage.getItem('tubepzl_v6');
    if (raw) localStorage.setItem('tubepzl_v6_stubbackup', raw);
    localStorage.removeItem('tubepzl_v6');
    console.log('[stub] progress cleared (backup in tubepzl_v6_stubbackup, restore with lb.restore()). Reload.');
  };
  window.lb.restore = () => {
    const raw = localStorage.getItem('tubepzl_v6_stubbackup');
    if (!raw) { console.warn('[stub] no backup'); return; }
    localStorage.setItem('tubepzl_v6', raw);
    console.log('[stub] progress restored. Reload.');
  };

  window.lb.off = () => {
    window.fetch = REAL;
    delete window.lb;
    console.warn('[stub] removed — score POSTs now reach the LIVE board again');
  };

  console.log('%c[stub] installed.', 'font-weight:bold',
    '\n  lb({my_rank:2, top_pct:2})  set scenario + repaint',
    '\n  lb.text()                   print the real share snippet',
    '\n  lb.reset() / lb.restore()   replay today / undo',
    '\n  lb.off()                    uninstall (live writes resume)');
})();
