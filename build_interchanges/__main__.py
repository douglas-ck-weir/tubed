"""Entry point: `python3 -m build_interchanges [options]`.

See `python3 -m build_interchanges --help` for usage.
"""

import sys

from .cli import main

if __name__ == '__main__':
    sys.exit(main())
