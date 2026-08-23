/**
 * osm/worldfile.js — the world-file semantic layer.
 *
 * This is to `./flatgeobuf.js` what `./geodata.js` is to `./overpass.js`: the file that
 * knows what a park is. `./flatgeobuf.js` reads bytes; this turns them into the `Poi`
 * records the rest of the pipeline already consumes, so `./geodata.js` downstream of
 * the fetch does not know or care which transport produced them.
 *
 * WORKER SIDE ONLY — no DOM.
 *
 * ── What replaced what ───────────────────────────────────────────────────────
 *
 *   Overpass, before                        world files, now
 *   ─────────────────────────────────────   ──────────────────────────────────
 *   one bbox query per category group       one Range-request query per category
 *   `out count;` audit in one request       index-only count, no feature bytes read
 *   ≤0.1° tiling when a fetch is too big    never — the index bounds the read
 *   mirror failover, 3 s courtesy sleeps    one immutable origin, no rate limit
 *   `is_in` for admin containment           the `admin` polygon layer
 *   `out center qt` building density        the `density` grid layer
 *
 * The count audit is the interesting one. `overpassCounts` existed because asking
 * Overpass for a count was enormously cheaper than asking it for features, so the
 * pipeline spent a whole request learning what it could afford to fetch. The same
 * asymmetry exists here for a better reason: a count is answered by walking the R-tree
 * alone, reading tens of kilobytes of index and not one feature byte. See `worldCount`.
 *
 * ── The two ways this can silently disagree with Overpass ────────────────────
 *
 *   1. The R-tree indexes bounding boxes, so `search` returns a SUPERSET: a diagonal
 *      river whose bbox clips the map corner comes back even when the river does not
 *      enter the map. `worldPois` filters that superset down by real geometry, so a
 *      category's features and its count agree. `worldCount` does NOT — it is the cheap
 *      pre-check, it is an upper bound, and it is only ever used to decide whether a
 *      category is too big to fetch.
 *
 *   2. The build applies its predicate ONCE, offline, against a planet snapshot. An
 *      Overpass run reflects OSM as of minutes ago. Every count is therefore as-of the
 *      manifest's `planet_timestamp`, which is why that field exists and why it reaches
 *      the provenance rows rather than being replaced with the wall clock.
 */

import { num } from '../lib/core.js';
import {
  bboxContains, polygonArea, pointInRing, ringCentroid, representativePoint,
  polylineMidpoint,
} from '../lib/geo.js';
import { FlatGeobufReader } from './flatgeobuf.js';

/**
 * Where the world files live. An R2 bucket served from a custom domain — public,
 * immutable, `Cache-Control: max-age=31536000`, and CORS-configured to expose
 * `content-range` so a browser can actually read a 206. `tools/osm-world/build.py`
 * writes the matching CORS document next to itself.
 *
 * Overridable so a build can be tested from a local static server before publishing.
 */
export const DEFAULT_WORLD_BASE_URL = 'https://jltg.herzog.tech/world';

/** Seconds before the manifest fetch is abandoned. See `RANGE_TIMEOUT_S`. */
export const MANIFEST_TIMEOUT_S = 20;

/**
 * The two identity columns `osmium export -c` is configured to write, via the config's
 * `attributes: {type: 'osm_type', id: 'osm_id'}`. They must be PROPERTIES, not the
 * GeoJSON Feature-level `id` member that `--add-unique-id` alone would produce — a
 * feature whose identity is not in `properties` is dropped silently by `featuresToPois`.
 * See `export_config` in tools/osm-world/build.py.
 */
const TYPE_PROPERTY = 'osm_type';
const ID_PROPERTY = 'osm_id';

/** Property keys that are identity or bookkeeping, never OSM tags. */
const NON_TAG_PROPERTIES = Object.freeze([TYPE_PROPERTY, ID_PROPERTY]);

/** Code-point-ordered string comparison. Never `localeCompare`. */
function cmpStr(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

/** Python tuple comparison for `(osmType, osmId)` — string then NUMBER. */
function cmpTypeId(a, b) {
  return cmpStr(a.osmType, b.osmType) || (a.osmId - b.osmId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// The rulebook's "map icon" rule
// ═══════════════════════════════════════════════════════════════════════════════
//
// Moved here from `./overpass.js` when that file was deleted. It was the last live
// thing in it: the Overpass transport and `parseOverpass` both became unreachable when
// the pipeline switched to world files, and keeping a whole module alive for one
// function was worse than moving the function.
//
// It lives next to `featuresToPois` on purpose — that is its only caller, and the two
// together are what decide where a park's icon sits.

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
 * Closed rings → area-weighted shoelace centroid over the outers, minus the inners,
 * with an interior fallback when the centroid lands outside the shape (a crescent-
 * shaped park's centroid is not in the park). Open lines → length-weighted midpoint.
 * A lone point → itself. Never `out center`, which is the bbox centre and diverges by
 * a measured p90 of 88 m on real park polygons.
 *
 * This is what the rulebook measures distance to: for a large park the relevant point
 * is the label in the middle, which can be a mile from where a player is standing
 * inside it.
 *
 * THIS IS THE ONE IMPLEMENTATION. `representativeLatlon` reaches it from an Overpass
 * element and `osm/worldfile.js` reaches it from a decoded FlatGeobuf feature. The two
 * data paths must place a park's icon on the same coordinate or the world-file
 * migration silently moves every measured distance, so they share this function rather
 * than each having their own copy of the rule.
 *
 * Every coordinate in and out is geographic `[lat, lon]`.
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
    // An Overpass way has exactly one line, so this loop is a no-op on that path. A
    // FlatGeobuf MultiLineString can have several (a river split into segments), and
    // the longest is chosen so the answer cannot depend on member order.
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
 * The manifest is the availability contract: a layer absent from it is a layer the
 * build did not produce, and `./geodata.js` degrades that category rather than throwing
 * — same first-class degradation path Overpass had, for the same reason. It is served
 * with a short max-age while the `.fgb` files are immutable, so publishing a new build
 * flips every layer atomically as far as a client is concerned.
 *
 * @param {string} [baseUrl]
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<World>}
 */
export async function openWorld(baseUrl = DEFAULT_WORLD_BASE_URL, opts = {}) {
  const doFetch = opts.fetchImpl || ((...args) => fetch(...args));
  const base = String(baseUrl).replace(/\/+$/, '');

  // Same abort-based timeout the layer reads use. This one matters more, not less: it
  // is the first request of the run, and a stall here means the page never gets as far
  // as reporting which layer was the problem.
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
 * `tools/osm-world/merge.py` writes `{"features": 0}` for a layer whose selector
 * matched nothing anywhere in the merged region, so the manifest can say "this layer
 * exists and its answer is zero" without shipping a zero-feature file. That is a
 * different statement from ABSENT (no entry at all), which means the build did not
 * produce the layer and the category degrades to unavailable.
 *
 * An empty layer answers 0 / [] and never gets a reader: there is no file to read,
 * and building `new FlatGeobufReader(base + '/undefined')` would throw on its first
 * Range request — aborting, for one path-less curse term, the entire curse-predicate
 * loop that was otherwise answerable.
 */
function layerEmpty(info) {
  return info !== null && typeof info === 'object'
    && (info.path === undefined || info.path === null);
}

/**
 * A reader for one layer, or null when there is nothing to read: the layer is not in
 * the manifest, or its entry is path-less (a present-but-empty layer — see
 * `layerEmpty`; the query functions answer those as 0 / [] without ever getting here).
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
 * Walks the R-tree and stops — no feature bytes are read at all, which is what makes
 * this cheap enough to run over every category before deciding what to fetch. It is the
 * direct replacement for the one-request `out count;` audit.
 *
 * UPPER BOUND, not a count. The index stores bounding boxes, so a feature whose bbox
 * clips the map while its geometry does not is included here and excluded by
 * `worldPois`. Use it to decide affordability; never publish it as a count.
 *
 * @returns {Promise<number|null>} null when the layer is not in the manifest;
 *   0 — a genuine, trustworthy zero — when the manifest lists it as a path-less
 *   empty layer
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
 * `{osm_type: 'way', osm_id: 1234}` → `['way', 1234]`. The build writes both columns;
 * nothing downstream can reconstruct OSM identity without them.
 *
 * Tolerates the prefixed single-column form ("w1234") too, so a world file built before
 * the two-column config still reads rather than silently yielding zero features — which
 * is exactly the failure this shape exists to make impossible.
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
 * THE R-TREE ANSWERS WITH BOUNDING BOXES, so `search` returns a superset and this is
 * what narrows it back to the truth. Both halves of that narrowing were wrong before:
 *
 *   - A vertex-only test DROPS a feature that crosses the map without a vertex inside
 *     it. Measured against live Overpass, that is 2-3% of canals on small Flevoland
 *     maps and — far worse — `landuse=forest` polygons covering 52-71% of a Tomsk map,
 *     because a polygon larger than the map rarely has a vertex in it. The published
 *     count then silently disagrees with `worldCount` computed in the same run.
 *
 *   - An extent-based "does it swallow the map" test ACCEPTS a feature that merely has
 *     a large bounding box. Canada is one relation whose bbox spans lat 41.7-83.1 and
 *     contains Grand Rapids; every country is one such relation. That is how a Michigan
 *     map came back with `countryCode: 'ca'`.
 *
 * So: a vertex inside the rect, OR a rect corner inside a ring (the feature swallows
 * the map), OR any segment crossing any rect edge. Rings are closed implicitly, and
 * open lines are walked as segments — a line and a ring differ only in that.
 *
 * Coordinates in and out are (lon, lat), matching the decoder.
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
    // Inner rings too, or stage 3's invariant is false: a hole lying WHOLLY inside the
    // map has no vertex outside to make it cross an edge, so stage 2 cannot see it, and
    // stage 3 then finds the centre inside the hole and rejects the whole feature. That
    // is the silent count/feature disagreement this file exists to prevent — observed on
    // `green` relation 7911045, where worldCount said 1 and worldPois said 0.
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

  // 3. the map sits wholly inside the feature — a lake bigger than the game, a country.
  //    Testing the centre is enough: with no vertex inside and no crossing edge, the
  //    rectangle is entirely in or entirely out of every ring.
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
 * The exact analogue of `parseOverpass`, and deliberately so: it applies the same
 * representative-point rule (through the shared `representativeFromGeometry`), the same
 * node-inside-same-category-area dedup, and the same `(osmType, osmId)` sort. A `Poi`
 * from here and a `Poi` from Overpass are indistinguishable to everything downstream,
 * which is the property that makes the migration safe to reason about.
 *
 * The dedup implements specs/osm.md §3.2 step 6 and only that: a NODE inside an area
 * feature of the same category is the same real-world thing mapped twice (a museum node
 * inside the museum building) and the area wins. It is deliberately not extended to
 * area-inside-area — measured on the reference bbox that would delete 25 pitches that
 * sit inside recreation grounds, which are genuinely separate features a player can
 * stand on.
 *
 * @param {Array<import('./flatgeobuf.js').FgbFeature>} features
 * @param {string} category
 * @param {import('../lib/geo.js').Projection} proj
 * @param {[number, number, number, number]} bbox
 * @param {{keepRings: boolean, keepTags?: boolean}} opts
 * @returns {Array<Object>} Poi records
 */
export function featuresToPois(features, category, proj, bbox, opts) {
  const keepRings = Boolean(opts && opts.keepRings);
  const keepTags = !opts || opts.keepTags === undefined ? true : Boolean(opts.keepTags);

  /** @type {Array<{poi: Object, rings: Array<Array<[number, number]>>, area: number}>} */
  const records = [];

  for (const feature of features) {
    // The R-tree answered with bounding boxes; this is where the superset is filtered
    // back down to features that really do reach the map.
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
    if (keepTags) {
      const keys = Object.keys(feature.properties)
        .filter((k) => !NON_TAG_PROPERTIES.includes(k))
        .sort(cmpStr);
      for (const k of keys) {
        const value = feature.properties[k];
        if (value === null || value === undefined) continue;
        tags[k] = String(value);
      }
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
 * Fetch one category from its world file and reduce it to `Poi` records.
 *
 * The direct replacement for `fetchCategory`. There is no tiling fallback and no
 * per-tile degradation because there is nothing to degrade: the read is bounded by the
 * index rather than by a server's patience, so it either succeeds or the origin is
 * down.
 *
 * @param {World} world
 * @param {string} layerKey the world-file layer (usually the category key)
 * @param {string} category the category the `Poi` records are labelled with
 * @param {[number, number, number, number]} bbox
 * @param {import('../lib/geo.js').Projection} proj
 * @param {{keepRings?: boolean, keepTags?: boolean, fetchImpl?: typeof fetch}} [opts]
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
  return featuresToPois(features, category, proj, bbox, {
    keepRings: Boolean(opts.keepRings),
    keepTags: opts.keepTags === undefined ? true : Boolean(opts.keepTags),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// The density grid
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Read the sparse density grid over `bbox`.
 *
 * Replaces both `out center qt` for buildings and the four count-only categories
 * (bridge, car_street, footpath, street). The grid is a FlatGeobuf of points — one per
 * populated cell, with an integer column per category — so it is read with exactly the
 * same index walk as everything else.
 *
 * Returns map-wide totals and the raw cells. The totals are EXACT: the build attributes
 * each feature to exactly one cell, so summing cells cannot double-count. The cells are
 * what `./geodata.js` attributes to zones, and that attribution is approximate — a cell
 * lands wholly inside or wholly outside a zone circle depending on where its centre
 * falls. See `_density_comment` in tools/osm-world/categories.json.
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
 * @property {string|null} nameEn `name:en` where the build carries it — the ladder
 *   prefers it, so Switzerland renders as "Switzerland" and not the four-language
 *   `name` string
 * @property {string|null} iso1 ISO3166-1 — present on level 2, the country-code fallback
 * @property {string|null} iso2 ISO3166-2
 * @property {Array<Array<[number, number]>>} rings outer rings, `[lat, lon]`
 */

/**
 * Every administrative area overlapping `bbox`, outer rings retained.
 *
 * Replaces the batched Overpass `is_in` — which cost one request per 150 zone centres
 * and could not be cached usefully, since the batch key changed with the zone set. Here
 * the areas are fetched once for the map and every zone centre is tested against them
 * locally, so zone count stops mattering entirely.
 *
 * Rings are always kept: containment is the whole question this layer answers, and a
 * representative point cannot answer it.
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
    // THE R-TREE ANSWERS WITH BOUNDING BOXES, AND FOR THIS LAYER THAT IS DANGEROUS.
    // `featuresToPois` filters the superset down; this function used to skip that step,
    // and administrative geometry is exactly where it bites hardest. A country is one
    // relation with one bbox: Canada's spans roughly lat 41.7–83.1, lon −141..−52,
    // which contains Grand Rapids, Michigan. `adminInfo` takes the first area carrying
    // ISO3166-1 in (level, name) order, and 'Canada' sorts before 'United States of
    // America' — so an unfiltered superset silently renders the whole page in
    // kilometres, changes the Unguided Tourist decision, drops the wrong country's
    // restaurants from Distant Cuisine, and reports an international border on a map
    // 250 km from one.
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
      // Holes are load-bearing here and were being discarded. OSM maps enclaves as
      // `inner` rings — San Marino and the Vatican inside Italy, Lesotho inside South
      // Africa, incorporated cities inside US townships — so a zone centre in the
      // Vatican falls in Italy's outer ring and inside its hole. Kept so containment
      // can subtract them.
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
 * The local analogue of one `is_in` result. A point-in-ring test against every outer
 * ring, which is correct for administrative boundaries because they do not have holes
 * a zone centre could fall into — an enclave is mapped as its own area at its own level,
 * not as a hole in its neighbour.
 *
 * The test runs on raw degrees rather than projected metres. Ray casting is a purely
 * topological test and does not care about the units, as long as both the point and the
 * ring are in the same ones — and skipping the projection keeps a whole-country ring
 * from being reprojected on every zone. The exception is a boundary crossing the
 * antimeridian, where a ring's longitudes wrap and the test is wrong; Russia and Fiji
 * are the real cases. A game map that straddles ±180° would need this projected.
 *
 * @param {Array<AdminArea>} areas @param {number} lat @param {number} lon
 * @returns {Array<AdminArea>} outermost (lowest `admin_level`) first
 */
export function adminAreasAt(areas, lat, lon) {
  const point = [lon, lat];
  const hits = [];
  for (const area of areas) {
    // `rings` and `holes` are [lat, lon]; flip so ring and point agree. Flipped here
    // rather than stored flipped only because every other consumer wants [lat, lon];
    // if this ever shows up in a profile, flip once in `worldAdminAreas` instead —
    // this allocates per vertex per zone.
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
 * The provenance line a world-file-backed count carries, in place of an Overpass URL.
 *
 * A player could re-run an Overpass query from the selector printed on the page. They
 * cannot re-run this one by hand, so the row says what it actually is: which file,
 * which planet snapshot, and how many bytes the browser read to answer it. Printing the
 * old Overpass selector next to a world-file count would be a lie about where the number
 * came from.
 */
export function worldProvenance(world, key) {
  const info = worldLayerInfo(world, key);
  const stamp = world.manifest.planet_timestamp || 'unknown';
  if (info === null) return `world file ${key}: not built (planet ${stamp})`;
  if (layerEmpty(info)) {
    // A path-less entry: the layer exists and is empty, so there is no file, no
    // bytes and no sha256 to cite — only the snapshot the zero is as-of.
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
