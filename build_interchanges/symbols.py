"""Map TfL itdServingLine symbols to Tubed display line names.

These come from the symbol attribute on <itdServingLine> elements in the
XML_STOPSTRUCTURE_REQUEST response. Each Tube/Overground/Elizabeth line has
one or more symbol codes — Elizabeth in particular uses several (one per
service group), all of which collapse to a single 'Elizabeth' display line.

If TfL adds or renames a line, add the new symbol here. The parser raises
UnknownSymbolWarning when it encounters a symbol it doesn't recognise so
omissions surface in CI/dry-run output rather than silently dropping pairs.
"""

from typing import Dict, FrozenSet


# Canonical mapping. Keep alphabetical by display name for review-friendliness.
SYMBOL_TO_LINE: Dict[str, str] = {
    'BAK': 'Bakerloo',
    'CEN': 'Central',
    'CIR': 'Circle',
    'DIS': 'District',
    'DLR': 'DLR',
    # Elizabeth line has multiple symbols, one per service group.
    '001': 'Elizabeth',
    '011': 'Elizabeth',
    '052': 'Elizabeth',
    '116': 'Elizabeth',
    'HAM': 'Hammersmith & City',
    'JUB': 'Jubilee',
    'LIB': 'Liberty',         # Overground Liberty line (post-2024 rename)
    'LIO': 'Lioness',         # Overground Lioness line
    'MET': 'Metropolitan',
    '022': 'Mildmay',         # Overground Mildmay line
    'MIL': 'Mildmay',
    'NTN': 'Northern',
    'PIC': 'Piccadilly',
    'SUF': 'Suffragette',     # Overground Suffragette line
    'VIC': 'Victoria',
    'WAC': 'Waterloo & City',
    'WEA': 'Weaver',          # Overground Weaver line
    'WIN': 'Windrush',        # Overground Windrush line
}

# Reverse map for assertions / tests.
LINE_TO_SYMBOLS: Dict[str, FrozenSet[str]] = {}
for sym, line in SYMBOL_TO_LINE.items():
    LINE_TO_SYMBOLS.setdefault(line, set()).add(sym)
LINE_TO_SYMBOLS = {k: frozenset(v) for k, v in LINE_TO_SYMBOLS.items()}


# Display lines that ever appear in INTERCHANGE_MINS keys. Used to validate
# NETWORK parsing and to give a single source of truth.
ALL_DISPLAY_LINES: FrozenSet[str] = frozenset(SYMBOL_TO_LINE.values())
