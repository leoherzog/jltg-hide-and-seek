/**
 * S1 · hiding zones and network metrics.
 *
 * Port of `generate.py`: `zone_cover`, `_s1_zone_members`,
 * `build_zones`, `_s1_hull_and_shape`, `_s1_route_km`, `radar_liveness`,
 * `_s1_percentiles`, `_s1_day_metrics`, `_s1_axis_scores`, `_s1_provisional_size`,
 * `network_metrics` and `route_headways`.
 *
 * `routeSpokes` is not a port: it is new (2026-08-23) and exists so the map can draw
 * the network's shape. It and `s1RouteKm` read one `s1Shapes(feed)` — one parse of
 * `shapes.txt`, one longest-shape-per-(route, direction) selection — so the drawn
 * network and the published kilometres are the same set of lines by construction.
 *
 * `cluster_stations` lives in `./service.js` in this port — it is a
 * property of the feed, not of the metric table — and is re-exported here so the
 * grouping of the Python section survives.
 *
 * Three things in this file carry rulebook meaning and must not drift:
 *
 *   * `zoneCover` is *the* hiding-zone count. The tie-break chain and the lazy-heap
 *     ordering are load-bearing: change either and the reference feed stops being
 *     319 quarter-mile zones.
 *   * `routeHeadways` reports the **midday median over the route-direction's stops**,
 *     never the all-day mean. It legitimately disagrees with agency-published figures
 *     on peak-heavy routes; that disagreement is the correct answer to "how often can
 *     I catch this at 11am", which is the only question the game asks.
 *   * `_s1DayMetrics` emits the metric table that `rules/score.js` and every renderer
 *     look up **by name**. Renaming a key silently deletes a scoring metric.
 *
 * Field names follow CONTRACT.md §(b): camelCase, with the snake_case Python
 * original in the trailing comment.
 *
 * No DOM, no clock, no RNG. Every `Map`/`Set`/object is sorted before it is
 * iterated for anything that reaches the output.
 *
 * @module gtfs/network.js
 */

import {
  DEFAULT_DEPARTURE,
  HALF_MILE_M,
  HEADWAY_WINDOW,
  MAP_SPOKE_RDP_M,
  MAX_MAP_SPOKES,
  M_PER_KM,
  M_PER_MILE,
  MIDDAY_WINDOW,
  QUARTER_MILE_M,
  RADAR_SAMPLE_PAIRS,
  SERVICE_DAY_SECONDS,
  SQM_PER_SQMI,
  T90_ORIGIN_STRIDE,
  cmpStr,
  coord,
  stableHash,
  dateRange,
  dowOf,
  hhmmss,
  hmsToS,
  lowerMedian,
  quantile,
} from '../lib/core.js';
import {
  GridIndex,
  Projection,
  bboxOf,
  convexHull,
  haversineM,
  minEnclosingCircle,
  polygonArea,
} from '../lib/geo.js';
import { s1Cache, s1Float, s1Int, s1Median, s1Share } from './feed.js';
// A cycle on purpose: infer.js imports the size table from here, and this file
// takes the memoised hub run from there. Both sides only call the other's
// functions from inside functions, never at module top level, so ES-module
// hoisting resolves it; do not add a top-level use of `hubRun` here.
import { hubRun } from './infer.js';
import {
  busiestDay,
  clusterStations,
  noServiceDates,
  s1BestDirGaps,
  s1Extras,
  s1Gaps,
  s1Positions,
} from './service.js';
import { raptor } from './raptor.js';

// ── private constants (generate.py) ──────────────────────────

/**
 * Tuple keys are joined with U+0000, which is below every character a GTFS id can
 * legally hold, so sorting the joined strings reproduces Python's element-wise
 * tuple ordering exactly.
 */
const SEP = '\u0000';

/** Ascending numeric order. `Array.prototype.sort` is lexicographic by default. */
function cmpNum(a, b) { return a - b; }

/**
 * `max(values)`, 0 on an empty sequence. Deliberately not `Math.max(...values)`:
 * spread passes every element as a call argument and blows the stack on arrays
 * with one entry per stop.
 */
function maxOf(values) {
  let m = 0;
  let seen = false;
  for (const v of values) {
    if (!seen || v > m) { m = v; seen = true; }
  }
  return seen ? m : 0;
}

/**
 * Radar / thermometer probe distances, in miles. Every rulebook radar and
 * thermometer tier appears here so `radarLiveness` answers all of them at once.
 * `_S1_RADAR_MILES`, generate.py.
 */
export const S1_RADAR_MILES = Object.freeze([0.25, 0.5, 1.0, 3.0, 5.0, 10.0, 15.0,
  25.0, 50.0, 100.0]);

/**
 * The rulebook's own size parameters (GUIDE.md "Choosing Game Size", SEEKING.md
 * question tiers). Every field here is a transcription EXCEPT `requiredHours`,
 * which is inferred and marked as such on each entry — see the note below.
 * `SIZES` in rules/catalogue.js is now only the catalogue-size lookup; it no
 * longer carries this table or this inference.
 * `_S1_SIZE_PARAMS`, generate.py.
 *
 * `requiredHours` is a playing DAY, not the whole game. The rulebook states a
 * size's length only as prose — SMALL "lasts 4–8 hours", MEDIUM "lasts about 1
 * day", LARGE "lasts 2 to 4 days" (GUIDE.md "Choosing Game Size") — and never
 * prints an hours-per-day figure, so 6 / 10 / 12 are ours. SMALL's 6 sits inside
 * the stated 4–8; 10 and 12 stay under the ~14 hours a day can hold once the
 * rulebook's own "minimum of 10 hours" of rest comes out of the 24. The scoring
 * layer divides a single day's service span by this, which is why a per-day
 * figure is the right unit for the multi-day sizes.
 */
export const S1_SIZE_PARAMS = Object.freeze({
  small: Object.freeze({
    hidingPeriodMin: 30, zoneRadiusM: QUARTER_MILE_M, tentacleReachMi: 0.0,
    thermometerMi: Object.freeze([0.5, 3.0]), categoryCount: 5, catalogueSize: 58,
    photoLimitMin: 10, otherLimitMin: 5, moveGrantMin: 10,
    requiredHours: 6.0,   // INFERRED — GUIDE.md line 28 says only "lasts 4–8 hours"
  }),
  medium: Object.freeze({
    hidingPeriodMin: 60, zoneRadiusM: QUARTER_MILE_M, tentacleReachMi: 1.0,
    thermometerMi: Object.freeze([0.5, 3.0, 10.0]), categoryCount: 6, catalogueSize: 71,
    photoLimitMin: 10, otherLimitMin: 5, moveGrantMin: 20,
    requiredHours: 10.0,  // INFERRED — GUIDE.md line 33 says only "lasts about 1 day"
  }),
  large: Object.freeze({
    hidingPeriodMin: 180, zoneRadiusM: HALF_MILE_M, tentacleReachMi: 15.0,
    thermometerMi: Object.freeze([0.5, 3.0, 10.0, 50.0]), categoryCount: 6, catalogueSize: 80,
    photoLimitMin: 20, otherLimitMin: 5, moveGrantMin: 60,
    requiredHours: 12.0,  // INFERRED — GUIDE.md line 38 says only "lasts 2 to 4 days"
  }),
});

/** `_S1_SIZE_ORDER`, generate.py. */
export const S1_SIZE_ORDER = Object.freeze(['small', 'medium', 'large']);

/** `sorted(_S1_SIZE_PARAMS)` — alphabetical, which is NOT `S1_SIZE_ORDER`. */
const SIZE_NAMES_SORTED = Object.freeze(Object.keys(S1_SIZE_PARAMS).sort(cmpStr));

// ── the lazy greedy heap ─────────────────────────────────────────────────────

/**
 * Python tuple order over `(-degree, -events, stopId)`.
 *
 * `stopId` is unique across the heap, so the order is total and the pop sequence
 * is fully determined — it does not depend on this heap's internal layout.
 */
function heapLess(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}

function siftUp(h, start) {
  let i = start;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!heapLess(h[i], h[parent])) break;
    const tmp = h[i]; h[i] = h[parent]; h[parent] = tmp;
    i = parent;
  }
}

function siftDown(h, start) {
  const n = h.length;
  let i = start;
  for (;;) {
    const l = 2 * i + 1;
    const r = l + 1;
    let small = i;
    if (l < n && heapLess(h[l], h[small])) small = l;
    if (r < n && heapLess(h[r], h[small])) small = r;
    if (small === i) break;
    const tmp = h[i]; h[i] = h[small]; h[small] = tmp;
    i = small;
  }
}

function heapify(h) {
  for (let i = (h.length >> 1) - 1; i >= 0; i--) siftDown(h, i);
}

function heapPush(h, item) {
  h.push(item);
  siftUp(h, h.length - 1);
}

function heapPop(h) {
  const last = h.pop();
  if (!h.length) return last;
  const top = h[0];
  h[0] = last;
  siftDown(h, 0);
  return top;
}

// ── zones ────────────────────────────────────────────────────────────────────

/**
 * Greedy maximal independent set at `radiusM` — the distinct-hiding-zone count.
 *
 * Repeatedly take the stop covering the most still-uncovered stops within the
 * radius, emit it as a zone centre, and remove everything inside. Tie-break chain
 * `(−degree, −stopEvents, stopId)` makes it fully deterministic; a grid makes it
 * 0.04 s where the O(n²) reference took 57 s (identical output).
 *
 * Returns the chosen centre stop ids, sorted. This is *the* number that goes into
 * the rulebook's "30–100 / 100–500 / 500+ stations" table — 1,493 bus poles are 319
 * distinct ¼-mile zones, and feeding the raw stop count in would call a mid-size
 * bus city a national rail network.
 *
 * @param {string[]} stopIds
 * @param {number} radiusM
 * @param {Object<string, number>} stopEvents
 * @param {Object<string, [number, number]>} pos  stop_id → projected metres
 * @returns {string[]} centre stop ids, sorted
 */
export function zoneCover(stopIds, radiusM, stopEvents, pos) {
  const ids = Array.from(new Set(stopIds)).sort(cmpStr);
  if (!ids.length) return [];

  const cell = Math.max(1.0, radiusM);
  const grid = new GridIndex(cell);
  for (const sid of ids) grid.add(sid, pos[sid][0], pos[sid][1]);

  /** @type {Map<string, string[]>} `neighbour_cache` — sorted, deduped, includes self. */
  const neighbourCache = new Map();
  function neighbours(sid) {
    let hit = neighbourCache.get(sid);
    if (hit === undefined) {
      hit = grid.nearKeys(pos[sid][0], pos[sid][1], radiusM);
      neighbourCache.set(sid, hit);
    }
    return hit;
  }

  const alive = new Set(ids);
  /** @type {string[]} */
  const picks = [];
  const heap = ids.map((sid) => {
    const raw = stopEvents[sid];
    return [-neighbours(sid).length, -Math.trunc(raw === undefined ? 0 : raw), sid];
  });
  heapify(heap);

  while (alive.size && heap.length) {
    let chosen = null;
    while (heap.length) {
      const [degree, events, sid] = heapPop(heap);
      if (!alive.has(sid)) continue;
      let current = 0;
      for (const other of neighbours(sid)) if (alive.has(other)) current++;
      if (current !== -degree) {            // stale key — reinsert with the live degree
        heapPush(heap, [-current, events, sid]);
        continue;
      }
      chosen = sid;
      break;
    }
    if (chosen === null) break;
    picks.push(chosen);
    for (const other of neighbours(chosen)) alive.delete(other);
  }
  // unreachable in practice; keeps the cover total
  for (const sid of Array.from(alive).sort(cmpStr)) picks.push(sid);
  return Array.from(new Set(picks)).sort(cmpStr);
}

/**
 * `centre → every stop of `stopIds` inside its circle`, sorted.
 * `_s1_zone_members`, generate.py.
 *
 * @param {string[]} centres @param {string[]} stopIds @param {number} radiusM
 * @param {Object<string, [number, number]>} pos
 * @returns {Object<string, string[]>}
 */
export function s1ZoneMembers(centres, stopIds, radiusM, pos) {
  const cell = Math.max(1.0, radiusM);
  const grid = new GridIndex(cell);
  for (const sid of Array.from(stopIds).sort(cmpStr)) grid.add(sid, pos[sid][0], pos[sid][1]);
  const out = Object.create(null);
  for (const centre of Array.from(centres).sort(cmpStr)) {
    out[centre] = grid.nearKeys(pos[centre][0], pos[centre][1], radiusM);
  }
  return out;
}

/**
 * Turn zone-cover centres into full `Zone` records.
 *
 * Each zone gains every served stop inside its circle, the union of their routes,
 * and the total stop events — so the dossier can say "6 stops, 3 routes, this is
 * the one you name". Sorted by `zoneId`.
 *
 * `inPlay` (2026-08-27) is the in-play set, or null for every served stop. It has to
 * be threaded here as well as into `zoneCover`: the cover picks the CENTRES, and
 * without this the MEMBERS would still be drawn from every served stop, so a stop the
 * border or `excludeStops` deleted would go on contributing its departures to
 * `stopEvents`, its routes to `routeIds`, and its id to `Zone.stopIds` — which
 * `s3ZoneHeadwayMin`, `s3ZoneLastArrivalS` and the strategy view's "N stops inside the
 * circle" all read. `s1DayMetrics` has always measured its own zones over the in-play
 * set, so the emitted zones and the metrics measured over them used to disagree.
 *
 * @param {object} feed @param {object} day a `ServiceDay`
 * @param {string[]} centres @param {number} radiusM
 * @param {Projection|{lat0:number,lon0:number}} projLike
 * @param {string[]|null} [inPlay] the in-play set, or null for every served stop
 * @returns {object[]} `Zone` records
 */
export function buildZones(feed, day, centres, radiusM, projLike, inPlay = null) {
  const proj = Projection.from(projLike);
  const pos = s1Positions(feed, proj);
  const members = s1ZoneMembers(centres, inPlayForDay(day, inPlay), radiusM, pos);
  const out = [];
  for (const centre of Object.keys(members).sort(cmpStr)) {
    const stop = feed.stops[centre];
    const inside = members[centre];
    const routeSet = new Set();
    let events = 0;
    for (const sid of inside) {
      const sd = day.stopDays[sid];
      for (const r of sd.routes) routeSet.add(r);
      events += sd.departures.length;
    }
    const [x, y] = pos[centre];
    out.push({
      zoneId: centre,                            // zone_id
      name: stop.baseName || stop.name,          // name
      lat: stop.lat,
      lon: stop.lon,
      x,
      y,
      stopIds: inside,                           // stop_ids
      routeIds: Array.from(routeSet).sort(cmpStr), // route_ids
      stopEvents: events,                        // stop_events
    });
  }
  return out;
}

// ── network metrics ──────────────────────────────────────────────────────────

/**
 * `[hull, areaM2, diameterM]` for planar points. Diameter is the max hull pair.
 * `_s1_hull_and_shape`, generate.py.
 *
 * @param {Array<[number, number]>} points
 * @returns {[Array<[number, number]>, number, number]}
 */
export function s1HullAndShape(points) {
  const hull = convexHull(points);
  const area = hull.length >= 3 ? polygonArea(hull) : 0.0;
  let diameter = 0.0;
  if (hull.length >= 2) {
    for (let i = 0; i < hull.length; i++) {
      for (let j = i + 1; j < hull.length; j++) {
        const d = Math.hypot(hull[i][0] - hull[j][0], hull[i][1] - hull[j][1]);
        if (d > diameter) diameter = d;
      }
    }
  } else if (points.length >= 2) {
    for (const p of points) {
      const d = Math.hypot(points[0][0] - p[0], points[0][1] - p[1]);
      if (d > diameter) diameter = d;
    }
  }
  return [hull, area, diameter];
}

/**
 * `shapes.txt`, parsed once per feed: each shape's metric length and its ordered
 * `[lat, lon]` points, plus the **longest shape per (routeId, directionId)**.
 *
 * `s1RouteKm` sums the lengths and `routeSpokes` draws the points, so this is the
 * one place the selection is made — the published kilometres and the drawn network
 * cannot disagree, and the file is read once rather than once per caller.
 *
 * A route-direction whose every shape measures zero is still a key here, carrying
 * `len: 0`: it adds nothing to a sum and draws nothing.
 *
 * Only the **selected** shapes' points survive into the cached value. A big feed's
 * `shapes.txt` is mostly short-turn and detour variants that no route-direction wins
 * with (MBTA: ~1.4 M points), and this is memoised on the feed for the whole run —
 * so the point arrays are built, measured, and then dropped for every shape
 * `longest` does not name.
 *
 * @param {object} feed
 * @returns {{seq: Map<string, Array<[number, number]>>,
 *            longest: Map<string, {len: number, id: string}>}}
 */
function s1Shapes(feed) {
  return s1Cache(feed, 'shapes', () => {
    /** @type {Map<string, Array<[number, number, number]>>} shape_id → (seq, lat, lon) */
    const pts = new Map();
    for (const row of (feed.tables && feed.tables.shapes) || []) {
      const lat = s1Float(row.shape_pt_lat);
      const lon = s1Float(row.shape_pt_lon);
      if (lat === null || lon === null) continue;
      const key = (row.shape_id || '').trim();
      let bucket = pts.get(key);
      if (bucket === undefined) { bucket = []; pts.set(key, bucket); }
      bucket.push([s1Int(row.shape_pt_sequence), lat, lon]);
    }

    /** @type {Map<string, number>} shape_id → metric length */
    const len = new Map();
    /** @type {Map<string, Array<[number, number]>>} shape_id → points, pruned below */
    const points = new Map();
    for (const shapeId of Array.from(pts.keys()).sort(cmpStr)) {
      const ordered = pts.get(shapeId).slice()
        .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]));
      let total = 0.0;
      for (let i = 1; i < ordered.length; i++) {
        total += haversineM(ordered[i - 1][1], ordered[i - 1][2], ordered[i][1], ordered[i][2]);
      }
      len.set(shapeId, total);
      points.set(shapeId, ordered.map((r) => [r[1], r[2]]));
    }

    /** @type {Map<string, {len: number, id: string}>} `(routeId, directionId)` → longest */
    const longest = new Map();
    const trips = ((feed.tables && feed.tables.trips) || []).slice()
      .sort((a, b) => cmpStr((a.trip_id || ''), (b.trip_id || '')));
    for (const trip of trips) {
      const shapeId = (trip.shape_id || '').trim();
      if (!len.has(shapeId)) continue;
      const k = (trip.route_id || '').trim() + SEP + (trip.direction_id || '').trim();
      const value = len.get(shapeId);
      const best = longest.get(k);
      if (best === undefined || value > best.len) longest.set(k, { len: value, id: shapeId });
    }

    /** @type {Map<string, Array<[number, number]>>} only the shapes `longest` names */
    const seq = new Map();
    for (const k of Array.from(longest.keys()).sort(cmpStr)) {
      const id = longest.get(k).id;
      if (!seq.has(id)) seq.set(id, points.get(id));
    }
    return { seq, longest };
  });
}

/**
 * `[bothDirectionsKm, oneDirectionKm]` from the **longest shape per
 * (routeId, directionId)**.
 *
 * Summing every shape overstates the reference network 6.5× (5,220 km against
 * 809 km) because every short-turn and detour variant is its own shape.
 *
 * The one-direction figure folds out of the same map: a route's longest shape is
 * the longest of its directions' longest shapes.
 *
 * @param {object} feed @returns {[number, number]}
 */
export function s1RouteKm(feed) {
  return s1Cache(feed, 'route_km', () => {
    const { longest } = s1Shapes(feed);

    /** @type {Map<string, number>} routeId → longest shape metres */
    const longestRoute = new Map();
    let both = 0.0;
    for (const k of Array.from(longest.keys()).sort(cmpStr)) {
      const value = longest.get(k).len;
      both += value;
      const routeId = k.slice(0, k.indexOf(SEP));
      if (value > (longestRoute.get(routeId) || 0.0)) longestRoute.set(routeId, value);
    }
    let one = 0.0;
    for (const k of Array.from(longestRoute.keys()).sort(cmpStr)) one += longestRoute.get(k);
    return [both / M_PER_KM, one / M_PER_KM];
  });
}

/**
 * Perpendicular distance in metres from `p` to the segment `a`–`b`.
 *
 * Local equirectangular metres about `a` — the same approximation `ringOf` in the
 * page runtime draws with, and good to a few centimetres over a bus route. Only the
 * RDP decimation reads it, and its tolerance is 20 m.
 */
function segDistM(p, a, b) {
  const k = Math.cos((a[0] * Math.PI) / 180.0);
  const py = (p[0] - a[0]) * 111132.0;
  const px = (p[1] - a[1]) * 111320.0 * k;
  const by = (b[0] - a[0]) * 111132.0;
  const bx = (b[1] - a[1]) * 111320.0 * k;
  const len2 = (bx * bx) + (by * by);
  if (len2 <= 0.0) return Math.sqrt((px * px) + (py * py));
  let t = ((px * bx) + (py * by)) / len2;
  if (t < 0.0) t = 0.0;
  if (t > 1.0) t = 1.0;
  const dx = px - (t * bx);
  const dy = py - (t * by);
  return Math.sqrt((dx * dx) + (dy * dy));
}

/**
 * Ramer-Douglas-Peucker, **iterative**, over `[lat, lon]` points.
 *
 * An explicit stack and integer indices, never recursion: a national feed ships
 * polylines deep enough to blow the call stack, and — worse for this repo — a
 * recursive implementation's result can depend on the engine's stack limit. The
 * keep-mask is built in index order, so the output is the input's own order.
 *
 * @param {Array<[number, number]>} points @param {number} toleranceM
 * @returns {Array<[number, number]>}
 */
function rdp(points, toleranceM) {
  const n = points.length;
  if (n <= 2) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  /** @type {number[]} pairs of indices, pushed and popped as flat integers */
  const stack = [0, n - 1];
  while (stack.length) {
    const last = stack.pop();
    const first = stack.pop();
    let worst = -1.0;
    let at = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segDistM(points[i], points[first], points[last]);
      if (d > worst) { worst = d; at = i; }
    }
    if (at >= 0 && worst > toleranceM) {
      keep[at] = 1;
      stack.push(first, at, at, last);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * Drawable geometry for the map's route-spoke layer, one entry per route-direction.
 *
 * The geometry is `s1Shapes`' **longest shape per (routeId, directionId)** — the
 * very selection `s1RouteKm` sums for `routeKmOneDir`, so the drawn network and the
 * published kilometres cannot disagree — decimated by RDP at `toleranceM`. A feed
 * with no `shapes.txt` falls back to the longest ordered stop sequence per
 * route-direction (`source: 'stops'`), which is a chord diagram rather than a road
 * alignment and is labelled as one on the page.
 *
 * Route-directions are ranked by `(-maxTrips, shortName, routeId, directionId)` —
 * `s4HeatmapRows`' own tie-break tuple — and sliced to `cap`. `cap.shown < cap.total`
 * is the page's cue to say so; a silent cap is the one thing this must not be.
 *
 * @param {object} feed @param {object[]} days @param {object|null} hub
 * @param {number} [cap=MAX_MAP_SPOKES] @param {number} [toleranceM=MAP_SPOKE_RDP_M]
 * @returns {{spokes: object[], cap: {shown: number, total: number, source: string}}}
 */
export function routeSpokes(feed, days, hub, cap = MAX_MAP_SPOKES,
  toleranceM = MAP_SPOKE_RDP_M) {
  const tripsPerDay = new Map();          // routeId\0directionId → dayKey → trips
  const dayKeys = Array.from(days || [], (d) => d.dayType.key).sort(cmpStr);
  for (const day of days || []) {
    const extras = s1Extras(day);
    for (const t of Object.keys(extras.tripRoute).sort(cmpStr)) {
      const [routeId, direction] = extras.tripRoute[t];
      const k = routeId + SEP + direction;
      let bucket = tripsPerDay.get(k);
      if (bucket === undefined) { bucket = new Map(); tripsPerDay.set(k, bucket); }
      bucket.set(day.dayType.key, (bucket.get(day.dayType.key) || 0) + 1);
    }
  }

  /** @type {Map<string, Array<[number, number]>>} route-direction → [lat, lon] points */
  const geometry = new Map();
  let source = 'shapes';

  const { seq, longest } = s1Shapes(feed);
  for (const k of Array.from(longest.keys()).sort(cmpStr)) {
    geometry.set(k, seq.get(longest.get(k).id));
  }

  if (!geometry.size) {
    // No shapes.txt (or none any trip references). The honest fallback is the
    // longest ordered stop sequence per route-direction: right topology, straight
    // chords instead of streets, and `source` says so.
    source = 'stops';
    /** @type {Map<string, string[]>} route-direction → stop ids */
    const longest = new Map();
    for (const day of days || []) {
      const ids = day.stopIndex.ids;
      for (const pattern of day.patterns || []) {
        const k = String(pattern.routeId || '') + SEP + String(pattern.directionId || '');
        const best = longest.get(k);
        if (best !== undefined && best.length >= pattern.stops.length) continue;
        const seq = [];
        for (let i = 0; i < pattern.stops.length; i++) seq.push(ids[pattern.stops[i]]);
        longest.set(k, seq);
      }
    }
    for (const k of Array.from(longest.keys()).sort(cmpStr)) {
      const seq = [];
      for (const sid of longest.get(k)) {
        const stop = feed.stops[sid];
        if (stop) seq.push([stop.lat, stop.lon]);
      }
      if (seq.length >= 2) geometry.set(k, seq);
    }
  }

  // Which route-directions touch the round-start station, from the day's own stop
  // rows rather than from the geometry — a shape can pass a stop it does not serve.
  const atHub = new Set();
  const hubId = (hub && hub.stopId) || '';
  if (hubId) {
    for (const day of days || []) {
      const sd = day.stopDays[hubId];
      for (const routeId of (sd && sd.routes) || []) atHub.add(routeId);
    }
  }

  const rows = [];
  for (const k of Array.from(geometry.keys()).sort(cmpStr)) {
    const cut = k.indexOf(SEP);
    const routeId = k.slice(0, cut);
    const directionId = k.slice(cut + 1);
    const route = feed.routes[routeId];
    const counts = tripsPerDay.get(k);
    /** @type {Object<string, number>} */ const trips = Object.create(null);
    let maxTrips = 0;
    for (const dk of dayKeys) {
      const n = counts ? (counts.get(dk) || 0) : 0;
      trips[dk] = n;
      if (n > maxTrips) maxTrips = n;
    }
    if (!maxTrips) continue;                // never runs on any day this feed models
    const coords = rdp(geometry.get(k), toleranceM)
      .map(([lat, lon]) => [coord(lon), coord(lat)]);
    if (coords.length < 2) continue;
    rows.push({
      routeId,                                              // route_id
      shortName: route ? route.shortName : '',              // short_name
      longName: route ? route.longName : '',                // long_name
      directionId,                                          // direction_id
      source,
      trips,
      touchesHub: atHub.has(routeId),                       // touches_hub
      coords,
      maxTrips,
    });
  }

  rows.sort((a, b) => (b.maxTrips - a.maxTrips)
    || cmpStr(String(a.shortName || ''), String(b.shortName || ''))
    || cmpStr(a.routeId, b.routeId)
    || cmpStr(a.directionId, b.directionId));
  const total = rows.length;
  const shown = Math.max(0, Math.min(Math.trunc(cap), total));
  const spokes = rows.slice(0, shown).map((r) => ({
    routeId: r.routeId,
    shortName: r.shortName,
    longName: r.longName,
    directionId: r.directionId,
    source: r.source,
    trips: r.trips,
    touchesHub: r.touchesHub,
    coords: r.coords,
  }));
  return { spokes, cap: { shown, total, source } };
}

/**
 * Hit rate of each radar radius over a deterministic stop-pair sample.
 *
 * Returns `radiusM → fraction of sampled pairs within that radius` (the key is the
 * radius stringified, per CONTRACT §(b) — `obj[402.336]` reads it back unchanged).
 * A radar is dead above `RADAR_DEAD_HIGH` (always "yes") or below `RADAR_DEAD_LOW`
 * (always "no"). Sampling is a fixed stride over sorted pairs, not RNG.
 *
 * @param {string[]} stopIds @param {Object<string, [number, number]>} pos
 * @param {number[]} radiiM
 * @returns {Object<string, number>}
 */
export function radarLiveness(stopIds, pos, radiiM) {
  const ids = Array.from(new Set(stopIds)).sort(cmpStr);
  const n = ids.length;
  const radii = Array.from(new Set(Array.from(radiiM, Number))).sort(cmpNum);

  const zeros = () => {
    const out = Object.create(null);
    for (const r of radii) out[r] = 0.0;
    return out;
  };
  if (n < 2 || !radii.length) return zeros();

  const totalPairs = Math.floor((n * (n - 1)) / 2);
  const stride = Math.max(1, Math.floor(totalPairs / RADAR_SAMPLE_PAIRS));
  const counts = new Array(radii.length).fill(0);
  let sampled = 0;
  const points = ids.map((sid) => pos[sid]);
  for (let i = 0; i < n; i++) {
    const xi = points[i][0];
    const yi = points[i][1];
    // The rotating offset keeps the sample from always landing on the same
    // alignment of the pair matrix; it is a pure function of i, not entropy.
    for (let j = i + 1 + (i % stride); j < n; j += stride) {
      const d = Math.hypot(points[j][0] - xi, points[j][1] - yi);
      sampled++;
      for (let k = 0; k < radii.length; k++) if (d <= radii[k]) counts[k]++;
    }
  }
  const out = Object.create(null);
  for (let k = 0; k < radii.length; k++) out[radii[k]] = counts[k] / sampled;
  return out;
}

/**
 * `{p05, p25, p50, …}` — the key is the probability × 100, zero-padded to two
 * digits, exactly as `_s1_percentiles` (generate.py) writes it.
 * @param {number[]} values @param {number[]} probs
 * @returns {Object<string, number>}
 */
export function s1Percentiles(values, probs) {
  const out = Object.create(null);
  if (!values.length) return out;
  for (const p of probs) {
    const key = `p${String(Math.round(p * 100)).padStart(2, '0')}`;
    out[key] = quantile(values, p);
  }
  return out;
}

/**
 * The in-play set as one service day sees it: `inPlay ∩ day.servedStopIds`, in
 * `inPlay`'s order, or every served stop when `inPlay` is null. The one place the
 * intersection is written, so `s1DayMetrics`, `buildZones` and the radar sample cannot
 * drift apart.
 * @param {object} day a `ServiceDay`
 * @param {string[]|null} inPlay
 * @returns {string[]}
 */
function inPlayForDay(day, inPlay) {
  if (!inPlay) return Array.from(day.servedStopIds);
  const today = new Set(day.servedStopIds);
  const out = inPlay.filter((sid) => today.has(sid));
  // A day the set does not touch AT ALL is measured whole rather than not at all.
  // The `IN_PLAY_MIN_SHARE` floor in `inPlayStopIds` protects the best day only, and
  // the set is then measured across every day type (and, for `suggestBorder`, over a
  // candidate core built on the best day): a Sunday network entirely outside the
  // reader's box leaves this intersection empty, and an empty set reaches
  // `minEnclosingCircle` below as `RangeError: no points` — which worker.js turns
  // into a fatal 'network' error and no report at all, for a border the reader was
  // entitled to draw. Same discipline as the floor, applied per day. (2026-08-27.)
  return out.length ? out : Array.from(day.servedStopIds);
}

/**
 * Everything that is a property of one service day. Called once per day type.
 * `_s1_day_metrics`, generate.py.
 *
 * The keys are read **by name** — by `rules/score.js`, by the renderers, and by
 * `networkMetrics` itself. Do not rename one without grepping.
 *
 * @param {object} feed @param {object} day a `ServiceDay`
 * `inPlay` (2026-08-27) narrows every quantity to the in-play set ∩ this day's
 * served stops — an intersection, because the set is built on the best day and a
 * Sunday-only stop is not in it while a weekday-only one is not served today.
 * Filtered in `inPlay`'s own order, which is `servedStopIds` order, so the T90
 * origin stride below samples the same way it always has. `null` is every served
 * stop and byte-identical to the pre-2026-08-27 behaviour.
 *
 * @param {Projection|{lat0:number,lon0:number}} projLike
 * @param {string|null} hubStopId @param {number} radiusM
 * @param {string[]|null} [inPlay] the in-play set, or null for every served stop
 * @returns {object} a `DayMetrics`
 */
export function s1DayMetrics(feed, day, projLike, hubStopId, radiusM, inPlay = null) {
  const proj = Projection.from(projLike);
  const pos = s1Positions(feed, proj);
  const extras = s1Extras(day);
  const served = inPlayForDay(day, inPlay);
  const events = Object.create(null);
  for (const sid of served) events[sid] = day.stopDays[sid].departures.length;

  const centres = zoneCover(served, radiusM, events, pos);
  // At LARGE the zone radius IS the half-mile radius, and nothing here mutates a
  // cover, so the two share one greedy pass rather than running it twice.
  const centresHalf = radiusM === HALF_MILE_M
    ? centres
    : zoneCover(served, HALF_MILE_M, events, pos);

  const points = served.map((sid) => pos[sid]);
  const [, hullArea, diameter] = s1HullAndShape(points);
  // Belt and braces beside `inPlayForDay`'s floor: `minEnclosingCircle` throws on an
  // empty array and `bboxOf` returns ±Infinity, which `proj.xy` turns into NaN. A day
  // with no served stops at all cannot reach here today; a table of zeroes is still a
  // better failure than a fatal stage. (2026-08-27.)
  const [cx, cy, mecR] = points.length ? minEnclosingCircle(points) : [0, 0, 0];
  const [mecLon, mecLat] = proj.lonlat(cx, cy);
  const latLon = served.map((sid) => [feed.stops[sid].lat, feed.stops[sid].lon]);
  const box = latLon.length ? bboxOf(latLon) : [0, 0, 0, 0];
  const sw = proj.xy(box[0], box[1]);
  const ne = proj.xy(box[2], box[3]);
  const bboxArea = Math.abs(ne[0] - sw[0]) * Math.abs(ne[1] - sw[1]);

  // ── headways ──────────────────────────────────────────────────────────────
  const base = served.filter((sid) => day.stopDays[sid].medianHeadwayS !== null);
  const medians = base.map((sid) => day.stopDays[sid].medianHeadwayS / 60.0);
  const worst = base.map((sid) => day.stopDays[sid].worstGapS / 60.0);
  const frequent = base.filter((sid) => day.stopDays[sid].frequent);

  const windowed = (window) => {
    const lo = hmsToS(window[0]) || 0;
    const hi = hmsToS(window[1]) || SERVICE_DAY_SECONDS;
    const out = [];
    for (const sid of served) {
      const inside = extras.dedup[sid].filter((t) => lo <= t && t <= hi);
      if (inside.length >= 2) out.push(s1Median(s1Gaps(inside)) / 60.0);
    }
    return out;
  };

  const midday = windowed(MIDDAY_WINDOW);

  // a stop counts as "30-minute" when a single route-direction beats 30 min — the
  // same measurement `buildServiceDay` cuts at FREQUENT_HEADWAY_MIN for `frequent`
  const bestDir = s1BestDirGaps(extras.routeDirStop);
  const within30 = base.filter((sid) => {
    const g = bestDir.get(sid);
    return (g === undefined ? Infinity : g) <= 1800;
  });

  const lastDepartures = served.map((sid) => day.stopDays[sid].last).sort(cmpNum);
  const routeCounts = served.map((sid) => day.stopDays[sid].routes.length);

  // ── travel time ───────────────────────────────────────────────────────────
  const depart = hmsToS(DEFAULT_DEPARTURE) || 32400;
  const origin = (hubStopId !== null && hubStopId !== undefined
    && Object.prototype.hasOwnProperty.call(day.stopDays, hubStopId))
    ? hubStopId
    : (served.length ? served[0] : null);
  /** @type {number[]} */
  let hubTimes = [];
  const reachByMinutes = Object.create(null);
  const reachableCentres = Object.create(null);
  if (origin) {
    // Memoised on the feed: `inferBorder` and `suggestBorder` want this exact run
    // (hub, DEFAULT_DEPARTURE) and now read the same object. Read-only from here.
    const run = hubRun(feed, day, origin, depart);
    // The run covers the WHOLE network — RAPTOR does not know about the in-play set —
    // so the arrival keys have to be narrowed to it here or `reachWithinHidingPeriod`
    // and the two hub-travel percentiles would be measured over stops the border
    // deleted, while `servedStops` beside them counts only the in-play ones. §05 and
    // the A2 finding print the two against each other ("1,486 of 1,190 served stops"),
    // so the mismatch was visible on the page. A null set keeps `Object.keys` verbatim
    // — same members, same order, byte-identical goldens. (2026-08-27.)
    const daySet = inPlay ? new Set(served) : null;
    // Unsorted keys on purpose: the map turns them into plain numbers before the
    // cmpNum sort, so the key order cannot be observed. Do not restore a cmpStr sort.
    hubTimes = Object.keys(run.arrivalS)
      .filter((sid) => daySet === null || daySet.has(sid))
      .map((sid) => (run.arrivalS[sid] - depart) / 60.0).sort(cmpNum);
    for (const minutes of [30, 60, 180]) {
      let reach = 0;
      for (const t of hubTimes) if (t <= minutes) reach++;
      reachByMinutes[minutes] = reach;
      let zones = 0;
      for (const c of centres) {
        const a = run.arrivalS[c];
        if (a !== undefined && (a - depart) / 60.0 <= minutes) zones++;
      }
      reachableCentres[minutes] = zones;
    }
  }

  // ~50 origins whatever the feed's size: the stride is the constant on a city
  // feed (1,490 served stops → exactly 50) and grows on a national one, so T90
  // costs 50 RAPTOR runs rather than one per thirty stops.
  const stride = Math.max(T90_ORIGIN_STRIDE, Math.ceil(served.length / 50));
  const sample = [];
  for (let i = 0; i < served.length; i += stride) sample.push(served[i]);
  const p90s = [];
  for (const sid of sample) {
    const run = raptor(day, [sid], depart);
    // Unsorted keys on purpose — same reasoning as the hub run above.
    const values = Object.keys(run.arrivalS)
      .map((k) => (run.arrivalS[k] - depart) / 60.0).sort(cmpNum);
    if (values.length >= 50) p90s.push(quantile(values, 0.90));
  }
  const t90 = p90s.length
    ? s1Median(p90s)
    : (hubTimes.length ? hubTimes[hubTimes.length - 1] : 0.0);

  // ── zone-shaped facts ─────────────────────────────────────────────────────
  const members = s1ZoneMembers(centres, served, radiusM, pos);
  let isolated = 0;
  if (centres.length > 1) {
    // Grid at 2r so any neighbour inside 2r lies in the 3×3 cell block — O(n),
    // not the O(n²) that a national feed's few thousand zones would make painful.
    const cell = Math.max(1.0, 2 * radiusM);
    const zgrid = new GridIndex(cell);
    for (const centre of centres) zgrid.add(centre, pos[centre][0], pos[centre][1]);
    for (const centre of centres) {
      let alone = true;
      for (const other of zgrid.nearKeys(pos[centre][0], pos[centre][1], 2 * radiusM)) {
        if (other !== centre) { alone = false; break; }
      }
      if (alone) isolated++;
    }
  }

  const roundStart = Math.max(day.firstDeparture, depart);
  const eveningShare = Object.create(null);
  for (const name of SIZE_NAMES_SORTED) {
    const cutoff = roundStart + S1_SIZE_PARAMS[name].requiredHours * 3600;
    let alive = 0;
    for (const c of centres) {
      for (const s of members[c]) {
        if (day.stopDays[s].last >= cutoff) { alive++; break; }
      }
    }
    eveningShare[name] = s1Share(alive, centres.length);
  }

  const spanHours = (day.lastDeparture - day.firstDeparture) / 3600.0;
  const servedSqMi = hullArea / SQM_PER_SQMI;

  const multiRoute = routeCounts.filter((c) => c >= 2).length;
  const tripleRoute = routeCounts.filter((c) => c >= 3).length;

  const reachWithinHidingPeriodBySize = Object.create(null);
  const reachableZoneShareBySize = Object.create(null);
  for (const name of SIZE_NAMES_SORTED) {
    const hp = S1_SIZE_PARAMS[name].hidingPeriodMin;
    const r = reachByMinutes[hp];
    reachWithinHidingPeriodBySize[name] = r === undefined ? 0 : r;
    const z = reachableCentres[hp];
    reachableZoneShareBySize[name] = s1Share(z === undefined ? 0 : z, centres.length);
  }

  return {
    dayKey: day.dayType.key,                     // day_key
    dayLabel: day.dayType.label,                 // day_label
    date: day.dayType.date,                      // date
    trips: day.trips,                            // trips
    stopEvents: day.stopEvents,                  // stop_events
    servedStops: served.length,                  // served_stops
    routes: day.routeIds.length,                 // routes
    firstDepartureS: day.firstDeparture,         // first_departure_s
    lastDepartureS: day.lastDeparture,           // last_departure_s
    spanHours,                                   // span_hours
    nZones: centres.length,                      // n_zones
    nZonesHalfMile: centresHalf.length,          // n_zones_half_mile
    bbox: box.map((v) => coord(v)),              // bbox
    hullSqM: hullArea,                           // hull_sq_m
    bboxSqM: bboxArea,                           // bbox_sq_m
    diameterM: diameter,                         // diameter_m
    mec: [coord(mecLat), coord(mecLon), mecR],   // mec
    medianHeadwayMin: medians.length ? s1Median(medians) : null,   // median_headway_min
    medianWorstGapMin: worst.length ? s1Median(worst) : null,      // median_worst_gap_min
    middayHeadwayP25P50P75: midday.length                          // midday_headway_p25_p50_p75
      ? [0.25, 0.5, 0.75].map((p) => quantile(midday, p)) : null,
    frequentStops: frequent.length,              // frequent_stops
    frequentShare: s1Share(frequent.length, base.length),   // frequent_share
    share30min: s1Share(within30.length, base.length),      // share_30min
    medianLastDepartureS: lastDepartures.length              // median_last_departure_s
      ? Math.trunc(s1Median(lastDepartures)) : day.lastDeparture,
    transferStops2plus: multiRoute,              // transfer_stops_2plus
    transferStops3plus: tripleRoute,             // transfer_stops_3plus
    multiRouteStopShare: s1Share(multiRoute, served.length),      // multi_route_stop_share
    // NOT `Math.max(...routeCounts)`: this array has one entry per served stop and
    // spread blows the argument limit on a national feed. Loop.
    routesPerStopMax: maxOf(routeCounts),        // routes_per_stop_max
    stopDensityPerSqMi: s1Share(served.length, servedSqMi),  // stop_density_per_sq_mi
    zoneDensityPerSqMi: s1Share(centres.length, servedSqMi), // zone_density_per_sq_mi
    hubTravelP50Min: hubTimes.length ? quantile(hubTimes, 0.50) : null, // hub_travel_p50_min
    hubTravelP95Min: hubTimes.length ? quantile(hubTimes, 0.95) : null, // hub_travel_p95_min
    t90Min: t90,                                 // t90_min
    isolatedZoneShare: s1Share(isolated, centres.length),    // isolated_zone_share
    eveningZoneShareBySize: eveningShare,        // evening_zone_share_by_size
    reachWithinHidingPeriodBySize,               // reach_within_hiding_period_by_size
    reachableZoneShareBySize,                    // reachable_zone_share_by_size
  };
}

/**
 * The four game-size axes, each scored 0=small / 1=medium / 2=large.
 * `_s1_axis_scores`, generate.py.
 * @param {number} hullSqMi @param {number} nZones @param {number} t90Min
 * @param {number} diameterMi
 * @returns {[number, number, number, number]}
 */
export function s1AxisScores(hullSqMi, nZones, t90Min, diameterMi) {
  const a = hullSqMi < 100 ? 0 : (hullSqMi <= 1000 ? 1 : 2);
  const b = nZones < 100 ? 0 : (nZones <= 500 ? 1 : 2);
  const c = t90Min <= 45 ? 0 : (t90Min <= 180 ? 1 : 2);
  const d = diameterMi < 15 ? 0 : (diameterMi <= 60 ? 1 : 2);
  return [a, b, c, d];
}

/**
 * The size the four axes imply, used only to pick which size-keyed default a
 * metric exposes. `inferGameSize` is the authority and re-derives it.
 * `_s1_provisional_size`, generate.py.
 * @param {object} metrics @returns {'small'|'medium'|'large'}
 */
export function s1ProvisionalSize(metrics) {
  const hullSqM = metrics.hullSqM === undefined ? 0.0 : metrics.hullSqM;
  const nZones = metrics.nZones === undefined ? 0 : metrics.nZones;
  const diameterM = metrics.diameterM === undefined ? 0.0 : metrics.diameterM;
  const scores = s1AxisScores(
    hullSqM / SQM_PER_SQMI,
    Math.trunc(nZones),
    Number(metrics.t90Min || 0.0),
    diameterM / M_PER_MILE,
  );
  let verdict = Math.floor(lowerMedian(Array.from(scores)));
  verdict = Math.max(scores[0] - 1, Math.min(scores[0] + 1, verdict));
  return S1_SIZE_ORDER[Math.max(0, Math.min(2, verdict))];
}

/**
 * Compute the whole network metric table — the input to the fitness model.
 *
 * Returns the flat object documented in CONTRACT §(b) `Metrics` (`servedStops`,
 * `nZones`, `hullSqM`, `diameterM`, `t90Min`, `medianHeadwayMin`, `frequentShare`,
 * `hubDominance`, `weekendRatio`, `spanHours`, …), with every per-day quantity
 * nested under `perDay[dayKey]`.
 *
 * Three choices that are baked in and must not be re-litigated:
 *   * route-km uses the **longest shape per (routeId, directionId)** — summing
 *     all shapes overstates the reference network 6.5× because every short-turn
 *     variant is its own shape;
 *   * area uses the **convex hull of served stops**, not the bbox (160 vs 259 sq mi);
 *   * traversal time is **T90** (median over a strided origin sample of each
 *     origin's p90), never `max`, which is set by one stop with a single
 *     mid-afternoon departure.
 *
 * Size-dependent quantities (`reachableZoneShare`, `eveningZoneShare`,
 * `playableDayWeight`, `reachWithinHidingPeriod`) are published both as a
 * `…BySize` object and as a single default keyed on the size the axes imply, so a
 * caller that already knows the resolved `GameSize` can read the exact figure.
 *
 * `inPlay` (2026-08-27) is the in-play set the whole table is measured over, or
 * null for every served stop. The memo key carries the set's length and a content
 * hash, so a caller measuring several candidate sets (`suggestBorder`) pays once
 * per DISTINCT set while a null caller keeps the key it always had. Two extra
 * fields describe the set: `allServedStops` (the unfiltered count on the best day)
 * and `inPlayFallback`, false here — the worker, which is the only caller that
 * knows whether `inPlayStopIds` fell back, overwrites it on the run's tables.
 *
 * @param {object} feed @param {object[]} days `ServiceDay`s
 * @param {Projection|{lat0:number,lon0:number}} projLike
 * @param {object} hub @param {number} radiusM
 * @param {string[]|null} [inPlay] the in-play set, or null for every served stop
 * @returns {object} a `Metrics`
 */
export function networkMetrics(feed, days, projLike, hub, radiusM, inPlay = null) {
  const proj = Projection.from(projLike);
  const ordered = Array.from(days);
  if (!ordered.length) throw new RangeError('networkMetrics needs at least one service day');

  const key = ['metrics', feed.sha256, ordered.map((d) => d.dayType.key).join(SEP),
    hub.stopId, Number(radiusM).toFixed(4),
    inPlay ? `in:${inPlay.length}:${stableHash(inPlay.join(','))}` : 'all'].join(SEP);
  const memo = s1Cache(feed, 'metrics_memo', () => new Map());
  if (memo.has(key)) return memo.get(key);

  const best = busiestDay(ordered);
  const hubStop = hub.stopId;

  /** @type {Object<string, object>} */
  const perDay = Object.create(null);
  for (const day of ordered) {
    perDay[day.dayType.key] = s1DayMetrics(feed, day, proj, hubStop, radiusM, inPlay);
  }

  // A shallow copy, exactly like the Python `dict(...)`: the nested objects stay
  // shared with `perDay[bestKey]`, only the top level is independent.
  const head = Object.assign(Object.create(null), perDay[best.dayType.key]);

  const stations = s1Cache(feed, `stations:${proj.lat0.toFixed(9)}`,
    () => clusterStations(Object.keys(feed.stops).sort(cmpStr).map((s) => feed.stops[s]), proj));
  const [, oneKm] = s1RouteKm(feed);

  // Which calendar weekday runs which day type. Keyed on the calendar, not on the
  // day-type name, so a feed whose Mon–Fri split into per-weekday types still
  // answers "what happens on a Saturday".
  /** @type {Map<number, string>} */
  const dowType = new Map();
  for (const day of ordered) {
    for (const date of day.dayType.dates) {
      const d = dowOf(date);
      if (!dowType.has(d)) dowType.set(d, day.dayType.key);
    }
  }

  const weekdayDows = [0, 1, 2, 3, 4].filter((d) => dowType.has(d));
  const weekday = weekdayDows.length
    ? perDay[dowType.get(weekdayDows[0])]
    : perDay[best.dayType.key];
  const saturday = dowType.has(5) ? (perDay[dowType.get(5)] || null) : null;
  const sunday = dowType.has(6) ? (perDay[dowType.get(6)] || null) : null;

  // A weekend day the feed does not run at all counts as zero, not as absent —
  // "there are no Sunday buses" is the strongest possible weekend collapse. Only a
  // feed with no weekday service to compare against scores the neutral 1.0.
  const weekendRatio = weekdayDows.length
    ? s1Share(Math.min(saturday ? saturday.trips : 0, sunday ? sunday.trips : 0), weekday.trips)
    : 1.0;

  const [deadDates, reducedDates] = noServiceDates(feed, feed.feedStart, feed.feedEnd);
  const windowDays = dateRange(feed.feedStart, feed.feedEnd).length;

  // playableDayWeight: 1/7 per calendar weekday whose day type keeps 60% of the
  // best day's zones and 70% of the size's required hours.
  const playable = Object.create(null);
  for (const name of SIZE_NAMES_SORTED) {
    const params = S1_SIZE_PARAMS[name];
    let total = 0.0;
    for (let dow = 0; dow < 7; dow++) {
      const info = perDay[dowType.has(dow) ? dowType.get(dow) : ''];
      if (!info) continue;
      if (info.nZones >= 0.60 * head.nZones
        && info.spanHours >= 0.70 * params.requiredHours) total += 1.0 / 7.0;
    }
    playable[name] = total;
  }

  const pos = s1Positions(feed, proj);
  const radar = radarLiveness(inPlayForDay(best, inPlay), pos,
    S1_RADAR_MILES.map((m) => m * M_PER_MILE));

  const baseNames = new Set();
  for (const sid of Object.keys(feed.stops).sort(cmpStr)) {
    const s = feed.stops[sid];
    baseNames.add(s.baseName || s.name);
  }

  const dowDayType = Object.create(null);
  for (let d = 0; d < 7; d++) dowDayType[String(d)] = dowType.has(d) ? dowType.get(d) : null;

  Object.assign(head, {
    stopsInFeed: Object.keys(feed.stops).length,     // stops_in_feed
    stations: stations.length,                       // stations
    distinctBaseNames: baseNames.size,               // distinct_base_names
    zoneRadiusM: Number(radiusM),                    // zone_radius_m
    routeKmOneDir: oneKm,                            // route_km_one_dir
    hubDominance: hub.routeShare,                    // hub_dominance
    hubTripShare: hub.tripShare,                     // hub_trip_share
    hubStopId: hub.stopId,                           // hub_stop_id
    networkShape: hub.shape,                         // network_shape
    weekendRatio,                                    // weekend_ratio
    satTripRatio: saturday ? s1Share(saturday.trips, weekday.trips) : null, // sat_trip_ratio
    sunTripRatio: sunday ? s1Share(sunday.trips, weekday.trips) : null,     // sun_trip_ratio
    saturdayDayKey: saturday ? saturday.dayKey : null, // saturday_day_key
    sundayDayKey: sunday ? sunday.dayKey : null,     // sunday_day_key
    dowDayType,                                      // dow_day_type
    noServiceDates: deadDates,                       // no_service_dates
    fullServiceDateShare: s1Share(                   // full_service_date_share
      windowDays - deadDates.length - reducedDates.length, windowDays),
    playableDayWeightBySize: playable,               // playable_day_weight_by_size
    radarHitRate: radar,                             // radar_hit_rate
    bestDay: best.dayType.key,                       // best_day
    perDay,                                          // per_day
    allServedStops: best.servedStopIds.length,       // all_served_stops (2026-08-27)
    inPlayFallback: false,                           // in_play_fallback — worker overwrites
  });

  const sizeName = s1ProvisionalSize(head);
  head.impliedSize = sizeName;                                        // implied_size
  head.eveningZoneShare = head.eveningZoneShareBySize[sizeName];      // evening_zone_share
  head.reachableZoneShare = head.reachableZoneShareBySize[sizeName];  // reachable_zone_share
  head.reachWithinHidingPeriod =                                      // reach_within_hiding_period
    head.reachWithinHidingPeriodBySize[sizeName];
  head.playableDayWeight = playable[sizeName];                        // playable_day_weight

  memo.set(key, head);
  return head;
}

/**
 * Per-route median headway per day type, for the heatmap.
 *
 * Keyed on `(routeId, directionId, stopId)` and then medianed over the
 * route-direction's stops. Computing it at "the busiest stop of the route" merges
 * the two directions and reported one route as 3 min instead of 8 — always key on
 * the direction.
 *
 * The window is MIDDAY, and the number is a MEDIAN over the direction's stops — not
 * the all-day mean and not an average of averages. On peak-heavy routes this
 * legitimately disagrees with the agency's own published headway, and the midday
 * figure is the one the game needs: it answers "how often can I catch this at 11am".
 *
 * Returns rows shaped as CONTRACT §(b) `RouteHeadwayRow`.
 *
 * @param {object} feed @param {object[]} days `ServiceDay`s
 * @returns {object[]}
 */
export function routeHeadways(feed, days) {
  if (!days.length) return [];
  const bestKey = busiestDay(days).dayType.key;

  // Midday is the honest window for "how often does this line run", but a peak-only
  // route has no midday service at all and would otherwise be indistinguishable from
  // a route that does not run that day. Widen the window until a number exists, so a
  // `null` headway means the line ran fewer than two trips past any single stop —
  // the row's `trips` counter says which of "none" and "one" it was.
  const windows = [MIDDAY_WINDOW, HEADWAY_WINDOW, ['00:00:00', hhmmss(SERVICE_DAY_SECONDS)]];

  // `routeId\0directionId` → dayKey → median headway ; and trip counts per day
  /** @type {Map<string, Map<string, number|null>>} */
  const headway = new Map();
  /** @type {Map<string, Map<string, number>>} */
  const trips = new Map();
  const bucket = (map, k) => {
    let b = map.get(k);
    if (b === undefined) { b = new Map(); map.set(k, b); }
    return b;
  };

  for (const day of days) {
    const extras = s1Extras(day);
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const t of Object.keys(extras.tripRoute).sort(cmpStr)) {
      const [routeId, direction] = extras.tripRoute[t];
      const k = routeId + SEP + direction;
      counts.set(k, (counts.get(k) || 0) + 1);
    }

    /** @type {Array<Map<string, number[]>>} */
    const perWindow = [];
    for (const window of windows) {
      const lo = hmsToS(window[0]) || 0;
      const hi = hmsToS(window[1]) || SERVICE_DAY_SECONDS;
      /** @type {Map<string, number[]>} */
      const perDir = new Map();
      for (const [[routeId, direction], values] of extras.routeDirStop) {
        const inside = values.filter((v) => lo <= v && v <= hi);
        if (inside.length < 2) continue;
        const k = routeId + SEP + direction;
        let arr = perDir.get(k);
        if (arr === undefined) { arr = []; perDir.set(k, arr); }
        arr.push(s1Median(s1Gaps(inside)) / 60.0);
      }
      perWindow.push(perDir);
    }

    const union = new Set(counts.keys());
    for (const pw of perWindow) for (const k of pw.keys()) union.add(k);
    for (const k of Array.from(union).sort(cmpStr)) {
      let value = null;
      for (const perDir of perWindow) {
        const got = perDir.get(k);
        if (got && got.length) { value = s1Median(got); break; }
      }
      bucket(headway, k).set(day.dayType.key, value);
      bucket(trips, k).set(day.dayType.key, counts.get(k) || 0);
    }
  }

  /** @type {Map<string, string[]>} routeId → directionIds, in sorted order */
  const byRoute = new Map();
  for (const composite of Array.from(headway.keys()).sort(cmpStr)) {
    const cut = composite.indexOf(SEP);
    const routeId = composite.slice(0, cut);
    const direction = composite.slice(cut + 1);
    let list = byRoute.get(routeId);
    if (list === undefined) { list = []; byRoute.set(routeId, list); }
    list.push(direction);
  }

  const rows = [];
  for (const routeId of Array.from(byRoute.keys()).sort(cmpStr)) {
    const route = feed.routes[routeId];
    const directions = byRoute.get(routeId).slice().sort(cmpStr);
    let split = false;
    if (directions.length === 2) {
      const ha = headway.get(routeId + SEP + directions[0]);
      const hb = headway.get(routeId + SEP + directions[1]);
      const a = ha ? ha.get(bestKey) : undefined;
      const b = hb ? hb.get(bestKey) : undefined;
      if (a && b && Math.max(a, b) / Math.min(a, b) > 1.5) split = true;
    }

    const rowFor = (direction, keys) => {
      const perDay = Object.create(null);
      const tripCounts = Object.create(null);
      for (const day of days) {
        const dk = day.dayType.key;
        const values = [];
        let sum = 0;
        for (const k of keys) {
          const hw = headway.get(routeId + SEP + k);
          const v = hw ? hw.get(dk) : undefined;
          if (v !== undefined && v !== null) values.push(v);
          const tc = trips.get(routeId + SEP + k);
          const n = tc ? tc.get(dk) : undefined;
          sum += n === undefined ? 0 : n;
        }
        perDay[dk] = values.length ? s1Median(values) : null;
        tripCounts[dk] = sum;
      }
      return {
        routeId,                                              // route_id
        shortName: route ? route.shortName : '',              // short_name
        longName: route ? route.longName : '',                // long_name
        routeType: route ? route.routeType : 3,               // route_type
        color: route ? route.color : '',                      // color
        directionId: (direction !== null && direction !== undefined && direction !== '')
          ? s1Int(direction, 0) : null,                       // direction_id
        perDay,                                               // per_day
        trips: tripCounts,                                    // trips
      };
    };

    if (split) {
      for (const direction of directions) rows.push(rowFor(direction, [direction]));
    } else {
      rows.push(rowFor(null, directions));
    }
  }

  const maxTrips = (r) => {
    const vals = Object.values(r.trips);
    return vals.length ? Math.max(...vals) : 0;
  };
  rows.sort((a, b) => (maxTrips(b) - maxTrips(a))
    || cmpStr(a.routeId, b.routeId)
    || ((a.directionId === null ? -1 : a.directionId)
      - (b.directionId === null ? -1 : b.directionId)));
  return rows;
}
