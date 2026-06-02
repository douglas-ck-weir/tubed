"""Parse the game's NETWORK and INTERCHANGE_MINS from index.html.

The game stores both in JS object literals. Single- and double-quoted keys
are both used (double for names containing apostrophes like "St. James's
Park"). This module handles both forms and escaped quotes (e.g. 'Earl\\'s
Court').

Output is just plain Python dicts; the CLI handles writing back.
"""

import logging
import re
from pathlib import Path
from typing import Dict, List, Set

from .symbols import ALL_DISPLAY_LINES


logger = logging.getLogger(__name__)


# JS key regex that handles both 'single' and "double" quoted strings,
# including escaped quotes. The capture groups in order are:
#   1: single-quoted content (with \' escapes)
#   2: double-quoted content (with \" escapes)
_KEY_RE = re.compile(
    r"""(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")"""
)


def _unescape_js_string(s: str) -> str:
    return s.replace("\\'", "'").replace('\\"', '"').replace('\\\\', '\\')


def _extract_block(html: str, header: str) -> str:
    """Extract the contents between the opening '{' and matching '\\n};' of
    a top-level JS object literal named `header` (e.g. 'const NETWORK = {').
    Raises ValueError if not found.
    """
    start = html.find(header)
    if start == -1:
        raise ValueError(f'{header!r} not found in HTML')
    block_start = html.index('{', start)
    # Find matching brace by counting depth.
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


# ── NETWORK ────────────────────────────────────────────────────────────────


def parse_network(html: str) -> Dict[str, Set[str]]:
    """Return {station: {display_line, ...}} from const NETWORK = {...}.

    Uses the game's own DISPLAY_LINE_PREFIXES table to map line patterns
    (e.g. 'Overground_Lioness', 'Northern_via_Bank') to display lines
    ('Lioness', 'Northern'). Mirrors the JS `displayLine()` function.
    """
    prefix_table = parse_display_line_prefixes(html)
    matcher = _make_pattern_matcher(prefix_table)
    block = _extract_block(html, 'const NETWORK = {')

    network: Dict[str, Set[str]] = {}

    # Each entry: 'pattern': [ ... stations ...],
    pattern_iter = re.finditer(
        r"""(?:'((?:[^'\\]|\\.)+)'|"((?:[^"\\]|\\.)+)")\s*:\s*\[([^\]]+)\]""",
        block, re.DOTALL,
    )
    for m in pattern_iter:
        raw_pattern = _unescape_js_string(m.group(1) or m.group(2) or '')
        body = m.group(3)
        line = matcher(raw_pattern)
        if line is None:
            logger.warning(
                'NETWORK pattern %r does not match any DISPLAY_LINE_PREFIXES '
                'entry; this station group will be ignored.', raw_pattern,
            )
            continue
        stations = [
            _unescape_js_string(s)
            for s in re.findall(r"'((?:[^'\\]|\\.)+)'", body)
        ]
        for stn in stations:
            network.setdefault(stn, set()).add(line)

    return network


def parse_display_line_prefixes(html: str) -> List[tuple]:
    """Extract the game's DISPLAY_LINE_PREFIXES table from index.html.

    Mirrors the JS `displayLine()` function — order matters because we
    use longest-prefix-first matching (the game does the same).

    Returns [(pattern_prefix, display_name), ...] in the order they
    appear in the HTML.
    """
    start = html.find('const DISPLAY_LINE_PREFIXES = [')
    if start == -1:
        raise ValueError('DISPLAY_LINE_PREFIXES not found in HTML')
    block_start = html.index('[', start)
    depth = 0
    end = block_start
    for i in range(block_start, len(html)):
        ch = html[i]
        if ch == '[':
            depth += 1
        elif ch == ']':
            depth -= 1
            if depth == 0:
                end = i
                break
    block = html[block_start + 1:end]

    pairs = []
    # Each entry: ['Pattern', 'Display'],
    for m in re.finditer(
        r"""\[\s*'((?:[^'\\]|\\.)+)'\s*,\s*'((?:[^'\\]|\\.)+)'\s*\]""",
        block,
    ):
        pairs.append((_unescape_js_string(m.group(1)),
                      _unescape_js_string(m.group(2))))
    return pairs


def _make_pattern_matcher(prefixes: List[tuple]):
    """Return a function pattern_string → display_line_or_None.

    Mirrors the game's `displayLine()` JS function: walks the prefix table
    in order and returns the first prefix match. Order matters because
    shorter prefixes (e.g. 'Overground') would otherwise eclipse longer
    ones (e.g. 'Overground_Lioness').

    If no prefix matches, falls back to ALL_DISPLAY_LINES — the game's JS
    `displayLine()` returns the input unchanged in this case, which is
    correct for patterns that ARE the display line (e.g. 'Bakerloo',
    'Jubilee'). We validate against ALL_DISPLAY_LINES so typos don't
    silently slip through.
    """
    def matcher(pattern: str):
        for prefix, name in prefixes:
            if pattern.startswith(prefix):
                return name
        if pattern in ALL_DISPLAY_LINES:
            return pattern
        return None
    return matcher


# ── INTERCHANGE_MINS ───────────────────────────────────────────────────────


def parse_interchange_mins(html: str) -> Dict[str, Dict[str, int]]:
    """Return {station: {line_pair: minutes}} from const INTERCHANGE_MINS."""
    block = _extract_block(html, 'const INTERCHANGE_MINS = {')

    # Two-level parse: track current station as we walk the block.
    result: Dict[str, Dict[str, int]] = {}
    current: str = ''

    header_re = re.compile(
        r"""^\s*(?:'((?:[^'\\]|\\.)+)'|"((?:[^"\\]|\\.)+)")\s*:\s*\{\s*$"""
    )
    entry_re = re.compile(
        r"""^\s*(?:'((?:[^'\\]|\\.)+)'|"((?:[^"\\]|\\.)+)")\s*:\s*(\d+)"""
    )

    for line in block.split('\n'):
        m = header_re.match(line)
        if m:
            current = _unescape_js_string(m.group(1) or m.group(2) or '')
            result[current] = {}
            continue
        m = entry_re.match(line)
        if m and current:
            key = _unescape_js_string(m.group(1) or m.group(2) or '')
            result[current][key] = int(m.group(3))

    return result


# ── Convenience loader ─────────────────────────────────────────────────────


def load_game_data(html_path: Path):
    """Read index.html and return (network, interchange_mins) parsed dicts."""
    html = html_path.read_text(encoding='utf-8')
    network = parse_network(html)
    interchange = parse_interchange_mins(html)
    return network, interchange
