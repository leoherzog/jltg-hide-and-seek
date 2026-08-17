#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "shapely>=2.0",
# ]
# ///
"""
tools/osm-world/cover.py — derive the two shard partitions from Geofabrik's index.

    uv run tools/osm-world/cover.py                 # writes tools/osm-world/shards.json
    uv run tools/osm-world/cover.py --out other.json --no-sizes

Downloads https://download.geofabrik.de/index-v1.json and computes:

  * `fine` — the finest DISJOINT cover of the planet by Geofabrik regions, for the
    density shards (PLAN.md §Phase 3: each shard counts ways whose first node falls in
    its assigned disjoint region, so boundary cells receive partial tallies that sum
    to the true total).

  * `coarse` — a covering set of regions each ≤ ~8 GB (`--cap-gb`), for the feature
    shards (runner disk is the constraint; overlap between coarse shards is fine, the
    Phase-3 merge dedups on `(osm_type, osm_id)`).

THE `parent` FIELD IS DISPLAY-ONLY. Geofabrik's index is not a tree: `us`,
`us-midwest` and `us/michigan` are all siblings in it, and combination regions (dach,
alps, britain-and-ireland) overlap their "siblings" wholesale. Both partitions are
therefore computed GEOMETRICALLY:

  * Containment: region A is inside region B when area(A ∩ B) ≥ 98% of area(A) and B
    is strictly larger. (Geofabrik's cutting polygons are buffered, so exact `covers`
    would never fire; 98% absorbs the buffer.)

  * FINE MEMBERSHIP: the GEOMETRIC LEAVES — regions that contain no other region.
    (A residual-area criterion is wrong here: a continent minus its countries keeps
    a huge open-ocean residual, so "residual survives" would keep every continent in
    the cover. The leaves are the finest extracts that exist anywhere; whatever a
    leaf set fails to cover is reported as `uncovered_deg2` so the gap is measured,
    not assumed away.)

  * THE FINE COVER'S DIFFERENCE ORDER, fixed and documented here because the density
    builds must reproduce it exactly: leaves sorted by ASCENDING polygon area
    (lon/lat square degrees, as shipped in index-v1.json), ties broken by region id
    ascending. Each leaf's assigned disjoint geometry is its polygon MINUS the union
    of all earlier (smaller) leaves' ORIGINAL polygons:

        assigned(i) = geom(i) − ∪ geom(j)   for all leaves j before i in that order

    The `fine` array in shards.json is written IN THIS ORDER, so a consumer can
    rebuild the assigned geometries from the index without re-deriving the order.

  * `disjoint_neighbors` on each fine entry: the other fine members whose assigned
    geometries touch or intersect it — the shards that can share a boundary density
    cell.

  * The coarse set: for every fine member, the LARGEST region with `est_bytes` ≤ the
    cap that geometrically contains it (falling back to the member itself); the
    coarse partition is the set of those containers. This picks germany over its 16
    states, and splits europe/asia/north-america into children instead of shipping a
    35 GB extract, exactly the PLAN rule — without ever trusting `parent`.

`est_bytes` comes from a HEAD request per chosen region's `-latest.osm.pbf` (the
index carries no sizes). `--no-sizes` skips that for a fast structural run.

Output (tools/osm-world/shards.json, the pinned cross-agent interface):

    {"generated_from": "geofabrik index-v1.json <date>",
     "coarse": [{"id", "pbf_url", "md5_url", "est_bytes"}, ...],
     "fine":   [{"id", "pbf_url", "md5_url", "est_bytes",
                 "disjoint_neighbors": [ids...]}, ...]}

SECOND OUTPUT — tools/osm-world/cover-geometries/ (--geometries-dir): one GeoJSON
Feature per FINE shard holding its ASSIGNED DISJOINT polygon (the `assigned(i)`
difference above), full coordinate precision, filename `<id with '/' -> '__'>.geojson`
(e.g. `us__michigan.geojson`). This is the BUILD-TIME input that makes the density
exactness rule real: `ci/build-shard.sh` passes it to `build.py --clip-region` for
density-kind shards, so each shard counts only the ways whose first node falls inside
its assigned disjoint region — without it, every way in Geofabrik's overlap buffers is
counted by both neighbouring shards and the merged density grid double-counts. The
directory is regenerated wholesale on every run (stale files are deleted first) and is
committed alongside shards.json — the two are one interface and must come from the
same run. Both outputs are written at the very end of the run, adjacent, after every
computation and network request (index fetch, size HEADs) has completed, and
shards.json itself is written atomically (temp file + rename). That shrinks the
desync window to the geometry-directory rewrite itself — it does not eliminate it: a
crash mid-way through the ~500 geometry writes still leaves the pair mixed. If a run
is interrupted there, rerun it before committing either output.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import email.utils
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

from shapely.geometry import mapping, shape
from shapely.prepared import prep
from shapely.strtree import STRtree
from shapely.ops import unary_union

HERE = Path(__file__).resolve().parent
INDEX_URL = "https://download.geofabrik.de/index-v1.json"

# Containment tolerance: Geofabrik cutting polygons are buffered outward, so a child
# sticks slightly out of its parent everywhere. 98% of the child's area inside is
# "contained" for both partitions.
CONTAINMENT_RATIO = 0.98

# Safety net only: a leaf whose assigned disjoint geometry falls below this (square
# degrees; 1e-4 ≈ 1.2 km² at the equator) would be a leaf entirely swallowed by
# smaller leaves — which should not exist, so it is dropped WITH a warning.
MIN_RESIDUAL_DEG2 = 1e-4


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def fetch_index(url: str) -> tuple[dict, str]:
    """(parsed index, human date of the copy served) — the date stamps shards.json."""
    log(f"downloading {url}")
    with urllib.request.urlopen(url, timeout=120) as response:
        raw = response.read()
        modified = response.headers.get("Last-Modified")
    date = "unknown-date"
    if modified:
        parsed = email.utils.parsedate_to_datetime(modified)
        date = parsed.date().isoformat()
    else:
        date = time.strftime("%Y-%m-%d")
    return json.loads(raw), date


def head_size(url: str) -> int | None:
    """Content-Length via HEAD, falling back to a 1-byte ranged GET (mirrors 302)."""
    try:
        request = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(request, timeout=60) as response:
            length = response.headers.get("Content-Length")
            if length:
                return int(length)
    except Exception:
        pass
    try:
        request = urllib.request.Request(url, headers={"Range": "bytes=0-0"})
        with urllib.request.urlopen(request, timeout=60) as response:
            content_range = response.headers.get("Content-Range", "")
            if "/" in content_range:
                return int(content_range.rsplit("/", 1)[1])
    except Exception:
        pass
    return None


class Region:
    __slots__ = ("id", "pbf_url", "geom", "area", "est_bytes")

    def __init__(self, id: str, pbf_url: str, geom) -> None:
        self.id = id
        self.pbf_url = pbf_url
        self.geom = geom
        self.area = geom.area
        self.est_bytes: int | None = None


def load_regions(index: dict) -> list[Region]:
    regions = []
    for feature in index["features"]:
        props = feature.get("properties") or {}
        rid = props.get("id")
        pbf = (props.get("urls") or {}).get("pbf")
        geometry = feature.get("geometry")
        if not rid or not pbf or not geometry:
            log(f"skipping index entry without id/pbf/geometry: {rid!r}")
            continue
        geom = shape(geometry)
        if not geom.is_valid:
            geom = geom.buffer(0)
        regions.append(Region(rid, pbf, geom))
    return regions


def fine_order(regions: list[Region]) -> list[Region]:
    """THE documented difference order: ascending area, ties by id."""
    return sorted(regions, key=lambda r: (r.area, r.id))


def geometric_leaves(regions: list[Region]) -> list[Region]:
    """Regions that contain no other region — the finest extracts that exist.

    Containment is the CONTAINMENT_RATIO area rule, never the `parent` field. This
    is what drops every continent, every subdivided country (germany, since its 16
    states exist), every combination region (dach, alps, britain-and-ireland,
    us-midwest, california once norcal/socal exist) — while keeping every region
    that is itself the finest coverage of its territory."""
    ordered = sorted(regions, key=lambda r: (r.area, r.id))
    tree = STRtree([r.geom for r in ordered])
    leaves: list[Region] = []
    for i, region in enumerate(ordered):
        contains_someone = False
        for j in sorted(tree.query(region.geom)):
            if j >= i:  # only strictly smaller regions can be contained
                continue
            child = ordered[j]
            inter = region.geom.intersection(child.geom).area
            if inter >= CONTAINMENT_RATIO * child.area:
                contains_someone = True
                break
        if not contains_someone:
            leaves.append(region)
    log(f"fine membership: {len(leaves)} geometric leaves of {len(regions)} regions")
    return leaves


def compute_fine(regions: list[Region]) -> tuple[list[Region], dict[str, object], float]:
    """The disjoint cover over the leaves: members in difference order, their
    assigned geometries, and the area (deg²) of the planet's region union NOT
    covered by any leaf. Each leaf is differenced only against the earlier leaves
    whose bbox intersects it — identical result to the full sequential difference,
    since a non-intersecting region subtracts nothing."""
    ordered = fine_order(geometric_leaves(regions))
    tree = STRtree([r.geom for r in ordered])
    members: list[Region] = []
    assigned: dict[str, object] = {}
    for i, region in enumerate(ordered):
        earlier = [j for j in tree.query(region.geom) if j < i]
        if earlier:
            residual = region.geom.difference(
                unary_union([ordered[j].geom for j in earlier]))
        else:
            residual = region.geom
        if residual.area >= MIN_RESIDUAL_DEG2:
            members.append(region)
            assigned[region.id] = residual
        else:
            log(f"WARNING: leaf {region.id} is entirely covered by smaller leaves "
                "and was dropped from the fine cover")
    # How much of the union of ALL regions the leaf cover misses — the honest
    # coverage figure for a leaves-only membership.
    all_union = unary_union([r.geom for r in regions])
    leaf_union = unary_union([r.geom for r in members])
    uncovered = all_union.difference(leaf_union).area
    log(f"fine cover: {len(members)} disjoint members; uncovered area "
        f"{uncovered:.2f} deg² of {all_union.area:.0f} deg² total")
    return members, assigned, uncovered


def neighbors(members: list[Region], assigned: dict[str, object]) -> dict[str, list[str]]:
    """Fine members whose ASSIGNED (disjoint) geometries touch each other."""
    geoms = [assigned[m.id] for m in members]
    tree = STRtree(geoms)
    result: dict[str, list[str]] = {}
    for i, member in enumerate(members):
        found = set()
        prepared = prep(geoms[i])
        for j in tree.query(geoms[i]):
            if j == i:
                continue
            if prepared.intersects(geoms[j]):
                found.add(members[j].id)
        result[member.id] = sorted(found)
    return result


def compute_coarse(regions: list[Region], fine_members: list[Region],
                   cap_bytes: int) -> list[Region]:
    """For each fine member, its largest container with est_bytes ≤ cap."""
    by_area = sorted(regions, key=lambda r: (-r.area, r.id))
    prepared = {}  # lazily prepared big regions
    coarse: dict[str, Region] = {}
    uncovered: list[str] = []
    for member in fine_members:
        chosen: Region | None = None
        for candidate in by_area:
            if candidate.est_bytes is None or candidate.est_bytes > cap_bytes:
                continue
            if candidate.area < member.area:
                break  # by_area is descending; nothing smaller can contain member
            if candidate.id == member.id:
                chosen = candidate
                break
            if not candidate.geom.envelope.contains(member.geom.envelope) and \
                    candidate.geom.envelope.intersection(member.geom.envelope).area \
                    < CONTAINMENT_RATIO * member.geom.envelope.area:
                continue
            if candidate.id not in prepared:
                prepared[candidate.id] = prep(candidate.geom)
            inter = candidate.geom.intersection(member.geom).area
            if inter >= CONTAINMENT_RATIO * member.area:
                chosen = candidate
                break
        if chosen is None:
            # est_bytes unknown or the member alone exceeds the cap: keep it, loudly.
            log(f"coarse: no container ≤ cap found for {member.id} "
                f"(est {member.est_bytes}); keeping the member itself")
            uncovered.append(member.id)
            chosen = member
        coarse[chosen.id] = chosen
    members = sorted(coarse.values(), key=lambda r: r.id)
    log(f"coarse cover: {len(members)} regions"
        + (f" ({len(uncovered)} kept without a ≤cap container: {uncovered})"
           if uncovered else ""))
    return members


def fill_sizes(regions: list[Region], workers: int) -> None:
    log(f"HEAD-requesting {len(regions)} pbf sizes ({workers} workers)")
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(head_size, r.pbf_url): r for r in regions}
        for future in concurrent.futures.as_completed(futures):
            region = futures[future]
            region.est_bytes = future.result()
            if region.est_bytes is None:
                log(f"WARNING: no size for {region.id} ({region.pbf_url})")


def geometry_filename(shard_id: str) -> str:
    """`us/michigan` -> `us__michigan.geojson` — the documented id-to-file mapping."""
    return shard_id.replace("/", "__") + ".geojson"


def write_geometries(members: list[Region], assigned: dict[str, object],
                     directory: Path) -> None:
    """One GeoJSON per fine shard: its assigned disjoint polygon, full precision.

    Full precision is deliberate — the assigned geometries partition the leaf union
    exactly, and rounding each file independently could open slivers of overlap or
    gap along shared boundaries, which is precisely the double/zero-count the clip
    exists to prevent. Stale files (shards gone from the cover) are removed so the
    directory always mirrors shards.json's `fine` array exactly.
    """
    directory.mkdir(parents=True, exist_ok=True)
    expected = {geometry_filename(m.id) for m in members}
    for stale in directory.glob("*.geojson"):
        if stale.name not in expected:
            log(f"removing stale geometry {stale.name}")
            stale.unlink()
    for member in members:
        feature = {
            "type": "Feature",
            "properties": {"id": member.id},
            "geometry": mapping(assigned[member.id]),
        }
        path = directory / geometry_filename(member.id)
        path.write_text(json.dumps(feature, separators=(",", ":")) + "\n",
                        encoding="utf-8")
    log(f"wrote {len(members)} assigned disjoint geometries to {directory}")


def entry(region: Region, neighbor_map: dict[str, list[str]] | None = None) -> dict:
    record = {
        "id": region.id,
        "pbf_url": region.pbf_url,
        "md5_url": region.pbf_url + ".md5",
        "est_bytes": region.est_bytes,
    }
    if neighbor_map is not None:
        record["disjoint_neighbors"] = neighbor_map.get(region.id, [])
    return record


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Compute the coarse + fine shard partitions from Geofabrik's index.")
    parser.add_argument("--index-url", default=INDEX_URL)
    parser.add_argument("--out", default=HERE / "shards.json", type=Path)
    parser.add_argument("--geometries-dir", default=HERE / "cover-geometries",
                        type=Path,
                        help="directory for the per-fine-shard assigned disjoint "
                             "GeoJSON files (build.py --clip-region inputs; "
                             "default: tools/osm-world/cover-geometries)")
    parser.add_argument("--cap-gb", default=8.0, type=float,
                        help="coarse shard size cap in GB (default: 8)")
    parser.add_argument("--no-sizes", action="store_true",
                        help="skip the HEAD requests (est_bytes becomes null; the "
                             "coarse partition then degenerates to the fine members)")
    parser.add_argument("--workers", default=16, type=int)
    args = parser.parse_args(argv)

    index, index_date = fetch_index(args.index_url)
    regions = load_regions(index)
    log(f"{len(regions)} regions in the index")

    fine_members, assigned, uncovered = compute_fine(regions)
    if uncovered > 1.0:
        log(f"WARNING: the leaf cover misses {uncovered:.2f} deg² that only "
            "coarser regions contain — inspect before trusting density totals there")
    neighbor_map = neighbors(fine_members, assigned)

    if not args.no_sizes:
        fill_sizes(regions, args.workers)

    cap_bytes = int(args.cap_gb * (1 << 30))
    coarse_members = compute_coarse(regions, fine_members, cap_bytes)

    fine_total = sum(r.est_bytes or 0 for r in fine_members)
    coarse_total = sum(r.est_bytes or 0 for r in coarse_members)
    largest_fine = max(fine_members, key=lambda r: r.est_bytes or 0)
    log(f"fine: {len(fine_members)} shards, {fine_total / 1e9:.1f} GB total, "
        f"largest {largest_fine.id} at {(largest_fine.est_bytes or 0) / 1e9:.2f} GB")
    log(f"coarse: {len(coarse_members)} shards, {coarse_total / 1e9:.1f} GB total")

    payload = {
        "generated_from": f"geofabrik index-v1.json {index_date}",
        "coarse": [entry(r) for r in coarse_members],
        # IN THE DIFFERENCE ORDER (ascending area, ties by id) — see the module
        # docstring; consumers rebuild the disjoint geometries from this order.
        "fine": [entry(r, neighbor_map) for r in fine_members],
    }

    # BOTH outputs are written HERE, last and adjacent, after every computation and
    # every network request (the index fetch and the ~500 size HEADs) has finished.
    # cover-geometries/ and shards.json are one interface and must come from the
    # same run — writing the geometries before the size fetches (the old order)
    # meant any interrupt in between left the two desynchronized on disk. The
    # shards.json write is atomic (temp + rename); the geometry-directory rewrite
    # is not — a crash inside write_geometries still desynchronizes the pair, so
    # an interrupted run must be rerun before committing (see module docstring).
    write_geometries(fine_members, assigned, args.geometries_dir)
    tmp_out = args.out.with_name(args.out.name + ".tmp")
    tmp_out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp_out, args.out)
    log(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
