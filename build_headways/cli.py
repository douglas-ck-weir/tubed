"""CLI for building wait_times.js."""

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .headway import (
    headway_from_tube_timetable,
    line_departures_from_jr,
    wait_minutes,
)
from .line_map import tfl_for_branch
from .naptan import load_csv_naptan_map, resolve_naptan
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
) -> Tuple[Optional[int], str]:
    """Return (wait_mins, source_tag) for one edge.

    source_tag is one of: 'tube-tt', 'jr', 'manual', 'no-data',
    'no-naptan', 'unmapped-line'.
    """
    if (from_stn, to_stn, branch) in MANUAL_WAIT_OVERRIDES:
        return MANUAL_WAIT_OVERRIDES[(from_stn, to_stn, branch)], 'manual'

    tfl_line, tfl_mode = tfl_for_branch(branch)
    if tfl_line is None:
        return None, 'unmapped-line'

    from_naptan = resolve_naptan(from_stn, naptan_map, client, tfl_line=tfl_line)
    to_naptan = resolve_naptan(to_stn, naptan_map, client, tfl_line=tfl_line)
    if from_naptan is None or to_naptan is None:
        return None, 'no-naptan'

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
                return wait_minutes(h), 'tube-tt'
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
            return wait_minutes(sum(gaps) / len(gaps)), 'jr'

    return None, 'no-data'


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
    for i, edge in enumerate(edges):
        a, b, branch = edge
        wait, src = compute_wait_for_edge(a, b, branch, naptan_map, client)
        results[edge] = (wait, src)
        if wait is not None:
            waits[edge] = wait
        if (i + 1) % 25 == 0:
            logger.info('Processed %d/%d edges (%d with data)',
                        i + 1, len(edges), len(waits))

    logger.info('Done: %d/%d edges have wait data', len(waits), len(edges))

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

    findings_by_check = validate.run_all_checks(
        wait_times_path=args.output,
        cache_dir=args.cache,
        fixture_path=DEFAULT_EXPECTED_FIXTURE,
        naptan_resolver=resolver,
        expected_asym=EXPECTED_ASYMMETRIES,
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
