"""TfL API client with caching, retries, and rate-limit awareness.

Cache strategy
--------------
* Responses are saved as XML files under cache/ keyed by stop ID.
* By default, cached responses are reused for fast iteration.
* Pass refresh=True (or --refresh on the CLI) to bypass the cache.

Rate limiting
-------------
* TfL API allows 500 req/min unauthenticated, more with an app_key.
* We sleep `min_interval_s` between requests (default 0.3s ≈ 200/min).
* On HTTP 429 we honour `Retry-After` if present, otherwise exponential
  backoff with jitter.
* On 5xx we retry up to `max_retries` times.
"""

import logging
import random
import time
import xml.etree.ElementTree as ET
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
    """Raised when the TfL API returns an unrecoverable error."""


class EmptyStopStructureError(TflApiError):
    """Raised when the Stop Structure response has no platform areas.

    This typically means the wrong identifier was used (e.g. a NaPTAN GID
    that TfL doesn't recognise for this API). See TfL forum thread on
    940GZZLUWLO for context.
    """

    def __init__(self, stop_id: str):
        super().__init__(
            f'Stop Structure response for {stop_id!r} contains no '
            f'platform areas. Likely a wrong identifier — use the ICS '
            f'code from /StopPoint/{{naptan}} → icsCode.'
        )
        self.stop_id = stop_id


class TflClient:
    """TfL API client. One instance per run; configure once."""

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

    # ── HTTP plumbing ──────────────────────────────────────────────────────

    def _throttle(self) -> None:
        elapsed = time.monotonic() - self._last_request_t
        if elapsed < self.min_interval_s:
            time.sleep(self.min_interval_s - elapsed)
        self._last_request_t = time.monotonic()

    def _get(self, path: str, params: Optional[dict] = None) -> requests.Response:
        """GET with throttle, retry on 429/5xx, and Retry-After awareness."""
        params = dict(params or {})
        params['app_key'] = self.api_key

        last_err: Optional[Exception] = None
        for attempt in range(self.max_retries + 1):
            self._throttle()
            try:
                r = requests.get(BASE_URL + path, params=params,
                                 timeout=self.timeout_s)
            except requests.RequestException as e:
                last_err = e
                backoff = (2 ** attempt) + random.random()
                logger.warning(
                    'Request error for %s (attempt %d/%d): %s — retrying in %.1fs',
                    path, attempt + 1, self.max_retries + 1, e, backoff,
                )
                time.sleep(backoff)
                continue

            if r.status_code == 429:
                retry_after = float(r.headers.get('Retry-After', 0))
                backoff = max(retry_after, (2 ** attempt) + random.random())
                logger.warning(
                    'Rate limited on %s (attempt %d/%d) — sleeping %.1fs',
                    path, attempt + 1, self.max_retries + 1, backoff,
                )
                time.sleep(backoff)
                continue

            if r.status_code >= 500:
                backoff = (2 ** attempt) + random.random()
                logger.warning(
                    'Server error %d on %s (attempt %d/%d) — retrying in %.1fs',
                    r.status_code, path, attempt + 1, self.max_retries + 1, backoff,
                )
                time.sleep(backoff)
                continue

            r.raise_for_status()
            return r

        raise TflApiError(f'Exhausted retries for {path}: {last_err}')

    # ── StopPoint metadata ────────────────────────────────────────────────

    def get_stop_point(self, identifier: str) -> dict:
        """Return the StopPoint JSON for a NaPTAN or HUB identifier."""
        r = self._get(f'/StopPoint/{identifier}')
        return r.json()

    def get_ics_code(self, identifier: str) -> Optional[str]:
        """Return the ICS code for a NaPTAN GID, or None if unknown.

        ICS codes are the documented-stable identifier for the Stop
        Structure API. NaPTAN GIDs are *not* guaranteed to work.
        """
        try:
            data = self.get_stop_point(identifier)
        except (TflApiError, requests.HTTPError) as e:
            logger.warning('Could not resolve ICS for %s: %s', identifier, e)
            return None
        ics = data.get('icsCode')
        return ics if ics else None

    def get_tube_stop_points(self) -> list:
        """Return the full /StopPoint/Mode/tube list."""
        r = self._get('/StopPoint/Mode/tube')
        return r.json().get('stopPoints', [])

    # ── Stop Structure ────────────────────────────────────────────────────

    def fetch_stop_structure(self, ics_code: str) -> ET.Element:
        """Fetch the XML_STOPSTRUCTURE_REQUEST response for one stop ID.

        Uses on-disk cache if available and `refresh` is False. Raises
        EmptyStopStructureError if the response contains no platform areas
        (a sign of a wrong identifier per the TfL forum guidance — e.g.
        Waterloo's 940GZZLUWLO is known to return empty).

        Only numeric ICS codes are documented to work reliably, but for
        a handful of stations (Edgware Road's cross-station footpaths)
        we need NaPTAN queries as the only available source. We allow
        them but rely on EmptyStopStructureError to surface failures.
        """
        if not ics_code.isdigit():
            logger.info(
                'Querying %s with non-ICS identifier (NaPTAN). This is '
                'undocumented and may fail; EmptyStopStructureError will '
                'be raised if it does.', ics_code,
            )

        xml_text = self._cached_or_fetch(ics_code)
        root = ET.fromstring(xml_text)

        # Sanity check: an empty response (like Waterloo's 940GZZLUWLO) has
        # no <stopAreaLines> child elements. Flag it loudly.
        area_lines = root.findall('.//stopAreaLines')
        if not area_lines:
            raise EmptyStopStructureError(ics_code)

        return root

    def _cached_or_fetch(self, ics_code: str) -> str:
        cache_path = (self.cache_dir / f'{ics_code}.xml'
                      if self.cache_dir else None)

        if cache_path is not None and cache_path.exists() and not self.refresh:
            logger.debug('Cache hit: %s', ics_code)
            return cache_path.read_text(encoding='utf-8')

        logger.debug('Fetching stop structure: %s', ics_code)
        r = self._get('/jp_public/api10/XML_STOPSTRUCTURE_REQUEST', {
            'sSStopNr':             ics_code,
            'sSFEA':                '1',
            'sSInclSL':             '1',
            'sSOnlyDF':             '0',
            'onlyDefaultFootpaths': '1',
        })
        xml_text = r.text

        if cache_path is not None:
            cache_path.write_text(xml_text, encoding='utf-8')
            logger.debug('Cached: %s → %s', ics_code, cache_path)

        return xml_text
