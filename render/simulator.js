// render/simulator.js — the secret hider's guide, after it is on the page.
//
// Ported from generate.py S5's page script (`_S5_STRATEGY_JS`): hav / band /
// nearestIn, answerFor, drawMap / ring / addBorder, placeSeeker / paint, readout,
// renderList, select / renderDossier, tableRows / renderTable (now `COLUMNS` +
// `wireGrid` on a `wa-data-grid`), optionChips and the bindings.
//
// `render/strategy.js` prints the guide; this file makes it move. The simulator runs
// the same arithmetic as `rules/audit.js`'s `survivalFractions` for exactly one
// seeker, the one the reader dropped on the map, so the colour partition is the score's
// own computation with the sample size set to one. The maths is a transcription.
//
// Three places are marked DIVERGENCE where the CLI's page script disagreed with
// `rules/audit.js` and the rulebook (anchored BOTH distances on one feature; never
// returned the tentacle "not within reach"; one tentacle reach per game size). They
// are corrections, not regressions, for AGENTS.md's "a JS/Python disagreement is a JS
// bug" rule.
//
// Answers are recomputed rather than read from an answer matrix: the worker never
// posts `signatures` / `surv`, and a seeker placed a second ago is in no precomputed
// sample. Everything comes from `state.report` via `zoneViews()` and `poiCategories()`.
//
// Both pages share one document and this view is mounted once and then hidden, so
// every id is namespaced `s-`, the wiring is idempotent, and reader state (mode,
// selection, sort, filter, page) survives leaving and re-entering the view.
//
// This is the only module under `render/` that mutates the DOM. Markup is built with
// the helpers in `./html.js`, every number goes through a formatter from
// `../lib/core.js`, and there is no `toFixed`, `Intl`, clock, randomness or unsorted
// iteration.
//
// @module render/simulator

import {
  MAPLIBRE_JS, TILES_LIGHT, TILES_DARK, M_PER_MILE, num, pct, mins,
} from '../lib/core.js';
import { haversineM } from '../lib/geo.js';
import {
  esc, el, join, waIcon, waCard, waCallout, waTag, waButton, waDetails,
  waProgressBar, chip, meter, subhead, dataTable,
} from './html.js';
import {
  s4Imperial, s4Dist, s4Val, s4Plural, s4MetricValue, s4Points, s4SourceTag,
} from './verdict.js';
import {
  zoneViews, modeChips, poiCategories,
  AXIS_IDS, AXIS_PLAIN, FLAG_TEXT,
  TABLE_LABELS, TABLE_PAGE, TABLE_PAGE_ABOVE, MAX_MAP_ZONES,
} from './strategy.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Presentation constants
// ═══════════════════════════════════════════════════════════════════════════════

/** The prompt each seeker mode prints until it has what it needs (generate.py). `explore` needs nothing. */
const MODE_NEED = Object.freeze({
  radar: 'Click the map to place the seekers, or use the button above.',
  match: 'Click the map to place the seekers, or use the button above.',
  measure: 'Click the map to place the seekers, or use the button above.',
  tentacle: 'Click the map to place the seekers, or use the button above.',
  thermo: 'Click the map twice — the start of the leg, then the end — or use the button above.',
});

/**
 * Arrow key → [Δlatitude, Δlongitude] in degrees, before the cosine correction.
 * ~55 m a press, ~550 m with shift: a fraction of the smallest rulebook radius, and a
 * walk between two questions. Degrees because the seeker is stored as lat/lon.
 */
const NUDGE_DEG = Object.freeze({
  ArrowUp: Object.freeze([0.0005, 0]),
  ArrowDown: Object.freeze([-0.0005, 0]),
  ArrowLeft: Object.freeze([0, -0.0005]),
  ArrowRight: Object.freeze([0, 0.0005]),
});

/**
 * The answer partition as an icon and a word: `--q-edge` cannot carry a signal by
 * colour alone (html.js:447), so every map colour is repeated as a word in the readout.
 * @type {Object<string, [string, string, string]>}  answer → [word, variant, icon]
 */
const ANSWER_TEXT = Object.freeze({
  yes: Object.freeze(['mostly yes', 'success', 'circle-check']),
  no: Object.freeze(['mostly no', 'danger', 'circle-xmark']),
  edge: Object.freeze(['mostly on the edge', 'warning', 'scale-balanced']),
  un: Object.freeze(['no answer yet', 'neutral', 'circle-question']),
});

/**
 * The same partition in tentacle words. A tentacle answer is a location's NAME or the
 * rulebook's "not within reach"; same keys, variants and icons as `ANSWER_TEXT` so the
 * colours cannot drift apart.
 * @type {Object<string, [string, string, string]>}
 */
const TENTACLE_TEXT = Object.freeze({
  yes: Object.freeze(['mostly a name in reach', 'success', 'circle-check']),
  no: Object.freeze(['mostly not within reach', 'danger', 'circle-xmark']),
  edge: Object.freeze(['mostly on the edge', 'warning', 'scale-balanced']),
  /* not "no answer yet": here `un` is the engine's class `-2`, the seekers named a
     category with nothing inside their own circle. See `majorityGroup`. */
  un: Object.freeze(['mostly nothing in reach to name', 'neutral', 'circle-question']),
});

/**
 * Score bands (`b:`) and answers (`a:`) share the fallback dot layer, so their keys are
 * namespaced before they meet in one `match` expression; `un` differs on the two sides.
 * @type {Array<[string, string]>}  key → the CSS custom property that colours it
 */
const DOT_COLOUR = Object.freeze([
  Object.freeze(['b:top', '--gold-mark']),
  Object.freeze(['b:good', '--accent']),
  /* `fair` is its own step (generate.py); collapsing it onto `good` left five bands in three colours */
  Object.freeze(['b:fair', '--warn']),
  Object.freeze(['b:weak', '--off']),
  Object.freeze(['b:un', '--off']),
  Object.freeze(['a:yes', '--q-yes']),
  Object.freeze(['a:no', '--q-no']),
  Object.freeze(['a:edge', '--q-edge']),
  Object.freeze(['a:un', '--q-un']),
]);

// ═══════════════════════════════════════════════════════════════════════════════
// Module-level helpers (pure, or DOM-generic)
// ═══════════════════════════════════════════════════════════════════════════════

/** One resolved design token, for the MapLibre paint properties a canvas cannot inherit. */
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * A closed ring of `[lon, lat]` pairs approximating a circle. Ports `ring`, generate.py.
 * 111320 m/degree on both axes is S5's own figure; app.js's 111132 differs by 0.17 %.
 *
 * @param {number} lat @param {number} lon @param {number} metres @param {number} [steps=64]
 * @returns {Array<[number, number]>}
 */
function ringOf(lat, lon, metres, steps = 64) {
  const dLat = metres / 111320;
  const dLon = metres / (111320 * Math.cos((lat * Math.PI) / 180));
  const out = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * 2 * Math.PI;
    out.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return out;
}

/** A GeoJSON `Feature` wrapper. */
function feature(geometry, properties = {}) {
  return { type: 'Feature', properties, geometry };
}

/**
 * The hover panel. MapLibre markers live outside every shadow root and map features
 * are canvas, so `wa-tooltip` cannot anchor to them (styles.css:210); `#tt` is the
 * page's one-off panel. Not a call into app.js's `bindTT`, which lives inside the
 * verbatim `PAGE_RUNTIME_JS`.
 *
 * `htmlFor` is a function: markers are built once and repainted, so the tip reads the
 * current mode and answer.
 *
 * @param {HTMLElement} node @param {() => string} htmlFor @returns {void}
 */
function bindTip(node, htmlFor) {
  let panel = document.getElementById('tt');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'tt';
    document.body.appendChild(panel);
  }
  const host = panel;
  node.addEventListener('mousemove', (e) => {
    host.innerHTML = htmlFor();
    host.style.display = 'block';
    const w = host.offsetWidth;
    host.style.left = `${Math.min(e.clientX + 14, window.innerWidth - w - 12)}px`;
    host.style.top = `${e.clientY + 16}px`;
  });
  node.addEventListener('mouseleave', () => { host.style.display = 'none'; });
}

/** Plain code-point comparison — never `localeCompare`, which is locale-dependent. */
function cmp(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** `rank` sorts nulls last, in the table and in every tie-break (generate.py). */
function rankKey(view) {
  return view.rank === null || view.rank === undefined ? Infinity : view.rank;
}

// ═══════════════════════════════════════════════════════════════════════════════
// The live instance
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The one wired view, or null. State lives here rather than in the DOM, as
 * `DECK_STATE` does (deck.js), so reader state survives leaving the view; it also gives
 * the MapLibre instance an owner, where `buildMap` (app.js) has no teardown and leaks.
 * @type {{root: HTMLElement, resize: () => void, destroy: () => void}|null}
 */
let instance = null;

/**
 * Wire the whole secret view: map, question modes, ranked rail, dossier, table.
 * IDEMPOTENT: a later call with the same `root` only resizes the map; a different
 * `root` tears the previous instance down first.
 *
 * MUST be called only when `root` is visible and laid out: MapLibre reads its container
 * size once, at construction. app.js flips `body[data-view="strategy"]` before calling.
 *
 * Never throws: the MapLibre import is wrapped and the map degrades to hidden.
 *
 * @param {HTMLElement} root  the `#strategy` element
 * @param {Object} report     the complete Report
 * @returns {void}
 */
export function initStrategy(root, report) {
  if (!root || !report) return;
  if (instance && instance.root === root) { instance.resize(); return; }
  if (instance) { instance.destroy(); instance = null; }
  instance = buildInstance(root, report);
}

/**
 * Everything above, once. One long closure rather than a class, as the CLI's script
 * is: every piece reads the same handful of variables.
 *
 * @param {HTMLElement} root @param {Object} report
 * @returns {{root: HTMLElement, resize: () => void, destroy: () => void}}
 */
function buildInstance(root, report) {
  const $ = (id) => root.querySelector(`#${id}`);

  // ── the view model, derived once ───────────────────────────────────────────
  const views = zoneViews(report);
  const byId = new Map(views.map((v) => [v.id, v]));
  const chips = modeChips(report);
  const poi = poiCategories(report);
  const size = report.size || {};
  const RAD = Number(size.zoneRadiusM) || 0;
  /**
   * Category key → THAT tentacle question's own reach, in metres. Never one reach per
   * game size from `size.tentacleReachMi`: a LARGE deck holds 1-mile and 15-mile
   * tentacles at once, and the engine reads the per-question `param` (`rules/audit.js`).
   */
  const tentacleReachM = new Map((chips.tentacle || [])
    .map((c) => [c.key, (Number(c.reachMi) || 0) * M_PER_MILE]));
  const HIDING_MIN = Number(size.hidingPeriodMin) || 0;
  const hubName = (report.hub && report.hub.name) || 'the hub';
  const imperial = s4Imperial(report);
  const mapLabels = views.length <= MAX_MAP_ZONES;
  const paged = views.length > TABLE_PAGE_ABOVE;

  // ── reader state (generate.py) ─────────────────────────────────
  let mode = 'explore';
  /* the first dossier zone, but only one `byId` can actually show */
  const opening = (report.dossierZoneIds || []).find((id) => byId.has(id));
  let selected = opening || (views[0] && views[0].id) || null;
  let seeker = null;
  let thermoA = null;
  let thermoB = null;
  /* first usable one-mile chip, else first usable chip, else one mile */
  const usableRadar = (chips.radar || []).filter((r) => r.usable);
  const opt = {
    radar: (usableRadar.find((r) => r.miles === 1) || usableRadar[0] || { miles: 1 }).miles,
    cat: null,
  };
  /* The grid owns the sort. Page and filter live here because the grid is not built
     until it upgrades, and `syncPager` writes the grid's 0-based page back. */
  let page = 0;
  let filter = '';
  /* `optionGroup` builds markup but cannot bind it, so it leaves the group id and handler here */
  let optionBind = null;

  /** zoneId → the current answer, refreshed by `computeAnswers` before every paint. */
  const answers = new Map();
  /** zoneId → the tentacle feature whose name the hider would have to say. */
  const tentacleNames = new Map();
  /**
   * zoneId → that feature's IDENTITY, `lon,lat`, which decides whether two zones gave
   * the same answer. Never group by name: `survivalFractions` classes by `flat.owner`,
   * so two branches with one name are two answers and unnamed features are not one.
   */
  const tentacleFeatures = new Map();
  let counts = { yes: 0, no: 0, edge: 0, un: 0 };
  /** The largest identical-answer group, refreshed with `counts`. See `majorityGroup`. */
  let majority = { size: 0, word: '' };

  // ── map handles, all owned by `destroy()` ──────────────────────────────────
  let maplibregl = null;
  let map = null;
  /** @type {Array<{view: Object, node: HTMLElement, marker: Object}>} */
  let markers = [];
  let seekerMarker = null;
  let themeMedia = null;
  let themeObserver = null;
  let dark = document.documentElement.classList.contains('wa-dark');
  let destroyed = false;

  // ═════════════════════════════════════════════════════════════════════════
  // The simulator — the client-side twin of `survivalFractions`
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * The three-valued answer for a signed distance past a boundary, in metres. The
   * tolerance is one zone radius: `edge` means the boundary passes through the zone's
   * rulebook circle, so the honest answer depends on where inside it the hider stands
   * (generate.py).
   *
   * @param {number} delta @returns {'yes'|'no'|'edge'}
   */
  function bandOf(delta) {
    if (Math.abs(delta) <= RAD) return 'edge';
    return delta < 0 ? 'yes' : 'no';
  }

  /**
   * The nearest of a list of `[lon, lat, name]` features to a point, and by how much it
   * wins. A `margin` inside two zone radii means a different feature could win from
   * elsewhere in the circle, which makes a matching or tentacle answer `edge`. Takes a
   * list, not a category, because the tentacle branch scans only the in-reach subset.
   *
   * @param {Array[]|null|undefined} features @param {number} lat @param {number} lon
   * @returns {{feature: Array, d: number, margin: number}|null}
   */
  function nearestOf(features, lat, lon) {
    if (!features || !features.length) return null;
    let best = null;
    let bd = Infinity;
    let second = Infinity;
    for (const f of features) {
      const d = haversineM(lat, lon, f[1], f[0]);
      if (d < bd) { second = bd; bd = d; best = f; } else if (d < second) { second = d; }
    }
    return { feature: best, d: bd, margin: second - bd };
  }

  /**
   * The same scan over a whole category. Ports `nearestIn`, generate.py.
   *
   * @param {string} cat @param {number} lat @param {number} lon
   * @returns {{feature: Array, d: number, margin: number}|null}
   */
  function nearestIn(cat, lat, lon) {
    const c = poi.categories && poi.categories[cat];
    return nearestOf(c && c.features, lat, lon);
  }

  /**
   * What this zone's hider would answer, for the loaded question and the placed seeker.
   * Ports `answerFor`, generate.py. `explore` returns a score band; every other mode
   * returns `yes` / `no` / `edge` / `un`, where `un` means "cannot be asked yet" and,
   * in tentacle mode, `no` is the rulebook's "not within reach".
   *
   * @param {Object} view @returns {string}
   */
  function answerFor(view) {
    if (mode === 'explore') return view.scoreBand;

    if (mode === 'radar') {
      if (!seeker) return 'un';
      return bandOf(haversineM(seeker.lat, seeker.lon, view.lat, view.lon)
        - opt.radar * M_PER_MILE);
    }

    if (mode === 'thermo') {
      if (!thermoA || !thermoB) return 'un';
      const da = haversineM(thermoA.lat, thermoA.lon, view.lat, view.lon);
      const db = haversineM(thermoB.lat, thermoB.lon, view.lat, view.lon);
      return bandOf(db - da);          /* hotter = closer to the end of the leg */
    }

    if (!opt.cat || !(poi.categories && poi.categories[opt.cat])) return 'un';
    if (!seeker) return 'un';

    if (mode === 'match') {
      const mine = nearestIn(opt.cat, seeker.lat, seeker.lon);
      const theirs = nearestIn(opt.cat, view.lat, view.lon);
      if (!mine || !theirs) return 'un';
      /* a different feature could win from elsewhere in the circle ⇒ edge */
      if (theirs.margin <= 2 * RAD) return 'edge';
      const same = mine.feature[0] === theirs.feature[0]
        && mine.feature[1] === theirs.feature[1];
      return same ? 'yes' : 'no';
    }

    if (mode === 'measure') {
      /* DIVERGENCE. Two nearest-feature lookups, one per side: the rulebook's measuring
         question has each player measure to the instance nearest THEM, which is what
         `osm_distance` and `survMeasuring` in rules/audit.js compare. */
      const mine = nearestIn(opt.cat, seeker.lat, seeker.lon);
      const theirs = nearestIn(opt.cat, view.lat, view.lon);
      if (!mine || !theirs) return 'un';
      /* `edge` as everywhere: the nearest-feature distance is 1-Lipschitz in position,
         so it can move by up to one radius inside the circle. It is also the engine's
         third class, a tie (`measuring_ties_are_their_own_answer`). */
      return bandOf(theirs.d - mine.d);
    }

    if (mode === 'tentacle') {
      /* The FEATURE reach anchors on the seekers, so a target outside the hider's zone
         can still be the name they give. But "(You must also be within ___ miles)", and
         a hider outside that reach answers "not within reach".

         DIVERGENCE. That answer is `no`: the engine's own class `-1` (`rules/audit.js`,
         `s3Answer` prints "not within reach"), distinct from both in-reach groups, and
         what the legend's `--q-no` "out of reach" promises. A circle straddling the
         reach ring is `edge`, like every other boundary here. */
      const reachM = tentacleReachM.get(opt.cat) || 0;
      if (!reachM) return 'un';
      const reachBand = bandOf(
        haversineM(seeker.lat, seeker.lon, view.lat, view.lon) - reachM,
      );
      if (reachBand === 'no') return 'no';                    /* "not within reach" */
      const c = poi.categories[opt.cat];
      const inReach = c.features.filter(
        (f) => haversineM(seeker.lat, seeker.lon, f[1], f[0]) <= reachM,
      );
      /* in reach, but the seekers named a category with nothing inside their own
         circle: no name to give (the engine's class `-2`) */
      if (!inReach.length) return 'un';
      /* `inReach` is non-empty, so the scan always names a feature */
      const near = nearestOf(inReach, view.lat, view.lon);
      tentacleNames.set(view.id, near.feature[2]);
      tentacleFeatures.set(view.id, `${near.feature[0]},${near.feature[1]}`);
      if (reachBand === 'edge') return 'edge';
      /* two names within a circle's width of each other ⇒ which is nearest depends on
         where in the circle the hider stands */
      return near.margin <= 2 * RAD ? 'edge' : 'yes';
    }
  }

  /**
   * The biggest set of zones whose answer is IDENTICAL, and the words for it. This is
   * the readout's survival number, the quantity `survivalFractions` averages over a
   * sample of seekers; here the sample is one.
   *
   * `edge` is never a group. Tentacles are why this cannot be `max(yes, no)`: the
   * in-reach zones each name a feature, so `yes` is one group per FEATURE, as
   * `rules/audit.js` counts them; the out-of-reach zones all give one answer.
   *
   * @param {{yes:number,no:number,edge:number,un:number}} tally
   * @returns {{size: number, word: string}}
   */
  function majorityGroup(tally) {
    if (mode !== 'tentacle') return { size: Math.max(tally.yes, tally.no), word: '' };
    let best = { size: tally.no, word: 'not within reach' };
    /* `un` is a real third group here, the engine's class `-2` (`survTentacle`): every
       in-reach zone answers "there is nothing to name". Only tentacle mode can hold a
       partial `un`; leaving it out reported 0% survival where every zone agreed. */
    if (tally.un > best.size) best = { size: tally.un, word: 'nothing in reach to name' };
    /* keyed by feature identity, not name — see `tentacleFeatures` */
    const byFeature = new Map();
    for (const v of views) {
      if (answers.get(v.id) !== 'yes') continue;
      const key = tentacleFeatures.get(v.id) || '';
      const row = byFeature.get(key);
      if (row === undefined) byFeature.set(key, { n: 1, name: tentacleNames.get(v.id) });
      else row.n += 1;
    }
    for (const key of Array.from(byFeature.keys()).sort(cmp)) {
      const { n, name } = byFeature.get(key);
      if (n <= best.size) continue;
      best = { size: n, word: name ? `nearest to ${name}` : 'nearest to the same unnamed feature' };
    }
    return best;
  }

  /** Refresh `answers`, `tentacleNames`, `counts` and `majority` for the question. */
  function computeAnswers() {
    const tally = { yes: 0, no: 0, edge: 0, un: 0 };
    tentacleNames.clear();
    tentacleFeatures.clear();
    for (const v of views) {
      const a = answerFor(v);
      answers.set(v.id, a);
      if (mode !== 'explore' && a in tally) tally[a] += 1;
    }
    counts = tally;
    majority = majorityGroup(tally);
  }

  /**
   * One zone's current answer, in the words it is actually given in: in tentacle mode
   * `no` is "not within reach", and a tip saying "no" would say the opposite.
   */
  function answerWord(view) {
    const a = answers.get(view.id) || 'un';
    if (mode === 'tentacle' && a === 'no') return 'not within reach';
    return a;
  }

  /** Does this zone have any service at all? Two places read it; both must agree. */
  function served(view) {
    return Boolean(view.service && view.service.served);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // The map
  // ═════════════════════════════════════════════════════════════════════════

  /** The paint colour for one dot key, resolved live so a theme flip re-reads it. */
  function dotColourExpression() {
    const expr = ['match', ['get', 'a']];
    for (const [key, token] of DOT_COLOUR) expr.push(key, cssVar(token) || '#7a8897');
    expr.push(cssVar('--off') || '#9ca6b1');
    return expr;
  }

  /** Every zone as a point, tagged with its current band or answer. */
  function zonePointData() {
    return {
      type: 'FeatureCollection',
      features: views.map((v) => feature(
        { type: 'Point', coordinates: [v.lon, v.lat] },
        { a: mode === 'explore' ? `b:${v.scoreBand}` : `a:${answers.get(v.id) || 'un'}` },
      )),
    };
  }

  /**
   * Sources and layers, added inside `style.load` so a `setStyle` theme flip re-adds
   * them (`buildMap`'s pattern). Every id is prefixed `s-` so nothing collides with the
   * network map's layers in the same document.
   */
  function addLayers() {
    const b = report.border || {};
    const bb = b.bbox || [0, 0, 0, 0];       /* [S, W, N, E] — Overpass order */
    const borderRing = b.kind === 'circle' && b.circle
      ? ringOf(b.circle[0], b.circle[1], b.circle[2])
      : [[bb[1], bb[0]], [bb[3], bb[0]], [bb[3], bb[2]], [bb[1], bb[2]], [bb[1], bb[0]]];

    map.addSource('s-border', {
      type: 'geojson',
      data: feature({ type: 'LineString', coordinates: borderRing }),
    });
    map.addLayer({
      id: 's-border',
      type: 'line',
      source: 's-border',
      paint: {
        'line-color': cssVar('--gold-deep') || '#906600',
        'line-width': 1.5,
        'line-dasharray': [3, 2],
      },
    });

    map.addSource('s-zone', {
      type: 'geojson',
      data: feature({ type: 'Polygon', coordinates: [[[0, 0], [0, 0], [0, 0]]] }),
    });
    map.addLayer({
      id: 's-zonefill',
      type: 'fill',
      source: 's-zone',
      paint: { 'fill-color': cssVar('--accent') || '#202f40', 'fill-opacity': 0.1 },
    });
    map.addLayer({
      id: 's-zonering',
      type: 'line',
      source: 's-zone',
      paint: { 'line-color': cssVar('--accent') || '#202f40', 'line-width': 1.5 },
    });

    map.addSource('s-leg', {
      type: 'geojson',
      data: feature({ type: 'LineString', coordinates: [] }),
    });
    map.addLayer({
      id: 's-leg',
      type: 'line',
      source: 's-leg',
      paint: {
        'line-color': cssVar('--q-edge') || '#f57a3c',
        'line-width': 2,
        'line-dasharray': [2, 1],
      },
    });

    /* Above MAX_MAP_ZONES label pills are unreadable and slow, so the partition is
       drawn as plain dots. The CLI drew nothing at that size (generate.py). */
    if (!mapLabels) {
      map.addSource('s-zonedots', { type: 'geojson', data: zonePointData() });
      map.addLayer({
        id: 's-zonedots',
        type: 'circle',
        source: 's-zonedots',
        paint: {
          'circle-color': dotColourExpression(),
          'circle-opacity': 0.9,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2.2, 12, 3.6, 14, 5, 16, 7],
          'circle-stroke-color': cssVar('--wa-color-surface-default') || '#f0f0f0',
          'circle-stroke-width': 1,
        },
      });
    }
  }

  /** The label pill for one zone. Attributes, never classes — the CSS keys on them. */
  function markerNode(view) {
    const node = document.createElement('div');
    node.setAttribute('data-zmark', 'zone');
    const label = document.createElement('span');
    label.setAttribute('data-zlbl', '');
    const dot = document.createElement('span');
    dot.setAttribute('data-zdot', '');
    const score = document.createElement('b');
    score.textContent = num(view.overall, 1);
    label.append(dot, score, ` ${view.name}`);
    node.appendChild(label);
    node.addEventListener('click', (ev) => { ev.stopPropagation(); select(view.id); });
    bindTip(node, () => join(
      el('b', esc(view.name)),
      `#${view.rank === null ? '—' : num(view.rank)} · ${num(view.overall, 1)}/${num(view.max, 0)}`,
      mode === 'explore' ? '' : `answer: ${esc(answerWord(view))}`,
      mode === 'tentacle' && tentacleNames.get(view.id)
        ? `nearest in reach: ${esc(tentacleNames.get(view.id))}`
        : '',
    ));
    return node;
  }

  /**
   * Build one marker per zone, once, and repaint in place. The CLI recreates all of
   * them on every paint (generate.py), which at MAX_MAP_ZONES is 1,200 `Marker`s a click.
   */
  function buildMarkers() {
    if (!map || !mapLabels || markers.length) return;
    markers = views.map((view) => {
      const node = markerNode(view);
      const marker = new maplibregl.Marker({ element: node, anchor: 'center' })
        .setLngLat([view.lon, view.lat])
        .addTo(map);
      return { view, node, marker };
    });
  }

  /**
   * Repaint the partition. `data-band` and `data-answer` are mutually exclusive:
   * explore sets the first and clears the second, every question mode the reverse.
   */
  function repaintMarkers() {
    for (const m of markers) {
      const { view, node } = m;
      if (mode === 'explore') {
        node.removeAttribute('data-answer');
        node.setAttribute('data-band', view.scoreBand);
      } else {
        node.removeAttribute('data-band');
        node.setAttribute('data-answer', answers.get(view.id) || 'un');
      }
      node.toggleAttribute('data-sel', view.id === selected);
      node.toggleAttribute('data-off', Boolean(view.excluded) || !served(view));
    }
    if (map && !mapLabels && map.getSource('s-zonedots')) {
      map.getSource('s-zonedots').setData(zonePointData());
    }
  }

  /** The selected zone's true-radius circle — the rulebook's own quarter/half mile. */
  function updateCircle() {
    const v = byId.get(selected);
    if (!map || !map.getSource('s-zone') || !v) return;
    map.getSource('s-zone').setData(
      feature({ type: 'Polygon', coordinates: [ringOf(v.lat, v.lon, RAD)] }),
    );
  }

  /** The thermometer leg, A→B, dashed. Empty until both ends are placed. */
  function drawLeg() {
    if (!map || !map.getSource('s-leg')) return;
    const coords = thermoA && thermoB
      ? [[thermoA.lon, thermoA.lat], [thermoB.lon, thermoB.lat]]
      : [];
    map.getSource('s-leg').setData(feature({ type: 'LineString', coordinates: coords }));
  }

  /**
   * The draggable seeker crosshair. Dragging it re-answers every question live.
   * MapLibre gives a custom marker no focusability, so the node is made a real control:
   * `tabindex="0"`, a name, and arrow keys that nudge it. With the "Place the seekers
   * at …" button in `#s-opts` that is the whole keyboard path.
   */
  function placeSeeker() {
    if (!map) return;
    if (seekerMarker) { seekerMarker.remove(); seekerMarker = null; }
    if (!seeker) return;
    const node = document.createElement('div');
    node.setAttribute('data-zmark', 'seeker');
    node.tabIndex = 0;
    node.setAttribute('role', 'application');
    node.setAttribute('aria-label',
      'The seekers. Drag, or use the arrow keys to move them.');
    const cross = document.createElement('span');
    cross.setAttribute('data-zcross', '');
    cross.textContent = '×';
    const label = document.createElement('span');
    label.setAttribute('data-zlbl', '');
    label.textContent = 'seekers';
    node.append(cross, label);
    node.addEventListener('keydown', (ev) => {
      const step = NUDGE_DEG[ev.key];
      if (!Array.isArray(step)) return;
      ev.preventDefault();
      /* MapLibre's own keyboard handler on the map container pans on the same keys */
      ev.stopPropagation();
      /* a shifted nudge is ten times the step: a walk between two questions */
      const scale = ev.shiftKey ? 10 : 1;
      /* longitude degrees shrink with latitude; cos keeps a horizontal nudge the same
         ground distance as a vertical one */
      const shrink = Math.max(Math.cos((seeker.lat * Math.PI) / 180), 0.05);
      seeker = {
        lat: seeker.lat + step[0] * scale,
        lon: seeker.lon + (step[1] * scale) / shrink,
      };
      seekerMarker.setLngLat([seeker.lon, seeker.lat]);
      paint();
    });
    seekerMarker = new maplibregl.Marker({ element: node, draggable: true, anchor: 'center' })
      .setLngLat([seeker.lon, seeker.lat])
      .addTo(map);
    seekerMarker.on('dragend', () => {
      const p = seekerMarker.getLngLat();
      seeker = { lat: p.lat, lon: p.lng };
      paint();
    });
    return node;
  }

  /** Where a click on the map goes, per mode (generate.py). */
  function onMapClick(e) {
    if (mode === 'radar' || mode === 'match' || mode === 'measure' || mode === 'tentacle') {
      seeker = { lat: e.lngLat.lat, lon: e.lngLat.lng };
      placeSeeker();
      paint();
    } else if (mode === 'thermo') {
      /* two clicks make a leg; a third starts a new one from A */
      if (!thermoA || (thermoA && thermoB)) {
        thermoA = { lat: e.lngLat.lat, lon: e.lngLat.lng };
        thermoB = null;
      } else {
        thermoB = { lat: e.lngLat.lat, lon: e.lngLat.lng };
      }
      drawLeg();
      paint();
    }
  }

  /** Follow the page's theme button. The CLI's map reads dark once and never again. */
  function retheme() {
    if (!map) return;
    const d = document.documentElement.classList.contains('wa-dark');
    if (d === dark) return;
    dark = d;
    const host = $('s-map');
    if (host) host.classList.toggle('dark-map', d);
    map.setStyle(d ? TILES_DARK : TILES_LIGHT);
  }

  /**
   * Construct the map. On any failure the container is hidden and everything else
   * keeps working; the map card's caption says so.
   */
  async function drawMap() {
    const host = $('s-map');
    if (!host) return;
    try {
      const ns = await import(MAPLIBRE_JS);
      /* ns.default ?? ns: maplibre-gl 6 ships named exports only (app.js) */
      maplibregl = ns.default ?? ns;
    } catch (err) {
      console.warn('[strategy] MapLibre unavailable — map omitted', err);
    }
    if (destroyed) return;
    if (!maplibregl || !maplibregl.Map) {
      host.hidden = true;
      paint();
      return;
    }

    const lats = views.map((v) => v.lat);
    const lons = views.map((v) => v.lon);
    dark = document.documentElement.classList.contains('wa-dark');
    host.classList.toggle('dark-map', dark);
    try {
      map = new maplibregl.Map({
        container: host,
        style: dark ? TILES_DARK : TILES_LIGHT,
        bounds: [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)],
        ],
        fitBoundsOptions: { padding: 46 },
        cooperativeGestures: true,
        attributionControl: { compact: true },
      });
    } catch (err) {
      console.warn('[strategy] MapLibre failed — map omitted', err);
      host.innerHTML = '';
      host.hidden = true;
      paint();
      return;
    }

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: imperial ? 'imperial' : 'metric' }));
    map.on('style.load', () => {
      addLayers();
      updateCircle();
      drawLeg();
      repaintMarkers();
    });
    map.on('load', () => { buildMarkers(); paint(); });
    map.on('click', onMapClick);

    themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
    themeMedia.addEventListener('change', retheme);
    themeObserver = new MutationObserver(retheme);
    themeObserver.observe(document.documentElement, {
      attributes: true, attributeFilter: ['class'],
    });
  }

  // ═════════════════════════════════════════════════════════════════════════
  // The readout
  // ═════════════════════════════════════════════════════════════════════════

  /** The lead phrase for the current question (generate.py). */
  function readoutLead() {
    const label = (poi.categories && poi.categories[opt.cat] && poi.categories[opt.cat].label)
      || opt.cat || 'feature';
    if (mode === 'radar') return `Within ${s4Val(opt.radar)} mi: `;
    if (mode === 'thermo') return 'Hotter (closer to the end of your leg): ';
    if (mode === 'match') return `Same nearest ${label}: `;
    /* not "that ${label}": each side measures to the instance nearest itself */
    if (mode === 'measure') return `Nearer their own ${label} than you are to yours: `;
    /* counts the zones that must name something; the rest answer "not within reach" */
    if (mode === 'tentacle') return `Within reach, and so having to name a ${label}: `;
    return '';
  }

  /**
   * The sentence under the map. The closing percentage is the client twin of
   * `survivalFractions`: the share of the field held by the largest group giving the
   * IDENTICAL answer (`majorityGroup`), edge zones in no group. `aria-live="polite"`,
   * so every repaint is read out.
   */
  function renderReadout() {
    const host = $('s-readout');
    if (!host) return;
    if (mode === 'explore') {
      host.textContent = 'Zones coloured by score band. Click one for its dossier.';
      return;
    }
    if ((mode === 'thermo' && !(thermoA && thermoB)) || (mode !== 'thermo' && !seeker)) {
      host.textContent = MODE_NEED[mode] || '';
      return;
    }
    /* `opt.cat` is shared by the three category modes, so it can name a category this
       mode has no question for (a park is never a tentacle subject) */
    if ((mode === 'match' || mode === 'measure' || mode === 'tentacle')
      && !(chips[mode] || []).some((c) => c.key === opt.cat)) {
      host.textContent = 'Pick a category above.';
      return;
    }
    const total = views.length;
    const yes = counts.yes || 0;
    const no = counts.no || 0;
    const edge = counts.edge || 0;
    /* the dominant answer as a word, so colour is never the only channel */
    let top = 'un';
    for (const k of ['yes', 'no', 'edge', 'un']) {
      if ((counts[k] || 0) > (counts[top] || 0)) top = k;
    }
    const words = mode === 'tentacle' ? TENTACLE_TEXT : ANSWER_TEXT;
    const [word, variant, icon] = words[top] || words.un;
    /* the tentacle mode's third answer is a real answer, so it is counted out loud */
    const notInReach = mode === 'tentacle' && no
      ? `. ${el('b', num(no))} are not within reach of the seekers and say so`
      : '';
    host.innerHTML = join(
      esc(readoutLead())
        + el('b', num(yes)) + ` of ${num(total)} zones`
        + (edge
          ? `, plus ${el('b', num(edge))} on the edge where the answer depends on`
            + ' where in the circle they stand'
          : '')
        + notInReach
        + '. Survival for a zone in the majority group'
        + (majority.word ? ` (${esc(majority.word)})` : '')
        + ` is ${total ? pct(majority.size / total, 0) : pct(0, 0)}.`,
      chip(word, icon, { variant, size: 's' }),
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // The ranked rail
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * The forty best zones, as a real listbox: one tab stop (roving `tabindex`),
   * Up/Down/Home/End move the selection, Enter/Space select. Selecting re-renders the
   * rail, so focus is captured before the rebuild and restored after.
   */
  function renderList() {
    const host = $('s-list');
    if (!host) return;
    const hadFocus = host.contains(document.activeElement);
    const shown = views.filter((v) => !v.excluded).slice(0, 40);
    host.innerHTML = shown.map((v) => {
      const off = !served(v);
      const routes = v.routeNames.length ? v.routeNames.join(', ') : '—';
      const body = el(
        'div',
        join(
          el('div', join(
            el('span', `#${num(v.rank)}`, {
              className: 'wa-caption-s wa-color-text-quiet',
            }),
            el('span', esc(v.name), { className: 'wa-heading-xs' }),
            el('span', esc(routes) + (off ? ' · no service' : ''), {
              className: 'wa-caption-xs wa-color-text-quiet',
            }),
            waProgressBar((100 * v.overall) / v.max, { label: v.name }),
          ), { className: 'wa-stack wa-gap-3xs' }),
          el('span', num(v.overall, 1), { className: 'wa-heading-xs' }),
        ),
        { className: 'wa-flank:end wa-gap-s wa-align-items-center', style: '--flank-size:4rem' },
      );
      return waCard(body, {
        className: v.id === selected ? 'wa-brand' : null,
        role: 'option',
        ariaSelected: v.id === selected ? 'true' : 'false',
        tabindex: '-1',
        dataId: v.id,
        dataOff: off || null,
      });
    }).join('');

    const rows = Array.from(host.querySelectorAll('[data-id]'));
    let active = rows.findIndex((r) => r.getAttribute('aria-selected') === 'true');
    if (active < 0) active = 0;
    rows.forEach((row, i) => {
      row.tabIndex = i === active ? 0 : -1;
      row.addEventListener('click', () => select(row.dataset.id));
      row.addEventListener('keydown', (e) => {
        let n = -1;
        if (e.key === 'ArrowDown') n = Math.min(i + 1, rows.length - 1);
        else if (e.key === 'ArrowUp') n = Math.max(i - 1, 0);
        else if (e.key === 'Home') n = 0;
        else if (e.key === 'End') n = rows.length - 1;
        else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select(row.dataset.id);
          return;
        } else return;
        e.preventDefault();
        select(rows[n].dataset.id);
      });
    });
    if (hadFocus && rows[active]) rows[active].focus();

    const count = $('s-count');
    if (count) count.textContent = `${num(shown.length)} of ${num(views.length)} shown`;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // The dossier
  // ═════════════════════════════════════════════════════════════════════════

  /** The travel sentence, DERIVED from metric R1 and never re-measured (generate.py). */
  function travelText(view) {
    if (view.travelMin === null || view.travelMin === undefined) {
      return 'not reachable in the hiding period';
    }
    const share = HIDING_MIN ? pct(view.travelMin / HIDING_MIN, 0) : '—';
    return `${mins(view.travelMin, 1)} from ${hubName} — ${share} of the hiding period`;
  }

  /** Block 3 — the questions that single this zone out, and what each leaves standing. */
  function threatsBlock(view) {
    if (!view.threats.length) {
      return el(
        'p',
        esc('No question on this map singles this zone out.'),
        { className: 'wa-body-s' },
      );
    }
    return dataTable(['Question', 'Your answer', 'Leaves'], view.threats.map((t) => [
      esc(t.label),
      esc(t.answer),
      `${num(t.zonesRemaining)} ${s4Plural(t.zonesRemaining, 'zone')} (${pct(t.surv, 0)})`,
    ]));
  }

  /** Block 4 — the six axes, each linking to its own §04 accordion item. */
  function scoreBlock(view) {
    return AXIS_IDS.map((a) => {
      const label = el(
        'a',
        esc((AXIS_PLAIN[a] || [a])[0]) + el('code', esc(a), { className: 'wa-caption-2xs' }),
        {
          href: `#s-axis-${a}`,
          className: 'wa-link wa-caption-s wa-cluster wa-gap-2xs wa-align-items-center',
        },
      );
      const measured = Boolean(view.axisMax[a]);
      const right = el(
        'span',
        measured ? `${num(view.axes[a], 1)}/${num(view.axisMax[a], 1)}` : esc('not measured'),
        { className: 'wa-caption-s' },
      );
      return meter(label, measured ? view.bars[a] || 0 : 0, right, {
        flank: '3rem', label: (AXIS_PLAIN[a] || [a])[0],
      });
    }).join('');
  }

  /** Block 5 — where the round can legally end inside this circle. */
  function spotsBlock(view) {
    if (!view.spots.length) {
      return el(
        'p',
        esc('No candidate legal endgame spot was found inside this circle. '
          + 'The rulebook needs somewhere publicly accessible during every game hour.'),
        { className: 'wa-body-s' },
      );
    }
    const list = el('ul', view.spots.map((s) => el('li', join(
      esc(s.name),
      el('span', `— ${esc(s.type)}, ${s4Dist(report, s.distanceM, 2)}`
        + (s.enclosed ? ', enclosed' : '')
        + (s.verify ? `, ${el('strong', esc('verify hours'))}` : ''), {
        className: 'wa-caption-s',
      }),
    ), { className: 'wa-body-s' })).join(''), { className: 'wa-stack wa-gap-3xs' });
    if (view.spotsTotal <= view.spots.length) return list;
    return join(list, el(
      'p',
      `${num(view.spotsTotal)} ${s4Plural(view.spotsTotal, 'candidate')} found;`
        + ` the ${num(view.spots.length)} strongest`
        + ` ${s4Plural(view.spots.length, 'is', 'are')} listed.`,
      { className: 'wa-caption-s wa-color-text-quiet' },
    ));
  }

  /**
   * Block 6 — service. Scope-reduced against the CLI's per-zone × per-day block, which
   * reads `ServiceDay.stopDays`; `daySummary` strips that before `postMessage`. What is
   * left is what was scored (S1, S2, S3 and the frequent-stop count), and the block
   * names the day it was measured on.
   */
  function serviceBlock(view) {
    const svc = view.service || {};
    if (!svc.served) {
      return join(
        waCallout(el('p', esc('No service at this station.'), { className: 'wa-body-s' }), {
          variant: 'danger', appearance: 'filled-outlined',
        }),
        el('p', esc('You cannot reach this zone, and you cannot leave it.'), {
          className: 'wa-body-s',
        }),
      );
    }
    const parts = [
      view.routeNames.length ? esc(view.routeNames.join(', ')) : '—',
      `${num(svc.routes)} ${s4Plural(svc.routes, 'route')}`,
    ];
    if (svc.headwayMin !== null && svc.headwayMin !== undefined) {
      parts.push(`typically every ${mins(svc.headwayMin, 1)}`);
    }
    parts.push(`${num(svc.frequentStops)} of ${num(svc.servedStops)}`
      + ` ${s4Plural(svc.servedStops, 'stop')} in the circle`
      + ` ${s4Plural(svc.servedStops, 'is', 'are')} frequent`);
    if (svc.exitMarginMin !== null && svc.exitMarginMin !== undefined) {
      parts.push(`${mins(svc.exitMarginMin, 1)} of margin on the last ride home`);
    }
    return join(
      el('p', parts.join(' · '), { className: 'wa-body-s' }),
      el('p', `Measured on ${esc(svc.dayLabel)}, the day the scores were computed on.`, {
        className: 'wa-caption-s wa-color-text-quiet',
      }),
    );
  }

  /** Block 7 — what the circle actually contains. */
  function amenitiesBlock(view) {
    const entries = Object.keys(view.inventory || {}).map((k) => [k, view.inventory[k]]);
    const inner = entries.length
      ? entries.map(([k, v]) => waTag(`${k} ${num(v)}`, {
        size: 's', appearance: 'outlined', pill: false,
      })).join('')
      : el('span', esc('Nothing catalogued inside the circle.'), { className: 'wa-caption-s' });
    return el('div', inner, { className: 'wa-cluster wa-gap-2xs' });
  }

  /** Block 8 — every metric this zone earned, one click down. */
  function evidenceBlock(view) {
    const rows = view.metrics.map((m) => [
      el('code', esc(m.id)) + ` ${esc(m.name)}`,
      m.available === false ? '—' : esc(s4MetricValue(m)),
      esc(s4Points(m.pointsTenths, m.maxTenths)),
      s4SourceTag(m.source) + (m.note ? ` — ${esc(m.note)}` : ''),
    ]);
    return waDetails(
      'Full evidence — every metric this zone earned',
      dataTable(['Metric', 'Value', 'Earned', 'Basis'], rows),
      { id: `s-ev-${view.id}` },
    );
  }

  /** The eight blocks in scouting-report order: what the zone is, what betrays it, what it scored, then the evidence (generate.py). */
  function renderDossier() {
    const body = $('s-body');
    const title = $('s-title');
    const score = $('s-score');
    if (!body) return;
    const view = byId.get(selected);
    if (title) {
      title.textContent = (view.rank === null ? '' : `#${num(view.rank)} `) + view.name;
    }
    if (score) {
      score.textContent = `${num(view.overall, 1)} / ${num(view.max, 0)}`
        + (view.cappedBy ? ` · held back by ${view.cappedBy}` : '');
    }

    const flags = view.flags.map((f) => {
      const [label, variant, icon] = FLAG_TEXT[f] || [f, 'neutral', 'circle-info'];
      return chip(label, icon, { variant, size: 's', pill: true });
    }).join('');

    body.innerHTML = join(
      el('p', join(
        el('b', esc('The stop this zone is measured from:')),
        `${esc(view.name)} · ${num(view.stopIds.length)}`
          + ` ${s4Plural(view.stopIds.length, 'stop')} inside the circle`
          + ` · ${esc(travelText(view))}`,
      ), { className: 'wa-body-s' }),
      flags ? el('div', flags, { className: 'wa-cluster wa-gap-2xs' }) : '',
      subhead('What finds you'), threatsBlock(view),
      subhead('Score'), scoreBlock(view),
      subhead('Endgame spots'), spotsBlock(view),
      subhead('Service'), serviceBlock(view),
      subhead('Amenities'), amenitiesBlock(view),
      evidenceBlock(view),
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // The full table — a `wa-data-grid` (render/strategy.js)
  // ═════════════════════════════════════════════════════════════════════════

  /** Every numeric column sorts on the same code-point `cmp` the old `sortKey` did. */
  const cmpNum = (a, b) => cmp(a, b);

  /**
   * The eleven columns, built ONCE: `columns` is memoised on array identity and the
   * comparators are part of that key.
   *
   * `value` is the SORT KEY and `formatter` is what a reader sees. An unmeasurable axis
   * still sorts on its number but prints an em dash, as do a null rank and travel time.
   * Rank and travel use `Infinity` for a missing value, not `sortUndefined: 'last'`, so
   * an unranked zone stays last ascending and first descending, as before. Flags sort
   * on `flags.length`.
   *
   * Formatter strings are escaped by the component, so no `esc()` here. Every
   * comparator is explicit: table-core's `'auto'` samples the first ten rows to pick an
   * algorithm, which is not a sort. Only Zone is searchable; see `searchMatches`.
   */
  const COLUMNS = Object.freeze([
    {
      id: 'rank', label: TABLE_LABELS[0], align: 'end', width: 88, searchable: false,
      value: (v) => rankKey(v), comparator: cmpNum,
      formatter: (_x, v) => (v.rank === null || v.rank === undefined ? '—' : num(v.rank)),
    },
    {
      id: 'name', field: 'name', label: TABLE_LABELS[1], flex: 3, minWidth: 150,
      /* the one alphabetical column, so the one that opens ascending */
      sortDescFirst: false,
      comparator: (a, b) => cmp(String(a).toLowerCase(), String(b).toLowerCase()),
    },
    {
      id: 'score', field: 'overall', label: TABLE_LABELS[2], align: 'end', width: 100,
      searchable: false, comparator: cmpNum, formatter: (x) => num(x, 1),
    },
    ...AXIS_IDS.map((a, i) => ({
      id: `axis-${a}`, label: TABLE_LABELS[3 + i], align: 'end', width: 128,
      searchable: false, value: (v) => v.axes[a], comparator: cmpNum,
      formatter: (x, v) => (v.axisMax[a] ? num(x, 1) : '—'),
    })),
    {
      id: 'flags', label: TABLE_LABELS[9], flex: 2, minWidth: 150, searchable: false,
      value: (v) => v.flags.length, comparator: cmpNum,
      formatter: (_x, v) => v.flags.map((f) => (FLAG_TEXT[f] || [f])[0]).join(', '),
    },
    {
      id: 'travel', label: TABLE_LABELS[10], align: 'end', width: 112, searchable: false,
      value: (v) => (v.travelMin === null || v.travelMin === undefined
        ? Infinity : v.travelMin),
      comparator: cmpNum,
      formatter: (_x, v) => (v.travelMin === null || v.travelMin === undefined
        ? '—' : mins(v.travelMin, 1)),
    },
  ]);

  /**
   * The rows, rank-ascending, which is where the sort's TOTALITY lives. The tie-break
   * is the DATA ORDER, not a comparator: table-core negates a comparator's whole return
   * for a descending column, but `compareRows` ends `rowA.index - rowB.index` outside
   * that branch, and filtering and paging never renumber. So a rank-ascending `data`
   * array is the tie-break in both directions.
   *
   * DIVERGENCE, recorded in CONTRACT.md §(g): generate.py's sign is inverted and opens
   * the table ascending while writing `aria-sort="descending"`. The port corrected the
   * sign; row order, `aria-sort` and the arrow now derive from one `desc` boolean.
   *
   * `zoneViews` already returns this order, so the sort is a no-op today; it is written
   * out so a change to `zoneViews` cannot silently take the tie-break away. `cmp`, not
   * subtraction: `Infinity - Infinity` is `NaN`.
   */
  const tableData = views.slice().sort((a, b) => cmp(rankKey(a), rankKey(b)));

  /**
   * The global filter: name, route names, flag keys. A `searchFn` because `routeNames`
   * is not a column. It runs once per SEARCHABLE column per row, OR-ed, so every column
   * but Zone is `searchable: false`. Assigned once: the component memoises on function
   * identity. The component does not trim `searchTerm`.
   */
  const searchMatches = (_value, term, view) => {
    const f = term.trim().toLowerCase();
    if (!f) return true;
    return `${view.name} ${view.routeNames.join(' ')} ${view.flags.join(' ')}`
      .toLowerCase().includes(f);
  };

  /** True once `wa-data-grid` has upgraded and `wireGrid` has run. */
  let gridReady = false;

  /**
   * `#s-tableinfo`, the page's one count. The component's own pager prints a bare
   * "1–100 of 237" in a span with no CSS part, so `part="footer"` is hidden wholesale in
   * styles.css. `page` is reset by a watcher on the next update, so every caller reaches
   * here through `updateComplete`.
   */
  function tableInfo() {
    const grid = $('s-table');
    const info = $('s-tableinfo');
    if (!grid || !info || !gridReady) return;
    const total = grid.filteredCount;
    const start = paged ? grid.page * TABLE_PAGE : 0;
    info.textContent = paged
      ? `Showing ${num(start + 1)}–${num(Math.min(start + TABLE_PAGE, total))}`
        + ` of ${num(total)}`
      : `${num(total)} ${s4Plural(total, 'zone')}`;
  }

  /**
   * The external pager, a `wa-pagination format="compact"`. BUILT ONCE and mutated
   * thereafter: the component restores focus to the current page item in `updated()`,
   * before `wa-page-change` fires, so re-creating it from its own handler would drop
   * focus to `<body>`. Setting `page` programmatically does not re-emit the event.
   * `wa-pagination` counts pages from 1 and `wa-data-grid` from 0, hence the `± 1`.
   */
  function syncPager() {
    const pager = $('s-pager');
    const grid = $('s-table');
    if (!pager || !grid || !paged || !gridReady) return;
    const total = grid.filteredCount;
    let pg = pager.querySelector('wa-pagination');
    if (!pg) {
      pager.innerHTML = el('wa-pagination', '', {
        total,
        pageSize: TABLE_PAGE,
        page: grid.page + 1,
        format: 'compact',
        label: 'Zone table pages',
      });
      pg = pager.querySelector('wa-pagination');
      pg.addEventListener('wa-page-change', (e) => {
        grid.page = e.detail.page - 1;
        void grid.updateComplete.then(() => { tableInfo(); syncPager(); });
      });
    } else {
      pg.total = total;
      pg.pageSize = TABLE_PAGE;
      pg.page = grid.page + 1;
    }
    page = grid.page;
  }

  /**
   * The selected row's tint. `selectable` stays `none`: `single` would add a checkbox
   * column and rebind Space. With selection off the row template still stamps
   * `data-selected`, which the component paints, and the `selectedKeys` setter never
   * dispatches `wa-row-select`, so there is no feedback loop. `aria-selected` is gated
   * on selection being enabled and is not written; the rail announces selection.
   */
  function syncTableSelection() {
    const grid = $('s-table');
    if (!grid || !gridReady) return;
    grid.selectedKeys = selected ? [selected] : [];
  }

  /**
   * Hand the grid its columns, rows and opening sort ONCE, after it upgrades. `sort`
   * and `selectedKeys` are plain accessors, not reactive properties: assigning one
   * before upgrade creates an own property that shadows the accessor for good, and the
   * opening sort would silently never apply. `buildInstance` runs once per root, so the
   * listeners are bound once.
   */
  function wireGrid() {
    const grid = $('s-table');
    if (!grid || destroyed) return;

    grid.columns = COLUMNS;
    grid.searchFn = searchMatches;
    grid.data = tableData;
    grid.paginate = paged;
    grid.pageSize = TABLE_PAGE;
    /* one option, so the component's rows-per-page <wa-select> never renders */
    grid.pageSizeOptions = [TABLE_PAGE];
    /* restore the mirror `syncPager` and the `#s-filter` handler keep; the grid clamps
       `page` and a non-empty `searchTerm` resets it, so neither can strand */
    grid.page = page;
    grid.searchTerm = filter;

    gridReady = true;

    /* best zones first, `aria-sort="descending"` on Score, arrow down: one `desc` for all three */
    grid.sort = [{ id: 'score', desc: true }];
    syncTableSelection();

    /* `wa-cell-click` fires on a pointer click and on Enter on the focused cell. Rows
       are keyed by `row-key`, so the focused cell survives the repaint. */
    grid.addEventListener('wa-cell-click', (e) => select(e.detail.row.id));

    /* sorting does not reset the page by itself; the old header handler did */
    grid.addEventListener('wa-sort-change', () => {
      grid.page = 0;
      void grid.updateComplete.then(() => { tableInfo(); syncPager(); });
    });

    /* the only `wa-page-change` the grid itself emits is the reset a search causes */
    grid.addEventListener('wa-page-change', () => {
      void grid.updateComplete.then(() => { tableInfo(); syncPager(); });
    });

    void grid.updateComplete.then(() => { tableInfo(); syncPager(); });
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Controls
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * One mutually-exclusive option row: a `wa-radio-group` of button-appearance radios,
   * as `s4ChipGroup` (render/deck.js) builds. Not reused because it cannot disable an
   * option, and a dead radius or category shown disabled-with-reason is the point.
   * The reasons are PRINTED, not put in a `title`: a disabled control is not focusable,
   * so a tooltip on it is reachable by pointer hover and nothing else.
   *
   * @param {string} groupId @param {string} label
   * @param {ReadonlyArray<{value:string,text:string,usable:boolean,why:string}>} items
   * @param {string} value @param {(v: string) => void} onPick
   * @returns {string} the markup; the caller writes it and binds the group
   */
  function optionGroup(groupId, label, items, value, onPick) {
    const radios = items.map((it) => el('wa-radio', join(
      esc(it.text),
      it.usable ? '' : waIcon('ban', { label: 'unavailable' }),
    ), {
      value: it.value,
      appearance: 'button',
      size: 's',
      disabled: it.usable ? null : true,
    })).join('');
    const why = items.filter((it) => !it.usable && it.why).map((it) => el(
      'p',
      join(el('b', esc(it.text)), esc(`— ${it.why}`)),
      { className: 'wa-caption-xs wa-color-text-quiet' },
    )).join('');
    optionBind = { groupId, onPick };
    return join(
      el('wa-radio-group', radios, {
        id: groupId,
        name: groupId,
        size: 's',
        orientation: 'horizontal',
        label,
        value: value || null,
        className: 'wa-visually-hidden-label',
      }),
      why ? el('div', why, { className: 'wa-stack wa-gap-3xs' }) : '',
    );
  }

  /**
   * The per-mode option row, plus the keyboard path to the seeker: clicking the canvas
   * and dragging the marker are pointer-only, so the button seeds the seeker at the
   * round-start station, from where the marker is focusable and the arrow keys nudge it.
   */
  function optionChips() {
    const host = $('s-opts');
    if (!host) return;
    optionBind = null;

    /* clustered, not stacked: a full-bleed button reads as the card's primary action */
    const seedButtonHtml = mode === 'thermo'
      ? waButton(`Run the leg from ${hubName} to the selected zone`, {
        size: 's', appearance: 'outlined', dataSeed: 'leg',
      })
      : (MODE_NEED[mode] ? waButton(`Place the seekers at ${hubName}`, {
        size: 's', appearance: 'outlined', dataSeed: 'seeker',
      }) : '');
    const seed = seedButtonHtml
      ? el('div', seedButtonHtml, { className: 'wa-cluster wa-gap-2xs' })
      : '';

    let options = '';
    if (mode === 'radar') {
      options = optionGroup(
        's-radius',
        'Radar radius',
        (chips.radar || []).map((r) => ({
          value: String(r.miles), text: r.label, usable: r.usable, why: r.why,
        })),
        String(opt.radar),
        (v) => { opt.radar = Number(v); paint(); },
      );
    } else if (mode === 'match' || mode === 'measure' || mode === 'tentacle') {
      options = optionGroup(
        's-category',
        'Category',
        (chips[mode] || []).map((c) => ({
          value: c.key, text: `${c.label} (${num(c.count)})`, usable: c.usable, why: c.why,
        })),
        opt.cat || '',
        (v) => { opt.cat = v; paint(); },
      );
    }

    host.innerHTML = join(seed, options);

    const seedButton = host.querySelector('[data-seed]');
    if (seedButton) {
      seedButton.addEventListener('click', () => {
        const h = report.hub || {};
        if (h.lat === undefined || h.lon === undefined) return;
        if (seedButton.dataset.seed === 'leg') {
          const v = byId.get(selected);
          thermoA = { lat: h.lat, lon: h.lon };
          thermoB = { lat: v.lat, lon: v.lon };
          drawLeg();
        } else {
          seeker = { lat: h.lat, lon: h.lon };
          /* focus follows the marker the button just created */
          const node = placeSeeker();
          if (node) node.focus();
        }
        paint();
      });
    }
    if (optionBind) {
      const group = host.querySelector(`#${optionBind.groupId}`);
      const { onPick } = optionBind;
      // Not re-rendered on a pick: the group owns the checked state, and a rebuild
      // would throw away a keyboard user's focus.
      if (group) group.addEventListener('change', () => { if (group.value) onPick(group.value); });
    }
  }

  /**
   * Recompute and redraw everything the current question touches. NOTHING IS EVER
   * REMOVED: elimination is a colour partition plus a survival percentage, because the
   * rulebook eliminates zones from a *seeker's* map, not from the hider's options.
   *
   * The rail and the grid are not rebuilt here: they read only `views`, `selected` and
   * the table's own state, and every mutation of those re-renders them itself.
   * Reassigning `data` would rebuild every row model and reset the indices the
   * tie-break rides on, so `data` is assigned exactly once, in `wireGrid`.
   */
  function paint() {
    computeAnswers();
    repaintMarkers();
    updateCircle();
    renderReadout();
  }

  /** The one way the selection ever changes — the rail, the table and the map agree. */
  function select(id) {
    if (!id || !byId.has(id)) return;
    selected = id;
    updateCircle();
    renderList();
    renderDossier();
    syncTableSelection();
    repaintMarkers();
    /* on a phone the dossier is below the rail, so a tap otherwise looks like a no-op */
    if (window.matchMedia('(max-width: 920px)').matches) {
      const detail = $('s-detail');
      if (detail) detail.scrollIntoView({ block: 'start' });
    }
  }

  // ── one-time bindings ──────────────────────────────────────────────────────

  /* `#s-modes` is a `wa-radio-group`: the checked state is the group's own, and a dead
     mode is unreachable by arrow key as well as by pointer */
  const modeGroup = $('s-modes');
  if (modeGroup) {
    modeGroup.addEventListener('change', () => {
      if (!modeGroup.value || modeGroup.value === mode) return;
      mode = modeGroup.value;
      /* entering the thermometer starts a fresh leg; the other modes share one seeker */
      if (mode === 'thermo') { thermoA = null; thermoB = null; drawLeg(); }
      optionChips();
      paint();
    });
  }

  const filterInput = $('s-filter');
  if (filterInput) {
    filterInput.value = filter;
    filterInput.addEventListener('input', () => {
      filter = filterInput.value;
      const grid = $('s-table');
      if (!grid || !gridReady) return;
      /* setting `searchTerm` behaves like typing in the component's own box (page reset,
         active cell clamped) but does NOT emit `wa-filter-change`, so the count and the
         pager are refreshed from here */
      grid.searchTerm = filter;
      void grid.updateComplete.then(() => { tableInfo(); syncPager(); });
    });
  }

  /* "Show on the map" on the hero's pick card — the only server-rendered control that
     drives client selection state, so it goes through select() like everything else. */
  root.querySelectorAll('[data-zone]').forEach((b) => b.addEventListener('click', () => {
    select(b.dataset.zone);
    const zones = $('s-zones');
    if (zones) zones.scrollIntoView();
  }));

  // ── boot, in the CLI's order (generate.py) ─────────────────────
  optionChips();
  renderList();
  renderDossier();
  void customElements.whenDefined('wa-data-grid').then(wireGrid);
  paint();
  drawMap();

  return {
    root,
    resize() { if (map) map.resize(); },
    destroy() {
      destroyed = true;
      if (themeMedia) themeMedia.removeEventListener('change', retheme);
      if (themeObserver) themeObserver.disconnect();
      for (const m of markers) m.marker.remove();
      markers = [];
      if (seekerMarker) { seekerMarker.remove(); seekerMarker = null; }
      if (map) { map.remove(); map = null; }
      const panel = document.getElementById('tt');
      if (panel) panel.style.display = 'none';
    },
  };
}
