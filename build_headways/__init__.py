"""Build per-edge wait times (half-headway) from TfL data.

Output: wait_times.js — a `const WAIT_MINS = {...}` table keyed by
`from|to|line` where `line` is the branch-qualified line ID used in
NETWORK (e.g. 'Northern_Bank_to_High_Barnet').

For Tube lines we use /Line/{id}/Timetable/{naptan} which returns the
full day's schedule. We filter to Monday-Friday off-peak (10:00-15:00)
and compute mean headway over consecutive departures.

For Overground/DLR/Elizabeth we use /Journey/JourneyResults with a
future Tuesday 12:00 query, advancing the time across calls to collect
5 consecutive departures on the line of interest.

The output covers only edges *out of interchange stations* — the first
adjacent hop after a line change. Mid-line edges have no wait because
the player is already on the train.
"""
