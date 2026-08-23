/**
 * S1 · RAPTOR.
 *
 * Port of `generate.py`: `_s1_slack`, `_s1_earliest_trip`,
 * `_s1_latest_trip`, `raptor`, `raptor_reverse` and `build_journey`.
 *
 * This is a real transit routing algorithm over the actual timetable. "35 minutes
 * from the hub" means there is a genuine sequence of buses that gets you there in
 * 35 minutes, including transfer waits. The round structure and the marked-stop
 * bookkeeping are ported exactly; the golden t90 = 76.8 min on the reference feed
 * depends on that faithfulness. There is no target pruning in either implementation —
 * every query fans out to the whole network, because the callers want all arrival
 * times, not one.
 *
 * The one shape change from the Python is representational, not behavioural:
 * labels, the marked sets and the parent pointers are typed arrays rather than
 * lists of tuples, and `day.patternAtStop` / `day.footpaths` arrive as the CSR
 * triples that `gtfs/service.js` builds. Stop ids are interned to dense
 * integers by `day.stopIndex`; everything below works in integer space and
 * converts back to string ids only at the API boundary.
 *
 * Determinism: the Python iterates `sorted(marked)` and `sorted(queue)`. Here
 * `marked` is a `Uint8Array` scanned in ascending index order and `queue` is an
 * `Int32Array` indexed by pattern, also scanned ascending — the same total order,
 * for free. There is no priority queue and therefore no tie-break nondeterminism.
 *
 * @module gtfs/raptor.js
 */

import { MAX_TRANSFERS } from '../lib/core.js';

/** `_S1_INF` / `_S1_NEG_INF`, generate.py. Both fit an Int32Array. */
const S1_INF = 1000000000;
const S1_NEG_INF = -1000000000;

/** `bisect.bisect_left` over a sorted Int32Array. */
function bisectLeft(col, value) {
  let lo = 0;
  let hi = col.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (col[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** `bisect.bisect_right` over a sorted Int32Array. */
function bisectRight(col, value) {
  let lo = 0;
  let hi = col.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (value < col[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Code-point string comparator. */
function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/** `sorted(set(ids))` — Python's normalisation of the origin/target list. */
function uniqueSorted(ids) {
  return Array.from(new Set(Array.from(ids, (s) => String(s)))).sort(cmpStr);
}

/**
 * The boarding slack this service day was built with.
 * @param {object} day @returns {number}
 */
export function s1Slack(day) {
  return Math.trunc(day._s1Slack);
}

/**
 * Index of the earliest trip departing offset `off` at or after `ready`, or −1.
 * @param {object} pattern @param {number} off @param {number} ready
 * @returns {number}
 */
export function s1EarliestTrip(pattern, off, ready) {
  const col = pattern.dep[off];
  if (pattern.sortedCols) {
    const j = bisectLeft(col, ready);
    return j < col.length ? j : -1;
  }
  let best = S1_INF;
  let bestI = -1;
  for (let i = 0; i < col.length; i++) {
    const value = col[i];
    if (ready <= value && value < best) { best = value; bestI = i; }
  }
  return bestI;
}

/**
 * Index of the latest trip arriving at offset `off` no later than `deadline`, or −1.
 * @param {object} pattern @param {number} off @param {number} deadline
 * @returns {number}
 */
export function s1LatestTrip(pattern, off, deadline) {
  const col = pattern.arr[off];
  if (pattern.sortedCols) return bisectRight(col, deadline) - 1;
  let best = S1_NEG_INF;
  let bestI = -1;
  for (let i = 0; i < col.length; i++) {
    const value = col[i];
    if (best < value && value <= deadline) { best = value; bestI = i; }
  }
  return bestI;
}

/** Allocate `count` Int32Arrays of length `n`, each filled with `fill`. */
function labelRounds(count, n, fill) {
  const out = new Array(count);
  for (let k = 0; k < count; k++) {
    const a = new Int32Array(n);
    a.fill(fill);
    out[k] = a;
  }
  return out;
}

/**
 * Round-based RAPTOR, one-to-all earliest arrival. ~8 ms per query.
 *
 * Determinism comes from iterating the marked stops and the pattern queue in
 * ascending index order — there is no priority queue and therefore no tie-break
 * nondeterminism. `TravelTimes.rounds` carries the transfer count of the best
 * journey, which the zone scoring needs and which a CSA implementation would not
 * give for free.
 *
 * Correctness was validated against an independent brute force (15/15 exact
 * matches, zero cases slower than a one-leg journey) — keep that test.
 *
 * @param {object} day  a `ServiceDay`
 * @param {string[]} originStopIds
 * @param {number} departureS
 * @returns {object} a `TravelTimes`
 */
export function raptor(day, originStopIds, departureS) {
  const index = day.stopIndex;
  const patterns = day.patterns;
  const atStop = day.patternAtStop;
  const foot = day.footpaths;
  const slack = s1Slack(day);
  const n = index.ids.length;
  const P = patterns.length;
  const K = MAX_TRANSFERS + 1;                           // K transit legs ⇒ K−1 transfers
  const dep0 = Math.trunc(departureS);

  const best = new Int32Array(n);
  best.fill(S1_INF);
  const label = labelRounds(K + 1, n, S1_INF);
  // parent[k][i] in the Python is None | ('walk', i) | ('ride', pi, trip, boardOff, off).
  // Here: kind 0 = none, 1 = walk (a = from-stop), 2 = ride (a = pattern,
  // b = trip, c = boardOff, d = alightOff).
  const parentKind = new Array(K + 1);
  const parentA = new Array(K + 1);
  const parentB = new Array(K + 1);
  const parentC = new Array(K + 1);
  const parentD = new Array(K + 1);
  for (let k = 0; k <= K; k++) {
    parentKind[k] = new Uint8Array(n);
    parentA[k] = new Int32Array(n);
    parentB[k] = new Int32Array(n);
    parentC[k] = new Int32Array(n);
    parentD[k] = new Int32Array(n);
  }
  const roundOf = new Int32Array(n);

  const origins = uniqueSorted(originStopIds);
  let marked = new Uint8Array(n);
  let anySeed = false;
  for (const sid of origins) {
    const i = index.byId.get(sid);
    if (i === undefined) continue;
    best[i] = dep0;
    label[0][i] = dep0;
    marked[i] = 1;
    anySeed = true;
  }
  if (!anySeed) {
    return { departureS: dep0, arrivalS: {}, rounds: {} };
  }

  /**
   * One walk hop out of every stop reached in round `k`.
   *
   * Deliberately **not** transitively closed. `WALK_RADIUS_M` is the transfer
   * radius; chaining hops would let the model walk the whole map at 1.2 m/s and it
   * inflates the reference feed's ≤30-minute reach from 768 stops to 792. A second
   * walk is a strategic decision, not a transfer.
   *
   * `seeds` is a snapshot (the Python takes `sorted(seeds)` on entry); `touched` is
   * returned separately and unioned in by the caller, so a stop reached by this
   * pass is never itself used as a seed of the same pass. Labels are, however,
   * mutated live — a seed processed later sees an improved base, exactly as the
   * Python does.
   */
  function relaxFootpaths(k, seeds) {
    const touched = new Uint8Array(n);
    const lab = label[k];
    for (let i = 0; i < n; i++) {
      if (!seeds[i]) continue;
      const base = lab[i];
      if (base >= S1_INF) continue;
      for (let e = foot.ptr[i]; e < foot.ptr[i + 1]; e++) {
        const j = foot.to[e];
        const value = base + foot.w[e];
        if (value < best[j]) {
          best[j] = value;
          lab[j] = value;
          parentKind[k][j] = 1;
          parentA[k][j] = i;
          roundOf[j] = k;
          touched[j] = 1;
        }
      }
    }
    return touched;
  }

  {
    const touched = relaxFootpaths(0, marked);
    for (let i = 0; i < n; i++) if (touched[i]) marked[i] = 1;
  }

  const queue = new Int32Array(P);
  for (let k = 1; k <= K; k++) {
    queue.fill(-1);
    for (let si = 0; si < n; si++) {
      if (!marked[si]) continue;
      for (let e = atStop.ptr[si]; e < atStop.ptr[si + 1]; e++) {
        const pi = atStop.pat[e];
        const off = atStop.off[e];
        if (queue[pi] < 0 || off < queue[pi]) queue[pi] = off;
      }
    }
    marked = new Uint8Array(n);
    const prev = label[k - 1];
    const lab = label[k];
    for (let pi = 0; pi < P; pi++) {
      const start = queue[pi];
      if (start < 0) continue;
      const pattern = patterns[pi];
      const stops = pattern.stops;
      const nOff = stops.length;
      let trip = -1;
      let boardOff = -1;
      for (let off = start; off < nOff; off++) {
        const si = stops[off];
        if (trip >= 0) {
          const arrival = pattern.arr[off][trip];
          if (arrival < best[si]) {
            best[si] = arrival;
            lab[si] = arrival;
            parentKind[k][si] = 2;
            parentA[k][si] = pi;
            parentB[k][si] = trip;
            parentC[k][si] = boardOff;
            parentD[k][si] = off;
            roundOf[si] = k;
            marked[si] = 1;
          }
        }
        if (prev[si] < S1_INF) {
          const ready = prev[si] + slack;
          if (trip < 0 || ready <= pattern.dep[off][trip]) {
            const cand = s1EarliestTrip(pattern, off, ready);
            if (cand >= 0 && (trip < 0 || pattern.dep[off][cand] < pattern.dep[off][trip])) {
              trip = cand;
              boardOff = off;
            }
          }
        }
      }
    }
    const touched = relaxFootpaths(k, marked);
    let anyMarked = false;
    for (let i = 0; i < n; i++) {
      if (touched[i]) marked[i] = 1;
      if (marked[i]) anyMarked = true;
    }
    if (!anyMarked) break;
  }

  // `index.ids` is sorted, so inserting in ascending index order gives sorted
  // insertion order — but nothing downstream may rely on it (see CONTRACT §0).
  const arrivalS = {};
  const rounds = {};
  for (let i = 0; i < n; i++) {
    if (best[i] >= S1_INF) continue;
    const sid = index.ids[i];
    arrivalS[sid] = best[i];
    rounds[sid] = Math.max(0, roundOf[i] - 1);
  }
  return {
    departureS: dep0,
    arrivalS,
    rounds,
    // `_s1_parent` / `_s1_round`, generate.py. Consumed only by
    // buildJourney; never crosses postMessage.
    _s1Parent: { kind: parentKind, a: parentA, b: parentB, c: parentC, d: parentD },
    _s1Round: roundOf,
  };
}

/**
 * Mirrored RAPTOR: per stop, the **latest departure** that still reaches the target.
 *
 * Labels are latest-departure instead of earliest-arrival, patterns are scanned
 * from the end, `max` replaces `min`, footpaths subtract. This is what produces the
 * honest `last_train_home` — strictly earlier than the raw last departure, and the
 * input to the `S2 exit_margin` metric.
 *
 * @param {object} day @param {string[]} targetStopIds @param {number} arriveByS
 * @returns {Object<string, number>} stop_id → latest departure seconds
 */
export function raptorReverse(day, targetStopIds, arriveByS) {
  const index = day.stopIndex;
  const patterns = day.patterns;
  const atStop = day.patternAtStop;
  const foot = day.footpaths;
  const slack = s1Slack(day);
  const n = index.ids.length;
  const P = patterns.length;
  const K = MAX_TRANSFERS + 1;
  const arrive0 = Math.trunc(arriveByS);

  const best = new Int32Array(n);
  best.fill(S1_NEG_INF);
  const label = labelRounds(K + 1, n, S1_NEG_INF);

  let marked = new Uint8Array(n);
  let anySeed = false;
  for (const sid of uniqueSorted(targetStopIds)) {
    const i = index.byId.get(sid);
    if (i === undefined) continue;
    best[i] = arrive0;
    label[0][i] = arrive0;
    marked[i] = 1;
    anySeed = true;
  }
  if (!anySeed) return {};

  /**
   * One walk hop, mirrored: footpaths subtract. Not transitively closed, for the
   * same reason as the forward scan.
   */
  function relaxFootpaths(k, seeds) {
    const touched = new Uint8Array(n);
    const lab = label[k];
    for (let i = 0; i < n; i++) {
      if (!seeds[i]) continue;
      const base = lab[i];
      if (base <= S1_NEG_INF) continue;
      for (let e = foot.ptr[i]; e < foot.ptr[i + 1]; e++) {
        const j = foot.to[e];
        const value = base - foot.w[e];
        if (value > best[j]) {
          best[j] = value;
          lab[j] = value;
          touched[j] = 1;
        }
      }
    }
    return touched;
  }

  {
    const touched = relaxFootpaths(0, marked);
    for (let i = 0; i < n; i++) if (touched[i]) marked[i] = 1;
  }

  const queue = new Int32Array(P);
  for (let k = 1; k <= K; k++) {
    queue.fill(-1);
    for (let si = 0; si < n; si++) {
      if (!marked[si]) continue;
      for (let e = atStop.ptr[si]; e < atStop.ptr[si + 1]; e++) {
        const pi = atStop.pat[e];
        const off = atStop.off[e];
        if (queue[pi] < 0 || off > queue[pi]) queue[pi] = off;
      }
    }
    marked = new Uint8Array(n);
    const prev = label[k - 1];
    const lab = label[k];
    for (let pi = 0; pi < P; pi++) {
      const start = queue[pi];
      if (start < 0) continue;
      const pattern = patterns[pi];
      const stops = pattern.stops;
      let trip = -1;
      for (let off = start; off >= 0; off--) {
        const si = stops[off];
        if (trip >= 0) {
          const dep = pattern.dep[off][trip];
          if (dep > best[si]) {
            best[si] = dep;
            lab[si] = dep;
            marked[si] = 1;
          }
        }
        if (prev[si] > S1_NEG_INF) {
          const deadline = prev[si] - slack;
          if (trip < 0 || deadline >= pattern.arr[off][trip]) {
            const cand = s1LatestTrip(pattern, off, deadline);
            if (cand >= 0 && (trip < 0 || pattern.arr[off][cand] > pattern.arr[off][trip])) {
              trip = cand;
            }
          }
        }
      }
    }
    const touched = relaxFootpaths(k, marked);
    let anyMarked = false;
    for (let i = 0; i < n; i++) {
      if (touched[i]) marked[i] = 1;
      if (marked[i]) anyMarked = true;
    }
    if (!anyMarked) break;
  }

  const out = {};
  for (let i = 0; i < n; i++) {
    if (best[i] > S1_NEG_INF) out[index.ids[i]] = best[i];
  }
  return out;
}

/**
 * Reconstruct a concrete itinerary from a RAPTOR result, or null if unreachable.
 *
 * Returns route labels, board/alight stop names and times per leg — the dossier's
 * "how you get there" panel. Legs are ordered; walk legs carry `mode: 'walk'`.
 *
 * @param {object} day @param {object} times a `TravelTimes` from `raptor()`
 * @param {string} destStopId
 * @returns {object|null} a `Journey`
 */
export function buildJourney(day, times, destStopId) {
  const index = day.stopIndex;
  const parent = times && times._s1Parent;
  const roundOf = times && times._s1Round;
  if (!parent || !roundOf
    || !Object.prototype.hasOwnProperty.call(times.arrivalS, destStopId)) return null;

  const extras = day.extras;
  const nameOf = (i) => {
    const sid = index.ids[i];
    const nm = extras && extras.stopName ? extras.stopName[sid] : undefined;
    return nm === undefined ? sid : nm;
  };
  const labelOf = (rid) => {
    const lb = extras && extras.routeLabel ? extras.routeLabel[rid] : undefined;
    return lb === undefined ? rid : lb;
  };

  let i = index.byId.get(destStopId);
  let k = roundOf[i];
  const legs = [];
  let guard = 0;
  while (guard < 512) {
    guard++;
    const kind = parent.kind[k][i];
    if (kind === 0) break;
    if (kind === 1) {
      const j = parent.a[k][i];
      legs.push({
        mode: 'walk',
        route: '',
        routeId: '',
        from: nameOf(j),
        fromId: index.ids[j],
        to: nameOf(i),
        toId: index.ids[i],
        dep: null,
        arr: null,
      });
      i = j;
    } else {
      const pi = parent.a[k][i];
      const trip = parent.b[k][i];
      const boardOff = parent.c[k][i];
      const alightOff = parent.d[k][i];
      const pattern = day.patterns[pi];
      const boardI = pattern.stops[boardOff];
      const ridden = pattern.tripRoutes[trip];
      legs.push({
        mode: 'transit',
        routeId: ridden,
        route: labelOf(ridden),
        tripId: pattern.tripIds[trip],
        from: nameOf(boardI),
        fromId: index.ids[boardI],
        to: nameOf(i),
        toId: index.ids[i],
        dep: pattern.dep[boardOff][trip],
        arr: pattern.arr[alightOff][trip],
      });
      i = boardI;
      k -= 1;
    }
  }
  legs.reverse();
  if (!legs.length) return { minutes: 0.0, transfers: 0, legs: [] };

  const total = (times.arrivalS[destStopId] - times.departureS) / 60.0;
  let rides = 0;
  for (const leg of legs) if (leg.mode === 'transit') rides++;
  return { minutes: total, transfers: Math.max(0, rides - 1), legs };
}
