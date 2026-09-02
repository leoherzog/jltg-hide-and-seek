#!/usr/bin/env node
// tools/mdb-snapshot.mjs — curate the Mobility Database catalogue into data/feeds.json.
//
// The landing map reads `data/feeds.json`, a tracked snapshot of the Mobility
// Database's open CSV catalogue, never a live fetch: no third-party dependency at
// load, curation rules reviewable in a diff, and a bad upstream day cannot empty
// the map.
//
//   node tools/mdb-snapshot.mjs                     # fetch, curate, rewrite data/feeds.json
//   node tools/mdb-snapshot.mjs --check             # validate the committed file, no network
//   git diff --stat data/feeds.json                 # then read the diff before committing
//
//   node tools/mdb-snapshot.mjs --csv ./feeds_v2.csv       # offline, from a saved CSV
//   node tools/mdb-snapshot.mjs --regional-km 250          # long-distance cut-off
//   node tools/mdb-snapshot.mjs --out data/feeds.json      # destination
//   node tools/mdb-snapshot.mjs --snapshot 2026-08-23      # override the snapshot date
//   node tools/mdb-snapshot.mjs --json --quiet             # machine-readable summary
//   node tools/mdb-snapshot.mjs --counts                   # ALSO measure each feed's size
//   node tools/mdb-snapshot.mjs --counts --counts-concurrency 8
//
// The tool prints a review summary against the file on disk (`+18 added, -4
// removed, 31 bboxes moved`) so the 810 KB diff is auditable.
//
// DETERMINISM. Nothing reads a clock: `snapshot` defaults to the newest
// `location.bounding_box.extracted_on` in the catalogue, rows sort by `id`, and
// strings compare by code point. The output is a function of the CSV plus the
// `data/feeds.json` already on disk, from which a row with no usable upstream bbox
// borrows its box (`toEntry`, marked `k`).
//
// `--counts` is the opt-in exception. The catalogue never says how big a feed is,
// and the APIs that do need a credential, so `--counts` measures the feeds over the
// mirror and is reproducible only against an unchanged mirror. The default run
// carries `t`/`u` forward untouched. CI passes `--counts`.
//
// A feed is measured without downloading it: a zip keeps its index at the END, so
// three Range requests suffice — the last 4 KB (EOCD plus central directory),
// `stops.txt` (count by `location_type`, see `countStops`), `routes.txt` (count
// rows). `stop_times.txt` is never touched. A feed that cannot be measured (404, no
// Range, ZIP64, odd compression) keeps its previous numbers and is marked `q`.
//
// Zero dependencies, Node 24. Nothing in the app imports this.

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
 * The v2 catalogue export: mirrors 4,056 feeds including the national-aggregator and
 * Transitland imports, unlike the older `sources.csv`. Same columns; `mdb_source_id`
 * became `id` and its values became strings. No redirect, so an offline `--csv` run
 * writes the same header.
 */
const CATALOG_URL = 'https://files.mobilitydatabase.org/feeds_v2.csv';

/**
 * MobilityData's CORS-open mirror of each source's latest zip. Every mirrored row is
 * `MIRROR + id + MIRROR_SUFFIX`, so entries store no URL; `lib/catalog.js` rebuilds
 * it. Rows of any other shape are dropped.
 */
const MIRROR = 'https://files.mobilitydatabase.org/';
const MIRROR_SUFFIX = '/latest.zip';

/** Above this, a feed is long-distance rather than a city, and becomes opt-in. */
const DEFAULT_REGIONAL_KM = 250;

/**
 * Feeds measured at once under `--counts`. 12 is the measured knee: wall clock is
 * latency, not bandwidth, and more mostly makes the CDN shed.
 */
const DEFAULT_COUNTS_CONCURRENCY = 12;

/** Per-request ceiling under `--counts`. Generous: a slow mirror is not a failed one. */
const COUNTS_TIMEOUT_MS = 30_000;

/** Attempts per range request before a feed carries its old numbers. */
const COUNTS_ATTEMPTS = 3;

/**
 * Tail read for the zip's EOCD record. 4 KB holds the EOCD and the whole central
 * directory of a ~15-member GTFS archive; `readDirectory` falls back to the format's
 * maximum when it does not.
 */
const ZIP_TAIL_BYTES = 4096;
const ZIP_TAIL_MAX = 65_557;

// 2: `id` is a catalogue id string, `f` is gone, `k` marks a carried bbox.
// 3: optional `t`, `u`, `q` measured sizes; `lib/catalog.js` ranks on `t`.
// `lib/catalog.js`'s CATALOG_VERSION moves with this.
const SCHEMA_VERSION = 3;

/** Every key an entry may carry, in write order. `t`/`u` are second letters: `s`, `r` are taken. */
const ENTRY_KEYS = ['id', 'p', 'n', 'c', 's', 'm', 'b', 'd', 'a', 't', 'u', 'k', 'q', 'r', 'x'];
const OPTIONAL_KEYS = new Set(['n', 'd', 'a', 't', 'u', 'k', 'q', 'r', 'x']);

/** The bare flags among them: present means 1, absent means the row is not that. */
const FLAG_KEYS = new Set(['k', 'q', 'r', 'x']);

/** The two count keys, which are written and validated as a pair. */
const COUNT_KEYS = ['t', 'u'];

/** A catalogue id, which is also the mirror's object name: must be a clean URL path segment. */
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

/** Code-point string order. Never `localeCompare`: locale-dependent is non-deterministic. */
function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// ── CSV ──────────────────────────────────────────────────────────────────────

/**
 * RFC 4180 reader for a whole document: quoted commas, doubled quotes, embedded
 * newlines. `gtfs/feed.js`'s parser is streaming and worker-shaped; this is one-shot.
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
 * Rows as objects keyed by header name. Column order is never assumed.
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

/** 5 dp is ~1 m, finer than the catalogue's boxes are worth. `+ 0` kills `-0`. */
function round5(v) { return Math.round(v * 1e5) / 1e5 + 0; }

/**
 * The catalogue's bbox columns as `[S, W, N, E]` (`lib/geo.js` order, NOT GeoJSON).
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
 * Why this box cannot go on a map, or null. The zero sentinel is commonest and is
 * named first so the counts read true. Runs on the ROUNDED box, so the committed
 * file satisfies its own `--check`.
 * @param {number[]} b `[S, W, N, E]`
 * @returns {string|null}
 */
export function corruptReason(b) {
  const [s, w, n, e] = b;
  // MobilityData writes 0 for "no bounding box".
  if (s === 0 || w === 0 || n === 0 || e === 0) return 'zero edge (the no-bbox sentinel)';
  if (Math.abs(s) > 85 || Math.abs(n) > 85) return 'beyond 85 degrees latitude';
  if (!(s < n) || !(w < e)) return 'inverted or empty';
  if (n - s > 60) return 'latitude span over 60 degrees';
  if (e - w > 150) return 'longitude span over 150 degrees';
  if (n - s < 0.001 && e - w < 0.001) return 'degenerate (under 0.001 degrees in both axes)';
  return null;
}

/**
 * The longer side of the box in km at its centroid latitude. Max, not diagonal:
 * a long thin rail corridor is exactly what this must catch.
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

/** http(s) only: the one scheme the page will put in an `href`. */
export function isHttpUrl(value) {
  return typeof value === 'string'
    && (value.startsWith('http://') || value.startsWith('https://'));
}

/**
 * One catalogue row to one snapshot entry, or a reason it was dropped. Rules run in
 * the order the counters print them.
 *
 * @param {Record<string,string>} row
 * @param {number[]|null} [priorBbox] the previous snapshot's box for this id, used
 *   when the catalogue's own is unusable
 * @returns {{entry: object|null, drop: string|null}}
 */
export function toEntry(row, priorBbox = null) {
  const drop = (why) => ({ entry: null, drop: why });

  if (row['data_type'] !== 'gtfs') return drop('not gtfs (realtime or gbfs)');
  // Only `deprecated` drops; `future` and `development` are ordinary small operators.
  const status = row['status'];                       // blank counts as live
  if (status === 'deprecated') return drop('deprecated');

  // The id is the mirror object name and the carry-forward key, so it is read first.
  const id = row['id'];
  if (!id || !ID_RE.test(id)) return drop('no usable source id');

  // A row whose own box went bad keeps the box on disk, marked `k`: a regressed
  // extraction is not a system that moved. Only a CITY-SIZED box is carried: every
  // oversized one offered was a national aggregate already wrong on its face, and
  // cutting at the `r` threshold means the rule can only restore a city.
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

  // The whole string is matched, not its ends: a row shaped any other way has no
  // mirror the page can rebuild from `id`.
  if (row['urls.latest'] !== `${MIRROR}${id}${MIRROR_SUFFIX}`) return drop('no mirror URL');

  const entry = {
    id,
    p: provider,
    c: row['location.country_code'],
    s: row['location.subdivision_name'],
    m: row['location.municipality'],
    b,
  };
  // `name` is the sub-feed label. Omitted when empty or repeating the provider.
  const name = row['name'];
  if (name && name !== provider) entry.n = name;
  // The producer's own URL: never auto-fetched (usually no CORS), but the only href
  // for an auth-gated row and the fallback when a mirror 404s. Only http(s) is kept:
  // it becomes an `href`, and escaping does not neutralise a `javascript:` scheme.
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
 * One row per `(provider, bbox)`, keeping the code-point-lowest id. `mdb-` sorts
 * below the auto-imported prefixes, so the hand-curated entry survives.
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
 * One JSON object per line inside `rows`, so `git diff` shows which feeds moved.
 * Every line beginning `{"` is exactly one feed.
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
 * What changed against the file on disk, printed on every regeneration.
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
    // Only counts that MOVED, not counts that appeared.
    if ((prev.t || prev.u) && (prev.t !== row.t || prev.u !== row.u)) resized++;
  }
  for (const id of before.keys()) if (!after.has(id)) removed++;
  return { fresh: false, added, removed, moved, newlyRegional, resized };
}

// ── --check ──────────────────────────────────────────────────────────────────

/**
 * Every invariant the runtime may assume, checked without a network.
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

    // `q` means "these numbers are older than this snapshot": meaningless without numbers.
    say(!row.q || row.t !== undefined || row.u !== undefined,
      `${at}: q is set but the row carries no counts`);

    for (const [k, v] of Object.entries(row)) {
      say(ENTRY_KEYS.includes(k), `${at}: unexpected key ${JSON.stringify(k)}`);
      say(v !== null, `${at}: key ${k} is null`);
      if (!OPTIONAL_KEYS.has(k)) continue;
      if (FLAG_KEYS.has(k)) say(v === 1, `${at}: ${k} is ${JSON.stringify(v)}, expected 1`);
      if (k === 'a') say(Number.isInteger(v) && v !== 0, `${at}: a is not a non-zero integer`);
      if (k === 'n' || k === 'd') say(typeof v === 'string' && v.length > 0, `${at}: ${k} is empty`);
      // A count is a positive integer or not written: zero is the shape of a failed
      // read, and `lib/catalog.js` ranks on `t`.
      if (COUNT_KEYS.includes(k)) {
        say(Number.isInteger(v) && v > 0, `${at}: ${k} is ${JSON.stringify(v)}, expected a positive integer`);
      }
      // `d` becomes an `href`, so its scheme is an invariant of the file.
      if (k === 'd') say(isHttpUrl(v), `${at}: d is not an http(s) URL`);
    }
  }

  // The example maps (`lib/catalog.js`) name rows by id; a regeneration that drops
  // one breaks a landing-page chip, so it fails here.
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
 * The catalogue CSV. The RESOLVED URL goes in the snapshot header.
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
// Just enough ZIP to read two members out of a remote archive; not a general
// unzipper and must not grow into one. Anything it cannot handle it declines by
// throwing, so the caller carries the previous snapshot's numbers.

const EOCD_SIG = 0x06054b50;
const CD_ENTRY_SIG = 0x02014b50;
const ZIP_STORED = 0;
const ZIP_DEFLATE = 8;

/**
 * One HTTP Range request, retried on anything transient. A 200 is a FAILURE: the
 * server ignored `Range` and is about to hand over the whole body.
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
      // Linear backoff: a catalogue-wide run cannot afford sleeping workers.
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
 * Every member of a remote zip, from its central directory. The common case is
 * exactly one request: the tail holds both the EOCD and the directory.
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
  // A mirror object that is not a zip is the commonest failure; name the cause.
  if (at < 0) {
    const head = tail.subarray(0, 64).toString('latin1').trimStart().toLowerCase();
    throw new Error(head.startsWith('<htm') || head.startsWith('<!do') || head.startsWith('<?xml')
      ? 'the mirror served a web page, not a zip'
      : 'no end-of-central-directory record');
  }

  const entryCount = tail.readUInt16LE(at + 10);
  const cdSize = tail.readUInt32LE(at + 12);
  const cdOffset = tail.readUInt32LE(at + 16);
  // ZIP64 archives are declined. The three sentinels ARE the detection: scanning the
  // tail for the locator signature would reject valid archives on a coincidence.
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || entryCount === 0xffff) {
    throw new Error('ZIP64 archive');
  }

  // The directory ends where the EOCD begins (`cdOffset + cdSize`, at `at` in the
  // tail), which fixes where the tail starts and lets it be sliced, not re-requested.
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
 * Replace an entry's 32-bit sentinels with the values from its ZIP64 extra field.
 *
 * A per-entry ZIP64 record is NOT a ZIP64 archive: streaming zip writers put
 * `0xFFFFFFFF` sizes in every entry of a 250 KB file while the EOCD stays 32-bit.
 * The 0x0001 field carries ONLY the sentinelled members, in a fixed order with no
 * per-value length prefix, so the order of the four `if`s below is the format.
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
 * One member's bytes, decompressed. Sizes come from the central directory, never
 * the local header (a streamed zip leaves those zero); the request overshoots by
 * `ZIP_TAIL_BYTES` so header and payload arrive together.
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

/** A member's basename, lowercased: GTFS zips may nest their txt files one folder deep. */
const memberBase = (name) => name.split('/').pop().toLowerCase();

/** A member by GTFS filename, or null when the archive has none. */
const memberNamed = (entries, file) => entries.find((e) => memberBase(e.name) === file) || null;

/**
 * The data rows of a GTFS table. Uses `parseCsv`, not a line count: `stop_name` can
 * hold quoted commas and newlines. Strips a UTF-8 BOM off the header.
 *
 * @param {Buffer} buf
 * @returns {{header: string[], rows: string[][]}}
 */
function readTable(buf) {
  const rows = parseCsv(buf.toString('utf8'));
  if (!rows.length) return { header: [], rows: [] };
  const header = rows[0].map((h, i) => (i === 0 ? h.replace(/^﻿/, '') : h).trim());
  // Drops the empty row a trailing newline parses to, and any blank line.
  const data = rows.slice(1).filter((r) => r.length > 1 || (r[0] || '') !== '');
  return { header, rows: data };
}

/**
 * How many places this feed serves: parent stations (`location_type=1`) where it
 * models them, plain stops otherwise. NYC Subway is 496 stations under 1,488 rows,
 * and the raw count would rank it above systems several times its size. Entrances,
 * nodes and boarding areas count in neither branch; no column means all stops.
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

/** How many routes this feed publishes: `routes.txt` data rows. */
export function countRoutes(buf) {
  return readTable(buf).rows.length;
}

/**
 * One feed measured, or a reason it could not be. Never throws: a single 404 must
 * not cost a refresh.
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
    // Header-only tables read as a successful measurement of nothing. Named here, and
    // left UNMEASURED rather than zero: no stops is a publishing accident.
    if (!t && !u) throw new Error('the archive has no stops and no routes');
    return { t, u, why: null };
  } catch (err) {
    return { t: null, u: null, why: reasonOf(err) };
  }
}

/** An error as a groupable one-line reason. Never returns `"null"` or `"undefined"`. */
function reasonOf(err) {
  if (err && typeof err.message === 'string' && err.message) {
    // `fetch` hides the real network fault under a bare "fetch failed".
    const cause = err.cause && err.cause.message ? ` (${err.cause.message})` : '';
    return `${err.message}${cause}`;
  }
  if (err && err.name) return err.name;
  return `threw ${Object.prototype.toString.call(err)}`;
}

/**
 * Measure every entry, `COUNTS_CONCURRENCY` at a time, writing `t`/`u`/`q` in place.
 * A measurement of 0 is thrown away: it is a broken read, not a small system.
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

  /** Write a measurement onto the row. Absent numbers are cleared, not kept. */
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

  // A second pass, serially, over whatever failed: the mirror sheds under the
  // concurrent burst and a feed can lose all three `rangeGet` attempts in seconds.
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
    source = CATALOG_URL;                       // a saved copy's origin is still this
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

  // The file on disk, read before curation: `toEntry` borrows boxes from it.
  let old = null;
  try { old = JSON.parse(await readFile(OUT_PATH, 'utf8')); } catch { /* first run */ }
  const priorBbox = new Map();
  const priorCounts = new Map();
  for (const row of (old && Array.isArray(old.rows)) ? old.rows : []) {
    // Counts are keyed independently of the box.
    if (row.t || row.u) priorCounts.set(String(row.id), { t: row.t, u: row.u, q: row.q });
    if (!Array.isArray(row.b)) continue;
    priorBbox.set(String(row.id), row.b);
    // A version-1 integer id is spelt `mdb-<n>` in v2; both names carry across.
    if (typeof row.id === 'number') priorBbox.set(`mdb-${row.id}`, row.b);
  }

  // Curate. Every drop is counted under the rule that dropped it.
  const drops = new Map();
  const entries = [];
  for (const row of records) {
    const { entry, drop } = toEntry(row, priorBbox.get(row['id']) || null);
    if (drop) { drops.set(drop, (drops.get(drop) || 0) + 1); continue; }
    entries.push(entry);
  }

  const { kept, removed: deduped } = dedupe(entries);

  // Every row inherits the last snapshot's measurements BEFORE `--counts` runs, so
  // the default run is a no-op for these fields and a failed probe is a hold.
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

  // Classify long-distance: a continent-sized box intersects every polygon a player
  // could draw.
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

  // The snapshot date comes from the catalogue, never from a clock.
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

// Only when run as a command; the helpers are exported for harnesses.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    fail(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}
