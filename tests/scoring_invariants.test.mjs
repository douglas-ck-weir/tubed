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

import { loadEngine, puzzleInstances, ROOT } from './lib/engine.mjs';
import { readFileSync } from 'fs';
import path from 'path';

const BUILD = process.env.TUBED_HTML || 'index.html';
const T = loadEngine(BUILD);
const g = T.buildGraph();
const instances = puzzleInstances();

// Read the build's own source so the freeze dates come from the file under
// test rather than a hardcoded list that would rot.
function readIndexSource() {
  return readFileSync(path.isAbsolute(BUILD) ? BUILD : path.join(ROOT, BUILD), 'utf8');
}

const results = [];
// `fn` may return a count of instances it actually examined. A test that
// examined zero is reported as SKIPPED, not passed — a green tick for an
// assertion that ran against nothing is worse than no test at all.
function test(name, fn) {
  try { const n = fn(); results.push({ name, ok: true, checked: n }); }
  catch (e) { results.push({ name, ok: false, error: e.message }); }
}

// Cache one dijkstra run per instance — several invariants share it.
//
// NOTE this calls pickOptimal directly, so it does NOT see todayPuzzle's freeze
// blocks. For most pinned dates that is harmless (a freeze pins the PAIR, and
// the pair is what we read from the lookup anyway), but one freeze overrides the
// OPTIMAL itself: 2026-08-06 hard publishes routes[0], the 36-min edge-walk
// route, where pickOptimal would return the 54-min tube route. Anything
// comparing against a published optimal must therefore skip frozen dates.
const solved = instances.map(inst => {
  const routes = T.dijkstra(g, inst.start, inst.end);
  return { inst, routes, optimal: T.pickOptimal(routes, inst) };
});

// Derived ONCE and shared. Previously each anchor rebuilt both of these, each
// re-reading index.html and re-running the same regex, so a change to how freeze
// dates are written had to be made in several places or one check would silently
// stop skipping pinned dates.
const TODAY_LONDON = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const FROZEN_DATES = new Set(
  [...readIndexSource().matchAll(/date === '(\d{4}-\d{2}-\d{2})'/g)].map(m => m[1])
);
/** Deliberately pinned in todayPuzzle(), so the engine is not free to choose. */
const isFrozen = date => FROZEN_DATES.has(date);

// ── Invariant 1: THE PUBLISHED OPTIMAL IS NOT BEATABLE ───────────────────────
// A route a player can actually enter must never score below the published
// optimal. This is the bug that shipped: buildUserLegs and the search resolved
// the boarding wait differently, so Preston Road -> Ealing Common published 34
// while a player could enter a route the game scored at 31.
//
// WALK ROUTES ARE INCLUDED (changed 2026-08-19). They used to be skipped, on
// the reasoning that pickOptimal published the best WALK-FREE route so a walk
// route beating it was a design decision. That reasoning died with the
// walk-transfer rule: the published optimal can now BE a walk route, and
// players have always been able to enter walk legs. Skipping them excluded
// exactly the code path this invariant exists to guard — the historic bug was
// buildUserLegs and the search disagreeing about the post-walk boarding wait
// (Mansion House -> Tower Hill -> [walk] -> Tower Gateway -> East India scored
// 20 against a published 23), which is only reachable through a walk leg.
test('no route a player can enter beats the published optimal', () => {
  const bad = [];
  for (const { inst, routes, optimal } of solved) {
    if (!optimal) continue;
    // A frozen date's optimal comes from its freeze block, not from pickOptimal
    // (see the note on `solved`), so comparing against pickOptimal's answer here
    // would flag a deliberate decision as a defect.
    if (isFrozen(inst.date)) continue;
    for (const r of routes) {
      const userRoute = r.legs.map(l => ({ station: l.to, line: l.line }));
      // SKIP ROUTES A PLAYER COULD NOT ENTER. The {station, line} form carries
      // only each leg's destination, so a cross-complex hop inside a route is
      // lost: dijkstra can return `District: Earl's Court>Monument | Walk:
      // Bank>Liverpool Street`, where the Monument->Bank step is a graph
      // interchange edge with no leg of its own. Replaying that as a user route
      // asks buildUserLegs to walk Monument->Liverpool Street, which is not an
      // OSI pair, so scoreLegs falls back to a flat 5 min and reports a total
      // no player could ever achieve. Third time this trap has produced a
      // phantom "beats the optimal" — validateStep, not buildUserLegs, is what
      // decides whether a route is real.
      try { assertPlayable(inst.start, userRoute, `${inst.start} -> ${inst.end}`); }
      catch { continue; }
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

// ── WALK DOMINATION ────────────────────────────────────────────────────────
// A pair whose genuinely cheapest route uses an OSI walk is unfit for a puzzle:
// pickOptimal publishes the walk-FREE optimal, so the published answer is
// beatable by anyone who spots the walk. The generator is supposed to reject
// such pairs outright.
//
// It stopped doing so on 2026-08-05. The check read
//   `if (opt.legs.some(l => l.line === 'Walk')) continue;`
// and `opt` was changed to pickOptimal's output, whose result is walk-free BY
// CONSTRUCTION — so the predicate could never be true and the filter silently
// passed everything. One cron run published 59 walk-dominated pairs, including
// Hanger Lane -> Harrow on the Hill at 54 min against an obvious 36 min walk.
//
// This asserts on the SHIPPED lookup, so it fails whether the cause is the
// filter, the search, or bad data. Past dates are exempt (frozen history that
// cannot be changed), as are dates pinned by a freeze block in todayPuzzle().
// Generalised 2026-08-06. The old version only fired when the cheapest route
// contained a Walk, which made it blind to any OTHER way of publishing a
// non-cheapest route. The property that actually matters is simpler and
// stronger: THE PUBLISHED OPTIMAL MUST COST WHAT THE CHEAPEST ROUTE COSTS.
// Anything else is beatable by a player who finds the cheaper one, and players
// can enter walking legs, so "they probably wouldn't think of it" is not a
// defence. This subsumes walk domination rather than special-casing it.
anchor('no upcoming puzzle publishes a beatable optimal', () => {
  const bad = [];
  let checked = 0;
  for (const { inst, routes, optimal } of solved) {
    if (!optimal || !routes.length) continue;
    if (inst.date < TODAY_LONDON) continue;    // frozen history
    if (isFrozen(inst.date)) continue;        // pinned by an explicit freeze
    checked++;
    const cheapest = routes[0];
    const gap = optimal.mins - cheapest.mins;
    if (gap > 0) {
      const how = cheapest.legs.map(l => `${l.line}:${l.from}>${l.to}`).join(' | ');
      bad.push(`${inst.date} ${inst.mode}: ${inst.start} -> ${inst.end} ` +
        `published=${optimal.mins} but ${cheapest.mins} is available (beatable by ${gap})\n      ${how}`);
    }
  }
  if (bad.length) {
    throw new Error(`${bad.length} upcoming puzzle(s) publish a beatable optimal — the ` +
      `generator is drawing pairs whose cheapest route it then refuses to publish:\n  ` +
      bad.slice(0, 15).join('\n  '));
  }
  return checked;
});

// The published optimal must also never open or close on foot (the rule that
// replaced the blanket walk ban on 2026-08-06). Separate from the anchor above
// because these are different failures: that one is "the answer is wrong", this
// one is "the answer is right but reads as a mis-set puzzle".
anchor('no upcoming puzzle starts or ends on foot', () => {
  const bad = [];
  let checked = 0;
  for (const { inst, optimal } of solved) {
    if (!optimal || !optimal.legs.length) continue;
    if (inst.date < TODAY_LONDON || isFrozen(inst.date)) continue;
    checked++;
    const first = optimal.legs[0].line, last = optimal.legs[optimal.legs.length - 1].line;
    if (first === 'Walk' || last === 'Walk') {
      bad.push(`${inst.date} ${inst.mode}: ${inst.start} -> ${inst.end} ` +
        `(${first === 'Walk' ? 'starts' : 'ends'} on foot)`);
    }
  }
  if (bad.length) {
    throw new Error(`${bad.length} upcoming puzzle(s) publish an edge walk:\n  ` + bad.slice(0, 15).join('\n  '));
  }
  return checked;
});

// ── The generator's publishability check must test the CHEAPEST route ───────
// The anchors above assert on the shipped lookup, so they only fail the day
// AFTER a bad cron run. This one fails immediately, on the code.
//
// The check must be evaluated against routes[0] (the genuinely cheapest route,
// walks included). Evaluated against pickOptimal's output it is dead code: that
// result satisfies the publishability rule by construction, so the predicate is
// always false. This is a source guard rather than a behavioural one because
// reproducing a cron run in-process means overriding the clock across a 90-day
// sweep; the failure mode it guards is a one-token edit, so matching the source
// is proportionate.
anchor('generator rejects unpublishable pairs using routes[0]', () => {
  const src = readIndexSource();
  // Anchor on a marker unique to the DRAW LOOP. 'routes = dijkstra(GRAPH,
  // start, end);' also appears verbatim in every freeze block, so slicing from
  // its first occurrence began the region ~120 lines early, spanning the freeze
  // blocks and the lookup oracle. Adding the 2026-08-19 freeze silently moved
  // that anchor; a future freeze mentioning isPublishableOptimal(routes[0])
  // would have satisfied this guard while the real check was gone.
  const loopStart = src.indexOf('for (let attempt = 0;');
  if (loopStart === -1) throw new Error('could not locate the draw loop');
  const loop = src.slice(loopStart);
  const region = loop.slice(0, loop.indexOf("if (m === 'easy')"));
  const testsCheapest = /isPublishableOptimal\(\s*(cheapest|routes\[0\])\s*\)/.test(region);
  if (!testsCheapest) {
    throw new Error(
      "the draw loop no longer rejects unpublishable pairs on routes[0].\n" +
      "      A check written against pickOptimal's output cannot fire — its result is\n" +
      "      publishable by construction. That silently published 59 walk-dominated\n" +
      "      pairs on 2026-08-05, including a 54-min optimal beatable in 36 by walking.");
  }
});

// isPublishableOptimal is the whole rule, so pin its edges directly.
anchor('isPublishableOptimal accepts mid-route walks, rejects edge walks', () => {
  const f = T.isPublishableOptimal;
  if (typeof f !== 'function') throw new Error('isPublishableOptimal is not exported from the build');
  const L = (...lines) => ({ mins: 1, legs: lines.map((l, i) => ({ line: l, from: `S${i}`, to: `S${i + 1}` })) });
  // A zero-length leg (from === to) laundered an edge walk past the rule at
  // K=32; these two pin that it can't.
  const nullLeadIn  = { mins: 1, legs: [
    { line: 'Central', from: 'A', to: 'A' },          // travels nowhere
    { line: 'Walk',    from: 'A', to: 'B' },
    { line: 'Victoria', from: 'B', to: 'C' }] };
  const nullTailOff = { mins: 1, legs: [
    { line: 'Victoria', from: 'A', to: 'B' },
    { line: 'Walk',    from: 'B', to: 'C' },
    { line: 'Central', from: 'C', to: 'C' }] };       // travels nowhere
  const cases = [
    [L('Central', 'Walk', 'Victoria'), true,  'tube/walk/tube is an ordinary walking transfer'],
    [L('Central', 'Victoria'),         true,  'pure tube'],
    [L('Walk', 'Victoria'),            false, 'starts on foot'],
    [L('Victoria', 'Walk'),            false, 'ends on foot'],
    [L('Walk'),                        false, 'walk only'],
    [nullLeadIn,                       false, 'zero-length leg disguising a leading walk'],
    [nullTailOff,                      false, 'zero-length leg disguising a trailing walk'],
    [{ mins: 0, legs: [] },            false, 'empty'],
    [null,                             false, 'null'],
  ];
  for (const [route, want, why] of cases) {
    if (f(route) !== want) throw new Error(`isPublishableOptimal: expected ${want} for ${why}`);
  }
  return cases.length;
});

for (const a of anchors) {
  try {
    const r = a.fn();
    // Honour a returned count so a sweeping anchor reports what it actually
    // examined. Reporting a hardcoded 1 would hide an anchor that swept zero
    // instances — the same "green tick for nothing" problem the SKIPPED
    // handling exists to prevent.
    const checked = r === 'skip' ? 0 : (typeof r === 'number' ? r : 1);
    results.push({ name: a.name, ok: true, checked });
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
