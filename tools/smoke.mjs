#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// tools/smoke.mjs — headless end-to-end harness
// ═══════════════════════════════════════════════════════════════════════════════
//
// Runs `runPipeline` from worker.js against the cached reference feed with the
// OSM layer disabled, and asserts generated/generate.py's own golden numbers from
// `selftest()` (line 15757). Those numbers are measured, not guessed: a change to
// any of them means an algorithm changed, which may be correct but must be
// deliberate. Never adjust an assertion to make it pass.
//
//   node tools/smoke.mjs [--feed <path>] [--quiet] [--json]
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
import { SQM_PER_SQMI } from '../lib/core.js';

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

async function main() {
  let bytes;
  try {
    bytes = await readFile(FEED_PATH);
  } catch (err) {
    process.stderr.write(`smoke: cannot read reference feed ${FEED_PATH}\n`
      + `       ${err.message}\n`);
    return 2;
  }

  // A `Blob` with a `name` is what `fetchFeedZip` duck-types a picked `File` as:
  // it has `.arrayBuffer()`, so the bytes are read directly with no network and no
  // cache. Node 24 has `Blob` and `File` globally; `File` is used when available so
  // the harness exercises exactly the browser path.
  const source = typeof File === 'function'
    ? new File([bytes], path.basename(FEED_PATH), { type: 'application/zip' })
    : Object.assign(new Blob([bytes], { type: 'application/zip' }),
      { name: path.basename(FEED_PATH) });

  const options = {
    source: path.basename(FEED_PATH),
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

  // ── the golden numbers (generate.py selftest, line 15757) ─────────────────
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

  line('Golden numbers (generate.py selftest line 15757, plus a measured scoring set)');
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

  const failed = results.filter((r) => !r.pass);
  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({ results, degradations, errors }, null, 2)}\n`);
  }
  line(failed.length
    ? colour(RED, `SUMMARY: ${results.length - failed.length}/${results.length} golden numbers pass `
      + `— ${failed.map((f) => f.name).join(', ')} FAILED`)
    : colour(GREEN, `SUMMARY: ${results.length}/${results.length} golden numbers pass`));

  return failed.length ? 1 : 0;
}

process.exitCode = await main();
