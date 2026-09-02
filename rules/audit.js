// ═══════════════════════════════════════════════════════════════════════════════
// S3 · QUESTION AND CURSE AUDIT
// ═══════════════════════════════════════════════════════════════════════════════
//
// Ported from generate.py. Three things live here:
//
//   1. THE VERDICTS. Every question gets one of `functional`, `weak`, `degenerate`
//      (exactly one instance, so the answer never varies), `dead` (none) or
//      `unknown` (not evaluated, never a zero). `unaskable` is in the vocabulary
//      but no map earns it. A dead question still pays the hider a card, so it is
//      reported rather than dropped.
//
//   2. INFORMATION RESISTANCE. `answerSignature` computes what every zone would
//      answer; `survivalFractions` computes how many other zones answer the same.
//
//   3. THE CURSE DECK. Which of the 24 curses this map can support.
//
// Worker-side: no DOM, no wall clock, no entropy. Maps and Sets are iterated only
// after their keys have been sorted.

import {
  M_PER_MILE, QUARTER_MILE_M, SEEKER_SAMPLE_CAP, SURV_FULL_UNIVERSE_MAX,
  cmpStr, rhu, num, pct, mins, miles, quantile,
} from '../lib/core.js';
import { Projection, bboxContains, bboxExpand } from '../lib/geo.js';
import { GEO_CATEGORIES, LOW_STREETVIEW_COUNTRIES } from '../osm/geodata.js';
import { QUESTIONS, CURSES, catalogueFor } from './catalogue.js';

const RAD = Math.PI / 180.0;

// ── subject resolution: what data answers each question ───────────────────────
//
// Questions whose subject is not a GEO_CATEGORIES key (`geodataRef`): GTFS, an
// admin ladder, a boundary line, or a datum this pipeline does not carry.

const S3_SPECIAL_SUBJECT = Object.freeze({
  'matching.transit_line': Object.freeze(['gtfs_transit_line', null]),
  'matching.station_name_length': Object.freeze(['gtfs_name_length', null]),
  'matching.street_or_path': Object.freeze(['street', null]),
  'matching.landmass': Object.freeze(['landmass', null]),
  'matching.admin_1': Object.freeze(['admin', 1]),
  'matching.admin_2': Object.freeze(['admin', 2]),
  'matching.admin_3': Object.freeze(['admin', 3]),
  'matching.admin_4': Object.freeze(['admin', 4]),
  'measuring.international_border': Object.freeze(['border_line', 0]),
  'measuring.admin_1_border': Object.freeze(['border_line', 1]),
  'measuring.admin_2_border': Object.freeze(['border_line', 2]),
  'measuring.sea_level': Object.freeze(['dem', null]),
  'tentacle.metro_line': Object.freeze(['gtfs_metro_line', null]),
});

/**
 * Photo questions treated as answerable from anywhere. The last two are a
 * judgement call disclosed in catalogue.js's `photo_always_answerable` row;
 * keep the two lists in step.
 */
const S3_ALWAYS_PHOTOS = Object.freeze([
  'photo.you',
  'photo.the_sky',
  'photo.tallest_structure_in_your_current_sightline',
  'photo.widest_street',
  'photo.trace_nearest_street_path',
  'photo.half_mile_of_streets_traced',
]);

/** Photo questions answered by a per-zone icon count: id → [category, minimum]. */
const S3_PHOTO_COUNT = Object.freeze({
  'photo.any_building_visible_from_transit_station': Object.freeze(['building', 1]),
  'photo.tallest_building_visible_from_transit_station': Object.freeze(['building', 1]),
  'photo.2_buildings': Object.freeze(['building', 2]),
  'photo.5_buildings': Object.freeze(['building', 5]),
  'photo.restaurant_interior': Object.freeze(['restaurant', 1]),
  'photo.grocery_store_aisle': Object.freeze(['grocery', 1]),
  'photo.place_of_worship': Object.freeze(['place_of_worship', 1]),
});

/** Photo questions answered by a polygon intersecting the zone circle. */
const S3_PHOTO_POLYGON = Object.freeze({
  'photo.park': 'park',
  'photo.biggest_body_of_water': 'water',
});

const S3_ORDINAL_WORD = Object.freeze({
  0: 'international', 1: '1st', 2: '2nd', 3: '3rd', 4: '4th',
});

/** Eight fixed bearings, as unit vectors, for the thermometer decision boundary. */
const S3_BEARINGS = Object.freeze([0, 45, 90, 135, 180, 225, 270, 315].map(
  (b) => Object.freeze([Math.cos((90.0 - b) * RAD), Math.sin((90.0 - b) * RAD)]),
));

// Module-level memos, keyed on the zone universe (fixed for a run), so the audit
// and the pipeline never compute the same signature twice.
/** @type {Map<string, *>} */
const S3_MEMO = new Map();

/** A stable identity for the zone universe. One run has exactly one. */
function universeKey(zones) {
  if (!zones.length) return 'empty';
  return `${zones.length}\u0000${zones[0].zoneId}\u0000${zones[zones.length - 1].zoneId}`;
}

/**
 * Recover the run's projection from a zone's (lat, lon) and (x, y); `Projection`
 * is an exactly invertible affine map. `auditQuestions` is not handed one.
 */
function projFromZones(zones) {
  if (!zones.length) return new Projection(0.0, 0.0);
  const z = zones[0];
  const lat0 = z.lat - z.y / 111132.0;
  const mLon = 111320.0 * Math.cos(lat0 * RAD);
  const lon0 = z.lon - (mLon ? z.x / mLon : 0.0);
  return new Projection(lat0, lon0);
}

/**
 * The seeker index sample `S`, identical to the worker's: every zone at or below
 * `SURV_FULL_UNIVERSE_MAX`, else a strided sample capped at `SEEKER_SAMPLE_CAP`.
 * An off-by-one in the stride changes published numbers.
 * (generate.py `_s3_seeker_sample`)
 * @param {Array<Object>} zones
 * @returns {number[]}
 */
export function seekerSample(zones) {
  const n = zones.length;
  const out = [];
  if (n <= SURV_FULL_UNIVERSE_MAX) {
    for (let i = 0; i < n; i++) out.push(i);
    return out;
  }
  const stride = Math.ceil(n / SEEKER_SAMPLE_CAP);
  for (let i = 0; i < n && out.length < SEEKER_SAMPLE_CAP; i += stride) out.push(i);
  return out;
}

/**
 * `d[zoneIndex * m + seekerPosition]` in metres, computed once per run. A flat
 * `Float64Array`: every radar question shares it and it is the audit's CPU peak.
 * (generate.py `_s3_zone_seeker_dists`)
 * @returns {{n: number, m: number, d: Float64Array}}
 */
function zoneSeekerDists(zones, seekers) {
  const key = `zsd\u0000${universeKey(zones)}\u0000${seekers.length ? seekers[0] : ''}\u0000${seekers.length}`;
  const hit = S3_MEMO.get(key);
  if (hit !== undefined) return hit;
  const n = zones.length;
  const m = seekers.length;
  const sx = new Float64Array(m);
  const sy = new Float64Array(m);
  for (let j = 0; j < m; j++) { sx[j] = zones[seekers[j]].x; sy[j] = zones[seekers[j]].y; }
  const d = new Float64Array(n * m);
  for (let i = 0; i < n; i++) {
    const zx = zones[i].x;
    const zy = zones[i].y;
    const base = i * m;
    for (let j = 0; j < m; j++) d[base + j] = Math.hypot(zx - sx[j], zy - sy[j]);
  }
  const out = { n, m, d };
  S3_MEMO.set(key, out);
  return out;
}

/**
 * The radius the Choose radar is modelled at: the median distance between zones,
 * which splits this map most evenly averaged over seeker positions.
 * (generate.py `_s3_choose_radius_m`)
 */
function chooseRadiusM(zones) {
  const key = `choose\u0000${universeKey(zones)}`;
  const hit = S3_MEMO.get(key);
  if (hit !== undefined) return hit;
  const n = zones.length;
  if (n < 2) return QUARTER_MILE_M;          // deliberately not memoised, as in the Python
  const stride = n <= 400 ? 1 : Math.ceil(n / 400);
  const sample = [];
  for (let i = 0; i < n; i += stride) sample.push(zones[i]);
  const dists = [];
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      dists.push(Math.hypot(sample[i].x - sample[j].x, sample[i].y - sample[j].y));
    }
  }
  const value = dists.length ? quantile(dists, 0.5) : QUARTER_MILE_M;
  S3_MEMO.set(key, value);
  return value;
}

/**
 * `"A"`, `"A and B"`, `"A, B and C"` — for lists short enough to print in full.
 * (generate.py `_s3_join`)
 * @param {string[]} items
 * @returns {string}
 */
export function s3Join(items) {
  const rows = Array.from(items);
  if (!rows.length) return '';
  if (rows.length === 1) return rows[0];
  return `${rows.slice(0, -1).join(', ')} and ${rows[rows.length - 1]}`;
}

/** The human label for a GEO_CATEGORIES key. (generate.py `_s3_geo_label`) */
function geoLabel(category) {
  for (const c of GEO_CATEGORIES) if (c.key === category) return c.label;
  return String(category).split('_').join(' ');
}

// English plurals the naive "+ s" rule gets wrong, for the labels printed here.
const S3_PLURAL = Object.freeze({
  library: 'libraries',
  water: 'bodies of water',
  high_speed_rail: 'high-speed rail lines',
  commercial_airport: 'commercial airports',
  foreign_consulate: 'foreign consulates',
  rail_station: 'rail stations',
});

/** The lower-case noun for a category, singular or plural to match `count`. */
function s3Noun(category, count) {
  const key = category || '';
  const singular = geoLabel(key).toLowerCase();
  if (count === 1) return singular;
  return Object.prototype.hasOwnProperty.call(S3_PLURAL, key) ? S3_PLURAL[key] : `${singular}s`;
}

/**
 * The exact Overpass selector behind a question, or a plain-words GTFS note.
 * Every kind `subjectOf` returns is answered here; the photo tables partition all
 * 18 photo ids (6 always-answerable, 7 counted, 2 polygon, 3 named below).
 * (generate.py `_s3_selector_for`)
 */
function selectorFor(question) {
  const [kind, arg] = subjectOf(question);
  if (kind === 'osm_nearest' || kind === 'osm_distance' || kind === 'osm_tentacle'
      || kind === 'landmass' || kind === 'street') {
    const cat = question.geodataRef;
    for (const c of GEO_CATEGORIES) {
      if (c.key === cat) return c.selector.split('{{bbox}}').join('BBOX');
    }
    return `OpenStreetMap category \`${cat}\` (not queried on this run)`;
  }
  if (kind === 'gtfs_transit_line') {
    return 'GTFS: the set of routes serving any stop inside the zone circle';
  }
  if (kind === 'gtfs_name_length') return 'GTFS: character count of the clustered station name';
  if (kind === 'gtfs_metro_line') {
    return 'GTFS: routes whose route_type is one of 0, 1, 2, 5, 7, 11, 12 (rail-like)';
  }
  if (kind === 'admin') {
    return `relation["boundary"="administrative"] containing each zone centre, ${arg} ordinal`;
  }
  if (kind === 'border_line') {
    return 'relation["boundary"="administrative"]["admin_level"=N](BBOX); way(r); out count; '
      + '— does a boundary line cross the map';
  }
  if (kind === 'dem') {
    return 'elevation — needs a digital elevation model, which this pipeline does not carry';
  }
  if (kind === 'geom') return 'geometry only: straight-line distance between station icons';
  if (kind === 'photo') {
    let cat = Object.prototype.hasOwnProperty.call(S3_PHOTO_COUNT, question.id)
      ? S3_PHOTO_COUNT[question.id]
      : (Object.prototype.hasOwnProperty.call(S3_PHOTO_POLYGON, question.id)
        ? S3_PHOTO_POLYGON[question.id] : '');
    if (Array.isArray(cat)) [cat] = cat;
    if (S3_ALWAYS_PHOTOS.includes(question.id)) {
      return 'no data needed: answerable from anywhere';
    }
    if (cat) {
      for (const c of GEO_CATEGORIES) {
        if (c.key === cat) return c.selector.split('{{bbox}}').join('BBOX');
      }
    }
    if (question.id === 'photo.tree') {
      return 'node["natural"="tree"](BBOX); nwr["landuse"~"^(forest|grass|meadow)$"](BBOX);';
    }
    if (question.id === 'photo.train_platform') {
      return 'nwr["railway"="platform"](BBOX); nwr["public_transport"="platform"](BBOX);';
    }
    if (question.id === 'photo.tallest_mountain_visible_from_transit_station') {
      return 'node["natural"~"^(peak|volcano)$"]["name"](BBOX);';
    }
  }
}

/**
 * `[kind, argument]` naming the data that answers this question. The six
 * categories are closed (catalogue.js asserts their counts), so every question
 * resolves to a kind.
 * (generate.py `_s3_subject`)
 */
function subjectOf(question) {
  const special = Object.prototype.hasOwnProperty.call(S3_SPECIAL_SUBJECT, question.id)
    ? S3_SPECIAL_SUBJECT[question.id] : null;
  if (special !== null) return special;
  if (question.category === 'photo') return ['photo', question.id];
  if (question.category === 'radar' || question.category === 'thermometer') return ['geom', null];
  if (question.category === 'matching') return ['osm_nearest', question.geodataRef];
  if (question.category === 'measuring') return ['osm_distance', question.geodataRef];
  if (question.category === 'tentacle') return ['osm_tentacle', question.geodataRef];
}

/**
 * `[features whose icon is inside the border, was this category queried]`.
 * The in-border test is on the representative point, not the raw Overpass
 * result: a polygon straddling the edge can have its icon outside the map.
 * (generate.py `_s3_in_border_pois`)
 */
function inBorderPois(geo, category, bbox) {
  if (!geo.available || !category) return [[], false];
  const pois = geo.pois[category];
  if (pois === undefined || pois === null) return [[], false];
  return [pois.filter((p) => bboxContains(bbox, p.lat, p.lon)), true];
}

/**
 * How many features of a category sit inside a modestly larger border: two zone
 * radii or 250 m, whichever is larger.
 * (generate.py `_s3_margin_count`)
 */
function marginCount(geo, category, bbox, radiusM) {
  if (!geo.available || !category) return 0;
  const pois = geo.pois[category];
  if (pois === undefined || pois === null) return 0;
  const margin = Math.max(2.0 * radiusM, 250.0);
  const big = bboxExpand(bbox, margin);
  let total = 0;
  for (const p of pois) if (bboxContains(big, p.lat, p.lon)) total++;
  return total;
}

/**
 * Total order over heterogeneous signature values, and their hash key: a type
 * tag then the value, strings JSON-quoted so no separator can be forged. Its
 * order differs from Python's `repr` order, which only affects float summation
 * order, never a published class or count.
 * (generate.py `_s3_sort_key`)
 */
function sigKey(v) {
  if (v === null || v === undefined) return 'null';
  const t = typeof v;
  if (t === 'number') return `n:${v}`;
  if (t === 'boolean') return v ? 'b:1' : 'b:0';
  if (t === 'string') return `s:${JSON.stringify(v)}`;
  if (Array.isArray(v)) return `a:[${v.map(sigKey).join(',')}]`;
  return `x:${JSON.stringify(v)}`;
}

/**
 * Signature value → number of zones carrying it, keyed by `sigKey`.
 * Sorted-stable by construction. (generate.py `_s3_blocks`)
 * @returns {Map<string, number>}
 */
function s3Blocks(values) {
  /** @type {Map<string, number>} */
  const counter = new Map();
  for (const v of values) {
    const k = sigKey(v);
    counter.set(k, (counter.get(k) || 0) + 1);
  }
  return counter;
}

/** Quality of a yes/no question: a 50/50 split scores 1.0, a constant answer 0.0. */
function binaryQuality(pYes) {
  const p = Math.min(1.0, Math.max(0.0, pYes));
  return Math.min(p, 1.0 - p) / 0.5;
}

/** Quality of a multi-class answer: Shannon entropy over `log2(realised classes)`. */
function entropyQuality(blocks, n) {
  const live = Array.from(blocks).filter((b) => b > 0);
  if (live.length < 2 || n <= 0) return 0.0;
  let h = 0.0;
  for (const b of live) {
    const p = b / n;
    h -= p * Math.log2(p);
  }
  return Math.min(1.0, h / Math.log2(live.length));
}

// ── bisect, on ascending numeric arrays ───────────────────────────────────────

function bisectLeft(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function bisectRight(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (x < arr[mid]) hi = mid; else lo = mid + 1;
  }
  return lo;
}

// ═══════════════════════════════════════════════════════════════════════════════
// S3 · ANSWER SIGNATURES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Distance from each zone to the nearest zone with a different label, by x-sweep.
 * The proxy behind the administrative-border measuring questions; an upper bound
 * on the true distance to the boundary line.
 * (generate.py `_s3_nearest_other_label_m`)
 */
function nearestOtherLabelM(zones, labels) {
  const n = zones.length;
  const inf = Infinity;
  if (n < 2) return new Array(n).fill(inf);
  const order = [];
  for (let i = 0; i < n; i++) order.push(i);
  order.sort((a, b) => (zones[a].x - zones[b].x)
    || (zones[a].y - zones[b].y)
    || cmpStr(zones[a].zoneId, zones[b].zoneId));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let p = 0; p < n; p++) { xs[p] = zones[order[p]].x; ys[p] = zones[order[p]].y; }
  const best = new Array(n).fill(inf);
  for (let pos = 0; pos < n; pos++) {
    const i = order[pos];
    const mine = labels[i];
    let b = inf;
    for (const step of [1, -1]) {
      let j = pos + step;
      while (j >= 0 && j < n) {
        if (Math.abs(xs[j] - xs[pos]) >= b) break;
        if (labels[order[j]] !== mine) {
          const d = Math.hypot(xs[j] - xs[pos], ys[j] - ys[pos]);
          if (d < b) b = d;
        }
        j += step;
      }
    }
    best[i] = b;
  }
  return best;
}

/**
 * The candidate set a tentacle question names, as `{label, xs, ys}` records. A
 * point feature carries one point; a metro line carries the positions of the
 * zones its route serves, capped at 64 by a fixed stride.
 * (generate.py `_s3_tentacle_features`)
 */
function tentacleFeatures(question, zones, geo, gtfsFacts, proj) {
  const [kind] = subjectOf(question);
  if (kind === 'gtfs_metro_line') {
    const rail = new Set(gtfsFacts.metro_route_ids || []);
    /** @type {Map<string, Array<[number, number]>>} */
    const byRoute = new Map();
    for (const z of zones) {
      for (const rid of z.routeIds) {
        if (rail.has(rid)) {
          let bucket = byRoute.get(rid);
          if (bucket === undefined) { bucket = []; byRoute.set(rid, bucket); }
          bucket.push([z.x, z.y]);
        }
      }
    }
    const routes = gtfsFacts.routes || {};
    const out = [];
    for (const rid of Array.from(byRoute.keys()).sort(cmpStr)) {
      const pts = byRoute.get(rid);
      const stride = Math.max(1, Math.ceil(pts.length / 64));
      const row = routes[rid];
      const label = (row && row.label) ? row.label : rid;
      const kept = [];
      for (let i = 0; i < pts.length; i += stride) kept.push(pts[i]);
      out.push(makeFeature(String(label), kept));
    }
    return out;
  }
  const [pois] = inBorderPois(geo, question.geodataRef, geo.bbox);
  return pois.map((p) => makeFeature(p.name || geoLabel(question.geodataRef || ''),
    [proj.xy(p.lat, p.lon)]));
}

/** One tentacle candidate: a label plus its projected points, in typed arrays. */
function makeFeature(label, pts) {
  const xs = new Float64Array(pts.length);
  const ys = new Float64Array(pts.length);
  for (let i = 0; i < pts.length; i++) { xs[i] = pts[i][0]; ys[i] = pts[i][1]; }
  return { label, xs, ys };
}

/** Squared distance from `(x, y)` to the nearest point of a feature. */
function featureMinSq(f, x, y) {
  let best = Infinity;
  const { xs, ys } = f;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - x;
    const dy = ys[i] - y;
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return best;
}

/** Is any point of `f` within `reach` of `(x, y)`? */
function featureWithinSq(f, x, y, reachSq) {
  const { xs, ys } = f;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - x;
    const dy = ys[i] - y;
    if (dx * dx + dy * dy <= reachSq) return true;
  }
  return false;
}

/**
 * Can the hider in this zone answer this photo question? `null` = not evaluable.
 * The tables and the three ids at the end partition all 18 photo questions.
 * (generate.py `_s3_photo_answer`)
 */
function photoAnswer(questionId, zone, geo, gtfsFacts) {
  if (S3_ALWAYS_PHOTOS.includes(questionId)) return true;
  if (!geo.available) return null;
  const inv = geo.zoneInventory[zone.zoneId] || {};
  const hits = geo.zonePolygonHits[zone.zoneId] || {};

  const countRule = Object.prototype.hasOwnProperty.call(S3_PHOTO_COUNT, questionId)
    ? S3_PHOTO_COUNT[questionId] : null;
  if (countRule !== null) {
    const [category, minimum] = countRule;
    if (!Object.prototype.hasOwnProperty.call(inv, category)) return null;
    return inv[category] >= minimum;
  }

  const polygonRule = Object.prototype.hasOwnProperty.call(S3_PHOTO_POLYGON, questionId)
    ? S3_PHOTO_POLYGON[questionId] : null;
  if (polygonRule !== null) {
    if (!Object.prototype.hasOwnProperty.call(hits, polygonRule)) return null;
    return Boolean(hits[polygonRule]);
  }

  if (questionId === 'photo.tree') {
    if (!Object.prototype.hasOwnProperty.call(inv, 'tree')
        && !Object.prototype.hasOwnProperty.call(inv, 'green')
        && !Object.prototype.hasOwnProperty.call(hits, 'park')) return null;
    return Boolean((inv.tree || 0) || (inv.green || 0) || hits.park);
  }
  if (questionId === 'photo.train_platform') {
    // OSM tags bus stops public_transport=platform too, so gate on the feed's
    // route types: no rail mode, no train platform.
    if (!gtfsFacts.has_rail) return false;
    if (!Object.prototype.hasOwnProperty.call(inv, 'platform')) return null;
    return inv.platform >= 1;
  }
  if (questionId === 'photo.tallest_mountain_visible_from_transit_station') {
    if (!Object.prototype.hasOwnProperty.call(geo.counts, 'mountain')) return null;
    return (geo.counts.mountain || 0) > 0;
  }
}

/**
 * The per-zone answer signature for one question, in `zones` order. Photo
 * questions return the answer itself; seeker-dependent ones return the invariant
 * the answer is computed from (nearest-feature class, distance to nearest
 * instance, projected position, position plus candidate set) so
 * `survivalFractions` can use closed forms. `null` means the zone cannot answer.
 * Memoised on the zone universe.
 * (generate.py `answer_signature`)
 *
 * @param {Object} question   QuestionDef
 * @param {Array<Object>} zones
 * @param {Object} geo        GeoData
 * @param {Object} gtfsFacts  snake_case bundle from `gtfsQuestionFacts`
 * @param {Projection} proj
 * @returns {Array<*>}
 */
export function answerSignature(question, zones, geo, gtfsFacts, proj) {
  const key = `sig\u0000${question.id}\u0000${universeKey(zones)}`;
  const hit = S3_MEMO.get(key);
  if (hit !== undefined) return hit;
  const sig = buildSignature(question, zones, geo, gtfsFacts, proj);
  S3_MEMO.set(key, sig);
  return sig;
}

/** (generate.py `_s3_build_signature`) */
function buildSignature(question, zones, geo, gtfsFacts, proj) {
  const n = zones.length;
  const [kind, arg] = subjectOf(question);

  if (kind === 'geom') return zones.map((z) => [z.x, z.y]);

  if (kind === 'osm_tentacle' || kind === 'gtfs_metro_line') {
    const feats = tentacleFeatures(question, zones, geo, gtfsFacts, proj);
    return zones.map((z) => [z.x, z.y, feats]);
  }

  if (kind === 'photo') return zones.map((z) => photoAnswer(question.id, z, geo, gtfsFacts));

  if (kind === 'gtfs_transit_line') {
    const byZone = gtfsFacts.routes_by_zone || {};
    return zones.map((z) => {
      const raw = byZone[z.zoneId] || z.routeIds;
      const rows = Array.from(raw).sort(cmpStr);
      return rows.length ? rows : null;      // Python's `tuple(...) or None`
    });
  }

  if (kind === 'gtfs_name_length') {
    const lengths = gtfsFacts.station_name_lengths || {};
    return zones.map((z) => (Object.prototype.hasOwnProperty.call(lengths, z.zoneId)
      ? lengths[z.zoneId] : z.name.length));
  }

  if (kind === 'street') {
    // Streets are counted map-wide but not downloaded, so one class per zone.
    return zones.map((z) => ['street', z.zoneId]);
  }

  if (kind === 'landmass') {
    const [pois, queried] = inBorderPois(geo, 'coastline', geo.bbox);
    if (!queried) return new Array(n).fill(null);
    // No coastline inside the border ⇒ the whole map is one landmass.
    if (!pois.length) return new Array(n).fill('landmass:1');
    return new Array(n).fill(null);          // assembling real landmasses is out of scope
  }

  if (kind === 'admin') {
    const perZone = geo.admin.perZone || {};
    const ord = geo.admin.ordinals || {};
    if (ord[arg] === undefined || ord[arg] === null) return new Array(n).fill(null);
    return zones.map((z) => {
      const row = perZone[z.zoneId] || {};
      const v = row[arg];
      return v === undefined ? null : v;
    });
  }

  if (kind === 'border_line') {
    const levels = geo.admin.borderLevels || {};
    if (!levels[arg]) return new Array(n).fill(null);
    const ordinal = arg === 0 ? 1 : arg;
    const perZone = geo.admin.perZone || {};
    const labels = zones.map((z) => {
      const row = perZone[z.zoneId] || {};
      const v = row[ordinal];
      return v === undefined ? null : v;
    });
    const distinct = new Set();
    for (const lab of labels) if (lab) distinct.add(lab);
    // the line crosses the map, but no zone is on the far side
    if (distinct.size < 2) return new Array(n).fill(null);
    const dists = nearestOtherLabelM(zones, labels);
    return dists.map((d) => (Number.isFinite(d) ? rhu(d / 2.0, 1) : null));
  }

  if (kind === 'dem') return new Array(n).fill(null);

  if (kind === 'osm_nearest') {
    const [pois, queried] = inBorderPois(geo, question.geodataRef, geo.bbox);
    if (!queried || !pois.length) return new Array(n).fill(null);
    const px = new Float64Array(pois.length);
    const py = new Float64Array(pois.length);
    for (let i = 0; i < pois.length; i++) {
      const p = proj.xy(pois[i].lat, pois[i].lon);
      px[i] = p[0];
      py[i] = p[1];
    }
    const out = new Array(n);
    for (let zi = 0; zi < n; zi++) {
      const zx = zones[zi].x;
      const zy = zones[zi].y;
      let bestI = 0;
      let bestD = Infinity;
      for (let i = 0; i < px.length; i++) {
        const dx = zx - px[i];
        const dy = zy - py[i];
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; bestI = i; }
      }
      out[zi] = bestI;
    }
    return out;
  }

  if (kind === 'osm_distance') {
    const [pois, queried] = inBorderPois(geo, question.geodataRef, geo.bbox);
    if (!queried || !pois.length) return new Array(n).fill(null);
    const px = new Float64Array(pois.length);
    const py = new Float64Array(pois.length);
    for (let i = 0; i < pois.length; i++) {
      const p = proj.xy(pois[i].lat, pois[i].lon);
      px[i] = p[0];
      py[i] = p[1];
    }
    const out = new Array(n);
    for (let zi = 0; zi < n; zi++) {
      const zx = zones[zi].x;
      const zy = zones[zi].y;
      let bestD = Infinity;
      for (let i = 0; i < px.length; i++) {
        const dx = zx - px[i];
        const dy = zy - py[i];
        const d = dx * dx + dy * dy;
        if (d < bestD) bestD = d;
      }
      out[zi] = rhu(Math.sqrt(bestD), 1);
    }
    return out;
  }

  return new Array(n).fill(null);
}

// ═══════════════════════════════════════════════════════════════════════════════
// S3 · SURVIVAL — one definition, six closed forms
// ═══════════════════════════════════════════════════════════════════════════════

/** The radar radius, in metres. `radar.choose` resolves to this map's own median. */
function radiusM(question, zones) {
  if (question.param === null || question.param === undefined) return chooseRadiusM(zones);
  return question.param * M_PER_MILE;
}

/**
 * `surv(q, z)` for every zone: the hider's anonymity under one question.
 *
 *     surv(q, z) = (1/|S|) · Σ_s |{z' : a_q(z', s) == a_q(z, s)}| / n
 *
 * 1 means the question never separates you from anyone; 1/n identifies you
 * outright. One definition, six closed forms, none pairwise:
 *
 *   * matching    — nearest-feature class sizes and the seeker distribution over them.
 *   * measuring   — prefix sums over distance ranks; an exact tie is its own class.
 *   * radar       — `(1/|S|) Σ_s [k_s if within else n − k_s] / n`.
 *   * thermometer — the perpendicular bisector of the seeker's leg over eight
 *     fixed bearings (an interpretation).
 *   * tentacle    — `(in_reach, nearest candidate)`, both reach tests on the seeker.
 *   * photo       — seeker-independent: `surv = block_size / n`.
 *
 * (generate.py `survival_fractions`)
 * @param {Object} question @param {Array<*>} signature
 * @param {Array<Object>} zones @param {number[]} seekers
 * @returns {number[]}
 */
export function survivalFractions(question, signature, zones, seekers) {
  const n = zones.length;
  if (n === 0) return [];
  if (!seekers.length) return new Array(n).fill(1.0);
  const cat = question.category;
  if (cat === 'matching') return survMatching(signature, n, seekers);
  if (cat === 'measuring') return survMeasuring(signature, n, seekers);
  if (cat === 'radar') return survRadar(question, zones, n, seekers);
  if (cat === 'thermometer') return survThermometer(question, zones, n, seekers);
  if (cat === 'tentacle') return survTentacle(question, signature, zones, n, seekers);
  if (cat === 'photo') {
    const blocks = s3Blocks(signature);
    return signature.map((v) => blocks.get(sigKey(v)) / n);
  }
}

/**
 * Closed form for a same-or-different question over equality classes. With class
 * sizes `c_j` and seeker counts `s_j`:
 * `surv_i = [T + s_i·(2c_i − n)] / (|S|·n)`, `T = Σ_j s_j·(n − c_j)`.
 * (generate.py `_s3_surv_matching`)
 */
function survMatching(signature, n, seekers) {
  const blocks = s3Blocks(signature);
  /** @type {Map<string, number>} */
  const seekerCounts = new Map();
  for (const s of seekers) {
    const k = sigKey(signature[s]);
    seekerCounts.set(k, (seekerCounts.get(k) || 0) + 1);
  }
  const totalSeekers = seekers.length;
  let T = 0.0;
  for (const k of Array.from(seekerCounts.keys()).sort(cmpStr)) {
    T += seekerCounts.get(k) * (n - (blocks.get(k) || 0));
  }
  const denom = totalSeekers * n;
  return signature.map((v) => {
    const k = sigKey(v);
    const c = blocks.get(k) || 0;
    const si = seekerCounts.get(k) || 0;
    return (T + si * (2 * c - n)) / denom;
  });
}

/**
 * Prefix sums over distance ranks. Three answer classes: a zone at exactly the
 * seeker's distance is its own class (`measuring_ties_are_their_own_answer`),
 * which keeps this in step with the concrete answers the dossiers print.
 * Verified against an O(n²·|S|) brute force.
 * (generate.py `_s3_surv_measuring`)
 */
function survMeasuring(signature, n, seekers) {
  const values = signature.filter((v) => v !== null && v !== undefined);
  if (values.length < n) return new Array(n).fill(1.0);   // some zone cannot answer at all
  const ordered = Float64Array.from(values).sort();
  const seekerValues = seekers.map((s) => signature[s]).sort((a, b) => a - b);
  /** @type {Map<number, number>} */
  const counts = new Map();
  const distinct = [];
  for (const v of seekerValues) {
    if (!counts.has(v)) distinct.push(v);
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  distinct.sort((a, b) => a - b);

  const lowerTerms = [];   // seeker distance < hider's ⇒ hider is further
  const upperTerms = [];   // seeker distance > hider's ⇒ hider is closer
  const tieTerms = [];
  for (const v of distinct) {
    const left = bisectLeft(ordered, v);
    const right = bisectRight(ordered, v);
    const equal = right - left;
    const greater = n - right;
    lowerTerms.push(counts.get(v) * greater);   // seeker nearer ⇒ hider answers "further"
    upperTerms.push(counts.get(v) * left);      // seeker further ⇒ hider answers "closer"
    tieTerms.push(counts.get(v) * equal);       // exactly level ⇒ neither
  }

  const prefixLower = [0.0];
  for (const t of lowerTerms) prefixLower.push(prefixLower[prefixLower.length - 1] + t);
  const suffixUpper = new Array(distinct.length + 1).fill(0.0);
  for (let i = distinct.length - 1; i >= 0; i--) suffixUpper[i] = suffixUpper[i + 1] + upperTerms[i];

  const denom = seekers.length * n;
  return signature.map((v) => {
    const pos = bisectLeft(distinct, v);
    const exact = pos < distinct.length && distinct[pos] === v;
    let agree = prefixLower[pos] + suffixUpper[exact ? pos + 1 : pos];
    if (exact) agree += tieTerms[pos];
    return agree / denom;
  });
}

/** `k_s` zones inside the seeker's disc, `n − k_s` outside; average over seekers. */
function survRadar(question, zones, n, seekers) {
  const radius = radiusM(question, zones);
  const { m, d } = zoneSeekerDists(zones, seekers);
  const inside = new Uint8Array(n * m);
  const k = new Int32Array(m);
  for (let i = 0; i < n; i++) {
    const base = i * m;
    for (let j = 0; j < m; j++) {
      if (d[base + j] <= radius) { inside[base + j] = 1; k[j]++; }
    }
  }
  const denom = m * n;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const base = i * m;
    let agree = 0;
    for (let j = 0; j < m; j++) agree += inside[base + j] ? k[j] : n - k[j];
    out[i] = agree / denom;
  }
  return out;
}

/**
 * Perpendicular-bisector half-planes, eight bearings, one sort per bearing.
 * "Hotter" is `z·u < s·u + L/2` for unit travel vector `u`, so projecting every
 * zone onto `u` turns the question into a prefix sum.
 * (generate.py `_s3_surv_thermometer`)
 */
function survThermometer(question, zones, n, seekers) {
  const leg = (question.param || 0.0) * M_PER_MILE;
  if (leg <= 0) return new Array(n).fill(1.0);
  const totals = new Float64Array(n);
  let trials = 0;
  for (const [ux, uy] of S3_BEARINGS) {
    const projZ = new Float64Array(n);
    for (let i = 0; i < n; i++) projZ[i] = zones[i].x * ux + zones[i].y * uy;
    const ordered = Float64Array.from(projZ).sort();
    const pairs = seekers.map((s) => {
      const thresh = zones[s].x * ux + zones[s].y * uy + leg / 2.0;
      return [thresh, bisectLeft(ordered, thresh)];
    });
    pairs.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const thresholds = Float64Array.from(pairs, (p) => p[0]);
    const prefixK = new Float64Array(pairs.length + 1);
    for (let i = 0; i < pairs.length; i++) prefixK[i + 1] = prefixK[i] + pairs[i][1];
    const totalK = prefixK[pairs.length];
    const m = pairs.length;
    trials += m;
    for (let i = 0; i < n; i++) {
      const pos = bisectRight(thresholds, projZ[i]);
      const hotterSide = totalK - prefixK[pos];        // thresholds above p ⇒ hider hotter
      const colderSide = pos * n - prefixK[pos];       // thresholds at or below p
      totals[i] += hotterSide + colderSide;
    }
  }
  const denom = trials * n;
  return Array.from(totals, (t) => t / denom);
}

/** Flatten in-reach features into parallel typed arrays plus an owner index. */
function flattenFeatures(feats) {
  let total = 0;
  for (const f of feats) total += f.xs.length;
  const xs = new Float64Array(total);
  const ys = new Float64Array(total);
  const owner = new Int32Array(total);
  let w = 0;
  for (let fi = 0; fi < feats.length; fi++) {
    const f = feats[fi];
    for (let i = 0; i < f.xs.length; i++) {
      xs[w] = f.xs[i];
      ys[w] = f.ys[i];
      owner[w] = fi;
      w++;
    }
  }
  return { xs, ys, owner };
}

/** Both reach tests anchored on the seeker, then nearest candidate among those in reach. */
function survTentacle(question, signature, zones, n, seekers) {
  const reach = (question.param || 0.0) * M_PER_MILE;
  const feats = (signature.length && Array.isArray(signature[0]) && signature[0].length === 3)
    ? signature[0][2] : [];
  if (reach <= 0 || !feats.length) return new Array(n).fill(1.0);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) { xs[i] = zones[i].x; ys[i] = zones[i].y; }
  const totals = new Float64Array(n);
  const reachSq = reach * reach;
  const classes = new Int32Array(n);
  for (const s of seekers) {
    const sx = zones[s].x;
    const sy = zones[s].y;
    const inReach = feats.filter((f) => featureWithinSq(f, sx, sy, reachSq));
    const flat = flattenFeatures(inReach);
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - sx;
      const dy = ys[i] - sy;
      if (dx * dx + dy * dy > reachSq) {
        classes[i] = -1;                       // "not within reach"
      } else if (!inReach.length) {
        classes[i] = -2;                       // nothing to be nearest to
      } else {
        let bestI = 0;
        let bestD = Infinity;
        for (let p = 0; p < flat.xs.length; p++) {
          const ex = flat.xs[p] - xs[i];
          const ey = flat.ys[p] - ys[i];
          const d = ex * ex + ey * ey;
          if (d < bestD) { bestD = d; bestI = flat.owner[p]; }
        }
        classes[i] = bestI;
      }
    }
    /** @type {Map<number, number>} */
    const sizes = new Map();
    for (let i = 0; i < n; i++) sizes.set(classes[i], (sizes.get(classes[i]) || 0) + 1);
    for (let i = 0; i < n; i++) totals[i] += sizes.get(classes[i]);
  }
  const denom = seekers.length * n;
  return Array.from(totals, (t) => t / denom);
}

// ═══════════════════════════════════════════════════════════════════════════════
// S3 · CONCRETE ANSWERS — what a zone actually says, for the funnel and the threats
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * `[class key, human wording]` of the answer zone `hider` gives seeker `seeker`.
 * (generate.py `_s3_answer`)
 * @param {Object} question @param {Array<*>} signature @param {Array<Object>} zones
 * @param {number} hider @param {number} seeker
 * @returns {[*, string]}
 */
export function s3Answer(question, signature, zones, hider, seeker) {
  const cat = question.category;
  const a = signature[hider];
  const b = signature[seeker];
  if (cat === 'matching') {
    if (a === null || a === undefined) return ['null', 'null — no such thing on this map'];
    return sigKey(a) === sigKey(b) ? ['yes', 'yes'] : ['no', 'no'];
  }
  if (cat === 'measuring') {
    if (a === null || a === undefined || b === null || b === undefined) {
      return ['null', 'null — no such thing on this map'];
    }
    if (a < b) return ['closer', 'closer'];
    if (a > b) return ['further', 'further'];
    return ['same', 'the same distance'];
  }
  if (cat === 'radar') {
    const radius = radiusM(question, zones);
    const d = Math.hypot(zones[hider].x - zones[seeker].x, zones[hider].y - zones[seeker].y);
    return d <= radius ? ['yes', 'yes'] : ['no', 'no'];
  }
  if (cat === 'thermometer') {
    const [ux, uy] = S3_BEARINGS[0];
    const leg = (question.param || 0.0) * M_PER_MILE;
    const thresh = zones[seeker].x * ux + zones[seeker].y * uy + leg / 2.0;
    const p = zones[hider].x * ux + zones[hider].y * uy;
    return p < thresh ? ['hotter', 'hotter'] : ['colder', 'colder'];
  }
  if (cat === 'photo') {
    if (a === null || a === undefined) return ['unknown', 'not evaluated'];
    return a ? ['photo', 'a photo'] : ['cannot', '“I cannot answer the question”'];
  }
  if (cat === 'tentacle') {
    const reach = (question.param || 0.0) * M_PER_MILE;
    const feats = (Array.isArray(a) && a.length === 3) ? a[2] : [];
    const sx = zones[seeker].x;
    const sy = zones[seeker].y;
    const hx = zones[hider].x;
    const hy = zones[hider].y;
    if (Math.hypot(hx - sx, hy - sy) > reach) return ['far', 'not within reach'];
    let bestLabel = null;
    let bestD = Infinity;
    for (const f of feats) {
      if (!featureWithinSq(f, sx, sy, reach * reach)) continue;
      const d = Math.sqrt(featureMinSq(f, hx, hy));
      if (d < bestD) { bestD = d; bestLabel = f.label; }
    }
    if (bestLabel === null) return ['none', 'nothing in reach to be nearest to'];
    return [['near', bestLabel], bestLabel];
  }
}

/**
 * The zone closest to the map's centre of mass — the funnel's standing seeker.
 * (generate.py `_s3_reference_seeker`)
 * @param {Array<Object>} zones
 * @returns {number}
 */
export function s3ReferenceSeeker(zones) {
  if (!zones.length) return 0;
  let cx = 0;
  let cy = 0;
  for (const z of zones) { cx += z.x; cy += z.y; }
  cx /= zones.length;
  cy /= zones.length;
  let bestI = 0;
  let best = Infinity;
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    const d = (z.x - cx) ** 2 + (z.y - cy) ** 2;
    if (d < best || (d === best && cmpStr(z.zoneId, zones[bestI].zoneId) < 0)) {
      best = d;
      bestI = i;
    }
  }
  return bestI;
}

/**
 * Renumber a partition: `[groupId, classKey]` pairs → dense group ids plus class
 * sizes. Same block sizes as the Python's growing tuples, without O(k) string
 * concatenation per zone per candidate.
 */
function refine(joint, classKeys, n) {
  /** @type {Map<string, number>} */
  const index = new Map();
  const next = new Int32Array(n);
  const sizes = [];
  for (let i = 0; i < n; i++) {
    const key = `${joint[i]}\u0000${classKeys[i]}`;
    let g = index.get(key);
    if (g === undefined) {
      g = sizes.length;
      index.set(key, g);
      sizes.push(0);
    }
    next[i] = g;
    sizes[g]++;
  }
  return { next, sizes };
}

/**
 * Greedily pick the k questions that break this map, and the resulting funnel.
 * Each step takes the question minimising the mean block size over `Z` once
 * appended to the picks, ties by `(cost, questionId)`. Answers are evaluated for
 * one standing seeker, the zone nearest the centre of mass, so the funnel names a
 * concrete sequence (`funnel_reference_seeker`).
 *
 * Returns `[questionIds, funnel]`: `funnel[0]` is `n`, `funnel[i]` the surviving
 * block size after the i-th question.
 * (generate.py `global_question_order`)
 *
 * @param {Array<Object>} questions   QuestionAudit rows
 * @param {Object<string, Array<*>>} signatures  questionId → signature
 * @param {Array<Object>} zones
 * @param {number} k
 * @param {{onProgress?: function(number, number, string): void}} [opts]
 * @returns {[string[], number[]]}
 */
export function globalQuestionOrder(questions, signatures, zones, k, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const n = zones.length;
  const memoKey = `order\u0000${universeKey(zones)}\u0000${k}\u0000`
    + `${Object.keys(signatures).sort(cmpStr).join(',')}\u0000`
    + `${questions.map((q) => q.id).sort(cmpStr).join(',')}`;
  const hit = S3_MEMO.get(memoKey);
  if (hit !== undefined) return [Array.from(hit[0]), Array.from(hit[1])];
  if (n === 0 || k <= 0) return [[], [n]];

  /** @type {Map<string, Object>} */
  const defs = new Map();
  for (const q of QUESTIONS) defs.set(q.id, q);
  const ref = s3ReferenceSeeker(zones);
  /** @type {Array<[string, string[], number]>} */
  const usable = [];
  for (const audit of Array.from(questions).sort((a, b) => cmpStr(a.id, b.id))) {
    if (audit.status !== 'functional' && audit.status !== 'weak') continue;
    const sig = Object.prototype.hasOwnProperty.call(signatures, audit.id)
      ? signatures[audit.id] : undefined;
    const q = defs.get(audit.id);
    if (sig === undefined || q === undefined) continue;
    const classKeys = new Array(n);
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      const key = sigKey(s3Answer(q, sig, zones, i, ref)[0]);
      classKeys[i] = key;
      seen.add(key);
    }
    if (seen.size < 2) continue;             // this question says the same thing everywhere
    usable.push([audit.id, classKeys, q.keep]);
  }

  const picked = [];
  const funnel = [n];
  let joint = new Int32Array(n);
  /** @type {Map<string, [string[], number]>} */
  const remaining = new Map();
  for (const [qid, classKeys, cost] of usable) remaining.set(qid, [classKeys, cost]);
  const steps = Math.min(k, remaining.size);
  for (let step = 0; step < steps; step++) {
    let best = null;                          // [meanBlock, cost, qid]
    let bestJoint = null;
    for (const qid of Array.from(remaining.keys()).sort(cmpStr)) {
      const [classKeys, cost] = remaining.get(qid);
      const { next, sizes } = refine(joint, classKeys, n);
      let sumSq = 0;
      for (const c of sizes) sumSq += c * c;
      const meanBlock = sumSq / n;
      const candidate = [meanBlock, cost, qid];
      if (best === null || cmpCandidate(candidate, best) < 0) {
        best = candidate;
        bestJoint = next;
      }
    }
    if (best === null || bestJoint === null) break;
    picked.push(best[2]);
    joint = bestJoint;
    funnel.push(Math.trunc(rhu(best[0])));
    remaining.delete(best[2]);
    if (onProgress) onProgress(step + 1, steps, `question order: ${best[2]}`);
  }

  S3_MEMO.set(memoKey, [picked, funnel]);
  return [Array.from(picked), Array.from(funnel)];
}

/** Python tuple comparison over `(meanBlock, cost, qid)`. */
function cmpCandidate(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return cmpStr(a[2], b[2]);
}

/**
 * Share of zones sharing each zone's joint signature over `questionIds`.
 * (generate.py `_s3_joint_block_share`)
 * @param {string[]} questionIds
 * @param {Object<string, Array<*>>} signatures
 * @param {Array<Object>} zones
 * @returns {number[]}
 */
export function s3JointBlockShare(questionIds, signatures, zones) {
  const n = zones.length;
  if (n === 0) return [];
  /** @type {Map<string, Object>} */
  const defs = new Map();
  for (const q of QUESTIONS) defs.set(q.id, q);
  const ref = s3ReferenceSeeker(zones);
  let joint = new Int32Array(n);
  let sizes = [n];
  for (const qid of questionIds) {
    const sig = Object.prototype.hasOwnProperty.call(signatures, qid) ? signatures[qid] : undefined;
    const q = defs.get(qid);
    if (sig === undefined || q === undefined) continue;
    const classKeys = new Array(n);
    for (let i = 0; i < n; i++) classKeys[i] = sigKey(s3Answer(q, sig, zones, i, ref)[0]);
    const refined = refine(joint, classKeys, n);
    joint = refined.next;
    sizes = refined.sizes;
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = sizes[joint[i]] / n;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// S3 · QUESTION VIABILITY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Quality in [0, 1], normalised per category (contract.md §5.1). Binary
 * categories score the balance of the yes/no split. Measuring always splits near
 * evenly, so it scores narrowing instead, renormalised so a clean halving is 1.0.
 * Tentacles score Shannon entropy over the classes they realise.
 * (generate.py `_s3_quality`)
 */
function s3Quality(question, signature, zones, seekers) {
  const n = zones.length;
  if (n === 0 || !seekers.length) return 0.0;
  const cat = question.category;

  if (cat === 'matching') {
    if (signature.some((v) => v === null || v === undefined)) return 0.0;
    const blocks = s3Blocks(signature);
    let pYes = 0.0;
    for (const s of seekers) pYes += (blocks.get(sigKey(signature[s])) || 0) / n;
    return binaryQuality(pYes / seekers.length);
  }

  if (cat === 'measuring') {
    // Mean survival across zones, renormalised so a perfect halving is 1.0.
    if (signature.some((v) => v === null || v === undefined)) return 0.0;
    const values = survivalFractions(question, signature, zones, seekers);
    const meanSurv = values.length ? sumSorted(values) / n : 1.0;
    return Math.min(1.0, Math.max(0.0, (1.0 - meanSurv) / 0.5));
  }

  if (cat === 'radar') {
    const radius = radiusM(question, zones);
    const { m, d } = zoneSeekerDists(zones, seekers);
    let inside = 0;
    for (let i = 0; i < d.length; i++) if (d[i] <= radius) inside++;
    return binaryQuality(inside / (m * n));
  }

  if (cat === 'thermometer') {
    const leg = (question.param || 0.0) * M_PER_MILE;
    if (leg <= 0) return 0.0;
    let hot = 0;
    let trials = 0;
    for (const [ux, uy] of S3_BEARINGS) {
      const projZ = new Float64Array(n);
      for (let i = 0; i < n; i++) projZ[i] = zones[i].x * ux + zones[i].y * uy;
      projZ.sort();
      for (const s of seekers) {
        const thresh = zones[s].x * ux + zones[s].y * uy + leg / 2.0;
        hot += bisectLeft(projZ, thresh);
        trials += n;
      }
    }
    return trials ? binaryQuality(hot / trials) : 0.0;
  }

  if (cat === 'photo') {
    const evaluated = signature.filter((v) => v !== null && v !== undefined);
    if (!evaluated.length) return 0.0;
    let yes = 0;
    for (const v of evaluated) if (v) yes++;
    return binaryQuality(yes / evaluated.length);
  }

  if (cat === 'tentacle') {
    const reach = (question.param || 0.0) * M_PER_MILE;
    const feats = (signature.length && Array.isArray(signature[0])) ? signature[0][2] : [];
    if (reach <= 0 || !feats || !feats.length) return 0.0;
    const scores = [];
    const reachSq = reach * reach;
    const classes = new Int32Array(n);
    for (const s of seekers) {
      const sx = zones[s].x;
      const sy = zones[s].y;
      const inReach = feats.filter((f) => featureWithinSq(f, sx, sy, reachSq));
      const flat = flattenFeatures(inReach);
      for (let i = 0; i < n; i++) {
        const zx = zones[i].x;
        const zy = zones[i].y;
        if ((zx - sx) ** 2 + (zy - sy) ** 2 > reachSq) {
          classes[i] = -1;
        } else if (!inReach.length) {
          classes[i] = -2;
        } else {
          let bestI = 0;
          let bestD = Infinity;
          for (let p = 0; p < flat.xs.length; p++) {
            const ex = flat.xs[p] - zx;
            const ey = flat.ys[p] - zy;
            const d = ex * ex + ey * ey;
            if (d < bestD) { bestD = d; bestI = flat.owner[p]; }
          }
          classes[i] = bestI;
        }
      }
      /** @type {Map<number, number>} */
      const counter = new Map();
      for (let i = 0; i < n; i++) counter.set(classes[i], (counter.get(classes[i]) || 0) + 1);
      const sizes = Array.from(counter.values()).sort((a, b) => a - b);
      scores.push(entropyQuality(sizes, n));
    }
    return scores.length ? sumSorted(scores) / scores.length : 0.0;
  }
}

/** `min` / `max` without a spread; the zone universe can be large. */
function minOf(values) {
  let m = Infinity;
  for (const v of values) if (v < m) m = v;
  return m;
}

function maxOf(values) {
  let m = -Infinity;
  for (const v of values) if (v > m) m = v;
  return m;
}

/** `sum(sorted(values))` — the Python's deterministic float summation order. */
function sumSorted(values) {
  const s = Array.from(values).sort((a, b) => a - b);
  let total = 0.0;
  for (const v of s) total += v;
  return total;
}

/**
 * `[number of classes, smallest class, largest class]` for a partition signature.
 * (generate.py `_s3_block_span`)
 */
function blockSpan(signature) {
  const blocks = s3Blocks(signature);
  const sizes = Array.from(blocks.values()).sort((a, b) => a - b);
  if (!sizes.length) return [0, 0, 0];
  return [sizes.length, sizes[0], sizes[sizes.length - 1]];
}

/**
 * Give every question in the catalogue a status and a quality score. The status
 * rule differs per category:
 *   * matching  — N=0 dead, N=1 degenerate (always "yes"), N≥2 functional.
 *   * measuring — N=0 dead, N≥1 functional; one instance still cuts a clean ring.
 *   * radar     — never dead as a category. Degenerate at or above the station-set
 *     diameter, weak below the zone radius.
 *   * thermometer — dead above the map diameter, degenerate above 0.7× it (interpretation).
 *   * photo     — coverage over Z; dead only at 0 map-wide.
 *   * tentacle  — N=0 dead, N=1 degenerate, N≥2 with median in-reach ≥2 functional.
 *
 * Nothing returns `unaskable`: no question is barred by the map alone, and no
 * consumer branches on it. Every count is measured inside the border on the
 * feature's own icon, and a status that would flip under a modestly larger
 * border is marked `borderline`.
 * (generate.py `audit_questions`)
 *
 * @param {Object} size @param {Object} geo @param {Object} gtfsFacts
 * @param {Array<Object>} zones @param {Object} metrics @param {Object} border
 * @param {{onProgress?: function(number, number, string): void}} [opts]
 * @returns {Array<Object>} QuestionAudit rows
 */
export function auditQuestions(size, geo, gtfsFacts, zones, metrics, border, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const n = zones.length;
  const proj = projFromZones(zones);
  const seekers = seekerSample(zones);
  const diameter = Number(metrics.diameterM || 0.0);
  const zoneRadius = Number(size.zoneRadiusM);
  const out = [];
  const catalogue = catalogueFor(size);

  for (let qi = 0; qi < catalogue.length; qi++) {
    const q = catalogue[qi];
    const [kind, arg] = subjectOf(q);
    const selector = selectorFor(q);
    const sig = answerSignature(q, zones, geo, gtfsFacts, proj);
    let quality = 0.0;
    /** @type {number|null} */ let instances = null;
    /** @type {number|null} */ let coverage = null;
    let borderline = false;
    let status = 'unknown';
    let why = 'Not evaluated.';

    // ── matching ──────────────────────────────────────────────────────────
    if (q.category === 'matching') {
      if (kind === 'osm_nearest') {
        const [pois, queried] = inBorderPois(geo, q.geodataRef, border.bbox);
        if (!queried) {
          status = 'unknown';
          why = notQueriedWhy(geo, s3Noun(q.geodataRef, 2));
        } else {
          instances = pois.length;
          const margin = marginCount(geo, q.geodataRef, border.bbox, zoneRadius);
          borderline = (instances === 0 && margin >= 1) || (instances === 1 && margin >= 2);
          if (instances === 0) {
            status = 'dead';
            why = `No ${s3Noun(q.geodataRef, 1)} inside the border. Out-of-border `
              + 'features do not exist for this game, so the answer is always null '
              + '— and a null still pays the hider a card.';
            if (margin) {
              why += ` ${num(margin)} sit just outside a border drawn `
                + `${num(Math.max(2 * zoneRadius, 250.0))} m wider, so this call is `
                + 'sensitive to where you draw the line.';
            }
          } else if (instances === 1) {
            status = 'degenerate';
            why = `One ${s3Noun(q.geodataRef, 1)} inside the border, so every `
              + "zone's nearest is the same one and the answer is always yes.";
          } else {
            quality = s3Quality(q, sig, zones, seekers);
            const [classes, smallest, largest] = blockSpan(sig);
            status = quality < 0.12 ? 'weak' : 'functional';
            why = `${num(instances)} ${s3Noun(q.geodataRef, instances)} inside the `
              + `border; ${num(classes)} of them are the nearest to at least one `
              + `zone, and those cells hold ${num(smallest)}–${num(largest)} zones `
              + 'each.';
            if (status === 'weak') {
              why += ' The cells are so fine that a random seeker almost never '
                + 'shares yours, so the answer is nearly always no — and a no '
                + "eliminates only that seeker's own cell.";
            }
          }
        }
      } else if (kind === 'gtfs_transit_line') {
        const routes = Number(metrics.routes || 0);
        instances = routes;
        const [classes] = blockSpan(sig);
        if (routes === 0) {
          status = 'dead';
          why = 'No routes serve this map.';
        } else if (routes === 1) {
          status = 'degenerate';
          why = "One route serves the whole map, so everyone's nearest transit line is it.";
        } else {
          // Scored like any matching question: the rulebook's only precondition is
          // timing (aboard and moving), and Curse of the Urban Explorer must be
          // drawn and played, so it is prose, not `unaskable`. Deliberate
          // divergence from generate.py, which hard-codes `unaskable` here.
          quality = s3Quality(q, sig, zones, seekers);
          status = quality < 0.12 ? 'weak' : 'functional';
          const sharp = quality >= 0.12
            ? 'cuts hard when it lands'
            : "almost always answers no, and a no eliminates only the seeker's own set";
          why = `${num(routes)} routes produce ${num(classes)} distinct route sets across `
            + `${num(n)} zones, so it ${sharp}. Asking it costs timing, not terrain: you `
            + 'must be aboard a vehicle and moving when the question goes out, which on '
            + `${num(routes)} routes is a matter of planning the ask. One caveat — if the `
            + 'hider draws Curse of the Urban Explorer, pays its cost and plays it, '
            + 'transit is closed to you for the rest of the run and this question goes '
            + 'with it.';
        }
      } else if (kind === 'gtfs_name_length') {
        const [classes, , largest] = blockSpan(sig);
        instances = classes;
        if (classes < 2) {
          status = 'degenerate';
          why = 'Every station name on this map is the same length.';
        } else {
          quality = s3Quality(q, sig, zones, seekers);
          status = quality < 0.12 ? 'weak' : 'functional';
          why = `${num(classes)} distinct station-name lengths across ${num(n)} zones, `
            + `the largest sharing ${num(largest)} zones.`;
        }
      } else if (kind === 'street') {
        const counted = geo.available
          ? (geo.counts.street === undefined ? null : geo.counts.street)
          : null;
        if (counted === null) {
          status = 'unknown';
          why = notQueriedWhy(geo, 'streets and paths');
        } else if (counted === 0) {
          status = 'dead';
          why = 'No mapped street or path inside the border.';
        } else {
          instances = counted;
          quality = s3Quality(q, sig, zones, seekers);
          status = quality < 0.12 ? 'weak' : 'functional';
          why = `${num(counted)} mapped street and path ways, effectively one nearest per `
            + 'zone, so the answer is almost always no — and a no eliminates exactly '
            + 'one zone. Live, but the weakest matching question on this map.';
        }
      } else if (kind === 'landmass') {
        const [pois, queried] = inBorderPois(geo, 'coastline', border.bbox);
        if (!queried) {
          status = 'unknown';
          why = notQueriedWhy(geo, 'coastline');
        } else if (!pois.length) {
          status = 'degenerate';
          instances = 1;
          why = 'No coastline inside the border, so the whole map is one landmass and '
            + 'the answer is always yes.';
        } else if (pois.every((p) => (p.tags || {}).derived)) {
          // Every shore was derived from a water body larger than the map, so
          // the water bounds the map rather than splitting it.
          status = 'degenerate';
          instances = 1;
          why = 'The only shore inside the border belongs to a water body larger than '
            + 'the map, so it bounds the map rather than splitting it: the land is '
            + 'one landmass and the answer is always yes.';
        } else {
          status = 'unknown';
          instances = pois.length;
          why = 'Coastline crosses the border, so the map spans more than one landmass; '
            + 'assembling landmasses from coastline ways is out of scope here.';
        }
      } else if (kind === 'admin') {
        ({ status, instances, quality, why } = adminMatching(q, arg, sig, geo, zones, seekers));
      }

    // ── measuring ─────────────────────────────────────────────────────────
    } else if (q.category === 'measuring') {
      if (kind === 'osm_distance') {
        const [pois, queried] = inBorderPois(geo, q.geodataRef, border.bbox);
        if (!queried) {
          status = 'unknown';
          why = notQueriedWhy(geo, s3Noun(q.geodataRef, 2));
        } else {
          instances = pois.length;
          const margin = marginCount(geo, q.geodataRef, border.bbox, zoneRadius);
          borderline = instances === 0 && margin >= 1;
          if (instances === 0) {
            status = 'dead';
            why = `No ${s3Noun(q.geodataRef, 1)} inside the border, so this always `
              + 'returns null — which costs the seekers a question and pays the '
              + 'hider a card.';
            if (margin) {
              why += ` ${num(margin)} sit just outside a border drawn `
                + `${num(Math.max(2 * zoneRadius, 250.0))} m wider, so the call is `
                + 'sensitive to where you draw the line.';
            }
          } else {
            quality = s3Quality(q, sig, zones, seekers);
            const values = sig.filter((v) => v !== null && v !== undefined);
            const lo = values.length ? minOf(values) : 0.0;
            const hi = values.length ? maxOf(values) : 0.0;
            status = quality < 0.30 ? 'weak' : 'functional';
            why = `${num(instances)} ${s3Noun(q.geodataRef, instances)} inside `
              + `the border; the zones sit ${miles(lo)}–${miles(hi)} from the `
              + 'nearest one, so the distance ring cuts the map cleanly.';
            if (instances === 1) {
              why += ' A single instance is not a weakness here: one clean ring is '
                + 'among the strongest measuring questions there is.';
            }
          }
        }
      } else if (kind === 'border_line') {
        ({ status, instances, quality, why } = borderMeasuring(q, arg, sig, geo, zones, seekers));
      } else if (kind === 'dem') {
        status = 'unknown';
        why = 'Elevation needs a digital elevation model this pipeline deliberately does '
          + 'not carry. On a map with real terrain this question probably works; it is '
          + 'reported as not evaluated rather than guessed.';
      }

    // ── radar ─────────────────────────────────────────────────────────────
    } else if (q.category === 'radar') {
      const radius = radiusM(q, zones);
      quality = s3Quality(q, sig, zones, seekers);
      const table = metrics.radarHitRate || {};
      const hit = table[radius] === undefined ? null : table[radius];
      if (diameter && radius >= diameter) {
        status = 'degenerate';
        why = `${miles(radius)} is wider than the map's ${miles(diameter)} diameter, so the `
          + 'answer is always yes.';
      } else if (radius < zoneRadius) {
        status = 'weak';
        why = `${miles(radius)} is smaller than the ${miles(zoneRadius)} hiding-zone `
          + 'radius, so the disc cannot even cover one zone. This is an endgame tool, '
          + 'not a search tool.';
      } else {
        status = quality < 0.25 ? 'weak' : 'functional';
        const share = hit;
        why = `A ${miles(radius)} disc covers `
          + `${share !== null ? pct(share) : 'part'} of the map's station pairs, `
          + 'so the yes and no branches are both worth buying.';
        if (q.param === null || q.param === undefined) {
          why = 'The seekers name the distance, so this radar can never be dead. On '
            + `this map the sharpest choice is about ${miles(radius)}, which splits `
            + 'the zone set closest to evenly.';
        }
        if (status === 'weak') {
          why += ' One branch is rare enough that the expected narrowing is small.';
        }
      }

    // ── thermometer ───────────────────────────────────────────────────────
    } else if (q.category === 'thermometer') {
      const leg = (q.param || 0.0) * M_PER_MILE;
      quality = s3Quality(q, sig, zones, seekers);
      if (diameter && leg > diameter) {
        status = 'dead';
        why = `A ${miles(leg)} leg is longer than the map's ${miles(diameter)} diameter: `
          + 'the seekers cannot travel it without leaving the map. Interpretation — '
          + 'the rulebook does not say what happens beyond the border.';
      } else if (diameter && leg > 0.70 * diameter) {
        status = 'degenerate';
        why = `A ${miles(leg)} leg is more than 0.7 of the map's ${miles(diameter)} `
          + 'diameter, so the seekers end up outside the zone set and the answer stops '
          + 'depending on where you are. Interpretation.';
      } else {
        status = quality < 0.20 ? 'weak' : 'functional';
        why = `A ${miles(leg)} leg splits the map through the perpendicular bisector of `
          + "the seekers' move; averaged over eight bearings it lands "
          + `${pct(quality / 2)} of the way to an even split.`;
      }

    // ── photo ─────────────────────────────────────────────────────────────
    } else if (q.category === 'photo') {
      const evaluated = sig.filter((v) => v !== null && v !== undefined);
      if (!evaluated.length) {
        status = 'unknown';
        why = notQueriedWhy(geo, 'the subject of this photo');
      } else {
        let yes = 0;
        for (const v of evaluated) if (v) yes++;
        coverage = yes / evaluated.length;
        quality = s3Quality(q, sig, zones, seekers);
        if (coverage <= 0.0) {
          status = 'dead';
          why = 'No zone on this map contains the subject, so every hider answers “I '
            + 'cannot answer the question” — which still pays them a card.';
        } else if (coverage >= 1.0) {
          status = 'degenerate';
          why = 'Every zone can answer this, so as a locational question it carries no '
            + 'information. The photograph itself may still show the seekers '
            + 'something — a landmark, a shadow, a skyline — that no model can score.';
        } else if (coverage < 0.15 || coverage > 0.85) {
          status = 'weak';
          why = `${pct(coverage)} of zones contain the subject, so one branch is rare. `
            + 'Note which branch: the rare answer is the informative one, and “I '
            + 'cannot answer” is a real answer that pays the hider.';
        } else {
          status = 'functional';
          why = `${pct(coverage)} of zones contain the subject, so both answers are `
            + 'worth buying.';
        }
        if (evaluated.length < n) {
          why += ` Evaluated for ${num(evaluated.length)} of ${num(n)} zones; the rest had `
            + 'no OpenStreetMap coverage for the subject.';
        }
        if (q.id === 'photo.train_platform' && !gtfsFacts.has_rail) {
          const railOsm = geo.counts.rail_station === undefined ? 0 : geo.counts.rail_station;
          why = 'Every route in this feed is a bus, so no zone has a train platform to '
            + 'photograph and every hider answers “I cannot answer the question” — '
            + 'which still pays them a card.';
          if (railOsm) {
            why += ` OpenStreetMap does show ${num(railOsm)} railway `
              + `station${railOsm === 1 ? '' : 's'} inside the border; agree `
              + 'in advance whether an intercity platform your transit map does '
              + 'not draw counts.';
          }
        }
      }

    // ── tentacle ──────────────────────────────────────────────────────────
    } else if (q.category === 'tentacle') {
      const feats = (sig.length && Array.isArray(sig[0]) && sig[0].length === 3) ? sig[0][2] : [];
      const reach = (q.param || 0.0) * M_PER_MILE;
      if (kind === 'gtfs_metro_line') {
        if (!gtfsFacts.has_rail) {
          status = 'dead';
          instances = 0;
          why = "Every route in this feed is a bus. The rulebook's metro lines are the "
            + 'coloured rail lines a map app draws, so this question has nothing to '
            + "name here — at the game's most expensive price, draw 4 keep 2.";
        } else if (!feats.length) {
          status = 'unknown';
          why = 'This feed has rail routes, but none of them reaches a candidate zone, '
            + 'so no line position could be derived.';
        } else {
          ({ status, instances, quality, why } = tentacleVerdict(
            q, sig, feats, zones, seekers, n, reach, 'metro line'));
        }
      } else {
        const [pois, queried] = inBorderPois(geo, q.geodataRef, border.bbox);
        const label = s3Noun(q.geodataRef, 2);
        if (!queried) {
          status = 'unknown';
          why = notQueriedWhy(geo, label);
        } else {
          instances = pois.length;
          const margin = marginCount(geo, q.geodataRef, border.bbox, zoneRadius);
          borderline = (instances === 0 && margin >= 1) || (instances === 1 && margin >= 2);
          if (instances === 0) {
            status = 'dead';
            why = `No ${s3Noun(q.geodataRef, 1)} inside the border, and this `
              + 'is the most expensive '
              + 'question in the game to ask: draw 4, keep 2, all of it paid to '
              + 'the hider for a null.';
          } else if (instances === 1) {
            status = 'degenerate';
            why = `One ${s3Noun(q.geodataRef, 1)} inside the border, so the `
              + 'question collapses into the intersection of two radars — for '
              + "twice a radar's price.";
          } else {
            ({ status, instances, quality, why } = tentacleVerdict(
              q, sig, feats, zones, seekers, n, reach, label));
          }
        }
      }
    }

    out.push({
      id: q.id,
      category: q.category,
      label: q.label,
      text: q.text,
      status,
      quality: rhu(Math.min(1.0, Math.max(0.0, quality)), 4),
      instances,
      coverage: coverage === null ? null : rhu(coverage, 4),
      selector,
      why,
      survMean: null,
      borderline,
      // Card price from the catalogue definition, so `#questions` carries real numbers.
      draw: q.draw,
      keep: q.keep,
    });
    if (onProgress) onProgress(qi + 1, catalogue.length, `question audit: ${q.label}`);
  }
  return out;
}

/**
 * The one sentence that explains an `unknown`, without pretending it is a zero.
 * (generate.py `_s3_not_queried_why`)
 */
function notQueriedWhy(geo, what) {
  if (!geo.available) {
    return `The OpenStreetMap layer was not available on this run, so ${what} could not be `
      + 'counted. Not evaluated — which is not the same as none.';
  }
  return `${what.slice(0, 1).toUpperCase()}${what.slice(1)} was not queried on this run, so this `
    + 'question is not evaluated. Not evaluated is not the same as none.';
}

/**
 * Status for one of the four administrative-division matching questions.
 * (generate.py `_s3_admin_matching`)
 */
function adminMatching(q, ordinal, sig, geo, zones, seekers) {
  const word = Object.prototype.hasOwnProperty.call(S3_ORDINAL_WORD, ordinal)
    ? S3_ORDINAL_WORD[ordinal] : String(ordinal);
  if (!geo.available || geo.admin.source === 'unknown') {
    return {
      status: 'unknown',
      instances: null,
      quality: 0.0,
      why: "The map's country could not be resolved, so no administrative level could be "
        + 'assigned to this ordinal. Administrative levels are never guessed.',
    };
  }
  const raw = (geo.admin.ordinals || {})[ordinal];
  const level = raw === undefined ? null : raw;
  if (level === null) {
    return {
      status: 'unknown',
      instances: null,
      quality: 0.0,
      why: `This country has no ${word} administrative division inside the map, so the `
        + 'question is not evaluated rather than counted as dead.',
    };
  }
  const names = Array.from(new Set(sig.filter((v) => v))).sort(cmpStr);
  if (!names.length) {
    return {
      status: 'unknown',
      instances: 0,
      quality: 0.0,
      why: `admin_level=${level} exists for this country but no zone centre resolved to one, `
        + `so the ${word} division could not be read.`,
    };
  }
  if (names.length === 1) {
    return {
      status: 'degenerate',
      instances: 1,
      quality: 0.0,
      why: `The whole map is inside ${names[0]}, so every zone's ${word} division is the same `
        + 'and the answer is always yes.',
    };
  }
  const quality = s3Quality(q, sig, zones, seekers);
  const [, smallest, largest] = blockSpan(sig);
  const listed = names.slice(0, 4).join(', ') + (names.length > 4 ? '…' : '');
  const status = quality < 0.12 ? 'weak' : 'functional';
  return {
    status,
    instances: names.length,
    quality,
    why: `${num(names.length)} ${word} divisions cover the map (${listed}) at `
      + `admin_level=${level}; their zone counts run ${num(smallest)}–${num(largest)}.`,
  };
}

/**
 * Status for International / 1st / 2nd administrative division border questions.
 * (generate.py `_s3_border_measuring`)
 */
function borderMeasuring(q, ordinal, sig, geo, zones, seekers) {
  const word = Object.prototype.hasOwnProperty.call(S3_ORDINAL_WORD, ordinal)
    ? S3_ORDINAL_WORD[ordinal] : String(ordinal);
  if (!geo.available || geo.admin.source === 'unknown') {
    return {
      status: 'unknown',
      instances: null,
      quality: 0.0,
      why: "The map's country could not be resolved, so no boundary level could be checked. "
        + 'Administrative levels are never guessed.',
    };
  }
  const ordinals = geo.admin.ordinals || {};
  const levels = geo.admin.borderLevels || {};
  if (ordinal && (ordinals[ordinal] === undefined || ordinals[ordinal] === null)) {
    return {
      status: 'unknown',
      instances: null,
      quality: 0.0,
      why: `This country has no ${word} administrative division, so there is no such `
        + 'boundary to measure to.',
    };
  }
  if (!Object.prototype.hasOwnProperty.call(levels, ordinal)) {
    return {
      status: 'unknown',
      instances: null,
      quality: 0.0,
      why: 'The boundary-crossing audit did not return a result for this level.',
    };
  }
  if (!levels[ordinal]) {
    const subject = ordinal === 0
      ? 'international border'
      : `${word} administrative division border`;
    return {
      status: 'dead',
      instances: 0,
      quality: 0.0,
      why: `No ${subject} crosses the map, so this always returns null. The matching twin `
        + 'of this question can still be alive: being inside one division is not the same '
        + 'as being near its edge.',
    };
  }
  if (sig.every((v) => v === null || v === undefined)) {
    return {
      status: 'unknown',
      instances: 1,
      quality: 0.0,
      why: `A ${word} boundary line does cross the map, but every zone centre sits on the `
        + 'same side of it, so the distance to it could not be derived from the zone set. '
        + 'Treat it as live and measure it by hand.',
    };
  }
  const quality = s3Quality(q, sig, zones, seekers);
  const values = sig.filter((v) => v !== null && v !== undefined);
  const lo = values.length ? minOf(values) : 0.0;
  const hi = values.length ? maxOf(values) : 0.0;
  const status = quality < 0.30 ? 'weak' : 'functional';
  return {
    status,
    instances: 1,
    quality,
    why: `A ${word} boundary crosses the map. Distance to it is approximated by the distance `
      + `to the nearest zone in a different division, which runs ${miles(lo)}–${miles(hi)} `
      + '— an upper bound on the true distance, and an interpretation.',
  };
}

/**
 * N≥2 tentacles: functional when the tentacle usually has more than one arm.
 * (generate.py `_s3_tentacle_verdict`)
 */
function tentacleVerdict(q, sig, feats, zones, seekers, n, reach, label) {
  const reachSq = reach * reach;
  const inReachCounts = [];
  for (const z of zones) {
    let c = 0;
    for (const f of feats) if (featureWithinSq(f, z.x, z.y, reachSq)) c++;
    inReachCounts.push(c);
  }
  const medianArms = inReachCounts.length ? quantile(inReachCounts, 0.5) : 0;
  const quality = s3Quality(q, sig, zones, seekers);
  let covered = 0;
  for (const c of inReachCounts) if (c >= 1) covered++;
  covered = n ? covered / n : 0.0;
  if (medianArms >= 2) {
    return {
      status: 'functional',
      instances: feats.length,
      quality,
      why: `${num(feats.length)} ${label} inside the border; the median zone has `
        + `${num(medianArms)} of them within ${miles(reach)}, so the answer names one of `
        + 'several and is worth its draw-4-keep-2 price.',
    };
  }
  const arms = medianArms < 1 ? 'none' : num(medianArms);
  return {
    status: 'weak',
    instances: feats.length,
    quality,
    why: `${num(feats.length)} ${label} inside the border, but the median zone has ${arms} `
      + `within ${miles(reach)} — the tentacle usually has at most one arm, so the answer `
      + `mostly repeats a radar at twice the cost. ${pct(covered)} of zones have any in `
      + 'reach at all. In-reach counts here are measured from the zone; in play both '
      + 'reach tests are anchored on the seeker.',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// S3 · CURSE DECK AUDIT
// ═══════════════════════════════════════════════════════════════════════════════

// Plain-words predicate for each curse, printed next to the count.
const S3_CURSE_PREDICATE_WORDS = Object.freeze({
  bridge: 'OSM: way["bridge"]["bridge"!="no"] carrying ["highway"] or ["railway"], '
    + 'covered ones included (BBOX)',
  water: 'OSM: natural=water, landuse=reservoir|basin and waterway=river|canal, pools '
    + 'excluded, named or not (BBOX)',
  car_street: 'OSM: motor-vehicle highway ways with motor_vehicle and access not no (BBOX)',
  grocery: 'OSM: shop=supermarket|greengrocer|convenience|grocery|farm (BBOX)',
  shop: 'OSM: shop=* (BBOX)',
  cuisine: "OSM: restaurants tagged with a single foreign country's cuisine (BBOX)",
  cairn_terrain: 'OSM: natural=scree|bare_rock|beach|shingle|wood (BBOX)',
  print_source: 'OSM: shop=newsagent|books|kiosk|stationery (BBOX)',
  tumble_ground: 'OSM: leisure=pitch|playground|recreation_ground|garden|nature_reserve (BBOX)',
  building: 'OSM: way["building"] (BBOX)',
  travel_agent_stop: 'OSM: parks, gardens, playgrounds, libraries, places of worship, '
    + 'marketplaces, town halls and pedestrian streets (BBOX)',
  animal_habitat: 'OSM: parks, nature reserves, forest/grass/meadow landuse and named water (BBOX)',
  u_turn: 'GTFS: share of stops with a second route, and the wait for a departure on a '
    + 'different route',
});

/**
 * Decide keep / warn / remove / player-choice for all 24 curses.
 *
 * Tier 1 (4 curses) the rulebook itself removes; tier 2 (5) is map-contingent and
 * auto-removed; tier 3 (10) warns only; tier 4 (5) is not map-contingent. Two
 * predicates are not OSM: Unguided Tourist reads `LOW_STREETVIEW_COUNTRIES`,
 * U-Turn reads `gtfsFacts.u_turn`. `metrics` (optional) supplies
 * `assumedSchedule`, which only U-Turn's wait-based verdict depends on.
 * (generate.py `audit_curses`)
 *
 * @param {Object} size @param {Object} geo @param {Object} gtfsFacts
 * @param {string|null} countryCode
 * @param {Object|null} [metrics] the `networkMetrics()` table, for `assumedSchedule`
 * @returns {Array<Object>} CurseAudit rows
 */
export function auditCurses(size, geo, gtfsFacts, countryCode, metrics = null) {
  const counts = geo.available ? geo.curseCounts : {};
  const cuisines = geo.available ? geo.cuisines : {};
  const uTurn = gtfsFacts.u_turn || {};
  const windowH = size.name === 'large' ? 1.0 : 0.5;
  const out = [];

  for (const c of CURSES) {
    let count = counts[c.id] === undefined ? null : counts[c.id];
    const pk = c.predicateKey || '';
    let predicate = Object.prototype.hasOwnProperty.call(S3_CURSE_PREDICATE_WORDS, pk)
      ? S3_CURSE_PREDICATE_WORDS[pk] : 'not map-contingent';
    let action = 'keep';
    let why = c.removalRule;

    if (c.id === 'unguided_tourist') {
      predicate = 'Static Street View coverage table for country '
        + `\`${countryCode || 'unknown'}\``;
      count = null;
      if (countryCode === null || countryCode === undefined) {
        action = 'warn';
        why = "The map's country could not be resolved, so Street View coverage is "
          + 'unknown. Check it yourself before you shuffle: the rulebook removes this '
          + 'curse wherever coverage is poor.';
      } else if (LOW_STREETVIEW_COUNTRIES.includes(countryCode)) {
        action = 'remove';
        why = `\`${countryCode}\` is on the low-Street-View list the rulebook's own example `
          + '(Germany) belongs to, so this curse comes out of the deck.';
      } else {
        why = `\`${countryCode}\` has broad Street View coverage, so the curse stays in.`;
      }
    } else if (c.id === 'u_turn') {
      const share = Number(uTurn.multi_route_stop_share || 0.0);
      const wait = uTurn.median_wait_other_route_min === undefined
        ? null : uTurn.median_wait_other_route_min;
      count = null;
      if (metrics && metrics.assumedSchedule) {
        // The wait comes from a synthesized timetable, so neither branch below
        // is a measurement; the route-share half is real geometry and still quoted.
        action = 'player-choice';
        why = `${pct(share)} of stops carry a second route — that much is real mapped `
          + 'geometry — but the wait for a departure on a different route comes from a '
          + 'timetable synthesized from OpenStreetMap, so whether the escape hatch opens '
          + `inside the card's ${num(windowH * 60)}-minute window is assumed, not measured. `
          + 'Check the real timetable before you count on this card either way. Never '
          + 'removed — the hatch is printed on the card.';
      } else if (share < 0.20 || (wait !== null && wait > windowH * 60)) {
        action = 'warn';
        why = `Only ${pct(share)} of stops carry a second route`
          + (wait !== null
            ? ', and the median wait for a departure on a different route is '
              + `${mins(wait)} against the card's ${num(windowH * 60)}-minute window`
            : '')
          + ". The card's escape hatch opens more often than the curse bites, so "
          + 'expect it to fizzle. Never removed — the hatch is printed on the card.';
      } else {
        why = `${pct(share)} of stops carry a second route`
          + (wait !== null ? ` and the median wait for a different route is ${mins(wait)}` : '')
          + ', so the curse usually bites. Never removed.';
      }
    } else if (c.id === 'egg_partner' || c.id === 'impressionable_consumer') {
      action = 'player-choice';
      if (count === 0) {
        action = 'remove';
        why = `${c.removalRule} Here the secondary check also fails: the map has none of `
          + 'the shops this curse needs, so it is uncastable anyway.';
      } else {
        why = `${c.removalRule} Geometry allows it`
          + (count !== null ? ` (${num(count)} qualifying shops on the map)` : '')
          + '; whether you want to buy things during the game is a conversation, not '
          + 'a measurement.';
      }
    } else if (c.id === 'bridge_troll') {
      if (count === null) {
        action = 'warn';
        why = "Bridges could not be counted on this run, so the rulebook's own removal test "
          + 'could not be applied.';
      } else if (count === 0) {
        action = 'remove';
        why = 'No bridges on the game map. The rulebook says outright to remove this '
          + 'curse in that case.';
      } else {
        // The card's definition of a bridge includes rail and covered ones.
        why = `${num(count)} bridges on the map — road, path and rail — so the curse `
          + 'stays in. Check that some of them are ones a seeker can physically stand '
          + 'under.';
      }
    } else if (c.id === 'distant_cuisine') {
      const distinct = Object.keys(cuisines).length;
      if (count === null) {
        action = 'warn';
        why = 'Restaurant cuisine tags were not available on this run.';
      } else if (count === 0) {
        action = 'remove';
        why = "No restaurant on the map is tagged with a single foreign country's "
          + 'cuisine, so this curse can never be cast.';
      } else if (distinct <= 1) {
        action = 'warn';
        why = `${num(count)} qualifying restaurants but only one distinct country, so `
          + 'every one of them is the same distance away and the curse is a formality.';
      } else if (count < 5) {
        action = 'warn';
        why = `Only ${num(count)} qualifying restaurants across ${num(distinct)} countries. `
          + 'Castable, but the hider has to be lucky with their zone.';
      } else {
        why = `${num(count)} restaurants across ${num(distinct)} distinct foreign cuisines. `
          + 'Remember this is a floor: many restaurants carry no cuisine tag at all.';
      }
    } else if (c.tier === 2) {
      if (count === null) {
        action = 'warn';
        why = `${c.removalRule} The count was not available on this run.`;
      } else if (count === 0) {
        action = 'remove';
        why = `${c.removalRule} The map's count is zero.`;
      } else {
        why = `${c.removalRule} The map's count is ${num(count)}, so it stays in.`;
      }
    } else if (c.tier === 3) {
      if (count !== null && count === 0) {
        action = 'warn';
        why = `${c.removalRule} Nothing on this map satisfies the predicate, so expect `
          + 'this one to stall. It is still never auto-removed.';
      } else if (count !== null) {
        why = `${c.removalRule} Map-wide count: ${num(count)}.`;
      }
    }

    out.push({
      id: c.id, name: c.name, tier: c.tier, action, predicate, count, why,
    });
  }
  return out;
}
