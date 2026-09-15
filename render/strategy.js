// render/strategy.js — the secret hider's guide, static markup.
//
// The guide is a second *view* of one document, reachable only by the fragment
// `#strategy`. The report never mentions it, and the one link out (the hero's
// `href="#top"`) is visible only from inside the guide.
//
// PURE: `Report → string`. No DOM, clock, randomness, listeners or side effects.
// `render/simulator.js` imports the view model from here and owns every mutation, so
// both files' numbers come from `zoneViews()`: one implementation, one rounding.
//
// Every id is prefixed `s-` because the report view already owns `#top`, `#sources`,
// `#zmap` and `#axis-IR`, and a collision would misdirect `openTargeted` (app.js).
// `#strategy` is the one bare id, because it is the fragment.
//
// Every number goes through exactly one formatter from `../lib/core.js`: no
// `toFixed`, no `Math.round`, no arithmetic inside a template literal.
//
// @module render/strategy

import {
  cmpStr, num, pct, mins, rhu, coord, prettyDate, fillPct, capWord,
} from '../lib/core.js';
import {
  esc, el, join, waIcon, waCard, waButton, waBadge, waTag, waDetails,
  waAccordion, chip, meter, searchInput, pullQuote, section, subhead,
  dataTable, swatch, basisChip, degradeChip, linkChip, iconLabel,
  legendRow, leadDetail, cardHeader, kpi,
} from './html.js';
import {
  fnum,
  s4Dist, s4Val, s4Plural, s4NaturalCmp, s4JoinWords, s4DayLabel, s4BestDay, s4WorstDay,
  s4LiveQuestions, s4MetricLookup, s4RampText, s4RampShort,
} from './verdict.js';
import { S4_STATUS_TAG } from './deck.js';
// Pure frozen data, safe on the main thread. Read for one field: a tentacle question's
// `param`, its reach in miles, which `QuestionAudit` does not carry (CONTRACT.md §(b)).
import { QUESTIONS } from '../rules/catalogue.js';

// ── rulebook presentation constants (read, never recomputed) ─────────────────

/**
 * The six zone axes: `(id, name, what it measures, rulebook clauses as [section, text])`.
 * Exported because CONTRACT.md §(a) names it.
 * @type {ReadonlyArray<readonly [string, string, string, ReadonlyArray<readonly [string, string]>]>}
 */
export const AXES = Object.freeze([
  Object.freeze(['IR', 'Information resistance',
    'How many zones answer like you.',
    Object.freeze([Object.freeze(['Seeking', 'every question is answered truthfully, so the '
      + 'only defence is being indistinguishable.'])])]),
  Object.freeze(['R', 'Reach',
    'Can you get here in time, in how many changes.',
    Object.freeze([Object.freeze(['Hiding Zones', "“if the hiding period ends and you're "
      + "somewhere else, then that's where your hiding zone is.”"])])]),
  Object.freeze(['S', 'Service',
    'Onward departures, gaps and last-ride margin.',
    Object.freeze([Object.freeze(['Curses & powerups',
      'Move costs your whole hand and needs a bus to exist.'])])]),
  Object.freeze(['E', 'Endgame spots',
    'Legal freeze spots in the circle, clustered or scattered.',
    Object.freeze([Object.freeze(['Hiding Spots', 'publicly accessible during all game hours, '
      + 'within 10 ft of a mapped path.'])])]),
  Object.freeze(['A', 'Amenities',
    'Toilet, food, water, shelter.',
    Object.freeze([Object.freeze(['Hiding',
      "“you're free to do whatever you like”, for as long as it takes."])])]),
  Object.freeze(['X', 'Exposure',
    'Edge and radar exposure, crowding, seeker cost.',
    Object.freeze([
      Object.freeze(['Radar Questions', 'an outlier is pinned by one question.']),
      Object.freeze(['Measuring', 'distance from the seekers is itself information.']),
    ])]),
]);

/** `['IR','R','S','E','A','X']` — the axis order every table column and meter uses. */
export const AXIS_IDS = Object.freeze(AXES.map((a) => a[0]));

/**
 * Axis id → (the plain name the page leads with, the short word a column header can
 * hold). The rulebook's name rides alongside as a caption in §04, and the letter as
 * a `<code>` beside every plain name and in parentheses in `TABLE_LABELS`.
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
 * Zone flag → `[label, wa-tag variant, icon, shortLabel]`, joined once here for both
 * this file and `simulator.js`. The icon exists so a flag is never colour alone.
 */
export const FLAG_TEXT = Object.freeze({
  no_service: Object.freeze(['No service', 'danger', 'circle-exclamation', 'No service']),
  unreachable: Object.freeze(['Unreachable in the hiding period', 'danger', 'circle-exclamation',
    'Unreachable']),
  pinned: Object.freeze(['Pinned by one question', 'danger', 'circle-exclamation',
    'Pinned by 1 question']),
  no_legal_spot: Object.freeze(['No legal endgame spot found', 'warning', 'triangle-exclamation',
    'No legal spot']),
  no_toilet: Object.freeze(['No public toilet', 'warning', 'triangle-exclamation', 'No toilet']),
  strands_seekers: Object.freeze(['Strands the seekers', 'warning', 'triangle-exclamation',
    'Strands seekers']),
  edge_zone: Object.freeze(['Circle crosses the border', 'warning', 'triangle-exclamation',
    'Edge zone']),
  osm_thin: Object.freeze(['Thin OSM coverage', 'neutral', 'circle-info', 'Thin OSM']),
});

/** Simulator mode → its button label, in button order. */
export const MODE_LABEL = Object.freeze([
  Object.freeze(['explore', 'No question']),
  Object.freeze(['radar', 'Radar']),
  Object.freeze(['thermo', 'Thermometer']),
  Object.freeze(['match', 'Matching']),
  Object.freeze(['measure', 'Measuring']),
  Object.freeze(['tentacle', 'Tentacles']),
]);

/** Simulator mode → icon. An icon never replaces the mode's word. */
export const MODE_ICON = Object.freeze({
  explore: 'compass',
  radar: 'magnifying-glass',
  thermo: 'temperature-half',
  match: 'equals',
  measure: 'ruler',
  tentacle: 'diagram-project',
});

/**
 * Simulator mode → the rulebook question category it simulates. Exact names:
 * a prefix match would silently disable the whole measuring family.
 */
export const MODE_CATEGORY = Object.freeze({
  radar: 'radar',
  thermo: 'thermometer',
  match: 'matching',
  measure: 'measuring',
  tentacle: 'tentacle',
});

/**
 * Radar question id → its radius in MILES. A
 * table, not a parse: `radar.quarter_mile` and `radar.3mi` are spelled differently.
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
 * Tentacle question id → its OWN reach in MILES, from the catalogue's `param`. There is
 * no single tentacle reach per game size: a LARGE deck holds the 1-mile questions and
 * the 15-mile ones at once. `SizeParams.tentacleReachMi` is only the headline figure;
 * the engine reads `question.param` (`rules/audit.js`).
 * @type {Object<string, number>}
 */
export const TENTACLE_ID_REACH_MI = Object.freeze(Object.fromEntries(
  QUESTIONS.filter((q) => q.category === 'tentacle').map((q) => [q.id, Number(q.param) || 0]),
));

/** Rows per page in §02's table once it pages at all. */
export const TABLE_PAGE = 100;
/** Below this many zones the table is never paged. */
export const TABLE_PAGE_ABOVE = 300;
/** Above this many zones the map plots score bands, not label pills. */
export const MAX_MAP_ZONES = 1200;
/** Endgame spots carried per zone; the card states the true total. */
export const SPOTS_SHIPPED = 10;
/** Simulator feature cap per category; the page says so when it bites. */
export const MAX_POI_PER_CATEGORY = 500;
/**
 * The zone score's denominator everywhere it is printed. A constant because
 * `overallTenths` is already renormalised to `1000 × earned ÷ max` (`rules/score.js`),
 * whether or not every axis could be measured. See CONTRACT.md §(g) 8.
 */
export const SCORE_MAX = 100;

// ── the shared numeric helpers ───────────────────────────────────────────────
//
// Rounding happens ONCE, inside `zoneViews`; `simulator.js` prints those fields rather
// than calling these again. Exported because CONTRACT.md §(a) names them.

/**
 * Integer tenths of a point → the number the page prints.
 * @param {number|null|undefined} tenths @returns {number}
 */
export function pts(tenths) {
  return (tenths === null || tenths === undefined) ? 0 : rhu(tenths / 10.0, 1);
}

/**
 * Axis fill as a 0–100 percentage, guarding a zero denominator. The guard
 * is load-bearing: with no map files the `E` and `A` axes carry `axisMax === 0`, and
 * the page must say "not measured" rather than draw `0 / 0`.
 *
 * @param {number|null|undefined} earnedTenths @param {number|null|undefined} maxTenths
 * @returns {number}
 */
export function bar(earnedTenths, maxTenths) {
  if (!maxTenths) return 0;
  return rhu((100.0 * (earnedTenths || 0)) / maxTenths, 1);
}

/** The shares of this map's best zone at which `band()` steps up; the legend prints them. */
export const BAND_CUTS = Object.freeze({ top: 0.9, good: 0.75, fair: 0.55 });

/**
 * Colour band for the map and the rail, relative to this map's own best zone.
 * Relative on purpose: a 41-point zone is a bad hide on a great map and
 * the best available on a poor one.
 *
 * @param {number} overall @param {number} best
 * @returns {'top'|'good'|'fair'|'weak'|'un'}
 */
export function band(overall, best) {
  if (best <= 0) return 'un';
  const share = overall / best;
  if (share >= BAND_CUTS.top) return 'top';
  if (share >= BAND_CUTS.good) return 'good';
  if (share >= BAND_CUTS.fair) return 'fair';
  return 'weak';
}

// ── tiny deterministic primitives ────────────────────────────────────────────

/** Sorted keys of a plain object. Nothing here ever iterates one unsorted. */
function keysOf(obj) {
  return Object.keys(obj || {}).sort(cmpStr);
}

/** `{metricId: Metric}` for one zone score. */
function metricById(score) {
  const out = Object.create(null);
  for (const m of (score && score.metrics) || []) out[m.id] = m;
  return out;
}

/**
 * The first ranked zone that carries a score. The per-axis
 * maxima are identical across zones, so one zone supplies the published totals every
 * axis label and column header prints.
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
 * DIVERGENCE, deliberate: `GEO_CATEGORIES` lives in a worker module this file may not
 * import, so the set is derived from the two `GeoData` fields keyed by category:
 * `counts` (zero-count categories included) and `pois`. A category that was never
 * queried is absent from the chips instead of appearing dead.
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

/** A question's short verdict: `explain.lead`, else the full `why`. */
function leadOf(q) {
  return (q && q.explain && q.explain.lead) || (q && q.why) || '';
}

/** Questions in id order, for every chip loop. */
function questionsById(report) {
  return Array.from((report && report.questions) || []).sort((a, b) => cmpStr(a.id, b.id));
}

/**
 * The DISTINCT reaches of a set of tentacle questions, ascending, in miles: `[]` for a
 * SMALL deck, `[1]` for MEDIUM, `[1, 15]` for LARGE. See `TENTACLE_ID_REACH_MI`.
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

/** One zone flag, as icon **and** word — never colour alone. */
function flagChip(flag, { short = false } = {}) {
  const [label, variant, icon, shortLabel] = FLAG_TEXT[flag] || [flag, 'neutral', 'circle-info'];
  return chip(short && shortLabel ? shortLabel : label, icon, { variant });
}

/** A question status in §07's words. */
function statusChip(status) {
  const [word, icon, variant, appearance] = S4_STATUS_TAG[status]
    || [status, 'circle-question', 'neutral', 'outlined'];
  return chip(word, icon, { variant, appearance });
}

/** Only a degraded source gets a chip; a healthy timetable and OpenStreetMap need no label. */
function sourceChips(report) {
  const assumed = Boolean((report.metrics || {}).assumedSchedule);
  const geoAvailable = Boolean((report.geo || {}).available);
  return join(
    assumed ? degradeChip('assumed_schedule') : '',
    geoAvailable ? '' : degradeChip('osm_unavailable'),
  );
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
 * @property {string[]} stopIds @property {string[]} routeNames
 * @property {number|null} travelMin
 * @property {number|null} travelShare  R1 `raw`: travel ÷ hiding period
 * @property {Object[]} threats @property {Object[]} metrics
 * @property {Object[]} spots @property {number} spotsTotal
 * @property {Object<string,number>} inventory
 * @property {boolean} osmReady  the map layer loaded and this zone has an inventory entry
 * @property {ServiceView} service
 */

/**
 * The ranked zone view model — the one place a zone becomes numbers for the page.
 *
 * Order: `report.rankedZoneIds` first, carrying rank 1..n, then every remaining key of
 * `report.zoneScores` in code-point order with `rank === null`. Those are the zones
 * `rankZones` held out (unreachable, or no service), and nothing is silently dropped.
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

  // One pass over `report.stops` instead of one per zone.
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

    // R1 is stored as travel ÷ hiding period; minutes are derived from it, never
    // re-measured, so the two cannot disagree.
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

    const spots = ((geo.legalSpots || {})[zid]) || [];
    const flags = Array.from(score.flags || []);

    // SCOPE-REDUCED (CONTRACT.md §(g)): the per-day block reads
    // `ServiceDay.stopDays`, which `daySummary` strips before `postMessage`. S1/S2/S3
    // plus the stop rows say the same minus first/last times and the sparkline.
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
      // DIVERGENCE, CONTRACT.md §(g) 8: `overall` is renormalised to 100
      // (`rules/score.js`) rather than shown over the sum of the raw axis maxima,
      // which with OSM off could read "97.6 / 70.0" and fill a bar to 139%.
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
      routeNames,
      travelMin,
      travelShare: r1raw,
      threats: Array.from(score.threats || []),
      metrics: Array.from(score.metrics || []),
      spots: spots.slice(0, SPOTS_SHIPPED),
      spotsTotal: spots.length,
      inventory,
      osmReady: Boolean(geo.available && Object.hasOwn(geo.zoneInventory || {}, zid)),
      service,
    });
  }
  return out;
}

/**
 * @typedef {{miles:number, label:string, why:string, usable:boolean,
 *            status:string, lead:string, degrade:string|null}} RadarChip
 * @typedef {{key:string, label:string, count:number,
 *            why:string, usable:boolean, reachMi:number|null,
 *            status:string, lead:string, degrade:string|null}} CatChip
 *
 * `reachMi` is the tentacle chip's own reach in miles (`TENTACLE_ID_REACH_MI`), `null`
 * on matching and measuring chips. The simulator measures against THIS number. `lead`
 * is the question's `explain.lead`, or its `why` when the audit carries no split.
 */

/**
 * Per-mode chip definitions, resolved once. A chip must name a
 * real question and a real OSM category, and neither join can be reconstructed from
 * an id in the browser.
 *
 * DIVERGENCE: the category label comes from the `QuestionAudit`'s own `label` rather
 * than from `GEO_CATEGORIES` (see `geoKeys`). Same words in practice.
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
      miles,
      label: q.label,
      why: q.why,
      usable: q.status === 'functional' || q.status === 'weak',
      status: q.status,
      lead: leadOf(q),
      degrade: q.degrade ?? null,
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
        label: q.label,
        count: counts[key] || 0,
        why: q.why,
        usable: (q.status === 'functional' || q.status === 'weak')
          && Array.isArray(features) && features.length > 0,
        // per QUESTION, not per game size (see `TENTACLE_ID_REACH_MI`)
        reachMi: mode === 'tentacle' ? (TENTACLE_ID_REACH_MI[q.id] ?? null) : null,
        status: q.status,
        lead: leadOf(q),
        degrade: q.degrade ?? null,
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
 * The simulator's POI set. Only categories a matching /
 * measuring / tentacle question uses, and only where features exist. Each is capped
 * and `capped` names the ones where the cap bit, so the page can say so.
 *
 * COORDINATE ORDER is `[lon, lat, name]`: GeoJSON's, and the opposite of every
 * `haversineM(lat, lon, …)` call.
 *
 * @param {Object} report
 * @returns {{categories: Object<string, PoiCategory>, capped: string[], cap: number}}
 */
export function poiCategories(report) {
  const rep = report || {};
  const geo = rep.geo || {};
  const pois = geo.pois || {};
  const keys = geoKeys(rep);

  // Exactly the categories a chip can select.
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
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE HERO AND ITS PICK CARD
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * One axis row of the pick card: short name, letter, bar, earned/max. An axis whose
 * maximum is zero was never measurable and draws no bar, never `0.0 / 0`.
 */
function axisMeter(view, axis, geoAvailable) {
  const [longName, shortName] = AXIS_PLAIN[axis];
  const label = el('span', join(
    el('span', esc(shortName), { className: 'wa-caption-s' }),
  ), { className: 'wa-cluster wa-gap-2xs wa-align-items-center' });
  if (!view.axisMax[axis]) return unmeasuredRow(label, geoAvailable);
  const right = el('span', esc(`${num(view.axes[axis], 1)} / ${num(view.axisMax[axis], 0)}`), {
    className: 'wa-caption-s wa-color-text-quiet',
  });
  return meter(label, view.bars[axis], right, { flank: '4.5rem', label: longName });
}

/** An unmeasurable axis: its label and the cause, with no bar. */
function unmeasuredRow(labelHtml, geoAvailable) {
  return el('div', join(labelHtml, geoAvailable
    ? el('span', esc('not measured'), { className: 'wa-caption-s wa-color-text-quiet' })
    : degradeChip('osm_unavailable')), {
    className: 'wa-split wa-flex-wrap wa-gap-2xs wa-align-items-center',
  });
}

/**
 * The page's answer, above everything else: the top-ranked zone in full.
 * Rendered once; the simulator's `selected` initialises to the same zone.
 *
 * @param {Object} report @param {ZoneView} view the rank-1 zone
 * @returns {string}
 */
function pickCard(report, view) {
  const size = report.size || {};
  const hub = report.hub || {};
  const period = Number(size.hidingPeriodMin) || 0;

  const ride = (view.travelShare === null || !period)
    ? el('p', esc(`Not reachable from ${hub.name} in time`), {
      className: 'wa-caption-s wa-color-text-quiet',
    })
    : meter(
      el('span', esc(`Ride from ${hub.name}`), { className: 'wa-caption-s' }),
      fillPct(view.travelShare),
      el('span', esc(`${mins(view.travelMin)} of ${mins(period)}`), {
        className: 'wa-caption-s wa-color-text-quiet',
      }),
      { flank: '7rem', label: 'Share of the hiding period spent riding' },
    );

  const geoAvailable = Boolean((report.geo || {}).available);
  const meters = AXIS_IDS.map((a) => axisMeter(view, a, geoAvailable)).join('');
  const flags = view.flags.map((f) => flagChip(f)).join('');

  const header = el('div', join(
    el('span', join(waBadge('#1'), el('span', esc(view.name), { className: 'wa-heading-s' })), {
      className: 'wa-cluster wa-gap-2xs wa-align-items-center',
    }),
    el('span', esc(`${num(view.overall, 1)} / ${num(view.max, 0)}`), {
      className: 'wa-caption-s wa-color-text-quiet',
    }),
  ), { className: 'wa-split' });

  const body = el('div', join(
    ride,
    el('div', meters, { className: 'wa-stack wa-gap-2xs' }),
    flags ? el('div', flags, { className: 'wa-cluster wa-gap-2xs' }) : '',
    view.routeNames.length
      ? el('div', join(
        el('span', esc('Routes'), { className: 'wa-caption-xs wa-color-text-quiet' }),
        view.routeNames.map((name) => waTag(name)).join(''),
      ), { className: 'wa-cluster wa-gap-3xs wa-align-items-center' })
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
 * The hero: kicker, headline, the chip strip (with the two source states), the pick
 * card, and the one link out. `href="#top"` leaves the route (spec §5.1): `applyRoute`
 * treats any hash that is not `#strategy` as an exit, and the link is visible only from
 * inside the secret view.
 */
function hero(report, views) {
  const feed = report.feed || {};
  const size = report.size || {};
  const agency = feed.agencyName || '';
  const place = report.place || agency;
  const zones = report.zones || [];

  const chips = join(
    chip(`${capWord(size.name)} game`, 'ruler-combined', { variant: 'warning' }),
    chip(`${num(zones.length)} scored zones`, 'location-dot'),
    sourceChips(report),
  );

  const back = el('a', join(waIcon('arrow-left'), esc('Back to the feasibility report')), {
    href: '#top', className: 'wa-link wa-caption-s wa-cluster wa-gap-2xs',
  });

  const left = el('div', join(
    el('p', esc(`Hider's guide · ${agency}`), {
      className: 'kicker wa-caption-s wa-text-uppercase',
    }),
    el('h1', esc(`Where to hide in ${place}`), { className: 'wa-heading-4xl' }),
    el('div', chips, { className: 'wa-cluster wa-gap-2xs' }),
    back,
  ), { className: 'wa-stack wa-gap-xs', style: 'flex:1 1 24rem' });

  // Top-aligned: the pick card is much taller than the text, and centring pushes the
  // h1 down once the columns sit side by side.
  return el('header', el('div', join(
    left,
    el('div', pickCard(report, views[0]), { style: 'flex:1 1 26rem' }),
  ), { className: 'wa-split wa-flex-wrap wa-gap-2xl wa-align-items-start' }), {
    id: 's-top', className: 'wa-stack wa-gap-l',
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// §01 THE SHORTLIST — the map, the simulator, the rail, the dossier
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * §01's map card: the mode buttons, the MapLibre host, the readout, the legend.
 * Order is steps → controls → map → readout → legend → method, and none of controls,
 * map, readout or legend may be collapsed: `#s-map` is a MapLibre container, which reads its size once.
 */
function mapCard(report) {
  const size = report.size || {};
  const hub = report.hub || {};
  const zones = report.zones || [];
  const questions = report.questions || [];
  const radiusLabel = s4Dist(report, size.zoneRadiusM || 0, 2);

  // A `wa-radio-group` of button-appearance radios, as `s4ChipGroup` (render/deck.js)
  // builds: the group carries the role, label, arrow keys and a real checked state.
  // Not `s4ChipGroup` itself because it cannot express `disabled`, and a dead mode
  // shown disabled-with-reason is the point of this row.
  const chips = modeChips(report);
  const geoAvailable = Boolean((report.geo || {}).available);
  const reasons = new Map();
  const radios = MODE_LABEL.map(([mode, label]) => {
    let cause = '';
    let text = '';
    if (mode !== 'explore') {
      const category = MODE_CATEGORY[mode];
      const family = questions.filter((q) => q.category === category);
      const live = family.filter((q) => q.status === 'functional' || q.status === 'weak');
      if (!family.length) {
        // The audit holds only this size's deck, so an empty family means the RULEBOOK
        // left the category out; today that is only tentacles in SMALL games
        // (`rules/catalogue.js`). Not a map problem, so not blamed on the geography.
        cause = chip(`Not in ${capWord(size.name)} decks`, 'ban');
        text = '';
      } else if (!live.length) {
        // A degradation is the whole family's cause; one question's lead would misname it.
        cause = family[0].degrade ? degradeChip(family[0].degrade) : statusChip(family[0].status);
        text = family[0].degrade ? '' : leadOf(family[0]);
      } else if (mode !== 'thermo' && !(chips[mode] || []).length) {
        // A live question with no selectable subject: `modeChips` derives its
        // categories from what the OSM stage returned (see `geoKeys`), so with the map
        // layer off the mode would open on an empty option row. Dead is dead.
        cause = degradeChip(geoAvailable ? 'osm_not_queried' : 'osm_unavailable',
          geoAvailable ? { suffix: 'no map features' } : {});
        text = '';
      }
    }
    const reason = Boolean(cause);
    if (reason) {
      const key = `${cause}\n${text}`;
      if (!reasons.has(key)) reasons.set(key, { cause, text, labels: [] });
      reasons.get(key).labels.push(label);
    }
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

  // The group's label stays visible: a row of icon buttons does not otherwise say what
  // it selects, and “No question” only reads as a mode under a heading that names one.
  const modes = el('wa-radio-group', radios, {
    id: 's-modes',
    name: 's-mode',
    size: 's',
    orientation: 'horizontal',
    label: 'Question mode',
    value: 'explore',
    dataPrint: 'hide',
  });

  // Printed, not a `title`: a disabled control is not focusable, so a tooltip on it
  // is reachable only by pointer hover. Modes sharing a reason are named together.
  const modesWhy = reasons.size
    ? el('div', Array.from(reasons.values(), (r) => el(
      'p',
      join(el('b', esc(s4JoinWords(r.labels))), r.cause, esc(r.text)),
      { className: 'wa-caption-xs wa-color-text-quiet wa-cluster wa-gap-2xs wa-align-items-center' },
    )).join(''), { id: 's-modes-why', className: 'wa-stack wa-gap-3xs' })
    : '';

  const steps = el('ol', [
    ['compass', 'Pick a mode'],
    ['location-crosshairs', 'Drop a seeker'],
    ['users', 'Hide in the biggest colour'],
  ].map(([icon, word], i) => el('li', join(
    i ? waIcon('arrow-right') : '',
    iconLabel(icon, word, { quiet: false }),
  ), { className: 'wa-cluster wa-gap-2xs wa-align-items-center' })).join(''), {
    className: 'wa-cluster wa-gap-xs wa-caption-s wa-list-plain',
    role: 'list',
    dataPrint: 'hide',
  });

  // The dots carry two encodings and the view OPENS in explore mode, where they are
  // score bands; simulator.js sets `data-mode` so CSS shows only the live key.
  const dot = (token) => swatch(
    `background:var(${token});border-radius:var(--wa-border-radius-circle)`,
  );
  const poi = poiCategories(report);
  const capped = poi.capped.map((k) => chip(
    `${poi.categories[k].label}: first ${num(poi.cap)} only`, 'filter', { variant: 'warning' },
  )).join('');
  const legend = el('div', join(
    el('div', legendRow([
      [dot('--gold-mark'), `Top ≥${pct(BAND_CUTS.top, 0)}`],
      [dot('--accent'), `Good ≥${pct(BAND_CUTS.good, 0)}`],
      [dot('--warn'), `Fair ≥${pct(BAND_CUTS.fair, 0)}`],
      [dot('--off'), 'Weak or unscored'],
    ], {
      label: 'Score band key',
      leadHtml: chip('Score bands · share of best zone', MODE_ICON.explore),
    }), { dataLegend: 'score' }),
    // The survival share's meaning rides on the readout meter's accessible name.
    el('div', legendRow([
      [dot('--q-yes'), 'Yes / hotter / in reach'],
      [dot('--q-no'), 'No / colder / out of reach'],
      [dot('--q-edge'), 'Edge · could go either way'],
      [dot('--q-un'), 'Awaiting input'],
    ], {
      label: 'Answer key',
      leadHtml: chip('Answers', MODE_ICON.radar),
    }), { dataLegend: 'answer' }),
    legendRow([
      [el('span', esc('★'), { style: 'color:var(--gold-deep);font-weight:800' }), hub.name],
      [swatch('background:transparent;border:1.5px dashed var(--gold-deep)'), 'Game border'],
      [swatch('background:transparent;border:1.5px solid var(--accent);'
        + 'border-radius:var(--wa-border-radius-circle)'), `Selected zone’s ${radiusLabel} circle`],
    ], { label: 'Map marks' }),
    capped ? el('div', capped, { className: 'wa-cluster wa-gap-2xs' }) : '',
  ), { id: 's-legend', className: 'wa-stack wa-gap-2xs' });

  const how = waDetails('How the simulator works', el('p', esc(
    'The same maths as the scores, run for the one seeker you place instead of the many '
    + 'the scores average over.',
  ), { className: 'wa-body-s' }), { appearance: 'plain' });

  return waCard(el('div', join(
    steps,
    modes,
    modesWhy,
    el('div', '', { id: 's-opts', className: 'wa-stack wa-gap-2xs', dataPrint: 'hide' }),
    el('div', '', { id: 's-map', dataPrint: 'hide' }),
    el('div', '', { id: 's-readout', className: 'wa-body-s', ariaLive: 'polite' }),
    legend,
    how,
  ), { className: 'wa-stack wa-gap-s' }), {
    headerHtml: cardHeader('The map', { chipsHtml: chip(`${num(zones.length)} zones`, 'location-dot') }),
  });
}

/**
 * §01's ranked rail and the dossier shell the simulator fills. The rail is a
 * `role="listbox"` built client-side; it is a shortlist, and the link under it says so.
 */
function railAndDossier(report) {
  const zones = report.zones || [];

  const head = el('div', join(
    subhead('Ranked candidates', { anchorId: 's-dossier' }),
    el('span', '', { id: 's-count', className: 'wa-caption-s wa-color-text-quiet' }),
  ), { className: 'wa-split' });

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

  // `#s-back` is shown only where the dossier sits under the rail; `simulator.js`
  // owns that width test and cancels the click, because changing the fragment here
  // would take `applyRoute` (app.js) out of the guide.
  const back = el('a', join(waIcon('arrow-up'), esc('Back to the list')), {
    id: 's-back',
    href: '#s-list',
    className: 'wa-link wa-caption-s wa-cluster wa-gap-2xs',
    hidden: true,
  });

  const dossier = el('div', waCard(
    el('div', el('p', esc('Select a zone on the map or in the list.'), {
      className: 'wa-body-s',
    }), { id: 's-body', className: 'wa-stack wa-gap-m' }),
    {
      headerHtml: el('div', join(
        el('h3', esc('Zone dossier'), { className: 'wa-heading-s', id: 's-title' }),
        el('div', join(
          el('span', '', { id: 's-score', className: 'wa-caption-s wa-color-text-quiet' }),
          back,
        ), { className: 'wa-cluster wa-gap-s wa-align-items-center' }),
      ), { className: 'wa-split' }),
    },
  ), { id: 's-detail' });

  return el('div', join(
    el('div', join(head, rail, more), { className: 'wa-stack wa-gap-s' }),
    dossier,
  ), { className: 'wa-grid wa-gap-l', style: '--min-column-size:22rem' });
}

/**
 * The host for the printed write-ups. One dossier is on screen at a time, so a
 * printout would otherwise carry none; `simulator.js` fills this at init and the
 * print stylesheet reveals it.
 */
function printDossiers() {
  return el('div', '', {
    id: 's-print-dossiers',
    className: 'wa-stack wa-gap-l',
    hidden: true,
  });
}

/** §01 — the map, the simulator, the ranked rail and the dossier, in one section. */
function sectionShortlist(report) {
  const size = report.size || {};
  const answer = el('div', join(
    chip(`${s4Dist(report, size.zoneRadiusM || 0, 2)} circles`, 'circle-dot'),
    chip(`${num(s4LiveQuestions(report))} of ${num((report.questions || []).length)} `
      + 'questions work', 'circle-check'),
  ), { className: 'wa-cluster wa-gap-2xs' });

  return section('s-zones', '01', 'The shortlist',
    join(mapCard(report), railAndDossier(report), printDossiers()), {
      kicker: 'Map & question simulator',
      answerHtml: answer,
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// §02 THE WHOLE FIELD — every scored zone, sortable and filterable
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The eleven column words of §02's table, in column order. **The ORDER is the contract
 * with `simulator.js`. Never reorder them.** `wa-data-grid` addresses a
 * column by string id (`rank`, `name`, `score`, `axis-IR` … `flags`, `travel`).
 */
const TABLE_HEADERS = Object.freeze([
  Object.freeze(['Rank', '']),
  Object.freeze(['Zone', '']),
  Object.freeze(['Score', '']),
  ...AXES.map((a) => Object.freeze([AXIS_PLAIN[a[0]][1], a[0]])),
  Object.freeze(['Flags', '']),
  Object.freeze(['Travel', '']),
]);

/**
 * The same eleven words as flat column labels. `wa-data-grid`'s `label` is a bare
 * string, so the axis's `<code>` chip folds into the text. The letter is KEPT in
 * parentheses: the 'Best on each axis' rows above the table link `#s-axis-{AXIS}` by it,
 * and CONTRACT §(g) note 3 makes those rows the substitute for the header tooltips.
 */
export const TABLE_LABELS = Object.freeze(
  TABLE_HEADERS.map(([word, axis]) => (axis ? `${word} (${axis})` : word)),
);

/** §02 — every scored zone, sortable and filterable, plus the axis winners. */
function sectionWholeField(report, views) {
  const zones = report.zones || [];
  const ref = referenceScore(report);
  const excluded = views.filter((v) => v.excluded);
  const geoAvailable = Boolean((report.geo || {}).available);

  // Axis winners: the best non-excluded zone on each axis, in `views` order so a tie
  // goes to the better-ranked zone. Every axis gets a row, measured or not, because
  // its name is the link into §04 that replaces the header tooltips.
  const winnerRows = AXES.map(([axis]) => {
    const [longName, shortName] = AXIS_PLAIN[axis];
    const maxPts = ref ? pts(ref.axisMax[axis]) : 0;
    const head = join(
      el('a', esc(shortName), { href: `#s-axis-${axis}`, className: 'wa-link wa-caption-s' }),
    );
    const cluster = 'wa-cluster wa-gap-2xs wa-align-items-center';
    if (!maxPts) return el('li', unmeasuredRow(el('span', head, { className: cluster }), geoAvailable));
    let best = null;
    for (const v of views) {
      if (v.excluded) continue;
      if (best === null || v.axes[axis] > best.axes[axis]) best = v;
    }
    if (best === null) return el('li', el('span', head, { className: cluster }));
    return el('li', meter(
      el('span', join(head, chip(best.name, 'location-dot', { variant: 'brand' })), {
        className: cluster,
      }),
      best.bars[axis],
      el('span', esc(`${num(best.axes[axis], 1)} / ${num(maxPts, 0)}`), {
        className: 'wa-caption-s wa-color-text-quiet',
      }),
      { flank: '4rem', label: `${longName}: ${best.name}` },
    ));
  }).join('');
  const winnersBlock = el('div', join(
    subhead('Best on each axis'),
    waCard(el('ul', winnerRows, { className: 'wa-stack wa-gap-s wa-list-plain', role: 'list' })),
  ), { className: 'wa-stack wa-gap-xs' });

  const controls = el('div', join(
    searchInput('s-filter', {
      placeholder: 'Filter by name, route or flag', label: 'Filter zones',
    }),
    el('span', '', { id: 's-tableinfo', className: 'wa-caption-s wa-color-text-quiet' }),
  ), {
    id: 's-controls',
    className: 'wa-split wa-flex-wrap wa-gap-s',
    dataPrint: 'hide',
  });

  // The component owns the sort cycle, arrows, `aria-sort`, stripes and scrolling;
  // `simulator.js` hands it `columns` and `data`. Four attributes carry behaviour the
  // hand-rolled table had:
  //   `sort-desc-first`      a new column opens on its most useful end; Zone overrides
  //                          it back (`sortDescFirst: false`).
  //   `without-sort-removal` the old cycle had no unsorted state.
  //   `max-multi-sort="1"`   shift-click would otherwise stack a second sort entry.
  //   `striped`              `wa-zebra-rows` was scoped to `<tbody> <tr>` and stops matching.
  // `with-search` is ABSENT: the filter matches route names, which are not a column,
  // and the component's box would render below the sticky `#s-controls`. `#s-filter`
  // drives the grid through `searchFn` + `searchTerm`. No `wa-scroller`: the grid is
  // already the horizontal scroller, and nesting one would confuse the row virtualizer.
  const table = el('wa-data-grid', '', {
    id: 's-table',
    label: 'Every scored zone',
    rowKey: 'id',
    size: 's',
    striped: true,
    sortDescFirst: true,
    withoutSortRemoval: true,
    maxMultiSort: '1',
  });

  const pager = el('div', '', {
    id: 's-pager', className: 'wa-cluster wa-gap-s wa-align-items-center',
    dataPrint: 'hide',
  });

  let excludedBlock = '';
  if (excluded.length) {
    const size = report.size || {};
    const period = Number(size.hidingPeriodMin) || 0;
    const dayLabel = s4DayLabel(report, s4BestDay(report));
    const rows = excluded.map((v) => [
      esc(v.name),
      el('div', v.flags.filter((f) => f === 'unreachable' || f === 'no_service')
        .map((f) => flagChip(f, { short: true })).join(''), {
        className: 'wa-cluster wa-gap-2xs wa-align-items-center',
      }),
      esc(v.travelMin === null ? '—' : mins(v.travelMin, 0)),
    ]);
    excludedBlock = waDetails('Zones outside the ranking', join(
      el('p', esc(`Still scored but not ranked. Either no bus arrives inside the ${mins(period)} `
        + `hiding period, or there are no departures on a ${dayLabel}.`), {
        className: 'wa-body-s',
      }),
      dataTable(['Zone', 'Why', 'Travel time'], rows),
    ));
  }

  return section('s-all', '02', 'The whole field',
    el('div', join(winnersBlock, controls, table, pager, excludedBlock), {
      className: 'wa-stack wa-gap-l',
    }), {
      kicker: `All ${num(zones.length)} scored zones`
        + (excluded.length ? ` · ${num(excluded.length)} outside the ranking` : ''),
      lede: 'One ranking, six axes: sort by the one you care about.',
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// §03 HOW TO PLAY THIS MAP — the parameterised playbook
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * §03 — rulebook tips parameterised from this feed, dropped when they do not apply.
 * Each card shows its basis, its figures as chips, and the rulebook sections it cites,
 * with the clause text folded.
 */
function sectionTactics(report) {
  const size = report.size || {};
  const geo = report.geo || {};
  const hub = report.hub || {};
  const metrics = s4MetricLookup(report);
  const radius = s4Dist(report, size.zoneRadiusM || 0, 2);
  const tips = [];
  const para = (text) => el('p', esc(text), { className: 'wa-body-s' });
  const lines = (rows) => el('ul', rows.map(([icon, text]) => el(
    'li', iconLabel(icon, text, { quiet: false }),
  )).join(''), { className: 'wa-stack wa-gap-3xs wa-body-s wa-list-plain', role: 'list' });

  tips.push({
    title: 'Spend the whole hiding period',
    basis: 'rulebook',
    chips: chip(mins(size.hidingPeriodMin), 'hourglass-half'),
    body: para('Where you stand when the timer ends is your zone. Plan the ride, not just the '
      + 'destination.'),
    clauses: [['Hiding Zones', "“if the hiding period ends and you're somewhere else, then "
      + 'that\'s where your hiding zone is.”']],
  });

  tips.push({
    title: 'Scope your endgame spot early, then wander',
    basis: 'interp',
    chips: chip(`${radius} circle`, 'circle-dot'),
    body: para('Wander inside your circle, but you freeze the moment a seeker walks in. Know '
      + 'your spot and pre-take the photos you can.'),
    clauses: [['Hiding Spots', 'the spot is final the moment the end game starts.']],
  });

  const parks = (geo.counts || {}).park;
  if (parks) {
    tips.push({
      title: 'Parks are the best-in-class final spot',
      basis: 'interp',
      chips: chip(`${num(parks)} parks`, 'tree'),
      body: join(
        para('Public at all hours. “Nearest park” measures to the icon, so a big park lets '
          + 'you name another.'),
        (geo.available && geo.pathJoinEvaluated === false)
          ? el('div', degradeChip('path_join_not_evaluated'), {
            className: 'wa-cluster',
          })
          : '',
      ),
      clauses: [
        ['Hiding Spots', 'publicly accessible during all game hours'],
        ['Matching', 'measure to the map icon.'],
      ],
    });
  }

  tips.push({
    title: 'Businesses are a mid-round tool, not a hiding spot',
    basis: 'rulebook',
    chips: '',
    body: para('Loitering draws attention and opening hours rarely cover the game. Use them '
      + 'for a bathroom, food and warmth mid-round.'),
    clauses: [['Hiding Spots', "“we'd suggest avoiding stores or other businesses.”"]],
  });

  if (size.name !== 'small') {
    const tentacles = (report.questions || []).filter(
      (q) => q.category === 'tentacle' && (q.status === 'functional' || q.status === 'weak'),
    );
    if (tentacles.length) {
      // Per question, never `size.tentacleReachMi`: a LARGE deck has both 1-mile and
      // 15-mile tentacles. (`TENTACLE_ID_REACH_MI`.)
      const reaches = tentacleReachesMi(tentacles);
      // The chip names the subject; the reach is the header chip, or rides in each chip
      // when the deck mixes reaches.
      const subject = (label) => String(label || '').replace(/\s+within\s+\S+\s+miles?$/i, '');
      const named = Array.from(new Set(tentacles.map((q) => (reaches.length === 1
        ? subject(q.label)
        : `${subject(q.label)} · ${s4Val(TENTACLE_ID_REACH_MI[q.id])} mi`)))).sort(cmpStr);
      tips.push({
        title: 'Respect the tentacle categories',
        basis: 'rulebook',
        chips: reaches.map((r) => chip(`${s4Val(r)} ${s4Plural(r, 'mile')}`, 'ruler')).join(''),
        body: join(
          el('div', named.map((name) => chip(name, 'diagram-project')).join(''), {
            className: 'wa-cluster wa-gap-2xs',
          }),
          lines([
            ['arrows-to-dot', 'Measured from the seekers, so the name can be far outside your zone'],
            ['circle-xmark', 'Out of reach yourself? Say “not within reach” and you still draw the card'],
          ]),
        ),
        clauses: [['Tentacle Questions', '“(You must also be within ___ miles.)”']],
      });
    }
  }

  tips.push({
    title: 'Radar targets you, not your zone',
    basis: 'rulebook',
    chips: '',
    body: el('p', join(
      esc('If the ring clips your circle but not your body, the answer is no. Stand on the '
        + `far side of your ${radius} circle. `),
      swatch('background:var(--q-edge);border-radius:var(--wa-border-radius-circle)'),
      esc(' Edge zones in the simulator are exactly this case.'),
    ), { className: 'wa-body-s' }),
    clauses: [['Radar Questions', 'the answer is about your location, not your zone.']],
  });

  tips.push({
    title: 'Build the deck to end the round holding time',
    basis: 'interp',
    chips: '',
    body: join(
      para('Bonuses count only if they are in your hand when you are caught.'),
      el('div', join(
        chip('~½ time bonuses', 'clock'),
        chip('~¼ powerups', 'bolt'),
        chip('~¼ curses', 'hand-sparkles'),
      ), { className: 'wa-cluster wa-gap-2xs' }),
      el('div', chip('Move powerup', 'person-running'), { className: 'wa-cluster' }),
      lines([
        ['hand', 'Costs your whole hand'],
        ['eye', 'Reveals your original station'],
        ['ban', 'Not playable in the end game'],
      ]),
    ),
    clauses: [['The Hider Deck', 'six-card hand limit'], ['Powerups', 'Move.']],
  });

  const evening = metrics.D2;
  const eveningRaw = evening ? fnum(evening.raw) : null;
  if (eveningRaw !== null && eveningRaw < 0.85) {
    // This view has no day banner, so the card names the day instead. An assumed
    // timetable keeps `raw` but not `available`, and its share is never printed.
    const worstKey = s4WorstDay(report);
    const measured = evening.available !== false;
    tips.push({
      title: 'Watch the service clock',
      basis: 'interp',
      chips: join(
        measured ? '' : degradeChip(evening.degrade || 'assumed_schedule'),
        worstKey
          ? chip(`Thinnest day · ${s4DayLabel(report, worstKey)}`, 'calendar-xmark', {
            variant: 'warning',
          })
          : '',
      ),
      body: join(
        measured ? kpi(pct(eveningRaw), 'of zones still served at round end', '', { size: 'l' }) : '',
        para('Late on, an hourly zone has no Move escape, and the seekers know it.'
          + (worstKey ? ' Settle the day before you shortlist.' : '')),
      ),
      clauses: [['Powerups', 'Move requires a departure to exist.']],
    });
  }

  // `Metrics.hubDominance` is the value used here.
  const dominance = fnum((report.metrics || {}).hubDominance);
  if (dominance !== null && dominance >= 0.5) {
    tips.push({
      title: 'Assume the seekers pass through the hub',
      basis: 'interp',
      chips: '',
      body: join(
        kpi(pct(dominance), 'of routes pass through', '', {
          size: 'l', subHtml: chip(hub.name, 'star'),
        }),
        para('Zones reached only back through the hub cost the seekers the transfer twice.'),
      ),
      clauses: [['Seeking', 'seekers move on the same transit you do.']],
    });
  }

  const items = tips.map((tip) => el('li', waCard(
    el('div', join(
      el('div', join(
        el('p', esc(tip.title), { className: 'wa-heading-s' }),
        el('div', join(basisChip(tip.basis), tip.chips), { className: 'wa-cluster wa-gap-2xs' }),
      ), { className: 'wa-split wa-flex-wrap wa-gap-xs wa-align-items-center' }),
      tip.body,
    ), { className: 'wa-stack wa-gap-xs' }),
    {
      footerHtml: leadDetail('', legendRow(tip.clauses.map(([name, text]) => [el('b', esc(name)), text]),
        { label: 'Rule text' }), {
        summary: 'Rule text', chipsHtml: tip.clauses.map(([name]) => chip(name, 'book')).join(''),
      }),
    },
  ))).join('');

  return section('s-tactics', '03', 'How to play this map',
    el('ol', items, { className: 'recs wa-stack wa-gap-s' }), {
      kicker: `The playbook for this map · ${num(tips.length)} tips`,
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// §04 HOW ZONES ARE SCORED — the six axes as reference material
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * §04 — one accordion item per axis, all collapsed. A reader arrives from a column
 * header or a dossier meter wanting one axis, and a collapsed label still shows the
 * plain name, the letter and what it is worth.
 */
function sectionAxes(report) {
  const geo = report.geo || {};
  const ref = referenceScore(report);

  // The example that makes `surv` concrete: the sharpest live question on this map.
  const sharp = (report.questions || [])
    .filter((q) => (q.status === 'functional' || q.status === 'weak') && fnum(q.survMean) !== null)
    .sort((a, b) => (a.survMean - b.survMean) || cmpStr(a.id, b.id))[0] || null;
  const example = sharp
    ? kpi(pct(sharp.survMean, 0), 'of zones left after the sharpest question', '', {
      size: 'l', subHtml: chip(sharp.label, 'circle-question'),
    })
    : '';

  // The pull quote carries the thesis; here its two metrics link to each other.
  const tension = el('p', join(
    linkChip('#s-axis-R', 'Reachable for you', 'route'),
    waIcon('arrows-left-right', { label: 'pulls against' }),
    linkChip('#s-axis-X', 'Hard for the seekers', 'shield'),
  ), { className: 'wa-cluster wa-gap-2xs wa-align-items-center' });

  const items = AXES.map(([axis, name, what, clauses]) => {
    const maxPts = ref ? pts(ref.axisMax[axis]) : 0;
    const rows = [];
    for (const m of (ref && ref.metrics) || []) {
      // `IR1` belongs to `IR`, not `I`: match only when the rest of the id is digits.
      if (!m.id.startsWith(axis) || !/^\d+$/.test(m.id.slice(axis.length))) continue;
      rows.push([
        join(
          esc(m.name), el('sup', esc(m.id), { dataCite: true }),
          m.available === false ? ` ${degradeChip(m.degrade || 'not_evaluated')}` : '',
          leadDetail('', esc(m.note || ''), { summary: 'Why' }),
        ),
        esc(m.unit || '—'),
        el('span', esc(s4RampShort(m.ramp, m.unit)), { ariaLabel: s4RampText(m.ramp, m.unit) }),
        esc(`${num(pts(m.maxTenths), 0)} pt`),
        basisChip(m.source),
      ]);
    }

    let status;
    if (maxPts) {
      status = waBadge(`${num(maxPts, 0)} pt`, { variant: 'neutral', appearance: 'outlined' });
    } else if (geo.available) {
      status = waBadge('not measured on this map', { variant: 'neutral', appearance: 'outlined' });
    } else {
      status = degradeChip('osm_unavailable');
    }
    const label = join(
      el('span', join(
        el('strong', esc(AXIS_PLAIN[axis][0]), { className: 'wa-body-s' }),
      ), { className: 'wa-stack wa-gap-3xs' }),
      el('span', join(
        (axis === 'E' && geo.available && geo.pathJoinEvaluated === false)
          ? degradeChip('path_join_not_evaluated')
          : '',
        status,
      ), { className: 'wa-cluster wa-gap-2xs wa-align-items-center' }),
    );

    const body = el('div', join(
      el('p', esc(name), { className: 'wa-caption-s wa-color-text-quiet' }),
      el('p', esc(what), { className: 'wa-body-s' }),
      axis === 'IR' ? example : '',
      maxPts ? '' : el('p', esc('Its points were left out of the total, so no zone was penalised.'), {
        className: 'wa-body-s wa-color-text-quiet',
      }),
      (axis === 'R' || axis === 'X') ? tension : '',
      rows.length ? dataTable(['Metric', 'Unit', 'Threshold', 'Max', 'Basis'], rows) : '',
      // The clause as §03's cards show theirs: section chips, text folded.
      leadDetail('', legendRow(clauses.map(([n, t]) => [el('b', esc(n)), t]), { label: 'Rule text' }), {
        summary: 'Rule text', chipsHtml: clauses.map(([n]) => chip(n, 'book')).join(''),
      }),
    ), { className: 'wa-stack wa-gap-s' });

    return [`s-axis-${axis}`, label, body, false];
  });

  const back = el('p', el('a', join(waIcon('table'), esc('Back to the table')), {
    href: '#s-all', className: 'wa-link wa-cluster wa-gap-2xs',
  }), { className: 'wa-caption-s' });

  // Once for every Threshold cell below: the cells print only the marks and the figures.
  const thresholdKey = legendRow([
    ['', 'Threshold ○ no points → ● full points, linear between'],
  ], { label: 'Threshold key' });

  return section('s-axes', '04', 'How zones are scored',
    el('div', join(thresholdKey, waAccordion(items, { mode: 'multiple', headingLevel: '3' }), back), {
      className: 'wa-stack wa-gap-m',
    }), {
      kicker: `Six axes, ${num(SCORE_MAX)} points`,
      ledeHtml: legendRow([[basisChip('rulebook'), ''], [basisChip('feed'), ''], [basisChip('interp'), '']], {
        label: 'Basis key',
        leadHtml: esc('Where each threshold comes from'),
      }),
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// §05 METHOD & PARAMETERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * §05 — the scoring parameters actually used. The feasibility report is named in
 * prose and deliberately **not** linked: the hero's back-link is the only affordance.
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
    ['Game size', esc(capWord(size.name))
      + (size.inferred ? ` ${chip('inferred', 'wand-magic-sparkles', { variant: 'warning' })}` : '')],
    ['Hiding period', esc(mins(size.hidingPeriodMin))],
    // Per question, not per size: a LARGE deck prints both reaches, a SMALL deck none.
    ['Tentacle reach', tentacleReaches.length
      ? esc(tentacleReachWords(tentacleReaches))
      : chip(`Not in ${capWord(size.name)} decks`, 'ban')],
    ['Round start', esc(hub.name)],
    // `HH:MM:SS` → `HH:MM`, a string slice
    ['Departure', esc(String(opts.departure || '').slice(0, 5))],
    ['Day shown', esc(s4DayLabel(report, s4BestDay(report)))],
    ['Live questions', esc(`${num(s4LiveQuestions(report))} of ${num(questions.length)}`)],
    ['Feed', esc(agency)],
    ['Feed version', esc(p.feedVersion || 'n/a')],
  ];
  if (/^\d{8}$/.test(String(p.asOf || ''))) {
    rows.push(['Analysis date', esc(prettyDate(String(p.asOf)))]);
  }

  const body = el('div', join(
    dataTable(['Parameter', 'Value'], rows.map(([k, v]) => [esc(k), v])),
    el('p', iconLabel('circle-info', 'Scheduled times are estimates. Check live tracking on the day.'), {
      className: 'wa-body-s',
    }),
  ), { className: 'wa-stack wa-gap-m' });

  // No answer line: the table is the answer.
  return section('s-method', '05', 'Method & parameters', body, {
    kicker: 'What produced these rankings',
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE VIEW
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The whole secret view as one HTML string, or `''` when the report is missing any
 * piece every section depends on. The five sections share that one guard, so the
 * literal ordinals `'01'`…`'05'` are always right. **Do not switch them to
 * `S4_ORDINAL`**: `renumberSections` (app.js) strips `data-n` from every remaining
 * `[data-n="--"]`, which would silently erase them.
 *
 * The returned string is EXACTLY ONE top-level element: `id="strategy"` is the
 * fragment and the `initStrategy` root, and `data-when="strategy"` is what
 * `body:not([data-view='strategy'])` hides. No `data-state`: `fatalError` sweeps
 * `[data-state="skeleton"]`.
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

  // The page's thesis is a pull quote on the hero; §04's R and X items link its two
  // metrics.
  const thesis = pullQuote(
    'A zone you can actually reach and a zone the seekers find expensive to reach are '
    + 'opposite things. One that scores well on both is genuinely rare, and it is what you '
    + 'are shopping for below.',
  );

  const p = rep.provenance || {};
  const credits = [
    ['map', 'Map features © OpenStreetMap contributors, ODbL'],
    ['layer-group', p.adminSource === 'overture'
      ? 'Admin divisions: Overture Maps Foundation'
      : 'Admin divisions © OpenStreetMap contributors, ODbL'],
    ['map-location-dot', 'Basemap: OpenFreeMap, OpenMapTiles data'],
    ['book', "Rules from Jet Lag: The Game's Hide+Seek rulebook"],
  ];

  // `href="#strategy"`, not `#top`: `#top` is the report hero and leaving is what it does.
  const footer = el('footer', join(
    el('ul', credits.map(([icon, text]) => el('li', iconLabel(icon, text, { quiet: false })))
      .join(''), {
      className: 'wa-cluster wa-gap-s wa-caption-s wa-list-plain',
      role: 'list',
      ariaLabel: 'Credits',
    }),
    el('a', join(waIcon('arrow-up'), esc('Back to top')), {
      href: '#strategy', className: 'wa-link wa-caption-s wa-cluster wa-gap-2xs',
    }),
  ), { className: 'wa-stack wa-gap-s' });

  // `section`, not `div`: `wa-page` pads only slotted `main` and `section`, so a `div`
  // lands flush against the header. Not `main`: `wa-page > main` is what styles.css
  // hides to put the report away, so a second `main` would hide the guide from itself.
  // The `--content-width` cap comes from the measure rule in styles.css, which lists
  // `wa-page > section` beside `main`.
  return el('section', join(
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
    // The report's `<main>` is `display: none` while this is up and `wa-page` supplies
    // no landmark, so without this the guide sits outside every landmark region. A
    // `display: none` element is not in the accessibility tree, so the two never collide.
    role: 'main',
    dataWhen: 'strategy',
    className: 'wa-stack wa-gap-3xl',
  });
}
