"""Thin TfL API client for headway fetching with on-disk caching.

Two endpoints are used:

* /Line/{lineId}/Timetable/{naptan}?direction=inbound
  Returns the full day's schedule for the given line at the given stop.
  Works for Tube lines only.

* /Journey/JourneyResults/{naptan}/to/{naptan}?date=...&time=...&mode=...
  Returns scheduled journeys from `from` to `to` at the requested time.
  Works for all modes — used as the fallback for Overground/DLR/Elizabeth
  where the Line Timetable endpoint returns empty.
"""

import json
import logging
import random
import time
from pathlib import Path
from typing import Optional

try:
    import requests
except ImportError:  # pragma: no cover
    raise SystemExit('Missing dependency: pip install requests')


logger = logging.getLogger(__name__)


BASE_URL = 'https://api.tfl.gov.uk'
DEFAULT_API_KEY = '0a40943bebe54244b7fad68b8a0d5ef1'


class TflApiError(Exception):
    pass


class TflClient:
    def __init__(
        self,
        api_key: str = DEFAULT_API_KEY,
        cache_dir: Optional[Path] = None,
        refresh: bool = False,
        min_interval_s: float = 0.3,
        max_retries: int = 3,
        timeout_s: float = 20,
    ):
        self.api_key = api_key
        self.cache_dir = cache_dir
        self.refresh = refresh
        self.min_interval_s = min_interval_s
        self.max_retries = max_retries
        self.timeout_s = timeout_s
        self._last_request_t = 0.0
        if cache_dir is not None:
            cache_dir.mkdir(parents=True, exist_ok=True)

    def _cache_path(self, cache_key: str) -> Optional[Path]:
        if self.cache_dir is None:
            return None
        safe = cache_key.replace('/', '_').replace('?', '_').replace('&', '_').replace('=', '-')
        return self.cache_dir / f'{safe}.json'

    def _get(self, path: str, cache_key: str) -> dict:
        cp = self._cache_path(cache_key)
        if cp is not None and cp.exists() and not self.refresh:
            return json.loads(cp.read_text())

        # Rate limit
        now = time.monotonic()
        wait = self.min_interval_s - (now - self._last_request_t)
        if wait > 0:
            time.sleep(wait)

        url = f'{BASE_URL}{path}'
        sep = '&' if '?' in path else '?'
        url_with_key = f'{url}{sep}app_key={self.api_key}'

        last_exc = None
        for attempt in range(self.max_retries):
            try:
                resp = requests.get(url_with_key, timeout=self.timeout_s)
                self._last_request_t = time.monotonic()
                if resp.status_code == 429:
                    retry_after = float(resp.headers.get('Retry-After', '2'))
                    logger.warning('429 rate-limited, sleeping %ss', retry_after)
                    time.sleep(retry_after)
                    continue
                if 500 <= resp.status_code < 600:
                    backoff = 2 ** attempt + random.random()
                    logger.warning('%d on %s, retrying in %.1fs', resp.status_code, path, backoff)
                    time.sleep(backoff)
                    continue
                # Accept 200, 400, 404 — caller inspects body
                data = resp.json()
                if cp is not None:
                    cp.write_text(json.dumps(data))
                return data
            except requests.RequestException as e:
                last_exc = e
                backoff = 2 ** attempt + random.random()
                logger.warning('request error on %s: %s, retrying in %.1fs', path, e, backoff)
                time.sleep(backoff)
        raise TflApiError(f'Failed after {self.max_retries} attempts: {last_exc}')

    def line_timetable(self, line_id: str, naptan: str, direction: str = 'inbound') -> dict:
        path = f'/Line/{line_id}/Timetable/{naptan}?direction={direction}'
        return self._get(path, f'lt_{line_id}_{naptan}_{direction}')

    def journey_results(
        self,
        from_naptan: str,
        to_naptan: str,
        date: str,
        time_str: str,
        mode: str,
    ) -> dict:
        path = (
            f'/Journey/JourneyResults/{from_naptan}/to/{to_naptan}'
            f'?date={date}&time={time_str}&timeIs=Departing&mode={mode}'
        )
        return self._get(path, f'jr_{from_naptan}_{to_naptan}_{date}_{time_str}_{mode}')
