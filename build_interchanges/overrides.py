"""Per-station declarations: GID filters, cross-platform pairs, manual overrides.

This module is the *only* place where human judgement enters the pipeline.
Every entry is auditable: grep for a station name and you see exactly what
the script does differently for it.

Conventions
-----------
* Station names match the keys in the game's NETWORK and INTERCHANGE_MINS.
* Line names match the values in symbols.py SYMBOL_TO_LINE.
* Line pairs are stored 'A|B' alphabetically sorted.

Three dicts:

STATION_QUERIES
    Stations that need explicit stop ID queries. Each value lists ICS codes.
    NaPTAN GIDs (940G… / 910G…) must NOT be used as query IDs — TfL only
    guarantees ICS codes work with the Stop Structure API (see TfL forum
    thread: NaPTAN 940GZZLUWLO for Waterloo returns empty). NaPTAN codes
    appear in ALLOWED_GIDS for filtering, not querying.

ALLOWED_GIDS
    Per-station whitelist of NaPTAN/areaGid values for footpath endpoints.
    Used to prevent cross-station bleed-in when an ICS query returns areas
    from neighbouring stations (e.g. Edgware Road's ICS returning Baker
    Street platforms). Empty / missing entry → no filtering.

CROSS_PLATFORM_INTERCHANGES
    Stations where two or more game lines share the same physical platform,
    making the inter-line change effectively zero walking time (1 minute).
    Each entry is a list of frozensets of line names — every pair drawn
    from the set gets a 1-min interchange. Auditable: every 1-min same-
    platform pair is a deliberate declaration here, not an API inference.

MANUAL_OVERRIDES
    Last-resort manual values for pairs the API genuinely cannot model
    (e.g. cross-mode interchanges via OSIs, Lioness at Euston). The build
    fails loudly if the game has a pair the API didn't return and it's
    not declared here.
"""

from typing import Dict, FrozenSet, List, Set


# Stations needing explicit ICS codes. Format: {station: [ics_code, ...]}.
# Only ICS codes (numeric strings) — NEVER NaPTAN GIDs — per TfL API thread.
# When a station has platforms across multiple ICS codes (Canary Wharf has
# three separate buildings), list all of them. Results are merged taking the
# minimum duration per line pair.
STATION_QUERIES: Dict[str, List[str]] = {
    # Bank and Monument share an ICS (treated as one station by TfL).
    'Bank':                    ['1000013'],
    'Monument':                ['1000013'],
    # Canary Wharf: three physically separate buildings.
    # 1000038 = Jubilee, 1002163 = Elizabeth, 1003008 = DLR.
    'Canary Wharf':            ['1000038', '1002163', '1003008'],
    'Custom House for ExCel':  ['1001079'],
    # Edgware Road: ICS 1000071 (Bakerloo) and 1000072 (Circle) both return
    # the Baker Street stop family per TfL's ICS hierarchy. Querying that
    # gives us the platform line data but NOT the Edgware-Road-specific
    # cross-line footpaths (Bakerloo ↔ Circle/District/H&C). For those, we
    # additionally query the ERC NaPTAN directly. This is technically
    # undocumented per the TfL forum thread on 940GZZLUWLO, so the API
    # client raises EmptyStopStructureError if the response is empty and
    # we surface that loudly rather than silently producing wrong data.
    'Edgware Road':            ['1000011', '940GZZLUERC'],
    # Hammersmith: two physically separate stations (District/Pic + H&C/Circle).
    'Hammersmith':             ['1000096', '1000097'],
    'Harrow on the Hill':      ['1000102'],
    'Heathrow Terminals 2&3':  ['1000105'],
    'Kings Cross St. Pancras': ['1000129'],
    # Paddington: ICS 1000174 covers LU Bakerloo/Circle/District/H&C/Eliz
    # but does NOT include footpaths between H&C and Elizabeth. Query
    # 910GPADTON (NaPTAN) as a secondary source for those footpaths.
    'Paddington':              ['1000174', '910GPADTON'],
    'Romford':                 ['1001243'],
    # South Kenton: ICS 1000213 returns the Bakerloo + Lioness interchange.
    'South Kenton':            ['1000213'],
    'Stratford':               ['1000226'],
    'Watford High Street':     ['1001316'],
    'Woolwich Arsenal':        ['1001344'],
}


# Per-station GID whitelist. Footpaths are kept only if BOTH endpoints'
# `gid` attribute is in the set. Values are NaPTAN identifiers as they
# appear in the API's `gid` attribute.
ALLOWED_GIDS: Dict[str, Set[str]] = {
    'Baker Street': {
        '940GZZLUBST',   # Bakerloo + Jubilee + Metropolitan
        '940GZZLUERB',   # Edgware Road Bakerloo (appears in Baker St family)
        '940GZZLUERC',   # Edgware Road Circle (appears in Baker St family)
    },
    'Bank': {'940GZZDLBNK', '940GZZLUMMT'},
    'Monument': {'940GZZDLBNK', '940GZZLUMMT'},
    'Bond Street': {'940GZZLUBND'},
    'Canary Wharf': {'940GZZLUCYF', '910GCANWHRF', '940GZZDLCAN'},
    'Euston': {'910GEUSTON'},
    'Liverpool Street': {'940GZZLULVT'},
    'Aldgate East': {'940GZZLUADE'},
    'Paddington': {
        '940GZZLUPAC',   # Bakerloo + Circle + District
        '940GZZLUPAH',   # H&C
        '910GPADTON',    # Elizabeth
    },
    'Bow Road': {'940GZZLUBWR'},
    'Mansion House': {'940GZZLUMSH'},
    'Hammersmith': {
        '940GZZLUHSD',   # District + Piccadilly station
        '940GZZLUHSC',   # H&C + Circle station (separate building)
    },
    'Edgware Road': {
        '940GZZLUERB',   # Bakerloo
        '940GZZLUERC',   # Circle/District/H&C
    },
    # South Kenton: Bakerloo + Overground (Lioness). NR GID returns the
    # interchange data; LU NaPTAN doesn't exist as a separate stop.
    'South Kenton': {'910GSKENTON'},
}


# Stations where lines share the same physical platform → 1-minute interchange.
# Every pair drawn from each frozenset gets a 1-min value (only added if the
# API didn't return a smaller value, which shouldn't happen but is safe).
#
# This replaces an earlier inferred rule ("if two lines appear in the same
# platform area's symbol set, emit 1 min"). The inferred rule produced
# correct values at sub-surface stations like Westminster but was hard to
# audit and dependent on TfL's serving-line enumeration staying consistent.
# Explicit declarations are auditable per-station.
#
# Rule of thumb: include a station here ONLY if you've personally confirmed
# from the TfL map or signage that the lines genuinely share the platform
# (cross-platform interchange, same train approach).
CROSS_PLATFORM_INTERCHANGES: Dict[str, List[FrozenSet[str]]] = {
    # Sub-surface Circle/District shared platforms (eastbound and westbound
    # platforms each carry both lines).
    'Blackfriars':           [frozenset({'Circle', 'District'})],
    'Cannon Street':         [frozenset({'Circle', 'District'})],
    'Embankment':            [frozenset({'Circle', 'District'})],
    'Gloucester Road':       [frozenset({'Circle', 'District'})],
    'High Street Kensington':[frozenset({'Circle', 'District'})],
    'Mansion House':         [frozenset({'Circle', 'District'})],
    'Monument':              [frozenset({'Circle', 'District'})],
    'Notting Hill Gate':     [frozenset({'Circle', 'District'})],
    "St. James's Park":      [frozenset({'Circle', 'District'})],
    'Sloane Square':         [frozenset({'Circle', 'District'})],
    'Temple':                [frozenset({'Circle', 'District'})],
    'Tower Hill':            [frozenset({'Circle', 'District'})],
    'Victoria':              [frozenset({'Circle', 'District'})],
    'Westminster':           [frozenset({'Circle', 'District'})],

    # Sub-surface Circle/H&C shared platforms.
    'Baker Street':          [frozenset({'Circle', 'Hammersmith & City'})],
    'Goldhawk Road':         [frozenset({'Circle', 'Hammersmith & City'})],
    'Ladbroke Grove':        [frozenset({'Circle', 'Hammersmith & City'})],
    'Latimer Road':          [frozenset({'Circle', 'Hammersmith & City'})],
    'Royal Oak':             [frozenset({'Circle', 'Hammersmith & City'})],
    "Shepherd's Bush Market":[frozenset({'Circle', 'Hammersmith & City'})],
    'Westbourne Park':       [frozenset({'Circle', 'Hammersmith & City'})],
    'Wood Lane':             [frozenset({'Circle', 'Hammersmith & City'})],

    # Sub-surface Circle/H&C/Metropolitan triple shared.
    'Aldgate East':          [frozenset({'District', 'Hammersmith & City'})],
    'Barbican':              [frozenset({'Circle', 'Hammersmith & City', 'Metropolitan'})],
    'Euston Square':         [frozenset({'Circle', 'Hammersmith & City', 'Metropolitan'})],
    'Farringdon':            [frozenset({'Circle', 'Hammersmith & City', 'Metropolitan'})],
    'Great Portland Street': [frozenset({'Circle', 'Hammersmith & City', 'Metropolitan'})],
    'Kings Cross St. Pancras': [frozenset({'Circle', 'Hammersmith & City', 'Metropolitan'})],
    'Liverpool Street':      [frozenset({'Circle', 'Hammersmith & City', 'Metropolitan'})],
    'Moorgate':              [frozenset({'Circle', 'Hammersmith & City', 'Metropolitan'})],

    # Other Circle/District same-platform stations not in the earlier list.
    'South Kensington':      [frozenset({'Circle', 'District'})],

    # Aldgate: Circle terminates on Metropolitan's platforms.
    'Aldgate':               [frozenset({'Circle', 'Metropolitan'})],

    # Other District-family shared platforms.
    'Bow Road':              [frozenset({'District', 'Hammersmith & City'})],
    'Bromley-by-Bow':        [frozenset({'District', 'Hammersmith & City'})],
    'Stepney Green':         [frozenset({'District', 'Hammersmith & City'})],
    'Mile End':              [frozenset({'Central', 'District'}),
                              frozenset({'Central', 'Hammersmith & City'}),
                              frozenset({'District', 'Hammersmith & City'})],
    'West Ham':              [frozenset({'District', 'Hammersmith & City'})],

    # Hammersmith (D/Pic station): District and Piccadilly share platforms.
    'Hammersmith':           [frozenset({'District', 'Piccadilly'})],

    # Northern/Picadilly outer Met branches sharing platforms with Met.
    'Eastcote':              [frozenset({'Metropolitan', 'Piccadilly'})],
    'Hillingdon':            [frozenset({'Metropolitan', 'Piccadilly'})],
    'Ickenham':              [frozenset({'Metropolitan', 'Piccadilly'})],
    'Rayners Lane':          [frozenset({'Metropolitan', 'Piccadilly'})],
    'Ruislip Manor':         [frozenset({'Metropolitan', 'Piccadilly'})],
    'Uxbridge':              [frozenset({'Metropolitan', 'Piccadilly'})],

    # District/Piccadilly cross-platform on the Heathrow branch.
    'Acton Town':            [frozenset({'District', 'Piccadilly'})],
    'Barons Court':          [frozenset({'District', 'Piccadilly'})],

    # Finsbury Park: Piccadilly/Victoria cross-platform.
    'Finsbury Park':         [frozenset({'Piccadilly', 'Victoria'})],

    # Canning Town: DLR/Jubilee cross-platform.
    'Canning Town':          [frozenset({'DLR', 'Jubilee'})],

    # Paddington: Circle terminates on H&C platforms at the H&C station,
    # and Circle/District share the sub-surface platforms at the LU station.
    'Paddington':            [frozenset({'Circle', 'District'}),
                              frozenset({'Circle', 'Hammersmith & City'})],

    # Edgware Road (Circle): Circle/District/H&C all share platforms here.
    'Edgware Road':          [frozenset({'Circle', 'District', 'Hammersmith & City'})],

    # Earl's Court: District services cross-platform interchange.
    "Earl's Court":          [frozenset({'District', 'Piccadilly'})],

    # Ealing Broadway: Central/District cross-platform.
    'Ealing Broadway':       [frozenset({'Central', 'District'})],
}


# Stations that share an interchange complex but are modelled as separate
# stations in NETWORK. INTERCHANGE_MINS entries for ANY of these stations
# include cross-line pairs spanning the combined line set, copied to both.
# Bank/Monument is the classic example: physically one complex, but the
# game's NETWORK gives Bank the deep lines and Monument the sub-surface
# lines so the pathfinder treats the cross-walk as a station transition.
LINKED_STATIONS: List[FrozenSet[str]] = [
    frozenset({'Bank', 'Monument'}),
]


# Manual values for pairs the API genuinely cannot model. Indexed by
# (station, sorted_pair). Used as the source of truth when the API doesn't
# emit a value AND the pair is expected to exist in the game.
#
# Each entry MUST include a `reason` comment explaining why the API can't
# provide this value, so a future maintainer can re-evaluate.
MANUAL_OVERRIDES: Dict[str, Dict[str, int]] = {
    # Lioness (London Overground) at Euston is not in the tube Stop
    # Structure data; the Overground station is modelled separately from
    # the LU station and footpaths between them aren't emitted.
    'Euston': {
        'Lioness|Northern': 10,
        'Lioness|Victoria': 9,
    },
    # Piccadilly Circus ↔ Lioness via Charing Cross NR station — OSI, not
    # a same-station interchange, but the game treats it as one.
    'Piccadilly Circus': {
        'Bakerloo|Lioness': 5,
    },
    # Ealing Broadway: Piccadilly does not stop at Ealing Broadway but the
    # game retains it (likely via Acton Town OSI). Keep existing value.
    'Ealing Broadway': {
        'District|Piccadilly': 3,
    },
    # Watford High Street: Metropolitan is at a different physical station
    # (Watford Met) — this is an OSI in reality, but the game records it
    # as a same-station interchange. Keep existing value.
    'Watford High Street': {
        'Lioness|Metropolitan': 4,
    },
    # Heathrow Terminals 2&3: Elizabeth↔Elizabeth branch-split between T4
    # and T5 services. The API merges both Elizabeth services into a
    # single platform area, so no footpath is emitted, but the game
    # correctly models the cross-service wait.
    'Heathrow Terminals 2&3': {
        'Elizabeth|Elizabeth': 1,
    },
    # Paddington: TfL Stop Structure API returns walk times computed via
    # the mainline concourse route (Circle|Elizabeth: 16, District|
    # Elizabeth: 18). Reality is shorter — the Circle/District sub-surface
    # subway leads directly to the Elizabeth ticket hall in ~10 min.
    # Player-verified via feedback July 2026. Circle and District share
    # the sub-surface platforms so both pairs get the same value.
    'Paddington': {
        'Circle|Elizabeth': 10,
        'District|Elizabeth': 10,
    },
}


def validate(network: Dict[str, Set[str]]) -> List[str]:
    """Validate that every declared station and line actually exists in the
    game NETWORK. Returns a list of error messages (empty if all OK).
    """
    errors: List[str] = []
    from .symbols import ALL_DISPLAY_LINES

    for stn, line_groups in CROSS_PLATFORM_INTERCHANGES.items():
        if stn not in network:
            errors.append(f"CROSS_PLATFORM_INTERCHANGES: unknown station {stn!r}")
            continue
        stn_lines = network[stn]
        for group in line_groups:
            for line in group:
                if line not in ALL_DISPLAY_LINES:
                    errors.append(
                        f"CROSS_PLATFORM_INTERCHANGES[{stn!r}]: "
                        f"unknown display line {line!r}"
                    )
                elif line not in stn_lines:
                    errors.append(
                        f"CROSS_PLATFORM_INTERCHANGES[{stn!r}]: line "
                        f"{line!r} doesn't serve this station per NETWORK"
                    )

    for stn, pairs in MANUAL_OVERRIDES.items():
        if stn not in network:
            errors.append(f"MANUAL_OVERRIDES: unknown station {stn!r}")
            continue
        for pair in pairs:
            parts = pair.split('|')
            # Pairs must be 'A|B' with A <= B alphabetically. Same-line
            # branch-split pairs (e.g. Elizabeth|Elizabeth) use A == B.
            if len(parts) != 2 or parts[0] > parts[1]:
                errors.append(
                    f"MANUAL_OVERRIDES[{stn!r}]: pair {pair!r} must be "
                    f"'A|B' with A <= B alphabetically"
                )

    return errors
