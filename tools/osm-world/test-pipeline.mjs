/**
 * tools/osm-world/test-pipeline.mjs — run `collectGeodata` for real, end to end.
 *
 *   uv run tools/osm-world/make-test-world.py /tmp/world
 *   node tools/osm-world/test-pipeline.mjs /tmp/world
 *
 * WHY THIS EXISTS. `collectGeodata` is ~250 lines of orchestration that nothing else
 * executes: `tools/smoke.mjs` points the world files at a host that cannot resolve, so
 * it takes the failure path and never enters this function, and every other test stops
 * at the FlatGeobuf reader. That gap is not theoretical — the world-file migration shipped
 * with `zoneInventory` accidentally deleted out from under its own call site, and the
 * failure was completely invisible, because `worker.js` catches everything from that
 * call and degrades to `emptyGeoData`. A crash inside the OSM layer still reaches the
 * page as a generic degradation unless something actually runs it.
 *
 * It serves the test world over real HTTP with real `Range` support rather than
 * injecting a fake `fetch`, because `collectGeodata` builds its own readers internally
 * and never threads a `fetchImpl` through — so a stubbed fetch would test a path the
 * app does not take.
 *
 * The server binds 0.0.0.0, not loopback.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import process from 'node:process';

import { collectGeodata } from '../../osm/geodata.js';
import { openWorld, worldStatsLine, worldCount } from '../../osm/worldfile.js';
import { FlatGeobufReader } from '../../osm/flatgeobuf.js';
import { Projection } from '../../lib/geo.js';

const worldDir = process.argv[2];
if (!worldDir) {
  console.error('usage: node tools/osm-world/test-pipeline.mjs <world-dir>');
  process.exit(2);
}

// ── a static server that speaks Range, the way R2 does ───────────────────────

let rangeRequests = 0;
let bytesServed = 0;

// A path-less manifest entry ({"features": 0}, merge.py's empty-layer shape) must
// never be turned into a reader: `baseUrl + '/' + info.path` on such an entry is
// literally '<base>/undefined'. Counted rather than 404'd so the failure is a named
// assertion, not a mystery in a degraded-category warn line.
let undefinedRequests = 0;

// Layers listed here 404, so a degraded origin can be simulated without a second
// world directory. Mutated between runs below.
const suppressed = new Set();

// basename → body, served INSTEAD of the file on disk. One world directory can then
// stand in for several published builds — used below to serve a legacy manifest that
// still lists `curse_animal_habitat` without rebuilding anything.
const overrides = new Map();

const server = createServer(async (req, res) => {
  try {
    const name = basename(decodeURIComponent(req.url.split('?')[0]));
    if (name === 'undefined') undefinedRequests += 1;
    if (suppressed.has(name)) { res.writeHead(404); res.end('suppressed'); return; }
    const override = overrides.get(name);
    const body = override !== undefined ? override : await readFile(join(worldDir, name));
    const info = { size: body.length };
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]) + 1, info.size);
      const slice = body.subarray(start, end);
      rangeRequests += 1;
      bytesServed += slice.length;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end - 1}/${info.size}`,
        'Content-Length': String(slice.length),
        'Accept-Ranges': 'bytes',
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, { 'Content-Length': String(info.size) });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

// Bind all interfaces — this box is headless and never loopback-only.
await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

// ── the smallest inputs collectGeodata will accept ───────────────────────────

const bbox = [42.9550, -85.6850, 42.9800, -85.6600];   // [s, w, n, e]
const border = { bbox };
const zones = [
  { zoneId: 'Z1', lat: 42.9700, lon: -85.6760 },   // inside Ah-Nab-Awen Park
  { zoneId: 'Z2', lat: 42.9660, lon: -85.6700 },   // near the restaurants
  { zoneId: 'Z3', lat: 42.9740, lon: -85.6690 },   // inside Riverside Park
];
const proj = new Projection(42.967, -85.672);
const radiusM = 400;

let passed = 0;
const failures = [];
const check = (what, ok, detail = '') => {
  if (ok) passed += 1;
  else failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
};

const logLines = [];
let geo;
let world;
try {
  // Exactly what worker.js does: open the world, then hand it to collectGeodata.
  world = await openWorld(baseUrl);
  geo = await collectGeodata(
    world, {}, border, zones, proj, radiusM,
    {
      onProgress: () => {},
      onLog: (level, message) => logLines.push(`${level}: ${message}`),
    },
  );
} catch (err) {
  console.error('\ncollectGeodata THREW — the pipeline is broken:\n');
  console.error(err && err.stack ? err.stack : err);
  console.error('\n--- pipeline log up to the throw ---');
  for (const l of logLines) console.error(`  ${l}`);
  server.close();
  process.exit(1);
}

// ── what a real run has to produce ───────────────────────────────────────────

check('geo.available', geo.available === true, JSON.stringify(geo.notes));

// Categories
check('park features found', (geo.pois.park || []).length === 2,
  `got ${(geo.pois.park || []).length}`);
check('node inside a same-category park was deduped',
  !(geo.pois.park || []).some((p) => p.osmType === 'node'),
  (geo.pois.park || []).map((p) => `${p.osmType}/${p.osmId}`).join(','));
check('park count matches feature list', geo.counts.park === (geo.pois.park || []).length,
  `counts.park=${geo.counts.park}`);
check('restaurants found', (geo.pois.restaurant || []).length === 3,
  `got ${(geo.pois.restaurant || []).length}`);
// A feature crossing the map with no vertex inside it must survive the superset filter.
check('a feature crossing the map with no vertex inside is kept',
  (geo.pois.water || []).some((p) => p.name === 'Crossing Canal'),
  (geo.pois.water || []).map((p) => p.name).join(' | ') || '(no water)');
check('water count agrees with the feature list',
  geo.counts.water === (geo.pois.water || []).length,
  `counts.water=${geo.counts.water} vs pois=${(geo.pois.water || []).length}`);
check('rings kept for park (RING_CATEGORIES)',
  (geo.pois.park || []).every((p) => p.rings && p.rings.length > 0));
check('rings NOT kept for restaurant',
  (geo.pois.restaurant || []).every((p) => !p.rings || p.rings.length === 0));

// THE regression this file exists for.
check('zoneInventory ran and produced per-zone rows',
  geo.zoneInventory && Object.keys(geo.zoneInventory).length === 3,
  JSON.stringify(Object.keys(geo.zoneInventory || {})));
check('zonePolygonHits produced', geo.zonePolygonHits
  && Object.keys(geo.zonePolygonHits).length === 3);
check('the two zone predicates differ (icon vs polygon)',
  JSON.stringify(geo.zoneInventory) !== JSON.stringify(geo.zonePolygonHits));

// Density grid
check('density counts are exact map-wide sums',
  geo.counts.building === 120 + 98 + 140 + 87, `got ${geo.counts.building}`);
check('the out-of-bbox density cell was excluded',
  geo.counts.building < 999, `got ${geo.counts.building}`);
check('density merged into per-zone inventory',
  Object.values(geo.zoneInventory).some((row) => (row.building || 0) > 0),
  JSON.stringify(geo.zoneInventory));
check('density categories marked partial in provenance',
  geo.queries.filter((q) => q.key === 'building').every((q) => q.partial === true));

// Admin, without Nominatim
check('country code from ISO3166-1 on the level-2 polygon',
  geo.admin.countryCode === 'us', String(geo.admin.countryCode));
// The R-tree hands back Canada for this map because its BBOX contains it. Only a real
// geometry test rejects it; without one, 'Canada' < 'United States of America' wins.
check('a country whose bbox contains the map but whose geometry does not is rejected',
  geo.admin.countryCode !== 'ca',
  `countryCode=${geo.admin.countryCode} — the admin bbox superset was not filtered`);
check('the bbox-only country does not fake an international border',
  geo.admin.borderLevels[0] !== true,
  JSON.stringify(geo.admin.borderLevels));
check('admin.source is the new value', geo.admin.source === 'world',
  String(geo.admin.source));
check('first ordinal anchored on the ISO3166-2 level (4)',
  geo.admin.ordinals[1] === 4, JSON.stringify(geo.admin.ordinals));
check('place name from the zone census, not the bbox centre',
  geo.admin.placeName === 'Grand Rapids', String(geo.admin.placeName));
check('per-zone admin ladder populated',
  Object.keys(geo.admin.perZone).length === 3);

// ── Phase 0: the double-emit fix, exercised on build.py's REAL pipeline ──────
//
// `pitch` and `coastline` were not hand-written into the test world: make-test-world
// runs an OSM XML fixture through build.py's actual per-layer chain. Way 7101 is a
// CLOSED way — under the old all-types export it produced two records (its polygon
// plus the same ring as a zero-area linestring) and therefore two POIs at different
// coordinates. Exactly one must survive.
const pitchPois = geo.pois.pitch || [];
check('closed way exports exactly one record (geometry class)',
  pitchPois.filter((p) => p.osmId === 7101).length === 1,
  pitchPois.map((p) => `${p.osmType}/${p.osmId}`).join(','));
check('unclosed way carrying an area tag is dropped as a mapping error',
  !pitchPois.some((p) => p.osmId === 7102),
  pitchPois.map((p) => `${p.osmType}/${p.osmId}`).join(','));
check('pitch count is the deduplicated count', geo.counts.pitch === 2,
  `counts.pitch=${geo.counts.pitch}`);
// The mixed-layer case: coastline keeps `linestring` in its export (way 7104 is an
// open shore segment), so the closed island way 7103 double-emits and the streaming
// dedup pass — not the geometry class — must drop its linestring copy.
const coastPois = geo.pois.coastline || [];
check('closed way on a mixed layer exports exactly one record (dedup pass)',
  coastPois.filter((p) => p.osmId === 7103).length === 1,
  coastPois.map((p) => `${p.osmType}/${p.osmId}`).join(','));
check('open linestring on a mixed layer survives the dedup',
  coastPois.filter((p) => p.osmId === 7104).length === 1,
  coastPois.map((p) => `${p.osmType}/${p.osmId}`).join(','));
check('coastline count is the deduplicated count', geo.counts.coastline === 2,
  `counts.coastline=${geo.counts.coastline}`);
check('tumble_ground curse reads the deduplicated pitch count',
  geo.curseCounts.endless_tumble === 2, `endless_tumble=${geo.curseCounts.endless_tumble}`);

// ── Phase 1 R5: a built layer ships ONLY the runtime columns ─────────────────
//
// Asserted on the FlatGeobuf HEADER, exactly, rather than on the decoded properties —
// a build-only column that came back would be invisible in the POIs (nothing reads
// `leisure`) while costing bytes on every feature of every layer on the planet. The
// fixture tags `pitch` with `leisure` and `name`; `-select` must project `leisure`
// away and keep the identity pair. An == comparison, so a re-added column fails here.
{
  const reader = new FlatGeobufReader(`${baseUrl}/pitch.fgb`);
  const columns = (await reader.open()).columns.map((c) => c.name);
  check('a pipeline-built layer ships exactly the runtime columns it can',
    JSON.stringify(columns) === JSON.stringify(['osm_type', 'osm_id', 'name']),
    JSON.stringify(columns));
}

// ── Phase 1 R1: curse layers are bbox diagonals with no properties ───────────
//
// curse_cairn_terrain also went through the real pipeline (a closed natural=wood way
// plus a natural=beach node). What ships must be 2-point linestrings whose envelopes
// are BIT-IDENTICAL to the source features' — that is the whole safety argument for
// R1: worldCount walks the R-tree, and identical envelopes mean identical counts.
{
  const rect = { minX: bbox[1], minY: bbox[0], maxX: bbox[3], maxY: bbox[2] };
  const reader = new FlatGeobufReader(`${baseUrl}/curse_cairn_terrain.fgb`);
  const diagonals = await reader.query(rect);
  check('curse layer ships exactly one diagonal per feature (id dedup)',
    diagonals.length === 2, `got ${diagonals.length}`);
  check('diagonals are 2-point linestrings with no properties',
    diagonals.every((f) => f.lines.length === 1 && f.lines[0].length === 2
      && Object.keys(f.properties).length === 0),
    JSON.stringify(diagonals.map((f) => [f.lines, f.properties])));
  const got = diagonals.map((f) => JSON.stringify(f.lines[0])).sort();
  // The wood way's ring spans lon −85.6750..−85.6730, lat 42.9560..42.9580; the beach
  // node degenerates to a zero-length diagonal. Compared exactly, not approximately —
  // the envelope must be bit-identical or every R-tree bbox drifts.
  check('diagonal equals the source envelope exactly (closed way)',
    got.includes(JSON.stringify([[-85.675, 42.956], [-85.673, 42.958]])), got.join(' | '));
  check('a node diagonal degenerates to its own point',
    got.includes(JSON.stringify([[-85.671, 42.9565], [-85.671, 42.9565]])), got.join(' | '));
  check('cairn curse counted off the diagonals', geo.curseCounts.cairn === 2,
    `cairn=${geo.curseCounts.cairn}`);
}

// ── Phase 1 R2: curse_animal_habitat replaced by a partition identity ────────
check('curse_animal_habitat is no longer built',
  world.manifest.layers.curse_animal_habitat === undefined);
check('the R2 partition layers are built',
  world.manifest.layers.green_recreation_ground !== undefined
  && world.manifest.layers.animal_delta !== undefined,
  Object.keys(world.manifest.layers).join(','));
{
  // The identity, computed the way the client computes it: envelope counts. The true
  // habitat set over this bbox is {w101, w102, w801, w802, w201, w203} — six.
  const green = await worldCount(world, 'green', bbox);
  const recreation = await worldCount(world, 'green_recreation_ground', bbox);
  const delta = await worldCount(world, 'animal_delta', bbox);
  check('partition identity holds exactly over envelopes',
    green !== null && recreation !== null && delta !== null
    && green - recreation + delta === 6,
    `${green} - ${recreation} + ${delta}`);
}
check('animal-habitat curses answered through the identity',
  geo.curseCounts.zoologist === 6 && geo.curseCounts.bird_guide === 6,
  `zoologist=${geo.curseCounts.zoologist}, bird_guide=${geo.curseCounts.bird_guide}`);
check('the substitution is logged, not silent',
  logLines.some((l) => /animal_habitat.*counted as/.test(l)),
  logLines.filter((l) => /animal_habitat/.test(l)).join(' | ') || '(no habitat log line)');

// ── R2's other half: a world that STILL ships curse_animal_habitat ───────────
//
// Every world built before Phase 1 R2 carries the layer, and `curseLayerCount` reads it
// directly in that case — the identity arithmetic must not run at all, or an old build
// would be re-derived from layers it never contained. The variant world is the same
// directory with an aliased manifest: `curse_animal_habitat` pointing at
// `curse_cairn_terrain.fgb`, whose 2 features over this bbox are deliberately NOT the
// 6 the identity produces, so a direct read and a substituted read cannot be confused.
{
  const real = JSON.parse(await readFile(join(worldDir, 'manifest.json'), 'utf8'));
  overrides.set('manifest.json', Buffer.from(JSON.stringify({
    ...real,
    layers: {
      ...real.layers,
      curse_animal_habitat: { ...real.layers.curse_cairn_terrain },
    },
  })));
  const legacyLog = [];
  const legacy = await collectGeodata(
    await openWorld(baseUrl), {}, border, zones, proj, radiusM,
    { onProgress: () => {}, onLog: (level, message) => legacyLog.push(`${level}: ${message}`) },
  );
  overrides.delete('manifest.json');
  check('a manifest that still ships curse_animal_habitat is read directly',
    legacy.curseCounts.zoologist === 2 && legacy.curseCounts.bird_guide === 2,
    `zoologist=${legacy.curseCounts.zoologist}, bird_guide=${legacy.curseCounts.bird_guide}`);
  check('no partition arithmetic runs when the layer is present',
    !legacyLog.some((l) => /animal_habitat.*counted as/.test(l)),
    legacyLog.filter((l) => /animal_habitat/.test(l)).join(' | '));
  check('the rest of the run is unaffected by the legacy layer',
    legacy.available === true && (legacy.pois.park || []).length === 2);
}

// ── the R2 identity against merge.py's two manifest degradations ─────────────
//
// Three variants of the same world, differing only in what the manifest says about
// `green_recreation_ground` (the subtracted term, 1 feature over this bbox):
//
//   1. a PATH-LESS `{"features": 0}` entry — a real, present, EMPTY layer. worldCount
//      answers 0 directly, so the identity runs with a genuine zero: 3 − 0 + 4 = 7.
//      No absent-term logging, and no fetch of '<base>/undefined'.
//   2. the entry DELETED from a full manifest — build.py's "selector matched nothing"
//      omission. The absent-term-as-zero branch runs, logged: 3 − 0 + 4 = 7.
//   3. the entry deleted from a manifest marked `"partial": true` — a --only build,
//      where absence means NOT BUILT. Zeroing would fabricate a wrong total in the
//      direction that removes a curse, so the predicate must refuse instead.
{
  const real = JSON.parse(await readFile(join(worldDir, 'manifest.json'), 'utf8'));
  const run = async (mutate) => {
    const manifest = JSON.parse(JSON.stringify(real));
    mutate(manifest);
    overrides.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    const lines = [];
    const out = await collectGeodata(
      await openWorld(baseUrl), {}, border, zones, proj, radiusM,
      { onProgress: () => {}, onLog: (level, message) => lines.push(`${level}: ${message}`) },
    );
    overrides.delete('manifest.json');
    return { out, lines };
  };

  // 1. path-less empty term: a genuine 0 inside the expression.
  const empty = await run((m) => {
    m.layers.green_recreation_ground = { features: 0 };
  });
  check('a path-less term counts as a genuine 0 in the curse expression',
    empty.out.curseCounts.zoologist === 7 && empty.out.curseCounts.bird_guide === 7,
    `zoologist=${empty.out.curseCounts.zoologist}, bird_guide=${empty.out.curseCounts.bird_guide}`);
  check('a path-less term is not logged as absent-counted-as-0',
    !empty.lines.some((l) => /green_recreation_ground.*counted as 0/.test(l)),
    empty.lines.filter((l) => /green_recreation_ground/.test(l)).join(' | '));

  // 2. term omitted from a FULL manifest: absent-as-zero, with the info line.
  const omitted = await run((m) => {
    delete m.layers.green_recreation_ground;
  });
  check('a term absent from a full manifest is zeroed (empty-region omission)',
    omitted.out.curseCounts.zoologist === 7,
    `zoologist=${omitted.out.curseCounts.zoologist}`);
  check('the absent-as-zero substitution is logged',
    omitted.lines.some((l) => /green_recreation_ground.*counted as 0/.test(l)),
    omitted.lines.filter((l) => /green_recreation_ground/.test(l)).join(' | ') || '(no line)');

  // 3. the same omission on a PARTIAL manifest: refuse, never zero.
  const partial = await run((m) => {
    delete m.layers.green_recreation_ground;
    m.partial = true;
  });
  check('a term absent from a partial manifest refuses instead of zeroing',
    partial.out.curseCounts.zoologist === undefined
    && partial.out.curseCounts.bird_guide === undefined,
    `zoologist=${JSON.stringify(partial.out.curseCounts.zoologist)}`);
  check('the partial-manifest refusal is a warn naming the partial build',
    partial.lines.some((l) => /^warn: .*partial/i.test(l)),
    partial.lines.filter((l) => /green_recreation_ground|partial/i.test(l)).join(' | ')
      || '(no line)');
  check('the partial-manifest run is otherwise unaffected',
    partial.out.available === true && (partial.out.pois.park || []).length === 2);
}

// ── Phase 1 R4: zero-valued density counts are omitted per cell ──────────────
{
  const rect = { minX: bbox[1], minY: bbox[0], maxX: bbox[3], maxY: bbox[2] };
  const reader = new FlatGeobufReader(`${baseUrl}/density.fgb`);
  const cells = await reader.query(rect);
  const zeroCell = cells.find((f) => f.points.length
    && Math.abs(f.points[0][0] - (-85.673)) < 1e-9);
  check('a zero-valued density count is ABSENT from its cell, not 0',
    zeroCell !== undefined && !('bridge' in zeroCell.properties)
    && zeroCell.properties.building === 98,
    zeroCell ? JSON.stringify(zeroCell.properties) : '(cell not found)');
  check('map-wide sums unchanged by the omission (absent reads as 0)',
    geo.counts.bridge === 1 + 2, `counts.bridge=${geo.counts.bridge}`);
}

// An empty layer (a map with no consulates) is a real state the reader must survive.
check('an empty layer reads as zero features, not an error',
  geo.counts.foreign_consulate === 0
  && (geo.pois.foreign_consulate || []).length === 0,
  `counts.foreign_consulate=${geo.counts.foreign_consulate}`);

// ── merge.py's OTHER empty-layer shape: a path-less {"features": 0} entry ────
//
// A merged world lists a layer that is empty across every region as an entry with no
// `path` at all — present, real, and zero. `mountain` is that entry in this world.
// It must answer 0 / [] like the with-file shape above, must not degrade the category
// to unavailable, and above all must never be turned into a reader: the naive
// `baseUrl + '/' + info.path` is '<base>/undefined', and the throw from its first
// Range request used to abort the whole curse-predicate loop.
check('a path-less manifest entry answers count 0, not unavailable',
  geo.counts.mountain === 0, `counts.mountain=${JSON.stringify(geo.counts.mountain)}`);
check('a path-less manifest entry answers an empty POI list',
  Array.isArray(geo.pois.mountain) && geo.pois.mountain.length === 0,
  JSON.stringify(geo.pois.mountain));
check('a path-less entry is a genuine zero, not a degraded category',
  geo.queries.some((q) => q.key === 'mountain' && q.partial === false),
  JSON.stringify(geo.queries.find((q) => q.key === 'mountain')));
check('no "no world-file layer" warn for the path-less entry',
  !logLines.some((l) => /category mountain/.test(l)),
  logLines.filter((l) => /mountain/.test(l)).join(' | '));
check('worldCount answers 0 directly for a path-less entry',
  (await worldCount(world, 'mountain', bbox)) === 0);
check('the path-less entry gets an empty-layer provenance line, not undefined/NaN',
  geo.queries.some((q) => q.key === 'mountain' && /empty layer/.test(String(q.endpoint))
    && !/undefined|NaN/.test(String(q.endpoint))),
  String((geo.queries.find((q) => q.key === 'mountain') || {}).endpoint));
check('no request was ever made to <base>/undefined',
  undefinedRequests === 0, `${undefinedRequests} requests to /undefined`);

// Curse predicates
// curse_water is 'marked' water (3 features); the water CATEGORY is 'named' (2). On a
// real map they differ by 8:1, and conflating them has happened before.
check('curse water uses its OWN layer, not the water category',
  geo.curseCounts.water_weight === 3,
  `water_weight=${geo.curseCounts.water_weight}, counts.water=${geo.counts.water}`);
check('curse water differs from the named-water category count',
  geo.curseCounts.water_weight !== geo.counts.water);
check('curse from density grid', geo.curseCounts.jammed_door === geo.counts.building,
  `jammed_door=${geo.curseCounts.jammed_door}`);
check('distant cuisine counted from restaurant tags',
  geo.curseCounts.distant_cuisine === 2, `got ${geo.curseCounts.distant_cuisine}`);

// Cuisines and legal spots
check('cuisines derived', geo.cuisines && Object.keys(geo.cuisines).length === 2,
  JSON.stringify(geo.cuisines));
check('legal spots produced', geo.legalSpots && Object.keys(geo.legalSpots).length > 0);
check('every legal spot is verify-on-the-ground (path join removed)',
  Object.values(geo.legalSpots).flat().every((s) => s.verify === true));
check('private-access bench excluded from legal spots',
  !Object.values(geo.legalSpots).flat().some((s) => String(s.key || '').includes('402')),
  JSON.stringify(Object.values(geo.legalSpots).flat().map((s) => s.key)));

// Provenance
check('provenance rows carry world-file endpoints',
  geo.queries.length > 0 && geo.queries.every(
    (q) => q.cacheKey === '' && /planet snapshot|not built/.test(String(q.endpoint))),
  JSON.stringify(geo.queries.slice(0, 2)));
check('no nominatim provenance row',
  !geo.queries.some((q) => String(q.key).startsWith('nominatim')));
check('no legal-spot-path-filter row',
  !geo.queries.some((q) => q.key === 'legal-spot-path-filter'));

// It really did use Range requests
check('served over HTTP Range', rangeRequests > 0,
  `${rangeRequests} range requests, ${bytesServed} bytes`);
check('worldStatsLine reports real traffic', /range requests/.test(worldStatsLine(world)),
  worldStatsLine(world));

// ── second run: the density grid is unreachable ──────────────────────────────
//
// A failed density fetch must leave the six grid categories ABSENT, not zero. A zero
// propagates: curseCounts reads geo.counts directly, so Bridge Troll / Luxury Car /
// Right Turn would all come back "remove, count 0 — no bridges on the game map" off a
// network error, and the street question would flip from functional to dead.
suppressed.add('density.fgb');
let degraded;
try {
  degraded = await collectGeodata(
    await openWorld(baseUrl), {}, border, zones, proj, radiusM,
    { onProgress: () => {}, onLog: () => {} },
  );
} catch (err) {
  failures.push(`degraded run threw: ${err && err.message}`);
}
if (degraded) {
  check('a dead density grid still yields an available OSM layer', degraded.available === true);
  for (const key of ['building', 'street', 'car_street', 'footpath', 'bridge', 'tree']) {
    check(`${key} count is ABSENT, not a fabricated 0`,
      degraded.counts[key] === undefined,
      `counts.${key} = ${JSON.stringify(degraded.counts[key])}`);
  }
  check('feature categories still resolved with the density grid down',
    (degraded.pois.park || []).length === 2);
}
suppressed.delete('density.fgb');

// Across EVERY run above — including the path-less-entry variants — nothing may have
// asked the origin for '<base>/undefined'.
check('no run ever requested <base>/undefined',
  undefinedRequests === 0, `${undefinedRequests} requests to /undefined`);

server.close();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log('\n--- pipeline log ---');
  for (const l of logLines) console.log(`  ${l}`);
  process.exit(1);
}
console.log(`(${rangeRequests} range requests, ${bytesServed} bytes served)`);
