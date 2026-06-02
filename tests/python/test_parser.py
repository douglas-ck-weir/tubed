"""Parser tests against checked-in XML fixtures.

Each fixture is the real TfL Stop Structure response for a known station
(captured during the initial build). The parser logic should produce stable
output for these fixtures — any regression breaks the test.

When the API response format changes, re-capture the fixtures by deleting
the corresponding cache file under build_interchanges/cache/ and re-running
the build. Then update these tests to match the new expected values.
"""

import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from build_interchanges import parser
from build_interchanges import overrides


FIXTURE_DIR = Path(__file__).parent / 'fixtures'


def _load(name: str) -> ET.Element:
    return ET.fromstring((FIXTURE_DIR / name).read_text(encoding='utf-8'))


# ── Baker Street ─────────────────────────────────────────────────────────


def test_baker_street_platform_areas():
    """Baker Street is the canonical test case for (gid, area) keying.

    When ICS 1000011 is queried, the response merges multiple stop records
    (LUBST, LUERB, LUERC) with overlapping area indices. The parser must
    key platforms by (gid, area) so each stop record's areas remain
    distinct.
    """
    root = _load('baker_street.xml')
    allowed = overrides.ALLOWED_GIDS['Baker Street']
    areas, _ = parser.collect_platform_areas(root, allowed)

    # LUBST holds Bakerloo (2/3), Circle+H&C (4/5), Jubilee (6/7), Met (8/9).
    # The Bakerloo platforms are also indexed under LUERB.
    assert ('940GZZLUBST', '2') in areas
    assert areas[('940GZZLUBST', '2')] == {'Bakerloo'}
    assert areas[('940GZZLUBST', '6')] == {'Jubilee'}
    assert areas[('940GZZLUBST', '8')] == {'Metropolitan'}
    assert areas[('940GZZLUBST', '4')] == {'Circle', 'Hammersmith & City'}


def test_baker_street_cross_line_pairs():
    """Cross-line pairs at Baker Street should include the major interchanges.

    The +1 from cross-platform declarations isn't applied at parse time;
    these are the raw footpath-derived values.
    """
    root = _load('baker_street.xml')
    allowed = overrides.ALLOWED_GIDS['Baker Street']
    pairs, _ = parser.parse_pairs_from_xml(root, allowed)

    # Bakerloo ↔ deep tube lines on the same physical station have known
    # short footpaths. Bakerloo ↔ Jubilee is a famously easy interchange.
    assert pairs.get('Bakerloo|Jubilee') == 2
    # Bakerloo ↔ Metropolitan is longer but within the same station.
    assert 3 <= pairs.get('Bakerloo|Metropolitan', 99) <= 6


# ── Paddington ───────────────────────────────────────────────────────────


def test_paddington_circle_district_share_platforms():
    """At PAC the sub-surface platforms carry both Circle and District.

    The parser should detect this without any platform-share expansion
    config — both lines appear in the same itdServingLine symbol set on
    each platform area.
    """
    root = _load('paddington.xml')
    allowed = overrides.ALLOWED_GIDS['Paddington']
    areas, _ = parser.collect_platform_areas(root, allowed)

    pac_subsurface_areas = [a for a in areas
                            if a[0] == '940GZZLUPAC' and
                            'Circle' in areas[a] and 'District' in areas[a]]
    assert pac_subsurface_areas, 'Expected at least one PAC area with Circle+District'


def test_paddington_bakerloo_to_subsurface_is_long():
    """At Paddington, Bakerloo platforms are at the south end (Praed St)
    and Circle/District are at the north — a long walk in TfL's data."""
    root = _load('paddington.xml')
    allowed = overrides.ALLOWED_GIDS['Paddington']
    pairs, _ = parser.parse_pairs_from_xml(root, allowed)

    bakerloo_circle = pairs.get('Bakerloo|Circle')
    assert bakerloo_circle is not None
    assert bakerloo_circle >= 8, (
        f'Bakerloo↔Circle at Paddington should be a long walk; got {bakerloo_circle}'
    )


# ── Mile End ─────────────────────────────────────────────────────────────


def test_mile_end_central_and_district_platforms_are_close():
    """Mile End is the iconic cross-platform Central↔District interchange.

    In the API data, Central and District/H&C are on *separate* areas (not
    the same one), but the footpath between them is very short (1-2 min)
    because they're adjacent across the same island platform. The actual
    1-minute interchange is declared in CROSS_PLATFORM_INTERCHANGES.
    """
    root = _load('mile_end.xml')
    areas, _ = parser.collect_platform_areas(root)

    central_areas = [a for a, lines in areas.items() if 'Central' in lines]
    district_areas = [a for a, lines in areas.items() if 'District' in lines]
    assert central_areas, 'Expected Central platforms at Mile End'
    assert district_areas, 'Expected District platforms at Mile End'

    # The footpath between Central and District should be ≤ 3 min,
    # reflecting the cross-platform proximity.
    pairs, _ = parser.parse_pairs_from_xml(root)
    central_district = pairs.get('Central|District')
    assert central_district is not None
    assert central_district <= 3, (
        f'Mile End Central↔District should be a short walk; got {central_district}'
    )


# ── Uxbridge ─────────────────────────────────────────────────────────────


def test_uxbridge_shared_terminus_platform():
    """At Uxbridge both Metropolitan and Piccadilly terminate on the same
    single island platform — no footpath between lines is needed."""
    root = _load('uxbridge.xml')
    areas, _ = parser.collect_platform_areas(root)

    # Exactly one platform area carries both Met and Pic.
    shared = [a for a, lines in areas.items()
              if {'Metropolitan', 'Piccadilly'} <= lines]
    assert len(shared) >= 1, (
        'Expected Uxbridge to have a shared Met+Pic platform area'
    )


# ── Edgware Road ─────────────────────────────────────────────────────────


def test_edgware_road_via_naptan_returns_cross_line_footpaths():
    """The ICS query for Edgware Road (which is really Baker Street's ICS)
    doesn't include the Bakerloo↔Circle footpath. The NaPTAN ERC query
    does — and this test guards against regression if TfL ever changes
    the response format.
    """
    root = _load('edgware_road_erc.xml')
    allowed = overrides.ALLOWED_GIDS['Edgware Road']
    pairs, _ = parser.parse_pairs_from_xml(root, allowed)

    # Bakerloo↔Circle (and H&C, District) at Edgware Road is the famous
    # cross-street walk between two separate buildings.
    assert pairs.get('Bakerloo|Circle') is not None
    assert pairs.get('Bakerloo|Circle') >= 5


# ── Filtering ────────────────────────────────────────────────────────────


def test_filter_to_game_lines_drops_unrelated_pairs():
    """The filter should drop pairs whose lines aren't both in the
    station's NETWORK line set."""
    pairs = {
        'Circle|District': 2,
        'Central|Circle': 5,  # Central doesn't serve Westminster
        'Jubilee|Circle': 4,
    }
    station_lines = {'Circle', 'District', 'Jubilee'}
    filtered = parser.filter_to_game_lines(pairs, station_lines)

    assert 'Circle|District' in filtered
    assert 'Central|Circle' not in filtered
    assert 'Jubilee|Circle' in filtered


def test_filter_to_game_lines_handles_empty_set():
    """If station_lines is empty (station not in NETWORK), nothing passes."""
    pairs = {'Circle|District': 2}
    assert parser.filter_to_game_lines(pairs, set()) == {}


# ── Cross-platform interchange application ───────────────────────────────


def test_apply_cross_platform_interchanges_adds_1_min_pairs():
    pairs = {'Circle|District': 4}  # API says 4 min for the East/West-bound walk
    decls = [frozenset({'Circle', 'District'})]
    station_lines = {'Circle', 'District'}
    out = parser.apply_cross_platform_interchanges(pairs, decls, station_lines)
    assert out['Circle|District'] == 1


def test_apply_cross_platform_interchanges_respects_network():
    """If the declared lines don't serve this station, the rule is silently
    skipped — defends against stale declarations after a NETWORK change."""
    decls = [frozenset({'Circle', 'District'})]
    station_lines = {'Circle'}  # District removed from this station
    out = parser.apply_cross_platform_interchanges({}, decls, station_lines)
    assert out == {}


def test_apply_cross_platform_interchanges_doesnt_override_lower():
    """If the API found a lower value (shouldn't happen but theoretically
    could be 0 via misconfig), don't raise it back to 1."""
    pairs = {'Circle|District': 0}
    decls = [frozenset({'Circle', 'District'})]
    out = parser.apply_cross_platform_interchanges(pairs, decls, {'Circle', 'District'})
    assert out['Circle|District'] == 0


# ── Merge ────────────────────────────────────────────────────────────────


def test_merge_minimums():
    d1 = {'A|B': 5, 'C|D': 3}
    d2 = {'A|B': 7, 'E|F': 2}
    d3 = {'A|B': 4}
    merged = parser.merge_minimums(d1, d2, d3)
    assert merged == {'A|B': 4, 'C|D': 3, 'E|F': 2}


# ── Same-line pairs ──────────────────────────────────────────────────────


def test_same_line_pairs_can_be_emitted_by_parser():
    """The parser emits X|X pairs when the API has footpaths between two
    platforms that both serve line X. The CLI later filters these to keep
    only the ones declared in the game (branch splits like Whitechapel
    Elizabeth↔Elizabeth)."""
    # Baker Street has two Bakerloo platforms (areas 2 and 3 of LUERB),
    # so the API emits a Bakerloo|Bakerloo footpath. The parser should
    # NOT drop it — that's the CLI's job.
    root = _load('baker_street.xml')
    allowed = overrides.ALLOWED_GIDS['Baker Street']
    pairs, _ = parser.parse_pairs_from_xml(root, allowed)
    assert 'Bakerloo|Bakerloo' in pairs, (
        'Parser should pass through same-line pairs for the CLI to filter'
    )


def test_filter_same_line_to_game_pairs_keeps_declared():
    """X|X pairs declared in the game (branch splits) are kept."""
    pair_mins = {
        'Central|Central': 3,           # game has it (branch split)
        'Elizabeth|Elizabeth': 4,       # game does NOT have it
        'Central|Northern': 5,          # cross-line, always kept
    }
    game_pairs = {'Central|Central', 'Central|Northern'}
    out = parser.filter_same_line_to_game_pairs(pair_mins, game_pairs)
    assert out == {'Central|Central': 3, 'Central|Northern': 5}


def test_filter_same_line_to_game_pairs_cross_line_unaffected():
    """Cross-line pairs (X|Y, X != Y) are always kept regardless of game."""
    pair_mins = {'Circle|District': 4}
    out = parser.filter_same_line_to_game_pairs(pair_mins, set())
    assert out == {'Circle|District': 4}


# ── Unknown symbols ──────────────────────────────────────────────────────


def test_unknown_symbols_surface():
    """Build a tiny XML with a fake unknown line symbol; the parser should
    report it via the unknown_symbols return so we never silently drop it."""
    xml = '''<?xml version="1.0"?>
    <root>
      <stopAreaLines>
        <stopArea areaType="81">
          <itdPoint area="1" gid="940GTEST"/>
        </stopArea>
        <itdServingLine symbol="ZZZ"/>
      </stopAreaLines>
    </root>'''
    root = ET.fromstring(xml)
    _, unknown = parser.collect_platform_areas(root)
    assert 'ZZZ' in unknown
