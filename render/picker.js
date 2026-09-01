/**
 * render/picker.js — the landing map, after it is on the page.
 *
 * `initPicker(root, handlers)` is the only export `app.js` uses, exactly the way
 * `initStrategy(root, report)` is for the secret view. This is the ONLY module under
 * `render/` besides `simulator.js` and `deck.js` that mutates the DOM, and it owns
 * every pixel of the picker: the search box, the results list, the selected list, the
 * note, the MapLibre map, the draw tool and the theme observer.
 *
 * THE MAP IS NEVER THE ONLY PATH. Search, Add, Remove and Analyse are wired
 * synchronously and work in full before MapLibre is imported, and keep working if the
 * import never resolves — the same posture `renderNetworkMap` takes for §05 ("If your
 * browser blocks the map library the map is omitted and everything below still
 * works"). The library is fetched behind an `IntersectionObserver`, so a reader who
 * types an operator's name and presses Analyse never pays for it.
 *
 * THE DRAW TOOL IS HAND-ROLLED, AND THAT IS DELIBERATE. `CONTRACT.md` §0 pins an
 * exhaustive five-item external-asset allowlist; a drawing library would need two
 * more pinned modules and a contract amendment to buy "close a ring, hand me its
 * vertices", which is about 140 lines of `click` / `mousemove` / `keydown` below. Do
 * not "improve" this with a CDN import.
 *
 * TWO MAPS IN ONE DOCUMENT. §05's network map lives inside `app.js`'s
 * `PAGE_RUNTIME_JS`, which is one `String.raw` template that cannot contain a
 * backtick. This map is real module code and must stay out of it. It is also
 * `.remove()`d in `app.js`'s `enterRunningState`, because a hidden WebGL context held
 * for the whole run is a leak the reader pays for.
 *
 * THE BORDER FRAME IS HAND-ROLLED FOR THE SAME REASON. The moment a feed is picked
 * a solid gold rectangle — the game border — is drawn from the union of the picked
 * boxes, with eight handles on it (`border-handle`) that resize it and an outline
 * (`border-line`) that moves the whole box — the fill (`border-fill`) is a tint and
 * NOT a drag target, so the map can still be panned under a frame that covers the
 * viewport; everything is MapLibre's own `mousedown` / `mousemove` /
 * `touchstart` events, about 150 lines below. It has two modes and the distinction
 * is the whole design: an `'auto'` frame is a PREVIEW and is sent to the worker as
 * `null`, so a reader who never touches it gets exactly the run they got before the
 * frame existed; any drag, field edit or button other than Fit makes it `'custom'`
 * and its rectangle crosses the wire. `handlers.onBorder` is how `app.js` hears
 * which — the frame is owned here, read there, never pushed back in.
 *
 * COORDINATE CONVENTION. Everything in this repo is geographic `[lat, lon]` and
 * `[S, W, N, E]`; MapLibre is `[lng, lat]`. The conversion happens HERE, at the map
 * boundary, and nowhere else — `lib/catalog.js` and `lib/geo.js` never see a
 * MapLibre-ordered pair.
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
 * How many search results the box lists before it stops and says how many more matched.
 *
 * A subdivision query is what sets this: "new york" matches 101 rows, and every one of
 * them ties at the weakest tier, so the cut lands in the middle of a field the ranking
 * has no strong opinion about. 25 is enough to reach the NYC Subway, which sorts 22nd
 * behind a dozen larger bus networks — 496 rail stations against their thousands of
 * bus stops. It is a window, not a fix: `renderResultsSummary` still says how many
 * more matched, because a list silently cut is a list lying about the catalogue.
 */
const SEARCH_LIMIT = 25;

/** How close, in pixels, a click has to land to vertex 0 to close the ring. */
const CLOSE_PX = 10;
/** Two clicks of a double-click land on the same point; anything under this is one. */
const DEDUPE_DEG = 1e-7;
/** Half the side of a border handle's hit box: 24 px square, which is the smallest
 *  target a finger reliably lands on, drawn as a 6 px circle so it does not hide
 *  the marker it may sit on. */
const HANDLE_PX = 12;
/** Shift+Arrow in an edge field moves that edge this far. About a kilometre. */
const NUDGE_DEG = 0.01;
/** Shrink / Grow move every side by this share of the box. */
const BORDER_STEP = 0.1;
/** How close, in pixels, the pointer has to be to the frame's OUTLINE to grab the
 *  whole box. The fill is deliberately not a move target: after a pick the frame is
 *  the union of the picked boxes and the map is fitted to it, so a fill that started
 *  a drag would swallow every attempt to pan the map. */
const EDGE_PX = 8;
/** A move drag does nothing until the pointer has travelled this far. Below it a
 *  press is a press: without the threshold a 1 px jitter during an attempted pan
 *  silently turned an `'auto'` frame `'custom'`, which changes what the run is sent. */
const MOVE_PX = 4;
/** How long the frame's caption stays a silent live region after the last change.
 *  A drag or a held Shift+Arrow rewrites it dozens of times a second; `role="status"`
 *  would queue every one of them. Announce the settled sentence, once. */
const CAPTION_QUIET_MS = 500;
/** The eight handles, clockwise from the top-left. Each key names the edges it
 *  moves — `'nw'` moves north AND west — which is all the drag code reads. */
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
/** CSS cursors for the handles, keyed the same way. */
const HANDLE_CURSOR = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
};

/**
 * The same four literals `app.js`'s `buildMap` writes out — `--ink-2`, `--surface`,
 * `--gold-deep`, `--accent` from styles.css §1/§2 — because MapLibre paint takes no
 * `var()`. Kept in step with that copy by hand; there is no third place.
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
 * Wire the picker.
 *
 * Idempotent: a second call on the same root returns the same handle and resizes the
 * map, so nothing is double-bound and the reader's selection survives.
 *
 * @param {HTMLElement} root `#picker`, the landing stage — the map layer and the
 *        floating panel both live inside it, so every id is one `querySelector` away
 * @param {Object} [handlers]
 * @param {(selected: Map<string, Object>) => void} [handlers.onChange] the ONLY way selection moves
 * @param {(ring: Array<[number, number]>|null) => void} [handlers.onRing]
 * @param {(border: {bbox: [number,number,number,number], mode: 'auto'|'custom'}|null) => void}
 *        [handlers.onBorder] the game-border frame, every time it moves or changes mode
 * @param {() => void} [handlers.onRemoveByo] clear the form's file/URL — it is not ours
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
  // The bring-your-own file/URL is rendered in `#picks` alongside the map picks, but
  // it LIVES in the form, which is outside this root — so removing it is a callback,
  // not a local delete.
  const onRemoveByo = handlers.onRemoveByo || (() => {});
  // The frame, reported outward every time it changes. One-way like `onChange`:
  // `app.js` reads it into `state.landing.border` and mirrors it into the Advanced
  // panel; nothing pushes a frame back in.
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
     * The drawn shape swept up nothing from the catalogue. Distinct from `ringEmpty`,
     * which is the NOTE's sentence and is reset by every search — a reader who draws
     * an empty shape and then types a word has not made the shape less empty, and the
     * offer to build it from OpenStreetMap must not evaporate under them. Cleared only
     * when the shape itself goes.
     */
    ringVacant: false,
    blocked: [],
    /**
     * The game-border frame, or null while nothing is picked. `mode` is the whole
     * contract with `app.js`: `'auto'` = fitted to the picks and sent as null,
     * `'custom'` = the reader's box and sent as-is. `bbox` is `[S, W, N, E]`.
     * @type {{bbox: [number,number,number,number], mode: 'auto'|'custom'}|null}
     */
    border: null,
    /** what `#border-row` was last built for, so a rebuild happens only on a shape change */
    borderRowKey: '',
    /** a handle or outline drag in progress:
     *  `{kind, handle, origin, point, start, moved}` — `point` is the mousedown in
     *  screen pixels, which is what `MOVE_PX` is measured against */
    borderDrag: null,
    /** the cursor the last hover asked for — a handle's resize arrow, `move` over the
     *  frame's outline, or '' for the map's own. Compared, not recomputed, so a
     *  mousemove over unchanged ground writes nothing. */
    hoverCursor: '',
    map: null,
    mapPending: false,
    mapFailed: false,
    dark: isDark(),
    destroyed: false,
  };

  const rowById = new Map(doc.rows.map((row) => [row.id, row]));
  /** The `quietCaption` timer, so `destroy()` can cancel it. Not a pipeline clock:
   *  it decides when a live region speaks, never a number on the page. */
  let captionTimer = null;
  const listeners = [];
  /** Every listener goes through here so `destroy` can be exhaustive. */
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  };

  // ── selection ─────────────────────────────────────────────────────────────

  /**
   * How many of the run's feed slots are spoken for. The bring-your-own file or URL
   * counts: `readSources` unions it with the map picks, so ten picks plus a dropped
   * zip is eleven feeds, which is one more than a run merges.
   */
  function slotsUsed() {
    return st.selected.size + (st.byo ? 1 : 0);
  }

  /**
   * The drawn area picked as an OpenStreetMap source, or null.
   *
   * It lives in `st.selected` beside the catalogue picks rather than in a slot of its
   * own — which is what makes it count against the cap at every door without a second
   * rule, exactly the way `readSources` and the worker count it. There is at most one:
   * there is at most one ring, and `clearRing` takes the pick with it.
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

  /**
   * Which chip the selection IS right now, or null. Exact set equality over the
   * catalogue picks — an extra feed or a removed one is no longer that city, and a
   * pressed chip over a selection it does not describe is the chip lying.
   */
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
   * Load one example: the chip REPLACES the catalogue picks rather than adding to
   * them, because "Chicago" pressed after "New York" means Chicago, not a run that
   * merges two cities a thousand kilometres apart. The bring-your-own feed is left
   * alone — it lives in the form, not here — and so is a drawn shape, which is a
   * border, not a pick. Everything goes through `addRow`, so the cap, the API-key
   * refusal and the picks list see a chip exactly as they see ten clicks on Add.
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
    // The frame goes with the picks it was fitted to. `refitBorder` deliberately
    // leaves a `'custom'` frame alone — the reader put it there — but a chip is the
    // "start over with this city" gesture, and a New York rectangle kept across a
    // press of Chicago governs the run from off-screen: the map flies to Chicago, the
    // gold frame is not on it, and Analyse posts a box containing none of the picked
    // stops. Clearing it here refits an `'auto'` frame around the city that was asked
    // for, the same way the non-OSM picks above are replaced rather than added to.
    // (2026-08-27.)
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
      // `st.blocked` describes the LAST action, never the session: it is reset by
      // every search, every drawn shape and every clear, so a note about a locked
      // feed the reader glanced at ten minutes ago cannot still be sitting under a
      // selection that has nothing to do with it.
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
   * Take the drawn shape itself as a source, to be built from OpenStreetMap.
   *
   * The ring goes into the ref, not into an option: it is the input being read, and
   * `sources` is the only thing that crosses to the worker. Everything downstream —
   * the cap, `#picks`, the run label, `readSources`' sort — treats it as one more
   * feed, which is the whole point of putting it in `st.selected`.
   *
   * Focus lands on the pick count rather than on the button that was pressed, because
   * the button is gone by the time this returns: the note re-renders without the offer
   * so it cannot be taken twice, and the count is the live region that has just been
   * told there is one more feed.
   */
  function addOsmArea() {
    if (!st.ring || osmPick() || slotsUsed() >= PICK_CAP) { renderPicksAndNote(); return; }
    // The offer's premise, re-checked at the moment it is taken: a button left
    // standing by a stale render must not commit an assumed timetable while a
    // published feed overlapping the same shape is one switch away and visible.
    if (rowsIntersectingRing(st.rows, st.ring).length > 0) {
      st.ringVacant = false;
      st.ringEmpty = false;
      renderPicksAndNote();
      return;
    }
    const ref = osmSourceRef(st.ring);
    if (!ref) return;
    st.selected.set(ref.id, ref);
    // The area IS the border, by construction: one drawn shape, read once as the
    // extent to build from and once as the map to play on. Seeded `'custom'` so it
    // crosses the wire — an `'auto'` frame would be sent as null and the worker
    // would fit a border to the synthesized network instead, giving one gesture two
    // extents. `commit()`'s refit leaves a custom frame alone.
    st.border = { bbox: normBbox(bboxOf(st.ring)), mode: 'custom' };
    commit();
    if (picksCount && typeof picksCount.focus === 'function') safeFocus(picksCount);
  }

  // `#picker-note` had no listener before this: it is a `role="status"` region that
  // only ever printed sentences. The one control it now prints is delegated from the
  // box, so the note can be rebuilt as often as it likes without rebinding anything.
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
        // Its own badge and its own icon, because this row is the one thing in the
        // list that is not a published timetable: the network is drawn from
        // OpenStreetMap and the schedule on top of it is invented. A reader scanning
        // "what is about to run" has to be able to see that without reading §09.
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
      // Offered only in the moment it answers: a shape is drawn, the catalogue had
      // nothing inside it, there is a slot free, and it has not been taken yet.
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
   * Put focus back where the reader left it.
   *
   * Every Add and every Remove rebuilds its whole list, which detaches the focused
   * button and drops focus to `<body>` — so the next Tab restarts at the top of the
   * document and a keyboard reader cannot walk down the results adding two feeds.
   * The rule is deterministic: after acting on a row, take the next control that
   * still exists, then the previous one, then the box the row lived in.
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
   * Focus that tolerates Web Awesome's timing. A `<wa-button>` created by the
   * innerHTML rebuild one line ago is upgraded but not yet rendered, and its
   * `focus()` delegates to a shadow part that does not exist until the first
   * update — so the synchronous call throws. Left unguarded, that throw unwinds
   * `commit()` before `onChange` has run, which is how an added feed could sit in
   * the picks list while the Analyse button stayed dead. Try, and on the
   * pre-render throw, finish the job after the element's own `updateComplete`;
   * a second failure means the element is gone, and focus falls where it falls.
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
    // Searches EVERY row, not `st.rows`: a reader who typed the operator's name has
    // already told us which side of the regional threshold they are on (PLAN D15).
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
        // A text input inside a <form> submits it on Enter. Here that would start the
        // analysis from the search box, which is never what the reader meant.
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

  // Roving arrow navigation over the Add buttons: Tab still reaches every one of them,
  // and arrows are the shortcut a reader coming down from the search box expects.
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
    // A switch flip changes the catalogue's answer for a standing shape. The
    // vacancy note's own advice is "turn on the regional feeds above", so following
    // it must retire the note — and the OpenStreetMap offer whose premise it was —
    // rather than leave both standing over rows that now overlap the shape. The
    // sweep is re-run without auto-adding (flipping a switch twice must not edit
    // the picks), the results list follows unless a typed search owns it, and the
    // note's own sentence stays search-owned the way `runSearch` left it.
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
    // `suppressClick` is deliberately NOT cleared here. `closeRing` calls this from
    // inside `mouseup`, before MapLibre emits the trailing click — clearing it here
    // meant the flag never suppressed anything, and a shift-drag that ended over a
    // marker removed the very feed it had just swept up.
    if (!value) st.draft = [];
    if (drawBtn) drawBtn.setAttribute('aria-pressed', value ? 'true' : 'false');
    if (finishBtn) finishBtn.hidden = !value;
    if (mapHost) mapHost.classList.toggle('drawing', value);
    if (st.map) {
      // MapLibre owns double-click zoom and shift-drag box-zoom; both are exactly the
      // gestures the draw tool needs, so they are borrowed for the duration.
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
    // The shape and the OpenStreetMap source are one gesture, so they end together.
    // A catalogue pick outlives its ring on purpose — it names a real operator that
    // exists whether or not a shape is on the map — but an area source IS the ring,
    // and leaving it behind would send the worker a border the reader has erased.
    const osm = osmPick();
    if (osm) st.selected.delete(osm.id);
    // The results list was the shape's own list of what it swept up. The shape is
    // gone, so the list goes with it rather than outliving the thing it described.
    if (!st.searching) st.results = [];
    if (clearBtn) clearBtn.hidden = true;
    onRing(null);
    // The area's frame was the box around the shape; with the shape gone it is a
    // custom box around nothing, so it is dropped and the refit below seeds an
    // `'auto'` frame from whatever catalogue picks remain (or none).
    if (osm) st.border = null;
    // `st.selected` may have just lost a member, and `onChange` is the only way the
    // main thread hears about that — the re-renders below are this card's own copy.
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
    // A ring is a sweep, not a border (final spec §1.6): the frame is untouched
    // unless the sweep added feeds to an `'auto'` one, which `applyRing`'s commits
    // have already handled. The row is re-drawn for "Box around my shape" alone.
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

  /** Clamp to the map and put the edges in order. A frame the reader drags past
   *  itself turns inside out rather than refusing — the same rubber-band feel a
   *  shift-drag box has — and lat/lon never leave the world (final spec §5:
   *  antimeridian-straddling frames are clamped, not supported). */
  function normBbox(b) {
    let s0 = Math.max(-90, Math.min(90, b[0]));
    let n0 = Math.max(-90, Math.min(90, b[2]));
    let w0 = Math.max(-180, Math.min(180, b[1]));
    let e0 = Math.max(-180, Math.min(180, b[3]));
    if (s0 > n0) { const t = s0; s0 = n0; n0 = t; }
    if (w0 > e0) { const t = w0; w0 = e0; e0 = t; }
    return [s0, w0, n0, e0];
  }

  /**
   * The picked boxes the frame is fitted to: every catalogue pick's `b`, and the
   * box around a drawn OpenStreetMap area. Sorted by pick id like every other walk
   * over `st.selected`, so a union built from them is order-independent by
   * construction and an overlap search is deterministic.
   */
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
   * else the largest-area intersection of any two of them, else null. The pairwise
   * fallback is what makes the button useful on a three-feed pick where a small
   * outlying operator touches neither of the other two.
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
   * The frame follows the picks while it is `'auto'`: a pick added or removed
   * refits it, and the last pick going takes it with it. A `'custom'` frame is the
   * reader's and is left exactly where they put it — except when nothing is picked
   * any more, because a border with no feed inside it describes no run.
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

  /** What `renderBorderRow` and `renderBorderCaption` are told.
   *
   *  `osmPicked` is not simply "an OpenStreetMap area is picked": it is "and the frame
   *  is STILL the box around it". The caption's OSM sentence describes the frame as
   *  the box around the drawn shape, which stops being true the moment a handle moves
   *  it, and a frame the reader has dragged kilometres must not go on calling itself
   *  their shape's box. (2026-08-27.) */
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
   * Keep `#border-caption` a live region that speaks at REST, not per frame.
   *
   * The caption carries `role="status"` (render/landing.js) and is rewritten on every
   * `syncBorder` — which means on every `mousemove` of a drag and, worse for the
   * reader this is for, at the OS key-repeat rate while Shift+Arrow is held in an edge
   * field. That queues thirty announcements for a two-second press and the region goes
   * on speaking long after the frame stops moving. So each change silences the region
   * and arms a timer; when the gesture stops, the attribute comes off and the settled
   * sentence is re-written once, which is the one announcement worth making. The
   * VISIBLE text is never delayed. (2026-08-27.)
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
      // Blank and re-write in one task: the region is live again and the mutation is
      // what makes it speak, exactly once, with the sentence the reader ended on.
      node.textContent = '';
      node.textContent = settled;
    }, CAPTION_QUIET_MS);
  }

  /**
   * Draw or patch `#border-row`.
   *
   * Rebuilt only when its shape changes (frame present, overlap button, shape
   * button, OpenStreetMap wording): an `innerHTML` rebuild detaches the field being
   * typed in and drops the caret on the floor. Otherwise the caption's text node
   * and the four field values are patched — skipping `opts.except`, the edge whose
   * field is the SOURCE of this change, because writing a normalised number back
   * into a field mid-keystroke turns "41." into "41" under the reader's fingers.
   */
  function renderBorderRowBox(opts = {}) {
    if (!borderRow) return;
    const view = borderView();
    // Deliberately NOT keyed on the frame's mode or on `osmFrame`: both change on the
    // first keystroke in an edge field, and a rebuild there would detach the field
    // being typed in. They only ever change the CAPTION, which is patched below.
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
   *
   * Two things `Number(field.value)` alone got wrong, both of them silent:
   *   * `Number('')` is 0 and finite, so CLEARING the north field and tabbing out
   *     wrote north = 0, `normBbox` swapped the edges, and the game border quietly
   *     became a box from the equator to the old north;
   *   * `Number('42,9')` is NaN, so a reader on a keyboard whose decimal key is a
   *     comma — the `inputmode="decimal"` pad on a German or French phone — typed a
   *     number, saw nothing happen, and left the field reading `42,9` for the rest of
   *     the session while the run used the old value.
   * So: the empty string is rejected explicitly, a comma decimal is normalised, and a
   * value that is still not a number is REJECTED VISIBLY on commit — the edge in force
   * goes back into the field and `aria-invalid` says it was refused, rather than the
   * text being left to disagree with the map, the mirror and the run. (2026-08-27.)
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
      // Mid-keystroke ('-', '41.', a half-typed minus) is left alone; a COMMITTED
      // non-number is put back, because the field is the only place the reader can
      // see what the border actually is.
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
        // A text input inside a <form> submits it on Enter — here that would start
        // the analysis from an edge field, the same trap `#catalog-search` guards
        // against. Enter commits the edge instead, exactly as leaving the field does.
        event.preventDefault();
        onBorderField(event, true);
        return;
      }
      // Shift+↑ / Shift+↓ nudge the edge the field owns. Shift, so a plain arrow
      // still moves the caret through the digits.
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
        // The one way back to `'auto'` — and to a run that sends null.
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
   * The handle under a screen point, within a 24 px square, or null. Nearest wins
   * when a small frame puts two handles inside one hit box. Suspended while drawing,
   * because a click that starts a vertex must not grab a corner instead.
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
   * Is the point ON the frame's outline — within `EDGE_PX` of `border-line`, and not
   * over a marker the click should reach instead?
   *
   * The frame's FILL used to be the move target, which cost the card its primary
   * gesture: after a pick the frame is the union of the picked boxes and `fitRows`
   * fits the viewport to exactly that, so the fill covers essentially the whole
   * canvas and a plain drag-to-pan anywhere inside it moved the border instead — the
   * only surface left to pan with was a feed marker. The outline is a real target (the
   * cursor says `move` over it, the same way it says `nwse-resize` over a corner) and
   * it leaves the interior to `dragPan`, where a map's drag belongs. (2026-08-27.)
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
    // A whole-box move waits for `MOVE_PX` of travel. The first `mousemove` used to
    // set `mode: 'custom'` unconditionally, so a hand that twitched while pressing
    // turned an `'auto'` frame into a `'custom'` one — and `readOptions` then sends
    // the box instead of null, which is the difference between "the border is
    // inferred from what the start stop can reach" and "this rectangle is the map".
    if (d.kind === 'move' && !d.moved && point && d.point
      && Math.hypot(point.x - d.point.x, point.y - d.point.y) < MOVE_PX) return;
    const b = d.start.slice();
    if (d.kind === 'handle') {
      if (d.handle.includes('n')) b[2] = here[0];
      if (d.handle.includes('s')) b[0] = here[0];
      if (d.handle.includes('e')) b[3] = here[1];
      if (d.handle.includes('w')) b[1] = here[1];
    } else {
      // Move the whole box by the pointer's travel, and stop at the edge of the
      // world rather than letting one side clamp and the box shrink.
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
    // The click MapLibre fires after this mouseup would land on whatever is under
    // the handle — a marker, most likely — and toggle it. Spent the same way the
    // shift-drag's trailing click is.
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
   * A MapLibre event's position as this repo's `[lat, lon]`, WRAPPED.
   *
   * `unproject` is `360 * x - 180` with no wrap, so on a duplicate world copy — and
   * at the map's opening zoom the card is already wider than one world — a click over
   * Paris comes back at lon −340. Nothing in `lib/catalog.js` or `lib/geo.js` would
   * intersect it, and a drawn border would carry it to Overpass. The conversion
   * belongs here, at the map boundary, so it is done in exactly one place.
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
   * The selected feeds, as their own FeatureCollection: a marker AND the bounding
   * box for each, so a pick shows the extent of what it adds to the run, not only
   * where its middle is, and the box goes when the pick goes.
   *
   * They cannot come from the `feeds` source: that one clusters, and a clustered
   * point is not emitted as an individual feature — so at the zoom the map opens at,
   * where nearly every row is inside a cluster, a filter over `feeds` would match
   * nothing and pressing Add would change the map not at all.
   *
   * One source, two geometry types, layers filtered by `geometry-type`: the box is
   * drawn from the same feature list as the marker, so the two can never disagree
   * about which feeds are selected. The polygon carries no `mdb` on purpose — the
   * click handler toggles whatever it hits, and a box the size of a county must not
   * remove its feed when the reader clicks somewhere inside it.
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
    // Three vertices is the least a shape can be made of, so the finish control says
    // so rather than answering a tap with nothing.
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

    // The selected boxes go under every marker and the hover box, so a hovered
    // neighbour still reads on top of a pick the size of a county.
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

    // The game-border frame: a SOLID gold line, against the draw tool's dashed one,
    // so the border and a sweep never look like the same thing. Fill and line sit
    // under the markers like the selected boxes; the handles go on top of everything
    // (added last, below) so a corner on a marker is still a corner.
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
        // `locked` is the cluster property counting members that need an API key; a
        // cluster of nothing but those is drawn muted, like the dots inside it.
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
        // OpenFreeMap's glyph endpoint ships Noto Sans and nothing else. MapLibre's
        // own default stack is "Open Sans Regular", which 404s there — the count
        // simply never draws, in both styles, with only console noise to say why.
        // Both OpenFreeMap styles list this face; keep the two in step.
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
        // Coincident boxes: zooming will never separate them, so list the members in
        // the results box instead, where each one has a real Add button.
        listCluster(source, clusterId);
      };
      // maplibre-gl 4+ returns a promise; 3 took a callback. Support both, because
      // the CDN URL is unpinned by major version.
      const maybe = source.getClusterExpansionZoom(clusterId, (err, zoom) => {
        if (!err) go(zoom);
      });
      if (maybe && typeof maybe.then === 'function') maybe.then(go).catch(() => {});
    });

    // ONE click handler for the map, because two would fight. A layer-scoped
    // `map.on('click', 'feeds-dot')` fires for every layer under the cursor, so a
    // gold marker sitting on its own dot would be added and removed in one click;
    // and the trailing click after a shift-drag has to be swallowed for BOTH the
    // draw tool and the selection, which a per-layer handler cannot do.
    map.on('click', (event) => {
      // The synthetic click that follows a shift-drag's mouseup. Spent here, once,
      // whatever it lands on — a stale flag dies at the next mousedown instead.
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
        // The resize cursor over a handle, `move` over the outline between them, and
        // nothing over the fill — which keeps the map's own cursor, so the markers
        // under it can still say "pointer" and a drag there still pans.
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

    // Shift-drag → a two-corner rectangle. It is the gesture most people reach for,
    // and with boxZoom disabled for the duration it costs fifteen lines.
    map.on('mousedown', (event) => {
      // A new gesture: whatever the last one asked to swallow is spent.
      st.suppressClick = false;
      // The frame, before the draw tool: drawing suspends the handles (`handleAt`
      // says so), so the two never compete for one mousedown. `preventDefault` on
      // the MapLibre event is what keeps `dragPan` from starting under the drag.
      if (!st.drawing && st.border && event.originalEvent.button === 0) {
        const h = handleAt(event.point);
        if (h) {
          event.preventDefault();
          beginBorderDrag('handle', h, at(event), event.point);
          return;
        }
        // The OUTLINE moves the whole box; the fill is the map's, so a drag inside the
        // frame pans exactly as it does outside it.
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

    // Touch: a finger on a HANDLE drags it, and only then is the browser's default
    // prevented. A finger anywhere else, the fill included, is left to the map: on a
    // phone the frame fills the screen after a pick, and a fill that swallowed every
    // touch would be a map that cannot be panned. (Before 2026-09-01 the default
    // being prevented was also cooperativeGestures' "use two fingers" overlay; the
    // map is the whole page now and that mode is off — see `ensureMap`.)
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

  /** Put a cluster's members in the results list — the keyboard path to the same feeds. */
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
   * The map could not be built — usually a content blocker on the CDN.
   *
   * Hiding the host and logging to the console leaves the reader looking for a map
   * the lede has just promised, with nothing on the page to explain the gap. So the
   * card says what happened and where the same feeds are, which is the posture
   * `renderNetworkMap` already takes for §05.
   */
  /**
   * No map. `mapHost.hidden` is load-bearing beyond hiding the box: it is the ONE
   * signal styles.css §7 reads to collapse the landing stage back to a centred card,
   * so a page with no map is not a viewport of empty grid with a panel floating on
   * it. `app.js` hides the same node when the catalogue itself never arrives, which
   * is why there is one rule and not two.
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
      // `ns.default ?? ns`, never `.default` alone: maplibre-gl 6 dropped the default
      // export and ships named exports only. `app.js`'s buildMap carries the same note
      // and the same bug behind it.
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
        // OFF since 2026-09-01, and it was on for a good reason before: the map used
        // to be a 56vh box inside a scrolling column, where a wheel that zoomed
        // instead of scrolling past was a trap. The map is now the landing page —
        // full-bleed, viewport-tall, with nothing to scroll past — so requiring
        // ctrl+wheel and two fingers is friction with nothing left to protect.
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
    // Sources and layers are rebuilt on every `style.load`, which fires again after
    // `setStyle` when the colour scheme flips.
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
      // The results list too: the bring-your-own feed takes a slot, so the Add
      // buttons have to disable and re-enable with it.
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
      // A hidden WebGL context held for the whole run is a leak the reader pays for.
      if (st.map) { st.map.remove(); st.map = null; }
      if (root) delete root.__picker;
    },
  };
  root.__picker = handle;
  return handle;
}
