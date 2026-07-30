// web/osm/overpass.js — the Overpass + Nominatim transport layer.
// Port of generate.py S2 lines 4862–5487 (`_ov_bbox` … `_is_in_areas`).
//
// Worker-side module: no DOM. Every network round-trip goes through
// `httpFetch` from ../lib/http.js, which owns the mirror failover, the retries
// and the courtesy sleeps; nothing here calls `fetch` directly.
//
// Etiquette is a hard requirement, not a nicety (generate.py line 4455): ONE
// bbox-wide query per category, never one per stop. 1,493 stops × 16 categories
// would be 24,000 requests and a ban. The whole reference dataset was six
// Overpass calls and one Nominatim call.
//
// Overpass bbox order is (S, W, N, E) — the opposite of GeoJSON.

import {
  polygonArea,
  ringCentroid,
  pointInRing,
  representativePoint,
  polylineMidpoint,
} from '../lib/geo.js';
import { num } from '../lib/core.js';
import {
  httpFetch,
  OVERPASS_ENDPOINTS,
  NOMINATIM_ENDPOINT,
  OVERPASS_COURTESY_SLEEP_S,
  NOMINATIM_COURTESY_SLEEP_S,
} from '../lib/http.js';
import { cacheKey16 } from '../lib/cache.js';
// One constant, three consumers (Right Turn, Luxury Car, street density) — so
// they can never disagree about what a street is. It lives in geodata.js per
// CONTRACT.md §(a); the resulting import cycle is safe because the binding is
// only ever read inside a function body, never at module-evaluation time.
import { CAR_STREET_SELECTOR } from './geodata.js';

// ── tuning constants (S2-local, generate.py lines 4691–4694) ─────────────────

export const OVERPASS_QL_TIMEOUT_S = 300;  // the [timeout:N] header inside the QL itself
export const OVERPASS_TILE_DEG = 0.1;      // ≤0.1° squares when a single-shot fetch fails
export const IS_IN_BATCH = 150;            // zone centres per batched is_in request

// generate.py lines 4730 and 4735. Defined here rather than in geodata.js
// because the fetch path is the only thing that reads them, and one definition
// beats two that can drift. Both are frozen sorted arrays, not Sets, so they
// are clone-safe; use `.includes()`.
export const GEO_DENSITY_ONLY = Object.freeze(['building']);
export const RING_CATEGORIES = Object.freeze(['commercial_airport', 'park', 'water']);

// ── small helpers ────────────────────────────────────────────────────────────

/** Fixed 6 dp, via the one permitted formatter. `num` is round-half-up. */
function f6(x) {
  return num(x, 6, { comma: false });
}

/** Warn without assuming a console exists. Never affects a return value. */
function warn(...args) {
  if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
    console.warn(...args);
  }
}

/**
 * Wrap an `onProgress(done, total, label)` callback so it can never break the
 * pipeline, and so callers may omit it.
 * @param {((done: number, total: number, label: string) => void)|undefined|null} onProgress
 * @returns {(done: number, total: number, label: string) => void}
 */
function progressor(onProgress) {
  if (typeof onProgress !== 'function') return () => {};
  return (done, total, label) => {
    try {
      onProgress(done, total, label);
    } catch {
      // A UI callback is not allowed to fail a fetch.
    }
  };
}

/** True for the offline-cache sentinel, which every caller must re-raise. */
function isCacheMiss(exc) {
  return Boolean(exc) && exc.name === 'CacheMiss';
}

/** Message text of anything that was thrown. */
function why(exc) {
  return exc instanceof Error ? exc.message : String(exc);
}

// ═══════════════════════════════════════════════════════════════════════════
// Overpass plumbing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Overpass bbox literal — (S, W, N, E), fixed 6 dp so the cache key is stable.
 * @param {[number, number, number, number]} bbox
 * @returns {string}
 */
export function ovBbox(bbox) {
  const [s, w, n, e] = bbox;
  return `${f6(s)},${f6(w)},${f6(n)},${f6(e)}`;
}

/**
 * Substitute `{{bbox}}` in a selector.
 * @param {string} selector
 * @param {[number, number, number, number]} bbox
 * @returns {string}
 */
export function ovSub(selector, bbox) {
  return selector.split('{{bbox}}').join(ovBbox(bbox));
}

/**
 * The selector for a category, resolving the ones that live in a shared constant.
 * @param {import('./geodata.js').GeoCategory|{key: string, selector: string}} category
 * @returns {string}
 */
export function ovSelector(category) {
  if (category.key === 'car_street') return CAR_STREET_SELECTOR;
  return category.selector;
}

/**
 * `[out:json][timeout:N];` — the header every query carries.
 *
 * `timeoutS` is a parameter because the optional legal-path join deliberately asks
 * for a smaller server budget than everything else (`LEGAL_PATH_QL_TIMEOUT_S`,
 * generate.py line 4700): it is an enhancement, and it must not be allowed to hold
 * a mirror for five minutes.
 *
 * @param {number} [timeoutS]
 * @returns {string}
 */
export function ovHeader(timeoutS = OVERPASS_QL_TIMEOUT_S) {
  return `[out:json][timeout:${timeoutS}];`;
}

/**
 * The 16-hex handle the cache entry is named after — printed in §Provenance.
 * ASYNC, because `sha256Text` is (`crypto.subtle.digest` returns a Promise).
 * @param {string} query
 * @returns {Promise<string>}
 */
export function queryCacheKey(query) {
  return cacheKey16(query);
}

/**
 * `out geom` everywhere a distance or a ring is compared; `out center qt` only
 * for the pure density tally (buildings), per specs/osm.md §1.4 and §3.1.
 * @param {{key: string}} category
 * @param {{densityOnly?: ReadonlyArray<string>}} [opts]
 * @returns {string}
 */
export function outDirective(category, opts = {}) {
  const densityOnly = opts.densityOnly || GEO_DENSITY_ONLY;
  return densityOnly.includes(category.key) ? 'out center qt;' : 'out geom;';
}

/**
 * Assemble one Overpass QL request. This is the single QL writer every builder
 * below goes through, so the header can never drift between them.
 *
 * A statement is either a raw string appended verbatim, or an object:
 *   `{selector}`  — wrapped in `( … );` with `{{bbox}}` substituted
 *   `{raw}`       — emitted verbatim in the selector's place (used by `is_in`)
 *   `{out}`       — the out directive that follows it
 *   `{count}`     — append `out count;` as an explicit statement terminator
 *
 * TWO CALL SHAPES, and both are load-bearing. `web/osm/geodata.js` builds the QL
 * body itself — it is the module that knows what a category is — and calls
 * `overpassQL(bodyText, bbox, {timeoutS})`, where `bodyText` is one already-joined
 * run of statements whose `{{bbox}}` placeholders still need substituting. That is
 * the form generate.py's own builders use (`_ov_header() + …`, line 4989), and it is
 * the only way to pass `LEGAL_PATH_QL_TIMEOUT_S`. The array form below is this
 * module's own. Dispatch is on the first argument's type: a bbox is an array, a body
 * is a string, and neither can be mistaken for the other.
 *
 * @param {[number, number, number, number]|string|null} bbox bbox, or the QL body
 * @param {Array<string|{selector?: string, raw?: string, out?: string, count?: boolean}>
 *        |[number, number, number, number]} statements statements, or the bbox
 * @param {{timeoutS?: number}} [opts] body form only
 * @returns {string}
 */
export function overpassQL(bbox, statements, opts = {}) {
  // ── body form: overpassQL(body, bbox, {timeoutS}) ────────────────────────
  if (typeof bbox === 'string') {
    const body = bbox;
    const box = statements;
    const header = ovHeader(opts.timeoutS === undefined
      ? OVERPASS_QL_TIMEOUT_S : opts.timeoutS);
    // `is_in` queries carry no `{{bbox}}` at all; substitution is then a no-op.
    return header + (box ? ovSub(body, box) : body);
  }

  let out = ovHeader();
  for (const st of statements) {
    if (typeof st === 'string') {
      out += st;
      continue;
    }
    if (st.raw !== undefined && st.raw !== null) out += st.raw;
    else out += `(${ovSub(st.selector, bbox)});`;
    if (st.out) out += st.out;
    if (st.count) out += 'out count;';
  }
  return out;
}

/**
 * Run one Overpass QL query (bbox already substituted) and return parsed JSON.
 *
 * The cache key is the fully substituted query text, so changing the border
 * correctly invalidates. Endpoints are tried in `OVERPASS_ENDPOINTS` order with
 * retries and a courtesy sleep. Throws on total failure — callers decide whether
 * that degrades a section or aborts the run.
 *
 * The QL travels as a `text/plain` POST body. That content type is
 * CORS-safelisted and overpass-api.de answers it with `Access-Control-Allow-Origin: *`;
 * any other header would provoke a preflight the mirrors do not answer.
 *
 * @param {import('../lib/cache.js').Cache} cache
 * @param {string} query
 * @param {{onProgress?: Function, label?: string, done?: number, total?: number}} [opts]
 * @returns {Promise<Object>}
 */
export async function overpassQuery(cache, query, opts = {}) {
  const report = progressor(opts.onProgress);
  const label = opts.label || 'Overpass';
  const done = opts.done || 0;
  const total = opts.total || 1;

  report(done, total, label);
  let body;
  try {
    body = await httpFetch(cache, {
      kind: 'overpass',
      cacheKey: query,
      ext: 'json',
      endpoints: OVERPASS_ENDPOINTS,
      method: 'POST',
      data: query,
      courtesySleepS: OVERPASS_COURTESY_SLEEP_S,
    });
  } finally {
    // Advance even on failure: a dead tile still consumed its slot, and a bar
    // that stalls on an error reads as a hang.
    report(done + 1, total, label);
  }

  // A poisoned cache entry would make every later run reproduce the failure,
  // so drop it before throwing.
  const reject = async (reason) => {
    await cache.delete('overpass', query, 'json');
    throw new Error(`Overpass: ${reason}`);
  };

  let data;
  try {
    data = JSON.parse(new TextDecoder('utf-8').decode(body));
  } catch (exc) {
    // An HTML error page is the usual cause.
    await reject(`non-JSON response (${exc && exc.name ? exc.name : 'SyntaxError'})`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.elements)) {
    await reject('response carried no `elements` array');
  }
  const remark = String(data.remark === undefined || data.remark === null ? '' : data.remark).trim();
  if (remark && /error|out of memory|timed out/i.test(remark)) {
    await reject(`server remark: ${remark}`);
  }
  if (remark) warn(`overpass remark: ${remark}`);
  return data;
}

/**
 * Split an `out …; out count;`-per-statement response into per-statement blocks.
 *
 * Overpass returns every statement's elements concatenated in statement order with
 * nothing between them, so the trailing `out count;` of each statement is used as
 * an explicit terminator *and* as a checksum: the block length must equal the
 * count. Without this, a partially failed query silently shifts every category's
 * features onto the wrong category.
 *
 * @param {Object} data
 * @param {number} expected
 * @param {string} what
 * @returns {Array<Array<Object>>}
 */
export function splitStatements(data, expected, what) {
  /** @type {Array<Array<Object>>} */
  const blocks = [];
  /** @type {Array<Object>} */
  let current = [];
  for (const element of (data && Array.isArray(data.elements) ? data.elements : [])) {
    if (element && element.type === 'count') {
      const tags = element.tags || {};
      const raw = tags.total;
      const totalV = raw === undefined || raw === null
        ? current.length
        : Number.parseInt(String(raw), 10);
      const totalN = Number.isFinite(totalV) ? totalV : current.length;
      if (totalN !== current.length) {
        throw new Error(
          `Overpass ${what}: statement ${blocks.length} returned ${current.length} `
          + `elements but counted ${totalN}`,
        );
      }
      blocks.push(current);
      current = [];
    } else {
      current.push(element);
    }
  }
  if (current.length) {
    throw new Error(`Overpass ${what}: ${current.length} trailing elements with no count marker`);
  }
  if (blocks.length !== expected) {
    throw new Error(`Overpass ${what}: expected ${expected} statements, got ${blocks.length}`);
  }
  return blocks;
}

/**
 * The exact QL text `overpassCounts` sends — also the cache key.
 * @param {[number, number, number, number]} bbox
 * @param {ReadonlyArray<[string, string]>} selectors
 * @returns {string}
 */
export function countsQuery(bbox, selectors) {
  return overpassQL(bbox, selectors.map(([, sel]) => ({ selector: sel, count: true })));
}

/**
 * Map-level audit in ONE request, using `out count`.
 *
 * `selectors` is `[key, selector]` pairs; each becomes a statement followed by
 * `out count;`. Responses come back as `type:"count"` elements **in statement
 * order**, so assert the count matches before zipping — a partially failed query
 * silently returns fewer, and mis-zipping would attribute one category's count to
 * another. 28 categories cost one request and ~4 kB.
 *
 * @param {import('../lib/cache.js').Cache} cache
 * @param {[number, number, number, number]} bbox
 * @param {ReadonlyArray<[string, string]>} selectors
 * @param {{onProgress?: Function, label?: string}} [opts]
 * @returns {Promise<Object<string, number>>}
 */
export async function overpassCounts(cache, bbox, selectors, opts = {}) {
  const query = countsQuery(bbox, selectors);
  const data = await overpassQuery(cache, query, {
    onProgress: opts.onProgress,
    label: opts.label || 'Overpass feature audit',
  });
  const counts = data.elements.filter((e) => e && e.type === 'count');
  if (counts.length !== selectors.length) {
    throw new Error(
      `Overpass count audit: asked ${selectors.length} statements, got ${counts.length} counts`,
    );
  }
  /** @type {Object<string, number>} */
  const out = {};
  for (let i = 0; i < selectors.length; i++) {
    const raw = (counts[i].tags || {}).total;
    const n = raw === undefined || raw === null ? 0 : Number.parseInt(String(raw), 10);
    out[selectors[i][0]] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Element → Poi: rings, representative points, dedup
// ═══════════════════════════════════════════════════════════════════════════

/** Exact coordinate equality — see `stitchRings`. */
function samePoint(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * `current[:0] = head` — prepend in place. Deliberately not `unshift(...head)`:
 * a stitched coastline ring runs to tens of thousands of points and spreading
 * that many arguments overflows the call stack.
 */
function prependInPlace(current, head) {
  const tail = current.slice();
  current.length = 0;
  for (const p of head) current.push(p);
  for (const p of tail) current.push(p);
}

/**
 * A way's `out geom` geometry as [lat, lon], dropping any hole Overpass left.
 * @param {Object} element
 * @returns {Array<[number, number]>}
 */
export function wayLine(element) {
  const geometry = element.geometry || [];
  const out = [];
  for (const p of geometry) {
    if (p && p.lat !== undefined) out.push([p.lat, p.lon]);
  }
  return out;
}

/**
 * Stitch member ways into closed rings by matching endpoints.
 *
 * Multipolygon members arrive unordered and in arbitrary direction; shared nodes
 * carry byte-identical coordinates, so exact coordinate equality is the correct
 * join. Open leftovers are discarded (a broken relation is not a polygon). Member
 * order is the response order, which is stable for a fixed OSM snapshot.
 *
 * @param {ReadonlyArray<ReadonlyArray<[number, number]>>} lines
 * @returns {Array<Array<[number, number]>>}
 */
export function stitchRings(lines) {
  const pool = [];
  for (const line of lines) {
    if (line.length >= 2) pool.push(Array.from(line));
  }
  /** @type {Array<Array<[number, number]>>} */
  const rings = [];
  while (pool.length) {
    const current = pool.shift();
    let progress = true;
    while (!samePoint(current[0], current[current.length - 1]) && progress) {
      progress = false;
      for (let i = 0; i < pool.length; i++) {
        const other = pool[i];
        const head = current[0];
        const tail = current[current.length - 1];
        if (samePoint(other[0], tail)) {
          for (let j = 1; j < other.length; j++) current.push(other[j]);
        } else if (samePoint(other[other.length - 1], tail)) {
          for (let j = other.length - 2; j >= 0; j--) current.push(other[j]);
        } else if (samePoint(other[other.length - 1], head)) {
          prependInPlace(current, other.slice(0, -1));
        } else if (samePoint(other[0], head)) {
          prependInPlace(current, Array.from(other).reverse().slice(0, -1));
        } else {
          continue;
        }
        pool.splice(i, 1);
        progress = true;
        break;
      }
    }
    if (samePoint(current[0], current[current.length - 1]) && current.length >= 4) {
      rings.push(current.slice(0, -1));
    }
  }
  return rings;
}

/**
 * `[outer rings, inner rings]` in [lat, lon]. Both empty when the element is not
 * an area.
 * @param {Object} element
 * @returns {[Array<Array<[number, number]>>, Array<Array<[number, number]>>]}
 */
export function elementRings(element) {
  const kind = element.type;
  if (kind === 'way') {
    const line = wayLine(element);
    if (line.length >= 4 && samePoint(line[0], line[line.length - 1])) {
      return [[line.slice(0, -1)], []];
    }
    return [[], []];
  }
  if (kind === 'relation') {
    /** @type {Array<Array<[number, number]>>} */
    const outer = [];
    /** @type {Array<Array<[number, number]>>} */
    const inner = [];
    for (const member of (element.members || [])) {
      if (!member || member.type !== 'way' || !member.geometry) continue;
      const line = [];
      for (const p of member.geometry) {
        if (p && p.lat !== undefined) line.push([p.lat, p.lon]);
      }
      if (line.length < 2) continue;
      (member.role === 'inner' ? inner : outer).push(line);
    }
    return [stitchRings(outer), stitchRings(inner)];
  }
  return [[], []];
}

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
 * Every coordinate an element carries, for the last-resort centroid.
 * @param {Object} element
 * @returns {Array<[number, number]>}
 */
export function allPoints(element) {
  const pts = wayLine(element);
  for (const member of (element.members || [])) {
    if (!member) continue;
    if (member.geometry) {
      for (const p of member.geometry) {
        if (p && p.lat !== undefined) pts.push([p.lat, p.lon]);
      }
    } else if (member.lat !== undefined) {
      pts.push([member.lat, member.lon]);
    }
  }
  return pts;
}

/**
 * The rulebook's "map icon" for one element — specs/osm.md §3.2.
 *
 * Node → itself. Closed way / multipolygon → area-weighted shoelace centroid with
 * an interior fallback when it lands outside the shape. Open way → length-weighted
 * midpoint. Never `out center`, which is the bbox centre and diverges by a measured
 * p90 of 88 m on real park polygons.
 *
 * This is what the rulebook measures distance to: for a large park the relevant
 * point is the label in the middle, which can be a mile from where a player is
 * standing inside it.
 *
 * @param {Object} element
 * @param {import('../lib/geo.js').Projection} proj
 * @param {ReadonlyArray<ReadonlyArray<[number, number]>>} outers
 * @param {ReadonlyArray<ReadonlyArray<[number, number]>>} inners
 * @returns {[number, number]|null} `[lat, lon]`
 */
export function representativeLatlon(element, proj, outers, inners) {
  if (element.type === 'node' && element.lat !== undefined) {
    return [Number(element.lat), Number(element.lon)];
  }

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

  const line = wayLine(element);
  if (line.length >= 2) {
    const [x, y] = polylineMidpoint(planar(line, proj));
    const [lon, lat] = proj.lonlat(x, y);
    return [lat, lon];
  }
  if (line.length === 1) return line[0];

  if (element.center !== undefined && element.center !== null) {
    // `out center` output — density tallies only.
    return [Number(element.center.lat), Number(element.center.lon)];
  }

  const pts = allPoints(element);
  if (pts.length) {
    const flat = pts.map(([lat, lon]) => proj.xy(lat, lon));
    let sx = 0.0;
    let sy = 0.0;
    for (const p of flat) { sx += p[0]; sy += p[1]; }
    const [lon, lat] = proj.lonlat(sx / flat.length, sy / flat.length);
    return [lat, lon];
  }
  const bounds = element.bounds;
  if (bounds) {
    return [(bounds.minlat + bounds.maxlat) / 2.0, (bounds.minlon + bounds.maxlon) / 2.0];
  }
  return null;
}

/** Code-point-ordered string comparison. Never `localeCompare`. */
function cmpStr(a, b) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

/**
 * Reduce one statement's elements to sorted, deduplicated `Poi` records.
 *
 * Deduplication implements specs/osm.md §3.2 step 6, and only that: a **node**
 * inside an area feature of the same category is the same real-world thing mapped
 * twice (a museum node inside the museum building) and the area wins. It is
 * deliberately not extended to area-inside-area — measured on the reference bbox
 * that would delete 25 pitches that sit inside recreation grounds, which are
 * genuinely separate features a player can stand on.
 *
 * @param {ReadonlyArray<Object>} elements
 * @param {string} category
 * @param {import('../lib/geo.js').Projection} proj
 * @param {{keepRings: boolean, keepTags?: boolean}} opts
 * @returns {Array<import('./geodata.js').Poi>}
 */
export function parseOverpass(elements, category, proj, opts) {
  const keepRings = Boolean(opts && opts.keepRings);
  const keepTags = !opts || opts.keepTags === undefined ? true : Boolean(opts.keepTags);

  /** @type {Array<{poi: Object, rings: Array<Array<[number, number]>>, area: number}>} */
  const records = [];
  for (const element of elements) {
    if (!element) continue;
    if (element.type !== 'node' && element.type !== 'way' && element.type !== 'relation') continue;
    const [outers, inners] = elementRings(element);
    const point = representativeLatlon(element, proj, outers, inners);
    if (point === null) continue;
    const tagsRaw = element.tags || {};
    /** @type {Object<string, string>} */
    const tags = {};
    if (keepTags) {
      for (const k of Object.keys(tagsRaw).sort(cmpStr)) tags[String(k)] = String(tagsRaw[k]);
    }
    const planarOuters = outers.map((r) => planar(r, proj));
    let area = 0.0;
    for (const r of planarOuters) area += polygonArea(r);
    for (const r of inners) area -= polygonArea(planar(r, proj));
    const poi = {
      category,
      osmType: element.type,
      osmId: Number.parseInt(String(element.id), 10),
      name: String(tagsRaw.name === undefined || tagsRaw.name === null ? '' : tagsRaw.name),
      lat: point[0],
      lon: point[1],
      tags,
      // Geographic [lat, lon] pairs — project before any geometry call.
      rings: keepRings ? outers : [],
    };
    records.push({ poi, rings: planarOuters, area: Math.max(0.0, area) });
  }

  records.sort((a, b) => cmpStr(a.poi.osmType, b.poi.osmType) || (a.poi.osmId - b.poi.osmId));

  /** @type {Array<{poi: Object, rings: Array<Array<[number, number]>>, area: number, box: [number, number, number, number]}>} */
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

// ═══════════════════════════════════════════════════════════════════════════
// Category fetching
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Split a bbox into ≤ `OVERPASS_TILE_DEG` squares, south-west first.
 * @param {[number, number, number, number]} bbox
 * @returns {Array<[number, number, number, number]>}
 */
export function tileBbox(bbox) {
  const [s, w, n, e] = bbox;
  const rows = Math.max(1, Math.ceil((n - s) / OVERPASS_TILE_DEG));
  const cols = Math.max(1, Math.ceil((e - w) / OVERPASS_TILE_DEG));
  const dlat = (n - s) / rows;
  const dlon = (e - w) / cols;
  /** @type {Array<[number, number, number, number]>} */
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push([s + r * dlat, w + c * dlon, s + (r + 1) * dlat, w + (c + 1) * dlon]);
    }
  }
  return out;
}

/**
 * The exact single-category QL — also the cache key for the provenance row.
 * @param {{key: string, selector: string}} category
 * @param {[number, number, number, number]} bbox
 * @param {{densityOnly?: ReadonlyArray<string>}} [opts]
 * @returns {string}
 */
export function categoryQuery(category, bbox, opts = {}) {
  return overpassQL(bbox, [{
    selector: ovSelector(category),
    out: outDirective(category, opts),
  }]);
}

/**
 * Fetch one category bbox-wide and reduce it to `Poi` records.
 *
 * Uses `out geom` when a real centroid or a ring is required and `out center qt`
 * otherwise. Applies the representative-point rule, deduplicates a node inside a
 * same-category polygon in favour of the polygon, and returns sorted by
 * `(osmType, osmId)`.
 *
 * When the size guard trips (`OVERPASS_WAY_BUDGET`, above 150,000 ways), tiles the
 * bbox into ≤0.1° squares, caches per tile, and reports `onPartial()` — a size
 * failure must never become a `0` that reads as "this category does not exist here".
 * A cold run on a new city takes about eight minutes, so `onProgress` fires around
 * every tile.
 *
 * @param {import('../lib/cache.js').Cache} cache
 * @param {{key: string, selector: string}} category
 * @param {[number, number, number, number]} bbox
 * @param {import('../lib/geo.js').Projection} proj
 * @param {{onProgress?: Function, onPartial?: Function, densityOnly?: ReadonlyArray<string>,
 *          ringCategories?: ReadonlyArray<string>}} [opts]
 * @returns {Promise<Array<Object>>}
 */
export async function fetchCategory(cache, category, bbox, proj, opts = {}) {
  const densityOnly = opts.densityOnly || GEO_DENSITY_ONLY;
  const ringCategories = opts.ringCategories || RING_CATEGORIES;
  const selector = ovSelector(category);
  if (!selector) return [];
  const keepRings = ringCategories.includes(category.key);
  const keepTags = !densityOnly.includes(category.key);
  const directive = outDirective(category, { densityOnly });
  const query = overpassQL(bbox, [{ selector, out: directive }]);

  try {
    const data = await overpassQuery(cache, query, {
      onProgress: opts.onProgress,
      label: `Overpass: ${category.key}`,
    });
    return parseOverpass(data.elements, category.key, proj, { keepRings, keepTags });
  } catch (exc) {
    if (isCacheMiss(exc)) throw exc;
    // A too-big or timed-out fetch degrades to tiles.
    warn(`category ${category.key} failed whole-bbox (${why(exc)}); tiling`);
  }

  /** @type {Map<string, Object>} */
  const merged = new Map();
  let failures = 0;
  const tiles = tileBbox(bbox);
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const tileQuery = overpassQL(tile, [{ selector, out: directive }]);
    let data;
    try {
      data = await overpassQuery(cache, tileQuery, {
        onProgress: opts.onProgress,
        label: `Overpass: ${category.key} (tiled)`,
        done: i,
        total: tiles.length,
      });
    } catch (exc) {
      if (isCacheMiss(exc)) throw exc;
      // One dead tile is a floor, not a zero.
      failures += 1;
      warn(`category ${category.key} tile ${ovBbox(tile)} failed: ${why(exc)}`);
      continue;
    }
    for (const poi of parseOverpass(data.elements, category.key, proj, { keepRings, keepTags })) {
      merged.set(`${poi.osmType} ${poi.osmId}`, poi);
    }
  }
  if (failures) {
    warn(`category ${category.key}: ${failures} tiles failed; count is a floor`);
    if (typeof opts.onPartial === 'function') opts.onPartial(category.key, failures);
  }
  return Array.from(merged.values())
    .sort((a, b) => cmpStr(a.osmType, b.osmType) || (a.osmId - b.osmId));
}

/**
 * Fetch several categories in ONE request, attributing results by count marker.
 *
 * Returns `[category key → pois, cacheKey]`. On any failure the caller falls back
 * to per-category fetches, which cost more requests but survive one bad selector.
 *
 * @param {import('../lib/cache.js').Cache} cache
 * @param {ReadonlyArray<{key: string, selector: string}>} categories
 * @param {[number, number, number, number]} bbox
 * @param {import('../lib/geo.js').Projection} proj
 * @param {string} label
 * @param {{onProgress?: Function, densityOnly?: ReadonlyArray<string>,
 *          ringCategories?: ReadonlyArray<string>}} [opts]
 * @returns {Promise<[Object<string, Array<Object>>, string]>}
 */
export async function fetchGroup(cache, categories, bbox, proj, label, opts = {}) {
  const densityOnly = opts.densityOnly || GEO_DENSITY_ONLY;
  const ringCategories = opts.ringCategories || RING_CATEGORIES;
  const query = overpassQL(bbox, categories.map((category) => ({
    selector: ovSelector(category),
    out: outDirective(category, { densityOnly }),
    count: true,
  })));
  const data = await overpassQuery(cache, query, {
    onProgress: opts.onProgress,
    label: `Overpass: ${label}`,
  });
  const blocks = splitStatements(data, categories.length, `group ${label}`);
  /** @type {Object<string, Array<Object>>} */
  const out = {};
  for (let i = 0; i < categories.length; i++) {
    const category = categories[i];
    out[category.key] = parseOverpass(blocks[i], category.key, proj, {
      keepRings: ringCategories.includes(category.key),
      keepTags: !densityOnly.includes(category.key),
    });
  }
  return [out, await cacheKey16(query)];
}

// ═══════════════════════════════════════════════════════════════════════════
// Nominatim and administrative divisions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {number} lat @param {number} lon
 * @returns {Object<string, string>} keys already in sorted order
 */
export function nominatimParams(lat, lon) {
  return {
    addressdetails: '1',
    extratags: '1',
    format: 'jsonv2',
    lat: f6(lat),
    lon: f6(lon),
    zoom: '10',
  };
}

/**
 * The fully-substituted request URL — the cache key and the provenance line.
 * @param {number} lat @param {number} lon
 * @returns {string}
 */
export function nominatimUrl(lat, lon) {
  const params = nominatimParams(lat, lon);
  return `${NOMINATIM_ENDPOINT}?${Object.keys(params).sort(cmpStr)
    .map((k) => `${k}=${params[k]}`).join('&')}`;
}

/**
 * One reverse geocode of the map centroid — the only Nominatim call per run.
 *
 * Supplies the place name (the pages' `{place}`), the country code (which drives
 * the Street View table and the scale-bar unit) and, crucially, the
 * `ISO3166-2-lvl<N>` key whose N *is* the country's first administrative division's
 * OSM `admin_level`. Rate limit is 1 req/s. If it is unreachable, the caller falls
 * back to the `ISO3166-1` tag on the `admin_level=2` area returned by `is_in`,
 * which costs no extra request — so a failure here must never abort the run.
 *
 * The Python sends a mandatory `User-Agent`. A browser cannot set one; Nominatim
 * accepts the `Referer` the browser sends instead.
 *
 * @param {import('../lib/cache.js').Cache} cache
 * @param {number} lat @param {number} lon
 * @param {{onProgress?: Function}} [opts]
 * @returns {Promise<Object>}
 */
export async function nominatimReverse(cache, lat, lon, opts = {}) {
  const report = progressor(opts.onProgress);
  const params = nominatimParams(lat, lon);
  const key = nominatimUrl(lat, lon);
  const label = 'Nominatim reverse geocode';

  report(0, 1, label);
  let body;
  try {
    body = await httpFetch(cache, {
      kind: 'nominatim',
      cacheKey: key,
      ext: 'json',
      endpoints: [NOMINATIM_ENDPOINT],
      method: 'GET',
      params,
      courtesySleepS: NOMINATIM_COURTESY_SLEEP_S,
    });
  } finally {
    report(1, 1, label);
  }

  let data;
  try {
    data = JSON.parse(new TextDecoder('utf-8').decode(body));
  } catch (exc) {
    await cache.delete('nominatim', key, 'json');
    throw new Error(`Nominatim: non-JSON response (${exc && exc.name ? exc.name : 'SyntaxError'})`);
  }
  return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
}

/**
 * The exact QL one batched containment request sends — also its cache key.
 * @param {ReadonlyArray<[number, number]>} batch `[lat, lon]` pairs
 * @returns {string}
 */
export function isInQuery(batch) {
  return overpassQL(null, batch.map(([lat, lon]) => ({
    raw: `is_in(${f6(lat)},${f6(lon)});`,
    out: 'out tags;',
    count: true,
  })));
}

/**
 * Batched `is_in` containment lookup. Returns per-point tag objects and cache keys.
 *
 * `is_in` yields **area** objects, so a `relation.a[...]` filter silently returns
 * nothing; the result is filtered on the returned elements' own tags instead. The
 * `out count;` after each `out tags;` is what makes a batched response separable —
 * without it every point's hierarchy is one undifferentiated list.
 *
 * @param {import('../lib/cache.js').Cache} cache
 * @param {ReadonlyArray<[number, number]>} points
 * @param {{onProgress?: Function}} [opts]
 * @returns {Promise<[Array<Array<Object<string, string>>>, string[]]>}
 */
export async function isInAreas(cache, points, opts = {}) {
  /** @type {Array<Array<Object<string, string>>>} */
  const perPoint = [];
  /** @type {string[]} */
  const keys = [];
  const batches = Math.max(1, Math.ceil(points.length / IS_IN_BATCH));
  let n = 0;
  for (let start = 0; start < points.length; start += IS_IN_BATCH) {
    const batch = points.slice(start, start + IS_IN_BATCH);
    const query = isInQuery(batch);
    const data = await overpassQuery(cache, query, {
      onProgress: opts.onProgress,
      label: 'Overpass: administrative containment',
      done: n,
      total: batches,
    });
    n += 1;
    keys.push(await cacheKey16(query));
    for (const block of splitStatements(data, batch.length, 'is_in')) {
      perPoint.push(block.map((e) => {
        const raw = (e && e.tags) || {};
        /** @type {Object<string, string>} */
        const tags = {};
        for (const k of Object.keys(raw).sort(cmpStr)) tags[String(k)] = String(raw[k]);
        return tags;
      }));
    }
  }
  return [perPoint, keys];
}
