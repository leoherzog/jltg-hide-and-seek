/**
 * osm/worldfile.js — the world-file semantic layer.
 *
 * `./flatgeobuf.js` reads bytes; this turns them into the `Poi` records the rest of the
 * pipeline consumes, plus the transit-route, density and admin layers.
 *
 * WORKER SIDE ONLY — no DOM.
 *
 * Two things to keep in mind:
 *   1. The R-tree indexes bounding boxes, so `search` returns a SUPERSET. `worldPois`
 *      filters it by real geometry; `worldCount` does not and is an upper bound.
 *   2. The build ran once against a planet snapshot, so every count is as-of the
 *      manifest's `planet_timestamp`, which is why provenance rows cite it.
 */

import { cmpStr, num } from '../lib/core.js';
import {
  bboxContains, polygonArea, pointInRing, ringCentroid, representativePoint,
  polylineMidpoint,
} from '../lib/geo.js';
import { FlatGeobufReader } from './flatgeobuf.js';

/**
 * Where the world files live: a public, immutable R2 bucket whose CORS exposes
 * `content-range` so a browser can read a 206. Overridable for local testing.
 */
export const DEFAULT_WORLD_BASE_URL = 'https://map.jltg.herzog.tech/world';

/** Seconds before the manifest fetch is abandoned. See `RANGE_TIMEOUT_S`. */
export const MANIFEST_TIMEOUT_S = 20;

/**
 * The two identity columns the build writes (see `export_config` in
 * tools/osm-world/build.py). They must be PROPERTIES: a feature whose identity is not in
 * `properties` is dropped silently by `featuresToPois`.
 */
const TYPE_PROPERTY = 'osm_type';
const ID_PROPERTY = 'osm_id';

/** Property keys that are identity or bookkeeping, never OSM tags. */
const NON_TAG_PROPERTIES = Object.freeze([TYPE_PROPERTY, ID_PROPERTY]);

/** Python tuple comparison for `(osmType, osmId)` — string then NUMBER. */
function cmpTypeId(a, b) {
  return cmpStr(a.osmType, b.osmType) || (a.osmId - b.osmId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// The rulebook's "map icon" rule
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Project a geographic ring into planar metres.
 * @param {ReadonlyArray<[number, number]>} ring
 * @param {import('../lib/geo.js').Projection} proj
 * @returns {Array<[number, number]>}
 */
function planar(ring, proj) {
  return ring.map(([lat, lon]) => proj.xy(lat, lon));
}

/**
 * The rulebook's "map icon" rule, applied to bare geometry — specs/osm.md §3.2.
 *
 * Closed rings → area-weighted centroid over the outers minus the inners, with an
 * interior fallback when the centroid lands outside the shape. Open lines →
 * length-weighted midpoint. A lone point → itself. Never the bbox centre.
 *
 * This is the one implementation; every data path must place an icon on the same
 * coordinate. Every coordinate in and out is geographic `[lat, lon]`.
 *
 * @param {import('../lib/geo.js').Projection} proj
 * @param {ReadonlyArray<ReadonlyArray<[number, number]>>} outers
 * @param {ReadonlyArray<ReadonlyArray<[number, number]>>} inners
 * @param {ReadonlyArray<ReadonlyArray<[number, number]>>} lines
 * @param {ReadonlyArray<[number, number]>} points
 * @returns {[number, number]|null} `[lat, lon]`, or null when there is no geometry
 */
export function representativeFromGeometry(proj, outers, inners, lines, points) {
  if (outers.length) {
    const planarOuters = outers.map((r) => planar(r, proj));
    const planarInners = inners.map((r) => planar(r, proj));
    let accX = 0.0;
    let accY = 0.0;
    let accA = 0.0;
    for (const ring of planarOuters) {
      const area = polygonArea(ring);
      const [cx, cy] = ringCentroid(ring);
      accX += area * cx;
      accY += area * cy;
      accA += area;
    }
    for (const ring of planarInners) {
      const area = polygonArea(ring);
      const [cx, cy] = ringCentroid(ring);
      accX -= area * cx;
      accY -= area * cy;
      accA -= area;
    }
    // Python's `max(key=…)` keeps the FIRST maximum; `>` (not `>=`) does too.
    let biggest = planarOuters[0];
    let biggestArea = polygonArea(biggest);
    for (let i = 1; i < planarOuters.length; i++) {
      const a = polygonArea(planarOuters[i]);
      if (a > biggestArea) {
        biggest = planarOuters[i];
        biggestArea = a;
      }
    }
    let point;
    if (accA > 1e-9) {
      point = [accX / accA, accY / accA];
      if (!pointInRing(point, biggest)) point = representativePoint(biggest);
    } else {
      point = representativePoint(biggest);
    }
    const [lon, lat] = proj.lonlat(point[0], point[1]);
    return [lat, lon];
  }

  if (lines.length) {
    // A MultiLineString can have several parts; the longest is chosen so the answer
    // cannot depend on member order.
    let longest = lines[0];
    let longestLength = -1;
    for (const line of lines) {
      if (line.length < 2) continue;
      const flat = planar(line, proj);
      let length = 0.0;
      for (let i = 1; i < flat.length; i++) {
        length += Math.hypot(flat[i][0] - flat[i - 1][0], flat[i][1] - flat[i - 1][1]);
      }
      if (length > longestLength) {
        longestLength = length;
        longest = line;
      }
    }
    if (longest.length >= 2) {
      const [x, y] = polylineMidpoint(planar(longest, proj));
      const [lon, lat] = proj.lonlat(x, y);
      return [lat, lon];
    }
    if (longest.length === 1) return longest[0];
  }

  if (points.length === 1) return points[0];
  if (points.length) {
    const flat = points.map(([lat, lon]) => proj.xy(lat, lon));
    let sx = 0.0;
    let sy = 0.0;
    for (const p of flat) { sx += p[0]; sy += p[1]; }
    const [lon, lat] = proj.lonlat(sx / flat.length, sy / flat.length);
    return [lat, lon];
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Opening the world
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} World
 * @property {string} baseUrl
 * @property {Object} manifest
 * @property {Map<string, FlatGeobufReader>} readers
 * @property {function(): {requests: number, bytes: number}} stats
 */

/**
 * Fetch `manifest.json` and return a handle every other function here takes.
 *
 * The manifest is the availability contract: a layer absent from it was not built, and
 * `./geodata.js` degrades that category rather than throwing.
 *
 * @param {string} [baseUrl]
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<World>}
 */
export async function openWorld(baseUrl = DEFAULT_WORLD_BASE_URL, opts = {}) {
  const doFetch = opts.fetchImpl || ((...args) => fetch(...args));
  const base = String(baseUrl).replace(/\/+$/, '');

  // Same abort-based timeout the layer reads use; a stall here would hang the run.
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, MANIFEST_TIMEOUT_S * 1000);
  let response;
  try {
    response = await doFetch(`${base}/manifest.json`, { signal: controller.signal });
  } catch (exc) {
    if (exc && exc.name === 'AbortError') {
      throw new Error(
        `world files: ${base}/manifest.json did not answer within ${MANIFEST_TIMEOUT_S}s`,
      );
    }
    throw exc;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`world files: manifest.json returned ${response.status} from ${base}`);
  }
  const manifest = await response.json();
  if (!manifest || typeof manifest !== 'object' || !manifest.layers) {
    throw new Error('world files: manifest.json carried no `layers`');
  }

  /** @type {Map<string, FlatGeobufReader>} */
  const readers = new Map();
  return {
    baseUrl: base,
    manifest,
    readers,
    stats() {
      let requests = 0;
      let bytes = 0;
      for (const reader of readers.values()) {
        requests += reader.requestCount;
        bytes += reader.bytesFetched;
      }
      return { requests, bytes };
    },
  };
}

/** The manifest entry for a layer, or null when the build did not produce it. */
export function worldLayerInfo(world, key) {
  const entry = world.manifest.layers[key];
  return entry === undefined ? null : entry;
}

/**
 * Is this manifest entry a present-but-EMPTY layer — an entry with no `path`?
 *
 * `tools/osm-world/merge.py` writes `{"features": 0}` for a layer whose selector matched
 * nothing, so the manifest can say "exists, answer is zero" without shipping a file.
 * ABSENT (no entry) means the build did not produce the layer and the category degrades.
 * An empty layer answers 0 / [] and never gets a reader.
 */
function layerEmpty(info) {
  return info !== null && typeof info === 'object'
    && (info.path === undefined || info.path === null);
}

/**
 * A reader for one layer, or null when the layer is absent or empty (see `layerEmpty`).
 * Readers are memoised so a layer's header costs one request per run, not per query.
 */
export function worldReader(world, key, opts = {}) {
  const existing = world.readers.get(key);
  if (existing !== undefined) return existing;
  const info = worldLayerInfo(world, key);
  if (info === null || layerEmpty(info)) return null;
  const reader = new FlatGeobufReader(`${world.baseUrl}/${info.path}`, opts);
  world.readers.set(key, reader);
  return reader;
}

/** App bbox `[s, w, n, e]` → the FlatGeobuf query rect, which is (lon, lat). */
function rectOf(bbox) {
  const [s, w, n, e] = bbox;
  return { minX: w, minY: s, maxX: e, maxY: n };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Counting
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * How many features of `key` have a bounding box touching `bbox`.
 *
 * Walks the R-tree only; no feature bytes are read. UPPER BOUND, not a count: a feature
 * whose bbox clips the map while its geometry does not is included here and excluded by
 * `worldPois`. Use it to decide affordability; never publish it as a count.
 *
 * @returns {Promise<number|null>} null when the layer is not in the manifest;
 *   0 (a genuine zero) when the manifest lists it as a path-less empty layer
 */
export async function worldCount(world, key, bbox, opts = {}) {
  const info = worldLayerInfo(world, key);
  if (info === null) return null;
  if (layerEmpty(info)) return 0;
  const reader = worldReader(world, key, opts);
  if (reader === null) return null;
  const offsets = await reader.search(rectOf(bbox));
  return offsets.length;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Features → Poi
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * `{osm_type: 'way', osm_id: 1234}` → `['way', 1234]`. Also tolerates the prefixed
 * single-column form ("w1234") so an older build still reads.
 *
 * @returns {[string, number]|null}
 */
function osmIdentity(props) {
  const rawId = props[ID_PROPERTY];
  const rawType = props[TYPE_PROPERTY];

  if (rawType !== undefined && rawType !== null && rawId !== undefined && rawId !== null) {
    const kind = String(rawType);
    if (kind !== 'node' && kind !== 'way' && kind !== 'relation') return null;
    const id = Number.parseInt(String(rawId), 10);
    return Number.isFinite(id) ? [kind, id] : null;
  }

  const raw = String(rawId === undefined || rawId === null ? '' : rawId);
  const kind = { n: 'node', w: 'way', r: 'relation' }[raw[0]];
  if (kind === undefined) return null;
  const id = Number.parseInt(raw.slice(1), 10);
  return Number.isFinite(id) ? [kind, id] : null;
}

/**
 * Does a decoded feature genuinely intersect `bbox`?
 *
 * The R-tree answers with bounding boxes, so this narrows the superset back to the
 * truth. A vertex-only test drops a polygon larger than the map (no vertex inside), and
 * an extent-only test accepts any country whose bbox covers the map. So: a vertex inside
 * the rect, OR any segment crossing any rect edge, OR the rect centre inside a ring.
 *
 * Coordinates are (lon, lat), matching the decoder.
 */

/** Do segments p1→p2 and p3→p4 properly intersect or touch? Orientation test. */
function segmentsCross(p1, p2, p3, p4) {
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const onSeg = (o, a, b) => Math.min(o[0], b[0]) <= a[0] && a[0] <= Math.max(o[0], b[0])
    && Math.min(o[1], b[1]) <= a[1] && a[1] <= Math.max(o[1], b[1]);
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
    && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  // Collinear/touching cases — a feature grazing the border is inside the map.
  if (d1 === 0 && onSeg(p3, p1, p4)) return true;
  if (d2 === 0 && onSeg(p3, p2, p4)) return true;
  if (d3 === 0 && onSeg(p1, p3, p2)) return true;
  if (d4 === 0 && onSeg(p1, p4, p2)) return true;
  return false;
}

/** The four edges of the map rectangle, as (lon, lat) segment pairs. */
function rectEdges(bbox) {
  const [s, w, n, e] = bbox;
  const sw = [w, s];
  const se = [e, s];
  const ne = [e, n];
  const nw = [w, n];
  return [[sw, se], [se, ne], [ne, nw], [nw, sw]];
}

/** Does any segment of `run` cross the rectangle? `closed` walks the wrap-around edge. */
function runCrossesRect(run, edges, closed) {
  if (run.length < 2) return false;
  const last = closed ? run.length : run.length - 1;
  for (let i = 0; i < last; i++) {
    const a = run[i];
    const b = run[(i + 1) % run.length];
    for (const [c, d] of edges) {
      if (segmentsCross(a, b, c, d)) return true;
    }
  }
  return false;
}

function intersectsBbox(feature, bbox) {
  const [s, w, n, e] = bbox;

  // 1. any vertex inside the rectangle
  for (const [lon, lat] of feature.points) {
    if (bboxContains(bbox, lat, lon)) return true;
  }
  for (const line of feature.lines) {
    for (const [lon, lat] of line) if (bboxContains(bbox, lat, lon)) return true;
  }
  for (const polygon of feature.polygons) {
    for (const [lon, lat] of polygon.outer) if (bboxContains(bbox, lat, lon)) return true;
    // Inner rings too: a hole lying wholly inside the map crosses no edge, and stage 3
    // would then find the centre inside the hole and reject the whole feature.
    for (const ring of polygon.inners) {
      for (const [lon, lat] of ring) if (bboxContains(bbox, lat, lon)) return true;
    }
  }

  const edges = rectEdges(bbox);

  // 2. any edge crossing — catches a feature passing clean through the map
  for (const line of feature.lines) {
    if (runCrossesRect(line, edges, false)) return true;
  }
  for (const polygon of feature.polygons) {
    if (runCrossesRect(polygon.outer, edges, true)) return true;
    for (const ring of polygon.inners) {
      if (runCrossesRect(ring, edges, true)) return true;
    }
  }

  // 3. the map sits wholly inside the feature. With no vertex inside and no crossing
  //    edge, the rectangle is entirely in or out of every ring, so the centre suffices.
  const centre = [(w + e) / 2, (s + n) / 2];
  for (const polygon of feature.polygons) {
    if (!pointInRing(centre, polygon.outer)) continue;
    if (polygon.inners.some((ring) => pointInRing(centre, ring))) continue;
    return true;
  }
  return false;
}

/** `[lon, lat]` pairs → `[lat, lon]` pairs. Geographic order everywhere downstream. */
function toLatLon(run) {
  return run.map(([lon, lat]) => [lat, lon]);
}

/**
 * Decoded FlatGeobuf features → sorted, deduplicated `Poi` records.
 *
 * Applies `representativeFromGeometry`, the node-inside-same-category-area dedup, and
 * the `(osmType, osmId)` sort. The dedup is specs/osm.md §3.2 step 6 only: a NODE inside
 * an area of the same category is the same thing mapped twice and the area wins. It is
 * deliberately not extended to area-inside-area (pitches inside recreation grounds are
 * separate features).
 *
 * @param {Array<import('./flatgeobuf.js').FgbFeature>} features
 * @param {string} category
 * @param {import('../lib/geo.js').Projection} proj
 * @param {[number, number, number, number]} bbox
 * @param {{keepRings: boolean}} opts
 * @returns {Array<Object>} Poi records
 */
export function featuresToPois(features, category, proj, bbox, opts) {
  const keepRings = Boolean(opts && opts.keepRings);

  /** @type {Array<{poi: Object, rings: Array<Array<[number, number]>>, area: number}>} */
  const records = [];

  for (const feature of features) {
    // Narrow the R-tree's bbox superset to features that really reach the map.
    if (!intersectsBbox(feature, bbox)) continue;

    const identity = osmIdentity(feature.properties);
    if (identity === null) continue;
    const [osmType, osmId] = identity;

    // Geographic [lat, lon] from here down — project before any geometry call.
    const outers = feature.polygons.map((p) => toLatLon(p.outer));
    const inners = [];
    for (const polygon of feature.polygons) {
      for (const ring of polygon.inners) inners.push(toLatLon(ring));
    }
    const lines = feature.lines.map(toLatLon);
    const points = feature.points.map(([lon, lat]) => [lat, lon]);

    const point = representativeFromGeometry(proj, outers, inners, lines, points);
    if (point === null) continue;

    /** @type {Object<string, string>} */
    const tags = {};
    const keys = Object.keys(feature.properties)
      .filter((k) => !NON_TAG_PROPERTIES.includes(k))
      .sort(cmpStr);
    for (const k of keys) {
      const value = feature.properties[k];
      if (value === null || value === undefined) continue;
      tags[k] = String(value);
    }

    const planarOuters = outers.map((ring) => ring.map(([lat, lon]) => proj.xy(lat, lon)));
    let area = 0.0;
    for (const ring of planarOuters) area += polygonArea(ring);
    for (const ring of inners) {
      area -= polygonArea(ring.map(([lat, lon]) => proj.xy(lat, lon)));
    }

    const nameRaw = feature.properties.name;
    const poi = {
      category,
      osmType,
      osmId,
      name: String(nameRaw === undefined || nameRaw === null ? '' : nameRaw),
      lat: point[0],
      lon: point[1],
      tags,
      rings: keepRings ? outers : [],
    };
    records.push({ poi, rings: planarOuters, area: Math.max(0.0, area) });
  }

  records.sort((a, b) => cmpTypeId(a.poi, b.poi));

  // Bounding boxes of the area features, for the dedup's cheap reject.
  const areas = [];
  for (const rec of records) {
    if (!rec.rings.length) continue;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const ring of rec.rings) {
      for (const p of ring) {
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      }
    }
    areas.push({ poi: rec.poi, rings: rec.rings, area: rec.area, box: [x0, y0, x1, y1] });
  }

  const keep = [];
  for (const rec of records) {
    const poi = rec.poi;
    if (poi.osmType !== 'node') {
      keep.push(poi);
      continue;
    }
    const point = proj.xy(poi.lat, poi.lon);
    let swallowed = false;
    for (const other of areas) {
      if (other.poi.osmId === poi.osmId && other.poi.osmType === poi.osmType) continue;
      if (other.area <= rec.area) continue;
      const [x0, y0, x1, y1] = other.box;
      if (!(x0 <= point[0] && point[0] <= x1 && y0 <= point[1] && point[1] <= y1)) continue;
      if (other.rings.some((ring) => pointInRing(point, ring))) {
        swallowed = true;
        break;
      }
    }
    if (!swallowed) keep.push(poi);
  }
  return keep;
}

/**
 * Fetch one category from its world file and reduce it to `Poi` records. No tiling
 * fallback: the read is bounded by the index, so it succeeds or the origin is down.
 *
 * @param {World} world
 * @param {string} layerKey the world-file layer (usually the category key)
 * @param {string} category the category the `Poi` records are labelled with
 * @param {[number, number, number, number]} bbox
 * @param {import('../lib/geo.js').Projection} proj
 * @param {{keepRings?: boolean, fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<Array<Object>|null>} null when the layer is not in the manifest;
 *   `[]` when the manifest lists it as a path-less empty layer
 */
export async function worldPois(world, layerKey, category, bbox, proj, opts = {}) {
  const info = worldLayerInfo(world, layerKey);
  if (info === null) return null;
  if (layerEmpty(info)) return [];
  const reader = worldReader(world, layerKey, opts);
  if (reader === null) return null;
  const features = await reader.query(rectOf(bbox));
  return featuresToPois(features, category, proj, bbox, { keepRings: Boolean(opts.keepRings) });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Transit routes
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} TransitRouteStop
 * @property {number} nodeId OSM node id of the relation's `stop` member
 * @property {string|null} name
 * @property {string|null} nameEn `name:en` where the build carried it
 * @property {number} lat
 * @property {number} lon
 */

/**
 * @typedef {Object} TransitRoute
 * @property {number} osmId the route relation's OSM id
 * @property {{name: string|null, nameEn: string|null, ref: string|null,
 *   colour: string|null, operator: string|null, network: string|null,
 *   route: string|null, interval: string|null, duration: string|null}} tags
 * @property {Array<Array<[number, number]>>} lines the chained parts, `[lat, lon]`
 * @property {Array<TransitRouteStop>} stops in travel order
 */

/**
 * The nine tag columns `tools/osm-world/build-transit.py` promises for this layer, and
 * the key each lands under. Pinned by name because downstream reads them by name.
 */
const TRANSIT_ROUTE_TAG_COLUMNS = Object.freeze([
  Object.freeze(['name', 'name']),
  Object.freeze(['name_en', 'nameEn']),
  Object.freeze(['ref', 'ref']),
  Object.freeze(['colour', 'colour']),
  Object.freeze(['operator', 'operator']),
  Object.freeze(['network', 'network']),
  Object.freeze(['route', 'route']),
  Object.freeze(['interval', 'interval']),
  Object.freeze(['duration', 'duration']),
]);

/** The property carrying the ordered stop list, as JSON. See `parseTransitStops`. */
const STOPS_PROPERTY = 'stops';

/**
 * A decoded property → a tag string, or null when the build carried nothing there.
 * The empty string collapses to null on purpose: `ref=""` is not a route number.
 */
function tagOrNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text === '' ? null : text;
}

/**
 * The `stops` column: a JSON array of `[nodeId, name, nameEn, lat, lon]` rows in TRAVEL
 * ORDER, which the build recovered by projecting each stop onto the chained line
 * (OSM member order is not a sequence). JSON because a FlatGeobuf column is a scalar.
 *
 * @returns {Array<TransitRouteStop>|null} null when the column is missing or will not
 *   parse; the caller then drops the whole feature rather than report a route with no stops.
 */
function parseTransitStops(raw) {
  if (raw === undefined || raw === null) return null;
  let rows;
  try {
    rows = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;

  /** @type {Array<TransitRouteStop>} */
  const stops = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [rawId, rawName, rawNameEn, rawLat, rawLon] = row;
    const nodeId = Number.parseInt(String(rawId), 10);
    const lat = Number(rawLat);
    const lon = Number(rawLon);
    // A stop the reader cannot place is skipped and the rest of the line kept.
    if (!Number.isFinite(nodeId) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    stops.push({
      nodeId,
      name: tagOrNull(rawName),
      nameEn: tagOrNull(rawNameEn),
      lat,
      lon,
    });
  }
  return stops;
}

/**
 * Read the `transit_route` layer — assembled route relations, with their stop lists.
 *
 * The one read here that does not end in a `Poi`: a `Poi` has no field for linework or
 * an ordered stop list, so route records go around `featuresToPois`. The only consumer
 * is the OSM fallback converter, which is why `transit_route` is not a `GEO_CATEGORIES`
 * member and `collectGeodata` never touches it.
 *
 * `null` (layer not built) tells the caller to refuse the source; `[]` (layer shipped,
 * nothing on this map) does not. Neither is a publishable count of zero.
 *
 * @param {World} world
 * @param {[number, number, number, number]} bbox
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<Array<TransitRoute>|null>} null when the layer is not in the
 *   manifest; `[]` when the manifest lists it as a path-less empty layer
 */
export async function worldTransitRoutes(world, bbox, opts = {}) {
  const info = worldLayerInfo(world, 'transit_route');
  if (info === null) return null;
  if (layerEmpty(info)) return [];
  const reader = worldReader(world, 'transit_route', opts);
  if (reader === null) return null;
  const features = await reader.query(rectOf(bbox));

  /** @type {Array<TransitRoute>} */
  const routes = [];
  for (const feature of features) {
    // A commuter line's bbox covers every town between its termini; narrow it down.
    if (!intersectsBbox(feature, bbox)) continue;

    const identity = osmIdentity(feature.properties);
    if (identity === null) continue;

    const stops = parseTransitStops(feature.properties[STOPS_PROPERTY]);
    if (stops === null) continue;

    /** @type {Object<string, string|null>} */
    const tags = {};
    for (const [column, key] of TRANSIT_ROUTE_TAG_COLUMNS) {
      tags[key] = tagOrNull(feature.properties[column]);
    }

    routes.push({
      osmId: identity[1],
      tags,
      // MultiLineString parts in geographic order. More than one part means the
      // relation's ways do not form a single connected run; that is a real property.
      lines: feature.lines.map(toLatLon),
      stops,
    });
  }
  // One feature per relation, so the relation id alone is a total order.
  routes.sort((a, b) => a.osmId - b.osmId);
  return routes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// The density grid
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Read the sparse density grid over `bbox`: a FlatGeobuf of points, one per populated
 * cell, with an integer column per count-only category.
 *
 * Returns map-wide totals and the raw cells. The totals are EXACT (each feature lands in
 * one cell). Zone attribution of cells in `./geodata.js` is approximate: a cell is wholly
 * in or out of a zone by its centre. See `_density_comment` in tools/osm-world/categories.json.
 *
 * @returns {Promise<{counts: Object<string, number>,
 *                    cells: Array<{lat: number, lon: number, counts: Object<string, number>}>,
 *                    cellDeg: number}|null>}
 */
export async function worldDensity(world, bbox, opts = {}) {
  const info = worldLayerInfo(world, 'density');
  if (info === null) return null;
  if (layerEmpty(info)) {
    // A present-but-empty grid: every tally is a real zero, not a missing read.
    return { counts: {}, cells: [], cellDeg: Number(world.manifest.cell_deg) || 0.002 };
  }
  const reader = worldReader(world, 'density', opts);
  if (reader === null) return null;
  const features = await reader.query(rectOf(bbox));

  /** @type {Object<string, number>} */
  const counts = {};
  const cells = [];
  for (const feature of features) {
    const point = feature.points[0];
    if (point === undefined) continue;
    const [lon, lat] = point;
    // A cell centre outside the bbox belongs to a neighbouring map, not this one.
    if (!bboxContains(bbox, lat, lon)) continue;
    /** @type {Object<string, number>} */
    const cellCounts = {};
    for (const key of Object.keys(feature.properties).sort(cmpStr)) {
      const value = Number(feature.properties[key]);
      if (!Number.isFinite(value) || value === 0) continue;
      cellCounts[key] = value;
      counts[key] = (counts[key] || 0) + value;
    }
    cells.push({ lat, lon, counts: cellCounts });
  }
  return { counts, cells, cellDeg: Number(world.manifest.cell_deg) || 0.002 };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Administrative areas
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} AdminArea
 * @property {number} level OSM `admin_level`, 2–10
 * @property {string} name
 * @property {string|null} nameEn `name:en` where the build carries it; the ladder prefers it
 * @property {string|null} iso1 ISO3166-1 — present on level 2, the country-code fallback
 * @property {string|null} iso2 ISO3166-2
 * @property {Array<Array<[number, number]>>} rings outer rings, `[lat, lon]`
 */

/**
 * Every administrative area overlapping `bbox`, rings retained. Fetched once per map;
 * every zone centre is then tested locally via `adminAreasAt`.
 *
 * @returns {Promise<Array<AdminArea>|null>} null when the layer is not in the manifest
 */
export async function worldAdminAreas(world, bbox, opts = {}) {
  const info = worldLayerInfo(world, 'admin');
  if (info === null) return null;
  if (layerEmpty(info)) return [];
  const reader = worldReader(world, 'admin', opts);
  if (reader === null) return null;
  const features = await reader.query(rectOf(bbox));

  /** @type {Array<AdminArea>} */
  const areas = [];
  for (const feature of features) {
    if (!feature.polygons.length) continue;
    // The bbox superset MUST be filtered here: Canada's bbox contains Grand Rapids, and
    // `adminInfo` takes the first ISO3166-1 area in (level, name) order, so an
    // unfiltered list silently gives a Michigan map `countryCode: 'ca'`.
    if (!intersectsBbox(feature, bbox)) continue;
    const props = feature.properties;
    const level = Number.parseInt(String(props.admin_level), 10);
    if (!Number.isFinite(level)) continue;
    const iso1 = props['ISO3166-1'] || props['ISO3166-1:alpha2'] || null;
    const nameEn = props['name:en'];
    areas.push({
      level,
      name: String(props.name === undefined || props.name === null ? '' : props.name),
      nameEn: nameEn === undefined || nameEn === null || nameEn === '' ? null : String(nameEn),
      iso1: iso1 === null ? null : String(iso1),
      iso2: props['ISO3166-2'] === undefined ? null : String(props['ISO3166-2']),
      rings: feature.polygons.map((p) => toLatLon(p.outer)),
      // OSM maps enclaves (the Vatican inside Italy, cities inside US townships) as
      // `inner` rings, so containment must subtract them.
      holes: feature.polygons.flatMap((p) => p.inners.map(toLatLon)),
    });
  }
  // Smallest level number is the largest area; sorting makes the ladder walk stable.
  areas.sort((a, b) => a.level - b.level || cmpStr(a.name, b.name));
  return areas;
}

/**
 * The administrative areas containing one point, outermost first.
 *
 * Point-in-ring on raw degrees: ray casting is topological and unit-agnostic, and this
 * avoids reprojecting a whole-country ring per zone. It is wrong for a ring crossing the
 * antimeridian (Russia, Fiji); a map straddling ±180° would need this projected.
 *
 * @param {Array<AdminArea>} areas @param {number} lat @param {number} lon
 * @returns {Array<AdminArea>} outermost (lowest `admin_level`) first
 */
export function adminAreasAt(areas, lat, lon) {
  const point = [lon, lat];
  const hits = [];
  for (const area of areas) {
    // `rings` and `holes` are [lat, lon]; flip so ring and point agree. This allocates
    // per vertex per zone; if it shows in a profile, flip once in `worldAdminAreas`.
    const flip = (ring) => ring.map(([ringLat, ringLon]) => [ringLon, ringLat]);
    if (!area.rings.some((ring) => pointInRing(point, flip(ring)))) continue;
    // An enclave is inside its neighbour's outer ring AND inside one of its holes.
    if ((area.holes || []).some((hole) => pointInRing(point, flip(hole)))) continue;
    hits.push(area);
  }
  return hits;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Provenance
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The provenance line a world-file-backed count carries: which file, which planet
 * snapshot, and how big it is.
 */
export function worldProvenance(world, key) {
  const info = worldLayerInfo(world, key);
  const stamp = world.manifest.planet_timestamp || 'unknown';
  if (info === null) return `world file ${key}: not built (planet ${stamp})`;
  if (layerEmpty(info)) {
    // An empty layer has no file, bytes or sha256 to cite; only the snapshot.
    return `world file ${key}: empty layer, no file shipped `
      + `(planet snapshot ${stamp})`;
  }
  return `${world.baseUrl}/${info.path} — ${num(info.features)} features, `
    + `${num(Math.round(info.bytes / 1e6))} MB, planet snapshot ${stamp}, `
    + `sha256 ${String(info.sha256).slice(0, 16)}`;
}

/** A one-line summary of what the run actually cost, for the log. */
export function worldStatsLine(world) {
  const { requests, bytes } = world.stats();
  return `world files: ${num(requests)} range requests, `
    + `${num(Math.round(bytes / 1024))} kB read`;
}
