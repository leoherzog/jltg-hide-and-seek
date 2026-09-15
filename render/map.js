/**
 * render/map.js — the map section (map plus `#glance` stat rail) and §06 Getting Around.
 *
 * Shared formatting and day-view helpers live in `./verdict.js`, so there is one
 * implementation of each.
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
  cmpStr, num, pct, mins, hhmm, prettyDate, quantile, jdump, fillPct, capWord, shapeWord,
  directionWord,
} from '../lib/core.js';

import {
  esc, el, join, waCard, waScroller, waDetails, waSwitch, waCopyButton, waButton,
  waCallout, waIcon, waBadge, waProgressBar, kpi, section, subhead, provChip, chip,
  linkChip, basisChip, degradeChip, iconLabel, legendRow, cardHeader, dataTable,
} from './html.js';

import {
  S4_ORDINAL, fnum,
  s4Dist, s4Area, s4Plural,
  s4Swatch,
  s4DayView, s4DayOrder, s4DayLabel, s4BestDay, s4LiveQuestions,
} from './verdict.js';

import { S4_STATUS_TAG, S4_STATUS_COUNT, S4_ACTION_TAG } from './deck.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Presentation constants
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

// Degradation thresholds, named so the legend cap chips can quote them.
/** Above this the map draws zone centres only. */
const S4_MAX_MAP_STOPS = 5000;
/** Above this the zone circles become dots only. */
const S4_MAX_MAP_ZONE_RINGS = 1200;
/** Above this no zone names are listed beside the unreachable-zone count chip. */
const S4_MAX_NAMED_ZONES = 6;

/** Above this the heatmap grid shows the busiest 25 and drawers the rest. */
const S4_MAX_HEATMAP_ROUTES = 25;
/** Below this the headway card has no method disclosure and adds the Transit Line "Our call" chip. */
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
 * accept. The copy button's payload only; the page prints the four labelled degrees.
 *
 * @param {number[]} bbox `[S, W, N, E]`
 * @returns {string}
 */
function s4BboxLine(bbox) {
  return bbox.map((x) => num(x, 6, { comma: false })).join(', ');
}

/**
 * Labelled degrees as a row of small stats: an upper-case caption over each value.
 * `size: 'xs'` is the compact form inside a callout.
 *
 * @param {ReadonlyArray<[string,string]>} rows `[label, formatted value]`
 * @param {{size?: 'm'|'xs'}} [opts]
 * @returns {string}
 */
function degreeCluster(rows, { size = 'm' } = {}) {
  const xs = size === 'xs';
  return el('div', rows.map(([label, value]) => el('span', join(
    el('span', esc(label), {
      className: xs ? 'wa-caption-2xs wa-text-uppercase' : 'wa-caption-xs wa-text-uppercase',
    }),
    el('b', esc(value), { className: xs ? 'wa-body-s' : 'wa-heading-xs' }),
  ), { className: 'wa-stack wa-gap-3xs' })).join(''), {
    className: xs ? 'wa-cluster wa-gap-l' : 'wa-cluster wa-gap-xl',
  });
}

/**
 * `#border-suggest` — the worker found a tighter border and this is the offer: the
 * whole network beside the reachable core, what is left out, then two actions. Copy
 * the four numbers, and `#suggest-rerun`, which app.js wires (CONTRACT §05). The
 * re-run is a fresh document load replaying the sources from the feed cache, so a
 * chosen `File` cannot survive it, and the note says so instead of failing later.
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
  const whole = s4DayView(report, sb.dayKey);
  const byFeed = Array.isArray(sb.trimmedByFeed) ? sb.trimmedByFeed : [];
  // "mostly X (n)" only informs when there is more than one feed to attribute to.
  const mostly = byFeed.length > 1 && byFeed[0]
    ? ` · mostly ${byFeed[0].agencyName} (${num(byFeed[0].count)})`
    : '';
  const sizeBadge = (name) => waBadge(String(name || '—').toUpperCase(),
    { variant: 'neutral', appearance: 'outlined' });
  const crossMins = (x) => (fnum(x) === null ? '—' : mins(Number(x)));
  const grid = dataTable(['', 'Whole network', 'Reachable core'], [
    [esc('Size'), sizeBadge(size.name), sizeBadge(sb.sizeName)],
    [esc('Area'), esc(s4Area(report, Number(whole.hullSqM || 0))),
      esc(s4Area(report, Number(vote.hullSqM || 0)))],
    [esc('Zones'), esc(num(fnum(whole.nZones) ?? (report.zones || []).length)),
      esc(num(vote.nZones || 0))],
    [esc('Time to cross'), esc(crossMins(whole.t90Min)), esc(crossMins(vote.t90Min))],
  ]);
  const facts = el('div', join(
    chip(`${num(sb.coreStops || 0)} of ${num(sb.allServedStops || 0)} stops kept`, 'location-dot'),
    chip(`${pct(Number(sb.eventShare || 0), 0)} of departures`, 'bus'),
    chip(`${num(sb.trimmedStops || 0)} outside${mostly}`, 'scissors'),
  ), { className: 'wa-cluster wa-gap-2xs' });
  const origin = markers(
    iconLabel('star', startStopName(report)),
    iconLabel('clock', `${num(sb.hidingPeriodMin || 0)} min reach`),
    iconLabel('calendar-day', s4DayLabel(report, sb.dayKey)),
  );

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
    ? join(waIcon('file-circle-xmark'), esc('Re-run needs a URL feed. A chosen file can’t '
      + 'survive the reload, so copy the border into the landing fields.'))
    : '', {
    id: 'suggest-note', role: 'status', tabindex: '-1',
    className: 'wa-caption-s wa-color-text-quiet',
  });

  return waCallout(join(
    el('p', esc('A tighter border is on offer.'), { className: 'wa-heading-s' }),
    origin,
    grid,
    facts,
    degreeCluster([
      ['South', num(sb.bbox[0], 6, { comma: false })], ['West', num(sb.bbox[1], 6, { comma: false })],
      ['North', num(sb.bbox[2], 6, { comma: false })], ['East', num(sb.bbox[3], 6, { comma: false })],
    ], { size: 'xs' }),
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
// S4 · SHARED MARKUP HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The map legend: `render/html.js` `legendRow` over `[swatchHtml, plainText]` items.
 * The `<ul>`'s `native.css` margin is zeroed only inside a `wa-cluster`/`wa-stack` parent.
 * @param {ReadonlyArray<[string,string,string?]>} items
 * @param {Object} [opts] `legendRow`'s
 * @returns {string}
 */
export function s4Legend(items, opts = {}) {
  return legendRow(Array.from(items), opts);
}

/** A quiet one-line cluster of markers; '' when every part is empty. */
function markers(...parts) {
  const html = join(...parts);
  return html ? el('div', html, { className: 'wa-cluster wa-gap-s wa-caption-xs' }) : '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · PER-DAY VIEWS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The `DaySummary` (CONTRACT §(d)) for one key, or `null`.
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
 * on tiles that name a fact the map can point at. `n` is the one clause under the
 * value (`nHtml`, when set, is that clause as markup), `more` the folded remainder,
 * `sub` a visible sub-figure, `fill` a 0–100 bar from `fillPct` and `chips` markup
 * that stays visible beside the note.
 *
 * @param {Object} report @param {string} dayKey
 * @returns {Array<{g:string,day:string,prov:string,v:string,l:string,n:string,
 *                  nHtml?:string,more?:string,sub?:string,fill?:number,chips?:string,
 *                  hl?:string}>}
 */
export function s4Tiles(report, dayKey) {
  const v = s4DayView(report, dayKey);
  const size = report.size || {};
  const nTotalRoutes = feedRouteCount(report);
  const questions = report.questions || [];
  const curses = report.curses || [];
  const catalogue = questions.length;
  const live = s4LiveQuestions(report);
  const removed = curses.filter((c) => c.action === 'remove').length;
  const radius = s4Dist(report, size.zoneRadiusM || 0, 2);
  const border = report.border || {};

  /** `v.get(key, default)` — null and undefined both mean absent. */
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
  const nZones = Math.trunc(Number(g('nZones', (report.zones || []).length)));
  const reach = s4ReachDay(report, dayKey);
  const startName = startStopName(report);
  const asOf = (report.provenance || {}).asOf || '';
  const repDate = String(g('date', asOf) || '') || '20000101';
  const departure = String((report.opts || {}).departure || '').slice(0, 5);
  const sizeWord = String(size.name || '').toUpperCase();

  const warned = curses.filter((c) => c.action === 'warn').length;
  const talked = curses.filter((c) => c.action === 'player-choice').length;
  const unserved = fnum(g('unservedStops'));
  const hpMin = num(size.hidingPeriodMin || 0);

  // Only non-zero statuses, in deck.js's degradation order, each carrying its status key.
  const statusRow = el('a', ['functional', 'weak', 'degenerate', 'dead', 'unknown'].map((k) => {
    const n = questions.filter((q) => q.status === k).length;
    return n ? el('span', iconLabel(S4_STATUS_TAG[k][1], `${num(n)} ${S4_STATUS_COUNT[k]}`),
      { dataStatus: k }) : '';
  }).join(''), { className: 'wa-link-plain wa-cluster wa-gap-s', href: '#questions' });
  const rulesMark = el('span', join(waIcon('book'), esc('From the rules')),
    { className: 'tile-tag', dataBasis: 'rulebook' });

  return [
    {
      g: 'map',
      day: '1',
      prov: 'A1',
      hl: 'zones',
      v: num(nZones),
      l: 'Hiding zones',
      n: `One per ${radius} circle over served stops`,
    },
    {
      g: 'map',
      day: '1',
      prov: 'feed',
      hl: 'stops',
      v: `${num(served)} / ${num(inFeed)}`,
      l: 'Stops served / in the feed',
      n: unserved === null ? '' : `${num(unserved)} with no departures`,
    },
    {
      g: 'map',
      day: '1',
      prov: 'feed',
      v: `${num(g('routes', 0))} of ${num(nTotalRoutes)}`,
      l: 'Routes running',
      n: `At least one trip on ${prettyDate(repDate)}`,
    },
    {
      g: 'map',
      day: '',
      prov: 'feed',
      hl: 'extent',
      v: s4Area(report, hull),
      l: 'Map area',
      n: 'Tight outline around every served stop',
      sub: `Border box · ${s4Area(report, Number(border.areaSqM || 0))}`,
      more: 'The border is a box rather than the hull, because a rectangle is what '
        + 'players can agree on.',
    },
    {
      g: 'map',
      day: '',
      prov: 'feed',
      hl: 'extent',
      v: s4Dist(report, diameter),
      l: 'Network diameter',
      n: 'Straight line, furthest two stops',
    },
    {
      g: 'clock',
      day: '1',
      prov: 'D1',
      v: `${hhmm(firstS)}–${hhmm(lastS)}`,
      l: 'Service window',
      n: `${num(spanH, 1)} h end to end`,
      chips: iconLabel('moon', `Last bus ${hhmm(medLast)} · median stop`),
    },
    {
      g: 'clock',
      day: '1',
      prov: 'C1',
      v: headway !== null && headway !== undefined ? mins(headway) : '—',
      l: 'Median headway per stop',
      n: 'All routes · 06:00–22:00',
      chips: (worstGap !== null && worstGap !== undefined)
        ? iconLabel('hourglass-half', `Worst gap ${mins(worstGap)} · median stop`)
        : '',
    },
    {
      g: 'clock',
      day: '1',
      prov: 'C3',
      hl: 'frequency',
      v: pct(freqShare),
      l: 'Stops on a 15-minute route',
      fill: fillPct(freqShare),
      n: `${num(freqStops)} stops with a bus every 15 min or better`,
    },
    {
      g: 'clock',
      day: '',
      prov: 'rulebook',
      v: `${hpMin} min`,
      l: 'Hiding period',
      n: '',
      nHtml: el('span', join(
        waBadge(sizeWord || '—', { variant: 'neutral', appearance: 'outlined' }),
        iconLabel('circle-dot', `${radius} zones`),
        iconLabel('layer-group', `${num(size.catalogueSize || 0)} questions`),
        iconLabel('camera', `${num(size.photoLimitMin || 0)} min per photo`),
      ), { className: 'wa-cluster wa-gap-s wa-align-items-center' }),
      chips: rulesMark,
    },
    {
      g: 'clock',
      day: '1',
      prov: 'A2',
      hl: 'reach',
      v: pct(reachShare),
      // The value is a share of ZONES, so the note counts zones from the worker's
      // `reachableZones`; the looser by-stop count folds into `More`.
      l: 'Zones reachable in the hiding period',
      fill: reach === null ? null : fillPct(reachShare),
      n: (reach === null
        ? `${num(reachN)} of ${num(served)} served stops within ${hpMin} min at ${departure}`
        : `${num(reach.reachableZones)} of ${num(nZones)} zones · from ${startName} at ${departure}`),
      more: reach === null ? ''
        : `Counted by stop instead of by zone, ${num(reachN)} of ${num(served)} are reachable. `
          + 'A stop counts if any bus reaches it; a zone needs its centre stop.',
      chips: reach === null ? degradeChip('reach_not_measured') : '',
    },
    {
      g: 'deck',
      day: '',
      prov: 'B1',
      v: `${num(live)} of ${num(catalogue)}`,
      l: 'Questions that work here',
      n: '',
      nHtml: statusRow,
    },
    {
      g: 'deck',
      day: '',
      prov: 'curses',
      v: `${num(removed)} of ${num(curses.length)}`,
      l: 'Curses to take out of the deck',
      n: '',
      nHtml: el('span', join(
        iconLabel(S4_ACTION_TAG.warn[1], `${num(warned)} ${S4_ACTION_TAG.warn[0]}`),
        iconLabel(S4_ACTION_TAG['player-choice'][1],
          `${num(talked)} ${S4_ACTION_TAG['player-choice'][0]}`),
      ), { className: 'wa-cluster wa-gap-s' }),
    },
  ];
}

/**
 * The tile grid's inner markup for one day, in its three labelled groups. Grouping
 * happens here, not around `#tiles`, because `renderDay()` replaces that container's
 * `innerHTML` wholesale.
 *
 * One clause sits under the value; sub-figures and chips stay visible, and only a
 * rationale folds into `More`.
 *
 * The deck group's tiles count questions and curses, which do not exist until the
 * `rules` stage; they are skeletons until then, so the rail neither prints "0 of 0"
 * nor changes height when the audit arrives.
 *
 * @param {Object} report @param {string} dayKey @returns {string}
 */
export function s4TilesHtml(report, dayKey) {
  const tiles = s4Tiles(report, dayKey);
  const dayChip = dayMarker();
  const pending = !(report.questions || []).length;
  const groups = [];
  for (const [key, title] of S4_TILE_GROUPS) {
    const cards = (key === 'deck' && pending)
      ? S4_DECK_SKELETON_WIDTHS.map(([a, b]) => el('div', join(
        el('wa-skeleton'),
        el('wa-skeleton', '', { style: `inline-size:${a}` }),
        el('wa-skeleton', '', { style: `inline-size:${b}` }),
      ), { className: 'sk-tile' }))
      : tiles.filter((t) => t.g === key).map((t) => {
        // The provenance superscript cites the value, so it stays on the clause
        // under it rather than moving into the disclosure.
        const note = (t.nHtml || esc(t.n)) + provChip(t.prov);
        const bar = (t.fill ?? null) === null ? '' : waProgressBar(t.fill, { label: t.l });
        const more = t.more
          ? waDetails('More', el('p', esc(t.more), { className: 'wa-body-s wa-color-text-quiet' }), {
            className: 'tile-more', appearance: 'plain',
          })
          : '';
        return waCard(
          join(
            kpi(t.v, t.l, note, {
              chipHtml: join(t.day ? dayChip : '', bar),
              subHtml: t.sub ? esc(t.sub) : '',
            }),
            t.chips ? el('div', t.chips, { className: 'wa-cluster wa-gap-2xs wa-caption-xs' }) : '',
            more,
          ),
          { dataDaySensitive: t.day ? true : null, dataHl: t.hl || null },
        );
      });
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
// S4 · AT A GLANCE — the stat rail, inside the map section
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
  // The hover hint is its own `<p id="glance-hover-note">` after the key: app.js removes it when
  // MapLibre never loads, and the rest of the key is true either way.
  const key = legendRow([
    [dayMarker(), ''],
    [waIcon('lock'), 'same every day'],
  ], { label: 'Tile key' });
  const hoverNote = el('p', join(waIcon('hand-pointer'), esc('Hover a tile to highlight it on the map. '),
    el('kbd', esc('Enter')), esc(' pins it.')), {
    className: 'wa-caption-xs wa-color-text-quiet', id: 'glance-hover-note',
  });
  return el('div', join(
    subhead('At a glance'),
    key,
    hoverNote,
    grid,
  ), { id: 'glance', className: 'wa-stack wa-gap-s' });
}

/**
 * The day-sensitive tile marker. A plain marker, not a `chip()`: a bordered tag beside
 * a big number reads as a control the reader can press.
 * @returns {string}
 */
function dayMarker() {
  return el('span', join(waIcon('calendar-day'), esc('changes by day')), {
    className: 'tile-tag',
    title: 'Measured on the selected service day',
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · §06 GETTING AROUND
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
      // Leading/trailing spaces and middots only.
      longName = `${longName} · ${directionWord(h.directionId)}`.replace(/^[ ·]+|[ ·]+$/g, '');
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
 * @param {Object} report @param {string} methodHtml
 * @param {string} [leadHtml] a visible marker row above the legend
 * @returns {string}
 */
export function s4Heatmap(report, methodHtml, leadHtml = '') {
  const rows = s4HeatmapRows(report);
  const shown = rows.slice(0, S4_MAX_HEATMAP_ROUTES);
  const extra = rows.slice(S4_MAX_HEATMAP_ROUTES);
  // the fills live on `[data-hb]` alone (styles.css), so a `.sw` key needs no override.
  const legend = join(leadHtml, s4Legend([
    ...S4_HEADWAY_BINS.map(([, binId, label]) => [
      el('span', '', { className: 'sw', dataHb: binId }), label,
    ]),
    [el('span', '', { className: 'sw', dataHb: 'none' }), 'No service that day'],
  ], { label: 'Headway key' }));
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

  const bestKey = s4BestDay(report);
  const bestLabel = s4DayLabel(report, bestKey);
  const assumed = Boolean((report.metrics || {}).assumedSchedule);

  if (samples.length) {
    // The chart's accessible description keeps the full reading; the page shows the key.
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
      [s4Swatch('background:var(--accent)'), `Fits ${hp} min`],
      [s4Swatch('background:var(--gold-mark)'), 'Fits, past ¾ of window or 2 changes'],
      [s4Swatch('background:var(--crit)'), 'Busts the window'],
      [s4Swatch('background:transparent;border:1.5px dashed var(--baseline)'),
        'No service that day'],
      [s4Swatch('background:transparent;border-block-start:1.5px dashed var(--baseline);'
        + 'border-radius:0'), `${hp}-min hiding period`],
    ], { label: 'Ride-time key' });
    const method = el('ul', join(
      el('li', iconLabel('calendar-check', 'Scheduled, not observed — a centre point, not a ceiling')),
      el('li', iconLabel('shuffle', 'Real bus sequences, transfer waits included')),
      el('li', iconLabel('repeat', `Same ${num(samples.length)} destinations every day`)),
    ), { className: 'wa-stack wa-gap-3xs wa-caption-xs wa-list-plain', role: 'list' });
    cards.push(waCard(
      el('div', join(
        assumed ? el('div', degradeChip('assumed_schedule'), { className: 'wa-cluster' }) : '',
        waScroller(chart),
        legend,
        waDetails('How to read this chart', method, { appearance: 'plain' }),
      ), { className: 'wa-stack wa-gap-s' }),
      {
        headerHtml: cardHeader('Ride time from start', {
          captionHtml: el('span', join(
            waBadge(`${num(samples.length)} destinations`, { variant: 'neutral', appearance: 'outlined' }),
          ), { className: 'wa-cluster wa-gap-s wa-align-items-center' }),
        }),
      },
    ));
  }

  const headways = report.routeHeadways || [];
  const nRoutes = headways.length;
  const subtitle = 'Minutes between buses · per route-direction · per day';
  const windowChip = chip('Median per route-direction · 10:00–14:00', 'clock');
  if (nRoutes >= S4_MIN_HEATMAP_ROUTES) {
    // Wording matches the "Median …" chip above; keep it consistent in the method text.
    const method = waDetails('How to read this', join(
      el('p', esc("Median minutes between departures at the route's own stops between 10:00 "
        + 'and 14:00. Medians, not averages: a route that runs every 10 minutes at rush hour '
        + 'and hourly at noon averages out to a figure that describes neither, and midday is '
        + 'when you will be playing.'), { className: 'wa-body-s wa-color-text-quiet' }),
      el('p', iconLabel('hand-pointer', 'Hover a cell for its trip count'), { className: 'wa-caption-xs' }),
    ), { appearance: 'plain' });
    const extra = s4HeatmapRows(report).slice(S4_MAX_HEATMAP_ROUTES).length;
    const badge = extra
      ? waBadge(`busiest ${num(S4_MAX_HEATMAP_ROUTES)} shown · ${num(extra)} more below`,
        { variant: 'neutral', appearance: 'outlined' })
      : '';
    cards.push(waCard(s4Heatmap(report, method, el('div', windowChip, { className: 'wa-cluster' })), {
      headerHtml: cardHeader('How often the buses come', { caption: subtitle, chipsHtml: badge }),
    }));
  } else if (nRoutes) {
    cards.push(waCard(el('div', join(
      s4Heatmap(report, '', el('div', windowChip, { className: 'wa-cluster' })),
      el('div', join(
        chip('Transit Line ≈ always the same answer', 'equals', { appearance: 'filled' }),
        basisChip('interp'),
      ), { className: 'wa-cluster wa-gap-2xs' }),
    ), { className: 'wa-stack wa-gap-s' }), {
      headerHtml: cardHeader('How often the buses come', { caption: 'Too few routes to compare' }),
    }));
  }

  if (!cards.length) return '';

  const fit = samples.filter((smp) => {
    const cell = (smp.perDay || {})[bestKey];
    return cell && cell.minutes !== null && cell.minutes !== undefined
      && Number(cell.minutes) <= Number(size.hidingPeriodMin || 0);
  }).length;
  const headway = fnum(s4DayView(report, bestKey).medianHeadwayMin);
  // One sentence from two halves, concatenated as strings so no separator creeps in.
  const fitHalf = samples.length
    ? `${el('b', esc(`${num(fit)} of ${num(samples.length)}`))} sample rides fit the `
      + `${esc(hp)}-min window on a ${esc(bestLabel)}`
    : '';
  const headwayHalf = headway === null ? ''
    : `${samples.length ? '; the' : 'The'} median stop sees a bus every ${el('b', esc(mins(headway)))}`;
  const answer = el('p', `${fitHalf}${headwayHalf}.`, { className: 'wa-body-s' });
  const ledeMarks = join(
    iconLabel('star', startName),
    departure ? iconLabel('clock', departure) : '',
    linkChip('#network', 'Same start as the map', 'map-location-dot'),
  );
  return section('transit', S4_ORDINAL, 'Getting around',
    el('div', cards.join(''), { className: 'wa-stack wa-gap-s' }),
    {
      kicker: 'How long things take',
      lede: 'Later rounds start from the last hider’s zone. Re-read from there.',
      ledeHtml: ledeMarks,
      answerHtml: (samples.length || headway !== null) ? answer : '',
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · §05 THE MAP YOU'RE PLAYING ON
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
 * "What to notice" — chips under the map: how many zones the hiding period cannot
 * reach (with their names when there are few) and whether another service day is
 * worse. On the day §05's answer line already counts, the count chip is left out and
 * the names carry a label chip instead, so the card never restates the callout.
 *
 * NETWORK-STAGE FACTS ONLY (`zones`, `zoneReach`, `size`): this string renders inside §05, and a string that moves at `rules`
 * or `score` re-mounts the section and tears down the MapLibre instance.
 *
 * It counts, filters, sorts and slices; it does no arithmetic. Every quantity is
 * carried or the length of a filtered list — the third chip is a filter over two
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
  const zones = r.zones || [];
  if (!zones.length || !size.hidingPeriodMin) return '';
  const hp = num(size.hidingPeriodMin);
  const label = s4DayLabel(r, dayKey);
  // §05's answer line counts the unreachable zones for this day already.
  const answerDay = dayKey === s4BestDay(r);
  const items = [];
  let names = '';

  // ── 1. reach ────────────────────────────────────────────────────────────────
  const reach = s4ReachDay(r, dayKey);
  if (reach !== null) {
    const missed = reach.unreachableZoneIds || [];
    if (!missed.length) {
      if (!answerDay) {
        items.push(chip(`All ${num(zones.length)} zones reachable · ${hp} min · ${label}`,
          'circle-check', { variant: 'success' }));
      }
    } else {
      // The ids arrive sorted, so the naming is sorted too. Naming stops at
      // `S4_MAX_NAMED_ZONES`: "A, B and 141 others" is a number wearing two names.
      const byId = new Map(zones.map((z) => [z.zoneId, z.name || z.zoneId]));
      const named = missed.length <= S4_MAX_NAMED_ZONES
        ? missed.map((id) => String(byId.get(id) || id))
        : [];
      const rest = named.slice(5);
      if (!answerDay) {
        items.push(chip(`${num(missed.length)} of ${num(zones.length)} zones out of reach · ${hp} min · ${label}`,
          'circle-xmark', { variant: 'danger' }));
      }
      // The names are their own row: five name chips, then one `+N more`. On the answer
      // line's day there is no count chip above them, so a label chip leads the row.
      names = join(
        answerDay && named.length ? chip('Out of reach', 'circle-xmark', { variant: 'danger' }) : '',
        ...named.slice(0, 5).map((name) => chip(name, 'location-dot')),
        rest.length ? linkChip('#netmap', `+${num(rest.length)} more`) : '',
      );
    }
  }

  // The hub is not repeated here: §05's lede chips already name it (or its absence).

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
    items.push(chip(`${num(worstExtra)} more ${s4Plural(worstExtra, 'zone')} out of reach · `
      + s4DayLabel(r, worstKey), 'calendar-xmark', { variant: 'warning' }));
  }

  if (!items.length) return '';
  const row = (html) => el('div', html, { className: 'wa-cluster wa-gap-2xs wa-align-items-center' });
  return el('div', join(row(items.join('')), names ? row(names) : ''), { className: 'wa-stack wa-gap-2xs' });
}

/**
 * What the map leaves undrawn, one `[text, icon, variant]` chip spec per cap, each
 * with its own count. `MAX_MAP_SPOKES` is applied worker-side (lib/core.js), so a
 * capped feed never ships the dropped polylines, and without the chip a layer that
 * draws part of the network is indistinguishable from a broken one.
 *
 * @param {Object} report
 * @param {{stopsShown?: boolean, ringsShown?: boolean, spokesShown?: boolean}} [flags]
 * @returns {Array<[string,string,string]>}
 */
export function s4CapNotes(report, flags = {}) {
  const {
    stopsShown = true, ringsShown = true,
    spokesShown = ((report && report.routeSpokes) || []).length > 0,
  } = flags;
  const out = [];
  if (!stopsShown) {
    out.push([`Stops hidden over ${num(S4_MAX_MAP_STOPS)} · Frequency layer off`, 'eye-slash', 'warning']);
  }
  if (!ringsShown) {
    out.push([`Circles hidden over ${num(S4_MAX_MAP_ZONE_RINGS)} zones`, 'eye-slash', 'warning']);
  }
  const cap = (report && report.spokeCap) || null;
  if (cap && spokesShown) {
    if (Number(cap.shown || 0) < Number(cap.total || 0)) {
      out.push([`Busiest ${num(cap.shown)} of ${num(cap.total)} route-directions drawn`,
        'filter', 'neutral']);
    }
    if (cap.source === 'stops') out.push(['Spokes follow stop order, not roads', 'bezier-curve', 'warning']);
  }
  return out;
}

/**
 * The map's legend, one block per colour mode plus the always-on items. Every block
 * is emitted; `#netlegend[data-mode]` decides which is visible, and the runtime
 * writes that attribute when the `#colourby` radio moves.
 *
 * The reach block's labels and colours are §06's ride-chart legend's: the map and the
 * chart are two pictures of one measurement and may not use two vocabularies. Counts
 * appear here, in the base labels, and nowhere else on the card.
 *
 * @param {Object} report
 * @param {{stopsShown: boolean, ringsShown: boolean, spokesShown: boolean,
 *          suggestShown?: boolean}} flags
 * @returns {string}
 */
export function s4MapLegends(report, flags) {
  const { stopsShown, ringsShown, spokesShown, suggestShown = false } = flags;
  const hub = report.hub || {};
  const size = report.size || {};
  const border = report.border || {};
  const hp = num(size.hidingPeriodMin || 0);
  const bestKey = s4BestDay(report);
  const reachDay = s4ReachDay(report, bestKey);
  const startId = (report.opts && report.opts.startStopId) || '';
  const startIsHub = !startId || startId === hub.stopId;

  // A legend block: the swatch list in its own `wa-cluster` parent (the <ul> relies on
  // that for its margins), then an optional visible marker row.
  const block = (mode, items, afterHtml, label) => el('div', join(
    el('div', s4Legend(items, { label }), { className: 'wa-cluster wa-gap-m' }),
    afterHtml,
  ), { dataLegendFor: mode, className: 'wa-stack wa-gap-3xs' });

  const always = [];
  if (ringsShown) {
    always.push([s4Swatch(
      'background:color-mix(in srgb, var(--accent) 18%, transparent);'
      + 'border:1px solid var(--accent)',
    ), 'Zone circle']);
  }
  if (spokesShown) {
    // Two swatches: a plain route line, and the gold heavier line of a route that
    // calls at the hub.
    always.push(
      [s4Swatch('background:var(--ink-2);block-size:2px;border-radius:1px'), 'Route line · selected day'],
      [s4Swatch('background:var(--gold-deep);block-size:3px;border-radius:1px'),
        'Route calling at the ★ hub'],
    );
  }
  always.push([el('span', esc('★'), { style: 'color:var(--gold-deep);font-weight:800' }),
    `${hub.name} · ${!startId ? 'assumed start' : (startId === hub.stopId ? 'start' : 'hub')}`]);
  // A fallback box also carries border_not_applied.
  const borderSwatch = s4Swatch('background:transparent;border:1.5px dashed var(--gold-deep)');
  if (border.derivation === 'option_fallback') {
    always.push([borderSwatch, 'Your box — not applied'], [degradeChip('border_not_applied'), '']);
  } else {
    // The toolbar chips carry the basis and the padding.
    always.push([borderSwatch, border.derivation === 'option' ? 'Your border box' : 'Game border']);
  }
  // The suggested frame is a thinner, SOLID gold line, so the two gold rectangles
  // read as different things.
  if (suggestShown) {
    always.push([s4Swatch('background:transparent;border:1px solid var(--gold-deep)'),
      'Suggested border']);
  }

  const zones = report.zones || [];
  const baseItems = [];
  if (stopsShown) {
    baseItems.push([s4Swatch('background:var(--ink-2);border-radius:var(--wa-border-radius-circle)'),
      `Served stop · ${num(servedStopCount(report, s4DayByKey(report, bestKey)))}`]);
  }
  baseItems.push([s4Swatch('background:var(--accent);border-radius:var(--wa-border-radius-circle)'),
    `Hiding zone · ${num(zones.length)}`]);

  const blocks = [block('base', baseItems, '', 'Map key')];

  if (reachDay !== null) {
    // Every key draws exactly what the canvas draws: three carry the ring the map
    // strokes (fills alone are 1.5:1 on a pale basemap), and the no-journey key is
    // SOLID because MapLibre has no dash on a circle stroke.
    //
    // The gold label differs from §06's on purpose: the chart also bins on transfers,
    // this layer bins on the window alone.
    blocks.push(block('reach', [
      [s4Swatch('background:var(--accent);border-radius:var(--wa-border-radius-circle)'),
        `Fits ${hp} min`],
      [s4Swatch('background:var(--gold-mark);border:1.4px solid var(--gold-deep);'
        + 'border-radius:var(--wa-border-radius-circle)'),
        'Fits, past ¾ of window'],
      [s4Swatch('background:var(--crit);border:1.6px solid var(--ink);'
        + 'border-radius:var(--wa-border-radius-circle)'),
        'Busts the window'],
      [s4Swatch('background:transparent;border:1.5px solid var(--ink-2);'
        + 'border-radius:var(--wa-border-radius-circle)'),
        'No journey'],
    ], markers(
      iconLabel('clock',
        `Scheduled ride time from ${startIsHub ? '★' : startStopName(report)} on the selected day`),
      linkChip('#transit', 'Ride chart', 'chart-bar'),
    ), 'Reach key'));
  }

  // Names its window: per stop, all routes, 06:00–22:00, not the grid's 10:00–14:00.
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
    ], markers(
      iconLabel('location-dot', 'Median headway per stop · all routes · 06:00–22:00 · selected day'),
      linkChip('#transit', 'Route grid · 10:00–14:00', 'not-equal', { variant: 'warning' }),
    ), 'Frequency key'));
  }

  // The always-on block carries the cap and reach chips, because no colour mode hides them.
  const capChips = join(
    ...s4CapNotes(report, { stopsShown, ringsShown, spokesShown })
      .map(([text, icon, variant]) => chip(text, icon, { variant })),
    reachDay === null ? degradeChip('reach_not_measured') : '',
  );
  blocks.push(block('always', always,
    capChips ? el('div', capChips, { className: 'wa-cluster wa-gap-2xs' }) : '', 'Always shown'));
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
  const departure = String((report.opts || {}).departure || '').slice(0, 5);
  const hpMin = num(size.hidingPeriodMin || 0);

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
    // stops and there is nothing to colour. The legend's cap chip says so.
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
    ringsShown ? waSwitch(`Zone circles · ${radius}`, { checked: false, id: 'zonesw' }) : '',
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
  const degrees = degreeCluster(degRows);

  const geojsonText = jdump(border.geojson);
  // The plain-text twin of the table, from the same `degRows` and therefore the same
  // digits: the copied artefact and the printed one can never disagree.
  const degText = degRows.map(([label, value]) => `${label} ${value}`).join('\n');

  // `Border.derivation` (CONTRACT §(b)): `'option'` is the reader's rectangle used as
  // given, with no padding; `'reach'` is the inferred, padded box; `'option_fallback'`
  // is a box that kept under `IN_PLAY_MIN_SHARE` of the served stops, so the worker
  // measured the whole network instead — and that must never be silent.
  const fallback = border.derivation === 'option_fallback';
  const padDist = s4Dist(report, Number(border.padM || 0), 2);
  const borderChips = fallback ? ''
    : join(
      border.derivation === 'option'
        ? chip('Your box · no padding', 'draw-polygon')
        : join(basisChip('interp'), chip(`Border padded ${padDist}`, 'draw-polygon')),
      provChip('border'),
    );

  const toolbar = el('div', join(
    // `#netlayers` so the runtime can remove the whole layer group when MapLibre is
    // blocked; the copy buttons beside them work without a map and stay.
    el('div', layerControls, {
      id: 'netlayers', className: 'wa-cluster wa-gap-s wa-align-items-center',
    }),
    el('div', join(
      borderChips,
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

  const fallbackCallout = fallback
    ? waCallout(join(
      degradeChip('border_not_applied'),
      el('p', esc('Your box kept under half the served stops, so it is drawn but not applied. '
        + 'Every count below is for the whole network.')
        + provChip('border'), { className: 'wa-body-s' }),
    ), { variant: 'warning', icon: 'triangle-exclamation' })
    : '';

  const borderArea = s4Area(report, Number(border.areaSqM || 0));
  const borderDetail = fallback
    ? `The box you drew, with no padding. It covers ${borderArea}.`
    : border.derivation === 'option'
      ? `The box you drew on the landing map, used as given. It covers ${borderArea}.`
      : `A box around every served stop, padded ${padDist} so each hiding zone sits wholly `
        + `inside it. It covers ${borderArea}.`;
  const howToRead = join(
    el('p', esc(borderDetail) + provChip('border'), { className: 'wa-body-s wa-color-text-quiet' }),
    el('ul', join(
      el('li', iconLabel('copy', 'Copy GeoJSON pastes into geojson.io, Google My Maps or a GPX app')),
      el('li', iconLabel('copy', 'Copy coordinates pastes into the landing map’s border fields')),
      stopsShown ? el('li', iconLabel('hand-pointer', 'Hover a stop for its name and route count')) : '',
    ), { className: 'wa-stack wa-gap-3xs wa-caption-xs wa-list-plain', role: 'list' }),
  );

  const follows = reachDay !== null && spokesShown ? 'changes by day'
    : reachDay !== null ? 'reach changes by day'
      : spokesShown ? 'spokes change by day' : '';
  const headerCaption = el('span', join(
    iconLabel('star', startName),
    departure ? iconLabel('clock', departure) : '',
    chip(bestLabel, 'calendar-day'),
    follows ? el('span', join(waIcon('calendar-day'), esc(follows)), { className: 'tile-tag' }) : '',
  ), { className: 'wa-cluster wa-gap-s wa-align-items-center' });

  const mapCard = waCard(
    el('div', join(
      toolbar,
      fallbackCallout,
      // The frame is what the blocked-map callout targets (app.js `giveUp`), and what
      // the print block keeps when it hides `#netmap`; index.html's skeleton uses the
      // same id.
      el('div', el('div', '', { id: 'netmap', className: 'wa-border-radius-m' }),
        { id: 'netmap-frame' }),
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
    { headerHtml: cardHeader('Network map and border', { captionHtml: headerCaption }) },
  );

  const shape = shapeWord(v.networkShape);
  const ledeChips = join(
    shape ? chip(capWord(shape), 'diagram-project') : '',
    hub.dominant
      ? chip(`${hub.name} · ${pct(Number(hub.routeShare || 0))} of routes`, 'star')
      : chip('No dominant interchange', 'circle-nodes'),
  );
  // `unreachableZoneIds.length` is a lookup on a worker-computed list, not a
  // subtraction, and a `network`-stage fact, so it does not move this string later.
  const missed = reachDay === null ? null : reachDay.unreachableZoneIds.length;
  const answer = el('p', missed === null
    ? `${el('b', esc(num(zones.length)))} hiding zones over ${el('b', esc(num(served)))} served `
      + `stops on a ${esc(bestLabel)}.`
    : `${el('b', esc(num(zones.length)))} hiding zones on a ${esc(bestLabel)}, `
      + `${el('b', esc(num(missed)))} of them out of reach in ${esc(hpMin)} min.`,
  { className: 'wa-body-s' });
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
    {
      kicker: 'The network', lede: `The raw playing field on a ${bestLabel}.`,
      ledeHtml: ledeChips, answerHtml: answer,
    });
}
