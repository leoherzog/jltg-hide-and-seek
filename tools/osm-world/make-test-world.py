#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyogrio>=0.13", "shapely>=2.1"]
# ///
"""
tools/osm-world/make-test-world.py — a miniature world file set, for end-to-end tests.

`make-fixture.py` proves `osm/flatgeobuf.js` can read a FlatGeobuf. This proves the
whole geo layer works: it writes a complete, manifest-described world directory — a few
category layers, the admin layer, the curse layers and the density grid — small enough
to serve from a local static server and run `collectGeodata` against for real.

That matters because `collectGeodata` is ~250 lines of orchestration that nothing
otherwise executes. It was shipped once with a function accidentally deleted out from
under it and the failure was invisible: `worker.js` catches everything from that call
and degrades to `emptyGeoData`, so a hard crash inside it looked exactly like an
unreachable origin. (`collectGeodata` now carries the real per-layer reasons out with
it, but the catch is still there and a test that only checks the OSM section is absent
would still have passed.)

    uv run tools/osm-world/make-test-world.py /tmp/world
    node tools/osm-world/test-pipeline.mjs /tmp/world

THE WORLD MIRRORS WHAT build.py NOW PRODUCES (DESIGN.md Phase 0 + Phase 1):

  * layers carry ONLY the runtime columns (R5) — the build projects the rest away;
  * the curse layers are 2-point bbox-diagonal linestrings with no properties (R1);
  * `curse_animal_habitat` does not exist; `green`, `green_recreation_ground` and
    `animal_delta` do, and their counts satisfy the partition identity the client
    reconstructs the habitat count from (R2);
  * the density grid omits zero-valued counts per cell (R4);
  * four layers — `pitch`, `coastline`, `curse_cairn_terrain`, `animal_delta` — are not
    hand-written at all: they are built from an embedded OSM XML fixture THROUGH
    build.py's real per-layer pipeline (tags-filter → export → dedup/diagonal →
    ogr2ogr), so the double-emit fix, the diagonal pass and the absent-column `where`
    guard are exercised on the actual code, not on a hand-made imitation of its output.
    This needs the `osmium` and `ogr2ogr` binaries, the same two the real build needs.

Geometry is placed around Grand Rapids, MI so the numbers are recognisable next to the
reference figures quoted throughout osm/geodata.js.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import shapely
from pyogrio.raw import write

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build  # noqa: E402 — build.py, the real pipeline; stdlib-only at import time

# All layers share one pinned column set: exactly the runtime columns the real build
# ships after R5 projects the build-only columns away (`runtime_columns` in
# categories.json). The client must work from these and nothing else — leisure,
# amenity, landuse and friends exist only inside the build's `where` clauses now.
COLUMNS = [
    "osm_type", "osm_id", "name", "name:en", "natural", "cuisine", "access", "foot",
    "entry", "opening_hours", "admin_level", "ISO3166-1", "ISO3166-1:alpha2",
    "ISO3166-2",
]

# key -> list of (osm_id, {column: value}, wkt). Props may name columns outside
# COLUMNS for documentation; only COLUMNS are written, exactly as R5 would.
LAYERS: dict[str, list] = {
    "park": [
        ("w101", {"name": "Ah-Nab-Awen Park"},
         "POLYGON ((-85.6790 42.9720, -85.6740 42.9720, -85.6740 42.9680, "
         "-85.6790 42.9680, -85.6790 42.9720))"),
        ("w102", {"name": "Riverside Park"},
         "POLYGON ((-85.6720 42.9760, -85.6670 42.9760, -85.6670 42.9720, "
         "-85.6720 42.9720, -85.6720 42.9760))"),
        # A node of the same category inside w101 — must be deduped away by featuresToPois.
        ("n103", {"name": "Ah-Nab-Awen Park"},
         "POINT (-85.6765 42.9700)"),
    ],
    "water": [
        # `natural` stays a runtime column because synthCoastline reads it off water
        # features (osm/geodata.js) — polygonal water only, rivers are not coasts.
        ("w201", {"name": "Grand River", "natural": "water"},
         "POLYGON ((-85.6800 42.9600, -85.6700 42.9620, -85.6700 42.9600, "
         "-85.6800 42.9580, -85.6800 42.9600))"),
        # CROSSES the map without a single vertex inside it. Both endpoints sit outside
        # the test bbox [42.9550,-85.6850,42.9800,-85.6600] on opposite corners, so a
        # vertex-only containment test drops it entirely while the R-tree still counts
        # it — the published count then disagrees with worldCount in the same run.
        # Real instance behind this: way 626208834 (Noordertocht), 33 vertices, none
        # inside a 0.008 deg Flevoland bbox, 550 m of canal crossing the map.
        ("w203", {"name": "Crossing Canal", "natural": "water"},
         "LINESTRING (-85.7000 42.9500, -85.6500 42.9900)"),
    ],
    "restaurant": [
        # `cuisine` is read off individual features by cuisineDetail — the reason
        # restaurant stays a feature layer instead of going into the density grid.
        ("n301", {"name": "Osteria", "cuisine": "italian"},
         "POINT (-85.6700 42.9650)"),
        ("n302", {"name": "Taqueria", "cuisine": "mexican"},
         "POINT (-85.6690 42.9655)"),
        ("n303", {"name": "Diner"},
         "POINT (-85.6680 42.9660)"),
    ],
    "bench": [
        ("n401", {}, "POINT (-85.6750 42.9690)"),
        ("n402", {"access": "private"}, "POINT (-85.6745 42.9695)"),
    ],
    "library": [
        ("n501", {"name": "Main Library", "opening_hours": "24/7"},
         "POINT (-85.6710 42.9670)"),
    ],
    # The positive term of the R2 partition identity, and a real category (legal-spot
    # weight 0.5). landuse in the source: forest, grass, recreation_ground — the
    # column itself is build-only and does not ship.
    "green": [
        ("w801", {"name": "Test Forest"},
         "POLYGON ((-85.6840 42.9560, -85.6820 42.9560, -85.6820 42.9580, "
         "-85.6840 42.9580, -85.6840 42.9560))"),
        ("w802", {"name": "Test Grass"},
         "POLYGON ((-85.6840 42.9590, -85.6820 42.9590, -85.6820 42.9610, "
         "-85.6840 42.9610, -85.6840 42.9590))"),
        ("w803", {"name": "Test Rec Ground"},
         "POLYGON ((-85.6840 42.9620, -85.6820 42.9620, -85.6820 42.9640, "
         "-85.6840 42.9640, -85.6840 42.9620))"),
    ],
    # An EMPTY layer is a real case — a map with no consulates — and the reader must
    # handle featuresCount == 0 rather than treating it as an error.
    "foreign_consulate": [],
    # admin_level 2 carries ISO3166-1 (the country code), level 4 carries ISO3166-2
    # (the principal subdivision) — which is how the ordinal ladder is anchored now
    # that Nominatim's ISO3166-2-lvl<N> is gone.
    "admin": [
        ("r901", {"name": "United States of America",
                  "admin_level": "2", "ISO3166-1": "US"},
         "POLYGON ((-86.0 42.5, -85.0 42.5, -85.0 43.5, -86.0 43.5, -86.0 42.5))"),
        ("r902", {"name": "Michigan",
                  "admin_level": "4", "ISO3166-2": "US-MI"},
         "POLYGON ((-86.0 42.5, -85.0 42.5, -85.0 43.5, -86.0 43.5, -86.0 42.5))"),
        ("r903", {"name": "Kent County", "admin_level": "6"},
         "POLYGON ((-85.9 42.8, -85.4 42.8, -85.4 43.2, -85.9 43.2, -85.9 42.8))"),
        ("r904", {"name": "Grand Rapids", "admin_level": "8"},
         "POLYGON ((-85.72 42.94, -85.60 42.94, -85.60 43.00, -85.72 43.00, "
         "-85.72 42.94))"),
        # THE BBOX-SUPERSET TRAP, and it is not hypothetical — this is Canada's real
        # shape problem in miniature. A country is one relation with one bounding box,
        # and Canada's spans lat 41.7-83.1 / lon -141..-52, which CONTAINS Grand Rapids.
        # The R-tree therefore returns it for a Michigan map. The geometry below is a
        # triangle in the far north-west whose bbox likewise covers the map while the
        # polygon itself comes nowhere near it.
        #
        # If `worldAdminAreas` ever stops filtering the superset by real geometry, this
        # feature wins the country vote on name order ('Canada' < 'United States of
        # America') and the page silently renders in kilometres, changes the Unguided
        # Tourist decision, and claims an international border 250 km from one.
        ("r905", {"name": "Canada",
                  "admin_level": "2", "ISO3166-1": "CA"},
         "POLYGON ((-141.0 84.0, -52.0 84.0, -141.0 41.0, -141.0 84.0))"),
    ],
}

# ── the count-only layers (DESIGN.md Phase 1 R1/R2) ────────────────────────────
#
# What the real build ships for these: one 2-point (minX,minY)→(maxX,maxY) linestring
# per feature, NO properties. The source geometry below is what the envelope is
# computed FROM — it never ships. `worldCount` walks the R-tree, and a diagonal has
# exactly its source's envelope, so every count is unchanged.
#
# curse_water is a proper SUPERSET of the water category: the curse says "marked",
# the category says "named", and on a real map they differ by 8:1. w202 is marked but
# unnamed; the crossing canal keeps its envelope-clips-the-map behaviour.
DIAGONAL_LAYERS: dict[str, list[str]] = {
    "curse_water": [
        LAYERS["water"][0][2],                       # w201 Grand River polygon
        "POLYGON ((-85.6650 42.9600, -85.6600 42.9600, -85.6600 42.9560, "
        "-85.6650 42.9560, -85.6650 42.9600))",      # w202 unnamed pond
        LAYERS["water"][1][2],                       # w203 Crossing Canal
    ],
    "curse_travel_agent_stop": [
        LAYERS["park"][0][2],                        # w101 Ah-Nab-Awen Park
    ],
    # R2 partition terms. The identity the client reconstructs the habitat count from:
    #   count(habitat) == count(green) − count(green_recreation_ground)
    #                     + count(animal_delta)
    # green_recreation_ground = green's recreation_ground members  = {w803}
    # animal_delta            = leisure(park,nature_reserve) ∪ named water,
    #                           minus green's landuse-4-set members
    #                         = {w101, w102, w201, w203}
    # so over the test bbox: 3 − 1 + 4 = 6 == |{w101,w102,w801,w802,w201,w203}|.
    #
    # `animal_delta` is NOT here: it is built through build.py for real (see
    # ANIMAL_DELTA_SOURCE), over the same four features and therefore the same four
    # envelopes, so the identity above is unchanged.
    "green_recreation_ground": [
        LAYERS["green"][2][2],                       # w803
    ],
}

# ── the layers built through build.py's REAL pipeline ────────────────────────
#
# An OSM XML fixture with the cases DESIGN.md Phase 0 exists for:
#   w7101  a CLOSED way (leisure=pitch)      — must export exactly ONCE (the old
#                                              all-types export wrote it twice);
#   w7102  an UNCLOSED way with an area tag  — a mapping error, dropped by the
#                                              point,polygon geometry class;
#   w7103  a closed coastline way (island)   — the mixed-layer case: linestring must
#                                              stay in the export, so the polygon
#                                              survives via the dedup pass instead;
#   w7104  an open coastline way             — the reason linestring must stay;
#   w7105  a closed natural=wood way         — diagonalized (R1) and id-deduped;
#   n7018  a natural=beach node              — a DEGENERATE diagonal (point envelope).
#
# `animal_delta` is built here too, and for a different reason: THE ABSENT-COLUMN CASE.
# Its `where` reads `landuse` only to exclude what `green` already counted, but nothing
# in its own tags-filter cut carries `landuse` — so `osmium export` never writes that
# column and `ogr2ogr` rejects the whole attribute filter over it. Under the
# `-skipfailures` the build passes, that is not even an error: exit 0, and every feature
# copied through UNFILTERED. This fixture is exactly the shape any small extract has, and
# it is the regression test for `build.rewrite_where` — if the fold stops working the
# diagonal count below stops being 4 and `test-pipeline.mjs` fails on the R2 identity.
PIPELINE_KEYS = ("pitch", "coastline", "curse_cairn_terrain", "animal_delta")

# The animal_delta source, generated into the fixture from the SAME WKT the hand-written
# layers use, so the envelopes the identity is measured over cannot drift apart. Tags
# are the build-only ones (`leisure`, `natural`, `name`) — deliberately no `landuse`.
#
# w204 is the DETECTOR and the only reason this fixture can fail. The four features
# above all satisfy the `where`, so a `where` that silently stopped being applied would
# still yield 4 and prove nothing. w204 is unnamed water: the selector rejects it, an
# unfiltered pass keeps it, and 5 diagonals break the R2 identity in test-pipeline.mjs.
ANIMAL_DELTA_SOURCE = [
    ("w101", {"leisure": "park", "name": "Ah-Nab-Awen Park"}, LAYERS["park"][0][2]),
    ("w102", {"leisure": "park", "name": "Riverside Park"}, LAYERS["park"][1][2]),
    ("w201", {"natural": "water", "name": "Grand River"}, LAYERS["water"][0][2]),
    ("w203", {"natural": "water", "name": "Crossing Canal"}, LAYERS["water"][1][2]),
    ("w204", {"natural": "water"},
     "POLYGON ((-85.6630 42.9700, -85.6610 42.9700, -85.6610 42.9720, "
     "-85.6630 42.9720, -85.6630 42.9700))"),
]

PIPELINE_OSM_HEAD = """<?xml version='1.0' encoding='UTF-8'?>
<osm version="0.6" generator="make-test-world">
  <node id="7001" lat="42.9560" lon="-85.6660"/>
  <node id="7002" lat="42.9560" lon="-85.6640"/>
  <node id="7003" lat="42.9580" lon="-85.6640"/>
  <node id="7004" lat="42.9580" lon="-85.6660"/>
  <node id="7005" lat="42.9590" lon="-85.6650">
    <tag k="leisure" v="pitch"/>
  </node>
  <node id="7006" lat="42.9600" lon="-85.6700"/>
  <node id="7007" lat="42.9610" lon="-85.6690"/>
  <node id="7008" lat="42.9700" lon="-85.6800"/>
  <node id="7009" lat="42.9700" lon="-85.6780"/>
  <node id="7010" lat="42.9720" lon="-85.6780"/>
  <node id="7011" lat="42.9720" lon="-85.6800"/>
  <node id="7012" lat="42.9740" lon="-85.6820"/>
  <node id="7013" lat="42.9760" lon="-85.6800"/>
  <node id="7014" lat="42.9560" lon="-85.6750"/>
  <node id="7015" lat="42.9560" lon="-85.6730"/>
  <node id="7016" lat="42.9580" lon="-85.6730"/>
  <node id="7017" lat="42.9580" lon="-85.6750"/>
  <node id="7018" lat="42.9565" lon="-85.6710">
    <tag k="natural" v="beach"/>
  </node>
  <way id="7101">
    <nd ref="7001"/><nd ref="7002"/><nd ref="7003"/><nd ref="7004"/><nd ref="7001"/>
    <tag k="leisure" v="pitch"/>
    <tag k="name" v="Closed Pitch"/>
  </way>
  <way id="7102">
    <nd ref="7006"/><nd ref="7007"/>
    <tag k="leisure" v="pitch"/>
    <tag k="name" v="Unclosed Pitch"/>
  </way>
  <way id="7103">
    <nd ref="7008"/><nd ref="7009"/><nd ref="7010"/><nd ref="7011"/><nd ref="7008"/>
    <tag k="natural" v="coastline"/>
  </way>
  <way id="7104">
    <nd ref="7012"/><nd ref="7013"/>
    <tag k="natural" v="coastline"/>
  </way>
  <way id="7105">
    <nd ref="7014"/><nd ref="7015"/><nd ref="7016"/><nd ref="7017"/><nd ref="7014"/>
    <tag k="natural" v="wood"/>
  </way>
"""


def ways_as_osm_xml(rows: list, first_node_id: int = 8001) -> str:
    """
    WKT LINESTRING/POLYGON rows → OSM XML `<node>`/`<way>` elements.

    Generated rather than hand-written so a fixture way and the hand-written layer it
    mirrors cannot drift: both read the same WKT string. A polygon's closing coordinate
    is not given its own node — the way references the first node again, which is what
    makes it closed to osmium.
    """
    node_id = first_node_id
    nodes: list[str] = []
    ways: list[str] = []
    for osm_id, tags, wkt in rows:
        geometry = shapely.from_wkt(wkt)
        coords = list(geometry.exterior.coords if geometry.geom_type == "Polygon"
                      else geometry.coords)
        closed = coords[0] == coords[-1]
        if closed:
            coords = coords[:-1]
        refs = []
        for lon, lat in coords:
            nodes.append(f'  <node id="{node_id}" lat="{lat:.7f}" lon="{lon:.7f}"/>')
            refs.append(node_id)
            node_id += 1
        if closed:
            refs.append(refs[0])
        body = "".join(f'<nd ref="{ref}"/>' for ref in refs)
        tag_xml = "".join(f'\n    <tag k="{k}" v="{v}"/>' for k, v in tags.items())
        ways.append(f'  <way id="{int(osm_id[1:])}">\n    {body}{tag_xml}\n  </way>')
    return "\n".join(nodes + ways) + "\n"


PIPELINE_OSM = PIPELINE_OSM_HEAD + ways_as_osm_xml(ANIMAL_DELTA_SOURCE) + "</osm>\n"

# The density grid: one point per populated cell, an integer column per category —
# with zero-valued counts OMITTED per cell (R4), exactly as stage_density writes them.
# The client reads an absent key as 0, so the map-wide sums are unchanged.
DENSITY_KEYS = ["building", "street", "car_street", "footpath", "bridge", "tree"]
DENSITY_CELLS = [
    (-85.675, 42.965, [120, 14, 11, 6, 1, 40]),
    (-85.673, 42.967, [98, 12, 9, 5, 0, 33]),    # bridge 0 → column absent in this cell
    (-85.671, 42.969, [140, 16, 13, 7, 2, 51]),
    (-85.669, 42.971, [87, 10, 8, 4, 0, 28]),
    # Far outside the test bbox — must NOT be counted.
    (-85.900, 43.400, [999, 99, 99, 99, 9, 999]),
]

CELL_DEG = 0.002


def write_layer(out: Path, key: str, rows: list) -> Path:
    path = out / f"{key}.fgb"
    geometry = np.array(
        [shapely.to_wkb(shapely.from_wkt(wkt)) for _, _, wkt in rows], dtype=object,
    )
    kinds = {"n": "node", "w": "way", "r": "relation"}

    def column(col):
        if col == "osm_type":
            return np.array([kinds[oid[0]] for oid, _, _ in rows], dtype=object)
        if col == "osm_id":
            return np.array([int(oid[1:]) for oid, _, _ in rows], dtype=np.int64)
        return np.array([props.get(col) for _, props, _ in rows], dtype=object)

    field_data = [column(col) for col in COLUMNS]
    write(
        str(path), geometry=geometry, field_data=field_data,
        fields=np.array(COLUMNS, dtype=object),
        driver="FlatGeobuf", geometry_type="Unknown", crs="EPSG:4326",
        layer=key, SPATIAL_INDEX="YES",
    )
    return path


def ogr2ogr_fgb(dst: Path, src: Path, layer: str, nlt: str) -> None:
    subprocess.run([
        "ogr2ogr", "-f", "FlatGeobuf", str(dst), str(src),
        "-nln", layer, "-lco", "SPATIAL_INDEX=YES", "-nlt", nlt,
    ], check=True)


def write_diagonal_layer(out: Path, key: str, wkts: list[str], tmp: Path) -> Path:
    """R1's shape, from the source geometry's bounds: diagonal, no properties."""
    grid = tmp / f"{key}.geojsonl"
    with grid.open("w", encoding="utf-8") as dst:
        for wkt in wkts:
            min_x, min_y, max_x, max_y = shapely.from_wkt(wkt).bounds
            dst.write(json.dumps({
                "type": "Feature",
                "geometry": {"type": "LineString",
                             "coordinates": [[min_x, min_y], [max_x, max_y]]},
                "properties": {},
            }, separators=(",", ":")) + "\n")
    path = out / f"{key}.fgb"
    ogr2ogr_fgb(path, grid, key, "LINESTRING")
    return path


def write_density(out: Path, tmp: Path) -> Path:
    grid = tmp / "density.geojsonl"
    with grid.open("w", encoding="utf-8") as dst:
        for lon, lat, counts in DENSITY_CELLS:
            dst.write(json.dumps({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                # R4: zeros omitted, mirroring stage_density.
                "properties": {k: c for k, c in zip(DENSITY_KEYS, counts) if c != 0},
            }, separators=(",", ":")) + "\n")
    path = out / "density.fgb"
    ogr2ogr_fgb(path, grid, "density", "POINT")
    return path


def build_pipeline_layers(out: Path, tmp: Path) -> dict[str, Path]:
    """PIPELINE_KEYS from the XML fixture, through build.py's real per-layer chain."""
    source = tmp / "fixture.osm"
    source.write_text(PIPELINE_OSM, encoding="utf-8")
    work = tmp / "work"
    work.mkdir(exist_ok=True)
    table = build.load_table(build.TABLE_PATH)
    by_key = {layer.key: layer for layer in table.feature_layers}
    built: dict[str, Path] = {}
    for key in PIPELINE_KEYS:
        fgb = build.build_layer(source, by_key[key], work, out, table, force=True)
        if fgb is None:
            raise SystemExit(f"pipeline layer {key} produced no output")
        built[key] = fgb
    return built


def main() -> int:
    missing = [b for b in ("osmium", "ogr2ogr", "ogrinfo") if shutil.which(b) is None]
    if missing:
        raise SystemExit(
            f"make-test-world needs {', '.join(missing)} on PATH — the same binaries "
            "the real build uses (osmium-tool and gdal packages). Three test layers "
            "are built through build.py's actual pipeline, not imitated.")

    out = Path(sys.argv[1] if len(sys.argv) > 1 else "build/test-world")
    out.mkdir(parents=True, exist_ok=True)

    built: dict[str, Path] = {}
    counts: dict[str, int] = {}
    with tempfile.TemporaryDirectory() as tmpname:
        tmp = Path(tmpname)
        for key, rows in LAYERS.items():
            built[key] = write_layer(out, key, rows)
            counts[key] = len(rows)
        for key, wkts in DIAGONAL_LAYERS.items():
            built[key] = write_diagonal_layer(out, key, wkts, tmp)
            counts[key] = len(wkts)
        for key, path in build_pipeline_layers(out, tmp).items():
            built[key] = path
            counts[key] = build.feature_count(path)
        built["density"] = write_density(out, tmp)
        counts["density"] = len(DENSITY_CELLS)

    manifest = {
        "version": 1,
        "cell_deg": CELL_DEG,
        "planet_timestamp": "2026-07-01T00:00:00Z",
        "layers": {
            key: {
                "path": path.name,
                "bytes": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "features": counts[key],
            }
            for key, path in sorted(built.items())
        },
    }
    # BOTH legal shapes of "this layer is present and empty" are in this world:
    #   * `foreign_consulate` above ships a real zero-feature .fgb (build.py's shape);
    #   * `mountain` here is merge.py's shape — a PATH-LESS `{"features": 0}` entry,
    #     written when a layer is empty across every merged region, so the manifest can
    #     say "exists, answer is zero" without a file. The client must answer 0 / []
    #     for either, and must never build a reader for the path-less one — a naive
    #     `baseUrl + '/' + info.path` yields '<base>/undefined' and throws.
    # `mountain` is a real category (reference count 0 around Grand Rapids), so the
    # end-to-end run exercises the path through collectGeodata, not just worldCount.
    manifest["layers"]["mountain"] = {"features": 0}
    (out / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    total = sum(p.stat().st_size for p in built.values())
    print(f"wrote {len(built)} layers + manifest.json to {out} ({total} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
