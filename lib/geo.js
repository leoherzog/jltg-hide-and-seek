// lib/geo.js
// ─────────────────────────────────────────────────────────────────────────────
// S0 · GEOMETRY — the shared toolkit
//
// Ported from generate.py.
//
// Everything here is haversine, an equirectangular projection, a monotone-chain
// hull, Welzl, ray casting and segment distance — a few hundred lines that
// would otherwise pull in a geometry library. The determinism story is also
// much easier to defend when the geometry is code we can read.
//
// CONVENTIONS
//   * A geographic point is `[lat, lon]` in decimal degrees.
//   * A planar point is `[x, y]` in metres, x east / y north, in a `Projection`.
//   * A bbox is `[S, W, N, E]` — Overpass order, NOT GeoJSON order.
//   * A ring is an array of planar points, first point NOT repeated at the end.
//
// Worker-safe: no DOM, no wall clock, no entropy.
// ─────────────────────────────────────────────────────────────────────────────

import { EARTH_R_M } from './core.js';

const RAD = Math.PI / 180;

/** Euclidean distance between two planar points — Python's `math.dist`. */
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

/**
 * Great-circle distance in metres between two WGS84 points.
 * @param {number} lat1 @param {number} lon1
 * @param {number} lat2 @param {number} lon2
 * @returns {number} metres
 */
export function haversineM(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD;
  const p2 = lat2 * RAD;
  const dp = p2 - p1;
  const dl = (lon2 - lon1) * RAD;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1.0, Math.sqrt(a)));
}

/**
 * Local equirectangular projection about a reference latitude.
 *
 * Metres, x east / y north, accurate to well under a metre across a city-sized
 * map and exactly reversible. Every distance, grid and area computation in the
 * program works in this plane; only the final output converts back to degrees.
 *
 * Instances are immutable and carry only two numbers, so `{lat0, lon0}` is the
 * structured-clone-safe wire form: rebuild with `new Projection(lat0, lon0)`.
 */
export class Projection {
  /**
   * @param {number} lat0
   * @param {number} lon0
   */
  constructor(lat0, lon0) {
    this.lat0 = lat0;
    this.lon0 = lon0;
    Object.freeze(this);
  }

  /** @returns {number} */
  get mPerDegLat() { return 111132.0; }

  /** @returns {number} */
  get mPerDegLon() { return 111320.0 * Math.cos(this.lat0 * RAD); }

  /**
   * Geographic → planar.
   * @param {number} lat @param {number} lon
   * @returns {[number, number]} `[x, y]` in metres
   */
  xy(lat, lon) {
    return [(lon - this.lon0) * this.mPerDegLon, (lat - this.lat0) * this.mPerDegLat];
  }

  /**
   * Planar → geographic. NOTE the order: `[lon, lat]`, matching the Python.
   * @param {number} x @param {number} y
   * @returns {[number, number]} `[lon, lat]` in degrees
   */
  lonlat(x, y) {
    return [this.lon0 + x / this.mPerDegLon, this.lat0 + y / this.mPerDegLat];
  }

  /**
   * Planar → geographic in `[lat, lon]` order, for callers that would otherwise
   * swap by hand. Same arithmetic as `lonlat`.
   * @param {number} x @param {number} y
   * @returns {[number, number]} `[lat, lon]`
   */
  latlon(x, y) {
    return [this.lat0 + y / this.mPerDegLat, this.lon0 + x / this.mPerDegLon];
  }

  /** Structured-clone-safe wire form. */
  toJSON() { return { lat0: this.lat0, lon0: this.lon0 }; }

  /**
   * Build a projection centred on the mean of `points` (`[lat, lon]` pairs).
   * @param {Array<[number, number]>} points
   * @returns {Projection}
   */
  static about(points) {
    if (!points || points.length === 0) throw new RangeError('no points to project about');
    let slat = 0;
    let slon = 0;
    for (const p of points) { slat += p[0]; slon += p[1]; }
    return new Projection(slat / points.length, slon / points.length);
  }

  /**
   * Rebuild a `Projection` from its wire form (or pass one through).
   * @param {{lat0: number, lon0: number}} o
   * @returns {Projection}
   */
  static from(o) {
    return o instanceof Projection ? o : new Projection(o.lat0, o.lon0);
  }
}

/**
 * `[S, W, N, E]` of a sequence of `[lat, lon]`. Overpass order, not GeoJSON.
 * @param {Array<[number, number]>} points
 * @returns {[number, number, number, number]}
 */
export function bboxOf(points) {
  let s = Infinity;
  let w = Infinity;
  let n = -Infinity;
  let e = -Infinity;
  for (const p of points) {
    if (p[0] < s) s = p[0];
    if (p[0] > n) n = p[0];
    if (p[1] < w) w = p[1];
    if (p[1] > e) e = p[1];
  }
  return [s, w, n, e];
}

/**
 * Expand an `[S, W, N, E]` box by `metres` on every side.
 * @param {[number, number, number, number]} bbox
 * @param {number} metres
 * @returns {[number, number, number, number]}
 */
export function bboxExpand(bbox, metres) {
  const [s, w, n, e] = bbox;
  const dlat = metres / 111132.0;
  const mid = (s + n) / 2;
  const dlon = metres / (111320.0 * Math.max(0.05, Math.cos(mid * RAD)));
  return [s - dlat, w - dlon, n + dlat, e + dlon];
}

/**
 * Is `(lat, lon)` inside the `[S, W, N, E]` box? Boundary counts as inside.
 * @param {[number, number, number, number]} bbox
 * @param {number} lat @param {number} lon
 * @returns {boolean}
 */
export function bboxContains(bbox, lat, lon) {
  const [s, w, n, e] = bbox;
  return s <= lat && lat <= n && w <= lon && lon <= e;
}

/**
 * Python's `sorted(set(points))` over planar `[x, y]` tuples: dedupe on exact
 * coordinate equality, then sort lexicographically by x then y.
 * @param {Array<[number, number]>} points
 * @returns {Array<[number, number]>}
 */
function sortedUnique(points) {
  const seen = new Map();
  for (const p of points) {
    // `+0` folds -0 into 0 so the two do not survive as distinct keys, matching
    // Python, where `-0.0 == 0.0` collapses them inside a set.
    const key = `${p[0] + 0},${p[1] + 0}`;
    if (!seen.has(key)) seen.set(key, [p[0] + 0, p[1] + 0]);
  }
  const out = Array.from(seen.values());
  out.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  return out;
}

/**
 * Monotone-chain convex hull of planar `[x, y]` points, counter-clockwise.
 *
 * Input is sorted first, so the output is identical regardless of input order.
 * Collinear points are dropped. Returns the hull without repeating the first
 * point; fewer than three distinct points returns them sorted.
 * @param {Array<[number, number]>} points
 * @returns {Array<[number, number]>}
 */
export function convexHull(points) {
  const pts = sortedUnique(points);
  if (pts.length <= 2) return pts;

  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * Shoelace area of a planar ring, in the ring's own units squared. Absolute.
 * @param {Array<[number, number]>} ring
 * @returns {number}
 */
export function polygonArea(ring) {
  if (ring.length < 3) return 0.0;
  let a = 0.0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2.0;
}

/**
 * Shoelace **area** centroid of a planar ring.
 *
 * Falls back to the bbox centre when the ring is degenerate (|A| < 1e-9). This
 * is deliberately not Overpass's `out center`, which returns the bbox centre
 * and diverges from the true centroid by a measured p90 of 88 m on real park
 * polygons — enough to flip zone membership against a 402 m radius.
 * @param {Array<[number, number]>} ring
 * @returns {[number, number]}
 */
export function ringCentroid(ring) {
  if (ring.length < 3) {
    const xs = ring.length ? ring.map((p) => p[0]) : [0.0];
    const ys = ring.length ? ring.map((p) => p[1]) : [0.0];
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  }
  let a = 0.0;
  let cx = 0.0;
  let cy = 0.0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    const f = x1 * y2 - x2 * y1;
    a += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let minx = Infinity; let maxx = -Infinity; let miny = Infinity; let maxy = -Infinity;
    for (const p of ring) {
      if (p[0] < minx) minx = p[0];
      if (p[0] > maxx) maxx = p[0];
      if (p[1] < miny) miny = p[1];
      if (p[1] > maxy) maxy = p[1];
    }
    return [(minx + maxx) / 2, (miny + maxy) / 2];
  }
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
}

/**
 * Ray-casting point-in-polygon for a planar ring.
 * Boundary is undefined-but-stable.
 * @param {[number, number]} pt
 * @param {Array<[number, number]>} ring
 * @returns {boolean}
 */
export function pointInRing(pt, ring) {
  const x = pt[0];
  const y = pt[1];
  let inside = false;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    if ((y1 > y) !== (y2 > y)) {
      const xint = (x2 - x1) * (y - y1) / (y2 - y1) + x1;
      if (x < xint) inside = !inside;
    }
  }
  return inside;
}

/**
 * A point guaranteed to lie *inside* a planar ring — the rulebook's "map icon".
 *
 * Uses the area centroid when it falls inside the ring. For concave shapes (a
 * C-shaped park, a river-wrapped campus) the centroid can fall outside, so this
 * falls back to scanning the horizontal line through the centroid's y, and
 * returns the midpoint of the longest interior span. Deterministic, and close
 * enough to where a map app would place the label.
 * @param {Array<[number, number]>} ring
 * @returns {[number, number]}
 */
export function representativePoint(ring) {
  const c = ringCentroid(ring);
  if (ring.length < 3 || pointInRing(c, ring)) return c;
  const y = c[1];
  const xs = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    if ((y1 > y) !== (y2 > y)) xs.push((x2 - x1) * (y - y1) / (y2 - y1) + x1);
  }
  xs.sort((a, b) => a - b);
  let best = c;
  let bestLen = -1.0;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const span = xs[i + 1] - xs[i];
    if (span > bestLen) {
      bestLen = span;
      best = [(xs[i] + xs[i + 1]) / 2, y];
    }
  }
  return best;
}

/**
 * Length-weighted midpoint of an open planar polyline (a river, a rail line).
 *
 * Not the mean of the vertices, which is biased toward dense vertex clusters at
 * curves.
 * @param {Array<[number, number]>} line
 * @returns {[number, number]}
 */
export function polylineMidpoint(line) {
  if (!line || line.length === 0) throw new RangeError('empty polyline');
  if (line.length === 1) return line[0];
  const segs = [];
  let total = 0.0;
  for (let i = 0; i + 1 < line.length; i++) {
    const d = dist(line[i], line[i + 1]);
    segs.push(d);
    total += d;
  }
  const half = total / 2;
  let run = 0.0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (run + seg >= half) {
      const t = seg === 0 ? 0.0 : (half - run) / seg;
      const [x1, y1] = line[i];
      const [x2, y2] = line[i + 1];
      return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
    }
    run += seg;
  }
  return line[line.length - 1];
}

/**
 * Distance from a planar point to the segment ab.
 * @param {[number, number]} pt
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @returns {number}
 */
export function segPointDist(pt, a, b) {
  const [ax, ay] = a;
  const [bx, by] = b;
  const [px, py] = pt;
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return dist(pt, a);
  const t = Math.max(0.0, Math.min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return dist(pt, [ax + t * dx, ay + t * dy]);
}

/**
 * Does the disc of `radius` about `pt` intersect the polygon `ring`?
 *
 * True when the point is inside the ring, or when any edge comes within
 * `radius`. This is the *polygon* predicate — the rulebook's photo questions
 * ("stand in a park") use it, while its matching/measuring questions use the
 * map icon instead. Measured spread on real data: 45.5% of stops by polygon vs
 * 29.0% by icon. Never substitute one for the other.
 * @param {[number, number]} pt
 * @param {Array<[number, number]>} ring
 * @param {number} radius
 * @returns {boolean}
 */
export function ringWithin(pt, ring, radius) {
  if (pointInRing(pt, ring)) return true;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    if (segPointDist(pt, ring[i], ring[(i + 1) % n]) <= radius) return true;
  }
  return false;
}

/**
 * mulberry32 — a 32-bit PRNG, used here as a FIXED PERMUTATION, not as entropy.
 *
 * THE ONE INTENTIONAL DIVERGENCE FROM THE CLI: generate.py shuffles with
 * `random.Random(0)` (Mersenne Twister), which cannot be reproduced cheaply in
 * the browser. The shuffle only exists to give Welzl its expected-linear
 * running time; the minimum enclosing circle it computes is the same circle
 * under any permutation, up to floating-point noise well under the 1e-7 slack
 * the `inside` test already carries. Seed is a hard-coded 0, there is no clock
 * or entropy source anywhere near it, and two runs over the same input produce
 * byte-identical output — which is what the determinism rule actually requires.
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Welzl's minimum enclosing circle of planar points → `[cx, cy, r]`.
 *
 * Determinism: the input is sorted and deduped first and then permuted by a
 * fixed-seed `mulberry32(0)` Fisher-Yates. That is a fixed permutation, not
 * entropy. See the note on `mulberry32` above for why this is the one place the
 * JS port does not mirror the CLI's shuffle exactly.
 * @param {Array<[number, number]>} points
 * @returns {[number, number, number]} `[cx, cy, radius]`
 */
export function minEnclosingCircle(points) {
  const pts = sortedUnique(points);
  if (!pts.length) throw new RangeError('no points');

  const rand = mulberry32(0);
  for (let i = pts.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = pts[i];
    pts[i] = pts[j];
    pts[j] = tmp;
  }

  const circle2 = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, dist(a, b) / 2];

  const circle3 = (a, b, c) => {
    const [ax, ay] = a;
    const [bx, by] = b;
    const [cx0, cy0] = c;
    const d = 2 * (ax * (by - cy0) + bx * (cy0 - ay) + cx0 * (ay - by));
    if (Math.abs(d) < 1e-12) return null;
    const ux = ((ax * ax + ay * ay) * (by - cy0) + (bx * bx + by * by) * (cy0 - ay)
      + (cx0 * cx0 + cy0 * cy0) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx0 - bx) + (bx * bx + by * by) * (ax - cx0)
      + (cx0 * cx0 + cy0 * cy0) * (bx - ax)) / d;
    return [ux, uy, dist([ux, uy], a)];
  };

  const inside = (c, p) => dist([c[0], c[1]], p) <= c[2] + 1e-7;

  let circle = [pts[0][0], pts[0][1], 0.0];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (inside(circle, p)) continue;
    circle = [p[0], p[1], 0.0];
    for (let j = 0; j < i; j++) {
      const q = pts[j];
      if (inside(circle, q)) continue;
      circle = circle2(p, q);
      for (let k = 0; k < j; k++) {
        const r = pts[k];
        if (inside(circle, r)) continue;
        const c3 = circle3(p, q, r);
        if (c3 !== null) circle = c3;
      }
    }
  }
  return circle;
}

/**
 * Uniform grid hash over planar points, for radius queries.
 *
 * Cell size is the query radius, so any query disc lies inside a 3×3 cell
 * neighbourhood: exactly nine bucket reads. (R/2 cells need 5×5 = 25 reads; 2R
 * cells need 3×3 but with 4× the candidates.) Measured on real data — 1,635
 * POIs, 1,493 query points, R = 402.336 m — this is 11.2 candidate tests per
 * query against 1,635 brute force, a 146× reduction.
 *
 * Bucket contents keep insertion order and callers insert in a sorted order, so
 * iteration is deterministic. `near()` returns `[key, x, y]` triples sorted by
 * `String(key)`.
 *
 * Not structured-clone-safe (it holds a Map). Build it inside the worker and
 * flatten before emitting.
 */
export class GridIndex {
  /** @param {number} cell cell size in metres, normally the query radius */
  constructor(cell) {
    this.cell = cell;
    /** @type {Map<string, Array<[*, number, number]>>} */
    this._cells = new Map();
  }

  _bucket(gx, gy) {
    const k = `${gx},${gy}`;
    let b = this._cells.get(k);
    if (b === undefined) { b = []; this._cells.set(k, b); }
    return b;
  }

  /**
   * Insert a *point* feature.
   * @param {*} key @param {number} x @param {number} y
   */
  add(key, x, y) {
    this._bucket(Math.floor(x / this.cell), Math.floor(y / this.cell)).push([key, x, y]);
  }

  /**
   * Insert an *area* feature into every cell its bbox touches.
   *
   * Returns false (and inserts nothing) when the feature would occupy more than
   * `cap` cells — the caller keeps those few huge features in a linear-scan
   * fallback list so one statewide multipolygon cannot blow up the index.
   * @param {*} key
   * @param {number} minx @param {number} miny @param {number} maxx @param {number} maxy
   * @param {{cap?: number}} [opts]
   * @returns {boolean}
   */
  addBbox(key, minx, miny, maxx, maxy, opts = {}) {
    const cap = opts.cap !== undefined ? opts.cap : 400;
    const x0 = Math.floor(minx / this.cell);
    const x1 = Math.floor(maxx / this.cell);
    const y0 = Math.floor(miny / this.cell);
    const y1 = Math.floor(maxy / this.cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > cap) return false;
    const cx = (minx + maxx) / 2;
    const cy = (miny + maxy) / 2;
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) this._bucket(gx, gy).push([key, cx, cy]);
    }
    return true;
  }

  /**
   * Every indexed item within `radius` of `(x, y)`, sorted by `String(key)`.
   * `radius` may be `Infinity`, which still only reads the 3×3 neighbourhood —
   * that is how the area-index callers ask for "everything nearby".
   * @param {number} x @param {number} y @param {number} radius
   * @returns {Array<[*, number, number]>}
   */
  near(x, y, radius) {
    const gx = Math.floor(x / this.cell);
    const gy = Math.floor(y / this.cell);
    const out = [];
    for (const dx of [-1, 0, 1]) {
      for (const dy of [-1, 0, 1]) {
        const bucket = this._cells.get(`${gx + dx},${gy + dy}`);
        if (bucket === undefined) continue;
        for (const item of bucket) {
          if (Math.hypot(x - item[1], y - item[2]) <= radius) out.push(item);
        }
      }
    }
    out.sort((a, b) => {
      const ka = String(a[0]);
      const kb = String(b[0]);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return out;
  }

  /**
   * Just the keys from `near()`, deduplicated, sorted by `String(key)`.
   * @param {number} x @param {number} y @param {number} radius
   * @returns {Array<*>}
   */
  nearKeys(x, y, radius) {
    const seen = new Map();
    for (const item of this.near(x, y, radius)) {
      const k = String(item[0]);
      if (!seen.has(k)) seen.set(k, item[0]);
    }
    return Array.from(seen.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((k) => seen.get(k));
  }
}
