// render/strategy.js — the secret hider's guide (generate.py S5), static markup.
//
// Ported from:
//   render_strategy         15533  — the hero, the pull quote, the five sections
//   strategy_pick_card      14309                              → the hero's #1 card
//   strategy_shortlist      14608  + strategy_zone_map 14459,
//                                    strategy_zone_list 14570,
//                                    strategy_dossier_template 14596  → §01 `#s-zones`
//   strategy_all_candidates 14618                              → §02 `#s-all`
//   strategy_tactics        14734                              → §03 `#s-tactics`
//   strategy_axes           14380                              → §04 `#s-axes`
//   strategy_provenance     14856                              → §05 `#s-method`
//   the constants and helpers at 13814–13998 (_S5_AXES … _s5_travel_minutes) and the
//   three payload builders at 14095–14270 (_s5_zone_payload, _s5_poi_payload,
//   _s5_mode_chips), which become `zoneViews`, `poiCategories` and `modeChips`.
//
// WHAT THIS FILE IS. The CLI emits a second document, `strategy.html`, which nothing
// links to. The browser port has one document, so the guide is a second *view* of it,
// reachable only by the URL fragment `#strategy` and excluded from the "Save"
// download by `data-run-only`. Nothing in the report view mentions it. The one link
// out of here — the hero's `href="#top"` — is only visible to somebody already
// inside, which is exactly the CLI's cross-page invariant (generate.py 13539–13550).
//
// PURE, LIKE EVERY OTHER RENDERER. `Report → string`. No DOM, no `Date.now()`, no
// `Math.random()`, no listener, no side effect. `render/simulator.js` imports the
// view model from here and owns every mutation; the dependency is one-way, and it is
// one-way so that the numbers this file prints and the numbers the simulator prints
// can only ever come from `zoneViews()` — one implementation, one rounding.
//
// THE `s-` ID NAMESPACE. Every id below is prefixed `s-`, which the CLI's ids are
// not. The CLI has two documents and can afford `#top`, `#sources`, `#zmap` and
// `#axis-IR`; here all of those already belong to the report view, and a collision
// would send `openTargeted` (app.js 2160) to the wrong element. `#strategy` itself is
// the one bare id, because it is the fragment.
//
// FORMATTING DISCIPLINE, as everywhere else: every number goes through exactly one
// formatter from `../lib/core.js`. No `toFixed`, no `Math.round`, no arithmetic inside
// a template literal.
//
// @module render/strategy

import { num, pct, mins, rhu, coord, prettyDate } from '../lib/core.js';
import {
  esc, el, join, waIcon, waCard, waCallout, waButton, waBadge, waDetails,
  waScroller, waAccordion, chip, meter, searchInput, pullQuote, section, subhead,
  dataTable,
} from './html.js';
import {
  s4Dist, s4Val, s4Plural, s4NaturalCmp, s4JoinWords, s4DayLabel, s4BestDay, s4WorstDay,
  s4LiveQuestions, s4MetricLookup, s4Swatch, s4CardHeader, s4SourceTag,
} from './verdict.js';
// `render/map.js` is read-only here, exactly like `verdict.js`: the map legends are a
// shared vocabulary, and a second hand-rolled `div[role="list"]` is the thing
// `s4Legend`'s own docstring exists to stop.
import { s4Legend } from './map.js';
// The catalogue is pure frozen data and imports nothing but `lib/core.js`, so reading
// it on the main thread is safe — `render/deck.js:71` already does. It is read here for
// one field only: a tentacle question's own `param`, its reach in miles. `QuestionAudit`
// does not carry `param` across the wire (CONTRACT.md §(b)), and inventing a wire field
// the contract does not have would be the worse of the two fixes.
import { QUESTIONS } from '../rules/catalogue.js';

// ── rulebook presentation constants (read, never recomputed) ─────────────────

/**
 * The six zone axes: `(id, name, what it measures, the rulebook clause behind it)`.
 * (generate.py `_S5_AXES`, line 13814.) `simulator.js` reads this for the dossier's
 * score block, so it is exported rather than kept private.
 * @type {ReadonlyArray<readonly [string, string, string, string]>}
 */
export const AXES = Object.freeze([
  Object.freeze(['IR', 'Information resistance',
    'How many other zones give the seekers the same answers you do. A zone whose '
    + 'answer vector is shared with many others survives questioning; a zone with a '
    + 'unique answer vector is named by one cheap question.',
    'Seeking — every question is answered truthfully, so the only defence is being '
    + 'indistinguishable.']),
  Object.freeze(['R', 'Reach',
    'Whether you can actually get here inside the hiding period, and how many '
    + 'changes it costs.',
    "Hiding Zones — “if the hiding period ends and you're somewhere else, then "
    + "that's where your hiding zone is.”"]),
  Object.freeze(['S', 'Service',
    'Onward departures, the gap between them, and how much margin you have on the '
    + 'last ride out of the zone.',
    'Curses & powerups — Move costs your whole hand and needs a bus to exist.']),
  Object.freeze(['E', 'Endgame spots',
    'Publicly-accessible places inside the circle where you can legally freeze when '
    + 'a seeker walks in, and whether they are clustered or scattered.',
    'Hiding Spots — publicly accessible during all game hours, within 10 ft of a '
    + 'mapped path.']),
  Object.freeze(['A', 'Amenities',
    'A bathroom you can use, food and water, and shelter — the things that decide '
    + 'whether you can sit here for hours.',
    "Hiding — “you're free to do whatever you like”, for as long as it takes."]),
  Object.freeze(['X', 'Exposure',
    'Map-edge and radar exposure, how many neighbouring zones share your patch, and '
    + 'how expensive you are for the seekers to reach.',
    'Radar Questions — an outlier is pinned by one question; Measuring — distance '
    + 'from the seekers is itself information.']),
]);

/** `['IR','R','S','E','A','X']` — the axis order every table column and meter uses. */
export const AXIS_IDS = Object.freeze(AXES.map((a) => a[0]));

/**
 * Axis id → (the plain name the page leads with, the short word a column header can
 * hold). (generate.py `_S5_AXIS_PLAIN`, line 13851.) The rulebook's own name for the
 * axis is never dropped — it rides alongside the plain one as a quiet caption in
 * §04's accordion labels, and the letter survives as a `<code>` beside every plain
 * name and in every `data-sort` index.
 */
export const AXIS_PLAIN = Object.freeze({
  IR: Object.freeze(['How well you blend in', 'Blends in']),
  R: Object.freeze(['How easy it is to get there', 'Getting there']),
  S: Object.freeze(['How good the buses are', 'Buses']),
  E: Object.freeze(['Places you can legally freeze at the end', 'Endgame spots']),
  A: Object.freeze(["What's nearby", 'Nearby']),
  X: Object.freeze(['How hard you are to reach', 'Hard to reach']),
});

/**
 * Zone flag → `[label, wa-tag variant, icon]`. The CLI keeps the label/variant pair
 * (`_S5_FLAG_TEXT`, 13869) and the variant→icon map (`_S5_FLAG_ICON`, 13862) apart
 * and joins them when it ships `__FLAGS__` to the client (15419); the join is done
 * once, here, because both this file and `simulator.js` need the joined form. The
 * icon exists so a flag is never colour alone (html.js `chip`).
 */
export const FLAG_TEXT = Object.freeze({
  no_service: Object.freeze(['No service', 'danger', 'circle-exclamation']),
  unreachable: Object.freeze(['Unreachable in the hiding period', 'danger', 'circle-exclamation']),
  pinned: Object.freeze(['Pinned by one question', 'danger', 'circle-exclamation']),
  no_legal_spot: Object.freeze(['No legal endgame spot found', 'warning', 'triangle-exclamation']),
  no_toilet: Object.freeze(['No public toilet', 'warning', 'triangle-exclamation']),
  strands_seekers: Object.freeze(['Strands the seekers', 'warning', 'triangle-exclamation']),
  edge_zone: Object.freeze(['Circle crosses the border', 'warning', 'triangle-exclamation']),
  osm_thin: Object.freeze(['Thin OSM coverage', 'neutral', 'circle-info']),
});

/** Simulator mode → its button label, in button order. (generate.py 13892.) */
export const MODE_LABEL = Object.freeze([
  Object.freeze(['explore', 'Explore']),
  Object.freeze(['radar', 'Radar']),
  Object.freeze(['thermo', 'Thermometer']),
  Object.freeze(['match', 'Matching']),
  Object.freeze(['measure', 'Measuring']),
  Object.freeze(['tentacle', 'Tentacles']),
]);

/** Simulator mode → icon. An icon never replaces the mode's word. (13862.) */
export const MODE_ICON = Object.freeze({
  explore: 'compass',
  radar: 'magnifying-glass',
  thermo: 'temperature-half',
  match: 'equals',
  measure: 'ruler',
  tentacle: 'diagram-project',
});

/**
 * Simulator mode → the rulebook question category it simulates. (13888.)
 * Exact names, because `'measuring'.startsWith('measure')` is true but
 * `'measure' === 'measuring'` is not, and the CLI's own comment records that
 * prefix-matching here once silently disabled the whole family.
 */
export const MODE_CATEGORY = Object.freeze({
  radar: 'radar',
  thermo: 'thermometer',
  match: 'matching',
  measure: 'measuring',
  tentacle: 'tentacle',
});

/**
 * Radar question id → its radius in MILES. (generate.py `_S5_RADAR_ID_MILES`, 13898.)
 * The ids are not reconstructible in the browser — `radar.quarter_mile` and
 * `radar.3mi` are spelled differently — so the join is a table, not a parse.
 */
export const RADAR_ID_MILES = Object.freeze({
  'radar.quarter_mile': 0.25,
  'radar.half_mile': 0.5,
  'radar.1mi': 1.0,
  'radar.3mi': 3.0,
  'radar.5mi': 5.0,
  'radar.10mi': 10.0,
  'radar.25mi': 25.0,
  'radar.50mi': 50.0,
  'radar.100mi': 100.0,
});

/**
 * Tentacle question id → its OWN reach in MILES, read off the catalogue's `param`.
 *
 * THERE IS NO SUCH THING AS "THE" TENTACLE REACH OF A GAME SIZE. The rulebook lists
 * Museums / Libraries / Movie Theaters / Hospitals **Within 1 Mile**, and then "For
 * LARGE Sized Games, Add the Following: Metro Lines Within 15 Miles / Zoos Within 15
 * Miles / Aquariums Within 15 Miles / Amusement Parks Within 15 Miles" — so a LARGE
 * deck carries both reaches at once. `SizeParams.tentacleReachMi` is the deck's
 * headline figure and cannot answer "how far does THIS question reach"; the engine has
 * never used it for that either (`rules/audit.js:980` reads `question.param`).
 * @type {Object<string, number>}
 */
export const TENTACLE_ID_REACH_MI = Object.freeze(Object.fromEntries(
  QUESTIONS.filter((q) => q.category === 'tentacle').map((q) => [q.id, Number(q.param) || 0]),
));

/** Rows per page in §02's table once it pages at all. (`_S5_TABLE_PAGE`.) */
export const TABLE_PAGE = 100;
/** Below this many zones the table is never paged. (`_S5_TABLE_PAGE_ABOVE`.) */
export const TABLE_PAGE_ABOVE = 300;
/** Above this many zones the map plots score bands, not label pills. (`_S5_MAX_MAP_ZONES`.) */
export const MAX_MAP_ZONES = 1200;
/** Endgame spots carried per zone; the card states the true total. (`_S5_SPOTS_SHIPPED`.) */
export const SPOTS_SHIPPED = 10;
/** Simulator feature cap per category; the page says so when it bites. (`_S5_MAX_POI_PER_CATEGORY`.) */
export const MAX_POI_PER_CATEGORY = 500;
/**
 * The zone score's denominator, everywhere it is printed or filled into a bar.
 *
 * A constant because `overallTenths` is already renormalised — `rules/score.js:1121`
 * is `1000 × earned ÷ max` — so it is out of 100 whether or not every axis could be
 * measured. See the note in `zoneViews` and CONTRACT.md §(g) 8.
 */
export const SCORE_MAX = 100;

// ── the shared numeric helpers ───────────────────────────────────────────────
//
// Exported so `simulator.js` rounds identically. Two files printing the same score
// through two roundings is the failure this prevents.

/**
 * Integer tenths of a point → the number the page prints. (`_s5_pts`, 13912.)
 * @param {number|null|undefined} tenths @returns {number}
 */
export function pts(tenths) {
  return (tenths === null || tenths === undefined) ? 0 : rhu(tenths / 10.0, 1);
}

/**
 * Axis fill as a 0–100 percentage, guarding a zero denominator. (`_s5_bar`, 13917.)
 *
 * The guard is load-bearing rather than defensive: under `--no-osm` the `E` and `A`
 * axes really do carry `axisMax === 0` (score.js 1004), and the page must say
 * "not measured" rather than draw an empty bar labelled `0 / 0`.
 *
 * @param {number|null|undefined} earnedTenths @param {number|null|undefined} maxTenths
 * @returns {number}
 */
export function bar(earnedTenths, maxTenths) {
  if (!maxTenths) return 0;
  return rhu((100.0 * (earnedTenths || 0)) / maxTenths, 1);
}

/**
 * Colour band for the map and the rail, relative to this map's own best zone.
 * (`_s5_band`, 13932.)
 *
 * Relative rather than absolute on purpose: a 41-point zone is a bad hide on a great
 * map and the best available hide on a poor one, and the player needs to see which
 * situation they are in.
 *
 * @param {number} overall @param {number} best
 * @returns {'top'|'good'|'fair'|'weak'|'un'}
 */
export function band(overall, best) {
  if (best <= 0) return 'un';
  const share = overall / best;
  if (share >= 0.9) return 'top';
  if (share >= 0.75) return 'good';
  if (share >= 0.55) return 'fair';
  return 'weak';
}

// ── tiny deterministic primitives ────────────────────────────────────────────

/** Plain code-point comparison. Never `localeCompare` — that is locale-bound. */
function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorted keys of a plain object. Nothing here ever iterates one unsorted. */
function keysOf(obj) {
  return Object.keys(obj || {}).sort(cmpStr);
}

/** A finite number, or `null`. Guards every raw metric value before a formatter. */
function fnum(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/** `{metricId: Metric}` for one zone score. (`_s5_metric_by_id`, 13984.) */
function metricById(score) {
  const out = Object.create(null);
  for (const m of (score && score.metrics) || []) out[m.id] = m;
  return out;
}

/**
 * The first ranked zone that carries a score. (`_s5_reference_score`, 13951.)
 *
 * The per-axis maxima are identical across zones, so one of them supplies the
 * published totals every axis label, legend row and column header prints. Reading
 * them off a real zone rather than restating them keeps the page and the score from
 * ever disagreeing.
 *
 * @param {Object} report @returns {Object|null}
 */
function referenceScore(report) {
  const scores = (report && report.zoneScores) || {};
  for (const zid of (report && report.rankedZoneIds) || []) {
    if (zid in scores) return scores[zid];
  }
  return null;
}

/**
 * The OSM category keys this run actually knows about.
 *
 * DIVERGENCE, deliberate. The CLI tests `key in {c.key for c in GEO_CATEGORIES}`
 * (generate.py 14205, 14252) to tell an OSM-backed question subject from a GTFS or
 * administrative one. `GEO_CATEGORIES` lives in `osm/geodata.js`, a worker
 * module this file may not import, so the set is derived from the two `GeoData`
 * fields that are keyed by category: `counts` (every queried category, zero-count
 * ones included — absent categories are absent keys, CONTRACT.md §(b)) and `pois`.
 * Same answer for every category the run touched; a category that was never queried
 * at all is simply absent from the chips instead of appearing dead, which is the one
 * observable difference.
 */
function geoKeys(report) {
  const geo = (report && report.geo) || {};
  const out = new Set(Object.keys(geo.counts || {}));
  for (const k of Object.keys(geo.pois || {})) out.add(k);
  return out;
}

/** The part of a question id after the first dot: `matching.park` → `park`. */
function subjectKey(questionId) {
  const id = String(questionId || '');
  const dot = id.indexOf('.');
  return dot === -1 ? id : id.slice(dot + 1);
}

/** Questions in id order — the CLI sorts before every chip loop (14239, 14257). */
function questionsById(report) {
  return Array.from((report && report.questions) || []).sort((a, b) => cmpStr(a.id, b.id));
}

/**
 * The DISTINCT reaches of a set of tentacle questions, ascending, in miles.
 *
 * `[]` for a SMALL deck (which holds no tentacle question at all), `[1]` for a MEDIUM
 * one, `[1, 15]` for a LARGE one — the rulebook adds the four 15-mile tentacles to the
 * four 1-mile ones rather than replacing them, so a LARGE game has two reaches at once
 * and no single number can stand for "the" tentacle reach. See `TENTACLE_ID_REACH_MI`.
 * @param {Array<Object>} questions @returns {number[]}
 */
function tentacleReachesMi(questions) {
  const seen = new Set();
  for (const q of questions || []) {
    if (q.category !== 'tentacle') continue;
    const r = TENTACLE_ID_REACH_MI[q.id];
    if (r) seen.add(r);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/** `[1, 15]` → `'1 mile and 15 miles'`; `[]` → `''`. */
function tentacleReachWords(reaches) {
  return s4JoinWords(reaches.map((r) => `${s4Val(r)} ${s4Plural(r, 'mile')}`));
}

/** One zone flag, as icon **and** word — never colour alone. (`_s5_flag_chip`, 13962.) */
function flagChip(flag) {
  const [label, variant, icon] = FLAG_TEXT[flag] || [flag, 'neutral', 'circle-info'];
  return chip(label, icon, { variant });
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE SHARED VIEW MODEL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} ServiceView
 * @property {boolean} served @property {number} routes
 * @property {number|null} headwayMin @property {number|null} exitMarginMin
 * @property {number} frequentStops @property {number} servedStops
 * @property {string} dayLabel
 */

/**
 * @typedef {Object} ZoneView   see the module docs and CONTRACT.md §(g).
 * @property {string} id @property {number|null} rank @property {string} name
 * @property {number} lat @property {number} lon
 * @property {number} overall @property {number} max  always `SCORE_MAX`; see §(g) 8
 * @property {'top'|'good'|'fair'|'weak'|'un'} scoreBand @property {string|null} cappedBy
 * @property {Object<string,number>} axes @property {Object<string,number>} axisMax
 * @property {Object<string,number>} bars
 * @property {string[]} flags @property {boolean} excluded @property {string} excludeReason
 * @property {string[]} stopIds @property {string[]} routeIds @property {string[]} routeNames
 * @property {number|null} travelMin
 * @property {number} survK @property {number} pinWorst @property {number} meanSurv
 * @property {Object[]} threats @property {Object[]} metrics
 * @property {Object[]} spots @property {number} spotsTotal
 * @property {Object<string,number>} inventory @property {Object<string,string>} admin
 * @property {ServiceView} service
 */

/**
 * The ranked zone view model — the one place a zone becomes numbers for the page.
 *
 * Order: `report.rankedZoneIds` first, in order, carrying rank 1..n, then every
 * remaining key of `report.zoneScores` sorted by plain code-point comparison,
 * carrying `rank === null`. Those leftovers are the zones `rankZones` deliberately
 * held out — unreachable, or the designated station has no service — and they still
 * reach the page, because nothing is ever silently dropped (generate.py 14120–14126).
 *
 * `_s5_tie_break` (14062) is `--llm`-only and the port has no LLM, so it is dropped.
 *
 * @param {Object} report the complete `Report`
 * @returns {ZoneView[]}
 */
export function zoneViews(report) {
  const rep = report || {};
  const scores = rep.zoneScores || {};
  const geo = rep.geo || {};
  const feed = rep.feed || {};
  const size = rep.size || {};
  const hidingMin = Number(size.hidingPeriodMin) || 0;

  const zoneById = Object.create(null);
  for (const z of rep.zones || []) zoneById[z.zoneId] = z;

  // One pass over `report.stops` instead of one per zone: 319 zones × 2,000 stops is
  // 640,000 comparisons for a count that is a single lookup away.
  const stopById = Object.create(null);
  for (const s of rep.stops || []) stopById[s.stopId] = s;

  const ranked = Array.from(rep.rankedZoneIds || []).filter((zid) => zid in scores);
  const seen = new Set(ranked);
  const leftover = keysOf(scores).filter((zid) => !seen.has(zid));

  let bestTenths = 0;
  for (const zid of ranked) {
    const t = scores[zid].overallTenths;
    if (t > bestTenths) bestTenths = t;
  }
  const best = pts(bestTenths);
  const dayLabel = s4DayLabel(rep, s4BestDay(rep));

  const out = [];
  const ordered = ranked.concat(leftover);
  for (let i = 0; i < ordered.length; i += 1) {
    const zid = ordered[i];
    const zone = zoneById[zid];
    const score = scores[zid];
    if (!zone || !score) continue;

    const axes = Object.create(null);
    const axisMax = Object.create(null);
    const bars = Object.create(null);
    for (const a of AXIS_IDS) {
      axes[a] = pts(score.axes ? score.axes[a] : 0);
      axisMax[a] = pts(score.axisMax ? score.axisMax[a] : 0);
      bars[a] = bar(score.axes ? score.axes[a] : 0, score.axisMax ? score.axisMax[a] : 0);
    }

    // R1 is stored as travel ÷ hiding period; the page prints minutes. Derived
    // rather than re-measured — the ratio is the scored quantity and this is only
    // its presentation, so the two can never disagree. (`_s5_travel_minutes`, 13989.)
    const metrics = metricById(score);
    const r1raw = metrics.R1 ? fnum(metrics.R1.raw) : null;
    const travelMin = r1raw === null ? null : rhu(r1raw * hidingMin, 1);

    const routeNames = [];
    const routeSeen = new Set();
    for (const rid of zone.routeIds || []) {
      const route = (feed.routes || {})[rid];
      if (!route) continue;
      const label = route.shortName || route.longName || rid;
      if (routeSeen.has(label)) continue;
      routeSeen.add(label);
      routeNames.push(label);
    }
    routeNames.sort(s4NaturalCmp);

    const inventory = Object.create(null);
    const rawInv = (geo.zoneInventory || {})[zid] || {};
    for (const k of keysOf(rawInv)) if (rawInv[k]) inventory[k] = rawInv[k];

    const admin = Object.create(null);
    const rawAdmin = (((geo.admin || {}).perZone) || {})[zid] || {};
    for (const k of keysOf(rawAdmin)) admin[k] = rawAdmin[k];

    const spots = ((geo.legalSpots || {})[zid]) || [];
    const flags = Array.from(score.flags || []);

    // SCOPE-REDUCED against the CLI, and recorded as such in CONTRACT.md §(g): the
    // CLI's per-zone × per-day block reads `ServiceDay.stopDays`, which `daySummary`
    // strips before anything crosses `postMessage` (worker.js 643). What is already
    // on the main thread and already scored — S1/S2/S3 plus the stop rows — says the
    // same things minus the first/last times, the departure count and the sparkline.
    let servedStops = 0;
    let frequentStops = 0;
    for (const sid of zone.stopIds || []) {
      const row = stopById[sid];
      if (!row) continue;
      servedStops += 1;
      if (row.frequent) frequentStops += 1;
    }
    const service = {
      served: (zone.routeIds || []).length > 0 && !flags.includes('no_service'),
      routes: metrics.S1 ? (fnum(metrics.S1.raw) || 0) : 0,
      headwayMin: metrics.S3 ? fnum(metrics.S3.raw) : null,
      exitMarginMin: metrics.S2 ? fnum(metrics.S2.raw) : null,
      frequentStops,
      servedStops,
      dayLabel,
    };

    const overall = pts(score.overallTenths);
    out.push({
      id: zid,
      rank: i < ranked.length ? i + 1 : null,
      name: zone.name,
      lat: coord(zone.lat),
      lon: coord(zone.lon),
      overall,
      // DIVERGENCE, deliberate, CONTRACT.md §(g) 8. The CLI prints `overall` over the
      // sum of the raw axis maxima (14326, 14361), but `overall` is not a raw total:
      // `rules/score.js:1121` renormalises it to `1000 × earned ÷ max`, so its
      // denominator is 100 whatever the axes measured. The two agree whenever every
      // axis was measurable; when OSM is off, E and A have `axisMax === 0` and the
      // CLI's arithmetic prints "97.6 / 70.0" — and fills a progress bar to 139%.
      max: SCORE_MAX,
      scoreBand: band(overall, best),
      cappedBy: score.cappedBy === undefined ? null : score.cappedBy,
      axes,
      axisMax,
      bars,
      flags,
      excluded: Boolean(score.excluded),
      excludeReason: score.excludeReason || '',
      stopIds: Array.from(zone.stopIds || []),
      routeIds: Array.from(zone.routeIds || []),
      routeNames,
      travelMin,
      survK: score.survK,
      pinWorst: score.pinWorst,
      meanSurv: score.meanSurv,
      threats: Array.from(score.threats || []),
      metrics: Array.from(score.metrics || []),
      spots: spots.slice(0, SPOTS_SHIPPED),
      spotsTotal: spots.length,
      inventory,
      admin,
      service,
    });
  }
  return out;
}

/**
 * @typedef {{id:string, miles:number, label:string, status:string, why:string,
 *            usable:boolean}} RadarChip
 * @typedef {{key:string, qid:string, label:string, count:number, status:string,
 *            why:string, usable:boolean, reachMi:number|null}} CatChip
 *
 * `reachMi` is the tentacle chip's own reach in miles (`TENTACLE_ID_REACH_MI`), and is
 * `null` on matching and measuring chips, which have no reach at all. The simulator
 * measures against THIS number, never against `size.tentacleReachMi`.
 */

/**
 * Per-mode chip definitions, resolved once. (`_s5_mode_chips`, 14232.)
 *
 * The chips have to name a real question and a real OSM category, and neither join
 * can be reconstructed from an id in the browser: radar radii are ids like
 * `radar.quarter_mile` and `radar.3mi`, and a category chip only means something if a
 * question of that category exists *and* the features were fetched.
 *
 * DIVERGENCE: the category label comes from the `QuestionAudit`'s own `label` rather
 * than from `GEO_CATEGORIES` (see `geoKeys`). Same words in practice — the catalogue
 * names a question after its subject.
 *
 * @param {Object} report
 * @returns {{radar: RadarChip[], match: CatChip[], measure: CatChip[], tentacle: CatChip[]}}
 */
export function modeChips(report) {
  const rep = report || {};
  const geo = rep.geo || {};
  const counts = geo.counts || {};
  const pois = geo.pois || {};
  const keys = geoKeys(rep);
  const sorted = questionsById(rep);

  const radar = [];
  for (const q of sorted) {
    if (q.category !== 'radar' || String(q.id).endsWith('.choose')) continue;
    const miles = RADAR_ID_MILES[q.id];
    if (miles === undefined) continue;
    radar.push({
      id: q.id,
      miles,
      label: q.label,
      status: q.status,
      why: q.why,
      usable: q.status === 'functional' || q.status === 'weak',
    });
  }
  radar.sort((a, b) => a.miles - b.miles);

  const out = { radar };
  for (const mode of ['match', 'measure', 'tentacle']) {
    const category = MODE_CATEGORY[mode];
    const chips = [];
    for (const q of sorted) {
      if (q.category !== category) continue;
      const key = subjectKey(q.id);
      // not an OSM-backed subject (administrative borders, transit lines, sea level)
      if (!keys.has(key)) continue;
      const features = pois[key];
      chips.push({
        key,
        qid: q.id,
        label: q.label,
        count: counts[key] || 0,
        status: q.status,
        why: q.why,
        usable: (q.status === 'functional' || q.status === 'weak')
          && Array.isArray(features) && features.length > 0,
        // per QUESTION, not per game size: a LARGE deck holds 1-mile and 15-mile
        // tentacles side by side, so the chip has to carry its own reach for the
        // simulator to measure against (see `TENTACLE_ID_REACH_MI`).
        reachMi: mode === 'tentacle' ? (TENTACLE_ID_REACH_MI[q.id] ?? null) : null,
      });
    }
    out[mode] = chips;
  }
  return out;
}

/**
 * @typedef {{label:string, count:number, capped:boolean,
 *            features:Array<[number,number,string]>}} PoiCategory
 */

/**
 * The simulator's POI set. (`_s5_poi_payload`, 14195.)
 *
 * Only categories a matching / measuring / tentacle question actually uses, and only
 * where features exist. Each is capped, and `capped` names the ones where the cap
 * bit — the page says so rather than quietly answering from a subset.
 *
 * NOTE THE COORDINATE ORDER: `[lon, lat, name]`. Longitude first, which is the CLI's
 * order and GeoJSON's, and the opposite of every `haversineM(lat, lon, …)` call —
 * `simulator.js` is written against it.
 *
 * @param {Object} report
 * @returns {{categories: Object<string, PoiCategory>, capped: string[], cap: number,
 *            available: boolean}}
 */
export function poiCategories(report) {
  const rep = report || {};
  const geo = rep.geo || {};
  const pois = geo.pois || {};
  const keys = geoKeys(rep);

  // Exactly the categories a chip can select: the subject of an OSM-backed question
  // in one of the three category-driven modes.
  const labels = Object.create(null);
  const used = new Set();
  for (const q of questionsById(rep)) {
    if (q.category !== 'matching' && q.category !== 'measuring' && q.category !== 'tentacle') {
      continue;
    }
    const key = subjectKey(q.id);
    if (!keys.has(key)) continue;
    const features = pois[key];
    if (!Array.isArray(features) || features.length === 0) continue;
    used.add(key);
    if (!(key in labels)) labels[key] = q.label;
  }

  const categories = Object.create(null);
  const capped = [];
  for (const key of Array.from(used).sort(cmpStr)) {
    const all = pois[key];
    const ordered = Array.from(all).sort((a, b) => cmpStr(a.osmType, b.osmType)
      || (a.osmId - b.osmId));
    const bitten = ordered.length > MAX_POI_PER_CATEGORY;
    if (bitten) capped.push(key);
    const kept = bitten ? ordered.slice(0, MAX_POI_PER_CATEGORY) : ordered;
    categories[key] = {
      label: labels[key] || key,
      count: all.length,
      capped: bitten,
      features: kept.map((p) => [coord(p.lon), coord(p.lat), p.name]),
    };
  }
  return {
    categories,
    capped,
    cap: MAX_POI_PER_CATEGORY,
    available: Boolean(geo.available),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE HERO AND ITS PICK CARD (generate.py 14309, 15594)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * One axis row of the pick card and the dossier: plain name, letter, bar, earned/max.
 *
 * An axis whose maximum is zero was never measurable on this map — under `--no-osm`
 * that is `E` and `A` — and prints the words, never `0.0 / 0`.
 */
function axisMeter(view, axis) {
  const label = el('span', join(
    el('span', esc(AXIS_PLAIN[axis][0]), { className: 'wa-caption-s' }),
    el('code', esc(axis), { className: 'wa-caption-2xs' }),
  ), { className: 'wa-cluster wa-gap-2xs wa-align-items-center' });
  if (!view.axisMax[axis]) {
    return meter(label, 0, el('span', esc('not measured'), {
      className: 'wa-caption-s wa-color-text-quiet',
    }), { flank: '3rem' });
  }
  const right = el('span', esc(`${num(view.axes[axis], 1)} / ${num(view.axisMax[axis], 0)}`), {
    className: 'wa-caption-s wa-color-text-quiet',
  });
  return meter(label, view.bars[axis], right, { flank: '3rem' });
}

/**
 * The page's answer, above everything else: the top-ranked zone in full.
 * (`strategy_pick_card`, 14309.)
 *
 * Zone scores are not day-dependent, so this card is rendered once and never
 * re-rendered. It is consistent with the simulator's own state by construction —
 * `selected` initialises to the same zone.
 *
 * @param {Object} report @param {ZoneView} view the rank-1 zone
 * @returns {string}
 */
function pickCard(report, view) {
  const size = report.size || {};
  const hub = report.hub || {};
  const period = Number(size.hidingPeriodMin) || 0;

  let ride;
  if (view.travelMin === null || !period) {
    ride = `Not reachable from ${hub.name} inside the hiding period.`;
  } else {
    ride = `${mins(view.travelMin)} from ${hub.name} — ${pct(view.travelMin / period)} `
      + 'of the hiding period.';
  }

  const meters = AXIS_IDS.map((a) => axisMeter(view, a)).join('');
  const flags = view.flags.map((f) => flagChip(f)).join('');

  const header = el('div', join(
    el('span', join(waBadge('#1'), el('span', esc(view.name), { className: 'wa-heading-s' })), {
      className: 'wa-cluster wa-gap-2xs wa-align-items-center',
    }),
    el('span', esc(`${num(view.overall, 1)} / ${num(view.max, 0)}`), {
      className: 'wa-caption-s wa-color-text-quiet',
    }),
  ), { className: 'wa-split wa-align-items-center' });

  const body = el('div', join(
    el('p', esc(ride), { className: 'wa-body-s' }),
    el('div', meters, { className: 'wa-stack wa-gap-2xs' }),
    flags ? el('div', flags, { className: 'wa-cluster wa-gap-2xs' }) : '',
    view.routeNames.length
      ? el('p', esc(`Routes: ${view.routeNames.join(', ')}`), {
        className: 'wa-caption-s wa-color-text-quiet',
      })
      : '',
  ), { className: 'wa-stack wa-gap-m' });

  const footer = el('div', join(
    waButton('Show on the map', {
      icon: 'map-location-dot', variant: 'brand', appearance: 'filled', dataZone: view.id,
    }),
    el('a', esc('Read the full dossier'), { href: '#s-dossier', className: 'wa-link' }),
  ), { className: 'wa-cluster wa-gap-s wa-align-items-center' });

  return waCard(body, { headerHtml: header, footerHtml: footer, className: 'wa-brand' });
}

/**
 * The hero: kicker, headline, lede, two chips, the pick card — and the one link out.
 *
 * `href="#top"` is what leaves the route (spec §5.1): the report hero owns `#top`, and
 * `applyRoute` treats any hash that is not `#strategy` as an exit. The link is inside
 * the secret view and is therefore visible only to somebody already in it, which is
 * how the CLI's "the two pages never link to each other" invariant survives the port.
 */
function hero(report, views) {
  const feed = report.feed || {};
  const size = report.size || {};
  const agency = feed.agencyName || '';
  const place = report.place || agency;
  const zones = report.zones || [];
  const dossiers = report.dossierZoneIds || [];

  const lede = `${num(zones.length)} candidate hiding zones scored on six axes, `
    + `${num(dossiers.length)} written up in full. Every number below comes from `
    + `${agency}'s own schedule and from OpenStreetMap — nothing here is an opinion `
    + 'about the city.';

  const chips = join(
    chip(`${String(size.name || '').toUpperCase()} game`, 'ruler-combined', { variant: 'warning' }),
    chip(`${num(zones.length)} scored zones`, 'location-dot'),
  );

  const back = el('a', join(waIcon('arrow-left'), esc('Back to the feasibility report')), {
    href: '#top', className: 'wa-link wa-caption-s wa-cluster wa-gap-2xs',
  });

  const left = el('div', join(
    el('p', esc(`Hider's guide · ${agency}`), {
      className: 'kicker wa-caption-s wa-text-uppercase',
    }),
    el('h1', esc(`Where to hide in ${place}`), { className: 'wa-heading-4xl' }),
    el('p', esc(lede), { className: 'wa-body-l', style: 'max-inline-size:46ch' }),
    el('div', chips, { className: 'wa-cluster wa-gap-2xs' }),
    back,
  ), { className: 'wa-stack wa-gap-xs', style: 'flex:1 1 24rem' });

  // Top-aligned for the same reason as the report hero: the pick card is much taller
  // than the text beside it, and centring pushes the h1 down the page once the two
  // columns fit side by side.
  return el('header', el('div', join(
    left,
    el('div', pickCard(report, views[0]), { style: 'flex:1 1 26rem' }),
  ), { className: 'wa-split wa-flex-wrap wa-gap-2xl wa-align-items-start' }), {
    id: 's-top', className: 'wa-stack wa-gap-l',
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// §01 THE SHORTLIST — the map, the simulator, the rail, the dossier (14459–14616)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * §01's map card: the mode buttons, the MapLibre host, the readout, the legend.
 *
 * Order is controls → map → readout → legend → method, and none of the first four
 * may ever be collapsed: `#s-map` is a MapLibre container, which reads its size once
 * at construction (html.js 239, 407), and the buttons are how the simulator is
 * driven. Only the closing `wa-details` collapses.
 */
function mapCard(report) {
  const size = report.size || {};
  const hub = report.hub || {};
  const zones = report.zones || [];
  const questions = report.questions || [];
  const radiusLabel = s4Dist(report, size.zoneRadiusM || 0, 2);

  // A mutually exclusive set of six, so it is a `wa-radio-group` of button-appearance
  // radios — the same native pair `s4ChipGroup` (render/map.js 169) builds for the
  // report's filter rows, and the same reason: the group carries the role, the label,
  // arrow-key navigation and a real checked state, where a row of `wa-button`s
  // conveyed the selection by fill colour and told assistive tech nothing at all.
  // `s4ChipGroup` itself is NOT reused here because it cannot express `disabled`, and
  // a dead mode shown disabled-with-reason is the point of this row, not an oversight —
  // knowing which questions cannot hurt you here is worth as much as knowing which
  // can. (generate.py 14483–14496.) Every attribute below is the helper's.
  const chips = modeChips(report);
  const reasons = [];
  const radios = MODE_LABEL.map(([mode, label]) => {
    let reason = '';
    if (mode !== 'explore') {
      const category = MODE_CATEGORY[mode];
      const family = questions.filter((q) => q.category === category);
      const live = family.filter((q) => q.status === 'functional' || q.status === 'weak');
      if (!family.length) {
        // NOT a map problem, and saying "no question functions on this map" blamed the
        // geography for a rule. The audit only ever contains the questions this game
        // size's deck holds, so an empty family means the RULEBOOK left the category
        // out — which today is exactly one case: "Tentacle question cannot be used in
        // SMALL games", asserted at `rules/catalogue.js:711`.
        reason = category === 'tentacle'
          ? 'The rulebook says the tentacle question cannot be used in SMALL games, so a '
            + 'SMALL deck contains none. Nothing about this map is at fault.'
          : `A ${String(size.name || '').toUpperCase()} game's deck contains no `
            + `${label.toLowerCase()} question.`;
      } else if (!live.length) {
        reason = family[0].why
          || `No ${label.toLowerCase()} question functions on this map.`;
      } else if (mode !== 'thermo' && !(chips[mode] || []).length) {
        // A live question the simulator has nothing to point at. `modeChips` derives
        // its category set from what the OSM stage returned (see `geoKeys`), so on a
        // run with the map layer off — or one where every category came back empty —
        // the question can be functional and still have no selectable subject. Left
        // enabled, the mode opened on an empty option row while the readout asked for
        // a category that was not there. Dead is dead: say so on the button.
        reason = 'No mapped category on this map backs a question of that kind, so the '
          + 'simulator has nothing to measure against.';
      }
    }
    if (reason) reasons.push([label, reason]);
    return el('wa-radio', join(
      waIcon(MODE_ICON[mode]),
      esc(label),
      reason ? waIcon('ban', { label: 'unavailable' }) : '',
    ), {
      value: mode,
      appearance: 'button',
      size: 's',
      disabled: reason ? true : null,
    });
  }).join('');

  const modes = el('wa-radio-group', radios, {
    id: 's-modes',
    name: 's-mode',
    size: 's',
    orientation: 'horizontal',
    label: 'Question mode',
    value: 'explore',
    className: 'wa-visually-hidden-label',
  });

  // A disabled control is not focusable, so a `title` on one is reachable only by
  // hovering with a pointer — no keyboard, no touch, no screen reader. The reasons are
  // printed instead, which also makes them findable and printable. They are the whole
  // argument of the card's copy below; they should not have been a tooltip.
  const modesWhy = reasons.length
    ? el('div', reasons.map(([label, why]) => el(
      'p',
      join(el('b', esc(label)), esc(`— ${why}`)),
      { className: 'wa-caption-xs wa-color-text-quiet' },
    )).join(''), { id: 's-modes-why', className: 'wa-stack wa-gap-3xs' })
    : '';

  const caption = [
    'Live OpenFreeMap basemap.',
    `Each dot is one of the ${num(zones.length)} candidate hiding zones, coloured by score `
    + 'until you pick a question mode — then by the answer that zone would have to give.',
    `The selected zone's true ${radiusLabel} rulebook circle is drawn around its designated `
    + 'station.',
    'Amber “edge” means the circle straddles the answer boundary, so the honest answer '
    + 'depends on where inside your zone you are actually standing.',
    '★ marks the round-start station. Dashed gold = the game border.',
    'If your browser blocks the map library, the map is omitted and everything below still '
    + 'works.',
  ].join(' ');

  // Three keys, not one, because the dots carry two different encodings: the view
  // OPENS in explore mode, where they are score bands, and the old legend documented
  // only the answer colours a reader has not seen yet. Same swatch shape and the same
  // `s4Legend` the report's maps use — a real `<ul class="wa-list-plain">` rather than
  // a `div[role="list"]`, per its own docstring; its margin caveat is satisfied
  // because the parent below is a `wa-stack`.
  const dot = (token) => s4Swatch(
    `background:var(${token});border-radius:var(--wa-border-radius-circle)`,
  );
  const legend = el('div', join(
    el('p', esc('Before you load a question — each zone’s score band:'), {
      className: 'wa-caption-xs wa-color-text-quiet',
    }),
    s4Legend([
      [dot('--gold-mark'), 'Top — within a tenth of this map’s best'],
      [dot('--accent'), 'Good'],
      [dot('--warn'), 'Fair'],
      [dot('--off'), 'Weak, or nothing measurable to score'],
    ]),
    el('p', esc('With a question loaded — the answer that zone would have to give:'), {
      className: 'wa-caption-xs wa-color-text-quiet',
    }),
    s4Legend([
      [dot('--q-yes'), 'Yes / hotter / in reach'],
      [dot('--q-no'), 'No / colder / out of reach'],
      [dot('--q-edge'), 'Edge — the circle straddles it'],
      [dot('--q-un'), 'Awaiting input'],
    ]),
    s4Legend([
      [el('span', esc('★'), { style: 'color:var(--gold-deep);font-weight:800' }), hub.name],
      [s4Swatch('background:transparent;border:1.5px dashed var(--gold-deep)'), 'Game border'],
    ]),
  ), { className: 'wa-stack wa-gap-2xs' });

  const poi = poiCategories(report);
  const cappedNames = poi.capped.map((k) => poi.categories[k].label);
  const cappedNote = cappedNames.length
    ? `${s4JoinWords(cappedNames)} carry more mapped features than the `
      + `${num(poi.cap)} the simulator holds per category, so their answers are drawn from `
      + 'the first that many rather than from all of them.'
    : '';

  const how = waDetails('How the simulator works', el('div', join(
    el('p', esc(
      'This simulator is the client-side twin of the survival model that produced the '
      + 'scores: the same arithmetic, run against one seeker you place yourself instead of '
      + 'the sample the scorer averages over. Dead question categories are shown disabled '
      + 'with the reason rather than hidden — knowing which questions cannot hurt you here '
      + 'is worth as much as knowing which can.',
    ), { className: 'wa-body-s' }),
    cappedNote ? el('p', esc(cappedNote), { className: 'wa-body-s wa-color-text-quiet' }) : '',
  ), { className: 'wa-stack wa-gap-s' }), { appearance: 'plain' });

  return waCard(el('div', join(
    modes,
    modesWhy,
    el('div', '', { id: 's-opts', className: 'wa-stack wa-gap-2xs' }),
    el('div', '', { id: 's-map' }),
    el('p', '', { id: 's-readout', className: 'wa-body-s', ariaLive: 'polite' }),
    legend,
    how,
  ), { className: 'wa-stack wa-gap-s' }), {
    headerHtml: s4CardHeader('The map', caption),
  });
}

/**
 * §01's ranked rail and the dossier shell the simulator fills.
 * (`strategy_zone_list` 14570 + `strategy_dossier_template` 14596.)
 *
 * The rail is a `role="listbox"` of `role="option"` rows built client-side; it is a
 * shortlist rather than the field, and the link under it says so.
 */
function railAndDossier(report) {
  const zones = report.zones || [];

  const head = el('div', join(
    subhead('Ranked candidates', { anchorId: 's-dossier' }),
    el('span', '', { id: 's-count', className: 'wa-caption-s wa-color-text-quiet' }),
  ), { className: 'wa-split wa-align-items-center' });

  const rail = el('div', '', {
    id: 's-list',
    className: 'wa-stack wa-gap-2xs',
    role: 'listbox',
    ariaLabel: 'Ranked hiding zones',
  });

  const more = el('p', el('a', join(
    esc(`See all ${num(zones.length)} in the table`), waIcon('table'),
  ), { href: '#s-all', className: 'wa-link wa-cluster wa-gap-2xs' }), {
    className: 'wa-caption-s',
  });

  const dossier = el('div', waCard(
    el('div', el('p', esc('Select a zone on the map or in the list.'), {
      className: 'wa-body-s',
    }), { id: 's-body', className: 'wa-stack wa-gap-m' }),
    {
      headerHtml: el('div', join(
        el('span', esc('Zone dossier'), { className: 'wa-heading-s', id: 's-title' }),
        el('span', '', { id: 's-score', className: 'wa-caption-s wa-color-text-quiet' }),
      ), { className: 'wa-split wa-align-items-center' }),
    },
  ), { id: 's-detail' });

  return el('div', join(
    el('div', join(head, rail, more), { className: 'wa-stack wa-gap-s' }),
    dossier,
  ), { className: 'wa-grid wa-gap-l', style: '--min-column-size:22rem' });
}

/** §01 — the map, the simulator, the ranked rail and the dossier, in one section. */
function sectionShortlist(report) {
  const size = report.size || {};
  const zones = report.zones || [];
  const answer = el('p', esc(
    `${num(zones.length)} zones were scored, each a ${s4Dist(report, size.zoneRadiusM || 0, 2)} `
    + `circle around its designated station, and ${num(s4LiveQuestions(report))} of the deck's `
    + 'questions function here. Pick a question mode to see what each one would do to the field.',
  ), { className: 'wa-body-s' });

  return section('s-zones', '01', 'The shortlist',
    join(mapCard(report), railAndDossier(report)), {
      kicker: 'The map, and what each question would do to it',
      answerHtml: answer,
      lede: 'Pick a question mode, drop a seeker, and watch the map partition. What you are '
        + 'looking for is a zone that stays the same colour as a large crowd of others.',
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// §02 THE WHOLE FIELD — every scored zone, sortable and filterable (14618)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The eleven column words of §02's table, in `data-sort` index order.
 *
 * **The indices 0–10 are the contract between this file and `simulator.js`
 * (generate.py 14690–14700). Never renumber them.**
 */
const TABLE_HEADERS = Object.freeze([
  Object.freeze(['Rank', '']),
  Object.freeze(['Zone', '']),
  Object.freeze(['Score', '']),
  ...AXES.map((a) => Object.freeze([AXIS_PLAIN[a[0]][1], a[0]])),
  Object.freeze(['Flags', '']),
  Object.freeze(['Travel', '']),
]);

/** §02 — every scored zone, sortable and filterable, plus the axis winners. */
function sectionWholeField(report, views) {
  const zones = report.zones || [];
  const ref = referenceScore(report);
  const excluded = views.filter((v) => v.excluded);

  // Axis winners: the best non-excluded zone on each axis, in `views` order, so a tie
  // resolves to the better-ranked zone. An axis nobody could be scored on has no
  // winner and no card — never a card reading "0 of 0 pt".
  const winners = [];
  for (const [axis, name] of AXES) {
    const maxPts = ref ? pts(ref.axisMax[axis]) : 0;
    if (!maxPts) continue;
    let best = null;
    for (const v of views) {
      if (v.excluded) continue;
      if (best === null || v.axes[axis] > best.axes[axis]) best = v;
    }
    if (best === null) continue;
    winners.push(waCard(join(
      el('p', join(el('code', esc(axis)), esc(` · ${AXIS_PLAIN[axis][0]}`)), {
        className: 'wa-caption-xs wa-text-uppercase',
      }),
      el('p', esc(best.name), { className: 'wa-heading-s' }),
      el('p', esc(`${num(best.axes[axis], 1)} of ${num(maxPts, 1)} pt · ${name}`), {
        className: 'wa-caption-s wa-color-text-quiet',
      }),
    ), { className: 'wa-brand' }));
  }
  const winnersBlock = winners.length
    ? el('div', join(
      subhead('Best on each axis'),
      el('div', winners.join(''), {
        className: 'wa-grid wa-gap-m', style: '--min-column-size:14rem',
      }),
    ), { className: 'wa-stack wa-gap-xs' })
    : '';

  // The axis legend replaces the CLI's six `wa-tooltip for="th-{axis}"` (14705):
  // `html.js` has no tooltip helper and is frozen for this task, and a link into §04
  // is a better answer than a hover anyway — it survives touch, print and Ctrl+F.
  // It stays out of the sticky strip on purpose: six labelled entries pinned under a
  // 7rem header would take a third of a phone viewport.
  // A real `<ul>`/`<li>` rather than a `div[role="list"]`, for `s4Legend`'s stated
  // reason — native semantics need no ARIA override. It cannot BE `s4Legend`: that
  // helper takes `[swatchHtml, plainText]`, and each entry here is a link, a name and
  // a points figure.
  const legend = el('ul', AXES.map(([axis]) => el('li', join(
    el('a', el('code', esc(axis)), { href: `#s-axis-${axis}`, className: 'wa-link' }),
    el('span', esc(AXIS_PLAIN[axis][0]), { className: 'wa-caption-s' }),
    el('span', esc(`${num(ref ? pts(ref.axisMax[axis]) : 0, 0)} pt`), {
      className: 'wa-caption-xs wa-color-text-quiet',
    }),
  ), { className: 'wa-cluster wa-gap-3xs wa-align-items-center' })).join(''), {
    className: 'wa-cluster wa-gap-m wa-list-plain',
  });

  const controls = el('div', join(
    searchInput('s-filter', {
      placeholder: 'Filter by name, route or flag', label: 'Filter zones',
    }),
    el('span', '', { id: 's-tableinfo', className: 'wa-caption-s wa-color-text-quiet' }),
  ), {
    id: 's-controls',
    className: 'wa-split wa-align-items-center wa-flex-wrap wa-gap-s',
  });

  // `aria-sort="none"` is set here as well as by `renderTable()` so the header row is
  // honest before the simulator has run; the sort arrows are a `th[aria-sort]` rule in
  // styles.css and need no extra markup.
  const cells = TABLE_HEADERS.map(([word, axis], i) => el('th', el('button', join(
    el('span', esc(word)),
    axis ? el('code', esc(axis), { className: 'wa-caption-2xs' }) : '',
  ), { className: 'wa-plain', dataSort: String(i) }), { ariaSort: 'none' })).join('');
  const table = waScroller(el('table',
    el('thead', el('tr', cells)) + el('tbody', '', { id: 's-tbody' }),
    { id: 's-table', className: 'wa-zebra-rows wa-hover-rows' }));

  const pager = el('div', '', {
    id: 's-pager', className: 'wa-cluster wa-gap-s wa-align-items-center',
  });

  let excludedBlock = '';
  if (excluded.length) {
    const rows = excluded.map((v) => [
      esc(v.name),
      esc(v.excludeReason || 'excluded'),
      esc(v.travelMin === null ? '—' : mins(v.travelMin, 0)),
    ]);
    excludedBlock = waDetails('Zones outside the ranking', join(
      el('p', esc(
        'These are still scored and still in the table above — they are held out of the '
        + 'ranking because you cannot reach them inside the hiding period, or because the '
        + 'designated station has no service on the selected day. Nothing is dropped '
        + 'silently.',
      ), { className: 'wa-body-s' }),
      dataTable(['Zone', 'Why', 'Travel time'], rows),
    ));
  }

  const answer = el('p', esc(
    `Every one of the ${num(zones.length)} scored zones is in this table`
    + (excluded.length ? `, including the ${num(excluded.length)} held out of the ranking` : '')
    + '. Sort by the column you care about.',
  ), { className: 'wa-body-s' });

  return section('s-all', '02', 'The whole field',
    el('div', join(winnersBlock, legend, controls, table, pager, excludedBlock), {
      className: 'wa-stack wa-gap-l',
    }), {
      kicker: `All ${num(zones.length)} scored zones`
        + (excluded.length ? ` · ${num(excluded.length)} outside the ranking` : ''),
      answerHtml: answer,
      lede: 'The ranking above is one set of weights. Sort this table by whichever axis '
        + 'matters to you and it will give you a different shortlist — which is the point.',
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// §03 HOW TO PLAY THIS MAP — the parameterised playbook (14734)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * §03 — rulebook tips parameterised from this feed, dropped when they do not apply.
 *
 * The clause each tip comes from lives in the card's footer, so the advice reads as
 * advice and the citation reads as a citation. Six to nine tips typically; five with
 * no OpenStreetMap data, because tips 3 and 5 have no facts to stand on.
 */
function sectionTactics(report) {
  const size = report.size || {};
  const geo = report.geo || {};
  const hub = report.hub || {};
  const metrics = s4MetricLookup(report);
  const tips = [];

  tips.push([
    `Spend the whole ${num(size.hidingPeriodMin)} minutes`,
    'Your hiding window is the only free movement you get. Wherever you are standing when '
    + 'the timer ends is your zone, so plan the ride, not just the destination — and check '
    + 'the travel time in the dossier before you commit to a zone.',
    "Hiding Zones — “if the hiding period ends and you're somewhere else, then that's "
    + 'where your hiding zone is.”',
  ]);

  tips.push([
    'Scope your endgame spot early, then wander',
    `Inside your ${s4Dist(report, size.zoneRadiusM || 0, 2)} circle you can shop, eat and `
    + 'sightsee — but the moment a seeker walks in off transit you freeze where you stand. '
    + 'Know exactly where you will be standing, and pre-take the photos you can, so a photo '
    + 'timer never forces you to sprint.',
    'Hiding Spots — the spot is final the moment the end game starts.',
  ]);

  const parks = (geo.counts || {}).park;
  if (parks) {
    tips.push([
      'Parks are the best-in-class final spot',
      'Publicly accessible at all hours, no risk of being asked to leave, and their path '
      + `networks satisfy the ten-feet-of-a-mapped-path rule. This map has ${num(parks)} of `
      + 'them. A large park is doubly useful: “nearest park” measures to the map icon, so '
      + 'you can be standing in one park and truthfully name a different one.',
      'Hiding Spots — publicly accessible during all game hours; Matching — measure to the '
      + 'map icon.',
    ]);
  }

  tips.push([
    'Businesses are a mid-round tool, not a hiding spot',
    'The rulebook warns against stores and businesses as final spots — loitering draws '
    + 'attention and opening hours rarely cover all game hours. Use them for a bathroom, food '
    + 'and warmth during the middle of the round, then be somewhere public when the endgame '
    + 'starts.',
    "Hiding Spots — “we'd suggest avoiding stores or other businesses.”",
  ]);

  if (size.name !== 'small') {
    const tentacles = (report.questions || []).filter(
      (q) => q.category === 'tentacle' && (q.status === 'functional' || q.status === 'weak'),
    );
    if (tentacles.length) {
      const named = Array.from(new Set(tentacles.map((q) => q.label)))
        .sort(cmpStr).slice(0, 4).join(', ');
      // Per question, never `size.tentacleReachMi`: a LARGE deck asks about museums,
      // libraries, movie theaters and hospitals within 1 mile AND about metro lines,
      // zoos, aquariums and amusement parks within 15, so one number would misstate
      // half the family. (`TENTACLE_ID_REACH_MI`.)
      const reaches = tentacleReachesMi(tentacles);
      const words = tentacleReachWords(reaches);
      const reachClause = reaches.length > 1
        ? `Each question carries its own reach — ${words} on this map — measured from the `
        : `The reach is ${words}, measured from the `;
      tips.push([
        'Respect the tentacle categories',
        `The live tentacle categories here are ${named}. ${reachClause}`
        + 'seekers, not from you, so a target well outside your zone can still be the name '
        + 'you have to give. You must be inside that reach yourself as well: if you are not, '
        + 'the honest answer is simply that you are not within reach, and it names nothing. '
        + 'A zone where the category is absent or ambiguous blunts the whole family — and a '
        + 'null answer still pays you a card draw.',
        `Tentacle Questions — “(You must also be within ___ miles.)”; ${words} of reach in a `
        + `${String(size.name || '').toUpperCase()} game.`,
      ]);
    }
  }

  tips.push([
    'Radar targets you, not your zone',
    'If the ring clips your circle but not your body, the honest answer is no. Stand on the '
    + `far side of your ${s4Dist(report, size.zoneRadiusM || 0, 2)} disc from the seekers' `
    + 'likely approach — the simulator above shows exactly which zones turn amber, and amber '
    + 'is the band where standing in the right half of your own circle changes the answer.',
    'Radar Questions — the answer is about your location, not your zone.',
  ]);

  tips.push([
    'Build the deck to end the round holding time',
    'Time bonuses only count if they are in your hand when you are caught. Aim for roughly '
    + 'half bonuses, a quarter powerups, a quarter curses — and remember that Move costs your '
    + 'entire hand, reveals your original station, and cannot be played in the end game.',
    'The Hider Deck — six-card hand limit; Powerups — Move.',
  ]);

  const evening = metrics.D2;
  const eveningRaw = evening ? fnum(evening.raw) : null;
  if (eveningRaw !== null && eveningRaw < 0.85) {
    // The CLI points the reader at the day banner; this view has none (the subheader
    // is `data-when="report"` and hidden), so the sentence names the day instead.
    const worstKey = s4WorstDay(report);
    const worstClause = worstKey
      ? ` ${s4DayLabel(report, worstKey)} is the worst day on this map, so settle which day `
        + 'you are playing before you even shortlist a zone.'
      : '';
    tips.push([
      'Watch the service clock',
      `Only ${pct(eveningRaw)} of zones still have service at the end of the round's playing `
      + 'hours. Late in the day an hourly zone has no Move escape — and the seekers know '
      + `it.${worstClause}`,
      'Powerups — Move requires a departure to exist.',
    ]);
  }

  // Fixed in the port, deliberately: the CLI reads `metrics["hub_route_share"]`
  // (14824), a key `network_metrics` never emits — it emits `hub_dominance` (3871) —
  // so this tip has never once fired in the CLI. `Metrics.hubDominance` (network.js
  // 890) is the intended value. Filed against generate.py separately.
  const dominance = fnum((report.metrics || {}).hubDominance);
  if (dominance !== null && dominance >= 0.5) {
    tips.push([
      'Assume the seekers pass through the hub',
      `${hub.name} carries ${pct(dominance)} of this network's routes, so almost every seeker `
      + 'journey crosses it. Zones whose only path from the seekers runs back through the hub '
      + 'buy you the transfer penalty twice.',
      'Seeking — seekers move on the same transit you do.',
    ]);
  }

  const items = tips.map(([title, body, clause]) => el('li', waCard(
    el('div', join(
      el('p', esc(title), { className: 'wa-heading-s' }),
      el('p', esc(body), { className: 'wa-body-s' }),
    ), { className: 'wa-stack wa-gap-2xs' }),
    {
      footerHtml: el('p', join(waIcon('book'), esc(clause)), {
        className: 'wa-caption-s wa-color-text-quiet wa-cluster wa-gap-2xs',
      }),
    },
  ))).join('');

  const answer = el('p', esc(
    `${num(tips.length)} things to do differently on this map, in the order they matter.`,
  ), { className: 'wa-body-s' });

  return section('s-tactics', '03', 'How to play this map',
    el('ol', items, { className: 'recs wa-stack wa-gap-s' }), {
      kicker: 'The playbook for this map',
      answerHtml: answer,
      lede: 'Everything below follows from the official rules applied to this particular '
        + 'network — each tip names the clause it comes from, and tips whose precondition '
        + 'does not hold here have been left out.',
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// §04 HOW ZONES ARE SCORED — the six axes as reference material (14380)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * §04 — one accordion item per axis, all collapsed.
 *
 * A reader arrives here from a column header or a dossier meter wanting one axis, not
 * six; and a collapsed accordion label still shows the axis's plain name, its letter
 * and what it is worth, which is the whole reason this is not a tab group.
 */
function sectionAxes(report) {
  const zones = report.zones || [];
  const ref = referenceScore(report);

  // The example that makes `surv` concrete: the sharpest live question on this map.
  let example = '';
  const live = (report.questions || []).filter(
    (q) => (q.status === 'functional' || q.status === 'weak') && fnum(q.survMean) !== null,
  );
  if (live.length && zones.length) {
    let sharp = null;
    for (const q of live) {
      if (sharp === null || q.survMean < sharp.survMean
        || (q.survMean === sharp.survMean && cmpStr(q.id, sharp.id) < 0)) sharp = q;
    }
    const remaining = Math.max(1, rhu(sharp.survMean * zones.length, 0));
    example = `On this map, asking “${sharp.label}” leaves on average ${num(remaining)} of `
      + `${num(zones.length)} zones still standing.`;
  }

  // The page's thesis rides on the hero as a pull quote; the precise version, naming
  // the two metrics that fight, stays here — in both axes it is about.
  const tension = waCallout(el('p', esc(
    'Reach and Exposure pull against each other on purpose, and that tension is the whole '
    + 'game. R1 rewards a zone you can actually get to inside the hiding period; X3 rewards '
    + 'a zone the seekers find expensive to reach. A zone that scores well on both is '
    + 'genuinely rare, and it is what you are shopping for below.',
  ), { className: 'wa-body-s' }), { variant: 'brand', appearance: 'plain', icon: 'circle-info' });

  const items = AXES.map(([axis, name, what, clause]) => {
    const maxPts = ref ? pts(ref.axisMax[axis]) : 0;
    const rows = [];
    for (const m of (ref && ref.metrics) || []) {
      // `IR1` starts with `I` but belongs to `IR`, not to a one-letter axis: the id
      // matches only when everything after the axis letters is digits. (14415.)
      if (!m.id.startsWith(axis) || !/^\d+$/.test(m.id.slice(axis.length))) continue;
      rows.push([
        el('code', esc(m.id)) + ' ' + esc(m.name),
        esc(m.unit || '—'),
        esc(`${num(pts(m.maxTenths), 1)} pt`),
        s4SourceTag(m.source),
        esc(m.note || ''),
      ]);
    }

    const label = join(
      el('span', join(
        el('strong', esc(AXIS_PLAIN[axis][0]), { className: 'wa-body-s' }),
        el('code', esc(axis), { className: 'wa-caption-2xs' }),
        el('span', esc(name), { className: 'wa-caption-xs wa-color-text-quiet' }),
      ), { className: 'wa-cluster wa-gap-2xs wa-align-items-center' }),
      waBadge(maxPts ? `${num(maxPts, 1)} pt` : 'not measured on this map', {
        variant: 'neutral', appearance: 'outlined',
      }),
    );

    const body = el('div', join(
      el('p', esc(what), { className: 'wa-body-s' }),
      (axis === 'IR' && example) ? el('p', esc(example), { className: 'wa-body-s' }) : '',
      maxPts ? '' : el('p', esc(
        'Nothing on this axis could be measured on this map — OpenStreetMap data was not '
        + 'available — so its points were dropped from the denominator rather than scored '
        + 'and lost. Every zone reads the same here, and none of them was penalised.',
      ), { className: 'wa-body-s wa-color-text-quiet' }),
      (axis === 'R' || axis === 'X') ? tension : '',
      rows.length ? dataTable(['Metric', 'Unit', 'Max', 'Basis', 'Note'], rows) : '',
      el('p', esc('Rulebook: ') + el('em', esc(clause)), {
        className: 'wa-caption-s wa-color-text-quiet',
      }),
    ), { className: 'wa-stack wa-gap-s' });

    return [`s-axis-${axis}`, label, body, false];
  });

  const back = el('p', el('a', join(waIcon('table'), esc('Back to the table')), {
    href: '#s-all', className: 'wa-link wa-cluster wa-gap-2xs',
  }), { className: 'wa-caption-s' });

  const answer = el('p', esc(
    `Every one of the ${num(zones.length)} zones sat the same six-axis exam, and every point `
    + 'it earned is listed in its own dossier.',
  ), { className: 'wa-body-s' });

  return section('s-axes', '04', 'How zones are scored',
    el('div', join(waAccordion(items, { mode: 'multiple', headingLevel: '3' }), back), {
      className: 'wa-stack wa-gap-m',
    }), {
      kicker: 'Six axes, one hundred points',
      answerHtml: answer,
      lede: 'Every zone is scored the same way, from the feed and from OpenStreetMap. Nothing '
        + 'here is a matter of taste: each axis is a list of named metrics with published '
        + "thresholds, and every zone's dossier shows which of them it earned. Open an "
        + 'axis for its metrics and the rulebook clause behind it.',
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// §05 METHOD & PARAMETERS (14856)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * §05 — the scoring parameters actually used.
 *
 * The feasibility report is named in prose and deliberately **not** linked: the hero's
 * back-link is the affordance, and it is the only one. (generate.py 14859–14862.)
 */
function sectionMethod(report) {
  const p = report.provenance || {};
  const feed = report.feed || {};
  const size = report.size || {};
  const hub = report.hub || {};
  const opts = report.opts || {};
  const zones = report.zones || [];
  const questions = report.questions || [];
  const agency = feed.agencyName || '';
  const tentacleReaches = tentacleReachesMi(questions);

  const rows = [
    ['Zones scored', esc(num(zones.length))],
    ['Zone radius', esc(s4Dist(report, size.zoneRadiusM || 0, 2))],
    ['Game size', esc(`${String(size.name || '').toUpperCase()}`
      + `${size.inferred ? ' (inferred)' : ' (given)'}`)],
    ['Hiding period', esc(mins(size.hidingPeriodMin))],
    // Per question, not per size. A LARGE deck holds the four 1-mile tentacles AND the
    // four 15-mile ones, so this row prints both; a SMALL deck holds none, because the
    // rulebook excludes the category. (`TENTACLE_ID_REACH_MI`.)
    ['Tentacle reach', esc(tentacleReaches.length
      ? tentacleReachWords(tentacleReaches)
      : `none — no tentacle question in a ${String(size.name || '').toUpperCase()} game`)],
    ['Round start', esc(hub.name)],
    ['Departure', esc(opts.departure || '')],
    ['Day shown', esc(s4DayLabel(report, s4BestDay(report)))],
    ['Live questions', esc(`${num(s4LiveQuestions(report))} of ${num(questions.length)}`)],
    ['Feed', esc(`${agency} — ${p.feedVersion || 'n/a'}`)],
  ];
  if (/^\d{8}$/.test(String(p.asOf || ''))) {
    rows.push(['Analysis date', esc(prettyDate(String(p.asOf)))]);
  }

  const body = el('div', join(
    dataTable(['Parameter', 'Value'], rows.map(([k, v]) => [esc(k), v])),
    el('p', esc(
      'Zone scores come from the feed and from OpenStreetMap via Overpass; the full method, '
      + 'the exact selectors and the complete score trace are on the feasibility report. '
      + 'Scheduled times are planning estimates — verify against live tracking on game day.',
    ), { className: 'wa-body-s' }),
  ), { className: 'wa-stack wa-gap-m' });

  const answer = el('p', esc(
    `Everything on this page was produced from ${agency}'s published timetable and from `
    + `OpenStreetMap, for a ${String(size.name || '').toUpperCase()} game starting at `
    + `${hub.name}.`,
  ), { className: 'wa-body-s' });

  return section('s-method', '05', 'Method & parameters', body, {
    kicker: 'What produced these rankings',
    answerHtml: answer,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE VIEW
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The whole secret view as one HTML string, or `''` when it cannot be rendered.
 *
 * Returns `''` — and the caller mounts nothing — when the report is missing any of
 * the pieces every section depends on. The five sections share that one guard, so
 * they are all present or all absent and the literal ordinals `'01'`…`'05'` are
 * always right. **Do not switch them to `S4_ORDINAL`**: `renumberSections`
 * (app.js 1215–1233) walks its own `NUMBERED` list and then strips `data-n` from
 * every remaining `[data-n="--"]` in the document, which would silently erase them.
 *
 * The returned string is EXACTLY ONE top-level element, and its three attributes are
 * load-bearing: `id="strategy"` is the fragment and the `initStrategy` root,
 * `data-when="strategy"` is what `body:not([data-view='strategy'])` hides, and
 * `data-run-only` is what keeps the whole guide out of the saved file
 * (`buildStandalonePage` already sweeps that selector, app.js 2802). There is no
 * `data-state`: `fatalError` sweeps `[data-state="skeleton"]` (app.js 1397).
 *
 * @param {Object} report the complete `Report` (state.report after `finish`)
 * @returns {string} HTML, or ''
 */
export function renderStrategy(report) {
  const rep = report || {};
  if (!(rep.zones || []).length) return '';
  if (!(rep.rankedZoneIds || []).length) return '';
  if (!rep.size || !rep.hub || !rep.border) return '';
  if (!Object.keys(rep.zoneScores || {}).length) return '';

  const views = zoneViews(rep);
  if (!views.length) return '';

  // The page's thesis, which the CLI keeps as a pull quote on the hero and repeats in
  // precise, metric-naming form inside §04's R and X items. Exactly one per view.
  const thesis = pullQuote(
    'A zone you can actually reach and a zone the seekers find expensive to reach are '
    + 'opposite things. One that scores well on both is genuinely rare — and it is what you '
    + 'are shopping for below.',
  );

  const credit = 'Map features and administrative divisions from OpenStreetMap contributors, '
    + 'ODbL. Basemap tiles by OpenFreeMap, from OpenMapTiles data. Rules from Jet Lag: The '
    + "Game's Hide+Seek rulebook. Scheduled times are planning estimates — check live tracking "
    + 'on the day.';

  // `href="#strategy"`, not `#top`: `#top` is the report hero and leaving is what it
  // does. The footer's job is to get back to the top of *this* view.
  const footer = el('footer', join(
    el('p', esc(credit), { className: 'wa-body-s', style: 'max-width:88ch' }),
    el('a', join(waIcon('arrow-up'), esc('Back to top')), {
      href: '#strategy', className: 'wa-link wa-caption-s wa-cluster wa-gap-2xs',
    }),
  ), { className: 'wa-stack wa-gap-s' });

  return el('div', join(
    hero(rep, views),
    thesis,
    sectionShortlist(rep),
    sectionWholeField(rep, views),
    sectionTactics(rep),
    sectionAxes(rep),
    sectionMethod(rep),
    footer,
  ), {
    id: 'strategy',
    // The report's `<main>` is `display: none` while this is up, and `wa-page` supplies
    // no landmark of its own (its shadow template wraps the slot in a plain `div`), so
    // without this the whole guide sits outside every landmark region. It cannot
    // collide with the report's `<main>`: a `display: none` element is not in the
    // accessibility tree, and the two are never visible together.
    role: 'main',
    dataRunOnly: true,
    dataWhen: 'strategy',
    className: 'wa-stack wa-gap-3xl',
  });
}
