"""Map game NETWORK branch IDs → TfL line IDs and modes.

Game branch IDs are the keys in NETWORK (e.g. 'Northern_Bank_to_Edgware').
TfL Unified API uses simpler line IDs ('northern') and modes ('tube').

The function `tfl_for_branch(branch)` returns (tfl_line_id, tfl_mode)
or (None, None) if the branch shouldn't get a wait time (Walk, etc).
"""

from typing import Optional, Tuple


# Order matters: longer prefixes first so 'Overground_Lioness' matches
# before 'Overground'.
_PREFIX_MAP = [
    ('Bakerloo',                          ('bakerloo', 'tube')),
    ('Central_',                          ('central', 'tube')),
    ('Circle',                            ('circle', 'tube')),
    ('District_',                         ('district', 'tube')),
    ('DLR_',                              ('dlr', 'dlr')),
    ('Elizabeth_',                        ('elizabeth', 'elizabeth-line')),
    ('Hammersmith & City',                ('hammersmith-city', 'tube')),
    ('Jubilee',                           ('jubilee', 'tube')),
    ('Metropolitan_',                     ('metropolitan', 'tube')),
    ('Northern_',                         ('northern', 'tube')),
    ('Piccadilly_',                       ('piccadilly', 'tube')),
    ('Victoria',                          ('victoria', 'tube')),
    ('Waterloo & City',                   ('waterloo-city', 'tube')),
    ('Overground_Lioness',                ('lioness', 'overground')),
    ('Overground_Mildmay',                ('mildmay', 'overground')),
    ('Overground_Windrush',               ('windrush', 'overground')),
    ('Overground_Weaver',                 ('weaver', 'overground')),
    ('Overground_Suffragette',            ('suffragette', 'overground')),
    ('Overground_Liberty',                ('liberty', 'overground')),
]


def tfl_for_branch(branch: str) -> Tuple[Optional[str], Optional[str]]:
    """Return (tfl_line_id, tfl_mode) for a NETWORK branch ID, or (None, None)."""
    for prefix, (line, mode) in _PREFIX_MAP:
        if branch == prefix or branch.startswith(prefix):
            return line, mode
    return None, None
