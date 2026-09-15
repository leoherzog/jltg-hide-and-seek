/**
 * render/landing.js — the landing picker's markup. Pure `data → string`, no DOM.
 *
 * This file prints the picker; `render/picker.js` makes it move (CONTRACT.md §(a)).
 * Every catalogue value goes through `esc()` or an escaping helper (§(e)). Numbers
 * use `num()` from `lib/core.js`, never `toFixed` or `Intl`.
 *
 * @module render/landing
 */

import { num, coord, MAX_FEEDS_PER_RUN } from '../lib/core.js';
import {
  esc, el, join, waIcon, waButton, waCallout, waBadge, chip, basisChip, degradeChip,
  iconLabel, legendRow, swatch,
} from './html.js';
import { labelOf, placeOf, spanKmOf } from '../lib/catalog.js';

/** How many feeds one run may merge; `readSources` and the worker refuse the same number. */
export const PICK_CAP = MAX_FEEDS_PER_RUN;

/** Shift+Arrow in an edge field moves that edge this far. About a kilometre. */
export const NUDGE_DEG = 0.01;

/**
 * The picker's controls, as one string. Injected by `app.js` only once the catalogue
 * loaded, so a failed fetch collapses the stage to a plain card.
 *
 * `#catalog-map`, the heading and the lede are NOT here: they are static markup in
 * `index.html`, siblings of this panel inside `#picker`, and survive its replacement.
 *
 * Every `<wa-button>` here is `type="button"`: this markup lives inside
 * `<form id="landing-form">` and a button in a form defaults to submitting it.
 *
 * @returns {string}
 */
export function renderPickerCard() {
  // The label is real but visually hidden, so a screen reader still announces it.
  const search = el('wa-input', join(
    waIcon('magnifying-glass', { slot: 'start' }),
    // Icon-only, so the icon carries the accessible name (Web Awesome's rule for
    // icon buttons). `render/picker.js` hides it where geolocation is missing and
    // lists what `rowsNear` finds; nothing asks for a position until this is pressed.
    el('wa-button', waIcon('location-crosshairs', { label: 'Feeds near me' }), {
      id: 'locate-me', slot: 'end', type: 'button', appearance: 'plain', size: 's',
      title: 'Feeds near me',
    }),
    // A plain `<a>` round the chip, not `linkChip`, which cannot set `target`. The
    // `~km` span on each result row already says marker positions are rough.
    el('span', join(esc('Or tap a marker.'),
      el('a', chip('Mobility Database', 'location-dot'), {
        className: 'wa-link-plain',
        href: 'https://mobilitydatabase.org',
        target: '_blank',
        rel: 'noopener noreferrer',
      })),
    { slot: 'hint', className: 'wa-caption-xs wa-color-text-quiet' }),
  ), {
    id: 'catalog-search',
    type: 'search',
    label: 'Search for a city or operator',
    placeholder: 'Grand Rapids, MBTA, De Lijn…',
    autocomplete: 'off',
    spellcheck: 'false',
    withClear: true,
    ariaControls: 'catalog-results',
    className: 'picker-search wa-visually-hidden-label',
  });

  const drawButtons = el('div', join(
    waButton('Draw a shape', {
      id: 'draw-shape', type: 'button', icon: 'draw-polygon', ariaPressed: 'false',
    }),
    // The touch way to finish a ring; double-click, vertex 0 and Enter are not
    // available to a finger. Revealed while drawing.
    waButton('Finish shape', {
      id: 'draw-finish', type: 'button', icon: 'check', variant: 'brand', hidden: true,
    }),
    waButton('Clear shape', {
      id: 'draw-clear', type: 'button', icon: 'eraser', appearance: 'plain', hidden: true,
    }),
  ), { className: 'wa-cluster wa-gap-2xs' });

  // What the draw tool does right now; `render/picker.js` writes `renderDrawHint` per mode.
  // It sits INSIDE `#picker-draw` because styles.css §7 keeps only that row on
  // screen while a shape is drawn on a phone.
  // A `<div>`, not a `<p>`: the hint holds a `legendRow` `<ul>`.
  const drawHint = el('div', '', {
    id: 'picker-draw-hint',
    className: 'wa-caption-s wa-color-text-quiet',
    ariaLive: 'polite',
  });

  // The draw tool's controls, in their own row so the mobile sheet can keep just
  // this row on screen while a shape is drawn (styles.css §7).
  const draw = el('div', join(drawButtons, drawHint), {
    id: 'picker-draw', className: 'wa-stack wa-gap-2xs',
  });

  const toolbar = el('div', join(search, draw), {
    id: 'picker-toolbar', className: 'wa-stack wa-gap-xs',
  });

  // Says on the page that the map library was blocked and where the same feeds are.
  const mapNote = el('p', '', {
    id: 'map-note',
    role: 'status',
    className: 'wa-caption-s wa-color-text-quiet',
    hidden: true,
  });

  // Filled by `render/picker.js` once it knows which examples the catalogue can serve.
  const examples = el('div', '', {
    id: 'example-maps',
    role: 'group',
    ariaLabel: 'Example maps',
    className: 'wa-stack wa-gap-2xs',
    hidden: true,
  });

  // Two opt-in switches in a disclosure. The slotted `hint`s land in each switch's
  // `aria-describedby`; this sits above `#picker-note`, whose advice points here.
  const switches = el('div', join(
    el('wa-switch', join(
      'Regional and long-distance feeds',
      el('span', join(chip('regional', 'route', { variant: 'warning' }),
        esc('Intercity rail and coaches. Overlaps most shapes.')),
      { slot: 'hint', className: 'wa-caption-xs wa-color-text-quiet' }),
    ), { id: 'include-regional', size: 's' }),
    el('wa-switch', join(
      'Feeds no longer updated',
      el('span', join(chip('no longer updated', 'clock-rotate-left', { variant: 'warning' }),
        esc('The operator stopped publishing, so the timetable is old.')),
      { slot: 'hint', className: 'wa-caption-xs wa-color-text-quiet' }),
    ), { id: 'include-inactive', size: 's' }),
  ), { id: 'picker-switches', className: 'wa-stack wa-gap-2xs' });

  const filters = el('wa-details', switches, {
    id: 'picker-filters', summary: 'Include more feeds', appearance: 'plain',
  });

  // `role="group"` with real buttons, not `role="listbox"`: an `option` containing a
  // `button` is a shape no screen reader has to make sense of. The one-line summary
  // is `role="status"`, so the count is spoken without the list being read out.
  const results = join(
    el('p', '', {
      id: 'catalog-summary',
      role: 'status',
      className: 'wa-caption-xs wa-color-text-quiet',
      hidden: true,
    }),
    el('div', '', {
      id: 'catalog-results',
      role: 'group',
      ariaLabel: 'Search results',
      hidden: true,
    }),
  );

  const picks = el('div', join(
    // `tabindex="-1"` so focus has somewhere to land when the last pick is removed.
    el('p', '', {
      id: 'picks-count', className: 'wa-caption-s', ariaLive: 'polite', tabindex: '-1',
    }),
    el('div', '', { id: 'picks-list', className: 'wa-stack wa-gap-2xs' }),
  ), { id: 'picks', className: 'wa-stack wa-gap-2xs' });

  // The game-border frame's controls; `render/picker.js` fills it with
  // `renderBorderRow` while a feed is picked.
  const borderRow = el('div', '', { id: 'border-row', hidden: true });

  // `.picker-controls` is what styles.css §7's drawing rule reaches through to keep
  // only the draw row on screen while a shape is drawn on a phone.
  return el('div', join(toolbar, mapNote, examples, filters, results, picks, borderRow,
    el('div', '', { id: 'picker-note', role: 'status' })),
  { className: 'picker-controls wa-stack wa-gap-m' });
}

/**
 * `#picker-draw-hint` for one draw-tool mode. Pointer-specific wording is split into
 * `.hint-fine` (a key legend) / `.hint-coarse` (a sentence) that styles.css shows
 * per pointer.
 *
 * @param {'idle'|'drawing'|'keyboard'} mode
 * @returns {string} markup
 */
export function renderDrawHint(mode) {
  if (mode === 'idle') {
    return join(
      el('div', legendRow([
        ['<kbd>Click</kbd>', 'adds a corner'],
        ['<kbd>Shift</kbd>+drag', 'draws a box'],
      ], { label: 'Drawing keys' }), { className: 'hint-fine' }),
      el('span', 'Tap to add corners', { className: 'hint-coarse' }),
    );
  }
  if (mode === 'drawing') {
    return join(
      el('div', legendRow([
        ['<kbd>Click</kbd>', 'adds'],
        ['<kbd>Enter</kbd>', 'closes'],
        ['<kbd>⌫</kbd>', 'undoes'],
        ['<kbd>Esc</kbd>', 'cancels'],
      ], { label: 'Drawing keys' }), { className: 'hint-fine' }),
      el('span', 'Tap to add corners, then Finish shape.', { className: 'hint-coarse' }),
    );
  }
  if (mode === 'keyboard') {
    return esc('Drawing needs a mouse or touch. Use the search box to pick feeds instead.');
  }
  return '';
}

/** `#map-note` once MapLibre has failed to load. @returns {string} markup */
export function renderMapNote() {
  return join(degradeChip('map_unavailable'), esc('Search finds every feed.'));
}

/** A frame edge as the fields print it: `coord()`'s six decimals, no grouping. */
function deg(x) {
  return String(coord(x));
}

/** The frame's area in km², grouped. Catalogue boxes are only marker-accurate. */
function km2(areaSqM) {
  return num(areaSqM / 1000000.0);
}

/**
 * The `#border-caption` sentence, as plain text. It is the caption's spoken form
 * (visually hidden); `renderBorderChips` is the visible one.
 *
 * Branch on `mode` FIRST: it alone decides what `readOptions` sends. An `'auto'`
 * frame says the border will be inferred, because null crosses the wire. The OSM
 * sentence is for `'custom'` only, and only while the frame is still that box.
 *
 * @param {Object} s
 * @param {{bbox: [number,number,number,number], mode: 'auto'|'custom'}|null} s.border
 * @param {number} s.count how many feeds the frame is fitted to
 * @param {number} s.areaSqM the frame's area, from `bboxAreaSqM`
 * @param {boolean} [s.osmPicked] a drawn OpenStreetMap area is one of the picks
 * @param {boolean} [s.osmFrame] and the frame is still the box around that shape
 * @returns {string} plain text, '' when there is no frame
 */
export function renderBorderCaption(s) {
  if (!s.border) return '';
  const area = `about ${km2(s.areaSqM)} km²`;
  if (s.border.mode === 'custom') {
    if (s.osmPicked && s.osmFrame) {
      return `Game border, ${area}, is the box around your shape. Map lines are read `
        + 'inside the shape only. Drag a corner or edge, or edit the numbers, to play a '
        + 'different box.';
    }
    return `Game border, ${area}, the box you set. Fit to feeds resets it.`;
  }
  if (s.osmPicked) {
    // 'auto' with a shape picked is still sent as null: the border is inferred from
    // the network the shape produces, not from the shape's extent.
    return `Game border, ${area}, fitted to your shape. Left alone, it is inferred from `
      + 'what the start stop can reach. Drag a corner or edge to play the box instead.';
  }
  const feeds = s.count === 1 ? 'the feed' : `the ${num(s.count)} feeds`;
  return `Game border, ${area}, fitted to ${feeds} you picked. Left alone, it is inferred `
    + 'from what the start stop can reach. Drag a corner or edge, or edit the numbers, '
    + 'to set it.';
}

/**
 * The caption's chips: the mode first, then the area. Same branches and arguments as
 * `renderBorderCaption`.
 *
 * @param {Object} s
 * @returns {string} markup, '' when there is no frame
 */
export function renderBorderChips(s) {
  if (!s.border) return '';
  const area = chip(`≈ ${km2(s.areaSqM)} km²`, 'ruler-combined');
  if (s.border.mode === 'custom') {
    if (s.osmPicked && s.osmFrame) {
      return join(chip('Box around your shape', 'draw-polygon', { variant: 'brand' }), area,
        chip('Lines clipped to your shape', 'scissors'));
    }
    return join(chip('Your box', 'crop-simple', { variant: 'brand' }), area);
  }
  return join(
    chip('Inferred from reach', 'wand-magic-sparkles'),
    s.osmPicked ? chip('Fitted to your shape', 'draw-polygon') : '',
    area,
  );
}

/** One of the four edge fields. `inputmode="decimal"` for a phone keyboard with a
 *  minus sign; `data-border-edge` is what `render/picker.js` delegates on. */
function borderField(edge, label, value) {
  return el('wa-input', '', {
    id: `border-${edge}`,
    type: 'text',
    size: 's',
    label,
    value: deg(value),
    inputmode: 'decimal',
    autocomplete: 'off',
    spellcheck: 'false',
    dataBorderEdge: edge,
    className: 'border-field',
  });
}

/**
 * The `#border-row` markup: caption, the four edge fields, the five buttons, legend.
 * `render/picker.js` rebuilds it only when its shape changes and otherwise patches
 * `[data-caption-chips]`, `[data-caption-text]` and the fields in place. The fields
 * are the keyboard path; the map handles are not focusable. Every `<wa-button>` is
 * `type="button"` (see above).
 *
 * @param {Object} s
 * @param {{bbox: [number,number,number,number], mode: 'auto'|'custom'}|null} s.border
 * @param {number} s.count @param {number} s.areaSqM
 * @param {boolean} [s.osmPicked] @param {boolean} [s.osmFrame]
 * @param {boolean} [s.overlap] two or more picked boxes intersect, so "Where they
 *        overlap" has something to seed from
 * @param {boolean} [s.hasRing] a drawn shape exists, so "Box around my shape" can
 * @returns {string} '' when there is no frame, so the host stays hidden
 */
export function renderBorderRow(s) {
  if (!s.border) return '';
  const [south, west, north, east] = s.border.bbox;
  const caption = el('p', join(
    el('span', 'Game border', { ariaHidden: 'true', className: 'wa-color-text-quiet' }),
    el('span', renderBorderChips(s), {
      ariaHidden: 'true', className: 'wa-cluster wa-gap-2xs', dataCaptionChips: '',
    }),
    el('span', esc(renderBorderCaption(s)), { className: 'wa-visually-hidden', dataCaptionText: '' }),
  ), {
    id: 'border-caption', role: 'status',
    className: 'wa-caption-s wa-cluster wa-gap-2xs wa-align-items-center',
  });
  const fields = el('div', join(
    borderField('s', 'South', south),
    borderField('w', 'West', west),
    borderField('n', 'North', north),
    borderField('e', 'East', east),
  ), {
    className: 'wa-grid wa-gap-xs',
    style: '--min-column-size:7rem',
    role: 'group',
    ariaLabel: 'Game border edges, in decimal degrees',
  });
  const buttons = el('div', join(
    waButton('Fit to feeds', {
      id: 'border-fit', type: 'button', icon: 'arrows-to-dot', dataBorderAction: 'fit',
    }),
    s.overlap ? waButton('Where they overlap', {
      id: 'border-overlap', type: 'button', icon: 'object-group', dataBorderAction: 'overlap',
    }) : '',
    waButton('Box around my shape', {
      id: 'border-from-shape', type: 'button', icon: 'draw-polygon', dataBorderAction: 'from-shape',
      disabled: !s.hasRing,
    }),
    waButton('Shrink 10 %', {
      id: 'border-shrink', type: 'button', icon: 'compress', dataBorderAction: 'shrink',
    }),
    waButton('Grow 10 %', {
      id: 'border-grow', type: 'button', icon: 'expand', dataBorderAction: 'grow',
    }),
  ), { className: 'wa-cluster wa-gap-2xs', role: 'group', ariaLabel: 'Game border tools' });
  const nudge = `<kbd>Shift</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> in a field nudges that edge ${esc(num(NUDGE_DEG, 2))}°`;
  const help = legendRow([
    [swatch('background:var(--gold)'), 'Game border on the map'],
    [waIcon('circle-dot'), 'Handles resize'],
    [waIcon('grip-lines'), 'Outline moves'],
    [waIcon('hand'), 'Inside pans'],
  ], { label: 'The border on the map' });
  const keys = el('p', nudge, { className: 'kbd-only wa-caption-xs wa-color-text-quiet' });
  return el('div', join(caption, fields, buttons, help, keys), { className: 'wa-stack wa-gap-xs' });
}

/**
 * The example-map chips: one `<wa-button>` per city, `data-example` naming it.
 * Buttons, not `<wa-tag>`s, because a keyboard cannot reach a tag. `aria-pressed`
 * says whether the selection is that example right now.
 *
 * @param {Array<{key: string, name: string, where: string, rows: Object[]}>} examples
 * @param {{pressedKey?: string|null}} [opts]
 * @returns {string} '' when there is nothing to offer, so the host stays hidden
 */
export function renderExampleMaps(examples, opts = {}) {
  const { pressedKey = null } = opts;
  if (!examples.length) return '';
  return join(
    el('p', 'Or try an example', { className: 'wa-caption-s wa-color-text-quiet', id: 'example-maps-lede' }),
    el('div', join(...examples.map((ex) => waButton(ex.name, {
      type: 'button',
      pill: true,
      variant: ex.key === pressedKey ? 'brand' : 'neutral',
      appearance: ex.key === pressedKey ? 'filled' : 'outlined',
      ariaPressed: ex.key === pressedKey ? 'true' : 'false',
      dataExample: ex.key,
      // "Chicago, Illinois — 4 feeds": the tooltip and the accessible name.
      title: `${ex.name}, ${ex.where} — ${num(ex.rows.length)} ${ex.rows.length === 1 ? 'feed' : 'feeds'}`,
      ariaLabel: `${ex.name}, ${ex.where}: ${num(ex.rows.length)} ${ex.rows.length === 1 ? 'feed' : 'feeds'}`,
    }))), { className: 'wa-cluster wa-gap-2xs', ariaLabelledby: 'example-maps-lede' }),
  );
}

/** The `regional` / `no longer updated` / `sign-in required` badges for one row. */
function rowBadges(row) {
  return join(
    row.r ? chip('regional', 'route', { variant: 'warning' }) : '',
    row.x ? chip('no longer updated', 'clock-rotate-left', { variant: 'warning' }) : '',
    row.a ? chip('sign-in required', 'lock', { variant: 'danger' }) : '',
  );
}

/** `Grand Rapids, Michigan, US · ↔ ~40 km`, as markup. */
function rowWhereHtml(row) {
  const place = placeOf(row);
  const span = `${waIcon('arrows-left-right', { label: 'across' })} ~${esc(num(spanKmOf(row)))} km`;
  return place ? `${esc(place)} · ${span}` : span;
}

/**
 * The `#tt` hover panel for one feed marker.
 * @param {Object} row a catalogue row
 * @returns {string} markup
 */
export function renderMarkerTip(row) {
  const badges = rowBadges(row);
  return join(
    el('b', esc(labelOf(row))),
    rowWhereHtml(row),
    badges ? el('div', badges, { className: 'wa-cluster wa-gap-2xs' }) : '',
  );
}

/**
 * One search result or one selected feed, as a row.
 * @param {string} textHtml @param {string} controlHtml @param {Object} [opts]
 */
function pickRow(textHtml, controlHtml, opts = {}) {
  // The cluster utilities are the row's layout, so a caller's `className` is appended.
  const { className = '', ...rest } = opts;
  return el('div', join(el('div', textHtml, { className: 'pick-row-text' }), controlHtml), {
    className: `pick-row wa-cluster wa-gap-s wa-justify-content-space-between ${className}`.trim(),
    ...rest,
  });
}

/**
 * The search results list. Opt-in rows are listed anyway with an "Add anyway"
 * button (PLAN D15). A row needing an API key offers the operator's download link
 * instead. `more` is how many matches are not listed; a last row says so.
 *
 * A row in `farKm` (catalogue id → km from the nearest pick) is a second city: it
 * says how far and its Add is disabled, because `addRow` would refuse it.
 *
 * @param {Object[]} rows
 * @param {{selectedIds?: Set<string>|string[], farKm?: Map<string, number>, full?: boolean, more?: number}} [opts]
 * @returns {string}
 */
export function renderResults(rows, opts = {}) {
  const { selectedIds = [], farKm = new Map(), full = false, more = 0 } = opts;
  const chosen = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  if (!rows.length) {
    return el('p', iconLabel('lightbulb', 'Try the operator’s name, or bring your own feed below.'),
      { className: 'wa-caption-s' });
  }
  const moreRow = more > 0
    ? el('p', join(waBadge(`+${num(more)}`, { variant: 'neutral', appearance: 'outlined' }),
      esc('Type more of the name or draw a shape.')),
    { className: 'wa-caption-xs wa-color-text-quiet' })
    : '';
  return join(...rows.map((row) => {
    const already = chosen.has(`mdb:${row.id}`);
    const farAway = farKm.get(String(row.id));
    const far = farAway !== undefined;
    const text = join(
      el('span', esc(labelOf(row)), { className: 'pick-row-name' }),
      el('span', rowWhereHtml(row), { className: 'wa-caption-xs wa-color-text-quiet' }),
      rowBadges(row),
      far ? chip(`${num(farAway)} km from your picks`, 'arrows-left-right', { variant: 'danger' }) : '',
    );
    let control = '';
    if (row.a) {
      // `tools/mdb-snapshot.mjs` keeps `d` only for http(s), so this is never a
      // `javascript:` href. Without one, the row's sign-in chip says it all.
      if (row.d) {
        control = el('a', join(waIcon('arrow-up-right-from-square'), 'Download zip'), {
          className: 'wa-link wa-caption-s',
          href: row.d,
          rel: 'noopener noreferrer',
          target: '_blank',
          ariaLabel: `Download ${labelOf(row)} yourself`,
        });
      }
    } else if (already) {
      control = waButton('Added', { type: 'button', icon: 'check', disabled: true });
    } else {
      control = waButton(row.r || row.x ? 'Add anyway' : 'Add', {
        type: 'button',
        icon: 'plus',
        variant: 'brand',
        dataAdd: String(row.id),
        disabled: full || far || null,
        ariaLabel: `Add ${labelOf(row)}`,
      });
    }
    return pickRow(text, control, { dataRow: String(row.id) });
  }), moreRow);
}

/**
 * The spoken one-liner beside the results (`role="status"` in the card markup).
 *
 * @param {number} shown @param {number} total
 * @returns {string} plain text; the caller writes it with `textContent`
 */
export function renderResultsSummary(shown, total) {
  if (!total) return 'No feed matches.';
  if (total === 1) return '1 feed matches.';
  if (shown < total) return `${num(total)} matches · closest ${num(shown)} shown`;
  return `${num(total)} feeds match.`;
}

/**
 * `#picks-count`: the pick count against the cap, with one pip per slot.
 *
 * @param {number} used slots taken, bring-your-own included @param {number} cap
 * @returns {string} markup
 */
export function renderPicksCount(used, cap) {
  if (!used) return esc('No feeds picked');
  const pips = Array.from({ length: cap }, (_, i) => el('span', '', {
    className: 'sw', dataOn: i < used,
  })).join('');
  return join(esc(`${num(used)} / ${num(cap)} feeds`),
    el('span', pips, { ariaHidden: 'true', className: 'pick-pips' }));
}

/**
 * The selected-feeds list: one row per feed that will be read, map picks and
 * bring-your-own alike.
 *
 * `degrade`, when set, is a `DEGRADE_KIND` code shown as its `degradeChip` in place of
 * the badge (the drawn OpenStreetMap area: `assumed_schedule`).
 *
 * @param {Array<{id: string, label: string, where: string, badge: string, icon: string, degrade?: string}>} picks
 * @returns {string} '' with nothing picked; `#picks-count` says so
 */
export function renderPicks(picks) {
  if (!picks.length) return '';
  return join(...picks.map((p) => pickRow(
    join(
      el('span', esc(p.label), { className: 'pick-row-name' }),
      p.where ? el('span', esc(p.where), { className: 'wa-caption-xs wa-color-text-quiet' }) : '',
      p.degrade ? degradeChip(p.degrade)
        : (p.badge ? chip(p.badge, p.icon || '', { variant: 'neutral' }) : ''),
    ),
    waButton('Remove', {
      type: 'button',
      icon: 'xmark',
      appearance: 'plain',
      dataRemove: p.id,
      ariaLabel: `Remove ${p.label}`,
    }),
    // `data-row-id` lets `render/picker.js` refocus the row next to the removed one.
    { className: 'pick-row-chosen', dataRowId: p.id },
  )));
}

/** Where OpenStreetMap lines run is measured; how often is assumed. */
function osmBasisLegend() {
  return legendRow([
    [basisChip('feed'), 'where they run'],
    [degradeChip('assumed_schedule'), 'how often'],
  ], { label: 'What is measured and what is assumed' });
}

/** A one-line chip row inside the note. */
function noteRow(html) {
  return el('div', html, { className: 'wa-cluster wa-gap-2xs wa-align-items-center wa-body-s' });
}

/**
 * The picker's status callout, or `''` when there is nothing to say. Only lines
 * that refuse (the cap), say something the page cannot say elsewhere (an API-key
 * feed, a shape the catalogue does not cover), or carry the OpenStreetMap offer.
 *
 * The offer button is the one control attached to a sentence; it disappears the
 * instant the area is picked, so it cannot be pressed twice. `[data-note-action]`
 * buttons (Redraw, Include regional) are delegated by `render/picker.js`.
 *
 * @param {Object} s
 * @param {boolean} s.capped @param {Array<{label: string, href: string}>} s.blocked
 * @param {boolean} s.ringEmpty
 * @param {boolean} [s.osmOffer] the drawn area can still be built from OpenStreetMap
 * @param {boolean} [s.osmPicked] it already has been, and is in the list below
 * @param {boolean} [s.regionalOn] the regional switch is on, so it is not offered
 * @param {Array<{label: string, km: number}>} [s.far] picks just refused as a second city
 * @param {number} [s.farMore] how many more were refused than `far` lists
 * @param {boolean} [s.split] the picks already there do not chain into one map
 * @returns {string}
 */
export function renderPickerNote(s) {
  const lines = [];
  for (const f of s.far || []) {
    lines.push(noteRow(join(
      el('b', esc(f.label)),
      chip(`${num(f.km)} km away`, 'arrows-left-right', { variant: 'danger' }),
      esc('Too far to share a game with your picks.'),
    )));
  }
  if (s.farMore > 0) {
    lines.push(noteRow(join(
      waBadge(`+${num(s.farMore)}`, { variant: 'neutral', appearance: 'outlined' }),
      esc('more feeds skipped as too far away.'),
    )));
  }
  if (s.split) {
    lines.push(noteRow(join(
      chip('Picks far apart', 'arrows-left-right', { variant: 'warning' }),
      esc('Keep one city’s feeds before you run.'),
    )));
  }
  if (s.capped) {
    lines.push(noteRow(join(
      // The pips in `#picks-count` already show the cap, so the chip is one word.
      chip('Full', 'ban', { variant: 'danger' }),
      esc('Remove a feed to add another.'),
    )));
  }
  // Not while the area is a source: "redraw" would be advice to redraw the thing
  // about to be built.
  const ringEmpty = s.ringEmpty && !s.osmPicked;
  if (ringEmpty) {
    lines.push(noteRow(join(
      chip('No published feed here', 'draw-polygon', { variant: 'warning' }),
      waButton('Redraw', {
        type: 'button', appearance: 'plain', icon: 'draw-polygon', dataNoteAction: 'redraw',
      }),
      s.regionalOn ? '' : waButton('Include regional', {
        type: 'button', appearance: 'plain', icon: 'route', dataNoteAction: 'regional',
      }),
    )));
  }
  if (s.osmOffer) {
    // Stands on its own: the line above is reset by the next search, this is not.
    lines.push(el('div', join(
      el('p', esc('OpenStreetMap has rail, metro and tram lines here.'), { className: 'wa-body-s' }),
      osmBasisLegend(),
    ), { className: 'wa-stack wa-gap-2xs' }));
  }
  // The locate button's outcomes that leave nothing in the results list. `'none'`
  // is a position with no catalogue feed near it; the other two never got one.
  if (s.locate === 'none') {
    lines.push(noteRow(join(
      chip('No published feed near you', 'location-crosshairs', { variant: 'warning' }),
      esc('Search for a city, or draw a shape.'),
    )));
  } else if (s.locate === 'denied') {
    lines.push(noteRow(join(
      chip('Location blocked', 'location-crosshairs', { variant: 'neutral' }),
      esc('Allow it in the browser, or search for a city.'),
    )));
  } else if (s.locate === 'unavailable') {
    lines.push(noteRow(join(
      chip('Location unavailable', 'location-crosshairs', { variant: 'neutral' }),
      esc('Search for a city instead.'),
    )));
  }
  for (const b of s.blocked || []) {
    const how = b.href
      ? el('a', join(waIcon('arrow-up-right-from-square'), 'Download'), {
        className: 'wa-link',
        href: b.href,
        rel: 'noopener noreferrer',
        target: '_blank',
        ariaLabel: `Download ${b.label} yourself`,
      }) + esc(', then drop it below.')
      : esc('Get the zip from the operator; drop it below.');
    lines.push(noteRow(join(
      el('b', esc(b.label)),
      chip('sign-in required', 'lock', { variant: 'danger' }),
      el('span', how),
    )));
  }
  if (!lines.length) return '';
  const offer = s.osmOffer
    ? waButton('Build this area from OpenStreetMap', {
      id: 'osm-build',
      type: 'button',
      icon: 'map-location-dot',
      variant: 'brand',
      dataOsmBuild: '',
    })
    : '';
  return waCallout(
    el('div', join(...lines, offer), { className: 'wa-stack wa-gap-xs' }),
    { variant: 'neutral', icon: 'circle-info' },
  );
}
