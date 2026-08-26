#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     # Also supplies the `pyosmium-up-to-date` binary that stage 0b runs.
#     "osmium>=4.3",
#     "boto3>=1.43",
#     # For --clip-region's point-in-polygon test (stage 4 density exactness).
#     "shapely>=2.0",
# ]
# ///
"""
tools/osm-world/build.py — build the global OSM world files and publish them to R2.

WHAT THIS REPLACES
------------------
`osm/geodata.js` used to answer every question by asking Overpass at run time: one
bbox-wide query per category group, with mirror failover, a ≤0.1° tiling fallback and
a 3 s courtesy sleep between round-trips. That is ~10 requests and ~40 MB on the
reference map, against a shared free service that 504'd on five of six first attempts.

This script moves all of it offline. It reads one planet.osm.pbf and writes a
FlatGeobuf per category to R2. The browser then range-requests only the bytes its bbox
needs, because FlatGeobuf carries a packed Hilbert R-tree in its header: read the
index, learn which byte ranges hold the features intersecting your bbox, fetch those.
No server, no rate limit, no failover, no tiling.

FlatGeobuf is the format that makes that possible. Geobuf — protobuf-encoded GeoJSON —
has no spatial index at all and would mean downloading the planet to read one park.

WHAT IT COSTS
-------------
A planet build is a big job and this script does not pretend otherwise:

  * planet.osm.pbf is ~87 GB. Stage 0 downloads it if it is not already there.
  * Stage 0b then keeps it current with replication diffs instead of re-downloading:
    a week of edits is ~700 MB of diffs against an 87.6 GB re-fetch, about 125× less.
    It rewrites the whole PBF to apply them, so it saves bandwidth, not time, and it
    transiently needs about double the planet in free disk. `--no-update` opts out.
  * Stage 1 makes ONE pass over it (see `stage_filter`) and everything after that
    works on a ~4 GB intermediate. Skipping that consolidation and running 35
    `osmium tags-filter` passes over the planet instead is roughly a day of I/O.
  * Stage 4 makes a second full pass for the density grid, because counting buildings
    needs every building and the intermediate deliberately does not carry them.
  * Peak disk is roughly 180 GB including the planet itself. Peak RAM is dominated by
    osmium's node-location cache; `--index-type sparse_file_array` keeps it on disk.

Every stage is skipped when its output already exists, so an interrupted build resumes.
Pass `--force` to rebuild anyway.

USAGE
-----
    uv run tools/osm-world/build.py --out build/world
    uv run tools/osm-world/build.py --planet some-extract.osm.pbf --out build/world
    uv run tools/osm-world/build.py --out build/world --upload

With no `--planet`, the planet file is downloaded to `./planet-latest.osm.pbf`, and
every later run brings that same file up to date with replication diffs rather than
re-downloading it. Point `--planet` at a Geofabrik extract to develop against
something that builds in minutes instead of hours — the script does not care which it
is given, and only downloads when the named file is absent.

`--no-fetch` turns a missing planet file into a hard error instead, which is what a CI
job with a pre-seeded cache wants.

`uv` reads the dependency block above and builds the environment itself; there is no
requirements file and no virtualenv to activate.

EXTERNAL BINARIES
-----------------
Two required, and they are not pip-installable:

    osmium      osmium-tool      (Fedora: dnf install osmium-tool)
    ogr2ogr     GDAL >= 3.5      (Fedora: dnf install gdal)

GDAL 3.5 is the floor because that is where the FlatGeobuf writer learned to emit the
spatial index by default. Without the index every client read is a full download and
the entire point of this exercise is lost, so `preflight` checks the version rather
than trusting it.

One more is needed only for stage 0, and any of the three will do:

    aria2c | curl | wget

The download is NOT done in Python. An 85 GB transfer wants resumption across a dropped
connection, and aria2c additionally wants several connections at once; all three of
these do that properly and correctly, and `urllib` does not.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
TABLE_PATH = HERE / "categories.json"

# GDAL's FlatGeobuf driver writes the packed Hilbert R-tree from 3.5 on. Below that the
# output is a valid FlatGeobuf with no index, which reads correctly and downloads whole
# — the failure is silent and only shows up as a 4 GB request in the browser.
MIN_GDAL = (3, 5)

# osmium's node-location index. `sparse_file_array` spills to disk; the in-memory
# alternatives need ~40 GB of RAM for a planet and get OOM-killed on anything smaller.
OSMIUM_INDEX = "sparse_file_array"

# ── stage 0: the planet download ─────────────────────────────────────────────

DEFAULT_PLANET = Path("planet-latest.osm.pbf")

# Tried in order. Every one of these was verified reachable, serving ~87.6 GB with a
# matching `.md5` sidecar. The OSM wiki lists 17 sites in total; these are the ones that
# answered, spread across operators and continents so that one institution's outage does
# not strand a build.
#
# NOT ordered by any etiquette rule. The wiki used to ask people to prefer a mirror to
# conserve OSM's bandwidth and explicitly no longer does — "It used to be necessary to
# download mirrors to conserve OSM bandwidth, but that is no longer necessary." The
# origin sits first because it is authoritative and always the freshest snapshot; the
# rest are failover.
#
# THE ORDER IS NOT ARBITRARY AT THE TAIL. Mirrors lag: when this list was checked, nine
# of ten reachable sites published md5 3f79d450… while osuosl published 434349ae… — a
# different nightly rebuild under the same filename. Lagging mirrors go last, and
# `stage_fetch_planet` discards a partial file rather than resuming it against a
# different mirror, because the two together are what prevent splicing two snapshots.
#
# Mirrors come and go. The current list lives at
# https://wiki.openstreetmap.org/wiki/Planet.osm — pass `--planet-url` to override
# rather than editing this and hoping.
PLANET_MIRRORS = (
    "https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf",
    "https://ftpmirror.your.org/pub/openstreetmap/pbf/planet-latest.osm.pbf",
    "https://ftp5.gwdg.de/pub/misc/openstreetmap/planet.openstreetmap.org/pbf/planet-latest.osm.pbf",
    "https://ftp.fau.de/osm-planet/pbf/planet-latest.osm.pbf",
    "https://mirror.init7.net/openstreetmap/pbf/planet-latest.osm.pbf",
    "https://ftp.spline.de/pub/openstreetmap/pbf/planet-latest.osm.pbf",
    "https://download.bbbike.org/osm/planet/planet-latest.osm.pbf",
    "https://downloads.opencagedata.com/planet/planet-latest.osm.pbf",
    "https://mirror.marwan.ma/openstreetmap/pbf/planet-latest.osm.pbf",
    # Observed a nightly behind the other nine. Kept as a last resort: a stale planet
    # still builds, it just dates every count by a day.
    "https://ftp.osuosl.org/pub/openstreetmap/pbf/planet-latest.osm.pbf",
)

# Free space demanded before starting: the file itself plus room for the ~4 GB stage-1
# intermediate and the per-layer scratch. Refusing up front beats discovering it at 90%.
PLANET_HEADROOM_BYTES = 20 << 30

# In preference order. All three resume a partial file, which is the property that
# matters — an 85 GB transfer WILL be interrupted. aria2c is first because it also
# opens several connections, which is usually the difference between 2 hours and 8.
DOWNLOADERS = (
    ("aria2c", lambda url, dest: [
        "aria2c", url,
        "--continue=true",
        "--max-connection-per-server=8",
        "--split=8",
        "--min-split-size=64M",
        # Preallocating 85 GB takes minutes on some filesystems and buys nothing here.
        "--file-allocation=none",
        "--summary-interval=60",
        "--dir", str(dest.parent.resolve()),
        "--out", dest.name,
    ]),
    ("curl", lambda url, dest: [
        "curl", url,
        "--location", "--fail",
        "--continue-at", "-",
        "--retry", "5", "--retry-delay", "10",
        "--output", str(dest),
    ]),
    ("wget", lambda url, dest: [
        "wget", url,
        "--continue", "--tries=5",
        "--output-document", str(dest),
    ]),
)


# ═══════════════════════════════════════════════════════════════════════════════
# The build table
# ═══════════════════════════════════════════════════════════════════════════════


# The geometry classes a layer may ask `osmium export` for. Passing all three to every
# layer was the double-emit bug (DESIGN.md §Phase 0): osmium exports a closed way ONCE PER
# REQUESTED INTERPRETATION, so `point,linestring,polygon` writes every closed way twice
# — its polygon, then the same ring re-read as a zero-area linestring — and nothing
# downstream dedups ways. `point,polygon` makes a closed way a polygon and only that.
GEOMETRY_TYPES = frozenset({"point", "linestring", "polygon"})


@dataclass(frozen=True)
class Layer:
    """One output FlatGeobuf: a name, an osmium pre-filter, an OGR SQL predicate.

    `geometry` is the comma-separated `--geometry-types` list handed to
    `osmium export`, derived per layer from its selector and OSM tagging reality
    (documented next to each entry in categories.json):

      * pure-node layers (`mountain`, `bench`) ask for `point`;
      * area layers (`park`, `museum`, …) ask for `point,polygon` — which is the
        double-emit fix for them: a closed way exports once, as its polygon, and an
        unclosed way carrying an area tag (a mapping error) is dropped;
      * genuinely mixed layers (`water`, `coastline`, `high_speed_rail`, `platform`,
        `green`) keep all three types and set `dedup`, because a lake is a polygon and
        a river a linestring in the same file.

    `dedup` drops a way's linestring reading when the same way was also exported as a
    polygon — the closed-way double emission that `--geometry-types` alone cannot fix
    on a mixed layer. See `apply_geometry_dedup`.

    `count_only` marks a layer nothing ever reads features from (the curse predicate
    layers): the client walks the R-tree and counts (`worldCount` in osm/worldfile.js)
    without touching one feature byte. Those ship as 2-point bbox-diagonal linestrings
    with no properties — same envelope, so every R-tree node and every search result
    is bit-identical, at a fraction of the bytes (DESIGN.md §Phase 1 R1). See
    `diagonalize_layer`, which also dedups on `(osm_type, osm_id)`.
    """

    key: str
    filter: tuple[str, ...]
    where: str
    post: str | None = None
    geometry: str = "point,linestring,polygon"
    dedup: bool = False
    count_only: bool = False


@dataclass
class Table:
    categories: list[Layer] = field(default_factory=list)
    curse_layers: list[Layer] = field(default_factory=list)
    density_layers: list[Layer] = field(default_factory=list)
    cell_deg: float = 0.002
    include_tags: tuple[str, ...] = ()
    # The columns the CLIENT reads off a shipped feature, plus the `(osm_type, osm_id)`
    # identity. Everything else in `include_tags` exists so a `where` clause can see it
    # and is projected away by `ogr2ogr -select` (DESIGN.md §Phase 1 R5). Identity stays
    # even on layers that never read it, because the Phase-3 shard merge dedups on it.
    runtime_columns: tuple[str, ...] = ()

    @property
    def feature_layers(self) -> list[Layer]:
        """Everything that ships as real geometry — one FlatGeobuf each.

        Deliberately WITHOUT admin: per-extract admin is broken by construction (a
        boundary relation only assembles inside an extract that contains it whole),
        and merge.py takes the shipped admin layer from `--admin` — the Overture
        build — never from anything build.py produced. Building it here was pure
        waste, measured at 16.5% of pooled feature-shard output. See
        `_admin_comment` in categories.json.
        """
        return list(self.categories) + list(self.curse_layers)


def load_table(path: Path) -> Table:
    raw = json.loads(path.read_text(encoding="utf-8"))

    def layer(entry: dict) -> Layer:
        built = Layer(
            key=entry["key"],
            filter=tuple(entry["filter"]),
            where=entry["where"],
            post=entry.get("post"),
            geometry=entry.get("geometry", "point,linestring,polygon"),
            dedup=bool(entry.get("dedup", False)),
            count_only=bool(entry.get("count_only", False)),
        )
        kinds = set(built.geometry.split(","))
        if not kinds or not kinds <= GEOMETRY_TYPES:
            raise SystemExit(
                f"layer {built.key}: geometry {built.geometry!r} is not a subset of "
                f"{sorted(GEOMETRY_TYPES)}")
        if built.dedup and not {"linestring", "polygon"} <= kinds:
            # Nothing to dedup unless a closed way can be exported both ways.
            raise SystemExit(
                f"layer {built.key}: dedup only applies to layers exporting both "
                f"linestring and polygon, not {built.geometry!r}")
        if built.dedup and built.count_only:
            # A count-only layer dedups on (osm_type, osm_id) inside diagonalize_layer;
            # the two flags together would run the same drop twice.
            raise SystemExit(f"layer {built.key}: count_only implies its own dedup")
        return built

    density = raw["density"]

    # No admin here on purpose — categories.json carries no admin entry (see its
    # `_admin_comment`): the shipped admin layer is Overture's, placed by
    # merge.py --admin, and a per-extract OSM admin build is discarded unread.
    return Table(
        categories=[layer(e) for e in raw["categories"]],
        curse_layers=[layer(e) for e in raw["curse_layers"]],
        density_layers=[layer(e) for e in density["layers"]],
        cell_deg=float(density["cell_deg"]),
        include_tags=tuple(raw["include_tags"]),
        runtime_columns=tuple(raw["runtime_columns"]),
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Post-filters — the conditions OGR SQL cannot express
# ═══════════════════════════════════════════════════════════════════════════════

# "200", "200 km/h", "125 mph", "160;200". OSM has no unit convention worth relying on,
# so parse the number and read the unit off the suffix, defaulting to km/h as the wiki
# specifies.
_MAXSPEED = re.compile(r"(\d+(?:\.\d+)?)\s*(mph|km/h|kmh|knots)?", re.IGNORECASE)
_MPH_TO_KMH = 1.609344
_KNOTS_TO_KMH = 1.852


def _maxspeed_kmh(value: str) -> float | None:
    """Highest speed named in a `maxspeed` value, in km/h, or None if unparseable."""
    best: float | None = None
    for number, unit in _MAXSPEED.findall(value or ""):
        try:
            speed = float(number)
        except ValueError:
            continue
        unit = (unit or "").lower()
        if unit == "mph":
            speed *= _MPH_TO_KMH
        elif unit == "knots":
            speed *= _KNOTS_TO_KMH
        if best is None or speed > best:
            best = speed
    return best


def post_highspeed(props: dict) -> bool:
    """
    `railway=rail` + (`highspeed=yes` OR maxspeed >= 200 km/h).

    The `where` clause keeps everything carrying either key, because OGR SQL cannot
    parse "125 mph". Without this step every ordinary rail line on Earth — every line
    with any maxspeed tag at all — would ship as high-speed rail.
    """
    if (props.get("highspeed") or "").strip().lower() == "yes":
        return True
    speed = _maxspeed_kmh(props.get("maxspeed") or "")
    return speed is not None and speed >= 200.0


POST_FILTERS = {"highspeed": post_highspeed}


# ═══════════════════════════════════════════════════════════════════════════════
# Shell plumbing
# ═══════════════════════════════════════════════════════════════════════════════


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    log("$ " + " ".join(cmd))
    return subprocess.run(cmd, check=True, **kwargs)


def gdal_version() -> tuple[int, ...]:
    out = subprocess.run(
        ["ogr2ogr", "--version"], check=True, capture_output=True, text=True
    ).stdout
    match = re.search(r"GDAL\s+(\d+)\.(\d+)\.(\d+)", out)
    if not match:
        raise SystemExit(f"could not parse GDAL version from {out!r}")
    return tuple(int(g) for g in match.groups())


def preflight() -> None:
    """Fail before the eight-hour part, not during it."""
    # ogrinfo included since 2026-08-22 (the finalize-job lesson, run
    # 32597356160): preflight what the code INVOKES — feature_count shells out
    # to ogrinfo — not just what usually travels together in a package.
    missing = [b for b in ("osmium", "ogr2ogr", "ogrinfo") if shutil.which(b) is None]
    if missing:
        raise SystemExit(
            f"missing required binary/binaries: {', '.join(missing)}\n"
            "  osmium          → osmium-tool package\n"
            "  ogr2ogr/ogrinfo → gdal package"
        )
    version = gdal_version()
    if version[:2] < MIN_GDAL:
        raise SystemExit(
            f"GDAL {'.'.join(map(str, version))} is too old; need "
            f">= {'.'.join(map(str, MIN_GDAL))} for the FlatGeobuf spatial index.\n"
            "An unindexed FlatGeobuf reads fine and downloads whole — the failure is "
            "silent and defeats the purpose of this build."
        )
    log(f"preflight ok — GDAL {'.'.join(map(str, version))}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ═══════════════════════════════════════════════════════════════════════════════
# Stage 0 — get the planet
# ═══════════════════════════════════════════════════════════════════════════════


def human_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024.0:
            return f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} PB"


def remote_size(url: str) -> int | None:
    """Content-Length via a HEAD, or None. Used only to check disk space up front."""
    import urllib.request  # noqa: PLC0415 — stdlib, and only stage 0 needs it

    request = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            length = response.headers.get("Content-Length")
            return int(length) if length else None
    except Exception:
        return None


def expected_md5(url: str) -> str | None:
    """
    The mirror's `.md5` sidecar, if it publishes one.

    Every planet mirror serves `planet-latest.osm.pbf.md5` next to the file, in the
    usual `<hash>  <filename>` form. It is worth having: a resumed download that
    silently interleaved bytes from two different nightly rebuilds produces a file that
    osmium will parse for hours before failing somewhere in the middle.
    """
    import urllib.request  # noqa: PLC0415

    try:
        with urllib.request.urlopen(f"{url}.md5", timeout=30) as response:
            text = response.read().decode("utf-8", "replace").strip()
    except Exception:
        return None
    parts = text.split()
    return parts[0] if parts and len(parts[0]) == 32 else None


def md5_file(path: Path) -> str:
    digest = hashlib.md5()  # noqa: S324 — matching the mirrors' published checksum
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stage_fetch_planet(planet: Path, url: str | None, no_fetch: bool,
                       skip_md5: bool) -> Path:
    """
    Download the planet if it is not already on disk.

    Deliberately a no-op when the file exists, which is what makes `--planet` usable for
    a Geofabrik extract: the script never asks what it was handed, only whether it is
    there. Nothing here re-downloads or freshens an existing file — a planet build takes
    hours and silently swapping the input out from under a resumed run would be worse
    than a stale snapshot. Delete the file to get a newer one.
    """
    if planet.exists():
        log(f"stage 0: {planet} present ({human_bytes(planet.stat().st_size)}), not fetching")
        return planet

    if no_fetch:
        raise SystemExit(
            f"planet file not found: {planet}\n"
            "--no-fetch was given, so it will not be downloaded."
        )

    tool = next(((name, build) for name, build in DOWNLOADERS if shutil.which(name)), None)
    if tool is None:
        raise SystemExit(
            "no downloader found — stage 0 needs one of aria2c, curl or wget.\n"
            "Install one, or fetch the planet yourself and pass --planet."
        )
    name, build_argv = tool

    urls = [url] if url else list(PLANET_MIRRORS)
    planet.parent.mkdir(parents=True, exist_ok=True)

    size = remote_size(urls[0])
    if size:
        free = shutil.disk_usage(planet.parent).free
        need = size + PLANET_HEADROOM_BYTES
        log(f"stage 0: remote is {human_bytes(size)}; "
            f"{human_bytes(free)} free on {planet.parent.resolve()}")
        if free < need:
            raise SystemExit(
                f"not enough free space: need ~{human_bytes(need)} "
                f"(the file plus {human_bytes(PLANET_HEADROOM_BYTES)} of build headroom), "
                f"have {human_bytes(free)}."
            )

    # This is an enormous side effect to trigger from a bare invocation, so say so
    # loudly enough that anyone who did not mean it can still ctrl-C.
    log("stage 0: ══════════════════════════════════════════════════════════")
    log(f"stage 0: downloading the OpenStreetMap planet ({human_bytes(size) if size else '~85 GB'})")
    log(f"stage 0:   to        {planet.resolve()}")
    log(f"stage 0:   with      {name}")
    log("stage 0:   this takes hours. It resumes if interrupted — rerun the same command.")
    log("stage 0:   pass --planet <extract.osm.pbf> to build from a small region instead.")
    log("stage 0: ══════════════════════════════════════════════════════════")

    last_error: Exception | None = None
    partial_from: str | None = None
    for candidate in urls:
        # Resuming ACROSS mirrors is the one thing that must not happen. Mirrors lag
        # each other by a nightly rebuild — as of writing, osuosl and planet.osm.org
        # publish different md5s for "planet-latest" — so continuing mirror A's partial
        # file against mirror B splices two different snapshots together. The result is
        # a plausible-looking PBF that osmium parses for hours before failing somewhere
        # in the middle. Start clean whenever the source changes.
        if partial_from is not None and partial_from != candidate and planet.exists():
            log(f"stage 0: discarding {human_bytes(planet.stat().st_size)} partial from "
                f"{partial_from} — resuming it against a different mirror would splice "
                "two nightly snapshots")
            planet.unlink()

        log(f"stage 0: trying {candidate}")
        partial_from = candidate
        try:
            run(build_argv(candidate, planet))
        except subprocess.CalledProcessError as exc:
            # A mirror can be down, rate-limiting, or simply not carry the file.
            log(f"stage 0: {candidate} failed ({exc}); trying the next mirror")
            last_error = exc
            continue
        if not planet.exists():
            last_error = RuntimeError(f"{name} reported success but wrote no file")
            continue

        if skip_md5:
            log("stage 0: --skip-md5 given, not verifying")
            return planet
        # Checked against the md5 published by the mirror we actually downloaded from,
        # never a fixed one, for the same lag reason.
        want = expected_md5(candidate)
        if want is None:
            log(f"stage 0: {candidate} publishes no .md5; cannot verify")
            return planet
        log(f"stage 0: verifying md5 (reads {human_bytes(planet.stat().st_size)}, a few minutes)")
        got = md5_file(planet)
        if got == want:
            log(f"stage 0: md5 ok ({got})")
            return planet
        # A corrupt file must never be left where the next run treats it as valid.
        log(f"stage 0: md5 MISMATCH on {candidate} (expected {want}, got {got}); "
            "discarding and trying the next mirror")
        planet.unlink(missing_ok=True)
        partial_from = None
        last_error = RuntimeError(f"md5 mismatch on {candidate}")

    raise SystemExit(f"could not download the planet from any mirror: {last_error}")


# ═══════════════════════════════════════════════════════════════════════════════
# Stage 0b — bring an existing planet up to date with replication diffs
# ═══════════════════════════════════════════════════════════════════════════════

# Per invocation, and this is a MEMORY limit, not a disk one: pyosmium-up-to-date holds
# the downloaded diffs in RAM. Its own default is 1 GB ≈ 3 days of edits, and raising it
# buys nothing here — a week of daily diffs is ~700 MB, so a weekly rebuild needs two or
# three passes and never more than a gigabyte resident. Do not raise this to "save
# passes"; it trades a bounded loop for an OOM kill.
UPDATE_CHUNK_MB = 1024

# Refuse to start if the loop could plausibly not finish. Applying diffs is not an
# in-place edit: osmium writes a complete new PBF and swaps it in, so the update
# transiently needs a second copy of the file.
UPDATE_HEADROOM_FACTOR = 2.1


def stage_update_planet(planet: Path, no_update: bool, freshly_downloaded: bool) -> bool:
    """
    Apply OSM replication diffs to an existing planet file. Returns True if it changed.

    WHY THIS IS THE DEFAULT. A weekly planet re-download is 87.6 GB. The same week of
    edits as replication diffs is about 700 MB — the daily diffs run ~100 MB each — so
    this is roughly 125× less to transfer. `pyosmium-up-to-date` reads the file's own
    `osmosis_replication_timestamp` header (the same field `planet_timestamp` reads for
    the manifest), works out which diffs are missing, and applies them.

    WHAT IT DOES NOT SAVE is time. Applying diffs rewrites the entire PBF, so the disk
    I/O is comparable to a fresh download and the transient disk requirement is roughly
    double the planet. On a very fast connection a fresh torrent can genuinely be
    quicker; on anything metered or slow this wins by a mile. `--no-update` opts out.

    A freshly downloaded planet is deliberately NOT updated. It is at most a week old,
    it is internally coherent, and the manifest records its real snapshot date — paying
    an 87 GB rewrite immediately after an 87 GB download to shave a few days off is not
    a trade anyone asked for.
    """
    if no_update:
        log("stage 0b: --no-update given, not applying replication diffs")
        return False
    if freshly_downloaded:
        log("stage 0b: planet was just downloaded, already current — not updating")
        return False

    tool = shutil.which("pyosmium-up-to-date")
    if tool is None:
        # Not fatal: an out-of-date planet still builds, it just dates every count.
        log("stage 0b: pyosmium-up-to-date not on PATH; building from the planet as-is")
        return False

    before = planet_timestamp(planet)
    size = planet.stat().st_size
    free = shutil.disk_usage(planet.parent).free
    need = int(size * UPDATE_HEADROOM_FACTOR) - size
    log(f"stage 0b: planet snapshot is {before or 'unknown'}")
    if free < need:
        log(f"stage 0b: skipping update — needs ~{human_bytes(need)} free to write a new "
            f"copy alongside the old one, have {human_bytes(free)}")
        return False

    log(f"stage 0b: applying replication diffs (rewrites {human_bytes(size)}; "
        "the download is small, the rewrite is not)")

    # Exit status is a three-way, not a boolean. Quoting its own --help: "returns 0, if
    # updates have been successfully applied up to the newest data or no new data was
    # available. It returns 1, if some updates could not be resolved. Any other error
    # results in a return code larger than 1."
    #
    # So 1 is the ambiguous one — it covers both "stopped at the --size limit, more to
    # do" and "genuinely could not resolve". Looping on it is right for the first and
    # useless for the second, and the two are indistinguishable from the exit code
    # alone. The loop therefore watches the file's OWN replication timestamp and stops
    # the moment a pass fails to advance it; without that, a persistent failure would
    # re-download a gigabyte of diffs twenty-four times over.
    passes = 0
    cursor = before
    for attempt in range(1, 25):
        proc = subprocess.run(  # noqa: S603
            [tool, "--size", str(UPDATE_CHUNK_MB), str(planet)],
            check=False,
        )
        if proc.returncode > 1:
            log(f"stage 0b: pyosmium-up-to-date failed (exit {proc.returncode}); "
                "building from whatever was applied")
            break
        passes += 1
        moved_to = planet_timestamp(planet)
        if proc.returncode == 0:
            cursor = moved_to
            break
        if moved_to == cursor:
            log(f"stage 0b: pass {attempt} returned 1 without advancing the snapshot "
                f"({cursor or 'unknown'}); stopping rather than retrying")
            break
        log(f"stage 0b: pass {attempt} advanced to {moved_to or '?'}; more diffs remain")
        cursor = moved_to
    else:
        log("stage 0b: stopped after 24 passes; building from what was applied")

    after = planet_timestamp(planet)
    if after == before:
        log(f"stage 0b: already current ({after or 'unknown'}), nothing applied")
        return False
    log(f"stage 0b: planet advanced {before or '?'} → {after or '?'}")
    return True


def planet_timestamp(planet: Path) -> str | None:
    """
    The PBF's own replication timestamp — the honest 'as of' for every count.

    Every number this build produces is a snapshot, and the pages say so. Reading the
    clock at build time instead would attribute a months-old planet dump to today.

    Read through pyosmium rather than by shelling out to `osmium fileinfo`. That is not
    a style preference: `stage_update_planet` calls this after every pass to decide
    whether the file actually advanced, and that guard is what stops a failing update
    from re-downloading diffs twenty-four times. A guard that silently returns None
    whenever osmium-tool happens not to be installed is not a guard.
    """
    import osmium  # noqa: PLC0415 — a declared dependency; kept beside its use

    try:
        reader = osmium.io.Reader(str(planet), osmium.osm.osm_entity_bits.NOTHING)
    except Exception:
        return None
    try:
        value = reader.header().get("osmosis_replication_timestamp", "")
    finally:
        reader.close()
    return value.strip() or None


# ═══════════════════════════════════════════════════════════════════════════════
# Stage 1 — one pass over the planet
# ═══════════════════════════════════════════════════════════════════════════════


def stage_filter(planet: Path, work: Path, table: Table, force: bool) -> Path:
    """
    Cut the planet down to everything any feature layer could possibly want, once.

    This is the stage that decides whether the build takes three hours or a day. Every
    feature layer's `filter` is unioned into a single `osmium tags-filter` invocation,
    so the 85 GB file is read once and every later stage works against a ~4 GB
    intermediate. Running one tags-filter per layer would re-read the planet 35 times.

    The union is a superset of every layer, which is safe in exactly the way the build
    table's header describes: `where` narrows it back down per layer, and widening
    never loses a feature.

    Density layers are deliberately NOT in this union. Buildings and highways are the
    bulk of the planet; folding them in here would make the intermediate as large as
    the input and save nothing. They get their own pass in stage 4.
    """
    out = work / "interesting.osm.pbf"
    if out.exists() and not force:
        log(f"stage 1: {out.name} exists, skipping")
        return out

    expressions = sorted({expr for layer in table.feature_layers for expr in layer.filter})
    log(f"stage 1: one planet pass, {len(expressions)} filter expressions")
    # No `--index-type` here: tags-filter takes only -e/-i/-R/-t and rejects anything
    # else outright (see `export_layer`). It needs no node-location index either — it
    # matches on tags and pulls referenced objects by id, never by location.
    run([
        "osmium", "tags-filter", str(planet),
        *expressions,
        "--overwrite", "-o", str(out),
    ])
    return out


# ═══════════════════════════════════════════════════════════════════════════════
# Stage 2/3 — per-layer extract, export and convert
# ═══════════════════════════════════════════════════════════════════════════════


def export_config(work: Path, table: Table) -> Path:
    """
    The `osmium export -c` config. Written rather than passed as flags, because the
    flags do not exist.

    `include_tags`, the attribute prefix and the record-separator switch are NOT
    command-line options of `osmium export` — they are config-file keys only.
    (`--include-tags` and `--attributes-prefix` have never existed in osmium-tool;
    `--omit-rs` was removed in 1.15.0.) Passing them aborts the run on the first
    invocation, and simply dropping them is worse than passing them: the export then
    succeeds while writing something the client cannot read.

    `attributes` is the load-bearing part. `--add-unique-id=type_id` puts the identity
    in the GeoJSON *Feature-level* `"id"` member, which is not a property — so
    `feature.properties.osm_id` would be undefined, `splitOsmId` would return null, and
    `featuresToPois` would `continue` on every single feature: zero POIs, no error
    anywhere. Naming `id` and `type` as attributes puts them in `properties` instead,
    where the client actually looks. The names are given explicitly so nothing carries
    osmium's default `@` prefix, which is not a portable column name — it has to survive
    an OGR SQL `-where` clause and a FlatGeobuf column header, and it is
    quoting-sensitive in both.

    Pinning `include_tags` is what gives the stream a stable schema, which is what lets
    ogr2ogr write a FlatGeobuf without buffering the whole layer to discover fields —
    and without it every stray tag in OSM becomes a column.
    """
    config = {
        "attributes": {"type": "osm_type", "id": "osm_id"},
        "include_tags": list(table.include_tags),
        "format_options": {"print_record_separator": False},
    }
    path = work / "export-config.json"
    path.write_text(json.dumps(config, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def export_layer(source: Path, layer: Layer, work: Path, table: Table, force: bool) -> Path:
    """
    `osmium tags-filter` then `osmium export` → newline-delimited GeoJSON.

    Identity travels as two columns, `osm_type` ("node"/"way"/"relation") and `osm_id`
    (an integer), which the client recombines. That pair is what the node-inside-area
    dedup, every tie-break sort and every provenance row key off; an export without it
    renumbers features arbitrarily and all three break at once.

    Note `--index-type` appears on `osmium export` and NOT on `osmium tags-filter`:
    tags-filter takes only `-e/-i/-R/-t` and rejects anything else outright.
    """
    cut = work / f"{layer.key}.osm.pbf"
    geojson = work / f"{layer.key}.geojsonl"
    if geojson.exists() and not force:
        log(f"stage 2: {geojson.name} exists, skipping")
        return geojson

    run([
        "osmium", "tags-filter", str(source), *layer.filter,
        "--overwrite", "-o", str(cut),
    ])
    run([
        "osmium", "export", str(cut),
        "--index-type", OSMIUM_INDEX,
        "--config", str(export_config(work, table)),
        # PER LAYER, and that is the double-emit fix (DESIGN.md §Phase 0). osmium exports
        # a closed way once per requested interpretation, so asking every layer for all
        # three types wrote every closed way twice — polygon plus zero-area linestring
        # — inflating counts up to 2× and planting a second POI at a different
        # coordinate. An area layer asks for `point,polygon` and the linestring reading
        # is never produced; the genuinely mixed layers keep `linestring` and drop the
        # duplicates in `apply_geometry_dedup` instead.
        f"--geometry-types={layer.geometry}",
        "-f", "geojsonseq",
        "--overwrite", "-o", str(geojson),
    ])
    cut.unlink(missing_ok=True)
    return geojson


def iter_features(geojson: Path):
    """Parsed features from a GeoJSONSeq stream, tolerating the RFC 7464 separator."""
    with geojson.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line.startswith("\x1e"):
                line = line[1:].strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def apply_post_filter(geojson: Path, layer: Layer) -> Path:
    """
    Run a Python predicate over the GeoJSONSeq stream.

    Only `high_speed_rail` uses this. It runs before `where` rather than after, which
    is sound because the two are conjunctive — both must hold — so the order in which
    they are applied cannot change the result set.
    """
    if layer.post is None:
        return geojson
    predicate = POST_FILTERS[layer.post]
    filtered = geojson.with_suffix(".post.geojsonl")
    kept = dropped = 0
    with geojson.open("r", encoding="utf-8") as src, \
            filtered.open("w", encoding="utf-8") as dst:
        for line in src:
            line = line.strip()
            # osmium emits RS-prefixed GeoJSON text sequences; tolerate both forms.
            if not line or line == "\x1e":
                continue
            if line.startswith("\x1e"):
                line = line[1:]
            try:
                feature = json.loads(line)
            except json.JSONDecodeError:
                dropped += 1
                continue
            if predicate(feature.get("properties") or {}):
                dst.write(json.dumps(feature, separators=(",", ":")) + "\n")
                kept += 1
            else:
                dropped += 1
    log(f"stage 2: post-filter {layer.post} on {layer.key}: kept {kept}, dropped {dropped}")
    geojson.unlink(missing_ok=True)
    return filtered


def apply_geometry_dedup(geojson: Path, layer: Layer) -> Path:
    """
    Drop a way's linestring reading when the same way was also exported as a polygon.

    This is the half of the double-emit fix (DESIGN.md §Phase 0) that per-layer
    `--geometry-types` cannot cover: a genuinely mixed layer (`water` holds lake
    polygons AND river linestrings) must keep `linestring` in its export, and osmium
    then writes every CLOSED way twice — its polygon, plus the same ring re-read as a
    zero-area linestring. The polygon is the real feature; the linestring copy is what
    inflated counts up to 2× and put a second POI at a different coordinate.

    TWO PASSES, NECESSARILY. osmium emits every linestring before any polygon (ways
    are exported in the way pass, areas in the area pass that follows), so a streaming
    "have I seen this id as a polygon yet" always answers no. The first pass collects
    the way-ids that appear as polygons; the second drops those ways' linestrings.
    The id set is ints only — ~75 MB per million closed ways, far under the flat
    2.4 GB the feature stages already hold.

    Only ways can be double-emitted: nodes have one reading and relations export as
    multipolygons only, so both pass through untouched.
    """
    if not layer.dedup:
        return geojson

    polygon_ways: set[int] = set()
    for feature in iter_features(geojson):
        geometry = feature.get("geometry") or {}
        if geometry.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        props = feature.get("properties") or {}
        if props.get("osm_type") != "way":
            continue
        try:
            polygon_ways.add(int(props.get("osm_id")))
        except (TypeError, ValueError):
            continue

    deduped = geojson.with_suffix(".dedup.geojsonl")
    kept = dropped = 0
    with deduped.open("w", encoding="utf-8") as dst:
        for feature in iter_features(geojson):
            geometry = feature.get("geometry") or {}
            props = feature.get("properties") or {}
            if geometry.get("type") in ("LineString", "MultiLineString") \
                    and props.get("osm_type") == "way":
                try:
                    way_id = int(props.get("osm_id"))
                except (TypeError, ValueError):
                    way_id = None
                if way_id is not None and way_id in polygon_ways:
                    dropped += 1
                    continue
            dst.write(json.dumps(feature, separators=(",", ":")) + "\n")
            kept += 1
    log(f"stage 2: geometry dedup on {layer.key}: kept {kept}, "
        f"dropped {dropped} closed-way linestring duplicates")
    geojson.unlink(missing_ok=True)
    return deduped


def geometry_envelope(coords) -> tuple[float, float, float, float] | None:
    """
    (minX, minY, maxX, maxY) over a GeoJSON coordinates array of any nesting depth.

    Computed from the same JSON-parsed float64s GDAL would parse from the same text,
    so the envelope written back out (json.dumps uses repr, the shortest round-trip
    form) re-parses to bit-identical doubles — which is what makes the R1 diagonal's
    R-tree exactly equal to the original feature's.
    """
    if not isinstance(coords, list) or not coords:
        return None
    if isinstance(coords[0], (int, float)):
        if len(coords) < 2:
            return None
        x, y = float(coords[0]), float(coords[1])
        return (x, y, x, y)
    box = None
    for part in coords:
        sub = geometry_envelope(part)
        if sub is None:
            continue
        box = sub if box is None else (
            min(box[0], sub[0]), min(box[1], sub[1]),
            max(box[2], sub[2]), max(box[3], sub[3]),
        )
    return box


def diagonalize_layer(filtered: Path, layer: Layer, work: Path) -> Path:
    """
    Reduce a count-only layer to 2-point bbox-diagonal linestrings (DESIGN.md §Phase 1 R1).

    The curse predicate layers are never drawn and never read feature-by-feature: the
    client calls `worldCount`, which walks the R-tree and reads zero feature bytes. All
    the index stores is each feature's envelope — and a diagonal from `(minX, minY)` to
    `(maxX, maxY)` HAS exactly that envelope. So every R-tree node bbox and every
    search result is bit-identical to the full-geometry layer's, at a fraction of the
    bytes. Properties are dropped entirely; there is nothing left that reads them.

    This pass also owns the layer's double-emit dedup: it keeps the FIRST record per
    `(osm_type, osm_id)`, which collapses a closed way's polygon+linestring pair into
    one diagonal (both readings of one ring have the same envelope, so which survives
    is irrelevant). Runs AFTER the `where` filter, which needs the original properties.
    """
    diag = filtered.with_suffix(".diag.geojsonl")
    seen: set[tuple[str, int]] = set()
    kept = dropped = 0
    with diag.open("w", encoding="utf-8") as dst:
        for feature in iter_features(filtered):
            props = feature.get("properties") or {}
            identity: tuple[str, int] | None = None
            raw_type, raw_id = props.get("osm_type"), props.get("osm_id")
            if raw_type is not None and raw_id is not None:
                try:
                    identity = (str(raw_type), int(raw_id))
                except (TypeError, ValueError):
                    identity = None
            if identity is not None:
                if identity in seen:
                    dropped += 1
                    continue
                seen.add(identity)
            envelope = geometry_envelope((feature.get("geometry") or {}).get("coordinates"))
            if envelope is None:
                dropped += 1
                continue
            min_x, min_y, max_x, max_y = envelope
            record = {
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[min_x, min_y], [max_x, max_y]],
                },
                "properties": {},
            }
            dst.write(json.dumps(record, separators=(",", ":")) + "\n")
            kept += 1
    log(f"stage 2: diagonalized {layer.key}: {kept} envelopes, "
        f"dropped {dropped} duplicates/empties")
    filtered.unlink(missing_ok=True)
    return diag


def has_features(geojson: Path) -> bool:
    """
    Does this GeoJSONSeq file contain at least one feature?

    Not a size check. `osmium export` writes a trailing newline even when it exported
    nothing, so a featureless file is 1 byte rather than 0, and `apply_post_filter`
    that dropped everything leaves 0 — both must read as empty. Records may also carry
    the RFC 7464 record separator (\\x1e), alone or as a line prefix, so a line is only
    a feature once the separator and surrounding whitespace are stripped.
    """
    with geojson.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip().strip("\x1e").strip():
                return True
    return False


def geojson_fields(geojson: Path) -> list[str]:
    """
    The property columns actually present in a GeoJSONSeq file, via `ogrinfo`.

    Needed because `ogr2ogr -select` HARD-FAILS (exit 1) on a field the source does
    not carry, and osmium only writes the `include_tags` a layer's features actually
    have — a water layer has no `cuisine` column to keep. The runtime column list is
    intersected with this before it becomes a `-select`.
    """
    out = subprocess.run(
        ["ogrinfo", "-so", "-al", str(geojson)],
        check=True, capture_output=True, text=True,
    ).stdout
    fields = []
    for line in out.splitlines():
        # `name:en: String (0.0)` — the field name itself can contain colons, so match
        # the type keyword and width suffix rather than splitting on the first colon.
        match = re.match(
            r"^(.+?): (?:String|Integer64|Integer|Real|Date|Time|DateTime|Binary"
            r"|StringList|Integer64List|IntegerList|RealList)\s*\([\d:. ]+\)$",
            line,
        )
        if match:
            fields.append(match.group(1))
    return fields


# ── the `where` guard: a column the source lacks is NULL, not an error ───────
#
# `ogr2ogr -where` REJECTS a field the source layer does not carry — the same trap
# `geojson_fields` already disarms for `-select`. It bites in two different ways and
# the second is the dangerous one, because both calls below pass `-skipfailures`:
#
#     ogr2ogr ... -where "landuse IS NULL"                  → exit 1, build aborts
#     ogr2ogr ... -where "landuse IS NULL" -skipfailures    → exit 0, and
#         "ERROR 1: SetAttributeFilter(...) failed" on stderr while EVERY FEATURE IS
#         COPIED THROUGH UNFILTERED. The layer builds, the manifest lists it, the
#         counts are wrong, and nothing downstream can tell.
#
# So this is not only an availability fix. Verified against GDAL 3.12.
#
# It happens because `osmium export` only writes the `include_tags` a layer's features
# actually HAVE. `animal_delta`'s `where` references `landuse` purely to exclude the
# features `green` already counted; on an extract where nothing in that layer's cut
# carries `landuse`, the column is absent and the clause explodes — on an input where
# the clause has nothing to do.
#
# The fix is not to drop the clause: dropping `landuse IS NULL OR ...` is fine, dropping
# `landuse IS NULL` alone would be a silent semantic change. An absent column is NULL
# for EVERY feature, so each predicate over it has a known constant value, and the
# expression is constant-folded with those substituted. That is exactly the answer
# ogr2ogr would have given had osmium written the column full of nulls.

_WHERE_TOKEN = re.compile(
    r"""\s+
      | (?P<quoted>"(?:[^"]|"")*")
      | (?P<literal>'(?:[^']|'')*')
      | (?P<number>\d+(?:\.\d+)?)
      | (?P<op><>|!=|<=|>=|[=<>])
      | (?P<punct>[(),])
      | (?P<word>[A-Za-z_][A-Za-z_0-9]*)
    """,
    re.VERBOSE,
)

# Words that are grammar rather than a column reference. Anything else spelled like an
# identifier IS a column, which is the conservative direction: an unknown keyword would
# be treated as a missing column and fold the clause away, so the set is kept complete
# for the SQL the build table is allowed to contain and `rewrite_where` refuses to guess
# beyond it (see the `NOT` guard below).
_SQL_KEYWORDS = frozenset({
    "AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE", "ILIKE", "BETWEEN", "ESCAPE",
    "TRUE", "FALSE",
})


def _where_tokens(where: str) -> list[tuple[str, str, int, int]]:
    """(kind, text, start, end) for every token, whitespace dropped."""
    tokens: list[tuple[str, str, int, int]] = []
    pos = 0
    while pos < len(where):
        match = _WHERE_TOKEN.match(where, pos)
        if match is None:
            raise SystemExit(
                f"build table `where` cannot be parsed at offset {pos}: "
                f"{where[pos:pos + 24]!r} — the guard in `rewrite_where` only "
                "understands the SQL subset categories.json is allowed to use")
        pos = match.end()
        if match.lastgroup is not None:
            tokens.append((match.lastgroup, match.group(), match.start(), match.end()))
    return tokens


def _parse_where(tokens: list[tuple[str, str, int, int]]) -> tuple:
    """
    Tokens → a tree of ('or'|'and', [children]) / ('not', child) / ('paren', child) /
    ('atom', tokens, start, end).

    An `atom` is a whole comparison — `leisure IN ('park', 'garden')` — kept as its
    ORIGINAL source slice so a surviving clause is re-emitted byte for byte. Only AND,
    OR, NOT and parentheses are structure; everything between them is opaque.
    """
    pos = 0

    def peek():
        return tokens[pos] if pos < len(tokens) else None

    def word_is(token, text) -> bool:
        return token is not None and token[0] == "word" and token[1].upper() == text

    def parse_or():
        nonlocal pos
        nodes = [parse_and()]
        while word_is(peek(), "OR"):
            pos += 1
            nodes.append(parse_and())
        return nodes[0] if len(nodes) == 1 else ("or", nodes)

    def parse_and():
        nonlocal pos
        nodes = [parse_not()]
        while word_is(peek(), "AND"):
            pos += 1
            nodes.append(parse_not())
        return nodes[0] if len(nodes) == 1 else ("and", nodes)

    def parse_not():
        nonlocal pos
        if word_is(peek(), "NOT"):
            pos += 1
            return ("not", parse_not())
        return parse_primary()

    def parse_primary():
        nonlocal pos
        token = peek()
        if token is None:
            raise SystemExit("build table `where` ends unexpectedly")
        if token[0] == "punct" and token[1] == "(":
            pos += 1
            inner = parse_or()
            closing = peek()
            if closing is None or closing[1] != ")":
                raise SystemExit("build table `where` has an unbalanced '('")
            pos += 1
            return ("paren", inner)
        return parse_atom()

    def parse_atom():
        nonlocal pos
        start = tokens[pos][2]
        end = start
        depth = 0
        atom: list[tuple[str, str, int, int]] = []
        while pos < len(tokens):
            kind, text, _, token_end = tokens[pos]
            if depth == 0 and kind == "word" and text.upper() in ("AND", "OR"):
                break
            if depth == 0 and kind == "punct" and text == ")":
                break
            if kind == "punct" and text == "(":
                depth += 1
            elif kind == "punct" and text == ")":
                depth -= 1
            atom.append(tokens[pos])
            end = token_end
            pos += 1
        if not atom:
            raise SystemExit("build table `where` has an empty term")
        return ("atom", atom, start, end)

    tree = parse_or()
    if pos != len(tokens):
        raise SystemExit(
            f"build table `where` has trailing tokens from offset {tokens[pos][2]}")
    return tree


def _atom_columns(atom: list[tuple[str, str, int, int]]) -> list[str]:
    """Column names an atom references — bare words that are not SQL keywords, plus
    every double-quoted identifier (`"natural"`, which HAS to be quoted)."""
    columns = []
    for kind, text, _, _ in atom:
        if kind == "word" and text.upper() not in _SQL_KEYWORDS:
            columns.append(text)
        elif kind == "quoted":
            columns.append(text[1:-1].replace('""', '"'))
    return columns


def _atom_null_value(atom: list[tuple[str, str, int, int]]) -> bool:
    """
    What an atom evaluates to once its column is known to be NULL for every feature.

    `col IS NULL` is TRUE. Everything else — `=`, `<>`, `IN`, `NOT IN`, `LIKE`,
    `IS NOT NULL` — is either FALSE or SQL's UNKNOWN, and a WHERE clause discards both,
    so they collapse to the same answer. That collapse is only sound while no prefix
    `NOT` can flip an UNKNOWN back to TRUE; `rewrite_where` refuses to fold at all when
    one is present, rather than reasoning about it.
    """
    shape = [text.upper() if kind == "word" else "#" for kind, text, _, _ in atom]
    return shape[1:] == ["IS", "NULL"]


def _has_prefix_not(node) -> bool:
    kind = node[0]
    if kind == "not":
        return True
    if kind == "paren":
        return _has_prefix_not(node[1])
    if kind in ("and", "or"):
        return any(_has_prefix_not(child) for child in node[1])
    return False


def rewrite_where(where: str, present, key: str = "") -> str | None:
    """
    `where` with every reference to a column the source lacks constant-folded away.

    Returns the SQL to hand `-where`; `""` when the clause became unconditionally true
    (pass no `-where` at all); or `None` when it can never match, which means the layer
    is legitimately empty for this input.

    The rewrite is semantics-preserving, not a best effort. `animal_delta` on an
    extract with no `landuse` anywhere goes from

        (leisure IN ('park','nature_reserve') OR ("natural" = 'water' AND name IS NOT
         NULL)) AND (landuse IS NULL OR landuse NOT IN ('forest','grass', ...))

    to just the first half — because with `landuse` NULL for every feature the second
    half IS true for every feature. Before this, that input shipped the layer with no
    attribute filter applied at all.

    A clause with nothing to fold is returned BYTE-IDENTICAL: surviving terms are
    re-emitted as their original source slices, never re-serialised from the parse.
    """
    present_lower = {str(column).lower() for column in present}
    tokens = _where_tokens(where)
    tree = _parse_where(tokens)
    folded: set[str] = set()

    def fold(node) -> tuple[bool | None, str | None]:
        """(constant, None) once a subtree is decided, or (None, sql) when it survives."""
        kind = node[0]
        if kind == "atom":
            missing = [c for c in _atom_columns(node[1])
                       if c.lower() not in present_lower]
            if not missing:
                return None, where[node[2]:node[3]]
            folded.update(missing)
            return _atom_null_value(node[1]), None
        if kind == "paren":
            constant, sql = fold(node[1])
            return (constant, None) if constant is not None else (None, f"({sql})")
        if kind == "not":
            constant, sql = fold(node[1])
            return (not constant, None) if constant is not None else (None, f"NOT {sql}")
        constants: list[bool] = []
        survivors: list[str] = []
        for child in node[1]:
            constant, sql = fold(child)
            (constants if constant is not None else survivors).append(
                constant if constant is not None else sql)
        if kind == "and":
            if any(c is False for c in constants):
                return False, None
            return (True, None) if not survivors else (None, " AND ".join(survivors))
        if any(c is True for c in constants):
            return True, None
        return (False, None) if not survivors else (None, " OR ".join(survivors))

    missing_anywhere = [c for c in _atom_columns(tokens)
                        if c.lower() not in present_lower]
    if missing_anywhere and _has_prefix_not(tree):
        # Never reached by the shipped table, and it must stay that way: under a prefix
        # NOT, SQL's UNKNOWN and FALSE stop agreeing and the fold above would silently
        # invert a clause. Fail loudly instead of guessing.
        raise SystemExit(
            f"layer {key}: `where` mixes a prefix NOT with the absent column(s) "
            f"{sorted(set(missing_anywhere))}; the NULL fold is only proven sound "
            "without one. Rewrite the clause or extend `rewrite_where`.")

    constant, sql = fold(tree)
    if folded:
        log(f"stage 3: {key}: {sorted(folded)} absent from the export schema — "
            f"folded to {'always true' if constant is True else 'always false' if constant is False else sql!r}")
    if constant is True:
        return ""
    if constant is False:
        return None
    return sql


def convert_layer(geojson: Path, layer: Layer, out_dir: Path, work: Path,
                  table: Table, force: bool) -> Path | None:
    """
    GeoJSONSeq → FlatGeobuf, applying `where` and building the spatial index.

    `SPATIAL_INDEX=YES` is the whole architecture in one creation option: it is the
    packed Hilbert R-tree the browser walks with Range requests. Without it the client
    must download the file to find anything in it.

    `-select` projects away the build-only columns (DESIGN.md §Phase 1 R5): the layer
    ships only what the client reads at runtime plus the `(osm_type, osm_id)` identity
    the Phase-3 merge dedups on. `-where` still sees every column — GDAL applies the
    attribute filter against the SOURCE layer, before the field map — so a `where` on
    `leisure` keeps working while `leisure` never reaches the output.

    `-where` is not passed verbatim either: `rewrite_where` folds out any reference to a
    column this export does not carry, because ogr2ogr rejects the whole attribute
    filter over one absent field — and under `-skipfailures` it does so while still
    exiting 0 and copying every feature through unfiltered.

    A `count_only` layer takes a different road: `where` must run while the properties
    still exist, so it is applied in its own GeoJSONSeq→GeoJSONSeq pass, then
    `diagonalize_layer` reduces what survives to bbox diagonals with no properties at
    all, and the FlatGeobuf is written from that with no `-where` and no `-select`.

    Returns None when the layer has no features. That is a real state, not an error:
    a regional extract legitimately contains no `high_speed_rail` and no `coastline`,
    and the GeoJSONSeq driver cannot open a file with no records — `ogr2ogr` fails with
    "Unable to open datasource" rather than writing an empty layer. Skipping keeps the key out of the
    manifest, which is the case `osm/geodata.js` already handles: it marks the category
    `partial` and degrades it alone. Writing a feature-less .fgb instead would claim
    the build had looked and found nothing, which is a different and stronger claim.
    """
    fgb = out_dir / f"{layer.key}.fgb"
    if fgb.exists() and not force:
        log(f"stage 3: {fgb.name} exists, skipping")
        return fgb
    if not has_features(geojson):
        log(f"stage 3: {layer.key} has no features, omitting from the manifest")
        return None

    # One schema probe, hoisted above the count_only branch so both roads share it:
    # `-select` is intersected with it, and `-where` is constant-folded against it.
    # Either would otherwise trip over a column osmium never wrote because no feature in
    # this layer's cut carried the tag. It costs a count-only layer one extra `ogrinfo`
    # pass over its GeoJSONSeq, which the feature layers were already paying.
    present = geojson_fields(geojson)
    where = rewrite_where(layer.where, present, key=layer.key)
    if where is None:
        log(f"stage 3: {layer.key}'s `where` cannot match anything this export carries, "
            "omitting from the manifest")
        return None
    where_args = ["-where", where] if where else []

    if layer.count_only:
        filtered = work / f"{layer.key}.where.geojsonl"
        run([
            "ogr2ogr", "-f", "GeoJSONSeq", str(filtered), str(geojson),
            *where_args,
            "-nln", layer.key,
            "-skipfailures",
        ])
        if not has_features(filtered):
            filtered.unlink(missing_ok=True)
            log(f"stage 3: {layer.key} has no features after `where`, "
                "omitting from the manifest")
            return None
        diag = diagonalize_layer(filtered, layer, work)
        if not has_features(diag):
            diag.unlink(missing_ok=True)
            log(f"stage 3: {layer.key} has no features after diagonalizing, "
                "omitting from the manifest")
            return None
        run([
            "ogr2ogr", "-f", "FlatGeobuf", str(fgb), str(diag),
            "-nln", layer.key,
            "-lco", "SPATIAL_INDEX=YES",
            "-nlt", "LINESTRING",
            "-skipfailures",
        ])
        diag.unlink(missing_ok=True)
        return fgb

    select = [column for column in table.runtime_columns if column in present]
    run([
        "ogr2ogr", "-f", "FlatGeobuf", str(fgb), str(geojson),
        *where_args,
        "-select", ",".join(select),
        "-nln", layer.key,
        "-lco", "SPATIAL_INDEX=YES",
        # Mixed node/way/relation layers hold points, lines and polygons at once.
        "-nlt", "GEOMETRY",
        "-skipfailures",
    ])
    return fgb


def build_layer(source: Path, layer: Layer, work: Path, out_dir: Path,
                table: Table, force: bool) -> Path | None:
    """One feature layer, source PBF → published .fgb (or None when it is empty)."""
    fgb = out_dir / f"{layer.key}.fgb"
    if fgb.exists() and not force:
        # Resuming: the .fgb is the stage's real output, so its existence short-circuits
        # the whole chain — re-running the export only to skip the conversion would
        # re-read the intermediate for nothing.
        log(f"stage 3: {fgb.name} exists, skipping")
        return fgb
    geojson = export_layer(source, layer, work, table, force)
    geojson = apply_post_filter(geojson, layer)
    geojson = apply_geometry_dedup(geojson, layer)
    result = convert_layer(geojson, layer, out_dir, work, table, force)
    geojson.unlink(missing_ok=True)
    return result


def feature_count(fgb: Path) -> int:
    """
    Read the layer's feature count back out of the written file.

    Deliberately parsed from `ogrinfo -so -al` text rather than `-json`: the JSON
    output arrived in GDAL 3.7 and `MIN_GDAL` is 3.5, so asking for it would break the
    build on exactly the versions this script claims to support.
    """
    out = subprocess.run(
        ["ogrinfo", "-so", "-al", str(fgb)],
        check=True, capture_output=True, text=True,
    ).stdout
    match = re.search(r"^Feature Count:\s*(\d+)", out, re.MULTILINE)
    return int(match.group(1)) if match else 0


# ═══════════════════════════════════════════════════════════════════════════════
# Stage 4 — the density grid
# ═══════════════════════════════════════════════════════════════════════════════


def load_clip_region(clip_region: Path):
    """GeoJSON (Feature / FeatureCollection / bare geometry) -> prepared shapely geom.

    The file is a cover.py `cover-geometries/` output: one shard's ASSIGNED DISJOINT
    polygon. `shapely.prepare` builds the predicate index in place so the per-way
    `contains_xy` test below is a prepared-geometry hit, not a fresh scan.
    """
    import shapely  # noqa: PLC0415 — uv installs it; keep the import next to its use
    from shapely.geometry import shape  # noqa: PLC0415

    data = json.loads(clip_region.read_text(encoding="utf-8"))
    if data.get("type") == "FeatureCollection":
        geoms = [shape(f["geometry"]) for f in data["features"]]
        geom = geoms[0] if len(geoms) == 1 else shapely.union_all(geoms)
    elif data.get("type") == "Feature":
        geom = shape(data["geometry"])
    else:
        geom = shape(data)
    if not geom.is_valid:
        geom = geom.buffer(0)
    shapely.prepare(geom)
    return geom


def stage_density(planet: Path, work: Path, out_dir: Path, table: Table,
                  force: bool, clip_region: Path | None = None) -> Path | None:
    """
    One pyosmium pass over the planet, binning six dense categories into a sparse grid.

    building, street, car_street, footpath, bridge and tree are counts rather than
    icons — nothing downstream draws them, everything downstream tallies them. Their
    planet-wide geometry is tens of gigabytes to answer questions of the form "how many
    buildings are in this circle", so they never ship as features. Instead each is
    attributed to exactly one `cell_deg` cell and the cell counts ship.

    Attributing each way to ONE cell — the cell of its first node — is what keeps
    map-wide totals exact: a way counted in one cell and only one cannot be
    double-counted by a bbox sum. It is also what makes per-zone figures approximate,
    since a long street belongs wholly to the cell where it starts. That trade is
    documented in categories.json's `_density_comment` and surfaced in provenance.

    `--clip-region` is the sharded-build half of that exactness rule (DESIGN.md
    §Phase 3): Geofabrik extracts overlap by design (buffered cutting polygons), so
    a shard build must count only what falls inside its ASSIGNED DISJOINT region
    (cover.py's `cover-geometries/<id>.geojson`) or every way in the overlap buffer
    is tallied by both neighbouring shards and merge.py's cell sums double-count.
    The test is on the way's FIRST NODE — the same point that picks the cell — and,
    for the node-based `tree` count, on the node's own location, which needs the
    identical clip for the identical reason. No --clip-region = unchanged behaviour.

    Output is a FlatGeobuf of POINTS at cell centres with one integer column per
    category, so the browser reads it with exactly the same Range-request client as
    every other layer.
    """
    fgb = out_dir / "density.fgb"
    # The skip-if-exists cache is only valid for the SAME --clip-region: a cached
    # grid was counted inside one polygon (or none), and reusing it under a
    # different clip would silently ship the wrong shard's tallies. The clip state
    # (sha256 of the region file, or "none") is recorded in a sidecar in the work
    # dir when the grid is built, and the skip only fires when it matches.
    clip_state = sha256_file(clip_region) if clip_region is not None else "none"
    clip_sidecar = work / "density.clip-state"
    if fgb.exists() and not force:
        recorded = (clip_sidecar.read_text(encoding="utf-8").strip()
                    if clip_sidecar.exists() else None)
        if recorded == clip_state:
            log(f"stage 4: {fgb.name} exists, skipping")
            return fgb
        log(f"stage 4: {fgb.name} exists but was built under a different "
            f"--clip-region state (recorded {recorded!r}, current "
            f"{clip_state!r}) — rebuilding")
    # Invalidate the sidecar BEFORE any rebuild work: if this run crashes midway
    # (e.g. during the final ogr2ogr, which writes the fgb in place), a surviving
    # sidecar would validate the corrupt grid for a later skip. Absent sidecar =
    # never skip. It is rewritten only after a fully successful build below.
    clip_sidecar.unlink(missing_ok=True)

    import osmium  # noqa: PLC0415 — uv installs it; keep the import next to its use

    if clip_region is not None:
        import shapely  # noqa: PLC0415 — uv installs it; declared in the header
        clip_geom = load_clip_region(clip_region)

        def inside(lon: float, lat: float) -> bool:
            # `contains_xy` EXCLUDES the boundary — and both neighbouring shards'
            # assigned polygons exclude it too, so a first node lying EXACTLY on a
            # shared border is counted by ZERO shards. The composition is therefore
            # at-most-once, not exactly-once. Accepted: it errs in the safe
            # direction (undercount, never the double-count the clip exists to
            # prevent) and an exact float hit on a full-precision boundary is
            # measure-zero in practice.
            return bool(shapely.contains_xy(clip_geom, lon, lat))
    else:
        inside = None

    cell_deg = table.cell_deg
    keys = [layer.key for layer in table.density_layers]

    # Predicates are written against raw OSM tags here rather than reusing the OGR SQL
    # `where` strings, because there is no SQL engine in this pass. The build table's
    # density `where` clauses are the specification; these must agree with them, and a
    # divergence is silent — so they are kept adjacent and minimal.
    car_values = {
        "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified",
        "residential", "living_street", "service", "motorway_link", "trunk_link",
        "primary_link", "secondary_link", "tertiary_link",
    }
    street_excluded = {
        "motorway", "motorway_link", "trunk_link", "construction", "proposed", "raceway",
    }
    foot_values = {"footway", "path", "pedestrian", "steps", "cycleway", "track"}

    class DensityHandler(osmium.SimpleHandler):
        def __init__(self) -> None:
            super().__init__()
            # cell -> [count per key]. Sparse: only populated cells are ever created,
            # which is what keeps a planet grid to tens of millions of cells rather
            # than the 2.6 billion a dense array would need.
            self.cells: dict[tuple[int, int], list[int]] = {}
            self.ways = 0
            self.nodes = 0
            self.clipped = 0

        def _bump(self, lat: float, lon: float, index: int) -> None:
            if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
                return
            cell = (int(lat // cell_deg), int(lon // cell_deg))
            row = self.cells.get(cell)
            if row is None:
                row = [0] * len(keys)
                self.cells[cell] = row
            row[index] += 1

        def node(self, n) -> None:
            if n.tags.get("natural") != "tree":
                return
            # Same clip as ways, on the node's own location: a tree in the extract's
            # overlap buffer would otherwise be counted by both neighbouring shards.
            if inside is not None and not inside(n.location.lon, n.location.lat):
                self.clipped += 1
                return
            self.nodes += 1
            self._bump(n.location.lat, n.location.lon, keys.index("tree"))

        def way(self, w) -> None:
            tags = w.tags
            highway = tags.get("highway")
            building = tags.get("building")
            bridge = tags.get("bridge")
            if highway is None and building is None and bridge is None:
                return
            try:
                first = w.nodes[0].location
                if not first.valid():
                    return
                lat, lon = first.lat, first.lon
            except (IndexError, osmium.InvalidLocationError):
                return
            # THE exactness rule under sharding: the way belongs to this shard iff
            # its FIRST NODE — the point that picks its one cell — is inside the
            # shard's assigned disjoint region. First node only; nothing else about
            # the way is tested, so the cost is one prepared point-in-polygon call
            # per candidate way.
            if inside is not None and not inside(lon, lat):
                self.clipped += 1
                return
            self.ways += 1

            if building is not None:
                self._bump(lat, lon, keys.index("building"))
            if highway is not None:
                if highway not in street_excluded:
                    self._bump(lat, lon, keys.index("street"))
                if highway in car_values \
                        and tags.get("motor_vehicle") != "no" \
                        and tags.get("access") != "no":
                    self._bump(lat, lon, keys.index("car_street"))
                if highway in foot_values:
                    self._bump(lat, lon, keys.index("footpath"))
            if bridge is not None and bridge != "no" \
                    and (highway is not None or tags.get("railway") is not None):
                self._bump(lat, lon, keys.index("bridge"))

    log(f"stage 4: density pass over the planet at {cell_deg}° cells"
        + (f", clipped to {clip_region.name}" if clip_region is not None else ""))
    handler = DensityHandler()
    handler.apply_file(str(planet), locations=True, idx=OSMIUM_INDEX)
    log(f"stage 4: {len(handler.cells)} populated cells "
        f"from {handler.ways} ways and {handler.nodes} nodes"
        + (f" ({handler.clipped} candidates outside the clip region dropped)"
           if clip_region is not None else ""))

    if not handler.cells:
        # Same contract as convert_layer: the GeoJSONSeq driver cannot open a file
        # with no records, and a key absent from the manifest is the degradation path
        # the client already handles. Only a fixture-sized extract can get here.
        log("stage 4: no populated cells, omitting density from the manifest")
        return None

    # Sorted so the intermediate is byte-stable for a given planet; FlatGeobuf reorders
    # into Hilbert order on write, but a reproducible input makes a diff meaningful.
    grid = work / "density.geojsonl"
    half = cell_deg / 2.0
    with grid.open("w", encoding="utf-8") as dst:
        for (row, col) in sorted(handler.cells):
            counts = handler.cells[(row, col)]
            feature = {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [
                        round(col * cell_deg + half, 7),
                        round(row * cell_deg + half, 7),
                    ],
                },
                # Zero-valued counts are OMITTED per cell (DESIGN.md §Phase 1 R4): the
                # client already reads an absent column as zero — `worldDensity` skips
                # zero and non-finite values on read (osm/worldfile.js), so absent and
                # 0 are indistinguishable by construction. A cell only exists because
                # some count is non-zero, so no feature ends up property-less.
                "properties": {
                    key: count for key, count in zip(keys, counts) if count != 0
                },
            }
            dst.write(json.dumps(feature, separators=(",", ":")) + "\n")

    run([
        "ogr2ogr", "-f", "FlatGeobuf", str(fgb), str(grid),
        "-nln", "density",
        "-lco", "SPATIAL_INDEX=YES",
        "-nlt", "POINT",
    ])
    grid.unlink(missing_ok=True)
    # Record which clip this grid was counted under, so the skip-if-exists cache
    # above can tell a reusable grid from a stale one.
    clip_sidecar.write_text(clip_state + "\n", encoding="utf-8")
    return fgb


# ═══════════════════════════════════════════════════════════════════════════════
# Stage 5 — the manifest
# ═══════════════════════════════════════════════════════════════════════════════


def stage_manifest(out_dir: Path, table: Table, planet_ts: str | None,
                   built: dict[str, Path], partial: bool = False) -> Path:
    """
    One small JSON the client fetches first.

    It exists so the browser can answer "is this category available, and how big is the
    file" without a HEAD request per layer, and so every page can print the planet
    snapshot date its counts came from. `osm/geodata.js` treats a category missing from
    the manifest as unavailable and degrades that category rather than erroring.

    `planet_ts` is captured by the caller BEFORE `--unlink-source` may have deleted
    the planet file. `partial: true` (the pinned client-side rule) marks a manifest
    whose layer table was truncated by SELECTION — `--only` / `--skip-density` — as
    opposed to a full build whose empty layers are legitimately absent; a shard build
    is partial by construction and must never be mistaken for a whole world.
    """
    manifest = {
        "version": 1,
        "cell_deg": table.cell_deg,
        "planet_timestamp": planet_ts,
        "layers": {},
    }
    if partial:
        manifest["partial"] = True
    for key, path in sorted(built.items()):
        manifest["layers"][key] = {
            "path": path.name,
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path),
            "features": feature_count(path),
        }
    target = out_dir / "manifest.json"
    target.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    log(f"stage 5: manifest with {len(built)} layers")
    return target


# ═══════════════════════════════════════════════════════════════════════════════
# Stage 6 — R2
# ═══════════════════════════════════════════════════════════════════════════════

# The bucket must answer Range requests cross-origin, and it must EXPOSE the range
# headers — a browser that cannot read Content-Range cannot walk the R2 index, and the
# failure looks like a corrupt file rather than a CORS error. Apply with:
#   wrangler r2 bucket cors set <bucket> --file tools/osm-world/r2-cors.json
# NOTE THE `rules` WRAPPER, and the nesting under `allowed`. S3 takes a bare array of
# AllowedOrigins/AllowedMethods; R2's own API does not, and `wrangler r2 bucket cors
# set` rejects the S3 shape with "must contain a 'rules' array". Emitting S3's shape
# made this file unappliable by the one command the docs give for applying it.
R2_CORS = {
    "rules": [
        {
            "allowed": {
                "origins": ["*"],
                "methods": ["GET", "HEAD"],
                "headers": ["range", "if-match"],
            },
            "exposeHeaders": ["content-length", "content-range", "etag"],
            "maxAgeSeconds": 86400,
        }
    ]
}


R2_ENV = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")


def check_upload_env() -> None:
    """
    The four `R2_*` variables `stage_upload` needs, checked as a PREFLIGHT.

    Stage 6 is the last thing that runs, so checking there means an unset variable
    surfaces only once every layer is already built — a minute for a density shard,
    an hour for a coarse feature shard like africa, and none of it survives, because
    CI's retry is a full re-download and rebuild. It costs nothing to ask first.

    Presence is all this can prove. A variable that is *set but wrong* — a rotated
    secret, a token without write scope, a typo'd bucket — is still only discovered
    when boto3 talks to the API in stage 6. Proving otherwise means a live HeadBucket
    at preflight, which trades this failure mode for a worse one: a transient network
    blip would then kill a build that was going to succeed.
    """
    missing = [name for name in R2_ENV if not os.environ.get(name)]
    if missing:
        raise SystemExit(f"--upload needs {', '.join(missing)} in the environment")


def r2_client():
    """
    The boto3 S3 client for R2, from the four `R2_*` environment variables.

    Split out of `stage_upload` so `merge.py` can reuse THE SAME uploader (DESIGN.md
    §Phase 6, gap B4) instead of growing a second aws-cli code path with its own
    ContentType/CacheControl conventions to drift.
    """
    import boto3  # noqa: PLC0415 — uv installs it; keep the import next to its use

    # Already checked at preflight when main() parsed --upload; repeated so the
    # client is correct on its own terms rather than by caller convention.
    check_upload_env()

    account = os.environ["R2_ACCOUNT_ID"]
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def r2_upload(client, path: Path, key: str) -> None:
    """
    Upload ONE file with the pinned ContentType/CacheControl rules.

    `.json` is mutable (the manifest, sidecars) and gets `max-age=300`; everything
    else is immutable per build — shard layer files are replaced wholesale on a
    rebuild and the merged world's layers are content-addressed — and gets a year.
    Uploads are multipart by default in boto3, which matters because the density
    grid is comfortably over the 5 GB single-PUT ceiling.
    """
    content_type = (
        "application/json" if path.suffix == ".json" else "application/octet-stream"
    )
    client.upload_file(
        str(path), os.environ["R2_BUCKET"], key,
        ExtraArgs={
            "ContentType": content_type,
            # The files are immutable per build; the manifest is what changes.
            "CacheControl": (
                "public, max-age=300" if path.suffix == ".json"
                else "public, max-age=31536000, immutable"
            ),
        },
    )


def stage_upload(out_dir: Path, prefix: str) -> None:
    """
    Publish to R2 over the S3-compatible API.

    Credentials come from the environment, never from a file in the repo:

        R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
    """
    client = r2_client()
    bucket = os.environ["R2_BUCKET"]

    cors_path = HERE / "r2-cors.json"
    cors_path.write_text(json.dumps(R2_CORS, indent=2) + "\n", encoding="utf-8")

    # MANIFEST LAST, ALWAYS. It is the only mutable object and the only thing that
    # flips a build live, so every layer it names must already be readable when it
    # lands. `sorted(out_dir.iterdir())` put manifest.json 22nd of 38 — alphabetically
    # ahead of pitch, platform, rail_station, restaurant, shop, water and ten more —
    # so for the length of those uploads the published manifest pointed at objects
    # that did not exist yet, and a client arriving in that window got a 404 on a
    # layer the manifest promised. Layers first, in any order; manifest strictly after.
    everything = sorted(p for p in out_dir.iterdir() if p.suffix in (".fgb", ".json"))
    layers_first = [p for p in everything if p.name != "manifest.json"]
    manifest = [p for p in everything if p.name == "manifest.json"]
    for path in layers_first + manifest:
        key = f"{prefix.strip('/')}/{path.name}" if prefix else path.name
        log(f"stage 6: uploading {path.name} ({path.stat().st_size / 1e6:.1f} MB) → {key}")
        r2_upload(client, path, key)
    log(f"stage 6: done — remember to apply CORS: "
        f"wrangler r2 bucket cors set {bucket} --file {cors_path}")


# ═══════════════════════════════════════════════════════════════════════════════
# Entry point
# ═══════════════════════════════════════════════════════════════════════════════


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build the global OSM FlatGeobuf world files and publish to R2.",
    )
    parser.add_argument("--planet", default=DEFAULT_PLANET, type=Path,
                        help="planet.osm.pbf, or any .osm.pbf extract. Downloaded if "
                             f"absent (default: {DEFAULT_PLANET})")
    parser.add_argument("--planet-url", default=None,
                        help="download from this URL instead of the built-in mirror list")
    parser.add_argument("--no-fetch", action="store_true",
                        help="fail if --planet is missing rather than downloading it")
    parser.add_argument("--skip-md5", action="store_true",
                        help="skip checksum verification of a freshly downloaded planet")
    parser.add_argument("--no-update", action="store_true",
                        help="do not apply replication diffs to an existing planet file")
    parser.add_argument("--out", default=Path("build/world"), type=Path,
                        help="output directory for the .fgb files and manifest.json")
    parser.add_argument("--work", default=None, type=Path,
                        help="scratch directory for intermediates (default: <out>/work)")
    parser.add_argument("--only", default=None,
                        help="comma-separated layer keys to build (default: all)")
    parser.add_argument("--skip-density", action="store_true",
                        help="skip the second planet pass that builds the density grid")
    parser.add_argument("--clip-region", default=None, type=Path,
                        help="GeoJSON polygon (a cover.py cover-geometries/ file): "
                             "stage 4 counts only ways whose FIRST NODE — and tree "
                             "nodes whose own location — falls inside it. Required "
                             "for sharded density builds (the extract overlaps its "
                             "neighbours; without the clip the merge double-counts). "
                             "Omit for unchanged whole-extract behaviour")
    parser.add_argument("--unlink-source", action="store_true",
                        help="delete the --planet file as soon as stage 1's filtered "
                             "intermediate exists (runner-disk headroom; DESIGN.md "
                             "§Phase 4). Refused when the density stage will run — "
                             "stage 4 is the only later reader of the raw extract")
    parser.add_argument("--force", action="store_true",
                        help="rebuild stages whose output already exists")
    parser.add_argument("--upload", action="store_true", help="publish to R2 when done")
    parser.add_argument("--prefix", default="world",
                        help="key prefix inside the R2 bucket (default: world)")
    args = parser.parse_args(argv)

    # Check the toolchain BEFORE spending hours on an 85 GB download that a missing
    # ogr2ogr would make useless. Same reasoning for the upload credentials: stage 6
    # runs last, so an unset R2_* variable would otherwise be found only after every
    # layer is built (see check_upload_env).
    preflight()
    if args.upload:
        check_upload_env()
    table = load_table(TABLE_PATH)

    out_dir: Path = args.out
    work: Path = args.work or (out_dir / "work")
    out_dir.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)

    wanted = set(args.only.split(",")) if args.only else None
    layers = [l for l in table.feature_layers if wanted is None or l.key in wanted]
    density_selected = not args.skip_density and (wanted is None or "density" in wanted)

    # --unlink-source exists for feature-only shard builds (stage 4 never runs, so
    # nothing reads the raw extract after stage 1). If density WILL run, deleting the
    # planet after stage 1 would starve stage 4 of its input — refuse up front rather
    # than dying hours in.
    if args.unlink_source and density_selected:
        raise SystemExit(
            "--unlink-source cannot be combined with a density build: stage 4 reads "
            "the raw --planet file (stage 1's intermediate deliberately excludes "
            "buildings/highways). Pass --skip-density, or --only without density.")

    if args.clip_region is not None:
        if not args.clip_region.exists():
            raise SystemExit(f"--clip-region file not found: {args.clip_region}")
        if not density_selected:
            log("note: --clip-region only affects the density stage, which this "
                "invocation does not run")

    started = time.time()
    had_planet = args.planet.exists()
    planet = stage_fetch_planet(args.planet, args.planet_url, args.no_fetch, args.skip_md5)
    planet_changed = stage_update_planet(planet, args.no_update, freshly_downloaded=not had_planet)

    # A newer planet invalidates EVERYTHING derived from the old one. Every stage below
    # skips when its output already exists, which is what makes an interrupted build
    # resumable — and is exactly what would otherwise splice a freshly-updated planet
    # together with last week's `interesting.osm.pbf` and last week's density grid. The
    # result would be internally inconsistent and would not look wrong anywhere.
    force = args.force
    if planet_changed and not force:
        log("stage 0b: planet changed — rebuilding every derived stage "
            "(the cached intermediates are from the previous snapshot)")
        force = True

    # Stage 1 is "the stage that decides whether the build takes three hours or a
    # day", and the per-layer loop below is its ONLY reader. A selection that leaves
    # no feature layers (`--only density`, every density shard in CI) would otherwise
    # pay for a whole planet tags-filter pass and write an interesting.osm.pbf that
    # nothing ever opens.
    source = stage_filter(planet, work, table, force) if layers else None

    # The timestamp must be read while the planet file still exists — stage 5 wants
    # it, and --unlink-source deletes the file two lines down.
    planet_ts = planet_timestamp(planet)

    if args.unlink_source and planet.exists():
        # Reachable with no stage 1 output: --only density --skip-density, or an
        # --only that names nothing in the table. The gate above has already proved
        # stage 4 will not run, so the extract is unread either way.
        why = (f"{source.name} exists and no remaining stage reads the raw extract"
               if source is not None
               else "no selected stage reads the raw extract")
        log(f"--unlink-source: deleting {planet} "
            f"({human_bytes(planet.stat().st_size)}) — {why}")
        planet.unlink()

    built: dict[str, Path] = {}
    for layer in layers:
        log(f"── {layer.key} ─────────────────────────────")
        fgb = build_layer(source, layer, work, out_dir, table, force)
        if fgb is not None:
            built[layer.key] = fgb

    if density_selected:
        density = stage_density(planet, work, out_dir, table, force,
                                clip_region=args.clip_region)
        if density is not None:
            built["density"] = density

    # Partial = the layer TABLE was truncated by selection (--only/--skip-density),
    # not merely that some selected layer came out legitimately empty.
    partial = (wanted is not None
               and any(l.key not in wanted for l in table.feature_layers)) \
        or not density_selected
    stage_manifest(out_dir, table, planet_ts, built, partial=partial)

    if args.upload:
        stage_upload(out_dir, args.prefix)

    total = sum(p.stat().st_size for p in built.values())
    log(f"built {len(built)} layers, {total / 1e9:.2f} GB, "
        f"in {(time.time() - started) / 60:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main())
