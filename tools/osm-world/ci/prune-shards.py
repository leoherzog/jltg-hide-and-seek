#!/usr/bin/env python3
"""
tools/osm-world/ci/prune-shards.py — list the shard objects in R2 that no current
shard names, for world-rebuild.yml to delete between the shard wave and the merge.

A shard keeps its `manifest.json` and every file that manifest's layers name.
Anything else under `<prefix>/{density,feature}/` is stale: a shard a cover change
dropped from shards.json, which merge-plan.py's cover check refuses to merge, or a
layer file a category change left behind. Other prefixes are never touched.

Refuses (exit 1, nothing listed) unless every shard in shards.json has a manifest,
so it can never prune against an incomplete wave.

Output: the keys to delete, one per line, sorted; a summary goes to stderr.
Stdlib only, like merge-plan.py.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# shards.json section -> the R2 directory its shards upload under.
KINDS = {"coarse": "feature", "fine": "density"}


def read_manifests(root: Path) -> dict[str, dict]:
    """id -> parsed manifest for every manifest.json under root; ids contain slashes."""
    if not root.is_dir():
        return {}
    return {mf.parent.relative_to(root).as_posix(): json.loads(mf.read_text(encoding="utf-8"))
            for mf in sorted(root.rglob("manifest.json"))}


def plan(keys: list[str], shards: dict, manifests: dict[str, dict[str, dict]],
         prefix: str) -> tuple[list[str], list[str]]:
    """Return (stale keys, problems). Any problem means prune nothing.

    @param manifests kind ('feature' | 'density') -> id -> manifest
    """
    problems = []
    keep = set()
    for section, kind in KINDS.items():
        want = [s["id"] for s in shards.get(section, [])]
        if not want:
            problems.append(f"shards.json lists no {section} shards; refusing to prune {kind}/")
            continue
        have = manifests.get(kind, {})
        missing = sorted(set(want) - set(have))
        if missing:
            problems.append(f"{kind}: {len(missing)} shard(s) in shards.json have no manifest "
                            f"in R2, so the wave is incomplete: {', '.join(missing[:10])}")
            continue
        for sid in want:
            base = f"{prefix}/{kind}/{sid}/"
            keep.add(base + "manifest.json")
            for layer in have[sid].get("layers", {}).values():
                if layer.get("path"):
                    keep.add(base + layer["path"])
    if problems:
        return [], problems
    scoped = tuple(f"{prefix}/{kind}/" for kind in KINDS.values())
    return sorted(k for k in set(keys) if k.startswith(scoped) and k not in keep), []


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--keys", type=Path, required=True,
                        help="every object key under --prefix, one per line")
    parser.add_argument("--feature-manifests", type=Path, required=True,
                        help="local copy of <prefix>/feature/*/manifest.json")
    parser.add_argument("--density-manifests", type=Path, required=True,
                        help="local copy of <prefix>/density/*/manifest.json")
    parser.add_argument("--shards-json", type=Path, default=HERE.parent / "shards.json")
    parser.add_argument("--prefix", default="shards")
    args = parser.parse_args(argv)

    keys = [k.strip() for k in args.keys.read_text(encoding="utf-8").splitlines() if k.strip()]
    shards = json.loads(args.shards_json.read_text(encoding="utf-8"))
    manifests = {"feature": read_manifests(args.feature_manifests),
                 "density": read_manifests(args.density_manifests)}
    stale, problems = plan(keys, shards, manifests, args.prefix.rstrip("/"))
    for p in problems:
        print(f"error: {p}", file=sys.stderr)
    if problems:
        return 1

    gone = sorted({k.rsplit("/", 1)[0] for k in stale if k.endswith("/manifest.json")})
    print(f"{len(keys)} object(s) under {args.prefix}/, {len(stale)} stale, "
          f"{len(gone)} of them whole shards no longer in shards.json"
          + (f": {', '.join(gone[:10])}" if gone else ""), file=sys.stderr)
    sys.stdout.write("".join(k + "\n" for k in stale))
    return 0


if __name__ == "__main__":
    sys.exit(main())
