"""Parse NETWORK from index.html and enumerate interchange edges.

An "interchange edge" is (from_station, to_station, branch_id) where
`from_station` is served by 2+ display lines (i.e. it's an interchange)
and (from_station, to_station) is an adjacent pair on `branch_id`.

Mid-line edges (where `from_station` has only one line) get no wait
because the player is already on the train.
"""

import logging
import re
from pathlib import Path
from typing import Dict, List, Set, Tuple


logger = logging.getLogger(__name__)


# Display line prefix table mirrors index.html's DISPLAY_LINE_PREFIXES.
DISPLAY_LINE_PREFIXES = [
    ('Overground_Lioness',     'Lioness'),
    ('Overground_Mildmay',     'Mildmay'),
    ('Overground_Windrush',    'Windrush'),
    ('Overground_Weaver',      'Weaver'),
    ('Overground_Suffragette', 'Suffragette'),
    ('Overground_Liberty',     'Liberty'),
    ('Overground',             'Overground'),
    ('Northern',               'Northern'),
    ('District',               'District'),
    ('Central',                'Central'),
    ('Circle',                 'Circle'),
    ('Metropolitan',           'Metropolitan'),
    ('Piccadilly',             'Piccadilly'),
    ('DLR',                    'DLR'),
    ('Elizabeth',              'Elizabeth'),
]


def display_line(branch_id: str) -> str:
    for prefix, name in DISPLAY_LINE_PREFIXES:
        if branch_id.startswith(prefix):
            return name
    return branch_id


def _extract_block(html: str, header: str) -> str:
    start = html.find(header)
    if start == -1:
        raise ValueError(f'{header!r} not found')
    block_start = html.index('{', start)
    depth = 0
    for i in range(block_start, len(html)):
        ch = html[i]
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return html[block_start + 1:i]
    raise ValueError(f'Unbalanced braces in {header}')


_KEY_RE = re.compile(r"""(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")""")


def _unescape(s: str) -> str:
    return s.replace("\\'", "'").replace('\\"', '"').replace('\\\\', '\\')


def parse_network(html: str) -> Dict[str, List[str]]:
    """Return {branch_id: [station1, station2, ...]}."""
    block = _extract_block(html, 'const NETWORK = {')
    network: Dict[str, List[str]] = {}
    for m in re.finditer(
        r"""(?:'((?:[^'\\]|\\.)+)'|"((?:[^"\\]|\\.)+)")\s*:\s*\[([^\]]+)\]""",
        block, re.DOTALL,
    ):
        branch = _unescape(m.group(1) or m.group(2) or '')
        body = m.group(3)
        stations = []
        for sm in _KEY_RE.finditer(body):
            station = _unescape(sm.group(1) or sm.group(2) or '')
            if station:
                stations.append(station)
        network[branch] = stations
    return network


def stations_by_display_line(network: Dict[str, List[str]]) -> Dict[str, Set[str]]:
    """Return {station: {display_line, ...}}."""
    out: Dict[str, Set[str]] = {}
    for branch, stns in network.items():
        dline = display_line(branch)
        for s in stns:
            out.setdefault(s, set()).add(dline)
    return out


def enumerate_interchange_edges(
    network: Dict[str, List[str]],
) -> List[Tuple[str, str, str]]:
    """List (from, to, branch_id) where `from` is an interchange (2+ lines).

    Both directions of every adjacent pair are included so we capture
    waits for both travel directions.
    """
    stn_lines = stations_by_display_line(network)
    out: List[Tuple[str, str, str]] = []
    for branch, stns in network.items():
        for i in range(len(stns) - 1):
            a, b = stns[i], stns[i + 1]
            if len(stn_lines.get(a, set())) >= 2:
                out.append((a, b, branch))
            if len(stn_lines.get(b, set())) >= 2:
                out.append((b, a, branch))
    # Dedupe — branches can share segments
    return sorted(set(out))
