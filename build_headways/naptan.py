"""Resolve game station names to NaPTAN IDs per TfL mode.

Many London stations have separate platforms for different modes (Tube,
Rail, DLR, Elizabeth) with distinct NaPTANs. The local CSV is often
wrong (it maps the rail NaPTAN to a tube-station name), so we query
/StopPoint/Search?query={name}&modes={mode} per (station, mode) and
cache the results on disk.

The lookup order for resolve_naptan(name, mode):
  1. LINE_SPECIFIC_NAPTAN[(name, tfl_line_id)] — manual per-line overrides
     for split-site stations (Hammersmith H&C vs District, etc.)
  2. /StopPoint/Search?query={name}&modes={mode_filter} — preferring
     mode-matching results, including HUB IDs.
  3. MANUAL_NAPTAN[name] — last-resort hand fixes.
"""

import csv
import logging
import re
from pathlib import Path
from typing import Dict, Optional

from .tfl_api import TflClient


logger = logging.getLogger(__name__)


CSV_PATH = (
    Path(__file__).parent.parent / 'build_interchanges' / 'data' / 'station_codes.csv'
)


# TfL line ID -> mode filter passed to /StopPoint/Search?modes=...
TUBE_LINES = {'bakerloo', 'central', 'circle', 'district', 'hammersmith-city',
              'jubilee', 'metropolitan', 'northern', 'piccadilly', 'victoria',
              'waterloo-city'}


def _modes_for_line(tfl_line: Optional[str]) -> str:
    if tfl_line is None:
        return 'tube,overground,dlr,elizabeth-line'
    if tfl_line in TUBE_LINES:
        return 'tube'
    if tfl_line in {'lioness', 'mildmay', 'windrush', 'weaver',
                    'suffragette', 'liberty'}:
        return 'overground'
    if tfl_line == 'dlr':
        return 'dlr'
    if tfl_line == 'elizabeth':
        return 'elizabeth-line'
    return 'tube,overground,dlr,elizabeth-line'


# Manual overrides for stations the CSV gets wrong or doesn't have.
# Keyed by game station name → NaPTAN.
MANUAL_NAPTAN = {
    "King's Cross St. Pancras":  '940GZZLUKSX',
    'Kings Cross St. Pancras':   '940GZZLUKSX',
    'Heathrow Terminals 2 & 3':  'HUBH13',
    'Heathrow Terminals 2&3':    'HUBH13',
    'Heathrow Terminal 4':       '940GZZLUHR4',
    'Heathrow Terminal 5':       '940GZZLUHR5',
    'Paddington':                '940GZZLUPAC',  # Bakerloo/Circle/District
    "Shepherd's Bush":           '940GZZLUSBC',  # Central
    "Shepherd's Bush Market":    '940GZZLUSBM',  # H&C
    'Wood Lane':                 '940GZZLUWLA',
    'White City':                '940GZZLUWCY',
    'Bank':                      '940GZZLUBNK',
    'Monument':                  '940GZZLUMTC',
    'Waterloo':                  '940GZZLUWLO',
    'Bermondsey':                '940GZZLUBMY',
    'Canary Wharf':              '940GZZLUCYF',
    'Canada Water':              '940GZZLUCWR',
    'Canning Town':              '940GZZLUCGT',
    'West Ham':                  '940GZZLUWHM',
    'Stratford':                 '940GZZLUSTD',  # default to Tube; per-line overrides below
    # Hub IDs for stations without a 940G/910G entry in the CSV.
    'Custom House for ExCel':    'HUBCUS',
    'Custom House':              'HUBCUS',
    "Shepherd's Bush (Overground)": '910GSHPDSB',
    'Woolwich Arsenal':          'HUBWWA',
    'Hayes & Harlington':        '910GHAYESAH',
    'Kensington (Olympia)':      '940GZZLUKOY',
    'Shadwell (Overground)':     '910GSHADWEL',
    'Bethnal Green (Overground)':'910GBTHNLGR',
    'Seven Sisters (Overground)':'910GSVNSIS',
    'Blackhorse Road (Overground)': '910GBLKHRSR',
}


# Per-(station, tfl_line_id) NaPTAN overrides. Some stations have separate
# physical platforms with distinct NaPTANs depending on which line you board.
# E.g. Hammersmith's H&C platforms (940GZZLUHSC) are a different building from
# the Piccadilly/District platforms (940GZZLUHSD). When this map has an entry
# for a (name, line) pair, use it in preference to MANUAL_NAPTAN / CSV.
LINE_SPECIFIC_NAPTAN = {
    ('Hammersmith', 'hammersmith-city'):    '940GZZLUHSC',
    ('Hammersmith', 'circle'):              '940GZZLUHSC',
    ('Hammersmith', 'district'):            '940GZZLUHSD',
    ('Hammersmith', 'piccadilly'):          '940GZZLUHSD',
    ('Edgware Road', 'bakerloo'):           '940GZZLUERB',
    ('Edgware Road', 'circle'):             '940GZZLUERC',
    ('Edgware Road', 'district'):           '940GZZLUERC',
    ('Edgware Road', 'hammersmith-city'):   '940GZZLUERC',
    # Barbican's tube code (940G) is what /Line/.../Timetable needs; the CSV
    # has the rail code (910GBRBCNLT) which the tube endpoint rejects.
    ('Barbican', 'circle'):                 '940GZZLUBBN',
    ('Barbican', 'hammersmith-city'):       '940GZZLUBBN',
    ('Barbican', 'metropolitan'):           '940GZZLUBBN',
    # Stratford for non-tube modes wants the multi-modal hub ID.
    ('Stratford', 'elizabeth'):             '910GSTFD',  # Elizabeth at rail station
    ('Stratford', 'dlr'):                   '940GZZDLSTD',
    ('Stratford', 'mildmay'):               '910GSTFD',  # rail NaPTAN works for Mildmay JR
    ('Stratford', 'central'):               '940GZZLUSTD',
    ('Stratford', 'jubilee'):               '940GZZLUSTD',
    # Paddington's H&C platforms are a separate NaPTAN from the main Bakerloo/
    # Circle/District platforms.
    ('Paddington', 'hammersmith-city'):     '940GZZLUPAH',
    # Canary Wharf has per-mode NaPTANs: tube, Elizabeth, DLR are separate buildings.
    ('Canary Wharf', 'elizabeth'):          '910GCANWHRF',
    ('Canary Wharf', 'dlr'):                '940GZZDLCAN',
    ('Canary Wharf', 'jubilee'):            '940GZZLUCYF',
    # Custom House (for ExCel) has per-mode NaPTANs.
    ('Custom House for ExCel', 'elizabeth'): '910GCUSTMHS',
    ('Custom House for ExCel', 'dlr'):      '940GZZDLCUS',
    ('Custom House', 'elizabeth'):          '910GCUSTMHS',
    ('Custom House', 'dlr'):                '940GZZDLCUS',
    # Woolwich Arsenal has per-mode NaPTANs.
    ('Woolwich Arsenal', 'elizabeth'):      '910GWOLWXR',
    ('Woolwich Arsenal', 'dlr'):            '940GZZDLWLA',
}


def _normalize_name(name: str) -> str:
    """Strip suffixes like 'Underground Station', 'Rail Station' for matching."""
    n = name.strip()
    for suffix in (
        ' Underground Station',
        ' Rail Station',
        ' DLR Station',
        ' (London)',
    ):
        if n.endswith(suffix):
            n = n[: -len(suffix)]
    return n.strip()


def load_csv_naptan_map() -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not CSV_PATH.exists():
        logger.warning('CSV missing: %s', CSV_PATH)
        return out
    with CSV_PATH.open() as f:
        for row in csv.reader(f):
            if len(row) < 4:
                continue
            name = row[2].strip()
            naptan = row[3].strip()
            if not naptan or naptan == 'NULL':
                continue
            if not (naptan.startswith('940G') or naptan.startswith('910G')):
                continue
            out[name] = naptan
    return out


def _accept_hub_or_naptan(stop_id: str) -> bool:
    return stop_id.startswith('940G') or stop_id.startswith('910G') or stop_id.startswith('HUB')


def _drill_hub(hub_id: str, modes_filter: str, client: TflClient) -> Optional[str]:
    """Given a HUB id, fetch its children and return the first child NaPTAN
    whose modes intersect with `modes_filter` (comma-separated)."""
    wanted = set(modes_filter.split(','))
    try:
        data = client._get(f'/StopPoint/{hub_id}', f'sp_hub_{hub_id}')
    except Exception as e:
        logger.warning('HUB drill failed for %s: %s', hub_id, e)
        return None
    # Prefer 940G (tube), then 940GZZDL (DLR), then 910G (rail/elizabeth)
    candidates_940 = []
    candidates_910 = []
    for c in data.get('children', []):
        cid = c.get('id', '')
        cmodes = set(c.get('modes', []))
        if not (cmodes & wanted):
            continue
        if cid.startswith('940G'):
            candidates_940.append(cid)
        elif cid.startswith('910G'):
            candidates_910.append(cid)
    if candidates_940:
        return candidates_940[0]
    if candidates_910:
        return candidates_910[0]
    return None


def resolve_naptan(
    name: str,
    csv_map: Dict[str, str],
    client: Optional[TflClient] = None,
    tfl_line: Optional[str] = None,
) -> Optional[str]:
    """Return the best NaPTAN for `name` on `tfl_line`, or None.

    Lookup order:
      1. LINE_SPECIFIC_NAPTAN[(name, tfl_line)] — split-site overrides
      2. /StopPoint/Search?query=&modes={mode_filter} — mode-correct match
      3. MANUAL_NAPTAN[name] — last-resort hand fixes
      4. CSV — final fallback (often wrong; only used when API fails)
    """
    if tfl_line and (name, tfl_line) in LINE_SPECIFIC_NAPTAN:
        return LINE_SPECIFIC_NAPTAN[(name, tfl_line)]

    if client is not None:
        modes = _modes_for_line(tfl_line)
        # URL-encode the query (spaces & ampersands inside station names)
        from urllib.parse import quote
        try:
            data = client._get(
                f'/StopPoint/Search?query={quote(name)}&modes={modes}',
                f'sp_{quote(name)}_{modes}',
            )
            # Two-pass selection so we don't fall for prefix matches:
            # "Aldgate" search returns Aldgate East first, but we want
            # exactly Aldgate. Prefer matches whose `name` minus suffix
            # equals the queried name (case-insensitive); fall back to
            # the first specific match otherwise.
            target = _normalize_name(name).lower()
            exact_specific = None
            exact_hub = None
            best_specific = None
            best_hub = None
            for m in data.get('matches', []):
                stop_id = m.get('id', '')
                stop_name = _normalize_name(m.get('name', '')).lower()
                is_exact = (stop_name == target)
                if stop_id.startswith(('940G', '910G')):
                    if is_exact and exact_specific is None:
                        exact_specific = stop_id
                    elif best_specific is None:
                        best_specific = stop_id
                elif stop_id.startswith('HUB'):
                    if is_exact and exact_hub is None:
                        exact_hub = stop_id
                    elif best_hub is None:
                        best_hub = stop_id
            if exact_specific is not None:
                return exact_specific
            if exact_hub is not None:
                specific = _drill_hub(exact_hub, modes, client)
                if specific is not None:
                    return specific
                return exact_hub
            if best_specific is not None:
                return best_specific
            # No specific match — drill into the HUB's children to find the
            # right mode-specific NaPTAN.
            if best_hub is not None:
                specific = _drill_hub(best_hub, modes, client)
                if specific is not None:
                    return specific
                # If HUB has no child for this mode, returning the HUB itself
                # works for /Journey/JourneyResults but NOT /Line/.../Timetable.
                # Caller decides.
                return best_hub
        except Exception as e:
            logger.warning('Search failed for %s (modes=%s): %s', name, modes, e)

    if name in MANUAL_NAPTAN:
        return MANUAL_NAPTAN[name]

    norm = _normalize_name(name)
    if norm in csv_map:
        return csv_map[norm]
    simple = re.sub(r"[.'’]", '', norm).lower()
    for k, v in csv_map.items():
        if re.sub(r"[.'’]", '', k).lower() == simple:
            return v

    return None
