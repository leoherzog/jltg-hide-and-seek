// ══════════════════════════════════════════════════════════════════════════════
// probe-admin.mjs — validate an admin.fgb through the app's own reader.
//
//   node tools/osm-world/probe-admin.mjs <admin.fgb>
//
// Exits 0 when every probe passes, 1 otherwise.
//
// WHY THIS EXISTS AND WHY IT IS NOT A SQL SCRIPT. `build-admin.sh` already runs
// ogrinfo probes, and ogrinfo answers with GEOS: correct, and irrelevant. What
// ships is `osm/worldfile.js` reading FlatGeobuf over HTTP Range and running its
// own ray-cast containment in raw degrees. Every interesting failure lives in the
// gap between those two — a multipolygon whose parts the reader flattens wrong,
// interior rings dropped so the Vatican answers "Italy", an R-tree bbox hit the
// client forgets to re-test against real geometry (Canada's bbox contains Grand
// Rapids). So this harness imports the real reader and feeds it real bytes
// through a file-backed `fetchImpl` that speaks HTTP 206 + Content-Range.
//
// The probes are the ones that actually distinguish a correct build:
//   Grand Rapids  the home map; country must reach it, and CANADA MUST NOT
//   Basel         three sovereign countries inside one 10 km box
//   Vatican       enclave carved as an interior ring — holes are load-bearing
//   Baarle        BE and NL interleaved at ~100 m; the hardest real case there is
//
// Expected values below are ground truth for Overture 2026-07-22.0 divisions.
// If a future release renames something, fix the expectation — do not relax it.
// ══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Locate the client reader ─────────────────────────────────────────────────
// Normally this file sits in tools/osm-world/ and the reader is ../../osm/. The
// fallbacks exist because this harness is genuinely useful copied next to a
// multi-GB fgb on a build box, where the repo lives somewhere else entirely.
function resolveWorldfile() {
  const candidates = [];
  if (process.env.WORLDFILE) candidates.push(path.resolve(process.env.WORLDFILE));
  candidates.push(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../osm/worldfile.js'));
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    candidates.push(path.join(dir, 'osm/worldfile.js'));
    if (path.dirname(dir) === dir) break;
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'probe-admin: cannot find osm/worldfile.js. Run from the repo, or set WORLDFILE=/path/to/osm/worldfile.js.\n'
    + `  tried:\n${candidates.map((c) => `    ${c}`).join('\n')}`,
  );
}

const { openWorld, worldAdminAreas, adminAreasAt } = await import(pathToFileURL(resolveWorldfile()).href);

// ── A file-backed fetch that behaves like a Range-capable origin ─────────────
// Deliberately strict: 206 only, a real Content-Range so the reader learns the
// file size the same way it does over HTTP, and reads clamped to EOF. A lenient
// stub here would hide exactly the transport bugs this is meant to catch.
function makeFetch(fgbPath, manifestPath) {
  const size = fs.statSync(fgbPath).size;
  return async (url, init = {}) => {
    const name = path.basename(String(url));
    if (name === 'manifest.json') {
      return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(manifestPath, 'utf8')) };
    }
    const match = /bytes=(\d+)-(\d+)/.exec((init.headers || {}).Range || '');
    if (!match) throw new Error(`probe-admin: request for ${name} carried no Range header`);
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), size - 1);
    const length = Math.max(0, end - start + 1);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(fgbPath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    return {
      ok: true,
      status: 206,
      headers: { get: (k) => (String(k).toLowerCase() === 'content-range' ? `bytes ${start}-${end}/${size}` : null) },
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    };
  };
}

// ── Probes ───────────────────────────────────────────────────────────────────
// bbox is the app's [south, west, north, east]. Point specs match a hit when
// every field given agrees; `reject` specs must match nothing.
const PROBES = [
  {
    label: 'Grand Rapids, Michigan',
    bbox: [42.87, -85.75, 43.05, -85.55],
    expectIso1: ['US'],
    // Canada is one relation with one bbox spanning lon -141..-52, lat 41.7..83.1,
    // which contains Grand Rapids. If it survives into the area list, `adminInfo`
    // picks it over the US and the whole page renders in kilometres.
    rejectIso1: ['CA'],
    points: [
      {
        label: 'GR downtown',
        lat: 42.9634,
        lon: -85.6681,
        expect: [{ level: 2, iso1: 'US' }, { level: 4, iso2: 'US-MI' }, { level: 6, name: 'Kent County' }, { level: 8, name: 'Grand Rapids' }],
        reject: [{ iso1: 'CA' }],
      },
    ],
  },
  {
    label: 'Basel tri-border',
    bbox: [47.52, 7.55, 47.60, 7.65],
    expectIso1: ['CH', 'DE', 'FR'],
    points: [
      {
        label: 'Basel Altstadt CH',
        lat: 47.5596,
        lon: 7.5886,
        expect: [{ level: 2, iso1: 'CH' }, { level: 4, iso2: 'CH-BS' }],
        reject: [{ level: 2, iso1: 'DE' }, { level: 2, iso1: 'FR' }],
      },
      {
        label: 'Weil am Rhein DE',
        lat: 47.5928,
        lon: 7.6236,
        expect: [{ level: 2, iso1: 'DE' }, { level: 4, iso2: 'DE-BW' }],
        reject: [{ level: 2, iso1: 'CH' }, { level: 2, iso1: 'FR' }],
      },
      {
        label: 'Saint-Louis FR',
        lat: 47.5890,
        lon: 7.5620,
        expect: [{ level: 2, iso1: 'FR' }, { level: 4, iso2: 'FR-GES' }],
        reject: [{ level: 2, iso1: 'CH' }, { level: 2, iso1: 'DE' }],
      },
    ],
  },
  {
    label: 'Vatican enclave',
    bbox: [41.85, 12.40, 41.95, 12.55],
    expectIso1: ['IT', 'VA'],
    points: [
      {
        // Inside Italy's OUTER ring and inside one of its interior rings. Passes only
        // if the reader kept holes and `adminAreasAt` subtracts them.
        label: "St Peter's Square",
        lat: 41.9029,
        lon: 12.4534,
        expect: [{ level: 2, iso1: 'VA' }],
        reject: [{ level: 2, iso1: 'IT' }],
      },
      {
        // The control: 3.5 km east, same country polygon, no hole.
        label: 'Rome centre',
        lat: 41.9028,
        lon: 12.4964,
        expect: [{ level: 2, iso1: 'IT' }, { level: 8, name: 'Roma' }],
        reject: [{ level: 2, iso1: 'VA' }],
      },
    ],
  },
  {
    label: 'Baarle-Hertog / -Nassau',
    bbox: [51.42, 4.90, 51.46, 4.96],
    expectIso1: ['BE', 'NL'],
    points: [
      {
        label: 'Baarle-Hertog BE',
        lat: 51.4390,
        lon: 4.9297,
        expect: [{ level: 2, iso1: 'BE' }, { level: 8, name: 'Baarle-Hertog' }],
        reject: [{ level: 2, iso1: 'NL' }],
      },
      {
        // ~1 km away, back in the Netherlands. Both directions must hold: a build
        // that returned the union everywhere would pass the first point alone.
        label: 'Baarle-Nassau NL',
        lat: 51.4306,
        lon: 4.9333,
        expect: [{ level: 2, iso1: 'NL' }, { level: 8, name: 'Baarle-Nassau' }],
        reject: [{ level: 2, iso1: 'BE' }],
      },
    ],
  },
];

const matches = (area, spec) => Object.entries(spec).every(([key, want]) => area[key] === want);
const describe = (spec) => Object.entries(spec).map(([k, v]) => `${k}=${v}`).join(' ');
const fmt = (a) => `lvl ${a.level} ${a.name || '(unnamed)'}${a.iso1 ? ` iso1=${a.iso1}` : ''}${a.iso2 ? ` iso2=${a.iso2}` : ''}`;

async function main() {
  const fgbArg = process.argv[2];
  if (!fgbArg) {
    console.error('usage: node tools/osm-world/probe-admin.mjs <admin.fgb>');
    return 2;
  }
  const fgbPath = path.resolve(fgbArg);
  if (!fs.existsSync(fgbPath)) {
    console.error(`probe-admin: no such file: ${fgbPath}`);
    return 2;
  }

  // A synthetic one-layer manifest: the reader only ever needs `layers.admin.path`,
  // and building it here means the harness runs against a bare fgb straight out of
  // the build, before merge.py has written the real global manifest.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-admin-'));
  const manifestPath = path.join(tmpDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    planet_timestamp: 'probe',
    admin_source: 'overture',
    layers: { admin: { path: path.basename(fgbPath), features: 0, bytes: fs.statSync(fgbPath).size, sha256: '' } },
  }));

  const fetchImpl = makeFetch(fgbPath, manifestPath);
  const failures = [];
  const record = (ok, line) => {
    console.log(`    ${ok ? 'ok  ' : 'FAIL'} ${line}`);
    if (!ok) failures.push(line);
  };

  console.log(`probe-admin: ${fgbPath} (${(fs.statSync(fgbPath).size / 1e9).toFixed(2)} GB)`);
  const world = await openWorld('http://probe.local/world', { fetchImpl });

  for (const probe of PROBES) {
    const before = world.stats();
    const areas = await worldAdminAreas(world, probe.bbox, { fetchImpl });
    const after = world.stats();
    if (areas === null) {
      failures.push(`${probe.label}: manifest has no admin layer`);
      console.log(`\n  ${probe.label}: FAIL — no admin layer`);
      continue;
    }
    const byLevel = [...new Set(areas.map((a) => a.level))].sort((a, b) => a - b)
      .map((l) => `${l}:${areas.filter((a) => a.level === l).length}`).join(' ');
    console.log(`\n  ${probe.label}  bbox [${probe.bbox.join(', ')}]`);
    console.log(`    ${areas.length} areas (level:count ${byLevel})`
      + `  ${after.requests - before.requests} range requests`
      + `  ${((after.bytes - before.bytes) / 1e6).toFixed(2)} MB`);
    if (process.env.PROBE_VERBOSE) {
      for (const a of areas) console.log(`      ${fmt(a)} rings=${a.rings.length} holes=${a.holes.length}`);
    }

    const iso1s = new Set(areas.filter((a) => a.iso1).map((a) => a.iso1));
    for (const want of probe.expectIso1 || []) {
      record(iso1s.has(want), `bbox contains a ${want} area  (saw: ${[...iso1s].sort().join(',') || 'none'})`);
    }
    for (const bad of probe.rejectIso1 || []) {
      record(!iso1s.has(bad), `bbox excludes ${bad} (bbox-hit superset must be re-tested against geometry)`);
    }

    for (const point of probe.points) {
      const hits = adminAreasAt(areas, point.lat, point.lon);
      const shown = hits.map(fmt).join(' | ') || '(nothing)';
      console.log(`    @ ${point.label} (${point.lat}, ${point.lon}) -> ${shown}`);
      for (const spec of point.expect || []) {
        record(hits.some((h) => matches(h, spec)), `${point.label}: ${describe(spec)}`);
      }
      for (const spec of point.reject || []) {
        record(!hits.some((h) => matches(h, spec)), `${point.label}: NOT ${describe(spec)}`);
      }
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  const { requests, bytes } = world.stats();
  console.log(`\n  total: ${requests} range requests, ${(bytes / 1e6).toFixed(2)} MB read`);
  if (failures.length) {
    console.error(`\nprobe-admin: ${failures.length} FAILED`);
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log('\nprobe-admin: all probes passed');
  return 0;
}

process.exit(await main());
