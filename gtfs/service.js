/**
 * S1 · the service day and the RAPTOR structures.
 *
 * Port of `generate.py` (derived caches, calendar, day-type grouping, the service
 * day, `cluster_stations`). Nothing here reads a clock, a locale or the DOM.
 *
 * `ServiceDay.patterns / patternAtStop / footpaths / stopIndex` are S1-private
 * (contract.md §3.2). Shapes:
 *
 *   stopIndex        {byId: Map<stop_id, i>, ids: [stop_id, …]}   — ids is sorted
 *   patterns         [_S1Pattern, …]  — column-major so the board lookup is a bisect
 *   patternAtStop    CSR over stop index → (patternIndex, offset) pairs, sorted
 *   footpaths        CSR over stop index → (otherIndex, seconds) pairs, sorted
 *
 * `day.extras` carries the per-day analysis vectors shared by several callers.
 *
 * The CSR structures replace the Python's tuple-of-tuples: RAPTOR runs several
 * times per report over thousands of stops, and an `Int32Array` triple is ~40×
 * cheaper to walk than an array of pairs. Layout:
 *
 *   patternAtStop = {ptr: Int32Array(n+1), pat: Int32Array(m), off: Int32Array(m)}
 *   footpaths     = {ptr: Int32Array(n+1), to:  Int32Array(m), w:   Int32Array(m)}
 *
 * so the edges of stop `i` are the slice `[ptr[i], ptr[i + 1])`.
 *
 * @module gtfs/service.js
 */

import {
  BOARD_SLACK_S,
  FREQUENT_HEADWAY_MIN,
  HEADWAY_WINDOW,
  SERVICE_DAY_SECONDS,
  STATION_CLUSTER_M,
  WALK_CIRCUITY,
  WALK_RADIUS_M,
  WALK_SPEED_MPS,
  cmpStr,
  dateRange,
  dowOf,
  hmsToS,
  lowerMedian,
} from '../lib/core.js';
import { GridIndex, Projection } from '../lib/geo.js';
import { s1Cache, s1Int, s1Median, stopTimesOf, tripRows } from './feed.js';

// ── private constants (generate.py) ──────────────────────────

const S1_DOW_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday',
  'saturday', 'sunday'];
const S1_DOW_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
  'Saturday', 'Sunday'];

/**
 * Tuple keys are joined with U+0000, below every legal GTFS id character, so sorting
 * the joined strings reproduces Python's tuple ordering, prefix case included.
 */
const SEP = '\u0000';

/** Lexicographic comparator over two arrays of strings (Python's `sorted(list_of_lists)`). */
function cmpStrList(a, b) {
  const k = Math.min(a.length, b.length);
  for (let i = 0; i < k; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

function pushTo(map, key, value) {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
}

// ── small private helpers (generate.py) ──────────────────────

/**
 * Consecutive differences of an already-sorted, de-duplicated departure vector.
 * @param {number[]} times
 * @returns {number[]}
 */
export function s1Gaps(times) {
  const out = [];
  for (let i = 1; i < times.length; i++) out.push(times[i] - times[i - 1]);
  return out;
}

/**
 * One departure per trip (the first), sorted. Without this a loop terminus reports
 * a fake 0-minute headway.
 * @param {Array<[string, number]>} pairs
 * @returns {number[]}
 */
export function s1Dedupe(pairs) {
  const seen = new Map();
  for (const [tripId, t] of pairs) {
    const prev = seen.get(tripId);
    if (prev === undefined || t < prev) seen.set(tripId, t);
  }
  return Array.from(seen.values()).sort((a, b) => a - b);
}

/**
 * The busiest day of a run — `max(days, key=(trips, day_type.key))`, so a tie on
 * trips is broken by the LARGER day key. Every headline number describes this day,
 * so the rule is written once. `days` must be non-empty; each caller guards first.
 *
 * @param {object[]} days non-empty `ServiceDay`s; only `trips` and `dayType.key` are read
 * @returns {object} the winning element of `days`
 */
export function busiestDay(days) {
  let best = days[0];
  for (const d of days) {
    if (d.trips > best.trips
      || (d.trips === best.trips && cmpStr(d.dayType.key, best.dayType.key) > 0)) best = d;
  }
  return best;
}

// ── per-feed derived caches ─────────────────────────────────────────────────
// The one worker-side memo is `s1Cache(feed, key, build)` in `gtfs/feed.js`
// (non-enumerable, never reaches `structuredClone`, dropped by `s1Invalidate`).
// Everything derived from a Feed goes through it, so a key means one thing.

/**
 * `service_id → trips rows`.
 * @param {object} feed
 * @returns {Map<string, object[]>}
 */
export function s1TripsByService(feed) {
  return s1Cache(feed, 'trips_by_service', () => {
    const out = new Map();
    for (const trip of feed.tables.trips || []) {
      pushTo(out, (trip.service_id || '').trim(), trip);
    }
    return out;
  });
}

/**
 * `[calendar rows, Map<date, [[service_id, exception_type], …]>]` — built once.
 * @param {object} feed
 * @returns {[object[], Map<string, Array<[string, string]>>]}
 */
export function s1CalendarIndex(feed) {
  return s1Cache(feed, 'calendar_index', () => {
    const cal = (feed.tables.calendar || []).filter((r) => (r.service_id || '').trim());
    const exc = new Map();
    for (const row of feed.tables.calendar_dates || []) {
      const date = (row.date || '').trim();
      const sid = (row.service_id || '').trim();
      if (date && sid) pushTo(exc, date, [sid, (row.exception_type || '1').trim()]);
    }
    for (const list of exc.values()) {
      list.sort((a, b) => cmpStr(a[0], b[0]) || cmpStr(a[1], b[1]));
    }
    return [cal, exc];
  });
}

/**
 * The set of `service_id`s running on `date`, as a **sorted array**.
 *
 * `calendar.txt` weekday bitmasks within the row's date range, then `calendar_dates`
 * exceptions (type 1 adds, type 2 removes). A `calendar_dates`-only feed signals a
 * no-service day by absence, so an empty result is meaningful, not an error.
 * @param {object} feed @param {string} date 'YYYYMMDD'
 * @returns {string[]} sorted
 */
export function activeServices(feed, date) {
  const [cal, exc] = s1CalendarIndex(feed);
  const dow = S1_DOW_NAMES[dowOf(date)];
  const out = new Set();
  for (const row of cal) {
    if ((row.start_date || '') <= date && date <= (row.end_date || '')
      && (row[dow] || '0') === '1') {
      out.add((row.service_id || '').trim());
    }
  }
  for (const [sid, kind] of exc.get(date) || []) {
    if (kind === '1') out.add(sid);
    else out.delete(sid);
  }
  return Array.from(out).sort(cmpStr);
}

/**
 * `[[date, active service ids (sorted), trip count], …]` for every serviced date,
 * ascending.
 * @param {object} feed @param {string} start @param {string} end
 * @returns {Array<[string, string[], number]>}
 */
export function s1DateProfiles(feed, start, end) {
  return s1Cache(feed, `date_profiles:${start}:${end}`, () => {
    const perService = new Map();
    for (const [sid, rows] of s1TripsByService(feed)) perService.set(sid, rows.length);
    const out = [];
    for (const date of dateRange(start, end)) {
      const services = activeServices(feed, date);
      if (!services.length) continue;
      let count = 0;
      for (const s of services) count += perService.get(s) || 0;
      if (count === 0) continue;   // a service_id with no trips is not a service day
      out.push([date, services, count]);
    }
    return out;
  });
}

/**
 * Pick the representative date of a group: lower-median trip count, then the
 * **middle** date among the ones tied at that count.
 *
 * Lower median so a busy/quiet tie resolves to the quiet pattern, or the page
 * promises service it does not have. The middle tied date avoids landing on a
 * partial first week.
 * @param {Array<[string, string[], number]>} dates
 * @returns {[string, string[], number]}
 */
function s1Representative(dates) {
  const counts = dates.map((d) => d[2]);
  const target = Math.trunc(lowerMedian(counts));
  const tied = dates.filter((d) => d[2] === target).map((d) => d[0]).sort(cmpStr);
  const date = tied[Math.floor(tied.length / 2)];
  const hit = dates.find((d) => d[0] === date);
  return [date, hit[1], target];
}

/**
 * Group the validity window into distinguishable service-day types.
 *
 * Per day-of-week, list every date with a non-empty active-service set, count trips,
 * and pick the **lower median** date as representative. Mon–Fri merge into one
 * 'weekday' type when they run similar amounts of service. Returned in calendar
 * order (weekday, Saturday, Sunday, …). The reference feed has two Sunday patterns
 * whose spans differ by 3½ hours, so "the first Sunday" would flip a headline fact.
 * @param {object} feed @param {string} start @param {string} end
 * @returns {import('./service.js').DayType[]}
 */
export function dayTypes(feed, start, end) {
  const profiles = s1DateProfiles(feed, start, end);
  if (!profiles.length) {
    throw new RangeError("no date in the feed's validity window has any service");
  }

  /** @type {Map<number, Array<[string, string[], number]>>} */
  const byDow = new Map();
  for (const [date, services, count] of profiles) {
    pushTo(byDow, dowOf(date), [date, services, count]);
  }

  // Conventional buckets first; a bucket only splits when its member weekdays run
  // genuinely different amounts of service (school-term Tuesdays must not split
  // Mon–Fri, but a Friday-only night network must not be averaged into it).
  /** @type {Array<[string, string, number[]]>} */
  const groups = [];
  const weekdayDows = Array.from(byDow.keys()).filter((d) => d <= 4).sort((a, b) => a - b);
  if (weekdayDows.length) {
    const medians = weekdayDows.map((d) => Math.trunc(lowerMedian(byDow.get(d).map((r) => r[2]))));
    const lo = Math.min(...medians);
    const hi = Math.max(...medians);
    if (lo > 0 && hi / lo <= 1.5 && weekdayDows.length > 1) {
      groups.push(['weekday', 'Weekday', weekdayDows]);
    } else {
      for (const d of weekdayDows) groups.push([`dow${d}`, S1_DOW_LABELS[d], [d]]);
    }
  }
  if (byDow.has(5)) groups.push(['saturday', 'Saturday', [5]]);
  if (byDow.has(6)) groups.push(['sunday', 'Sunday', [6]]);

  const out = [];
  for (const [key, label, dows] of groups) {
    const member = [];
    for (const dow of dows) member.push(...byDow.get(dow));
    member.sort((a, b) => cmpStr(a[0], b[0]));
    const [date, services, trips] = s1Representative(member);
    out.push({
      key,
      label,
      date,
      dates: member.map((r) => r[0]),
      serviceIds: Array.from(services).sort(cmpStr),
      trips,
      tripCounts: member.map((r) => r[2]),
    });
  }

  const rank = { weekday: 0, saturday: 5, sunday: 6 };
  out.sort((a, b) => {
    const ra = rank[a.key] !== undefined ? rank[a.key] : s1Int(a.key.slice(3), 9);
    const rb = rank[b.key] !== undefined ? rank[b.key] : s1Int(b.key.slice(3), 9);
    return ra - rb || cmpStr(a.key, b.key);
  });
  return out;
}

/**
 * Return `[noServiceDates, reducedServiceDates]` inside the window.
 *
 * A date is no-service when `activeServices` is empty. It is reduced-service when
 * its trip count is below 80% of the representative day for its weekday. Both feed
 * the `D3 full_service_date_share` metric and catch school-term-only feeds.
 * @param {object} feed @param {string} start @param {string} end
 * @returns {[string[], string[]]}
 */
export function noServiceDates(feed, start, end) {
  const profiles = s1DateProfiles(feed, start, end);
  const served = new Set(profiles.map((p) => p[0]));
  const dead = dateRange(start, end).filter((d) => !served.has(d));

  /** @type {Map<number, number[]>} */
  const byDow = new Map();
  for (const [date, , count] of profiles) pushTo(byDow, dowOf(date), count);
  const reference = new Map();
  for (const dow of Array.from(byDow.keys()).sort((a, b) => a - b)) {
    reference.set(dow, Math.trunc(lowerMedian(byDow.get(dow))));
  }

  const reduced = profiles
    .filter(([d, , c]) => c < 0.8 * reference.get(dowOf(d)))
    .map(([d]) => d)
    .sort(cmpStr);
  return [dead, reduced];
}

// ═══════════════════════════════════════════════════════════════════════════════
// S1 · the service day and the RAPTOR structures
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} S1StopIndex   // `_S1StopIndex`, generate.py.
 * Bidirectional stop_id ↔ dense-index map over the whole feed's stops.
 * @property {Map<string, number>} byId
 * @property {string[]} ids        // sorted
 */

/**
 * @typedef {Object} S1Pattern     // `_S1Pattern`, generate.py.
 * Trips sharing an identical stop sequence, stored column-major.
 *
 * `dep[offset]` and `arr[offset]` are per-trip vectors in trip order (sorted by
 * departure at the pattern's first stop), which makes "earliest trip at this
 * offset departing at or after t" a plain bisect when the pattern does not
 * overtake itself.
 * @property {Int32Array} stops           // stop indices
 * @property {Int32Array[]} dep           // dep[offset][trip]
 * @property {Int32Array[]} arr           // arr[offset][trip]
 * @property {string[]} tripIds
 * @property {string[]} tripRoutes        // per trip: two routes can share a stop sequence
 * @property {string} routeId
 * @property {string} directionId
 * @property {boolean} sortedCols         // false ⇒ this pattern overtakes; scan linearly
 */

/**
 * @typedef {Object} S1DayExtras   // `_S1DayExtras`, generate.py.
 * Per-day vectors shared by the metrics, headway and question layers.
 * @property {Object<string, [string, string]>} tripRoute   // trip_id → [route_id, direction_id]
 * @property {Object<string, number[]>} dedup               // stop_id → one departure per trip
 * @property {Array<[[string, string, string], number[]]>} routeDirStop
 *   Sorted array of `[[routeId, directionId, stopId], departures]` — the Python's
 *   3-tuple-keyed dict, iterated `sorted(...)`.
 * @property {Object<string, string[]>} stopRoutes
 * @property {Object<string, string>} stopName              // stop_id → display name
 * @property {Object<string, string>} routeLabel            // route_id → Route.label
 */

/**
 * The per-day analysis vectors hung off a `ServiceDay`.
 * @param {object} day @returns {S1DayExtras}
 */
export function s1Extras(day) { return day.extras; }

/**
 * Bidirectional stop_id ↔ dense-index map over the whole feed's stops.
 * @param {object} feed @returns {S1StopIndex}
 */
export function s1StopIndex(feed) {
  return s1Cache(feed, 'stop_index', () => {
    const ids = Object.keys(feed.stops).sort(cmpStr);
    const byId = new Map();
    for (let i = 0; i < ids.length; i++) byId.set(ids[i], i);
    return { byId, ids };
  });
}

/**
 * `stop_id → [x, y]` metres in the shared projection, built once per feed.
 * @param {object} feed @param {Projection|{lat0:number,lon0:number}} projLike
 * @returns {Object<string, [number, number]>}
 */
export function s1Positions(feed, projLike) {
  const proj = Projection.from(projLike);
  const key = `pos:${proj.lat0.toFixed(9)}:${proj.lon0.toFixed(9)}`;
  return s1Cache(feed, key, () => {
    const out = Object.create(null);
    for (const sid of Object.keys(feed.stops).sort(cmpStr)) {
      const st = feed.stops[sid];
      out[sid] = proj.xy(st.lat, st.lon);
    }
    return out;
  });
}

/**
 * Geometric transfer graph: every stop pair within `WALK_RADIUS_M`.
 *
 * Weight is `straight_line × WALK_CIRCUITY ÷ WALK_SPEED_MPS`. `transfers.txt`
 * overrides: `transfer_type=3` deletes the edge, `2` raises its weight to at least
 * `min_transfer_time`, and a listed pair is added even beyond the walk radius.
 * Symmetric and day-independent, so built once per feed.
 *
 * Returned as CSR (see the module header), edges sorted by `(to, w)`.
 * @param {object} feed @param {Projection|{lat0:number,lon0:number}} projLike
 * @returns {{ptr: Int32Array, to: Int32Array, w: Int32Array}}
 */
export function s1Footpaths(feed, projLike) {
  const proj = Projection.from(projLike);
  const key = `foot:${proj.lat0.toFixed(9)}:${proj.lon0.toFixed(9)}`;

  return s1Cache(feed, key, () => {
    const index = s1StopIndex(feed);
    const pos = s1Positions(feed, proj);
    const n = index.ids.length;

    /** @type {Map<string, [string, number]>} `${a}\0${b}` → [transfer_type, min_transfer_time] */
    const rules = new Map();
    for (const row of feed.tables.transfers || []) {
      const a = (row.from_stop_id || '').trim();
      const b = (row.to_stop_id || '').trim();
      if (!a || !b || a === b) continue;
      rules.set(a + SEP + b,
        [(row.transfer_type || '0').trim(), s1Int(row.min_transfer_time, 0)]);
    }

    const grid = new GridIndex(WALK_RADIUS_M);
    for (const sid of index.ids) {
      const p = pos[sid];
      grid.add(sid, p[0], p[1]);
    }

    /** @type {Array<Array<[number, number]>>} */
    const edges = new Array(n);
    for (let i = 0; i < n; i++) edges[i] = [];

    for (const sid of index.ids) {
      const p = pos[sid];
      const x = p[0];
      const y = p[1];
      const i = index.byId.get(sid);
      for (const item of grid.near(x, y, WALK_RADIUS_M)) {
        const other = item[0];
        if (other === sid) continue;
        const d = Math.hypot(x - item[1], y - item[2]);
        if (d > WALK_RADIUS_M) continue;
        const rule = rules.get(sid + SEP + other);
        if (rule && rule[0] === '3') continue;
        let w = Math.trunc(d * WALK_CIRCUITY / WALK_SPEED_MPS);
        if (rule && rule[0] === '2') w = Math.max(w, rule[1]);
        edges[i].push([index.byId.get(other), w]);
      }
    }

    for (const composite of Array.from(rules.keys()).sort(cmpStr)) {
      const [kind, minimum] = rules.get(composite);
      const cut = composite.indexOf(SEP);
      const a = composite.slice(0, cut);
      const b = composite.slice(cut + 1);
      if (kind === '3' || !index.byId.has(a) || !index.byId.has(b)) continue;
      const i = index.byId.get(a);
      const j = index.byId.get(b);
      let already = false;
      for (const e of edges[i]) { if (e[0] === j) { already = true; break; } }
      if (already) continue;
      const pa = pos[a];
      const pb = pos[b];
      const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
      edges[i].push([j, Math.max(Math.trunc(d * WALK_CIRCUITY / WALK_SPEED_MPS), minimum)]);
    }

    // `tuple(tuple(sorted(set(e))) for e in edges)` — dedupe, then sort by (to, w).
    const ptr = new Int32Array(n + 1);
    const rows = new Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const seen = new Set();
      const uniq = [];
      for (const e of edges[i]) {
        const k = `${e[0]}|${e[1]}`;
        if (seen.has(k)) continue;
        seen.add(k);
        uniq.push(e);
      }
      uniq.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      rows[i] = uniq;
      total += uniq.length;
      ptr[i + 1] = total;
    }
    const to = new Int32Array(total);
    const w = new Int32Array(total);
    let at = 0;
    for (let i = 0; i < n; i++) {
      for (const e of rows[i]) { to[at] = e[0]; w[at] = e[1]; at++; }
    }
    return { ptr, to, w };
  });
}

/**
 * `stop_id → the shortest median headway any single route-direction achieves there`,
 * over the `HEADWAY_WINDOW` slice of `routeDirStop`.
 *
 * One route-direction at a time (gtfs.md §1.9): two unrelated half-hourly routes do
 * not make a 15-minute stop. Fewer than two departures in the window is no headway,
 * so the stop stays absent rather than present with a fake value.
 *
 * `buildServiceDay`'s `frequent` (`FREQUENT_HEADWAY_MIN`) and `s1DayMetrics`'
 * `within30` cut the same measurement at different thresholds on purpose. Do not
 * reconcile them.
 *
 * @param {Array<[[string, string, string], number[]]>} routeDirStop `day.extras.routeDirStop`
 * @returns {Map<string, number>} seconds
 */
export function s1BestDirGaps(routeDirStop) {
  const lo = hmsToS(HEADWAY_WINDOW[0]) || 0;
  const hi = hmsToS(HEADWAY_WINDOW[1]) || SERVICE_DAY_SECONDS;
  /** @type {Map<string, number>} */
  const best = new Map();
  for (const [[, , sid], values] of routeDirStop) {
    const inside = values.filter((v) => lo <= v && v <= hi);
    if (inside.length < 2) continue;
    const gap = s1Median(s1Gaps(inside));
    const prev = best.get(sid);
    if (prev === undefined || gap < prev) best.set(sid, gap);
  }
  return best;
}

/**
 * Materialise one service day, including the RAPTOR structures.
 *
 * Builds per-stop departure vectors, routes, headways and the frequent flag; RAPTOR
 * patterns (trips sharing a stop sequence, sorted by first departure); and the
 * footpath graph (`s1Footpaths`). Checks once that trips within a pattern do not
 * overtake; if any do, the earliest-trip lookup falls back to a linear scan.
 *
 * @param {object} feed
 * @param {object} day  a `DayType`
 * @param {Projection|{lat0:number,lon0:number}} projLike
 * @param {{boardSlackS?: number}} [opts]
 * @returns {object} a `ServiceDay`
 */
export function buildServiceDay(feed, day, projLike, opts = {}) {
  const boardSlackS = opts.boardSlackS === undefined ? BOARD_SLACK_S : opts.boardSlackS;
  const proj = Projection.from(projLike);
  const index = s1StopIndex(feed);
  const st = stopTimesOf(feed);
  const byTrip = tripRows(feed);
  const services = new Set(day.serviceIds);

  /** @type {Map<string, [string, string]>} */
  const tripRoute = new Map();
  for (const trip of feed.tables.trips || []) {
    if (services.has((trip.service_id || '').trim())) {
      tripRoute.set((trip.trip_id || '').trim(),
        [(trip.route_id || '').trim(), (trip.direction_id || '').trim()]);
    }
  }

  // ── one ordered pass over the day's stop_times ────────────────────────────
  // Straight off the columnar store: rows come sorted by int(stop_sequence) with
  // integer seconds. `stopId` still gets `.trim()`: a feed with padded stop ids
  // matches its `stops` table only after it.
  /** @type {Map<string, number[]>} */          const departures = new Map();
  /** @type {Map<string, Array<[string, number]>>} */ const tripDeps = new Map();
  /** @type {Map<string, Set<string>>} */       const stopRoutes = new Map();
  /** @type {Map<string, Array<[string, number]>>} */ const rds = new Map();
  /** @type {Map<string, Array<[number, string]>>} */ const patternBucket = new Map();
  /** @type {Map<string, Array<[number, number]>>} */ const patternTimes = new Map();
  let stopEvents = 0;

  const orderedTripIds = Array.from(tripRoute.keys()).sort(cmpStr);
  for (const tripId of orderedTripIds) {
    const rows = byTrip.get(tripId);
    if (!rows || !rows.length) continue;
    const [routeId, direction] = tripRoute.get(tripId);
    const seqStops = [];
    const seqTimes = [];
    for (const r of rows) {
      const sid = (st.stopId(r) || '').trim();
      if (!index.byId.has(sid)) continue;
      let arr = st.arrival(r);
      let dep = st.departure(r);
      if (arr === null && dep === null) continue;
      if (arr === null) arr = dep;
      if (dep === null) dep = arr;
      seqStops.push(sid);
      seqTimes.push([arr, dep]);
      stopEvents++;
      pushTo(departures, sid, dep);
      pushTo(tripDeps, sid, [tripId, dep]);
      let rset = stopRoutes.get(sid);
      if (rset === undefined) { rset = new Set(); stopRoutes.set(sid, rset); }
      rset.add(routeId);
      pushTo(rds, routeId + SEP + direction + SEP + sid, [tripId, dep]);
    }
    if (seqStops.length < 2) continue;
    pushTo(patternBucket, seqStops.join(SEP), [seqTimes[0][1], tripId]);
    patternTimes.set(tripId, seqTimes);
  }

  const served = Array.from(departures.keys()).sort(cmpStr);
  if (!served.length) {
    throw new RangeError(`service day ${day.key} (${day.date}) has no departures`);
  }

  // ── per-stop facts ────────────────────────────────────────────────────────
  // one departure per (trip, stop) per route-direction (gtfs.md §1.9); a loop
  // terminus otherwise reports a fake 0-minute headway
  const rdsKeys = Array.from(rds.keys()).sort(cmpStr);
  /** @type {Array<[[string, string, string], number[]]>} */
  const rdsClean = [];
  for (const composite of rdsKeys) {
    const parts = composite.split(SEP);
    rdsClean.push([[parts[0], parts[1], parts[2]], s1Dedupe(rds.get(composite))]);
  }

  const loW = hmsToS(HEADWAY_WINDOW[0]) || 0;
  const hiW = hmsToS(HEADWAY_WINDOW[1]) || SERVICE_DAY_SECONDS;

  const bestDirGap = s1BestDirGaps(rdsClean);

  const stopDays = Object.create(null);
  const dedupAll = Object.create(null);
  for (const sid of served) {
    const every = departures.get(sid).slice().sort((a, b) => a - b);
    const deduped = s1Dedupe(tripDeps.get(sid));
    dedupAll[sid] = deduped;
    const inside = deduped.filter((t) => loW <= t && t <= hiW);
    const gaps = inside.length >= 2 ? s1Gaps(inside) : [];
    let worst = null;
    if (gaps.length) { worst = gaps[0]; for (const g of gaps) if (g > worst) worst = g; }
    const dirGap = bestDirGap.get(sid);
    stopDays[sid] = {
      stopId: sid,
      departures: every,
      routes: Array.from(stopRoutes.get(sid)).sort(cmpStr),
      first: every[0],
      last: every[every.length - 1],
      medianHeadwayS: gaps.length ? s1Median(gaps) : null,
      worstGapS: gaps.length ? worst : null,
      frequent: (dirGap === undefined ? Infinity : dirGap) <= FREQUENT_HEADWAY_MIN * 60,
    };
  }

  // ── RAPTOR patterns ───────────────────────────────────────────────────────
  /** @type {S1Pattern[]} */
  const patterns = [];
  /** @type {Array<Array<[number, number]>>} */
  const atStop = new Array(index.ids.length);
  for (let i = 0; i < atStop.length; i++) atStop[i] = [];

  for (const key of Array.from(patternBucket.keys()).sort(cmpStr)) {
    const trips = patternBucket.get(key).slice()
      .sort((a, b) => a[0] - b[0] || cmpStr(a[1], b[1]));
    const ids = trips.map((t) => t[1]);
    const stopKeys = key.split(SEP);
    const nOff = stopKeys.length;
    const nTrips = ids.length;
    const times = ids.map((t) => patternTimes.get(t));
    const colsDep = new Array(nOff);
    const colsArr = new Array(nOff);
    let ordered = true;
    for (let off = 0; off < nOff; off++) {
      const depCol = new Int32Array(nTrips);
      const arrCol = new Int32Array(nTrips);
      for (let t = 0; t < nTrips; t++) {
        const pair = times[t][off];
        arrCol[t] = pair[0];
        depCol[t] = pair[1];
      }
      for (let t = 0; t + 1 < nTrips; t++) {
        if (depCol[t] > depCol[t + 1]) { ordered = false; break; }
      }
      for (let t = 0; t + 1 < nTrips; t++) {
        if (arrCol[t] > arrCol[t + 1]) { ordered = false; break; }
      }
      colsDep[off] = depCol;
      colsArr[off] = arrCol;
    }
    // Patterns are keyed on the stop sequence alone, so one can carry trips of two
    // routes; keep the per-trip route so a journey never names the wrong line.
    const tripRoutes = ids.map((t) => tripRoute.get(t)[0]);
    const head = tripRoute.get(ids[0]);
    const pi = patterns.length;
    const stopsIdx = new Int32Array(nOff);
    for (let off = 0; off < nOff; off++) stopsIdx[off] = index.byId.get(stopKeys[off]);
    patterns.push({
      stops: stopsIdx,
      dep: colsDep,
      arr: colsArr,
      tripIds: ids,
      tripRoutes,
      routeId: head[0],
      directionId: head[1],
      sortedCols: ordered,
    });
    for (let off = 0; off < nOff; off++) atStop[stopsIdx[off]].push([pi, off]);
  }
  for (const list of atStop) list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  // CSR-flatten pattern_at_stop.
  const asPtr = new Int32Array(atStop.length + 1);
  let asTotal = 0;
  for (let i = 0; i < atStop.length; i++) { asTotal += atStop[i].length; asPtr[i + 1] = asTotal; }
  const asPat = new Int32Array(asTotal);
  const asOff = new Int32Array(asTotal);
  let cursor = 0;
  for (let i = 0; i < atStop.length; i++) {
    for (const pair of atStop[i]) { asPat[cursor] = pair[0]; asOff[cursor] = pair[1]; cursor++; }
  }

  let first = Infinity;
  let last = -Infinity;
  for (const sid of served) {
    const sd = stopDays[sid];
    if (sd.first !== null && sd.first < first) first = sd.first;
    if (sd.last !== null && sd.last > last) last = sd.last;
  }

  const routeSet = new Set();
  for (const sid of served) for (const r of stopRoutes.get(sid)) routeSet.add(r);

  let tripCount = 0;
  for (const t of orderedTripIds) {
    const rows = byTrip.get(t);
    if (rows && rows.length) tripCount++;
  }

  const stopName = Object.create(null);
  for (const sid of served) stopName[sid] = feed.stops[sid].name;
  const routeLabel = Object.create(null);
  for (const rid of Object.keys(feed.routes).sort(cmpStr)) routeLabel[rid] = feed.routes[rid].label;
  const stopRoutesOut = Object.create(null);
  for (const sid of Array.from(stopRoutes.keys()).sort(cmpStr)) {
    stopRoutesOut[sid] = Array.from(stopRoutes.get(sid)).sort(cmpStr);
  }
  const tripRouteOut = Object.create(null);
  for (const t of orderedTripIds) tripRouteOut[t] = tripRoute.get(t);

  return {
    dayType: day,
    stopDays,
    servedStopIds: served,
    routeIds: Array.from(routeSet).sort(cmpStr),
    trips: tripCount,
    stopEvents,
    firstDeparture: first,
    lastDeparture: last,
    // RAPTOR structures — opaque to other sections, built here. Stripped before
    // any ServiceDay crosses postMessage.
    patterns,
    patternAtStop: { ptr: asPtr, pat: asPat, off: asOff },
    footpaths: s1Footpaths(feed, proj),
    stopIndex: index,
    extras: {
      tripRoute: tripRouteOut,
      dedup: dedupAll,
      routeDirStop: rdsClean,
      stopRoutes: stopRoutesOut,
      stopName,
      routeLabel,
    },
    // `_s1_slack`, generate.py. Read back by raptor.js.
    _s1Slack: Math.trunc(boardSlackS),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// S1 · stations
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Synthesise stations by single-link clustering of stops within `STATION_CLUSTER_M`,
 * honouring `parentStation` first. Union-find over grid-accelerated pairs. **Do not**
 * single-link at the zone radius: chaining collapses whole corridors (on the
 * reference feed 100 m gives 822 stations, 402 m gives 111).
 *
 * @param {object[]} stops  `Stop` records
 * @param {Projection|{lat0:number,lon0:number}} projLike
 * @returns {object[]} `Station` records, sorted by stationId
 */
export function clusterStations(stops, projLike) {
  const proj = Projection.from(projLike);
  const ordered = Array.from(stops).sort((a, b) => cmpStr(a.stopId, b.stopId));
  if (!ordered.length) return [];
  const ids = ordered.map((s) => s.stopId);
  const slot = new Map();
  for (let i = 0; i < ids.length; i++) slot.set(ids[i], i);
  const parent = new Int32Array(ids.length);
  for (let i = 0; i < ids.length; i++) parent[i] = i;

  function find(a) {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }

  for (const stop of ordered) {                      // parentStation first
    if (stop.parentStation && slot.has(stop.parentStation)) {
      union(slot.get(stop.stopId), slot.get(stop.parentStation));
    }
  }
  /** @type {Map<string, string[]>} */
  const byParent = new Map();
  for (const stop of ordered) {
    if (stop.parentStation) pushTo(byParent, stop.parentStation, stop.stopId);
  }
  for (const group of Array.from(byParent.values()).sort(cmpStrList)) {
    for (let i = 1; i < group.length; i++) union(slot.get(group[0]), slot.get(group[i]));
  }

  const pos = Object.create(null);
  for (const s of ordered) pos[s.stopId] = proj.xy(s.lat, s.lon);
  const grid = new GridIndex(STATION_CLUSTER_M);
  for (const sid of ids) grid.add(sid, pos[sid][0], pos[sid][1]);
  for (const sid of ids) {
    const x = pos[sid][0];
    const y = pos[sid][1];
    for (const item of grid.near(x, y, STATION_CLUSTER_M)) {
      const other = item[0];
      if (other !== sid && Math.hypot(x - item[1], y - item[2]) <= STATION_CLUSTER_M) {
        union(slot.get(sid), slot.get(other));
      }
    }
  }

  /** @type {Map<number, string[]>} */
  const members = new Map();
  for (const sid of ids) pushTo(members, find(slot.get(sid)), sid);

  const lookup = new Map();
  for (const s of ordered) lookup.set(s.stopId, s);
  const out = [];
  for (const raw of Array.from(members.values()).sort(cmpStrList)) {
    const group = raw.slice().sort(cmpStr);
    const names = new Map();
    for (const g of group) {
      const st = lookup.get(g);
      const label = st.baseName || st.name;
      names.set(label, (names.get(label) || 0) + 1);
    }
    const name = Array.from(names.entries())
      .sort((a, b) => (b[1] - a[1]) || cmpStr(a[0], b[0]))[0][0];
    let slat = 0;
    let slon = 0;
    for (const g of group) { slat += lookup.get(g).lat; slon += lookup.get(g).lon; }
    out.push({
      stationId: group[0],
      name,
      lat: slat / group.length,
      lon: slon / group.length,
      stopIds: group,
    });
  }
  out.sort((a, b) => cmpStr(a.stationId, b.stationId));
  return out;
}
