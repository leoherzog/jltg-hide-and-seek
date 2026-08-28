/**
 * gtfs/infer.js — S1 · inference — hub, border, game size — and the
 * question-layer inputs.
 *
 * Port of `generate.py`. Worker side: no DOM, no clock, no
 * randomness. Everything here is pure over `(feed, days, zones, options)`.
 *
 * Five public entry points, in the order `build_report` calls them:
 *
 *   inferHub(feed, day, proj, inPlay)             → Hub
 *   inferGameSize(metrics, options)               → [GameSize, SizeInference]
 *   inferBorder(feed, day, hub, size, proj, opts, inPlay) → Border
 *   gtfsQuestionFacts(feed, days, zones, stations)→ the GTFS-only question inputs
 *   travelTimeSamples(days, zones, …)             → TravelSampleRow[]  (runs LAST;
 *                                                    see worker.js's reordering note)
 *
 * Plus two helpers the map's reach layer added on 2026-08-23, which share the RAPTOR
 * passes `travelTimeSamples` was already making:
 *
 *   dayRaptorRuns(days, originStopId, departureS) → Map<dayKey, run|null>
 *   zoneReachMinutes(days, zones, runs, …)        → ZoneReach
 *
 * And the in-play set (2026-08-27, CONTRACT.md §(b) Metrics "Stop set"), which
 * is what makes `Options.borderBbox` / `excludeStops` / `excludeRoutes` honest —
 * before it they trimmed the border rectangle and nothing else:
 *
 *   excludedStopSet(feed, day, opts)              → Set<stopId>
 *   inPlayStopIds(feed, day, opts)                → {ids, fallback}
 *   hubRun(feed, day, originId, departS)          → the memoised RAPTOR run
 *
 * And the suggested border (same date, CONTRACT.md §(b) SuggestedBorder), which
 * the worker computes after `inferBorder` and only ever OFFERS — applying it is
 * the reader's cached second run, never this module's decision:
 *
 *   suggestBorder(feed, days, best, hub, proj, opts, size, inPlay, events)
 *                                                 → SuggestedBorder | null
 *
 * `inPlay` is an optional trailing parameter everywhere it is threaded, and
 * `null` means "every served stop, exactly as before" — the worker passes null
 * whenever no override narrows the set, so a plain run's memo keys, sample
 * strides and iteration orders are literally the pre-2026-08-27 ones. The
 * smoke goldens rest on that.
 *
 * ── determinism ────────────────────────────────────────────────────────────────
 * Every `Map`/`Set`/plain object is sorted before it is iterated anywhere the
 * result can reach output. String order is code-point order (`cmpStr`), never
 * `localeCompare`. Numeric sorts always pass an explicit comparator.
 */

import {
  HUB_SNAP_M, HUB_RADIAL_MIN, HUB_SEMI_RADIAL_MIN,
  QUARTER_MILE_M, HALF_MILE_M, SQM_PER_SQMI, M_PER_MILE,
  DEFAULT_DEPARTURE, HEADWAY_WINDOW, SERVICE_DAY_SECONDS, IN_PLAY_MIN_SHARE,
  SUGGEST_MIN_TRIM_SHARE, SUGGEST_MIN_EVENT_SHARE, SUGGEST_MIN_CORE_STOPS,
  SUGGEST_MIN_CORE_SHARE,
  cmpStr, coord, rhu, num, hmsToS, lowerMedian,
} from '../lib/core.js';
import {
  Projection, bboxOf, bboxExpand, bboxContains, minEnclosingCircle,
} from '../lib/geo.js';
import { s1Cache, s1Median, s1Share } from './feed.js';
import { busiestDay, s1Positions, s1Extras } from './service.js';
import { raptor, raptorReverse, buildJourney } from './raptor.js';
// `S1_SIZE_PARAMS` / `S1_SIZE_ORDER` / `s1AxisScores` live in `network.js` because
// `_s1_provisional_size` (which network_metrics needs) uses the same thresholds.
// One source of truth; re-exported here so a caller can reach them from either.
// `networkMetrics` is what `suggestBorder` votes each candidate core with; the
// module cycle this closes (network.js imports `hubRun` from here) is function-only
// on both sides and resolves under ESM hoisting. Do not add a top-level use.
import {
  zoneCover, networkMetrics, S1_SIZE_PARAMS, S1_SIZE_ORDER, s1AxisScores,
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

/** `route_type`s the rulebook would call "rail-ish". `_S1_RAIL_TYPES`. */
export const S1_RAIL_TYPES = Object.freeze([0, 1, 2, 5, 7, 11, 12]);

// ── small private helpers ─────────────────────────────────────────────────────

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
 * The stops an `Options` object excludes outright: `excludeStops` verbatim, plus
 * every served stop whose routes are ALL in `excludeRoutes` (a stop that keeps
 * one live route stays — excluding a route is not excluding its shared poles).
 *
 * Lifted from `inferBorder`, which used to be the only reader of the two lists
 * and now shares the set with `inPlayStopIds` so the border and the metrics can
 * never disagree about which stops an exclusion removes.
 *
 * @param {object} feed a `Feed` (unused today; kept so a future route-level
 *   rule has the feed without a signature change)
 * @param {object} day a `ServiceDay`
 * @param {object} opts an `Options`
 * @returns {Set<string>}
 */
export function excludedStopSet(feed, day, opts) {
  const o = opts || {};
  const excluded = new Set(o.excludeStops || []);
  if (o.excludeRoutes && o.excludeRoutes.length) {
    const blocked = new Set(o.excludeRoutes);
    for (const sid of day.servedStopIds) {
      const rs = day.stopDays[sid].routes;
      let subset = true;
      for (const r of rs) if (!blocked.has(r)) { subset = false; break; }
      if (subset) excluded.add(sid);
    }
  }
  return excluded;
}

/**
 * The in-play stop set: the day's served stops inside `opts.borderBbox` (when one
 * is given) minus `excludedStopSet`. Everything measured — hub candidates, the
 * metric table, the size vote, zones, the stop table and the border trim — runs
 * over this set, so a box the reader drew on the landing map is the game, not a
 * decoration on it.
 *
 * FILTERS `servedStopIds`, never re-sorts it: `buildServiceDay` sorts that array
 * with `cmpStr` once, `s1DayMetrics`' T90 origin sample is a fixed stride over it,
 * and a subset produced any other way would shift which stops the stride lands on.
 *
 * The 50 % floor (`IN_PLAY_MIN_SHARE`) mirrors `inferBorder`'s own fallbacks: a box
 * that keeps under half the system has missed the city, and the honest answer is
 * to measure the whole system and say so (`Metrics.inPlayFallback`) rather than
 * print a report about a suburb.
 *
 * @param {object} feed a `Feed`
 * @param {object} day the best `ServiceDay`
 * @param {object} opts an `Options`
 * @returns {{ids: string[], fallback: boolean}} `ids` in `servedStopIds` order
 */
export function inPlayStopIds(feed, day, opts) {
  const o = opts || {};
  const served = day.servedStopIds;
  const excluded = excludedStopSet(feed, day, o);
  const box = o.borderBbox || null;
  const ids = served.filter((sid) => {
    if (excluded.has(sid)) return false;
    if (!box) return true;
    const stop = feed.stops[sid];
    return bboxContains(box, stop.lat, stop.lon);
  });
  if (ids.length < IN_PLAY_MIN_SHARE * served.length) {
    LOG.warn(`in-play: the border and exclusions kept only ${ids.length} of `
      + `${served.length} served stops; using every served stop`);
    return { ids: served.slice(), fallback: true };
  }
  return { ids, fallback: false };
}

/**
 * One forward RAPTOR run from `originId` at `departS` on `day`, memoised on the
 * feed. `inferBorder`, `s1DayMetrics` (network.js) and `suggestBorder` all want
 * exactly this run from the hub at the default departure, and the memo means the
 * three share one object rather than recomputing it — the SAME object, so nothing
 * numeric can move; callers must therefore treat the result as read-only.
 *
 * @param {object} feed a `Feed` @param {object} day a `ServiceDay`
 * @param {string} originId @param {number} departS
 * @returns {{arrivalS: Object<string, number>}} the `raptor` result
 */
export function hubRun(feed, day, originId, departS) {
  return s1Cache(feed, `raptor:${day.dayType.key}:${originId}:${departS}`,
    () => raptor(day, [originId], departS));
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
 * With an in-play set the candidates (and the snap cluster and the alternatives)
 * are restricted to it, so a hub outside the reader's box is never named; an empty
 * restriction falls back to every served stop rather than to no hub at all.
 *
 * @param {object} feed a `Feed`
 * @param {object} day  the best `ServiceDay`
 * @param {Projection|{lat0:number,lon0:number}} proj
 * @param {string[]|null} [inPlay] the in-play set, or null for every served stop
 * @returns {object} a `Hub`
 */
export function inferHub(feed, day, proj, inPlay = null) {
  const pos = s1Positions(feed, proj);
  const restricted = inPlay ? inPlay.filter((sid) => has(day.stopDays, sid)) : [];
  const served = restricted.length ? restricted : Array.from(day.servedStopIds);
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
 * `options.borderBbox` overrides the derivation entirely (`derivation: 'option'`,
 * no padding, `rawBbox === bbox`); `options.borderShape === 'circle'` only changes
 * which shape is presented as canonical. `trimmedStopIds` names the in-play stops
 * the reach test dropped, after the two fallbacks — the list §05 explains the
 * border with, and the one `suggestBorder` attributes to feeds.
 *
 * @param {object} feed @param {object} day @param {object} hub @param {object} size
 * @param {Projection|{lat0:number,lon0:number}} projLike
 * @param {object} options an `Options`
 * @param {string[]|null} [inPlay] the in-play set, or null for every served stop
 * @returns {object} a `Border`
 */
export function inferBorder(feed, day, hub, size, projLike, options, inPlay = null) {
  const proj = Projection.from(projLike);
  const opts = options || {};
  const pos = s1Positions(feed, proj);
  const served = inPlay ? Array.from(inPlay) : Array.from(day.servedStopIds);
  // Already applied inside an in-play set, and a no-op on it then; kept so a
  // null `inPlay` behaves exactly as it did before the set existed.
  const excluded = excludedStopSet(feed, day, opts);

  // Python's `or` chain: `hms_to_s('00:00:00')` is 0, which is falsy, so a
  // midnight departure falls through to the default. Kept.
  const depart = hmsToS(opts.departure) || hmsToS(DEFAULT_DEPARTURE) || 32400;
  const budget = 3 * size.hidingPeriodMin * 60;
  const forward = hubRun(feed, day, hub.stopId, depart);
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
  // `allowed − inMap`: the stops the reach test (after its fallbacks) left outside.
  const trimmedStopIds = Array.from(new Set(allowed.filter((sid) => !inMapSet.has(sid))))
    .sort(cmpStr);
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
    rawBbox: raw.map(coord),
    circle: [coord(circle[0]), coord(circle[1]), circle[2]],
    padM: pad,
    geojson,
    areaSqM: area,
    trimmedStopIds,
    derivation: opts.borderBbox ? 'option' : 'reach',
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
 * Offer a tighter, reachability-aware game border — or nothing.
 *
 * The inferred border (`inferBorder`) keeps every stop the hub can reach there
 * and back within three hiding periods, which on a metro-plus-commuter-rail merge
 * is the whole region: Chicago + Pace measures LARGE because the outer Metra and
 * Pace stops stretch the hull, though the game most readers mean to play is the
 * CTA core. This asks a narrower question: is there a size `s` whose one-way
 * hiding-period core — the stops reachable from the run origin within
 * `S1_SIZE_PARAMS[s].hidingPeriodMin`, the SAME rule `zoneReachMinutes` colours
 * the map with — measures as an `s`-sized game when everything is re-measured on
 * those stops alone? The smallest such `s` is the suggestion.
 *
 * What it costs: the memoised hub run (`hubRun`, already made) plus at most three
 * `networkMetrics` passes, one per candidate core. Because the hiding periods are
 * 30 < 60 < 180 min, `core(small) ⊆ core(medium) ⊆ core(large)`, and the memo key
 * carries the set's hash so two candidates with the same core pay once.
 *
 * What it refuses to do (`null`):
 *   * when the reader has already decided — `opts.sizeOverride` or
 *     `opts.borderBbox` set — a suggestion would be second-guessing them;
 *   * when the origin sees no departure on the best day (no run to read);
 *   * when the core at the voted size trims under `SUGGEST_MIN_TRIM_SHARE` of the
 *     in-play stops — the whole-feed border is close enough to say nothing;
 *   * when no candidate is self-consistent: a core is `degenerate` under
 *     `max(SUGGEST_MIN_CORE_STOPS, SUGGEST_MIN_CORE_SHARE × |inPlay|)` stops,
 *     `sparse` under `SUGGEST_MIN_EVENT_SHARE` of the day's departures (weighted by
 *     departures so a ring of one-bus stops cannot veto a dense core), and
 *     `outvoted` when `inferGameSize` on its metrics names a different size.
 *
 * What it does NOT refuse: a core that votes the run's own size. That is a tighter
 * box for the SAME game — the trim-share gate above has already established it is at
 * least `SUGGEST_MIN_TRIM_SHARE` smaller — and it is worth offering. The renderer,
 * not this function, is the place that must not print "a MEDIUM game rather than
 * MEDIUM". (The spec's second emission guard was dead code; see the note at the
 * acceptance below.)
 *
 * Every candidate is recorded in `candidatesTried` in the order tried, so the
 * page can say why nothing was offered. All iteration is over cmpStr-sorted
 * arrays produced by FILTERING `inPlay` — never re-sorted, for the same T90
 * stride reason `inPlayStopIds` gives — and nothing reads a clock.
 *
 * @param {object} feed a `Feed`
 * @param {object[]} days every `ServiceDay` (the metric passes are per day)
 * @param {object} best the busiest `ServiceDay`
 * @param {object} hub the run's `Hub`
 * @param {Projection|{lat0:number,lon0:number}} proj
 * @param {object} opts an `Options`
 * @param {object} size the `GameSize` the in-play metrics voted
 * @param {string[]|null} inPlay the in-play set, or null for every served stop
 * @param {Object<string, number>} events `stopId → departures on the best day`
 * @returns {object|null} a `SuggestedBorder` (CONTRACT.md §(b)), or null
 */
export function suggestBorder(feed, days, best, hub, proj, opts, size, inPlay, events) {
  const o = opts || {};
  if (o.sizeOverride !== null && o.sizeOverride !== undefined) return null;
  if (o.borderBbox) return null;

  const origin = o.startStopId || hub.stopId;
  if (!has(best.stopDays, origin)) return null;
  // The same `or` chain as `inferBorder`: a literal midnight falls through.
  const depart = hmsToS(o.departure) || hmsToS(DEFAULT_DEPARTURE) || 32400;

  // Already in `servedStopIds` order when threaded; re-filtered against the day so
  // a caller handing in a stale set cannot index a missing `stopDays` row.
  const pool = (inPlay ? inPlay : best.servedStopIds).filter((sid) => has(best.stopDays, sid));
  if (!pool.length) return null;
  const run = hubRun(feed, best, origin, depart);

  const eventsOf = (sid) => {
    if (events && has(events, sid)) return Number(events[sid]) || 0;
    return best.stopDays[sid].departures.length;
  };
  let totalEvents = 0;
  for (const sid of pool) totalEvents += eventsOf(sid);

  /** The one-way hiding-period core at size `s`. A filter, so `pool` order holds. */
  const core = (s) => {
    const budget = 60 * S1_SIZE_PARAMS[s].hidingPeriodMin;
    return pool.filter((sid) => has(run.arrivalS, sid) && run.arrivalS[sid] - depart <= budget);
  };
  const trimShareOf = (kept) => (pool.length - kept.length) / pool.length;

  // Gate: at the voted size the core must trim enough to be worth a sentence.
  const stopAt = S1_SIZE_ORDER.indexOf(size.name);
  if (stopAt < 0) return null;
  const votedCore = core(size.name);
  if (trimShareOf(votedCore) < SUGGEST_MIN_TRIM_SHARE) {
    LOG.info(`suggest: the ${size.name} core keeps ${votedCore.length} of ${pool.length} `
      + 'in-play stops; nothing to offer');
    return null;
  }

  const floor = Math.max(SUGGEST_MIN_CORE_STOPS, SUGGEST_MIN_CORE_SHARE * pool.length);
  /** @type {Array<{sizeName:string, keptStops:number, eventShare:number, vote:string|null, reason:string}>} */
  const candidatesTried = [];
  let accepted = null;
  let acceptedCore = null;
  let acceptedMetrics = null;
  let acceptedVotes = null;
  for (let i = 0; i <= stopAt; i++) {
    const s = S1_SIZE_ORDER[i];
    const c = core(s);
    let coreEvents = 0;
    for (const sid of c) coreEvents += eventsOf(sid);
    const eventShare = totalEvents > 0 ? coreEvents / totalEvents : 0;
    const row = { sizeName: s, keptStops: c.length, eventShare, vote: null, reason: '' };
    candidatesTried.push(row);
    if (c.length < floor) { row.reason = 'degenerate'; continue; }
    if (eventShare < SUGGEST_MIN_EVENT_SHARE) { row.reason = 'sparse'; continue; }
    LOG.info(`suggest: measuring the ${s} core, ${c.length} of ${pool.length} in-play stops`);
    const m = networkMetrics(feed, days, proj, hub, QUARTER_MILE_M, c);
    const [voted, inference] = inferGameSize(m, { ...o, sizeOverride: null });
    row.vote = voted.name;
    if (voted.name !== s) { row.reason = 'outvoted'; continue; }
    row.reason = 'accepted';
    accepted = s;
    acceptedCore = c;
    acceptedMetrics = m;
    acceptedVotes = inference.votes;
    break;
  }
  if (accepted === null) {
    LOG.info(`suggest: no self-consistent core (${candidatesTried
      .map((r) => `${r.sizeName}:${r.reason}`).join(', ')})`);
    return null;
  }
  // No emission guard here, deliberately (2026-08-27). The spec's guard was "emit only
  // if the accepted size differs OR the trim share is at least SUGGEST_MIN_TRIM_SHARE",
  // which is dead code as written: when the search accepts `s === size.name`,
  // `acceptedCore` IS the `votedCore` the gate above already measured, and that gate
  // returned null unless its trim share cleared the same threshold. So a same-size
  // suggestion always cleared it and always shipped — correctly, because "the same
  // size on a box under half the area" is a real offer. It is the SENTENCE that has to
  // know: `s4SuggestCallout` (render/map.js) has a same-size branch, because
  // "a MEDIUM game rather than MEDIUM" is what the comparison degenerates to.

  const params = S1_SIZE_PARAMS[accepted];
  const coreSet = new Set(acceptedCore);
  const trimmedStopIds = pool.filter((sid) => !coreSet.has(sid)).sort(cmpStr);
  const latLon = acceptedCore.map((sid) => [feed.stops[sid].lat, feed.stops[sid].lon]);
  const rawBbox = bboxOf(latLon);
  const padM = Number(params.zoneRadiusM);
  const bbox = bboxExpand(rawBbox, padM);
  const p = Projection.from(proj);
  const sw = p.xy(bbox[0], bbox[1]);
  const ne = p.xy(bbox[2], bbox[3]);
  const areaSqM = Math.abs(ne[0] - sw[0]) * Math.abs(ne[1] - sw[1]);

  // Which feeds the trimmed stops belong to. Merged ids are `f<k>:` namespaced
  // (gtfs/merge.js) and `feed.sources[k].tag` names the prefix; a single feed's
  // ids are bare and all of it is feed 0.
  const sources = Array.isArray(feed.sources) ? feed.sources : [];
  /** @type {Map<string, number>} */ const tagIndex = new Map();
  if (sources.length > 1) sources.forEach((row, i) => tagIndex.set(String(row.tag), i));
  /** @type {Map<number, number>} */ const perFeed = new Map();
  for (const sid of trimmedStopIds) {
    const colon = sid.indexOf(':');
    const tag = colon > 0 ? sid.slice(0, colon) : '';
    const idx = tagIndex.has(tag) ? tagIndex.get(tag) : 0;
    perFeed.set(idx, (perFeed.get(idx) || 0) + 1);
  }
  const trimmedByFeed = Array.from(perFeed, ([feedIndex, count]) => ({
    feedIndex,
    agencyName: String((sources[feedIndex] && sources[feedIndex].agencyName) || feed.agencyName || ''),
    count,
  })).sort((a, b) => (b.count - a.count) || (a.feedIndex - b.feedIndex));

  const acceptedRow = candidatesTried[candidatesTried.length - 1];
  LOG.info(`suggest: ${accepted} core keeps ${acceptedCore.length} of ${pool.length} in-play `
    + `stops (${num(acceptedRow.eventShare * 100, 1, { comma: false })}% of departures); `
    + `the run measured ${size.name}`);
  return {
    kind: 'bbox',
    bbox: bbox.map(coord),
    rawBbox: rawBbox.map(coord),
    padM,
    geojson: s1BboxGeojson(bbox),
    areaSqM,
    sizeName: accepted,
    hidingPeriodMin: Math.trunc(params.hidingPeriodMin),
    originStopId: origin,
    departureS: depart,
    dayKey: best.dayType.key,
    coreStops: acceptedCore.length,
    allServedStops: best.servedStopIds.length,
    trimmedStops: trimmedStopIds.length,
    eventShare: acceptedRow.eventShare,
    trimmedStopIds,
    trimmedByFeed,
    vote: {
      axes: Array.from(acceptedVotes),
      hullSqM: Number(acceptedMetrics.hullSqM || 0),
      t90Min: Number(acceptedMetrics.t90Min || 0),
      nZones: Math.trunc(Number(acceptedMetrics.nZones || 0)),
      diameterM: Number(acceptedMetrics.diameterM || 0),
    },
    candidatesTried,
    definition: 'one_way_from_origin_within_hiding_period',
  };
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
 * One RAPTOR run per service day, from the round-start station.
 *
 * Lifted out of `travelTimeSamples`, which built exactly this Map and then threw
 * everything away but fourteen picks. `zoneReachMinutes` wants the same runs for
 * every zone, so the loop moved here and both callers are handed the one result:
 * the map's reach layer costs zero extra RAPTOR passes. A day whose `stopDays` has
 * no row for the origin gets `null` — there is no journey to model from a stop that
 * sees no departure. (Extracted 2026-08-23 for the map's reach layer.)
 *
 * @param {object[]} days @param {string} originStopId @param {number} departureS
 * @returns {Map<string, object|null>} `dayType.key` → run
 */
export function dayRaptorRuns(days, originStopId, departureS) {
  /** @type {Map<string, object|null>} */ const runs = new Map();
  for (const day of days || []) {
    const origin = has(day.stopDays, originStopId) ? originStopId : null;
    runs.set(day.dayType.key, origin ? raptor(day, [origin], departureS) : null);
  }
  return runs;
}

/**
 * Travel minutes from the round-start station to **every** hiding zone, per day.
 *
 * The same runs `travelTimeSamples` uses — same origin, same departure — so
 * `perDay[bestDay].minutes[z]` is `rhu(ZoneScore.metrics.R1.raw × hidingPeriodMin, 1)`
 * by construction and the map can never disagree with the hider's dossier.
 *
 * The counts are computed here rather than left to the page because a renderer may
 * count and filter but may not do arithmetic on a measured quantity: `reachableZones`
 * is a subtraction and `unreachableZoneIds` is a comparison against the hiding period.
 *
 * @param {object[]} days @param {object[]} zones
 * @param {Map<string, object|null>} runs from `dayRaptorRuns`
 * @param {string} originStopId @param {number} departureS @param {number} hidingPeriodMin
 * @returns {object} `ZoneReach` (CONTRACT.md §(b))
 */
export function zoneReachMinutes(days, zones, runs, originStopId, departureS, hidingPeriodMin) {
  const zoneIds = Array.from(zones || [], (z) => z.zoneId).sort(cmpStr);
  /** @type {Object<string, object>} */ const perDay = Object.create(null);
  const keys = Array.from(days || [], (d) => d.dayType.key).sort(cmpStr);
  for (const key of keys) {
    const run = runs && runs.get(key) ? runs.get(key) : null;
    /** @type {Object<string, number|null>} */ const minutes = Object.create(null);
    /** @type {string[]} */ const unreachable = [];
    let furthestZoneId = null;
    let furthestMinutes = null;
    // `zoneIds` is sorted, so `unreachable` comes out sorted and a tie for furthest
    // is broken by the smaller zone id. No second sort, and no set iteration.
    for (const zid of zoneIds) {
      const value = (run !== null && has(run.arrivalS, zid))
        ? rhu((run.arrivalS[zid] - departureS) / 60.0, 1)
        : null;
      minutes[zid] = value;
      if (value === null || value > hidingPeriodMin) unreachable.push(zid);
      if (value !== null && (furthestMinutes === null || value > furthestMinutes)) {
        furthestMinutes = value;
        furthestZoneId = zid;
      }
    }
    perDay[key] = {
      minutes,
      unreachableZoneIds: unreachable,
      reachableZones: zoneIds.length - unreachable.length,
      furthestZoneId,
      furthestMinutes,
    };
  }
  return { originStopId, departureS, hidingPeriodMin, perDay };
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
 * @param {object[]} days @param {object[]} zones
 * @param {string} originStopId @param {number} departureS
 * @param {number} count how many destinations to chart
 * @param {Map<string, object|null>} runs `dayRaptorRuns` output, shared with
 *   `zoneReachMinutes` so the RAPTOR passes happen once per run
 * @returns {object[]} `TravelSampleRow[]`
 */
export function travelTimeSamples(days, zones, originStopId, departureS, count, runs) {
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

  const bestKey = busiestDay(days).dayType.key;

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
  const best = (days && days.length) ? busiestDay(days) : null;
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
