#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// tools/smoke.mjs — headless end-to-end harness
// ═══════════════════════════════════════════════════════════════════════════════
//
// Runs `runPipeline` from worker.js against the cached reference feed with the
// OSM layer disabled, and asserts generated/generate.py's own golden numbers from
// `selftest()`. Those numbers are measured, not guessed: a change to
// any of them means an algorithm changed, which may be correct but must be
// deliberate. Never adjust an assertion to make it pass.
//
//   node tools/smoke.mjs [--feed <path>] [--quiet] [--json]
//                        [--no-merge] [--merge-pipeline]
//
// After the goldens, and before the merge phases, the BORDER scenario (B1) runs the
// same feed a second time with `borderBbox` set to a box that clips about 20 % of
// the served stops off the south edge. It asserts the in-play facts CONTRACT.md
// §(b) Metrics "Stop set" promises — the measured set shrank, the whole-feed count
// is still reported, the border is the reader's box unpadded — as SHAPE checks and
// relations, never as golden numbers: a clipped run is not a stable reference.
//
// After the goldens it runs the MERGE phases, which cover `gtfs/merge.js` and carry
// their own pass/fail count, reported on its own line so the 19 above stay legible:
//
//   M1  self-merge — the reference feed merged with itself. Identical bytes mean
//       identical hashes and a 100% id collision, which is the strongest namespacing
//       test available and needs no second fixture.
//   M2  two feeds — the reference plus Rochester, when that zip is cached. Additivity,
//       the window intersection, the mixed-timezone warning, referential integrity.
//   M3  end to end (`--merge-pipeline`) — a merged run reaching `done`. A SHAPE check,
//       never a golden: a merged map is not a stable reference and must never grow one.
//   M4  the failure path (`--merge-pipeline`) — three sources of which one cannot be
//       downloaded. The run must survive it AND must credit the two feeds that
//       actually loaded, because §09 exists so a merged report cannot lie about what
//       it read; an index into the loaded list is not an index into the source list.
//   M5  the big pair (`--merge-pipeline`) — the reference feed merged with MBTA, the
//       one cached pair whose trip-count primary ships no `fare_attributes.txt`. It
//       covers the fare fallback, which no self-merge or same-shaped pair can.
//
// `--merge-pipeline` opts into all three of the slow phases (each loads or runs a
// whole pipeline; M5 alone reads an 18 MB feed). M1 and M2 are seconds and run by
// default. `cache/` is gitignored, so a fixture that is not on this machine prints
// SKIP and does not fail. `--no-merge` skips the phases entirely.
//
// Node has no `Worker`, no `indexedDB` and no `File`. All three are handled without
// shimming the pipeline: `runPipeline` takes its message sink as an argument,
// `lib/cache.js` falls back to an in-memory Map, and the zip is handed in as a
// `Blob`, which is the same duck type (`.arrayBuffer()`, `.name`) a picked `File`
// presents.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import { runPipeline } from '../worker.js';
import { SQM_PER_SQMI, cmpStr } from '../lib/core.js';
import { openCache } from '../lib/cache.js';
import { loadFeed, stopTimesOf } from '../gtfs/feed.js';
import { mergeFeeds, mergeOrder, feedSourceRows, MERGE_TABLES } from '../gtfs/merge.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// The Rapid, summer 2026 — 2.7 MB. The reference feed every golden number below
// was measured on.
const REFERENCE_FEED = path.join(REPO, 'cache', 'gtfs', 'c25d617e4716161f.zip');

const argv = process.argv.slice(2);
const QUIET = argv.includes('--quiet');
const JSON_OUT = argv.includes('--json');
const feedArg = argv.indexOf('--feed');
const FEED_PATH = feedArg >= 0 && argv[feedArg + 1] ? argv[feedArg + 1] : REFERENCE_FEED;
const NO_MERGE = argv.includes('--no-merge');
const MERGE_PIPELINE = argv.includes('--merge-pipeline');

// Rochester, summer 2026 — 508 KB, a different timezone and no id in common with the
// reference feed. Optional: `cache/` is gitignored.
const SECOND_FEED = path.join(REPO, 'cache', 'gtfs', '7da582fb8508a2f9.zip');

// MBTA, summer 2026 — 18 MB, 83,098 trips and NO `fare_attributes.txt`. The only
// cached feed that outruns the reference on trips while shipping no fares, which is
// what makes it the fixture for the fare fallback (M5). Optional, and slow.
const BIG_FEED = path.join(REPO, 'cache', 'gtfs', '3e729bcf6f763c38.zip');

// A host that cannot resolve, so M4's dead source fails in DNS rather than hanging on
// a real server. `.invalid` is reserved by RFC 2606 and can never be registered.
const DEAD_FEED_URL = 'https://feed.invalid/dead.zip';

// Every `runPipeline` call in this file passes these; only `source` differs (a
// merged run names 'merged', a single-feed run names the zip). Written once so the
// goldens and the merge assertions cannot drift onto three different option sets.
const PIPELINE_OPTS = {
  useOsm: false,               // --no-osm
  asOf: null,
  sizeOverride: null,
  zoneRadiusM: null,
  hidingPeriodMin: null,
  startStopId: null,
  borderShape: 'bbox',
  borderBbox: null,
  excludeStops: [],
  excludeRoutes: [],
  departure: '09:00:00',
  boardSlackS: 0,
  offline: false,
  refresh: false,
};

// The B1 border: the reference feed's served stops span S 42.837874 → N 43.043655,
// and the 20th percentile of their latitudes is 42.898863 (measured 2026-08-27), so
// a south edge at 42.8989 keeps ~1,190 of 1,490 stops — enough to stay MEDIUM and
// well clear of `IN_PLAY_MIN_SHARE`, which is the point: the scenario is "the reader
// trimmed the map", not "the reader missed the city". W/N/E are the feed's own box.
const BORDER_CLIP_BBOX = Object.freeze([42.8989, -85.88913, 43.043655, -85.530098]);

// ── console helpers ──────────────────────────────────────────────────────────

const GREEN = '[32m';
const RED = '[31m';
const DIM = '[2m';
const RESET = '[0m';
const colour = process.stdout.isTTY ? (c, s) => `${c}${s}${RESET}` : (_c, s) => s;

function line(text) { if (!JSON_OUT) process.stdout.write(`${text}\n`); }

/** Fixed-width without `toFixed` semantics leaking into the pipeline's own output. */
function show(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6);
  }
  return JSON.stringify(value);
}

// ── stage timing ─────────────────────────────────────────────────────────────
//
// Wall-clock, deliberately, and ONLY here: the harness reports how long each stage
// took. Nothing it measures reaches a pipeline value, and the pipeline itself
// contains no clock at all — that is the property this file exists to protect, not
// to violate.

const STAGES = ['feed', 'days', 'network', 'geo', 'rules', 'score', 'provenance'];

// ── the merge phases ─────────────────────────────────────────────────────────

/** A picked-`File` duck type over a zip on disk, or null when it is not cached. */
async function feedFile(zipPath, name) {
  let bytes;
  try {
    bytes = await readFile(zipPath);
  } catch {
    return null;
  }
  return typeof File === 'function'
    ? new File([bytes], name, { type: 'application/zip' })
    : Object.assign(new Blob([bytes], { type: 'application/zip' }), { name });
}

/** Distinct non-blank values of one column. */
function idSet(rows, col) {
  const out = new Set();
  for (const row of (rows || [])) {
    const v = String(row[col] ?? '').trim();
    if (v) out.add(v);
  }
  return out;
}

/**
 * `gtfs/merge.js`, asserted.
 *
 * Every number below is additive or structural — the sum of two measured feeds, or a
 * property that must hold whatever the feeds are. `merge.two.stopTimes` is asserted
 * BOTH as its measured value and as the relation `a + b`, so a refreshed fixture
 * reports honestly instead of silently.
 *
 * @returns {Promise<{results: Array<object>, skips: string[]}>}
 */
async function mergePhases() {
  /** @type {Array<{name:string,expected:string,actual:string,pass:boolean}>} */
  const results = [];
  /** @type {string[]} */
  const skips = [];
  const is = (name, got, want) => results.push({
    name, expected: show(want), actual: show(got), pass: got === want,
  });

  const cache = await openCache({ offline: false, refresh: false });

  // ── M1 · self-merge ───────────────────────────────────────────────────────
  // Identical bytes: identical sha256 (so `mergeOrder`'s label tie-break is what
  // decides the tags) and every single id colliding. Nothing available is this hostile.
  const refA = await feedFile(REFERENCE_FEED, 'ref-a.zip');
  const refB = await feedFile(REFERENCE_FEED, 'ref-b.zip');
  if (!refA || !refB) {
    skips.push(`M1 self-merge — ${path.relative(REPO, REFERENCE_FEED)} is not cached`);
  } else {
    line('  M1 · the reference feed merged with itself');
    const a = await loadFeed(refA, cache);
    const b = await loadFeed(refB, cache);

    // THE invariant the 19 goldens rest on: one source in, the SAME OBJECT out.
    is('merge.identity', (await mergeFeeds([a])) === a, true);

    /** @type {string[]} */
    const notes = [];
    const merged = await mergeFeeds([a, b], { onNote: (msg) => notes.push(msg) });

    is('merge.self.stops', Object.keys(merged.stops).length, 2986);
    is('merge.self.routes', Object.keys(merged.routes).length, 50);
    is('merge.self.trips', merged.tables.trips.length, 11240);
    is('merge.self.stopTimes', stopTimesOf(merged).length, 401532);

    // Every id prefixed, and every id still distinct: 2n distinct values out of two
    // copies of n is the whole claim the namespacing scheme makes.
    const cols = [
      ['stops', 'stop_id'], ['routes', 'route_id'], ['trips', 'trip_id'],
      ['trips', 'service_id'], ['trips', 'shape_id'],
    ];
    let prefixed = true;
    for (const [table, col] of cols) {
      const mine = idSet(merged.tables[table], col);
      const parts = idSet(a.tables[table], col).size + idSet(b.tables[table], col).size;
      if (mine.size !== parts) prefixed = false;
      for (const v of mine) if (!v.startsWith('f0:') && !v.startsWith('f1:')) prefixed = false;
    }
    is('merge.self.prefixes', prefixed, true);

    const kept = Object.keys(merged.tables).sort(cmpStr);
    const subset = kept.every((t) => MERGE_TABLES.includes(t));
    const fares = (merged.tables.fare_attributes || []).length;
    // The primary feed's rows, NOT both feeds' — the house rule quotes one price as
    // the fare for the whole map.
    is('merge.self.tables', subset && fares === (a.tables.fare_attributes || []).length, true);

    is('merge.self.window', `${merged.feedStart}/${merged.feedEnd}`, '20260724/20260830');
    is('merge.self.notz', notes.some((n) => /time ?zone/i.test(n)), false);

    const rows = feedSourceRows(mergeOrder([a, b]), null);
    is('merge.self.sources', rows.map((r) => r.tag).join(','), 'f0,f1');
  }

  // ── M2 · two real feeds ───────────────────────────────────────────────────
  const secondName = path.basename(SECOND_FEED);
  const twoA = await feedFile(REFERENCE_FEED, path.basename(REFERENCE_FEED));
  const twoB = await feedFile(SECOND_FEED, secondName);
  if (!twoA || !twoB) {
    skips.push(`M2 two feeds — ${path.relative(REPO, SECOND_FEED)} is not cached`);
  } else {
    line('  M2 · the reference feed merged with Rochester');
    const a = await loadFeed(twoA, cache);
    const b = await loadFeed(twoB, cache);
    /** @type {string[]} */
    const notes = [];
    const m = await mergeFeeds([a, b], { onNote: (msg) => notes.push(msg) });

    is('merge.two.stops', Object.keys(m.stops).length, 2291);
    is('merge.two.routes', Object.keys(m.routes).length, 53);
    is('merge.two.trips', m.tables.trips.length, 6347);
    is('merge.two.stopTimes', stopTimesOf(m).length, 224047);
    // The same claim as a relation, so a refreshed fixture still catches row loss.
    is('merge.two.stopTimesSum', stopTimesOf(m).length,
      stopTimesOf(a).length + stopTimesOf(b).length);

    // The INTERSECTION, not the union: `dayTypes` picks a representative date by trip
    // count over the window, and a union would happily pick one nobody runs on.
    is('merge.two.window', `${m.feedStart}/${m.feedEnd}`, '20260729/20260828');

    const tzNote = notes.find((n) => /time ?zone/i.test(n)) || '';
    is('merge.two.timezone',
      tzNote.includes('America/New_York') && tzNote.includes('America/Chicago'), true);

    // Referential integrity. The stop_times sweep is at a fixed stride, which is
    // deterministic and still crosses both feeds' halves of the store.
    let refsOk = true;
    for (const row of m.tables.trips) {
      if (!(String(row.route_id) in m.routes)) { refsOk = false; break; }
    }
    const services = new Set([
      ...idSet(m.tables.calendar, 'service_id'),
      ...idSet(m.tables.calendar_dates, 'service_id'),
    ]);
    for (const row of m.tables.trips) {
      if (!services.has(String(row.service_id ?? '').trim())) { refsOk = false; break; }
    }
    const st = stopTimesOf(m);
    for (let i = 0; i < st.length; i += 97) {
      if (!(st.stopId(i) in m.stops)) { refsOk = false; break; }
    }
    is('merge.two.refs', refsOk, true);

    // Content-addressed order: the argument order must not reach the output.
    const swapped = await mergeFeeds([b, a]);
    is('merge.two.deterministic',
      swapped.sha256 === m.sha256
      && Object.keys(swapped.stops).sort(cmpStr).join(' ')
        === Object.keys(m.stops).sort(cmpStr).join(' '), true);

    // ONE feed's fare table, never both concatenated, and the merge says whose:
    // the house rule quotes `fare_attributes[0]` as the price for the whole map.
    // Here the trip-count primary (the reference feed) is the one that has fares;
    // M5 covers the other direction, where the primary ships none.
    is('merge.two.fares',
      `${(m.tables.fare_attributes || []).length}/${m.fareAgency}`,
      `${(a.tables.fare_attributes || []).length}/${a.agencyName}`);

    const info = m.tables.feed_info || [];
    is('merge.two.feedinfo',
      info.length === 1
      && info[0].feed_start_date === m.feedStart
      && info[0].feed_end_date === m.feedEnd, true);
  }

  // ── M3 · end to end ───────────────────────────────────────────────────────
  // A SHAPE check and never a golden: a merged map is not a stable reference and must
  // never grow one.
  if (!MERGE_PIPELINE) {
    skips.push('M3 end-to-end — pass --merge-pipeline to run it');
  } else if (!twoA || !twoB) {
    skips.push('M3 end-to-end — the second feed is not cached');
  } else {
    line('  M3 · a merged run, end to end');
    const pipeA = await feedFile(REFERENCE_FEED, path.basename(REFERENCE_FEED));
    const pipeB = await feedFile(SECOND_FEED, secondName);
    let pipeFatal = null;
    const sink = (msg) => {
      if (msg.type === 'error' && msg.fatal) pipeFatal = `${msg.stage}: ${msg.message}`;
    };
    const opts = { source: 'merged', ...PIPELINE_OPTS };
    const rep = await runPipeline(opts, [pipeA, pipeB], sink);
    is('merge.pipe.fatal', pipeFatal, null);
    is('merge.pipe.report', Boolean(rep), true);
    if (rep) {
      const served = Number((rep.metrics || {}).servedStops) || 0;
      is('merge.pipe.servedStops', served >= 1493 && served <= 1493 + 798, true);
      const score = (rep.fitness || {}).score;
      is('merge.pipe.fitness', score !== null && score !== undefined, true);
      is('merge.pipe.zones', (rep.zones || []).length > 0
        && (rep.rankedZoneIds || []).length > 0, true);
      // Labels, not just a count: a count of 2 stays green even when both rows are
      // attributed to the wrong source. §09 is the record of what was read.
      is('merge.pipe.feeds',
        ((rep.provenance || {}).feeds || []).map((r) => r.label).join(','),
        `${path.basename(REFERENCE_FEED)},${secondName}`);
    }
  }

  // ── M4 · one source of three cannot be downloaded ──────────────────────────
  // The path D8 was written for. What is asserted is not that it survives — M3
  // already shows a merged run completing — but that the report NAMES the two feeds
  // that loaded and nothing else: `feedSourceRows` walks the merge order, whose
  // indices address the loaded list, so the source metadata has to travel beside the
  // feed it produced rather than be looked up by position afterwards.
  if (!MERGE_PIPELINE) {
    skips.push('M4 a dead source — pass --merge-pipeline to run it');
  } else if (!twoA || !twoB) {
    skips.push('M4 a dead source — the second feed is not cached');
  } else {
    line('  M4 · three sources, the first one dead');
    const liveA = await feedFile(REFERENCE_FEED, path.basename(REFERENCE_FEED));
    const liveB = await feedFile(SECOND_FEED, secondName);
    /** @type {string[]} */
    const degradations = [];
    let deadFatal = null;
    const sink = (msg) => {
      if (msg.type === 'degraded') degradations.push(String(msg.message));
      if (msg.type === 'error' && msg.fatal) deadFatal = `${msg.stage}: ${msg.message}`;
    };
    const opts = { source: 'merged', ...PIPELINE_OPTS };
    const rep = await runPipeline(opts, [
      { kind: 'url', file: null, url: DEAD_FEED_URL, id: 'url:dead', label: 'Dead Mirror Transit', mdbId: 999 },
      { kind: 'file', file: liveA, url: null, id: 'file:a', label: 'The Rapid', mdbId: 1 },
      { kind: 'file', file: liveB, url: null, id: 'file:b', label: 'Rochester', mdbId: 2 },
    ], sink);
    is('merge.dead.fatal', deadFatal, null);
    is('merge.dead.report', Boolean(rep), true);
    const feeds = ((rep || {}).provenance || {}).feeds || [];
    is('merge.dead.labels', feeds.map((r) => r.label).join(','), 'The Rapid,Rochester');
    // Each row must describe the feed it names, not the one beside it.
    is('merge.dead.sources', feeds.map((r) => r.source).join(','),
      `${path.basename(REFERENCE_FEED)},${secondName}`);
    // One failure, one line — the sentence that names the feed and the consequence.
    is('merge.dead.degraded',
      degradations.filter((d) => d.includes('Dead Mirror Transit')).length, 1);
  }

  // ── M5 · the big pair, for the fare fallback ───────────────────────────────
  // The reference feed (5,620 trips, one fare row) merged with MBTA (83,098 trips, no
  // `fare_attributes.txt`). The primary is MBTA, so taking the primary's table alone
  // would silently delete the `carry_fare` house rule that Grand Rapids produces on
  // its own — the commonest shape of merge is a small city beside a big neighbour.
  const bigFeed = MERGE_PIPELINE ? await feedFile(BIG_FEED, path.basename(BIG_FEED)) : null;
  if (!MERGE_PIPELINE) {
    skips.push('M5 the big pair — pass --merge-pipeline to run it');
  } else if (!refA || !bigFeed) {
    skips.push(`M5 the big pair — ${path.relative(REPO, BIG_FEED)} is not cached`);
  } else {
    line('  M5 · the reference feed merged with MBTA');
    const small = await loadFeed(await feedFile(REFERENCE_FEED, path.basename(REFERENCE_FEED)), cache);
    const big = await loadFeed(bigFeed, cache);
    const m = await mergeFeeds([small, big]);
    // The primary really is the fare-less feed, or the assertion below proves nothing.
    is('merge.big.primary',
      big.tables.trips.length > small.tables.trips.length
      && (big.tables.fare_attributes || []).length === 0, true);
    is('merge.big.fares',
      `${(m.tables.fare_attributes || []).length}/${m.fareAgency}`,
      `${(small.tables.fare_attributes || []).length}/${small.agencyName}`);
    // The mixed `shape_dist_traveled` case, which only this pair exercises.
    is('merge.big.stopTimes', stopTimesOf(m).length,
      stopTimesOf(small).length + stopTimesOf(big).length);
  }

  return { results, skips };
}

async function main() {
  let bytes;
  try {
    bytes = await readFile(FEED_PATH);
  } catch (err) {
    process.stderr.write(`smoke: cannot read reference feed ${FEED_PATH}\n`
      + `       ${err.message}\n`);
    return 2;
  }

  // A `Blob` with a `name` is what `_s1ReadSource` (gtfs/feed.js) duck-types a picked `File` as:
  // it has `.arrayBuffer()`, so the bytes are read directly with no network and no
  // cache. Node 24 has `Blob` and `File` globally; `File` is used when available so
  // the harness exercises exactly the browser path.
  const source = typeof File === 'function'
    ? new File([bytes], path.basename(FEED_PATH), { type: 'application/zip' })
    : Object.assign(new Blob([bytes], { type: 'application/zip' }),
      { name: path.basename(FEED_PATH) });

  const options = { source: path.basename(FEED_PATH), ...PIPELINE_OPTS };

  const t0 = performance.now();
  let mark = t0;
  /** @type {Array<[string, number]>} */
  const timings = [];
  /** @type {string[]} */
  const degradations = [];
  /** @type {string[]} */
  const errors = [];
  let fatal = null;

  const emit = (msg) => {
    switch (msg.type) {
      case 'stage': {
        const now = performance.now();
        timings.push([msg.stage, now - mark]);
        mark = now;
        break;
      }
      case 'degraded':
        degradations.push(msg.message);
        break;
      case 'error':
        errors.push(`${msg.stage}: ${msg.message}`);
        if (msg.fatal) fatal = `${msg.stage}: ${msg.message}`;
        break;
      case 'log':
        if (!QUIET) process.stderr.write(`${colour(DIM, `  [${msg.level}] ${msg.message}`)}\n`);
        break;
      default:
        break;
    }
  };

  line(`smoke: ${path.relative(REPO, FEED_PATH)}  (--no-osm)`);
  line('');

  let report;
  try {
    report = await runPipeline(options, source, emit);
  } catch (err) {
    process.stderr.write(`smoke: pipeline threw: ${err && err.stack ? err.stack : err}\n`);
    return 1;
  }
  const elapsed = performance.now() - t0;

  // ── stage timings ─────────────────────────────────────────────────────────
  line('Stage timings');
  for (const name of STAGES) {
    const row = timings.find((t) => t[0] === name);
    const ms = row ? row[1] : null;
    const bar = ms === null ? '—' : `${(ms / 1000).toFixed(2)}s`;
    line(`  ${name.padEnd(12)} ${bar.padStart(8)}`);
  }
  line(`  ${'TOTAL'.padEnd(12)} ${`${(elapsed / 1000).toFixed(2)}s`.padStart(8)}`);
  line('');

  if (fatal) {
    process.stderr.write(`smoke: FATAL ${fatal}\n`);
    return 1;
  }
  if (!report) {
    process.stderr.write('smoke: pipeline returned no report\n');
    return 1;
  }

  // ── the golden numbers (generate.py selftest) ─────────────────
  const m = report.metrics || {};
  const exact = [
    ['served_stops', m.servedStops, 1490],
    ['routes', m.routes, 24],
    ['trips', m.trips, 1699],
    ['zones', (report.zones || []).length, 319],
    ['hub stop_id', report.hub ? report.hub.stopId : null, '1'],
    ['size', report.size ? report.size.name : null, 'medium'],
  ];
  const approx = [
    ['hull_sq_mi', (Number(m.hullSqM) || 0) / SQM_PER_SQMI, 160.1, 0.5],
    ['t90_min', Number(m.t90Min) || 0, 76.8, 1.0],
    ['hub_route_share', report.hub ? report.hub.routeShare : null, 0.750, 0.01],
  ];

  // The scoring layer is not covered by generate.py's own selftest, so these are
  // measured against a real `python3 generate.py <reference feed> --no-osm` run.
  // Every one of them is an exact integer-tenths quantity — a drift of 0.1 here is
  // a bug in a ramp, in `tenths()`, or in the drop-and-renormalise rule.
  const fit = report.fitness || {};
  exact.push(
    ['fitness.score', fit.score === undefined ? null : fit.score, 76.0],
    ['fitness.available', fit.availablePoints === undefined ? null : fit.availablePoints, 75.0],
    ['fitness.band', fit.band || null, 'Strong map'],
    ['fitness.cappedBy', fit.cappedBy === undefined ? null : fit.cappedBy, null],
    ['ranked_zones', (report.rankedZoneIds || []).length, 315],
    ['dossiers', (report.dossierZoneIds || []).length, 13],
    ['findings', (report.findings || []).length, 13],
    ['house_rules', (report.recommendations || []).length, 10],
    ['top_zone', (report.rankedZoneIds || [])[0] || null, '6496'],
    ['top_zone_tenths',
      report.zoneScores && report.rankedZoneIds && report.rankedZoneIds.length
        ? report.zoneScores[report.rankedZoneIds[0]].overallTenths : null,
      976],
  );

  /** @type {Array<{name:string,expected:string,actual:string,pass:boolean}>} */
  const results = [];
  for (const [name, got, want] of exact) {
    results.push({
      name, expected: show(want), actual: show(got), pass: got === want,
    });
  }
  for (const [name, got, want, tol] of approx) {
    const ok = got !== null && got !== undefined && Number.isFinite(Number(got))
      && Math.abs(Number(got) - want) <= tol;
    results.push({
      name, expected: `${want} ±${tol}`, actual: show(got), pass: ok,
    });
  }

  line('Golden numbers (the CLI selftest baseline, plus a measured scoring set)');
  for (const r of results) {
    const tag = r.pass ? colour(GREEN, 'PASS') : colour(RED, 'FAIL');
    line(`  ${tag}  ${r.name.padEnd(17)} expected ${r.expected.padEnd(14)} actual ${r.actual}`);
  }
  line('');

  // ── structural sanity, reported but not asserted ──────────────────────────
  line('Pipeline shape');
  line(`  days              ${(report.days || []).length}`);
  line(`  routeHeadways     ${(report.routeHeadways || []).length}`);
  line(`  travelSamples     ${(report.travelSamples || []).length}`);
  line(`  stops (map layer) ${(report.stops || []).length}`);
  line(`  questions         ${(report.questions || []).length}`);
  line(`  curses            ${(report.curses || []).length}`);
  line(`  questionOrder     ${JSON.stringify(report.questionOrder || [])}`);
  line(`  questionFunnel    ${JSON.stringify(report.questionFunnel || [])}`);
  line(`  fitness.score     ${report.fitness ? show(report.fitness.score) : 'null (no score.js)'}`);
  line(`  provenance        ${report.provenance ? 'present' : 'null (no score.js)'}`);
  line('');

  if (degradations.length) {
    line('Degradations');
    for (const d of degradations) line(`  · ${d}`);
    line('');
  }
  if (errors.length) {
    line('Non-fatal errors');
    for (const e of errors) line(`  · ${e}`);
    line('');
  }

  // ── B1 · a supplied border ────────────────────────────────────────────────
  // The second scenario: the same feed with `borderBbox` clipping the south fifth.
  // Every assertion is a relation to the plain run above or a shape — the served
  // count fell, the unfiltered count is still 1,490, the border is the box itself
  // with no padding and says so, and no row of the stop table lies outside it.
  /** @type {Array<{name:string,expected:string,actual:string,pass:boolean}>} */
  const borderResults = [];
  {
    line('The in-play set (CONTRACT.md §(b) Metrics "Stop set")');
    const bis = (name, got, want) => borderResults.push({
      name, expected: show(want), actual: show(got), pass: got === want,
    });

    // Additive (2026-08-27): the Border and Metrics fields the in-play set added,
    // read off the PLAIN run above. There the set is null all the way down, so
    // these describe the whole feed; they live here rather than among the goldens
    // so the 19 stay the 19.
    const b = report.border || {};
    bis('plain.trimmedStopIds', Array.isArray(b.trimmedStopIds), true);
    bis('plain.derivation', b.derivation || null, 'reach');
    bis('plain.rawBbox', Array.isArray(b.rawBbox) && b.rawBbox.length === 4, true);
    bis('plain.allServedStops', m.allServedStops, 1490);
    bis('plain.inPlayFallback', m.inPlayFallback, false);
    // `suggestBorder` (2026-08-27) on the reference feed: 1,484 of its 1,490 served
    // stops are within one 60-minute hiding period of Central Station one-way, a
    // 0.4 % trim under `SUGGEST_MIN_TRIM_SHARE`, so the gate says nothing to offer.
    // Measured, not assumed; the field is present and null, and a run that starts
    // offering a border here has moved the reach model or the threshold.
    bis('plain.suggestedBorder', 'suggestedBorder' in report && report.suggestedBorder === null, true);

    line('  B1 · the same feed inside a border clipping the south fifth');
    let clipFatal = null;
    const clipSource = typeof File === 'function'
      ? new File([bytes], path.basename(FEED_PATH), { type: 'application/zip' })
      : Object.assign(new Blob([bytes], { type: 'application/zip' }),
        { name: path.basename(FEED_PATH) });
    const clipOpts = {
      source: path.basename(FEED_PATH), ...PIPELINE_OPTS, borderBbox: Array.from(BORDER_CLIP_BBOX),
    };
    let clipped = null;
    try {
      clipped = await runPipeline(clipOpts, clipSource, (msg) => {
        if (msg.type === 'error' && msg.fatal) clipFatal = `${msg.stage}: ${msg.message}`;
      });
    } catch (err) {
      clipFatal = err && err.stack ? err.stack : String(err);
    }
    bis('border.fatal', clipFatal, null);
    bis('border.report', Boolean(clipped), true);
    if (clipped) {
      const cm = clipped.metrics || {};
      const cb = clipped.border || {};
      const allServed = Number(m.servedStops) || 0;
      const served = Number(cm.servedStops) || 0;
      // Fewer than the whole feed, more than the fallback floor — the clip was a
      // trim, not a miss, and no fallback fired.
      bis('border.served_stops', served < allServed && served > 0.5 * allServed, true);
      bis('border.allServedStops', cm.allServedStops, 1490);
      bis('border.inPlayFallback', cm.inPlayFallback, false);
      bis('border.size', clipped.size ? clipped.size.name : null, 'medium');
      bis('border.derivation', cb.derivation || null, 'option');
      bis('border.padM', cb.padM, 0);
      bis('border.bbox', JSON.stringify(cb.bbox), JSON.stringify(BORDER_CLIP_BBOX));
      bis('border.rawBbox', JSON.stringify(cb.rawBbox), JSON.stringify(cb.bbox));
      bis('border.trimmedStopIds', Array.isArray(cb.trimmedStopIds), true);
      // The stop table and the zones are the in-play set, not the feed: nothing
      // south of the box may appear on the map.
      const [bs, bw, bn, be] = BORDER_CLIP_BBOX;
      const inside = (r) => bs <= r.lat && r.lat <= bn && bw <= r.lon && r.lon <= be;
      bis('border.stops_inside', (clipped.stops || []).every(inside), true);
      bis('border.stops_rows', (clipped.stops || []).length, served);
      // The hub run covers the whole network whatever the in-play set is, so the reach
      // counts have to be narrowed to the set as well: §05 and the A2 finding print
      // `reachWithinHidingPeriod` and `servedStops` against each other, and this used
      // to read "1,486 of 1,190 served stops". A count can never exceed its own
      // denominator. (2026-08-27.)
      bis('border.reach_le_served', cm.reachWithinHidingPeriod <= served, true);
      bis('border.reach_by_size_le_served',
        Object.values(cm.reachWithinHidingPeriodBySize || {}).every((n) => n <= served), true);
      // Zone MEMBERS are the in-play set too, not just the zone centres: a stop the box
      // deleted must not go on contributing its departures to a zone's headway and its
      // id to the strategy view's "N stops inside the circle".
      const known = new Set((clipped.stops || []).map((r) => r.stopId));
      bis('border.zone_members_in_play',
        (clipped.zones || []).every((z) => (z.stopIds || []).every((sid) => known.has(sid))), true);
      bis('border.zones_fewer', (clipped.zones || []).length < (report.zones || []).length, true);
      // The hub is still the reference hub — Central Station is well inside the box.
      bis('border.hub', clipped.hub ? clipped.hub.stopId : null, '1');
    }
    for (const r of borderResults) {
      const tag = r.pass ? colour(GREEN, 'PASS') : colour(RED, 'FAIL');
      line(`  ${tag}  ${r.name.padEnd(24)} expected ${r.expected.padEnd(12)} actual ${r.actual}`);
    }
    line('');
  }

  // ── the merge phases ──────────────────────────────────────────────────────
  // Reported on their own line: the 19 above are the algorithm's fingerprint and
  // must stay legible, and a merge assertion is a different kind of claim.
  /** @type {Array<{name:string,expected:string,actual:string,pass:boolean}>} */
  let mergeResults = [];
  /** @type {string[]} */
  let mergeSkips = [];
  if (!NO_MERGE) {
    line('Merging several feeds into one (gtfs/merge.js)');
    try {
      ({ results: mergeResults, skips: mergeSkips } = await mergePhases());
    } catch (err) {
      process.stderr.write(`smoke: merge phase threw: ${err && err.stack ? err.stack : err}\n`);
      return 1;
    }
    for (const r of mergeResults) {
      const tag = r.pass ? colour(GREEN, 'PASS') : colour(RED, 'FAIL');
      line(`  ${tag}  ${r.name.padEnd(24)} expected ${r.expected.padEnd(12)} actual ${r.actual}`);
    }
    for (const skip of mergeSkips) line(`  ${colour(DIM, 'SKIP')}  ${skip}`);
    line('');
  }

  const failed = results.filter((r) => !r.pass);
  const borderFailed = borderResults.filter((r) => !r.pass);
  const mergeFailed = mergeResults.filter((r) => !r.pass);
  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({
      mode: NO_MERGE ? 'goldens' : (MERGE_PIPELINE ? 'goldens+merge+pipeline' : 'goldens+merge'),
      results,
      borderResults,
      mergeResults,
      mergeSkips,
      degradations,
      errors,
    }, null, 2)}\n`);
  }
  line(failed.length
    ? colour(RED, `SUMMARY: ${results.length - failed.length}/${results.length} golden numbers pass `
      + `— ${failed.map((f) => f.name).join(', ')} FAILED`)
    : colour(GREEN, `SUMMARY: ${results.length}/${results.length} golden numbers pass`));
  line(borderFailed.length
    ? colour(RED, `BORDER:  ${borderResults.length - borderFailed.length}/${borderResults.length} `
      + `border assertions pass — ${borderFailed.map((f) => f.name).join(', ')} FAILED`)
    : colour(GREEN, `BORDER:  ${borderResults.length}/${borderResults.length} border assertions pass`));
  if (!NO_MERGE) {
    const n = mergeResults.length;
    const skipTail = mergeSkips.length ? ` (${mergeSkips.length} skipped)` : '';
    line(mergeFailed.length
      ? colour(RED, `MERGE:   ${n - mergeFailed.length}/${n} merge assertions pass${skipTail} `
        + `— ${mergeFailed.map((f) => f.name).join(', ')} FAILED`)
      : colour(GREEN, `MERGE:   ${n}/${n} merge assertions pass${skipTail}`));
  }

  return (failed.length || borderFailed.length || mergeFailed.length) ? 1 : 0;
}

process.exitCode = await main();
