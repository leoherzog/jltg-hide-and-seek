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
// 370 KB file has to make its own diff auditable — the same discipline
// `tools/osm-world/build.py` follows.
//
//   node tools/mdb-snapshot.mjs --csv ./sources.csv        # offline, from a saved CSV
//   node tools/mdb-snapshot.mjs --regional-km 250          # long-distance cut-off
//   node tools/mdb-snapshot.mjs --out data/feeds.json      # destination
//   node tools/mdb-snapshot.mjs --snapshot 2026-08-23      # override the snapshot date
//   node tools/mdb-snapshot.mjs --json --quiet             # machine-readable summary
//
// DETERMINISM. The same CSV bytes must produce the same file bytes, so nothing here
// reads a clock: the `snapshot` date defaults to the newest
// `location.bounding_box.extracted_on` in the catalogue itself, rows are sorted by
// `mdb_source_id`, and every string comparison is by code point. Rerunning against a
// saved CSV is byte-identical, which is what makes a regeneration reviewable.
//
// Zero dependencies, Node 24. No build step — this is a `tools/` script, not part of
// the app; nothing in `lib/`, `gtfs/`, `osm/`, `rules/` or `render/` imports it.
// ═══════════════════════════════════════════════════════════════════════════════

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/** The published short link. It 302s to the GCS object; Node's fetch follows it. */
const CATALOG_URL = 'https://bit.ly/catalogs-csv';

/**
 * Where that short link lands today. Recorded so an offline `--csv` run writes the
 * same `source` a live run does — otherwise regenerating from a saved copy would
 * rewrite one header line and make the two modes disagree byte for byte.
 */
const CATALOG_RESOLVED = 'https://storage.googleapis.com/storage/v1/b/mdb-csv/o/sources.csv?alt=media';

/** MobilityData's mirror of the latest fetched zip for each source. CORS-open. */
const MIRROR = 'https://storage.googleapis.com/storage/v1/b/mdb-latest/o/';
const MIRROR_SUFFIX = '?alt=media';

/** Above this, a feed is long-distance rather than a city, and becomes opt-in. */
const DEFAULT_REGIONAL_KM = 250;

const SCHEMA_VERSION = 1;

/** Every key an entry may carry, in the order it is written. */
const ENTRY_KEYS = ['id', 'p', 'n', 'c', 's', 'm', 'b', 'f', 'd', 'a', 'r', 'x'];
const OPTIONAL_KEYS = new Set(['n', 'd', 'a', 'r', 'x']);

// ── argv ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const QUIET = argv.includes('--quiet');
const JSON_OUT = argv.includes('--json');
const CHECK_ONLY = argv.includes('--check');

/** `--flag value`, or null when absent. */
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

const OUT_PATH = path.resolve(REPO, flag('--out') || path.join('data', 'feeds.json'));
const CSV_PATH = flag('--csv');
const SNAPSHOT_OVERRIDE = flag('--snapshot');
const REGIONAL_KM = Number(flag('--regional-km') || DEFAULT_REGIONAL_KM);

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

/**
 * One catalogue row to one snapshot entry, or a reason string it was dropped.
 * The rules run in the order the counters print them.
 * @param {Record<string,string>} row
 * @returns {{entry: object|null, drop: string|null}}
 */
/** http(s) only — the one scheme the page is willing to put in an `href`. */
export function isHttpUrl(value) {
  return typeof value === 'string'
    && (value.startsWith('http://') || value.startsWith('https://'));
}

export function toEntry(row) {
  const drop = (why) => ({ entry: null, drop: why });

  if (row['data_type'] !== 'gtfs') return drop('not gtfs (realtime or gbfs)');
  const status = row['status'];                       // blank counts as live — most are
  if (status === 'deprecated') return drop('deprecated');

  const b = bboxOf(row);
  if (!b) return drop('bbox does not parse');
  const bad = corruptReason(b);
  if (bad) return drop(`bbox ${bad}`);

  const provider = row['provider'];
  if (!provider) return drop('no provider');

  // The mirror URL is stored as its object name alone: every row's `urls.latest` is
  // `MIRROR + name + MIRROR_SUFFIX`, so keeping the whole URL is ~55 redundant bytes a
  // row. A row that does not follow the pattern has no mirror the page can rebuild.
  const latest = row['urls.latest'];
  if (!latest.startsWith(MIRROR) || !latest.endsWith(MIRROR_SUFFIX)) return drop('no mirror URL');
  const f = latest.slice(MIRROR.length, latest.length - MIRROR_SUFFIX.length);
  if (!f.endsWith('.zip') || f.includes('/') || f.includes('?')) return drop('odd mirror URL');

  const id = Number(row['mdb_source_id']);
  if (!Number.isInteger(id) || id <= 0) return drop('no source id');

  const entry = {
    id,
    p: provider,
    c: row['location.country_code'],
    s: row['location.subdivision_name'],
    m: row['location.municipality'],
    b,
    f,
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
  // spelling `javascript:` would ship a live link inside a 375 KB generated file
  // nobody line-reads. A row whose only URL is something else keeps its marker and
  // loses the link.
  const direct = row['urls.direct_download'];
  if (direct && isHttpUrl(direct)) entry.d = direct;
  // Flag, never drop: the page shows these and says the browser cannot fetch them.
  const auth = Number(row['urls.authentication_type']);
  if (row['urls.authentication_type'] && Number.isFinite(auth) && auth !== 0) entry.a = auth;
  if (status === 'inactive') entry.x = 1;
  return { entry, drop: null };
}

/**
 * One row per `(provider, bbox)`, keeping the lowest source id — VBB and the Estonian
 * county set each publish the same box several times over.
 * @param {object[]} entries
 * @returns {{kept: object[], removed: number}}
 */
export function dedupe(entries) {
  const seen = new Map();
  for (const entry of entries) {
    const key = `${entry.p} ${entry.b.join(',')}`;
    const prev = seen.get(key);
    if (!prev || entry.id < prev.id) seen.set(key, entry);
  }
  const kept = [...seen.values()].sort((a, b) => a.id - b.id);
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
 * rather than one 370 KB blob. The document's own opening brace is line 1; every
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
 * 370 KB diff can be reviewed as a sentence before it is read as a diff.
 * @param {object|null} old
 * @param {object} next
 * @returns {object} counts
 */
export function diffSummary(old, next) {
  if (!old || !Array.isArray(old.rows)) {
    return { fresh: true, added: next.count, removed: 0, moved: 0, newlyRegional: 0 };
  }
  const before = new Map(old.rows.map((r) => [r.id, r]));
  const after = new Map(next.rows.map((r) => [r.id, r]));
  let added = 0;
  let removed = 0;
  let moved = 0;
  let newlyRegional = 0;
  for (const [id, row] of after) {
    const prev = before.get(id);
    if (!prev) { added++; continue; }
    if (prev.b.join(',') !== row.b.join(',')) moved++;
    if (!prev.r && row.r) newlyRegional++;
  }
  for (const id of before.keys()) if (!after.has(id)) removed++;
  return { fresh: false, added, removed, moved, newlyRegional };
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
  let lastId = -Infinity;
  for (const row of doc.rows) {
    if (!row || typeof row !== 'object') { problems.push('a row is not an object'); continue; }
    const at = `row id=${row.id}`;
    say(Number.isInteger(row.id) && row.id > 0, `${at}: id is not a positive integer`);
    say(!ids.has(row.id), `${at}: duplicate id`);
    ids.add(row.id);
    say(row.id > lastId, `${at}: rows are not sorted ascending by id`);
    lastId = row.id;

    say(typeof row.p === 'string' && row.p.length > 0, `${at}: p is empty`);
    say(typeof row.f === 'string' && row.f.endsWith('.zip') && !row.f.includes('/')
      && !row.f.includes('?'), `${at}: f is not a bare .zip object name`);

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

    for (const [k, v] of Object.entries(row)) {
      say(ENTRY_KEYS.includes(k), `${at}: unexpected key ${JSON.stringify(k)}`);
      say(v !== null, `${at}: key ${k} is null`);
      if (!OPTIONAL_KEYS.has(k)) continue;
      if (k === 'r' || k === 'x') say(v === 1, `${at}: ${k} is ${JSON.stringify(v)}, expected 1`);
      if (k === 'a') say(Number.isInteger(v) && v !== 0, `${at}: a is not a non-zero integer`);
      if (k === 'n' || k === 'd') say(typeof v === 'string' && v.length > 0, `${at}: ${k} is empty`);
      // `d` becomes an `href` on the page, so its SCHEME is an invariant of the file,
      // not a property of whatever the upstream happened to publish today.
      if (k === 'd') say(isHttpUrl(v), `${at}: d is not an http(s) URL`);
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
    source = CATALOG_RESOLVED;                  // the origin of a saved copy is still this
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

  // Curate. Every drop is counted under the rule that dropped it, in rule order.
  const drops = new Map();
  const entries = [];
  for (const row of records) {
    const { entry, drop } = toEntry(row);
    if (drop) { drops.set(drop, (drops.get(drop) || 0) + 1); continue; }
    entries.push(entry);
  }

  const { kept, removed: deduped } = dedupe(entries);

  // Classify long-distance. A continent-sized box intersects every polygon a player
  // could draw, so Amtrak must not arrive uninvited with Chicago.
  let regional = 0;
  let inactive = 0;
  let authed = 0;
  for (const entry of kept) {
    if (spanKm(entry.b) > REGIONAL_KM) { entry.r = 1; regional++; }
    if (entry.x) inactive++;
    if (entry.a) authed++;
  }

  // The snapshot date comes from the catalogue, never from a clock (see the header).
  const extracted = records
    .map((r) => (r['location.bounding_box.extracted_on'] || '').slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort(cmpStr);
  const snapshot = SNAPSHOT_OVERRIDE || extracted[extracted.length - 1] || '';
  if (!snapshot) throw new Error('no usable extracted_on date in the catalogue; pass --snapshot');

  let old = null;
  try { old = JSON.parse(await readFile(OUT_PATH, 'utf8')); } catch { /* first run */ }

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
      deduped,
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
        + `${delta.newlyRegional} newly regional`);
    line(`  ${doc.count - regional} city feeds, ${regional} regional or long-distance `
      + `(over ${REGIONAL_KM} km), ${inactive} no longer updated, ${authed} need a key`);
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
