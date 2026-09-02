#!/usr/bin/env bash
# build-admin.sh — the global administrative-boundary layer, from Overture.
#
# DESIGN.md Phase 2. Produces one `admin.fgb` with exactly the columns
# `osm/worldfile.js:worldAdminAreas` reads: `admin_level`, `name`, `name:en`,
# `ISO3166-1`, `ISO3166-2`. Overture is used because per-shard OSM builds
# cannot assemble boundary relations; Overture ships them assembled.
#
# ATTRIBUTION (REQUIRED). Overture's `divisions` theme derives from OpenStreetMap
# under ODbL 1.0 (share-alike). Anything served from this output must show:
#
#     © OpenStreetMap contributors, ODbL 1.0 — via Overture Maps Foundation
#
# The manifest records `admin_source: "overture"`; the release id goes to
# admin.meta.json only and is not served.
#
# USAGE
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
# DuckDB writes the FGB directly via duckdb-spatial's bundled GDAL: the CI
# runner's apt GDAL lacks the Parquet driver, so an ogr2ogr step cannot read a
# parquet intermediate there. The header declares Geometry "Unknown (any)";
# per-feature types are still written and osm/flatgeobuf.js reads those.
#
# Sizing (full 2026-07-22.0 build, 16 cores / 31 GB): 984,219 features;
# SIMPLIFY=0.0001 -> 2.29 GB, peak RSS 6.3 GB. Full precision -> 6.04 GB,
# peak RSS 13.1 GB. MEMORY_LIMIT=8GB works by spilling to `$OUT/duckdb-tmp`;
# budget ~10 GB of scratch there on CI.
#
# Rebuild rarely; boundaries move on a timescale of years.
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

# Driver preflights: a binary can exist and still lack the driver a step needs,
# so check both by name before any data moves. ogrinfo must READ FlatGeobuf
# (probes); duckdb-spatial's GDAL must CREATE it (build).
# grep WITHOUT -q on purpose: with pipefail, `grep -q` makes ogrinfo die of SIGPIPE.
ogrinfo --formats 2>/dev/null | grep "FlatGeobuf" >/dev/null \
  || die "this ogrinfo lacks the FlatGeobuf driver — the verification probes cannot run"
fgb_create="$(duckdb -noheader -list \
  -c "INSTALL spatial; LOAD spatial; SELECT count(*) FROM ST_Drivers() WHERE short_name = 'FlatGeobuf' AND can_create;" \
  2>/dev/null || true)"
[ "$fgb_create" = "1" ] \
  || die "duckdb-spatial's bundled GDAL cannot create FlatGeobuf (probe said '${fgb_create:-nothing}') — the direct admin.fgb write needs it"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

# SIMPLIFY: validate before it reaches SQL. ST_Multi gives a uniform MultiPolygon output.
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

# Overture prunes old releases from S3; check the listing first rather than
# fail mid-scan with an opaque HTTP error.
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

# Optional bbox subset (smoke runs).
BBOX_SQL=""
BBOX_NOTE="global"
if [ -n "$BBOX" ]; then
  IFS=, read -r BX0 BY0 BX1 BY1 <<<"$BBOX"
  [ -n "${BY1:-}" ] || die "BBOX must be 'minLon,minLat,maxLon,maxLat', got '$BBOX'"
  for n in "$BX0" "$BY0" "$BX1" "$BY1"; do
    case "$n" in ''|*[!0-9.eE+-]*) die "BBOX component '$n' is not a number" ;; esac
  done
  # The bbox struct pre-filter prunes parquet row groups before any geometry is decoded.
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

# 1. One DuckDB pass: Overture GeoParquet -> admin.fgb. SPATIAL_INDEX=YES is
# what lets the browser answer a bbox with a few Range requests. The output
# basename becomes the layer name (`admin`).
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

-- Overture's own \`admin_level\` is a per-country depth, NULL below county; map
-- \`subtype\` to the OSM admin_level values (2-10) instead.
CREATE OR REPLACE MACRO ov_level(st) AS (
  CASE st WHEN 'country'      THEN 2
          WHEN 'dependency'   THEN 3
          WHEN 'region'       THEN 4
          WHEN 'county'       THEN 6
          WHEN 'localadmin'   THEN 7
          WHEN 'locality'     THEN 8
          WHEN 'macrohood'    THEN 9
          WHEN 'neighborhood' THEN 10 END);
-- 'microhood' (squares, named blocks) is dropped on purpose.

COPY (
  SELECT ov_level(subtype)                                              AS admin_level,
         coalesce(names.primary, '')                                    AS "name",
         names.common['en']                                             AS "name:en",
         -- Overture fills \`country\` on every descendant row; copying it down would
         -- make \`worldAdminAreas\` read a county as a country.
         CASE WHEN subtype IN ('country','dependency') THEN country END AS "ISO3166-1",
         -- Likewise \`region\`.
         CASE WHEN subtype = 'region'                  THEN region  END AS "ISO3166-2",
         $GEOM_EXPR AS geometry
  FROM read_parquet('$SOURCE_GLOB')
  -- LOAD-BEARING: \`class = 'maritime'\` rows are EEZ polygons reaching hundreds of km offshore.
  WHERE class = 'land'
    AND ov_level(subtype) IS NOT NULL
$BBOX_SQL
) TO '$OUT/admin.fgb'
  (FORMAT GDAL, DRIVER 'FlatGeobuf', SRS 'EPSG:4326',
   LAYER_CREATION_OPTIONS 'SPATIAL_INDEX=YES');
EOF

duckdb -f "$OUT/admin.sql"

# 2. Checksum sidecar, in `sha256sum -c` format; the merge step copies the digest into the manifest.
( cd "$OUT" && sha256sum admin.fgb > admin.fgb.sha256 )
say "sha256"
cat "$OUT/admin.fgb.sha256"

# 3. Verification probes: catch a plausible file with the wrong column mapping.
# `-spat` tests real geometry, so these are point-in-polygon answers.
FAIL=0

probe_expect() {          # label  minLon minLat maxLon maxLat  expected-iso1...
  local label="$1" x0="$2" y0="$3" x1="$4" y1="$5"; shift 5
  # Outside a BBOX subset build the probe is meaningless; skip it.
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
# Grand Rapids, Michigan: the app's home map.
probe_expect "Grand Rapids" -85.6682 42.9633 -85.6680 42.9635 US
# Basel: three countries inside one 10 km box.
probe_expect "Basel tri-border" 7.55 47.52 7.65 47.60 CH DE FR

FEATURES="$(ogrinfo -so -al "$OUT/admin.fgb" | sed -n 's/^Feature Count: //p')"
[ "${FEATURES:-0}" -gt 0 ] || { printf '   FAIL layer is empty\n'; FAIL=1; }
say "summary"
ogrinfo -so -al "$OUT/admin.fgb" | sed -n '1,8p;/^admin_level/,$p'
printf '   %s features, %s\n' "$FEATURES" "$(du -h "$OUT/admin.fgb" | cut -f1)"

[ "$FAIL" = "0" ] || die "verification probes FAILED — do not publish this file"

say "done. Deeper validation (enclaves, holes, the real client reader):
   node tools/osm-world/probe-admin.mjs $OUT/admin.fgb"
