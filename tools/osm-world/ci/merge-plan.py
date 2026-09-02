#!/usr/bin/env python3
"""
tools/osm-world/ci/merge-plan.py — plan world-merge.yml's matrices from the shard
manifests actually present in R2.

See DESIGN.md §Phase 6. world-merge.yml's `plan` job syncs every shard's
`manifest.json` out of R2 into two local directories and points this script at
them. It answers three questions:

  1. IS THE SHARD SET COMPLETE AND EXACT? A shard whose job never ran leaves no
     trace, and the merge would publish counts silently short. A shard deleted
     from shards.json but still in R2 would merge stale data, and for density
     that DOUBLE-COUNTS because its cells were reassigned along the difference
     chain. So the manifest set must equal shards.json's id set exactly, both
     directions, per cover. `--skip-cover-check` is the logged escape hatch for
     deliberate partial merges.

  2. HOW MANY DENSITY BANDS? N = ceil(total cells / --cells-per-band), summed at
     runtime from the fine manifests' `layers.density.features`, never hard-coded.
     A shard with no density entry contributes 0 and is NOT an error: smaller
     sub-extracts sorting ahead of british-columbia claim its populated land, so
     its offshore residual publishes `layers: {}`. Zero cells overall is the same
     hard error merge.py enforces.

  3. WHICH LAYER JOBS, IN WHAT ORDER? One entry per identity + count_only layer
     from categories.json (the layer table, not the manifests, so a layer empty in
     every shard still gets its `features: 0` entry), sorted by pooled shard bytes
     DESCENDING so the longest merge starts in the first wave.

CANARY SWITCHES (world-merge.yml's only_layers / skip_density inputs) narrow the
plan here rather than with jq in the workflow, so the narrowing is unit-testable:

  * `--only-layers a,b` keeps only those layer jobs. A key not in the layer table,
    or carried by no shard manifest, is a HARD ERROR naming the key: a typo'd
    canary layer that merged nothing would look like a pass. (Outside
    --only-layers, an everywhere-absent layer legitimately becomes `features: 0`.)
  * `--skip-density` reads no density manifests: no density cover check,
    `bands_matrix` empty, `cells`/`bands` 0.

Output: one JSON object on stdout —
    {"cells": N, "bands": N, "contributing_density_shards": N,
     "layers_matrix": [{"layer": k, "pooled_bytes": b}, ...],
     "bands_matrix": [{"band": k, "bands": n}, ...]}

Stdlib only, so a bare `python3` on the runner can run it without `uv`.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def read_manifests(root: Path) -> dict[str, dict]:
    """id -> parsed manifest, for every manifest.json under root, recursively.

    The id is the manifest's directory relative to root: the R2 layout is
    `shards/<kind>/<id>/manifest.json` and ids contain slashes (`us/michigan`).
    """
    if not root.is_dir():
        sys.exit(f"error: manifest directory not found: {root}")
    out: dict[str, dict] = {}
    for mf in sorted(root.rglob("manifest.json")):
        out[mf.parent.relative_to(root).as_posix()] = json.loads(
            mf.read_text(encoding="utf-8"))
    if not out:
        sys.exit(f"error: no manifest.json files under {root} — was the R2 sync "
                 "pointed at the right prefix?")
    return out


def cover_problems(kind: str, got: set[str], want: set[str]) -> list[str]:
    problems = []

    def listing(ids: list[str]) -> str:
        head = ", ".join(ids[:10])
        return head + (f", … and {len(ids) - 10} more" if len(ids) > 10 else "")

    missing = sorted(want - got)
    if missing:
        problems.append(
            f"{kind}: {len(missing)} shard(s) in shards.json have NO manifest in "
            f"R2 — the shard job never ran, or its upload failed before the "
            f"manifest (which build.py uploads last): {listing(missing)}")
    extra = sorted(got - want)
    if extra:
        problems.append(
            f"{kind}: {len(extra)} manifest(s) in R2 are NOT in shards.json — "
            f"stale shards from an older cover. Merging them double-counts "
            f"density (their cells were reassigned along the difference chain); "
            f"delete their R2 prefixes before merging: {listing(extra)}")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--feature-manifests", type=Path, required=True,
                        help="local dir the feature-shard manifests were synced to")
    parser.add_argument("--density-manifests", type=Path, default=None,
                        help="local dir the density-shard manifests were synced to "
                             "(required unless --skip-density)")
    parser.add_argument("--only-layers", default=None, metavar="A,B",
                        help="restrict the layer matrix to these keys (canary "
                             "runs). A key unknown to the table, or carried by "
                             "no shard manifest, is a hard error — see the "
                             "module docstring")
    parser.add_argument("--skip-density", action="store_true",
                        help="plan no density bands at all (canary runs): no "
                             "density manifests read, empty bands_matrix")
    parser.add_argument("--shards-json", type=Path,
                        default=HERE.parent / "shards.json",
                        help="path to shards.json (default: tools/osm-world/shards.json)")
    parser.add_argument("--categories", type=Path,
                        default=HERE.parent / "categories.json",
                        help="path to categories.json (the layer table)")
    parser.add_argument("--cells-per-band", type=int, default=30_000_000,
                        help="density cells per merge band (default 30M — sized "
                             "so one band's FGB write stays ~3 GB RSS, DESIGN.md "
                             "§Phase 6)")
    parser.add_argument("--skip-cover-check", action="store_true",
                        help="tolerate a manifest set that does not equal "
                             "shards.json's id set (DELIBERATE partial merges "
                             "only — the merged counts will be short, or stale "
                             "shards will be merged in)")
    args = parser.parse_args(argv)

    if args.cells_per_band < 1:
        sys.exit("error: --cells-per-band must be >= 1")
    shards = json.loads(args.shards_json.read_text(encoding="utf-8"))
    raw = json.loads(args.categories.read_text(encoding="utf-8"))
    layer_keys = ([e["key"] for e in raw["categories"]]
                  + [e["key"] for e in raw["curse_layers"]])

    feature = read_manifests(args.feature_manifests)
    density: dict[str, dict] = {}
    if not args.skip_density:
        if args.density_manifests is None:
            sys.exit("error: --density-manifests is required unless --skip-density")
        density = read_manifests(args.density_manifests)

    problems = cover_problems("feature", set(feature),
                              {s["id"] for s in shards["coarse"]})
    if not args.skip_density:
        problems += cover_problems("density", set(density),
                                   {s["id"] for s in shards["fine"]})
    if problems:
        for problem in problems:
            print(("warning" if args.skip_cover_check else "error")
                  + ": " + problem, file=sys.stderr)
        if not args.skip_cover_check:
            return 1

    # Path-less or absent density entries are legitimate (british-columbia); zero
    # cells overall is merge.py's hard error, surfaced before any job is scheduled.
    cells = 0
    contributing = 0
    bands = 0
    if not args.skip_density:
        for manifest in density.values():
            entry = manifest.get("layers", {}).get("density")
            if isinstance(entry, dict) and entry.get("path"):
                cells += int(entry.get("features", 0))
                contributing += 1
        if cells < 1:
            sys.exit("error: zero density cells across every synced density shard "
                     "— a merge with no density is always an operational failure "
                     "(merge.py refuses it too). Were the density shards built?")
        bands = math.ceil(cells / args.cells_per_band)

    pooled: dict[str, int] = {key: 0 for key in layer_keys}
    carriers: dict[str, int] = {key: 0 for key in layer_keys}
    for manifest in feature.values():
        for key, entry in manifest.get("layers", {}).items():
            if key in pooled and isinstance(entry, dict):
                pooled[key] += int(entry.get("bytes", 0))
                carriers[key] += 1

    if args.only_layers is not None:
        wanted = [k.strip() for k in args.only_layers.split(",") if k.strip()]
        if not wanted:
            sys.exit("error: --only-layers was given but names no layers")
        unknown = sorted(set(wanted) - set(layer_keys))
        if unknown:
            sys.exit(f"error: --only-layers key(s) not in the layer table "
                     f"({args.categories}): {', '.join(unknown)}")
        # A canary layer no shard carries would merge nothing and read as a pass;
        # refuse it by name. In a full plan an absent layer merges to features: 0.
        uncarried = sorted(k for k in wanted if carriers[k] == 0)
        if uncarried:
            sys.exit(f"error: --only-layers key(s) present in NO shard "
                     f"manifest: {', '.join(uncarried)} — the canary would "
                     "merge nothing and look like a pass. Pick a layer the "
                     "shards actually carry (or fix the typo).")
        layer_keys = [key for key in layer_keys if key in set(wanted)]

    plan = {
        "cells": cells,
        "bands": bands,
        "contributing_density_shards": contributing,
        "layers_matrix": [
            {"layer": key, "pooled_bytes": pooled[key]}
            for key in sorted(layer_keys, key=lambda k: (-pooled[k], k))
        ],
        "bands_matrix": [{"band": k, "bands": bands} for k in range(1, bands + 1)],
    }
    print(json.dumps(plan, separators=(",", ":")))
    density_note = ("density SKIPPED (--skip-density)" if args.skip_density else
                    f"{cells} density cells from {contributing} of "
                    f"{len(density)} density shards -> {bands} band(s) at "
                    f"{args.cells_per_band}/band")
    print(f"merge-plan: {density_note}; {len(layer_keys)} layer job(s)"
          + (f" (--only-layers: {', '.join(m['layer'] for m in plan['layers_matrix'])})"
             if args.only_layers is not None else "")
          + f", largest {plan['layers_matrix'][0]['layer']} at "
          f"{plan['layers_matrix'][0]['pooled_bytes'] / 1e9:.2f} GB pooled",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
