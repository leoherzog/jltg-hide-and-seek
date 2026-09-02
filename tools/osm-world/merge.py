#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "boto3>=1.43",
# ]
# ///
"""
tools/osm-world/merge.py — merge per-shard build.py outputs into one global world.

    uv run tools/osm-world/merge.py --shards <dir> --admin <admin.fgb> \
                                    --transit <transit_route.fgb> --out <dir>

`--shards` holds one `build.py --out` directory per shard (`manifest.json` plus
`<layer>.fgb`), at any nesting depth: the R2 sync layout nests ids with slashes
(`shards/feature/us/michigan/` syncs to `us/michigan/`). A directory with `.fgb`
files but no `manifest.json` is a failed build's leavings and a hard error
(`--allow-incomplete` opts out). Output: one FlatGeobuf per layer with one Hilbert
R-tree, a global density grid, the Overture admin layer, the global transit_route
layer, and one `manifest.json`.

Mechanics (measured, spike S1):

  * Shard FGB schemas are sparse and differ per shard (osmium writes only the
    `include_tags` present), and `ogr2ogr -append` silently drops columns that first
    appear in a later shard. Every layer is read through an OGRVRTUnionLayer with
    `FieldStrategy=Union`.

  * Dedup goes VRT → GPKG (`SPATIAL_INDEX=NO`) → one SQL DELETE keeping MIN(fid) per
    identity → ogr2ogr GPKG→FGB. MIN(fid) over a fixed shard order makes the
    surviving duplicate deterministic, so re-runs are byte-identical. A single-pass
    SQLite GROUP BY was rejected: bare columns come from an arbitrary row.

  * The FlatGeobuf writer peaks at ~166 MB + 100 B/feature, so RAM is not the limit.
    Disk is: it stages a hidden temp in the output directory (~2× final bytes,
    `CPL_TMPDIR` does not redirect it).

What gets merged how:

  * Identity layers (every category layer): schema-union, dedup on
    `(osm_type, osm_id)`. Each shard input and the merged output are asserted to
    satisfy rows == distinct identities (`--no-assert` opts out).

  * count_only layers: 2-point bbox-diagonal linestrings with no properties, so they
    dedup on exact geometry bytes. Known residual: a feature clipped differently at
    an extract boundary survives twice; two distinct entities with identical
    diagonals collapse. Both only nudge diagnostic counts.

  * density: cells summed by `(row, col)` via external `sort` (a planet grid is
    90–196M cells; a dict is the RAM wall that killed the monolith build), then
    re-emitted exactly as `stage_density` writes it so a single-shard merge
    round-trips.

  * transit_route and admin: not merged from shards, since a relation only assembles
    inside the extract that holds it whole. Taken verbatim from `--transit`
    (`build-transit.py`) and `--admin` (`build-admin.sh`), hardlinked or copied in
    content-addressed; the manifest says `"admin_source": "overture"`. transit_route
    presence is the OSM fallback tier's capability signal.

The manifest is build.py's shape plus:
  * `admin_source: "overture"`;
  * explicit `{"features": 0}` for feature layers empty in every shard, so a failed
    job cannot look like an empty layer. Density is the exception: the client trusts
    a present-but-empty grid as a real zero (lifting density-based curses), so zero
    density contributions is a hard error and `--allow-missing-density` omits the
    layer entirely. Never `density: {"features": 0}`;
  * `planet_timestamp` = the oldest contributing shard's; an `--only` merge-into
    keeps the oldest of the existing manifest's and this run's, and hard-errors on a
    `cell_deg` mismatch;
  * per-layer `bbox` so the client can skip layers that cannot intersect its map;
  * content-addressed filenames `<layer>.<sha256-prefix-12>.fgb`; `manifest.json`
    is the only mutable object;
  * top-level `"partial": true` whenever the layer table is not the full table
    (only `--only` or `--allow-missing-density` can produce this). An `--only` run
    merges into an existing manifest.json in --out, drops (loudly) keys the layer
    table no longer contains, and clears `partial` once the table is complete.

CI modes (DESIGN.md §Phase 6; world-merge.yml drives these):

  * `--upload --prefix P [--manifest-dest KEY]` publishes what this run produced via
    build.py's boto3 uploader: layer files first, manifest strictly last. Matrix jobs
    point `--manifest-dest` at a staging key; only the finalize job writes the live
    `<prefix>/manifest.json`. `/vsis3` is not used: a rename there is a CopyObject,
    which R2 caps at 5 GiB, and `water` exceeds that.

  * `--only <layer>` + `--upload` is the per-layer matrix job. `--admin`/`--transit`
    are only required when the run places those layers.

  * `--density-band K/N` (with `--only density`) merges the rows with
    `row % N == K-1`. Interleaved rows keep band populations near-equal without a
    row histogram; banding exists because a single global FGB write does not
    reliably fit a 16 GB runner. Output is `density.band-K-of-N.fgb` plus a `.json`
    sidecar {cells, cell_deg, planet_timestamp}, no manifest. The sidecar uploads
    after the band file and marks it complete.

  * `--assemble-density-bands DIR` appends the N bands into the one global density
    layer (the client opens exactly one reader). Hard-errors on a missing/mixed band
    set or a count mismatch against the sidecars. RAM: ~166 MB + 100 B/feature →
    ~12.1 GB at 119,473,135 cells on a 15 GB runner.

  * `--assemble-manifests DIR --admin … --transit …` is the finalize job: unions the
    staged partial manifests, places admin and transit_route, refuses on any missing
    layer (`--allow-missing-density` excepted), and with `--upload` HeadObject-
    verifies every referenced layer before uploading those two and then the manifest.
"""

from __future__ import annotations

import argparse
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

sys.path.insert(0, str(HERE))
import build  # noqa: E402 — build.py, same directory; stdlib-only at import time.
# The R2 uploader is reused from build.py, never duplicated. These four are plain
# rebindings, not wrappers: a wrapper would resolve `build.run` at call time and
# pick up test-update.py's stub, changing what that harness exercises.
log = build.log
run = build.run
sha256_file = build.sha256_file
feature_count = build.feature_count

TABLE_PATH = HERE / "categories.json"

SHA_PREFIX = 12


def preflight_binaries(needed: tuple[str, ...]) -> None:
    """Fail immediately, by name, if a binary this run will shell out to is absent.

    Workflow-level checks only cover the jobs someone remembered to give them; the
    invoking code knows what each mode needs, so main() derives the set per mode.
    """
    missing = [b for b in needed if shutil.which(b) is None]
    if missing:
        raise SystemExit(
            f"missing required binar{'y' if len(missing) == 1 else 'ies'} on "
            f"PATH: {', '.join(missing)}\n"
            "  ogrinfo/ogr2ogr → gdal-bin package\n"
            "  sort            → coreutils\n"
            "This run would otherwise crash mid-merge or (worse) mid-publish.")


# ═══════════════════════════════════════════════════════════════════════════════
# The build table — merge.py reads the same categories.json as build.py
# ═══════════════════════════════════════════════════════════════════════════════


def load_table() -> dict:
    raw = json.loads(TABLE_PATH.read_text(encoding="utf-8"))
    identity_layers = [e["key"] for e in raw["categories"]]
    count_only_layers = [e["key"] for e in raw["curse_layers"]
                         if e.get("count_only")]
    # A non-count_only curse layer carries identity and merges with the categories.
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
    """Every directory under `shards_dir` (itself included) holding a manifest.json,
    recursively, in sorted relative-path order, without descending into a shard.

    Recursion is required: R2 shard ids contain slashes, so a sync of
    `shards/feature/us/michigan/` lands at `us/michigan/`, and a flat scan would
    silently lose every `us/*` shard. `shards_dir` itself is a candidate, so
    pointing --shards at one build directory is a single-shard merge.

    Symlinked directories are followed, guarded by visited realpaths: a second reach
    of a non-shard directory is skipped with a log line, and a second reach of a
    shard is a hard error, because density is summed additively and a shard merged
    twice doubles its contribution. Bind mounts have distinct realpaths and are not
    detected; do not build merge trees out of them.

    A directory with `*.fgb` files but no manifest.json is a failed build's leavings
    (build.py writes the manifest last) and a hard error; `--allow-incomplete`
    downgrades it to a warning. This applies to `shards_dir` itself too.

    The order is load-bearing: it fixes which duplicate MIN(fid) keeps, which makes
    re-runs byte-identical.
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
            # A cycle or diamond over a non-shard directory: already walked.
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
            # Symlinked directories are followed; the visited guard ends cycles.
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


def listed_path(manifest: dict, key: str) -> str | None:
    """The layer's file name in a shard manifest, or None when the shard has no
    file for it.

    Two shapes mean "nothing to contribute": the key absent (build.py omits empty
    layers) and a path-less `{"features": 0}` entry (merge.py's own shape, real when
    a merged or make-test-world.py world is used as a shard input). A listed path
    missing on disk stays the hard error it is (`write_union_vrt`).
    """
    entry = manifest.get("layers", {}).get(key)
    if not isinstance(entry, dict):
        return None
    return entry.get("path")


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

    `FieldStrategy=Union` is the point: shard schemas are sparse and differ, and a
    plain append silently drops columns first appearing in later shards.

    Every input must exist first: `inputs` comes from what manifests claim, and GDAL
    resolves a missing `<SrcDataSource>` to an empty sub-layer, so a half-synced tree
    would otherwise publish a silently short world.
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

    `key_sql` is (osm_type, osm_id) for category layers, or the raw geometry blob
    `geom` for property-less count_only layers.
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
                        count_only: bool, assert_shards: bool) -> Path:
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
                  density_keys: list[str], cell_deg: float,
                  band: tuple[int, int] | None = None) -> Path | None:
    """Sum shard density grids by (row, col) and rewrite the global grid.

    Shard grids hold cell centres rounded to 7 decimals (`stage_density`), so
    `(row, col)` is `round((coord - half) / cell)`. Cells stream to a text file,
    aggregate through external `sort` (constant memory), and re-emit with build.py's
    conventions: sorted by (row, col), centres rounded to 7 decimals, zero-valued
    properties omitted (R4).

    `band=(K, N)` keeps only rows with `row % N == K - 1`, filtered before the raw
    write so sort and emit shrink too. The N bands partition the full merge exactly.
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
                    if band is not None and row % band[1] != band[0] - 1:
                        continue  # another band's row (Python % is non-negative)
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


def place_prebuilt(source: Path, key: str, out_dir: Path) -> dict:
    """Hardlink (or copy) an out-of-band layer build into the output, content-addressed.

    Used for `admin` (`build-admin.sh`) and `transit_route` (`build-transit.py`).
    Like `publish_layer` minus the rename: the source must survive untouched, so
    link first and copy on a cross-filesystem handoff.
    """
    digest = sha256_file(source)
    final = out_dir / f"{key}.{digest[:SHA_PREFIX]}.fgb"
    if not final.exists():
        try:
            os.link(source, final)
        except OSError:
            shutil.copyfile(source, final)
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
    return place_prebuilt(admin_src, "admin", out_dir)


def place_transit(transit_src: Path, out_dir: Path) -> dict:
    """Hardlink (or copy) the global transit_route build into the output."""
    return place_prebuilt(transit_src, "transit_route", out_dir)


# ═══════════════════════════════════════════════════════════════════════════════
# CI modes: density bands, band assembly, manifest assembly, upload (B4)
# ═══════════════════════════════════════════════════════════════════════════════


_BAND_FILE_RE = re.compile(r"^density\.band-(\d+)-of-(\d+)\.fgb$")


def parse_band(spec: str) -> tuple[int, int]:
    """`K/N` → (K, N), 1-based, validated. The workflow passes e.g. `2/4`."""
    match = re.fullmatch(r"(\d+)/(\d+)", spec)
    if not match:
        raise SystemExit(f"--density-band wants K/N (e.g. 2/4), got '{spec}'")
    k, n = int(match.group(1)), int(match.group(2))
    if n < 1 or not 1 <= k <= n:
        raise SystemExit(f"--density-band {spec}: K must be in 1..N and N >= 1")
    return k, n


def band_paths(out_dir: Path, k: int, n: int) -> tuple[Path, Path]:
    return (out_dir / f"density.band-{k}-of-{n}.fgb",
            out_dir / f"density.band-{k}-of-{n}.json")


def assemble_density_bands(band_dir: Path, out_dir: Path,
                           work: Path) -> tuple[Path, dict]:
    """N row-band grids → the one global density FGB the client reads.

    Bands are row-disjoint, so this is a pure VRT append. A lost band would merge
    cleanly and undercount, so the set is validated (K = 1..N for one N, each with
    its sidecar) and the output count must equal the sidecars' sum. Returns the
    merged temp path plus {cells, cell_deg, planet_timestamp}.
    """
    found: dict[int, tuple[int, Path]] = {}
    for entry in sorted(band_dir.iterdir()):
        match = _BAND_FILE_RE.match(entry.name)
        if match:
            found[int(match.group(1))] = (int(match.group(2)), entry)
    if not found:
        raise SystemExit(f"no density.band-K-of-N.fgb files under {band_dir}")
    n_values = {n for n, _ in found.values()}
    if len(n_values) != 1:
        raise SystemExit(
            f"mixed band denominators under {band_dir}: {sorted(n_values)} — "
            "band files from different runs are mixed together; clear the "
            "directory and re-stage one run's bands.")
    n = n_values.pop()
    missing = sorted(set(range(1, n + 1)) - set(found))
    if missing:
        raise SystemExit(
            f"band set under {band_dir} is incomplete: N={n} but band(s) "
            f"{missing} are absent. A missing band would publish a density grid "
            "silently short by its rows — re-run the missing band job(s).")

    cells = 0
    timestamps: list[str] = []
    cell_degs: set[float] = set()
    for k in range(1, n + 1):
        sidecar = found[k][1].with_suffix(".json")
        if not sidecar.exists():
            raise SystemExit(
                f"{found[k][1].name} has no {sidecar.name} sidecar — the sidecar "
                "is uploaded last and marks the band complete; its absence means "
                "the band job died mid-upload. Re-run that band job.")
        meta = json.loads(sidecar.read_text(encoding="utf-8"))
        if int(meta.get("cells", 0)) < 1:
            raise SystemExit(f"{sidecar.name} claims {meta.get('cells')} cells — "
                             "a zero-cell band is always an operational failure")
        cells += int(meta["cells"])
        cell_degs.add(float(meta["cell_deg"]))
        if meta.get("planet_timestamp"):
            timestamps.append(meta["planet_timestamp"])
    if len(cell_degs) != 1:
        raise SystemExit(f"band sidecars disagree on cell_deg: {sorted(cell_degs)}")

    inputs = [found[k][1] for k in range(1, n + 1)]  # K order: deterministic
    merged = out_dir / "density.merged.fgb"
    merged.unlink(missing_ok=True)
    vrt = write_union_vrt("density", inputs, work)
    run([
        "ogr2ogr", "-f", "FlatGeobuf", str(merged), str(vrt),
        "-nln", "density",
        "-lco", "SPATIAL_INDEX=YES",
        "-nlt", "POINT",
    ])
    vrt.unlink(missing_ok=True)

    got = feature_count(merged)
    if got != cells:
        raise SystemExit(
            f"assembled density grid has {got} cells but the {n} band sidecars "
            f"sum to {cells} — a band contributed partially (truncated file?). "
            "Refusing to publish a silently short grid.")
    log(f"density: assembled {got} cells from {n} row band(s)")
    return merged, {
        "cells": cells,
        "cell_deg": cell_degs.pop(),
        "planet_timestamp": min(timestamps) if timestamps else None,
    }


def assemble_manifests(manifest_dir: Path) -> tuple[dict, float | None, str | None]:
    """Union the per-layer partial manifests staged by CI's matrix jobs.

    Returns (layers, cell_deg, planet_timestamp). Every `*.json` must be a partial
    manifest, duplicate layer keys are a hard error (stale staging), cell_deg must
    agree, and planet_timestamp is the oldest, as in the serial merge.
    """
    layers: dict[str, dict] = {}
    owners: dict[str, Path] = {}
    cell_degs: set[float] = set()
    timestamps: list[str] = []
    partials = sorted(p for p in manifest_dir.iterdir() if p.suffix == ".json")
    if not partials:
        raise SystemExit(f"no staged partial manifests (*.json) under {manifest_dir}")
    for path in partials:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data.get("layers"), dict):
            raise SystemExit(
                f"{path} does not look like a manifest (no 'layers' object) — "
                "the staging directory must hold ONLY the matrix jobs' partial "
                "manifests.")
        if data.get("cell_deg") is not None:
            cell_degs.add(float(data["cell_deg"]))
        if data.get("planet_timestamp"):
            timestamps.append(data["planet_timestamp"])
        for key, entry in data["layers"].items():
            if key in layers:
                raise SystemExit(
                    f"layer '{key}' appears in both {owners[key].name} and "
                    f"{path.name} — two matrix jobs claimed the same layer, "
                    "which means the staging prefix holds files from more than "
                    "one run. Clear it and re-stage.")
            layers[key] = entry
            owners[key] = path
    if len(cell_degs) > 1:
        raise SystemExit(f"staged manifests disagree on cell_deg: {sorted(cell_degs)}")
    return (layers,
            cell_degs.pop() if cell_degs else None,
            min(timestamps) if timestamps else None)


def object_key(prefix: str, name: str) -> str:
    return f"{prefix.strip('/')}/{name}" if prefix else name


def verify_layers_in_r2(client, layers: dict[str, dict], prefix: str,
                        skip: set[str]) -> None:
    """HeadObject every layer file the manifest is about to reference.

    A missing or wrong-sized object would be a live-site break the moment the
    manifest lands.
    """
    from botocore.exceptions import ClientError  # noqa: PLC0415

    bucket = os.environ["R2_BUCKET"]
    problems: list[str] = []
    for key in sorted(layers):
        entry = layers[key]
        if key in skip or "path" not in entry:
            continue
        obj = object_key(prefix, entry["path"])
        try:
            head = client.head_object(Bucket=bucket, Key=obj)
        except ClientError as exc:
            problems.append(f"{key}: {obj} — {exc.response.get('Error', {}).get('Code', exc)}")
            continue
        if head["ContentLength"] != entry["bytes"]:
            problems.append(f"{key}: {obj} is {head['ContentLength']} bytes in R2 "
                            f"but the staged manifest says {entry['bytes']}")
    if problems:
        raise SystemExit(
            "refusing to publish the manifest — layer object(s) it references "
            "are not (correctly) in R2:\n  " + "\n  ".join(problems)
            + "\nRe-run the matrix job(s) that own them, then finalize again.")


def upload_published(out_dir: Path, layers: dict[str, dict], prefix: str,
                     manifest_dest: str | None) -> None:
    """Upload this run's published layer files, then its manifest, strictly last.

    Only this run's files: an `--only` merge-into's untouched layers are already in
    R2 under their content-addressed names.
    """
    client = build.r2_client()
    dest = manifest_dest or object_key(prefix, "manifest.json")
    manifest = out_dir / "manifest.json"
    if (manifest_dest is None
            and json.loads(manifest.read_text(encoding="utf-8")).get("partial")):
        # A partial manifest at the live key hides every layer it lacks; it must
        # be explicit, never a matrix job that forgot --manifest-dest.
        raise SystemExit(
            f"refusing to upload a PARTIAL manifest to the default {dest} — "
            f"pass --manifest-dest {dest} explicitly if replacing the live "
            "manifest with a partial one is really the intent, or point "
            "--manifest-dest at a staging key.")
    for key in sorted(layers):
        entry = layers[key]
        if "path" not in entry:
            continue
        path = out_dir / entry["path"]
        obj = object_key(prefix, entry["path"])
        log(f"upload: {path.name} ({path.stat().st_size / 1e6:.1f} MB) → {obj}")
        build.r2_upload(client, path, obj)
    log(f"upload: manifest.json → {dest} (last, always)")
    build.r2_upload(client, manifest, dest)


# ═══════════════════════════════════════════════════════════════════════════════
# Entry point
# ═══════════════════════════════════════════════════════════════════════════════


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Merge per-shard build.py outputs into one global world.")
    parser.add_argument("--shards", type=Path, default=None,
                        help="directory containing one subdirectory per shard build "
                             "(required except in the two --assemble-* modes)")
    parser.add_argument("--admin", type=Path, default=None,
                        help="the Overture admin.fgb (build-admin.sh output). "
                             "Required whenever this run places admin — the "
                             "default full merge, an --only set containing admin, "
                             "or --assemble-manifests")
    parser.add_argument("--transit", type=Path, default=None,
                        help="the global transit_route.fgb (build-transit.py "
                             "output). Required on exactly the runs --admin is: "
                             "a route relation is no more shardable than an "
                             "admin boundary, so this layer joins the world here "
                             "or not at all")
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
    parser.add_argument("--density-band", default=None, metavar="K/N",
                        help="merge ONE interleaved row-band of the density grid "
                             "(cells with row %% N == K-1; K is 1-based) into "
                             "density.band-K-of-N.fgb + .json sidecar, no "
                             "manifest. Requires --only density. CI's banded "
                             "density merge — see the module docstring")
    parser.add_argument("--assemble-density-bands", default=None, type=Path,
                        metavar="DIR",
                        help="concatenate a complete density.band-*-of-N.fgb set "
                             "(with sidecars) into the one global density layer, "
                             "published content-addressed with a partial manifest")
    parser.add_argument("--assemble-manifests", default=None, type=Path,
                        metavar="DIR",
                        help="finalize: union the staged per-layer partial "
                             "manifests in DIR, place --admin, refuse on an "
                             "incomplete layer table, and write the world "
                             "manifest (with --upload: HeadObject-verify every "
                             "referenced layer first; manifest uploaded last)")
    parser.add_argument("--upload", action="store_true",
                        help="publish what this run produced to R2 when done, "
                             "through build.py's uploader — layer files first, "
                             "manifest strictly last")
    parser.add_argument("--prefix", default="world",
                        help="R2 key prefix for published layer files "
                             "(default: world)")
    parser.add_argument("--manifest-dest", default=None, metavar="KEY",
                        help="R2 key for the manifest when uploading (default: "
                             "<prefix>/manifest.json). CI's matrix jobs point "
                             "this at a staging key so only the finalize job "
                             "ever writes the live world manifest")
    args = parser.parse_args(argv)

    table = load_table()

    # Mode sanity and the upload-env preflight first: an unset R2_* variable must
    # surface now, not after hours of merging.
    modes = [name for name, on in (("--density-band", args.density_band),
                                   ("--assemble-density-bands",
                                    args.assemble_density_bands),
                                   ("--assemble-manifests", args.assemble_manifests))
             if on]
    if len(modes) > 1:
        raise SystemExit(f"{' and '.join(modes)} are mutually exclusive")
    # Every mode needs ogrinfo; geometry-transforming modes add ogr2ogr; only
    # density aggregation needs the external sort.
    if args.assemble_manifests is not None:
        preflight_binaries(("ogrinfo",))
    elif args.assemble_density_bands is not None:
        preflight_binaries(("ogrinfo", "ogr2ogr"))
    else:
        preflight_binaries(("ogrinfo", "ogr2ogr", "sort"))
    if args.upload:
        build.check_upload_env()
    if args.admin is not None and not args.admin.exists():
        raise SystemExit(f"--admin file not found: {args.admin}")
    if args.transit is not None and not args.transit.exists():
        raise SystemExit(f"--transit file not found: {args.transit}")

    out_dir: Path = args.out
    work: Path = args.work or (out_dir / "work")
    out_dir.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)

    # ── --assemble-density-bands: band files → the one global density layer ──
    if args.assemble_density_bands is not None:
        for flag, value in (("--shards", args.shards), ("--admin", args.admin),
                            ("--transit", args.transit), ("--only", args.only)):
            if value is not None:
                raise SystemExit(f"{flag} has no role in --assemble-density-bands")
        merged, meta = assemble_density_bands(args.assemble_density_bands,
                                              out_dir, work)
        layers = {"density": publish_layer(merged, "density", out_dir)}
        manifest = {
            "version": 1,
            "admin_source": "overture",
            "cell_deg": meta["cell_deg"],
            "planet_timestamp": meta["planet_timestamp"],
            "layers": layers,
            "partial": True,  # density alone is never the full table
        }
        (out_dir / "manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        if args.upload:
            upload_published(out_dir, layers, args.prefix, args.manifest_dest)
        return 0

    # ── --assemble-manifests: staged partials + admin → the world manifest ──
    if args.assemble_manifests is not None:
        for flag, value in (("--shards", args.shards), ("--only", args.only),):
            if value is not None:
                raise SystemExit(f"{flag} has no role in --assemble-manifests")
        if args.admin is None:
            raise SystemExit("--assemble-manifests places the admin layer and "
                             "needs --admin (build-admin.sh's admin.fgb)")
        if args.transit is None:
            raise SystemExit("--assemble-manifests places the transit_route layer "
                             "and needs --transit (build-transit.py's "
                             "transit_route.fgb, published by world-transit.yml)")
        staged, cell_deg, planet_timestamp = assemble_manifests(
            args.assemble_manifests)
        all_layers = dict(staged)
        log("── admin (from --admin, not merged) ─────")
        all_layers["admin"] = place_admin(args.admin, out_dir)
        log("── transit_route (from --transit, not merged) ─────")
        all_layers["transit_route"] = place_transit(args.transit, out_dir)

        full_table = set(table["identity"]) | set(table["count_only"]) | \
            {"density", "admin", "transit_route"}
        unknown = sorted(set(all_layers) - full_table)
        if unknown:
            raise SystemExit(
                f"staged manifests carry layer key(s) the table does not know: "
                f"{', '.join(unknown)} — stale staging from an older layer table; "
                "clear the staging prefix and re-run the matrix.")
        missing = sorted(full_table - set(all_layers))
        density_omitted = False
        if missing == ["density"] and args.allow_missing_density:
            density_omitted = True
            log("--allow-missing-density: publishing WITHOUT a density layer "
                "(absent, never features: 0)")
        elif missing:
            raise SystemExit(
                f"the staged layer table is missing: {', '.join(missing)} — a "
                "matrix job failed or its staging upload was lost. A partial "
                "world must never publish as full; re-run the missing job(s).")

        manifest = {
            "version": 1,
            "admin_source": "overture",
            "cell_deg": cell_deg if cell_deg is not None else table["cell_deg"],
            "planet_timestamp": planet_timestamp,
            "layers": {key: all_layers[key] for key in sorted(all_layers)},
        }
        if density_omitted:
            manifest["partial"] = True
        (out_dir / "manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        published = sum(1 for v in all_layers.values() if "path" in v)
        log(f"world manifest: {len(all_layers)} layers ({published} with files)"
            + (" — PARTIAL (density omitted)" if density_omitted else ""))
        if args.upload:
            client = build.r2_client()
            # Matrix jobs uploaded the rest; verify it is there at the right size
            # before the manifest points at it. Admin and transit are this job's.
            verify_layers_in_r2(client, all_layers, args.prefix,
                                skip={"admin", "transit_route"})
            upload_published(out_dir,
                             {key: all_layers[key]
                              for key in ("admin", "transit_route")},
                             args.prefix, args.manifest_dest)
        return 0

    if args.shards is None:
        raise SystemExit("--shards is required (except in the --assemble-* modes)")

    shards = find_shards(args.shards, allow_incomplete=args.allow_incomplete)
    manifests = {shard: shard_manifest(shard) for shard in shards}
    log(f"merging {len(shards)} shard(s): "
        + ", ".join(s.relative_to(args.shards).as_posix() for s in shards))

    # planet_timestamp: the oldest contributing shard (ISO-8601 sorts as strings).
    timestamps = [m.get("planet_timestamp") for m in manifests.values()
                  if m.get("planet_timestamp")]
    planet_timestamp = min(timestamps) if timestamps else None

    cell_degs = {m.get("cell_deg") for m in manifests.values() if m.get("cell_deg")}
    if len(cell_degs) > 1:
        raise SystemExit(f"shards disagree on cell_deg: {sorted(cell_degs)}")
    cell_deg = cell_degs.pop() if cell_degs else table["cell_deg"]

    # ── --density-band: one row-band, no manifest, sidecar last ──
    if args.density_band is not None:
        if args.only != "density":
            raise SystemExit("--density-band requires --only density — a banded "
                             "merge of anything else is meaningless (bands "
                             "partition GRID ROWS, and only density is a grid)")
        if args.admin is not None:
            raise SystemExit("--admin has no role in a --density-band run")
        if args.transit is not None:
            raise SystemExit("--transit has no role in a --density-band run")
        k, n = parse_band(args.density_band)
        density_inputs = [shard / p for shard, m in manifests.items()
                          if (p := listed_path(m, "density"))]
        if not density_inputs:
            raise SystemExit(
                "density: no shard under --shards lists a density layer — most "
                "likely the density shards were never synced, or --shards points "
                "at a feature-only tree.")
        merged = merge_density(density_inputs, out_dir, work,
                               table["density_keys"], cell_deg, band=(k, n))
        if merged is None:
            raise SystemExit(
                f"density band {k}/{n}: zero cells contributed by any shard — "
                "for a real region that is an operational failure, never true "
                "emptiness. Fix the shard tree.")
        band_fgb, band_sidecar = band_paths(out_dir, k, n)
        band_fgb.unlink(missing_ok=True)
        merged.rename(band_fgb)
        cells = feature_count(band_fgb)
        band_sidecar.write_text(json.dumps({
            "band": k,
            "bands": n,
            "cells": cells,
            "cell_deg": cell_deg,
            "planet_timestamp": planet_timestamp,
        }, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        log(f"density band {k}/{n}: {cells} cells from {len(density_inputs)} "
            f"shard grid(s)")
        if args.upload:
            client = build.r2_client()
            # Band file first, sidecar last: the sidecar marks the band complete.
            for path in (band_fgb, band_sidecar):
                obj = object_key(args.prefix, path.name)
                log(f"upload: {path.name} ({path.stat().st_size / 1e6:.1f} MB) "
                    f"→ {obj}")
                build.r2_upload(client, path, obj)
        return 0

    wanted = set(args.only.split(",")) if args.only else None

    # --admin/--transit are only needed when this run places those layers; the
    # per-layer matrix jobs never carry them.
    if (wanted is None or "admin" in wanted) and args.admin is None:
        raise SystemExit("--admin is required (this run places the admin layer; "
                         "only an --only set that excludes admin may omit it)")
    if (wanted is None or "transit_route" in wanted) and args.transit is None:
        raise SystemExit("--transit is required (this run places the "
                         "transit_route layer; only an --only set that excludes "
                         "transit_route may omit it). Build it with "
                         "tools/osm-world/build-transit.py, or fetch the one "
                         "world-transit.yml published to the handoff prefix.")

    # The full layer table, for the `partial` stamp and for dropping stale keys on
    # an --only merge-into. The out-of-band layers count: missing either is partial.
    full_table = set(table["identity"]) | set(table["count_only"]) | \
        {"density", "admin", "transit_route"}

    # An --only run merges into an existing manifest. Read it up front so its
    # invariants gate the run: cell_deg must equal the existing one (a world cannot
    # mix grid resolutions), and planet_timestamp stays the oldest of both (the
    # untouched layers still date from the old run).
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

    # The no-shard-lists-density cause of the zero-density hard error is knowable
    # now, so fail before hours of feature merging; the every-grid-empty cause is
    # only detectable post-merge and stays as the backstop below.
    if ((wanted is None or "density" in wanted)
            and not args.allow_missing_density
            and not any(listed_path(m, "density") for m in manifests.values())):
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
        inputs = [shard / p for shard, m in manifests.items()
                  if (p := listed_path(m, key))]
        if not inputs:
            # Empty everywhere: explicit, so a failed job cannot look like one.
            layers[key] = {"features": 0}
            log(f"{key}: empty in every shard — manifest gets features: 0")
            continue
        log(f"── {key} ({'geometry-bytes' if count_only else 'identity'} dedup, "
            f"{len(inputs)} shard(s)) ─────")
        merged = merge_feature_layer(
            key, inputs, out_dir, work, count_only,
            assert_shards=not args.no_assert)
        layers[key] = publish_layer(merged, key, out_dir)

    # Density never gets a features:0 entry: the client trusts a present-but-empty
    # grid as a real zero (lifting Bridge Troll, Luxury Car, Right Turn), and zero
    # density cells for a real region is always an operational failure.
    density_omitted = False
    if wanted is None or "density" in wanted:
        density_inputs = [shard / p for shard, m in manifests.items()
                          if (p := listed_path(m, "density"))]
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

    if wanted is None or "transit_route" in wanted:
        log("── transit_route (from --transit, not merged) ─────")
        layers["transit_route"] = place_transit(args.transit, out_dir)

    # An --only run updates the existing manifest in place so re-merging one layer
    # does not unlist the rest. Keys the layer table no longer knows are dropped
    # loudly, or a removed layer would stay listed forever.
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
        # Carrying an older density entry forward would contradict the flag.
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
    # Pinned client rule: a layer table short of the full table carries a top-level
    # `"partial": true`; an --only run that completes it clears the flag.
    if not full_table <= set(all_layers):
        manifest["partial"] = True
    target.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n",
                      encoding="utf-8")

    if args.upload:
        # Only this run's files; an --only merge-into's untouched layers are in R2.
        upload_published(out_dir, layers, args.prefix, args.manifest_dest)

    published = sum(1 for v in layers.values() if "path" in v)
    total = sum(v.get("bytes", 0) for v in layers.values())
    log(f"merged world: {published} layers published, "
        f"{len(layers) - published} empty, {total / 1e9:.2f} GB, "
        f"in {(time.time() - started) / 60:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main())
