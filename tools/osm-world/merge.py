#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "boto3>=1.43",
# ]
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

CI MODES AND UPLOAD (PLAN.md §Phase 6 — world-merge.yml drives these; nothing below
changes the serial `--shards … --admin … --out …` behaviour above):

  * `--upload --prefix P [--manifest-dest KEY]` publishes what THIS run produced,
    through build.py's boto3 uploader (`r2_client`/`r2_upload` — one uploader, one
    set of ContentType/CacheControl rules; gap B4 closed). Layer files go up FIRST,
    the manifest STRICTLY LAST (build.py's documented ordering: a manifest naming a
    not-yet-uploaded layer is a live-site break). `--manifest-dest` exists so CI's
    per-layer matrix jobs can drop their partial manifest at a STAGING key while
    their layer file goes straight to the world prefix — the LIVE
    `<prefix>/manifest.json` is only ever written by the finalize job. `/vsis3` is
    deliberately not used anywhere: `publish_layer` renames, a rename over /vsis3
    is a server-side CopyObject, and R2 caps single-part copy at 5 GiB — which
    `water` (5.44 GB measured 2026-08-22) exceeds. Write locally, then upload.

  * `--only <layer>` + `--upload` is the per-layer matrix job. `--admin` is only
    required when the run actually places admin (default runs, or `--only` sets
    containing `admin`).

  * `--density-band K/N` (with `--only density`) merges ONE row-band of the density
    grid: the cells whose grid row satisfies `row % N == K-1`. Interleaved rows
    rather than contiguous latitude ranges because band populations must be
    near-equal WITHOUT a global row histogram — population concentrates in the
    mid-northern latitudes, so contiguous ranges would be wildly lopsided, and the
    whole point of banding is that GDAL's FGB writer holds ~100 B/feature in RAM at
    close() and a single global write does not reliably fit a 16 GB runner. Every
    row belongs to exactly one band, so the N bands partition the cells exactly.
    Output is `density.band-K-of-N.fgb` plus a `.json` sidecar carrying
    {cells, cell_deg, planet_timestamp}; NO manifest is written. The sidecar is
    uploaded AFTER the band file, so its presence marks the band complete.

  * `--assemble-density-bands DIR` concatenates the N band files back into the one
    global `density.<sha>.fgb` the client reads (the manifest contract is a single
    `density` layer — osm/worldfile.js `worldDensity` opens exactly one reader).
    Bands are row-disjoint by construction, so this is a pure VRT append with no
    dedup and no re-aggregation. It hard-errors on a missing/mixed band set and on
    a feature-count mismatch against the sidecars' cell sum — a dropped band must
    never publish silently short. NOTE the RAM math: this one job rebuilds the
    Hilbert index over the full grid, ~166 MB + 100 B/feature measured (S1) →
    ~12.1 GB at the measured 119,473,135 cells against a 15 GB public runner. That
    fits under the MEASURED law; at the investigation's pessimistic 162 B/feature
    it would not, and the durable fix would be client-side multi-band density.

  * `--assemble-manifests DIR --admin admin.fgb` is the finalize job: it reads the
    per-layer partial manifests staged by the matrix jobs, places the Overture
    admin layer (`place_admin`), refuses loudly if any layer of the full table is
    missing (a failed or unstaged matrix job must never publish a partial world;
    `--allow-missing-density` is the one documented exception), and with
    `--upload` verifies EVERY referenced layer object already exists in R2 at the
    right byte size (HeadObject) before uploading admin and then — strictly last —
    the manifest.
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

sys.path.insert(0, str(HERE))
import build  # noqa: E402 — build.py, same directory; stdlib-only at import time.
# The R2 uploader (r2_client / r2_upload / check_upload_env) lives there and is
# REUSED, never duplicated (PLAN.md §Phase 6 gap B4): one uploader, one set of
# ContentType/CacheControl rules, one multipart configuration.

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


def listed_path(manifest: dict, key: str) -> str | None:
    """The layer's file name in a shard manifest, or None when the shard has no
    FILE for it.

    Two shapes both mean "nothing to contribute" and merge as empty: the key
    absent entirely (build.py omits empty layers from shard manifests — and an
    all-water residual like british-columbia, whose populated land is claimed by
    the smaller sub-extracts sorting ahead of it in the cover, legitimately
    publishes `layers: {}`), and a path-less `{"features": 0}` entry — merge.py's
    OWN empty shape, which build.py never writes but which is real whenever a
    merged world or a make-test-world.py world is itself used as a shard input.
    Indexing `["path"]` unconditionally crashed on the second shape. Neither is
    an error; a LISTED path whose file is missing on disk stays the hard error it
    is (`write_union_vrt` — that shape means a failed upload or an unfinished
    sync, which must never merge as empty).
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
                  density_keys: list[str], cell_deg: float,
                  band: tuple[int, int] | None = None) -> Path | None:
    """Sum shard density grids by (row, col) and rewrite the global grid.

    Each shard grid holds points at cell centres `(col*cell+half, row*cell+half)`
    rounded to 7 decimals (`stage_density`), so `(row, col)` is recovered exactly by
    `round((coord - half) / cell)`. Cells are streamed to a text file of
    `row col c0..cN` lines, aggregated through external `sort` (constant memory —
    a planet grid is far too large for a dict), and re-emitted with build.py's exact
    conventions: sorted by (row, col), centres rounded to 7 decimals, zero-valued
    properties omitted per cell (R4).

    `band=(K, N)` (K in 1..N) keeps ONLY the cells whose grid row satisfies
    `row % N == K - 1` — one interleaved row-band of the global grid, for CI's
    banded density merge (module docstring). The filter sits before the raw write
    so the sort and emit stages shrink by N too. Summing is per-cell, and every
    row lands in exactly one band, so the N band outputs partition the full merge
    exactly — the assemble step checks that identity by cell count.
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
    """N row-band grids → the ONE global density FGB the client reads.

    Bands are row-disjoint by construction (`row % N` partitions the rows), so
    this is a pure append — no dedup, no re-aggregation — through the same VRT
    union mechanics as the feature layers. What it must NOT do is publish short:
    a band file lost between the band jobs and this one would merge cleanly and
    undercount a quarter of the planet, so the band SET is validated (exactly
    K = 1..N for one consistent N, each with its sidecar) and the output's
    feature count must equal the sidecars' cell sum. Returns the merged temp
    path plus {cells, cell_deg, planet_timestamp} from the sidecars.
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

    Returns (layers, cell_deg, planet_timestamp). Every `*.json` in the
    directory must BE a partial manifest (shape-checked loudly — a stray file in
    the staging prefix must not be half-read as layers), duplicate layer keys
    across partials are a hard error (two jobs claimed the same layer — stale
    staging), cell_deg must agree everywhere, and planet_timestamp is the OLDEST
    across partials, exactly the rule the serial merge applies across shards.
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

    The manifest is the only mutable object and the last thing uploaded; a layer
    entry whose object is missing (a matrix job that claimed success but whose
    upload was lost) or the wrong size would be a live-site break the moment the
    manifest lands. ~40 HEADs cost nothing next to that.
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
    """Upload THIS run's published layer files, then its manifest, strictly last.

    Only the files this run actually produced — an `--only` merge-into must not
    re-upload (or worse, require on local disk) the layers it did not touch;
    those are already in R2 under their content-addressed names.
    """
    client = build.r2_client()
    dest = manifest_dest or object_key(prefix, "manifest.json")
    manifest = out_dir / "manifest.json"
    if (manifest_dest is None
            and json.loads(manifest.read_text(encoding="utf-8")).get("partial")):
        # A partial manifest at the live key is a legal client state (the pinned
        # `partial: true` rule) but it hides every layer the table lacks — so it
        # must be an explicit decision, never the default of a CI matrix job
        # that forgot --manifest-dest and would otherwise clobber the world.
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

    # Mode sanity first, and the upload-env preflight right after argparse for the
    # same reason build.py checks before downloading: an unset R2_* variable must
    # surface now, not after hours of merging (check_upload_env's own rationale).
    modes = [name for name, on in (("--density-band", args.density_band),
                                   ("--assemble-density-bands",
                                    args.assemble_density_bands),
                                   ("--assemble-manifests", args.assemble_manifests))
             if on]
    if len(modes) > 1:
        raise SystemExit(f"{' and '.join(modes)} are mutually exclusive")
    if args.upload:
        build.check_upload_env()
    if args.admin is not None and not args.admin.exists():
        raise SystemExit(f"--admin file not found: {args.admin}")

    out_dir: Path = args.out
    work: Path = args.work or (out_dir / "work")
    out_dir.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)

    # ── --assemble-density-bands: band files → the one global density layer ──
    if args.assemble_density_bands is not None:
        for flag, value in (("--shards", args.shards), ("--admin", args.admin),
                            ("--only", args.only)):
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
        staged, cell_deg, planet_timestamp = assemble_manifests(
            args.assemble_manifests)
        all_layers = dict(staged)
        log("── admin (from --admin, not merged) ─────")
        all_layers["admin"] = place_admin(args.admin, out_dir)

        full_table = set(table["identity"]) | set(table["count_only"]) | \
            {"density", "admin"}
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
            # Everything except admin was uploaded by its matrix job — verify it
            # is actually there at the right size before the manifest can point
            # at it. Admin is THIS job's to upload, before the manifest.
            verify_layers_in_r2(client, all_layers, args.prefix, skip={"admin"})
            upload_published(out_dir, {"admin": all_layers["admin"]},
                             args.prefix, args.manifest_dest)
        return 0

    if args.shards is None:
        raise SystemExit("--shards is required (except in the --assemble-* modes)")

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

    # ── --density-band: one row-band, no manifest, sidecar last ──
    if args.density_band is not None:
        if args.only != "density":
            raise SystemExit("--density-band requires --only density — a banded "
                             "merge of anything else is meaningless (bands "
                             "partition GRID ROWS, and only density is a grid)")
        if args.admin is not None:
            raise SystemExit("--admin has no role in a --density-band run")
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
            # Band file FIRST, sidecar LAST: the assemble step treats the
            # sidecar's presence as the band's completeness marker.
            for path in (band_fgb, band_sidecar):
                obj = object_key(args.prefix, path.name)
                log(f"upload: {path.name} ({path.stat().st_size / 1e6:.1f} MB) "
                    f"→ {obj}")
                build.r2_upload(client, path, obj)
        return 0

    wanted = set(args.only.split(",")) if args.only else None

    # --admin is only needed when this run actually places admin. CI's per-layer
    # matrix jobs (--only <one feature layer>) neither have nor want the 2.29 GB
    # Overture file; the finalize job is where admin enters the world.
    if (wanted is None or "admin" in wanted) and args.admin is None:
        raise SystemExit("--admin is required (this run places the admin layer; "
                         "only an --only set that excludes admin may omit it)")

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

    if args.upload:
        # Only THIS run's published files — an --only merge-into's untouched
        # layers are already in R2 under their content-addressed names.
        upload_published(out_dir, layers, args.prefix, args.manifest_dest)

    published = sum(1 for v in layers.values() if "path" in v)
    total = sum(v.get("bytes", 0) for v in layers.values())
    log(f"merged world: {published} layers published, "
        f"{len(layers) - published} empty, {total / 1e9:.2f} GB, "
        f"in {(time.time() - started) / 60:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main())
