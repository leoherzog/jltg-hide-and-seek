#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// tools/mdb-snapshot.mjs — curate the Mobility Database catalogue into data/feeds.json
// ═══════════════════════════════════════════════════════════════════════════════
//
// The landing map needs one marker per city. It gets them from `data/feeds.json`, a
// tracked snapshot of the Mobility Database's open CSV catalogue — not from a live
// fetch. A snapshot means the page has no third-party dependency at load, the
// curation rules below are reviewable in a diff, and a bad upstream day cannot empty
// the map.
//
// REFRESHING THE SNAPSHOT
//
//   node tools/mdb-snapshot.mjs                     # fetch, curate, rewrite data/feeds.json
//   node tools/mdb-snapshot.mjs --check             # validate the committed file, no network
//   git diff --stat data/feeds.json                 # then read the diff before committing
//
// The tool prints a review summary against the file already on disk
// (`+18 added, -4 removed, 31 bboxes moved`) because a tool whose output is a tracked
// 810 KB file has to make its own diff auditable — the same discipline
// `tools/osm-world/build.py` follows.
//
//   node tools/mdb-snapshot.mjs --csv ./feeds_v2.csv       # offline, from a saved CSV
//   node tools/mdb-snapshot.mjs --regional-km 250          # long-distance cut-off
//   node tools/mdb-snapshot.mjs --out data/feeds.json      # destination
//   node tools/mdb-snapshot.mjs --snapshot 2026-08-23      # override the snapshot date
//   node tools/mdb-snapshot.mjs --json --quiet             # machine-readable summary
//   node tools/mdb-snapshot.mjs --counts                   # ALSO measure each feed's size
//   node tools/mdb-snapshot.mjs --counts --counts-concurrency 8
//
// DETERMINISM. Nothing here reads a clock: the `snapshot` date defaults to the newest
// `location.bounding_box.extracted_on` in the catalogue itself, rows are sorted by
// `id`, and every string comparison is by code point.
//
// The output is a function of the CSV and ONE other input — the `data/feeds.json`
// already on disk, which a row with no usable upstream bbox borrows its box from (see
// `toEntry`). Both inputs are in git, so a regeneration is still reproducible and
// still reviewable; what it is not is derivable from the CSV alone. Rows that took a
// carried box say so with `k`, and the run prints how many did, so the one place the
// file remembers something the catalogue no longer says is visible in both.
//
// `--counts` IS THE ONE EXCEPTION, AND IT IS OPT-IN FOR THAT REASON. The catalogue
// says where a feed is and never how big it is: there is no stop or route column in
// the CSV, and both APIs that carry one (`api.mobilitydatabase.org`, Transitland)
// need a credential a public build cannot hold. So `--counts` measures the feeds
// themselves, and that makes the run a function of what the mirror served TODAY —
// reproducible only against an unchanged mirror. The default run does not probe, and
// carries `t`/`u` forward from the file on disk untouched, so `node
// tools/mdb-snapshot.mjs` still means exactly what this header has always said it
// means. CI passes `--counts`; a human refreshing the catalogue by hand need not.
//
// HOW A FEED IS MEASURED WITHOUT DOWNLOADING IT. A GTFS zip keeps its index at the
// END, so three HTTP Range requests are enough for an exact count and the 19.8 MB
// body never moves:
//
//   1. the last 4 KB          → the EOCD record and, for a ~15-member archive, the
//                               whole central directory: every member's name, offset,
//                               compressed size and compression method
//   2. `stops.txt`'s bytes    → inflate, count by `location_type` (see `countStops`)
//   3. `routes.txt`'s bytes   → inflate, count data rows
//
// `stop_times.txt` is 90%+ of every feed and is never touched. Measured over a
// 60-feed spread of the catalogue: 3.0 requests and 40 KB per feed, 0 failures —
// about 135 MB and 2.5 minutes for the whole file at the default concurrency.
//
// A feed that cannot be measured — mirror 404, no Range support, ZIP64, a member that
// is not deflate or stored — is NOT an error and never drops a row. It keeps the
// numbers the previous snapshot recorded and is marked `q`, the same treatment `k`
// gives a withdrawn bounding box, and the run prints how many took it.
//
// Zero dependencies, Node 24. No build step — this is a `tools/` script, not part of
// the app; nothing in `lib/`, `gtfs/`, `osm/`, `rules/` or `render/` imports it.
// ═══════════════════════════════════════════════════════════════════════════════

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { inflateRawSync } from 'node:zlib';
import { EXAMPLE_MAPS } from '../lib/catalog.js';
import { MAX_FEEDS_PER_RUN } from '../lib/core.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/**
 * The v2 catalogue export.
 *
 * The older `sources.csv` behind `https://bit.ly/catalogs-csv` is still published and
 * this tool read it until now, but it holds only the `mdb-*` half of the catalogue and
 * leaves `urls.latest` EMPTY for 1,031 of those rows — every one of which had to be
 * dropped here for want of a fetchable mirror. v2 mirrors 4,056 feeds and carries the
 * national-aggregator and Transitland imports besides, which is where a system like
 * Holland's Macatawa Area Express (`tld-5873`) lives. Same columns, two renames:
 * `mdb_source_id` became `id` and its values became strings.
 *
 * No short link, so no redirect to record: this URL is both what is fetched and what
 * an offline `--csv` run writes into the snapshot header, so the two modes agree byte
 * for byte.
 */
const CATALOG_URL = 'https://files.mobilitydatabase.org/feeds_v2.csv';

/**
 * MobilityData's mirror of the latest fetched zip for each source. CORS-open for an
 * arbitrary origin, which is the whole reason the page reads the mirror and never the
 * agency's own URL.
 *
 * Every mirrored row spells this exactly one way — `MIRROR + id + MIRROR_SUFFIX`, all
 * 4,056 of them, no exceptions — so an entry stores no part of the URL at all: `id` is
 * the object name and `lib/catalog.js` rebuilds the rest. A row whose `urls.latest`
 * does not match that shape has no mirror this tool can reconstruct and is dropped;
 * in practice those are the 272 rows still parked on an openmobilitydata S3 bucket,
 * 269 of them deprecated already.
 */
const MIRROR = 'https://files.mobilitydatabase.org/';
const MIRROR_SUFFIX = '/latest.zip';

/** Above this, a feed is long-distance rather than a city, and becomes opt-in. */
const DEFAULT_REGIONAL_KM = 250;

/**
 * Feeds measured at once under `--counts`.
 *
 * 12 is the measured knee against the mirror: the 60-feed calibration run finished in
 * 2.7 s at 12 and gained nothing above it, because each feed is three small serial
 * round trips and the wall clock is latency, not bandwidth. Raising it mostly raises
 * the chance MobilityData's CDN starts shedding, and a shed feed costs a measurement.
 */
const DEFAULT_COUNTS_CONCURRENCY = 12;

/** Per-request ceiling under `--counts`. Generous: a slow mirror is not a failed one. */
const COUNTS_TIMEOUT_MS = 30_000;

/** Attempts per range request before a feed is given up on and carries its old numbers. */
const COUNTS_ATTEMPTS = 3;

/**
 * The tail read that hunts the zip's end-of-central-directory record.
 *
 * 4 KB rather than the 65,557 the format's maximum comment permits: a GTFS archive has
 * ~15 members and no comment, so 4 KB holds the EOCD *and* the whole central directory,
 * and the calibration run needed a second read for 0 of 60 feeds. The full read is
 * still there as the fallback when it does not (`readDirectory`), so the small default
 * costs correctness nothing.
 */
const ZIP_TAIL_BYTES = 4096;
const ZIP_TAIL_MAX = 65_557;

// 2: `id` is a catalogue id string rather than an integer, the mirror object name `f`
// is gone (it was always `id`), and `k` marks a carried bbox. `lib/catalog.js`'s
// CATALOG_VERSION moves with this.
// 3: `t`, `u` and `q` — how big the feed is, measured rather than catalogued (see
// `--counts` in the header). All three are optional and absent on an unprobed row, so
// a v2 file is a v3 file with no measurements; the version still moves because
// `lib/catalog.js` now RANKS on `t` and a reader that silently got none of them would
// order the catalogue by a field that is never there.
const SCHEMA_VERSION = 3;

/**
 * Every key an entry may carry, in the order it is written.
 *
 * `t` and `u` take the second letter of the word they abbreviate because the first is
 * long since spent: `s` is the subdivision and `r` is the regional flag.
 */
const ENTRY_KEYS = ['id', 'p', 'n', 'c', 's', 'm', 'b', 'd', 'a', 't', 'u', 'k', 'q', 'r', 'x'];
const OPTIONAL_KEYS = new Set(['n', 'd', 'a', 't', 'u', 'k', 'q', 'r', 'x']);

/** The bare flags among them: present means 1, absent means the row is not that. */
const FLAG_KEYS = new Set(['k', 'q', 'r', 'x']);

/** The two count keys, which are written and validated as a pair. */
const COUNT_KEYS = ['t', 'u'];

/**
 * A catalogue id. It is also the mirror's object name, so its charset is a property of
 * a URL path segment and not just of the CSV: anything outside this would have to be
 * escaped by every caller that rebuilds the download URL.
 */
const ID_RE = /^[A-Za-z0-9_-]+$/;

// ── argv ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const QUIET = argv.includes('--quiet');
const JSON_OUT = argv.includes('--json');
const CHECK_ONLY = argv.includes('--check');
const WITH_COUNTS = argv.includes('--counts');

/** `--flag value`, or null when absent. */
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

const OUT_PATH = path.resolve(REPO, flag('--out') || path.join('data', 'feeds.json'));
const CSV_PATH = flag('--csv');
const SNAPSHOT_OVERRIDE = flag('--snapshot');
const REGIONAL_KM = Number(flag('--regional-km') || DEFAULT_REGIONAL_KM);
const COUNTS_CONCURRENCY = Math.max(1, Number(flag('--counts-concurrency') || DEFAULT_COUNTS_CONCURRENCY));

// ── console helpers ──────────────────────────────────────────────────────────

const GREEN = '[32m';
const RED = '[31m';
const DIM = '[2m';
const RESET = '[0m';
const colour = process.stdout.isTTY ? (c, s) => `${c}${s}${RESET}` : (_c, s) => s;

function line(text = '') { if (!JSON_OUT) process.stdout.write(`${text}\n`); }
function chatter(text = '') { if (!QUIET) line(text); }
function fail(text) { process.stderr.write(`${colour(RED, 'ERROR')} ${text}\n`); }

/** Code-point string order. Never `localeCompare` — locale-dependent is non-deterministic. */
function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// ── CSV ──────────────────────────────────────────────────────────────────────

/**
 * RFC 4180 reader for a whole document. Handles quoted fields containing commas,
 * doubled quotes and embedded newlines. `gtfs/feed.js` has its own parser, but it is
 * streaming and worker-shaped; this is a one-shot 1.2 MB string and wants the simple
 * version rather than an export that widens that module's surface.
 * @param {string} text
 * @returns {string[][]} rows of raw fields, header included
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let started = false;             // distinguishes a quoted field from a bare one
  const push = () => { row.push(field); field = ''; started = false; };
  const endRow = () => { push(); rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') { field += ch; continue; }
      if (text[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
      continue;
    }
    if (ch === '"' && !started) { quoted = true; started = true; continue; }
    if (ch === ',') { push(); continue; }
    if (ch === '\r') continue;                       // CRLF and a lone CR both end here
    if (ch === '\n') { endRow(); continue; }
    field += ch;
    started = true;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

/**
 * Rows as objects keyed by header name. Column ORDER is never assumed — the upstream
 * header has changed shape before and will again.
 * @param {string} text
 * @returns {Record<string,string>[]}
 */
function csvRecords(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const rec = {};
    for (let i = 0; i < header.length; i++) rec[header[i]] = (cells[i] ?? '').trim();
    return rec;
  });
}

// ── geometry ─────────────────────────────────────────────────────────────────

/** 5 dp is ~1 m — finer than the catalogue's own boxes are worth. `+ 0` kills `-0`. */
function round5(v) { return Math.round(v * 1e5) / 1e5 + 0; }

/**
 * The catalogue's four bbox columns as `[S, W, N, E]` — Overpass order, `lib/geo.js`'s
 * convention, NOT GeoJSON. Drops straight into `options.borderBbox`.
 * @param {Record<string,string>} row
 * @returns {number[]|null} rounded box, or null when any edge fails to parse
 */
export function bboxOf(row) {
  const s = Number(row['location.bounding_box.minimum_latitude']);
  const w = Number(row['location.bounding_box.minimum_longitude']);
  const n = Number(row['location.bounding_box.maximum_latitude']);
  const e = Number(row['location.bounding_box.maximum_longitude']);
  const box = [s, w, n, e];
  if (box.some((v) => !Number.isFinite(v))) return null;
  return box.map(round5);
}

/**
 * Why this box cannot go on a map, or null when it can. Precedence matters: the zero
 * sentinel is by far the commonest and must be named first so the counts read true.
 * Runs on the ROUNDED box, so the committed file satisfies its own `--check`.
 * @param {number[]} b `[S, W, N, E]`
 * @returns {string|null}
 */
export function corruptReason(b) {
  const [s, w, n, e] = b;
  // MobilityData writes 0 for "no bounding box". Two real rows worldwide have a lone
  // zero longitude edge with honest latitudes; ~495 carry the sentinel. Cheap trade.
  if (s === 0 || w === 0 || n === 0 || e === 0) return 'zero edge (the no-bbox sentinel)';
  if (Math.abs(s) > 85 || Math.abs(n) > 85) return 'beyond 85 degrees latitude';
  if (!(s < n) || !(w < e)) return 'inverted or empty';
  if (n - s > 60) return 'latitude span over 60 degrees';
  if (e - w > 150) return 'longitude span over 150 degrees';
  if (n - s < 0.001 && e - w < 0.001) return 'degenerate (under 0.001 degrees in both axes)';
  return null;
}

/**
 * The longer of the box's two sides in km, measured at its own centroid latitude.
 * Max rather than diagonal: a long thin commuter-rail corridor is exactly what this
 * has to catch, and its diagonal barely differs from its length.
 * @param {number[]} b `[S, W, N, E]`
 * @returns {number} km
 */
export function spanKm(b) {
  const [s, w, n, e] = b;
  const midLat = ((s + n) / 2) * (Math.PI / 180);
  const lat = (n - s) * 110.574;
  const lon = Math.abs(e - w) * 111.320 * Math.cos(midLat);
  return Math.max(lat, lon);
}

// ── curation ─────────────────────────────────────────────────────────────────

/** http(s) only — the one scheme the page is willing to put in an `href`. */
export function isHttpUrl(value) {
  return typeof value === 'string'
    && (value.startsWith('http://') || value.startsWith('https://'));
}

/**
 * One catalogue row to one snapshot entry, or a reason string it was dropped.
 * The rules run in the order the counters print them.
 *
 * @param {Record<string,string>} row
 * @param {number[]|null} [priorBbox] the box the previous snapshot recorded for this
 *   id, offered as a fallback when the catalogue's own has stopped being usable
 * @returns {{entry: object|null, drop: string|null}}
 */
export function toEntry(row, priorBbox = null) {
  const drop = (why) => ({ entry: null, drop: why });

  if (row['data_type'] !== 'gtfs') return drop('not gtfs (realtime or gbfs)');
  // Only `deprecated` drops. v2 also spells `future` and `development`, which this
  // deliberately keeps: 15 of them ship in the file today, they are ordinary small
  // operators rather than bad data, and re-cutting the live/dead line is a curation
  // decision to take on its own evidence, not a side effect of changing CSV.
  const status = row['status'];                       // blank counts as live — most are
  if (status === 'deprecated') return drop('deprecated');

  // The id is read before the box because it is both the mirror's object name and the
  // key the carry-forward below looks the previous snapshot up by.
  const id = row['id'];
  if (!id || !ID_RE.test(id)) return drop('no usable source id');

  // A row whose own box has stopped being usable keeps the box already on disk, when
  // there is one. An upstream extraction that regresses is not a transit system that
  // moved, and dropping a live feed over it costs a reader a city. `k` marks the row
  // so the borrow is legible in the file itself and not only in this run's summary.
  //
  // Only a CITY-SIZED box is carried, though. An empty bbox column is the catalogue
  // withdrawing a claim about where a feed is, and re-asserting a withdrawn claim is
  // only defensible where the claim was modest: every oversized box this rule was
  // offered belonged to a national aggregate and was already wrong on its face — the
  // Germany-wide DELFI feed boxed in Argentina, a Dutch one spanning Pau to Lithuania.
  // Those are what upstream is RIGHT to stop publishing. Cutting at the same 250 km
  // that decides `r` also means a carried row is always one the map actually shows,
  // so the rule can only ever restore a city, never pad the opt-in lists.
  let b = bboxOf(row);
  let bad = b ? corruptReason(b) : 'does not parse';
  let carried = false;
  if (bad && Array.isArray(priorBbox) && priorBbox.length === 4
      && !corruptReason(priorBbox) && spanKm(priorBbox) <= REGIONAL_KM) {
    b = priorBbox.slice();
    bad = null;
    carried = true;
  }
  if (bad) return drop(`bbox ${bad}`);

  const provider = row['provider'];
  if (!provider) return drop('no provider');

  // No part of the mirror URL is stored: it is `MIRROR + id + MIRROR_SUFFIX` for every
  // mirrored row in the catalogue, so `id` already is the object name and keeping the
  // rest would be ~40 redundant bytes a row across 3,300 of them. Matching the whole
  // string rather than its ends is what makes that identity checked rather than
  // assumed — a row shaped any other way has no mirror the page can rebuild.
  if (row['urls.latest'] !== `${MIRROR}${id}${MIRROR_SUFFIX}`) return drop('no mirror URL');

  const entry = {
    id,
    p: provider,
    c: row['location.country_code'],
    s: row['location.subdivision_name'],
    m: row['location.municipality'],
    b,
  };
  // `name` is the sub-feed label (Estonia's per-county feeds, an operator's second
  // network). Omitted when it is empty or just repeats the provider.
  const name = row['name'];
  if (name && name !== provider) entry.n = name;
  // The producer's own URL. Never auto-fetched — usually no CORS — but it is the only
  // href for an auth-gated row and the fallback when a mirror 404s.
  //
  // Only http(s) is kept. The page renders this value into an `href`, and escaping
  // stops markup injection but does not neutralise a SCHEME: one upstream row
  // spelling `javascript:` would ship a live link inside an 810 KB generated file
  // nobody line-reads. A row whose only URL is something else keeps its marker and
  // loses the link.
  const direct = row['urls.direct_download'];
  if (direct && isHttpUrl(direct)) entry.d = direct;
  // Flag, never drop: the page shows these and says the browser cannot fetch them.
  const auth = Number(row['urls.authentication_type']);
  if (row['urls.authentication_type'] && Number.isFinite(auth) && auth !== 0) entry.a = auth;
  if (carried) entry.k = 1;
  if (status === 'inactive') entry.x = 1;
  return { entry, drop: null };
}

/**
 * One row per `(provider, bbox)`, keeping the code-point-lowest id — VBB and the
 * Estonian county set each publish the same box several times over.
 *
 * Code point is the only total order a catalogue id has left now that ids are strings,
 * and it happens to break the tie the useful way: `mdb-` sorts below `ntd-`, `tdg-`,
 * `tfs-` and `tld-`, so where a hand-curated entry and an auto-imported one describe
 * the same network, the curated one — better municipality, better provider name — is
 * the one that survives.
 * @param {object[]} entries
 * @returns {{kept: object[], removed: number}}
 */
export function dedupe(entries) {
  const seen = new Map();
  for (const entry of entries) {
    const key = `${entry.p} ${entry.b.join(',')}`;
    const prev = seen.get(key);
    if (!prev || cmpStr(entry.id, prev.id) < 0) seen.set(key, entry);
  }
  const kept = [...seen.values()].sort((a, b) => cmpStr(a.id, b.id));
  return { kept, removed: entries.length - kept.length };
}

/** An entry rebuilt in `ENTRY_KEYS` order, so the JSON text is stable. */
function ordered(entry) {
  const out = {};
  for (const k of ENTRY_KEYS) if (entry[k] !== undefined) out[k] = entry[k];
  return out;
}

// ── the snapshot file ────────────────────────────────────────────────────────

/**
 * One JSON object per line inside `rows`, so `git diff` shows which feeds moved
 * rather than one 810 KB blob. The document's own opening brace is line 1; every
 * other line beginning `{` is exactly one feed.
 * @param {object} doc
 * @returns {string}
 */
export function serialiseSnapshot(doc) {
  const head = [
    '{',
    `  "version": ${JSON.stringify(doc.version)},`,
    `  "snapshot": ${JSON.stringify(doc.snapshot)},`,
    `  "source": ${JSON.stringify(doc.source)},`,
    `  "mirror": ${JSON.stringify(doc.mirror)},`,
    `  "mirrorSuffix": ${JSON.stringify(doc.mirrorSuffix)},`,
    `  "regionalKm": ${JSON.stringify(doc.regionalKm)},`,
    `  "count": ${JSON.stringify(doc.count)},`,
    '  "rows": [',
  ];
  const rows = doc.rows.map((r) => JSON.stringify(ordered(r)));
  return `${head.join('\n')}\n${rows.join(',\n')}\n  ]\n}\n`;
}

/**
 * @param {object[]} entries id-ascending, already classified
 * @param {string} outPath
 * @param {{snapshot: string, source: string}} meta
 * @returns {Promise<{doc: object, text: string}>}
 */
export async function writeSnapshot(entries, outPath, meta) {
  const doc = {
    version: SCHEMA_VERSION,
    snapshot: meta.snapshot,
    source: meta.source,
    mirror: MIRROR,
    mirrorSuffix: MIRROR_SUFFIX,
    regionalKm: REGIONAL_KM,
    count: entries.length,
    rows: entries,
  };
  const text = serialiseSnapshot(doc);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, text, 'utf8');
  return { doc, text };
}

/**
 * What changed against the file already on disk. Printed on every regeneration so a
 * 810 KB diff can be reviewed as a sentence before it is read as a diff.
 * @param {object|null} old
 * @param {object} next
 * @returns {object} counts
 */
export function diffSummary(old, next) {
  if (!old || !Array.isArray(old.rows)) {
    return { fresh: true, added: next.count, removed: 0, moved: 0, newlyRegional: 0, resized: 0 };
  }
  const before = new Map(old.rows.map((r) => [r.id, r]));
  const after = new Map(next.rows.map((r) => [r.id, r]));
  let added = 0;
  let removed = 0;
  let moved = 0;
  let newlyRegional = 0;
  let resized = 0;
  for (const [id, row] of after) {
    const prev = before.get(id);
    if (!prev) { added++; continue; }
    if (prev.b.join(',') !== row.b.join(',')) moved++;
    if (!prev.r && row.r) newlyRegional++;
    // Only counts that MOVED, not counts that appeared: the run that first measures
    // the catalogue would otherwise report 3,309 changes and say nothing.
    if ((prev.t || prev.u) && (prev.t !== row.t || prev.u !== row.u)) resized++;
  }
  for (const id of before.keys()) if (!after.has(id)) removed++;
  return { fresh: false, added, removed, moved, newlyRegional, resized };
}

// ── --check ──────────────────────────────────────────────────────────────────

/**
 * Every invariant the runtime is allowed to assume, checked without a network. A
 * hand-edit that breaks one of these fails here, not on the landing map.
 * @param {string} filePath
 * @returns {Promise<{ok: boolean, problems: string[], doc: object|null}>}
 */
export async function checkSnapshot(filePath) {
  const problems = [];
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    return { ok: false, problems: [`cannot read ${filePath}: ${err.message}`], doc: null };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { ok: false, problems: [`not valid JSON: ${err.message}`], doc: null };
  }
  const say = (cond, msg) => { if (!cond) problems.push(msg); };

  say(doc.version === SCHEMA_VERSION, `version is ${doc.version}, expected ${SCHEMA_VERSION}`);
  for (const k of ['snapshot', 'source', 'mirror', 'mirrorSuffix']) {
    say(typeof doc[k] === 'string' && doc[k].length > 0, `${k} is not a non-empty string`);
  }
  say(Number.isFinite(doc.regionalKm) && doc.regionalKm > 0, 'regionalKm is not a positive number');
  say(Array.isArray(doc.rows), 'rows is not an array');
  if (!Array.isArray(doc.rows)) return { ok: false, problems, doc };
  say(doc.count === doc.rows.length, `count ${doc.count} is not rows.length ${doc.rows.length}`);

  // One object per line, so a regeneration is reviewable as a line diff.
  const objectLines = text.split('\n').filter((l) => l.startsWith('{"')).length;
  say(objectLines === doc.rows.length,
    `${objectLines} lines begin a row object, expected ${doc.rows.length}`);

  const ids = new Set();
  const pairs = new Set();
  let lastId = '';
  for (const row of doc.rows) {
    if (!row || typeof row !== 'object') { problems.push('a row is not an object'); continue; }
    const at = `row id=${row.id}`;
    say(typeof row.id === 'string' && ID_RE.test(row.id),
      `${at}: id is not a catalogue id`);
    say(!ids.has(row.id), `${at}: duplicate id`);
    ids.add(row.id);
    say(cmpStr(row.id, lastId) > 0, `${at}: rows are not sorted ascending by id`);
    lastId = row.id;

    say(typeof row.p === 'string' && row.p.length > 0, `${at}: p is empty`);

    const b = row.b;
    if (!Array.isArray(b) || b.length !== 4 || b.some((v) => !Number.isFinite(v))) {
      problems.push(`${at}: b is not four finite numbers`);
    } else {
      const [s, w, n, e] = b;
      say(s >= -90 && n <= 90 && s < n, `${at}: latitudes out of order or out of range`);
      say(w >= -180 && e <= 180 && w < e, `${at}: longitudes out of order or out of range`);
      say(Math.abs(s) <= 85 && Math.abs(n) <= 85, `${at}: beyond 85 degrees latitude`);
      say(!b.some((v) => v === 0), `${at}: a bbox edge is exactly 0`);
      const km = spanKm(b);
      if (row.r) say(km > doc.regionalKm, `${at}: flagged regional but spans only ${Math.round(km)} km`);
      else say(km <= doc.regionalKm, `${at}: spans ${Math.round(km)} km but is not flagged regional`);
      const key = `${row.p} ${b.join(',')}`;
      say(!pairs.has(key), `${at}: duplicate (provider, bbox)`);
      pairs.add(key);
    }

    // `q` says "these numbers are older than this snapshot", so it is meaningless
    // without numbers to be older than.
    say(!row.q || row.t !== undefined || row.u !== undefined,
      `${at}: q is set but the row carries no counts`);

    for (const [k, v] of Object.entries(row)) {
      say(ENTRY_KEYS.includes(k), `${at}: unexpected key ${JSON.stringify(k)}`);
      say(v !== null, `${at}: key ${k} is null`);
      if (!OPTIONAL_KEYS.has(k)) continue;
      if (FLAG_KEYS.has(k)) say(v === 1, `${at}: ${k} is ${JSON.stringify(v)}, expected 1`);
      if (k === 'a') say(Number.isInteger(v) && v !== 0, `${at}: a is not a non-zero integer`);
      if (k === 'n' || k === 'd') say(typeof v === 'string' && v.length > 0, `${at}: ${k} is empty`);
      // A measured count is a positive integer or it is not written. Zero is the shape
      // a failed read takes, and `lib/catalog.js` ranks on `t` — a zero there would
      // sort a real operator below every unmeasured row in its own city.
      if (COUNT_KEYS.includes(k)) {
        say(Number.isInteger(v) && v > 0, `${at}: ${k} is ${JSON.stringify(v)}, expected a positive integer`);
      }
      // `d` becomes an `href` on the page, so its SCHEME is an invariant of the file,
      // not a property of whatever the upstream happened to publish today.
      if (k === 'd') say(isHttpUrl(v), `${at}: d is not an http(s) URL`);
    }
  }

  // The example maps (`lib/catalog.js`) name rows by id. A regeneration that drops
  // one, or an upstream that puts one behind a key, breaks a chip on the landing
  // page — so it fails here, where the diff is being reviewed, with the fix named.
  const byId = new Map(doc.rows.map((row) => [row.id, row]));
  const keys = new Set();
  for (const ex of EXAMPLE_MAPS) {
    const at = `example map ${ex.key}`;
    say(!keys.has(ex.key), `${at}: duplicate key`);
    keys.add(ex.key);
    say(ex.ids.length > 0 && ex.ids.length <= MAX_FEEDS_PER_RUN,
      `${at}: ${ex.ids.length} feeds, the run cap is ${MAX_FEEDS_PER_RUN}`);
    say(new Set(ex.ids).size === ex.ids.length, `${at}: repeats an id`);
    for (const id of ex.ids) {
      const row = byId.get(id);
      say(Boolean(row), `${at}: ${id} is not in the catalogue`);
      if (!row) continue;
      say(!row.a, `${at}: ${id} (${row.p}) needs an API key`);
      say(!row.x, `${at}: ${id} (${row.p}) is no longer updated`);
    }
  }
  return { ok: problems.length === 0, problems, doc };
}

// ── fetch ────────────────────────────────────────────────────────────────────

/**
 * The catalogue CSV. Node follows the short link's 302; the RESOLVED URL is what goes
 * in the snapshot header, so a reader knows exactly which object was read.
 * @param {string} url
 * @returns {Promise<{text: string, url: string}>}
 */
export async function fetchCatalog(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`catalogue fetch failed: HTTP ${res.status} ${res.statusText}`);
  return { text: await res.text(), url: res.url || url };
}

// ── counts (--counts) ────────────────────────────────────────────────────────
//
// Enough of the ZIP format to read two members out of a remote archive, and no more.
// This is not a general unzipper and must not grow into one: it reads the central
// directory, then the bytes of two named members, and everything it cannot handle it
// declines by throwing so the caller carries the previous snapshot's numbers instead.

const EOCD_SIG = 0x06054b50;
const CD_ENTRY_SIG = 0x02014b50;
const ZIP_STORED = 0;
const ZIP_DEFLATE = 8;

/**
 * One HTTP Range request, retried on anything transient.
 *
 * A 200 is a FAILURE here, not a success: it means the server ignored `Range` and is
 * about to hand over a 300 MB body one line at a time. The whole design rests on 206,
 * so a server that will not do partial content is declined rather than indulged.
 *
 * @param {string} url @param {string} spec an HTTP range spec — `0-4095`, `-4096`
 * @returns {Promise<Buffer>}
 */
async function rangeGet(url, spec) {
  let last;
  for (let attempt = 1; attempt <= COUNTS_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Range: `bytes=${spec}` },
        signal: AbortSignal.timeout(COUNTS_TIMEOUT_MS),
      });
      if (res.status === 200) throw new Error('server ignored Range (200, not 206)');
      if (res.status !== 206) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      last = err;
      // Linear, not exponential: three tries against a CDN that is either there or
      // not, and a catalogue-wide run cannot afford a long tail of sleeping workers.
      if (attempt < COUNTS_ATTEMPTS) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw last;
}

/** The last `EOCD_SIG` in a buffer, scanning backwards as the format requires. */
function findEocd(buf) {
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  return -1;
}

/**
 * Every member of a remote zip, from its central directory.
 *
 * Reads the tail once at `ZIP_TAIL_BYTES` and again at the format's maximum only if
 * the first read missed the EOCD, then re-reads the directory separately only if it
 * did not already land inside the tail — so the common case is exactly one request.
 *
 * @param {string} url
 * @returns {Promise<{name: string, method: number, csize: number, usize: number, offset: number}[]>}
 */
export async function readDirectory(url) {
  let tailLen = ZIP_TAIL_BYTES;
  let tail = await rangeGet(url, `-${tailLen}`);
  let at = findEocd(tail);
  if (at < 0 && tail.length >= tailLen) {
    tailLen = ZIP_TAIL_MAX;
    tail = await rangeGet(url, `-${tailLen}`);
    at = findEocd(tail);
  }
  // A mirror object that is not a zip at all is the commonest way this fails, and
  // "no end-of-central-directory record" describes the symptom rather than the cause.
  // Four rows in the catalogue today serve an HTML error page from the mirror.
  if (at < 0) {
    const head = tail.subarray(0, 64).toString('latin1').trimStart().toLowerCase();
    throw new Error(head.startsWith('<htm') || head.startsWith('<!do') || head.startsWith('<?xml')
      ? 'the mirror served a web page, not a zip'
      : 'no end-of-central-directory record');
  }

  const entryCount = tail.readUInt16LE(at + 10);
  const cdSize = tail.readUInt32LE(at + 12);
  const cdOffset = tail.readUInt32LE(at + 16);
  // ZIP64 is declined rather than implemented: it needs a 64-bit EOCD locator, a
  // second directory format and per-entry extra-field parsing, and the calibration
  // run met it 0 times in 60 feeds. A row that hits it carries its old numbers.
  // The three sentinels ARE the detection — scanning the tail for the ZIP64 locator's
  // signature would read compressed payload as structure and reject valid archives on
  // a four-byte coincidence.
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || entryCount === 0xffff) {
    throw new Error('ZIP64 archive');
  }

  // The central directory ends exactly where the EOCD begins, so the EOCD's file
  // offset is `cdOffset + cdSize` and it sits at `at` inside the tail. That fixes
  // where the tail starts, and lets an offset already inside it be sliced rather than
  // requested a second time.
  const tailStart = cdOffset + cdSize - at;
  const cd = cdOffset >= tailStart
    ? tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize)
    : await rangeGet(url, `${cdOffset}-${cdOffset + cdSize - 1}`);

  const entries = [];
  let p = 0;
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CD_ENTRY_SIG) {
      throw new Error(`central directory truncated at entry ${i} of ${entryCount}`);
    }
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const extraAt = p + 46 + nameLen;
    const entry = {
      name: cd.toString('utf8', p + 46, extraAt),
      method: cd.readUInt16LE(p + 10),
      csize: cd.readUInt32LE(p + 20),
      usize: cd.readUInt32LE(p + 24),
      offset: cd.readUInt32LE(p + 42),
      disk: cd.readUInt16LE(p + 34),
    };
    widenZip64(entry, cd.subarray(extraAt, extraAt + extraLen));
    entries.push(entry);
    p = extraAt + extraLen + cd.readUInt16LE(p + 32);
  }
  return entries;
}

/**
 * Replace an entry's 32-bit sentinels with the real values from its ZIP64 extra field.
 *
 * A per-entry ZIP64 record is NOT the same thing as a ZIP64 archive, and conflating
 * them cost 24 feeds on the first catalogue-wide run. Several publishers write
 * `0xFFFFFFFF` sizes into every entry — a streaming zip writer that will not seek back
 * to patch them — while the archive's own EOCD stays perfectly 32-bit. mdb-1052 is
 * 248 KB and does exactly this. Read the sentinels literally and the reader asks for a
 * 4 GB range on a quarter-megabyte file.
 *
 * The 0x0001 field carries ONLY the members that were sentinelled, in a fixed order:
 * uncompressed size, compressed size, local header offset, disk number. There is no
 * length prefix per value — which of them are present is inferred from which of the
 * fixed-record fields is 0xFFFF(FFFF), so the order of these four `if`s is the format.
 *
 * @param {{csize: number, usize: number, offset: number, disk: number}} entry mutated
 * @param {Buffer} extra the central-directory extra field
 */
function widenZip64(entry, extra) {
  if (entry.csize !== 0xffffffff && entry.usize !== 0xffffffff && entry.offset !== 0xffffffff) return;
  for (let p = 0; p + 4 <= extra.length;) {
    const id = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    const body = extra.subarray(p + 4, p + 4 + size);
    p += 4 + size;
    if (id !== 0x0001) continue;
    let q = 0;
    const take64 = () => {
      if (q + 8 > body.length) throw new Error('ZIP64 extra field is short');
      const v = body.readBigUInt64LE(q);
      q += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ZIP64 value beyond 2^53');
      return Number(v);
    };
    if (entry.usize === 0xffffffff) entry.usize = take64();
    if (entry.csize === 0xffffffff) entry.csize = take64();
    if (entry.offset === 0xffffffff) entry.offset = take64();
    if (entry.disk === 0xffff && q + 4 <= body.length) entry.disk = body.readUInt32LE(q);
    return;
  }
  throw new Error('a size is 0xFFFFFFFF but the entry has no ZIP64 extra field');
}

/**
 * One member's bytes, decompressed.
 *
 * The SIZES come from the central directory, never from the local header: a zip
 * written as a stream leaves the local header's sizes zero and defers them to a data
 * descriptor after the payload. Only the two variable-length local fields are read
 * here, and those are always correct — the request deliberately overshoots by
 * `ZIP_TAIL_BYTES` so the header and the whole payload arrive together.
 *
 * @param {string} url @param {{method: number, csize: number, offset: number}} entry
 * @returns {Promise<Buffer>}
 */
export async function readMember(url, entry) {
  if (entry.method !== ZIP_STORED && entry.method !== ZIP_DEFLATE) {
    throw new Error(`unsupported compression method ${entry.method}`);
  }
  const end = entry.offset + 30 + ZIP_TAIL_BYTES + entry.csize;
  const raw = await rangeGet(url, `${entry.offset}-${end}`);
  if (raw.length < 30) throw new Error('local header truncated');
  const start = 30 + raw.readUInt16LE(26) + raw.readUInt16LE(28);
  const body = raw.subarray(start, start + entry.csize);
  if (body.length < entry.csize) throw new Error('member payload truncated');
  return entry.method === ZIP_STORED ? body : inflateRawSync(body);
}

/**
 * A member's name inside the archive, lowercased and stripped of any directory.
 * A GTFS zip is allowed to nest its txt files one folder deep, and plenty do.
 */
const memberBase = (name) => name.split('/').pop().toLowerCase();

/** A member by GTFS filename, or null when the archive has none. */
const memberNamed = (entries, file) => entries.find((e) => memberBase(e.name) === file) || null;

/**
 * The data rows of a GTFS table, as arrays.
 *
 * Reuses `parseCsv` rather than splitting on newlines because `stop_name` routinely
 * contains a comma AND, in a handful of feeds, a newline — both inside quotes, both
 * invisible to a line count. Strips a UTF-8 BOM off the first header cell, which a
 * surprising number of publishers emit.
 *
 * @param {Buffer} buf
 * @returns {{header: string[], rows: string[][]}}
 */
function readTable(buf) {
  const rows = parseCsv(buf.toString('utf8'));
  if (!rows.length) return { header: [], rows: [] };
  const header = rows[0].map((h, i) => (i === 0 ? h.replace(/^﻿/, '') : h).trim());
  // A trailing newline parses to one empty final row; a blank line mid-file is not
  // data either. Both are dropped by the same test.
  const data = rows.slice(1).filter((r) => r.length > 1 || (r[0] || '') !== '');
  return { header, rows: data };
}

/**
 * How many places this feed serves — STATIONS where it models them, stops otherwise.
 *
 * The raw row count of `stops.txt` is the wrong number for exactly the systems this
 * ranking exists to surface. NYC Subway writes 1,488 rows: 496 parent stations
 * (`location_type=1`) and 992 platforms beneath them. 496 is the figure a reader
 * means by "how big is the subway"; 1,488 is an artefact of how thoroughly MTA models
 * its platforms, and it would rank the subway above systems several times its size.
 *
 * So: count parent stations when the feed has any, and its plain stops when it does
 * not. Entrances (2), generic nodes (3) and boarding areas (4) are never places to
 * ride from and are counted in neither branch. A feed with no `location_type` column
 * at all — legal, and common in small feeds — is all stops by definition.
 *
 * @param {Buffer} buf `stops.txt`
 * @returns {number}
 */
export function countStops(buf) {
  const { header, rows } = readTable(buf);
  const at = header.indexOf('location_type');
  if (at < 0) return rows.length;
  let stations = 0;
  let stops = 0;
  for (const row of rows) {
    const kind = (row[at] || '').trim();
    if (kind === '1') stations++;
    else if (kind === '' || kind === '0') stops++;
  }
  return stations > 0 ? stations : stops;
}

/** How many routes this feed publishes: `routes.txt` data rows, and nothing subtler. */
export function countRoutes(buf) {
  return readTable(buf).rows.length;
}

/**
 * One feed measured, or a reason it could not be.
 *
 * Never throws. A feed that cannot be read is a row that keeps the numbers it already
 * had — the catalogue is 3,309 feeds against third-party infrastructure and a single
 * 404 must not cost a refresh.
 *
 * @param {string} url the mirror object
 * @returns {Promise<{t: number|null, u: number|null, why: string|null}>}
 */
export async function measureFeed(url) {
  try {
    const entries = await readDirectory(url);
    const stops = memberNamed(entries, 'stops.txt');
    const routes = memberNamed(entries, 'routes.txt');
    if (!stops && !routes) throw new Error('neither stops.txt nor routes.txt is in the archive');
    const t = stops ? countStops(await readMember(url, stops)) : null;
    const u = routes ? countRoutes(await readMember(url, routes)) : null;
    // A zip whose tables are headers and nothing else. Eight rows in the catalogue are
    // like this — Columbia University's shuttle among them — and they read as a
    // successful measurement of nothing, which is the one shape the caller cannot tell
    // apart from a failure on its own. Naming it here is what keeps it out of the
    // summary as a bare `null`, and it stays UNMEASURED rather than being written as a
    // zero, because a feed with no stops is a publishing accident, not a small system.
    if (!t && !u) throw new Error('the archive has no stops and no routes');
    return { t, u, why: null };
  } catch (err) {
    return { t: null, u: null, why: reasonOf(err) };
  }
}

/**
 * An error as a groupable one-line reason.
 *
 * Never returns `"null"` or `"undefined"`. The first run over the catalogue produced
 * eight of those and they named nothing at all — a summary line whose whole job is to
 * tell a reviewer which feeds to look at cannot spend a row on a value that says a
 * throw happened without saying what it was.
 */
function reasonOf(err) {
  if (err && typeof err.message === 'string' && err.message) {
    // `fetch` reports a whole class of network faults as a bare "fetch failed" and
    // hides the real one underneath.
    const cause = err.cause && err.cause.message ? ` (${err.cause.message})` : '';
    return `${err.message}${cause}`;
  }
  if (err && err.name) return err.name;
  return `threw ${Object.prototype.toString.call(err)}`;
}

/**
 * Measure every entry, `COUNTS_CONCURRENCY` at a time, writing `t`/`u`/`q` in place.
 *
 * A measurement of 0 is thrown away rather than written. Zero stops is not a small
 * system, it is a broken read or an empty archive, and writing it would sort a real
 * operator to the bottom of every search on a number that is not true.
 *
 * @param {object[]} entries mutated in place
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<{measured: number, carried: number, missing: number, reasons: Map<string, number>}>}
 */
export async function measureAll(entries, onProgress) {
  const reasons = new Map();
  let measured = 0;
  let carried = 0;
  let missing = 0;
  let done = 0;
  let next = 0;

  /** Write a successful measurement onto the row. Absent numbers are cleared, not kept. */
  const accept = (entry, t, u) => {
    if (t) entry.t = t; else delete entry.t;
    if (u) entry.u = u; else delete entry.u;
    delete entry.q;
  };

  const failed = [];
  const worker = async () => {
    for (let i = next++; i < entries.length; i = next++) {
      const entry = entries[i];
      const { t, u, why } = await measureFeed(`${MIRROR}${entry.id}${MIRROR_SUFFIX}`);
      if (t || u) { accept(entry, t, u); measured++; } else failed.push({ entry, why });
      done++;
      if (onProgress && done % 100 === 0) onProgress(done, entries.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(COUNTS_CONCURRENCY, entries.length) }, worker));

  // A SECOND PASS, SERIALLY, over whatever failed. `rangeGet` already retries a request
  // three times, but that is the wrong granularity for the failure this catches: the
  // mirror sheds under the concurrent pass and a feed loses all three attempts within a
  // couple of seconds of each other. Re-reading the stragglers alone, one at a time and
  // off the back of the burst, recovered every transient failure of the first
  // catalogue-wide run. It is cheap because it is only ever tens of feeds — and when it
  // is not cheap, the feeds are genuinely broken and worth the wait to say so.
  const stillFailed = [];
  for (const { entry, why } of failed) {
    const retry = await measureFeed(`${MIRROR}${entry.id}${MIRROR_SUFFIX}`);
    if (retry.t || retry.u) { accept(entry, retry.t, retry.u); measured++; continue; }
    stillFailed.push({ entry, why: retry.why || why });
  }
  for (const { entry, why } of stillFailed) {
    reasons.set(why, (reasons.get(why) || 0) + 1);
    if (entry.t || entry.u) { entry.q = 1; carried++; } else { missing++; }
  }

  if (onProgress) onProgress(done, entries.length);
  return { measured, carried, missing, retried: failed.length - stillFailed.length, reasons };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (CHECK_ONLY) {
    const { ok, problems, doc } = await checkSnapshot(OUT_PATH);
    if (JSON_OUT) {
      process.stdout.write(`${JSON.stringify({
        mode: 'check', ok, problems, count: doc ? doc.count : 0,
      }, null, 2)}\n`);
    } else if (ok) {
      line(`${colour(GREEN, 'OK')} ${path.relative(REPO, OUT_PATH)} — ${doc.count} feeds, `
        + 'every invariant holds');
    } else {
      for (const p of problems.slice(0, 40)) fail(p);
      if (problems.length > 40) fail(`and ${problems.length - 40} more`);
    }
    process.exitCode = ok ? 0 : 1;
    return;
  }

  let csv;
  let source;
  if (CSV_PATH) {
    csv = await readFile(path.resolve(process.cwd(), CSV_PATH), 'utf8');
    source = CATALOG_URL;                       // the origin of a saved copy is still this
    chatter(colour(DIM, `Reading ${CSV_PATH} (${csv.length} bytes)`));
  } else {
    chatter(colour(DIM, `Fetching ${CATALOG_URL}`));
    const got = await fetchCatalog(CATALOG_URL);
    csv = got.text;
    source = got.url;
    chatter(colour(DIM, `  ${source} (${csv.length} bytes)`));
  }

  const records = csvRecords(csv);
  if (!records.length) throw new Error('the catalogue parsed to zero rows');

  // The file already on disk, read before curation rather than after it because a row
  // whose upstream bbox has gone bad borrows the box recorded here (see `toEntry`).
  let old = null;
  try { old = JSON.parse(await readFile(OUT_PATH, 'utf8')); } catch { /* first run */ }
  const priorBbox = new Map();
  const priorCounts = new Map();
  for (const row of (old && Array.isArray(old.rows)) ? old.rows : []) {
    // Counts are keyed independently of the box: a row whose bbox went bad still has
    // perfectly good numbers, and vice versa.
    if (row.t || row.u) priorCounts.set(String(row.id), { t: row.t, u: row.u, q: row.q });
    if (!Array.isArray(row.b)) continue;
    priorBbox.set(String(row.id), row.b);
    // A version-1 row's id was the Mobility Database source id as an integer, which
    // v2 spells `mdb-<n>`. Reading each old row under both names is what lets the one
    // regeneration that migrates the schema carry boxes ACROSS that migration; after
    // it, ids match on the nose and the second name is never hit.
    if (typeof row.id === 'number') priorBbox.set(`mdb-${row.id}`, row.b);
  }

  // Curate. Every drop is counted under the rule that dropped it, in rule order.
  const drops = new Map();
  const entries = [];
  for (const row of records) {
    const { entry, drop } = toEntry(row, priorBbox.get(row['id']) || null);
    if (drop) { drops.set(drop, (drops.get(drop) || 0) + 1); continue; }
    entries.push(entry);
  }

  const { kept, removed: deduped } = dedupe(entries);

  // Every row inherits whatever the last snapshot measured, BEFORE `--counts` gets a
  // chance to improve on it. That ordering is what makes the default run a no-op for
  // these two fields and a failed probe a silent hold rather than a loss.
  for (const entry of kept) {
    const prior = priorCounts.get(entry.id);
    if (!prior) continue;
    if (prior.t) entry.t = prior.t;
    if (prior.u) entry.u = prior.u;
    if (prior.q) entry.q = 1;
  }

  let counts = null;
  if (WITH_COUNTS) {
    chatter(colour(DIM, `Measuring ${kept.length} feeds over the mirror, `
      + `${COUNTS_CONCURRENCY} at a time`));
    counts = await measureAll(kept, (done, total) => {
      chatter(colour(DIM, `  ${done}/${total}`));
    });
  }

  // Classify long-distance. A continent-sized box intersects every polygon a player
  // could draw, so Amtrak must not arrive uninvited with Chicago.
  let regional = 0;
  let inactive = 0;
  let authed = 0;
  let carried = 0;
  let measured = 0;
  for (const entry of kept) {
    if (spanKm(entry.b) > REGIONAL_KM) { entry.r = 1; regional++; }
    if (entry.x) inactive++;
    if (entry.a) authed++;
    if (entry.k) carried++;
    if (entry.t || entry.u) measured++;
  }

  // The snapshot date comes from the catalogue, never from a clock (see the header).
  const extracted = records
    .map((r) => (r['location.bounding_box.extracted_on'] || '').slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort(cmpStr);
  const snapshot = SNAPSHOT_OVERRIDE || extracted[extracted.length - 1] || '';
  if (!snapshot) throw new Error('no usable extracted_on date in the catalogue; pass --snapshot');

  const { doc, text } = await writeSnapshot(kept, OUT_PATH, { snapshot, source });
  const delta = diffSummary(old, doc);
  const verify = await checkSnapshot(OUT_PATH);

  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({
      mode: 'build',
      out: path.relative(REPO, OUT_PATH),
      snapshot,
      source,
      regionalKm: REGIONAL_KM,
      read: records.length,
      count: doc.count,
      regional,
      inactive,
      authed,
      carried,
      deduped,
      measured,
      counts: counts ? {
        probed: true,
        ok: counts.measured,
        carried: counts.carried,
        missing: counts.missing,
        reasons: Object.fromEntries([...counts.reasons].sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0]))),
      } : { probed: false },
      bytes: Buffer.byteLength(text),
      drops: Object.fromEntries([...drops].sort((a, b) => cmpStr(a[0], b[0]))),
      diff: delta,
      ok: verify.ok,
      problems: verify.problems,
    }, null, 2)}\n`);
  } else {
    chatter();
    chatter(`Read      ${records.length} catalogue rows`);
    for (const [why, n] of [...drops].sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0]))) {
      chatter(colour(DIM, `  dropped ${String(n).padStart(5)}  ${why}`));
    }
    chatter(colour(DIM, `  dropped ${String(deduped).padStart(5)}  duplicate (provider, bbox)`));
    chatter();
    line(`${path.relative(REPO, OUT_PATH)} — ${doc.count} feeds, ${Buffer.byteLength(text)} bytes, `
      + `snapshot ${snapshot}`);
    line(delta.fresh
      ? `  new file: ${delta.added} rows`
      : `  ${delta.added} added, ${delta.removed} removed, ${delta.moved} bboxes moved, `
        + `${delta.newlyRegional} newly regional, ${delta.resized} resized`);
    line(`  ${doc.count - regional} city feeds, ${regional} regional or long-distance `
      + `(over ${REGIONAL_KM} km), ${inactive} no longer updated, ${authed} need a key`);
    if (carried) {
      line(`  ${carried} kept a bounding box from the previous snapshot because the `
        + 'catalogue no longer publishes a usable one');
    }
    line(`  ${measured} carry a measured size, ${doc.count - measured} do not`
      + (WITH_COUNTS ? '' : ' (run with --counts to measure)'));
    if (counts) {
      line(`  measured ${counts.measured} feeds over the mirror`
        + (counts.retried ? `, ${counts.retried} of them only on the second pass` : '')
        + (counts.carried ? `, ${counts.carried} held their previous numbers` : '')
        + (counts.missing ? `, ${counts.missing} could not be measured at all` : ''));
      for (const [why, n] of [...counts.reasons].sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0])).slice(0, 8)) {
        chatter(colour(DIM, `    ${String(n).padStart(5)}  ${why}`));
      }
    }
    line(verify.ok
      ? `  ${colour(GREEN, 'check OK')} — every invariant holds`
      : `  ${colour(RED, 'CHECK FAILED')} — ${verify.problems.length} problems`);
  }
  for (const p of verify.problems.slice(0, 20)) fail(p);
  process.exitCode = verify.ok ? 0 : 1;
}

// Only when run as a command. The curation helpers above are exported so a harness
// can import and exercise them without this reaching for the network.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    fail(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}
