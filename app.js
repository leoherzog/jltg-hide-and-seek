/**
 * app.js — the main-thread controller.
 *
 * Ported from generate.py's S4 page assembly (`render_index`), day-switched payload
 * and client runtime (`SHARED_PAGE_JS` + `_S4_INDEX_JS`).
 *
 * The document is assembled progressively: the shell ships skeleton sections, the
 * worker streams staged partial results, and each section is swapped for real markup
 * as its data lands. The stat rail hydrates through a nested `data-section="glance"`
 * host inside the map section so its tiles can be corrected without re-mounting
 * `#netmap` and tearing down MapLibre.
 *
 * Division of labour: the worker computes and never touches the DOM; `render/*.js`
 * turn a `Report` into HTML strings and never touch the DOM; this file owns every
 * element, every listener and the worker protocol.
 *
 * @module app
 */

import {
  MAPLIBRE_JS, TILES_LIGHT, TILES_DARK,
  DEFAULT_DEPARTURE, BOARD_SLACK_S, MAX_FEEDS_PER_RUN,
  cmpStr, num, pct, mins, hhmm, prettyDate, rhu, quantile, coord,
} from './lib/core.js';

import {
  esc, el, join, waIcon, waCard, waDetails, jsonBlock, chip,
} from './render/html.js';

// The S4 formatting and day-view helpers are aliased back to their bare CLI names.
import {
  renderHero, renderVerdict, renderScoreTrace, renderYourGame, bandVariant,
  s4Imperial as imperial, s4Signed as signed, s4JoinWords as joinWords,
  s4DayView as dayView, s4DayOrder as dayOrder, s4DayLabel as dayLabel,
  s4BestDay as bestDay,
} from './render/verdict.js';
import {
  renderGlanceRail, renderNetworkMap, renderTransitReality, s4TilesHtml, s4MapCaption,
  S4_HEADWAY_BINS, s4DayByKey as dayByKey,
} from './render/map.js';
import {
  renderQuestions, renderCurses, renderProvenance, renderFooter, initDeckTables,
} from './render/deck.js';
// S5 (`render_strategy`) — the hider's guide. Not a section and not in `SECTIONS`:
// the fragment `#strategy` is the only door (see `applyRoute`).
import { renderStrategy } from './render/strategy.js';
import { initStrategy } from './render/simulator.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The placeholder every section passes as its ordinal (`_S4_ORDINAL`). Replaced with
 * the real number after empty sections are dropped, so the sequence has no gaps.
 */
const ORDINAL_PLACEHOLDER = '--';

/**
 * The one cross-load handoff (CONTRACT §(d)). "Re-run with this border" writes
 * `{v:1, sources, options, note}` here and reloads; `boot()` reads it, removes it,
 * validates it and starts the run without the picker. Session storage so the key
 * cannot outlive the tab; consumed exactly once.
 */
const RERUN_KEY = 'jltg.rerun';
/** The handoff's schema version. Anything else is ignored, never migrated. */
const RERUN_VERSION = 1;

/** `class Options`, minus everything meaningless in a browser. */
const DEFAULT_OPTIONS = Object.freeze({
  // Null means the default bucket, resolved in `worker.js` (`osm/worldfile.js`'s
  // `DEFAULT_WORLD_BASE_URL`); importing it here would pull the world reader onto
  // the main thread.
  worldBaseUrl: null,
  asOf: null,
  sizeOverride: null,
  zoneRadiusM: null,
  hidingPeriodMin: null,
  startStopId: null,
  borderShape: 'bbox',
  borderBbox: null,
  // Provenance only; no pipeline reads it (CONTRACT §(c)). `'landing'`, `'suggestion'`
  // or null when the border was inferred.
  borderSource: null,
  excludeStops: [],
  excludeRoutes: [],
  departure: DEFAULT_DEPARTURE,
  boardSlackS: BOARD_SLACK_S,
  offline: false,
  refresh: false,
});

/**
 * Section → the stage that first fills it, and the later stages that correct it.
 *
 * `redo` matters: `scoreZones` fills `QuestionAudit.surv_mean` in place (CONTRACT
 * §(d)), and the stat rail counts live questions and removed curses. A redo whose
 * markup is identical to what is on the page is skipped.
 *
 * Order is load-bearing for `glance` only: `hydrate` walks this array in order, and
 * `network` must mount the rail's empty host before `glance` mounts into it.
 */
const SECTIONS = [
  // The hero's headline counts `questions.length`, which is 0 until `rules`; `days`
  // adds the "Best day" chip.
  { id: 'hero', needs: 'feed', redo: ['days', 'network', 'rules', 'score'], render: (r) => renderHero(r) },
  // `geo` only: `s4Imperial` flips km→mi there. Scored zone dots arrive through
  // `#stops` and `refreshMapData()` (a `setData`, which keeps pan and zoom).
  { id: 'network', needs: 'network', redo: ['geo'], render: (r) => renderNetworkMap(r) },
  // Not numbered: the stat rail lives in a nested `data-section="glance"` host inside
  // §05 and redoes on everything §05 must not.
  { id: 'glance', needs: 'network', redo: ['days', 'geo', 'rules', 'score'], render: (r) => renderGlanceRail(r) },
  { id: 'yourgame', needs: 'score', redo: [], render: (r) => renderYourGame(r) },
  { id: 'transit', needs: 'network', redo: ['score'], render: (r) => renderTransitReality(r) },
  { id: 'verdict', needs: 'score', redo: [], render: (r) => renderVerdict(r) },
  { id: 'questions', needs: 'rules', redo: ['score'], render: (r) => renderQuestions(r) },
  { id: 'curses', needs: 'rules', redo: ['score'], render: (r) => renderCurses(r) },
  { id: 'trace', needs: 'score', redo: [], render: (r) => renderScoreTrace(r) },
  { id: 'sources', needs: 'provenance', redo: [], render: (r) => renderProvenance(r) },
  // Chrome, like the hero: its figures are corrected by every stage that changes one.
  { id: 'footer', needs: 'feed', redo: ['network', 'rules', 'score', 'provenance'], render: (r) => renderFooter(r) },
];

/**
 * The eight numbered sections, in page order. `hero` and the `glance` rail are
 * chrome and take no ordinal.
 *
 * `renumberSections` walks this array, not the DOM, to hand out `data-n`, so it, the
 * <section> order in index.html and the nav rail (which `bindSpy` walks in link
 * order) must stay in lockstep.
 *
 * The `§NN` written in comments throughout this repo is the port's original
 * numbering (§01 verdict … §09 sources), a nickname rather than the printed ordinal.
 * CONTRACT.md §(e) is the id → printed-ordinal map. (`render/strategy.js` and
 * `render/simulator.js` number the strategy view's own sections.)
 */
const NUMBERED = ['network', 'yourgame', 'transit', 'verdict',
  'questions', 'curses', 'trace', 'sources'];

/** What each stage is doing, in words a waiting human can act on. */
const STAGE_NOTE = {
  feed: 'Downloading and unzipping the GTFS feed.',
  days: 'Working out which service days this feed distinguishes.',
  network: 'Computing travel times from every stop and covering the map in hiding zones.',
  geo: 'Reading the OpenStreetMap data for this area.',
  rules: 'Auditing all 80 questions and 24 curses against this map.',
  score: 'Scoring the city out of 100 and ranking the hiding zones.',
  provenance: 'Collecting the receipts.',
};

/** What each stage was doing, for the fatal-error heading. */
const STAGE_DOING = {
  feed: 'reading the feed',
  days: 'reading the calendar',
  network: 'building the network',
  geo: 'reading the map',
  rules: 'auditing the rules',
  score: 'scoring',
  provenance: 'collecting sources',
};

/** Reader-facing section names, for the “could not be rendered” notice. */
const SECTION_NAME = {
  hero: 'the headline',
  network: 'The Map You’re Playing On',
  glance: 'At a Glance',
  yourgame: 'House Rules',
  transit: 'Getting Around',
  verdict: 'Verdict',
  questions: 'The Questions',
  curses: 'The Curse Deck',
  trace: 'Where the Points Came From',
  sources: 'Where These Numbers Come From',
  footer: 'the footer',
};

/**
 * The only door to S5. The seekers read the report, so nothing in the report view
 * may mention, link to or hint at this fragment. The guide may link back.
 */
const STRATEGY_HASH = '#strategy';

// ═══════════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The report as far as the worker has got. Every field is pre-seeded with an empty
 * container so an early renderer cannot trip over a missing key.
 * @returns {Object}
 */
function emptyReport() {
  return {
    opts: { ...DEFAULT_OPTIONS, source: '' },
    feed: {
      source: '', sha256: '', tables: {}, stops: {}, routes: {},
      agencyName: '', agencyUrl: '', timezone: '',
      feedStart: '', feedEnd: '', feedVersion: '', publisher: '',
    },
    // Counts from the `'feed'` stage; the real `feed.stops` / `feed.routes` maps do
    // not cross postMessage until `'done'`.
    feedCounts: { stops: 0, routes: 0, trips: 0 },
    proj: { lat0: 0, lon0: 0 },
    size: null,
    sizeInference: null,
    hub: null,
    border: null,
    // The worker's reachability-aware box (CONTRACT §(b) SuggestedBorder), or null.
    suggestedBorder: null,
    days: [],
    selectedDay: '',
    zones: [],
    metrics: {},
    routeHeadways: [],
    travelSamples: [],
    zoneReach: null,
    routeSpokes: [],
    spokeCap: null,
    stops: [],
    geo: emptyGeoLocal(),
    questions: [],
    questionOrder: [],
    questionFunnel: [],
    curses: [],
    fitness: null,
    caps: [],
    zoneScores: {},
    rankedZoneIds: [],
    dossierZoneIds: [],
    findings: [],
    recommendations: [],
    place: '',
    provenance: {},
    degradations: [],
    // Main-side only: the `kind` of every `SourceRef` the run was started with. §05's
    // suggestion callout reads it to know whether a re-run is possible (a `File`
    // cannot survive the reload). Stamped in `startRun`, fixed for the run.
    sourceKinds: [],
  };
}

/**
 * The unavailable `GeoData`, main-thread copy of `osm/geodata.js`'s `emptyGeoData`.
 * Kept byte-identical to CONTRACT §(b).
 * @returns {Object}
 */
function emptyGeoLocal() {
  return {
    available: false, bbox: [0, 0, 0, 0], pois: {}, counts: {},
    zoneInventory: {}, zonePolygonHits: {},
    admin: {
      countryCode: null, countryName: null, placeName: null,
      ordinals: {}, perZone: {}, borderLevels: {}, source: 'unknown', adminSource: 'unknown',
    },
    curseCounts: {}, cuisines: {}, legalSpots: {}, queries: [], notes: [],
  };
}

/**
 * Seconds of complete silence from the worker before the run is called dead. Not a
 * wall-clock deadline: the worker announces every round trip through `onProgress`,
 * so silence means a hung fetch, not a slow stage.
 */
const WORKER_SILENCE_S = 120;

const state = {
  /** @type {Worker|null} */ worker: null,
  /** @type {number|null} */ watchdog: null,
  /** @type {Object} */ report: emptyReport(),
  /** @type {Set<string>} */ arrived: new Set(),
  /** @type {string[]} */ degradations: [],
  /** The degradation list as it stood when the reader closed the toast, so a re-render
   *  does not put it back. Empty until they close one. */
  /** @type {string} */ degradationsDismissed: '',
  /** @type {Map<string,string>} */ rendered: new Map(),
  /** @type {Set<string>} */ dropped: new Set(),
  booted: false,
  running: false,
  finished: false,
  fatal: false,
  progress: { pct: 0, stage: '', label: '' },
  /** @type {number|null} */ heartbeat: null,
  /** Seconds since the last `progress` message. Chrome only — never a report value. */
  waitedS: 0,
  /** The report's `document.title`, parked while the secret view holds the tab.
   *  Empty means "not in the guide"; see `applyRoute`. */
  /** @type {string} */ strategyTitle: '',
  /**
   * What this run was started with, retained so a re-run can replay it. `source` is
   * the display string §09 echoes; `note` is the previous run's handoff note when
   * this run is itself a re-run (the `#run-history` chip reads it), else null.
   */
  run: {
    /** @type {Object[]|null} */ sources: null,
    /** @type {Object|null} */ options: null,
    /** @type {string} */ source: '',
    /** @type {Object|null} */ note: null,
  },
  /**
   * Landing-page feed picker. `selected` is `Map<string, SourceRef>` keyed by the
   * ref's stable `id`, the only place a map pick lives. With no picker on the page it
   * stays empty and `readSources` falls through to the bring-your-own card.
   */
  landing: {
    /** @type {Map<string, Object>} */ selected: new Map(),
    /**
     * The game-border frame the picker draws, or null. The picker owns it and reports
     * it through `onPickerBorder`. `'auto'` (fitted to the picks, untouched) sends
     * `borderBbox: null` so the worker infers the border; `'custom'` sends the
     * rectangle. With no frame `readOptions` falls back to the writable
     * `#opt-border-bbox` field.
     * @type {{bbox: [number,number,number,number], mode: 'auto'|'custom'}|null}
     */
    border: null,
    /** The picker's handle (`{ setByo, resize, destroy }`), or null when the
     *  catalogue never loaded. */
    /** @type {Object|null} */ picker: null,
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// Small DOM helpers
// ═══════════════════════════════════════════════════════════════════════════════

const $id = (id) => document.getElementById(id);

/**
 * The run form, addressed only by its `data-role` so dropping the attribute fails
 * loudly rather than falling back to whichever `<form>` comes first.
 */
function runForm() {
  return document.querySelector('form[data-role="runform"]');
}

/** `prefers-reduced-motion` — honoured for every transition this file animates. */
function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Parse an HTML string into a detached fragment. */
function parseHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content;
}

/** One animation frame. */
function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Boot
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wire the landing form and the progress readout, then wait.
 * Nothing runs until the user hands over a feed.
 */
export function boot() {
  if (state.booted) return;
  state.booted = true;
  ensureTooltipHost();
  const form = runForm();
  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      startRunFromForm(form);
    });
  }
  // `#suggest-rerun` lives inside §05's re-mounted string, so it is delegated from the
  // document. Wired here, not from `PAGE_RUNTIME_JS` (CONTRACT §05): the handoff
  // touches `state.run`, which the runtime cannot see.
  document.addEventListener('click', (event) => {
    const target = event.target;
    const button = target && target.closest ? target.closest('#suggest-rerun') : null;
    if (!button || button.disabled || button.hasAttribute('disabled')) return;
    event.preventDefault();
    rerunWithSuggestion();
  });
  // A URL and a file together is an error, so choosing a file clears the URL box.
  // `change` fires for a dialog pick, a drop and the remove control, so the re-sync
  // happens on every change.
  const fileInput = findFileInput(form);
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length) {
        const urlInput = findUrlInput(form);
        if (urlInput && urlInput.value) urlInput.value = '';
      }
      clearFormError();
      syncAnalyse();
    });
  }
  guardStrayDrops();
  // Chrome, not form: `data-when="report"`, and the only control left after `failed`.
  const reset = document.querySelector('wa-button[data-role="reset"]');
  if (reset) reset.addEventListener('click', resetToLanding);
  // A re-run handed over by the previous document (`RERUN_KEY`) skips the picker. The
  // key is gone by the time `takeRerunHandoff` returns, valid or not.
  const handoff = takeRerunHandoff();
  if (handoff) {
    state.run.note = handoff.note;
    mountRunHistory(handoff);
    startRun(handoff.sources, handoff.options, handoff.source);
  } else {
    initLanding();
  }
  // The whole router: one route, one fallback (the landing form).
  window.addEventListener('hashchange', applyRoute);
  applyRoute();
  setProgress({ stage: '', label: 'Waiting for a feed', done: 0, total: 0 });
}

/**
 * A file dropped outside the drop zone must not navigate the page away mid-run. Both
 * events are cancelled: `dragover` to make the page a legal target, `drop` to stop the
 * browser opening the file. `<wa-file-input>` owns the zone itself and stops
 * propagation of its own drops.
 */
function guardStrayDrops() {
  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (event) => event.preventDefault());
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// The landing feed picker
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The catalogue snapshot: a same-origin repo asset (CONTRACT §0) generated offline by
 * `tools/mdb-snapshot.mjs`, never fetched from upstream at runtime.
 */
const CATALOG_URL = new URL('./data/feeds.json', import.meta.url);

/** The Advanced panel's read-only mirror of the frame, wherever the markup put it. */
function borderMirror() {
  return document.querySelector('[data-opt="borderBbox"]');
}

/**
 * Keep `#analyse` honest: enabled exactly when there is something to run, labelled
 * with the count when there is more than one, and mirroring the bring-your-own file
 * or URL into `#picks`. Safe to call before the picker exists.
 */
function syncAnalyse() {
  const form = runForm();
  const byo = readByoSource(form);
  const ref = byo.error ? null : byo.ref;
  if (state.landing.picker) state.landing.picker.setByo(ref);

  const count = state.landing.selected.size + (ref ? 1 : 0);
  const button = $id('analyse');
  if (button) {
    // A file and a URL at once still counts as "something to run", so pressing
    // Analyse surfaces the error instead of leaving a dead button.
    button.disabled = count === 0 && !byo.error;
    const label = button.querySelector('[data-role="analyselabel"]');
    if (label) label.textContent = count > 1 ? `Analyse ${num(count)} feeds` : 'Analyse';
  }

}

/**
 * The reader removed the bring-your-own row from `#picks`. That row mirrors a control
 * the picker does not own, so the clearing happens here.
 */
function onPickerRemoveByo() {
  const form = runForm();
  const fileInput = findFileInput(form);
  if (fileInput) {
    // `<wa-file-input>.files` is a reactive `File[]`; an empty array re-renders the
    // card empty and the same file stays re-choosable.
    if (fileInput.localName === 'wa-file-input') {
      fileInput.files = [];
    } else {
      fileInput.value = '';
    }
  }
  const urlInput = findUrlInput(form);
  if (urlInput) urlInput.value = '';
  clearFormError();
  syncAnalyse();
}

/** The picker moved the selection. This is the ONLY writer of `state.landing.selected`. */
function onPickerChange(next) {
  state.landing.selected = next;
  clearFormError();
  syncAnalyse();
}

/**
 * The picker moved or dropped the game-border frame. The only writer of
 * `state.landing.border` and of `#opt-border-bbox`, which mirrors the frame with
 * `data-border-mode` saying whether it will be sent (`custom`) or inferred (`auto`).
 * `readOptions` reads the state, never the mirror's text.
 */
function onPickerBorder(border) {
  state.landing.border = border;
  const mirror = borderMirror();
  if (!mirror) return;
  mirror.value = border ? border.bbox.map((x) => String(coord(x))).join(', ') : '';
  mirror.setAttribute('data-border-mode', border ? border.mode : 'none');
  // Read-only while there is a frame, writable when there is not: a bring-your-own
  // zip or URL never produces a frame, and this field is then its only border input.
  // Losing the frame clears the text so stale numbers are not sent as a hard border.
  mirror.toggleAttribute('readonly', Boolean(border));
}

/**
 * Wire the landing panel, then try to build the picker on top of it.
 *
 * Order matters: the bring-your-own path is wired synchronously first, so a rejected
 * import or failed catalogue fetch cannot skip it. A catalogue failure degrades
 * silently: the map is hidden and the bring-your-own disclosure opens instead.
 * The picker modules are imported dynamically so the `#strategy` route and report
 * reloads never parse them.
 */
function initLanding() {
  const form = runForm();
  const urlInput = findUrlInput(form);
  if (urlInput) {
    urlInput.addEventListener('input', () => { clearFormError(); syncAnalyse(); });
  }
  initPanelGrip();
  syncAnalyse();

  const host = $id('picker');
  const body = host && host.querySelector('[data-role="pickerbody"]');
  if (!host || !body) return;

  // The catalogue is ~370 KB; one line holds the space while it loads. `index.html`
  // ships the same sentence, so this is a no-op on a cold load.
  body.innerHTML = '<p class="wa-caption-s wa-color-text-quiet" role="status">'
    + 'Loading the list of transit feeds…</p>';

  (async () => {
    const [catalog, landing, picker] = await Promise.all([
      import('./lib/catalog.js'),
      import('./render/landing.js'),
      import('./render/picker.js'),
    ]);
    const doc = await catalog.loadCatalog(CATALOG_URL);
    body.innerHTML = landing.renderPickerCard();
    state.landing.picker = picker.initPicker(host, {
      doc,
      onChange: onPickerChange,
      onBorder: onPickerBorder,
      onRemoveByo: onPickerRemoveByo,
    });
    syncAnalyse();
  })().catch((err) => {
    // Hide the map, not the host: the host is the stage and its panel carries the
    // bring-your-own disclosure, Advanced and Analyse, none of which need a
    // catalogue. Hiding the map collapses the stage to a centred card (styles.css §7
    // `NO MAP`, shared with `giveUpOnMap`).
    const map = host.querySelector('#catalog-map');
    if (map) map.hidden = true;
    body.innerHTML = '';
    const byo = $id('byo');
    if (byo) byo.open = true;
    // eslint-disable-next-line no-console
    console.warn('The feed catalogue is unavailable — bring your own feed instead', err);
  });
}

/**
 * The bottom sheet's grab bar. Landing chrome, not picker chrome: it must work when
 * the catalogue never loaded. It is `display: none` above the sheet breakpoint
 * (styles.css §7), so no media query is mirrored here. Collapsing leaves the foot,
 * where Analyse lives. The label is the button's only accessible name, so it says
 * what pressing does; `aria-expanded` carries the state.
 */
function initPanelGrip() {
  const grip = document.querySelector('[data-role="panelgrip"]');
  const panel = grip && grip.closest('.landing-panel');
  if (!grip || !panel) return;
  const label = grip.querySelector('[data-role="panelgriplabel"]');
  grip.addEventListener('click', () => {
    const collapsed = !panel.hasAttribute('data-collapsed');
    panel.toggleAttribute('data-collapsed', collapsed);
    grip.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    if (label) label.textContent = collapsed ? 'Show the panel' : 'Hide the panel';
  });
}

/** `<div id="tt">` — the page's own hover panel; `document()` emits it unconditionally. */
function ensureTooltipHost() {
  if (!$id('tt')) {
    const tt = document.createElement('div');
    tt.id = 'tt';
    document.body.appendChild(tt);
  }
}

/** `<wa-file-input>`'s `.files` is a `File[]`, interchangeable with a `FileList` here. */
function findFileInput(form) {
  const scope = form || document;
  return scope.querySelector('wa-file-input');
}

function findUrlInput(form) {
  const scope = form || document;
  return scope.querySelector('[data-opt="url"]');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Options
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Read one control's value in the shape `key` wants. `[data-opt="<key>"]` is the only
 * address; the kebab-case `id="opt-…"` attributes are documentation anchors.
 */
function readControl(form, key) {
  const scope = form || document;
  const node = scope.querySelector(`[data-opt="${key}"]`);
  if (!node) return undefined;
  const tag = node.localName;
  if (tag === 'wa-switch' || tag === 'wa-checkbox' || node.type === 'checkbox') {
    return node.checked === true;
  }
  const raw = node.value;
  return raw === null || raw === undefined ? undefined : String(raw);
}

/** '' / null / undefined → null; everything else trimmed. */
function orNull(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/** A finite number, or null. Never NaN — a NaN option silently poisons the pipeline. */
function orNumber(value) {
  const s = orNull(value);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** `'a, b b, a'` → `['a', 'b']`. Sorted and deduped, as CONTRACT §(c) requires. */
function idList(value) {
  const s = orNull(value);
  if (s === null) return [];
  const seen = new Set();
  for (const part of s.split(/[\s,]+/)) {
    const t = part.trim();
    if (t) seen.add(t);
  }
  return [...seen].sort(cmpStr);
}

/**
 * Assemble `Options` from the Advanced panel. Mirrors `parse_args`: `departure`
 * gains `':00'` when it has only one colon, the exclusion lists are sorted and
 * deduped, and `borderBbox` is four numbers or an error.
 *
 * @param {HTMLElement|null} form
 * @returns {{options: Object, errors: string[]}}
 */
function readOptions(form) {
  const errors = [];
  const options = { ...DEFAULT_OPTIONS };

  // Validated here so a bad value is a sentence under the form, not a failed fetch
  // four stages in. Trailing slashes come off so the provenance argv reads the same
  // bucket the same way.
  const worldBaseUrl = orNull(readControl(form, 'worldBaseUrl'));
  if (worldBaseUrl !== null) {
    let parsed = null;
    try {
      parsed = new URL(worldBaseUrl);
    } catch {
      errors.push('The map file base URL is not a URL. It needs to start with https://');
    }
    if (parsed && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      errors.push('The map file base URL has to be http:// or https://');
    } else if (parsed) {
      options.worldBaseUrl = worldBaseUrl.replace(/\/+$/, '');
    }
  }

  const asOf = orNull(readControl(form, 'asOf'));
  if (asOf !== null) {
    // Accept both the CLI's 'YYYYMMDD' and an <input type="date">'s 'YYYY-MM-DD'.
    const digits = asOf.replace(/-/g, '');
    if (!/^\d{8}$/.test(digits)) errors.push('Analysis date must be YYYY-MM-DD.');
    else options.asOf = digits;
  }

  const size = orNull(readControl(form, 'sizeOverride'));
  if (size !== null) {
    if (!['small', 'medium', 'large'].includes(size)) errors.push('Game size must be small, medium or large.');
    else options.sizeOverride = size;
  }

  const radius = orNumber(readControl(form, 'zoneRadiusM'));
  if (radius !== null) {
    if (radius <= 0) errors.push('Zone radius must be a positive number of metres.');
    else options.zoneRadiusM = radius;
  }

  const hiding = orNumber(readControl(form, 'hidingPeriodMin'));
  if (hiding !== null) {
    if (hiding <= 0) errors.push('Hiding period must be a positive number of minutes.');
    else options.hidingPeriodMin = hiding;
  }

  options.startStopId = orNull(readControl(form, 'startStopId'));

  const shape = orNull(readControl(form, 'borderShape'));
  if (shape !== null) {
    if (!['bbox', 'circle'].includes(shape)) errors.push('Border shape must be bbox or circle.');
    else options.borderShape = shape;
  }

  // With a frame, the border comes from the frame and its mode; the mirror field is
  // not parsed. `'auto'` sends null so the worker infers the border. `'custom'` sends
  // the rectangle and forces `borderShape` to `bbox`, since the reader set a
  // rectangle. With no frame (bring-your-own, or a failed catalogue) the field is the
  // input. `borderSource` is provenance only.
  const frame = state.landing.border;
  if (!frame) {
    const typed = orNull(readControl(form, 'borderBbox'));
    if (typed !== null) {
      const parts = typed.split(/[\s,]+/).filter((x) => x !== '').map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        errors.push('Border box must be exactly four numbers: south, west, north, east.');
      } else if (parts[0] >= parts[2] || parts[1] >= parts[3]) {
        errors.push('The game border has no area: south must be below north and west left of east.');
      } else {
        options.borderBbox = /** @type {[number,number,number,number]} */ (parts.map((x) => coord(x)));
        options.borderSource = 'landing';
      }
    }
  } else if (frame.mode === 'custom') {
    const b = frame.bbox;
    if (b.length !== 4 || b.some((n) => !Number.isFinite(n))) {
      errors.push('Border box must be exactly four numbers: south, west, north, east.');
    } else if (b[0] >= b[2] || b[1] >= b[3]) {
      errors.push('The game border has no area: south must be below north and west left of east.');
    } else {
      // `coord()`-quantised (6 dp), so the rectangle sent is the one the mirror prints.
      options.borderBbox = /** @type {[number,number,number,number]} */ (b.map((x) => coord(x)));
      options.borderShape = 'bbox';
      options.borderSource = 'landing';
    }
  }

  options.excludeStops = idList(readControl(form, 'excludeStops'));
  options.excludeRoutes = idList(readControl(form, 'excludeRoutes'));

  const departure = orNull(readControl(form, 'departure'));
  if (departure !== null) {
    // `parse_args`: 'HH:MM' gains ':00'. Anything else has to be HH:MM:SS already.
    const value = departure.split(':').length === 2 ? `${departure}:00` : departure;
    if (!/^\d{1,2}:\d{2}:\d{2}$/.test(value)) errors.push('Departure time must be HH:MM or HH:MM:SS.');
    else options.departure = value;
  }

  const slack = orNumber(readControl(form, 'boardSlackS'));
  if (slack !== null) {
    if (slack < 0) errors.push('Boarding slack cannot be negative.');
    else options.boardSlackS = slack;
  }

  const offline = readControl(form, 'offline');
  if (typeof offline === 'boolean') options.offline = offline;
  const refresh = readControl(form, 'refresh');
  if (typeof refresh === 'boolean') options.refresh = refresh;

  return { options, errors };
}

/**
 * The bring-your-own half: the file input and the URL box. A `File` must end `.zip`.
 * A URL only has to be http(s): many agencies serve the zip from an extensionless
 * path or a script handler, so `unzip` in gtfs/feed.js raises the error if the bytes
 * are not a zip.
 *
 * @returns {{ref: Object|null, error: string}} a `SourceRef` (CONTRACT.md §(d)), or null
 */
function readByoSource(form) {
  const fileInput = findFileInput(form);
  const file = (fileInput && fileInput.files && fileInput.files[0]) || null;
  const urlInput = findUrlInput(form);
  const url = orNull(urlInput ? urlInput.value : null);

  if (file && url) {
    return {
      ref: null,
      error: 'Pick a file or paste a URL — not both. Clear one of them and try again.',
    };
  }
  if (file) {
    if (!/\.zip$/i.test(file.name)) {
      return {
        ref: null,
        error: `“${file.name}” is not a .zip. A GTFS feed is a zip archive of .txt tables — `
          + 'pick the archive itself, not a file from inside it.',
      };
    }
    return {
      ref: {
        kind: 'file',
        file,
        url: null,
        id: `file:${file.name}:${file.size}`,
        label: file.name,
        mdbId: null,
      },
      error: '',
    };
  }
  if (url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ref: null, error: 'That is not a URL. It needs to start with https://' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ref: null, error: 'The feed URL has to be http:// or https://' };
    }
    return {
      ref: {
        kind: 'url', file: null, url, id: `url:${url}`, label: url, mdbId: null,
      },
      error: '',
    };
  }
  return { ref: null, error: '' };
}

/**
 * Everything the run will read, as a `SourceRef[]` (CONTRACT.md §(d)). The map picks
 * and the bring-your-own file or URL add rather than replace. Sorted by stable `id`
 * so the same selection always posts the same message; the merge order is decided
 * in the worker from the feed bytes.
 *
 * @returns {{sources: Object[], source: string, error: string}}
 */
function readSources(form) {
  const byId = new Map();
  for (const ref of state.landing.selected.values()) {
    if (ref && ref.id) byId.set(String(ref.id), ref);
  }

  const byo = readByoSource(form);
  if (byo.error) return { sources: [], source: '', error: byo.error };
  if (byo.ref) byId.set(byo.ref.id, byo.ref);

  const sources = Array.from(byId.keys())
    .sort(cmpStr)
    .map((id) => byId.get(id));
  if (!sources.length) {
    return {
      sources: [],
      source: '',
      error: 'Pick a city on the map, or choose a GTFS .zip from your computer '
        + 'or paste a link to one.',
    };
  }
  // Enforced here as well as in the picker: a reader with the maximum map picks can
  // still drop a zip into "Or bring your own feed".
  if (sources.length > MAX_FEEDS_PER_RUN) {
    return {
      sources: [],
      source: '',
      error: `That is ${num(sources.length)} feeds, and one run merges at most `
        + `${num(MAX_FEEDS_PER_RUN)}. Remove ${num(sources.length - MAX_FEEDS_PER_RUN)} `
        + 'of them and run the rest.',
    };
  }
  return {
    sources,
    // The display string §09 echoes.
    source: sources.map((ref) => ref.label).join(' + '),
    error: '',
  };
}

/** The callout lives in the shell (index.html); there is only something to reveal. */
function formErrorBox() {
  const box = document.querySelector('#landing-error');
  return { box, text: box && box.querySelector('[data-role="formerrortext"]') };
}

function showFormError(message) {
  const { box, text } = formErrorBox();
  if (!box || !text) return;
  // Unhide first, or `role="alert"` has nothing to announce.
  box.hidden = false;
  text.textContent = message;
}

function clearFormError() {
  const { box, text } = formErrorBox();
  if (!box) return;
  box.hidden = true;
  // Blank it too, or re-submitting an unfixed form mutates nothing and the alert
  // stays silent.
  if (text) text.textContent = '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// The run
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate the form, spawn the worker and post the single `run` message. The `File`
 * crosses by structured clone; reading it into an `ArrayBuffer` here would double
 * peak memory.
 */
function startRunFromForm(form) {
  if (state.running) return;
  clearFormError();

  const src = readSources(form);
  if (src.error) {
    showFormError(src.error);
    return;
  }
  const { options, errors } = readOptions(form);
  if (errors.length) {
    showFormError(errors.join(' '));
    return;
  }
  startRun(src.sources, options, src.source);
}

/**
 * Spawn the worker and post the single `run` message for an already-validated
 * `SourceRef[]` and `Options`. Called by the landing form and by `boot()` replaying a
 * re-run handoff; each validates its own input first.
 *
 * @param {Object[]} sources `SourceRef[]` (CONTRACT §(d)), sorted by `id`
 * @param {Object} options an `Options` (CONTRACT §(c))
 * @param {string} source the display string §09 echoes as `Options.source`
 */
function startRun(sources, options, source) {
  if (state.running) return;
  state.run = { ...state.run, sources, options, source };
  // `source` stays on this side: CONTRACT §(c) carries the inputs in `sources`.
  state.report.opts = { ...options, source };
  state.report.sourceKinds = sources.map((ref) => String(ref.kind));

  let worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    showFormError(`This browser could not start the analysis (${err && err.name}). `
      + 'The page has to be served over http, not opened from disk.');
    return;
  }
  state.worker = worker;
  state.running = true;

  worker.addEventListener('message', (event) => {
    armWatchdog();
    try {
      onWorkerMessage(event.data);
    } catch (err) {
      // A renderer throwing must not silently stop the run.
      recordDegradation(`The page could not render part of the report (${err && err.message}).`);
      // eslint-disable-next-line no-console
      console.error(err);
    }
  });
  worker.addEventListener('error', (event) => {
    fatalError('worker', event.message || 'The analysis stopped unexpectedly.');
  });
  worker.addEventListener('messageerror', () => {
    fatalError('worker', 'The analysis sent a message this browser could not read.');
  });

  enterRunningState({ sources });
  armWatchdog();
  worker.postMessage({ type: 'run', options, sources });
}

// ═══════════════════════════════════════════════════════════════════════════════
// The cached re-run
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * "Re-run with this border": store the handoff and reload.
 *
 * A re-run is a new document (see `resetToLanding`), so the run's inputs go through
 * `RERUN_KEY`: the same `SourceRef[]` (URL and OSM refs only; a `File` cannot survive
 * the reload, which is why §05's button is disabled then), the same `Options` with
 * the suggested box in `borderBbox`, `borderShape` forced to `bbox`, `sizeOverride`
 * cleared so the second run measures the in-border game itself, and `borderSource:
 * 'suggestion'`. `note` feeds the second run's `#run-history` chip.
 *
 * If storage refuses, the box goes to the clipboard with a sentence saying where to
 * paste it.
 */
function rerunWithSuggestion() {
  const sb = state.report.suggestedBorder;
  const run = state.run;
  if (!sb || !Array.isArray(sb.bbox) || !run.sources || !run.options) return;
  if (run.sources.some((ref) => ref.kind === 'file')) return;
  const bbox = sb.bbox.map((x) => coord(x));
  const handoff = {
    v: RERUN_VERSION,
    sources: run.sources.map(portableSourceRef),
    options: {
      ...run.options,
      borderBbox: bbox,
      borderShape: 'bbox',
      sizeOverride: null,
      borderSource: 'suggestion',
    },
    note: {
      prevSize: state.report.size ? String(state.report.size.name) : null,
      prevBorderSource: run.options.borderSource || null,
      run: ((run.note && run.note.run) || 1) + 1,
    },
  };
  try {
    sessionStorage.setItem(RERUN_KEY, JSON.stringify(handoff));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[app] could not store the re-run handoff', err);
    const line = bbox.map((x) => num(x, 6, { comma: false })).join(', ');
    const note = $id('suggest-note');
    if (note) {
      note.textContent = `This browser would not keep the run for a reload. The border `
        + `${line} has been copied — press Reset and paste into the border fields on the `
        + 'landing map.';
      // `#suggest-note` is `role="status"` and `tabindex="-1"`, so a keyboard reader
      // lands on the explanation instead of the inert button.
      try { note.focus({ preventScroll: true }); } catch { /* not focusable here */ }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(line).catch(() => { /* the sentence still says the numbers */ });
    }
    return;
  }
  resetToLanding();
}

/**
 * A `SourceRef` as plain JSON: exactly the CONTRACT §(d) fields, `file` always null,
 * `ring` only on an OSM ref.
 * @param {Object} ref @returns {Object}
 */
function portableSourceRef(ref) {
  const out = {
    kind: ref.kind,
    file: null,
    url: ref.kind === 'url' ? String(ref.url) : null,
    id: String(ref.id),
    label: String(ref.label || ''),
    mdbId: ref.mdbId === null || ref.mdbId === undefined ? null : String(ref.mdbId),
  };
  if (ref.kind === 'osm') out.ring = ref.ring;
  return out;
}

/**
 * Read, remove and validate the handoff, in that order: removal is unconditional so
 * a malformed value can never replay on every load.
 *
 * @returns {{sources: Object[], options: Object, source: string, note: Object}|null}
 */
function takeRerunHandoff() {
  let raw = null;
  try {
    raw = sessionStorage.getItem(RERUN_KEY);
    if (raw !== null) sessionStorage.removeItem(RERUN_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return validateRerunHandoff(parsed);
}

/**
 * The handoff's shape, checked with the same rules `readSources` and `readOptions`
 * apply to the form. Any failure rejects the whole handoff.
 *
 * @param {*} h
 * @returns {{sources: Object[], options: Object, source: string, note: Object}|null}
 */
function validateRerunHandoff(h) {
  if (!h || typeof h !== 'object' || h.v !== RERUN_VERSION) return null;
  if (!Array.isArray(h.sources) || !h.sources.length || h.sources.length > MAX_FEEDS_PER_RUN) {
    return null;
  }
  const byId = new Map();
  for (const raw of h.sources) {
    const ref = normaliseRerunSource(raw);
    if (!ref) return null;
    byId.set(ref.id, ref);
  }
  // Sorted by id exactly as `readSources` sorts.
  const sources = Array.from(byId.keys()).sort(cmpStr).map((id) => byId.get(id));
  const options = normaliseRerunOptions(h.options);
  if (!options) return null;
  const note = h.note && typeof h.note === 'object' ? h.note : {};
  const run = Number(note.run);
  return {
    sources,
    options,
    source: sources.map((ref) => ref.label).join(' + '),
    note: {
      prevSize: typeof note.prevSize === 'string' ? note.prevSize : null,
      prevBorderSource: ['landing', 'suggestion'].includes(note.prevBorderSource)
        ? note.prevBorderSource : null,
      run: Number.isInteger(run) && run >= 2 ? run : 2,
    },
  };
}

/**
 * One stored `SourceRef` → a live one, or null. `'file'` and any kind the contract
 * does not list are refused.
 * @param {*} raw @returns {Object|null}
 */
function normaliseRerunSource(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const label = typeof raw.label === 'string' ? raw.label : '';
  const mdbId = raw.mdbId === null || raw.mdbId === undefined ? null : String(raw.mdbId);
  if (raw.kind === 'url') {
    if (typeof raw.url !== 'string') return null;
    let parsed;
    try {
      parsed = new URL(raw.url);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : `url:${raw.url}`;
    return { kind: 'url', file: null, url: raw.url, id, label: label || raw.url, mdbId };
  }
  if (raw.kind === 'osm') {
    const ring = raw.ring;
    if (!Array.isArray(ring) || ring.length < 3) return null;
    for (const v of ring) {
      if (!Array.isArray(v) || v.length !== 2 || !Number.isFinite(v[0]) || !Number.isFinite(v[1])) {
        return null;
      }
    }
    if (typeof raw.id !== 'string' || !raw.id) return null;
    return { kind: 'osm', file: null, url: null, id: raw.id, label, mdbId, ring };
  }
  return null;
}

/**
 * A stored `Options` → a live one over `DEFAULT_OPTIONS`, or null. The rules are
 * `readOptions`'s, field by field. Unknown keys are dropped.
 * @param {*} raw @returns {Object|null}
 */
function normaliseRerunOptions(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const o = { ...DEFAULT_OPTIONS };
  const bool = (key) => {
    if (raw[key] === undefined) return true;
    if (typeof raw[key] !== 'boolean') return false;
    o[key] = raw[key];
    return true;
  };
  const nullable = (key, ok) => {
    const v = raw[key];
    if (v === undefined || v === null) return true;
    if (!ok(v)) return false;
    o[key] = v;
    return true;
  };
  const positive = (v) => Number.isFinite(v) && v > 0;
  if (!bool('offline') || !bool('refresh')) return null;
  if (!nullable('asOf', (v) => typeof v === 'string' && /^\d{8}$/.test(v))) return null;
  if (!nullable('sizeOverride', (v) => ['small', 'medium', 'large'].includes(v))) return null;
  if (!nullable('zoneRadiusM', positive) || !nullable('hidingPeriodMin', positive)) return null;
  if (!nullable('startStopId', (v) => typeof v === 'string' && v.trim() !== '')) return null;
  if (!nullable('borderSource', (v) => ['landing', 'suggestion'].includes(v))) return null;
  if (raw.worldBaseUrl !== undefined && raw.worldBaseUrl !== null) {
    let parsed;
    try {
      parsed = new URL(String(raw.worldBaseUrl));
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    o.worldBaseUrl = String(raw.worldBaseUrl).replace(/\/+$/, '');
  }
  if (raw.borderShape !== undefined) {
    if (!['bbox', 'circle'].includes(raw.borderShape)) return null;
    o.borderShape = raw.borderShape;
  }
  if (raw.borderBbox !== undefined && raw.borderBbox !== null) {
    const b = raw.borderBbox;
    if (!Array.isArray(b) || b.length !== 4 || !b.every((x) => Number.isFinite(x))) return null;
    if (b[0] >= b[2] || b[1] >= b[3]) return null;
    o.borderBbox = /** @type {[number,number,number,number]} */ (b.map((x) => coord(x)));
  }
  for (const key of ['excludeStops', 'excludeRoutes']) {
    if (raw[key] === undefined) continue;
    if (!Array.isArray(raw[key]) || !raw[key].every((x) => typeof x === 'string')) return null;
    o[key] = idList(raw[key].join(','));
  }
  if (raw.departure !== undefined && raw.departure !== null) {
    const d = String(raw.departure);
    const value = d.split(':').length === 2 ? `${d}:00` : d;
    if (!/^\d{1,2}:\d{2}:\d{2}$/.test(value)) return null;
    o.departure = value;
  }
  if (raw.boardSlackS !== undefined && raw.boardSlackS !== null) {
    if (!Number.isFinite(raw.boardSlackS) || raw.boardSlackS < 0) return null;
    o.boardSlackS = raw.boardSlackS;
  }
  return o;
}

/**
 * The `#run-history` chip: what this run is and what the previous one was. Templated
 * from the handoff and mounted once, from `boot()`, for a re-run.
 *
 * @param {{options: Object, note: Object}} handoff
 */
function mountRunHistory(handoff) {
  const host = $id('run-history');
  if (!host) return;
  const b = handoff.options.borderBbox;
  const line = Array.isArray(b) ? b.map((x) => num(x, 6, { comma: false })).join(', ') : '';
  const note = handoff.note || {};
  const from = handoff.options.borderSource === 'suggestion' ? 'from the suggestion'
    : handoff.options.borderSource === 'landing' ? 'from the landing map' : 'inferred';
  const prevBorder = note.prevBorderSource === 'suggestion' ? 'suggested border'
    : note.prevBorderSource === 'landing' ? 'your own border' : 'inferred border';
  // A stored handoff without a `borderBbox` must read "border inferred", not
  // "border  inferred".
  const where = line ? `border ${line} ${from}` : `border ${from}`;
  const text = `Run ${num(note.run || 2)} · ${where} · previous run: `
    + `${prevBorder}${note.prevSize ? `, ${note.prevSize}` : ''}`;
  host.innerHTML = chip(text, 'arrow-rotate-left', { variant: 'brand', title: text });
  host.hidden = false;
}

/** (Re)start the silence timer. Every message from the worker is a sign of life. */
function armWatchdog() {
  clearWatchdog();
  state.watchdog = setTimeout(() => {
    state.watchdog = null;
    fatalError('worker', `The analysis stopped responding — nothing was heard from it `
      + `for ${WORKER_SILENCE_S} seconds. The most likely cause is a map file request `
      + 'that never came back.');
  }, WORKER_SILENCE_S * 1000);
}

function clearWatchdog() {
  if (state.watchdog !== null) {
    clearTimeout(state.watchdog);
    state.watchdog = null;
  }
}

/**
 * The header's Reset: back to the landing stage by way of a fresh document load.
 *
 * Not a teardown: by now `dropSection` and `pruneNav` have deleted shell markup,
 * MapLibre instances are mounted and `mountStrategy` may have inserted a second view,
 * so a load is the only honest reset.
 *
 * The URL sheds its fragment first so a deep link (`#strategy` especially) does not
 * come straight back. `location.replace` rather than `reload()`: a fragment-less URL
 * is always a load, it stays out of session history, and browsers do not restore
 * form state across it. The worker is terminated first so it does not compete with
 * the new page for CPU and the IndexedDB cache.
 */
function resetToLanding() {
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
  const home = new URL(location.href);
  home.hash = '';
  home.search = '';
  location.replace(home.href);
}

/**
 * Set `body[data-state]`, the switch styles.css §7 reads: its `!important`
 * `[data-when='report']` rule hides the report in the landing state, so leaving the
 * attribute at `landing` hides every section for the whole run. The wordmark's anchor
 * rides along, since `#top` is hidden in the landing state.
 */
function setShellState(value) {
  if (document.body) document.body.setAttribute('data-state', value);
  // `data-view` (the secret route) owns the wordmark's anchor while it holds.
  if (document.body && document.body.hasAttribute('data-view')) return;
  const wordmark = document.getElementById('wordmark');
  if (wordmark) wordmark.setAttribute('href', value === 'landing' ? '#landing' : '#top');
}

/** Hide the landing form, reveal the report skeletons, start the progress readout. */
function enterRunningState(src) {
  setShellState('running');
  // Destroy the picker before hiding the card, or its WebGL context and observers
  // are held for the whole run.
  if (state.landing.picker) {
    try { state.landing.picker.destroy(); } catch { /* nothing to do about it */ }
    state.landing.picker = null;
  }
  const landing = document.querySelector('#landing');
  if (landing) landing.hidden = true;
  const report = document.querySelector('main');
  if (report) report.hidden = false;
  // The landing can scroll, and swapping it for the skeletons keeps the offset, so
  // the reader would land partway down with the progress bar out of view. `wa-page`
  // scrolls the document itself. `instant`: this is a new view, not a move within one.
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  const first = (src.sources && src.sources[0]) || null;
  setProgress({
    stage: 'feed',
    label: (src.sources && src.sources.length > 1)
      ? `Reading ${num(src.sources.length)} feeds`
      : (first && first.kind === 'osm'
        ? 'Building the area from OpenStreetMap'
        : (first && first.kind === 'file' ? `Reading ${first.label}` : 'Fetching the feed')),
    done: 0,
    total: 100,
  });
  startHeartbeat();
}

/**
 * Say how long the current step has been running. Page chrome only; nothing it
 * prints reaches the report. Silent for the first 30 s, so a warm run never shows it.
 */
function startHeartbeat() {
  if (state.heartbeat) return;
  state.heartbeat = setInterval(() => {
    if (state.finished || state.fatal) {
      clearInterval(state.heartbeat);
      state.heartbeat = null;
      const out = document.querySelector('[data-role="progresswait"]');
      if (out) out.textContent = '';
      return;
    }
    state.waitedS += 5;
    const out = document.querySelector('[data-role="progresswait"]');
    if (!out) return;
    if (state.waitedS < 30) {
      out.textContent = '';
      return;
    }
    const m = Math.floor(state.waitedS / 60);
    const s = state.waitedS % 60;
    const elapsed = m ? `${m} min ${s}s` : `${s}s`;
    out.textContent = `Still working — ${elapsed} on this step.`;
  }, 5000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Worker protocol
// ═══════════════════════════════════════════════════════════════════════════════

/** @param {{type:string}} msg */
function onWorkerMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'progress':
      setProgress(msg);
      return;
    case 'stage':
      applyStage(msg.stage, msg.payload || {});
      return;
    case 'log':
      // Diagnostics are never report content.
      // eslint-disable-next-line no-console
      (msg.level === 'warn' ? console.warn : console.info)('[worker]', msg.message);
      return;
    case 'degraded':
      recordDegradation(msg.message);
      return;
    case 'error':
      if (msg.fatal) fatalError(msg.stage, msg.message);
      else recordDegradation(`${msg.stage}: ${msg.message}`);
      return;
    case 'done':
      finish(msg.report);
      return;
    default:
      // eslint-disable-next-line no-console
      console.warn('[app] unknown message from worker', msg.type);
  }
}

/**
 * Merge one stage payload into the accumulating report, hydrate whatever that
 * unblocks, and refresh the embedded JSON blocks.
 */
function applyStage(stage, payload) {
  const r = state.report;
  switch (stage) {
    case 'feed':
      r.feed = {
        ...r.feed,
        source: payload.source || '',
        sha256: payload.sha256 || '',
        agencyName: payload.agencyName || '',
        agencyUrl: payload.agencyUrl || '',
        timezone: payload.timezone || '',
        feedStart: payload.feedStart || '',
        feedEnd: payload.feedEnd || '',
        feedVersion: payload.feedVersion || '',
        publisher: payload.publisher || '',
        // One row per input feed, in merge order (CONTRACT.md §(b) `FeedSourceRow`).
        sources: payload.feeds || [],
      };
      r.feedCounts = {
        stops: payload.stops || 0,
        routes: payload.routes || 0,
        trips: payload.trips || 0,
      };
      r.place = payload.place || r.feed.agencyName;
      r.provenance = { ...r.provenance, asOf: payload.asOf || '' };
      break;
    case 'days':
      r.days = payload.days || [];
      r.selectedDay = payload.selectedDay || (r.days[0] && r.days[0].dayType.key) || '';
      break;
    case 'network':
      r.zones = payload.zones || [];
      r.hub = payload.hub || null;
      r.border = payload.border || null;
      r.suggestedBorder = payload.suggestedBorder || null;
      r.size = payload.size || null;
      r.sizeInference = payload.sizeInference || null;
      r.metrics = payload.metrics || {};
      r.routeHeadways = payload.routeHeadways || [];
      r.travelSamples = payload.travelSamples || [];
      // The map's data layers. `routeSpokes` is capped worker-side; `spokeCap` says
      // by how much.
      r.zoneReach = payload.zoneReach || null;
      r.routeSpokes = payload.routeSpokes || [];
      r.spokeCap = payload.spokeCap || null;
      r.stops = payload.stops || [];
      r.proj = payload.proj || r.proj;
      break;
    case 'geo':
      r.geo = payload.geo || emptyGeoLocal();
      break;
    case 'rules':
      r.questions = payload.questions || [];
      r.curses = payload.curses || [];
      r.questionOrder = payload.questionOrder || [];
      r.questionFunnel = payload.questionFunnel || [];
      break;
    case 'score':
      r.fitness = payload.fitness || null;
      r.caps = payload.caps || [];
      r.zoneScores = payload.zoneScores || {};
      r.rankedZoneIds = payload.rankedZoneIds || [];
      r.dossierZoneIds = payload.dossierZoneIds || [];
      r.findings = payload.findings || [];
      r.recommendations = payload.recommendations || [];
      // `scoreZones` fills `surv_mean` in place; this copy is the authoritative one.
      if (payload.questions) r.questions = payload.questions;
      break;
    case 'provenance':
      r.provenance = { ...r.provenance, ...(payload.provenance || {}) };
      for (const d of payload.degradations || []) recordDegradation(d, { quiet: true });
      break;
    default:
      break;
  }
  state.arrived.add(stage);
  hydrate(stage);
  mountChrome();
  // The day selector and the day banner both print a fitness delta, so neither can
  // exist before the score does.
  if (state.arrived.has('score')) mountDayChrome();
  writeDataBlocks();
  renderDegradations();
  injectRuntime();
}

/**
 * The complete `Report` replaces the accumulator; every section is re-rendered
 * through the same comparison, so only changed markup touches the DOM.
 */
function finish(report) {
  if (report && typeof report === 'object') {
    const counts = {
      stops: Object.keys(report.feed && report.feed.stops ? report.feed.stops : {}).length
        || state.report.feedCounts.stops,
      routes: Object.keys(report.feed && report.feed.routes ? report.feed.routes : {}).length
        || state.report.feedCounts.routes,
      trips: state.report.feedCounts.trips,
    };
    // `null` in the `done` report never wins over something a stage already
    // delivered: a degraded worker can send a null field its stage filled, and taking
    // that literally would delete a correct section. The merge only adds.
    const merged = { ...state.report };
    for (const key of Object.keys(report)) {
      const value = report[key];
      if (value === null || value === undefined) continue;
      merged[key] = value;
    }
    state.report = {
      ...merged,
      feedCounts: counts,
      // The worker's `Report` has no home for these two; they arrive on their stages.
      caps: report.caps || state.report.caps,
      stops: report.stops || state.report.stops,
    };
    for (const d of report.degradations || []) recordDegradation(d, { quiet: true });
  }
  state.finished = true;
  state.running = false;
  for (const stage of ['feed', 'days', 'network', 'geo', 'rules', 'score', 'provenance']) {
    state.arrived.add(stage);
  }
  hydrate('done');
  // Nothing will fill these now; a hidden husk is still a nav link that goes nowhere.
  for (const husk of [...document.querySelectorAll('[data-state="empty"]')]) {
    dropSectionHost(husk, husk.getAttribute('data-section'));
  }
  renumberSections();
  pruneNav();
  writeDataBlocks();
  renderDegradations();
  mountChrome();
  mountDayChrome();
  injectRuntime();
  // `ready` retires the header progress block; it must be set even if a section
  // threw, or the page is stuck behind the running-state chrome.
  setShellState('ready');
  setProgress({ stage: 'done', label: 'Report complete', done: 1, total: 1 });
  clearWatchdog();
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
  // Last: a page loaded at `#strategy` enters the guide the moment the run completes.
  applyRoute();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Progress
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Drive the header bar. `total` grows as work is discovered (CONTRACT §(d)), so the
 * displayed percentage is clamped monotonically.
 */
function setProgress(msg) {
  state.waitedS = 0;
  const waited = document.querySelector('[data-role="progresswait"]');
  if (waited) waited.textContent = '';
  const done = Number(msg.done) || 0;
  const total = Number(msg.total) || 0;
  const raw = total > 0 ? Math.min(100, (done / total) * 100) : state.progress.pct;
  const value = Math.max(state.progress.pct, raw);
  state.progress = {
    pct: value,
    stage: msg.stage || state.progress.stage,
    label: msg.label || state.progress.label,
  };

  const bar = document.querySelector('[data-role="progressbar"]');
  if (bar) {
    bar.value = rhu(value, 1);
    bar.setAttribute('value', String(rhu(value, 1)));
  }
  const label = document.querySelector('[data-role="progresslabel"]');
  if (label) label.textContent = state.progress.label || '';

  const root = state.progress.stage.split(':')[0];
  const note = document.querySelector('[data-role="progressnote"]');
  if (note) note.textContent = STAGE_NOTE[root] || '';
  const host = document.querySelector('[data-role="progress"]');
  if (host) host.setAttribute('data-stage', root);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Hydration
// ═══════════════════════════════════════════════════════════════════════════════

/** Every section this stage either fills for the first time or corrects. */
function sectionsFor(stage) {
  if (stage === 'done') return SECTIONS.filter((s) => state.arrived.has(s.needs));
  return SECTIONS.filter((s) => s.needs === stage
    || (s.redo.includes(stage) && state.arrived.has(s.needs)));
}

/**
 * Render every section this stage unblocks and swap it into the page. A renderer
 * that throws takes only its own section down.
 */
function hydrate(stage) {
  let changed = false;
  for (const def of sectionsFor(stage)) {
    if (state.dropped.has(def.id)) continue;
    let html = '';
    try {
      html = def.render(state.report) || '';
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[app] ${def.id} renderer failed`, err);
      recordDegradation(`The ${SECTION_NAME[def.id] || def.id} section could not be rendered (${err && err.message}).`);
      continue;
    }
    if (state.rendered.get(def.id) === html) continue;
    state.rendered.set(def.id, html);
    changed = true;
    if (!html) {
      // pages.md §5's "no empty cards": the section goes, and so does its nav entry.
      dropSection(def);
      continue;
    }
    mountSection(def.id, html);
  }
  if (changed) {
    renumberSections();
    pruneNav();
  }
}

/** The live element for a section id, whatever wrapper the shell chose. */
function sectionHost(id) {
  return document.querySelector(`[data-section="${id}"]`) || $id(id);
}

/**
 * Take a section host off the page, and its nav link with it. A host with no
 * `data-section` is removed and nothing else, so sweeps are safe over anything.
 */
function dropSectionHost(host, id) {
  if (host) host.remove();
  if (!id) return;
  state.dropped.add(id);
  for (const a of document.querySelectorAll(`nav[slot="navigation"] a[href="#${id}"]`)) a.remove();
}

/**
 * Evict the cached markup of every section host nested inside this one (§05's
 * `#glance`): a replaced host takes its children with it, and a cached nested
 * section would otherwise be skipped as "unchanged" and never come back.
 */
function evictNested(host, id) {
  if (!host.querySelectorAll) return;
  for (const nested of host.querySelectorAll('[data-section]')) {
    const nid = nested.getAttribute('data-section');
    if (nid && nid !== id) state.rendered.delete(nid);
  }
}

/**
 * Replace a skeleton with real markup without janking (large tables go in across
 * frames), losing the reader's place (scroll is corrected by the height delta) or
 * flashing (the swap fades unless motion is reduced).
 */
function mountSection(id, html) {
  const host = sectionHost(id);
  if (!host) return;
  const fragment = parseHtml(html);
  if (!fragment.firstElementChild) return;
  /** @type {Element} */
  let root;
  if (fragment.children.length === 1) {
    root = fragment.firstElementChild;
  } else {
    // A renderer that joined several top-level blocks keeps all of them.
    root = document.createElement('div');
    root.className = 'wa-stack wa-gap-l';
    root.appendChild(fragment);
  }
  root.setAttribute('data-section', id);
  root.setAttribute('data-state', 'ready');

  const rect = host.getBoundingClientRect();
  const before = rect.height;
  const above = rect.bottom < 0;

  // Big tables go in in pieces.
  const heavy = [...root.querySelectorAll('tbody')].filter((b) => b.rows.length > 200);
  const parked = heavy.map((body) => {
    const rows = [...body.rows];
    for (const row of rows) row.remove();
    return { body, rows };
  });

  // The map is built once, guarded by `window.__jltg.mapBuilt`. When a re-render of
  // §05 swaps `#netmap` out, the flag must be cleared or the new one is never built.
  // Only the km→mi flip at `geo` rewrites §05's string; the rail's host never
  // contains `#netmap`.
  const hadMap = host.querySelector && host.querySelector('#netmap');
  if (hadMap && root.querySelector && root.querySelector('#netmap')) {
    const runtime = window.__jltg;
    if (runtime) {
      runtime.mapBuilt = 0;
      // Clearing these makes `refreshMapData()` a no-op until the rebuilt map
      // republishes them.
      runtime.map = null;
      runtime.mapReady = 0;
      runtime.paintMap = null;
      runtime.refreshMapData = null;
      runtime.highlight = null;
      runtime.highlightPinned = null;
    }
  }

  // The markup about to be replaced takes its nested hosts down with it.
  evictNested(host, id);

  host.replaceWith(root);

  if (parked.length) fillChunked(parked);

  const after = root.getBoundingClientRect().height;
  if (above && Math.abs(after - before) > 1) {
    // The reader is below this section; keep their line of text under their eyes.
    window.scrollBy(0, after - before);
  }
  if (!reducedMotion() && typeof root.animate === 'function') {
    root.animate(
      [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
      { duration: 220, easing: 'ease-out' },
    );
  }

  // `deck.js` owns §07/§08's sortable headers, page size and filter state and must
  // be handed the fresh nodes. Idempotent, and never dispatches `refilter`. Both
  // arguments matter: the payload is what its re-wire observer replays later.
  if (id === 'questions' || id === 'curses') {
    try { initDeckTables(root, state.report); } catch (err) { console.warn('[app] deck tables', err); }
  }
}

/**
 * Re-attach parked table rows a frame at a time, with a time budget, so a long table
 * never blocks scrolling. Rows land in document order; nothing is reordered.
 */
async function fillChunked(parked) {
  for (const { body, rows } of parked) {
    let i = 0;
    while (i < rows.length) {
      const start = performance.now();
      const chunk = document.createDocumentFragment();
      while (i < rows.length && performance.now() - start < 6) {
        chunk.appendChild(rows[i]);
        i += 1;
      }
      body.appendChild(chunk);
      // eslint-disable-next-line no-await-in-loop
      await nextFrame();
    }
  }
}

/**
 * A section that rendered nothing disappears, and its nav entry goes with it.
 *
 * The CLI can make that call once, holding the whole report. Here the call is only
 * safe when no later stage could still fill the section — the map's stat rail renders
 * empty until the geo layer decides what units to print in — so an early empty result
 * merely hides the card, and only a stage with nothing left to wait for removes it
 * for good. A nested host (`glance`) is hidden and removed by exactly this path, and
 * its rail link goes with it.
 */
function dropSection(def) {
  const host = sectionHost(def.id);
  const pending = def.redo.some((s) => !state.arrived.has(s));
  if (pending) {
    if (host) {
      host.setAttribute('data-state', 'empty');
      host.hidden = true;
      // Blanking the host destroys any nested host inside it.
      evictNested(host, def.id);
      host.innerHTML = '';
    }
    return;
  }
  dropSectionHost(host, def.id);
}

/**
 * Assign `data-n` in page order, after the drops. `section()` is the only thing that
 * emits `data-n`, so this can only ever hit the right attribute.
 */
function renumberSections() {
  // The count walks every section still on the page, hydrated or not: a skeleton is
  // going to be numbered eventually, so counting it now keeps §07 reading "07" from
  // the moment it lands instead of climbing as its neighbours arrive. Only a section
  // that rendered nothing — and was therefore removed outright — shifts the sequence.
  let n = 0;
  for (const id of NUMBERED) {
    const host = sectionHost(id);
    if (!host || host.getAttribute('data-state') === 'empty') continue;
    n += 1;
    const heading = host.querySelector('[data-n]');
    if (heading) heading.setAttribute('data-n', String(n).padStart(2, '0'));
  }
  // Anything still holding the placeholder is not one of the eight numbered cards.
  // Blank beats printing '--' at a reader.
  for (const node of document.querySelectorAll(`[data-n="${ORDINAL_PLACEHOLDER}"]`)) {
    node.removeAttribute('data-n');
  }
}

/**
 * Drop rail links whose target no longer exists.
 *
 * §03 is a container: the rail addresses `#recs` and `#findings` directly, and either
 * half can be absent. A link to a heading that was never rendered is a link that does
 * nothing, so it goes — and `document()`'s rule that an empty group emits no heading
 * is enforced here too.
 */
function pruneNav() {
  const nav = document.querySelector('nav[slot="navigation"]');
  if (!nav) return;
  for (const a of [...nav.querySelectorAll('a[href^="#"]')]) {
    const id = decodeURIComponent(a.getAttribute('href').slice(1));
    if (!id) continue;
    const owner = SECTIONS.find((s) => s.id === id);
    // Only judge a link once the section that would contain its target has landed
    // *and* every stage that could still change it has been and gone.
    // A fatal error settles everything: no further stage is coming, so a link whose
    // target never arrived is a dead link now and not merely a pending one.
    const settled = state.fatal || (owner
      ? state.arrived.has(owner.needs) && owner.redo.every((s) => state.arrived.has(s))
      : state.arrived.has('score') || state.finished);
    if (!settled) continue;
    if (!document.getElementById(id)) a.remove();
  }
  for (const group of [...nav.children]) {
    if (!group.querySelector('a[href^="#"]')) group.remove();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Degradations and errors
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Every `degraded` message and every non-fatal `error` lands here, and every one of
 * them reaches the page. Nothing is swallowed.
 */
function recordDegradation(message, opts = {}) {
  const text = String(message || '').trim();
  if (!text || state.degradations.includes(text)) return;
  state.degradations.push(text);
  if (!state.report.degradations.includes(text)) state.report.degradations.push(text);
  if (!opts.quiet) renderDegradations();
}

/**
 * `_s4_degradation_callout`, rendered live as a toast.
 *
 * Says what is missing — and only when something actually is: an empty warning is
 * worse than none.
 *
 * `duration="0"` is not optional. `wa-toast-item`'s own accessibility notes are blunt
 * that a transient notice gets missed by magnifier users and is awkward to reach by
 * keyboard, so this one never auto-dismisses; it waits for the close button. The
 * standing record is §09 Sources ("What this data does not know", deck.js 1359) plus
 * the #provenance block, both fed from the same `report.degradations` — so a reader
 * who closes this, or never sees it, has lost nothing.
 *
 * Re-rendering must not resurrect a notice the reader has already closed, and must not
 * re-pop one they are still reading. So: same lines as when they dismissed → stay
 * closed; item still open → rewrite it in place; genuinely new lines → a fresh toast.
 */
function renderDegradations() {
  const host = degradationHost();
  if (!host) return;
  const lines = [...state.degradations];
  const geoLanded = state.arrived.has('geo');
  if (geoLanded && !state.report.geo.available
      && !lines.some((x) => x.includes('OpenStreetMap') || x.toLowerCase().includes('osm'))) {
    lines.unshift('OpenStreetMap is unavailable, so every question, curse and score that '
      + 'needs map features is excluded rather than guessed at.');
  }
  const open = host.querySelector('wa-toast-item');
  if (!lines.length) {
    if (open) open.hide();
    return;
  }
  const signature = lines.join('\u0000');
  if (!open && signature === state.degradationsDismissed) return;

  const body = join(
    el('p', esc(lines.length === 1
      ? 'Part of this report is missing:'
      : 'Parts of this report are missing:'), { className: 'wa-body-s' }),
    el('ul', lines.map((x) => el('li', esc(x))).join(''), { className: 'wa-stack wa-gap-2xs' }),
  );

  if (open) {
    // Already on screen and still unread: swap the contents, do not re-animate.
    open.innerHTML = body;
    open.dataset.signature = signature;
    return;
  }
  const item = document.createElement('wa-toast-item');
  item.setAttribute('variant', 'warning');
  // Never auto-dismiss. `duration > 0` is what starts the countdown and draws the
  // progress ring (toast-item, `startTimer`/`render`); 0 does neither.
  item.setAttribute('duration', '0');
  item.innerHTML = body;
  item.dataset.signature = signature;
  // `hide()` removes the item from the DOM, so this string is the only memory of what
  // was dismissed. Read it off the element, not this closure: the list can grow while
  // the toast is open, and dismissing must record what was actually on screen.
  item.addEventListener('wa-after-hide', () => {
    state.degradationsDismissed = item.dataset.signature || '';
  });
  host.appendChild(item);
}

/**
 * The `<wa-toast>` stack (index.html, just after `</wa-page>`), created if absent.
 *
 * It is deliberately outside `wa-page`: `wa-toast` positions itself against the
 * viewport, and the component expects one stack per page.
 */
function degradationHost() {
  let host = document.querySelector('#degradations');
  if (host) return host;
  host = document.createElement('wa-toast');
  host.id = 'degradations';
  host.setAttribute('placement', 'bottom-start');
  document.body.appendChild(host);
  return host;
}

/**
 * A fatal error means there is no report at all — the source could not be fetched,
 * the zip could not be opened, or the feed has no `stops.txt`. The page says which
 * stage failed and stops pretending.
 */
function fatalError(stage, message) {
  if (state.fatal) return;
  state.fatal = true;
  state.running = false;
  clearWatchdog();
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
  // Not `landing`: that would put the pick-a-feed card back under the error and hide
  // the error's own container. `failed` shows the report region and hides the run
  // chrome, which is exactly what is wanted.
  setShellState('failed');
  // The stack goes on an inner wrapper, not the card host: the host's own flex items
  // are wa-card's shadow header/body/footer, so a gap there opens a seam under the
  // header instead of spacing these two paragraphs.
  const card = waCard(el('div', join(
    el('p', esc(String(message || 'The run stopped and did not say why.')), { className: 'wa-body-m' }),
    el('p', esc('Reload and try another feed, or the same one again. The commonest causes '
      + 'are a link that is not a GTFS zip and a feed that is missing stop_times.txt.'),
    { className: 'wa-body-s wa-color-text-quiet' }),
  ), { className: 'wa-stack wa-gap-m' }), {
    headerHtml: el('h2', join(waIcon('triangle-exclamation'),
      esc(STAGE_DOING[stage] ? `Stopped while ${STAGE_DOING[stage]}` : 'The analysis stopped')),
      { className: 'wa-heading-l wa-cluster wa-gap-xs wa-align-items-center' }),
  });
  const slot = document.querySelector('#run-error');
  if (slot) {
    // The shell has a place for this. Use it, and clear away the skeletons that are
    // never going to fill — a stopped run must not leave eight shimmering cards
    // implying work is still happening.
    slot.innerHTML = el('div', card, { className: 'wa-stack wa-gap-l' });
    slot.hidden = false;
    for (const husk of [...document.querySelectorAll('[data-state="skeleton"]')]) {
      dropSectionHost(husk, husk.getAttribute('data-section'));
    }
    // The hero and the footer are `data-state="pending"` so that sweep cannot take
    // them: the hero carries `#top`, which the wordmark and the footer's "Back to
    // top" both point at, and the footer carries the OpenStreetMap/ODbL and rulebook
    // attribution, which is true of every run including this failed one. They still
    // must not shimmer — settle them in place instead of removing them.
    for (const host of [...document.querySelectorAll('[data-state="pending"]')]) {
      for (const sk of [...host.querySelectorAll('wa-skeleton')]) sk.remove();
      host.removeAttribute('aria-busy');
    }
    pruneNav();
  }
  const landing = document.querySelector('#landing');
  if (landing) landing.hidden = true;
  setProgress({ stage, label: `Stopped during ${stage}`, done: 0, total: 0 });
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · per-day views
// ═══════════════════════════════════════════════════════════════════════════════

/** The day strip: four figures, one sentence, one fitness delta. (`_s4_banner`.) */
function dayBanner(report, dayKey) {
  const v = dayView(report, dayKey);
  const label = dayLabel(report, dayKey);
  const day = dayByKey(report, dayKey);
  const size = report.size || { hidingPeriodMin: 0 };
  const perDay = (report.fitness && report.fitness.perDay) || {};
  const best = bestDay(report);
  const score = dayKey in perDay ? perDay[dayKey] : null;
  const bestScore = best in perDay ? perDay[best] : null;
  const delta = (score === null || bestScore === null) ? null : score - bestScore;

  const headway = v.medianHeadwayMin;
  const midday = v.middayHeadwayP25P50P75;
  let cadence;
  let cadenceNote;
  if (Array.isArray(midday) && midday.length === 3 && midday[0] !== null && midday[0] !== undefined) {
    cadence = `${num(midday[0])}–${num(midday[2])} min`;
    cadenceNote = 'midday quartiles';
  } else if (headway !== null && headway !== undefined) {
    cadence = mins(headway);
    cadenceNote = 'median per stop';
  } else {
    cadence = '—';
    cadenceNote = 'no service';
  }

  const nDates = day ? day.dayType.dates.length : 0;
  const asOf = String(v.date || (report.provenance && report.provenance.asOf) || '20000101');
  let note = `${num(v.trips || 0)} trips across ${num(v.servedStops || 0)} stops, `
    + `${num(v.nZones || 0)} hiding zones, and `
    + `${pct(Number(v.reachableZoneShare || 0))} of them reachable inside the `
    + `${num(size.hidingPeriodMin)}-minute hiding period. `
    + `The median stop's last departure is ${hhmm(Math.trunc(v.medianLastDepartureS || 0))}. `
    + `${num(nDates)} ${nDates === 1 ? 'date' : 'dates'} in this feed run this pattern; `
    + `${prettyDate(asOf)} is the one every number on this page is measured on.`;
  if (delta !== null && delta < -0.05) {
    note += ` Map fitness on this day is ${num(score, 1)}, ${signed(delta)} against `
      + `${dayLabel(report, best)}.`;
  }

  let variant;
  if (delta === null || delta >= -2.0) variant = 'success';
  else if (delta >= -10.0) variant = 'warning';
  else variant = 'danger';

  const nRoutes = report.feedCounts.routes
    || Object.keys((report.feed && report.feed.routes) || {}).length;

  return {
    key: dayKey,
    label,
    variant,
    routes: `${num(v.routes || 0)} of ${num(nRoutes)}`,
    cadence,
    cadenceNote,
    span: `${hhmm(Math.trunc(v.firstDepartureS || 0))}–${hhmm(Math.trunc(v.lastDepartureS || 0))}`,
    note,
    score: score === null ? null : num(score, 1),
    delta: delta === null ? null : signed(delta),
  };
}

/**
 * The day strip's inner markup. `wa-callout`'s variant is set by the page script,
 * because the element itself is rendered once and reused.
 *
 * The day's heading leads, the four figures read across, and the 55-word paragraph —
 * which was in the way of everything under it — is one tap down. Nothing is dropped:
 * the cadence's "midday quartiles" qualifier moves into that paragraph as words, and
 * the paragraph itself is verbatim.
 *
 * Takes the banner both callers already hold, rather than the `(report, dayKey)` pair
 * that would build a second one.
 */
function dayBannerHtml(b) {
  const figures = [['Routes running', b.routes], ['How often', b.cadence], ['Service window', b.span]];
  if (b.score !== null) {
    figures.push(['Map fitness today',
      b.score + (b.delta && b.delta !== '0.0' ? ` · ${b.delta}` : '')]);
  }
  const note = `How often: ${b.cadence}, ${b.cadenceNote}. ${b.note}`;
  return join(
    el('div', join(
      el('p', join(waIcon('calendar-day'), esc(`${b.label} service`)),
        { className: 'wa-heading-xs wa-cluster wa-gap-2xs wa-align-items-center' }),
      el('div', figures.map(([caption, value]) => el('div', join(
        el('span', esc(value), { className: 'wa-heading-s' }),
        el('span', esc(caption), { className: 'wa-caption-xs wa-text-uppercase wa-color-text-quiet' }),
      ), { className: 'wa-stack wa-gap-3xs' })).join(''), { className: 'wa-cluster wa-gap-l' }),
    ), { className: 'wa-split wa-align-items-center wa-flex-wrap wa-gap-m' }),
    waDetails('What that means on the ground',
      el('p', esc(note), { className: 'wa-body-s wa-color-text-quiet' }),
      { appearance: 'plain' }),
  );
}

/**
 * The ride-time chart's rows for one day, sorted by travel time (no-service last).
 *
 * The colour rule is stated in the card's caption verbatim, because a bar colour a
 * reader cannot reconstruct is decoration rather than information.
 */
function travelRows(report, dayKey) {
  const hp = Number((report.size && report.size.hidingPeriodMin) || 0);
  const label = dayLabel(report, dayKey);
  const rows = [];
  for (const s of report.travelSamples || []) {
    const per = ((s.perDay || {})[dayKey]) || {};
    const rawMinutes = per.minutes;
    const transfers = per.transfers;
    const routes = (per.routes || []).map((x) => String(x));
    const name = String(s.name || s.stopId || '');
    const short = name.length <= 36 ? name : `${name.slice(0, 35)}…`;
    if (rawMinutes === null || rawMinutes === undefined) {
      rows.push({
        name, label: short, minutes: 0.0, avail: false, tone: 'none',
        note: `no service on a ${label}`,
        tip: el('b', esc(name)) + esc(`No service on a ${label}.`),
      });
      continue;
    }
    const minutes = Number(rawMinutes);
    let tone;
    let verdict;
    if (minutes > hp) {
      tone = 'bust';
      verdict = `busts the ${num(hp)}-minute hiding period`;
    } else if (minutes > 0.75 * hp || (transfers || 0) >= 2) {
      tone = 'tight';
      verdict = 'fits, but with no slack or two changes';
    } else {
      tone = 'fits';
      verdict = 'fits the hiding period comfortably';
    }
    const leg = joinWords(routes.map((r) => `route ${r}`)) || 'walking';
    const tip = el('b', esc(name)) + esc(
      `${mins(minutes, 1)} from the start location on ${leg}, `
      + `${num(transfers || 0)} ${(transfers || 0) === 1 ? 'change' : 'changes'} — ${verdict}.`,
    );
    rows.push({
      name, label: short, minutes: rhu(minutes, 1), avail: true, tone, note: '', tip,
    });
  }
  rows.sort((a, b) => {
    if (a.avail !== b.avail) return a.avail ? -1 : 1;
    if (a.minutes !== b.minutes) return a.minutes - b.minutes;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return rows;
}

/**
 * Deterministic x-axis maximum for the ride-time chart: the larger of 1.25 × the
 * hiding period and the p90 of every sampled time, rounded up to a multiple of 15.
 * The hiding-period line always fits and one outlier cannot squash the other bars.
 */
function chartMax(report) {
  const values = [];
  for (const s of report.travelSamples || []) {
    const per = s.perDay || {};
    for (const key of Object.keys(per).sort(cmpStr)) {
      const p = per[key];
      if (p && p.minutes !== null && p.minutes !== undefined) values.push(Number(p.minutes));
    }
  }
  const floorV = Number((report.size && report.size.hidingPeriodMin) || 0) * 1.25;
  const top = Math.max(floorV, values.length ? quantile(values, 0.90) : 0.0);
  return Math.max(15, Math.ceil(top / 15.0) * 15);
}

/** The stat rail's tile grid for one day, from the same function the rail renders through. */
function tilesHtmlFor(report, dayKey) {
  try {
    return s4TilesHtml(report, dayKey) || '';
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[app] tiles render failed', err);
    return '';
  }
}

/**
 * The map's "what to notice" caption for one day. The renderer owns the sentences;
 * shipping the string per day makes a day switch an innerHTML swap on `#netcaption`.
 */
function mapCaptionFor(report, dayKey) {
  try {
    return s4MapCaption(report, dayKey) || '';
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[app] map caption render failed', err);
    return '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · the embedded JSON blocks
// ═══════════════════════════════════════════════════════════════════════════════
//
// One block per concern, so a page that only wants the verdict never parses the stop
// list. The map and the day switcher read them from the live DOM.

/** Above this the map draws zone centres only. (`_S4_MAX_MAP_STOPS`.) */
const MAX_MAP_STOPS = 5000;
/** Above this the zone circles become dots only. (`_S4_MAX_MAP_ZONE_RINGS`.) */
const MAX_MAP_ZONE_RINGS = 1200;
// The spoke cap, `MAX_MAP_SPOKES`, lives in lib/core.js: it is applied worker-side
// so the bytes never cross `postMessage`. `#stops.spoke_cap` reports what it did.

/**
 * The scalar metrics the page prints, flattened for `#data`. Not the whole `metrics`
 * dict: its per-day id lists and hull rings would triple the page weight unread.
 * `mec` is the one non-scalar, `[lat, lon, radiusM]`, drawn when the *Network
 * diameter* tile is highlighted.
 */
const CURATED_METRIC_KEYS = [
  'servedStops', 'stopsInFeed', 'stations', 'nZones', 'nZonesHalfMile',
  'routes', 'trips', 'stopEvents', 'diameterM', 'hullSqM', 'bboxSqM',
  'spanHours', 'firstDepartureS', 'lastDepartureS', 'medianHeadwayMin',
  'medianWorstGapMin', 'medianLastDepartureS', 'frequentShare', 'frequentStops',
  'share30min', 'multiRouteStopShare', 'transferStops2plus', 'transferStops3plus',
  'routesPerStopMax', 'hubDominance', 'hubTripShare', 'networkShape', 'mec',
  'isolatedZoneShare', 't90Min', 'hubTravelP50Min', 'hubTravelP95Min',
  'reachableZoneShare', 'reachWithinHidingPeriod', 'eveningZoneShare',
  'weekendRatio', 'satTripRatio', 'sunTripRatio', 'fullServiceDateShare',
  'routeKmOneDir', 'stopDensityPerSqMi', 'zoneDensityPerSqMi',
  'distinctBaseNames', 'bestDay', 'impliedSize',
];

function curatedMetrics(report) {
  const v = dayView(report, bestDay(report));
  const out = {};
  for (const k of CURATED_METRIC_KEYS) {
    if (k in v && v[k] !== null && v[k] !== undefined) {
      const value = v[k];
      out[k] = (typeof value === 'number' && !Number.isInteger(value)) ? rhu(value, 4) : value;
    }
  }
  return out;
}

/** `#data` — everything the page shares, plus the pre-rendered day markup. */
function dataPayload(report) {
  const f = report.fitness;
  const days = {};
  // The per-day markup is not true until the score lands (the banner prints a fitness
  // delta), so before then the block ships `days: {}` and `renderDay()` returns early.
  for (const key of state.arrived.has('score') ? dayOrder(report) : []) {
    const b = dayBanner(report, key);
    days[key] = {
      key,
      label: b.label,
      variant: b.variant,
      banner_html: dayBannerHtml(b),
      tiles_html: tilesHtmlFor(report, key),
      map_caption_html: mapCaptionFor(report, key),
      score: b.score,
      travel: travelRows(report, key).map((r) => ({
        label: r.label, minutes: rhu(r.minutes, 1), avail: r.avail,
        tone: r.tone, note: r.note, tip: r.tip,
      })),
    };
  }
  const border = report.border;
  const hub = report.hub;
  const size = report.size;
  const inference = report.sizeInference;
  return {
    place: report.place,
    agency: {
      name: report.feed.agencyName, url: report.feed.agencyUrl, timezone: report.feed.timezone,
    },
    game: size ? {
      size: size.name,
      hiding_period_min: size.hidingPeriodMin,
      zone_radius_m: rhu(size.zoneRadiusM, 1),
      catalogue_size: size.catalogueSize,
      tentacle_reach_mi: size.tentacleReachMi,
      photo_limit_min: size.photoLimitMin,
      other_limit_min: size.otherLimitMin,
      inferred: size.inferred,
      chart_max_min: chartMax(report),
      scale_unit: imperial(report) ? 'imperial' : 'metric',
      // The same thresholds §06's headway grid bins on. `Infinity` is not JSON, so
      // the open-ended last bin ships as `null`.
      headway_bins_min: S4_HEADWAY_BINS.map(
        ([limit]) => (Number.isFinite(limit) ? limit : null),
      ),
    } : null,
    border: border ? {
      kind: border.kind,
      bbox: border.bbox.map((x) => coord(x)),
      circle: [coord(border.circle[0]), coord(border.circle[1]), rhu(border.circle[2], 1)],
      pad_m: rhu(border.padM, 1),
      area_sq_m: rhu(border.areaSqM, 1),
      geojson: border.geojson,
    } : null,
    hub: hub ? {
      stop_id: hub.stopId, name: hub.name, lat: coord(hub.lat), lon: coord(hub.lon),
      shape: hub.shape, dominant: hub.dominant, route_share: rhu(hub.routeShare, 4),
    } : null,
    // The runtime's `border-suggested-line` reads `.bbox` only; null draws no line.
    suggestedBorder: suggestedBorderPayload(report.suggestedBorder),
    fitness: f ? {
      score: f.score === null ? null : rhu(f.score, 1),
      raw_score: rhu(f.rawScore, 1),
      capped_by: f.cappedBy,
      band: f.band,
      available_points: rhu(f.availablePoints, 1),
      per_day: sortedMap(f.perDay || {}, (v) => rhu(v, 1)),
      subscores: (f.subscores || []).map((s) => ({
        id: s.id, name: s.name,
        earned: rhu(s.earnedTenths / 10.0, 1),
        max: rhu(s.maxTenths / 10.0, 1),
        partial: s.partial,
        missing: [...s.missing],
      })),
    } : null,
    size_inference: inference ? {
      verdict: inference.verdict,
      votes: [...inference.votes],
      unanimous: inference.unanimous,
      clamped: inference.clamped,
      note: inference.note,
      axes: inference.axes.map((a) => ({ ...a })),
    } : null,
    metrics: curatedMetrics(report),
    route_headways: (report.routeHeadways || []).map((h) => ({
      route_id: h.routeId, short_name: h.shortName, long_name: h.longName,
      direction_id: h.directionId,
      per_day: sortedMap(h.perDay || {}, (v) => (v === null || v === undefined ? null : rhu(Number(v), 1))),
      trips: sortedMap(h.trips || {}, (v) => v),
    })),
    findings: (report.findings || []).map((x) => sortedObject(x)),
    recommendations: (report.recommendations || []).map((x) => sortedObject(x)),
    day_keys: dayOrder(report),
    selected_day: bestDay(report),
    days,
    degradations: [...state.degradations],
  };
}

/** A plain object rebuilt in sorted key order. */
function sortedObject(obj) {
  const out = {};
  for (const k of Object.keys(obj || {}).sort(cmpStr)) out[k] = obj[k];
  return out;
}

/** The same, with a value transform. */
function sortedMap(obj, fn) {
  const out = {};
  for (const k of Object.keys(obj || {}).sort(cmpStr)) out[k] = fn(obj[k]);
  return out;
}

function questionsPayload(report) {
  const rows = [...(report.questions || [])].sort((a, b) => {
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }).map((q) => ({
    id: q.id, category: q.category, label: q.label, text: q.text,
    status: q.status, quality: rhu(q.quality, 4),
    instances: q.instances,
    coverage: q.coverage === null || q.coverage === undefined ? null : rhu(q.coverage, 4),
    selector: q.selector, why: q.why,
    surv_mean: q.survMean === null || q.survMean === undefined ? null : rhu(q.survMean, 4),
    borderline: q.borderline,
    // `draw` / `keep` are the card price from the catalogue, copied onto every audit row.
    draw: q.draw === undefined ? null : q.draw,
    keep: q.keep === undefined ? null : q.keep,
  }));
  return {
    questions: rows,
    question_order: [...(report.questionOrder || [])],
    question_funnel: [...(report.questionFunnel || [])],
  };
}

function cursesPayload(report) {
  return {
    curses: (report.curses || []).map((c) => ({
      id: c.id, name: c.name, tier: c.tier, action: c.action,
      predicate: c.predicate, count: c.count, why: c.why,
    })),
  };
}

/**
 * `DATA.suggestedBorder`, or null. Guards the shape: a missing bbox must degrade to
 * "no line", not to an exception in `buildMap`.
 * @param {Object|null} sb a `SuggestedBorder`
 * @returns {Object|null}
 */
function suggestedBorderPayload(sb) {
  if (!sb || typeof sb !== 'object') return null;
  const b = sb.bbox;
  if (!Array.isArray(b) || b.length !== 4 || !b.every((x) => Number.isFinite(x))) return null;
  const raw = Array.isArray(sb.rawBbox) && sb.rawBbox.length === 4 ? sb.rawBbox : b;
  return {
    kind: 'bbox',
    bbox: b.map((x) => coord(x)),
    raw_bbox: raw.map((x) => coord(x)),
    pad_m: rhu(Number(sb.padM || 0), 1),
    area_sq_m: rhu(Number(sb.areaSqM || 0), 1),
    size: sb.sizeName || null,
    core_stops: sb.coreStops || 0,
    trimmed_stops: sb.trimmedStops || 0,
  };
}

/**
 * `#stops` — `[lon, lat, name, route_count, frequent]` tuples plus the zone centres,
 * the per-day reach and headway columns, and the route spokes. Tuples, not objects,
 * for the byte count on a 20,000-stop feed.
 *
 * `reach` and `hw` are parallel arrays, index-aligned with `zones` and `stops`.
 * `reach[dayKey][i]` is minutes from the round-start station to `zones[i]` (`null` =
 * no journey); `hw[dayKey][i]` is `stops[i]`'s median headway over 06:00–22:00
 * (`null` = no service). Over `MAX_MAP_STOPS` the stop tuples and `hw` are dropped.
 */
function stopsPayload(report) {
  const rows = report.stops || [];
  const withinCap = rows.length <= MAX_MAP_STOPS;
  const stops = withinCap
    ? rows.map((s) => [coord(s.lon), coord(s.lat), s.name, (s.routeIds || []).length,
      s.frequent ? 1 : 0])
    : [];
  const scores = report.zoneScores || {};
  const zoneRows = [...(report.zones || [])]
    .sort((a, b) => (a.zoneId < b.zoneId ? -1 : a.zoneId > b.zoneId ? 1 : 0));
  const zones = zoneRows.map((z) => [coord(z.lon), coord(z.lat), z.name,
    z.zoneId in scores ? rhu(scores[z.zoneId].overallTenths / 10.0, 1) : null]);

  const keys = dayOrder(report);
  const reach = {};
  const perDay = ((report.zoneReach || {}).perDay) || {};
  for (const key of keys) {
    const cell = perDay[key];
    if (!cell) continue;
    const minutes = cell.minutes || {};
    reach[key] = zoneRows.map((z) => {
      const value = minutes[z.zoneId];
      return (value === null || value === undefined) ? null : value;
    });
  }
  const hw = {};
  if (withinCap) {
    for (const key of keys) {
      hw[key] = rows.map((s) => {
        const value = (s.headwayByDay || {})[key];
        return (value === null || value === undefined) ? null : value;
      });
    }
  }
  const spokes = (report.routeSpokes || []).map((r) => ({
    r: r.shortName || r.routeId,
    hub: r.touchesHub ? 1 : 0,
    trips: r.trips || {},
    coords: r.coords || [],
  }));
  return {
    stops,
    zones,
    rings: zones.length <= MAX_MAP_ZONE_RINGS,
    reach,
    hw,
    spokes,
    spoke_cap: report.spokeCap || { shown: 0, total: 0, source: 'shapes' },
  };
}

/** Write (or rewrite) the five `<script type="application/json">` blocks into the DOM. */
function writeDataBlocks() {
  const blocks = [
    ['data', dataPayload(state.report)],
    ['questions-data', questionsPayload(state.report)],
    ['curses-data', cursesPayload(state.report)],
    ['stops', stopsPayload(state.report)],
    ['provenance', state.report.provenance || {}],
  ];
  let host = $id('jltg-data');
  if (!host) {
    host = document.createElement('div');
    host.id = 'jltg-data';
    host.hidden = true;
    document.body.appendChild(host);
  }
  host.innerHTML = blocks.map(([id, payload]) => jsonBlock(id, payload)).join('\n');
  // Map data that arrives after the map was built goes through `refreshMapData`,
  // which re-reads `#stops` and pushes it through `setData`; pan and zoom survive.
  try {
    const runtime = window.__jltg;
    if (runtime && typeof runtime.refreshMapData === 'function') runtime.refreshMapData();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[app] map refresh failed', err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Day chrome
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The two pieces of page chrome that need a `Report`: the wordmark's place name and
 * the status chip. The score is `null` when more than 40% of the points could not be
 * measured (CONTRACT §(f)), and the chip then says `Partly measurable` rather than
 * printing a guess. The shell ships both spans empty and `hidden`.
 */
function mountChrome() {
  const report = state.report;
  const place = report.place || report.feed.agencyName || '';
  const placeSpan = $id('wordmark-place');
  const x = $id('wordmark-x');
  if (placeSpan) {
    placeSpan.textContent = place;
    placeSpan.hidden = !place;
  }
  if (x) x.hidden = !place;

  const host = $id('status');
  if (!host) return;
  const f = report.fitness;
  if (!f) { host.innerHTML = ''; return; }
  host.innerHTML = (f.score !== null && f.score !== undefined)
    ? chip(`${num(f.score, 1)} · ${f.band}`, 'circle-check', {
      variant: bandVariant(f.band), appearance: 'filled',
    })
    : chip('Partly measurable', 'circle-question', { variant: 'neutral' });
}

function mountDayChrome() {
  const report = state.report;
  const keys = dayOrder(report);

  // ── the banner, first child of <main> ──────────────────────────────────────
  const banner = $id('daybanner');
  if (banner && keys.length) {
    const b = dayBanner(report, bestDay(report));
    banner.setAttribute('variant', b.variant);
    banner.innerHTML = dayBannerHtml(b);
    // The shell ships it `hidden`; filling it is what reveals it.
    banner.hidden = false;
  } else if (banner) {
    banner.hidden = true;
  }

  // ── the selector, in the subheader; hidden when there is nothing to choose ──
  if (keys.length < 2) {
    const existing = $id('daysel');
    if (existing) existing.remove();
    return;
  }
  const per = (report.fitness && report.fitness.perDay) || {};
  const radios = keys.map((key) => {
    const label = dayLabel(report, key);
    const title = key in per
      ? `${label} — rated ${num(per[key], 1)} of 100 on ${label} service`
      : label;
    return el('wa-radio', esc(label), { value: key, appearance: 'button', size: 's', title });
  }).join('');
  const html = el('wa-radio-group', radios, {
    id: 'daysel', name: 'day', label: 'Playing on',
    orientation: 'horizontal', size: 's', value: bestDay(report),
  });
  const existing = $id('daysel');
  if (existing) {
    existing.outerHTML = html;
    return;
  }
  const slot = document.querySelector('[data-role="dayselector"]');
  if (slot) slot.insertAdjacentHTML('afterbegin', html);
}

// ═══════════════════════════════════════════════════════════════════════════════
// The secret route
// ═══════════════════════════════════════════════════════════════════════════════
//
// S5 (`render_strategy`) is a second *view* of the same document, reached only by
// `location.hash === '#strategy'`, linked from nothing.
//
//   * It is a view, not a tenth section: membership in `SECTIONS` would give it an
//     ordinal, a nav entry and a place in the reading order.
//   * Visibility hangs off `body[data-view]`, not `data-state`. `data-state` is the
//     run lifecycle, and leaving it alone means the report is hidden, never torn
//     down: `#netmap` keeps its MapLibre instance and coming back is free.
//   * The route is module code. `PAGE_RUNTIME_JS` is a verbatim port and must never
//     learn that this view exists.

/**
 * Build the guide once and insert it inside `<wa-page>`, as a sibling of `<main>`.
 * The root must be a `<section>`: `wa-page > section` is what gets the page measure
 * and block padding in styles.css; a `<div>` renders flush and full-bleed.
 *
 * @returns {HTMLElement|null} the `#strategy` root, or null when there is nothing to
 *   render (no zones, or the renderer threw). Callers gate on `state.finished`.
 */
function mountStrategy() {
  const existing = $id('strategy');
  if (existing) return existing;
  let html = '';
  try {
    html = renderStrategy(state.report);
  } catch (err) {
    // A guide that cannot be built must not break the report. Fall through quietly.
    // eslint-disable-next-line no-console
    console.warn('[app] strategy', err);
    return null;
  }
  if (!html) return null;
  const page = document.querySelector('wa-page');
  if (!page) return null;
  const root = parseHtml(html).firstElementChild;
  if (!root) return null;
  const main = page.querySelector(':scope > main');
  if (main && main.nextSibling) page.insertBefore(root, main.nextSibling);
  else page.appendChild(root);
  return root;
}

/**
 * Read the fragment and put the right view on screen. Bound to `hashchange`, called
 * once in `boot()` for a deep link, and once more at the tail of `finish()`.
 * `#strategy` with no finished report is the landing form, with no hint that
 * anything else exists.
 */
function applyRoute() {
  const body = document.body;
  if (!body) return;
  if (location.hash === STRATEGY_HASH && state.finished) {
    const host = mountStrategy();
    if (!host) { leaveStrategy(); return; }
    // Before `initStrategy`: MapLibre reads its container size once, at construction,
    // and a `display:none` container measures zero for ever.
    body.setAttribute('data-view', 'strategy');
    if (!state.strategyTitle) state.strategyTitle = document.title;
    const report = state.report;
    const place = report.place || report.feed.agencyName || 'This map';
    document.title = `${place} × Hide and Seek — Hider's Guide`;
    // `#top` is the report hero, hidden here; pointing the wordmark at the fragment
    // itself keeps it inert.
    const wordmark = $id('wordmark');
    if (wordmark) wordmark.setAttribute('href', STRATEGY_HASH);
    try {
      initStrategy(host, report);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[app] strategy', err);
    }
    // Two frames: the runtime's `openTargeted` is also bound to `hashchange` and
    // scrolls `#strategy` to `block: 'center'` one frame later, so this must queue
    // after it. The focus move gives a screen reader the new view; `tabindex="-1"`
    // keeps the root out of the tab order.
    host.tabIndex = -1;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      host.scrollIntoView({ block: 'start' });
      host.focus({ preventScroll: true });
    }));
    return;
  }
  leaveStrategy();
}

/** Put the report back. Idempotent and cheap: nothing was destroyed. */
function leaveStrategy() {
  const body = document.body;
  if (!body || !body.hasAttribute('data-view')) return;
  body.removeAttribute('data-view');
  if (state.strategyTitle) {
    document.title = state.strategyTitle;
    state.strategyTitle = '';
  }
  const wordmark = $id('wordmark');
  if (wordmark) {
    wordmark.setAttribute('href',
      body.getAttribute('data-state') === 'landing' ? '#landing' : '#top');
  }
  // Mirror of the focus move in `applyRoute`.
  const back = document.querySelector('#top');
  if (back) {
    back.tabIndex = -1;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      back.focus({ preventScroll: true });
    }));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// The page runtime
// ═══════════════════════════════════════════════════════════════════════════════
//
// A port of generate.py's `SHARED_PAGE_JS` and `_S4_INDEX_JS`, kept as one source
// string. Two changes, both forced by progressive hydration: every binding is
// idempotent (nodes stamped `data-bound`, one-shot observers flagged on
// `window.__jltg`) because it runs again each time a stage lands new markup, and
// every `D()` read tolerates a missing block.

const PAGE_RUNTIME_JS = String.raw`
const W = (window.__jltg = window.__jltg || {});
const $  = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const D   = id => { const n = document.getElementById(id);
                    if (!n) return null;
                    try { return JSON.parse(n.textContent); } catch (e) { return null; } };
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* MapLibre feature-hover cannot anchor a <wa-tooltip>; this reads offsetWidth. */
let tt = $('tt');
if (!tt) { tt = document.createElement('div'); tt.id = 'tt'; document.body.appendChild(tt); }
function bindTT(el, html) {
  if (el.dataset.ttBound) return;
  el.dataset.ttBound = '1';
  el.addEventListener('mousemove', e => {
    tt.innerHTML = html; tt.style.display = 'block';
    const w = tt.offsetWidth, x = Math.min(e.clientX + 14, innerWidth - w - 12);
    tt.style.left = x + 'px'; tt.style.top = (e.clientY + 16) + 'px';
  });
  el.addEventListener('mouseleave', () => tt.style.display = 'none');
}

/* The Points Budget and the deck strip are <wa-chart> canvases (budgetBar in
   render/html.js). This plugin paints the segment letters, and hover routes to the
   #tt panel because Chart.js's own tooltip is clipped inside a 20px canvas. */
const budgetSeg = {
  id: 'budgetSeg',
  afterDatasetsDraw(chart) {
    const ctx = chart.ctx;
    ctx.save();
    ctx.font = '700 11px ' + cssVar('--sans');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [i, ds] of chart.data.datasets.entries()) {
      const bar = chart.getDatasetMeta(i).data[0];
      if (!bar || !ds.letter) continue;
      const { base, x, y } = bar.getProps(['base', 'x', 'y'], true);
      if (Math.abs(x - base) < 14) continue;   /* too narrow for a letter */
      ctx.fillStyle = ds.ink ? cssVar(ds.ink) : '#fff';
      ctx.fillText(String(ds.letter), (base + x) / 2, y);
    }
    ctx.restore();
  },
};

/* Assigning '.plugins' re-renders the component on its own; the hover handler reads
   '.chart' lazily, so it is correct while the element is still upgrading. */
function bindBudgets() {
  for (const c of document.querySelectorAll('wa-chart[data-budget]')) {
    if (c.dataset.budgetBound) continue;
    c.dataset.budgetBound = '1';
    c.plugins = [budgetSeg];
    c.addEventListener('mousemove', e => {
      /* 'nearest', not 'index': with one category 'index' returns all seven datasets */
      const hit = c.chart
        && c.chart.getElementsAtEventForMode(e, 'nearest', { intersect: true }, false);
      const ds = hit && hit.length ? c.chart.data.datasets[hit[0].datasetIndex] : null;
      if (!ds) { tt.style.display = 'none'; return; }
      tt.innerHTML = esc(ds.label);
      tt.style.display = 'block';
      const w = tt.offsetWidth, x = Math.min(e.clientX + 14, innerWidth - w - 12);
      tt.style.left = x + 'px'; tt.style.top = (e.clientY + 16) + 'px';
    });
    c.addEventListener('mouseleave', () => { tt.style.display = 'none'; });
  }
}

/* the two pages share the selected game day through localStorage */
const DAY_KEY = 'jltg-day';
function loadDay(fallback) {
  try { return localStorage.getItem(DAY_KEY) || fallback; } catch (e) { return fallback; }
}
function saveDay(k) { try { localStorage.setItem(DAY_KEY, k); } catch (e) {} }

/* The map's layer state, per viewer. It has to outlive the geo-stage re-mount, which
   rebuilds the MapLibre instance. MODES is the whitelist: a stale value in storage
   must not put the map in a mode it no longer has. */
const LAYER_KEY = 'jltg-netlayers';
const MODES = ['base', 'reach', 'frequency'];
function loadLayers() {
  const out = { mode: 'reach', zones: false, spokes: false };
  try {
    const raw = localStorage.getItem(LAYER_KEY);
    const got = raw ? JSON.parse(raw) : null;
    if (got && typeof got === 'object') {
      if (MODES.indexOf(got.mode) >= 0) out.mode = got.mode;
      out.zones = Boolean(got.zones);
      out.spokes = Boolean(got.spokes);
    }
  } catch (e) { /* no storage, or nonsense in it */ }
  return out;
}
function saveLayers() {
  try { localStorage.setItem(LAYER_KEY, JSON.stringify(W.layers)); } catch (e) {}
}
W.layers = W.layers || loadLayers();

/* Open whatever the fragment is buried inside, then scroll to it; otherwise a link
   into a closed disclosure appears to do nothing. */
function openTargeted() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) return;
  const t = document.getElementById(id);
  if (!t) return;
  for (let n = t; n && n !== document.body; n = n.parentElement) {
    if (n.localName === 'wa-details') n.open = true;
    else if (n.localName === 'wa-accordion-item') n.setAttribute('expanded', '');
    else if (n.localName === 'wa-tab-panel') {
      const g = n.closest('wa-tab-group');
      if (g) g.setAttribute('active', n.getAttribute('name'));
    }
  }
  requestAnimationFrame(() => t.scrollIntoView({ block: 'center' }));
}
if (!W.hashBound) { W.hashBound = 1; addEventListener('hashchange', openTargeted); }

/* Scrollspy: aria-current on the rail link of the section nearest the top. */
function bindSpy() {
  if (W.spy) { W.spy.disconnect(); W.spy = null; }
  const links = [...document.querySelectorAll('nav[slot="navigation"] a[href^="#"]')];
  const pairs = links.map(a => [document.getElementById(a.getAttribute('href').slice(1)), a])
                     .filter(p => p[0]);
  if (!pairs.length || !('IntersectionObserver' in window)) return;
  let cur = null;
  const tick = () => {
    let hit = pairs[0];
    for (const p of pairs) if (p[0].getBoundingClientRect().top <= 140) hit = p;
    if (hit[1] === cur) return;
    if (cur) cur.removeAttribute('aria-current');
    cur = hit[1];
    cur.setAttribute('aria-current', 'true');
  };
  const io = new IntersectionObserver(tick, { rootMargin: '-140px 0px -55% 0px', threshold: [0, 1] });
  pairs.forEach(p => io.observe(p[0]));
  W.spy = io;
  tick();
}

/* Reading-progress bar in the status strip. */
function bindProgress() {
  const bar = $('readbar');
  if (!bar || W.readProgress) return;
  W.readProgress = 1;
  const on = () => {
    const h = document.documentElement, d = h.scrollHeight - h.clientHeight;
    bar.value = d > 0 ? Math.min(100, Math.max(0, (h.scrollTop / d) * 100)) : 0;
  };
  addEventListener('scroll', on, { passive: true });
  on();
}

/* ── data ────────────────────────────────────────────────────────────────── */
const DATA  = D('data');
const STOPS = D('stops');
const G     = (DATA && DATA.game) || {};

/* ── day state, persisted through localStorage ───────────────────────────── */
let CURRENT = W.day || (DATA && DATA.selected_day) || '';
if (DATA && !W.day) {
  const saved = loadDay(DATA.selected_day);
  if ((DATA.day_keys || []).indexOf(saved) >= 0) CURRENT = saved;
}
W.day = CURRENT;

function hwHighlight() {
  document.querySelectorAll('#hwmap .cell, #hwmap2 .cell').forEach(c =>
    c.toggleAttribute('data-dim', c.dataset.d !== CURRENT));
  document.querySelectorAll('#hwmap th[data-d], #hwmap2 th[data-d]').forEach(h =>
    h.toggleAttribute('data-sel', h.dataset.d === CURRENT));
}

function flagFindings() {
  document.querySelectorAll('#findings-body wa-card[data-day]').forEach(c =>
    c.toggleAttribute('data-today', c.dataset.day === CURRENT));
}

function renderDay() {
  if (!DATA) return;
  const d = (DATA.days || {})[CURRENT];
  if (!d) return;
  const banner = $('daybanner');
  if (banner && d.banner_html) { banner.setAttribute('variant', d.variant); banner.innerHTML = d.banner_html; }
  const tiles = $('tiles');
  if (tiles && d.tiles_html) tiles.innerHTML = d.tiles_html;
  /* An empty caption is a real answer (nothing to notice), so this assigns
     unconditionally and lets #netcaption:empty take the row back. */
  const cap = $('netcaption');
  if (cap && 'map_caption_html' in d) cap.innerHTML = d.map_caption_html || '';
  document.querySelectorAll('#dayscores [data-day]').forEach(t => {
    if (t.dataset.day === CURRENT) t.setAttribute('aria-current', 'true');
    else t.removeAttribute('aria-current');
  });
  hwHighlight();
  flagFindings();
  renderTT();
  /* The map's data layers read the selected day; the viewport does not move. */
  if (W.paintMap) W.paintMap();
  /* #tiles was just replaced, so the tile controls need their attributes back. */
  bindRail();
}

function setDay(k) {
  if (!DATA || !(DATA.days || {})[k]) return;
  CURRENT = k;
  W.day = k;
  saveDay(k);
  const sel = $('daysel');
  if (sel && sel.value !== k) sel.value = k;
  renderDay();
}

/* ── ride-time chart ─────────────────────────────────────────────────────── */
/* Chart.js paints to a <canvas>, which cannot resolve var(--x); the tokens are
   read at draw time so the chart follows the wa-light / wa-dark class on <html>. */
const TT_BAR = 21, TT_GAP = 9;

const ttDecor = {
  id: 'ttDecor',
  afterDatasetsDraw(chart) {
    const cfg = chart.options.plugins.ttDecor;
    const rows = cfg.rows, max = cfg.max;
    const { ctx, scales: { x } } = chart;
    ctx.save();
    ctx.textBaseline = 'middle';
    chart.getDatasetMeta(0).data.forEach((bar, i) => {
      const t = rows[i];
      if (!t) return;
      /* bars past the axis maximum are clipped, so pin their annotation to the end */
      const px = x.getPixelForValue(Math.min(t.minutes, max));
      const y = bar.y, h = bar.height;
      if (t.avail) {
        ctx.font = '700 12px ' + cssVar('--mono');
        ctx.fillStyle = cssVar('--ink-2');
        ctx.textAlign = 'left';
        ctx.fillText(String(t.minutes), px + 6, y);
      } else {
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = cssVar('--baseline');
        ctx.strokeRect(x.getPixelForValue(0), y - h / 2,
                       Math.max(2, x.getPixelForValue(max) - x.getPixelForValue(0)), h);
        ctx.setLineDash([]);
        ctx.font = 'italic 11px ' + cssVar('--sans');
        ctx.fillStyle = cssVar('--ink-3');
        ctx.textAlign = 'right';
        ctx.fillText(t.note, x.getPixelForValue(max) - 6, y);
      }
    });
    ctx.restore();
  },
  afterDraw(chart) {
    const cfg = chart.options.plugins.ttDecor;
    const { ctx, chartArea: ca, scales: { x } } = chart;
    if (cfg.hp > cfg.max) return;
    const px = x.getPixelForValue(cfg.hp);
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = cssVar('--crit');
    ctx.beginPath(); ctx.moveTo(px, ca.top - 10); ctx.lineTo(px, ca.bottom); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '700 10.5px ' + cssVar('--sans');
    ctx.fillStyle = cssVar('--crit-text');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(cfg.hpLabel, px, ca.top - 14);
    ctx.restore();
  },
};

/* the rich tooltip is the page's #tt panel; canvas tooltips cannot carry markup */
(function ttHover() {
  const el = $('ttchart');
  if (!el || el.dataset.hoverBound) return;
  el.dataset.hoverBound = '1';
  el.addEventListener('mousemove', e => {
    if (tt.style.display !== 'block') return;
    const w = tt.offsetWidth, x = Math.min(e.clientX + 14, innerWidth - w - 12);
    tt.style.left = x + 'px'; tt.style.top = (e.clientY + 16) + 'px';
  });
  el.addEventListener('mouseleave', () => tt.style.display = 'none');
})();

async function renderTT() {
  const el = $('ttchart');
  if (!el || !DATA) return;
  const seq = (W.ttSeq = (W.ttSeq || 0) + 1);
  const rows = ((DATA.days || {})[CURRENT] || {}).travel || [];
  if (!rows.length) return;
  const max = G.chart_max_min;
  el.style.height = (rows.length * (TT_BAR + TT_GAP) + 64) + 'px';
  if (!customElements.get('wa-chart')) await customElements.whenDefined('wa-chart');
  await el.updateComplete;
  if (seq !== W.ttSeq) return;                     /* a later day switch already won */

  const fill = t => !t.avail ? 'transparent'
                  : t.tone === 'bust'  ? cssVar('--crit')
                  : t.tone === 'tight' ? cssVar('--gold-mark')
                  : cssVar('--accent');
  el.plugins = [ttDecor];
  el.config = {
    type: 'bar',
    data: {
      labels: rows.map(r => r.label),
      datasets: [{
        data: rows.map(r => r.avail ? r.minutes : 0),
        backgroundColor: rows.map(fill),
        /* wa-chart auto-assigns a palette border to a dataset that omits one */
        borderColor: 'transparent',
        borderWidth: 0,
        borderRadius: { topLeft: 0, bottomLeft: 0, topRight: 4, bottomRight: 4 },
        borderSkipped: false,
        barThickness: TT_BAR,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: matchMedia('(prefers-reduced-motion: reduce)').matches
        ? false : { duration: 450, easing: 'easeOutQuart' },
      layout: { padding: { top: 22, right: 52 } },
      scales: {
        x: {
          min: 0, max: max,
          border: { display: false },
          grid: { color: cssVar('--grid'), drawTicks: false },
          ticks: { stepSize: Math.max(5, Math.round(max / 5 / 5) * 5), color: cssVar('--ink-3'),
                   font: { family: cssVar('--sans'), size: 11 } },
        },
        y: {
          border: { display: false },
          grid: { display: false },
          ticks: {
            autoSkip: false,
            font: { family: cssVar('--sans'), size: 12.5, weight: '600' },
            color: c => rows[c.index] && !rows[c.index].avail ? cssVar('--ink-3') : cssVar('--ink'),
          },
        },
      },
      plugins: {
        legend: { display: false },
        ttDecor: { rows: rows, max: max, hp: G.hiding_period_min,
                   hpLabel: G.hiding_period_min + '-MIN HIDING PERIOD' },
        tooltip: {
          enabled: false,
          external(ctx) {
            const d = rows[ctx.tooltip.dataPoints?.[0]?.dataIndex];
            if (!ctx.tooltip.opacity || !d) { tt.style.display = 'none'; return; }
            tt.innerHTML = d.tip;
            tt.style.display = 'block';
          },
        },
      },
    },
  };
  el.renderChart();
}
/* canvas colours are baked in at draw time — repaint when the colour scheme flips */
if (!W.ttThemeObs) {
  W.ttThemeObs = new MutationObserver(() => { if (W.renderTT) W.renderTT(); });
  W.ttThemeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
}
W.renderTT = renderTT;

/* ── the network map ─────────────────────────────────────────────────────── */
function ringOf(lon, lat, radiusM, n) {
  const out = [];
  const dLat = radiusM / 111132;
  const dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  for (let i = 0; i <= n; i++) {
    const a = 2 * Math.PI * i / n;
    out.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return out;
}

async function buildMap() {
  const host = $('netmap');
  if (!host || W.mapBuilt || !DATA || !STOPS || !DATA.border || !DATA.hub) return;
  W.mapBuilt = 1;
  /* giveUp undoes the claim so the next injectRuntime() can retry, and hides the
     map's own chrome (layer switches and colour key), which is useless without a
     map. The copy buttons stay: the border is text. */
  const setChrome = (on) => {
    for (const id of ['netlayers', 'netlegend']) {
      const n = $(id);
      if (n) n.hidden = !on;
    }
  };
  const giveUp = (msg, e) => { W.mapBuilt = 0; setChrome(false); console.warn(msg, e || ''); };
  let maplibregl;
  /* ns.default ?? ns: maplibre-gl 6 dropped the default export. (No backticks in
     here: this whole runtime is one String.raw template.) */
  try {
    const ns = await import('__MAPLIBRE_JS__');
    maplibregl = ns.default ?? ns;
  } catch (e) { giveUp('MapLibre unavailable — map omitted', e); return; }
  if (typeof maplibregl === 'undefined' || !maplibregl || !maplibregl.Map) {
    giveUp('MapLibre unavailable — map omitted');
    return;
  }

  const B = DATA.border, bb = B.bbox;                  /* [S, W, N, E] */
  const borderRing = B.kind === 'circle'
    ? ringOf(B.circle[1], B.circle[0], B.circle[2], 96)
    : [[bb[1], bb[0]], [bb[3], bb[0]], [bb[3], bb[2]], [bb[1], bb[2]], [bb[1], bb[0]]];

  const STYLES = { light: '__TILES_LIGHT__', dark: '__TILES_DARK__' };
  /* the same values as styles.css --ink-2, --surface, --gold-deep, --accent, written
     out because MapLibre paint takes no var() */
  const PAL = { light: { stop: '#556577', edge: '#fafafa', gold: '#906600', zone: '#202f40' },
                dark:  { stop: '#b5bfcb', edge: '#202f40', gold: '#ffbf40', zone: '#91b5dd' } };
  const isDark = () => document.documentElement.classList.contains('wa-dark');
  let dark = isDark();

  host.style.height = '470px';
  host.classList.toggle('dark-map', dark);

  let map;
  try {
    map = new maplibregl.Map({
      container: 'netmap',
      style: STYLES[dark ? 'dark' : 'light'],
      bounds: [[bb[1], bb[0]], [bb[3], bb[2]]],
      fitBoundsOptions: { padding: { top: 40, bottom: 34, left: 40, right: 52 } },
      cooperativeGestures: true,
      attributionControl: { compact: true },
    });
  } catch (e) {
    giveUp('MapLibre failed — map omitted', e);
    host.innerHTML = ''; host.style.height = '';
    return;
  }
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: G.scale_unit }), 'bottom-left');
  /* Published: a later injectRuntime() builds a new closure and returns early on the
     mapBuilt guard, so anything that pushes new data must reach the map through W. */
  W.map = map;
  W.mapReady = 1;
  /* A retry after an earlier giveUp() finds the chrome hidden; this gives it back. */
  setChrome(true);

  const zoneRings = STOPS.rings ? {
    type: 'FeatureCollection',
    features: STOPS.zones.map(z => ({
      type: 'Feature', properties: { name: z[2] },
      geometry: { type: 'Polygon', coordinates: [ringOf(z[0], z[1], G.zone_radius_m, 40)] },
    })),
  } : { type: 'FeatureCollection', features: [] };

  /* Sources and layers are rebuilt on every style.load, which fires again after
     setStyle on a theme flip. The ramps are read with cssVar() rather than
     hard-coded like PAL because they are the same tokens the ride chart and the
     headway grid paint from, and a second copy would drift. */
  let RAMP = null;
  const readRamp = () => ({
    reachOk: cssVar('--accent'),        /* fits the window with slack */
    reachTight: cssVar('--gold-mark'),  /* fits, but past three quarters of it */
    reachBust: cssVar('--crit'),        /* busts the hiding period */
    reachNone: cssVar('--baseline'),    /* no journey on this day */
    /* the six steps [data-hb='1']…[data-hb='6'] paint the headway grid with */
    hb: [cssVar('--seq-100'), cssVar('--seq-200'), cssVar('--seq-300'),
         cssVar('--seq-400'), cssVar('--seq-550'), cssVar('--seq-650')],
    off: cssVar('--off'),
    spoke: cssVar('--ink-2'),          /* a route line, and every mark's hairline */
    spokeHub: cssVar('--gold-deep'),   /* a route that calls at the hub */
    ink: cssVar('--ink'),              /* the ring that makes a fill a shape */
  });

  /* The headway grid's own thresholds, via #data. A trailing null is the open-ended
     last bin (Infinity is not JSON). */
  const BINS = (G.headway_bins_min && G.headway_bins_min.length)
    ? G.headway_bins_min : [10, 15, 25, 35, 50, null];
  const binOf = v => {
    for (let i = 0; i < BINS.length; i++) {
      const lim = BINS[i];
      if (lim === null || lim === undefined || v <= lim) return i + 1;
    }
    return BINS.length;
  };

  /* Which per-day columns #stops carried, last time paintMap read it. Cached because
     applyMode runs on every tile hover and D('stops') is a large parse. */
  let HAS_REACH = Boolean(STOPS.reach && Object.keys(STOPS.reach).length);
  let HAS_HW = Boolean(STOPS.hw && Object.keys(STOPS.hw).length);

  /* Rebuild the two data-bearing sources from whatever #stops now holds, re-filter
     the spokes to the selected day, then repaint. Never setStyle, never fitBounds:
     nothing here may move the viewport. */
  const paintMap = () => {
    if (!W.map || !W.map.getSource) return;
    const S = D('stops') || STOPS || {};
    const day = W.day || CURRENT;
    const hp = Number(G.hiding_period_min || 0);
    HAS_REACH = Boolean(S.reach && Object.keys(S.reach).length);
    HAS_HW = Boolean(S.hw && Object.keys(S.hw).length);
    const reach = (S.reach || {})[day] || null;
    const zs = W.map.getSource('zonedots');
    if (zs) {
      zs.setData({
        type: 'FeatureCollection',
        features: (S.zones || []).map((z, i) => {
          /* -1 is "no journey", never null: MapLibre expressions compare numbers */
          const t = reach && reach[i] !== null && reach[i] !== undefined ? reach[i] : null;
          return {
            type: 'Feature',
            properties: {
              name: z[2], score: z[3],
              t: t === null ? -1 : t,
              frac: (t === null || hp <= 0) ? -1 : t / hp,
            },
            geometry: { type: 'Point', coordinates: [z[0], z[1]] },
          };
        }),
      });
    }
    const hw = (S.hw || {})[day] || null;
    const ss = W.map.getSource('stops');
    if (ss) {
      ss.setData({
        type: 'FeatureCollection',
        features: (S.stops || []).map((s, i) => {
          /* hb 0 is "no service at this stop on this day" (CONTRACT §(d) StopRow) */
          const v = hw && hw[i] !== null && hw[i] !== undefined ? hw[i] : null;
          return {
            type: 'Feature',
            properties: {
              name: s[2], routes: s[3], freq: s[4] || 0,
              hb: v === null ? 0 : binOf(v),
              hwv: v === null ? -1 : v,
            },
            geometry: { type: 'Point', coordinates: [s[0], s[1]] },
          };
        }),
      });
    }
    /* Spoke geometry never changes, only which run today: a setFilter on the per-day
       t_<dayKey> property, flattened at build time because an expression cannot
       index into a nested object. */
    if (W.map.getLayer && W.map.getLayer('n-spoke-line')) {
      W.map.setFilter('n-spoke-line', ['>', ['coalesce', ['get', 't_' + day], 0], 0]);
    }
    applyMode();
  };

  /* The stop dots' edge ramp, and the heavier one the frequency layer needs so a
     1.3 px dot at z9 still has an edge. */
  const STOP_EDGE_W = ['interpolate', ['linear'], ['zoom'], 9, .3, 13, 1];
  const STOP_EDGE_HB = ['interpolate', ['linear'], ['zoom'], 9, .6, 13, 1.2];

  /* Colour only: setPaintProperty on two layers. The force argument lets a tile
     highlight put the map into a mode without writing it to W.layers or storage,
     so dropping the highlight gives the reader's own choice straight back. */
  const applyMode = (force) => {
    if (!W.map || !W.map.getLayer || !W.map.getLayer('zone-dots') || !RAMP) return;
    const p = PAL[isDark() ? 'dark' : 'light'];
    let mode = force || (W.layers && W.layers.mode) || 'base';
    /* A mode with no column behind it looks like a broken map; W.layers may still
       carry it from another feed, so the paint refuses it too. */
    if (mode === 'reach' && !HAS_REACH) mode = 'base';
    if (mode === 'frequency' && !HAS_HW) mode = 'base';
    const set = (layer, prop, value) => {
      if (W.map.getLayer(layer)) W.map.setPaintProperty(layer, prop, value);
    };
    if (mode === 'reach') {
      /* Four bins that differ in hue AND ring: lightness is not monotone in the
         light theme, so the stroke is the redundant channel (tight wears --gold-deep,
         bust wears --ink, no-journey is ring only). The strokes are also the contrast
         fix: the fills alone are well under 3:1 on the basemap's land colour. Keep
         the fills as §06's ride-chart tokens. */
      set('zone-dots', 'circle-color', ['case',
        ['<', ['get', 'frac'], 0], 'rgba(0,0,0,0)',
        ['<=', ['get', 'frac'], 0.75], RAMP.reachOk,
        ['<=', ['get', 'frac'], 1.0], RAMP.reachTight,
        RAMP.reachBust]);
      set('zone-dots', 'circle-stroke-color', ['case',
        ['<', ['get', 'frac'], 0], RAMP.spoke,
        ['>', ['get', 'frac'], 1.0], RAMP.ink,
        ['>', ['get', 'frac'], 0.75], RAMP.spokeHub,
        p.edge]);
      set('zone-dots', 'circle-stroke-width', ['case',
        ['<', ['get', 'frac'], 0], 1.5,
        ['>', ['get', 'frac'], 1.0], 1.6,
        ['>', ['get', 'frac'], 0.75], 1.4,
        1]);
      set('zone-dots', 'circle-stroke-opacity', 0.95);
      set('zone-dots', 'circle-opacity', 0.9);
      set('stop-dots', 'circle-color', RAMP.off);
      set('stop-dots', 'circle-stroke-color', p.edge);
      set('stop-dots', 'circle-stroke-width', STOP_EDGE_W);
      set('stop-dots', 'circle-opacity', 0.4);
    } else if (mode === 'frequency') {
      /* A single-hue lightness ramp, CVD-safe, same six steps as the headway grid. */
      set('stop-dots', 'circle-color', ['case',
        ['<=', ['get', 'hb'], 0], RAMP.off,
        ['match', ['get', 'hb'],
          1, RAMP.hb[0], 2, RAMP.hb[1], 3, RAMP.hb[2],
          4, RAMP.hb[3], 5, RAMP.hb[4], 6, RAMP.hb[5], RAMP.hb[5]]]);
      set('stop-dots', 'circle-opacity', ['case', ['<=', ['get', 'hb'], 0], 0.35, 0.9]);
      /* The hairline the grid's cells carry: the light end of this ramp is 1.1:1
         against pale ground, and without an edge the best-served stops vanish. */
      set('stop-dots', 'circle-stroke-color', RAMP.spoke);
      set('stop-dots', 'circle-stroke-width', STOP_EDGE_HB);
      set('zone-dots', 'circle-color', p.zone);
      set('zone-dots', 'circle-stroke-color', p.edge);
      set('zone-dots', 'circle-stroke-width', 1);
      set('zone-dots', 'circle-stroke-opacity', 0.85);
      set('zone-dots', 'circle-opacity', 0.3);
    } else {
      set('zone-dots', 'circle-color', p.zone);
      set('zone-dots', 'circle-stroke-color', p.edge);
      set('zone-dots', 'circle-stroke-width', 1);
      set('zone-dots', 'circle-stroke-opacity', 0.85);
      set('zone-dots', 'circle-opacity', 0.9);
      set('stop-dots', 'circle-color', p.stop);
      set('stop-dots', 'circle-stroke-color', p.edge);
      set('stop-dots', 'circle-stroke-width', STOP_EDGE_W);
      set('stop-dots', 'circle-opacity', 0.8);
    }
    const legend = $('netlegend');
    if (legend) legend.setAttribute('data-mode', mode);
  };
  /* ── tile → map highlight ──────────────────────────────────────────────────
     Some stat tiles name a fact the map can point at. Hover or focus previews it,
     click or Enter/Space pins it, one at a time. Every branch below is paint, a
     filter or a visibility flag: nothing touches a source, writes W.layers or moves
     the viewport, so clearing a highlight is one applyMode() and two hidden layers. */
  const HL_NONE = ['==', ['literal', 0], ['literal', 1]];   /* matches no feature */
  const HL_LABEL = {
    zones: 'the hiding zones',
    stops: 'the served stops',
    frequency: 'the stops on a 15-minute route-direction',
    reach: 'the zones the hiding period cannot reach',
    extent: 'the border and the smallest circle that holds the network',
  };
  let hlPinned = null;
  let hlPreview = null;

  const applyHl = () => {
    if (!W.map || !W.map.getLayer || !W.map.getLayer('zone-dots') || !RAMP) return;
    let kind = hlPreview || hlPinned || null;
    /* a highlight with no data behind it shows nothing rather than dimming everything */
    if (kind === 'reach' && !HAS_REACH) kind = null;
    const set = (layer, prop, value) => {
      if (W.map.getLayer(layer)) W.map.setPaintProperty(layer, prop, value);
    };
    const filt = (layer, value) => {
      if (W.map.getLayer(layer)) W.map.setFilter(layer, value);
    };
    const show = (layer, on) => {
      if (W.map.getLayer(layer)) {
        W.map.setLayoutProperty(layer, 'visibility', on ? 'visible' : 'none');
      }
    };
    /* Back to the reader's own layer state first, then the emphasis on top. The
       frequency highlight dims on the freq flag, so it still works without the
       headway column; it just does not force the ramp it cannot paint. */
    applyMode((kind === 'frequency' && HAS_HW) ? 'frequency'
      : kind === 'reach' ? 'reach' : null);
    filt('n-hl-zones', HL_NONE);
    filt('n-hl-stops', HL_NONE);
    show('n-mec-line', false);
    if (W.map.getLayer('border-line')) {
      W.map.setPaintProperty('border-line', 'line-width', kind === 'extent' ? 3 : 1.6);
      W.map.setPaintProperty('border-line', 'line-opacity', kind === 'extent' ? 1 : .85);
    }
    /* the extent tile thickens both gold frames */
    if (W.map.getLayer('border-suggested-line')) {
      W.map.setPaintProperty('border-suggested-line', 'line-width', kind === 'extent' ? 2.4 : 1.2);
      W.map.setPaintProperty('border-suggested-line', 'line-opacity', kind === 'extent' ? 1 : .9);
    }
    if (kind === 'zones') {
      set('stop-dots', 'circle-opacity', .12);
    } else if (kind === 'stops') {
      set('zone-dots', 'circle-opacity', .12);
      set('stop-dots', 'circle-opacity', .95);
    } else if (kind === 'frequency') {
      /* freq is the 15-minute route-direction flag the tile counts */
      set('stop-dots', 'circle-opacity', ['case', ['>', ['get', 'freq'], 0], .95, .07]);
      set('zone-dots', 'circle-opacity', .1);
      filt('n-hl-stops', ['>', ['get', 'freq'], 0]);
    } else if (kind === 'reach') {
      /* frac < 0 is "no journey"; frac > 1 busts the window. Only those stay lit. */
      const missed = ['any', ['<', ['get', 'frac'], 0], ['>', ['get', 'frac'], 1]];
      set('zone-dots', 'circle-opacity', ['case', missed, 1, .08]);
      set('stop-dots', 'circle-opacity', .06);
      filt('n-hl-zones', missed);
    } else if (kind === 'extent') {
      set('stop-dots', 'circle-opacity', .25);
      set('zone-dots', 'circle-opacity', .25);
      show('n-mec-line', true);
    }
    /* A live region announces on mutation, and applyHl runs on every hover across
       the rail, so write only when the text actually differs. */
    const note = $('netpin');
    const say = hlPinned ? 'Showing: ' + (HL_LABEL[hlPinned] || '') : '';
    if (note && note.textContent !== say) note.textContent = say;
  };

  /* Published for bindRail(), which lives outside this closure because #tiles is
     rewritten on every day switch and re-stamped from renderDay(). */
  W.highlight = (kind, pin) => {
    if (pin === 'pin') hlPinned = (hlPinned === kind) ? null : kind;
    else hlPreview = kind;
    applyHl();
    return hlPinned;
  };
  W.highlightPinned = () => hlPinned;

  const paintAll = () => { paintMap(); applyHl(); };
  W.paintMap = paintAll;
  W.refreshMapData = paintAll;

  /* Only now do the tiles become controls: earlier bindRail() calls were no-ops
     until W.highlight existed. */
  bindRail();

  map.on('style.load', () => {
    /* The geo-stage re-mount orphans this instance, listeners and all; an orphan's
       style.load would repaint the live map from a stale closure. */
    if (W.map !== map) return;
    const p = PAL[isDark() ? 'dark' : 'light'];
    RAMP = readRamp();

    /* Route spokes go in first, so they sit under everything. A route calling at the
       hub is gold and a shade heavier. Hidden unless asked for; paintMap() filters. */
    map.addSource('n-spokes', { type: 'geojson', data: {
      type: 'FeatureCollection',
      features: (STOPS.spokes || []).map(sp => {
        const props = { r: sp.r, hub: sp.hub ? 1 : 0 };
        const trips = sp.trips || {};
        for (const k of Object.keys(trips).sort()) props['t_' + k] = trips[k];
        return { type: 'Feature', properties: props,
          geometry: { type: 'LineString', coordinates: sp.coords || [] } };
      }),
    } });
    map.addLayer({ id: 'n-spoke-line', type: 'line', source: 'n-spokes',
      layout: { visibility: W.layers.spokes ? 'visible' : 'none',
        'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['>', ['get', 'hub'], 0], RAMP.spokeHub, RAMP.spoke],
        'line-opacity': ['case', ['>', ['get', 'hub'], 0], .5, .35],
        /* only one zoom-based interpolate per expression, so the case goes inside */
        'line-width': ['interpolate', ['linear'], ['zoom'],
          9, ['case', ['>', ['get', 'hub'], 0], 1.3, .7],
          13, ['case', ['>', ['get', 'hub'], 0], 1.8, 1.2],
          16, ['case', ['>', ['get', 'hub'], 0], 2.6, 2]],
      } });

    map.addSource('border', { type: 'geojson', data: {
      type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: borderRing } } });
    map.addLayer({ id: 'border-line', type: 'line', source: 'border',
      paint: { 'line-color': p.gold, 'line-width': 1.6, 'line-opacity': .85, 'line-dasharray': [3, 2.4] } });

    /* The worker's suggested border, when it offered one: a second gold rectangle,
       solid and thinner. No suggestion is the common case: the source is then an
       empty FeatureCollection so the layer exists either way for applyHl(). */
    const SB = DATA.suggestedBorder;
    const sbb = (SB && SB.bbox && SB.bbox.length === 4 && SB.bbox.every(Number.isFinite))
      ? SB.bbox : null;
    map.addSource('border-suggested', { type: 'geojson', data: sbb
      ? { type: 'Feature', properties: {}, geometry: { type: 'LineString',
        coordinates: [[sbb[1], sbb[0]], [sbb[3], sbb[0]], [sbb[3], sbb[2]],
          [sbb[1], sbb[2]], [sbb[1], sbb[0]]] } }
      : { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'border-suggested-line', type: 'line', source: 'border-suggested',
      paint: { 'line-color': p.gold, 'line-width': 1.2, 'line-opacity': .9 } });

    map.addSource('zonerings', { type: 'geojson', data: zoneRings });
    map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zonerings',
      layout: { visibility: W.layers.zones ? 'visible' : 'none' },
      paint: { 'fill-color': p.zone, 'fill-opacity': .10 } });
    map.addLayer({ id: 'zone-ring', type: 'line', source: 'zonerings',
      layout: { visibility: W.layers.zones ? 'visible' : 'none' },
      paint: { 'line-color': p.zone, 'line-width': .8, 'line-opacity': .55 } });

    map.addSource('stops', { type: 'geojson', data: {
      type: 'FeatureCollection',
      features: STOPS.stops.map(s => ({ type: 'Feature',
        properties: { name: s[2], routes: s[3] },
        geometry: { type: 'Point', coordinates: [s[0], s[1]] } })),
    } });
    map.addLayer({ id: 'stop-dots', type: 'circle', source: 'stops',
      paint: { 'circle-color': p.stop, 'circle-opacity': .8,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 1.3, 12, 2.4, 14, 3.6, 16, 5.4],
        'circle-stroke-color': p.edge, 'circle-stroke-opacity': .8,
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, .3, 13, 1] } });

    map.addSource('zonedots', { type: 'geojson', data: {
      type: 'FeatureCollection',
      features: STOPS.zones.map(z => ({ type: 'Feature',
        properties: { name: z[2], score: z[3] },
        geometry: { type: 'Point', coordinates: [z[0], z[1]] } })),
    } });
    map.addLayer({ id: 'zone-dots', type: 'circle', source: 'zonedots',
      paint: { 'circle-color': p.zone, 'circle-opacity': .9,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2.2, 12, 3.6, 14, 5, 16, 7],
        'circle-stroke-color': p.edge, 'circle-stroke-width': 1, 'circle-stroke-opacity': .85 } });

    /* Two halo layers, always present and filtered to nothing until a tile asks.
       Additive, on top of the dots: the point is to find four zones in three hundred. */
    map.addLayer({ id: 'n-hl-zones', type: 'circle', source: 'zonedots',
      filter: ['==', ['literal', 0], ['literal', 1]],
      paint: { 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': RAMP.spokeHub,
        'circle-stroke-width': 3, 'circle-stroke-opacity': .55,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 5.2, 12, 6.6, 14, 8, 16, 10] } });
    map.addLayer({ id: 'n-hl-stops', type: 'circle', source: 'stops',
      filter: ['==', ['literal', 0], ['literal', 1]],
      paint: { 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': RAMP.spokeHub,
        'circle-stroke-width': 2, 'circle-stroke-opacity': .5,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3.3, 12, 4.4, 14, 5.6, 16, 7.4] } });

    /* The smallest circle that holds the whole network, drawn only while the Network
       diameter tile is highlighted. */
    const mec = (DATA.metrics || {}).mec;
    map.addSource('n-mec', { type: 'geojson', data: {
      type: 'Feature', properties: {}, geometry: { type: 'LineString',
        coordinates: (mec && mec.length === 3) ? ringOf(mec[1], mec[0], mec[2], 96) : [] } } });
    map.addLayer({ id: 'n-mec-line', type: 'line', source: 'n-mec',
      layout: { visibility: 'none' },
      paint: { 'line-color': RAMP.spokeHub, 'line-width': 1.4, 'line-opacity': .7,
        'line-dasharray': [2, 2] } });

    /* Fill in what arrives later or changes with the day, and re-apply the pin. */
    paintMap();
    applyHl();
  });

  const star = document.createElement('div');
  star.className = 'mk-central';
  star.innerHTML = '<span class="star">★</span><span class="clbl">' + esc(DATA.hub.name) + '</span>';
  new maplibregl.Marker({ element: star }).setLngLat([DATA.hub.lon, DATA.hub.lat]).addTo(map);
  bindTT(star, '<b>' + esc(DATA.hub.name) + '</b>The inferred round-start station.');

  const showTip = (e, html) => {
    tt.innerHTML = html;
    tt.style.display = 'block';
    const w = tt.offsetWidth, x = Math.min(e.originalEvent.clientX + 14, innerWidth - w - 12);
    tt.style.left = x + 'px'; tt.style.top = (e.originalEvent.clientY + 16) + 'px';
  };
  /* delegated layer events survive setStyle, so bind them once */
  map.on('mousemove', 'stop-dots', e => {
    const f = e.features[0].properties;
    const wait = Number(f.hwv);
    showTip(e, '<b>' + esc(f.name || 'Stop') + '</b>' + f.routes + ' route(s) on this day'
              + (!isFinite(wait) || wait < 0
                ? ' · no service on the day you picked'
                : ' · a departure about every ' + wait + ' min, 06:00-22:00')
              + (Number(f.freq) ? ' · on a 15-minute route-direction' : ''));
  });
  map.on('mouseleave', 'stop-dots', () => { tt.style.display = 'none'; });
  map.on('mousemove', 'zone-dots', e => {
    const f = e.features[0].properties;
    const t = Number(f.t);
    showTip(e, '<b>' + esc(f.name || 'Zone') + '</b>Hiding zone'
              + (f.score == null ? '' : ' · rated ' + f.score + ' / 100')
              + (!isFinite(t) || t < 0
                ? ' · no journey from the start on this day'
                : ' · ' + t + ' min from the start'));
  });
  map.on('mouseleave', 'zone-dots', () => { tt.style.display = 'none'; });

  map.on('mousemove', 'n-spoke-line', e => {
    const f = e.features[0].properties;
    showTip(e, '<b>' + esc(String(f.r || 'Route')) + '</b>'
              + (Number(f.hub) ? 'Calls at ' + esc(DATA.hub.name) : 'Does not call at the hub'));
  });
  map.on('mouseleave', 'n-spoke-line', () => { tt.style.display = 'none'; });

  const spsw = $('spokesw');
  if (spsw) {
    if (W.layers.spokes) spsw.checked = true;
    spsw.addEventListener('change', () => {
      W.layers.spokes = Boolean(spsw.checked);
      saveLayers();
      if (map.getLayer('n-spoke-line')) {
        map.setLayoutProperty('n-spoke-line', 'visibility', spsw.checked ? 'visible' : 'none');
      }
    });
  }

  const sw = $('zonesw');
  if (sw) {
    if (W.layers.zones) sw.checked = true;
    sw.addEventListener('change', () => {
      W.layers.zones = Boolean(sw.checked);
      saveLayers();
      const v = sw.checked ? 'visible' : 'none';
      ['zone-fill', 'zone-ring'].forEach(id => {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
      });
    });
  }

  const cb = $('colourby');
  if (cb) {
    /* Attribute first, then property: an un-upgraded wa-radio-group reads the
       attribute. Only the modes this map offers count: a feed over MAX_MAP_STOPS
       ships no Frequency button, and storage must not select a mode with no control. */
    const offered = [].slice.call(cb.querySelectorAll('wa-radio'))
      .map(r => r.getAttribute('value'));
    if (offered.indexOf(W.layers.mode) < 0) {
      W.layers.mode = offered.indexOf('reach') >= 0 ? 'reach' : 'base';
    }
    cb.setAttribute('value', W.layers.mode);
    cb.value = W.layers.mode;
    cb.addEventListener('change', () => {
      const want = cb.value || 'base';
      W.layers.mode = offered.indexOf(want) >= 0 ? want : 'base';
      saveLayers();
      /* applyHl(), never applyMode(): applyMode alone would wipe a pinned tile's
         dimming while the tile still said aria-current. */
      applyHl();
    });
  }

  const retheme = () => {
    /* the orphaned instance keeps this listener too */
    if (W.map !== map) return;
    const d = isDark();
    if (d === dark) return;
    dark = d;
    host.classList.toggle('dark-map', d);
    map.setStyle(STYLES[d ? 'dark' : 'light']);
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', retheme);
  new MutationObserver(retheme)
    .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
}

/* ── the stat rail's tiles, as map controls ──────────────────────────────────
   Tiles carrying data-hl become controls: hover or focus previews, click or
   Enter/Space pins, aria-current says which. Delegated on #glance because
   renderDay() replaces #tiles wholesale; the attributes are re-stamped after each
   rewrite. Stamps nothing unless the map built, so with MapLibre blocked the tiles
   stay inert text. */
function railCard(host, e, strict) {
  const t = e.target;
  const card = t && t.closest ? t.closest('[data-hl]') : null;
  if (!card || !host.contains(card)) return null;
  // A click or Enter that started on the tile's provenance link belongs to the
  // link. Hover and focus previews are not strict.
  if (strict && t.closest) {
    const inner = t.closest('a[href], button, input, select, textarea, wa-button, wa-copy-button');
    if (inner && inner !== card && card.contains(inner)) return null;
  }
  return card;
}

function bindRail() {
  const host = $('glance');
  if (!host || !W.mapReady || !W.highlight) return;
  const sync = () => {
    const pinned = W.highlightPinned ? W.highlightPinned() : null;
    host.querySelectorAll('[data-hl]').forEach(card => {
      card.setAttribute('tabindex', '0');
      /* aria-current, not role=button: a button's children are presentational and
         would take the card's provenance link out of the accessibility tree. */
      card.setAttribute('aria-current', card.dataset.hl === pinned ? 'true' : 'false');
    });
  };
  if (!host.dataset.railBound) {
    host.dataset.railBound = '1';
    const pin = card => { W.highlight(card.dataset.hl, 'pin'); sync(); };
    host.addEventListener('mouseover', e => {
      const c = railCard(host, e);
      if (c) W.highlight(c.dataset.hl);
    });
    host.addEventListener('mouseout', e => {
      const c = railCard(host, e);
      /* moving between two children of the same card is not a leave */
      if (!c || (e.relatedTarget && c.contains(e.relatedTarget))) return;
      W.highlight(null);
    });
    host.addEventListener('focusin', e => {
      const c = railCard(host, e);
      if (c) W.highlight(c.dataset.hl);
    });
    host.addEventListener('focusout', e => {
      const c = railCard(host, e);
      if (!c || (e.relatedTarget && c.contains(e.relatedTarget))) return;
      W.highlight(null);
    });
    host.addEventListener('click', e => {
      const c = railCard(host, e, 1);
      if (c) pin(c);
    });
    host.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const c = railCard(host, e, 1);
      if (!c) return;
      e.preventDefault();
      pin(c);
    });
  }
  sync();
}
W.bindRail = bindRail;

/* ── table filters ───────────────────────────────────────────────────────── */
/* Rows carry their own data-* key, so filtering is a 'hidden' toggle and the table
   is complete with scripting off. */
function bindFilter(groupId, tableId, key) {
  const grp = $(groupId), table = $(tableId);
  if (!grp || !table) return null;
  const apply = () => {
    const want = grp.value || 'all';
    table.querySelectorAll('tbody tr').forEach(tr => {
      const chipOk = want === 'all' || tr.dataset[key] === want;
      tr.hidden = !chipOk || tr.dataset.match === '0';
    });
  };
  if (!grp.dataset.filterBound) {
    grp.dataset.filterBound = '1';
    grp.addEventListener('change', apply);
    document.addEventListener('refilter', apply);   /* the search box and the chips agree */
  }
  apply();
  return apply;
}

/* Free-text search. It only writes data-match; the 'hidden' decision stays in
   bindFilter, so the two controls cannot fight. */
function bindSearch(inputId, tableId, key) {
  const inp = $(inputId), tbl = $(tableId);
  if (!inp || !tbl || !tbl.tBodies.length) return;
  const apply = () => {
    const rows = [...tbl.tBodies[0].rows];
    const q = inp.value.trim().toLowerCase();
    for (const r of rows) r.dataset[key] = (!q || r.textContent.toLowerCase().includes(q)) ? '1' : '0';
    document.dispatchEvent(new CustomEvent('refilter'));
  };
  if (!inp.dataset.searchBound) {
    inp.dataset.searchBound = '1';
    inp.addEventListener('input', apply);
  }
  apply();
}

/* ── the "nobody spends money" switch ────────────────────────────────────── */
function bindSpending(reapplyFilter) {
  const sw = $('nospend');
  if (!sw) return;
  const rows = document.querySelectorAll('#ctable tr[data-spending]');
  rows.forEach(tr => { if (!tr.dataset.baseAction) tr.dataset.baseAction = tr.dataset.action; });
  const apply = () => {
    const on = !!sw.checked;
    document.querySelectorAll('#ctable tr[data-spending] [data-when]').forEach(node => {
      node.hidden = (node.dataset.when === 'on') !== on;
    });
    rows.forEach(tr => { tr.dataset.action = on ? 'remove' : tr.dataset.baseAction; });
    if (reapplyFilter) reapplyFilter();      /* the action filter must follow the switch */
  };
  if (!sw.dataset.spendBound) {
    sw.dataset.spendBound = '1';
    sw.addEventListener('change', apply);
  }
  apply();
}

/* ── boot ────────────────────────────────────────────────────────────────── */
(function bootPage() {
  const sel = $('daysel');
  if (sel) {
    if (CURRENT) sel.value = CURRENT;
    if (!sel.dataset.dayBound) {
      sel.dataset.dayBound = '1';
      sel.addEventListener('change', () => setDay(sel.value));
    }
  }
  document.querySelectorAll('#hwmap .cell[data-tip], #hwmap2 .cell[data-tip]')
    .forEach(cell => bindTT(cell, cell.dataset.tip));
  bindBudgets();
  for (const tile of document.querySelectorAll('#dayscores [data-day]')) {
    if (tile.dataset.tileBound) continue;
    tile.dataset.tileBound = '1';
    tile.addEventListener('click', () => setDay(tile.dataset.day));
    tile.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDay(tile.dataset.day); }
    });
  }
  bindFilter('qchips', 'qtable', 'status');
  bindSearch('qsearch', 'qtable', 'match');
  bindSpending(bindFilter('cchips', 'ctable', 'action'));
  renderDay();
  buildMap();
  bindRail();
  bindSpy();
  bindProgress();
  openTargeted();
})();
`;

/** The runtime with its three build-time substitutions applied. */
function pageRuntimeSource() {
  return PAGE_RUNTIME_JS
    .split('__MAPLIBRE_JS__').join(MAPLIBRE_JS)
    .split('__TILES_LIGHT__').join(TILES_LIGHT)
    .split('__TILES_DARK__').join(TILES_DARK);
}

/**
 * Run the page runtime against whatever is currently in the DOM, as an inline
 * module. Every binding is idempotent, so re-running it after a later section lands
 * is safe; the map is built once. Not run before `network`, the first stage that
 * gives the map a border, a hub and a stop list.
 */
function injectRuntime() {
  if (!state.arrived.has('network')) return;
  // The spent <script> is removed first so the DOM never accumulates one per stage.
  const spent = document.querySelector('script[data-jltg-runtime]');
  if (spent) spent.remove();
  const script = document.createElement('script');
  script.type = 'module';
  script.setAttribute('data-jltg-runtime', '');
  script.textContent = pageRuntimeSource();
  document.body.appendChild(script);
}

// ═══════════════════════════════════════════════════════════════════════════════

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

export default boot;
