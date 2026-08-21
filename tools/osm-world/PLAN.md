# PLAN — Option B: sharded build, global delivery

The goal: serve the OSM layer entirely from static files, globally, with the browser
client **unchanged** from what `osm/worldfile.js` + `osm/flatgeobuf.js` already implement
and test. Shards exist only inside the build; the client sees one world at one base URL,
exactly as `openWorld(baseUrl)` works today.

This plan consolidates a research session (2026-08-16) that ran four real builds, an
audit of the data model, and a re-examination of the format choice. Every number in it
is measured unless marked as an estimate. Baselines for before/after comparison live on
kadro at `~/osm-builds/` — see §Baselines.

**Status (2026-08-16, end of session).** Phase 0 and Phase 1 are **DONE and verified on
two real builds**, and a retest wave has since rebuilt and re-verified both with the
`advertising` fix (**michigan-v3**, **germany-v3** — see §Phase 0 Result). Spikes S1 and
S2 are **RESOLVED** — Option B is confirmed and Overture admin is adopted. Phase 2's
tooling, Phase 3's merge + cover, and Phase 4's workflows are written and exercised; the
same retest wave verified `merge.py`'s recursive shard discovery, its loud
incomplete-shard failure, `--unlink-source`, and the density `--clip-region` fix
end-to-end against ground truth (§Phase 3). S3 (a real Actions run) is the one open
spike; H2b (cross-tile feature duplication rate) is the one open measurement.

| | before | after | |
| --- | ---: | ---: | ---: |
| michigan | 643,681,472 B | 232,847,376 B | **−63.8%** |
| germany | 9,004,762,856 B | 3,343,969,105 B | **−62.9%** |

Both are Phase 0 + Phase 1 compound, same source PBFs, all correctness checks green —
these are the **michigan-v3** / **germany-v3** totals, the advertising-fix rebuilds that
superseded michigan-v2/germany-v2 (9,288 B and 135,248 B smaller respectively, short
exactly the 56 and 816 dropped `advertising` features).

---

## Why Option B

A planet-monolith build is impossible: `stage_density` holds every populated cell in a
Python dict, and the measured law is

    peak RSS ≈ 1.29 GB + 1.53 kB × cells

Michigan produced 644,967 cells (2.21 GB true peak, `/usr/bin/time -v`; `ps` sampling
under-measures — it caught 940 MB). Germany produced 4,612,683 cells (7.88 GB peak).
Cell count is bounded by land area and saturates — Michigan populates 9.4% of its
available 0.002° cells, Germany 40% — so scaling from both ends brackets the planet at
**90–196M cells → 139–301 GB of RAM**. No machine in play, no free tier, no runner.

Sharding the *build* fixes that (feature stages run flat at 2.18–2.38 GB RSS regardless
of shard size; density is per-shard-linear). Sharding the *delivery* — Option A — was
measured too, and it breaks something: **an administrative area only assembles into a
polygon when its relation fits entirely inside the extract.** Confirmed on 17 builds:
`us/michigan` has 73 level-2 features, all zero-area LINESTRINGs, no USA polygon; the
germany monolith yields `Deutschland [DE]` as a MULTIPOLYGON while 15 of its 16 state
sub-tiles have no country polygon at all. Option B sidesteps per-tile admin entirely and
keeps all sharding complexity out of the client.

Option A was the documented fallback if the merge spike (S1) failed. **S1 passed** — see
§Phase 3 — so Option A stays rejected and is kept below only so it stays rejected.

---

## Measured constants (2026-08-16, planet snapshot 2026-08-15T20:21:20Z)

| build | source | wall | output | peak RSS | cells |
| --- | ---: | ---: | ---: | ---: | ---: |
| us/michigan, 4-core/3.9 GB VM | 311 MB | 22:09 | 644 MB | 2.21 GB | 644,967 |
| us/michigan, 16-core/31 GB (kadro) | 311 MB | 3:36 | 644 MB | 2.21 GB | 644,967 |
| europe/germany monolith (kadro) | 4,820 MB | 32:26 | 9.00 GB | 7.88 GB | 4,612,683 |
| 16 germany sub-tiles, 2-concurrent | 4,927 MB | — | 8,884 MiB | 2.2–2.4 GB each | — |
| **michigan-v2** (Phase 0+1, kadro) | 311 MB | 4:08 | **232,838,088 B** | 2.21 GB | 644,967 |
| **germany-v2** (Phase 0+1, kadro) | 4,820 MB | 34:32 | **3,343,833,857 B** | 7.91 GB | 4,612,683 |
| **michigan-v3** (advertising fix, kadro) | 311 MB | 4.4 min | **232,847,376 B** | not captured this run | 644,967 |
| **germany-v3** (advertising fix, kadro) | 4,820 MB | 34.5 min | **3,343,969,105 B** | 8.3 GB | 4,612,683 |

**Phase 0+1 do not move peak RSS or wall clock, and were never going to.** Peak RSS is
`stage_density`'s dict and the reductions are all in the feature stages: michigan stayed
at 2.21 GB, germany went 7.88 → 7.91 GB (8,293,856 kB, `/usr/bin/time -v`), and cell
count is identical in both builds (germany 4,612,683 before and after — R4 omits zero
*properties*, not cells). The RSS law is unchanged and still governs shard sizing.
Wall clock: michigan 3:36 → 4:08, germany 32:26 → 34:32 (+6.5%) — the dedup and
diagonalize passes are a streaming read, and R2 splits one curse layer into two smaller
ones. Both within run-to-run variance plus the new stages.

- **Reproducible**: the two Michigan builds are byte-identical — same 643,681,472-byte
  total, same per-layer sha256 — across different core counts, kernels, filesystems.
  This is what allows content-addressed filenames (§Phase 3).
- **Time** (six content-homogeneous German tiles, R² = 0.9952):
  `t ≈ 6.5 s + 0.533 s/MB` on kadro. Fixed cost is ~7% of a 500-shard rebuild, not
  worth optimising shard count for. (An earlier 97 s fixed-cost figure was an artifact
  of fitting two regions with different layer mixes.) The 4-core VM measured 4.27 s/MB
  overall but was RAM-starved; CI-class throughput is unknown until S3.
- **Sharding overhead in bytes**: sources +2.24% (Geofabrik's cutting polygons are
  buffered), outputs +3.5%. Both vanish under Option B's merge.
- **Client cost today**: a partial query (6 feature layers + admin + density, Grand
  Rapids bbox) = 1,212 range requests / 7.0 MB. Floor: one manifest + a 16 kB header
  probe per layer ≈ 0.6 MB before any feature bytes. Overpass moved ~40 MB in ~10
  requests. Bytes are fine; request count is the metric to watch. (Measured pre-Phase-0,
  so those requests include the double-emitted features. Post-Phase-1 comparables, both
  through the real reader: the merged 3-shard world is 306 requests / 5.8 MB, and the
  Overture admin file alone is 32 requests / 7.49 MB for a city bbox — admin is now the
  dominant term.)
- **Planet PBF** is 94.3 GB (docs in this repo still say 87.6 — stale). The finest
  disjoint cover of Geofabrik's 555 regions is **514 members totalling 114.2 GB**, largest
  africa at 7.90 GB (`cover.py`, re-run 2026-08-20 under the land rule; the superseded
  leaf rule gave 500 / 78.4 GB and a 70%-residual rule gave 512 / 82.4 GB, both with
  holes over inhabited land — see §Phase 3 cover fix).
  Note `index-v1.json`'s `parent` field is a display hierarchy, not a tree — `us`,
  `us-midwest`, `us/michigan` are siblings; the cover must be computed geometrically,
  and `cover.py` does.
- **Geofabrik `.md5` sidecars** 302-redirect to mirrors and name the *dated* file
  (`germany-260815.osm.pbf`), not `-latest`. `build.py`'s `expected_md5` handles both
  correctly (urllib follows redirects; hash-only comparison). Shell scripts must use
  `curl -L` and compare hashes, never `md5sum -c`.

---

## Phase 0 — fix the double-emit bug (correctness; blocks all measurement) — **DONE**

`export_layer` passes `--geometry-types=point,linestring,polygon` to every
`osmium export`, so **every closed way is emitted twice**: once as its polygon, once as
the same ring re-read as a zero-area linestring. Verified on one feature —
`osm_id 30513335` appears as `MULTIPOLYGON (area 6.4e-05)` and `LINESTRING (area 0)`.
Nothing downstream dedups: `featuresToPois`' only dedup is node-swallowed-by-area
(`osm/worldfile.js:570`), which never touches ways.

Measured inflation (rows vs distinct `osm_type:osm_id`):

| layer | rows | distinct | factor |
| --- | ---: | ---: | ---: |
| park (michigan) | 12,567 | 6,550 | 1.92× |
| green (bayern) | 876,339 | 447,532 | 1.96× |
| pitch (bayern) | 139,706 | 74,668 | 1.87× |
| library (michigan) | 1,016 | 614 | 1.65× |
| restaurant (michigan) | 8,756 | 6,119 | 1.43× |
| water (michigan) | 25,195 | 18,684 | 1.35× |

Consequences: published counts inflated up to 2×, and each duplicate yields a **second
POI at a different coordinate** (polygon copy → area-weighted centroid; linestring copy
→ `polylineMidpoint`), feeding the legal-spot shortlist and per-zone distances. The
suite cannot see it: all 19 golden numbers run `useOsm: false`.

**Fix.** Per-layer geometry types are not quite enough on their own — `water` is
legitimately mixed (lake polygons + river linestrings). Two parts:

1. Wire up the dead `Layer.keep_geometry` field (`build.py:201`, set for admin at
   `:244`, read by nothing) into a per-layer `--geometry-types` argument: `polygon` for
   pure-area layers, `point` for pure-node layers, mixed only where genuinely mixed
   (`water`, `coastline`, `high_speed_rail`, `platform`, curse layers pre-R1).
2. For the genuinely mixed layers, add a streaming dedup pass (template:
   `apply_post_filter`, `build.py:758`) that drops a linestring feature whose
   `(osm_type, osm_id)` was already emitted as a polygon.

**Verification.** Add a closed way to `make-fixture.py` / `make-test-world.py` and
assert exactly one record; extend `test-pipeline.mjs` accordingly. Then rebuild
michigan + germany and diff against the kadro baselines — expect area-layer bytes to
drop ~35–50% and every `rows == distinct` check to pass. Note this *corrects* published
counts; the report pages' numbers will change, and should.

### Result

Implemented as `geometry` (+ `dedup`) per entry in `categories.json`, read by
`Layer.geometry_types` and `apply_geometry_dedup` in `build.py`. Both rebuilds pass:

- **`rows == distinct(osm_type, osm_id)` on all 8 required layers, germany-v2**: green
  2,736,050; pitch 453,437; park 14,194; water 68,100; admin 33,257; restaurant 103,270;
  library 5,764; shop 486,941 — every one equal. Michigan-v2 likewise.
- Feature counts fall by roughly the predicted factors: germany green 5,374,835 →
  2,736,050 (1.96×, exactly the bayern prediction), pitch 849,229 → 453,437,
  park 26,868 → 14,194, water 97,669 → 68,100.

**Correction found in review — `advertising` was misclassified.** It was
`point,polygon`, but `advertising=*` describes a physical object, `area=*` never
applies, and a billboard *face* is legitimately drawn as a short open way. Those ways
were never exported at all: **56 of 772 distinct entities lost in michigan (7.3%), 816 of
35,816 in germany (2.3%)**, silently. Now `point,linestring,polygon` + `dedup` (the
platform route); michigan rebuilds to 772 features against michigan-v2's shipped 716.

Every other `point,polygon` layer was then re-audited **empirically** on both extracts —
per layer, export all three geometry types, apply the layer's `where`, count distinct
entities appearing as a linestring and never as a polygon (exactly what the class
drops). Michigan / Germany: shelter 0 / 24 of 99,512; pitch 0 / 61 of 453,498; park 0 /
2 of 14,196; shop 1 of 27,295 / 0; place_of_worship 0 / 1 of 72,054; fast_food 0 / 1 of
44,034; and **exactly zero on both** for museum, movie_theater, hospital, library, zoo,
aquarium, amusement_park, golf_course, foreign_consulate, commercial_airport,
rail_station, toilets, grocery, newsagent, restaurant, cafe. All kept as area-only, and
the judgement is written down in `categories.json`'s "THE point,polygon AUDIT" block:
`amenity`/`tourism`/`shop`/`office`/`leisure`/`landuse`/`aeroway=aerodrome`/
`railway=station` describe a place and OSM documents no linear form, so the residual
handful are mapping errors; every key that *does* have a documented linear form is
already in the mixed class. `admin` is the deliberate outlier at 1,308/3,218 (40.7%) MI
and 86,039/119,296 (72.1%) DE — all boundary member ways, which is what R3 is for.
Raw audit output: `kadro:~/osm-builds/audit-w2/{mi.tsv,de.tsv}`.

**`germany-v2/` and `michigan-v2/` on kadro predate the advertising fix** — their
`advertising` layers were 816 and 56 features short. **Rebuilt and verified — this is
now closed.** `michigan-v3` and `germany-v3` are the current, publishable baselines;
v2 is kept only as a diff reference.

- **michigan-v3**: clean build log (no Traceback/Error), "built 35 layers, 0.23 GB, in
  4.4 min". `advertising.fgb`: rows == distinct(osm_type,osm_id) == **772**, matching
  the michigan-v2-shipped-716 expectation. `diff-layers.sh` against michigan-v2 shows
  **exactly 1 differing layer** — `advertising` (716→772 features, 107,216→116,504
  bytes) — out of 35 total; all other 34 layers are byte-for-byte/sha256-identical to
  michigan-v2, confirming Phase 0's `where`-rewriter and geometry-class changes touched
  nothing else. Manifest sum **232,847,376 B** (222.06 MiB), `du -sh` 223M, within the
  expected ~232–234 MB range. Manifest coherence: all 35 `.fgb` files on disk match the
  manifest's byte sizes and per-layer feature counts exactly (all 35 checked, not
  sampled).
- **germany-v3**: built 37 layers, **3,343,969,105 B** (3.34 GB), 34.5 min wall, exit
  status 0 (`/usr/bin/time -v`: wall 34:31.51, max RSS 8.3 GB); zero
  Traceback/Error/Failed/Exception matches in the full log, including zero recurrences
  of the `SetAttributeFilter` `-skipfailures` bug. `advertising`: 35,816 rows ==
  distinct — exactly the target baseline (mono's raw pre-dedup count was 36,161;
  germany-v2 predates the fix and was short by 816). `rows == distinct` reconfirmed on
  green (2,736,050), pitch (453,437), park (14,194), water (68,100), admin (33,257),
  restaurant (103,270), library (5,764), shop (486,941), and advertising (35,816). Curse
  diagonal check: `curse_cairn_terrain` (337,403), `curse_travel_agent_stop` (421,694),
  `curse_water` (522,279) all 2-point LINESTRINGs, 0 non-LineString rows. R2 identity
  reconfirmed: 2,736,050 − 10,308 + 89,197 = 2,814,939. Density unchanged at 4,612,683
  cells. Total bytes are +135,248 over germany-v2 — smaller than the ~1 MB estimate but
  the right direction and within range. germany-v2 was left untouched on kadro for
  reference.

**Second bug, found the same way and worse:** a `where` clause naming a column absent
from the export schema did **not** abort. `build.py` passes `-skipfailures`, and GDAL
3.12 with it prints `ERROR 1: SetAttributeFilter(...) failed`, **exits 0, and copies
every feature through unfiltered** — a layer that builds, lands in the manifest, and has
silently wrong counts. Fixed by `rewrite_where(where, present, key) -> str | None` in
`build.py`, which constant-folds every predicate over an absent column (absent ⇒ NULL
for every feature, so the predicate has a known constant value), returning the rewritten
SQL, `""` for unconditionally-true, or `None` for can-never-match (layer omitted from
the manifest, same state an empty layer already produces). A prefix `NOT` over a missing
column raises `SystemExit` instead of folding — that is the one place SQL's UNKNOWN
stops behaving like FALSE. Clauses with nothing to fold come back byte-identical, and
`test-update.py` asserts that for all 42 clauses in the build table.

---

## Phase 1 — zero-risk payload reductions (~45% of output, no published number moves) — **DONE**

From the data-model audit (verified against the code, file:line cited):

- Only 3 categories keep geometry on the client:
  `RING_CATEGORIES = ['commercial_airport', 'park', 'water']` (`osm/geodata.js:282`) —
  and `commercial_airport`'s rings are kept but never read (`zonePolygonHits` is only
  read for `park`, `rules/score.js:1064`). Everything else is representative-point+tags.
  (Now 2: `['park', 'water']` at `osm/geodata.js:330`.)
- The four `curse_*` layers — 3,893 MiB on germany, 45% of the build — are **count-only**:
  the curse loop (`osm/geodata.js:1011`) calls `worldCount`, which walks the R-tree and
  reads zero feature bytes. `worldPois` is never called on them.

| # | change | saving | mechanism / safety argument |
| --- | --- | ---: | --- |
| R1 | curse layers → 2-point bbox-diagonal linestrings, no properties | ~36% | A diagonal `(minX,minY)→(maxX,maxY)` has exactly the original envelope, so every R-tree node bbox and `search` result is bit-identical. No client change. Forecloses ever drawing curse features — acceptable, nothing ever has. |
| R2 | delete `curse_animal_habitat`; compute its count as a partition identity | ~6% | `landuse` is single-valued, so `count = worldCount(green) − worldCount(green_recreation_ground) + worldCount(animal_delta)` is exact over unchanged envelopes. Two small new layers (~240k features); client change at `osm/geodata.js:1005-1014` (`CURSE_WORLD_LAYERS` entry becomes an expression). |
| R3 | admin: polygons only | ~1.5% | 86,719 of germany's 119,976 admin features (72%) are boundary-way LINESTRINGs discarded at `osm/worldfile.js:699`. Largely subsumed by Phase 0's per-layer geometry types; `-R` cannot be used (osmium export needs member ways to assemble relations) — filter at export/ogr2ogr instead. |
| R4 | density: omit zero-valued properties per cell | ~1.3% | `worldDensity` already skips zeros on read (`worldfile.js:654-658`); absent == 0 by construction. |
| R5 | project away the 23 build-only columns | ~1% | `include_tags` has 35 columns; the client reads 12 of them at runtime (`name`, `name:en`, `natural`, `cuisine`, `access`, `foot`, `entry`, `opening_hours`, `admin_level`, `ISO3166-1`, `ISO3166-1:alpha2`, `ISO3166-2`) plus `osm_type`/`osm_id` — 14 in `runtime_columns`, 23 build-only. Keep the rest through `where`, then `ogr2ogr -select` them away, intersected with the columns the layer actually carries (`-select` hard-fails on a missing field). |

`name:en` earns its place for real now, which it did not when this row was written: the
admin ladder prefers it (`AdminArea.nameEn` → `tags['name:en']` in `adminInfo`), so a
Swiss map says "Switzerland" instead of `Schweiz/Suisse/Svizzera/Svizra`. That matters
more under Overture, whose `name` is local-language for every division.

Cosmetic, same PR: drop `commercial_airport` from `RING_CATEGORIES` (**done** —
`osm/geodata.js:330` is now `['park', 'water']`); note that `spotOpenAllHours` is dead
code (`pathIds = null` unconditionally at `geodata.js:1769` makes `verify` always true
at `:1188`).

**Deferred, not rejected — R6**: ship `green`/`pitch` as precomputed representative
points (+24%, germany 2,982 → ~890 MiB). It changes count semantics from
geometry-intersects-bbox to point-in-padded-bbox (measured divergence <1% on michigan
probes, but nonzero), and `pitch` is the `tumble_ground` curse predicate, where a count
hitting zero auto-removes a curse. Requires re-wording the §09 provenance promise
("re-run any selector at overpass-turbo.eu") and `partial`-marking. Decide after
Phases 0–2 land and real sizes are known.

**Expected result**: germany ≈ 9.0 → ~3.5–4 GB; global ≈ **60–70 GB** (estimate;
re-measure). ~45 GB if R6 is taken later. R2 storage at that size ≈ $1/month.

### Result

Germany came in at **3,343,833,857 B — better than the estimate's low end.** Per layer,
old → new bytes (features):

| layer | old | new | old feat | new feat |
| --- | ---: | ---: | ---: | ---: |
| `curse_animal_habitat` (retired, R2) | 2,968,744,248 | — | 5,523,884 | — |
| `green` | 2,839,170,144 | 1,570,608,168 | 5,374,835 | 2,736,050 |
| `density` | 676,527,800 | 594,652,352 | 4,612,683 | 4,612,683 |
| `curse_water` (R1) | 481,384,488 | 64,066,912 | 986,409 | 522,279 |
| `admin` | 410,431,888 | 320,534,416 | 119,976 | 33,257 |
| `curse_cairn_terrain` (R1) | 354,318,792 | 41,388,800 | 665,262 | 337,403 |
| `pitch` | 287,034,664 | 158,227,544 | 849,229 | 453,437 |
| `curse_travel_agent_stop` (R1) | 278,013,616 | 51,728,480 | 738,339 | 421,694 |
| `animal_delta` (new, R2) | — | 10,942,192 | — | 89,197 |
| `green_recreation_ground` (new, R2) | — | 1,265,160 | — | 10,308 |

Reading the mechanisms off that table: **R1** is the biggest single lever — the three
surviving curse layers drop 86–92% of their bytes at unchanged envelopes. **R2** removes
germany's single largest layer (2.97 GB) and replaces it with 12.2 MB of derived terms.
**R3** takes admin from 119,976 features to 33,257 (72.3% were boundary member ways, the
predicted 72%); bytes fall less than features because what remains is the polygons.
**R4** is 12.1% of the density grid over an identical 4,612,683 cells. **R5** is spread
across every feature layer — e.g. bench keeps all 831,532 features and still loses 9.8%
of its bytes, which is pure column projection.

**The R2 identity holds.** Michigan is exact against its own baseline:
61,160 − 790 + 17,426 = **77,796**. Germany is internally consistent —
2,736,050 − 10,308 + 89,197 = 2,814,939, all three layers present and populated, no
nulls — but is not comparable to the baseline's retired layer, whose 5,523,884 rows were
double-emitted. **The R1 diagonals are verified as diagonals**, not just as counts:
germany's `curse_cairn_terrain` 337,403 rows / 337,403 two-point / 0 non-LineString;
`curse_travel_agent_stop` 421,694 / 421,694 / 0; `curse_water` 522,279 / 522,279 / 0.

---

## Phase 2 — admin moves to Overture `division_area` — **ADOPTED** (S2 resolved)

Per-tile admin is unfixable by construction (§Why Option B), and even the monolith
approach only works per-country. Overture ships **already-assembled polygons**, which
cannot fail the relation-assembly way:

- Type: `division_area` — Polygon/MultiPolygon, subtypes country / dependency /
  macroregion / region / macrocounty / county / macrocity(?) / locality.
- Carries ISO 3166-1 alpha-2 and ISO 3166-2. Licence **ODbL** (OSM-derived) — compatible.
- GeoParquet on S3/Azure, e.g.
  `s3://overturemaps-us-west-2/release/2026-07-22.0/theme=divisions/type=division_area/*`
  (~monthly releases; pin one).

Build: one `ogr2ogr` (or DuckDB) pass GeoParquet → a single global `admin.fgb`, columns
renamed to what `worldAdminAreas` already reads (`admin_level`, `name`, `ISO3166-1`,
`ISO3166-2`). Client unchanged if the mapping is faithful. Rebuild rarely — boundaries
move on a timescale of years — on its own cadence, outside the shard pipeline.

**Spike S2 (before committing):** Overture's schema requires `admin_level` only for
country→county; whether `locality` carries it is undetermined. The app consumes levels
2–10 and hard-codes level 9 for fr/de/it and 10 for gb (`ADMIN_ORDINAL_OVERRIDES`,
`osm/geodata.js:447-454`). If deep levels lack `admin_level`, build a
subtype→ordinal mapping per country. Also unknown: `division_area` total size.
Validation: the Grand Rapids probe must return a US country polygon; a Basel bbox must
return CH/DE/FR; an enclave case (Vatican/Italy or Baarle) must resolve correctly —
holes are load-bearing (`worldfile.js:720-727`).

### S2 result — resolved, and Overture is adopted

Release **2026-07-22.0**, `theme=divisions/type=division_area`: **1,073,093 rows /
4.47 GB** of source parquet. After `class='land'` and the microhood drop it is
**984,219 features**:

| variant | bytes | DuckDB peak RSS | wall (16 cores) |
| --- | ---: | ---: | ---: |
| full precision | 6,038,396,104 | 13.1 GB | 9.6 s + 21.8 s ogr2ogr |
| **`SIMPLIFY=0.0001` (SHIPPED)** | **2,292,533,384** | 6.3 GB | 56 s + 11 s ogr2ogr |

`MEMORY_LIMIT=8GB` completes by spilling to `$OUT/duckdb-tmp`; budget ~10 GB of scratch
on a runner. Tooling: **`tools/osm-world/build-admin.sh`** (env `OUT` required, `REL`
default `2026-07-22.0`, `SIMPLIFY` default `0.0001`, `BBOX`, `MEMORY_LIMIT`, `THREADS`,
`SRC`, `KEEP_PARQUET`) and **`tools/osm-world/probe-admin.mjs`** as the validation
harness. The build writes a `sha256sum -c`-format sidecar and fails loudly with the live
S3 release listing if the pinned `REL` has been pruned — as of this run only
`2026-06-17.0` and `2026-07-22.0` still exist, so **pin the release and record its
sha256**; a release aging out is a scheduled event, not a surprise.

**Every validation passed**, run through the *real* client reader against the shipped
2.29 GB file — 39/39 assertions, 184 range requests, 19.01 MB, 0.43 s:

- Grand Rapids → `US | Michigan US-MI | Kent County | Grand Rapids`, and the Canada trap
  (a bbox that must *not* pull CA) holds.
- Basel → CH+DE+FR, each of Altstadt/Weil am Rhein/Saint-Louis rejecting the other two.
- **Vatican is the enclave case and it works**: St Peter's returns `VA` **only** — IT is
  excluded by the interior ring, which is exactly the hole subtraction the client already
  implements. Rome centre returns IT and never VA.
- Baarle resolves both ways across the enclave boundary (BE / Baarle-Hertog at one point,
  NL / Baarle-Nassau 100 m away).
- Negative control: the same harness against a Michigan-only admin file exits 1 with 20
  failures, so the failure path is real.

**Overture's own `admin_level` is unusable** — it is a per-country *depth* (country = 0)
and is NULL below county. `subtype` is the rank and is always populated, so the build
maps it: country 2, dependency 3, region 4, county 6, localadmin 7, locality 8,
macrohood 9, neighborhood 10; **microhood dropped**. `class='land'` is load-bearing —
`class='maritime'` rows are EEZ polygons. ISO3166-1 is emitted only on country/dependency
and ISO3166-2 only on region: Overture fills `country` on every descendant row, and
copying it down would make `worldAdminAreas` read a county as a country.

Because the ladder is synthetic, per-country ordinals change under Overture. The client
carries a second table, `OVERTURE_ADMIN_ORDINAL_OVERRIDES` (`osm/geodata.js:513`),
selected **only** when the manifest says `admin_source: "overture"`; the OSM path is
byte-identical to before. fr/it/gb `[4,6,8,10]`, de `[4,6,8,9]`, jp `[4,6,8,null]`,
cn `[4,6,7,8]`; generic countries anchor at `iso2Level = 4`.

**Known risks, in order of how much they can hurt:**

1. **Bytes per map.** A single city bbox costs **32 requests / 7.49 MB** against the
   simplified file — the largest single consumer in the client by a wide margin. One
   double-fetch was already found and fixed (`flatgeobuf.js` tail overflow, below).
   If it still hurts: split admin by level so a map fetches only the levels its ladder
   reads.
2. The **4th ordinal is best-effort** — macrohood/neighborhood coverage is thin outside
   dense cities, and `jp`'s is `null` on purpose.
3. **GB coverage holes** in the deep levels.
4. **Release pruning** — mitigated by the pin + sha256 + fail-loud listing above.

**Licensing is not optional here**: ODbL 1.0, share-alike. Anything served from this file
must display *"© OpenStreetMap contributors, ODbL 1.0 — via Overture Maps Foundation"*.
The manifest's `admin_source: "overture"` plus the release id is what lets the page
render that attribution without guessing.

---

## Phase 3 — the sharded build pipeline — **built and exercised** (S1 resolved)

**Source basis: Geofabrik's published extracts.** Not for geometry — because they are
the only way to never download the 94.3 GB planet. Geofabrik does that pass nightly.

**Two partitions over the same source**, because the two stage groups have opposite
constraints (feature stages: flat RAM, want coarse; density: linear RAM, wants fine):

| partition | for | rule | count | worst case |
| --- | --- | --- | ---: | --- |
| coarse | feature layers (stages 1–3, `--skip-density`) | coarsest Geofabrik region ≤ ~8 GB: six continents whole; europe (34.8 GB), asia (16.2), north-america (19.3) split to children | **86** (measured) | disk-bound, see §Phase 4; largest africa 7.90 GB |
| fine | density only (stage 4 alone) | the finest geometric cover | **500** (measured) | quebec 1.158 GB → ~2.4M cells ≈ 5 GB RSS at the worst measured cells/GB ratio |

**Disjoint partition, derived once offline**: Geofabrik's polygons overlap by design
(buffers). Density's exactness rule — each way attributed to exactly one cell via its
first node — survives sharding only if each shard counts ways whose first node falls in
its *assigned disjoint* region (`shapely.difference` in a fixed order over the cover).
A boundary cell then receives partial tallies from each side that sum to the true total.
Feature stages don't need disjointness; the merge dedups. **Enforced at build time**:
`cover.py` writes each fine shard's assigned polygon to
`tools/osm-world/cover-geometries/<id with '/'→'__'>.geojson` (committed next to
`shards.json`, same run), `ci/build-shard.sh` passes it to **`build.py
--clip-region`**, and stage 4 then bins a way only when its first node — and a tree
node only when its own location — tests inside that polygon (prepared shapely
geometry, one `contains_xy` per candidate). `contains_xy` excludes the polygon
boundary on BOTH sides, so a first node lying exactly on a shared border counts on
zero sides — the composition is at-most-once rather than exactly-once, accepted
because it errs toward undercount (the safe direction) and an exact float hit on a
full-precision boundary is measure-zero in practice. Without the clip every way in the overlap
buffers is tallied by both neighbouring shards and the merge double-counts; merge-time
correction is impossible (the summed cells no longer say which side a way came from).

**Clip overhead, measured.** On michigan (kadro, unclipped baseline reproduces the
644,967-cell result exactly): the density pass goes 77 s → 87 s (+13%, ~2.5 µs/candidate
over 4.16M tests), the whole density-only run +11.7%, peak RSS unchanged; 7,720 of
4.16M candidates (0.19%) are dropped as buffer overlap. On German sub-tiles the
overhead is proportionally larger — a state-level Geofabrik extract's buffer is a much
bigger share of a smaller polygon than Michigan's: saarland's density stage goes 23 s →
31 s (+8 s), dropping 934 of 769,482 candidates (0.121%); rheinland-pfalz goes 94 s →
110 s (+17%), dropping 41,444 of 3,348,289 (1.238%) — an order of magnitude above
michigan's drop rate. Peak RSS is unchanged in both cases (±0.2%).

**The mechanism has since been verified end-to-end against ground truth**, not just
argued from first principles — see the retest result at the end of this phase.

**Merge** (the Option B novelty):

- Feature layers: per layer, concat shard outputs → dedup on `(osm_type, osm_id)` →
  one `ogr2ogr` into a single global `.fgb` with one Hilbert R-tree. The 2.24% buffer
  duplication disappears here instead of shipping.
- Density: sum cells by `(row, col)`; write one global grid.
- Manifest: one global `manifest.json`. Changes while in here:
  - explicit `features: 0` for legitimately-empty FEATURE layers instead of
    omission — michigan omitted `high_speed_rail` and `coastline` (correctly: OSM
    reserves `natural=coastline` for ocean) and a failed job must not look like
    that. **Density is the one exception**: the client trusts a present-but-empty
    density grid as a real zero (which auto-lifts the density-based curses —
    Bridge Troll, Luxury Car, Right Turn), and zero density cells is never true
    for a real region — so a merge with zero density contributions is a **hard
    error**, and `--allow-missing-density` publishes with density **omitted
    entirely** (absent ⇒ the client degrades and curses warn, the safe
    direction). `density: {"features": 0}` is never written;
  - `planet_timestamp` becomes the oldest contributing shard's timestamp; an
    `--only` merge-into keeps the oldest of the existing manifest's value and this
    run's (the untouched layers still date from the old run), and hard-errors if
    this run's `cell_deg` differs from the existing manifest's;
  - optional per-layer bbox, so the client can skip layers that cannot intersect its
    map (addresses the request-count watch item);
  - `admin_source: "overture"`, which is both the ordinal-table switch and the
    attribution the page must render (§Phase 2).
- **Content-addressed filenames** (`park.<sha256-prefix>.fgb`), enabled by the verified
  byte-reproducibility: unchanged layers keep their URL across rebuilds, so browser and
  CDN caches stay warm; `manifest.json` (max-age 300) is the only mutable object.

**Spike S1 — decides Option B vs fallback to Option A:** can GDAL's FlatGeobuf writer
build the R-tree for a merged multi-GB layer within sane memory? (Prognosis is good —
the Hilbert sort needs feature *bounds*, not geometries — but it is unverified.) Test:
merge germany+france `green` (the largest layer class) on kadro and record peak RSS,
then extrapolate to the post-Phase-1 global layer sizes. If it fails even after
Phase 1's reductions, fall back to Option A: 499-tile delivery, client-side fan-out with
`(osm_type, osm_id)` dedup (`cmpTypeId` exists), per-tile manifests, and Overture admin
regardless. All Phase 0–2 work is identical under both options.

### S1 result — resolved. **Option B is confirmed; Option A stays rejected.**

The prognosis was right and the law is per-*feature*, not per-*byte*:

    FGB writer peak RSS ≈ 166 MB + 100 B/feature

measured out to **87M features / 46 GB, peak 8.6 GB**. Nothing the merge will ever be
asked to write comes close to kadro's 31 GB, and the ratio does not depend on geometry
size. Option A is not needed.

**New constraint S1 turned up:** the writer keeps a *hidden unlinked* temp file, and it
lands **in the output directory** — `CPL_TMPDIR` is ignored. Transient disk in `$OUT` is
therefore double the final layer size. That is what keeps the merge on kadro rather than
a runner, independently of RAM.

Three further S1 findings, the first two about failures that would otherwise be
invisible — both are now designed against in `merge.py`:

1. **Sparse per-shard schemas make a naive `-append` silently drop columns.** A shard
   whose extract happens to contain no feature carrying `cuisine` writes no such column,
   and appending it into a layer that has one drops the column for those rows without a
   word. **Schema union is mandatory**, and `merge.py` implements it (VRT
   `FieldStrategy=Union`); the merge test asserts single-shard column witnesses in 23
   layers.
2. **Merge dedup would have MASKED the Phase 0 double-emit bug**, non-deterministically —
   dedup on `(osm_type, osm_id)` collapses the duplicate ring silently, so the bug would
   have shown up as "some builds are 2× larger than others". Hence `merge.py`'s **loud
   per-shard `rows == distinct` assert before merging anything** (`--no-assert` to
   override). A bug that a later stage cleans up is a bug you never find.
3. **H2b is still open**: cross-tile duplication rate per layer, which sizes the merge.
   The earlier measurement was polluted by the double-emit bug and must be re-taken
   tiles-only with post-Phase-0 code.

### Result — `merge.py`, `cover.py`, `shards.json`

`uv run tools/osm-world/merge.py --shards <dir of per-shard build dirs> --admin
<admin.fgb> --out <dir> [--no-assert] [--work] [--only] [--strategy]
[--allow-incomplete] [--allow-missing-density]`. Shard discovery is **recursive** (an
R2 sync of
`shards/feature/` nests `us/michigan/` a level deeper than a flat scan looks) and
treats `--shards` itself as a candidate first (a `manifest.json` at the root is a
single-shard merge). Symlinked directories are **followed** (out-of-tree shard links
are a supported layout) under a visited-realpath guard: cycles and duplicate routes
over non-shard directories are skipped with a log, and a **shard** reached twice is a
**hard error naming both paths** (duplicated shards double-count density additively;
a symlink loop once yielded 41 discoveries of one shard before the guard). The guard
resolves symlinks only — bind-mount duplicates are not detected. A
directory holding `.fgb` files without a `manifest.json` — a failed build's leavings —
is a **hard error listing the offenders** unless `--allow-incomplete` (root `.fgb`
strays included), and an `--only`
run merges into an existing `manifest.json` (stamping top-level `"partial": true`
while the layer table is incomplete — the pinned client rule) instead of clobbering
the layers it did not touch, **dropping (loudly) any existing keys the current layer
table no longer contains** so removed layers disappear on the next `--only` run. Per
layer: VRT
union → GPKG → `DELETE` keeping `MIN(fid)` over shard dirs in **sorted relative-path
order** (determinism) → FGB with a spatial index. `count_only` layers carry zero property
columns, so they dedup on exact geometry bytes instead. Density is summed by
`(row, col)` through an external sort that reproduces `stage_density`'s exact output
shape. Admin is hardlinked in from `--admin` and stamps `admin_source: "overture"`.

**Merge test on kadro** (`~/osm-builds/merge-test/`), bremen + hamburg + berlin shards
built from the current tools, merged with the global Overture admin:

- shard builds: bremen 0.5 min / 8.9 M, hamburg 0.7 min / 20 M, berlin 0.9 min / 37 M.
- merged world: **37 layers, 2.36 GB** (admin 2.29 GB / 984,219 features; 243,474
  feature-layer features; 58,996 density cells), **0.5 min wall**.
- **304/304 verification checks pass**: schema union, `rows == distinct`, count bounds,
  exact density sums per key (building 1,086,946 / street 751,018 / car_street 344,590 /
  footpath 399,595 / bridge 12,370 / tree 584,223), manifest coherence, sha/bytes/bbox.
- **Re-running the merge is byte-identical** — every layer sha256 and the manifest match,
  so content-addressed names are stable in practice and not just in principle.
- Merging bremen with itself collapses identity layers to exactly single-shard counts and
  doubles density sums on identical cells — the two behaviours the merge must have.
- The assert fires: a doctored duplicate shard exits 1; `--no-assert` dedups it.
- A single-shard berlin merge produces the `features: 0` entries for `coastline` and
  `commercial_airport`, which is the manifest change this phase called for.
- The real client reader opens the merged world 9/9, including Overture admin at levels
  2/4/8 (`2:Deutschland | 4:Berlin | 8:Mitte`), in 306 range requests / 5.8 MB.
- `count_only` residual duplication: **0 cross-shard exact duplicates, 0 near-duplicates
  at 1e-4°**. The 8 dropped duplicates were all *within*-shard byte-identical diagonals
  (distinct entities that share an envelope — a documented hair of under-count). This is
  a lower bound: the three test shards are not adjacent, which is why full-overlap dedup
  was exercised by the self-merge instead. Still H2b.

`uv run tools/osm-world/cover.py [--cap-gb 8] [--no-sizes]` writes
**`tools/osm-world/shards.json`** — the pinned interface CI consumes:
`{generated_from, coarse[], fine[]}`, each entry `{id, pbf_url, md5_url, est_bytes}` and
each fine entry additionally `disjoint_neighbors` (which shards can share a boundary
density cell — diagnostic, consumed by nothing in CI or the merge). It also writes
**`tools/osm-world/cover-geometries/`** — one GeoJSON per fine shard with its assigned
disjoint polygon at full precision (rounding could open slivers along shared
boundaries), the `build.py --clip-region` input. Both are checked in, from the same
run. The `fine` array is **in the
difference order** (ascending polygon area, ties by id) so a consumer can rebuild the
assigned disjoint geometries. Real run against `index-v1.json` 2026-08-15 (555 regions):

- **fine: 514 members, 114.2 GB**, largest africa 7.90 GB, no null sizes. One piece of
  land is uncovered by design: Diego Garcia, whose only source is `asia` at 16.18 GB.
- **coarse: 87 regions, each ≤ 8 GB, 82.2 GB**, largest africa 7.90 GB. `dach` (6.2 GB)
  is chosen over `germany`; canada 6.41 GB; france 5.06 GB; the US splits into
  midwest/northeast/pacific/south/west; africa, south-america, australia-oceania and
  antarctica stay whole.
- Uncovered area is **measured, not assumed** — `cover.py` logs `uncovered_deg2`. The
  coarse cover misses 4,175 deg², located chunk by chunk and **entirely open ocean**
  (Indian Ocean, N Atlantic, Pacific off Mexico, Arctic, Philippine Sea); every sampled
  piece of extract-less land is covered by a parent region (e.g. Saudi Arabia via
  `gcc-states`), and no populated place falls in the gap — a claim that was FALSE at
  4,251 deg² under the leaf rule, when Ukraine was sitting in it and the "Black Sea"
  piece was partly Ukrainian land. The fine cover misses 18,574 deg² of the 58,770 deg²
  region union (19,726 under the leaf rule), so
  **density under-counts there and only there** — ocean.

### Retest — recursive discovery, `--unlink-source`, `--only` merge-into, and the clip-region fix verified end-to-end

A later wave re-verified the just-fixed `merge.py`/`build.py` on kadro (sha256-matched
against the synced code) with real, larger inputs rather than the small merge-test shards
above.

**Nested discovery + loud failure.** Wave-2 shards hardlinked three levels deep into an
R2-sync-shaped tree (`shards-nested/feature/eu/de-north/{bremen,hamburg}`,
`.../de-east/berlin`) were all found (`merging 3 shard(s): feature/eu/de-east/berlin,
feature/eu/de-north/bremen, feature/eu/de-north/hamburg`, `--only park,museum`, 1.7 s).
A doctored directory holding `.fgb` files and no `manifest.json` produced exit 1 naming
the offender and the `--allow-incomplete` escape, with **nothing written to `--out`**
(the failure is pre-write); the same run with `--allow-incomplete` exits 0 with a
WARNING listing the ignored directory and merges the 3 good shards. Both `--only`
manifests correctly carried `"partial": true`.

**`--only` merges into the existing manifest**, confirmed on a real 37-layer world: a
`--only park` re-run logged `--only: merged 1 layer entr(y|ies) into the existing
manifest's 37` and produced a byte-identical manifest with no spurious `partial` —
exactly the behaviour Phase 3 specified above, now exercised rather than only argued.

**`--unlink-source` refuses instantly and correctly** for both density-reaching
invocations (`--only density --unlink-source`, and `--unlink-source` with the default
full layer set): exit 1 before any I/O, naming stage 4 as the reason and pointing at
`--skip-density` or `--only` without density; the source pbf survives untouched. A real
`--skip-density --unlink-source` run on a 21,132,558-byte extract deleted the pbf one
second after stage 1 started, once `interesting.osm.pbf` existed and no remaining stage
read the raw extract; outputs (34 `.fgb` files, manifest) were byte-identical to a
control run that kept the source.

**The density double-count fix is verified against ground truth, not just argued.**
Adjacent pair from `de-src`: saarland (843,022 ways) and rheinland-pfalz (3,932,973
ways), extents overlapping heavily by design. Clip polygons = `cover.py`'s real
`cover-geometries/{saarland,rheinland-pfalz}.geojson`, confirmed disjoint (intersection
area 1.4e-18, touching along the shared border). Ground truth = `germany-v2/density.fgb`
(4,612,683 cells, single whole-Germany count), compared over an interior zone (328,924
truth cells) and a boundary band straddling both polygons (6,592 truth cells).

- **Clipped merge vs. truth: exact.** Interior: 328,924 cells equal, 0 differing, 0
  truth-only, 0 merged-only. Boundary band: 6,592 cells equal, 0 differing. Per-key sums
  identical in both zones (interior building 2,720,451 / street 1,033,980 / car_street
  469,503 / footpath 571,735 / bridge 23,985 / tree 247,599; band building 43,903 /
  street 14,808 / car_street 6,274 / footpath 8,679 / bridge 411 / tree 1,386).
- **Unclipped merge (the pre-fix behaviour) is detectably wrong.** 1,776 interior cells
  differ, 98.2% of them (1,744) inside the boundary band — 26.5% of all band cells.
  Band-level inflation: footpath +27.7% (11,081 vs 8,679), bridge +24.3%, street +21.4%,
  car_street +13.3%, building +3.8%, tree +6.9%. Diluted over the whole interior the
  error is smaller but nonzero: street +0.310%, footpath +0.427%, bridge +0.417%,
  car_street +0.179%, building +0.061%, tree +0.039%.
- **Clip cost on this pair**: saarland dropped 934 of 769,482 candidates (0.121%),
  density stage 23 s → 31 s; rheinland-pfalz dropped 41,444 of 3,348,289 (1.238%),
  94 s → 110 s (+17%). Peak RSS unchanged in both (saarland 2,229,716 vs 2,228,832 KB;
  RLP 2,296,424 vs 2,300,936 KB).
- **The mechanism is confirmed independently**: merging one shard with itself yields
  identical density *cell count* (10,057) but exactly 2× the per-key totals (building
  197,166→394,332, street 71,704→143,408, tree 26,540→53,080) — density merging is
  purely additive with no identity to dedup on, which is exactly why the disjoint clip,
  not a merge-time correction, is the only defence.

This closes the gap between Phase 3's mechanistic argument for `--clip-region`
("without the clip … the merge double-counts") and an actual measurement of what the
bug looks like and how completely the fix removes it.

**H2b (cross-tile feature-layer duplication rate) is still open.** The retest's shard
pairs (nested bremen/hamburg/berlin, and the self-merge used to confirm mechanism) are
either non-adjacent Geofabrik extracts or a deliberate exact self-merge, so cross-shard
identity dedup on real adjacent boundaries is still not measured — the merge-test's
0%-duplicates result above remains a lower bound, not a resolution.

---

## Phase 4 — orchestration — **workflows authored, S3 not yet run**

**CI fit (GitHub Actions, standard runners: 4 vCPU / 16 GB / 6 h; disk free ≈ 22 GB
x64, ≈ 45 GB arm64):**

- Density shards: all 500 fit easily (≤ ~5 GB RSS, ~1.2 GB disk, minutes each).
- Feature shards: RAM flat ~2.4 GB; **disk is the constraint**. Peak ≈ 2.6× source when
  the source is deleted after stage 1 (safe: feature shards never run stage 4, which is
  the only later reader of the raw extract). The deletion is **`build.py
  --unlink-source`** — `build-shard.sh` passes it for feature-kind builds, and build.py
  refuses the flag whenever the density stage would run. Without it the peak is
  source + intermediate + outputs (~3.5×; africa's 7.90 GB would peak ~28 GB against
  ~22 GB of runner disk). That bounds shards at ~8.6 GB on x64,
  ~17 GB on arm64 — hence the ≤ ~8 GB coarse rule.
- **The merge does not fit a runner today** (germany `green` alone is 2.7 GB; global
  pre-reduction ~43 GB for that one layer). Run merges on kadro (219 GB free, 31 GB RAM)
  until Phase 0+1 shrink layers enough to revisit — post-reduction the largest global
  layer is plausibly runner-sized, at which point the whole pipeline is CI-native.
- Matrix cap 256 jobs/workflow → batch the 500 density shards. Concurrency: 20 (Free) /
  40 (Pro). Public repos: unlimited free minutes; private on Pro: 3,000 min/mo then
  $0.005/min (arm64 2-core). A monthly rebuild ≈ 12.5 job-hours on kadro-class
  hardware — CI-class unknown until **S3: run one ~1 GB shard as a canary workflow and
  measure**. If private overage matters, split `tools/osm-world/` + workflow into a
  public build repo (nothing in it is sensitive; R2 credentials are env/secrets).
- R2: bucket CORS must expose `content-range` (`build.py` writes `r2-cors.json`;
  apply with `wrangler r2 bucket cors put`). The account token in `.dev.vars` currently
  lacks R2 permissions — mint one with R2 write for CI.
- Cadence: monthly. Parks and libraries do not move weekly; `planet_timestamp` reaches
  every provenance row, and staleness is disclosed, not hidden.

### Result — three workflows, and one of them must be run by hand first

| file | trigger | matrix | per-job timeout | R2 prefix |
| --- | --- | --- | ---: | --- |
| `.github/workflows/world-canary.yml` | `workflow_dispatch` only | one ~1 GB coarse shard | — | none — **needs no secrets** |
| `.github/workflows/world-density-shards.yml` | dispatch only (schedule disabled until the R2 secrets exist) | 514 fine shards, batch 5 → 103 jobs | 90 min | `shards/density/<id>/` |
| `.github/workflows/world-feature-shards.yml` | dispatch only (schedule disabled until the R2 secrets exist) | 87 coarse shards, batch 1 → 87 jobs | 240 min | `shards/feature/<id>/` |

Helpers: `tools/osm-world/ci/chunk-shards.py` (stdlib only; batches `shards.json[kind]`
into the `strategy.matrix.include` list and **fails cleanly** if a future `cover.py` run
would exceed `--max-jobs`, default 256 — the fix is raising the batch size, not a code
change) and `tools/osm-world/ci/build-shard.sh` (downloads pbf + `.md5` with `curl -L`
and **compares hashes by hand** — never `md5sum -c`, whose name field rejects the dated
filename Geofabrik's sidecar redirects to — then runs `build.py … --upload --prefix
shards/<kind>/<id>`, reusing `build.py`'s own boto3 uploader rather than a second
aws-cli path, and cleans its scratch dir between shards. Density builds get
`--clip-region cover-geometries/<id>.geojson` — a missing geometry file is a hard
error, since an unclipped density shard would silently poison the merge — and feature
builds get `--unlink-source` for the runner-disk math above).

Both scheduled workflows **fail loudly** on a missing `shards.json` (it and
`cover-geometries/` are `cover.py`'s outputs and are **committed to the repo** — the
workflows read them from the checkout, so absence is an error, not a reason to skip)
and on missing `R2_ACCOUNT_ID` /
`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET`. **Those secrets do not exist
yet** — the `.dev.vars` token lacks R2 write — so the `schedule:` trigger will fail every
month until one is minted; disable `schedule:` and keep `workflow_dispatch` until then.
Retries wrap the *whole* per-shard call, and a retry is a **full re-download + rebuild**,
not a resume — `build-shard.sh` clears its work dir on entry and passes `--force`
(and `--unlink-source` deletes the extract mid-build) — which is acceptable because
the retry exists for transient network/runner failures and costs one extra shard build.

**The merge is deliberately not in CI** — see S1's hidden-temp finding — and each
workflow header documents the manual kadro-side step, including the
`aws s3 sync s3://$R2_BUCKET/shards/<kind>/` handoff.

Validation done: PyYAML parse, `bash -n` over all 17 embedded `run:` scripts,
`chunk-shards.py` verified against a synthetic 499-fine/7-coarse index (batch 5 → 100
batches with 4 in the last, total preserved; over-cap fails cleanly). **No `actionlint`
was available and none was run, and no runtime behaviour is verified** — matrix
expansion, secret propagation, and whether `ubuntu-latest`'s apt GDAL clears
`preflight`'s version floor are all unknown. That is precisely what `world-canary.yml`
is for, and it should be dispatched before anyone trusts the other two files' timeouts.

---

## Phase 5 — client wiring and test closure — **mostly done**

- ~~Thread `worldBaseUrl` from UI → `app.js` → worker~~ **done**; `DEFAULT_WORLD_BASE_URL`
  still needs the real bucket domain.
- ~~Extend `make-test-world.py`/`test-pipeline.mjs`: closed-way dedup case (Phase 0),
  `features: 0` manifest entries, bbox-diagonal curse layers (R1)~~ **done** — the suite
  grew from 68 to **83 assertions** (path-less manifest entries and the `partial: true`
  refusal rule, below) and the test world builds four layers through `build.py`'s
  real pipeline. Still open: a golden-number run with `useOsm: true`, so the OSM path
  remains invisible to `tools/smoke.mjs`'s 19 numbers.
- Browser end-to-end against the real bucket (Range + CORS differ between Node fetch
  and browsers; this is the step that catches a bucket that doesn't expose
  `Content-Range`, which presents as a corrupt file, not a CORS error). **Still open.**

Wired this wave, all in `osm/`:

- **`admin_source` switch**: absent or `"osm"` keeps the existing OSM admin-level
  behaviour byte-identically; `"overture"` selects the ordinal table above. Read off the
  manifest inside `adminInfo`, which already receives the `World` handle. Documented in
  `CONTRACT.md`.
- **`name:en`** now genuinely reaches the ladder (R5's rationale is no longer aspirational).
- **`curseLayerCount`**: an absent *non-base* term of a fallback expression now counts 0
  with an info log, because the build legitimately omits a layer whose selector matched
  nothing. An absent *base* term (`green`) still refuses, and a negative total still
  refuses.
- **Path-less `{"features": 0}` manifest entries are now real, empty layers, not
  crashes.** `merge.py`'s empty-layer shape (a manifest entry with `features: 0` and no
  `path`) previously fell through to `<base>/undefined` and aborted whatever predicate
  touched it. `osm/worldfile.js` now distinguishes three manifest states: **absent** (no
  entry — `null`, category degrades, unchanged), **empty-with-file** (entry has a path,
  `features: 0` — reader constructed, file read, genuinely empty), and **empty-path-less**
  (entry has `features` and no path, merge.py's shape — `worldCount` returns a real `0`,
  `worldPois` returns `[]`, no reader is ever constructed, and no HTTP request is ever
  issued). The pinned partial-manifest rule now has a consumer, too: when a fallback term
  is absent *and* the manifest's top-level `"partial"` is `true` (a `--only` build),
  `curseLayerCount` refuses with a warn log instead of silently counting it as 0, because
  on a partial manifest absence means "not built," not "empty" — a full manifest's
  absence still zeroes with an info line, as above. Verified against the real reader
  through 36 checks in the retest wave (§Phase 3 retest), including a doctored
  `partial: true` manifest that correctly leaves the affected curse predicates
  unanswered while the rest of the loop keeps working, and a run confirming zero
  requests to `<base>/undefined` across every scenario.
- **`flatgeobuf.js` tail overflow**: when the last feature of a run exceeds the 8 kB
  coalesce tail the reader fetched only the missing bytes instead of re-reading the whole
  run — 91,056 vs 109,808 bytes on a 60-small-plus-one-64 kB-polygon probe, same 3
  requests, identical features. This is the double-fetch that Phase 2's admin bytes made
  worth finding.
- **Country identity by zone-centre census** over ISO3166-1 polygons rather than
  alphabetical order — a Basel-like map answers `ch`, not `de`. The old
  `(level, name)`-order rule survives as the tie-break and the no-zones fallback.

---

## Rejected alternatives (and why, so they stay rejected)

- **Planet monolith build**: 139–301 GB RAM in stage 4. Not a disk problem — rewriting
  `stage_density` to spill would fix RAM but not the ~112 h single-machine wall clock.
- **Free-tier planet hosting of the build** (GCP/AWS/Azure/Oracle/Actions): all fail on
  disk and/or RAM; Oracle's Always Free was halved June 2026 and is the only near-miss.
- **PMTiles instead of FlatGeobuf**: the doc's stated objections (tags dropped, clipping)
  are defeasible (`-y/--include`; precomputed centroids), but exact counts are
  achievable-not-guaranteed (`-r1 -pf -pk`, no documented zero-drop guarantee), MVT
  simplification breaks point-in-polygon, and `--use-attribute-for-id` is unstable
  across runs. With admin moved to Overture and the payload reduced by a measured 63%,
  the size problem PMTiles would solve no longer exists, and the working 45/45-tested
  reader stays. Revisit only if request-count becomes a real UX problem.
- **Overture for the category layers**: selectors are OSM-tag-specific and `cuisine` is
  read off individual features; not verified safe. Admin only.
- **Regular lat/lon grid as shard basis**: requires the planet locally to cut. The whole
  point of Geofabrik-based sharding is never touching the planet.
- **Coarser-shards-for-cost**: dead since the 6.5 s fixed-cost measurement; shard count
  is a wash. Coarseness only matters for runner disk (upper bound) — admin no longer
  cares, it left the shard pipeline entirely in Phase 2.

## Open questions / spikes

| id | question | decides | status |
| --- | --- | --- | --- |
| S1 | peak RSS of GDAL FlatGeobuf write on a merged multi-GB layer | Option B vs fallback A | **RESOLVED** — 166 MB + 100 B/feature; Option B confirmed |
| S2 | Overture `locality` admin_level coverage + `division_area` size; fr/de/it/gb deep-level mapping | Phase 2 shape | **RESOLVED** — Overture adopted; synthetic subtype→level map |
| S3 | one ~1 GB shard on an actual Actions runner (time, disk headroom) | CI cost model | **OPEN** — `world-canary.yml` is written; needs a manual dispatch |
| H2b | cross-tile duplication rate per layer — prior measurement was polluted by the double-emit bug | merge dedup sizing | **OPEN** — merge-test's 0% and the retest's nested-shard 0% are both lower bounds (non-adjacent Geofabrik extracts); still needs a real adjacent-boundary measurement, tiles-only with post-Phase-0 code |
| — | rebuild michigan/germany with the `advertising` fix before any count is published | published numbers | **CLOSED** — michigan-v3 (232,847,376 B, advertising 772) and germany-v3 (3,343,969,105 B, advertising 35,816) built and fully verified; see §Phase 0 Result |
| — | `green` at ~27 GB global pre-reduction serves a weight-0.5 legal-spot category (`osm/geodata.js:301`) | product call on R6 | open — now 1.57 GB for germany post-Phase-1, so less pressing |

## Baselines (kadro, `~/osm-builds/` — outside the Syncthing-synced tree; keep)

- `michigan-mono/` — byte-identical to the VM build; the reproducibility reference.
- `germany-mono/` + `rss-germany.log`, `time-germany.log` — monolith reference for the
  double-emit fix and Phase 1.
- `de-tiles/` (16 sub-tile builds + `RESULTS.txt` per-tile timings) + `de-src/` sources —
  H2/H3 evidence and re-measurement inputs without re-downloading.
- `germany-latest.osm.pbf`, `michigan-latest.osm.pbf` — pinned sources
  (planet snapshot 2026-08-15T20:21:20Z).
- **`michigan-v2/`, `germany-v2/`** + `build-germany-v2.log` — the Phase 0+1 outputs.
  **Both predate the `advertising` reclassification** — kept only as a diff reference
  against v3, below.
- **`michigan-v3/`, `germany-v3/`** + `build-germany-v3.log` — the current, published
  baselines: advertising-fix rebuilds, fully verified (§Phase 0 Result). These are the
  numbers in the top-of-file summary table.
- **`spike-s1/`** — the FGB-writer RSS series (to 87M features / 46 GB).
- **`spike-s2/`** — `admin-global-s.fgb` (2.29 GB, 984,219 features, the shipped
  simplified variant), the full-precision variant, and the Michigan-only negative control.
- **`merge-test/`** — the bremen/hamburg/berlin shards, the merged world, and
  `verify-merge.py`'s 304 checks.
- **`merge-test3/`** — the retest wave's artifacts: nested-shard discovery + loud-failure
  fixtures, the saarland/rheinland-pfalz clip-region ground-truth comparison
  (`dens.sql`, re-runnable), the client features:0 fixtures and `client-test.mjs`, the
  `--unlink-source` fixtures, and a repeat of `verify-merge.py` (as `verify-merge3.py`,
  304/304) confirming no regressions.
- **`audit-w2/{mi.tsv,de.tsv}`** — the raw `point,polygon` audit output.

Reminder: `~/Projects` is one Syncthing folder (vibe ↔ kadro, no `.stignore`). Build
outputs go to `~/osm-builds/` on kadro, never inside the repo; deletes inside the repo
propagate to both machines.
