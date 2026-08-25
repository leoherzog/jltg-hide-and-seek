/**
 * tools/osm-world/test-reader.mjs — exercise `osm/flatgeobuf.js` against a real file.
 *
 * `osm/flatgeobuf.js` is a hand-written reader for a binary format: FlatBuffers vtable
 * arithmetic, a packed Hilbert R-tree walk, and a packed property blob whose field
 * widths come from the header rather than from the blob. Every one of those is the kind
 * of code that is either exactly right or silently returns plausible garbage, so it is
 * checked against a file GDAL wrote rather than reasoned about.
 *
 *   uv run tools/osm-world/make-fixture.py /tmp/fixture.fgb
 *   node tools/osm-world/test-reader.mjs /tmp/fixture.fgb
 *
 * The reader takes an injected `fetchImpl`, so this serves the fixture out of the local
 * filesystem and answers `Range` with a 206 exactly as R2 does — no server needed, and
 * the range handling itself gets tested rather than stubbed out.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

import { FlatGeobufReader, levelBounds, nodeCount, GEOMETRY_TYPE } from '../../osm/flatgeobuf.js';
import { featuresToPois } from '../../osm/worldfile.js';
import { Projection } from '../../lib/geo.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: node tools/osm-world/test-reader.mjs <fixture.fgb>');
  process.exit(2);
}
const BYTES = readFileSync(path);

let requests = 0;

/** A `fetch` that serves one local file and honours `Range` the way R2 does. */
function fileFetch(url, init = {}) {
  requests += 1;
  const range = (init.headers || {}).Range;
  const match = /^bytes=(\d+)-(\d+)$/.exec(range || '');
  if (!match) {
    return Promise.resolve({
      ok: true, status: 200,
      arrayBuffer: async () => BYTES.buffer.slice(BYTES.byteOffset, BYTES.byteOffset + BYTES.length),
    });
  }
  const start = Number(match[1]);
  const end = Math.min(Number(match[2]) + 1, BYTES.length);
  const slice = BYTES.subarray(start, end);
  return Promise.resolve({
    ok: true,
    status: 206,
    // R2 answers a 206 with Content-Range; the reader learns the file size from it and
    // clamps its tail reads, so serving it here tests that path rather than stubbing it.
    headers: {
      get: (name) => (name.toLowerCase() === 'content-range'
        ? `bytes ${start}-${end - 1}/${BYTES.length}`
        : null),
    },
    arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length),
  });
}

// ── the tiny assertion harness ───────────────────────────────────────────────

let passed = 0;
const failures = [];

function check(what, condition, detail = '') {
  if (condition) {
    passed += 1;
  } else {
    failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(a, b, tolerance = 1e-9) {
  return Math.abs(a - b) <= tolerance;
}

// ── level bounds, checked against the shape the format specifies ─────────────

{
  // Pure arithmetic, independent of the fixture: 68 items at the default branching
  // factor of 16 is 68 leaves → 5 → 1, so 74 nodes laid out root first.
  const bounds = levelBounds(68, 16);
  check('levelBounds levels', bounds.length === 3, `got ${bounds.length}`);
  check('levelBounds shape', JSON.stringify(bounds) === '[[6,74],[1,6],[0,1]]',
    JSON.stringify(bounds));
  // The regression that put `dataStart` inside the index: this must be the LEAF
  // level's end (74), not the root level's (1).
  check('nodeCount counts every level', nodeCount(68, 16) === 74, `got ${nodeCount(68, 16)}`);
  check('levelBounds root is one node',
    bounds[bounds.length - 1][1] - bounds[bounds.length - 1][0] === 1, JSON.stringify(bounds));
}

// ── header ───────────────────────────────────────────────────────────────────

const reader = new FlatGeobufReader('file://fixture.fgb', { fetchImpl: fileFetch });
const head = await reader.open();

check('header feature count', head.featuresCount === 2008, `got ${head.featuresCount}`);
check('header has a spatial index', head.indexNodeSize > 0, `got ${head.indexNodeSize}`);
check('header column count', head.columns.length === 4,
  JSON.stringify(head.columns.map((c) => c.name)));
check('header column names',
  head.columns.map((c) => c.name).join(',') === 'osm_type,osm_id,name,rank',
  head.columns.map((c) => c.name).join(','));

// ── a bbox query over the interesting features ───────────────────────────────

const rect = { minX: -85.70, minY: 42.94, maxX: -85.65, maxY: 42.99 };
const features = await reader.query(rect);
// Identity is two columns now; recompose the short form for readability.
const shortId = (f) => `${String(f.properties.osm_type || '?')[0]}${f.properties.osm_id}`;
const byId = new Map(features.map((f) => [shortId(f), f]));

check('query found the point', byId.has('n1'));
check('query found the polygon', byId.has('w3'));
check('query found the linestring', byId.has('w4'));
check('query found the multipolygon', byId.has('r5'));
check('query found the multilinestring', byId.has('w6'));
check('query excluded distant filler',
  features.length === 8, `${features.length} features returned, expected the 8 real ones`);
check('identity arrives as two properties, not a Feature-level id',
  typeof byId.get('w3').properties.osm_type === 'string'
  && Number.isFinite(byId.get('w3').properties.osm_id),
  JSON.stringify({ t: byId.get('w3').properties.osm_type, i: byId.get('w3').properties.osm_id }));

// ── geometry decoding, shape by shape ────────────────────────────────────────

{
  const point = byId.get('n1');
  check('point type', point.type === GEOMETRY_TYPE.POINT, `got ${point.type}`);
  check('point count', point.points.length === 1, `got ${point.points.length}`);
  check('point lon', near(point.points[0][0], -85.6681, 1e-7), String(point.points[0][0]));
  check('point lat', near(point.points[0][1], 42.9634, 1e-7), String(point.points[0][1]));
}

{
  const polygon = byId.get('w3');
  check('polygon type', polygon.type === GEOMETRY_TYPE.POLYGON, `got ${polygon.type}`);
  check('polygon part count', polygon.polygons.length === 1, `got ${polygon.polygons.length}`);
  // THE case a flattened ring list gets wrong.
  check('polygon kept its hole', polygon.polygons[0].inners.length === 1,
    `got ${polygon.polygons[0].inners.length} inner rings`);
  check('polygon outer ring is closed',
    polygon.polygons[0].outer.length === 5, `got ${polygon.polygons[0].outer.length}`);
}

{
  const multi = byId.get('r5');
  check('multipolygon type', multi.type === GEOMETRY_TYPE.MULTIPOLYGON, `got ${multi.type}`);
  check('multipolygon part count', multi.polygons.length === 2, `got ${multi.polygons.length}`);
  check('multipolygon parts have no holes',
    multi.polygons.every((p) => p.inners.length === 0));
}

{
  const line = byId.get('w4');
  check('linestring type', line.type === GEOMETRY_TYPE.LINESTRING, `got ${line.type}`);
  check('linestring run count', line.lines.length === 1, `got ${line.lines.length}`);
  check('linestring vertex count', line.lines[0].length === 3, `got ${line.lines[0].length}`);
}

{
  const multi = byId.get('w6');
  check('multilinestring type', multi.type === GEOMETRY_TYPE.MULTILINESTRING, `got ${multi.type}`);
  check('multilinestring run count', multi.lines.length === 2, `got ${multi.lines.length}`);
  check('multilinestring vertex counts',
    multi.lines[0].length === 2 && multi.lines[1].length === 3,
    multi.lines.map((l) => l.length).join(','));
}

{
  const multi = byId.get('n7');
  check('multipoint point count', multi.points.length === 2, `got ${multi.points.length}`);
}

// ── property decoding ────────────────────────────────────────────────────────

check('string property', byId.get('w3').properties.name === 'Ah-Nab-Awen Park',
  String(byId.get('w3').properties.name));
check('integer property', byId.get('w3').properties.rank === 3,
  `${byId.get('w3').properties.rank} (${typeof byId.get('w3').properties.rank})`);
// An absent column must be ABSENT, not empty string — `name IS NOT NULL` depends on it.
check('absent property is absent', !('name' in byId.get('n2').properties),
  JSON.stringify(byId.get('n2').properties));

// ── the range reads were actually ranged ─────────────────────────────────────

// The whole point of the exercise: a bbox query must read a small fraction of the file.
check('reader used Range requests, not a full download',
  reader.bytesFetched < BYTES.length / 2,
  `read ${reader.bytesFetched} of ${BYTES.length} bytes in ${requests} requests`);

// ── featuresToPois: the representative-point rule and the dedup ──────────────

{
  const proj = new Projection(42.96, -85.67);
  const bbox = [42.94, -85.70, 42.99, -85.65];
  const pois = featuresToPois(features, 'park', proj, bbox, { keepRings: true });
  const poiById = new Map(pois.map((p) => [`${p.osmType[0]}${p.osmId}`, p]));

  check('poi osm identity split', poiById.has('w3') && poiById.get('w3').osmType === 'way');
  check('poi carries its name', poiById.get('w3').name === 'Ah-Nab-Awen Park');
  check('poi kept rings when asked', poiById.get('w3').rings.length === 1);

  // The polygon's representative point must land inside the polygon, not on a corner.
  const park = poiById.get('w3');
  check('polygon icon is inside the polygon',
    park.lat > 42.9660 && park.lat < 42.9700 && park.lon > -85.6760 && park.lon < -85.6700,
    `${park.lat}, ${park.lon}`);

  // The line's icon is its midpoint, which for w4 is the middle vertex.
  const river = poiById.get('w4');
  check('linestring icon is its midpoint',
    near(river.lat, 42.9650, 1e-3) && near(river.lon, -85.6750, 1e-3),
    `${river.lat}, ${river.lon}`);

  // n8 is a node of the same category inside w3 — it must be swallowed by the area.
  check('node inside a same-category area is deduped away', !poiById.has('n8'),
    `${pois.length} pois: ${pois.map((p) => `${p.osmType[0]}${p.osmId}`).join(',')}`);
  check('the area that swallowed it survived', poiById.has('w3'));

  // Sorted by (osmType, osmId) — node, relation, way, then ascending id.
  const order = pois.map((p) => `${p.osmType}/${p.osmId}`);
  const sorted = [...order].sort((a, b) => {
    const [at, ai] = a.split('/');
    const [bt, bi] = b.split('/');
    return (at < bt ? -1 : at > bt ? 1 : 0) || (Number(ai) - Number(bi));
  });
  check('pois are sorted by (osmType, osmId)', order.join('|') === sorted.join('|'),
    order.join('|'));
}

// ── the range gate ───────────────────────────────────────────────────────────

// The module-global gate in `osm/flatgeobuf.js` bounds how many Range requests are in
// flight across every reader at once, and `geodata.js` runs its categories in parallel
// on the strength of that promise. Its failure mode is the reason it is tested here
// rather than trusted: a permit that is taken and never given back does not throw and
// does not corrupt anything — it silently shrinks the ceiling, and enough of them hang
// the OSM layer with no error anywhere. Nothing else in this repo executes the error
// paths under contention, so this drives them deliberately: a third of the requests
// fail, half of those by throwing and half by answering 500, which are the two shapes
// that leak a permit if the `finally` is ever moved or dropped.
{
  const SIZE = 1 << 20;
  let live = 0;
  let peak = 0;
  let served = 0;
  const failingFetch = async (url, init) => {
    served += 1;
    const mine = served;
    live += 1;
    peak = Math.max(peak, live);
    try {
      await new Promise((resolve) => { setTimeout(resolve, 1); });
      if (mine % 3 === 0) {
        if (mine % 2 === 0) throw new Error('synthetic transport failure');
        return new Response('nope', { status: 500 });
      }
      const span = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
      const from = Number(span[1]);
      const to = Number(span[2]) + 1;
      return new Response(new Uint8Array(to - from), {
        status: 206,
        headers: { 'Content-Range': `bytes ${from}-${to - 1}/${SIZE}` },
      });
    } finally {
      live -= 1;
    }
  };

  const gated = new FlatGeobufReader('https://example.invalid/gate.fgb', {
    fetchImpl: failingFetch,
  });
  // Set the size directly: this fixture is never opened, so there is no header read to
  // learn it from, and `read` clamps against it.
  gated.reader.size = SIZE;

  const spans = Array.from({ length: 200 }, (_, i) => [i * 512, i * 512 + 256]);
  const settled = await Promise.allSettled(spans.map(([from, to]) => gated.reader.read(from, to)));
  const fulfilled = settled.filter((one) => one.status === 'fulfilled').length;

  check('the gate is never exceeded', peak <= 32, `peak ${peak} in flight`);
  check('it is actually reached under 200 concurrent reads', peak === 32, `peak ${peak}`);
  check('the failing third really failed', fulfilled > 0 && fulfilled < spans.length,
    `${fulfilled}/${spans.length} fulfilled`);

  // The leak check. A permit lost on an error path shows up as a read that never
  // settles at all, so the timeout — not a rejection — is the failure being caught.
  const outcome = await Promise.race([
    gated.reader.read(900000, 900100).then(() => 'settled', () => 'settled'),
    new Promise((resolve) => { setTimeout(() => resolve('never settled'), 5000); }),
  ]);
  check('a read after 66 failures still settles', outcome === 'settled', outcome);

  // A rejected span must not be remembered: the in-flight map is keyed by span, and a
  // rejection left in it would hand the same stale error to every later read forever.
  const again = await gated.reader.read(1024, 1280).then(() => true, () => true);
  check('a span that failed is still retryable', again);
}

// ── report ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  FAIL  ${failure}`);
  process.exit(1);
}
console.log(`(read ${reader.bytesFetched} of ${BYTES.length} bytes in ${requests} requests)`);
