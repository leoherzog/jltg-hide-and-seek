#!/usr/bin/env bash
# tools/osm-world/fgb-equal.sh — is FlatGeobuf A equivalent to FlatGeobuf B?
#
# build.py's per-layer pipeline is byte-reproducible, so sha256 is the real test.
# The semantic tiers cover the case where sha256 legitimately differs (a GDAL or
# osmium upgrade, a flag change) and the question is whether the DATA is the same.
#
#   TIER 1  sha256           the whole file. Cheap, and the one that should pass.
#   TIER 2  ogrinfo -so -al  layer name, geometry type, feature count, extent,
#                            field schema. Header only: instant.
#   TIER 3  sorted content   every feature as WKT + attributes, sorted, hashed.
#                            Reads both files end to end, so opt-in via --deep.
#
# USAGE
#   tools/osm-world/fgb-equal.sh a.fgb b.fgb            # tiers 1-2
#   tools/osm-world/fgb-equal.sh --deep a.fgb b.fgb     # tiers 1-3
#   tools/osm-world/fgb-equal.sh --deep --dir OLD NEW   # every *.fgb in two dirs
#
# Exit status is 0 only if every file compared came out equivalent.

set -uo pipefail

deep=0
dirmode=0
while [[ ${1:-} == --* ]]; do
  case "$1" in
    --deep) deep=1; shift ;;
    --dir)  dirmode=1; shift ;;
    --help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ $# -ne 2 ]]; then
  echo "usage: $0 [--deep] [--dir] <A> <B>" >&2
  exit 2
fi

# Tier 2: the header summary, minus the path line and the constant WGS 84 WKT.
summary() {
  ogrinfo -so -al "$1" 2>&1 \
    | grep -Ev '^INFO: Open of|^ *using driver|^$' \
    | sed -n '/^Layer name:/,$p' \
    | grep -Ev '^(GEOGCRS|ENSEMBLE|MEMBER|ELLIPSOID|LENGTHUNIT|ENSEMBLEACCURACY|PRIMEM|ANGLEUNIT|CS|AXIS|ORDER|USAGE|SCOPE|AREA|BBOX|ID|Layer SRS WKT|Data axis)|^ '
}

# Tier 3: every feature, sorted so the writer's Hilbert order cannot matter.
# LC_ALL=C so the sort is bytewise regardless of locale.
content_hash() {
  LC_ALL=C ogr2ogr -f CSV /vsistdout/ "$1" -lco GEOMETRY=AS_WKT -lco LINEFORMAT=LF 2>/dev/null \
    | LC_ALL=C sort \
    | sha256sum | cut -d' ' -f1
}

compare_one() {
  local a="$1" b="$2" label="$3" rc=0

  if [[ ! -f $a ]]; then echo "MISSING  $label  (no $a)"; return 1; fi
  if [[ ! -f $b ]]; then echo "MISSING  $label  (no $b)"; return 1; fi

  local ha hb
  ha=$(sha256sum "$a" | cut -d' ' -f1)
  hb=$(sha256sum "$b" | cut -d' ' -f1)
  if [[ $ha == "$hb" ]]; then
    echo "IDENTICAL  $label  sha256=$ha"
    return 0
  fi

  echo "BYTES DIFFER  $label"
  echo "    A $ha  ($(stat -c%s "$a") bytes)"
  echo "    B $hb  ($(stat -c%s "$b") bytes)"

  if ! diff <(summary "$a") <(summary "$b") > /tmp/fgb-equal.$$.diff 2>&1; then
    echo "  TIER2 FAIL  schema/count/extent differ:"
    sed 's/^/      /' /tmp/fgb-equal.$$.diff
    rc=1
  else
    echo "  tier2 ok    layer, geometry type, feature count, extent and fields all match"
  fi
  rm -f /tmp/fgb-equal.$$.diff

  if [[ $deep == 1 ]]; then
    local ca cb
    ca=$(content_hash "$a")
    cb=$(content_hash "$b")
    if [[ $ca == "$cb" ]]; then
      echo "  tier3 ok    sorted feature content identical ($ca)"
    else
      echo "  TIER3 FAIL  sorted feature content differs"
      echo "      A $ca"
      echo "      B $cb"
      rc=1
    fi
  fi
  return $rc
}

status=0
if [[ $dirmode == 1 ]]; then
  # Compare the union of both directories so an omitted layer is reported, not skipped.
  mapfile -t names < <(
    { ls "$1" 2>/dev/null; ls "$2" 2>/dev/null; } | grep '\.fgb$' | sort -u
  )
  if [[ ${#names[@]} -eq 0 ]]; then
    echo "no .fgb files found in $1 or $2" >&2
    exit 2
  fi
  for name in "${names[@]}"; do
    compare_one "$1/$name" "$2/$name" "$name" || status=1
  done
  echo
  [[ $status == 0 ]] && echo "ALL ${#names[@]} LAYERS EQUIVALENT" || echo "DIFFERENCES FOUND"
else
  compare_one "$1" "$2" "$(basename "$1") vs $(basename "$2")" || status=1
fi
exit $status
