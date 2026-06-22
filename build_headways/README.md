# build_headways

Generates `wait_times.js` for Tubed - a table of per-edge half-headway wait
times in minutes, keyed by `(from_station, to_station, branch_line)`.

These values feed into Tubed's scorer: when the optimal-route finder (or the
user-route scorer) adds an interchange, it also adds the half-headway for
the next line. The numbers come from TfL's Unified API (off-peak weekday
schedules) so the optimal route reflects what a real Londoner would take,
not just walking time + travel time.

The generated file is inlined into `index.html` (search for
`const WAIT_MINS = `). The standalone `wait_times.js` is also written
alongside `index.html` for reference, but the inlined copy is the source
of truth the browser actually runs.

## Quick start

```bash
# Regenerate from cache (no API calls if cache is fresh)
python3 -m build_headways

# Force re-fetch from TfL API (slow; takes several minutes)
python3 -m build_headways --refresh

# Run validation only, don't rebuild
python3 -m build_headways --validate
```

No API key required - TfL Unified is public. No pip dependencies beyond
the Python stdlib.

## How it works

For each interchange edge in the NETWORK (an edge being a station + a
branch line going to a specific next stop, e.g.
`(Bank, London Bridge, Northern_Bank_to_High_Barnet)`), we compute the
expected half-headway in minutes.

Two data sources, picked per line type:

- **Tube lines** (11 of them): `/Line/{id}/Timetable/{naptan}` returns the
  full day's schedule. We filter to Monday-Friday 10:00-15:00 and
  compute the mean gap between consecutive departures, divided by 2.

- **Overground / DLR / Elizabeth**: `/Journey/JourneyResults/{from}/to/{to}`
  is polled with later times until we collect at least 5 same-line
  departures, then half the mean gap.

For a handful of edges where the API gives no usable answer (rush-hour-only
shuttles, off-peak skip-stops), there's a `MANUAL_WAIT_OVERRIDES` table
in `cli.py` with a value derived from the published frequency on the
station's TfL page.

## Cache

API responses go to `build_headways/cache/` (gitignored). The cache is
the source of truth for recompute - the headway calculation runs against
cached JSON, so fixing a math bug doesn't need a re-fetch.

To force re-fetch:

- `--refresh` ignores the cache for the whole run
- Delete specific files in `cache/` to re-fetch only those (filenames are
  `lt_{line}_{naptan}_{dir}.json` for tube timetable and
  `jr_{from}_{to}_{date}_{time}_{mode}.json` for journey results)

## Output files

- `wait_times.js` - standalone file with `const WAIT_MINS = {...}`
- `wait_times_report.txt` - per-edge breakdown showing which data source
  was used and intermediate values. Useful for spot-checking.

The `wait_times.js` content also needs to be pasted into `index.html`
inline (the runtime uses the inlined copy). See the comment block above
`const WAIT_MINS = ` in `index.html` for the convention.

## Validation

`python3 -m build_headways --validate` runs six checks against the current
`wait_times.js` and the on-disk cache:

| Check | What it catches |
| --- | --- |
| 1. Cross-validate | Tube timetable vs JourneyResults disagreement per edge |
| 2. Symmetry | `|wait(A->B) - wait(B->A)|` outside tolerance |
| 3. Per-line variance | A station's wait far from the line's median |
| 4. Sparse service | Headway computed from too few journeys in the window |
| 5. NaPTAN mode-drift | Resolved NaPTAN modes don't match the line's mode |
| 6. Expected-waits fixture | Mismatch against hand-validated values in `expected_waits.json` |

Findings are flagged as `warn` or `error`. The `expected_waits.json`
fixture is the easiest knob to extend - add a hand-validated entry there
when you investigate an edge and confirm its correct value, so future
runs catch regressions automatically.

## Files

| File | What's in it |
| --- | --- |
| `__main__.py` | Entry point (`python3 -m build_headways`) |
| `cli.py` | Arg parsing, orchestration, `MANUAL_WAIT_OVERRIDES`, output writers |
| `headway.py` | Half-headway calculation from raw schedules |
| `naptan.py` | Station name -> NaPTAN ID resolution (handles split-site stations, HUB drill-down) |
| `network.py` | Parses NETWORK from `index.html`, enumerates interchange edges |
| `line_map.py` | Maps branch IDs (e.g. `Northern_Bank_to_Edgware`) to TfL line IDs |
| `tfl_api.py` | HTTP client with on-disk caching |
| `validate.py` | The six validation checks |
| `expected_waits.json` | Hand-validated fixture for ~20 well-known interchanges |

## When values look wrong

1. Run `python3 -m build_headways --validate` first - if a known fixture
   is wrong, the cause is almost always in `headway.py` or `naptan.py`.
2. For a single suspect edge, inspect the raw response in
   `build_headways/cache/lt_{line}_{naptan}_{dir}.json` (tube) or the
   relevant `jr_*.json` (other modes).
3. If TfL's data itself is the problem (sparse service, event-only line),
   add an entry to `MANUAL_WAIT_OVERRIDES` in `cli.py` with a derived
   value and a comment explaining why.

Don't edit `wait_times.js` by hand - it's regenerated on every run and
your edit will vanish.
