// Scoring invariants for Tubed.
//   node tests/scoring_invariants.test.mjs
//   TUBED_HTML=backups/index.html.pre-unified-engine.2026-08-05.bak node tests/scoring_invariants.test.mjs
//
// These are the guards for the bug class that has now surfaced three times:
// two parts of the engine disagreeing about what a route costs. Previously this
// lived in a scratchpad script and was run by hand, which is why the
// disagreements were only ever found after a player hit one.
//
// Runs over every (date, mode) instance in puzzle-lookup.json.

import { loadEngine, puzzleInstances } from './lib/engine.mjs';

const BUILD = process.env.TUBED_HTML || 'index.html';
const T = loadEngine(BUILD);
const g = T.buildGraph();
const instances = puzzleInstances();

const results = [];
// `fn` may return a count of instances it actually examined. A test that
// examined zero is reported as SKIPPED, not passed — a green tick for an
// assertion that ran against nothing is worse than no test at all.
function test(name, fn) {
  try { const n = fn(); results.push({ name, ok: true, checked: n }); }
  catch (e) { results.push({ name, ok: false, error: e.message }); }
}

// Cache one dijkstra run per instance — several invariants share it.
const solved = instances.map(inst => {
  const routes = T.dijkstra(g, inst.start, inst.end);
  return { inst, routes, optimal: T.pickOptimal(routes, inst) };
});

// ── Invariant 1: THE PUBLISHED OPTIMAL IS NOT BEATABLE ───────────────────────
// A player who enters a walk-free route must never score below the published
// optimal. This is the bug that shipped: buildUserLegs and the search resolved
// the boarding wait differently, so Preston Road -> Ealing Common published 34
// while a player could enter a route the game scored at 31.
//
// Walk-assisted routes are excluded ON PURPOSE: pickOptimal deliberately
// publishes the best WALK-FREE route because players reject an "optimal" that
// tells them to walk between stations, so a walk route beating it is a design
// decision, not a defect.
test('no walk-free route a player can enter beats the published optimal', () => {
  const bad = [];
  for (const { inst, routes, optimal } of solved) {
    if (!optimal) continue;
    for (const r of routes) {
      if (r.legs.some(l => l.line === 'Walk')) continue;
      const userRoute = r.legs.map(l => ({ station: l.to, line: l.line }));
      let mins;
      try { mins = T.buildUserLegs(inst.start, userRoute).totalMins; } catch { continue; }
      if (mins < optimal.mins) {
        bad.push(`${inst.date} ${inst.mode}: ${inst.start} -> ${inst.end} optimal=${optimal.mins} beaten by ${mins}`);
        break;
      }
    }
  }
  if (bad.length) {
    throw new Error(`${bad.length} beatable optimal(s):\n  ` + bad.slice(0, 20).join('\n  '));
  }
});

// ── Invariant 2: ONE COST MODEL ──────────────────────────────────────────────
// Replaying the published optimal back through the PLAYER's scoring path must
// reproduce its published total. If these differ, the number shown as "optimal"
// and the number the player is graded against came from different models —
// which is the precondition for invariant 1 failing.
test('the published optimal re-scores to its own total through buildUserLegs', () => {
  const bad = [];
  for (const { inst, optimal } of solved) {
    if (!optimal) continue;
    const userRoute = optimal.legs.map(l => ({ station: l.to, line: l.line }));
    let replay;
    try { replay = T.buildUserLegs(inst.start, userRoute).totalMins; }
    catch (e) { bad.push(`${inst.date} ${inst.mode}: ${inst.start} -> ${inst.end} threw ${e.message}`); continue; }
    if (replay !== optimal.mins) {
      bad.push(`${inst.date} ${inst.mode}: ${inst.start} -> ${inst.end} optimal=${optimal.mins} replay=${replay}`);
    }
  }
  if (bad.length) {
    throw new Error(`${bad.length} optimal(s) disagree with the player scorer:\n  ` + bad.slice(0, 20).join('\n  '));
  }
});

// ── Invariant 3: THE DISPLAYED BREAKDOWN ADDS UP ─────────────────────────────
// The per-leg minutes plus per-interchange minutes shown on the result card
// must sum to the total printed beside them. This is the arithmetic bug that
// made Oval -> Cannon Street render 10 + (4 walk + 3 wait) + 1 = 18 next to a
// stated optimal of 16.
test('every published optimal\'s legs + interchanges sum to its total', () => {
  const bad = [];
  let checked = 0;
  for (const { inst, optimal } of solved) {
    if (!optimal || !optimal.interchanges) continue;
    checked++;
    let sum = optimal.legs.reduce((a, l) => a + l.mins, 0);
    for (const ic of optimal.interchanges) if (ic) sum += ic.mins;
    if (optimal.originTransfer) sum += optimal.originTransfer.mins;
    if (sum !== optimal.mins) {
      bad.push(`${inst.date} ${inst.mode}: ${inst.start} -> ${inst.end} total=${optimal.mins} but rows sum to ${sum}`);
    }
  }
  if (bad.length) {
    throw new Error(`${bad.length} card breakdown(s) do not sum to their total:\n  ` + bad.slice(0, 20).join('\n  '));
  }
  return checked;
});

// ── Invariant 4: THE SEARCH RANKS BY THE SCORER ──────────────────────────────
// Builds that expose scoreLegs must have every returned route's `mins` equal to
// scoreLegs' verdict on its own legs. That is what makes "player beats the
// optimal" structurally impossible rather than merely absent today: the route
// is chosen BY the function that grades the player. Skipped on builds without
// scoreLegs (index.html), so this file runs against both.
test('dijkstra route totals are exactly scoreLegs\' verdict (scoreLegs builds only)', () => {
  if (typeof T.scoreLegs !== 'function') return 0;   // not applicable to this build
  const bad = [];
  let checked = 0;
  for (const { inst, routes } of solved) {
    checked++;
    for (const r of routes) {
      const rescored = T.scoreLegs(r.legs, inst.start).totalMins;
      if (rescored !== r.mins) {
        bad.push(`${inst.date} ${inst.mode}: ${inst.start} -> ${inst.end} route.mins=${r.mins} scoreLegs=${rescored}`);
        break;
      }
    }
  }
  if (bad.length) {
    throw new Error(`${bad.length} route(s) carry a total scoreLegs disagrees with:\n  ` + bad.slice(0, 20).join('\n  '));
  }
  return checked;
});

// ── ABSOLUTE ANCHORS ─────────────────────────────────────────────────────────
// Invariants 1-4 above check that the engine agrees WITH ITSELF. Once every
// caller routes through scoreLegs that is true by construction, so those tests
// can no longer detect a cost model that is consistently WRONG — verified by
// mutation: reintroducing the origin-transfer, directional-wait and
// boarding-station bugs left all four passing.
//
// These pin absolute values instead. Each corresponds to a specific bug that
// shipped, and each fails if that bug is reintroduced. Values are the engine's,
// cross-checked against the reasoning recorded with each fix.
const anchors = [];
function anchor(name, fn) { anchors.push({ name, fn }); }

// ── Playability guard ──────────────────────────────────────────────────────
// buildUserLegs scores whatever it is handed — the GAME's validateStep is what
// refuses impossible routes. So a hardcoded test route can quietly assert a
// confident number for something no player could ever enter, and pass forever.
// (This bit us for real: a test plan quoted 36 min for "Preston Road → Baker
// Street [Metropolitan] → Ealing Common [District]" when Baker Street has no
// District platforms.) Any anchor that hardcodes a route runs it through here
// first. Bank/Monument is allowed as one complex, which the game permits.
const BM_COMPLEX = { Bank: 'Monument', Monument: 'Bank' };
function assertPlayable(start, route, label) {
  const stns = [start, ...route.map(r => r.station)];
  const problems = [];
  route.forEach((r, i) => {
    const from = stns[i], to = stns[i + 1];
    if (r.line === 'Walk') {
      if (T.osiTime(from, to) === null) problems.push(`no OSI pair ${from} → ${to}`);
      return;
    }
    const serves = stn => T.stationsForDisplayLine(r.line).includes(stn)
      || (BM_COMPLEX[stn] && T.stationsForDisplayLine(r.line).includes(BM_COMPLEX[stn]));
    if (!serves(from)) problems.push(`${r.line} does not serve ${from}`);
    if (!serves(to))   problems.push(`${r.line} does not serve ${to}`);
  });
  if (problems.length) {
    throw new Error(`unplayable route "${label}": ${problems.join('; ')} — the assertion below is meaningless`);
  }
}

// Directional wait. At Rayners Lane the Piccadilly runs every ~4 min west
// toward Uxbridge (shared with the Metropolitan) but every ~10 min east toward
// South Harrow (Piccadilly alone). Keying the lookup on the leg DESTINATION
// instead of the first hop collapsed these, letting players beat the optimal.
const boardWait = (from, to, line) => (typeof T.boardingWait === 'function')
  ? T.boardingWait(from, to, line)
  : T.waitTime(from, T.firstHopOnLeg(from, to, line), line);

anchor('Rayners Lane wait is directional (2 west, 5 east)', () => {
  const west = boardWait('Rayners Lane', 'Uxbridge', 'Piccadilly');
  const east = boardWait('Rayners Lane', 'South Harrow', 'Piccadilly');
  if (west !== 2) throw new Error(`westbound expected 2, got ${west}`);
  if (east !== 5) throw new Error(`eastbound expected 5, got ${east}`);
});

// Circle teardrop pivot. Paddington appears twice on the Circle; which
// occurrence you board decides the wait. Keying on the leg DESTINATION resolves
// Paddington -> Baker Street the long way round (via Edgware Road, 2) instead of
// the short way (1). Chosen because it separates a destination-keyed lookup from
// a first-hop-keyed one — 223 station pairs do, and Rayners Lane alone does not.
anchor('Circle pivot resolves by first hop, not destination (Paddington=1)', () => {
  const short = boardWait('Paddington', 'Baker Street', 'Circle');
  if (short !== 1) {
    throw new Error(`Paddington -> Baker Street expected 1 (short way round), got ${short}`);
  }
});

// Boarding station, not arrival station. Bank has no Circle platforms, so a
// lookup there misses and falls back to WAIT_MINS_DEFAULT (3) when Monument's
// real value is 1. This is what made the result card print a breakdown 2 min
// above the total beside it.
anchor('wait is looked up at the boarding station (Monument=1, not Bank=3)', () => {
  if (typeof T.scoreLegs !== 'function') return 'skip';
  if (T.waitTime('Bank', 'Cannon Street', 'Circle') !== 3) {
    throw new Error('Bank no longer falls back to the default; this anchor needs rewriting');
  }
  // Must go THROUGH scoreLegs: calling boardingWait directly with the right
  // station cannot detect a scorer that passes it the wrong one.
  assertPlayable('Oval', [{station: 'Bank', line: 'Northern'},
                          {station: 'Cannon Street', line: 'Circle'}], 'Oval → Cannon Street');
  const legs = [{from: 'Oval', to: 'Bank', line: 'Northern'},
                {from: 'Monument', to: 'Cannon Street', line: 'Circle'}];
  const scored = T.scoreLegs(legs, 'Oval');
  const ic = scored.interchanges[0];
  if (!ic || ic.waitMins !== 1) {
    throw new Error(`Bank↔Monument change should wait 1 (Monument's Circle value), got ${ic && ic.waitMins}`);
  }
  if (scored.totalMins !== 16) throw new Error(`Oval -> Cannon Street expected 16, got ${scored.totalMins}`);
});

// Trunk vs branch. Boarding at Paddington for Shenfield must charge the
// Shenfield service frequency (3), not the combined frequency of all four
// Elizabeth branches through the core (1). v2 only.
anchor('boarding charges the branch frequency, not the trunk (v2 only)', () => {
  if (typeof T.boardingWait !== 'function') return 'skip';
  const trunk  = T.waitTime('Paddington', T.firstHopOnLeg('Paddington', 'Shenfield', 'Elizabeth'), 'Elizabeth');
  const branch = T.boardingWait('Paddington', 'Shenfield', 'Elizabeth');
  if (trunk !== 1) throw new Error(`trunk hop expected 1, got ${trunk}`);
  if (branch < 3) throw new Error(`Shenfield boarding expected >=3, got ${branch}`);
  if (T.boardingWait('Bond Street', 'Heathrow Terminal 5', 'Elizabeth') !== 15) {
    throw new Error('Heathrow T5 boarding should charge the 15-min shuttle headway');
  }
});

// Origin transfer. Starting at Bank and boarding at Monument must charge the
// crossing; it used to be free, which is what made the search and the scorer
// disagree and left the published optimal dependent on the label cap.
anchor('a cross-complex origin transfer is charged (v2 only)', () => {
  if (typeof T.scoreLegs !== 'function') return 'skip';
  const legs = [{from: 'Monument', to: 'Westminster', line: 'Circle'},
                {from: 'Westminster', to: 'Green Park', line: 'Jubilee'}];
  const same  = T.scoreLegs(legs, 'Monument').totalMins;
  const cross = T.scoreLegs(legs, 'Bank').totalMins;
  if (cross <= same) throw new Error(`starting at Bank (${cross}) must cost more than at Monument (${same})`);
  const ot = T.scoreLegs(legs, 'Bank').originTransfer;
  if (!ot || ot.mins !== 4) throw new Error(`expected a 4-min Bank↔Monument transfer, got ${JSON.stringify(ot)}`);
});

// Post-walk boarding wait. An OSI walk covers the WALKING, not standing on the
// far platform waiting for a train. Charging nothing there let a player walk
// between stations and board instantly, beating the published optimal:
// Mansion House -> Tower Hill -> [walk] -> Tower Gateway -> East India scored
// 20 against a published 23. The search charged this wait all along, so it was
// the scorer and the search disagreeing. Reported by the user, 2026-08-05.
anchor('boarding after an OSI walk still pays a wait (v2 only)', () => {
  if (typeof T.scoreLegs !== 'function') return 'skip';
  const walkRoute = [
    { station: 'Tower Hill',    line: 'District' },
    { station: 'Tower Gateway', line: 'Walk' },
    { station: 'East India',    line: 'DLR' },
  ];
  assertPlayable('Mansion House', walkRoute, 'Mansion House → East India via OSI walk');
  const r = T.buildUserLegs('Mansion House', walkRoute);
  const ic = r.interchanges[1];              // slot after the Walk leg
  if (!ic || ic.waitMins !== 3) {
    throw new Error(`expected a 3-min wait boarding the DLR after the walk, got ${ic && ic.waitMins}`);
  }
  if (ic.walkMins !== 0) {
    throw new Error(`walkMins must be 0 after an OSI (the walk leg already carries it), got ${ic.walkMins}`);
  }
  if (r.totalMins !== 23) throw new Error(`route total expected 23, got ${r.totalMins}`);
});

// The corollary, swept over the whole corpus: walking must not be a way to beat
// the published optimal. One case legitimately remains — Southfields ->
// Dalston Kingsland, where the walk is the FINAL leg so there is no train to
// board and no wait to charge, and the player genuinely saves a minute. That is
// the walk-free publishing rule, not an undercharge. Anything beyond a handful
// means a transfer is going uncharged again.
anchor('walking beats the published optimal in at most 1 puzzle', () => {
  let beat = 0;
  for (const { inst, routes, optimal } of solved) {
    if (!optimal) continue;
    for (const r of routes) {
      if (!r.legs.some(l => l.line === 'Walk')) continue;
      let mins;
      try { mins = T.buildUserLegs(inst.start, r.legs.map(l => ({ station: l.to, line: l.line }))).totalMins; }
      catch { continue; }
      if (mins < optimal.mins) { beat++; break; }
    }
  }
  // index.html (no post-walk wait) sits at 83; v2 sits at 1.
  if (typeof T.scoreLegs !== 'function') return 'skip';
  if (beat > 1) throw new Error(`${beat} puzzles are beatable by walking (expected at most 1)`);
});

for (const a of anchors) {
  try {
    const r = a.fn();
    results.push(r === 'skip' ? { name: a.name, ok: true, checked: 0 } : { name: a.name, ok: true, checked: 1 });
  } catch (e) { results.push({ name: a.name, ok: false, error: e.message }); }
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`\nscoring invariants — ${BUILD} — ${instances.length} puzzle instances\n`);
for (const r of results) {
  if (!r.ok) { console.log(`  ✗ ${r.name}\n      ${r.error}`); continue; }
  if (r.checked === 0) { console.log(`  – ${r.name}  [SKIPPED: not applicable to this build]`); continue; }
  console.log(`  ✓ ${r.name}${r.checked ? `  (${r.checked} checked)` : ''}`);
}
const failed  = results.filter(r => !r.ok).length;
const skipped = results.filter(r => r.ok && r.checked === 0).length;
console.log(`\n${results.length - failed - skipped} passed${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} failed` : ''}\n`);
process.exit(failed ? 1 : 0);
