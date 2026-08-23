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
    density shards (DESIGN.md §Phase 3: each shard counts ways whose first node falls in
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

  * FINE MEMBERSHIP: a region is a member when its RESIDUAL — itself minus the
    members already kept, in the difference order below — still contains LAND. One
    greedy pass, one question, and the question is the real one rather than a proxy
    for it. Land comes from vendored Natural Earth 1:50m polygons (see LAND_PATH);
    the mask decides membership only, while a member's assigned clip stays the full
    Geofabrik residual, so nothing near a coastline is lost.

    TWO PROXIES WERE TRIED HERE AND BOTH SHIPPED HOLES, which is why the rule is
    worth stating plainly. "A region that contains no other region" drops every
    region containing an ENCLAVE and takes its non-enclave territory with it: London,
    Hanover, Marseille, Casablanca, Guangzhou, Sydney, Kyiv and Lviv were in no shard
    at all, and Ukraine had no feature shard either. "A region at least 70%
    uncovered" then dropped one that is 62.9% uncovered, losing central-america's
    Lesser Antilles and italy's San Marino. Both asked about AREA when the question
    is about TERRITORY, so both needed a threshold, and a threshold on the wrong
    quantity always has a wrong side. Asking about land needs no threshold beyond
    "is there any", and it makes the cover's guarantee assertable: main() refuses to
    write a cover that leaves land to no shard.

  * THE FINE COVER'S DIFFERENCE ORDER, fixed and documented here because the density
    builds must reproduce it exactly: ALL regions sorted by ASCENDING polygon area
    (lon/lat square degrees, as shipped in index-v1.json), ties broken by region id
    ascending. Membership and assignment are decided in that one pass, so a member's
    assigned geometry is its polygon MINUS the union of the ORIGINAL polygons of the
    members KEPT before it:

        assigned(i) = geom(i) − ∪ geom(j)   for all KEPT MEMBERS j before i

    "Kept members", not "all earlier regions": a region the pass rejected as already
    subdivided contributes nothing to any difference, and subtracting one would hand
    its territory to no shard at all.

    The `fine` array in shards.json is written IN THIS ORDER, so a consumer holding
    the index can rebuild every assigned geometry from the member list alone.

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

# Fine membership asks one question: does this region still cover LAND that no
# member already covers? Natural Earth 1:50m land polygons (public domain, vendored
# so a rebuild cannot drift) are the signal. 1:110m was measured first and drops ten
# of the twelve Caribbean places this rule exists to keep, so 50m is the floor.
#
# The mask is a DECISION input, not the definition of coverage: a member's assigned
# clip is still its full-precision Geofabrik residual, sea included, so nothing near
# a coastline is lost. The mask only decides WHICH regions become members, which is
# why a coarse-ish outline is good enough.
LAND_PATH = HERE / "land-50m.geojson"

# Natural Earth's coastlines and Geofabrik's cutting polygons do not agree to the
# metre, so every residual picks up a fringe of thin slivers along its coasts —
# `england`'s is 473 pieces totalling 0.0127 deg², none of them a place. Eroding by
# ~550 m deletes anything narrower than that while leaving a real one intact:
# San Marino, the smallest thing this rule must keep, is 0.0053 deg² in ONE piece
# and survives at 0.0038. What is left after erosion is land; the rest is slop.
LAND_SLOP_DEG = 0.005
LAND_EPSILON_DEG2 = 1e-4

# Can this shard be built on a runner at all? Density RSS scales with the cells
# INSIDE the clip, not with extract size, so a big extract clipped to a sliver is
# cheap in memory — what bounds it is disk: a density shard cannot use
# --unlink-source (stage 4 reads the raw extract), so peak is roughly extract +
# stage-1 intermediate against ~22 GB of runner. Hence the same 8 GB the coarse cap
# uses, for the same reason.
#
# The number matters more than it looks: at 1.5 GB — sized off quebec, the largest
# ORDINARY member — San Marino, Saint-Pierre-et-Miquelon, South Georgia and Kerguelen
# all fell out of the cover, because the only extract reaching each of them is a
# country or continent file. Their clips are tiny; only their sources are large.
MAX_FINE_BYTES = 8 * (1 << 30)


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


# A pbf response must actually be a pbf. Geofabrik lists regions whose extract does
# not exist — `enfield` is one — and serves the DIRECTORY LISTING for them: 200,
# text/html, Content-Length 9609. Taken at face value that is a 9.6 kB "extract",
# which is how a phantom region became fine shard #3, carved its polygon out of
# greater-london's clip, and left ~330,000 people in a permanent zero-density hole
# that no shard could ever fill. Any response that is not an octet-stream is a miss.
PBF_CONTENT_TYPES = ("application/octet-stream", "application/x-protobuf",
                     "application/x-osm-pbf", "binary/octet-stream")


def head_size(url: str) -> int | None:
    """The extract's size in bytes, or None when there is no extract at that URL.

    Content-Length via HEAD, falling back to a 1-byte ranged GET (both follow 302).
    A response is only believed when it is a 2xx whose Content-Type is a binary
    stream: see PBF_CONTENT_TYPES above for the failure this exists to catch.
    """
    def believable(response) -> bool:
        if not (200 <= response.status < 300):
            return False
        ctype = (response.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype and ctype not in PBF_CONTENT_TYPES:
            log(f"WARNING: {url} served {ctype!r}, not a pbf — treating as absent")
            return False
        return True

    try:
        request = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(request, timeout=60) as response:
            length = response.headers.get("Content-Length")
            if length and believable(response):
                return int(length)
    except Exception:
        pass
    try:
        request = urllib.request.Request(url, headers={"Range": "bytes=0-0"})
        with urllib.request.urlopen(request, timeout=60) as response:
            content_range = response.headers.get("Content-Range", "")
            if "/" in content_range and believable(response):
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


def load_land(path: Path = LAND_PATH):
    """(land polygons, STRtree over them) — the membership rule's only extra input."""
    data = json.loads(path.read_text(encoding="utf-8"))
    geoms = []
    for feature in data["features"]:
        geom = shape(feature["geometry"])
        geoms.append(geom if geom.is_valid else geom.buffer(0))
    log(f"land mask: {len(geoms)} polygons from {path.name}")
    return geoms, STRtree(geoms)


def land_area(geom, land) -> float:
    """Area of `geom` that is land once coastline slop is eroded away (LAND_SLOP_DEG)."""
    geoms, tree = land
    parts = [geom.intersection(geoms[i]) for i in tree.query(geom)]
    parts = [g for g in parts if not g.is_empty]
    if not parts:
        return 0.0
    eroded = unary_union(parts).buffer(-LAND_SLOP_DEG)
    return 0.0 if eroded.is_empty else eroded.area


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


def compute_fine(regions: list[Region], land) -> tuple[list[Region], dict[str, object], float]:
    """The disjoint fine cover: members IN THE DIFFERENCE ORDER, their assigned
    geometries, and the area (deg²) of LAND no member covers.

    ONE greedy pass over every region, ascending area, ties by id. A region becomes a
    member when its residual — itself minus the members already kept — still contains
    LAND, and its extract is small enough to build (MAX_FINE_BYTES). Two clauses,
    both asking the real question rather than a proxy for it: does this shard cover
    ground nobody else does, and can it be built at all.

    Land no member covers is therefore not silently lost — main() lists it and
    refuses to publish unless told to. That residue is where Geofabrik has no extract
    small enough to reach some island, and it is a decision to take deliberately.

    Two proxies were tried and both shipped holes. "A region that contains no other
    region" drops every region containing an ENCLAVE, which put London, Hanover,
    Marseille, Casablanca, Guangzhou, Sydney, Kyiv and Lviv in no shard at all.
    "A region at least 70% uncovered" drops one that is 62.9% uncovered, which is
    how central-america's Lesser Antilles and italy's San Marino went missing. Both
    were asking about AREA when the question is about TERRITORY, so both had a
    threshold, and a threshold on the wrong quantity always has a wrong side.

    Two details are load-bearing:

    * SUBTRACT ONLY KEPT MEMBERS. Differencing against a region that was itself
      skipped would carve territory out of a member's assigned polygon and hand it
      to nobody.
    * Each region is differenced only against the earlier kept members whose BBOX
      intersects it — identical to the full sequential difference, since a
      non-intersecting region subtracts nothing, and it is what keeps the pass
      affordable at 555 regions.
    """
    ordered = sorted(regions, key=lambda r: (r.area, r.id))
    tree = STRtree([r.geom for r in ordered])
    members: list[Region] = []
    assigned: dict[str, object] = {}
    kept: set[int] = set()
    covered: list[str] = []
    for i, region in enumerate(ordered):
        earlier = [j for j in tree.query(region.geom) if j < i and j in kept]
        residual = (region.geom.difference(unary_union([ordered[j].geom for j in earlier]))
                    if earlier else region.geom)
        buildable = region.est_bytes is None or region.est_bytes <= MAX_FINE_BYTES
        if (not residual.is_empty and buildable
                and land_area(residual, land) > LAND_EPSILON_DEG2):
            kept.add(i)
            members.append(region)
            assigned[region.id] = residual
        else:
            covered.append(region.id)
    log(f"fine membership: {len(members)} members of {len(regions)} regions "
        f"({len(covered)} cover no land a smaller member does not already cover)")

    # THE INVARIANT, asserted rather than estimated: every piece of land inside the
    # region union belongs to exactly one member. `uncovered` is what is left over,
    # and main() refuses to publish a cover with a non-trivial amount of it — that
    # is the whole guarantee, and it is why this function needs no other guard.
    all_land = unary_union([r.geom for r in regions]).intersection(
        unary_union(land[0]))
    uncovered = all_land.difference(unary_union([assigned[m.id] for m in members]))
    log(f"fine cover: {len(members)} disjoint members; "
        f"{uncovered.area:.4f} deg² of land uncovered")
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

    Full precision is deliberate — the assigned geometries partition the member union
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
    parser.add_argument("--allow-uncovered-land", action="store_true",
                        help="publish even when land belongs to no density shard "
                             "(there the map renders normally while the density "
                             "curses silently lift — see compute_fine)")
    parser.add_argument("--workers", default=16, type=int)
    args = parser.parse_args(argv)

    index, index_date = fetch_index(args.index_url)
    regions = load_regions(index)
    log(f"{len(regions)} regions in the index")

    # Sizes BEFORE membership, not after. An unavailable extract must not reach the
    # partition at all, because a phantom region is not merely a shard that fails to
    # build — it is a POLYGON, and the difference order subtracts it from the real
    # region that contains it. `enfield` (see head_size) was fine member #3 at a
    # 9.6 kB HTML directory listing, and its polygon was cut out of greater-london's
    # clip: ~330,000 people in a hole no shard could ever fill. Excluding it here is
    # what lets greater-london's residual absorb Enfield.
    if not args.no_sizes:
        fill_sizes(regions, args.workers)
        absent = sorted(r.id for r in regions if r.est_bytes is None)
        if absent:
            log(f"excluding {len(absent)} region(s) with no downloadable extract from "
                f"BOTH partitions: {', '.join(absent)}")
            regions = [r for r in regions if r.est_bytes is not None]

    fine_members, assigned, uncovered = compute_fine(regions, load_land())
    # THE ONE CHECK THIS FILE NEEDS. compute_fine's rule is "a member is a region
    # that still covers land nobody else covers", so its guarantee is that no land is
    # left over — and that is asserted here rather than estimated, before either
    # output is written. Land with no density shard is the silent failure: the coarse
    # cover still reaches it, so parks and water render normally, while worldDensity
    # returns no cells and geodata.js reads that as a real zero and DELETES Bridge
    # Troll, Luxury Car and Right Turn from the deck.
    pieces = [g for g in getattr(uncovered, "geoms", [uncovered])
              if g.area > LAND_EPSILON_DEG2]
    if pieces:
        listed = "; ".join(
            f"{g.area:.4f} deg² near {g.centroid.y:.2f},{g.centroid.x:.2f}"
            for g in sorted(pieces, key=lambda g: -g.area)[:8])
        message = (f"{len(pieces)} piece(s) of land totalling {uncovered.area:.4f} "
                   f"deg² belong to no density shard: {listed}.")
        if args.allow_uncovered_land:
            log(f"WARNING: {message} Continuing because --allow-uncovered-land "
                "was given.")
        else:
            raise SystemExit(
                f"{message}\n\nEvery place with a feature shard must have a density "
                "shard too, or the map renders there while the density curses "
                "silently lift. Nothing was written.")

    neighbor_map = neighbors(fine_members, assigned)

    cap_bytes = int(args.cap_gb * (1 << 30))
    coarse_members = compute_coarse(regions, fine_members, cap_bytes)

    fine_total = sum(r.est_bytes or 0 for r in fine_members)
    coarse_total = sum(r.est_bytes or 0 for r in coarse_members)
    largest_fine = max(fine_members, key=lambda r: r.est_bytes or 0, default=None)
    log(f"fine: {len(fine_members)} shards, {fine_total / 1e9:.1f} GB total"
        + (f", largest {largest_fine.id} at {(largest_fine.est_bytes or 0) / 1e9:.2f} GB"
           if largest_fine else ""))
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
