# The OSM world files

The app reads prebuilt **FlatGeobuf** files from R2 with HTTP Range requests instead of
asking the Overpass API at run time. This directory is the build that produces them.

## Why FlatGeobuf and not the alternatives

| format | spatial index | whole geometry + tags | Range-readable | verdict |
| --- | --- | --- | --- | --- |
| **FlatGeobuf** | packed Hilbert R-tree in the header | yes | yes | chosen |
| Geobuf (protobuf-encoded GeoJSON) | none: reading one park downloads the whole file | yes | no | rejected |
| PMTiles | per vector tile | no: clipped at tile boundaries, tags dropped | yes | rejected |

The client reads the index, learns which byte ranges hold the features intersecting its
bbox, and fetches only those. That is what makes a multi-gigabyte planet file usable from
a browser. Tiles are out because this app reads `opening_hours`, `access` and `cuisine`
off individual features and computes area-weighted centroids.

## Dependencies

| dependency | install | needed for | note |
| --- | --- | --- | --- |
| `osmium` (pyosmium) | `uv`, from the PEP 723 block in `build.py` | the density pass, the transit relation assembly | no requirements file, no virtualenv to activate |
| `boto3` | `uv`, same block | the R2 upload | |
| `osmium` (osmium-tool) | `dnf install osmium-tool` | `tags-filter`, `export` | not pip-installable |
| `ogr2ogr` (GDAL >= 3.5) | `dnf install gdal` | writing FlatGeobuf | not pip-installable; floor below |
| one of `aria2c`, `curl`, `wget` | system | the planet download only | resumable; aria2c's eight parallel connections are usually two hours instead of eight |

The transfer is not done in Python because 94 GB wants resumption across a dropped
connection.

> [!WARNING]
> GDAL 3.5 is a hard floor: it is where the FlatGeobuf writer began emitting the spatial
> index by default. An unindexed file is still valid and still reads correctly, by
> downloading all of it. That failure is silent, so `preflight` checks the version.

## Running a build

```sh
uv run tools/osm-world/build.py --out build/world
uv run tools/osm-world/build.py --out build/world --upload
```

With no `--planet`, **the planet file is downloaded automatically** to
`./planet-latest.osm.pbf`. **Every later run updates that file with replication diffs
instead of re-downloading it**: a week of edits is ~700 MB of daily diffs against a
94.3 GB re-fetch.

For development, point it at a Geofabrik extract instead. The script only downloads when
the named file is absent:

```sh
uv run tools/osm-world/build.py --planet michigan-latest.osm.pbf --out build/world
```

| flag | effect |
| --- | --- |
| `--no-fetch` | missing planet is a hard error instead of a download (what CI with a pre-seeded cache wants) |
| `--no-update` | do not apply replication diffs to an existing planet |
| `--planet-url` | download from a specific URL instead of the built-in mirror list |
| `--skip-md5` | skip verification of a fresh download |
| `--only park,water` | build a subset of layers (`--only density` builds the grid alone, and skips stage 1 outright) |
| `--skip-density` | skip the second planet pass |
| `--force` | rebuild stages whose output already exists |
| `--upload` / `--prefix` | publish to R2 under a prefix (default `world`) |

### Stages

Every stage skips when its output exists, so an interrupted build resumes.

| stage | does | skips when | note |
| --- | --- | --- | --- |
| 0 | download the planet: checks free disk, tries the mirrors in order, verifies the mirror's `.md5` | the named file exists | checksum comes from the mirror that served the bytes |
| 0b | `pyosmium-up-to-date` (ships with pyosmium) reads the PBF's `osmosis_replication_timestamp` and applies the missing diffs | `--no-update`, a fresh download, or under ~2× the planet in free disk | rewrites the whole PBF: saves bandwidth, not wall-clock |
| 1 | one `tags-filter` pass → ~4 GB `interesting.osm.pbf` | output exists, or the selection leaves no feature layer | 35 `tags-filter` passes over the planet instead is roughly a day of I/O |
| 2 | per-layer `osmium export`, geometry dedup, count-only diagonals | output exists | |
| 3 | `ogr2ogr` → indexed `.fgb`, `where` folded | output exists | a layer left with no features, or whose `where` folds to `None`, is omitted from the manifest |
| 4 | second full planet pass for the density grid | output exists **and** `density.clip-state` matches | reads the raw extract; peak RSS lives here |
| 5 | manifest | | |
| 6 | R2 upload, with `--upload` | | manifest last |

- **A successful 0b update forces every downstream stage to rebuild.** A newer planet
  invalidates every cached intermediate; otherwise stage 1's cached `interesting.osm.pbf`
  from last week would be silently spliced onto this week's planet.
- **Stage 4's skip is keyed on the `--clip-region` state**: sha256 of the region file, or
  `none`, recorded in a `density.clip-state` sidecar in the work dir. A cached grid built
  under a different clip is rebuilt, not silently reused.
- **Stage 1 is skipped entirely when the selection leaves no feature layer** (`--only
  density`, which is every CI density shard). The per-layer loop is its only reader.
  Density reads the raw extract in stage 4 and is unaffected.

<details>
<summary>Why not re-download by torrent</summary>

`planet-latest.osm.pbf.torrent` names a *dated* file (`planet-260727.osm.pbf`), so a week
later aria2c writes a second 94.3 GB file rather than updating the first. Forcing the name
to match salvages almost nothing: a PBF is a run of independently compressed blobs of
ID-sorted entities, so a week of edits reflows the whole file and essentially every 4 MiB
piece hash changes.

</details>

### Costs

Planet 94.3 GB (measured 2026-08-16) · intermediate ~4 GB · peak
disk ~180 GB including the planet · peak RSS `≈ 1.29 GB + 1.53 kB × populated cells`.

| reference build (16-core/31 GB box) | wall clock | bytes | peak RSS |
| --- | ---: | ---: | ---: |
| michigan-v3 | 4.4 min | 232,847,376 | 2.21 GB (measured on michigan-v2) |
| germany-v3 | 34.5 min | 3,343,969,105 | 8.3 GB |

Peak RSS is `stage_density`'s dict and nothing else, and it is what bounds a density
shard's size. In practice nobody builds the planet in one go; see
[Sharding](#sharding-and-putting-the-shards-back-together).

### Mirrors

17 listed on the OSM wiki · 10 verified reachable in `PLANET_MIRRORS`, spread across
operators and continents · `--planet-url` overrides the list entirely.

The wiki does not ask anyone to prefer a mirror over the origin, so the origin is tried
first as the freshest snapshot and the rest are failover.

> [!WARNING]
> Mirrors lag each other, and that is a correctness problem. When the list was last
> checked, nine of ten reachable sites published md5 `3f79d450…` and osuosl published
> `434349ae…`: a different nightly rebuild under the same filename.

Two defences, both needed:

- the checksum is fetched from whichever mirror actually served the bytes, never a fixed
  one;
- on failing over mid-transfer, the partial file is **discarded** rather than resumed
  against a different mirror. Without this, `--continue` would splice two nightlies into
  a plausible-looking PBF that osmium parses for hours before failing.

## Upload and CORS

Credentials come from the environment, never a file in the repo:

```
R2_ACCOUNT_ID  R2_ACCESS_KEY_ID  R2_SECRET_ACCESS_KEY  R2_BUCKET
```

`--upload` checks all four are **set at preflight**, next to the GDAL version. Whether
they are *correct* is caught only when boto3 first talks to the API.

<details>
<summary>Why presence at preflight, and only presence</summary>

The variables are used in stage 6, which runs last, so an unset one would otherwise
surface only after every layer was built: an hour for a coarse feature shard like africa,
and CI's retry is a full re-download and rebuild. Proving a value correct at preflight
means a live `HeadBucket`, and a transient network blip would then kill a build that was
going to succeed.

</details>

> [!WARNING]
> The bucket must answer Range requests cross-origin **and expose the range headers**. A
> browser that cannot read `Content-Range` cannot walk the index, and the failure looks
> like a corrupt file rather than a CORS error.

`build.py` writes `r2-cors.json`; apply it with:

```sh
wrangler r2 bucket cors set <bucket> --file tools/osm-world/r2-cors.json
```

| object | `Cache-Control` | upload order | role |
| --- | --- | --- | --- |
| `*.fgb` | `max-age=31536000, immutable` | first | immutable per build |
| `manifest.json` | `max-age=300` | **last, always** | the only mutable object, and what flips a new build live |

## Where it is published

| | |
| --- | --- |
| bucket | `jltg-hide-and-seek` (R2) |
| public origin | `https://map.jltg.herzog.tech` — custom domain bound to the bucket |
| client constant | `DEFAULT_WORLD_BASE_URL` in `osm/worldfile.js`, `https://map.jltg.herzog.tech/world` |
| prefix | `world/` for the published world; `shards/{density,feature}/<id>/` for shard output; `admin/` and `transit/` for the two out-of-band handoffs the merge reads |
| site | GitHub Pages, `https://leoherzog.github.io/jltg-hide-and-seek/` — so the browser origin CORS must admit is `https://leoherzog.github.io` |

The **repo is public**, and that is a build requirement: the merge depends on public
runners' disk.

| Actions runner | vCPU | RAM | disk |
| --- | ---: | ---: | --- |
| private repo | 2 | 8 GB | — |
| public, documented | 4 | 16 GB | 14 GB |
| public, measured on ours 2026-08-22 | 4 | 15 GB | **86.2 GB free of 144.3 GB** |

Every workflow prints `cores: 4   ram: 15 GB`, **`disk: 86.2 GB free of 144.3 GB`** as
its first step, because the disk figure is undocumented, has moved twice, and the merge
sizing depends on it (`DESIGN.md` §Phase 6).

| credential | scope | used for |
| --- | --- | --- |
| R2 S3 key pair | **Object Read & Write**, nothing more | Write: `upload_file`, a multipart upload once an object clears the 5 GB single-PUT ceiling (the density grid does). Read: the merge pulling shards back with `aws s3 sync` |
| `wrangler` API token | `Workers R2 Storage: Edit` | applying CORS; would also apply a lifecycle rule |
| Cloudflare Admin | console only | one-time bucket creation and custom domain; **nothing in CI needs Admin** |
| browser | anonymous | reads |

Scopes are verified against the live bucket. Cloudflare has no write-only tier, and the
`wrangler` token is a *separate* credential from the S3 key pair.

- **Manifest last.** Every layer it names must be readable before it lands. A plain
  sorted upload put `manifest.json` 22nd of 38, ahead of sixteen layers.
- **Superseded layers are pruned, not overwritten.** Content-addressed names mean a
  rebuild never replaces the previous world's files, so `world-merge.yml`'s finalize waits
  out the manifest's `max-age` and then deletes every `world/*.fgb` the live manifest no
  longer names. Without that step the 2026-08-22 merge left 35 such files (49.5 GB)
  behind.

## What ships, and what does not

| class | layers | built by | client reads |
| --- | --- | --- | --- |
| feature | 31 | `build.py` | real geometry, exact counts, usable for distance and containment; one `.fgb` each |
| count-only | 5: three `curse_*`, `green_recreation_ground`, `animal_delta` | `build.py` | R-tree envelopes only |
| density grid | 1: `building`, `street`, `car_street`, `footpath`, `bridge`, `tree` | `build.py` stage 4 | per-cell tallies |
| `admin` | 1, replacing Overpass `is_in` | Overture, joined by `merge.py --admin` | whole rings |
| `transit_route` | 1, the assembled route relations | `build-transit.py`, joined by `merge.py --transit` | the OSM fallback tier synthesizes a feed from it |
| **all** | **39 in a published world** | a full `build.py` logs **37** | |

The three `curse_*` layers serve curse predicates whose selector deliberately differs from
the same-named category. `green_recreation_ground` and `animal_delta` exist only to
reconstruct a sixth count as an identity
([below](#the-curse_animal_habitat-identity)). `admin` and `transit_route` join at merge
time (`merge.py --admin --transit`) for the same reason: a relation only assembles when it
fits entirely inside the extract being read, so neither can come from a shard.

**The density grid** is tallies, not icons: nothing draws them, everything counts them,
and their planet-wide geometry is tens of gigabytes. They build into one sparse FlatGeobuf
of points, one per populated 0.002° (~220 m) cell, with an integer column per category.

> [!NOTE]
> Map-wide totals from the grid are **exact** — the build attributes each feature to
> exactly one cell, so a bbox sum cannot double-count, and those totals are what every
> curse predicate and the street-density figure read. Per-zone figures are
> **approximate**: a cell counts wholly inside or wholly outside a zone circle depending
> on where its centre falls. `osm/geodata.js` marks every density category `partial` and
> pushes a note saying so.

`restaurant`, `cafe`, `fast_food` and `shop` are real features on purpose: they are not
dense at planet scale, and `cuisineDetail` reads the `cuisine` tag off individual
restaurants. A grid cell cannot answer which country's cuisine is served inside it.

## The build table: `categories.json`

`geometry`, `dedup` and `count_only` decide what a layer weighs, and `runtime_columns`
decides what a feature carries. Together with the identity below they took michigan from
643,681,472 to 232,847,376 bytes (−63.8%) and germany from 9,004,762,856 to
3,343,969,105 (−62.9%). No published number moved except the ones that were wrong.
`tools/osm-world/DESIGN.md` has the per-layer figures.

### `geometry` — the per-layer `osmium export --geometry-types`

**osmium exports a closed way once per requested type.** Asking every layer for
`point,linestring,polygon` wrote every closed way *twice*: its polygon, plus the same ring
re-read as a zero-area linestring. That inflated counts by up to 2× (germany `green`
5,374,835 rows for 2,736,050 entities) and placed a *second POI at a different
coordinate*, because the polygon copy centroids and the linestring copy takes a polyline
midpoint.

| `--geometry-types` | layers | rule | evidence |
| --- | --- | --- | --- |
| `point` | 2: `mountain`, `bench` | the filter only admits nodes | — |
| `point,polygon` | 22, area tags | a closed way exports once, as its polygon; an **unclosed** way carrying an area tag is a mapping error and is dropped | sixteen lose exactly zero on both extracts; a handful lose one or two inspectable mapping errors |
| `point,linestring,polygon` + `dedup: true` | 7: `water`, `coastline`, `platform`, `high_speed_rail`, `rail_line`, `advertising`, `green` | genuinely mixed; the linestring reading must survive (lakes are polygons, rivers are linestrings) | **`advertising` was the one real miss** as `point,polygon`: 56 of 772 in michigan (7.3%), 816 of 35,816 in germany (2.3%), because a billboard *face* is legitimately a short open way |

`point,polygon` is a *claim about OSM tagging*, and getting it wrong loses features with no
error anywhere. So every layer in that class was measured on two extracts with different
mapping cultures, counting distinct entities that export as a linestring and never as a
polygon. The full audit table lives in `categories.json`'s header comment, and
`test-update.py` pins the mixed layers so the decision cannot be silently reverted.

`green` is mixed for an exactness reason rather than a tagging one; see the identity below.

### `count_only` — layers the client never reads a byte of

The curse loop calls `worldCount`, which walks the R-tree and reads **zero feature bytes**.
Those layers ship as **2-point bbox-diagonal linestrings with no properties**: a diagonal
from `(minX, minY)` to `(maxX, maxY)` has exactly the original envelope, so every R-tree
node bbox and every `search` result is bit-identical, and the client needs no change.
`diagonalize_layer` also owns their `(osm_type, osm_id)` dedup.

Saves 86–92% of their bytes · germany `curse_water` 481,384,488 → 64,066,912 bytes
(−86.7%).

**Trade:** this forecloses ever *drawing* a curse feature.

`admin` is the opposite case and has **no entry in this table**: containment is the whole
question, so its rings must stay whole, and whole rings only exist when the relation fits
entirely inside the extract, which no shard guarantees. The shipped admin layer comes from
Overture at merge time ([below](#the-admin-layer-comes-from-overture-not-osm)), and
`_admin_comment` in `categories.json` records the removal and its measured cost (16.5% of
pooled feature-shard output built, indexed, uploaded and discarded).

### The `curse_animal_habitat` identity

That layer was 45% a copy of `green` — 2.97 GB on germany, the single largest layer in
the build — so it is **deleted**, and its count is reconstructed client-side:

    count(curse_animal_habitat)
      == count(green) − count(green_recreation_ground) + count(animal_delta)

`landuse` is single-valued, so `green` minus its `recreation_ground` members is exactly
the old selector's landuse line, and `animal_delta` is exactly its other two lines with
the landuse members removed. Both new terms are count-only diagonals over unchanged
envelopes, so the identity holds for every bbox the R-tree is asked about; verified
exactly on michigan: **61,160 − 790 + 17,426 = 77,796**. The two replacement layers cost
12.2 MB on germany. The identity holds feature-for-feature only if every term counts each
OSM object exactly once, which is why `green` is in the mixed geometry class.

`CURSE_ANIMAL_HABITAT_TERMS` in `osm/geodata.js` is the consumer. **"Absent" has a precise
meaning**, because the manifest can express present-but-empty two ways:

| manifest entry | emitted by | `osm/worldfile.js` | `curseLayerCount` |
| --- | --- | --- | --- |
| `"coastline": {"path": "...", "features": 0}` | `build.py`: a non-`count_only` layer whose export has rows but whose `where` keeps none, or a resumed `.fgb` already on disk | constructs a reader and reads the empty file | 0 |
| `"amusement_park": {"features": 0}`, no path | `merge.py`'s empty-layer output; never for density | `worldCount` returns `0`, `worldPois` returns `[]`; **no reader is constructed and no HTTP request is issued** | 0 |
| no entry, full manifest | `build.py` stage 3 wrote nothing: an empty export, a `where` folded to `None`, or a `count_only` layer empty after `where` or diagonalizing | `null`, and the category degrades | a non-base term counts as 0 with an info log; an absent `green` refuses, because that is a broken build rather than an empty one |
| no entry, top-level `"partial": true` | a `--only`/`--skip-density` shard build | `null` | "not built": the predicate refuses with a warn log |

Treating the path-less entry as a path requests `<base>/undefined`, which aborts the
curse-predicate loop. `merge.py` never emits the path-less shape for **density**; see the
density row of [the global manifest](#the-global-manifest).

### `runtime_columns` — what actually ships on a feature

36 columns pinned by `include_tags` · 12 read at runtime, plus `osm_type`/`osm_id` · 24
exist only for a `where` clause.

The pinned set gives the GeoJSONSeq a stable schema. `ogr2ogr -select` projects the
filter-only columns away per layer, intersected with the columns that layer's features
actually carry, because `-select` hard-fails on a missing field. `osm_type`/`osm_id` are
never stripped: they are the shard merge's dedup key.

> [!CAUTION]
> A `where` naming a column absent from the export **does not abort**. `build.py` passes
> `-skipfailures`, and GDAL 3.12 with it prints `ERROR 1: SetAttributeFilter(…) failed`,
> exits 0, and copies every feature through **unfiltered**: a layer that builds, lands in
> the manifest, and has silently wrong counts.

`rewrite_where()` constant-folds every predicate over an absent column (absent ⇒ NULL for
every feature):

| `rewrite_where()` result | meaning | the layer |
| --- | --- | --- |
| rewritten SQL | still filters | built with the rewritten clause |
| `""` | unconditionally true | built unfiltered |
| `None` | can never match | omitted from the manifest |
| raises | a prefix `NOT` over a missing column | the build aborts (`SystemExit`): the one place SQL's UNKNOWN stops behaving like FALSE |

## The admin layer comes from Overture, not OSM

An administrative area only assembles into a polygon when its relation fits **entirely
inside the extract**. That makes per-shard admin impossible by construction — a Michigan
extract yields 73 level-2 features, all zero-area linestrings and no USA polygon — so
admin left the shard pipeline. Overture's `division_area` ships **already-assembled**
polygons, is OSM-derived, and is ODbL like the rest.

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
| `SRC`, `THREADS` | | local parquet glob (skips the release check), thread cap |

It writes `admin.sql` (the generated DuckDB script), `admin.fgb` and an
`admin.fgb.sha256` sidecar in `sha256sum -c` format. Budget ~10 GB of scratch.

| release | source | features | bytes | peak RSS | wall clock |
| --- | --- | ---: | --- | ---: | ---: |
| `2026-07-22.0` | 1,073,093 rows / 4.47 GB | 984,219 | **2,292,533,384 simplified** (shipped); 6,038,396,104 at full precision | 6.3 GB (simplified) | ~67 s on 16 cores (simplified) |

**Overture's own `admin_level` is unusable.** It is a per-country *depth* (country = 0)
and NULL below county. `subtype` is the rank and is always populated, so the build maps
it:

| Overture `subtype` | `admin_level` | ISO code carried |
| --- | ---: | --- |
| country | 2 | ISO3166-1 |
| dependency | 3 | ISO3166-1 |
| region | 4 | ISO3166-2 |
| county | 6 | — |
| localadmin | 7 | — |
| locality | 8 | — |
| macrohood | 9 | — |
| neighborhood | 10 | — |
| microhood | dropped | — |

- **ISO codes only where shown.** Overture fills `country` on every descendant row, and
  copying it down would make `worldAdminAreas` read a county as a country.
- **`class='land'`**: the `maritime` rows are EEZ and territorial-water polygons.

Because that ladder is synthetic, the manifest carries **`admin_source`**: absent or
`"osm"` keeps the existing OSM behaviour byte-identically, `"overture"` selects
`OVERTURE_ADMIN_ORDINAL_OVERRIDES` in `osm/geodata.js`. It is also what lets the page
render the required attribution — *"© OpenStreetMap contributors, ODbL 1.0 — via
Overture Maps Foundation"* — without guessing.

`probe-admin.mjs` tests the client and the file together by driving the **real**
`openWorld`/`worldAdminAreas` through a strict file-backed Range server: 206 only, real
`Content-Range`, and a throw when no Range header was sent.

Exit 0 pass · 1 a probe failed · 2 usage or missing file · `PROBE_VERBOSE=1` dumps every
area with ring and hole counts · `WORLDFILE=` points it at the reader outside the repo

| case | must return | must not | tests |
| --- | --- | --- | --- |
| Grand Rapids | `US \| Michigan US-MI \| Kent County \| Grand Rapids` | Canada, from a neighbouring bbox | edge bleed |
| Basel | CH + DE + FR | a district matching either of the other two countries | tri-border |
| **St Peter's** | VA | IT | holes subtracted: enclaves must be carried as interior rings |
| Baarle | BE and NL at two points ~1 km apart | — | enclaves |

37/37 pass against the shipped file · 184 range requests · 19.01 MB · a Michigan-only file
fails 20.

Overture prunes releases (at time of writing only `2026-06-17.0` and `2026-07-22.0` still
exist on S3), so `build-admin.sh` checks the live listing and dies printing the survivors
when the pinned `REL` has aged out.

## `transit_route` — the layer a city with no feed is played from

| layer | carries | built by | read by |
| --- | --- | --- | --- |
| `transit_route` | one feature per urban-rail route relation: the assembled line and the ordered stops it names | `build-transit.py` | `osm/synth.js` only |
| `rail_line` | the *track*: `railway IN (rail, subway, light_rail, tram, monorail, funicular) AND service IS NULL` | `build.py`, as an ordinary category layer | "is there a rail line in your zone" |

`service IS NULL` is the whole `rail_line` entry: 59.5% of `railway=subway` ways are yards
and sidings, rail 49.9%. It is the reason `service` is in `include_tags`.

`osm/synth.js` reads `transit_route` over the ring a player drew and synthesizes a GTFS
feed from it. The geometry and stop order are real; OSM has no timetable, so the schedule
is invented and the report says so. The layer is not a `GEO_CATEGORIES` member and
`collectGeodata` never touches it, so a run whose sources are all real feeds pays nothing
for it.

It has its own script for two independent reasons:

- **`osmium export` cannot produce it.** It emits relations as multipolygons only and
  drops `type=route` entirely (verified on osmium-tool 1.19.1), so no `where` clause
  recovers a route from the category chain.
- **A relation only assembles inside the extract that holds it whole**, the same law that
  moved `admin` to Overture. A metro line crossing a Geofabrik boundary would assemble
  half in each of two shards, and the merge's `MIN(fid)` dedup would keep whichever shard
  sorts first, half line and all.

```sh
uv run tools/osm-world/build-transit.py --out ~/osm-builds/transit
uv run tools/osm-world/build-transit.py --planet berlin-latest.osm.pbf \
                                        --out ~/osm-builds/transit-berlin
```

`--planet`, `--planet-url`, `--no-fetch`, `--skip-md5`, `--no-update` and `--force` are
`build.py`'s (the fetch and update stages are imported rather than copied), so pointing it
at a Geofabrik extract is the development loop. Its outputs are pipeline intermediates
handed to the merge, not published world objects; the upload is `world-transit.yml`'s job.

```
<planet>
  → osmium tags-filter <planet> r/route=subway,train,light_rail,tram,monorail,funicular
      (pulls the matched relations' member ways and nodes along: self-contained)
  → pyosmium pass 1: relations
  → pyosmium pass 2: only the member ids pass 1 asked for
  → GeoJSONSeq sorted by relation id
  → ogr2ogr → transit_route.fgb
             transit_route.fgb.sha256   (sha256sum -c format)
             transit_route.meta.json    (counts, modes, planet timestamp)
```

A single pyosmium pass would have to cache every way and node in the file, the RAM wall
that killed the monolith build. Urban rail is a small universe, ~27,000 relations
worldwide across the six modes and ~9,000 of them non-`train`, so everything after the
planet pass is minutes.

**The assembly is where the work is**, and every rule is a measured property of the data
rather than a reading of the PTv2 spec:

| rule | evidence |
| --- | --- |
| **Member order is unreliable, topology is sound.** Members are re-chained by shared endpoint *node id*, never by coordinate (two nodes at the same position are a crossing, not a connection), with per-segment reversal | chaining in stored order hits at least one endpoint mismatch in 52/162 Seoul relations, 50/131 NYC, 27/148 Berlin; union-find over way endpoints says 97.7% of relations are one connected component |
| **Path members are role ∈ {`""`, `forward`, `backward`}** | PTv2 deprecated the last two in 2011 and Seoul alone still carries 957; filtering on the empty role leaves 8 Seoul relations with no geometry and fakes gaps in 54 more |
| **Platform ways are members of the same relation** and must never reach the geometry | NYC 3,309, Berlin 2,609 |
| **Stops are read by role, never by position** | a handful of relations interleave them after the ways; every `stop`-role member in the corpus is a node, 0 exceptions in 19,400+ slots |
| **Loops, branches and honest gaps ship as a MultiLineString**, parts ordered longest-first. Nothing fabricates a joining segment: an invented line across a gap is a line the trains do not run on | 22 relations have no degree-1 endpoint (circle lines), 3 have a junction, 17 are genuinely disconnected into 2–4 pieces |
| **Stop order comes from the geometry; direction comes from the member list**, by majority vote | sorting stops by projection onto the chained line reproduces the member order for 95.9% of relations and fixes the 4.1% that disagree (Tokyo/Berlin through-services); the chainer seeds its walk on a node id and cannot know which way the trains run, so projection alone would hand back both of a line's direction relations pointing the same way |
| **A relation with no stop members is dropped**: a line nobody can board is not a route | 17 in the corpus |

Determinism is the same contract as `build.py`'s: relations emitted in id order, every
tie in the chainer broken by the smallest node id then the smallest way id, coordinates
rounded to 7 decimals, fixed JSON key order, no clock. So `fgb-equal.sh` tier 1 (sha256
of the whole file) is the reproducibility test.

The layer is **self-contained by design**: it is not built through `export_layer`, so
`include_tags` and `runtime_columns` do not apply and its columns are pinned in
`build-transit.py`. Every column ships on every feature, with the empty string for an
absent tag, because a GeoJSONSeq column that is null on every feature has no type for OGR
to infer.

| column | |
| --- | --- |
| `osm_type`, `osm_id` | always `relation` + the relation id; one feature per relation |
| `name`, `name_en`, `ref` | 99.5% / 97.8% of subway routes carry name / ref |
| `colour` | British spelling only — `colour` 1.6M uses planet-wide, `color` 74 |
| `operator`, `network`, `route` | `route` is the mode the converter maps to a GTFS `route_type` |
| `interval`, `duration` | raw and unparsed; the converter owns the grammar and the fallback |
| `stops` | JSON `[[nodeId, name, nameEn, lat, lon], …]` **in travel order** |

`stops` is one JSON string rather than parallel columns because a FlatGeobuf column is a
scalar, and `"names;lats;lons"` has a worse escaping story for a station called
`Champs-Élysées ; Clemenceau`.

**Measured** on `berlin-latest.osm.pbf`, 2026-08-24, planet snapshot
2026-08-23T20:21:36Z, 16 cores:

| | |
| --- | --- |
| route relations in → features out | 237 → **237** |
| output | **2,678,856 bytes** |
| wall clock, including the tags-filter pass | **15.5 s** |
| multi-part features | 27 |
| platform members excluded | 4,712 |
| stops further than 500 m from their line | 0 |
| reproducibility | three runs from the same extract byte-identical (`088224f4…`) |
| read back through the app's reader, central Berlin bbox | 165 routes in 278 range requests |
| U8's two direction relations | 24 stops each, **running opposite ways**: the property the direction rule exists for |

A city extract also demonstrates the extract law from the other side: 74,850 member ways
of Berlin's regional `route=train` relations lie outside it, which is what a shard would
suffer and a planet run does not.

## Sharding, and putting the shards back together

The planet cannot be built as a monolith: `stage_density` holds every populated cell in a
Python dict at `peak RSS ≈ 1.29 GB + 1.53 kB × cells`, which brackets the planet at
139–301 GB of RAM. The build shards; **the client does not**. It still sees one world at
one base URL.

```sh
uv run tools/osm-world/cover.py [--cap-gb 8] [--no-sizes]
uv run tools/osm-world/merge.py --shards <dir of per-shard build dirs> \
                                --admin <admin.fgb> --transit <transit_route.fgb> \
                                --out <dir> [--no-assert]
```

### `cover.py`

`cover.py` downloads Geofabrik's `index-v1.json` and writes two outputs:

```
shards.json            {generated_from, coarse[], fine[]}      the interface CI reads
  every entry          {id, pbf_url, md5_url, est_bytes}
  fine entries         + disjoint_neighbors                    diagnostic: which shards can share a boundary density cell
cover-geometries/      one GeoJSON per fine shard, holding its assigned disjoint polygon
                       filename = id with / → __
```

Both are committed, from the same run, and both are **written last, adjacent, after every
network request**, so an interrupted run cannot leave one updated without the other.

Two partitions, because the two stage groups have opposite constraints:

| partition | members | total | serves | bounded by | membership |
| --- | --- | ---: | --- | --- | --- |
| **fine** | 514 (largest africa 7.90 GB) | 114.2 GB | density alone | RAM, which density is linear in | one greedy pass in the *difference order*: ascending polygon area, ties by id |
| **coarse** | 87 regions, each ≤ 8 GB | 82.2 GB | the feature layers, flat at ~2.4 GB RSS | runner disk | derived from the fine members' containers |

**Membership.** A region is a fine member when its residual (itself minus the members
already kept) still covers LAND, and its extract is small enough to build. Land is vendored
Natural Earth 1:50m (`land-50m.geojson`). The mask decides membership only; a member's
assigned clip stays the full-precision Geofabrik residual, so nothing near a coastline is
lost. The `fine` array ships in difference order so a consumer can rebuild the assigned
disjoint geometries.

Both rules tried before, folded below, asked about **area** when the question is about **territory**, so both
needed a threshold, and a threshold on the wrong quantity always has a wrong side. Asking
about land needs no threshold beyond "is there any", and it makes the guarantee
assertable: `cover.py` **refuses to write a cover that leaves land to no shard**.

<details>
<summary>Membership rules tried before, both of which shipped covers with holes</summary>

| rule | failure | lost |
| --- | --- | --- |
| *"A region that contains no other region."* | drops every region containing an **enclave** and takes its non-enclave territory along: `greater-london` went to `enfield`, `niedersachsen` to `bremen`, `ukraine` to `crimean-fed-district`, `morocco` to `ceuta`/`melilla`, and eight more | London, Hanover, Marseille, Casablanca, Guangzhou, Sydney, Kyiv and Lviv were in **no density shard**, and Ukraine had no feature shard either |
| *"A region at least 70% uncovered."* | drops `central-america` at 62.9% uncovered and `italy` at 7.0% | Trinidad, Barbados, Grenada, St Lucia, Curaçao, Aruba, Cayman and the BVI; San Marino |
| the residual covers land | shipped | — |

Before the land rule the coarse cover's gap was 4,251 deg², and the claim that it held
only ocean was *false*: Ukraine was sitting in it.

</details>

**Clip.** Geofabrik's polygons overlap by design. Density's exactness rule, each way
attributed to exactly one cell via its first node, survives sharding only if each shard
counts the ways whose first node falls in its assigned **disjoint** region. Without the
clip, both neighbours count every way in the overlap buffers and the merged grid
double-counts. `build-shard.sh` enforces it by passing the shard's `cover-geometries/`
file to **`build.py --clip-region`**, and stage 4 bins a way only when its first node (a
tree node: its own location) tests inside the polygon.

| clip overhead | density pass | peak RSS | candidates dropped as buffer overlap |
| --- | --- | --- | ---: |
| michigan | 77 s → 87 s (+13%) | unchanged | 0.19% |
| saarland | +8 s on a 23 s pass | | 0.121% |
| rheinland-pfalz | +17% on a 94 s pass | | 1.238% |

> [!NOTE]
> **The clip is verified against ground truth.** A clipped merge of two adjacent German
> states matches a whole-Germany reference density build exactly: 0 differing cells
> across 335,516 compared cells. The unclipped merge inflates the shared boundary band by
> up to +27.7% per category (`tools/osm-world/DESIGN.md` §Phase 3 retest).

**Land test** · `england`'s sliver fringe: **473 pieces**, 0.0127 deg² · erosion ~550 m ·
San Marino: one piece of 0.0053 deg², survives at 0.0038 · 8 GB cap: a **disk** bound.

Both details are measured rather than chosen. Natural Earth's coastlines and Geofabrik's
cutting polygons disagree by metres, so every residual picks up a fringe of thin slivers,
none of them a place; eroding by ~550 m deletes anything narrower while leaving a real
place intact. The cap bounds disk, not memory: a clipped shard's RSS scales with cells
inside the clip, but a density shard cannot use `--unlink-source` (stage 4 reads the raw
extract). Sized off `quebec` at 1.5 GB instead, San Marino, Saint-Pierre-et-Miquelon,
South Georgia and Kerguelen all fell out, because the only extract reaching each is a
country file.

Micro-territories below the mask's resolution do not get their own shard. Their land is
covered by the parent that contains them, which costs a larger parent extract and is
**not** a coverage gap:

| below mask resolution | covered by |
| --- | --- |
| Monaco (`monaco`) | `provence-alpes-cote-d-azur` |
| Macau (`macau`) | `guangdong` |
| Gibraltar | `andalucia` |
| the Vatican | `centro` |
| `tokelau`, `cocos-islands`, `norfolk-island`, `ile-de-clipperton`, `ashmore-cartier` | the parent that contains each |

> [!WARNING]
> Exactly one piece of land is genuinely uncovered: **Diego Garcia** (0.0108 deg², Chagos),
> whose only source is `asia` at 16.18 GB, twice what a runner can hold. Regenerating
> therefore needs `--allow-uncovered-land`, and the expected residue is that one piece. If
> a run reports anything else, investigate before committing it.

```sh
uv run tools/osm-world/cover.py --allow-uncovered-land
```

`index-v1.json`'s `parent` field is a *display* hierarchy, not a tree (`us`, `us-midwest`
and `us/michigan` are siblings), so the cover is computed geometrically. Uncovered area is
logged rather than assumed: the coarse cover's 4,175 deg² gap is entirely open ocean, and
no populated place falls in it.

### `merge.py`

`merge.py` discovers shard builds **recursively**: an R2 sync nests `us/michigan/` a level
deeper than a flat scan looks. `--shards` itself is a candidate first.

| situation | `merge.py` does | override |
| --- | --- | --- |
| a directory with `.fgb` files but no `manifest.json`: a failed build's leavings | hard error listing the offenders | `--allow-incomplete` |
| `manifest.json` at the `--shards` root | single-shard merge | — |
| stray `.fgb` files at the `--shards` root | the same hard error | `--allow-incomplete` |
| a symlinked directory | **followed**, so a merge tree may be assembled from links to out-of-tree builds instead of copying gigabytes | — |
| a symlink cycle, or a duplicate route over a non-shard directory | skipped with a log line (visited-realpath set) | — |
| a **shard** reached twice | hard error naming both paths: a shard merged twice double-counts density additively, and a symlink loop once yielded 41 discoveries of one shard | — |
| two bind-mounted views of one directory | **not detected**: the guard resolves symlinks only | don't build merge trees out of bind mounts |

Per layer: VRT with `FieldStrategy=Union` → GPKG → `DELETE` keeping `MIN(fid)` over shard
dirs in sorted relative-path order → FGB with a spatial index.

- **The schema union is mandatory.** A shard whose extract contains no feature carrying
  `cuisine` writes no such column, and a naive `-append` would drop that column for those
  rows without a word.
- **`rows == distinct(osm_type, osm_id)` is asserted per shard before merging anything**
  (`--no-assert` overrides). Dedup at merge time would otherwise have *masked* the
  double-emit bug non-deterministically, and a bug a later stage silently cleans up is a
  bug nobody finds.

`count_only` layers carry no property columns, so they dedup on exact geometry bytes.
Density is summed by `(row, col)` through an external sort that reproduces
`stage_density`'s exact output shape. Admin is brought in from `--admin` and stamps
`admin_source: "overture"`; `transit_route` is brought in from `--transit` the same way,
content-addressed and hardlinked when the filesystem allows. Both are **required** on any
run that places them, because a world silently missing either looks exactly like a world
that has them.

### The global manifest

The global manifest is the per-build manifest plus these rules:

| field | rule | why |
| --- | --- | --- |
| `features: 0` | explicit for legitimately-empty FEATURE layers, rather than omission | michigan really has no `coastline`, and a failed job must not look like that |
| density | **never gets a `features: 0` entry**. A merge in which no shard contributes density is a **hard error**; `--allow-missing-density` publishes with density **omitted from the manifest entirely** | the client trusts a present-but-empty grid as a real zero, which would auto-lift the density-based curses (Bridge Troll, Luxury Car, Right Turn). Zero density cells for a real region is an operational failure (a forgotten or mis-pathed density sync), never true emptiness. Absent ⇒ the client degrades and the curses warn, the safe direction |
| `planet_timestamp` | the **oldest** contributing shard; on a merge-into run, the oldest of the existing manifest's value and this run's shards | |
| `bbox` | optional, per layer | |
| layer filenames | content-addressed: `layer.<sha256-12>.fgb` | an unchanged layer keeps its URL across rebuilds, so browser and CDN caches stay warm |
| `"partial": true` | stamped by any `build.py`/`merge.py` run whose manifest lacks the full layer table because of `--only`/`--skip-density` selection or the density omission above | a shard build must never be mistaken for a whole world |
| `cell_deg` | on a merge-into run, differing from the existing manifest's is a hard error | a world cannot mix grid resolutions |

**`partial` does not propagate through the merge.** A per-shard build made with
`--only`/`--skip-density` stamps `partial: true` on that *shard's* manifest (every
density-only shard does), but `merge.py` computes the merged manifest's `partial` from the
merged layer table alone. A full merge of partial shards comes out with all 39 keys and no
`partial` flag.

A `merge.py --only` run merges into an existing `manifest.json` instead of clobbering the
layers it did not touch, clearing `partial` once the table is complete. Manifest keys the
current layer table no longer contains are **dropped, loudly**, because a removed layer
would otherwise be carried forward forever. Merge-into is safe because builds are
byte-reproducible: two michigan builds on different core counts, kernels and filesystems
are identical, and so is a re-run of the merge.

| verification (`tools/osm-world/DESIGN.md` §Phase 3 retest) | result |
| --- | --- |
| three-shard merge: bremen + hamburg + berlin + global admin, measured before `rail_line` and `transit_route` joined the table | 37 layers / 2.36 GB in half a minute; passes 304 verification checks; the real client reader opens the result, Overture admin and all |
| recursive discovery | re-verified through a three-level-deep R2-sync-shaped tree |
| incomplete shard | fails loudly; `--allow-incomplete` escapes; nothing written to `--out` on failure |
| a real `--only park` run into an existing 37-layer manifest | byte-identical, no spurious `partial` |
| `--unlink-source` | refuses whenever density would run; otherwise deletes a real 21 MB extract mid-build, with byte-identical outputs to a control run |

## CI

Seven workflows. All are `workflow_dispatch` (the shard schedules stay commented out),
`max-parallel` 20, `fail-fast: false`, and fail loudly rather than quietly skipping when
`shards.json` is missing or the `R2_*` secrets are unset. The secrets exist as of
2026-08-22.

| workflow | what | matrix | timeout | R2 prefix | status |
| --- | --- | --- | ---: | --- | --- |
| `world-density-shards.yml` | fine shards (514) | batch ≤5 / ≤2 GB → 113 matrix jobs | 350 min | `shards/density/<id>/` | **proven at full scale**: 113/113 jobs, zero failures (2026-08-22) |
| `world-feature-shards.yml` | coarse shards (87) | batch 1 → 87 matrix jobs | 240 min | `shards/feature/<id>/` | **proven at full scale**: 87/87 jobs, zero failures (2026-08-22) |
| `world-admin.yml` | Overture admin build + probes | 1 job | 120 min | `admin/` (handoff) | dispatched, run 32591161893; failed on a GDAL driver gap, which drove the fix now in `build-admin.sh` |
| `world-transit.yml` | global route-relation build + probes | 1 job | 350 min | `transit/` (handoff) | never dispatched; `build-transit.py` has only run against a city extract, so the planet-scale disk and wall-clock numbers in the header are arithmetic rather than measurement |
| `world-merge.yml` | shards + admin + transit → the world | 36 layers + N bands + 3 | 350 min max | `world/` | dispatched, run 32599689118, which published the live world |
| `world-rebuild.yml` | shards → admin, transit → merge | calls the other five | — | — | never dispatched |
| `world-canary.yml` | one ~1 GB shard, full pipeline, re-measures a runner | 1 job | 90 min | none: output is a workflow artifact | — |

Shard-run evidence is in `DESIGN.md` §Phase 4 Result.

### Shard jobs

`tools/osm-world/ci/chunk-shards.py` batches `shards.json` into the matrix.
`tools/osm-world/ci/build-shard.sh` downloads a shard, then calls `build.py … --upload
--prefix`.

| script / flag | applies to | guard |
| --- | --- | --- |
| `chunk-shards.py --batch-size` | both shard workflows | a batch closes on whichever cap is hit first, shard count or accumulated bytes; the script fails cleanly if a future cover run would exceed the 256-job cap (the fix is a larger cap, not a code change) |
| `chunk-shards.py --max-batch-bytes` | the density workflow | the single-threaded density pass makes a batch's wall clock track its accumulated `est_bytes`; a shard alone over the byte cap still gets its own job |
| md5 check | every shard | `build-shard.sh` **compares md5 hashes by hand**, never `md5sum -c`, whose filename field rejects the dated file Geofabrik's sidecar redirects to |
| `--clip-region cover-geometries/<id>.geojson` | density builds | hard error if the geometry file is missing, **resolved before the download** so a bad `--id` costs no transfer |
| `--unlink-source` | feature builds | deletes the raw extract once stage 1's intermediate exists, which keeps africa's 7.90 GB under runner disk; `build.py` refuses the flag when density would run, since stage 4 reads the raw extract |
| `--unlink-source` with **no** stage-1 intermediate | an `--only` selection naming no feature layer, with density skipped or absent, e.g. `--only density --skip-density --unlink-source` | the deletion log says `no selected stage reads the raw extract`; same gate: it deletes only what nothing left to run will open |
| retries | every shard | wrap the whole per-shard call and are a full re-download + rebuild, not a resume: `build-shard.sh` clears its work dir and passes `--force` |

**A failed shard says why.** `/usr/bin/time -v` writes its resource report to its own
stderr, which is the same fd as the child's, so `2> time.log` would swallow build.py's
stderr too. The report goes to `-o time.log` instead, leaving build.py's stderr on the job
log live and in order. An `EXIT` trap prints the report on a non-zero exit, because peak
RSS and wall clock are how an OOM kill is told apart from a bug, and an OOM-killed process
writes no stderr at all.

### The merge in CI

`world-merge.yml` is the shape the 14-agent investigation (`DESIGN.md` §Phase 6)
concluded fits a public runner: a **per-layer matrix**, with the density grid merged in
**N = ceil(cells / 30M) interleaved row bands computed at run time**
(`ci/merge-plan.py`) and reassembled by one band-append job.

| constraint | measured | limit | consequence |
| --- | ---: | ---: | --- |
| one serial merge job | ~5.4 h, no checkpointing | 6-hour cap | a per-layer matrix instead |
| density cells | 119,473,135 | 30M per band | 4 bands today |
| assemble-job RAM | ~12.1 GB | 15 GB | the only tight job; the writer takes ≈ 166 MB + 100 B/feature |
| `green` pooled | 14.22 GB | | long assumed to be the blocker; a one-country extrapolation suggested 34–50 GB |

> [!CAUTION]
> GDAL's FlatGeobuf writer keeps a hidden unlinked temp file *in the output directory* and
> ignores `CPL_TMPDIR`, so transient disk is double the final layer size. That is why
> `jlumbroso/free-disk-space` is mandatory on every merge job.

- `merge.py --upload` reuses `build.py`'s boto3 uploader: layers first, a HeadObject check
  on every referenced object, and the manifest strictly last.
- `world-merge.yml`'s plan job refuses to merge unless the R2 manifest set equals
  `shards.json` in both directions. A shard job that never ran, or a stale shard whose
  density would double-count, stops the merge by name instead of shipping wrong counts.

**Two guards exist because a merge failure is otherwise silent:**

- `write_union_vrt` checks every shard input a manifest claims exists and is non-empty;
  otherwise a file an interrupted `aws s3 sync` never fetched publishes a layer short by
  one shard, with no error.
- No shard contributing density is a hard error; see the density row of
  [the global manifest](#the-global-manifest).

## What this loses

> [!IMPORTANT]
> Not evaluated: the rulebook's **"within 10 ft of a routable path"** refinement. Every
> candidate spot is marked verify-on-the-ground unconditionally, and the page states this
> rather than papering over it.

The server-side join, walkable ways buffered by 5 m against candidate spots, has no local
equivalent short of shipping the global footpath network, the densest layer in OSM and
what the density grid exists to avoid.

Old join budget 40,000 walkable ways · reference map alone 84,466 · so the join was
already skipped on essentially every real map.

Counts are as of `planet_timestamp`, read from the PBF's replication header and shown in
every provenance row.

## Testing the reader

`osm/flatgeobuf.js` is a hand-written reader for a binary format: FlatBuffers vtable
arithmetic, an R-tree walk, a packed property blob whose field widths come from the
header. That is code that is either exactly right or silently returns plausible garbage,
so it is checked against a file GDAL wrote. Four suites, all green before anything ships:

```sh
uv run tools/osm-world/make-fixture.py /tmp/f.fgb
node tools/osm-world/test-reader.mjs /tmp/f.fgb          # 45 assertions

uv run tools/osm-world/make-test-world.py /tmp/world
node tools/osm-world/test-pipeline.mjs /tmp/world        # 83, collectGeodata end to end

uv run tools/osm-world/test-update.py                    # build.py internals
node tools/smoke.mjs                                     # 19/19 golden numbers
```

| suite | checks | covers |
| --- | ---: | --- |
| `test-reader.mjs` | 45 | every geometry shape the reader branches on, including a polygon with a hole and a multipolygon, the cases a flattened ring list silently gets wrong; 2,000 filler features so the R-tree has four levels and the file is comfortably larger than the reader's 16 kB header probe, without which the "did it actually use Range requests" assertion cannot fail |
| `test-pipeline.mjs` | 83 | `collectGeodata` end to end over `make-test-world.py`'s world |
| `test-update.py` | 8 | the parts of `build.py` no other harness can reach: the stage 0b replication-diff loop, the `where` rewriter, the geometry classes, and `build-transit.py`'s relation assembly |
| `tools/smoke.mjs` | 19/19 | golden numbers |

<details>
<summary>What <code>make-test-world.py</code> and <code>test-pipeline.mjs</code> pin</summary>

- **Four** layers, `pitch`, `coastline`, `curse_cairn_terrain` and `animal_delta`, go
  through `build.py`'s real pipeline from an OSM XML fixture generated from the same WKT
  the hand-written layers use, so the two cannot drift.
- `animal_delta`'s cut deliberately carries no `landuse` column (the absent-column `where`
  case), and the fixture carries a **detector** feature, an unnamed `natural=water` way,
  that only an unapplied filter would let through.
- `pitch.fgb`'s header columns are pinned to exactly `["osm_type","osm_id","name"]`, so a
  re-added build-only column fails loudly rather than costing bytes on every feature on
  the planet.
- Both legal empty-layer manifest shapes: a path-less `mountain` entry alongside a
  with-file empty `foreign_consulate`.
- The legacy-manifest path, where an old `curse_animal_habitat` layer is present and must
  be read directly instead of through the identity.

</details>

<details>
<summary>What <code>test-update.py</code> pins</summary>

- **The `where` rewriter:** fold cases from the real table, the invariant that all 42
  clauses round-trip byte-identical, and the prefix-`NOT` refusal.
- **The geometry classes:** the mixed + dedup layers are pinned so the `advertising`
  decision cannot be silently reverted.
- **Transit assembly**, on fixtures shaped like the corpus pathologies: scrambled and
  reversed member ways, a circle line, a disconnected relation, a junction, legacy and
  platform roles, a stop out of sequence, both directions of one line, and byte-identical
  output under a reordered member list.
- **The diff loop** replaces `pyosmium-up-to-date` with a stub whose exit codes are
  scripted, because the case worth testing is the loop around the updater. That tool's
  exit status is ambiguous by design: `1` means both "stopped at the `--size` limit, more
  to do" and "could not resolve". Retrying blindly would re-download a gigabyte of diffs on
  each of 24 passes, so the loop watches the file's replication timestamp and stops as
  soon as a pass fails to advance it.

</details>

Two real bugs were caught this way and both were silent: the R-tree descent started at
the last node instead of the root, and `nodeCount` returned the root level's end (1)
instead of the leaf level's (74), which put `dataStart` 2,920 bytes inside the index.
