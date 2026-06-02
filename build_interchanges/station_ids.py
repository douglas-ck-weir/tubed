"""Resolve game station names to ICS codes for the TfL Stop Structure API.

Two sources:
1. STATION_QUERIES in overrides.py — explicit ICS codes for complex stations.
2. /StopPoint/Mode/tube — bulk lookup of all tube StopPoints, which include
   `commonName` (matches game station names after suffix stripping) and
   `icsCode`.

ICS codes are the documented-stable identifier for the Stop Structure API.
NaPTAN GIDs are NOT guaranteed to work (see TfL forum thread on
940GZZLUWLO). This module always returns ICS codes, never NaPTAN.

The CSV at data/station_codes.csv provides NaPTAN codes (only) as a backup
data source — useful for stations missing from the live tube StopPoint list
(e.g. Overground-only stations). We use it to look up the NaPTAN when needed,
then resolve to ICS via the live API.
"""

import csv
import logging
import re
from pathlib import Path
from typing import Dict, List, Optional

from .overrides import STATION_QUERIES
from .tfl_api import TflClient


logger = logging.getLogger(__name__)


CSV_PATH = Path(__file__).parent / 'data' / 'station_codes.csv'


def load_csv_naptan_map() -> Dict[str, str]:
    """Load CSV → {commonName: naptan_gid}.

    Format per row: short_code,?,common_name,naptan,postcode
    Lines where naptan is empty/NULL are skipped.
    """
    out: Dict[str, str] = {}
    with CSV_PATH.open() as f:
        for row in csv.reader(f):
            if len(row) < 4:
                continue
            _, _, name, naptan = row[0], row[1], row[2], row[3]
            if not naptan or naptan == 'NULL':
                continue
            if not (naptan.startswith('940G') or naptan.startswith('910G')):
                continue
            out[name.strip()] = naptan.strip()
    return out


def resolve_station_ics(
    game_stations: List[str],
    client: TflClient,
) -> Dict[str, List[str]]:
    """Map game station names → list of ICS codes to query.

    Stations in STATION_QUERIES use their declared ICS codes directly.
    Other stations are looked up via /StopPoint/Mode/tube (commonName match).
    Stations not found are reported but not failed — the caller decides
    whether to abort.

    Returns {station: [ics_code, ...]}.
    """
    result: Dict[str, List[str]] = {}

    # 1. Declared overrides take priority.
    for stn, ics_list in STATION_QUERIES.items():
        if stn in game_stations:
            result[stn] = list(ics_list)

    remaining = [s for s in game_stations if s not in result]
    if not remaining:
        return result

    # 2. Bulk lookup via /StopPoint/Mode/tube.
    logger.info('Fetching /StopPoint/Mode/tube for ICS resolution...')
    stops = client.get_tube_stop_points()

    name_to_ics: Dict[str, str] = {}
    for s in stops:
        if not s.get('naptanId', '').startswith('940G'):
            continue
        ics = s.get('icsCode', '')
        if not ics:
            continue
        # commonName is e.g. "Baker Street Underground Station"; strip suffix.
        name = re.sub(r'\s+Underground Station$', '',
                      s.get('commonName', ''), flags=re.IGNORECASE)
        name_to_ics[name] = ics

    # Case-sensitive match first, then case-insensitive fallback.
    lower_to_orig = {k.lower(): k for k in name_to_ics}
    unresolved: List[str] = []
    for stn in remaining:
        if stn in name_to_ics:
            result[stn] = [name_to_ics[stn]]
        elif stn.lower() in lower_to_orig:
            result[stn] = [name_to_ics[lower_to_orig[stn.lower()]]]
        else:
            unresolved.append(stn)

    if unresolved:
        logger.warning(
            'Could not resolve ICS code for %d station(s): %s',
            len(unresolved), ', '.join(sorted(unresolved)),
        )
        # Try the CSV → NaPTAN → ICS path as a last resort.
        csv_map = load_csv_naptan_map()
        for stn in unresolved:
            naptan = csv_map.get(stn)
            if not naptan:
                logger.error('No CSV NaPTAN for %s — station will be skipped', stn)
                continue
            ics = client.get_ics_code(naptan)
            if ics:
                logger.info('Resolved %s via CSV→NaPTAN→ICS: %s → %s',
                            stn, naptan, ics)
                result[stn] = [ics]
            else:
                logger.error('CSV NaPTAN %s for %s did not resolve to an ICS',
                             naptan, stn)

    return result


def validate_ics_resolution(
    game_stations: List[str],
    resolved: Dict[str, List[str]],
) -> List[str]:
    """Return a list of stations missing from `resolved`, for fail-loud checks."""
    return [s for s in game_stations if s not in resolved]
