"""CLI orchestration for the interchange build pipeline.

Flow
----
1. Load game NETWORK and INTERCHANGE_MINS from index.html.
2. Validate overrides.py declarations against NETWORK.
3. Resolve game station names → ICS codes (via STATION_QUERIES + live API).
4. For each station: fetch + parse → cross-line pair minimums.
5. Apply ALLOWED_GIDS filter, CROSS_PLATFORM_INTERCHANGES declarations,
   game NETWORK filter, and MANUAL_OVERRIDES.
6. Diff against existing game data.
7. If --check-only: print diff and exit non-zero on missing pairs.
   Otherwise: write interchange_new.js and (optionally) update index.html.
"""

import argparse
import logging
import sys
from pathlib import Path
from typing import Dict, List

from . import diff as diff_mod
from . import game_data
from . import overrides
from . import parser as parser_mod
from . import station_ids
from . import writer
from .tfl_api import EmptyStopStructureError, TflClient


logger = logging.getLogger('build_interchanges')


PROJECT_ROOT = Path(__file__).parent.parent
DEFAULT_HTML = PROJECT_ROOT / 'index.html'
DEFAULT_CACHE = PROJECT_ROOT / 'build_interchanges' / 'cache'
DEFAULT_OUTPUT_JS = PROJECT_ROOT / 'interchange_new.js'
DEFAULT_DIFF_TXT = PROJECT_ROOT / 'interchange_diff.txt'


def main(argv: List[str] = None) -> int:
    args = _parse_args(argv)
    _configure_logging(args.verbose)

    network, existing = game_data.load_game_data(args.html)
    logger.info('Loaded NETWORK (%d stations) and INTERCHANGE_MINS (%d stations, %d pairs)',
                len(network), len(existing),
                sum(len(v) for v in existing.values()))

    # Validate declarations BEFORE running anything against the API.
    errors = overrides.validate(network)
    if errors:
        for e in errors:
            logger.error('Declarations error: %s', e)
        return 2

    stations = sorted(existing.keys())
    if args.station:
        wanted = set(args.station)
        stations = [s for s in stations if s in wanted]
        missing = wanted - set(stations)
        if missing:
            logger.error('Unknown station(s): %s', ', '.join(sorted(missing)))
            return 2
        logger.info('Limiting to %d station(s): %s', len(stations),
                    ', '.join(stations))

    client = TflClient(
        cache_dir=args.cache_dir,
        refresh=args.refresh,
    )

    ics_map = station_ids.resolve_station_ics(stations, client)
    unresolved = station_ids.validate_ics_resolution(stations, ics_map)
    if unresolved:
        logger.error('No ICS code for: %s', ', '.join(unresolved))
        if not args.allow_unresolved:
            return 3

    measured = _build_measured(client, stations, ics_map, network, existing)

    # If we only ran a subset (--station), splice into existing for diffing.
    if args.station:
        merged_for_diff = dict(existing)
        merged_for_diff.update(measured)
        diff_against = merged_for_diff
    else:
        diff_against = measured

    report = diff_mod.compute_diff(existing, diff_against)
    report_text = diff_mod.format_report(report)

    args.diff_path.write_text(report_text + '\n', encoding='utf-8')
    logger.info('Wrote %s', args.diff_path)
    print(report_text)

    if report.missing_pairs:
        logger.error(
            '%d pair(s) in the game are not produced by the API. '
            'Either declare them in MANUAL_OVERRIDES (with a reason) '
            'or remove them from the game. See diff report for the list.',
            len(report.missing_pairs),
        )
        if not args.allow_missing:
            return 4

    if args.check_only:
        logger.info('--check-only: not writing output files')
        return 0

    writer.write_standalone_js(diff_against, args.output_js)
    logger.info('Wrote %s', args.output_js)

    if args.apply:
        writer.replace_in_html(args.html, diff_against)
        logger.info('Updated INTERCHANGE_MINS block in %s', args.html)

    return 0


# ── Implementation helpers ────────────────────────────────────────────────


def _build_measured(client, stations, ics_map, network,
                    existing_game_data) -> Dict[str, Dict[str, int]]:
    """Run the full per-station pipeline and return {station: {pair: minutes}}."""
    measured: Dict[str, Dict[str, int]] = {}
    all_unknown_symbols = set()

    # Pre-compute combined line sets for linked-station groups
    # (e.g. Bank+Monument: combined lines = Central, Circle, DLR, District,
    # Northern, W&C). Each member station gets the full set so cross-line
    # pairs spanning the link survive the filter_to_game_lines step.
    linked_lines: Dict[str, set] = {}
    for group in overrides.LINKED_STATIONS:
        combined = set()
        for s in group:
            combined |= network.get(s, set())
        for s in group:
            linked_lines[s] = combined

    for i, stn in enumerate(stations, 1):
        ics_list = ics_map.get(stn)
        if not ics_list:
            logger.warning('[%d/%d] %s — no ICS code, skipping', i, len(stations), stn)
            continue

        allowed_gids = overrides.ALLOWED_GIDS.get(stn)
        # Use combined linked-station lines if this station is in a linked
        # group; otherwise use the per-station NETWORK lines.
        station_lines = linked_lines.get(stn) or network.get(stn, set())

        per_query_dicts = []
        for ics in ics_list:
            try:
                root = client.fetch_stop_structure(ics)
            except EmptyStopStructureError as e:
                logger.error('[%d/%d] %s — %s', i, len(stations), stn, e)
                continue
            pairs, unknown = parser_mod.parse_pairs_from_xml(root, allowed_gids)
            per_query_dicts.append(pairs)
            all_unknown_symbols.update(unknown)

        merged = parser_mod.merge_minimums(*per_query_dicts) if per_query_dicts else {}

        # Cross-platform interchange declarations (1-min same-platform pairs).
        cp_decls = overrides.CROSS_PLATFORM_INTERCHANGES.get(stn, [])
        merged = parser_mod.apply_cross_platform_interchanges(
            merged, cp_decls, station_lines,
        )

        # Drop pairs whose lines don't both serve this station per NETWORK
        # (or the combined set if linked).
        if station_lines:
            merged = parser_mod.filter_to_game_lines(merged, station_lines)

        # Same-line X|X pairs: keep only those the game already declares
        # (branch splits). Drop the rest (direction-change waits, which
        # the game doesn't model as interchanges).
        game_pairs_for_stn = set(existing_game_data.get(stn, {}).keys())
        merged = parser_mod.filter_same_line_to_game_pairs(
            merged, game_pairs_for_stn,
        )

        # Apply MANUAL_OVERRIDES last — they win over API.
        manual = overrides.MANUAL_OVERRIDES.get(stn, {})
        for pair, val in manual.items():
            merged[pair] = val

        measured[stn] = merged
        logger.info('[%d/%d] %s  ICS=%s → %d pairs',
                    i, len(stations), stn, ics_list, len(merged))

    if all_unknown_symbols:
        logger.warning(
            'Encountered %d unknown serving-line symbol(s): %s. '
            'Add them to symbols.py if they represent a real line.',
            len(all_unknown_symbols), sorted(all_unknown_symbols),
        )

    return measured


def _parse_args(argv):
    p = argparse.ArgumentParser(
        prog='build_interchanges',
        description='Build INTERCHANGE_MINS from the TfL Stop Structure API.',
    )
    p.add_argument('--html', type=Path, default=DEFAULT_HTML,
                   help='Path to index.html (default: %(default)s)')
    p.add_argument('--cache-dir', type=Path, default=DEFAULT_CACHE,
                   help='Where to cache XML responses (default: %(default)s)')
    p.add_argument('--refresh', action='store_true',
                   help='Bypass cache and re-fetch all responses')
    p.add_argument('--output-js', type=Path, default=DEFAULT_OUTPUT_JS,
                   help='Where to write the generated JS (default: %(default)s)')
    p.add_argument('--diff-path', type=Path, default=DEFAULT_DIFF_TXT,
                   help='Where to write the diff report (default: %(default)s)')
    p.add_argument('--apply', action='store_true',
                   help='Replace the INTERCHANGE_MINS block in index.html')
    p.add_argument('--check-only', action='store_true',
                   help='Print the diff and exit; do not write any files')
    p.add_argument('--station', action='append', default=[],
                   help='Limit to this station (repeatable). For debugging.')
    p.add_argument('--allow-missing', action='store_true',
                   help='Exit 0 even if game has pairs the API does not produce')
    p.add_argument('--allow-unresolved', action='store_true',
                   help='Exit 0 even if some stations lack ICS codes')
    p.add_argument('-v', '--verbose', action='count', default=0,
                   help='-v for INFO, -vv for DEBUG')
    return p.parse_args(argv)


def _configure_logging(verbose: int) -> None:
    level = logging.WARNING
    if verbose == 1:
        level = logging.INFO
    elif verbose >= 2:
        level = logging.DEBUG
    logging.basicConfig(
        level=level,
        format='%(asctime)s %(levelname)-7s %(name)s: %(message)s',
        datefmt='%H:%M:%S',
    )


if __name__ == '__main__':
    sys.exit(main())
