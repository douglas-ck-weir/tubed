"""Validation checks on the generated wait_times.js.

Six checks run against the current `wait_times.js` and the on-disk cache:

  1. Cross-validation:        tube-tt vs JR agreement per edge
  2. Symmetry:                |wait(A,B) - wait(B,A)| within tolerance
  3. Per-line variance:       stations whose wait is far from line median
  4. Sparse-service:          headway computed from very few journeys
  5. NaPTAN mode-drift:       resolved NaPTAN's modes match the line's mode
  6. Expected-waits fixture:  match hand-validated values for key edges

Each check returns a list of finding dicts:
    {edge: (from, to, branch), severity: 'warn'|'error',
     check: str, detail: str}
"""

import json
import logging
import re
import statistics
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .headway import (
    OFFPEAK_END_HOUR,
    OFFPEAK_START_HOUR,
    WEEKDAY_SCHED_NAMES,
    _line_name_matches,
)
from .network import display_line


logger = logging.getLogger(__name__)


SYMMETRY_TOLERANCE_MIN = 3
VARIANCE_TOLERANCE_MIN = 3
EXPECTED_TOLERANCE_MIN = 1
SPARSE_MIN_JOURNEYS = 10
TUBE_LINE_IDS = {
    'bakerloo', 'central', 'circle', 'district', 'hammersmith-city',
    'jubilee', 'metropolitan', 'northern', 'piccadilly', 'victoria',
    'waterloo-city',
}


# ── Parsing ────────────────────────────────────────────────────────────────


def parse_wait_times_js(path: Path) -> Dict[Tuple[str, str, str], int]:
    """Parse wait_times.js (or the embedded WAIT_MINS block in index.html).

    Handles entries with escaped apostrophes (St. James's Park, Earl's Court,
    Shepherd's Bush etc.).
    """
    text = path.read_text()
    out: Dict[Tuple[str, str, str], int] = {}
    # Match: '   'A|B|branch': 12,    with any of A, B, branch containing \'
    pat = re.compile(
        r"^\s*'((?:[^'\\]|\\.)+)\|((?:[^'\\]|\\.)+)\|((?:[^'\\]|\\.)+)':\s*(\d+),\s*$",
        re.MULTILINE,
    )
    for m in pat.finditer(text):
        a = m.group(1).replace("\\'", "'")
        b = m.group(2).replace("\\'", "'")
        branch = m.group(3).replace("\\'", "'")
        out[(a, b, branch)] = int(m.group(4))
    return out


# ── Check 1: tube-tt vs JR cross-validation ────────────────────────────────


def _line_id_for_branch(branch: str) -> Optional[str]:
    from .line_map import tfl_for_branch
    line, _ = tfl_for_branch(branch)
    return line


def _count_jr_departures_for_edge(
    cache_dir: Path, from_naptan: str, to_naptan: str,
    line_display: str,
) -> Optional[int]:
    """Read cached JourneyResults for this edge at noon, return # of
    same-line journeys (None if not cached)."""
    # The cli writes JR caches as: jr_{from}_{to}_{date}_{time}_{mode}.json
    # We may have multiple time samples; check the 1200 one only.
    pattern = f'jr_{from_naptan}_{to_naptan}_*_1200_*.json'
    files = list(cache_dir.glob(pattern))
    if not files:
        return None
    total = 0
    for f in files:
        try:
            d = json.loads(f.read_text())
        except Exception:
            continue
        for j in d.get('journeys', []):
            for leg in j.get('legs', []):
                if leg.get('mode', {}).get('name') == 'walking':
                    continue
                opts = leg.get('routeOptions', [])
                ln = opts[0].get('name', '') if opts else ''
                if _line_name_matches(ln, line_display):
                    total += 1
                    break
    return total


def check_1_cross_validate(
    waits: Dict[Tuple[str, str, str], int],
    cache_dir: Path,
    naptan_resolver,
) -> List[dict]:
    """Tube-tt edges should agree with a JR fallback within tolerance."""
    findings = []
    for (a, b, branch), w_tt in waits.items():
        line_id = _line_id_for_branch(branch)
        if line_id not in TUBE_LINE_IDS:
            continue
        # Resolve NaPTANs
        from_naptan = naptan_resolver(a, line_id)
        to_naptan = naptan_resolver(b, line_id)
        if not from_naptan or not to_naptan:
            continue
        # Look in cache for a JR snapshot of this exact pair at noon
        line_display = display_line(branch)
        n_dep = _count_jr_departures_for_edge(
            cache_dir, from_naptan, to_naptan, line_display
        )
        if n_dep is None or n_dep == 0:
            # No cached JR exists for this tube edge — that's fine
            continue
        # Re-derive headway from the JR cache (3 deps → 2 gaps minimum)
        # For now just flag big mismatches by counting deps in 30-min window:
        # 5 deps in ~30 min = ~6 tph, 3 deps = ~6 tph (5 min gaps), etc.
        # We don't have the actual gaps here easily; treat as soft signal.
        # Crude: if tube-tt says 1 min wait (high freq), expect ≥3 deps in
        # the 30-min JR window. If tube-tt says 5+ min wait, expect ≤4 deps.
        # Strong signals only (JR returns up to 4 journeys per call, often
        # interleaving multiple lines, so per-call counts are noisy).
        if w_tt <= 2 and n_dep == 0:
            findings.append({
                'edge': (a, b, branch),
                'severity': 'warn',
                'check': 'cross-validate',
                'detail': f'tube-tt says {w_tt}m wait but 0 JR deps in '
                          f'cached 30-min window — possible NaPTAN issue',
            })
        elif w_tt >= 8 and n_dep >= 8:
            findings.append({
                'edge': (a, b, branch),
                'severity': 'warn',
                'check': 'cross-validate',
                'detail': f'tube-tt says {w_tt}m wait but {n_dep} JR deps '
                          f'in 30 min suggests much faster service',
            })
    return findings


# ── Check 2: Symmetry ──────────────────────────────────────────────────────


def check_2_symmetry(
    waits: Dict[Tuple[str, str, str], int],
    expected_asym: set = frozenset(),
) -> List[dict]:
    """Pairs (A, B, branch) and (B, A, branch) should agree within tolerance."""
    findings = []
    seen = set()
    for (a, b, branch), w_ab in waits.items():
        if (a, b, branch) in seen or (b, a, branch) in seen:
            continue
        w_ba = waits.get((b, a, branch))
        if w_ba is None:
            continue
        diff = abs(w_ab - w_ba)
        if diff >= SYMMETRY_TOLERANCE_MIN:
            # Check allowlist: real asymmetries (branch-end stations)
            pair_key = tuple(sorted([a, b])) + (branch,)
            if pair_key in expected_asym:
                continue
            findings.append({
                'edge': (a, b, branch),
                'severity': 'warn',
                'check': 'symmetry',
                'detail': f'{a}→{b}={w_ab}m vs {b}→{a}={w_ba}m (diff {diff}m)',
            })
        seen.add((a, b, branch))
        seen.add((b, a, branch))
    return findings


# ── Check 3: Per-line variance ─────────────────────────────────────────────


def check_3_variance(
    waits: Dict[Tuple[str, str, str], int],
) -> List[dict]:
    """Flag edges whose wait is >VARIANCE_TOLERANCE from its display-line median.

    Caveat: trunk-vs-branch is a legitimate source of variance. We bucket
    by branch_id (not display line) so each branch has its own median.
    """
    by_branch: Dict[str, List[int]] = defaultdict(list)
    for (a, b, branch), w in waits.items():
        by_branch[branch].append(w)
    findings = []
    for (a, b, branch), w in waits.items():
        peers = by_branch[branch]
        if len(peers) < 5:
            continue  # not enough data to define a median reliably
        med = statistics.median(peers)
        if abs(w - med) >= VARIANCE_TOLERANCE_MIN:
            findings.append({
                'edge': (a, b, branch),
                'severity': 'warn',
                'check': 'variance',
                'detail': f'wait={w}m but branch median={med:.0f}m',
            })
    return findings


# ── Check 4: Sparse service ────────────────────────────────────────────────


def check_4_sparse_service(cache_dir: Path) -> List[dict]:
    """Flag cached Line/.../Timetable responses where the Mon-Fri off-peak
    window has fewer than SPARSE_MIN_JOURNEYS departures — these produce
    unreliable half-headways."""
    findings = []
    for f in cache_dir.glob('lt_*.json'):
        try:
            d = json.loads(f.read_text())
        except Exception:
            continue
        routes = d.get('timetable', {}).get('routes', [])
        if not routes:
            continue
        count = 0
        for route in routes:
            for sched in route.get('schedules', []):
                if sched.get('name') not in WEEKDAY_SCHED_NAMES:
                    continue
                for j in sched.get('knownJourneys', []):
                    try:
                        h = int(j.get('hour', -1))
                    except (TypeError, ValueError):
                        continue
                    if OFFPEAK_START_HOUR <= h < OFFPEAK_END_HOUR:
                        count += 1
        if 0 < count < SPARSE_MIN_JOURNEYS:
            # Parse cache filename: lt_{line}_{naptan}_{direction}.json
            stem = f.stem  # lt_circle_940GZZLUKOY_outbound
            findings.append({
                'edge': (stem, '', ''),
                'severity': 'warn',
                'check': 'sparse-service',
                'detail': f'only {count} off-peak journeys; headway unreliable',
            })
    return findings


# ── Check 5: NaPTAN mode-drift ─────────────────────────────────────────────


def check_5_naptan_modes(
    waits: Dict[Tuple[str, str, str], int],
    naptan_resolver,
    cache_dir: Path,
) -> List[dict]:
    """For each (station, line) we used, verify the resolved NaPTAN actually
    serves that line's mode according to TfL's StopPoint metadata.
    Uses cached sp_*.json + sp_hub_*.json — does not hit the API."""
    findings = []
    # Build a {naptan: modes} index from cached StopPoint responses
    naptan_modes: Dict[str, set] = {}
    for f in cache_dir.glob('sp_hub_*.json'):
        try:
            d = json.loads(f.read_text())
        except Exception:
            continue
        for c in d.get('children', []):
            cid = c.get('id', '')
            naptan_modes[cid] = set(c.get('modes', []))
    for f in cache_dir.glob('sp_*.json'):
        if f.name.startswith('sp_hub_'):
            continue
        try:
            d = json.loads(f.read_text())
        except Exception:
            continue
        for m in d.get('matches', []):
            mid = m.get('id', '')
            naptan_modes[mid] = set(m.get('modes', []))

    mode_map = {
        'tube': 'tube', 'overground': 'overground',
        'dlr': 'dlr', 'elizabeth-line': 'elizabeth-line',
    }
    # TfL line ID → mode for this purpose
    line_to_mode = {
        **{k: 'tube' for k in TUBE_LINE_IDS},
        'dlr': 'dlr', 'elizabeth': 'elizabeth-line',
        'lioness': 'overground', 'mildmay': 'overground',
        'windrush': 'overground', 'weaver': 'overground',
        'suffragette': 'overground', 'liberty': 'overground',
    }

    checked = set()
    for (a, b, branch) in waits.keys():
        line_id = _line_id_for_branch(branch)
        if not line_id:
            continue
        mode = line_to_mode.get(line_id)
        if not mode:
            continue
        for stn in (a, b):
            key = (stn, line_id)
            if key in checked:
                continue
            checked.add(key)
            naptan = naptan_resolver(stn, line_id)
            if not naptan:
                continue
            naptan_serves = naptan_modes.get(naptan)
            if naptan_serves is None:
                continue  # unknown, can't check
            if mode not in naptan_serves:
                findings.append({
                    'edge': (stn, '', branch),
                    'severity': 'error',
                    'check': 'naptan-mode',
                    'detail': f'{stn} → {naptan} resolved for line {line_id} '
                              f'(mode {mode}) but NaPTAN serves '
                              f'{sorted(naptan_serves)}',
                })
    return findings


# ── Check 6: Expected-waits fixture ────────────────────────────────────────


def check_6_expected(
    waits: Dict[Tuple[str, str, str], int],
    fixture_path: Path,
) -> List[dict]:
    """Compare against hand-validated values; flag mismatches > tolerance."""
    findings = []
    if not fixture_path.exists():
        return findings
    fixture = json.loads(fixture_path.read_text())
    for key, expected in fixture.items():
        if key.startswith('_'):
            continue
        if not isinstance(expected, int):
            continue
        parts = key.split('|')
        if len(parts) != 3:
            continue
        a, b, branch = parts
        actual = waits.get((a, b, branch))
        if actual is None:
            findings.append({
                'edge': (a, b, branch),
                'severity': 'error',
                'check': 'expected',
                'detail': f'expected={expected}m but no entry in WAIT_MINS',
            })
            continue
        if abs(actual - expected) > EXPECTED_TOLERANCE_MIN:
            findings.append({
                'edge': (a, b, branch),
                'severity': 'error' if abs(actual - expected) > 3 else 'warn',
                'check': 'expected',
                'detail': f'actual={actual}m, expected={expected}m (diff '
                          f'{abs(actual - expected)}m)',
            })
    return findings


# ── Runner ─────────────────────────────────────────────────────────────────


def run_all_checks(
    wait_times_path: Path,
    cache_dir: Path,
    fixture_path: Path,
    naptan_resolver,
    expected_asym: set = frozenset(),
) -> Dict[str, List[dict]]:
    """Run all six checks; return findings keyed by check name."""
    waits = parse_wait_times_js(wait_times_path)
    logger.info('Parsed %d entries from %s', len(waits), wait_times_path)

    results = {}
    results['cross-validate'] = check_1_cross_validate(waits, cache_dir, naptan_resolver)
    results['symmetry']       = check_2_symmetry(waits, expected_asym)
    results['variance']       = check_3_variance(waits)
    results['sparse-service'] = check_4_sparse_service(cache_dir)
    results['naptan-mode']    = check_5_naptan_modes(waits, naptan_resolver, cache_dir)
    results['expected']       = check_6_expected(waits, fixture_path)
    return results


def format_findings(findings_by_check: Dict[str, List[dict]]) -> str:
    """Pretty-print the findings as a text report."""
    lines = []
    lines.append('═══ build_headways --validate report ═══')
    lines.append('')
    total = sum(len(v) for v in findings_by_check.values())
    errors = sum(1 for vs in findings_by_check.values() for f in vs if f['severity'] == 'error')
    warns = total - errors
    lines.append(f'Total findings: {total} ({errors} errors, {warns} warnings)')
    lines.append('')
    for check_name, findings in findings_by_check.items():
        lines.append(f'── {check_name} ({len(findings)}) ────────────────────')
        if not findings:
            lines.append('  (none)')
            continue
        for f in findings:
            a, b, branch = f['edge']
            sev = f['severity'].upper()
            sig = f'{a} → {b} ({branch})' if b else f'{a} ({branch})' if branch else a
            lines.append(f'  [{sev}] {sig}')
            lines.append(f'         {f["detail"]}')
        if len(findings) > 50:
            lines.append(f'  ... +{len(findings) - 50} more')
        lines.append('')
    return '\n'.join(lines)
