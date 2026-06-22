"""Headway computation: turn API responses into wait minutes.

Two paths:

* `headway_from_tube_timetable(timetable_json, line_name_filter=None)`
  For Tube lines: parse `knownJourneys` from the Mon–Fri off-peak window
  and return the mean gap between consecutive departures.

* `headway_from_journey_results(jr_json, line_name)`
  For non-Tube modes: filter journeys to those whose first leg is on
  `line_name`, then return the gap between consecutive departures.
"""

from datetime import datetime
from typing import List, Optional


OFFPEAK_START_HOUR = 10
OFFPEAK_END_HOUR = 15  # exclusive
WEEKDAY_SCHED_NAMES = {
    'Monday - Thursday',
    'Monday - Friday',
    'Friday',
}


def _is_weekday_offpeak_schedule(name: str) -> bool:
    return name in WEEKDAY_SCHED_NAMES


def _line_name_matches(api_name: str, display_name: str) -> bool:
    """TfL sometimes appends ' line' to the route name (Elizabeth line, Mildmay
    line). Accept either form."""
    if api_name == display_name:
        return True
    if api_name == f'{display_name} line':
        return True
    return False


def _route_serves_stop(route: dict, target_naptan: str) -> bool:
    """True if any of `route.stationIntervals[].intervals[]` visits target_naptan.

    Each TfL "route" is one direction of one service pattern; a station like
    Edgware Road that's a Circle teardrop pivot appears in BOTH directions,
    each as a separate route. Picking the route that reaches the target stop
    isolates the headway for the direction the passenger actually wants.
    """
    if not target_naptan:
        return False
    for si in route.get('stationIntervals', []):
        for interval in si.get('intervals', []):
            if interval.get('stopId') == target_naptan:
                return True
    return False


def _gaps_from_route(route: dict) -> List[float]:
    """Return Mon-Fri off-peak adjacent-departure gaps (minutes) for one route."""
    minutes_of_day: List[int] = []
    for sched in route.get('schedules', []):
        if not _is_weekday_offpeak_schedule(sched.get('name', '')):
            continue
        for j in sched.get('knownJourneys', []):
            try:
                h = int(j['hour'])
                m = int(j['minute'])
            except (KeyError, ValueError):
                continue
            if OFFPEAK_START_HOUR <= h < OFFPEAK_END_HOUR:
                minutes_of_day.append(h * 60 + m)
    if len(minutes_of_day) < 2:
        return []
    minutes_of_day.sort()
    return [
        minutes_of_day[i + 1] - minutes_of_day[i]
        for i in range(len(minutes_of_day) - 1)
        if 0 < minutes_of_day[i + 1] - minutes_of_day[i] < 60
    ]


def headway_from_tube_timetable(
    timetable_json: dict,
    target_naptan: Optional[str] = None,
) -> Optional[float]:
    """Mean off-peak headway in minutes from /Line/.../Timetable response.

    When `target_naptan` is given, restrict to routes whose service actually
    reaches that stop — important at teardrop pivots (Paddington / Edgware
    Road on Circle) where two opposite directions both appear and naively
    summing them doubles the apparent tph.

    Returns None if no usable data.
    """
    tt = timetable_json.get('timetable', {})
    routes = tt.get('routes', [])
    if not routes:
        return None

    # When target_naptan is given, prefer routes that serve it.
    if target_naptan:
        relevant = [r for r in routes if _route_serves_stop(r, target_naptan)]
        if relevant:
            routes = relevant

    all_gaps: List[float] = []
    for route in routes:
        all_gaps.extend(_gaps_from_route(route))

    if not all_gaps:
        return None
    return sum(all_gaps) / len(all_gaps)


def line_departures_from_jr(jr_json: dict, line_name: str) -> List[datetime]:
    """Return the list of departure datetimes from one JR response,
    filtered to `line_name` and de-walked. Used by the polling loop."""
    out: List[datetime] = []
    for j in jr_json.get('journeys', []):
        leg_dep = None
        for leg in j.get('legs', []):
            if leg.get('mode', {}).get('name') == 'walking':
                continue
            opts = leg.get('routeOptions', [])
            ln = opts[0].get('name', '') if opts else ''
            if _line_name_matches(ln, line_name):
                leg_dep = leg.get('departureTime') or j.get('startDateTime')
                break
        if leg_dep is None:
            continue
        try:
            out.append(datetime.fromisoformat(leg_dep))
        except ValueError:
            continue
    return sorted(out)


def headway_from_journey_results(jr_json: dict, line_name: str) -> Optional[float]:
    """Mean headway from /Journey/JourneyResults response, filtered to `line_name`.

    `line_name` matches the `routeOptions[0].name` field, e.g.
    'Hammersmith & City', 'Mildmay', 'DLR'. TfL appends ' line' to
    'Elizabeth' so we match leniently on the leading word.
    """
    journeys = jr_json.get('journeys', [])
    times: List[datetime] = []
    for j in journeys:
        # Find the first non-walking leg on the line we care about and
        # use its departureTime — JR often inserts a walking leg from
        # the station entrance, which shares startDateTime with the
        # subsequent train leg but isn't the boarding moment we want.
        leg_dep = None
        for leg in j.get('legs', []):
            if leg.get('mode', {}).get('name') == 'walking':
                continue
            opts = leg.get('routeOptions', [])
            ln = opts[0].get('name', '') if opts else ''
            if _line_name_matches(ln, line_name):
                leg_dep = leg.get('departureTime') or j.get('startDateTime')
                break
        if leg_dep is None:
            continue
        try:
            times.append(datetime.fromisoformat(leg_dep))
        except ValueError:
            continue

    if len(times) < 2:
        return None

    times.sort()
    gaps = [(times[i + 1] - times[i]).total_seconds() / 60 for i in range(len(times) - 1)]
    gaps = [g for g in gaps if 0 < g < 60]
    if not gaps:
        return None
    return sum(gaps) / len(gaps)


def wait_minutes(headway: float) -> int:
    """Half-headway, rounded to the nearest minute, minimum 1."""
    return max(1, round(headway / 2))
