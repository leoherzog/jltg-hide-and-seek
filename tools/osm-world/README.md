# The OSM world files

The app used to ask the Overpass API for map features at run time. It now reads
prebuilt **FlatGeobuf** files from R2 with HTTP Range requests. This directory is the
build that produces them.

## Why FlatGeobuf and not the alternatives

FlatGeobuf carries a **packed Hilbert R-tree** in its header. The client reads the
index, learns which byte ranges hold the features intersecting its bbox, and fetches
only those. That is the entire architecture, and it is the property that makes a
multi-gigabyte planet file usable from a browser.

- **Geobuf** — protobuf-encoded GeoJSON — has *no spatial index*. Reading one park
  means downloading the whole file. It cannot do this job.
- **PMTiles** is the other real single-file/Range format, but it stores vector *tiles*:
  geometry is clipped at tile boundaries and tags are dropped. This app reads
  `opening_hours`, `access` and `cuisine` off individual features and computes
  area-weighted centroids, so tiles lose exactly what it needs.

## Dependencies

Two Python packages, not 723:

```
osmium   (pyosmium)   the density pass
boto3                 the R2 upload
```

`uv` reads the PEP 723 block at the top of `build.py` and builds the environment
itself — there is no requirements file and no virtualenv to activate.

Two external binaries, which are not pip-installable:

```
osmium     osmium-tool     dnf install osmium-tool
ogr2ogr    GDAL >= 3.5     dnf install gdal
```

Plus one of `aria2c`, `curl` or `wget`, needed only for the planet download. The
transfer is not done in Python: 94 GB wants resumption across a dropped connection, and
aria2c additionally wants eight connections at once — that is usually the difference
between two hours and eight.

GDAL 3.5 is a hard floor: it is where the FlatGeobuf writer began emitting the spatial
index by default. An unindexed file is still valid and still reads correctly — by
downloading all of it. That failure is silent, so `preflight` checks the version rather
than trusting it.

## Running a build

```sh
uv run tools/osm-world/build.py --out build/world
uv run tools/osm-world/build.py --out build/world --upload
```

With no `--planet`, **the planet file is downloaded automatically** to
`./planet-latest.osm.pbf`. Stage 0 checks free disk space first, tries the mirrors in
order, and verifies the `.md5` the mirror publishes.

**Every later run updates that file with replication diffs instead of re-downloading
it.** A week of edits is ~700 MB of daily diffs against a 94.3 GB re-fetch — about
135× less. `pyosmium-up-to-date` (which ships with pyosmium, already a dependency) reads
the PBF's own `osmosis_replication_timestamp`, works out which diffs are missing, and
applies them.

Two honest caveats. Applying diffs **rewrites the whole PBF**, so it saves bandwidth,
not wall-clock, and it transiently needs about double the planet in free disk — stage 0b
checks and skips rather than filling the volume. And because a newer planet invalidates
every cached intermediate, a successful update **forces every downstream stage to
rebuild**; otherwise stage 1's cached `interesting.osm.pbf` from last week would be
silently spliced onto this week's planet.

A torrent re-download is not an alternative here, and not for the obvious reason:
`planet-latest.osm.pbf.torrent` names a *dated* file (`planet-260727.osm.pbf`), so a
week later aria2c writes a second 94.3 GB file rather than updating the first. Even
forcing the name to match salvages almost nothing — a PBF is a run of independently
compressed blobs of ID-sorted entities, so a week of edits reflows the whole file and
essentially every 4 MiB piece hash changes.

For development, point it at a Geofabrik extract instead — the script does not care
which it was handed, and only downloads when the named file is absent:

```sh
uv run tools/osm-world/build.py --planet michigan-latest.osm.pbf --out build/world
```

| flag | effect |
| --- | --- |
| `--no-fetch` | missing planet is a hard error instead of a download (what CI with a pre-seeded cache wants) |
| `--no-update` | do not apply replication diffs to an existing planet |
| `--planet-url` | download from a specific URL instead of the built-in mirror list |
| `--skip-md5` | skip verification of a fresh download |
| `--only park,water` | build a subset of layers (`--only density` builds the grid alone) |
| `--skip-density` | skip the second planet pass |
| `--force` | rebuild stages whose output already exists |
| `--upload` / `--prefix` | publish to R2 under a prefix (default `world`) |

Every stage skips when its output exists, so an interrupted build resumes. Stage 4's
skip is additionally keyed on the `--clip-region` **state** (sha256 of the region
file, or `none`), recorded in a `density.clip-state` sidecar in the work dir — a
cached grid built under a different clip is rebuilt, not silently reused.

**Costs.** The planet is 94.3 GB (measured 2026-08-16; older notes in this repo say
87.6). Stage 1 makes one pass over it and everything after works on a ~4 GB
intermediate — skipping that consolidation and running 35 `tags-filter` passes over the
planet instead is roughly a day of I/O. Stage 4 makes a second full pass for the density
grid. Peak disk is ~180 GB including the planet.

In practice nobody builds the planet in one go — see §Sharding below. Two reference
builds, post-reduction and post-`advertising`-fix, on a 16-core/31 GB box:
**michigan-v3 4.4 min / 232,847,376 bytes** (density stage unchanged from the fix,
measured at 2.21 GB peak RSS on michigan-v2), **germany-v3 34.5 min / 3,343,969,105
bytes / 8.3 GB peak RSS**. Peak RSS is `stage_density`'s dict and nothing else; it
follows `≈ 1.29 GB + 1.53 kB × populated cells` and is what bounds a density shard's
size.

**Mirrors.** The OSM wiki lists 17 sites. `PLANET_MIRRORS` carries the 10 that were
verified reachable, spread across operators and continents; `--planet-url` overrides the
list entirely. The wiki no longer asks anyone to prefer a mirror over the origin — *"It
used to be necessary to download mirrors to conserve OSM bandwidth, but that is no longer
necessary"* — so the origin is tried first, as the freshest snapshot, and the rest are
failover.

**Mirrors lag each other, and that is a correctness problem, not a speed one.** When the
list was last checked, nine of ten reachable sites published md5 `3f79d450…` and osuosl
published `434349ae…`: a different nightly rebuild under the same filename. Two defences,
and both are needed:

- the checksum is fetched from whichever mirror actually served the bytes, never a fixed
  one;
- on failing over mid-transfer, the partial file is **discarded** rather than resumed
  against a different mirror.

Without the second, `--continue` would splice two nightlies into a plausible-looking PBF
that osmium parses for hours before failing somewhere in the middle.

## Upload and CORS

Credentials come from the environment, never a file in the repo:

```
R2_ACCOUNT_ID  R2_ACCESS_KEY_ID  R2_SECRET_ACCESS_KEY  R2_BUCKET
```

`--upload` checks all four are **set at preflight**, next to the GDAL version, rather
than in stage 6 where they are used: stage 6 runs last, so an unset variable used to
surface only once every layer was already built — a minute for a density shard, an hour
for a coarse feature shard like africa, and none of it survives, because CI's retry is a
full re-download and rebuild. Presence is all that can be proven cheaply; a variable that
is *set but wrong* — rotated secret, no write scope, typo'd bucket — is still only caught
when boto3 talks to the API. Proving that at preflight means a live `HeadBucket`, which
trades this failure mode for a worse one: a transient network blip killing a build that
was going to succeed.

The bucket must answer Range requests cross-origin **and expose the range headers** — a
browser that cannot read `Content-Range` cannot walk the index, and the failure looks
like a corrupt file rather than a CORS error. `build.py` writes `r2-cors.json`; apply it
with:

```sh
wrangler r2 bucket cors set <bucket> --file tools/osm-world/r2-cors.json
```

`.fgb` files are immutable per build and served `max-age=31536000, immutable`;
`manifest.json` is served `max-age=300` and is what flips a new build live.

## Where it is published

| | |
| --- | --- |
| bucket | `jltg-hide-and-seek` (R2) |
| public origin | `https://jltg.herzog.tech` — custom domain bound to the bucket |
| client constant | `DEFAULT_WORLD_BASE_URL` in `osm/worldfile.js`, `https://jltg.herzog.tech/world` |
| prefix | `world/` for the published world; `shards/{density,feature}/<id>/` for shard output |
| site | GitHub Pages, `https://leoherzog.github.io/jltg-hide-and-seek/` — so the browser origin CORS must admit is `https://leoherzog.github.io` |

The **repo is public**, and that is a build requirement rather than a preference: a
private-repo Actions runner is 2 vCPU / 8 GB RAM, a public one is 4 vCPU / 16 GB, and
the merge depends on public runners' disk. Measured on ours, 2026-08-22:
`cores: 4   ram: 15 GB`, **`disk: 86.2 GB free of 144.3 GB`** — against the 14 GB
GitHub documents. Every workflow prints that line as its first step, because the figure
is undocumented, has moved twice, and the merge sizing depends on it (`PLAN.md` §Phase 6).

**Credentials, verified against the live bucket** — the S3 key pair needs **Object Read
& Write**, nothing more and nothing less. Write covers `upload_file`, which becomes
`CreateMultipartUpload`/`UploadPart`/`CompleteMultipartUpload` once an object clears the
5 GB single-PUT ceiling — the density grid does. Read covers the merge pulling shards
back with `aws s3 sync` (`ListObjectsV2` + `GetObject`). Cloudflare has no write-only
tier, so Object Read & Write is the narrowest thing that works. Bucket creation and the
custom domain are one-time console actions needing Admin; **nothing in CI needs Admin**,
and browser reads are anonymous.

`wrangler` is a *separate* credential — a Cloudflare API token with `Workers R2
Storage: Edit`, not the S3 key pair — and it is what applies CORS and would apply a
lifecycle rule.

**The manifest uploads last, always.** It is the only mutable object and the only thing
that flips a build live, so every layer it names must be readable before it lands.
`sorted(out_dir.iterdir())` used to put `manifest.json` 22nd of 38 — ahead of `pitch`,
`platform`, `rail_station`, `restaurant`, `shop`, `water` and ten more — so for the
length of those uploads the published manifest pointed at objects that did not exist.

## What ships, and what does not

**Feature layers** (30) — real geometry, exact counts, usable for distance and
containment. One `.fgb` each. Plus five count-only layers — three `curse_*` for the
curse predicates whose selector deliberately differs from the same-named category, and
`green_recreation_ground` + `animal_delta`, which exist only to reconstruct a sixth
count as an identity (below). With the density grid, **36 layers in all**, which is
what a full build logs. The **37th layer of a published world** — `admin`, replacing
Overpass `is_in` — is not built here at all: it joins at merge time from the Overture
build (`merge.py --admin`, §below), because a per-extract OSM admin layer is broken by
construction and was discarded unread.

**The density grid** — `building`, `street`, `car_street`, `footpath`, `bridge`, `tree`.
These are tallies, not icons: nothing draws them, everything counts them, and their
planet-wide geometry is tens of gigabytes. They build into one sparse FlatGeobuf of
points, one per populated 0.002° (~220 m) cell, with an integer column per category.

> Map-wide totals from the grid are **exact** — the build attributes each feature to
> exactly one cell, so a bbox sum cannot double-count, and those totals are what every
> curse predicate and the street-density figure read. Per-zone figures are
> **approximate**: a cell counts wholly inside or wholly outside a zone circle depending
> on where its centre falls. `osm/geodata.js` marks every density category `partial` and
> pushes a note saying so.

`restaurant`, `cafe`, `fast_food` and `shop` were on the exclusion list in an earlier
draft and are back as real features on purpose. They are not dense at planet scale, and
`cuisineDetail` reads the `cuisine` tag off individual restaurants — a grid cell cannot
answer which country's cuisine is served inside it.

## The build table: `categories.json`

`geometry`, `dedup` and `count_only` decide what a layer weighs, and `runtime_columns`
decides what a feature carries. Together with the identity below they took michigan from
643,681,472 to 232,847,376 bytes (−63.8%) and germany from 9,004,762,856 to
3,343,969,105 (−62.9%) — no published number moved except the ones that were wrong, and
several were. (Those are the `advertising`-fix, `-v3` totals — see §Testing the reader
and `tools/osm-world/PLAN.md` for the intermediate `-v2` numbers this fix corrected.)

### `geometry` — the per-layer `osmium export --geometry-types`

**osmium exports a closed way once per requested type.** Asking every layer for
`point,linestring,polygon` therefore wrote every closed way *twice* — its polygon, plus
the same ring re-read as a zero-area linestring — inflating counts by up to 2× (germany
`green` 5,374,835 rows for 2,736,050 entities) and placing a *second POI at a different
coordinate*, because the polygon copy centroids and the linestring copy takes a polyline
midpoint. Three classes:

- **`point`** — the filter only admits nodes (`mountain`, `bench`).
- **`point,polygon`** — area tags. A closed way exports once, as its polygon; an
  **unclosed** way carrying an area tag is a mapping error and is dropped.
- **`point,linestring,polygon` + `dedup: true`** — genuinely mixed layers, where the
  linestring reading must survive: `water` (lakes are polygons, rivers are linestrings),
  `coastline`, `platform`, `high_speed_rail`, `advertising`, `green`.

`point,polygon` is a *claim about OSM tagging*, and getting it wrong loses features with
no error anywhere — so every layer in that class was measured on two extracts with
different mapping cultures, counting distinct entities that export as a linestring and
never as a polygon. Sixteen layers lose exactly zero on both; a handful lose one or two
inspectable mapping errors. **`advertising` was the one real miss** — 56 of 772 in
michigan (7.3%), 816 of 35,816 in germany (2.3%) — because a billboard *face* is
legitimately a short open way, and it is now in the mixed class. The full audit table
and the reasoning for every kept decision live in `categories.json`'s header comment;
`test-update.py` pins the mixed layers so the decision cannot be silently reverted.

`green` is mixed for an exactness reason rather than a tagging one — see the identity
below.

### `count_only` — layers the client never reads a byte of

The curse loop calls `worldCount`, which walks the R-tree and reads **zero feature
bytes**. Those layers ship as **2-point bbox-diagonal linestrings with no properties**:
a diagonal from `(minX, minY)` to `(maxX, maxY)` has exactly the original envelope, so
every R-tree node bbox and every `search` result is bit-identical, and the client needs
no change. `diagonalize_layer` also owns their `(osm_type, osm_id)` dedup. It costs
86–92% of their bytes: germany's `curse_water` went 481,384,488 → 64,066,912.

The trade is real and worth stating: this forecloses ever *drawing* a curse feature.

`admin` is the opposite case — containment is the entire question, so its rings must
be kept whole — and that is exactly why it has **no entry in this table**: whole rings
only exist when the relation fits entirely inside the extract, which no shard
guarantees. The shipped admin layer comes from Overture at merge time (§below);
`_admin_comment` in `categories.json` records the removal and its measured cost
(16.5% of pooled feature-shard output built, indexed, uploaded and discarded).

### The `curse_animal_habitat` identity

That layer was 45% a copy of `green` — 2.97 GB on germany, the single largest layer in
the build — so it is **deleted**, and its count is reconstructed client-side:

    count(curse_animal_habitat)
      == count(green) − count(green_recreation_ground) + count(animal_delta)

`landuse` is single-valued, so `green` minus its `recreation_ground` members is exactly
the old selector's landuse line, and `animal_delta` is exactly its other two lines with
the landuse members removed. Nothing is counted twice and nothing is missed. Both new
terms are count-only diagonals over unchanged envelopes, so the identity holds for every
bbox the R-tree is asked about, and it is verified exactly on michigan:
**61,160 − 790 + 17,426 = 77,796**. The two replacement layers cost 12.2 MB on germany.

This is why `green` is in the mixed geometry class: it is a term of the identity, which
holds feature-for-feature only if every term counts each OSM object exactly once.

`CURSE_ANIMAL_HABITAT_TERMS` in `osm/geodata.js` is the consumer. An absent non-base
term counts as 0 (the build legitimately omits a layer whose selector matched nothing);
an absent `green` refuses, because that is a broken build rather than an empty one.

**"Absent" has to mean something precise, because the manifest can express a layer being
present-but-empty two different ways.** A full build that finds zero features for a
layer still lists it, with a path, e.g. `"coastline": {"path": "...", "features": 0}` —
`osm/worldfile.js` constructs a reader and reads the (empty) file. `merge.py`'s own
empty-layer output has no path at all — `"amusement_park": {"features": 0}` — and
`worldfile.js` treats that as a third, distinct state: genuinely empty, `worldCount`
returns `0`, `worldPois` returns `[]`, but **no reader is ever constructed and no HTTP
request is ever issued** for it. Before this was handled, a path-less entry produced a
request to `<base>/undefined`, which aborted the curse-predicate loop. True absence (no
manifest entry at all) is unchanged: `null`, category degrades. (`merge.py` never
emits the path-less shape for the **density** layer — the client would trust it as a
real zero and silently lift the density-based curses, so a merge with zero density
contributions hard-errors or, with `--allow-missing-density`, omits density entirely;
see §Sharding.)

The `"partial": true` top-level flag (below) changes what absence *means* to
`curseLayerCount`: on a full manifest, an absent non-base term is legitimately built-empty
and counts as 0 with an info log, as above; on a `partial: true` manifest — a
`--only`/`--skip-density` shard build, where the layer table was never meant to be
complete — the same absence means "not built," and the predicate refuses with a warn log
instead of silently treating it as zero.

### `runtime_columns` — what actually ships on a feature

`include_tags` pins 35 columns so the GeoJSONSeq has a stable schema. The client reads
**12 of them** at runtime, plus `osm_type`/`osm_id`; the other 23 exist only so a `where`
clause can see them, and `ogr2ogr -select` projects them away per layer — intersected
with the columns that layer's features actually carry, because `-select` hard-fails on a
missing field. `osm_type`/`osm_id` are never stripped even on layers that never read
them: they are the shard merge's dedup key.

A related trap, since `where` and `-select` face the same sparse-schema problem: a
`where` naming a column absent from the export **does not abort**. `build.py` passes
`-skipfailures`, and GDAL 3.12 with it prints `ERROR 1: SetAttributeFilter(…) failed`,
exits 0, and copies every feature through **unfiltered** — a layer that builds, lands in
the manifest, and has silently wrong counts. `rewrite_where()` constant-folds every
predicate over an absent column (absent ⇒ NULL for every feature, so the predicate has a
known constant value), returning rewritten SQL, `""` for unconditionally-true, or `None`
for can-never-match — the last of which omits the layer from the manifest, the same state
an empty layer already produces. A prefix `NOT` over a missing column raises instead of
folding: that is the one place SQL's UNKNOWN stops behaving like FALSE.

## The admin layer comes from Overture, not OSM

An administrative area only assembles into a polygon when its relation fits **entirely
inside the extract**. That makes per-shard admin impossible by construction — a Michigan
extract yields 73 level-2 features, all zero-area linestrings and no USA polygon — so
admin left the shard pipeline entirely. Overture's `division_area` ships
**already-assembled** polygons, is OSM-derived, and is ODbL like the rest.

```sh
OUT=~/osm-builds/admin-2026-07-22 tools/osm-world/build-admin.sh
node tools/osm-world/probe-admin.mjs ~/osm-builds/admin-2026-07-22/admin.fgb
```

| env | default | |
| --- | --- | --- |
| `OUT` | — | required; fails loudly if unset |
| `REL` | `2026-07-22.0` | Overture release; **pin it** |
| `SIMPLIFY` | `0.0001` | empty or `0` = full precision |
| `BBOX` | — | `minLon,minLat,maxLon,maxLat`, for a smoke run |
| `MEMORY_LIMIT` | `16GB` | DuckDB; 8 GB works by spilling to `$OUT/duckdb-tmp` |
| `SRC`, `THREADS`, `KEEP_PARQUET` | | local parquet glob (skips the release check), thread cap, keep the intermediate |

It writes `admin.sql` (the generated, readable DuckDB script), `admin.parquet`,
`admin.fgb` and an `admin.fgb.sha256` sidecar in `sha256sum -c` format. Release
2026-07-22.0 is 1,073,093 source rows / 4.47 GB, and comes out as **984,219 features —
2,292,533,384 bytes simplified** (the shipped variant, 6.3 GB peak RSS, ~67 s on 16
cores) or 6,038,396,104 bytes at full precision. Budget ~10 GB of scratch.

Three things about the schema are load-bearing:

- **Overture's own `admin_level` is unusable.** It is a per-country *depth* (country = 0)
  and NULL below county. `subtype` is the rank and is always populated, so the build maps
  it: country 2, dependency 3, region 4, county 6, localadmin 7, locality 8, macrohood 9,
  neighborhood 10. `microhood` is dropped.
- **`class='land'`** — the `maritime` rows are EEZ and territorial-water polygons.
- **ISO3166-1 only on country/dependency, ISO3166-2 only on region.** Overture fills
  `country` on every descendant row, and copying it down would make `worldAdminAreas`
  read a county as a country.

Because that ladder is synthetic, the manifest carries **`admin_source`**: absent or
`"osm"` keeps the existing OSM behaviour byte-identically, `"overture"` selects
`OVERTURE_ADMIN_ORDINAL_OVERRIDES` in `osm/geodata.js`. It is also what lets the page
render the required attribution — *"© OpenStreetMap contributors, ODbL 1.0 — via
Overture Maps Foundation"* — without guessing.

`probe-admin.mjs` drives the **real** `openWorld`/`worldAdminAreas` through a strict
file-backed Range implementation (206 only, real `Content-Range`, throws if no Range
header was sent), so it tests the client and the file together. Exit 0/1/2;
`PROBE_VERBOSE=1` dumps every area with ring and hole counts; `WORLDFILE=` points it at
the reader when it is run outside the repo. Its ground truths are the cases that break:
Grand Rapids resolving to `US | Michigan US-MI | Kent County | Grand Rapids` while a
neighbouring bbox must *not* pull Canada; Basel returning CH+DE+FR with each district
rejecting the other two countries; **St Peter's returning VA and never IT**, which only
works if enclaves are carried as interior rings and the client subtracts holes; and
Baarle resolving BE and NL at two points 100 m apart. 39/39 pass against the shipped
file in 184 range requests / 19.01 MB. A Michigan-only file fails 20 of them, so the
failure path is real.

Overture prunes releases — at time of writing only `2026-06-17.0` and `2026-07-22.0`
still exist on S3 — so `build-admin.sh` checks the live listing and dies printing the
survivors when the pinned `REL` has aged out.

## Sharding, and putting the shards back together

The planet cannot be built as a monolith: `stage_density` holds every populated cell in
a Python dict at `peak RSS ≈ 1.29 GB + 1.53 kB × cells`, which brackets the planet at
139–301 GB of RAM. The build shards; **the client does not** — it still sees one world at
one base URL.

```sh
uv run tools/osm-world/cover.py [--cap-gb 8] [--no-sizes]
uv run tools/osm-world/merge.py --shards <dir of per-shard build dirs> \
                                --admin <admin.fgb> --out <dir> [--no-assert]
```

`cover.py` downloads Geofabrik's `index-v1.json` and writes **`shards.json`**, which is
the interface CI reads: `{generated_from, coarse[], fine[]}`, each entry
`{id, pbf_url, md5_url, est_bytes}`, each `fine` entry additionally
`disjoint_neighbors` (diagnostic — which shards can share a boundary density cell). It
also writes **`cover-geometries/`**: one GeoJSON per fine shard holding its assigned
disjoint polygon (filename = id with `/` → `__`). Both are committed, from the same
run — and both are **written last, adjacent, after every network request** (the index
fetch and the per-region size HEADs), so an interrupted run cannot leave one updated
without the other. Two partitions, because the two stage groups have opposite
constraints:

- **fine — 514 members, 114.2 GB** (largest africa 7.90 GB), for density alone, which
  is linear in RAM. Membership is one greedy pass in the *difference order* (ascending
  polygon area, ties by id), and the rule is two clauses: **a region is a member when
  its residual — itself minus the members already kept — still covers LAND, and its
  extract is small enough to build.** Land is vendored Natural Earth 1:50m
  (`land-50m.geojson`); the mask decides membership only, while a member's assigned
  clip stays the full-precision Geofabrik residual, so nothing near a coastline is
  lost. The array ships in that order so a consumer can rebuild the assigned disjoint
  geometries: Geofabrik's polygons overlap by design, and density's exactness rule —
  each way attributed to exactly one cell via its first node — survives sharding only
  if each shard counts the ways whose first node falls in its assigned **disjoint**
  region. That is enforced at build time: `build-shard.sh` passes the shard's
  `cover-geometries/` file to **`build.py --clip-region`**, and stage 4 bins a way
  only when its first node (a tree node: its own location) tests inside the polygon.
  Without the clip, both neighbours count every way in the overlap buffers and the
  merged grid double-counts. **Measured overhead** on michigan: the density pass goes
  77 s → 87 s (+13%, ~2.5 µs/candidate), peak RSS unchanged, 0.19% of candidates
  dropped as buffer overlap; German sub-tiles drop proportionally more (a state-level
  extract's buffer is a bigger share of a smaller polygon) — saarland +8 s on a 23 s
  pass (0.121% dropped), rheinland-pfalz +17% on a 94 s pass (1.238% dropped). **The
  fix is verified against ground truth**: a clipped merge of two adjacent German
  states matches a whole-Germany reference density build exactly (0 differing cells
  across 335,516 compared cells); the unclipped merge is detectably wrong, inflating
  the shared boundary band by up to +27.7% per category (`tools/osm-world/PLAN.md`
  §Phase 3 retest has the full comparison).
- **coarse — 87 regions, each ≤ 8 GB, 82.2 GB**, for the feature layers, which run flat
  at ~2.4 GB RSS and are bounded by runner disk instead. It is derived from the fine
  members' containers.

**Three membership rules were tried here, and the first two shipped covers with holes
in them** — worth recording, because each looked obviously right at the time.

1. *"A region that contains no other region."* Drops every region containing an
   **enclave** and takes its non-enclave territory along: `greater-london` went to
   `enfield`, `niedersachsen` to `bremen`, `ukraine` to `crimean-fed-district`,
   `morocco` to `ceuta`/`melilla`, and eight more. London, Hanover, Marseille,
   Casablanca, Guangzhou, Sydney, Kyiv and Lviv were in **no density shard**, and
   Ukraine had no feature shard either.
2. *"A region at least 70% uncovered."* Then drops one that is 62.9% uncovered:
   `central-america`, taking Trinidad, Barbados, Grenada, St Lucia, Curaçao, Aruba,
   Cayman and the BVI; and `italy` at 7.0%, taking San Marino.

Both asked about **area** when the question is about **territory**, so both needed a
threshold, and a threshold on the wrong quantity always has a wrong side. Asking about
land needs no threshold beyond "is there any", and it makes the guarantee assertable:
`cover.py` **refuses to write a cover that leaves land to no shard**.

Two details of the land test are measured rather than chosen. Natural Earth's
coastlines and Geofabrik's cutting polygons disagree by metres, so every residual
picks up a fringe of thin slivers — `england`'s is **473 pieces** totalling 0.0127 deg²,
none of them a place — and eroding by ~550 m deletes anything narrower while leaving a
real place intact (San Marino is one piece of 0.0053 deg² and survives at 0.0038). And
the 8 GB cap is a **disk** bound, not a memory one: a clipped shard's RSS scales with
cells inside the clip, so a large extract clipped to a sliver is cheap in memory, but a
density shard cannot use `--unlink-source` (stage 4 reads the raw extract). Sized off
`quebec` at 1.5 GB instead, San Marino, Saint-Pierre-et-Miquelon, South Georgia and
Kerguelen all fell out, because the only extract reaching each is a country file.

**Two consequences to know.** Micro-territories below the mask's resolution — `monaco`,
`macau`, `tokelau`, `cocos-islands`, `norfolk-island`, `ile-de-clipperton`,
`ashmore-cartier` — do not get their own shard; their land is covered by the parent
that contains them (Monaco by `provence-alpes-cote-d-azur`, Macau by `guangdong`,
Gibraltar by `andalucia`, the Vatican by `centro`), which costs a larger parent extract
and is **not** a coverage gap. And exactly one piece of land is genuinely uncovered:
**Diego Garcia** (0.0108 deg², Chagos), whose only source is `asia` at 16.18 GB — twice
what a runner can hold. Regenerating therefore needs `--allow-uncovered-land`, and the
expected residue is that one piece:

```sh
uv run tools/osm-world/cover.py --allow-uncovered-land
```

If a run reports anything else, investigate before committing it.

Note `index-v1.json`'s `parent` field is a *display* hierarchy, not a tree — `us`,
`us-midwest` and `us/michigan` are siblings — so the cover is computed geometrically.
Uncovered area is logged rather than assumed: the coarse cover's 4,175 deg² gap is
entirely open ocean — the eight largest pieces are the Indian Ocean, the North Atlantic,
the Pacific off Mexico, the Arctic north of Alaska, and four more of the same, and no
populated place falls in it. (It was 4,251 deg² and that claim was *false* before the
membership fix above: Ukraine was sitting in the gap.)

`merge.py` discovers shard builds **recursively** (an R2 sync nests `us/michigan/` a
level deeper than a flat scan looks; a directory with `.fgb` files but no
`manifest.json` — a failed build's leavings — is a hard error listing the offenders
unless `--allow-incomplete`). `--shards` itself is a candidate first, so a
`manifest.json` at the root is a single-shard merge and stray root `.fgb` files hit
the same hard error. Symlinked directories are **followed** — a merge tree may be
assembled from links to out-of-tree builds instead of copying gigabytes — guarded by
a visited-realpath set: a symlink cycle or duplicate route over a non-shard
directory is skipped with a log line, and a **shard** reached twice is a hard error
naming both paths (a shard merged twice double-counts density additively; a symlink
loop once yielded 41 discoveries of one shard before this guard existed). The guard
resolves symlinks only — two bind-mounted views of one directory are NOT detected,
so don't build merge trees out of bind mounts. Per layer it
does: VRT with `FieldStrategy=Union` →
GPKG → `DELETE` keeping
`MIN(fid)` over shard dirs in sorted relative-path order → FGB with a spatial index.
Two details are not incidental:

- **The schema union is mandatory.** A shard whose extract contains no feature carrying
  `cuisine` writes no such column, and a naive `-append` would drop that column for those
  rows without a word.
- **It asserts `rows == distinct(osm_type, osm_id)` per shard before merging anything**
  (`--no-assert` overrides). Dedup at merge time would otherwise have *masked* the
  double-emit bug non-deterministically — a bug a later stage silently cleans up is a bug
  nobody finds.

`count_only` layers carry no property columns, so they dedup on exact geometry bytes.
Density is summed by `(row, col)` through an external sort that reproduces
`stage_density`'s exact output shape. Admin is brought in from `--admin` and stamps
`admin_source: "overture"`.

The global manifest is the per-build manifest plus: explicit **`features: 0`** for
legitimately-empty FEATURE layers rather than omission (michigan really has no
`coastline`, and a
failed job must not look like that), `planet_timestamp` from the **oldest** contributing
shard, an optional per-layer `bbox`, and **content-addressed layer filenames**
(`layer.<sha256-12>.fgb`). **Density never gets a `features: 0` entry**: the client
trusts a present-but-empty density grid as a real zero (which would auto-lift the
density-based curses — Bridge Troll, Luxury Car, Right Turn), and zero density cells
for a real region is an operational failure (a forgotten or mis-pathed density sync),
never true emptiness — so a merge in which no shard contributes any density cells is a
**hard error**, and `--allow-missing-density` publishes with density **omitted from
the manifest entirely** (absent ⇒ the client degrades and the curses warn, the safe
direction). Any `build.py`/`merge.py` run whose manifest lacks the full
layer table because of `--only`/`--skip-density` selection (or the density omission
above) stamps top-level
**`"partial": true`** (the pinned client rule — a shard build must never be mistaken
for a whole world), and a `merge.py --only` run merges into an existing
`manifest.json` instead of clobbering the layers it did not touch, clearing `partial`
once the table is complete. On such a merge-into run the existing manifest also sets
three invariants: manifest keys the current layer table no longer contains are
**dropped, loudly** (a removed layer would otherwise be carried forward forever),
`planet_timestamp` stays the **oldest** of the existing manifest's value and this
run's shards (the untouched layers still date from the old run), and a `cell_deg`
differing from the existing manifest's is a hard error — a world cannot mix grid
resolutions. That merge-into behaviour is earned: two michigan builds on different core
counts, kernels and filesystems are byte-identical, and a re-run of the merge is
byte-identical too — so an unchanged layer keeps its URL across rebuilds and browser and
CDN caches stay warm. `manifest.json` is the only mutable object.

**`partial` does not propagate through the merge** — a per-shard build made with
`--only`/`--skip-density` stamps `partial: true` on that *shard's* manifest (every
density-only shard does, since density-only selection is exactly what `--only density`
means), but `merge.py` deliberately ignores the shard-level flag and computes the
merged manifest's `partial` from the merged layer table alone: a full merge of
partial shards still comes out with all 37 keys and no `partial` flag.

A three-shard merge (bremen + hamburg + berlin + global admin) produces 37 layers /
2.36 GB in half a minute and passes 304 verification checks; the real client reader opens
the result, Overture admin and all. **A later retest re-verified all of this on real
inputs**: recursive discovery through a three-level-deep R2-sync-shaped tree, the loud
incomplete-shard failure and its `--allow-incomplete` escape (confirmed to write nothing
to `--out` on failure), a real `--only park` run merging into an existing 37-layer
manifest (`--only: merged 1 layer entr(y|ies) into the existing manifest's 37`, byte-
identical manifest, no spurious `partial`), and `--unlink-source` refusing instantly
whenever density would run and correctly deleting a real 21 MB extract mid-build
otherwise, with byte-identical outputs to a control run. See `tools/osm-world/PLAN.md`
§Phase 3 retest for the full detail.

## CI

Three workflows, and **`world-canary.yml` is meant to be dispatched by hand first** — it
needs no secrets, builds one ~1 GB coarse shard through the full pipeline, and reports
wall, RSS, CPU and disk high-water into the step summary. Nothing about the other two
files' timeouts should be trusted until it has run.

| workflow | shards | matrix | timeout | R2 prefix |
| --- | --- | --- | ---: | --- |
| `world-density-shards.yml` | fine (514) | batch ≤5 / ≤2 GB → 113 jobs | 350 min | `shards/density/<id>/` |
| `world-feature-shards.yml` | coarse (87) | batch 1 → 87 jobs | 240 min | `shards/feature/<id>/` |

Both are monthly plus `workflow_dispatch`, `max-parallel` 20, `fail-fast: false`, and
both fail loudly rather than quietly skipping when `shards.json` is missing or the
`R2_*` secrets are unset. **Those secrets do not exist yet**, so the `schedule:` trigger
will fail every month until a token with R2 write is minted — disable `schedule:` and
keep `workflow_dispatch` until then.

`tools/osm-world/ci/chunk-shards.py` batches `shards.json` into the matrix. A batch
closes on whichever cap is hit first — shard count (`--batch-size`) or accumulated
`est_bytes` (`--max-batch-bytes`, used by the density workflow because the
single-threaded density pass makes a batch's wall clock track its bytes; a shard
alone over the byte cap still gets its own job) — and the script fails cleanly if a
future cover run would exceed the 256-job cap (the fix is a larger cap, not a code
change). `tools/osm-world/ci/build-shard.sh` downloads a shard and
**compares md5 hashes by hand** — never `md5sum -c`, whose filename field rejects the
dated file Geofabrik's sidecar redirects to — then calls `build.py … --upload --prefix`,
adding `--clip-region cover-geometries/<id>.geojson` for density builds (hard error if
the geometry file is missing, **resolved before the download** so a bad `--id` costs no
transfer — up to 1.16 GB for quebec) and `--unlink-source` for feature builds (deletes the
raw extract once stage 1's intermediate exists — what keeps africa's 7.90 GB under runner
disk; build.py refuses the flag when density would run, since stage 4 reads the raw
extract). Retries wrap the whole per-shard call and are a full re-download + rebuild,
not a resume — build-shard.sh clears its work dir and passes `--force` — which is fine
for the transient failures they exist for.

**A failed shard says why.** `/usr/bin/time -v` writes its resource report to its own
stderr, which is the same fd as the child's, so capturing it with `2> time.log` swallowed
build.py's stderr too — and that file was only printed after a *successful* build, which
`set -e` never reaches on failure. The report goes to `-o time.log` instead, leaving
build.py's stderr on the job log live and in order; an `EXIT` trap prints the report on a
non-zero exit, because peak RSS and wall clock are how an OOM kill is told apart from a
bug, and an OOM-killed process writes no stderr at all.

**The merge is not in CI *yet*, and the reason has changed.** GDAL's FlatGeobuf writer
keeps a hidden unlinked temp file *in the output directory* and ignores `CPL_TMPDIR`, so
transient disk is double the final layer size. RAM is not the problem — the writer
measures at ≈ 166 MB + 100 B/feature, verified to 87M features / 46 GB — disk is. On a
workstation that is inconvenient; on a runner it decides the design. A 14-agent
investigation (`PLAN.md` §Phase 6) concluded the merge **does** fit on a public runner as
a **per-layer matrix** rather than one serial job, provided the density grid is merged in
row bands — that single job fails on RAM, ~13.3–21.6 GB against 16 GB, and on the 6-hour
cap at a measured 11,588 cells/s. `green`, long assumed to be the blocker, merges in
~1.7 h at ~22.4 GB (not the 34–50 GB a one-country extrapolation suggested).

**Two guards exist because a merge failure is otherwise silent.** `write_union_vrt`
checks every shard input actually exists before writing the VRT — `inputs` is built from
what each shard's manifest *claims*, so a file an interrupted `aws s3 sync` never fetched
resolves to an empty VRT sub-layer, contributes nothing, and publishes a layer short by
exactly one shard, with no error and a manifest identical in shape to a good one. And a
merge in which no shard contributes density is a hard error, because the client trusts an
empty grid as a real zero and lifts three curses on the strength of it.

## What this loses

One thing, and it is stated on the page rather than papered over: the rulebook's
**"within 10 ft of a routable path"** refinement. It worked as a server-side spatial
join — buffer every walkable way by 5 m, intersect with candidate spots, return ids —
and there is no local equivalent short of shipping the global footpath network, which is
the densest layer in OSM and precisely what the density grid exists to avoid.

It was already the exception: the budget was 40,000 walkable ways and the reference map
alone has 84,466, so the join was skipped on essentially every real map, and when it was
attempted it timed out on all three mirrors twice. Every candidate spot is now marked
verify-on-the-ground unconditionally.

Counts are also now **as of a planet snapshot** rather than as of minutes ago. The
manifest carries `planet_timestamp`, read from the PBF's own replication header, and it
reaches every provenance row.

## Testing the reader

`osm/flatgeobuf.js` is a hand-written reader for a binary format — FlatBuffers vtable
arithmetic, an R-tree walk, a packed property blob whose field widths come from the
header. That is code that is either exactly right or silently returns plausible garbage,
so it is checked against a file GDAL wrote. Four suites, and all four must be green
before anything ships:

```sh
uv run tools/osm-world/make-fixture.py /tmp/f.fgb
node tools/osm-world/test-reader.mjs /tmp/f.fgb          # 45 assertions

uv run tools/osm-world/make-test-world.py /tmp/world
node tools/osm-world/test-pipeline.mjs /tmp/world        # 83, collectGeodata end to end

uv run tools/osm-world/test-update.py                    # build.py internals
node tools/smoke.mjs                                     # 19/19 golden numbers
```

`make-test-world.py` builds **four** of its layers — `pitch`, `coastline`,
`curse_cairn_terrain`, `animal_delta` — through `build.py`'s real pipeline from an OSM
XML fixture generated from the same WKT the hand-written layers use, so the two cannot
drift. `animal_delta`'s cut deliberately carries no `landuse` column, which is exactly
the absent-column `where` case, and the fixture carries a **detector** feature (an
unnamed `natural=water` way) that only an unapplied filter would let through — without
it the four real features all satisfy the clause and the test would pass either way.
The suite also pins `pitch.fgb`'s header columns to exactly
`["osm_type","osm_id","name"]`, so a re-added build-only column fails loudly rather than
costing bytes on every feature on the planet, covers both legal empty-layer manifest
shapes — a path-less `mountain` entry (`merge.py`'s shape, above) alongside a
with-file empty `foreign_consulate` — and covers the legacy-manifest path where
an old `curse_animal_habitat` layer is present and must be read directly instead of
through the identity.

`test-update.py` runs three sections and reaches the parts of `build.py` no other harness
can: the stage 0b replication-diff loop, the `where` rewriter (fold cases from the real
table, plus the invariant that all 42 clauses in the build table round-trip
byte-identical, plus the prefix-`NOT` refusal), and the geometry classes (the mixed +
dedup layers are pinned so the `advertising` decision cannot be silently reverted).

The diff loop is worth its own harness: it replaces `pyosmium-up-to-date` with a stub
whose exit codes are scripted, because the case worth testing is not the updater but the
loop around it. That tool's exit status is ambiguous by design — `1` means both "stopped
at the `--size` limit, more to do" and "could not resolve", and the code alone cannot
distinguish them. Retrying blindly would re-download a gigabyte of diffs on each of 24
passes, so the loop watches the file's replication timestamp and stops as soon as a pass
fails to advance it.

The reader fixture covers every geometry shape the reader branches on — including a polygon
with a hole and a multipolygon, the cases a flattened ring list silently gets wrong —
plus 2,000 filler features, so that the R-tree has four levels and the file is
comfortably larger than the reader's 16 kB header probe. Without that second property
the "did it actually use Range requests" assertion cannot fail.

Two real bugs were caught this way and both were silent: the R-tree descent started at
the last node instead of the root, and `nodeCount` returned the root level's end (1)
instead of the leaf level's (74), which put `dataStart` 2,920 bytes inside the index.
