/**
 * app.js — the main-thread controller.
 *
 * Ported from generate.py's S4 page assembly (`render_index`), its
 * day-switched payload (`_s4_banner` … `_s4_stops_payload`) and
 * its client runtime (`SHARED_PAGE_JS` + `_S4_INDEX_JS`).
 *
 * The CLI computes a whole `Report` and then prints one finished document. The
 * browser cannot: an eight-minute Overpass pass would be eight minutes of blank
 * page. So the same document is assembled progressively — the shell ships nine
 * skeleton sections, the worker streams staged partial results, and each section is
 * swapped for real markup the moment its data lands. The *output* is the same
 * artifact; only the arrival order changed.
 *
 * Division of labour, unchanged from the CLI:
 *   • the worker computes, and never touches the DOM;
 *   • `render/*.js` turn a `Report` into HTML strings, and never touch the DOM;
 *   • this file owns every element, every listener and the worker protocol.
 *
 * @module app
 */

import {
  MAPLIBRE_JS, TILES_LIGHT, TILES_DARK,
  IMPERIAL_COUNTRIES, DEFAULT_DEPARTURE, BOARD_SLACK_S,
  num, pct, mins, hhmm, prettyDate, rhu, quantile, coord,
} from './lib/core.js';

import {
  esc, el, join, waIcon, waCard, waDetails, jsonBlock, chip,
} from './render/html.js';

import {
  renderHero, renderVerdict, renderScoreTrace, renderYourGame, bandVariant,
} from './render/verdict.js';
import { renderKeyNumbers, renderNetworkMap, renderTransitReality } from './render/map.js';
import {
  renderQuestions, renderCurses, renderProvenance, renderFooter, initDeckTables,
} from './render/deck.js';
// S5 (`render_strategy`) — the hider's guide. Not a section, not a nav
// entry, not in `SECTIONS`: the fragment `#strategy` is the only door. See
// `applyRoute` below for why it is a view and not a tenth card.
import { renderStrategy } from './render/strategy.js';
import { initStrategy } from './render/simulator.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The placeholder every section passes as its ordinal (`_S4_ORDINAL`).
 * Replaced with the section's real number **after** the empty ones are dropped, so a
 * feed with no curses yields §01…§08 with no gap in the sequence.
 */
const ORDINAL_PLACEHOLDER = '--';

/** `class Options`, minus everything meaningless in a browser. */
const DEFAULT_OPTIONS = Object.freeze({
  useOsm: true,
  // An override, and null is the whole of its default. The published bucket is named
  // once, in `osm/worldfile.js`'s `DEFAULT_WORLD_BASE_URL`, and this file does not
  // import it: doing so would pull the world-file reader and the FlatGeobuf decoder
  // onto the main thread to read one string, when the only code that opens a world is
  // in the worker. Null travels to `worker.js`, which resolves it.
  worldBaseUrl: null,
  asOf: null,
  sizeOverride: null,
  zoneRadiusM: null,
  hidingPeriodMin: null,
  startStopId: null,
  borderShape: 'bbox',
  borderBbox: null,
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
 * `redo` is not a nicety: `scoreZones` fills `QuestionAudit.surv_mean` in place, so
 * §07 rendered from the `'rules'` copy is missing its funnel column (CONTRACT §(d)),
 * and §04's tiles count live questions and removed curses. Every redo is compared
 * against the markup already on the page and skipped when identical, so a section
 * that did not actually change never reflows.
 */
const SECTIONS = [
  // The hero's redo list is long on purpose. Its headline sentence reads "N of the M
  // questions in the SIZE deck function here", and `M` is `questions.length` — which
  // is `0` between the `network` and `rules` stages. Without `rules` in the list the
  // page would sit on "0 of the 0 questions" for the whole Overpass wait, which is
  // several minutes of a confidently wrong sentence. `days` is here for the same
  // reason at smaller stakes: it adds the "Best day" chip.
  { id: 'hero', needs: 'feed', redo: ['days', 'network', 'rules', 'score'], render: (r) => renderHero(r) },
  { id: 'verdict', needs: 'score', redo: [], render: (r) => renderVerdict(r) },
  { id: 'trace', needs: 'score', redo: [], render: (r) => renderScoreTrace(r) },
  { id: 'yourgame', needs: 'score', redo: [], render: (r) => renderYourGame(r) },
  { id: 'numbers', needs: 'rules', redo: ['score'], render: (r) => renderKeyNumbers(r) },
  { id: 'network', needs: 'network', redo: ['geo', 'score'], render: (r) => renderNetworkMap(r) },
  { id: 'transit', needs: 'network', redo: ['score'], render: (r) => renderTransitReality(r) },
  { id: 'questions', needs: 'rules', redo: ['score'], render: (r) => renderQuestions(r) },
  { id: 'curses', needs: 'rules', redo: ['score'], render: (r) => renderCurses(r) },
  { id: 'sources', needs: 'provenance', redo: [], render: (r) => renderProvenance(r) },
  // Chrome, like the hero: no ordinal, no nav entry. Its five figures count zones,
  // live questions, removed curses, Overpass queries and interpretations, so it is
  // corrected by every stage that changes one of those.
  { id: 'footer', needs: 'feed', redo: ['network', 'rules', 'score', 'provenance'], render: (r) => renderFooter(r) },
];

/** The nine numbered sections, in page order. `hero` is chrome, not a numbered card. */
const NUMBERED = ['verdict', 'trace', 'yourgame', 'numbers', 'network', 'transit',
  'questions', 'curses', 'sources'];

/**
 * What each stage is actually doing, in words a waiting human can act on.
 *
 * No stage waits on a shared, rate-limited service any more — GEO reads the prebuilt
 * world files — but a cold run still has quiet stretches: the feed unzip, RAPTOR over
 * every stop, the first range reads of a map. An unchanged label reads as a hang, so
 * each note says what the stage is doing and, where it matters, why it takes as long
 * as it does.
 */
const STAGE_NOTE = {
  feed: 'Downloading and unzipping the GTFS feed.',
  days: 'Working out which service days this feed actually distinguishes.',
  network: 'Running RAPTOR over every stop and covering the map in hiding zones.',
  geo: 'Reading the prebuilt OpenStreetMap files. Only the bytes covering this map are '
    + 'fetched, using HTTP range requests against a spatial index, so this is now one of '
    + 'the quicker stages rather than the slowest.',
  rules: 'Auditing all 80 questions and 24 curses against this map.',
  score: 'Scoring the city out of 100 and ranking the hiding zones.',
  provenance: 'Collecting the receipts.',
};

/**
 * The only door to S5.
 *
 * The CLI ships two files and states the invariant plainly: the
 * feasibility report and the hider's guide never link to each other, because the
 * seekers read the first one. The port has one document, so the invariant becomes:
 * nothing in the report view mentions, links to or hints at this fragment. The guide
 * may link *back* — that link is only ever visible to someone already inside it.
 */
const STRATEGY_HASH = '#strategy';

// ═══════════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The report as far as the worker has got. Every field is pre-seeded with an empty
 * container so a renderer reached at stage 2 cannot trip over a missing key.
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
    // Counts from the `'feed'` stage: the real `feed.stops` / `feed.routes` maps do
    // not cross postMessage until `'done'`, so anything that just wants an N reads
    // these. Both are kept in sync on `'done'`.
    feedCounts: { stops: 0, routes: 0, trips: 0 },
    proj: { lat0: 0, lon0: 0 },
    size: null,
    sizeInference: null,
    hub: null,
    border: null,
    days: [],
    selectedDay: '',
    zones: [],
    metrics: {},
    routeHeadways: [],
    travelSamples: [],
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
  };
}

/**
 * The unavailable `GeoData`, main-thread copy. `osm/geodata.js` exports the real
 * `emptyGeoData` but it lives in the worker; duplicating the six-line literal is
 * cheaper than importing a worker module onto the main thread. Kept byte-identical to
 * CONTRACT §(b).
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
 * Seconds of COMPLETE SILENCE from the worker before the run is called dead. Not a
 * wall-clock deadline on the run: a cold first visit legitimately spends minutes
 * reading world files, and cutting that off would be worse than the bug. What is never
 * legitimate is the worker going quiet — it announces every round trip through
 * `onProgress`, so silence means a fetch that will never return or a hang, and until
 * this existed the page span on that forever with nothing to click.
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
  progress: { pct: 0, done: 0, total: 0, stage: '', label: '' },
  /** @type {number|null} */ heartbeat: null,
  /** Seconds since the last `progress` message. Chrome only — never a report value. */
  waitedS: 0,
  /** The report's `document.title`, parked while the secret view holds the tab.
   *  Empty means "not in the guide"; see `applyRoute`. */
  /** @type {string} */ strategyTitle: '',
};

// ═══════════════════════════════════════════════════════════════════════════════
// Small DOM helpers
// ═══════════════════════════════════════════════════════════════════════════════

const $id = (id) => document.getElementById(id);

/** First match for any of `selectors`, or null. Lets the shell name things its way. */
function pick(...selectors) {
  for (const sel of selectors) {
    const found = document.querySelector(sel);
    if (found) return found;
  }
  return null;
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
  const form = pick('#runform', 'form[data-role="runform"]', 'form');
  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      startRun(form);
    });
  }
  // <wa-file-input> names the file and draws its own card, so all that is left here is
  // the cross-field rule: a URL and a file together is an error, and choosing a file is
  // the unambiguous half of that pair, so the URL box is cleared rather than making the
  // reader do it. `change` is fired for both a dialog pick and a drop.
  const fileInput = findFileInput(form);
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      if (!(fileInput.files && fileInput.files.length)) return;
      const urlInput = findUrlInput(form);
      if (urlInput && urlInput.value) urlInput.value = '';
      clearFormError();
    });
  }
  guardStrayDrops();
  // The whole router. It has one route and one fallback, and on a cold load with no
  // report the fallback is the landing form — silently, which is the point.
  window.addEventListener('hashchange', applyRoute);
  applyRoute();
  setProgress({ stage: '', label: 'Waiting for a feed', done: 0, total: 0 });
}

/**
 * A file dropped anywhere *other* than the drop zone must not navigate the page away
 * mid-run — the browser's default for a dropped file is to open it, which throws away
 * a report that can take minutes to build.
 *
 * Both types are cancelled, and that pairing is the point: `dragover` defaults to
 * *refusing* the drop, so cancelling it is what makes the rest of the page a legal
 * target, and cancelling `drop` is then what stops the browser opening the file. The
 * two together swallow the drop and do nothing, which is the intent.
 *
 * This is the whole of what app.js still does about dragging. `<wa-file-input>` owns
 * the zone itself: the dragenter/dragover/dragleave/drop handlers, the `dragging`
 * state the border colour keys off, walking a dropped directory, and re-checking
 * `accept` against what was dropped. It calls `stopPropagation()` on both of these,
 * so the ones that land on target never reach window and are unaffected.
 */
function guardStrayDrops() {
  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (event) => event.preventDefault());
  }
}

/** `<div id="tt">` — the page's own hover panel; `document()` emits it unconditionally. */
function ensureTooltipHost() {
  if (!$id('tt')) {
    const tt = document.createElement('div');
    tt.id = 'tt';
    document.body.appendChild(tt);
  }
}

/**
 * `<wa-file-input>` first: its `.files` is a plain `File[]` rather than a `FileList`,
 * but everything here only ever reads `.files[0]` and `.files.length`, so the two are
 * interchangeable and the native fallbacks below still work unchanged.
 */
function findFileInput(form) {
  const scope = form || document;
  return scope.querySelector('wa-file-input')
    || scope.querySelector('input[type="file"][data-opt="file"]')
    || scope.querySelector('#feedfile')
    || scope.querySelector('input[type="file"]');
}

function findUrlInput(form) {
  const scope = form || document;
  return scope.querySelector('[data-opt="url"]')
    || scope.querySelector('#feedurl')
    || scope.querySelector('input[type="url"]');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Options
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Read one control's value in the shape `key` wants.
 *
 * Every control is found by `[data-opt="<key>"]` first and `#opt-<key>` second, so
 * the shell can tag its inputs either way and neither of us has to guess the other's
 * ids.
 */
function readControl(form, key) {
  const scope = form || document;
  const node = scope.querySelector(`[data-opt="${key}"]`) || scope.querySelector(`#opt-${key}`);
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

/**
 * `'a, b b, a'` → `['a', 'b']`. Sorted and deduped here, as CONTRACT §(c) requires,
 * because `parse_args` does it and the provenance echo prints the result.
 */
function idList(value) {
  const s = orNull(value);
  if (s === null) return [];
  const seen = new Set();
  for (const part of s.split(/[\s,]+/)) {
    const t = part.trim();
    if (t) seen.add(t);
  }
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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

  const noOsm = readControl(form, 'noOsm');
  if (typeof noOsm === 'boolean') options.useOsm = !noOsm;

  // Validated here rather than in the worker for the same reason every other field
  // is: a bad value should come back as a sentence under the form, not as a failed
  // fetch four stages in. Trailing slashes come off here even though `openWorld`
  // strips them again — this is the string §(b) echoes into the provenance argv, and
  // two runs of the same bucket typed with and without one must not read as two
  // different sources.
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

  const bbox = orNull(readControl(form, 'borderBbox'));
  if (bbox !== null) {
    const parts = bbox.split(/[\s,]+/).filter((p) => p !== '').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      errors.push('Border box must be exactly four numbers: south, west, north, east.');
    } else {
      options.borderBbox = /** @type {[number,number,number,number]} */ (parts);
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
 * The one thing worth being strict about: the source has to be a GTFS zip.
 *
 * A `File` must end `.zip`. A URL must be http(s); an extensionless endpoint is fine
 * (plenty of agencies serve their feed from `/gtfs` or `?format=zip`), but a URL that
 * plainly points at something else is rejected with the extension named.
 *
 * @returns {{file: File|null, url: string|null, source: string, error: string}}
 */
function readSource(form) {
  const fileInput = findFileInput(form);
  const file = (fileInput && fileInput.files && fileInput.files[0]) || null;
  const urlInput = findUrlInput(form);
  const url = orNull(urlInput ? urlInput.value : null);

  if (file && url) {
    return {
      file: null, url: null, source: '',
      error: 'Pick a file or paste a URL — not both. Clear one of them and try again.',
    };
  }
  if (file) {
    if (!/\.zip$/i.test(file.name)) {
      return {
        file: null, url: null, source: '',
        error: `“${file.name}” is not a .zip. A GTFS feed is a zip archive of .txt tables — `
          + 'pick the archive itself, not a file from inside it.',
      };
    }
    return { file, url: null, source: file.name, error: '' };
  }
  if (url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { file: null, url: null, source: '', error: 'That is not a URL. It needs to start with https://' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { file: null, url: null, source: '', error: 'The feed URL has to be http:// or https://' };
    }
    const ext = (parsed.pathname.match(/\.([a-z0-9]+)$/i) || [])[1];
    if (ext && ext.toLowerCase() !== 'zip') {
      return {
        file: null, url: null, source: '',
        error: `That URL points at a .${ext.toLowerCase()} file. A GTFS feed is a .zip archive — `
          + 'this page cannot read anything else.',
      };
    }
    return { file: null, url, source: url, error: '' };
  }
  return {
    file: null, url: null, source: '',
    error: 'Choose a GTFS .zip from your computer, or paste a link to one.',
  };
}

/**
 * The callout itself is in the shell (index.html), the same way `#daybanner` is —
 * so there is nothing to build here, only something to reveal. The text node is
 * found inside the box, never document-wide, so it cannot bind to anything else.
 */
function formErrorBox() {
  const box = pick('#landing-error', '[data-role="formerror"]');
  return { box, text: box && box.querySelector('[data-role="formerrortext"]') };
}

function showFormError(message) {
  const { box, text } = formErrorBox();
  if (!box || !text) return;
  // Unhide first: the region must be in the a11y tree before the message lands,
  // or `role="alert"` has nothing to announce.
  box.hidden = false;
  text.textContent = message;
}

function clearFormError() {
  const { box, text } = formErrorBox();
  if (!box) return;
  box.hidden = true;
  // Blank it too — otherwise re-submitting an unfixed form writes the same string,
  // mutates nothing, and the alert stays silent.
  if (text) text.textContent = '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// The run
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate the form, spawn the worker and post the single `run` message.
 *
 * The `File` is transferred by reference. Reading it into an `ArrayBuffer` here
 * would double peak memory on a 65 MB feed for no gain — structured clone handles
 * `File` objects and the worker can stream it.
 */
function startRun(form) {
  if (state.running) return;
  clearFormError();

  const src = readSource(form);
  if (src.error) {
    showFormError(src.error);
    return;
  }
  const { options, errors } = readOptions(form);
  if (errors.length) {
    showFormError(errors.join(' '));
    return;
  }
  // `source` stays on this side: CONTRACT §(c) carries it in the message's `file` /
  // `url` fields, and keeping the two apart is what makes the protocol readable.
  state.report.opts = { ...options, source: src.source };

  let worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    showFormError(`This browser could not start the analysis worker (${err && err.name}). `
      + 'A module Web Worker is required, and the page has to be served over http, not opened from disk.');
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
    fatalError('worker', event.message || 'The analysis worker stopped unexpectedly.');
  });
  worker.addEventListener('messageerror', () => {
    fatalError('worker', 'The analysis worker sent a message this browser could not read.');
  });

  enterRunningState(src);
  armWatchdog();
  worker.postMessage({ type: 'run', options, file: src.file, url: src.url });
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
 * Move the shell from `landing` to `running`: hide the form, reveal the nine
 * skeletons, start the progress readout.
 *
 * `document.body.dataset.state` is the switch, and styles.css §7 is the only thing
 * that reads it — `body[data-state='landing'] [data-when='report']` is what keeps the
 * report out of the way before a feed exists, and it is `!important`, so nothing this
 * file does to an individual element can overrule it. Leaving the attribute at
 * `landing` hides every section on the page for the whole run.
 *
 * The wordmark's anchor rides along, for the same reason: `#top` is the hero, the
 * hero is `data-when="report"`, and that same `!important` rule makes it
 * `display: none` in the landing state — an anchor to a hidden element scrolls
 * nowhere and cannot take sequential focus. So the wordmark points at the landing
 * card while the landing card is what there is to point at.
 */
function setShellState(value) {
  if (document.body) document.body.setAttribute('data-state', value);
  // `data-view` is the orthogonal axis (see the secret route below). While it holds,
  // it owns the wordmark's anchor — `#top` is `data-when="report"` and hidden there,
  // so writing it would leave the one always-visible chrome element pointing at
  // nothing. The lifecycle attribute above still changes; only the href is deferred.
  if (document.body && document.body.hasAttribute('data-view')) return;
  const wordmark = document.getElementById('wordmark');
  if (wordmark) wordmark.setAttribute('href', value === 'landing' ? '#landing' : '#top');
}

/** Hide the landing form, reveal the report skeletons, start the progress readout. */
function enterRunningState(src) {
  setShellState('running');
  const landing = pick('#landing', '[data-role="landing"]');
  if (landing) landing.hidden = true;
  const report = pick('#report', '[data-role="report"]', 'main');
  if (report) report.hidden = false;
  setProgress({
    stage: 'feed',
    label: src.file ? `Reading ${src.file.name}` : 'Fetching the feed',
    done: 0,
    total: 100,
  });
  startHeartbeat();
}

/**
 * Say how long the current step has been running.
 *
 * The pipeline is deterministic and reads no clock; this is page chrome, and nothing
 * it prints reaches the report. It exists because a stage can still go quiet for
 * longer than a reader will sit still — RAPTOR over a large feed, or a cold map whose
 * world-file reads are ~40 MB on a slow link — and an unchanging label reads as a
 * hang, which is the one thing this run is not. Nothing is printed for the first 30 s,
 * so a warm run never shows it at all.
 */
function startHeartbeat() {
  if (state.heartbeat) return;
  state.heartbeat = setInterval(() => {
    if (state.finished || state.fatal) {
      clearInterval(state.heartbeat);
      state.heartbeat = null;
      const out = pick('[data-role="progresswait"]');
      if (out) out.textContent = '';
      return;
    }
    state.waitedS += 5;
    const out = pick('[data-role="progresswait"]');
    if (!out) return;
    if (state.waitedS < 30) {
      out.textContent = '';
      return;
    }
    const m = Math.floor(state.waitedS / 60);
    const s = state.waitedS % 60;
    const elapsed = m ? `${m} min ${s}s` : `${s}s`;
    out.textContent = `Still working — ${elapsed} on this step. Nothing has stalled; `
      + 'the page is waiting for an answer rather than guessing at one.';
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
      // Diagnostics are never report content. They go where diagnostics go.
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
      r.size = payload.size || null;
      r.sizeInference = payload.sizeInference || null;
      r.metrics = payload.metrics || {};
      r.routeHeadways = payload.routeHeadways || [];
      r.travelSamples = payload.travelSamples || [];
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
 * The complete `Report`. Everything up to here was a partial view of it, so the
 * authoritative copy replaces the accumulator — but every section is re-rendered
 * through the same comparison, so only sections whose markup actually changed touch
 * the DOM.
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
    // delivered. CONTRACT §(d) says `done` is complete, but a degraded worker can
    // send a `Report` with a null field it filled on its stage anyway — a missing
    // scoring layer sends `provenance: null` after the `'provenance'` stage sent a
    // real one — and taking that literally deletes a section that was already on the
    // page and correct. A merge can only ever add here; it can never subtract.
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
  // Nothing is going to fill these now. A hidden husk in the DOM is still a nav link
  // that goes nowhere, so the last word on "no empty cards" is said here.
  for (const husk of [...document.querySelectorAll('[data-state="empty"]')]) {
    const id = husk.getAttribute('data-section');
    husk.remove();
    if (id) {
      state.dropped.add(id);
      for (const a of document.querySelectorAll(`nav[slot="navigation"] a[href="#${id}"]`)) a.remove();
    }
  }
  renumberSections();
  pruneNav();
  writeDataBlocks();
  renderDegradations();
  mountChrome();
  mountDayChrome();
  injectRuntime();
  // `ready` retires the header progress block (`[data-when='running']`) and leaves
  // the report visible; it must be set even if a section threw, because the
  // alternative is a page stuck behind the running-state chrome.
  setShellState('ready');
  setProgress({ stage: 'done', label: 'Report complete', done: 1, total: 1 });
  clearWatchdog();
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
  // Last, after `setShellState('ready')`: a page that was loaded at `#strategy`
  // before there was a feed enters the guide the moment the run completes.
  applyRoute();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Progress
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Drive the header bar.
 *
 * `total` grows as work is discovered (CONTRACT §(d)), so the raw ratio can fall even
 * though nothing went backwards. The displayed percentage is therefore clamped
 * monotonically: a bar that retreats is worse than a bar that pauses.
 */
function setProgress(msg) {
  state.waitedS = 0;
  const waited = pick('[data-role="progresswait"]');
  if (waited) waited.textContent = '';
  const done = Number(msg.done) || 0;
  const total = Number(msg.total) || 0;
  const raw = total > 0 ? Math.min(100, (done / total) * 100) : state.progress.pct;
  const value = Math.max(state.progress.pct, raw);
  state.progress = {
    pct: value,
    done,
    total,
    stage: msg.stage || state.progress.stage,
    label: msg.label || state.progress.label,
  };

  const bar = pick('[data-role="progressbar"]');
  if (bar) {
    bar.value = rhu(value, 1);
    bar.setAttribute('value', String(rhu(value, 1)));
  }
  const label = pick('[data-role="progresslabel"]');
  if (label) label.textContent = state.progress.label || '';

  const root = state.progress.stage.split(':')[0];
  const note = pick('[data-role="progressnote"]');
  if (note) note.textContent = STAGE_NOTE[root] || '';
  const host = pick('[data-role="progress"]');
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
 * Render every section this stage unblocks and swap it into the page.
 *
 * A renderer that throws takes only its own section down: the rest of the report is
 * still true, and a blank card that says why beats a blank page.
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
      recordDegradation(`Section “${def.id}” could not be rendered (${err && err.message}).`);
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
 * Replace a skeleton with real markup.
 *
 * Three things this must not do: jank the main thread (large fragments go in across
 * animation frames), lose the user's place (a section above the fold that grows
 * scrolls the page under them, so the scroll position is corrected by the height
 * delta), and flash (the swap fades, unless the reader asked for no motion).
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
    // A renderer that joined several top-level blocks keeps all of them; taking only
    // the first would silently drop content.
    root = document.createElement('div');
    root.className = 'wa-stack wa-gap-l';
    root.appendChild(fragment);
  }
  root.setAttribute('data-section', id);
  root.setAttribute('data-state', 'ready');

  const rect = host.getBoundingClientRect();
  const before = rect.height;
  const above = rect.bottom < 0;

  // Big sections — a 7,700-stop table, a 400-row question list — go in in pieces.
  const heavy = [...root.querySelectorAll('tbody')].filter((b) => b.rows.length > 200);
  const parked = heavy.map((body) => {
    const rows = [...body.rows];
    for (const row of rows) row.remove();
    return { body, rows };
  });

  // The map is built once and guarded by `window.__jltg.mapBuilt`, which is exactly
  // right until a later stage re-renders §05: the old `#netmap` goes out with the old
  // markup and the flag would stop the new one ever being built, leaving a
  // `height:0` div where the map was. Clearing the flag when the swap actually
  // carries a map frame is what makes `redo: ['geo', 'score']` safe for §05.
  const hadMap = host.querySelector && host.querySelector('#netmap');
  if (hadMap && root.querySelector && root.querySelector('#netmap')) {
    const runtime = window.__jltg;
    if (runtime) runtime.mapBuilt = 0;
  }

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

  // §07 and §08 ship sortable headers, a page-size control and filter state that
  // survives a re-render; `deck.js` owns all three and has to be handed the freshly
  // inserted nodes. It is idempotent and never dispatches `refilter`, so it composes
  // with this file's own filter/search bindings rather than fighting them.
  if (id === 'questions' || id === 'curses') {
    // Both arguments matter: `root` is the freshly inserted subtree, and the payload
    // is what deck.js's re-wire observer replays when a later stage swaps the markup
    // out from under it. Called with neither, the observer re-wires against `null`.
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
 * safe when no later stage could still fill the section — §04 renders empty until the
 * geo layer decides what units to print in — so an early empty result merely hides the
 * card, and only a stage with nothing left to wait for removes it for good.
 */
function dropSection(def) {
  const host = sectionHost(def.id);
  const pending = def.redo.some((s) => !state.arrived.has(s));
  if (pending) {
    if (host) {
      host.setAttribute('data-state', 'empty');
      host.hidden = true;
      host.innerHTML = '';
    }
    return;
  }
  state.dropped.add(def.id);
  if (host) host.remove();
  for (const a of document.querySelectorAll(`nav[slot="navigation"] a[href="#${def.id}"]`)) {
    a.remove();
  }
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
  // Anything still holding the placeholder is not one of the nine numbered cards.
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
      ? 'Part of this report is missing rather than guessed at:'
      : 'Parts of this report are missing rather than guessed at:'), { className: 'wa-body-s' }),
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
  let host = pick('#degradations', '[data-role="degradations"]', 'wa-toast');
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
    el('p', esc('Nothing on this page was written from a partial answer — the run stopped here '
      + 'rather than filling the gap. Reload and try another feed, or the same one again: the '
      + 'commonest causes are a link that is not a GTFS zip and a feed that is missing '
      + 'stop_times.txt.'), { className: 'wa-body-s wa-color-text-quiet' }),
  ), { className: 'wa-stack wa-gap-m' }), {
    headerHtml: el('h2', join(waIcon('triangle-exclamation'), esc(`Stopped during “${stage}”`)),
      { className: 'wa-heading-l wa-cluster wa-gap-xs wa-align-items-center' }),
  });
  const slot = pick('#run-error', '[data-role="runerror"]');
  if (slot) {
    // The shell has a place for this. Use it, and clear away the skeletons that are
    // never going to fill — a stopped run must not leave nine shimmering cards
    // implying work is still happening.
    slot.innerHTML = el('div', card, { className: 'wa-stack wa-gap-l' });
    slot.hidden = false;
    for (const husk of [...document.querySelectorAll('[data-state="skeleton"]')]) {
      const id = husk.getAttribute('data-section');
      husk.remove();
      if (id) {
        state.dropped.add(id);
        for (const a of document.querySelectorAll(`nav[slot="navigation"] a[href="#${id}"]`)) a.remove();
      }
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
  const landing = pick('#landing', '[data-role="landing"]');
  if (landing) landing.hidden = true;
  setProgress({ stage, label: `Stopped during ${stage}`, done: 0, total: 0 });
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · unit and value formatting
// ═══════════════════════════════════════════════════════════════════════════════

/** Does this map's country read distances in miles? Metric when unknown. */
function imperial(report) {
  const code = String((report.geo && report.geo.admin && report.geo.admin.countryCode) || '').toLowerCase();
  return IMPERIAL_COUNTRIES.includes(code);
}

/** A delta with an explicit sign and a real minus glyph: '−10.2', '+3.0', '0'. */
function signed(value, dp = 1) {
  const v = rhu(value, dp);
  if (v === 0) return num(0, dp, { comma: false });
  return (v > 0 ? '+' : '−') + num(Math.abs(v), dp, { comma: false });
}

/** 'a', 'a and b', 'a, b and c' — for template sentences that list feed values. */
function joinWords(items, conjunction = 'and') {
  const good = items.filter((i) => i);
  if (!good.length) return '';
  if (good.length === 1) return good[0];
  return `${good.slice(0, -1).join(', ')} ${conjunction} ${good[good.length - 1]}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · per-day views
// ═══════════════════════════════════════════════════════════════════════════════

/** Day-type keys in the feed's own order (weekday, Saturday, Sunday, …). */
function dayOrder(report) {
  return (report.days || []).map((d) => d.dayType.key);
}

function dayLabel(report, dayKey) {
  for (const d of report.days || []) if (d.dayType.key === dayKey) return d.dayType.label;
  return dayKey;
}

function dayByKey(report, dayKey) {
  for (const d of report.days || []) if (d.dayType.key === dayKey) return d;
  return null;
}

/** The day the report opens on. */
function bestDay(report) {
  const keys = dayOrder(report);
  if (keys.includes(report.selectedDay)) return report.selectedDay;
  return keys.length ? keys[0] : 'weekday';
}

/**
 * The metric table as it reads on one service day.
 *
 * `networkMetrics` publishes the best day at the top level and every day under
 * `perDay[key]`; the size-dependent quantities exist only in their `…BySize` form
 * inside `perDay`, because S1 computes them before the size is resolved. This merges
 * the two into the flat view the tiles and banner read, and resolves the size once,
 * here, so no caller can pick the wrong band.
 */
function dayView(report, dayKey) {
  const view = { ...(report.metrics || {}) };
  delete view.perDay;
  const per = (report.metrics && report.metrics.perDay) ? report.metrics.perDay[dayKey] : null;
  if (per && typeof per === 'object') Object.assign(view, per);
  const sizeName = report.size ? report.size.name : '';
  for (const key of ['eveningZoneShare', 'reachableZoneShare',
    'reachWithinHidingPeriod', 'playableDayWeight']) {
    const bySize = view[`${key}BySize`];
    if (bySize && typeof bySize === 'object' && sizeName in bySize) view[key] = bySize[sizeName];
  }
  return view;
}

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
 */
function dayBannerHtml(report, dayKey) {
  const b = dayBanner(report, dayKey);
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
 * A deterministic x-axis maximum for the ride-time chart.
 *
 * The hiding-period line must always be on the canvas, and one 3-hour outlier must
 * not squash every other bar, so the axis is the larger of 1.25 × the hiding period
 * and the p90 of every sampled time on every day, rounded up to a multiple of 15.
 * Bars past it are clipped and annotated at the axis end.
 */
function chartMax(report) {
  const values = [];
  for (const s of report.travelSamples || []) {
    const per = s.perDay || {};
    for (const key of Object.keys(per).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      const p = per[key];
      if (p && p.minutes !== null && p.minutes !== undefined) values.push(Number(p.minutes));
    }
  }
  const floorV = Number((report.size && report.size.hidingPeriodMin) || 0) * 1.25;
  const top = Math.max(floorV, values.length ? quantile(values, 0.90) : 0.0);
  return Math.max(15, Math.ceil(top / 15.0) * 15);
}

/**
 * §04's tile grid for one day.
 *
 * The CLI renders `_s4_tiles_html` per day and ships the strings. Here the tiles live
 * inside `renderKeyNumbers`, so the same strings are obtained by rendering §04 once
 * per day type with `selectedDay` swapped and lifting `#tiles`. Same output, and only
 * one implementation of the tile markup.
 */
function tilesHtmlFor(report, dayKey) {
  const previous = report.selectedDay;
  report.selectedDay = dayKey;
  let html = '';
  try {
    html = renderKeyNumbers(report) || '';
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[app] tiles render failed', err);
    html = '';
  } finally {
    report.selectedDay = previous;
  }
  if (!html) return '';
  const tiles = parseHtml(html).querySelector('#tiles');
  return tiles ? tiles.innerHTML : '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · the embedded JSON blocks
// ═══════════════════════════════════════════════════════════════════════════════
//
// One block per concern, so a page that only wants the verdict never parses the stop
// list. The blocks are written into the live DOM because the map and the day switcher
// read them exactly the way the CLI's page does.

/** Above this the map draws zone centres only. (`_S4_MAX_MAP_STOPS`.) */
const MAX_MAP_STOPS = 5000;
/** Above this the zone circles become dots only. (`_S4_MAX_MAP_ZONE_RINGS`.) */
const MAX_MAP_ZONE_RINGS = 1200;

/**
 * The scalar metrics the page prints, flattened for `#data`. Deliberately not the
 * whole `metrics` dict: that carries per-day zone-centre id lists and hull rings,
 * which would triple the page weight for values nothing on index.html reads.
 */
const CURATED_METRIC_KEYS = [
  'servedStops', 'stopsInFeed', 'stations', 'nZones', 'nZonesHalfMile',
  'routes', 'trips', 'stopEvents', 'diameterM', 'hullSqM', 'bboxSqM',
  'spanHours', 'firstDepartureS', 'lastDepartureS', 'medianHeadwayMin',
  'medianWorstGapMin', 'medianLastDepartureS', 'frequentShare', 'frequentStops',
  'share30min', 'multiRouteStopShare', 'transferStops2plus', 'transferStops3plus',
  'routesPerStopMax', 'hubDominance', 'hubTripShare', 'networkShape',
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
  // The per-day markup costs one §04 render per day type, and it is not *true* until
  // the score lands — the banner prints a fitness delta and the tiles count live
  // questions. Before then the block ships `days: {}` and the runtime's `renderDay()`
  // returns early, which is also what keeps the eight-minute OSM wait cheap.
  for (const key of state.arrived.has('score') ? dayOrder(report) : []) {
    const b = dayBanner(report, key);
    days[key] = {
      key,
      label: b.label,
      variant: b.variant,
      banner_html: dayBannerHtml(report, key),
      tiles_html: tilesHtmlFor(report, key),
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

/** A plain object rebuilt in sorted key order — `dict(sorted(x.items()))`. */
function sortedObject(obj) {
  const out = {};
  for (const k of Object.keys(obj || {}).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) out[k] = obj[k];
  return out;
}

/** The same, with a value transform. Key order is never left to `Object.keys`. */
function sortedMap(obj, fn) {
  const out = {};
  for (const k of Object.keys(obj || {}).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) out[k] = fn(obj[k]);
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
    // `draw` / `keep` are the card price from the catalogue: `auditQuestions` copies
    // them onto every audit row from the question definition it scored, and they ride
    // across the wire with the rest of the row.
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
 * `#stops` — `[lon, lat, name, route_count]` tuples plus the zone centres.
 *
 * Tuples rather than objects: on a 1,500-stop feed that is a third of the bytes, and
 * on a 20,000-stop feed it is the difference between a page that opens and one that
 * does not. The zone centres ride along because the network map draws them and they
 * are the same geometry the strategy page ranks.
 */
function stopsPayload(report) {
  const rows = report.stops || [];
  const withinCap = rows.length <= MAX_MAP_STOPS;
  const stops = withinCap
    ? rows.map((s) => [coord(s.lon), coord(s.lat), s.name, (s.routeIds || []).length])
    : [];
  const scores = report.zoneScores || {};
  const zones = [...(report.zones || [])]
    .sort((a, b) => (a.zoneId < b.zoneId ? -1 : a.zoneId > b.zoneId ? 1 : 0))
    .map((z) => [coord(z.lon), coord(z.lat), z.name,
      z.zoneId in scores ? rhu(scores[z.zoneId].overallTenths / 10.0, 1) : null]);
  return {
    stops,
    zones,
    rings: zones.length <= MAX_MAP_ZONE_RINGS,
  };
}

/**
 * Write (or rewrite) the five JSON blocks into the live DOM.
 *
 * They are written as `<script type="application/json">` so the page is
 * self-describing, and so the map, the day switcher and the table filters read their
 * data through exactly the same door the CLI's page uses.
 */
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
}

// ═══════════════════════════════════════════════════════════════════════════════
// Day chrome
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * `_s4_day_selector` and the `#daybanner` callout.
 *
 * The day-type radio group is built from the day types the feed actually
 * distinguishes. A single-day-type feed hides the control entirely — there is
 * nothing to choose, and an empty selector reads as a bug.
 *
 * Both elements are created here if the shell did not ship them, because both need
 * data that does not exist until the score lands.
 */
/**
 * The two pieces of `page_chrome` that need a `Report`: the wordmark's
 * place name, and the status chip.
 *
 * `status_html` is "the page's one persistent grade readout" and the only part of the
 * chrome that differs between the two CLI pages, so it is ported verbatim including
 * the `Partly measurable` fallback — the score is `null` whenever more than 40% of the
 * hundred points could not be measured (CONTRACT §(f)), and printing a number there
 * would be exactly the guess the whole design refuses to make.
 *
 * The shell ships both spans empty and `hidden`; filling one is what reveals it.
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
    const opening = bestDay(report);
    banner.setAttribute('variant', dayBanner(report, opening).variant);
    banner.innerHTML = dayBannerHtml(report, opening);
    // The shell ships it `hidden` — an empty callout above the verdict is worse than
    // none — so filling it is also what reveals it. Without this the day strip never
    // appears and the day switcher looks like it does nothing.
    banner.hidden = false;
  } else if (banner) {
    banner.hidden = true;
  }

  // ── the selector, in the subheader ─────────────────────────────────────────
  if (keys.length < 2) {
    const existing = $id('daysel');
    if (existing) existing.remove();
    return;
  }
  const per = (report.fitness && report.fitness.perDay) || {};
  const radios = keys.map((key) => {
    const label = dayLabel(report, key);
    const title = key in per
      ? `${label} — this map rates ${num(per[key], 1)} of 100 on ${label} service`
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
  const slot = pick('#dayselslot', '[data-role="dayselector"]', '[slot="subheader"]');
  if (slot) slot.insertAdjacentHTML('afterbegin', html);
}

// ═══════════════════════════════════════════════════════════════════════════════
// The secret route
// ═══════════════════════════════════════════════════════════════════════════════
//
// S5 (`render_strategy`) is a whole second page in the CLI, written to
// `strategy.html`, linked from nothing. Here it is a second *view* of the same
// document, reached only by `location.hash === '#strategy'`.
//
// Three decisions worth the words:
//
//   * It is a **view**, not a tenth section. `SECTIONS` drives `hydrate`,
//     `mountSection`, `dropSection`, `renumberSections` and `pruneNav`; membership
//     would mean an ordinal, a nav entry and a place in the reading order, which is
//     the one thing this page must not have.
//   * Visibility hangs off a **new attribute**, `body[data-view]`, not off
//     `data-state`. `data-state` means the *run lifecycle* (`landing` / `running` /
//     `ready` / `failed`), and a fourth value there would put the two axes into a
//     fight over the same three `!important` rules in styles.css §7. Because
//     `data-state` is never touched, the report is *hidden* while the guide is up —
//     never re-rendered, never torn down. No listener is dropped, `#netmap` keeps its
//     MapLibre instance, and coming back is free.
//   * The route is **module code**, deliberately. `PAGE_RUNTIME_JS` already has a
//     `hashchange` listener (`openTargeted`), and that source string is a verbatim
//     port of the CLI's page JS — it must stay one, so it never learns that this view
//     exists. The listener below lives here, outside the ported text.

/**
 * Build the guide once and insert it inside `<wa-page>`, as a sibling of `<main>`.
 *
 * Sibling-of-`main` is what makes it inherit the page gutter and the `--content-width`
 * cap.
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
    // A guide that cannot be built is not a reason to break the report the reader
    // already has. Fall through to the report, quietly.
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
 *
 * The four ways back all arrive here: the guide's own `Back to the feasibility report`
 * (`href="#top"`), the browser Back button, editing the URL, and any other fragment.
 * `#strategy` with no finished report is the landing form — no error, no message, no
 * hint that anything else exists. If a feed is then run and the fragment is still
 * `#strategy`, `finish()` calls this again and the reader lands straight in the guide.
 */
function applyRoute() {
  const body = document.body;
  if (!body) return;
  if (location.hash === STRATEGY_HASH && state.finished) {
    const host = mountStrategy();
    if (!host) { leaveStrategy(); return; }
    // The attribute goes on BEFORE `initStrategy`: MapLibre reads its container size
    // once, at construction, and a container inside a `display:none` subtree measures
    // zero for ever.
    body.setAttribute('data-view', 'strategy');
    if (!state.strategyTitle) state.strategyTitle = document.title;
    const report = state.report;
    const place = report.place || report.feed.agencyName || 'This map';
    document.title = `${place} × Hide and Seek — Hider's Guide`;
    // `#top` is the report hero, and the hero is `data-when="report"` — hidden here.
    // Pointing the wordmark at the fragment itself keeps it inert rather than making
    // the one always-visible chrome element a trapdoor out of the view.
    const wordmark = $id('wordmark');
    if (wordmark) wordmark.setAttribute('href', STRATEGY_HASH);
    try {
      initStrategy(host, report);
    } catch (err) {
      // `initStrategy` is idempotent and degrades on its own; this is the last net.
      // eslint-disable-next-line no-console
      console.warn('[app] strategy', err);
    }
    // Two frames, not one, and a focus move.
    //
    // The page runtime's `openTargeted` is live in this document and is bound to
    // `hashchange` too — it resolves `#strategy` to this very element and scrolls it
    // `block: 'center'`, which on a many-screen root lands the reader in the middle of
    // the guide. `applyRoute` is bound first, so a single rAF here is queued first and
    // loses; a second frame puts this last.
    //
    // The focus move is the other half: this is a whole-document view change with a
    // new `document.title`, and everything that had focus is inside the subtree the
    // stylesheet just put to `display: none`, so the browser drops focus to `<body>`
    // and a screen reader is told nothing. `tabindex="-1"` keeps the root out of the
    // tab order while making it a legal focus target.
    host.tabIndex = -1;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      host.scrollIntoView({ block: 'start' });
      host.focus({ preventScroll: true });
    }));
    return;
  }
  leaveStrategy();
}

/** Put the report back. Idempotent, and cheap: nothing was destroyed. */
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
  // The mirror of the focus move in `applyRoute`: whatever had focus is now inside a
  // hidden subtree, so the report has to be handed a focus origin of its own.
  const back = pick('#top', 'main', '#report');
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
// A verbatim port of `SHARED_PAGE_JS` and `_S4_INDEX_JS`,
// kept as one source string so it stays diffable against the CLI's own text. Rewriting
// it as module code would let the browser port drift from `generate.py`'s output
// silently, which is the one thing a port must not do.
//
// Two changes from the CLI's copy, both forced by progressive hydration:
//   * every binding is idempotent — nodes are stamped `data-bound`, one-shot
//     observers are flagged on `window.__jltg` — because this runs again each time a
//     later stage lands new markup;
//   * every `D()` read tolerates a missing block, because §09 arrives after §05.
// Everything else, including the comments, is the CLI's.

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
   render/html.js). chart.js registers no datalabels plugin, so the segment letters are
   painted here; and Chart.js's own tooltip draws *inside* a 20px-tall canvas, where it
   is clipped to nothing, so hover routes to the same #tt panel the heatmap uses. One
   plugin, both jobs. wa-chart merges '.plugins' onto the config it parsed from the
   slotted <script>, which is why the config itself can stay in the render layer. */
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
      if (Math.abs(x - base) < 14) continue;   /* the font-size:0 rule, reborn — now per
                                                  segment rather than all-or-nothing */
      ctx.fillStyle = ds.ink ? cssVar(ds.ink) : '#fff';
      ctx.fillText(String(ds.letter), (base + x) / 2, y);
    }
    ctx.restore();
  },
};

/* Assigning '.plugins' is itself a property change, so the component re-renders on its
   own — no awaiting whenDefined/updateComplete. The hover handler reads '.chart'
   lazily, so it is correct even while the element is still upgrading. */
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

/* Open whatever the fragment is buried inside, then scroll to it. Without this, every
   #prov-*, #trace-*, #sel-*, #pred-*, #q-*, #c-* and #axis-* link would land on a row
   inside a closed disclosure and appear to do nothing. */
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

/* Scrollspy: aria-current on the rail link of the section nearest the top. One
   observer, no scroll listener, no timers. */
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
  document.querySelectorAll('#dayscores [data-day]').forEach(t => {
    if (t.dataset.day === CURRENT) t.setAttribute('aria-current', 'true');
    else t.removeAttribute('aria-current');
  });
  hwHighlight();
  flagFindings();
  renderTT();
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

/* the rich tooltip is the page's own #tt panel; canvas tooltips cannot carry markup */
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
        /* wa-chart auto-assigns a palette border to any dataset that omits one; these
           bars carry semantic fills only, and ttDecor draws the no-service outline */
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
  /* Undo the claim, so the next injectRuntime() gets to try again rather than
     inheriting a flag that says a map already exists. */
  const giveUp = (msg, e) => { W.mapBuilt = 0; console.warn(msg, e || ''); };
  let maplibregl;
  /* ns.default ?? ns, never .default alone: maplibre-gl 6 dropped the default export
     and ships named exports only, so .default is undefined on the unpinned CDN URL and
     every map silently became "unavailable". The namespace object carries the same
     Map / Marker / NavigationControl / ScaleControl either way. (No backticks in here:
     this whole runtime is one String.raw template and a backtick would end it.) */
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
  /* the same values as styles.css §1/§2 — --ink-2, --surface, --gold-deep, --accent —
     written out because MapLibre paint takes no var() */
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

  const zoneRings = STOPS.rings ? {
    type: 'FeatureCollection',
    features: STOPS.zones.map(z => ({
      type: 'Feature', properties: { name: z[2] },
      geometry: { type: 'Polygon', coordinates: [ringOf(z[0], z[1], G.zone_radius_m, 40)] },
    })),
  } : { type: 'FeatureCollection', features: [] };

  /* sources and layers are rebuilt on every style.load, which fires again after
     setStyle when the colour scheme flips */
  map.on('style.load', () => {
    const p = PAL[isDark() ? 'dark' : 'light'];
    map.addSource('border', { type: 'geojson', data: {
      type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: borderRing } } });
    map.addLayer({ id: 'border-line', type: 'line', source: 'border',
      paint: { 'line-color': p.gold, 'line-width': 1.6, 'line-opacity': .85, 'line-dasharray': [3, 2.4] } });

    map.addSource('zonerings', { type: 'geojson', data: zoneRings });
    map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zonerings',
      layout: { visibility: ($('zonesw') && $('zonesw').checked) ? 'visible' : 'none' },
      paint: { 'fill-color': p.zone, 'fill-opacity': .10 } });
    map.addLayer({ id: 'zone-ring', type: 'line', source: 'zonerings',
      layout: { visibility: ($('zonesw') && $('zonesw').checked) ? 'visible' : 'none' },
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
    showTip(e, '<b>' + esc(f.name || 'Stop') + '</b>' + f.routes + ' route(s) on this day');
  });
  map.on('mouseleave', 'stop-dots', () => { tt.style.display = 'none'; });
  map.on('mousemove', 'zone-dots', e => {
    const f = e.features[0].properties;
    showTip(e, '<b>' + esc(f.name || 'Zone') + '</b>Hiding zone'
              + (f.score == null ? '' : ' · rated ' + f.score + ' / 100'));
  });
  map.on('mouseleave', 'zone-dots', () => { tt.style.display = 'none'; });

  const sw = $('zonesw');
  if (sw) sw.addEventListener('change', () => {
    const v = sw.checked ? 'visible' : 'none';
    ['zone-fill', 'zone-ring'].forEach(id => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
    });
  });

  const retheme = () => {
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

/* ── table filters ───────────────────────────────────────────────────────── */
/* Rows are all rendered ahead of time and carry their own data-* key, so filtering is
   a 'hidden' toggle: the table is complete and readable with scripting off. */
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

/* Free-text search over an already-rendered table. It only writes data-match; the
   'hidden' decision stays in bindFilter, so the two controls cannot fight. */
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
 * Run the page runtime against whatever is currently in the DOM.
 *
 * Injected as an inline module rather than imported, for the same reason the CLI
 * inlines it: running the ported source string is what keeps this page and
 * `generate.py`'s output the same code path. Every binding it makes is idempotent, so
 * re-running it after a later section lands is safe and cheap; the map, in
 * particular, is built once and never rebuilt.
 *
 * It is not run before `#data` and `#stops` exist — `network` is the first stage that
 * gives the map a border, a hub and a stop list.
 */
function injectRuntime() {
  if (!state.arrived.has('network')) return;
  // An inline module runs once and the element is inert afterwards; the spent one is
  // cleared first so the DOM never accumulates one dead <script> per stage. (It is
  // removed *before* the new one is appended, never after: removing a module script
  // element does not cancel its execution, but it does make the ordering unreadable.)
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
