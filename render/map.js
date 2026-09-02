/**
 * render/map.js — the map section (map plus `#glance` stat rail) and §06 Getting Around.
 *
 * Ported from generate.py S4: `index_key_numbers`, `index_network_map`,
 * `index_transit_reality` and their `_s4_*` helpers. Shared formatting and day-view
 * helpers live in `./verdict.js`, so there is one implementation of each.
 *
 * PROGRESSIVE HYDRATION. The browser's `Report` grows as worker stages land; every
 * renderer degrades on a partial one and returns `''` when it has nothing to show,
 * so app.js can drop the section and its nav entry.
 *
 * FORMATTING. Every number goes through one formatter from `../lib/core.js`: no
 * `toFixed`, no `Intl`, no arithmetic inside a template literal.
 *
 * DETERMINISM. No clock, no randomness, no unsorted iteration over object keys.
 *
 * The stat rail is a plain `#glance` div INSIDE the map section, mounted through its
 * own nested `data-section="glance"` host with its own hydration clock (app.js
 * `SECTIONS`). They cannot share one: §05's string must not move at `rules` or
 * `score`, because a changed string re-mounts the section and tears down the MapLibre
 * instance, and the tiles move at both. `#tiles` keeps its id because `renderDay()`
 * rewrites that container's innerHTML on every day switch.
 *
 * @module render/map
 */

import {
  cmpStr, num, pct, mins, hhmm, prettyDate, quantile, jdump,
} from '../lib/core.js';

import {
  esc, el, join, waCard, waScroller, waDetails, waSwitch, waCopyButton, waButton,
  waCallout, chip, kpi, section, subhead, provChip,
} from './html.js';

import {
  S4_ORDINAL, fnum,
  s4Dist, s4Area, s4Plural, s4JoinWords,
  s4Swatch, s4CardHeader,
  s4DayView, s4DayOrder, s4DayLabel, s4BestDay, s4LiveQuestions,
} from './verdict.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Presentation constants (generate.py)
// ═══════════════════════════════════════════════════════════════════════════════

/** The rail's three tile groups; `s4Tiles` tags every tile with a `g` key. */
const S4_TILE_GROUPS = Object.freeze([
  Object.freeze(['map', 'The map']),
  Object.freeze(['clock', 'The clock']),
  Object.freeze(['deck', 'The deck']),
]);

/**
 * The two placeholder tiles the deck group shows before the `rules` stage lands.
 * Widths are literals so the markup stays byte-stable.
 */
const S4_DECK_SKELETON_WIDTHS = Object.freeze([
  Object.freeze(['82%', '70%']),
  Object.freeze(['60%', '84%']),
]);

/**
 * Headway heatmap bins in minutes. The middle element is the cell's `data-hb` value;
 * `[data-hb='N']` styles both the grid cell and the `.sw` legend key.
 *
 * Exported because the map's frequency layer bins per-stop headways on the same
 * thresholds: app.js ships them into `#data` as `game.headway_bins_min` so the map
 * and the grid can never bin at different edges.
 */
export const S4_HEADWAY_BINS = Object.freeze([
  Object.freeze([10.0, '1', '≤10 min']),
  Object.freeze([15.0, '2', '≤15']),
  Object.freeze([25.0, '3', '≤25']),
  Object.freeze([35.0, '4', '≤35']),
  Object.freeze([50.0, '5', '≤50']),
  Object.freeze([Infinity, '6', 'over 50']),
]);

// Degradation thresholds from pages.md §5, named so the caption can quote them.
/** Above this the map draws zone centres only. (`_S4_MAX_MAP_STOPS`.) */
const S4_MAX_MAP_STOPS = 5000;
/** Above this the zone circles become dots only. (`_S4_MAX_MAP_ZONE_RINGS`.) */
const S4_MAX_MAP_ZONE_RINGS = 1200;
/** Above this the map caption prints the unreachable-zone count instead of names. */
const S4_MAX_NAMED_ZONES = 6;

/** Above this the heatmap grid shows the busiest 25 and drawers the rest. */
const S4_MAX_HEATMAP_ROUTES = 25;
/** Below this the heatmap becomes one sentence. */
const S4_MIN_HEATMAP_ROUTES = 3;

// ═══════════════════════════════════════════════════════════════════════════════
// Small local helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * `len(report.feed.routes)`. `feed.routes` only crosses `postMessage` at `'done'`,
 * so before then the count comes from the `'feed'` stage's scalar.
 */
function feedRouteCount(report) {
  const routes = (report.feed && report.feed.routes) || {};
  const n = Object.keys(routes).length;
  if (n) return n;
  return Number((report.feedCounts || {}).routes || 0);
}

/**
 * The number of stops with service on `day`. A `DaySummary` carries the count, not
 * the id list (CONTRACT §(d)); the `StopRow[]` map layer is the same set and the fallback.
 */
function servedStopCount(report, day) {
  const n = day ? fnum(day.servedStops) : null;
  if (n !== null) return n;
  return ((report && report.stops) || []).length;
}

/**
 * The worker's `SuggestedBorder`, or null for anything that is not the shape
 * CONTRACT §(b) describes. Null renders nothing, so a partial object degrades to the
 * page as it was rather than to a half-filled sentence.
 *
 * @param {Object} report
 * @returns {Object|null}
 */
function s4SuggestedBorder(report) {
  const sb = report && report.suggestedBorder;
  if (!sb || typeof sb !== 'object') return null;
  const bbox = sb.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((x) => Number.isFinite(x))) {
    return null;
  }
  if (!sb.vote || typeof sb.vote !== 'object') return null;
  return sb;
}

/**
 * `S, W, N, E` — the suggested rectangle as the one line the landing frame's fields
 * accept, in the same digits the Exact coordinates table prints.
 *
 * @param {number[]} bbox `[S, W, N, E]`
 * @returns {string}
 */
function s4BboxLine(bbox) {
  return bbox.map((x) => num(x, 6, { comma: false })).join(', ');
}

/**
 * `#border-suggest` — the worker found a tighter border and this is the offer:
 * measurement, consequence, what is left out, then two actions. Copy the four
 * numbers, and `#suggest-rerun`, which app.js wires (CONTRACT §05). The re-run is a
 * fresh document load replaying the sources from the feed cache, so it needs every
 * source addressable by URL: a chosen `File` cannot survive a reload, and the button
 * says so instead of failing later.
 *
 * Every figure is the worker's; the renderer never derives one from another.
 *
 * @param {Object} report
 * @param {Object|null} suggested the already-validated `SuggestedBorder`, or null
 * @returns {string} HTML, or '' when there is nothing to offer
 */
function s4SuggestCallout(report, suggested) {
  const sb = suggested;
  if (!sb) return '';
  const size = report.size || {};
  const vote = sb.vote || {};
  const startName = startStopName(report);
  const dayLabel = s4DayLabel(report, sb.dayKey);
  const byFeed = Array.isArray(sb.trimmedByFeed) ? sb.trimmedByFeed : [];
  // "mostly X (n)" only informs when there is more than one feed to attribute to.
  const mostly = byFeed.length > 1 && byFeed[0]
    ? ` — mostly ${byFeed[0].agencyName} (${num(byFeed[0].count)})`
    : '';
  // Upper-cased like every other size name on the page (the rulebook's spelling).
  const suggestWord = String(sb.sizeName || '').toUpperCase();
  const currentWord = String(size.name || '').toUpperCase();
  // A core voting the run's OWN size is legitimate (`suggestBorder` only offers a box
  // at least `SUGGEST_MIN_TRIM_SHARE` tighter), but "a MEDIUM game rather than
  // MEDIUM" reads as a fault, so the same-size case gets its own half-sentence.
  const measured = `Measured on those stops alone this is `
    + `${suggestWord === currentWord ? 'still a' : 'a'} ${suggestWord} game `
    + `(${s4Area(report, Number(vote.hullSqM || 0))}, ${num(vote.nZones || 0)} zones, `
    + `T90 ${mins(Number(vote.t90Min || 0))})`;
  const versus = suggestWord === currentWord
    ? ', on the reachable core rather than on the whole network. '
    : ` rather than ${currentWord || 'the size measured on the whole feed'}. `;
  const sentence = `Within ${num(sb.hidingPeriodMin || 0)} minutes of ${startName} on a `
    + `${dayLabel} the network keeps ${num(sb.coreStops || 0)} of `
    + `${num(sb.allServedStops || 0)} stops carrying ${pct(Number(sb.eventShare || 0), 0)} `
    + 'of the day\u2019s departures. '
    + measured + versus
    + `${num(sb.trimmedStops || 0)} stops lie outside${mostly}.`;

  const kinds = Array.isArray(report.sourceKinds) ? report.sourceKinds : [];
  const hasFile = kinds.includes('file');
  const line = s4BboxLine(sb.bbox);
  const actions = el('div', join(
    waCopyButton(line, {
      label: 'Copy suggested border', id: 'suggestcopy',
      trigger: waButton('Copy suggested border'),
    }),
    waButton('Re-run with this border', {
      id: 'suggest-rerun', type: 'button', variant: 'brand', appearance: 'filled',
      disabled: hasFile,
    }),
  ), { className: 'wa-cluster wa-gap-s wa-align-items-center' });
  // `#suggest-note` ships with the file sentence, or empty; app.js writes into it when
  // the handoff cannot be stored (the clipboard fallback), and `:empty` hides it.
  // `role="status"` announces that write; `tabindex="-1"` lets app.js focus it, so a
  // keyboard reader lands on the explanation instead of on an inert-looking button.
  const note = el('p', hasFile
    ? esc('Re-running needs feeds picked by URL \u2014 a file you chose cannot survive a reload. '
      + 'Copy the border and set it in the landing frame\u2019s fields instead.')
    : '', {
    id: 'suggest-note', role: 'status', tabindex: '-1',
    className: 'wa-caption-s wa-color-text-quiet',
  });

  return waCallout(join(
    el('p', esc('A tighter border is on offer.'), { className: 'wa-heading-s' }),
    el('p', esc(sentence), { className: 'wa-body-s' }),
    el('p', esc(`Suggested box: ${line} (south, west, north, east).`),
      { className: 'wa-caption-s wa-color-text-quiet' }),
    actions,
    note,
  ), { id: 'border-suggest', variant: 'brand', icon: 'compress' });
}

function startStopName(report) {
  const hub = report.hub || {};
  const startId = (report.opts && report.opts.startStopId) || hub.stopId || '';
  if (startId) {
    const stop = ((report.feed && report.feed.stops) || {})[startId];
    if (stop && stop.name) return stop.name;
    for (const row of (report.stops || [])) {
      if (row.stopId === startId && row.name) return row.name;
    }
  }
  return hub.name || '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · SHARED MARKUP HELPERS (generate.py)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A `wa-cluster` of `.sw` swatches — the map legend, as a real `<ul>`.
 *
 * CAVEAT: the `<ul>`'s `native.css` block margin is zeroed only because
 * `wa-cluster`/`wa-split` parents reset child margins; an unclassed parent brings it back.
 * @param {ReadonlyArray<[string,string]>} items `[swatchHtml, plainText]`
 * @returns {string}
 */
export function s4Legend(items) {
  return el('ul', Array.from(items, ([swatchHtml, text]) => el(
    'li',
    swatchHtml + esc(text),
    { className: 'wa-cluster wa-gap-2xs' },
  )).join(''), { className: 'wa-cluster wa-gap-m wa-caption-xs wa-list-plain' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · PER-DAY VIEWS (generate.py)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The `DaySummary` (CONTRACT §(d)) for one key, or `null`. (`_s4_day_by_key`.)
 *
 * @param {Object} report @param {string} dayKey @returns {Object|null}
 */
export function s4DayByKey(report, dayKey) {
  for (const d of (report && report.days) || []) {
    if ((d.dayType || {}).key === dayKey) return d;
  }
  return null;
}

/**
 * The twelve stat tiles for one service day (pages.md §3.3). Seven move with the
 * day; the other five are map-wide or rulebook constants.
 *
 * `hl` is the `data-hl` the runtime binds tile↔map highlighting to, and is set only
 * on tiles that name a fact the map can point at.
 *
 * @param {Object} report @param {string} dayKey
 * @returns {Array<{g:string,day:string,prov:string,v:string,l:string,n:string,hl?:string}>}
 */
export function s4Tiles(report, dayKey) {
  const v = s4DayView(report, dayKey);
  const size = report.size || {};
  const label = s4DayLabel(report, dayKey);
  const nTotalRoutes = feedRouteCount(report);
  const questions = report.questions || [];
  const curses = report.curses || [];
  const catalogue = questions.length;
  const live = s4LiveQuestions(report);
  const removed = curses.filter((c) => c.action === 'remove').length;
  const radius = s4Dist(report, size.zoneRadiusM || 0, 2);
  const border = report.border || {};

  /** `v.get(key, default)` — Python's `None` and JS's `undefined` both mean absent. */
  const g = (key, dflt = null) => {
    const got = v[key];
    return (got === null || got === undefined) ? dflt : got;
  };

  const spanH = Number(g('spanHours', 0.0));
  const firstS = Math.trunc(Number(g('firstDepartureS', 0)));
  const lastS = Math.trunc(Number(g('lastDepartureS', 0)));
  const medLast = Math.trunc(Number(g('medianLastDepartureS', lastS)));
  const worstGap = g('medianWorstGapMin');
  const served = Math.trunc(Number(g('servedStops', 0)));
  const inFeed = Math.trunc(Number(g('stopsInFeed', served)));
  const reachN = Math.trunc(Number(g('reachWithinHidingPeriod', 0)));
  const reachShare = Number(g('reachableZoneShare', 0.0));
  const freqShare = Number(g('frequentShare', 0.0));
  const freqStops = Math.trunc(Number(g('frequentStops', 0)));
  const headway = g('medianHeadwayMin');
  const hull = Number(g('hullSqM', 0.0));
  const diameter = Number(g('diameterM', 0.0));
  const mec = g('mec', [0, 0, 0]) || [0, 0, 0];
  const nZones = Math.trunc(Number(g('nZones', (report.zones || []).length)));
  const reach = s4ReachDay(report, dayKey);
  const startName = startStopName(report);
  const asOf = (report.provenance || {}).asOf || '';
  const repDate = String(g('date', asOf) || '') || '20000101';
  const departure = String((report.opts || {}).departure || '').slice(0, 5);
  const sizeWord = String(size.name || '').toUpperCase();

  const dead = questions.filter(
    (q) => q.status === 'dead' || q.status === 'degenerate',
  ).length;
  const warned = curses.filter((c) => c.action === 'warn').length;
  const talked = curses.filter((c) => c.action === 'player-choice').length;

  return [
    {
      g: 'map',
      day: '1',
      prov: 'A1',
      hl: 'zones',
      v: num(nZones),
      l: 'Distinct hiding zones',
      n: `One zone per ${radius} circle — a cover of the ${num(served)} stops with `
        + `service on a ${label}.`,
    },
    {
      g: 'map',
      day: '1',
      prov: 'feed',
      hl: 'stops',
      v: `${num(served)} / ${num(inFeed)}`,
      l: 'Stops served / in the feed',
      n: `${num(inFeed - served)} stops in the feed see no departure on a ${label}.`,
    },
    {
      g: 'map',
      day: '1',
      prov: 'feed',
      v: `${num(g('routes', 0))} of ${num(nTotalRoutes)}`,
      l: 'Routes running',
      n: `Route patterns with at least one trip on the representative ${label}, `
        + `${prettyDate(repDate)}.`,
    },
    {
      g: 'map',
      day: '',
      prov: 'feed',
      hl: 'extent',
      v: s4Area(report, hull),
      l: 'Map area',
      n: 'The area the buses actually cover — the convex hull of the served stops. '
        + 'The printed border box is '
        + `${s4Area(report, Number(border.areaSqM || 0))}, because a rectangle is what `
        + 'players can agree on.',
    },
    {
      g: 'map',
      day: '',
      prov: 'feed',
      hl: 'extent',
      v: s4Dist(report, diameter, 1),
      l: 'Network diameter',
      n: 'The longest straight line between two served stops. The smallest circle '
        + 'that holds the whole network has a radius of '
        + `${s4Dist(report, Number(mec[2] || 0), 1)}.`,
    },
    {
      g: 'clock',
      day: '1',
      prov: 'D1',
      v: `${hhmm(firstS)}–${hhmm(lastS)}`,
      l: 'Service window',
      n: `${num(spanH, 1)} hours end to end. The median stop's last departure is `
        + `${hhmm(medLast)}, which is the number that ends your game.`,
    },
    {
      g: 'clock',
      day: '1',
      prov: 'C1',
      v: headway !== null && headway !== undefined ? mins(headway) : '—',
      l: 'Median headway per stop',
      n: (worstGap !== null && worstGap !== undefined)
        ? "All routes combined, 06:00–22:00. The median stop's worst gap of the day is "
          + `${mins(worstGap)}.`
        : 'All routes combined, 06:00–22:00.',
    },
    {
      g: 'clock',
      day: '1',
      prov: 'C3',
      hl: 'frequency',
      v: pct(freqShare),
      l: 'Stops on a 15-minute route',
      n: `${num(freqStops)} stops where one single route-direction runs every `
        + '15 minutes or better.',
    },
    {
      g: 'clock',
      day: '',
      prov: 'rulebook',
      v: `${num(size.hidingPeriodMin || 0)} min`,
      l: 'Hiding period',
      n: `${sizeWord} game: ${radius} hiding zones, `
        + `${num(size.catalogueSize || 0)} questions in the deck, `
        + `${num(size.photoLimitMin || 0)} minutes to answer a photo.`,
    },
    {
      g: 'clock',
      day: '1',
      prov: 'A2',
      hl: 'reach',
      v: pct(reachShare),
      // The value is a share of ZONES, so the note counts zones too, from the
      // worker-computed `reachableZones`; the stop figure stays as the looser test.
      l: 'Zones reachable in the hiding period',
      n: (reach === null
        ? `${num(reachN)} of ${num(served)} served stops are within `
          + `${num(size.hidingPeriodMin || 0)} minutes of the start location at `
          + `${departure}.`
        : `${num(reach.reachableZones)} of ${num(nZones)} zones are within `
          + `${num(size.hidingPeriodMin || 0)} minutes of ${startName} at ${departure} `
          + `on a ${label} — the ${num(reach.unreachableZoneIds.length)} that are not are `
          + "red on the map's reach layer, hollow where there is no journey at all. "
          + `(${num(reachN)} of ${num(served)} served stops are, a looser test.)`),
    },
    {
      g: 'deck',
      day: '',
      prov: 'B1',
      v: `${num(live)} of ${num(catalogue)}`,
      l: 'Questions that work here',
      n: `Functional plus weak, out of the ${sizeWord} catalogue. `
        + `${num(dead)} return a fixed or null answer and should be pre-briefed.`,
    },
    {
      g: 'deck',
      day: '',
      prov: 'curses',
      v: `${num(removed)} of ${num(curses.length)}`,
      l: 'Curses to take out of the deck',
      n: `${num(warned)} more are weakened but stay in the deck, and `
        + `${num(talked)} are a conversation to have rather than a measurement to take.`,
    },
  ];
}

/**
 * The tile grid's inner markup for one day, in its three labelled groups. Grouping
 * happens here, not around `#tiles`, because `renderDay()` replaces that container's
 * `innerHTML` wholesale.
 *
 * The deck group's tiles count questions and curses, which do not exist until the
 * `rules` stage; they are skeletons until then, so the rail neither prints "0 of 0"
 * nor changes height when the audit arrives.
 *
 * @param {Object} report @param {string} dayKey @returns {string}
 */
export function s4TilesHtml(report, dayKey) {
  const tiles = s4Tiles(report, dayKey);
  const dayChip = chip('changes by day', 'calendar-day', {
    title: 'Measured on the selected service day',
  });
  const pending = !(report.questions || []).length;
  const groups = [];
  for (const [key, title] of S4_TILE_GROUPS) {
    const cards = (key === 'deck' && pending)
      ? S4_DECK_SKELETON_WIDTHS.map(([a, b]) => el('div', join(
        el('wa-skeleton'),
        el('wa-skeleton', '', { style: `inline-size:${a}` }),
        el('wa-skeleton', '', { style: `inline-size:${b}` }),
      ), { className: 'sk-tile' }))
      : tiles.filter((t) => t.g === key).map((t) => waCard(
        kpi(t.v, t.l, esc(t.n) + provChip(t.prov), { chipHtml: t.day ? dayChip : '' }),
        { dataDaySensitive: t.day ? true : null, dataHl: t.hl || null },
      ));
    if (!cards.length) continue;
    groups.push(el('div', join(
      subhead(title),
      el('div', cards.join(''), {
        className: 'wa-grid wa-gap-s',
        style: '--min-column-size:230px',
      }),
    ), { className: 'wa-stack wa-gap-xs' }));
  }
  return join(...groups);
}

/**
 * A deterministic x-axis maximum for the ride-time chart: the larger of 1.25 × the
 * hiding period and the p90 of every sampled time on every day, rounded up to a
 * multiple of 15, so the hiding-period line is always on the canvas and one outlier
 * cannot squash every other bar. Bars past it are clipped and annotated.
 *
 * @param {Object} report @returns {number}
 */
export function s4ChartMax(report) {
  const values = [];
  for (const s of report.travelSamples || []) {
    const per = s.perDay || {};
    for (const key of Object.keys(per).sort(cmpStr)) {
      const p = per[key];
      if (p && p.minutes !== null && p.minutes !== undefined) values.push(Number(p.minutes));
    }
  }
  const floorV = Number((report.size || {}).hidingPeriodMin || 0) * 1.25;
  const top = Math.max(floorV, values.length ? quantile(values, 0.90) : 0.0);
  return Math.max(15, Math.ceil(top / 15.0) * 15);
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · AT A GLANCE — the stat rail, inside the map section (generate.py)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The twelve stat tiles in three groups, as a plain `<div id="glance">` (no
 * `section()`, no `data-n`). app.js mounts it through its nested
 * `data-section="glance"` host inside §05 and stamps `data-section` / `data-state`
 * onto this root.
 *
 * The gate is why the rail's `needs` is `network`, not `rules`: `size`, `metrics`
 * and `days` all land at the `network` stage.
 *
 * @param {Object} payload the (possibly partial) `Report`
 * @returns {string} HTML, or '' when there is nothing to show yet
 */
export function renderGlanceRail(payload) {
  const report = payload || {};
  if (!report.size || !report.metrics || !report.days || !report.days.length) return '';
  const best = s4BestDay(report);
  const grid = el('div', s4TilesHtml(report, best), {
    className: 'wa-stack wa-gap-l',
    id: 'tiles',
  });
  const caption = 'Measured on the service day selected above, on the map you are '
    + 'looking at. Tiles with a gold rule and a “changes by day” chip move when you '
    + 'change the day; the rest are map-wide or come straight from the rulebook. '
    + 'Where a tile names a place, hovering it lights that place on the map above — '
    + 'or focus it and press Enter to pin it there.';
  return el('div', join(
    subhead('At a glance'),
    el('p', esc(caption), {
      className: 'wa-body-s wa-color-text-quiet', style: 'max-inline-size:72ch',
    }),
    grid,
  ), { id: 'glance', className: 'wa-stack wa-gap-s' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · §06 GETTING AROUND (generate.py)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * `[data-hb value, legend label]` for one headway in minutes.
 * @param {number} value @returns {[string,string]}
 */
export function s4HeadwayBin(value) {
  for (const [limit, binId, label] of S4_HEADWAY_BINS) {
    if (value <= limit) return [binId, label];
  }
  const last = S4_HEADWAY_BINS[S4_HEADWAY_BINS.length - 1];
  return [last[1], last[2]];
}

/**
 * Every route-direction, busiest first on the opening day. No truncation.
 * @param {Object} report @returns {Object[]}
 */
export function s4HeatmapRows(report) {
  const best = s4BestDay(report);
  const rows = Array.from(report.routeHeadways || []);
  // Python key: (-trips[best], short_name, route_id, -1 if direction_id is None else it)
  const key = (h) => [
    -Number((h.trips || {})[best] || 0),
    String(h.shortName || ''),
    String(h.routeId || ''),
    (h.directionId === null || h.directionId === undefined) ? -1 : Number(h.directionId),
  ];
  rows.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    const s1 = cmpStr(ka[1], kb[1]);
    if (s1 !== 0) return s1;
    const s2 = cmpStr(ka[2], kb[2]);
    if (s2 !== 0) return s2;
    return ka[3] - kb[3];
  });
  return rows;
}

/**
 * `table.hw` — routes × day types, binned, hatched where a route does not run.
 * @param {Object} report @param {ReadonlyArray<Object>} rows @param {string} tableId
 * @returns {string}
 */
export function s4HeatmapTable(report, rows, tableId) {
  const days = s4DayOrder(report);
  const head = el('tr', el('th', esc('Route')) + days.map(
    (k) => el('th', esc(s4DayLabel(report, k)), { dataD: k }),
  ).join(''));
  const body = [];
  for (const h of rows) {
    const route = String(h.shortName || h.longName || h.routeId || '');
    let longName = String(h.longName || '');
    if (h.directionId !== null && h.directionId !== undefined) {
      // Python: f"{long_name} · direction {id}".strip(" ·")
      // Python `.strip(" ·")` — leading/trailing spaces and middots only.
      longName = `${longName} · direction ${h.directionId}`.replace(/^[ ·]+|[ ·]+$/g, '');
    }
    const cells = [el('td', el('b', esc(route)) + esc(longName))];
    for (const key of days) {
      const value = (h.perDay || {})[key];
      const trips = Math.trunc(Number((h.trips || {})[key] || 0));
      const title = el('b', esc(`Route ${route}${longName ? ` — ${longName}` : ''}`));
      let cell;
      if (value === null || value === undefined) {
        const tip = title + esc(`${s4DayLabel(report, key)}: no service, no trips.`);
        cell = el('div', esc('—'), {
          className: 'cell', dataHb: 'none', dataD: key, dataTip: tip,
        });
      } else {
        const [binId] = s4HeadwayBin(Number(value));
        const tip = title + esc(`${s4DayLabel(report, key)}: about one every `
          + `${mins(Number(value))}, from ${num(trips)} trips.`);
        cell = el('div', esc(num(Number(value))), {
          className: 'cell', dataHb: binId, dataD: key, dataTip: tip,
        });
      }
      cells.push(el('td', cell));
    }
    body.push(el('tr', cells.join('')));
  }
  const table = el('table', el('thead', head) + el('tbody', body.join('')), {
    className: 'hw',
  });
  return waScroller(el('div', table, { id: tableId }));
}

/**
 * The frequency card's body: legend, grid, method, and the overflow routes. The
 * busiest `S4_MAX_HEATMAP_ROUTES` rows are the grid; every remaining route renders in
 * full in a second table below it, never as a "N more not shown" line.
 *
 * @param {Object} report @param {string} methodHtml @returns {string}
 */
export function s4Heatmap(report, methodHtml) {
  const rows = s4HeatmapRows(report);
  const shown = rows.slice(0, S4_MAX_HEATMAP_ROUTES);
  const extra = rows.slice(S4_MAX_HEATMAP_ROUTES);
  // the fills live on `[data-hb]` alone (styles.css), so a `.sw` key needs no override.
  const legend = s4Legend([
    ...S4_HEADWAY_BINS.map(([, binId, label]) => [
      el('span', '', { className: 'sw', dataHb: binId }), label,
    ]),
    [el('span', '', { className: 'sw', dataHb: 'none' }), 'No service that day'],
  ]);
  let overflow = '';
  if (extra.length) {
    const n = extra.length;
    overflow = waDetails(
      `${num(n)} more ${s4Plural(n, 'route')}`,
      s4HeatmapTable(report, extra, 'hwmap2'),
      { appearance: 'plain' },
    );
  }
  return el('div', join(
    legend, s4HeatmapTable(report, shown, 'hwmap'), methodHtml, overflow,
  ), { className: 'wa-stack wa-gap-s' });
}

/**
 * §06 — the ride-time bar chart and the headway-by-day heatmap.
 *
 * Chart A: travel time from the start to a fixed destination sample, with a dashed
 * line at the hiding period; bars are brand when they fit, gold with a caveat, danger
 * when they bust the window, hollow dashed for no service. Chart B: `table.hw`,
 * routes × day types, binned `[data-hb='1']`–`[data-hb='6']`, hatched for no service.
 *
 * Both cards read title → graphic → legend → method; the `wa-chart` keeps the full
 * caption as its `description`. Neither graphic goes inside a disclosure: Chart.js
 * sizes itself once, at construction.
 *
 * @param {Object} payload the (possibly partial) `Report`
 * @returns {string} HTML, or '' when there is nothing to show yet
 */
export function renderTransitReality(payload) {
  const report = payload || {};
  const size = report.size;
  if (!size || !report.days || !report.days.length) return '';
  const hp = num(size.hidingPeriodMin || 0);
  const startName = startStopName(report);
  const departure = String((report.opts || {}).departure || '').slice(0, 5);
  const samples = report.travelSamples || [];
  const cards = [];

  if (samples.length) {
    // A reader must not be able to mistake these minutes for a straight-line guess.
    const caption = `Scheduled minutes from ${startName} at ${departure} on the selected `
      + `day, to a fixed sample of ${num(samples.length)} busy zones — the same `
      + 'sample every day, so the bars are comparable across the selector. '
      + `Blue = the ride fits inside the ${hp}-minute hiding period with slack; `
      + 'gold = it fits but uses more than three quarters of the window or needs two changes; '
      + 'red = it busts the window; '
      + 'a hollow dashed outline = no service to that stop on the selected day. '
      + `Dashed line = the ${hp}-minute hiding period. Times are scheduled, not observed: `
      + 'treat each bar as a centre point, not a ceiling. '
      + 'Each ride is a real sequence of buses over the timetable, transfer wait '
      + 'included — not a straight-line guess.';
    const chart = el('wa-chart', '', {
      id: 'ttchart',
      type: 'bar',
      indexAxis: 'y',
      grid: 'x',
      min: '0',
      max: num(s4ChartMax(report), 0, { comma: false }),
      withoutLegend: true,
      label: `Scheduled ride time from ${startName}`,
      description: caption,
      style: 'display:block;min-width:680px',
    });
    const legend = s4Legend([
      [s4Swatch('background:var(--accent)'), `Fits the ${hp}-minute window`],
      [s4Swatch('background:var(--gold-mark)'), 'Fits, but tight or two changes'],
      [s4Swatch('background:var(--crit)'), 'Busts the hiding period'],
      [s4Swatch('background:transparent;border:1.5px dashed var(--baseline)'),
        'No service on the selected day'],
    ]);
    cards.push(waCard(
      el('div', join(
        waScroller(chart),
        legend,
        waDetails('How to read this chart',
          el('p', esc(caption), { className: 'wa-body-s wa-color-text-quiet' }),
          { appearance: 'plain' }),
      ), { className: 'wa-stack wa-gap-s' }),
      {
        headerHtml: s4CardHeader(
          `Scheduled ride time from ${startName}`,
          `Scheduled minutes to ${num(samples.length)} fixed destinations.`,
        ),
      },
    ));
  }

  const headways = report.routeHeadways || [];
  const nRoutes = headways.length;
  if (nRoutes >= S4_MIN_HEATMAP_ROUTES) {
    // "Median … between 10:00 and 14:00" is the CLI's own wording; keep it.
    let cap = 'Median minutes between departures per route — how often a bus comes — measured at '
      + "the route's own stops between 10:00 and 14:00, one column per service day this "
      + 'feed distinguishes. The technical name is headway. '
      + 'Medians, not averages: a route that runs every 10 minutes at rush hour '
      + 'and hourly at noon averages out to a figure that describes neither, and '
      + 'midday is when you will be playing. '
      + 'Darker = less frequent. A hatched cell means the route does not run that day. '
      + 'The selected day is highlighted; hover any cell for its trip count.';
    let subtitle = 'How often a bus comes, per route, per service day.';
    if (nRoutes > S4_MAX_HEATMAP_ROUTES) {
      const extra = nRoutes - S4_MAX_HEATMAP_ROUTES;
      cap += ` This feed has ${num(nRoutes)} route rows; the busiest `
        + `${num(S4_MAX_HEATMAP_ROUTES)} are in the grid and the other `
        + `${num(extra)} are in the drawer beneath it, in full.`;
      subtitle = `How often a bus comes. The busiest ${num(S4_MAX_HEATMAP_ROUTES)} of `
        + `${num(nRoutes)} rows are in the grid; the rest are below it.`;
    }
    const method = waDetails('How to read this',
      el('p', esc(cap), { className: 'wa-body-s wa-color-text-quiet' }),
      { appearance: 'plain' });
    cards.push(waCard(s4Heatmap(report, method), {
      headerHtml: s4CardHeader('How often the buses come', subtitle),
    }));
  } else if (nRoutes) {
    const labels = s4JoinWords(headways.map((h) => String(h.shortName || h.routeId || '')));
    cards.push(waCard(el('p', esc(
      `This network has ${num(nRoutes)} route${nRoutes !== 1 ? 's' : ''} — ${labels} — `
      + 'too few for a frequency heatmap to say anything a sentence cannot. '
      + 'Median headways are in the tile above. With this few routes the Transit Line '
      + 'matching question is close to degenerate: expect it to identify a zone rather '
      + 'than narrow the field.',
    ), { className: 'wa-body-s' }), {
      headerHtml: s4CardHeader('How often the buses come',
        'Too few routes for a grid.'),
    }));
  }

  if (!cards.length) return '';

  // The map's reach layer already shows reach; this section says what only it has:
  // specific rides, and specific waits.
  const lede = `Measured from ${startName}${departure ? ` at ${departure}` : ''} `
    + '— the same origin as the map’s reach layer, in specific rides rather than in '
    + 'colour. Later rounds start from the previous hider’s zone, so re-read them from '
    + 'that stop rather than from the hub.';
  const answer = el('p', esc(
    `The map says how far ${hp} minutes gets you. This chart says how long `
    + `${num(samples.length)} specific rides take, and the grid under it says how long `
    + 'you wait for one.',
  ), { className: 'wa-body-s' });
  return section('transit', S4_ORDINAL, 'Getting around',
    el('div', cards.join(''), { className: 'wa-stack wa-gap-s' }),
    { kicker: 'How long things take', lede, answerHtml: answer });
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · §05 THE MAP YOU'RE PLAYING ON (generate.py)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * `ZoneReach.perDay[dayKey]`, or `null`. A lookup, not a computation: every count the
 * page prints was computed worker-side so a renderer never subtracts two measurements.
 *
 * @param {Object} report @param {string} dayKey @returns {Object|null}
 */
export function s4ReachDay(report, dayKey) {
  const perDay = ((report && report.zoneReach) || {}).perDay || {};
  const cell = perDay[dayKey];
  return cell === undefined || cell === null ? null : cell;
}

/**
 * "What to notice" — two or three deterministic sentences under the map: which zones
 * the hiding period cannot reach, whether there is a hub worth camping, and whether
 * another service day is worse.
 *
 * NETWORK-STAGE FACTS ONLY (`zones`, `zoneReach`, `hub`, `size`, `metrics`,
 * `routeSpokes`): this string renders inside §05, and a string that moves at `rules`
 * or `score` re-mounts the section and tears down the MapLibre instance.
 *
 * It counts, filters, sorts and slices; it does no arithmetic. Every quantity is
 * carried or the length of a filtered list — sentence three is a filter over two
 * carried id lists, never a subtraction of two counts.
 *
 * app.js pre-renders per-day variants into `DATA.days[k].map_caption_html`, so a day
 * switch is an innerHTML swap. Before `score` this renderer's own copy stands.
 *
 * @param {Object} report @param {string} dayKey
 * @returns {string} HTML, or '' when there is nothing worth noticing yet
 */
export function s4MapCaption(report, dayKey) {
  const r = report || {};
  const size = r.size || {};
  const hub = r.hub || {};
  const zones = r.zones || [];
  if (!zones.length || !size.hidingPeriodMin) return '';
  const hp = num(size.hidingPeriodMin);
  const startName = startStopName(r);
  const label = s4DayLabel(r, dayKey);
  const spokesShown = (r.routeSpokes || []).length > 0;
  const sentences = [];

  // ── 1. reach ────────────────────────────────────────────────────────────────
  const reach = s4ReachDay(r, dayKey);
  if (reach !== null) {
    const missed = reach.unreachableZoneIds || [];
    if (!missed.length) {
      sentences.push(`Every one of the ${num(zones.length)} zones is reachable from `
        + `${startName} inside the ${hp}-minute hiding period on a ${label}, which is `
        + 'unusual and makes distance a weak question on this map.');
    } else {
      // The ids arrive sorted, so the naming is sorted too. Naming stops at
      // `S4_MAX_NAMED_ZONES`: "A, B and 141 others" is a number wearing two names.
      const byId = new Map(zones.map((z) => [z.zoneId, z.name || z.zoneId]));
      const named = missed.length <= S4_MAX_NAMED_ZONES
        ? missed.map((id) => String(byId.get(id) || id))
        : [];
      const rest = named.slice(2);
      const phrase = named.length === 0 ? ''
        : (named.length <= 3
          ? s4JoinWords(named)
          : s4JoinWords([...named.slice(0, 2), `${num(rest.length)} others`]));
      sentences.push(`The ${hp}-minute hiding period cannot reach `
        + `${num(missed.length)} of the ${num(zones.length)} zones from ${startName} on a `
        + `${label}${phrase ? ` — ${phrase}` : ''}. The reach layer is where they sit.`);
    }
  }

  // ── 2. structure ────────────────────────────────────────────────────────────
  if (hub.name) {
    const shape = String(s4DayView(r, dayKey).networkShape || '').split('-').join(' ');
    const share = pct(Number(hub.routeShare || 0));
    sentences.push(hub.dominant
      ? `One station, ${hub.name}, touches ${share} of the routes and the network reads `
        + `as ${shape}, so `
        + (spokesShown
          ? 'the spokes layer draws the seekers’ cheapest move: camp the hub.'
          : 'the seekers’ cheapest move is to camp the hub.')
      : `No single station dominates this network — the busiest touches ${share} of the `
        + 'routes — so there is no hub to camp'
        + (spokesShown
          ? '; turn on the spokes layer to see where the seekers will actually wait.'
          : ' and the seekers have to spread out.'));
  }

  // ── 3. the day that is worse ────────────────────────────────────────────────
  // Two tests, not one: a day qualifies only if it is worse overall AND adds zones.
  // Ranking on the set difference alone named a strictly better day as the worse one.
  const here = new Set((reach && reach.unreachableZoneIds) || []);
  let worstKey = null;
  let worstExtra = 0;
  for (const key of s4DayOrder(r)) {
    if (key === dayKey) continue;
    const cell = s4ReachDay(r, key);
    if (cell === null) continue;
    const missedThere = (cell.unreachableZoneIds || []);
    if (missedThere.length <= here.size) continue;
    const extra = missedThere.filter((id) => !here.has(id)).length;
    if (extra > worstExtra) { worstExtra = extra; worstKey = key; }
  }
  if (worstKey !== null) {
    sentences.push(`On a ${s4DayLabel(r, worstKey)}, another ${num(worstExtra)} `
      + `${s4Plural(worstExtra, 'zone')} ${s4Plural(worstExtra, 'falls', 'fall')} outside `
      + 'the window.');
  }

  if (!sentences.length) return '';
  return el('p', esc(sentences.join(' ')), { className: 'wa-body-s' });
}

/**
 * The spoke layer's honesty sentences: what was drawn, and out of how many.
 * `MAX_MAP_SPOKES` is applied worker-side (lib/core.js), so a capped feed never ships
 * the dropped polylines, and a layer that quietly draws part of the network is
 * indistinguishable from a broken one.
 *
 * @param {Object} report @returns {string[]} zero, one or two sentences
 */
export function s4SpokeNotes(report) {
  const cap = (report && report.spokeCap) || null;
  if (!cap) return [];
  const out = [];
  if (Number(cap.shown || 0) < Number(cap.total || 0)) {
    out.push(`The busiest ${num(cap.shown)} of the ${num(cap.total)} route-directions in `
      + 'this feed are drawn; the rest would be a thicket at this scale.');
  }
  if (cap.source === 'stops') {
    out.push('This feed ships no route shapes, so each line is the route\u2019s ordered stop '
      + 'sequence rather than the road it takes.');
  }
  return out;
}

/**
 * The map's legend, one block per colour mode plus the always-on items. Every block
 * is emitted; `#netlegend[data-mode]` decides which is visible, and the runtime
 * writes that attribute when the `#colourby` radio moves.
 *
 * The reach block's labels and colours are §06's ride-chart legend's: the map and the
 * chart are two pictures of one measurement and may not use two vocabularies.
 *
 * @param {Object} report
 * @param {{stopsShown: boolean, ringsShown: boolean, spokesShown: boolean}} flags
 * @returns {string}
 */
export function s4MapLegends(report, flags) {
  const { stopsShown, ringsShown, spokesShown, suggestShown = false } = flags;
  const hub = report.hub || {};
  const size = report.size || {};
  const hp = num(size.hidingPeriodMin || 0);
  const radius = s4Dist(report, size.zoneRadiusM || 0, 2);
  const startName = startStopName(report);
  const departure = String((report.opts || {}).departure || '').slice(0, 5);

  // A legend block: the swatch list in its own `wa-cluster` parent (s4Legend's <ul>
  // relies on that for its margins), with an optional caption.
  const block = (mode, items, note) => el('div', join(
    el('div', s4Legend(items), { className: 'wa-cluster wa-gap-m' }),
    note ? el('p', esc(note), { className: 'wa-caption-xs wa-color-text-quiet' }) : '',
  ), { dataLegendFor: mode, className: 'wa-stack wa-gap-3xs' });

  const always = [];
  if (ringsShown) {
    always.push([s4Swatch(
      'background:color-mix(in srgb, var(--accent) 18%, transparent);'
      + 'border:1px solid var(--accent)',
    ), 'Zone circle (toggle)']);
  }
  if (spokesShown) {
    // Two swatches: a plain route line, and the gold heavier line of a route that
    // calls at the hub.
    always.push(
      [s4Swatch('background:var(--ink-2);block-size:2px;border-radius:1px'), 'Route line (toggle)'],
      [s4Swatch('background:var(--gold-deep);block-size:3px;border-radius:1px'),
        `Route calling at ${hub.name}`],
    );
  }
  always.push(
    [el('span', esc('★'), { style: 'color:var(--gold-deep);font-weight:800' }), hub.name],
    [s4Swatch('background:transparent;border:1.5px dashed var(--gold-deep)'), 'Game border'],
  );
  // The suggested frame is a thinner, SOLID gold line, so the two gold rectangles
  // read as different things.
  if (suggestShown) {
    always.push([s4Swatch('background:transparent;border:1px solid var(--gold-deep)'),
      'Suggested border']);
  }

  const baseItems = [];
  if (stopsShown) {
    baseItems.push([s4Swatch('background:var(--ink-2);border-radius:var(--wa-border-radius-circle)'), 'Served stop']);
  }
  baseItems.push([s4Swatch('background:var(--accent);border-radius:var(--wa-border-radius-circle)'), 'Designated hiding zone']);

  const blocks = [block('base', baseItems, '')];

  if (s4ReachDay(report, s4BestDay(report)) !== null) {
    // Every key draws exactly what the canvas draws: three carry the ring the map
    // strokes (fills alone are 1.5:1 on a pale basemap), and the no-journey key is
    // SOLID because MapLibre has no dash on a circle stroke.
    //
    // The gold label differs from §06's "Fits, but tight or two changes" on purpose:
    // the chart also bins on transfers, this layer bins on the window alone.
    blocks.push(block('reach', [
      [s4Swatch('background:var(--accent);border-radius:var(--wa-border-radius-circle)'),
        `Fits the ${hp}-minute window`],
      [s4Swatch('background:var(--gold-mark);border:1.4px solid var(--gold-deep);'
        + 'border-radius:var(--wa-border-radius-circle)'),
        'Fits, but past three quarters of the window'],
      [s4Swatch('background:var(--crit);border:1.6px solid var(--ink);'
        + 'border-radius:var(--wa-border-radius-circle)'),
        'Busts the hiding period'],
      [s4Swatch('background:transparent;border:1.5px solid var(--ink-2);'
        + 'border-radius:var(--wa-border-radius-circle)'),
        'No journey at all on the selected day'],
    ], `Zone dots, coloured by scheduled travel time from ${startName} at ${departure} on `
      + 'the selected day — the same measurement the ride chart under Getting around '
      + 'draws as bars. '
      + `Gold starts at three quarters of the ${hp} minutes; red is the cliff. Stops fade `
      + `back so the zones read. Zones are ${radius} circles.`));
  }

  // The frequency block names its window: §06's grid is the median per
  // route-direction between 10:00 and 14:00, this is the median per STOP over all
  // routes between 06:00 and 22:00, and the two legitimately disagree.
  if (stopsShown) {
    blocks.push(block('frequency', [
      ...S4_HEADWAY_BINS.map(([, binId, label]) => [
        el('span', '', { className: 'sw', dataHb: binId }), label,
      ]),
      // Flat --off with the bins' hairline, because that is what applyMode() paints;
      // the grid's hatch belongs to a table cell.
      [s4Swatch('background:color-mix(in srgb, var(--off) 45%, transparent);'
        + 'box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--ink) 14%, transparent)'),
        'No service that day'],
    ], 'Stops, coloured by the median minutes between departures at that one stop, all '
      + 'routes together, between 06:00 and 22:00 on the selected day. Lighter = more '
      + 'service. The grid under Getting around measures one route direction at a time, '
      + 'between 10:00 and 14:00, so the two legitimately disagree. Zone dots fade back '
      + 'so the stops read.'));
  }

  // The always-on block carries the cap sentence, because no colour mode hides it.
  const capNotes = [];
  if (!stopsShown) {
    capNotes.push(`Over ${num(S4_MAX_MAP_STOPS)} served stops the individual dots are not `
      + 'drawn, so this map has no frequency layer and Colour by offers Plain and Reach '
      + 'only.');
  }
  if (spokesShown) capNotes.push(...s4SpokeNotes(report));
  blocks.push(block('always', always, capNotes.join(' ')));
  return blocks.join('');
}

/**
 * §05 — the MapLibre network map plus the copy-pasteable border: a toolbar above the
 * map, a legend below, the border as two `wa-copy-button`s and a collapsed table of
 * decimal degrees. Every player must use the exact same border, so it is copied, not
 * retyped.
 *
 * This emits only the `#netmap` host and the copy around it; `buildMap` in app.js's
 * `PAGE_RUNTIME_JS` attaches MapLibre afterwards and omits the map when the library
 * is blocked. Never wrap the map in a `wa-scroller`.
 *
 * WHAT THIS FUNCTION MAY READ, and nothing else: `border`, `hub`, `size`, `zones`,
 * `days` / `selectedDay`, `metrics`, `stops`, `zoneReach`, `routeSpokes`, `spokeCap`
 * and `suggestedBorder` — all `network`-stage fields — plus `geo.admin.countryCode`
 * through `s4Dist`/`s4Area` and the main-side `sourceKinds` list, fixed for the run.
 * Quoting a question count, curse, score or finding would change this string at
 * `rules` or `score`, re-mount the section and destroy the MapLibre instance with the
 * reader's pan and zoom (CONTRACT §(d)). That is why the stat rail is a NESTED host
 * with its own clock; anything later reaches the map through `#stops` and the runtime.
 *
 * @param {Object} payload the (possibly partial) `Report`
 * @returns {string} HTML, or '' when there is nothing to show yet
 */
export function renderNetworkMap(payload) {
  const report = payload || {};
  const border = report.border;
  const hub = report.hub;
  const size = report.size;
  if (!border || !hub || !size) return '';
  const day = s4DayByKey(report, s4BestDay(report));
  if (day === null) return '';
  const v = s4DayView(report, s4BestDay(report));
  const zones = report.zones || [];
  const served = servedStopCount(report, day);
  const stopsShown = served <= S4_MAX_MAP_STOPS;
  const ringsShown = zones.length <= S4_MAX_MAP_ZONE_RINGS;
  // The spoke layer is capped worker-side (lib/core.js `MAX_MAP_SPOKES`).
  const spokesShown = (report.routeSpokes || []).length > 0;
  // The worker's tighter box, or null — the common case, which renders nothing.
  const suggested = s4SuggestedBorder(report);
  const radius = s4Dist(report, size.zoneRadiusM || 0, 2);

  const bestKey = s4BestDay(report);
  const bestLabel = s4DayLabel(report, bestKey);
  const reachDay = s4ReachDay(report, bestKey);
  const startName = startStopName(report);
  const hpMin = num(size.hidingPeriodMin || 0);

  const captionParts = [
    'Live basemap.',
    // The row set is the BUSIEST day's served stops on every day (CONTRACT §(d)
    // `StopRow`); only the reach layer reads the selected day.
    stopsShown
      ? `Grey dots = each of the ${num(served)} stops with service on a ${bestLabel}, the `
        + 'representative day (hover for the name and route count).'
      : `This feed has ${num(served)} served stops, more than the `
        + `${num(S4_MAX_MAP_STOPS)} this map draws individually, so only the `
        + `${num(zones.length)} zone centres are plotted.`,
    ringsShown
      ? `Blue dots = the ${num(zones.length)} designated hiding zones; the switch draws each `
        + `one's ${radius} rulebook circle.`
      : `Blue dots = the ${num(zones.length)} designated hiding zones. There are too many to `
        + 'draw every circle, so the radius toggle is unavailable.',
    reachDay === null
      ? ''
      : `Colour by Reach recolours those zone dots by scheduled travel time from `
        + `${startName}, with the ${hpMin}-minute hiding period as the cliff, and follows `
        + 'the day selector. Colour by Plain is the flat blue.',
    stopsShown
      ? 'Colour by Frequency recolours the stops instead, on the same six steps as the '
        + 'headway grid under Getting around — but measured per stop over all routes '
        + 'between 06:00 and 22:00, a different question from that grid’s.'
      : `Over ${num(S4_MAX_MAP_STOPS)} stops the individual dots are dropped, so the `
        + 'frequency layer is unavailable and the colour selector offers Plain and Reach only.',
    !spokesShown ? ''
      : 'Route spokes draws each route-direction\u2019s own line under the dots, filtered '
        + 'to the day you picked. Lines that call at the hub are gold and a shade heavier.',
    !spokesShown ? '' : s4SpokeNotes(report).join(' '),
    `★ = ${hub.name}, the inferred round-start station.`,
    // The same three-way split as the border sentence below the map: on a fallback
    // run the frame is drawn but "nothing outside it exists" is not true.
    (border.derivation === 'option_fallback'
      ? 'Dashed gold frame = the box you set. It kept fewer than half this network, so it '
        + 'was drawn and not applied: the stops, zones and counts here are the whole network.'
      : 'Dashed gold frame = the game border. Nothing outside it exists for this game.'),
    !suggested ? ''
      : 'Thin solid gold frame = the tighter border the analysis suggests; the note '
        + 'under the map says what it keeps and offers to re-run inside it.',
    'If your browser blocks the map library the map is omitted and everything below still works.',
  ];
  const caption = captionParts.filter((x) => x).join(' ');

  // Colour modes are exclusive (two ramps at once needs two legends), so this is a
  // radio group. It offers exactly the modes THIS feed has a column for, and exists
  // whenever that is more than none: gating on reach alone lost the frequency layer
  // on any feed whose RAPTOR pass degraded.
  const modeButtons = join(
    el('wa-radio', esc('Plain'), { value: 'base', appearance: 'button', size: 's' }),
    reachDay === null
      ? ''
      : el('wa-radio', esc('Reach'), { value: 'reach', appearance: 'button', size: 's' }),
    // No Frequency button over `MAX_MAP_STOPS`: the per-stop headways ride with the
    // stops and there is nothing to colour. The caption says so.
    stopsShown
      ? el('wa-radio', esc('Frequency'), { value: 'frequency', appearance: 'button', size: 's' })
      : '',
  );
  const colourBy = (reachDay === null && !stopsShown) ? '' : el('wa-radio-group', modeButtons, {
    id: 'colourby',
    name: 'colourby',
    size: 's',
    orientation: 'horizontal',
    label: 'Colour by',
    value: reachDay === null ? 'base' : 'reach',
  });

  const layerControls = join(
    colourBy,
    // Geometry, not a recolouring, so it is orthogonal to `Colour by` and stays a
    // switch. It ships unchecked: the dots are the content, the spokes context.
    spokesShown ? waSwitch('Route spokes', { checked: false, id: 'spokesw' }) : '',
    ringsShown ? waSwitch(`Draw the ${radius} zone circles`, { checked: false, id: 'zonesw' }) : '',
  );

  const [s, w, n, e] = border.bbox;
  const degRows = [
    ['South', num(s, 6, { comma: false })], ['West', num(w, 6, { comma: false })],
    ['North', num(n, 6, { comma: false })], ['East', num(e, 6, { comma: false })],
  ];
  if (border.kind === 'circle') {
    degRows.push(['Centre', `${num(border.circle[0], 6, { comma: false })}, `
      + `${num(border.circle[1], 6, { comma: false })}`]);
    degRows.push(['Radius', s4Dist(report, border.circle[2], 2)]);
  }
  const degrees = el('div', degRows.map(([label, value]) => el('span', join(
    el('span', esc(label), { className: 'wa-caption-xs wa-text-uppercase' }),
    el('b', esc(value), { className: 'wa-heading-xs' }),
  ), { className: 'wa-stack wa-gap-3xs' })).join(''), { className: 'wa-cluster wa-gap-xl' });

  const geojsonText = jdump(border.geojson);
  // The plain-text twin of the table, from the same `degRows` and therefore the same
  // digits: the copied artefact and the printed one can never disagree.
  const degText = degRows.map(([label, value]) => `${label} ${value}`).join('\n');

  const toolbar = el('div', join(
    // `#netlayers` so the runtime can remove the whole layer group when MapLibre is
    // blocked; the copy buttons beside them work without a map and stay.
    el('div', layerControls, {
      id: 'netlayers', className: 'wa-cluster wa-gap-s wa-align-items-center',
    }),
    el('div', join(
      // Slotted triggers, not the icon-only default: the two payloads are different
      // things and the buttons have to say which is which.
      waCopyButton(geojsonText, {
        label: 'Copy GeoJSON', id: 'geocopy',
        trigger: waButton('Copy GeoJSON'),
      }),
      waCopyButton(degText, {
        label: 'Copy coordinates', id: 'bboxcopy',
        trigger: waButton('Copy coordinates'),
      }),
    ), { className: 'wa-cluster wa-gap-s wa-align-items-center' }),
  ), { id: 'netcontrols', className: 'wa-split wa-align-items-center wa-flex-wrap wa-gap-s' });

  // `Border.derivation` (CONTRACT §(b)): `'option'` is the reader's rectangle used as
  // given, with no padding; `'reach'` is the inferred, padded box; `'option_fallback'`
  // is a box that kept under `IN_PLAY_MIN_SHARE` of the served stops, so the worker
  // measured the whole network instead — and that must never be silent.
  const borderArea = s4Area(report, Number(border.areaSqM || 0));
  const borderSentence = border.derivation === 'option_fallback'
    ? `The border is the box you set on the landing map (no padding), and it covers `
      + `${borderArea} — but it kept fewer than half the stops this network serves, so `
      + 'nothing on this page was measured inside it: every count below is the whole '
      + 'network. '
    : border.derivation === 'option'
      ? `The border is the box you set on the landing map (no padding). It covers `
        + `${borderArea}. `
      : 'The border is the bounding box of the in-map stops padded by one hiding-zone '
        + `radius (${s4Dist(report, Number(border.padM || 0), 2)}), so every legal zone lies `
        + `wholly inside it. It covers ${borderArea}. `;
  const howToRead = join(
    el('p', esc(caption), { className: 'wa-body-s wa-color-text-quiet' }),
    el('p', esc(
      borderSentence
      + 'Copy GeoJSON pastes into geojson.io, Google My Maps or a GPX app; Copy '
      + 'coordinates gives the four labelled degrees as text.',
    ) + provChip('border'), { className: 'wa-body-s wa-color-text-quiet' }),
  );

  const mapCard = waCard(
    el('div', join(
      toolbar,
      el('div', '', { id: 'netmap', className: 'wa-border-radius-m' }),
      el('div', s4MapLegends(report, {
        stopsShown, ringsShown, spokesShown, suggestShown: suggested !== null,
      }), {
        id: 'netlegend',
        dataMode: reachDay === null ? 'base' : 'reach',
        className: 'wa-stack wa-gap-3xs',
      }),
      // A colour change on a <canvas> is invisible to a screen reader, so a PINNED
      // tile highlight is announced here. Hover and focus previews deliberately are
      // not. Ships empty; `:empty` hides the row.
      el('p', '', {
        id: 'netpin',
        ariaLive: 'polite',
        className: 'wa-caption-s wa-color-text-quiet',
      }),
      // "What to notice" for the representative day; once `score` lands `renderDay()`
      // swaps in the selected day's pre-rendered variant. `:empty` hides the row.
      el('div', s4MapCaption(report, bestKey), {
        id: 'netcaption', className: 'wa-body-s wa-color-text-quiet',
      }),
      // '' when there is no suggestion; `join` drops it.
      s4SuggestCallout(report, suggested),
      waDetails('How to read this map', howToRead, { appearance: 'plain' }),
      waDetails('Exact coordinates', degrees, { appearance: 'plain', id: 'mapborder' }),
    ), { className: 'wa-stack wa-gap-s' }),
    {
      headerHtml: s4CardHeader(
        `${num(served)} served stops, ${num(zones.length)} hiding zones and the border`,
        `Everything that runs on a ${bestLabel}, the representative day. The reach layer `
        + 'follows the day selector. Copy the border: every player must use the same one.',
      ),
    },
  );

  const shape = String(v.networkShape).split('-').join(' ');
  const lede = `The raw playing field: every stop with service on a ${bestLabel}, and the `
    + `${num(zones.length)} hiding zones one zone per `
    + `${radius} circle produces. `
    + `The network reads as ${shape}`
    + (hub.dominant
      ? `, with one station — ${hub.name} — touching ${pct(Number(hub.routeShare || 0))} of all routes`
      : ', with no single dominant interchange')
    + '.';
  // `unreachableZoneIds.length` is a lookup on a worker-computed list, not a
  // subtraction, and a `network`-stage fact, so it does not move this string later.
  const missed = reachDay === null ? null : reachDay.unreachableZoneIds.length;
  const answer = el('p', esc(
    `${num(zones.length)} places to hide`
    + (missed === null
      ? `, out of the ${num(served)} stops that run on a ${bestLabel}.`
      : `, and ${num(missed)} of them the ${hpMin}-minute hiding period cannot reach from `
        + `${startName} on a ${bestLabel}.`)
    + " The numbers under the map are the same day's measurements; copy the border "
    + 'before anyone draws a card.',
  ), { className: 'wa-body-s' });
  // The stat rail's host, empty. app.js mounts `renderGlanceRail` into it and
  // re-mounts it on its own clock without this string — or the map — moving.
  const glanceHost = el('div', '', {
    id: 'glance',
    dataSection: 'glance',
    dataStage: 'rules',
    dataState: 'skeleton',
    ariaBusy: 'true',
    className: 'wa-stack wa-gap-s',
  });

  return section('network', S4_ORDINAL, 'The map you’re playing on',
    join(el('div', mapCard, { className: 'wa-stack wa-gap-s' }), glanceHost),
    { kicker: 'The network', lede, answerHtml: answer });
}
