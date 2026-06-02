"""Tests for overrides.py declarations.

These run during normal `pytest` invocations to validate that the
declarations are internally consistent and reference real stations/lines
in the game NETWORK.
"""

from pathlib import Path

import pytest

from build_interchanges import overrides, game_data


@pytest.fixture(scope='module')
def network():
    html = Path(__file__).parent.parent.parent / 'index.html'
    if not html.exists():
        pytest.skip('index.html not present')
    n, _ = game_data.load_game_data(html)
    return n


def test_validate_returns_no_errors(network):
    """All CROSS_PLATFORM_INTERCHANGES and MANUAL_OVERRIDES entries should
    reference stations and lines that exist in the current NETWORK."""
    errors = overrides.validate(network)
    assert errors == [], '\n'.join(errors)


def test_station_queries_use_ics_codes_or_documented_naptan():
    """ICS codes are documented to work. NaPTAN identifiers are not — only
    a small allow-list of stations is permitted to use them, and each must
    be present as a documented workaround in overrides.py.
    """
    DOCUMENTED_NAPTAN_USERS = {
        'Edgware Road',  # Cross-station footpaths only via ERC NaPTAN
        'Paddington',    # Elizabeth↔H&C footpaths only via 910GPADTON
    }
    for stn, ids in overrides.STATION_QUERIES.items():
        for sid in ids:
            if sid.isdigit():
                continue
            assert stn in DOCUMENTED_NAPTAN_USERS, (
                f'{stn} uses non-ICS identifier {sid!r}. NaPTAN identifiers '
                f'are not documented to work with this API per the TfL '
                f'forum thread on 940GZZLUWLO. Either find an ICS or add '
                f'this station to DOCUMENTED_NAPTAN_USERS in this test.'
            )


def test_manual_override_pairs_are_sorted():
    """Pair keys must be 'A|B' with A <= B alphabetically. Same-line
    branch-split pairs (e.g. Elizabeth|Elizabeth at Heathrow T2&3) use
    A == B and are valid."""
    for stn, pairs in overrides.MANUAL_OVERRIDES.items():
        for pair in pairs:
            parts = pair.split('|')
            assert len(parts) == 2, f'{stn} {pair}: not A|B format'
            assert parts[0] <= parts[1], (
                f'{stn} {pair}: not sorted alphabetically'
            )


def test_cross_platform_groups_are_nontrivial():
    """A cross-platform group must have at least 2 lines (otherwise it's
    declaring nothing — likely a typo)."""
    for stn, groups in overrides.CROSS_PLATFORM_INTERCHANGES.items():
        for group in groups:
            assert len(group) >= 2, (
                f'{stn}: cross-platform group {group} has fewer than 2 lines'
            )


def test_linked_stations_use_frozensets():
    for group in overrides.LINKED_STATIONS:
        assert isinstance(group, frozenset)
        assert len(group) >= 2
