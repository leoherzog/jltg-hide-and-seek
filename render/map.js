/**
 * render/map.js — the map section (its stat rail and its map) and §06 Getting Around.
 *
 * Ported from generate.py S4:
 *   index_key_numbers      + _s4_legend, _s4_swatch,
 *                            _s4_card_header             → the `#glance` stat rail
 *   index_network_map                                    → §05 `#network`
 *   index_transit_reality  + _s4_headway_bin, _s4_heatmap_rows,
 *                            _s4_heatmap_table, _s4_heatmap,
 *                            _s4_chart_max               → §06 `#transit`
 *   the per-day views        (_s4_day_view … _s4_tiles_html)
 *
 * The shared S4 formatting helpers (`_s4_dist`, `_s4_area`, `_s4_val`, `_s4_plural`,
 * `_s4_natural_key`, `_s4_swatch`, `_s4_card_header`) and four of the day-view helpers
 * live in `./verdict.js`; they are imported and re-exported here rather than written a
 * second time, so there is exactly one implementation of each on the page.
 *
 * PROGRESSIVE HYDRATION. The CLI has one finished `Report`; the browser has a partial
 * one that grows as the worker's stages land. Every renderer here takes that partial
 * report and degrades: a piece it has not been handed yet is not printed, and a
 * section with nothing to show returns `''` so app.js can drop it and its nav entry.
 *
 * FORMATTING DISCIPLINE. Every number goes through exactly one formatter from
 * `../lib/core.js`. No `toFixed`, no `Intl`, no arithmetic inside a template literal.
 *
 * DETERMINISM. No clock, no randomness, and no unsorted iteration of an object whose
 * key order could vary. The sort below (`_s4_heatmap_rows`) carries the Python's full
 * tie-break tuple for exactly that reason.
 *
 * §04 WAS FOLDED INTO §05 on 2026-08-23. `index_key_numbers` no longer renders a
 * numbered section of its own: `renderGlanceRail` returns the twelve stat tiles as a
 * plain `#glance` div that lives INSIDE the map section, through its own nested
 * `data-section="glance"` host with its own hydration clock (`needs: 'network'`, its
 * own `redo` — see app.js's `SECTIONS`). The two cannot share one clock: §05's string
 * must not move at `rules` or `score`, because a changed string re-mounts the section
 * and tears the MapLibre instance down with it, and the tiles move at both. `#tiles`
 * keeps its exact id because `renderDay()` rewrites that container's innerHTML on
 * every day switch.
 *
 * @module render/map
 */

import {
  num, pct, mins, hhmm, prettyDate, quantile, jdump,
} from '../lib/core.js';

import {
  esc, el, join, waCard, waScroller, waDetails, waSwitch, waCopyButton, waButton,
  chip, kpi, section, subhead, provChip,
} from './html.js';

import {
  S4_ORDINAL,
  s4Dist, s4Area, s4Plural, s4JoinWords,
  s4Swatch, s4CardHeader,
  s4DayView, s4DayOrder, s4DayLabel, s4BestDay, s4WorstDay, s4LiveQuestions,
} from './verdict.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Presentation constants (generate.py)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The rail's three tile groups. `s4Tiles` tags every tile with a `g` key; the grouping is
 * produced here rather than around `#tiles`, because `renderDay()` replaces that
 * container's `innerHTML` wholesale and would overwrite any chrome outside this string.
 */
const S4_TILE_GROUPS = Object.freeze([
  Object.freeze(['map', 'The map']),
  Object.freeze(['clock', 'The clock']),
  Object.freeze(['deck', 'The deck']),
]);

/**
 * The two placeholder tiles the deck group shows before the `rules` stage lands.
 * Widths are literals for the same reason every other skeleton's are: the markup
 * must be byte-stable, and nothing here may read a clock or a random number.
 */
const S4_DECK_SKELETON_WIDTHS = Object.freeze([
  Object.freeze(['82%', '70%']),
  Object.freeze(['60%', '84%']),
]);

/**
 * Headway heatmap bins in minutes. The middle element is the `data-hb` value the cell
 * carries; the six ramp steps are styled by `[data-hb='N']`, unscoped so the 92x30 grid
 * cell and the 11px `.sw` legend key share one fill rule.
 *
 * Exported since 2026-08-23: the map's frequency layer bins per-stop headways on
 * these thresholds and paints them from `--seq-100`…`--seq-650`, the same six tokens
 * `[data-hb='1']`…`[data-hb='6']` use. `app.js` ships the thresholds into `#data` as
 * `game.headway_bins_min` rather than letting `PAGE_RUNTIME_JS` keep a second copy —
 * a map that binned at different edges from the grid two cards down would be a lie
 * that nothing on the page could catch.
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
/** Above this the heatmap grid shows the busiest 25 and drawers the rest. */
/**
 * How many unreachable zones the map's caption will name before it stops naming them
 * and prints the count alone. (2026-08-23, with the generated caption.)
 */
const S4_MAX_NAMED_ZONES = 6;

const S4_MAX_HEATMAP_ROUTES = 25;
/** Below this the heatmap becomes one sentence. */
const S4_MIN_HEATMAP_ROUTES = 3;

// ═══════════════════════════════════════════════════════════════════════════════
// Small local helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Plain code-point string comparison. Never `localeCompare` — that is locale-bound. */
function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A finite number, or `null`. Guards every raw value before a formatter. */
function fnum(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/**
 * `len(report.feed.routes)`.
 *
 * The real `feed.routes` map does not cross `postMessage` until the `'done'` message,
 * so before then the count comes from the `'feed'` stage's scalar. Same number, and
 * the tile reads correctly from stage 1 onward instead of printing "of 0".
 */
function feedRouteCount(report) {
  const routes = (report.feed && report.feed.routes) || {};
  const n = Object.keys(routes).length;
  if (n) return n;
  return Number((report.feedCounts || {}).routes || 0);
}

/**
 * The number of stops with service on `day`.
 *
 * The CLI reads `len(day.served_stop_ids)`; a `DaySummary` cannot carry the id list
 * across `postMessage` (CONTRACT §(d)) and carries the count instead. The `StopRow[]`
 * map layer is the same set, so it is the fallback.
 */
function servedStopCount(report, day) {
  const n = day ? fnum(day.servedStops) : null;
  if (n !== null) return n;
  return ((report && report.stops) || []).length;
}

/**
 * The round-start station's display name.
 *
 * The CLI reads `report.feed.stops[start_stop_id]` and falls back to `hub.name`. In
 * the browser `feed.stops` is empty until `'done'`, so the `StopRow[]` map layer —
 * which carries the same names and arrives at the `'network'` stage — sits between
 * the two. The printed name is identical either way.
 */
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
 * A `wa-cluster` of `.sw` swatches — the drafts' map legend.
 *
 * A real `<ul>`/`<li>` with `wa-list-plain`, not a div with `role="list"`: native
 * semantics need no ARIA override. CAVEAT: the `<ul>`'s own block margin from
 * `native.css` is zeroed only because `wa-cluster`/`wa-split` reset child margins, and
 * both current parents carry one. Drop this legend into an unclassed parent and it
 * picks up list margins that the old `<div>` never had.
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
 * The day summary for one key, or `null`. (`_s4_day_by_key`.)
 *
 * The CLI returns a full `ServiceDay`; in the browser `report.days` holds the
 * clone-safe `DaySummary` (CONTRACT §(d)), which carries every field §04–§06 read.
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
 * The twelve stat tiles for one service day (pages.md §3.3).
 *
 * Seven of the twelve move with the day; the other five are map-wide or rulebook
 * constants and are repeated so that one list renders the whole grid.
 *
 * `hl` is on exactly the tiles that name a fact the map can point at, and is the
 * `data-hl` the runtime binds tile↔map highlighting to (added 2026-08-23 with the
 * §04→§05 merge). The other tiles deliberately carry nothing: a tile that lights
 * nothing must not look like a control.
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
      // The value is a share of ZONES and the note used to count STOPS — two
      // different quantities in one tile. It counts zones now, from `ZoneReach`'s
      // worker-computed `reachableZones` (a renderer may look a count up; it may not
      // subtract one measured quantity from another), and keeps the stop figure as
      // the parenthetical looser test it always was. (Fixed 2026-08-23 with the
      // map's reach layer.)
      l: 'Zones reachable in the hiding period',
      n: (reach === null
        ? `${num(reachN)} of ${num(served)} served stops are within `
          + `${num(size.hidingPeriodMin || 0)} minutes of the start location at `
          + `${departure}.`
        : `${num(reach.reachableZones)} of ${num(nZones)} zones are within `
          + `${num(size.hidingPeriodMin || 0)} minutes of ${startName} at ${departure} `
          + `on a ${label} — the ${num(reach.unreachableZoneIds.length)} that are not are `
          + "red on the map's reach layer, hollow where there is no journey at all. "
          + `(${num(reachN)} of ${num(served)} served stops are, which is the looser test.)`),
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
 * The tile grid's inner markup for one day, in its three labelled groups.
 *
 * The grouping is produced here rather than around `#tiles`, because `renderDay()`
 * replaces that container's `innerHTML` wholesale and would overwrite any chrome that
 * lived outside this string.
 *
 * The deck group's two tiles count questions and curses, which do not exist until the
 * `rules` stage — three stages after the rail itself lands. They are drawn as
 * skeletons until then rather than as a truthful-but-useless "0 of 0", and rather
 * than being dropped, so the rail does not change height under the reader when the
 * audit arrives. (Added 2026-08-23 with the §04→§05 merge.)
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
 * A deterministic x-axis maximum for the ride-time chart.
 *
 * The hiding-period line must always be on the canvas, and one 3-hour outlier must not
 * squash every other bar, so the axis is the larger of 1.25 × the hiding period and the
 * p90 of every sampled time on every day, rounded up to a multiple of 15. Bars past it
 * are clipped and annotated at the axis end.
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
 * The twelve stat tiles in three groups, each with value, label, note and chip.
 *
 * Was §04, a numbered section of its own, until 2026-08-23; it is now the rail under
 * the map, and therefore returns a plain `<div id="glance">` — no `section()`, no
 * `S4_ORDINAL`, no `data-n`, no kicker. app.js mounts it through its own nested
 * `data-section="glance"` host inside §05 and stamps `data-section` / `data-state`
 * onto this root itself.
 *
 * The old §04 answer line went with the merge: it said "N places to hide across
 * A km², served by R of M routes", which is the hero's headline and, two cards up,
 * §05's own answer. The rail states its measuring conditions and then shows numbers.
 *
 * Its gate is unchanged and is why the rail's `needs` is `network` and not `rules`:
 * `size`, `metrics` and `days` all land at the `network` stage.
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
    // Promised when the rail was folded in, delivered with the runtime that makes it
    // true; the six tiles that name a place carry `data-hl`. (2026-08-23.)
    + 'Where a tile names a place, hovering it lights that place on the map above — '
    + 'or move to it with the keyboard and press Enter to pin it there.';
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
 * The frequency card's body: legend, grid, method, and the overflow routes.
 *
 * The legend leads, because a reader needs the scale before the grid. The busiest
 * `S4_MAX_HEATMAP_ROUTES` rows are the grid; **every remaining route renders in full**
 * in a second, complete table below it rather than collapsing into a "N more routes
 * not shown" line. A report whose whole claim is completeness does not get to truncate
 * its own evidence.
 *
 * @param {Object} report @param {string} methodHtml @returns {string}
 */
export function s4Heatmap(report, methodHtml) {
  const rows = s4HeatmapRows(report);
  const shown = rows.slice(0, S4_MAX_HEATMAP_ROUTES);
  const extra = rows.slice(S4_MAX_HEATMAP_ROUTES);
  // the fills live on `[data-hb]` alone (styles.css), so a `.sw` key gets the bin
  // colour and the contrast hairline at 11px with no geometry override.
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
 * Chart A: travel time from the start location to a deterministic 14-destination
 * sample, with a dashed line at the hiding period; bars are brand when they fit, gold
 * when they fit with a caveat, danger when they bust the window, and hollow dashed when
 * there is no service that day. Chart B: `table.hw`, routes × day types, binned
 * `[data-hb='1']`–`[data-hb='6']`, hatched `[data-hb='none']` for no service.
 *
 * Both cards read title → graphic → legend → method: the encoding note is the same
 * words it always was, but a reader meets the picture and its key first and the 95-word
 * explanation only if they want it. The `wa-chart` keeps the full caption as its
 * `description`, so assistive tech loses nothing either way. Neither graphic is ever
 * inside a disclosure — Chart.js and MapLibre size themselves once, at construction,
 * and a collapsed container has no size.
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
    // The RAPTOR sentence is the README's own ("Read the schedule"): these minutes are
    // a real sequence of buses over the real timetable, including the wait for the
    // transfer, and a reader must not be able to mistake them for a straight-line guess.
    const caption = `Scheduled minutes from ${startName} at ${departure} on the selected `
      + `day, to a fixed sample of ${num(samples.length)} busy zones — the same `
      + 'sample every day, so the bars are comparable across the selector. '
      + `Blue = the ride fits inside the ${hp}-minute hiding period with slack; `
      + 'gold = it fits but uses more than three quarters of the window or needs two changes; '
      + 'red = it busts the window outright; '
      + 'a hollow dashed outline = no service to that stop on the selected day. '
      + `Dashed line = the ${hp}-minute hiding period. Times are scheduled, not observed: `
      + 'treat each bar as a centre point, not a ceiling. '
      + 'Each ride is a real sequence of buses over the timetable, including the '
      + 'transfer wait — not a straight-line guess.';
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
    // "Median … between 10:00 and 14:00" is the CLI's own wording and is the whole
    // honesty of this grid; the "not averages" clause is the README's gloss on it.
    let cap = 'Median minutes between departures per route — how often a bus comes — measured at '
      + "the route's own stops between 10:00 and 14:00, one column per service day this "
      + 'feed distinguishes. The technical name is headway. '
      + 'These are medians, not averages: a route that runs every 10 minutes at rush hour '
      + 'and once an hour at noon averages out to a figure that describes neither. That '
      + 'window is when you will be playing. '
      + 'Darker = less frequent. A hatched cell means the route does not run that day at '
      + 'all. The selected day is highlighted; hover any cell for its trip count.';
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
      + 'which is too few for a frequency heatmap to say anything a sentence cannot. '
      + 'Median headways are in the tile above; with this few routes the Transit Line '
      + 'matching question is close to degenerate and both sides should expect it to '
      + 'identify a zone rather than narrow the field.',
    ), { className: 'wa-body-s' }), {
      headerHtml: s4CardHeader('How often the buses come',
        'Too few routes for a grid.'),
    }));
  }

  if (!cards.length) return '';

  // The map's reach layer now colours every zone by travel time from the start, with
  // the hiding period as the cliff — so this section stopped repeating that and says
  // what only it has instead: specific rides, and specific waits. (R7, 2026-08-23.)
  const lede = `These are measured from ${startName}${departure ? ` at ${departure}` : ''} `
    + '— the same origin as the map’s reach layer, in specific rides rather than in '
    + 'colour. Later rounds '
    + 'start from the previous hider’s zone, so re-read them from that stop rather than '
    + 'from the hub.';
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
 * `ZoneReach.perDay[dayKey]`, or `null`.
 *
 * A lookup, not a computation: every count the page prints (`reachableZones`,
 * `unreachableZoneIds.length`, `furthestMinutes`) was computed worker-side precisely
 * so a renderer never subtracts one measured quantity from another.
 *
 * @param {Object} report @param {string} dayKey @returns {Object|null}
 */
export function s4ReachDay(report, dayKey) {
  const perDay = ((report && report.zoneReach) || {}).perDay || {};
  const cell = perDay[dayKey];
  return cell === undefined || cell === null ? null : cell;
}

/**
 * "What to notice" — two or three deterministic sentences under the map (R6).
 *
 * The map carries the report's findings now, and a picture that says nothing is a
 * picture nobody reads. This is the caption that names what the layers are showing:
 * which zones the hiding period cannot reach, whether the network has a hub worth
 * camping, and whether another service day is worse.
 *
 * NETWORK-STAGE FACTS ONLY — `zones`, `zoneReach`, `hub`, `size`, `metrics`,
 * `routeSpokes` — for the same reason `renderNetworkMap` is held to that list: this
 * string is rendered inside §05, and a string that moves at `rules` or `score`
 * re-mounts the section and tears the MapLibre instance down with it.
 *
 * IT COUNTS, FILTERS, SORTS AND SLICES; IT DOES NOT DO ARITHMETIC. Every quantity it
 * prints is either carried (`reachableZones`, `unreachableZoneIds`) or the length of
 * a list it filtered. Sentence three in particular is "how many of the worse day's
 * unreachable zones are NOT unreachable today", which is a filter over two carried
 * id lists — never a subtraction of two measured counts.
 *
 * Per-day variants are pre-rendered into `DATA.days[k].map_caption_html` by app.js's
 * `dataPayload`, so a day switch is an innerHTML swap and never a recompute. Before
 * the `score` stage `DATA.days` is empty and this renderer's own copy — for the
 * representative day — is what stands, which is correct: there is no day selector yet.
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
      // A name lookup, the same move render/strategy.js already makes for its
      // dossiers. The ids arrive sorted, so the naming is sorted too.
      //
      // Naming stops at six. "A, B and two others" is a fact a reader can hold; "A, B
      // and 141 others" is a number wearing two names, and on a Sunday this feed has
      // 143 of them. Past the threshold the count and the layer say it better.
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
  // Two tests, not one. Ranking on the set difference ALONE named a strictly better
  // day as the worse one: on the reference feed a Sunday reader was told "on a
  // Saturday, another 6 zones fall outside the window" when Saturday's own total is
  // 81 against Sunday's 143 — true as a set difference, false as the impression.
  // A day only qualifies now if it is worse overall as well as additive. Both are
  // lengths of carried lists, so this stays a filter and a comparison, never
  // renderer arithmetic. (Fixed 2026-08-23.)
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
 *
 * `MAX_MAP_SPOKES` is applied worker-side (lib/core.js), so a capped feed never even
 * ships the polylines it dropped — which is exactly why the page has to say so. The
 * same rule the stop cap follows: a layer that quietly draws part of the network is
 * indistinguishable from a broken one. Counting and comparing two carried numbers,
 * never subtracting them. (2026-08-23, the spoke layer.)
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
 * The map's legend, one block per colour mode plus the always-on items.
 *
 * Every block is emitted; `#netlegend[data-mode]` decides which one is visible, and
 * the runtime writes that attribute when the reader moves the `#colourby` radio.
 * Rendering all of them means the legend never lags the map by a frame and needs no
 * data of its own.
 *
 * The reach block's four labels are **quoted from §06's ride-chart legend, verbatim**,
 * and its four colours are the same four tokens. The map and the chart are two
 * pictures of one measurement — same origin, same departure, same hiding period — so
 * they may not describe it in two different vocabularies.
 *
 * @param {Object} report
 * @param {{stopsShown: boolean, ringsShown: boolean, spokesShown: boolean}} flags
 * @returns {string}
 */
export function s4MapLegends(report, flags) {
  const { stopsShown, ringsShown, spokesShown } = flags;
  const hub = report.hub || {};
  const size = report.size || {};
  const hp = num(size.hidingPeriodMin || 0);
  const radius = s4Dist(report, size.zoneRadiusM || 0, 2);
  const startName = startStopName(report);
  const departure = String((report.opts || {}).departure || '').slice(0, 5);

  // A legend block: the swatch list in its own `wa-cluster` parent (s4Legend's <ul>
  // relies on that for its margins), with an optional caption under it.
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
    // Two swatches, because the layer paints two things: a plain route line and the
    // gold, slightly heavier line of a route that actually calls at the hub. The
    // hub emphasis is the whole reason the layer is worth drawing, so the key names
    // it rather than leaving the reader to notice the weight. (2026-08-23.)
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

  const baseItems = [];
  if (stopsShown) {
    baseItems.push([s4Swatch('background:var(--ink-2);border-radius:var(--wa-border-radius-circle)'), 'Served stop']);
  }
  baseItems.push([s4Swatch('background:var(--accent);border-radius:var(--wa-border-radius-circle)'), 'Designated hiding zone']);

  const blocks = [block('base', baseItems, '')];

  if (s4ReachDay(report, s4BestDay(report)) !== null) {
    // Every key draws exactly what the canvas draws, which is why three of these
    // four carry a ring: the map strokes the gold bin --gold-deep, the red bin
    // --ink and the no-journey bin --ink-2, because the fills alone are 1.5:1 on a
    // pale basemap and because a ring is the channel that survives a colour-blind
    // reading. The no-journey key is SOLID, not dashed: MapLibre has no dash on a
    // circle stroke, so the map cannot draw one and the key must not promise it.
    //
    // The gold label is the one label here that is NOT quoted verbatim from §06's
    // ride chart ("Fits, but tight or two changes"). The chart bins on the window
    // AND on transfers; this layer bins on the window alone, so the shared wording
    // would promise a meaning the canvas does not encode. (Both fixed 2026-08-23.)
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

  // The frequency block. Its window is NAMED, because §06's grid is the median per
  // route-direction between 10:00 and 14:00 and this is the median per STOP over all
  // routes between 06:00 and 22:00 — two honest measurements of "how often", which
  // legitimately disagree (Wyoming: 60 midday, 43 all-day). Unnamed, the map would
  // contradict the grid two cards down and neither would be wrong.
  if (stopsShown) {
    blocks.push(block('frequency', [
      ...S4_HEADWAY_BINS.map(([, binId, label]) => [
        el('span', '', { className: 'sw', dataHb: binId }), label,
      ]),
      // Flat --off, faded, with the same hairline the six bins carry — because that
      // is what applyMode() paints. The grid's 45-degree hatch belongs to a table
      // cell; a reader scanning the canvas for hatched dots would find none.
      // (Fixed 2026-08-23.)
      [s4Swatch('background:color-mix(in srgb, var(--off) 45%, transparent);'
        + 'box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--ink) 14%, transparent)'),
        'No service that day'],
    ], 'Stops, coloured by the median minutes between departures at that one stop, all '
      + 'routes together, between 06:00 and 22:00 on the selected day. Lighter = more '
      + 'service. The grid under Getting around measures a different thing — one route '
      + "direction at a time, between 10:00 and 14:00 — so the two legitimately "
      + 'disagree. Zone dots fade back so the stops read.'));
  }

  // The always-on block carries the cap sentence when a cap bit, because that block
  // is the one part of the legend no colour mode hides. A dropped layer that says
  // nothing is indistinguishable from a broken one.
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
 * §05 — the MapLibre network map plus the copy-pasteable border.
 *
 * Served stops as small circles, zone-cover centres as larger marked circles with their
 * radius drawn (behind a `wa-switch`), the hub as the ★ marker, and the border as a
 * dashed gold ring. A toolbar above the map, a legend below it, and the border as two
 * `wa-copy-button`s in that toolbar plus a collapsed table of decimal degrees — the
 * rulebook's hard requirement is that every player uses the exact same border, and the
 * way to make that true is to copy it rather than retype it.
 *
 * This function only emits the `#netmap` host and the copy around it; MapLibre itself is
 * attached afterwards by `buildMap` inside app.js's `PAGE_RUNTIME_JS`, which guards on
 * MapLibre being absent and omits the map rather than throwing. The builder lives in
 * that inlined runtime and not in this module on purpose: the runtime is a verbatim
 * port of the CLI's page JS, and the CLI builds its map there. A second copy here
 * would be the one that never runs.
 *
 * Never wrap the map in a `wa-scroller`.
 *
 * WHAT THIS FUNCTION MAY READ, and nothing else: `border`, `hub`, `size`, `zones`,
 * `days` / `selectedDay`, `metrics`, `stops`, `zoneReach`, `routeSpokes` and
 * `spokeCap` — every one of them a `network`-stage field, plus `geo.admin.countryCode`
 * reaching it through `s4Dist`/`s4Area`. Quoting
 * a question count, a curse, a score or a finding here would change this string at
 * `rules` or `score`, and a changed string re-mounts the section, which destroys the
 * MapLibre instance and throws away the reader's pan and zoom. That is why the stat
 * rail — which counts all four — is a NESTED section host with its own clock, and it
 * is the invariant CONTRACT §(d) records. Anything arriving later reaches the map
 * through `#stops` and the runtime, never through this string.
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
  // The spoke layer exists when the worker carried polylines for it. It is capped
  // there, not here (lib/core.js `MAX_MAP_SPOKES`), because the geometry must not
  // cross `postMessage` only to be thrown away on this side.
  const spokesShown = (report.routeSpokes || []).length > 0;
  const radius = s4Dist(report, size.zoneRadiusM || 0, 2);

  const bestKey = s4BestDay(report);
  const bestLabel = s4DayLabel(report, bestKey);
  const reachDay = s4ReachDay(report, bestKey);
  const startName = startStopName(report);
  const hpMin = num(size.hidingPeriodMin || 0);

  const captionParts = [
    'Live basemap.',
    // The row set is the BUSIEST day's served stops on every day (CONTRACT §(d)
    // `StopRow`), so "the selected day" was a small lie here. The reach layer is what
    // reads the selected day. (Corrected 2026-08-23 with the reach layer.)
    stopsShown
      ? `Grey dots = each of the ${num(served)} stops with service on a ${bestLabel}, the `
        + 'representative day (hover for the name and route count).'
      : `This feed has ${num(served)} served stops, more than the `
        + `${num(S4_MAX_MAP_STOPS)} this map draws individually, so only the `
        + `${num(zones.length)} zone centres are plotted.`,
    ringsShown
      ? `Blue dots = the ${num(zones.length)} designated hiding zones; the switch draws each `
        + `one's true ${radius} rulebook circle.`
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
        + 'between 06:00 and 22:00, which is a different question from that grid’s.'
      : `Over ${num(S4_MAX_MAP_STOPS)} stops the individual dots are dropped, so the `
        + 'frequency layer is unavailable on this feed and the colour selector offers '
        + 'Plain and Reach only.',
    !spokesShown ? ''
      : 'Route spokes draws each route-direction\u2019s own line under the dots, filtered '
        + 'to the day you picked — so a route that does not run on a Sunday is not on the '
        + 'Sunday map. Lines that call at the hub are gold and a shade heavier.',
    !spokesShown ? '' : s4SpokeNotes(report).join(' '),
    `★ = ${hub.name}, the inferred round-start station.`,
    'Dashed gold frame = the game border. Nothing outside it exists for this game.',
    'If your browser blocks the map library the map is omitted and everything below still works.',
  ];
  const caption = captionParts.filter((x) => x).join(' ');

  // Colour modes are exclusive — two ramps at once is mush and needs two legends —
  // so this is a radio group, not switches, and it says so instead of leaving the
  // reader to discover it.
  //
  // It offers exactly the modes THIS feed has a column for, and it exists whenever
  // that is more than none. Gating the whole group on reach alone lost the frequency
  // layer on any feed whose RAPTOR pass degraded — the per-stop headways still cross
  // in `#stops`, the legend block was still emitted, and nothing could ever switch
  // to it. Same rule as the stop cap, applied to the other column.
  // (Fixed 2026-08-23.)
  const modeButtons = join(
    el('wa-radio', esc('Plain'), { value: 'base', appearance: 'button', size: 's' }),
    reachDay === null
      ? ''
      : el('wa-radio', esc('Reach'), { value: 'reach', appearance: 'button', size: 's' }),
    // No Frequency button when the stop layer was dropped over `MAX_MAP_STOPS`: the
    // per-stop headways ride with the stops and there is nothing to colour. The
    // caption says so rather than leaving a control that does nothing.
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
    // switch. It ships unchecked: the spokes are context for a question the reader
    // has not asked yet, and the dots are the content. (2026-08-23.)
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
  // The plain-text twin of the table below, from the same `degRows` and therefore the
  // same digits — the copied artefact and the printed one can never disagree.
  const degText = degRows.map(([label, value]) => `${label} ${value}`).join('\n');

  // The border used to be a card of its own under the map, which printed the four
  // degrees a second time (§03's house rule was the third) and put the action a
  // scroll away from the thing it describes. It is on the map frame now: the two
  // copies are buttons in the toolbar, the coordinates are a collapsed disclosure in
  // the same card, and the pad/area sentence moved into "How to read this map" with
  // its provenance chip. `#geocopy` keeps its id. (R5, 2026-08-23.)
  const toolbar = el('div', join(
    // `#netlayers` so the runtime can take the whole layer group away when MapLibre
    // is blocked: a Colour by group and two switches for a map that was never drawn
    // are dead controls. The copy buttons beside them work without a map and stay.
    // (2026-08-23.)
    el('div', layerControls, {
      id: 'netlayers', className: 'wa-cluster wa-gap-s wa-align-items-center',
    }),
    el('div', join(
      // Slotted triggers, not the component's icon-only default: side by side the
      // two defaults are the same glyph twice, and the payloads are not
      // interchangeable — one is a GeoJSON Feature, the other four labelled
      // degrees. The old border card said which was which in its own copy; this
      // says it on the buttons. (Fixed 2026-08-23.)
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

  const howToRead = join(
    el('p', esc(caption), { className: 'wa-body-s wa-color-text-quiet' }),
    el('p', esc(
      'The border is the bounding box of the in-map stops padded by one hiding-zone '
      + `radius (${s4Dist(report, Number(border.padM || 0), 2)}), so every legal zone lies `
      + `wholly inside it. It covers ${s4Area(report, Number(border.areaSqM || 0))}. `
      + 'Copy GeoJSON pastes into geojson.io, Google My Maps or a GPX app; Copy '
      + 'coordinates gives the four labelled degrees as text.',
    ) + provChip('border'), { className: 'wa-body-s wa-color-text-quiet' }),
  );

  const mapCard = waCard(
    el('div', join(
      toolbar,
      el('div', '', { id: 'netmap', className: 'wa-border-radius-m' }),
      el('div', s4MapLegends(report, { stopsShown, ringsShown, spokesShown }), {
        id: 'netlegend',
        dataMode: reachDay === null ? 'base' : 'reach',
        className: 'wa-stack wa-gap-3xs',
      }),
      // A colour change on a <canvas> is invisible to a screen reader, so a PINNED
      // tile highlight says what it is showing, here, politely. Previews (hover and
      // focus) deliberately do not announce: tabbing across five tiles must not
      // narrate five times. Ships empty; `:empty` takes the row back. (2026-08-23.)
      el('p', '', {
        id: 'netpin',
        ariaLive: 'polite',
        className: 'wa-caption-s wa-color-text-quiet',
      }),
      // "What to notice", generated. The renderer's own copy is the representative
      // day's; once `score` lands, `renderDay()` swaps in the selected day's
      // pre-rendered variant from `DATA.days[k].map_caption_html`. `:empty` hides the
      // row on a feed with nothing to say. (R6, 2026-08-23.)
      el('div', s4MapCaption(report, bestKey), {
        id: 'netcaption', className: 'wa-body-s wa-color-text-quiet',
      }),
      waDetails('How to read this map', howToRead, { appearance: 'plain' }),
      waDetails('Exact coordinates', degrees, { appearance: 'plain', id: 'mapborder' }),
    ), { className: 'wa-stack wa-gap-s' }),
    {
      headerHtml: s4CardHeader(
        `${num(served)} served stops, ${num(zones.length)} hiding zones and the border`,
        `Everything that runs on a ${bestLabel}, the representative day. The reach layer `
        + 'follows the day selector. Copy the border — every player must use the same '
        + 'rectangle.',
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
  // subtraction: the count and the ids are carried precisely so this line and the
  // reach layer cannot disagree. It is a `network`-stage fact, so quoting it here does
  // not move this string at `rules` or `score`.
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
  // The stat rail's host, empty. app.js mounts `renderGlanceRail` into it in the same
  // hydration pass that mounts this section, and re-mounts it on its own clock
  // afterwards (`days`, `geo`, `rules`, `score` and every day click) without this
  // string — and therefore the map — moving at all.
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

// ═══════════════════════════════════════════════════════════════════════════════
// Re-exports — the day helpers app.js needs for day switching
// ═══════════════════════════════════════════════════════════════════════════════
//
// `s4DayView` / `s4DayOrder` / `s4DayLabel` / `s4BestDay` / `s4WorstDay` are defined in
// `./verdict.js` (the hero reads all five). They are re-exported here so a caller can
// take the whole day-switching surface from one module, and there is still exactly one
// implementation of each.

export {
  s4DayView, s4DayOrder, s4DayLabel, s4BestDay, s4WorstDay,
};
