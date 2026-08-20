#!/usr/bin/env python3
"""Local dev server for Tubed that refuses to let the browser cache anything.

    python3 serve.py [port]        # default 8001

WHY THIS EXISTS. `python3 -m http.server` sends Last-Modified and lets the
browser decide whether to revalidate. Browsers frequently don't, and a cached
index.html then scores with old data while the files on disk are correct. That
happened twice on 2026-08-19: once through sandbox.html's iframe (a stale route
was nearly diagnosed as an engine bug) and once on the game page (a corrected
6-minute walk still displaying as 2). Both times the disk, the server and the
test suite all agreed and only the browser disagreed.

Cache-Control: no-store makes that failure mode impossible, which matters more
than the negligible reload cost when the whole point of the session is deciding
whether a number on screen is right.
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # quiet: the request log drowns anything useful in the terminal


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8001
    print(f'Tubed dev server on http://localhost:{port}/  (no-store, nothing cached)')
    print(f'   game:    http://localhost:{port}/index.html')
    print(f'   sandbox: http://localhost:{port}/sandbox.html')
    ThreadingHTTPServer(('', port), NoCacheHandler).serve_forever()
