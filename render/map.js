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
  esc, el, join, waCard, waScroller, waDetails, waSwitch, waCopyButton,
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
 */
const S4_HEADWAY_BINS = Object.freeze([
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
      v: num(g('nZones', (report.zones || []).length)),
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
      l: 'Zones reachable in the hiding period',
      n: `${num(reachN)} of ${num(served)} served stops are within `
        + `${num(size.hidingPeriodMin || 0)} minutes of the start location at `
        + `${departure}.`,
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
    + 'change the day; the rest are map-wide or come straight from the rulebook.';
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

  const lede = 'Round one starts wherever your group begins — this report assumes '
    + `${startName} — and a hiding run must end inside the `
    + `${hp}-minute hiding period. Later rounds start from the previous hider's zone, so `
    + 're-read these times from that stop rather than from the hub.';
  const answer = el('p', esc(
    `From ${startName} you have ${hp} minutes to get anywhere and hide. The chart below is `
    + 'how far that gets you; the grid under it is how long you wait for the ride '
    + 'back.',
  ), { className: 'wa-body-s' });
  return section('transit', S4_ORDINAL, 'Getting around',
    el('div', cards.join(''), { className: 'wa-stack wa-gap-s' }),
    { kicker: 'How long things take', lede, answerHtml: answer });
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · §05 THE MAP YOU'RE PLAYING ON (generate.py)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * §05 — the MapLibre network map plus the copy-pasteable border.
 *
 * Served stops as small circles, zone-cover centres as larger marked circles with their
 * radius drawn (behind a `wa-switch`), the hub as the ★ marker, and the border as a
 * dashed gold ring. Below it, a legend built as a `wa-cluster` of `.sw` swatches with
 * `role="list"`, and the border as decimal degrees *and* GeoJSON behind a
 * `wa-copy-button` — the rulebook's hard requirement is that every player uses the
 * exact same border.
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
 * `days` / `selectedDay`, `metrics` and `stops` — every one of them a `network`-stage
 * field, plus `geo.admin.countryCode` reaching it through `s4Dist`/`s4Area`. Quoting
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
  const radius = s4Dist(report, size.zoneRadiusM || 0, 2);

  const captionParts = [
    'Live basemap.',
    stopsShown
      ? `Grey dots = each of the ${num(served)} stops with service on the `
        + 'selected day (hover for the name and route count).'
      : `This feed has ${num(served)} served stops, more than the `
        + `${num(S4_MAX_MAP_STOPS)} this map draws individually, so only the `
        + `${num(zones.length)} zone centres are plotted.`,
    ringsShown
      ? `Blue dots = the ${num(zones.length)} designated hiding zones; the switch draws each `
        + `one's true ${radius} rulebook circle.`
      : `Blue dots = the ${num(zones.length)} designated hiding zones. There are too many to `
        + 'draw every circle, so the radius toggle is unavailable.',
    `★ = ${hub.name}, the inferred round-start station.`,
    'Dashed gold frame = the game border. Nothing outside it exists for this game.',
    'If your browser blocks the map library the map is omitted and everything below still works.',
  ];
  const caption = captionParts.join(' ');

  let controls = '';
  if (ringsShown) {
    controls = el('div', waSwitch(`Draw the ${radius} zone circles`, {
      checked: false, id: 'zonesw',
    }), { className: 'wa-cluster wa-gap-s' });
  }

  const legendItems = [];
  if (stopsShown) {
    legendItems.push([s4Swatch('background:var(--ink-2);border-radius:var(--wa-border-radius-circle)'), 'Served stop']);
  }
  legendItems.push(
    [s4Swatch('background:var(--accent);border-radius:var(--wa-border-radius-circle)'), 'Designated hiding zone'],
    [el('span', esc('★'), { style: 'color:var(--gold-deep);font-weight:800' }), hub.name],
    [s4Swatch('background:transparent;border:1.5px dashed var(--gold-deep)'), 'Game border'],
  );
  if (ringsShown) {
    // Python `legend_items.insert(-2, …)` — before the ★, after the zone dot.
    legendItems.splice(legendItems.length - 2, 0, [s4Swatch(
      'background:color-mix(in srgb, var(--accent) 18%, transparent);'
      + 'border:1px solid var(--accent)',
    ), 'Zone circle (toggle)']);
  }

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
  // The card leads with the action, not with four bare decimal degrees: the rulebook
  // is emphatic that every player must be using the identical border, and the way to
  // make that true is to copy it rather than retype it.
  const borderCard = waCard(
    el('div', join(
      el('p', esc('The rectangle you are playing in. Nothing outside it exists for this '
        + 'game.'), { className: 'wa-body-s' }),
      el('div', join(
        waCopyButton(geojsonText, { label: 'Copy the border', id: 'geocopy' }),
        el('span', esc('GeoJSON · paste into geojson.io, Google My Maps or a GPX app'),
          { className: 'wa-caption-xs wa-color-text-quiet' }),
      ), { className: 'wa-cluster wa-gap-s wa-align-items-center' }),
      waDetails('Exact coordinates', degrees, { appearance: 'plain' }),
      el('p', esc(
        'The border is the bounding box of the in-map stops padded by one hiding-zone '
        + `radius (${s4Dist(report, Number(border.padM || 0), 2)}), so every legal zone lies `
        + `wholly inside it. It covers ${s4Area(report, Number(border.areaSqM || 0))}.`,
      ) + provChip('border'), { className: 'wa-body-s wa-color-text-quiet' }),
    ), { className: 'wa-stack wa-gap-m' }),
    {
      headerHtml: s4CardHeader('The border, exactly',
        'Copy it. Every player must be using the same rectangle.'),
    },
  );

  const mapCard = waCard(
    el('div', join(
      el('div', '', { id: 'netmap', className: 'wa-border-radius-m' }),
      el('div', join(controls, s4Legend(legendItems)),
        { className: 'wa-split wa-align-items-center wa-flex-wrap wa-gap-s' }),
      waDetails('How to read this map',
        el('p', esc(caption), { className: 'wa-body-s wa-color-text-quiet' }),
        { appearance: 'plain' }),
    ), { className: 'wa-stack wa-gap-s' }),
    {
      headerHtml: s4CardHeader(
        `${num(served)} served stops and ${num(zones.length)} hiding zones`,
        'Every stop that runs on the selected day.',
      ),
    },
  );

  const shape = String(v.networkShape).split('-').join(' ');
  const lede = 'The raw playing field: every stop with service on the selected day, and the '
    + `${num(zones.length)} hiding zones one zone per `
    + `${radius} circle produces. `
    + `The network reads as ${shape}`
    + (hub.dominant
      ? `, with one station — ${hub.name} — touching ${pct(Number(hub.routeShare || 0))} of all routes`
      : ', with no single dominant interchange')
    + '.';
  const answer = el('p', esc(
    `${num(served)} stops run on the selected day, and they group into `
    + `${num(zones.length)} places you are allowed to hide. Copy the border before anyone `
    + 'draws a card.',
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
    join(el('div', join(mapCard, borderCard), { className: 'wa-stack wa-gap-s' }),
      glanceHost),
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
