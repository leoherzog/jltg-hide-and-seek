#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
tools/osm-world/merge.py — merge per-shard build.py outputs into one global world.

    uv run tools/osm-world/merge.py --shards <dir> --admin <admin.fgb> --out <dir>

`--shards` holds ONE DIRECTORY PER SHARD BUILD, each being a `build.py --out`
directory (its `manifest.json` plus `<layer>.fgb` files), AT ANY NESTING DEPTH —
discovery is recursive because the documented R2 sync layout nests ids with slashes
(`shards/feature/us/michigan/` syncs to `us/michigan/`), and a flat-only scan would
silently drop every nested shard from the merge. A directory holding `.fgb` files but
NO `manifest.json` is a failed/interrupted build's leavings and is a HARD ERROR
(`--allow-incomplete` opts out) — a merge that quietly skips it publishes counts that
are silently short. The merge produces the one world the client sees: a single
FlatGeobuf per layer with one Hilbert R-tree, a global density grid, the Overture
admin layer, and one `manifest.json`.

WHY THE MECHANICS LOOK THE WAY THEY DO (all measured, spike S1 on kadro):

  * Shard FGB schemas are SPARSE AND DIFFER per shard — osmium only writes the
    `include_tags` a shard's features actually carry, so bremen's `green` may have 19
    columns where a monolith has 30. A plain `ogr2ogr -append` SILENTLY DROPS columns
    that first appear in a later shard. The merge therefore reads every layer through
    an OGRVRTUnionLayer with `FieldStrategy=Union`, which is the documented way to get
    the schema union.

  * Dedup goes VRT → GPKG (`-lco SPATIAL_INDEX=NO`) → one SQL DELETE keeping MIN(fid)
    per identity → plain ogr2ogr GPKG→FGB. Keeping MIN(fid) over a fixed shard order
    (sorted subdirectory names) makes WHICH duplicate survives deterministic, which is
    what makes re-runs byte-identical and content-addressed filenames stable.
    A single-pass `-dialect SQLITE ... GROUP BY` over the VRT was benchmarked too
    (`--strategy groupby`); SQLite picks bare columns from an arbitrary row under
    GROUP BY, so it is not the default — correctness and determinism first.

  * The FlatGeobuf writer's peak RSS is ~166 MB + 100 B/feature (the Hilbert index
    build at close()), so RAM is not the constraint at any plausible layer size. Disk
    is: the writer stages a hidden unlinked temp IN THE OUTPUT DIRECTORY (~2× the
    final bytes, `CPL_TMPDIR` does not redirect it), so the merge needs transient free
    space of about twice its largest layer on the output filesystem.

WHAT GETS MERGED HOW:

  * Feature layers with identity (every category layer): schema-union across shards,
    dedup on `(osm_type, osm_id)`. Before merging, every shard input is asserted to
    already satisfy rows == distinct(osm_type, osm_id) — Phase 0 upstream guarantees
    it, and the merge must FAIL LOUDLY rather than silently absorb a double-emit
    regression (`--no-assert` opts out). The merged output is asserted the same way.

  * count_only layers (curse_water, curse_cairn_terrain, curse_travel_agent_stop,
    green_recreation_ground, animal_delta): these are 2-point bbox-diagonal
    linestrings with ZERO property columns (verified against michigan-v2), so
    cross-shard dedup on ids is impossible by design. They are deduped on EXACT
    GEOMETRY BYTES instead — two shards exporting the same way produce the same
    envelope, hence the same diagonal, hence the same GPKG geometry blob. KNOWN
    RESIDUAL: a feature whose coordinates differ between shards (e.g. a relation
    clipped differently at an extract boundary) survives as a duplicate. MEASURED
    on the bremen+hamburg+berlin test merge (curse_travel_agent_stop, 22,343 rows):
    0 cross-shard residuals at 1e-4° tolerance — but those extracts are not
    adjacent, so treat that as a lower bound for buffered neighbours. KNOWN
    UNDER-COUNT: two DISTINCT entities with byte-identical diagonals collapse too
    (all 8 duplicates dropped in that merge were such within-shard pairs — e.g.
    two stops on the same node coordinate). Both effects move diagnostic counts
    by a hair; count_only layers carry no identity the client could miss.

  * density: cells are summed by `(row, col)` across shards. The grid is rebuilt
    exactly the way `stage_density` writes it — points at cell centres rounded to 7
    decimals, zero-valued properties omitted per cell (R4), sorted by (row, col) —
    so a single-shard merge round-trips. Aggregation is external-sort based
    (`sort`), not a dict, because a planet grid is 90–196M cells and a Python dict
    at that size is the exact RAM wall that killed the monolith build.

  * admin: NOT merged from shards (per-shard admin is broken by construction —
    boundary relations only assemble inside their extract). It is taken verbatim from
    `--admin`, the Overture division_area build (`build-admin.sh`), hardlinked or
    copied into the output under its content-addressed name, and the manifest says
    `"admin_source": "overture"` so the client picks the Overture ordinal table.

THE MANIFEST is build.py's shape plus:
  * `admin_source: "overture"`;
  * explicit `{"features": 0}` entries for FEATURE layers legitimately empty in
    every shard — a failed job must not look like an empty layer. DENSITY is the
    exception: the client trusts a present-but-empty density grid as a real zero
    (which lifts the density-based curses), and zero density cells for a real
    region is always an operational failure — so a merge with zero density
    contributions is a HARD ERROR, and `--allow-missing-density` omits the layer
    entirely (absent => the client degrades, the safe direction). Never
    `density: {"features": 0}`;
  * `planet_timestamp` = the OLDEST contributing shard's timestamp (the honest "as
    of" for the whole world); an `--only` merge-into keeps the OLDEST of the
    existing manifest's value and this run's, since the untouched layers still
    date from the old run — and it hard-errors if this run's `cell_deg` differs
    from the existing manifest's;
  * per-layer `bbox` `[minX, minY, maxX, maxY]`, so the client can skip layers that
    cannot intersect its map;
  * content-addressed filenames `<layer>.<sha256-prefix-12>.fgb` — unchanged layers
    keep their URL across rebuilds, and `manifest.json` is the only mutable object;
  * top-level `"partial": true` (the pinned client rule) whenever the layer table is
    not the full table — which only an `--only` run or `--allow-missing-density`
    can produce, since a full merge otherwise lists every key (empty feature
    layers as `features: 0`). An `--only` run also merges into an existing
    manifest.json in --out instead of clobbering the layers it did not touch —
    dropping (loudly) any existing keys the current layer table no longer
    contains — and clears `partial` once the table is complete.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
TABLE_PATH = HERE / "categories.json"

SHA_PREFIX = 12


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    log("$ " + " ".join(cmd))
    return subprocess.run(cmd, check=True, **kwargs)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ═══════════════════════════════════════════════════════════════════════════════
# The build table — merge.py reads the same categories.json as build.py
# ═══════════════════════════════════════════════════════════════════════════════


def load_table() -> dict:
    raw = json.loads(TABLE_PATH.read_text(encoding="utf-8"))
    identity_layers = [e["key"] for e in raw["categories"]]
    count_only_layers = [e["key"] for e in raw["curse_layers"]
                         if e.get("count_only")]
    # A curse layer that is NOT count_only would carry identity and belong with the
    # category layers. None exist today; handle it rather than silently mis-merging.
    identity_layers += [e["key"] for e in raw["curse_layers"]
                        if not e.get("count_only")]
    return {
        "identity": identity_layers,
        "count_only": count_only_layers,
        "density_keys": [e["key"] for e in raw["density"]["layers"]],
        "cell_deg": float(raw["density"]["cell_deg"]),
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Shard discovery
# ═══════════════════════════════════════════════════════════════════════════════


def find_shards(shards_dir: Path, allow_incomplete: bool = False) -> list[Path]:
    """Every directory under `shards_dir` holding a manifest.json — `shards_dir`
    ITSELF included — RECURSIVELY, in sorted relative-path order, without descending
    INTO a shard build (a shard's own subdirectories, e.g. a stray work/, are its
    business, not more shards).

    Recursion is required, not a nicety: R2 shard ids contain slashes
    (`shards/feature/us/michigan/`), so an `aws s3 sync` of that prefix produces
    `us/michigan/` — one level deeper than a flat scan looks. A flat scan run on a
    planet sync would find the single-level European ids and SILENTLY lose all 52
    `us/*` shards. `shards_dir` itself is a candidate first, so pointing --shards
    straight at ONE build directory (manifest.json at the root) is a single-shard
    merge rather than a "no shards found" error.

    SYMLINKED DIRECTORIES ARE FOLLOWED, WITH A VISITED-REALPATH GUARD. Following
    symlinks is what lets a merge tree be assembled from links to out-of-tree
    builds (`ln -s ~/osm-builds/michigan-v3 tree/michigan`) instead of copying
    gigabytes — skipping them silently would publish a short world. The guard is
    what makes following safe: every directory's realpath is recorded, a second
    reach of a NON-shard directory (a symlink cycle or a diamond route) is skipped
    with a log line and the walk terminates, and a second reach of a SHARD is a
    HARD ERROR naming both paths — a shard merged twice is not a cosmetic bug,
    because density cells are summed ADDITIVELY across shards, so every duplicate
    discovery doubles that shard's density contribution. Known limit: the guard
    resolves symlinks only. Two bind-mounted views of one directory have distinct
    realpaths and would NOT be detected — do not build merge trees out of bind
    mounts.

    A directory containing `*.fgb` files but no manifest.json is what a failed or
    interrupted build leaves behind (build.py writes the manifest LAST). Merging
    around it would publish silently-short counts, so it is a hard error listing
    every offender; `--allow-incomplete` downgrades it to a warning for deliberate
    partial merges. That rule applies to `shards_dir` itself too: stray root `.fgb`
    files without a manifest are the same hard error as anywhere else.

    The order is load-bearing: it fixes GPKG insertion order, which fixes which
    duplicate MIN(fid) keeps, which is what makes re-runs byte-identical.
    """
    shards: list[Path] = []
    incomplete: list[Path] = []
    visited: dict[str, Path] = {}  # realpath -> the path it was first reached as
    shard_reals: set[str] = set()  # realpaths that turned out to be shard builds

    def walk(directory: Path) -> None:
        real = os.path.realpath(directory)
        first = visited.get(real)
        if first is not None:
            if real in shard_reals:
                raise SystemExit(
                    f"shard discovery reached the same shard twice: {first} and "
                    f"{directory} both resolve to {real}. A shard merged twice "
                    f"double-counts density additively, so this is a hard error "
                    f"— remove the duplicate route under {shards_dir}.")
            # A cycle or diamond over a NON-shard directory: its contents were
            # already walked from `first`, so there is nothing to lose by
            # stopping here — but say so, silence is how worlds come up short.
            log(f"shard discovery: skipping {directory} — already walked as "
                f"{first} (symlink cycle or duplicate route)")
            return
        visited[real] = directory
        if (directory / "manifest.json").exists():
            shard_reals.add(real)
            shards.append(directory)
            return  # a shard build; do not descend
        has_fgb = any(entry.is_file() and entry.suffix == ".fgb"
                      for entry in directory.iterdir())
        if has_fgb:
            incomplete.append(directory)
        for entry in sorted(directory.iterdir()):
            # Symlinked directories ARE followed (out-of-tree shard links are a
            # supported layout); cycles terminate via the visited-realpath guard
            # above rather than the kernel's ELOOP.
            if entry.is_dir():
                walk(entry)

    walk(shards_dir)

    if incomplete:
        listing = "\n  ".join(str(p) for p in sorted(incomplete))
        if allow_incomplete:
            log(f"WARNING: --allow-incomplete — ignoring {len(incomplete)} "
                f"director(y|ies) with .fgb files but no manifest.json:\n  {listing}")
        else:
            raise SystemExit(
                f"{len(incomplete)} director(y|ies) under {shards_dir} hold .fgb "
                f"files but NO manifest.json — a failed or interrupted shard build "
                f"(build.py writes the manifest last):\n  {listing}\n"
                "Rebuild or remove them, or pass --allow-incomplete to merge "
                "without them (the merged counts will be short for those regions).")

    shards.sort(key=lambda d: d.relative_to(shards_dir).as_posix())
    if not shards:
        raise SystemExit(f"no shard builds found under {shards_dir} "
                         "(expected directories each holding a manifest.json)")
    return shards


def shard_manifest(shard: Path) -> dict:
    return json.loads((shard / "manifest.json").read_text(encoding="utf-8"))


# ═══════════════════════════════════════════════════════════════════════════════
# ogrinfo probes
# ═══════════════════════════════════════════════════════════════════════════════


_COUNT_RE = re.compile(r"^\s*n \(Integer(?:64)?\) = (\d+)", re.MULTILINE)
_DISTINCT_RE = re.compile(r"^\s*d \(Integer(?:64)?\) = (\d+)", re.MULTILINE)


def rows_and_distinct(fgb: Path, layer: str) -> tuple[int, int]:
    """(row count, distinct (osm_type, osm_id) count) for one FlatGeobuf layer."""
    out = subprocess.run(
        ["ogrinfo", "-dialect", "SQLITE", "-sql",
         f'SELECT COUNT(*) AS n, COUNT(DISTINCT osm_type || \'/\' || osm_id) AS d '
         f'FROM "{layer}"',
         str(fgb)],
        check=True, capture_output=True, text=True,
    ).stdout
    n = _COUNT_RE.search(out)
    d = _DISTINCT_RE.search(out)
    if not n or not d:
        raise SystemExit(f"could not parse rows/distinct from ogrinfo on {fgb}:\n{out}")
    return int(n.group(1)), int(d.group(1))


def feature_count(fgb: Path) -> int:
    out = subprocess.run(
        ["ogrinfo", "-so", "-al", str(fgb)],
        check=True, capture_output=True, text=True,
    ).stdout
    match = re.search(r"^Feature Count:\s*(\d+)", out, re.MULTILINE)
    return int(match.group(1)) if match else 0


def layer_extent(fgb: Path) -> list[float] | None:
    """[minX, minY, maxX, maxY] read off the FlatGeobuf header via ogrinfo -so."""
    out = subprocess.run(
        ["ogrinfo", "-so", "-al", str(fgb)],
        check=True, capture_output=True, text=True,
    ).stdout
    match = re.search(
        r"^Extent:\s*\(([-\d.eE+]+),\s*([-\d.eE+]+)\)\s*-\s*"
        r"\(([-\d.eE+]+),\s*([-\d.eE+]+)\)",
        out, re.MULTILINE,
    )
    if not match:
        return None
    return [float(match.group(i)) for i in (1, 2, 3, 4)]


# ═══════════════════════════════════════════════════════════════════════════════
# Feature-layer merge: VRT union → GPKG → SQL dedup → FGB
# ═══════════════════════════════════════════════════════════════════════════════


def write_union_vrt(layer: str, inputs: list[Path], work: Path) -> Path:
    """The schema-union view over every shard's copy of one layer.

    `FieldStrategy=Union` is the entire point: shard schemas are sparse and differ,
    and a plain append silently drops columns first appearing in later shards.

    EVERY INPUT IS CHECKED TO EXIST FIRST, and that check is the only thing standing
    between a half-synced shard tree and a silently short world. `inputs` is built
    from what each shard's manifest CLAIMS (`merge_all`: `shard / m["layers"][key]
    ["path"]`), never from the filesystem — so an object that failed to upload, or a
    file an interrupted `aws s3 sync` never fetched, still lands in this list. GDAL
    resolves a missing `<SrcDataSource>` to an empty sub-layer and the union simply
    contributes nothing: the layer merges, publishes, and is short by exactly one
    shard, with no error anywhere and a manifest identical in shape to a good one.
    That is the same class of failure as a shard job that never ran, and the merge
    cannot tell them apart afterwards — so refuse now, loudly, naming the files.
    """
    missing = [p for p in inputs if not p.exists() or p.stat().st_size == 0]
    if missing:
        raise SystemExit(
            f"{layer}: {len(missing)} of {len(inputs)} shard input(s) are missing or "
            f"empty on disk though a shard manifest lists them:\n  "
            + "\n  ".join(str(p) for p in missing[:10])
            + (f"\n  … and {len(missing) - 10} more" if len(missing) > 10 else "")
            + "\n\nThe shard tree is incomplete — most likely a sync that did not "
              "finish, or a shard whose upload failed after writing its manifest. "
              "Merging anyway would publish a layer short by those shards with no "
              "error. Re-sync and re-run.")
    if not inputs:
        raise SystemExit(
            f"{layer}: write_union_vrt called with no inputs. A layer absent from "
            "every shard is handled by the caller as features: 0; reaching here means "
            "the layer table and the shard manifests disagree.")
    lines = [
        "<OGRVRTDataSource>",
        f'  <OGRVRTUnionLayer name="{layer}">',
        "    <FieldStrategy>Union</FieldStrategy>",
        "    <GeometryType>wkbUnknown</GeometryType>",
        "    <LayerSRS>EPSG:4326</LayerSRS>",
    ]
    for path in inputs:
        lines.append(
            f'    <OGRVRTLayer name="{layer}">'
            f"<SrcDataSource>{path.resolve()}</SrcDataSource>"
            f"</OGRVRTLayer>")
    lines += ["  </OGRVRTUnionLayer>", "</OGRVRTDataSource>", ""]
    vrt = work / f"{layer}.union.vrt"
    vrt.write_text("\n".join(lines), encoding="utf-8")
    return vrt


def dedup_gpkg(gpkg: Path, layer: str, key_sql: str) -> tuple[int, int]:
    """DELETE all but the first-inserted row per key. Returns (before, after).

    `key_sql` is the grouping expression: the (osm_type, osm_id) identity for
    category layers, the raw geometry blob (`geom`) for the property-less count_only
    layers — GPKG geometry blobs are byte-identical exactly when the envelope
    diagonal is, which is the count_only dedup contract.
    """
    con = sqlite3.connect(gpkg)
    try:
        con.execute("PRAGMA cache_size = -1048576")  # 1 GB; S1 sized this stage
        con.execute("PRAGMA journal_mode = OFF")
        con.execute("PRAGMA synchronous = OFF")
        (before,) = con.execute(f'SELECT COUNT(*) FROM "{layer}"').fetchone()
        con.execute(
            f'DELETE FROM "{layer}" WHERE fid NOT IN '
            f'(SELECT MIN(fid) FROM "{layer}" GROUP BY {key_sql})')
        (after,) = con.execute(f'SELECT COUNT(*) FROM "{layer}"').fetchone()
        con.commit()
    finally:
        con.close()
    return before, after


def merge_feature_layer(layer: str, inputs: list[Path], out_dir: Path, work: Path,
                        count_only: bool, assert_shards: bool,
                        strategy: str) -> Path:
    """One layer across all shards → one deduped, indexed FlatGeobuf (temp name)."""
    if assert_shards and not count_only:
        for fgb in inputs:
            rows, distinct = rows_and_distinct(fgb, layer)
            if rows != distinct:
                raise SystemExit(
                    f"shard input {fgb} has {rows} rows but only {distinct} distinct "
                    f"(osm_type, osm_id) — the Phase-0 double-emit guarantee is "
                    f"broken upstream. Refusing to mask it; fix the shard build or "
                    f"pass --no-assert.")

    merged = out_dir / f"{layer}.merged.fgb"
    merged.unlink(missing_ok=True)
    nlt = "LINESTRING" if count_only else "GEOMETRY"
    vrt = write_union_vrt(layer, inputs, work)

    if strategy == "groupby" and not count_only:
        # Benchmark path (see module docstring): one pass, but SQLite's bare-column
        # pick under GROUP BY is documented as arbitrary — not the default.
        run([
            "ogr2ogr", "-f", "FlatGeobuf", str(merged), str(vrt),
            "-dialect", "SQLITE",
            "-sql", f'SELECT * FROM "{layer}" GROUP BY osm_type, osm_id',
            "-nln", layer,
            "-lco", "SPATIAL_INDEX=YES",
            "-nlt", nlt,
        ])
        vrt.unlink(missing_ok=True)
        return merged

    gpkg = work / f"{layer}.merge.gpkg"
    gpkg.unlink(missing_ok=True)
    run([
        "ogr2ogr", "-f", "GPKG", str(gpkg), str(vrt),
        "-nln", layer,
        "-lco", "SPATIAL_INDEX=NO",
        "-nlt", nlt,
    ])
    key_sql = "geom" if count_only else "osm_type, osm_id"
    before, after = dedup_gpkg(gpkg, layer, key_sql)
    log(f"{layer}: {before} rows in from {len(inputs)} shard(s), "
        f"{after} after dedup ({before - after} duplicates dropped)")
    run([
        "ogr2ogr", "-f", "FlatGeobuf", str(merged), str(gpkg),
        layer,
        "-nln", layer,
        "-lco", "SPATIAL_INDEX=YES",
        "-nlt", nlt,
    ])
    gpkg.unlink(missing_ok=True)
    vrt.unlink(missing_ok=True)

    if assert_shards and not count_only:
        rows, distinct = rows_and_distinct(merged, layer)
        if rows != distinct:
            raise SystemExit(
                f"merged {layer} has {rows} rows but {distinct} distinct identities "
                "— the dedup failed; refusing to publish.")
    return merged


# ═══════════════════════════════════════════════════════════════════════════════
# Density merge: external-sort aggregation, exactly stage_density's output shape
# ═══════════════════════════════════════════════════════════════════════════════


def merge_density(inputs: list[Path], out_dir: Path, work: Path,
                  density_keys: list[str], cell_deg: float) -> Path | None:
    """Sum shard density grids by (row, col) and rewrite the global grid.

    Each shard grid holds points at cell centres `(col*cell+half, row*cell+half)`
    rounded to 7 decimals (`stage_density`), so `(row, col)` is recovered exactly by
    `round((coord - half) / cell)`. Cells are streamed to a text file of
    `row col c0..cN` lines, aggregated through external `sort` (constant memory —
    a planet grid is far too large for a dict), and re-emitted with build.py's exact
    conventions: sorted by (row, col), centres rounded to 7 decimals, zero-valued
    properties omitted per cell (R4).
    """
    half = cell_deg / 2.0
    raw = work / "density.cells.txt"
    with raw.open("w", encoding="utf-8") as dst:
        for shard_index, fgb in enumerate(inputs):
            # Indexed, not named after the shard dir: nested shard ids can share a
            # basename (us/georgia vs europe/georgia).
            csv_path = work / f"density.{shard_index}.csv"
            csv_path.unlink(missing_ok=True)
            run([
                "ogr2ogr", "-f", "CSV", str(csv_path), str(fgb),
                "-lco", "GEOMETRY=AS_XY",
            ])
            with csv_path.open("r", encoding="utf-8") as src:
                header = src.readline().strip().split(",")
                # X,Y first, then whichever density columns this shard carries.
                col_index = {name: i for i, name in enumerate(header)}
                key_pos = [col_index.get(k) for k in density_keys]
                xi, yi = col_index["X"], col_index["Y"]
                for line in src:
                    parts = line.rstrip("\n").split(",")
                    col = round((float(parts[xi]) - half) / cell_deg)
                    row = round((float(parts[yi]) - half) / cell_deg)
                    counts = [
                        int(parts[p]) if p is not None and p < len(parts)
                        and parts[p] not in ("", "0") else 0
                        for p in key_pos
                    ]
                    dst.write(f"{row} {col} " + " ".join(map(str, counts)) + "\n")
            csv_path.unlink(missing_ok=True)

    if raw.stat().st_size == 0:
        raw.unlink()
        log("density: no cells in any shard, omitting")
        return None

    sorted_cells = work / "density.cells.sorted.txt"
    run(["sort", "-k1,1n", "-k2,2n", "-S", "512M", "-T", str(work),
         "-o", str(sorted_cells), str(raw)], env={**os.environ, "LC_ALL": "C"})
    raw.unlink()

    grid = work / "density.geojsonl"
    cells = 0
    with sorted_cells.open("r", encoding="utf-8") as src, \
            grid.open("w", encoding="utf-8") as dst:

        def emit(row: int, col: int, counts: list[int]) -> None:
            nonlocal cells
            feature = {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [
                        round(col * cell_deg + half, 7),
                        round(row * cell_deg + half, 7),
                    ],
                },
                "properties": {
                    key: count
                    for key, count in zip(density_keys, counts) if count != 0
                },
            }
            dst.write(json.dumps(feature, separators=(",", ":")) + "\n")
            cells += 1

        current: tuple[int, int] | None = None
        acc: list[int] = []
        for line in src:
            parts = line.split()
            key = (int(parts[0]), int(parts[1]))
            counts = [int(v) for v in parts[2:]]
            if key == current:
                acc = [a + b for a, b in zip(acc, counts)]
            else:
                if current is not None:
                    emit(*current, acc)
                current, acc = key, counts
        if current is not None:
            emit(*current, acc)
    sorted_cells.unlink()

    merged = out_dir / "density.merged.fgb"
    merged.unlink(missing_ok=True)
    run([
        "ogr2ogr", "-f", "FlatGeobuf", str(merged), str(grid),
        "-nln", "density",
        "-lco", "SPATIAL_INDEX=YES",
        "-nlt", "POINT",
    ])
    grid.unlink(missing_ok=True)
    log(f"density: {cells} cells from {len(inputs)} shard grid(s)")
    return merged


# ═══════════════════════════════════════════════════════════════════════════════
# Publish: content-addressed rename + manifest
# ═══════════════════════════════════════════════════════════════════════════════


def publish_layer(temp: Path, key: str, out_dir: Path) -> dict:
    """Rename to `<key>.<sha12>.fgb` and return its manifest entry."""
    digest = sha256_file(temp)
    final = out_dir / f"{key}.{digest[:SHA_PREFIX]}.fgb"
    if final.exists():
        # Same content already published (a re-run): keep the existing file.
        temp.unlink()
    else:
        temp.rename(final)
    entry = {
        "path": final.name,
        "bytes": final.stat().st_size,
        "sha256": digest,
        "features": feature_count(final),
    }
    bbox = layer_extent(final)
    if bbox is not None:
        entry["bbox"] = bbox
    return entry


def place_admin(admin_src: Path, out_dir: Path) -> dict:
    """Hardlink (or copy) the Overture admin build into the output, content-addressed."""
    digest = sha256_file(admin_src)
    final = out_dir / f"admin.{digest[:SHA_PREFIX]}.fgb"
    if not final.exists():
        try:
            os.link(admin_src, final)
        except OSError:
            shutil.copyfile(admin_src, final)
    entry = {
        "path": final.name,
        "bytes": final.stat().st_size,
        "sha256": digest,
        "features": feature_count(final),
    }
    bbox = layer_extent(final)
    if bbox is not None:
        entry["bbox"] = bbox
    return entry


# ═══════════════════════════════════════════════════════════════════════════════
# Entry point
# ═══════════════════════════════════════════════════════════════════════════════


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Merge per-shard build.py outputs into one global world.")
    parser.add_argument("--shards", required=True, type=Path,
                        help="directory containing one subdirectory per shard build")
    parser.add_argument("--admin", required=True, type=Path,
                        help="the Overture admin.fgb (build-admin.sh output)")
    parser.add_argument("--out", required=True, type=Path,
                        help="output directory for the merged world")
    parser.add_argument("--work", default=None, type=Path,
                        help="scratch directory for intermediates (default: <out>/work)")
    parser.add_argument("--no-assert", action="store_true",
                        help="skip the per-shard rows==distinct(osm_type,osm_id) "
                             "assertion (and the post-merge one)")
    parser.add_argument("--only", default=None,
                        help="comma-separated layer keys to merge (default: all). "
                             "Merges INTO an existing manifest.json in --out when "
                             "one is present, and stamps the manifest "
                             "\"partial\": true while its layer table is incomplete")
    parser.add_argument("--allow-missing-density", action="store_true",
                        help="when NO shard contributes any density cells (normally "
                             "a hard error — a forgotten or mis-pathed density "
                             "sync, never true emptiness for a real region), "
                             "publish a manifest with the density layer OMITTED "
                             "entirely (the client degrades and density-based "
                             "curses warn) instead of refusing. Never writes a "
                             "features:0 density entry either way")
    parser.add_argument("--allow-incomplete", action="store_true",
                        help="tolerate directories under --shards holding .fgb files "
                             "without a manifest.json (a failed build's leavings) "
                             "instead of failing loudly; the merge then proceeds "
                             "WITHOUT them and its counts are short for those regions")
    parser.add_argument("--strategy", choices=("gpkg", "groupby"), default="gpkg",
                        help="dedup mechanics; groupby is the benchmarked-but-"
                             "nondeterministic single pass (default: gpkg)")
    args = parser.parse_args(argv)

    table = load_table()
    if not args.admin.exists():
        raise SystemExit(f"--admin file not found: {args.admin}")

    out_dir: Path = args.out
    work: Path = args.work or (out_dir / "work")
    out_dir.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)

    shards = find_shards(args.shards, allow_incomplete=args.allow_incomplete)
    manifests = {shard: shard_manifest(shard) for shard in shards}
    log(f"merging {len(shards)} shard(s): "
        + ", ".join(s.relative_to(args.shards).as_posix() for s in shards))

    # planet_timestamp: the OLDEST contributing shard. ISO-8601 compares
    # lexicographically, so min() over the strings is min() over the instants.
    timestamps = [m.get("planet_timestamp") for m in manifests.values()
                  if m.get("planet_timestamp")]
    planet_timestamp = min(timestamps) if timestamps else None

    cell_degs = {m.get("cell_deg") for m in manifests.values() if m.get("cell_deg")}
    if len(cell_degs) > 1:
        raise SystemExit(f"shards disagree on cell_deg: {sorted(cell_degs)}")
    cell_deg = cell_degs.pop() if cell_degs else table["cell_deg"]

    wanted = set(args.only.split(",")) if args.only else None

    # The full layer table — used both for the `partial` stamp and to drop stale
    # manifest keys on an --only merge-into run.
    full_table = set(table["identity"]) | set(table["count_only"]) | \
        {"density", "admin"}

    # An --only run merges INTO an existing manifest. Read it UP FRONT so its
    # invariants gate the run before any heavy work:
    #   * cell_deg must EQUAL the existing manifest's — this run's shards rebuild
    #     some layers of THAT world, and a world cannot mix grid resolutions;
    #   * planet_timestamp stays the OLDEST of the existing manifest's value and
    #     this run's shards — the untouched layers still date from the old run, so
    #     stamping only this run's (newer) timestamp would mislabel them.
    target = out_dir / "manifest.json"
    existing: dict | None = None
    if wanted is not None and target.exists():
        existing = json.loads(target.read_text(encoding="utf-8"))
        existing_cell = existing.get("cell_deg")
        if existing_cell is not None and float(existing_cell) != float(cell_deg):
            raise SystemExit(
                f"--only merge-into: this run's cell_deg ({cell_deg}) does not "
                f"equal the existing manifest's ({existing_cell}) in {target} — "
                "a world cannot mix density grid resolutions. Merge these shards "
                "into a fresh --out, or rebuild the world at one cell_deg.")
        existing_ts = existing.get("planet_timestamp")
        if existing_ts and (planet_timestamp is None
                            or existing_ts < planet_timestamp):
            planet_timestamp = existing_ts

    # The no-shard-lists-density cause of the zero-density hard error (below,
    # after the layer loop) is fully computable from the manifests already in
    # hand — fail NOW rather than after hours of feature-layer merging. The
    # other cause (every contributed grid empty) is only detectable post-merge,
    # so the late check stays as the backstop.
    if ((wanted is None or "density" in wanted)
            and not args.allow_missing_density
            and not any("density" in m["layers"] for m in manifests.values())):
        raise SystemExit(
            "density: no shard under --shards lists a density layer — most "
            "likely the density shards were never synced, or --shards points at "
            "a feature-only tree (detected before any layer merge; nothing was "
            "written). Fix the shard tree, or pass --allow-missing-density to "
            "publish WITHOUT a density layer.")

    started = time.time()
    layers: dict[str, dict] = {}

    universe = [(key, False) for key in table["identity"]] + \
               [(key, True) for key in table["count_only"]]
    for key, count_only in universe:
        if wanted is not None and key not in wanted:
            continue
        inputs = [shard / m["layers"][key]["path"]
                  for shard, m in manifests.items() if key in m["layers"]]
        if not inputs:
            # Legitimately empty everywhere — explicit, so a failed job cannot
            # masquerade as an empty layer.
            layers[key] = {"features": 0}
            log(f"{key}: empty in every shard — manifest gets features: 0")
            continue
        log(f"── {key} ({'geometry-bytes' if count_only else 'identity'} dedup, "
            f"{len(inputs)} shard(s)) ─────")
        merged = merge_feature_layer(
            key, inputs, out_dir, work, count_only,
            assert_shards=not args.no_assert, strategy=args.strategy)
        layers[key] = publish_layer(merged, key, out_dir)

    # Density is the ONE layer that never gets a features:0 manifest entry. The
    # client trusts a present-but-empty density grid as a real zero everywhere —
    # which auto-lifts the density-based curses (Bridge Troll, Luxury Car, Right
    # Turn) — and for any real region "zero density cells" is an operational
    # failure (a forgotten or mis-pathed density sync), never true emptiness.
    # Feature layers are different: bremen+hamburg genuinely have no
    # amusement_park, so THEIR features:0 entries stay.
    density_omitted = False
    if wanted is None or "density" in wanted:
        density_inputs = [shard / m["layers"]["density"]["path"]
                          for shard, m in manifests.items()
                          if "density" in m["layers"]]
        merged = None
        if density_inputs:
            merged = merge_density(density_inputs, out_dir, work,
                                   table["density_keys"], cell_deg)
        if merged is not None:
            layers["density"] = publish_layer(merged, "density", out_dir)
        else:
            cause = ("no shard under --shards lists a density layer — most "
                     "likely the density shards were never synced, or --shards "
                     "points at a feature-only tree"
                     if not density_inputs else
                     f"all {len(density_inputs)} contributing shard density "
                     f"grid(s) are empty")
            if not args.allow_missing_density:
                raise SystemExit(
                    f"density: zero cells contributed by any shard ({cause}). "
                    "For a real region that is an operational failure, never "
                    "true emptiness, and a features:0 density entry would be "
                    "trusted by the client as a real zero — silently lifting "
                    "the density-based curses. Fix the shard tree, or pass "
                    "--allow-missing-density to publish WITHOUT a density layer "
                    "(absent => the client degrades and curses warn, the safe "
                    "direction).")
            density_omitted = True
            log(f"density: {cause} — --allow-missing-density: OMITTING the "
                "density layer from the manifest (absent, never features: 0)")

    if wanted is None or "admin" in wanted:
        log("── admin (from --admin, not merged) ─────")
        layers["admin"] = place_admin(args.admin, out_dir)

    # An --only run updates an existing manifest IN PLACE rather than clobbering the
    # layers it did not touch — otherwise re-merging one layer would silently unlist
    # every other published layer of the world. Keys the current layer table no
    # longer knows are DROPPED (loudly): carrying them forward forever would keep a
    # removed layer listed on every --only run until the end of time.
    all_layers = dict(layers)
    if existing is not None:
        existing_layers = dict(existing.get("layers", {}))
        stale = sorted(set(existing_layers) - full_table)
        if stale:
            log("--only: dropping existing manifest entr(y|ies) no longer in the "
                f"layer table: {', '.join(stale)}")
            for key in stale:
                del existing_layers[key]
        all_layers = {**existing_layers, **layers}
        log(f"--only: merged {len(layers)} layer entr(y|ies) into the existing "
            f"manifest's {len(existing_layers)}")
    if density_omitted and "density" in all_layers:
        # --allow-missing-density means "publish this world without density" —
        # carrying an older density entry forward would contradict the flag.
        log("--allow-missing-density: dropping the existing manifest's density "
            "entry too")
        del all_layers["density"]

    manifest = {
        "version": 1,
        "admin_source": "overture",
        "cell_deg": cell_deg,
        "planet_timestamp": planet_timestamp,
        "layers": {key: all_layers[key] for key in sorted(all_layers)},
    }
    # The pinned client rule: a manifest whose layer table is not the FULL table —
    # every category + count_only layer, density, and admin — carries a top-level
    # `"partial": true`. A full merge normally lists every key (legitimately-empty
    # FEATURE layers get explicit `features: 0`), so a manifest can only be partial
    # via an --only run or via --allow-missing-density omitting the density layer;
    # an --only run that completes a previously-partial manifest clears the flag.
    if not full_table <= set(all_layers):
        manifest["partial"] = True
    target.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n",
                      encoding="utf-8")

    published = sum(1 for v in layers.values() if "path" in v)
    total = sum(v.get("bytes", 0) for v in layers.values())
    log(f"merged world: {published} layers published, "
        f"{len(layers) - published} empty, {total / 1e9:.2f} GB, "
        f"in {(time.time() - started) / 60:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main())
