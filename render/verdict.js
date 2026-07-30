// render/verdict.js — the hero and §01–§03 (generate.py S4).
//
// Ported from:
//   index_hero            11455   + _s4_band_bounds 11278, _s4_band_ladder 11295,
//                                   _s4_points_budget 11312, _s4_subscore_meters 11336,
//                                   _s4_day_tiles 11351, _s4_scorecard 11381,
//                                   _s4_axis_word 11528, _s4_axis_card 11542,
//                                   band_variant 13516
//   index_verdict         11580   + _s4_verdict_title 11708          → §01 `#verdict`
//   index_score_trace     12579   + _s4_source_tag 12545,
//                                   _s4_trace_table 12554            → §02 `#trace`
//   index_your_game       12785   + _s4_findings_half 12675,
//                                   _s4_house_rules_half 12746       → §03 `#yourgame`
//
// This file also owns the shared S4 formatting helpers (generate.py 10611–10724) and
// the per-day view helpers (10726–10800). `render/map.js` and `render/deck.js` import
// them from here rather than duplicating them.
//
// PROGRESSIVE HYDRATION. The CLI has one `Report`; the browser has a partial one that
// grows as the worker's stages land. Every function here takes that partial report and
// degrades: a piece it has not been given yet is simply not printed, and a section with
// nothing to show returns '' so app.js can drop it and its nav entry. That is the only
// structural difference from the Python — the sentences, the thresholds and the
// wording are the CLI's, verbatim.
//
// FORMATTING DISCIPLINE. Every number on this page goes through exactly one formatter
// from `../lib/core.js`. There is no `toFixed` and no arithmetic inside a template
// literal anywhere below.

import {
  IMPERIAL_COUNTRIES, num, pct, mins, miles, km, sqmi, rhu, prettyDate,
} from '../lib/core.js';
import {
  esc, el, join, waIcon, waCard, waCallout, waTag, waButton, waProgressBar,
  waProgressRing, waAccordion, waScroller, waCopyButton, chip, meter, budgetBar,
  section, subhead, provChip, dataTable,
} from './html.js';

// ── rulebook presentation constants (read, never recomputed) ─────────────────

// Verdict bands, high to low (scoring.md §1.9). `generate.py` line 7423 — S4 reads it
// for the ladder and the advice sentence, exactly as `band_variant` does.
const S3_BANDS = Object.freeze([
  Object.freeze([80.0, 'Excellent map', 'Play it as written; no house rules required.']),
  Object.freeze([65.0, 'Strong map', 'A few house rules and it plays well.']),
  Object.freeze([50.0, 'Playable with house rules', 'The house rules below are required, not optional.']),
  Object.freeze([35.0, 'Marginal', 'Expect substantial modification: shrink the map or change the game size.']),
  Object.freeze([0.0, 'Not recommended as a transit game', "Consider the rulebook's cars or on-foot variant."]),
]);

// scoring.md §1.9 verdict bands → the italic half-sentence in the h1. Keyed on the
// band string S3 produced; an unknown band falls back to the band itself, so a new
// band can never render as an empty headline.
const S4_BAND_PHRASE = Object.freeze({
  'Excellent map': 'Yes — comfortably.',
  'Strong map': 'Yes, with a few house rules.',
  'Playable with house rules': 'Yes, once you agree some house rules.',
  Marginal: 'Only with substantial changes.',
  'Not recommended as a transit game': 'Not on transit, no.',
});

// Finding severity → (word, icon). The *variant* comes from the quadrant, not from
// here: a "high" plus is a strong point, and painting it red was a bug. The icons are
// magnitude, not alarm, for the same reason: `circle-exclamation` means "a risk to the
// round" everywhere else on both pages, and ten of them on the strengths grid said the
// opposite of what the grid says. Up / dot / down are used nowhere else.
const S4_SEVERITY = Object.freeze({
  high: Object.freeze(['major', 'circle-up']),
  medium: Object.freeze(['moderate', 'circle-dot']),
  low: Object.freeze(['minor', 'circle-down']),
});

// `Metric.source` → (wa-tag variant, the word the page prints, icon, the precise term).
// An interpretation is never presented as a rule; contract.md §5.4 requires it to be
// visually distinct and labelled, and the precise term survives in the tag's `title`
// and in the row's `data-basis`.
const S4_SOURCE_TAG = Object.freeze({
  rulebook: Object.freeze(['brand', 'From the rules', 'book', 'rulebook']),
  feed: Object.freeze(['neutral', 'Measured', 'wave-square', 'feed']),
  interp: Object.freeze(['warning', 'Our call', 'scale-balanced', 'interpretation']),
});

// The four findings quadrants, in the drafts' order, with their swatch colour, the
// WebAwesome colour utility that tints the card's leading edge, and the icon that
// makes the tone legible without the colour.
const S4_QUADRANTS = Object.freeze([
  Object.freeze(['plus', 'What the map does well', 'var(--good)', 'wa-success', 'circle-check']),
  Object.freeze(['minus', 'What works against it', 'var(--crit)', 'wa-danger', 'circle-xmark']),
  Object.freeze(['benefit', 'Practical upsides for players', 'var(--accent)', 'wa-brand', 'circle-check']),
  Object.freeze(['concern', 'Risks needing a house rule', 'var(--warn)', 'wa-warning', 'triangle-exclamation']),
]);

// The four size axes in plain words. The generator's own technical name for each stays
// on the page as the quiet caption beneath, so nothing is renamed away.
const S4_AXIS_PLAIN = Object.freeze({
  A: 'The area the buses actually cover',
  B: 'How many distinct places there are to hide',
  C: 'How long it takes to cross the map',
  D: 'How far it is corner to corner',
});

// Where each axis's band came from, as a `Metric.source` value so the axis table can
// reuse `s4SourceTag` and read the same as every other provenance chip on the page.
//
// "Choosing a Transit System" gives the size table in full and gives nothing else:
// SMALL 30–100 stations / 10–100 sq. mi, MEDIUM 100–500 / 100–1,000, LARGE 500+ /
// 1,000+. So:
//   A · convex-hull area [100, 1000] sq mi — verbatim the rulebook's second column.
//   B · hiding zones [100, 500] — a reading, not a quotation: the rulebook counts
//       *stations*, and only because it says each hiding zone is centred on one (and
//       calls the whole table "our best estimate") does the station band transfer.
//   C · T90 traversal time and D · straight-line diameter — no rulebook counterpart at
//       all; the rulebook never mentions traversal or diameter. These bands are the
//       generator's, and saying otherwise turned two invented thresholds into rules.
// The numbers themselves live in gtfs/infer.js and are not restated here.
const S4_AXIS_BASIS = Object.freeze({
  A: 'rulebook',
  B: 'interp',
  C: 'interp',
  D: 'interp',
});

// The placeholder every index section passes as its ordinal. app.js replaces it with
// the section's real number **after** the empty ones are dropped, so a feed with no
// curses yields §01…§08 with no gap in the sequence. `section()` is the only thing
// that emits `data-n`, so the substitution can only ever hit the right attribute.
export const S4_ORDINAL = '--';

// ── tiny deterministic primitives ────────────────────────────────────────────

/** Plain code-point string comparison. Never `localeCompare` — that is locale-bound. */
function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compare two Python-style sort keys: arrays whose elements are numbers or strings,
 * compared element by element, a shorter prefix sorting first.
 */
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

/** `sorted(items, key=…)` — a stable sort on a Python-style tuple key. */
function sortedBy(items, keyFn) {
  return Array.from(items).sort((a, b) => cmpKey(keyFn(a), keyFn(b)));
}

/** `max(items, key=…)`, with Python's full tie-break semantics (the key decides). */
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

/** Python's `str.capitalize()`: first character upper, the rest lower. */
function cap(text) {
  const s = String(text || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '';
}

/** A finite number, or `null`. Guards every raw metric value before a formatter. */
function fnum(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

// ── unit and value formatting (generate.py 10611–10724) ──────────────────────

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
 * A bare number at the shortest precision that does not lose it.
 *
 * Ramp bounds and raw metric values span 0.003 to 84,466 on one page, so a fixed
 * number of decimals is wrong somewhere: `319.0 zones` and `0.4 share` are both
 * misreadings waiting to happen. This walks 0→3 decimals and stops at the first
 * that round-trips, which prints 319, 160.2, 18.99 and 0.003 from one rule.
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
 * Sort '3 Miles' before '10 Miles' before '100 Miles'.
 *
 * Half the rulebook's question labels are numeric ('¼ Mile', '25 Miles', '2nd
 * Administrative Division'), and a plain lexical sort renders those lists in an
 * order that reads as a bug. Still fully deterministic: digits compare as integers,
 * everything else casefolded, and the raw string breaks any remaining tie.
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
  if (unit === 'min') return mins(raw, 1);
  if (unit === 'ratio' || unit === '0–1' || unit === '0-1') return num(raw, 2, { comma: false });
  if (!unit) return s4Val(raw);
  return `${s4Val(raw)} ${unit}`;
}

/**
 * The threshold column of the score trace, in words.
 *
 * Every metric carries the shaping function that turned its raw value into points;
 * printing it is what makes "17 of 25" checkable rather than assertable.
 *
 * @param {{kind?: string, args?: number[]}|null} spec @returns {string}
 */
export function s4RampText(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return '—';
  const kind = String(spec.kind || '');
  const args = Array.from(spec.args || [], (a) => Number(a));
  const v = args.map((a) => s4Val(a));
  if (kind === 'ramp' && v.length >= 2) return `none at ${v[0]}, full at ${v[1]}`;
  if (kind === 'rramp' && v.length >= 2) return `full at ${v[0]}, none at ${v[1]}`;
  if (kind === 'plateau' && v.length >= 4) {
    return `full between ${v[1]} and ${v[2]}; none below ${v[0]} or above ${v[3]}`;
  }
  if (kind === 'table') return `steps at ${v.join(', ')}`;
  return kind || '—';
}

/**
 * `70 / 80` tenths → '7.0 / 8.0'.
 * @param {number} pointsTenths @param {number} maxTenths @returns {string}
 */
export function s4Points(pointsTenths, maxTenths) {
  return `${num(pointsTenths / 10.0, 1)} / ${num(maxTenths / 10.0, 1)}`;
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

// Python-name aliases, so the other renderers can import whichever spelling they
// reached for. Same functions, no second implementation.
export {
  s4Imperial as _s4_imperial,
  s4Dist as _s4_dist,
  s4Area as _s4_area,
  s4Val as _s4_val,
  s4MetricValue as _s4_metric_value,
  s4RampText as _s4_ramp_text,
  s4Points as _s4_points,
  s4Signed as _s4_signed,
  s4JoinWords as _s4_join_words,
  s4Plural as _s4_plural,
  s4NaturalKey as _s4_natural_key,
};

// ── per-day views (generate.py 10726–10800) ──────────────────────────────────

/**
 * The metric table as it reads on one service day.
 *
 * `networkMetrics` publishes the best day at the top level and every day under
 * `perDay[key]`; the size-dependent quantities exist only in their `…BySize` form
 * inside `perDay`, because S1 computes them before the size is resolved. This merges
 * the two into the flat view the tiles and the banner read, and resolves the size
 * once, here, so no caller can pick the wrong band.
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
 * Questions that actually function: functional plus weak. `degenerate`, `dead` and
 * `unknown` are not counted; `unaskable` is not counted either, but nothing emits it
 * any more — `rules/audit.js` `auditQuestions` now scores Transit Line like every
 * other matching question, because a curse that has to be drawn and paid for is not a
 * property of the map. The status stays in the union, so the test stays.
 */
export function s4LiveQuestions(report) {
  let n = 0;
  for (const q of (report && report.questions) || []) {
    if (q.status === 'functional' || q.status === 'weak') n += 1;
  }
  return n;
}

/** Every fitness metric by id, for the prose slots and the headline sentence. */
export function s4MetricLookup(report) {
  const out = {};
  for (const sub of (report && report.fitness && report.fitness.subscores) || []) {
    for (const m of sub.metrics || []) out[m.id] = m;
  }
  return out;
}

// ── shared small markup helpers ──────────────────────────────────────────────

/**
 * A `.sw` colour swatch. (generate.py `_s4_swatch`, line 11780.)
 *
 * Shape overrides go in `style`, not a utility class: `.sw` is unlayered, so it beats
 * anything in `@layer wa-utilities` — `class="wa-border-radius-circle"` would lose to
 * `.sw`'s own 3px. The dot swatches reference the token inline instead.
 */
export function s4Swatch(style) {
  return el('span', '', { className: 'sw', style });
}

/**
 * The drafts' card header: a heading and the caption that explains the encoding —
 * including, always, what the empty state means. (generate.py `_s4_card_header`.)
 */
export function s4CardHeader(title, caption) {
  return el('div', join(
    el('p', esc(title), { className: 'wa-heading-xs' }),
    el('p', esc(caption), { className: 'wa-caption-xs' }),
  ), { className: 'wa-stack wa-gap-3xs' });
}

/**
 * The WebAwesome colour variant for a verdict band, read off `S3_BANDS`.
 *
 * Reading a module-level rulebook constant is not computing: the cut points are the
 * rulebook's, and both renderers need the same green/amber/red for the same word.
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
// Stage 1 posts the feed's fields flat (`{agencyName, feedStart, …}`); the final
// `done` report nests them under `feed`. Both are read the same way here so the hero
// renders identically whichever one app.js has merged in.

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
 * `[cut point, the next band's cut point, the advice sentence]` for one band.
 *
 * `S3_BANDS` is a module-level rulebook presentation constant carrying
 * `(cut, name, advice)`; `scoreFitness` uses the first two elements and discards the
 * third. Reading it here is not computing, and it is what finally gives the headline
 * number a scale, plus a "so what" sentence that until now was written and thrown
 * away.
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
 * The five verdict bands as a rising ladder of tags, the map's own one filled.
 *
 * The cut-point is in the tag's *text*, not only its `title`: a hover is not an
 * affordance on a phone, and the ladder exists precisely to give the dial a scale.
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
  return el('div', tags.join(''), { className: 'wa-cluster wa-gap-3xs', role: 'list' });
}

/**
 * The score as a 100-unit segmented bar — the README's ASCII breakdown, rendered.
 *
 * The six sub-scores are identity, not magnitude, so every segment is one hue and
 * carries its own letter: painting A–F in six colours would imply F is worse than A,
 * which is false. This is why no `variants` is passed — one hue, and the segments are
 * told apart by the 1px seam and the drawn letter, which `budgetSeg` in app.js paints
 * onto the canvas.
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
    const pctage = s.maxTenths ? (100.0 * s.earnedTenths) / s.maxTenths : 0.0;
    const label = el('a', esc(`${s.id} · ${s.name}`), {
      href: `#trace-${s.id}`, className: 'wa-link-plain wa-caption-s',
    });
    const right = el('span', join(
      esc(num(s.earnedTenths / 10.0, 1)),
      el('span', esc(` / ${num(s.maxTenths / 10.0, 0)}`), { className: 'wa-color-text-quiet' }),
    ), { className: 'wa-caption-s' });
    rows.push(meter(label, pctage, right, { flank: '3.5rem' }));
  }
  if (rows.length === 0) return '';
  return el('div', rows.join(''), {
    className: 'wa-grid wa-gap-s', style: '--min-column-size:15rem',
  });
}

/**
 * The three service days and what each one is worth, as clickable tiles.
 *
 * These numbers exist otherwise only inside a `title=` attribute on the day radios,
 * and they are the most interesting finding on the page: the same map is a different
 * game on a Sunday. Clicking a tile goes through `setDay()`, so the tiles, the
 * selector and `localStorage` can never disagree.
 */
function s4DayTiles(report) {
  const per = (report.fitness && report.fitness.perDay) || {};
  const keys = s4DayOrder(report).filter((k) => k in per);
  if (keys.length < 2) return '';
  const best = maxBy(keys, (k) => [per[k], k]);
  const cards = [];
  for (const key of keys) {
    const delta = per[key] - per[best];
    cards.push(waCard(el('div', join(
      el('span', esc(num(per[key], 1)), {
        className: 'wa-heading-xl', style: 'font-family:var(--sans)',
      }),
      el('span', esc(s4DayLabel(report, key)), { className: 'wa-caption-xs wa-text-uppercase' }),
      el('span', esc(key === best ? 'best day' : `${s4Signed(delta)} points`), {
        className: 'wa-caption-2xs wa-color-text-quiet',
      }),
    ), { className: 'wa-stack wa-gap-3xs' }), {
      appearance: 'outlined',
      dataDay: key,
      role: 'button',
      tabindex: '0',
      title: `Re-read the whole page for ${s4DayLabel(report, key)} service`,
    }));
  }
  return el('div', cards.join(''), {
    className: 'wa-grid wa-gap-s', style: '--min-column-size:11rem', id: 'dayscores',
  });
}

/**
 * The hero's answer panel: grade, scale, budget, rubric, and what to do next.
 *
 * Tier 1 is the dial and the band word — exactly one grade on the page. Tier 2 is
 * the ladder, the budget bar, the six meters and the day tiles, and none of it is
 * ever collapsed: it is what makes the grade checkable. Tier 3, the metric rows
 * behind every one of those numbers, is one click away in §02.
 */
function s4Scorecard(report) {
  const f = report.fitness;
  if (!f) return '';
  let top;
  if (f.score === null || f.score === undefined) {
    top = waCallout(el('div', join(
      el('p', esc('Not enough of this map could be measured to give it one number'), {
        className: 'wa-heading-s',
      }),
      el('p', esc(`Only ${num(f.availablePoints, 1)} of 100 points could be measured on `
        + 'this map, so no headline number is printed. The sub-scores that were '
        + 'measurable are below.'), { className: 'wa-body-s' }),
    ), { className: 'wa-stack wa-gap-2xs' }), {
      variant: 'neutral', appearance: 'outlined', icon: 'circle-question',
    });
  } else {
    const [cut, upper, advice] = s4BandBounds(f.band);
    let note = f.band;
    if (f.cappedBy) note = `${f.band} · held back by ${f.cappedBy}`;
    else if (f.availablePoints < 100) {
      note = `${f.band} · ${num(f.availablePoints, 1)} of 100 points measurable`;
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
      el('p', esc(`${num(cut, 1)}–${num(upper, 1)} out of 100 is “${String(f.band).toLowerCase()}”.`), {
        className: 'wa-body-s',
      }),
      el('p', esc(advice), { className: 'wa-caption-s wa-color-text-quiet' }),
      el('p', esc(note) + provChip('trace'), { className: 'wa-caption-s wa-color-text-quiet' }),
    ), { className: 'wa-stack wa-gap-3xs', style: 'flex:1 1 11rem' });
    top = el('div', join(
      el('div', dial + beside, { className: 'wa-cluster wa-gap-l wa-align-items-center' }),
      s4BandLadder(report),
    ), { className: 'wa-stack wa-gap-s' });
  }

  let budget = '';
  if (f.score !== null && f.score !== undefined) {
    // Not `subhead()`: this label sits inside the hero <header>, before the page's
    // first <h2>, and an <h3> there is a heading-order skip (h1 → h3 → h2).
    budget = el('div', join(
      el('p', esc('Where the 100 points went'), {
        className: 'wa-heading-s wa-color-text-quiet wa-text-uppercase',
      }),
      s4PointsBudget(report),
      el('p', esc('Each block is one sub-score; the grey tail is what the map did not '
        + 'earn. Hover a block for its name and its points.'), {
        className: 'wa-caption-xs wa-color-text-quiet',
      }),
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
 * §00 — the page's answer, above everything else: kicker, the question as an `h1`,
 * the band phrase as its own deck line, the headline sentence, three orienting chips,
 * and the scorecard.
 *
 * Exactly one display figure and one band word exist on this page, and they are both
 * in here. When too little of the map could be measured the dial and the points
 * budget are replaced by a callout saying so; the six sub-score meters and the day
 * tiles are the scorecard's body in both branches, so the fallback is the same layout
 * rather than a different one.
 *
 * @param {Object} payload the accumulated (possibly partial) report
 * @returns {string}
 */
export function renderHero(payload) {
  const report = payload || {};
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
    // `place` falls back to the agency name when Nominatim was not consulted
    // (--no-osm, or an Overpass failure), so guard against "CTA, CTA".
    (place && place !== agency) ? `${agency}, ${place}` : agency,
  ].filter((x) => x).join(' · ');

  // The headline sentence needs the zone cover and the question audit; until those
  // stages land it is simply not printed, rather than printed with holes in it.
  let headlineHtml = '';
  if (size && report.zones && report.questions) {
    const live = s4LiveQuestions(report);
    const c2 = metrics.C2;
    const t90 = fnum(v.t90Min);
    let crossing = '';
    if (t90 !== null) {
      crossing = `, and crossing the network end to end costs about ${mins(t90)}`;
      const c2raw = c2 ? fnum(c2.raw) : null;
      if (c2raw) crossing += ` — ${num(c2raw, 2, { comma: false })} hiding periods`;
    }
    const headline = `${num(report.zones.length)} distinct hiding zones across `
      + `${s4Area(report, fnum(v.hullSqM) || 0.0)} of ${agency} network, `
      + `${num(live)} of the ${num(report.questions.length)} questions in the `
      + `${String(size.name).toUpperCase()} deck function here${crossing}.`;
    headlineHtml = el('p', esc(headline) + provChip('A1', 'B1'), {
      className: 'wa-body-l', style: 'max-inline-size:46ch',
    });
  }

  const chips = [];
  if (size) {
    chips.push(chip(`${cap(size.name)} map · ${num(size.hidingPeriodMin)}-min hiding period · `
      + `${s4Dist(report, size.zoneRadiusM, 2)} zones`, 'ruler-combined', { variant: 'warning' }));
  }
  if (report.hub && report.hub.name) chips.push(chip(`Start: ${report.hub.name}`, 'star'));
  if (report.days && report.days.length) {
    chips.push(chip(`Best day: ${s4DayLabel(report, s4BestDay(report))}`, 'calendar-day', {
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

  // `wa-align-items-start`, not `-center`: the scorecard is roughly twice the height
  // of the text beside it, so centring buries the headline under ~275px of dead space
  // once the two columns fit side by side (~1176px viewport and up). Below that the
  // columns wrap, each flex line holds one item, and the two alignments are identical.
  return el('header', el('div', join(
    left,
    card ? el('div', card, { style: 'flex:1 1 26rem' }) : '',
  ), { className: 'wa-split wa-flex-wrap wa-gap-2xl wa-align-items-start' }), {
    id: 'top', className: 'wa-stack wa-gap-l',
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
 * "Why this is a Medium map" — the four size axes as a table, above the prose.
 *
 * This used to be a 60-word clause inside paragraph one. Same four facts per axis —
 * name, value, verdict word and both thresholds — laid out so they can be compared
 * rather than parsed, plus a fifth the table used to assert wrongly in its subtitle:
 * where the band came from.
 */
function s4AxisCard(report) {
  const si = report.sizeInference || null;
  const axes = (si && si.axes) || [];
  if (!axes.length) return '';
  const rows = [];
  for (const a of axes) {
    const value = a.value;
    const unit = String(a.unit || '').trim();
    const shown = typeof value === 'number' ? s4Val(value) : String(value);
    const thresholds = Array.from(a.thresholds || [], (t) => s4Val(Number(t)));
    const word = s4AxisWord(a.score === undefined ? 1 : a.score);
    const bands = thresholds.length >= 2
      ? `small under ${thresholds[0]} · large over ${thresholds[1]}`
      : '—';
    rows.push([
      el('b', esc(S4_AXIS_PLAIN[String(a.id)] || String(a.name || '')))
        + el('span', esc(String(a.name || '')), {
          className: 'wa-caption-xs wa-color-text-quiet', style: 'display:block',
        }),
      el('span', esc(`${shown} ${unit}`.trim()), { className: 'wa-text-nowrap' }),
      chip(word, 'equals', { title: `${a.name} votes ${word}` }),
      // The band and, beneath it, whose band it is. Only axis A's is quoted from the
      // rulebook (`S4_AXIS_BASIS`); the reader has to be able to tell which cut points
      // they can look up and which are this generator's, because the verdict is the
      // median of all four votes, so an arguable band still moves it.
      el('span', esc(bands), {
        className: 'wa-caption-xs wa-color-text-quiet', style: 'display:block',
      }) + s4SourceTag(S4_AXIS_BASIS[String(a.id)] || 'interp'),
    ]);
  }
  return waCard(
    // Scrollable, like every other table on the page. This was the one bare `<table>`
    // in the document, and four columns — one of them a prose label, one a pair of
    // band thresholds — do not fit 360px, so at that width it was the page body that
    // scrolled sideways rather than the table. `waScroller` is `overflow-x: auto`: at
    // any width where the table already fits it changes nothing at all.
    dataTable(['What was measured', 'This map', 'Verdict', 'Bands'], rows),
    {
      headerHtml: s4CardHeader(
        `Why this is a ${cap((report.size || {}).name || (si && si.verdict) || '')} map`,
        'Each axis votes independently, and every band says whose it is: only the area '
        + "band is the rulebook's.",
      ),
      appearance: 'plain',
    },
  );
}

/** The section's own headline: the band, the size and the network shape. */
export function s4VerdictTitle(report) {
  const shape = String(((report.metrics || {}).networkShape) || '').split('-').join(' ');
  const size = cap((report.size || {}).name || '');
  const f = report.fitness || {};
  const band = (f.score !== null && f.score !== undefined) ? f.band : 'Partly measurable';
  if (shape && shape !== 'unknown') return `${band}: a ${shape} ${size} map`;
  return `${band}: a ${size} map`;
}

/**
 * §01 — three to five dropcap paragraphs, entirely template-filled.
 *
 * One paragraph for the size inference naming all four axes and flagging any
 * disagreement, one for the strongest sub-score with its two best metrics, one for
 * the weakest with its two worst and their mitigations, one for any cap that fired,
 * one for the day recommendation. **No free prose** — every sentence is a slot with
 * typed values, so no sentence can drift from the numbers.
 *
 * @param {Object} payload @returns {string}
 */
export function renderVerdict(payload) {
  const report = payload || {};
  const f = report.fitness;
  const size = report.size;
  if (!f || !size) return '';
  const si = report.sizeInference || { axes: [], verdict: size.name, note: '', unanimous: true, clamped: false };

  /** @type {Object<string, Object>} */
  const mit = {};
  for (const x of report.findings || []) {
    if (x.mitigation) mit[String(x.metricId)] = x;
  }

  // Paragraphs are markup, not text: two of them link a sub-score name into its own
  // score-trace item, so each entry is escaped as it is built.
  const paras = [];

  // 1 · the size inference. The four axes themselves are in the table above; this
  // paragraph keeps the unanimity clause, the clamp caveat and what the size means.
  let lead;
  if (size.inferred) {
    lead = `This map is a ${cap(si.verdict)} map. `
      + 'Four independent axes vote on that, and they are in the table above.';
    lead += ` ${si.note ? si.note : (si.unanimous ? 'All of them agree.' : 'They do not all agree.')}`;
    if (!si.unanimous) {
      lead += ' Where the axes disagree the vote resolves down, to the smaller and quieter '
        + 'game, and the disagreement is worth reading as a warning: a map that looks '
        + 'large by area and small by zone count will feel empty in play.';
    }
    if (si.clamped) {
      lead += ' The vote was clamped to within one band of the area axis, which is the '
        + 'axis the rulebook itself describes maps by.';
    }
  } else {
    lead = `The game size was set to ${String(size.name).toUpperCase()} on the command line, so the four `
      + 'inference axes in the table above are reported but not used.';
  }
  lead += ` A ${cap(size.name)} map means a ${num(size.hidingPeriodMin)}-minute hiding `
    + `period, ${s4Dist(report, size.zoneRadiusM, 2)} hiding zones, `
    + `${num(size.catalogueSize)} questions in the deck and `
    + `${num(size.photoLimitMin)} minutes to answer a photo question.`;
  paras.push(esc(lead));

  // 2 · the strongest sub-score
  const subs = (f.subscores || []).filter((s) => s.maxTenths > 0);
  const best = subs.length ? maxBy(subs, (s) => [s.earnedTenths / s.maxTenths, s.id]) : null;
  if (best) {
    const top = sortedBy(
      (best.metrics || []).filter((m) => m.available && m.maxTenths > 0),
      (m) => [-(m.pointsTenths / m.maxTenths), m.id],
    ).slice(0, 2);
    const detail = s4JoinWords(top.map(
      (m) => `${String(m.name).toLowerCase()} at ${s4MetricValue(m)} `
        + `(${s4Points(m.pointsTenths, m.maxTenths)} points)`,
    ));
    paras.push(join(
      esc("The map's strongest suit is "),
      el('a', esc(String(best.name).toLowerCase()), { href: `#trace-${best.id}`, className: 'wa-link' }),
      esc(`, which earns ${s4Points(best.earnedTenths, best.maxTenths)} points`
        + `${detail ? `: ${detail}.` : '.'} `
        + ((f.score !== null && f.score !== undefined)
          ? `Overall the map scores ${num(f.score, 1)} of 100, which the rating bands call `
            + `“${String(f.band).toLowerCase()}”.`
          : 'No overall score is printed, because too little of the map could be '
            + 'measured.')),
    ));
  }

  // 3 · the weakest sub-score and its mitigations
  if (subs.length) {
    const worst = minBy(subs, (s) => [s.earnedTenths / s.maxTenths, s.id]);
    const low = sortedBy(
      (worst.metrics || []).filter((m) => m.available && m.maxTenths > 0),
      (m) => [m.pointsTenths / m.maxTenths, m.id],
    ).slice(0, 2);
    if (worst.id !== best.id && low.length) {
      const detail = s4JoinWords(low.map(
        (m) => `${String(m.name).toLowerCase()} at ${s4MetricValue(m)} `
          + `(${s4Points(m.pointsTenths, m.maxTenths)} points)`,
      ));
      let tail = `, at ${s4Points(worst.earnedTenths, worst.maxTenths)}: ${detail}.`;
      const fixes = low.filter((m) => m.id in mit).map((m) => String(mit[m.id].mitigation));
      if (fixes.length) tail += ` ${fixes.join(' ')}`;
      paras.push(join(
        esc('What costs it points is '),
        el('a', esc(String(worst.name).toLowerCase()), { href: `#trace-${worst.id}`, className: 'wa-link' }),
        esc(tail),
      ));
    }
  }

  // 4 · caps and missing data
  if (f.cappedBy) {
    paras.push(esc(
      `One structural cap fired. The metrics add up to ${num(f.rawScore, 1)}, but `
      + `${f.cappedBy} holds the published score at `
      + `${(f.score !== null && f.score !== undefined) ? num(f.score, 1) : '—'} `
      + '— a cap can only ever lower a score, never raise one, and the score trace shows both '
      + 'numbers. Treat it as the map telling you which conversation to have before you play.',
    ));
  } else if (f.availablePoints < 100) {
    const names = new Set();
    for (const s of f.subscores || []) {
      if (s.partial || (s.missing && s.missing.length)) names.add(String(s.name).toLowerCase());
    }
    const missing = s4JoinWords(Array.from(names).sort(cmpStr));
    paras.push(esc(
      'Not everything could be measured: the score is computed from '
      + `${num(f.availablePoints, 1)} of 100 available points`
      + `${missing ? `, with ${missing} incomplete` : ''}. `
      + "If we can't measure it, it comes out of the total rather than being guessed at, so "
      + 'the number is honest about its own coverage.',
    ));
  } else {
    const borderline = (report.questions || []).filter((q) => q.borderline);
    if (borderline.length) {
      const subjects = Array.from(new Set(borderline.map((q) => q.label))).sort(s4NaturalCmp);
      const names = s4JoinWords(subjects.slice(0, 3));
      paras.push(esc(
        'Nothing capped the score, but the border did most of the work. '
        + `${num(borderline.length)} ${s4Plural(borderline.length, 'question')} about `
        + `${names}${subjects.length > 3 ? ' and others' : ''} would change verdict under a `
        + 'modestly larger map. Out-of-border features do not exist for this game, so agree '
        + 'the rectangle before anyone draws a card, and expect at least one player to hold '
        + 'up a phone showing one of those features just outside the line.',
      ));
    }
  }

  // 5 · the day recommendation
  const bestDay = s4BestDay(report);
  const worstDay = s4WorstDay(report);
  const per = f.perDay || {};
  if (worstDay && bestDay in per && worstDay in per) {
    paras.push(esc(
      `Play on a ${s4DayLabel(report, bestDay)}. The same map rates `
      + `${num(per[bestDay], 1)} on a ${s4DayLabel(report, bestDay)} and `
      + `${num(per[worstDay], 1)} on a ${s4DayLabel(report, worstDay)}, a swing of `
      + `${s4Signed(per[worstDay] - per[bestDay])} points, and every number on this page `
      + 'can be re-read for another day with the selector at the top.',
    ));
  } else {
    paras.push(esc(
      'This feed distinguishes only one kind of service day, so there is no better or worse '
      + 'day to play: every number on this page is measured on '
      + `${s4DayLabel(report, bestDay)} service.`,
    ));
  }

  const prose = el('div', paras.map((t) => el('p', t)).join(''), {
    className: 'dropcap wa-prose', style: '--wa-prose-line-length:72ch', id: 'verdict-prose',
  });
  return section('verdict', S4_ORDINAL, s4VerdictTitle(report),
    el('div', join(s4AxisCard(report), prose), { className: 'wa-stack wa-gap-l' }),
    { kicker: 'The verdict' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · §02 WHERE THE POINTS CAME FROM — the explainability anchor
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Where a threshold came from, in words, with its icon. The precise term —
 * `rulebook`, `feed`, `interpretation` — survives in the chip's `title` and in the
 * row's `data-basis`, which is what the interpretation styling keys on.
 *
 * @param {string} source @returns {string}
 */
export function s4SourceTag(source) {
  const [variant, word, icon, term] = S4_SOURCE_TAG[source]
    || ['neutral', source || '—', 'circle-question', source || ''];
  return chip(word, icon, { variant, title: term ? `basis: ${term}` : word });
}

/**
 * One sub-score's metrics: value, threshold, points, and where the rule came from.
 *
 * Each row carries `id="prov-<metric id>"`, which is what every provenance chip
 * elsewhere on the page links to. The table is never truncated and never "top N"-ed:
 * a dropped metric is printed with its reason for being dropped, because if a
 * threshold is wrong the reader must be able to see exactly which one and exactly
 * what it cost.
 *
 * @param {ReadonlyArray<Object>} metrics @returns {string}
 */
export function s4TraceTable(metrics) {
  const head = el('thead', el('tr', ['Metric', 'Value', 'Threshold', 'Points', 'Source']
    .map((h) => el('th', esc(h))).join('')));
  const rows = [];
  for (const m of metrics || []) {
    const cells = [
      el('td', el('b', esc(m.name)) + (m.note
        ? el('span', esc(m.note), {
          className: 'wa-caption-xs',
          style: 'display:block;color:var(--ink-3);max-width:62ch',
        })
        : '')),
      el('td', esc(m.available ? s4MetricValue(m) : 'not evaluated')),
      el('td', esc(s4RampText(m.ramp))),
      el('td', esc(m.available
        ? s4Points(m.pointsTenths, m.maxTenths)
        : `— / ${num(m.maxTenths / 10.0, 1)}`)),
      el('td', s4SourceTag(m.source)),
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
 * §02 — the explainability anchor: one accordion item per sub-score, each holding a
 * table of `metric · value · threshold · points earned / possible · where the rule
 * came from`. Interpretation rows are visually distinct and labelled in words. Every
 * provenance chip elsewhere on the page links into one of these rows.
 *
 * The bar and the earned/max ride in the accordion item's **label**, so the six
 * collapsed rows read as the whole scorecard while the tables stay one click down.
 *
 * @param {Object} payload @returns {string}
 */
export function renderScoreTrace(payload) {
  const report = payload || {};
  const f = report.fitness;
  if (!f || !f.subscores || f.subscores.length === 0) return '';

  const callouts = [];
  if (f.cappedBy) {
    callouts.push(waCallout(el('p', esc(
      `The metrics below add up to ${num(f.rawScore, 1)}, but ${f.cappedBy} caps the `
      + `published score at ${(f.score !== null && f.score !== undefined) ? num(f.score, 1) : '—'}. A cap can only `
      + 'lower a score. It fires on a structural fact about the map rather than on a '
      + 'threshold crossing, and it is the first thing to fix if you want a better game.',
    ), { className: 'wa-body-s' }), { variant: 'danger', icon: 'circle-exclamation' }));
  }
  if (f.availablePoints < 100) {
    callouts.push(waCallout(el('p', esc(
      `Only ${num(f.availablePoints, 1)} of the 100 points could be measured on this map. `
      + "If we can't measure it, it comes out of the total rather than being guessed at, and "
      + "the row below says 'not evaluated' rather than showing a number.",
    ), { className: 'wa-body-s' }), { variant: 'warning', icon: 'triangle-exclamation' }));
  }

  const items = [];
  for (const s of f.subscores) {
    const pctage = s.maxTenths ? (100.0 * s.earnedTenths) / s.maxTenths : 0.0;
    let summary = `${s.id} · ${s.name} — ${s4Points(s.earnedTenths, s.maxTenths)} points`;
    let partial = '';
    if (s.partial) {
      let nHave = 0;
      for (const m of s.metrics || []) if (m.available) nHave += 1;
      partial = `partial: ${num(nHave)} of ${num((s.metrics || []).length)} metrics`;
      summary += ` (${partial})`;
    }
    const label = join(
      el('span', join(
        el('strong', esc(`${s.id} · ${s.name}`), { className: 'wa-body-s' }),
        partial ? el('span', esc(partial), { className: 'wa-caption-xs wa-color-text-quiet' }) : '',
      ), { className: 'wa-cluster wa-gap-s wa-align-items-center' }),
      el('span', join(
        waProgressBar(pctage, { label: summary, style: 'width:8rem' }),
        el('span', esc(s4Points(s.earnedTenths, s.maxTenths)), {
          className: 'wa-caption-s wa-color-text-quiet',
        }),
      ), { className: 'wa-cluster wa-gap-s wa-align-items-center' }),
    );
    const bodyHtml = el('div', join(
      (s.missing && s.missing.length)
        ? el('p', esc(`Metrics missing from this block: ${s4JoinWords(Array.from(s.missing).sort(cmpStr))}.`), {
          className: 'wa-body-s wa-color-text-quiet',
        })
        : '',
      s4TraceTable(s.metrics),
    ), { className: 'wa-stack wa-gap-s' });
    items.push([`trace-${s.id}`, label, bodyHtml, s.id === f.subscores[0].id]);
  }

  const rampLegend = waCallout(el('p', join(
    el('b', esc('How to read the threshold column.')),
    esc(' “none at 0.35, full at 0.85” means you earn zero points at 0.35, all of them at '
      + '0.85, and a straight line in between.'),
  ), { className: 'wa-body-s' }), {
    variant: 'neutral', appearance: 'plain', icon: 'circle-info',
  });

  let budget = '';
  if (f.score !== null && f.score !== undefined) {
    budget = el('div', join(
      // `height`, not `style`: style would replace the helper's whole style string and
      // drop `aspect-ratio:auto`. 1rem, not .85rem — the 1px seam per edge costs 2px of
      // fill, so 1rem lands on the same painted height .85rem used to give.
      s4PointsBudget(report, { height: '1rem' }),
      el('p', esc('The same 100 points as the scorecard: one block per sub-score, the grey '
        + 'tail is what was not earned.'), { className: 'wa-caption-xs wa-color-text-quiet' }),
    ), { className: 'wa-stack wa-gap-3xs' });
  }

  const lede = 'Every point on the dial comes from one of these rows. A row names the metric, the '
    + 'value measured on this feed, the shaping function that turned it into points, and '
    + "whether the threshold is the rulebook's, the feed's own, or this generator's "
    + 'interpretation. Our-call rows carry a gold rule and are never presented as rules. '
    + 'Arithmetic is in integer tenths of a point throughout, so the sub-scores and the '
    + 'total are exact sums rather than accumulated floats.';
  let answer = '';
  const subs = f.subscores.filter((s) => s.maxTenths > 0);
  if (f.score !== null && f.score !== undefined && subs.length) {
    const worst = minBy(subs, (s) => [s.earnedTenths / s.maxTenths, s.id]);
    const lost = (worst.maxTenths - worst.earnedTenths) / 10.0;
    answer = el('p', esc(
      `${num(f.score, 1)} out of 100. The biggest single loss is ${String(worst.name).toLowerCase()}, `
      + `at ${num(lost, 1)} points.`,
    ), { className: 'wa-body-s' });
  }
  const body = el('div', join(
    callouts.join(''),
    budget,
    rampLegend,
    waAccordion(items, { mode: 'single-collapsible', headingLevel: '3' }),
  ), { className: 'wa-stack wa-gap-m', id: 'prov-trace' });
  return section('trace', S4_ORDINAL, 'Where the points came from', body, {
    kicker: 'Every point, traced', lede, answerHtml: answer,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · §03 WHAT THIS MEANS FOR YOUR GAME — house rules and findings, one section
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * §03's second half — the four findings quadrants as colour-utility `wa-card`s.
 *
 * Three fixes over the old §08. The card's **heading is the finding's sentence**,
 * with its machine-built title demoted to the caption above it, because ten of these
 * cards used to be titled "<metric name> is a strength here". The severity badge's
 * variant follows the quadrant's tone, so a major *plus* is not painted as an alarm.
 * And a day-sensitive card gets the `[data-today]` outline when the selected day is
 * the one that bites.
 */
function s4FindingsHalf(report) {
  const findings = report.findings || [];
  if (!findings.length) return '';
  const blocks = [];
  for (const [quadrant, title, colour, tint, icon] of S4_QUADRANTS) {
    const items = findings.filter((x) => x.quadrant === quadrant);
    if (!items.length) continue;
    const variant = tint.startsWith('wa-') ? tint.slice(3) : tint;
    const cards = [];
    for (const item of items) {
      const severity = String(item.severity || '');
      const [word, sevIcon] = S4_SEVERITY[severity] || [severity, 'circle-info'];
      let badge = severity
        ? chip(word, sevIcon, {
          variant, appearance: 'outlined', title: `severity: ${severity}`,
        })
        : '';
      // A day-sensitive card used to say so in colour only — a red outline the
      // accessibility tree never sees. Both chips are always in the markup and one
      // CSS rule swaps them, so the card itself carries the word.
      const dayKey = typeof item.daySensitive === 'string' ? item.daySensitive : '';
      if (dayKey) {
        const dayLabel = s4DayLabel(report, dayKey);
        badge = join(
          chip(`only on ${dayLabel}`, 'calendar-day', { dataTodayCue: 'off' }),
          chip('applies to your day', 'calendar-day', {
            variant: 'danger', appearance: 'filled', dataTodayCue: 'on',
          }),
          badge,
        );
      }
      const metricId = String(item.metricId || '');
      const header = el('div', join(
        el('span', esc(String(item.title || '')) + (metricId ? provChip(metricId) : ''), {
          className: 'wa-caption-xs wa-text-uppercase wa-color-text-quiet',
        }),
        el('span', badge, { className: 'wa-cluster wa-gap-2xs wa-align-items-center' }),
      ), { className: 'wa-split wa-align-items-center wa-gap-s' });
      let footer = '';
      if (item.mitigation) {
        footer = el('div', join(
          el('b', esc('What to do'), {
            className: 'wa-caption-xs wa-text-uppercase', style: 'color:var(--good-text)',
          }),
          esc(` · ${String(item.mitigation)}`),
        ), { className: 'wa-body-s' });
      }
      cards.push(waCard(
        el('h4', esc(String(item.detail || '')), { className: 'wa-heading-xs wa-text-pretty' }),
        { headerHtml: header, footerHtml: footer, className: tint, dataDay: dayKey || null },
      ));
    }
    blocks.push(el('div', join(
      el('h4', s4Swatch(`background:${colour}`) + waIcon(icon) + esc(title), {
        className: 'wa-heading-s wa-color-text-quiet wa-cluster wa-gap-s wa-align-items-center',
      }),
      el('div', cards.join(''), { className: 'wa-grid wa-gap-m', style: '--min-column-size:300px' }),
    ), { className: 'wa-stack wa-gap-s' }));
  }

  const lede = 'Nothing here is written by hand: a card appears when a scored metric crosses a '
    + 'threshold — under 35% of its possible points becomes a minus (or a concern when there '
    + 'is a known mitigation), over 85% becomes a plus. A card that only bites on one '
    + 'service day says which day, and says “applies to your day” when that is the day '
    + 'you picked above.';
  return el('div', join(
    subhead('What works, what fights you', { anchorId: 'findings' }),
    el('p', esc(lede), {
      className: 'wa-body-s wa-color-text-quiet', style: 'max-inline-size:72ch',
    }),
    el('div', blocks.join(''), { className: 'wa-stack wa-gap-xl', id: 'findings-body' }),
  ), { className: 'wa-stack wa-gap-s' });
}

/**
 * §03's first half — the fired house rules as an `ol.recs`, in priority order.
 *
 * The whole checklist is also one `wa-copy-button` away as plain text, because the
 * artefact a group actually takes to the game is a list they can paste into a chat.
 */
function s4HouseRulesHalf(report) {
  const recs = report.recommendations || [];
  if (!recs.length) return '';
  const items = [];
  for (const rec of recs) {
    const tags = [];
    if (rec.required) {
      // amber, not red: red on this page already means "take it out of the deck"
      // and "this question is dead", and a third meaning would be a bug.
      tags.push(chip('everyone must agree', 'circle-exclamation', { variant: 'warning' }));
    }
    if (rec.evidence) {
      tags.push(chip('why?', 'circle-question', { title: String(rec.evidence) }));
    }
    const card = waCard(el('div', join(
      el('span', esc(String(rec.text || '')), { className: 'wa-body-m' }),
      tags.length ? el('div', tags.join(''), { className: 'wa-cluster wa-gap-2xs' }) : '',
    ), { className: 'wa-stack wa-gap-2xs' }));
    items.push(el('li', card));
  }
  const lede = `${num(recs.length)} house rules fired for this map, in the order they `
    + 'matter. Each one has a predicate over the numbers above; rules whose precondition is '
    + 'false are not printed at all. The last one always fires, because the rulebook demands '
    + 'that conversation and explicitly refuses to automate it.';
  const checklist = recs.map(
    (rec, i) => `${num(i + 1)}. ${rec.text || ''}${rec.required ? ' (everyone must agree)' : ''}`,
  ).join('\n');
  return el('div', join(
    el('div', join(
      subhead('House rules to agree before you start', { anchorId: 'recs' }),
      waCopyButton(checklist, { label: 'Copy the checklist', id: 'reccopy' }),
    ), { className: 'wa-split wa-align-items-center wa-gap-s' }),
    el('p', esc(lede), {
      className: 'wa-body-s wa-color-text-quiet', style: 'max-inline-size:72ch',
    }),
    el('ol', items.join(''), { className: 'recs', id: 'recs-list', style: 'max-width:78ch' }),
  ), { className: 'wa-stack wa-gap-s' });
}

/**
 * §03 — the two things a group actually acts on: what to agree, and what to expect.
 *
 * Either half may be empty; the section renders if either survives, and when only one
 * does it takes that half's own title. `#recs` and `#findings` stop being sections and
 * become `<h3 id>` destinations inside this one, so every inbound link and every nav
 * entry still resolves.
 *
 * The rules the rulebook is silent on stay labelled as interpretations rather than
 * asserted as rules, each house rule cites its rule in the `why?` chip, and the
 * closing sentiment of the whole report is that the group is the final authority.
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

  /** @type {Object<string, number>} */
  const quads = {};
  for (const x of report.findings || []) {
    const k = String(x.quadrant || '');
    quads[k] = (quads[k] || 0) + 1;
  }
  const recs = report.recommendations || [];
  let required = 0;
  for (const r of recs) if (r.required) required += 1;
  const nRules = recs.length;
  const answer = el('p', esc(
    `${num((quads.plus || 0) + (quads.benefit || 0))} things this map does well, `
    + `${num((quads.minus || 0) + (quads.concern || 0))} that fight you, and ${num(nRules)} house `
    + `${s4Plural(nRules, 'rule')} — ${num(required)} of them your group has to agree on.`,
  ), { className: 'wa-body-s' });
  const body = el('div', join(rules, findings), { className: 'wa-stack wa-gap-2xl' });
  return section('yourgame', S4_ORDINAL, title, body, {
    kicker: 'Before you play', answerHtml: answer,
  });
}
