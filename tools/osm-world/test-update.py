#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["osmium>=4.3", "boto3>=1.43", "shapely>=2.0"]
# ///
"""
tools/osm-world/test-update.py — build.py/merge.py internals no other harness can reach.

    uv run tools/osm-world/test-update.py

Eight checks, all about code that runs in the middle of an eight-hour job where a
wrong answer is invisible: the replication-diff loop (stage 0b), the `where` rewriter
that keeps `ogr2ogr` from silently discarding an attribute filter, the per-layer
geometry classes that decide whether an open way is exported at all, the density
`--clip-region` exactness rule and its skip-if-exists cache, build-transit.py's
relation assembly (member re-chaining, role filtering, stop order, determinism),
merge.py's shard discovery (symlink/duplicate hardening, root-as-shard), and
merge.py's manifest rules (the density features:0 refusal, `--only` merge-into
stale keys, timestamps and cell_deg).

WHY A STUB AND NOT THE REAL UPDATER. Exercising `pyosmium-up-to-date` for real means
pulling days of diffs off OSM's replication servers and rewriting the PBF — minutes to
hours, hundreds of megabytes, and a different answer every day. None of that tests the
part that can actually be wrong, which is `stage_update_planet`'s control flow. So the
updater is replaced by a stub whose exit codes and reported progress are scripted, and
the assertions are about how many times the loop calls it.

THE CASE THIS EXISTS FOR is scenario B. `pyosmium-up-to-date --help` documents its exit
status as: "returns 0, if updates have been successfully applied up to the newest data
or no new data was available. It returns 1, if some updates could not be resolved. Any
other error results in a return code larger than 1."

`1` is therefore ambiguous — it covers both "stopped at the --size limit, more to do"
(retry) and "could not resolve" (do not retry), and the exit code alone cannot tell them
apart. Looping blindly on `1` would re-download a gigabyte of diffs on every one of 24
passes against a persistently failing server. The loop watches the file's own
replication timestamp instead and stops the moment a pass fails to advance it.
"""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

STUB = '''#!/usr/bin/env python3
"""Stands in for pyosmium-up-to-date. Consumes one scripted step per invocation."""
import os, sys, json, pathlib
plan = pathlib.Path(os.environ["STUB_PLAN"])
state = json.loads(plan.read_text())
calls = state["calls"]
step = state["steps"][min(calls, len(state["steps"]) - 1)]
state["calls"] = calls + 1
if step["ts"] is not None:
    pathlib.Path(os.environ["STUB_TS"]).write_text(step["ts"])
plan.write_text(json.dumps(state))
sys.exit(step["rc"])
'''


def load_module(name: str):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_build():
    return load_module("build")


def check_where_rewriter(build, failures: list[str]) -> None:
    """
    `rewrite_where` — the guard that stops an absent column from killing a `where`.

    `ogr2ogr` refuses an attribute filter naming a field the source lacks, and with
    `-skipfailures` (which the build passes) it refuses it while exiting 0 and copying
    every feature through UNFILTERED. `osmium export` only writes the `include_tags` a
    layer's features actually carry, so this is not an edge case: any extract where a
    layer's cut happens to contain no `landuse` triggers it.

    The rewriter substitutes NULL for every absent column and constant-folds, which is
    the answer ogr2ogr would have given for a column full of nulls. What follows pins
    both halves of that: the folds, and — the invariant that matters more — that a
    clause with nothing to fold comes back BYTE-IDENTICAL.
    """
    print("\n=== where-rewriter ===")
    table_raw = json.loads((HERE / "categories.json").read_text(encoding="utf-8"))
    every_column = ["osm_type", "osm_id", *table_raw["include_tags"]]

    animal_delta = next(e for e in table_raw["curse_layers"] if e["key"] == "animal_delta")
    golf = next(e for e in table_raw["categories"] if e["key"] == "golf_course")
    water = next(e for e in table_raw["categories"] if e["key"] == "water")

    cases = [
        # THE case: animal_delta on a cut with no landuse anywhere. The landuse half is
        # true for every feature once landuse is NULL, so it disappears; the half that
        # selects the features must survive untouched.
        ("animal_delta without landuse", animal_delta["where"],
         [c for c in every_column if c != "landuse"],
         "(leisure IN ('park', 'nature_reserve') OR (\"natural\" = 'water' "
         "AND name IS NOT NULL))"),
        # A trailing optional-exclusion clause folding to nothing at all.
        ("golf_course without golf", golf["where"],
         [c for c in every_column if c != "golf"],
         "leisure = 'golf_course' AND name IS NOT NULL"),
        # Both exclusion terms gone from one branch, the other branch untouched.
        ("water without water/leisure", water["where"],
         [c for c in every_column if c not in ("water", "leisure")],
         "(\"natural\" = 'water' AND name IS NOT NULL) OR "
         "(waterway IN ('river', 'canal') AND name IS NOT NULL)"),
        # The whole selector rests on the missing column: nothing can match, and the
        # layer is legitimately absent rather than empty-or-everything.
        ("green_recreation_ground without landuse", "landuse = 'recreation_ground'",
         ["osm_type", "osm_id"], None),
        ("advertising without advertising", "advertising IS NOT NULL",
         ["osm_type", "osm_id"], None),
        # IS NULL is the one predicate an absent column makes TRUE — a clause made only
        # of those is unconditionally true and must be dropped, not inverted.
        ("only IS NULL terms", "golf IS NULL AND (water IS NULL OR water <> 'pool')",
         ["osm_type", "osm_id"], ""),
    ]
    for name, clause, present, want in cases:
        got = build.rewrite_where(clause, present, key=name)
        if got != want:
            failures.append(f"rewrite_where {name}: expected {want!r}, got {got!r}")
        else:
            print(f"  ok  {name} -> {got!r}")

    # The invariant. Every `where` the build table ships must survive a full-schema
    # rewrite unchanged, character for character — the rewriter parses SQL, and a parser
    # that reformats what it does not need to touch would rewrite clauses on the planet
    # build for no reason and hide a real change in the diff.
    # No admin entry: categories.json deliberately carries none (its `_admin_comment`
    # — the shipped admin layer is Overture's, via merge.py --admin, never built here).
    layers = [*table_raw["categories"], *table_raw["curse_layers"],
              *table_raw["density"]["layers"]]
    for entry in layers:
        key = entry["key"]
        got = build.rewrite_where(entry["where"], every_column, key=key)
        if got != entry["where"]:
            failures.append(
                f"rewrite_where round-trip on {key}: {entry['where']!r} -> {got!r}")
    print(f"  ok  {len(layers)} build-table clauses round-trip unchanged")

    # A prefix NOT is where SQL's UNKNOWN stops behaving like FALSE, so the fold is not
    # proven sound there. Nothing in the table uses one; if something ever does, the
    # build must stop rather than quietly invert a clause.
    try:
        build.rewrite_where("NOT (landuse = 'forest')", ["osm_type"], key="synthetic")
    except SystemExit:
        print("  ok  a prefix NOT over an absent column refuses to fold")
    else:
        failures.append("rewrite_where: a prefix NOT over an absent column folded anyway")


def check_geometry_classes(build, failures: list[str]) -> None:
    """
    The `point,polygon` class is a claim about OSM tagging, and getting it wrong is
    silent: an open way carrying the layer's tag is simply never exported.

    Every key below has a DOCUMENTED linear form — a billboard face, a platform edge, a
    shore segment, a river, a rail line — so its layer must keep `linestring` in the
    export and drop the closed-way duplicates in the dedup pass instead. `advertising`
    is on this list because it was NOT, and lost 7.3% of Michigan's and 2.3% of
    Germany's entities before anyone measured it (see the audit in categories.json).
    """
    print("\n=== geometry classes ===")
    table = build.load_table(build.TABLE_PATH)
    must_be_mixed = {"advertising", "platform", "coastline", "water",
                     "high_speed_rail", "rail_line"}
    for layer in table.feature_layers:
        if layer.key not in must_be_mixed:
            continue
        kinds = set(layer.geometry.split(","))
        if "linestring" not in kinds or not layer.dedup:
            failures.append(
                f"{layer.key} has a documented linear mapping and must be exported as "
                f"point,linestring,polygon with dedup, not {layer.geometry!r} "
                f"(dedup={layer.dedup})")
        else:
            print(f"  ok  {layer.key} keeps its linear form")


def check_density_clip(build, failures: list[str]) -> None:
    """
    `--clip-region` — the sharded-density exactness rule (DESIGN.md §Phase 3).

    Geofabrik extracts overlap their neighbours (buffered cutting polygons), so a
    density shard that bins EVERY way of its extract double-counts the buffers once
    merge.py sums cells. The rule: a way counts iff its FIRST NODE falls inside the
    shard's assigned disjoint region — and a tree node iff its own location does.

    The fixture is four entities against a unit-square clip region (lon/lat 0..1):
    a building way whose first node is inside, a building way whose first node is in
    the "buffer" outside, and one tree node on each side. Unclipped, everything
    counts (the unchanged-behaviour contract for builds without --clip-region);
    clipped, exactly the inside pair does. `build.run` is stubbed to capture the
    geojsonl grid before ogr2ogr would consume it, so the test needs no GDAL.
    """
    print("\n=== density --clip-region ===")
    table = build.load_table(build.TABLE_PATH)

    osm_xml = """<?xml version='1.0' encoding='UTF-8'?>
<osm version="0.6" generator="test-update.py">
  <node id="1" version="1" lat="0.4" lon="0.4"/>
  <node id="2" version="1" lat="0.4" lon="0.6"/>
  <node id="3" version="1" lat="0.6" lon="0.6"/>
  <node id="4" version="1" lat="0.4" lon="1.5"/>
  <node id="5" version="1" lat="0.4" lon="1.7"/>
  <node id="6" version="1" lat="0.6" lon="1.7"/>
  <node id="7" version="1" lat="0.2" lon="0.2">
    <tag k="natural" v="tree"/>
  </node>
  <node id="8" version="1" lat="0.2" lon="1.2">
    <tag k="natural" v="tree"/>
  </node>
  <way id="10" version="1">
    <nd ref="1"/><nd ref="2"/><nd ref="3"/>
    <tag k="building" v="yes"/>
  </way>
  <way id="11" version="1">
    <nd ref="4"/><nd ref="5"/><nd ref="6"/>
    <tag k="building" v="yes"/>
  </way>
</osm>
"""
    clip = {
        "type": "Feature",
        "properties": {"id": "test/unit-square"},
        "geometry": {"type": "Polygon",
                     "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]},
    }

    def totals(grid_lines: list[str], key: str) -> int:
        return sum(json.loads(line)["properties"].get(key, 0)
                   for line in grid_lines if line.strip())

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        planet = tmp / "fixture.osm"
        planet.write_text(osm_xml, encoding="utf-8")
        clip_path = tmp / "clip.geojson"
        clip_path.write_text(json.dumps(clip), encoding="utf-8")

        captured: dict[str, list[str]] = {}
        real_run = build.run

        def fake_run(cmd, **kwargs):
            # stage_density's single `run` call is the ogr2ogr geojsonl->fgb
            # conversion; grab the grid instead of converting it.
            grid = tmp / "work" / "density.geojsonl"
            captured["lines"] = grid.read_text(encoding="utf-8").splitlines()

        build.run = fake_run
        try:
            for label, clip_region, want_building, want_tree in (
                    ("unclipped", None, 2, 2),
                    ("clipped to the unit square", clip_path, 1, 1)):
                (tmp / "work").mkdir(exist_ok=True)
                out = tmp / f"out-{'clip' if clip_region else 'noclip'}"
                out.mkdir()
                captured.clear()
                result = build.stage_density(planet, tmp / "work", out, table,
                                             force=True, clip_region=clip_region)
                lines = captured.get("lines", [])
                got_building = totals(lines, "building")
                got_tree = totals(lines, "tree")
                print(f"  -> {label}: building={got_building}, tree={got_tree}, "
                      f"cells={len(lines)}")
                if result is None:
                    failures.append(f"density clip ({label}): stage returned None")
                if got_building != want_building or got_tree != want_tree:
                    failures.append(
                        f"density clip ({label}): expected building={want_building} "
                        f"tree={want_tree}, got building={got_building} "
                        f"tree={got_tree} — a first node inside the region must "
                        "count and one in the buffer outside must not")
                else:
                    print(f"  ok  {label}")
        finally:
            build.run = real_run

    # The CLI gate: --unlink-source deletes stage 4's only input, so combining it
    # with a density build must be refused up front — and refused for THAT reason,
    # not because of some later missing-file accident. (--out/--work point into a
    # scratch dir because main() mkdirs them before the gate runs.)
    with tempfile.TemporaryDirectory() as gate_tmp:
        base = ["--planet", str(Path(gate_tmp) / "does-not-exist.osm.pbf"),
                "--no-fetch", "--out", str(Path(gate_tmp) / "out"),
                "--work", str(Path(gate_tmp) / "work"), "--unlink-source"]
        try:
            build.main(base)
        except SystemExit as exc:
            if "--unlink-source" in str(exc):
                print("  ok  --unlink-source with a density build is refused up front")
            else:
                failures.append(
                    f"--unlink-source + density: refused for the wrong reason: {exc}")
        else:
            failures.append("--unlink-source + density: not refused at all")

        try:
            build.main([*base, "--skip-density"])
        except SystemExit as exc:
            if "--unlink-source" in str(exc):
                failures.append(
                    "--unlink-source with --skip-density must pass the gate "
                    f"(it failed with: {exc})")
            else:
                # Fails later, on the deliberately-missing planet file — the gate
                # let the legitimate combination through.
                print("  ok  --unlink-source with --skip-density passes the gate")
        else:
            failures.append(
                "--unlink-source --skip-density on a missing planet ran to completion?")


def check_density_cache(build, failures: list[str]) -> None:
    """
    stage 4's skip-if-exists cache must be keyed on the `--clip-region` STATE, not
    just on the output file existing: a cached grid was counted inside one polygon
    (or none), and silently reusing it under a different clip ships the wrong
    shard's tallies. The state (sha256 of the region file, or "none") lives in a
    sidecar in the work dir; the skip fires only on a match.

    `build.run` is stubbed to count builds and to touch the output fgb (so the
    exists-check is real), which keeps the whole thing GDAL-free.
    """
    print("\n=== density clip-state cache ===")
    table = build.load_table(build.TABLE_PATH)

    osm_xml = """<?xml version='1.0' encoding='UTF-8'?>
<osm version="0.6" generator="test-update.py">
  <node id="1" version="1" lat="0.4" lon="0.4"/>
  <node id="2" version="1" lat="0.4" lon="0.6"/>
  <way id="10" version="1">
    <nd ref="1"/><nd ref="2"/>
    <tag k="building" v="yes"/>
  </way>
</osm>
"""
    unit_square = {
        "type": "Feature",
        "properties": {"id": "test/unit-square"},
        "geometry": {"type": "Polygon",
                     "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]},
    }

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        planet = tmp / "fixture.osm"
        planet.write_text(osm_xml, encoding="utf-8")
        clip_path = tmp / "clip.geojson"
        clip_path.write_text(json.dumps(unit_square), encoding="utf-8")
        work = tmp / "work"
        work.mkdir()
        out = tmp / "out"
        out.mkdir()

        builds = {"n": 0}
        real_run = build.run

        def fake_run(cmd, **kwargs):
            # stage_density's single `run` call is ogr2ogr geojsonl -> fgb;
            # cmd[3] is the output path. Touch it so the cache has a file to see.
            builds["n"] += 1
            Path(cmd[3]).touch()

        build.run = fake_run
        try:
            steps = [
                # (label, force, clip_region, builds expected after the call)
                ("first unclipped build", True, None, 1),
                ("same state again is skipped", False, None, 1),
                ("a NEW clip region must rebuild", False, clip_path, 2),
                ("same clip again is skipped", False, clip_path, 2),
            ]
            for label, force, clip_region, want in steps:
                build.stage_density(planet, work, out, table,
                                    force=force, clip_region=clip_region)
                if builds["n"] != want:
                    failures.append(
                        f"density cache ({label}): expected {want} build(s) so "
                        f"far, saw {builds['n']} — the skip-if-exists cache "
                        "ignored (or over-honoured) the --clip-region state")
                else:
                    print(f"  ok  {label}")

            # A CHANGED clip file (same path, different bytes) is a different
            # state — the sha256 in the sidecar is what must notice.
            unit_square["geometry"]["coordinates"] = \
                [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]]
            clip_path.write_text(json.dumps(unit_square), encoding="utf-8")
            build.stage_density(planet, work, out, table,
                                force=False, clip_region=clip_path)
            if builds["n"] != 3:
                failures.append(
                    "density cache (changed clip file contents): expected a "
                    f"rebuild (3 builds), saw {builds['n']} — a changed clip "
                    "silently reused the stale grid")
            else:
                print("  ok  changed clip file contents rebuild")
        finally:
            build.run = real_run


def check_route_assembly(transit, failures: list[str]) -> None:
    """
    build-transit.py's relation assembly — the part of the transit_route stage that
    no other harness can see and that fails silently when it fails.

    Every fixture here is a shape the 14-city corpus actually contains, reduced to
    the smallest thing that still has the pathology:

      * member ways stored out of order, one of them against its own direction
        (52/162 Seoul relations, 50/131 NYC) — the re-chain must recover one
        continuous line, and it must start at the smallest degree-1 node id rather
        than at whichever member happened to be listed first;
      * a circle line with no degree-1 endpoint at all (22 corpus relations) —
        seeded from the smallest way id instead, and still one part;
      * a relation disconnected into two pieces (17 corpus relations, Berlin 11) —
        a MultiLineString, longest part first, and NEVER a fabricated segment
        joining them;
      * a junction (3 corpus relations) — the branch spills into its own part
        rather than being dropped or spliced onto the trunk;
      * legacy `forward` / `backward` path roles (Seoul carries 957; filtering on
        the empty role alone empties 8 relations outright), platform WAY members
        that must stay out of the geometry (Berlin 2,609), stops interleaved after
        the ways (Beijing 2, Tokyo 2), and junk roles — `inactive`, a `"station "`
        with a trailing space — that must be ignored without crashing;
      * one stop out of sequence (Berlin 10/148, Tokyo 10/94 — the through
        services), which must come back in travel order because the projection
        onto the line says so, not because the relation did;
      * a relation whose stops run the other way, which must come back running the
        other way: the chainer seeds on a node id and has no idea which direction
        the trains go, so if the projection alone decided, a line's two direction
        relations would both list their stops southbound and a feed built from
        them would have no northbound service at all;
      * and determinism: reordering the WAY members must produce byte-identical
        output, since member order is exactly the thing the assembly is not
        allowed to depend on.
    """
    print("\n=== transit route assembly ===")

    def segment(way_id, nodes, coords):
        return transit.Segment(way_id, nodes[0], nodes[-1], tuple(coords))

    def straight(lon0, lon1, steps=1, lat=52.5):
        span = (lon1 - lon0) / steps
        return [(round(lon0 + span * i, 7), lat) for i in range(steps + 1)]

    # ── 1. out-of-order members, one reversed ──────────────────────────────
    # Four consecutive 0.01° pieces of one line, listed 3, 1, 4, 2 with piece 4
    # stored backwards. Node ids ascend along the line, so the walk must start at
    # node 1 and finish at node 5.
    pieces = [
        segment(203, [3, 4], straight(13.02, 13.03)),
        segment(201, [1, 2], straight(13.00, 13.01)),
        segment(204, [5, 4], straight(13.04, 13.03)),
        segment(202, [2, 3], straight(13.01, 13.02)),
    ]
    parts = transit.chain_segments(pieces)
    if len(parts) != 1:
        failures.append(f"scrambled member ways chained into {len(parts)} parts, "
                        "expected one continuous line")
    elif parts[0][0] != (13.0, 52.5) or parts[0][-1] != (13.04, 52.5):
        failures.append(
            f"re-chained line runs {parts[0][0]} → {parts[0][-1]}, expected "
            "13.00 → 13.04 (seeded at the smallest degree-1 node)")
    elif len(parts[0]) != 5:
        failures.append(f"re-chained line has {len(parts[0])} coordinates, "
                        "expected 5 — a shared node was duplicated or dropped")
    else:
        print("  ok  scrambled and reversed member ways re-chain into one line")

    # ── 2. a circle line ───────────────────────────────────────────────────
    ring = [
        segment(301, [11, 12], [(13.0, 52.5), (13.01, 52.5)]),
        segment(302, [12, 13], [(13.01, 52.5), (13.01, 52.51)]),
        segment(303, [13, 14], [(13.01, 52.51), (13.0, 52.51)]),
        segment(304, [14, 11], [(13.0, 52.51), (13.0, 52.5)]),
    ]
    parts = transit.chain_segments(ring)
    if len(parts) != 1 or parts[0][0] != parts[0][-1]:
        failures.append(
            f"a circle line came back as {len(parts)} part(s), closed="
            f"{bool(parts) and parts[0][0] == parts[0][-1]} — a loop has no "
            "degree-1 endpoint and must be seeded from the smallest way id")
    else:
        print("  ok  a circle line with no endpoints closes into one part")

    # ── 3. genuinely disconnected, longest part first ──────────────────────
    split = [
        segment(402, [21, 22], straight(13.30, 13.31)),          # ~0.01°
        segment(401, [31, 32], straight(13.00, 13.05, steps=5)),  # ~0.05°
    ]
    parts = transit.chain_segments(split)
    if len(parts) != 2:
        failures.append(f"a disconnected relation gave {len(parts)} part(s), "
                        "expected 2 — a gap must never be bridged")
    elif parts[0][0] != (13.0, 52.5):
        failures.append("MultiLineString parts must come back longest-first; "
                        f"part 0 starts at {parts[0][0]}")
    else:
        print("  ok  a disconnected relation is a MultiLineString, longest first")

    # ── 4. a junction spills a branch ──────────────────────────────────────
    fork = [
        segment(501, [41, 42], straight(13.00, 13.01)),
        segment(502, [42, 43], straight(13.01, 13.02)),
        segment(503, [42, 44], [(13.01, 52.5), (13.01, 52.52)]),
    ]
    parts = transit.chain_segments(fork)
    if len(parts) != 2 or sum(len(part) for part in parts) < 5:
        failures.append(f"a junction gave {len(parts)} part(s) totalling "
                        f"{sum(len(part) for part in parts)} coordinates — the "
                        "branch must survive as its own part")
    else:
        print("  ok  a junction spills its branch into a second part")

    # ── 5. roles, stop order, and determinism, through assemble() ──────────
    ways = {piece.way_id: piece for piece in pieces}
    nodes = {
        node_id: {"id": node_id, "name": name, "name_en": name_en,
                  "lat": 52.5, "lon": lon}
        for node_id, name, name_en, lon in (
            (101, "Alpha", "Alpha", 13.005),
            (102, "Beta", None, 13.015),
            (103, "Gamma", "Gamma", 13.025),
            (104, "Delta", None, 13.035),
        )
    }
    members = [
        ("n", 101, "stop"),
        ("n", 102, "stop"),
        ("n", 104, "stop"),                                  # one out of sequence
        ("w", 203, ""),
        ("w", 999, "platform"),                              # a platform WAY
        ("w", 201, "forward"),                               # legacy path roles
        ("n", 902, "inactive"),                              # junk, ignored
        ("w", 204, "backward"),
        ("w", 202, ""),
        ("n", 103, "stop_exit_only"),                        # interleaved, after ways
        ("n", 901, transit.normalise_role("station ")),      # trailing space
    ]
    relation = {
        "id": 4242,
        "tags": {"name": "U-Fixture", "ref": "UF", "colour": "#009FDF",
                 "route": "subway", "interval": "10"},
        "members": members,
    }

    counts = transit.Counts()
    feature = transit.assemble(relation, ways, nodes, counts)
    if feature is None:
        failures.append("assemble() dropped a relation with four stops and a "
                        "resolvable line")
    else:
        stops = json.loads(feature["properties"]["stops"])
        if [stop[0] for stop in stops] != [101, 102, 103, 104]:
            failures.append(
                f"stops must come back in travel order by projection, got "
                f"{[stop[0] for stop in stops]}")
        else:
            print("  ok  a displaced, interleaved stop is put back in travel order")
        if stops[1][2] is not None:
            failures.append("a missing name:en must be null inside the stops JSON, "
                            f"got {stops[1][2]!r}")
        if len(feature["geometry"]["coordinates"]) != 1:
            failures.append(
                "the platform way must not reach the geometry — expected one "
                f"part, got {len(feature['geometry']['coordinates'])}")
        elif len(feature["geometry"]["coordinates"][0]) != 5:
            failures.append(
                "forward/backward members must count as path ways — expected a "
                f"5-point line, got "
                f"{len(feature['geometry']['coordinates'][0])}")
        else:
            print("  ok  platform members are excluded and legacy roles are not")
        if counts.platform_members != 1 or counts.other_roles != 2:
            failures.append(
                f"role accounting is off: {counts.platform_members} platform "
                f"member(s), {counts.other_roles} in other roles, expected 1 and 2")
        else:
            print("  ok  platform and junk roles are counted, not crashed on")
        absent = [key for key, _ in transit.TAG_COLUMNS
                  if key not in feature["properties"]]
        if absent:
            failures.append(
                f"every column must ship on every feature (a GeoJSONSeq column "
                f"that is null everywhere has no type to infer): missing {absent}")
        elif feature["properties"]["duration"] != transit.ABSENT:
            failures.append("an absent tag must ship as the empty string, got "
                            f"{feature['properties']['duration']!r}")
        else:
            print("  ok  absent tags ship as empty strings, schema pinned")

        # The same relation walked the other way. Its stops are the same four
        # nodes on the same track; only the member sequence says southbound.
        opposite = dict(relation, id=4243, members=[
            member for member in members if member[0] != "n"
        ] + [("n", node_id, "stop") for node_id in (104, 103, 102, 101)])
        against = transit.assemble(opposite, ways, nodes, transit.Counts())
        order = [stop[0] for stop in json.loads(against["properties"]["stops"])]
        if order != [104, 103, 102, 101]:
            failures.append(
                "the member list decides which end is the start — a relation "
                f"listing its stops southbound must stay southbound, got {order}")
        else:
            print("  ok  the opposite direction relation stays the opposite way")

        shuffled = dict(relation, members=(
            [member for member in members if member[0] == "n"]
            + list(reversed([member for member in members if member[0] == "w"]))))
        again = transit.assemble(shuffled, ways, nodes, transit.Counts())
        if json.dumps(again, sort_keys=True) != json.dumps(feature, sort_keys=True):
            failures.append("assemble() is not independent of way-member order — "
                            "the one thing the corpus says cannot be trusted")
        else:
            print("  ok  reordering the way members changes nothing")

    # ── 6. the two rejections ──────────────────────────────────────────────
    counts = transit.Counts()
    stopless = {"id": 7, "tags": {}, "members": [("w", 201, "")]}
    if transit.assemble(stopless, ways, nodes, counts) is not None \
            or counts.no_stops != 1:
        failures.append("a relation with no stop members must be dropped and "
                        "counted — it is a line nobody can board")
    else:
        print("  ok  a stopless relation is dropped")

    counts = transit.Counts()
    lineless = {"id": 8, "tags": {},
                "members": [("n", 101, "stop"), ("w", 8888, "")]}
    if transit.assemble(lineless, ways, nodes, counts) is not None \
            or counts.no_geometry != 1 or counts.unresolved_ways != 1:
        failures.append("a relation whose member ways are all outside the extract "
                        "must be dropped, with the unresolved members counted")
    else:
        print("  ok  a relation with no resolvable geometry is dropped")


def check_merge_discovery(merge, failures: list[str]) -> None:
    """
    find_shards hardening: symlinked directories ARE followed (out-of-tree shard
    links are a supported layout) under a visited-realpath guard — a symlink cycle
    over a non-shard directory terminates cleanly with the shard found exactly
    once (pre-guard, one loop yielded 41 discoveries, ended only by the kernel's
    ELOOP), while a SHARD reached twice by any route is a hard error naming both
    paths (duplicated shards double-count density ADDITIVELY). --shards itself is
    a shard candidate (manifest.json at the root = single-shard merge; stray root
    .fgb without a manifest = the usual incomplete-build error).
    """
    print("\n=== merge.py shard discovery ===")

    def manifest_dir(path: Path) -> Path:
        path.mkdir(parents=True, exist_ok=True)
        (path / "manifest.json").write_text('{"layers": {}}', encoding="utf-8")
        return path

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)

        # --shards pointing straight at ONE build directory is a single-shard merge.
        root = manifest_dir(tmp / "single")
        found = merge.find_shards(root)
        if found != [root]:
            failures.append(f"root manifest.json: expected [{root}], got {found}")
        else:
            print("  ok  a root manifest.json is a single-shard merge")

        # Stray .fgb at the root without a manifest: same hard error as anywhere.
        stray = tmp / "stray"
        stray.mkdir()
        (stray / "leftover.fgb").write_bytes(b"")
        manifest_dir(stray / "good")
        try:
            merge.find_shards(stray)
        except SystemExit as exc:
            if str(stray) in str(exc) and "manifest.json" in str(exc):
                print("  ok  stray root .fgb without a manifest is a hard error")
            else:
                failures.append(f"stray root .fgb: wrong error: {exc}")
        else:
            failures.append("stray root .fgb without a manifest was not an error")
        found = merge.find_shards(stray, allow_incomplete=True)
        if found != [stray / "good"]:
            failures.append(
                f"stray root .fgb with --allow-incomplete: expected the one good "
                f"shard, got {found}")
        else:
            print("  ok  --allow-incomplete still finds the good shard under it")

        # Nested discovery is unchanged.
        nested = tmp / "nested"
        manifest_dir(nested / "eu" / "de" / "berlin")
        manifest_dir(nested / "michigan")
        found = merge.find_shards(nested)
        want = [nested / "eu" / "de" / "berlin", nested / "michigan"]
        if found != want:
            failures.append(f"nested discovery: expected {want}, got {found}")
        else:
            print("  ok  nested shards still found in sorted relative order")

        # THE loop case: a symlink back to an ancestor. Pre-guard this discovered
        # the shard dozens of times before ELOOP; the visited-realpath guard cuts
        # the cycle with a log line, so the shard is found exactly once and the
        # walk terminates.
        loopy = tmp / "loopy"
        shard = manifest_dir(loopy / "shard1")
        (loopy / "loop").symlink_to(loopy, target_is_directory=True)
        try:
            found = merge.find_shards(loopy)
        except (SystemExit, OSError) as exc:
            failures.append(f"symlink loop: discovery failed instead of "
                            f"terminating cleanly: {exc}")
        else:
            if found != [shard]:
                failures.append(
                    f"symlink loop: expected exactly [{shard}] once, got {found}")
            else:
                print("  ok  symlink loop: cycle cut, shard discovered "
                      "exactly once")

        # Symlinks TO shards are followed: a merge tree assembled from links to
        # out-of-tree builds must discover them (silently skipping symlinked dirs
        # is how a world comes up short).
        outside = manifest_dir(tmp / "outside-build")
        linktree = tmp / "linktree"
        linktree.mkdir()
        (linktree / "michigan").symlink_to(outside, target_is_directory=True)
        found = merge.find_shards(linktree)
        if found != [linktree / "michigan"]:
            failures.append(
                f"out-of-tree symlinked shard: expected "
                f"[{linktree / 'michigan'}], got {found}")
        else:
            print("  ok  a symlink to an out-of-tree shard build is followed")

        # Two routes to the SAME shard (the real dir plus a symlink alias) is the
        # duplicate the hard error exists for.
        dup2 = tmp / "dup2"
        real_shard = manifest_dir(dup2 / "shard1")
        (dup2 / "alias").symlink_to(real_shard, target_is_directory=True)
        try:
            merge.find_shards(dup2)
        except SystemExit as exc:
            if "twice" in str(exc):
                print("  ok  a shard reachable via two routes is a hard error")
            else:
                failures.append(f"alias duplicate: wrong error: {exc}")
        else:
            failures.append(
                "a shard reachable twice (real dir + symlink alias) was not "
                "an error")

        # The guard itself: two distinct paths resolving to one realpath where
        # that realpath is a SHARD is a hard error naming both paths. Simulated
        # by collapsing two real dirs to one realpath. (Note the guard resolves
        # symlinks only — true bind-mount duplicates keep distinct realpaths and
        # are documented as undetectable.)
        dup = tmp / "dup"
        a = manifest_dir(dup / "dup-a")
        b = manifest_dir(dup / "dup-b")
        real_realpath = merge.os.path.realpath

        def fake_realpath(path, *args, **kwargs):
            return real_realpath(path, *args, **kwargs).replace("dup-b", "dup-a")

        merge.os.path.realpath = fake_realpath
        try:
            try:
                merge.find_shards(dup)
            except SystemExit as exc:
                if str(a) in str(exc) and str(b) in str(exc):
                    print("  ok  a shard reached twice is a hard error "
                          "naming both paths")
                else:
                    failures.append(f"duplicate shard: error must name both "
                                    f"paths ({a}, {b}): {exc}")
            else:
                failures.append(
                    "duplicate shard (same realpath twice) was not an error")
        finally:
            merge.os.path.realpath = real_realpath


def check_merge_manifest(merge, failures: list[str]) -> None:
    """
    merge.py's manifest rules, exercised through main() with empty-layer shards so
    no GDAL ever runs (place_admin is stubbed):

      * a merge in which NO shard contributes density is a HARD ERROR — a
        features:0 density entry would be trusted by the client as a real zero and
        silently lift the density curses; `--allow-missing-density` publishes with
        the density layer OMITTED instead (absent = the client degrades, safe);
      * feature layers keep their explicit features:0 entries;
      * an --only merge-into drops existing manifest keys the current layer table
        no longer contains, keeps planet_timestamp = the OLDEST of the existing
        manifest's and this run's, and hard-errors on a cell_deg mismatch.
    """
    print("\n=== merge.py manifest rules ===")
    table = merge.load_table()
    cell = table["cell_deg"]
    shard_ts = "2026-03-01T00:00:00Z"

    # Both out-of-band layers are stubbed: they are hardlink-and-ogrinfo, and this
    # check is about the manifest rules around them, not about GDAL.
    real_place_admin = merge.place_admin
    real_place_transit = merge.place_transit
    merge.place_admin = lambda src, out: {
        "path": "admin.stub.fgb", "bytes": 1, "sha256": "0" * 64, "features": 1}
    merge.place_transit = lambda src, out: {
        "path": "transit_route.stub.fgb", "bytes": 1, "sha256": "1" * 64,
        "features": 1}
    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            shards = tmp / "shards"
            shard = shards / "empty-region"
            shard.mkdir(parents=True)
            (shard / "manifest.json").write_text(json.dumps({
                "version": 1, "layers": {},
                "planet_timestamp": shard_ts, "cell_deg": cell,
            }), encoding="utf-8")
            admin = tmp / "admin.fgb"
            admin.write_bytes(b"stub")
            transit = tmp / "transit_route.fgb"
            transit.write_bytes(b"stub")
            base = ["--shards", str(shards), "--admin", str(admin),
                    "--transit", str(transit), "--work", str(tmp / "work")]

            # Zero density contributions: refused, pointing at the escape hatch.
            out1 = tmp / "out-refused"
            try:
                merge.main([*base, "--out", str(out1)])
            except SystemExit as exc:
                if "density" in str(exc) and "--allow-missing-density" in str(exc):
                    print("  ok  zero density contributions is a hard error")
                else:
                    failures.append(f"missing density: wrong error: {exc}")
            else:
                failures.append("a merge with zero density contributions passed")
            if (out1 / "manifest.json").exists():
                failures.append("missing density: a manifest was written anyway")

            # --allow-missing-density: density OMITTED (never features:0),
            # feature layers keep their explicit features:0 entries.
            out2 = tmp / "out-allowed"
            merge.main([*base, "--out", str(out2), "--allow-missing-density"])
            written = json.loads((out2 / "manifest.json").read_text())
            if "density" in written["layers"]:
                failures.append(
                    f"--allow-missing-density: density must be OMITTED, got "
                    f"{written['layers']['density']}")
            elif written.get("partial") is not True:
                failures.append(
                    "--allow-missing-density: an incomplete layer table must "
                    "stamp partial: true")
            else:
                print("  ok  --allow-missing-density omits density and stamps partial")
            if written["layers"].get("park") != {"features": 0}:
                failures.append(
                    "feature layers empty in every shard must keep explicit "
                    f"features: 0, got {written['layers'].get('park')}")
            else:
                print("  ok  empty feature layers keep features: 0")
            if written.get("planet_timestamp") != shard_ts:
                failures.append(
                    f"full merge: planet_timestamp should be the shard's "
                    f"{shard_ts}, got {written.get('planet_timestamp')}")

            # --only merge-into: stale keys dropped, timestamp = min, cell_deg
            # must match.
            def existing_manifest(out: Path, ts: str, cell_deg: float) -> None:
                out.mkdir(parents=True, exist_ok=True)
                (out / "manifest.json").write_text(json.dumps({
                    "version": 1, "admin_source": "overture",
                    "cell_deg": cell_deg, "planet_timestamp": ts,
                    "layers": {
                        "park": {"features": 7, "path": "park.old.fgb"},
                        "retired_layer": {"features": 3, "path": "retired.fgb"},
                    },
                }), encoding="utf-8")

            out3 = tmp / "out-only-older"
            existing_manifest(out3, "2026-01-01T00:00:00Z", cell)
            merge.main([*base, "--out", str(out3), "--only", "park"])
            written = json.loads((out3 / "manifest.json").read_text())
            if "retired_layer" in written["layers"]:
                failures.append(
                    "--only merge-into carried forward a key no longer in the "
                    "layer table (retired_layer)")
            else:
                print("  ok  --only drops stale manifest keys")
            if written.get("planet_timestamp") != "2026-01-01T00:00:00Z":
                failures.append(
                    "--only merge-into: planet_timestamp must be the OLDEST of "
                    "existing and this run's (2026-01-01), got "
                    f"{written.get('planet_timestamp')}")
            else:
                print("  ok  --only keeps the older existing planet_timestamp")

            out4 = tmp / "out-only-newer"
            existing_manifest(out4, "2026-12-01T00:00:00Z", cell)
            merge.main([*base, "--out", str(out4), "--only", "park"])
            written = json.loads((out4 / "manifest.json").read_text())
            if written.get("planet_timestamp") != shard_ts:
                failures.append(
                    "--only merge-into: a NEWER existing timestamp must lose to "
                    f"this run's older {shard_ts}, got "
                    f"{written.get('planet_timestamp')}")
            else:
                print("  ok  --only takes this run's older shard timestamp")

            out5 = tmp / "out-cell-mismatch"
            existing_manifest(out5, "2026-01-01T00:00:00Z", cell * 2)
            try:
                merge.main([*base, "--out", str(out5), "--only", "park"])
            except SystemExit as exc:
                if "cell_deg" in str(exc):
                    print("  ok  --only refuses a cell_deg mismatch")
                else:
                    failures.append(f"cell_deg mismatch: wrong error: {exc}")
            else:
                failures.append(
                    "--only merged into a manifest with a DIFFERENT cell_deg")
            # --transit is required on exactly the runs --admin is, and for the
            # same reason: a route relation is no more shardable than an admin
            # boundary, so a full merge that omits it would publish a world in
            # which the OSM fallback tier silently does not exist.
            out6 = tmp / "out-no-transit"
            try:
                merge.main(["--shards", str(shards), "--admin", str(admin),
                            "--work", str(tmp / "work6"), "--out", str(out6),
                            "--allow-missing-density"])
            except SystemExit as exc:
                if "--transit" in str(exc):
                    print("  ok  a full merge without --transit is refused by name")
                else:
                    failures.append(f"missing --transit: wrong error: {exc}")
            else:
                failures.append("a full merge published without a transit_route "
                                "layer")

            # And when it IS placed it reaches the manifest as a real entry with
            # a path, beside admin — layer presence is the whole capability
            # signal the client reads for the OSM fallback tier.
            out7 = tmp / "out-with-transit"
            merge.main([*base, "--out", str(out7), "--allow-missing-density"])
            written = json.loads((out7 / "manifest.json").read_text())
            entry = written["layers"].get("transit_route")
            if not isinstance(entry, dict) or "path" not in entry:
                failures.append(
                    f"a full merge must list transit_route with a path, got {entry}")
            else:
                print("  ok  transit_route is placed and listed with a path")
    finally:
        merge.place_admin = real_place_admin
        merge.place_transit = real_place_transit


def check_cover(cover, failures: list[str]) -> None:
    """
    cover.py's fine-membership rule: a region is a member when its residual still
    contains LAND that no member already covers.

    Two proxies preceded it and both shipped holes. "Contains no other region" drops
    every region containing an ENCLAVE, taking its non-enclave territory along —
    London, Hanover, Marseille, Casablanca, Guangzhou, Sydney, Kyiv, Lviv. "At least
    70% uncovered" then dropped one that is 62.9% uncovered — central-america's
    Lesser Antilles, italy's San Marino. The fixture below is built so that ONE extra
    region flips the continent in or out, which is the whole rule in one comparison.
    """
    print("\n=== cover.py fine membership ===")
    from shapely.geometry import box, mapping, Point  # noqa: PLC0415

    # Land: a mainland the countries sit on, an island, and a far archipelago that
    # only the continent-sized region reaches.
    land = [box(0, 0, 100, 50), box(0, 60, 10, 70), box(70, 60, 72, 62)]
    land_mask = (land, cover.STRtree(land))

    base = {
        "continent": box(0, 0, 100, 100),
        "country-a": box(0, 0, 50, 50),
        "quarter-sw": box(0, 0, 25, 25), "quarter-se": box(25, 0, 50, 25),
        "quarter-nw": box(0, 25, 25, 50), "quarter-ne": box(25, 25, 50, 50),
        "country-b": box(50, 0, 100, 50),
        "enclave": box(60, 10, 62, 12),
        "island": box(0, 60, 10, 70),
    }
    def regions_for(shapes):
        return [cover.Region(rid, f"https://example.invalid/{rid}.osm.pbf", geom)
                for rid, geom in shapes.items()]

    # ── the archipelago has no extract of its own: the continent is its ONLY source
    members, assigned, uncovered = cover.compute_fine(regions_for(base), land_mask)
    got = {m.id for m in members}
    expected = {"quarter-sw", "quarter-se", "quarter-nw", "quarter-ne",
                "country-b", "enclave", "island", "continent"}
    if got == expected:
        print("  ok  a region is kept when it is the only source for land")
    else:
        failures.append(f"cover: expected {sorted(expected)}, got {sorted(got)}")
    if "country-b" in got:
        print("  ok  a region whose only smaller member is an enclave stays in")
    else:
        failures.append("cover: the enclave parent was dropped — the leaf bug is back")
    if "country-a" not in got:
        print("  ok  a region its own sub-regions already cover is dropped")
    else:
        failures.append("cover: a fully subdivided region was kept")
    if uncovered.area <= cover.LAND_EPSILON_DEG2:
        print(f"  ok  no land left over ({uncovered.area:.6f} deg²)")
    else:
        failures.append(f"cover: {uncovered.area:.4f} deg² of land uncovered")

    # ── give the archipelago its own extract and the continent must drop out
    with_arch = dict(base, **{"archipelago": box(69.5, 59.5, 72.5, 62.5)})
    got2 = {m.id for m in cover.compute_fine(regions_for(with_arch), land_mask)[0]}
    if "archipelago" in got2 and "continent" not in got2:
        print("  ok  and drops out as soon as a smaller region covers that land")
    else:
        failures.append(
            f"cover: the continent did not yield to the archipelago: {sorted(got2)}")

    # Members must partition, not overlap: two shards counting one density cell is
    # exactly what --clip-region exists to prevent.
    overlap, ids = 0.0, [m.id for m in members]
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            overlap += assigned[a].intersection(assigned[b]).area
    if overlap < 1e-9:
        print(f"  ok  assigned geometries pairwise disjoint (overlap {overlap:g})")
    else:
        failures.append(f"cover: assigned geometries overlap by {overlap:g} deg²")

    for label, lon, lat, want in (("inside the enclave", 61.0, 11.0, "enclave"),
                                  ("in the enclave's parent", 80.0, 25.0, "country-b"),
                                  ("in a subdivided parent", 10.0, 10.0, "quarter-sw"),
                                  ("on the far archipelago", 71.0, 61.0, "continent")):
        owners = [m.id for m in members if assigned[m.id].contains(Point(lon, lat))]
        if owners == [want]:
            print(f"  ok  a point {label} -> {want}")
        else:
            failures.append(f"cover: point {label} -> {owners}, want [{want}]")

    # ── the two guards, through main(), with the network and the land mask stubbed.
    # Both must refuse BEFORE writing: a rejected cover that already replaced
    # cover-geometries/ is worse than none, because the next density build reads it.
    real_fetch, real_fill, real_land = cover.fetch_index, cover.fill_sizes, cover.load_land

    def run_main(shapes, extra=(), fat=None, blind=False):
        index = {"features": [
            {"properties": {"id": rid,
                            "urls": {"pbf": f"https://example.invalid/{rid}.osm.pbf"}},
             "geometry": mapping(geom)} for rid, geom in shapes.items()]}
        cover.fetch_index = lambda url: (index, "test")
        cover.load_land = lambda *a, **k: land_mask
        cover.fill_sizes = lambda regions_, workers: [
            setattr(r, "est_bytes", cover.MAX_FINE_BYTES + 1 if r.id == fat else 1000)
            for r in regions_]
        saved = cover.land_area
        if blind:
            # Simulate the membership rule going wrong WITHOUT touching the check's
            # own threshold: a rule that sees no land keeps nothing, and every piece
            # of land must then show up in the assertion.
            cover.land_area = lambda geom, land: 0.0
        try:
            with tempfile.TemporaryDirectory() as tmp:
                out, geoms_dir = Path(tmp) / "shards.json", Path(tmp) / "cover-geometries"
                args = ["--out", str(out), "--geometries-dir", str(geoms_dir)] + list(extra)
                try:
                    result = cover.main(args)
                except SystemExit as exc:
                    result = exc
                return result, (out.exists(), geoms_dir.exists())
        finally:
            cover.land_area = saved

    try:
        # A rule that stops keeping enough regions must be caught by the assertion,
        # not shipped. Raising the land threshold above every residual simulates it.
        outcome, wrote = run_main(with_arch, blind=True)
        if isinstance(outcome, SystemExit) and "belong to no density shard" in str(outcome):
            print("  ok  land belonging to no density shard is a hard error")
        else:
            failures.append(f"cover: uncovered-land assertion did not fire: {outcome!r}")
        if any(wrote):
            failures.append("cover: the uncovered-land assertion wrote before refusing")

        # The two clauses interacting: make the continent — the archipelago's only
        # source — too big to build, and that land must surface as uncovered rather
        # than as an oversized shard nobody could run.
        outcome, wrote = run_main(base, fat="continent")
        if isinstance(outcome, SystemExit) and "belong to no density shard" in str(outcome):
            print("  ok  land whose only source is unbuildable is reported, not shipped")
        else:
            failures.append(f"cover: unbuildable-source case did not refuse: {outcome!r}")
        if any(wrote):
            failures.append("cover: refused after writing")

        outcome, wrote = run_main(with_arch)
        if outcome == 0 and all(wrote):
            print("  ok  a clean cover publishes, and writes both outputs")
        else:
            failures.append(f"cover: a clean cover did not publish: {outcome!r} {wrote}")
    finally:
        cover.fetch_index, cover.fill_sizes, cover.load_land = \
            real_fetch, real_fill, real_land


def main() -> int:
    build = load_build()
    failures: list[str] = []

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        bindir = tmp / "bin"
        bindir.mkdir()
        stub = bindir / "pyosmium-up-to-date"
        stub.write_text(STUB)
        stub.chmod(stub.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

        ts_file = tmp / "ts.txt"
        plan_file = tmp / "plan.json"
        planet = tmp / "planet.osm.pbf"
        planet.write_bytes(b"\0" * 4096)   # never parsed; the stub does not read it

        os.environ["STUB_TS"] = str(ts_file)
        os.environ["STUB_PLAN"] = str(plan_file)
        os.environ["PATH"] = f"{bindir}{os.pathsep}{os.environ['PATH']}"

        # The loop's progress guard is driven entirely by this, so point it at whatever
        # the stub last claimed rather than at a real PBF header.
        build.planet_timestamp = lambda _p: (
            ts_file.read_text().strip() if ts_file.exists() else None)

        def scenario(name, steps, *, want_changed, want_calls,
                     start="2026-07-20T00:00:00Z"):
            ts_file.write_text(start)
            plan_file.write_text(json.dumps({"calls": 0, "steps": steps}))
            print(f"\n=== {name} ===")
            changed = build.stage_update_planet(
                planet, no_update=False, freshly_downloaded=False)
            calls = json.loads(plan_file.read_text())["calls"]
            print(f"  -> changed={changed}, updater invoked {calls}x")
            if changed is not want_changed or calls != want_calls:
                failures.append(
                    f"{name}: expected changed={want_changed} calls={want_calls}, "
                    f"got changed={changed} calls={calls}")

        # A — the normal weekly case: two --size-limited passes, then current.
        scenario("partial, partial, done (rc 1,1,0)", [
            {"rc": 1, "ts": "2026-07-23T00:00:00Z"},
            {"rc": 1, "ts": "2026-07-26T00:00:00Z"},
            {"rc": 0, "ts": "2026-08-01T00:00:00Z"},
        ], want_changed=True, want_calls=3)

        # B — THE ONE THAT MATTERS. rc 1 forever, no progress. Must stop at one call;
        # blind retrying would be 24 gigabyte-sized downloads for nothing.
        scenario("stuck: rc 1 without advancing", [{"rc": 1, "ts": None}],
                 want_changed=False, want_calls=1)

        # C — a real error is not retried either.
        scenario("hard failure (rc 2)", [{"rc": 2, "ts": None}],
                 want_changed=False, want_calls=1)

        # D — nothing to do. Must report unchanged, so downstream stages keep their
        # cached intermediates instead of rebuilding for no reason.
        scenario("already current (rc 0, no change)", [{"rc": 0, "ts": None}],
                 want_changed=False, want_calls=1)

        # E — opt-outs never invoke the updater at all.
        for label, kwargs in (("--no-update", {"no_update": True, "freshly_downloaded": False}),
                              ("fresh download", {"no_update": False, "freshly_downloaded": True})):
            ts_file.write_text("2026-07-20T00:00:00Z")
            plan_file.write_text(json.dumps({"calls": 0, "steps": [{"rc": 0, "ts": None}]}))
            print(f"\n=== skipped: {label} ===")
            changed = build.stage_update_planet(planet, **kwargs)
            calls = json.loads(plan_file.read_text())["calls"]
            print(f"  -> changed={changed}, updater invoked {calls}x")
            if changed is not False or calls != 0:
                failures.append(f"{label}: expected no invocation, got {calls}")

    check_where_rewriter(build, failures)
    check_geometry_classes(build, failures)
    check_density_clip(build, failures)
    check_density_cache(build, failures)

    # build-transit.py imports build.py and defers osmium to the function bodies,
    # so its assembly is plain data in, plain data out — no PBF, no GDAL, no I/O.
    check_route_assembly(load_module("build-transit"), failures)

    merge = load_module("merge")
    check_merge_discovery(merge, failures)
    check_merge_manifest(merge, failures)

    check_cover(load_module("cover"), failures)

    print()
    if failures:
        for f in failures:
            print(f"  FAIL  {f}")
        print(f"{len(failures)} failed")
        return 1
    print("update loop, where-rewriter, geometry classes, density clip + cache, "
          "transit route assembly, merge discovery/manifest rules, and the fine "
          "cover behaved as intended")
    return 0


if __name__ == "__main__":
    sys.exit(main())
