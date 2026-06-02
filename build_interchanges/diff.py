"""Compare API-derived interchange pairs against the existing game data."""

from dataclasses import dataclass, field
from typing import Dict, List, Tuple


@dataclass
class DiffReport:
    matches: List[Tuple[str, str, int, int]] = field(default_factory=list)
    small_changes: List[Tuple[str, str, int, int]] = field(default_factory=list)
    big_changes: List[Tuple[str, str, int, int]] = field(default_factory=list)
    new_pairs: List[Tuple[str, str, int]] = field(default_factory=list)
    missing_pairs: List[Tuple[str, str, int]] = field(default_factory=list)

    @property
    def is_clean(self) -> bool:
        return not (self.big_changes or self.missing_pairs)

    def summary_counts(self) -> Dict[str, int]:
        return {
            'matches':       len(self.matches),
            'small_changes': len(self.small_changes),
            'big_changes':   len(self.big_changes),
            'new_pairs':     len(self.new_pairs),
            'missing_pairs': len(self.missing_pairs),
        }


def compute_diff(
    game: Dict[str, Dict[str, int]],
    api: Dict[str, Dict[str, int]],
    small_change_threshold: int = 1,
) -> DiffReport:
    """Compare two {station: {pair: minutes}} dicts.

    Returns a DiffReport categorising each pair as:
    * match            — same value
    * small_change     — abs(delta) <= small_change_threshold
    * big_change       — abs(delta) >  small_change_threshold
    * new_pair         — in API but not game
    * missing_pair     — in game but not API (needs MANUAL_OVERRIDES decision)
    """
    report = DiffReport()
    stations = sorted(set(game) | set(api))
    for stn in stations:
        g = game.get(stn, {})
        a = api.get(stn, {})
        for pair in sorted(set(g) | set(a)):
            gv, av = g.get(pair), a.get(pair)
            if gv is not None and av is None:
                report.missing_pairs.append((stn, pair, gv))
            elif gv is None and av is not None:
                report.new_pairs.append((stn, pair, av))
            elif gv == av:
                report.matches.append((stn, pair, gv, av))
            elif abs(av - gv) <= small_change_threshold:
                report.small_changes.append((stn, pair, gv, av))
            else:
                report.big_changes.append((stn, pair, gv, av))
    return report


def format_report(report: DiffReport) -> str:
    rows = [
        '=' * 72,
        'INTERCHANGE TIMES — Stop Structure API vs Game',
        '=' * 72,
    ]
    c = report.summary_counts()
    rows.append(
        f"matches: {c['matches']}  small: {c['small_changes']}  "
        f"big: {c['big_changes']}  new: {c['new_pairs']}  "
        f"missing: {c['missing_pairs']}"
    )

    rows.append(f'\nMATCHES ({len(report.matches)}):')
    for stn, pair, g, a in report.matches:
        rows.append(f'  {stn} [{pair}]: game={g}  API={a}')

    rows.append(f'\nSMALL CHANGES <={1} ({len(report.small_changes)}):')
    for stn, pair, g, a in report.small_changes:
        rows.append(f'  {stn} [{pair}]: game={g}  API={a}  ({a-g:+d})')

    rows.append(f'\nBIG CHANGES >1 ({len(report.big_changes)}):')
    for stn, pair, g, a in report.big_changes:
        rows.append(f'  {stn} [{pair}]: game={g}  API={a}  ({a-g:+d})')

    rows.append(f'\nNEW pairs from API ({len(report.new_pairs)}):')
    for stn, pair, a in report.new_pairs:
        rows.append(f'  {stn} [{pair}]: API={a}')

    rows.append(f'\nMISSING — in game but not API ({len(report.missing_pairs)}):')
    for stn, pair, g in report.missing_pairs:
        rows.append(f'  {stn} [{pair}]: game={g}  ← needs MANUAL_OVERRIDES decision')

    rows.append('\n' + '=' * 72)
    return '\n'.join(rows)
