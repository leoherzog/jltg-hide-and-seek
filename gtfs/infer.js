/**
 * gtfs/infer.js — S1 · inference — hub, border, game size — and the
 * question-layer inputs.
 *
 * Port of `generate.py`. Worker side: no DOM, no clock, no
 * randomness. Everything here is pure over `(feed, days, zones, options)`.
 *
 * Five public entry points, in the order `build_report` calls them:
 *
 *   inferHub(feed, day, proj)                     → Hub
 *   inferGameSize(metrics, options)               → [GameSize, SizeInference]
 *   inferBorder(feed, day, hub, size, proj, opts) → Border
 *   gtfsQuestionFacts(feed, days, zones, stations)→ the GTFS-only question inputs
 *   travelTimeSamples(feed, days, zones, …)       → TravelSampleRow[]  (runs LAST;
 *                                                    see worker.js's reordering note)
 *
 * ── determinism ────────────────────────────────────────────────────────────────
 * Every `Map`/`Set`/plain object is sorted before it is iterated anywhere the
 * result can reach output. String order is code-point order (`cmpStr`), never
 * `localeCompare`. Numeric sorts always pass an explicit comparator.
 */

import {
  HUB_SNAP_M, HUB_RADIAL_MIN, HUB_SEMI_RADIAL_MIN,
  QUARTER_MILE_M, HALF_MILE_M, SQM_PER_SQMI, M_PER_MILE,
  DEFAULT_DEPARTURE, HEADWAY_WINDOW, SERVICE_DAY_SECONDS,
  coord, rhu, num, hmsToS, lowerMedian,
} from '../lib/core.js';
import {
  Projection, bboxOf, bboxExpand, minEnclosingCircle,
} from '../lib/geo.js';
import { s1Positions, s1Extras } from './service.js';
import { raptor, raptorReverse, buildJourney } from './raptor.js';
// `S1_SIZE_PARAMS` / `S1_SIZE_ORDER` / `s1AxisScores` live in `network.js` because
// `_s1_provisional_size` (which network_metrics needs) uses the same thresholds.
// One source of truth; re-exported here so a caller can reach them from either.
import {
  zoneCover, S1_SIZE_PARAMS, S1_SIZE_ORDER, s1AxisScores,
} from './network.js';

// ── logging ───────────────────────────────────────────────────────────────────
// `generate.py` logs through the stdlib `log`. In the worker there is no console
// worth writing to, so the sink is injectable and defaults to silence. The worker
// wires it to `postMessage({type:'log', …})`.

let LOG = { info() {}, warn() {} };

/**
 * Install the log sink used by this module. `sink.info(msg)` / `sink.warn(msg)`.
 * Passing null restores silence.
 * @param {{info:(m:string)=>void, warn:(m:string)=>void}|null} sink
 */
export function setInferLogger(sink) {
  LOG = sink && typeof sink.info === 'function' ? sink : { info() {}, warn() {} };
}

// ── private constants ─────────────────────────────────────────────────────────

/** Code-point string order — Python's. Never `localeCompare` (locale = non-determinism). */
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `route_type`s the rulebook would call "rail-ish". `_S1_RAIL_TYPES`. */
export const S1_RAIL_TYPES = Object.freeze([0, 1, 2, 5, 7, 11, 12]);

// ── small private helpers ─────────────────────────────────────────────────────

/** `n / d`, or 0.0 when the denominator is empty. Keeps every share finite. */
function s1Share(numerator, denominator) {
  return denominator ? (numerator / denominator) : 0.0;
}

/**
 * Median of a *measured distribution* — `statistics.median`, the mean of the two
 * middle values for even n. Deliberately **not** `lowerMedian`: that one is
 * reserved for the two places where a tie must resolve down to the quieter
 * option (representative-day choice and the game-size vote).
 */
function s1Median(values) {
  const s = Array.from(values).sort((a, b) => a - b);
  const n = s.length;
  if (!n) throw new RangeError('median of an empty sequence');
  const half = n >> 1;
  return (n % 2) ? s[half] : (s[half - 1] + s[half]) / 2;
}

/** Euclidean distance between two planar `[x, y]` points — Python's `math.dist`. */
function dist(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.hypot(dx, dy);
}

/**
 * Python's `len(str)` counts **code points**; JS `.length` counts UTF-16 code
 * units. Station names are the one place the difference reaches a number the
 * page prints, so count code points.
 */
function nameLen(name) {
  return Array.from(String(name === null || name === undefined ? '' : name)).length;
}

/**
 * Python's `max(seq, key=…)` — first maximal element wins, tuple keys compared
 * left to right. `keyFn` must return an array of comparable scalars.
 */
function maxBy(items, keyFn) {
  let best = null;
  let bestKey = null;
  for (const item of items) {
    const key = keyFn(item);
    if (best === null || cmpKey(key, bestKey) > 0) { best = item; bestKey = key; }
  }
  return best;
}

/** Lexicographic comparison of two tuple keys of scalars. */
function cmpKey(a, b) {
  for (let i = 0; i < a.length && i < b.length; i++) {
    const x = a[i];
    const y = b[i];
    if (typeof x === 'string' || typeof y === 'string') {
      const c = cmpStr(String(x), String(y));
      if (c) return c;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return a.length - b.length;
}

/** `Object.prototype.hasOwnProperty`, safe against null-prototype maps. */
function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

// ═══════════════════════════════════════════════════════════════════════════════
// S1 · inference — hub, border, game size — and the question-layer inputs
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Distinct trips of the day that call at `stopId` (loops counted once).
 * `_s1_trips_touching`, generate.py.
 * @param {object} day a `ServiceDay`
 * @param {string} stopId
 * @returns {number}
 */
function s1TripsTouching(day, stopId) {
  const index = day.stopIndex;
  const i = index.byId.get(stopId);
  if (i === undefined) return 0;
  const seen = new Set();
  for (const pattern of day.patterns) {
    if (pattern.stops.includes(i)) {
      for (const t of pattern.tripIds) seen.add(t);
    }
  }
  return seen.size;
}

/**
 * Infer the round-start station and classify the network's shape.
 *
 * Scores every served stop by `(distinct routes, stop events, stop_id)` and snaps
 * the winner to the busiest member of its `HUB_SNAP_M` cluster so a directional
 * pair does not split the score. `routeShare ≥ 0.50` ⇒ radial-hub, `≥ 0.25` ⇒
 * semi-radial, below ⇒ polycentric — and in the polycentric case `dominant` is
 * false and the pages must *not* name a single hub, using the min-enclosing-circle
 * centre as the map centre and the top three stops as start suggestions.
 *
 * @param {object} feed a `Feed`
 * @param {object} day  the best `ServiceDay`
 * @param {Projection|{lat0:number,lon0:number}} proj
 * @returns {object} a `Hub`
 */
export function inferHub(feed, day, proj) {
  const pos = s1Positions(feed, proj);
  const served = Array.from(day.servedStopIds);
  /** @type {Object<string, number>} */ const events = Object.create(null);
  /** @type {Object<string, number>} */ const routes = Object.create(null);
  for (const sid of served) {
    events[sid] = day.stopDays[sid].departures.length;
    routes[sid] = day.stopDays[sid].routes.length;
  }

  const ranked = served.slice().sort((a, b) => (
    (-routes[a]) - (-routes[b]) || (-events[a]) - (-events[b]) || cmpStr(a, b)
  ));
  let winner = ranked[0];

  // Snap to the busiest pole of the winner's cluster, but only among the members
  // that carry the cluster's full route count — snapping is there to resolve a
  // directional pair, and it must never *lower* the hub-dominance index.
  const near = served.filter((sid) => dist(pos[sid], pos[winner]) <= HUB_SNAP_M);
  let topRoutes = -Infinity;
  for (const sid of near) if (routes[sid] > topRoutes) topRoutes = routes[sid];
  let snapped = null;
  for (const sid of near) {
    if (routes[sid] !== topRoutes) continue;
    if (snapped === null
      || cmpKey([-events[sid], sid], [-events[snapped], snapped]) < 0) snapped = sid;
  }
  winner = snapped;

  const totalRoutes = Math.max(1, day.routeIds.length);
  const routeShare = routes[winner] / totalRoutes;
  const tripShare = s1Share(s1TripsTouching(day, winner), day.trips);

  let shape;
  if (routeShare >= HUB_RADIAL_MIN) shape = 'radial-hub';
  else if (routeShare >= HUB_SEMI_RADIAL_MIN) shape = 'semi-radial';
  else shape = 'polycentric';
  const dominant = routeShare >= HUB_SEMI_RADIAL_MIN;

  /** @type {Array<[string, string]>} */ const alternatives = [];
  const chosen = [winner];
  const wanted = dominant ? 2 : 3;
  for (const sid of ranked) {
    if (alternatives.length >= wanted) break;
    let tooClose = false;
    for (const other of chosen) {
      if (dist(pos[sid], pos[other]) <= HUB_SNAP_M) { tooClose = true; break; }
    }
    if (tooClose) continue;
    chosen.push(sid);
    alternatives.push([sid, feed.stops[sid].name]);
  }

  const stop = feed.stops[winner];
  LOG.info(`hub: ${winner} (${stop.name}), ${routes[winner]}/${totalRoutes} routes = `
    + `${num(routeShare, 3, { comma: false })}, trip share `
    + `${num(tripShare, 3, { comma: false })}, ${shape}`);
  return {
    stopId: winner,
    name: stop.name,
    lat: stop.lat,
    lon: stop.lon,
    routeShare,
    tripShare,
    shape,
    alternatives,
    dominant,
  };
}

/**
 * The padded box as a GeoJSON `Feature`. `_s1_bbox_geojson`.
 * @param {[number, number, number, number]} bbox `[S, W, N, E]`
 * @returns {object}
 */
function s1BboxGeojson(bbox) {
  const s = coord(bbox[0]);
  const w = coord(bbox[1]);
  const n = coord(bbox[2]);
  const e = coord(bbox[3]);
  const ring = [[w, s], [e, s], [e, n], [w, n], [w, s]];
  return {
    type: 'Feature',
    properties: { kind: 'bbox' },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

/**
 * A 96-gon approximating the border circle. `_s1_circle_geojson`.
 * @param {number} lat @param {number} lon @param {number} radiusM
 * @returns {object}
 */
function s1CircleGeojson(lat, lon, radiusM) {
  const steps = 96;
  const ring = [];
  for (let k = 0; k <= steps; k++) {
    const theta = 2 * Math.PI * (k % steps) / steps;
    const dlat = (radiusM * Math.cos(theta)) / 111132.0;
    const dlon = (radiusM * Math.sin(theta))
      / (111320.0 * Math.max(0.05, Math.cos(lat * Math.PI / 180)));
    ring.push([coord(lon + dlon), coord(lat + dlat)]);
  }
  return {
    type: 'Feature',
    properties: { kind: 'circle' },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

/**
 * Derive the map border: the padded bbox of in-map stops, plus the circle.
 *
 * In-map means reachable from the hub within `3 × hidingPeriod` *and* able to
 * reach the hub within the same (forward and reverse RAPTOR). This travel-time
 * criterion replaces a geometric outlier trim on purpose: trimming the farthest
 * 0.5% of stops on the reference feed shrinks the enclosing circle 20% and the
 * stops it deletes are the airport and the university campus — all excellent game
 * locations. Padding is one zone radius, so every legal zone lies wholly inside.
 *
 * `options.borderBbox` overrides the derivation entirely; `options.borderShape ===
 * 'circle'` only changes which shape is presented as canonical.
 *
 * @param {object} feed @param {object} day @param {object} hub @param {object} size
 * @param {Projection|{lat0:number,lon0:number}} projLike
 * @param {object} options an `Options`
 * @returns {object} a `Border`
 */
export function inferBorder(feed, day, hub, size, projLike, options) {
  const proj = Projection.from(projLike);
  const opts = options || {};
  const pos = s1Positions(feed, proj);
  const served = Array.from(day.servedStopIds);
  const excluded = new Set(opts.excludeStops || []);
  if (opts.excludeRoutes && opts.excludeRoutes.length) {
    const blocked = new Set(opts.excludeRoutes);
    for (const sid of served) {
      const rs = day.stopDays[sid].routes;
      let subset = true;
      for (const r of rs) if (!blocked.has(r)) { subset = false; break; }
      if (subset) excluded.add(sid);
    }
  }

  // Python's `or` chain: `hms_to_s('00:00:00')` is 0, which is falsy, so a
  // midnight departure falls through to the default. Kept.
  const depart = hmsToS(opts.departure) || hmsToS(DEFAULT_DEPARTURE) || 32400;
  const budget = 3 * size.hidingPeriodMin * 60;
  const forward = raptor(day, [hub.stopId], depart);
  const backward = raptorReverse(day, [hub.stopId], depart + budget);

  let allowed = served.filter((sid) => !excluded.has(sid));
  if (!allowed.length) allowed = served.slice();
  const reachable = allowed.filter((sid) => has(forward.arrivalS, sid)
    && forward.arrivalS[sid] - depart <= budget);
  let inMap = reachable.filter((sid) => has(backward, sid) && backward[sid] >= depart);

  // The travel-time criterion is a scalpel for a genuine outlier, not a way to
  // redraw the map. On a one-way or weakly connected network the round-trip test
  // can delete most of the system; if it does, fall back rather than print a border
  // that excludes the city. The reachability metrics report the problem instead.
  if (inMap.length < 0.5 * allowed.length) {
    LOG.warn(`border: the there-and-back test kept only ${inMap.length} of `
      + `${allowed.length} stops; falling back to one-way reachability`);
    inMap = reachable;
  }
  if (inMap.length < 0.5 * allowed.length) {
    LOG.warn(`border: one-way reachability kept only ${inMap.length} of `
      + `${allowed.length} stops; using every served stop`);
    inMap = allowed;
  }
  // `len(set(served) - set(in_map))` — only the count is used, so the difference is
  // counted rather than materialised and sorted.
  const inMapSet = new Set(inMap);
  let trimmedCount = 0;
  for (const sid of new Set(served)) if (!inMapSet.has(sid)) trimmedCount++;
  if (trimmedCount) {
    LOG.info(`border: ${trimmedCount} of ${served.length} served stops are outside `
      + `the ${Math.floor(budget / 60)}-minute reach of the hub`);
  }

  const inMapSorted = Array.from(new Set(inMap)).sort(cmpStr);
  const latLon = inMapSorted.map((sid) => [feed.stops[sid].lat, feed.stops[sid].lon]);
  let raw = bboxOf(latLon);
  let pad = Number(size.zoneRadiusM);
  let padded;

  if (opts.borderBbox) {
    raw = Array.from(opts.borderBbox);
    padded = Array.from(opts.borderBbox);
    pad = 0.0;
  } else {
    padded = bboxExpand(raw, pad);
  }

  const mec = minEnclosingCircle(inMapSorted.map((sid) => pos[sid]));
  const clonlat = proj.lonlat(mec[0], mec[1]);
  const circle = [clonlat[1], clonlat[0], mec[2] + pad];

  const sw = proj.xy(padded[0], padded[1]);
  const ne = proj.xy(padded[2], padded[3]);
  const bboxArea = Math.abs(ne[0] - sw[0]) * Math.abs(ne[1] - sw[1]);

  const kind = opts.borderShape === 'circle' ? 'circle' : 'bbox';
  let geojson;
  let area;
  if (kind === 'circle') {
    geojson = s1CircleGeojson(circle[0], circle[1], circle[2]);
    area = Math.PI * circle[2] * circle[2];
  } else {
    geojson = s1BboxGeojson(padded);
    area = bboxArea;
  }

  return {
    kind,
    bbox: padded.map(coord),
    circle: [coord(circle[0]), coord(circle[1]), circle[2]],
    padM: pad,
    geojson,
    areaSqM: area,
  };
}

/**
 * Vote on the game size across four axes and resolve the rulebook parameters.
 *
 * Axes (each scored 0=small / 1=medium / 2=large): convex-hull area of served stops
 * (<100 / 100–1000 / >1000 sq mi), distinct ¼-mile zones (<100 / 100–500 / >500),
 * T90 traversal time (≤45 / 45–180 / >180 min), straight-line diameter (<15 / 15–60
 * / >60 mi). Combine with `floor(median(scores))` so ties round **down** to the
 * smaller game, then clamp to within one step of the area axis.
 *
 * Validated against all eight of the rulebook's own examples, including the one
 * genuinely marginal case (Winston-Salem), which the round-down tie-break puts on
 * the correct side. `options.sizeOverride` / `hidingPeriodMin` / `zoneRadiusM`
 * override, and a non-unanimous vote must be reported as borderline on the page
 * rather than hidden.
 *
 * @param {object} metrics the `networkMetrics()` table
 * @param {object} options an `Options`
 * @returns {[object, object]} `[GameSize, SizeInference]`
 */
export function inferGameSize(metrics, options) {
  const opts = options || {};
  const m = metrics || {};
  const areaSqMi = Number(m.hullSqM || 0.0) / SQM_PER_SQMI;
  const nZones = Math.trunc(Number(m.nZones || 0));
  const t90 = Number(m.t90Min || 0.0) || 0.0;
  const diameterMi = Number(m.diameterM || 0.0) / M_PER_MILE;
  const votes = s1AxisScores(areaSqMi, nZones, t90, diameterMi);

  const rawVerdict = Math.trunc(Math.floor(lowerMedian(votes.slice())));
  let clampedVerdict = Math.max(votes[0] - 1, Math.min(votes[0] + 1, rawVerdict));
  clampedVerdict = Math.max(0, Math.min(2, clampedVerdict));
  const clamped = clampedVerdict !== rawVerdict;
  const verdict = S1_SIZE_ORDER[clampedVerdict];

  const axes = [
    {
      id: 'A', name: 'Convex-hull area', value: rhu(areaSqMi, 1), unit: 'sq mi',
      score: votes[0], thresholds: [100, 1000],
    },
    {
      id: 'B', name: 'Distinct hiding zones', value: nZones, unit: 'zones',
      score: votes[1], thresholds: [100, 500],
    },
    {
      id: 'C', name: 'T90 traversal time', value: rhu(t90, 1), unit: 'min',
      score: votes[2], thresholds: [45, 180],
    },
    {
      id: 'D', name: 'Straight-line diameter', value: rhu(diameterMi, 2), unit: 'mi',
      score: votes[3], thresholds: [15, 60],
    },
  ];
  const unanimous = new Set(votes).size === 1;
  let note;
  if (unanimous) {
    note = 'All four axes agree.';
  } else {
    const disagree = axes.map((a) => `${a.id}=${S1_SIZE_ORDER[a.score]}`).join(', ');
    note = `Axes disagree (${disagree}); the median rounds down to the smaller game.`;
  }
  if (clamped) note += ' The vote was kept within one step of the area axis.';

  const forced = opts.sizeOverride !== null && opts.sizeOverride !== undefined;
  const name = forced ? opts.sizeOverride : verdict;
  if (forced) note += ` Overridden to ${name}.`;

  const params = Object.assign({}, S1_SIZE_PARAMS[name]);
  if (opts.hidingPeriodMin !== null && opts.hidingPeriodMin !== undefined) {
    params.hidingPeriodMin = Math.trunc(opts.hidingPeriodMin);
  }
  if (opts.zoneRadiusM !== null && opts.zoneRadiusM !== undefined) {
    params.zoneRadiusM = Number(opts.zoneRadiusM);
  }

  const size = {
    name,
    hidingPeriodMin: Math.trunc(params.hidingPeriodMin),
    zoneRadiusM: Number(params.zoneRadiusM),
    tentacleReachMi: Number(params.tentacleReachMi),
    thermometerMi: Array.from(params.thermometerMi),
    categoryCount: Math.trunc(params.categoryCount),
    catalogueSize: Math.trunc(params.catalogueSize),
    photoLimitMin: Math.trunc(params.photoLimitMin),
    otherLimitMin: Math.trunc(params.otherLimitMin),
    moveGrantMin: Math.trunc(params.moveGrantMin),
    requiredHours: Number(params.requiredHours),
    inferred: !forced,
  };
  const inference = {
    axes, votes: Array.from(votes), verdict, unanimous, clamped, note,
  };
  LOG.info(`game size: ${name} (axes ${votes.join(', ')})${forced ? ' [forced]' : ''}`);
  return [size, inference];
}

/**
 * Recover the radius a zone set was built at, from the zones themselves.
 *
 * Every member stop lies inside its centre's circle, so the largest centre-to-member
 * distance is a lower bound on the radius; snap that up to the rulebook radius that
 * contains it. Needed because `travelTimeSamples` is handed zones, not a radius.
 *
 * `_s1_zone_radius`, generate.py.
 * @param {object[]} zones `Zone` records
 * @returns {number} metres
 */
function s1ZoneRadius(zones) {
  let widest = 0.0;
  /** @type {Map<string, object>} */ const byId = new Map();
  for (const z of zones) byId.set(z.zoneId, z);
  for (const zone of zones) {
    for (const sid of zone.stopIds) {
      // NOTE (kept from the Python): this looks a member *stop* id up in a map of
      // *zone* ids, so only members that are themselves zone centres widen the
      // bound. That is the reference behaviour and the bound is still valid.
      const other = byId.get(sid);
      if (other !== undefined) {
        widest = Math.max(widest, dist([zone.x, zone.y], [other.x, other.y]));
      }
    }
  }

  // No two centres are within one radius of each other (that is what the greedy
  // cover guarantees), so the true radius is in [widest, closest_pair).
  let closest = Infinity;
  const points = zones.map((z) => [z.x, z.y]).sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  /** @type {Map<string, Array<[number, number]>>} */ const grid = new Map();
  const cell = Math.max(1.0, QUARTER_MILE_M);
  for (const [x, y] of points) {
    const key = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    let bucket = grid.get(key);
    if (bucket === undefined) { bucket = []; grid.set(key, bucket); }
    bucket.push([x, y]);
  }
  for (const [x, y] of points) {
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const bucket = grid.get(`${gx + dx},${gy + dy}`);
        if (bucket === undefined) continue;
        for (const other of bucket) {
          // Python compares tuples by value: an exactly coincident centre is
          // skipped, not counted as a zero-distance pair.
          if (other[0] === x && other[1] === y) continue;
          const d = dist([x, y], other);
          if (d < closest) closest = d;
        }
      }
    }
  }

  for (const candidate of [HALF_MILE_M, QUARTER_MILE_M]) {
    if (widest <= candidate && candidate < closest) return candidate;
  }
  return Math.max(widest, QUARTER_MILE_M);
}

/**
 * A deterministic destination sample for the ride-time chart.
 *
 * Re-runs the zone cover at `3 × zoneRadius` to get well-spread destinations, takes
 * the `count` highest-`stopEvents` picks, and reports travel time and transfers from
 * `originStopId` **on every day type**, so the chart can re-render when the reader
 * switches days. Rows are sorted by travel time on the best day; a destination with
 * no service that day carries `minutes: null`, which the chart draws hollow-dashed
 * rather than omitting.
 *
 * @param {object} feed @param {object[]} days @param {object[]} zones
 * @param {string} originStopId @param {number} departureS
 * @param {Projection|{lat0:number,lon0:number}} proj  (unused; kept for call-site parity)
 * @param {number} [count=14]
 * @returns {object[]} `TravelSampleRow[]`
 */
export function travelTimeSamples(feed, days, zones, originStopId, departureS, proj, count = 14) {
  if (!zones || !zones.length || !days || !days.length) return [];
  const radius = s1ZoneRadius(zones);
  /** @type {Map<string, object>} */ const byId = new Map();
  /** @type {Object<string, [number, number]>} */ const pos = Object.create(null);
  /** @type {Object<string, number>} */ const events = Object.create(null);
  for (const z of zones) {
    byId.set(z.zoneId, z);
    pos[z.zoneId] = [z.x, z.y];
    events[z.zoneId] = z.stopEvents;
  }

  const wanted = Math.max(1, Math.trunc(count));
  const zoneIds = Object.keys(pos).sort(cmpStr);
  const spread = zoneCover(zoneIds, 3.0 * radius, events, pos)
    // a 0-minute bar for the start is noise
    .filter((zid) => zid !== originStopId);
  const picks = spread.slice()
    .sort((a, b) => ((-events[a]) - (-events[b])) || cmpStr(a, b))
    .slice(0, wanted);
  if (picks.length < wanted) {
    // A small network can collapse to a handful of well-spread picks; top the
    // chart up with the busiest remaining zones rather than draw three bars.
    const chosen = new Set(picks);
    const byBusy = zoneIds.slice()
      .sort((a, b) => ((-events[a]) - (-events[b])) || cmpStr(a, b));
    for (const zid of byBusy) {
      if (picks.length >= wanted) break;
      if (zid !== originStopId && !chosen.has(zid)) {
        picks.push(zid);
        chosen.add(zid);
      }
    }
  }

  const bestKey = maxBy(days, (d) => [d.trips, d.dayType.key]).dayType.key;
  /** @type {Map<string, object|null>} */ const runs = new Map();
  for (const day of days) {
    const origin = has(day.stopDays, originStopId) ? originStopId : null;
    runs.set(day.dayType.key, origin ? raptor(day, [origin], departureS) : null);
  }

  const rows = [];
  for (const zid of picks.slice().sort(cmpStr)) {
    const zone = byId.get(zid);
    /** @type {Object<string, object>} */ const perDay = Object.create(null);
    for (const day of days) {
      const key = day.dayType.key;
      const run = runs.get(key);
      const entry = { minutes: null, transfers: null, routes: [] };
      if (run !== null && run !== undefined && has(run.arrivalS, zid)) {
        const journey = buildJourney(day, run, zid);
        entry.minutes = rhu((run.arrivalS[zid] - departureS) / 60.0, 1);
        entry.transfers = run.rounds[zid];
        const routeSet = new Set();
        for (const leg of journey.legs) {
          if (leg.mode === 'transit' && leg.routeId) routeSet.add(leg.routeId);
        }
        entry.routes = Array.from(routeSet).sort(cmpStr);
      }
      perDay[key] = entry;
    }
    rows.push({
      stopId: zid,
      zoneId: zid,
      name: zone.name,
      lat: coord(zone.lat),
      lon: coord(zone.lon),
      stopEvents: zone.stopEvents,
      perDay,
    });
  }

  const sortKey = (r) => {
    const cell = has(r.perDay, bestKey) ? r.perDay[bestKey] : {};
    const minutes = cell && cell.minutes !== undefined ? cell.minutes : null;
    return [minutes === null ? 1 : 0, minutes || 0.0, r.stopId];
  };
  rows.sort((a, b) => cmpKey(sortKey(a), sortKey(b)));
  return rows;
}

/**
 * The GTFS-only inputs the question layer needs, in one bundle.
 *
 * Keys: `has_rail` (any `route_type` in the rail-ish set — a pure-GTFS
 * determination that kills four questions on a bus-only feed), `routes`,
 * `routes_by_zone`, `station_name_lengths`, `metro_route_ids`, and `u_turn` (the
 * fraction of stops with ≥2 routes and the median wait for a *different* route
 * inside the U-Turn card's 0.5/0.5/1-hour window — that curse is decided by GTFS,
 * not OSM).
 *
 * The key names are **snake_case, exactly as in the Python**: the question audit
 * looks these up by name and this bundle is a lookup table, not a typed record.
 *
 * @param {object} feed @param {object[]} days @param {object[]} zones @param {object[]} stations
 * @returns {Object<string, *>}
 */
export function gtfsQuestionFacts(feed, days, zones, stations) {
  const best = (days && days.length) ? maxBy(days, (d) => [d.trips, d.dayType.key]) : null;
  const routeIdsSorted = Object.keys(feed.routes).sort(cmpStr);

  const railIds = routeIdsSorted.filter((rid) => S1_RAIL_TYPES.includes(feed.routes[rid].routeType));

  const zonesSorted = zones.slice().sort((a, b) => cmpStr(a.zoneId, b.zoneId));
  /** @type {Object<string, string[]>} */ const routesByZone = Object.create(null);
  /** @type {Object<string, number>} */ const nameLengths = Object.create(null);
  for (const z of zonesSorted) {
    routesByZone[z.zoneId] = Array.from(z.routeIds);
    nameLengths[z.zoneId] = nameLen(z.name);
  }

  // ── Curse of the U-Turn: is there a second line to escape onto, and how long
  //    would you wait for it? ────────────────────────────────────────────────
  let multiShare = 0.0;
  /** @type {number[]} */ const waits = [];
  if (best !== null) {
    const extras = s1Extras(best);
    const served = Array.from(best.servedStopIds);
    const multi = served.filter((sid) => best.stopDays[sid].routes.length >= 2);
    multiShare = s1Share(multi.length, served.length);
    const lo = hmsToS(HEADWAY_WINDOW[0]) || 0;
    const hi = hmsToS(HEADWAY_WINDOW[1]) || SERVICE_DAY_SECONDS;

    // `extras.routeDirStop` is already the Python's `sorted(...items())`; bucket it
    // by stop so the per-stop scan is O(entries) rather than O(stops × entries).
    // Bucket order is the array's order, which is the sorted order.
    /** @type {Map<string, Array<[string, number[]]>>} */ const rdsByStop = new Map();
    for (const [[routeId, , stopId], values] of extras.routeDirStop) {
      let bucket = rdsByStop.get(stopId);
      if (bucket === undefined) { bucket = []; rdsByStop.set(stopId, bucket); }
      bucket.push([routeId, values]);
    }

    for (const sid of multi) {
      /** @type {Array<[number, string]>} */ const evts = [];
      for (const [routeId, values] of (rdsByStop.get(sid) || [])) {
        for (const v of values) if (lo <= v && v <= hi) evts.push([v, routeId]);
      }
      evts.sort((a, b) => (a[0] - b[0]) || cmpStr(a[1], b[1]));
      const gaps = [];
      for (let i = 0; i < evts.length; i++) {
        const t = evts[i][0];
        const routeId = evts[i][1];
        for (let j = i + 1; j < evts.length; j++) {
          if (evts[j][1] !== routeId) { gaps.push((evts[j][0] - t) / 60.0); break; }
        }
      }
      if (gaps.length) {
        waits.push(s1Median(gaps));
      }
    }
  }

  const uTurn = {
    multi_route_stop_share: multiShare,
    median_wait_other_route_min: waits.length ? s1Median(waits) : null,
  };

  /** @type {Object<string, object>} */ const routesOut = Object.create(null);
  for (const rid of routeIdsSorted) {
    const r = feed.routes[rid];
    routesOut[rid] = {
      label: r.label,
      short_name: r.shortName,
      long_name: r.longName,
      route_type: r.routeType,
      is_rail: r.isRail,
    };
  }

  return {
    has_rail: Boolean(railIds.length),
    metro_route_ids: railIds,
    routes_by_zone: routesByZone,
    station_name_lengths: nameLengths,
    u_turn: uTurn,
    routes: routesOut,
  };
}
