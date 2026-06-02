# build_interchanges

Rebuilds the `INTERCHANGE_MINS` block in `index.html` from the TfL
Stop Structure API. Designed to be re-runnable a year from now without
manual review of every value — see the architecture notes below.

## Usage

```bash
# Dry run: print diff against current game data, exit non-zero on regressions.
python3 -m build_interchanges --check-only

# Full run: regenerate interchange_new.js but don't touch index.html.
python3 -m build_interchanges

# Full run + apply to index.html in place.
python3 -m build_interchanges --apply

# Debug one station (uses cache so it's fast).
python3 -m build_interchanges --station "Baker Street" --check-only -v

# Force a fresh fetch instead of using cached XML.
python3 -m build_interchanges --refresh
```

## Exit codes

| Code | Meaning                                                              |
|-----:|---------------------------------------------------------------------|
| 0    | Build clean. Output written if not `--check-only`.                  |
| 2    | Declarations in `overrides.py` reference unknown stations or lines. |
| 3    | One or more game stations have no ICS code; pipeline cannot run.    |
| 4    | The game has pairs the API does not produce, with no override.      |

## Architecture

```
build_interchanges/
  cli.py            Entry point. Orchestrates the pipeline.
  game_data.py      Parses NETWORK and INTERCHANGE_MINS from index.html.
  parser.py         Pure: XML → {pair: minutes}. Heavily tested.
  tfl_api.py        HTTP client: caching, retry, rate limiting.
  station_ids.py    Resolves game station names → ICS codes.
  overrides.py      Per-station declarations (the domain knowledge).
  symbols.py        TfL line symbol → display line name.
  diff.py           Compares API output vs game data.
  writer.py         Renders JS output and patches index.html.
  data/
    station_codes.csv   NaPTAN backup map (rarely used).
  cache/
    *.xml               Cached Stop Structure responses (gitignored).
```

## How re-runnability works

### 1. The pipeline is deterministic and pure where it counts
- `parser.py` has no I/O. Same XML in → same dict out, every time.
- All side effects (network calls, file writes) live in `tfl_api.py`,
  `writer.py`, and `cli.py`.

### 2. Declarations are explicit, not inferred
Every 1-minute cross-platform interchange (Westminster Cir|Dis, Baker
Street Cir|H&C, etc.) is declared in `overrides.CROSS_PLATFORM_INTERCHANGES`.
A reviewer can grep the file and see exactly which stations get the rule.
Earlier versions inferred this from API symbol sets — that worked but
produced wrong results when TfL's "trains stopping" enumeration diverged
from "platforms passengers can change between" (Paddington Cir|H&C was
wrongly 1 min for this reason).

### 3. The CSV and ICS codes are sourced at runtime
- `STATION_QUERIES` in `overrides.py` holds explicit ICS codes for
  complex stations.
- For ordinary stations, ICS codes come from `/StopPoint/Mode/tube` at
  runtime — TfL updates → we pick up the change.
- For stations missing from the tube list (Overground-only,
  newly-opened), the CSV `data/station_codes.csv` provides NaPTAN
  as a last-resort fallback that we resolve to ICS via the live API.

### 4. NaPTAN identifiers are explicitly limited
Per the [TfL forum thread on `940GZZLUWLO`][forum], NaPTAN GIDs are not
documented to work with the Stop Structure API. The client raises
`EmptyStopStructureError` if a response has no platform areas — a known
signature of "wrong identifier". Only two stations are allowed to use
NaPTAN, both with documented reasons in `overrides.py`:
- **Edgware Road** — the ICS hierarchy treats Edgware Rd Bakerloo and
  Circle as platforms of Baker Street's ICS, so the cross-line
  footpaths are only accessible via the NaPTAN query.
- **Paddington** — ICS 1000174 doesn't include H&C↔Elizabeth footpaths.

A test (`test_overrides.py::test_station_queries_use_ics_codes_or_documented_naptan`)
enforces this rule, so the next person adding a station has to make
the explicit decision rather than copy-paste a NaPTAN GID.

### 5. Failure modes surface loudly
- **Empty API response** → `EmptyStopStructureError`, logged as ERROR
- **Game pair the API doesn't produce** → listed in diff under "MISSING",
  build exits 4 unless `--allow-missing`. Either declare in
  `MANUAL_OVERRIDES` (with `reason`) or remove from index.html.
- **Unknown line symbol** in the API response → warning at end of run,
  prompting you to update `symbols.py`.
- **Override referencing nonexistent station/line** → build refuses to
  start (exit 2).

### 6. Caching makes iteration cheap
First run takes ~30s (97 stations × ~250ms throttled API calls).
Subsequent runs hit the cache and complete in <2s. Use `--refresh`
when you want to re-fetch (e.g. after a known TfL data update).

## When to update this

| What changed                                        | What to update                                                          |
|------------------------------------------------------|--------------------------------------------------------------------------|
| TfL renames a line (e.g. Overground Lioness → X)    | `symbols.py` symbol map; the diff test will flag unknown symbols       |
| A new station opens                                 | The game adds it to NETWORK; this pipeline picks it up automatically   |
| A station's platforms are restructured              | Re-run with `--refresh`. Compare the diff; investigate big swings.     |
| A new cross-platform interchange (e.g. step-free)  | Add to `CROSS_PLATFORM_INTERCHANGES` in `overrides.py`                  |
| API endpoint changes shape                          | Update `parser.py`; tests against `fixtures/*.xml` will flag breakage  |

## Testing

```bash
python3 -m pytest tests/python/ -v
```

Tests run against checked-in XML fixtures under `tests/python/fixtures/`.
These fixtures are **trimmed** down from the full TfL responses (which
are ~25MB each because they include every bus and rail interchange in
the area) to just the elements the parser reads — typically <50KB.

When you need to re-capture a fixture (e.g. TfL changes the API shape):

```bash
# 1. Capture a fresh response into the cache.
python3 -m build_interchanges --refresh --station "Baker Street"

# 2. Trim it down (mutates in place; ~200x smaller).
python3 -m build_interchanges.trim_fixture \
    build_interchanges/cache/1000011.xml \
    tests/python/fixtures/baker_street.xml

# 3. Verify tests still pass.
python3 -m pytest tests/python/
```

The trimmer keeps only `stopAreaLines` with platform `areaType` 81/65,
and only the `footpathInfo` entries that connect kept platforms. It
also strips bulky `itdServingLine` metadata (routes, operators) since
the parser only reads the `symbol` attribute.

[forum]: https://techforum.tfl.gov.uk/ (search "940GZZLUWLO empty")
