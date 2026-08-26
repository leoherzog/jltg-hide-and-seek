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
 * COORDINATE CONVENTION. Everything in this repo is geographic `[lat, lon]` and
 * `[S, W, N, E]`; MapLibre is `[lng, lat]`. The conversion happens HERE, at the map
 * boundary, and nowhere else — `lib/catalog.js` and `lib/geo.js` never see a
 * MapLibre-ordered pair.
 *
 * @module render/picker
 */

import { MAPLIBRE_JS, TILES_LIGHT, TILES_DARK, cmpStr, num } from '../lib/core.js';
import { bboxOf } from '../lib/geo.js';
import {
  visibleRows, searchCatalog, rowsIntersectingRing, centroidOf,
  labelOf, placeOf, spanKmOf, sourceRefFor, osmSourceRef,
} from '../lib/catalog.js';
import { esc } from './html.js';
import {
  renderResults, renderResultsSummary, renderPicks, renderPickerNote, PICK_CAP,
} from './landing.js';

/** How close, in pixels, a click has to land to vertex 0 to close the ring. */
const CLOSE_PX = 10;
/** Two clicks of a double-click land on the same point; anything under this is one. */
const DEDUPE_DEG = 1e-7;
/** A rough per-feed download, for the "this is a lot of bytes" warning. */
const EST_MB_PER_FEED = 25;

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
 * Wire the picker card.
 *
 * Idempotent: a second call on the same root returns the same handle and resizes the
 * map, so nothing is double-bound and the reader's selection survives.
 *
 * @param {HTMLElement} root the picker card
 * @param {Object} [handlers]
 * @param {(selected: Map<string, Object>) => void} [handlers.onChange] the ONLY way selection moves
 * @param {(ring: Array<[number, number]>|null) => void} [handlers.onRing]
 * @param {() => void} [handlers.onRemoveByo] clear the form's file/URL — it is not ours
 * @param {Object} handlers.doc the catalogue snapshot
 * @returns {{setByo: Function, refresh: Function, resize: Function, destroy: Function}}
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
  // Whether "Skip OpenStreetMap" is ticked RIGHT NOW. The switch lives in the form's
  // Advanced panel, outside this card, and `app.js` ticks it once and then leaves it
  // to the reader — so the note has to read its live state or it ends up instructing
  // someone to do what they have already done.
  const osmSkipped = handlers.osmSkipped || (() => false);
  // Whether the drawn shape is ALSO the game border right now. Same posture as
  // `osmSkipped`, for the same reason: `#opt-use-drawn-border` lives in the form's
  // Advanced panel and belongs to the reader after the one auto-tick, so the note
  // must read its live state or keep calling the shape the border after they have
  // said otherwise.
  const drawnBorderUsed = handlers.drawnBorderUsed || (() => false);

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
    map: null,
    mapPending: false,
    mapFailed: false,
    dark: isDark(),
    destroyed: false,
  };

  const rowById = new Map(doc.rows.map((row) => [row.id, row]));
  const listeners = [];
  /** Every listener goes through here so `destroy` can be exhaustive. */
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  };

  // ── selection ─────────────────────────────────────────────────────────────

  /**
   * How many of the run's feed slots are spoken for. The bring-your-own file or URL
   * counts: `readSources` unions it with the map picks, so six picks plus a dropped
   * zip is seven feeds, which is one more than a run merges.
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
    syncSelectedLayer();
    onChange(new Map(st.selected));
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

  /** The longitude guess D6 warns about. The worker reads `agency.txt` and decides. */
  function tzSpread() {
    const hours = new Set();
    for (const ref of st.selected.values()) {
      const row = ref.mdbId === null ? null : rowById.get(ref.mdbId);
      if (row) hours.add(Math.round(centroidOf(row)[1] / 15));
    }
    return hours.size > 1;
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
      count: views.length,
      capped: slotsUsed() >= PICK_CAP,
      osmSkipped: views.length > 1 && osmSkipped(),
      blocked: st.blocked,
      tzSpread: tzSpread(),
      ringEmpty: st.ringEmpty,
      // The OpenStreetMap area downloads no feed — it is read out of map files the
      // run would open anyway — so it is not counted into the "this is a lot of
      // bytes" estimate. Counting it would make the sentence wrong rather than
      // merely rough, which is the line this note does not cross.
      estMb: (views.length - (osm ? 1 : 0)) * EST_MB_PER_FEED,
      // Offered only in the moment it answers: a shape is drawn, the catalogue had
      // nothing inside it, there is a slot free, and it has not been taken yet.
      osmOffer: Boolean(st.ring) && st.ringVacant && !osm && slotsUsed() < PICK_CAP,
      osmPicked: Boolean(osm),
      drawnBorderUsed: drawnBorderUsed(),
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
      ? searchCatalog(st.doc.rows, q, { limit: 20 })
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
    // `st.selected` may have just lost a member, and `onChange` is the only way the
    // main thread hears about that — the re-renders below are this card's own copy.
    if (osm) onChange(new Map(st.selected));
    syncDrawSource();
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
   * The selected feeds, as their own FeatureCollection.
   *
   * They cannot come from the `feeds` source: that one clusters, and a clustered
   * point is not emitted as an individual feature — so at the zoom the map opens at,
   * where nearly every row is inside a cluster, a filter over `feeds` would match
   * nothing and pressing Add would change the map not at all.
   */
  function selectedFeatures() {
    const feats = [];
    const ids = Array.from(st.selected.keys()).sort(cmpStr);
    for (const id of ids) {
      const ref = st.selected.get(id);
      const row = ref.mdbId === null ? null : rowById.get(ref.mdbId);
      if (!row) continue;
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
      if (!st.drawing || !event.originalEvent.shiftKey) return;
      event.preventDefault();
      st.boxing = true;
      st.boxA = at(event);
      st.draft = [];
      map.dragPan.disable();
    });
    map.on('mouseup', (event) => {
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
        cooperativeGestures: true,
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
    /** Re-read whatever lives outside this card — today, the Skip OpenStreetMap switch. */
    refresh() { renderPicksAndNote(); },
    resize() { if (st.map) st.map.resize(); },
    destroy() {
      if (st.destroyed) return;
      st.destroyed = true;
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
