/**
 * rules/score.js — the scoring layer.
 *
 * Port of generate.py's S3 scoring section: the ramps, the 100-point
 * city fitness model (`score_fitness`), the per-zone rating
 * (`score_zones`), the findings and house rules and the
 * provenance block (`build_provenance`).
 *
 * Worker side — no DOM. Every number here is an INTEGER NUMBER OF TENTHS of a
 * point from `tenths()` onward, so sub-scores and totals are exact integer sums
 * and the printed rows always add up to the printed total. Degradation is
 * drop-and-renormalise, never impute: an unavailable metric leaves the
 * denominator, it is never scored as zero.
 *
 * CONTRACT.md §(a), §(b) "Scoring layer", §(d) stages 6 and 7.
 */

import {
  GENERATOR, VERSION, M_PER_MILE, SEEKER_SAMPLE_CAP,
  rhu, num, pct, mins, miles, hhmm, quantile,
} from '../lib/core.js';
import { bboxOf, bboxContains, Projection } from '../lib/geo.js';
import { cacheBackend } from '../lib/cache.js';
import { QUESTIONS, INTERPRETATIONS } from './catalogue.js';
import {
  globalQuestionOrder, s3JointBlockShare, s3ReferenceSeeker, s3Answer, s3Join,
} from './audit.js';

/** Code-point string order — Python's. Never `localeCompare` (locale = non-determinism). */
function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/** `sorted(dict)` — a plain object's keys in code-point order. */
function sortedKeys(obj) {
  return obj ? Object.keys(obj).sort(cmpStr) : [];
}

/** Python's `d.get(k)`, without inheriting from `Object.prototype`. */
function get(obj, key) {
  if (obj === null || obj === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** Python's `d.get(k, 0)` for count-like tables. */
function getNum(obj, key, fallback = 0) {
  const v = get(obj, key);
  return (v === undefined || v === null) ? fallback : v;
}

// ── ramps: the only shaping functions in the scoring path ────────────────────

/**
 * Monotone increasing, clamped: `lo`→0, `hi`→1.
 * (generate.py `ramp`)
 * @param {number} x @param {number} lo @param {number} hi @returns {number}
 */
export function ramp(x, lo, hi) {
  if (hi === lo) return x >= hi ? 1.0 : 0.0;
  return Math.min(1.0, Math.max(0.0, (x - lo) / (hi - lo)));
}

/**
 * Monotone decreasing, clamped: `good`→1, `bad`→0.
 * (generate.py `rramp`)
 * @param {number} x @param {number} good @param {number} bad @returns {number}
 */
export function rramp(x, good, bad) {
  return ramp(-x, -bad, -good);
}

/**
 * 0 below `a`, ramp `a`→`b`, 1 across `[b, c]`, ramp down `c`→`d`, 0 above `d`.
 * (generate.py `plateau`)
 * @param {number} x
 * @param {number} a @param {number} b @param {number} c @param {number} d
 * @returns {number}
 */
export function plateau(x, a, b, c, d) {
  if (x < b) return ramp(x, a, b);
  if (x <= c) return 1.0;
  return rramp(x, c, d);
}

/**
 * Convert a ramp output to integer tenths of a point.
 *
 * `floor(frac * max * 10 + 0.5)`. Every point in the program is an integer number
 * of tenths from here on, so sub-scores and totals are exact integer sums.
 * (generate.py `tenths`)
 * @param {number} fraction @param {number} maxPoints @returns {number}
 */
export function tenths(fraction, maxPoints) {
  return Math.trunc(Math.floor(fraction * maxPoints * 10 + 0.5));
}

// ═══════════════════════════════════════════════════════════════════════════════
// S3 · CITY FITNESS
// ═══════════════════════════════════════════════════════════════════════════════

/** `_S3_BANDS`, generate.py. `[threshold, name, advice]`, descending. */
export const S3_BANDS = Object.freeze([
  Object.freeze([80.0, 'Excellent map', 'Play it as written; no house rules required.']),
  Object.freeze([65.0, 'Strong map', 'A few house rules and it plays well.']),
  Object.freeze([50.0, 'Playable with house rules',
    'The house rules below are required, not optional.']),
  Object.freeze([35.0, 'Marginal',
    'Expect substantial modification: shrink the map or change the game size.']),
  Object.freeze([0.0, 'Not recommended as a transit game',
    "Consider the rulebook's cars or on-foot variant."]),
]);

/** `_S3_GREEDY_K`, generate.py. */
export const S3_GREEDY_K = Object.freeze({ small: 3, medium: 4, large: 5 });

/**
 * One scored row. `frac` is the ramp output; points are integer tenths from here on.
 * (generate.py `_s3_metric`)
 *
 * @param {string} mid @param {string} name @param {number|null} raw @param {string} unit
 * @param {number|null} frac @param {number} maxPoints
 * @param {'ramp'|'rramp'|'plateau'|'table'} kind @param {number[]} args
 * @param {'rulebook'|'feed'|'interp'} source @param {string} note
 * @param {boolean} [available]
 * @returns {Object} a `Metric`
 */
function s3Metric(mid, name, raw, unit, frac, maxPoints, kind, args, source, note,
  available = true) {
  const points = (available && frac !== null && frac !== undefined)
    ? tenths(frac, maxPoints) : 0;
  return {
    id: mid,
    name,
    raw: (raw === null || raw === undefined) ? null : rhu(Number(raw), 4),
    unit,
    pointsTenths: points,                              // points_tenths
    maxTenths: Math.trunc(rhu(maxPoints * 10)),        // max_tenths
    ramp: { kind, args: args.map((a) => Number(a)) },
    source,
    note,
    available,
  };
}

/**
 * The four B-metric inputs, from the audit rows. `unknown` never enters a denominator.
 * (generate.py `_s3_question_stats`)
 *
 * `unaskable` used to be counted into the functional pool at both sites below, because
 * there was exactly one `unaskable` question — Transit Line, forced there by a curse
 * that only bites once drawn and played — and folding it back in was how the pool kept a
 * live question at full weight. `rules/audit.js` no longer emits that status for a map
 * with routes, so the clause is gone; carrying it would silently
 * restore full weight to any question a future rule does class `unaskable`, which is by
 * definition a question that cannot be asked.
 * @param {Object[]} questions @param {Object} size @returns {Object}
 */
function s3QuestionStats(questions, size) {
  const scored = questions.filter((q) => q.status !== 'unknown');
  const total = scored.length;
  const functional = scored.filter((q) => q.status === 'functional');
  const weak = scored.filter((q) => q.status === 'weak');
  const liveShare = total ? (functional.length + 0.5 * weak.length) / total : null;

  /** @type {Object<string, {n: number, functional: number, dead: number}>} */
  const perCat = Object.create(null);
  for (const q of scored) {
    let row = get(perCat, q.category);
    if (row === undefined) { row = { n: 0, functional: 0, dead: 0 }; perCat[q.category] = row; }
    row.n += 1;
    if (q.status === 'functional') row.functional += 1;
    if (q.status === 'dead' || q.status === 'degenerate') row.dead += 1;
  }

  const cats = sortedKeys(perCat);
  let deep = 0;
  let anyLive = 0;
  for (const cat of cats) {
    if (perCat[cat].functional >= 2) deep += 1;
    if (perCat[cat].functional >= 1) anyLive += 1;
  }
  const depth = size.categoryCount ? deep / size.categoryCount : null;

  // Python sums a *sorted* list, so the float accumulation order is fixed.
  const qualities = functional.map((q) => q.quality).sort((a, b) => a - b);
  let meanQuality = null;
  if (qualities.length) {
    let acc = 0.0;
    for (const v of qualities) acc += v;
    meanQuality = acc / qualities.length;
  }

  let randomize = null;
  if (total) {
    randomize = 0.0;
    for (const cat of cats) {
      const row = perCat[cat];
      randomize += (row.n / total) * (row.n ? row.dead / row.n : 0.0);
    }
  }

  return {
    total,
    liveShare,                          // live_share
    categoryDepth: depth,               // category_depth
    categoriesWithLive: anyLive,        // categories_with_live
    meanQuality,                        // mean_quality
    randomizeRisk: randomize,           // randomize_risk
  };
}

/**
 * The metric view for one service day: the head table, overlaid with that day's values.
 * (generate.py `_s3_view`)
 * @param {Object} metrics @param {string|null} dayKey @param {Object} size @returns {Object}
 */
function s3View(metrics, dayKey, size) {
  const view = Object.assign(Object.create(null), metrics);
  if (dayKey) {
    const day = get(get(metrics, 'perDay') || {}, dayKey);
    if (day) Object.assign(view, day);
  }
  for (const base of ['reachableZoneShare', 'eveningZoneShare', 'reachWithinHidingPeriod']) {
    const bySize = get(view, `${base}BySize`);
    if (bySize && typeof bySize === 'object' && get(bySize, size.name) !== undefined) {
      view[base] = bySize[size.name];
    }
  }
  const bySize = get(metrics, 'playableDayWeightBySize');
  if (bySize && typeof bySize === 'object' && get(bySize, size.name) !== undefined) {
    view.playableDayWeight = bySize[size.name];
  }
  return view;
}

/**
 * The largest share of served stops any single route reaches, on the best day.
 *
 * Per-route trip totals are not on the metric table, so the one-route cap is
 * evaluated on stop reach instead. A route touching nine stops in ten is a
 * one-dimensional map either way; this is the `one_route_cap_is_stop_share`
 * interpretation.
 * (generate.py `_s3_one_route_share`)
 * @param {Object[]} days @returns {number}
 */
function s3OneRouteShare(days) {
  if (!days || !days.length) return 0.0;
  let best = days[0];
  for (const d of days) {
    if (d.trips > best.trips
      || (d.trips === best.trips && cmpStr(d.dayType.key, best.dayType.key) > 0)) best = d;
  }
  const served = best.servedStopIds;
  if (!served.length) return 0.0;
  /** @type {Map<string, number>} */
  const reach = new Map();
  for (const sid of served) {
    for (const rid of best.stopDays[sid].routes) reach.set(rid, (reach.get(rid) || 0) + 1);
  }
  if (!reach.size) return 0.0;
  let top = -Infinity;
  for (const rid of Array.from(reach.keys()).sort(cmpStr)) {
    const v = reach.get(rid);
    if (v > top) top = v;
  }
  return top / served.length;
}

/**
 * Build all six sub-scores from one metric view. Pure arithmetic; no I/O.
 * (generate.py `_s3_subscores`)
 *
 * @param {Object} view @param {Object} qstats @param {Object} size
 * @param {number|null} sharedSignatureShare
 * @param {boolean} weekendAvailable @param {string} weekendNote
 * @param {boolean} questionsAvailable
 * @returns {Object[]} `SubScore[]`
 */
function s3Subscores(view, qstats, size, sharedSignatureShare, weekendAvailable, weekendNote,
  questionsAvailable) {
  const hidingH = size.hidingPeriodMin / 60.0;
  const required = size.requiredHours;

  const nZones = get(view, 'nZones');
  const reachShare = get(view, 'reachableZoneShare');
  const a = [
    s3Metric('A1', 'Distinct hiding zones', nullish(nZones), 'zones',
      nullish(nZones) === null ? null : ramp(Number(nZones), 15, 60), 8,
      'ramp', [15, 60], 'interp',
      'The greedy cover at the size\'s zone radius, not the raw stop count: adjacent '
      + 'bus poles share almost all of their circle. Monotone with a cap, because more '
      + 'zones is never worse for the game.',
      nullish(nZones) !== null),
    s3Metric('A2', 'Zones reachable inside the hiding period', nullish(reachShare), 'share',
      nullish(reachShare) === null ? null : ramp(Number(reachShare), 0.35, 0.85), 7,
      'ramp', [0.35, 0.85], 'interp',
      `Below 0.35 most of the printed map is decorative and the real map is much `
      + `smaller. The bound is the rulebook\'s own ${size.hidingPeriodMin}-minute `
      + `hiding period.`,
      nullish(reachShare) !== null),
    s3Metric('A3', 'Zones that share a top-question signature', nullish(sharedSignatureShare),
      'share',
      nullish(sharedSignatureShare) === null
        ? null : ramp(sharedSignatureShare, 0.30, 0.75),
      5, 'ramp', [0.30, 0.75], 'interp',
      'If the map\'s best few questions pin most zones uniquely, hiding is a formality.',
      nullish(sharedSignatureShare) !== null),
  ];

  const b = [
    s3Metric('B1', 'Share of the catalogue that is live', qstats.liveShare, 'share',
      qstats.liveShare === null ? null : ramp(qstats.liveShare, 0.35, 0.80),
      10, 'ramp', [0.35, 0.80], 'interp',
      `Functional plus half of weak, over the ${num(qstats.total)} questions that `
      + `could be evaluated. Under a third live and the seekers are re-asking `
      + `questions at doubled cost while the hider farms cards.`,
      questionsAvailable && qstats.liveShare !== null),
    s3Metric('B2', 'Categories with two or more functional questions', qstats.categoryDepth,
      'share',
      qstats.categoryDepth === null ? null : ramp(qstats.categoryDepth, 0.50, 1.00),
      6, 'ramp', [0.50, 1.00], 'rulebook',
      `Out of ${num(size.categoryCount)} categories in a ${size.name.toUpperCase()} game. `
      + `Two matters because Drained Brain bans three questions across different `
      + `categories and Spotty Memory forces a category on you.`,
      questionsAvailable && qstats.categoryDepth !== null),
    s3Metric('B3', 'Mean quality of the functional questions', qstats.meanQuality, '0–1',
      qstats.meanQuality === null ? null : ramp(qstats.meanQuality, 0.25, 0.65),
      5, 'ramp', [0.25, 0.65], 'interp',
      'A live question that splits the map 97/3 is technically alive and practically '
      + 'useless.',
      questionsAvailable && qstats.meanQuality !== null),
    s3Metric('B4', 'Randomize risk', qstats.randomizeRisk, 'share',
      qstats.randomizeRisk === null ? null : rramp(qstats.randomizeRisk, 0.10, 0.40),
      4, 'rramp', [0.10, 0.40], 'rulebook',
      'Randomize redraws within the same category, so the category-weighted dead '
      + 'share is exactly the chance the powerup hands the hider a free card. The '
      + 'rulebook permits a randomize onto a null question outright.',
      questionsAvailable && qstats.randomizeRisk !== null),
  ];

  const headway = get(view, 'medianHeadwayMin');
  const t90 = get(view, 't90Min');
  const frequent = get(view, 'frequentShare');
  const traverse = (nullish(t90) === null || hidingH <= 0)
    ? null : Number(t90) / size.hidingPeriodMin;
  const c = [
    s3Metric('C1', 'Median per-stop headway', nullish(headway), 'min',
      nullish(headway) === null ? null : rramp(Number(headway), 10, 45), 8,
      'rramp', [10, 45], 'interp',
      'All routes combined, 06:00–22:00, medianed across served stops. Monotone on '
      + 'purpose: Tokyo and London are the rulebook\'s own showcase maps, so frequency '
      + 'is never the flaw.',
      nullish(headway) !== null),
    s3Metric('C2', 'Traverse ratio (T90 ÷ hiding period)', traverse, 'ratio',
      traverse === null ? null : plateau(traverse, 0.40, 0.80, 2.50, 4.50), 7,
      'plateau', [0.40, 0.80, 2.50, 4.50], 'feed',
      `Crossing this network costs ${num(traverse || 0, 2)} hiding periods. Below `
      + `0.40 the map collapses — every radar is yes and “far away” stops existing. `
      + `Above 4.50 the map is bigger than the game.`,
      traverse !== null),
    s3Metric('C3', 'Share of stops on a frequent route-direction', nullish(frequent), 'share',
      nullish(frequent) === null ? null : ramp(Number(frequent), 0.05, 0.50), 5,
      'ramp', [0.05, 0.50], 'interp',
      'A single route-direction at 15 minutes or better. The frequent network is what '
      + 'the seekers actually chase along.',
      nullish(frequent) !== null),
  ];

  const span = get(view, 'spanHours');
  const evening = get(view, 'eveningZoneShare');
  const fullDays = get(view, 'fullServiceDateShare');
  const spanRatio = (nullish(span) === null || required <= 0) ? null : Number(span) / required;
  // The rulebook gives a size's length only as prose — SMALL "lasts 4–8 hours", MEDIUM
  // "lasts about 1 day", LARGE "lasts 2 to 4 days" (GUIDE.md "Choosing Game Size", lines
  // 28/33/38). It never prints a playing-hours figure, so `requiredHours` is OURS: those
  // durations read as a single playing DAY, which is the unit D1 needs because it divides
  // ONE day's service span. SMALL's 6 sits inside the stated 4–8; 10 and 12 stay under the
  // ~14 hours a playing day can hold once the rulebook's own "minimum of 10 hours" of rest
  // (GUIDE.md "Considering Rest Periods", line 167) comes out of the 24. So D1 and its
  // 0.60/1.00 bounds are tagged `interp` — "Our call" — not `rulebook`; the numbers are
  // unchanged.
  const stated = get(Object.freeze({
    small: 'lasts 4–8 hours', medium: 'lasts about 1 day', large: 'lasts 2 to 4 days',
  }), size.name);
  const d = [
    s3Metric('D1', 'Service span ÷ the size\'s playing hours', spanRatio, 'ratio',
      spanRatio === null ? null : ramp(spanRatio, 0.60, 1.00), 6,
      'ramp', [0.60, 1.00], 'interp',
      `The rulebook says a ${size.name.toUpperCase()} game `
      + `${stated || 'runs to no stated number of hours'}; we read that as about `
      + `${num(required)} hours of play in a day. At 0.6 you end the round because the buses `
      + `stopped, not because someone was found.`,
      spanRatio !== null),
    s3Metric('D2', 'Zones still served at the end of the round', nullish(evening), 'share',
      nullish(evening) === null ? null : ramp(Number(evening), 0.30, 0.85), 5,
      'ramp', [0.30, 0.85], 'interp',
      'Zones with a departure after first departure plus the size\'s playing hours. '
      + 'This asks whether the *map* survives to the end, not just the single latest bus.',
      nullish(evening) !== null),
    s3Metric('D3', 'Dates running full service', nullish(fullDays), 'share',
      nullish(fullDays) === null ? null : ramp(Number(fullDays), 0.70, 1.00), 4,
      'ramp', [0.70, 1.00], 'interp',
      'Catches school-term-only, seasonal and holiday-riddled feeds, which look fine '
      + 'on a single representative day.',
      nullish(fullDays) !== null),
  ];

  const weekend = get(view, 'weekendRatio');
  const playable = get(view, 'playableDayWeight');
  const e = [
    s3Metric('E1', 'Weekend service ratio',
      !weekendAvailable ? 1.0 : nullish(weekend), 'ratio',
      !weekendAvailable
        ? 1.0
        : (nullish(weekend) === null ? null : ramp(Number(weekend), 0.15, 0.60)),
      5, 'ramp', [0.15, 0.60], 'interp',
      weekendNote || 'The quieter weekend day\'s trips over a weekday\'s. The game is '
        + 'overwhelmingly played on days off.',
      !weekendAvailable ? true : nullish(weekend) !== null),
    s3Metric('E2', 'Playable share of the calendar week', nullish(playable), 'share',
      nullish(playable) === null ? null : Math.min(1.0, Math.max(0.0, Number(playable))), 5,
      'ramp', [0.0, 1.0], 'interp',
      'One seventh per calendar weekday whose service keeps 60% of the best day\'s '
      + 'zones and 70% of the size\'s playing hours.',
      nullish(playable) !== null),
  ];

  const hub = get(view, 'hubDominance');
  const isolated = get(view, 'isolatedZoneShare');
  const multi = get(view, 'multiRouteStopShare');
  const f = [
    s3Metric('F1', 'Route share at the busiest stop', nullish(hub), 'share',
      nullish(hub) === null ? null : rramp(Number(hub), 0.25, 0.90), 5,
      'rramp', [0.25, 0.90], 'interp',
      'A strongly radial network means every hider journey is hub-out and seekers '
      + 'camping the hub see most of the system.',
      nullish(hub) !== null),
    s3Metric('F2', 'Isolated zones', nullish(isolated), 'share',
      nullish(isolated) === null ? null : rramp(Number(isolated), 0.15, 0.50), 3,
      'rramp', [0.15, 0.50], 'interp',
      'Zones whose nearest neighbour is more than two zone radii away. An isolated '
      + 'zone is pinned by a single radar.',
      nullish(isolated) !== null),
    s3Metric('F3', 'Stops with two or more routes', nullish(multi), 'share',
      nullish(multi) === null ? null : ramp(Number(multi), 0.10, 0.40), 2,
      'ramp', [0.10, 0.40], 'rulebook',
      'Drives the Transit Line question\'s discriminating power and whether Curse of '
      + 'the U-Turn has an escape hatch.',
      nullish(multi) !== null),
  ];

  const blocks = [
    ['A', 'Zone supply', a, 200],
    ['B', 'Question health', b, 250],
    ['C', 'Mobility & tempo', c, 200],
    ['D', 'Round viability', d, 150],
    ['E', 'Schedule resilience', e, 100],
    ['F', 'Structural fairness', f, 100],
  ];
  const out = [];
  for (const [sid, name, rows, full] of blocks) {
    const available = rows.filter((m) => m.available);
    let availMax = 0;
    let earned = 0;
    for (const m of available) { availMax += m.maxTenths; earned += m.pointsTenths; }
    const missing = rows.filter((m) => !m.available).map((m) => m.id);
    if (availMax === 0) {
      out.push({
        id: sid, name, metrics: rows, earnedTenths: 0, maxTenths: full, partial: true, missing,
      });
    } else {
      const scaled = Math.trunc(rhu(earned * full / availMax));
      out.push({
        id: sid,
        name,
        metrics: rows,
        earnedTenths: scaled,
        maxTenths: full,
        partial: missing.length > 0,
        missing,
      });
    }
  }
  return out;
}

/** `undefined` and `null` are both Python's `None` here. */
function nullish(v) { return (v === undefined || v === null) ? null : v; }

/**
 * The 100-point city rating: six sub-scores, 18 named metrics, all traceable.
 *
 *     A Zone supply 20 · B Question health 25 · C Mobility & tempo 20
 *     D Round viability 15 · E Schedule resilience 10 · F Structural fairness 10
 *
 * Every threshold is a ratio against a rulebook parameter or against the feed
 * itself, so the model ports from a 1,493-stop bus feed to a national rail network
 * without editing. Frequency is deliberately **monotone**; map *collapse* lives
 * entirely on `C2 = T90 / hiding_period`, a plateau, so there is no absolute size
 * constant anywhere.
 *
 * Five named caps can only *lower* the score, and the trace shows both values.
 * Degradation is drop-and-renormalise; above 40% missing points, no headline number
 * is printed at all.
 * (generate.py `score_fitness`)
 *
 * @param {Object} metrics @param {Object[]} questions @param {Object[]} zones
 * @param {Object<string, Object>} zoneScores @param {Object} size @param {Object[]} days
 * @returns {Object} a `Fitness`
 */
export function scoreFitness(metrics, questions, zones, zoneScores, size, days) {
  const qstats = s3QuestionStats(questions, size);
  // B is only meaningful when most of the catalogue could actually be evaluated.
  // With no map data readable, two thirds of the questions are `unknown`, and scoring the
  // remainder as if it were the whole toolkit would be a fiction. Drop the whole
  // sub-score instead and let the headline say "computed from 75 of 100 points"
  // (scoring.md §1.10.2).
  const questionsAvailable = qstats.total >= 6 && qstats.total >= 0.5 * size.catalogueSize;

  const n = zones.length;
  let shared = null;
  const zoneIds = sortedKeys(zoneScores);
  if (zoneIds.length && n) {
    let hit = 0;
    for (const zid of zoneIds) if (zoneScores[zid].survK > 1.0 / n) hit += 1;
    shared = hit / n;
  }

  const dowTypes = [];
  for (const k of sortedKeys(get(metrics, 'dowDayType') || {})) {
    const v = metrics.dowDayType[k];
    if (v) dowTypes.push(v);
  }
  const singleType = new Set(dowTypes).size <= 1 && dowTypes.length === 7;
  let weekendNote = '';
  if (singleType) {
    weekendNote = 'This feed distinguishes one service day type across the whole week, so no '
      + 'weekend collapse is possible and this metric scores full marks.';
  }

  const headView = s3View(metrics, null, size);
  const subs = s3Subscores(headView, qstats, size, shared, !singleType, weekendNote,
    questionsAvailable);

  let availableTenths = 0;
  let earnedTenths = 0;
  for (const s of subs) {
    if (s.metrics.some((m) => m.available)) {
      availableTenths += s.maxTenths;
      earnedTenths += s.earnedTenths;
    }
  }
  const availablePoints = availableTenths / 10.0;
  let raw = availablePoints <= 0 ? 0.0 : earnedTenths / 10.0 / availablePoints * 100.0;
  raw = rhu(raw, 1);

  // ── caps: they only ever lower, and each names itself ─────────────────────
  const caps = fitnessCaps(metrics, questions, zones, size, days).filter((row) => row.fired);
  const capOrder = caps.slice().sort((x, y) => (x.cap - y.cap) || cmpStr(x.id, y.id));
  let score = raw;
  let cappedBy = null;
  for (const row of capOrder) {
    if (score !== null && score > row.cap) {
      score = row.cap;
      cappedBy = row.id;
      break;
    }
  }

  if (availablePoints < 60.0) score = null;

  let band = 'insufficient data for an overall rating';
  if (score !== null) {
    for (const [threshold, name] of S3_BANDS) {
      if (score >= threshold) { band = name; break; }
    }
  }

  // ── the same arithmetic, once per service day, for the day switcher ───────
  const perDay = Object.create(null);
  for (const dayKey of sortedKeys(get(metrics, 'perDay') || {})) {
    const view = s3View(metrics, dayKey, size);
    const rows = s3Subscores(view, qstats, size, shared, !singleType, weekendNote,
      questionsAvailable);
    let availTenths = 0;
    let got = 0;
    for (const s of rows) {
      if (s.metrics.some((m) => m.available)) { availTenths += s.maxTenths; got += s.earnedTenths; }
    }
    const avail = availTenths / 10.0;
    let value = avail <= 0 ? 0.0 : rhu(got / 10.0 / avail * 100.0, 1);
    // No `break` here, deliberately: the per-day figure takes every fired cap
    // except CAP_SPAN, which is re-applied below from that day's own span.
    for (const row of capOrder) {
      if (row.id !== 'CAP_SPAN' && value > row.cap) value = row.cap;
    }
    const daySpan = Number(get(view, 'spanHours') || 0.0);
    if (daySpan < 4.0 && value > 25.0) value = 25.0;
    perDay[dayKey] = value;
  }

  return {
    score,
    rawScore: raw,                      // raw_score
    cappedBy,                           // capped_by
    band,
    subscores: subs,
    availablePoints: rhu(availablePoints, 1),   // available_points
    perDay,                             // per_day
  };
}

/**
 * All five guard rails, fired or not, each with the sentence that explains it.
 *
 * `scoreFitness` consumes the fired rows; the renderer prints the whole list, so
 * "CAP_CATEGORIES — not evaluated" is visible rather than silently absent. A cap
 * can only ever *lower* a score. Sorted by id.
 * (generate.py `fitness_caps`)
 *
 * @param {Object} metrics @param {Object[]} questions @param {Object[]} zones
 * @param {Object} size @param {Object[]} days
 * @returns {Object[]} `FitnessCap[]`
 */
export function fitnessCaps(metrics, questions, zones, size, days) {
  const qstats = s3QuestionStats(questions, size);
  const view = s3View(metrics, null, size);
  const n = zones.length;
  const perDay = get(metrics, 'perDay') || {};
  const spans = sortedKeys(perDay).map((k) => Number(get(perDay[k] || {}, 'spanHours') || 0.0));
  const longest = spans.length ? Math.max(...spans) : null;
  const reach = nullish(get(view, 'reachableZoneShare'));
  const oneRoute = s3OneRouteShare(days);
  const evaluated = qstats.total >= 6 && qstats.total >= 0.5 * size.catalogueSize;

  const rows = [
    {
      id: 'CAP_ZONES',
      cap: 40.0,
      fired: Boolean(n && n < 30),
      evaluated: Boolean(n),
      why: n
        ? `${num(n)} distinct hiding zones, against the rulebook\'s own SMALL floor of 30 `
          + 'stations.'
        : 'No zones were built, so this could not be evaluated.',
    },
    {
      id: 'CAP_CATEGORIES',
      cap: 45.0,
      fired: evaluated && qstats.categoriesWithLive < 3,
      evaluated,
      why: evaluated
        ? `${num(qstats.categoriesWithLive)} of ${num(size.categoryCount)} question `
          + 'categories have at least one functional question.'
        : 'Too few questions could be evaluated to judge category coverage; not evaluated.',
    },
    {
      id: 'CAP_SPAN',
      cap: 25.0,
      fired: longest !== null && longest < 4.0,
      evaluated: longest !== null,
      why: longest !== null
        ? `The longest service day spans ${num(longest || 0, 1)} hours, against the `
          + 'rulebook\'s shortest game of 4.'
        : 'No service day was measured; not evaluated.',
    },
    {
      id: 'CAP_UNREACHABLE',
      cap: 45.0,
      fired: reach !== null && Number(reach) < 0.15,
      evaluated: reach !== null,
      why: reach !== null
        ? `${pct(Number(reach))} of zones are reachable inside the hiding period from the `
          + 'start location.'
        : 'Reachability was not computed; not evaluated.',
    },
    {
      id: 'CAP_ONE_ROUTE',
      cap: 50.0,
      fired: oneRoute >= 0.90,
      evaluated: Boolean(days && days.length),
      why: (days && days.length)
        ? `The single most widespread route reaches ${pct(oneRoute)} of served stops. `
          + 'Above 90% the map is one-dimensional and every question degenerates to '
          + 'position along the line.'
        : 'No service day was available; not evaluated.',
    },
  ];
  return rows.sort((x, y) => cmpStr(x.id, y.id));
}

// ═══════════════════════════════════════════════════════════════════════════════
// S3 · HIDING-ZONE RATING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Equal-area polar sample of a disc: 8 rings × 16 spokes = 128 points, used for the
 * share of a zone circle that falls outside the map border.
 * (generate.py `_S3_DISC_SAMPLE`)
 */
const S3_DISC_SAMPLE = (() => {
  const out = [];
  for (let ring = 0; ring < 8; ring++) {
    for (let spoke = 0; spoke < 16; spoke++) {
      const r = Math.sqrt((ring + 0.5) / 8.0);
      out.push([r * Math.cos(2 * Math.PI * spoke / 16.0), r * Math.sin(2 * Math.PI * spoke / 16.0)]);
    }
  }
  return Object.freeze(out);
})();

/**
 * Share of the zone circle's area that lies outside the map border.
 * (generate.py `_s3_edge_fraction`)
 */
function s3EdgeFraction(zone, bbox, radiusM, proj) {
  let outside = 0;
  for (const [ux, uy] of S3_DISC_SAMPLE) {
    const [lon, lat] = proj.lonlat(zone.x + ux * radiusM, zone.y + uy * radiusM);
    if (!bboxContains(bbox, lat, lon)) outside += 1;
  }
  return outside / S3_DISC_SAMPLE.length;
}

/**
 * Median gap between departures from anywhere inside the zone circle, 06:00–22:00.
 * (generate.py `_s3_zone_headway_min`)
 */
function s3ZoneHeadwayMin(zone, day, lo, hi) {
  const times = [];
  for (const sid of zone.stopIds) {
    const sd = get(day.stopDays, sid);
    if (sd === undefined || sd === null) continue;
    for (const t of sd.departures) if (t >= lo && t <= hi) times.push(t);
  }
  const uniq = Array.from(new Set(times)).sort((a, b) => a - b);
  if (uniq.length < 2) return null;
  const gaps = [];
  for (let i = 0; i + 1 < uniq.length; i++) gaps.push((uniq[i + 1] - uniq[i]) / 60.0);
  return quantile(gaps, 0.5);
}

/**
 * The latest departure from anywhere inside the zone circle.
 * (generate.py `_s3_zone_last_arrival_s`)
 */
function s3ZoneLastArrivalS(zone, day) {
  let best = null;
  for (const sid of zone.stopIds) {
    const sd = get(day.stopDays, sid);
    if (sd === undefined || sd === null || sd.last === null || sd.last === undefined) continue;
    best = best === null ? sd.last : Math.max(best, sd.last);
  }
  return best;
}

/**
 * Other zones within `radiusM` of each zone, by an x-sweep.
 * (generate.py `_s3_neighbour_count`)
 */
function s3NeighbourCount(zones, radiusM) {
  const n = zones.length;
  if (n < 2) return new Array(n).fill(0);
  const order = zones.map((_, i) => i).sort((i, j) => (zones[i].x - zones[j].x)
    || (zones[i].y - zones[j].y)
    || cmpStr(zones[i].zoneId, zones[j].zoneId));
  const xs = order.map((i) => zones[i].x);
  const ys = order.map((i) => zones[i].y);
  const out = new Array(n).fill(0);
  for (let pos = 0; pos < n; pos++) {
    const i = order[pos];
    let count = 0;
    for (const step of [1, -1]) {
      let j = pos + step;
      while (j >= 0 && j < n && Math.abs(xs[j] - xs[pos]) <= radiusM) {
        if (Math.hypot(xs[j] - xs[pos], ys[j] - ys[pos]) <= radiusM) count += 1;
        j += step;
      }
    }
    out[i] = count;
  }
  return out;
}

/**
 * Single-link clusters of candidate legal spots, at 100 m.
 * (generate.py `_s3_spot_clusters`)
 */
function s3SpotClusters(spots, proj, linkM = 100.0) {
  const pts = spots.map((s) => proj.xy(Number(s.lat), Number(s.lon)));
  const n = pts.length;
  if (n === 0) return 0;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (start) => {
    let i = start;
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) <= linkM) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }
  const roots = new Set();
  for (let i = 0; i < n; i++) roots.add(find(i));
  return roots.size;
}

const S3_AXIS_OF = Object.freeze({
  IR: ['IR1', 'IR2', 'IR3'],
  R: ['R1', 'R2'],
  S: ['S1', 'S2', 'S3'],
  E: ['E1', 'E2', 'E3'],
  A: ['A1', 'A2', 'A3'],
  X: ['X1', 'X2', 'X3'],
});

/**
 * Score every zone on six axes, 100 points.
 *
 *     IR information resistance 30 · R reachability 15 · S redundancy & exit 15
 *     E endgame spots 15 · A amenities 15 · X exposure 10
 *
 * IR replaces the hand-assigned "hideability" of the drafts with the computed
 * survival model. R1 and X3 deliberately pull in opposite directions and the page
 * must say why: the hider travels with certainty at the start, the seekers travel
 * under uncertainty later, so the best zone is cheap for you to reach now and
 * expensive for them to reach then.
 *
 * Flags cap rather than override: `pinned` caps at 45, `no_legal_spot` at 40.
 * `unreachable` and `no_service` zones are *excluded* from the ranking and listed
 * separately with their times — never silently dropped.
 *
 * Side effect, by design: this is the only function that sees both the audit rows
 * and the survival table, so it fills `QuestionAudit.survMean` in place.
 * (generate.py `score_zones`)
 *
 * @param {Object[]} zones @param {Object[]} questions
 * @param {Object<string, Array<*>>} signatures @param {Object<string, number[]>} surv
 * @param {Object} geo @param {Object} day @param {Object} times
 * @param {Object<string, number>} back @param {Object} size @param {Object} metrics
 * @param {Projection|{lat0:number,lon0:number}} projLike
 * @returns {Object<string, Object>} zoneId → `ZoneScore`
 */
export function scoreZones(zones, questions, signatures, surv, geo, day, times, back, size,
  metrics, projLike) {
  const proj = Projection.from(projLike);
  const n = zones.length;
  /** @type {Object<string, Object>} */
  const out = Object.create(null);
  if (n === 0) return out;

  /** @type {Map<string, Object>} */
  const defs = new Map();
  for (const q of QUESTIONS) defs.set(q.id, q);
  /** @type {Map<string, Object>} */
  const audits = new Map();
  for (const q of questions) audits.set(q.id, q);
  const liveIds = sortedKeys(surv).filter((qid) => defs.has(qid) && surv[qid].length === n);

  // QuestionAudit.survMean — the funnel and the question table both print it.
  for (const qid of liveIds) {
    const row = audits.get(qid);
    if (row !== undefined) {
      // Python sums a *sorted* copy, so the float accumulation order is fixed.
      const values = surv[qid].slice().sort((a, b) => a - b);
      let acc = 0.0;
      for (const v of values) acc += v;
      row.survMean = rhu(acc / n, 4);
    }
  }

  const k = getNum(S3_GREEDY_K, size.name, 4);
  const [order] = globalQuestionOrder(questions, signatures, zones, k);
  const survK = s3JointBlockShare(order, signatures, zones);
  const ref = s3ReferenceSeeker(zones);

  const hidingMin = Number(size.hidingPeriodMin);
  const radiusM = Number(size.zoneRadiusM);
  const t90 = Number(get(metrics, 't90Min') || 0.0);
  const borderBbox = (geo.bbox && geo.bbox.length)
    ? geo.bbox : bboxOf(zones.map((z) => [z.lat, z.lon]));
  const neighbourRadius = (size.name === 'small' ? 0.5 : 1.0) * M_PER_MILE;
  const neighbours = s3NeighbourCount(zones, neighbourRadius);
  const neighbourLabel = miles(neighbourRadius);

  const firstDep = Number(get(metrics, 'firstDepartureS') || 0.0);
  const gameEndS = firstDep + size.requiredHours * 3600.0;

  // `_s3_zone_last_arrival_s` is called three times per zone in the Python (median,
  // no_service flag, strands_seekers). Same value each time — computed once here.
  const lastArrivalOf = zones.map((z) => s3ZoneLastArrivalS(z, day));
  const lastArrivals = lastArrivalOf.filter((a) => a !== null);
  const medianLast = lastArrivals.length ? quantile(lastArrivals, 0.5) : null;

  // HEADWAY_WINDOW resolved once rather than per zone.
  const hwLo = 6 * 3600;
  const hwHi = 22 * 3600;

  for (let index = 0; index < n; index++) {
    const zone = zones[index];
    const metricsRows = [];
    const flags = [];

    // ── IR · information resistance ──────────────────────────────────────
    const perQ = liveIds.map((qid) => [qid, surv[qid][index], defs.get(qid).keep])
      .sort((p, q) => (p[1] - q[1]) || cmpStr(p[0], q[0]));
    let pinWorst = 0.0;
    let weighted = 0.0;
    let weights = 0.0;
    for (const [, value, cost] of perQ) {
      pinWorst = Math.max(pinWorst, (1.0 - value) / cost);
      weighted += value / cost;
      weights += 1.0 / cost;
    }
    const meanSurv = weights ? weighted / weights : 1.0;
    const joint = index < survK.length ? survK[index] : 1.0;
    const haveIr = perQ.length > 0;

    metricsRows.push(s3Metric(
      'IR1', 'Zones sharing your answers to the map\'s best questions', joint, 'share',
      haveIr ? ramp(joint, 1.0 / n, 0.10) : null, 12, 'ramp', [1.0 / n, 0.10],
      'interp',
      `Full marks if at least 10% of the map still answers exactly like you after the `
      + `seekers\' best ${num(k)} questions. The floor is 1/${num(n)} — being the only one.`,
      haveIr,
    ));
    metricsRows.push(s3Metric(
      'IR2', 'Worst single question, per card it costs', pinWorst, '0–1',
      haveIr ? rramp(pinWorst, 0.50, 0.95) : null, 10, 'rramp', [0.50, 0.95],
      'interp',
      'At 0.95 one draw-3-keep-1 question leaves 5% of the map — the uniquely-identifiable '
      + 'failure. Divided by the cards the question pays you, so an expensive question that '
      + 'finds you is less of an indictment.',
      haveIr,
    ));
    metricsRows.push(s3Metric(
      'IR3', 'Average anonymity across every live question', meanSurv, '0–1',
      haveIr ? ramp(meanSurv, 0.45, 0.78) : null, 8, 'ramp', [0.45, 0.78], 'interp',
      'Cost-weighted mean survival: general anonymity rather than the worst case. 0.5 is the '
      + 'coin-flip baseline every binary question achieves against a balanced map.',
      haveIr,
    ));

    const threats = [];
    for (const [qid, value] of perQ.slice(0, 3)) {
      const q = defs.get(qid);
      const [, wording] = s3Answer(q, signatures[qid], zones, index, ref);
      threats.push({
        questionId: qid,                                        // question_id
        label: audits.has(qid) ? audits.get(qid).label : q.label,
        surv: rhu(value, 4),
        answer: wording,
        zonesRemaining: Math.trunc(rhu(value * n)),             // zones_remaining
      });
    }

    // ── R · reachability ─────────────────────────────────────────────────
    const arrival = get(times.arrivalS, zone.zoneId);
    const travelMin = (arrival === undefined || arrival === null)
      ? null : (arrival - times.departureS) / 60.0;
    const transfers = nullish(get(times.rounds, zone.zoneId));
    const travelFrac = travelMin === null ? null : travelMin / hidingMin;
    let r1Frac = null;
    if (travelFrac !== null) {
      r1Frac = travelFrac > 1.0 ? 0.0 : plateau(travelFrac, 0.10, 0.30, 0.85, 1.00);
    }
    metricsRows.push(s3Metric(
      'R1', 'Travel time from the start, ÷ the hiding period', travelFrac, 'ratio',
      r1Frac, 9, 'plateau', [0.10, 0.30, 0.85, 1.00], 'rulebook',
      `Above 1.0 you cannot legally be here: the hiding period is `
      + `${num(size.hidingPeriodMin)} minutes and wherever you are when it ends is your `
      + `zone. Below 0.10 you are still standing where the seekers start.`,
      travelMin !== null,
    ));
    let r2Frac = null;
    if (transfers !== null) r2Frac = transfers <= 1 ? 1.0 : (transfers === 2 ? 0.6 : 0.2);
    metricsRows.push(s3Metric(
      'R2', 'Transfers on the best journey', transfers, 'changes', r2Frac, 6,
      'table', [0, 1, 2, 3], 'interp',
      'Each change on an infrequent network risks the whole window; a missed connection is '
      + 'a whole headway.',
      transfers !== null,
    ));

    // ── S · service redundancy and exit ──────────────────────────────────
    const routes = zone.routeIds.length;
    const s1Frac = routes <= 1 ? 0.2 : (routes === 2 ? 0.6 : 1.0);
    metricsRows.push(s3Metric(
      'S1', 'Distinct routes inside the zone', routes, 'routes',
      routes ? s1Frac : null, 6, 'table', [1, 2, 3], 'rulebook',
      // Both clauses are hider-negative, which is why one route scores 0.2. The U-Turn card's
      // parenthetical is a let-off for the SEEKERS — they disembark only "as long as that
      // station is serviced by another form of transit" inside the window — so a one-route
      // zone is where that escape hatch is always open and the curse fizzles. F3 above and
      // audit.js's u_turn finding read it the same way; this sentence used to say the
      // opposite. The 0.2/0.6/1.0 table is unchanged.
      'One route means the Transit Line matching question names you, and Curse of the U-Turn '
      + 'fizzles here: with no second form of transit at the station, the card\'s escape hatch '
      + 'is always open and the seekers stay on board.',
      routes > 0,
    ));
    const home = nullish(get(back, zone.zoneId));
    const exitMargin = home === null ? null : (home - gameEndS) / 60.0;
    metricsRows.push(s3Metric(
      'S2', 'Minutes of margin on the last ride home', exitMargin, 'min',
      exitMargin === null ? null : ramp(exitMargin, -60, 60), 5, 'ramp', [-60, 60],
      'interp',
      'The latest departure from here that still reaches the start location, against the end '
      + 'of a full round. You need to leave for the next round, and the Move powerup needs to '
      + 'mean something.',
      exitMargin !== null,
    ));
    const onward = s3ZoneHeadwayMin(zone, day, hwLo, hwHi);
    metricsRows.push(s3Metric(
      'S3', 'Median gap between departures from the zone', onward, 'min',
      onward === null ? null : rramp(onward, 10, 60), 4, 'rramp', [10, 60], 'rulebook',
      `The Move powerup grants ${num(size.moveGrantMin)} minutes to establish a brand-new `
      + `zone; a 60-minute headway makes that unplayable from here. Scored out of 4 rather `
      + `than 5 so the three service metrics sum to the axis\'s 15 points.`,
      onward !== null,
    ));

    // ── E · endgame spots ────────────────────────────────────────────────
    const spots = geo.available ? (get(geo.legalSpots, zone.zoneId) || []) : [];
    const osmReady = Boolean(geo.available
      && Object.prototype.hasOwnProperty.call(geo.zoneInventory, zone.zoneId));
    let spotWeight = 0.0;
    let enclosedCount = 0;
    for (const s of spots) {
      spotWeight += Number(s.weight || 0.0);
      if (s.enclosed) enclosedCount += 1;
    }
    const clusters = spots.length ? s3SpotClusters(spots, proj) : 0;
    const enclosedShare = spots.length ? enclosedCount / spots.length : 0.0;
    metricsRows.push(s3Metric(
      'E1', 'Candidate legal hiding spots', spotWeight, 'weighted count',
      osmReady ? ramp(spotWeight, 0, 12) : null, 8, 'ramp', [0, 12], 'interp',
      'Publicly accessible. The rulebook also requires a spot to be within 10 ft of a '
      + 'routable path; that test is not evaluated here, so every spot is marked '
      + 'verify-on-the-ground and features with restrictive opening hours count half — '
      + 'OpenStreetMap does not know whether a plaza is locked at night.',
      osmReady,
    ));
    metricsRows.push(s3Metric(
      'E2', 'Separate spot clusters', clusters, 'clusters',
      osmReady ? ramp(clusters, 1, 5) : null, 4, 'ramp', [1, 5], 'rulebook',
      'You may wander until the end game triggers, so separate clusters mean the seekers\' '
      + 'entry point does not decide your fate.',
      osmReady,
    ));
    metricsRows.push(s3Metric(
      'E3', 'Spots enclosed by a park, plaza or campus', enclosedShare, 'share',
      osmReady ? ramp(enclosedShare, 0.10, 0.60) : null, 3, 'ramp', [0.10, 0.60],
      'interp',
      'A spot inside a polygon beats a lone point on a pavement.',
      osmReady,
    ));

    // ── A · amenities ────────────────────────────────────────────────────
    const inv = geo.available ? (get(geo.zoneInventory, zone.zoneId) || {}) : {};
    const hits = geo.available ? (get(geo.zonePolygonHits, zone.zoneId) || {}) : {};
    let toilet = 0.0;
    if (getNum(inv, 'toilets') > 0) toilet = 1.0;
    else if (getNum(inv, 'toilets_wide') > 0) toilet = 0.5;
    if (getNum(inv, 'library') > 0 || get(hits, 'park') || getNum(inv, 'park') > 0) toilet += 1.0;
    metricsRows.push(s3Metric(
      'A1', 'A bathroom you can use', Math.min(1.0, toilet), '0–1',
      osmReady ? Math.min(1.0, toilet) : null, 6, 'ramp', [0, 1], 'rulebook',
      'The rulebook\'s strongest packing advice is to make sure there is a bathroom you can '
      + 'access. Mapped toilets score 1.0, one just outside the circle 0.5, and a library or '
      + 'park inside the circle adds 1.0.',
      osmReady,
    ));
    let food = 0;
    for (const key of ['cafe', 'restaurant', 'fast_food', 'grocery']) food += getNum(inv, key);
    metricsRows.push(s3Metric(
      'A2', 'Food and water inside the circle', food, 'places',
      osmReady ? ramp(food, 0, 6) : null, 5, 'ramp', [0, 6], 'rulebook',
      'Cafés, restaurants, fast food and groceries. The rulebook tells you to identify these '
      + 'in your zone before the round starts.',
      osmReady,
    ));
    const shelter = getNum(inv, 'shelter') * 1.5
      + Math.min(2.0, getNum(inv, 'bench') * 0.25)
      + (get(hits, 'park') ? 1.0 : 0.0);
    metricsRows.push(s3Metric(
      'A3', 'Shelter from the weather', shelter, 'score',
      osmReady ? ramp(shelter, 0, 5) : null, 4, 'ramp', [0, 5], 'interp',
      'Shelters count 1.5, benches 0.25 up to 2, a park polygon reaching the circle 1.0. '
      + 'Weather is a stated rulebook concern nothing here can forecast; shelter is the '
      + 'proxy.',
      osmReady,
    ));

    // ── X · exposure ─────────────────────────────────────────────────────
    const edge = s3EdgeFraction(zone, borderBbox, radiusM, proj);
    metricsRows.push(s3Metric(
      'X1', 'Share of your circle outside the border', edge, 'share',
      rramp(edge, 0.0, 0.35), 4, 'rramp', [0.0, 0.35], 'interp',
      'An edge zone loses usable ground and is pinned by the border measuring questions.',
      true,
    ));
    metricsRows.push(s3Metric(
      'X2', `Other zones within ${neighbourLabel}`, neighbours[index], 'zones',
      ramp(neighbours[index], 0, 8), 3, 'ramp', [0, 8], 'interp',
      'The geometric, map-free version of information resistance: it still answers when no '
      + 'map data can be read at all, and it is what a radar measures.',
      true,
    ));
    const seekerFrac = (travelMin === null || t90 <= 0) ? null : travelMin / t90;
    metricsRows.push(s3Metric(
      'X3', 'Seeker travel cost to reach you, ÷ T90', seekerFrac, 'ratio',
      seekerFrac === null ? null : ramp(seekerFrac, 0.20, 0.80), 3, 'ramp', [0.20, 0.80],
      'feed',
      'Measured on the same run as R1, from the round-start location. R1 and X3 pull in '
      + 'opposite directions on purpose: you travel here with certainty on the first bus, the '
      + 'seekers travel here later under uncertainty and often back through the hub.',
      seekerFrac !== null,
    ));

    // ── axes, caps and flags ─────────────────────────────────────────────
    /** @type {Map<string, Object>} */
    const byId = new Map();
    for (const m of metricsRows) byId.set(m.id, m);
    const axes = Object.create(null);
    const axisMax = Object.create(null);
    for (const axis of sortedKeys(S3_AXIS_OF)) {
      let earned = 0;
      let maxT = 0;
      for (const mid of S3_AXIS_OF[axis]) {
        const m = byId.get(mid);
        if (m === undefined || !m.available) continue;
        earned += m.pointsTenths;
        maxT += m.maxTenths;
      }
      axes[axis] = earned;
      axisMax[axis] = maxT;
    }
    let totalMax = 0;
    let totalEarned = 0;
    for (const axis of sortedKeys(axisMax)) totalMax += axisMax[axis];
    for (const axis of sortedKeys(axes)) totalEarned += axes[axis];
    let overall = totalMax ? Math.trunc(rhu(1000.0 * totalEarned / totalMax)) : 0;

    const zoneLast = lastArrivalOf[index];
    if (!zone.routeIds.length || zoneLast === null) flags.push('no_service');
    if (travelMin === null) flags.push('unreachable');
    else if (travelMin > hidingMin) flags.push('unreachable');
    let cheapPin = 0.0;
    for (const [, value, cost] of perQ) {
      if (cost === 1) cheapPin = Math.max(cheapPin, 1.0 - value);
    }
    if (cheapPin >= 0.95) flags.push('pinned');
    if (osmReady && spotWeight <= 0.0) flags.push('no_legal_spot');
    if (osmReady && toilet <= 0.0) flags.push('no_toilet');
    if (medianLast !== null && zoneLast !== null && zoneLast <= medianLast - 3600) {
      flags.push('strands_seekers');
    }
    if (edge > 0.25) flags.push('edge_zone');
    if (osmReady) {
      let thin = 0;
      for (const key of sortedKeys(inv)) if (key !== 'toilets_wide') thin += inv[key];
      if (thin < 10) flags.push('osm_thin');
    }

    let cappedBy = null;
    if (flags.includes('pinned') && overall > 450) { overall = 450; cappedBy = 'pinned'; }
    if (flags.includes('no_legal_spot') && overall > 400) {
      overall = 400;
      cappedBy = 'no_legal_spot';
    }

    const excluded = flags.includes('unreachable') || flags.includes('no_service');
    let reason = '';
    if (flags.includes('no_service')) {
      reason = 'No departures from this zone on the selected service day.';
    } else if (flags.includes('unreachable')) {
      reason = `Not reachable from the start location inside the `
        + `${num(size.hidingPeriodMin)}-minute hiding period`
        + (travelMin !== null ? ` (${mins(travelMin)}).` : ' — no journey found at all.');
    }

    out[zone.zoneId] = {
      zoneId: zone.zoneId,
      overallTenths: overall,                 // overall_tenths
      cappedBy,                               // capped_by
      axes,
      axisMax,                                // axis_max
      metrics: metricsRows,
      flags: Array.from(new Set(flags)).sort(cmpStr),
      threats,
      survK: rhu(joint, 4),                   // surv_k
      pinWorst: rhu(pinWorst, 4),             // pin_worst
      meanSurv: rhu(meanSurv, 4),             // mean_surv
      excluded,
      excludeReason: reason,                  // exclude_reason
    };
  }
  return out;
}

/**
 * Rank key `(−overallTenths, −IR, −R, zoneId)`. Fully deterministic.
 *
 * Excluded zones (unreachable, or no service on the selected day) are left out of
 * the ranking; they are never dropped from `zoneScores`, so the page can list them
 * separately with their times.
 * (generate.py `rank_zones`)
 *
 * @param {Object<string, Object>} zoneScores @returns {string[]}
 */
export function rankZones(zoneScores) {
  const live = sortedKeys(zoneScores).filter((z) => !zoneScores[z].excluded);
  return live.sort((a, b) => (zoneScores[b].overallTenths - zoneScores[a].overallTenths)
    || (getNum(zoneScores[b].axes, 'IR') - getNum(zoneScores[a].axes, 'IR'))
    || (getNum(zoneScores[b].axes, 'R') - getNum(zoneScores[a].axes, 'R'))
    || cmpStr(a, b));
}

/**
 * Choose the diversified dossier set by deterministic maximal marginal relevance.
 *
 * Walk the ranked list and accept a zone when it is at least `8 × zoneRadius` from
 * every already-accepted zone, or when it scores ≥5 points better than the nearest
 * accepted one. Target `min(12, max(6, round(n / 25)))`. Then append the **axis
 * winners** — the top zone on each of IR, R, S, E, A, X — so the most
 * information-resistant zone on the map appears even if it ranks 60th overall
 * because it has no toilet.
 * (generate.py `select_dossiers`)
 *
 * @param {string[]} ranked @param {Object<string, Object>} zoneScores
 * @param {Object<string, Object>} zones zoneId → `Zone`
 * @param {number} radiusM
 * @returns {string[]}
 */
export function selectDossiers(ranked, zoneScores, zones, radiusM) {
  const n = ranked.length;
  if (n === 0) return [];
  const target = Math.min(12, Math.max(6, Math.trunc(rhu(n / 25.0))));
  if (n <= 12) return ranked.slice();

  const separation = 8.0 * radiusM;
  const accepted = [];
  for (const zid of ranked) {
    const z = get(zones, zid);
    if (z === undefined || z === null) continue;
    if (!accepted.length) { accepted.push(zid); continue; }
    let nearest = accepted[0];
    let nearestD = Infinity;
    for (const other of accepted) {
      const oz = get(zones, other);
      if (oz === undefined || oz === null) continue;
      const dd = Math.hypot(z.x - oz.x, z.y - oz.y);
      if (dd < nearestD) { nearestD = dd; nearest = other; }
    }
    const better = zoneScores[zid].overallTenths >= zoneScores[nearest].overallTenths + 50;
    if (nearestD >= separation || better) accepted.push(zid);
    if (accepted.length >= target) break;
  }

  for (const axis of ['IR', 'R', 'S', 'E', 'A', 'X']) {
    const winner = ranked.slice().sort((a, b) => (getNum(zoneScores[b].axes, axis)
      - getNum(zoneScores[a].axes, axis))
      || (zoneScores[b].overallTenths - zoneScores[a].overallTenths)
      || cmpStr(a, b))[0];
    if (!accepted.includes(winner)) accepted.push(winner);
  }
  return accepted;
}

// ═══════════════════════════════════════════════════════════════════════════════
// S3 · FINDINGS, HOUSE RULES, PROVENANCE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mitigations keyed by metric id. A minus with a mitigation becomes a `concern`
 * (something you can play around); a minus without one stays a `minus`.
 * (generate.py `_S3_MITIGATION`)
 */
const S3_MITIGATION = Object.freeze({
  A2: 'Move the start location to a stop nearer the middle of the network, or play the next '
    + 'size down so the hiding period matches the map.',
  B1: 'Pre-brief the dead question list before the round starts, so nobody spends a card '
    + 'buying a null.',
  B4: 'Consider removing Randomize from the deck, or agreeing that a randomize onto a '
    + 'known-dead question is rerolled.',
  C1: 'Agree that the seekers may check the live timetable at any time; on this map the wait '
    + 'is the game.',
  C2: 'Shrink the border, or step the game size up one so the hiding period matches how long '
    + 'crossing this map takes.',
  D1: 'Set an explicit end-of-game timer rather than playing until the buses stop.',
  D2: 'End the round earlier than the size\'s nominal length, or move the start time earlier.',
  D3: 'Check the date you are playing against the feed\'s own calendar: this feed has days that '
    + 'run materially less service.',
  E1: 'Play on a weekday or Saturday rather than a Sunday.',
  E2: 'Fix the day of the week before anyone plans anything else.',
  F1: 'Ban camping the hub, or make the hub a neutral zone the seekers may not linger in.',
  F2: 'Consider trimming the outermost isolated zones out of the map.',
  F3: 'Expect Curse of the U-Turn to fizzle and Transit Line to be strong; brief both.',
});

/**
 * One factual sentence about a metric, in that metric's own units.
 * (generate.py `_s3_finding_detail`)
 */
function s3FindingDetail(metric, metrics, questions) {
  const mid = metric.id;
  const raw = metric.raw;
  const r = raw || 0;
  if (mid === 'A1') {
    return `${num(r)} distinct hiding zones at the size\'s zone radius, from `
      + `${num(get(metrics, 'servedStops') || 0)} served stops.`;
  }
  if (mid === 'A2') {
    return `${num(get(metrics, 'reachWithinHidingPeriod') || 0)} of `
      + `${num(get(metrics, 'servedStops') || 0)} served stops are inside the hiding `
      + 'period from the start location.';
  }
  if (mid === 'A3') {
    return `${pct(r)} of zones still share their answers with at least one other zone `
      + 'after the map\'s best questions.';
  }
  if (mid === 'B1') {
    const dead = questions.filter((q) => q.status === 'dead' || q.status === 'degenerate');
    return `${num(dead.length)} of ${num(questions.length)} questions in this size\'s catalogue are `
      + 'dead or degenerate, and every one of them still pays the hider a card if asked.';
  }
  if (mid === 'B2') {
    return `${pct(r)} of the size\'s question categories have two or more functional questions.`;
  }
  if (mid === 'B3') {
    return `Mean quality across the functional questions is ${num(r * 100, 0)} out of 100.`;
  }
  if (mid === 'B4') {
    return `A Randomize redraw lands on a dead or degenerate question about `
      + `${pct(r)} of the time.`;
  }
  if (mid === 'C1') {
    return `The median served stop sees a bus every ${mins(r)} between 06:00 and 22:00, `
      + 'counting every route together.';
  }
  if (mid === 'C2') {
    return `Crossing the network takes ${mins(get(metrics, 't90Min') || 0, 1)} at the 90th `
      + `percentile, which is ${num(r, 2)} hiding periods.`;
  }
  if (mid === 'C3') {
    return `${pct(r)} of served stops have a single route-direction at 15 minutes or better.`;
  }
  if (mid === 'D1') {
    return `Service spans ${num(get(metrics, 'spanHours') || 0, 1)} hours, from `
      + `${hhmm(get(metrics, 'firstDepartureS') || 0)} to `
      + `${hhmm(get(metrics, 'lastDepartureS') || 0)}.`;
  }
  if (mid === 'D2') return `${pct(r)} of zones still have a departure at the end of a full round.`;
  if (mid === 'D3') {
    return `${pct(r)} of the dates in the feed\'s validity window run full service; `
      + `${num((get(metrics, 'noServiceDates') || []).length)} have no service at all.`;
  }
  if (mid === 'E1') {
    const sat = nullish(get(metrics, 'satTripRatio'));
    const sun = nullish(get(metrics, 'sunTripRatio'));
    const parts = [];
    if (sat !== null) parts.push(`Saturday runs ${pct(sat)} of a weekday\'s trips`);
    if (sun !== null) parts.push(`Sunday runs ${pct(sun)}`);
    return parts.length ? `${parts.join('; ')}.` : `Weekend ratio ${num(r, 2)}.`;
  }
  if (mid === 'E2') {
    return `About ${num(r * 7, 1)} of the 7 calendar days are fully playable.`;
  }
  if (mid === 'F1') {
    return `The busiest stop carries ${pct(r)} of all routes, and the network reads as `
      + `${get(metrics, 'networkShape')}.`;
  }
  if (mid === 'F2') return `${pct(r)} of zones have no other zone within two zone radii.`;
  if (mid === 'F3') return `${pct(r)} of served stops carry a second route.`;
  return `${metric.name}: ${num(r, 3)} ${metric.unit}.`;
}

/**
 * The service day a finding is really about, or null.
 * (generate.py `_s3_day_sensitive`)
 */
function s3DaySensitive(metricId, metrics) {
  if (!['E1', 'E2', 'C1', 'C3', 'D1', 'D2'].includes(metricId)) return null;
  const sat = nullish(get(metrics, 'satTripRatio'));
  const sun = nullish(get(metrics, 'sunTripRatio'));
  if (sun !== null && (sat === null || sun <= sat)) return nullish(get(metrics, 'sundayDayKey'));
  if (sat !== null) return nullish(get(metrics, 'saturdayDayKey'));
  return null;
}

/**
 * Emit the findings quadrants from threshold crossings, not from prose.
 *
 * A metric earning `< 0.35` of its maximum emits a *minus* (or a *concern* when the
 * static mitigation table has an entry for its id); `> 0.85` emits a *plus*.
 * Returns rows sorted by `(quadrant, −severity, metricId)`.
 *
 * The **benefit** quadrant has no computable source beyond `fare_attributes.txt`,
 * which this function is not handed, so it is dropped rather than invented — which
 * is what the contract asks for when the source is absent.
 * (generate.py `derive_findings`)
 *
 * @param {Object} fitness @param {Object} metrics @param {Object[]} questions
 * @returns {Object[]} `Finding[]`
 */
export function deriveFindings(fitness, metrics, questions) {
  const rank = { high: 2, medium: 1, low: 0 };
  const rows = [];
  if (!fitness || !fitness.subscores) return rows;
  const subs = fitness.subscores.slice().sort((a, b) => cmpStr(a.id, b.id));
  for (const sub of subs) {
    const ms = sub.metrics.slice().sort((a, b) => cmpStr(a.id, b.id));
    for (const metric of ms) {
      if (!metric.available || metric.maxTenths <= 0) continue;
      const frac = metric.pointsTenths / metric.maxTenths;
      if (frac >= 0.35 && frac <= 0.85) continue;
      let mitigation = nullish(get(S3_MITIGATION, metric.id));
      let quadrant;
      let severity;
      let title;
      if (frac < 0.35) {
        quadrant = mitigation ? 'concern' : 'minus';
        severity = frac < 0.15 ? 'high' : (frac < 0.25 ? 'medium' : 'low');
        title = `${metric.name} scores ${num(metric.pointsTenths / 10.0, 1)} of `
          + `${num(metric.maxTenths / 10.0, 1)}`;
      } else {
        quadrant = 'plus';
        mitigation = null;
        severity = frac >= 0.98 ? 'high' : (frac >= 0.92 ? 'medium' : 'low');
        title = `${metric.name} is a strength here`;
      }
      rows.push({
        quadrant,
        severity,
        metricId: metric.id,                                    // metric_id
        title,
        detail: s3FindingDetail(metric, metrics, questions),
        mitigation,
        daySensitive: s3DaySensitive(metric.id, metrics),       // day_sensitive
      });
    }
  }
  rows.sort((a, b) => cmpStr(a.quadrant, b.quadrant)
    || (rank[b.severity] - rank[a.severity])
    || cmpStr(a.metricId, b.metricId));
  return rows;
}

/**
 * Fire the house rules whose preconditions hold, in fixed priority order.
 *
 * One rule **always** fires: agree the safety exclusions — the rulebook demands
 * that conversation and explicitly refuses to automate the polygon.
 * (generate.py `derive_recommendations`)
 *
 * @param {Object} reportParts `{metrics, fitness, size, hub, border, curses, questions, feed}`
 * @returns {Object[]} `Recommendation[]`
 */
export function deriveRecommendations(reportParts) {
  const metrics = get(reportParts, 'metrics') || {};
  const fitness = nullish(get(reportParts, 'fitness'));
  const size = reportParts.size;
  const hub = nullish(get(reportParts, 'hub'));
  const border = nullish(get(reportParts, 'border'));
  const curses = get(reportParts, 'curses') || [];
  const questions = get(reportParts, 'questions') || [];
  const feed = nullish(get(reportParts, 'feed'));

  const perDay = get(metrics, 'perDay') || {};
  const bestKey = get(metrics, 'bestDay') || '';
  const bestLabel = get(get(perDay, bestKey) || {}, 'dayLabel') || bestKey || 'the busiest day';
  const out = [];

  const add = (rid, priority, text, evidence, required = false) => {
    out.push({ id: rid, priority, text, evidence, required });
  };

  // 1 · which day
  const weekend = nullish(get(metrics, 'weekendRatio'));
  if (weekend !== null && Number(weekend) < 0.60) {
    add('play_day', 10,
      `Play on ${bestLabel}. Service on the quieter weekend day drops to `
      + `${pct(Number(weekend))} of a weekday\'s trips, and every question that depends on `
      + 'being able to move gets worse with it.',
      `E1 weekend_ratio = ${num(Number(weekend), 2)}`, Number(weekend) < 0.35);
  } else {
    add('play_day', 10,
      `Any day works here, but ${bestLabel} carries the most service and is the day every `
      + 'number on this page is computed for.',
      `best day = ${bestKey}`);
  }

  // 2 · where the round starts
  if (hub !== null && hub.dominant) {
    add('start_at_hub', 20,
      `Start every round at ${hub.name}. It touches ${pct(hub.routeShare)} of the network\'s `
      + 'routes, so it is the only place from which the whole map is reachable inside the '
      + 'hiding period — and it is where the seekers will start anyway.',
      `F1 hub_dominance = ${num(hub.routeShare, 3)}, network shape `
      + `${get(metrics, 'networkShape')}`);
  } else if (hub !== null) {
    const alts = hub.alternatives.slice(0, 3).map(([, name]) => name).join(', ');
    add('start_at_hub', 20,
      `This network has no dominant hub, so agree a start station before you begin. The `
      + `three busiest are ${hub.name}${alts ? `, ${alts}` : ''}.`,
      `network shape ${get(metrics, 'networkShape')}`);
  }

  // 3 · the border
  if (border !== null) {
    // The four decimal degrees used to be spelled out here, which made this the third
    // place the page printed them (the map's own coordinate table and the GeoJSON block
    // being the other two). The map is now their single home; this rule points at it and
    // the renderer appends them to the COPIED checklist, so the copy-paste artefact
    // still stands alone. (2026-08-23.)
    add('use_borders', 30,
      'Use exactly the border printed under the map, and copy the GeoJSON rather than '
      + 'redrawing it. The rulebook is emphatic that every player must be using the same '
      + 'set of borders, and on this map the border decides which questions work at all.',
      `border padded by ${num(border.padM)} m — one hiding-zone radius, so every legal zone `
      + 'lies wholly inside', true);
  }

  // 4 · is this a transit game at all
  if (fitness !== null && fitness.score !== null && fitness.score < 35.0) {
    add('consider_variant', 34,
      `This system rates ${num(fitness.score, 1)} out of 100 — ${fitness.band.toLowerCase()}. `
      + 'Before you house-rule around it, read the rulebook\'s cars or on-foot variant: with '
      + 'no transit system the map is just borders and hiding zones centre on street '
      + 'termini, which is a better game than a broken transit one.',
      `fitness ${num(fitness.score, 1)} / 100, band “${fitness.band}”`, true);
  }

  // 5 · does the inferred size actually fit
  const implied = get(metrics, 'impliedSize');
  if (implied && implied !== size.name) {
    add('resize_map', 35,
      `The map\'s own numbers point at a ${implied.toUpperCase()} game while the parameters in use `
      + `are ${size.name.toUpperCase()}. Either shrink the border or switch size — the hiding period `
      + 'and the zone radius are what make distance mean something.',
      `axes imply ${implied}, running as ${size.name}`);
  }

  // 6 · the dead list
  const dead = questions.filter((q) => q.status === 'dead' || q.status === 'degenerate');
  if (dead.length) {
    const sample = dead.slice().sort((a, b) => cmpStr(a.id, b.id)).slice(0, 5)
      .map((q) => q.label).join(', ');
    add('brief_dead_questions', 40,
      `Read the dead list out before the first round. ${num(dead.length)} questions here `
      + `return null or a known answer — ${sample}`
      + `${dead.length > 5 ? '…' : ''} — and asking one costs the seekers a slot and pays `
      + 'the hider a card.',
      `B1: ${num(dead.length)} dead or degenerate questions`,
      dead.length > questions.length / 3);
  }

  // 7 · the deck
  const removals = curses.filter((c) => c.action === 'remove');
  if (removals.length) {
    const names = s3Join(removals.slice().sort((a, b) => cmpStr(a.id, b.id)).map((c) => c.name));
    add('remove_curses', 45,
      `Take ${num(removals.length)} curse${removals.length !== 1 ? 's' : ''} out of the deck `
      + `before you shuffle: ${names}. Each one is either uncastable here or explicitly `
      + 'removed by the rulebook.',
      'Curse deck audit, tiers 1 and 2', true);
  }
  const choices = curses.filter((c) => c.action === 'player-choice');
  if (choices.length) {
    add('no_spending_toggle', 46,
      'Decide as a group whether anyone has to spend money during the game. Egg Partner, '
      + 'Impressionable Consumer and Lemon Phylactery all require a purchase; the rulebook '
      + 'flags the first two and is silent about the third, which is an inconsistency. Treat '
      + 'them as one switch.',
      'rules.md ambiguity spending_curse_inconsistency');
  }

  // 8 · when it ends
  const medianLast = get(metrics, 'medianLastDepartureS');
  if (medianLast) {
    add('end_timer', 50,
      `Set an end-of-game timer at ${hhmm(Number(medianLast) - 1800)}. That is 30 minutes `
      + 'before the median last departure, which is the point after which a hider in an '
      + 'average zone can no longer get anywhere — including home.',
      `median last departure ${hhmm(Number(medianLast))}`);
  }

  // 9 · fares
  // On a merged run `fare_attributes` holds ONE feed's rows (see gtfs/merge.js): the
  // primary's when it has fares, otherwise the first feed in merge order that does.
  // This rule quotes one price as the fare for the whole map, so when the merge says
  // which operator it quoted (`feed.fareAgency`, merged runs only) the sentence names
  // them rather than saying "this feed" of a feed that is several.
  if (feed !== null) {
    const fares = (feed.tables && get(feed.tables, 'fare_attributes')) || [];
    if (fares.length) {
      const row = fares[0];
      const price = getNum(row, 'price', '');
      const currency = getNum(row, 'currency_type', '');
      const transfers = getNum(row, 'transfers', '');
      let note = '';
      if (transfers !== '') {
        note = String(transfers) !== '0'
          ? ' Transfers are included.'
          : ' Transfers are not included, so budget a fare per boarding.';
      }
      const fareAgency = String(get(feed, 'fareAgency') || '');
      const whose = fareAgency ? `on ${fareAgency}` : 'in this feed';
      add('carry_fare', 55,
        `Carry fare. A single ride is ${price} ${currency} ${whose}.${note} Both sides `
        + 'will board more often than they expect.',
        'fare_attributes.txt');
    }
  }

  // 10 · the size's own limits
  add('answer_limits', 60,
    `A ${size.name.toUpperCase()} game gives ${num(size.photoLimitMin)} minutes to answer a photo `
    + `question and ${num(size.otherLimitMin)} minutes for everything else, and the Move `
    + `powerup grants ${num(size.moveGrantMin)} minutes. Put a visible timer on it.`,
    `rulebook size table, ${size.name}`);
  add('hand_limit', 61,
    'Hand limit is 6, raised to 7 or 8 only by Draw 1 Expand 1. Going over forces an immediate '
    + 'play-or-discard, and time bonuses only count if you are still holding them at the end.',
    'rulebook, hider deck');

  // 11 · frequency and reachability warnings
  const headway = nullish(get(metrics, 'medianHeadwayMin'));
  if (headway !== null && Number(headway) > 30) {
    add('check_timetable', 62,
      `Agree that either side may check live departures at any time. The median stop here `
      + `sees a bus every ${mins(Number(headway))}; without the timetable the game becomes a `
      + 'coin flip about which bus somebody caught.',
      `C1 median_headway_min = ${num(Number(headway), 1)}`);
  }
  const reach = nullish(get(metrics, 'reachableZoneShare'));
  if (reach !== null && Number(reach) < 0.85) {
    add('reachability_brief', 64,
      `Warn the hider that only ${pct(Number(reach))} of the map is reachable inside the `
      + 'hiding period from the start location. Plan the journey before the clock starts — '
      + 'the rulebook\'s advice is to go somewhere you know you can get to.',
      `A2 reachable_zone_share = ${num(Number(reach), 3)}`);
  }

  // 12 · borderline questions
  const borderline = questions.filter((q) => q.borderline);
  if (borderline.length) {
    const subjects = [];
    for (const q of borderline.slice().sort((a, b) => cmpStr(a.id, b.id))) {
      if (!subjects.includes(q.label)) subjects.push(q.label);
    }
    const sample = s3Join(subjects.slice(0, 3));
    add('settle_borderline', 66,
      `Settle the edge cases out loud before the round. ${sample}`
      + `${subjects.length > 3 ? '…' : ''} sits just outside the border, so `
      + `${num(borderline.length)} question`
      + `${borderline.length !== 1 ? 's' : ''} would change status if you drew the line `
      + 'slightly wider. A player checking on their phone will see the feature and argue.',
      `${num(borderline.length)} borderline questions across ${num(subjects.length)} subjects`,
      true);
  }

  // 13 · rail-free feeds
  const railIds = ['measuring.rail_station', 'measuring.high_speed_rail', 'tentacle.metro_line',
    'photo.train_platform'];
  const railDead = questions.filter((q) => railIds.includes(q.id) && q.status === 'dead');
  if (railDead.length >= 2) {
    const names = s3Join(railDead.slice().sort((a, b) => cmpStr(a.id, b.id)).map((q) => q.label));
    add('no_rail_note', 67,
      `There is no rail mode in this feed, so ${names} are dead. Brief the seekers: that is `
      + `${num(railDead.length)} question${railDead.length !== 1 ? 's' : ''} that pay the `
      + 'hider a card and teach nothing.',
      'GTFS route types: no route_type in the rail-like set');
  }

  // 14 · long games need rest
  if (size.name === 'large') {
    add('rest_periods', 70,
      'Agree rest periods in advance — at least 10 hours is the rulebook\'s recommendation — '
      + 'and remember that everyone resumes from their exact position, and that the '
      + 'publicly-accessible test for a hiding spot does not apply during a rest period.',
      'rulebook, game sizes');
  }

  // 15 · the one rule that always fires
  add('safety_exclusions', 90,
    'Before anything else, agree which areas are off the map because someone does not feel '
    + 'safe going there. The rulebook requires this conversation and refuses to automate '
    + 'it. Exclude those stops and routes so every number on these pages matches the map '
    + 'you are playing.',
    'The rulebook requires this conversation and explicitly refuses to automate it.',
    true);

  out.sort((a, b) => (a.priority - b.priority) || cmpStr(a.id, b.id));
  return out;
}

/**
 * The browser's stand-in for `sys.argv`: a synthesised echo of the Options form.
 *
 * CONTRACT.md §(c) drops `argv` from `Options`, but §(b) `Provenance.argv` must
 * still show what was asked for. Only non-default fields are echoed, in a fixed
 * key order, so two identical form submissions produce identical provenance.
 *
 * A merged run echoes one `--feed <label>` per source, in merge order, instead of
 * the single positional: `Options.source` is a display string that joins the labels
 * with ' + ', and a reader who wants to reproduce the run needs them separated. A
 * single-source run is byte-identical to what it was before the merge existed.
 */
function synthArgv(opts, feeds = []) {
  const argv = [];
  const src = get(opts, 'source');
  if (feeds.length > 1) {
    for (const f of feeds) argv.push('--feed', String(f.label || f.source || ''));
  } else if (typeof src === 'string' && src) argv.push(src);
  else if (src && typeof src === 'object' && src.name) argv.push(String(src.name));
  if (get(opts, 'useOsm') === false) argv.push('--no-osm');
  // No such CLI flag — `generate.py` predates the world files — but §(b) asks what was
  // asked for, not what a shell would accept, and "which copy of the map did these
  // counts come from" is the single most load-bearing thing a reader can check when
  // two runs of the same feed disagree. Echoed only when set, so the default run's
  // argv is byte-identical to what it was before this option existed.
  if (get(opts, 'worldBaseUrl')) argv.push('--world-base-url', String(opts.worldBaseUrl));
  if (get(opts, 'asOf')) argv.push('--as-of', String(opts.asOf));
  if (get(opts, 'sizeOverride')) argv.push('--size', String(opts.sizeOverride));
  if (nullish(get(opts, 'zoneRadiusM')) !== null) {
    argv.push('--zone-radius', String(opts.zoneRadiusM));
  }
  if (nullish(get(opts, 'hidingPeriodMin')) !== null) {
    argv.push('--hiding-period', String(opts.hidingPeriodMin));
  }
  if (get(opts, 'startStopId')) argv.push('--start-stop', String(opts.startStopId));
  if (get(opts, 'borderShape') && opts.borderShape !== 'bbox') {
    argv.push('--border-shape', String(opts.borderShape));
  }
  const bb = get(opts, 'borderBbox');
  if (bb) argv.push('--border-bbox', bb.join(','));
  for (const sid of (get(opts, 'excludeStops') || [])) argv.push('--exclude-stop', String(sid));
  for (const rid of (get(opts, 'excludeRoutes') || [])) argv.push('--exclude-route', String(rid));
  if (get(opts, 'departure')) argv.push('--departure', String(opts.departure));
  if (get(opts, 'boardSlackS')) argv.push('--board-slack', String(opts.boardSlackS));
  if (get(opts, 'offline')) argv.push('--offline');
  if (get(opts, 'refresh')) argv.push('--refresh');
  return argv;
}

/**
 * Assemble the provenance block: what was fetched, what was assumed.
 *
 * Contains **no timestamp** that is not derived from `feed_info` or `options.asOf`.
 * (generate.py `build_provenance`)
 *
 * @param {Object} opts @param {Object} feed @param {Object} geo @param {Object} size
 * @param {string} asOf @param {string[]} degradations
 * @returns {Object} a `Provenance`
 */
export function buildProvenance(opts, feed, geo, size, asOf, degradations) {
  // One row per input feed, in merge order — length 1 for an ordinary run. §09 prints
  // them all: a merged report that showed a single sha256 would be lying about what
  // it read.
  const feeds = Array.from(get(feed, 'sources') || []);
  let agencies = [];
  for (const row of ((feed.tables && get(feed.tables, 'agency')) || [])) {
    agencies.push({
      name: getNum(row, 'agency_name', '') || feed.agencyName,
      url: getNum(row, 'agency_url', '') || feed.agencyUrl,
      timezone: getNum(row, 'agency_timezone', '') || feed.timezone,
    });
  }
  if (!agencies.length) {
    agencies = [{ name: feed.agencyName, url: feed.agencyUrl, timezone: feed.timezone }];
  }

  // One row per category. The `nominatim` bucket that used to sit alongside this is
  // gone: no provenance row starts with 'nominatim' any more, so the branch that
  // filled it was unreachable and the array was always empty.
  const overpass = [];
  const queries = (geo.queries || []).slice()
    .sort((a, b) => cmpStr(a.key, b.key) || cmpStr(a.cacheKey, b.cacheKey));
  for (const q of queries) {
    overpass.push({
      key: q.key,
      selector: q.selector,
      bbox: Array.from(q.bbox),
      count: q.count,
      cacheKey: q.cacheKey,
      endpoint: q.endpoint,
      partial: q.partial,
    });
  }

  const adminLevels = Object.create(null);
  for (const k of ['1', '2', '3', '4']) adminLevels[k] = nullish(get(geo.admin.ordinals, k));

  const interpretations = INTERPRETATIONS.slice()
    .sort((a, b) => cmpStr(a.id, b.id))
    .map((row) => ({ id: row.id, text: row.text, affects: Array.from(row.affects) }));

  return {
    feedUrl: feed.source,                       // feed_url
    feedSha256: feed.sha256,                    // feed_sha256
    feedVersion: feed.feedVersion,              // feed_version
    publisher: feed.publisher,
    feedStart: feed.feedStart,                  // feed_start
    feedEnd: feed.feedEnd,                      // feed_end
    asOf,                                       // as_of
    agencies,
    generator: GENERATOR,
    version: VERSION,
    argv: synthArgv(opts, feeds),
    feeds,
    overpass,
    osmAvailable: geo.available,                // osm_available
    osmNotes: Array.from(geo.notes || []),      // osm_notes
    adminLevels,                                // admin_levels
    // The manifest's own `admin_source` ('overture' / 'osm'), NOT `geo.admin.source`,
    // which has only ever held 'world' or 'unknown' and so told a reader nothing.
    adminSource: geo.admin.adminSource || geo.admin.source,   // admin_source
    countryCode: geo.admin.countryCode,         // country_code
    countryName: geo.admin.countryName,         // country_name
    placeName: geo.admin.placeName,             // place_name
    gameSize: size.name,                        // game_size
    sizeInferred: size.inferred,                // size_inferred
    hidingPeriodMin: size.hidingPeriodMin,      // hiding_period_min
    zoneRadiusM: rhu(size.zoneRadiusM, 3),      // zone_radius_m
    catalogueSize: size.catalogueSize,          // catalogue_size
    greedyK: getNum(S3_GREEDY_K, size.name, 4), // greedy_k
    seekerSampleCap: SEEKER_SAMPLE_CAP,         // seeker_sample_cap
    startStopId: nullish(get(opts, 'startStopId')),   // start_stop_id
    departure: get(opts, 'departure'),
    boardSlackS: get(opts, 'boardSlackS'),      // board_slack_s
    excludedStops: Array.from(get(opts, 'excludeStops') || []),   // excluded_stops
    excludedRoutes: Array.from(get(opts, 'excludeRoutes') || []), // excluded_routes
    llmUsed: false,                             // llm_used — the LLM path is dropped in the port
    // No Python counterpart: the CLI's cache is a directory and is always persistent.
    // The browser's is IndexedDB when it can be opened and a per-run Map when it
    // cannot (a locked-down profile, private browsing, Node), and the fallback is
    // otherwise completely silent — a reader whose value here is `memory` now knows
    // why the next run refetched the whole feed. Read from the module rather than
    // taken as an argument because the Cache never reaches the scoring layer.
    cacheBackend: cacheBackend(),
    interpretations,
    degradations: Array.from(degradations || []),
  };
}
