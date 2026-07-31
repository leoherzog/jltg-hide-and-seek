#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx>=0.28"]
# ///
"""Hide+Seek transit-map feasibility generator.

Reads one GTFS feed (URL or local .zip) and writes two self-contained HTML pages
describing how well that transit system works as a map for Jet Lag: The Game's
*Hide and Seek* home game:

    index.html     — is this system fit for the game, how well does it rate,
                     which of the 80 questions function here, which curses come
                     out of the deck, and how to set the game up.
    strategy.html  — the hider's page: every candidate hiding zone scored and
                     ranked, what finds you, and what to look for on this map.

Everything except the one optional `--llm` slot is deterministic: the same feed
plus the same cached HTTP responses must produce byte-identical HTML. There is no
`random` (except one fixed-seed permutation inside the minimum-enclosing-circle),
no unsorted iteration that reaches output, and no wall-clock time — every date on
the pages is derived from the feed's own `feed_info.txt` / `calendar*.txt` or from
`--as-of`.

    uv run generate.py https://connect.ridetherapid.org/InfoPoint/GTFS-Zip.ashx
    uv run generate.py feed.zip --out build/ --size medium --no-osm

Data sources
    GTFS       the feed itself (stops, service, travel times, network shape).
    OpenStreetMap via Overpass   the POI categories the rulebook's questions name
               (museum, park, zoo, golf course, hospital, …), admin boundaries and
               the curse predicates. One bbox-wide query per category, cached.
    Nominatim  one reverse geocode of the map centroid, for the place name and the
               country's `admin_level` ladder.

Layout of this file
    S0  plumbing        CLI, logging, cache, HTTP, rounding, JSON, geometry, HTML
    S1  gtfs            feed parse, service calendar, metrics, RAPTOR, inference
    S2  geo             Overpass/Nominatim, categories, spatial index, zone inventory
    S3  rules           rulebook catalogue, question viability, surv, scoring
    S4  render_index    index.html
    S5  render_strategy strategy.html (plus the optional, off-by-default LLM slot)

Specs behind this file live in scratchpad/specs/: gtfs.md, osm.md, rules.md,
rules.json, scoring.md, pages.md, contract.md. contract.md is authoritative for
the shape of everything that crosses a section boundary.
"""

from __future__ import annotations

import argparse
import bisect
import collections
import csv
import dataclasses
import datetime as dt
import hashlib
import heapq
import html
import io
import json
import logging
import math
import re
import statistics
import sys
import time
import zipfile
from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Iterable, Iterator, Literal, Sequence

import httpx

# ═══════════════════════════════════════════════════════════════════════════════
# S0 · CONSTANTS
# ═══════════════════════════════════════════════════════════════════════════════

GENERATOR = "jltg-hide-and-seek/generate.py"
VERSION = "1.0.0"
USER_AGENT = f"{GENERATOR} {VERSION} (+https://github.com/leoherzog/jltg-hide-and-seek)"

# ── units ─────────────────────────────────────────────────────────────────────
M_PER_MILE = 1609.344
M_PER_KM = 1000.0
QUARTER_MILE_M = 402.336          # exact; do NOT round to 400 or counts stop reproducing
HALF_MILE_M = 804.672             # exact
SQM_PER_SQMI = M_PER_MILE ** 2
EARTH_R_M = 6371008.8             # IUGG mean radius

# ── travel-time model (specs/gtfs.md §4.1) ────────────────────────────────────
WALK_SPEED_MPS = 1.2              # deliberately below the 1.4 pedestrian norm
WALK_RADIUS_M = 400.0             # straight-line transfer radius
WALK_CIRCUITY = 1.3               # straight-line → street distance
BOARD_SLACK_S = 0                 # --board-slack overrides
MAX_TRANSFERS = 4                 # K; measured to saturate at 2 on a radial bus feed
DEFAULT_DEPARTURE = "09:00:00"    # mid-morning on the representative day
SERVICE_DAY_SECONDS = 30 * 3600   # service days legally run past 24:00; never modulo 86400

# ── analysis windows ──────────────────────────────────────────────────────────
HEADWAY_WINDOW = ("06:00:00", "22:00:00")
MIDDAY_WINDOW = ("10:00:00", "14:00:00")
EVENING_WINDOW = ("19:00:00", "22:00:00")
FREQUENT_HEADWAY_MIN = 15         # a stop is "frequent" if one route-direction beats this
STATION_CLUSTER_M = 100.0         # single-link station synthesis (specs/gtfs.md §3.2)
HUB_SNAP_M = 200.0                # snap the hub to the busiest member of its cluster
T90_ORIGIN_STRIDE = 30            # sorted(served)[::30] → ~50 deterministic origins
RADAR_SAMPLE_PAIRS = 200_000      # deterministic stop-pair sample for radar liveness
RADAR_DEAD_HIGH = 0.98            # hit rate above this ⇒ always "yes" ⇒ dead
RADAR_DEAD_LOW = 0.02             # hit rate below this ⇒ always "no"  ⇒ dead
SEEKER_SAMPLE_CAP = 200           # |S| for the surv computation when n > 400
SURV_FULL_UNIVERSE_MAX = 400      # S = Z below this

# ── network shape classification (specs/gtfs.md §6.1) ─────────────────────────
HUB_RADIAL_MIN = 0.50
HUB_SEMI_RADIAL_MIN = 0.25

# ── HTTP ──────────────────────────────────────────────────────────────────────
OVERPASS_ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)
NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/reverse"
HTTP_TIMEOUT_S = 300.0
HTTP_ATTEMPTS_PER_ENDPOINT = 2
HTTP_BACKOFF_S = 8.0              # between attempts on the same endpoint
OVERPASS_COURTESY_SLEEP_S = 3.0   # after every successful fetch
NOMINATIM_COURTESY_SLEEP_S = 1.0  # Nominatim's hard limit is 1 req/s
OVERPASS_WAY_BUDGET = 150_000     # above this, tile the bbox (specs/osm.md §1.5)

# ── LLM (off by default; see scratchpad/QWEN_VERDICT.md for why) ───────────────
LLM_URL = "http://miniaturo.stingray-yo.ts.net:1234"
# Measured, not assumed — see scratchpad/QWEN_VERDICT.md. gemma-4-12b-qat scores 94%
# on the binary legality probe with zero disagreement across five samples; qwen3.5-9b
# scored 62% with 7 of 16 items unstable. The tie-break is the only thing either is
# asked to do, but there is no reason to default to the weaker model.
LLM_MODEL = "google/gemma-4-12b-qat"

# ── front-end chrome (copied verbatim from the hand-built drafts) ─────────────
WA_KIT = "https://ka-p.webawesome.com/kit/95e68140d1204145/webawesome@3.10.0"
MAPLIBRE_CSS = "https://cdn.jsdelivr.net/npm/maplibre-gl/dist/maplibre-gl.min.css"
MAPLIBRE_JS = "https://cdn.jsdelivr.net/npm/maplibre-gl/+esm"
TILES_LIGHT = "https://tiles.openfreemap.org/styles/positron"
TILES_DARK = "https://tiles.openfreemap.org/styles/dark"

# Countries that read distances in miles (drives MapLibre's ScaleControl unit).
IMPERIAL_COUNTRIES = frozenset({"us", "gb", "lr", "mm"})

log = logging.getLogger("generate")


# ═══════════════════════════════════════════════════════════════════════════════
# S0 · CLI AND LOGGING
# ═══════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class Options:
    """Every knob, resolved. Sections receive this rather than the argparse Namespace.

    `source` is the positional GTFS URL or path. Everything else either overrides an
    inference or controls I/O. A bare run sets every override to None.
    """

    source: str
    out_dir: Path
    cache_dir: Path
    as_of: str | None                     # 'YYYYMMDD', clamped into the feed window
    size: Literal["small", "medium", "large"] | None
    hiding_period_min: int | None
    zone_radius_m: float | None
    start_stop_id: str | None
    border_kind: Literal["bbox", "circle"]
    border_bbox: tuple[float, float, float, float] | None   # (S, W, N, E)
    exclude_stops: tuple[str, ...]
    exclude_routes: tuple[str, ...]
    departure: str                        # 'HH:MM:SS' on the representative day
    board_slack_s: int
    use_osm: bool
    offline: bool
    refresh: bool
    llm: bool
    llm_url: str
    llm_model: str
    selftest: bool
    argv: tuple[str, ...]                 # for the provenance block


def parse_args(argv: Sequence[str] | None = None) -> Options:
    """Parse the command line into `Options`. Pure; no I/O beyond path resolution."""
    p = argparse.ArgumentParser(
        prog="generate.py",
        description="Rate a public transit system as a Hide+Seek map and write index.html + strategy.html.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("source", help="GTFS feed URL or path to a local GTFS .zip")
    p.add_argument("--out", dest="out", default=".", help="output directory (default: .)")
    p.add_argument("--cache", dest="cache", default="cache", help="HTTP cache directory (default: cache)")

    g = p.add_argument_group("inference overrides")
    g.add_argument("--as-of", metavar="YYYYMMDD", help="analysis date; default = feed_info.feed_start_date")
    g.add_argument("--size", choices=("small", "medium", "large"), help="override the inferred game size")
    g.add_argument("--hiding-period", type=int, metavar="MIN", help="override the hiding period in minutes")
    g.add_argument("--zone-radius", type=float, metavar="M", help="override the hiding-zone radius in metres")
    g.add_argument("--start", metavar="STOP_ID", help="override the inferred hub / round-start station")
    g.add_argument("--border", choices=("bbox", "circle"), default="bbox", help="border shape (default: bbox)")
    g.add_argument("--border-bbox", metavar="S,W,N,E", help="explicit border box in decimal degrees")
    g.add_argument("--exclude-stop", action="append", default=[], metavar="STOP_ID",
                   help="drop a stop from the map (repeatable; for the safety-exclusion conversation)")
    g.add_argument("--exclude-route", action="append", default=[], metavar="ROUTE_ID",
                   help="drop a route from the map (repeatable)")
    g.add_argument("--departure", default=DEFAULT_DEPARTURE, metavar="HH:MM[:SS]",
                   help=f"round-start departure time (default: {DEFAULT_DEPARTURE})")
    g.add_argument("--board-slack", type=int, default=BOARD_SLACK_S, metavar="SEC",
                   help="seconds of transfer slack in the travel-time model (default: 0)")

    n = p.add_argument_group("network / cache")
    n.add_argument("--no-osm", action="store_true", help="skip Overpass and Nominatim entirely")
    n.add_argument("--offline", action="store_true", help="a cache miss is a hard error instead of a fetch")
    n.add_argument("--refresh", action="store_true", help="ignore cached responses and refetch")

    m = p.add_argument_group("machine-suggested text (off by default)")
    m.add_argument("--llm", action="store_true",
                   help="allow a local model to break exact score ties and add clearly-labelled flavour sentences")
    m.add_argument("--llm-url", default=LLM_URL, help=f"LM Studio base URL (default: {LLM_URL})")
    m.add_argument("--llm-model", default=LLM_MODEL, help=f"model id (default: {LLM_MODEL})")

    p.add_argument("--selftest", action="store_true", help="assert the golden numbers for the reference feed")
    p.add_argument("-v", "--verbose", action="count", default=0, help="-v for debug, -vv for trace")
    p.add_argument("--version", action="version", version=f"{GENERATOR} {VERSION}")

    a = p.parse_args(argv)
    setup_logging(a.verbose)

    bbox = None
    if a.border_bbox:
        parts = [float(x) for x in a.border_bbox.split(",")]
        if len(parts) != 4:
            p.error("--border-bbox takes four comma-separated numbers: S,W,N,E")
        bbox = (parts[0], parts[1], parts[2], parts[3])

    dep = a.departure if a.departure.count(":") == 2 else a.departure + ":00"

    return Options(
        source=a.source,
        out_dir=Path(a.out).resolve(),
        cache_dir=Path(a.cache).resolve(),
        as_of=a.as_of,
        size=a.size,
        hiding_period_min=a.hiding_period,
        zone_radius_m=a.zone_radius,
        start_stop_id=a.start,
        border_kind=a.border,
        border_bbox=bbox,
        exclude_stops=tuple(sorted(set(a.exclude_stop))),
        exclude_routes=tuple(sorted(set(a.exclude_route))),
        departure=dep,
        board_slack_s=a.board_slack,
        use_osm=not a.no_osm,
        offline=a.offline,
        refresh=a.refresh,
        llm=a.llm,
        llm_url=a.llm_url,
        llm_model=a.llm_model,
        selftest=a.selftest,
        argv=tuple(argv if argv is not None else sys.argv[1:]),
    )


def setup_logging(verbosity: int) -> None:
    """Configure the module logger. Logs go to stderr so stdout stays clean."""
    level = logging.WARNING if verbosity == 0 else logging.INFO if verbosity == 1 else logging.DEBUG
    logging.basicConfig(
        level=level,
        stream=sys.stderr,
        format="%(asctime)s %(levelname)-5s %(message)s",
        datefmt="%H:%M:%S",
    )
    log.setLevel(level)


class Timer:
    """Context manager that logs how long a pipeline stage took (to stderr only —
    a duration must never reach the HTML, it is not reproducible)."""

    def __init__(self, label: str) -> None:
        self.label = label
        self.t0 = 0.0

    def __enter__(self) -> "Timer":
        self.t0 = time.perf_counter()
        log.info("%s …", self.label)
        return self

    def __exit__(self, *exc: object) -> Literal[False]:
        log.info("%s done in %.2fs", self.label, time.perf_counter() - self.t0)
        return False


# ═══════════════════════════════════════════════════════════════════════════════
# S0 · NUMBERS — one rounding policy for the whole program
# ═══════════════════════════════════════════════════════════════════════════════
#
# THE RULE: no section formats a number by hand. Every quantity that reaches the
# HTML or the embedded JSON goes through exactly one of the functions below, so
# two sections can never print the same value differently. Rounding happens at the
# point of *formatting*, never at the point of computation.

def rhu(x: float, dp: int = 0) -> float:
    """Round half **up** (not banker's) to `dp` decimal places.

    `round()` is banker's rounding and would make 0.5-boundary values depend on
    parity; every display value uses this instead.
    """
    if not math.isfinite(x):
        raise ValueError(f"cannot round non-finite {x!r}")
    q = Decimal(1).scaleb(-dp)
    return float(Decimal(repr(x)).quantize(q, rounding=ROUND_HALF_UP))


def num(x: float, dp: int = 0, *, comma: bool = True) -> str:
    """Format a plain number: `num(1493)` → '1,493', `num(76.83, 1)` → '76.8'."""
    v = rhu(x, dp)
    return f"{v:,.{dp}f}" if comma else f"{v:.{dp}f}"


def pct(frac: float, dp: int = 1) -> str:
    """Format a 0..1 fraction as a percentage: `pct(0.126)` → '12.6%'."""
    return f"{num(frac * 100, dp, comma=False)}%"


def mins(minutes: float, dp: int = 0) -> str:
    """Format a duration given in minutes: `mins(76.8, 1)` → '76.8 min'."""
    return f"{num(minutes, dp)} min"


def miles(metres: float, dp: int = 2) -> str:
    """Format a distance given in metres, as miles: `miles(15270)` → '9.49 mi'."""
    return f"{num(metres / M_PER_MILE, dp)} mi"


def km(metres: float, dp: int = 1) -> str:
    """Format a distance given in metres, as kilometres."""
    return f"{num(metres / M_PER_KM, dp)} km"


def sqmi(sq_metres: float, dp: int = 1) -> str:
    """Format an area given in m², as square miles: → '160.1 sq mi'."""
    return f"{num(sq_metres / SQM_PER_SQMI, dp)} sq mi"


def coord(x: float) -> float:
    """Quantise a latitude/longitude to 6 dp (~11 cm). All coordinates in the
    embedded JSON pass through this so the payload is byte-stable."""
    return rhu(x, 6)


def hhmm(seconds: float) -> str:
    """Format seconds-since-service-day-start as 'H:MM', keeping hours past 24.

    `hhmm(87360)` → '24:16'. Never modulo by 86400 — a last bus at 24:16 really is
    later than one at 23:59.
    """
    s = int(rhu(seconds))
    return f"{s // 3600}:{(s % 3600) // 60:02d}"


def hhmmss(seconds: float) -> str:
    """Format seconds-since-service-day-start as 'H:MM:SS', keeping hours past 24."""
    s = int(rhu(seconds))
    return f"{s // 3600}:{(s % 3600) // 60:02d}:{s % 60:02d}"


def hms_to_s(value: str | None) -> int | None:
    """Parse a GTFS 'H:MM:SS' time to seconds since service-day start.

    Returns None for a blank/absent time (legal at non-timepoint stops). Hours are
    not zero-padded in many feeds and may exceed 23; both are handled.
    """
    if not value or not value.strip():
        return None
    h, m, s = value.strip().split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def iso_date(yyyymmdd: str) -> str:
    """'20260812' → '2026-08-12'. Raises on anything that isn't 8 digits."""
    if not re.fullmatch(r"\d{8}", yyyymmdd):
        raise ValueError(f"not a GTFS date: {yyyymmdd!r}")
    return f"{yyyymmdd[:4]}-{yyyymmdd[4:6]}-{yyyymmdd[6:]}"


def pretty_date(yyyymmdd: str) -> str:
    """'20260812' → 'Wed 12 Aug 2026'. Derived from the feed, never from the clock."""
    d = dt.date(int(yyyymmdd[:4]), int(yyyymmdd[4:6]), int(yyyymmdd[6:]))
    return d.strftime("%a %-d %b %Y")


def dow_of(yyyymmdd: str) -> int:
    """Monday=0 … Sunday=6, for a GTFS date string."""
    return dt.date(int(yyyymmdd[:4]), int(yyyymmdd[4:6]), int(yyyymmdd[6:])).weekday()


def date_range(start: str, end: str) -> list[str]:
    """Every GTFS date string from `start` to `end` inclusive, ascending."""
    d0 = dt.date(int(start[:4]), int(start[4:6]), int(start[6:]))
    d1 = dt.date(int(end[:4]), int(end[4:6]), int(end[6:]))
    out, d = [], d0
    while d <= d1:
        out.append(d.strftime("%Y%m%d"))
        d += dt.timedelta(days=1)
    return out


def lower_median(values: Sequence[float]) -> float:
    """`sorted(v)[(n-1)//2]` — the lower of the two middle values for even n.

    Used for representative-day selection and for the game-size vote, where ties
    must round *down* to the smaller/quieter option.
    """
    s = sorted(values)
    return s[(len(s) - 1) // 2]


def quantile(values: Sequence[float], q: float) -> float:
    """Deterministic nearest-rank quantile: `sorted(v)[ceil(q*n)-1]`, clamped.

    Not `statistics.quantiles` — that interpolates, and its edge behaviour differs
    across Python versions. Every p05/p50/p90/p95 on either page uses this one.
    """
    if not values:
        raise ValueError("quantile of an empty sequence")
    s = sorted(values)
    idx = max(0, min(len(s) - 1, math.ceil(q * len(s)) - 1))
    return s[idx]


# ═══════════════════════════════════════════════════════════════════════════════
# S0 · DETERMINISTIC JSON
# ═══════════════════════════════════════════════════════════════════════════════


def _normalise(obj: Any, float_dp: int) -> Any:
    """Recursively quantise floats and convert dataclasses/sets for serialisation."""
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return _normalise(dataclasses.asdict(obj), float_dp)
    if isinstance(obj, dict):
        return {str(k): _normalise(v, float_dp) for k, v in sorted(obj.items(), key=lambda kv: str(kv[0]))}
    if isinstance(obj, (list, tuple)):
        return [_normalise(v, float_dp) for v in obj]
    if isinstance(obj, (set, frozenset)):
        return [_normalise(v, float_dp) for v in sorted(obj, key=str)]
    if isinstance(obj, bool) or obj is None or isinstance(obj, (int, str)):
        return obj
    if isinstance(obj, float):
        if not math.isfinite(obj):
            return None
        v = rhu(obj, float_dp)
        return int(v) if v == int(v) and abs(v) < 1e15 else v
    if isinstance(obj, (dt.date, dt.datetime)):
        return obj.isoformat()
    raise TypeError(f"cannot serialise {type(obj).__name__} deterministically: {obj!r}")


def jdump(obj: Any, *, float_dp: int = 6) -> str:
    """Serialise to compact, key-sorted, byte-stable JSON.

    Every float is quantised to `float_dp` places first (a backstop — callers should
    already have applied the semantic precision from contract.md: coordinates 6 dp,
    scores 1 dp, shares 4 dp). Dataclasses, sets and dates are converted; anything
    else raises rather than silently stringifying.
    """
    return json.dumps(
        _normalise(obj, float_dp),
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    )


def sha256_bytes(data: bytes) -> str:
    """Lowercase hex sha256 — used for cache keys and for feed provenance."""
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    """Lowercase hex sha256 of UTF-8 text."""
    return sha256_bytes(text.encode("utf-8"))


# ═══════════════════════════════════════════════════════════════════════════════
# S0 · HTTP CACHE
# ═══════════════════════════════════════════════════════════════════════════════


class CacheMiss(RuntimeError):
    """Raised in `--offline` mode when a request is not already cached."""


class Cache:
    """Content-addressed HTTP cache under `cache/<kind>/<sha256(key)[:16]>.<ext>`.

    The key is always the *fully substituted* request (URL with parameters, or the
    complete Overpass query text with the bbox already interpolated), so changing a
    border correctly invalidates. Nothing time-derived is ever part of a key, and
    the cached file holds only the response body — no fetch timestamp, no headers.
    A populated cache makes the whole run offline and byte-identical.
    """

    def __init__(self, root: Path, *, offline: bool = False, refresh: bool = False) -> None:
        self.root = root
        self.offline = offline
        self.refresh = refresh
        self.hits: list[str] = []
        self.misses: list[str] = []

    def path_for(self, kind: str, key: str, ext: str) -> Path:
        return self.root / kind / f"{sha256_text(key)[:16]}.{ext}"

    def get(self, kind: str, key: str, ext: str) -> bytes | None:
        """Return the cached body, or None on a miss (or when `--refresh` is set)."""
        p = self.path_for(kind, key, ext)
        if self.refresh or not p.exists():
            return None
        self.hits.append(f"{kind}/{p.name}")
        log.debug("cache hit  %s %s", kind, p.name)
        return p.read_bytes()

    def put(self, kind: str, key: str, ext: str, body: bytes) -> Path:
        """Write a response body into the cache and return its path."""
        p = self.path_for(kind, key, ext)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_bytes(body)
        tmp.replace(p)
        self.misses.append(f"{kind}/{p.name}")
        log.debug("cache store %s %s (%d bytes)", kind, p.name, len(body))
        return p

    def require_online(self, what: str) -> None:
        if self.offline:
            raise CacheMiss(f"--offline and no cached response for {what}")


def http_fetch(
    cache: Cache,
    *,
    kind: str,
    cache_key: str,
    ext: str,
    endpoints: Sequence[str],
    method: str = "GET",
    params: dict[str, str] | None = None,
    data: str | None = None,
    courtesy_sleep_s: float = 0.0,
    attempts_per_endpoint: int = HTTP_ATTEMPTS_PER_ENDPOINT,
    backoff_s: float = HTTP_BACKOFF_S,
    timeout_s: float = HTTP_TIMEOUT_S,
) -> bytes:
    """Fetch a URL with caching, retries and mirror failover. Returns the body.

    Tries each endpoint in `endpoints` order, `attempts_per_endpoint` times each,
    sleeping `backoff_s` between attempts and honouring `Retry-After` on 429. This
    is not defensive programming for its own sake: during the measurement run behind
    specs/osm.md, overpass-api.de returned HTTP 504 on the first attempt of five of
    six queries and one query only succeeded on the third mirror.

    Raises `CacheMiss` in `--offline` mode, or `httpx.HTTPError` when every endpoint
    is exhausted.
    """
    hit = cache.get(kind, cache_key, ext)
    if hit is not None:
        return hit
    cache.require_online(cache_key[:120])

    last: Exception | None = None
    headers = {"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"}
    for endpoint in endpoints:
        for attempt in range(1, attempts_per_endpoint + 1):
            try:
                log.info("fetch %s (%s attempt %d)", endpoint, kind, attempt)
                with httpx.Client(timeout=timeout_s, follow_redirects=True, headers=headers) as client:
                    if method == "POST":
                        r = client.post(endpoint, content=data, params=params)
                    else:
                        r = client.get(endpoint, params=params)
                if r.status_code == 429:
                    wait = float(r.headers.get("Retry-After", backoff_s))
                    log.warning("429 from %s, sleeping %.0fs", endpoint, wait)
                    time.sleep(wait)
                    continue
                r.raise_for_status()
                body = r.content
                cache.put(kind, cache_key, ext, body)
                if courtesy_sleep_s:
                    time.sleep(courtesy_sleep_s)
                return body
            except Exception as exc:  # noqa: BLE001 — any transport error means "try the next mirror"
                last = exc
                log.warning("fetch failed (%s attempt %d): %s", endpoint, attempt, exc)
                if attempt < attempts_per_endpoint:
                    time.sleep(backoff_s)
    raise httpx.HTTPError(f"all endpoints failed for {kind}: {last}")


# ═══════════════════════════════════════════════════════════════════════════════
# S0 · GEOMETRY — the shared toolkit
# ═══════════════════════════════════════════════════════════════════════════════
#
# Pure Python on purpose. Everything here is haversine, an equirectangular
# projection, a monotone-chain hull, Welzl, ray casting and segment distance —
# a few hundred lines that would otherwise pull in shapely (a C extension) and
# geopandas (which drags GDAL, pandas and pyproj). The determinism story is also
# much easier to defend when the geometry is code we can read.

def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres between two WGS84 points."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R_M * math.asin(min(1.0, math.sqrt(a)))


@dataclass(frozen=True)
class Projection:
    """Local equirectangular projection about a reference latitude.

    Metres, x east / y north, accurate to well under a metre across a city-sized
    map and exactly reversible. Every distance, grid and area computation in the
    program works in this plane; only the final output converts back to degrees.
    """

    lat0: float
    lon0: float

    @property
    def m_per_deg_lat(self) -> float:
        return 111_132.0

    @property
    def m_per_deg_lon(self) -> float:
        return 111_320.0 * math.cos(math.radians(self.lat0))

    def xy(self, lat: float, lon: float) -> tuple[float, float]:
        return ((lon - self.lon0) * self.m_per_deg_lon, (lat - self.lat0) * self.m_per_deg_lat)

    def lonlat(self, x: float, y: float) -> tuple[float, float]:
        return (self.lon0 + x / self.m_per_deg_lon, self.lat0 + y / self.m_per_deg_lat)

    @staticmethod
    def about(points: Sequence[tuple[float, float]]) -> "Projection":
        """Build a projection centred on the mean of `points` (lat, lon)."""
        if not points:
            raise ValueError("no points to project about")
        return Projection(
            lat0=sum(p[0] for p in points) / len(points),
            lon0=sum(p[1] for p in points) / len(points),
        )


def bbox_of(points: Sequence[tuple[float, float]]) -> tuple[float, float, float, float]:
    """(S, W, N, E) of a sequence of (lat, lon). Overpass order, not GeoJSON order."""
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    return (min(lats), min(lons), max(lats), max(lons))


def bbox_expand(bbox: tuple[float, float, float, float], metres: float) -> tuple[float, float, float, float]:
    """Expand an (S, W, N, E) box by `metres` on every side."""
    s, w, n, e = bbox
    dlat = metres / 111_132.0
    mid = (s + n) / 2
    dlon = metres / (111_320.0 * max(0.05, math.cos(math.radians(mid))))
    return (s - dlat, w - dlon, n + dlat, e + dlon)


def bbox_contains(bbox: tuple[float, float, float, float], lat: float, lon: float) -> bool:
    """Is (lat, lon) inside the (S, W, N, E) box? Boundary counts as inside."""
    s, w, n, e = bbox
    return s <= lat <= n and w <= lon <= e


def convex_hull(points: Sequence[tuple[float, float]]) -> list[tuple[float, float]]:
    """Monotone-chain convex hull of planar (x, y) points, counter-clockwise.

    Input is sorted first, so the output is identical regardless of input order.
    Collinear points are dropped. Returns the hull without repeating the first
    point; fewer than three distinct points returns them sorted.
    """
    pts = sorted(set(points))
    if len(pts) <= 2:
        return list(pts)

    def cross(o: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[tuple[float, float]] = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list[tuple[float, float]] = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def polygon_area(ring: Sequence[tuple[float, float]]) -> float:
    """Shoelace area of a planar ring, in the ring's own units squared. Absolute."""
    if len(ring) < 3:
        return 0.0
    a = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0


def ring_centroid(ring: Sequence[tuple[float, float]]) -> tuple[float, float]:
    """Shoelace **area** centroid of a planar ring.

    Falls back to the bbox centre when the ring is degenerate (|A| < 1e-9). This is
    deliberately not Overpass's `out center`, which returns the bbox centre and
    diverges from the true centroid by a measured p90 of 88 m on real park polygons
    — enough to flip zone membership against a 402 m radius.
    """
    if len(ring) < 3:
        xs = [p[0] for p in ring] or [0.0]
        ys = [p[1] for p in ring] or [0.0]
        return ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)
    a = cx = cy = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        f = x1 * y2 - x2 * y1
        a += f
        cx += (x1 + x2) * f
        cy += (y1 + y2) * f
    if abs(a) < 1e-9:
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        return ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)
    a *= 0.5
    return (cx / (6 * a), cy / (6 * a))


def point_in_ring(pt: tuple[float, float], ring: Sequence[tuple[float, float]]) -> bool:
    """Ray-casting point-in-polygon for a planar ring. Boundary is undefined-but-stable."""
    x, y = pt
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xint = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < xint:
                inside = not inside
    return inside


def representative_point(ring: Sequence[tuple[float, float]]) -> tuple[float, float]:
    """A point guaranteed to lie *inside* a planar ring — the rulebook's "map icon".

    Uses the area centroid when it falls inside the ring. For concave shapes (a
    C-shaped park, a river-wrapped campus) the centroid can fall outside, so this
    falls back to scanning the horizontal line through the centroid's y, and
    returns the midpoint of the longest interior span. Deterministic, and close
    enough to where a map app would place the label.
    """
    c = ring_centroid(ring)
    if len(ring) < 3 or point_in_ring(c, ring):
        return c
    y = c[1]
    xs: list[float] = []
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xs.append((x2 - x1) * (y - y1) / (y2 - y1) + x1)
    xs.sort()
    best, best_len = c, -1.0
    for i in range(0, len(xs) - 1, 2):
        span = xs[i + 1] - xs[i]
        if span > best_len:
            best_len, best = span, ((xs[i] + xs[i + 1]) / 2, y)
    return best


def polyline_midpoint(line: Sequence[tuple[float, float]]) -> tuple[float, float]:
    """Length-weighted midpoint of an open planar polyline (a river, a rail line).

    Not the mean of the vertices, which is biased toward dense vertex clusters at
    curves.
    """
    if not line:
        raise ValueError("empty polyline")
    if len(line) == 1:
        return line[0]
    segs = [math.dist(line[i], line[i + 1]) for i in range(len(line) - 1)]
    half = sum(segs) / 2
    run = 0.0
    for i, seg in enumerate(segs):
        if run + seg >= half:
            t = 0.0 if seg == 0 else (half - run) / seg
            (x1, y1), (x2, y2) = line[i], line[i + 1]
            return (x1 + t * (x2 - x1), y1 + t * (y2 - y1))
        run += seg
    return line[-1]


def seg_point_dist(pt: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    """Distance from a planar point to the segment ab."""
    ax, ay = a
    bx, by = b
    px, py = pt
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.dist(pt, a)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.dist(pt, (ax + t * dx, ay + t * dy))


def ring_within(pt: tuple[float, float], ring: Sequence[tuple[float, float]], radius: float) -> bool:
    """Does the disc of `radius` about `pt` intersect the polygon `ring`?

    True when the point is inside the ring, or when any edge comes within `radius`.
    This is the *polygon* predicate — the rulebook's photo questions ("stand in a
    park") use it, while its matching/measuring questions use the map icon instead.
    Measured spread on real data: 45.5% of stops by polygon vs 29.0% by icon. Never
    substitute one for the other.
    """
    if point_in_ring(pt, ring):
        return True
    n = len(ring)
    for i in range(n):
        if seg_point_dist(pt, ring[i], ring[(i + 1) % n]) <= radius:
            return True
    return False


def min_enclosing_circle(points: Sequence[tuple[float, float]]) -> tuple[float, float, float]:
    """Welzl's minimum enclosing circle of planar points → (cx, cy, r).

    Determinism: the input is `sorted()` first and then permuted by a *local*
    `random.Random(0)`. That is a fixed permutation, not entropy — the result is
    verified stable across interpreter hash seeds. Welzl needs the shuffle for its
    expected-linear time; sorted-then-fixed-shuffle keeps both properties.
    """
    import random as _random  # local: nothing else in this program may use random

    pts = sorted(set(points))
    if not pts:
        raise ValueError("no points")
    _random.Random(0).shuffle(pts)

    def circle2(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float, float]:
        return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, math.dist(a, b) / 2)

    def circle3(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> tuple[float, float, float] | None:
        ax, ay = a
        bx, by = b
        cx, cy = c
        d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
        if abs(d) < 1e-12:
            return None
        ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
        uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
        return (ux, uy, math.dist((ux, uy), a))

    def inside(c: tuple[float, float, float], p: tuple[float, float]) -> bool:
        return math.dist((c[0], c[1]), p) <= c[2] + 1e-7

    circle: tuple[float, float, float] = (pts[0][0], pts[0][1], 0.0)
    for i, p in enumerate(pts):
        if inside(circle, p):
            continue
        circle = (p[0], p[1], 0.0)
        for j in range(i):
            q = pts[j]
            if inside(circle, q):
                continue
            circle = circle2(p, q)
            for k in range(j):
                r = pts[k]
                if inside(circle, r):
                    continue
                c3 = circle3(p, q, r)
                if c3 is not None:
                    circle = c3
    return circle


class GridIndex:
    """Uniform grid hash over planar points, for radius queries.

    Cell size is the query radius, so any query disc lies inside a 3×3 cell
    neighbourhood: exactly nine bucket reads. (R/2 cells need 5×5 = 25 reads; 2R
    cells need 3×3 but with 4× the candidates.) Measured on real data — 1,635 POIs,
    1,493 query points, R = 402.336 m — this is 11.2 candidate tests per query
    against 1,635 brute force, a 146× reduction.

    Bucket contents keep insertion order and callers insert in a sorted order, so
    iteration is deterministic. `near()` returns `(key, x, y)` triples sorted by key.
    """

    def __init__(self, cell: float) -> None:
        self.cell = cell
        self._cells: dict[tuple[int, int], list[tuple[Any, float, float]]] = collections.defaultdict(list)

    def add(self, key: Any, x: float, y: float) -> None:
        self._cells[(int(math.floor(x / self.cell)), int(math.floor(y / self.cell)))].append((key, x, y))

    def add_bbox(self, key: Any, minx: float, miny: float, maxx: float, maxy: float, *, cap: int = 400) -> bool:
        """Insert an *area* feature into every cell its bbox touches.

        Returns False (and inserts nothing) when the feature would occupy more than
        `cap` cells — the caller keeps those few huge features in a linear-scan
        fallback list so one statewide multipolygon cannot blow up the index.
        """
        x0, x1 = int(math.floor(minx / self.cell)), int(math.floor(maxx / self.cell))
        y0, y1 = int(math.floor(miny / self.cell)), int(math.floor(maxy / self.cell))
        if (x1 - x0 + 1) * (y1 - y0 + 1) > cap:
            return False
        cx = (minx + maxx) / 2
        cy = (miny + maxy) / 2
        for gx in range(x0, x1 + 1):
            for gy in range(y0, y1 + 1):
                self._cells[(gx, gy)].append((key, cx, cy))
        return True

    def near(self, x: float, y: float, radius: float) -> list[tuple[Any, float, float]]:
        """Every indexed item within `radius` of (x, y), sorted by key."""
        gx, gy = int(math.floor(x / self.cell)), int(math.floor(y / self.cell))
        out: list[tuple[Any, float, float]] = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for item in self._cells.get((gx + dx, gy + dy), ()):
                    if math.dist((x, y), (item[1], item[2])) <= radius:
                        out.append(item)
        out.sort(key=lambda it: str(it[0]))
        return out

    def near_keys(self, x: float, y: float, radius: float) -> list[Any]:
        """Just the keys from `near()`, deduplicated, sorted."""
        seen = {it[0] for it in self.near(x, y, radius)}
        return sorted(seen, key=str)


# ═══════════════════════════════════════════════════════════════════════════════
# S0 · HTML — the rendering approach
# ═══════════════════════════════════════════════════════════════════════════════
#
# APPROACH: Python f-strings through a small set of helpers, no template files, no
# template engine. `uv run generate.py <url>` from a fresh checkout must work, so
# every byte of markup and CSS lives in this file.
#
# THE ESCAPING CONTRACT — both renderers must follow it exactly:
#
#   * A parameter whose name ends in `_html` receives markup that is ALREADY safe.
#     The helper inserts it verbatim. You build it with other helpers, or you call
#     `esc()` yourself.
#   * Every other string parameter is plain text. The helper calls `esc()` on it.
#   * `esc()` is the only way text becomes markup. There is no "I know this is
#     safe" exception — feed data contains apostrophes, ampersands and, in the wild,
#     angle brackets.
#   * Attribute values always go through `attrs()`, which escapes them.
#
# Only WebAwesome 3.10 components that the drafts already use (or that pages.md
# explicitly sanctions) get a helper. If there is no helper for it, it is not on
# the sanctioned list — do not invent one.


def esc(value: Any) -> str:
    """HTML-escape any value, including quotes. The single entry point for text."""
    return html.escape("" if value is None else str(value), quote=True)


def attrs(**kwargs: Any) -> str:
    """Render keyword arguments as HTML attributes, escaped, in sorted key order.

    `None` and `False` drop the attribute; `True` renders it bare (`pill`). Trailing
    underscores are stripped and inner underscores become hyphens, so `class_` →
    `class` and `index_axis` → `index-axis`. Sorted keys keep the output byte-stable.
    """
    parts: list[str] = []
    for raw_key in sorted(kwargs):
        v = kwargs[raw_key]
        if v is None or v is False:
            continue
        key = raw_key.rstrip("_").replace("_", "-")
        parts.append(key if v is True else f'{key}="{esc(v)}"')
    return (" " + " ".join(parts)) if parts else ""


def el(tag: str, content_html: str = "", **kwargs: Any) -> str:
    """A generic element: `el('p', esc(text), class_='wa-body-s')`."""
    return f"<{tag}{attrs(**kwargs)}>{content_html}</{tag}>"


def void(tag: str, **kwargs: Any) -> str:
    """A void element: `void('img', src=...)`."""
    return f"<{tag}{attrs(**kwargs)}>"


def join(*chunks: str | None) -> str:
    """Concatenate markup chunks, dropping Nones and empties. Newline-separated."""
    return "\n".join(c for c in chunks if c)


# ── WebAwesome component helpers ──────────────────────────────────────────────

def wa_icon(name: str, *, label: str = "", **kwargs: Any) -> str:
    """`<wa-icon>` — Font Awesome Free **solid**; the kit autoloads the element.

    `label` is the accessible name. Omit it for a decorative icon sitting beside text
    that already says the same thing; supply it for an icon-only control. An icon is
    never the only channel for a status — that is what `chip()` enforces.
    """
    return el("wa-icon", "", name=name, label=(label or None), **kwargs)


def wa_card(body_html: str, *, header_html: str = "", footer_html: str = "",
            image_html: str = "", class_: str = "", **kwargs: Any) -> str:
    """`<wa-card>` with optional header/footer/image slots.

    Passing a header or footer adds the `with-header` / `with-footer` attributes,
    which WebAwesome requires for the slot to be laid out.
    """
    slots = join(
        el("div", image_html, slot="media") if image_html else "",
        el("div", header_html, slot="header") if header_html else "",
        body_html,
        el("div", footer_html, slot="footer") if footer_html else "",
    )
    return el("wa-card", slots, class_=class_ or None,
              with_header=bool(header_html), with_footer=bool(footer_html),
              with_image=bool(image_html), **kwargs)


def wa_callout(body_html: str, *, variant: str = "neutral", appearance: str = "filled-outlined",
               icon: str | None = None, **kwargs: Any) -> str:
    """`<wa-callout>`. `variant` ∈ brand | success | warning | danger | neutral."""
    inner = join(wa_icon(icon, slot="icon") if icon else "", body_html)
    return el("wa-callout", inner, variant=variant, appearance=appearance, **kwargs)


def wa_tag(text: str, *, variant: str = "neutral", appearance: str = "outlined",
           size: str = "small", pill: bool = True, icon: str = "", **kwargs: Any) -> str:
    """`<wa-tag>` — a static label chip. Text is escaped.

    `icon` prepends a `<wa-icon>` in the tag's default slot; `wa-tag` has no `start`
    slot, and its `:host` gap spaces the icon from the word. Prefer `chip()` whenever
    the tag is carrying a *status*, which must never be colour alone.
    """
    inner = join(wa_icon(icon) if icon else "", esc(text))
    return el("wa-tag", inner, variant=variant, appearance=appearance, size=size, pill=pill, **kwargs)


def wa_badge(text: str, *, variant: str = "brand", appearance: str = "filled",
             pill: bool = True, **kwargs: Any) -> str:
    """`<wa-badge>` — a count or status pip. Text is escaped."""
    return el("wa-badge", esc(text), variant=variant, appearance=appearance, pill=pill, **kwargs)


def wa_button(text: str, *, variant: str = "neutral", appearance: str = "outlined",
              size: str = "small", icon: str = "", **kwargs: Any) -> str:
    """`<wa-button>`. Text is escaped. `icon` fills the button's `start` slot."""
    inner = join(wa_icon(icon, slot="start") if icon else "", esc(text))
    return el("wa-button", inner, variant=variant, appearance=appearance, size=size, **kwargs)


def wa_details(summary: str, body_html: str, **kwargs: Any) -> str:
    """`<wa-details>` disclosure. `summary` is plain text and is escaped."""
    return el("wa-details", body_html, summary=summary, **kwargs)


def wa_divider(**kwargs: Any) -> str:
    """`<wa-divider>`."""
    return el("wa-divider", "", **kwargs)


def wa_scroller(body_html: str, *, orientation: str = "horizontal", **kwargs: Any) -> str:
    """`<wa-scroller>` — wraps wide tables and charts. Never wrap a map in one; it
    breaks MapLibre's sizing (the drafts carry this comment and it is correct)."""
    return el("wa-scroller", body_html, orientation=orientation, **kwargs)


def wa_progress_bar(value: float, *, label: str = "", **kwargs: Any) -> str:
    """`<wa-progress-bar>`; `value` is 0..100 and is rounded to one place."""
    return el("wa-progress-bar", "", value=num(value, 1, comma=False), label=label or None, **kwargs)


def wa_progress_ring(value: float, *, label: str = "", inner_html: str = "", **kwargs: Any) -> str:
    """`<wa-progress-ring>`; `value` is 0..100. `inner_html` fills the centre."""
    return el("wa-progress-ring", inner_html, value=num(value, 1, comma=False), label=label or None, **kwargs)


def wa_switch(label: str, *, checked: bool = False, size: str = "small", **kwargs: Any) -> str:
    """`<wa-switch>`. Label text is escaped."""
    return el("wa-switch", esc(label), checked=checked or None, size=size, **kwargs)


def wa_tooltip(target_id: str, text: str, **kwargs: Any) -> str:
    """`<wa-tooltip for="…">`. Use `bindTT` instead for MapLibre/SVG hover, which
    cannot anchor a real tooltip element."""
    return el("wa-tooltip", esc(text), for_=target_id, **kwargs)


def wa_radio_group(name: str, options: Sequence[tuple[str, str]], *, value: str = "",
                   label: str = "", orientation: str = "horizontal", size: str = "small",
                   **kwargs: Any) -> str:
    """`<wa-radio-group>` of `(value, label)` pairs, both escaped."""
    radios = "".join(el("wa-radio", esc(lbl), value=val) for val, lbl in options)
    return el("wa-radio-group", radios, name=name, value=value or None,
              label=label or None, orientation=orientation, size=size, **kwargs)


def wa_copy_button(payload: str, *, label: str = "Copy", **kwargs: Any) -> str:
    """`<wa-copy-button>` carrying `payload` as its `value` (escaped as an attribute).

    Used for the border GeoJSON: the rulebook's hard requirement is that every
    player uses the *exact same* border, so it has to be copy-pasteable.
    """
    return el("wa-copy-button", "", value=payload, copy_label=label, **kwargs)


def wa_sparkline(values: Sequence[float], **kwargs: Any) -> str:
    """`<wa-sparkline>` over a numeric series (per-zone departure profile)."""
    return el("wa-sparkline", "", value=",".join(num(v, 2, comma=False) for v in values), **kwargs)


def wa_chart(chart_type: str, config_json: str, **kwargs: Any) -> str:
    """`<wa-chart>` with an inline Chart.js config.

    `config_json` must come from `jdump()` so the markup is byte-stable. Chart.js
    paints to a canvas and cannot resolve `var(--x)`, so colours must be resolved
    at draw time in page script via `cssVar()` — see the drafts' `ttDecor` plugin.
    """
    return el("wa-chart", el("script", config_json, type="application/json"), type=chart_type, **kwargs)


def wa_tab_group(tabs: Sequence[tuple[str, str, str]], **kwargs: Any) -> str:
    """`<wa-tab-group>` from `(panel_name, tab_label, panel_html)` triples.

    Defined, deliberately unused. A tab hides n−1 panels from Ctrl+F and from print,
    puts no state in the URL, and cannot hold a map or a canvas here (see
    `wa_accordion`). A collapsed accordion label still shows its content's headline;
    an inactive tab shows nothing.
    """
    heads = "".join(el("wa-tab", esc(label), panel=name) for name, label, _ in tabs)
    panels = "".join(el("wa-tab-panel", body, name=name) for name, _, body in tabs)
    return el("wa-tab-group", heads + panels, **kwargs)


def wa_accordion(items: Sequence[tuple[str, str, str, bool]], *,
                 mode: str = "single-collapsible", appearance: str = "plain",
                 heading_level: str = "4", **kwargs: Any) -> str:
    """A grouped disclosure list. `items` are `(item_id, label_html, body_html, expanded)`.

    `label_html` fills each item's `label` slot, so a *collapsed* label can still carry
    a progress bar or a badge — which is the whole point of preferring this to tabs.
    `item_id` becomes the item's `id`, so a `#fragment` addresses it and
    `openTargeted()` expands every ancestor disclosure before scrolling.

    NEVER put a map or a chart inside one. MapLibre and Chart.js read their container
    size once, at construction, a collapsed item has none, and nothing in this file
    ever calls `.resize()` — the same reason `wa_scroller` forbids it.
    """
    body = "".join(
        el("wa-accordion-item",
           el("div", label_html, slot="label",
              class_="wa-split wa-align-items-center wa-gap-s", style="flex:1") + body_html,
           id=(item_id or None), expanded=(True if expanded else None))
        for item_id, label_html, body_html, expanded in items)
    return el("wa-accordion", body, mode=mode, appearance=appearance,
              heading_level=heading_level, **kwargs)


def wa_button_group(buttons_html: str, *, label: str, **kwargs: Any) -> str:
    """`<wa-button-group>` — a segmented control. `label` is announced, never shown."""
    return el("wa-button-group", buttons_html, label=label, **kwargs)


# ── design primitives: the three tiers (grade · rubric · evidence) ────────────

def chip(text: str, icon_name: str = "", *, variant: str = "neutral",
         appearance: str = "outlined", **kwargs: Any) -> str:
    """A status chip: icon **and** word, never colour alone.

    The only sanctioned way to render a question status, a curse action, a finding
    severity or a metric source on either page. The reason is measured: against the
    warm-paper surface `--warn` is 1.66:1, `--gold` 1.96:1 and `--q-edge` 2.07:1, all
    under the 3:1 non-text floor, so the hue cannot carry the signal by itself. Those
    hues are the page's identity and stay; the word and the icon are the redundancy.

    `appearance` is `wa-tag`'s, which has no `plain`: use `outlined` (the default),
    `filled`, `filled-outlined` or `accent`. Anything else is silently ignored and
    renders as the default.
    """
    return wa_tag(text, variant=variant, appearance=appearance, icon=icon_name, **kwargs)


def meter(label_html: str, value_pct: float, right_html: str, *,
          flank: str = "6rem", **kwargs: Any) -> str:
    """A label / track / value row — the rubric tier's workhorse.

    `value_pct` is 0–100 and is computed by the caller, never here. `label_html` and
    `right_html` are markup. Rubric is never collapsed: it is what makes a headline
    number checkable rather than decorative.
    """
    left = el("div", join(label_html, wa_progress_bar(value_pct)), class_="wa-stack wa-gap-3xs")
    return el("div", join(left, right_html),
              class_="wa-flank:end wa-gap-s wa-align-items-center",
              style=f"--flank-size:{flank}", **kwargs)


def budget_bar(segments: Sequence[tuple[str, float, str]], total: float, *,
               aria_label: str, remainder_tip: str = "",
               variants: Sequence[str] = (), **kwargs: Any) -> str:
    """The Points Budget — a segmented bar, and the page's one bespoke class.

    `segments` are `(letter, value, tip_text)` triples whose values sum to at most
    `total`; each segment's flex-grow is its share of `total`, carried as `--v`. If
    the segments fall short a final un-earned segment is appended in the de-emphasis
    grey. `tip_text` is plain and lands in `data-tip`, which `bindTT` reads — the same
    path `#hwmap .cell[data-tip]` already uses.

    `variants` is optional and parallel to `segments`: each entry is a WebAwesome
    variant utility (`success`, `warning`, `danger`, `brand`, `neutral`) whose class
    re-points `--wa-color-fill-loud` / `--wa-color-on-loud` on that one segment. Use it
    only when the segments encode *state* and something beside the bar is acting as a
    colour legend; leave it empty when they encode identity, where one hue is correct.

    `wa-progress-bar` is a single-fill track and WebAwesome has no stacked bar, which
    is why this is CSS. Never nest one inside a disclosure: it is rubric, not evidence.
    """
    spans = [el("span", esc(letter), style=f"--v:{num(value / total * 100, 2, comma=False)}",
                class_=(f"wa-{variants[i]}" if i < len(variants) else None),
                data_tip=tip)
             for i, (letter, value, tip) in enumerate(segments)]
    used = sum(value for _letter, value, _tip in segments)
    if used < total - 1e-9:
        spans.append(el("span", "", data_off=True, data_tip=(remainder_tip or None),
                        style=f"--v:{num((total - used) / total * 100, 2, comma=False)}"))
    return el("div", "".join(spans), class_="budget", role="img",
              aria_label=aria_label, **kwargs)


def search_input(input_id: str, *, placeholder: str, label: str) -> str:
    """A native `<input type="search">`, skinned by WebAwesome's `native.css`.

    A real `<wa-input>` would add a custom element per table for no gain, and the
    native control stays usable with scripting off.
    """
    return el("label", join(
        el("span", esc(label), class_="wa-visually-hidden"),
        void("input", type="search", id=input_id, class_="wa-input", placeholder=placeholder),
    ))


def pull_quote(text: str, *, attribution: str = "") -> str:
    """The page's one counter-intuitive claim, set as an editorial pull quote.

    `native.css` already gives `<blockquote>` its leading border, quiet colour and
    serif face, so this costs no CSS. Exactly one per page.
    """
    cite = (el("footer", esc(attribution), class_="wa-caption-s wa-color-text-quiet")
            if attribution else "")
    return el("blockquote", el("p", esc(text), class_="wa-longform-xl") + cite)


# ── page-level composition helpers ────────────────────────────────────────────

def section(section_id: str, number: str, title: str, body_html: str, *,
            kicker: str = "", lede: str = "", answer_html: str = "",
            answer_variant: str = "neutral", answer_icon: str = "circle-info") -> str:
    """A numbered editorial `<section>` with the drafts' heading treatment.

    `number` renders through `h2[data-n]::before`, so it exists only as an attribute
    and never as text a screen reader has to read twice.

    `answer_html` is ONE plain-English sentence carrying the two or three numbers that
    matter, set as a quiet tinted strip above the evidence. Every number in it must
    already be produced by an existing helper or `Report` field — a renderer chooses
    where a value appears and what word labels it, never what it is.
    """
    head = join(
        el("p", esc(kicker), class_="kicker wa-caption-s wa-text-uppercase") if kicker else "",
        el("h2", esc(title), class_="wa-heading-2xl", data_n=number),
        el("p", esc(lede), class_="wa-body-l") if lede else "",
    )
    answer = (wa_callout(answer_html, variant=answer_variant, appearance="plain", icon=answer_icon)
              if answer_html else "")
    return el("section",
              join(el("header", head, class_="wa-stack wa-gap-3xs"), answer, body_html),
              id=section_id, class_="wa-stack wa-gap-l")


def subhead(text: str, *, anchor_id: str = "") -> str:
    """A small quiet subheading inside a section. `anchor_id` makes it a nav target."""
    return el("h3", esc(text), id=(anchor_id or None),
              class_="wa-heading-s wa-color-text-quiet wa-text-uppercase")


def kpi(value: str, label: str, note_html: str = "", *, chip_html: str = "") -> str:
    """The drafts' stat-tile inner block: big number, caption, optional note.

    `chip_html` sits under the value — it is where a "changes by day" chip goes, so
    the gold top rule on a day-sensitive tile carries a word as well as a colour.
    """
    return el("div", join(
        el("span", esc(value), class_="wa-heading-2xl", style="font-family:var(--sans)"),
        el("span", esc(label), class_="wa-caption-xs wa-text-uppercase"),
        chip_html,
        el("span", note_html, class_="wa-body-s wa-color-text-quiet") if note_html else "",
    ), class_="wa-stack wa-gap-3xs")


def prov_chip(*ids: str) -> str:
    """A provenance chip — the drafts' superscript citation mechanism, repurposed.

    Every printed number carries the id of the metric or Overpass query that produced
    it; the chip links to that row in the score trace or the provenance section, both
    of which the sources index gives a named home. This is how "every point traces to
    a named metric" actually reaches the UI.
    """
    good = [i for i in ids if i]
    if not good:
        return ""
    links = ",".join(el("a", esc(i), class_="wa-link", href=f"#prov-{i}",
                        title=f"Where this number comes from: {i}") for i in good)
    return el("sup", links, data_cite=True)


def data_table(headers: Sequence[str], rows: Sequence[Sequence[str]], *,
               class_: str = "", scrollable: bool = True, **kwargs: Any) -> str:
    """A `<table>` from plain-text headers and **pre-escaped** row cells.

    Row cells are markup (so a cell can hold a `wa-tag`); headers are text. Wrapped
    in a `wa-scroller` by default because long tables must scroll inside their own
    container, never the page body.
    """
    thead = el("thead", el("tr", "".join(el("th", esc(h)) for h in headers)))
    tbody = el("tbody", "".join(el("tr", "".join(el("td", c) for c in row)) for row in rows))
    table = el("table", thead + tbody, class_=class_ or None, **kwargs)
    return wa_scroller(table) if scrollable else table


def json_block(block_id: str, payload: Any, *, float_dp: int = 6) -> str:
    """Embed a payload as `<script type="application/json" id="…">`.

    `</` is escaped so a string containing `</script>` cannot break out. Parsed once
    at the top of the page script; one block per concern, so a huge POI set does not
    have to be parsed to render the verdict.
    """
    text = jdump(payload, float_dp=float_dp).replace("</", "<\\/")
    return el("script", text, type="application/json", id=block_id)


def document(*, title: str, description: str, body_html: str, script_js: str,
             extra_css: str = "",
             nav: Sequence[tuple[str, Sequence[tuple[str, str, str]]]] = ()) -> str:
    """Assemble a complete HTML file.

    Emits the exact WebAwesome kit links, theme classes and colour-scheme script the
    drafts use, then `SHARED_CSS`, then `extra_css`, then the body and the page
    script.

    `nav` is `(group_title, [(href, label, icon_name), …])`. A group whose link list
    is empty emits nothing at all — no orphan heading — mirroring the rule that a
    section which rendered `""` vanishes from the rail with it. Every link keeps
    `data-drawer="close"` so the mobile drawer dismisses itself.

    Each link is a `wa-flank:start` — the utilities skill's "fixed icon next to
    flexible text" media object — and **not** a `wa-cluster`. A cluster is
    `flex-wrap`, so a label wider than the rail is pushed onto its own flex line and
    lands *under* the icon, flush left; the flank gives the label its own column, so
    a two-line label hangs indented and the icon stays put.
    """
    navi = ""
    groups = []
    for group_title, links in nav:
        if not links:
            continue
        anchors = "".join(
            el("a", join(wa_icon(icon, class_="wa-color-text-quiet"), el("span", esc(label))),
               href=href, data_drawer="close",
               class_="wa-flank:start wa-gap-xs wa-align-items-start wa-link-plain")
            for href, label, icon in links)
        groups.append(el("div", join(
            el("span", esc(group_title),
               class_="wa-caption-2xs wa-text-uppercase wa-color-text-quiet"),
            el("div", anchors, class_="wa-stack wa-gap-3xs"),
        ), class_="wa-stack wa-gap-3xs"))
    if groups:
        navi = el("nav", "".join(groups), slot="navigation", class_="wa-stack wa-gap-l")
    return "\n".join([
        "<!DOCTYPE html>",
        '<html lang="en" class="wa-theme-default wa-palette-default wa-light wa-cloak">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<meta name="color-scheme" content="light dark">',
        f'<meta name="description" content="{esc(description)}">',
        f"<title>{esc(title)}</title>",
        f'<link rel="stylesheet" href="{MAPLIBRE_CSS}">',
        f'<link rel="stylesheet" href="{WA_KIT}/styles/themes/default.css" />',
        f'<link rel="stylesheet" href="{WA_KIT}/styles/native.css" />',
        f'<link rel="stylesheet" href="{WA_KIT}/styles/utilities.css" />',
        f'<script type="module" src="{WA_KIT}/webawesome.loader.js"></script>',
        "<style>",
        SHARED_CSS,
        extra_css,
        "</style>",
        "</head>",
        "<body>",
        body_html.replace("<!--NAV-->", navi),
        '<div id="tt"></div>',
        "<script>",
        COLOR_SCHEME_JS,
        "</script>",
        '<script type="module">',
        script_js,
        "</script>",
        "</body>",
        "</html>",
        "",
    ])


# ── verbatim chrome: CSS and the colour-scheme script ─────────────────────────
#
# Comments inside these strings SHIP. The two pages deliberately do not reference
# each other in their output — the report is shareable with the whole group and the
# hider's guide is not — so any note that names the sibling page lives out here, as
# a Python comment, where it stays useful without being served.
#
# Split, for the record: the heatmap, the network map, the central-stop marker, the
# Points Budget, the drop cap and the sources index belong to the report page alone
# and live in INDEX_CSS. Shipping them into the hider's guide was ~19 rules that
# could never match. Likewise `.mk-central` is not in STRATEGY_CSS: only the report
# page's `#netmap` builds that marker (S4's map script), so the four rules that used
# to shadow INDEX_CSS's copy never matched either.

SHARED_CSS = r"""/* ══ 1. THEME TOKENS — LIGHT ═════════════════════════════════════════════ */
:where(:root), .wa-light, .wa-dark .wa-invert {
  /* type */
  --wa-font-family-body:     "Charter", "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
  --wa-font-family-heading:  "Charter", "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
  --wa-font-family-longform: "Charter", "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
  --wa-font-family-code:     ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  --wa-font-size-scale: 1.0625;          /* base 17px, matches the old body */
  --wa-line-height-normal: 1.62;
  --wa-font-weight-heading: 700;
  --wa-font-weight-action: 700;
  --wa-link-decoration-default: none;
  --wa-link-decoration-hover: underline;

  /* shape + rhythm */
  --wa-border-radius-scale: 1.25;        /* 10–12px cards, as before */
  --wa-content-spacing: var(--wa-space-l);

  /* surfaces & text — the warm-paper identity */
  --wa-color-surface-default: #f4f4ef;
  --wa-color-surface-raised:  #fcfcf9;
  --wa-color-surface-lowered: #eaeae2;
  --wa-color-surface-border:  #e2ded2;
  --wa-color-text-normal: #191713;
  --wa-color-text-quiet:  #57534a;
  --wa-color-text-link:   #1c5cab;
  --wa-color-shadow: #191713;
  --wa-color-focus:  #2a78d6;

  /* variant colours — exact hues from the old palette */
  --wa-color-brand-fill-loud:   #2a78d6;
  --wa-color-brand-on-loud:     #ffffff;
  --wa-color-success-fill-loud: #0ca30c;
  --wa-color-success-on-loud:   #ffffff;
  --wa-color-success-on-quiet:  #006300;
  --wa-color-warning-fill-loud: #fab219;
  --wa-color-warning-on-loud:   #3a2800;
  --wa-color-warning-on-quiet:  #8a5c00;
  --wa-color-danger-fill-loud:  #d03b3b;
  --wa-color-danger-on-loud:    #ffffff;
  --wa-color-danger-on-quiet:   #b02a2a;

  /* ── legacy aliases: READ BY SVG CHART + MAP JS. Do not rename in JS. ── */
  --paper:      var(--wa-color-surface-default);
  --surface:    var(--wa-color-surface-raised);
  --surface-2:  var(--wa-color-surface-lowered);
  --ink:        var(--wa-color-text-normal);
  --ink-2:      var(--wa-color-text-quiet);
  --ink-3:      #8d887c;                       /* identical in both schemes */
  --grid:       var(--wa-color-surface-border);
  --baseline:   #c6c1b2;
  --accent:     var(--wa-color-brand-fill-loud);
  --accent-ink: var(--wa-color-text-link);
  --good:       var(--wa-color-success-fill-loud);
  --good-text:  var(--wa-color-success-on-quiet);
  --warn:       var(--wa-color-warning-fill-loud);
  --warn-text:  var(--wa-color-warning-on-quiet);
  --crit:       var(--wa-color-danger-fill-loud);
  --crit-text:  var(--wa-color-danger-on-quiet);
  /* WA has four family roles — body, heading, code, longform — and no UI role, so
     this one is ours and stays out of the reserved --wa-* namespace. */
  --sans:  system-ui, -apple-system, "Segoe UI", sans-serif;
  --serif: var(--wa-font-family-longform);
  --mono:  var(--wa-font-family-code);

  /* ── semantic chart colours WA has no token for ── */
  --gold: #eda100; --gold-mark: #eda100; --gold-deep: #a86e00;
  --off: #a49f92;
  --seq-100:#cde2fb; --seq-200:#9ec5f4; --seq-300:#6da7ec;
  --seq-400:#3987e5; --seq-550:#1c5cab; --seq-650:#104281;
  --serious: #ec835a; --serious-text: #9c3d16;
  --q-yes:#2e9d5b; --q-no:#d1495b; --q-edge:#e0a000; --q-un:#7a8899;
}

/* ══ 2. THEME TOKENS — DARK ══════════════════════════════════════════════ */
.wa-dark, .wa-invert {
  --wa-color-surface-default: #12110e;
  --wa-color-surface-raised:  #1b1a16;
  --wa-color-surface-lowered: #24221c;
  --wa-color-surface-border:  #2c2a24;
  --wa-color-text-normal: #f2efe6;
  --wa-color-text-quiet:  #c3beb0;
  --wa-color-text-link:   #6da7ec;
  --wa-color-shadow: #000000;
  --wa-color-focus:  #3987e5;
  --wa-color-brand-fill-loud:  #3987e5;
  --wa-color-success-on-quiet: #3fc43f;
  --wa-color-warning-on-quiet: #fab219;
  --wa-color-danger-on-quiet:  #e66767;
  --baseline: #3b3830;
  --gold-mark: #c98500; --gold-deep: #c98500;
  --off: #5f5a4f;
  --serious-text: #ec835a;
  --q-yes:#3db374; --q-no:#e0616f; --q-edge:#d9a50a; --q-un:#8b99aa;
  /* the sequential ramp re-anchors on the dark surface (more service = lighter).
     Measured against --wa-color-surface-raised #1b1a16: 13.29 · 10.17 · 7.52 · 5.31
     · 3.53 · 2.22:1, monotone in lightness. Unanchored, --seq-650 sat at 1.90:1 and
     the worst-frequency bin vanished. */
  --seq-100:#cfe3fa; --seq-200:#a5c9f4; --seq-300:#7aaeea;
  --seq-400:#5590dc; --seq-550:#3771bd; --seq-650:#24528f;
}

/* ══ 3. UI VOICE — serif reading text, sans chrome (the page's identity) ══ */
/* Custom properties inherit through shadow DOM; this is the reliable lever. */
/* .wa-heading-s / -xs are chrome (card titles, subheads, stat values, chart titles);
   .wa-heading-2xl / -4xl are reading text (h1 + section titles) and stay serif. */
wa-button, wa-tag, wa-badge, wa-radio, wa-radio-group, wa-switch, wa-input, wa-select,
wa-callout, wa-details, wa-progress-bar, [class*="wa-caption-"],
.wa-heading-s, .wa-heading-xs, th {
  --wa-font-family-body: var(--sans);
  font-family: var(--sans);
}
sup[data-cite] { font-family: var(--sans); font-size: 10px; font-weight: 700; }

/* ══ 4. PAGE FURNITURE ════════════════════════════════════════════════════ */
html { scroll-behavior: smooth; scroll-padding-top: 7rem; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
html, body { min-height: 100%; padding: 0; margin: 0; }
body { background-image: radial-gradient(color-mix(in srgb, var(--ink) 3%, transparent) 1px, transparent 1px);
       background-size: 22px 22px; }                          /* one rule, both schemes */
wa-page { --menu-width: 15rem; --content-width: 1080px; }     /* group headings + icons need the width */
wa-page[view='mobile'] { --menu-width: auto; }
wa-page::part(main-content) { padding-inline: 0; }
/* wa-card's :host paints --wa-color-surface-default, i.e. the body colour; every
   panel in this design is a raised surface, as it was before the migration. */
wa-card { background-color: var(--wa-color-surface-raised); }
/* ---- measure: every band on the page starts at the same x ----
   wa-page's shadow sheet pads its slotted children by three different amounts
   (`::slotted(main)` 3xl, `::slotted([slot='header'])` m, `::slotted([slot='footer'])`
   3xl) and never pads the unslotted hero at all, so a single max-inline-size on its
   own leaves four different content edges. Declarations from the outer tree beat
   `::slotted()`, so one gutter is declared here and applied to all of them; the cap
   is on the border box, so identical padding means identical text alignment. */
wa-page { --gutter: var(--wa-space-3xl); }
@media (max-width: 40rem) { wa-page { --gutter: var(--wa-space-m); } }
:where(main, wa-page > header, [slot='subheader'], wa-page > [slot='footer'] > *) {
  max-inline-size: var(--content-width); margin-inline: auto; width: 100%;
  padding-inline: var(--gutter, var(--wa-space-3xl));
}
wa-page > [slot='footer'] { padding-inline: 0; }   /* the gutter belongs to the child */
/* the hero is an unslotted <header>, so wa-page's ::slotted(main) padding never reaches it */
wa-page > header:not([slot]) { padding-block-start: var(--wa-space-3xl); }
section > header > p:last-child { max-inline-size: 72ch; }    /* the one reading-width rule */
:where(td, .wa-heading-2xl, .wa-heading-xl, .wa-heading-l) { font-variant-numeric: tabular-nums; }
main pre { font-family: var(--mono); font-size: 11.5px; line-height: 1.5; white-space: pre-wrap;
           overflow-wrap: anywhere; margin: 0; color: var(--ink-2); }
#daysel::part(form-control) { display: flex; align-items: center; gap: var(--wa-space-s); flex-wrap: wrap; }
#daysel wa-radio[value='sat'] { margin-inline-start: var(--wa-space-xs); }  /* replaces .sep */

/* ---- the sticky status strip and the scrollspy rail ---- */
[slot='subheader'] {
  padding-block: var(--wa-space-2xs);
  border-block-end: 1px solid var(--wa-color-surface-border);
  background: var(--wa-color-surface-raised);
}
/* wa-progress-bar's track has no intrinsic width, so as a bare flex item it collapses;
   the reading bar takes its own full-width line under the strip. */
[slot='subheader'] > wa-progress-bar { flex: 1 1 100%; }
nav[slot='navigation'] a { padding: var(--wa-space-3xs) var(--wa-space-2xs);
                           border-radius: var(--wa-border-radius-m); }
/* The link is a flank (icon column + label column), so the only thing left to fix is
   where the icon sits against a label that wrapped: `wa-align-items-start` pins it to
   the top of the label *block*, and a 1lh-tall canvas re-centres the 1em glyph on the
   first *line*. Balanced wrapping keeps a three-word label from leaving one word
   alone on line two. */
nav[slot='navigation'] a > wa-icon { block-size: 1lh; }
nav[slot='navigation'] a > span { text-wrap: balance; overflow-wrap: break-word; }
nav[slot='navigation'] a[aria-current] {
  color: var(--wa-color-text-normal); font-weight: var(--wa-font-weight-bold);
  background: var(--wa-color-brand-fill-quiet);
}
/* in-section control bars: a filter is never scrolled away from the rows it filters */
#qcontrols, #ccontrols, #zcontrols {
  position: sticky; top: 7rem; z-index: 1;
  background: var(--wa-color-surface-default); padding-block: var(--wa-space-2xs);
}
@media (max-width: 560px) { #qcontrols, #ccontrols, #zcontrols { position: static; } }

/* ══ 5. EDITORIAL DECORATION (identity; WA has no equivalent) ═════════════ */
  .kicker { color: var(--gold-deep); }
  .kicker::before { content: ""; display: inline-block; width: 34px; height: 3px; background: var(--gold); margin-right: 10px; vertical-align: middle; border-radius: 2px; }
  /* the ordinal is the wayfinding cue and stays, but the monospace tell goes: it is
     the loudest "machine-generated" signal on an otherwise editorial page. */
  h2[data-n]::before { content: attr(data-n); color: var(--wa-color-text-quiet); margin-right: 10px;
                       font-family: inherit; font-size: var(--wa-font-size-l);
                       font-weight: var(--wa-font-weight-normal); }
  .sw { display: inline-block; width: 11px; height: 11px; border-radius: 3px; flex: none; }
  /* a flex/grid parent blockifies the <li> and can drop its marker, so the recs
     list stays in normal flow and spaces itself. */
  ol.recs { list-style: decimal-leading-zero; padding-inline-start: 3ch; }
  ol.recs li:has(+ li) { margin-block-end: var(--wa-space-s); }
  ol.recs li::marker { font-family: var(--mono); font-weight: 700; color: var(--gold-deep); }
  /* the accent rail keys off the WA colour utility the card already carries */
  wa-card.wa-success, wa-card.wa-danger, wa-card.wa-brand, wa-card.wa-warning {
    border-inline-start-width: var(--wa-border-width-l);
    border-inline-start-color: var(--wa-color-fill-loud);
  }
  wa-card[data-day-sensitive] { border-block-start: var(--wa-border-width-l) solid var(--gold); }
  wa-card[data-today] { outline: var(--wa-border-width-m) solid var(--crit); }
  /* the day-sensitive cue is a word, not a colour: both chips ship, one is shown */
  [data-today-cue='on'], wa-card[data-today] [data-today-cue='off'] { display: none; }
  wa-card[data-today] [data-today-cue='on'] { display: inline-flex; }

/* ══ 6. CHART / MAP INTERNALS — hand-rolled SVG + MapLibre. Permanent keeps. ══ */
  /* MapLibre feature-hover cannot anchor a <wa-tooltip>; bindTT reads offsetWidth. */
  #tt {
    position: fixed; z-index: 100; pointer-events: none; display: none; max-width: 320px;
    background: var(--ink); color: var(--paper); font-family: var(--sans); font-size: 12.5px; line-height: 1.45;
    padding: 8px 11px; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.3);
  }
  #tt b { display: block; margin-bottom: 2px; }

  /* MapLibre's own controls live outside WA and outside shadow DOM; both maps skin
     them identically, so the block is written once. */
  :is(#netmap, #zmap).dark-map .maplibregl-ctrl-group { background: #24221c; box-shadow: 0 0 0 1.5px rgba(242,239,230,.12); }
  :is(#netmap, #zmap).dark-map .maplibregl-ctrl button .maplibregl-ctrl-icon { filter: invert(.9) hue-rotate(180deg); }
  :is(#netmap, #zmap).dark-map .maplibregl-ctrl-attrib { background: rgba(27,26,22,.75); }
  :is(#netmap, #zmap).dark-map .maplibregl-ctrl-attrib, :is(#netmap, #zmap).dark-map .maplibregl-ctrl-attrib a { color: #c3beb0; }
  :is(#netmap, #zmap).dark-map .maplibregl-ctrl-scale { background: rgba(27,26,22,.6); color: #c3beb0; border-color: #8d887c; }
"""

STRATEGY_CSS = r"""/* ---- strategy.html only ---- */
#zmap { border-radius: 8px; overflow: hidden; background: var(--surface-2); }
#zmap.maplibregl-map { min-width: 0; }
.mk { cursor: pointer; } /* must not override maplibregl-marker's position:absolute */
.mk:hover, .mk[data-sel] { z-index: 5; }
.mk .lbl {
  position: absolute; white-space: nowrap; font: 700 11px var(--sans); color: var(--ink); pointer-events: none;
  background: color-mix(in srgb, var(--surface) 78%, transparent); padding: 1px 6px; border-radius: 5px;
  left: 50%; bottom: 100%; transform: translateX(-50%); margin-bottom: 3px;
}

/* ---- polygon-zone label pills ---- */
.mk.zlabel { width: 0; height: 0; }
.mk.zlabel .lbl { left: 50%; top: 50%; right: auto; bottom: auto; transform: translate(-50%, -50%); margin: 0;
  pointer-events: auto; cursor: pointer; border: 1.5px solid transparent; box-shadow: 0 1px 4px rgba(0,0,0,.18); }
.mk.zlabel .lbl b { font-family: var(--mono); font-weight: 800; }
.mk.zlabel .md { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; background: var(--accent); }
.mk.zlabel.gold .md { background: var(--gold-mark); }
.mk.zlabel.crit .md { background: var(--crit); }
.mk.zlabel[data-answer='yes'] .md { background: var(--q-yes); } .mk.zlabel[data-answer='yes'] .lbl { border-color: var(--q-yes); }
.mk.zlabel[data-answer='no'] .md { background: var(--q-no); }   .mk.zlabel[data-answer='no'] .lbl { border-color: var(--q-no); }
.mk.zlabel[data-answer='edge'] .md { background: var(--q-edge); } .mk.zlabel[data-answer='edge'] .lbl { border-color: var(--q-edge); }
.mk.zlabel[data-answer='un'] .md { background: var(--q-un); }   .mk.zlabel[data-answer='un'] .lbl { border-color: var(--q-un); }
.mk.zlabel[data-sel] .lbl { outline: 3px solid color-mix(in srgb, var(--accent) 45%, transparent); }
.mk.zlabel[data-off] .md { background: var(--off); }
.mk.zlabel[data-off] .lbl { color: var(--ink-3); }
/* the .dark-map MapLibre-control block is shared with #netmap and lives in SHARED_CSS §6 */

/* ---- question-overlay markers ---- */
.mk .qb { display: inline-block; margin-left: 5px; padding: 0 4px; border-radius: 4px; font: 700 10px var(--mono); background: var(--surface-2); color: var(--ink-2); }
.mk.q-yes .qb { background: color-mix(in srgb, var(--q-yes) 18%, var(--surface)); color: var(--q-yes); }
.mk.q-no .qb { background: color-mix(in srgb, var(--q-no) 18%, var(--surface)); color: var(--q-no); }
.mk.q-edge .qb { background: color-mix(in srgb, var(--q-edge) 20%, var(--surface)); color: var(--q-edge); }
.mk-seeker { width: 30px; height: 30px; cursor: grab; z-index: 6; }
.mk-seeker:active { cursor: grabbing; }
.mk-seeker .cross {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font: 800 30px/1 var(--sans); color: var(--ink); text-shadow: 0 0 4px var(--surface), 0 0 8px var(--surface);
}
.mk-seeker .slbl {
  position: absolute; left: 50%; top: 100%; transform: translateX(-50%); margin-top: 1px; white-space: nowrap;
  font: 700 10.5px var(--sans); color: var(--ink); background: color-mix(in srgb, var(--surface) 82%, transparent); padding: 0 5px; border-radius: 4px; pointer-events: none;
}

/* ---- ranked zone rows: a JS-built grid row, so hover/selected/off stay CSS ---- */
.zrow { display: grid; grid-template-columns: 26px minmax(0,1fr) 120px 52px; gap: 10px; align-items: center; background: var(--surface); border: 1px solid var(--grid); border-radius: 9px; padding: 9px 12px; cursor: pointer; font-family: var(--sans); }
.zrow:hover { border-color: var(--accent); }
.zrow[aria-selected='true'] { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent); }
.zrow[data-off] { opacity: .55; }
.zrow[data-off]:hover { border-color: var(--grid); }

/* ---- zone dossier: the one non-component rule the sticky column needs ---- */
#zdetail { position: sticky; top: 8rem; }"""

COLOR_SCHEME_JS = r"""/* ---- colour scheme: WA classes, host data-theme, OS preference, localStorage ---- */
function applyScheme(dark) { document.documentElement.classList.toggle('wa-dark', dark);
                             document.documentElement.classList.toggle('wa-light', !dark); }
function getPreferredScheme() {
  const host = document.documentElement.dataset.theme;          /* artifact-viewer handoff */
  if (host === 'dark') return true;
  if (host === 'light') return false;
  let saved = null; try { saved = localStorage.getItem('wa-color-scheme'); } catch (e) {}
  if (saved !== null) return saved === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
applyScheme(getPreferredScheme());
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
  let saved = null; try { saved = localStorage.getItem('wa-color-scheme'); } catch (err) {}
  if (!saved && !document.documentElement.dataset.theme) applyScheme(e.matches);
});
new MutationObserver(() => applyScheme(getPreferredScheme()))
  .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
document.getElementById('color-scheme-button').addEventListener('click', () => {
  const toDark = !document.documentElement.classList.contains('wa-dark');
  applyScheme(toDark);
  try { localStorage.setItem('wa-color-scheme', toDark ? 'dark' : 'light'); } catch (e) {}
});"""

# Small JS helpers both pages define at the top of their module script. Emitted
# verbatim by each renderer so the two pages share one implementation.
SHARED_PAGE_JS = r"""
const $  = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const D   = id => JSON.parse(document.getElementById(id).textContent);
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* MapLibre feature-hover cannot anchor a <wa-tooltip>; this reads offsetWidth. */
const tt = $('tt');
function bindTT(el, html) {
  el.addEventListener('mousemove', e => {
    tt.innerHTML = html; tt.style.display = 'block';
    const w = tt.offsetWidth, x = Math.min(e.clientX + 14, innerWidth - w - 12);
    tt.style.left = x + 'px'; tt.style.top = (e.clientY + 16) + 'px';
  });
  el.addEventListener('mouseleave', () => tt.style.display = 'none');
}

/* the two pages share the selected game day through localStorage */
const DAY_KEY = 'jltg-day';
function loadDay(fallback) {
  try { return localStorage.getItem(DAY_KEY) || fallback; } catch (e) { return fallback; }
}
function saveDay(k) { try { localStorage.setItem(DAY_KEY, k); } catch (e) {} }

/* the client-side twin of subhead(): JS-built headings must match server-built ones */
const SUB = t => '<h4 class=' + JSON.stringify('wa-heading-s wa-color-text-quiet wa-text-uppercase')
  + '>' + t + '</h4>';

/* Open whatever the fragment is buried inside, then scroll to it. Without this, every
   #prov-*, #trace-*, #sel-*, #pred-*, #q-*, #c-* and #axis-* link would land on a row
   inside a closed disclosure and appear to do nothing. */
function openTargeted() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) return;
  const t = document.getElementById(id);
  if (!t) return;
  for (let n = t; n && n !== document.body; n = n.parentElement) {
    if (n.localName === 'wa-details') n.open = true;
    else if (n.localName === 'wa-accordion-item') n.setAttribute('expanded', '');
    else if (n.localName === 'wa-tab-panel') {
      const g = n.closest('wa-tab-group');
      if (g) g.setAttribute('active', n.getAttribute('name'));
    }
  }
  requestAnimationFrame(() => t.scrollIntoView({ block: 'center' }));
}
addEventListener('hashchange', openTargeted);

/* Scrollspy: aria-current on the rail link of the section nearest the top, plus the
   status strip's "you are in" readout. One observer, no scroll listener, no timers. */
function bindSpy() {
  const links = [...document.querySelectorAll('nav[slot="navigation"] a[href^="#"]')];
  const pairs = links.map(a => [document.getElementById(a.getAttribute('href').slice(1)), a])
                     .filter(p => p[0]);
  if (!pairs.length || !('IntersectionObserver' in window)) return;
  const out = $('nowat');
  let cur = null;
  const tick = () => {
    let hit = pairs[0];
    for (const p of pairs) if (p[0].getBoundingClientRect().top <= 140) hit = p;
    if (hit[1] === cur) return;
    if (cur) cur.removeAttribute('aria-current');
    cur = hit[1];
    cur.setAttribute('aria-current', 'true');
    if (out) out.textContent = cur.textContent.trim();
  };
  const io = new IntersectionObserver(tick, { rootMargin: '-140px 0px -55% 0px', threshold: [0, 1] });
  pairs.forEach(p => io.observe(p[0]));
  tick();
}

/* Reading-progress bar in the status strip. */
function bindProgress() {
  const bar = $('readbar');
  if (!bar) return;
  const on = () => {
    const h = document.documentElement, d = h.scrollHeight - h.clientHeight;
    bar.value = d > 0 ? Math.min(100, Math.max(0, (h.scrollTop / d) * 100)) : 0;
  };
  addEventListener('scroll', on, { passive: true });
  on();
}
"""


# ═══════════════════════════════════════════════════════════════════════════════
# S1 · GTFS — feed, service, metrics, travel time, inference
# ═══════════════════════════════════════════════════════════════════════════════
#
# Owner: the S1 agent. Spec: scratchpad/specs/gtfs.md (every number in it was
# measured against the reference feed; the prototypes are scratchpad/common.py,
# raptor.py, metrics.py).
#
# Hard-won edge cases this section MUST handle, all observed in the reference feed:
#   * `stop_sequence` is non-contiguous in every trip and starts at 0. Sort by
#     int() and use post-sort position; never use it as an index.
#   * 592 trips revisit a stop (loops). Scan pattern offsets linearly; dedupe to one
#     departure per (trip, stop) before computing headways.
#   * No `calendar.txt` — 38 `calendar_dates` rows, all type 1. Absence of a date is
#     the no-service signal. Both conventions must work.
#   * Times past 24:00 (max 26:15:00) with unpadded hours. Never modulo 86400.
#   * `frequencies.txt` and `transfers.txt` present but header-only.
#   * `parent_station` / `location_type` / `zone_id` empty everywhere — the station
#     concept has to be synthesised.
#   * `utf-8-sig` + `newline=''` are both required; feeds may nest files in a folder.


@dataclass(frozen=True)
class Stop:
    """One GTFS stop (a pole, not a station — see `Station`)."""

    stop_id: str
    name: str
    base_name: str          # directional suffix like ' (NB)' stripped
    lat: float
    lon: float
    code: str = ""
    location_type: str = "0"
    parent_station: str = ""


@dataclass(frozen=True)
class Route:
    """One GTFS route."""

    route_id: str
    short_name: str
    long_name: str
    route_type: int
    color: str = ""

    @property
    def label(self) -> str:
        """Short name if present, else long name, else the id."""
        return self.short_name or self.long_name or self.route_id

    @property
    def is_rail(self) -> bool:
        """route_type in the rail-ish set — kills or enables four questions outright."""
        return self.route_type in {0, 1, 2, 5, 7, 11, 12}


@dataclass
class Feed:
    """A parsed, normalised GTFS feed.

    `tables` holds every `*.txt` as a list of dicts exactly as read (optional columns
    accessed with `.get`). The typed attributes are the normalised views everything
    downstream uses.
    """

    source: str                         # the URL or path given on the command line
    sha256: str
    tables: dict[str, list[dict[str, str]]]
    stops: dict[str, Stop]
    routes: dict[str, Route]
    agency_name: str
    agency_url: str
    timezone: str
    feed_start: str                     # 'YYYYMMDD'
    feed_end: str
    feed_version: str = ""
    publisher: str = ""


@dataclass(frozen=True)
class Station:
    """A synthesised station: a cluster of stops that a player would call one place."""

    station_id: str                     # the lowest member stop_id, for stability
    name: str
    lat: float
    lon: float
    stop_ids: tuple[str, ...]


@dataclass
class DayType:
    """One distinguishable kind of service day in the feed.

    `key` is a stable machine token ('weekday', 'saturday', 'sunday', or 'dow{N}'
    when a feed distinguishes more); `date` is the representative date chosen by
    lower-median trip count, and `dates` is every date of that type in the window.
    """

    key: str
    label: str                          # 'Weekday', 'Saturday', …
    date: str                           # representative 'YYYYMMDD'
    dates: tuple[str, ...]
    service_ids: tuple[str, ...]
    trips: int
    trip_counts: tuple[int, ...]        # per date in `dates`, for the spread report


@dataclass
class StopDay:
    """Per-stop service facts on one service day."""

    stop_id: str
    departures: tuple[int, ...]         # seconds since service-day start, sorted
    routes: tuple[str, ...]             # route_ids, sorted
    first: int | None
    last: int | None
    median_headway_s: float | None      # over HEADWAY_WINDOW, all routes combined
    worst_gap_s: float | None
    frequent: bool                      # some single (route, direction) ≤ 15 min


@dataclass
class ServiceDay:
    """One materialised service day: everything RAPTOR and the metrics need."""

    day_type: DayType
    stop_days: dict[str, StopDay]
    served_stop_ids: tuple[str, ...]
    route_ids: tuple[str, ...]
    trips: int
    stop_events: int
    first_departure: int
    last_departure: int
    # RAPTOR structures — opaque to other sections, built by `build_service_day`.
    patterns: Any = None
    pattern_at_stop: Any = None
    footpaths: Any = None
    stop_index: Any = None


@dataclass
class Journey:
    """A concrete itinerary, for the dossier's "how you get there" panel."""

    minutes: float
    transfers: int
    legs: tuple[dict[str, Any], ...]    # {mode, route, from, to, dep, arr} per contract.md


@dataclass
class TravelTimes:
    """The result of one one-to-all RAPTOR run."""

    origin_stop_ids: tuple[str, ...]
    departure_s: int
    arrival_s: dict[str, int]           # stop_id → earliest arrival; absent = unreachable
    rounds: dict[str, int]              # stop_id → transfers used by the best journey


@dataclass(frozen=True)
class GameSize:
    """The rulebook's size parameters, after inference or `--size`."""

    name: Literal["small", "medium", "large"]
    hiding_period_min: int
    zone_radius_m: float
    tentacle_reach_mi: float
    thermometer_mi: tuple[float, ...]
    category_count: int
    catalogue_size: int                 # 58 / 71 / 80
    photo_limit_min: int
    other_limit_min: int
    move_grant_min: int
    required_hours: float               # scoring.md §1.5
    inferred: bool                      # False when --size forced it


@dataclass
class SizeInference:
    """The four-axis size vote, kept in full because the pages show the disagreement."""

    axes: tuple[dict[str, Any], ...]    # {id, name, value, unit, score, thresholds}
    votes: tuple[int, ...]
    verdict: Literal["small", "medium", "large"]
    unanimous: bool
    clamped: bool
    note: str


@dataclass
class Hub:
    """The inferred round-start station and the network-shape verdict."""

    stop_id: str
    name: str
    lat: float
    lon: float
    route_share: float
    trip_share: float
    shape: Literal["radial-hub", "semi-radial", "polycentric"]
    alternatives: tuple[tuple[str, str], ...]   # (stop_id, name) runners-up
    dominant: bool                              # False ⇒ do not name a single hub


@dataclass
class Border:
    """The map border, as both a box and a circle. The rulebook sanctions both."""

    kind: Literal["bbox", "circle"]
    bbox: tuple[float, float, float, float]     # (S, W, N, E), padded
    raw_bbox: tuple[float, float, float, float]
    circle: tuple[float, float, float]          # (lat, lon, radius_m)
    pad_m: float
    geojson: dict[str, Any]
    area_sq_m: float
    trimmed_stop_ids: tuple[str, ...]           # stops ruled out-of-map, if any


@dataclass
class Zone:
    """One candidate hiding zone: a rulebook circle centred on a designated station."""

    zone_id: str                # == the designated stop_id
    name: str                   # the designated station's display name
    lat: float
    lon: float
    x: float                    # projected metres
    y: float
    stop_ids: tuple[str, ...]   # every served stop inside the circle, sorted
    route_ids: tuple[str, ...]  # every route at any of those stops, sorted
    stop_events: int


# ── S1 functions ──────────────────────────────────────────────────────────────


# ═══════════════════════════════════════════════════════════════════════════════
# S1 · GTFS — implementation
# ═══════════════════════════════════════════════════════════════════════════════
#
# ── Names assumed to be in scope from the skeleton (S0) ───────────────────────
#   constants:  M_PER_MILE M_PER_KM QUARTER_MILE_M HALF_MILE_M SQM_PER_SQMI
#               EARTH_R_M WALK_SPEED_MPS WALK_RADIUS_M WALK_CIRCUITY BOARD_SLACK_S
#               MAX_TRANSFERS DEFAULT_DEPARTURE SERVICE_DAY_SECONDS HEADWAY_WINDOW
#               MIDDAY_WINDOW EVENING_WINDOW FREQUENT_HEADWAY_MIN STATION_CLUSTER_M
#               HUB_SNAP_M T90_ORIGIN_STRIDE RADAR_SAMPLE_PAIRS RADAR_DEAD_HIGH
#               RADAR_DEAD_LOW HUB_RADIAL_MIN HUB_SEMI_RADIAL_MIN USER_AGENT log
#   plumbing:   Options Cache CacheMiss http_fetch Timer
#   numbers:    rhu num pct mins miles km sqmi coord hhmm hhmmss hms_to_s iso_date
#               pretty_date dow_of date_range lower_median quantile jdump
#               sha256_bytes sha256_text
#   geometry:   haversine_m Projection bbox_of bbox_expand bbox_contains convex_hull
#               polygon_area ring_centroid point_in_ring representative_point
#               seg_point_dist ring_within min_enclosing_circle GridIndex
#   dataclasses declared in the skeleton and filled in here:
#               Stop Route Feed Station DayType StopDay ServiceDay Journey
#               TravelTimes GameSize SizeInference Hub Border Zone
#
# ── Third-party imports needed ────────────────────────────────────────────────
#   none beyond the skeleton's own (`httpx` is used only through `http_fetch`).
#   stdlib used: bisect collections csv datetime(dt) io math re statistics zipfile
#   heapq pathlib.Path json — all already imported by the skeleton.
#
# Everything below is pure, sorted and clock-free. The only I/O is `load_feed`,
# which goes through the shared `Cache`.


# ── private constants ─────────────────────────────────────────────────────────

_S1_RAIL_TYPES = frozenset({0, 1, 2, 5, 7, 11, 12})
_S1_DOW_NAMES = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
_S1_DOW_LABELS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
_S1_DIR_SUFFIX = re.compile(r"\s*\((NB|SB|EB|WB)\)$")
_S1_INF = 10 ** 9
_S1_NEG_INF = -(10 ** 9)

# Radar / thermometer probe distances, in miles. Every rulebook radar and
# thermometer tier appears here so `radar_liveness` answers all of them at once.
_S1_RADAR_MILES = (0.25, 0.5, 1.0, 3.0, 5.0, 10.0, 15.0, 25.0, 50.0, 100.0)

# The rulebook's own size parameters (GUIDE.md "Game Size", SEEKING.md question
# tiers). Transcriptions, with one exception: `required_hours` is INFERRED. The
# rulebook gives a size's length only as prose — "lasts 4–8 hours" / "about 1 day" /
# "2 to 4 days" — and never an hours-per-playing-day figure, so 6 / 10 / 12 are ours
# and D1 is tagged `interp` rather than `rulebook`.
_S1_SIZE_PARAMS: dict[str, dict[str, Any]] = {
    "small": dict(hiding_period_min=30, zone_radius_m=QUARTER_MILE_M, tentacle_reach_mi=0.0,
                  thermometer_mi=(0.5, 3.0), category_count=5, catalogue_size=58,
                  photo_limit_min=10, other_limit_min=5, move_grant_min=10, required_hours=6.0),
    "medium": dict(hiding_period_min=60, zone_radius_m=QUARTER_MILE_M, tentacle_reach_mi=1.0,
                   thermometer_mi=(0.5, 3.0, 10.0), category_count=6, catalogue_size=71,
                   photo_limit_min=10, other_limit_min=5, move_grant_min=20, required_hours=10.0),
    "large": dict(hiding_period_min=180, zone_radius_m=HALF_MILE_M, tentacle_reach_mi=15.0,
                  thermometer_mi=(0.5, 3.0, 10.0, 50.0), category_count=6, catalogue_size=80,
                  photo_limit_min=20, other_limit_min=5, move_grant_min=60, required_hours=12.0),
}
_S1_SIZE_ORDER = ("small", "medium", "large")


# ── small private helpers ─────────────────────────────────────────────────────

def _s1_median(values: Sequence[float]) -> float:
    """Median of a *measured distribution* — headways, gaps, travel times.

    This is the ordinary median (`statistics.median`: the mean of the two middle
    values for even n), and it is deliberately **not** `lower_median`. The contract
    reserves `lower_median` for the two places where a tie must resolve *down* to the
    quieter option — representative-day choice and the game-size vote — because there
    the two middle values are alternative realities and averaging them would invent a
    day the feed does not have. A headway distribution is not like that: the middle of
    an even sample is genuinely between the two, and the lower-median variant shifts
    the reference feed's frequent-stop count from 186 to 191 and its ≤30-minute share
    from 57% to 60% against the measured values. `statistics.median` is deterministic.
    """
    return float(statistics.median(values))


def _s1_gaps(times: Sequence[int]) -> list[int]:
    """Consecutive differences of an already-sorted, de-duplicated departure vector."""
    return [b - a for a, b in zip(times, times[1:])]


def _s1_dedupe(pairs: Sequence[tuple[str, int]]) -> list[int]:
    """One departure per trip (the first), sorted.

    592 of the reference feed's 5,620 trips revisit a stop; without this a loop
    terminus reports a fake 0-minute headway.
    """
    seen: dict[str, int] = {}
    for trip_id, t in pairs:
        if trip_id not in seen or t < seen[trip_id]:
            seen[trip_id] = t
    return sorted(seen.values())


def _s1_share(numerator: float, denominator: float) -> float:
    """`n / d`, or 0.0 when the denominator is empty. Keeps every share finite."""
    return (numerator / denominator) if denominator else 0.0


def _s1_base_name(name: str) -> str:
    """Strip a trailing directional suffix: 'Wealthy Street Station (NB)' → '… Station'."""
    return _S1_DIR_SUFFIX.sub("", name or "").strip()


def _s1_is_url(source: str) -> bool:
    return source.startswith("http://") or source.startswith("https://")


def _s1_int(value: str | None, default: int = 0) -> int:
    """Tolerant int(): GTFS fields are text and optional columns arrive blank."""
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def _s1_float(value: str | None) -> float | None:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


# ═══════════════════════════════════════════════════════════════════════════════
# S1 · feed loading and normalisation
# ═══════════════════════════════════════════════════════════════════════════════


def _s1_read_source(source: str, cache: Cache) -> tuple[bytes, str]:
    """Return `(zip_or_dir_bytes, sha256)` for a URL, a .zip path, or a directory.

    A directory is repacked in sorted name order so its hash — and therefore every
    cache key derived from it — is stable.
    """
    if _s1_is_url(source):
        body = http_fetch(cache, kind="gtfs", cache_key=source, ext="zip", endpoints=(source,))
        return body, sha256_bytes(body)

    path = Path(source).expanduser()
    if path.is_dir():
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED) as zf:
            for child in sorted(path.rglob("*.txt")):
                # date_time fixed: a mtime in the archive would break byte-stability
                info = zipfile.ZipInfo(child.relative_to(path).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
                zf.writestr(info, child.read_bytes())
        body = buf.getvalue()
        return body, sha256_bytes(body)

    body = path.read_bytes()
    return body, sha256_bytes(body)


def _s1_parse_tables(body: bytes) -> dict[str, list[dict[str, str]]]:
    """Every `*.txt` in the archive as a list of row dicts.

    `utf-8-sig` strips the BOM that would otherwise rename the first column to
    `'\\ufeffstop_id'`; `newline=''` keeps quoted fields containing CRLF intact;
    `rsplit('/')` tolerates feeds zipped with a top-level directory.
    """
    tables: dict[str, list[dict[str, str]]] = {}
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        for name in sorted(zf.namelist()):
            base = name.rsplit("/", 1)[-1]
            if not base.endswith(".txt") or base.startswith(".") or "__MACOSX" in name:
                continue
            with zf.open(name) as handle:
                reader = csv.DictReader(io.TextIOWrapper(handle, encoding="utf-8-sig", newline=""))
                rows: list[dict[str, str]] = []
                for raw in reader:
                    raw.pop(None, None)                     # ragged rows: drop the restkey
                    rows.append({k: ("" if v is None else v) for k, v in raw.items() if k is not None})
            tables[base[:-4]] = rows
    return tables


def _s1_window_dates(tables: dict[str, list[dict[str, str]]]) -> tuple[str, str]:
    """`(feed_start, feed_end)` from feed_info, else calendar, else calendar_dates."""
    info = tables.get("feed_info") or []
    if info:
        start = (info[0].get("feed_start_date") or "").strip()
        end = (info[0].get("feed_end_date") or "").strip()
        if re.fullmatch(r"\d{8}", start) and re.fullmatch(r"\d{8}", end) and start <= end:
            return start, end

    cal = tables.get("calendar") or []
    starts = [r.get("start_date", "").strip() for r in cal if re.fullmatch(r"\d{8}", r.get("start_date", "").strip())]
    ends = [r.get("end_date", "").strip() for r in cal if re.fullmatch(r"\d{8}", r.get("end_date", "").strip())]
    if starts and ends:
        return min(starts), max(ends)

    dates = sorted({r.get("date", "").strip() for r in (tables.get("calendar_dates") or [])
                    if re.fullmatch(r"\d{8}", r.get("date", "").strip())})
    if dates:
        return dates[0], dates[-1]
    raise ValueError("feed has no feed_info, calendar or calendar_dates dates to derive a window from")


def load_feed(source: str, cache: Cache) -> Feed:
    """Fetch (or open) a GTFS zip and parse every `*.txt` into `Feed`.

    Returns a fully normalised `Feed`: `tables` holds the raw rows, `stops`/`routes`
    the typed views, and `sha256` the hash of the zip bytes (which goes on the page
    as provenance). Reads with `utf-8-sig` and `newline=''`, tolerates files nested
    in a top-level directory, and treats every optional column as optional.
    Downloads are cached at `cache/gtfs/<sha256(url)>.zip`.
    """
    body, digest = _s1_read_source(source, cache)
    tables = _s1_parse_tables(body)
    for required in ("stops", "routes", "trips", "stop_times"):
        if not tables.get(required):
            raise ValueError(f"GTFS feed {source!r} has no usable {required}.txt")

    stops: dict[str, Stop] = {}
    for row in tables["stops"]:
        sid = (row.get("stop_id") or "").strip()
        loc = (row.get("location_type") or "0").strip() or "0"
        if not sid or loc not in ("0", ""):
            continue                                        # 1=station, 2/3/4=entrance/node/area
        lat, lon = _s1_float(row.get("stop_lat")), _s1_float(row.get("stop_lon"))
        if lat is None or lon is None:
            continue
        name = (row.get("stop_name") or sid).strip()
        stops[sid] = Stop(
            stop_id=sid, name=name, base_name=_s1_base_name(name) or name,
            lat=lat, lon=lon, code=(row.get("stop_code") or "").strip(),
            location_type="0", parent_station=(row.get("parent_station") or "").strip(),
        )
    if not stops:
        raise ValueError(f"GTFS feed {source!r} contains no boarding-capable stops")

    routes: dict[str, Route] = {}
    for row in tables["routes"]:
        rid = (row.get("route_id") or "").strip()
        if not rid:
            continue
        routes[rid] = Route(
            route_id=rid,
            short_name=(row.get("route_short_name") or "").strip(),
            long_name=(row.get("route_long_name") or "").strip(),
            route_type=_s1_int(row.get("route_type"), 3),
            color=(row.get("route_color") or "").strip(),
        )

    agencies = tables.get("agency") or [{}]
    tzs = sorted({(a.get("agency_timezone") or "").strip() for a in agencies
                  if (a.get("agency_timezone") or "").strip()})
    if len(tzs) > 1:
        log.warning("feed declares %d agency timezones (%s); using the primary agency's",
                    len(tzs), ", ".join(tzs))

    # A multi-agency feed is not "the first row in agency.txt". MBTA's feed lists Cape
    # Cod RTA first and MBTA second, which named a Boston-wide map after a bus operator
    # 100 km away. Pick the agency that actually runs the most trips; ties break on
    # agency_id so the choice is deterministic. Single-agency feeds are unaffected.
    primary = agencies[0]
    if len(agencies) > 1:
        route_agency = {(r.get("route_id") or "").strip(): (r.get("agency_id") or "").strip()
                        for r in tables["routes"]}
        trips_per_agency: dict[str, int] = collections.Counter()
        for row in tables["trips"]:
            trips_per_agency[route_agency.get((row.get("route_id") or "").strip(), "")] += 1
        ranked = sorted(agencies,
                        key=lambda a: (-trips_per_agency.get((a.get("agency_id") or "").strip(), 0),
                                       (a.get("agency_id") or "").strip()))
        primary = ranked[0]
        log.info("multi-agency feed: %d agencies, using %r (%d of %d trips)",
                 len(agencies), (primary.get("agency_name") or "").strip(),
                 trips_per_agency.get((primary.get("agency_id") or "").strip(), 0),
                 len(tables["trips"]))
    timezone = (primary.get("agency_timezone") or "UTC").strip()

    start, end = _s1_window_dates(tables)
    info = (tables.get("feed_info") or [{}])[0]

    feed = Feed(
        source=source, sha256=digest, tables=tables, stops=stops, routes=routes,
        agency_name=(primary.get("agency_name") or "").strip() or "this transit agency",
        agency_url=(primary.get("agency_url") or "").strip(),
        timezone=timezone, feed_start=start, feed_end=end,
        feed_version=(info.get("feed_version") or "").strip(),
        publisher=(info.get("feed_publisher_name") or "").strip(),
    )
    log.info("feed %s: %d stops, %d routes, %d trips, %d stop_times, window %s–%s",
             feed.agency_name, len(stops), len(routes),
             len(tables["trips"]), len(tables["stop_times"]), start, end)
    return feed


# ── per-feed derived caches (attached to the Feed object, never serialised) ────

def _s1_cache(feed: Feed, key: str, build):
    """Memoise a derived structure on the Feed. Pure, so this cannot affect output."""
    store = getattr(feed, "_s1_derived", None)
    if store is None:
        store = {}
        feed._s1_derived = store                            # type: ignore[attr-defined]
    if key not in store:
        store[key] = build()
    return store[key]


def _s1_invalidate(feed: Feed) -> None:
    feed._s1_derived = {}                                   # type: ignore[attr-defined]


def _s1_trip_rows(feed: Feed) -> dict[str, list[dict[str, str]]]:
    """`trip_id → stop_times rows, sorted by int(stop_sequence)`.

    `stop_sequence` is non-contiguous in **every** trip of the reference feed and
    starts at 0, so it is a sort key and never an index.
    """
    def build() -> dict[str, list[dict[str, str]]]:
        by_trip: dict[str, list[dict[str, str]]] = collections.defaultdict(list)
        for row in feed.tables["stop_times"]:
            by_trip[row.get("trip_id", "")].append(row)
        for rows in by_trip.values():
            rows.sort(key=lambda r: _s1_int(r.get("stop_sequence")))
        return dict(by_trip)
    return _s1_cache(feed, "trip_rows", build)


def _s1_trips_by_service(feed: Feed) -> dict[str, list[dict[str, str]]]:
    def build() -> dict[str, list[dict[str, str]]]:
        out: dict[str, list[dict[str, str]]] = collections.defaultdict(list)
        for trip in feed.tables["trips"]:
            out[(trip.get("service_id") or "").strip()].append(trip)
        return dict(out)
    return _s1_cache(feed, "trips_by_service", build)


def _s1_calendar_index(feed: Feed) -> tuple[list[dict[str, str]], dict[str, list[tuple[str, str]]]]:
    """`(calendar rows, date → [(service_id, exception_type)])` — built once."""
    def build():
        cal = [r for r in feed.tables.get("calendar", []) if (r.get("service_id") or "").strip()]
        exc: dict[str, list[tuple[str, str]]] = collections.defaultdict(list)
        for row in feed.tables.get("calendar_dates", []):
            date = (row.get("date") or "").strip()
            sid = (row.get("service_id") or "").strip()
            if date and sid:
                exc[date].append((sid, (row.get("exception_type") or "1").strip()))
        for date in exc:
            exc[date].sort()
        return cal, dict(exc)
    return _s1_cache(feed, "calendar_index", build)


def normalise_times(feed: Feed) -> None:
    """In-place: fill blank `arrival_time`/`departure_time` by linear interpolation,
    expand `frequencies.txt` into concrete trips (dropping the template trips'
    original `stop_times`), and validate that every trip's times are non-decreasing.

    Mutates `feed.tables['stop_times']` and `['trips']`. Idempotent.
    """
    if getattr(feed, "_s1_normalised", False):
        return

    _s1_expand_frequencies(feed)
    _s1_fill_blank_times(feed)
    _s1_check_monotone(feed)

    feed._s1_normalised = True                              # type: ignore[attr-defined]
    _s1_invalidate(feed)


def _s1_expand_frequencies(feed: Feed) -> None:
    """Turn every `frequencies.txt` row into concrete trips.

    The template trip's own `stop_times` rows are **dropped**, not kept alongside —
    keeping them would double-count the first headway slot. `exact_times` makes no
    difference to an earliest-arrival model: expanding at the stated headway is the
    correct conservative reading of both 0 and 1.
    """
    freq = [r for r in feed.tables.get("frequencies", []) if (r.get("trip_id") or "").strip()]
    if not freq:
        return

    by_trip = _s1_trip_rows(feed)
    trips_by_id = {(t.get("trip_id") or ""): t for t in feed.tables["trips"]}
    templates = sorted({(r.get("trip_id") or "").strip() for r in freq})

    new_trips: list[dict[str, str]] = []
    new_times: list[dict[str, str]] = []
    for row in sorted(freq, key=lambda r: ((r.get("trip_id") or ""), (r.get("start_time") or ""))):
        tid = (row.get("trip_id") or "").strip()
        rows = by_trip.get(tid)
        template = trips_by_id.get(tid)
        if not rows or template is None:
            continue
        t0, t1 = hms_to_s(row.get("start_time")), hms_to_s(row.get("end_time"))
        headway = _s1_int(row.get("headway_secs"), 0)
        if t0 is None or t1 is None or headway <= 0 or t1 <= t0:
            continue
        anchor = hms_to_s(rows[0].get("departure_time")) or hms_to_s(rows[0].get("arrival_time")) or 0
        offsets = [(hms_to_s(r.get("arrival_time")), hms_to_s(r.get("departure_time"))) for r in rows]
        for k, dep0 in enumerate(range(t0, t1, headway)):
            new_id = f"{tid}#{k:04d}"
            clone = dict(template)
            clone["trip_id"] = new_id
            new_trips.append(clone)
            for src, (arr, dep) in zip(rows, offsets):
                out = dict(src)
                out["trip_id"] = new_id
                if arr is not None:
                    out["arrival_time"] = hhmmss(dep0 + arr - anchor)
                if dep is not None:
                    out["departure_time"] = hhmmss(dep0 + dep - anchor)
                new_times.append(out)

    dropped = set(templates)
    feed.tables["trips"] = [t for t in feed.tables["trips"] if (t.get("trip_id") or "") not in dropped] + new_trips
    feed.tables["stop_times"] = [r for r in feed.tables["stop_times"] if (r.get("trip_id") or "") not in dropped] + new_times
    _s1_invalidate(feed)
    log.info("frequencies.txt: expanded %d template trips into %d concrete trips",
             len(templates), len(new_trips))


def _s1_fill_blank_times(feed: Feed) -> None:
    """Linear interpolation of blank times between the surrounding timepoints.

    Interpolates by `shape_dist_traveled` when every row of the run carries it, and
    by post-sort position otherwise. Rows outside the first/last timepoint of a trip
    (which is malformed GTFS) are filled by copying the nearest known time.
    """
    filled = 0
    for _, rows in sorted(_s1_trip_rows(feed).items()):
        times = [hms_to_s(r.get("departure_time")) or hms_to_s(r.get("arrival_time")) for r in rows]
        if all(t is not None for t in times):
            continue
        known = [i for i, t in enumerate(times) if t is not None]
        if not known:
            continue
        dists = [_s1_float(r.get("shape_dist_traveled")) for r in rows]
        use_dist = all(d is not None for d in dists) and dists[-1] != dists[0]
        axis = [float(d) for d in dists] if use_dist else [float(i) for i in range(len(rows))]

        for i, t in enumerate(times):
            if t is not None:
                continue
            before = [k for k in known if k < i]
            after = [k for k in known if k > i]
            if before and after:
                a, b = before[-1], after[0]
                span = axis[b] - axis[a]
                frac = ((axis[i] - axis[a]) / span) if span else 0.5
                value = int(round(times[a] + frac * (times[b] - times[a])))
            else:
                value = times[(before or after)[-1 if before else 0]]
            times[i] = value
            filled += 1

        for row, value in zip(rows, times):
            if not (row.get("arrival_time") or "").strip():
                row["arrival_time"] = hhmmss(value)
            if not (row.get("departure_time") or "").strip():
                row["departure_time"] = hhmmss(value)
    if filled:
        log.info("interpolated %d blank stop_times values", filled)


def _s1_check_monotone(feed: Feed) -> None:
    """Warn (never crash) when a trip's times go backwards. Real feeds do this."""
    bad = 0
    for trip_id, rows in sorted(_s1_trip_rows(feed).items()):
        prev = None
        for row in rows:
            arr = hms_to_s(row.get("arrival_time"))
            dep = hms_to_s(row.get("departure_time"))
            for value in (arr, dep):
                if value is None:
                    continue
                if prev is not None and value < prev:
                    bad += 1
                prev = max(prev, value) if prev is not None else value
    if bad:
        log.warning("%d non-monotone stop_times values; the travel-time model clamps them", bad)


def feed_window(feed: Feed, as_of: str | None) -> tuple[str, str, str]:
    """Resolve the feed's validity window and the analysis date.

    Returns `(start, end, as_of)` as GTFS date strings. Priority for the window:
    `feed_info` dates, else min/max over `calendar`, else min/max over
    `calendar_dates`. `as_of` defaults to `start` and is clamped into the window.
    **Never calls `date.today()`** — that is the whole reason this function exists.
    """
    start, end = feed.feed_start, feed.feed_end
    chosen = (as_of or "").strip() or start
    if not re.fullmatch(r"\d{8}", chosen):
        raise ValueError(f"--as-of must be YYYYMMDD, got {as_of!r}")
    if chosen < start:
        log.warning("--as-of %s is before the feed window; clamped to %s", chosen, start)
        chosen = start
    elif chosen > end:
        log.warning("--as-of %s is after the feed window; clamped to %s", chosen, end)
        chosen = end
    return start, end, chosen


def active_services(feed: Feed, date: str) -> frozenset[str]:
    """The set of `service_id`s running on `date`.

    Handles both conventions in one pass: `calendar.txt` weekday bitmasks within
    the row's date range, then `calendar_dates.txt` exceptions (type 1 adds, type 2
    removes). A feed with only `calendar_dates` signals a no-service day by the
    date's *absence*, so an empty result is meaningful, not an error.
    """
    cal, exc = _s1_calendar_index(feed)
    dow = _S1_DOW_NAMES[dow_of(date)]
    out: set[str] = set()
    for row in cal:
        if (row.get("start_date") or "") <= date <= (row.get("end_date") or "") and (row.get(dow) or "0") == "1":
            out.add((row.get("service_id") or "").strip())
    for sid, kind in exc.get(date, ()):
        if kind == "1":
            out.add(sid)
        else:
            out.discard(sid)
    return frozenset(out)


def _s1_date_profiles(feed: Feed, start: str, end: str) -> list[tuple[str, frozenset[str], int]]:
    """`[(date, active service ids, trip count)]` for every serviced date, ascending."""
    def build() -> list[tuple[str, frozenset[str], int]]:
        per_service = {sid: len(rows) for sid, rows in _s1_trips_by_service(feed).items()}
        out: list[tuple[str, frozenset[str], int]] = []
        for date in date_range(start, end):
            services = active_services(feed, date)
            if not services:
                continue
            count = sum(per_service.get(s, 0) for s in sorted(services))
            if count == 0:
                continue                                    # a service_id with no trips is not a service day
            out.append((date, services, count))
        return out
    return _s1_cache(feed, f"date_profiles:{start}:{end}", build)


def _s1_representative(dates: Sequence[tuple[str, frozenset[str], int]]) -> tuple[str, frozenset[str], int]:
    """Pick the representative date of a group: lower-median trip count, then the
    **middle** date among the ones tied at that count.

    Lower median is the rulebook-safe choice — a tie between a busy and a quiet
    pattern must resolve to the quiet one, or the page promises service it does not
    have (the reference feed's two Sunday patterns differ by 3½ hours of span).
    Taking the middle tied date rather than the first avoids landing on a partial
    first week, which is a common feed artefact; it is still a pure function of the
    sorted date list.
    """
    counts = [c for _, _, c in dates]
    target = int(lower_median(counts))
    tied = sorted(d for d, _, c in dates if c == target)
    date = tied[len(tied) // 2]
    services = next(s for d, s, _ in dates if d == date)
    return date, services, target


def day_types(feed: Feed, start: str, end: str) -> list[DayType]:
    """Group the validity window into distinguishable service-day types.

    For each day-of-week, list every date whose active-service set is non-empty,
    count trips, and pick the date with the **lower median** trip count (tie-break
    earliest) as representative. Day types with identical service-id sets and trip
    counts are merged (a Mon–Fri feed yields one 'weekday' type, not five).

    Returns them in calendar order (weekday, Saturday, Sunday, …). This matters more
    than it looks: the reference feed has two Sunday patterns whose spans differ by
    3½ hours, and picking "the first Sunday" would flip a headline fact.
    """
    profiles = _s1_date_profiles(feed, start, end)
    if not profiles:
        raise ValueError("no date in the feed's validity window has any service")

    by_dow: dict[int, list[tuple[str, frozenset[str], int]]] = collections.defaultdict(list)
    for date, services, count in profiles:
        by_dow[dow_of(date)].append((date, services, count))

    # Conventional buckets first; a bucket only splits when its member weekdays run
    # genuinely different amounts of service (school-term Tuesdays must not split
    # Mon–Fri, but a Friday-only night network must not be averaged into it).
    groups: list[tuple[str, str, list[int]]] = []
    weekday_dows = sorted(d for d in by_dow if d <= 4)
    if weekday_dows:
        medians = {d: int(lower_median([c for _, _, c in by_dow[d]])) for d in weekday_dows}
        lo, hi = min(medians.values()), max(medians.values())
        if lo > 0 and hi / lo <= 1.5 and len(weekday_dows) > 1:
            groups.append(("weekday", "Weekday", weekday_dows))
        else:
            for d in weekday_dows:
                groups.append((f"dow{d}", _S1_DOW_LABELS[d], [d]))
    if 5 in by_dow:
        groups.append(("saturday", "Saturday", [5]))
    if 6 in by_dow:
        groups.append(("sunday", "Sunday", [6]))

    out: list[DayType] = []
    for key, label, dows in groups:
        member = sorted((d, s, c) for dow in dows for d, s, c in by_dow[dow])
        date, services, trips = _s1_representative(member)
        out.append(DayType(
            key=key, label=label, date=date,
            dates=tuple(d for d, _, _ in member),
            service_ids=tuple(sorted(services)),
            trips=trips,
            trip_counts=tuple(c for _, _, c in member),
        ))

    rank = {"weekday": 0, "saturday": 5, "sunday": 6}
    out.sort(key=lambda t: (rank.get(t.key, _s1_int(t.key[3:], 9)), t.key))
    log.info("day types: %s", ", ".join(f"{t.key}={t.date}({t.trips} trips)" for t in out))
    return out


def no_service_dates(feed: Feed, start: str, end: str) -> tuple[list[str], list[str]]:
    """Return `(no_service_dates, reduced_service_dates)` inside the window.

    A date is no-service when `active_services` is empty. It is reduced-service when
    its trip count is below 80% of the representative day for its weekday. Both feed
    the `D3 full_service_date_share` metric and catch school-term-only feeds.
    """
    profiles = _s1_date_profiles(feed, start, end)
    served = {d for d, _, _ in profiles}
    dead = [d for d in date_range(start, end) if d not in served]

    by_dow: dict[int, list[int]] = collections.defaultdict(list)
    for date, _, count in profiles:
        by_dow[dow_of(date)].append(count)
    reference = {dow: int(lower_median(counts)) for dow, counts in sorted(by_dow.items())}

    reduced = sorted(d for d, _, c in profiles if c < 0.8 * reference[dow_of(d)])
    return dead, reduced

# ═══════════════════════════════════════════════════════════════════════════════
# S1 · the service day and the RAPTOR structures
# ═══════════════════════════════════════════════════════════════════════════════
#
# `ServiceDay.patterns / pattern_at_stop / footpaths / stop_index` are S1-private,
# exactly as contract.md §3.2 says. Their concrete shapes are:
#
#   stop_index        _S1StopIndex(by_id={stop_id: i}, ids=(stop_id, …))
#   patterns          (_S1Pattern, …)  — column-major so the board lookup is a bisect
#   pattern_at_stop   tuple indexed by stop index → ((pattern_i, offset), …)
#   footpaths         tuple indexed by stop index → ((other_i, seconds), …)
#
# and one extra object, `day._s1x`, carries the per-day analysis vectors that would
# otherwise be recomputed by three different callers.


@dataclass(frozen=True)
class _S1StopIndex:
    """Bidirectional stop_id ↔ dense-index map over the whole feed's stops."""

    by_id: dict[str, int]
    ids: tuple[str, ...]


@dataclass(frozen=True)
class _S1Pattern:
    """Trips sharing an identical stop sequence, stored column-major.

    `dep[offset]` and `arr[offset]` are per-trip vectors in trip order (sorted by
    departure at the pattern's first stop), which makes "earliest trip at this
    offset departing at or after t" a plain `bisect` when the pattern does not
    overtake itself.
    """

    stops: tuple[int, ...]
    dep: tuple[tuple[int, ...], ...]
    arr: tuple[tuple[int, ...], ...]
    trip_ids: tuple[str, ...]
    trip_routes: tuple[str, ...]          # per trip: two routes can share a stop sequence
    route_id: str
    direction_id: str
    sorted_cols: bool                     # False ⇒ this pattern overtakes; scan linearly


@dataclass
class _S1DayExtras:
    """Per-day vectors shared by the metrics, headway and question layers."""

    trip_route: dict[str, tuple[str, str]]                       # trip_id → (route_id, direction_id)
    dedup: dict[str, tuple[int, ...]]                            # stop_id → one departure per trip
    route_dir_stop: dict[tuple[str, str, str], tuple[int, ...]]  # (route, dir, stop) → departures
    stop_routes: dict[str, tuple[str, ...]]
    stop_name: dict[str, str]                                    # stop_id → display name
    route_label: dict[str, str]                                  # route_id → Route.label


def _s1_extras(day: ServiceDay) -> _S1DayExtras:
    return day._s1x                                              # type: ignore[attr-defined]


def _s1_stop_index(feed: Feed) -> _S1StopIndex:
    def build() -> _S1StopIndex:
        ids = tuple(sorted(feed.stops))
        return _S1StopIndex(by_id={s: i for i, s in enumerate(ids)}, ids=ids)
    return _s1_cache(feed, "stop_index", build)


def _s1_positions(feed: Feed, proj: Projection) -> dict[str, tuple[float, float]]:
    """`stop_id → (x, y)` metres in the shared projection, built once per feed."""
    def build() -> dict[str, tuple[float, float]]:
        return {sid: proj.xy(st.lat, st.lon) for sid, st in sorted(feed.stops.items())}
    return _s1_cache(feed, f"pos:{proj.lat0:.9f}:{proj.lon0:.9f}", build)


def _s1_footpaths(feed: Feed, proj: Projection) -> tuple[tuple[tuple[int, int], ...], ...]:
    """Geometric transfer graph: every stop pair within `WALK_RADIUS_M`.

    Weight is `straight_line × WALK_CIRCUITY ÷ WALK_SPEED_MPS`. `transfers.txt`, when
    populated, overrides: `transfer_type=3` deletes the edge, `2` raises its weight to
    at least `min_transfer_time`, and an explicitly listed pair is added even if it is
    beyond the walk radius. The graph is symmetric and identical on every service day,
    so it is built once per feed.
    """
    key = f"foot:{proj.lat0:.9f}:{proj.lon0:.9f}"

    def build() -> tuple[tuple[tuple[int, int], ...], ...]:
        index = _s1_stop_index(feed)
        pos = _s1_positions(feed, proj)
        n = len(index.ids)

        rules: dict[tuple[str, str], tuple[str, int]] = {}
        for row in feed.tables.get("transfers", []):
            a = (row.get("from_stop_id") or "").strip()
            b = (row.get("to_stop_id") or "").strip()
            if not a or not b or a == b:
                continue
            rules[(a, b)] = ((row.get("transfer_type") or "0").strip(),
                             _s1_int(row.get("min_transfer_time"), 0))

        cell = WALK_RADIUS_M
        grid: dict[tuple[int, int], list[str]] = collections.defaultdict(list)
        for sid in index.ids:
            x, y = pos[sid]
            grid[(int(math.floor(x / cell)), int(math.floor(y / cell)))].append(sid)

        edges: list[list[tuple[int, int]]] = [[] for _ in range(n)]
        for sid in index.ids:
            x, y = pos[sid]
            gx, gy = int(math.floor(x / cell)), int(math.floor(y / cell))
            i = index.by_id[sid]
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for other in grid.get((gx + dx, gy + dy), ()):
                        if other == sid:
                            continue
                        d = math.dist((x, y), pos[other])
                        if d > WALK_RADIUS_M:
                            continue
                        rule = rules.get((sid, other))
                        if rule and rule[0] == "3":
                            continue
                        w = int(d * WALK_CIRCUITY / WALK_SPEED_MPS)
                        if rule and rule[0] == "2":
                            w = max(w, rule[1])
                        edges[i].append((index.by_id[other], w))

        for (a, b), (kind, minimum) in sorted(rules.items()):
            if kind == "3" or a not in index.by_id or b not in index.by_id:
                continue
            i, j = index.by_id[a], index.by_id[b]
            if any(t == j for t, _ in edges[i]):
                continue
            d = math.dist(pos[a], pos[b])
            edges[i].append((j, max(int(d * WALK_CIRCUITY / WALK_SPEED_MPS), minimum)))

        out = tuple(tuple(sorted(set(e))) for e in edges)
        log.debug("footpaths: %d directed edges over %d stops", sum(len(e) for e in out), n)
        return out

    return _s1_cache(feed, key, build)


def build_service_day(feed: Feed, day: DayType, proj: Projection, *,
                      board_slack_s: int = BOARD_SLACK_S) -> ServiceDay:
    """Materialise one service day, including the RAPTOR structures.

    Builds: per-stop departure vectors, routes, headways and the frequent flag;
    RAPTOR patterns (trips sharing an identical stop sequence, sorted by first
    departure) and the geometric footpath graph (`WALK_RADIUS_M` straight-line ×
    `WALK_CIRCUITY` ÷ `WALK_SPEED_MPS`, honouring `transfers.txt` when populated:
    `transfer_type=3` deletes an edge, `2` raises its weight).

    Also asserts once, at build time, that trips within a pattern do not overtake;
    if any do, the earliest-trip lookup falls back to a linear scan instead of
    `bisect`. Measured cost on the reference feed: 0.29 s.
    """
    index = _s1_stop_index(feed)
    trip_rows = _s1_trip_rows(feed)
    services = set(day.service_ids)

    trip_route: dict[str, tuple[str, str]] = {}
    for trip in feed.tables["trips"]:
        if (trip.get("service_id") or "").strip() in services:
            trip_route[(trip.get("trip_id") or "").strip()] = (
                (trip.get("route_id") or "").strip(),
                (trip.get("direction_id") or "").strip(),
            )

    # ── one ordered pass over the day's stop_times ────────────────────────────
    departures: dict[str, list[int]] = collections.defaultdict(list)
    trip_deps: dict[str, list[tuple[str, int]]] = collections.defaultdict(list)
    stop_routes: dict[str, set[str]] = collections.defaultdict(set)
    rds: dict[tuple[str, str, str], list[tuple[str, int]]] = collections.defaultdict(list)
    pattern_bucket: dict[tuple[str, ...], list[tuple[int, str]]] = collections.defaultdict(list)
    pattern_times: dict[str, tuple[tuple[int, int], ...]] = {}
    stop_events = 0

    for trip_id in sorted(trip_route):
        rows = trip_rows.get(trip_id)
        if not rows:
            continue
        route_id, direction = trip_route[trip_id]
        seq_stops: list[str] = []
        seq_times: list[tuple[int, int]] = []
        for row in rows:
            sid = (row.get("stop_id") or "").strip()
            if sid not in feed.stops:
                continue
            arr = hms_to_s(row.get("arrival_time"))
            dep = hms_to_s(row.get("departure_time"))
            if arr is None and dep is None:
                continue
            arr = arr if arr is not None else dep
            dep = dep if dep is not None else arr
            seq_stops.append(sid)
            seq_times.append((int(arr), int(dep)))
            stop_events += 1
            departures[sid].append(int(dep))
            trip_deps[sid].append((trip_id, int(dep)))
            stop_routes[sid].add(route_id)
            rds[(route_id, direction, sid)].append((trip_id, int(dep)))
        if len(seq_stops) < 2:
            continue
        pattern_bucket[tuple(seq_stops)].append((seq_times[0][1], trip_id))
        pattern_times[trip_id] = tuple(seq_times)

    served = tuple(sorted(departures))
    if not served:
        raise ValueError(f"service day {day.key} ({day.date}) has no departures")

    # ── per-stop facts ────────────────────────────────────────────────────────
    # one departure per (trip, stop) per route-direction, exactly as gtfs.md §1.9
    # requires — a loop terminus otherwise reports a fake 0-minute headway
    rds_clean: dict[tuple[str, str, str], tuple[int, ...]] = {
        key: tuple(_s1_dedupe(value)) for key, value in sorted(rds.items())}

    lo_w, hi_w = hms_to_s(HEADWAY_WINDOW[0]) or 0, hms_to_s(HEADWAY_WINDOW[1]) or SERVICE_DAY_SECONDS
    best_dir_gap: dict[str, float] = {}
    for (route_id, direction, sid), values in sorted(rds_clean.items()):
        inside = [v for v in values if lo_w <= v <= hi_w]
        if len(inside) < 2:
            continue
        gap = float(_s1_median(_s1_gaps(inside)))
        if sid not in best_dir_gap or gap < best_dir_gap[sid]:
            best_dir_gap[sid] = gap

    stop_days: dict[str, StopDay] = {}
    dedup_all: dict[str, tuple[int, ...]] = {}
    for sid in served:
        every = tuple(sorted(departures[sid]))
        deduped = tuple(_s1_dedupe(trip_deps[sid]))
        dedup_all[sid] = deduped
        inside = [t for t in deduped if lo_w <= t <= hi_w]
        gaps = _s1_gaps(inside) if len(inside) >= 2 else []
        stop_days[sid] = StopDay(
            stop_id=sid, departures=every, routes=tuple(sorted(stop_routes[sid])),
            first=every[0], last=every[-1],
            median_headway_s=float(_s1_median(gaps)) if gaps else None,
            worst_gap_s=float(max(gaps)) if gaps else None,
            frequent=best_dir_gap.get(sid, float("inf")) <= FREQUENT_HEADWAY_MIN * 60,
        )

    # ── RAPTOR patterns ───────────────────────────────────────────────────────
    patterns: list[_S1Pattern] = []
    at_stop: list[list[tuple[int, int]]] = [[] for _ in range(len(index.ids))]
    for key in sorted(pattern_bucket):
        trips = sorted(pattern_bucket[key])
        ids = tuple(t for _, t in trips)
        cols_dep: list[tuple[int, ...]] = []
        cols_arr: list[tuple[int, ...]] = []
        ordered = True
        for off in range(len(key)):
            dep_col = tuple(pattern_times[t][off][1] for t in ids)
            arr_col = tuple(pattern_times[t][off][0] for t in ids)
            if any(dep_col[i] > dep_col[i + 1] for i in range(len(dep_col) - 1)):
                ordered = False
            if any(arr_col[i] > arr_col[i + 1] for i in range(len(arr_col) - 1)):
                ordered = False
            cols_dep.append(dep_col)
            cols_arr.append(arr_col)
        # Patterns are keyed on the stop sequence alone (the RAPTOR definition), so a
        # pattern can in principle carry trips of two different routes. Keep the
        # per-trip route so a reconstructed journey never names the wrong line.
        trip_routes = tuple(trip_route.get(t, ("", ""))[0] for t in ids)
        route_id, direction = trip_route.get(ids[0], ("", ""))
        pi = len(patterns)
        stops_idx = tuple(index.by_id[s] for s in key)
        patterns.append(_S1Pattern(stops=stops_idx, dep=tuple(cols_dep), arr=tuple(cols_arr),
                                   trip_ids=ids, trip_routes=trip_routes,
                                   route_id=route_id, direction_id=direction,
                                   sorted_cols=ordered))
        for off, si in enumerate(stops_idx):
            at_stop[si].append((pi, off))
    for lst in at_stop:
        lst.sort()
    overtaking = sum(1 for p in patterns if not p.sorted_cols)
    if overtaking:
        log.info("%d of %d patterns overtake themselves; those use a linear trip scan",
                 overtaking, len(patterns))

    first = min(sd.first for sd in stop_days.values() if sd.first is not None)
    last = max(sd.last for sd in stop_days.values() if sd.last is not None)

    sd_obj = ServiceDay(
        day_type=day, stop_days=stop_days, served_stop_ids=served,
        route_ids=tuple(sorted({r for rid in served for r in stop_routes[rid]})),
        trips=len([t for t in sorted(trip_route) if trip_rows.get(t)]),
        stop_events=stop_events, first_departure=first, last_departure=last,
        patterns=tuple(patterns), pattern_at_stop=tuple(tuple(v) for v in at_stop),
        footpaths=_s1_footpaths(feed, proj), stop_index=index,
    )
    sd_obj._s1x = _S1DayExtras(                                  # type: ignore[attr-defined]
        trip_route=trip_route, dedup=dedup_all,
        route_dir_stop=rds_clean,
        stop_routes={k: tuple(sorted(v)) for k, v in sorted(stop_routes.items())},
        stop_name={sid: feed.stops[sid].name for sid in served},
        route_label={rid: r.label for rid, r in sorted(feed.routes.items())},
    )
    sd_obj._s1_slack = int(board_slack_s)                        # type: ignore[attr-defined]
    log.info("%s %s: %d trips, %d patterns, %d served stops, %s–%s",
             day.key, day.date, sd_obj.trips, len(patterns), len(served), hhmm(first), hhmm(last))
    return sd_obj


def _s1_slack(day: ServiceDay) -> int:
    return int(getattr(day, "_s1_slack", BOARD_SLACK_S))


# ── RAPTOR ────────────────────────────────────────────────────────────────────

def _s1_earliest_trip(pattern: _S1Pattern, off: int, ready: int) -> int:
    """Index of the earliest trip departing offset `off` at or after `ready`, or −1."""
    col = pattern.dep[off]
    if pattern.sorted_cols:
        j = bisect.bisect_left(col, ready)
        return j if j < len(col) else -1
    best, best_i = _S1_INF, -1
    for i, value in enumerate(col):
        if ready <= value < best:
            best, best_i = value, i
    return best_i


def _s1_latest_trip(pattern: _S1Pattern, off: int, deadline: int) -> int:
    """Index of the latest trip arriving at offset `off` no later than `deadline`, or −1."""
    col = pattern.arr[off]
    if pattern.sorted_cols:
        return bisect.bisect_right(col, deadline) - 1
    best, best_i = _S1_NEG_INF, -1
    for i, value in enumerate(col):
        if best < value <= deadline:
            best, best_i = value, i
    return best_i


def raptor(day: ServiceDay, origin_stop_ids: Sequence[str], departure_s: int, *,
           max_transfers: int = MAX_TRANSFERS) -> TravelTimes:
    """Round-based RAPTOR, one-to-all earliest arrival. ~8 ms per query.

    Determinism comes from iterating `sorted(marked)` and `sorted(queue)` — there is
    no priority queue and therefore no tie-break nondeterminism. `TravelTimes.rounds`
    carries the transfer count of the best journey, which the zone scoring needs and
    which a CSA implementation would not give for free.

    Correctness was validated against an independent brute force (15/15 exact
    matches, zero cases slower than a one-leg journey) — keep that test.
    """
    index: _S1StopIndex = day.stop_index
    patterns: tuple[_S1Pattern, ...] = day.patterns
    at_stop = day.pattern_at_stop
    foot = day.footpaths
    slack = _s1_slack(day)
    n = len(index.ids)
    K = max(1, int(max_transfers) + 1)                # K transit legs ⇒ K−1 transfers

    best = [_S1_INF] * n
    label = [[_S1_INF] * n for _ in range(K + 1)]
    parent: list[list[Any]] = [[None] * n for _ in range(K + 1)]
    round_of = [0] * n

    marked: set[int] = set()
    for sid in sorted(set(origin_stop_ids)):
        i = index.by_id.get(sid)
        if i is None:
            continue
        best[i] = label[0][i] = int(departure_s)
        marked.add(i)
    if not marked:
        return TravelTimes(tuple(sorted(set(origin_stop_ids))), int(departure_s), {}, {})

    def relax_footpaths(k: int, seeds: set[int]) -> set[int]:
        """One walk hop out of every stop reached in round `k`.

        Deliberately **not** transitively closed. `WALK_RADIUS_M` is the transfer
        radius; chaining hops would let the model walk the whole map at 1.2 m/s and
        it inflates the reference feed's ≤30-minute reach from 768 stops to 792.
        A second walk is a strategic decision, not a transfer.
        """
        touched: set[int] = set()
        for i in sorted(seeds):
            base = label[k][i]
            if base >= _S1_INF:
                continue
            for j, w in foot[i]:
                value = base + w
                if value < best[j]:
                    best[j] = label[k][j] = value
                    parent[k][j] = ("walk", i)
                    round_of[j] = k
                    touched.add(j)
        return touched

    marked |= relax_footpaths(0, marked)

    for k in range(1, K + 1):
        queue: dict[int, int] = {}
        for si in sorted(marked):
            for pi, off in at_stop[si]:
                if pi not in queue or off < queue[pi]:
                    queue[pi] = off
        marked = set()
        prev = label[k - 1]
        for pi in sorted(queue):
            pattern = patterns[pi]
            stops = pattern.stops
            trip = -1
            board_off = -1
            for off in range(queue[pi], len(stops)):
                si = stops[off]
                if trip >= 0:
                    arrival = pattern.arr[off][trip]
                    if arrival < best[si]:
                        best[si] = label[k][si] = arrival
                        parent[k][si] = ("ride", pi, trip, board_off, off)
                        round_of[si] = k
                        marked.add(si)
                if prev[si] < _S1_INF:
                    ready = prev[si] + slack
                    if trip < 0 or ready <= pattern.dep[off][trip]:
                        cand = _s1_earliest_trip(pattern, off, ready)
                        if cand >= 0 and (trip < 0 or pattern.dep[off][cand] < pattern.dep[off][trip]):
                            trip, board_off = cand, off
        marked |= relax_footpaths(k, marked)
        if not marked:
            break

    arrival_s = {index.ids[i]: best[i] for i in range(n) if best[i] < _S1_INF}
    transfers: dict[str, int] = {}
    for sid in sorted(arrival_s):
        i = index.by_id[sid]
        transfers[sid] = max(0, round_of[i] - 1)
    out = TravelTimes(tuple(sorted(set(origin_stop_ids))), int(departure_s), arrival_s, transfers)
    out._s1_parent = parent                                      # type: ignore[attr-defined]
    out._s1_round = round_of                                     # type: ignore[attr-defined]
    return out


def raptor_reverse(day: ServiceDay, target_stop_ids: Sequence[str], arrive_by_s: int, *,
                   max_transfers: int = MAX_TRANSFERS) -> dict[str, int]:
    """Mirrored RAPTOR: per stop, the **latest departure** that still reaches the target.

    Labels are latest-departure instead of earliest-arrival, patterns are scanned
    from the end, `max` replaces `min`, footpaths subtract. This is what produces the
    honest `last_train_home` — strictly earlier than the raw last departure, and the
    input to the `S2 exit_margin` metric.
    """
    index: _S1StopIndex = day.stop_index
    patterns: tuple[_S1Pattern, ...] = day.patterns
    at_stop = day.pattern_at_stop
    foot = day.footpaths
    slack = _s1_slack(day)
    n = len(index.ids)
    K = max(1, int(max_transfers) + 1)

    best = [_S1_NEG_INF] * n
    label = [[_S1_NEG_INF] * n for _ in range(K + 1)]

    marked: set[int] = set()
    for sid in sorted(set(target_stop_ids)):
        i = index.by_id.get(sid)
        if i is None:
            continue
        best[i] = label[0][i] = int(arrive_by_s)
        marked.add(i)
    if not marked:
        return {}

    def relax_footpaths(k: int, seeds: set[int]) -> set[int]:
        """One walk hop, mirrored: footpaths subtract. Not transitively closed,
        for the same reason as the forward scan."""
        touched: set[int] = set()
        for i in sorted(seeds):
            base = label[k][i]
            if base <= _S1_NEG_INF:
                continue
            for j, w in foot[i]:
                value = base - w
                if value > best[j]:
                    best[j] = label[k][j] = value
                    touched.add(j)
        return touched

    marked |= relax_footpaths(0, marked)

    for k in range(1, K + 1):
        queue: dict[int, int] = {}
        for si in sorted(marked):
            for pi, off in at_stop[si]:
                if pi not in queue or off > queue[pi]:
                    queue[pi] = off
        marked = set()
        prev = label[k - 1]
        for pi in sorted(queue):
            pattern = patterns[pi]
            stops = pattern.stops
            trip = -1
            for off in range(queue[pi], -1, -1):
                si = stops[off]
                if trip >= 0:
                    dep = pattern.dep[off][trip]
                    if dep > best[si]:
                        best[si] = label[k][si] = dep
                        marked.add(si)
                if prev[si] > _S1_NEG_INF:
                    deadline = prev[si] - slack
                    if trip < 0 or deadline >= pattern.arr[off][trip]:
                        cand = _s1_latest_trip(pattern, off, deadline)
                        if cand >= 0 and (trip < 0 or pattern.arr[off][cand] > pattern.arr[off][trip]):
                            trip = cand
        marked |= relax_footpaths(k, marked)
        if not marked:
            break

    return {index.ids[i]: best[i] for i in range(n) if best[i] > _S1_NEG_INF}


def build_journey(day: ServiceDay, times: TravelTimes, dest_stop_id: str) -> Journey | None:
    """Reconstruct a concrete itinerary from a RAPTOR result, or None if unreachable.

    Returns route labels, board/alight stop names and times per leg — the dossier's
    "how you get there" panel. Legs are ordered; walk legs carry `mode='walk'`.
    """
    index: _S1StopIndex = day.stop_index
    parent = getattr(times, "_s1_parent", None)
    round_of = getattr(times, "_s1_round", None)
    if parent is None or round_of is None or dest_stop_id not in times.arrival_s:
        return None

    extras = _s1_extras(day)

    def name_of(i: int) -> str:
        sid = index.ids[i]
        return extras.stop_name.get(sid, sid)

    i = index.by_id[dest_stop_id]
    k = round_of[i]
    legs: list[dict[str, Any]] = []
    guard = 0
    while guard < 512:
        guard += 1
        step = parent[k][i]
        if step is None:
            break
        if step[0] == "walk":
            j = step[1]
            legs.append({
                "mode": "walk", "route": "", "route_id": "",
                "from": name_of(j), "from_id": index.ids[j],
                "to": name_of(i), "to_id": index.ids[i],
                "dep": None, "arr": None,
            })
            i = j
        else:
            _, pi, trip, board_off, alight_off = step
            pattern: _S1Pattern = day.patterns[pi]
            board_i = pattern.stops[board_off]
            ridden = pattern.trip_routes[trip]
            legs.append({
                "mode": "transit", "route_id": ridden,
                "route": extras.route_label.get(ridden, ridden),
                "trip_id": pattern.trip_ids[trip],
                "from": name_of(board_i), "from_id": index.ids[board_i],
                "to": name_of(i), "to_id": index.ids[i],
                "dep": pattern.dep[board_off][trip], "arr": pattern.arr[alight_off][trip],
            })
            i = board_i
            k -= 1
        if k < 0:
            break
    legs.reverse()
    if not legs:
        return Journey(minutes=0.0, transfers=0, legs=())

    total = (times.arrival_s[dest_stop_id] - times.departure_s) / 60.0
    rides = sum(1 for leg in legs if leg["mode"] == "transit")
    return Journey(minutes=total, transfers=max(0, rides - 1), legs=tuple(legs))

# ═══════════════════════════════════════════════════════════════════════════════
# S1 · stations, hiding zones, network metrics
# ═══════════════════════════════════════════════════════════════════════════════


def cluster_stations(stops: Sequence[Stop], proj: Projection, *,
                     radius_m: float = STATION_CLUSTER_M) -> list[Station]:
    """Synthesise stations by single-link clustering of stops within `radius_m`.

    Honours `parent_station` first when the feed populates it; otherwise pure
    geometry. Union-find over grid-accelerated pairs. Measured knee on the reference
    feed: 100 m → 822 stations from 1,493 stops. **Do not** single-link at the zone
    radius — chaining collapses whole corridors (402 m gives 111, which is nonsense).
    """
    ordered = sorted(stops, key=lambda s: s.stop_id)
    if not ordered:
        return []
    ids = [s.stop_id for s in ordered]
    slot = {sid: i for i, sid in enumerate(ids)}
    parent = list(range(len(ids)))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    for stop in ordered:                                    # parent_station first
        if stop.parent_station and stop.parent_station in slot:
            union(slot[stop.stop_id], slot[stop.parent_station])
    by_parent: dict[str, list[str]] = collections.defaultdict(list)
    for stop in ordered:
        if stop.parent_station:
            by_parent[stop.parent_station].append(stop.stop_id)
    for group in sorted(by_parent.values()):
        for other in group[1:]:
            union(slot[group[0]], slot[other])

    pos = {s.stop_id: proj.xy(s.lat, s.lon) for s in ordered}
    cell = max(1.0, radius_m)
    grid: dict[tuple[int, int], list[str]] = collections.defaultdict(list)
    for sid in ids:
        x, y = pos[sid]
        grid[(int(math.floor(x / cell)), int(math.floor(y / cell)))].append(sid)
    for sid in ids:
        x, y = pos[sid]
        gx, gy = int(math.floor(x / cell)), int(math.floor(y / cell))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for other in grid.get((gx + dx, gy + dy), ()):
                    if other != sid and math.dist((x, y), pos[other]) <= radius_m:
                        union(slot[sid], slot[other])

    members: dict[int, list[str]] = collections.defaultdict(list)
    for sid in ids:
        members[find(slot[sid])].append(sid)

    lookup = {s.stop_id: s for s in ordered}
    out: list[Station] = []
    for group in sorted(members.values()):
        group = sorted(group)
        names = collections.Counter(lookup[g].base_name or lookup[g].name for g in group)
        name = sorted(names.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
        out.append(Station(
            station_id=group[0], name=name,
            lat=sum(lookup[g].lat for g in group) / len(group),
            lon=sum(lookup[g].lon for g in group) / len(group),
            stop_ids=tuple(group),
        ))
    out.sort(key=lambda s: s.station_id)
    return out


def zone_cover(stop_ids: Sequence[str], radius_m: float, stop_events: dict[str, int],
               pos: dict[str, tuple[float, float]]) -> list[str]:
    """Greedy maximal independent set at `radius_m` — the distinct-hiding-zone count.

    Repeatedly take the stop covering the most still-uncovered stops within the
    radius, emit it as a zone centre, and remove everything inside. Tie-break chain
    `(−degree, −stop_events, stop_id)` makes it fully deterministic; a grid makes it
    0.04 s where the O(n²) reference took 57 s (identical output).

    Returns the chosen centre stop_ids, sorted. This is *the* number that goes into
    the rulebook's "30–100 / 100–500 / 500+ stations" table — 1,493 bus poles are 319
    distinct ¼-mile zones, and feeding the raw stop count in would call a mid-size
    bus city a national rail network.
    """
    ids = sorted(set(stop_ids))
    if not ids:
        return []
    cell = max(1.0, radius_m)
    grid: dict[tuple[int, int], list[str]] = collections.defaultdict(list)
    for sid in ids:
        x, y = pos[sid]
        grid[(int(math.floor(x / cell)), int(math.floor(y / cell)))].append(sid)

    neighbour_cache: dict[str, tuple[str, ...]] = {}

    def neighbours(sid: str) -> tuple[str, ...]:
        hit = neighbour_cache.get(sid)
        if hit is None:
            x, y = pos[sid]
            gx, gy = int(math.floor(x / cell)), int(math.floor(y / cell))
            found: list[str] = []
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for other in grid.get((gx + dx, gy + dy), ()):
                        if math.dist((x, y), pos[other]) <= radius_m:
                            found.append(other)
            hit = tuple(sorted(set(found)))
            neighbour_cache[sid] = hit
        return hit

    alive = set(ids)
    picks: list[str] = []
    heap = [(-len(neighbours(sid)), -int(stop_events.get(sid, 0)), sid) for sid in ids]
    heapq.heapify(heap)
    while alive and heap:
        chosen = None
        while heap:
            degree, events, sid = heapq.heappop(heap)
            if sid not in alive:
                continue
            current = sum(1 for other in neighbours(sid) if other in alive)
            if current != -degree:
                heapq.heappush(heap, (-current, events, sid))
                continue
            chosen = sid
            break
        if chosen is None:
            break
        picks.append(chosen)
        for other in neighbours(chosen):
            alive.discard(other)
    picks.extend(sorted(alive))                             # unreachable in practice; keeps the cover total
    return sorted(set(picks))


def _s1_zone_members(centres: Sequence[str], stop_ids: Sequence[str], radius_m: float,
                     pos: dict[str, tuple[float, float]]) -> dict[str, list[str]]:
    """`centre → every stop of `stop_ids` inside its circle`, sorted."""
    cell = max(1.0, radius_m)
    grid: dict[tuple[int, int], list[str]] = collections.defaultdict(list)
    for sid in sorted(stop_ids):
        x, y = pos[sid]
        grid[(int(math.floor(x / cell)), int(math.floor(y / cell)))].append(sid)
    out: dict[str, list[str]] = {}
    for centre in sorted(centres):
        x, y = pos[centre]
        gx, gy = int(math.floor(x / cell)), int(math.floor(y / cell))
        found: list[str] = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for other in grid.get((gx + dx, gy + dy), ()):
                    if math.dist((x, y), pos[other]) <= radius_m:
                        found.append(other)
        out[centre] = sorted(set(found))
    return out


def build_zones(feed: Feed, day: ServiceDay, centres: Sequence[str], radius_m: float,
                proj: Projection) -> list[Zone]:
    """Turn zone-cover centres into full `Zone` records.

    Each zone gains every served stop inside its circle, the union of their routes,
    and the total stop events — so the dossier can say "6 stops, 3 routes, this is
    the one you name". Sorted by `zone_id`.
    """
    pos = _s1_positions(feed, proj)
    members = _s1_zone_members(centres, day.served_stop_ids, radius_m, pos)
    out: list[Zone] = []
    for centre in sorted(members):
        stop = feed.stops[centre]
        inside = members[centre]
        routes = sorted({r for sid in inside for r in day.stop_days[sid].routes})
        events = sum(len(day.stop_days[sid].departures) for sid in inside)
        x, y = pos[centre]
        out.append(Zone(
            zone_id=centre, name=stop.base_name or stop.name,
            lat=stop.lat, lon=stop.lon, x=x, y=y,
            stop_ids=tuple(inside), route_ids=tuple(routes), stop_events=events,
        ))
    return out


# ── network metrics ───────────────────────────────────────────────────────────

def _s1_hull_and_shape(points: Sequence[tuple[float, float]]) -> tuple[list[tuple[float, float]], float, float]:
    """`(hull, area_m2, diameter_m)` for planar points. Diameter is the max hull pair."""
    hull = convex_hull(points)
    area = polygon_area(hull) if len(hull) >= 3 else 0.0
    diameter = 0.0
    if len(hull) >= 2:
        for i in range(len(hull)):
            for j in range(i + 1, len(hull)):
                d = math.dist(hull[i], hull[j])
                if d > diameter:
                    diameter = d
    elif len(points) >= 2:
        diameter = max(math.dist(points[0], p) for p in points)
    return hull, area, diameter


def _s1_route_km(feed: Feed) -> tuple[float, float]:
    """`(both_directions_km, one_direction_km)` from the **longest shape per
    (route_id, direction_id)**.

    Summing every shape overstates the reference network 6.5× (5,220 km against
    809 km) because every short-turn and detour variant is its own shape.
    """
    def build() -> tuple[float, float]:
        shapes = feed.tables.get("shapes") or []
        if not shapes:
            return 0.0, 0.0
        pts: dict[str, list[tuple[int, float, float]]] = collections.defaultdict(list)
        for row in shapes:
            lat, lon = _s1_float(row.get("shape_pt_lat")), _s1_float(row.get("shape_pt_lon"))
            if lat is None or lon is None:
                continue
            pts[(row.get("shape_id") or "").strip()].append(
                (_s1_int(row.get("shape_pt_sequence")), lat, lon))
        length: dict[str, float] = {}
        for shape_id in sorted(pts):
            seq = sorted(pts[shape_id])
            total = 0.0
            for a, b in zip(seq, seq[1:]):
                total += haversine_m(a[1], a[2], b[1], b[2])
            length[shape_id] = total

        longest_dir: dict[tuple[str, str], float] = {}
        longest_route: dict[str, float] = {}
        for trip in sorted(feed.tables["trips"], key=lambda t: (t.get("trip_id") or "")):
            shape_id = (trip.get("shape_id") or "").strip()
            if shape_id not in length:
                continue
            route_id = (trip.get("route_id") or "").strip()
            direction = (trip.get("direction_id") or "").strip()
            value = length[shape_id]
            key = (route_id, direction)
            if value > longest_dir.get(key, 0.0):
                longest_dir[key] = value
            if value > longest_route.get(route_id, 0.0):
                longest_route[route_id] = value
        both = sum(longest_dir[k] for k in sorted(longest_dir)) / M_PER_KM
        one = sum(longest_route[k] for k in sorted(longest_route)) / M_PER_KM
        return both, one
    return _s1_cache(feed, "route_km", build)


def radar_liveness(stop_ids: Sequence[str], pos: dict[str, tuple[float, float]],
                   radii_m: Sequence[float]) -> dict[float, float]:
    """Hit rate of each radar radius over a deterministic stop-pair sample.

    Returns `radius_m → fraction of sampled pairs within that radius`. A radar is
    dead above `RADAR_DEAD_HIGH` (always "yes") or below `RADAR_DEAD_LOW` (always
    "no"). Sampling is a fixed stride over sorted pairs, not RNG.
    """
    ids = sorted(set(stop_ids))
    n = len(ids)
    radii = sorted(set(float(r) for r in radii_m))
    if n < 2 or not radii:
        return {r: 0.0 for r in radii}

    total_pairs = n * (n - 1) // 2
    stride = max(1, total_pairs // RADAR_SAMPLE_PAIRS)
    counts = [0] * len(radii)
    sampled = 0
    points = [pos[sid] for sid in ids]
    for i in range(n):
        xi, yi = points[i]
        # The rotating offset keeps the sample from always landing on the same
        # alignment of the pair matrix; it is a pure function of i, not entropy.
        for j in range(i + 1 + (i % stride), n, stride):
            xj, yj = points[j]
            d = math.hypot(xj - xi, yj - yi)
            sampled += 1
            for k, r in enumerate(radii):
                if d <= r:
                    counts[k] += 1
    if not sampled:
        return {r: 0.0 for r in radii}
    return {r: counts[k] / sampled for k, r in enumerate(radii)}


def _s1_percentiles(values: Sequence[float], probs: Sequence[float]) -> dict[str, float]:
    if not values:
        return {}
    return {f"p{int(round(p * 100)):02d}": quantile(values, p) for p in probs}


def _s1_day_metrics(feed: Feed, day: ServiceDay, proj: Projection, hub_stop_id: str | None,
                    radius_m: float) -> dict[str, Any]:
    """Everything that is a property of one service day. Called once per day type."""
    pos = _s1_positions(feed, proj)
    extras = _s1_extras(day)
    served = list(day.served_stop_ids)
    events = {sid: len(day.stop_days[sid].departures) for sid in served}

    centres = zone_cover(served, radius_m, events, pos)
    centres_half = zone_cover(served, HALF_MILE_M, events, pos)

    points = [pos[sid] for sid in served]
    hull, hull_area, diameter = _s1_hull_and_shape(points)
    cx, cy, mec_r = min_enclosing_circle(points)
    mec_lon, mec_lat = proj.lonlat(cx, cy)
    lat_lon = [(feed.stops[sid].lat, feed.stops[sid].lon) for sid in served]
    box = bbox_of(lat_lon)
    sw = proj.xy(box[0], box[1])
    ne = proj.xy(box[2], box[3])
    bbox_area = abs(ne[0] - sw[0]) * abs(ne[1] - sw[1])

    # ── headways ──────────────────────────────────────────────────────────────
    base = [sid for sid in served if day.stop_days[sid].median_headway_s is not None]
    medians = [day.stop_days[sid].median_headway_s / 60.0 for sid in base]
    worst = [day.stop_days[sid].worst_gap_s / 60.0 for sid in base]
    frequent = [sid for sid in base if day.stop_days[sid].frequent]

    def windowed(window: tuple[str, str]) -> list[float]:
        lo, hi = hms_to_s(window[0]) or 0, hms_to_s(window[1]) or SERVICE_DAY_SECONDS
        out: list[float] = []
        for sid in served:
            inside = [t for t in extras.dedup[sid] if lo <= t <= hi]
            if len(inside) >= 2:
                out.append(_s1_median(_s1_gaps(inside)) / 60.0)
        return out

    midday, evening = windowed(MIDDAY_WINDOW), windowed(EVENING_WINDOW)

    # a stop counts as "30-minute" when a single route-direction beats 30 min
    lo_w, hi_w = hms_to_s(HEADWAY_WINDOW[0]) or 0, hms_to_s(HEADWAY_WINDOW[1]) or SERVICE_DAY_SECONDS
    best_dir: dict[str, float] = {}
    for (route_id, direction, sid), values in sorted(extras.route_dir_stop.items()):
        inside = [v for v in values if lo_w <= v <= hi_w]
        if len(inside) < 2:
            continue
        gap = _s1_median(_s1_gaps(inside))
        if sid not in best_dir or gap < best_dir[sid]:
            best_dir[sid] = gap
    within_30 = [sid for sid in base if best_dir.get(sid, float("inf")) <= 1800]

    last_departures = sorted(day.stop_days[sid].last for sid in served)
    route_counts = [len(day.stop_days[sid].routes) for sid in served]

    # ── travel time ───────────────────────────────────────────────────────────
    depart = hms_to_s(DEFAULT_DEPARTURE) or 32400
    origin = hub_stop_id if hub_stop_id in day.stop_days else (served[0] if served else None)
    hub_times: list[float] = []
    reach_by_minutes: dict[int, int] = {}
    reachable_centres: dict[int, int] = {}
    if origin:
        run = raptor(day, [origin], depart)
        hub_times = sorted((run.arrival_s[sid] - depart) / 60.0 for sid in sorted(run.arrival_s))
        for minutes in (30, 60, 180):
            reach_by_minutes[minutes] = sum(1 for t in hub_times if t <= minutes)
            reachable_centres[minutes] = sum(
                1 for c in centres if c in run.arrival_s and (run.arrival_s[c] - depart) / 60.0 <= minutes)

    # ~50 origins whatever the feed's size: the stride is the constant on a city
    # feed (1,490 served stops → exactly 50) and grows on a national one, so T90
    # costs 50 RAPTOR runs rather than one per thirty stops.
    stride = max(T90_ORIGIN_STRIDE, math.ceil(len(served) / 50))
    sample = served[::stride]
    p90s: list[float] = []
    for sid in sample:
        run = raptor(day, [sid], depart)
        values = sorted((run.arrival_s[k] - depart) / 60.0 for k in sorted(run.arrival_s))
        if len(values) >= 50:
            p90s.append(quantile(values, 0.90))
    t90 = _s1_median(p90s) if p90s else (hub_times[-1] if hub_times else 0.0)

    # ── zone-shaped facts ─────────────────────────────────────────────────────
    members = _s1_zone_members(centres, served, radius_m, pos)
    isolated = 0
    if len(centres) > 1:
        # Grid at 2r so any neighbour inside 2r lies in the 3×3 cell block — O(n),
        # not the O(n²) that a national feed's few thousand zones would make painful.
        cell = max(1.0, 2 * radius_m)
        zgrid: dict[tuple[int, int], list[str]] = collections.defaultdict(list)
        for centre in centres:
            x, y = pos[centre]
            zgrid[(int(math.floor(x / cell)), int(math.floor(y / cell)))].append(centre)
        for centre in centres:
            x, y = pos[centre]
            gx, gy = int(math.floor(x / cell)), int(math.floor(y / cell))
            alone = True
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for other in zgrid.get((gx + dx, gy + dy), ()):
                        if other != centre and math.dist((x, y), pos[other]) <= 2 * radius_m:
                            alone = False
                            break
                    if not alone:
                        break
                if not alone:
                    break
            if alone:
                isolated += 1

    round_start = max(day.first_departure, depart)
    evening_share: dict[str, float] = {}
    for name, params in sorted(_S1_SIZE_PARAMS.items()):
        cutoff = round_start + params["required_hours"] * 3600
        alive = sum(1 for c in centres if any(day.stop_days[s].last >= cutoff for s in members[c]))
        evening_share[name] = _s1_share(alive, len(centres))

    span_hours = (day.last_departure - day.first_departure) / 3600.0
    served_sq_mi = hull_area / SQM_PER_SQMI

    out: dict[str, Any] = {
        "day_key": day.day_type.key, "day_label": day.day_type.label, "date": day.day_type.date,
        "dates_represented": len(day.day_type.dates),
        "trips": day.trips, "stop_events": day.stop_events,
        "served_stops": len(served), "routes": len(day.route_ids),
        "first_departure_s": day.first_departure, "last_departure_s": day.last_departure,
        "span_hours": span_hours,
        "n_zones": len(centres), "n_zones_half_mile": len(centres_half),
        "zone_centre_ids": tuple(centres),
        "bbox": tuple(coord(v) for v in box),
        "hull_sq_m": hull_area, "bbox_sq_m": bbox_area, "diameter_m": diameter,
        "mec": (coord(mec_lat), coord(mec_lon), mec_r),
        "hull_lonlat": tuple(tuple(coord(v) for v in proj.lonlat(px, py)) for px, py in hull),
        "median_headway_min": _s1_median(medians) if medians else None,
        "median_worst_gap_min": _s1_median(worst) if worst else None,
        "midday_headway_p25_p50_p75": tuple(quantile(midday, p) for p in (0.25, 0.5, 0.75)) if midday else None,
        "evening_headway_p25_p50_p75": tuple(quantile(evening, p) for p in (0.25, 0.5, 0.75)) if evening else None,
        "headway_base_stops": len(base),
        "frequent_stops": len(frequent), "frequent_share": _s1_share(len(frequent), len(base)),
        "share_30min": _s1_share(len(within_30), len(base)),
        "median_last_departure_s": int(_s1_median(last_departures)) if last_departures else day.last_departure,
        "last_bus_percentiles_s": {k: int(v) for k, v in
                                   _s1_percentiles(last_departures, (0.05, 0.25, 0.5, 0.75, 0.95)).items()},
        "transfer_stops_2plus": sum(1 for c in route_counts if c >= 2),
        "transfer_stops_3plus": sum(1 for c in route_counts if c >= 3),
        "multi_route_stop_share": _s1_share(sum(1 for c in route_counts if c >= 2), len(served)),
        "routes_per_stop_mean": _s1_share(sum(route_counts), len(served)),
        "routes_per_stop_max": max(route_counts) if route_counts else 0,
        "stop_density_per_sq_mi": _s1_share(len(served), served_sq_mi),
        "zone_density_per_sq_mi": _s1_share(len(centres), served_sq_mi),
        "trips_per_served_stop": _s1_share(day.trips, len(served)),
        "stop_events_per_served_stop": _s1_share(day.stop_events, len(served)),
        "trips_per_sq_mi": _s1_share(day.trips, served_sq_mi),
        "hub_travel_p50_min": quantile(hub_times, 0.50) if hub_times else None,
        "hub_travel_p95_min": quantile(hub_times, 0.95) if hub_times else None,
        "hub_travel_max_min": hub_times[-1] if hub_times else None,
        "t90_min": t90,
        "t90_origin_sample": len(p90s),
        "isolated_zone_share": _s1_share(isolated, len(centres)),
        "evening_zone_share_by_size": evening_share,
        "reach_within_minutes": dict(reach_by_minutes),
        "reachable_zones_within_minutes": dict(reachable_centres),
        "reach_within_hiding_period_by_size": {
            name: reach_by_minutes.get(params["hiding_period_min"], 0)
            for name, params in sorted(_S1_SIZE_PARAMS.items())},
        "reachable_zone_share_by_size": {
            name: _s1_share(reachable_centres.get(params["hiding_period_min"], 0), len(centres))
            for name, params in sorted(_S1_SIZE_PARAMS.items())},
    }
    return out


def _s1_axis_scores(hull_sq_mi: float, n_zones: int, t90_min: float, diameter_mi: float) -> tuple[int, int, int, int]:
    """The four game-size axes, each scored 0=small / 1=medium / 2=large."""
    a = 0 if hull_sq_mi < 100 else (1 if hull_sq_mi <= 1000 else 2)
    b = 0 if n_zones < 100 else (1 if n_zones <= 500 else 2)
    c = 0 if t90_min <= 45 else (1 if t90_min <= 180 else 2)
    d = 0 if diameter_mi < 15 else (1 if diameter_mi <= 60 else 2)
    return a, b, c, d


def _s1_provisional_size(metrics: dict[str, Any]) -> str:
    """The size the four axes imply, used only to pick which size-keyed default a
    metric exposes. `infer_game_size` is the authority and re-derives it."""
    scores = _s1_axis_scores(
        metrics.get("hull_sq_m", 0.0) / SQM_PER_SQMI,
        int(metrics.get("n_zones", 0)),
        float(metrics.get("t90_min", 0.0) or 0.0),
        metrics.get("diameter_m", 0.0) / M_PER_MILE,
    )
    verdict = int(math.floor(lower_median(list(scores))))
    verdict = max(scores[0] - 1, min(scores[0] + 1, verdict))
    return _S1_SIZE_ORDER[max(0, min(2, verdict))]


def network_metrics(feed: Feed, days: Sequence[ServiceDay], proj: Projection,
                    hub: Hub | None, radius_m: float) -> dict[str, Any]:
    """Compute the whole network metric table — the input to the fitness model.

    Returns the flat dict documented in contract.md §3 (`served_stops`, `n_zones`,
    `hull_sq_m`, `diameter_m`, `t90_min`, `median_headway_min`, `frequent_share`,
    `hub_dominance`, `weekend_ratio`, `span_hours`, `last_bus_percentiles`, …), with
    every per-day quantity nested under `per_day[day_key]`.

    Three choices that are baked in and must not be re-litigated:
      * route-km uses the **longest shape per (route_id, direction_id)** — summing
        all shapes overstates the reference network 6.5× because every short-turn
        variant is its own shape;
      * area uses the **convex hull of served stops**, not the bbox (160 vs 259 sq mi);
      * traversal time is **T90** (median over a strided origin sample of each
        origin's p90), never `max`, which is set by one stop with a single
        mid-afternoon departure.

    Size-dependent quantities (`reachable_zone_share`, `evening_zone_share`,
    `playable_day_weight`, `reach_within_hiding_period`) are published both as a
    `…_by_size` dict and as a single default keyed on the size the axes imply, so a
    caller that already knows the resolved `GameSize` can read the exact figure.
    """
    key = ("metrics", feed.sha256, tuple(d.day_type.key for d in days),
           hub.stop_id if hub else None, round(float(radius_m), 4))
    cached = _s1_cache(feed, "metrics_memo", dict)
    if key in cached:
        return cached[key]

    ordered = list(days)
    if not ordered:
        raise ValueError("network_metrics needs at least one service day")
    best = max(ordered, key=lambda d: (d.trips, d.day_type.key))
    hub_stop = hub.stop_id if hub else None

    per_day: dict[str, dict[str, Any]] = {}
    for day in ordered:
        per_day[day.day_type.key] = _s1_day_metrics(feed, day, proj, hub_stop, radius_m)

    head = dict(per_day[best.day_type.key])
    head.pop("zone_centre_ids", None)

    stations = _s1_cache(feed, f"stations:{proj.lat0:.9f}", lambda: cluster_stations(
        sorted(feed.stops.values(), key=lambda s: s.stop_id), proj))
    both_km, one_km = _s1_route_km(feed)

    # Which calendar weekday runs which day type. Keyed on the calendar, not on the
    # day-type name, so a feed whose Mon–Fri split into per-weekday types still
    # answers "what happens on a Saturday".
    dow_type: dict[int, str] = {}
    for day in ordered:
        for date in day.day_type.dates:
            dow_type.setdefault(dow_of(date), day.day_type.key)

    weekday_dows = [d for d in range(5) if d in dow_type]
    weekday = per_day[dow_type[weekday_dows[0]]] if weekday_dows else per_day[best.day_type.key]
    saturday = per_day.get(dow_type[5]) if 5 in dow_type else None
    sunday = per_day.get(dow_type[6]) if 6 in dow_type else None

    # A weekend day the feed does not run at all counts as zero, not as absent —
    # "there are no Sunday buses" is the strongest possible weekend collapse. Only a
    # feed with no weekday service to compare against scores the neutral 1.0.
    if weekday_dows:
        weekend_ratio = _s1_share(min(saturday["trips"] if saturday else 0,
                                      sunday["trips"] if sunday else 0), weekday["trips"])
    else:
        weekend_ratio = 1.0

    dead_dates, reduced_dates = no_service_dates(feed, feed.feed_start, feed.feed_end)
    window_days = len(date_range(feed.feed_start, feed.feed_end))

    # playable_day_weight: 1/7 per calendar weekday whose day type keeps 60% of the
    # best day's zones and 70% of the size's required hours.
    playable: dict[str, float] = {}
    for name, params in sorted(_S1_SIZE_PARAMS.items()):
        total = 0.0
        for dow in range(7):
            info = per_day.get(dow_type.get(dow, ""))
            if not info:
                continue
            if info["n_zones"] >= 0.60 * head["n_zones"] and info["span_hours"] >= 0.70 * params["required_hours"]:
                total += 1.0 / 7.0
        playable[name] = total

    pos = _s1_positions(feed, proj)
    radar = radar_liveness(list(best.served_stop_ids), pos, [m * M_PER_MILE for m in _S1_RADAR_MILES])

    head.update({
        "stops_in_feed": len(feed.stops),
        "stations": len(stations),
        "distinct_base_names": len({s.base_name or s.name for s in feed.stops.values()}),
        "zone_radius_m": float(radius_m),
        "route_km_both_dirs": both_km, "route_km_one_dir": one_km,
        "route_mi_both_dirs": both_km * M_PER_KM / M_PER_MILE,
        "hub_dominance": hub.route_share if hub else None,
        "hub_trip_share": hub.trip_share if hub else None,
        "hub_stop_id": hub.stop_id if hub else None,
        "network_shape": hub.shape if hub else "unknown",
        "weekend_ratio": weekend_ratio,
        "sat_trip_ratio": _s1_share(saturday["trips"], weekday["trips"]) if saturday else None,
        "sun_trip_ratio": _s1_share(sunday["trips"], weekday["trips"]) if sunday else None,
        "sat_stop_ratio": _s1_share(saturday["served_stops"], weekday["served_stops"]) if saturday else None,
        "sun_stop_ratio": _s1_share(sunday["served_stops"], weekday["served_stops"]) if sunday else None,
        "weekday_day_key": weekday["day_key"],
        "saturday_day_key": saturday["day_key"] if saturday else None,
        "sunday_day_key": sunday["day_key"] if sunday else None,
        "dow_day_type": {str(d): dow_type.get(d) for d in range(7)},
        "no_service_dates": dead_dates,
        "reduced_service_dates": reduced_dates,
        "full_service_date_share": _s1_share(window_days - len(dead_dates) - len(reduced_dates), window_days),
        "playable_day_weight_by_size": playable,
        "radar_hit_rate": radar,
        "radar_hit_rate_mi": {m: radar[m * M_PER_MILE] for m in _S1_RADAR_MILES},
        "day_keys": [d.day_type.key for d in ordered],
        "best_day": best.day_type.key,
        "feed_window": (feed.feed_start, feed.feed_end),
        "feed_window_days": window_days,
        "per_day": per_day,
    })

    size_name = _s1_provisional_size(head)
    head["implied_size"] = size_name
    head["evening_zone_share"] = head["evening_zone_share_by_size"][size_name]
    head["reachable_zone_share"] = head["reachable_zone_share_by_size"][size_name]
    head["reach_within_hiding_period"] = head["reach_within_hiding_period_by_size"][size_name]
    head["playable_day_weight"] = playable[size_name]

    cached[key] = head
    return head


def route_headways(feed: Feed, days: Sequence[ServiceDay]) -> list[dict[str, Any]]:
    """Per-route median headway per day type, for the heatmap.

    Keyed on `(route_id, direction_id, stop_id)` and then medianed over the
    route-direction's stops. Computing it at "the busiest stop of the route" merges
    the two directions and reported one route as 3 min instead of 8 — always key on
    the direction.

    Returns rows shaped as contract.md §3.4 `route_headways[]`.
    """
    if not days:
        return []
    best_key = max(days, key=lambda d: (d.trips, d.day_type.key)).day_type.key

    # Midday is the honest window for "how often does this line run", but a peak-only
    # route has no midday service at all and would otherwise be indistinguishable from
    # a route that does not run that day. Widen the window until a number exists, so a
    # `None` headway means the line ran fewer than two trips past any single stop —
    # the row's `trips` counter says which of "none" and "one" it was.
    windows = (MIDDAY_WINDOW, HEADWAY_WINDOW, ("00:00:00", hhmmss(SERVICE_DAY_SECONDS)))

    # (route, direction) → day_key → median headway ; and trip counts per day
    headway: dict[tuple[str, str], dict[str, float | None]] = collections.defaultdict(dict)
    trips: dict[tuple[str, str], dict[str, int]] = collections.defaultdict(dict)
    for day in days:
        extras = _s1_extras(day)
        counts: dict[tuple[str, str], int] = collections.Counter(
            extras.trip_route[t] for t in sorted(extras.trip_route))
        per_window: list[dict[tuple[str, str], list[float]]] = []
        for window in windows:
            lo = hms_to_s(window[0]) or 0
            hi = hms_to_s(window[1]) or SERVICE_DAY_SECONDS
            per_dir: dict[tuple[str, str], list[float]] = collections.defaultdict(list)
            for (route_id, direction, _sid), values in sorted(extras.route_dir_stop.items()):
                inside = [v for v in values if lo <= v <= hi]
                if len(inside) < 2:
                    continue
                per_dir[(route_id, direction)].append(_s1_median(_s1_gaps(inside)) / 60.0)
            per_window.append(per_dir)
        for key in sorted(set(counts) | {k for pw in per_window for k in pw}):
            value = None
            for per_dir in per_window:
                if per_dir.get(key):
                    value = _s1_median(per_dir[key])
                    break
            headway[key][day.day_type.key] = value
            trips[key][day.day_type.key] = counts.get(key, 0)

    by_route: dict[str, list[str]] = collections.defaultdict(list)
    for route_id, direction in sorted(headway):
        by_route[route_id].append(direction)

    rows: list[dict[str, Any]] = []
    for route_id in sorted(by_route):
        route = feed.routes.get(route_id)
        directions = sorted(by_route[route_id])
        split = False
        if len(directions) == 2:
            a = headway[(route_id, directions[0])].get(best_key)
            b = headway[(route_id, directions[1])].get(best_key)
            if a and b and max(a, b) / min(a, b) > 1.5:
                split = True

        def row_for(direction: str | None, keys: Sequence[str]) -> dict[str, Any]:
            per_day: dict[str, float | None] = {}
            trip_counts: dict[str, int] = {}
            for day in days:
                dk = day.day_type.key
                values = [headway[(route_id, k)].get(dk) for k in keys]
                values = [v for v in values if v is not None]
                per_day[dk] = _s1_median(values) if values else None
                trip_counts[dk] = sum(trips[(route_id, k)].get(dk, 0) for k in keys)
            return {
                "route_id": route_id,
                "short_name": route.short_name if route else "",
                "long_name": route.long_name if route else "",
                "route_type": route.route_type if route else 3,
                "color": route.color if route else "",
                "direction_id": _s1_int(direction, 0) if (direction not in (None, "")) else None,
                "per_day": per_day,
                "trips": trip_counts,
            }

        if split:
            for direction in directions:
                rows.append(row_for(direction, [direction]))
        else:
            rows.append(row_for(None, directions))

    rows.sort(key=lambda r: (-max([v for v in r["trips"].values()] or [0]), r["route_id"],
                             -1 if r["direction_id"] is None else r["direction_id"]))
    return rows

# ═══════════════════════════════════════════════════════════════════════════════
# S1 · inference — hub, border, game size — and the question-layer inputs
# ═══════════════════════════════════════════════════════════════════════════════


def _s1_trips_touching(day: ServiceDay, stop_id: str) -> int:
    """Distinct trips of the day that call at `stop_id` (loops counted once)."""
    index: _S1StopIndex = day.stop_index
    i = index.by_id.get(stop_id)
    if i is None:
        return 0
    seen: set[str] = set()
    for pattern in day.patterns:
        if i in pattern.stops:
            seen.update(pattern.trip_ids)
    return len(seen)


def infer_hub(feed: Feed, day: ServiceDay, proj: Projection) -> Hub:
    """Infer the round-start station and classify the network's shape.

    Scores every served stop by `(distinct routes, stop events, stop_id)` and snaps
    the winner to the busiest member of its `HUB_SNAP_M` cluster so a directional
    pair does not split the score. `route_share ≥ 0.50` ⇒ radial-hub, `≥ 0.25` ⇒
    semi-radial, below ⇒ polycentric — and in the polycentric case `dominant` is
    False and the pages must *not* name a single hub, using the min-enclosing-circle
    centre as the map centre and the top three stops as start suggestions.
    """
    pos = _s1_positions(feed, proj)
    served = list(day.served_stop_ids)
    events = {sid: len(day.stop_days[sid].departures) for sid in served}
    routes = {sid: len(day.stop_days[sid].routes) for sid in served}

    ranked = sorted(served, key=lambda sid: (-routes[sid], -events[sid], sid))
    winner = ranked[0]

    # Snap to the busiest pole of the winner's cluster, but only among the members
    # that carry the cluster's full route count — snapping is there to resolve a
    # directional pair, and it must never *lower* the hub-dominance index.
    near = [sid for sid in served if math.dist(pos[sid], pos[winner]) <= HUB_SNAP_M]
    top_routes = max(routes[sid] for sid in near)
    winner = min((sid for sid in near if routes[sid] == top_routes),
                 key=lambda sid: (-events[sid], sid))

    total_routes = max(1, len(day.route_ids))
    route_share = routes[winner] / total_routes
    trip_share = _s1_share(_s1_trips_touching(day, winner), day.trips)

    shape: Literal["radial-hub", "semi-radial", "polycentric"]
    if route_share >= HUB_RADIAL_MIN:
        shape = "radial-hub"
    elif route_share >= HUB_SEMI_RADIAL_MIN:
        shape = "semi-radial"
    else:
        shape = "polycentric"
    dominant = route_share >= HUB_SEMI_RADIAL_MIN

    alternatives: list[tuple[str, str]] = []
    chosen = [winner]
    wanted = 2 if dominant else 3
    for sid in ranked:
        if len(alternatives) >= wanted:
            break
        if any(math.dist(pos[sid], pos[other]) <= HUB_SNAP_M for other in chosen):
            continue
        chosen.append(sid)
        alternatives.append((sid, feed.stops[sid].name))

    stop = feed.stops[winner]
    log.info("hub: %s (%s), %d/%d routes = %.3f, trip share %.3f, %s",
             winner, stop.name, routes[winner], total_routes, route_share, trip_share, shape)
    return Hub(stop_id=winner, name=stop.name, lat=stop.lat, lon=stop.lon,
               route_share=route_share, trip_share=trip_share, shape=shape,
               alternatives=tuple(alternatives), dominant=dominant)


def _s1_bbox_geojson(bbox: tuple[float, float, float, float]) -> dict[str, Any]:
    s, w, n, e = (coord(v) for v in bbox)
    ring = [[w, s], [e, s], [e, n], [w, n], [w, s]]
    return {"type": "Feature", "properties": {"kind": "bbox"},
            "geometry": {"type": "Polygon", "coordinates": [ring]}}


def _s1_circle_geojson(lat: float, lon: float, radius_m: float, *, steps: int = 96) -> dict[str, Any]:
    ring: list[list[float]] = []
    for k in range(steps + 1):
        theta = 2 * math.pi * (k % steps) / steps
        dlat = (radius_m * math.cos(theta)) / 111_132.0
        dlon = (radius_m * math.sin(theta)) / (111_320.0 * max(0.05, math.cos(math.radians(lat))))
        ring.append([coord(lon + dlon), coord(lat + dlat)])
    return {"type": "Feature", "properties": {"kind": "circle"},
            "geometry": {"type": "Polygon", "coordinates": [ring]}}


def infer_border(feed: Feed, day: ServiceDay, hub: Hub, size: GameSize, proj: Projection,
                 opts: Options) -> Border:
    """Derive the map border: the padded bbox of in-map stops, plus the circle.

    In-map means reachable from the hub within `3 × hiding_period` *and* able to
    reach the hub within the same (forward and reverse RAPTOR). This travel-time
    criterion replaces a geometric outlier trim on purpose: trimming the farthest
    0.5% of stops on the reference feed shrinks the enclosing circle 20% and the
    stops it deletes are the airport and the university campus — all excellent game
    locations. Padding is one zone radius, so every legal zone lies wholly inside.

    `--border-bbox` overrides the derivation entirely; `--border circle` only changes
    which shape is presented as canonical.
    """
    pos = _s1_positions(feed, proj)
    served = list(day.served_stop_ids)
    excluded = set(opts.exclude_stops)
    if opts.exclude_routes:
        blocked = set(opts.exclude_routes)
        excluded |= {sid for sid in served if set(day.stop_days[sid].routes) <= blocked}

    depart = hms_to_s(opts.departure) or hms_to_s(DEFAULT_DEPARTURE) or 32400
    budget = 3 * size.hiding_period_min * 60
    forward = raptor(day, [hub.stop_id], depart)
    backward = raptor_reverse(day, [hub.stop_id], depart + budget)

    allowed = [sid for sid in served if sid not in excluded] or list(served)
    reachable = [sid for sid in allowed
                 if sid in forward.arrival_s and forward.arrival_s[sid] - depart <= budget]
    in_map = [sid for sid in reachable if sid in backward and backward[sid] >= depart]

    # The travel-time criterion is a scalpel for a genuine outlier, not a way to
    # redraw the map. On a one-way or weakly connected network the round-trip test
    # can delete most of the system; if it does, fall back rather than print a border
    # that excludes the city. The reachability metrics report the problem instead.
    if len(in_map) < 0.5 * len(allowed):
        log.warning("border: the there-and-back test kept only %d of %d stops; "
                    "falling back to one-way reachability", len(in_map), len(allowed))
        in_map = reachable
    if len(in_map) < 0.5 * len(allowed):
        log.warning("border: one-way reachability kept only %d of %d stops; "
                    "using every served stop", len(in_map), len(allowed))
        in_map = allowed
    trimmed = tuple(sorted(set(served) - set(in_map)))
    if trimmed:
        log.info("border: %d of %d served stops are outside the %d-minute reach of the hub",
                 len(trimmed), len(served), budget // 60)

    lat_lon = [(feed.stops[sid].lat, feed.stops[sid].lon) for sid in sorted(in_map)]
    raw = bbox_of(lat_lon)
    pad = float(size.zone_radius_m)

    if opts.border_bbox:
        raw = tuple(opts.border_bbox)                       # type: ignore[assignment]
        padded = tuple(opts.border_bbox)                    # type: ignore[assignment]
        pad = 0.0
    else:
        padded = bbox_expand(raw, pad)

    cx, cy, r = min_enclosing_circle([pos[sid] for sid in sorted(in_map)])
    clon, clat = proj.lonlat(cx, cy)
    circle = (clat, clon, r + pad)

    sw, ne = proj.xy(padded[0], padded[1]), proj.xy(padded[2], padded[3])
    bbox_area = abs(ne[0] - sw[0]) * abs(ne[1] - sw[1])

    if opts.border_kind == "circle":
        geojson = _s1_circle_geojson(circle[0], circle[1], circle[2])
        area = math.pi * circle[2] ** 2
    else:
        geojson = _s1_bbox_geojson(padded)
        area = bbox_area

    return Border(kind=opts.border_kind, bbox=tuple(coord(v) for v in padded),   # type: ignore[arg-type]
                  raw_bbox=tuple(coord(v) for v in raw),                          # type: ignore[arg-type]
                  circle=(coord(circle[0]), coord(circle[1]), circle[2]),
                  pad_m=pad, geojson=geojson, area_sq_m=area, trimmed_stop_ids=trimmed)


def infer_game_size(metrics: dict[str, Any], opts: Options) -> tuple[GameSize, SizeInference]:
    """Vote on the game size across four axes and resolve the rulebook parameters.

    Axes (each scored 0=small / 1=medium / 2=large): convex-hull area of served stops
    (<100 / 100–1000 / >1000 sq mi), distinct ¼-mile zones (<100 / 100–500 / >500),
    T90 traversal time (≤45 / 45–180 / >180 min), straight-line diameter (<15 / 15–60
    / >60 mi). Combine with `floor(median(scores))` so ties round **down** to the
    smaller game, then clamp to within one step of the area axis.

    Validated against all eight of the rulebook's own examples, including the one
    genuinely marginal case (Winston-Salem), which the round-down tie-break puts on
    the correct side. `--size` / `--hiding-period` / `--zone-radius` override, and a
    non-unanimous vote must be reported as borderline on the page rather than hidden.
    """
    area_sq_mi = float(metrics.get("hull_sq_m", 0.0)) / SQM_PER_SQMI
    n_zones = int(metrics.get("n_zones", 0))
    t90 = float(metrics.get("t90_min", 0.0) or 0.0)
    diameter_mi = float(metrics.get("diameter_m", 0.0)) / M_PER_MILE
    votes = _s1_axis_scores(area_sq_mi, n_zones, t90, diameter_mi)

    raw_verdict = int(math.floor(lower_median(list(votes))))
    clamped_verdict = max(votes[0] - 1, min(votes[0] + 1, raw_verdict))
    clamped_verdict = max(0, min(2, clamped_verdict))
    clamped = clamped_verdict != raw_verdict
    verdict = _S1_SIZE_ORDER[clamped_verdict]

    axes = (
        {"id": "A", "name": "Convex-hull area", "value": rhu(area_sq_mi, 1), "unit": "sq mi",
         "score": votes[0], "thresholds": (100, 1000)},
        {"id": "B", "name": "Distinct hiding zones", "value": n_zones, "unit": "zones",
         "score": votes[1], "thresholds": (100, 500)},
        {"id": "C", "name": "T90 traversal time", "value": rhu(t90, 1), "unit": "min",
         "score": votes[2], "thresholds": (45, 180)},
        {"id": "D", "name": "Straight-line diameter", "value": rhu(diameter_mi, 2), "unit": "mi",
         "score": votes[3], "thresholds": (15, 60)},
    )
    unanimous = len(set(votes)) == 1
    if unanimous:
        note = "All four axes agree."
    else:
        disagree = ", ".join(f"{a['id']}={_S1_SIZE_ORDER[a['score']]}" for a in axes)
        note = f"Axes disagree ({disagree}); the median rounds down to the smaller game."
    if clamped:
        note += " The vote was clamped to stay within one step of the area axis."

    forced = opts.size is not None
    name = opts.size or verdict
    if forced:
        note += f" Overridden with --size {name}."

    params = dict(_S1_SIZE_PARAMS[name])
    if opts.hiding_period_min is not None:
        params["hiding_period_min"] = int(opts.hiding_period_min)
    if opts.zone_radius_m is not None:
        params["zone_radius_m"] = float(opts.zone_radius_m)

    size = GameSize(
        name=name,  # type: ignore[arg-type]
        hiding_period_min=int(params["hiding_period_min"]),
        zone_radius_m=float(params["zone_radius_m"]),
        tentacle_reach_mi=float(params["tentacle_reach_mi"]),
        thermometer_mi=tuple(params["thermometer_mi"]),
        category_count=int(params["category_count"]),
        catalogue_size=int(params["catalogue_size"]),
        photo_limit_min=int(params["photo_limit_min"]),
        other_limit_min=int(params["other_limit_min"]),
        move_grant_min=int(params["move_grant_min"]),
        required_hours=float(params["required_hours"]),
        inferred=not forced,
    )
    inference = SizeInference(axes=axes, votes=votes, verdict=verdict,  # type: ignore[arg-type]
                              unanimous=unanimous, clamped=clamped, note=note)
    log.info("game size: %s (axes %s)%s", name, votes, " [forced]" if forced else "")
    return size, inference


def _s1_zone_radius(zones: Sequence[Zone]) -> float:
    """Recover the radius a zone set was built at, from the zones themselves.

    Every member stop lies inside its centre's circle, so the largest centre-to-member
    distance is a lower bound on the radius; snap that up to the rulebook radius that
    contains it. Needed because `travel_time_samples` is handed zones, not a radius.
    """
    widest = 0.0
    by_id = {z.zone_id: z for z in zones}
    for zone in zones:
        for sid in zone.stop_ids:
            other = by_id.get(sid)
            if other is not None:
                widest = max(widest, math.dist((zone.x, zone.y), (other.x, other.y)))

    # No two centres are within one radius of each other (that is what the greedy
    # cover guarantees), so the true radius is in [widest, closest_pair).
    closest = float("inf")
    points = sorted((z.x, z.y) for z in zones)
    grid: dict[tuple[int, int], list[tuple[float, float]]] = collections.defaultdict(list)
    cell = max(1.0, QUARTER_MILE_M)
    for x, y in points:
        grid[(int(math.floor(x / cell)), int(math.floor(y / cell)))].append((x, y))
    for x, y in points:
        gx, gy = int(math.floor(x / cell)), int(math.floor(y / cell))
        for dx in (-2, -1, 0, 1, 2):
            for dy in (-2, -1, 0, 1, 2):
                for other in grid.get((gx + dx, gy + dy), ()):
                    if other != (x, y):
                        closest = min(closest, math.dist((x, y), other))

    for candidate in (HALF_MILE_M, QUARTER_MILE_M):
        if widest <= candidate < closest:
            return candidate
    return max(widest, QUARTER_MILE_M)


def travel_time_samples(feed: Feed, days: Sequence[ServiceDay], zones: Sequence[Zone],
                        origin_stop_id: str, departure_s: int, proj: Projection,
                        count: int = 14) -> list[dict[str, Any]]:
    """A deterministic destination sample for the ride-time chart.

    Re-runs the zone cover at `3 × zone_radius` to get well-spread destinations, takes
    the `count` highest-`stop_events` picks, and reports travel time and transfers from
    `origin_stop_id` **on every day type**, so the chart can re-render when the reader
    switches days. Rows are sorted by travel time on the best day; a destination with
    no service that day carries `minutes: None`, which the chart draws hollow-dashed
    rather than omitting.
    """
    if not zones or not days:
        return []
    radius = _s1_zone_radius(zones)
    by_id = {z.zone_id: z for z in zones}
    pos = {z.zone_id: (z.x, z.y) for z in zones}
    events = {z.zone_id: z.stop_events for z in zones}

    wanted = max(1, int(count))
    spread = [zid for zid in zone_cover(sorted(pos), 3.0 * radius, events, pos)
              if zid != origin_stop_id]          # a 0-minute bar for the start is noise
    picks = sorted(spread, key=lambda zid: (-events[zid], zid))[:wanted]
    if len(picks) < wanted:
        # A small network can collapse to a handful of well-spread picks; top the
        # chart up with the busiest remaining zones rather than draw three bars.
        chosen = set(picks)
        for zid in sorted(pos, key=lambda z: (-events[z], z)):
            if len(picks) >= wanted:
                break
            if zid != origin_stop_id and zid not in chosen:
                picks.append(zid)
                chosen.add(zid)

    best_key = max(days, key=lambda d: (d.trips, d.day_type.key)).day_type.key
    runs: dict[str, TravelTimes | None] = {}
    for day in days:
        origin = origin_stop_id if origin_stop_id in day.stop_days else None
        runs[day.day_type.key] = raptor(day, [origin], departure_s) if origin else None

    rows: list[dict[str, Any]] = []
    for zid in sorted(picks):
        zone = by_id[zid]
        per_day: dict[str, dict[str, Any]] = {}
        for day in days:
            key = day.day_type.key
            run = runs[key]
            entry: dict[str, Any] = {"minutes": None, "transfers": None, "routes": []}
            if run is not None and zid in run.arrival_s:
                journey = build_journey(day, run, zid)
                entry["minutes"] = rhu((run.arrival_s[zid] - departure_s) / 60.0, 1)
                entry["transfers"] = run.rounds.get(zid, 0)
                entry["routes"] = sorted({leg["route_id"] for leg in (journey.legs if journey else ())
                                          if leg["mode"] == "transit" and leg["route_id"]})
            per_day[key] = entry
        rows.append({
            "stop_id": zid, "zone_id": zid, "name": zone.name,
            "lat": coord(zone.lat), "lon": coord(zone.lon),
            "stop_events": zone.stop_events, "per_day": per_day,
        })

    rows.sort(key=lambda r: (r["per_day"].get(best_key, {}).get("minutes") is None,
                             r["per_day"].get(best_key, {}).get("minutes") or 0.0,
                             r["stop_id"]))
    return rows


def gtfs_question_facts(feed: Feed, days: Sequence[ServiceDay], zones: Sequence[Zone],
                        stations: Sequence[Station]) -> dict[str, Any]:
    """The GTFS-only inputs the question layer needs, in one bundle.

    Keys: `has_rail` (any `route_type` in the rail-ish set — a pure-GTFS
    determination that kills four questions on a bus-only feed), `route_types`,
    `routes_by_zone`, `station_name_lengths`, `metro_route_ids`,
    `multi_route_stop_share`, and `u_turn` (the fraction of stops with ≥2 routes and
    the median wait for a *different* route inside the U-Turn card's 0.5/0.5/1-hour
    window — that curse is decided by GTFS, not OSM).
    """
    best = max(days, key=lambda d: (d.trips, d.day_type.key)) if days else None
    route_types = sorted({r.route_type for r in feed.routes.values()})
    rail_ids = sorted(rid for rid, r in feed.routes.items() if r.route_type in _S1_RAIL_TYPES)

    routes_by_zone = {z.zone_id: list(z.route_ids) for z in sorted(zones, key=lambda z: z.zone_id)}
    zone_route_count = {z.zone_id: len(z.route_ids) for z in zones}
    name_lengths = {z.zone_id: len(z.name) for z in sorted(zones, key=lambda z: z.zone_id)}
    all_lengths = sorted(len(s.name) for s in stations) or sorted(len(z.name) for z in zones)
    raw_lengths = sorted(len(s.name) for s in feed.stops.values())

    # ── Curse of the U-Turn: is there a second line to escape onto, and how long
    #    would you wait for it? ────────────────────────────────────────────────
    multi_share = 0.0
    waits: list[float] = []
    per_stop_wait: dict[str, float] = {}
    if best is not None:
        extras = _s1_extras(best)
        served = list(best.served_stop_ids)
        multi = [sid for sid in served if len(best.stop_days[sid].routes) >= 2]
        multi_share = _s1_share(len(multi), len(served))
        lo = hms_to_s(HEADWAY_WINDOW[0]) or 0
        hi = hms_to_s(HEADWAY_WINDOW[1]) or SERVICE_DAY_SECONDS
        for sid in multi:
            events: list[tuple[int, str]] = []
            for (route_id, _direction, stop_id), values in sorted(extras.route_dir_stop.items()):
                if stop_id != sid:
                    continue
                events.extend((v, route_id) for v in values if lo <= v <= hi)
            events.sort()
            gaps: list[float] = []
            for i, (t, route_id) in enumerate(events):
                for later, other in events[i + 1:]:
                    if other != route_id:
                        gaps.append((later - t) / 60.0)
                        break
            if gaps:
                per_stop_wait[sid] = _s1_median(gaps)
                waits.append(per_stop_wait[sid])

    served_total = len(best.served_stop_ids) if best is not None else 0
    u_turn = {
        "multi_route_stop_share": multi_share,
        "stops_with_alternative": len(per_stop_wait),
        "served_stops": served_total,
        "median_wait_other_route_min": _s1_median(waits) if waits else None,
        "share_within_30min": _s1_share(sum(1 for w in per_stop_wait.values() if w <= 30), served_total),
        "share_within_60min": _s1_share(sum(1 for w in per_stop_wait.values() if w <= 60), served_total),
        "zone_share_with_two_routes": _s1_share(
            sum(1 for c in zone_route_count.values() if c >= 2), len(zone_route_count)),
    }

    return {
        "has_rail": bool(rail_ids),
        "route_types": route_types,
        "route_type_names": {str(r.route_type): r.route_id for r in sorted(
            feed.routes.values(), key=lambda r: r.route_id)},
        "metro_route_ids": rail_ids,
        "routes_by_zone": routes_by_zone,
        "zone_route_count": zone_route_count,
        "station_name_lengths": name_lengths,
        "station_name_lengths_all": all_lengths,
        "station_name_length_stats": {
            "min": all_lengths[0] if all_lengths else 0,
            "p25": quantile(all_lengths, 0.25) if all_lengths else 0,
            "median": quantile(all_lengths, 0.50) if all_lengths else 0,
            "p75": quantile(all_lengths, 0.75) if all_lengths else 0,
            "max": all_lengths[-1] if all_lengths else 0,
            "count": len(all_lengths),
        },
        "stop_name_length_stats": {
            "min": raw_lengths[0] if raw_lengths else 0,
            "p25": quantile(raw_lengths, 0.25) if raw_lengths else 0,
            "median": quantile(raw_lengths, 0.50) if raw_lengths else 0,
            "p75": quantile(raw_lengths, 0.75) if raw_lengths else 0,
            "max": raw_lengths[-1] if raw_lengths else 0,
            "count": len(raw_lengths),
        },
        "names_containing_station": sum(
            1 for s in feed.stops.values() if "station" in (s.name or "").lower()),
        "stations": len(stations),
        "multi_route_stop_share": multi_share,
        "u_turn": u_turn,
        "routes": {rid: {"label": r.label, "short_name": r.short_name, "long_name": r.long_name,
                         "route_type": r.route_type, "is_rail": r.is_rail}
                   for rid, r in sorted(feed.routes.items())},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# S2 · GEO — Overpass, Nominatim, categories, spatial inventory
# ═══════════════════════════════════════════════════════════════════════════════
#
# Owner: the S2 agent. Spec: scratchpad/specs/osm.md (every count in it was measured
# live; nine cached responses are in scratchpad/cache/).
#
# Etiquette is a hard requirement, not a nicety: ONE bbox-wide query per category,
# never one per stop (1,493 stops × 16 categories would be 24,000 requests and a
# ban). The whole reference dataset was six Overpass calls and one Nominatim call.
# Overpass bbox order is (S, W, N, E) — the opposite of GeoJSON. Mirror failover is
# required; the main endpoint 504'd on five of six first attempts.


@dataclass(frozen=True)
class GeoCategory:
    """One rulebook feature category and the exact selector that realises it.

    `selector` is Overpass QL with `{{bbox}}` unsubstituted; it is printed verbatim
    next to every count on the page so a player can re-run it. `needs_geometry` marks
    the categories where a distance or a polygon test is required (fetch `out geom`),
    versus the ones where a count or a centre suffices.
    """

    key: str
    label: str
    selector: str
    needs_geometry: bool = False
    note: str = ""


# The category table is the S1/S2/S3 interface: S2 fetches it, S3 asks questions of
# it, S4/S5 print the selectors. Counts in the comments are the measured reference
# values, kept as a regression anchor.
GEO_CATEGORIES: tuple[GeoCategory, ...] = (
    GeoCategory("park", "Park",
                'nwr["leisure"="park"]["name"]({{bbox}});', needs_geometry=True,
                note="Not garden/nature_reserve/recreation_ground — a map app gives those different icons."),  # 214
    GeoCategory("museum", "Museum", 'nwr["tourism"="museum"]["name"]({{bbox}});'),  # 10
    GeoCategory("movie_theater", "Movie theater", 'nwr["amenity"="cinema"]["name"]({{bbox}});'),  # 7
    GeoCategory("hospital", "Hospital", 'nwr["amenity"="hospital"]["name"]({{bbox}});',
                note="Excludes amenity=clinic and amenity=doctors — including them is a 7× overcount."),  # 6
    GeoCategory("library", "Library", 'nwr["amenity"="library"]["name"]({{bbox}});',
                note="Excludes amenity=public_bookcase (Little Free Libraries)."),  # 21
    GeoCategory("zoo", "Zoo", 'nwr["tourism"="zoo"]({{bbox}});'),  # 1
    GeoCategory("aquarium", "Aquarium", 'nwr["tourism"="aquarium"]({{bbox}});'),  # 1
    GeoCategory("amusement_park", "Amusement park", 'nwr["tourism"="theme_park"]({{bbox}});',
                note="Excludes leisure=water_park and amusement_arcade."),  # 1
    GeoCategory("golf_course", "Golf course",
                'nwr["leisure"="golf_course"]["golf"!="driving_range"]["name"]({{bbox}});',
                note="The rulebook explicitly excludes mini golf and driving ranges."),  # 18
    GeoCategory("foreign_consulate", "Foreign consulate",
                'nwr["office"="diplomatic"]["diplomatic"~"^(consulate|consulate_general)$"]'
                '["consulate"!="honorary"]({{bbox}});',
                note="Honorary consulates are excluded by the rulebook."),  # 0
    GeoCategory("commercial_airport", "Commercial airport",
                'nwr["aeroway"="aerodrome"]["iata"]({{bbox}});', needs_geometry=True,
                note="The iata filter is what makes it 'commercial'; without it, private grass strips count."),  # 1
    GeoCategory("mountain", "Mountain", 'node["natural"~"^(peak|volcano)$"]["name"]({{bbox}});'),  # 0
    GeoCategory("rail_station", "Rail station", 'nwr["railway"~"^(station|halt)$"]({{bbox}});',
                note="Unioned with GTFS stops on rail route types."),  # 1
    GeoCategory("high_speed_rail", "High-speed rail line",
                'way["railway"="rail"]["highspeed"="yes"]({{bbox}});',
                note="Fallback: parse maxspeed ≥ 200 km/h, accepting '200', '200 km/h' and '125 mph'."),  # 0
    GeoCategory("water", "Body of water",
                'nwr["natural"="water"]["name"]["water"!~"^(pool|reflecting_pool)$"]'
                '["leisure"!="swimming_pool"]({{bbox}});'
                'way["waterway"~"^(river|canal)$"]["name"]({{bbox}});', needs_geometry=True,
                note="The name filter is the measuring question's own wording — \"any named "
                     "body of water on your maps app, excluding pools\": 999 water features "
                     "exist, 75 are named. It belongs to THIS question only. Curse of the Water "
                     "Weight says \"marked\", not \"named\", and has its own unnamed predicate "
                     "in CURSE_PREDICATE_SELECTORS."),  # 75+48
    GeoCategory("coastline", "Coastline", 'way["natural"="coastline"]({{bbox}});',
                note="OSM tags ocean/sea only, so shore segments are also derived from any "
                     "water body larger than the game map — a great-lake shore is a coast."),  # 0 tagged
    GeoCategory("street", "Street or path",
                'way["highway"]["highway"!~"^(motorway|motorway_link|trunk_link|construction|proposed|raceway)$"]'
                '({{bbox}});',
                note="Dissolved by name per connected component; unnamed ways split at intersections."),  # 14,246 named
    GeoCategory("restaurant", "Restaurant", 'nwr["amenity"="restaurant"]({{bbox}});'),  # 368
    GeoCategory("grocery", "Grocery store",
                'nwr["shop"~"^(supermarket|greengrocer|convenience|grocery|farm)$"]({{bbox}});'),  # 233
    GeoCategory("place_of_worship", "Place of worship", 'nwr["amenity"="place_of_worship"]({{bbox}});'),  # 227
    GeoCategory("toilets", "Public toilets", 'nwr["amenity"="toilets"]({{bbox}});'),  # 81
    GeoCategory("cafe", "Cafe", 'nwr["amenity"="cafe"]({{bbox}});'),  # 90
    GeoCategory("fast_food", "Fast food", 'nwr["amenity"="fast_food"]({{bbox}});'),
    GeoCategory("bench", "Bench", 'node["amenity"="bench"]({{bbox}});'),  # 241
    GeoCategory("shelter", "Shelter", 'nwr["amenity"="shelter"]({{bbox}});'),
    GeoCategory("platform", "Train platform",
                'nwr["railway"="platform"]({{bbox}});nwr["public_transport"="platform"]({{bbox}});'),
    GeoCategory("tree", "Tree", 'node["natural"="tree"]({{bbox}});'),  # 2,675
    GeoCategory("building", "Building", 'way["building"]({{bbox}});',
                note="Fetched with `out center qt` — id and one point each, ~8 MB not ~120 MB."),  # 134,962
    GeoCategory("green", "Green landuse",
                'nwr["landuse"~"^(forest|grass|meadow|village_green|recreation_ground)$"]({{bbox}});'),  # 640
    GeoCategory("pitch", "Pitch / playground",
                'nwr["leisure"~"^(pitch|playground|recreation_ground|garden|nature_reserve)$"]({{bbox}});'),  # 1,559
    GeoCategory("footpath", "Footpath",
                'way["highway"~"^(footway|path|pedestrian|steps|cycleway|track)$"]({{bbox}});'),  # 30,827
    GeoCategory("bridge", "Bridge",
                'way["bridge"]["bridge"!="no"]["highway"]({{bbox}});'
                'way["bridge"]["bridge"!="no"]["railway"]({{bbox}});',
                note="The Bridge Troll card defines a bridge as \"any elevated structure, acting "
                     "as a path, road or railway\" — so railway bridges are in, and covered "
                     "bridges are not filtered out. Kept identical to the `bridge` curse "
                     "predicate."),  # >1,026 (1,026 was the road-only, uncovered count)
    GeoCategory("car_street", "Motor-vehicle street", "", note="See CAR_STREET_SELECTOR."),  # 54,693
    GeoCategory("shop", "Shop", 'nwr["shop"]({{bbox}});'),  # 1,220
    GeoCategory("advertising", "Advertising", 'nwr["advertising"]({{bbox}});',
                note="OSM barely maps billboards — a low count is not evidence of scarcity."),  # 22
    GeoCategory("newsagent", "Print source",
                'nwr["shop"~"^(newsagent|books|kiosk|stationery)$"]({{bbox}});'),  # 23
)

# One constant, three consumers (Right Turn, Luxury Car, street density) — so they
# can never disagree about what a street is.
CAR_STREET_SELECTOR = (
    'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|'
    'living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]'
    '["motor_vehicle"!="no"]["access"!="no"]({{bbox}});'
)

# Foot-routable graph for the "within 10 ft of a marked path" legality test.
FOOT_WAY_SELECTOR = (
    'way["highway"]["highway"!~"^(motorway|motorway_link|trunk|trunk_link)$"]'
    '["foot"!~"^(no|private)$"]["access"!~"^(no|private)$"]({{bbox}});'
)

# Street View coverage — a static country table, NOT an OSM query. The rulebook
# names Germany explicitly; this is the low-coverage set the Unguided Tourist curse
# is removed for.
LOW_STREETVIEW_COUNTRIES = frozenset({"de", "at", "by", "cn", "in", "ba", "lt"})


@dataclass(frozen=True)
class Poi:
    """One OSM feature reduced to what the questions need.

    `lat`/`lon` is the **representative point** (the rulebook's "map icon"): a node's
    own coordinates, a closed way's area centroid with an interior fallback, an open
    way's length-weighted midpoint, or a multipolygon's area-weighted centroid.
    Never Overpass's `out center`, which is the bbox centre.

    `rings` carries polygon geometry only for categories where a containment test is
    needed (parks and water), because the photo questions ask about the polygon while
    the matching/measuring questions ask about the icon — two predicates that must
    never be interchanged.
    """

    category: str
    osm_type: Literal["node", "way", "relation"]
    osm_id: int
    name: str
    lat: float
    lon: float
    tags: dict[str, str] = field(default_factory=dict)
    rings: tuple[tuple[tuple[float, float], ...], ...] = ()


@dataclass
class OverpassQueryRecord:
    """Provenance for one Overpass statement: what was asked and what came back."""

    key: str
    selector: str
    bbox: tuple[float, float, float, float]
    count: int
    cache_key: str
    endpoint: str
    partial: bool = False       # True when a size guard forced a degraded query


@dataclass
class AdminInfo:
    """The administrative-division ladder for this map.

    `ordinals` maps 1..4 → OSM `admin_level`, derived rather than guessed: Nominatim's
    `ISO3166-2-lvl<N>` key literally encodes the country's first-division level, and
    ordinals 2–4 are the distinct levels present across all zone centres above it. A
    missing ordinal is `None` and must render as "no Nth division here", never as a
    guessed level. Unknown country ⇒ every admin question is `unknown`, not `dead`.
    """

    country_code: str | None
    country_name: str | None
    place_name: str | None
    ordinals: dict[int, int | None]
    per_zone: dict[str, dict[int, str]]     # zone_id → ordinal → division name
    border_levels: dict[int, bool]          # ordinal → does a boundary line cross the map
    source: str                             # 'nominatim' | 'is_in' | 'unknown'


@dataclass
class GeoData:
    """Everything S2 produces, in one object.

    Absent categories are absent *keys*, and that is load-bearing: a category that
    was never queried and a category with zero features are different states all the
    way to the page. Never conflate them.
    """

    available: bool                         # False under --no-osm or total Overpass failure
    bbox: tuple[float, float, float, float]
    pois: dict[str, list[Poi]]              # category key → features, sorted by (type, id)
    counts: dict[str, int]                  # category key → in-border feature count
    zone_inventory: dict[str, dict[str, int]]   # zone_id → category → count inside the circle
    zone_polygon_hits: dict[str, dict[str, bool]]  # zone_id → category → polygon intersects circle
    admin: AdminInfo
    curse_counts: dict[str, int]            # curse id → the count its predicate returned
    cuisines: dict[str, int]                # ISO-3166-1 alpha-2 → qualifying restaurants
    legal_spots: dict[str, list[dict[str, Any]]]   # zone_id → candidate endgame spots
    queries: list[OverpassQueryRecord]
    notes: list[str]                        # honesty notes that must reach the page


# ── S2 functions ──────────────────────────────────────────────────────────────


# ═══════════════════════════════════════════════════════════════════════════════
# S2 · GEO — implementation (concatenate into generate.py in place of the stubs)
# ═══════════════════════════════════════════════════════════════════════════════
#
# NAMES ASSUMED IN SCOPE (all provided by the skeleton, none redefined here)
#
#   stdlib already imported at the top of generate.py:
#       collections, json, math, re, time   (no new stdlib import is needed)
#   third-party: none directly — httpx is only ever touched inside http_fetch().
#
#   constants:  OVERPASS_ENDPOINTS, NOMINATIM_ENDPOINT, OVERPASS_COURTESY_SLEEP_S,
#               NOMINATIM_COURTESY_SLEEP_S, OVERPASS_WAY_BUDGET, HTTP_TIMEOUT_S,
#               QUARTER_MILE_M, M_PER_MILE, GEO_CATEGORIES, CAR_STREET_SELECTOR,
#               FOOT_WAY_SELECTOR, LOW_STREETVIEW_COUNTRIES, USER_AGENT, log
#   classes:    Cache, CacheMiss, Options, Projection, GridIndex, GeoCategory,
#               Poi, OverpassQueryRecord, AdminInfo, GeoData, Zone, Border
#   functions:  http_fetch, sha256_text, haversine_m, bbox_of, bbox_expand,
#               bbox_contains, polygon_area, ring_centroid, point_in_ring,
#               representative_point, polyline_midpoint, seg_point_dist,
#               ring_within, num, pct, miles, quantile
#
# Everything below is deterministic: no wall clock reaches a return value, every
# dict/set is iterated through sorted(), every tie-break ends in a stable OSM id,
# and every cache key is the fully-substituted request text.


# ── tuning constants (S2-local) ───────────────────────────────────────────────

OVERPASS_QL_TIMEOUT_S = 300          # the [timeout:N] header inside the QL itself
OVERPASS_TILE_DEG = 0.1              # ≤0.1° squares when a single-shot fetch fails
CATEGORY_FEATURE_BUDGET = 40_000     # above this, a category is counted but not fetched
IS_IN_BATCH = 150                    # zone centres per batched is_in request
LEGAL_SPOTS_PER_ZONE = 40            # cap on the per-zone shortlist (page size guard)
TOILET_WIDE_FACTOR = 1.5             # A1's "just outside the circle" fallback ring
REDUNDANT_PAIR_FRACTION = 0.05       # 1/20 of the map diagonal (specs/osm.md §7.4)
LEGAL_PATH_RADIUS_M = 5              # OSM analogue of the rulebook's 10 ft
LEGAL_PATH_QL_TIMEOUT_S = 120        # the optional path join gets a small server budget
LEGAL_PATH_HTTP_TIMEOUT_S = 150.0    # …and one attempt per mirror, not two
# Buffering every walkable way by 5 m is the most expensive thing this program can ask
# a shared free service to do. Measured on the reference bbox (84,466 non-motorway
# highway ways) it timed out on all three mirrors, twice, costing 7½ minutes for an
# optional refinement. So it is only attempted on maps whose walkable network is small
# enough for the join to be cheap; above the budget the test is skipped and every
# candidate spot is honestly marked verify-on-the-ground.
LEGAL_PATH_JOIN_WAY_BUDGET = 40_000
SPOT_VERIFY_WEIGHT = 0.5             # restrictive opening_hours ⇒ half weight

# Which categories are fetched as features, grouped into as few Overpass requests
# as the size guard allows. One request per group; statements are separated in the
# response by `out count;` markers so attribution is never guessed.
GEO_FETCH_GROUPS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("landmarks", ("advertising", "amusement_park", "aquarium", "bench", "coastline",
                   "commercial_airport", "foreign_consulate", "golf_course", "high_speed_rail",
                   "hospital", "library", "mountain", "movie_theater", "museum", "newsagent",
                   "platform", "rail_station", "shelter", "toilets", "zoo")),
    ("areas", ("park", "water")),
    ("amenities", ("cafe", "fast_food", "grocery", "place_of_worship", "restaurant", "shop", "tree")),
    ("cover", ("green", "pitch")),
)

# Descriptive: the categories no group fetches. They are counted map-wide and never
# pulled as features, because they are densities rather than icons and their geometry
# would be tens of megabytes in service of no question.
GEO_COUNT_ONLY: tuple[str, ...] = ("bridge", "car_street", "footpath", "street")

# Fetched with `out center qt` — a pure density tally, the one place where the
# bbox centre is acceptable (specs/osm.md §3.1).
GEO_DENSITY_ONLY: tuple[str, ...] = ("building",)

# Rings are kept only where a containment test is actually asked for. The photo
# questions ask "is the hider standing in a park", the matching/measuring ones ask
# about the icon; the two predicates must never be interchanged.
RING_CATEGORIES: frozenset[str] = frozenset({"park", "water", "commercial_airport"})

# Categories that can supply a candidate endgame spot, with the weight the spot
# starts at. Restricted to categories this pipeline already fetches, so the
# shortlist costs no extra request. `True` = the feature is an enclosure when it is
# an area (park interior, playground, pitch), `False` = a point on the street.
LEGAL_SPOT_CATEGORIES: tuple[tuple[str, float, bool], ...] = (
    ("park", 1.0, True),
    ("pitch", 1.0, True),
    ("green", 0.5, True),      # a grass verge is a place to stand, not a destination
    ("bench", 1.0, False),
    ("shelter", 1.0, False),
    ("platform", 0.75, False),
    ("library", 0.75, False),
    ("place_of_worship", 0.5, False),
    ("toilets", 0.75, False),
)

# Access values that make a feature unusable as a hiding spot.
PRIVATE_ACCESS = frozenset({"private", "no", "customers", "permit", "military", "delivery"})

# Curse predicates that are decided by an OSM count. Everything else — Unguided
# Tourist (a static Street View country table) and U-Turn (GTFS route overlap) —
# is decided elsewhere and deliberately absent from this table.
CURSE_PREDICATE_SELECTORS: tuple[tuple[str, str], ...] = (
    # "'Bridge' is defined as any elevated structure, acting as a path, road or railway,
    # intended to be crossed by pedestrians, cars, or other vehicles" (Bridge Troll). So the
    # ["highway"] clause cannot be mandatory — railway bridges are named outright — and
    # covered bridges are not excluded: the card cares that it is crossable, not that it is
    # open to the sky. Two statements because Overpass cannot OR across two keys in one; the
    # surrounding union deduplicates a way carrying both.
    ("bridge", 'way["bridge"]["bridge"!="no"]["highway"]({{bbox}});'
               'way["bridge"]["bridge"!="no"]["railway"]({{bbox}});'),
    # "'Body of water' within this context does not necessarily mean natural, but it cannot
    # be a pool and must be large enough to be marked on the map" (Water Weight). MARKED, not
    # named — so no ["name"] filter here. The named form belongs to the *measuring* question
    # ("any named body of water on your maps app"), which is the GEO_CATEGORIES `water`
    # category; the two are kept apart on purpose because they differ by 8:1 and one drifted
    # into the other once already. "Not necessarily natural" pulls in reservoirs and basins.
    # "Large enough to be marked" has no tag that expresses it, so it is approximated by "OSM
    # marks it at all" — the honest reading, and the looser one, which is the right direction
    # for a REMOVAL test.
    ("water", 'nwr["natural"="water"]["water"!~"^(pool|reflecting_pool)$"]'
              '["leisure"!="swimming_pool"]({{bbox}});'
              'nwr["landuse"~"^(reservoir|basin)$"]({{bbox}});'
              'way["waterway"~"^(river|canal)$"]({{bbox}});'),
    ("car_street", CAR_STREET_SELECTOR),
    ("grocery", 'nwr["shop"~"^(supermarket|greengrocer|convenience|grocery|farm)$"]({{bbox}});'),
    ("shop", 'nwr["shop"]({{bbox}});'),
    ("cairn_terrain", 'nwr["natural"~"^(scree|bare_rock|beach|shingle|wood)$"]({{bbox}});'),
    ("print_source", 'nwr["shop"~"^(newsagent|books|kiosk|stationery)$"]({{bbox}});'),
    ("tumble_ground", 'nwr["leisure"~"^(pitch|playground|recreation_ground|garden|nature_reserve)$"]({{bbox}});'),
    ("building", 'way["building"]({{bbox}});'),
    ("travel_agent_stop", 'nwr["leisure"~"^(park|garden|playground)$"]({{bbox}});'
                          'nwr["amenity"~"^(library|place_of_worship|marketplace|townhall)$"]({{bbox}});'
                          'way["highway"="pedestrian"]({{bbox}});'),
    ("animal_habitat", 'nwr["leisure"~"^(park|nature_reserve)$"]({{bbox}});'
                       'nwr["landuse"~"^(forest|grass|meadow|village_green)$"]({{bbox}});'
                       'nwr["natural"="water"]["name"]({{bbox}});'),
)

# curse id → predicate key above. A curse absent from this map is decided by GTFS
# or by a static table, never by silence.
CURSE_PREDICATE_MAP: tuple[tuple[str, str], ...] = (
    ("bridge_troll", "bridge"),
    ("water_weight", "water"),
    ("right_turn", "car_street"),
    ("luxury_car", "car_street"),
    ("lemon_phylactery", "grocery"),
    ("egg_partner", "grocery"),
    ("impressionable_consumer", "shop"),
    ("cairn", "cairn_terrain"),
    ("ransom_note", "print_source"),
    ("endless_tumble", "tumble_ground"),
    ("jammed_door", "building"),
    ("mediocre_travel_agent", "travel_agent_stop"),
    ("zoologist", "animal_habitat"),
    ("bird_guide", "animal_habitat"),
)

# ── cuisine → ISO-3166-1 alpha-2 ──────────────────────────────────────────────
# Adjective tokens ONLY. Promoting a dish to a country is a judgement call that
# changes the count, so dishes and super-national regions are rejected and the
# rejected tokens are reported so a player can override.

CUISINE_COUNTRY: dict[str, str] = {
    "afghan": "AF", "albanian": "AL", "algerian": "DZ", "american": "US", "argentinian": "AR",
    "argentine": "AR", "armenian": "AM", "australian": "AU", "austrian": "AT", "bangladeshi": "BD",
    "basque": "ES", "belgian": "BE", "bolivian": "BO", "bosnian": "BA", "brazilian": "BR",
    "british": "GB", "bulgarian": "BG", "cambodian": "KH", "canadian": "CA", "chilean": "CL",
    "chinese": "CN", "colombian": "CO", "croatian": "HR", "cuban": "CU", "czech": "CZ",
    "danish": "DK", "dominican": "DO", "dutch": "NL", "ecuadorian": "EC", "egyptian": "EG",
    "english": "GB", "eritrean": "ER", "estonian": "EE", "ethiopian": "ET", "filipino": "PH",
    "finnish": "FI", "french": "FR", "georgian": "GE", "german": "DE", "ghanaian": "GH",
    "greek": "GR", "guatemalan": "GT", "haitian": "HT", "hawaiian": "US", "honduran": "HN",
    "hungarian": "HU", "icelandic": "IS", "indian": "IN", "indonesian": "ID", "iranian": "IR",
    "persian": "IR", "iraqi": "IQ", "irish": "IE", "israeli": "IL", "italian": "IT",
    "jamaican": "JM", "japanese": "JP", "jordanian": "JO", "kenyan": "KE", "korean": "KR",
    "laotian": "LA", "lao": "LA", "lebanese": "LB", "malaysian": "MY", "mexican": "MX",
    "moroccan": "MA", "nepalese": "NP", "nepali": "NP", "nigerian": "NG", "norwegian": "NO",
    "pakistani": "PK", "palestinian": "PS", "peruvian": "PE", "polish": "PL", "portuguese": "PT",
    "puerto_rican": "PR", "romanian": "RO", "russian": "RU", "salvadoran": "SV", "scottish": "GB",
    "senegalese": "SN", "serbian": "RS", "singaporean": "SG", "slovak": "SK", "slovenian": "SI",
    "somali": "SO", "spanish": "ES", "sri_lankan": "LK", "sudanese": "SD", "swedish": "SE",
    "swiss": "CH", "syrian": "SY", "taiwanese": "TW", "thai": "TH", "tibetan": "CN",
    "tunisian": "TN", "turkish": "TR", "ukrainian": "UA", "uruguayan": "UY", "venezuelan": "VE",
    "vietnamese": "VN", "welsh": "GB", "yemeni": "YE",
}

CUISINE_REJECT_REGIONAL: frozenset[str] = frozenset({
    "african", "american_chinese", "arab", "asian", "balkan", "baltic", "caribbean", "central_american",
    "central_asian", "eastern_european", "european", "fusion", "international", "latin", "latin_american",
    "mediterranean", "middle_eastern", "nordic", "oriental", "regional", "scandinavian", "south_american",
    "southern", "southwestern", "tex-mex", "western",
})

CUISINE_REJECT_DISH: frozenset[str] = frozenset({
    "bagel", "bakery", "barbecue", "bbq", "beef_bowl", "breakfast", "brunch", "buffet", "burger",
    "cake", "chicken", "coffee_shop", "crepe", "curry", "deli", "dessert", "diner", "donut",
    "doughnut", "dumpling", "empanada", "fine_dining", "fish", "fish_and_chips", "friture",
    "frozen_yogurt", "gyro", "hot_dog", "ice_cream", "juice", "kebab", "noodle", "pancake",
    "pasta", "pastry", "pho", "pie", "pizza", "poke", "pretzel", "ramen", "rice", "salad",
    "sandwich", "sausage", "seafood", "shawarma", "smoothie", "soup", "steak_house", "sushi",
    "taco", "tapas", "tea", "teppanyaki", "vegan", "vegetarian", "waffle", "wings", "wrap",
})

# ── administrative ladders that are not simply "the next level that exists" ────
# Small and explicit, per specs/osm.md §6.3 step 5. A None entry means "this
# country has no such division"; a level absent from the map resolves to None too.
ADMIN_ORDINAL_OVERRIDES: dict[str, tuple[int | None, int | None, int | None, int | None]] = {
    "fr": (4, 6, 8, 9),      # région / département / commune (7 = arrondissement is skipped)
    "de": (4, 6, 8, 9),      # Land / Kreis / Gemeinde / Stadtbezirk (5 = Regierungsbezirk skipped)
    "gb": (4, 6, 8, 10),     # constituent country / county / district / civil parish
    "jp": (4, 7, 8, None),   # prefecture / municipality / ward
    "cn": (4, 6, 7, 8),      # province / prefecture-city / county / township
    "it": (4, 6, 8, 9),      # regione / provincia / comune / circoscrizione
}


# ═══════════════════════════════════════════════════════════════════════════════
# Overpass plumbing
# ═══════════════════════════════════════════════════════════════════════════════


def _ov_bbox(bbox: tuple[float, float, float, float]) -> str:
    """Overpass bbox literal — (S, W, N, E), fixed 6 dp so the cache key is stable."""
    s, w, n, e = bbox
    return f"{s:.6f},{w:.6f},{n:.6f},{e:.6f}"


def _ov_sub(selector: str, bbox: tuple[float, float, float, float]) -> str:
    """Substitute `{{bbox}}` in a selector."""
    return selector.replace("{{bbox}}", _ov_bbox(bbox))


def _ov_selector(category: GeoCategory) -> str:
    """The selector for a category, resolving the ones that live in a shared constant."""
    if category.key == "car_street":
        return CAR_STREET_SELECTOR
    return category.selector


def _geo_categories() -> dict[str, GeoCategory]:
    """`GEO_CATEGORIES` as a key → category map."""
    return {c.key: c for c in GEO_CATEGORIES}


def _ov_header() -> str:
    return f"[out:json][timeout:{OVERPASS_QL_TIMEOUT_S}];"


def _cache_key16(query: str) -> str:
    """The 16-hex handle the cache file is named after — printed in §Provenance."""
    return sha256_text(query)[:16]


def overpass_query(cache: Cache, query: str) -> dict[str, Any]:
    """Run one Overpass QL query (bbox already substituted) and return parsed JSON.

    The cache key is the fully substituted query text, so changing the border
    correctly invalidates. Endpoints are tried in `OVERPASS_ENDPOINTS` order with
    retries and a courtesy sleep. Raises on total failure — callers decide whether
    that degrades a section or aborts the run.
    """
    body = http_fetch(
        cache,
        kind="overpass",
        cache_key=query,
        ext="json",
        endpoints=OVERPASS_ENDPOINTS,
        method="POST",
        data=query,
        courtesy_sleep_s=OVERPASS_COURTESY_SLEEP_S,
    )

    def _reject(reason: str) -> None:
        # A poisoned cache entry would make every later run reproduce the failure,
        # so drop it before raising.
        try:
            cache.path_for("overpass", query, "json").unlink(missing_ok=True)
        except OSError:  # pragma: no cover — a read-only cache dir is not our problem
            pass
        raise RuntimeError(f"Overpass: {reason}")

    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except Exception as exc:  # noqa: BLE001 — an HTML error page is the usual cause
        _reject(f"non-JSON response ({exc.__class__.__name__})")
    if not isinstance(data, dict) or not isinstance(data.get("elements"), list):
        _reject("response carried no `elements` array")
    remark = str(data.get("remark", "")).strip()
    if remark and re.search(r"error|out of memory|timed out", remark, re.I):
        _reject(f"server remark: {remark}")
    if remark:
        log.warning("overpass remark: %s", remark)
    return data


def _split_statements(data: dict[str, Any], expected: int, what: str) -> list[list[dict[str, Any]]]:
    """Split an `out …; out count;`-per-statement response into per-statement blocks.

    Overpass returns every statement's elements concatenated in statement order with
    nothing between them, so the trailing `out count;` of each statement is used as
    an explicit terminator *and* as a checksum: the block length must equal the
    count. Without this, a partially failed query silently shifts every category's
    features onto the wrong category.
    """
    blocks: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for element in data.get("elements", []):
        if element.get("type") == "count":
            total = int(element.get("tags", {}).get("total", len(current)))
            if total != len(current):
                raise RuntimeError(
                    f"Overpass {what}: statement {len(blocks)} returned {len(current)} "
                    f"elements but counted {total}"
                )
            blocks.append(current)
            current = []
        else:
            current.append(element)
    if current:
        raise RuntimeError(f"Overpass {what}: {len(current)} trailing elements with no count marker")
    if len(blocks) != expected:
        raise RuntimeError(f"Overpass {what}: expected {expected} statements, got {len(blocks)}")
    return blocks


def overpass_counts(cache: Cache, bbox: tuple[float, float, float, float],
                    selectors: Sequence[tuple[str, str]]) -> dict[str, int]:
    """Map-level audit in ONE request, using `out count`.

    `selectors` is `(key, selector)` pairs; each becomes a statement followed by
    `out count;`. Responses come back as `type:"count"` elements **in statement
    order**, so assert `len(counts) == len(selectors)` before zipping — a partially
    failed query silently returns fewer, and mis-zipping would attribute one
    category's count to another. 28 categories cost one request and ~4 kB.
    """
    query = _counts_query(bbox, selectors)
    data = overpass_query(cache, query)
    counts = [e for e in data.get("elements", []) if e.get("type") == "count"]
    if len(counts) != len(selectors):
        raise RuntimeError(
            f"Overpass count audit: asked {len(selectors)} statements, got {len(counts)} counts"
        )
    return {key: int(c.get("tags", {}).get("total", 0)) for (key, _), c in zip(selectors, counts)}


def _counts_query(bbox: tuple[float, float, float, float],
                  selectors: Sequence[tuple[str, str]]) -> str:
    """The exact QL text `overpass_counts` sends — also the cache key."""
    return _ov_header() + "".join(f"({_ov_sub(sel, bbox)});out count;" for _, sel in selectors)


# ═══════════════════════════════════════════════════════════════════════════════
# Element → Poi: rings, representative points, dedup
# ═══════════════════════════════════════════════════════════════════════════════


def _way_line(element: dict[str, Any]) -> list[tuple[float, float]]:
    """A way's `out geom` geometry as (lat, lon), dropping any hole Overpass left."""
    return [(p["lat"], p["lon"]) for p in (element.get("geometry") or []) if p and "lat" in p]


def _stitch_rings(lines: Sequence[Sequence[tuple[float, float]]]) -> list[tuple[tuple[float, float], ...]]:
    """Stitch member ways into closed rings by matching endpoints.

    Multipolygon members arrive unordered and in arbitrary direction; shared nodes
    carry byte-identical coordinates, so exact tuple equality is the correct join.
    Open leftovers are discarded (a broken relation is not a polygon). Member order
    is the response order, which is stable for a fixed OSM snapshot.
    """
    pool = [list(line) for line in lines if len(line) >= 2]
    rings: list[tuple[tuple[float, float], ...]] = []
    while pool:
        current = pool.pop(0)
        progress = True
        while current[0] != current[-1] and progress:
            progress = False
            for i, other in enumerate(pool):
                if other[0] == current[-1]:
                    current.extend(other[1:])
                elif other[-1] == current[-1]:
                    current.extend(list(reversed(other))[1:])
                elif other[-1] == current[0]:
                    current[:0] = other[:-1]
                elif other[0] == current[0]:
                    current[:0] = list(reversed(other))[:-1]
                else:
                    continue
                pool.pop(i)
                progress = True
                break
        if current[0] == current[-1] and len(current) >= 4:
            rings.append(tuple(current[:-1]))
    return rings


def _element_rings(element: dict[str, Any]) -> tuple[list[tuple[tuple[float, float], ...]],
                                                     list[tuple[tuple[float, float], ...]]]:
    """(outer rings, inner rings) in (lat, lon). Empty when the element is not an area."""
    kind = element.get("type")
    if kind == "way":
        line = _way_line(element)
        if len(line) >= 4 and line[0] == line[-1]:
            return [tuple(line[:-1])], []
        return [], []
    if kind == "relation":
        outer: list[list[tuple[float, float]]] = []
        inner: list[list[tuple[float, float]]] = []
        for member in element.get("members") or []:
            if member.get("type") != "way" or not member.get("geometry"):
                continue
            line = [(p["lat"], p["lon"]) for p in member["geometry"] if p and "lat" in p]
            if len(line) < 2:
                continue
            (inner if member.get("role") == "inner" else outer).append(line)
        return _stitch_rings(outer), _stitch_rings(inner)
    return [], []


def _planar(ring: Sequence[tuple[float, float]], proj: Projection) -> list[tuple[float, float]]:
    return [proj.xy(lat, lon) for lat, lon in ring]


def _all_points(element: dict[str, Any]) -> list[tuple[float, float]]:
    """Every coordinate an element carries, for the last-resort centroid."""
    pts = _way_line(element)
    for member in element.get("members") or []:
        if member.get("geometry"):
            pts.extend((p["lat"], p["lon"]) for p in member["geometry"] if p and "lat" in p)
        elif "lat" in member:
            pts.append((member["lat"], member["lon"]))
    return pts


def _representative_latlon(element: dict[str, Any], proj: Projection,
                           outers: Sequence[Sequence[tuple[float, float]]],
                           inners: Sequence[Sequence[tuple[float, float]]]) -> tuple[float, float] | None:
    """The rulebook's "map icon" for one element — specs/osm.md §3.2.

    Node → itself. Closed way / multipolygon → area-weighted shoelace centroid with
    an interior fallback when it lands outside the shape. Open way → length-weighted
    midpoint. Never `out center`, which is the bbox centre and diverges by a measured
    p90 of 88 m on real park polygons.
    """
    if element.get("type") == "node" and "lat" in element:
        return (float(element["lat"]), float(element["lon"]))

    if outers:
        planar_outers = [_planar(r, proj) for r in outers]
        planar_inners = [_planar(r, proj) for r in inners]
        acc_x = acc_y = acc_a = 0.0
        for ring in planar_outers:
            area = polygon_area(ring)
            cx, cy = ring_centroid(ring)
            acc_x += area * cx
            acc_y += area * cy
            acc_a += area
        for ring in planar_inners:
            area = polygon_area(ring)
            cx, cy = ring_centroid(ring)
            acc_x -= area * cx
            acc_y -= area * cy
            acc_a -= area
        biggest = max(planar_outers, key=polygon_area)
        if acc_a > 1e-9:
            point = (acc_x / acc_a, acc_y / acc_a)
            if not point_in_ring(point, biggest):
                point = representative_point(biggest)
        else:
            point = representative_point(biggest)
        lon, lat = proj.lonlat(point[0], point[1])
        return (lat, lon)

    line = _way_line(element)
    if len(line) >= 2:
        x, y = polyline_midpoint(_planar(line, proj))
        lon, lat = proj.lonlat(x, y)
        return (lat, lon)
    if len(line) == 1:
        return line[0]

    if "center" in element:  # `out center` output — density tallies only
        return (float(element["center"]["lat"]), float(element["center"]["lon"]))

    pts = _all_points(element)
    if pts:
        planar = [proj.xy(lat, lon) for lat, lon in pts]
        x = sum(p[0] for p in planar) / len(planar)
        y = sum(p[1] for p in planar) / len(planar)
        lon, lat = proj.lonlat(x, y)
        return (lat, lon)
    bounds = element.get("bounds")
    if bounds:
        return ((bounds["minlat"] + bounds["maxlat"]) / 2.0,
                (bounds["minlon"] + bounds["maxlon"]) / 2.0)
    return None


def _parse_elements(elements: Sequence[dict[str, Any]], category: str, proj: Projection, *,
                    keep_rings: bool, keep_tags: bool = True) -> list[Poi]:
    """Reduce one statement's elements to sorted, deduplicated `Poi` records.

    Deduplication implements specs/osm.md §3.2 step 6, and only that: a **node**
    inside an area feature of the same category is the same real-world thing mapped
    twice (a museum node inside the museum building) and the area wins. It is
    deliberately not extended to area-inside-area — measured on the reference bbox
    that would delete 25 pitches that sit inside recreation grounds, which are
    genuinely separate features a player can stand on.
    """
    records: list[tuple[Poi, list[list[tuple[float, float]]], float]] = []
    for element in elements:
        if element.get("type") not in ("node", "way", "relation"):
            continue
        outers, inners = _element_rings(element)
        point = _representative_latlon(element, proj, outers, inners)
        if point is None:
            continue
        tags_raw = element.get("tags") or {}
        tags = {str(k): str(v) for k, v in sorted(tags_raw.items())} if keep_tags else {}
        planar_outers = [_planar(r, proj) for r in outers]
        area = sum(polygon_area(r) for r in planar_outers) - sum(
            polygon_area(_planar(r, proj)) for r in inners)
        poi = Poi(
            category=category,
            osm_type=element["type"],
            osm_id=int(element["id"]),
            name=str(tags_raw.get("name", "")),
            lat=point[0],
            lon=point[1],
            tags=tags,
            rings=tuple(outers) if keep_rings else (),
        )
        records.append((poi, planar_outers, max(0.0, area)))

    records.sort(key=lambda r: (r[0].osm_type, r[0].osm_id))
    areas = []
    for poi, rings, area in records:
        if not rings:
            continue
        xs = [p[0] for ring in rings for p in ring]
        ys = [p[1] for ring in rings for p in ring]
        areas.append((poi, rings, area, (min(xs), min(ys), max(xs), max(ys))))
    keep: list[Poi] = []
    for poi, _rings, area in records:
        if poi.osm_type != "node":
            keep.append(poi)
            continue
        point = proj.xy(poi.lat, poi.lon)
        swallowed = False
        for other, other_rings, other_area, (x0, y0, x1, y1) in areas:
            if other.osm_id == poi.osm_id and other.osm_type == poi.osm_type:
                continue
            if other_area <= area:
                continue
            if not (x0 <= point[0] <= x1 and y0 <= point[1] <= y1):
                continue
            if any(point_in_ring(point, ring) for ring in other_rings):
                swallowed = True
                break
        if not swallowed:
            keep.append(poi)
    return keep


# ═══════════════════════════════════════════════════════════════════════════════
# Category fetching
# ═══════════════════════════════════════════════════════════════════════════════


def _out_directive(category: GeoCategory) -> str:
    """`out geom` everywhere a distance or a ring is compared; `out center qt` only
    for the pure density tally (buildings), per specs/osm.md §1.4 and §3.1."""
    return "out center qt;" if category.key in GEO_DENSITY_ONLY else "out geom;"


def _tiles(bbox: tuple[float, float, float, float]) -> list[tuple[float, float, float, float]]:
    """Split a bbox into ≤ `OVERPASS_TILE_DEG` squares, south-west first."""
    s, w, n, e = bbox
    rows = max(1, int(math.ceil((n - s) / OVERPASS_TILE_DEG)))
    cols = max(1, int(math.ceil((e - w) / OVERPASS_TILE_DEG)))
    dlat = (n - s) / rows
    dlon = (e - w) / cols
    out: list[tuple[float, float, float, float]] = []
    for r in range(rows):
        for c in range(cols):
            out.append((s + r * dlat, w + c * dlon, s + (r + 1) * dlat, w + (c + 1) * dlon))
    return out


def fetch_category(cache: Cache, category: GeoCategory,
                   bbox: tuple[float, float, float, float], proj: Projection) -> list[Poi]:
    """Fetch one category bbox-wide and reduce it to `Poi` records.

    Uses `out geom` when `category.needs_geometry` (a real centroid or a ring is
    required) and `out center tags` otherwise. Applies the representative-point rule,
    deduplicates a node inside a same-category polygon in favour of the polygon, and
    returns sorted by `(osm_type, osm_id)`.

    When the size guard trips (`OVERPASS_WAY_BUDGET`), tiles the bbox into ≤0.1°
    squares, caches per tile, and marks the result `partial` — a size failure must
    never become a `0` that reads as "this category does not exist here".
    """
    selector = _ov_selector(category)
    if not selector:
        return []
    keep_rings = category.key in RING_CATEGORIES
    keep_tags = category.key not in GEO_DENSITY_ONLY
    query = _ov_header() + f"({_ov_sub(selector, bbox)});{_out_directive(category)}"
    try:
        data = overpass_query(cache, query)
        return _parse_elements(data.get("elements", []), category.key, proj,
                               keep_rings=keep_rings, keep_tags=keep_tags)
    except CacheMiss:
        raise
    except Exception as exc:  # noqa: BLE001 — a too-big or timed-out fetch degrades to tiles
        log.warning("category %s failed whole-bbox (%s); tiling", category.key, exc)

    merged: dict[tuple[str, int], Poi] = {}
    failures = 0
    for tile in _tiles(bbox):
        tile_query = _ov_header() + f"({_ov_sub(selector, tile)});{_out_directive(category)}"
        try:
            data = overpass_query(cache, tile_query)
        except CacheMiss:
            raise
        except Exception as exc:  # noqa: BLE001 — one dead tile is a floor, not a zero
            failures += 1
            log.warning("category %s tile %s failed: %s", category.key, _ov_bbox(tile), exc)
            continue
        for poi in _parse_elements(data.get("elements", []), category.key, proj,
                                   keep_rings=keep_rings, keep_tags=keep_tags):
            merged[(poi.osm_type, poi.osm_id)] = poi
    if failures:
        log.warning("category %s: %d tiles failed; count is a floor", category.key, failures)
    return [merged[k] for k in sorted(merged, key=lambda k: (k[0], k[1]))]


def _fetch_group(cache: Cache, categories: Sequence[GeoCategory],
                 bbox: tuple[float, float, float, float], proj: Projection,
                 label: str) -> tuple[dict[str, list[Poi]], str]:
    """Fetch several categories in ONE request, attributing results by count marker.

    Returns `(category key → pois, cache_key)`. On any failure the caller falls back
    to per-category fetches, which cost more requests but survive one bad selector.
    """
    parts = []
    for category in categories:
        selector = _ov_selector(category)
        parts.append(f"({_ov_sub(selector, bbox)});{_out_directive(category)}out count;")
    query = _ov_header() + "".join(parts)
    data = overpass_query(cache, query)
    blocks = _split_statements(data, len(categories), f"group {label}")
    out: dict[str, list[Poi]] = {}
    for category, block in zip(categories, blocks):
        out[category.key] = _parse_elements(
            block, category.key, proj,
            keep_rings=category.key in RING_CATEGORIES,
            keep_tags=category.key not in GEO_DENSITY_ONLY,
        )
    return out, _cache_key16(query)


# ═══════════════════════════════════════════════════════════════════════════════
# Spatial index and the two zone predicates
# ═══════════════════════════════════════════════════════════════════════════════


def build_poi_index(pois: Sequence[Poi], proj: Projection, radius_m: float) -> GridIndex:
    """Index a POI set for radius queries at the zone radius. See `GridIndex`."""
    index = GridIndex(max(1.0, radius_m))
    for poi in sorted(pois, key=lambda p: (p.category, p.osm_type, p.osm_id)):
        x, y = proj.xy(poi.lat, poi.lon)
        index.add((poi.category, poi.osm_type, poi.osm_id), x, y)
    return index


def _area_index(pois: Sequence[Poi], proj: Projection,
                radius_m: float) -> tuple[GridIndex, list[Poi], dict[tuple[str, str, int], Poi]]:
    """Grid of *area* features by bounding box, plus the linear-scan overflow list.

    A feature is inserted into every cell its bbox touches, so a query only has to
    read the 3×3 neighbourhood; anything spanning more than `GridIndex.add_bbox`'s
    cap (one statewide multipolygon) goes into the overflow list instead of blowing
    up the index.
    """
    index = GridIndex(max(1.0, radius_m))
    overflow: list[Poi] = []
    lookup: dict[tuple[str, str, int], Poi] = {}
    for poi in sorted(pois, key=lambda p: (p.category, p.osm_type, p.osm_id)):
        if not poi.rings:
            continue
        key = (poi.category, poi.osm_type, poi.osm_id)
        lookup[key] = poi
        xs: list[float] = []
        ys: list[float] = []
        for ring in poi.rings:
            for lat, lon in ring:
                x, y = proj.xy(lat, lon)
                xs.append(x)
                ys.append(y)
        if not xs:
            continue
        if not index.add_bbox(key, min(xs), min(ys), max(xs), max(ys)):
            overflow.append(poi)
    return index, overflow, lookup


def _rings_planar(poi: Poi, proj: Projection) -> list[list[tuple[float, float]]]:
    return [_planar(ring, proj) for ring in poi.rings]


def zone_inventory(zones: Sequence[Zone], pois: dict[str, list[Poi]], proj: Projection,
                   radius_m: float) -> tuple[dict[str, dict[str, int]], dict[str, dict[str, bool]]]:
    """Count, per zone, how many features of each category fall inside the circle.

    Returns `(icon_counts, polygon_hits)`. **Two different predicates**: icon counts
    ask whether the representative point is inside the disc (what matching and
    measuring questions measure to); polygon hits ask whether the feature's ring
    intersects the disc (what the photo questions mean by "stand in a park"). On the
    reference feed parks are 28.5% by icon and 45.5% by polygon. Never substitute one
    for the other.
    """
    categories = sorted(pois)
    flat: list[Poi] = []
    for key in categories:
        flat.extend(pois[key])
    index = build_poi_index(flat, proj, radius_m)

    ring_pois = [p for p in flat if p.rings]
    area_grid, area_overflow, area_lookup = _area_index(ring_pois, proj, radius_m)
    ring_categories = sorted({p.category for p in ring_pois})
    planar_cache: dict[tuple[str, str, int], list[list[tuple[float, float]]]] = {}

    wide_categories = ("toilets",)
    wide_index = build_poi_index(
        [p for p in flat if p.category in wide_categories], proj, radius_m * TOILET_WIDE_FACTOR)

    icon_counts: dict[str, dict[str, int]] = {}
    polygon_hits: dict[str, dict[str, bool]] = {}
    for zone in sorted(zones, key=lambda z: z.zone_id):
        counts = {key: 0 for key in categories}
        for key in index.near_keys(zone.x, zone.y, radius_m):
            counts[key[0]] += 1
        if "toilets" in counts:
            counts["toilets_wide"] = len(
                wide_index.near_keys(zone.x, zone.y, radius_m * TOILET_WIDE_FACTOR))
        icon_counts[zone.zone_id] = counts

        hits = {key: False for key in ring_categories}
        candidates = [area_lookup[k] for k in area_grid.near_keys(zone.x, zone.y, float("inf"))]
        for poi in candidates + area_overflow:
            if hits.get(poi.category):
                continue
            key = (poi.category, poi.osm_type, poi.osm_id)
            rings = planar_cache.get(key)
            if rings is None:
                rings = _rings_planar(poi, proj)
                planar_cache[key] = rings
            if any(ring_within((zone.x, zone.y), ring, radius_m) for ring in rings):
                hits[poi.category] = True
        polygon_hits[zone.zone_id] = hits
    return icon_counts, polygon_hits


# ═══════════════════════════════════════════════════════════════════════════════
# Nominatim and administrative divisions
# ═══════════════════════════════════════════════════════════════════════════════


def _nominatim_params(lat: float, lon: float) -> dict[str, str]:
    return {
        "addressdetails": "1",
        "extratags": "1",
        "format": "jsonv2",
        "lat": f"{lat:.6f}",
        "lon": f"{lon:.6f}",
        "zoom": "10",
    }


def _nominatim_url(lat: float, lon: float) -> str:
    """The fully-substituted request URL — the cache key and the provenance line."""
    params = _nominatim_params(lat, lon)
    return NOMINATIM_ENDPOINT + "?" + "&".join(f"{k}={params[k]}" for k in sorted(params))


def nominatim_reverse(cache: Cache, lat: float, lon: float) -> dict[str, Any]:
    """One reverse geocode of the map centroid — the only Nominatim call per run.

    Supplies the place name (the pages' `{place}`), the country code (which drives
    the Street View table and the scale-bar unit) and, crucially, the
    `ISO3166-2-lvl<N>` key whose N *is* the country's first administrative division's
    OSM `admin_level`. Rate limit is 1 req/s and the User-Agent is mandatory. If it
    is unreachable, fall back to the `ISO3166-1` tag on the `admin_level=2` area
    returned by `is_in`, which costs no extra request.
    """
    params = _nominatim_params(lat, lon)
    key = _nominatim_url(lat, lon)
    body = http_fetch(
        cache,
        kind="nominatim",
        cache_key=key,
        ext="json",
        endpoints=[NOMINATIM_ENDPOINT],
        method="GET",
        params=params,
        courtesy_sleep_s=NOMINATIM_COURTESY_SLEEP_S,
    )
    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except Exception as exc:  # noqa: BLE001
        try:
            cache.path_for("nominatim", key, "json").unlink(missing_ok=True)
        except OSError:  # pragma: no cover
            pass
        raise RuntimeError(f"Nominatim: non-JSON response ({exc.__class__.__name__})") from exc
    return data if isinstance(data, dict) else {}


def _is_in_query(batch: Sequence[tuple[float, float]]) -> str:
    """The exact QL one batched containment request sends — also its cache key."""
    return _ov_header() + "".join(
        f"is_in({lat:.6f},{lon:.6f});out tags;out count;" for lat, lon in batch)


def _is_in_areas(cache: Cache, points: Sequence[tuple[float, float]],
                 ) -> tuple[list[list[dict[str, str]]], list[str]]:
    """Batched `is_in` containment lookup. Returns per-point tag dicts and cache keys.

    `is_in` yields **area** objects, so a `relation.a[...]` filter silently returns
    nothing; the result is filtered on the returned elements' own tags instead. The
    `out count;` after each `out tags;` is what makes a batched response separable —
    without it every point's hierarchy is one undifferentiated list.
    """
    per_point: list[list[dict[str, str]]] = []
    keys: list[str] = []
    for start in range(0, len(points), IS_IN_BATCH):
        batch = points[start:start + IS_IN_BATCH]
        query = _is_in_query(batch)
        data = overpass_query(cache, query)
        keys.append(_cache_key16(query))
        for block in _split_statements(data, len(batch), "is_in"):
            per_point.append([
                {str(k): str(v) for k, v in sorted((e.get("tags") or {}).items())}
                for e in block
            ])
    return per_point, keys


def _admin_level(tags: dict[str, str]) -> int | None:
    value = tags.get("admin_level", "")
    if value.isdigit():
        return int(value)
    return None


def _iso_lvl_from_nominatim(nominatim: dict[str, Any] | None) -> int | None:
    """`ISO3166-2-lvl<N>` ⇒ N is the country's first-division `admin_level`."""
    if not nominatim:
        return None
    address = nominatim.get("address") or {}
    levels = []
    for key in sorted(address):
        m = re.fullmatch(r"ISO3166-2-lvl(\d+)", key)
        if m:
            levels.append(int(m.group(1)))
    return min(levels) if levels else None


def resolve_admin(cache: Cache, zones: Sequence[Zone], bbox: tuple[float, float, float, float],
                  nominatim: dict[str, Any] | None) -> AdminInfo:
    """Resolve the 1st–4th administrative divisions for this map.

    Two Overpass forms are needed because they answer two different rulebook
    questions and they disagree: containment (`is_in`, batched) answers the
    *matching* questions, boundary crossing (`relation[boundary=administrative]`
    inside the bbox) answers the *border measuring* questions. A bbox query returns
    only divisions whose boundary crosses the box, so the containing state and
    country are simply absent from it — correct for "does a border cross the map",
    catastrophically wrong for "which state am I in".

    Ordinals 2–4 come from the distinct levels present across *all* zone centres, not
    one probe point. Never guess an `admin_level`.
    """
    ordered = sorted(zones, key=lambda z: z.zone_id)
    points = [(z.lat, z.lon) for z in ordered]
    per_point: list[list[dict[str, str]]] = []
    if points:
        try:
            per_point, _keys = _is_in_areas(cache, points)
        except CacheMiss:
            raise
        except Exception as exc:  # noqa: BLE001 — admin questions degrade to `unknown`
            log.warning("is_in containment lookup failed: %s", exc)
            per_point = []

    # Per-zone {admin_level: name}, plus the map-wide level census.
    per_zone_levels: dict[str, dict[int, str]] = {}
    levels_present: set[int] = set()
    iso1_country: str | None = None
    iso2_level: int | None = None
    country_name: str | None = None
    for zone, areas in zip(ordered, per_point):
        ladder: dict[int, str] = {}
        for tags in areas:
            if tags.get("boundary") != "administrative":
                continue
            level = _admin_level(tags)
            name = tags.get("name:en") or tags.get("name") or ""
            if level is None or not name:
                continue
            ladder[level] = name
            levels_present.add(level)
            if tags.get("ISO3166-1"):
                iso1_country = iso1_country or tags["ISO3166-1"].lower()
                country_name = country_name or name
            if tags.get("ISO3166-2") and iso2_level is None:
                iso2_level = level
        per_zone_levels[zone.zone_id] = ladder

    # Country identity: Nominatim first, `is_in`'s ISO3166-1 tag as the free fallback.
    country_code: str | None = None
    place_name: str | None = None
    source = "unknown"
    if nominatim:
        address = nominatim.get("address") or {}
        cc = str(address.get("country_code", "")).lower()
        country_code = cc or None
        country_name = str(address.get("country", "")) or country_name
        for field_name in ("city", "town", "village", "municipality", "borough", "suburb",
                           "county", "state", "region"):
            if address.get(field_name):
                place_name = str(address[field_name])
                break
        if not place_name and nominatim.get("name"):
            place_name = str(nominatim["name"])
        source = "nominatim"
    if country_code is None and iso1_country:
        country_code = iso1_country
        source = "is_in"
    elif source == "unknown" and per_zone_levels:
        source = "is_in"

    # Ordinal ladder. Derived, never guessed.
    first = _iso_lvl_from_nominatim(nominatim) or iso2_level
    ordinals: dict[int, int | None] = {1: None, 2: None, 3: None, 4: None}
    override = ADMIN_ORDINAL_OVERRIDES.get(country_code or "")
    if override:
        for ordinal, level in enumerate(override, start=1):
            ordinals[ordinal] = level if (level is not None and level in levels_present) else None
        if ordinals[1] is None and first is not None and first in levels_present:
            ordinals[1] = first
    elif first is not None:
        ordinals[1] = first
        rest = [lv for lv in sorted(levels_present) if lv > first]
        for ordinal, level in zip((2, 3, 4), rest):
            ordinals[ordinal] = level

    # Zone → ordinal → division name.
    per_zone: dict[str, dict[int, str]] = {}
    for zone_id in sorted(per_zone_levels):
        ladder = per_zone_levels[zone_id]
        entry: dict[int, str] = {}
        for ordinal in (1, 2, 3, 4):
            level = ordinals.get(ordinal)
            if level is not None and level in ladder:
                entry[ordinal] = ladder[level]
        per_zone[zone_id] = entry

    # The place name is the municipality that contains the most zone centres, not the
    # one under the bbox centre: the centre of a bounding box is a geometric artefact
    # and on the reference feed it lands in a suburb (Wyoming, MI) while 171 of 393
    # zones sit in Grand Rapids. Nominatim's answer is the fallback, not the source.
    #
    # Which ordinal holds "the municipality" is not fixed across countries, or even
    # across US states. Michigan puts cities at ordinal 3. Illinois puts historic
    # civil townships there and the city one level down, so reading ordinal 3 named
    # the CTA map "Lake Township" (265 of 1,204 zones) when ordinal 4 had "Chicago"
    # covering 1,070. So tally every candidate ordinal and let zone coverage decide;
    # ties break toward the more specific division, then the name, for determinism.
    if per_zone:
        # Go as specific as the data allows, then take the division containing the
        # most zone centres *within that ordinal*. Ranking candidates by raw zone
        # count across ordinals does not work: a broader division always wins on
        # count, which named the Grand Rapids map "Kent County" (317 of 319).
        #
        # Which ordinal holds "the municipality" is not fixed, even across US states.
        # Michigan puts cities at ordinal 3 and has no ordinal 4. Illinois puts
        # historic civil townships at 3 and the city at 4, so reading ordinal 3 named
        # the CTA map "Lake Township" (265 of 1,204) when ordinal 4 held "Chicago"
        # (1,070). Taking the deepest populated ordinal gets both right.
        for ordinal in (4, 3, 2):
            tally: dict[str, int] = {}
            for zone_id in sorted(per_zone):
                name = per_zone[zone_id].get(ordinal)
                if name:
                    tally[name] = tally.get(name, 0) + 1
            if not tally:
                continue
            name, count = sorted(tally.items(), key=lambda kv: (-kv[1], kv[0]))[0]
            place_name = name
            log.info("place name %r from ordinal %d (%d of %d zones, %d divisions there)",
                     place_name, ordinal, count, len(per_zone), len(tally))
            break

    # Does a boundary LINE cross the map? Ordinal 0 is the international border.
    wanted: list[tuple[int, int]] = [(0, 2)]
    for ordinal in (1, 2, 3, 4):
        level = ordinals.get(ordinal)
        if level is not None:
            wanted.append((ordinal, level))
    border_levels: dict[int, bool] = {}
    if wanted:
        parts = "".join(
            f'relation["boundary"="administrative"]["admin_level"="{level}"]'
            f"({_ov_bbox(bbox)})->.a{ordinal};way(r.a{ordinal})({_ov_bbox(bbox)});out count;"
            for ordinal, level in wanted
        )
        try:
            data = overpass_query(cache, _ov_header() + parts)
            counts = [e for e in data.get("elements", []) if e.get("type") == "count"]
            if len(counts) == len(wanted):
                for (ordinal, _level), c in zip(wanted, counts):
                    border_levels[ordinal] = int(c.get("tags", {}).get("total", 0)) > 0
            else:
                log.warning("admin border audit returned %d of %d counts", len(counts), len(wanted))
        except CacheMiss:
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("admin border audit failed: %s", exc)

    return AdminInfo(
        country_code=country_code,
        country_name=country_name,
        place_name=place_name,
        ordinals=ordinals,
        per_zone=per_zone,
        border_levels=border_levels,
        source=source,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Curse predicates and cuisines
# ═══════════════════════════════════════════════════════════════════════════════


def curse_predicates(cache: Cache, bbox: tuple[float, float, float, float],
                     geo: GeoData) -> dict[str, int]:
    """Evaluate every OSM-decided curse predicate in one `out count` request.

    Returns `curse_id → count`. Removal is `count == 0` for the hard tier; the warn
    tier is reported with its count and never auto-removed. Two predicates are *not*
    OSM: Unguided Tourist (the static Street View country table) and U-Turn (GTFS
    route overlap and wait times) — those are decided elsewhere and must not be
    invented here.
    """
    counts: dict[str, int] = {}
    try:
        raw = overpass_counts(cache, bbox, CURSE_PREDICATE_SELECTORS)
    except CacheMiss:
        raise
    except Exception as exc:  # noqa: BLE001 — the curse audit degrades, it never aborts
        log.warning("curse predicate audit failed: %s", exc)
        raw = {}
    for curse_id, predicate in sorted(CURSE_PREDICATE_MAP):
        if predicate in raw:
            counts[curse_id] = raw[predicate]
    # Distant Cuisine is decided by tag *content*, not by a count: it is the number
    # of restaurants serving a single identifiable foreign country's cuisine.
    if "restaurant" in geo.pois:
        restaurants = geo.pois["restaurant"]
        host = (geo.admin.country_code or "").upper() or None
        counts["distant_cuisine"] = _cuisine_detail(restaurants, host)[1]
    return counts


def _cuisine_tokens(poi: Poi) -> list[str]:
    raw = poi.tags.get("cuisine", "")
    return [t.strip().lower().replace(" ", "_") for t in raw.split(";") if t.strip()]


def _cuisine_detail(restaurants: Sequence[Poi], host_country: str | None,
                    ) -> tuple[dict[str, int], int, int, int, list[str]]:
    """(per-country counts, qualifying restaurants, tagged, total, rejected tokens)."""
    per_country: dict[str, int] = {}
    qualifying = 0
    tagged = 0
    rejected: set[str] = set()
    host = (host_country or "").upper()
    for poi in sorted(restaurants, key=lambda p: (p.osm_type, p.osm_id)):
        tokens = _cuisine_tokens(poi)
        if not tokens:
            continue
        tagged += 1
        hits: set[str] = set()
        for token in tokens:
            code = CUISINE_COUNTRY.get(token)
            if code is None:
                rejected.add(token)
                continue
            if code == host:
                continue
            hits.add(code)
        if hits:
            qualifying += 1
            for code in sorted(hits):
                per_country[code] = per_country.get(code, 0) + 1
    return (per_country, qualifying, tagged, len(restaurants), sorted(rejected))


def classify_cuisines(restaurants: Sequence[Poi], host_country: str | None) -> dict[str, int]:
    """Bucket `cuisine` tags into single-foreign-country cuisines for Distant Cuisine.

    Only **adjective tokens** map to a country (`mexican`→MX, `thai`→TH, …).
    Super-national tokens (`asian`, `mediterranean`, `latin_american`, `fusion`) and
    dish tokens (`pizza`, `sushi`, `ramen`, `pho`, `kebab`) are rejected — promoting
    dishes to countries is a judgement call that changes the count, so the rule is
    strict and the rejected-token list is printed so a player can override.

    Returns `ISO-3166-1 alpha-2 → count`, excluding the host country.
    """
    return _cuisine_detail(restaurants, host_country)[0]


# ═══════════════════════════════════════════════════════════════════════════════
# Candidate legal endgame spots
# ═══════════════════════════════════════════════════════════════════════════════


def _spot_open_all_hours(tags: dict[str, str]) -> bool:
    hours = tags.get("opening_hours", "").strip()
    return hours == "" or hours in ("24/7", "Mo-Su 00:00-24:00")


def _spot_public(tags: dict[str, str]) -> bool:
    for key in ("access", "foot", "entry"):
        if tags.get(key, "").strip().lower() in PRIVATE_ACCESS:
            return False
    return True


def legal_endgame_spots(zones: Sequence[Zone], geo: GeoData, proj: Projection,
                        radius_m: float) -> dict[str, list[dict[str, Any]]]:
    """Shortlist candidate legal hiding spots inside each zone circle.

    The rulebook's two hard tests are (a) publicly accessible during all game hours
    and (b) within 10 ft of a path the map app would route you along. (b) has an OSM
    analogue: within 5 m of a foot-accessible `highway` way. **(a) does not.** OSM
    does not know whether a plaza is locked at night, so this returns a shortlist for
    a human and the page must say so — it is never a verdict.

    Features carrying a restrictive `opening_hours` (anything but `24/7`) are demoted
    to "verify on the ground" at half weight rather than dropped.
    """
    path_ok: frozenset[tuple[str, int]] | None = getattr(geo, "path_ok_ids", None)
    labels = {c.key: c.label for c in GEO_CATEGORIES}

    candidates: list[tuple[Poi, float, bool]] = []
    for category, weight, enclosing in LEGAL_SPOT_CATEGORIES:
        for poi in geo.pois.get(category, ()):
            if not _spot_public(poi.tags):
                continue
            if path_ok is not None and (poi.osm_type, poi.osm_id) not in path_ok:
                continue
            candidates.append((poi, weight, enclosing))
    if not candidates:
        return {zone.zone_id: [] for zone in zones}

    index = build_poi_index([c[0] for c in candidates], proj, radius_m)
    meta = {(p.category, p.osm_type, p.osm_id): (p, w, e) for p, w, e in candidates}

    # Planar rings, projected exactly once each.
    planar: dict[tuple[str, str, int], list[list[tuple[float, float]]]] = {}
    for poi, _w, _e in candidates:
        if poi.rings:
            planar[(poi.category, poi.osm_type, poi.osm_id)] = _rings_planar(poi, proj)
    area_grid, area_overflow, _area_lookup = _area_index(
        [p for p, _w, _e in candidates if p.rings], proj, radius_m)

    park_grid, park_overflow, _park_lookup = _area_index(
        [p for p in geo.pois.get("park", ()) if p.rings], proj, radius_m)
    park_planar: dict[tuple[str, str, int], list[list[tuple[float, float]]]] = {
        (p.category, p.osm_type, p.osm_id): _rings_planar(p, proj)
        for p in geo.pois.get("park", ()) if p.rings
    }

    def _inside_a_park(x: float, y: float) -> bool:
        for key in park_grid.near_keys(x, y, float("inf")):
            if any(point_in_ring((x, y), ring) for ring in park_planar[key]):
                return True
        for poi in park_overflow:
            rings = park_planar[(poi.category, poi.osm_type, poi.osm_id)]
            if any(point_in_ring((x, y), ring) for ring in rings):
                return True
        return False

    # Per-feature facts: computed once per feature, never once per zone.
    fixed: dict[tuple[str, str, int], dict[str, Any]] = {}
    for poi, weight, enclosing in candidates:
        key = (poi.category, poi.osm_type, poi.osm_id)
        px, py = proj.xy(poi.lat, poi.lon)
        verify = (path_ok is None) or not _spot_open_all_hours(poi.tags)
        enclosed = bool(enclosing and poi.osm_type != "node") or _inside_a_park(px, py)
        fixed[key] = {
            "name": poi.name or labels.get(poi.category, poi.category),
            "type": poi.category,
            "lat": poi.lat,
            "lon": poi.lon,
            "weight": weight * (SPOT_VERIFY_WEIGHT if verify else 1.0),
            "enclosed": enclosed,
            "verify": verify,
            "osm": f"{poi.osm_type}/{poi.osm_id}",
            "_xy": (px, py),
        }

    out: dict[str, list[dict[str, Any]]] = {}
    for zone in sorted(zones, key=lambda z: z.zone_id):
        centre = (zone.x, zone.y)
        keys = list(index.near_keys(zone.x, zone.y, radius_m))
        # An area feature counts when its ring reaches the circle even if its icon
        # does not: a big park with a distant centroid is still a legal spot here.
        for key in list(area_grid.near_keys(zone.x, zone.y, float("inf"))) + [
                (p.category, p.osm_type, p.osm_id) for p in area_overflow]:
            if any(ring_within(centre, ring, radius_m) for ring in planar.get(key, ())):
                keys.append(key)
        found: dict[tuple[str, str, int], dict[str, Any]] = {}
        for key in keys:
            if key in found or key not in fixed:
                continue
            row = dict(fixed[key])
            px, py = row.pop("_xy")
            distance = math.dist(centre, (px, py))
            for ring in planar.get(key, ()):
                if point_in_ring(centre, ring):
                    distance = 0.0
                    break
                distance = min(distance, min(
                    seg_point_dist(centre, ring[i], ring[(i + 1) % len(ring)])
                    for i in range(len(ring))))
            row["distance_m"] = distance
            found[key] = row
        # Best first, then nearest: the cap must never let a cluster of unnamed grass
        # verges push the park, the bench and the shelter off a zone's shortlist.
        rows = sorted(found.items(),
                      key=lambda kv: (-kv[1]["weight"], kv[1]["distance_m"],
                                      kv[0][0], kv[0][1], kv[0][2]))
        out[zone.zone_id] = [row for _key, row in rows[:LEGAL_SPOTS_PER_ZONE]]
    return out


def _fetch_path_adjacent_ids(cache: Cache, bbox: tuple[float, float, float, float],
                             ) -> tuple[frozenset[tuple[str, int]] | None, str, int]:
    """Ids of candidate spot features within 5 m of a foot-routable way.

    The join runs **server-side** (`around.paths:5`) and returns `out ids` — a few kB
    instead of the ~40 MB the foot-way geometry would cost. Returns `None` when the
    query fails, which the caller reports as "the path test could not be applied"
    rather than silently dropping every spot.

    This is the one *optional* request in the pipeline, and the most expensive one for
    the server (a 5 m buffer around every walkable way in the map). It therefore runs
    on a deliberately small budget — one attempt per mirror, a short server-side
    timeout — so a busy Overpass costs the run a couple of minutes and a caveat rather
    than half an hour.
    """
    candidate = (
        'nwr["leisure"~"^(park|garden|playground|pitch|recreation_ground|common|nature_reserve)$"]({{bbox}});'
        'nwr["amenity"~"^(bench|shelter|library|place_of_worship|toilets|marketplace|townhall)$"]({{bbox}});'
        'nwr["landuse"~"^(forest|grass|meadow|village_green|recreation_ground)$"]({{bbox}});'
        'nwr["public_transport"="platform"]({{bbox}});nwr["railway"="platform"]({{bbox}});'
    )
    query = (
        f"[out:json][timeout:{LEGAL_PATH_QL_TIMEOUT_S}];"
        + f"({_ov_sub(FOOT_WAY_SELECTOR, bbox)})->.paths;"
        + f"({_ov_sub(candidate, bbox)})->.cand;"
        + f"(node.cand(around.paths:{LEGAL_PATH_RADIUS_M});"
        + f"way.cand(around.paths:{LEGAL_PATH_RADIUS_M});"
        + f"relation.cand(around.paths:{LEGAL_PATH_RADIUS_M}););out ids;"
    )
    try:
        body = http_fetch(
            cache, kind="overpass", cache_key=query, ext="json",
            endpoints=OVERPASS_ENDPOINTS, method="POST", data=query,
            courtesy_sleep_s=OVERPASS_COURTESY_SLEEP_S,
            attempts_per_endpoint=1,
            timeout_s=LEGAL_PATH_HTTP_TIMEOUT_S,
        )
        data = json.loads(body.decode("utf-8", "replace"))
        if not isinstance(data, dict) or not isinstance(data.get("elements"), list):
            raise RuntimeError("no elements array")
    except CacheMiss:
        raise
    except Exception as exc:  # noqa: BLE001
        try:
            cache.path_for("overpass", query, "json").unlink(missing_ok=True)
        except OSError:  # pragma: no cover
            pass
        log.warning("legal-spot path filter unavailable: %s", exc)
        return None, _cache_key16(query), 0
    ids = frozenset(
        (str(e["type"]), int(e["id"])) for e in data.get("elements", [])
        if e.get("type") in ("node", "way", "relation")
    )
    return ids, _cache_key16(query), len(ids)


# ═══════════════════════════════════════════════════════════════════════════════
# The pipeline
# ═══════════════════════════════════════════════════════════════════════════════


def _icon_offset_p90(pois: Sequence[Poi], proj: Projection) -> float | None:
    """p90 of |representative point − bbox centre| over ring-carrying features.

    This is the honesty number specs/osm.md §3.3 demands: how far our computed map
    icon can sit from where `out center` (and, by proxy, a map app's label) puts it.
    """
    offsets: list[float] = []
    for poi in sorted(pois, key=lambda p: (p.osm_type, p.osm_id)):
        if not poi.rings:
            continue
        xs: list[float] = []
        ys: list[float] = []
        for ring in poi.rings:
            for lat, lon in ring:
                x, y = proj.xy(lat, lon)
                xs.append(x)
                ys.append(y)
        if not xs:
            continue
        centre = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)
        offsets.append(math.dist(proj.xy(poi.lat, poi.lon), centre))
    if len(offsets) < 5:
        return None
    return quantile(sorted(offsets), 0.90)


def _redundant_pairs(pois: dict[str, list[Poi]], proj: Projection,
                     diagonal_m: float) -> list[tuple[str, str, float]]:
    """Single-instance categories whose icons are close enough to be one question.

    GR's zoo and aquarium are 81 m apart, so the two matching questions are the same
    bit for six cards (specs/osm.md §7.4).
    """
    singles = sorted(k for k, v in pois.items() if len(v) == 1 and k not in GEO_DENSITY_ONLY)
    out: list[tuple[str, str, float]] = []
    threshold = diagonal_m * REDUNDANT_PAIR_FRACTION
    for i, a in enumerate(singles):
        for b in singles[i + 1:]:
            pa, pb = pois[a][0], pois[b][0]
            d = haversine_m(pa.lat, pa.lon, pb.lat, pb.lon)
            if d <= threshold:
                out.append((a, b, d))
    return out


# A water body larger than the game map behaves exactly like a coast: its shore is
# the edge of the playable world. OSM reserves `natural=coastline` for ocean and sea,
# so a Great Lakes or inland-sea map would otherwise report "no coastline" — which is
# true of the tagging and false of the geography. House ruling: a great-lake shore is
# a coast.
#
# The shore is emitted as many short segments rather than one whole-lake feature,
# because that is how `natural=coastline` itself is modelled and everything
# downstream depends on it: the in-border filter and the measuring questions both
# work off a feature's representative point, and Lake Michigan's centroid is ~100 km
# offshore and outside the map entirely.
COAST_SEGMENT_PTS = 12            # ring points per synthesised shore segment
COAST_MAX_SEGMENTS = 600          # hard cap; a whole sea coast must not swamp the page
COAST_BBOX_PAD_M = 2000.0         # keep shore just outside the border — it still bounds the map
COAST_MIN_AREA_SQM = 25e6         # 25 km²: floor, so a tiny map cannot promote a pond to a sea


def _synth_coastline(pois: dict[str, list[Poi]], bbox: tuple[float, float, float, float],
                     proj: Projection) -> tuple[list[Poi], list[str]]:
    """Shore segments for every water body that extends beyond the map border.

    Returns `(segments, names)`. A water body wholly inside the border is a lake you
    can walk around, not a coast, and is left to the body-of-water questions.
    """
    padded = bbox_expand(bbox, COAST_BBOX_PAD_M)
    segments: list[Poi] = []
    names: list[str] = []

    # "Larger than the game map" is the test, with a floor so that a very small map
    # cannot promote a boating pond to a sea.
    south, west, north, east = bbox
    sw, ne = proj.xy(south, west), proj.xy(north, east)
    map_area = abs((ne[0] - sw[0]) * (ne[1] - sw[1]))
    threshold = max(map_area, COAST_MIN_AREA_SQM)

    for water in sorted(pois.get("water") or [], key=lambda p: (p.osm_type, p.osm_id)):
        if not water.rings:
            continue
        # Polygonal water only. A river or canal is linear and almost always runs off
        # the edge of the map, but a riverbank is not a coast — that is what the
        # body-of-water questions are for.
        if (water.tags or {}).get("natural") != "water":
            continue
        # Bigger than the map? This has to be a real size test, not a clipping test:
        # "some ring point falls outside the border" is also true of every pond near
        # the map edge, and picked up three suburban ponds on the reference feed.
        # Overpass returns a matched element's full geometry, so the area is honest.
        area = max((abs(polygon_area([proj.xy(lat, lon) for lat, lon in ring]))
                    for ring in water.rings if len(ring) >= 3), default=0.0)
        if area < threshold:
            continue

        runs: list[list[tuple[float, float]]] = []
        for ring in water.rings:
            run: list[tuple[float, float]] = []
            for lat, lon in ring:
                if bbox_contains(padded, lat, lon):
                    run.append((lat, lon))
                elif run:
                    runs.append(run)
                    run = []
            if run:
                runs.append(run)
        if not runs:
            continue                      # bigger than the map, but nowhere near it

        made = 0
        for run in runs:
            for start in range(0, len(run), COAST_SEGMENT_PTS):
                chunk = run[start:start + COAST_SEGMENT_PTS]
                if len(chunk) < 2:
                    continue
                if len(segments) >= COAST_MAX_SEGMENTS:
                    break
                mid = chunk[len(chunk) // 2]
                segments.append(Poi(
                    category="coastline",
                    osm_type=water.osm_type,
                    # Negative ids mark a derived feature, and keep every segment
                    # distinct so nothing downstream dedupes them into one.
                    osm_id=-(abs(water.osm_id) * 1000 + len(segments)),
                    name=water.name,
                    lat=mid[0], lon=mid[1],
                    tags={"natural": "coastline", "derived_from": f"{water.osm_type}/{water.osm_id}",
                          "derived": "shore of a water body larger than the map"},
                    rings=(tuple(chunk),),
                ))
                made += 1
            if len(segments) >= COAST_MAX_SEGMENTS:
                break
        if made:
            names.append(water.name or f"{water.osm_type}/{water.osm_id}")
        if len(segments) >= COAST_MAX_SEGMENTS:
            log.warning("coastline synthesis hit the %d-segment cap", COAST_MAX_SEGMENTS)
            break

    return segments, names


def collect_geodata(cache: Cache, opts: Options, border: Border, zones: Sequence[Zone],
                    proj: Projection, radius_m: float) -> GeoData:
    """Run the whole S2 pipeline and return `GeoData`.

    Order: the one-request category count audit → geometry fetches for the categories
    that need it → the POI index → per-zone inventory → Nominatim → admin resolution →
    curse predicates → cuisines → legal spots. Under `--no-osm`, or if Overpass fails
    outright, return `GeoData(available=False, …)` with empty containers; every
    downstream consumer must degrade rather than crash.

    Budget on the reference map: ~10 requests, ~40 MB, once, then cached.
    """
    bbox = border.bbox
    catalogue = _geo_categories()
    queries: list[OverpassQueryRecord] = []
    notes: list[str] = []

    # ── 1. one-request map-level audit ────────────────────────────────────────
    audit_pairs = [(c.key, _ov_selector(c)) for c in GEO_CATEGORIES if _ov_selector(c)]
    audit_query = _counts_query(bbox, audit_pairs)
    counts = overpass_counts(cache, bbox, audit_pairs)   # raises ⇒ build_report degrades
    audit_key = _cache_key16(audit_query)

    # ── 2. features, one request per group, per-category fallback ─────────────
    pois: dict[str, list[Poi]] = {}
    fetch_keys: dict[str, str] = {}
    partial_categories: set[str] = set()
    for label, keys in GEO_FETCH_GROUPS:
        group = [catalogue[k] for k in keys if k in catalogue]
        big = [c for c in group if counts.get(c.key, 0) > CATEGORY_FEATURE_BUDGET]
        group = [c for c in group if c not in big]
        for category in big:
            partial_categories.add(category.key)
            log.warning("category %s has %d features (> %d): counted, not fetched",
                        category.key, counts.get(category.key, 0), CATEGORY_FEATURE_BUDGET)
        if group:
            try:
                fetched, key = _fetch_group(cache, group, bbox, proj, label)
                for category in group:
                    pois[category.key] = fetched.get(category.key, [])
                    fetch_keys[category.key] = key
            except CacheMiss:
                raise
            except Exception as exc:  # noqa: BLE001 — one bad selector must not kill the group
                log.warning("group %s failed (%s); falling back to per-category fetches", label, exc)
                for category in group:
                    try:
                        pois[category.key] = fetch_category(cache, category, bbox, proj)
                        fetch_keys[category.key] = _cache_key16(
                            _ov_header() + f"({_ov_sub(_ov_selector(category), bbox)});"
                            f"{_out_directive(category)}")
                    except CacheMiss:
                        raise
                    except Exception as inner:  # noqa: BLE001
                        partial_categories.add(category.key)
                        log.warning("category %s unavailable: %s", category.key, inner)

    # Buildings: a pure density tally, and the only place `out center` is allowed.
    building = catalogue.get("building")
    if building is not None:
        n_buildings = counts.get("building", 0)
        if 0 < n_buildings <= OVERPASS_WAY_BUDGET:
            try:
                pois["building"] = fetch_category(cache, building, bbox, proj)
                fetch_keys["building"] = _cache_key16(
                    _ov_header() + f"({_ov_sub(building.selector, bbox)});{_out_directive(building)}")
            except CacheMiss:
                raise
            except Exception as exc:  # noqa: BLE001
                partial_categories.add("building")
                log.warning("building density fetch failed: %s", exc)
        elif n_buildings > OVERPASS_WAY_BUDGET:
            partial_categories.add("building")
            notes.append(
                f"{num(n_buildings)} buildings is above the {num(OVERPASS_WAY_BUDGET)}-way fetch "
                "budget, so per-zone building counts were not computed; the map-wide count is exact.")

    # ── 2b. great-lake and inland-sea shores count as coastline ──────────────
    if pois.get("water"):
        shore, shore_names = _synth_coastline(pois, bbox, proj)
        if shore:
            pois["coastline"] = sorted(
                (pois.get("coastline") or []) + shore,
                key=lambda p: (p.osm_type, p.osm_id))
            counts["coastline"] = counts.get("coastline", 0) + len(shore)
            joined = ", ".join(sorted(set(shore_names))[:4])
            notes.append(
                f"OpenStreetMap tags `natural=coastline` on ocean and sea shorelines only, so a "
                f"great lake carries none. {num(len(shore))} shore segments were derived from "
                f"{joined} — water bodies larger than the game map, whose shore bounds the map the "
                f"way a coast does. Distances are measured to those segments.")
            log.info("coastline: derived %d shore segments from %s", len(shore), joined)

    # ── 3. provenance rows, one per category ─────────────────────────────────
    for category in GEO_CATEGORIES:
        selector = _ov_selector(category)
        if not selector:
            continue
        counted = counts.get(category.key)
        if counted is None:
            continue
        queries.append(OverpassQueryRecord(
            key=category.key,
            selector=_ov_sub(selector, bbox),
            bbox=bbox,
            count=counted,
            cache_key=fetch_keys.get(category.key, audit_key),
            endpoint=OVERPASS_ENDPOINTS[0],
            partial=category.key in partial_categories,
        ))

    # ── 4. per-zone inventory (two predicates, never interchanged) ────────────
    inventory, polygon_hits = zone_inventory(zones, pois, proj, radius_m)

    geo = GeoData(
        available=True, bbox=bbox, pois=pois, counts=counts, zone_inventory=inventory,
        zone_polygon_hits=polygon_hits,
        admin=AdminInfo(None, None, None, {1: None, 2: None, 3: None, 4: None}, {}, {}, "unknown"),
        curse_counts={}, cuisines={}, legal_spots={}, queries=queries, notes=notes,
    )

    # ── 5. place, country and the administrative ladder ──────────────────────
    # Probe the mean of the zone centres, not the bbox centre: the network's centre of
    # mass is where the map actually is, and a bounding box's middle can easily be a
    # field. Falls back to the bbox centre when there are no zones at all.
    s, w, n, e = bbox
    if zones:
        ordered = sorted(zones, key=lambda z: z.zone_id)
        probe = (sum(z.lat for z in ordered) / len(ordered),
                 sum(z.lon for z in ordered) / len(ordered))
    else:
        probe = ((s + n) / 2.0, (w + e) / 2.0)
    nominatim: dict[str, Any] | None = None
    try:
        nominatim = nominatim_reverse(cache, probe[0], probe[1])
    except CacheMiss:
        raise
    except Exception as exc:  # noqa: BLE001 — is_in carries the ISO code as a free fallback
        log.warning("Nominatim unavailable (%s); falling back to is_in tags", exc)
    if nominatim:
        queries.append(OverpassQueryRecord(
            key="nominatim-reverse",
            selector=_nominatim_url(probe[0], probe[1]),
            bbox=bbox, count=1,
            cache_key=_cache_key16(_nominatim_url(probe[0], probe[1])),
            endpoint=NOMINATIM_ENDPOINT, partial=False,
        ))
    geo.admin = resolve_admin(cache, zones, bbox, nominatim)
    if zones:
        ordered_points = [(z.lat, z.lon) for z in sorted(zones, key=lambda z: z.zone_id)]
        queries.append(OverpassQueryRecord(
            key="admin-containment",
            selector=f"is_in(lat,lon);out tags;out count;  × {num(len(zones))} zone centres, "
                     f"batched {IS_IN_BATCH} per request",
            bbox=bbox, count=len(geo.admin.per_zone),
            cache_key=_cache_key16(_is_in_query(ordered_points[:IS_IN_BATCH])),
            endpoint=OVERPASS_ENDPOINTS[0], partial=not geo.admin.per_zone,
        ))

    # ── 6. cuisines, then the curse audit that consumes them ─────────────────
    host = (geo.admin.country_code or "").upper() or None
    restaurants = pois.get("restaurant", [])
    per_country, qualifying, tagged, total, rejected = _cuisine_detail(restaurants, host)
    geo.cuisines = per_country
    geo.curse_counts = curse_predicates(cache, bbox, geo)
    queries.append(OverpassQueryRecord(
        key="curse-audit",
        selector="; ".join(f"{k}: {_ov_sub(sel, bbox)}" for k, sel in CURSE_PREDICATE_SELECTORS),
        bbox=bbox, count=len(geo.curse_counts),
        cache_key=_cache_key16(_counts_query(bbox, CURSE_PREDICATE_SELECTORS)),
        endpoint=OVERPASS_ENDPOINTS[0], partial=not geo.curse_counts,
    ))

    # ── 7. candidate legal endgame spots ─────────────────────────────────────
    walkable_ways = counts.get("street", 0)
    if walkable_ways and walkable_ways > LEGAL_PATH_JOIN_WAY_BUDGET:
        path_ids, path_key, path_n = None, "", 0
        log.info("path proximity join skipped: %d walkable ways > %d",
                 walkable_ways, LEGAL_PATH_JOIN_WAY_BUDGET)
        notes.append(
            f"The rulebook's “within 10 ft of a routable path” test was not evaluated: this map "
            f"has {num(walkable_ways)} walkable ways, and asking a shared Overpass mirror to buffer "
            f"all of them is not a polite request. Every candidate spot below is therefore marked "
            f"verify-on-the-ground.")
    else:
        path_ids, path_key, path_n = _fetch_path_adjacent_ids(cache, bbox)
        queries.append(OverpassQueryRecord(
            key="legal-spot-path-filter",
            selector=f"({_ov_sub(FOOT_WAY_SELECTOR, bbox)})->.paths; candidate features "
                     f"(around.paths:{LEGAL_PATH_RADIUS_M}); out ids;",
            bbox=bbox, count=path_n,
            cache_key=path_key, endpoint=OVERPASS_ENDPOINTS[0], partial=path_ids is None,
        ))
    geo.path_ok_ids = path_ids                      # read by legal_endgame_spots only
    geo.legal_spots = legal_endgame_spots(zones, geo, proj, radius_m)

    # ── 8. the honesty notes that must reach the page ────────────────────────
    notes.append(
        "OSM has no review count, so the rulebook's “5 or more Google Reviews” legitimacy test is "
        "approximated by requiring a `name` tag. Measured effect on this kind of feed: a 5–10% trim, "
        "in the right direction, but not the same function.")
    notes.append(
        "Every OpenStreetMap count here is a lower bound on what the seekers' map app will show. "
        "OSM is strong on parks, schools, places of worship, hospitals and libraries and materially "
        "incomplete on retail, restaurants and chains.")
    offset = _icon_offset_p90(pois.get("park", []), proj)
    if offset is not None:
        notes.append(
            f"Distances are measured to a computed area centroid, not to a map app's label anchor. "
            f"On this map's park polygons the two differ by up to {num(offset)} m at the 90th "
            f"percentile, which is a real fraction of the {num(radius_m)} m zone radius.")
    if path_ids is None and path_key:
        notes.append(
            "The “within 10 ft of a routable path” test could not be evaluated (the Overpass "
            "proximity join failed), so every candidate spot below is marked verify-on-the-ground.")
    notes.append(
        "Candidate hiding spots are a shortlist for a human, never a verdict: OpenStreetMap does not "
        "know whether a plaza is locked at night, so the rulebook's “publicly accessible during all "
        "game hours” test cannot be automated.")
    if total:
        notes.append(
            f"{pct(tagged / total)} of restaurants carry a `cuisine` tag ({num(tagged)} of "
            f"{num(total)}), so the {num(qualifying)} restaurants qualifying for Curse of the "
            f"Distant Cuisine are a floor, not a total.")
    if rejected:
        shown = ", ".join(rejected[:12])
        notes.append(
            f"Cuisine tokens rejected as dishes or super-national regions rather than countries: "
            f"{shown}{'…' if len(rejected) > 12 else ''}. Adjective tokens only — promoting a dish "
            f"to a country would change the count.")
    if counts.get("coastline", 0) == 0 and counts.get("water", 0) > 0:
        notes.append(
            "OpenStreetMap tags `natural=coastline` on ocean and sea shorelines only, so a great "
            "lake or inland sea carries none. A zero here means “no ocean coast in the border”, not "
            "“no large water”.")
    if counts.get("mountain", 0) == 0:
        notes.append(
            "No named peak or volcano is mapped inside the border. A map app may still label a hill "
            "from its own gazetteer, so treat the mountain questions as dead-with-a-caveat.")
    if len(zones) > 1:
        pts = [(z.lat, z.lon) for z in sorted(zones, key=lambda z: z.zone_id)]
        diagonal = haversine_m(min(p[0] for p in pts), min(p[1] for p in pts),
                               max(p[0] for p in pts), max(p[1] for p in pts))
        for a, b, d in _redundant_pairs(pois, proj, diagonal):
            notes.append(
                f"{catalogue[a].label} and {catalogue[b].label} each have exactly one instance on "
                f"this map and their icons are {num(d)} m apart, so the two matching questions are "
                f"the same bit of information bought twice.")
    partial_keys = sorted(q.key for q in queries if q.partial)
    if partial_keys:
        notes.append(
            "These queries returned a floor rather than a total and are marked partial: "
            + ", ".join(partial_keys) + ".")
    notes.append(
        "Counts reflect one OpenStreetMap snapshot; the mirror that answered is not recorded, "
        "because recording it would make two identical runs produce different pages. Cached "
        "responses keep reruns byte-identical.")

    geo.notes = notes
    geo.queries = sorted(queries, key=lambda q: (q.key, q.cache_key))
    return geo


# ═══════════════════════════════════════════════════════════════════════════════
# S3 · RULES — catalogue, question viability, information resistance, scoring
# ═══════════════════════════════════════════════════════════════════════════════
#
# Owner: the S3 agent. Specs: scratchpad/specs/rules.md + rules.json (the rulebook,
# machine-readable) and scoring.md (every score, rank and verdict).
#
# The catalogue below is *data*, transcribed from rules.json. rules.json itself is
# 234 kB and cannot be shipped inside this file, so S3 distils it: the fields the
# engine actually reads, and nothing else. The literal must be complete — 80
# questions, 24 curses, 3 sizes — and its counts are asserted at import time.


@dataclass(frozen=True)
class QuestionDef:
    """One of the rulebook's 80 questions, as the engine needs it."""

    id: str                                     # 'matching.park'
    category: Literal["matching", "measuring", "radar", "thermometer", "photo", "tentacle"]
    group: str                                  # the rulebook's own grouping, e.g. 'Transit'
    label: str                                  # 'Park'
    text: str                                   # the full question sentence
    sizes: tuple[str, ...]                      # which game sizes include it
    draw: int
    keep: int                                   # == the cards the hider gains; 2 only for tentacles
    geodata_ref: str | None                     # key into GEO_CATEGORIES, or None for GTFS-only
    param: float | None = None                  # radar/thermometer/tentacle distance, in miles
    note: str = ""


@dataclass(frozen=True)
class CurseDef:
    """One of the 24 curses, with the predicate that decides whether it stays in."""

    id: str
    name: str
    tier: Literal[1, 2, 3, 4]                   # 1 rulebook-explicit … 4 not map-contingent
    card_text: str
    casting_cost: str
    blocks: tuple[str, ...]
    predicate_key: str | None                   # curse-predicate key, or None
    removal_rule: str                           # plain words, printed on the page
    quote: str = ""                             # verbatim rulebook trigger, tier 1 only


# Rulebook size parameters. Complete — these three entries are the whole table.
#
# `thermometer_mi` is cumulative, exactly as SEEKING.md prints it: SMALL gets ½ and 3 mi,
# MEDIUM and LARGE add 10 mi, LARGE adds 50 mi. There is no ¼-mile, 1-mile or 15-mile
# thermometer. `tentacle_reach_mi` is 0 for SMALL because SEEKING.md line 436 says
# outright "Tentacle question cannot be used in SMALL games". Both now agree with the
# QUESTIONS rows below and with `_S1_SIZE_PARAMS`, which is the copy the pipeline runs on.
#
# One field is NOT a transcription: `required_hours` (6 / 10 / 12) is ours. The rulebook
# gives a size's length only as prose — "lasts 4–8 hours" / "about 1 day" / "2 to 4 days"
# (GUIDE.md "Choosing Game Size") — and never an hours-per-playing-day figure, so the
# metric built on it is tagged `interp` rather than `rulebook`. The trailing `True` is a
# different thing entirely and is not a provenance flag: it is `GameSize.inferred`,
# meaning the size was deduced from the feed rather than forced with `--size`.
SIZES: dict[str, GameSize] = {
    "small": GameSize("small", 30, QUARTER_MILE_M, 0.0, (0.5, 3.0), 5, 58, 10, 5, 10, 6.0, True),
    "medium": GameSize("medium", 60, QUARTER_MILE_M, 1.0, (0.5, 3.0, 10.0), 6, 71, 10, 5, 20, 10.0, True),
    "large": GameSize("large", 180, HALF_MILE_M, 15.0, (0.5, 3.0, 10.0, 50.0), 6, 80, 20, 5, 60, 12.0, True),
}

# Radar distances the rulebook offers, in miles. The last one is the "Choose" radar,
# which is why the radar category can never be fully dead on any map.
RADAR_MILES: tuple[float, ...] = (0.25, 0.5, 1.0, 3.0, 5.0, 10.0, 25.0, 50.0, 100.0)

# S3: complete these two tables from specs/rules.json. Three rows of each are given
# to pin the shape; the assertions below fail loudly until the tables are complete.
QUESTIONS: tuple[QuestionDef, ...] = (
    QuestionDef("matching.commercial_airport", "matching", "Transit", "Commercial Airport",
                "Is your nearest commercial airport the same as my nearest commercial airport?",
                ("small", "medium", "large"), 3, 1, "commercial_airport"),
    QuestionDef("matching.transit_line", "matching", "Transit", "Transit Line",
                "Is your nearest transit line the same as my nearest transit line?",
                ("small", "medium", "large"), 3, 1, None,
                note="Can only be asked from aboard a moving vehicle; if the hider draws, "
                     "pays for and plays Curse of the Urban Explorer, it is gone for the "
                     "rest of the run."),
    QuestionDef("radar.5mi", "radar", "Radar", "5 miles",
                "Are you within 5 miles of me?", ("small", "medium", "large"), 2, 1, None, param=5.0),
    # … 77 more, from specs/rules.json `questions[]`
)

CURSES: tuple[CurseDef, ...] = (
    CurseDef("bridge_troll", "Curse of the Bridge Troll", 1,
             "The seekers must ask their next question from under a bridge.",
             "Seekers must be at least S 1 / M 5 / L 30 miles from you.",
             ("asking_questions",), "bridge",
             "Remove when the map contains no bridges.",
             quote="If there are no bridges on the game map, this curse should be removed from the deck."),
    CurseDef("water_weight", "Curse of the Water Weight", 2,
             "", "Seekers must be within 1,000 feet (300 m) of a body of water.",
             ("asking_questions",), "water",
             "The casting cost is a geographic gate: with no non-pool water body the curse can never be cast."),
    CurseDef("u_turn", "Curse of the U-Turn", 3,
             "", "", (), "u_turn",
             "Decided by GTFS, not OSM: the card only bites when another route serves the next "
             "station inside 0.5/0.5/1 hours."),
    # … 21 more, from specs/rules.json `hider_deck.curses[]`
)


@dataclass
class QuestionAudit:
    """One question's verdict on this map — the core of index.html §05."""

    id: str
    category: str
    label: str
    text: str
    status: Literal["functional", "weak", "degenerate", "dead", "unaskable", "unknown"]
    quality: float                          # 0..1, normalised per category
    instances: int | None                   # in-border N; None when not evaluated
    coverage: float | None                  # photo questions: share of zones with the subject
    selector: str                           # the exact Overpass selector, or a GTFS note
    why: str                                # one sentence, printed next to the status
    surv_mean: float | None = None          # mean surv over Z, for the funnel
    borderline: bool = False                # would flip under a modestly larger border


@dataclass
class CurseAudit:
    """One curse's verdict."""

    id: str
    name: str
    tier: int
    action: Literal["keep", "warn", "remove", "player-choice"]
    predicate: str
    count: int | None
    why: str


@dataclass
class Metric:
    """One named, traceable scoring metric. This tuple *is* the explanation.

    Arithmetic is in **integer tenths of a point** throughout, so sub-scores and
    totals are integer sums and no float drift can move a headline number.
    """

    id: str                                 # 'A1', 'IR2', …
    name: str
    raw: float | None
    unit: str
    points_tenths: int
    max_tenths: int
    ramp: dict[str, Any]                    # {kind: 'ramp'|'rramp'|'plateau'|'table', args: [...]}
    source: Literal["rulebook", "feed", "interp"]
    note: str = ""
    available: bool = True                  # False ⇒ dropped from the denominator


@dataclass
class SubScore:
    """A named block of metrics. Degradation is drop-and-renormalise, never impute."""

    id: str
    name: str
    metrics: list[Metric]
    earned_tenths: int
    max_tenths: int
    partial: bool = False
    missing: tuple[str, ...] = ()


@dataclass
class Fitness:
    """The city rating: 100 points across six sub-scores, plus the per-day deltas."""

    score: float | None                     # None when >40% of points are unavailable
    raw_score: float
    capped_by: str | None
    band: str
    subscores: list[SubScore]
    available_points: float
    per_day: dict[str, float]


@dataclass
class Threat:
    """One question that narrows the search onto a zone — the dossier's "what finds you"."""

    question_id: str
    label: str
    surv: float
    answer: str
    zones_remaining: int


@dataclass
class ZoneScore:
    """One zone's rating: six axes, 100 points, plus the flags that cap it."""

    zone_id: str
    overall_tenths: int
    capped_by: str | None
    axes: dict[str, int]                    # axis id → tenths earned
    axis_max: dict[str, int]
    metrics: list[Metric]
    flags: tuple[str, ...]
    threats: tuple[Threat, ...]
    surv_k: float
    pin_worst: float
    mean_surv: float
    excluded: bool = False                  # unreachable / no service: ranked separately
    exclude_reason: str = ""


@dataclass
class Report:
    """Everything the two renderers consume. See contract.md for the field-by-field
    shape and a worked example populated with real reference-feed values."""

    opts: Options
    feed: Feed
    proj: Projection
    size: GameSize
    size_inference: SizeInference
    hub: Hub
    border: Border
    days: list[ServiceDay]
    selected_day: str
    zones: list[Zone]
    metrics: dict[str, Any]
    route_headways: list[dict[str, Any]]
    travel_samples: list[dict[str, Any]]
    geo: GeoData
    questions: list[QuestionAudit]
    question_order: list[str]
    question_funnel: list[int]
    curses: list[CurseAudit]
    fitness: Fitness
    zone_scores: dict[str, ZoneScore]
    ranked_zone_ids: list[str]
    dossier_zone_ids: list[str]
    findings: list[dict[str, Any]]
    recommendations: list[dict[str, Any]]
    place: str
    provenance: dict[str, Any]
    degradations: list[str]


# ── ramps: the only shaping functions in the scoring path ─────────────────────

def ramp(x: float, lo: float, hi: float) -> float:
    """Monotone increasing, clamped: lo→0, hi→1."""
    if hi == lo:
        return 1.0 if x >= hi else 0.0
    return min(1.0, max(0.0, (x - lo) / (hi - lo)))


def rramp(x: float, good: float, bad: float) -> float:
    """Monotone decreasing, clamped: good→1, bad→0."""
    return ramp(-x, -bad, -good)


def plateau(x: float, a: float, b: float, c: float, d: float) -> float:
    """0 below a, ramp a→b, 1 across [b, c], ramp down c→d, 0 above d."""
    if x < b:
        return ramp(x, a, b)
    if x <= c:
        return 1.0
    return rramp(x, c, d)


def tenths(fraction: float, max_points: float) -> int:
    """Convert a ramp output to integer tenths of a point.

    `floor(frac * max * 10 + 0.5)`. Every point in the program is an integer number
    of tenths from here on, so sub-scores and totals are exact integer sums.
    """
    return int(math.floor(fraction * max_points * 10 + 0.5))


# ── S3 functions ──────────────────────────────────────────────────────────────


# ═══════════════════════════════════════════════════════════════════════════════
# S3 · RULES — implementation (concatenate into generate.py in place of the stubs)
# ═══════════════════════════════════════════════════════════════════════════════
#
# NAMES ASSUMED IN SCOPE (all provided by the skeleton; none are redefined here)
#
#   stdlib, already imported at the top of generate.py — no new import is needed:
#       bisect, collections, math
#   third-party: none. Nothing in S3 performs I/O, and nothing in S3 calls an LLM.
#
#   constants:  QUARTER_MILE_M  M_PER_MILE  SQM_PER_SQMI  SEEKER_SAMPLE_CAP
#               SURV_FULL_UNIVERSE_MAX  HEADWAY_WINDOW  SERVICE_DAY_SECONDS
#               GEO_CATEGORIES  CAR_STREET_SELECTOR  LOW_STREETVIEW_COUNTRIES
#               GENERATOR  VERSION
#   number/format helpers: rhu num pct mins miles sqmi hhmm hms_to_s quantile
#   ramps:      ramp  rramp  plateau  tenths
#   geometry:   bbox_of  bbox_expand  bbox_contains  Projection
#   dataclasses declared in the skeleton and filled in here:
#               QuestionDef CurseDef QuestionAudit CurseAudit Metric SubScore
#               Fitness Threat ZoneScore
#   dataclasses read but never constructed here:
#               Options Feed GameSize Hub Border Zone ServiceDay TravelTimes
#               GeoData Poi AdminInfo
#   tables:     SIZES (the skeleton's own). QUESTIONS and CURSES below are the
#               complete versions of the two stub tables the skeleton carries —
#               the integrator must DELETE the skeleton's three-row placeholders,
#               not keep both.
#
# Everything here is pure: no clock, no network, no `random`, every dict and set is
# iterated through `sorted()`, and every tie-break ends in a stable id. Verified
# byte-identical across PYTHONHASHSEED=0/7/999/12345 over a 2.2 MB dump of every
# question audit, curse audit, metric trace and all 319 zone scores.
#
# NOTES FOR THE INTEGRATOR AND FOR S4/S5 — five things worth knowing
#
#   1. `question_funnel` has **k + 1** entries. `funnel[0]` is `n` (the whole zone
#      universe) and `funnel[i]` is the surviving block size after the i-th question,
#      so a MEDIUM game reads `319 → 159 → 80 → 42 → 23`. Render it as a chain, not
#      zipped against `question_order`.
#   2. `fitness_caps(metrics, questions, zones, size, days)` is an extra public
#      helper this section exports. It returns all five guard rails — fired or not,
#      each with `{id, cap, fired, evaluated, why}` — because `Fitness` only carries
#      `capped_by`, and §Score Trace has to be able to show "CAP_CATEGORIES: not
#      evaluated" rather than silently omitting it.
#   3. `score_zones` fills `QuestionAudit.surv_mean` **in place**. It is the only
#      function that sees both the audit rows and the survival table, and the
#      contract puts that field on the audit row. Render questions after scoring.
#   4. `derive_findings` never emits the **benefit** quadrant. Its signature does not
#      receive the feed, so `fare_attributes` is out of reach; the contract says drop
#      the quadrant rather than invent it. The fare fact reaches the page through the
#      `carry_fare` recommendation instead.
#   5. `answer_signature` and `global_question_order` memoise on the zone universe,
#      so `audit_questions` (which needs a signature to score quality) and
#      `build_report` (which asks for the same signature again) do the work once.


# ═══════════════════════════════════════════════════════════════════════════════
# S3 · THE CATALOGUE — the rulebook as data
# ═══════════════════════════════════════════════════════════════════════════════
#
# Transcribed from specs/rules.json, which was itself read off GUIDE.md / HIDING.md
# / SEEKING.md and the 24 curse card faces. Question text is verbatim. `note` is
# analysis and the pages must render it as such.
#
# Ids differ from rules.json's in three families, to match contract.md §5.1/§5.2:
# `radar.5mi` not `radar.5_miles`, `matching.admin_1` not
# `matching.1st_administrative_division`, `tentacle.metro_line` not
# `tentacle.metro_lines_within_15_miles`. Nothing else was renamed.

QUESTIONS: tuple[QuestionDef, ...] = (
    QuestionDef("matching.commercial_airport", "matching", "Transit", "Commercial Airport",
                "Is your nearest commercial airport the same as my nearest commercial airport?",
                ("small", "medium", "large"), 3, 1, "commercial_airport"),
    QuestionDef("matching.transit_line", "matching", "Transit", "Transit Line",
                "Is your nearest transit line the same as my nearest transit line?",
                ("small", "medium", "large"), 3, 1, None,
                # NOT the `unaskable` status: the rulebook attaches a timing precondition,
                # not a terrain one, and a curse that has to be drawn and paid for is not a
                # property of the map. `audit_questions` scores this like every other
                # matching question.
                note="Can only be asked from aboard a moving vehicle; if the hider draws, pays "
                     "for and plays Curse of the Urban Explorer, it is gone for the rest of "
                     "the run.",
                ),
    QuestionDef("matching.station_name_length", "matching", "Transit", "Station's Name Length",
                "Is your nearest station's name length the same as my nearest station's name length?",
                ("small", "medium", "large"), 3, 1, None),
    QuestionDef("matching.street_or_path", "matching", "Transit", "Street or Path",
                "Is your nearest street or path the same as my nearest street or path?",
                ("small", "medium", "large"), 3, 1, "street",
                note="Streets are counted map-wide but not fetched as geometry; the partition is "
                     "modelled as one class per zone.",
                ),
    QuestionDef("matching.admin_1", "matching", "Administrative Divisions", "1st Administrative Division",
                "Is your nearest 1st administrative division the same as my nearest 1st administrative division?",
                ("small", "medium", "large"), 3, 1, None),
    QuestionDef("matching.admin_2", "matching", "Administrative Divisions", "2nd Administrative Division",
                "Is your nearest 2nd administrative division the same as my nearest 2nd administrative division?",
                ("small", "medium", "large"), 3, 1, None),
    QuestionDef("matching.admin_3", "matching", "Administrative Divisions", "3rd Administrative Division",
                "Is your nearest 3rd administrative division the same as my nearest 3rd administrative division?",
                ("small", "medium", "large"), 3, 1, None),
    QuestionDef("matching.admin_4", "matching", "Administrative Divisions", "4th Administrative Division",
                "Is your nearest 4th administrative division the same as my nearest 4th administrative division?",
                ("small", "medium", "large"), 3, 1, None),
    QuestionDef("matching.mountain", "matching", "Natural", "Mountain",
                "Is your nearest mountain the same as my nearest mountain?",
                ("small", "medium", "large"), 3, 1, "mountain"),
    QuestionDef("matching.landmass", "matching", "Natural", "Landmass",
                "Is your nearest landmass the same as my nearest landmass?",
                ("small", "medium", "large"), 3, 1, "coastline",
                note="Derived from assembled coastline: with no coastline inside the border the "
                     "whole map is one landmass.",
                ),
    QuestionDef("matching.park", "matching", "Natural", "Park",
                "Is your nearest park the same as my nearest park?",
                ("small", "medium", "large"), 3, 1, "park"),
    QuestionDef("matching.amusement_park", "matching", "Places of Interest", "Amusement Park",
                "Is your nearest amusement park the same as my nearest amusement park?",
                ("small", "medium", "large"), 3, 1, "amusement_park"),
    QuestionDef("matching.zoo", "matching", "Places of Interest", "Zoo",
                "Is your nearest zoo the same as my nearest zoo?",
                ("small", "medium", "large"), 3, 1, "zoo"),
    QuestionDef("matching.aquarium", "matching", "Places of Interest", "Aquarium",
                "Is your nearest aquarium the same as my nearest aquarium?",
                ("small", "medium", "large"), 3, 1, "aquarium"),
    QuestionDef("matching.golf_course", "matching", "Places of Interest", "Golf Course",
                "Is your nearest golf course the same as my nearest golf course?",
                ("small", "medium", "large"), 3, 1, "golf_course"),
    QuestionDef("matching.museum", "matching", "Places of Interest", "Museum",
                "Is your nearest museum the same as my nearest museum?",
                ("small", "medium", "large"), 3, 1, "museum"),
    QuestionDef("matching.movie_theater", "matching", "Places of Interest", "Movie Theater",
                "Is your nearest movie theater the same as my nearest movie theater?",
                ("small", "medium", "large"), 3, 1, "movie_theater"),
    QuestionDef("matching.hospital", "matching", "Public Utilities", "Hospital",
                "Is your nearest hospital the same as my nearest hospital?",
                ("small", "medium", "large"), 3, 1, "hospital"),
    QuestionDef("matching.library", "matching", "Public Utilities", "Library",
                "Is your nearest library the same as my nearest library?",
                ("small", "medium", "large"), 3, 1, "library"),
    QuestionDef("matching.foreign_consulate", "matching", "Public Utilities", "Foreign Consulate",
                "Is your nearest foreign consulate the same as my nearest foreign consulate?",
                ("small", "medium", "large"), 3, 1, "foreign_consulate"),
    QuestionDef("measuring.commercial_airport", "measuring", "Transit-Related", "Commercial Airport",
                "Compared to me, are you closer to or further from a commercial airport?",
                ("small", "medium", "large"), 3, 1, "commercial_airport"),
    QuestionDef("measuring.high_speed_rail", "measuring", "Transit-Related", "High-Speed Train Line",
                "Compared to me, are you closer to or further from a high-speed train line?",
                ("small", "medium", "large"), 3, 1, "high_speed_rail"),
    QuestionDef("measuring.rail_station", "measuring", "Transit-Related", "Rail Station",
                "Compared to me, are you closer to or further from a rail station?",
                ("small", "medium", "large"), 3, 1, "rail_station"),
    QuestionDef("measuring.international_border", "measuring", "Borders", "International Border",
                "Compared to me, are you closer to or further from an international border?",
                ("small", "medium", "large"), 3, 1, None,
                note="Decided by whether an admin_level=2 boundary line crosses the map, not by "
                     "the containing country.",
                ),
    QuestionDef("measuring.admin_1_border", "measuring", "Borders", "1st Administrative Division Border",
                "Compared to me, are you closer to or further from a 1st administrative division border?",
                ("small", "medium", "large"), 3, 1, None,
                note="A boundary LINE crossing the map, which can be true while the matching "
                     "twin is degenerate.",
                ),
    QuestionDef("measuring.admin_2_border", "measuring", "Borders", "2nd Administrative Division Border",
                "Compared to me, are you closer to or further from a 2nd administrative division border?",
                ("small", "medium", "large"), 3, 1, None,
                note="A boundary LINE crossing the map, which can be true while the matching "
                     "twin is degenerate.",
                ),
    QuestionDef("measuring.sea_level", "measuring", "Natural", "Sea Level",
                "Compared to me, are you closer to or further from sea level?",
                ("small", "medium", "large"), 3, 1, None,
                note="Needs a digital elevation model this pipeline deliberately does not carry; "
                     "reported as not evaluated rather than guessed.",
                ),
    QuestionDef("measuring.body_of_water", "measuring", "Natural", "Body of Water",
                "Compared to me, are you closer to or further from a body of water?",
                ("small", "medium", "large"), 3, 1, "water"),
    QuestionDef("measuring.coastline", "measuring", "Natural", "Coastline",
                "Compared to me, are you closer to or further from a coastline?",
                ("small", "medium", "large"), 3, 1, "coastline"),
    QuestionDef("measuring.mountain", "measuring", "Natural", "Mountain",
                "Compared to me, are you closer to or further from a mountain?",
                ("small", "medium", "large"), 3, 1, "mountain"),
    QuestionDef("measuring.park", "measuring", "Natural", "Park",
                "Compared to me, are you closer to or further from a park?",
                ("small", "medium", "large"), 3, 1, "park"),
    QuestionDef("measuring.amusement_park", "measuring", "Places of Interest", "Amusement Park",
                "Compared to me, are you closer to or further from an amusement park?",
                ("small", "medium", "large"), 3, 1, "amusement_park"),
    QuestionDef("measuring.zoo", "measuring", "Places of Interest", "Zoo",
                "Compared to me, are you closer to or further from a zoo?",
                ("small", "medium", "large"), 3, 1, "zoo"),
    QuestionDef("measuring.aquarium", "measuring", "Places of Interest", "Aquarium",
                "Compared to me, are you closer to or further from an aquarium?",
                ("small", "medium", "large"), 3, 1, "aquarium"),
    QuestionDef("measuring.golf_course", "measuring", "Places of Interest", "Golf Course",
                "Compared to me, are you closer to or further from a golf course?",
                ("small", "medium", "large"), 3, 1, "golf_course"),
    QuestionDef("measuring.museum", "measuring", "Places of Interest", "Museum",
                "Compared to me, are you closer to or further from a museum?",
                ("small", "medium", "large"), 3, 1, "museum"),
    QuestionDef("measuring.movie_theater", "measuring", "Places of Interest", "Movie Theater",
                "Compared to me, are you closer to or further from a movie theater?",
                ("small", "medium", "large"), 3, 1, "movie_theater"),
    QuestionDef("measuring.hospital", "measuring", "Public Utilities", "Hospital",
                "Compared to me, are you closer to or further from a hospital?",
                ("small", "medium", "large"), 3, 1, "hospital"),
    QuestionDef("measuring.library", "measuring", "Public Utilities", "Library",
                "Compared to me, are you closer to or further from a library?",
                ("small", "medium", "large"), 3, 1, "library"),
    QuestionDef("measuring.foreign_consulate", "measuring", "Public Utilities", "Foreign Consulate",
                "Compared to me, are you closer to or further from a foreign consulate?",
                ("small", "medium", "large"), 3, 1, "foreign_consulate"),
    QuestionDef("radar.quarter_mile", "radar", "Radar", "¼ Mile",
                "Are you within ¼ mile of me?",
                ("small", "medium", "large"), 2, 1, None, param=0.25),
    QuestionDef("radar.half_mile", "radar", "Radar", "½ Mile",
                "Are you within ½ mile of me?",
                ("small", "medium", "large"), 2, 1, None, param=0.5),
    QuestionDef("radar.1mi", "radar", "Radar", "1 Mile",
                "Are you within 1 mile of me?",
                ("small", "medium", "large"), 2, 1, None, param=1.0),
    QuestionDef("radar.3mi", "radar", "Radar", "3 Miles",
                "Are you within 3 miles of me?",
                ("small", "medium", "large"), 2, 1, None, param=3.0),
    QuestionDef("radar.5mi", "radar", "Radar", "5 Miles",
                "Are you within 5 miles of me?",
                ("small", "medium", "large"), 2, 1, None, param=5.0),
    QuestionDef("radar.10mi", "radar", "Radar", "10 Miles",
                "Are you within 10 miles of me?",
                ("small", "medium", "large"), 2, 1, None, param=10.0),
    QuestionDef("radar.25mi", "radar", "Radar", "25 Miles",
                "Are you within 25 miles of me?",
                ("small", "medium", "large"), 2, 1, None, param=25.0),
    QuestionDef("radar.50mi", "radar", "Radar", "50 Miles",
                "Are you within 50 miles of me?",
                ("small", "medium", "large"), 2, 1, None, param=50.0),
    QuestionDef("radar.100mi", "radar", "Radar", "100 Miles",
                "Are you within 100 miles of me?",
                ("small", "medium", "large"), 2, 1, None, param=100.0),
    QuestionDef("radar.choose", "radar", "Radar", "Choose",
                "Are you within a distance of my choosing of me?",
                ("small", "medium", "large"), 2, 1, None,
                note="The seekers name any distance, so the radar category can never be fully "
                     "dead; modelled at the distance that splits this map most evenly.",
                ),
    QuestionDef("thermometer.half_mile", "thermometer", "Thermometer", "½ Mile",
                "After traveling ½ mile, am I hotter or colder?",
                ("small", "medium", "large"), 2, 1, None, param=0.5),
    QuestionDef("thermometer.3mi", "thermometer", "Thermometer", "3 Miles",
                "After traveling 3 miles, am I hotter or colder?",
                ("small", "medium", "large"), 2, 1, None, param=3.0),
    QuestionDef("thermometer.10mi", "thermometer", "Thermometer", "10 Miles",
                "After traveling 10 miles, am I hotter or colder?",
                ("medium", "large"), 2, 1, None, param=10.0),
    QuestionDef("thermometer.50mi", "thermometer", "Thermometer", "50 Miles",
                "After traveling 50 miles, am I hotter or colder?",
                ("large",), 2, 1, None, param=50.0),
    QuestionDef("photo.any_building_visible_from_transit_station", "photo", "Photo", "Any Building Visible from Transit Station",
                "Send me a photo of any building visible from transit station.",
                ("small", "medium", "large"), 1, 1, None),
    QuestionDef("photo.widest_street", "photo", "Photo", "Widest Street",
                "Send me a photo of widest street.",
                ("small", "medium", "large"), 1, 1, None,
                note="Unconditionally answerable wherever a transit stop exists.",
                ),
    QuestionDef("photo.tree", "photo", "Photo", "Tree",
                "Send me a photo of tree.",
                ("small", "medium", "large"), 1, 1, None),
    QuestionDef("photo.tallest_structure_in_your_current_sightline", "photo", "Photo", "Tallest Structure in Your Current Sightline",
                "Send me a photo of tallest structure in your current sightline.",
                ("small", "medium", "large"), 1, 1, None,
                note="Unconditionally answerable: there is always a tallest thing in a "
                     "sightline.",
                ),
    QuestionDef("photo.you", "photo", "Photo", "You",
                "Send me a photo of you.",
                ("small", "medium", "large"), 1, 1, None,
                note="Unconditionally answerable, so it carries no locational information — but "
                     "the image itself can still show the seekers something no model can score.",
                ),
    QuestionDef("photo.the_sky", "photo", "Photo", "The Sky",
                "Send me a photo of the sky.",
                ("small", "medium", "large"), 1, 1, None,
                note="Unconditionally answerable; weather and sun angle are outside this model.",
                ),
    QuestionDef("photo.tallest_building_visible_from_transit_station", "photo", "Photo", "Tallest Building Visible from Transit Station",
                "Send me a photo of tallest building visible from transit station.",
                ("medium", "large"), 1, 1, None),
    QuestionDef("photo.trace_nearest_street_path", "photo", "Photo", "Trace Nearest Street/Path",
                "Send me a photo of trace nearest street/path.",
                ("medium", "large"), 1, 1, None,
                note="The street graph is never consulted: this is short-circuited to "
                     "answerable everywhere, so the rulebook's \"street/path must be visible "
                     "on mapping app\" condition is not checked. See the "
                     "photo_always_answerable interpretation.",
                ),
    QuestionDef("photo.2_buildings", "photo", "Photo", "2 Buildings",
                "Send me a photo of 2 buildings.",
                ("medium", "large"), 1, 1, None),
    QuestionDef("photo.restaurant_interior", "photo", "Photo", "Restaurant Interior",
                "Send me a photo of restaurant interior.",
                ("medium", "large"), 1, 1, None),
    QuestionDef("photo.park", "photo", "Photo", "Park",
                "Send me a photo of park.",
                ("medium", "large"), 1, 1, None),
    QuestionDef("photo.grocery_store_aisle", "photo", "Photo", "Grocery Store Aisle",
                "Send me a photo of grocery store aisle.",
                ("medium", "large"), 1, 1, None),
    QuestionDef("photo.place_of_worship", "photo", "Photo", "Place of Worship",
                "Send me a photo of place of worship.",
                ("medium", "large"), 1, 1, None),
    QuestionDef("photo.train_platform", "photo", "Photo", "Train Platform",
                "Send me a photo of train platform.",
                ("medium", "large"), 1, 1, None,
                note="OSM tags `public_transport=platform` on bus stops too, so this is gated on "
                     "the feed actually having a rail mode.",
                ),
    QuestionDef("photo.half_mile_of_streets_traced", "photo", "Photo", "½ Mile of Streets Traced",
                "Send me a photo of ½ mile of streets traced.",
                ("large",), 1, 1, None,
                note="The ≥0.5 mi, ≥5-turn walk is not verified against the street graph; "
                     "treated as answerable and flagged.",
                ),
    QuestionDef("photo.tallest_mountain_visible_from_transit_station", "photo", "Photo", "Tallest Mountain Visible from Transit Station",
                "Send me a photo of tallest mountain visible from transit station.",
                ("large",), 1, 1, None),
    QuestionDef("photo.biggest_body_of_water", "photo", "Photo", "The Biggest Body of Water in Your Zone",
                "Send me a photo of the biggest body of water in your zone.",
                ("large",), 1, 1, None),
    QuestionDef("photo.5_buildings", "photo", "Photo", "5 Buildings",
                "Send me a photo of 5 buildings.",
                ("large",), 1, 1, None),
    QuestionDef("tentacle.museum", "tentacle", "Tentacle", "Museums Within 1 Mile",
                "Within 1 mile of me, which museums are you nearest to? (You must also be within 1 mile.)",
                ("medium", "large"), 4, 2, "museum", param=1.0),
    QuestionDef("tentacle.library", "tentacle", "Tentacle", "Libraries Within 1 Mile",
                "Within 1 mile of me, which libraries are you nearest to? (You must also be within 1 mile.)",
                ("medium", "large"), 4, 2, "library", param=1.0),
    QuestionDef("tentacle.movie_theater", "tentacle", "Tentacle", "Movie Theaters Within 1 Mile",
                "Within 1 mile of me, which movie theaters are you nearest to? (You must also be within 1 mile.)",
                ("medium", "large"), 4, 2, "movie_theater", param=1.0),
    QuestionDef("tentacle.hospital", "tentacle", "Tentacle", "Hospitals Within 1 Mile",
                "Within 1 mile of me, which hospitals are you nearest to? (You must also be within 1 mile.)",
                ("medium", "large"), 4, 2, "hospital", param=1.0),
    QuestionDef("tentacle.metro_line", "tentacle", "Tentacle", "Metro Lines Within 15 Miles",
                "Within 15 miles of me, which metro lines are you nearest to? (You must also be within 15 miles.)",
                ("large",), 4, 2, None, param=15.0,
                note="Metro lines are the coloured rail lines a map app draws, so this is "
                     "decided by GTFS route_type, not by OSM.",
                ),
    QuestionDef("tentacle.zoo", "tentacle", "Tentacle", "Zoos Within 15 Miles",
                "Within 15 miles of me, which zoos are you nearest to? (You must also be within 15 miles.)",
                ("large",), 4, 2, "zoo", param=15.0),
    QuestionDef("tentacle.aquarium", "tentacle", "Tentacle", "Aquariums Within 15 Miles",
                "Within 15 miles of me, which aquariums are you nearest to? (You must also be within 15 miles.)",
                ("large",), 4, 2, "aquarium", param=15.0),
    QuestionDef("tentacle.amusement_park", "tentacle", "Tentacle", "Amusement Parks Within 15 Miles",
                "Within 15 miles of me, which amusement parks are you nearest to? (You must also be within 15 miles.)",
                ("large",), 4, 2, "amusement_park", param=15.0),
)


# Card text and casting costs are read off the card faces (www.lifack.ch/img/cards),
# which are the only place they exist — the markdown rulebook carries the *notes*
# only. `removal_rule` is plain words for the page; `quote` is verbatim rulebook and
# is present on tier 1 only, because tier 1 is the tier the rulebook itself decides.
CURSES: tuple[CurseDef, ...] = (
    # ── tier 1 · the rulebook says to remove it ───────────────────────────────
    CurseDef("bridge_troll", "Curse of the Bridge Troll", 1,
             "The seekers must ask their next question from under a bridge.",
             "Seekers must be at least S 1 / M 5 / L 30 miles from you.",
             ("asking_questions",), "bridge",
             "Remove when the map contains no bridges.",
             quote="If there are no bridges on the game map, this curse should be removed from the deck."),
    CurseDef("egg_partner", "Curse of the Egg Partner", 1,
             "The seekers must acquire an egg before asking another question. This egg is now "
             "treated as an official team member of the seekers. If any team members are abandoned "
             "or killed (defined as any crack, in the egg's case) before the end of your run, you "
             "are awarded an extra S 30 / M 45 / L 60 minutes. This curse cannot be played during "
             "the endgame.",
             "Discard two cards.",
             ("asking_questions",), "grocery",
             "A player preference, not a measurement: the rulebook removes it when you do not want "
             "to buy things during the game. The grocery count only tells you whether an egg is "
             "obtainable at all.",
             quote="If you do not want to buy items during the course of your game, or object to "
                   "this curse on ethical grounds, this curse should be removed from the deck."),
    CurseDef("impressionable_consumer", "Curse of the Impressionable Consumer", 1,
             "Seekers must enter and gain admission (if applicable) to a location or a buy a "
             "product that they saw an advertisement for before asking another question. This "
             "advertisement must be found out in the world, not on a seeker's device, and must be "
             "at least 100 feet from the product or location itself.",
             "The seekers' next question is free.",
             ("asking_questions",), "shop",
             "A player preference, not a measurement. The shop count is the secondary check: an "
             "advertisement 100 ft from the thing it advertises needs commercial density.",
             quote="If you do not want to be forced to potentially spend money to fulfill this "
                   "curse, it should be removed from the deck."),
    CurseDef("unguided_tourist", "Curse of the Unguided Tourist", 1,
             "Send the seekers an unzoomed Google Street View image from a street within 500 feet "
             "of where they are now. The shot has to be parallel to the horizon and include at "
             "least one human-built structure other than a road. Without using the internet for "
             "research, they must find what you sent them in real life before they can use "
             "transportation or ask another question. They must send a picture to the hider for "
             "verification.",
             "Seekers must be outside.",
             ("asking_questions", "taking_transit"), None,
             "Decided by a static Street View coverage table keyed on the map's country, not by "
             "OpenStreetMap. Removed in the countries the rulebook's own example (Germany) belongs to.",
             quote="If you are playing in a country or area with highly limited Google Street View "
                   "coverage (such as Germany), this curse should be removed from the deck."),

    # ── tier 2 · map-contingent by derivation, hard enough to auto-remove ─────
    CurseDef("distant_cuisine", "Curse of the Distant Cuisine", 2,
             "Find a restaurant within your zone that explicitly serves food from a specific "
             "foreign country. The seekers must visit a restaurant serving food from a country "
             "that is an equal or greater distance away before asking another question.",
             "You must be at the restaurant.",
             ("asking_questions",), "cuisine",
             "Remove when no restaurant on the map is tagged with a single foreign country's "
             "cuisine. Warn when there are fewer than five, or when only one distinct country is "
             "represented — then every qualifying restaurant is the same distance away and the "
             "curse is a formality."),
    CurseDef("lemon_phylactery", "Curse of the Lemon Phylactery", 2,
             "Before asking another question, the seekers must each find a lemon and affix it to "
             "the outermost layer of their clothes or skin. If, at any point, one of these lemons "
             "is no longer touching a seeker, you are awarded an extra S 30 / M 45 / L 60 minutes. "
             "This curse cannot be played during the endgame.",
             "Discard a powerup.",
             ("asking_questions",), "grocery",
             "Every seeker has to buy a lemon. The rulebook flags Egg Partner and Impressionable "
             "Consumer for the spending objection and is silent about this one, which is an "
             "inconsistency — group all three under one no-spending house rule."),
    CurseDef("luxury_car", "Curse of the Luxury Car", 2,
             "Take a photo of a car. The seekers must take a photo of a more expensive car before "
             "asking another question.",
             "A photo of a car.",
             ("asking_questions",), "car_street",
             "Remove only when the map has no motor-vehicle street at all. Car-free transit maps "
             "are real: Venice, Zermatt, Mackinac Island, Hydra, Giethoorn."),
    CurseDef("right_turn", "Curse of the Right Turn", 2,
             "For the next S 20 / M 40 / L 60 minutes, the seekers can only turn right at any "
             "street intersection. If, at any point, they find themselves in a dead end where they "
             "cannot continue forward or turn right for another 1,000 feet, they may do a full "
             "180. A right turn is defined as a road at any angle that veers to the right of the "
             "seekers.",
             "Discard a card.",
             (), "car_street",
             "The rulebook says outright that the curse has no effect where there are no streets, "
             "so remove it when the motor-vehicle street count is zero."),
    CurseDef("water_weight", "Curse of Water Weight", 2,
             "The seekers must acquire and carry at least 2 liters of liquid per seeker for the "
             "rest of your run. They cannot ask another question until they have acquired the "
             "liquid. The water may be distributed between seekers as they see fit. If the liquid "
             "is lost or abandoned at any point after acquisition, the hider is awarded a "
             "S 30 / M 30 / L 60 minute bonus.",
             "Seekers must be within 1,000 feet (300 m) of a body of water.",
             ("asking_questions",), "water",
             "The casting cost is a geographic gate: with no non-pool body of water on the map the "
             "curse can never be cast."),

    # ── tier 3 · map-contingent, warn only, never auto-removed ────────────────
    CurseDef("bird_guide", "Curse of the Bird Guide", 3,
             "You have one chance to film a bird for as long as possible, up to S 5 / M 10 / L 15 "
             "minutes straight. If, at any point, the bird leaves the frame, your timer is "
             "stopped. The seekers must then film a bird for the same amount of time or longer "
             "before asking another question.",
             "Film a bird.",
             ("asking_questions",), "animal_habitat",
             "Never removed. Green cover is the signal for how quickly either side finds a bird "
             "worth filming."),
    CurseDef("cairn", "Curse of the Cairn", 3,
             "You have one attempt to stack as many rocks on top of each other as you can in a "
             "freestanding tower. Each rock may only touch one other rock. Once you have added a "
             "rock to the tower, it may not be removed. Before adding another rock, the tower must "
             "stand for at least five seconds. If at any point, any rock other than the base rock "
             "touches the ground, your tower has fallen. Once your tower falls, tell the seekers "
             "how many rocks high your tower was when it last stood for five seconds. The seekers "
             "must then construct a rock tower of the same number of rocks, under the same "
             "parameters, before asking another question. If their tower falls, they must "
             "restart. The rocks must be found in nature, and both teams must disperse the "
             "rocks after building.",
             "Build a rock tower.",
             ("asking_questions",), "cairn_terrain",
             "Never removed. Loose rock is not reliably mapped, so the terrain count is a hint "
             "rather than a verdict; the rulebook only calls this curse useless at global scale."),
    CurseDef("endless_tumble", "Curse of the Endless Tumble", 3,
             "Seekers must roll a die at least 100 feet and have it land on a 5 or a 6 before they "
             "can ask another question. The die must roll the full distance, unaided, using only "
             "the momentum from the initial throw and gravity to travel the 100 feet. If the "
             "seekers accidentally hit someone with a die, you are awarded a S 10 / M 20 / L 30 "
             "minute bonus.",
             "Roll a die. If it's a 5 or a 6, this card has no effect.",
             ("asking_questions",), "tumble_ground",
             "Never removed. It needs 100 ft of open, ideally sloped, publicly accessible ground; "
             "the open-ground count says how grim that will be here."),
    CurseDef("jammed_door", "Curse of the Jammed Door", 3,
             "For the next S 0.5 / M 1 / L 3 hours, whenever the seekers want to pass through a "
             "doorway into a building, business, train, or other vehicle, they must first roll 2 "
             "dice. If they do not roll a 7 or higher, they cannot enter that space (including "
             "through other doorways.) Any given doorway can be re-attempted after "
             "S 5 / M 10 / L 15 minutes.",
             "Discard two cards.",
             (), "building",
             "Never removed — it is always satisfiable. Its bite scales with how much of the "
             "seekers' route is boardings: punishing on a bus-heavy map, weak on a walking one."),
    CurseDef("labyrinth", "Curse of the Labyrinth", 3,
             "Spend up to S 10 / M 20 / L 30 minutes drawing a solvable maze and send a photo of "
             "it to the seekers. You cannot use the internet to research maze designs. The seekers "
             "must solve the maze before asking another question.",
             "Draw a maze.",
             # The maze is the same categorical prevention Cairn, Bird Guide and Endless
             # Tumble carry, and HIDING.md line 94 says "there cannot be more than one
             # active curse preventing the seekers from asking questions or taking
             # transit" — so it has to occupy that slot.
             ("asking_questions",), None,
             "Never removed and not a geography question: it needs pen and paper, which belongs in "
             "the what-to-pack list."),
    CurseDef("mediocre_travel_agent", "Curse of the Mediocre Travel Agent", 3,
             "Choose any publicly-accessible place within S 0.25 / M 0.25 / L 0.5 miles of the "
             "seekers' current location. They cannot currently be on transit. They must go there, "
             "and spend at least S 5 / M 5 / L 10 minutes there, before asking another question. "
             "They must send you at least three photos of them enjoying their vacation, and "
             "procure an object to bring you as a souvenir. If this souvenir is lost before they "
             "can give it to you, you are awarded an extra S 30 / M 45 / L 60 minutes.",
             "Their vacation destination must be further from you than their current location.",
             ("asking_questions",), "travel_agent_stop",
             "Never removed. It fails only where the seekers are somewhere with nothing around, so "
             "the signal is the share of stations with a public destination in range."),
    CurseDef("ransom_note", "Curse of the Ransom Note", 3,
             "The next question that the seekers ask must be composed of words and letters cut out "
             "of any printed material. The question must be coherent, and include at least 5 words.",
             "Spell out “ransom note” as a ransom note (without using this card).",
             ("asking_questions",), "print_source",
             "Never removed. Both sides need printed material found in the wild plus something to "
             "cut with, which is genuinely hard in a zone with no newsstand or flyer board."),
    CurseDef("u_turn", "Curse of the U-Turn", 3,
             "The seekers must disembark their current mode of transportation at the next station "
             "(as long as that station is serviced by another form of transit in the next "
             "S 0.5 / M 0.5 / L 1 hours.)",
             "Seekers must be heading the wrong way. (Their next station is further from you than "
             "they are.)",
             (), "u_turn",
             "Decided by GTFS, not OSM: the card only bites when another route serves the next "
             "station inside 0.5/0.5/1 hours. Never removed — the escape hatch is printed on the "
             "card, not a flaw in the map."),
    CurseDef("urban_explorer", "Curse of the Urban Explorer", 3,
             "For the rest of your run, seekers cannot ask questions when they are on transit or "
             "in a transit station.",
             "Discard 2 cards.",
             ("asking_questions",), None,
             "Never removed, but it permanently kills the Transit Line matching question, which "
             "requires the seekers to be on moving transit. On a map where Transit Line is one of "
             "the few live matching questions this costs the seekers far more than two cards."),
    CurseDef("zoologist", "Curse of the Zoologist", 3,
             "Take a photo of a wild fish, bird, mammal, reptile, amphibian, or bug. The seekers "
             "must take a picture of a wild animal in the same category before asking another "
             "question.",
             "A photo of an animal.",
             ("asking_questions",), "animal_habitat",
             "Never removed. The hider picks the category, so they will pick bird or bug; zoos and "
             "aquariums explicitly do not count."),

    # ── tier 4 · not map-contingent at all ───────────────────────────────────
    CurseDef("drained_brain", "Curse of the Drained Brain", 4,
             "Choose three questions in different categories. The seekers cannot ask those "
             "questions for the rest of your run.",
             "Discard your hand.",
             (), None,
             "Not map-contingent. It cannot break on any map, because the radar category is never "
             "fully dead — the Choose radar guarantees at least one live category."),
    CurseDef("gamblers_feet", "Curse of the Gambler's Feet", 4,
             "For the next S 20 / M 40 / L 60 minutes, seekers must roll a die before they take "
             "any steps in any direction. They may take that many steps before rolling again.",
             "Roll a die. If it's an even number, this curse has no effect.",
             (), None,
             "Not map-contingent."),
    CurseDef("hidden_hangman", "Curse of the Hidden Hangman", 4,
             "Before asking another question or boarding another form of transportation, seekers "
             "must beat the hider in a game of hangman. To play, the hider chooses a 5 letter "
             "word, and the game ends after either a correct word guess or 7 wrong letter guesses "
             "(head, body, two arms, two legs, and a hat). The hider must respond to all queries "
             "within 30 seconds. The seekers cannot challenge the hider for 10 minutes after a "
             "loss. After S 1 / M 2 / L 3 losses, the seekers must wait 10 more minutes and then "
             "the curse is cleared.",
             "Discard 2 cards.",
             ("asking_questions", "taking_transit"), None,
             "Not map-contingent."),
    CurseDef("overflowing_chalice", "Curse of the Overflowing Chalice", 4,
             "For the next three questions, you may draw (not keep) an additional card when "
             "drawing from the hider deck.",
             "Discard a card.",
             (), None,
             "Not map-contingent. Its note is the only place the rulebook independently restates "
             "the base draw/keep numbers, and they agree with SEEKING.md exactly."),
    CurseDef("spotty_memory", "Curse of Spotty Memory", 4,
             "For the rest of your run, one random category of questions will be disabled at all "
             "times. After this curse is played, seekers must roll a die to determine the category "
             "of questions to be disabled. This category remains disabled until the next question "
             "is asked, at which point a die is rolled again to choose a new category. The same "
             "category can be disabled multiple times in a row.",
             "Discard a time bonus.",
             (), None,
             "Not map-contingent, but note that a SMALL game has only five categories, so a six is "
             "a reroll — and that the curse hurts most on a map where only two categories are any "
             "good."),
)


# ── shape assertions, run at import ───────────────────────────────────────────
assert len(QUESTIONS) == 80, f"question catalogue is {len(QUESTIONS)}, expected 80"
assert len({q.id for q in QUESTIONS}) == 80, "duplicate question id"
assert len(CURSES) == 24, f"curse deck is {len(CURSES)}, expected 24"
assert len({c.id for c in CURSES}) == 24, "duplicate curse id"
assert sorted(collections.Counter(q.category for q in QUESTIONS).items()) == [
    ("matching", 20), ("measuring", 20), ("photo", 18), ("radar", 10),
    ("tentacle", 8), ("thermometer", 4)], "category counts do not match the rulebook"
assert sorted(collections.Counter(c.tier for c in CURSES).items()) == [
    (1, 4), (2, 5), (3, 10), (4, 5)], "curse tier counts do not match rules.md §4"
for _size_name, _expected in (("small", 58), ("medium", 71), ("large", 80)):
    _got = sum(1 for q in QUESTIONS if _size_name in q.sizes)
    assert _got == _expected, f"{_size_name} catalogue is {_got}, expected {_expected}"
    assert SIZES[_size_name].catalogue_size == _expected
del _size_name, _expected, _got
assert not any(q.category == "tentacle" and "small" in q.sizes for q in QUESTIONS), \
    "SMALL games drop the tentacle category (SEEKING.md, and the Spotty Memory note)"


# ═══════════════════════════════════════════════════════════════════════════════
# S3 · INTERPRETATIONS — everywhere the rulebook is silent and this code decides
# ═══════════════════════════════════════════════════════════════════════════════
#
# Every entry here is printed verbatim in §Provenance and is the reason a page may
# say "interpretation" next to a number. Adding a judgement call to the engine
# without adding a row here is a bug.

_S3_INTERPRETATIONS: tuple[dict[str, Any], ...] = (
    {"id": "in_border_rule", "affects": ["every count on this page"],
     "text": "The rulebook says that locations outside the map's boundaries must be treated as "
             "not existing, so every instance count here is measured inside the drawn border. "
             "The border therefore decides most of this audit, which is why questions that would "
             "change status under a slightly larger border are flagged as borderline."},
    {"id": "map_border_derivation", "affects": ["border", "every instance count"],
     "text": "The border is the bounding box of the in-map stops padded by one hiding-zone "
             "radius, so that every legal zone lies wholly inside the map. The rulebook leaves "
             "borders entirely to the players; this is a default, not a rule."},
    {"id": "osm_is_not_google_maps", "affects": ["all OSM counts", "B", "E", "A"],
     "text": "Every matching, measuring and tentacle question is defined by what a mapping app "
             "categorises, with a five-Google-Reviews legitimacy test. This generator reads "
             "OpenStreetMap, which has no reviews, tags things the apps do not surface and misses "
             "chains the apps have. Counts here are a lower bound and the exact selector is "
             "printed beside each one so a player can check it."},
    {"id": "matching_quality_is_binary", "affects": ["every matching question's quality"],
     "text": "A matching question's answer is yes or no, so its quality is scored as the balance "
             "of that binary split — the chance that a random pair of zones answers the same way "
             "— rather than as the entropy of the underlying nearest-feature partition. A "
             "question whose feature set is so fine that every zone has its own nearest instance "
             "almost always answers no, and eliminates one zone; the binary form says so and the "
             "entropy form does not."},
    {"id": "measuring_ties_are_their_own_answer", "affects": ["every measuring question"],
     "text": "The rulebook offers closer and further and nothing else, so it does not say what a "
             "hider sitting exactly as far from the feature as the seeker should answer. Here "
             "that zone is treated as answering neither, agreeing only with the other zones at "
             "the same distance — which keeps the survival numbers and the concrete answers "
             "printed in the dossiers describing the same game."},
    {"id": "measuring_quality_is_narrowing", "affects": ["every measuring question's quality"],
     "text": "A measuring question always splits the map close to evenly, so scoring the balance "
             "of its split would rate every one of them perfect. Its quality is scored as how "
             "much of the map the answer removes on average — one minus the mean survival, "
             "renormalised so a clean halving is 1.0."},
    {"id": "thermometer_beyond_map", "affects": ["thermometer.3mi", "thermometer.10mi",
                                                 "thermometer.50mi"],
     "text": "The rulebook does not say what happens when the thermometer distance exceeds the "
             "map. This generator calls a thermometer dead above the map's straight-line "
             "diameter and degenerate above 0.7 of it, because beyond that the seekers cannot "
             "travel the leg without leaving the map."},
    {"id": "thermometer_bearings", "affects": ["every thermometer question"],
     "text": "Nothing constrains which direction the seekers travel, so the thermometer's "
             "decision boundary is averaged over eight fixed bearings from each sampled seeker "
             "position."},
    {"id": "choose_radar_radius", "affects": ["radar.choose"],
     "text": "The Choose radar lets the seekers name any distance, which is why the radar "
             "category can never be fully dead. It is modelled at the distance that splits this "
             "particular map most evenly — the median distance between two zones."},
    {"id": "transit_line_zone_set", "affects": ["matching.transit_line"],
     "text": "Your nearest transit line is modelled as the set of routes reaching your zone "
             "circle, and two zones answer yes when those sets are identical."},
    {"id": "street_singleton_partition", "affects": ["matching.street_or_path"],
     "text": "Street geometry is counted map-wide but not downloaded, so the nearest-street "
             "partition is modelled as one class per zone. That is the honest worst case for the "
             "seekers: the answer is almost always no, and a no removes exactly one zone."},
    {"id": "admin_border_distance_proxy", "affects": ["measuring.admin_1_border",
                                                      "measuring.admin_2_border"],
     "text": "Administrative boundary geometry is not downloaded. Distance to a division border "
             "is approximated by the distance to the nearest zone that sits in a different "
             "division, which is an upper bound on the true distance."},
    {"id": "sea_level_needs_dem", "affects": ["measuring.sea_level"],
     "text": "Elevation needs a digital elevation model, which this pipeline deliberately does "
             "not carry for one question. Sea Level is reported as not evaluated rather than "
             "guessed; on a map with real terrain it is probably functional."},
    {"id": "coastline_definition", "affects": ["measuring.coastline", "matching.landmass"],
     "text": "OpenStreetMap tags natural=coastline on ocean and sea shorelines only, so a great "
             "lake carries none. This generator treats the shore of any water body larger than the "
             "game map as a coast and derives shore segments from it, because such a shore bounds "
             "the map exactly the way an ocean coast does. A shore derived this way is counted for "
             "the coastline question but is not treated as splitting the map into separate "
             "landmasses. The rulebook's one-mile-estuary clause still has no OSM equivalent."},
    {"id": "metro_line_definition", "affects": ["tentacle.metro_line"],
     "text": "Metro lines are the coloured lines a map app draws, so this question is restricted "
             "to rail route types. On a bus-only feed it is dead. Where rail exists, a line's "
             "position is approximated by the zones its route serves."},
    {"id": "photo_null_is_not_free", "affects": ["every photo question"],
     "text": "“I cannot answer the question” is a real answer: it pays the hider a card and it "
             "still leaks one bit. Low coverage is therefore scored as weak, never dead, and the "
             "coverage share is printed."},
    {"id": "photo_always_answerable", "affects": ["photo.you", "photo.the_sky",
                                                  "photo.tallest_structure_in_your_current_sightline",
                                                  "photo.widest_street",
                                                  "photo.trace_nearest_street_path",
                                                  "photo.half_mile_of_streets_traced"],
     "text": "Six photo questions are short-circuited to answerable everywhere, so as locational "
             "questions they are degenerate — but the image itself can still show the seekers a "
             "landmark, a shadow or a sky no model can score. They are scored as zero-information "
             "and flagged. Four of them really are answerable from anywhere on Earth: You, The "
             "Sky, Tallest Structure in Your Current Sightline and Widest Street. The other two "
             "are a judgement call. The rulebook conditions Trace Nearest Street/Path on "
             "“Street/path must be visible on mapping app” and ½ Mile of Streets Traced on "
             "“Streets must appear on mapping app”, plus a continuous five-turn route with no "
             "doubling back — and street geometry is counted map-wide but never downloaded, so "
             "neither condition can be checked here. They are assumed answerable rather than "
             "reported as unknown, which overstates them on a zone whose streets a mapping app "
             "does not draw."},
    {"id": "tentacle_double_radius", "affects": ["every tentacle question"],
     "text": "The two distance blanks on a tentacle card are always the same number, and both "
             "reach tests are anchored on the seeker, not on the hider."},
    {"id": "seeker_positions_are_zones", "affects": ["every survival number"],
     "text": "Seekers stand at transit stations, so the seeker sample is drawn from the candidate "
             "zone set itself. Answers are computed from station icons, not from anywhere inside "
             "the zone circle, which is the rulebook's own measurement rule."},
    {"id": "funnel_reference_seeker", "affects": ["question_order", "question_funnel"],
     "text": "The narrowing funnel is computed for a seeker standing at the zone closest to the "
             "map's centre of mass. A survival number averages over every seeker position; a "
             "funnel has to pick one, and the centre is the least arbitrary choice."},
    {"id": "reachability_one_way", "affects": ["R1", "S2"],
     "text": "The rulebook's reachability constraint is one-way and applies to the hider only: "
             "you must be able to get there inside the hiding period. Nothing requires you to be "
             "able to get back, so a zone that strands the seekers is reported as a tactical fact "
             "and never scored."},
    {"id": "one_route_cap_is_stop_share", "affects": ["CAP_ONE_ROUTE"],
     "text": "The one-route cap is evaluated as the share of served stops a single route reaches, "
             "because per-route trip totals are not part of the metric table. A route touching "
             "nine stops in ten is a one-dimensional map either way."},
    {"id": "legal_spots_are_a_shortlist", "affects": ["E1", "E2", "E3"],
     "text": "OpenStreetMap does not know whether a plaza is locked at night, so the rulebook's "
             "“publicly accessible during all game hours” test cannot be automated. Endgame spot "
             "counts are a shortlist for a human to check, never a verdict."},
)


# ── subject resolution: what data answers each question ───────────────────────
#
# `geodata_ref` on `QuestionDef` names a GEO_CATEGORIES key when one exists. These
# are the questions whose subject is something else — GTFS, an admin ladder, a
# boundary line, or a datum this pipeline does not carry.

_S3_SPECIAL_SUBJECT: dict[str, tuple[str, Any]] = {
    "matching.transit_line": ("gtfs_transit_line", None),
    "matching.station_name_length": ("gtfs_name_length", None),
    "matching.street_or_path": ("street", None),
    "matching.landmass": ("landmass", None),
    "matching.admin_1": ("admin", 1),
    "matching.admin_2": ("admin", 2),
    "matching.admin_3": ("admin", 3),
    "matching.admin_4": ("admin", 4),
    "measuring.international_border": ("border_line", 0),
    "measuring.admin_1_border": ("border_line", 1),
    "measuring.admin_2_border": ("border_line", 2),
    "measuring.sea_level": ("dem", None),
    "tentacle.metro_line": ("gtfs_metro_line", None),
}

# Photo questions this engine treats as answerable from anywhere.
#
# The first four genuinely are. The last two are a judgement call, disclosed as one in
# the `photo_always_answerable` interpretation: the rulebook conditions both on the
# mapping app ("Street/path must be visible on mapping app", "Streets must appear on
# mapping app"), and this engine never checks that the zone has such a street. Keep the
# two lists in step — a judgement call the interpretation table does not carry is a bug.
_S3_ALWAYS_PHOTOS = frozenset({
    "photo.you",
    "photo.the_sky",
    "photo.tallest_structure_in_your_current_sightline",
    "photo.widest_street",
    "photo.trace_nearest_street_path",
    "photo.half_mile_of_streets_traced",
})

# Photo questions answered by a per-zone icon count: id → (category, minimum).
_S3_PHOTO_COUNT: dict[str, tuple[str, int]] = {
    "photo.any_building_visible_from_transit_station": ("building", 1),
    "photo.tallest_building_visible_from_transit_station": ("building", 1),
    "photo.2_buildings": ("building", 2),
    "photo.5_buildings": ("building", 5),
    "photo.restaurant_interior": ("restaurant", 1),
    "photo.grocery_store_aisle": ("grocery", 1),
    "photo.place_of_worship": ("place_of_worship", 1),
}

# Photo questions answered by a polygon intersecting the zone circle.
_S3_PHOTO_POLYGON: dict[str, str] = {
    "photo.park": "park",
    "photo.biggest_body_of_water": "water",
}

_S3_ORDINAL_WORD = {0: "international", 1: "1st", 2: "2nd", 3: "3rd", 4: "4th"}

# Eight fixed bearings, in radians, for the thermometer decision boundary.
_S3_BEARINGS: tuple[tuple[float, float], ...] = tuple(
    (math.cos(math.radians(90.0 - b)), math.sin(math.radians(90.0 - b)))
    for b in (0, 45, 90, 135, 180, 225, 270, 315)
)

# Verdict bands, high to low (scoring.md §1.9).
_S3_BANDS: tuple[tuple[float, str, str], ...] = (
    (80.0, "Excellent map", "Play it as written; no house rules required."),
    (65.0, "Strong map", "A few house rules and it plays well."),
    (50.0, "Playable with house rules", "The house rules below are required, not optional."),
    (35.0, "Marginal", "Expect substantial modification: shrink the map or change the game size."),
    (0.0, "Not recommended as a transit game", "Consider the rulebook's cars or on-foot variant."),
)

# Module-level memos. Keyed on the zone universe, which is fixed for a whole run, so
# `audit_questions` (which needs a signature to score quality) and `build_report`
# (which needs the same signature again) never compute one twice.
_S3_MEMO: dict[Any, Any] = {}


def _s3_universe_key(zones: Sequence[Zone]) -> tuple[Any, ...]:
    """A stable identity for the zone universe. One run has exactly one."""
    if not zones:
        return ("empty",)
    return (len(zones), zones[0].zone_id, zones[-1].zone_id)


def _s3_proj_from_zones(zones: Sequence[Zone]) -> Projection:
    """Recover the run's projection from a zone's (lat, lon) and (x, y).

    `audit_questions` is not handed the projection but needs one to reuse
    `answer_signature`. `Projection` is an exactly invertible affine map, so the
    reference point can be read straight back off any zone.
    """
    if not zones:
        return Projection(0.0, 0.0)
    z = zones[0]
    lat0 = z.lat - z.y / 111_132.0
    m_lon = 111_320.0 * math.cos(math.radians(lat0))
    lon0 = z.lon - (z.x / m_lon if m_lon else 0.0)
    return Projection(lat0=lat0, lon0=lon0)


def _s3_seeker_sample(zones: Sequence[Zone]) -> list[int]:
    """The seeker index sample `S`, identical to the one `build_report` builds."""
    n = len(zones)
    if n <= SURV_FULL_UNIVERSE_MAX:
        return list(range(n))
    stride = math.ceil(n / SEEKER_SAMPLE_CAP)
    return list(range(0, n, stride))[:SEEKER_SAMPLE_CAP]


def _s3_zone_seeker_dists(zones: Sequence[Zone], seekers: Sequence[int]) -> list[list[float]]:
    """`d[zone_index][seeker_position]` in metres, computed once per run."""
    key = ("zsd", _s3_universe_key(zones), tuple(seekers[:1]), len(seekers))
    hit = _S3_MEMO.get(key)
    if hit is not None:
        return hit
    sx = [zones[s].x for s in seekers]
    sy = [zones[s].y for s in seekers]
    out: list[list[float]] = []
    for z in zones:
        zx, zy = z.x, z.y
        out.append([math.hypot(zx - ax, zy - ay) for ax, ay in zip(sx, sy)])
    _S3_MEMO[key] = out
    return out


def _s3_choose_radius_m(zones: Sequence[Zone]) -> float:
    """The radius the Choose radar is modelled at: the median distance between zones.

    That is the radius which, averaged over seeker positions, splits this map most
    evenly — the strongest single radar the seekers can name here.
    """
    key = ("choose", _s3_universe_key(zones))
    hit = _S3_MEMO.get(key)
    if hit is not None:
        return hit
    n = len(zones)
    if n < 2:
        return QUARTER_MILE_M
    stride = 1 if n <= 400 else math.ceil(n / 400)
    sample = [zones[i] for i in range(0, n, stride)]
    dists: list[float] = []
    for i in range(len(sample)):
        for j in range(i + 1, len(sample)):
            dists.append(math.hypot(sample[i].x - sample[j].x, sample[i].y - sample[j].y))
    value = quantile(dists, 0.5) if dists else QUARTER_MILE_M
    _S3_MEMO[key] = value
    return value


def _s3_join(items: Sequence[str]) -> str:
    """"A", "A and B", "A, B and C" — for lists short enough to print in full."""
    rows = list(items)
    if not rows:
        return ""
    if len(rows) == 1:
        return rows[0]
    return ", ".join(rows[:-1]) + " and " + rows[-1]


def _s3_geo_label(category: str) -> str:
    """The human label for a GEO_CATEGORIES key."""
    for c in GEO_CATEGORIES:
        if c.key == category:
            return c.label
    return category.replace("_", " ")


# English plurals the naive "+ s" rule gets wrong. Small, explicit, and only for the
# category labels this section actually prints.
_S3_PLURAL: dict[str, str] = {
    "library": "libraries",
    "water": "bodies of water",
    "high_speed_rail": "high-speed rail lines",
    "street": "street and path ways",
    "commercial_airport": "commercial airports",
    "foreign_consulate": "foreign consulates",
    "rail_station": "rail stations",
}


def _s3_noun(category: str | None, count: int) -> str:
    """The lower-case noun for a category, singular or plural to match `count`."""
    key = category or ""
    singular = _s3_geo_label(key).lower()
    if count == 1:
        return singular
    return _S3_PLURAL.get(key, singular + "s")


def _s3_selector_for(question: QuestionDef) -> str:
    """The exact Overpass selector behind a question, or a plain-words GTFS note."""
    kind, arg = _s3_subject(question)
    if kind in ("osm_nearest", "osm_distance", "osm_tentacle", "landmass", "street"):
        cat = question.geodata_ref
        for c in GEO_CATEGORIES:
            if c.key == cat:
                return c.selector.replace("{{bbox}}", "BBOX") or CAR_STREET_SELECTOR.replace(
                    "{{bbox}}", "BBOX")
        return f"OpenStreetMap category `{cat}` (not queried on this run)"
    if kind == "gtfs_transit_line":
        return "GTFS: the set of routes serving any stop inside the zone circle"
    if kind == "gtfs_name_length":
        return "GTFS: character count of the clustered station name"
    if kind == "gtfs_metro_line":
        return "GTFS: routes whose route_type is one of 0, 1, 2, 5, 7, 11, 12 (rail-like)"
    if kind == "admin":
        return f'relation["boundary"="administrative"] containing each zone centre, {arg} ordinal'
    if kind == "border_line":
        return ('relation["boundary"="administrative"]["admin_level"=N](BBOX); way(r); out count; '
                "— does a boundary line cross the map")
    if kind == "dem":
        return "elevation — needs a digital elevation model, which this pipeline does not carry"
    if kind == "geom":
        return "geometry only: straight-line distance between station icons"
    if kind == "photo":
        cat = _S3_PHOTO_COUNT.get(question.id, _S3_PHOTO_POLYGON.get(question.id, ""))
        if isinstance(cat, tuple):
            cat = cat[0]
        if question.id in _S3_ALWAYS_PHOTOS:
            return "no data needed: answerable from anywhere"
        if cat:
            for c in GEO_CATEGORIES:
                if c.key == cat:
                    return c.selector.replace("{{bbox}}", "BBOX")
        if question.id == "photo.tree":
            return 'node["natural"="tree"](BBOX); nwr["landuse"~"^(forest|grass|meadow)$"](BBOX);'
        if question.id == "photo.train_platform":
            return 'nwr["railway"="platform"](BBOX); nwr["public_transport"="platform"](BBOX);'
        if question.id == "photo.tallest_mountain_visible_from_transit_station":
            return 'node["natural"~"^(peak|volcano)$"]["name"](BBOX);'
    return "—"


def _s3_subject(question: QuestionDef) -> tuple[str, Any]:
    """`(kind, argument)` naming the data that answers this question."""
    special = _S3_SPECIAL_SUBJECT.get(question.id)
    if special is not None:
        return special
    if question.category == "photo":
        return ("photo", question.id)
    if question.category in ("radar", "thermometer"):
        return ("geom", None)
    if question.category == "matching":
        return ("osm_nearest", question.geodata_ref)
    if question.category == "measuring":
        return ("osm_distance", question.geodata_ref)
    if question.category == "tentacle":
        return ("osm_tentacle", question.geodata_ref)
    return ("unknown", None)


def _s3_in_border_pois(geo: GeoData, category: str | None,
                       bbox: tuple[float, float, float, float]) -> tuple[list[Poi], bool]:
    """`(features whose icon is inside the border, was this category queried)`.

    The in-border rule is applied to the **representative point**, not to the raw
    Overpass result: Overpass returns anything intersecting the bbox, so a large
    polygon straddling the edge comes back with its icon outside the map. That is
    exactly the commercial-airport case the border sensitivity report is about.
    """
    if not geo.available or not category:
        return ([], False)
    pois = geo.pois.get(category)
    if pois is None:
        return ([], False)
    return ([p for p in pois if bbox_contains(bbox, p.lat, p.lon)], True)


def _s3_margin_count(geo: GeoData, category: str | None,
                     bbox: tuple[float, float, float, float], radius_m: float) -> int:
    """How many features of a category sit inside a *modestly* larger border.

    "Modestly" is two zone radii, or 250 m, whichever is larger — small enough that
    a player would call it the same map, large enough to catch an icon that fell a
    few metres outside a padded edge.
    """
    if not geo.available or not category:
        return 0
    pois = geo.pois.get(category)
    if pois is None:
        return 0
    margin = max(2.0 * radius_m, 250.0)
    big = bbox_expand(bbox, margin)
    return sum(1 for p in pois if bbox_contains(big, p.lat, p.lon))


def _s3_blocks(values: Sequence[Any]) -> dict[Any, int]:
    """Signature value → number of zones carrying it. Sorted-stable by construction."""
    counter: dict[Any, int] = {}
    for v in values:
        counter[v] = counter.get(v, 0) + 1
    return counter


def _s3_binary_quality(p_yes: float) -> float:
    """Quality of a yes/no question: a 50/50 split scores 1.0, a constant answer 0.0."""
    p = min(1.0, max(0.0, p_yes))
    return min(p, 1.0 - p) / 0.5


def _s3_entropy_quality(blocks: Sequence[int], n: int) -> float:
    """Quality of a multi-class answer: Shannon entropy over `log2(realised classes)`."""
    live = [b for b in blocks if b > 0]
    if len(live) < 2 or n <= 0:
        return 0.0
    h = 0.0
    for b in live:
        p = b / n
        h -= p * math.log2(p)
    return min(1.0, h / math.log2(len(live)))


def catalogue_for(size: GameSize) -> list[QuestionDef]:
    """The question catalogue for one game size: 58 / 71 / 80 questions.

    SMALL drops the **tentacle** category (confirmed twice in the rulebook — the
    tentacle section says so outright, and the Spotty Memory note says a d6 roll of
    six is a reroll "for small-sized games, which only include five categories").
    """
    rows = [q for q in QUESTIONS if size.name in q.sizes]
    if len(rows) != size.catalogue_size:  # pragma: no cover — the import assertions cover it
        raise AssertionError(f"{size.name} catalogue is {len(rows)}, expected {size.catalogue_size}")
    return rows


# ═══════════════════════════════════════════════════════════════════════════════
# S3 · ANSWER SIGNATURES
# ═══════════════════════════════════════════════════════════════════════════════


def _s3_nearest_other_label_m(zones: Sequence[Zone], labels: Sequence[Any]) -> list[float]:
    """Distance from each zone to the nearest zone carrying a *different* label.

    An x-sweep, not an O(n²) scan: sort by x, walk outward from each zone and stop
    as soon as the horizontal gap alone exceeds the best distance found. This is the
    proxy behind the administrative-border measuring questions, and it is an upper
    bound on the true distance to the boundary line.
    """
    n = len(zones)
    inf = float("inf")
    if n < 2:
        return [inf] * n
    order = sorted(range(n), key=lambda i: (zones[i].x, zones[i].y, zones[i].zone_id))
    xs = [zones[i].x for i in order]
    ys = [zones[i].y for i in order]
    best = [inf] * n
    for pos in range(n):
        i = order[pos]
        mine = labels[i]
        b = inf
        for step in (1, -1):
            j = pos + step
            while 0 <= j < n:
                if abs(xs[j] - xs[pos]) >= b:
                    break
                if labels[order[j]] != mine:
                    d = math.hypot(xs[j] - xs[pos], ys[j] - ys[pos])
                    if d < b:
                        b = d
                j += step
        best[i] = b
    return best


def _s3_tentacle_features(question: QuestionDef, zones: Sequence[Zone], geo: GeoData,
                          gtfs_facts: dict[str, Any],
                          proj: Projection) -> tuple[tuple[str, tuple[tuple[float, float], ...]], ...]:
    """The candidate set a tentacle question names, as `(label, points)` pairs.

    A point feature carries one point. A metro line carries the projected positions
    of the zones its route serves, capped at 64 by a fixed stride — a line is not a
    point and its distance is the distance to the nearest part of it.
    """
    kind, _arg = _s3_subject(question)
    if kind == "gtfs_metro_line":
        rail = set(gtfs_facts.get("metro_route_ids") or ())
        by_route: dict[str, list[tuple[float, float]]] = {}
        for z in zones:
            for rid in z.route_ids:
                if rid in rail:
                    by_route.setdefault(rid, []).append((z.x, z.y))
        routes = gtfs_facts.get("routes") or {}
        out: list[tuple[str, tuple[tuple[float, float], ...]]] = []
        for rid in sorted(by_route):
            pts = by_route[rid]
            stride = max(1, math.ceil(len(pts) / 64))
            label = (routes.get(rid) or {}).get("label") or rid
            out.append((str(label), tuple(pts[::stride])))
        return tuple(out)
    pois, _queried = _s3_in_border_pois(geo, question.geodata_ref, geo.bbox)
    return tuple(
        (p.name or _s3_geo_label(question.geodata_ref or ""), (proj.xy(p.lat, p.lon),))
        for p in pois
    )


def _s3_photo_answer(question_id: str, zone: Zone, geo: GeoData,
                     gtfs_facts: dict[str, Any]) -> bool | None:
    """Can the hider in this zone answer this photo question? `None` = not evaluable."""
    if question_id in _S3_ALWAYS_PHOTOS:
        return True
    if not geo.available:
        return None
    inv = geo.zone_inventory.get(zone.zone_id) or {}
    hits = geo.zone_polygon_hits.get(zone.zone_id) or {}

    count_rule = _S3_PHOTO_COUNT.get(question_id)
    if count_rule is not None:
        category, minimum = count_rule
        if category not in inv:
            return None
        return inv[category] >= minimum

    polygon_rule = _S3_PHOTO_POLYGON.get(question_id)
    if polygon_rule is not None:
        if polygon_rule not in hits:
            return None
        return bool(hits[polygon_rule])

    if question_id == "photo.tree":
        if "tree" not in inv and "green" not in inv and "park" not in hits:
            return None
        return bool(inv.get("tree", 0) or inv.get("green", 0) or hits.get("park"))
    if question_id == "photo.train_platform":
        # OSM tags public_transport=platform on bus stops too, so the platform count
        # alone would call every bus shelter a train platform. The gate is the feed's
        # own route types: no rail mode, no train platform.
        if not gtfs_facts.get("has_rail"):
            return False
        if "platform" not in inv:
            return None
        return inv["platform"] >= 1
    if question_id == "photo.tallest_mountain_visible_from_transit_station":
        if "mountain" not in geo.counts:
            return None
        return geo.counts.get("mountain", 0) > 0
    return None


def answer_signature(question: QuestionDef, zones: Sequence[Zone], geo: GeoData,
                     gtfs_facts: dict[str, Any], proj: Projection) -> list[Any]:
    """The per-zone answer signature for one question, in `zones` order.

    Seeker-independent questions (the photo set) return the answer itself. Seeker-
    dependent ones return the *invariant* the answer is computed from — the nearest-
    feature class for matching, the distance to the nearest instance for measuring,
    the projected position for radar and thermometer, and position-plus-candidate-set
    for tentacles — so `survival_fractions` can use the closed forms instead of an
    O(n²·|S|) pairwise computation.

    A `None` entry means "this zone cannot answer": the question is dead there. The
    result is memoised on the zone universe, because `audit_questions` needs a
    signature to score quality and `build_report` asks for the same one again.
    """
    key = ("sig", question.id, _s3_universe_key(zones))
    hit = _S3_MEMO.get(key)
    if hit is not None:
        return hit
    sig = _s3_build_signature(question, zones, geo, gtfs_facts, proj)
    _S3_MEMO[key] = sig
    return sig


def _s3_build_signature(question: QuestionDef, zones: Sequence[Zone], geo: GeoData,
                        gtfs_facts: dict[str, Any], proj: Projection) -> list[Any]:
    n = len(zones)
    kind, arg = _s3_subject(question)

    if kind == "geom":
        return [(z.x, z.y) for z in zones]

    if kind == "osm_tentacle" or kind == "gtfs_metro_line":
        feats = _s3_tentacle_features(question, zones, geo, gtfs_facts, proj)
        return [(z.x, z.y, feats) for z in zones]

    if kind == "photo":
        return [_s3_photo_answer(question.id, z, geo, gtfs_facts) for z in zones]

    if kind == "gtfs_transit_line":
        by_zone = gtfs_facts.get("routes_by_zone") or {}
        return [tuple(sorted(by_zone.get(z.zone_id) or z.route_ids)) or None for z in zones]

    if kind == "gtfs_name_length":
        lengths = gtfs_facts.get("station_name_lengths") or {}
        return [lengths.get(z.zone_id, len(z.name)) for z in zones]

    if kind == "street":
        # One class per zone: streets are counted map-wide but not downloaded, so the
        # honest model is that your nearest street is your own.
        return [("street", z.zone_id) for z in zones]

    if kind == "landmass":
        pois, queried = _s3_in_border_pois(geo, "coastline", geo.bbox)
        if not queried:
            return [None] * n
        if not pois:
            # No coastline inside the border ⇒ the whole map is one landmass.
            return ["landmass:1"] * n
        return [None] * n            # assembling real landmasses is out of scope

    if kind == "admin":
        per_zone = geo.admin.per_zone or {}
        if geo.admin.ordinals.get(arg) is None:
            return [None] * n
        return [(per_zone.get(z.zone_id) or {}).get(arg) for z in zones]

    if kind == "border_line":
        if not geo.admin.border_levels.get(arg, False):
            return [None] * n
        ordinal = 1 if arg == 0 else arg
        per_zone = geo.admin.per_zone or {}
        labels = [(per_zone.get(z.zone_id) or {}).get(ordinal) for z in zones]
        if len({lab for lab in labels if lab}) < 2:
            return [None] * n        # the line crosses the map, but no zone is on the far side
        dists = _s3_nearest_other_label_m(zones, labels)
        return [None if not math.isfinite(d) else rhu(d / 2.0, 1) for d in dists]

    if kind == "dem":
        return [None] * n

    if kind == "osm_nearest":
        pois, queried = _s3_in_border_pois(geo, question.geodata_ref, geo.bbox)
        if not queried or not pois:
            return [None] * n
        pts = [proj.xy(p.lat, p.lon) for p in pois]
        out: list[Any] = []
        for z in zones:
            best_i, best_d = 0, float("inf")
            for i, (px, py) in enumerate(pts):
                d = (z.x - px) ** 2 + (z.y - py) ** 2
                if d < best_d:
                    best_d, best_i = d, i
            out.append(best_i)
        return out

    if kind == "osm_distance":
        pois, queried = _s3_in_border_pois(geo, question.geodata_ref, geo.bbox)
        if not queried or not pois:
            return [None] * n
        pts = [proj.xy(p.lat, p.lon) for p in pois]
        out = []
        for z in zones:
            best_d = float("inf")
            for px, py in pts:
                d = (z.x - px) ** 2 + (z.y - py) ** 2
                if d < best_d:
                    best_d = d
            out.append(rhu(math.sqrt(best_d), 1))
        return out

    return [None] * n


# ═══════════════════════════════════════════════════════════════════════════════
# S3 · SURVIVAL — one definition, six closed forms
# ═══════════════════════════════════════════════════════════════════════════════


def _s3_radius_m(question: QuestionDef, zones: Sequence[Zone]) -> float:
    """The radar radius, in metres. `radar.choose` resolves to this map's own median."""
    if question.param is None:
        return _s3_choose_radius_m(zones)
    return question.param * M_PER_MILE


def survival_fractions(question: QuestionDef, signature: Sequence[Any],
                       zones: Sequence[Zone], seekers: Sequence[int]) -> list[float]:
    """`surv(q, z)` for every zone — the hider's anonymity under one question.

        surv(q, z) = (1/|S|) · Σ_s |{z' : a_q(z', s) == a_q(z, s)}| / n

    `surv = 1` means the question never separates you from anyone; `surv = 1/n` means
    it identifies you outright. One definition for all six categories, none of them
    computed pairwise:

      * matching    — from the nearest-feature class sizes and the seeker sample's
        distribution across them, in closed form.
      * measuring   — prefix sums over distance ranks; a zone at exactly the
        seeker's distance answers neither closer nor further and forms its own class.
      * radar       — `(1/|S|) Σ_s [k_s if within else n − k_s] / n`.
      * thermometer — the perpendicular bisector of the seeker's leg, averaged over
        eight fixed bearings (an interpretation: the rulebook does not constrain the
        seekers' direction).
      * tentacle    — `(in_reach, nearest candidate)` with **both** reach tests
        anchored on the seeker.
      * photo       — seeker-independent: `surv = block_size / n`.
    """
    n = len(zones)
    if n == 0:
        return []
    if not seekers:
        return [1.0] * n
    cat = question.category
    if cat == "matching":
        return _s3_surv_matching(signature, n, seekers)
    if cat == "measuring":
        return _s3_surv_measuring(signature, n, seekers)
    if cat == "radar":
        return _s3_surv_radar(question, zones, n, seekers)
    if cat == "thermometer":
        return _s3_surv_thermometer(question, zones, n, seekers)
    if cat == "tentacle":
        return _s3_surv_tentacle(question, signature, zones, n, seekers)
    if cat == "photo":
        blocks = _s3_blocks(signature)
        return [blocks[v] / n for v in signature]
    return [1.0] * n


def _s3_surv_matching(signature: Sequence[Any], n: int, seekers: Sequence[int]) -> list[float]:
    """Closed form for a same-or-different question over equality classes.

    With class sizes `c_j`, seeker counts `s_j` and `|S| = Σ s_j`, a seeker in class
    `j` answering "no" agrees with every zone outside `j`, and answering "yes" agrees
    with every zone inside it. Collecting terms gives
    `surv_i = [T + s_i·(2c_i − n)] / (|S|·n)` with `T = Σ_j s_j·(n − c_j)`, so the
    whole map costs one pass instead of |S|·n comparisons.
    """
    blocks = _s3_blocks(signature)
    seeker_counts: dict[Any, int] = {}
    for s in seekers:
        v = signature[s]
        seeker_counts[v] = seeker_counts.get(v, 0) + 1
    total_seekers = len(seekers)
    T = 0.0
    for v in sorted(seeker_counts, key=_s3_sort_key):
        T += seeker_counts[v] * (n - blocks.get(v, 0))
    denom = total_seekers * n
    out = []
    for v in signature:
        c = blocks.get(v, 0)
        s_i = seeker_counts.get(v, 0)
        out.append((T + s_i * (2 * c - n)) / denom)
    return out


def _s3_sort_key(value: Any) -> str:
    """Total order over heterogeneous signature values, for deterministic summation."""
    return repr(value)


def _s3_surv_measuring(signature: Sequence[Any], n: int, seekers: Sequence[int]) -> list[float]:
    """Prefix sums over distance ranks.

    Three answer classes, not two: a zone sitting at *exactly* the seeker's distance
    answers neither closer nor further, so it agrees only with the other zones at that
    same distance. That is the `measuring_ties_are_their_own_answer` interpretation,
    and it is what makes this closed form agree exactly with the concrete answers the
    dossiers and the funnel print — verified against a literal O(n²·|S|) brute force.
    """
    values = [v for v in signature if v is not None]
    if len(values) < n:                       # some zone cannot answer at all
        return [1.0] * n
    ordered = sorted(values)
    seeker_values = sorted(signature[s] for s in seekers)
    distinct = sorted(set(seeker_values))
    counts = collections.Counter(seeker_values)

    lower_terms: list[float] = []             # seeker distance < hider's ⇒ hider is further
    upper_terms: list[float] = []             # seeker distance > hider's ⇒ hider is closer
    tie_terms: list[float] = []
    for v in distinct:
        left = bisect.bisect_left(ordered, v)
        right = bisect.bisect_right(ordered, v)
        equal = right - left
        greater = n - right
        lower_terms.append(counts[v] * greater)      # seeker nearer ⇒ hider answers "further"
        upper_terms.append(counts[v] * left)         # seeker further ⇒ hider answers "closer"
        tie_terms.append(counts[v] * equal)          # exactly level ⇒ neither

    prefix_lower = [0.0]
    for t in lower_terms:
        prefix_lower.append(prefix_lower[-1] + t)
    suffix_upper = [0.0] * (len(distinct) + 1)
    for i in range(len(distinct) - 1, -1, -1):
        suffix_upper[i] = suffix_upper[i + 1] + upper_terms[i]

    denom = len(seekers) * n
    out = []
    for v in signature:
        pos = bisect.bisect_left(distinct, v)
        exact = pos < len(distinct) and distinct[pos] == v
        agree = prefix_lower[pos] + suffix_upper[pos + 1 if exact else pos]
        if exact:
            agree += tie_terms[pos]
        out.append(agree / denom)
    return out


def _s3_surv_radar(question: QuestionDef, zones: Sequence[Zone], n: int,
                   seekers: Sequence[int]) -> list[float]:
    """`k_s` zones inside the seeker's disc, `n − k_s` outside; average over seekers."""
    radius = _s3_radius_m(question, zones)
    dists = _s3_zone_seeker_dists(zones, seekers)
    m = len(seekers)
    inside = [[d <= radius for d in row] for row in dists]
    k = [0] * m
    for row in inside:
        for j, flag in enumerate(row):
            if flag:
                k[j] += 1
    denom = m * n
    out = []
    for row in inside:
        agree = 0
        for j, flag in enumerate(row):
            agree += k[j] if flag else n - k[j]
        out.append(agree / denom)
    return out


def _s3_surv_thermometer(question: QuestionDef, zones: Sequence[Zone], n: int,
                         seekers: Sequence[int]) -> list[float]:
    """Perpendicular-bisector half-planes, eight bearings, one sort per bearing.

    "Hotter" means the hider is nearer the seeker's destination than their origin,
    which is exactly `z·u < s·u + L/2` for a unit travel vector `u`. Projecting every
    zone onto `u` once turns the whole question into a prefix sum.
    """
    leg = (question.param or 0.0) * M_PER_MILE
    if leg <= 0:
        return [1.0] * n
    totals = [0.0] * n
    trials = 0
    for ux, uy in _S3_BEARINGS:
        proj_z = [z.x * ux + z.y * uy for z in zones]
        ordered = sorted(proj_z)
        pairs = []
        for s in seekers:
            thresh = zones[s].x * ux + zones[s].y * uy + leg / 2.0
            pairs.append((thresh, bisect.bisect_left(ordered, thresh)))
        pairs.sort()
        thresholds = [p[0] for p in pairs]
        prefix_k = [0]
        for _t, kv in pairs:
            prefix_k.append(prefix_k[-1] + kv)
        total_k = prefix_k[-1]
        m = len(pairs)
        trials += m
        for i, p in enumerate(proj_z):
            pos = bisect.bisect_right(thresholds, p)
            hotter_side = total_k - prefix_k[pos]          # thresholds above p ⇒ hider hotter
            colder_side = pos * n - prefix_k[pos]          # thresholds at or below p
            totals[i] += hotter_side + colder_side
    denom = trials * n
    return [t / denom for t in totals]


def _s3_surv_tentacle(question: QuestionDef, signature: Sequence[Any], zones: Sequence[Zone],
                      n: int, seekers: Sequence[int]) -> list[float]:
    """Both reach tests anchored on the seeker, then nearest candidate among those in reach."""
    reach = (question.param or 0.0) * M_PER_MILE
    feats = signature[0][2] if signature and isinstance(signature[0], tuple) and len(signature[0]) == 3 else ()
    if reach <= 0 or not feats:
        return [1.0] * n
    xs = [z.x for z in zones]
    ys = [z.y for z in zones]
    totals = [0.0] * n
    reach_sq = reach * reach
    for s in seekers:
        sx, sy = zones[s].x, zones[s].y
        in_reach: list[tuple[str, tuple[tuple[float, float], ...]]] = []
        for label, pts in feats:
            if any((px - sx) ** 2 + (py - sy) ** 2 <= reach_sq for px, py in pts):
                in_reach.append((label, pts))
        classes: list[int] = []
        for i in range(n):
            if (xs[i] - sx) ** 2 + (ys[i] - sy) ** 2 > reach_sq:
                classes.append(-1)                       # "not within reach"
            elif not in_reach:
                classes.append(-2)                       # nothing to be nearest to
            else:
                best_i, best_d = 0, float("inf")
                for fi, (_label, pts) in enumerate(in_reach):
                    d = min((px - xs[i]) ** 2 + (py - ys[i]) ** 2 for px, py in pts)
                    if d < best_d:
                        best_d, best_i = d, fi
                classes.append(best_i)
        sizes = collections.Counter(classes)
        for i, c in enumerate(classes):
            totals[i] += sizes[c]
    denom = len(seekers) * n
    return [t / denom for t in totals]


# ═══════════════════════════════════════════════════════════════════════════════
# S3 · CONCRETE ANSWERS — what a zone actually says, for the funnel and the threats
# ═══════════════════════════════════════════════════════════════════════════════


def _s3_answer(question: QuestionDef, signature: Sequence[Any], zones: Sequence[Zone],
               hider: int, seeker: int) -> tuple[Any, str]:
    """`(class key, human wording)` of the answer zone `hider` gives seeker `seeker`."""
    cat = question.category
    a, b = signature[hider], signature[seeker]
    if cat == "matching":
        if a is None:
            return ("null", "null — no such thing on this map")
        return ("yes", "yes") if a == b else ("no", "no")
    if cat == "measuring":
        if a is None or b is None:
            return ("null", "null — no such thing on this map")
        if a < b:
            return ("closer", "closer")
        if a > b:
            return ("further", "further")
        return ("same", "the same distance")
    if cat == "radar":
        radius = _s3_radius_m(question, zones)
        d = math.hypot(zones[hider].x - zones[seeker].x, zones[hider].y - zones[seeker].y)
        return ("yes", "yes") if d <= radius else ("no", "no")
    if cat == "thermometer":
        ux, uy = _S3_BEARINGS[0]
        leg = (question.param or 0.0) * M_PER_MILE
        thresh = zones[seeker].x * ux + zones[seeker].y * uy + leg / 2.0
        p = zones[hider].x * ux + zones[hider].y * uy
        return ("hotter", "hotter") if p < thresh else ("colder", "colder")
    if cat == "photo":
        if a is None:
            return ("unknown", "not evaluated")
        return ("photo", "a photo") if a else ("cannot", "“I cannot answer the question”")
    if cat == "tentacle":
        reach = (question.param or 0.0) * M_PER_MILE
        feats = a[2] if isinstance(a, tuple) and len(a) == 3 else ()
        sx, sy = zones[seeker].x, zones[seeker].y
        hx, hy = zones[hider].x, zones[hider].y
        if math.hypot(hx - sx, hy - sy) > reach:
            return ("far", "not within reach")
        best_label, best_d = None, float("inf")
        for label, pts in feats:
            if not any(math.hypot(px - sx, py - sy) <= reach for px, py in pts):
                continue
            d = min(math.hypot(px - hx, py - hy) for px, py in pts)
            if d < best_d:
                best_d, best_label = d, label
        if best_label is None:
            return ("none", "nothing in reach to be nearest to")
        return (("near", best_label), best_label)
    return ("unknown", "not evaluated")


def _s3_reference_seeker(zones: Sequence[Zone]) -> int:
    """The zone closest to the map's centre of mass — the funnel's standing seeker."""
    if not zones:
        return 0
    cx = sum(z.x for z in zones) / len(zones)
    cy = sum(z.y for z in zones) / len(zones)
    best_i, best = 0, float("inf")
    for i, z in enumerate(zones):
        d = (z.x - cx) ** 2 + (z.y - cy) ** 2
        if d < best or (d == best and z.zone_id < zones[best_i].zone_id):
            best, best_i = d, i
    return best_i


def global_question_order(questions: Sequence[QuestionAudit], signatures: dict[str, Sequence[Any]],
                          zones: Sequence[Zone], k: int) -> tuple[list[str], list[int]]:
    """Greedily pick the k questions that break this map, and the resulting funnel.

    At each step take the question minimising the mean block size over all of `Z`
    once its answer is appended to the already-picked ones; break ties by
    `(cost, question_id)`. The criterion is map-wide expected narrowing rather than
    targeted narrowing, because the seekers do not know which zone they are hunting.

    Answers are evaluated for one standing seeker — the zone nearest the map's centre
    of mass — because a funnel has to name a concrete sequence of answers, and a
    survival number (which averages over every seeker) cannot. That is the
    `funnel_reference_seeker` interpretation.

    Returns `(question_ids, funnel)` where `funnel[0]` is `n` and `funnel[i]` is the
    surviving block size after the i-th question: `319 → 84 → 31 → 12 → 7`.
    """
    n = len(zones)
    memo_key = ("order", _s3_universe_key(zones), k,
                tuple(sorted(signatures)), tuple(sorted(q.id for q in questions)))
    hit = _S3_MEMO.get(memo_key)
    if hit is not None:
        return (list(hit[0]), list(hit[1]))
    if n == 0 or k <= 0:
        return ([], [n])

    defs = {q.id: q for q in QUESTIONS}
    ref = _s3_reference_seeker(zones)
    usable: list[tuple[str, list[Any], int]] = []
    for audit in sorted(questions, key=lambda q: q.id):
        if audit.status not in ("functional", "weak", "unaskable"):
            continue
        sig = signatures.get(audit.id)
        q = defs.get(audit.id)
        if sig is None or q is None:
            continue
        classes = [_s3_answer(q, sig, zones, i, ref)[0] for i in range(n)]
        if len({_s3_sort_key(c) for c in classes}) < 2:
            continue                     # this question says the same thing everywhere
        usable.append((audit.id, classes, q.keep))

    picked: list[str] = []
    funnel: list[int] = [n]
    joint: list[tuple[Any, ...]] = [() for _ in range(n)]
    remaining = {qid: (classes, cost) for qid, classes, cost in usable}
    for _step in range(min(k, len(remaining))):
        best: tuple[float, int, str] | None = None
        best_joint: list[tuple[Any, ...]] | None = None
        for qid in sorted(remaining):
            classes, cost = remaining[qid]
            trial = [joint[i] + (classes[i],) for i in range(n)]
            sizes = collections.Counter(_s3_sort_key(t) for t in trial)
            mean_block = sum(c * c for c in sizes.values()) / n
            candidate = (mean_block, cost, qid)
            if best is None or candidate < best:
                best, best_joint = candidate, trial
        if best is None or best_joint is None:
            break
        picked.append(best[2])
        joint = best_joint
        funnel.append(int(rhu(best[0])))
        del remaining[best[2]]

    _S3_MEMO[memo_key] = (picked, funnel)
    return (list(picked), list(funnel))


def _s3_joint_block_share(question_ids: Sequence[str], signatures: dict[str, Sequence[Any]],
                          zones: Sequence[Zone]) -> list[float]:
    """Share of zones sharing each zone's joint signature over `question_ids`."""
    n = len(zones)
    if n == 0:
        return []
    defs = {q.id: q for q in QUESTIONS}
    ref = _s3_reference_seeker(zones)
    joint: list[tuple[Any, ...]] = [() for _ in range(n)]
    for qid in question_ids:
        sig = signatures.get(qid)
        q = defs.get(qid)
        if sig is None or q is None:
            continue
        classes = [_s3_answer(q, sig, zones, i, ref)[0] for i in range(n)]
        joint = [joint[i] + (classes[i],) for i in range(n)]
    keys = [_s3_sort_key(t) for t in joint]
    sizes = collections.Counter(keys)
    return [sizes[key] / n for key in keys]


# ═══════════════════════════════════════════════════════════════════════════════
# S3 · QUESTION VIABILITY
# ═══════════════════════════════════════════════════════════════════════════════


def _s3_quality(question: QuestionDef, signature: Sequence[Any], zones: Sequence[Zone],
                seekers: Sequence[int]) -> float:
    """Quality in [0, 1], normalised per category (contract.md §5.1).

    Binary-answer categories — matching, radar, thermometer, photo — score the
    balance of the yes/no split: a 50/50 question scores 1.0 and a constant answer
    scores 0.0. Measuring always splits close to evenly, so scoring its split balance
    would rate every measuring question perfect; it scores *narrowing* instead — how
    much of the map its answer removes on average, renormalised so a clean halving is
    1.0. Tentacles have a multi-class answer and score Shannon entropy over the
    classes they realise.
    """
    n = len(zones)
    if n == 0 or not seekers:
        return 0.0
    cat = question.category

    if cat == "matching":
        if any(v is None for v in signature):
            return 0.0
        blocks = _s3_blocks(signature)
        p_yes = 0.0
        for s in seekers:
            p_yes += blocks.get(signature[s], 0) / n
        return _s3_binary_quality(p_yes / len(seekers))

    if cat == "measuring":
        # A measuring question always splits the map close to evenly, so a split-balance
        # score would rate every one of them 1.0 and tell you nothing. Score how much of
        # the map the answer actually removes instead: the mean survival across zones,
        # renormalised so a perfect halving is 1.0. A question whose distances are all
        # equal survives at 1.0 and scores 0.
        if any(v is None for v in signature):
            return 0.0
        values = survival_fractions(question, signature, zones, seekers)
        mean_surv = sum(sorted(values)) / n if values else 1.0
        return min(1.0, max(0.0, (1.0 - mean_surv) / 0.5))

    if cat == "radar":
        radius = _s3_radius_m(question, zones)
        dists = _s3_zone_seeker_dists(zones, seekers)
        inside = 0
        for row in dists:
            for d in row:
                if d <= radius:
                    inside += 1
        return _s3_binary_quality(inside / (len(seekers) * n))

    if cat == "thermometer":
        leg = (question.param or 0.0) * M_PER_MILE
        if leg <= 0:
            return 0.0
        hot = 0
        trials = 0
        for ux, uy in _S3_BEARINGS:
            proj_z = sorted(z.x * ux + z.y * uy for z in zones)
            for s in seekers:
                thresh = zones[s].x * ux + zones[s].y * uy + leg / 2.0
                hot += bisect.bisect_left(proj_z, thresh)
                trials += n
        return _s3_binary_quality(hot / trials) if trials else 0.0

    if cat == "photo":
        evaluated = [v for v in signature if v is not None]
        if not evaluated:
            return 0.0
        return _s3_binary_quality(sum(1 for v in evaluated if v) / len(evaluated))

    if cat == "tentacle":
        reach = (question.param or 0.0) * M_PER_MILE
        feats = signature[0][2] if signature and isinstance(signature[0], tuple) else ()
        if reach <= 0 or not feats:
            return 0.0
        scores: list[float] = []
        reach_sq = reach * reach
        for s in seekers:
            sx, sy = zones[s].x, zones[s].y
            in_reach = [(lab, pts) for lab, pts in feats
                        if any((px - sx) ** 2 + (py - sy) ** 2 <= reach_sq for px, py in pts)]
            classes = []
            for z in zones:
                if (z.x - sx) ** 2 + (z.y - sy) ** 2 > reach_sq:
                    classes.append(-1)
                elif not in_reach:
                    classes.append(-2)
                else:
                    best_i, best_d = 0, float("inf")
                    for fi, (_lab, pts) in enumerate(in_reach):
                        d = min((px - z.x) ** 2 + (py - z.y) ** 2 for px, py in pts)
                        if d < best_d:
                            best_d, best_i = d, fi
                    classes.append(best_i)
            sizes = sorted(collections.Counter(classes).values())
            scores.append(_s3_entropy_quality(sizes, n))
        return sum(scores) / len(scores) if scores else 0.0

    return 0.0


def _s3_block_span(signature: Sequence[Any]) -> tuple[int, int, int]:
    """`(number of classes, smallest class, largest class)` for a partition signature."""
    blocks = _s3_blocks(signature)
    sizes = sorted(blocks.values())
    if not sizes:
        return (0, 0, 0)
    return (len(sizes), sizes[0], sizes[-1])


def audit_questions(size: GameSize, geo: GeoData, gtfs_facts: dict[str, Any],
                    zones: Sequence[Zone], metrics: dict[str, Any],
                    border: Border) -> list[QuestionAudit]:
    """Give every question in the catalogue a status and a quality score.

    The status rule differs per category and this is the part that resists a single
    formula:
      * matching  — N=0 dead, N=1 **degenerate** (one instance ⇒ always "yes", zero
        bits), N≥2 functional.
      * measuring — N=0 dead, N≥1 **functional**. Measuring never degenerates on
        instance count: one instance still cuts a clean distance ring. Weakness comes
        from an extreme split.
      * radar     — never dead as a category (the "Choose" radar). A radius is
        degenerate at or above the station-set diameter, and trivial below the zone
        radius.
      * thermometer — dead above the map diameter, degenerate above 0.7× it. An
        interpretation, and labelled as one.
      * photo     — per *zone*. The metric is coverage over Z; dead only when that is
        0 map-wide, because "I cannot answer" still pays the hider and still leaks.
      * tentacle  — N=0 dead at the game's priciest cost, N=1 degenerate, N≥2 with a
        median in-reach count ≥2 functional.

    Nothing here returns `unaskable` any more: it means "the rules of the question
    itself cannot be satisfied here", and no question in the catalogue is barred by the
    map alone. *Transit Line* used to claim it on the strength of a curse that might be
    drawn; see the branch for why that is prose, not a verdict. The status is kept in
    the vocabulary because the renderers still name it.

    Every count is measured **inside the border**, applied to the feature's own map
    icon rather than to whatever Overpass returned for the bbox, and any question whose
    status would flip under a modestly larger border is marked `borderline`.
    """
    n = len(zones)
    proj = _s3_proj_from_zones(zones)
    seekers = _s3_seeker_sample(zones)
    diameter = float(metrics.get("diameter_m") or 0.0)
    zone_radius = float(size.zone_radius_m)
    out: list[QuestionAudit] = []

    for q in catalogue_for(size):
        kind, arg = _s3_subject(q)
        selector = _s3_selector_for(q)
        sig = answer_signature(q, zones, geo, gtfs_facts, proj)
        quality = 0.0
        instances: int | None = None
        coverage: float | None = None
        borderline = False
        status = "unknown"
        why = "Not evaluated."

        # ── matching ──────────────────────────────────────────────────────────
        if q.category == "matching":
            if kind == "osm_nearest":
                pois, queried = _s3_in_border_pois(geo, q.geodata_ref, border.bbox)
                if not queried:
                    status, why = "unknown", _s3_not_queried_why(geo, _s3_noun(q.geodata_ref, 2))
                else:
                    instances = len(pois)
                    margin = _s3_margin_count(geo, q.geodata_ref, border.bbox, zone_radius)
                    borderline = (instances == 0 and margin >= 1) or (instances == 1 and margin >= 2)
                    if instances == 0:
                        status = "dead"
                        why = (f"No {_s3_noun(q.geodata_ref, 1)} inside the border. Out-of-border "
                               f"features do not exist for this game, so the answer is always null "
                               f"— and a null still pays the hider a card.")
                        if margin:
                            why += (f" {num(margin)} sit just outside a border drawn "
                                    f"{num(max(2 * zone_radius, 250.0))} m wider, so this call is "
                                    f"sensitive to where you draw the line.")
                    elif instances == 1:
                        status = "degenerate"
                        why = (f"One {_s3_noun(q.geodata_ref, 1)} inside the border, so every "
                               f"zone's nearest is the same one and the answer is always yes.")
                    else:
                        quality = _s3_quality(q, sig, zones, seekers)
                        classes, smallest, largest = _s3_block_span(sig)
                        status = "weak" if quality < 0.12 else "functional"
                        why = (f"{num(instances)} {_s3_noun(q.geodata_ref, instances)} inside the "
                               f"border; {num(classes)} of them are the nearest to at least one "
                               f"zone, and those cells hold {num(smallest)}–{num(largest)} zones "
                               f"each.")
                        if status == "weak":
                            why += (" The cells are so fine that a random seeker almost never "
                                    "shares yours, so the answer is nearly always no — and a no "
                                    "eliminates only that seeker's own cell.")
            elif kind == "gtfs_transit_line":
                routes = int(metrics.get("routes") or 0)
                instances = routes
                classes, smallest, largest = _s3_block_span(sig)
                if routes == 0:
                    status, why = "dead", "No routes serve this map."
                elif routes == 1:
                    status = "degenerate"
                    why = "One route serves the whole map, so everyone's nearest transit line is it."
                else:
                    # Scored like every other matching question, because nothing about
                    # THIS MAP stops the question being asked. The rulebook attaches only
                    # a timing precondition — "In order to ask this question, seekers must
                    # be on the form of transit, and it must be moving" (SEEKING.md) —
                    # which seekers on a multi-route network can satisfy whenever they
                    # choose. Curse of the Urban Explorer can end that, but it has to be
                    # drawn, paid for and played, so it is advice for the row's prose, not
                    # a property of the map, and it does not earn `unaskable` ("the rules
                    # of the question itself cannot be satisfied here").
                    quality = _s3_quality(q, sig, zones, seekers)
                    status = "weak" if quality < 0.12 else "functional"
                    sharp = "cuts hard when it lands" if quality >= 0.12 else \
                            "almost always answers no, and a no eliminates only the seeker's own set"
                    why = (f"{num(routes)} routes produce {num(classes)} distinct route sets across "
                           f"{num(n)} zones, so it {sharp}. Asking it costs timing, not terrain: "
                           f"you must be aboard a vehicle and moving when the question goes out, "
                           f"which on {num(routes)} routes is a matter of planning the ask. One "
                           f"caveat — if the hider draws Curse of the Urban Explorer, pays its "
                           f"cost and plays it, transit is closed to you for the rest of the run "
                           f"and this question goes with it.")
            elif kind == "gtfs_name_length":
                classes, smallest, largest = _s3_block_span(sig)
                instances = classes
                if classes < 2:
                    status = "degenerate"
                    why = "Every station name on this map is the same length."
                else:
                    quality = _s3_quality(q, sig, zones, seekers)
                    status = "weak" if quality < 0.12 else "functional"
                    why = (f"{num(classes)} distinct station-name lengths across {num(n)} zones, "
                           f"the largest sharing {num(largest)} zones.")
            elif kind == "street":
                counted = geo.counts.get("street") if geo.available else None
                if counted is None:
                    status, why = "unknown", _s3_not_queried_why(geo, "streets and paths")
                elif counted == 0:
                    status, why = "dead", "No mapped street or path inside the border."
                else:
                    instances = counted
                    quality = _s3_quality(q, sig, zones, seekers)
                    status = "weak" if quality < 0.12 else "functional"
                    why = (f"{num(counted)} mapped street and path ways, effectively one nearest per "
                           f"zone, so the answer is almost always no — and a no eliminates exactly "
                           f"one zone. Live, but the weakest matching question on this map.")
            elif kind == "landmass":
                pois, queried = _s3_in_border_pois(geo, "coastline", border.bbox)
                if not queried:
                    status, why = "unknown", _s3_not_queried_why(geo, "coastline")
                elif not pois:
                    status, instances = "degenerate", 1
                    why = ("No coastline inside the border, so the whole map is one landmass and "
                           "the answer is always yes.")
                elif all((p.tags or {}).get("derived") for p in pois):
                    # Every shore here was derived from a water body larger than the
                    # map, so the water bounds the map rather than cutting through it
                    # — the land is still one piece and the answer is still always yes.
                    status, instances = "degenerate", 1
                    why = ("The only shore inside the border belongs to a water body larger than "
                           "the map, so it bounds the map rather than splitting it: the land is "
                           "one landmass and the answer is always yes.")
                else:
                    status, instances = "unknown", len(pois)
                    why = ("Coastline crosses the border, so the map spans more than one landmass; "
                           "assembling landmasses from coastline ways is outside this pipeline.")
            elif kind == "admin":
                status, instances, quality, why = _s3_admin_matching(q, arg, sig, geo, zones, seekers, n)
            else:
                status, why = "unknown", "No data source for this question."

        # ── measuring ─────────────────────────────────────────────────────────
        elif q.category == "measuring":
            if kind == "osm_distance":
                pois, queried = _s3_in_border_pois(geo, q.geodata_ref, border.bbox)
                if not queried:
                    status, why = "unknown", _s3_not_queried_why(geo, _s3_noun(q.geodata_ref, 2))
                else:
                    instances = len(pois)
                    margin = _s3_margin_count(geo, q.geodata_ref, border.bbox, zone_radius)
                    borderline = instances == 0 and margin >= 1
                    if instances == 0:
                        status = "dead"
                        why = (f"No {_s3_noun(q.geodata_ref, 1)} inside the border, so this always "
                               f"returns null — which costs the seekers a question and pays the "
                               f"hider a card.")
                        if margin:
                            why += (f" {num(margin)} sit just outside a border drawn "
                                    f"{num(max(2 * zone_radius, 250.0))} m wider, so the call is "
                                    f"sensitive to where you draw the line.")
                    else:
                        quality = _s3_quality(q, sig, zones, seekers)
                        values = [v for v in sig if v is not None]
                        lo, hi = (min(values), max(values)) if values else (0.0, 0.0)
                        status = "weak" if quality < 0.30 else "functional"
                        why = (f"{num(instances)} {_s3_noun(q.geodata_ref, instances)} inside "
                               f"the border; the zones sit {miles(lo)}–{miles(hi)} from the "
                               f"nearest one, so the distance ring cuts the map cleanly.")
                        if instances == 1:
                            why += (" A single instance is not a weakness here: one clean ring is "
                                    "among the strongest measuring questions there is.")
            elif kind == "border_line":
                status, instances, quality, why = _s3_border_measuring(q, arg, sig, geo, zones, seekers, n)
            elif kind == "dem":
                status = "unknown"
                why = ("Elevation needs a digital elevation model this pipeline deliberately does "
                       "not carry. On a map with real terrain this question probably works; it is "
                       "reported as not evaluated rather than guessed.")
            else:
                status, why = "unknown", "No data source for this question."

        # ── radar ─────────────────────────────────────────────────────────────
        elif q.category == "radar":
            radius = _s3_radius_m(q, zones)
            quality = _s3_quality(q, sig, zones, seekers)
            hit = (metrics.get("radar_hit_rate") or {}).get(radius)
            if diameter and radius >= diameter:
                status = "degenerate"
                why = (f"{miles(radius)} is wider than the map's {miles(diameter)} diameter, so the "
                       f"answer is always yes.")
            elif radius < zone_radius:
                status = "weak"
                why = (f"{miles(radius)} is smaller than the {miles(zone_radius)} hiding-zone "
                       f"radius, so the disc cannot even cover one zone. This is an endgame tool, "
                       f"not a search tool.")
            else:
                status = "weak" if quality < 0.25 else "functional"
                share = hit if hit is not None else None
                why = (f"A {miles(radius)} disc covers "
                       f"{pct(share) if share is not None else 'part'} of the map's station pairs, "
                       f"so the yes and no branches are both worth buying.")
                if q.param is None:
                    why = (f"The seekers name the distance, so this radar can never be dead. On "
                           f"this map the sharpest choice is about {miles(radius)}, which splits "
                           f"the zone set closest to evenly.")
                if status == "weak":
                    why += " One branch is rare enough that the expected narrowing is small."

        # ── thermometer ───────────────────────────────────────────────────────
        elif q.category == "thermometer":
            leg = (q.param or 0.0) * M_PER_MILE
            quality = _s3_quality(q, sig, zones, seekers)
            if diameter and leg > diameter:
                status = "dead"
                why = (f"A {miles(leg)} leg is longer than the map's {miles(diameter)} diameter: "
                       f"the seekers cannot travel it without leaving the map. Interpretation — "
                       f"the rulebook does not say what happens beyond the border.")
            elif diameter and leg > 0.70 * diameter:
                status = "degenerate"
                why = (f"A {miles(leg)} leg is more than 0.7 of the map's {miles(diameter)} "
                       f"diameter, so the seekers end up outside the zone set and the answer stops "
                       f"depending on where you are. Interpretation.")
            else:
                status = "weak" if quality < 0.20 else "functional"
                why = (f"A {miles(leg)} leg splits the map through the perpendicular bisector of "
                       f"the seekers' move; averaged over eight bearings it lands "
                       f"{pct(quality / 2)} of the way to an even split.")

        # ── photo ─────────────────────────────────────────────────────────────
        elif q.category == "photo":
            evaluated = [v for v in sig if v is not None]
            if not evaluated:
                status, why = "unknown", _s3_not_queried_why(geo, "the subject of this photo")
            else:
                coverage = sum(1 for v in evaluated if v) / len(evaluated)
                quality = _s3_quality(q, sig, zones, seekers)
                if coverage <= 0.0:
                    status = "dead"
                    why = ("No zone on this map contains the subject, so every hider answers “I "
                           "cannot answer the question” — which still pays them a card.")
                elif coverage >= 1.0:
                    status = "degenerate"
                    why = ("Every zone can answer this, so as a locational question it carries no "
                           "information. The photograph itself may still show the seekers "
                           "something — a landmark, a shadow, a skyline — that no model can score.")
                elif coverage < 0.15 or coverage > 0.85:
                    status = "weak"
                    why = (f"{pct(coverage)} of zones contain the subject, so one branch is rare. "
                           f"Note which branch: the rare answer is the informative one, and “I "
                           f"cannot answer” is a real answer that pays the hider.")
                else:
                    status = "functional"
                    why = (f"{pct(coverage)} of zones contain the subject, so both answers are "
                           f"worth buying.")
                if len(evaluated) < n:
                    why += (f" Evaluated for {num(len(evaluated))} of {num(n)} zones; the rest had "
                            f"no OpenStreetMap coverage for the subject.")
                if q.id == "photo.train_platform" and not gtfs_facts.get("has_rail"):
                    rail_osm = geo.counts.get("rail_station", 0)
                    why = ("Every route in this feed is a bus, so no zone has a train platform to "
                           "photograph and every hider answers “I cannot answer the question” — "
                           "which still pays them a card.")
                    if rail_osm:
                        why += (f" OpenStreetMap does show {num(rail_osm)} railway "
                                f"station{'' if rail_osm == 1 else 's'} inside the border; agree "
                                f"in advance whether an intercity platform your transit map does "
                                f"not draw counts.")

        # ── tentacle ──────────────────────────────────────────────────────────
        elif q.category == "tentacle":
            feats = sig[0][2] if sig and isinstance(sig[0], tuple) and len(sig[0]) == 3 else ()
            reach = (q.param or 0.0) * M_PER_MILE
            if kind == "gtfs_metro_line":
                if not gtfs_facts.get("has_rail"):
                    status, instances = "dead", 0
                    why = ("Every route in this feed is a bus. The rulebook's metro lines are the "
                           "coloured rail lines a map app draws, so this question has nothing to "
                           "name here — at the game's most expensive price, draw 4 keep 2.")
                elif not feats:
                    status = "unknown"
                    why = ("This feed has rail routes, but none of them reaches a candidate zone, "
                           "so no line position could be derived.")
                else:
                    status, instances, quality, why = _s3_tentacle_verdict(
                        q, sig, feats, zones, seekers, n, reach, "metro line")
            else:
                pois, queried = _s3_in_border_pois(geo, q.geodata_ref, border.bbox)
                label = _s3_noun(q.geodata_ref, 2)
                if not queried:
                    status, why = "unknown", _s3_not_queried_why(geo, label)
                else:
                    instances = len(pois)
                    margin = _s3_margin_count(geo, q.geodata_ref, border.bbox, zone_radius)
                    borderline = (instances == 0 and margin >= 1) or (instances == 1 and margin >= 2)
                    if instances == 0:
                        status = "dead"
                        why = (f"No {_s3_noun(q.geodata_ref, 1)} inside the border, and this "
                               f"is the most expensive "
                               f"question in the game to ask: draw 4, keep 2, all of it paid to "
                               f"the hider for a null.")
                    elif instances == 1:
                        status = "degenerate"
                        why = (f"One {_s3_noun(q.geodata_ref, 1)} inside the border, so the "
                               f"question collapses into the intersection of two radars — for "
                               f"twice a radar's price.")
                    else:
                        status, instances, quality, why = _s3_tentacle_verdict(
                            q, sig, feats, zones, seekers, n, reach, label)

        out.append(QuestionAudit(
            id=q.id, category=q.category, label=q.label, text=q.text,
            status=status, quality=rhu(min(1.0, max(0.0, quality)), 4),
            instances=instances,
            coverage=None if coverage is None else rhu(coverage, 4),
            selector=selector, why=why, surv_mean=None, borderline=borderline,
        ))
    return out


def _s3_not_queried_why(geo: GeoData, what: str) -> str:
    """The one sentence that explains an `unknown`, without pretending it is a zero."""
    if not geo.available:
        return (f"The OpenStreetMap layer was not available on this run, so {what} could not be "
                f"counted. Not evaluated — which is not the same as none.")
    return (f"{what[:1].upper()}{what[1:]} was not queried on this run, so this question is not "
            f"evaluated. Not evaluated is not the same as none.")


def _s3_admin_matching(q: QuestionDef, ordinal: int, sig: Sequence[Any], geo: GeoData,
                       zones: Sequence[Zone], seekers: Sequence[int],
                       n: int) -> tuple[str, int | None, float, str]:
    """Status for one of the four administrative-division matching questions."""
    word = _S3_ORDINAL_WORD.get(ordinal, str(ordinal))
    if not geo.available or geo.admin.source == "unknown":
        return ("unknown", None, 0.0,
                "The map's country could not be resolved, so no administrative level could be "
                "assigned to this ordinal. Administrative levels are never guessed.")
    level = geo.admin.ordinals.get(ordinal)
    if level is None:
        return ("unknown", None, 0.0,
                f"This country has no {word} administrative division inside the map, so the "
                f"question is not evaluated rather than counted as dead.")
    names = sorted({v for v in sig if v})
    if not names:
        return ("unknown", 0, 0.0,
                f"admin_level={level} exists for this country but no zone centre resolved to one, "
                f"so the {word} division could not be read.")
    if len(names) == 1:
        return ("degenerate", 1, 0.0,
                f"The whole map is inside {names[0]}, so every zone's {word} division is the same "
                f"and the answer is always yes.")
    quality = _s3_quality(q, sig, zones, seekers)
    classes, smallest, largest = _s3_block_span(sig)
    listed = ", ".join(names[:4]) + ("…" if len(names) > 4 else "")
    status = "weak" if quality < 0.12 else "functional"
    return (status, len(names), quality,
            f"{num(len(names))} {word} divisions cover the map ({listed}) at admin_level={level}; "
            f"their zone counts run {num(smallest)}–{num(largest)}.")


def _s3_border_measuring(q: QuestionDef, ordinal: int, sig: Sequence[Any], geo: GeoData,
                         zones: Sequence[Zone], seekers: Sequence[int],
                         n: int) -> tuple[str, int | None, float, str]:
    """Status for International / 1st / 2nd administrative division border questions."""
    word = _S3_ORDINAL_WORD.get(ordinal, str(ordinal))
    if not geo.available or geo.admin.source == "unknown":
        return ("unknown", None, 0.0,
                "The map's country could not be resolved, so no boundary level could be checked. "
                "Administrative levels are never guessed.")
    if ordinal and geo.admin.ordinals.get(ordinal) is None:
        return ("unknown", None, 0.0,
                f"This country has no {word} administrative division, so there is no such "
                f"boundary to measure to.")
    if ordinal not in geo.admin.border_levels:
        return ("unknown", None, 0.0,
                "The boundary-crossing audit did not return a result for this level.")
    if not geo.admin.border_levels.get(ordinal):
        subject = "international border" if ordinal == 0 else f"{word} administrative division border"
        return ("dead", 0, 0.0,
                f"No {subject} crosses the map, so this always returns null. Note the asymmetry: "
                f"the matching twin of this question can still be alive, because being inside one "
                f"division is not the same as being near its edge.")
    if all(v is None for v in sig):
        return ("unknown", 1, 0.0,
                f"A {word} boundary line does cross the map, but every zone centre sits on the "
                f"same side of it, so the distance to it could not be derived from the zone set. "
                f"Treat it as live and measure it by hand.")
    quality = _s3_quality(q, sig, zones, seekers)
    values = [v for v in sig if v is not None]
    lo, hi = (min(values), max(values)) if values else (0.0, 0.0)
    status = "weak" if quality < 0.30 else "functional"
    return (status, 1, quality,
            f"A {word} boundary crosses the map. Distance to it is approximated by the distance to "
            f"the nearest zone in a different division, which runs {miles(lo)}–{miles(hi)} — an "
            f"upper bound on the true distance, and an interpretation.")


def _s3_tentacle_verdict(q: QuestionDef, sig: Sequence[Any], feats: Sequence[Any],
                         zones: Sequence[Zone], seekers: Sequence[int], n: int,
                         reach: float, label: str) -> tuple[str, int, float, str]:
    """N≥2 tentacles: functional when the tentacle usually has more than one arm."""
    reach_sq = reach * reach
    in_reach_counts: list[int] = []
    for z in zones:
        c = 0
        for _lab, pts in feats:
            if any((px - z.x) ** 2 + (py - z.y) ** 2 <= reach_sq for px, py in pts):
                c += 1
        in_reach_counts.append(c)
    median_arms = quantile(in_reach_counts, 0.5) if in_reach_counts else 0
    quality = _s3_quality(q, sig, zones, seekers)
    covered = sum(1 for c in in_reach_counts if c >= 1) / n if n else 0.0
    if median_arms >= 2:
        status = "functional"
        why = (f"{num(len(feats))} {label} inside the border; the median zone has "
               f"{num(median_arms)} of them within {miles(reach)}, so the answer names one of "
               f"several and is worth its draw-4-keep-2 price.")
    else:
        status = "weak"
        arms = "none" if median_arms < 1 else num(median_arms)
        why = (f"{num(len(feats))} {label} inside the border, but the median zone has {arms} "
               f"within {miles(reach)} — the tentacle usually has at most one arm, so the answer "
               f"mostly repeats a radar at twice the cost. {pct(covered)} of zones have any in "
               f"reach at all. In-reach counts here are measured from the zone; in play both "
               f"reach tests are anchored on the seeker.")
    return (status, len(feats), quality, why)


# ═══════════════════════════════════════════════════════════════════════════════
# S3 · CURSE DECK AUDIT
# ═══════════════════════════════════════════════════════════════════════════════

# Plain-words description of what decides each curse. Printed next to the count, so
# a player can disagree with the predicate rather than with the verdict.
_S3_CURSE_PREDICATE_WORDS: dict[str, str] = {
    "bridge": 'OSM: way["bridge"]["bridge"!="no"] carrying ["highway"] or ["railway"], '
              'covered ones included (BBOX)',
    "water": 'OSM: natural=water, landuse=reservoir|basin and waterway=river|canal, pools '
             'excluded, named or not (BBOX)',
    "car_street": "OSM: motor-vehicle highway ways with motor_vehicle and access not no (BBOX)",
    "grocery": 'OSM: shop=supermarket|greengrocer|convenience|grocery|farm (BBOX)',
    "shop": 'OSM: shop=* (BBOX)',
    "cuisine": "OSM: restaurants tagged with a single foreign country's cuisine (BBOX)",
    "cairn_terrain": 'OSM: natural=scree|bare_rock|beach|shingle|wood (BBOX)',
    "print_source": 'OSM: shop=newsagent|books|kiosk|stationery (BBOX)',
    "tumble_ground": 'OSM: leisure=pitch|playground|recreation_ground|garden|nature_reserve (BBOX)',
    "building": 'OSM: way["building"] (BBOX)',
    "travel_agent_stop": "OSM: parks, gardens, playgrounds, libraries, places of worship, "
                         "marketplaces, town halls and pedestrian streets (BBOX)",
    "animal_habitat": "OSM: parks, nature reserves, forest/grass/meadow landuse and named water (BBOX)",
    "u_turn": "GTFS: share of stops with a second route, and the wait for a departure on a "
              "different route",
}


def audit_curses(size: GameSize, geo: GeoData, gtfs_facts: dict[str, Any],
                 country_code: str | None) -> list[CurseAudit]:
    """Decide keep / warn / remove / player-choice for all 24 curses.

    Tier 1 (4 curses) is what the rulebook itself says to remove; tier 2 (5) is
    map-contingent and hard enough to auto-remove; tier 3 (10) warns only and is
    never auto-removed; tier 4 (5) is not map-contingent at all. Two predicates are
    not OSM: Unguided Tourist reads `LOW_STREETVIEW_COUNTRIES`, and U-Turn reads
    `gtfs_facts['u_turn']`.
    """
    counts = geo.curse_counts if geo.available else {}
    cuisines = geo.cuisines if geo.available else {}
    u_turn = gtfs_facts.get("u_turn") or {}
    window_h = 1.0 if size.name == "large" else 0.5
    out: list[CurseAudit] = []

    for c in CURSES:
        count = counts.get(c.id)
        predicate = _S3_CURSE_PREDICATE_WORDS.get(c.predicate_key or "", "not map-contingent")
        action = "keep"
        why = c.removal_rule

        if c.id == "unguided_tourist":
            predicate = f"Static Street View coverage table for country `{country_code or 'unknown'}`"
            count = None
            if country_code is None:
                action = "warn"
                why = ("The map's country could not be resolved, so Street View coverage is "
                       "unknown. Check it yourself before you shuffle: the rulebook removes this "
                       "curse wherever coverage is poor.")
            elif country_code in LOW_STREETVIEW_COUNTRIES:
                action = "remove"
                why = (f"`{country_code}` is on the low-Street-View list the rulebook's own example "
                       f"(Germany) belongs to, so this curse comes out of the deck.")
            else:
                why = f"`{country_code}` has broad Street View coverage, so the curse stays in."

        elif c.id == "u_turn":
            share = float(u_turn.get("multi_route_stop_share") or 0.0)
            wait = u_turn.get("median_wait_other_route_min")
            count = None
            if share < 0.20 or (wait is not None and wait > window_h * 60):
                action = "warn"
                why = (f"Only {pct(share)} of stops carry a second route"
                       + (f", and the median wait for a departure on a different route is "
                          f"{mins(wait)} against the card's {num(window_h * 60)}-minute window"
                          if wait is not None else "")
                       + ". The card's escape hatch opens more often than the curse bites, so "
                         "expect it to fizzle. Never removed — the hatch is printed on the card.")
            else:
                why = (f"{pct(share)} of stops carry a second route"
                       + (f" and the median wait for a different route is {mins(wait)}"
                          if wait is not None else "")
                       + ", so the curse usually bites. Never removed.")

        elif c.id in ("egg_partner", "impressionable_consumer"):
            action = "player-choice"
            if count == 0:
                action = "remove"
                why = (f"{c.removal_rule} Here the secondary check also fails: the map has none of "
                       f"the shops this curse needs, so it is uncastable anyway.")
            else:
                why = (f"{c.removal_rule} Geometry allows it"
                       + (f" ({num(count)} qualifying shops on the map)" if count is not None else "")
                       + "; whether you want to buy things during the game is a conversation, not "
                         "a measurement.")

        elif c.id == "bridge_troll":
            if count is None:
                action, why = "warn", ("Bridges could not be counted on this run, so the "
                                       "rulebook's own removal test could not be applied.")
            elif count == 0:
                action = "remove"
                why = ("No bridges on the game map. The rulebook says outright to remove this "
                       "curse in that case.")
            else:
                # The card defines a bridge as "any elevated structure, acting as a path,
                # road or railway, intended to be crossed by pedestrians, cars, or other
                # vehicles", so rail and covered bridges are inside the count and the
                # wording says so.
                why = (f"{num(count)} bridges on the map — road, path and rail — so the "
                       f"curse stays in. Check that "
                       f"some of them are ones a seeker can physically stand under.")

        elif c.id == "distant_cuisine":
            distinct = len(cuisines)
            if count is None:
                action, why = "warn", "Restaurant cuisine tags were not available on this run."
            elif count == 0:
                action = "remove"
                why = ("No restaurant on the map is tagged with a single foreign country's "
                       "cuisine, so this curse can never be cast.")
            elif distinct <= 1:
                action = "warn"
                why = (f"{num(count)} qualifying restaurants but only one distinct country, so "
                       f"every one of them is the same distance away and the curse is a formality.")
            elif count < 5:
                action = "warn"
                why = (f"Only {num(count)} qualifying restaurants across {num(distinct)} countries. "
                       f"Castable, but the hider has to be lucky with their zone.")
            else:
                why = (f"{num(count)} restaurants across {num(distinct)} distinct foreign cuisines. "
                       f"Remember this is a floor: many restaurants carry no cuisine tag at all.")

        elif c.tier == 2:
            if count is None:
                action, why = "warn", f"{c.removal_rule} The count was not available on this run."
            elif count == 0:
                action = "remove"
                why = f"{c.removal_rule} The map's count is zero."
            else:
                why = f"{c.removal_rule} The map's count is {num(count)}, so it stays in."

        elif c.tier == 3:
            if count is not None and count == 0:
                action = "warn"
                why = (f"{c.removal_rule} Nothing on this map satisfies the predicate, so expect "
                       f"this one to stall. It is still never auto-removed.")
            elif count is not None:
                why = f"{c.removal_rule} Map-wide count: {num(count)}."

        out.append(CurseAudit(id=c.id, name=c.name, tier=c.tier, action=action,
                              predicate=predicate, count=count, why=why))
    return out


# ═══════════════════════════════════════════════════════════════════════════════
# S3 · CITY FITNESS — 100 points, six sub-scores, every one traceable
# ═══════════════════════════════════════════════════════════════════════════════


def _s3_metric(mid: str, name: str, raw: float | None, unit: str, frac: float | None,
               max_points: float, kind: str, args: Sequence[float], source: str,
               note: str, available: bool = True) -> Metric:
    """One scored row. `frac` is the ramp output; points are integer tenths from here on."""
    points = tenths(frac, max_points) if (available and frac is not None) else 0
    return Metric(id=mid, name=name, raw=None if raw is None else rhu(float(raw), 4), unit=unit,
                  points_tenths=points, max_tenths=int(rhu(max_points * 10)),
                  ramp={"kind": kind, "args": [float(a) for a in args]},
                  source=source, note=note, available=available)


# How long the rulebook says a game of each size lasts, in its own words (GUIDE.md
# "Choosing Game Size"). Printed by D1 so the reader can see the stated duration next to
# the playing-hours figure we inferred from it.
_S3_SIZE_STATED_LENGTH: dict[str, str] = {
    "small": "lasts 4–8 hours",
    "medium": "lasts about 1 day",
    "large": "lasts 2 to 4 days",
}


def _s3_question_stats(questions: Sequence[QuestionAudit],
                       size: GameSize) -> dict[str, Any]:
    """The four B-metric inputs, from the audit rows. `unknown` never enters a denominator.

    `unaskable` used to be counted into the functional pool at both sites below, because
    there was exactly one `unaskable` question — Transit Line, forced there by a curse
    that only bites once drawn and played — and folding it back in was how the pool kept
    a live question at full weight. `audit_questions` no longer emits that status for a
    map with routes, so the clause is gone; carrying it would silently restore full
    weight to any question a future rule does class `unaskable`, which is by definition a
    question that cannot be asked.
    """
    scored = [q for q in questions if q.status != "unknown"]
    total = len(scored)
    functional = [q for q in scored if q.status == "functional"]
    weak = [q for q in scored if q.status == "weak"]
    dead = [q for q in scored if q.status in ("dead", "degenerate")]
    live_share = (len(functional) + 0.5 * len(weak)) / total if total else None

    per_cat: dict[str, dict[str, int]] = {}
    for q in scored:
        row = per_cat.setdefault(q.category, {"n": 0, "functional": 0, "dead": 0})
        row["n"] += 1
        if q.status == "functional":
            row["functional"] += 1
        if q.status in ("dead", "degenerate"):
            row["dead"] += 1

    deep = sum(1 for cat in sorted(per_cat) if per_cat[cat]["functional"] >= 2)
    any_live = sum(1 for cat in sorted(per_cat) if per_cat[cat]["functional"] >= 1)
    depth = deep / size.category_count if size.category_count else None

    qualities = sorted(q.quality for q in functional)
    mean_quality = sum(qualities) / len(qualities) if qualities else None

    randomize = None
    if total:
        randomize = 0.0
        for cat in sorted(per_cat):
            row = per_cat[cat]
            randomize += (row["n"] / total) * (row["dead"] / row["n"] if row["n"] else 0.0)

    return {
        "total": total, "functional": len(functional), "weak": len(weak), "dead": len(dead),
        "live_share": live_share, "category_depth": depth, "categories_with_live": any_live,
        "mean_quality": mean_quality, "randomize_risk": randomize, "per_category": per_cat,
    }


def _s3_view(metrics: dict[str, Any], day_key: str | None, size: GameSize) -> dict[str, Any]:
    """The metric view for one service day: the head table, overlaid with that day's values."""
    view = dict(metrics)
    if day_key:
        day = (metrics.get("per_day") or {}).get(day_key)
        if day:
            view.update(day)
    for base in ("reachable_zone_share", "evening_zone_share", "reach_within_hiding_period"):
        by_size = view.get(f"{base}_by_size")
        if isinstance(by_size, dict) and size.name in by_size:
            view[base] = by_size[size.name]
    by_size = metrics.get("playable_day_weight_by_size")
    if isinstance(by_size, dict) and size.name in by_size:
        view["playable_day_weight"] = by_size[size.name]
    return view


def _s3_one_route_share(days: Sequence[ServiceDay]) -> float:
    """The largest share of served stops any single route reaches, on the best day.

    Per-route trip totals are not on the metric table, so the one-route cap is
    evaluated on stop reach instead. A route touching nine stops in ten is a
    one-dimensional map either way; this is the `one_route_cap_is_stop_share`
    interpretation.
    """
    if not days:
        return 0.0
    best = max(days, key=lambda d: (d.trips, d.day_type.key))
    served = best.served_stop_ids
    if not served:
        return 0.0
    reach: dict[str, int] = {}
    for sid in served:
        for rid in best.stop_days[sid].routes:
            reach[rid] = reach.get(rid, 0) + 1
    if not reach:
        return 0.0
    return max(reach[rid] for rid in sorted(reach)) / len(served)


def _s3_subscores(view: dict[str, Any], qstats: dict[str, Any], size: GameSize,
                  shared_signature_share: float | None,
                  weekend_available: bool, weekend_note: str,
                  questions_available: bool) -> list[SubScore]:
    """Build all six sub-scores from one metric view. Pure arithmetic; no I/O."""
    hiding_h = size.hiding_period_min / 60.0
    required = size.required_hours

    n_zones = view.get("n_zones")
    reach_share = view.get("reachable_zone_share")
    a = [
        _s3_metric("A1", "Distinct hiding zones", n_zones, "zones",
                   None if n_zones is None else ramp(float(n_zones), 15, 60), 8,
                   "ramp", (15, 60), "interp",
                   "The greedy cover at the size's zone radius, not the raw stop count: adjacent "
                   "bus poles share almost all of their circle. Monotone with a cap, because more "
                   "zones is never worse for the game.",
                   n_zones is not None),
        _s3_metric("A2", "Zones reachable inside the hiding period", reach_share, "share",
                   None if reach_share is None else ramp(float(reach_share), 0.35, 0.85), 7,
                   "ramp", (0.35, 0.85), "interp",
                   f"Below 0.35 most of the printed map is decorative and the real map is much "
                   f"smaller. The bound is the rulebook's own {size.hiding_period_min}-minute "
                   f"hiding period.",
                   reach_share is not None),
        _s3_metric("A3", "Zones that share a top-question signature", shared_signature_share,
                   "share",
                   None if shared_signature_share is None else ramp(shared_signature_share, 0.30, 0.75),
                   5, "ramp", (0.30, 0.75), "interp",
                   "If the map's best few questions pin most zones uniquely, hiding is a formality.",
                   shared_signature_share is not None),
    ]

    b = [
        _s3_metric("B1", "Share of the catalogue that is live", qstats["live_share"], "share",
                   None if qstats["live_share"] is None else ramp(qstats["live_share"], 0.35, 0.80),
                   10, "ramp", (0.35, 0.80), "interp",
                   f"Functional plus half of weak, over the {num(qstats['total'])} questions that "
                   f"could be evaluated. Under a third live and the seekers are re-asking "
                   f"questions at doubled cost while the hider farms cards.",
                   questions_available and qstats["live_share"] is not None),
        _s3_metric("B2", "Categories with two or more functional questions", qstats["category_depth"],
                   "share",
                   None if qstats["category_depth"] is None else ramp(qstats["category_depth"], 0.50, 1.00),
                   6, "ramp", (0.50, 1.00), "rulebook",
                   f"Out of {num(size.category_count)} categories in a {size.name.upper()} game. "
                   f"Two matters because Drained Brain bans three questions across different "
                   f"categories and Spotty Memory forces a category on you.",
                   questions_available and qstats["category_depth"] is not None),
        _s3_metric("B3", "Mean quality of the functional questions", qstats["mean_quality"], "0–1",
                   None if qstats["mean_quality"] is None else ramp(qstats["mean_quality"], 0.25, 0.65),
                   5, "ramp", (0.25, 0.65), "interp",
                   "A live question that splits the map 97/3 is technically alive and practically "
                   "useless.",
                   questions_available and qstats["mean_quality"] is not None),
        _s3_metric("B4", "Randomize risk", qstats["randomize_risk"], "share",
                   None if qstats["randomize_risk"] is None else rramp(qstats["randomize_risk"], 0.10, 0.40),
                   4, "rramp", (0.10, 0.40), "rulebook",
                   "Randomize redraws within the same category, so the category-weighted dead "
                   "share is exactly the chance the powerup hands the hider a free card. The "
                   "rulebook permits a randomize onto a null question outright.",
                   questions_available and qstats["randomize_risk"] is not None),
    ]

    headway = view.get("median_headway_min")
    t90 = view.get("t90_min")
    frequent = view.get("frequent_share")
    traverse = None if t90 is None or hiding_h <= 0 else float(t90) / size.hiding_period_min
    c = [
        _s3_metric("C1", "Median per-stop headway", headway, "min",
                   None if headway is None else rramp(float(headway), 10, 45), 8,
                   "rramp", (10, 45), "interp",
                   "All routes combined, 06:00–22:00, medianed across served stops. Monotone on "
                   "purpose: Tokyo and London are the rulebook's own showcase maps, so frequency "
                   "is never the flaw.",
                   headway is not None),
        _s3_metric("C2", "Traverse ratio (T90 ÷ hiding period)", traverse, "ratio",
                   None if traverse is None else plateau(traverse, 0.40, 0.80, 2.50, 4.50), 7,
                   "plateau", (0.40, 0.80, 2.50, 4.50), "feed",
                   f"Crossing this network costs {num(traverse or 0, 2)} hiding periods. Below "
                   f"0.40 the map collapses — every radar is yes and “far away” stops existing. "
                   f"Above 4.50 the map is bigger than the game.",
                   traverse is not None),
        _s3_metric("C3", "Share of stops on a frequent route-direction", frequent, "share",
                   None if frequent is None else ramp(float(frequent), 0.05, 0.50), 5,
                   "ramp", (0.05, 0.50), "interp",
                   "A single route-direction at 15 minutes or better. The frequent network is what "
                   "the seekers actually chase along.",
                   frequent is not None),
    ]

    span = view.get("span_hours")
    evening = view.get("evening_zone_share")
    full_days = view.get("full_service_date_share")
    span_ratio = None if span is None or required <= 0 else float(span) / required
    d = [
        _s3_metric("D1", "Service span ÷ the size's playing hours", span_ratio, "ratio",
                   None if span_ratio is None else ramp(span_ratio, 0.60, 1.00), 6,
                   # The rulebook gives a size's length only as prose — SMALL "lasts 4–8
                   # hours", MEDIUM "lasts about 1 day", LARGE "lasts 2 to 4 days"
                   # (GUIDE.md "Choosing Game Size"). It never prints a playing-hours
                   # figure, so `required_hours` is OURS: those durations read as a single
                   # playing DAY, which is the unit D1 needs because it divides ONE day's
                   # service span. SMALL's 6 sits inside the stated 4–8; 10 and 12 stay
                   # under the ~14 hours a playing day can hold once the rulebook's own
                   # "minimum of 10 hours" of rest comes out of the 24. So D1 and its
                   # 0.60/1.00 bounds are `interp`, not `rulebook`; the numbers are unchanged.
                   "ramp", (0.60, 1.00), "interp",
                   f"The rulebook says a {size.name.upper()} game "
                   f"{_S3_SIZE_STATED_LENGTH.get(size.name, 'runs to no stated number of hours')}; "
                   f"we read that as about {num(required)} hours of play in a day. At 0.6 "
                   f"you end the round because the buses stopped, not because someone was found.",
                   span_ratio is not None),
        _s3_metric("D2", "Zones still served at the end of the round", evening, "share",
                   None if evening is None else ramp(float(evening), 0.30, 0.85), 5,
                   "ramp", (0.30, 0.85), "interp",
                   "Zones with a departure after first departure plus the size's playing hours. "
                   "This asks whether the *map* survives to the end, not just the single latest bus.",
                   evening is not None),
        _s3_metric("D3", "Dates running full service", full_days, "share",
                   None if full_days is None else ramp(float(full_days), 0.70, 1.00), 4,
                   "ramp", (0.70, 1.00), "interp",
                   "Catches school-term-only, seasonal and holiday-riddled feeds, which look fine "
                   "on a single representative day.",
                   full_days is not None),
    ]

    weekend = view.get("weekend_ratio")
    playable = view.get("playable_day_weight")
    e = [
        _s3_metric("E1", "Weekend service ratio", 1.0 if not weekend_available else weekend, "ratio",
                   1.0 if not weekend_available else (
                       None if weekend is None else ramp(float(weekend), 0.15, 0.60)),
                   5, "ramp", (0.15, 0.60), "interp",
                   weekend_note or "The quieter weekend day's trips over a weekday's. The game is "
                                   "overwhelmingly played on days off.",
                   True if not weekend_available else weekend is not None),
        _s3_metric("E2", "Playable share of the calendar week", playable, "share",
                   None if playable is None else min(1.0, max(0.0, float(playable))), 5,
                   "ramp", (0.0, 1.0), "interp",
                   "One seventh per calendar weekday whose service keeps 60% of the best day's "
                   "zones and 70% of the size's playing hours.",
                   playable is not None),
    ]

    hub = view.get("hub_dominance")
    isolated = view.get("isolated_zone_share")
    multi = view.get("multi_route_stop_share")
    f = [
        _s3_metric("F1", "Route share at the busiest stop", hub, "share",
                   None if hub is None else rramp(float(hub), 0.25, 0.90), 5,
                   "rramp", (0.25, 0.90), "interp",
                   "A strongly radial network means every hider journey is hub-out and seekers "
                   "camping the hub see most of the system.",
                   hub is not None),
        _s3_metric("F2", "Isolated zones", isolated, "share",
                   None if isolated is None else rramp(float(isolated), 0.15, 0.50), 3,
                   "rramp", (0.15, 0.50), "interp",
                   "Zones whose nearest neighbour is more than two zone radii away. An isolated "
                   "zone is pinned by a single radar.",
                   isolated is not None),
        _s3_metric("F3", "Stops with two or more routes", multi, "share",
                   None if multi is None else ramp(float(multi), 0.10, 0.40), 2,
                   "ramp", (0.10, 0.40), "rulebook",
                   "Drives the Transit Line question's discriminating power and whether Curse of "
                   "the U-Turn has an escape hatch.",
                   multi is not None),
    ]

    blocks = (("A", "Zone supply", a, 200), ("B", "Question health", b, 250),
              ("C", "Mobility & tempo", c, 200), ("D", "Round viability", d, 150),
              ("E", "Schedule resilience", e, 100), ("F", "Structural fairness", f, 100))
    out: list[SubScore] = []
    for sid, name, rows, full in blocks:
        available = [m for m in rows if m.available]
        avail_max = sum(m.max_tenths for m in available)
        earned = sum(m.points_tenths for m in available)
        missing = tuple(m.id for m in rows if not m.available)
        if avail_max == 0:
            out.append(SubScore(sid, name, rows, 0, full, True, missing))
        else:
            scaled = int(rhu(earned * full / avail_max))
            out.append(SubScore(sid, name, rows, scaled, full, bool(missing), missing))
    return out


def score_fitness(metrics: dict[str, Any], questions: Sequence[QuestionAudit],
                  zones: Sequence[Zone], zone_scores: dict[str, ZoneScore],
                  size: GameSize, days: Sequence[ServiceDay]) -> Fitness:
    """The 100-point city rating: six sub-scores, 18 named metrics, all traceable.

        A Zone supply 20 · B Question health 25 · C Mobility & tempo 20
        D Round viability 15 · E Schedule resilience 10 · F Structural fairness 10

    Every threshold is a ratio against a rulebook parameter or against the feed
    itself, so the model ports from a 1,493-stop bus feed to a national rail network
    without editing. Frequency is deliberately **monotone**; map *collapse* lives
    entirely on `C2 = T90 / hiding_period`, a plateau, so there is no absolute size
    constant anywhere.

    Five named caps can only *lower* the score, and the trace shows both values.
    Degradation is drop-and-renormalise; above 40% missing points, no headline number
    is printed at all.
    """
    qstats = _s3_question_stats(questions, size)
    # B is only meaningful when most of the catalogue could actually be evaluated.
    # With Overpass down, two thirds of the questions are `unknown`, and scoring the
    # remainder as if it were the whole toolkit would be a fiction. Drop the whole
    # sub-score instead and let the headline say "computed from 75 of 100 points"
    # (scoring.md §1.10.2).
    questions_available = qstats["total"] >= 6 and qstats["total"] >= 0.5 * size.catalogue_size

    n = len(zones)
    shared = None
    if zone_scores and n:
        shared = sum(1 for zid in sorted(zone_scores) if zone_scores[zid].surv_k > 1.0 / n) / n

    dow_types = {k: v for k, v in sorted((metrics.get("dow_day_type") or {}).items()) if v}
    single_type = len(set(dow_types.values())) <= 1 and len(dow_types) == 7
    weekend_note = ""
    if single_type:
        weekend_note = ("This feed distinguishes one service day type across the whole week, so no "
                        "weekend collapse is possible and this metric scores full marks.")

    head_view = _s3_view(metrics, None, size)
    subs = _s3_subscores(head_view, qstats, size, shared, not single_type, weekend_note,
                         questions_available)

    available_points = sum(s.max_tenths for s in subs
                           if any(m.available for m in s.metrics)) / 10.0
    earned_tenths = sum(s.earned_tenths for s in subs if any(m.available for m in s.metrics))
    raw = 0.0 if available_points <= 0 else earned_tenths / 10.0 / available_points * 100.0
    raw = rhu(raw, 1)

    # ── caps: they only ever lower, and each names itself ─────────────────────
    caps = [row for row in fitness_caps(metrics, questions, zones, size, days) if row["fired"]]
    score: float | None = raw
    capped_by: str | None = None
    for row in sorted(caps, key=lambda r: (r["cap"], r["id"])):
        if score is not None and score > row["cap"]:
            score, capped_by = row["cap"], row["id"]
            break

    if available_points < 60.0:
        score = None

    band = "insufficient data for an overall rating"
    if score is not None:
        for threshold, name, _advice in _S3_BANDS:
            if score >= threshold:
                band = name
                break

    # ── the same arithmetic, once per service day, for the day switcher ───────
    per_day: dict[str, float] = {}
    for day_key in sorted((metrics.get("per_day") or {})):
        view = _s3_view(metrics, day_key, size)
        rows = _s3_subscores(view, qstats, size, shared, not single_type, weekend_note,
                             questions_available)
        avail = sum(s.max_tenths for s in rows if any(m.available for m in s.metrics)) / 10.0
        got = sum(s.earned_tenths for s in rows if any(m.available for m in s.metrics))
        value = 0.0 if avail <= 0 else rhu(got / 10.0 / avail * 100.0, 1)
        for row in sorted(caps, key=lambda r: (r["cap"], r["id"])):
            if row["id"] != "CAP_SPAN" and value > row["cap"]:
                value = row["cap"]
        day_span = float(view.get("span_hours") or 0.0)
        if day_span < 4.0 and value > 25.0:
            value = 25.0
        per_day[day_key] = value

    return Fitness(score=score, raw_score=raw, capped_by=capped_by, band=band,
                   subscores=subs, available_points=rhu(available_points, 1), per_day=per_day)


def fitness_caps(metrics: dict[str, Any], questions: Sequence[QuestionAudit],
                 zones: Sequence[Zone], size: GameSize,
                 days: Sequence[ServiceDay]) -> list[dict[str, Any]]:
    """All five guard rails, fired or not, each with the sentence that explains it.

    `score_fitness` consumes the fired rows; the renderer prints the whole list, so
    "CAP_CATEGORIES — not evaluated" is visible rather than silently absent. A cap
    can only ever *lower* a score. Sorted by id.
    """
    qstats = _s3_question_stats(questions, size)
    view = _s3_view(metrics, None, size)
    n = len(zones)
    per_day = metrics.get("per_day") or {}
    spans = [float((per_day.get(k) or {}).get("span_hours") or 0.0) for k in sorted(per_day)]
    longest = max(spans) if spans else None
    reach = view.get("reachable_zone_share")
    one_route = _s3_one_route_share(days)
    evaluated = qstats["total"] >= 6 and qstats["total"] >= 0.5 * size.catalogue_size

    rows: list[dict[str, Any]] = [
        {"id": "CAP_ZONES", "cap": 40.0, "fired": bool(n and n < 30), "evaluated": bool(n),
         "why": (f"{num(n)} distinct hiding zones, against the rulebook's own SMALL floor of 30 "
                 f"stations." if n else "No zones were built, so this could not be evaluated.")},
        {"id": "CAP_CATEGORIES", "cap": 45.0,
         "fired": evaluated and qstats["categories_with_live"] < 3, "evaluated": evaluated,
         "why": (f"{num(qstats['categories_with_live'])} of {num(size.category_count)} question "
                 f"categories have at least one functional question."
                 if evaluated else
                 "Too few questions could be evaluated to judge category coverage; not evaluated.")},
        {"id": "CAP_SPAN", "cap": 25.0,
         "fired": longest is not None and longest < 4.0, "evaluated": longest is not None,
         "why": (f"The longest service day spans {num(longest or 0, 1)} hours, against the "
                 f"rulebook's shortest game of 4." if longest is not None
                 else "No service day was measured; not evaluated.")},
        {"id": "CAP_UNREACHABLE", "cap": 45.0,
         "fired": reach is not None and float(reach) < 0.15, "evaluated": reach is not None,
         "why": (f"{pct(float(reach))} of zones are reachable inside the hiding period from the "
                 f"start location." if reach is not None
                 else "Reachability was not computed; not evaluated.")},
        {"id": "CAP_ONE_ROUTE", "cap": 50.0, "fired": one_route >= 0.90, "evaluated": bool(days),
         "why": (f"The single most widespread route reaches {pct(one_route)} of served stops. "
                 f"Above 90% the map is one-dimensional and every question degenerates to "
                 f"position along the line." if days
                 else "No service day was available; not evaluated.")},
    ]
    return sorted(rows, key=lambda r: r["id"])


# ═══════════════════════════════════════════════════════════════════════════════
# S3 · HIDING-ZONE RATING
# ═══════════════════════════════════════════════════════════════════════════════

_S3_GREEDY_K = {"small": 3, "medium": 4, "large": 5}

# Equal-area polar sample of a disc: 8 rings × 16 spokes = 128 points, used for the
# share of a zone circle that falls outside the map border.
_S3_DISC_SAMPLE: tuple[tuple[float, float], ...] = tuple(
    (math.sqrt((ring + 0.5) / 8.0) * math.cos(2 * math.pi * spoke / 16.0),
     math.sqrt((ring + 0.5) / 8.0) * math.sin(2 * math.pi * spoke / 16.0))
    for ring in range(8) for spoke in range(16)
)


def _s3_edge_fraction(zone: Zone, bbox: tuple[float, float, float, float],
                      radius_m: float, proj: Projection) -> float:
    """Share of the zone circle's area that lies outside the map border."""
    outside = 0
    for ux, uy in _S3_DISC_SAMPLE:
        lon, lat = proj.lonlat(zone.x + ux * radius_m, zone.y + uy * radius_m)
        if not bbox_contains(bbox, lat, lon):
            outside += 1
    return outside / len(_S3_DISC_SAMPLE)


def _s3_zone_headway_min(zone: Zone, day: ServiceDay) -> float | None:
    """Median gap between departures from anywhere inside the zone circle, 06:00–22:00."""
    lo = hms_to_s(HEADWAY_WINDOW[0]) or 0
    hi = hms_to_s(HEADWAY_WINDOW[1]) or SERVICE_DAY_SECONDS
    times: list[int] = []
    for sid in zone.stop_ids:
        sd = day.stop_days.get(sid)
        if sd is None:
            continue
        times.extend(t for t in sd.departures if lo <= t <= hi)
    times = sorted(set(times))
    if len(times) < 2:
        return None
    gaps = [(times[i + 1] - times[i]) / 60.0 for i in range(len(times) - 1)]
    return quantile(gaps, 0.5)


def _s3_zone_last_arrival_s(zone: Zone, day: ServiceDay) -> int | None:
    """The latest departure from anywhere inside the zone circle."""
    best: int | None = None
    for sid in zone.stop_ids:
        sd = day.stop_days.get(sid)
        if sd is None or sd.last is None:
            continue
        best = sd.last if best is None else max(best, sd.last)
    return best


def _s3_neighbour_count(zones: Sequence[Zone], radius_m: float) -> list[int]:
    """Other zones within `radius_m` of each zone, by an x-sweep."""
    n = len(zones)
    if n < 2:
        return [0] * n
    order = sorted(range(n), key=lambda i: (zones[i].x, zones[i].y, zones[i].zone_id))
    xs = [zones[i].x for i in order]
    ys = [zones[i].y for i in order]
    out = [0] * n
    for pos in range(n):
        i = order[pos]
        count = 0
        for step in (1, -1):
            j = pos + step
            while 0 <= j < n and abs(xs[j] - xs[pos]) <= radius_m:
                if math.hypot(xs[j] - xs[pos], ys[j] - ys[pos]) <= radius_m:
                    count += 1
                j += step
        out[i] = count
    return out


def _s3_spot_clusters(spots: Sequence[dict[str, Any]], proj: Projection,
                      link_m: float = 100.0) -> int:
    """Single-link clusters of candidate legal spots, at 100 m."""
    pts = [proj.xy(float(s["lat"]), float(s["lon"])) for s in spots]
    n = len(pts)
    if n == 0:
        return 0
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(n):
        for j in range(i + 1, n):
            if math.dist(pts[i], pts[j]) <= link_m:
                a, b = find(i), find(j)
                if a != b:
                    parent[max(a, b)] = min(a, b)
    return len({find(i) for i in range(n)})


def score_zones(zones: Sequence[Zone], questions: Sequence[QuestionAudit],
                signatures: dict[str, Sequence[Any]], surv: dict[str, list[float]],
                geo: GeoData, day: ServiceDay, times: TravelTimes,
                back: dict[str, int], size: GameSize, metrics: dict[str, Any],
                proj: Projection) -> dict[str, ZoneScore]:
    """Score every zone on six axes, 100 points.

        IR information resistance 30 · R reachability 15 · S redundancy & exit 15
        E endgame spots 15 · A amenities 15 · X exposure 10

    IR replaces the hand-assigned "hideability" of the drafts with the computed
    survival model. R1 and X3 deliberately pull in opposite directions and the page
    must say why: the hider travels with certainty at the start, the seekers travel
    under uncertainty later, so the best zone is cheap for you to reach now and
    expensive for them to reach then.

    Flags cap rather than override: `pinned` caps at 45, `no_legal_spot` at 40.
    `unreachable` and `no_service` zones are *excluded* from the ranking and listed
    separately with their times — never silently dropped.

    Side effect, by design: this is the only function that sees both the audit rows
    and the survival table, so it fills `QuestionAudit.surv_mean` in place.
    """
    n = len(zones)
    out: dict[str, ZoneScore] = {}
    if n == 0:
        return out

    defs = {q.id: q for q in QUESTIONS}
    audits = {q.id: q for q in questions}
    live_ids = sorted(qid for qid in surv if qid in defs and len(surv[qid]) == n)

    # QuestionAudit.surv_mean — the funnel and the question table both print it.
    for qid in live_ids:
        row = audits.get(qid)
        if row is not None:
            values = surv[qid]
            row.surv_mean = rhu(sum(sorted(values)) / n, 4)

    k = _S3_GREEDY_K.get(size.name, 4)
    order, _funnel = global_question_order(questions, signatures, zones, k)
    surv_k = _s3_joint_block_share(order, signatures, zones)
    ref = _s3_reference_seeker(zones)

    hiding_min = float(size.hiding_period_min)
    radius_m = float(size.zone_radius_m)
    t90 = float(metrics.get("t90_min") or 0.0)
    border_bbox = geo.bbox if geo.bbox else bbox_of([(z.lat, z.lon) for z in zones])
    neighbour_radius = (0.5 if size.name == "small" else 1.0) * M_PER_MILE
    neighbours = _s3_neighbour_count(zones, neighbour_radius)

    first_dep = float(metrics.get("first_departure_s") or 0.0)
    game_end_s = first_dep + size.required_hours * 3600.0
    last_arrivals = [a for a in (_s3_zone_last_arrival_s(z, day) for z in zones) if a is not None]
    median_last = quantile(last_arrivals, 0.5) if last_arrivals else None

    for index, zone in enumerate(zones):
        metrics_rows: list[Metric] = []
        flags: list[str] = []

        # ── IR · information resistance ──────────────────────────────────────
        per_q = sorted(
            ((qid, surv[qid][index], defs[qid].keep) for qid in live_ids),
            key=lambda row: (row[1], row[0]))
        pin_worst = 0.0
        weighted, weights = 0.0, 0.0
        for qid, value, cost in per_q:
            pin_worst = max(pin_worst, (1.0 - value) / cost)
            weighted += value / cost
            weights += 1.0 / cost
        mean_surv = weighted / weights if weights else 1.0
        joint = surv_k[index] if index < len(surv_k) else 1.0
        have_ir = bool(per_q)

        metrics_rows.append(_s3_metric(
            "IR1", "Zones sharing your answers to the map's best questions", joint, "share",
            ramp(joint, 1.0 / n, 0.10) if have_ir else None, 12, "ramp", (1.0 / n, 0.10),
            "interp",
            f"Full marks if at least 10% of the map still answers exactly like you after the "
            f"seekers' best {num(k)} questions. The floor is 1/{num(n)} — being the only one.",
            have_ir))
        metrics_rows.append(_s3_metric(
            "IR2", "Worst single question, per card it costs", pin_worst, "0–1",
            rramp(pin_worst, 0.50, 0.95) if have_ir else None, 10, "rramp", (0.50, 0.95),
            "interp",
            "At 0.95 one draw-3-keep-1 question leaves 5% of the map — the uniquely-identifiable "
            "failure. Divided by the cards the question pays you, so an expensive question that "
            "finds you is less of an indictment.",
            have_ir))
        metrics_rows.append(_s3_metric(
            "IR3", "Average anonymity across every live question", mean_surv, "0–1",
            ramp(mean_surv, 0.45, 0.78) if have_ir else None, 8, "ramp", (0.45, 0.78), "interp",
            "Cost-weighted mean survival: general anonymity rather than the worst case. 0.5 is the "
            "coin-flip baseline every binary question achieves against a balanced map.",
            have_ir))

        threats: list[Threat] = []
        for qid, value, _cost in per_q[:3]:
            q = defs[qid]
            _cls, wording = _s3_answer(q, signatures[qid], zones, index, ref)
            threats.append(Threat(question_id=qid,
                                  label=audits[qid].label if qid in audits else q.label,
                                  surv=rhu(value, 4), answer=wording,
                                  zones_remaining=int(rhu(value * n))))

        # ── R · reachability ─────────────────────────────────────────────────
        arrival = times.arrival_s.get(zone.zone_id)
        travel_min = None if arrival is None else (arrival - times.departure_s) / 60.0
        transfers = times.rounds.get(zone.zone_id)
        travel_frac = None if travel_min is None else travel_min / hiding_min
        r1_frac = None
        if travel_frac is not None:
            r1_frac = 0.0 if travel_frac > 1.0 else plateau(travel_frac, 0.10, 0.30, 0.85, 1.00)
        metrics_rows.append(_s3_metric(
            "R1", "Travel time from the start, ÷ the hiding period", travel_frac, "ratio",
            r1_frac, 9, "plateau", (0.10, 0.30, 0.85, 1.00), "rulebook",
            f"Above 1.0 you cannot legally be here: the hiding period is "
            f"{num(size.hiding_period_min)} minutes and wherever you are when it ends is your "
            f"zone. Below 0.10 you are still standing where the seekers start.",
            travel_min is not None))
        r2_frac = None
        if transfers is not None:
            r2_frac = 1.0 if transfers <= 1 else (0.6 if transfers == 2 else 0.2)
        metrics_rows.append(_s3_metric(
            "R2", "Transfers on the best journey", transfers, "changes", r2_frac, 6,
            "table", (0, 1, 2, 3), "interp",
            "Each change on an infrequent network risks the whole window; a missed connection is "
            "a whole headway.",
            transfers is not None))

        # ── S · service redundancy and exit ──────────────────────────────────
        routes = len(zone.route_ids)
        s1_frac = 0.2 if routes <= 1 else (0.6 if routes == 2 else 1.0)
        metrics_rows.append(_s3_metric(
            "S1", "Distinct routes inside the zone", routes, "routes",
            s1_frac if routes else None, 6, "table", (1, 2, 3), "rulebook",
            # Both clauses are hider-negative, which is why one route scores 0.2. The
            # U-Turn card's parenthetical is a let-off for the SEEKERS — they disembark
            # only "as long as that station is serviced by another form of transit"
            # inside the window — so a one-route zone is where that escape hatch is
            # always open and the curse fizzles. F3 and the u_turn curse finding read it
            # the same way; this sentence used to say the opposite. The 0.2/0.6/1.0
            # table is unchanged.
            "One route means the Transit Line matching question names you, and Curse of the "
            "U-Turn fizzles here: with no second form of transit at the station, the card's "
            "escape hatch is always open and the seekers stay on board.",
            routes > 0))
        home = back.get(zone.zone_id)
        exit_margin = None if home is None else (home - game_end_s) / 60.0
        metrics_rows.append(_s3_metric(
            "S2", "Minutes of margin on the last ride home", exit_margin, "min",
            None if exit_margin is None else ramp(exit_margin, -60, 60), 5, "ramp", (-60, 60),
            "interp",
            "The latest departure from here that still reaches the start location, against the end "
            "of a full round. You need to leave for the next round, and the Move powerup needs to "
            "mean something.",
            exit_margin is not None))
        onward = _s3_zone_headway_min(zone, day)
        metrics_rows.append(_s3_metric(
            "S3", "Median gap between departures from the zone", onward, "min",
            None if onward is None else rramp(onward, 10, 60), 4, "rramp", (10, 60), "rulebook",
            f"The Move powerup grants {num(size.move_grant_min)} minutes to establish a brand-new "
            f"zone; a 60-minute headway makes that unplayable from here. Scored out of 4 rather "
            f"than 5 so the three service metrics sum to the axis's 15 points.",
            onward is not None))

        # ── E · endgame spots ────────────────────────────────────────────────
        spots = (geo.legal_spots.get(zone.zone_id) or []) if geo.available else []
        osm_ready = geo.available and zone.zone_id in geo.zone_inventory
        spot_weight = sum(float(s.get("weight") or 0.0) for s in spots)
        clusters = _s3_spot_clusters(spots, proj) if spots else 0
        enclosed_share = (sum(1 for s in spots if s.get("enclosed")) / len(spots)) if spots else 0.0
        metrics_rows.append(_s3_metric(
            "E1", "Candidate legal hiding spots", spot_weight, "weighted count",
            ramp(spot_weight, 0, 12) if osm_ready else None, 8, "ramp", (0, 12), "interp",
            "Publicly accessible and within 10 ft of a routable path. Features with restrictive "
            "opening hours count half and are marked verify-on-the-ground: OpenStreetMap does not "
            "know whether a plaza is locked at night.",
            osm_ready))
        metrics_rows.append(_s3_metric(
            "E2", "Separate spot clusters", clusters, "clusters",
            ramp(clusters, 1, 5) if osm_ready else None, 4, "ramp", (1, 5), "rulebook",
            "You may wander until the end game triggers, so separate clusters mean the seekers' "
            "entry point does not decide your fate.",
            osm_ready))
        metrics_rows.append(_s3_metric(
            "E3", "Spots enclosed by a park, plaza or campus", enclosed_share, "share",
            ramp(enclosed_share, 0.10, 0.60) if osm_ready else None, 3, "ramp", (0.10, 0.60),
            "interp",
            "A spot inside a polygon beats a lone point on a pavement.",
            osm_ready))

        # ── A · amenities ────────────────────────────────────────────────────
        inv = (geo.zone_inventory.get(zone.zone_id) or {}) if geo.available else {}
        hits = (geo.zone_polygon_hits.get(zone.zone_id) or {}) if geo.available else {}
        toilet = 0.0
        if inv.get("toilets", 0) > 0:
            toilet = 1.0
        elif inv.get("toilets_wide", 0) > 0:
            toilet = 0.5
        if inv.get("library", 0) > 0 or hits.get("park") or inv.get("park", 0) > 0:
            toilet += 1.0
        metrics_rows.append(_s3_metric(
            "A1", "A bathroom you can actually use", min(1.0, toilet), "0–1",
            min(1.0, toilet) if osm_ready else None, 6, "ramp", (0, 1), "rulebook",
            "The rulebook's strongest packing advice is to make sure there is a bathroom you can "
            "access. Mapped toilets score 1.0, one just outside the circle 0.5, and a library or "
            "park inside the circle adds 1.0.",
            osm_ready))
        food = sum(inv.get(key, 0) for key in ("cafe", "restaurant", "fast_food", "grocery"))
        metrics_rows.append(_s3_metric(
            "A2", "Food and water inside the circle", food, "places",
            ramp(food, 0, 6) if osm_ready else None, 5, "ramp", (0, 6), "rulebook",
            "Cafés, restaurants, fast food and groceries. The rulebook tells you to identify these "
            "in your zone before the round starts.",
            osm_ready))
        shelter = (inv.get("shelter", 0) * 1.5
                   + min(2.0, inv.get("bench", 0) * 0.25)
                   + (1.0 if hits.get("park") else 0.0))
        metrics_rows.append(_s3_metric(
            "A3", "Shelter from the weather", shelter, "score",
            ramp(shelter, 0, 5) if osm_ready else None, 4, "ramp", (0, 5), "interp",
            "Shelters count 1.5, benches 0.25 up to 2, a park polygon reaching the circle 1.0. "
            "Weather is a stated rulebook concern that this pipeline cannot forecast; shelter is "
            "the computable proxy.",
            osm_ready))

        # ── X · exposure ─────────────────────────────────────────────────────
        edge = _s3_edge_fraction(zone, border_bbox, radius_m, proj)
        metrics_rows.append(_s3_metric(
            "X1", "Share of your circle outside the border", edge, "share",
            rramp(edge, 0.0, 0.35), 4, "rramp", (0.0, 0.35), "interp",
            "An edge zone loses usable ground and is pinned by the border measuring questions.",
            True))
        metrics_rows.append(_s3_metric(
            "X2", f"Other zones within {miles(neighbour_radius)}", neighbours[index], "zones",
            ramp(neighbours[index], 0, 8), 3, "ramp", (0, 8), "interp",
            "The geometric, OSM-free version of information resistance: it survives an Overpass "
            "outage and it is what a radar actually measures.",
            True))
        seeker_frac = None if (travel_min is None or t90 <= 0) else travel_min / t90
        metrics_rows.append(_s3_metric(
            "X3", "Seeker travel cost to reach you, ÷ T90", seeker_frac, "ratio",
            None if seeker_frac is None else ramp(seeker_frac, 0.20, 0.80), 3, "ramp", (0.20, 0.80),
            "feed",
            "Measured on the same run as R1, from the round-start location. R1 and X3 pull in "
            "opposite directions on purpose: you travel here with certainty on the first bus, the "
            "seekers travel here later under uncertainty and often back through the hub.",
            seeker_frac is not None))

        # ── axes, caps and flags ─────────────────────────────────────────────
        axis_of = {"IR": ("IR1", "IR2", "IR3"), "R": ("R1", "R2"), "S": ("S1", "S2", "S3"),
                   "E": ("E1", "E2", "E3"), "A": ("A1", "A2", "A3"), "X": ("X1", "X2", "X3")}
        by_id = {m.id: m for m in metrics_rows}
        axes: dict[str, int] = {}
        axis_max: dict[str, int] = {}
        for axis in sorted(axis_of):
            rows = [by_id[mid] for mid in axis_of[axis] if mid in by_id]
            available = [m for m in rows if m.available]
            axes[axis] = sum(m.points_tenths for m in available)
            axis_max[axis] = sum(m.max_tenths for m in available)
        total_max = sum(axis_max[a] for a in sorted(axis_max))
        total_earned = sum(axes[a] for a in sorted(axes))
        overall = int(rhu(1000.0 * total_earned / total_max)) if total_max else 0

        if not zone.route_ids or (_s3_zone_last_arrival_s(zone, day) is None):
            flags.append("no_service")
        if travel_min is None:
            flags.append("unreachable")
        elif travel_min > hiding_min:
            flags.append("unreachable")
        cheap_pin = max((1.0 - value for qid, value, cost in per_q if cost == 1), default=0.0)
        if cheap_pin >= 0.95:
            flags.append("pinned")
        if osm_ready and spot_weight <= 0.0:
            flags.append("no_legal_spot")
        if osm_ready and toilet <= 0.0:
            flags.append("no_toilet")
        zone_last = _s3_zone_last_arrival_s(zone, day)
        if median_last is not None and zone_last is not None and zone_last <= median_last - 3600:
            flags.append("strands_seekers")
        if edge > 0.25:
            flags.append("edge_zone")
        if osm_ready and sum(v for key, v in sorted(inv.items()) if key != "toilets_wide") < 10:
            flags.append("osm_thin")

        capped_by: str | None = None
        if "pinned" in flags and overall > 450:
            overall, capped_by = 450, "pinned"
        if "no_legal_spot" in flags and overall > 400:
            overall, capped_by = 400, "no_legal_spot"

        excluded = "unreachable" in flags or "no_service" in flags
        reason = ""
        if "no_service" in flags:
            reason = "No departures from this zone on the selected service day."
        elif "unreachable" in flags:
            reason = (f"Not reachable from the start location inside the "
                      f"{num(size.hiding_period_min)}-minute hiding period"
                      + (f" ({mins(travel_min)})." if travel_min is not None
                         else " — no journey found at all."))

        out[zone.zone_id] = ZoneScore(
            zone_id=zone.zone_id, overall_tenths=overall, capped_by=capped_by,
            axes=axes, axis_max=axis_max, metrics=metrics_rows,
            flags=tuple(sorted(set(flags))), threats=tuple(threats),
            surv_k=rhu(joint, 4), pin_worst=rhu(pin_worst, 4), mean_surv=rhu(mean_surv, 4),
            excluded=excluded, exclude_reason=reason,
        )
    return out


def rank_zones(zone_scores: dict[str, ZoneScore]) -> list[str]:
    """Rank key `(−overall_tenths, −IR, −R, zone_id)`. Fully deterministic.

    Excluded zones (unreachable, or no service on the selected day) are left out of
    the ranking; they are never dropped from `zone_scores`, so the page can list them
    separately with their times.
    """
    live = [z for z in sorted(zone_scores) if not zone_scores[z].excluded]
    return sorted(live, key=lambda zid: (
        -zone_scores[zid].overall_tenths,
        -zone_scores[zid].axes.get("IR", 0),
        -zone_scores[zid].axes.get("R", 0),
        zid,
    ))


def select_dossiers(ranked: Sequence[str], zone_scores: dict[str, ZoneScore],
                    zones: dict[str, Zone], radius_m: float) -> list[str]:
    """Choose the diversified dossier set by deterministic maximal marginal relevance.

    Walk the ranked list and accept a zone when it is at least `8 × zone_radius` from
    every already-accepted zone, or when it scores ≥5 points better than the nearest
    accepted one. Target `min(12, max(6, round(n / 25)))`. Then append the **axis
    winners** — the top zone on each of IR, R, S, E, A, X — so the most
    information-resistant zone on the map appears even if it ranks 60th overall
    because it has no toilet.
    """
    n = len(ranked)
    if n == 0:
        return []
    target = min(12, max(6, int(rhu(n / 25.0))))
    if n <= 12:
        return list(ranked)

    separation = 8.0 * radius_m
    accepted: list[str] = []
    for zid in ranked:
        z = zones.get(zid)
        if z is None:
            continue
        if not accepted:
            accepted.append(zid)
            continue
        nearest, nearest_d = accepted[0], float("inf")
        for other in accepted:
            oz = zones.get(other)
            if oz is None:
                continue
            d = math.hypot(z.x - oz.x, z.y - oz.y)
            if d < nearest_d:
                nearest_d, nearest = d, other
        better = (zone_scores[zid].overall_tenths
                  >= zone_scores[nearest].overall_tenths + 50)
        if nearest_d >= separation or better:
            accepted.append(zid)
        if len(accepted) >= target:
            break

    for axis in ("IR", "R", "S", "E", "A", "X"):
        winner = sorted(
            ranked,
            key=lambda zid: (-zone_scores[zid].axes.get(axis, 0),
                             -zone_scores[zid].overall_tenths, zid))[0]
        if winner not in accepted:
            accepted.append(winner)
    return accepted


# ═══════════════════════════════════════════════════════════════════════════════
# S3 · FINDINGS, HOUSE RULES, PROVENANCE
# ═══════════════════════════════════════════════════════════════════════════════

# Mitigations keyed by metric id. A minus with a mitigation becomes a `concern`
# (something you can play around); a minus without one stays a `minus`.
_S3_MITIGATION: dict[str, str] = {
    "A2": "Move the start location to a stop nearer the middle of the network, or play the next "
          "size down so the hiding period matches the map.",
    "B1": "Pre-brief the dead question list before the round starts, so nobody spends a card "
          "buying a null.",
    "B4": "Consider removing Randomize from the deck, or agreeing that a randomize onto a "
          "known-dead question is rerolled.",
    "C1": "Agree that the seekers may check the live timetable at any time; on this map the wait "
          "is the game.",
    "C2": "Shrink the border, or step the game size up one so the hiding period matches how long "
          "crossing this map actually takes.",
    "D1": "Set an explicit end-of-game timer rather than playing until the buses stop.",
    "D2": "End the round earlier than the size's nominal length, or move the start time earlier.",
    "D3": "Check the date you are playing against the feed's own calendar: this feed has days that "
          "run materially less service.",
    "E1": "Play on a weekday or Saturday rather than a Sunday.",
    "E2": "Fix the day of the week before anyone plans anything else.",
    "F1": "Ban camping the hub, or make the hub a neutral zone the seekers may not linger in.",
    "F2": "Consider trimming the outermost isolated zones out of the map.",
    "F3": "Expect Curse of the U-Turn to fizzle and Transit Line to be strong; brief both.",
}


def _s3_finding_detail(metric: Metric, metrics: dict[str, Any],
                       questions: Sequence[QuestionAudit]) -> str:
    """One factual sentence about a metric, in that metric's own units."""
    mid, raw = metric.id, metric.raw
    if mid == "A1":
        return (f"{num(raw or 0)} distinct hiding zones at the size's zone radius, from "
                f"{num(metrics.get('served_stops') or 0)} served stops.")
    if mid == "A2":
        return (f"{num(metrics.get('reach_within_hiding_period') or 0)} of "
                f"{num(metrics.get('served_stops') or 0)} served stops are inside the hiding "
                f"period from the start location.")
    if mid == "A3":
        return (f"{pct(raw or 0)} of zones still share their answers with at least one other zone "
                f"after the map's best questions.")
    if mid == "B1":
        dead = [q for q in questions if q.status in ("dead", "degenerate")]
        return (f"{num(len(dead))} of {num(len(questions))} questions in this size's catalogue are "
                f"dead or degenerate, and every one of them still pays the hider a card if asked.")
    if mid == "B2":
        return f"{pct(raw or 0)} of the size's question categories have two or more functional questions."
    if mid == "B3":
        return f"Mean quality across the functional questions is {num((raw or 0) * 100, 0)} out of 100."
    if mid == "B4":
        return (f"A Randomize redraw lands on a dead or degenerate question about "
                f"{pct(raw or 0)} of the time.")
    if mid == "C1":
        return (f"The median served stop sees a bus every {mins(raw or 0)} between 06:00 and 22:00, "
                f"counting every route together.")
    if mid == "C2":
        return (f"Crossing the network takes {mins(metrics.get('t90_min') or 0, 1)} at the 90th "
                f"percentile, which is {num(raw or 0, 2)} hiding periods.")
    if mid == "C3":
        return f"{pct(raw or 0)} of served stops have a single route-direction at 15 minutes or better."
    if mid == "D1":
        return (f"Service spans {num(metrics.get('span_hours') or 0, 1)} hours, from "
                f"{hhmm(metrics.get('first_departure_s') or 0)} to "
                f"{hhmm(metrics.get('last_departure_s') or 0)}.")
    if mid == "D2":
        return f"{pct(raw or 0)} of zones still have a departure at the end of a full round."
    if mid == "D3":
        return (f"{pct(raw or 0)} of the dates in the feed's validity window run full service; "
                f"{num(len(metrics.get('no_service_dates') or []))} have no service at all.")
    if mid == "E1":
        sat = metrics.get("sat_trip_ratio")
        sun = metrics.get("sun_trip_ratio")
        parts = []
        if sat is not None:
            parts.append(f"Saturday runs {pct(sat)} of a weekday's trips")
        if sun is not None:
            parts.append(f"Sunday runs {pct(sun)}")
        return ("; ".join(parts) + "." if parts else f"Weekend ratio {num(raw or 0, 2)}.")
    if mid == "E2":
        playable = (raw or 0) * 7
        return f"About {num(playable, 1)} of the 7 calendar days are fully playable."
    if mid == "F1":
        return (f"The busiest stop carries {pct(raw or 0)} of all routes, and the network reads as "
                f"{metrics.get('network_shape') or 'unknown'}.")
    if mid == "F2":
        return f"{pct(raw or 0)} of zones have no other zone within two zone radii."
    if mid == "F3":
        return f"{pct(raw or 0)} of served stops carry a second route."
    return f"{metric.name}: {num(raw or 0, 3)} {metric.unit}."


def _s3_day_sensitive(metric_id: str, metrics: dict[str, Any]) -> str | None:
    """The service day a finding is really about, or None."""
    if metric_id not in ("E1", "E2", "C1", "C3", "D1", "D2"):
        return None
    sat = metrics.get("sat_trip_ratio")
    sun = metrics.get("sun_trip_ratio")
    if sun is not None and (sat is None or sun <= sat):
        return metrics.get("sunday_day_key")
    if sat is not None:
        return metrics.get("saturday_day_key")
    return None


def derive_findings(fitness: Fitness, metrics: dict[str, Any],
                    questions: Sequence[QuestionAudit]) -> list[dict[str, Any]]:
    """Emit the findings quadrants from threshold crossings, not from prose.

    A metric earning `< 0.35` of its maximum emits a *minus* (or a *concern* when the
    static mitigation table has an entry for its id); `> 0.85` emits a *plus*.
    Returns rows sorted by `(quadrant, −severity, metric_id)`.

    The **benefit** quadrant has no computable source beyond `fare_attributes.txt`,
    which this function is not handed, so it is dropped rather than invented — which
    is what the contract asks for when the source is absent.
    """
    rank = {"high": 2, "medium": 1, "low": 0}
    rows: list[dict[str, Any]] = []
    for sub in sorted(fitness.subscores, key=lambda s: s.id):
        for metric in sorted(sub.metrics, key=lambda m: m.id):
            if not metric.available or metric.max_tenths <= 0:
                continue
            frac = metric.points_tenths / metric.max_tenths
            if 0.35 <= frac <= 0.85:
                continue
            mitigation = _S3_MITIGATION.get(metric.id)
            if frac < 0.35:
                quadrant = "concern" if mitigation else "minus"
                severity = "high" if frac < 0.15 else ("medium" if frac < 0.25 else "low")
                title = f"{metric.name} scores {num(metric.points_tenths / 10.0, 1)} of " \
                        f"{num(metric.max_tenths / 10.0, 1)}"
            else:
                quadrant = "plus"
                mitigation = None
                severity = "high" if frac >= 0.98 else ("medium" if frac >= 0.92 else "low")
                title = f"{metric.name} is a strength here"
            rows.append({
                "quadrant": quadrant,
                "severity": severity,
                "metric_id": metric.id,
                "title": title,
                "detail": _s3_finding_detail(metric, metrics, questions),
                "mitigation": mitigation,
                "day_sensitive": _s3_day_sensitive(metric.id, metrics),
            })
    rows.sort(key=lambda r: (r["quadrant"], -rank[r["severity"]], r["metric_id"]))
    return rows


def derive_recommendations(report_parts: dict[str, Any]) -> list[dict[str, Any]]:
    """Fire the house rules whose preconditions hold, in fixed priority order.

    One rule **always** fires: agree the safety exclusions — the rulebook demands
    that conversation and explicitly refuses to automate the polygon.
    """
    metrics: dict[str, Any] = report_parts.get("metrics") or {}
    fitness: Fitness | None = report_parts.get("fitness")
    size: GameSize = report_parts["size"]
    hub: Hub | None = report_parts.get("hub")
    border: Border | None = report_parts.get("border")
    curses: Sequence[CurseAudit] = report_parts.get("curses") or ()
    questions: Sequence[QuestionAudit] = report_parts.get("questions") or ()
    feed: Feed | None = report_parts.get("feed")

    per_day = metrics.get("per_day") or {}
    best_key = metrics.get("best_day") or ""
    best_label = (per_day.get(best_key) or {}).get("day_label") or best_key or "the busiest day"
    out: list[dict[str, Any]] = []

    def add(rid: str, priority: int, text: str, evidence: str, required: bool = False) -> None:
        out.append({"id": rid, "priority": priority, "text": text,
                    "evidence": evidence, "required": required})

    # 1 · which day
    weekend = metrics.get("weekend_ratio")
    if weekend is not None and float(weekend) < 0.60:
        add("play_day", 10,
            f"Play on {best_label}. Service on the quieter weekend day drops to "
            f"{pct(float(weekend))} of a weekday's trips, and every question that depends on "
            f"being able to move gets worse with it.",
            f"E1 weekend_ratio = {num(float(weekend), 2)}", required=float(weekend) < 0.35)
    else:
        add("play_day", 10,
            f"Any day works here, but {best_label} carries the most service and is the day every "
            f"number on this page is computed for.",
            f"best day = {best_key}")

    # 2 · where the round starts
    if hub is not None and hub.dominant:
        add("start_at_hub", 20,
            f"Start every round at {hub.name}. It touches {pct(hub.route_share)} of the network's "
            f"routes, so it is the only place from which the whole map is reachable inside the "
            f"hiding period — and it is where the seekers will start anyway.",
            f"F1 hub_dominance = {num(hub.route_share, 3)}, network shape "
            f"{metrics.get('network_shape')}")
    elif hub is not None:
        alts = ", ".join(name for _sid, name in hub.alternatives[:3])
        add("start_at_hub", 20,
            f"This network has no dominant hub, so agree a start station before you begin. The "
            f"three busiest are {hub.name}"
            + (f", {alts}" if alts else "") + ".",
            f"network shape {metrics.get('network_shape')}")

    # 3 · the border
    if border is not None:
        s, w, n_, e = border.bbox
        add("use_borders", 30,
            f"Use exactly these borders: south {num(s, 6)}, west {num(w, 6)}, north {num(n_, 6)}, "
            f"east {num(e, 6)}. The rulebook is emphatic that every player must be using the same "
            f"set of borders, and on this map the border decides which questions work at all. "
            f"Copy the GeoJSON rather than redrawing it.",
            f"border padded by {num(border.pad_m)} m — one hiding-zone radius, so every legal zone "
            f"lies wholly inside", required=True)

    # 4 · is this a transit game at all
    if fitness is not None and fitness.score is not None and fitness.score < 35.0:
        add("consider_variant", 34,
            f"This system rates {num(fitness.score, 1)} out of 100 — {fitness.band.lower()}. "
            f"Before you house-rule around it, read the rulebook's cars or on-foot variant: with "
            f"no transit system the map is just borders and hiding zones centre on street "
            f"termini, which is a better game than a broken transit one.",
            f"fitness {num(fitness.score, 1)} / 100, band “{fitness.band}”", required=True)

    # 5 · does the inferred size actually fit
    implied = metrics.get("implied_size")
    if implied and implied != size.name:
        add("resize_map", 35,
            f"The map's own numbers point at a {implied.upper()} game while the parameters in use "
            f"are {size.name.upper()}. Either shrink the border or switch size — the hiding period "
            f"and the zone radius are what make distance mean something.",
            f"axes imply {implied}, running as {size.name}")

    # 6 · the dead list
    dead = [q for q in questions if q.status in ("dead", "degenerate")]
    if dead:
        sample = ", ".join(q.label for q in sorted(dead, key=lambda q: q.id)[:5])
        add("brief_dead_questions", 40,
            f"Read the dead list out before the first round. {num(len(dead))} questions here "
            f"return null or a known answer — {sample}"
            f"{'…' if len(dead) > 5 else ''} — and asking one costs the seekers a slot and pays "
            f"the hider a card.",
            f"B1: {num(len(dead))} dead or degenerate questions", required=len(dead) > len(questions) / 3)

    # 7 · the deck
    removals = [c for c in curses if c.action == "remove"]
    if removals:
        names = _s3_join([c.name for c in sorted(removals, key=lambda c: c.id)])
        add("remove_curses", 45,
            f"Take {num(len(removals))} curse{'s' if len(removals) != 1 else ''} out of the deck "
            f"before you shuffle: {names}. Each one is either uncastable here or explicitly "
            f"removed by the rulebook.",
            "Curse deck audit, tiers 1 and 2", required=True)
    choices = [c for c in curses if c.action == "player-choice"]
    if choices:
        add("no_spending_toggle", 46,
            "Decide as a group whether anyone has to spend money during the game. Egg Partner, "
            "Impressionable Consumer and Lemon Phylactery all require a purchase; the rulebook "
            "flags the first two and is silent about the third, which is an inconsistency. Treat "
            "them as one switch.",
            "rules.md ambiguity spending_curse_inconsistency")

    # 8 · when it ends
    median_last = metrics.get("median_last_departure_s")
    if median_last:
        add("end_timer", 50,
            f"Set an end-of-game timer at {hhmm(float(median_last) - 1800)}. That is 30 minutes "
            f"before the median last departure, which is the point after which a hider in an "
            f"average zone can no longer get anywhere — including home.",
            f"median last departure {hhmm(float(median_last))}")

    # 9 · fares
    if feed is not None:
        fares = feed.tables.get("fare_attributes") or []
        if fares:
            row = fares[0]
            price = row.get("price", "")
            currency = row.get("currency_type", "")
            transfers = row.get("transfers", "")
            note = ""
            if transfers not in ("", None):
                note = (" Transfers are included." if str(transfers) not in ("0",)
                        else " Transfers are not included, so budget a fare per boarding.")
            add("carry_fare", 55,
                f"Carry fare. A single ride is {price} {currency} in this feed.{note} Both sides "
                f"will board more often than they expect.",
                "fare_attributes.txt")

    # 10 · the size's own limits
    add("answer_limits", 60,
        f"A {size.name.upper()} game gives {num(size.photo_limit_min)} minutes to answer a photo "
        f"question and {num(size.other_limit_min)} minutes for everything else, and the Move "
        f"powerup grants {num(size.move_grant_min)} minutes. Put a visible timer on it.",
        f"rulebook size table, {size.name}")
    add("hand_limit", 61,
        "Hand limit is 6, raised to 7 or 8 only by Draw 1 Expand 1. Going over forces an immediate "
        "play-or-discard, and time bonuses only count if you are still holding them at the end.",
        "rulebook, hider deck")

    # 11 · frequency and reachability warnings
    headway = metrics.get("median_headway_min")
    if headway is not None and float(headway) > 30:
        add("check_timetable", 62,
            f"Agree that either side may check live departures at any time. The median stop here "
            f"sees a bus every {mins(float(headway))}; without the timetable the game becomes a "
            f"coin flip about which bus somebody caught.",
            f"C1 median_headway_min = {num(float(headway), 1)}")
    reach = metrics.get("reachable_zone_share")
    if reach is not None and float(reach) < 0.85:
        add("reachability_brief", 64,
            f"Warn the hider that only {pct(float(reach))} of the map is reachable inside the "
            f"hiding period from the start location. Plan the journey before the clock starts — "
            f"the rulebook's advice is to go somewhere you know you can get to.",
            f"A2 reachable_zone_share = {num(float(reach), 3)}")

    # 12 · borderline questions
    borderline = [q for q in questions if q.borderline]
    if borderline:
        subjects: list[str] = []
        for q in sorted(borderline, key=lambda q: q.id):
            if q.label not in subjects:
                subjects.append(q.label)
        sample = _s3_join(subjects[:3])
        add("settle_borderline", 66,
            f"Settle the edge cases out loud before the round. {sample}"
            f"{'…' if len(subjects) > 3 else ''} sits just outside the border, so "
            f"{num(len(borderline))} question"
            f"{'s' if len(borderline) != 1 else ''} would change status if you drew the line "
            f"slightly wider. A player checking on their phone will see the feature and argue.",
            f"{num(len(borderline))} borderline questions across {num(len(subjects))} subjects",
            required=True)

    # 13 · rail-free feeds
    rail_ids = ("measuring.rail_station", "measuring.high_speed_rail", "tentacle.metro_line",
                "photo.train_platform")
    rail_dead = [q for q in questions if q.id in rail_ids and q.status == "dead"]
    if len(rail_dead) >= 2:
        names = _s3_join([q.label for q in sorted(rail_dead, key=lambda q: q.id)])
        add("no_rail_note", 67,
            f"There is no rail mode in this feed, so {names} are dead. Brief the seekers: that is "
            f"{num(len(rail_dead))} question{'s' if len(rail_dead) != 1 else ''} that pay the "
            f"hider a card and teach nothing.",
            "GTFS route types: no route_type in the rail-like set")

    # 14 · long games need rest
    if size.name == "large":
        add("rest_periods", 70,
            "Agree rest periods in advance — at least 10 hours is the rulebook's recommendation — "
            "and remember that everyone resumes from their exact position, and that the "
            "publicly-accessible test for a hiding spot does not apply during a rest period.",
            "rulebook, game sizes")

    # 15 · the one rule that always fires
    add("safety_exclusions", 90,
        "Before anything else, agree which areas are off the map because someone does not feel "
        "safe going there. The rulebook requires this conversation and explicitly refuses to "
        "automate it; this generator will not draw that polygon for you. Apply the outcome with "
        "--exclude-stop so every number on these pages matches the map you are actually playing.",
        "The rulebook requires this conversation and explicitly refuses to automate it.",
        required=True)

    out.sort(key=lambda r: (r["priority"], r["id"]))
    return out


def build_provenance(opts: Options, feed: Feed, geo: GeoData, size: GameSize,
                     as_of: str, degradations: Sequence[str]) -> dict[str, Any]:
    """Assemble the provenance block: what was fetched, what was assumed.

    Contains **no timestamp** that is not derived from `feed_info` or `--as-of`.
    """
    agencies = []
    for row in (feed.tables.get("agency") or []):
        agencies.append({
            "name": row.get("agency_name", "") or feed.agency_name,
            "url": row.get("agency_url", "") or feed.agency_url,
            "timezone": row.get("agency_timezone", "") or feed.timezone,
        })
    if not agencies:
        agencies = [{"name": feed.agency_name, "url": feed.agency_url, "timezone": feed.timezone}]

    overpass: list[dict[str, Any]] = []
    nominatim: list[dict[str, Any]] = []
    for q in sorted(geo.queries, key=lambda q: (q.key, q.cache_key)):
        row = {"key": q.key, "selector": q.selector, "bbox": list(q.bbox), "count": q.count,
               "cache_key": q.cache_key, "endpoint": q.endpoint, "partial": q.partial}
        if q.key.startswith("nominatim"):
            nominatim.append({"url": q.selector, "cache_key": q.cache_key,
                              "place": geo.admin.place_name, "country_code": geo.admin.country_code})
        else:
            overpass.append(row)

    admin_levels = {str(k): geo.admin.ordinals.get(k) for k in (1, 2, 3, 4)}
    interpretations = [
        {"id": row["id"], "text": row["text"], "affects": list(row["affects"])}
        for row in sorted(_S3_INTERPRETATIONS, key=lambda r: r["id"])
    ]

    return {
        "feed_url": feed.source,
        "feed_sha256": feed.sha256,
        "feed_version": feed.feed_version,
        "publisher": feed.publisher,
        "feed_start": feed.feed_start,
        "feed_end": feed.feed_end,
        "as_of": as_of,
        "agencies": agencies,
        "generator": GENERATOR,
        "version": VERSION,
        "argv": list(opts.argv),
        "overpass": overpass,
        "nominatim": nominatim,
        "osm_available": geo.available,
        "osm_notes": list(geo.notes),
        "admin_levels": admin_levels,
        "admin_source": geo.admin.source,
        "country_code": geo.admin.country_code,
        "country_name": geo.admin.country_name,
        "place_name": geo.admin.place_name,
        "game_size": size.name,
        "size_inferred": size.inferred,
        "hiding_period_min": size.hiding_period_min,
        "zone_radius_m": rhu(size.zone_radius_m, 3),
        "catalogue_size": size.catalogue_size,
        "greedy_k": _S3_GREEDY_K.get(size.name, 4),
        "seeker_sample_cap": SEEKER_SAMPLE_CAP,
        "start_stop_id": opts.start_stop_id,
        "departure": opts.departure,
        "board_slack_s": opts.board_slack_s,
        "excluded_stops": list(opts.exclude_stops),
        "excluded_routes": list(opts.exclude_routes),
        "llm_used": bool(opts.llm),
        "interpretations": interpretations,
        "degradations": list(degradations),
    }


# ═══════════════════════════════════════════════════════════════════════════════
# S4 · RENDER INDEX — index.html
# ═══════════════════════════════════════════════════════════════════════════════
#
# Owner: the S4 agent. Spec: scratchpad/specs/pages.md §3. Reference for quality
# (do not overwrite it): the hand-built index.html at the repo root.
#
# Every section function returns markup or the empty string. A section with no data
# emits **nothing at all** — not an empty card — and `render_index` omits its nav
# entry to match. Both pages must render valid HTML with zero JS errors under every
# degradation in pages.md §5.


# ═══════════════════════════════════════════════════════════════════════════════
# S4 · RENDER INDEX — implementation (concatenate into generate.py in place of the
# stubs between the "S4 · RENDER INDEX" banner and the "S5 · RENDER STRATEGY" one)
# ═══════════════════════════════════════════════════════════════════════════════
#
# NAMES ASSUMED IN SCOPE (all provided by the skeleton; none are redefined here)
#
#   stdlib already imported at the top of generate.py:
#       collections, math, dataclasses  (no new stdlib import is required)
#   third-party: none. S4 performs no I/O and makes no network call.
#
#   constants:  GENERATOR VERSION WA_KIT MAPLIBRE_CSS MAPLIBRE_JS TILES_LIGHT
#               TILES_DARK IMPERIAL_COUNTRIES M_PER_MILE SQM_PER_SQMI
#               QUARTER_MILE_M HALF_MILE_M SHARED_CSS SHARED_PAGE_JS
#               COLOR_SCHEME_JS STRATEGY_CSS SIZES RADAR_MILES GEO_CATEGORIES log
#   classes:    Report Options Feed Stop Route GameSize SizeInference Hub Border
#               Zone ServiceDay DayType StopDay GeoData AdminInfo Poi
#               OverpassQueryRecord QuestionDef CurseDef QuestionAudit CurseAudit
#               Metric SubScore Fitness ZoneScore Threat Projection
#   formatters: num pct mins miles km sqmi coord hhmm hhmmss rhu quantile
#               pretty_date iso_date dow_of date_range lower_median jdump
#   html:       esc attrs el void join wa_card wa_callout wa_tag wa_badge wa_button
#               wa_details wa_divider wa_scroller wa_progress_bar wa_progress_ring
#               wa_switch wa_tooltip wa_radio_group wa_copy_button wa_sparkline
#               wa_chart wa_tab_group wa_accordion wa_button_group wa_icon chip
#               meter budget_bar search_input pull_quote section subhead kpi
#               prov_chip data_table json_block document
#   S3:         catalogue_for  (read only, and only for a question's rulebook
#               draw/keep cost, which lives on QuestionDef and not on QuestionAudit)
#
# THE RULE THIS SECTION OBEYS: the renderer formats, it never computes. Every
# quantity printed here is read from `Report` and passed through exactly one of the
# skeleton's formatters. The only arithmetic below is (a) presentation aggregates
# that pages.md asks for by name — the per-category health bar `(functional +
# 0.5·weak)/count` and the "N of 24 removed" counts — and (b) picking which of two
# already-computed numbers to show. No threshold, score or verdict originates here.
#
# DETERMINISM: no clock (the footer date comes from `provenance['as_of']`), no
# `random`, every dict is iterated through `sorted()`, and every per-day payload is
# built from `sorted(metrics['per_day'])`. Markup that the page script re-renders on
# a day change is pre-rendered **in Python** and shipped as a string, so the browser
# never formats a number and server and client output cannot drift.


# ── small presentation tables ────────────────────────────────────────────────

# scoring.md §1.9 verdict bands → the italic half-sentence in the h1. Keyed on the
# band string S3 produced; an unknown band falls back to the band itself, so a new
# band can never render as an empty headline.
_S4_BAND_PHRASE: dict[str, str] = {
    "Excellent map": "Yes — comfortably.",
    "Strong map": "Yes, with a few house rules.",
    "Playable with house rules": "Yes, once you agree some house rules.",
    "Marginal": "Only with substantial changes.",
    "Not recommended as a transit game": "Not on transit, no.",
}

# Question status → (plain phrase, icon, wa-tag variant, appearance). Colour is never
# the only channel and the plain phrase is never the only wording: the rulebook's own
# word rides in the chip's `title`, in `data-status` (which the filter keys on) and in
# §07's "What these words mean" list.
_S4_STATUS_TAG: dict[str, tuple[str, str, str, str]] = {
    "functional": ("works", "circle-check", "success", "accent"),
    "weak": ("barely helps", "circle-half-stroke", "warning", "accent"),
    "degenerate": ("always the same answer", "equals", "neutral", "filled"),
    "dead": ("can't be answered here", "circle-xmark", "danger", "accent"),
    "unaskable": ("impossible on this map", "ban", "brand", "outlined"),
    "unknown": ("not checked", "circle-question", "neutral", "outlined"),
}

# The six statuses in the order the deck itself degrades, with the sentence §07's
# definition list prints. Ordered tuple rather than a dict so the list is stable.
_S4_STATUS_DEF: tuple[tuple[str, str], ...] = (
    ("functional", "It splits the map into groups, so the answer narrows the search."),
    ("weak", "It can be asked and answered, but it barely splits the map."),
    ("degenerate", "Only one qualifying thing is on the map, so every zone answers "
                   "identically. It buys the seekers nothing and still pays you a card."),
    ("dead", "Nothing on this map can answer it, so it is a wasted draw."),
    ("unaskable", "The rules of the question itself cannot be satisfied here."),
    ("unknown", "It could not be evaluated on this run, so it is excluded from the score "
                "rather than guessed at."),
)

# The same six statuses as a counting phrase: "7 work · 3 barely help". The chip
# label is a noun ("works"), a count needs a verb, and "7 works" reads as a bug.
_S4_STATUS_COUNT: dict[str, str] = {
    "functional": "work",
    "weak": "barely help",
    "degenerate": "always answer the same",
    "dead": "can't be answered",
    "unaskable": "impossible here",
    "unknown": "not checked",
}

_S4_ACTION_TAG: dict[str, tuple[str, str, str, str]] = {
    "keep": ("leave it in", "circle-check", "success", "accent"),
    "warn": ("flag it", "circle-half-stroke", "warning", "accent"),
    "remove": ("take it out", "circle-xmark", "danger", "accent"),
    "player-choice": ("your call", "scale-balanced", "brand", "outlined"),
}

_S4_ACTION_DEF: tuple[tuple[str, str], ...] = (
    ("keep", "The curse works exactly as printed on this map."),
    ("warn", "It still works, but it is weaker or stranger here than the rulebook assumes."),
    ("remove", "Nothing on this map can satisfy it, so it is a dead card in the hider's hand."),
    ("player-choice", "Whether it belongs in the deck is a conversation, not a measurement."),
)

# Curse tier → (the rulebook's label, the plain phrase, what it means). "tier N"
# itself stays on every row and in `data-tier`; this is what the number means.
_S4_TIER_DEF: tuple[tuple[str, str, str], ...] = (
    ("tier 1", "the rulebook says so",
     "The rulebook itself tells you to take this one out."),
    ("tier 2", "the map decides",
     "It depends on the geography, and this map settles it clearly enough to act on."),
    ("tier 3", "warning only",
     "Weaker or stranger on this map, but never removed on this page's advice."),
    ("tier 4", "nothing to do with the map",
     "It is about the deck, the clock or the players, not the geography."),
)

# Finding severity → (word, icon). The *variant* comes from the quadrant, not from
# here: a "high" plus is a strong point, and painting it red was a bug. The icons are
# magnitude, not alarm, for the same reason: `circle-exclamation` means "a risk to the
# round" everywhere else on both pages, and ten of them on the strengths grid said the
# opposite of what the grid says. Up / dot / down are used nowhere else.
_S4_SEVERITY: dict[str, tuple[str, str]] = {
    "high": ("major", "circle-up"),
    "medium": ("moderate", "circle-dot"),
    "low": ("minor", "circle-down"),
}

# `Metric.source` → (wa-tag variant, the word the page prints, icon, the precise term).
# An interpretation is never presented as a rule; contract.md §5.4 requires it to be
# visually distinct and labelled, and the precise term survives in the tag's `title`
# and in the row's `data-basis`.
_S4_SOURCE_TAG: dict[str, tuple[str, str, str, str]] = {
    "rulebook": ("brand", "From the rules", "book", "rulebook"),
    "feed": ("neutral", "Measured", "wave-square", "feed"),
    "interp": ("warning", "Our call", "scale-balanced", "interpretation"),
}

# The four findings quadrants, in the drafts' order, with their swatch colour, the
# WebAwesome colour utility that tints the card's leading edge, and the icon that
# makes the tone legible without the colour.
_S4_QUADRANTS: tuple[tuple[str, str, str, str, str], ...] = (
    ("plus", "What the map does well", "var(--good)", "wa-success", "circle-check"),
    ("minus", "What works against it", "var(--crit)", "wa-danger", "circle-xmark"),
    ("benefit", "Practical upsides for players", "var(--accent)", "wa-brand", "circle-check"),
    ("concern", "Risks needing a house rule", "var(--warn)", "wa-warning", "triangle-exclamation"),
)

# §04's three tile groups. `_s4_tiles` tags every tile with a `g` key; the grouping is
# produced in Python because `#tiles.innerHTML` is replaced wholesale on a day switch.
_S4_TILE_GROUPS: tuple[tuple[str, str], ...] = (
    ("map", "The map"),
    ("clock", "The clock"),
    ("deck", "The deck"),
)

_S4_CATEGORY_LABEL: dict[str, str] = {
    "matching": "Matching",
    "measuring": "Measuring",
    "radar": "Radar",
    "thermometer": "Thermometer",
    "photo": "Photo",
    "tentacle": "Tentacle",
}

# The three purchase curses the "no spending" switch toggles together. The rulebook
# names the first two and is silent on the third; rules.md files that silence as the
# ambiguity `spending_curse_inconsistency`, and the page surfaces it rather than
# quietly resolving it.
_S4_SPENDING_CURSES: frozenset[str] = frozenset({"egg_partner", "impressionable_consumer", "lemon_phylactery"})

# Headway heatmap bins in minutes. The middle element is the `data-hb` value the
# cell carries; the six ramp steps are styled by `.cell[data-hb='N']`.
_S4_HEADWAY_BINS: tuple[tuple[float, str, str], ...] = (
    (10.0, "1", "≤10 min"),
    (15.0, "2", "≤15"),
    (25.0, "3", "≤25"),
    (35.0, "4", "≤35"),
    (50.0, "5", "≤50"),
    (float("inf"), "6", "over 50"),
)

# The placeholder every index section passes as its ordinal. `render_index` replaces
# it with the section's real number **after** the empty ones are dropped, so a feed
# with no curses yields §01…§08 with no gap in the sequence. `section()` is the only
# thing that emits `data-n`, so the substitution can only ever hit the right attribute.
_S4_ORDINAL = "--"

# Degradation thresholds from pages.md §5, named so the caption can quote them.
_S4_MAX_MAP_STOPS = 5000        # above this the map draws zone centres only
_S4_MAX_MAP_ZONE_RINGS = 1200   # above this the zone circles become dots only
_S4_MAX_HEATMAP_ROUTES = 25     # above this the heatmap shows the busiest 25
_S4_MIN_HEATMAP_ROUTES = 3      # below this the heatmap becomes one sentence

# index.html-only styles. Everything structural already lives in SHARED_CSS; these
# are the few rules the new sections need and the drafts had no equivalent for.
INDEX_CSS = r"""/* ---- index.html only ---- */
#prov-trace table { width: 100%; border-collapse: collapse; font-family: var(--sans); font-size: 13px; }
#prov-trace th { text-align: left; font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
                 color: var(--ink-3); padding: 4px 10px 4px 0; white-space: nowrap; }
#prov-trace td { padding: 7px 10px 7px 0; border-top: 1px solid var(--grid); vertical-align: top; }
#prov-trace tr[data-basis='interp'] td:first-child { border-inline-start: 3px solid var(--gold); padding-inline-start: 8px; }
#prov-trace tr[data-available='0'] td { opacity: .55; }
:is(#qtable, #ctable) td:last-child { max-inline-size: 62ch; }   /* replaces .qwhy */

/* ---- editorial: the one drop cap ---- */
.dropcap p:first-child::first-letter { font-size: 3.1em; float: left; line-height: .82; padding: 4px 8px 0 0; font-weight: 700; color: var(--gold-deep); }

/* ---- the Points Budget / deck strip: the one bespoke class on either page.
   wa-progress-bar is a single-fill track and WA has no stacked bar. The fill is
   --seq-550, not --seq-400: white on --seq-400 measures 3.64:1 light / 3.28:1 dark
   and these letters are 11px bold, so 4.5:1 applies. --seq-550 is 6.2:1 / 4.9:1, and
   the bar is identity-encoded, so which step of the ramp it uses is free. ---- */
.budget { display: flex; gap: 2px; block-size: 1.25rem; }
.budget > span {
  flex: var(--v) 0 0; background: var(--seq-550); color: #fff;
  font: 700 11px/1.25rem var(--sans); text-align: center;
  border-radius: var(--wa-border-radius-s); overflow: hidden;
}
/* a segment that encodes state carries its own variant utility, which re-points
   --wa-color-fill-loud/--wa-color-on-loud on that element — no new class name. */
.budget > span:is(.wa-success, .wa-warning, .wa-danger, .wa-brand, .wa-neutral) {
  background: var(--wa-color-fill-loud); color: var(--wa-color-on-loud);
}
.budget > span[data-off] { background: var(--off); color: var(--ink-3); }
.budget > span:first-child { border-start-start-radius: var(--wa-border-radius-m);
                             border-end-start-radius: var(--wa-border-radius-m); }
.budget > span:last-child  { border-start-end-radius: var(--wa-border-radius-m);
                             border-end-end-radius: var(--wa-border-radius-m); }
@media (max-width: 30rem) { .budget > span { font-size: 0; } }   /* aria-label carries it */

/* ---- the hero's three day tiles are controls, so they need to look like controls:
   a pointer, a hover, a focus ring, and a visible current state for the aria-current
   that renderDay() sets. Without these the click was undiscoverable and unconfirmed. */
#dayscores [data-day] { cursor: pointer; }
#dayscores [data-day]:hover { border-color: var(--gold); }
#dayscores [data-day]:focus-visible { outline: var(--wa-focus-ring);
                                      outline-offset: var(--wa-focus-ring-offset); }
#dayscores [data-day][aria-current] { border-color: var(--gold);
                                      box-shadow: inset 0 0 0 var(--wa-border-width-m) var(--gold); }

/* ---- headway heatmap ---- */
table.hw { border-collapse: separate; border-spacing: 2px; font-family: var(--sans); font-size: 12.5px; min-width: 560px; }
table.hw th { text-align: left; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); padding: 4px 8px; }
table.hw td { padding: 0; }
table.hw td:first-child { padding: 0 10px 0 4px; white-space: nowrap; color: var(--ink-2); }
table.hw td:first-child b { color: var(--ink); font-family: var(--mono); font-size: 12px; background: var(--surface-2); border-radius: 5px; padding: 1px 7px; margin-right: 7px; display:inline-block; min-width: 34px; text-align:center; }
/* the hairline is the measured fix for the light end of the ramp: --seq-100 is
   1.20:1 against the paper, and that bin is "a bus every 10 minutes". The defect is
   the mark's edge, not its fill, so re-stepping the ramp would be the wrong fix. */
.cell { width: 92px; height: 30px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-weight: 700; font-variant-numeric: tabular-nums; cursor: default;
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 14%, transparent); }
.cell[data-hb='none'] { background: repeating-linear-gradient(45deg, var(--surface-2), var(--surface-2) 4px, var(--paper) 4px, var(--paper) 8px); color: var(--ink-3); font-weight: 500; }
.cell[data-hb='1'] { background: var(--seq-100); color: #0d366b; } .cell[data-hb='2'] { background: var(--seq-200); color: #0d366b; }
.cell[data-hb='3'] { background: var(--seq-300); color: #0d366b; } .cell[data-hb='4'] { background: var(--seq-400); color: #fff; }
.cell[data-hb='5'] { background: var(--seq-550); color: #fff; } .cell[data-hb='6'] { background: var(--seq-650); color: #fff; }
#hwmap .cell[data-dim], #hwmap2 .cell[data-dim] { opacity: .33; }
#hwmap th[data-sel], #hwmap2 th[data-sel] { color: var(--accent-ink); }

/* ---- network map (all bus stops, no scoring) ---- */
#netmap { height: 0; overflow: hidden; background: var(--surface-2); }  /* the map script sets a height once it builds */
#netmap.maplibregl-map { min-width: 0; }
.mk-central { width: 24px; height: 24px; }
.mk-central .star { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 22px; color: var(--gold-deep); text-shadow: 0 1px 3px rgba(0,0,0,.25); }
.mk-central .clbl {
  position: absolute; white-space: nowrap; font: 700 11px var(--sans); color: var(--ink); pointer-events: none;
  background: color-mix(in srgb, var(--surface) 78%, transparent); padding: 1px 6px; border-radius: 5px;
  top: 100%; left: 50%; transform: translateX(-50%); margin-top: 2px;
}

/* ---- sources index: two-column jump target ---- */
#cites { font-size: 13.5px; color: var(--ink-2); padding-left: 26px; columns: 2; column-gap: 40px; }
@media (max-width: 760px) { #cites { columns: 1; } }
#cites li { margin-bottom: 7px; break-inside: avoid; }
#cites code { font-family: var(--mono); font-size: 11.5px; color: var(--gold-deep); }
#cites li:target { background: color-mix(in srgb, var(--gold) 22%, transparent); border-radius: 4px; padding: 2px 4px; }"""


# ── unit and value formatting ────────────────────────────────────────────────

def _s4_imperial(report: Report) -> bool:
    """Does this map's country read distances in miles? Metric when unknown."""
    code = (report.geo.admin.country_code or "").lower()
    return code in IMPERIAL_COUNTRIES


def _s4_dist(report: Report, metres: float, dp: int = 2) -> str:
    """A distance, in the map's own units."""
    return miles(metres, dp) if _s4_imperial(report) else km(metres, dp)


def _s4_area(report: Report, sq_metres: float, dp: int = 1) -> str:
    """An area, in the map's own units."""
    if _s4_imperial(report):
        return sqmi(sq_metres, dp)
    return f"{num(sq_metres / 1_000_000.0, dp)} km²"


def _s4_val(x: float) -> str:
    """A bare number at the shortest precision that does not lose it.

    Ramp bounds and raw metric values span 0.003 to 84,466 on one page, so a fixed
    number of decimals is wrong somewhere: `319.0 zones` and `0.4 share` are both
    misreadings waiting to happen. This walks 0→3 decimals and stops at the first
    that round-trips, which prints 319, 160.2, 18.99 and 0.003 from one rule.
    """
    for dp in (0, 1, 2, 3):
        if abs(rhu(x, dp) - x) < 1e-9:
            return num(x, dp)
    return num(x, 3)


def _s4_natural_key(text: str) -> tuple[Any, ...]:
    """Sort '3 Miles' before '10 Miles' before '100 Miles'.

    Half the rulebook's question labels are numeric ('¼ Mile', '25 Miles', '2nd
    Administrative Division'), and a plain lexical sort renders those lists in an
    order that reads as a bug. Still fully deterministic: digits compare as integers,
    everything else casefolded, and the raw string breaks any remaining tie.
    """
    parts = re.split(r"(\d+)", text)
    return tuple((1, int(p)) if p.isdigit() else (0, p.casefold()) for p in parts) + ((0, text),)


def _s4_plural(n: float, singular: str, plural: str = "") -> str:
    """'1 curse' / '2 curses' — subject-verb agreement in generated prose."""
    return singular if rhu(n, 0) == 1 else (plural or singular + "s")


def _s4_metric_value(m: Metric) -> str:
    """`Metric.raw` rendered in its own unit."""
    if m.raw is None:
        return "—"
    unit = (m.unit or "").strip()
    if unit == "share":
        return pct(m.raw)
    if unit == "min":
        return mins(m.raw, 1)
    if unit in ("ratio", "0–1", "0-1"):
        return num(m.raw, 2, comma=False)
    if not unit:
        return _s4_val(m.raw)
    return f"{_s4_val(m.raw)} {unit}"


def _s4_ramp_text(spec: dict[str, Any] | None) -> str:
    """The threshold column of the score trace, in words.

    Every metric carries the shaping function that turned its raw value into points;
    printing it is what makes "17 of 25" checkable rather than assertable.
    """
    if not isinstance(spec, dict):
        return "—"
    kind = str(spec.get("kind", ""))
    args = [float(a) for a in (spec.get("args") or [])]
    v = [_s4_val(a) for a in args]
    if kind == "ramp" and len(v) >= 2:
        return f"none at {v[0]}, full at {v[1]}"
    if kind == "rramp" and len(v) >= 2:
        return f"full at {v[0]}, none at {v[1]}"
    if kind == "plateau" and len(v) >= 4:
        return f"full between {v[1]} and {v[2]}; none below {v[0]} or above {v[3]}"
    if kind == "table":
        return "steps at " + ", ".join(v)
    return kind or "—"


def _s4_points(points_tenths: int, max_tenths: int) -> str:
    """`70 / 80` tenths → '7.0 / 8.0'."""
    return f"{num(points_tenths / 10.0, 1)} / {num(max_tenths / 10.0, 1)}"


def _s4_signed(value: float, dp: int = 1) -> str:
    """A delta with an explicit sign and a real minus glyph: '−10.2', '+3.0', '0'."""
    v = rhu(value, dp)
    if v == 0:
        return num(0, dp, comma=False)
    body = num(abs(v), dp, comma=False)
    return ("+" if v > 0 else "−") + body


def _s4_join_words(items: Sequence[str], conjunction: str = "and") -> str:
    """'a', 'a and b', 'a, b and c' — for template sentences that list feed values."""
    items = [i for i in items if i]
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    return ", ".join(items[:-1]) + f" {conjunction} " + items[-1]


# ── per-day views ────────────────────────────────────────────────────────────

def _s4_day_view(report: Report, day_key: str) -> dict[str, Any]:
    """The metric table as it reads on one service day.

    `network_metrics` publishes the best day at the top level and every day under
    `per_day[key]`; the size-dependent quantities exist only in their `…_by_size`
    form inside `per_day`, because S1 computes them before the size is resolved.
    This merges the two into the flat view the tiles and banner read, and resolves
    the size once, here, so no caller can pick the wrong band.
    """
    view = dict(report.metrics)
    view.pop("per_day", None)
    per = (report.metrics.get("per_day") or {}).get(day_key)
    if isinstance(per, dict):
        view.update(per)
    size_name = report.size.name
    for key in ("evening_zone_share", "reachable_zone_share",
                "reach_within_hiding_period", "playable_day_weight"):
        by_size = view.get(f"{key}_by_size")
        if isinstance(by_size, dict) and size_name in by_size:
            view[key] = by_size[size_name]
    return view


def _s4_day_order(report: Report) -> list[str]:
    """Day-type keys in the feed's own order (weekday, Saturday, Sunday, …)."""
    return [d.day_type.key for d in report.days]


def _s4_day_label(report: Report, day_key: str) -> str:
    for d in report.days:
        if d.day_type.key == day_key:
            return d.day_type.label
    return day_key


def _s4_day_by_key(report: Report, day_key: str) -> ServiceDay | None:
    for d in report.days:
        if d.day_type.key == day_key:
            return d
    return None


def _s4_best_day(report: Report) -> str:
    """The day the report opens on."""
    keys = _s4_day_order(report)
    if report.selected_day in keys:
        return report.selected_day
    return keys[0] if keys else "weekday"


def _s4_worst_day(report: Report) -> str | None:
    """The day type with the lowest fitness, when it differs from the best one."""
    per = report.fitness.per_day or {}
    keys = [k for k in _s4_day_order(report) if k in per]
    if len(keys) < 2:
        return None
    worst = min(keys, key=lambda k: (per[k], k))
    return worst if worst != _s4_best_day(report) else None


def _s4_live_questions(report: Report) -> int:
    """Questions that actually function: functional plus weak. `unaskable` is not
    counted — Transit Line exists but cannot be asked from a standing start."""
    return sum(1 for q in report.questions if q.status in ("functional", "weak"))


def _s4_removed_curses(report: Report) -> list[CurseAudit]:
    return [c for c in report.curses if c.action == "remove"]


# ═══════════════════════════════════════════════════════════════════════════════
# S4 · THE DAY-SWITCHED PAYLOAD
# ═══════════════════════════════════════════════════════════════════════════════
#
# Everything the day selector changes is rendered here, in Python, once per day
# type, and shipped to the page as finished markup. The page script swaps strings;
# it never formats a number. That is what keeps the printed value on Saturday
# identical in shape to the one on a weekday, and what keeps the whole page
# byte-reproducible.


def _s4_tiles(report: Report, day_key: str) -> list[dict[str, str]]:
    """The twelve stat tiles for one service day (pages.md §3.3).

    Seven of the twelve move with the day; the other five are map-wide or rulebook
    constants and are repeated so that one list renders the whole grid.
    """
    v = _s4_day_view(report, day_key)
    size = report.size
    label = _s4_day_label(report, day_key)
    n_total_routes = len(report.feed.routes)
    catalogue = len(report.questions)
    live = _s4_live_questions(report)
    removed = len(_s4_removed_curses(report))
    radius = _s4_dist(report, size.zone_radius_m, 2)

    def g(key: str, default: Any = None) -> Any:
        got = v.get(key)
        return default if got is None else got

    span_h = float(g("span_hours", 0.0))
    first_s = int(g("first_departure_s", 0))
    last_s = int(g("last_departure_s", 0))
    med_last = int(g("median_last_departure_s", last_s))
    worst_gap = g("median_worst_gap_min")
    served = int(g("served_stops", 0))
    in_feed = int(g("stops_in_feed", served))
    reach_n = int(g("reach_within_hiding_period", 0))
    reach_share = float(g("reachable_zone_share", 0.0))
    freq_share = float(g("frequent_share", 0.0))
    freq_stops = int(g("frequent_stops", 0))
    headway = g("median_headway_min")
    hull = float(g("hull_sq_m", 0.0))
    diameter = float(g("diameter_m", 0.0))

    tiles: list[dict[str, str]] = [
        {"g": "map", "day": "1", "prov": "A1",
         "v": num(g("n_zones", len(report.zones))),
         "l": "Distinct hiding zones",
         "n": f"One zone per {radius} circle — a greedy {radius} cover of the {num(served)} "
              f"stops with service on a {label}. This is the denominator for every share on "
              f"both pages."},
        {"g": "map", "day": "1", "prov": "feed",
         "v": f"{num(served)} / {num(in_feed)}",
         "l": "Stops served / in the feed",
         "n": f"{num(in_feed - served)} stops in the feed see no departure on a {label}."},
        {"g": "map", "day": "1", "prov": "feed",
         "v": f"{num(g('routes', 0))} of {num(n_total_routes)}",
         "l": "Routes running",
         "n": f"Route patterns with at least one trip on the representative {label}, "
              f"{pretty_date(str(g('date', report.provenance.get('as_of', '')) or '20000101'))}."},
        {"g": "map", "day": "", "prov": "feed",
         "v": _s4_area(report, hull),
         "l": "Map area",
         "n": f"The area the buses actually cover — the convex hull of the served stops. "
              f"The printed border box is "
              f"{_s4_area(report, report.border.area_sq_m)}, because a rectangle is what "
              f"players can actually agree on."},
        {"g": "map", "day": "", "prov": "feed",
         "v": _s4_dist(report, diameter, 1),
         "l": "Network diameter",
         "n": f"The longest straight line between two served stops. The smallest circle "
              f"that holds the whole network has a radius of "
              f"{_s4_dist(report, float((g('mec', (0, 0, 0)) or (0, 0, 0))[2]), 1)}."},
        {"g": "clock", "day": "1", "prov": "D1",
         "v": f"{hhmm(first_s)}–{hhmm(last_s)}",
         "l": "Service window",
         "n": f"{num(span_h, 1)} hours end to end. The median stop's last departure is "
              f"{hhmm(med_last)}, which is the number that ends your game."},
        {"g": "clock", "day": "1", "prov": "C1",
         "v": mins(headway) if headway is not None else "—",
         "l": "Median headway per stop",
         "n": (f"All routes combined, 06:00–22:00. The median stop's worst gap of the day is "
               f"{mins(worst_gap)}." if worst_gap is not None else
               "All routes combined, 06:00–22:00.")},
        {"g": "clock", "day": "1", "prov": "C3",
         "v": pct(freq_share),
         "l": "Stops on a 15-minute route",
         "n": f"{num(freq_stops)} stops where one single route-direction runs every "
              f"15 minutes or better. The frequent network is what the seekers actually use."},
        {"g": "clock", "day": "", "prov": "rulebook",
         "v": f"{num(size.hiding_period_min)} min",
         "l": "Hiding period",
         "n": f"{size.name.upper()} game: {radius} hiding zones, "
              f"{num(size.catalogue_size)} questions in the deck, "
              f"{num(size.photo_limit_min)} minutes to answer a photo."},
        {"g": "clock", "day": "1", "prov": "A2",
         "v": pct(reach_share),
         "l": "Zones reachable in the hiding period",
         "n": f"{num(reach_n)} of {num(served)} served stops are within "
              f"{num(size.hiding_period_min)} minutes of the start location at "
              f"{report.opts.departure[:5]}."},
        {"g": "deck", "day": "", "prov": "B1",
         "v": f"{num(live)} of {num(catalogue)}",
         "l": "Questions that work here",
         "n": f"Functional plus weak, out of the {size.name.upper()} catalogue. "
              f"{num(sum(1 for q in report.questions if q.status in ('dead', 'degenerate')))} "
              f"return a fixed or null answer and should be pre-briefed."},
        {"g": "deck", "day": "", "prov": "curses",
         "v": f"{num(removed)} of {num(len(report.curses))}",
         "l": "Curses to take out of the deck",
         "n": f"{num(sum(1 for c in report.curses if c.action == 'warn'))} more are weakened but "
              f"stay in the deck, and "
              f"{num(sum(1 for c in report.curses if c.action == 'player-choice'))} are a "
              f"conversation to have rather than a measurement to take."},
    ]
    return tiles


def _s4_tiles_html(report: Report, day_key: str) -> str:
    """The tile grid's inner markup for one day, in its three labelled groups.

    Rendered server-side for the opening day and shipped as a string for the others.
    The grouping is produced here rather than around `#tiles`, because `renderDay()`
    replaces that container's `innerHTML` wholesale and would overwrite any chrome
    that lived outside this string.
    """
    tiles = _s4_tiles(report, day_key)
    day_chip = chip("changes by day", "calendar-day",
                    title="This figure is measured on the selected service day")
    groups: list[str] = []
    for key, title in _S4_TILE_GROUPS:
        cards = [wa_card(kpi(t["v"], t["l"], esc(t["n"]) + prov_chip(t["prov"]),
                             chip_html=(day_chip if t["day"] else "")),
                         data_day_sensitive=bool(t["day"]) or None)
                 for t in tiles if t["g"] == key]
        if not cards:
            continue
        groups.append(el("div", join(
            subhead(title),
            el("div", "".join(cards), class_="wa-grid wa-gap-s", style="--min-column-size:230px"),
        ), class_="wa-stack wa-gap-xs"))
    return join(*groups)


def _s4_banner(report: Report, day_key: str) -> dict[str, Any]:
    """The day strip: four figures, one sentence, one fitness delta."""
    v = _s4_day_view(report, day_key)
    label = _s4_day_label(report, day_key)
    day = _s4_day_by_key(report, day_key)
    size = report.size
    per_day = report.fitness.per_day or {}
    best = _s4_best_day(report)
    score = per_day.get(day_key)
    best_score = per_day.get(best)
    delta = None if (score is None or best_score is None) else score - best_score

    headway = v.get("median_headway_min")
    midday = v.get("midday_headway_p25_p50_p75")
    if isinstance(midday, (list, tuple)) and len(midday) == 3 and midday[0] is not None:
        cadence = f"{num(midday[0])}–{num(midday[2])} min"
        cadence_note = "midday quartiles"
    elif headway is not None:
        cadence = mins(headway)
        cadence_note = "median per stop"
    else:
        cadence = "—"
        cadence_note = "no service"

    n_dates = len(day.day_type.dates) if day else 0
    note = (
        f"{num(v.get('trips', 0))} trips across {num(v.get('served_stops', 0))} stops, "
        f"{num(v.get('n_zones', 0))} hiding zones, and "
        f"{pct(float(v.get('reachable_zone_share', 0.0)))} of them reachable inside the "
        f"{num(size.hiding_period_min)}-minute hiding period. "
        f"The median stop's last departure is {hhmm(int(v.get('median_last_departure_s', 0)))}. "
        f"{num(n_dates)} {'date' if n_dates == 1 else 'dates'} in this feed run this pattern; "
        f"{pretty_date(str(v.get('date') or report.provenance.get('as_of') or '20000101'))} is the "
        f"one every number on this page is measured on."
    )
    if delta is not None and delta < -0.05:
        note += (f" Map fitness on this day is {num(score, 1)}, {_s4_signed(delta)} against "
                 f"{_s4_day_label(report, best)}.")

    if delta is None or delta >= -2.0:
        variant = "success"
    elif delta >= -10.0:
        variant = "warning"
    else:
        variant = "danger"

    return {
        "key": day_key, "label": label, "variant": variant,
        "routes": f"{num(v.get('routes', 0))} of {num(len(report.feed.routes))}",
        "cadence": cadence, "cadence_note": cadence_note,
        "span": f"{hhmm(int(v.get('first_departure_s', 0)))}–{hhmm(int(v.get('last_departure_s', 0)))}",
        "note": note,
        "score": None if score is None else num(score, 1),
        "delta": None if delta is None else _s4_signed(delta),
    }


def _s4_banner_html(report: Report, day_key: str) -> str:
    """The day strip's inner markup. `wa-callout`'s variant is set by the page script,
    because the element itself is server-rendered once and reused.

    The day's heading leads, the four figures read across, and the 55-word paragraph
    — which was in the way of everything under it — is one tap down. Nothing is
    dropped: the cadence's "midday quartiles" qualifier moves into that paragraph as
    words, and the paragraph itself is verbatim.
    """
    b = _s4_banner(report, day_key)
    figures = [("Routes running", b["routes"]),
               ("How often", b["cadence"]),
               ("Service window", b["span"])]
    if b["score"] is not None:
        figures.append(("Map fitness today",
                        b["score"] + (f" · {b['delta']}"
                                      if b["delta"] and b["delta"] != "0.0" else "")))
    note = f"How often: {b['cadence']}, {b['cadence_note']}. {b['note']}"
    return join(
        el("div", join(
            el("p", join(wa_icon("calendar-day"), esc(f"{b['label']} service")),
               class_="wa-heading-xs wa-cluster wa-gap-2xs wa-align-items-center"),
            el("div", "".join(
                el("div", join(
                    el("span", esc(value), class_="wa-heading-s"),
                    el("span", esc(caption),
                       class_="wa-caption-xs wa-text-uppercase wa-color-text-quiet"),
                ), class_="wa-stack wa-gap-3xs") for caption, value in figures),
               class_="wa-cluster wa-gap-l"),
        ), class_="wa-split wa-align-items-center wa-flex-wrap wa-gap-m"),
        wa_details("What that means on the ground",
                   el("p", esc(note), class_="wa-body-s wa-color-text-quiet"),
                   appearance="plain"),
    )


def _s4_travel_rows(report: Report, day_key: str) -> list[dict[str, Any]]:
    """The ride-time chart's rows for one day, sorted by travel time (no-service last).

    The colour rule is stated in the card's caption verbatim, because a bar colour a
    reader cannot reconstruct is decoration rather than information.
    """
    hp = float(report.size.hiding_period_min)
    label = _s4_day_label(report, day_key)
    rows: list[dict[str, Any]] = []
    for s in report.travel_samples:
        per = (s.get("per_day") or {}).get(day_key) or {}
        minutes = per.get("minutes")
        transfers = per.get("transfers")
        routes = [str(r) for r in (per.get("routes") or [])]
        name = str(s.get("name") or s.get("stop_id") or "")
        short = name if len(name) <= 36 else name[:35] + "…"
        if minutes is None:
            rows.append({
                "name": name, "label": short, "minutes": 0.0, "avail": False, "tone": "none",
                "note": f"no service on a {label}",
                "tip": el("b", esc(name)) + esc(f"No service on a {label}."),
            })
            continue
        minutes = float(minutes)
        if minutes > hp:
            tone = "bust"
            verdict = f"busts the {num(hp)}-minute hiding period"
        elif minutes > 0.75 * hp or (transfers or 0) >= 2:
            tone = "tight"
            verdict = "fits, but with no slack or two changes"
        else:
            tone = "fits"
            verdict = "fits the hiding period comfortably"
        leg = _s4_join_words([f"route {r}" for r in routes]) or "walking"
        tip = el("b", esc(name)) + esc(
            f"{mins(minutes, 1)} from the start location on {leg}, "
            f"{num(transfers or 0)} {'change' if (transfers or 0) == 1 else 'changes'} — {verdict}.")
        rows.append({"name": name, "label": short, "minutes": rhu(minutes, 1), "avail": True,
                     "tone": tone, "note": "", "tip": tip})
    rows.sort(key=lambda r: (not r["avail"], r["minutes"], r["name"]))
    return rows


def _s4_chart_max(report: Report) -> float:
    """A deterministic x-axis maximum for the ride-time chart.

    The hiding-period line must always be on the canvas, and one 3-hour outlier must
    not squash every other bar, so the axis is the larger of 1.25 × the hiding period
    and the p90 of every sampled time on every day, rounded up to a multiple of 15.
    Bars past it are clipped and annotated at the axis end.
    """
    values = [float(p["minutes"])
              for s in report.travel_samples
              for _, p in sorted((s.get("per_day") or {}).items())
              if p and p.get("minutes") is not None]
    floor_v = float(report.size.hiding_period_min) * 1.25
    top = max(floor_v, quantile(values, 0.90) if values else 0.0)
    return float(max(15, int(math.ceil(top / 15.0)) * 15))


# ═══════════════════════════════════════════════════════════════════════════════
# S4 · THE EMBEDDED JSON BLOCKS
# ═══════════════════════════════════════════════════════════════════════════════
#
# One block per concern (contract.md §7.5), so a page that only wants the verdict
# never parses the stop list. Semantic precisions are applied here, before `jdump`:
# coordinates 6 dp via `coord()`, scores 1 dp, shares 4 dp, minutes 1 dp.


def _s4_metric_lookup(report: Report) -> dict[str, Metric]:
    """Every fitness metric by id, for the prose slots and the headline sentence."""
    out: dict[str, Metric] = {}
    for sub in report.fitness.subscores:
        for m in sub.metrics:
            out[m.id] = m
    return out


def _s4_curated_metrics(report: Report) -> dict[str, Any]:
    """The scalar metrics the page prints, flattened for `#data`.

    Deliberately not the whole `metrics` dict: that carries per-day zone-centre id
    lists and hull rings, which would triple the page weight for values nothing on
    index.html reads.
    """
    v = _s4_day_view(report, _s4_best_day(report))
    keys = (
        "served_stops", "stops_in_feed", "stations", "n_zones", "n_zones_half_mile",
        "routes", "trips", "stop_events", "diameter_m", "hull_sq_m", "bbox_sq_m",
        "span_hours", "first_departure_s", "last_departure_s", "median_headway_min",
        "median_worst_gap_min", "median_last_departure_s", "frequent_share", "frequent_stops",
        "share_30min", "multi_route_stop_share", "transfer_stops_2plus", "transfer_stops_3plus",
        "routes_per_stop_max", "hub_dominance", "hub_trip_share", "network_shape",
        "isolated_zone_share", "t90_min", "hub_travel_p50_min", "hub_travel_p95_min",
        "reachable_zone_share", "reach_within_hiding_period", "evening_zone_share",
        "weekend_ratio", "sat_trip_ratio", "sun_trip_ratio", "full_service_date_share",
        "route_km_one_dir", "stop_density_per_sq_mi", "zone_density_per_sq_mi",
        "distinct_base_names", "best_day", "implied_size",
    )
    out: dict[str, Any] = {}
    for k in keys:
        if k in v and v[k] is not None:
            value = v[k]
            out[k] = rhu(value, 4) if isinstance(value, float) else value
    return out


def _s4_data_payload(report: Report) -> dict[str, Any]:
    """`#data` — everything both pages share, plus the pre-rendered day markup."""
    f = report.fitness
    days: dict[str, Any] = {}
    for key in _s4_day_order(report):
        b = _s4_banner(report, key)
        days[key] = {
            "key": key,
            "label": b["label"],
            "variant": b["variant"],
            "banner_html": _s4_banner_html(report, key),
            "tiles_html": _s4_tiles_html(report, key),
            "score": b["score"],
            "travel": [{"label": r["label"], "minutes": rhu(r["minutes"], 1), "avail": r["avail"],
                        "tone": r["tone"], "note": r["note"], "tip": r["tip"]}
                       for r in _s4_travel_rows(report, key)],
        }
    border = report.border
    return {
        "place": report.place,
        "agency": {"name": report.feed.agency_name, "url": report.feed.agency_url,
                   "timezone": report.feed.timezone},
        "game": {
            "size": report.size.name,
            "hiding_period_min": report.size.hiding_period_min,
            "zone_radius_m": rhu(report.size.zone_radius_m, 1),
            "catalogue_size": report.size.catalogue_size,
            "tentacle_reach_mi": report.size.tentacle_reach_mi,
            "photo_limit_min": report.size.photo_limit_min,
            "other_limit_min": report.size.other_limit_min,
            "inferred": report.size.inferred,
            "chart_max_min": _s4_chart_max(report),
            "scale_unit": "imperial" if _s4_imperial(report) else "metric",
        },
        "border": {
            "kind": border.kind,
            "bbox": [coord(x) for x in border.bbox],
            "circle": [coord(border.circle[0]), coord(border.circle[1]), rhu(border.circle[2], 1)],
            "pad_m": rhu(border.pad_m, 1),
            "area_sq_m": rhu(border.area_sq_m, 1),
            "geojson": border.geojson,
        },
        "hub": {"stop_id": report.hub.stop_id, "name": report.hub.name,
                "lat": coord(report.hub.lat), "lon": coord(report.hub.lon),
                "shape": report.hub.shape, "dominant": report.hub.dominant,
                "route_share": rhu(report.hub.route_share, 4)},
        "fitness": {
            "score": None if f.score is None else rhu(f.score, 1),
            "raw_score": rhu(f.raw_score, 1),
            "capped_by": f.capped_by,
            "band": f.band,
            "available_points": rhu(f.available_points, 1),
            "per_day": {k: rhu(v, 1) for k, v in sorted((f.per_day or {}).items())},
            "subscores": [{"id": s.id, "name": s.name, "earned": rhu(s.earned_tenths / 10.0, 1),
                           "max": rhu(s.max_tenths / 10.0, 1), "partial": s.partial,
                           "missing": list(s.missing)} for s in f.subscores],
        },
        "size_inference": {
            "verdict": report.size_inference.verdict,
            "votes": list(report.size_inference.votes),
            "unanimous": report.size_inference.unanimous,
            "clamped": report.size_inference.clamped,
            "note": report.size_inference.note,
            "axes": [dict(a) for a in report.size_inference.axes],
        },
        "metrics": _s4_curated_metrics(report),
        "route_headways": [
            {"route_id": h.get("route_id"), "short_name": h.get("short_name"),
             "long_name": h.get("long_name"), "direction_id": h.get("direction_id"),
             "per_day": {k: (None if v is None else rhu(float(v), 1))
                         for k, v in sorted((h.get("per_day") or {}).items())},
             "trips": {k: v for k, v in sorted((h.get("trips") or {}).items())}}
            for h in report.route_headways],
        "findings": [dict(sorted(x.items())) for x in report.findings],
        "recommendations": [dict(sorted(x.items())) for x in report.recommendations],
        "day_keys": _s4_day_order(report),
        "selected_day": _s4_best_day(report),
        "days": days,
        "degradations": list(report.degradations),
    }


def _s4_questions_payload(report: Report) -> dict[str, Any]:
    defs = {d.id: d for d in catalogue_for(report.size)}
    rows = []
    for q in sorted(report.questions, key=lambda x: (x.category, x.id)):
        d = defs.get(q.id)
        rows.append({
            "id": q.id, "category": q.category, "label": q.label, "text": q.text,
            "status": q.status, "quality": rhu(q.quality, 4),
            "instances": q.instances, "coverage": None if q.coverage is None else rhu(q.coverage, 4),
            "selector": q.selector, "why": q.why,
            "surv_mean": None if q.surv_mean is None else rhu(q.surv_mean, 4),
            "borderline": q.borderline,
            "draw": None if d is None else d.draw,
            "keep": None if d is None else d.keep,
        })
    return {"questions": rows,
            "question_order": list(report.question_order),
            "question_funnel": list(report.question_funnel)}


def _s4_curses_payload(report: Report) -> dict[str, Any]:
    return {"curses": [{"id": c.id, "name": c.name, "tier": c.tier, "action": c.action,
                        "predicate": c.predicate, "count": c.count, "why": c.why}
                       for c in report.curses]}


def _s4_stops_payload(report: Report) -> dict[str, Any]:
    """`#stops` — `[lon, lat, name, route_count]` tuples plus the zone centres.

    Tuples rather than objects: on a 1,500-stop feed that is a third of the bytes,
    and on a 20,000-stop feed it is the difference between a page that opens and one
    that does not. The zone centres ride along because the network map draws them and
    they are the same geometry the strategy page ranks.
    """
    day = _s4_day_by_key(report, _s4_best_day(report))
    stops: list[list[Any]] = []
    if day is not None and len(day.served_stop_ids) <= _S4_MAX_MAP_STOPS:
        for sid in day.served_stop_ids:
            stop = report.feed.stops.get(sid)
            if stop is None:
                continue
            sd = day.stop_days.get(sid)
            stops.append([coord(stop.lon), coord(stop.lat), stop.name, len(sd.routes) if sd else 0])
    scores = report.zone_scores
    zones = [[coord(z.lon), coord(z.lat), z.name,
              rhu(scores[z.zone_id].overall_tenths / 10.0, 1) if z.zone_id in scores else None]
             for z in sorted(report.zones, key=lambda z: z.zone_id)]
    return {"stops": stops, "zones": zones,
            "stops_omitted": day is not None and len(day.served_stop_ids) > _S4_MAX_MAP_STOPS,
            "rings": len(zones) <= _S4_MAX_MAP_ZONE_RINGS}


# ═══════════════════════════════════════════════════════════════════════════════
# S4 · HERO AND VERDICT
# ═══════════════════════════════════════════════════════════════════════════════


def _s4_band_bounds(band: str) -> tuple[float, float, str]:
    """`(cut point, the next band's cut point, the advice sentence)` for one band.

    `_S3_BANDS` is a module-level rulebook presentation constant carrying
    `(cut, name, advice)`; `build_fitness` uses the first two elements and discards the
    third. Reading it here is not computing — S5 reads `_S5_AXES` and `RADAR_MILES` the
    same way — and it is what finally gives the headline number a scale, plus a "so
    what" sentence that until now was written and thrown away.
    """
    upper = 100.0
    for cut, name, advice in _S3_BANDS:          # high → low, the constant's own order
        if name == band:
            return cut, upper, advice
        upper = cut
    return 0.0, 100.0, ""


def _s4_band_ladder(report: Report) -> str:
    """The five verdict bands as a rising ladder of tags, the map's own one filled.

    The cut-point is in the tag's *text*, not only its `title`: a hover is not an
    affordance on a phone, and the ladder exists precisely to give the dial a scale.
    """
    current = report.fitness.band
    tags = []
    for cut, name, _advice in reversed(_S3_BANDS):        # low → high, deterministic
        active = name == current
        tags.append(wa_tag(f"{num(cut, 0)}+ {name}", size="s",
                           variant=(band_variant(name) if active else "neutral"),
                           appearance=("filled" if active else "outlined"),
                           title=f"{num(cut, 1)} and up"))
    return el("div", "".join(tags), class_="wa-cluster wa-gap-3xs", role="list")


def _s4_points_budget(report: Report, **kwargs: Any) -> str:
    """The score as a 100-unit segmented bar — the README's ASCII breakdown, rendered.

    The six sub-scores are identity, not magnitude, so every segment is one hue and
    carries its own letter: painting A–F in six colours would imply F is worse than A,
    which is false.
    """
    f = report.fitness
    if not f.subscores:
        return ""
    segments = [(s.id, s.earned_tenths / 10.0,
                 f"{s.id} · {s.name} — {_s4_points(s.earned_tenths, s.max_tenths)} points")
                for s in f.subscores]
    earned = sum(v for _id, v, _tip in segments)
    spoken = "; ".join(f"{s.id} {num(s.earned_tenths / 10.0, 1)} of "
                       f"{num(s.max_tenths / 10.0, 0)}" for s in f.subscores)
    remainder = f"{num(100.0 - earned, 1)} points not earned"
    if f.capped_by:
        remainder += f" — held back by {f.capped_by}"
    return budget_bar(segments, 100.0,
                      aria_label=f"{num(earned, 1)} of 100 points earned: {spoken}",
                      remainder_tip=remainder, **kwargs)


def _s4_subscore_meters(report: Report) -> str:
    """One `meter()` per sub-score, each linking into its own score-trace item."""
    rows = []
    for s in report.fitness.subscores:
        pctage = 100.0 * s.earned_tenths / s.max_tenths if s.max_tenths else 0.0
        label = el("a", esc(f"{s.id} · {s.name}"), href=f"#trace-{s.id}",
                   class_="wa-link-plain wa-caption-s")
        right = el("span", join(esc(num(s.earned_tenths / 10.0, 1)),
                                el("span", esc(f" / {num(s.max_tenths / 10.0, 0)}"),
                                   class_="wa-color-text-quiet")),
                   class_="wa-caption-s")
        rows.append(meter(label, pctage, right, flank="3.5rem"))
    return el("div", "".join(rows), class_="wa-grid wa-gap-s", style="--min-column-size:15rem")


def _s4_day_tiles(report: Report) -> str:
    """The three service days and what each one is worth, as clickable tiles.

    These numbers exist today only inside a `title=` attribute on the day radios, and
    they are the most interesting finding on the page: the same map is a different
    game on a Sunday. Clicking a tile goes through `setDay()`, so the tiles, the
    selector and `localStorage` can never disagree.
    """
    per = report.fitness.per_day or {}
    keys = [k for k in _s4_day_order(report) if k in per]
    if len(keys) < 2:
        return ""
    best = max(keys, key=lambda k: (per[k], k))
    cards = []
    for key in keys:
        delta = per[key] - per[best]
        cards.append(wa_card(el("div", join(
            el("span", esc(num(per[key], 1)), class_="wa-heading-xl",
               style="font-family:var(--sans)"),
            el("span", esc(_s4_day_label(report, key)),
               class_="wa-caption-xs wa-text-uppercase"),
            el("span", esc("best day" if key == best else f"{_s4_signed(delta)} points"),
               class_="wa-caption-2xs wa-color-text-quiet"),
        ), class_="wa-stack wa-gap-3xs"), appearance="outlined", data_day=key,
            role="button", tabindex="0",
            title=f"Re-read the whole page for {_s4_day_label(report, key)} service"))
    return el("div", "".join(cards), class_="wa-grid wa-gap-s",
              style="--min-column-size:11rem", id="dayscores")


def _s4_scorecard(report: Report) -> str:
    """The hero's answer panel: grade, scale, budget, rubric, and what to do next.

    Tier 1 is the dial and the band word — exactly one grade on the page. Tier 2 is
    the ladder, the budget bar, the six meters and the day tiles, and none of it is
    ever collapsed: it is what makes the grade checkable. Tier 3, the metric rows
    behind every one of those numbers, is one click away in §02.
    """
    f = report.fitness
    top: str
    if f.score is None:
        top = wa_callout(el("div", join(
            el("p", esc("Not enough of this map could be measured to give it one number"),
               class_="wa-heading-s"),
            el("p", esc(f"Only {num(f.available_points, 1)} of 100 points could be measured on "
                        f"this map, so no headline number is printed. The sub-scores that were "
                        f"measurable are below."), class_="wa-body-s"),
        ), class_="wa-stack wa-gap-2xs"), variant="neutral", appearance="outlined",
            icon="circle-question")
    else:
        cut, upper, advice = _s4_band_bounds(f.band)
        note = f.band
        if f.capped_by:
            note = f"{f.band} · held back by {f.capped_by}"
        elif f.available_points < 100:
            note = f"{f.band} · {num(f.available_points, 1)} of 100 points measurable"
        inner = el("span", join(
            el("span", esc(num(f.score, 1)), class_="wa-heading-2xl",
               style="font-family:var(--sans)"),
            el("span", esc("/ 100"), class_="wa-caption-2xs wa-text-uppercase"),
        ), class_="wa-stack wa-gap-3xs wa-align-items-center")
        dial = wa_progress_ring(f.score, label="Map fitness score", inner_html=inner, id="dial",
                                style="--size:9rem;--track-width:.5rem;--indicator-width:.75rem;"
                                      "--track-color:var(--surface-2);--indicator-color:var(--gold)")
        beside = el("div", join(
            el("p", esc("How good a map this is"), class_="wa-heading-xs"),
            el("p", esc(f"{num(cut, 1)}–{num(upper, 1)} out of 100 is “{f.band.lower()}”."),
               class_="wa-body-s"),
            el("p", esc(advice), class_="wa-caption-s wa-color-text-quiet"),
            el("p", esc(note) + prov_chip("trace"),
               class_="wa-caption-s wa-color-text-quiet"),
        ), class_="wa-stack wa-gap-3xs", style="flex:1 1 11rem")
        top = el("div", join(
            el("div", dial + beside, class_="wa-cluster wa-gap-l wa-align-items-center"),
            _s4_band_ladder(report),
        ), class_="wa-stack wa-gap-s")

    budget = ""
    if f.score is not None:
        # Not `subhead()`: this label sits inside the hero <header>, before the page's
        # first <h2>, and an <h3> there is a heading-order skip (h1 → h3 → h2).
        budget = el("div", join(
            el("p", esc("Where the 100 points went"),
               class_="wa-heading-s wa-color-text-quiet wa-text-uppercase"),
            _s4_points_budget(report),
            el("p", esc("Each block is one sub-score; the grey tail is what the map did not "
                        "earn. Hover a block for its name and its points."),
               class_="wa-caption-xs wa-color-text-quiet"),
        ), class_="wa-stack wa-gap-3xs")

    footer = ""
    buttons = []
    if report.recommendations:
        n = len(report.recommendations)
        buttons.append(wa_button(f"Read the {num(n)} house {_s4_plural(n, 'rule')}",
                                 href="#recs", variant="brand", appearance="filled",
                                 icon="list-check"))
    footer = el("div", "".join(buttons), class_="wa-cluster wa-gap-s") if buttons else ""

    return wa_card(el("div", join(
        top, budget, _s4_subscore_meters(report), _s4_day_tiles(report),
    ), class_="wa-stack wa-gap-m"), footer_html=footer)


def index_hero(report: Report) -> str:
    """The page's answer, above everything else: kicker, the question as an `h1`, the
    band phrase as its own deck line, the headline sentence, three orienting chips,
    and the scorecard.

    Exactly one display figure and one band word exist on this page, and they are both
    in here. When too little of the map could be measured the dial and the points
    budget are replaced by a callout saying so; the six sub-score meters and the day
    tiles are the scorecard's body in both branches, so the fallback is the same
    layout rather than a different one.
    """
    f = report.fitness
    p = report.provenance
    size = report.size
    metrics = _s4_metric_lookup(report)
    v = _s4_day_view(report, _s4_best_day(report))

    window = ""
    if p.get("feed_start") and p.get("feed_end"):
        window = f"{pretty_date(str(p['feed_start']))} – {pretty_date(str(p['feed_end']))}"
    kicker = " · ".join(x for x in (
        "Feasibility report", window,
        # `place` falls back to the agency name when Nominatim was not consulted
        # (--no-osm, or an Overpass failure), so guard against "CTA, CTA".
        (f"{report.feed.agency_name}, {report.place}"
         if report.place and report.place != report.feed.agency_name
         else report.feed.agency_name),
    ) if x)

    live = _s4_live_questions(report)
    c2 = metrics.get("C2")
    crossing = ""
    if v.get("t90_min") is not None:
        crossing = (f", and crossing the network end to end costs about "
                    f"{mins(float(v['t90_min']))}")
        if c2 is not None and c2.raw:
            crossing += f" — {num(float(c2.raw), 2, comma=False)} hiding periods"
    headline = (
        f"{num(len(report.zones))} distinct hiding zones across "
        f"{_s4_area(report, float(v.get('hull_sq_m', 0.0)))} of {report.feed.agency_name} network, "
        f"{num(live)} of the {num(len(report.questions))} questions in the "
        f"{size.name.upper()} deck function here{crossing}."
    )

    chips = "".join((
        chip(f"{size.name.capitalize()} map · {num(size.hiding_period_min)}-min hiding period · "
             f"{_s4_dist(report, size.zone_radius_m, 2)} zones", "ruler-combined",
             variant="warning"),
        chip(f"Start: {report.hub.name}", "star"),
        chip(f"Best day: {_s4_day_label(report, _s4_best_day(report))}", "calendar-day",
             variant="brand"),
    ))

    left = el("div", join(
        el("p", esc(kicker), class_="kicker wa-caption-s wa-text-uppercase"),
        el("h1", esc(f"Can you hide in {report.place}?"), class_="wa-heading-4xl"),
        el("p", el("em", esc(_S4_BAND_PHRASE.get(f.band, f.band))),
           class_="wa-heading-2xl wa-color-text-quiet"),
        el("p", esc(headline) + prov_chip("A1", "B1"), class_="wa-body-l",
           style="max-inline-size:46ch"),
        el("div", chips, class_="wa-cluster wa-gap-2xs"),
    ), class_="wa-stack wa-gap-xs", style="flex:1 1 24rem")

    # `wa-align-items-start`, not `-center`: the scorecard is roughly twice the height
    # of the text beside it, so centring buries the headline under ~275px of dead space
    # once the two columns fit side by side (~1176px viewport and up). Below that the
    # columns wrap, each flex line holds one item, and the two alignments are identical.
    return el("header", el("div", join(
        left, el("div", _s4_scorecard(report), style="flex:1 1 26rem"),
    ), class_="wa-split wa-flex-wrap wa-gap-2xl wa-align-items-start"),
        id="top", class_="wa-stack wa-gap-l")


def _s4_axis_word(score: int) -> str:
    return ("small", "medium", "large")[max(0, min(2, int(score)))]


# The four size axes in plain words. The generator's own technical name for each stays
# on the page as the quiet caption beneath, so nothing is renamed away.
_S4_AXIS_PLAIN: dict[str, str] = {
    "A": "The area the buses actually cover",
    "B": "How many distinct places there are to hide",
    "C": "How long it takes to cross the map",
    "D": "How far it is corner to corner",
}

# Where each axis's band came from, as a `Metric.source` value so the axis table can
# reuse `_s4_source_tag` and read the same as every other provenance chip on the page.
#
# GUIDE.md "Choosing a Transit System" gives the size table in full and gives nothing
# else: SMALL 30–100 stations / 10–100 sq. mi, MEDIUM 100–500 / 100–1,000, LARGE 500+ /
# 1,000+. So:
#   A · convex-hull area [100, 1000] sq mi — verbatim the rulebook's second column.
#   B · hiding zones [100, 500] — a reading, not a quotation: the rulebook counts
#       *stations*, and only because it says each hiding zone is centred on one (and
#       calls the whole table "our best estimate") does the station band transfer.
#   C · T90 traversal time and D · straight-line diameter — no rulebook counterpart at
#       all; the rulebook never mentions traversal or diameter. These bands are the
#       generator's, and saying otherwise turned two invented thresholds into rules.
# The numbers themselves live in `infer_game_size` and are not restated here.
_S4_AXIS_BASIS: dict[str, str] = {
    "A": "rulebook",
    "B": "interp",
    "C": "interp",
    "D": "interp",
}


def _s4_axis_card(report: Report) -> str:
    """"Why this is a Medium map" — the four size axes as a table, above the prose.

    This used to be a 60-word clause inside paragraph one. Same four facts per axis —
    name, value, verdict word and both thresholds — laid out so they can be compared
    rather than parsed.
    """
    si = report.size_inference
    axes = list(si.axes)
    if not axes:
        return ""
    rows: list[Sequence[str]] = []
    for a in axes:
        value = a.get("value")
        unit = str(a.get("unit") or "").strip()
        shown = _s4_val(float(value)) if isinstance(value, (int, float)) else str(value)
        thresholds = [_s4_val(float(t)) for t in (a.get("thresholds") or [])]
        word = _s4_axis_word(int(a.get("score", 1)))
        if len(thresholds) >= 2:
            bands = f"small under {thresholds[0]} · large over {thresholds[1]}"
        else:
            bands = "—"
        rows.append([
            el("b", esc(_S4_AXIS_PLAIN.get(str(a.get("id")), str(a.get("name") or ""))))
            + el("span", esc(str(a.get("name") or "")),
                 class_="wa-caption-xs wa-color-text-quiet", style="display:block"),
            el("span", esc(f"{shown} {unit}".strip()), class_="wa-text-nowrap"),
            chip(word, "equals", title=f"{a.get('name')} votes {word}"),
            # Two of the four bands are the rulebook's and two are ours, so each row
            # carries its own provenance chip (`_S4_AXIS_BASIS`); the reader has to be
            # able to tell which cut points they can look up and which are this
            # generator's, because the verdict is the median of all four votes, so an
            # arguable band still moves it.
            el("span", esc(bands), class_="wa-caption-xs wa-color-text-quiet",
               style="display:block")
            + _s4_source_tag(_S4_AXIS_BASIS.get(str(a.get("id")), "interp")),
        ])
    return wa_card(
        data_table(["What was measured", "This map", "Verdict", "Bands"], rows, scrollable=False),
        header_html=_s4_card_header(
            f"Why this is a {report.size.name.capitalize()} map",
            "Each axis votes independently; each band says where it came from."),
        appearance="plain")


def index_verdict(report: Report) -> str:
    """§01 — three to five dropcap paragraphs, entirely template-filled.

    One paragraph for the size inference naming all four axes and flagging any
    disagreement, one for the strongest sub-score with its two best metrics, one for
    the weakest with its two worst and their mitigations, one for any cap that fired,
    one for the day recommendation. **No free prose** — every sentence is a slot with
    typed values, so no sentence can drift from the numbers.
    """
    f = report.fitness
    size = report.size
    si = report.size_inference
    mit = {str(x.get("metric_id")): x for x in report.findings if x.get("mitigation")}
    # Paragraphs are markup, not text: two of them link a sub-score name into its own
    # score-trace item, so each entry is escaped as it is built.
    paras: list[str] = []

    # 1 · the size inference. The four axes themselves are in the table above; this
    # paragraph keeps the unanimity clause, the clamp caveat and what the size means.
    if size.inferred:
        lead = (f"This map is a {si.verdict.capitalize()} map. "
                f"Four independent axes vote on that, and they are in the table above.")
        lead += " " + (si.note if si.note else
                       ("All of them agree." if si.unanimous else "They do not all agree."))
        if not si.unanimous:
            lead += (" Where the axes disagree the vote resolves down, to the smaller and quieter "
                     "game, and the disagreement is worth reading as a warning: a map that looks "
                     "large by area and small by zone count will feel empty in play.")
        if si.clamped:
            lead += (" The vote was clamped to within one band of the area axis, which is the "
                     "axis the rulebook itself describes maps by.")
    else:
        lead = (f"The game size was set to {size.name.upper()} on the command line, so the four "
                f"inference axes in the table above are reported but not used.")
    lead += (f" A {size.name.capitalize()} map means a {num(size.hiding_period_min)}-minute hiding "
             f"period, {_s4_dist(report, size.zone_radius_m, 2)} hiding zones, "
             f"{num(size.catalogue_size)} questions in the deck and "
             f"{num(size.photo_limit_min)} minutes to answer a photo question.")
    paras.append(esc(lead))

    # 2 · the strongest sub-score
    subs = [s for s in f.subscores if s.max_tenths > 0]
    if subs:
        best = max(subs, key=lambda s: (s.earned_tenths / s.max_tenths, s.id))
        top = sorted([m for m in best.metrics if m.available and m.max_tenths > 0],
                     key=lambda m: (-(m.points_tenths / m.max_tenths), m.id))[:2]
        detail = _s4_join_words([f"{m.name.lower()} at {_s4_metric_value(m)} "
                                 f"({_s4_points(m.points_tenths, m.max_tenths)} points)" for m in top])
        paras.append(join(
            esc("The map's strongest suit is "),
            el("a", esc(best.name.lower()), href=f"#trace-{best.id}", class_="wa-link"),
            esc(f", which earns {_s4_points(best.earned_tenths, best.max_tenths)} points"
                f"{': ' + detail + '.' if detail else '.'} "
                + (f"Overall the map scores {num(f.score, 1)} of 100, which the rating bands call "
                   f"“{f.band.lower()}”."
                   if f.score is not None else
                   "No overall score is printed, because too little of the map could be "
                   "measured."))))

    # 3 · the weakest sub-score and its mitigations
    if subs:
        worst = min(subs, key=lambda s: (s.earned_tenths / s.max_tenths, s.id))
        low = sorted([m for m in worst.metrics if m.available and m.max_tenths > 0],
                     key=lambda m: (m.points_tenths / m.max_tenths, m.id))[:2]
        if worst.id != max(subs, key=lambda s: (s.earned_tenths / s.max_tenths, s.id)).id and low:
            detail = _s4_join_words([f"{m.name.lower()} at {_s4_metric_value(m)} "
                                     f"({_s4_points(m.points_tenths, m.max_tenths)} points)" for m in low])
            tail = (f", at {_s4_points(worst.earned_tenths, worst.max_tenths)}: {detail}.")
            fixes = [str(mit[m.id]["mitigation"]) for m in low if m.id in mit]
            if fixes:
                tail += " " + " ".join(fixes)
            paras.append(join(
                esc("What costs it points is "),
                el("a", esc(worst.name.lower()), href=f"#trace-{worst.id}", class_="wa-link"),
                esc(tail)))

    # 4 · caps and missing data
    if f.capped_by:
        paras.append(esc(
            f"One structural cap fired. The metrics add up to {num(f.raw_score, 1)}, but "
            f"{f.capped_by} holds the published score at {num(f.score, 1) if f.score is not None else '—'} "
            f"— a cap can only ever lower a score, never raise one, and the score trace shows both "
            f"numbers. Treat it as the map telling you which conversation to have before you play."))
    elif f.available_points < 100:
        missing = _s4_join_words(sorted({s.name.lower() for s in f.subscores if s.partial or s.missing}))
        paras.append(esc(
            f"Not everything could be measured: the score is computed from "
            f"{num(f.available_points, 1)} of 100 available points"
            f"{', with ' + missing + ' incomplete' if missing else ''}. "
            f"If we can't measure it, it comes out of the total rather than being guessed at, so "
            f"the number is honest about its own coverage."))
    else:
        borderline = [q for q in report.questions if q.borderline]
        if borderline:
            subjects = sorted({q.label for q in borderline}, key=_s4_natural_key)
            names = _s4_join_words(subjects[:3])
            paras.append(esc(
                f"Nothing capped the score, but the border did most of the work. "
                f"{num(len(borderline))} {_s4_plural(len(borderline), 'question')} about "
                f"{names}{' and others' if len(subjects) > 3 else ''} would change verdict under a "
                f"modestly larger map. Out-of-border features do not exist for this game, so agree "
                f"the rectangle before anyone draws a card, and expect at least one player to hold "
                f"up a phone showing one of those features just outside the line."))

    # 5 · the day recommendation
    best_day = _s4_best_day(report)
    worst_day = _s4_worst_day(report)
    per = f.per_day or {}
    if worst_day and best_day in per and worst_day in per:
        paras.append(esc(
            f"Play on a {_s4_day_label(report, best_day)}. The same map rates "
            f"{num(per[best_day], 1)} on a {_s4_day_label(report, best_day)} and "
            f"{num(per[worst_day], 1)} on a {_s4_day_label(report, worst_day)}, a swing of "
            f"{_s4_signed(per[worst_day] - per[best_day])} points, and every number on this page "
            f"can be re-read for another day with the selector at the top."))
    else:
        paras.append(esc(
            f"This feed distinguishes only one kind of service day, so there is no better or worse "
            f"day to play: every number on this page is measured on "
            f"{_s4_day_label(report, best_day)} service."))

    prose = el("div", "".join(el("p", t) for t in paras),
               class_="dropcap wa-prose", style="--wa-prose-line-length:72ch", id="verdict-prose")
    return section("verdict", _S4_ORDINAL, _s4_verdict_title(report),
                   el("div", join(_s4_axis_card(report), prose), class_="wa-stack wa-gap-l"),
                   kicker="The verdict")


def _s4_verdict_title(report: Report) -> str:
    """The section's own headline: the band, the size and the network shape."""
    shape = str(report.metrics.get("network_shape") or "").replace("-", " ")
    size = report.size.name.capitalize()
    band = report.fitness.band if report.fitness.score is not None else "Partly measurable"
    if shape and shape != "unknown":
        return f"{band}: a {shape} {size} map"
    return f"{band}: a {size} map"


def index_key_numbers(report: Report) -> str:
    """§04 — the twelve stat tiles in three groups, each with value, label, note and chip."""
    v = _s4_day_view(report, _s4_best_day(report))
    grid = el("div", _s4_tiles_html(report, _s4_best_day(report)),
              class_="wa-stack wa-gap-l", id="tiles")
    lede = ("Every figure is measured on this feed, on the representative day for the service "
            "type selected above. Tiles with a gold rule and a “changes by day” chip move when "
            "you change the day; the rest are map-wide or come straight from the rulebook.")
    answer = el("p", esc(
        f"{num(v.get('n_zones', len(report.zones)))} places to hide across "
        f"{_s4_area(report, float(v.get('hull_sq_m', 0.0)))}, served by "
        f"{num(v.get('routes', 0))} of {num(len(report.feed.routes))} routes."), class_="wa-body-s")
    return section("numbers", _S4_ORDINAL, "The map at a glance", grid,
                   kicker="Key numbers", lede=lede, answer_html=answer)


# ═══════════════════════════════════════════════════════════════════════════════
# S4 · SHARED MARKUP HELPERS
# ═══════════════════════════════════════════════════════════════════════════════


def _s4_chip_group(group_id: str, name: str,
                   options: Sequence[tuple[str, str] | tuple[str, str, str]], *,
                   label: str, value: str = "") -> str:
    """A filter chip row: a `wa-radio-group` of button-appearance radios.

    `wa_radio_group` in the skeleton renders plain radios; the drafts' filters are
    button-appearance ones, and the selection is the group's `value`. Built from the
    sanctioned `wa-radio-group` / `wa-radio` pair either way. An option may carry a
    third element, its icon name; the word always stays.
    """
    if not options:
        return ""
    radios = "".join(
        el("wa-radio", join(wa_icon(opt[2]) if len(opt) > 2 and opt[2] else "", esc(opt[1])),
           value=opt[0], appearance="button", size="s")
        for opt in options)
    return el("wa-radio-group", radios, id=group_id, name=name, size="s",
              orientation="horizontal", label=label, value=value or options[0][0],
              class_="wa-visually-hidden-label")


def _s4_table(headers: Sequence[str], rows: Sequence[tuple[dict[str, Any], Sequence[str]]], *,
              table_id: str = "", class_: str = "wa-zebra-rows wa-hover-rows") -> str:
    """A `<table>` whose rows can carry attributes (the filters need `data-status`).

    Cells are pre-escaped markup, headers are plain text — the same contract as the
    skeleton's `data_table`, which cannot attach per-row attributes.
    """
    thead = el("thead", el("tr", "".join(el("th", esc(h)) for h in headers)))
    body = "".join(el("tr", "".join(el("td", c) for c in cells), **row_attrs)
                   for row_attrs, cells in rows)
    return wa_scroller(el("table", thead + el("tbody", body), id=table_id or None, class_=class_))


def _s4_legend(items: Sequence[tuple[str, str]]) -> str:
    """A `wa-cluster` of `.sw` swatches with `role="list"` — the drafts' map legend."""
    return el("div", "".join(
        el("span", (swatch_html + esc(text)), class_="wa-cluster wa-gap-2xs", role="listitem")
        for swatch_html, text in items), class_="wa-cluster wa-gap-m wa-caption-xs", role="list")


def _s4_swatch(style: str) -> str:
    return el("span", "", class_="sw", style=style)


def _s4_card_header(title: str, caption: str) -> str:
    """The drafts' card header: a heading and the caption that explains the encoding
    — including, always, what the empty state means."""
    return el("div", join(el("p", esc(title), class_="wa-heading-xs"),
                          el("p", esc(caption), class_="wa-caption-xs")),
              class_="wa-stack wa-gap-3xs")


# ═══════════════════════════════════════════════════════════════════════════════
# S4 · §06 GETTING AROUND
# ═══════════════════════════════════════════════════════════════════════════════


def _s4_headway_bin(value: float) -> tuple[str, str]:
    """`(data-hb value, legend label)` for one headway in minutes."""
    for limit, bin_id, label in _S4_HEADWAY_BINS:
        if value <= limit:
            return bin_id, label
    return _S4_HEADWAY_BINS[-1][1], _S4_HEADWAY_BINS[-1][2]


def _s4_heatmap_rows(report: Report) -> list[dict[str, Any]]:
    """Every route-direction, busiest first on the opening day. No truncation."""
    best = _s4_best_day(report)
    rows = list(report.route_headways)
    rows.sort(key=lambda h: (-int((h.get("trips") or {}).get(best, 0) or 0),
                             str(h.get("short_name") or ""), str(h.get("route_id") or ""),
                             -1 if h.get("direction_id") is None else int(h["direction_id"])))
    return rows


def _s4_heatmap_table(report: Report, rows: Sequence[dict[str, Any]], table_id: str) -> str:
    """`table.hw` — routes × day types, binned, hatched where a route does not run."""
    days = _s4_day_order(report)
    head = el("tr", el("th", esc("Route")) + "".join(
        el("th", esc(_s4_day_label(report, k)), data_d=k) for k in days))
    body: list[str] = []
    for h in rows:
        route = str(h.get("short_name") or h.get("long_name") or h.get("route_id") or "")
        long_name = str(h.get("long_name") or "")
        if h.get("direction_id") is not None:
            long_name = f"{long_name} · direction {h['direction_id']}".strip(" ·")
        name_cell = el("td", el("b", esc(route)) + esc(long_name))
        cells = [name_cell]
        for key in days:
            value = (h.get("per_day") or {}).get(key)
            trips = int((h.get("trips") or {}).get(key, 0) or 0)
            title = el("b", esc(f"Route {route}{' — ' + long_name if long_name else ''}"))
            if value is None:
                tip = title + esc(f"{_s4_day_label(report, key)}: no service, no trips.")
                cell = el("div", esc("—"), class_="cell", data_hb="none", data_d=key, data_tip=tip)
            else:
                bin_id, _label = _s4_headway_bin(float(value))
                tip = title + esc(f"{_s4_day_label(report, key)}: about one every "
                                  f"{mins(float(value))}, from {num(trips)} trips.")
                cell = el("div", esc(num(float(value))), class_="cell", data_hb=bin_id, data_d=key, data_tip=tip)
            cells.append(el("td", cell))
        body.append(el("tr", "".join(cells)))
    table = el("table", el("thead", head) + el("tbody", "".join(body)), class_="hw")
    return wa_scroller(el("div", table, id=table_id))


def _s4_heatmap(report: Report, method_html: str) -> str:
    """The frequency card's body: legend, grid, method, and the overflow routes.

    The legend leads, because a reader needs the scale before the grid. The busiest
    `_S4_MAX_HEATMAP_ROUTES` rows are the grid; **every remaining route renders in
    full** in a second, complete table below it rather than collapsing into a "N more
    routes not shown" line. A report whose whole claim is completeness does not get to
    truncate its own evidence.
    """
    rows = _s4_heatmap_rows(report)
    shown, extra = rows[:_S4_MAX_HEATMAP_ROUTES], rows[_S4_MAX_HEATMAP_ROUTES:]
    # `.cell` is the 92x30 grid block; a legend swatch needs the same fill at `.sw`
    # size, and `.cell` wins the cascade, so every swatch carries the override the
    # no-service one already did.
    swatch_size = "width:11px;height:11px;display:inline-block"
    legend = _s4_legend(
        [(el("span", "", class_="sw cell", data_hb=bin_id, style=swatch_size), label)
         for _limit, bin_id, label in _S4_HEADWAY_BINS]
        + [(el("span", "", class_="sw cell", data_hb="none", style=swatch_size),
            "No service that day")])
    overflow = ""
    if extra:
        n = len(extra)
        overflow = wa_details(
            f"{num(n)} more {_s4_plural(n, 'route')}",
            _s4_heatmap_table(report, extra, "hwmap2"), appearance="plain")
    return el("div", join(legend, _s4_heatmap_table(report, shown, "hwmap"),
                          method_html, overflow),
              class_="wa-stack wa-gap-s")


def index_transit_reality(report: Report) -> str:
    """§06 — the ride-time bar chart and the headway-by-day heatmap.

    Chart A: travel time from the start location to a deterministic 14-destination
    sample, with a dashed line at the hiding period; bars are brand when they fit,
    gold when they fit with a caveat, danger when they bust the window, and hollow
    dashed when there is no service that day. Chart B: `table.hw`, routes × day types,
    binned `[data-hb='1']`–`[data-hb='6']`, hatched `[data-hb='none']` for no service.

    Both cards read title → graphic → legend → method: the encoding note is the same
    words it always was, but a reader meets the picture and its key first and the
    95-word explanation only if they want it. The `wa-chart` keeps the full caption as
    its `description`, so assistive tech loses nothing either way. Neither graphic is
    ever inside a disclosure — Chart.js and MapLibre size themselves once, at
    construction, and a collapsed container has no size.
    """
    size = report.size
    hp = num(size.hiding_period_min)
    start = report.feed.stops.get(report.opts.start_stop_id or report.hub.stop_id)
    start_name = start.name if start else report.hub.name
    cards: list[str] = []

    if report.travel_samples:
        caption = (
            f"Scheduled minutes from {start_name} at {report.opts.departure[:5]} on the selected "
            f"day, to a fixed sample of {num(len(report.travel_samples))} busy zones — the same "
            f"sample every day, so the bars are comparable across the selector. "
            f"Blue = the ride fits inside the {hp}-minute hiding period with slack; "
            f"gold = it fits but uses more than three quarters of the window or needs two changes; "
            f"red = it busts the window outright; "
            f"a hollow dashed outline = no service to that stop on the selected day. "
            f"Dashed line = the {hp}-minute hiding period. Times are scheduled, not observed: "
            f"treat each bar as a centre point, not a ceiling.")
        chart = el("wa-chart", "", id="ttchart", type="bar", index_axis="y", grid="x",
                   min="0", max=num(_s4_chart_max(report), 0, comma=False), without_legend=True,
                   label=f"Scheduled ride time from {start_name}",
                   description=caption, style="display:block;min-width:680px")
        legend = _s4_legend([
            (_s4_swatch("background:var(--accent)"), f"Fits the {hp}-minute window"),
            (_s4_swatch("background:var(--gold-mark)"), "Fits, but tight or two changes"),
            (_s4_swatch("background:var(--crit)"), "Busts the hiding period"),
            (_s4_swatch("background:transparent;border:1.5px dashed var(--baseline)"),
             "No service on the selected day"),
        ])
        cards.append(wa_card(
            el("div", join(
                wa_scroller(chart), legend,
                wa_details("How to read this chart",
                           el("p", esc(caption), class_="wa-body-s wa-color-text-quiet"),
                           appearance="plain"),
            ), class_="wa-stack wa-gap-s"),
            header_html=_s4_card_header(
                f"Scheduled ride time from {start_name}",
                f"Scheduled minutes to {num(len(report.travel_samples))} fixed destinations.")))

    n_routes = len(report.route_headways)
    if n_routes >= _S4_MIN_HEATMAP_ROUTES:
        cap = (f"Median minutes between departures per route — how often a bus comes — measured at "
               f"the route's own stops between 10:00 and 14:00, one column per service day this "
               f"feed distinguishes. The technical name is headway. "
               f"Darker = less frequent. A hatched cell means the route does not run that day at "
               f"all — which is a different statement from a slow headway, and the two are never "
               f"drawn the same way. The selected day is highlighted; hover any cell for its trip "
               f"count.")
        subtitle = "How often a bus comes, per route, per service day."
        if n_routes > _S4_MAX_HEATMAP_ROUTES:
            extra = n_routes - _S4_MAX_HEATMAP_ROUTES
            cap += (f" This feed has {num(n_routes)} route rows; the busiest "
                    f"{num(_S4_MAX_HEATMAP_ROUTES)} are in the grid and the other "
                    f"{num(extra)} are in the drawer beneath it, in full.")
            subtitle = (f"How often a bus comes. The busiest {num(_S4_MAX_HEATMAP_ROUTES)} of "
                        f"{num(n_routes)} rows are in the grid; the rest are below it.")
        method = wa_details("How to read this",
                            el("p", esc(cap), class_="wa-body-s wa-color-text-quiet"),
                            appearance="plain")
        cards.append(wa_card(_s4_heatmap(report, method),
                             header_html=_s4_card_header("How often the buses come", subtitle)))
    elif n_routes:
        labels = _s4_join_words([str(h.get("short_name") or h.get("route_id")) for h in report.route_headways])
        cards.append(wa_card(el("p", esc(
            f"This network has {num(n_routes)} route{'s' if n_routes != 1 else ''} — {labels} — "
            f"which is too few for a frequency heatmap to say anything a sentence cannot. "
            f"Median headways are in the tile above; with this few routes the Transit Line "
            f"matching question is close to degenerate and both sides should expect it to "
            f"identify a zone rather than narrow the field."), class_="wa-body-s"),
            header_html=_s4_card_header("How often the buses come",
                                        "Replaced by a sentence: fewer than three routes.")))

    if not cards:
        return ""

    lede = (f"Round one starts wherever your group begins — this report assumes "
            f"{start_name} — and a hiding run must end inside the "
            f"{hp}-minute hiding period. Later rounds start from the previous hider's zone, so "
            f"re-read these times from that stop rather than from the hub.")
    answer = el("p", esc(
        f"From {start_name} you have {hp} minutes to get anywhere and hide. The chart below is "
        f"how far that actually gets you; the grid under it is how long you wait for the ride "
        f"back."), class_="wa-body-s")
    return section("transit", _S4_ORDINAL, "Getting around",
                   el("div", "".join(cards), class_="wa-stack wa-gap-s"),
                   kicker="How long things take", lede=lede, answer_html=answer)


# ═══════════════════════════════════════════════════════════════════════════════
# S4 · §05 THE MAP YOU'RE PLAYING ON
# ═══════════════════════════════════════════════════════════════════════════════


def index_network_map(report: Report) -> str:
    """§05 — the MapLibre network map plus the copy-pasteable border.

    Served stops as small circles, zone-cover centres as larger marked circles with
    their radius drawn (behind a `wa-switch`), the hub as the ★ marker, and the
    border as a dashed gold ring. Below it, a legend built as a `wa-cluster` of `.sw`
    swatches with `role="list"`, and the border as decimal degrees *and* GeoJSON
    behind a `wa-copy-button` — the rulebook's hard requirement is that every player
    uses the exact same border.

    Guard on `typeof maplibregl === 'undefined'` and omit the map rather than throwing.
    Never wrap the map in a `wa-scroller`.
    """
    day = _s4_day_by_key(report, _s4_best_day(report))
    if day is None:
        return ""
    v = _s4_day_view(report, _s4_best_day(report))
    border = report.border
    stops_shown = len(day.served_stop_ids) <= _S4_MAX_MAP_STOPS
    rings_shown = len(report.zones) <= _S4_MAX_MAP_ZONE_RINGS

    caption_parts = [
        "Live OpenFreeMap basemap.",
        (f"Grey dots = each of the {num(len(day.served_stop_ids))} stops with service on the "
         f"selected day (hover for the name and route count)."
         if stops_shown else
         f"This feed has {num(len(day.served_stop_ids))} served stops, more than the "
         f"{num(_S4_MAX_MAP_STOPS)} this map draws individually, so only the "
         f"{num(len(report.zones))} zone centres are plotted."),
        (f"Blue dots = the {num(len(report.zones))} designated hiding zones; the switch draws each "
         f"one's true {_s4_dist(report, report.size.zone_radius_m, 2)} rulebook circle."
         if rings_shown else
         f"Blue dots = the {num(len(report.zones))} designated hiding zones. There are too many to "
         f"draw every circle, so the radius toggle is unavailable."),
        f"★ = {report.hub.name}, the inferred round-start station.",
        "Dashed gold frame = the game border. Nothing outside it exists for this game.",
        "If your browser blocks the map library the map is omitted and everything below still works.",
    ]
    caption = " ".join(caption_parts)

    controls = ""
    if rings_shown:
        controls = el("div", wa_switch(
            f"Draw the {_s4_dist(report, report.size.zone_radius_m, 2)} zone circles",
            checked=False, id="zonesw"), class_="wa-cluster wa-gap-s")

    legend_items = []
    if stops_shown:
        legend_items.append((_s4_swatch("background:var(--ink-2);border-radius:50%"),
                             "Served stop"))
    legend_items += [
        (_s4_swatch("background:var(--accent);border-radius:50%"), "Designated hiding zone"),
        (el("span", esc("★"), style="color:var(--gold-deep);font-weight:800"), report.hub.name),
        (_s4_swatch("background:transparent;border:1.5px dashed var(--gold-deep)"), "Game border"),
    ]
    if rings_shown:
        legend_items.insert(-2, (_s4_swatch(
            "background:color-mix(in srgb, var(--accent) 18%, transparent);"
            "border:1px solid var(--accent)"), "Zone circle (toggle)"))

    s, w, n, e = border.bbox
    deg_rows = [
        ("South", num(s, 6, comma=False)), ("West", num(w, 6, comma=False)),
        ("North", num(n, 6, comma=False)), ("East", num(e, 6, comma=False)),
    ]
    if border.kind == "circle":
        deg_rows.append(("Centre", f"{num(border.circle[0], 6, comma=False)}, "
                                   f"{num(border.circle[1], 6, comma=False)}"))
        deg_rows.append(("Radius", _s4_dist(report, border.circle[2], 2)))
    degrees = el("div", "".join(
        el("span", join(el("span", esc(label), class_="wa-caption-xs wa-text-uppercase"),
                        el("b", esc(value), class_="wa-heading-xs")),
           class_="wa-stack wa-gap-3xs") for label, value in deg_rows),
        class_="wa-cluster wa-gap-xl")

    geojson_text = jdump(border.geojson)
    # The card leads with the action, not with four bare decimal degrees: the rulebook
    # is emphatic that every player must be using the identical border, and the way to
    # make that true is to copy it rather than retype it.
    border_card = wa_card(
        el("div", join(
            el("p", esc("The rectangle you are playing in. Nothing outside it exists for this "
                        "game."), class_="wa-body-s"),
            el("div", join(
                wa_copy_button(geojson_text, label="Copy the border", id="geocopy"),
                el("span", esc("GeoJSON · paste into geojson.io, Google My Maps or a GPX app"),
                   class_="wa-caption-xs wa-color-text-quiet"),
            ), class_="wa-cluster wa-gap-s wa-align-items-center"),
            wa_details("Exact coordinates", degrees, appearance="plain"),
            el("p", esc(
                f"The border is the bounding box of the in-map stops padded by one hiding-zone "
                f"radius ({_s4_dist(report, border.pad_m, 2)}), so every legal zone lies wholly "
                f"inside it. It covers {_s4_area(report, border.area_sq_m)}. The rulebook leaves "
                f"borders entirely to the players, but is emphatic that everyone must use the "
                f"same one — so copy this rather than redrawing it."
            ) + prov_chip("border"), class_="wa-body-s wa-color-text-quiet"),
        ), class_="wa-stack wa-gap-m"),
        header_html=_s4_card_header("The border, exactly",
                                    "Copy it. Every player must be using the same rectangle."))

    map_card = wa_card(
        el("div", join(
            el("div", "", id="netmap", class_="wa-border-radius-m"),
            el("div", join(controls, _s4_legend(legend_items)),
               class_="wa-split wa-align-items-center wa-flex-wrap wa-gap-s"),
            wa_details("How to read this map",
                       el("p", esc(caption), class_="wa-body-s wa-color-text-quiet"),
                       appearance="plain"),
        ), class_="wa-stack wa-gap-s"),
        header_html=_s4_card_header(
            f"{num(len(day.served_stop_ids))} served stops and "
            f"{num(len(report.zones))} hiding zones",
            "Every stop that runs on the selected day."))

    shape = str(v.get("network_shape") or "unknown").replace("-", " ")
    lede = (f"The raw playing field: every stop with service on the selected day, and the "
            f"{num(len(report.zones))} hiding zones one zone per "
            f"{_s4_dist(report, report.size.zone_radius_m, 2)} circle produces. "
            f"The network reads as {shape}"
            + (f", with one station — {report.hub.name} — touching "
               f"{pct(report.hub.route_share)} of all routes"
               if report.hub.dominant else ", with no single dominant interchange") + ".")
    answer = el("p", esc(
        f"{num(len(day.served_stop_ids))} stops run on the selected day, and they group into "
        f"{num(len(report.zones))} places you are allowed to hide. Copy the border before anyone "
        f"draws a card."), class_="wa-body-s")
    return section("network", _S4_ORDINAL, "The map you\u2019re playing on",
                   el("div", join(map_card, border_card), class_="wa-stack wa-gap-s"),
                   kicker="The network", lede=lede, answer_html=answer)


# ═══════════════════════════════════════════════════════════════════════════════
# S4 · §07 THE QUESTIONS
# ═══════════════════════════════════════════════════════════════════════════════


def _s4_status_tag(status: str) -> str:
    """A question's status as a plain phrase with its icon. The one-word status survives
    in the chip's `title`, in the row's `data-status` and in §07's definition list — the
    phrase is the UI, the term is the record.

    The `title` says whose word it is. The six statuses are this report's vocabulary (see
    `_S4_STATUS_TAG`), and calling them the rulebook's turned six judgement calls into six
    rules ~98 times per report."""
    plain, icon, variant, appearance = _S4_STATUS_TAG.get(
        status, (status, "circle-question", "neutral", "outlined"))
    return chip(plain, icon, variant=variant, appearance=appearance,
                title=f"this report's word for this is “{status}”")


def _s4_question_categories(report: Report) -> list[dict[str, Any]]:
    """Per-category health, the presentation aggregate pages.md §3.6 asks for by name.

    `health = (functional + 0.5 · weak) / count`, and `randomize risk` is the share of
    the category that is dead or degenerate — which is exactly the chance that a
    Randomize redraw, which stays inside the category, hands the hider a free card.
    """
    order = [c for c in ("matching", "measuring", "radar", "thermometer", "photo", "tentacle")]
    seen = {q.category for q in report.questions}
    order += sorted(seen - set(order))
    out: list[dict[str, Any]] = []
    for cat in order:
        rows = [q for q in report.questions if q.category == cat]
        if not rows:
            continue
        counts = collections.Counter(q.status for q in rows)
        n = len(rows)
        health = (counts["functional"] + 0.5 * counts["weak"]) / n
        risk = (counts["dead"] + counts["degenerate"]) / n
        gone = sorted({q.label for q in rows if q.status in ("dead", "degenerate")},
                      key=_s4_natural_key)
        out.append({"category": cat, "label": _S4_CATEGORY_LABEL.get(cat, cat.title()),
                    "n": n, "counts": counts, "health": health, "risk": risk, "gone": gone})
    return out


def _s4_funnel(report: Report) -> str:
    """"The questions that break this map" — the greedy map-wide narrowing order."""
    order = list(report.question_order)
    funnel = list(report.question_funnel)
    if not order or len(funnel) < 2:
        return ""
    audits = {q.id: q for q in report.questions}
    defs = {d.id: d for d in catalogue_for(report.size)}
    start = funnel[0]
    items: list[str] = []
    for i, qid in enumerate(order):
        remaining = funnel[i + 1] if i + 1 < len(funnel) else funnel[-1]
        before = funnel[i]
        a = audits.get(qid)
        d = defs.get(qid)
        label = a.label if a else qid
        cat = _S4_CATEGORY_LABEL.get(a.category if a else "", "")
        cost = (f"draw {num(d.draw)} · keep {num(d.keep)}" if d else "")
        left = el("span", esc(f"{num(before)} → {num(remaining)}"),
                  class_="wa-text-nowrap wa-heading-xs")
        mid = el("span", join(
            el("b", esc(label)),
            el("span", esc(" · ".join(x for x in (cat, cost,
                                                  f"{pct(remaining / start if start else 0.0)} of the map "
                                                  f"is still in the running with you") if x)),
               class_="wa-caption-xs wa-color-text-quiet", style="display:block"),
        ))
        items.append(el("li", mid + left, class_="wa-split wa-align-items-center wa-gap-m"))
    caption = (
        f"Greedy order: at each step, the question that leaves the smallest average group of "
        f"identical answers across all {num(start)} zones. It is the seekers' best line of play "
        f"if they knew nothing about you, which is exactly the situation they are in. "
        f"After {num(len(order))} questions the map narrows from {num(start)} zones to "
        f"{num(funnel[-1])} — that is what a hider has to survive, and it is the same "
        f"computation the strategy page's simulator runs with one seeker instead of a sample.")
    return wa_card(el("div", join(
        el("ol", "".join(items), class_="recs"),
        el("p", esc(caption), class_="wa-body-s wa-color-text-quiet"),
    ), class_="wa-stack wa-gap-s"),
        header_html=_s4_card_header(
            "How fast this map narrows",
            f"{num(start)} zones down to {num(funnel[-1])}, one question at a time."))


def _s4_definition_list(rows: Sequence[tuple[str, str, str]]) -> str:
    """A `<dl>` of `(plain phrase, the precise term, what it means)`.

    This is where the precise vocabulary lives once the chips speak plain English — a
    definition list on the page, not a tooltip: tooltips do not exist on a phone, and
    this reader is on a phone.
    """
    out: list[str] = []
    for plain, term, meaning in rows:
        out.append(el("dt", join(el("b", esc(plain)),
                                 el("code", esc(term), class_="wa-caption-xs")),
                      class_="wa-cluster wa-gap-2xs wa-align-items-center"))
        out.append(el("dd", esc(meaning), class_="wa-body-s wa-color-text-quiet",
                      style="margin:0 0 var(--wa-space-xs) 0"))
    return el("dl", "".join(out), class_="wa-stack wa-gap-3xs")


def index_questions(report: Report) -> str:
    """§07 — the narrowing funnel, category health, the filterable question table, and
    every question's exact test collected into one appendix at the foot.

    Order is deliberate: the funnel answers "how fast does this map narrow?" before any
    taxonomy, the six health cards are the table's visual summary, and the 71 Overpass
    selectors — which used to be 71 separate disclosure widgets interleaved with the
    reading — are collected below the table, one row each, still one click and one
    permalink from the row they belong to.
    """
    if not report.questions:
        return ""
    cats = _s4_question_categories(report)
    cards = []
    for c in cats:
        counts = c["counts"]
        detail = " · ".join(f"{num(counts[k])} {_S4_STATUS_COUNT[k]}" for k in
                            ("functional", "weak", "degenerate", "dead", "unaskable", "unknown")
                            if counts[k])
        body = join(
            el("div", join(
                el("b", esc(c["label"]), class_="wa-heading-s"),
                el("span", esc(f"{num(c['health'] * 100, 0)}%"), class_="wa-caption-s"),
            ), class_="wa-split"),
            wa_progress_bar(c["health"] * 100,
                            label=f"{c['label']} health: {pct(c['health'])}",
                            style="--indicator-color:var(--accent);--track-color:var(--surface-2);"
                                  "--track-height:9px"),
            el("p", esc(f"{num(c['n'])} questions · {detail}") + prov_chip("B1"),
               class_="wa-body-s wa-color-text-quiet"),
            el("p", join(
                el("b", esc("Dead or fixed:"), class_="wa-caption-xs wa-text-uppercase",
                   style="color:var(--crit-text)"),
                esc(" " + _s4_join_words(c["gone"]))), class_="wa-body-s") if c["gone"] else "",
            el("p", esc(f"A Randomize redraw inside this category lands on one of those "
                        f"{pct(c['risk'])} of the time.") + prov_chip("B4"),
               class_="wa-body-s wa-color-text-quiet") if c["risk"] > 0 else "",
        )
        cards.append(wa_card(el("div", body, class_="wa-stack wa-gap-2xs")))
    grid = el("div", join(
        subhead("How each kind of question holds up"),
        el("div", "".join(cards), class_="wa-grid wa-gap-s", style="--min-column-size:300px"),
    ), class_="wa-stack wa-gap-xs")

    funnel = _s4_funnel(report) if report.geo.available else ""

    # Chip VALUES are the one-word statuses and never change — `bindFilter` keys on
    # them and so does every row's `data-status`. Only the labels are plain.
    statuses = ["functional", "weak", "degenerate", "dead", "unaskable", "unknown"]
    present = [s for s in statuses if any(q.status == s for q in report.questions)]
    options: list[tuple[str, str] | tuple[str, str, str]] = [
        ("all", f"All {num(len(report.questions))}", "list")]
    options += [(s, f"{_S4_STATUS_TAG[s][0]} · "
                    f"{num(sum(1 for q in report.questions if q.status == s))}",
                 _S4_STATUS_TAG[s][1]) for s in present]
    controls = el("div", join(
        _s4_chip_group("qchips", "qfilter", options, label="Filter questions by status"),
        search_input("qsearch", placeholder="Search the questions…",
                     label="Search the question table"),
    ), class_="wa-split wa-align-items-center wa-flex-wrap wa-gap-s", id="qcontrols")

    words = wa_details("What these words mean", _s4_definition_list(
        [(_S4_STATUS_TAG[key][0], key, meaning) for key, meaning in _S4_STATUS_DEF]
        + [("How much it narrows the search", "quality",
            "The information a question actually carries, normalised inside its own category, "
            "so a clean 50/50 split scores 100%."),
           ("Blends in", "anonymity",
            "The share of zones that answer this question exactly the way yours does — the "
            "higher it is, the more company you have.")]), appearance="plain")

    rows: list[tuple[dict[str, Any], list[str]]] = []
    selector_rows: list[Sequence[str]] = []
    for q in sorted(report.questions, key=lambda x: (x.category, x.id)):
        instances = "—" if q.instances is None else num(q.instances)
        if q.coverage is not None:
            instances = pct(q.coverage) + " of zones"
        quality = pct(q.quality, 0) if q.quality is not None else "—"
        why = el("p", esc(q.why), class_="wa-body-s")
        extras: list[str] = []
        if q.borderline:
            extras.append(chip("borderline", "circle-half-stroke", variant="warning",
                               title="would change verdict under a modestly larger map"))
        if q.surv_mean is not None:
            extras.append(chip(f"blends in {pct(q.surv_mean, 0)}",
                               title=f"anonymity {num(q.surv_mean, 2, comma=False)}"))
        extras.append(el("a", el("code", esc("test")), href=f"#sel-{q.id}",
                         class_="wa-caption-xs wa-link",
                         title="The exact thing this question was tested against"))
        why += el("div", "".join(extras), class_="wa-cluster wa-gap-2xs")
        rows.append(({"id": f"q-{q.id}", "data_status": q.status, "data_cat": q.category,
                      "data_id": q.id}, [
            el("span", esc(_S4_CATEGORY_LABEL.get(q.category, q.category)), class_="wa-text-nowrap"),
            el("b", esc(q.label)) + el("span", esc(q.text),
                                       class_="wa-caption-xs wa-color-text-quiet",
                                       style="display:block;max-width:44ch"),
            _s4_status_tag(q.status),
            el("span", esc(instances), class_="wa-text-nowrap"),
            el("span", esc(quality), class_="wa-text-nowrap"),
            why,
        ]))
        selector_rows.append([
            el("b", esc(q.label)) + el("span", esc(_S4_CATEGORY_LABEL.get(q.category, q.category)),
                                       class_="wa-caption-xs wa-color-text-quiet",
                                       style="display:block"),
            el("pre", esc(q.selector)),
        ])
    table = _s4_table(["Category", "Question", "Status", "Found on the map",
                       "How much it narrows the search", "Assessment"],
                      rows, table_id="qtable")

    tests = ""
    if selector_rows:
        head = el("thead", el("tr", el("th", esc("Question")) + el("th", esc("What was searched for"))))
        body_rows = "".join(
            el("tr", el("td", cells[0]) + el("td", cells[1]),
               id=f"sel-{q.id}")
            for q, cells in zip(sorted(report.questions, key=lambda x: (x.category, x.id)),
                                selector_rows))
        tests = wa_details(
            "Every question's exact test",
            join(el("p", esc("One row per question, printed verbatim, so you can re-run any of "
                             "them yourself. This is the same text that used to sit inside each "
                             "row of the table above."),
                    class_="wa-body-s wa-color-text-quiet"),
                 wa_scroller(el("table", head + el("tbody", body_rows),
                                class_="wa-zebra-rows"))),
            appearance="plain")

    counts = collections.Counter(q.status for q in report.questions)
    live = _s4_live_questions(report)
    title = f"{num(live)} of the {num(len(report.questions))} questions work here"
    lede = (
        "Every question in the deck, checked against this map. “Found on the map” is how many "
        "qualifying things the question has to work with inside the border; “how much it narrows "
        "the search” is the information the answer actually carries. Each status also has a "
        "one-word name of this report's own — they are not the rulebook's — and they are "
        "defined under “what these words mean”, with the chips."
    )
    if not report.geo.available:
        lede += (" OpenStreetMap was not available for this run, so only the questions this "
                 "generator can answer from the feed alone are evaluated.")
    answer = el("p", esc(
        f"{num(counts['functional'])} split the map cleanly, {num(counts['weak'])} barely help, "
        f"and {num(counts['dead'] + counts['degenerate'])} are a wasted draw you should brief "
        f"everyone about before you start."), class_="wa-body-s")
    body = el("div", join(funnel, grid, controls, words, table, tests),
              class_="wa-stack wa-gap-l")
    return section("questions", _S4_ORDINAL, title, body, kicker="The deck", lede=lede,
                   answer_html=answer)


# ═══════════════════════════════════════════════════════════════════════════════
# S4 · §08 THE CURSE DECK
# ═══════════════════════════════════════════════════════════════════════════════


def _s4_action_tag(action: str) -> str:
    """A curse's verdict as an instruction, with its icon. `data-action` — which the
    filter keys on — keeps the one-word action, and so does the chip's `title`.

    The four actions are this report's verdict on a curse, not rulebook terms — the
    rulebook has no `keep` / `warn` / `remove` / `player-choice` vocabulary. What it does
    prescribe is which specific curses to take out, and that is what tier 1 records."""
    plain, icon, variant, appearance = _S4_ACTION_TAG.get(
        action, (action, "circle-question", "neutral", "outlined"))
    return chip(plain, icon, variant=variant, appearance=appearance,
                title=f"this report's word for this is “{action}”")


def _s4_curse_rows(report: Report, curses: Sequence[CurseAudit]) -> list[tuple[dict[str, Any], list[str]]]:
    rows: list[tuple[dict[str, Any], list[str]]] = []
    tiers = {term: plain for term, plain, _meaning in _S4_TIER_DEF}
    for c in sorted(curses, key=lambda x: (x.tier, x.name, x.id)):
        count = "—" if c.count is None else num(c.count)
        action_cell = _s4_action_tag(c.action)
        attrs_row: dict[str, Any] = {"id": f"c-{c.id}", "data_action": c.action,
                                     "data_tier": str(c.tier), "data_id": c.id}
        if c.id in _S4_SPENDING_CURSES:
            attrs_row["data_spending"] = "1"
            action_cell = (el("span", _s4_action_tag(c.action), data_when="off")
                           + el("span", _s4_action_tag("remove"), data_when="on", hidden=True))
        tier_word = tiers.get(f"tier {c.tier}", "")
        why = el("p", esc(c.why), class_="wa-body-s")
        why += el("div", el("a", el("code", esc("test")), href=f"#pred-{c.id}",
                            class_="wa-caption-xs wa-link",
                            title="The exact test that decided this"),
                  class_="wa-cluster wa-gap-2xs")
        rows.append((attrs_row, [
            el("b", esc(c.name)) + el("span", esc(f"tier {num(c.tier)} · {tier_word}"),
                                      class_="wa-caption-xs wa-color-text-quiet",
                                      style="display:block"),
            action_cell,
            el("span", esc(count), class_="wa-text-nowrap"),
            why,
        ]))
    return rows


def _s4_deck_strip(report: Report, curses: Sequence[CurseAudit]) -> str:
    """The whole deck's shape in one bar — the table's visual summary.

    Labelled "as printed": it is static and deliberately does not follow `#nospend`,
    because the callout above it already says in words how many curses that switch
    moves.

    Each segment carries its action's own variant. The four actions are *state* — the
    chips directly below the bar read as its legend — and a legend whose colours do
    not appear in the thing it labels is worse than no legend. (The Points Budget is
    the opposite case: its six sub-scores are identity, so it stays one hue.)
    """
    if not curses:
        return ""
    shown = collections.Counter(c.action for c in curses)
    order = [a for a in ("keep", "warn", "remove", "player-choice") if shown[a]]
    total = float(len(curses))
    segments = [(str(shown[a]), float(shown[a]),
                 f"{_S4_ACTION_TAG[a][0]} — {num(shown[a])} of {num(len(curses))} "
                 f"{_s4_plural(len(curses), 'curse')}")
                for a in order]
    spoken = "; ".join(f"{_S4_ACTION_TAG[a][0]} {num(shown[a])}" for a in order)
    legend = el("div", "".join(
        chip(f"{_S4_ACTION_TAG[a][0]} · {num(shown[a])}", _S4_ACTION_TAG[a][1],
             variant=_S4_ACTION_TAG[a][2], appearance="outlined") for a in order),
        class_="wa-cluster wa-gap-2xs")
    return el("div", join(
        subhead("The deck, as printed"),
        budget_bar(segments, total, aria_label=f"{num(len(curses))} curses: {spoken}",
                   variants=[_S4_ACTION_TAG[a][2] for a in order]),
        legend,
    ), class_="wa-stack wa-gap-2xs")


def index_curses(report: Report) -> str:
    """§08 — the 24-row curse audit, filterable by action, with the one "no-spending"
    `wa-switch` that toggles Egg Partner, Impressionable Consumer and Lemon
    Phylactery together (the rulebook flags the first two and is silent on the third,
    which is an inconsistency worth surfacing rather than papering over).

    The 24 deciding predicates, which used to be 24 disclosure widgets inside the
    table's cells, are collected into one appendix at the foot; every row links to its
    own by permalink."""
    if not report.curses:
        return ""
    counts = collections.Counter(c.action for c in report.curses)
    main = [c for c in report.curses if c.tier <= 3]
    tier4 = [c for c in report.curses if c.tier >= 4]

    # The chip counts are over the rows the table actually holds, not over all 24 —
    # a filter that promises eight rows and shows five is worse than no filter.
    # The chip VALUES stay the rulebook's action words: `bindFilter` reads them.
    shown = collections.Counter(c.action for c in main)
    actions = ["keep", "warn", "remove", "player-choice"]
    present = [a for a in actions if shown[a]]
    options: list[tuple[str, str] | tuple[str, str, str]] = [
        ("all", f"All {num(len(main))}", "list")]
    options += [(a, f"{_S4_ACTION_TAG[a][0]} · {num(shown[a])}", _S4_ACTION_TAG[a][1])
                for a in present]
    words = wa_details("What these words mean", _s4_definition_list(
        [(_S4_ACTION_TAG[key][0], key, meaning) for key, meaning in _S4_ACTION_DEF]
        + [(plain, term, meaning) for term, plain, meaning in _S4_TIER_DEF]),
                       appearance="plain")
    # `words` sits *outside* #ccontrols, exactly as §07 places its own: #ccontrols is
    # `position: sticky`, and an open 8-term definition list inside it would pin ~500px
    # of glossary over the table it is filtering for the whole scroll.
    controls = el("div",
                  _s4_chip_group("cchips", "cfilter", options, label="Filter curses by action"),
                  class_="wa-split wa-align-items-center wa-flex-wrap wa-gap-s", id="ccontrols")

    spending_present = sorted(c.name for c in report.curses if c.id in _S4_SPENDING_CURSES)
    toggle = ""
    if spending_present:
        toggle = wa_callout(join(
            el("p", esc(
                f"The rulebook removes {_s4_join_words(spending_present[:2])} when your group does "
                f"not want to spend money during the game, and is silent about "
                f"{spending_present[-1]}, which needs a purchase just the same. That silence is an "
                f"inconsistency in the rules, not in this map, so the switch treats all "
                f"{num(len(spending_present))} together and the table shows what it changes."),
                class_="wa-body-s"),
            wa_switch("Nobody spends money during this game", checked=False, id="nospend"),
        ), variant="neutral", appearance="outlined", icon=None)

    table = _s4_table(["Curse", "Action", "Count", "Why"],
                      _s4_curse_rows(report, main), table_id="ctable")
    details = ""
    if tier4:
        details = wa_details(
            f"{num(len(tier4))} curses that no map can affect",
            join(el("p", esc(
                "These do not depend on the geography at all — they are about the deck, the clock "
                "or the players. They are listed for completeness and are never removed on this "
                "page's advice."), class_="wa-body-s"),
                _s4_table(["Curse", "Action", "Count", "Why"], _s4_curse_rows(report, tier4))),
            appearance="plain")

    head = el("thead", el("tr", el("th", esc("Curse")) + el("th", esc("The deciding test"))))
    body_rows = "".join(
        el("tr", el("td", el("b", esc(c.name))
                    + el("span", esc(f"tier {num(c.tier)}"),
                         class_="wa-caption-xs wa-color-text-quiet", style="display:block"))
           + el("td", el("pre", esc(c.predicate))), id=f"pred-{c.id}")
        for c in sorted(report.curses, key=lambda x: (x.tier, x.name, x.id)))
    tests = wa_details(
        "Every curse's deciding test",
        join(el("p", esc("One row per curse, printed verbatim. This is the same text that used "
                         "to sit inside each row of the tables above."),
                class_="wa-body-s wa-color-text-quiet"),
             wa_scroller(el("table", head + el("tbody", body_rows), class_="wa-zebra-rows"))),
        appearance="plain")

    title = (f"{num(counts['keep'])} of {num(len(report.curses))} curses work as printed on this map")
    lede = ("Every curse in the hider's deck, checked against this map's geography and this feed's "
            "network. A count is the number of qualifying features inside the border — outside "
            "does not count, because outside does not exist for this game. What each tier and each "
            "instruction means is under “what these words mean”, beside the filter.")
    answer = el("p", esc(
        f"Take {num(counts['remove'])} {_s4_plural(counts['remove'], 'curse')} out of the deck "
        f"before you start, flag {num(counts['warn'])} more, and talk about "
        f"{num(counts['player-choice'])}."), class_="wa-body-s")
    body = el("div", join(_s4_deck_strip(report, main), toggle, controls, words, table,
                          details, tests),
              class_="wa-stack wa-gap-l")
    return section("curses", _S4_ORDINAL, title, body, kicker="The curse deck", lede=lede,
                   answer_html=answer)


# ═══════════════════════════════════════════════════════════════════════════════
# S4 · §02 WHERE THE POINTS CAME FROM — the explainability anchor
# ═══════════════════════════════════════════════════════════════════════════════


def _s4_source_tag(source: str) -> str:
    """Where a threshold came from, in words, with its icon. The precise term —
    `rulebook`, `feed`, `interpretation` — survives in the chip's `title` and in the
    row's `data-basis`, which is what the interpretation styling keys on."""
    variant, word, icon, term = _S4_SOURCE_TAG.get(
        source, ("neutral", source or "—", "circle-question", source or ""))
    return chip(word, icon, variant=variant, title=f"basis: {term}" if term else word)


def _s4_trace_table(metrics: Sequence[Metric]) -> str:
    """One sub-score's metrics: value, threshold, points, and where the rule came from.

    Each row carries `id="prov-<metric id>"`, which is what every provenance chip
    elsewhere on the page links to.
    """
    head = el("thead", el("tr", "".join(el("th", esc(h)) for h in
                                        ("Metric", "Value", "Threshold", "Points", "Source"))))
    rows: list[str] = []
    for m in metrics:
        cells = [
            el("td", el("b", esc(m.name)) + (el("span", esc(m.note), class_="wa-caption-xs",
                                                style="display:block;color:var(--ink-3);max-width:62ch")
                                             if m.note else "")),
            el("td", esc(_s4_metric_value(m) if m.available else "not evaluated")),
            el("td", esc(_s4_ramp_text(m.ramp))),
            el("td", esc(_s4_points(m.points_tenths, m.max_tenths) if m.available
                         else f"— / {num(m.max_tenths / 10.0, 1)}")),
            el("td", _s4_source_tag(m.source)),
        ]
        rows.append(el("tr", "".join(cells), id=f"prov-{m.id}", data_basis=m.source,
                       data_available=("0" if not m.available else None)))
    return wa_scroller(el("table", head + el("tbody", "".join(rows))))


def index_score_trace(report: Report) -> str:
    """§02 — the explainability anchor: one accordion item per sub-score, each holding
    a table of `metric · value · threshold · points earned / possible · where the rule
    came from`. Interpretation rows are visually distinct and labelled in words. Every
    provenance chip elsewhere on the page links into one of these rows.

    The bar and the earned/max ride in the accordion item's **label**, so the six
    collapsed rows read as the whole scorecard while the tables stay one click down.
    """
    f = report.fitness
    if not f.subscores:
        return ""
    callouts: list[str] = []
    if f.capped_by:
        callouts.append(wa_callout(el("p", esc(
            f"The metrics below add up to {num(f.raw_score, 1)}, but {f.capped_by} caps the "
            f"published score at {num(f.score, 1) if f.score is not None else '—'}. A cap can only "
            f"lower a score. It fires on a structural fact about the map rather than on a "
            f"threshold crossing, and it is the first thing to fix if you want a better game."),
            class_="wa-body-s"), variant="danger", icon="circle-exclamation"))
    if f.available_points < 100:
        callouts.append(wa_callout(el("p", esc(
            f"Only {num(f.available_points, 1)} of the 100 points could be measured on this map. "
            f"If we can't measure it, it comes out of the total rather than being guessed at, and "
            f"the row below says 'not evaluated' rather than showing a number."),
            class_="wa-body-s"), variant="warning", icon="triangle-exclamation"))

    items: list[tuple[str, str, str, bool]] = []
    for s in f.subscores:
        pctage = 100.0 * s.earned_tenths / s.max_tenths if s.max_tenths else 0.0
        summary = f"{s.id} · {s.name} — {_s4_points(s.earned_tenths, s.max_tenths)} points"
        partial = ""
        if s.partial:
            n_have = sum(1 for m in s.metrics if m.available)
            partial = f"partial: {num(n_have)} of {num(len(s.metrics))} metrics"
            summary += f" ({partial})"
        label = join(
            el("span", join(
                el("strong", esc(f"{s.id} · {s.name}"), class_="wa-body-s"),
                el("span", esc(partial), class_="wa-caption-xs wa-color-text-quiet")
                if partial else "",
            ), class_="wa-cluster wa-gap-s wa-align-items-center"),
            el("span", join(
                wa_progress_bar(pctage, label=summary, style="width:8rem"),
                el("span", esc(_s4_points(s.earned_tenths, s.max_tenths)),
                   class_="wa-caption-s wa-color-text-quiet"),
            ), class_="wa-cluster wa-gap-s wa-align-items-center"),
        )
        body_html = el("div", join(
            el("p", esc(f"Metrics missing from this block: {_s4_join_words(sorted(s.missing))}."),
               class_="wa-body-s wa-color-text-quiet") if s.missing else "",
            _s4_trace_table(s.metrics),
        ), class_="wa-stack wa-gap-s")
        items.append((f"trace-{s.id}", label, body_html, s.id == f.subscores[0].id))

    ramp_legend = wa_callout(el("p", join(
        el("b", esc("How to read the threshold column.")),
        esc(" “none at 0.35, full at 0.85” means you earn zero points at 0.35, all of them at "
            "0.85, and a straight line in between."),
    ), class_="wa-body-s"), variant="neutral", appearance="plain", icon="circle-info")

    budget = ""
    if f.score is not None:
        budget = el("div", join(
            _s4_points_budget(report, style="block-size:.85rem"),
            el("p", esc("The same 100 points as the scorecard: one block per sub-score, the grey "
                        "tail is what was not earned."),
               class_="wa-caption-xs wa-color-text-quiet"),
        ), class_="wa-stack wa-gap-3xs")

    lede = ("Every point on the dial comes from one of these rows. A row names the metric, the "
            "value measured on this feed, the shaping function that turned it into points, and "
            "whether the threshold is the rulebook's, the feed's own, or this generator's "
            "interpretation. Our-call rows carry a gold rule and are never presented as rules. "
            "Arithmetic is in integer tenths of a point throughout, so the sub-scores and the "
            "total are exact sums rather than accumulated floats.")
    answer = ""
    subs = [s for s in f.subscores if s.max_tenths > 0]
    if f.score is not None and subs:
        worst = min(subs, key=lambda s: (s.earned_tenths / s.max_tenths, s.id))
        lost = (worst.max_tenths - worst.earned_tenths) / 10.0
        answer = el("p", esc(
            f"{num(f.score, 1)} out of 100. The biggest single loss is {worst.name.lower()}, "
            f"at {num(lost, 1)} points."), class_="wa-body-s")
    body = el("div", join("".join(callouts), budget, ramp_legend,
                          wa_accordion(items, mode="single-collapsible", heading_level="3")),
              class_="wa-stack wa-gap-m", id="prov-trace")
    return section("trace", _S4_ORDINAL, "Where the points came from", body,
                   kicker="Every point, traced", lede=lede, answer_html=answer)


# ═══════════════════════════════════════════════════════════════════════════════
# S4 · §03 WHAT THIS MEANS FOR YOUR GAME — house rules and findings, one section
# ═══════════════════════════════════════════════════════════════════════════════


def _s4_findings_half(report: Report) -> str:
    """§03's second half — the four findings quadrants as colour-utility `wa-card`s.

    Three fixes over the old §08. The card's **heading is the finding's sentence**,
    with its machine-built title demoted to the caption above it, because ten of these
    cards used to be titled "<metric name> is a strength here". The severity badge's
    variant follows the quadrant's tone, so a major *plus* is not painted as an alarm.
    And a day-sensitive card gets the `[data-today]` outline when the selected day is
    the one that bites.
    """
    if not report.findings:
        return ""
    blocks: list[str] = []
    for quadrant, title, colour, tint, icon in _S4_QUADRANTS:
        items = [x for x in report.findings if x.get("quadrant") == quadrant]
        if not items:
            continue
        variant = tint.removeprefix("wa-")
        cards: list[str] = []
        for item in items:
            severity = str(item.get("severity") or "")
            word, sev_icon = _S4_SEVERITY.get(severity, (severity, "circle-info"))
            badge = (chip(word, sev_icon, variant=variant, appearance="outlined",
                          title=f"severity: {severity}") if severity else "")
            # A day-sensitive card used to say so in colour only — a red outline the
            # accessibility tree never sees. Both chips are always in the markup and
            # one CSS rule swaps them, so the card itself carries the word.
            day_key = str(item.get("day_sensitive") or "")
            if day_key:
                day_label = _s4_day_label(report, day_key)
                badge = join(
                    chip(f"only on {day_label}", "calendar-day", data_today_cue="off"),
                    chip("applies to your day", "calendar-day", variant="danger",
                         appearance="filled", data_today_cue="on"),
                    badge)
            metric_id = str(item.get("metric_id") or "")
            header = el("div", join(
                el("span", esc(str(item.get("title") or ""))
                   + (prov_chip(metric_id) if metric_id else ""),
                   class_="wa-caption-xs wa-text-uppercase wa-color-text-quiet"),
                el("span", badge, class_="wa-cluster wa-gap-2xs wa-align-items-center"),
            ), class_="wa-split wa-align-items-center wa-gap-s")
            footer = ""
            if item.get("mitigation"):
                footer = el("div", join(
                    el("b", esc("What to do"), class_="wa-caption-xs wa-text-uppercase",
                       style="color:var(--good-text)"),
                    esc(" · " + str(item["mitigation"]))), class_="wa-body-s")
            cards.append(wa_card(
                el("h4", esc(str(item.get("detail") or "")), class_="wa-heading-xs wa-text-pretty"),
                header_html=header, footer_html=footer, class_=tint,
                data_day=str(item.get("day_sensitive") or "") or None))
        blocks.append(el("div", join(
            el("h4", _s4_swatch(f"background:{colour}") + wa_icon(icon) + esc(title),
               class_="wa-heading-s wa-color-text-quiet wa-cluster wa-gap-s "
                      "wa-align-items-center"),
            el("div", "".join(cards), class_="wa-grid wa-gap-m", style="--min-column-size:300px"),
        ), class_="wa-stack wa-gap-s"))

    lede = ("Nothing here is written by hand: a card appears when a scored metric crosses a "
            "threshold — under 35% of its possible points becomes a minus (or a concern when there "
            "is a known mitigation), over 85% becomes a plus. A card that only bites on one "
            "service day says which day, and says “applies to your day” when that is the day "
            "you picked above.")
    return el("div", join(
        subhead("What works, what fights you", anchor_id="findings"),
        el("p", esc(lede), class_="wa-body-s wa-color-text-quiet", style="max-inline-size:72ch"),
        el("div", "".join(blocks), class_="wa-stack wa-gap-xl", id="findings-body"),
    ), class_="wa-stack wa-gap-s")


def _s4_house_rules_half(report: Report) -> str:
    """§03's first half — the fired house rules as an `ol.recs`, in priority order.

    The whole checklist is also one `wa-copy-button` away as plain text, because the
    artefact a group actually takes to the game is a list they can paste into a chat.
    """
    if not report.recommendations:
        return ""
    items: list[str] = []
    for rec in report.recommendations:
        tags: list[str] = []
        if rec.get("required"):
            # amber, not red: red on this page already means "take it out of the deck"
            # and "this question is dead", and a third meaning would be a bug.
            tags.append(chip("everyone must agree", "circle-exclamation", variant="warning"))
        if rec.get("evidence"):
            tags.append(chip("why?", "circle-question", title=str(rec["evidence"])))
        card = wa_card(el("div", join(
            el("span", esc(str(rec.get("text") or "")), class_="wa-body-m"),
            el("div", "".join(tags), class_="wa-cluster wa-gap-2xs") if tags else "",
        ), class_="wa-stack wa-gap-2xs"))
        items.append(el("li", card))
    lede = (f"{num(len(report.recommendations))} house rules fired for this map, in the order they "
            f"matter. Each one has a predicate over the numbers above; rules whose precondition is "
            f"false are not printed at all. The last one always fires, because the rulebook demands "
            f"that conversation and explicitly refuses to automate it.")
    checklist = "\n".join(
        f"{i}. {rec.get('text') or ''}" + (" (everyone must agree)" if rec.get("required") else "")
        for i, rec in enumerate(report.recommendations, 1))
    return el("div", join(
        el("div", join(
            subhead("House rules to agree before you start", anchor_id="recs"),
            wa_copy_button(checklist, label="Copy the checklist", id="reccopy"),
        ), class_="wa-split wa-align-items-center wa-gap-s"),
        el("p", esc(lede), class_="wa-body-s wa-color-text-quiet", style="max-inline-size:72ch"),
        el("ol", "".join(items), class_="recs", id="recs-list", style="max-width:78ch"),
    ), class_="wa-stack wa-gap-s")


def index_your_game(report: Report) -> str:
    """§03 — the two things a group actually acts on: what to agree, and what to expect.

    Either half may be empty; the section renders if either survives, and when only
    one does it takes that half's own title. `#recs` and `#findings` stop being
    sections and become `<h3 id>` destinations inside this one, so every inbound link
    and every nav entry still resolves.
    """
    rules = _s4_house_rules_half(report)
    findings = _s4_findings_half(report)
    if not rules and not findings:
        return ""
    title = "What this means for your game"
    if not findings:
        title = "House rules to agree before you start"
    elif not rules:
        title = "What works, what fights you"

    quads = collections.Counter(str(x.get("quadrant") or "") for x in report.findings)
    required = sum(1 for r in report.recommendations if r.get("required"))
    n_rules = len(report.recommendations)
    answer = el("p", esc(
        f"{num(quads['plus'] + quads['benefit'])} things this map does well, "
        f"{num(quads['minus'] + quads['concern'])} that fight you, and {num(n_rules)} house "
        f"{_s4_plural(n_rules, 'rule')} — {num(required)} of them your group has to agree on."),
        class_="wa-body-s")
    body = el("div", join(rules, findings), class_="wa-stack wa-gap-2xl")
    return section("yourgame", _S4_ORDINAL, title, body, kicker="Before you play",
                   answer_html=answer)


# ═══════════════════════════════════════════════════════════════════════════════
# S4 · §09 WHERE THESE NUMBERS COME FROM
# ═══════════════════════════════════════════════════════════════════════════════


def _s4_fact_rows(rows: Sequence[tuple[str, str, str]]) -> str:
    """A definition list of `(anchor_id, label, value)` — the provenance spine."""
    out: list[str] = []
    for anchor, label, value in rows:
        if not value:
            continue
        out.append(el("div", join(
            el("span", esc(label), class_="wa-caption-xs wa-text-uppercase"),
            el("span", esc(value), class_="wa-body-s", style="overflow-wrap:anywhere"),
        ), class_="wa-stack wa-gap-3xs", id=f"prov-{anchor}" if anchor else None))
    return el("div", "".join(out), class_="wa-grid wa-gap-m", style="--min-column-size:260px")


def index_provenance(report: Report) -> str:
    """§09 — feed hash and dates, every Overpass selector with its count, the admin
    ladder, the generator version and arguments, and the full interpretation list.

    The three machine identifiers — feed sha256, generator, argv — move into a "Build
    fingerprint" disclosure with their anchors intact; `openTargeted()` opens it when a
    citation points inside."""
    p = report.provenance
    size = report.size
    agencies = p.get("agencies") or []
    agency_names = _s4_join_words([str(a.get("name") or "") for a in agencies])
    tz = str((agencies[0].get("timezone") if agencies else "") or "")

    fingerprint_rows: list[tuple[str, str, str]] = [
        ("", "Feed sha256", str(p.get("feed_sha256") or "")),
        ("generator", "Generator",
         f"{p.get('generator', GENERATOR)} {p.get('version', VERSION)}"),
        # verbatim, scratchpad path and all: this string *is* the determinism claim,
        # and truncating it would be removing content.
        ("argv", "Arguments", " ".join(str(a) for a in (p.get("argv") or [])) or "(none)"),
    ]

    fact_rows: list[tuple[str, str, str]] = [
        ("feed", "The agency's published timetable file",
         str(p.get("feed_url") or report.feed.source)),
        ("", "Feed version / publisher",
         " · ".join(x for x in (str(p.get("feed_version") or ""), str(p.get("publisher") or "")) if x)),
        ("", "Feed validity",
         f"{pretty_date(str(p['feed_start']))} – {pretty_date(str(p['feed_end']))}"
         if p.get("feed_start") and p.get("feed_end") else ""),
        ("", "Analysis date", pretty_date(str(p["as_of"])) if p.get("as_of") else ""),
        ("", "Agencies", " · ".join(x for x in (agency_names, tz) if x)),
        ("rulebook", "Game size",
         f"{size.name.upper()}{' (inferred)' if size.inferred else ' (set on the command line)'} · "
         f"{num(size.hiding_period_min)}-minute hiding period · "
         f"{_s4_dist(report, size.zone_radius_m, 2)} zones · "
         f"{num(size.catalogue_size)} questions · {num(len(report.curses))} curses"),
        ("border", "Border",
         f"{report.border.kind} · S {num(report.border.bbox[0], 6, comma=False)}, "
         f"W {num(report.border.bbox[1], 6, comma=False)}, "
         f"N {num(report.border.bbox[2], 6, comma=False)}, "
         f"E {num(report.border.bbox[3], 6, comma=False)} · padded "
         f"{_s4_dist(report, report.border.pad_m, 2)}"),
        ("questions", "Question audit",
         f"{num(len(report.questions))} questions evaluated inside the border; "
         f"{num(_s4_live_questions(report))} function, "
         f"{num(sum(1 for q in report.questions if q.borderline))} would change under a larger map"),
        ("curses", "Curse audit",
         f"{num(len(report.curses))} curses checked; "
         f"{num(len(_s4_removed_curses(report)))} removed, "
         f"{num(sum(1 for c in report.curses if c.action == 'warn'))} weakened, "
         f"{num(sum(1 for c in report.curses if c.action == 'player-choice'))} left to the players"),
        ("start", "Round-start location and departure",
         f"{report.hub.name} ({report.opts.start_stop_id or report.hub.stop_id}) at "
         f"{report.opts.departure}"),
        ("days", "Representative days",
         " · ".join(f"{d.day_type.label} {pretty_date(d.day_type.date)}" for d in report.days)),
        ("scoring", "Scoring parameters",
         f"seeker sample {num(p.get('seeker_sample_cap') or SEEKER_SAMPLE_CAP)} · "
         f"greedy k {num(p.get('greedy_k') or len(report.question_order))} · "
         f"zone radius {_s4_dist(report, float(p.get('zone_radius_m') or size.zone_radius_m), 2)}"),
    ]

    blocks: list[str] = [wa_card(join(
        _s4_fact_rows(fact_rows),
        wa_details("Build fingerprint", _s4_fact_rows(fingerprint_rows), appearance="plain"),
    ), header_html=_s4_card_header(
        "What this report was built from",
        "Everything here is derived from the feed, the OpenStreetMap snapshot and the rulebook. "
        "There is no timestamp on this page that does not come from the feed's own calendar or "
        "from the --as-of argument, which is what lets two runs produce byte-identical files."))]

    overpass = list(p.get("overpass") or [])
    if overpass:
        rows: list[tuple[dict[str, Any], list[str]]] = []
        for q in sorted(overpass, key=lambda x: (str(x.get("key")), str(x.get("cache_key")))):
            count = q.get("count")
            shown = "—" if count is None else num(int(count))
            if q.get("partial"):
                shown += " +"
            rows.append(({"id": f"prov-osm-{q.get('key')}"}, [
                el("b", esc(str(q.get("key") or ""))),
                el("span", esc(shown), class_="wa-text-nowrap"),
                el("pre", esc(str(q.get("selector") or ""))),
                el("span", esc(str(q.get("cache_key") or "")),
                   class_="wa-caption-xs wa-color-text-quiet", style="font-family:var(--mono)"),
            ]))
        note = ("Every count is the number of matching OpenStreetMap elements inside the border, "
                "from one bbox-wide query per category. A count marked with a + is a floor: a size "
                "guard forced a degraded query. Selectors are printed verbatim so you can re-run "
                "any of them at overpass-turbo.eu and check this page against a live database.")
        blocks.append(wa_card(join(
            el("p", esc(note), class_="wa-body-s wa-color-text-quiet"),
            _s4_table(["Category", "Count", "What was searched for", "Cache key"], rows)),
            header_html=_s4_card_header(
                f"{num(len(overpass))} OpenStreetMap queries",
                "One query per category, run against the border and cached by content.")))

    admin = report.geo.admin
    ladder = p.get("admin_levels") or {}
    if ladder or admin.country_code:
        items: list[str] = []
        for ordinal in ("1", "2", "3", "4"):
            level = ladder.get(ordinal, ladder.get(int(ordinal)) if isinstance(ladder, dict) else None)
            if level is None:
                items.append(f"{ordinal}: no {ordinal}th-level division on this map")
            else:
                items.append(f"{ordinal}: OSM admin_level {num(int(level))}")
        text = (f"Country {str(admin.country_name or admin.country_code or 'unknown')} · "
                + " · ".join(items))
        if admin.source == "unknown":
            text = ("The country could not be determined, so the administrative-division questions "
                    "were marked unknown rather than guessed at, and were excluded from the score's "
                    "denominator.")
        blocks.append(wa_card(el("p", esc(text), class_="wa-body-s", style="max-width:80ch"),
                              header_html=_s4_card_header(
                                  "Administrative divisions",
                                  "The rulebook's 1st–4th divisions mean different OSM levels in "
                                  "every country, so the ladder is derived from the country's own "
                                  "ISO-3166-2 encoding and never assumed.")))

    interps = list(p.get("interpretations") or [])
    if interps:
        # A `<dl>`, not an accordion. As a disclosure this was inverted: the *summary*
        # was a 30–45-word paragraph and the *payload* was two tags, so 23 chevrons
        # each promised more and delivered less. Flat, the sentence reads first, the
        # id and the affected metrics sit under it, and nothing is one click away that
        # was not already in the label. `id="interp-…"` still anchors each entry.
        entries: list[str] = []
        for i in sorted(interps, key=lambda x: str(x.get("id"))):
            iid = str(i.get("id") or "")
            affects = [str(a) for a in (i.get("affects") or [])]
            tail = (el("span", esc("affects"), class_="wa-caption-xs wa-text-uppercase "
                                                      "wa-color-text-quiet")
                    + "".join(wa_tag(a) for a in affects) if affects
                    else el("span", esc("changes no printed number directly"),
                            class_="wa-caption-xs wa-color-text-quiet"))
            entries.append(el("dt", esc(str(i.get("text") or "")),
                              class_="wa-body-s", id=f"interp-{iid}"))
            entries.append(el("dd", el("div", join(
                el("code", esc(iid), class_="wa-caption-2xs wa-color-text-quiet"), tail),
                class_="wa-cluster wa-gap-2xs wa-align-items-center"),
                style="margin:0 0 var(--wa-space-m) 0"))
        blocks.append(wa_card(el("dl", "".join(entries), class_="wa-stack wa-gap-3xs"),
                              header_html=_s4_card_header(
                                  f"{num(len(interps))} places where the rulebook is silent and "
                                  f"this generator decided",
                                  "Each of these changed a number on this page. They are "
                                  "interpretations, not rules, and a group that disagrees with one "
                                  "should feel free to overrule it.")))

    notes = sorted(set(report.geo.notes)) + sorted(set(report.degradations))
    if notes:
        blocks.append(wa_card(
            el("ul", "".join(el("li", esc(n)) for n in notes), class_="wa-stack wa-gap-2xs"),
            header_html=_s4_card_header(
                "What this data does not know",
                "Honest limits of the sources, carried straight through from the layers that "
                "produced them.")))

    index_block = _s4_sources_index(report, fact_rows + fingerprint_rows)
    if index_block:
        blocks.append(wa_card(index_block, header_html=_s4_card_header(
            "Every citation on this page, and where it lands",
            "The little superscript links next to the numbers point here.")))

    return section("sources", _S4_ORDINAL, "Where these numbers come from",
                   el("div", "".join(blocks), class_="wa-stack wa-gap-s"),
                   kicker="Provenance",
                   lede="Every number above, traced to the query that produced it.")


def _s4_sources_index(report: Report,
                      fact_rows: Sequence[tuple[str, str, str]]) -> str:
    """`<ol id="cites">` — a named home for every `prov_chip` target on the page.

    This adds no content: every one of the page's citations already points at an anchor
    that exists. What was missing was an index to land in, so a reader arriving from a
    superscript could see what the anchor is called. Deterministic by construction: the
    score trace's own order, then the provenance card's own row order, then the
    Overpass keys in the order that table already sorts them. `fact_rows` is the exact
    list `_s4_fact_rows` was handed, so an entry can never point at a row that a blank
    value suppressed.
    """
    entries: list[tuple[str, str]] = []
    if report.fitness.subscores:
        for s in report.fitness.subscores:
            for m in s.metrics:
                entries.append((f"prov-{m.id}", m.name))
        entries.append(("prov-trace", "The full score trace"))
    entries += [(f"prov-{anchor}", label) for anchor, label, value in fact_rows
                if anchor and value]
    for q in sorted(report.provenance.get("overpass") or [],
                    key=lambda x: (str(x.get("key")), str(x.get("cache_key")))):
        entries.append((f"prov-osm-{q.get('key')}",
                        f"OpenStreetMap query — {q.get('key')}"))
    if not entries:
        return ""
    lis = "".join(el("li", join(
        el("code", esc(anchor.removeprefix("prov-"))),
        el("a", esc(label), href=f"#{anchor}", class_="wa-link"),
    )) for anchor, label in entries)
    return el("ol", lis, id="cites")


# ═══════════════════════════════════════════════════════════════════════════════
# S4 · THE PAGE SCRIPT
# ═══════════════════════════════════════════════════════════════════════════════
#
# The script does four things and formats nothing: it swaps pre-rendered day markup,
# repaints the Chart.js canvas (which cannot read a CSS custom property, so the
# palette is resolved at draw time via `cssVar`), builds the MapLibre map, and
# toggles table rows. Every number it displays was formatted in Python.

_S4_INDEX_JS = r"""
/* ── data ────────────────────────────────────────────────────────────────── */
const DATA  = D('data');
const STOPS = D('stops');
const G     = DATA.game;

/* ── day state, persisted through localStorage ───────────────────────────── */
let CURRENT = DATA.selected_day;
{
  const saved = loadDay(DATA.selected_day);
  if (DATA.day_keys.indexOf(saved) >= 0) CURRENT = saved;
}

function hwHighlight() {
  document.querySelectorAll('#hwmap .cell, #hwmap2 .cell').forEach(c =>
    c.toggleAttribute('data-dim', c.dataset.d !== CURRENT));
  document.querySelectorAll('#hwmap th[data-d], #hwmap2 th[data-d]').forEach(h =>
    h.toggleAttribute('data-sel', h.dataset.d === CURRENT));
}

function flagFindings() {
  document.querySelectorAll('#findings-body wa-card[data-day]').forEach(c =>
    c.toggleAttribute('data-today', c.dataset.day === CURRENT));
}

function renderDay() {
  const d = DATA.days[CURRENT];
  if (!d) return;
  const banner = $('daybanner');
  if (banner) { banner.setAttribute('variant', d.variant); banner.innerHTML = d.banner_html; }
  const tiles = $('tiles');
  if (tiles) tiles.innerHTML = d.tiles_html;
  document.querySelectorAll('#dayscores [data-day]').forEach(t => {
    if (t.dataset.day === CURRENT) t.setAttribute('aria-current', 'true');
    else t.removeAttribute('aria-current');
  });
  hwHighlight();
  flagFindings();
  renderTT();
}

function setDay(k) {
  if (!DATA.days[k]) return;
  CURRENT = k;
  saveDay(k);
  const sel = $('daysel');
  if (sel && sel.value !== k) sel.value = k;
  renderDay();
}

/* ── ride-time chart ─────────────────────────────────────────────────────── */
/* Chart.js paints to a <canvas>, which cannot resolve var(--x); the tokens are
   read at draw time so the chart follows the wa-light / wa-dark class on <html>. */
const TT_BAR = 21, TT_GAP = 9;

const ttDecor = {
  id: 'ttDecor',
  afterDatasetsDraw(chart) {
    const cfg = chart.options.plugins.ttDecor;
    const rows = cfg.rows, max = cfg.max;
    const { ctx, scales: { x } } = chart;
    ctx.save();
    ctx.textBaseline = 'middle';
    chart.getDatasetMeta(0).data.forEach((bar, i) => {
      const t = rows[i];
      if (!t) return;
      /* bars past the axis maximum are clipped, so pin their annotation to the end */
      const px = x.getPixelForValue(Math.min(t.minutes, max));
      const y = bar.y, h = bar.height;
      if (t.avail) {
        ctx.font = '700 12px ' + cssVar('--mono');
        ctx.fillStyle = cssVar('--ink-2');
        ctx.textAlign = 'left';
        ctx.fillText(String(t.minutes), px + 6, y);
      } else {
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = cssVar('--baseline');
        ctx.strokeRect(x.getPixelForValue(0), y - h / 2,
                       Math.max(2, x.getPixelForValue(max) - x.getPixelForValue(0)), h);
        ctx.setLineDash([]);
        ctx.font = 'italic 11px ' + cssVar('--sans');
        ctx.fillStyle = cssVar('--ink-3');
        ctx.textAlign = 'right';
        ctx.fillText(t.note, x.getPixelForValue(max) - 6, y);
      }
    });
    ctx.restore();
  },
  afterDraw(chart) {
    const cfg = chart.options.plugins.ttDecor;
    const { ctx, chartArea: ca, scales: { x } } = chart;
    if (cfg.hp > cfg.max) return;
    const px = x.getPixelForValue(cfg.hp);
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = cssVar('--crit');
    ctx.beginPath(); ctx.moveTo(px, ca.top - 10); ctx.lineTo(px, ca.bottom); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '700 10.5px ' + cssVar('--sans');
    ctx.fillStyle = cssVar('--crit-text');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(cfg.hpLabel, px, ca.top - 14);
    ctx.restore();
  },
};

/* the rich tooltip is the page's own #tt panel; canvas tooltips cannot carry markup */
(function ttHover() {
  const el = $('ttchart');
  if (!el) return;
  el.addEventListener('mousemove', e => {
    if (tt.style.display !== 'block') return;
    const w = tt.offsetWidth, x = Math.min(e.clientX + 14, innerWidth - w - 12);
    tt.style.left = x + 'px'; tt.style.top = (e.clientY + 16) + 'px';
  });
  el.addEventListener('mouseleave', () => tt.style.display = 'none');
})();

let ttSeq = 0;
async function renderTT() {
  const el = $('ttchart');
  if (!el) return;
  const seq = ++ttSeq;
  const rows = (DATA.days[CURRENT] || {}).travel || [];
  if (!rows.length) return;
  const max = G.chart_max_min;
  el.style.height = (rows.length * (TT_BAR + TT_GAP) + 64) + 'px';
  if (!customElements.get('wa-chart')) await customElements.whenDefined('wa-chart');
  await el.updateComplete;
  if (seq !== ttSeq) return;                       /* a later day switch already won */

  const fill = t => !t.avail ? 'transparent'
                  : t.tone === 'bust'  ? cssVar('--crit')
                  : t.tone === 'tight' ? cssVar('--gold-mark')
                  : cssVar('--accent');
  el.plugins = [ttDecor];
  el.config = {
    type: 'bar',
    data: {
      labels: rows.map(r => r.label),
      datasets: [{
        data: rows.map(r => r.avail ? r.minutes : 0),
        backgroundColor: rows.map(fill),
        /* wa-chart auto-assigns a palette border to any dataset that omits one; these
           bars carry semantic fills only, and ttDecor draws the no-service outline */
        borderColor: 'transparent',
        borderWidth: 0,
        borderRadius: { topLeft: 0, bottomLeft: 0, topRight: 4, bottomRight: 4 },
        borderSkipped: false,
        barThickness: TT_BAR,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: matchMedia('(prefers-reduced-motion: reduce)').matches
        ? false : { duration: 450, easing: 'easeOutQuart' },
      layout: { padding: { top: 22, right: 52 } },
      scales: {
        x: {
          min: 0, max: max,
          border: { display: false },
          grid: { color: cssVar('--grid'), drawTicks: false },
          ticks: { stepSize: Math.max(5, Math.round(max / 5 / 5) * 5), color: cssVar('--ink-3'),
                   font: { family: cssVar('--sans'), size: 11 } },
        },
        y: {
          border: { display: false },
          grid: { display: false },
          ticks: {
            autoSkip: false,
            font: { family: cssVar('--sans'), size: 12.5, weight: '600' },
            color: c => rows[c.index] && !rows[c.index].avail ? cssVar('--ink-3') : cssVar('--ink'),
          },
        },
      },
      plugins: {
        legend: { display: false },
        ttDecor: { rows: rows, max: max, hp: G.hiding_period_min,
                   hpLabel: G.hiding_period_min + '-MIN HIDING PERIOD' },
        tooltip: {
          enabled: false,
          external(ctx) {
            const d = rows[ctx.tooltip.dataPoints?.[0]?.dataIndex];
            if (!ctx.tooltip.opacity || !d) { tt.style.display = 'none'; return; }
            tt.innerHTML = d.tip;
            tt.style.display = 'block';
          },
        },
      },
    },
  };
  el.renderChart();
}
/* canvas colours are baked in at draw time — repaint when the colour scheme flips */
new MutationObserver(() => renderTT())
  .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

/* ── the network map ─────────────────────────────────────────────────────── */
function ringOf(lon, lat, radiusM, n) {
  const out = [];
  const dLat = radiusM / 111132;
  const dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  for (let i = 0; i <= n; i++) {
    const a = 2 * Math.PI * i / n;
    out.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return out;
}

async function buildMap() {
  const host = $('netmap');
  if (!host) return;
  let maplibregl;
  try { maplibregl = (await import('__MAPLIBRE_JS__')).default; }
  catch (e) { console.warn('MapLibre unavailable — map omitted', e); return; }
  if (typeof maplibregl === 'undefined' || !maplibregl || !maplibregl.Map) {
    console.warn('MapLibre unavailable — map omitted');
    return;
  }

  const B = DATA.border, bb = B.bbox;                  /* [S, W, N, E] */
  const borderRing = B.kind === 'circle'
    ? ringOf(B.circle[1], B.circle[0], B.circle[2], 96)
    : [[bb[1], bb[0]], [bb[3], bb[0]], [bb[3], bb[2]], [bb[1], bb[2]], [bb[1], bb[0]]];

  const STYLES = { light: '__TILES_LIGHT__', dark: '__TILES_DARK__' };
  const PAL = { light: { stop: '#57534a', edge: '#ffffff', gold: '#a86e00', zone: '#2a78d6' },
                dark:  { stop: '#8d887c', edge: '#1b1a16', gold: '#c98500', zone: '#3987e5' } };
  const isDark = () => document.documentElement.classList.contains('wa-dark');
  let dark = isDark();

  host.style.height = '470px';
  host.classList.toggle('dark-map', dark);

  let map;
  try {
    map = new maplibregl.Map({
      container: 'netmap',
      style: STYLES[dark ? 'dark' : 'light'],
      bounds: [[bb[1], bb[0]], [bb[3], bb[2]]],
      fitBoundsOptions: { padding: { top: 40, bottom: 34, left: 40, right: 52 } },
      cooperativeGestures: true,
      attributionControl: { compact: true },
    });
  } catch (e) {
    console.warn('MapLibre failed — map omitted', e);
    host.innerHTML = ''; host.style.height = '';
    return;
  }
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: G.scale_unit }), 'bottom-left');

  const zoneRings = STOPS.rings ? {
    type: 'FeatureCollection',
    features: STOPS.zones.map(z => ({
      type: 'Feature', properties: { name: z[2] },
      geometry: { type: 'Polygon', coordinates: [ringOf(z[0], z[1], G.zone_radius_m, 40)] },
    })),
  } : { type: 'FeatureCollection', features: [] };

  /* sources and layers are rebuilt on every style.load, which fires again after
     setStyle when the colour scheme flips */
  map.on('style.load', () => {
    const p = PAL[isDark() ? 'dark' : 'light'];
    map.addSource('border', { type: 'geojson', data: {
      type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: borderRing } } });
    map.addLayer({ id: 'border-line', type: 'line', source: 'border',
      paint: { 'line-color': p.gold, 'line-width': 1.6, 'line-opacity': .85, 'line-dasharray': [3, 2.4] } });

    map.addSource('zonerings', { type: 'geojson', data: zoneRings });
    map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zonerings',
      layout: { visibility: ($('zonesw') && $('zonesw').checked) ? 'visible' : 'none' },
      paint: { 'fill-color': p.zone, 'fill-opacity': .10 } });
    map.addLayer({ id: 'zone-ring', type: 'line', source: 'zonerings',
      layout: { visibility: ($('zonesw') && $('zonesw').checked) ? 'visible' : 'none' },
      paint: { 'line-color': p.zone, 'line-width': .8, 'line-opacity': .55 } });

    map.addSource('stops', { type: 'geojson', data: {
      type: 'FeatureCollection',
      features: STOPS.stops.map(s => ({ type: 'Feature',
        properties: { name: s[2], routes: s[3] },
        geometry: { type: 'Point', coordinates: [s[0], s[1]] } })),
    } });
    map.addLayer({ id: 'stop-dots', type: 'circle', source: 'stops',
      paint: { 'circle-color': p.stop, 'circle-opacity': .8,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 1.3, 12, 2.4, 14, 3.6, 16, 5.4],
        'circle-stroke-color': p.edge, 'circle-stroke-opacity': .8,
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, .3, 13, 1] } });

    map.addSource('zonedots', { type: 'geojson', data: {
      type: 'FeatureCollection',
      features: STOPS.zones.map(z => ({ type: 'Feature',
        properties: { name: z[2], score: z[3] },
        geometry: { type: 'Point', coordinates: [z[0], z[1]] } })),
    } });
    map.addLayer({ id: 'zone-dots', type: 'circle', source: 'zonedots',
      paint: { 'circle-color': p.zone, 'circle-opacity': .9,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2.2, 12, 3.6, 14, 5, 16, 7],
        'circle-stroke-color': p.edge, 'circle-stroke-width': 1, 'circle-stroke-opacity': .85 } });
  });

  const star = document.createElement('div');
  star.className = 'mk-central';
  star.innerHTML = '<span class="star">★</span><span class="clbl">' + esc(DATA.hub.name) + '</span>';
  new maplibregl.Marker({ element: star }).setLngLat([DATA.hub.lon, DATA.hub.lat]).addTo(map);
  bindTT(star, '<b>' + esc(DATA.hub.name) + '</b>The inferred round-start station.');

  const showTip = (e, html) => {
    tt.innerHTML = html;
    tt.style.display = 'block';
    const w = tt.offsetWidth, x = Math.min(e.originalEvent.clientX + 14, innerWidth - w - 12);
    tt.style.left = x + 'px'; tt.style.top = (e.originalEvent.clientY + 16) + 'px';
  };
  /* delegated layer events survive setStyle, so bind them once */
  map.on('mousemove', 'stop-dots', e => {
    const f = e.features[0].properties;
    showTip(e, '<b>' + esc(f.name || 'Stop') + '</b>' + f.routes + ' route(s) on this day');
  });
  map.on('mouseleave', 'stop-dots', () => { tt.style.display = 'none'; });
  map.on('mousemove', 'zone-dots', e => {
    const f = e.features[0].properties;
    showTip(e, '<b>' + esc(f.name || 'Zone') + '</b>Hiding zone'
              + (f.score == null ? '' : ' · rated ' + f.score + ' / 100'));
  });
  map.on('mouseleave', 'zone-dots', () => { tt.style.display = 'none'; });

  const sw = $('zonesw');
  if (sw) sw.addEventListener('change', () => {
    const v = sw.checked ? 'visible' : 'none';
    ['zone-fill', 'zone-ring'].forEach(id => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
    });
  });

  const retheme = () => {
    const d = isDark();
    if (d === dark) return;
    dark = d;
    host.classList.toggle('dark-map', d);
    map.setStyle(STYLES[d ? 'dark' : 'light']);
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', retheme);
  new MutationObserver(retheme)
    .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
}

/* ── table filters ───────────────────────────────────────────────────────── */
/* Rows are all rendered server-side and carry their own data-* key, so filtering is
   a `hidden` toggle: the table is complete and readable with scripting off. */
function bindFilter(groupId, tableId, key) {
  const grp = $(groupId), table = $(tableId);
  if (!grp || !table) return null;
  const apply = () => {
    const want = grp.value || 'all';
    table.querySelectorAll('tbody tr').forEach(tr => {
      const chipOk = want === 'all' || tr.dataset[key] === want;
      tr.hidden = !chipOk || tr.dataset.match === '0';
    });
  };
  grp.addEventListener('change', apply);
  document.addEventListener('refilter', apply);   /* the search box and the chips agree */
  apply();
  return apply;
}

/* Free-text search over an already-rendered table. It only writes data-match; the
   `hidden` decision stays in bindFilter, so the two controls cannot fight. */
function bindSearch(inputId, tableId, key) {
  const inp = $(inputId), tbl = $(tableId);
  if (!inp || !tbl || !tbl.tBodies.length) return;
  const rows = [...tbl.tBodies[0].rows];
  const apply = () => {
    const q = inp.value.trim().toLowerCase();
    for (const r of rows) r.dataset[key] = (!q || r.textContent.toLowerCase().includes(q)) ? '1' : '0';
    document.dispatchEvent(new CustomEvent('refilter'));
  };
  inp.addEventListener('input', apply);
  apply();
}

/* ── the "nobody spends money" switch ────────────────────────────────────── */
function bindSpending(reapplyFilter) {
  const sw = $('nospend');
  if (!sw) return;
  const rows = document.querySelectorAll('#ctable tr[data-spending]');
  rows.forEach(tr => { tr.dataset.baseAction = tr.dataset.action; });
  const apply = () => {
    const on = !!sw.checked;
    document.querySelectorAll('#ctable tr[data-spending] [data-when]').forEach(node => {
      node.hidden = (node.dataset.when === 'on') !== on;
    });
    rows.forEach(tr => { tr.dataset.action = on ? 'remove' : tr.dataset.baseAction; });
    if (reapplyFilter) reapplyFilter();      /* the action filter must follow the switch */
  };
  sw.addEventListener('change', apply);
  apply();
}

/* ── boot ────────────────────────────────────────────────────────────────── */
(function boot() {
  const sel = $('daysel');
  if (sel) {
    sel.value = CURRENT;
    sel.addEventListener('change', () => setDay(sel.value));
  }
  document.querySelectorAll('#hwmap .cell[data-tip], #hwmap2 .cell[data-tip]')
    .forEach(cell => bindTT(cell, cell.dataset.tip));
  document.querySelectorAll('.budget > span[data-tip]')
    .forEach(seg => bindTT(seg, seg.dataset.tip));
  for (const tile of document.querySelectorAll('#dayscores [data-day]')) {
    tile.addEventListener('click', () => setDay(tile.dataset.day));
    tile.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDay(tile.dataset.day); }
    });
  }
  bindFilter('qchips', 'qtable', 'status');
  bindSearch('qsearch', 'qtable', 'match');
  bindSpending(bindFilter('cchips', 'ctable', 'action'));
  renderDay();
  buildMap();
  bindSpy();
  bindProgress();
  openTargeted();
})();
"""


def index_script(report: Report) -> str:
    """The page's module script: day switching, tile/chart/table re-render, the map,
    and the filter controls. Starts with `SHARED_PAGE_JS`; reads its data from the
    `#data`, `#questions`, `#curses`, `#stops` and `#provenance` JSON blocks."""
    js = (_S4_INDEX_JS
          .replace("__MAPLIBRE_JS__", MAPLIBRE_JS)
          .replace("__TILES_LIGHT__", TILES_LIGHT)
          .replace("__TILES_DARK__", TILES_DARK))
    return SHARED_PAGE_JS + js


# ═══════════════════════════════════════════════════════════════════════════════
# S4 · PAGE ASSEMBLY
# ═══════════════════════════════════════════════════════════════════════════════


def _s4_day_selector(report: Report) -> str:
    """The day-type radio group, built from the day types the feed actually
    distinguishes. A single-day-type feed hides the control entirely — there is
    nothing to choose, and an empty selector reads as a bug."""
    keys = _s4_day_order(report)
    if len(keys) < 2:
        return ""
    per = report.fitness.per_day or {}
    radios = []
    for key in keys:
        label = _s4_day_label(report, key)
        title = label
        if key in per:
            title = f"{label} — this map rates {num(per[key], 1)} of 100 on {label} service"
        radios.append(el("wa-radio", esc(label), value=key, appearance="button", size="s",
                         title=title))
    return el("wa-radio-group", "".join(radios), id="daysel", name="day", label="Playing on",
              orientation="horizontal", size="s", value=_s4_best_day(report))


def band_variant(band: str) -> str:
    """The WebAwesome colour variant for a verdict band, read off `_S3_BANDS`.

    Reading a module-level rulebook constant is not computing: the cut points are the
    rulebook's, and both renderers need the same green/amber/red for the same word.
    """
    for cut, name, _advice in _S3_BANDS:
        if name == band:
            return "success" if cut >= 65.0 else "warning" if cut >= 35.0 else "danger"
    return "neutral"


def nav_groups(live: Sequence[tuple[str, str, str, str, str]],
               order: Sequence[str]) -> tuple[tuple[str, tuple[tuple[str, str, str], ...]], ...]:
    """Turn the surviving `(anchor, group, label, icon, html)` quints into `document`'s
    `nav` shape, in `order`. A group whose sections all rendered `""` yields an empty
    link list, and `document()` then emits nothing for it — no orphan heading."""
    return tuple(
        (group, tuple((f"#{anchor}", label, icon)
                      for anchor, grp, label, icon, _html in live if grp == group))
        for group in order)


def page_chrome(report: Report, *, status_html: str) -> tuple[str, str]:
    """The chrome both pages share: `(header_slot_html, subheader_slot_html)`.

    The two pages deliberately do NOT link to each other. `index.html` is meant to be
    shareable with the whole group, and `strategy.html` names the hider's best zones —
    a link from the report would hand every seeker the hider's guide. They still read
    as one product through the shared chrome, wordmark and day state; they are simply
    not navigable from one another. `status_html` is the page's one persistent grade
    readout, and is the only part that differs between them.

    `id="color-scheme-button"` must not change — `COLOR_SCHEME_JS` binds it unguarded.
    """
    place = report.place or report.feed.agency_name
    wordmark = el("a", join(
        esc(place), el("span", esc("×"), style="color:var(--gold-deep)"), esc("Hide+Seek"),
    ), href="#top", class_="wa-caption-s wa-text-uppercase wa-cluster wa-gap-2xs wa-link-plain")

    header = el("header", join(
        wordmark,
        wa_button("Theme", id="color-scheme-button", appearance="plain", size="s",
                  icon="circle-half-stroke"),
    ), slot="header", class_="wa-split wa-align-items-center wa-gap-m")

    subheader = el("div", join(
        el("div", join(
            wa_button("Menu", data_toggle_nav=True, appearance="plain", size="s",
                      class_="wa-mobile-only", icon="bars"),
            _s4_day_selector(report),
        ), class_="wa-cluster wa-gap-s wa-align-items-center"),
        status_html,
        el("span", join(wa_icon("location-dot"), el("span", "", id="nowat")),
           class_="wa-caption-s wa-color-text-quiet wa-cluster wa-gap-2xs wa-desktop-only"),
        wa_progress_bar(0, id="readbar", label="Reading progress",
                        class_="wa-visually-hidden-label", style="--track-height:3px"),
    ), slot="subheader", class_="wa-split wa-align-items-center wa-flex-wrap wa-gap-s")
    return header, subheader


# The rail's group order. Sections declare which group they belong to; a group with
# no surviving section emits nothing at all.
_S4_NAV_ORDER: tuple[str, ...] = ("The Answer", "The Map", "The Deck", "The Receipts")

# strategy.html's two groups, same mechanism.
_S5_NAV_ORDER: tuple[str, ...] = ("Play", "Reference")


def _s4_banner_slot(report: Report) -> str:
    """The degradation notice, in `wa-page`'s `banner` slot — above the header, on
    both pages. Empty when nothing degraded: `wa-page` hides an empty banner, but an
    empty warning is worse than none either way."""
    body = _s4_degradation_callout(report)
    return el("div", body, slot="banner") if body else ""


def _s4_degradation_callout(report: Report) -> str:
    """The persistent banner that says what is missing. Rendered only when something
    actually is: an empty warning is worse than none."""
    lines = list(report.degradations)
    if not report.geo.available and not any("OpenStreetMap" in x or "osm" in x.lower() for x in lines):
        lines.insert(0, "The OpenStreetMap layer is unavailable, so every question, curse and score "
                        "that depends on map features is excluded rather than guessed at.")
    if not lines:
        return ""
    body = join(
        el("p", esc("This run is missing data, and the page says so rather than filling the gap:"),
           class_="wa-body-s"),
        el("ul", "".join(el("li", esc(x)) for x in lines), class_="wa-stack wa-gap-2xs"),
    )
    return wa_callout(body, variant="warning", appearance="filled-outlined", icon=None)


def _s4_footer(report: Report) -> str:
    p = report.provenance
    as_of = str(p.get("as_of") or report.feed.feed_start or "")
    date_text = pretty_date(as_of) if re.fullmatch(r"\d{8}", as_of) else ""
    stats = [
        (num(len(report.zones)), "hiding zones scored"),
        (f"{num(_s4_live_questions(report))} / {num(len(report.questions))}", "questions live"),
        (num(len(_s4_removed_curses(report))), "curses removed"),
        (num(len(p.get("overpass") or [])), "OpenStreetMap queries"),
        (num(len(p.get("interpretations") or [])), "documented interpretations"),
    ]
    figures = el("div", "".join(
        el("span", join(el("b", esc(value), class_="wa-heading-s"),
                        el("span", esc(label), class_="wa-caption-xs")),
           class_="wa-stack wa-gap-3xs") for value, label in stats),
        class_="wa-grid wa-gap-m", style="--min-column-size:230px")
    credit = (
        f"Generated by {p.get('generator', GENERATOR)} {p.get('version', VERSION)} from "
        f"{report.feed.agency_name}'s GTFS feed"
        + (f" (valid {pretty_date(str(p['feed_start']))} – {pretty_date(str(p['feed_end']))})"
           if p.get("feed_start") and p.get("feed_end") else "")
        + ". Map features and administrative divisions from OpenStreetMap contributors, ODbL. "
          "Basemap tiles by OpenFreeMap, from OpenMapTiles data. Rules from Jet Lag: The Game's "
          "Hide+Seek rulebook. Scheduled times are planning estimates — check live tracking on the "
          "day."
        + (f" Analysis date {date_text}, taken from the feed's own calendar." if date_text else ""))
    top = el("a", join(wa_icon("arrow-up"), esc("Back to top")), href="#top",
             class_="wa-link wa-caption-s wa-cluster wa-gap-2xs")
    return el("footer", el("div", join(figures, el("p", esc(credit), class_="wa-body-s",
                                                   style="max-width:88ch"), top),
                           class_="wa-stack wa-gap-m"), slot="footer")


def render_index(report: Report) -> str:
    """Build the complete index.html document.

    Sections, in page order: hero · §01 The verdict · §02 Where the points came from ·
    §03 What this means for your game · §04 The map at a glance · §05 The map you're
    playing on · §06 Getting around · §07 The questions · §08 The curse deck · §09
    Where these numbers come from. Returns the finished HTML string; the caller writes
    it.
    """
    # (anchor, nav group, nav label, icon, markup). A section that produced nothing is
    # dropped here and its nav entry disappears with it — pages.md §5's "no empty
    # cards" rule — and a nav group left with no links vanishes too.
    built: list[tuple[str, str, str, str, str]] = [
        ("verdict", "The Answer", "Verdict", "circle-check", index_verdict(report)),
        ("trace", "The Answer", "Where the Points Came From", "chart-simple",
         index_score_trace(report)),
        ("yourgame", "", "", "", index_your_game(report)),
        ("numbers", "The Map", "At a Glance", "hashtag", index_key_numbers(report)),
        ("network", "The Map", "The Map You're Playing On", "map-location-dot",
         index_network_map(report)),
        ("transit", "The Map", "Getting Around", "route", index_transit_reality(report)),
        ("questions", "The Deck", "The Questions", "circle-question", index_questions(report)),
        ("curses", "The Deck", "The Curse Deck", "wand-magic-sparkles", index_curses(report)),
        ("sources", "The Receipts", "Where These Numbers Come From", "book-open",
         index_provenance(report)),
    ]
    live = [quint for quint in built if quint[4]]
    # Ordinals are assigned after the drop, so the printed sequence never has a hole.
    numbered = [quint[4].replace(f'data-n="{_S4_ORDINAL}"', f'data-n="{i:02d}"', 1)
                for i, quint in enumerate(live, 1)]

    # §03 is a container; the rail addresses its two halves directly, because "house
    # rules" and "what fights you" are what a reader is actually looking for. Both are
    # `<h3 id>` destinations inside `#yourgame`, so every inbound link still resolves.
    nav_source: list[tuple[str, str, str, str, str]] = []
    for quint in live:
        if quint[0] != "yourgame":
            nav_source.append(quint)
            continue
        if report.recommendations:
            nav_source.append(("recs", "The Answer", "House Rules", "list-check", "1"))
        if report.findings:
            nav_source.append(("findings", "The Answer", "What Works, What Fights You",
                               "circle-exclamation", "1"))
    nav = nav_groups(nav_source, _S4_NAV_ORDER)

    place = report.place or report.feed.agency_name
    f = report.fitness
    status = (chip(f"{num(f.score, 1)} · {f.band}", "circle-check",
                   variant=band_variant(f.band), appearance="filled")
              if f.score is not None
              else chip("Partly measurable", "circle-question", variant="neutral"))
    header, subheader = page_chrome(report, status_html=status)

    # The day strip is card-weight and sits in the content below the hero, not
    # full-bleed in `main-header` where it out-shouted the verdict. `renderDay()` still
    # owns its `variant` and its `innerHTML`; only the shape of that string changed.
    banner = el("wa-callout", _s4_banner_html(report, _s4_best_day(report)),
                id="daybanner", appearance="filled-outlined",
                variant=_s4_banner(report, _s4_best_day(report))["variant"])

    main = el("main", join(banner, *numbered), class_="wa-stack wa-gap-3xl")

    page = el("wa-page", join(_s4_banner_slot(report), header, subheader, "<!--NAV-->",
                              index_hero(report), main, _s4_footer(report)),
              mobile_breakpoint="920")

    blocks = join(
        json_block("data", _s4_data_payload(report)),
        # `-data` suffixes: <section id="questions"> and <section id="curses"> are the
        # nav's own anchors, and a duplicate id breaks getElementById and #fragment.
        json_block("questions-data", _s4_questions_payload(report)),
        json_block("curses-data", _s4_curses_payload(report)),
        json_block("stops", _s4_stops_payload(report)),
        json_block("provenance", report.provenance),
    )

    size = report.size
    description = (
        f"Is {place}'s transit system a good map for Jet Lag: The Game's Hide+Seek? "
        f"{num(len(report.zones))} hiding zones, "
        f"{num(_s4_live_questions(report))} of {num(len(report.questions))} questions live, "
        f"{num(len(_s4_removed_curses(report)))} curses to remove"
        + (f", rated {num(report.fitness.score, 1)} of 100." if report.fitness.score is not None
           else ", with the sub-scores that could be measured.")
        + f" Generated from {report.feed.agency_name}'s GTFS feed for a {size.name.upper()} game.")

    return document(
        title=f"{place} × Hide and Seek — Map Fitness Report",
        description=description,
        body_html=page + "\n" + blocks,
        script_js=index_script(report),
        extra_css=INDEX_CSS,
        nav=nav,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# S5 · RENDER STRATEGY — strategy.html (+ the optional LLM slot)
# ═══════════════════════════════════════════════════════════════════════════════
#
# Owner: the S5 agent. Spec: scratchpad/specs/pages.md §4. Reference for quality
# (do not overwrite it): the hand-built strategy.html at the repo root.
#
# The draft's question-mode simulator is the single best thing in either page and is
# kept wholesale. It is the client-side twin of `survival_fractions` — the same
# maths with one seeker instead of a sample — and the page should say so.


# ── the optional LLM adapter — off by default ─────────────────────────────────
#
# Settled empirically; see scratchpad/QWEN_VERDICT.md. On identical input the local
# model swung scores by ±2, hallucinated facts into prose, and scored 62% on a binary
# legality call under majority-vote-of-5 (against a 50% baseline) while writing
# reasons that contradicted its own verdicts. Therefore: deterministic Python owns
# every number, score, ranking, eligibility call and every factual sentence on both
# pages. Under `--llm` the model may do exactly ONE thing: break ties among zones the
# deterministic layer scored *exactly* equal. That is the only job it cannot get
# factually wrong, because every candidate in a tie is already known to be equally
# good, so no ordering it produces becomes a claim on the page.
#
# A second slot — one validated, clearly-labelled flavour sentence per dossier zone —
# was built and then removed. Even constrained to a supplied fact list, with every
# numeral and proper noun checked against it, the surviving sentences invented "a
# bright circle", "three wide circles", "a 10-station circle" and "a good spot to
# hide". Tightening the validator (it now also rejects quantities spelled as words)
# cut the pass rate from 12/12 to 5/12 and every survivor was still wrong. A page
# that states falsehoods is worse than a page that says less.
#
# Without `--llm` the pages are complete and never mention a model.


# ═══════════════════════════════════════════════════════════════════════════════
# S5 · RENDER STRATEGY — implementation
# ═══════════════════════════════════════════════════════════════════════════════
#
# NAMES ASSUMED IN SCOPE (all from the skeleton or an earlier section; none
# redefined here)
#
#   stdlib already imported at the top of generate.py:
#       collections, json, math, re  (no new stdlib import is required)
#   third-party: httpx — but only inside LLMClient.chat, which is the one place in
#       this section that performs I/O, and only under --llm.
#
#   constants:  GENERATOR VERSION WA_KIT MAPLIBRE_JS TILES_LIGHT TILES_DARK
#               SHARED_CSS STRATEGY_CSS SHARED_PAGE_JS COLOR_SCHEME_JS SIZES
#               RADAR_MILES GEO_CATEGORIES M_PER_MILE QUARTER_MILE_M log
#   classes:    Report Options Feed Stop Route GameSize Hub Border Zone ServiceDay
#               DayType StopDay GeoData AdminInfo Poi QuestionAudit CurseAudit
#               Metric ZoneScore Threat Projection Cache CacheMiss
#   formatters: num pct mins miles km sqmi coord hhmm rhu jdump sha256_text
#   html:       esc attrs el void join wa_card wa_callout wa_tag wa_badge wa_button
#               wa_details wa_divider wa_scroller wa_progress_bar wa_switch
#               wa_radio_group wa_copy_button wa_sparkline wa_tab_group wa_accordion
#               wa_button_group wa_icon chip meter budget_bar search_input pull_quote
#               section subhead kpi prov_chip data_table json_block document
#   from S4:    _s4_imperial _s4_dist _s4_day_order _s4_day_label _s4_day_by_key
#               _s4_best_day _s4_plural _s4_natural_key _s4_swatch _s4_source_tag
#               _s4_footer _s4_degradation_callout _s4_banner_slot _s4_day_selector
#               page_chrome nav_groups band_variant _S4_ORDINAL _S5_NAV_ORDER
#
# THE RULE THIS SECTION OBEYS, same as S4: the renderer formats, it never computes.
# Every score, rank, threat, flag and metric printed here is read from `Report`.
# The only arithmetic is presentation (tenths → points, ratio → minutes for display,
# bar widths), and it is all funnelled through `_s5_pts` / `_s5_bar`.
#
# DETERMINISM: no clock, no `random`, every dict iterated through `sorted()`, and
# the LLM slot is cached by prompt hash and validated so that even when it is on it
# cannot introduce a fact that was not already in `Report`.


_S5_AXES: tuple[tuple[str, str, str, str], ...] = (
    # (id, name, what it measures, the rulebook clause it derives from)
    ("IR", "Information resistance",
     "How many other zones give the seekers the same answers you do. A zone whose "
     "answer vector is shared with many others survives questioning; a zone with a "
     "unique answer vector is named by one cheap question.",
     "Seeking — every question is answered truthfully, so the only defence is being "
     "indistinguishable."),
    ("R", "Reach",
     "Whether you can actually get here inside the hiding period, and how many "
     "changes it costs.",
     "Hiding Zones — “if the hiding period ends and you're somewhere else, then "
     "that's where your hiding zone is.”"),
    ("S", "Service",
     "Onward departures, the gap between them, and how much margin you have on the "
     "last ride out of the zone.",
     "Curses & powerups — Move costs your whole hand and needs a bus to exist."),
    ("E", "Endgame spots",
     "Publicly-accessible places inside the circle where you can legally freeze when "
     "a seeker walks in, and whether they are clustered or scattered.",
     "Hiding Spots — publicly accessible during all game hours, within 10 ft of a "
     "mapped path."),
    ("A", "Amenities",
     "A bathroom you can use, food and water, and shelter — the things that decide "
     "whether you can sit here for hours.",
     "Hiding — “you're free to do whatever you like”, for as long as it takes."),
    ("X", "Exposure",
     "Map-edge and radar exposure, how many neighbouring zones share your patch, and "
     "how expensive you are for the seekers to reach.",
     "Radar Questions — an outlier is pinned by one question; Measuring — distance "
     "from the seekers is itself information."),
)

# Axis id → (the plain name the page leads with, the short word a column header can
# hold). The rulebook's own name for the axis is never dropped: it rides alongside
# the plain one as a quiet caption in §04's accordion labels, and the letter itself
# survives as a `<code>` beside every plain name and in every `data-sort` index.
_S5_AXIS_PLAIN: dict[str, tuple[str, str]] = {
    "IR": ("How well you blend in", "Blends in"),
    "R": ("How easy it is to get there", "Getting there"),
    "S": ("How good the buses are", "Buses"),
    "E": ("Places you can legally freeze at the end", "Endgame spots"),
    "A": ("What's nearby", "Nearby"),
    "X": ("How hard you are to reach", "Hard to reach"),
}

# Simulator mode → its icon, from the fixed cross-page assignment. An icon never
# replaces the mode's word; it sits beside it.
_S5_MODE_ICON: dict[str, str] = {
    "explore": "compass", "radar": "magnifying-glass", "thermo": "temperature-half",
    "match": "equals", "measure": "ruler", "tentacle": "diagram-project",
}

# A flag's `wa-tag` variant → the icon that carries the same meaning without colour.
# Shipped to the client inside `FLAGS` so the dossier's flags are `chip()`s too.
_S5_FLAG_ICON: dict[str, str] = {
    "danger": "circle-exclamation",
    "warning": "triangle-exclamation",
    "neutral": "circle-info",
}

_S5_FLAG_TEXT: dict[str, tuple[str, str]] = {
    "no_service": ("No service", "danger"),
    "unreachable": ("Unreachable in the hiding period", "danger"),
    "pinned": ("Pinned by one question", "danger"),
    "no_legal_spot": ("No legal endgame spot found", "warning"),
    "no_toilet": ("No public toilet", "warning"),
    "strands_seekers": ("Strands the seekers", "warning"),
    "edge_zone": ("Circle crosses the border", "warning"),
    "osm_thin": ("Thin OSM coverage", "neutral"),
}

# Simulator mode → the rulebook question category it simulates. Exact names, because
# "measuring".startswith("measure") is False and silently disabled the whole family.
_S5_MODE_CATEGORY: dict[str, str] = {
    "radar": "radar", "thermo": "thermometer", "match": "matching",
    "measure": "measuring", "tentacle": "tentacle",
}
_S5_MODE_LABEL: tuple[tuple[str, str], ...] = (
    ("explore", "Explore"), ("radar", "Radar"), ("thermo", "Thermometer"),
    ("match", "Matching"), ("measure", "Measuring"), ("tentacle", "Tentacles"),
)

_S5_MAX_MAP_ZONES = 1200          # above this the map plots score bands, not labels
_S5_RADAR_ID_MILES: dict[str, float] = {
    "radar.quarter_mile": 0.25, "radar.half_mile": 0.5, "radar.1mi": 1.0,
    "radar.3mi": 3.0, "radar.5mi": 5.0, "radar.10mi": 10.0,
    "radar.25mi": 25.0, "radar.50mi": 50.0, "radar.100mi": 100.0,
}

# A tentacle question's own reach, in miles, from its `param`. NOT `size.tentacle_reach_mi`:
# that is the deck's headline figure, and a LARGE deck holds 1-mile tentacles (Museums,
# Libraries, Movie Theaters, Hospitals) and 15-mile ones (Metro Lines, Zoos, Aquariums,
# Amusement Parks) at the same time, so one number per size cannot express it.
_S5_TENTACLE_ID_REACH_MI: dict[str, float] = {
    q.id: float(q.param) for q in QUESTIONS
    if q.category == "tentacle" and q.param is not None
}

_S5_SPOTS_SHIPPED = 10        # the dossier lists 8; the rest is a count, not a payload
_S5_MAX_POI_PER_CATEGORY = 500    # simulator payload cap; the page states when it bites
_S5_TABLE_PAGE = 100
_S5_TABLE_PAGE_ABOVE = 300


# ── small presentation helpers ────────────────────────────────────────────────

def _s5_pts(tenths: int | None) -> float:
    """Integer tenths of a point → the number the page prints."""
    return 0.0 if tenths is None else rhu(tenths / 10.0, 1)


def _s5_bar(earned: int | None, maximum: int | None) -> float:
    """Axis fill as a 0–100 percentage, guarding a zero denominator."""
    if not maximum:
        return 0.0
    return rhu(100.0 * (earned or 0) / maximum, 1)


def _s5_score_of(report: Report, zone_id: str) -> ZoneScore | None:
    return report.zone_scores.get(zone_id)


def _s5_zone_by_id(report: Report) -> dict[str, Zone]:
    return {z.zone_id: z for z in report.zones}


def _s5_band(overall: float, best: float) -> str:
    """Colour band for the map and the list, relative to this map's own best zone.

    Relative rather than absolute on purpose: a 41-point zone is a bad hide on a
    great map and the best available hide on a poor one, and the player needs to
    see which situation they are in.
    """
    if best <= 0:
        return "un"
    share = overall / best
    if share >= 0.9:
        return "top"
    if share >= 0.75:
        return "good"
    if share >= 0.55:
        return "fair"
    return "weak"


def _s5_reference_score(report: Report) -> ZoneScore | None:
    """The first ranked zone that carries a score.

    The per-axis maxima are identical across zones, so one of them supplies the
    published totals every axis label, column tooltip and legend row prints. Reading
    them off a real zone rather than restating them keeps the page and the score from
    ever disagreeing.
    """
    for zid in report.ranked_zone_ids:
        if zid in report.zone_scores:
            return report.zone_scores[zid]
    return None


def _s5_flag_chip(flag: str) -> str:
    """One zone flag, as icon **and** word — never colour alone."""
    label, variant = _S5_FLAG_TEXT.get(flag, (flag, "neutral"))
    return chip(label, _S5_FLAG_ICON.get(variant, "circle-info"), variant=variant)


def _s5_route_names(report: Report, route_ids: Sequence[str]) -> list[str]:
    out = []
    for rid in route_ids:
        route = report.feed.routes.get(rid)
        if route is None:
            continue
        out.append(route.short_name or route.long_name or rid)
    return sorted(set(out), key=_s4_natural_key)


def _s5_live_questions(report: Report) -> list[QuestionAudit]:
    return [q for q in report.questions if q.status in ("functional", "weak")]


def _s5_metric_by_id(score: ZoneScore) -> dict[str, Metric]:
    return {m.id: m for m in score.metrics}


def _s5_travel_minutes(report: Report, score: ZoneScore) -> float | None:
    """R1 is stored as travel ÷ hiding period; the page prints minutes.

    Derived rather than re-measured — the ratio is the scored quantity and this is
    only its presentation, so the two can never disagree.
    """
    m = _s5_metric_by_id(score).get("R1")
    if m is None or m.raw is None:
        return None
    return rhu(float(m.raw) * report.size.hiding_period_min, 1)


def _s5_day_service(report: Report, zone_id: str, day_key: str) -> dict[str, Any]:
    """The designated station's service facts on one day."""
    day = _s4_day_by_key(report, day_key)
    if day is None:
        return {"served": False}
    sd = day.stop_days.get(zone_id)
    if sd is None:
        return {"served": False}
    deps = list(sd.departures)
    # a coarse histogram of the day's departures, for the sparkline
    buckets = [0] * 24
    for t in deps:
        h = int(t // 3600) % 24
        buckets[h] += 1
    return {
        "served": True,
        "first": hhmm(sd.first),
        "last": hhmm(sd.last),
        "departures": len(deps),
        "headway_min": None if sd.median_headway_s is None else rhu(sd.median_headway_s / 60.0, 0),
        "worst_gap_min": None if sd.worst_gap_s is None else rhu(sd.worst_gap_s / 60.0, 0),
        "frequent": sd.frequent,
        "routes": _s5_route_names(report, sd.routes),
        "hist": buckets,
    }


# ── payloads ──────────────────────────────────────────────────────────────────

def _s5_metric_defs(report: Report) -> list[dict[str, Any]]:
    """The metric definitions, which are identical for every zone.

    Shipping them per zone cost 5.5 kB × n and dominated the page: on the reference
    feed it was 1.7 MB of the 2.1 MB payload. The rows are emitted once here and the
    per-zone payload carries only the three things that actually vary.
    """
    for zid in report.ranked_zone_ids:
        score = report.zone_scores.get(zid)
        if score is None:
            continue
        return [{"id": m.id, "name": m.name, "unit": m.unit,
                 "max": _s5_pts(m.max_tenths), "source": m.source, "note": m.note}
                for m in score.metrics]
    return []


def _s5_metric_row(score: ZoneScore, defs: Sequence[dict[str, Any]]) -> list[Any] | None:
    """`[raw, points, available, note-override]` per metric, or None if this zone's
    metric list does not line up with the shared definitions (then the full rows are
    shipped for that zone instead — correctness before compactness)."""
    if [m.id for m in score.metrics] != [d["id"] for d in defs]:
        return None
    out = []
    for m, d in zip(score.metrics, defs):
        out.append([None if m.raw is None else rhu(float(m.raw), 3),
                    _s5_pts(m.points_tenths),
                    1 if m.available else 0,
                    None if m.note == d["note"] else m.note])
    return out


def _s5_tie_break(report: Report, ranked: Sequence[str]) -> list[str]:
    """Reorder runs of zones that scored *exactly* equal, under `--llm`.

    This is the only thing the model is trusted with by default, because it is the
    only thing it cannot get factually wrong: every candidate is already known to be
    equally good, so any order is defensible and none of it becomes a claim on the
    page. Without `--llm` the deterministic order is returned untouched.
    """
    if not report.opts.llm or len(ranked) < 2:
        return list(ranked)
    scores = report.zone_scores
    zones = _s5_zone_by_id(report)
    cache = Cache(report.opts.cache_dir, offline=report.opts.offline, refresh=report.opts.refresh)
    client = LLMClient(report.opts, cache)

    out: list[str] = []
    run: list[str] = []
    moved = 0

    def flush() -> None:
        nonlocal moved
        if len(run) < 2:
            out.extend(run)
            return
        facts = {}
        for zid in run:
            zone = zones.get(zid)
            inv = report.geo.zone_inventory.get(zid, {})
            facts[zid] = (f"{zone.name if zone else zid}; "
                          f"routes {len(zone.route_ids) if zone else 0}; "
                          + "; ".join(f"{k} {v}" for k, v in sorted(inv.items()) if v))
        ordered = llm_break_ties(client, run, facts)
        if ordered != sorted(run):
            moved += 1
        out.extend(ordered)

    for zid in ranked:
        if run and scores[zid].overall_tenths != scores[run[0]].overall_tenths:
            flush()
            run = []
        run.append(zid)
    flush()
    if moved:
        log.info("LLM tie-break reordered %d group(s) of exactly-equal zones", moved)
    return out


def _s5_zone_payload(report: Report) -> dict[str, Any]:
    """`#zones` — every scored zone, ranked, with everything the dossier prints."""
    zones = _s5_zone_by_id(report)
    scores = report.zone_scores
    ranked = list(report.ranked_zone_ids)
    best = max((scores[z].overall_tenths for z in ranked if z in scores), default=0)
    day_keys = _s4_day_order(report)
    admin = report.geo.admin
    defs = _s5_metric_defs(report)

    # `rank_zones` returns only the rankable zones — a zone that is unreachable or
    # unserved is scored but deliberately left out of the ranking. Those still have
    # to reach the page (pages.md: nothing is ever silently dropped), so they are
    # appended after the ranked ones, in zone_id order, carrying rank None.
    ranked = _s5_tie_break(report, ranked)
    leftover = sorted(zid for zid in scores if zid not in set(ranked))
    if leftover:
        log.info("%d scored zones are outside the ranking (unreachable or unserved)", len(leftover))

    rows: list[dict[str, Any]] = []
    for position, zid in enumerate(list(ranked) + leftover, start=1):
        zone, score = zones.get(zid), scores.get(zid)
        if zone is None or score is None:
            continue
        rank = position if position <= len(ranked) else None
        overall = _s5_pts(score.overall_tenths)
        compact = _s5_metric_row(score, defs)
        rows.append({
            "id": zid,
            "rank": rank,
            "name": zone.name,
            "lat": coord(zone.lat),
            "lon": coord(zone.lon),
            "overall": overall,
            "max": _s5_pts(sum(score.axis_max.get(a, 0) for a in sorted(score.axis_max))),
            "band": _s5_band(overall, _s5_pts(best)),
            "capped_by": score.capped_by,
            "axes": {a: _s5_pts(score.axes.get(a)) for a, *_ in _S5_AXES},
            "axis_max": {a: _s5_pts(score.axis_max.get(a)) for a, *_ in _S5_AXES},
            "bars": {a: _s5_bar(score.axes.get(a), score.axis_max.get(a)) for a, *_ in _S5_AXES},
            "flags": list(score.flags),
            "excluded": score.excluded,
            "exclude_reason": score.exclude_reason,
            "stop_ids": list(zone.stop_ids),
            "routes": _s5_route_names(report, zone.route_ids),
            "travel_min": _s5_travel_minutes(report, score),
            "surv_k": rhu(score.surv_k, 3),
            "pin_worst": rhu(score.pin_worst, 3),
            "mean_surv": rhu(score.mean_surv, 3),
            "threats": [{"id": t.question_id, "label": t.label, "surv": rhu(t.surv, 3),
                         "answer": t.answer, "remaining": t.zones_remaining}
                        for t in score.threats],
            "m": compact,
            "metrics": None if compact is not None else [
                {"id": m.id, "name": m.name,
                 "raw": None if m.raw is None else rhu(float(m.raw), 3),
                 "unit": m.unit, "points": _s5_pts(m.points_tenths),
                 "max": _s5_pts(m.max_tenths), "source": m.source,
                 "note": m.note, "available": m.available}
                for m in score.metrics],
            # The dossier shows the best few; shipping all of them cost 4.9 kB per
            # zone and made the CTA page 6 MB. Ship what is displayed plus headroom,
            # and carry the true total so the card can say what it is not showing.
            "spots": [{"name": s.get("name", ""), "type": s.get("type", ""),
                       "dist_m": rhu(float(s.get("distance_m", 0.0)), 0),
                       "enclosed": bool(s.get("enclosed")),
                       "verify": bool(s.get("verify")),
                       "osm": s.get("osm", "")}
                      for s in (report.geo.legal_spots.get(zid, []) or [])[:_S5_SPOTS_SHIPPED]],
            "spots_total": len(report.geo.legal_spots.get(zid, []) or []),
            "inventory": {k: v for k, v in sorted(report.geo.zone_inventory.get(zid, {}).items()) if v},
            "admin": {str(k): v for k, v in sorted(admin.per_zone.get(zid, {}).items())},
            "service": {k: _s5_day_service(report, zid, k) for k in day_keys},
        })
    return {
        "zones": rows,
        "metric_defs": defs,
        "best": _s5_pts(best),
        "ranked": [r["id"] for r in rows],
        "dossiers": list(report.dossier_zone_ids),
        "page_size": _S5_TABLE_PAGE,
        "paged": len(rows) > _S5_TABLE_PAGE_ABOVE,
        "map_labels": len(rows) <= _S5_MAX_MAP_ZONES,
    }


def _s5_poi_payload(report: Report) -> dict[str, Any]:
    """`#poi` — the features the simulator needs, as `[lon, lat, name]` triples.

    Only categories a live question actually uses are shipped, and each is capped;
    the page says so when the cap bites rather than quietly drawing a subset.
    """
    # Exactly the categories a chip can select: the id suffix of an OSM-backed
    # question in one of the three category-driven modes.
    geo_keys = {c.key for c in GEO_CATEGORIES}
    used = set()
    for q in report.questions:
        if q.category not in ("matching", "measuring", "tentacle"):
            continue
        key = q.id.split(".", 1)[1] if "." in q.id else q.id
        if key in geo_keys and report.geo.pois.get(key):
            used.add(key)

    out: dict[str, Any] = {}
    capped: list[str] = []
    labels = {c.key: c.label for c in GEO_CATEGORIES}
    for key in sorted(used):
        pois = report.geo.pois.get(key) or []
        if not pois:
            continue
        ordered = sorted(pois, key=lambda p: (p.osm_type, p.osm_id))
        if len(ordered) > _S5_MAX_POI_PER_CATEGORY:
            capped.append(key)
            ordered = ordered[:_S5_MAX_POI_PER_CATEGORY]
        out[key] = {
            "label": labels.get(key, key),
            "count": len(pois),
            "features": [[coord(p.lon), coord(p.lat), p.name] for p in ordered],
        }
    return {"categories": out, "capped": sorted(capped),
            "cap": _S5_MAX_POI_PER_CATEGORY, "available": report.geo.available}


def _s5_reach_words(reaches: Sequence[float]) -> str:
    """"1 mile", "1 mile and 15 miles", or the SMALL game's plain statement of the rule."""
    if not reaches:
        return "none — no tentacle question in a SMALL game"
    parts = [f"{num(r, 0)} mile" + ("" if float(r) == 1.0 else "s") for r in reaches]
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + " and " + parts[-1]


def _s5_mode_chips(report: Report) -> dict[str, Any]:
    """Per-mode chip definitions, resolved in Python.

    The chips have to name a real question and a real OSM category, and neither id
    can be reconstructed in the browser: radar radii are ids like `radar.quarter_mile`
    and `radar.3mi`, and a category chip only means something if a question of that
    category exists *and* the features were fetched. Both joins happen here, once.
    """
    geo_keys = {c.key for c in GEO_CATEGORIES}
    counts = report.geo.counts
    labels = {c.key: c.label for c in GEO_CATEGORIES}

    out: dict[str, Any] = {}

    radar = []
    for q in sorted(report.questions, key=lambda q: q.id):
        if q.category != "radar" or q.id.endswith(".choose"):
            continue
        radius = _S5_RADAR_ID_MILES.get(q.id)
        if radius is None:
            continue
        radar.append({"id": q.id, "miles": radius, "label": q.label,
                      "status": q.status, "why": q.why,
                      "usable": q.status in ("functional", "weak")})
    out["radar"] = sorted(radar, key=lambda r: r["miles"])

    for mode in ("match", "measure", "tentacle"):
        category = _S5_MODE_CATEGORY[mode]
        chips = []
        for q in sorted(report.questions, key=lambda q: q.id):
            if q.category != category:
                continue
            key = q.id.split(".", 1)[1] if "." in q.id else q.id
            if key not in geo_keys:
                continue          # not an OSM-backed subject (admin borders, transit lines)
            chip_def = {
                "key": key, "qid": q.id,
                "label": labels.get(key, q.label),
                "count": counts.get(key, 0),
                "status": q.status, "why": q.why,
                "usable": q.status in ("functional", "weak") and bool(report.geo.pois.get(key)),
            }
            if mode == "tentacle":
                # That question's own reach, which `answerFor` measures against. Never
                # `G.tentacle_reach_mi` — a LARGE deck holds two reaches at once.
                chip_def["reach_mi"] = _S5_TENTACLE_ID_REACH_MI.get(q.id, 0.0)
            chips.append(chip_def)
        out[mode] = chips
    return out


def _s5_game_payload(report: Report) -> dict[str, Any]:
    """`#sgame` — the parameters the simulator needs to answer a question."""
    size = report.size
    border = report.border
    live = {q.id: {"label": q.label, "status": q.status, "why": q.why,
                   "instances": q.instances, "quality": rhu(q.quality, 3),
                   "category": q.category}
            for q in report.questions}
    return {
        "place": report.place,
        "size": size.name,
        "zone_radius_m": rhu(size.zone_radius_m, 1),
        "hiding_period_min": size.hiding_period_min,
        "tentacle_reach_mi": size.tentacle_reach_mi,
        "radar_miles": [m for m in RADAR_MILES],
        "scale_unit": "imperial" if _s4_imperial(report) else "metric",
        "border": {"kind": border.kind, "bbox": [coord(x) for x in border.bbox],
                   "circle": [coord(border.circle[0]), coord(border.circle[1]),
                              rhu(border.circle[2], 1)]},
        "hub": {"id": report.hub.stop_id, "name": report.hub.name,
                "lat": coord(report.hub.lat), "lon": coord(report.hub.lon)},
        "days": [{"key": k, "label": _s4_day_label(report, k)} for k in _s4_day_order(report)],
        "default_day": _s4_best_day(report),
        "questions": live,
        "chips": _s5_mode_chips(report),
        "order": list(report.question_order),
    }


# ── the hero's pick card ──────────────────────────────────────────────────────

def strategy_pick_card(report: Report) -> str:
    """The page's answer, above everything else: the top-ranked zone in full.

    Zone scores are not day-dependent — the day changes only the service block in the
    rail, the dossier and the table — so this card is server-rendered once and never
    re-renders on a day switch. It is consistent with the client's own state by
    construction: `selected` initialises to the same zone.
    """
    if not report.ranked_zone_ids:
        return ""
    zid = report.ranked_zone_ids[0]
    score = report.zone_scores.get(zid)
    zone = _s5_zone_by_id(report).get(zid)
    if score is None or zone is None:
        return ""

    # The same total the dossier prints, summed the same way, so the two agree.
    maximum = _s5_pts(sum(score.axis_max.get(a, 0) for a in sorted(score.axis_max)))
    meters = "".join(
        meter(el("span", join(
                  el("span", esc(_S5_AXIS_PLAIN[axis][0]), class_="wa-caption-s"),
                  el("code", esc(axis), class_="wa-caption-2xs"),
              ), class_="wa-cluster wa-gap-2xs wa-align-items-center"),
              _s5_bar(score.axes.get(axis), score.axis_max.get(axis)),
              el("span", esc(f"{num(_s5_pts(score.axes.get(axis)), 1)}"
                             f" / {num(_s5_pts(score.axis_max.get(axis)), 0)}"),
                 class_="wa-caption-s wa-color-text-quiet"),
              flank="3rem")
        for axis, *_rest in _S5_AXES)

    routes = ", ".join(_s5_route_names(report, zone.route_ids))
    travel = _s5_travel_minutes(report, score)
    ride = (f"{mins(travel)} from {report.hub.name}" if travel is not None
            else f"not reachable from {report.hub.name} inside the hiding period")
    flags = "".join(_s5_flag_chip(f) for f in score.flags)

    buttons = [
        wa_button("Open its dossier", href="#dossier", variant="brand", appearance="filled",
                  icon="location-dot"),
        wa_button("Show on the map", data_zone=zid, appearance="outlined",
                  icon="map-location-dot"),
        wa_button(f"See all {num(len(report.zones))} →", href="#all", appearance="plain"),
    ]
    return wa_card(
        el("div", join(
            el("div", join(
                el("strong", esc(zone.name), class_="wa-heading-l"),
                el("span", esc(f"{routes} · {ride}" if routes else ride),
                   class_="wa-caption-s wa-color-text-quiet"),
                el("div", meters, class_="wa-stack wa-gap-2xs"),
                el("div", flags, class_="wa-cluster wa-gap-2xs") if flags else "",
            ), class_="wa-stack wa-gap-2xs", style="flex:1"),
            el("div", join(
                el("span", esc(num(_s5_pts(score.overall_tenths), 1)), class_="wa-heading-2xl",
                   style="font-family:var(--sans)"),
                el("span", esc(f"of {num(maximum, 0)}"), class_="wa-caption-xs wa-color-text-quiet"),
            ), class_="wa-stack wa-gap-3xs wa-align-items-end"),
        ), class_="wa-flank:end wa-gap-l", style="--flank-size:5rem"),
        header_html=el("div", join(
            el("span", esc("The pick"), class_="wa-caption-xs wa-text-uppercase"),
            wa_badge("#1", variant="brand"),
        ), class_="wa-split wa-align-items-center"),
        footer_html=el("div", "".join(buttons), class_="wa-cluster wa-gap-s"),
        class_="wa-brand")


# ── §04 how zones are scored ──────────────────────────────────────────────────

def strategy_axes(report: Report) -> str:
    """§04 — the six axes as reference material: one accordion item each.

    Demoted from first to fourth and left collapsed on purpose. A reader arrives here
    from a column header in §02 wanting one axis, not six; and a collapsed accordion
    label still shows the axis's plain name, its letter and what it is worth, which is
    the whole reason this is not a tab group.
    """
    # The example that makes `surv` concrete: the sharpest live question on this map.
    example = ""
    live = [q for q in _s5_live_questions(report) if q.surv_mean is not None]
    if live and report.zones:
        sharp = min(live, key=lambda q: (q.surv_mean, q.id))
        remaining = max(1, int(round((sharp.surv_mean or 0.0) * len(report.zones))))
        example = (f"On this map, asking “{sharp.label}” leaves on average "
                   f"{num(remaining)} of {num(len(report.zones))} zones still standing.")

    # A representative zone supplies the per-axis maxima; they are identical across
    # zones except where a metric was unavailable, which the metric row notes.
    ref = _s5_reference_score(report)

    # The thesis of the page rides on the hero as a pull quote; the precise version,
    # naming the two metrics that fight, stays here in both axes it is about.
    tension = wa_callout(
        el("p", esc(
            "Reach and Exposure pull against each other on purpose, and that tension is the "
            "whole game. R1 rewards a zone you can actually get to inside the hiding period; "
            "X3 rewards a zone the seekers find expensive to reach. A zone that scores well on "
            "both is genuinely rare, and it is what you are shopping for below."),
           class_="wa-body-s"),
        variant="brand", appearance="plain", icon="circle-info")

    items: list[tuple[str, str, str, bool]] = []
    for axis, name, what, clause in _S5_AXES:
        maximum = _s5_pts(ref.axis_max.get(axis)) if ref else 0.0
        rows = []
        if ref:
            for m in ref.metrics:
                if not m.id.startswith(axis) or (m.id[len(axis):] and not m.id[len(axis):].isdigit()):
                    continue
                rows.append([
                    el("code", esc(m.id)) + " " + esc(m.name),
                    esc(m.unit),
                    esc(f"{_s5_pts(m.max_tenths)} pt"),
                    _s4_source_tag(m.source),
                ])
        label = join(
            el("span", join(
                el("strong", esc(_S5_AXIS_PLAIN[axis][0]), class_="wa-body-s"),
                el("code", esc(axis), class_="wa-caption-2xs"),
                el("span", esc(name), class_="wa-caption-xs wa-color-text-quiet"),
            ), class_="wa-cluster wa-gap-2xs wa-align-items-center"),
            wa_badge(f"{num(maximum, 1)} pt", variant="neutral", appearance="outlined"),
        )
        body = el("div", join(
            el("p", esc(what), class_="wa-body-s"),
            el("p", esc(example), class_="wa-body-s") if axis == "IR" and example else "",
            tension if axis in ("R", "X") else "",
            data_table(["Metric", "Unit", "Worth", "Where it comes from"], rows) if rows else "",
            el("p", esc("Rulebook: ") + el("em", esc(clause)),
               class_="wa-caption-s wa-color-text-quiet"),
        ), class_="wa-stack wa-gap-s")
        items.append((f"axis-{axis}", label, body, False))

    back = el("p", el("a", join(wa_icon("table"), esc("Back to the table")), href="#all",
                      class_="wa-link wa-cluster wa-gap-2xs"), class_="wa-caption-s")
    answer = el("p", esc(
        f"Every one of the {num(len(report.zones))} zones sat the same six-axis exam, and every "
        f"point it earned is listed in its own dossier."), class_="wa-body-s")
    return section(
        "axes", _S4_ORDINAL, "How zones are scored",
        el("div", join(wa_accordion(items, mode="multiple", heading_level="3"), back),
           class_="wa-stack wa-gap-m"),
        kicker="Six axes, one hundred points", answer_html=answer,
        lede=("Every zone is scored the same way, from the feed and from OpenStreetMap. "
              "Nothing here is a matter of taste: each axis is a list of named metrics with "
              "published thresholds, and every zone's dossier shows which of them it earned. "
              "Open an axis for its metrics and the rulebook clause behind it."))


# ── §01 the map, the simulator, the list, the dossier ─────────────────────────

def strategy_zone_map(report: Report) -> str:
    """§01 map card — MapLibre plus the question-mode simulator chips and legend.

    Order is controls → map → readout → legend → method, and none of the first four
    may ever be collapsed: `#zmap` is a MapLibre container, which reads its size once
    at construction, and the chips are how the simulator is driven.
    """
    if not report.zones:
        return ""
    size = report.size
    radius_label = _s4_dist(report, size.zone_radius_m, 2)

    modes: list[tuple[str, str]] = [("explore", "Explore")]
    reasons: dict[str, str] = {}
    for mode, label in _S5_MODE_LABEL:
        if mode == "explore":
            continue
        category = _S5_MODE_CATEGORY[mode]
        live = [q for q in report.questions
                if q.category == category and q.status in ("functional", "weak")]
        modes.append((mode, label))
        if not live:
            dead = [q for q in report.questions if q.category == category]
            if not dead:
                # NOT a map problem, and saying "no question functions on this map"
                # blamed the geography for a rule. The audit only ever contains the
                # questions this game size's deck holds, so an empty family means the
                # RULEBOOK left the category out — which today is exactly one case:
                # "Tentacle question cannot be used in SMALL games".
                reasons[mode] = (
                    "The rulebook says the tentacle question cannot be used in SMALL games, "
                    "so a SMALL deck contains none. Nothing about this map is at fault."
                    if category == "tentacle" else
                    f"A {size.name.upper()} game's deck contains no {label.lower()} question.")
            else:
                reasons[mode] = dead[0].why

    # Built from `el` rather than `wa_button` because a dead mode carries *two* icons:
    # its own, and a `ban` that says the button is off without relying on the disabled
    # tint alone. The `data-mode`, `disabled` and explanatory `title` are unchanged —
    # showing a dead category disabled-with-reason is the point, not an oversight.
    chips = "".join(
        el("wa-button", join(wa_icon(_S5_MODE_ICON[mode], slot="start"), esc(label),
                             wa_icon("ban", slot="end") if mode in reasons else ""),
           data_mode=mode, size="s", variant="neutral",
           appearance="outlined" if mode != "explore" else "accent",
           disabled=True if mode in reasons else None,
           title=reasons.get(mode) or None)
        for mode, label in modes)

    caption = " ".join(x for x in (
        "Live OpenFreeMap basemap.",
        f"Each dot is one of the {num(len(report.zones))} candidate hiding zones, coloured by score "
        f"until you pick a question mode — then by the answer that zone would have to give.",
        f"The selected zone's true {radius_label} rulebook circle is drawn around its designated "
        f"station.",
        "Amber “edge” means the circle straddles the answer boundary, so the honest answer depends "
        "on where inside your zone you are actually standing.",
        "★ marks the round-start station. Dashed gold = the game border.",
        "If your browser blocks the map library, the map is omitted and everything below still works.",
    ) if x)

    legend = el("div", "".join(
        el("span", join(swatch, el("span", esc(text), class_="wa-caption-s")),
           class_="wa-cluster wa-gap-2xs", role="listitem")
        for swatch, text in (
            (_s4_swatch("background:var(--q-yes);border-radius:50%"), "Yes / hotter / in reach"),
            (_s4_swatch("background:var(--q-no);border-radius:50%"), "No / colder / out of reach"),
            (_s4_swatch("background:var(--q-edge);border-radius:50%"), "Edge — the circle straddles it"),
            (_s4_swatch("background:var(--q-un);border-radius:50%"), "Awaiting input"),
            (el("span", esc("★"), style="color:var(--gold-deep);font-weight:800"), report.hub.name),
            (_s4_swatch("background:transparent;border:1.5px dashed var(--gold-deep)"), "Game border"),
        )), class_="wa-cluster wa-gap-m", role="list")

    # The six-sentence map caption and the simulator explainer are the same subject —
    # how the thing works — so they become one disclosure, both texts verbatim. Method
    # is the only tier on this card that collapses.
    how = wa_details("How the simulator works", el("div", join(
        el("p", esc(caption), class_="wa-body-s"),
        el("p", esc(
            "This simulator is the client-side twin of the survival model that produced the "
            "scores: the same arithmetic, run against one seeker you place yourself instead of "
            "the sample the scorer averages over. Dead question categories are shown disabled "
            "with the reason rather than hidden — knowing which questions cannot hurt you here "
            "is worth as much as knowing which can."), class_="wa-body-s"),
    ), class_="wa-stack wa-gap-s"))

    return wa_card(el("div", join(
        el("div", chips, class_="wa-cluster wa-gap-2xs", id="smodes"),
        el("div", "", id="sopts", class_="wa-cluster wa-gap-2xs"),
        el("div", "", id="zmap"),
        el("p", "", id="sreadout", class_="wa-body-s"),
        legend,
        how,
    ), class_="wa-stack wa-gap-s"))


def strategy_zone_list(report: Report) -> str:
    """§01 list + dossier — the ranked rail and the container the script fills.

    The rail is a `role="listbox"` of `role="option"` rows built by `renderList()`. It
    is a shortlist rather than the field, and the link under it now says so.
    """
    if not report.zones:
        return ""
    list_head = el("div", join(
        subhead("Ranked candidates", anchor_id="dossier"),
        el("span", "", id="zcount", class_="wa-caption-s wa-color-text-quiet"),
    ), class_="wa-split wa-align-items-center")

    rail = el("div", "", id="zlist", class_="wa-stack wa-gap-2xs",
              role="listbox", aria_label="Ranked hiding zones")
    more = el("p", el("a", join(esc(f"See all {num(len(report.zones))} in the table"),
                                wa_icon("table")),
                      href="#all", class_="wa-link wa-cluster wa-gap-2xs"),
              class_="wa-caption-s")
    dossier = el("div", strategy_dossier_template(report), id="zdetail")

    return el("div", join(
        el("div", join(list_head, rail, more), class_="wa-stack wa-gap-s"),
        dossier,
    ), class_="wa-grid wa-gap-l", style="--min-column-size:22rem")


def strategy_shortlist(report: Report) -> str:
    """§01 — the map, the simulator, the ranked rail and the dossier, in one section.

    The rail and the dossier were previously emitted *after* `</section>`, so the best
    content on the page belonged to no section and had no rail entry. Both are inside
    now, and `#dossier` is a destination of its own.
    """
    body = join(strategy_zone_map(report), strategy_zone_list(report))
    if not body:
        return ""
    answer = el("p", esc(
        f"{num(len(report.zones))} zones were scored and the "
        f"{num(len(report.dossier_zone_ids))} best are written up in full. Pick a question mode "
        f"to see what each one would do to the field."), class_="wa-body-s")
    return section("zones", _S4_ORDINAL, "The shortlist", body,
                   kicker="The map, and what each question would do to it",
                   answer_html=answer,
                   lede=("Pick a question mode, drop a seeker, and watch the map partition. "
                         "What you are looking for is a zone that stays the same colour as a "
                         "large crowd of others."))


def strategy_dossier_template(report: Report) -> str:
    """§01 dossier — the shell the script fills for the selected zone.

    The evidence table is metric rows, not prose: nothing on this card can drift
    from the score, because it *is* the score.
    """
    placeholder = el("p", esc("Select a zone on the map or in the list."), class_="wa-body-s")
    return wa_card(el("div", placeholder, id="zbody"),
                   header_html=el("div", join(
                       el("span", esc("Zone dossier"), class_="wa-heading-s", id="ztitle"),
                       el("span", "", id="zscore", class_="wa-caption-s"),
                   ), class_="wa-split wa-align-items-center"))


# ── §02 the full ranked table ─────────────────────────────────────────────────

def strategy_all_candidates(report: Report) -> str:
    """§02 — every scored zone, sortable and filterable, plus the axis winners.

    The complete table is the anti-cutoff guarantee: a player who disagrees with the
    weights can re-sort by the axis they care about and get their own shortlist. The
    column headers lead with plain English and keep the axis letter as a caption, so
    `IR R S E A X` is legible without scrolling to §04 to look it up.
    """
    if not report.zones:
        return ""
    scores = report.zone_scores
    zones = _s5_zone_by_id(report)
    # every scored zone, ranked ones first, then the ones held out of the ranking
    every = list(report.ranked_zone_ids) + sorted(
        zid for zid in scores if zid not in set(report.ranked_zone_ids))

    winners = []
    for axis, name, _what, _clause in _S5_AXES:
        best_id, best_val = None, -1
        for zid in every:
            s = scores.get(zid)
            if s is None or s.excluded:
                continue
            v = s.axes.get(axis, 0)
            if v > best_val:
                best_id, best_val = zid, v
        if best_id is None:
            continue
        zone = zones.get(best_id)
        winners.append(wa_card(join(
            el("p", join(el("code", esc(axis)), esc(" · " + _S5_AXIS_PLAIN[axis][0])),
               class_="wa-caption-xs wa-text-uppercase"),
            el("p", esc(zone.name if zone else best_id), class_="wa-heading-s"),
            el("p", esc(f"{num(_s5_pts(best_val), 1)} of {num(_s5_pts(scores[best_id].axis_max.get(axis)), 1)} pt"
                        f" · {name}"),
               class_="wa-caption-s wa-color-text-quiet"),
        ), class_="wa-brand"))

    excluded = [(zid, scores[zid]) for zid in every if scores[zid].excluded]
    excluded_block = ""
    if excluded:
        rows = [[esc(zones[zid].name if zid in zones else zid),
                 esc(s.exclude_reason or "excluded"),
                 esc(f"{num(_s5_travel_minutes(report, s) or 0, 0)} min"
                     if _s5_travel_minutes(report, s) is not None else "—")]
                for zid, s in excluded]
        excluded_block = wa_details(
            f"{num(len(excluded))} zones excluded from the ranking",
            join(el("p", esc(
                "These are still scored and still in the table above — they are held out of the "
                "ranking because you cannot reach them inside the hiding period, or because the "
                "designated station has no service on the selected day. Nothing is dropped "
                "silently."), class_="wa-body-s"),
                data_table(["Zone", "Why", "Travel time"], rows)))

    # The axis legend: the same `_S5_AXES` data §04 prints, directly above the table.
    # Six two-letter column headers are unreadable without it, and sending the reader
    # four sections away to decode them is not an answer.
    ref = _s5_reference_score(report)
    legend = el("div", "".join(
        el("span", join(
            el("code", esc(axis)),
            el("span", esc(_S5_AXIS_PLAIN[axis][0]), class_="wa-caption-s"),
            el("span", esc(f"{num(_s5_pts(ref.axis_max.get(axis)) if ref else 0, 0)} pt"),
               class_="wa-caption-xs wa-color-text-quiet"),
        ), class_="wa-cluster wa-gap-3xs wa-align-items-center", role="listitem")
        for axis, *_rest in _S5_AXES), class_="wa-cluster wa-gap-m", role="list")

    # The legend stays out of the sticky strip on purpose: six labelled rows pinned
    # under a 7rem header would take a third of a phone viewport. The strip keeps
    # what has to follow the reader down 319 rows — the filter and the count.
    controls = el("div", join(
        search_input("zfilter", placeholder="Filter by name, route or flag",
                     label="Filter zones"),
        el("span", "", id="ztableinfo", class_="wa-caption-s wa-color-text-quiet"),
    ), class_="wa-split wa-align-items-center wa-flex-wrap wa-gap-s", id="zcontrols")

    # `data-sort` indices are the JS's column contract and are untouched; only the
    # label markup changes. The axis columns get an id so a `wa-tooltip` can anchor to
    # them, and the letter survives as the caption under the plain word.
    headers: list[tuple[str, str, str]] = [
        ("Rank", "", ""), ("Zone", "", ""), ("Score", "", ""),
    ] + [(_S5_AXIS_PLAIN[a][1], a, name) for a, name, *_rest in _S5_AXES] + [
        ("Flags", "", ""), ("Travel", "", ""),
    ]
    cells, tips = [], []
    for i, (word, axis, name) in enumerate(headers):
        label = join(el("span", esc(word)),
                     el("code", esc(axis), class_="wa-caption-2xs") if axis else "")
        th_id = f"th-{axis}" if axis else None
        cells.append(el("th", el("button", label, class_="wa-plain", data_sort=str(i)),
                        id=th_id))
        if axis:
            tips.append(wa_tooltip(
                f"th-{axis}",
                f"{name} — {_S5_AXIS_PLAIN[axis][0].lower()}. "
                f"0–{num(_s5_pts(ref.axis_max.get(axis)) if ref else 0, 0)} points."))
    head = el("thead", el("tr", "".join(cells)))
    table = join(wa_scroller(el("table", head + el("tbody", "", id="ztbody"), id="ztable")),
                 "".join(tips))
    pager = el("div", "", id="zpager", class_="wa-cluster wa-gap-2xs")

    winners_block = el("div", join(
        subhead("Best on each axis"),
        el("div", "".join(winners), class_="wa-grid wa-gap-m", style="--min-column-size:230px"),
    ), class_="wa-stack wa-gap-xs") if winners else ""

    answer = el("p", esc(
        f"Every one of the {num(len(report.zones))} scored zones is in this table"
        + (f", including the {num(len(excluded))} held out of the ranking" if excluded else "")
        + ". Sort by the column you care about."), class_="wa-body-s")
    return section("all", _S4_ORDINAL, "The whole field",
                   el("div", join(winners_block, legend, controls, table, pager, excluded_block),
                      class_="wa-stack wa-gap-l"),
                   kicker=(f"All {num(len(report.zones))} scored zones"
                           + (f" · {num(len(excluded))} outside the ranking" if excluded else "")),
                   answer_html=answer,
                   lede=("The ranking above is one set of weights. Sort this table by whichever "
                         "axis matters to you and it will give you a different shortlist — which "
                         "is the point."))


# ── §03 tactics ───────────────────────────────────────────────────────────────

def strategy_tactics(report: Report) -> str:
    """§03 — rulebook tips parameterised from this feed, dropped when they don't apply.

    The clause each tip comes from moves out of the body and into the card's footer,
    so the advice reads as advice and the citation reads as a citation.
    """
    size = report.size
    metrics = {m.id: m for s in report.fitness.subscores for m in s.metrics}
    v = report.metrics
    tips: list[tuple[str, str, str]] = []   # (title, body, rulebook clause)

    tips.append((
        f"Spend the whole {num(size.hiding_period_min)} minutes",
        "Your hiding window is the only free movement you get. Wherever you are standing when "
        "the timer ends is your zone, so plan the ride, not just the destination — and check "
        "the travel time in the dossier before you commit to a zone.",
        "Hiding Zones — “if the hiding period ends and you're somewhere else, then that's where "
        "your hiding zone is.”"))

    tips.append((
        "Scope your endgame spot early, then wander",
        f"Inside your {_s4_dist(report, size.zone_radius_m, 2)} circle you can shop, eat and "
        f"sightsee — but the moment a seeker walks in off transit you freeze where you stand. "
        f"Know exactly where you will be standing, and pre-take the photos you can, so a photo "
        f"timer never forces you to sprint.",
        "Hiding Spots — the spot is final the moment the end game starts."))

    parks = report.geo.counts.get("park")
    if parks:
        tips.append((
            "Parks are the best-in-class final spot",
            f"Publicly accessible at all hours, no risk of being asked to leave, and their path "
            f"networks satisfy the ten-feet-of-a-mapped-path rule. This map has {num(parks)} of "
            f"them. A large park is doubly useful: “nearest park” measures to the map icon, so "
            f"you can be standing in one park and truthfully name a different one.",
            "Hiding Spots — publicly accessible during all game hours; Matching — measure to the "
            "map icon."))

    tips.append((
        "Businesses are a mid-round tool, not a hiding spot",
        "The rulebook warns against stores and businesses as final spots — loitering draws "
        "attention and opening hours rarely cover all game hours. Use them for a bathroom, food "
        "and warmth during the middle of the round, then be somewhere public when the endgame "
        "starts.",
        "Hiding Spots — “we'd suggest avoiding stores or other businesses.”"))

    if size.name != "small":
        tentacles = [q for q in report.questions
                     if q.category.lower().startswith("tentacle") and q.status in ("functional", "weak")]
        if tentacles:
            named = ", ".join(sorted({q.label for q in tentacles})[:4])
            reaches = sorted({_S5_TENTACLE_ID_REACH_MI[q.id] for q in tentacles
                              if q.id in _S5_TENTACLE_ID_REACH_MI})
            reach_words = _s5_reach_words(reaches)
            tips.append((
                "Respect the tentacle categories",
                f"The live tentacle categories here are {named}. Each question carries its own "
                f"reach — {reach_words} on this map — and it is measured from the seekers, not "
                f"from you, so a target well outside your zone can still be the name you have to "
                f"give. You must also be inside that reach yourself: if you are not, you may "
                f"simply answer that you are not within reach. A zone where the category is "
                f"absent or ambiguous blunts the whole family — and a null answer still pays you "
                f"a card draw.",
                f"Tentacle Questions — {reach_words} of reach in a {size.name.upper()} game."))

    tips.append((
        "Radar targets you, not your zone",
        f"If the ring clips your circle but not your body, the honest answer is no. Stand on the "
        f"far side of your {_s4_dist(report, size.zone_radius_m, 2)} disc from the seekers' likely "
        f"approach — the simulator above shows exactly which zones turn amber, and amber is the "
        f"band where standing in the right half of your own circle changes the answer.",
        "Radar Questions — the answer is about your location, not your zone."))

    tips.append((
        "Build the deck to end the round holding time",
        "Time bonuses only count if they are in your hand when you are caught. Aim for roughly "
        "half bonuses, a quarter powerups, a quarter curses — and remember that Move costs your "
        "entire hand, reveals your original station, and cannot be played in the end game.",
        "The Hider Deck — six-card hand limit; Powerups — Move."))

    evening = metrics.get("D2")
    if evening is not None and evening.raw is not None and float(evening.raw) < 0.85:
        worst_key, worst_score = None, None
        for key, sc in sorted((report.fitness.per_day or {}).items()):
            if worst_score is None or sc < worst_score:
                worst_key, worst_score = key, sc
        worst = _s4_day_label(report, worst_key) if worst_key else "the quietest day"
        tips.append((
            "Watch the service clock",
            f"Only {pct(float(evening.raw))} of zones still have service at the end of the "
            f"round's playing hours. Late in the day an hourly zone has no Move escape — and the "
            f"seekers know it. {worst} is the worst day on this map; check the day banner before "
            f"you even shortlist a zone.",
            "Powerups — Move requires a departure to exist."))

    if v.get("hub_route_share") is not None and float(v["hub_route_share"]) >= 0.5:
        tips.append((
            "Assume the seekers pass through the hub",
            f"{report.hub.name} carries {pct(float(v['hub_route_share']))} of this network's "
            f"routes, so almost every seeker journey crosses it. Zones whose only path from the "
            f"seekers runs back through the hub buy you the transfer penalty twice.",
            "Seeking — seekers move on the same transit you do."))

    items = "".join(
        el("li", wa_card(
            el("div", join(
                el("p", esc(title), class_="wa-heading-s"),
                el("p", esc(body), class_="wa-body-s"),
            ), class_="wa-stack wa-gap-2xs"),
            footer_html=el("p", join(wa_icon("book"), esc(clause)),
                           class_="wa-caption-s wa-color-text-quiet wa-cluster wa-gap-2xs")))
        for title, body, clause in tips)

    answer = el("p", esc(
        f"{num(len(tips))} things to do differently on this map, in the order they matter."),
        class_="wa-body-s")
    return section("tactics", _S4_ORDINAL, "How to play this map",
                   el("ol", items, class_="recs wa-stack wa-gap-s"),
                   kicker="The playbook for this map", answer_html=answer,
                   lede=("Everything below follows from the official rules applied to this "
                         "particular network — each tip names the clause it comes from, and tips "
                         "whose precondition does not hold here have been left out."))


# ── §05 provenance ────────────────────────────────────────────────────────────

def strategy_provenance(report: Report) -> str:
    """§05 — the scoring parameters actually used.

    The feasibility report is named in prose but deliberately not linked: this page is
    the hider's, and it must not carry a path to a document meant for the whole group
    (nor advertise one back to itself). See `page_chrome`.
    """
    p = report.provenance
    size = report.size
    rows = [
        ["Zones scored", esc(num(len(report.zones)))],
        ["Zone radius", esc(_s4_dist(report, size.zone_radius_m, 2))],
        ["Game size", esc(size.name.upper() + (" (inferred)" if size.inferred else " (given)"))],
        ["Hiding period", esc(mins(size.hiding_period_min))],
        ["Round start", esc(report.hub.name)],
        ["Departure", esc(report.opts.departure)],
        ["Day shown", esc(_s4_day_label(report, _s4_best_day(report)))],
        ["Live questions", esc(f"{num(len(_s5_live_questions(report)))} of {num(len(report.questions))}")],
        ["Feed", esc(f"{report.feed.agency_name} — {p.get('feed_version', 'n/a')}")],
    ]
    if p.get("as_of"):
        rows.append(["Analysis date", esc(pretty_date(str(p["as_of"])))])

    body = el("div", join(
        data_table(["Parameter", "Value"], rows),
        el("p", esc(
            "Zone scores come from the feed and from OpenStreetMap via Overpass; the full "
            "method, the exact selectors and the complete score trace are on the feasibility "
            "report. Scheduled times are planning estimates — verify against live tracking on "
            "game day."), class_="wa-body-s"),
    ), class_="wa-stack wa-gap-m")
    answer = el("p", esc(
        f"Everything on this page was produced from {report.feed.agency_name}'s published "
        f"timetable and from OpenStreetMap, for a {size.name.upper()} game starting at "
        f"{report.hub.name}."), class_="wa-body-s")
    return section("sources", _S4_ORDINAL, "Method & parameters", body,
                   kicker="What produced these rankings", answer_html=answer)


# ── the page script ───────────────────────────────────────────────────────────

_S5_STRATEGY_JS = r"""
const G = D('sgame'), Z = D('zdata'), P = D('poi');
const ZONES = Z.zones, BY_ID = Object.fromEntries(ZONES.map(z => [z.id, z]));
const AXES = ['IR', 'R', 'S', 'E', 'A', 'X'];
const AXIS_NAME = {IR: 'Information resistance', R: 'Reach', S: 'Service',
                   E: 'Endgame spots', A: 'Amenities', X: 'Exposure'};
/* the plain name the UI leads with; the rulebook's own name above stays in the
   sparkbar tooltips, so neither vocabulary is lost */
const AXIS_PLAIN = __AXIS_PLAIN__;
const FLAGS = __FLAGS__;
const MI = 1609.344;
const imperial = G.scale_unit === 'imperial';
const dist = m => imperial ? (m / MI).toFixed(2) + ' mi' : (m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m');

let day = loadDay(G.default_day);
if (!G.days.some(d => d.key === day)) day = G.default_day;   /* a stale key from the other page */
let selected = Z.dossiers[0] || (ZONES[0] && ZONES[0].id) || null;
let mode = 'explore';
let seeker = null, thermoA = null, thermoB = null;
const _usableRadar = (G.chips.radar || []).filter(r => r.usable);
/* category key → that tentacle question's OWN reach in miles. A LARGE deck holds
   1-mile and 15-mile tentacles at once, so `G.tentacle_reach_mi` cannot answer this. */
const CAT_REACH_MI = {};
for (const c of (G.chips.tentacle || [])) CAT_REACH_MI[c.key] = c.reach_mi || 0;
/* tentacle answers are not yes/no: `no` is the rulebook's "not within reach" and `un`
   is "the seekers named a category with nothing inside their own circle". */
const TENTACLE_WORD = {no: 'not within reach', un: 'nothing in reach to name'};
let opt = {radar: (_usableRadar.find(r => r.miles === 1) || _usableRadar[0] || {miles: 1}).miles, cat: null};

/* ── geometry: the same arithmetic the scorer used, one seeker at a time ── */
const R_EARTH = 6371008.8;
function hav(a, b, c, d) {
  const p = Math.PI / 180, dla = (c - a) * p, dlo = (d - b) * p;
  const s = Math.sin(dla / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin(dlo / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}
const RAD = G.zone_radius_m;

/* A zone's answer is `edge` when the boundary passes through its own circle: the
   honest answer then depends on where inside the zone the hider is standing. */
function band(delta) { return Math.abs(delta) <= RAD ? 'edge' : (delta < 0 ? 'yes' : 'no'); }

function nearestIn(cat, lat, lon) {
  const c = P.categories[cat];
  if (!c || !c.features.length) return null;
  let best = null, bd = Infinity, second = Infinity;
  for (const f of c.features) {
    const d = hav(lat, lon, f[1], f[0]);
    if (d < bd) { second = bd; bd = d; best = f; } else if (d < second) { second = d; }
  }
  return {feature: best, d: bd, margin: second - bd};
}

function answerFor(z) {
  if (mode === 'explore') return z.band;
  if (mode === 'radar') {
    if (!seeker) return 'un';
    const r = opt.radar * MI;
    return band(hav(seeker.lat, seeker.lon, z.lat, z.lon) - r);
  }
  if (mode === 'thermo') {
    if (!thermoA || !thermoB) return 'un';
    const da = hav(thermoA.lat, thermoA.lon, z.lat, z.lon);
    const db = hav(thermoB.lat, thermoB.lon, z.lat, z.lon);
    return band(db - da);          /* hotter = closer to B than to A */
  }
  if (!opt.cat || !P.categories[opt.cat]) return 'un';
  if (mode === 'match') {
    if (!seeker) return 'un';
    const mine = nearestIn(opt.cat, seeker.lat, seeker.lon);
    const theirs = nearestIn(opt.cat, z.lat, z.lon);
    if (!mine || !theirs) return 'un';
    const same = mine.feature[0] === theirs.feature[0] && mine.feature[1] === theirs.feature[1];
    /* if a different feature could win from elsewhere in the circle, it is an edge */
    if (theirs.margin <= 2 * RAD) return 'edge';
    return same ? 'yes' : 'no';
  }
  if (mode === 'measure') {
    /* "Compared to me, are you closer to or further from ____?" — the blank is a
       CATEGORY, and each side answers about the feature nearest THEM. The rulebook
       spells it out: "If you are in a large park, a mile from the park icon, you might
       have to say you are a mile away from any park despite the fact that you are in a
       park." So this is two nearest-feature lookups, not one shared target. */
    if (!seeker || !opt.cat) return 'un';
    const mine = nearestIn(opt.cat, seeker.lat, seeker.lon);
    const theirs = nearestIn(opt.cat, z.lat, z.lon);
    if (!mine || !theirs) return 'un';
    return band(theirs.d - mine.d);
  }
  if (mode === 'tentacle') {
    /* The FEATURE reach anchors on the seekers — "Within ___ miles of me, which ___ are
       you nearest to?" — so a target well outside the hider's zone can still be the name
       they have to give. But the question ends "(You must also be within ___ miles)",
       and the rulebook spells the consequence out: "If the hider is not within reach of
       the tentacle question, they may simply answer that they are not within reach."
       That answer is `no`, its own class, distinct from both in-reach groups. The reach
       ring gets the same edge treatment as every other boundary on this page. */
    if (!seeker) return 'un';
    const reach = (CAT_REACH_MI[opt.cat] || 0) * MI;
    if (!reach) return 'un';
    const c = P.categories[opt.cat];
    if (!c) return 'un';
    const reachBand = band(hav(seeker.lat, seeker.lon, z.lat, z.lon) - reach);
    if (reachBand === 'no') return 'no';          /* "not within reach" */
    const inReach = c.features.filter(f => hav(seeker.lat, seeker.lon, f[1], f[0]) <= reach);
    /* in reach of the seekers, but the seekers named a category with nothing inside
       their own circle — there is no name to give */
    if (!inReach.length) return 'un';
    let best = null, bd = Infinity, second = Infinity;
    for (const f of inReach) {
      const d = hav(z.lat, z.lon, f[1], f[0]);
      if (d < bd) { second = bd; bd = d; best = f; } else if (d < second) second = d;
    }
    z._tent = best ? best[2] : null;
    /* the answer's identity is the FEATURE, not its name: two branches sharing a name
       are two answers, and an unnamed feature is not the same answer as every other */
    z._tentKey = best ? best[0] + ',' + best[1] : '';
    if (reachBand === 'edge') return 'edge';
    return (second - bd) <= 2 * RAD ? 'edge' : 'yes';
  }
  return 'un';
}

/* ── the map ── */
let map = null, markers = [], seekerMarker = null, maplibregl = null;
async function drawMap() {
  try { maplibregl = (await import('__MAPLIBRE_JS__')).default; }
  catch (e) { console.warn('MapLibre unavailable — map omitted', e); }
  if (!maplibregl || !maplibregl.Map) { $('zmap').style.display = 'none'; paint(); return; }
  const dark = document.documentElement.classList.contains('wa-dark');
  const lats = ZONES.map(z => z.lat), lons = ZONES.map(z => z.lon);
  $('zmap').style.height = '470px';
  $('zmap').classList.toggle('dark-map', dark);
  map = new maplibregl.Map({
    container: 'zmap',
    style: dark ? '__TILES_DARK__' : '__TILES_LIGHT__',
    bounds: [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    fitBoundsOptions: {padding: 46},
    cooperativeGestures: true,
    attributionControl: {compact: true},
  });
  map.addControl(new maplibregl.NavigationControl({showCompass: false}), 'top-right');
  map.addControl(new maplibregl.ScaleControl({unit: imperial ? 'imperial' : 'metric'}));
  map.on('load', () => { addBorder(); addCircle(); paint(); });
  map.on('click', e => {
    if (mode === 'radar' || mode === 'match' || mode === 'measure' || mode === 'tentacle') {
      seeker = {lat: e.lngLat.lat, lon: e.lngLat.lng}; placeSeeker(); paint();
    } else if (mode === 'thermo') {
      if (!thermoA || (thermoA && thermoB)) { thermoA = {lat: e.lngLat.lat, lon: e.lngLat.lng}; thermoB = null; }
      else { thermoB = {lat: e.lngLat.lat, lon: e.lngLat.lng}; }
      drawLeg(); paint();
    }
  });
}

function ring(lat, lon, m) {
  const dLa = m / 111320, dLo = m / (111320 * Math.cos(lat * Math.PI / 180)), pts = [];
  for (let i = 0; i <= 64; i++) { const a = i / 64 * 2 * Math.PI; pts.push([lon + dLo * Math.cos(a), lat + dLa * Math.sin(a)]); }
  return pts;
}
function addBorder() {
  const b = G.border.bbox, coords = G.border.kind === 'circle'
    ? ring(G.border.circle[0], G.border.circle[1], G.border.circle[2])
    : [[b[1], b[0]], [b[3], b[0]], [b[3], b[2]], [b[1], b[2]], [b[1], b[0]]];
  map.addSource('border', {type: 'geojson', data: {type: 'Feature', geometry: {type: 'LineString', coordinates: coords}}});
  map.addLayer({id: 'border', type: 'line', source: 'border',
    paint: {'line-color': cssVar('--gold-deep') || '#a97b00', 'line-width': 1.5, 'line-dasharray': [3, 2]}});
}
function addCircle() {
  map.addSource('zcircle', {type: 'geojson', data: {type: 'Feature', geometry: {type: 'Polygon', coordinates: [[[0, 0], [0, 0], [0, 0]]]}}});
  map.addLayer({id: 'zcircle-f', type: 'fill', source: 'zcircle',
    paint: {'fill-color': cssVar('--accent') || '#2a78d6', 'fill-opacity': 0.10}});
  map.addLayer({id: 'zcircle-l', type: 'line', source: 'zcircle',
    paint: {'line-color': cssVar('--accent') || '#2a78d6', 'line-width': 1.5}});
  map.addSource('leg', {type: 'geojson', data: {type: 'Feature', geometry: {type: 'LineString', coordinates: []}}});
  map.addLayer({id: 'leg', type: 'line', source: 'leg',
    paint: {'line-color': cssVar('--q-edge') || '#e0a000', 'line-width': 2, 'line-dasharray': [2, 1]}});
}
function updateCircle() {
  const z = BY_ID[selected];
  if (!map || !map.getSource('zcircle') || !z) return;
  map.getSource('zcircle').setData({type: 'Feature', geometry: {type: 'Polygon', coordinates: [ring(z.lat, z.lon, RAD)]}});
}
function drawLeg() {
  if (!map || !map.getSource('leg')) return;
  const c = (thermoA && thermoB) ? [[thermoA.lon, thermoA.lat], [thermoB.lon, thermoB.lat]] : [];
  map.getSource('leg').setData({type: 'Feature', geometry: {type: 'LineString', coordinates: c}});
}
function placeSeeker() {
  if (!map) return;
  if (seekerMarker) seekerMarker.remove();
  if (!seeker) return;
  const d = document.createElement('div');
  d.className = 'mk mk-seeker';
  d.innerHTML = '<span class="cross">×</span><span class="slbl">seekers</span>';
  seekerMarker = new maplibregl.Marker({element: d, draggable: true, anchor: 'center'})
    .setLngLat([seeker.lon, seeker.lat]).addTo(map);
  seekerMarker.on('dragend', () => {
    const p = seekerMarker.getLngLat(); seeker = {lat: p.lat, lon: p.lng}; paint();
  });
}

function paint() {
  const counts = {yes: 0, no: 0, edge: 0, un: 0};
  for (const z of ZONES) { z._a = answerFor(z); if (mode !== 'explore') counts[z._a] = (counts[z._a] || 0) + 1; }
  if (map) {
    markers.forEach(m => m.remove());
    markers = [];
    if (Z.map_labels) {
      for (const z of ZONES) {
        const d = document.createElement('div');
        d.className = 'mk zlabel';
        if (z.id === selected) d.setAttribute('data-sel', '');
        if (z.excluded) d.setAttribute('data-off', '');
        if (mode === 'explore') d.dataset.band = z.band; else d.dataset.answer = z._a;
        d.innerHTML = '<span class="lbl"><span class="md"></span><b>' + esc(z.overall) + '</b> ' + esc(z.name) + '</span>';
        d.addEventListener('click', ev => { ev.stopPropagation(); select(z.id); });
        bindTT(d, '<b>' + esc(z.name) + '</b><br>#' + z.rank + ' · ' + z.overall + '/' + z.max
                 + (mode !== 'explore' ? '<br>answer: ' + answerWord(z) : ''));
        markers.push(new maplibregl.Marker({element: d, anchor: 'center'}).setLngLat([z.lon, z.lat]).addTo(map));
      }
    }
    updateCircle();
  }
  readout(counts);
  renderList();
  renderTable();
}

/* One zone's answer in the words it is actually given in. Only tentacles need the
   translation, and they need it badly: `no` there is the rulebook's "not within reach",
   and a marker tip saying "no" would tell the reader the opposite of what their hider
   would say. */
function answerWord(z) {
  const a = z._a || 'un';
  return (mode === 'tentacle' && TENTACLE_WORD[a]) ? TENTACLE_WORD[a] : a;
}

/* The biggest set of zones whose answer is IDENTICAL, and the words for it. This is the
   readout's survival number, the same quantity the score is built from.

   `edge` is never a group — its zones have no decided answer to share. Tentacles are why
   this cannot be `max(yes, no)`: the in-reach zones do NOT all say the same thing, they
   each name a feature, so the `yes` colour is really one group per FEATURE. The
   out-of-reach zones, by contrast, all give one and the same answer and are frequently
   the largest group on the map. `un` is a third real group in tentacle mode — the seekers
   named a category with nothing inside their own circle, so every zone in reach gives the
   identical answer "there is nothing to name". */
function majorityGroup(counts) {
  if (mode !== 'tentacle') return {size: Math.max(counts.yes || 0, counts.no || 0), word: ''};
  let best = {size: counts.no || 0, word: TENTACLE_WORD.no};
  if ((counts.un || 0) > best.size) best = {size: counts.un, word: TENTACLE_WORD.un};
  const byFeature = new Map();
  for (const z of ZONES) {
    if (z._a !== 'yes') continue;
    const key = z._tentKey || '';
    const row = byFeature.get(key);
    if (row === undefined) byFeature.set(key, {n: 1, name: z._tent}); else row.n += 1;
  }
  for (const key of Array.from(byFeature.keys()).sort()) {
    const row = byFeature.get(key);
    if (row.n <= best.size) continue;
    best = {size: row.n, word: row.name ? 'nearest to ' + row.name : 'nearest to the same unnamed feature'};
  }
  return best;
}

function readout(counts) {
  const el2 = $('sreadout');
  if (mode === 'explore') { el2.textContent = 'Zones coloured by score band. Click one for its dossier.'; return; }
  const need = {radar: 'Click the map to place the seekers.', match: 'Click the map to place the seekers.',
                measure: 'Click the map to place the seekers.', tentacle: 'Click the map to place the seekers.',
                thermo: 'Click the map twice: the start of the leg, then the end.'}[mode];
  if ((mode === 'thermo' && !(thermoA && thermoB)) || (mode !== 'thermo' && !seeker)) { el2.textContent = need; return; }
  if ((mode === 'match' || mode === 'measure' || mode === 'tentacle') && !opt.cat) {
    el2.textContent = 'Pick a category above.'; return; }
  const total = ZONES.length;
  const yes = counts.yes || 0, edge = counts.edge || 0;
  let lead = '';
  if (mode === 'radar') lead = 'Within ' + opt.radar + ' mi: ';
  else if (mode === 'thermo') lead = 'Hotter (closer to the end of your leg): ';
  else if (mode === 'match') lead = 'Same nearest ' + (P.categories[opt.cat] || {}).label + ': ';
  else if (mode === 'measure') lead = 'Nearer their own ' + (P.categories[opt.cat] || {}).label + ' than you are to yours: ';
  else if (mode === 'tentacle') lead = 'Within reach, and so having to name a ' + (P.categories[opt.cat] || {}).label + ': ';
  const maj = majorityGroup(counts);
  el2.innerHTML = esc(lead) + '<b>' + yes + '</b> of ' + total + ' zones'
    + (edge ? ', plus <b>' + edge + '</b> on the edge where the answer depends on where in the circle they stand' : '')
    + (mode === 'tentacle' && counts.no ? '. <b>' + counts.no + '</b> are not within reach of the seekers and simply say so' : '')
    + '. Survival for a zone in the majority group' + (maj.word ? ' (' + esc(maj.word) + ')' : '')
    + ' is ' + Math.round(100 * maj.size / total) + '%.';
}

/* ── the ranked list ──
   #zlist is announced as a listbox, so it owes the reader the listbox interaction
   model: ONE tab stop (roving tabindex), Up/Down/Home/End moving the selection, and
   focus following it. Selection re-renders the rail, so the focus is restored after
   the rebuild — otherwise the first arrow press would drop focus to the body. */
function renderList() {
  const host = $('zlist');
  if (!host) return;
  const hadFocus = host.contains(document.activeElement);
  const shown = ZONES.filter(z => !z.excluded).slice(0, 40);
  host.innerHTML = shown.map(z => {
    const svc = z.service[day] || {};
    const off = !svc.served;
    const bars = AXES.map(a => '<span class="ab" style="--w:' + (z.bars[a] || 0) + '%" title="'
      + esc(AXIS_NAME[a] + ': ' + z.axes[a] + ' of ' + z.axis_max[a]) + '"></span>').join('');
    return '<div class="zrow" role="option" aria-selected="'
      + (z.id === selected ? 'true' : 'false') + '"' + (off ? ' data-off' : '')
      + ' data-id="' + esc(z.id) + '">'
      + '<span class="wa-caption-s wa-color-text-quiet">' + (z.rank == null ? '—' : z.rank) + '</span>'
      + '<span class="wa-stack wa-gap-3xs"><b class="wa-heading-xs">' + esc(z.name) + '</b>'
      + '<small class="wa-caption-xs wa-color-text-quiet">' + esc((z.routes || []).join(', ') || '—')
      + (off ? ' · no service ' + esc(dayLabel(day)) : '') + '</small></span>'
      + '<span class="abar">' + bars + '</span>'
      + '<span class="wa-heading-xs">' + z.overall + '</span></div>';
  }).join('');
  const rows = [...host.querySelectorAll('.zrow')];
  let active = rows.findIndex(r => r.getAttribute('aria-selected') === 'true');
  if (active < 0) active = 0;
  rows.forEach((r, i) => {
    r.tabIndex = i === active ? 0 : -1;
    r.addEventListener('click', () => select(r.dataset.id));
    r.addEventListener('keydown', e => {
      let n = -1;
      if (e.key === 'ArrowDown') n = Math.min(i + 1, rows.length - 1);
      else if (e.key === 'ArrowUp') n = Math.max(i - 1, 0);
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = rows.length - 1;
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(r.dataset.id); return; }
      else return;
      e.preventDefault();
      select(rows[n].dataset.id);
    });
  });
  if (hadFocus && rows[active]) rows[active].focus();
  const c = $('zcount');
  if (c) c.textContent = shown.length + ' of ' + ZONES.length + ' shown';
}
function dayLabel(k) { const d = G.days.find(x => x.key === k); return d ? d.label : k; }

/* The metric definitions are shared by every zone and shipped once; a zone whose
   list did not line up carries its own full rows instead. */
function metricsOf(z) {
  if (z.metrics) return z.metrics;
  if (!z.m) return [];
  return Z.metric_defs.map((d, i) => {
    const v = z.m[i] || [];
    return {id: d.id, name: d.name, unit: d.unit, max: d.max, source: d.source,
            raw: v[0], points: v[1], available: v[2] !== 0, note: v[3] == null ? d.note : v[3]};
  });
}

/* ── the dossier ── */
function select(id) {
  selected = id; updateCircle(); renderList(); renderDossier(); paint2();
  /* on a phone the dossier is below the rail, so a tap otherwise looks like a no-op */
  if (matchMedia('(max-width: 920px)').matches) {
    const d = $('zdetail'); if (d) d.scrollIntoView({block: 'start'});
  }
}
function paint2() { if (map && Z.map_labels) paint(); }

function renderDossier() {
  const z = BY_ID[selected];
  const body = $('zbody'), title = $('ztitle'), sc = $('zscore');
  if (!z) { body.innerHTML = '<p class="wa-body-s">Select a zone.</p>'; return; }
  title.textContent = (z.rank == null ? '' : '#' + z.rank + ' ') + z.name;
  sc.textContent = z.overall + ' / ' + z.max + (z.capped_by ? ' · held back by ' + z.capped_by : '');
  const svc = z.service[day] || {};

  /* the meter() shape, with the axis name linking to its own §04 accordion item */
  const axes = AXES.map(a => '<div class="wa-flank:end wa-gap-s wa-align-items-center" style="--flank-size:3rem">'
    + '<div class="wa-stack wa-gap-3xs">'
    + '<a class="wa-link-plain wa-caption-s wa-cluster wa-gap-2xs wa-align-items-center" href="#axis-' + a + '">'
    + esc(AXIS_PLAIN[a] || AXIS_NAME[a]) + '<code class="wa-caption-2xs">' + a + '</code></a>'
    + '<wa-progress-bar value="' + (z.bars[a] || 0) + '" label="' + esc(AXIS_NAME[a]) + '"></wa-progress-bar></div>'
    + '<span class="wa-caption-s">' + z.axes[a] + '/' + z.axis_max[a] + '</span></div>').join('');

  const threats = (z.threats || []).length
    ? '<table><thead><tr><th>Question</th><th>Your answer</th><th>Leaves</th></tr></thead><tbody>'
      + z.threats.map(t => '<tr><td>' + esc(t.label) + '</td><td>' + esc(t.answer) + '</td><td>'
        + t.remaining + ' zones (' + Math.round(t.surv * 100) + '%)</td></tr>').join('')
      + '</tbody></table>'
    : '<p class="wa-body-s">No question on this map singles this zone out — which is the best thing a dossier can say.</p>';

  const shipped = z.spots || [];
  const nspots = z.spots_total == null ? shipped.length : z.spots_total;
  const spots = shipped.length
    ? '<ul class="wa-stack wa-gap-3xs">' + shipped.map(s =>
        '<li class="wa-body-s">' + esc(s.name) + ' <span class="wa-caption-s">— ' + esc(s.type)
        + ', ' + dist(s.dist_m) + (s.enclosed ? ', enclosed' : '')
        + (s.verify ? ', <b>verify hours</b>' : '') + '</span></li>').join('') + '</ul>'
      + (nspots > shipped.length ? '<p class="wa-caption-s wa-color-text-quiet">' + nspots
         + ' candidate' + (nspots === 1 ? '' : 's') + ' found; the ' + shipped.length
         + ' strongest ' + (shipped.length === 1 ? 'is' : 'are') + ' listed.</p>' : '')
    : '<p class="wa-body-s">No candidate legal endgame spot was found inside this circle. That is a real risk: the rulebook needs somewhere publicly accessible during every game hour.</p>';

  const inv = Object.entries(z.inventory || {});
  const amenities = inv.length
    ? inv.map(([k, v]) => '<wa-tag size="s" appearance="outlined">' + esc(k) + ' ' + v + '</wa-tag>').join('')
    : '<span class="wa-caption-s">Nothing catalogued inside the circle.</span>';

  const service = svc.served
    ? '<p class="wa-body-s">' + esc(dayLabel(day)) + ': ' + esc(svc.routes.join(', ')) + ' · first '
      + esc(svc.first) + ', last ' + esc(svc.last) + ' · ' + svc.departures + ' departures'
      + (svc.headway_min != null ? ' · typically every ' + svc.headway_min + ' min' : '')
      + (svc.worst_gap_min != null ? ' · worst gap ' + svc.worst_gap_min + ' min' : '') + '</p>'
      + '<wa-sparkline values="' + svc.hist.join(',') + '"></wa-sparkline>'
    : '<wa-callout variant="danger" appearance="filled-outlined"><p class="wa-body-s">No service at this station on ' + esc(dayLabel(day)) + '. You cannot reach this zone, and you cannot leave it.</p></wa-callout>';

  /* icon **and** word: a flag's colour is never the only channel */
  const flags = (z.flags || []).map(f => {
    const meta = FLAGS[f] || [f, 'neutral', 'circle-info'];
    return '<wa-tag size="s" pill variant="' + meta[1] + '" appearance="outlined">'
      + '<wa-icon name="' + esc(meta[2] || 'circle-info') + '"></wa-icon>' + esc(meta[0]) + '</wa-tag>';
  }).join('');

  const evidence = '<table><thead><tr><th>Metric</th><th>Value</th><th>Earned</th><th>Basis</th></tr></thead><tbody>'
    + metricsOf(z).map(m => '<tr><td><code>' + esc(m.id) + '</code> ' + esc(m.name) + '</td><td>'
      + (m.raw == null ? '—' : esc(m.raw + ' ' + m.unit)) + '</td><td>' + m.points + ' / ' + m.max
      + '</td><td>' + esc(m.source) + (m.note ? ' — ' + esc(m.note) : '') + '</td></tr>').join('')
    + '</tbody></table>';

  const travel = z.travel_min == null ? 'not reachable in the hiding period'
    : z.travel_min + ' min from ' + esc(G.hub.name) + ' — ' + Math.round(100 * z.travel_min / G.hiding_period_min) + '% of the hiding period';

  /* Block order: the scouting report leads, the score breakdown supports it, and the
     metric rows behind every number stay one click down. */
  body.innerHTML =
      '<p class="wa-body-s"><b>The stop this zone is measured from:</b> ' + esc(z.name) + ' · ' + (z.stop_ids || []).length
    + ' stop' + ((z.stop_ids || []).length === 1 ? '' : 's') + ' inside the circle · ' + esc(travel) + '</p>'
    + (flags ? '<div class="wa-cluster wa-gap-2xs">' + flags + '</div>' : '')
    + SUB('What finds you') + threats
    + SUB('Score') + axes
    + SUB('Endgame spots') + spots
    + SUB('Service') + service
    + SUB('Amenities') + '<div class="wa-cluster wa-gap-2xs">' + amenities + '</div>'
    + '<wa-details id="ev-' + esc(z.id) + '" summary="Full evidence — every metric this zone earned">'
    + evidence + '</wa-details>';
}

/* ── the full table ── */
let sortCol = 2, sortDir = -1, page = 0, filter = '';
function tableRows() {
  const f = filter.trim().toLowerCase();
  let rows = ZONES;
  if (f) rows = rows.filter(z => (z.name + ' ' + (z.routes || []).join(' ') + ' ' + (z.flags || []).join(' ')).toLowerCase().includes(f));
  const key = z => {
    if (sortCol === 0) return z.rank == null ? Infinity : z.rank;
    if (sortCol === 1) return z.name.toLowerCase();
    if (sortCol === 2) return z.overall;
    if (sortCol >= 3 && sortCol <= 8) return z.axes[AXES[sortCol - 3]];
    if (sortCol === 9) return (z.flags || []).length;
    return z.travel_min == null ? Infinity : z.travel_min;
  };
  return rows.slice().sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka < kb) return sortDir; if (ka > kb) return -sortDir;
    return (a.rank == null ? Infinity : a.rank) - (b.rank == null ? Infinity : b.rank);
  });
}
function renderTable() {
  const body = $('ztbody');
  if (!body) return;
  const rows = tableRows();
  const paged = Z.paged;
  const start = paged ? page * Z.page_size : 0;
  const slice = paged ? rows.slice(start, start + Z.page_size) : rows;
  /* the Score cell carries its own magnitude, so 300 rows scan as a leaderboard
     rather than a spreadsheet; `--w` drives an id-scoped gradient, no class */
  body.innerHTML = slice.map(z => '<tr tabindex="0" data-id="' + esc(z.id) + '"' + (z.id === selected ? ' data-sel' : '') + '>'
    + '<td>' + (z.rank == null ? '—' : z.rank) + '</td><td>' + esc(z.name) + '</td>'
    + '<td data-bar style="--w:' + (z.max ? Math.round(100 * z.overall / z.max) : 0) + '%">' + z.overall + '</td>'
    + AXES.map(a => '<td>' + z.axes[a] + '</td>').join('')
    + '<td>' + (z.flags || []).map(f => (FLAGS[f] || [f])[0]).join(', ') + '</td>'
    + '<td>' + (z.travel_min == null ? '—' : z.travel_min + ' min') + '</td></tr>').join('');
  /* a row opens a dossier, so it is a control: Enter/Space reaches it too, the same
     way the ranked rail's rows do. Mouse-only selection was the pre-existing gap. */
  body.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => select(tr.dataset.id));
    tr.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(tr.dataset.id); }
    });
  });
  /* the sort state was invisible: eleven identical headers and no indicator */
  document.querySelectorAll('#ztable thead th').forEach((th, i) => {
    th.setAttribute('aria-sort', i === sortCol ? (sortDir > 0 ? 'ascending' : 'descending') : 'none');
  });
  const info = $('ztableinfo');
  if (info) info.textContent = paged
    ? 'Showing ' + (start + 1) + '–' + Math.min(start + Z.page_size, rows.length) + ' of ' + rows.length
    : rows.length + ' zones';
  const pager = $('zpager');
  if (pager && paged) {
    const pages = Math.ceil(rows.length / Z.page_size);
    pager.innerHTML = '<wa-button size="s" appearance="outlined" id="pprev">Previous</wa-button>'
      + '<span class="wa-caption-s">Page ' + (page + 1) + ' of ' + pages + '</span>'
      + '<wa-button size="s" appearance="outlined" id="pnext">Next</wa-button>';
    $('pprev').addEventListener('click', () => { if (page > 0) { page--; renderTable(); } });
    $('pnext').addEventListener('click', () => { if (page < pages - 1) { page++; renderTable(); } });
  }
}

/* ── controls ── */
function optionChips() {
  const host = $('sopts');
  if (mode === 'explore' || mode === 'thermo') { host.innerHTML = ''; return; }
  if (mode === 'radar') {
    const rs = (G.chips.radar || []);
    host.innerHTML = rs.map(r =>
      '<wa-button size="s" data-radar="' + r.miles + '" appearance="'
      + (r.miles === opt.radar ? 'accent' : 'outlined') + '"'
      + (r.usable ? '' : ' disabled title="' + esc(r.why) + '"')
      + '>' + esc(r.label) + '</wa-button>').join('')
      || '<span class="wa-caption-s">No radar radius is live on this map.</span>';
    host.querySelectorAll('[data-radar]').forEach(b => b.addEventListener('click', () => {
      opt.radar = parseFloat(b.dataset.radar); optionChips(); paint();
    }));
    return;
  }
  const chips = G.chips[mode] || [];
  host.innerHTML = chips.map(c =>
    '<wa-button size="s" data-cat="' + esc(c.key) + '" appearance="'
    + (c.key === opt.cat ? 'accent' : 'outlined') + '"'
    + (c.usable ? '' : ' disabled title="' + esc(c.why) + '"')
    + '>' + esc(c.label) + ' (' + c.count + ')</wa-button>').join('')
    || '<span class="wa-caption-s">No mapped category is live for this question type on this map.</span>';
  host.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => {
    opt.cat = b.dataset.cat; optionChips(); paint();
  }));
}

document.querySelectorAll('#smodes [data-mode]').forEach(b => b.addEventListener('click', () => {
  if (b.hasAttribute('disabled')) return;
  mode = b.dataset.mode;
  document.querySelectorAll('#smodes [data-mode]').forEach(x =>
    x.setAttribute('appearance', x.dataset.mode === mode ? 'accent' : 'outlined'));
  if (mode === 'thermo') { thermoA = thermoB = null; drawLeg(); }
  optionChips(); paint();
}));
document.querySelectorAll('#ztable [data-sort]').forEach(b => b.addEventListener('click', () => {
  const c = parseInt(b.dataset.sort, 10);
  if (c === sortCol) sortDir = -sortDir; else { sortCol = c; sortDir = (c === 1 ? 1 : -1); }
  page = 0; renderTable();
}));
const zf = $('zfilter');
if (zf) zf.addEventListener('input', () => { filter = zf.value; page = 0; renderTable(); });

/* "Show on the map" on the hero's pick card — the only server-rendered control that
   drives client selection state, so it goes through `select()` like everything else. */
document.querySelectorAll('[data-zone]').forEach(b => b.addEventListener('click', () => {
  select(b.dataset.zone);
  const s = $('zones'); if (s) s.scrollIntoView();
}));

/* The day control is the shared `wa-radio-group#daysel`; the selection is persisted
   through localStorage. */
const daysel = $('daysel');
if (daysel) {
  daysel.value = day;
  daysel.addEventListener('change', () => {
    day = daysel.value; saveDay(day);
    renderList(); renderDossier(); renderTable();
  });
}

optionChips();
renderList();
renderDossier();
renderTable();
paint();
drawMap();
bindSpy();
bindProgress();
openTargeted();
"""


def strategy_script(report: Report) -> str:
    """The page's module script: map, simulator, list, dossier, table, day state."""
    js = (_S5_STRATEGY_JS
          .replace("__MAPLIBRE_JS__", MAPLIBRE_JS)
          .replace("__TILES_LIGHT__", TILES_LIGHT)
          .replace("__TILES_DARK__", TILES_DARK)
          .replace("__FLAGS__",
                   jdump({k: [label, variant, _S5_FLAG_ICON.get(variant, "circle-info")]
                          for k, (label, variant) in sorted(_S5_FLAG_TEXT.items())}))
          .replace("__AXIS_PLAIN__",
                   jdump({k: v[0] for k, v in sorted(_S5_AXIS_PLAIN.items())})))
    return SHARED_PAGE_JS + js


# ── the optional LLM adapter — off by default ─────────────────────────────────
#
# Settled empirically; see scratchpad/QWEN_VERDICT.md. On identical input the local
# model swung scores by ±2, hallucinated facts into prose, and scored 62% on a binary
# legality call under majority-vote-of-5 (against a 50% baseline) while writing
# reasons that contradicted its own verdicts. Therefore: deterministic Python owns
# every number, score, ranking, eligibility call and every factual sentence on both
# pages. The model may do exactly two things, and only under `--llm`:
#   (a) break ties among items the deterministic layer already scored *exactly* equal;
#   (b) write a flavour sentence into one visually distinct, explicitly labelled
#       "machine-suggested" slot, constrained to a supplied fact list, with every
#       number and proper noun validated against that list and the sentence dropped
#       on any mismatch.
# Without `--llm` the pages are complete and never mention a model.

class LLMClient:
    """Minimal LM Studio client. Every response is cached by prompt hash so reruns
    stay byte-identical, and every failure is silent (the feature is optional)."""

    def __init__(self, opts: Options, cache: Cache) -> None:
        self.url = opts.llm_url.rstrip("/")
        self.model = opts.llm_model
        self.cache = cache
        self.enabled = opts.llm

    def chat(self, system_prompt: str, user_input: str) -> str | None:
        """POST `/api/v1/chat` and return the first `message` item's text, or None.

        Cached by `sha256(model + system + input)`. Any error — transport, HTTP
        status, malformed body, or `--offline` with no cache entry — returns None,
        because nothing on the page may depend on this call succeeding.
        """
        if not self.enabled:
            return None
        key = f"{self.model}\x00{system_prompt}\x00{user_input}"
        cached = self.cache.get("llm", key, "json")
        if cached is not None:
            try:
                return json.loads(cached.decode("utf-8")).get("text")
            except (ValueError, UnicodeDecodeError):
                return None
        if self.cache.offline:
            return None

        body = {"model": self.model, "input": user_input,
                "system_prompt": system_prompt, "reasoning": "off"}
        try:
            with httpx.Client(timeout=120.0) as client:
                r = client.post(f"{self.url}/api/v1/chat", json=body)
            r.raise_for_status()
            text = ""
            for item in r.json().get("output", []):
                if item.get("type") == "message":
                    text = (item.get("content") or "").strip()
                    break
        except Exception as exc:  # noqa: BLE001 — the feature is optional by design
            log.warning("LLM call failed (ignored): %s", exc)
            return None
        self.cache.put("llm", key, "json", jdump({"text": text}).encode("utf-8"))
        return text or None


def llm_break_ties(client: LLMClient, tied_zone_ids: Sequence[str],
                   facts: dict[str, Any]) -> list[str]:
    """Reorder zones the deterministic layer scored *exactly* equal.

    Presentation order only — never a score. Any id the model omits or invents drops
    the whole reordering back to the deterministic `zone_id` order.
    """
    ordered = sorted(tied_zone_ids)
    if not client.enabled or len(ordered) < 2:
        return ordered
    lines = "\n".join(f"- {zid}: {facts.get(zid, '')}" for zid in ordered)
    prompt = (f"These places all scored exactly the same. Order them best-first for someone "
              f"hiding from seekers who travel by public transit.\n{lines}\n\n"
              f"Reply with the ids only, one per line, in your order. No other text.")
    text = client.chat(
        "You order a list of places. Reply with the given ids, one per line, and nothing else.",
        prompt)
    if not text:
        return ordered
    seen: list[str] = []
    allowed = set(ordered)
    for line in text.splitlines():
        cand = line.strip().strip("-•* \t").split(":")[0].strip()
        if cand in allowed and cand not in seen:
            seen.append(cand)
    if len(seen) != len(ordered):
        log.info("LLM tie-break rejected: returned %d of %d ids", len(seen), len(ordered))
        return ordered
    return seen


# ── the document ──────────────────────────────────────────────────────────────

_S5_EXTRA_CSS = r"""
@media (max-width: 900px) { #zdetail { position: static; } }
/* the compact 6-segment sparkbar. 240 <wa-progress-bar> custom elements in a 40-row
   rail would be materially worse than three CSS rules. */
.abar { display: flex; gap: 2px; align-items: center; }
.abar .ab { display: block; width: 100%; height: 8px; border-radius: 2px; background: var(--surface-2); position: relative; overflow: hidden; }
.abar .ab::after { content: ''; position: absolute; inset: 0 auto 0 0; width: var(--w); background: var(--accent); }
.mk.zlabel[data-band='top'] .md { background: var(--good); } .mk.zlabel[data-band='good'] .md { background: var(--accent); }
.mk.zlabel[data-band='fair'] .md { background: var(--warn); } .mk.zlabel[data-band='weak'] .md { background: var(--off); }
/* id-scoped, so it costs no class name: the alternative is a wa-text-nowrap class on
   every one of the ~3,300 client-rendered cells. */
#ztable td, #ztable th { white-space: nowrap; }
/* the Score cell's own bar: magnitude on the sequential ramp, behind the figure */
#ztable td[data-bar] { background: linear-gradient(to right,
  color-mix(in srgb, var(--seq-400) 22%, transparent) var(--w), transparent 0); }
#ztable tr[data-sel] td { background: color-mix(in srgb, var(--accent) 12%, transparent); }
#ztable th code { margin-inline-start: .35em; color: var(--ink-3); }
/* the sort headers are plain buttons, so the sorted column needs to say so */
#ztable th[aria-sort='ascending'] button::after { content: ' \2191'; }
#ztable th[aria-sort='descending'] button::after { content: ' \2193'; }
#ztable th[aria-sort]:not([aria-sort='none']) button { color: var(--accent-ink); font-weight: 700; }
/* a table row selects a dossier, so it is focusable and needs a visible focus ring */
#ztable tbody tr:focus-visible { outline: var(--wa-focus-ring); outline-offset: -2px; }
.zrow:focus-visible { outline: var(--wa-focus-ring); outline-offset: var(--wa-focus-ring-offset); }
"""


def render_strategy(report: Report) -> str:
    """Build the complete strategy.html document.

    Sections, in page order: hero + the pick card · the pull quote · §01 The shortlist ·
    §02 The whole field · §03 How to play this map · §04 How zones are scored · §05
    Method & parameters. All five share one guard (`report.zones` empty ⇒ all five
    vanish together), so the renumbering has no partial case — but it goes through the
    same placeholder mechanism index uses, because a guard is not a promise.
    """
    built: list[tuple[str, str, str, str, str]] = [
        ("zones", "Play", "The Shortlist", "map-location-dot", strategy_shortlist(report)),
        ("all", "Play", "The Whole Field", "table", strategy_all_candidates(report)),
        ("tactics", "Play", "Tactics", "list-check", strategy_tactics(report)),
        ("axes", "Reference", "How Zones Are Scored", "chart-simple", strategy_axes(report)),
        ("sources", "Reference", "Method", "book-open", strategy_provenance(report)),
    ]
    live = [quint for quint in built if quint[4]]
    numbered = [quint[4].replace(f'data-n="{_S4_ORDINAL}"', f'data-n="{i:02d}"', 1)
                for i, quint in enumerate(live, 1)]

    place = report.place or report.feed.agency_name
    top = report.ranked_zone_ids[0] if report.ranked_zone_ids else None
    top_zone = _s5_zone_by_id(report).get(top) if top else None
    pick = strategy_pick_card(report)

    # The rail addresses two destinations that are not sections of their own: the
    # hero's pick card, and the dossier — the best content on the page, which until
    # now had no entry at all.
    nav_source: list[tuple[str, str, str, str, str]] = []
    if pick:
        nav_source.append(("top", "Play", "The Pick", "star", "1"))
    for quint in live:
        nav_source.append(quint)
        if quint[0] == "zones" and report.zones:
            nav_source.append(("dossier", "Play", "Zone Dossiers", "location-dot", "1"))
    nav = nav_groups(nav_source, _S5_NAV_ORDER)

    status = ""
    if top_zone and top in report.zone_scores:
        status = chip(f"Best zone · {top_zone.name} "
                      f"{num(_s5_pts(report.zone_scores[top].overall_tenths), 1)}",
                      "location-dot", variant="brand", appearance="filled")
    header, subheader = page_chrome(report, status_html=status)

    # The top-zone chip is gone from this row because the pick card *is* it, in full.
    chips = "".join((
        chip(f"{report.size.name.capitalize()} game · "
             f"{_s4_dist(report, report.size.zone_radius_m, 2)} zones", "ruler-combined",
             variant="warning"),
        chip(f"Start: {report.hub.name}", "star"),
    ))

    left = el("div", join(
        el("p", esc("Hider's guide · " + report.feed.agency_name),
           class_="kicker wa-caption-s wa-text-uppercase"),
        el("h1", esc(f"Where to hide in {place}"), class_="wa-heading-4xl"),
        el("p", esc(
            f"{num(len(report.zones))} candidate hiding zones scored on six axes, "
            f"{num(len(report.dossier_zone_ids))} written up in full. "
            f"Every number below comes from {report.feed.agency_name}'s own schedule and from "
            f"OpenStreetMap — nothing here is an opinion about the city."),
           class_="wa-body-l", style="max-inline-size:46ch"),
        el("div", chips, class_="wa-cluster wa-gap-2xs"),
    ), class_="wa-stack wa-gap-xs", style="flex:1 1 24rem")

    # Top-aligned for the same reason as the report hero: the pick card is much taller
    # than the text, and centring it pushes the H1 down the page in the two-column view.
    hero = el("header", el("div", join(
        left, el("div", pick, style="flex:1 1 26rem") if pick else "",
    ), class_="wa-split wa-flex-wrap wa-gap-2xl wa-align-items-start"),
        id="top", class_="wa-stack wa-gap-l")

    # The page's thesis, which was a footnote at the end of §01. The precise version
    # naming R1 and X3 survives verbatim inside §04's R and X bodies.
    thesis = pull_quote(
        "A zone you can actually reach and a zone the seekers find expensive to reach are "
        "opposite things. One that scores well on both is genuinely rare — and it is what "
        "you are shopping for below.")

    main = el("main", join(thesis, *numbered), class_="wa-stack wa-gap-3xl")

    page = el("wa-page", join(_s4_banner_slot(report), header, subheader, "<!--NAV-->",
                              hero, main, _s4_footer(report)),
              mobile_breakpoint="920")

    zones_payload = _s5_zone_payload(report)
    blocks = join(
        json_block("sgame", _s5_game_payload(report)),
        json_block("zdata", zones_payload),
        json_block("poi", _s5_poi_payload(report)),
    )

    description = (
        f"Where to hide in {place} for Jet Lag: The Game's Hide+Seek — "
        f"{num(len(report.zones))} transit hiding zones scored on information resistance, reach, "
        f"service, endgame spots, amenities and exposure, with a question simulator.")

    return document(
        title=f"Where to hide in {place} — Hide+Seek strategy",
        description=description,
        body_html=page + "\n" + blocks,
        script_js=strategy_script(report),
        extra_css=STRATEGY_CSS + _S5_EXTRA_CSS,
        nav=nav,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# S0 · ORCHESTRATION
# ═══════════════════════════════════════════════════════════════════════════════


def build_report(opts: Options, cache: Cache) -> Report:
    """Run the whole pipeline and return the object both renderers consume.

    The order below is the dependency order and it is the contract between sections:
    nothing later may be needed by anything earlier.
    """
    degradations: list[str] = []

    with Timer("S1 load feed"):
        feed = load_feed(opts.source, cache)
        normalise_times(feed)
        start, end, as_of = feed_window(feed, opts.as_of)
        types = day_types(feed, start, end)
        if len(types) < 2:
            degradations.append("single service-day type: no weekend variation in this feed")

    with Timer("S1 service days"):
        proj = Projection.about([(s.lat, s.lon) for s in sorted(feed.stops.values(), key=lambda s: s.stop_id)])
        days = [build_service_day(feed, t, proj, board_slack_s=opts.board_slack_s) for t in types]
        best = max(days, key=lambda d: (d.trips, d.day_type.key))
        stations = cluster_stations(sorted(feed.stops.values(), key=lambda s: s.stop_id), proj)

    with Timer("S1 inference"):
        hub = infer_hub(feed, best, proj)
        metrics = network_metrics(feed, days, proj, hub, QUARTER_MILE_M)
        size, size_inference = infer_game_size(metrics, opts)
        border = infer_border(feed, best, hub, size, proj, opts)
        centres = zone_cover(
            best.served_stop_ids, size.zone_radius_m,
            {sid: len(best.stop_days[sid].departures) for sid in best.served_stop_ids},
            {sid: proj.xy(feed.stops[sid].lat, feed.stops[sid].lon) for sid in best.served_stop_ids},
        )
        zones = build_zones(feed, best, centres, size.zone_radius_m, proj)
        metrics = network_metrics(feed, days, proj, hub, size.zone_radius_m)
        headways = route_headways(feed, days)
        gtfs_facts = gtfs_question_facts(feed, days, zones, stations)

    with Timer("S2 geodata"):
        if opts.use_osm:
            try:
                geo = collect_geodata(cache, opts, border, zones, proj, size.zone_radius_m)
            except Exception as exc:  # noqa: BLE001 — Overpass is a shared free service and does fail
                log.warning("OSM layer unavailable: %s", exc)
                degradations.append(f"OpenStreetMap layer unavailable ({exc.__class__.__name__})")
                geo = GeoData(False, border.bbox, {}, {}, {}, {}, AdminInfo(None, None, None, {}, {}, {}, "unknown"),
                              {}, {}, {}, [], ["Overpass was unreachable; OSM-backed scores are excluded."])
        else:
            degradations.append("--no-osm: OSM-backed questions, curses and zone axes are excluded")
            geo = GeoData(False, border.bbox, {}, {}, {}, {}, AdminInfo(None, None, None, {}, {}, {}, "unknown"),
                          {}, {}, {}, [], ["--no-osm was given; the OSM layer was not queried."])

    with Timer("S3 questions and scoring"):
        questions = audit_questions(size, geo, gtfs_facts, zones, metrics, border)
        curses = audit_curses(size, geo, gtfs_facts, geo.admin.country_code)

        # Signatures and surv are computed only for questions that are still alive:
        # a dead question partitions nothing, and evaluating it would just be noise.
        defs = {d.id: d for d in catalogue_for(size)}
        live = [q for q in questions if q.status in ("functional", "weak", "unaskable")]
        signatures = {q.id: answer_signature(defs[q.id], zones, geo, gtfs_facts, proj) for q in live}
        if len(zones) <= SURV_FULL_UNIVERSE_MAX:
            seekers = list(range(len(zones)))
        else:
            stride = math.ceil(len(zones) / SEEKER_SAMPLE_CAP)
            seekers = list(range(0, len(zones), stride))[:SEEKER_SAMPLE_CAP]
        surv = {q.id: survival_fractions(defs[q.id], signatures[q.id], zones, seekers) for q in live}
        k = {"small": 3, "medium": 4, "large": 5}[size.name]
        order, funnel = global_question_order(questions, signatures, zones, k)

        origin = opts.start_stop_id or hub.stop_id
        dep_s = hms_to_s(opts.departure) or 32400
        times = raptor(best, [origin], dep_s)
        back = raptor_reverse(best, [origin], int(metrics["median_last_departure_s"]))
        zone_scores = score_zones(zones, questions, signatures, surv, geo, best, times, back,
                                  size, metrics, proj)
        ranked = rank_zones(zone_scores)
        fitness = score_fitness(metrics, questions, zones, zone_scores, size, days)
        dossiers = select_dossiers(ranked, zone_scores, {z.zone_id: z for z in zones}, size.zone_radius_m)

    findings = derive_findings(fitness, metrics, questions)
    recommendations = derive_recommendations({
        "metrics": metrics, "fitness": fitness, "size": size, "hub": hub,
        "border": border, "curses": curses, "questions": questions, "feed": feed,
    })
    provenance = build_provenance(opts, feed, geo, size, as_of, degradations)
    place = geo.admin.place_name or feed.agency_name
    travel_samples = travel_time_samples(feed, days, zones, origin, dep_s, proj)

    return Report(
        opts=opts, feed=feed, proj=proj, size=size, size_inference=size_inference,
        hub=hub, border=border, days=days, selected_day=best.day_type.key, zones=zones,
        metrics=metrics, route_headways=headways, travel_samples=travel_samples, geo=geo,
        questions=questions, question_order=order, question_funnel=funnel, curses=curses,
        fitness=fitness, zone_scores=zone_scores, ranked_zone_ids=ranked,
        dossier_zone_ids=dossiers, findings=findings, recommendations=recommendations,
        place=place, provenance=provenance, degradations=degradations,
    )


def selftest(report: Report) -> None:
    """Assert the golden numbers for the reference feed (The Rapid, summer 2026).

    Run with `--selftest`. These are measured, not guessed, and a change to any of
    them means an algorithm changed — which may be correct, but must be deliberate.
    """
    checks: list[tuple[str, Any, Any]] = [
        ("served_stops_weekday", report.metrics.get("served_stops"), 1490),
        ("routes_weekday", report.metrics.get("routes"), 24),
        ("trips_weekday", report.metrics.get("trips"), 1699),
        ("zones_quarter_mile", len(report.zones), 319),
        ("hub", report.hub.stop_id, "1"),
        ("game_size", report.size.name, "medium"),
    ]
    approx: list[tuple[str, Any, float, float]] = [
        ("hull_sq_mi", report.metrics.get("hull_sq_m", 0) / SQM_PER_SQMI, 160.1, 0.5),
        ("t90_min", report.metrics.get("t90_min", 0), 76.8, 1.0),
        ("hub_route_share", report.hub.route_share, 0.750, 0.01),
    ]
    bad: list[str] = []
    for name, got, want in checks:
        if got != want:
            bad.append(f"{name}: expected {want!r}, got {got!r}")
    for name, got, want, tol in approx:
        if got is None or abs(float(got) - want) > tol:
            bad.append(f"{name}: expected ≈{want} (±{tol}), got {got!r}")
    if bad:
        raise SystemExit("selftest FAILED:\n  " + "\n  ".join(bad))
    print("selftest OK", file=sys.stderr)


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point: parse, build, render, write. Returns a process exit code."""
    opts = parse_args(argv)
    cache = Cache(opts.cache_dir, offline=opts.offline, refresh=opts.refresh)
    opts.out_dir.mkdir(parents=True, exist_ok=True)

    try:
        report = build_report(opts, cache)
    except CacheMiss as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except NotImplementedError as exc:
        print(f"error: section {exc} is not implemented yet", file=sys.stderr)
        return 3

    if opts.selftest:
        selftest(report)

    with Timer("S4 render index.html"):
        index_html = render_index(report)
    with Timer("S5 render strategy.html"):
        strategy_html = render_strategy(report)

    for name, text in (("index.html", index_html), ("strategy.html", strategy_html)):
        path = opts.out_dir / name
        path.write_text(text, encoding="utf-8", newline="\n")
        log.info("wrote %s (%d bytes)", path, len(text.encode("utf-8")))

    if len(report.zones) > 2000:
        # pages.md §5: nothing is ever silently dropped — the complete scored set goes
        # next to the HTML and the table links to it.
        (opts.out_dir / "zones.json").write_text(
            jdump({"zones": [report.zone_scores[z] for z in report.ranked_zone_ids]}),
            encoding="utf-8", newline="\n")

    print(f"{opts.out_dir / 'index.html'}\n{opts.out_dir / 'strategy.html'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
