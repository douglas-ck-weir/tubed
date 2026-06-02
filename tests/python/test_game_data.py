"""Tests for game_data.py — the index.html parser.

These tests use inline HTML strings rather than the full index.html to
keep them focused. There's a separate "smoke test" against the real
file at the end.
"""

from pathlib import Path

import pytest

from build_interchanges import game_data


# ── INTERCHANGE_MINS parsing ─────────────────────────────────────────────


def test_parse_interchange_mins_basic():
    html = """
    junk
    const INTERCHANGE_MINS = {
      'Acton Town': {
        'District|Piccadilly': 2,
      },
      'Bond Street': {
        'Central|Jubilee': 4,
        'Central|Elizabeth': 5,
      },
    };
    more junk
    """
    out = game_data.parse_interchange_mins(html)
    assert out['Acton Town'] == {'District|Piccadilly': 2}
    assert out['Bond Street']['Central|Jubilee'] == 4
    assert out['Bond Street']['Central|Elizabeth'] == 5


def test_parse_interchange_mins_apostrophe_station():
    """Station names with apostrophes (Earl's, Queen's, St. James's, etc.)
    are quoted with double quotes in the HTML. The parser must handle both.
    """
    html = """
    const INTERCHANGE_MINS = {
      "Earl's Court": {
        'District|Piccadilly': 3,
      },
      "St. James's Park": {
        'Circle|District': 4,
      },
    };
    """
    out = game_data.parse_interchange_mins(html)
    assert "Earl's Court" in out
    assert out["Earl's Court"]['District|Piccadilly'] == 3
    assert "St. James's Park" in out
    assert out["St. James's Park"]['Circle|District'] == 4


def test_parse_interchange_mins_escaped_apostrophe():
    """If a station name in single-quoted JS contains an escaped apostrophe
    (e.g. 'Earl\\'s Court'), the parser should unescape it."""
    html = r"""
    const INTERCHANGE_MINS = {
      'Earl\'s Court': {
        'District|Piccadilly': 3,
      },
    };
    """
    out = game_data.parse_interchange_mins(html)
    assert "Earl's Court" in out


def test_parse_interchange_mins_does_not_misattribute_apostrophe_section():
    """Regression test: an earlier parser bug attributed pairs from the
    'St. James's Park' block to the previous station (because the regex
    didn't match the double-quoted apostrophe key, leaving `current` stale).
    """
    html = """
    const INTERCHANGE_MINS = {
      'South Kenton': {
        'Bakerloo|Lioness': 2,
      },
      "St. James's Park": {
        'Circle|District': 4,
      },
    };
    """
    out = game_data.parse_interchange_mins(html)
    # South Kenton MUST only have Bakerloo|Lioness — not Circle|District.
    assert out['South Kenton'] == {'Bakerloo|Lioness': 2}
    assert out["St. James's Park"] == {'Circle|District': 4}


# ── NETWORK parsing ──────────────────────────────────────────────────────


def test_parse_network_basic():
    html = """
    const DISPLAY_LINE_PREFIXES = [
      ['Overground_Lioness', 'Lioness'],
    ];
    const NETWORK = {
      'Bakerloo': ['Elephant & Castle', 'Lambeth North'],
      'Overground_Lioness': ['Watford Junction', 'Watford High Street'],
    };
    """
    network = game_data.parse_network(html)
    assert 'Elephant & Castle' in network
    assert network['Elephant & Castle'] == {'Bakerloo'}
    assert network['Watford High Street'] == {'Lioness'}


def test_parse_network_unknown_pattern_warns_not_fails(caplog):
    """Unknown patterns should warn, not crash, so a NETWORK addition doesn't
    fail the build before someone updates DISPLAY_LINE_PREFIXES."""
    html = """
    const DISPLAY_LINE_PREFIXES = [
      ['Bakerloo', 'Bakerloo'],
    ];
    const NETWORK = {
      'Bakerloo': ['Embankment'],
      'WeirdMadeUpLine_Branch': ['Some Station'],
    };
    """
    import logging
    with caplog.at_level(logging.WARNING):
        network = game_data.parse_network(html)
    assert 'Embankment' in network
    # The bogus pattern should have logged a warning and been skipped.
    assert any('WeirdMadeUpLine_Branch' in r.message for r in caplog.records)


# ── Smoke test against the real index.html ──────────────────────────────


def test_real_index_html_has_expected_structure():
    """Smoke test: the real index.html parses cleanly with expected counts."""
    project_root = Path(__file__).parent.parent.parent
    html_path = project_root / 'index.html'
    if not html_path.exists():
        pytest.skip('index.html not present (running outside project)')

    network, interchange = game_data.load_game_data(html_path)

    # Sanity bounds — adjust if the game grows significantly.
    assert len(network) >= 200, 'NETWORK seems too small'
    assert len(interchange) >= 80, 'INTERCHANGE_MINS seems too small'
    # Bank and Monument must both exist with their canonical lines.
    assert {'Central', 'Northern'}.issubset(network.get('Bank', set()))
    assert {'Circle', 'District'}.issubset(network.get('Monument', set()))
    # Apostrophe stations must round-trip.
    assert "Earl's Court" in network
