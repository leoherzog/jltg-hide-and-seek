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
import { esc, el, join, waIcon, waButton, waCallout, chip } from './html.js';
import { labelOf, placeOf, spanKmOf } from '../lib/catalog.js';

/** How many feeds one run may merge; `readSources` and the worker refuse the same number. */
export const PICK_CAP = MAX_FEEDS_PER_RUN;

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
    el('span', 'Or tap a marker. Locations come from the Mobility Database and are '
      + 'approximate.',
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

  // The draw tool's controls, in their own row so the mobile sheet can keep just
  // this row on screen while a shape is drawn (styles.css §7).
  const draw = el('div', join(
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
  ), { id: 'picker-draw', className: 'wa-cluster wa-gap-2xs' });

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
      el('span', 'Intercity rail, coach networks, statewide aggregates. They overlap '
        + 'almost any shape you draw.',
      { slot: 'hint', className: 'wa-caption-xs wa-color-text-quiet' }),
    ), { id: 'include-regional', size: 's' }),
    el('wa-switch', join(
      'Feeds no longer updated',
      el('span', 'The operator has stopped publishing, but the city is real.',
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

/** A frame edge as the fields print it: `coord()`'s six decimals, no grouping. */
function deg(x) {
  return String(coord(x));
}

/** `about 11,400 km²`: roughly, because catalogue boxes are only marker-accurate. */
function aboutArea(areaSqM) {
  return `about ${num(areaSqM / 1000000.0)} km²`;
}

/**
 * The `#border-caption` sentence, as plain text; the caller writes it with
 * `textContent` so a drag patches one node.
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
  if (s.border.mode === 'custom') {
    if (s.osmPicked && s.osmFrame) {
      return 'Game border: the box around your shape (the OpenStreetMap read is clipped '
        + `to the shape itself, ${aboutArea(s.areaSqM)}). Drag a corner or edge, or edit `
        + 'the numbers, to play a different box.';
    }
    return `Game border: the box you set (${aboutArea(s.areaSqM)}). Fit to feeds resets it.`;
  }
  if (s.osmPicked) {
    // 'auto' with a shape picked is still sent as null: the border is inferred from
    // the network the shape produces, not from the shape's extent.
    return `Game border: fitted to your shape (${aboutArea(s.areaSqM)}) but left to be `
      + 'inferred from what the start stop can reach. Drag a corner or edge to play the '
      + 'box instead.';
  }
  const feeds = s.count === 1 ? 'the feed' : `the ${num(s.count)} feeds`;
  return `Game border: fitted to ${feeds} you picked (${aboutArea(s.areaSqM)}). Leave it `
    + 'and the border is inferred from what the start stop can reach; drag a corner or '
    + 'edge, or edit the numbers, to set it yourself.';
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
 * The `#border-row` markup: caption, the four edge fields, the five buttons.
 * `render/picker.js` rebuilds it only when its shape changes and otherwise patches
 * the caption and fields in place. The fields are the keyboard path; the map
 * handles are not focusable. Every `<wa-button>` is `type="button"` (see above).
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
  const caption = el('p', esc(renderBorderCaption(s)), {
    id: 'border-caption', role: 'status', className: 'wa-caption-s',
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
  const help = el('p', 'The gold rectangle on the map is the same box: drag a handle to '
    + 'resize it, or its outline to move it. Dragging inside it pans the map. '
    + 'In a field, Shift+↑ and Shift+↓ nudge that edge by 0.01°.',
  { className: 'wa-caption-xs wa-color-text-quiet', style: 'max-inline-size:72ch' });
  return el('div', join(caption, fields, buttons, help), { className: 'wa-stack wa-gap-xs' });
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
    el('p', 'Or try an example:', { className: 'wa-caption-s wa-color-text-quiet', id: 'example-maps-lede' }),
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

/** `Grand Rapids, Michigan, US · about 40 km across` */
function rowWhere(row) {
  const place = placeOf(row);
  const span = `about ${num(spanKmOf(row))} km across`;
  return place ? `${place} · ${span}` : span;
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
 * instead. When `total` exceeds what is shown, a last row says how many more matched.
 *
 * @param {Object[]} rows
 * @param {{selectedIds?: Set<string>|string[], full?: boolean, total?: number}} [opts]
 * @returns {string}
 */
export function renderResults(rows, opts = {}) {
  const { selectedIds = [], full = false, total = 0 } = opts;
  const chosen = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  if (!rows.length) {
    return el('p', 'No feed in the catalogue matches that. Try the operator’s name, or '
      + 'bring your own feed below.', { className: 'wa-caption-s wa-color-text-quiet' });
  }
  const more = total > rows.length
    ? el('p', esc(`${num(total - rows.length)} more match. Type more of the name, or `
      + 'draw a shape around them on the map.'),
    { className: 'wa-caption-xs wa-color-text-quiet' })
    : '';
  return join(...rows.map((row) => {
    const already = chosen.has(`mdb:${row.id}`);
    const text = join(
      el('span', esc(labelOf(row)), { className: 'pick-row-name' }),
      el('span', esc(rowWhere(row)), { className: 'wa-caption-xs wa-color-text-quiet' }),
      rowBadges(row),
    );
    let control;
    if (row.a) {
      // `tools/mdb-snapshot.mjs` keeps `d` only for http(s), so this is never a
      // `javascript:` href.
      control = row.d
        ? el('a', join(waIcon('arrow-up-right-from-square'), 'Download it yourself'), {
          className: 'wa-link wa-caption-s',
          href: row.d,
          rel: 'noopener noreferrer',
          target: '_blank',
        })
        : el('span', 'Needs an API key', { className: 'wa-caption-s wa-color-text-quiet' });
    } else if (already) {
      control = waButton('Added', { type: 'button', icon: 'check', disabled: true });
    } else {
      control = waButton(row.r || row.x ? 'Add anyway' : 'Add', {
        type: 'button',
        icon: 'plus',
        variant: 'brand',
        dataAdd: String(row.id),
        disabled: full || null,
        ariaLabel: `Add ${labelOf(row)}`,
      });
    }
    return pickRow(text, control, { dataRow: String(row.id) });
  }), more);
}

/**
 * The spoken one-liner beside the results (`role="status"` in the card markup).
 *
 * @param {number} shown @param {number} total
 * @returns {string} plain text; the caller writes it with `textContent`
 */
export function renderResultsSummary(shown, total) {
  if (!total) return 'No feed in the catalogue matches that.';
  if (total === 1) return '1 feed matches.';
  if (shown < total) return `${num(total)} feeds match; showing the closest ${num(shown)}.`;
  return `${num(total)} feeds match.`;
}

/**
 * The selected-feeds list: one row per feed that will be read, map picks and
 * bring-your-own alike.
 *
 * @param {Array<{id: string, label: string, where: string, badge: string, icon: string}>} picks
 * @returns {string}
 */
export function renderPicks(picks) {
  if (!picks.length) {
    return el('p', 'Nothing picked yet.', { className: 'wa-caption-s wa-color-text-quiet' });
  }
  return join(...picks.map((p) => pickRow(
    join(
      el('span', esc(p.label), { className: 'pick-row-name' }),
      p.where ? el('span', esc(p.where), { className: 'wa-caption-xs wa-color-text-quiet' }) : '',
      p.badge ? chip(p.badge, p.icon || '', { variant: 'neutral' }) : '',
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

/**
 * The picker's status callout, or `''` when there is nothing to say. Only lines
 * that refuse (the cap), say something the page cannot say elsewhere (an API-key
 * feed, a shape the catalogue does not cover), or carry the OpenStreetMap offer.
 *
 * The offer button is the one control here, attached to the sentence that provoked
 * it. It disappears the instant the area is picked, so it cannot be pressed twice.
 *
 * @param {Object} s
 * @param {boolean} s.capped @param {string[]} s.blocked @param {boolean} s.ringEmpty
 * @param {boolean} [s.osmOffer] the drawn area can still be built from OpenStreetMap
 * @param {boolean} [s.osmPicked] it already has been, and is in the list below
 * @returns {string}
 */
export function renderPickerNote(s) {
  const lines = [];
  if (s.capped) {
    lines.push(`That is ${num(PICK_CAP)} feeds, which is as many as one run merges. `
      + 'Remove one before adding another.');
  }
  // Not while the area is a source: "try a bigger one" would be advice to redraw
  // the thing about to be built.
  if (s.ringEmpty && !s.osmPicked) {
    lines.push('Nothing in the catalogue overlaps that shape. Try a bigger one, or turn '
      + 'on the regional feeds above.');
  }
  if (s.osmOffer) {
    // Stands on its own: the sentence above is reset by the next search, this is not.
    lines.push('OpenStreetMap maps the rail, metro and tram lines inside your shape, '
      + 'even where no timetable is published. The area can be built from those instead: '
      + 'where the lines run is measured, how often they run is assumed, and the report '
      + 'says which is which on every number.');
  }
  if (s.osmPicked) {
    // `#border-caption` describes the frame live; this only says where it came from.
    lines.push('This area will be built from OpenStreetMap’s rail, metro and tram '
      + 'lines. Where they run is measured; how often they run is assumed, so every score '
      + 'resting on the timetable is dropped rather than guessed. The game border '
      + 'starts as the box around your shape.');
  }
  for (const label of s.blocked || []) {
    lines.push(`${label} needs an API key, so this page cannot fetch it. Download the zip `
      + 'yourself and drop it in below.');
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
    join(
      ...lines.map((line) => el('p', esc(line), { className: 'wa-body-s' })),
      offer,
    ),
    { variant: 'neutral', icon: 'circle-info' },
  );
}
