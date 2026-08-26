#!/usr/bin/env bash
# tools/osm-world/ci/build-shard.sh — download, build, and upload ONE Geofabrik shard.
#
# See DESIGN.md §Phase 4. Called in a loop, once per shard in its batch, by
# .github/workflows/world-density-shards.yml and world-feature-shards.yml. Not meant
# to be run standalone outside CI, though it will work locally given the same env.
#
# What it does, per shard:
#   1. curl -L the shard's .osm.pbf and its .md5 sidecar, verify by hand.
#   2. Run build.py against just that extract (feature layers only, or density only).
#   3. Let build.py's own --upload push the shard's output straight to R2.
#   4. Clean up its own disk footprint so a batch of shards can run back-to-back on
#      one runner without the disk climbing monotonically across the batch.
#
# A failed shard exits non-zero and leaves no half-uploaded manifest.json for that
# shard's prefix (build.py writes the manifest last, stage 5, after every layer is
# already up in stage-order — but *this script's* retry wrapper in the workflow is
# what makes a transient failure retry instead of silently reporting empty). Do not
# swallow errors here: the merge step's `features: 0` convention only means what it
# says if a failed shard is visibly absent/failed rather than silently short.
set -euo pipefail

# ── args ─────────────────────────────────────────────────────────────────────
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

# `/usr/bin/time -v` writes its resource report to ITS OWN stderr, which is the same
# fd as the child's — so the obvious `2> time.log` captured both, and build.py's
# stderr with it. That file was only `cat` on success, and `set -e` exits before
# reaching it, so a failed shard's job log ended after the last stage line and never
# said WHY. `-o FILE` (below) splits them: the report goes to a file, build.py's
# stderr stays on this script's stderr and lands in the job log live and in order.
#
# What is left worth rescuing on failure is the report itself — peak RSS and wall
# clock are how an OOM kill or a disk exhaustion is told apart from a bug, and an
# OOM-killed process writes no stderr at all. Fires only on a non-zero exit, so a
# successful run is not printed twice by the `cat` further down.
on_exit() {
  local status=$?
  if [ "$status" -ne 0 ] && [ -f "$SHARD_WORK/time.log" ]; then
    echo "[build-shard $KIND/$ID] FAILED (exit $status) — resources used by the" \
         "failed attempt:" >&2
    cat "$SHARD_WORK/time.log" >&2
  fi
}
trap on_exit EXIT

# ── mode args ────────────────────────────────────────────────────────────────
# Computed BEFORE the download: --kind density needs a cover geometry out of the
# checkout, and a missing one is a hard error. Discovering that after the transfer
# would throw away up to 7.90 GB (africa, the largest fine shard) for a bad --id.
#
# --unlink-source (feature only): delete the raw extract the moment stage 1's
#   filtered intermediate exists. Feature shards never run stage 4 — the only later
#   reader of the raw extract — and the deletion is what the workflows' runner-disk
#   math (peak ≈ 2.6× source) assumes; without it africa (7.90 GB) peaks ~28 GB
#   against ~22 GB of x64 runner disk.
# --clip-region (density only): the shard's ASSIGNED DISJOINT polygon from
#   cover.py's cover-geometries/ (in the checkout, committed next to shards.json;
#   filename = id with '/' -> '__'). Without it, every way whose first node lands
#   in Geofabrik's overlap buffer is counted by BOTH neighbouring shards and the
#   merged density grid double-counts. A missing geometry file is a hard error:
#   building an unclipped density shard would silently poison the merge.
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

# ── download + verify ───────────────────────────────────────────────────────
# Geofabrik's .md5 sidecar 302-redirects, and the redirect target names the DATED
# file it actually points at (e.g. "austria-260801.osm.pbf"), not "austria-latest".
# `md5sum -c` reads that filename field and fails the check on the name mismatch
# alone, even when the hash is fine — so this compares hashes by hand instead:
# curl -L to follow the redirect, then take only the first whitespace-separated
# token from whatever the sidecar contains.
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

# ── build ────────────────────────────────────────────────────────────────────
# --no-fetch: the planet arg is this shard's extract, already on disk — a bug that
#   left it missing must be a hard error, never a silent 85 GB planet download.
# --no-update: shards are a one-shot extract per run, never replication-diffed.
# --skip-md5: build.py's own stage 0 checksum is for a freshly-*downloaded* planet
#   file; irrelevant here since the file already exists (stage_fetch_planet no-ops
#   on an existing path) — passed anyway so intent reads correctly if that changes.
# --force: this is a scratch runner; there is no previous run's cache to resume.
#   (Consequence, documented in both workflows: a workflow-level retry of this
#   script is a FULL re-download + rebuild — the rm -rf above plus --force means
#   nothing survives between attempts.)
# MODE_ARGS carries the per-kind flags, computed above the download.
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

# ── cleanup ──────────────────────────────────────────────────────────────────
# Reclaim disk before the next shard in this job's batch starts — this is what
# lets a batch of N shards share one runner's ~22 GB (x64) without the footprint
# growing across the batch instead of staying roughly flat per-shard.
rm -rf "$SHARD_WORK"
