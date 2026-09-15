// render/verdict.js — the hero and §01–§03: the verdict summary, the score
// trace, and the your-game section.
//
// Also owns the shared formatting helpers, the per-day view helpers and the
// deterministic primitives (`sortedBy` over `cmpKey`, `fnum`); `render/map.js` and
// `render/deck.js` import them from here rather than duplicating them.
//
// PROGRESSIVE HYDRATION. The browser's `Report` grows as worker stages land; every
// function degrades on a partial one and returns '' when it has nothing to show, so
// app.js can drop the section and its nav entry.
//
// FORMATTING. Every number goes through one formatter from `../lib/core.js`: no
// `toFixed`, no arithmetic inside a template literal.

import {
  IMPERIAL_COUNTRIES, cmpStr, num, pct, mins, miles, km, sqmi, rhu, prettyDate, fillPct, shapeWord,
  FINDING_MINUS_BELOW, FINDING_PLUS_ABOVE, FITNESS_MIN_AVAILABLE_POINTS,
} from '../lib/core.js';
import {
  esc, el, join, waIcon, waCard, waCallout, waTag, waBadge, waButton, waProgressBar,
  waProgressRing, waAccordion, waScroller, waCopyButton, chip, meter, budgetBar,
  section, subhead, provChip, setProvNames, dataTable, swatch, basisChip, degradeChip,
  factChips, miniMeter, linkChip, iconLabel, legendRow, leadDetail, cardHeader, kpi,
} from './html.js';

// ── rulebook presentation constants (read, never recomputed) ─────────────────

// Verdict bands, high to low (scoring.md §1.9), read for the ladder and the advice.
const S3_BANDS = Object.freeze([
  Object.freeze([80.0, 'Excellent map', 'Play it as written; no house rules required.']),
  Object.freeze([65.0, 'Strong map', 'A few house rules and it plays well.']),
  Object.freeze([50.0, 'Playable with house rules', 'The house rules below are required, not optional.']),
  Object.freeze([35.0, 'Marginal', 'Expect substantial modification: shrink the map or change the game size.']),
  Object.freeze([0.0, 'Not recommended as a transit game', "Consider the rulebook's cars or on-foot variant."]),
]);

// Verdict band → the italic half-sentence under the h1. An unknown band falls back
// to the band itself, so a new band never renders an empty headline.
const S4_BAND_PHRASE = Object.freeze({
  'Excellent map': 'Yes — comfortably.',
  'Strong map': 'Yes, with a few house rules.',
  'Playable with house rules': 'Yes, once you agree some house rules.',
  Marginal: 'Only with substantial changes.',
  'Not recommended as a transit game': 'Not on transit, no.',
});

// Finding severity → (word, icon). The variant comes from the quadrant, not from
// here: a "high" plus is a strong point, not an alarm. The icons are magnitude, not
// alarm, for the same reason.
const S4_SEVERITY = Object.freeze({
  high: Object.freeze(['major impact', 'circle-up']),
  medium: Object.freeze(['moderate impact', 'circle-dot']),
  low: Object.freeze(['minor impact', 'circle-down']),
});

// The findings quadrants: swatch colour, the WebAwesome colour utility that tints the
// card's edge, and the icon that carries the tone without the colour.
const S4_QUADRANTS = Object.freeze([
  Object.freeze(['plus', 'What the map does well', 'var(--good)', 'wa-success', 'circle-check']),
  Object.freeze(['minus', 'What works against it', 'var(--crit)', 'wa-danger', 'circle-xmark']),
  Object.freeze(['concern', 'Risks needing a house rule', 'var(--warn)', 'wa-warning', 'triangle-exclamation']),
]);

// The four size axes: short label, icon, and the plain gloss printed under it, '' for none.
const S4_AXIS_SHORT = Object.freeze({
  A: Object.freeze(['Area covered', 'draw-polygon', 'outline around every served stop']),
  B: Object.freeze(['Hiding zones', 'location-dot', '']),
  C: Object.freeze(['Time to cross', 'stopwatch', '90th-percentile crossing time']),
  D: Object.freeze(['Corner to corner', 'arrows-left-right', '']),
});

const S4_AXIS_WORDS = Object.freeze(['small', 'medium', 'large']);

// Where each axis's band came from, as a `Metric.source` value for `s4SourceTag`.
// Only A (convex-hull area, 100–1,000 sq mi) is the rulebook's own column. B (hiding
// zones) is a reading of the rulebook's station counts; C (T90) and D (diameter) have
// no rulebook counterpart at all. The numbers live in gtfs/infer.js.
const S4_AXIS_BASIS = Object.freeze({
  A: 'rulebook',
  B: 'interp',
  C: 'interp',
  D: 'interp',
});

// The placeholder every section passes as its ordinal. app.js replaces it with the
// real number after empty sections are dropped, so the sequence has no gaps.
export const S4_ORDINAL = '--';

// ── tiny deterministic primitives ────────────────────────────────────────────

/** Compare two tuple-style sort keys element by element; a shorter prefix sorts first. */
function cmpKey(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    if (typeof x === 'number' && typeof y === 'number') {
      if (x < y) return -1;
      if (x > y) return 1;
    } else if (Array.isArray(x) && Array.isArray(y)) {
      const c = cmpKey(x, y);
      if (c !== 0) return c;
    } else {
      const c = cmpStr(String(x), String(y));
      if (c !== 0) return c;
    }
  }
  return a.length - b.length;
}

/** A stable sort on a tuple-style key. */
export function sortedBy(items, keyFn) {
  return Array.from(items).sort((a, b) => cmpKey(keyFn(a), keyFn(b)));
}

/** The maximum item by a tuple-style key; ties keep the first item encountered. */
function maxBy(items, keyFn) {
  let best = null;
  let bestKey = null;
  for (const item of items) {
    const k = keyFn(item);
    if (bestKey === null || cmpKey(k, bestKey) > 0) {
      best = item;
      bestKey = k;
    }
  }
  return best;
}

/** `min(items, key=…)`. */
function minBy(items, keyFn) {
  let best = null;
  let bestKey = null;
  for (const item of items) {
    const k = keyFn(item);
    if (bestKey === null || cmpKey(k, bestKey) < 0) {
      best = item;
      bestKey = k;
    }
  }
  return best;
}

/** First character upper, the rest lower. */
function cap(text) {
  const s = String(text || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '';
}

/** A finite number, or `null`. Guards every raw metric value before a formatter. */
export function fnum(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

// ── unit and value formatting ──────────────────────

/**
 * Does this map's country read distances in miles? Metric when unknown.
 * @param {Object} report @returns {boolean}
 */
export function s4Imperial(report) {
  const admin = (report && report.geo && report.geo.admin) || null;
  const code = String((admin && admin.countryCode) || '').toLowerCase();
  return IMPERIAL_COUNTRIES.includes(code);
}

/**
 * A distance, in the map's own units.
 * @param {Object} report @param {number} metres @param {number} [dp=2] @returns {string}
 */
export function s4Dist(report, metres, dp = 2) {
  return s4Imperial(report) ? miles(metres, dp) : km(metres, dp);
}

/**
 * An area, in the map's own units.
 * @param {Object} report @param {number} sqMetres @param {number} [dp=1] @returns {string}
 */
export function s4Area(report, sqMetres, dp = 1) {
  if (s4Imperial(report)) return sqmi(sqMetres, dp);
  return `${num(sqMetres / 1000000.0, dp)} km²`;
}

/**
 * A bare number at the shortest precision (0–3 decimals) that round-trips: 319,
 * 160.2, 18.99 and 0.003 from one rule.
 *
 * @param {number} x @returns {string}
 */
export function s4Val(x) {
  for (const dp of [0, 1, 2, 3]) {
    if (Math.abs(rhu(x, dp) - x) < 1e-9) return num(x, dp);
  }
  return num(x, 3);
}

/**
 * Sort '3 Miles' before '10 Miles' before '100 Miles'. Deterministic: digits compare
 * as integers, everything else casefolded, and the raw string breaks ties.
 *
 * @param {string} text @returns {Array<[number, number|string]>}
 */
export function s4NaturalKey(text) {
  const s = String(text === null || text === undefined ? '' : text);
  const parts = s.split(/(\d+)/);
  const key = parts.map((p) => (/^\d+$/.test(p) ? [1, Number(p)] : [0, p.toLowerCase()]));
  key.push([0, s]);
  return key;
}

/** The comparator form of `s4NaturalKey`, for `Array.prototype.sort`. */
export function s4NaturalCmp(a, b) {
  return cmpKey(s4NaturalKey(a), s4NaturalKey(b));
}

/**
 * '1 curse' / '2 curses' — subject-verb agreement in generated prose.
 * @param {number} n @param {string} singular @param {string} [plural] @returns {string}
 */
export function s4Plural(n, singular, plural = '') {
  return rhu(n, 0) === 1 ? singular : (plural || `${singular}s`);
}

/**
 * `Metric.raw` rendered in its own unit.
 * @param {Object} m @returns {string}
 */
export function s4MetricValue(m) {
  const raw = m && m.raw !== undefined ? m.raw : null;
  if (raw === null || raw === undefined) return '—';
  const unit = String((m && m.unit) || '').trim();
  if (unit === 'share') return pct(raw);
  if (unit === 'min') return mins(raw);
  if (unit === 'ratio' || unit === '0–1' || unit === '0-1') return num(raw, 2, { comma: false });
  if (!unit) return s4Val(raw);
  return `${s4Val(raw)} ${unit}`;
}

/**
 * One threshold in the metric's own unit, so it reads like the value beside it:
 * a share as a percentage (as `s4MetricValue` prints it), minutes with their unit.
 * @param {number} a @param {string} unit @returns {string}
 */
function s4RampArg(a, unit) {
  const u = String(unit || '').trim();
  if (u === 'share') return pct(a);
  if (u === 'min') return `${s4Val(a)} min`;
  return s4Val(a);
}

/**
 * The threshold column of the score trace, in words: the shaping function that
 * turned a raw value into points, which is what makes "17 of 25" checkable.
 *
 * @param {{kind?: string, args?: number[]}|null} spec @param {string} [unit] the metric's unit
 * @returns {string}
 */
export function s4RampText(spec, unit = '') {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return '—';
  const kind = String(spec.kind || '');
  const args = Array.from(spec.args || [], (a) => Number(a));
  const v = args.map((a) => s4RampArg(a, unit));
  if (kind === 'ramp' && v.length >= 2) return `none at ${v[0]}, full at ${v[1]}`;
  if (kind === 'rramp' && v.length >= 2) return `full at ${v[0]}, none at ${v[1]}`;
  if (kind === 'plateau' && v.length >= 4) {
    return `full between ${v[1]} and ${v[2]}; none below ${v[0]} or above ${v[3]}`;
  }
  if (kind === 'table') return `steps at ${v.join(', ')}`;
  return kind || '—';
}

/**
 * The terse threshold form of `s4RampText`: ○ marks no points, ● full points.
 * @param {{kind?: string, args?: number[]}|null} spec @param {string} [unit] the metric's unit
 * @returns {string}
 */
export function s4RampShort(spec, unit = '') {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return '—';
  const kind = String(spec.kind || '');
  const v = Array.from(spec.args || [], (a) => s4RampArg(Number(a), unit));
  if (kind === 'ramp' && v.length >= 2) return `○ ${v[0]} → ● ${v[1]}`;
  if (kind === 'rramp' && v.length >= 2) return `● ${v[0]} → ○ ${v[1]}`;
  if (kind === 'plateau' && v.length >= 4) return `○ ${v[0]} · ● ${v[1]}–${v[2]} · ○ ${v[3]}`;
  return s4RampText(spec);
}

/**
 * `70 / 80` tenths → '7.0 / 8.0'.
 * @param {number} pointsTenths @param {number} maxTenths @returns {string}
 */
export function s4Points(pointsTenths, maxTenths) {
  return `${num(pointsTenths / 10.0, 1)} / ${num(maxTenths / 10.0, 0)}`;
}

/**
 * A delta with an explicit sign and a real minus glyph: '−10.2', '+3.0', '0'.
 * @param {number} value @param {number} [dp=1] @returns {string}
 */
export function s4Signed(value, dp = 1) {
  const v = rhu(value, dp);
  if (v === 0) return num(0, dp, { comma: false });
  const body = num(Math.abs(v), dp, { comma: false });
  return (v > 0 ? '+' : '−') + body;
}

/**
 * 'a', 'a and b', 'a, b and c' — for template sentences that list feed values.
 * @param {ReadonlyArray<string>} items @param {string} [conjunction='and'] @returns {string}
 */
export function s4JoinWords(items, conjunction = 'and') {
  const kept = Array.from(items || []).filter((i) => i);
  if (kept.length === 0) return '';
  if (kept.length === 1) return kept[0];
  return `${kept.slice(0, -1).join(', ')} ${conjunction} ${kept[kept.length - 1]}`;
}

// ── per-day views ──────────────────────────────────

/**
 * The metric table as it reads on one service day: the top level merged with
 * `perDay[key]`, with the `…BySize` quantities resolved for the run's size once,
 * here, so no caller can pick the wrong band.
 *
 * @param {Object} report @param {string} dayKey @returns {Object}
 */
export function s4DayView(report, dayKey) {
  const metrics = (report && report.metrics) || {};
  const view = { ...metrics };
  delete view.perDay;
  const per = (metrics.perDay || {})[dayKey];
  if (per && typeof per === 'object') Object.assign(view, per);
  const sizeName = (report && report.size && report.size.name) || '';
  for (const key of ['eveningZoneShare', 'reachableZoneShare',
    'reachWithinHidingPeriod', 'playableDayWeight']) {
    const bySize = view[`${key}BySize`];
    if (bySize && typeof bySize === 'object' && sizeName in bySize) view[key] = bySize[sizeName];
  }
  return view;
}

/** Day-type keys in the feed's own order (weekday, Saturday, Sunday, …). */
export function s4DayOrder(report) {
  return Array.from((report && report.days) || [], (d) => (d.dayType || {}).key);
}

/** The day type's printed label, falling back to its key. */
export function s4DayLabel(report, dayKey) {
  for (const d of (report && report.days) || []) {
    if ((d.dayType || {}).key === dayKey) return (d.dayType || {}).label || dayKey;
  }
  return dayKey;
}

/** The day the report opens on. */
export function s4BestDay(report) {
  const keys = s4DayOrder(report);
  const selected = report && report.selectedDay;
  if (selected && keys.includes(selected)) return selected;
  return keys.length ? keys[0] : 'weekday';
}

/** The day type with the lowest fitness, when it differs from the best one. */
export function s4WorstDay(report) {
  const per = (report && report.fitness && report.fitness.perDay) || {};
  const keys = s4DayOrder(report).filter((k) => k in per);
  if (keys.length < 2) return null;
  const worst = minBy(keys, (k) => [per[k], k]);
  return worst !== s4BestDay(report) ? worst : null;
}

/**
 * Questions that function: functional plus weak. `degenerate`, `dead`, `unknown` and
 * `unaskable` are not counted (`unaskable` stays in the status union though nothing
 * emits it).
 */
export function s4LiveQuestions(report) {
  let n = 0;
  for (const q of (report && report.questions) || []) {
    if (q.status === 'functional' || q.status === 'weak') n += 1;
  }
  return n;
}

/** Every fitness metric by id. */
export function s4MetricLookup(report) {
  const out = {};
  for (const sub of (report && report.fitness && report.fitness.subscores) || []) {
    for (const m of sub.metrics || []) out[m.id] = m;
  }
  return out;
}

// The citation ids §09's provenance card owns, named as its own index names them so a
// superscript and the row it lands on announce the same thing. Cited from the tiles and
// the map card, which render long before §09 exists.
const S4_SOURCE_NAMES = Object.freeze([
  ['rulebook', 'Game size'],
  ['border', 'Border'],
  ['questions', 'Question audit'],
  ['curses', 'Curse audit'],
  ['start', 'Round-start location and departure'],
  ['days', 'Representative days'],
  ['scoring', 'Scoring parameters'],
  ['generator', 'Generator'],
  ['argv', 'Options'],
]);

/**
 * Name every `#prov-<id>` anchor this report owns, so a provenance superscript
 * announces its source instead of its code. Called from `renderHero`, which app.js
 * renders first on every stage, so the names are in place before any other section's
 * superscripts; an unnamed id still renders, carrying its code.
 */
function s4RegisterProvNames(report) {
  const pairs = [];
  const subscores = (report && report.fitness && report.fitness.subscores) || [];
  for (const sub of subscores) {
    for (const m of sub.metrics || []) pairs.push([String(m.id), String(m.name || '')]);
  }
  if (subscores.length) pairs.push(['trace', 'The full score trace']);
  const sources = (report && report.feed && report.feed.sources) || [];
  pairs.push(['feed', sources.length > 1
    ? 'The published timetable files'
    : "The agency's published timetable file"]);
  for (const pair of S4_SOURCE_NAMES) pairs.push(pair);
  setProvNames(pairs);
}

// ── shared small markup helpers ──────────────────────────────────────────────

/**
 * A `.sw` colour swatch; alias of `render/html.js` `swatch`. Shape overrides go in
 * `style`, not a utility class: `.sw` is unlayered and beats `@layer wa-utilities`.
 */
export const s4Swatch = swatch;

/** A card header with a string caption; positional wrapper over `cardHeader`. */
export const s4CardHeader = (title, caption) => cardHeader(title, { caption });

/**
 * The WebAwesome colour variant for a verdict band, read off `S3_BANDS`, so both
 * renderers give the same word the same colour.
 *
 * @param {string} band @returns {string}
 */
export function bandVariant(band) {
  for (const [cut, name] of S3_BANDS) {
    if (name === band) {
      if (cut >= 65.0) return 'success';
      if (cut >= 35.0) return 'warning';
      return 'danger';
    }
  }
  return 'neutral';
}

// ── the feed / place accessors the partial report needs ──────────────────────
//
// Stage 1 posts the feed's fields flat; the final `done` report nests them under
// `feed`. Both are read the same way so the hero renders identically either way.

function feedOf(report) {
  return (report && report.feed) || report || {};
}

function agencyNameOf(report) {
  return String(feedOf(report).agencyName || '');
}

function placeOf(report) {
  return String((report && report.place) || agencyNameOf(report) || '');
}

function provOf(report) {
  return (report && report.provenance) || {};
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · HERO
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * `[cut point, the next band's cut point, the advice sentence]` for one band, read
 * off `S3_BANDS`: what gives the headline number a scale and a "so what".
 *
 * @param {string} band @returns {[number, number, string]}
 */
export function s4BandBounds(band) {
  let upper = 100.0;
  for (const [cut, name, advice] of S3_BANDS) { // high → low, the constant's own order
    if (name === band) return [cut, upper, advice];
    upper = cut;
  }
  return [0.0, 100.0, ''];
}

/**
 * The five verdict bands as a rising ladder of tags, the map's own one filled. The
 * cut-point is in the tag's text, not only its `title`: a hover is no affordance on a phone.
 */
function s4BandLadder(report) {
  const current = report.fitness.band;
  const tags = [];
  for (let i = S3_BANDS.length - 1; i >= 0; i -= 1) { // low → high, deterministic
    const [cut, name] = S3_BANDS[i];
    const active = name === current;
    tags.push(waTag(`${num(cut, 0)}+ ${name}`, {
      size: 's',
      variant: active ? bandVariant(name) : 'neutral',
      appearance: active ? 'filled' : 'outlined',
      title: `${num(cut, 1)} and up`,
    }));
  }
  return el('ul', tags.map((t) => el('li', t)).join(''), {
    className: 'wa-cluster wa-gap-3xs wa-list-plain',
  });
}

/**
 * The score as a 100-unit segmented bar. The six sub-scores are identity, not
 * magnitude, so no `variants` is passed: one hue, and the segments are told apart by
 * the seam and the letter `budgetSeg` in app.js paints.
 *
 * @param {Object} report @param {Object} [opts] @returns {string}
 */
export function s4PointsBudget(report, opts = {}) {
  const f = (report && report.fitness) || null;
  if (!f || !f.subscores || f.subscores.length === 0) return '';
  const segments = f.subscores.map((s) => [
    s.id,
    s.earnedTenths / 10.0,
    `${s.id} · ${s.name} — ${s4Points(s.earnedTenths, s.maxTenths)} points`,
  ]);
  let earned = 0;
  for (const [, value] of segments) earned += value;
  const spoken = f.subscores.map(
    (s) => `${s.id} ${num(s.earnedTenths / 10.0, 1)} of ${num(s.maxTenths / 10.0, 0)}`,
  ).join('; ');
  let remainder = `${num(100.0 - earned, 1)} points not earned`;
  if (f.cappedBy) remainder += ` — held back by ${f.cappedBy}`;
  return budgetBar(segments, 100.0, {
    ariaLabel: `${num(earned, 1)} of 100 points earned: ${spoken}`,
    remainderTip: remainder,
    ...opts,
  });
}

/** One `meter()` per sub-score, each linking into its own score-trace item. */
function s4SubscoreMeters(report) {
  const rows = [];
  for (const s of (report.fitness && report.fitness.subscores) || []) {
    const pctage = fillPct(s.earnedTenths, s.maxTenths);
    const label = el('a', esc(`${s.id} · ${s.name}`), {
      href: `#trace-${s.id}`, className: 'wa-link-plain wa-caption-s',
    });
    const right = el('span', join(
      esc(num(s.earnedTenths / 10.0, 1)),
      el('span', esc(` / ${num(s.maxTenths / 10.0, 0)}`), { className: 'wa-color-text-quiet' }),
    ), { className: 'wa-caption-s' });
    rows.push(meter(label, pctage, right, { flank: '5rem', label: `${s.id} · ${s.name}` }));
  }
  if (rows.length === 0) return '';
  return el('div', rows.join(''), {
    className: 'wa-grid wa-gap-s', style: '--min-column-size:15rem',
  });
}

/**
 * The service days and what each one is worth, as clickable tiles. Clicking one goes
 * through `setDay()`, so the tiles, the selector and `localStorage` never disagree.
 */
function s4DayTiles(report) {
  const f = report.fitness || {};
  const per = f.perDay || {};
  const keys = s4DayOrder(report).filter((k) => k in per);
  if (Object.keys(per).length < 2 || keys.length < 2) {
    if (!(report.days || []).length) return '';
    return el('div', chip(`one service day: ${s4DayLabel(report, s4BestDay(report))}`, 'calendar-day'), {
      className: 'wa-cluster wa-gap-2xs',
    });
  }
  const deltas = f.perDayDelta || {};
  const selected = s4BestDay(report);
  const cards = [];
  for (const key of keys) {
    let note = '';
    if (key === selected) note = 'best day';
    else if (typeof deltas[key] === 'number') note = `${s4Signed(deltas[key])} points`;
    cards.push(waCard(el('div', join(
      el('span', esc(num(per[key], 1)), {
        className: 'wa-heading-xl', style: 'font-family:var(--sans)',
      }),
      el('span', esc(s4DayLabel(report, key)), { className: 'wa-caption-xs wa-text-uppercase' }),
      note ? el('span', esc(note), { className: 'wa-caption-2xs wa-color-text-quiet' }) : '',
    ), { className: 'wa-stack wa-gap-3xs' }), {
      appearance: 'outlined',
      dataDay: key,
      role: 'button',
      tabindex: '0',
      title: `Re-read the whole page for ${s4DayLabel(report, key)} service`,
    }));
  }
  return el('div', join(
    el('div', cards.join(''), {
      className: 'wa-grid wa-gap-s', style: '--min-column-size:11rem', id: 'dayscores',
    }),
    el('p', iconLabel('hand-pointer', 'Tap a day to re-read the page'), { className: 'wa-caption-xs' }),
  ), { className: 'wa-stack wa-gap-2xs' });
}

/** A cap's short label from `report.caps`, falling back to its id. */
function s4CapLabel(report, capId) {
  const row = (report.caps || []).find((c) => c.id === capId);
  return (row && row.label) || String(capId || '');
}

/** One `wa-skeleton`, sized by the caller. */
function sk(opts = {}) {
  return el('wa-skeleton', '', opts);
}

/**
 * The scorecard before the score lands, shape-for-shape the hero skeleton in
 * index.html. Returning nothing here would drop the card and re-add it at the `score`
 * stage, moving every heading below the hero twice.
 */
function s4ScorecardSkeleton() {
  const dial = el('div', join(
    sk({ style: 'inline-size:9rem;block-size:9rem;flex:none' }),
    el('div', join(
      sk({ style: 'inline-size:70%' }),
      sk(),
      sk({ style: 'inline-size:85%' }),
      sk({ style: 'inline-size:55%' }),
    ), { className: 'sk-text wa-stack wa-gap-xs', style: 'flex:1 1 11rem' }),
  ), { className: 'wa-cluster wa-gap-l' });
  // Mirrors `s4BandLadder`: one chip per band, low to high, widths tracking the labels.
  const ladder = el('div', ['14rem', '6rem', '11rem', '7rem', '8rem'].map(
    (w) => sk({ className: 'sk-chip', style: `inline-size:${w}` }),
  ).join(''), { className: 'wa-cluster wa-gap-3xs' });
  const budget = el('div', join(
    el('p', esc('Where the 100 points went'), {
      className: 'wa-heading-s wa-color-text-quiet wa-text-uppercase',
    }),
    sk({ className: 'sk-bar' }),
  ), { className: 'wa-stack wa-gap-3xs' });
  const meters = el('div', Array.from(
    { length: 6 }, () => el('div', sk() + sk(), { className: 'sk-meter' }),
  ).join(''), { className: 'wa-stack wa-gap-2xs' });
  const days = el('div', Array.from(
    { length: 3 }, () => sk({ className: 'sk-day' }),
  ).join(''), { className: 'wa-grid wa-gap-s', style: '--min-column-size:8rem' });
  const top = el('div', dial + ladder, { className: 'wa-stack wa-gap-s' });
  return waCard(el('div', join(top, budget, meters, days), {
    className: 'wa-stack wa-gap-m sk-body',
  }));
}

/**
 * The hero's answer panel. Tier 1 is the dial and the band word, the page's one
 * grade. Tier 2 (ladder, budget bar, meters, day tiles) is never collapsed: it is
 * what makes the grade checkable. Tier 3, the metric rows, is one click away in §02.
 */
function s4Scorecard(report) {
  const f = report.fitness;
  if (!f) return s4ScorecardSkeleton();
  let top;
  if (f.score === null || f.score === undefined) {
    top = waCallout(el('div', join(
      el('p', esc('Not enough of this map could be measured to give it one number'), {
        className: 'wa-heading-s',
      }),
      meter(el('span', esc('Measurable'), { className: 'wa-caption-s' }), fillPct(f.availablePoints, 100),
        el('span', esc(`${num(f.availablePoints, 1)} / 100`), { className: 'wa-caption-s' }),
        { label: 'Measurable points', flank: '4.5rem' }),
      el('p', esc(`a rating needs ${num(FITNESS_MIN_AVAILABLE_POINTS)}`), {
        className: 'wa-caption-xs wa-color-text-quiet',
      }),
    ), { className: 'wa-stack wa-gap-2xs' }), {
      variant: 'neutral', appearance: 'outlined', icon: 'circle-question',
    });
  } else {
    const [, , advice] = s4BandBounds(f.band);
    let noteHtml = '';
    if (f.cappedBy) {
      noteHtml = chip(`capped: ${s4CapLabel(report, f.cappedBy)}`, 'lock', { variant: 'danger' });
    } else if (f.availablePoints < 100) {
      noteHtml = chip(`${num(f.availablePoints, 1)} / 100 measurable`, 'gauge', { variant: 'warning' });
    }
    const inner = el('span', join(
      el('span', esc(num(f.score, 1)), {
        className: 'wa-heading-2xl', style: 'font-family:var(--sans)',
      }),
      el('span', esc('/ 100'), { className: 'wa-caption-2xs wa-text-uppercase' }),
    ), { className: 'wa-stack wa-gap-3xs wa-align-items-center' });
    const dial = waProgressRing(f.score, {
      label: 'Map fitness score',
      innerHtml: inner,
      id: 'dial',
      style: '--size:9rem;--track-width:.5rem;--indicator-width:.75rem;'
        + '--track-color:var(--surface-2);--indicator-color:var(--gold)',
    });
    const beside = el('div', join(
      el('p', esc('How good a map this is'), { className: 'wa-heading-xs' }),
      el('p', esc(advice) + (noteHtml ? '' : provChip('trace')), {
        className: 'wa-caption-s wa-color-text-quiet',
      }),
      noteHtml
        ? el('div', noteHtml + provChip('trace'), { className: 'wa-cluster wa-gap-2xs wa-align-items-center' })
        : '',
    ), { className: 'wa-stack wa-gap-3xs', style: 'flex:1 1 11rem' });
    top = el('div', join(
      el('div', dial + beside, { className: 'wa-cluster wa-gap-l wa-align-items-center' }),
      s4BandLadder(report),
    ), { className: 'wa-stack wa-gap-s' });
  }

  let budget = '';
  if (f.score !== null && f.score !== undefined) {
    // Not `subhead()`: an <h3> before the page's first <h2> is a heading-order skip.
    budget = el('div', join(
      el('p', esc('Where the 100 points went'), {
        className: 'wa-heading-s wa-color-text-quiet wa-text-uppercase',
      }),
      // `id` rides through budgetBar's `...rest`. This is the page's ONE 100-point
      // bar; the score trace links up to it.
      s4PointsBudget(report, { id: 'points-budget' }),
      legendRow([
        [swatch('background:var(--seq-550)'), 'earned (A–F)'],
        [swatch('background:var(--off)'), 'not earned'],
      ], { label: 'Points bar key' }),
    ), { className: 'wa-stack wa-gap-3xs' });
  }

  const buttons = [];
  const recs = report.recommendations || [];
  if (recs.length) {
    const n = recs.length;
    buttons.push(waButton(`Read the ${num(n)} house ${s4Plural(n, 'rule')}`, {
      href: '#recs', variant: 'brand', appearance: 'filled', icon: 'list-check',
    }));
  }
  const footer = buttons.length
    ? el('div', buttons.join(''), { className: 'wa-cluster wa-gap-s' })
    : '';

  return waCard(el('div', join(
    top, budget, s4SubscoreMeters(report), s4DayTiles(report),
  ), { className: 'wa-stack wa-gap-m' }), { footerHtml: footer });
}

/**
 * §00 — the page's answer: kicker, the question as an `h1`, the band phrase, the
 * headline figures as kpi tiles, the orienting chips, and the scorecard. The page's one display
 * figure and one band word are both here. When too little could be measured the dial
 * and budget become a callout; the meters and day tiles stay, so the layout is the same.
 *
 * @param {Object} payload the accumulated (possibly partial) report
 * @returns {string}
 */
export function renderHero(payload) {
  const report = payload || {};
  s4RegisterProvNames(report);
  const agency = agencyNameOf(report);
  const place = placeOf(report);
  if (!agency && !place) return '';

  const f = report.fitness || null;
  const size = report.size || null;
  const p = provOf(report);
  const metrics = s4MetricLookup(report);
  const v = s4DayView(report, s4BestDay(report));

  const feedStart = p.feedStart || feedOf(report).feedStart || '';
  const feedEnd = p.feedEnd || feedOf(report).feedEnd || '';
  const window = feedStart && feedEnd
    ? `${prettyDate(String(feedStart))} – ${prettyDate(String(feedEnd))}`
    : '';
  const kicker = [
    'Feasibility report',
    window,
    // `place` falls back to the agency name, so guard against "CTA, CTA".
    (place && place !== agency) ? `${agency}, ${place}` : agency,
  ].filter((x) => x).join(' · ');

  // The strip needs the zone cover. The questions tile is gated on length, not
  // presence: `report.questions` is pre-seeded as `[]` before the `rules` stage.
  let headlineHtml = '';
  if (size && report.zones && report.zones.length) {
    const tiles = [
      kpi(num(report.zones.length), 'hiding zones', '', { size: 'l', subHtml: provChip('A1') }),
      kpi(s4Area(report, fnum(v.hullSqM) || 0.0), 'network area', '', { size: 'l' }),
    ];
    const nQuestions = (report.questions || []).length;
    if (nQuestions) {
      tiles.push(kpi(`${num(s4LiveQuestions(report))} of ${num(nQuestions)}`, 'questions work', '', {
        size: 'l', subHtml: provChip('B1'),
      }));
    }
    const t90 = fnum(v.t90Min);
    if (t90 !== null) {
      const c2raw = metrics.C2 ? fnum(metrics.C2.raw) : null;
      tiles.push(kpi(mins(t90, 1), 'to cross', '', {
        size: 'l',
        subHtml: (c2raw ? esc(`${num(c2raw, 2, { comma: false })} hiding periods`) : '') + provChip('C2'),
      }));
    }
    headlineHtml = el('div', tiles.join(''), {
      className: 'wa-grid wa-gap-s', style: '--min-column-size:7rem;max-inline-size:46rem',
    });
  }

  const chips = [];
  if (size) {
    chips.push(size.inferred === false
      ? chip(`${cap(size.name)} · fixed`, 'lock', { variant: 'warning' })
      : chip(`${cap(size.name)} game`, 'ruler-combined'));
    chips.push(chip(`${num(size.hidingPeriodMin)} min hiding period`, 'hourglass-half'));
    chips.push(chip(`${s4Dist(report, size.zoneRadiusM, 2)} zone radius`, 'circle-dot'));
  }
  if (report.hub && report.hub.name) chips.push(chip(`Start · ${report.hub.name}`, 'star'));
  if (report.days && report.days.length) {
    chips.push(chip(`Best day · ${s4DayLabel(report, s4BestDay(report))}`, 'calendar-day', {
      variant: 'brand',
    }));
  }

  const bandLine = f && f.band
    ? el('p', el('em', esc(S4_BAND_PHRASE[f.band] || f.band)), {
      className: 'wa-heading-2xl wa-color-text-quiet',
    })
    : '';

  const left = el('div', join(
    el('p', esc(kicker), { className: 'kicker wa-caption-s wa-text-uppercase' }),
    el('h1', esc(`Can you hide in ${place}?`), { className: 'wa-heading-4xl' }),
    bandLine,
    headlineHtml,
    chips.length ? el('div', chips.join(''), { className: 'wa-cluster wa-gap-2xs' }) : '',
  ), { className: 'wa-stack wa-gap-xs', style: 'flex:1 1 24rem' });

  const card = s4Scorecard(report);

  // `wa-align-items-start`, not `-center`: the scorecard is twice the height of the
  // text beside it, and centring would bury the headline in dead space.
  //
  // `min-inline-size:0` on the card's flex item is load-bearing: Chart.js writes the
  // budget canvas's rendered width back as an inline style, and the flex default
  // `min-width:auto` would then never let the card shrink again.
  return el('header', el('div', join(
    left,
    el('div', card, { style: 'flex:1 1 26rem;min-inline-size:0' }),
  ), { className: 'wa-split wa-flex-wrap wa-gap-2xl wa-align-items-start' }), {
    id: 'top', dataWhen: 'report', className: 'wa-stack wa-gap-l',
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · §01 THE VERDICT
// ═══════════════════════════════════════════════════════════════════════════════

/** 0 / 1 / 2 → 'small' / 'medium' / 'large'. */
export function s4AxisWord(score) {
  const i = Math.max(0, Math.min(2, Math.trunc(Number(score) || 0)));
  return ['small', 'medium', 'large'][i];
}

/**
 * The four size axes as a table: short label, value, the vote ladder with both
 * thresholds, and whose band it is. Agreement, split and clamp are header chips.
 */
function s4AxisCard(report) {
  const si = report.sizeInference || null;
  const axes = (si && si.axes) || [];
  if (!axes.length) return '';
  const size = report.size || {};
  const fixed = size.inferred === false;
  const rows = [];
  for (const a of axes) {
    const value = a.value;
    const unit = String(a.unit || '').trim();
    const shown = typeof value === 'number' ? s4Val(value) : String(value);
    const thresholds = Array.from(a.thresholds || [], (t) => s4Val(Number(t)));
    const word = s4AxisWord(a.score === undefined ? 1 : a.score);
    const [short, icon, gloss] = S4_AXIS_SHORT[String(a.id)] || [String(a.name || ''), 'ruler', ''];
    const tag = (w) => (w === word
      ? waTag(w, { variant: 'brand', appearance: 'filled', ariaCurrent: 'true' })
        + el('span', esc(`votes ${w}`), { className: 'wa-visually-hidden' })
      : waTag(w));
    const cut = (t) => el('span', esc(t), { className: 'wa-caption-2xs wa-color-text-quiet' });
    const ladder = thresholds.length >= 2
      // Each cut in the value column's own form, unit included: `100 sq mi`, `45 min`.
      ? join(tag(S4_AXIS_WORDS[0]), cut(`${thresholds[0]} ${unit}`.trim()), tag(S4_AXIS_WORDS[1]),
        cut(`${thresholds[1]} ${unit}`.trim()),
        tag(S4_AXIS_WORDS[2]))
      : tag(word);
    rows.push([
      el('span', waIcon(icon) + el('b', esc(short)), {
        className: 'wa-cluster wa-gap-2xs wa-align-items-center wa-text-nowrap',
      }) + (gloss
        ? el('span', esc(gloss), { className: 'wa-caption-2xs wa-color-text-quiet', style: 'display:block' })
        : ''),
      el('span', esc(`${shown} ${unit}`.trim()), { className: 'wa-text-nowrap' }),
      // An arguable band still moves the median vote, so every row says whose band it is.
      el('div', join(
        el('div', ladder, { className: 'wa-cluster wa-gap-3xs wa-align-items-center' }),
        basisChip(S4_AXIS_BASIS[String(a.id)] || 'interp'),
      ), { className: 'wa-stack wa-gap-3xs' }),
    ]);
  }

  const chips = [];
  if (fixed) {
    chips.push(chip(`fixed at ${cap(size.name)}`, 'lock', { variant: 'warning' }));
  } else if (si.unanimous) {
    chips.push(chip(`${num(axes.length)} of ${num(axes.length)} axes agree`, 'check-double', { variant: 'success' }));
  } else {
    chips.push(chip('axes split · rounds down', 'arrow-down', { variant: 'warning' }));
  }
  if (!fixed && si.clamped) chips.push(chip('held within one step of area', 'lock'));

  const why = [];
  if (!fixed && !si.unanimous) {
    why.push('Where the axes disagree the vote resolves down, to the smaller game: a map that '
      + 'looks large by area and small by zone count will feel empty in play.');
  }
  if (!fixed && si.clamped) {
    why.push('The vote was kept within one band of the area axis, the axis the rulebook itself '
      + 'describes maps by.');
  }

  return waCard(
    el('div', join(
      // Scrollable, like every other table: three columns do not fit 360px.
      dataTable(['What was measured', 'This map', 'Vote'], rows),
      why.length ? leadDetail('', esc(why.join(' ')), { summary: 'How the vote resolved' }) : '',
    ), { className: 'wa-stack wa-gap-s' }),
    {
      headerHtml: cardHeader(fixed ? 'The four size axes (not used)' : `Why this is a ${cap(size.name || si.verdict || '')} map`, {
        caption: fixed ? 'Reported only; the size was fixed' : 'Four axes vote; the median sets the size',
        chipsHtml: chips.join(''),
      }),
      appearance: 'plain',
    },
  );
}

/** The section's own headline: the band, the size and the network shape. */
export function s4VerdictTitle(report) {
  const shape = shapeWord((report.metrics || {}).networkShape);
  const size = cap((report.size || {}).name || '');
  const f = report.fitness || {};
  const band = (f.score !== null && f.score !== undefined) ? f.band : 'Partly measurable';
  const parts = [shape, size ? `${size} size` : ''].filter((x) => x);
  return parts.length ? `${band}: ${parts.join(', ')}` : band;
}

/** Distinct `DegradeCode`s of the unavailable metrics, in trace order. */
function s4DropCodes(fitness) {
  const codes = [];
  for (const s of (fitness && fitness.subscores) || []) {
    for (const m of s.metrics || []) {
      const code = m.available ? null : (m.degrade || 'not_evaluated');
      if (code && !codes.includes(code)) codes.push(code);
    }
  }
  return codes;
}

/**
 * The strongest and weakest measured sub-scores as two cards, each with its two most
 * telling metrics as meters. A sub-score with no measured metric is never picked.
 */
function s4SuitCards(report) {
  const f = report.fitness;
  const measured = (m) => m.available && m.maxTenths > 0;
  const subs = (f.subscores || []).filter((s) => s.maxTenths > 0 && (s.metrics || []).some(measured));
  if (!subs.length) return '';
  /** @type {Object<string, boolean>} */
  const fixable = {};
  for (const x of report.findings || []) if (x.mitigation) fixable[String(x.metricId)] = true;

  const card = (sub, strongest) => {
    const share = (m) => fillPct(m.pointsTenths, m.maxTenths);
    const top = sortedBy((sub.metrics || []).filter(measured),
      strongest ? (m) => [-share(m), m.id] : (m) => [share(m), m.id]).slice(0, 2);
    const meters = top.map((m) => meter(
      el('span', esc(m.name) + provChip(m.id), { className: 'wa-caption-s' }),
      share(m),
      el('span', join(
        el('span', esc(s4MetricValue(m)), { style: 'display:block' }),
        el('span', esc(s4Points(m.pointsTenths, m.maxTenths)), { className: 'wa-color-text-quiet' }),
      ), { className: 'wa-caption-s' }),
      { label: m.name, flank: '5.5rem' },
    ));
    const fix = !strongest && top.some((m) => fixable[m.id])
      ? el('div', linkChip('#findings', 'see the house rules', 'wrench', { variant: 'success' }))
      : '';
    return waCard(el('div', meters.join('') + fix, { className: 'wa-stack wa-gap-s' }), {
      headerHtml: cardHeader('', {
        titleHtml: el('a', esc(sub.name), { href: `#trace-${sub.id}`, className: 'wa-link' }),
        chipsHtml: strongest
          ? chip('strongest', 'circle-up', { variant: 'success' })
          : chip('weakest', 'circle-down', { variant: 'danger' }),
        caption: `${s4Points(sub.earnedTenths, sub.maxTenths)} points`,
      }),
    });
  };

  const key = (s) => [fillPct(s.earnedTenths, s.maxTenths), s.id];
  const best = maxBy(subs, key);
  const worst = minBy(subs, key);
  const cards = [card(best, true)];
  if (worst.id !== best.id) cards.push(card(worst, false));
  return el('div', cards.join(''), { className: 'wa-grid wa-gap-m', style: '--min-column-size:15rem' });
}

/** One chip row: a fired cap, else what could not be measured, else borderline questions. */
function s4WatchOuts(report) {
  const f = report.fitness;
  const chips = [];
  if (f.cappedBy) {
    chips.push(
      linkChip('#trace', `capped at ${(f.score !== null && f.score !== undefined) ? num(f.score, 1) : '—'}`,
        'lock', { variant: 'danger' }),
      chip(`raw score ${num(f.rawScore, 1)}`, 'gauge'),
    );
  } else if (f.availablePoints < 100) {
    for (const s of f.subscores || []) {
      if (!s.partial && !(s.missing && s.missing.length)) continue;
      const all = s.metrics || [];
      chips.push(linkChip(`#trace-${s.id}`,
        `${s.name} · ${num(all.filter((m) => m.available).length)} of ${num(all.length)} measured`,
        'circle-half-stroke', { variant: 'warning' }));
    }
    for (const code of s4DropCodes(f)) chips.push(degradeChip(code));
  } else {
    const n = (report.questions || []).filter((q) => q.borderline).length;
    if (n) {
      const fired = (report.recommendations || []).some((r) => r.id === 'settle_borderline');
      chips.push(linkChip(fired ? '#rec-settle_borderline' : '#questions',
        `${num(n)} borderline ${s4Plural(n, 'question')}`, 'circle-half-stroke', { variant: 'warning' }));
    }
  }
  if (!chips.length) return '';
  return el('div', join(
    el('span', esc('Watch for'), { className: 'wa-caption-xs wa-text-uppercase wa-color-text-quiet' }),
    ...chips,
  ), { className: 'wa-cluster wa-gap-xs wa-align-items-center' });
}

/**
 * §01 — three rows, every word templated: the size axes, the strongest and weakest
 * sub-scores, and one watch-out chip row.
 *
 * @param {Object} payload @returns {string}
 */
export function renderVerdict(payload) {
  const report = payload || {};
  const f = report.fitness;
  const size = report.size;
  if (!f || !size) return '';
  return section('verdict', S4_ORDINAL, s4VerdictTitle(report),
    el('div', join(s4AxisCard(report), s4SuitCards(report), s4WatchOuts(report)), {
      className: 'wa-stack wa-gap-l',
    }),
    { kicker: 'The verdict' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · §02 WHERE THE POINTS CAME FROM — the explainability anchor
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Where a threshold came from, in words, with its icon; alias of `render/html.js`
 * `basisChip`. The precise term survives in the chip's `title` and the row's `data-basis`.
 */
export const s4SourceTag = basisChip;

/**
 * One sub-score's metrics: value, threshold, points, and where the rule came from.
 * Each row carries `id="prov-<metric id>"`, the target of every provenance chip. The
 * table is never truncated: a dropped metric is printed with its cause chip.
 *
 * @param {ReadonlyArray<Object>} metrics
 * @param {Object} [opts] @param {boolean} [opts.singleDayType] the feed has one day type
 * @returns {string}
 */
export function s4TraceTable(metrics, opts = {}) {
  const { singleDayType = false } = opts;
  const head = el('thead', el('tr', ['Metric', 'Value', 'Threshold', 'Points', 'Basis']
    .map((h) => el('th', esc(h))).join('')));
  const rows = [];
  for (const m of metrics || []) {
    const flags = join(
      m.available ? '' : degradeChip(m.degrade || 'not_evaluated'),
      singleDayType && m.available && m.id === 'E1' ? chip('one day type · full marks', 'calendar-day') : '',
    );
    // The assumed-timetable note is printed once, in the section's warning callout.
    const note = m.note && m.degrade !== 'assumed_schedule'
      ? leadDetail('', esc(m.note), { summary: 'Why this threshold' })
      : '';
    const cells = [
      el('td', el('b', esc(m.name))
        + (flags ? el('div', flags, { className: 'wa-cluster wa-gap-2xs' }) : '') + note),
      el('td', m.available ? esc(s4MetricValue(m)) : '—'),
      el('td', esc(s4RampShort(m.ramp, m.unit)), { ariaLabel: s4RampText(m.ramp, m.unit) }),
      el('td', m.available
        ? miniMeter(fillPct(m.pointsTenths, m.maxTenths), esc(s4Points(m.pointsTenths, m.maxTenths)), {
          label: `${m.name} points`,
        })
        : esc(`— / ${num(m.maxTenths / 10.0, 0)}`)),
      el('td', basisChip(m.source)),
    ];
    rows.push(el('tr', cells.join(''), {
      id: `prov-${m.id}`,
      dataBasis: m.source,
      dataAvailable: m.available ? null : '0',
    }));
  }
  return waScroller(el('table', head + el('tbody', rows.join(''))));
}

/**
 * §02 — the explainability anchor: a legend, the cap and measurability callouts, and
 * one accordion item per sub-score holding its metric table. The bar and earned/max
 * ride in the item's label, so the collapsed rows read as the whole scorecard.
 *
 * @param {Object} payload @returns {string}
 */
export function renderScoreTrace(payload) {
  const report = payload || {};
  const f = report.fitness;
  if (!f || !f.subscores || f.subscores.length === 0) return '';
  const hasScore = f.score !== null && f.score !== undefined;
  const caps = report.caps || [];

  const callouts = [];
  if (f.cappedBy) {
    const fired = caps.find((c) => c.id === f.cappedBy) || null;
    callouts.push(waCallout(el('div', join(
      el('div', join(
        chip(s4CapLabel(report, f.cappedBy), 'lock', { variant: 'danger' }),
        el('span', esc(`raw ${num(f.rawScore, 1)}`)),
        waIcon('arrow-right'),
        el('b', esc(`published ${hasScore ? num(f.score, 1) : '—'}`)),
      ), { className: 'wa-cluster wa-gap-xs wa-align-items-center wa-body-s' }),
      fired && fired.why ? el('p', esc(fired.why), { className: 'wa-body-s' }) : '',
    ), { className: 'wa-stack wa-gap-2xs' }), { variant: 'danger', icon: 'circle-exclamation' }));
  }
  if (f.availablePoints < 100) {
    const codes = s4DropCodes(f);
    let assumedNote = '';
    for (const s of f.subscores) {
      for (const m of s.metrics || []) {
        if (!assumedNote && m.degrade === 'assumed_schedule' && m.note) assumedNote = String(m.note);
      }
    }
    callouts.push(waCallout(el('div', join(
      meter(el('span', esc('Points that could be measured'), { className: 'wa-caption-s' }),
        fillPct(f.availablePoints, 100),
        el('span', esc(`${num(f.availablePoints, 1)} / 100`), { className: 'wa-caption-s' }),
        { label: 'Points that could be measured', flank: '4.5rem' }),
      codes.length ? el('div', codes.map((c) => degradeChip(c)).join(''), { className: 'wa-cluster wa-gap-2xs' }) : '',
      assumedNote
        ? el('p', esc(assumedNote), { className: 'wa-body-s' })
        : el('p', esc('Unmeasured points are dropped, never guessed.'), {
          className: 'wa-caption-xs wa-color-text-quiet',
        }),
    ), { className: 'wa-stack wa-gap-2xs' }), { variant: 'warning', icon: 'triangle-exclamation' }));
  }

  let capRow = '';
  if (caps.length) {
    const capChips = caps.map((c) => {
      const label = c.label || String(c.id || '');
      if (c.fired) return chip(`${label} · caps at ${num(c.cap)}`, 'circle-exclamation', { variant: 'danger' });
      if (c.evaluated === false) return degradeChip('not_evaluated', { suffix: label });
      return chip(label, 'circle-check', { variant: 'success' });
    });
    capRow = el('div', join(
      el('span', esc('Structural caps'), { className: 'wa-caption-xs wa-text-uppercase wa-color-text-quiet' }),
      ...capChips,
    ), { className: 'wa-cluster wa-gap-2xs wa-align-items-center' });
  }

  const singleDayType = (report.days || []).length === 1;
  const items = [];
  for (const s of f.subscores) {
    let summary = `${s.id} · ${s.name} — ${s4Points(s.earnedTenths, s.maxTenths)} points`;
    let partial = '';
    if (s.partial) {
      const all = s.metrics || [];
      partial = `${num(all.filter((m) => m.available).length)}/${num(all.length)} measured`;
      summary += ` (${partial})`;
    }
    const label = join(
      el('span', join(
        el('strong', esc(`${s.id} · ${s.name}`), { className: 'wa-body-s' }),
        partial ? chip(partial, 'circle-half-stroke', { variant: 'warning' }) : '',
      ), { className: 'wa-cluster wa-gap-s wa-align-items-center' }),
      el('span', join(
        waProgressBar(fillPct(s.earnedTenths, s.maxTenths), { label: summary, style: 'width:8rem' }),
        el('span', esc(s4Points(s.earnedTenths, s.maxTenths)), {
          className: 'wa-caption-s wa-color-text-quiet',
        }),
      ), { className: 'wa-cluster wa-gap-s wa-align-items-center' }),
    );
    // Every block starts collapsed: an open first item claims the sub-score the
    // reader arrived for is this one, and buries the other five below a long table.
    items.push([`trace-${s.id}`, label, s4TraceTable(s.metrics, { singleDayType }), false]);
  }

  const legendItems = [
    [basisChip('rulebook'), ''],
    [basisChip('feed'), ''],
    [join(swatch('background:var(--gold)'), basisChip('interp')), 'Gold edge on the row'],
    [join(swatch('background:var(--ink-3);opacity:.55'), degradeChip('not_evaluated')), 'Faded row, not scored'],
    ['', 'Threshold ○ no points → ● full points, linear between'],
  ];
  const legend = legendRow(legendItems, { label: 'How to read the score trace' });

  let answer = '';
  const lossy = f.subscores.filter((s) => typeof s.lostTenths === 'number'
    && (s.metrics || []).some((m) => m.available));
  if (hasScore && lossy.length) {
    const worst = sortedBy(lossy, (s) => [-s.lostTenths, s.id])[0];
    const parts = [];
    if (worst.lostTenths > 0) {
      parts.push(el('span', el('b', esc(`−${num(worst.lostTenths / 10.0, 1)} points`))
        + esc(` on ${String(worst.name).toLowerCase()}, the biggest loss`)));
    }
    for (const s of f.subscores) {
      const all = s.metrics || [];
      if (!all.length || all.some((m) => m.available)) continue;
      parts.push(degradeChip(all[0].degrade || 'not_evaluated', { suffix: s.name }));
    }
    if (parts.length) {
      answer = el('div', parts.join(''), { className: 'wa-cluster wa-gap-xs wa-align-items-center wa-body-s' });
    }
  }
  const body = el('div', join(
    legend,
    callouts.join(''),
    capRow,
    waAccordion(items, { mode: 'single-collapsible', headingLevel: '3' }),
    // A pointer back to the hero's one 100-point bar, on its own line, not in the key.
    hasScore ? el('p', linkChip('#points-budget', 'Back to the 100-point bar', 'chart-simple'), {
      className: 'wa-caption-s',
    }) : '',
  ), { className: 'wa-stack wa-gap-m', id: 'prov-trace' });
  return section('trace', S4_ORDINAL, 'Where the points came from', body, {
    kicker: 'Every point, traced', answerHtml: answer,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · §03 WHAT THIS MEANS FOR YOUR GAME — house rules and findings, one section
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * §03's second half — the findings quadrants as colour-utility `wa-card`s. A card leads
 * with its metric's value and a points meter, then the finding's sentence, then what to
 * do. A day-sensitive card gets the `[data-today]` outline on the day that bites.
 */
function s4FindingsHalf(report) {
  const findings = report.findings || [];
  if (!findings.length) return '';
  const metrics = s4MetricLookup(report);
  const recs = report.recommendations || [];
  const captions = {
    plus: `over ${pct(FINDING_PLUS_ABOVE, 0)} of its points`,
    minus: `under ${pct(FINDING_MINUS_BELOW, 0)} of its points`,
    concern: `under ${pct(FINDING_MINUS_BELOW, 0)} · has a fix`,
  };
  const blocks = [];
  for (const [quadrant, title, colour, tint, icon] of S4_QUADRANTS) {
    const items = findings.filter((x) => x.quadrant === quadrant);
    if (!items.length) continue;
    // Every tint in `S4_QUADRANTS` is a `wa-` colour utility; the variant is its suffix.
    const variant = tint.slice(3);
    const cards = [];
    for (const item of items) {
      const severity = String(item.severity || '');
      const [word, sevIcon] = S4_SEVERITY[severity] || [severity, 'circle-info'];
      let badge = severity
        ? chip(word, sevIcon, {
          variant, appearance: 'outlined', title: `severity: ${severity}`,
        })
        : '';
      // Both day chips are always in the markup and one CSS rule swaps them, so the
      // card carries the word and not just a red outline.
      const dayKey = typeof item.daySensitive === 'string' ? item.daySensitive : '';
      if (dayKey) {
        const dayLabel = s4DayLabel(report, dayKey);
        badge = join(
          chip(`Measured on ${dayLabel}`, 'calendar-day', { dataTodayCue: 'off' }),
          chip('Your day', 'calendar-day', {
            variant: 'danger', appearance: 'filled', dataTodayCue: 'on',
          }),
          badge,
        );
      }
      const metricId = String(item.metricId || '');
      const m = metrics[metricId] || null;
      const lead = m && m.available && m.maxTenths > 0
        ? join(
          el('span', esc(s4MetricValue(m)), { className: 'wa-heading-l', style: 'font-family:var(--sans)' }),
          meter(el('span', esc(m.name) + provChip(metricId), { className: 'wa-caption-s' }),
            fillPct(m.pointsTenths, m.maxTenths),
            el('span', esc(s4Points(m.pointsTenths, m.maxTenths)), { className: 'wa-caption-s wa-color-text-quiet' }),
            { label: m.name, flank: '4.5rem' }),
        )
        : el('p', esc(String(item.title || '')) + (metricId ? provChip(metricId) : ''), {
          className: 'wa-caption-xs wa-text-uppercase wa-color-text-quiet',
        });
      let footer = '';
      if (item.mitigation) {
        const ruleIndex = quadrant === 'concern'
          ? recs.findIndex((r) => (r.metricIds || []).includes(metricId))
          : -1;
        footer = ruleIndex >= 0
          ? linkChip(`#rec-${recs[ruleIndex].id}`, `house rule ${num(ruleIndex + 1)}`, 'list-check', {
            variant: 'success',
          })
          : el('div', chip('what to do', 'wrench', { variant: 'success' })
            + el('span', esc(String(item.mitigation))), {
            className: 'wa-cluster wa-gap-xs wa-align-items-center wa-body-s',
          });
      }
      cards.push(waCard(
        el('div', join(
          lead,
          el('p', esc(String(item.detail || '')), { className: 'wa-body-s wa-text-pretty' }),
        ), { className: 'wa-stack wa-gap-xs' }),
        {
          headerHtml: badge ? el('div', badge, { className: 'wa-cluster wa-gap-2xs wa-align-items-center' }) : '',
          footerHtml: footer,
          className: tint,
          dataDay: dayKey || null,
        },
      ));
    }
    blocks.push(el('div', join(
      el('div', join(
        el('h4', join(
          swatch(`background:${colour}`),
          waIcon(icon),
          el('span', esc(title)),
          waBadge(num(items.length), { variant: 'neutral', appearance: 'outlined' }),
        ), { className: 'wa-heading-s wa-color-text-quiet wa-cluster wa-gap-s wa-align-items-center' }),
        el('span', esc(captions[quadrant]), { className: 'wa-caption-xs wa-color-text-quiet' }),
      ), { className: 'wa-cluster wa-gap-s wa-align-items-center' }),
      el('div', cards.join(''), {
        className: 'wa-grid wa-gap-m', style: `--min-column-size:${quadrant === 'plus' ? '16rem' : '300px'}`,
      }),
    ), { className: 'wa-stack wa-gap-s' }));
  }

  return el('div', join(
    subhead('What works, what fights you', { anchorId: 'findings' }),
    el('div', blocks.join(''), { className: 'wa-stack wa-gap-xl', id: 'findings-body' }),
  ), { className: 'wa-stack wa-gap-s' });
}

/**
 * The four border degrees, spelled exactly as the map's coordinates table spells
 * them. Only for the COPIED checklist, which is pasted into a chat where "the map
 * above" points at nothing.
 */
function s4BorderDegrees(report) {
  const bbox = (report.border && report.border.bbox) || null;
  if (!bbox || bbox.length < 4) return '';
  const [s, w, n, e] = bbox;
  return ` The border is south ${num(s, 6, { comma: false })}, west ${num(w, 6, { comma: false })}, `
    + `north ${num(n, 6, { comma: false })}, east ${num(e, 6, { comma: false })}.`;
}

/**
 * §03's first half — the fired house rules as an `ol.recs`, in priority order. Each
 * card is an imperative lead, a status row (must agree · basis · degrade · figures), an
 * items row (at most five names, then `+N more`), and the rationale folded. `evidence`
 * is report.json provenance and is never rendered; the whole checklist is one
 * `wa-copy-button` away as plain `text`.
 */
function s4HouseRulesHalf(report) {
  const recs = report.recommendations || [];
  if (!recs.length) return '';
  const items = [];
  const row = (parts) => {
    const kept = parts.filter(Boolean);
    return kept.length
      ? el('div', kept.join(''), { className: 'wa-cluster wa-gap-2xs wa-align-items-center' })
      : '';
  };
  for (const rec of recs) {
    const ex = rec.explain || null;
    const lead = ex && ex.lead ? String(ex.lead) : String(rec.text || '');
    const detail = ex ? String(ex.detail || '') : '';
    const status = row([
      // amber, not red: red on this page already means "out of the deck" / "dead".
      rec.required ? chip('Everyone must agree', 'circle-exclamation', { variant: 'warning' }) : '',
      rec.basis ? basisChip(rec.basis) : '',
      degradeChip(rec.degrade),
      factChips(rec.facts),
    ]);
    const more = (rec.id === 'remove_curses' || rec.id === 'no_spending_toggle') ? '#curses' : '#questions';
    const names = row([
      ...(rec.items || []).slice(0, 5).map((it) => chip(String(it.label || it.id || ''))),
      rec.itemsMore > 0 ? linkChip(more, `+${num(rec.itemsMore)} more`) : '',
      // The map is the degrees' one home, so the border rule links there.
      rec.id === 'use_borders' ? linkChip('#network', 'go to the map', 'map-location-dot') : '',
    ]);
    // The safety rule's body is the judgement itself, so it is never folded.
    let body = '';
    if (detail) {
      body = rec.id === 'safety_exclusions'
        ? el('p', esc(detail), { className: 'wa-body-s' })
        : leadDetail('', esc(detail), { summary: 'Details' });
    }
    const card = waCard(el('div', join(
      el('p', join(
        rec.icon ? waIcon(rec.icon) : '',
        el('span', el('b', esc(lead)) + provChip(...(rec.metricIds || []))),
      ), {
        className: 'wa-body-m wa-cluster wa-gap-xs wa-align-items-center', style: 'flex-wrap:nowrap',
      }),
      status,
      names,
      body,
    ), { className: 'wa-stack wa-gap-2xs' }));
    items.push(el('li', card, { id: `rec-${rec.id}` }));
  }
  const required = recs.filter((r) => r.required).length;
  const badges = join(
    waBadge(num(recs.length), { variant: 'neutral', appearance: 'outlined' }),
    required ? waBadge(`${num(required)} must agree`, { variant: 'warning' }) : '',
  );
  const checklist = recs.map(
    (rec, i) => `${num(i + 1)}. ${rec.text || ''}`
      + (rec.id === 'use_borders' ? s4BorderDegrees(report) : '')
      + (rec.required ? ' (everyone must agree)' : ''),
  ).join('\n');
  return el('div', join(
    el('div', join(
      subhead('House rules to agree before you start', { anchorId: 'recs', badgeHtml: badges }),
      waCopyButton(checklist, { label: 'Copy the checklist', id: 'reccopy' }),
    ), { className: 'wa-split wa-align-items-center wa-gap-s' }),
    el('p', esc('Triggered by this map · priority order'), { className: 'wa-caption-s wa-color-text-quiet' }),
    el('ol', items.join(''), { className: 'recs', id: 'recs-list', style: 'max-width:78ch' }),
  ), { className: 'wa-stack wa-gap-s' });
}

/**
 * §03 — what to agree, and what to expect. Either half may be empty; when only one
 * survives the section takes that half's title. `#recs` and `#findings` are `<h3 id>`
 * destinations inside it, so every inbound link and nav entry still resolves. The
 * counts ride as badges on each half's headings.
 *
 * @param {Object} payload @returns {string}
 */
export function renderYourGame(payload) {
  const report = payload || {};
  const rules = s4HouseRulesHalf(report);
  const findings = s4FindingsHalf(report);
  if (!rules && !findings) return '';
  let title = 'What this means for your game';
  if (!findings) title = 'House rules to agree before you start';
  else if (!rules) title = 'What works, what fights you';
  const body = el('div', join(rules, findings), { className: 'wa-stack wa-gap-2xl' });
  return section('yourgame', S4_ORDINAL, title, body, { kicker: 'Before you play' });
}
