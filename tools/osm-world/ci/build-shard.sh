#!/usr/bin/env bash
# tools/osm-world/ci/build-shard.sh — download, build, and upload ONE Geofabrik shard.
#
# DESIGN.md §Phase 4. Called once per shard by world-density-shards.yml and
# world-feature-shards.yml; works locally given the same env.
#
# Per shard: download the .osm.pbf and verify its .md5 by hand, run build.py on
# that extract (feature layers or density), upload via build.py --upload, then
# reclaim disk so a batch can run back-to-back on one runner.
#
# Do not swallow errors: a failed shard must exit non-zero, or the merge step's
# `features: 0` convention silently reports a short shard as empty.
set -euo pipefail

# args
KIND=""
ID=""
PBF_URL=""
MD5_URL=""
WORK_ROOT="${RUNNER_TEMP:-/tmp}/osm-world-shards"
R2_PREFIX_ROOT="shards"

usage() {
  echo "usage: $0 --kind density|feature --id ID --pbf-url URL --md5-url URL" \
       "[--work-root DIR] [--prefix-root PREFIX]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --kind) KIND="$2"; shift 2 ;;
    --id) ID="$2"; shift 2 ;;
    --pbf-url) PBF_URL="$2"; shift 2 ;;
    --md5-url) MD5_URL="$2"; shift 2 ;;
    --work-root) WORK_ROOT="$2"; shift 2 ;;
    --prefix-root) R2_PREFIX_ROOT="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

case "$KIND" in
  density|feature) ;;
  *) echo "error: --kind must be density or feature, got '$KIND'" >&2; exit 2 ;;
esac
[ -n "$ID" ] || { echo "error: --id required" >&2; exit 2; }
[ -n "$PBF_URL" ] || { echo "error: --pbf-url required" >&2; exit 2; }
[ -n "$MD5_URL" ] || { echo "error: --md5-url required" >&2; exit 2; }

# REPO_ROOT: this script lives at tools/osm-world/ci/build-shard.sh.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SHARD_WORK="$WORK_ROOT/$KIND/$ID"
rm -rf "$SHARD_WORK"
mkdir -p "$SHARD_WORK"
PBF="$SHARD_WORK/shard.osm.pbf"
OUT="$SHARD_WORK/out"
BUILD_WORK="$SHARD_WORK/work"

log() { echo "[build-shard $KIND/$ID] $*" >&2; }

# `/usr/bin/time -v -o FILE` keeps the resource report apart from build.py's
# stderr. On failure print it: peak RSS and wall clock tell an OOM kill from a
# bug, and an OOM-killed process writes no stderr. Success is printed by the
# `cat` further down.
on_exit() {
  local status=$?
  if [ "$status" -ne 0 ] && [ -f "$SHARD_WORK/time.log" ]; then
    echo "[build-shard $KIND/$ID] FAILED (exit $status) — resources used by the" \
         "failed attempt:" >&2
    cat "$SHARD_WORK/time.log" >&2
  fi
}
trap on_exit EXIT

# Mode args, computed BEFORE the download so a bad --id fails before the transfer.
#
# --unlink-source (feature only): delete the raw extract once stage 1's filtered
#   intermediate exists. The workflows' disk math (peak ≈ 2.6× source) assumes it.
# --clip-region (density only): the shard's assigned disjoint polygon from
#   cover-geometries/ (filename = id with '/' -> '__'). Without it ways in
#   Geofabrik's overlap buffer are counted by both neighbours. Missing is a hard
#   error: an unclipped density shard silently poisons the merge.
case "$KIND" in
  feature) MODE_ARGS=(--skip-density --unlink-source) ;;
  density)
    CLIP_FILE="$REPO_ROOT/tools/osm-world/cover-geometries/${ID//\//__}.geojson"
    if [ ! -f "$CLIP_FILE" ]; then
      echo "error: no assigned disjoint geometry for '$ID' at $CLIP_FILE —" \
           "regenerate with cover.py (it writes shards.json AND cover-geometries/" \
           "from the same run) and commit both" >&2
      exit 1
    fi
    MODE_ARGS=(--only density --clip-region "$CLIP_FILE")
    ;;
esac

# Download + verify. Geofabrik's .md5 sidecar names the dated file, not "-latest",
# so `md5sum -c` fails on the name alone; compare the hash by hand instead.
log "downloading $PBF_URL"
curl -fL --retry 5 --retry-connrefused --retry-delay 3 -o "$PBF" "$PBF_URL"

log "downloading $MD5_URL"
expected_md5="$(curl -fL --retry 5 --retry-connrefused --retry-delay 3 "$MD5_URL" | awk '{print $1}')"
if [ -z "$expected_md5" ]; then
  echo "error: $MD5_URL returned no parseable hash" >&2
  exit 1
fi
got_md5="$(md5sum "$PBF" | awk '{print $1}')"
if [ "$got_md5" != "$expected_md5" ]; then
  echo "error: md5 mismatch on $ID: expected $expected_md5, got $got_md5" >&2
  exit 1
fi
log "md5 ok ($got_md5)"

# Build.
# --no-fetch: a missing extract must be a hard error, never a planet download.
# --no-update: shards are one-shot extracts, never replication-diffed.
# --skip-md5: the file was verified above; stage 0 no-ops on an existing path anyway.
# --force: scratch runner, no cache to resume. A workflow-level retry is a full
#   re-download + rebuild.
log "building ($KIND)"
/usr/bin/time -v -o "$SHARD_WORK/time.log" uv run "$REPO_ROOT/tools/osm-world/build.py" \
  --planet "$PBF" \
  --no-fetch \
  --no-update \
  --skip-md5 \
  --out "$OUT" \
  --work "$BUILD_WORK" \
  --force \
  "${MODE_ARGS[@]}" \
  --upload \
  --prefix "$R2_PREFIX_ROOT/$KIND/$ID" \
  | tee "$SHARD_WORK/build.log"
cat "$SHARD_WORK/time.log" >&2

log "done — uploaded under r2://\$R2_BUCKET/$R2_PREFIX_ROOT/$KIND/$ID/"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "- \`$ID\` ($KIND) uploaded to \`$R2_PREFIX_ROOT/$KIND/$ID/\`"
  } >> "$GITHUB_STEP_SUMMARY"
fi

# Reclaim disk before the next shard in the batch starts.
rm -rf "$SHARD_WORK"
