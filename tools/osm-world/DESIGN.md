# DESIGN — the sharded build and global delivery of the OSM layer

> Design record for shipped work: the reasoning, measurements and failure modes behind
> the sharded OSM build. Seventeen files across `tools/osm-world/`, `.github/workflows/`
> and `osm/geodata.js` cite it for *why*; the rationale lives nowhere else.

Goal: serve the OSM layer entirely from static files, globally, with the browser client
**unchanged** from what `osm/worldfile.js` + `osm/flatgeobuf.js` implement and test.
Shards exist only inside the build; the client sees one world at one base URL via
`openWorld(baseUrl)`.

Every number here is measured unless marked as an estimate (research session 2026-08-16,
four real builds, plus the later waves recorded per phase). Baselines live on kadro at
`~/osm-builds/` — see §Baselines.

| | before | after | |
| --- | ---: | ---: | ---: |
| michigan | 643,681,472 B | 232,847,376 B | **−63.8%** |
| germany | 9,004,762,856 B | 3,343,969,105 B | **−62.9%** |

Phase 0 + Phase 1 compound, same source PBFs, all correctness checks green. These are the
**michigan-v3** / **germany-v3** totals — the `advertising`-fix rebuilds, 9,288 B and
135,248 B larger than v2, exactly the 56 and 816 recovered `advertising` features.

---

## Why Option B

A planet-monolith build is impossible: `stage_density` holds every populated cell in a
Python dict, and the measured law is

    peak RSS ≈ 1.29 GB + 1.53 kB × cells

Michigan: 644,967 cells, 2.21 GB true peak (`/usr/bin/time -v`; `ps` sampling
under-measures — it caught 940 MB). Germany: 4,612,683 cells, 7.88 GB. Cell count is
bounded by land area and saturates (Michigan populates 9.4% of its 0.002° cells, Germany
40%), so scaling from both ends brackets the planet at **90–196M cells → 139–301 GB of
RAM**. No machine in play, no free tier, no runner.

Sharding the *build* fixes that: feature stages run flat at 2.18–2.38 GB RSS regardless
of shard size, and density is per-shard-linear. Sharding the *delivery* (Option A) was
measured too, and it breaks something: **an administrative area only assembles into a
polygon when its relation fits entirely inside the extract.** Confirmed on 17 builds:
`us/michigan` has 73 level-2 features, all zero-area LINESTRINGs, no USA polygon; the
germany monolith yields `Deutschland [DE]` as a MULTIPOLYGON while 15 of its 16 state
sub-tiles have no country polygon at all. Option B — shard the build, merge, deliver one
world — sidesteps per-tile admin entirely and keeps all sharding complexity out of the
client.

Option A was the fallback if the merge spike (S1) failed. S1 passed (§Phase 3), so
Option A stays rejected.

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

**Phase 0+1 do not move peak RSS or wall clock.** Peak RSS is `stage_density`'s dict and
the reductions are all in the feature stages: michigan stayed at 2.21 GB, germany went
7.88 → 7.91 GB (8,293,856 kB), and cell count is identical (R4 omits zero *properties*,
not cells). Wall clock: michigan 3:36 → 4:08, germany 32:26 → 34:32 (+6.5%) — the dedup
and diagonalize passes are streaming reads, and R2 splits one curse layer into two. The
RSS law still governs shard sizing.

- **Reproducible**: the two Michigan builds are byte-identical — same 643,681,472-byte
  total, same per-layer sha256 — across different core counts, kernels and filesystems.
  This is what allows content-addressed filenames (§Phase 3).
- **Time** (six content-homogeneous German tiles, R² = 0.9952): `t ≈ 6.5 s + 0.533 s/MB`
  on kadro. Fixed cost is ~7% of a 500-shard rebuild, not worth optimising shard count
  for. (An earlier 97 s fixed-cost figure was an artifact of fitting two regions with
  different layer mixes.) The 4-core VM measured 4.27 s/MB but was RAM-starved.
- **Sharding overhead in bytes**: sources +2.24% (Geofabrik's cutting polygons are
  buffered), outputs +3.5%. Both vanish under the merge.
- **Client cost**: pre-Phase-0, a partial query (6 feature layers + admin + density,
  Grand Rapids bbox) = 1,212 range requests / 7.0 MB; the floor is one manifest + a
  16 kB header probe per layer ≈ 0.6 MB. Overpass moved ~40 MB in ~10 requests. Request
  count, not bytes, is the metric to watch. Post-Phase-1 through the real reader: the
  merged 3-shard world is 306 requests / 5.8 MB, and the Overture admin file alone is
  32 requests / 7.49 MB for a city bbox — admin is the dominant term.
- **Planet PBF** is 94.3 GB (older docs say 87.6 — stale). The finest disjoint cover of
  Geofabrik's 555 regions is **514 members totalling 114.2 GB**, largest africa at
  7.90 GB (`cover.py`, land rule, 2026-08-20; the superseded leaf rule gave 500 / 78.4 GB
  and a 70%-residual rule 512 / 82.4 GB, both with holes over inhabited land).
  `index-v1.json`'s `parent` field is a display hierarchy, not a tree — `us`,
  `us-midwest`, `us/michigan` are siblings — so the cover is computed geometrically.
- **Geofabrik `.md5` sidecars** 302-redirect to mirrors and name the *dated* file
  (`germany-260815.osm.pbf`), not `-latest`. `build.py`'s `expected_md5` handles both
  (urllib follows redirects; hash-only comparison). Shell scripts must use `curl -L` and
  compare hashes, never `md5sum -c`.

---

## Phase 0 — the double-emit bug (correctness; blocked all measurement)

`export_layer` passed `--geometry-types=point,linestring,polygon` to every
`osmium export`, so **every closed way was emitted twice**: once as its polygon, once as
the same ring re-read as a zero-area linestring (`osm_id 30513335` appears as
`MULTIPOLYGON (area 6.4e-05)` and `LINESTRING (area 0)`). Nothing downstream dedups:
`featuresToPois`' only dedup is node-swallowed-by-area, which never touches ways.

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
→ `polylineMidpoint`), feeding the legal-spot shortlist and per-zone distances. The test
suite could not see it: all 19 golden numbers run against an unresolvable world bucket.

**Fix.** Per-layer geometry types alone are not enough — `water` is legitimately mixed
(lake polygons + river linestrings). Two parts, implemented as `geometry` (+ `dedup`)
per entry in `categories.json`, read by `Layer.geometry_types` and
`apply_geometry_dedup` in `build.py`:

1. A per-layer `--geometry-types`: `polygon` for pure-area layers, `point` for pure-node
   layers, mixed only where genuinely mixed (`water`, `coastline`, `high_speed_rail`,
   `platform`, curse layers pre-R1).
2. For the mixed layers, a streaming dedup pass that drops a linestring feature whose
   `(osm_type, osm_id)` was already emitted as a polygon.

Verification: `make-test-world.py` carries a closed way and `test-pipeline.mjs` asserts
exactly one record; both extracts were rebuilt and diffed against the kadro baselines.
This *corrects* published counts, so the report pages' numbers change.

### Result

- **`rows == distinct(osm_type, osm_id)` on all 8 required layers, germany**: green
  2,736,050; pitch 453,437; park 14,194; water 68,100; admin 33,257; restaurant 103,270;
  library 5,764; shop 486,941. Michigan likewise.
- Feature counts fall by the predicted factors: germany green 5,374,835 → 2,736,050
  (1.96×, exactly the bayern prediction), pitch 849,229 → 453,437, park 26,868 → 14,194,
  water 97,669 → 68,100.

**`advertising` was misclassified.** It was `point,polygon`, but `advertising=*`
describes a physical object, `area=*` never applies, and a billboard *face* is
legitimately a short open way. Those ways were never exported: **56 of 772 distinct
entities lost in michigan (7.3%), 816 of 35,816 in germany (2.3%)**, silently. Now
`point,linestring,polygon` + `dedup`.

Every other `point,polygon` layer was then audited **empirically** on both extracts: export
all three geometry types, apply the layer's `where`, count distinct entities appearing as
a linestring and never as a polygon (exactly what the class drops). Michigan / Germany:
shelter 0 / 24 of 99,512; pitch 0 / 61 of 453,498; park 0 / 2 of 14,196; shop 1 of
27,295 / 0; place_of_worship 0 / 1 of 72,054; fast_food 0 / 1 of 44,034; and **exactly
zero on both** for museum, movie_theater, hospital, library, zoo, aquarium,
amusement_park, golf_course, foreign_consulate, commercial_airport, rail_station,
toilets, grocery, newsagent, restaurant, cafe. All kept as area-only:
`amenity`/`tourism`/`shop`/`office`/`leisure`/`landuse`/`aeroway=aerodrome`/
`railway=station` describe a place and OSM documents no linear form, so the residual
handful are mapping errors, and every key that *does* have a documented linear form is
already in the mixed class (`categories.json`'s "THE point,polygon AUDIT" block). `admin`
is the deliberate outlier at 1,308/3,218 (40.7%) MI and 86,039/119,296 (72.1%) DE — all
boundary member ways, which is what R3 is for. Raw audit output:
`kadro:~/osm-builds/audit-w2/{mi.tsv,de.tsv}`.

**The v3 rebuilds** are the publishable baselines; v2 is kept only as a diff reference.

- **michigan-v3**: 35 layers, 4.4 min, manifest sum **232,847,376 B** (222.06 MiB).
  `advertising.fgb` rows == distinct == **772**. `diff-layers.sh` against michigan-v2
  shows **exactly 1 differing layer** — `advertising` (716→772 features,
  107,216→116,504 bytes); the other 34 are sha256-identical, so the `where`-rewriter and
  geometry-class changes touched nothing else. All 35 `.fgb` files match the manifest's
  byte sizes and feature counts.
- **germany-v3**: 37 layers, **3,343,969,105 B**, 34.5 min wall (`/usr/bin/time -v`:
  34:31.51, max RSS 8.3 GB), zero Traceback/Error/Failed/Exception in the log, including
  zero recurrences of the `SetAttributeFilter` bug below. `advertising` 35,816 rows ==
  distinct (the monolith's raw pre-dedup count was 36,161). `rows == distinct`
  reconfirmed on all eight layers above. Curse diagonals: `curse_cairn_terrain` 337,403,
  `curse_travel_agent_stop` 421,694, `curse_water` 522,279 — all 2-point LINESTRINGs,
  0 non-LineString rows. R2 identity: 2,736,050 − 10,308 + 89,197 = 2,814,939. Density
  unchanged at 4,612,683 cells. +135,248 B over germany-v2.

**Second bug, worse:** a `where` clause naming a column absent from the export schema did
**not** abort. `build.py` passes `-skipfailures`, and GDAL 3.12 with it prints
`ERROR 1: SetAttributeFilter(...) failed`, **exits 0, and copies every feature through
unfiltered** — a layer that builds, lands in the manifest, and has silently wrong counts.
Fix: `rewrite_where(where, present, key) -> str | None` in `build.py` constant-folds
every predicate over an absent column (absent ⇒ NULL for every feature, so the predicate
has a known constant value), returning the rewritten SQL, `""` for unconditionally-true,
or `None` for can-never-match (layer omitted from the manifest, the state an empty layer
already produces). A prefix `NOT` over a missing column raises `SystemExit` instead of
folding — the one place SQL's UNKNOWN stops behaving like FALSE. Clauses with nothing to
fold come back byte-identical; `test-update.py` asserts that for all 42 clauses in the
build table.

---

## Phase 1 — zero-risk payload reductions (~45% of output, no published number moves)

From the data-model audit:

- Only `park` and `water` keep geometry on the client (`RING_CATEGORIES`,
  `osm/geodata.js`). `commercial_airport` was dropped from that list: its rings were kept
  but never read (`zonePolygonHits` is only read for `park`). Everything else is
  representative-point+tags.
- The four `curse_*` layers — 3,893 MiB on germany, 45% of the build — are
  **count-only**: the curse loop calls `worldCount`, which walks the R-tree and reads zero
  feature bytes. `worldPois` is never called on them.

| # | change | saving | mechanism / safety argument |
| --- | --- | ---: | --- |
| R1 | curse layers → 2-point bbox-diagonal linestrings, no properties | ~36% | A diagonal `(minX,minY)→(maxX,maxY)` has exactly the original envelope, so every R-tree node bbox and `search` result is bit-identical. No client change. Forecloses ever drawing curse features — acceptable, nothing ever has. |
| R2 | delete `curse_animal_habitat`; compute its count as a partition identity | ~6% | `landuse` is single-valued, so `count = worldCount(green) − worldCount(green_recreation_ground) + worldCount(animal_delta)` is exact over unchanged envelopes. Two small new layers (~240k features); the `CURSE_WORLD_LAYERS` entry in `osm/geodata.js` becomes an expression. |
| R3 | admin: polygons only | ~1.5% | 86,719 of germany's 119,976 admin features (72%) are boundary-way LINESTRINGs discarded by `osm/worldfile.js`. Largely subsumed by Phase 0's per-layer geometry types; `-R` cannot be used (osmium export needs member ways to assemble relations) — filter at export/ogr2ogr instead. |
| R4 | density: omit zero-valued properties per cell | ~1.3% | `worldDensity` already skips zeros on read; absent == 0 by construction. |
| R5 | project away the build-only columns | ~1% | `include_tags` pins the export schema; the client reads 12 columns at runtime (`name`, `name:en`, `natural`, `cuisine`, `access`, `foot`, `entry`, `opening_hours`, `admin_level`, `ISO3166-1`, `ISO3166-1:alpha2`, `ISO3166-2`) plus `osm_type`/`osm_id` — `runtime_columns`. Keep the rest through `where`, then `ogr2ogr -select` them away, intersected with the columns the layer actually carries (`-select` hard-fails on a missing field). |

`name:en` earns its place: the admin ladder prefers it (`AdminArea.nameEn` →
`tags['name:en']` in `adminInfo`), so a Swiss map says "Switzerland" instead of
`Schweiz/Suisse/Svizzera/Svizra`. That matters more under Overture, whose `name` is
local-language for every division.

Noted in passing: `spotOpenAllHours` is dead code (`pathIds = null` unconditionally makes
`verify` always true).

**Deferred, not rejected — R6**: ship `green`/`pitch` as precomputed representative
points (+24%, germany 2,982 → ~890 MiB). It changes count semantics from
geometry-intersects-bbox to point-in-padded-bbox (measured divergence <1% on michigan
probes, but nonzero), and `pitch` is the `tumble_ground` curse predicate, where a count
hitting zero auto-removes a curse. Requires re-wording the §09 provenance promise
("re-run any selector at overpass-turbo.eu") and `partial`-marking.

Estimate before the build: germany ≈ 9.0 → ~3.5–4 GB; global ≈ 60–70 GB (~45 GB if R6
is taken). R2 storage at that size ≈ $1/month.

### Result

Germany came in at **3,343,833,857 B** (v2) — better than the estimate's low end. Per
layer, old → new bytes (features):

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

**R1** is the biggest single lever — the three surviving curse layers drop 86–92% of
their bytes at unchanged envelopes. **R2** removes germany's single largest layer
(2.97 GB) and replaces it with 12.2 MB of derived terms. **R3** takes admin from 119,976
features to 33,257 (72.3% were boundary member ways, the predicted 72%); bytes fall less
than features because what remains is the polygons. **R4** is 12.1% of the density grid
over an identical 4,612,683 cells. **R5** is spread across every feature layer — bench
keeps all 831,532 features and still loses 9.8% of its bytes, pure column projection.

**The R2 identity holds.** Michigan is exact against its own baseline:
61,160 − 790 + 17,426 = **77,796**. Germany is internally consistent
(2,736,050 − 10,308 + 89,197 = 2,814,939, all three layers present, no nulls) but not
comparable to the baseline's retired layer, whose 5,523,884 rows were double-emitted.
**The R1 diagonals are verified as diagonals**: germany's `curse_cairn_terrain` 337,403
rows / 337,403 two-point / 0 non-LineString; `curse_travel_agent_stop` 421,694 /
421,694 / 0; `curse_water` 522,279 / 522,279 / 0.

---

## Phase 2 — admin moves to Overture `division_area`

Per-tile admin is unfixable by construction (§Why Option B), and even the monolith
approach only works per-country. Overture ships **already-assembled polygons**, which
cannot fail the relation-assembly way:

- Type `division_area` — Polygon/MultiPolygon, subtypes country / dependency /
  macroregion / region / macrocounty / county / macrocity / locality.
- Carries ISO 3166-1 alpha-2 and ISO 3166-2. Licence **ODbL** (OSM-derived) — compatible.
- GeoParquet on S3/Azure, e.g.
  `s3://overturemaps-us-west-2/release/2026-07-22.0/theme=divisions/type=division_area/*`
  (~monthly releases; pin one).

Build: one DuckDB pass GeoParquet → a single global `admin.fgb`, columns renamed to what
`worldAdminAreas` already reads (`admin_level`, `name`, `ISO3166-1`, `ISO3166-2`).
Rebuilt rarely — boundaries move on a timescale of years — on its own cadence, outside
the shard pipeline.

**Spike S2** asked whether `locality` carries `admin_level` (the app consumes levels
2–10 and hard-codes level 9 for fr/de/it and 10 for gb in `ADMIN_ORDINAL_OVERRIDES`) and
how big `division_area` is. Validation: the Grand Rapids probe must return a US country
polygon; a Basel bbox must return CH/DE/FR; an enclave case must resolve — holes are
load-bearing in `worldfile.js`.

### S2 result — Overture adopted

Release **2026-07-22.0**, `theme=divisions/type=division_area`: **1,073,093 rows /
4.47 GB** of source parquet. After `class='land'` and the microhood drop: **984,219
features**.

| variant | bytes | DuckDB peak RSS | wall (16 cores) |
| --- | ---: | ---: | ---: |
| full precision | 6,038,396,104 | 13.1 GB | 9.6 s + 21.8 s ogr2ogr |
| **`SIMPLIFY=0.0001` (SHIPPED)** | **2,292,533,384** | 6.3 GB | 56 s + 11 s ogr2ogr |

`MEMORY_LIMIT=8GB` completes by spilling to `$OUT/duckdb-tmp`; budget ~10 GB of scratch
on a runner. Tooling: `tools/osm-world/build-admin.sh` (env `OUT` required; `REL` default
`2026-07-22.0`, `SIMPLIFY` default `0.0001`, `BBOX`, `MEMORY_LIMIT`, `THREADS`, `SRC`,
`KEEP_PARQUET`) and `tools/osm-world/probe-admin.mjs` as the validation harness. The
build writes a `sha256sum -c`-format sidecar and fails loudly with the live S3 listing if
the pinned `REL` has been pruned — only `2026-06-17.0` and `2026-07-22.0` existed at the
time, so **pin the release and record its sha256**; a release aging out is a scheduled
event, not a surprise.

**Every validation passed** through the *real* client reader against the shipped 2.29 GB
file — 39/39 assertions, 184 range requests, 19.01 MB, 0.43 s:

- Grand Rapids → `US | Michigan US-MI | Kent County | Grand Rapids`; the Canada trap (a
  bbox that must *not* pull CA) holds.
- Basel → CH+DE+FR, each of Altstadt/Weil am Rhein/Saint-Louis rejecting the other two.
- **Vatican, the enclave case**: St Peter's returns `VA` **only** — IT is excluded by the
  interior ring, exactly the hole subtraction the client already implements. Rome centre
  returns IT and never VA.
- Baarle resolves both ways across the enclave boundary (BE / Baarle-Hertog at one point,
  NL / Baarle-Nassau 100 m away).
- Negative control: the same harness against a Michigan-only admin file exits 1 with 20
  failures, so the failure path is real.

**Overture's own `admin_level` is unusable** — a per-country *depth* (country = 0), NULL
below county. `subtype` is the rank and is always populated, so the build maps it:
country 2, dependency 3, region 4, county 6, localadmin 7, locality 8, macrohood 9,
neighborhood 10; **microhood dropped**. `class='land'` is load-bearing —
`class='maritime'` rows are EEZ polygons. ISO3166-1 is emitted only on country/dependency
and ISO3166-2 only on region: Overture fills `country` on every descendant row, and
copying it down would make `worldAdminAreas` read a county as a country.

Because the ladder is synthetic, per-country ordinals change. The client carries
`OVERTURE_ADMIN_ORDINAL_OVERRIDES` (`osm/geodata.js`), selected **only** when the
manifest says `admin_source: "overture"`; the OSM path is byte-identical to before.
fr/it/gb `[4,6,8,10]`, de `[4,6,8,9]`, jp `[4,6,8,null]`, cn `[4,6,7,8]`; generic
countries anchor at `iso2Level = 4`.

**Known risks, most painful first:**

1. **Bytes per map.** A single city bbox costs **32 requests / 7.49 MB** against the
   simplified file — the largest single consumer in the client by a wide margin. One
   double-fetch was already found and fixed (`flatgeobuf.js` tail overflow, §Phase 5). If
   it still hurts: split admin by level so a map fetches only the levels its ladder reads.
2. The **4th ordinal is best-effort** — macrohood/neighborhood coverage is thin outside
   dense cities, and `jp`'s is `null` on purpose.
3. **GB coverage holes** in the deep levels.
4. **Release pruning** — mitigated by the pin + sha256 + fail-loud listing.

**Licensing**: ODbL 1.0, share-alike. Anything served from this file must display
*"© OpenStreetMap contributors, ODbL 1.0 — via Overture Maps Foundation"*. The
manifest's `admin_source: "overture"` plus the release id is what lets the page render
that attribution without guessing.

---

## Phase 3 — the sharded build pipeline

**Source basis: Geofabrik's published extracts** — the only way to never download the
94.3 GB planet. Geofabrik does that pass nightly.

**Two partitions over the same source**, because the two stage groups have opposite
constraints (feature stages: flat RAM, want coarse; density: linear RAM, wants fine):

| partition | for | rule | count | worst case |
| --- | --- | --- | ---: | --- |
| coarse | feature layers (stages 1–3, `--skip-density`) | coarsest Geofabrik region ≤ ~8 GB: six continents whole; europe (34.8 GB), asia (16.2), north-america (19.3) split to children | **86** (measured) | disk-bound, see §Phase 4; largest africa 7.90 GB |
| fine | density only (stage 4 alone) | the finest geometric cover | **500** (measured) | quebec 1.158 GB → ~2.4M cells ≈ 5 GB RSS at the worst measured cells/GB ratio |

**Disjoint partition, derived once offline.** Geofabrik's polygons overlap by design
(buffers). Density's exactness rule — each way attributed to exactly one cell via its
first node — survives sharding only if each shard counts ways whose first node falls in
its *assigned disjoint* region (`shapely.difference` in a fixed order over the cover).
A boundary cell then receives partial tallies from each side that sum to the true total.
Feature stages don't need disjointness; the merge dedups. **Enforced at build time**:
`cover.py` writes each fine shard's assigned polygon to
`tools/osm-world/cover-geometries/<id with '/'→'__'>.geojson` (committed next to
`shards.json`, same run), `ci/build-shard.sh` passes it to `build.py --clip-region`, and
stage 4 bins a way only when its first node — a tree node only when its own location —
tests inside that polygon (prepared shapely geometry, one `contains_xy` per candidate).
`contains_xy` excludes the boundary on BOTH sides, so a first node lying exactly on a
shared border counts on zero sides — at-most-once rather than exactly-once, accepted
because it errs toward undercount and an exact float hit on a full-precision boundary is
measure-zero in practice. Without the clip every way in the overlap buffers is tallied by
both neighbours and the merge double-counts; merge-time correction is impossible (the
summed cells no longer say which side a way came from).

**Clip overhead, measured.** On michigan (unclipped baseline reproduces the 644,967-cell
result exactly): the density pass goes 77 s → 87 s (+13%, ~2.5 µs/candidate over 4.16M
tests), the whole density-only run +11.7%, peak RSS unchanged; 7,720 of 4.16M candidates
(0.19%) are dropped as buffer overlap. German sub-tiles drop proportionally more (a
state-level extract's buffer is a bigger share of a smaller polygon): saarland 23 s →
31 s, 934 of 769,482 (0.121%); rheinland-pfalz 94 s → 110 s (+17%), 41,444 of 3,348,289
(1.238%). Peak RSS unchanged in both (±0.2%). Verified against ground truth in §Retest.

**Merge** (the Option B novelty):

- Feature layers: per layer, concat shard outputs → dedup on `(osm_type, osm_id)` →
  one `ogr2ogr` into a single global `.fgb` with one Hilbert R-tree. The 2.24% buffer
  duplication disappears here instead of shipping.
- Density: sum cells by `(row, col)`; write one global grid.
- Manifest: one global `manifest.json`, with:
  - explicit `features: 0` for legitimately-empty FEATURE layers instead of omission —
    michigan omitted `high_speed_rail` and `coastline` (correctly: OSM reserves
    `natural=coastline` for ocean) and a failed job must not look like that. **Density is
    the one exception**: the client trusts a present-but-empty density grid as a real
    zero (which auto-lifts Bridge Troll, Luxury Car and Right Turn), and zero density
    cells is never true for a real region — so a merge with zero density contributions
    is a **hard error**, and `--allow-missing-density` publishes with density **omitted
    entirely** (absent ⇒ the client degrades and curses warn, the safe direction).
    `density: {"features": 0}` is never written;
  - `planet_timestamp` = the oldest contributing shard's; an `--only` merge-into keeps
    the oldest of the existing manifest's value and this run's, and hard-errors if this
    run's `cell_deg` differs from the existing manifest's;
  - optional per-layer bbox, so the client can skip layers that cannot intersect its map;
  - `admin_source: "overture"`, both the ordinal-table switch and the attribution the
    page must render (§Phase 2).
- **Content-addressed filenames** (`park.<sha256-prefix>.fgb`), enabled by the verified
  byte-reproducibility: unchanged layers keep their URL across rebuilds, so browser and
  CDN caches stay warm; `manifest.json` (max-age 300) is the only mutable object.

**Spike S1 — Option B vs fallback A:** can GDAL's FlatGeobuf writer build the R-tree for
a merged multi-GB layer within sane memory? Fallback if not: 499-tile delivery,
client-side fan-out with `(osm_type, osm_id)` dedup (`cmpTypeId` exists), per-tile
manifests, and Overture admin regardless.

### S1 result — Option B confirmed

The law is per-*feature*, not per-*byte*:

    FGB writer peak RSS ≈ 166 MB + 100 B/feature

measured out to **87M features / 46 GB, peak 8.6 GB**. Nothing the merge will write comes
close to kadro's 31 GB, and the ratio does not depend on geometry size.

**New constraint:** the writer keeps a *hidden unlinked* temp file, and it lands **in the
output directory** — `CPL_TMPDIR` is ignored. Transient disk in `$OUT` is double the
final layer size. This kept the merge on kadro until Phase 6.

Two failures that would otherwise be invisible, both designed against in `merge.py`:

1. **Sparse per-shard schemas make a naive `-append` silently drop columns.** A shard
   whose extract contains no feature carrying `cuisine` writes no such column, and
   appending it into a layer that has one drops the column for those rows without a
   word. **Schema union is mandatory** (VRT `FieldStrategy=Union`); the merge test
   asserts single-shard column witnesses in 23 layers.
2. **Merge dedup would have MASKED the Phase 0 double-emit bug**, non-deterministically —
   it would have shown up as "some builds are 2× larger than others". Hence `merge.py`'s
   **loud per-shard `rows == distinct` assert before merging anything** (`--no-assert` to
   override). A bug that a later stage cleans up is a bug you never find.

### Result — `merge.py`, `cover.py`, `shards.json`

`uv run tools/osm-world/merge.py --shards <dir of per-shard build dirs> --admin
<admin.fgb> --out <dir> [--no-assert] [--work] [--only] [--allow-incomplete]
[--allow-missing-density]`.

Shard discovery is **recursive** (an R2 sync of `shards/feature/` nests `us/michigan/`
a level deeper than a flat scan looks) and treats `--shards` itself as a candidate first
(a root `manifest.json` is a single-shard merge). Symlinked directories are **followed**
under a visited-realpath guard: cycles and duplicate routes over non-shard directories
are skipped with a log, and a **shard** reached twice is a **hard error naming both
paths** (duplicated shards double-count density additively; a symlink loop once yielded
41 discoveries of one shard before the guard). The guard resolves symlinks only —
bind-mount duplicates are not detected. A directory holding `.fgb` files without a
`manifest.json` — a failed build's leavings — is a **hard error listing the offenders**
unless `--allow-incomplete` (root `.fgb` strays included). An `--only` run merges into an
existing `manifest.json` (stamping top-level `"partial": true` while the layer table is
incomplete — the pinned client rule) instead of clobbering the layers it did not touch,
**dropping (loudly) any existing keys the current layer table no longer contains**. Per
layer: VRT union → GPKG → `DELETE` keeping `MIN(fid)` over shard dirs in **sorted
relative-path order** (determinism) → FGB with a spatial index. `count_only` layers carry
zero property columns, so they dedup on exact geometry bytes. Density is summed by
`(row, col)` through an external sort that reproduces `stage_density`'s exact output
shape. Admin is hardlinked in from `--admin` and stamps `admin_source: "overture"`.

**Merge test on kadro** (`~/osm-builds/merge-test/`), bremen + hamburg + berlin shards
merged with the global Overture admin:

- shard builds: bremen 0.5 min / 8.9 M, hamburg 0.7 min / 20 M, berlin 0.9 min / 37 M.
- merged world: **37 layers, 2.36 GB** (admin 2.29 GB / 984,219 features; 243,474
  feature-layer features; 58,996 density cells), **0.5 min wall**.
- **304/304 verification checks pass**: schema union, `rows == distinct`, count bounds,
  exact density sums per key (building 1,086,946 / street 751,018 / car_street 344,590 /
  footpath 399,595 / bridge 12,370 / tree 584,223), manifest coherence, sha/bytes/bbox.
- **Re-running the merge is byte-identical** — every layer sha256 and the manifest match,
  so content-addressed names are stable in practice.
- Merging bremen with itself collapses identity layers to exactly single-shard counts and
  doubles density sums on identical cells — the two behaviours the merge must have.
- The assert fires: a doctored duplicate shard exits 1; `--no-assert` dedups it.
- A single-shard berlin merge produces the `features: 0` entries for `coastline` and
  `commercial_airport`.
- The real client reader opens the merged world 9/9, including Overture admin at levels
  2/4/8 (`2:Deutschland | 4:Berlin | 8:Mitte`), in 306 range requests / 5.8 MB.
- `count_only` residual duplication: **0 cross-shard exact duplicates, 0 near-duplicates
  at 1e-4°**. The 8 dropped duplicates were all *within*-shard byte-identical diagonals
  (distinct entities that share an envelope — a documented hair of under-count). A lower
  bound: the three test shards are not adjacent, so full-overlap dedup was exercised by
  the self-merge instead.

`uv run tools/osm-world/cover.py [--cap-gb 8] [--no-sizes]` writes
**`tools/osm-world/shards.json`** — the pinned interface CI consumes:
`{generated_from, coarse[], fine[]}`, each entry `{id, pbf_url, md5_url, est_bytes}` and
each fine entry additionally `disjoint_neighbors` (which shards can share a boundary
density cell — diagnostic, consumed by nothing). It also writes
**`tools/osm-world/cover-geometries/`** — one GeoJSON per fine shard with its assigned
disjoint polygon at full precision (rounding could open slivers along shared boundaries),
the `build.py --clip-region` input. Both are checked in from the same run. The `fine`
array is **in the difference order** (ascending polygon area, ties by id) so a consumer
can rebuild the assigned disjoint geometries. Real run against `index-v1.json` 2026-08-15
(555 regions):

- **fine: 514 members, 114.2 GB**, largest africa 7.90 GB, no null sizes. One piece of
  land is uncovered by design: Diego Garcia, whose only source is `asia` at 16.18 GB.
- **coarse: 87 regions, each ≤ 8 GB, 82.2 GB**, largest africa 7.90 GB. `dach` (6.2 GB)
  is chosen over `germany`; canada 6.41 GB; france 5.06 GB; the US splits into
  midwest/northeast/pacific/south/west; africa, south-america, australia-oceania and
  antarctica stay whole.
- Uncovered area is **measured, not assumed** — `cover.py` logs `uncovered_deg2`. The
  coarse cover misses 4,175 deg², **entirely open ocean** (Indian Ocean, N Atlantic,
  Pacific off Mexico, Arctic, Philippine Sea); every sampled piece of extract-less land
  is covered by a parent region (e.g. Saudi Arabia via `gcc-states`), and no populated
  place falls in the gap — a claim that was FALSE at 4,251 deg² under the leaf rule,
  when Ukraine was sitting in it. The fine cover misses 18,574 deg² of the 58,770 deg²
  region union (19,726 under the leaf rule), so **density under-counts there and only
  there** — ocean.

### Retest — recursive discovery, `--unlink-source`, `--only` merge-into, and the clip-region fix verified end-to-end

Re-verified on kadro with real, larger inputs (`~/osm-builds/merge-test3/`).

**Nested discovery + loud failure.** Shards hardlinked three levels deep into an
R2-sync-shaped tree (`shards-nested/feature/eu/de-north/{bremen,hamburg}`,
`.../de-east/berlin`) were all found (`--only park,museum`, 1.7 s). A doctored directory
holding `.fgb` files and no `manifest.json` produced exit 1 naming the offender and the
`--allow-incomplete` escape, with **nothing written to `--out`** (the failure is
pre-write); with `--allow-incomplete` the same run exits 0 with a WARNING and merges the
3 good shards. Both `--only` manifests carried `"partial": true`.

**`--only` merges into the existing manifest**: on a real 37-layer world, a `--only park`
re-run logged `--only: merged 1 layer entr(y|ies) into the existing manifest's 37` and
produced a byte-identical manifest with no spurious `partial`.

**`--unlink-source` refuses instantly** for both density-reaching invocations
(`--only density --unlink-source`, and `--unlink-source` with the full layer set): exit 1
before any I/O, naming stage 4 and pointing at `--skip-density` or `--only` without
density; the source pbf survives. A real `--skip-density --unlink-source` run on a
21,132,558-byte extract deleted the pbf one second after stage 1 started, once
`interesting.osm.pbf` existed; outputs (34 `.fgb` files, manifest) were byte-identical to
a control run that kept the source.

**The density double-count fix, against ground truth.** Adjacent pair from `de-src`:
saarland (843,022 ways) and rheinland-pfalz (3,932,973 ways), extents overlapping heavily
by design. Clip polygons = `cover.py`'s real
`cover-geometries/{saarland,rheinland-pfalz}.geojson`, confirmed disjoint (intersection
area 1.4e-18, touching along the shared border). Ground truth = `germany-v2/density.fgb`
(4,612,683 cells), compared over an interior zone (328,924 truth cells) and a boundary
band straddling both polygons (6,592 truth cells).

- **Clipped merge vs. truth: exact.** Interior: 328,924 cells equal, 0 differing, 0
  truth-only, 0 merged-only. Boundary band: 6,592 equal, 0 differing. Per-key sums
  identical in both zones (interior building 2,720,451 / street 1,033,980 / car_street
  469,503 / footpath 571,735 / bridge 23,985 / tree 247,599; band building 43,903 /
  street 14,808 / car_street 6,274 / footpath 8,679 / bridge 411 / tree 1,386).
- **Unclipped merge (the pre-fix behaviour) is detectably wrong.** 1,776 interior cells
  differ, 98.2% of them (1,744) inside the boundary band — 26.5% of all band cells.
  Band-level inflation: footpath +27.7% (11,081 vs 8,679), bridge +24.3%, street +21.4%,
  car_street +13.3%, building +3.8%, tree +6.9%. Over the whole interior: street +0.310%,
  footpath +0.427%, bridge +0.417%, car_street +0.179%, building +0.061%, tree +0.039%.
- **Clip cost on this pair**: saarland dropped 934 of 769,482 candidates (0.121%),
  density stage 23 s → 31 s; rheinland-pfalz 41,444 of 3,348,289 (1.238%), 94 s → 110 s
  (+17%). Peak RSS unchanged (saarland 2,229,716 vs 2,228,832 KB; RLP 2,296,424 vs
  2,300,936 KB).
- **Mechanism confirmed independently**: merging one shard with itself yields an
  identical density *cell count* (10,057) but exactly 2× the per-key totals (building
  197,166→394,332, street 71,704→143,408, tree 26,540→53,080) — density merging is purely
  additive with no identity to dedup on, which is why the disjoint clip, not a merge-time
  correction, is the only defence.

**H2b — cross-tile feature duplication rate.** The retest's shard pairs were either
non-adjacent extracts or a deliberate self-merge, so their 0% results were lower bounds.
Resolved 2026-08-22 by the first real global merge — see §Open questions.

---

## Phase 4 — orchestration

**CI fit (GitHub Actions, standard runners: 4 vCPU / 16 GB / 6 h; documented disk free
≈ 22 GB x64, ≈ 45 GB arm64):**

- Density shards: all fit easily (≤ ~5 GB RSS, ~1.2 GB disk, minutes each). **These
  figures, and every density-shard wall clock and peak-disk number below, PREDATE the
  stage-1 gating (2026-08-26)** and are pessimistic: they were measured with `build.py`
  running the full planet `osmium tags-filter` pass unconditionally, so every density
  shard paid for an `interesting.osm.pbf` no stage read. `main()` now computes
  `source = stage_filter(...) if layers else None`, and `--only density` leaves
  `layers == []`. Do not adjust the published numbers by arithmetic — **re-measure them**.
- Feature shards: RAM flat ~2.4 GB; **disk is the constraint**. Peak ≈ 2.6× source when
  the source is deleted after stage 1 — `build.py --unlink-source`, which
  `build-shard.sh` passes for feature-kind builds and build.py refuses whenever the
  density stage would run (stage 4 is the only later reader of the raw extract). Without
  it the peak is source + intermediate + outputs (~3.5×; africa's 7.90 GB would peak
  ~28 GB against ~22 GB of documented runner disk). That bounds shards at ~8.6 GB on x64,
  ~17 GB on arm64 — hence the ≤ ~8 GB coarse rule.
- The merge did not fit a documented runner (germany `green` alone is 2.7 GB; global
  pre-reduction ~43 GB for that one layer), so it ran on kadro (219 GB free, 31 GB RAM)
  until Phase 6 measured the real runner envelope.
- Matrix cap 256 jobs/workflow → batch the density shards. Concurrency: 20 (Free) /
  40 (Pro). Public repos: unlimited free minutes; private on Pro: 3,000 min/mo then
  $0.005/min (arm64 2-core). A monthly rebuild ≈ 12.5 job-hours on kadro-class hardware.
  If private overage matters, split `tools/osm-world/` + workflow into a public build
  repo (nothing in it is sensitive; R2 credentials are env/secrets).
- R2: bucket CORS must expose `content-range` (`build.py` writes `r2-cors.json`; apply
  with `wrangler r2 bucket cors set`).
- Cadence: monthly. Parks and libraries do not move weekly; `planet_timestamp` reaches
  every provenance row, and staleness is disclosed, not hidden.

### Result

| file | trigger | matrix | per-job timeout | R2 prefix |
| --- | --- | --- | ---: | --- |
| `.github/workflows/world-canary.yml` | `workflow_dispatch` only | one ~1 GB coarse shard | — | none — **needs no secrets** |
| `.github/workflows/world-density-shards.yml` | dispatch only (schedule disabled) | 514 fine shards, batched | 90 min | `shards/density/<id>/` |
| `.github/workflows/world-feature-shards.yml` | dispatch only (schedule disabled) | 87 coarse shards, batch 1 → 87 jobs | 240 min | `shards/feature/<id>/` |

Helpers: `tools/osm-world/ci/chunk-shards.py` (stdlib only; batches `shards.json[kind]`
into the `strategy.matrix.include` list and **fails cleanly** if a future `cover.py` run
would exceed `--max-jobs`, default 256 — the fix is raising the batch size, not a code
change) and `tools/osm-world/ci/build-shard.sh` (downloads pbf + `.md5` with `curl -L`
and **compares hashes by hand**, then runs `build.py … --upload --prefix
shards/<kind>/<id>`, reusing `build.py`'s own boto3 uploader, and cleans its scratch dir
between shards; density builds get `--clip-region cover-geometries/<id>.geojson` — a
missing geometry file is a hard error, since an unclipped density shard would silently
poison the merge — and feature builds get `--unlink-source`).

Both shard workflows **fail loudly** on a missing `shards.json` (it and
`cover-geometries/` are committed `cover.py` outputs, read from the checkout) and on
missing `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET`.
The `schedule:` trigger stays disabled; the secrets exist as of 2026-08-22. Retries wrap
the *whole* per-shard call and are a **full re-download + rebuild**, not a resume
(`build-shard.sh` clears its work dir on entry and passes `--force`) — acceptable for the
transient network/runner failures they exist for.

Validation: PyYAML parse; `actionlint` 1.7.10 (+shellcheck 0.11.0) clean over all
workflow files; `chunk-shards.py` verified against a synthetic 499-fine/7-coarse index
(batch 5 → 100 batches with 4 in the last, total preserved; over-cap fails cleanly). At
full scale: **run 32568376978 (`world-feature-shards`) finished 88/88 jobs with zero
failures** — longest `canada` at 220.9 min against the 240-min timeout, 6.34 GB peak
RSS, 128% CPU, disk never below 87 GB free (`africa`, a larger 7.90 GB extract, took only
50.2 min; `russia` 106 min — canada is slow because of lake geometry, not size) — and
**run 32568378245 (`world-density-shards`) finished 114/114 with zero failures**, longest
job 47 min. Matrix expansion, secret propagation and apt GDAL all behaved. All 601 shard
manifests landed under `shards/{feature,density}/<id>/manifest.json`, 50.00 GB total in
R2.

---

## Phase 5 — client wiring and test closure

- `worldBaseUrl` is threaded UI → `app.js` → worker; `DEFAULT_WORLD_BASE_URL` carries the
  real bucket domain.
- `make-test-world.py`/`test-pipeline.mjs` cover the closed-way dedup case, `features: 0`
  entries, bbox-diagonal curse layers, path-less manifest entries and the `partial: true`
  refusal rule — 68 → **83 assertions**; the test world builds four layers through
  `build.py`'s real pipeline.
- **Still open**: a golden-number run against a readable world. Since 2026-09-01
  (`useOsm` deleted, the S2 phase unconditional) the app has no configuration in which
  the OSM layer is skipped, so `tools/smoke.mjs`'s 19 numbers cover a path —
  `worldBaseUrl` unreachable — that only a harness ever takes.
- **Still open**: browser end-to-end against the real bucket. Range + CORS differ between
  Node fetch and browsers; this is the step that catches a bucket that doesn't expose
  `Content-Range`, which presents as a corrupt file, not a CORS error.

Wired, all in `osm/`:

- **`admin_source` switch**: absent or `"osm"` keeps the OSM admin-level behaviour
  byte-identically; `"overture"` selects the Overture ordinal table. Read off the
  manifest inside `adminInfo`. Documented in `CONTRACT.md`.
- **`name:en`** genuinely reaches the ladder.
- **`curseLayerCount`**: an absent *non-base* term of a fallback expression counts 0 with
  an info log (the build legitimately omits a layer whose selector matched nothing). An
  absent *base* term (`green`) refuses, and a negative total refuses.
- **Path-less `{"features": 0}` manifest entries are real, empty layers, not crashes.**
  `osm/worldfile.js` distinguishes three manifest states: **absent** (no entry — `null`,
  category degrades), **empty-with-file** (path + `features: 0` — reader constructed,
  file read, genuinely empty), and **empty-path-less** (merge.py's shape — `worldCount`
  returns `0`, `worldPois` returns `[]`, no reader constructed, no HTTP request issued;
  previously this fell through to `<base>/undefined` and aborted whatever predicate
  touched it). When a fallback term is absent *and* the manifest's top-level `"partial"`
  is `true` (a `--only` build), `curseLayerCount` refuses with a warn log instead of
  counting 0, because on a partial manifest absence means "not built". Verified against
  the real reader through 36 checks in the retest wave, including a doctored
  `partial: true` manifest that leaves the affected curse predicates unanswered while the
  rest of the loop keeps working, and zero requests to `<base>/undefined` across every
  scenario.
- **`flatgeobuf.js` tail overflow**: when the last feature of a run exceeds the 8 kB
  coalesce tail, the reader fetches only the missing bytes instead of re-reading the
  whole run — 91,056 vs 109,808 bytes on a 60-small-plus-one-64 kB-polygon probe, same 3
  requests, identical features. This is the double-fetch Phase 2's admin bytes made worth
  finding.
- **Country identity by zone-centre census** over ISO3166-1 polygons rather than
  alphabetical order — a Basel-like map answers `ch`, not `de`. The `(level, name)`-order
  rule survives as the tie-break and the no-zones fallback.

---

## Rejected alternatives (and why, so they stay rejected)

- **Planet monolith build**: 139–301 GB RAM in stage 4. Not a disk problem — rewriting
  `stage_density` to spill would fix RAM but not the ~112 h single-machine wall clock.
- **Free-tier planet hosting of the build** (GCP/AWS/Azure/Oracle/Actions): all fail on
  disk and/or RAM; Oracle's Always Free was halved June 2026 and is the only near-miss.
- **PMTiles instead of FlatGeobuf**: the README's objections (tags dropped, clipping) are
  defeasible (`-y/--include`; precomputed centroids), but exact counts are
  achievable-not-guaranteed (`-r1 -pf -pk`, no documented zero-drop guarantee), MVT
  simplification breaks point-in-polygon, and `--use-attribute-for-id` is unstable
  across runs. With admin moved to Overture and the payload reduced by a measured 63%,
  the size problem PMTiles would solve no longer exists, and the tested reader stays.
  Revisit only if request count becomes a real UX problem.
- **Overture for the category layers**: selectors are OSM-tag-specific and `cuisine` is
  read off individual features; not verified safe. Admin only.
- **Regular lat/lon grid as shard basis**: requires the planet locally to cut. The whole
  point of Geofabrik-based sharding is never touching the planet.
- **Coarser-shards-for-cost**: dead since the 6.5 s fixed-cost measurement; shard count
  is a wash. Coarseness only matters for runner disk (upper bound).

## Open questions / spikes

| id | question | decides | status |
| --- | --- | --- | --- |
| S1 | peak RSS of GDAL FlatGeobuf write on a merged multi-GB layer | Option B vs fallback A | **RESOLVED** — 166 MB + 100 B/feature; Option B confirmed |
| S2 | Overture `locality` admin_level coverage + `division_area` size; fr/de/it/gb deep-level mapping | Phase 2 shape | **RESOLVED** — Overture adopted; synthetic subtype→level map |
| S3 | one ~1 GB shard on an actual Actions runner (time, disk headroom) | CI cost model | **RESOLVED** — run 32324799596 (2026-08-20, PRIVATE-repo runner, 2 vCPU / 8 GB): czech-republic, 944 MB, full pipeline, **19.8 min, 2.19 GB peak RSS, 110% CPU, GDAL 3.8.4 from apt**, 36 layers / 960,750,728 B. Re-run on a PUBLIC runner (32566905248, 2026-08-22): same shard, **13.8 min** (−30%), 115% CPU, 2.29 GB RSS, identical output. Cores doubled; wall clock fell 30%, not 50%, because the density pass is single-threaded |
| H2b | cross-tile duplication rate per layer — prior measurement was polluted by the double-emit bug | merge dedup sizing | **RESOLVED** (2026-08-22, merge-canary run 32587570192) — first real cross-shard merge over the full 87-member coarse cover (aquarium carried by 70 shards, foreign_consulate by 86): aquarium 1,699 → 1,679 (**1.18%** deduped), foreign_consulate 5,375 → 5,355 (**0.372%**), green_recreation_ground 194,672 → 194,105 (**0.291%**, via the count_only geometry-bytes dedup). Every prior figure was a 0% lower bound from non-adjacent extracts. Caveat: a **three-layer** rate from a canary; per-layer rates will vary with feature density along Geofabrik's buffers |
| — | rebuild michigan/germany with the `advertising` fix before any count is published | published numbers | **CLOSED** — michigan-v3 (232,847,376 B, advertising 772) and germany-v3 (3,343,969,105 B, advertising 35,816); see §Phase 0 Result |
| — | `green` serves a weight-0.5 legal-spot category (`osm/geodata.js`) at a large fraction of the world's bytes | product call on R6 | open — 1.57 GB for germany post-Phase-1, 14.22 GB pooled globally, so less pressing |

## Phase 6 — everything in GitHub Actions

Investigated 2026-08-22 (14-agent fleet: 7 research / 3 designs / 3 critiques /
synthesis) after the canary resolved S3: can the MERGE and the ADMIN build move into
Actions, leaving no step that needs a workstation? **Yes, if (a) the repo is public and
(b) the density merge is banded.**

- **Public is not about minutes.** A private-repo standard runner is 2 vCPU / 8 GB RAM;
  public is 4 vCPU / 16 GB. **Measured on our own runner** (canary run 32566905248,
  2026-08-22, first thing after checkout): `cores: 4   ram: 15 GB` and **`disk: 86.2 GB
  free of 144.3 GB`**, against the **14 GB GitHub documents** — and not the ~108 GB the
  investigation's sample reported (same 144 GB volume, 22 GB less free), so treat 86 GB
  as the working figure and re-read it every run. The merge needs 60–90 GB.
  `jlumbroso/free-disk-space` (+31 GB, ~3 min) is **mandatory on the merge jobs, not
  conditional**, because the 86 GB envelope is undocumented headroom that could shrink
  without notice. The repo was made public 2026-08-22. Every workflow prints `nproc`,
  `free -g` and `df -Pk` as its first step so a reversion shows up as a logged number
  rather than as ENOSPC 400 jobs into a rebuild.
- **Larger runners are not an option.** They require a Team/Enterprise *organisation*;
  this account is a User. Do not design around them.
- **The density merge is the only job that does not fit, and it fails on RAM.** The
  merged grid was estimated at ~133 M cells (79–243 M band); **measured 2026-08-22:
  119,473,135 cells** summed across the 514 fine manifests. GDAL's writer at
  100–162 B/feature puts a single global write at **~12.1–19.5 GB against 16 GB**, and at
  a measured 11,588 cells/s it is ~2.9 h serial against the 6 h cap. Split by row into
  N = ceil(cells / 30 M) bands and each becomes a ~35 min job at ~3 GB RSS. At the
  measured count **N = 4**; N is **computed at run time** by `ci/merge-plan.py` from the
  manifests' summed `layers.density.features`, never hard-coded, so the next planet
  snapshot re-derives it.
- **`green` was never the blocker.** Extrapolating from czech-republic (63% of that
  shard's output) gave 34–50 GB; multi-extract extrapolation gave ~22.4 GB (band
  14.9–27.7); **measured at full scale: 14.22 GB pooled / 19,477,819 features** — below
  even the band's low end. One-country extrapolation was wrong by ~2×, multi-extract by
  ~1.6×. Its merge runs ~1.7 h on a real runner.
- Shape: five workflows (the three existing plus `world-admin.yml` and
  `world-merge.yml`, under a `world-rebuild.yml` orchestrator), **~218 jobs, ~4.5–5 h
  wall** at the 40-concurrent ceiling. The merge is a **per-layer matrix**, not one
  serial job — the serial version measured ~5.4 h against the 6 h cap with no
  checkpointing, so an hour-5 failure would discard the admin build and 36 finished
  layers. Intermediates move through **R2, never Actions artifacts**: there is no
  documented artifact size ceiling and a known 4.29 GB failure report.
- **The `/vsis3` escape hatch does not work.** Writing merge output straight to R2 would
  drop local footprint to 0.87×F, but `publish_layer` does `sha256_file(temp)` then
  `temp.rename(final)`, and over `/vsis3` a rename is a server-side `CopyObject` —
  **R2 caps single-part copy at 5 GiB**, which both `water` (**5.44 GB measured**; an
  earlier estimate said 7.14) and `green` exceed. Rescuable with multipart
  `UploadPartCopy`, but that is new untested code. Merge output is written locally and
  uploaded through build.py's boto3 uploader instead (`merge.py --upload`, B4 below).

### Result — the measured planet, and the five workflows (2026-08-22)

Runs 32568376978 (feature, 88/88) and 32568378245 (density, 114/114) against commit
`9ef3459` put 601 shard manifests and **50.00 GB** in R2. Pooled shard totals, summed from
the manifests:

| quantity | measured |
| --- | ---: |
| feature shards, all layers | **34.94 GB**, 103,646,150 features, 35 layers |
| `green` | **14.22 GB**, 19,477,819 features |
| `water` | **5.44 GB**, 2,292,996 features |
| `curse_water` | 3.24 GB, 26,446,788 features |
| `pitch` | 2.31 GB |
| `curse_cairn_terrain` | 1.82 GB |
| `coastline` | 1.52 GB |
| `shop` | 1.51 GB |
| density grid | **119,473,135 cells**, 15.06 GB |

**One shard published a manifest with zero layers, and that is correct.**
`british-columbia` logged `stage 4: no populated cells, omitting density from the
manifest` and published `layers: {}` — its populated land is claimed by the four smaller
sub-extracts (`southcoast-admreg`, `island-admreg`, `okanagan-admreg`, `north-admreg`)
that sort ahead of it in the area-ascending cover, leaving an offshore-only residual. The
merge tolerates it: an absent layer key and a path-less `{"features": 0}` entry both
merge as empty (`merge.py listed_path` — the path-less shape used to crash with a
KeyError; build.py never writes it, but merged worlds and test worlds used as shard
inputs do), and both are kept distinct from a LISTED file that is missing on disk, which
stays a hard error.

**The merge and admin builds are workflows**: `world-admin.yml`, `world-merge.yml`, and
the `world-rebuild.yml` orchestrator chaining shards → admin → merge (the two shard
workflows grew a `workflow_call` trigger; `workflow_dispatch` behaviour is unchanged).
world-merge: a `plan` job (`ci/merge-plan.py`) syncs the ~600 manifests, **refuses to
merge unless the R2 manifest set equals shards.json's id set in both directions** (a
missing manifest is a job that never ran; an extra one is a stale shard whose density
would double-count — the lakes-mask hazard below), computes **N = ceil(cells / 30 M) at
run time**, and emits the per-layer matrix pooled-bytes-descending so green starts
first; 35 per-layer merge jobs; N density band jobs (`merge.py --density-band K/N`,
interleaved rows `row % N == K-1` so band populations are near-equal without a global
row histogram); one `assemble-density` job (`--assemble-density-bands`, a pure VRT
append of the row-disjoint bands — validated band set, cell-count identity enforced; the
one full-grid FGB write, ~12.1 GB RSS against 15 GB, with swap as the buffer and
client-side multi-band density as the documented fallback if it ever OOMs); and a
`finalize` job (`--assemble-manifests`) that places admin, refuses an incomplete layer
table, and **HeadObject-verifies every referenced layer object in R2 (name and bytes)
before uploading the manifest last**. Intermediates (partial manifests, band files) stage
under `merge/staging/<run_id>/` in R2 — never Actions artifacts — and are cleaned up by
finalize.

**Gap B4 — `merge.py` had no uploader — is closed.** `merge.py --upload --prefix
[--manifest-dest]` reuses build.py's boto3 uploader (`r2_client`/`r2_upload`, extracted
from `stage_upload` behaviour-identically): layer files first, manifest strictly last,
same ContentType/CacheControl rules, no second aws-cli path for published objects. The
four primitives merge.py used to re-implement — `log`, `run`, `sha256_file`,
`feature_count` — are plain module-level rebindings (`log = build.log`, …), not
wrappers, on purpose: a wrapper resolves `build.run` at call time and would pick up
`test-update.py`'s stub of it, silently changing what that harness exercises. aws-cli is
used only for the intermediate handoffs (manifest syncs, staging, the admin.fgb handoff),
always via the S3 API — never the public CDN domain, whose immutable-cached copies of the
non-content-addressed shard files can be stale. Two extra guards, because a wrong
manifest is a live-site break: `--upload` refuses to write a `partial: true` manifest to
the DEFAULT `<prefix>/manifest.json` (a matrix job that forgot `--manifest-dest` must not
clobber the world), and the band sidecar uploads after its band file so its presence
marks the band complete.

**First world-admin dispatch (run 32591161893) failed on a GDAL driver gap; the fix
removed the dependency.** ubuntu-latest's apt GDAL is built WITHOUT the Arrow/Parquet
drivers (82 drivers listed, neither present), so `build-admin.sh`'s parquet handoff to
ogr2ogr could not open its own intermediate — invisible on kadro, whose GDAL has the
drivers. The gap was drivers, not version, and `command -v` can never catch it. Fix:
duckdb-spatial's bundled GDAL writes `admin.fgb` DIRECTLY (`COPY … TO (FORMAT GDAL,
DRIVER 'FlatGeobuf', SRS 'EPSG:4326', LAYER_CREATION_OPTIONS 'SPATIAL_INDEX=YES')`, with
`ST_Multi` replacing ogr2ogr's `PROMOTE_TO_MULTI`) — no 4.47 GB intermediate, no ogr2ogr
step. Verified on a Vatican-bbox A/B against the old path run through local GDAL:
**identical feature content** (same md5 over sorted-WKT dumps) and **identical answers
through the real client reader** (IT+VA seen; St Peter's → VA only; Rome → IT, never VA;
11 range requests — a successful query proves the spatial index, since the reader's
`search` throws without one). One cosmetic difference: the layer header says Geometry
"Unknown (any)" instead of "Multi Polygon"; per-feature types are written and the reader
treats the header type as a default only. Every GDAL-using workflow job now **preflights
its drivers by name** right after the apt install (`ogrinfo --formats | grep` — plain
grep, not `-q`, whose early exit SIGPIPEs ogrinfo and fails the pipeline under `pipefail`
on success), so the next gap of this kind costs seconds, not a 3.5-minute build.

Verified locally (2026-08-22): the banded path equals the serial merge **cell for cell**
on the make-test-world.py world (bands 1/2 + 2/2 → assemble → identical cells and per-key
counts; all 36 other layer entries byte-identical in the final manifest); every
loud-failure path fires (missing band, missing sidecar, incomplete layer table,
stale/missing cover members, partial-to-live-manifest guard); all four suites pass
(test-update 45, test-reader 45, test-pipeline 83, smoke 19/19). `world-merge.yml` was
then dispatched for real as run 32599689118, which published the live world.

### What this found that is not about Actions

- **Feature shards still build the `admin` layer `merge.py` discards** — **16.5% of
  pooled shard output** (13% on czech, 41.7% on ghana), ~11 GB built, uploaded and thrown
  away per rebuild. Free to remove; nothing reads it. (Since removed — see the README's
  `count_only` section.)
- **`opening_hours` is dead weight.** `geodata.js` sets `pathIds = null`, so
  `spotOpenAllHours` is never called. ~150–250 MB.
- **Only `park` and `water` need rings** (`RING_CATEGORIES`); the other 20
  mixed-geometry layers ship polygon rings nothing reads. Replacing them with bbox
  diagonals plus stored `rep_lat`/`rep_lon` takes the world 62.8 → ~43 GB and green
  22.4 → ~6 GB. Three measured constraints: a bare POINT is smaller still but moves the
  R-tree envelope and **undercounts by up to 30% on a 2 km map**; the `rep_lat`/`rep_lon`
  pair is **not optional** (p99 representative shift 116 m on green, **789 m on pitch**,
  against a 400 m zone radius); and `merge.py` re-exports diagonals as `-nlt GEOMETRY`,
  costing **+13%**. A build-time node-swallow that would make this cheaper is
  **rejected**: under sharding `complete_ways` drops an area whose vertices all lie
  outside a shard while its interior covers a node inside it (3 of 25 straddlers in a
  real bremen re-cut), so the swallow must stay in the merge.
- **Only 5.1% of the fine cover buys artifacts, not the ~35% first reported.** Audited
  2026-08-22 by recomputing `cover.py`'s exact land test against every committed
  `cover-geometries/<id>.geojson`, decomposing the pieces for all 11 members over 1 GB,
  and reverse-geocoding each. Fresh residuals recomputed from today's index in
  `shards.json`'s difference order have **zero** symmetric difference with all 11.

  | member | GB | eroded land deg² | what is actually there | verdict |
  | --- | ---: | ---: | --- | --- |
  | australia-oceania | 1.56 | 0.810 | Archipel des Kerguelen | REAL, sole source |
  | south-america | 4.10 | 0.481 | South Georgia + South Sandwich | REAL, sole source |
  | canada | 6.42 | 0.019 | Saint-Pierre-et-Miquelon — **~6,000 residents** | REAL, sole source |
  | africa | 7.90 | 0.011 | Archipel des Crozet | REAL, sole source |
  | british-columbia | 1.24 | 0.025 | BC outer coast in no `admreg` extract | REAL |
  | italy | 2.22 | 0.004 | San Marino | REAL, sole source |
  | england | 1.69 | 0.0004 | inland gaps between county cutting polygons, ~3 km² | REAL but trivial |
  | **us-midwest** | **2.49** | 0.291 | **open Lake Michigan + Superior surface** | **ARTIFACT** |
  | **us-northeast** | **1.79** | 0.004 | **open Lake Erie surface** | **ARTIFACT** |
  | **china** | **1.58** | 0.001 | cross-Amur buffer sliver **inside Russia**, already covered by `siberian-fed-district` | **ARTIFACT** |

  The four big remotes (19.98 GB) buy real, sole-source, in one case *inhabited* land,
  and are irreplaceable under the cover's "no land in no shard" contract. **The waste is
  5.86 GB, in three members**; the "155 members for 0.25% of land" framing was
  misleading, since most of those are legitimate tiny members (tuvalu, nauru, ceuta)
  costing ~0 GB.

- **The artifacts have one root cause, and no threshold fixes it.** Natural Earth's
  1:50m *land* layer **does not subtract lakes**, so open Great Lakes surface reads as
  land. Sorted by eroded land, real and artifact **interleave** — tuvalu 0.00027 <
  england 0.00043 < china 0.00088 < melilla 0.00094 < nauru 0.00145 < pitcairn 0.0024 <
  ceuta 0.0025 < maldives 0.0034 < **us-northeast 0.0035** < San Marino 0.0038 — so any
  `LAND_EPSILON_DEG2` that drops an artifact drops six real territories first. Erosion
  fails in the other direction: the lake pieces are broad rather than thin, so
  `us-midwest` still has 0.15 deg² at 0.05° while San Marino dies at 0.03° and atolls die
  immediately. **The fix is to subtract Natural Earth's lakes layer from the mask** —
  that removes `us-midwest` and `us-northeast` (4.28 GB) with nothing real at risk.
  `china` needs a separate rule (a post-pass dropping a member whose residual land lies
  wholly inside later buildable members) or 1.58 GB accepted. `england` is genuinely
  uncovered land with no smaller container, so only an upstream Geofabrik tiling fix or a
  documented `--allow-uncovered-land` waiver removes it, at ~13 km² of countryside where
  the density curses would silently lift.

  **Measured cost of the lakes mask (not applied to the 2026-08-22 run): a five-shard
  delta.** Subtracting `ne_50m_lakes` (412 polygons; 126.99 deg² of lake surface removed,
  touching 14 of 1,420 land polygons, with San Marino / Kerguelen / Saint-Pierre / Crozet
  / South Georgia all still land) gives **512 members: two dropped, none promoted** —
  their residual was pure lake surface. But the assigned polygons are a difference chain,
  so dropping a member changes what every later member differences against: **509 of 512
  come out byte-identical; three gain territory** — `canada` 0.0689 deg², `ontario`
  0.0055, `quebec` 4e-8 — absorbing the former overlap band along the US–Canada border on
  Erie/Ontario/Huron/Superior and the St. Lawrence. Mostly water, but that band holds
  real ways (Niagara, the Ambassador Bridge), so those three density shards are stale
  under the new cover.

  **It must land atomically with respect to the merge**: a pre-change
  `ontario`/`canada`/`quebec` merged *after* the drop zero-counts the band; merged
  *before* the two dropped shards' R2 output is deleted, it double-counts it. Nothing in
  the pipeline detects either. Sequence: regenerate cover + geometries with the new mask
  in one commit, rebuild those three shards (8.55 GB, ~2.2 h across three jobs at the
  measured ~15 min/GB), delete the two dropped shards' R2 prefixes, then merge. One-time
  8.55 GB of builds to save 4.28 GB every month — break-even inside two cycles. `china`'s
  1.58 GB is untouched by this. The uncovered-land assertion is unchanged under either
  mask: 0.0110 deg², one piece, Diego Garcia.

- **The committed cover is exactly reproducible.** A control run of the real
  `compute_fine` against today's index with the committed mask returns exactly 514
  members and **all 514 assigned geometries byte-identical** to the committed
  `cover-geometries/` files. The partition does not drift with Geofabrik's nightly
  index, so a shard rebuilt next week is clipped identically to one built today.

- **Geofabrik etiquette.** The plan pulls ~196 GB/month across 601 files, and 41.45 GB
  of that is **72 extracts downloaded twice** because they are in both covers. Their
  Sept 2025 "Download responsibly!" post says *"If you want data for the whole planet,
  don't download it piecemeal from us."* The long-term answer is mirroring
  `planet-latest.osm.pbf` (94.4 GB — less than one month of our pulls) into R2 and
  cutting extracts ourselves.

## Phase 7 — `transit_route` and `rail_line`, the OSM fallback tier's build side (2026-08-24)

The fallback tier lets a map with **no GTFS feed at all** be played: the player draws a
ring, `osm/synth.js` synthesizes a feed from OSM route relations, and the report labels
the invented timetable as invented. That costs the build one ordinary category layer and
one that cannot be one.

**`transit_route` cannot be a `categories.json` entry, for two independent reasons:**

- **`osmium export` drops `type=route` entirely.** It emits relations as multipolygons
  only. Verified against osmium-tool 1.19.1: a `type=route,route=subway` relation over
  two member ways exported as the two ways' linestrings carrying their own
  `railway=subway` tags and **none of the relation's**. No `where` clause recovers a
  route from that.
- **The Phase 2 law.** A relation only assembles when it fits entirely inside the extract
  being read. A metro line crossing a Geofabrik boundary assembles half, or not at all,
  in each of the two shards that touch it, and `merge.py` keeps `MIN(fid)` over shards in
  sorted order, so the surviving copy would be whichever shard sorts first, half line and
  all.

So it is a **global out-of-band pass joined at merge time, exactly as admin is**:
`build-transit.py` (PEP-723 uv script, importing `build.py`'s planet stages rather than
copying them) → `merge.py --transit` (`place_prebuilt`, which `place_admin` now shares)
→ `world-transit.yml` (world-admin.yml's shape, plus a mandatory disk gate because this
one reads the planet) → chained in `world-rebuild.yml` beside admin. The pipeline is one
`osmium tags-filter r/route=<six modes>` pass over the planet, then **two** pyosmium
passes over the resulting few-hundred-MB intermediate — relations first, so the second
pass keeps only the member ids the first asked for. A single pass would have to cache
every way and node in the file against the chance a later relation names it, which is
`stage_density`'s RSS law and the reason the monolith build died.

**Every assembly rule is a measurement, not a reading of the spec.** Corpus: 992
relations across 14 cities (Seoul, NYC, Berlin, Tokyo, Shanghai, Beijing, Guangzhou,
Shenzhen, Chengdu, Wuhan, Osaka, Nagoya, Taipei, Busan).

| the naive thing | what the corpus says | the rule |
| --- | --- | --- |
| chain members in stored order | ≥1 endpoint mismatch in Seoul 52/162, NYC 50/131, Berlin 27/148; union-find says 97.7% are one component | re-chain by shared endpoint **node id**, reversing segments; ties on the smallest id |
| path members are role `""` | Seoul carries 413 `forward` + 544 `backward`; the empty role alone empties 8 Seoul relations and fakes gaps in 54 | path roles are {`""`, `forward`, `backward`} |
| the relation's ways are the line | NYC 3,309 way-`platform` members, Berlin 2,609 | platform roles never reach geometry; unknown roles ignored and counted |
| stops come first (PTv2) | Beijing 2, Tokyo 2, Shenzhen 2, Chengdu 1, Osaka 1 interleave them after the ways | read stops **by role**, never by position |
| a route is one line | 22 relations have no degree-1 endpoint (circle lines), 3 have a junction, 17 are disconnected into 2–4 pieces | seed loops from the smallest way id; emit MultiLineString, longest part first; **never bridge a gap** |
| stop order = member order | projection onto the chained line reproduces member order for 95.9%; the 4.1% that differ are the Tokyo/Berlin through-services | sort by projected distance… |
| …so the projection decides everything | the chainer seeds on a node id and cannot know which way trains run — both direction relations would come back identical | …but the **member list** decides which end is the start, by majority vote |
| ship every relation | 17 corpus relations have no stop members (Taipei 6/32) | drop them: a line nobody can board is not a route |

**The schema is self-contained and that is load-bearing.** The layer is not built through
`export_layer`, so `include_tags`/`runtime_columns` do not apply and the twelve columns
are pinned in `build-transit.py`: `osm_type`, `osm_id`, `name`, `name_en`, `ref`,
`colour`, `operator`, `network`, `route`, `interval`, `duration`, `stops` (JSON
`[[nodeId, name, nameEn, lat, lon], …]` in travel order). Writing it through the global
`-select` projection would hand the client a layer whose tag columns are all empty.
Absent tags are written as the empty string rather than JSON null, because OGR infers a
GeoJSONSeq field's type from the values it sees and a column null on every feature has
no type to infer.

### Result — measured on Berlin, reproducible, and read back through the client

`berlin-latest.osm.pbf` (94.5 MB, planet snapshot 2026-08-23T20:21:36Z), 16 cores:

| quantity | measured |
| --- | ---: |
| route relations found | 237 |
| features emitted | **237** (0 dropped for no stops, 0 for no geometry) |
| output | **2,678,856 bytes**, `sha256 088224f4…` |
| wall clock | **15.5 s**, of which ~7 s is the tags-filter pass |
| peak RSS | **1.85 GB** — almost all of it pyosmium's fixed cost |
| multi-part (honest gaps) | 27 |
| platform members excluded | 4,712 |
| stops > 500 m from their line | 0 |
| member ways outside the extract | 74,850 |

Three runs from the same extract are **byte-identical**, so `fgb-equal.sh` tier 1 is
the reproducibility test for this stage as for `build.py`'s. The last row is the extract
law seen from the inside: Berlin's regional `route=train` relations run to Hamburg, and
74,850 of their member ways are not in the file — what a shard would suffer and a planet
run does not.

Read back through **the app's own reader** (`worldTransitRoutes` over a file-backed Range
implementation, central-Berlin bbox): 165 routes in 278 range requests, tags and `stops`
intact, and U8's two direction relations returning 24 stops each **running opposite
ways** — the one property the direction rule exists for, and the one a projection-only
sort silently gets wrong. `test-update.py`'s eighth check pins all of it on fixtures:
scrambled and reversed members, a circle line, a disconnected relation, a junction,
legacy and platform roles, an out-of-sequence stop, both directions, and byte-identical
output under a reordered member list.

**`rail_line`** is the ordinary half, one `categories.json` entry:
`railway IN (rail, subway, light_rail, tram, monorail, funicular) AND service IS NULL`,
mixed geometry with `dedup` (a balloon loop is a closed way and exports as a polygon
too). The `service IS NULL` clause is the entry: **59.5% of `railway=subway` ways carry
`service=*`** (47.3% of them `service=yard`), rail 49.9%, light_rail 30.6%, tram 27.4% —
without it the layer is mostly depots and sidings. It is why `service` joins
`include_tags` (and **only** `include_tags`: no client reads it). Lifecycle values are
excluded by listing the live ones rather than negating the dead ones, because
`railway=abandoned` alone is 434,320 ways and a negation would silently admit whatever
value gets invented next.

### What is NOT measured yet

- **The planet run.** `world-transit.yml`'s disk and wall-clock numbers are arithmetic on
  measurements taken elsewhere: the canary's `86.2 GB free of 144.3 GB` plus
  `jlumbroso/free-disk-space`'s +31 GB against a ~94 GB planet, which is why that action
  is **mandatory** here and why the job refuses by name below 100 GB free rather than
  discovering ENOSPC an hour into a download. The workflow has never been dispatched.
- **The handoff is wired but unexercised.** `world-merge.yml`'s finalize job fetches
  `$TRANSIT_PREFIX/transit_route.fgb`, verifies its sha256 sidecar, and passes
  `--transit` to `--assemble-manifests`, mirroring the `--admin` handling. No CI merge
  has run with it; until a transit build exists in R2, a finalize run fails loudly by
  name at the fetch ("dispatch world-transit.yml first").
- **RAM at planet scale.** Berlin's 1.85 GB is dominated by a fixed pyosmium cost. At
  planet scale pass B holds every path way's coordinates in memory at once: ~1.5 M
  distinct path ways at ~20 nodes each is a few GB of Python tuples against a 16 GB
  runner — probably fine, unmeasured, and the first thing to look at if the job is
  OOM-killed rather than timed out. The cheap fix is an `array('d')` per way rather than
  a tuple of tuples; the expensive one is to shard by mode.
- **The client budget.** The measured OSM budget on the reference border (~33 s, ~290
  range requests, ~14.6 MB) predates `rail_line`. It must be **re-measured**, not
  adjusted by arithmetic, before this ships.

## Baselines (kadro, `~/osm-builds/` — outside the Syncthing-synced tree; keep)

- `michigan-mono/` — byte-identical to the VM build; the reproducibility reference.
- `germany-mono/` + `rss-germany.log`, `time-germany.log` — monolith reference for the
  double-emit fix and Phase 1.
- `de-tiles/` (16 sub-tile builds + `RESULTS.txt` per-tile timings) + `de-src/` sources —
  H2/H3 evidence and re-measurement inputs without re-downloading.
- `germany-latest.osm.pbf`, `michigan-latest.osm.pbf` — pinned sources (planet snapshot
  2026-08-15T20:21:20Z).
- **`michigan-v2/`, `germany-v2/`** + `build-germany-v2.log` — the Phase 0+1 outputs,
  predating the `advertising` reclassification; kept only as a diff reference against v3.
- **`michigan-v3/`, `germany-v3/`** + `build-germany-v3.log` — the current, published
  baselines (§Phase 0 Result); the numbers in the top-of-file summary table.
- **`spike-s1/`** — the FGB-writer RSS series (to 87M features / 46 GB).
- **`spike-s2/`** — `admin-global-s.fgb` (2.29 GB, 984,219 features, the shipped
  simplified variant), the full-precision variant, and the Michigan-only negative control.
- **`merge-test/`** — the bremen/hamburg/berlin shards, the merged world, and
  `verify-merge.py`'s 304 checks.
- **`merge-test3/`** — the retest wave's artifacts: nested-shard discovery + loud-failure
  fixtures, the saarland/rheinland-pfalz clip-region ground-truth comparison (`dens.sql`,
  re-runnable), the client features:0 fixtures and `client-test.mjs`, the
  `--unlink-source` fixtures, and `verify-merge3.py` (304/304).
- **`audit-w2/{mi.tsv,de.tsv}`** — the raw `point,polygon` audit output.

`~/Projects` is one Syncthing folder (vibe ↔ kadro, no `.stignore`). Build outputs go to
`~/osm-builds/` on kadro, never inside the repo; deletes inside the repo propagate to
both machines.
