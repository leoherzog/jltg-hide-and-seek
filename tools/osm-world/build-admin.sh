#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# build-admin.sh — the global administrative-boundary layer, from Overture.
#
# PLAN.md Phase 2. Produces one `admin.fgb` whose columns are exactly what
# `osm/worldfile.js:worldAdminAreas` already reads — `admin_level`, `name`,
# `name:en`, `ISO3166-1`, `ISO3166-2` — so the client needs no change beyond
# reading `"admin_source": "overture"` in the manifest.
#
# WHY NOT OSM. Admin boundaries are relations; a per-shard OSM build can only
# ever assemble the part of a boundary that falls inside the shard, so a country
# polygon is unbuildable from tiles and only barely buildable per-country.
# Overture ships the polygons already assembled, globally, in GeoParquet.
#
# ─── ATTRIBUTION (REQUIRED, NOT OPTIONAL) ─────────────────────────────────────
# Overture's `divisions` theme is derived from OpenStreetMap and is licensed
# ODbL 1.0. Anything served from the output of this script must carry, visibly:
#
#     © OpenStreetMap contributors, ODbL 1.0 — via Overture Maps Foundation
#
# ODbL is share-alike: a derived database that is publicly used must be offered
# under ODbL as well. Keep the attribution line with the artefact. The world manifest
# records `admin_source: "overture"`, which is what the page renders from; the release
# id is written to admin.meta.json beside the build and is NOT currently threaded into
# the manifest or served, so nothing can print it yet.
#
# ─── USAGE ────────────────────────────────────────────────────────────────────
#   OUT=~/osm-builds/admin-2026-07-22 ./tools/osm-world/build-admin.sh
#
#   OUT           (required) output directory; created if absent
#   REL           Overture release id            [2026-07-22.0]
#   SIMPLIFY      ST_SimplifyPreserveTopology tolerance, degrees [0.0001]
#                 SIMPLIFY= (empty) or 0 -> full precision, ~2.6x larger
#   BBOX          "minLon,minLat,maxLon,maxLat" subset, for smoke runs  [unset]
#   MEMORY_LIMIT  DuckDB memory_limit                              [16GB]
#   THREADS       DuckDB threads                        [unset = all cores]
#   SRC           local parquet glob instead of S3 (skips release check)
#
# WHY DUCKDB WRITES THE FGB ITSELF (2026-08-22, world-admin run 32591161893):
# this script used to hand DuckDB's output to ogr2ogr through an admin.parquet
# intermediate — and ubuntu-latest's apt GDAL is built WITHOUT the Arrow/Parquet
# drivers, so on a CI runner ogr2ogr could not open it (an 82-driver dump, no
# `Parquet` in it; kadro's GDAL has the driver, which is why this never bit
# locally). duckdb-spatial bundles its own GDAL with FlatGeobuf create support,
# so the COPY now writes `admin.fgb` directly: no 4.47 GB intermediate, no
# ogr2ogr step, no dependence on the host GDAL's driver list for the BUILD
# (ogrinfo still reads the output for the probes, and FlatGeobuf read IS in the
# runner's driver list — both preflighted below). Verified equivalent on a
# Vatican-bbox A/B against the old path: identical feature content (same md5
# over sorted WKT dumps), identical probe answers through the real client
# reader, spatial index present (the reader's `search` throws without one).
# One cosmetic difference: the layer header declares Geometry "Unknown (any)"
# instead of "Multi Polygon" — per-feature types are still written, and
# osm/flatgeobuf.js reads the per-feature type (header type is only a default).
#
# Sizing, measured on the full 2026-07-22.0 global build (spike S2, kadro,
# 16 cores / 31 GB, the superseded parquet+ogr2ogr path): 984,219 features;
# SIMPLIFY=0.0001 -> 2.29 GB fgb, DuckDB peak RSS 6.3 GB, 56 s + 11 s ogr2ogr.
# Full precision -> 6.04 GB fgb, peak RSS 13.1 GB. MEMORY_LIMIT=8GB also
# completes: DuckDB spills the sort/aggregate to `$OUT/duckdb-tmp`, which is
# what a CI runner should use — budget ~10 GB of scratch disk there on top of
# the outputs. The direct-write path trades the parquet write for the FGB
# write inside the same process; re-measure on its first full run.
#
# Rebuild cadence: rarely. Boundaries move on a timescale of years, and this
# build is deliberately outside the sharded OSM pipeline.
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REL="${REL:-2026-07-22.0}"
SIMPLIFY="${SIMPLIFY-0.0001}"          # `-` not `:-`: an explicit empty means full precision
MEMORY_LIMIT="${MEMORY_LIMIT:-16GB}"
BBOX="${BBOX:-}"
THREADS="${THREADS:-}"
SRC="${SRC:-}"

die() { printf '\n build-admin: %s\n' "$*" >&2; exit 1; }
say() { printf '\n── %s\n' "$*"; }

[ -n "${OUT:-}" ] || die "OUT is required (output directory). See the header for usage."
for tool in duckdb ogrinfo sha256sum curl; do
  command -v "$tool" >/dev/null 2>&1 || die "\`$tool\` not on PATH"
done

# ── driver preflights: fail in seconds, not after the full S3 scan ────────────
# The 2026-08-22 CI failure (header) surfaced a missing GDAL driver only AFTER
# the 3.5-minute DuckDB pass, as a confusing 82-driver dump. `command -v` can
# never catch that class of gap — a binary can exist and still lack the driver
# a step needs — so check the two drivers this script actually depends on, by
# name, before any data moves: ogrinfo must READ FlatGeobuf (the probes), and
# duckdb-spatial's bundled GDAL must CREATE it (the build). The INSTALL here is
# idempotent and needed by the build anyway.
# grep WITHOUT -q on purpose: under `set -o pipefail`, `grep -q` exits at the
# first match, ogrinfo dies of SIGPIPE, and the pipeline "fails" on success.
ogrinfo --formats 2>/dev/null | grep "FlatGeobuf" >/dev/null \
  || die "this ogrinfo lacks the FlatGeobuf driver — the verification probes cannot run"
fgb_create="$(duckdb -noheader -list \
  -c "INSTALL spatial; LOAD spatial; SELECT count(*) FROM ST_Drivers() WHERE short_name = 'FlatGeobuf' AND can_create;" \
  2>/dev/null || true)"
[ "$fgb_create" = "1" ] \
  || die "duckdb-spatial's bundled GDAL cannot create FlatGeobuf (probe said '${fgb_create:-nothing}') — the direct admin.fgb write needs it"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

# ── SIMPLIFY: validate before it reaches SQL ──────────────────────────────────
# ST_Multi replaces the retired ogr2ogr step's `-nlt PROMOTE_TO_MULTI`: a
# uniform MultiPolygon output, verified feature-identical against the old path
# on the Vatican-bbox A/B (header note).
if [ -z "$SIMPLIFY" ] || [ "$SIMPLIFY" = "0" ]; then
  GEOM_EXPR="ST_Multi(geometry)"
  SIMPLIFY_NOTE="full precision (no simplification)"
else
  case "$SIMPLIFY" in
    ''|*[!0-9.eE+-]*) die "SIMPLIFY must be a number in degrees, got '$SIMPLIFY'" ;;
  esac
  GEOM_EXPR="ST_Multi(ST_SimplifyPreserveTopology(geometry, $SIMPLIFY))"
  SIMPLIFY_NOTE="ST_SimplifyPreserveTopology($SIMPLIFY deg ≈ $(awk "BEGIN{printf \"%.0f\", $SIMPLIFY*111320}") m)"
fi

# ── The release listing is pruned. Fail loudly rather than 404 mid-scan ───────
# Overture keeps only the last couple of releases on S3; a pinned REL that has
# aged out fails deep inside a 3 GB parquet scan with an opaque HTTP error, so
# check the bucket listing first and print what actually exists.
if [ -n "$SRC" ]; then
  say "release check skipped — reading local SRC=$SRC"
else
  say "checking that release $REL still exists on S3"
  LIST_URL='https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/?list-type=2&delimiter=/&prefix=release/'
  RELEASES="$(curl -sfL "$LIST_URL" \
      | grep -o '<Prefix>release/[^<]*</Prefix>' \
      | sed -e 's|<Prefix>release/||' -e 's|/*</Prefix>||' \
      | grep -v '^$' || true)"
  [ -n "$RELEASES" ] || die "could not list s3://overturemaps-us-west-2/release/ (network? bucket layout change?)
   tried: $LIST_URL"
  if ! printf '%s\n' "$RELEASES" | grep -qx -- "$REL"; then
    die "release '$REL' is gone from the bucket — Overture prunes old releases.
   available now:
$(printf '%s\n' "$RELEASES" | sed 's/^/     /')
   Re-pin REL to one of those and rebuild; the manifest records which one was used."
  fi
  printf '   ok — releases present: %s\n' "$(printf '%s ' $RELEASES)"
fi

SOURCE_GLOB="${SRC:-s3://overturemaps-us-west-2/release/$REL/theme=divisions/type=division_area/*.parquet}"

# ── Optional bbox subset (smoke runs) ─────────────────────────────────────────
BBOX_SQL=""
BBOX_NOTE="global"
if [ -n "$BBOX" ]; then
  IFS=, read -r BX0 BY0 BX1 BY1 <<<"$BBOX"
  [ -n "${BY1:-}" ] || die "BBOX must be 'minLon,minLat,maxLon,maxLat', got '$BBOX'"
  for n in "$BX0" "$BY0" "$BX1" "$BY1"; do
    case "$n" in ''|*[!0-9.eE+-]*) die "BBOX component '$n' is not a number" ;; esac
  done
  # The struct pre-filter is what makes this cheap: it prunes parquet row groups
  # by statistics before a single geometry is decoded. ST_Intersects then trims
  # the bbox superset down to real overlaps.
  BBOX_SQL="    AND bbox.xmin <= $BX1 AND bbox.xmax >= $BX0
    AND bbox.ymin <= $BY1 AND bbox.ymax >= $BY0
    AND ST_Intersects(geometry, ST_MakeEnvelope($BX0, $BY0, $BX1, $BY1))"
  BBOX_NOTE="bbox $BBOX"
fi

THREADS_SQL=""
[ -n "$THREADS" ] && THREADS_SQL="SET threads=$THREADS;"

say "building $BBOX_NOTE admin layer
   release   $REL
   source    $SOURCE_GLOB
   geometry  $SIMPLIFY_NOTE
   memory    $MEMORY_LIMIT (spill dir $OUT/duckdb-tmp)
   out       $OUT/admin.fgb"

# ── 1. one DuckDB pass: Overture GeoParquet -> admin.fgb, directly ────────────
# SPATIAL_INDEX=YES is the whole point: the packed Hilbert R-tree is what lets
# the browser answer a map bbox with a handful of Range requests instead of
# downloading gigabytes. The write goes through duckdb-spatial's bundled GDAL
# (header note) — the output file's basename becomes the layer name, so
# `admin.fgb` keeps the layer named `admin` exactly as ogr2ogr's `-nln admin`
# did.
mkdir -p "$OUT/duckdb-tmp"
rm -f "$OUT/admin.fgb"
cat > "$OUT/admin.sql" <<EOF
-- Generated by tools/osm-world/build-admin.sh — Overture release $REL.
-- Source data © OpenStreetMap contributors, ODbL 1.0, via Overture Maps Foundation.
INSTALL httpfs; INSTALL spatial; LOAD httpfs; LOAD spatial;
SET s3_region='us-west-2';
SET memory_limit='$MEMORY_LIMIT';
SET temp_directory='$OUT/duckdb-tmp';
SET preserve_insertion_order=false;
$THREADS_SQL

-- SUBTYPE IS THE RANK, NOT \`admin_level\`. Overture's own \`admin_level\` column is a
-- per-country DEPTH (country = 0) and is NULL below county, so it cannot be used as
-- an OSM admin_level. \`subtype\` is populated for every row; map it explicitly.
-- The ordinals below are the OSM values the app already reasons about (2-10).
CREATE OR REPLACE MACRO ov_level(st) AS (
  CASE st WHEN 'country'      THEN 2
          WHEN 'dependency'   THEN 3
          WHEN 'region'       THEN 4
          WHEN 'county'       THEN 6
          WHEN 'localadmin'   THEN 7
          WHEN 'locality'     THEN 8
          WHEN 'macrohood'    THEN 9
          WHEN 'neighborhood' THEN 10 END);
-- 'microhood' is dropped on purpose: it is squares, quarters and named blocks, far
-- below anything the game reasons about, and it is the long tail of the row count.

COPY (
  SELECT ov_level(subtype)                                              AS admin_level,
         coalesce(names.primary, '')                                    AS "name",
         names.common['en']                                             AS "name:en",
         -- ISO3166-1 only where it means something. Overture fills \`country\` on
         -- every descendant row; copying it down would make \`worldAdminAreas\` read a
         -- county as a country, since it takes the first area carrying ISO3166-1.
         CASE WHEN subtype IN ('country','dependency') THEN country END AS "ISO3166-1",
         -- Likewise \`region\`: only the region row itself is an ISO 3166-2 entity.
         CASE WHEN subtype = 'region'                  THEN region  END AS "ISO3166-2",
         $GEOM_EXPR AS geometry
  FROM read_parquet('$SOURCE_GLOB')
  -- LOAD-BEARING. \`class = 'maritime'\` rows are EEZ / territorial-water polygons:
  -- they extend hundreds of km offshore and would put a coastal player "inside"
  -- a country whose land they are nowhere near. Land only.
  WHERE class = 'land'
    AND ov_level(subtype) IS NOT NULL
$BBOX_SQL
) TO '$OUT/admin.fgb'
  (FORMAT GDAL, DRIVER 'FlatGeobuf', SRS 'EPSG:4326',
   LAYER_CREATION_OPTIONS 'SPATIAL_INDEX=YES');
EOF

duckdb -f "$OUT/admin.sql"

# ── 2. Checksum sidecar ───────────────────────────────────────────────────────
# Written in `sha256sum -c` format so `cd "$OUT" && sha256sum -c admin.fgb.sha256`
# verifies a transferred copy, and so the merge step can copy the digest straight
# into the manifest's `sha256` field without recomputing it.
( cd "$OUT" && sha256sum admin.fgb > admin.fgb.sha256 )
say "sha256"
cat "$OUT/admin.fgb.sha256"

# ── 3. Verification probes ────────────────────────────────────────────────────
# A build that produced a plausible-looking file with the wrong column mapping is
# the failure this exists to catch — it is invisible until a player sees the wrong
# country. `-spat` uses the R-tree AND then tests real geometry, so these are
# point-in-polygon answers, not bbox hits, and each costs milliseconds.
FAIL=0

probe_expect() {          # label  minLon minLat maxLon maxLat  expected-iso1...
  local label="$1" x0="$2" y0="$3" x1="$4" y1="$5"; shift 5
  # Outside a BBOX subset build the probe is meaningless, not failing — skip it.
  if [ -n "$BBOX" ] && { awk "BEGIN{exit !($x1 < $BX0 || $x0 > $BX1 || $y1 < $BY0 || $y0 > $BY1)}"; }; then
    printf '   SKIP %-22s (outside BBOX)\n' "$label"
    return 0
  fi
  local got
  got="$(ogrinfo -ro -q -al -geom=NO -spat "$x0" "$y0" "$x1" "$y1" \
           -where "admin_level = 2" "$OUT/admin.fgb" \
         | sed -n 's/.*ISO3166-1 (String) = //p' | sort -u | tr '\n' ' ')"
  local missing=""
  for want in "$@"; do
    printf '%s' " $got" | grep -q " $want " || missing="$missing $want"
  done
  if [ -n "$missing" ]; then
    printf '   FAIL %-22s expected%s, got: %s\n' "$label" "$missing" "${got:-(nothing)}"
    FAIL=1
  else
    printf '   ok   %-22s level-2 ISO3166-1: %s\n' "$label" "$got"
  fi
}

say "verification probes"
# Grand Rapids, Michigan — the app's home map. A country polygon must reach here,
# which is exactly what a per-shard OSM build could never produce.
probe_expect "Grand Rapids" -85.6682 42.9633 -85.6680 42.9635 US
# Basel — three countries inside one 10 km box. Catches a build that kept only the
# outermost country per point, or that let maritime EEZs in.
probe_expect "Basel tri-border" 7.55 47.52 7.65 47.60 CH DE FR

FEATURES="$(ogrinfo -so -al "$OUT/admin.fgb" | sed -n 's/^Feature Count: //p')"
[ "${FEATURES:-0}" -gt 0 ] || { printf '   FAIL layer is empty\n'; FAIL=1; }
say "summary"
ogrinfo -so -al "$OUT/admin.fgb" | sed -n '1,8p;/^admin_level/,$p'
printf '   %s features, %s\n' "$FEATURES" "$(du -h "$OUT/admin.fgb" | cut -f1)"

[ "$FAIL" = "0" ] || die "verification probes FAILED — do not publish this file"

say "done. Deeper validation (enclaves, holes, the real client reader):
   node tools/osm-world/probe-admin.mjs $OUT/admin.fgb"
