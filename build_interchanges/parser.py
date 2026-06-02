"""Parse TfL Stop Structure XML into {line_pair: min_minutes}.

This module is pure: input is an XML root + a few config sets, output is
a dict. No I/O, no network. That makes it unit-testable against checked-in
fixtures (see tests/fixtures/).

Key concepts
------------

* **Platform areas**: `<stopAreaLines>` blocks with `areaType` 81 (LOCALTRAINS+
  LINESCARRYING_BIKES+PUBLICTRANSPORT) or 65 (LOCALTRAINS+PUBLICTRANSPORT)
  are physical train platforms. Each has an `<itdPoint area="N" gid="...">`
  identifying its position and stop record.

* **(gid, area) keying**: The same area index N appears multiple times in
  a no-ESM response — once per stop record (NaPTAN) that contributes to it.
  We key platform areas by `(gid, area)` so e.g. Baker Street Bakerloo
  (area=2, gid=940GZZLUERB) is distinct from Baker Street Circle/H&C
  (area=2, gid=940GZZLUERC).

* **Serving lines**: `<itdServingLine symbol="...">` enumerates the lines
  that stop at each platform. Mapped to display names via symbols.py.

* **Footpaths**: `<footpathInfo duration="N">` with two `<itdPoint>` children
  identifies an interchange path between two areas, scoped by GID. We filter
  to footpaths where both GIDs are in the per-station allowed set, then
  compute min(duration) per cross-line pair.
"""

import logging
import xml.etree.ElementTree as ET
from typing import Dict, FrozenSet, List, Optional, Set, Tuple

from .symbols import SYMBOL_TO_LINE


logger = logging.getLogger(__name__)


PLATFORM_AREA_TYPES = frozenset({'81', '65'})


def _normalise_pair(a: str, b: str) -> str:
    """Return 'A|B' alphabetically sorted (or 'X|X' for same-line pairs).

    Same-line pairs are kept here because some stations have legitimate
    same-line interchanges (branch splits: Whitechapel Elizabeth↔Elizabeth
    Shenfield↔Abbey Wood, Woodford Central↔Central Hainault↔Epping, etc.).
    The CLI later filters these to only preserve pairs the game already
    declares — see filter_same_line_to_game_pairs.
    """
    return '|'.join(sorted([a, b]))


def collect_platform_areas(
    root: ET.Element,
    allowed_gids: Optional[Set[str]] = None,
) -> Tuple[Dict[Tuple[str, str], Set[str]], Set[str]]:
    """Build {(gid, area_idx): {display_line, ...}} from a stop structure XML.

    If `allowed_gids` is given, only areas whose `gid` is in the set are kept.
    Returns (area_lines, unknown_symbols) where unknown_symbols collects
    any itdServingLine symbols not in SYMBOL_TO_LINE — surfacing new lines
    or renames so they can't be silently dropped.
    """
    area_lines: Dict[Tuple[str, str], Set[str]] = {}
    unknown_symbols: Set[str] = set()

    for sal in root.findall('.//stopAreaLines'):
        sa = sal.find('stopArea')
        if sa is None:
            continue
        if sa.get('areaType', '') not in PLATFORM_AREA_TYPES:
            continue
        pt = sa.find('itdPoint')
        if pt is None:
            continue
        gid = pt.get('gid', '')
        if allowed_gids is not None and gid not in allowed_gids:
            continue
        area = pt.get('area', '')
        if not area:
            continue

        for sl in sal.findall('.//itdServingLine'):
            symbol = sl.get('symbol', '')
            if not symbol:
                continue
            line = SYMBOL_TO_LINE.get(symbol)
            if line is None:
                # Bus / NR services use numeric symbols we don't care about.
                # Only flag symbols that *look* like tube/Overground codes
                # (3-letter all-caps) — otherwise we get thousands of "12N"
                # false positives.
                if len(symbol) == 3 and symbol.isalpha() and symbol.isupper():
                    unknown_symbols.add(symbol)
                continue
            area_lines.setdefault((gid, area), set()).add(line)

    return area_lines, unknown_symbols


def parse_footpath_pairs(
    root: ET.Element,
    area_lines: Dict[Tuple[str, str], Set[str]],
    allowed_gids: Optional[Set[str]] = None,
) -> Dict[str, int]:
    """Extract {sorted_line_pair: min_duration} from <footpathInfo> elements.

    A footpath endpoint contributes to a pair iff its (gid, area) is in
    `area_lines` (which means it's a platform area, possibly GID-filtered).
    Same-line pairs are dropped per the game's data model.
    """
    pair_mins: Dict[str, int] = {}

    for fp in root.findall('.//footpathInfos/footpathInfo'):
        dur_s = fp.get('duration', '')
        if not dur_s:
            continue
        try:
            dur = int(dur_s)
        except ValueError:
            continue
        if dur <= 0:
            continue

        pts = fp.findall('itdPoint')
        if len(pts) < 2:
            continue
        gid_a, gid_b = pts[0].get('gid', ''), pts[1].get('gid', '')
        if allowed_gids is not None:
            if gid_a not in allowed_gids or gid_b not in allowed_gids:
                continue

        area_a, area_b = pts[0].get('area', ''), pts[1].get('area', '')
        # Skip self-loops (gid+area identical) — they don't model interchange.
        if gid_a == gid_b and area_a == area_b:
            continue

        lines_a = area_lines.get((gid_a, area_a), set())
        lines_b = area_lines.get((gid_b, area_b), set())
        if not lines_a or not lines_b:
            continue

        for la in lines_a:
            for lb in lines_b:
                pair = _normalise_pair(la, lb)
                if pair not in pair_mins or dur < pair_mins[pair]:
                    pair_mins[pair] = dur

    return pair_mins


def apply_cross_platform_interchanges(
    pair_mins: Dict[str, int],
    declarations: List[FrozenSet[str]],
    station_lines: Set[str],
) -> Dict[str, int]:
    """Emit 1-min entries for declared cross-platform interchange pairs.

    Each frozenset in `declarations` enumerates lines that share a physical
    platform at this station. Every cross-line pair drawn from each set
    gets a 1-min interchange — but only if both lines actually serve this
    station per NETWORK (defends against stale declarations).
    """
    out = dict(pair_mins)
    for group in declarations:
        valid = sorted(line for line in group if line in station_lines)
        for i in range(len(valid)):
            for j in range(i + 1, len(valid)):
                pair = _normalise_pair(valid[i], valid[j])
                if pair not in out or 1 < out[pair]:
                    out[pair] = 1
    return out


def filter_to_game_lines(
    pair_mins: Dict[str, int],
    station_lines: Set[str],
) -> Dict[str, int]:
    """Drop pairs whose lines don't both serve this station per NETWORK.

    The API can return cross-line pairs involving lines from physically
    nearby but distinct stations (e.g. Tower Hill returning Central via
    Bank footpaths). Only keep pairs where both lines are in the game's
    set of lines for this station.
    """
    out: Dict[str, int] = {}
    for pair, val in pair_mins.items():
        a, b = pair.split('|')
        if a in station_lines and b in station_lines:
            out[pair] = val
    return out


def merge_minimums(*dicts: Dict[str, int]) -> Dict[str, int]:
    """Merge multiple {pair: minutes} dicts, taking the minimum per key."""
    out: Dict[str, int] = {}
    for d in dicts:
        for k, v in d.items():
            if k not in out or v < out[k]:
                out[k] = v
    return out


def filter_same_line_to_game_pairs(
    pair_mins: Dict[str, int],
    game_pairs: Set[str],
) -> Dict[str, int]:
    """Keep same-line (X|X) pairs ONLY if they're declared in the game's
    existing INTERCHANGE_MINS for this station.

    Why: the API can emit X|X for two distinct reasons:
    * Branch splits — Whitechapel Elizabeth↔Elizabeth (Shenfield vs Abbey
      Wood), Woodford Central↔Central (Hainault vs Epping). These ARE
      game interchanges; the player physically changes trains.
    * Direction-change wait — eastbound platform ↔ westbound platform on
      the same line. NOT a game interchange; the game ignores them.

    We can't tell these apart from the API alone, so we trust the game's
    existing declaration: if the game has X|X for this station, the API
    value is kept; otherwise it's dropped.

    Cross-line pairs (X|Y where X != Y) are unaffected by this filter.
    """
    out: Dict[str, int] = {}
    for pair, val in pair_mins.items():
        a, b = pair.split('|')
        if a == b and pair not in game_pairs:
            continue
        out[pair] = val
    return out


def parse_pairs_from_xml(
    root: ET.Element,
    allowed_gids: Optional[Set[str]] = None,
) -> Tuple[Dict[str, int], Set[str]]:
    """End-to-end: XML → (cross-line pairs, unknown symbols).

    Convenience wrapper around collect_platform_areas + parse_footpath_pairs
    for callers that don't need the intermediate state.
    """
    area_lines, unknown = collect_platform_areas(root, allowed_gids)
    pairs = parse_footpath_pairs(root, area_lines, allowed_gids)
    return pairs, unknown
