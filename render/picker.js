/**
 * render/picker.js — the landing map, after it is on the page.
 *
 * `initPicker(root, handlers)` is the only export `app.js` uses. Besides
 * `simulator.js` and `deck.js` this is the only `render/` module that mutates the
 * DOM; it owns the search box, results, picks, note, MapLibre map, draw tool, border
 * frame and theme observer.
 *
 * The map is never the only path: search, Add, Remove and Analyse are wired
 * synchronously and keep working if the MapLibre import never resolves. The library
 * is fetched behind an `IntersectionObserver`.
 *
 * The draw tool and border frame are hand-rolled on MapLibre's own events because
 * `CONTRACT.md` §0 pins the external-asset allowlist. Do not replace them with a CDN
 * import.
 *
 * The border frame has two modes: an `'auto'` frame is a preview sent to the worker
 * as `null`; any drag, field edit or button other than Fit makes it `'custom'` and
 * its rectangle crosses the wire. `handlers.onBorder` reports it; nothing pushes a
 * frame back in.
 *
 * Coordinates: this repo is `[lat, lon]` / `[S, W, N, E]`; MapLibre is `[lng, lat]`.
 * The conversion happens here, at the map boundary, and nowhere else.
 *
 * @module render/picker
 */

import { MAPLIBRE_JS, TILES_LIGHT, TILES_DARK, cmpStr, num, coord } from '../lib/core.js';
import { bboxOf, bboxUnion, bboxIntersection, bboxAreaSqM, bboxScale } from '../lib/geo.js';
import {
  visibleRows, searchCatalog, rowsIntersectingRing, centroidOf,
  labelOf, placeOf, spanKmOf, sourceRefFor, osmSourceRef, exampleMapsFor,
} from '../lib/catalog.js';
import { esc } from './html.js';
import {
  renderResults, renderResultsSummary, renderPicks, renderPickerNote, renderExampleMaps,
  renderBorderRow, renderBorderCaption, PICK_CAP,
} from './landing.js';

/**
 * How many search results the box lists before it says how many more matched.
 * 25 is enough for "new york" (101 ties) to reach the NYC Subway, which sorts 22nd.
 */
const SEARCH_LIMIT = 25;

/** How close, in pixels, a click has to land to vertex 0 to close the ring. */
const CLOSE_PX = 10;
/** Two clicks of a double-click land on the same point; anything under this is one. */
const DEDUPE_DEG = 1e-7;
/** Half the side of a border handle's 24 px hit box (drawn as a 6 px circle). */
const HANDLE_PX = 12;
/** Shift+Arrow in an edge field moves that edge this far. About a kilometre. */
const NUDGE_DEG = 0.01;
/** Shrink / Grow move every side by this share of the box. */
const BORDER_STEP = 0.1;
/** Pixel distance from the frame's OUTLINE that grabs the whole box. The fill is not
 *  a move target: after a pick it covers the viewport and would swallow every pan. */
const EDGE_PX = 8;
/** A move drag does nothing until the pointer has travelled this far, so a 1 px
 *  jitter during a pan cannot turn an `'auto'` frame `'custom'`. */
const MOVE_PX = 4;
/** How long the frame's caption stays a silent live region after the last change,
 *  so a drag announces the settled sentence once rather than every frame. */
const CAPTION_QUIET_MS = 500;
/** The eight handles, clockwise from the top-left. Each key names the edges it
 *  moves (`'nw'` moves north and west). */
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
/** CSS cursors for the handles, keyed the same way. */
const HANDLE_CURSOR = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
};

/**
 * The same literals `app.js`'s `buildMap` writes out (`--ink-2`, `--surface`,
 * `--gold-deep`, `--accent` from styles.css), because MapLibre paint takes no
 * `var()`. Keep the two copies in step by hand.
 */
const PAL = {
  light: {
    dot: '#556577', edge: '#fafafa', gold: '#906600', accent: '#202f40', muted: '#8b97a5',
  },
  dark: {
    dot: '#b5bfcb', edge: '#202f40', gold: '#ffbf40', accent: '#91b5dd', muted: '#7a8897',
  },
};

const STYLES = { light: TILES_LIGHT, dark: TILES_DARK };

const isDark = () => document.documentElement.classList.contains('wa-dark');
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Wire the picker. Idempotent: a second call on the same root returns the same
 * handle and resizes the map.
 *
 * @param {HTMLElement} root `#picker`, the landing stage; map and panel live inside it
 * @param {Object} [handlers]
 * @param {(selected: Map<string, Object>) => void} [handlers.onChange] the only way selection moves
 * @param {(ring: Array<[number, number]>|null) => void} [handlers.onRing]
 * @param {(border: {bbox: [number,number,number,number], mode: 'auto'|'custom'}|null) => void}
 *        [handlers.onBorder] the game-border frame, every time it moves or changes mode
 * @param {() => void} [handlers.onRemoveByo] clear the form's file/URL, which lives outside this root
 * @param {Object} handlers.doc the catalogue snapshot
 * @returns {{setByo: Function, resize: Function, destroy: Function}}
 */
export function initPicker(root, handlers = {}) {
  if (root && root.__picker) {
    if (root.__picker.resize) root.__picker.resize();
    return root.__picker;
  }
  const doc = handlers.doc;
  const onChange = handlers.onChange || (() => {});
  const onRing = handlers.onRing || (() => {});
  // The bring-your-own file/URL lives in the form, outside this root, so removing
  // it is a callback.
  const onRemoveByo = handlers.onRemoveByo || (() => {});
  // One-way like `onChange`: `app.js` reads the frame; nothing pushes one back in.
  const onBorder = handlers.onBorder || (() => {});

  const $ = (id) => root.querySelector(`#${id}`);
  const search = $('catalog-search');
  const resultsBox = $('catalog-results');
  const summaryBox = $('catalog-summary');
  const mapNote = $('map-note');
  const mapHost = $('catalog-map');
  const picksList = $('picks-list');
  const picksCount = $('picks-count');
  const noteBox = $('picker-note');
  const drawBtn = $('draw-shape');
  const clearBtn = $('draw-clear');
  const finishBtn = $('draw-finish');
  const swRegional = $('include-regional');
  const swInactive = $('include-inactive');
  const examplesBox = $('example-maps');
  const borderRow = $('border-row');

  const st = {
    doc,
    /** the rows the map and a drawn shape may use — the switches govern this */
    rows: visibleRows(doc, { regional: false, inactive: false }),
    /** `mdb:<id>` → SourceRef. The picker's half of `state.landing.selected`. */
    selected: new Map(),
    /** the bring-your-own ref, shown in the same list so there is one place to look */
    byo: null,
    /** the closed shape, `[[lat, lon], …]`, first point not repeated */
    ring: null,
    /** vertices while drawing */
    draft: [],
    rubber: null,
    boxA: null,
    drawing: false,
    boxing: false,
    suppressClick: false,
    results: [],
    /** how many rows matched in all, so a truncated list can say so */
    resultsTotal: 0,
    /** the row a click acted on, so focus survives the list being rebuilt */
    focusHint: null,
    /** true once the reader has typed something, so "no matches" can be said */
    searching: false,
    ringEmpty: false,
    /**
     * The drawn shape swept up nothing from the catalogue. Unlike `ringEmpty` (the
     * note's sentence, reset by every search) this is cleared only when the shape
     * goes, so the OpenStreetMap offer survives a typed search.
     */
    ringVacant: false,
    blocked: [],
    /**
     * The game-border frame, or null while nothing is picked. `'auto'` = fitted to
     * the picks and sent as null; `'custom'` = the reader's box, sent as-is.
     * `bbox` is `[S, W, N, E]`.
     * @type {{bbox: [number,number,number,number], mode: 'auto'|'custom'}|null}
     */
    border: null,
    /** what `#border-row` was last built for, so a rebuild happens only on a shape change */
    borderRowKey: '',
    /** a handle or outline drag in progress: `{kind, handle, origin, point, start, moved}`;
     *  `point` is the mousedown in screen pixels, which `MOVE_PX` is measured against */
    borderDrag: null,
    /** the cursor the last hover asked for, so an unchanged mousemove writes nothing */
    hoverCursor: '',
    map: null,
    mapPending: false,
    mapFailed: false,
    dark: isDark(),
    destroyed: false,
  };

  const rowById = new Map(doc.rows.map((row) => [row.id, row]));
  /** The `quietCaption` timer, so `destroy()` can cancel it. */
  let captionTimer = null;
  const listeners = [];
  /** Every listener goes through here so `destroy` can be exhaustive. */
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  };

  // ── selection ─────────────────────────────────────────────────────────────

  /** Feed slots spoken for. The bring-your-own file or URL counts, as `readSources` unions it. */
  function slotsUsed() {
    return st.selected.size + (st.byo ? 1 : 0);
  }

  /**
   * The drawn area picked as an OpenStreetMap source, or null. It lives in
   * `st.selected` so it counts against the cap like any other pick; there is at most
   * one, and `clearRing` takes it with the ring.
   */
  function osmPick() {
    for (const ref of st.selected.values()) if (ref && ref.kind === 'osm') return ref;
    return null;
  }

  /** The one funnel. Nothing else writes `st.selected`. */
  function commit() {
    renderPicksAndNote();
    renderResultsBox();
    renderExamplesBox();
    syncSelectedLayer();
    refitBorder();
    onChange(new Map(st.selected));
  }

  // ── example maps ───────────────────────────────────────────────────────────

  /** The chips this catalogue can serve; a dropped one is said once, in the console. */
  const examples = (() => {
    const found = exampleMapsFor(doc);
    for (const gone of found.missing) {
      // eslint-disable-next-line no-console
      console.warn(`example map "${gone.key}" is not offered: ${gone.ids.join(', ')} `
        + 'missing from the catalogue or behind an API key');
    }
    return found.examples;
  })();

  /** Which chip the selection is right now, or null. Exact set equality over the catalogue picks. */
  function pressedExample() {
    const picked = Array.from(st.selected.values())
      .filter((ref) => ref.kind !== 'osm').map((ref) => ref.mdbId);
    for (const ex of examples) {
      if (ex.rows.length !== picked.length) continue;
      const want = new Set(ex.rows.map((row) => row.id));
      if (picked.every((id) => want.has(id))) return ex.key;
    }
    return null;
  }

  function renderExamplesBox() {
    if (!examplesBox) return;
    const html = renderExampleMaps(examples, { pressedKey: pressedExample() });
    examplesBox.hidden = !html;
    examplesBox.innerHTML = html;
  }

  /**
   * Load one example. The chip REPLACES the catalogue picks ("Chicago" after "New
   * York" means Chicago); the bring-your-own feed and a drawn shape are left alone.
   */
  function applyExample(key) {
    const ex = examples.find((e) => e.key === key);
    if (!ex) return;
    st.blocked = [];
    for (const [id, ref] of Array.from(st.selected)) {
      if (ref.kind !== 'osm') st.selected.delete(id);
    }
    for (const row of ex.rows) {
      const ref = sourceRefFor(st.doc, row);
      if (slotsUsed() >= PICK_CAP) break;
      st.selected.set(ref.id, ref);
    }
    // A chip is "start over with this city": drop even a `'custom'` frame, or a New
    // York rectangle would govern a Chicago run from off-screen.
    st.border = null;
    commit();
    fitRows(ex.rows);
    if (picksCount && typeof picksCount.focus === 'function') safeFocus(picksCount);
  }

  /** Frame the map on a set of rows. A no-op until MapLibre has arrived. */
  function fitRows(rows) {
    if (!st.map || !rows.length) return;
    let [s, w, n, e] = rows[0].b;
    for (const row of rows) {
      s = Math.min(s, row.b[0]); w = Math.min(w, row.b[1]);
      n = Math.max(n, row.b[2]); e = Math.max(e, row.b[3]);
    }
    st.map.fitBounds([[w, s], [e, n]], { padding: 40, duration: reducedMotion() ? 0 : 600, maxZoom: 10 });
  }

  if (examplesBox) {
    renderExamplesBox();
    on(examplesBox, 'click', (event) => {
      const btn = event.target.closest ? event.target.closest('[data-example]') : null;
      if (!btn) return;
      event.preventDefault();
      applyExample(btn.getAttribute('data-example'));
    });
  }

  function addRow(row) {
    if (!row) return false;
    if (row.a) {                                   // needs an API key: not fetchable here
      const label = labelOf(row);
      // `st.blocked` describes the last action only: every search, shape and clear resets it.
      if (!st.blocked.includes(label)) st.blocked.push(label);
      renderPicksAndNote();
      return false;
    }
    const ref = sourceRefFor(st.doc, row);
    if (st.selected.has(ref.id)) return true;
    if (slotsUsed() >= PICK_CAP) { renderPicksAndNote(); return false; }
    st.selected.set(ref.id, ref);
    commit();
    return true;
  }

  function removeId(id) {
    if (st.byo && st.byo.id === id) { onRemoveByo(); return; }
    if (!st.selected.delete(id)) return;
    commit();
  }

  /**
   * Take the drawn shape itself as a source, to be built from OpenStreetMap. The
   * ring goes into the ref, since `sources` is all that crosses to the worker.
   * Focus lands on the pick count because the offer button is gone by the time this
   * returns.
   */
  function addOsmArea() {
    if (!st.ring || osmPick() || slotsUsed() >= PICK_CAP) { renderPicksAndNote(); return; }
    // Re-check the offer's premise: a stale button must not commit an assumed
    // timetable while a published feed overlaps the same shape.
    if (rowsIntersectingRing(st.rows, st.ring).length > 0) {
      st.ringVacant = false;
      st.ringEmpty = false;
      renderPicksAndNote();
      return;
    }
    const ref = osmSourceRef(st.ring);
    if (!ref) return;
    st.selected.set(ref.id, ref);
    // The area is the border. Seeded `'custom'` so it crosses the wire; an `'auto'`
    // frame would be sent as null and the worker would fit its own.
    st.border = { bbox: normBbox(bboxOf(st.ring)), mode: 'custom' };
    commit();
    if (picksCount && typeof picksCount.focus === 'function') safeFocus(picksCount);
  }

  // Delegated from the box, so the note can be rebuilt without rebinding.
  if (noteBox) {
    on(noteBox, 'click', (event) => {
      const btn = event.target.closest ? event.target.closest('[data-osm-build]') : null;
      if (!btn) return;
      event.preventDefault();
      addOsmArea();
    });
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  /** `[{id, label, where, badge, icon}]` — map picks first, then bring-your-own. */
  function pickViews() {
    const out = [];
    const ids = Array.from(st.selected.keys()).sort(cmpStr);
    for (const id of ids) {
      const ref = st.selected.get(id);
      const row = ref.mdbId === null ? null : rowById.get(ref.mdbId);
      if (ref.kind === 'osm') {
        // Its own badge and icon: the only row that is not a published timetable.
        out.push({
          id,
          label: ref.label,
          where: '',
          badge: 'estimated from OpenStreetMap',
          icon: 'map-location-dot',
        });
        continue;
      }
      out.push({
        id,
        label: ref.label,
        where: row ? placeOf(row) : '',
        badge: row && row.r ? 'regional' : (row && row.x ? 'no longer updated' : ''),
        icon: row && row.r ? 'route' : 'clock-rotate-left',
      });
    }
    if (st.byo) {
      out.push({
        id: st.byo.id,
        label: st.byo.label,
        where: '',
        badge: st.byo.kind === 'file' ? 'from your computer' : 'from a URL',
        icon: st.byo.kind === 'file' ? 'file-zipper' : 'link',
      });
    }
    return out;
  }

  function renderPicksAndNote() {
    const views = pickViews();
    picksList.innerHTML = renderPicks(views);
    if (st.focusHint && st.focusHint.list === 'picks') refocus();
    picksCount.textContent = views.length === 1
      ? '1 feed selected'
      : `${num(views.length)} feeds selected`;
    const osm = osmPick();
    noteBox.innerHTML = renderPickerNote({
      capped: slotsUsed() >= PICK_CAP,
      blocked: st.blocked,
      ringEmpty: st.ringEmpty,
      // Offered only while a drawn shape is vacant, a slot is free and it is untaken.
      osmOffer: Boolean(st.ring) && st.ringVacant && !osm && slotsUsed() < PICK_CAP,
      osmPicked: Boolean(osm),
    });
  }

  function renderResultsBox() {
    if (!st.results.length && !st.searching) {
      resultsBox.hidden = true;
      resultsBox.innerHTML = '';
      if (summaryBox) { summaryBox.hidden = true; summaryBox.textContent = ''; }
      return;
    }
    resultsBox.hidden = false;
    resultsBox.innerHTML = renderResults(st.results, {
      selectedIds: new Set(st.selected.keys()),
      full: slotsUsed() >= PICK_CAP,
      total: st.resultsTotal,
    });
    if (summaryBox && st.searching) {
      summaryBox.hidden = false;
      summaryBox.textContent = renderResultsSummary(st.results.length, st.resultsTotal);
    } else if (summaryBox) {
      summaryBox.hidden = true;
      summaryBox.textContent = '';
    }
    refocus();
  }

  /**
   * Put focus back after a list rebuild detaches the focused button: the next
   * control that still exists, then the previous one, then the box the row lived in.
   */
  function refocus() {
    const hint = st.focusHint;
    st.focusHint = null;
    if (!hint) return;
    const box = hint.list === 'picks' ? picksList : resultsBox;
    if (!box || box.hidden) return;
    const sel = hint.list === 'picks' ? '[data-remove]' : '[data-add]:not([disabled])';
    const rows = Array.from(box.querySelectorAll('.pick-row'));
    const key = hint.list === 'picks' ? 'data-row-id' : 'data-row';
    let here = rows.findIndex((row) => row.getAttribute(key) === String(hint.id));
    if (here < 0) here = rows.length;
    const order = rows.slice(here + 1).concat(rows.slice(0, here + 1).reverse());
    for (const row of order) {
      const btn = row.querySelector(sel);
      if (btn && typeof btn.focus === 'function') { safeFocus(btn); return; }
    }
    const fallback = hint.list === 'picks' ? picksCount : search;
    if (fallback && typeof fallback.focus === 'function') safeFocus(fallback);
  }

  /**
   * Focus that tolerates Web Awesome's timing: a freshly rebuilt `<wa-button>` throws
   * from `focus()` until its first update, and an unguarded throw would unwind
   * `commit()` before `onChange` ran. Retry after `updateComplete`.
   */
  function safeFocus(el) {
    try {
      el.focus();
    } catch {
      if (el.updateComplete) {
        el.updateComplete.then(() => { try { el.focus(); } catch { /* detached since */ } });
      }
    }
  }

  function runSearch() {
    st.blocked = [];
    const q = search && search.value ? String(search.value) : '';
    // Searches every row, not `st.rows`: a typed name overrides the switches (PLAN D15).
    st.searching = q.trim() !== '';
    const found = st.searching
      ? searchCatalog(st.doc.rows, q, { limit: SEARCH_LIMIT })
      : { rows: [], total: 0 };
    st.results = found.rows;
    st.resultsTotal = found.total;
    st.ringEmpty = false;
    renderResultsBox();
  }

  // ── search + list wiring, all synchronous, all before MapLibre ─────────────

  if (search) {
    on(search, 'input', runSearch);
    on(search, 'keydown', (event) => {
      if (event.key === 'Enter') {
        // Enter in a <form> input would submit it and start the analysis.
        event.preventDefault();
        const first = st.results.find((row) => !row.a && !st.selected.has(`mdb:${row.id}`));
        if (first) addRow(first);
        return;
      }
      if (event.key === 'ArrowDown') {
        const btn = resultsBox.querySelector('[data-add]');
        if (btn) { event.preventDefault(); btn.focus(); }
      }
    });
  }

  on(resultsBox, 'click', (event) => {
    const btn = event.target.closest ? event.target.closest('[data-add]') : null;
    if (!btn) return;
    event.preventDefault();
    st.focusHint = { list: 'results', id: btn.getAttribute('data-add') };
    addRow(rowById.get(btn.getAttribute('data-add')));
    refocus();                       // in case nothing re-rendered (a refused add)
  });

  // Arrow navigation over the Add buttons; Tab still reaches every one of them.
  on(resultsBox, 'keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = Array.from(resultsBox.querySelectorAll('[data-add]'));
    const here = buttons.indexOf(event.target.closest('[data-add]'));
    if (here < 0) return;
    event.preventDefault();
    const next = here + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) { if (search) search.focus(); return; }
    if (next < buttons.length) buttons[next].focus();
  });

  on(picksList, 'click', (event) => {
    const btn = event.target.closest ? event.target.closest('[data-remove]') : null;
    if (!btn) return;
    event.preventDefault();
    st.focusHint = { list: 'picks', id: btn.getAttribute('data-remove') };
    removeId(btn.getAttribute('data-remove'));
  });

  function onSwitch() {
    st.rows = visibleRows(st.doc, {
      regional: Boolean(swRegional && swRegional.checked),
      inactive: Boolean(swInactive && swInactive.checked),
    });
    syncFeedSource();
    // A switch flip changes what a standing shape sweeps up, so re-run the sweep
    // without auto-adding (flipping twice must not edit the picks) and retire a
    // vacancy note the flip has answered. A typed search keeps its own list.
    if (st.ring) {
      const hits = rowsIntersectingRing(st.rows, st.ring);
      st.ringVacant = hits.length === 0;
      if (!st.searching) {
        st.ringEmpty = hits.length === 0;
        st.results = hits.slice(0, 20);
        st.resultsTotal = hits.length;
        renderResultsBox();
      }
      renderPicksAndNote();
    }
  }
  if (swRegional) on(swRegional, 'change', onSwitch);
  if (swInactive) on(swInactive, 'change', onSwitch);

  // ── the draw tool ─────────────────────────────────────────────────────────

  function setDrawing(value) {
    st.drawing = value;
    // Drawing suspends the frame's hit-testing, so a drag cannot continue under it.
    if (value) endBorderDrag();
    st.rubber = null;
    st.boxing = false;
    st.boxA = null;
    // `suppressClick` is deliberately NOT cleared here: `closeRing` calls this from
    // `mouseup`, before MapLibre emits the trailing click that the flag must swallow.
    if (!value) st.draft = [];
    if (drawBtn) drawBtn.setAttribute('aria-pressed', value ? 'true' : 'false');
    if (finishBtn) finishBtn.hidden = !value;
    if (mapHost) mapHost.classList.toggle('drawing', value);
    if (st.map) {
      // Double-click zoom and shift-drag box-zoom are borrowed by the draw tool.
      if (value) { st.map.doubleClickZoom.disable(); st.map.boxZoom.disable(); }
      else { st.map.doubleClickZoom.enable(); st.map.boxZoom.enable(); }
      st.map.getCanvas().style.cursor = value ? 'crosshair' : '';
    }
    syncDrawSource();
  }

  function cancelDraw() {
    setDrawing(false);
    if (drawBtn && drawBtn.focus) drawBtn.focus();
  }

  function clearRing() {
    st.ring = null;
    st.ringEmpty = false;
    st.ringVacant = false;
    st.blocked = [];
    // The OpenStreetMap source IS the ring, so it goes with it; catalogue picks
    // outlive the shape because they name real operators.
    const osm = osmPick();
    if (osm) st.selected.delete(osm.id);
    // The results list was the shape's sweep; it goes too.
    if (!st.searching) st.results = [];
    if (clearBtn) clearBtn.hidden = true;
    onRing(null);
    // The area's frame was the box around the shape; the refit below seeds an
    // `'auto'` frame from whatever picks remain.
    if (osm) st.border = null;
    // `onChange` is the only way the main thread hears that a member was lost.
    if (osm) onChange(new Map(st.selected));
    syncDrawSource();
    syncSelectedLayer();
    refitBorder();
    renderPicksAndNote();
    renderResultsBox();
  }

  /** Drop the duplicate vertices a double-click leaves behind. */
  function tidy(points) {
    const out = [];
    for (const p of points) {
      const last = out[out.length - 1];
      if (last && Math.abs(last[0] - p[0]) < DEDUPE_DEG && Math.abs(last[1] - p[1]) < DEDUPE_DEG) continue;
      out.push(p);
    }
    return out;
  }

  function closeRing(points) {
    const ring = tidy(points || st.draft);
    if (ring.length < 3) return;
    st.ring = ring;
    setDrawing(false);
    if (clearBtn) clearBtn.hidden = false;
    onRing(ring.map((p) => [p[0], p[1]]));
    applyRing();
    syncDrawSource();
    // A ring is a sweep, not a border (final spec §1.6); the row is re-drawn only
    // for the "Box around my shape" button.
    renderBorderRowBox();
  }

  /** Every visible feed the shape touches, up to the cap. */
  function applyRing() {
    st.blocked = [];
    const hits = rowsIntersectingRing(st.rows, st.ring);
    st.ringEmpty = hits.length === 0;
    st.ringVacant = hits.length === 0;
    st.searching = false;
    st.results = hits.slice(0, 20);
    st.resultsTotal = hits.length;
    for (const row of hits) {
      if (slotsUsed() >= PICK_CAP) break;
      addRow(row);
    }
    renderResultsBox();
    renderPicksAndNote();
  }

  if (drawBtn) {
    on(drawBtn, 'click', (event) => {
      event.preventDefault();
      if (st.drawing) { cancelDraw(); return; }
      if (st.ring) clearRing();
      setDrawing(true);
    });
  }
  if (clearBtn) {
    on(clearBtn, 'click', (event) => { event.preventDefault(); clearRing(); });
  }
  if (finishBtn) {
    on(finishBtn, 'click', (event) => { event.preventDefault(); closeRing(); });
  }

  on(document, 'keydown', (event) => {
    if (!st.drawing) return;
    const tag = event.target && event.target.localName;
    if (tag === 'input' || tag === 'textarea' || tag === 'wa-input') return;
    if (event.key === 'Escape') { event.preventDefault(); cancelDraw(); }
    else if (event.key === 'Enter') { event.preventDefault(); closeRing(); }
    else if (event.key === 'Backspace') {
      event.preventDefault();
      st.draft.pop();
      syncDrawSource();
    }
  });

  // ── the border frame ──────────────────────────────────────────────────────

  /** Clamp to the world and put the edges in order; a frame dragged past itself
   *  turns inside out. Antimeridian frames are clamped, not supported (final spec §5). */
  function normBbox(b) {
    let s0 = Math.max(-90, Math.min(90, b[0]));
    let n0 = Math.max(-90, Math.min(90, b[2]));
    let w0 = Math.max(-180, Math.min(180, b[1]));
    let e0 = Math.max(-180, Math.min(180, b[3]));
    if (s0 > n0) { const t = s0; s0 = n0; n0 = t; }
    if (w0 > e0) { const t = w0; w0 = e0; e0 = t; }
    return [s0, w0, n0, e0];
  }

  /** The picked boxes the frame is fitted to, sorted by pick id so the union is deterministic. */
  function selectedBoxes() {
    const out = [];
    const ids = Array.from(st.selected.keys()).sort(cmpStr);
    for (const id of ids) {
      const ref = st.selected.get(id);
      if (ref.kind === 'osm' && ref.ring) { out.push(bboxOf(ref.ring)); continue; }
      const row = ref.mdbId === null ? null : rowById.get(ref.mdbId);
      if (row) out.push(row.b);
    }
    return out;
  }

  /** The `'auto'` frame: the union of the picked boxes, or null with nothing picked. */
  function seedBorder() {
    const u = bboxUnion(selectedBoxes());
    return u ? normBbox(u) : null;
  }

  /**
   * "Where they overlap": the intersection of every picked box when it has area,
   * else the largest-area intersection of any two, else null.
   */
  function overlapSeed() {
    const boxes = selectedBoxes();
    if (boxes.length < 2) return null;
    let all = boxes[0];
    for (let i = 1; i < boxes.length && all; i++) all = bboxIntersection(all, boxes[i]);
    if (all && bboxAreaSqM(all) > 0) return normBbox(all);
    let best = null;
    let bestArea = 0;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const x = bboxIntersection(boxes[i], boxes[j]);
        const a = x ? bboxAreaSqM(x) : 0;
        if (a > bestArea) { bestArea = a; best = x; }
      }
    }
    return best ? normBbox(best) : null;
  }

  /**
   * An `'auto'` frame follows the picks. A `'custom'` frame is left alone unless
   * nothing is picked any more.
   */
  function refitBorder() {
    const seed = seedBorder();
    if (!seed) st.border = null;
    else if (!st.border || st.border.mode === 'auto') st.border = { bbox: seed, mode: 'auto' };
    syncBorder();
  }

  /** Move the frame to `bbox` as the reader's own box. */
  function setBorder(bbox, opts = {}) {
    if (!bbox) return;
    st.border = { bbox: normBbox(bbox), mode: 'custom' };
    syncBorder(opts);
  }

  /** The frame as GeoJSON: one polygon (fill + line) and eight handle points. */
  function borderFeatures() {
    if (!st.border) return EMPTY;
    const [s, w, n, e] = st.border.bbox;
    const midLat = (s + n) / 2;
    const midLon = (w + e) / 2;
    const at8 = {
      nw: [n, w], n: [n, midLon], ne: [n, e], e: [midLat, e],
      se: [s, e], s: [s, midLon], sw: [s, w], w: [midLat, w],
    };
    const feats = [{
      type: 'Feature',
      properties: { role: 'frame' },
      geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
    }];
    for (const h of HANDLES) {
      feats.push({
        type: 'Feature',
        properties: { role: 'handle', handle: h },
        geometry: { type: 'Point', coordinates: toLngLat(at8[h]) },
      });
    }
    return { type: 'FeatureCollection', features: feats };
  }

  /** Everything that reads the frame, in one place: the map, the row, `app.js`. */
  function syncBorder(opts = {}) {
    setData('border', borderFeatures());
    renderBorderRowBox(opts);
    onBorder(st.border ? { bbox: st.border.bbox.slice(), mode: st.border.mode } : null);
  }

  /** What `renderBorderRow` and `renderBorderCaption` are told. `osmFrame` means the
   *  frame is STILL the box around the drawn shape, which a moved handle ends. */
  function borderView() {
    const osm = osmPick();
    const shapeBox = osm && osm.ring ? normBbox(bboxOf(osm.ring)) : null;
    const isShapeBox = Boolean(shapeBox) && Boolean(st.border)
      && shapeBox.every((v, i) => coord(v) === coord(st.border.bbox[i]));
    return {
      border: st.border,
      count: st.selected.size,
      areaSqM: st.border ? bboxAreaSqM(st.border.bbox) : 0,
      osmPicked: Boolean(osm),
      osmFrame: isShapeBox,
      overlap: overlapSeed() !== null,
      hasRing: Boolean(st.ring),
    };
  }

  /**
   * Keep `#border-caption` (a `role="status"` region) speaking at rest, not per
   * frame: each change silences it and arms a timer, and the settled sentence is
   * re-written once when the gesture stops. The visible text is never delayed.
   */
  function quietCaption(caption) {
    caption.setAttribute('aria-live', 'off');
    if (captionTimer !== null) clearTimeout(captionTimer);
    captionTimer = setTimeout(() => {
      captionTimer = null;
      const node = borderRow ? borderRow.querySelector('#border-caption') : null;
      if (!node) return;
      const settled = node.textContent;
      node.removeAttribute('aria-live');
      // Blank and re-write in one task: the mutation is what makes it speak.
      node.textContent = '';
      node.textContent = settled;
    }, CAPTION_QUIET_MS);
  }

  /**
   * Draw or patch `#border-row`. Rebuilt only when its shape changes, since an
   * `innerHTML` rebuild detaches the field being typed in; otherwise the caption and
   * the four field values are patched, skipping `opts.except` (the edge being typed)
   * so "41." is not normalised to "41" mid-keystroke.
   */
  function renderBorderRowBox(opts = {}) {
    if (!borderRow) return;
    const view = borderView();
    // Not keyed on mode or `osmFrame`: both change on the first keystroke in an edge
    // field and only affect the caption, which is patched below.
    const key = [Boolean(view.border), view.overlap, view.hasRing, view.osmPicked].join('|');
    if (key !== st.borderRowKey) {
      st.borderRowKey = key;
      const html = renderBorderRow(view);
      borderRow.innerHTML = html;
      borderRow.hidden = !html;
      return;
    }
    if (!view.border) return;
    const caption = borderRow.querySelector('#border-caption');
    if (caption) {
      caption.textContent = renderBorderCaption(view);
      quietCaption(caption);
    }
    const edges = { s: 0, w: 1, n: 2, e: 3 };
    for (const edge of Object.keys(edges)) {
      if (edge === opts.except) continue;
      const field = borderRow.querySelector(`[data-border-edge="${edge}"]`);
      if (!field) continue;
      const next = String(coord(view.border.bbox[edges[edge]]));
      if (field.value !== next) field.value = next;
    }
  }

  /**
   * A typed edge. Only a finite number moves anything; "-" and "41." are left be.
   * The empty string is rejected explicitly (`Number('')` is 0), a comma decimal is
   * normalised, and a committed non-number is put back with `aria-invalid` so the
   * field never disagrees with the map and the run.
   */
  function onBorderField(event, commitValue) {
    const field = event.target && event.target.closest
      ? event.target.closest('[data-border-edge]') : null;
    if (!field || !st.border) return;
    const edge = field.getAttribute('data-border-edge');
    const idx = { s: 0, w: 1, n: 2, e: 3 }[edge];
    const raw = String(field.value).trim();
    const value = raw === '' ? NaN : Number(raw.replace(',', '.'));
    if (!Number.isFinite(value)) {
      // Mid-keystroke is left alone; a committed non-number is put back.
      if (commitValue) {
        field.value = String(coord(st.border.bbox[idx]));
        field.setAttribute('aria-invalid', 'true');
      }
      return;
    }
    field.removeAttribute('aria-invalid');
    const next = st.border.bbox.slice();
    next[idx] = value;
    if (commitValue) {
      // `change` (the field was left): put the edges in order and write them back.
      setBorder(next);
      return;
    }
    // Live typing: keep the raw edge, even inverted for a moment, and leave this
    // field's text alone. The map and the caption follow; `change` tidies up.
    st.border = { bbox: next, mode: 'custom' };
    syncBorder({ except: edge });
  }

  if (borderRow) {
    on(borderRow, 'input', (event) => onBorderField(event, false));
    on(borderRow, 'change', (event) => onBorderField(event, true));
    on(borderRow, 'keydown', (event) => {
      const field = event.target && event.target.closest
        ? event.target.closest('[data-border-edge]') : null;
      if (!field || !st.border) return;
      if (event.key === 'Enter') {
        // Enter would submit the <form>; commit the edge instead, as leaving does.
        event.preventDefault();
        onBorderField(event, true);
        return;
      }
      // Shift+↑ / Shift+↓ nudge the edge; a plain arrow still moves the caret.
      if (!event.shiftKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      event.preventDefault();
      const idx = { s: 0, w: 1, n: 2, e: 3 }[field.getAttribute('data-border-edge')];
      const next = st.border.bbox.slice();
      next[idx] += event.key === 'ArrowUp' ? NUDGE_DEG : -NUDGE_DEG;
      setBorder(next);
    });
    on(borderRow, 'click', (event) => {
      const btn = event.target.closest ? event.target.closest('[data-border-action]') : null;
      if (!btn || btn.disabled) return;
      event.preventDefault();
      const action = btn.getAttribute('data-border-action');
      if (action === 'fit') {
        // The one way back to `'auto'`, and to a run that sends null.
        st.border = null;
        refitBorder();
      } else if (action === 'overlap') {
        setBorder(overlapSeed());
      } else if (action === 'from-shape') {
        if (st.ring) setBorder(bboxOf(st.ring));
      } else if (action === 'shrink' && st.border) {
        setBorder(bboxScale(st.border.bbox, 1 - BORDER_STEP));
      } else if (action === 'grow' && st.border) {
        setBorder(bboxScale(st.border.bbox, 1 + BORDER_STEP));
      }
    });
  }

  /**
   * The handle under a screen point, within a 24 px square, or null. Nearest wins.
   * Suspended while drawing, so a vertex click cannot grab a corner.
   */
  function handleAt(point) {
    const map = st.map;
    if (!map || !st.border || st.drawing || !map.getLayer('border-handle')) return null;
    const box = [
      [point.x - HANDLE_PX, point.y - HANDLE_PX],
      [point.x + HANDLE_PX, point.y + HANDLE_PX],
    ];
    const hits = map.queryRenderedFeatures(box, { layers: ['border-handle'] });
    let best = null;
    let bestD = Infinity;
    for (const f of hits) {
      const p = map.project(f.geometry.coordinates);
      const d = Math.hypot(p.x - point.x, p.y - point.y);
      if (d < bestD) { bestD = d; best = f.properties.handle; }
    }
    return best;
  }

  /**
   * Is the point on the frame's outline (within `EDGE_PX` of `border-line`) and not
   * over a marker the click should reach instead? The fill is left to `dragPan`.
   */
  function edgeAt(point) {
    const map = st.map;
    if (!map || !st.border || st.drawing || !map.getLayer('border-line')) return false;
    const markers = ['feeds-selected', 'feeds-dot', 'feeds-cluster'].filter((id) => map.getLayer(id));
    if (markers.length && map.queryRenderedFeatures(point, { layers: markers }).length) return false;
    const box = [
      [point.x - EDGE_PX, point.y - EDGE_PX],
      [point.x + EDGE_PX, point.y + EDGE_PX],
    ];
    return map.queryRenderedFeatures(box, { layers: ['border-line'] }).length > 0;
  }

  function beginBorderDrag(kind, handle, origin, point) {
    st.borderDrag = {
      kind, handle, origin, point: point || null, start: st.border.bbox.slice(), moved: false,
    };
    if (st.map) st.map.dragPan.disable();
    if (mapHost) mapHost.classList.add('border-dragging');
  }

  /** Apply the pointer at `[lat, lon]` to the drag in progress. `point` is the same
   *  position in screen pixels, when the caller has one. */
  function moveBorderDrag(here, point) {
    const d = st.borderDrag;
    if (!d || !st.border) return;
    // A whole-box move waits for `MOVE_PX` of travel, so a twitch while pressing
    // cannot turn an `'auto'` frame `'custom'`.
    if (d.kind === 'move' && !d.moved && point && d.point
      && Math.hypot(point.x - d.point.x, point.y - d.point.y) < MOVE_PX) return;
    const b = d.start.slice();
    if (d.kind === 'handle') {
      if (d.handle.includes('n')) b[2] = here[0];
      if (d.handle.includes('s')) b[0] = here[0];
      if (d.handle.includes('e')) b[3] = here[1];
      if (d.handle.includes('w')) b[1] = here[1];
    } else {
      // Move the whole box, stopping at the edge of the world so it cannot shrink.
      let dlat = here[0] - d.origin[0];
      let dlon = here[1] - d.origin[1];
      dlat = Math.max(-90 - b[0], Math.min(90 - b[2], dlat));
      dlon = Math.max(-180 - b[1], Math.min(180 - b[3], dlon));
      b[0] += dlat; b[2] += dlat; b[1] += dlon; b[3] += dlon;
    }
    d.moved = true;
    st.border = { bbox: normBbox(b), mode: 'custom' };
    syncBorder();
  }

  function endBorderDrag() {
    const d = st.borderDrag;
    if (!d) return;
    st.borderDrag = null;
    // Swallow the trailing click, which would toggle the marker under the handle.
    if (d.moved) st.suppressClick = true;
    if (st.map) st.map.dragPan.enable();
    if (mapHost) mapHost.classList.remove('border-dragging');
  }

  // A mouseup outside the canvas still ends the drag; MapLibre only reports its own.
  on(window, 'mouseup', endBorderDrag);
  on(window, 'touchend', endBorderDrag);
  on(window, 'touchcancel', endBorderDrag);

  // ── MapLibre ──────────────────────────────────────────────────────────────

  const toLngLat = (p) => [p[1], p[0]];

  /**
   * A MapLibre event's position as this repo's `[lat, lon]`, wrapped: `unproject`
   * does not wrap, so a click on a duplicate world copy comes back at lon −340.
   */
  const at = (event) => [
    event.lngLat.lat,
    (((event.lngLat.lng + 180) % 360) + 360) % 360 - 180,
  ];

  function feedFeatures() {
    return {
      type: 'FeatureCollection',
      features: st.rows.map((row) => ({
        type: 'Feature',
        properties: {
          id: `mdb:${row.id}`,
          mdb: row.id,
          p: labelOf(row),
          sub: placeOf(row),
          auth: Boolean(row.a),
          regional: Boolean(row.r),
          inactive: Boolean(row.x),
        },
        geometry: { type: 'Point', coordinates: toLngLat(centroidOf(row)) },
      })),
    };
  }

  const EMPTY = { type: 'FeatureCollection', features: [] };

  function bboxPolygon(bbox) {
    const [s, w, n, e] = bbox;
    return {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
      }],
    };
  }

  function drawFeatures() {
    const feats = [];
    const pts = st.ring || st.draft;
    if (st.ring) {
      const coords = st.ring.map(toLngLat);
      coords.push(coords[0]);
      feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords] } });
    } else if (st.draft.length) {
      const coords = st.draft.map(toLngLat);
      if (st.rubber && !st.boxing) coords.push(toLngLat(st.rubber));
      if (coords.length > 2) {
        feats.push({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Polygon', coordinates: [coords.concat([coords[0]])] },
        });
      } else if (coords.length > 1) {
        feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
      }
    }
    for (const p of pts) {
      feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: toLngLat(p) } });
    }
    return { type: 'FeatureCollection', features: feats };
  }

  const setData = (id, data) => {
    if (!st.map) return;
    const src = st.map.getSource(id);
    if (src) src.setData(data);
  };

  /**
   * The selected feeds as their own FeatureCollection: a marker and a bounding box
   * each. Not a filter over `feeds`, since a clustered point is never emitted as a
   * feature. The polygon carries no `mdb` on purpose: the click handler toggles
   * whatever it hits, and a county-sized box must not remove its feed.
   */
  function selectedFeatures() {
    const feats = [];
    const ids = Array.from(st.selected.keys()).sort(cmpStr);
    for (const id of ids) {
      const ref = st.selected.get(id);
      const row = ref.mdbId === null ? null : rowById.get(ref.mdbId);
      if (!row) continue;
      const [s, w, n, e] = row.b;
      feats.push({
        type: 'Feature',
        properties: { id, p: labelOf(row) },
        geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
      });
      feats.push({
        type: 'Feature',
        properties: { id, mdb: row.id, p: labelOf(row) },
        geometry: { type: 'Point', coordinates: toLngLat(centroidOf(row)) },
      });
    }
    return { type: 'FeatureCollection', features: feats };
  }

  function syncFeedSource() { setData('feeds', feedFeatures()); }
  function syncDrawSource() {
    setData('draw', drawFeatures());
    // A shape needs three vertices; the finish control says so.
    if (finishBtn) finishBtn.disabled = st.draft.length < 3;
  }
  function syncSelectedLayer() { setData('selected', selectedFeatures()); }

  function addLayers() {
    const map = st.map;
    const p = PAL[isDark() ? 'dark' : 'light'];

    map.addSource('feeds', {
      type: 'geojson',
      data: feedFeatures(),
      cluster: true,
      clusterRadius: 46,
      clusterMaxZoom: 11,
      clusterProperties: { locked: ['+', ['case', ['get', 'auth'], 1, 0]] },
    });
    map.addSource('selected', { type: 'geojson', data: selectedFeatures() });
    map.addSource('hover', { type: 'geojson', data: EMPTY });
    map.addSource('draw', { type: 'geojson', data: drawFeatures() });
    map.addSource('border', { type: 'geojson', data: borderFeatures() });

    // The selected boxes go under every marker and the hover box.
    map.addLayer({
      id: 'selected-fill', type: 'fill', source: 'selected',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': p.gold, 'fill-opacity': 0.1 },
    });
    map.addLayer({
      id: 'selected-line', type: 'line', source: 'selected',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'line-color': p.gold, 'line-width': 1.4, 'line-opacity': 0.9 },
    });

    // The game-border frame: a SOLID gold line, against the draw tool's dashed one.
    // Fill and line sit under the markers; the handles are added last, on top.
    map.addLayer({
      id: 'border-fill', type: 'fill', source: 'border',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': p.gold, 'fill-opacity': 0.06 },
    });
    map.addLayer({
      id: 'border-line', type: 'line', source: 'border',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'line-color': p.gold, 'line-width': 2.2, 'line-opacity': 1 },
    });

    map.addLayer({
      id: 'hover-fill', type: 'fill', source: 'hover',
      paint: { 'fill-color': p.accent, 'fill-opacity': 0.08 },
    });
    map.addLayer({
      id: 'hover-line', type: 'line', source: 'hover',
      paint: { 'line-color': p.accent, 'line-width': 1.2, 'line-opacity': 0.7 },
    });

    map.addLayer({
      id: 'feeds-cluster', type: 'circle', source: 'feeds', filter: ['has', 'point_count'],
      paint: {
        // A cluster of nothing but API-key feeds (`locked`) is drawn muted.
        'circle-color': ['case', ['==', ['get', 'locked'], ['get', 'point_count']], p.muted, p.accent],
        'circle-opacity': 0.75,
        'circle-radius': ['step', ['get', 'point_count'], 14, 10, 18, 50, 24],
        'circle-stroke-color': p.edge,
        'circle-stroke-width': 1.5,
      },
    });
    map.addLayer({
      id: 'feeds-cluster-count', type: 'symbol', source: 'feeds', filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        // OpenFreeMap's glyph endpoint ships Noto Sans only; MapLibre's default
        // "Open Sans Regular" 404s there and the label silently never draws.
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'text-allow-overlap': true,
      },
      paint: { 'text-color': p.edge },
    });
    map.addLayer({
      id: 'feeds-dot', type: 'circle', source: 'feeds', filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': ['case', ['get', 'auth'], p.muted, p.dot],
        'circle-opacity': 0.85,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 10, 6, 14, 9],
        'circle-stroke-color': p.edge,
        'circle-stroke-width': 1,
      },
    });
    map.addLayer({
      id: 'feeds-selected', type: 'circle', source: 'selected',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-color': p.gold,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 5, 10, 9, 14, 13],
        'circle-stroke-color': p.edge,
        'circle-stroke-width': 2,
      },
    });
    map.addLayer({
      id: 'feeds-label', type: 'symbol', source: 'feeds', filter: ['!', ['has', 'point_count']],
      minzoom: 9,
      layout: {
        'text-field': ['get', 'p'],
        'text-font': ['Noto Sans Regular'],   // see feeds-cluster-count
        'text-size': 11,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
      },
      paint: { 'text-color': p.dot, 'text-halo-color': p.edge, 'text-halo-width': 1.2 },
    });

    map.addLayer({
      id: 'draw-fill', type: 'fill', source: 'draw',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': p.gold, 'fill-opacity': 0.12 },
    });
    map.addLayer({
      id: 'draw-line', type: 'line', source: 'draw',
      filter: ['!=', ['geometry-type'], 'Point'],
      paint: { 'line-color': p.gold, 'line-width': 1.8, 'line-dasharray': [3, 2.4] },
    });
    map.addLayer({
      id: 'draw-vertex', type: 'circle', source: 'draw',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-color': p.gold, 'circle-radius': 4,
        'circle-stroke-color': p.edge, 'circle-stroke-width': 1.5,
      },
    });

    map.addLayer({
      id: 'border-handle', type: 'circle', source: 'border',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-color': p.edge, 'circle-radius': 6,
        'circle-stroke-color': p.gold, 'circle-stroke-width': 2,
      },
    });
  }

  const tip = () => document.getElementById('tt');

  function showTip(event, row) {
    const box = tip();
    if (!box) return;
    box.innerHTML = `<b>${esc(labelOf(row))}</b>${esc(placeOf(row))}`
      + `<br>about ${esc(num(spanKmOf(row)))} km across`
      + (row.a ? '<br>Needs an API key — this page cannot fetch it.' : '')
      + (row.r ? '<br>Regional / long-distance.' : '')
      + (row.x ? '<br>No longer updated.' : '');
    box.style.display = 'block';
    const w = box.offsetWidth;
    const x = Math.min(event.originalEvent.clientX + 14, window.innerWidth - w - 12);
    box.style.left = `${x}px`;
    box.style.top = `${event.originalEvent.clientY + 16}px`;
  }

  function hideTip() {
    const box = tip();
    if (box) box.style.display = 'none';
  }

  function bindMapEvents() {
    const map = st.map;

    map.on('mousemove', 'feeds-dot', (event) => {
      if (st.drawing) return;
      const feature = event.features && event.features[0];
      if (!feature) return;
      const row = rowById.get(feature.properties.mdb);
      if (!row) return;
      map.getCanvas().style.cursor = row.a ? 'not-allowed' : 'pointer';
      setData('hover', bboxPolygon(row.b));
      showTip(event, row);
    });
    map.on('mouseleave', 'feeds-dot', () => {
      if (!st.drawing) map.getCanvas().style.cursor = '';
      setData('hover', EMPTY);
      hideTip();
    });

    map.on('mouseenter', 'feeds-cluster', () => {
      if (!st.drawing) map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'feeds-cluster', () => {
      if (!st.drawing) map.getCanvas().style.cursor = '';
    });
    map.on('click', 'feeds-cluster', (event) => {
      if (st.drawing) return;
      const feature = event.features && event.features[0];
      if (!feature) return;
      const source = map.getSource('feeds');
      const centre = feature.geometry.coordinates;
      const clusterId = feature.properties.cluster_id;
      const go = (zoom) => {
        if (zoom !== null && zoom !== undefined && zoom > map.getZoom() + 0.05) {
          if (reducedMotion()) map.jumpTo({ center: centre, zoom });
          else map.easeTo({ center: centre, zoom });
          return;
        }
        // Coincident boxes never separate by zooming: list the members instead.
        listCluster(source, clusterId);
      };
      // maplibre-gl 4+ returns a promise; 3 took a callback. The CDN URL is unpinned.
      const maybe = source.getClusterExpansionZoom(clusterId, (err, zoom) => {
        if (!err) go(zoom);
      });
      if (maybe && typeof maybe.then === 'function') maybe.then(go).catch(() => {});
    });

    // ONE click handler: per-layer handlers fire for every layer under the cursor,
    // so a gold marker on its own dot would be added and removed in one click.
    map.on('click', (event) => {
      // The synthetic click after a shift-drag's mouseup is spent here, once.
      const swallowed = st.suppressClick;
      st.suppressClick = false;
      if (st.drawing) {
        if (swallowed) return;
        const here = at(event);
        if (st.draft.length >= 3) {
          const first = map.project(toLngLat(st.draft[0]));
          if (Math.hypot(first.x - event.point.x, first.y - event.point.y) <= CLOSE_PX) {
            closeRing();
            return;
          }
        }
        st.draft.push(here);
        syncDrawSource();
        return;
      }
      if (swallowed) return;
      // The whole gold marker is clickable, not only the smaller dot beneath it.
      const layers = ['feeds-selected', 'feeds-dot'].filter((id) => map.getLayer(id));
      if (!layers.length) return;
      const hit = map.queryRenderedFeatures(event.point, { layers })[0];
      if (!hit) return;
      const row = rowById.get(hit.properties.mdb);
      if (!row) return;
      const id = `mdb:${row.id}`;
      if (st.selected.has(id)) removeId(id);
      else addRow(row);
    });

    map.on('dblclick', (event) => {
      if (!st.drawing) return;
      if (event.preventDefault) event.preventDefault();
      closeRing();
    });

    map.on('mousemove', (event) => {
      if (st.borderDrag) { moveBorderDrag(at(event), event.point); return; }
      if (!st.drawing && st.border) {
        // Resize cursor over a handle, `move` over the outline, the map's own over the fill.
        const h = handleAt(event.point);
        const want = h ? HANDLE_CURSOR[h] : (edgeAt(event.point) ? 'move' : '');
        if (want !== st.hoverCursor) {
          st.hoverCursor = want;
          map.getCanvas().style.cursor = want;
        }
      }
      if (!st.drawing) return;
      if (st.boxing && st.boxA) {
        const b = at(event);
        st.draft = [st.boxA, [st.boxA[0], b[1]], b, [b[0], st.boxA[1]]];
      } else {
        st.rubber = at(event);
      }
      syncDrawSource();
    });

    // Shift-drag draws a two-corner rectangle.
    map.on('mousedown', (event) => {
      // A new gesture: whatever the last one asked to swallow is spent.
      st.suppressClick = false;
      // The frame first; drawing suspends the handles (`handleAt`). `preventDefault`
      // on the MapLibre event keeps `dragPan` from starting under the drag.
      if (!st.drawing && st.border && event.originalEvent.button === 0) {
        const h = handleAt(event.point);
        if (h) {
          event.preventDefault();
          beginBorderDrag('handle', h, at(event), event.point);
          return;
        }
        // The outline moves the whole box; the fill is the map's.
        if (edgeAt(event.point)) {
          event.preventDefault();
          beginBorderDrag('move', null, at(event), event.point);
          return;
        }
      }
      if (!st.drawing || !event.originalEvent.shiftKey) return;
      event.preventDefault();
      st.boxing = true;
      st.boxA = at(event);
      st.draft = [];
      map.dragPan.disable();
    });
    map.on('mouseup', (event) => {
      if (st.borderDrag) { endBorderDrag(); return; }
      if (!st.boxing) return;
      st.boxing = false;
      map.dragPan.enable();
      const b = at(event);
      const ring = [st.boxA, [st.boxA[0], b[1]], b, [b[0], st.boxA[1]]];
      st.boxA = null;
      st.suppressClick = true;
      // A zero-area drag is a click that happened to hold shift; ignore it.
      const box = bboxOf(ring);
      if (box[2] - box[0] < DEDUPE_DEG || box[3] - box[1] < DEDUPE_DEG) {
        st.draft = [];
        syncDrawSource();
        return;
      }
      closeRing(ring);
    });

    // Touch: a finger on a HANDLE drags it; anywhere else, the fill included, is
    // left to the map, or a phone could not pan once the frame fills the screen.
    map.on('touchstart', (event) => {
      if (st.drawing || !st.border || !event.point) return;
      const h = handleAt(event.point);
      if (!h) return;
      event.preventDefault();
      if (event.originalEvent && event.originalEvent.cancelable) event.originalEvent.preventDefault();
      beginBorderDrag('handle', h, at(event), event.point);
    });
    map.on('touchmove', (event) => {
      if (!st.borderDrag) return;
      event.preventDefault();
      if (event.originalEvent && event.originalEvent.cancelable) event.originalEvent.preventDefault();
      moveBorderDrag(at(event), event.point);
    });
    map.on('touchend', () => { if (st.borderDrag) endBorderDrag(); });
  }

  /** Put a cluster's members in the results list, where each has an Add button. */
  function listCluster(source, clusterId) {
    const take = (leaves) => {
      const rows = (leaves || [])
        .map((f) => rowById.get(f.properties.mdb))
        .filter((row) => row)
        .sort((a, b) => a.id - b.id);
      if (!rows.length) return;
      st.results = rows;
      st.resultsTotal = rows.length;
      st.searching = false;
      st.ringEmpty = false;
      renderResultsBox();
    };
    const maybe = source.getClusterLeaves(clusterId, 20, 0, (err, leaves) => {
      if (!err) take(leaves);
    });
    if (maybe && typeof maybe.then === 'function') maybe.then(take).catch(() => {});
  }

  /**
   * The map could not be built, usually a content blocker on the CDN. The card says
   * so rather than logging silently. `mapHost.hidden` is the one signal styles.css
   * §7 reads to collapse the landing stage to a centred card; `app.js` sets it too
   * when the catalogue never arrives.
   */
  function giveUpOnMap() {
    st.mapFailed = true;
    if (mapHost) mapHost.hidden = true;
    if (drawBtn) drawBtn.hidden = true;
    if (finishBtn) finishBtn.hidden = true;
    if (clearBtn) clearBtn.hidden = true;
    if (mapNote) {
      mapNote.hidden = false;
      mapNote.textContent = 'The map library did not load, so the map and the drawing '
        + 'tool are not here. The search box above finds every one of the same feeds.';
    }
  }

  async function ensureMap() {
    if (st.map || st.mapPending || st.mapFailed || st.destroyed) return;
    st.mapPending = true;
    let maplibregl;
    try {
      // `ns.default ?? ns`: maplibre-gl 6 dropped the default export. Same in `app.js`.
      const ns = await import(MAPLIBRE_JS);
      maplibregl = ns.default ?? ns;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('MapLibre unavailable — the feed map is omitted; search still works', err);
      giveUpOnMap();
      return;
    }
    if (st.destroyed) return;
    if (!maplibregl || !maplibregl.Map) {
      giveUpOnMap();
      return;
    }
    st.dark = isDark();
    mapHost.classList.toggle('dark-map', st.dark);
    try {
      st.map = new maplibregl.Map({
        container: mapHost,
        style: STYLES[st.dark ? 'dark' : 'light'],
        center: [-40, 34],
        zoom: 1.1,
        // Off: the map is the whole landing page, with nothing to scroll past.
        cooperativeGestures: false,
        attributionControl: { compact: true },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('MapLibre failed — the feed map is omitted; search still works', err);
      giveUpOnMap();
      return;
    }
    st.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    // `style.load` fires again after `setStyle` when the colour scheme flips.
    st.map.on('style.load', () => { if (!st.destroyed) addLayers(); });
    bindMapEvents();
    if (st.drawing) setDrawing(true);
  }

  // ── lazy load, resize, theme ──────────────────────────────────────────────

  let io = null;
  if (mapHost && typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        io.disconnect();
        io = null;
        ensureMap();
      }
    }, { rootMargin: '200px' });
    io.observe(mapHost);
  } else {
    ensureMap();
  }

  let ro = null;
  if (mapHost && typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => { if (st.map) st.map.resize(); });
    ro.observe(mapHost);
  }

  const retheme = () => {
    const next = isDark();
    if (next === st.dark || !st.map) return;
    st.dark = next;
    mapHost.classList.toggle('dark-map', next);
    st.map.setStyle(STYLES[next ? 'dark' : 'light']);
  };
  const scheme = window.matchMedia('(prefers-color-scheme: dark)');
  on(scheme, 'change', retheme);
  const mo = new MutationObserver(retheme);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  // ── the handle ────────────────────────────────────────────────────────────

  renderPicksAndNote();
  renderBorderRowBox();

  const handle = {
    /** The bring-your-own file or URL, shown in the same list. */
    setByo(ref) {
      const before = st.byo ? st.byo.id : '';
      st.byo = ref || null;
      if ((st.byo ? st.byo.id : '') === before) return;
      // The bring-your-own feed takes a slot, so the Add buttons follow it.
      renderPicksAndNote();
      renderResultsBox();
    },
    /** The card's box changed under the map — let MapLibre re-read it. */
    resize() { if (st.map) st.map.resize(); },
    destroy() {
      if (st.destroyed) return;
      st.destroyed = true;
      if (captionTimer !== null) { clearTimeout(captionTimer); captionTimer = null; }
      for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
      listeners.length = 0;
      if (io) { io.disconnect(); io = null; }
      if (ro) { ro.disconnect(); ro = null; }
      mo.disconnect();
      hideTip();
      // A hidden WebGL context held for the whole run is a leak.
      if (st.map) { st.map.remove(); st.map = null; }
      if (root) delete root.__picker;
    },
  };
  root.__picker = handle;
  return handle;
}
