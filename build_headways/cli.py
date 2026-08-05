"""CLI for building wait_times.js."""

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Dict, FrozenSet, List, Optional, Tuple

from .headway import (
    headway_from_tube_timetable,
    line_departures_from_jr,
    wait_minutes,
)
from .line_map import tfl_for_branch
from .naptan import load_csv_naptan_map, platform_line_sets, resolve_naptan
from .network import display_line, enumerate_interchange_edges, parse_network
from .tfl_api import TflClient


logger = logging.getLogger('build_headways')


PROJECT_ROOT = Path(__file__).parent.parent
DEFAULT_HTML = PROJECT_ROOT / 'index.html'
DEFAULT_CACHE = PROJECT_ROOT / 'build_headways' / 'cache'
DEFAULT_OUTPUT_JS = PROJECT_ROOT / 'wait_times.js'
DEFAULT_REPORT_TXT = PROJECT_ROOT / 'wait_times_report.txt'


# Date queried for JourneyResults. Pick a representative weekday a few
# weeks out so the schedule is stable and not affected by today's
# disruptions or weekend service.
QUERY_DATE = '20260616'  # Tuesday 16 June 2026
QUERY_TIME = '1200'


# Manual wait-time overrides for edges the API can't answer cleanly during
# our off-peak sample window. Keyed by (from, to, branch) -> wait_mins.
#
# Turnham Green Piccadilly: trains skip this stop 10:00-15:00 (the off-peak
# window we sample). Service exists in early morning and late evening.
# Use Acton Town's Piccadilly wait (1 min) since it's the next stop on the
# same trains.
MANUAL_WAIT_OVERRIDES = {
    ('Turnham Green', 'Acton Town', 'Piccadilly_T4_Cockfosters'):       1,
    ('Turnham Green', 'Acton Town', 'Piccadilly_T5_Cockfosters'):       1,
    ('Turnham Green', 'Acton Town', 'Piccadilly_Uxbridge_Cockfosters'): 1,
    ('Turnham Green', 'Hammersmith', 'Piccadilly_T4_Cockfosters'):       1,
    ('Turnham Green', 'Hammersmith', 'Piccadilly_T5_Cockfosters'):       1,
    ('Turnham Green', 'Hammersmith', 'Piccadilly_Uxbridge_Cockfosters'): 1,
    # Kensington (Olympia) District shuttle: weekday Mon-Fri runs almost
    # nothing 10-15 (just peak + late evening). Weekend service is 3 tph
    # all day, which is the realistic "when trains are running" rate.
    # Half-headway at 3 tph (20 min) = 10 min.
    ("Earl's Court", 'Kensington (Olympia)', 'District_Kensington_Olympia_Earls_Court'): 10,
    ('Kensington (Olympia)', "Earl's Court", 'District_Kensington_Olympia_Earls_Court'): 10,
    # ── Wrong-direction / uncombined-frequency corrections (2026-08-02) ──────────
    # The off-peak timetable sampler picked the wrong service direction (or the
    # Piccadilly-only figure on shared Picc+Met track), so these edges got waits
    # that disagree with the TfL Working Timetable off-peak (10:30-15:45) figures
    # and with live JourneyResults. Corrected to the passenger-experienced wait.
    #
    # Piccadilly Uxbridge branch: Rayners Lane->South Harrow is Piccadilly-ONLY
    # toward Acton Town (6 tph WTT -> wait 5); the sampler used the opposite
    # Uxbridge-bound 3 tph (->10). Ruislip->Ickenham / ->Ruislip Manor are on
    # SHARED Picc+Met track (combined ~8 min live -> wait 4); the sampler used
    # Piccadilly-only (->10) or Metropolitan-only (->3).
    ('Rayners Lane', 'South Harrow',  'Piccadilly_Uxbridge_Cockfosters'): 5,
    ('Ruislip',      'Ickenham',      'Piccadilly_Uxbridge_Cockfosters'): 4,
    ('Ruislip',      'Ruislip Manor', 'Piccadilly_Uxbridge_Cockfosters'): 4,
    ('Ruislip',      'Ickenham',      'Metropolitan_Uxbridge_Aldgate'):   4,
    ('Ruislip',      'Ruislip Manor', 'Metropolitan_Uxbridge_Aldgate'):   4,
    # District medium-frequency sections under-counted (~10-11 min live -> wait 5),
    # confirmed against the reverse-direction entries which already read 5.
    ("Earl's Court", 'High Street Kensington', 'District_Wimbledon_Edgware_Road'): 5,
    ('Turnham Green', 'Gunnersbury',   'District_Richmond_Upminster'):       5,
    ('Turnham Green', 'Chiswick Park', 'District_Ealing_Broadway_Upminster'): 5,
    ('Turnham Green', 'Stamford Brook', 'District_Ealing_Broadway_Upminster'): 5,
    ('Turnham Green', 'Stamford Brook', 'District_Richmond_Upminster'):       5,
    # Central Ealing Broadway stub (~10 min live -> wait 5); sampler gave 3.
    ('Ealing Broadway', 'West Acton', 'Central_Ealing_Broadway_Epping'):    5,
    ('Ealing Broadway', 'West Acton', 'Central_Ealing_Broadway_Hainault'):  5,
}


def _parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description='Build wait_times.js from TfL data')
    p.add_argument('--html', type=Path, default=DEFAULT_HTML)
    p.add_argument('--cache', type=Path, default=DEFAULT_CACHE)
    p.add_argument('--output', type=Path, default=DEFAULT_OUTPUT_JS)
    p.add_argument('--report', type=Path, default=DEFAULT_REPORT_TXT)
    p.add_argument('--refresh', action='store_true', help='Bypass cache')
    p.add_argument('--limit', type=int, default=None,
                   help='Process only first N edges (for testing)')
    p.add_argument('--dry-run', action='store_true',
                   help="Don't write output files")
    p.add_argument('--validate', action='store_true',
                   help='Run validation checks on the existing wait_times.js '
                        '(does not rebuild). Outputs flagged-edges report.')
    p.add_argument('-v', '--verbose', action='count', default=0)
    return p.parse_args(argv)


def _configure_logging(verbose: int) -> None:
    level = logging.WARNING if verbose == 0 else (
        logging.INFO if verbose == 1 else logging.DEBUG)
    logging.basicConfig(
        level=level,
        format='%(asctime)s %(levelname)s %(name)s: %(message)s',
        datefmt='%H:%M:%S',
    )


def compute_wait_for_edge(
    from_stn: str,
    to_stn: str,
    branch: str,
    naptan_map: Dict[str, str],
    client: TflClient,
) -> Tuple[Optional[int], Optional[float], str]:
    """Return (wait_mins, raw_headway, source_tag) for one edge.

    `raw_headway` is the full (pre-halved) headway in minutes that produced
    `wait_mins`, so callers can recombine frequencies across branches that
    share a boarding hop without losing precision to the half-headway floor.
    For a manual override it is 2*wait (the override's implied headway); it is
    None only when there is no wait at all (no live data).

    source_tag is one of: 'tube-tt', 'jr', 'manual', 'no-data',
    'no-naptan', 'unmapped-line'.
    """
    if (from_stn, to_stn, branch) in MANUAL_WAIT_OVERRIDES:
        # A manual override IS the intended half-headway wait, so its implied
        # full headway is exactly 2*wait. Return that as raw_headway so a
        # combine involving this edge uses the intended value rather than
        # re-flooring 2*wait a second time (see combine_shared_hops).
        ov = MANUAL_WAIT_OVERRIDES[(from_stn, to_stn, branch)]
        return ov, 2.0 * ov, 'manual'

    tfl_line, tfl_mode = tfl_for_branch(branch)
    if tfl_line is None:
        return None, None, 'unmapped-line'

    from_naptan = resolve_naptan(from_stn, naptan_map, client, tfl_line=tfl_line)
    to_naptan = resolve_naptan(to_stn, naptan_map, client, tfl_line=tfl_line)
    if from_naptan is None or to_naptan is None:
        return None, None, 'no-naptan'

    # Tube: use Line Timetable (full day, can filter to off-peak in-process).
    # We pass to_naptan so headway_from_tube_timetable can isolate the route
    # that actually serves the target — important at teardrop pivots like
    # Paddington / Edgware Road on Circle.
    if tfl_mode == 'tube':
        try:
            data = client.line_timetable(tfl_line, from_naptan, direction='inbound')
            # If disambiguation, try outbound
            if 'disambiguation' in data:
                data = client.line_timetable(tfl_line, from_naptan, direction='outbound')
            h = headway_from_tube_timetable(data, target_naptan=to_naptan)
            if h is None:
                # Try outbound as fallback
                data2 = client.line_timetable(tfl_line, from_naptan, direction='outbound')
                h = headway_from_tube_timetable(data2, target_naptan=to_naptan)
            if h is not None:
                return wait_minutes(h), h, 'tube-tt'
        except Exception as e:
            logger.warning('Tube TT failed for %s @ %s: %s', tfl_line, from_naptan, e)

    # Non-Tube (or Tube fallback): JourneyResults, with a polling loop to
    # accumulate ≥5 same-line departures. Each call returns ~3-5 journeys
    # interleaved across all lines serving the edge; if our line only
    # appears once per call, we keep advancing the time and re-querying
    # until we have enough.
    line_name = display_line(branch)
    deps = []
    seen_ts = set()
    cur_time = QUERY_TIME
    max_attempts = 6
    for attempt in range(max_attempts):
        try:
            data = client.journey_results(
                from_naptan, to_naptan, QUERY_DATE, cur_time, tfl_mode,
            )
        except Exception as e:
            logger.warning('JR failed for %s->%s on %s: %s',
                           from_naptan, to_naptan, tfl_line, e)
            break
        new_deps = line_departures_from_jr(data, line_name)
        added = 0
        for d in new_deps:
            ts = d.isoformat()
            if ts not in seen_ts:
                seen_ts.add(ts)
                deps.append(d)
                added += 1
        if not new_deps or added == 0:
            break
        deps.sort()
        if len(deps) >= 5:
            break
        # Advance to 1 min after the last departure we've seen
        last = deps[-1]
        cur_time = f'{last.hour:02d}{(last.minute + 1) % 60:02d}'
        # If we wrapped past the off-peak window, stop
        if last.hour >= 15:
            break

    if len(deps) >= 2:
        gaps = [(deps[i + 1] - deps[i]).total_seconds() / 60
                for i in range(len(deps) - 1)]
        gaps = [g for g in gaps if 0 < g < 60]
        if gaps:
            h = sum(gaps) / len(gaps)
            return wait_minutes(h), h, 'jr'

    return None, None, 'no-data'


def write_wait_times_js(
    waits: Dict[Tuple[str, str, str], int],
    path: Path,
) -> None:
    """Write wait_times.js as a JS object literal."""
    lines = [
        '// Auto-generated by build_headways. Do not edit manually.',
        '// Source: TfL Unified API (Line Timetable + JourneyResults).',
        '// Half-headway in minutes for each (from|to|line_branch) edge,',
        '// computed from off-peak weekday schedules.',
        '//',
        '// Used by the route scorer: when a player boards a train on `line_branch`',
        '// at `from` heading to `to`, add this many minutes of expected wait.',
        '// Mid-line edges (no line change) get no wait — already on the train.',
        'const WAIT_MINS = {',
    ]
    # Sort for stable diffs
    for (a, b, branch), w in sorted(waits.items()):
        a_esc = a.replace("'", "\\'")
        b_esc = b.replace("'", "\\'")
        branch_esc = branch.replace("'", "\\'")
        lines.append(f"  '{a_esc}|{b_esc}|{branch_esc}': {w},")
    lines.append('};')
    lines.append('')
    path.write_text('\n'.join(lines))


def write_report(
    edges: List[Tuple[str, str, str]],
    results: Dict[Tuple[str, str, str], Tuple[Optional[int], str]],
    path: Path,
) -> None:
    lines = ['from -> to (branch) | wait_min | source']
    lines.append('-' * 70)
    for e in edges:
        wait, src = results.get(e, (None, 'missing'))
        a, b, branch = e
        wait_str = f'{wait:>3}' if wait is not None else '  -'
        lines.append(f'{a} -> {b} ({branch}) | {wait_str} | {src}')
    # Summary
    n_ok = sum(1 for w, _ in results.values() if w is not None)
    n_total = len(edges)
    lines.append('-' * 70)
    lines.append(f'Total edges: {n_total}, with wait data: {n_ok} ({n_ok/n_total:.0%})')
    src_counts: Dict[str, int] = {}
    for _, src in results.values():
        src_counts[src] = src_counts.get(src, 0) + 1
    for src, count in sorted(src_counts.items(), key=lambda x: -x[1]):
        lines.append(f'  {src}: {count}')
    path.write_text('\n'.join(lines))


DEFAULT_VALIDATE_REPORT = PROJECT_ROOT / 'wait_times_validate.txt'
DEFAULT_EXPECTED_FIXTURE = Path(__file__).parent / 'expected_waits.json'


# Real asymmetries that aren't bugs — branch-end stations served by
# different combined frequencies from each side. Keyed by
# (sorted_a, sorted_b, branch).
EXPECTED_ASYMMETRIES = {
    # Acton Town vs Ealing Common Piccadilly: Acton Town is trunk (all 3
    # branches), Ealing Common only on Uxbridge branch.
    ("Acton Town", "Ealing Common", "Piccadilly_Uxbridge_Cockfosters"),
    # Stonebridge Park (outer Bakerloo) vs Wembley Central (trunk).
    ("Stonebridge Park", "Wembley Central", "Bakerloo"),
    # Gunnersbury (trunk) vs Turnham Green (branch start).
    ("Gunnersbury", "Turnham Green", "District_Richmond_Upminster"),
    # Earl's Court vs High Street Kensington District: H St K is on the
    # Edgware Rd shuttle leg, served less frequently than Earl's Court trunk.
    ("Earl's Court", "High Street Kensington", "District_Wimbledon_Edgware_Road"),
}


def platform_line_components(
    platforms: List[FrozenSet[str]],
) -> Dict[str, FrozenSet[str]]:
    """Map each line to the set of lines it can 'board whichever comes first'
    with, i.e. the connected component of the co-occurrence graph over the
    station's platforms.

    Two lines that appear together on any platform are linked; the relation is
    transitive. At Paddington the platforms are {Circle,District},
    {Circle,H&C}, {H&C}, {Bakerloo}×2 — Circle links District and links H&C, so
    Circle/District/H&C form ONE component (a rider on any of the three boards
    whichever train comes first), while Bakerloo stays separate. First-match
    platform keying would have wrongly split H&C off Circle here.
    """
    parent: Dict[str, str] = {}

    def find(x: str) -> str:
        parent.setdefault(x, x)
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:
            parent[x], x = root, parent[x]
        return root

    def union(a: str, b: str) -> None:
        parent[find(a)] = find(b)

    for lines in platforms:
        it = list(lines)
        for other in it[1:]:
            union(it[0], other)

    comps: Dict[str, set] = {}
    for line in parent:
        comps.setdefault(find(line), set()).add(line)
    return {line: frozenset(members)
            for members in comps.values() for line in members}


def platform_group_key(
    station: str,
    branch: str,
    boarding_naptan: Dict[Tuple[str, str], str],
    station_components: Dict[str, Dict[str, FrozenSet[str]]],
) -> object:
    """Return a key EQUAL for two branches iff a rider can board whichever train
    comes first among them at `station`, and unique otherwise.

    Keys on (station NAME, the connected component of lines this branch's line
    shares platforms with — see platform_line_components). NB: station NAME, not
    NaPTAN — see the split-site note at the end of this docstring; do not change
    this to key on the NaPTAN. Two branches whose lines are in the same component
    share the key; a line on its own platform (Metropolitan at Baker St, Northern
    vs Victoria at Kings Cross) is a singleton component and gets a singleton key.

    Falls back to a unique sentinel — never merges — when the boarding NaPTAN is
    unresolved, is a multi-modal HUB (doesn't prove a shared platform), or the
    station exposes no platform data (e.g. Overground-only 910G stops).

    The key is (station NAME, component) rather than (NaPTAN, component) on
    purpose: split-site stations give one line a different sub-station NaPTAN
    (Paddington H&C is 940GZZLUPAH while Circle/District is 940GZZLUPAC) even
    though they share platforms. The component is computed from the same
    platform list regardless of which NaPTAN we entered by, so keying on the
    station name keeps a genuine shared component together.
    """
    nap = boarding_naptan.get((station, branch))
    if nap is None or nap.startswith('HUB'):
        return ('__unresolved__', station, branch)
    dl = display_line(branch)
    comp = station_components.get(nap, {}).get(dl)
    if comp is None:
        return ('__no_platform__', station, branch)
    return (station, comp)


def combine_shared_hops(
    waits: Dict[Tuple[str, str, str], int],
    raw_headways: Dict[Tuple[str, str, str], Optional[float]],
    network: Dict[str, List[str]],
    boarding_naptan: Dict[Tuple[str, str], str],
    station_components: Dict[str, Dict[str, FrozenSet[str]]],
) -> Dict[Tuple[str, str, str], int]:
    """Collapse each shared boarding platform to its combined-frequency wait.

    Two branches share a wait only when a rider on one physically boards from
    the same platform as the other and takes whichever train comes first. The
    authoritative signal is TfL's per-platform line list (NaptanMetroPlatform
    children): two lines board the same platform iff some platform lists both.
    Station-level NaPTAN is NOT enough — Kings Cross gives one NaPTAN to Northern
    (plats 4/5) and Victoria (plats 1/2), physically separate platforms; likewise
    Metropolitan sits on its own platforms at Baker Street while Circle/H&C share
    another. See platform_group_key and naptan.platform_line_sets.

    We group the branches on a hop by shared platform and combine only within
    each group, via the combined headway H_c = 1 / sum(1 / H_i), writing that
    value to every branch in the group. Singleton groups are left untouched.

    Combining uses the raw (pre-floor) headways where available, falling back
    to reconstructing H_i = 2 * wait for entries without one (manual overrides).
    """
    from collections import defaultdict

    from .network import branches_by_hop

    hop_branches = branches_by_hop(network)
    combined = dict(waits)

    for (a, b), branch_ids in hop_branches.items():
        # Which of those branches actually have a wait for this hop.
        present = [br for br in branch_ids if (a, b, br) in waits]
        if len(present) < 2:
            continue  # single-branch hop: nothing to combine

        by_platform: Dict[object, List[str]] = defaultdict(list)
        for br in present:
            key = platform_group_key(a, br, boarding_naptan, station_components)
            by_platform[key].append(br)

        for group in by_platform.values():
            if len(group) < 2:
                continue  # only one branch boards this platform: no combine

            inv_sum = 0.0
            for br in group:
                h = raw_headways.get((a, b, br))
                if h is None or h <= 0:
                    h = 2 * waits[(a, b, br)]  # reconstruct from half-headway
                inv_sum += 1.0 / h
            if inv_sum <= 0:
                continue
            w_combined = wait_minutes(1.0 / inv_sum)

            for br in group:
                combined[(a, b, br)] = w_combined

    return combined


def main(argv: Optional[List[str]] = None) -> int:
    args = _parse_args(argv)
    _configure_logging(args.verbose)

    if args.validate:
        return _run_validate(args)

    html = args.html.read_text()
    network = parse_network(html)
    logger.info('Parsed %d branches in NETWORK', len(network))

    edges = enumerate_interchange_edges(network)
    logger.info('Found %d interchange edges', len(edges))
    if args.limit:
        edges = edges[:args.limit]
        logger.info('Limited to first %d edges', len(edges))

    naptan_map = load_csv_naptan_map()
    logger.info('Loaded %d NaPTAN codes from CSV', len(naptan_map))

    client = TflClient(cache_dir=args.cache, refresh=args.refresh)

    results: Dict[Tuple[str, str, str], Tuple[Optional[int], str]] = {}
    waits: Dict[Tuple[str, str, str], int] = {}
    raw_headways: Dict[Tuple[str, str, str], Optional[float]] = {}
    for i, edge in enumerate(edges):
        a, b, branch = edge
        wait, raw_h, src = compute_wait_for_edge(a, b, branch, naptan_map, client)
        results[edge] = (wait, src)
        if wait is not None:
            waits[edge] = wait
            raw_headways[edge] = raw_h
        if (i + 1) % 25 == 0:
            logger.info('Processed %d/%d edges (%d with data)',
                        i + 1, len(edges), len(waits))

    logger.info('Done: %d/%d edges have wait data', len(waits), len(edges))

    # Resolve the boarding NaPTAN for each (from-station, branch) that has a
    # wait, then fetch each station's per-platform line lists. combine_shared_hops
    # merges only branches that call at the same physical platform (a NaPTAN's
    # NaptanMetroPlatform child listing both lines) — station NaPTAN alone is too
    # coarse (Kings Cross gives one NaPTAN to Northern and Victoria on separate
    # platforms). Cache is already warm from the wait loop for the resolves; the
    # platform fetches are one StopPoint per station (cached on disk).
    boarding_naptan: Dict[Tuple[str, str], str] = {}
    for (a, _b, branch) in waits:
        if (a, branch) in boarding_naptan:
            continue
        tfl_line, _mode = tfl_for_branch(branch)
        if tfl_line is None:
            continue
        nap = resolve_naptan(a, naptan_map, client, tfl_line=tfl_line)
        if nap is not None:
            boarding_naptan[(a, branch)] = nap

    station_components: Dict[str, Dict[str, FrozenSet[str]]] = {}
    for nap in set(boarding_naptan.values()):
        station_components[nap] = platform_line_components(
            platform_line_sets(nap, client))

    # Collapse shared boarding platforms (branches sharing a physical platform)
    # to their combined frequency, so a player is never scored differently for
    # boarding the same physical train stream under a different line name.
    pre_combine = dict(waits)
    waits = combine_shared_hops(
        waits, raw_headways, network, boarding_naptan, station_components)
    n_changed = sum(1 for e, w in waits.items() if pre_combine.get(e) != w)
    logger.info('Combined shared hops: %d edge waits adjusted (of %d)',
                n_changed, len(waits))

    # Keep `results` (the human-readable report) in sync with the combined
    # waits actually written to wait_times.js — otherwise the report shows the
    # pre-combine per-line values, which no longer match the shipped data.
    for e, w in waits.items():
        _old_wait, src = results.get(e, (None, 'combined'))
        results[e] = (w, src)

    if not args.dry_run:
        write_wait_times_js(waits, args.output)
        write_report(edges, results, args.report)
        print(f'Wrote {args.output} ({len(waits)} edges)')
        print(f'Wrote {args.report}')
    else:
        print(f'[dry-run] would write {len(waits)} edges')

    return 0


def _run_validate(args) -> int:
    """Subcommand: run validation checks on the current wait_times.js.

    Returns 0 if no errors, 1 if any errors (warnings don't fail)."""
    from . import validate
    naptan_map = load_csv_naptan_map()
    client = TflClient(cache_dir=args.cache, refresh=False)

    def resolver(name: str, tfl_line: str):
        return resolve_naptan(name, naptan_map, client, tfl_line=tfl_line)

    def platform_fetcher(naptan: str):
        return platform_line_sets(naptan, client)

    network = parse_network(args.html.read_text())

    findings_by_check = validate.run_all_checks(
        wait_times_path=args.output,
        cache_dir=args.cache,
        fixture_path=DEFAULT_EXPECTED_FIXTURE,
        naptan_resolver=resolver,
        expected_asym=EXPECTED_ASYMMETRIES,
        network=network,
        platform_fetcher=platform_fetcher,
    )
    report = validate.format_findings(findings_by_check)
    print(report)
    DEFAULT_VALIDATE_REPORT.write_text(report)
    print(f'\nFull report: {DEFAULT_VALIDATE_REPORT}')

    n_errors = sum(
        1 for fs in findings_by_check.values()
        for f in fs if f['severity'] == 'error'
    )
    return 1 if n_errors > 0 else 0
