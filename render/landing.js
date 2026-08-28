/**
 * render/landing.js — the landing picker's markup. Pure `data → string`, no DOM.
 *
 * The same split `render/strategy.js` / `render/simulator.js` uses and CONTRACT.md
 * §(a) already sanctions: this file prints the picker, `render/picker.js` makes it
 * move. Nothing here reads or writes an element, listens to anything, or knows that
 * MapLibre exists — which is what lets the search results and the selected list be
 * checked as strings.
 *
 * ESCAPING. Every value on this page comes from `data/feeds.json`, which is upstream
 * text: provider names carry ampersands, accents, quotes and the occasional angle
 * bracket. Everything goes through `esc()` or a helper that escapes for us, exactly
 * as §(e) requires — there is no interpolation of a raw catalogue string anywhere
 * below.
 *
 * NUMBERS. `num()` from `lib/core.js`, never `toFixed`, never `Intl`. This file
 * formats; it does not compute. `spanKmOf` is `lib/catalog.js`'s.
 *
 * @module render/landing
 */

import { num, coord, MAX_FEEDS_PER_RUN } from '../lib/core.js';
import { esc, el, join, waIcon, waButton, waCallout, chip } from './html.js';
import { labelOf, placeOf, spanKmOf } from '../lib/catalog.js';

/** How many feeds one run may merge. PLAN D24: warn above 3, refuse above this.
 *  One number, defined in `lib/core.js`, because `readSources` and the worker refuse
 *  the same eleventh feed this list refuses. */
export const PICK_CAP = MAX_FEEDS_PER_RUN;
/** Above this many, the note starts saying so. */
export const PICK_WARN = 3;
/** Rough megabytes above which the note mentions the download. PLAN D24. */
export const BIG_DOWNLOAD_MB = 150;

/**
 * The picker card's inner markup.
 *
 * Shipped as a string rather than as static `index.html` so the card exists only when
 * the catalogue actually loaded: `app.js` injects this into the empty host and only
 * then unhides it, so a failed fetch leaves the bring-your-own card as the whole of
 * the page instead of an empty grey box that looks broken.
 *
 * Every `<wa-button>` here is `type="button"` on purpose. This markup lives INSIDE
 * `<form id="landing-form">` (PLAN D10 — one form, so `boot()`'s single submit
 * listener and `readOptions`' eleven `[data-opt]` lookups are untouched), and a
 * button in a form defaults to submitting it. A "Draw a shape" button that started
 * the analysis would be a very confusing bug.
 *
 * @returns {string}
 */
export function renderPickerCard() {
  const header = el('div', join(
    el('h2', 'Pick your city', { className: 'wa-heading-m' }),
    el('p',
      'Search for an operator, click a marker, or draw a shape to take every system '
      + 'inside it. Boxes come from the Mobility Database and are only accurate enough '
      + 'to place a marker.',
      { className: 'wa-caption-s wa-color-text-quiet', style: 'max-inline-size:72ch' }),
  ), { className: 'wa-stack wa-gap-3xs' });

  // Filled by `render/picker.js` once it knows which examples the catalogue can
  // serve (`exampleMapsFor`); empty markup here so the card is still one string.
  const examples = el('div', '', {
    id: 'example-maps',
    role: 'group',
    ariaLabel: 'Example maps',
    hidden: true,
  });

  const toolbar = el('div', join(
    el('wa-input', '', {
      id: 'catalog-search',
      type: 'search',
      label: 'Search for a city or operator',
      placeholder: 'Grand Rapids, MBTA, De Lijn…',
      autocomplete: 'off',
      spellcheck: 'false',
      ariaControls: 'catalog-results',
      className: 'picker-search',
    }),
    waButton('Draw a shape', {
      id: 'draw-shape', type: 'button', icon: 'draw-polygon', ariaPressed: 'false',
    }),
    // The pointer-only way to finish a ring. Double-click, a click on vertex 0 and
    // Enter all close it, and none of the three is available to a finger on a phone:
    // there is no keyboard, a 10 px target is not a realistic tap, and a double-tap
    // under cooperative gestures is the map's own. Revealed while drawing.
    waButton('Finish shape', {
      id: 'draw-finish', type: 'button', icon: 'check', variant: 'brand', hidden: true,
    }),
    waButton('Clear shape', {
      id: 'draw-clear', type: 'button', icon: 'eraser', appearance: 'plain', hidden: true,
    }),
  ), { id: 'picker-toolbar', className: 'wa-cluster wa-gap-s wa-align-items-end' });

  const switches = el('div', join(
    el('wa-switch', join(
      'Include regional and long-distance feeds',
      el('span', 'Systems whose box spans a few hundred kilometres — intercity rail, '
        + 'coach networks, statewide aggregates. They overlap almost any shape you draw, '
        + 'which is why they are off by default.',
      { slot: 'hint', className: 'wa-caption-xs wa-color-text-quiet' }),
    ), { id: 'include-regional', size: 's' }),
    el('wa-switch', join(
      'Include feeds no longer updated',
      el('span', 'The operator has stopped publishing. The schedule still describes a '
        + 'real city and still produces a valid report — it is just old.',
      { slot: 'hint', className: 'wa-caption-xs wa-color-text-quiet' }),
    ), { id: 'include-inactive', size: 's' }),
  ), { id: 'picker-switches', className: 'wa-stack wa-gap-2xs' });

  // `role="group"` and real buttons, deliberately NOT `role="listbox"`: every row
  // carries an Add control, and an `option` containing a `button` is a shape no
  // screen reader is required to make sense of. A group of buttons is reachable by
  // Tab, announced with its own name, and arrow-navigable — see `render/picker.js`.
  // The count is spoken, the list is not: `role="status"` on a one-line summary says
  // "7 feeds match, showing 5" without a screen reader reading twenty buttons aloud
  // every keystroke. `#catalog-search` points at the list with `aria-controls`, so the
  // relationship is stated rather than implied by document order.
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

  // `tabindex="-1"` because MapLibre's canvas takes focus itself and the map is a
  // convenience, never the only path: search does everything the map does, works
  // before MapLibre loads, and works if it never loads.
  const map = el('div', '', {
    id: 'catalog-map',
    ariaLabel: 'Map of transit feeds. Every feed on it can also be found with the search box above.',
    tabindex: '-1',
  });

  // Said on the page, not only in the console: the lede promises a map, so when the
  // library is blocked the reader is told what happened and where the same feeds are.
  const mapNote = el('p', '', {
    id: 'map-note',
    role: 'status',
    className: 'wa-caption-s wa-color-text-quiet',
    hidden: true,
  });

  const picks = el('div', join(
    // `tabindex="-1"` so focus has somewhere to land when the last pick is removed
    // and there is no Remove button left to take it (see `refocus` in picker.js).
    el('p', '', {
      id: 'picks-count', className: 'wa-caption-s', ariaLive: 'polite', tabindex: '-1',
    }),
    el('div', '', { id: 'picks-list', className: 'wa-stack wa-gap-2xs' }),
  ), { id: 'picks', className: 'wa-stack wa-gap-2xs' });

  // The game-border frame's controls. Empty and hidden until a feed is picked:
  // `render/picker.js` fills it with `renderBorderRow` the moment `st.border`
  // exists and empties it again when the last pick goes. It sits between the map
  // and the picks list because it edits the rectangle drawn ON the map, and a
  // control two cards away from the thing it moves is a control nobody finds.
  const borderRow = el('div', '', { id: 'border-row', hidden: true });

  return el('div', join(header, examples, toolbar, switches, results, map, mapNote, borderRow,
    picks, el('div', '', { id: 'picker-note', role: 'status' })), { className: 'wa-stack wa-gap-m' });
}

/** A frame edge as the fields print it: `coord()`'s six decimals, no grouping. */
function deg(x) {
  return String(coord(x));
}

/** `about 11,400 km²` — the frame's area, spoken roughly because the boxes it is
 *  fitted to are catalogue boxes, "only accurate enough to place a marker". */
function aboutArea(areaSqM) {
  return `about ${num(areaSqM / 1000000.0)} km²`;
}

/**
 * The `#border-caption` sentence, as plain text — the caller writes it with
 * `textContent`, so a drag that moves the frame sixty times a second updates one
 * text node rather than rebuilding the row under the reader's pointer.
 *
 * The state is the frame's `mode` FIRST, then the flags — never the other way round,
 * because `mode` is the only thing that decides what `readOptions` sends. An untouched
 * (`'auto'`) frame says the border will be INFERRED, because that is what happens to
 * it: null crosses the wire and the worker fits the border to what the start stop can
 * reach, exactly as a run with no frame at all. A frame the reader has moved says so
 * and names the way back.
 *
 * An OpenStreetMap area splits the same way and used to be tested first, which made
 * its sentence win in every mode: taking the area, then pressing "Fit to feeds", left
 * a frame that sends null while the caption still called it "the box around the shape
 * you drew" — the two-extents confusion the auto/custom split exists to prevent. So
 * the OSM sentence is for `'custom'` only, and `osmFrame` narrows it further to a
 * frame that is still literally that box (see `borderView` in render/picker.js): once
 * a handle has moved it, it is the reader's rectangle like any other. (2026-08-27.)
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
      return 'Game border: the box around the shape you drew (the OpenStreetMap read is '
        + `clipped to the shape itself, ${aboutArea(s.areaSqM)}). Drag a corner or edge, `
        + 'or edit the numbers, to play a different box.';
    }
    return `Game border: the box you set (${aboutArea(s.areaSqM)}). Fit to feeds resets it.`;
  }
  if (s.osmPicked) {
    // 'auto' with a shape picked: the frame is fitted to the shape's box, but it is
    // still sent as null, so the border will be inferred from the network the shape
    // produces — not from the shape's own extent. Saying which is the whole point.
    return `Game border: fitted to the shape you drew (${aboutArea(s.areaSqM)}), and left `
      + 'to be inferred — an untouched border is fitted to what the start stop can reach '
      + 'in the network built from that shape. Drag a corner or edge, or edit the '
      + 'numbers, to play the box instead.';
  }
  const feeds = s.count === 1 ? 'the feed' : `the ${num(s.count)} feeds`;
  return `Game border: fitted to ${feeds} you picked (${aboutArea(s.areaSqM)}). Drag a `
    + 'corner or edge, edit the numbers, or leave it — an untouched border is inferred '
    + 'from what the start stop can reach.';
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
 *
 * Rebuilt by `render/picker.js` only when its SHAPE changes — the frame appears or
 * goes, the overlap button earns or loses its place, a drawn shape arrives — and
 * otherwise patched in place, because an `innerHTML` rebuild detaches the field the
 * reader is typing in. That is why the caption and the field values are also
 * reachable one at a time (`renderBorderCaption`, and the fields by `data-border-edge`).
 *
 * The four fields ARE the keyboard path. The handles on the map are not focusable —
 * eight tab stops on a canvas the search box already bypasses would be eight stops
 * to nowhere — so the help line says the fields do the same job, and Shift+Arrow in
 * one nudges that edge by 0.01°.
 *
 * Every `<wa-button>` is `type="button"`: this row lives inside `<form
 * id="landing-form">`, and "Shrink 10 %" starting the analysis would be a bad joke.
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
  ), { className: 'border-fields', role: 'group', ariaLabel: 'Game border edges, in decimal degrees' });
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
  const help = el('p', 'The gold rectangle on the map is the same box: drag a corner or an '
    + 'edge handle to resize it, or drag the rectangle’s outline between the handles to '
    + 'move the whole box. Dragging inside it pans the map. The fields do the same job '
    + 'from the keyboard — Shift+↑ and Shift+↓ in a field nudge that edge by 0.01°.',
  { className: 'wa-caption-xs wa-color-text-quiet', style: 'max-inline-size:72ch' });
  return el('div', join(caption, fields, buttons, help), { className: 'wa-stack wa-gap-xs' });
}

/**
 * The example-map chips: one `<wa-button>` per city, `data-example` naming it.
 *
 * Buttons, not `<wa-tag>`s — a chip that loads four feeds is a control, and a tag is
 * decoration a keyboard cannot reach. `aria-pressed` says whether the selection IS
 * that example right now; `render/picker.js` keeps it current, because a reader who
 * removes the Water Taxi has left Chicago and the chip must stop saying otherwise.
 * `type="button"` for the same reason every button in this card carries it: the card
 * lives inside `<form id="landing-form">`.
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
      // "Chicago, Illinois — 4 feeds": the tooltip a mouse gets and the name a
      // screen reader hears, so the chip says what it costs before it is pressed.
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
  return el('div', join(el('div', textHtml, { className: 'pick-row-text' }), controlHtml), {
    className: 'pick-row', ...opts,
  });
}

/**
 * The search results list.
 *
 * A row in one of the two opt-in groups is listed anyway, with its badge and an
 * "Add anyway" button (PLAN D15): any single threshold is wrong for somebody, and a
 * reader who typed the operator's name has already said which side of it they are on.
 *
 * A row needing an API key cannot be added at all — the page has no key and will
 * never have one — so it offers the operator's own download link instead.
 *
 * A list silently cut at the caller's limit is a list lying about the catalogue, so
 * when `total` exceeds what is shown the last row says how many more matched and what
 * to do about it.
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
      // The producer's own URL, and only when the snapshot actually carries one:
      // `tools/mdb-snapshot.mjs` keeps `d` only for http(s), so this can never be a
      // `javascript:` href, and a row without one says so instead of rendering a
      // link that goes nowhere. Some of these are plain `http:` — a downgrade the
      // reader can see in the link, not a silent one.
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
 * The spoken one-liner beside the results — `role="status"` in the card markup, so a
 * screen reader hears the count without the list being read out on every keystroke.
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
 * The selected-feeds list. One row per feed that will actually be read, map picks and
 * bring-your-own alike — so there is exactly one place on the page that answers "what
 * is about to run".
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
    // `data-row-id` so `render/picker.js` can put focus back on the row next to the
    // one just removed instead of dropping it to `<body>`.
    { className: 'pick-row pick-row-chosen', dataRowId: p.id },
  )));
}

/**
 * The counts / caps / warnings callout, or `''` when there is nothing to say.
 *
 * Everything here is a WARNING, never a refusal, with one exception: the hard cap.
 * The reasoning is PLAN D24's — the OSM layer's cost scales with the border, and
 * scale guards for a country-sized border are explicitly out of scope this round, so
 * the default has to be "skip the map files and say so" rather than a five-minute
 * apparent hang the reader cannot attribute to anything.
 *
 * `tzSpread` is a GUESS from longitude, and is labelled as one: the catalogue carries
 * no timezone column, so the worker — which reads `agency.txt` — is the authority and
 * says so again in the report if it disagrees.
 *
 * THE ONE INTERACTIVE CONTROL IN HERE is the OpenStreetMap offer, and it is here
 * rather than in the toolbar because the offer only makes sense attached to the
 * sentence that provoked it: a shape was drawn, the catalogue had nothing inside it,
 * and this is the moment the reader learns the run is off unless something else
 * supplies the network. The host is `role="status"`, so the button is re-announced
 * whenever the note is rebuilt; it is spelled with a stable id and it DISAPPEARS the
 * instant the area is picked, so it cannot be pressed twice and `render/picker.js`
 * has somewhere deterministic to put focus afterwards.
 *
 * @param {Object} s
 * @param {number} s.count @param {boolean} s.capped @param {boolean} s.osmSkipped
 * @param {string[]} s.blocked @param {boolean} s.tzSpread @param {boolean} s.ringEmpty
 * @param {number} [s.estMb] a rough total download, for the "this is a lot" line
 * @param {boolean} [s.osmOffer] the drawn area can still be built from OpenStreetMap
 * @param {boolean} [s.osmPicked] it already has been, and is in the list below
 * @returns {string}
 */
export function renderPickerNote(s) {
  const lines = [];
  if (s.capped) {
    lines.push(`That is ${num(PICK_CAP)} feeds, which is as many as one run merges. `
      + 'Remove one before adding another.');
  } else if (s.count > PICK_WARN) {
    lines.push(`${num(s.count)} feeds is a lot to merge — the download, the walk-transfer `
      + 'graph and the zone cover all grow with it. Three or fewer is the comfortable range.');
  }
  // `>=`, not `>`: six map picks times the per-feed estimate lands EXACTLY on the
  // threshold (6 × 25 MB = 150), so a strict test would delay this line by a whole
  // pick in the only flow it was written for.
  if (s.estMb && s.estMb >= BIG_DOWNLOAD_MB) {
    lines.push(`Feeds this many can add up to a few hundred megabytes of download on a `
      + 'cold run. They are cached in this browser afterwards, so the second run is fast.');
  }
  if (s.osmSkipped) {
    lines.push('Two or more feeds: OpenStreetMap is skipped by default, because the '
      + 'map-file cost scales with the border. Untick Skip OpenStreetMap in Advanced to '
      + 'include it.');
  }
  if (s.tzSpread) {
    lines.push('These look like they are in different time zones. That is a guess from '
      + 'longitude — the analysis reads each feed’s own zone and will say so plainly if '
      + 'it agrees.');
  }
  // Not while the area is a source: "try a bigger one" is advice about a shape
  // that has since become the run's input, and the two sentences in one status
  // region would tell the reader to redraw the thing that is about to be built.
  if (s.ringEmpty && !s.osmPicked) {
    lines.push('Nothing in the catalogue overlaps that shape. Try a bigger one, or turn '
      + 'on the regional feeds above.');
  }
  if (s.osmOffer) {
    // Written to stand on its own. The sentence above it is reset by the next search
    // while this offer is not, so the two are not guaranteed to appear together.
    lines.push('OpenStreetMap maps the rail, metro and tram lines inside the shape you '
      + 'drew, in plenty of places where no timetable is published. The area can be built '
      + 'from those instead: where the lines run would be measured, how often they run '
      + 'would be assumed, and the report says which is which on every number.');
  }
  if (s.osmPicked) {
    // The border itself is described by `#border-caption`, which tracks the frame
    // live; this sentence only says where the frame came from, so the two status
    // regions never disagree about which box governs the run.
    lines.push('This area will be built from OpenStreetMap’s own rail, metro and tram '
      + 'lines. Where they run is measured; how often they run is assumed, so every '
      + 'score that rests on the timetable is dropped rather than guessed at. The game '
      + 'border above starts as the box around the shape you drew.');
  }
  for (const label of s.blocked || []) {
    lines.push(`${label} needs an API key, so this page cannot fetch it. Download the zip `
      + 'yourself and drop it in below.');
  }
  if (!lines.length) return '';
  // `type="button"`, like every other button this file prints: the card lives inside
  // `<form id="landing-form">` and a submitting button here would start the analysis
  // from the note.
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
