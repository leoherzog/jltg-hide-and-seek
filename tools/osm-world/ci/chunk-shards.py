#!/usr/bin/env python3
"""
tools/osm-world/ci/chunk-shards.py — turn shards.json into a GitHub Actions matrix.

See PLAN.md §Phase 4. Consumed by .github/workflows/world-density-shards.yml and
world-feature-shards.yml, both of which need a dynamic matrix (the shard count is
decided by cover.py's Geofabrik-derived cover, not known when the workflow is
authored) that stays under the platform's 256-entry-per-matrix cap.

shards.json (the pinned interface written by cover.py) has the shape:

    {
      "generated_from": "geofabrik index-v1.json <date>",
      "coarse": [{"id": "...", "pbf_url": "...", "md5_url": "...", "est_bytes": N}],
      "fine":   [{..same.., "disjoint_neighbors": ["..."]}]
    }

This script reads one of those two arrays, groups it into batches (a GitHub matrix
*job* runs one batch, looping over its shards sequentially — that is what keeps 514
fine shards under 256 jobs without raising per-job concurrency), and prints a JSON
array of `{"batch_id", "shards"}` objects suitable for:

    strategy:
      matrix:
        include: ${{ fromJson(needs.setup.outputs.matrix) }}

A batch closes on whichever cap is hit first: `--batch-size` (shard count) or, when
given, `--max-batch-bytes` (accumulated `est_bytes`). The byte cap exists because
the fine shards span ~100 kB to 7.90 GB and the density pass is single-threaded, so
a batch's wall clock tracks its total bytes, not its shard count: with count-only
batching, whichever fixed batch drew africa was ~10x the work of a typical one and
blew the workflow timeout while its neighbours finished in minutes. A single shard
larger than the byte cap still gets a batch — its own, alone; the cap bounds what a
shard *shares a job with*, it is not an admission test (dropping the shard would
silently publish a world without africa).

`disjoint_neighbors` (fine-only) is not consumed here, and it is not a merge input
either: the density exactness rule is enforced at BUILD time (build-shard.sh passes
cover.py's cover-geometries/<id>.geojson — the shard's assigned disjoint polygon —
to `build.py --clip-region`; merge.py just sums cells). `disjoint_neighbors` records
which fine shards can share a boundary density cell — diagnostic/bookkeeping data,
not a scheduling input for CI.

No third-party dependencies (stdlib json/argparse only) so a bare `python3` on the
runner can run it without an `uv` setup step.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def chunk(items: list, size: int, max_bytes: int | None = None) -> list[list]:
    """Greedy, order-preserving batching: close the open batch when adding the next
    shard would exceed the count cap OR the byte cap, whichever comes first.

    Order-preserving matters only in that it keeps the output stable for a given
    shards.json — batches have no build-time meaning beyond "these run sequentially
    on one runner". An oversized shard (est_bytes > max_bytes) opens a fresh batch
    and the very next shard closes it, so it runs alone rather than being dropped
    or erroring; every shard appears in exactly one batch either way.
    """
    if size < 1:
        raise ValueError("batch size must be >= 1")
    if max_bytes is not None and max_bytes < 1:
        raise ValueError("max batch bytes must be >= 1")
    batches: list[list] = []
    current: list = []
    current_bytes = 0
    for item in items:
        est = int(item["est_bytes"]) if max_bytes is not None else 0
        if current and (len(current) >= size
                        or (max_bytes is not None
                            and current_bytes + est > max_bytes)):
            batches.append(current)
            current = []
            current_bytes = 0
        current.append(item)
        current_bytes += est
    if current:
        batches.append(current)
    return batches


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shards-json", type=Path,
                        default=Path(__file__).resolve().parent.parent / "shards.json",
                        help="path to shards.json (default: tools/osm-world/shards.json)")
    parser.add_argument("--kind", required=True, choices=["coarse", "fine"],
                        help="which array of shards.json to batch")
    parser.add_argument("--batch-size", type=int, required=True,
                        help="max shards per matrix job (one job loops over its "
                             "batch sequentially inside build-shard.sh)")
    parser.add_argument("--max-batch-bytes", type=int, default=None,
                        help="close a batch early once its accumulated est_bytes "
                             "would exceed this (default: no byte cap, count-only "
                             "batching). A single shard over the cap still gets a "
                             "batch of its own — see the module docstring.")
    parser.add_argument("--max-jobs", type=int, default=256,
                        help="hard cap on emitted matrix entries (GitHub Actions "
                             "limit; default 256)")
    parser.add_argument("--id-prefix", default=None,
                        help="batch_id prefix (default: --kind)")
    args = parser.parse_args(argv)

    if not args.shards_json.exists():
        print(
            f"error: {args.shards_json} not found.\n"
            "shards.json is generated by cover.py (see PLAN.md §Phase 3/4) and IS "
            "checked in at tools/osm-world/shards.json — the workflows read it from "
            "the checkout. If it is missing, regenerate it with cover.py (which also "
            "writes cover-geometries/) and commit both, or point --shards-json at a "
            "copy.",
            file=sys.stderr,
        )
        return 1

    data = json.loads(args.shards_json.read_text(encoding="utf-8"))
    if args.kind not in data:
        print(f"error: {args.shards_json} has no \"{args.kind}\" array", file=sys.stderr)
        return 1
    shards = data[args.kind]
    if not shards:
        print(f"error: {args.shards_json}[\"{args.kind}\"] is empty", file=sys.stderr)
        return 1

    if args.max_batch_bytes is not None:
        # cover.py --no-sizes writes est_bytes: null (it skips the per-region HEAD
        # requests). Treating null as 0 would silently pack every shard of such a
        # run into count-capped batches, which is exactly the failure mode the byte
        # cap exists to prevent — refuse instead.
        unsized = [s["id"] for s in shards if not s.get("est_bytes")]
        if unsized:
            print(
                f"error: --max-batch-bytes needs est_bytes on every shard, but "
                f"{len(unsized)} {args.kind} shard(s) have none (first: "
                f"{unsized[0]}). This shards.json came from a cover.py --no-sizes "
                "run — regenerate without --no-sizes, or drop --max-batch-bytes.",
                file=sys.stderr,
            )
            return 1

    batches = chunk(shards, args.batch_size, args.max_batch_bytes)
    if len(batches) > args.max_jobs:
        caps = f"batch-size {args.batch_size}"
        fix = "Raise --batch-size."
        if args.max_batch_bytes is not None:
            caps += f" / max-batch-bytes {args.max_batch_bytes}"
            fix = "Raise --batch-size and/or --max-batch-bytes."
        print(
            f"error: {len(shards)} {args.kind} shards at {caps} = {len(batches)} "
            f"matrix jobs, over the --max-jobs cap of {args.max_jobs}. {fix}",
            file=sys.stderr,
        )
        return 1

    prefix = args.id_prefix or args.kind
    matrix = [
        {
            "batch_id": f"{prefix}-{index:04d}",
            "shards": batch,
        }
        for index, batch in enumerate(batches)
    ]

    print(json.dumps(matrix, separators=(",", ":")))
    caps = f"batch size {args.batch_size}"
    if args.max_batch_bytes is not None:
        caps += f", byte cap {args.max_batch_bytes}"
    print(
        f"chunk-shards: {len(shards)} {args.kind} shards -> {len(matrix)} matrix jobs "
        f"({caps})",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
