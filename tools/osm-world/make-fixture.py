#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyogrio>=0.13", "shapely>=2.1"]
# ///
"""
tools/osm-world/make-fixture.py — write the FlatGeobuf `osm/flatgeobuf.js` is tested on.

`osm/flatgeobuf.js` is a hand-written reader for a binary format. The only way to know
its FlatBuffers vtable arithmetic and its R-tree walk are right is to point it at a file
GDAL produced and check it reads back what went in — so this writes one, deliberately
covering every shape the reader has a branch for:

  * a bare Point, and a MultiPoint
  * a LineString, and a MultiLineString (which exercises the longest-part choice in
    `representativeFromGeometry`)
  * a Polygon WITH A HOLE — the case a flattened ring list silently gets wrong
  * a MultiPolygon of two disjoint parts
  * string, integer and absent properties, since an absent column is how the build's
    `name IS NOT NULL` survives the round trip
  * enough features to force the packed R-tree to have more than one level, which is
    the only way the descent path in `search` is exercised at all

Run it via `uv run tools/osm-world/make-fixture.py <out.fgb>`; pyogrio ships GDAL in its
wheel, so this needs no system GDAL.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import shapely
from pyogrio.raw import write

# (osm_id, name, category_rank, wkt) — the rank column exists to prove integer columns
# decode, since every other property here is a string.
FEATURES: list[tuple[str, str | None, int, str]] = [
    ("n1", "Bench by the path", 1, "POINT (-85.6681 42.9634)"),
    ("n2", None, 2, "POINT (-85.6700 42.9640)"),
    ("w3", "Ah-Nab-Awen Park", 3,
     "POLYGON ((-85.6760 42.9700, -85.6700 42.9700, -85.6700 42.9660, "
     "-85.6760 42.9660, -85.6760 42.9700), "
     "(-85.6740 42.9690, -85.6720 42.9690, -85.6720 42.9670, "
     "-85.6740 42.9670, -85.6740 42.9690))"),
    ("w4", "Grand River", 4,
     "LINESTRING (-85.6800 42.9600, -85.6750 42.9650, -85.6700 42.9700)"),
    ("r5", "Riverside Park", 5,
     "MULTIPOLYGON (((-85.6900 42.9800, -85.6850 42.9800, -85.6850 42.9760, "
     "-85.6900 42.9760, -85.6900 42.9800)), "
     "((-85.6840 42.9820, -85.6800 42.9820, -85.6800 42.9790, "
     "-85.6840 42.9790, -85.6840 42.9820)))"),
    ("w6", "Split Creek", 6,
     "MULTILINESTRING ((-85.7000 42.9500, -85.6990 42.9510), "
     "(-85.6980 42.9520, -85.6900 42.9600, -85.6850 42.9650))"),
    ("n7", "Twin markers", 7, "MULTIPOINT ((-85.6600 42.9500), (-85.6590 42.9510))"),
    # A node sitting inside w3's outer ring, same category — the dedup case.
    ("n8", "Ah-Nab-Awen Park", 3, "POINT (-85.6710 42.9665)"),
]

# Padding, for two reasons. The default branching factor is 16, so a small file would
# leave the descent in `search` untested — 2,008 features build a four-level tree. And
# the file has to be comfortably larger than the reader's 16 kB header probe, or the
# first request swallows the whole thing and "did it really use Range requests" cannot
# be asserted at all.
PADDING = 2000


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "fixture.fgb")

    rows = list(FEATURES)
    for i in range(PADDING):
        lon = -85.90 + (i % 10) * 0.004
        lat = 42.90 + (i // 10) * 0.004
        rows.append((f"n{1000 + i}", f"Filler {i}", 100 + i, f"POINT ({lon} {lat})"))

    geometry = np.array(
        [shapely.to_wkb(shapely.from_wkt(wkt)) for _, _, _, wkt in rows],
        dtype=object,
    )
    # Two columns, matching what `osmium export -c` writes: the identity must live in
    # `properties`, never in the GeoJSON Feature-level `id` member.
    kinds = {"n": "node", "w": "way", "r": "relation"}
    osm_type = np.array([kinds[r[0][0]] for r in rows], dtype=object)
    osm_id = np.array([int(r[0][1:]) for r in rows], dtype=np.int64)
    name = np.array([r[1] for r in rows], dtype=object)
    rank = np.array([r[2] for r in rows], dtype=np.int32)

    write(
        str(out),
        geometry=geometry,
        field_data=[osm_type, osm_id, name, rank],
        fields=np.array(["osm_type", "osm_id", "name", "rank"], dtype=object),
        driver="FlatGeobuf",
        # Mixed geometry types in one layer, exactly as the real category files are.
        geometry_type="Unknown",
        crs="EPSG:4326",
        layer="fixture",
        SPATIAL_INDEX="YES",
    )
    print(f"wrote {out} — {len(rows)} features, {out.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
