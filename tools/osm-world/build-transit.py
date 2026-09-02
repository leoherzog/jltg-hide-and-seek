#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     # The relation assembly is a pyosmium pass, exactly like build.py's stage 4.
#     "osmium>=4.3",
# ]
# ///
"""
tools/osm-world/build-transit.py — the global `transit_route` layer.

WHAT THIS IS FOR
----------------
One feature per urban-rail ROUTE RELATION, carrying the assembled line geometry and
the ordered list of stops the relation names. A map with no GTFS feed can still be
played: `osm/synth.js` reads this layer over the drawn ring and synthesizes a feed
from it. OSM has no timetable, so the schedule is invented and says so; the geometry
and stop order are real.

WHY IT IS A SEPARATE SCRIPT AND NOT A `categories.json` ENTRY
------------------------------------------------------------
`osmium export` emits relations as multipolygons only and drops `type=route`
entirely (verified against osmium-tool 1.19.1), so no `where` clause can recover a
route. And a relation only assembles when it fits ENTIRELY inside the extract being
read (the law that moved `admin` to Overture, DESIGN.md §Phase 2): a metro line
crossing a shard boundary would assemble half or not at all in each shard, and
merge.py would keep whichever copy sorts first. So this is a GLOBAL pass, joined to
the world at merge time like admin (`merge.py --transit`), never a shard's job.

THE PIPELINE
------------
    osmium tags-filter <planet> r/route=…   →  work/routes.osm.pbf   (tiny)
    pass A: relations         (which relations, and which members they name)
    pass B: ways + nodes      (only the members pass A asked for)
    assembly → GeoJSONSeq sorted by relation id
    ogr2ogr → transit_route.fgb (MultiLineString, SPATIAL_INDEX=YES)

`tags-filter` pulls a matched relation's member ways and their nodes along with it,
so the intermediate is self-contained. Urban rail is about 27,000 route relations
planet-wide, so the job is minutes of work once the planet has been read.

TWO PASSES, NOT ONE. A single pass would have to cache every way and node against the
chance that a relation later names it. Relations sort last in a PBF, so pass A learns
the exact member id sets first and pass B keeps nothing else; peak memory is a
function of urban rail, not of the input (Berlin: 1.85 GB peak RSS, nearly all
pyosmium's fixed cost). If the planet ever OOM-kills pass B, hold each way's
coordinates in an `array('d')` rather than a tuple of tuples, or run once per mode.

ASSEMBLY, AND WHY IT IS NOT "CONCATENATE THE MEMBER WAYS"
--------------------------------------------------------
Measured over a 14-city corpus (992 relations):

  * MEMBER ORDER IS UNRELIABLE, TOPOLOGY IS SOUND. Stored order hits an endpoint
    mismatch in 52/162 Seoul relations; union-find says 97.7% are one connected
    component anyway. So members are re-chained by endpoint matching with
    per-segment reversal.

  * PATH MEMBERS ARE ROLE ∈ {"", forward, backward}. PTv2 deprecated forward and
    backward in 2011 and they are still everywhere (Seoul: 957); the empty role
    alone leaves 8 Seoul relations with NO geometry.

  * PLATFORM WAYS ARE MEMBERS OF THE SAME RELATION (NYC: 3,309) and must never reach
    the geometry; they are excluded by not being path roles, like every other role.

  * STOPS ARE READ BY ROLE, NEVER BY POSITION. A handful of relations interleave
    stops after the ways. Every `stop`-role member in the corpus is a NODE (0
    exceptions in 19,400+ slots), so a non-node stop member is dropped and counted.

  * LOOPS AND BRANCHES EXIST. 22 relations have no degree-1 endpoint (circle lines),
    so the chainer must seed a walk arbitrarily; 17 are genuinely disconnected and
    ship as a MultiLineString, parts longest-first. Nothing here fabricates a
    joining segment: an honest gap is information.

  * STOP ORDER COMES FROM THE GEOMETRY. Projecting stops onto the assembled line
    reproduces the member order for 95.9% of relations, and the rest are
    through-services where the projection is right. The DIRECTION is a separate
    question the projection cannot answer; see `order_stops`.

  * RELATIONS WITH NO STOPS ARE DROPPED (17 in the corpus): a route with no stops is
    a line nobody can board.

DETERMINISM
-----------
Same planet in, same bytes out. Relations are emitted sorted by id; every tie in the
chainer is broken by smallest node id, then way id, then member index; coordinates
are rounded to 7 decimals; the `stops` JSON has fixed key order and compact
separators; nothing reads a clock. `fgb-equal.sh` tier 1 (sha256) is the
reproducibility test.

USAGE
-----
    uv run tools/osm-world/build-transit.py --out ~/osm-builds/transit
    uv run tools/osm-world/build-transit.py --planet berlin-latest.osm.pbf \\
        --out ~/osm-builds/transit-berlin

`--planet` behaves exactly as in build.py because `stage_fetch_planet` and
`stage_update_planet` are imported, not copied: downloads only when the named file is
absent, and `--no-fetch` makes a missing file a hard error. A city extract is the
development loop.

It writes, next to each other in `--out`:

    transit_route.fgb            the layer
    transit_route.fgb.sha256     in `sha256sum -c` format, like build-admin.sh's
    transit_route.meta.json      counts, modes, planet timestamp, emitter version

The upload is the workflow's job (world-transit.yml): these are pipeline
intermediates handed to world-merge.yml's finalize step, not published world objects.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple

HERE = Path(__file__).resolve().parent

sys.path.insert(0, str(HERE))
import build  # noqa: E402 — build.py, same directory; stdlib-only at import time.
# The planet stages and preflight are REUSED, never duplicated: `--planet` must mean
# exactly what it means in build.py.

# ── what counts as a route ───────────────────────────────────────────────────

# The six rail modes. `train` is not optional: Tokyo and Osaka are mostly
# `route=train`. `bus` is deliberately absent: 342,003 relations whose member ways
# would drag most of the planet's highways into the intermediate.
MODES = ("subway", "train", "light_rail", "tram", "monorail", "funicular")

# Like every `filter` in categories.json this is WIDER than the selector: tags-filter
# cannot express a second key, so `type=route` is tested in Python. Widening is safe;
# narrowing loses features silently.
TAGS_FILTER_EXPRESSION = "r/route=" + ",".join(MODES)

# Bumped whenever a change here would produce different bytes from the same planet.
# It is part of the skip-cache key, beside the mode list and the planet's identity,
# because the output file's existence cannot witness those parameters (the
# `density.clip-state` rule, build.py stage 4).
EMITTER_VERSION = "1"

# ── member roles ─────────────────────────────────────────────────────────────

# Roles are compared after `strip().lower()`: Taipei has a member whose role is
# literally `"station "`, and a known role plus stray whitespace must not hide.
PATH_ROLES = frozenset({"", "forward", "backward"})
STOP_ROLES = frozenset({"stop", "stop_entry_only", "stop_exit_only"})

# Never geometry. Listed so the count is a diagnostic: if it collapses, the role
# vocabulary moved and the lines grew platform stubs.
PLATFORM_ROLES = frozenset({
    "platform", "platform_entry_only", "platform_exit_only", "platform_edge",
})


def normalise_role(role: str) -> str:
    """The one place a member role is turned into something comparable; a
    silently-unrecognised path role is a silently-missing piece of line."""
    return role.strip().lower()

# ── the FGB property schema ──────────────────────────────────────────────────

# Self-contained on purpose: this layer is NOT built through `export_layer`, so
# `include_tags` / `runtime_columns` do not apply. Order is the column order in the file.
TAG_COLUMNS = (
    ("name", "name"),
    ("name_en", "name:en"),
    ("ref", "ref"),
    # British spelling only. `colour` has 1.6M uses planet-wide; `color` has 74.
    ("colour", "colour"),
    ("operator", "operator"),
    ("network", "network"),
    ("route", "route"),
    # The only two temporal tags OSM has for a line, both rare. They ship raw: the
    # converter owns the grammar and the fallback.
    ("interval", "interval"),
    ("duration", "duration"),
)

COLUMNS = ("osm_type", "osm_id", *[name for name, _ in TAG_COLUMNS], "stops")

# An absent tag ships as the EMPTY STRING, not JSON null: OGR infers a GeoJSONSeq
# field's type from the values it sees, and an all-null column has no type. Inside the
# `stops` JSON a missing name is null, so the consumer can tell "unnamed" from "".
ABSENT = ""

# A stop far from the line (JOSM PT_Assistant's "stop not served" uses ~0.002°) is
# NOT dropped, since that would silently shorten a line, but it is counted: a build
# where this number jumps is a build where assembly went wrong.
STOP_OFFLINE_M = 500.0

EARTH_RADIUS_M = 6371008.8


# ═══════════════════════════════════════════════════════════════════════════════
# Geometry — plain functions over plain data, so test-update.py can drive them
# ═══════════════════════════════════════════════════════════════════════════════


class Segment(NamedTuple):
    """One path-role member way, reduced to what chaining needs.

    Endpoints are NODE IDS, not coordinates. Ways in OSM connect by sharing a node,
    and two distinct nodes at the same rounded position are not a connection —
    matching on floats would join tracks that merely cross.
    """

    way_id: int
    first: int
    last: int
    coords: tuple[tuple[float, float], ...]   # (lon, lat), in the way's own order


def _plane(origin: tuple[float, float]):
    """A local equirectangular projection to metres, anchored at `origin`.

    Good to a fraction of a percent over a metro: it orders MultiLineString parts and
    projects stops. No published number reads a distance out of it.
    """
    lon0, lat0 = origin
    scale = math.cos(math.radians(lat0))

    def project(lon: float, lat: float) -> tuple[float, float]:
        return (math.radians(lon - lon0) * scale * EARTH_RADIUS_M,
                math.radians(lat) * EARTH_RADIUS_M)

    return project


def line_length_m(coords, project) -> float:
    total = 0.0
    previous = None
    for lon, lat in coords:
        point = project(lon, lat)
        if previous is not None:
            total += math.dist(previous, point)
        previous = point
    return total


def chain_segments(segments: list[Segment]) -> list[list[tuple[float, float]]]:
    """Re-chain member ways into as few continuous lines as their topology allows.

    Greedy walk over shared endpoint nodes with reversal, seeded at the smallest
    degree-1 node id when there is one and at the smallest way id otherwise (a circle
    line has no end). Every tie-break is on an id, never on member order.

    Leftovers become extra parts (disconnected relations, a junction's branch), so the
    caller emits a MultiLineString and never bridges the gap. Parts come back
    longest-first, ties by smallest way id, so the principal line is part 0.
    """
    remaining = set(range(len(segments)))
    incident: dict[int, list[int]] = {}
    for index, segment in enumerate(segments):
        incident.setdefault(segment.first, []).append(index)
        if segment.last != segment.first:
            incident.setdefault(segment.last, []).append(index)

    parts: list[tuple[list[tuple[float, float]], int]] = []
    while remaining:
        degree: dict[int, int] = {}
        for index in remaining:
            segment = segments[index]
            degree[segment.first] = degree.get(segment.first, 0) + 1
            if segment.last != segment.first:
                degree[segment.last] = degree.get(segment.last, 0) + 1
        ends = [node for node, count in degree.items() if count == 1]
        if ends:
            node = min(ends)
        else:
            node = segments[min(remaining,
                                key=lambda i: (segments[i].way_id, i))].first

        coords: list[tuple[float, float]] = []
        used: list[int] = []
        while True:
            candidates = [i for i in incident.get(node, ()) if i in remaining]
            if not candidates:
                break
            index = min(candidates, key=lambda i: (segments[i].way_id, i))
            remaining.discard(index)
            segment = segments[index]
            used.append(segment.way_id)
            if segment.first == node:
                piece = list(segment.coords)
                node = segment.last
            else:
                piece = list(reversed(segment.coords))
                node = segment.first
            if coords and coords[-1] == piece[0]:
                coords.extend(piece[1:])
            else:
                coords.extend(piece)
        if used and len(coords) >= 2:
            parts.append((coords, min(used)))

    if not parts:
        return []
    project = _plane(parts[0][0][0])
    decorated = [(-line_length_m(coords, project), way_id, coords)
                 for coords, way_id in parts]
    decorated.sort(key=lambda row: (row[0], row[1]))
    return [coords for _, _, coords in decorated]


def _project_onto(parts, project):
    """Per-part cumulative offsets along the concatenated chain.

    A disconnected relation still has ONE travel order, so the second part continues
    where the first left off plus the straight-line gap, which keeps parts from
    interleaving when the second doubles back.
    """
    offsets = []
    running = 0.0
    previous_end = None
    for coords in parts:
        if previous_end is not None:
            running += math.dist(project(*previous_end), project(*coords[0]))
        offsets.append(running)
        running += line_length_m(coords, project)
        previous_end = coords[-1]
    return offsets


def order_stops(parts, stops):
    """Sort stops into travel order by projecting them onto the chained line.

    THE PROJECTION DECIDES THE SEQUENCE; THE MEMBER LIST DECIDES WHICH END IS THE
    START. The chainer's seed is a determinism rule with no idea which way the trains
    run, so a line's two direction relations would otherwise list their stops in the
    SAME order and a synthesized feed would have two northbound services. PTv2 says
    stop members are listed in travel order (true for 95.9% of the corpus), so if the
    projected distances descend more often than they ascend along the member list,
    the sequence is flipped; a stop or two out of place cannot disturb that vote.

    Returns `(ordered, offline)`: the sorted list, and how many lie further than
    `STOP_OFFLINE_M` from every part. The sort is stable, so stops projecting to the
    same distance keep the relation's relative order.

    With no geometry the member order is the only order; that case is the caller's
    to reject, but the function stays total.
    """
    if not parts or not stops:
        return list(stops), 0

    project = _plane(parts[0][0])
    offsets = _project_onto(parts, project)

    ordered = []
    offline = 0
    for stop in stops:
        point = project(stop["lon"], stop["lat"])
        best_distance = math.inf
        best_along = 0.0
        for offset, coords in zip(offsets, parts):
            along = 0.0
            previous = project(*coords[0])
            for lon, lat in coords[1:]:
                current = project(lon, lat)
                dx, dy = current[0] - previous[0], current[1] - previous[1]
                span = dx * dx + dy * dy
                if span == 0.0:
                    t = 0.0
                else:
                    t = ((point[0] - previous[0]) * dx
                         + (point[1] - previous[1]) * dy) / span
                    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
                foot = (previous[0] + t * dx, previous[1] + t * dy)
                distance = math.dist(point, foot)
                if distance < best_distance:
                    best_distance = distance
                    best_along = offset + along + t * math.sqrt(span)
                along += math.sqrt(span)
                previous = current
        if best_distance > STOP_OFFLINE_M:
            offline += 1
        ordered.append((best_along, stop))

    along = [row[0] for row in ordered]        # still in member order here
    ascending = sum(1 for a, b in zip(along, along[1:]) if b > a)
    descending = sum(1 for a, b in zip(along, along[1:]) if b < a)
    backwards = descending > ascending
    ordered.sort(key=lambda row: -row[0] if backwards else row[0])
    return [stop for _, stop in ordered], offline


# ═══════════════════════════════════════════════════════════════════════════════
# Stage 1 — cut the planet down to route relations and their members
# ═══════════════════════════════════════════════════════════════════════════════


def stage_filter_routes(planet: Path, work: Path, force: bool) -> Path:
    """One `osmium tags-filter` pass; everything after it reads a few-hundred-MB file.

    No `-R`: the referenced member ways and nodes are exactly what pass B needs.
    tags-filter takes no `--index-type` and needs none.

    The skip has its own witness, `routes.state`, holding the filter expression AND
    the planet identity the intermediate was cut from: a mode added to MODES or a
    swapped `--planet` must re-cut it, and the emitter's sidecar is rewritten too
    late to protect a rerun's passes from a stale cut.
    """
    out = work / "routes.osm.pbf"
    witness = work / "routes.state"
    state = "\n".join((str(planet.resolve()),
                       build.planet_timestamp(planet) or "",
                       TAGS_FILTER_EXPRESSION))
    recorded = (witness.read_text(encoding="utf-8").strip()
                if witness.exists() else None)
    if out.exists() and not force and recorded == state:
        build.log(f"stage 1: {out.name} exists, skipping")
        return out
    # Invalidated before the work, rewritten only after osmium succeeds — the
    # emitter sidecar's rule, for the same crash-mid-write reason.
    witness.unlink(missing_ok=True)
    build.log(f"stage 1: one planet pass for {TAGS_FILTER_EXPRESSION}")
    build.run([
        "osmium", "tags-filter", str(planet),
        TAGS_FILTER_EXPRESSION,
        "--overwrite", "-o", str(out),
    ])
    witness.write_text(state + "\n", encoding="utf-8")
    return out


# ═══════════════════════════════════════════════════════════════════════════════
# Stage 2 — two pyosmium passes over the intermediate
# ═══════════════════════════════════════════════════════════════════════════════


def read_relations(routes: Path) -> list[dict]:
    """Pass A: every `type=route` relation in a wanted mode, with its member list.

    Members are copied out as plain tuples immediately. pyosmium invalidates the
    OSM object the moment the callback returns, and a reference kept past that
    point reads freed memory — silently, with plausible values.
    """
    import osmium  # noqa: PLC0415 — uv installs it; keep the import next to its use

    found: list[dict] = []

    class RelationPass(osmium.SimpleHandler):
        def relation(self, r) -> None:
            tags = r.tags
            if tags.get("type") != "route":
                return
            if tags.get("route") not in MODES:
                return
            found.append({
                "id": r.id,
                "tags": {key: tags.get(source) for key, source in TAG_COLUMNS},
                "members": [(m.type, m.ref, normalise_role(m.role))
                            for m in r.members],
            })

    RelationPass().apply_file(str(routes))
    found.sort(key=lambda relation: relation["id"])
    return found


def read_members(routes: Path, way_ids: set[int], node_ids: set[int]):
    """Pass B: the member ways' geometry and the stop nodes' position and names.

    Only the ids pass A asked for are kept, which bounds memory to urban rail.

    A way with even one unresolvable node location is dropped whole: keeping the
    valid part would move its endpoints and chain to the wrong neighbour. The drop is
    counted and reported.
    """
    import osmium  # noqa: PLC0415 — as above

    ways: dict[int, Segment] = {}
    nodes: dict[int, dict] = {}
    broken = 0

    class MemberPass(osmium.SimpleHandler):
        def node(self, n) -> None:
            if n.id not in node_ids:
                return
            location = n.location
            if not location.valid():
                return
            nodes[n.id] = {
                "id": n.id,
                "name": n.tags.get("name"),
                "name_en": n.tags.get("name:en"),
                "lat": location.lat,
                "lon": location.lon,
            }

        def way(self, w) -> None:
            nonlocal broken
            if w.id not in way_ids:
                return
            refs: list[int] = []
            coords: list[tuple[float, float]] = []
            for node_ref in w.nodes:
                location = node_ref.location
                if not location.valid():
                    broken += 1
                    return
                refs.append(node_ref.ref)
                coords.append((location.lon, location.lat))
            if len(coords) < 2:
                return
            ways[w.id] = Segment(w.id, refs[0], refs[-1], tuple(coords))

    MemberPass().apply_file(str(routes), locations=True, idx=build.OSMIUM_INDEX)
    return ways, nodes, broken


# ═══════════════════════════════════════════════════════════════════════════════
# Stage 3 — assembly
# ═══════════════════════════════════════════════════════════════════════════════


class Counts:
    """Everything a later reader would want to know about what this run threw away."""

    def __init__(self) -> None:
        self.relations = 0
        self.emitted = 0
        self.no_stops = 0
        self.no_geometry = 0
        self.unresolved_ways = 0
        self.platform_members = 0
        self.other_roles = 0
        self.non_node_stops = 0
        self.stops_offline = 0
        self.multipart = 0

    def as_dict(self) -> dict:
        return {key: value for key, value in sorted(vars(self).items())}


def assemble(relation: dict, ways: dict[int, Segment], nodes: dict[int, dict],
             counts: Counts) -> dict | None:
    """One relation → one GeoJSON feature, or None when there is nothing honest to say.

    Two rejections, both deliberate: a relation with no stop members is a line
    nobody can board, and a relation whose member ways are all outside the extract
    has no line at all. Everything else is emitted, gaps and offline stops included,
    with the counts recording what was odd about it.
    """
    counts.relations += 1

    segments: list[Segment] = []
    stops: list[dict] = []
    for member_type, ref, role in relation["members"]:
        if member_type == "w" and role in PATH_ROLES:
            segment = ways.get(ref)
            if segment is None:
                counts.unresolved_ways += 1
            else:
                segments.append(segment)
        elif role in STOP_ROLES:
            if member_type != "n":
                # 0 exceptions in 19,400+ corpus stop slots. If this ever fires,
                # the tagging moved and the converter's station model needs a look.
                counts.non_node_stops += 1
                continue
            node = nodes.get(ref)
            if node is not None:
                stops.append(node)
        elif role in PLATFORM_ROLES:
            counts.platform_members += 1
        else:
            counts.other_roles += 1

    if not stops:
        counts.no_stops += 1
        return None

    parts = chain_segments(segments)
    if not parts:
        counts.no_geometry += 1
        return None
    if len(parts) > 1:
        counts.multipart += 1

    ordered, offline = order_stops(parts, stops)
    counts.stops_offline += offline

    properties = {"osm_type": "relation", "osm_id": relation["id"]}
    for key, _ in TAG_COLUMNS:
        value = relation["tags"].get(key)
        properties[key] = ABSENT if value is None else value
    properties["stops"] = json.dumps(
        [[stop["id"], stop["name"], stop["name_en"],
          round(stop["lat"], 7), round(stop["lon"], 7)] for stop in ordered],
        ensure_ascii=False, separators=(",", ":"))

    counts.emitted += 1
    return {
        "type": "Feature",
        "geometry": {
            "type": "MultiLineString",
            "coordinates": [[[round(lon, 7), round(lat, 7)] for lon, lat in part]
                            for part in parts],
        },
        "properties": properties,
    }


def emit_geojsonseq(features: list[dict], work: Path) -> Path:
    """Write the features one per line, in relation-id order.

    FlatGeobuf reorders into Hilbert order on write, but a reproducible intermediate
    makes a diff between two builds meaningful, as `stage_density`'s sort does.
    """
    path = work / "transit_route.geojsonl"
    with path.open("w", encoding="utf-8") as destination:
        for feature in features:
            destination.write(
                json.dumps(feature, ensure_ascii=False, separators=(",", ":")) + "\n")
    return path


def convert(geojsonl: Path, out_dir: Path) -> Path:
    """GeoJSONSeq → FlatGeobuf, with the column list pinned rather than discovered."""
    fgb = out_dir / "transit_route.fgb"
    fgb.unlink(missing_ok=True)
    build.run([
        "ogr2ogr", "-f", "FlatGeobuf", str(fgb), str(geojsonl),
        "-nln", "transit_route",
        "-select", ",".join(COLUMNS),
        "-lco", "SPATIAL_INDEX=YES",
        "-nlt", "MULTILINESTRING",
    ])
    return fgb


# ═══════════════════════════════════════════════════════════════════════════════
# main
# ═══════════════════════════════════════════════════════════════════════════════


def state_key(planet: Path) -> str:
    """Everything this run's output depends on, the planet's identity included.

    A skip-if-exists cache is only sound when the output's existence witnesses the
    parameters it was built under: the mode list, the emitter version, and the planet
    file's resolved path and replication timestamp, so a Berlin dev-loop build cannot
    masquerade as a planet build under the default `--out`.
    """
    return hashlib.sha256("\n".join((
        EMITTER_VERSION,
        TAGS_FILTER_EXPRESSION,
        str(planet.resolve()),
        build.planet_timestamp(planet) or "",
    )).encode("utf-8")).hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build the global transit_route FlatGeobuf from OSM route relations.",
    )
    parser.add_argument("--planet", default=build.DEFAULT_PLANET, type=Path,
                        help="planet.osm.pbf, or any .osm.pbf extract. Downloaded if "
                             f"absent (default: {build.DEFAULT_PLANET})")
    parser.add_argument("--planet-url", default=None,
                        help="download from this URL instead of the built-in mirror list")
    parser.add_argument("--no-fetch", action="store_true",
                        help="fail if --planet is missing rather than downloading it")
    parser.add_argument("--skip-md5", action="store_true",
                        help="skip checksum verification of a freshly downloaded planet")
    parser.add_argument("--no-update", action="store_true",
                        help="do not apply replication diffs to an existing planet file")
    parser.add_argument("--out", default=Path("build/transit"), type=Path,
                        help="output directory for transit_route.fgb and its sidecars")
    parser.add_argument("--work", default=None, type=Path,
                        help="scratch directory for intermediates (default: <out>/work)")
    parser.add_argument("--force", action="store_true",
                        help="rebuild stages whose output already exists")
    args = parser.parse_args(argv)

    # build.py's toolchain check: below the GDAL floor ogr2ogr writes a valid
    # FlatGeobuf with no spatial index and no error.
    build.preflight()

    out_dir: Path = args.out
    work: Path = args.work or (out_dir / "work")
    out_dir.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)

    fgb = out_dir / "transit_route.fgb"
    sidecar = work / "transit.state"

    # The planet stages run BEFORE the skip check, as in build.py's main: a skip must
    # never return a layer built from a different planet or an older snapshot, and
    # `--no-fetch`'s hard error must fire on every run. Fetch is a no-op when the file
    # exists and update is cheap when it is current (`--no-update` for the dev loop).
    had_planet = args.planet.exists()
    planet = build.stage_fetch_planet(args.planet, args.planet_url,
                                      args.no_fetch, args.skip_md5)
    planet_changed = build.stage_update_planet(
        planet, args.no_update, freshly_downloaded=not had_planet)

    key = state_key(planet)
    if fgb.exists() and not args.force and not planet_changed:
        recorded = (sidecar.read_text(encoding="utf-8").strip()
                    if sidecar.exists() else None)
        if recorded == key:
            build.log(f"{fgb.name} exists and matches the recorded emitter state "
                      "and planet, skipping")
            return 0
        build.log(f"{fgb.name} exists but was built under a different emitter "
                  f"state or planet (recorded {recorded!r}, current {key!r}) "
                  "— rebuilding")
    # Invalidated BEFORE any work, rewritten only on success: a crash mid-ogr2ogr
    # must not leave a sidecar that validates a truncated layer for a later skip.
    sidecar.unlink(missing_ok=True)

    force = args.force or planet_changed
    if planet_changed:
        build.log("the planet advanced — rebuilding the filtered intermediate too")

    routes = stage_filter_routes(planet, work, force)

    build.log("stage 2a: reading route relations")
    relations = read_relations(routes)
    way_ids: set[int] = set()
    node_ids: set[int] = set()
    for relation in relations:
        for member_type, ref, role in relation["members"]:
            if member_type == "w" and role in PATH_ROLES:
                way_ids.add(ref)
            elif member_type == "n" and role in STOP_ROLES:
                node_ids.add(ref)
    build.log(f"stage 2a: {len(relations)} route relations naming "
              f"{len(way_ids)} path ways and {len(node_ids)} stop nodes")

    build.log("stage 2b: reading their member ways and stop nodes")
    ways, nodes, broken = read_members(routes, way_ids, node_ids)
    build.log(f"stage 2b: resolved {len(ways)}/{len(way_ids)} ways "
              f"({broken} dropped for an incomplete node location) and "
              f"{len(nodes)}/{len(node_ids)} stop nodes")

    counts = Counts()
    features = [feature for feature in
                (assemble(relation, ways, nodes, counts) for relation in relations)
                if feature is not None]
    build.log(f"stage 3: {counts.emitted} features from {counts.relations} relations "
              f"({counts.no_stops} had no stop members, {counts.no_geometry} no "
              f"resolvable geometry, {counts.multipart} are multi-part); excluded "
              f"{counts.platform_members} platform members and {counts.other_roles} "
              f"members in other roles; {counts.unresolved_ways} member ways were "
              f"outside the extract; {counts.stops_offline} stops sit more than "
              f"{STOP_OFFLINE_M:.0f} m from their line")

    if not features:
        # As in build.py's convert_layer: the GeoJSONSeq driver cannot open a
        # record-less file. Only a fixture-sized extract should ever get here.
        raise SystemExit(
            "no route relation in this extract survived assembly — nothing to "
            "write. For a real region that is a build failure, not an empty "
            "world; for a fixture it means the fixture has no rail.")

    geojsonl = emit_geojsonseq(features, work)
    fgb = convert(geojsonl, out_dir)
    geojsonl.unlink(missing_ok=True)

    digest = build.sha256_file(fgb)
    # `sha256sum -c` format, like build-admin.sh's sidecar, so a transferred copy
    # verifies with the stock tool.
    (out_dir / "transit_route.fgb.sha256").write_text(
        f"{digest}  {fgb.name}\n", encoding="utf-8")
    meta = {
        "bytes": fgb.stat().st_size,
        "counts": counts.as_dict(),
        "emitter_version": EMITTER_VERSION,
        "features": build.feature_count(fgb),
        "modes": list(MODES),
        # The PBF's own replication header, never the clock: stamping build time
        # would attribute a months-old planet dump to today.
        "planet_timestamp": build.planet_timestamp(planet),
        "sha256": digest,
    }
    (out_dir / "transit_route.meta.json").write_text(
        json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    sidecar.write_text(key + "\n", encoding="utf-8")
    build.log(f"transit_route.fgb: {meta['features']} features, "
              f"{build.human_bytes(meta['bytes'])}, sha256 {digest[:12]}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as error:
        raise SystemExit(f"command failed ({error.returncode}): "
                         f"{' '.join(str(part) for part in error.cmd)}") from error
