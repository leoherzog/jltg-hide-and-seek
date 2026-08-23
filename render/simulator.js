// render/simulator.js — the secret hider's guide, after it is on the page.
//
// Ported from generate.py S5's page script:
//   _S5_STRATEGY_JS       15108  — the whole client twin, verbatim below:
//                                    hav / band / nearestIn      15150–14940
//                                    answerFor                   15161–14992
//                                    drawMap / ring / addBorder  15268–15060
//                                    placeSeeker / paint         15310–15098
//                                    readout                     15375–15120
//                                    renderList                  15405–15170
//                                    select / renderDossier      15471–15270
//                                    tableRows / renderTable     15570–15334
//                                    optionChips + the bindings  15337–15405
//
// WHAT THIS FILE IS. `render/strategy.js` prints the guide; this file makes it move.
// The interesting half is the simulator: the rulebook says a seeker asks a question
// and the hider must answer truthfully, and `rules/audit.js`'s `survivalFractions`
// answers it for a *sample* of seekers to score a zone. This runs the identical
// arithmetic for exactly **one** seeker — the one the reader just dropped on the map —
// so the colour partition on screen is the same computation the score came from, with
// the sample size set to one. That is why the maths below is a transcription and not
// an approximation: a reader checking the page against the rulebook will check this.
//
// WHERE IT DELIBERATELY LEAVES THE CLI BEHIND. Three places where `generate.py`'s page
// script did not agree with `rules/audit.js`, and therefore did not agree with the
// rulebook: measuring anchored BOTH distances on the seeker's nearest feature; the
// tentacle mode never tested the hider's own distance and so could never return the
// rulebook's "not within reach"; and the tentacle reach was one number per game size
// when a LARGE deck holds a 1-mile family and a 15-mile family at once. All three are
// corrected below and each is marked DIVERGENCE, so that AGENTS.md's rule — a JS/Python
// disagreement is a JS bug — does not misread them as regressions.
//
// WHY IT RECOMPUTES INSTEAD OF READING AN ANSWER MATRIX. `worker.js:461–477`
// builds `signatures` and `surv` as worker-local consts and never posts them. It does
// not need to: the CLI's simulator never consumed them either (its `#zdata` carries no
// answer matrix), because a seeker the reader placed a second ago is not in any
// precomputed sample. Everything here comes out of `state.report` in memory —
// `geo.pois` via `poiCategories()`, zone centres via `zoneViews()` — which is also why
// the guide ships no `<script type="application/json">` block of its own.
//
// THE ONE STRUCTURAL DIFFERENCE FROM THE CLI. The CLI has one document per page and
// can bind to bare ids at parse time. The browser port has both pages in one document
// and a view that is mounted once and then hidden, so every id here is namespaced
// `s-` (see the DOM contract in the spec), the wiring is idempotent, and the reader's
// mode, selection, sort, filter and page all survive leaving and re-entering the view.
//
// DOM DISCIPLINE. This is the only module under `render/` that mutates the DOM, and it
// does it the way `initDeckTables` (`render/deck.js:1840`) does: markup is built with
// the sanctioned helpers in `./html.js`, never with hand-rolled strings, and every
// number goes through a formatter from `../lib/core.js`. No `toFixed`, no `Intl`, no
// clock, no randomness, and no unsorted iteration of anything.
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
  TABLE_PAGE, TABLE_PAGE_ABOVE, MAX_MAP_ZONES,
} from './strategy.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Presentation constants
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The instruction each seeker mode prints until it has what it needs
 * (generate.py:15106–15109). `explore` needs nothing and never reaches here.
 */
const MODE_NEED = Object.freeze({
  radar: 'Click the map to place the seekers, or use the button above.',
  match: 'Click the map to place the seekers, or use the button above.',
  measure: 'Click the map to place the seekers, or use the button above.',
  tentacle: 'Click the map to place the seekers, or use the button above.',
  thermo: 'Click the map twice — the start of the leg, then the end — or use the button above.',
});

/**
 * Arrow key → [Δlatitude, Δlongitude] in degrees, before the cosine correction.
 *
 * ~55 m a press, ~550 m with shift held: a fraction of the smallest rulebook radius
 * (a quarter mile is 402 m) and a walk between two questions respectively. Degrees
 * rather than metres because the seeker is stored as a lat/lon pair and the map is
 * the only thing that would convert.
 */
const NUDGE_DEG = Object.freeze({
  ArrowUp: Object.freeze([0.0005, 0]),
  ArrowDown: Object.freeze([-0.0005, 0]),
  ArrowLeft: Object.freeze([0, -0.0005]),
  ArrowRight: Object.freeze([0, 0.0005]),
});

/**
 * The answer partition, as an icon **and** a word.
 *
 * `--q-edge` measures 2.07:1 against the page surface and cannot carry a signal by
 * itself (html.js:447 states the rule); every colour on the map is therefore repeated
 * as a word in the readout chip.
 * @type {Object<string, [string, string, string]>}  answer → [word, variant, icon]
 */
const ANSWER_TEXT = Object.freeze({
  yes: Object.freeze(['mostly yes', 'success', 'circle-check']),
  no: Object.freeze(['mostly no', 'danger', 'circle-xmark']),
  edge: Object.freeze(['mostly on the edge', 'warning', 'scale-balanced']),
  un: Object.freeze(['no answer yet', 'neutral', 'circle-question']),
});

/**
 * The same partition in tentacle words.
 *
 * A tentacle answer is never yes or no: it is the NAME of a location, or — rulebook,
 * `seeking/tentacle_questions` — "If the hider is not within reach of the tentacle
 * question, they may simply answer that they are not within reach." Same three keys,
 * same variants and icons as `ANSWER_TEXT` so the colours cannot drift apart; only the
 * words differ, because the word is the channel a reader who cannot see the colour gets.
 * @type {Object<string, [string, string, string]>}
 */
const TENTACLE_TEXT = Object.freeze({
  yes: Object.freeze(['mostly a name in reach', 'success', 'circle-check']),
  no: Object.freeze(['mostly not within reach', 'danger', 'circle-xmark']),
  edge: Object.freeze(['mostly on the edge', 'warning', 'scale-balanced']),
  /* NOT "no answer yet": by the time this chip is drawn a category is selected and a
     seeker is placed, so `un` here can only be the engine's class `-2` — the seekers
     named a category with nothing inside their own circle, and "there is nothing to
     name" is an answer every in-reach zone gives alike. See `majorityGroup`. */
  un: Object.freeze(['mostly nothing in reach to name', 'neutral', 'circle-question']),
});

/**
 * Score bands and answers share the fallback circle layer when a map is too big for
 * label pills, so their keys are namespaced before they meet in one `match`
 * expression: `b:` is a score band, `a:` is an answer. `un` means different things on
 * the two sides and must never collide.
 * @type {Array<[string, string]>}  key → the CSS custom property that colours it
 */
const DOT_COLOUR = Object.freeze([
  Object.freeze(['b:top', '--gold-mark']),
  Object.freeze(['b:good', '--accent']),
  /* `fair` is its own step, as `generate.py:15526` gives it — collapsing it onto
     `good`'s colour rendered a five-band scale in three colours */
  Object.freeze(['b:fair', '--warn']),
  Object.freeze(['b:weak', '--off']),
  Object.freeze(['b:un', '--off']),
  Object.freeze(['a:yes', '--q-yes']),
  Object.freeze(['a:no', '--q-no']),
  Object.freeze(['a:edge', '--q-edge']),
  Object.freeze(['a:un', '--q-un']),
]);

/** The eleven table columns, in the order `data-sort` numbers them (generate.py:14690). */
const SORT_RANK = 0;
const SORT_NAME = 1;
const SORT_SCORE = 2;
const SORT_AXIS_FIRST = 3;
const SORT_AXIS_LAST = 8;
const SORT_FLAGS = 9;
const SORT_TRAVEL = 10;

// ═══════════════════════════════════════════════════════════════════════════════
// Module-level helpers (pure, or DOM-generic)
// ═══════════════════════════════════════════════════════════════════════════════

/** One resolved design token, for the MapLibre paint properties a canvas cannot inherit. */
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * A closed ring of `[lon, lat]` pairs approximating a circle, for the border outline
 * and the selected zone's true-radius disc. Ports `ring`, generate.py:15021.
 *
 * The metres-per-degree constants are S5's own (111320 on both axes). `buildMap` in
 * app.js uses 111132 for latitude, which is the better figure, but the two differ by
 * 0.17 % — under a metre at a quarter-mile radius — and this is a transcription.
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

/** A GeoJSON `Feature` wrapper, so the four `setData` calls below read as one thing. */
function feature(geometry, properties = {}) {
  return { type: 'Feature', properties, geometry };
}

/**
 * The hover panel.
 *
 * MapLibre markers are DOM nodes MapLibre owns, outside every shadow root, and a map
 * feature is canvas rather than DOM — so `wa-tooltip`, which anchors to an element,
 * cannot be used (styles.css:210 records the reason). `#tt` is the page's existing
 * one-off panel; this is a local ten-line binder rather than a call into app.js's
 * `bindTT`, because that function lives inside `PAGE_RUNTIME_JS`, a verbatim port of
 * the CLI's page JS that must stay one and never learn that this view exists.
 *
 * `htmlFor` is a *function*: markers are built once and repainted in place, so the
 * tip has to read the current mode and answer rather than a string captured at build.
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

/** `rank` sorts nulls last, in the table and in every tie-break (generate.py:15288). */
function rankKey(view) {
  return view.rank === null || view.rank === undefined ? Infinity : view.rank;
}

// ═══════════════════════════════════════════════════════════════════════════════
// The live instance
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The one wired view, or null.
 *
 * State lives here rather than in the DOM for the same reason `DECK_STATE` does
 * (deck.js:1487): the reader's mode, selection, sort, filter and page must survive
 * leaving the view, and re-entering must not rebuild anything. It also gives the
 * MapLibre instance an owner — `buildMap` (app.js:2434) has no teardown and leaks a
 * `Map` plus two theme listeners every time §05 is re-rendered, which is exactly the
 * bug this file's idempotence contract exists to avoid.
 * @type {{root: HTMLElement, resize: () => void, destroy: () => void}|null}
 */
let instance = null;

/**
 * Wire the whole secret view: the map, the six question modes, the ranked rail, the
 * dossier, and the sortable/filterable table. IDEMPOTENT.
 *
 * First call: builds everything, including the MapLibre instance. Later calls with
 * the same `root`: resize the map and return — nothing is rebuilt, no listener is
 * added twice, and every scrap of reader state survives. A call with a different
 * `root` tears the previous instance down first.
 *
 * MUST be called only when `root` is visible and laid out: MapLibre reads its
 * container size once, at construction (html.js:242–245). app.js guarantees this by
 * flipping `body[data-view="strategy"]` before calling.
 *
 * Never throws: MapLibre's dynamic import is wrapped and the map degrades to hidden,
 * which the map caption already warns about.
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
 * Everything above, once.
 *
 * One long closure rather than a class: every piece — `answerFor`, `paint`, the rail,
 * the dossier, the table — reads the same eight variables, and the CLI's script is
 * one closure for exactly that reason. Splitting it would mean threading a context
 * object through thirty functions to buy nothing.
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
   * Category key → THAT tentacle question's own reach, in metres.
   *
   * Never one `REACH_M` per game size from `size.tentacleReachMi`, which is what this
   * used to do and what it measured every tentacle question against. The rulebook does
   * not work that way: it lists Museums / Libraries / Movie Theaters /
   * Hospitals **Within 1 Mile**, and then "For LARGE Sized Games, Add the Following:
   * Metro Lines Within 15 Miles / Zoos … / Aquariums … / Amusement Parks Within 15
   * Miles" — so a LARGE deck asks both, and one number misstates half of it. The engine
   * has always read the per-question `param` (`rules/audit.js:980`); `modeChips` now
   * carries the same figure as `reachMi`, so this side reads it too.
   * `size.tentacleReachMi` is left alone — it is still the deck's headline number.
   */
  const tentacleReachM = new Map((chips.tentacle || [])
    .map((c) => [c.key, (Number(c.reachMi) || 0) * M_PER_MILE]));
  const HIDING_MIN = Number(size.hidingPeriodMin) || 0;
  const hubName = (report.hub && report.hub.name) || 'the hub';
  const imperial = s4Imperial(report);
  const mapLabels = views.length <= MAX_MAP_ZONES;
  const paged = views.length > TABLE_PAGE_ABOVE;

  // ── reader state (generate.py:14908–14916) ─────────────────────────────────
  let mode = 'explore';
  /* the first dossier zone, but only if it is one we can actually show; a zoneId in
     `dossierZoneIds` with no `ZoneScore` would otherwise leave `selected` naming a zone
     `byId` does not hold, and the dossier with nothing to render. */
  const opening = (report.dossierZoneIds || []).find((id) => byId.has(id));
  let selected = opening || (views[0] && views[0].id) || null;
  let seeker = null;
  let thermoA = null;
  let thermoB = null;
  /* The initial radius is the first usable one-mile chip, else the first usable chip,
     else one mile — a dead radar map still opens on a legible number. */
  const usableRadar = (chips.radar || []).filter((r) => r.usable);
  const opt = {
    radar: (usableRadar.find((r) => r.miles === 1) || usableRadar[0] || { miles: 1 }).miles,
    cat: null,
  };
  let sortCol = SORT_SCORE;
  let sortDir = -1;
  let page = 0;
  let filter = '';
  /* `optionGroup` builds markup but cannot bind it — the nodes do not exist until the
     caller writes them — so it leaves the group id and its handler here. */
  let optionBind = null;

  /** zoneId → the current answer, refreshed by `computeAnswers` before every paint. */
  const answers = new Map();
  /** zoneId → the tentacle feature whose name the hider would have to say. */
  const tentacleNames = new Map();
  /**
   * zoneId → the IDENTITY of that feature, `lon,lat`, which is what decides whether
   * two zones gave the same answer. Never group by the name: `rules/audit.js`'s
   * `survivalFractions` classes a zone by `flat.owner`, the feature's own index, so two
   * branches both called "Kent District Library" are two answers, and a feature with no
   * `name` tag at all is not the same answer as every other unnamed one.
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
   * The three-valued answer for a signed distance past a boundary, in metres.
   *
   * NOT a boolean, and the tolerance is exactly one zone radius: `edge` means the
   * boundary passes through the zone's own rulebook circle, so the honest answer
   * depends on where inside it the hider is standing. This is the single most
   * important line in the port (generate.py:14929).
   *
   * @param {number} delta @returns {'yes'|'no'|'edge'}
   */
  function bandOf(delta) {
    if (Math.abs(delta) <= RAD) return 'edge';
    return delta < 0 ? 'yes' : 'no';
  }

  /**
   * The nearest feature of a category to a point, and by how much it wins.
   *
   * `margin` is second-nearest minus nearest: when it is inside two zone radii, a
   * different feature could win from elsewhere in the same circle, which is what
   * turns a matching or tentacle answer into an `edge`. Ports `nearestIn`,
   * generate.py:14931. Features are `[lon, lat, name]` — lon first.
   *
   * @param {string} cat @param {number} lat @param {number} lon
   * @returns {{feature: Array, d: number, margin: number}|null}
   */
  function nearestIn(cat, lat, lon) {
    const c = poi.categories && poi.categories[cat];
    if (!c || !c.features || !c.features.length) return null;
    let best = null;
    let bd = Infinity;
    let second = Infinity;
    for (const f of c.features) {
      const d = haversineM(lat, lon, f[1], f[0]);
      if (d < bd) { second = bd; bd = d; best = f; } else if (d < second) { second = d; }
    }
    return { feature: best, d: bd, margin: second - bd };
  }

  /**
   * What this zone's hider would have to answer, for the question the reader has
   * loaded and the seeker they have placed. Ports `answerFor`, generate.py:14942.
   *
   * `explore` is the odd one out and returns a *score* band, not an answer; every
   * other mode returns `yes` / `no` / `edge` / `un`, and `un` means "the question
   * cannot be asked yet", never "no". In the tentacle mode `no` is the rulebook's
   * "not within reach" — see that branch — which is why nothing prints these keys raw.
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
      /* Two nearest-feature lookups, not one. Calling `nearestIn` once on the seeker and
         measuring BOTH sides to that one feature — which this used to do — answers "how
         far are you from the seekers' nearest park", a question nobody asked. The rulebook's measuring
         question is "Compared to me, are you closer to or further from ____?", and each
         player measures to the instance nearest THEM: "If you are in a large park, a
         mile from the park icon, you might have to say you are a mile away from any
         park despite the fact that you are in a park." Two independent nearest-feature
         distances, which is exactly what the engine compares — `osm_distance`
         (rules/audit.js:727) stores each zone's OWN nearest distance and `survMeasuring`
         (:851) ranks those against the seeker's. */
      const mine = nearestIn(opt.cat, seeker.lat, seeker.lon);
      const theirs = nearestIn(opt.cat, view.lat, view.lon);
      if (!mine || !theirs) return 'un';
      /* `edge` still means what it means everywhere else: the nearest-feature distance
         is 1-Lipschitz in the hider's position, so anywhere inside the rulebook circle
         it can move by up to one radius — and inside that band the honest answer really
         does depend on where in the circle the hider is standing. It is also where the
         engine's third class lives: a zone level with the seeker answers neither closer
         nor further (`measuring_ties_are_their_own_answer`). */
      return bandOf(theirs.d - mine.d);
    }

    if (mode === 'tentacle') {
      /* The FEATURE reach anchors on the seekers — "Within ___ miles of me, which ___
         are you nearest to?" — so a target well outside the hider's zone can still be
         the name they have to give. But the question does not stop there. It ends
         "(You must also be within ___ miles)", and the rulebook spells the consequence
         out: "If the hider is not within reach of the tentacle question, they may
         simply answer that they are not within reach."

         Filtering only the features and then returning `edge` or `yes` for every zone —
         which this used to do — left that rulebook answer unreachable in the shipped
         tool. The engine has always had it — `rules/audit.js:999` classes an
         out-of-reach zone `-1`, its own class, and `s3Answer` (:1073) prints "not
         within reach" — and this is that class: `no`, distinct from both in-reach
         groups, which is what the map legend's `--q-no` "out of reach" already promised.

         The reach ring gets the same treatment as every other boundary on this page: a
         hider whose circle straddles it answers one way from one half of it and the
         other way from the other half, which is `edge`. */
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
      /* in reach of the seekers, but the seekers named a category with nothing inside
         their own circle — there is no name to give (the engine's class `-2`) */
      if (!inReach.length) return 'un';
      let best = null;
      let bd = Infinity;
      let second = Infinity;
      for (const f of inReach) {
        const d = haversineM(view.lat, view.lon, f[1], f[0]);
        if (d < bd) { second = bd; bd = d; best = f; } else if (d < second) { second = d; }
      }
      tentacleNames.set(view.id, best ? best[2] : null);
      tentacleFeatures.set(view.id, best ? `${best[0]},${best[1]}` : '');
      if (reachBand === 'edge') return 'edge';
      /* two names within a circle's width of each other ⇒ which one is nearest depends
         on where in the circle the hider stands */
      return second - bd <= 2 * RAD ? 'edge' : 'yes';
    }
  }

  /**
   * The biggest set of zones whose answer is IDENTICAL, and the words for it.
   *
   * This is the readout's survival number, and it is the same quantity the score is
   * built from: `survivalFractions` averages the size of the hider's own answer class
   * over a sample of seekers, and here the sample is the one seeker on the map.
   *
   * `edge` is never a group — its zones have no decided answer to share. Tentacles are
   * why this cannot be `max(yes, no)`: the in-reach zones do NOT all say the same
   * thing, they each name a feature, so the `yes` colour is really one group per
   * FEATURE, exactly as `rules/audit.js:1016` counts them. The out-of-reach zones, by
   * contrast, all give one and the same answer and are frequently the largest group.
   *
   * @param {{yes:number,no:number,edge:number,un:number}} tally
   * @returns {{size: number, word: string}}
   */
  function majorityGroup(tally) {
    if (mode !== 'tentacle') return { size: Math.max(tally.yes, tally.no), word: '' };
    let best = { size: tally.no, word: 'not within reach' };
    /* `un` is a third real group here, not a gap: it is the engine's class `-2`
       (`rules/audit.js`, `survTentacle`) — the seekers named a category with nothing
       inside their own circle, so every zone that IS in reach gives the identical
       answer "there is nothing to name". Only the tentacle mode can hold a partial
       `un`; every other mode's `un` is all-or-nothing and `renderReadout` has already
       returned by then. Leaving it out reported 0% survival on a map where every zone
       agreed. */
    if (tally.un > best.size) best = { size: tally.un, word: 'nothing in reach to name' };
    /* Keyed by feature identity, not by name — see `tentacleFeatures`. Grouping by name
       merged every unnamed feature into one bogus group and reported survival over a set
       of zones that do not share an answer. */
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
   * One zone's current answer, in the words that answer is actually given in.
   *
   * Only the tentacle mode needs the translation, and it needs it badly: `no` there is
   * the rulebook's "not within reach", not a plain no, and a marker tip that said "no"
   * would be telling the reader the opposite of what their hider would say.
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
    for (const [key, token] of DOT_COLOUR) expr.push(key, cssVar(token) || '#7a8899');
    expr.push(cssVar('--off') || '#a49f92');
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
   * them rather than losing them — `buildMap`'s pattern (app.js:2497). Every id is
   * prefixed `s-` so nothing can collide with the network map's `border` / `stops` /
   * `zonedots`, which live in the same document.
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
        'line-color': cssVar('--gold-deep') || '#a97b00',
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
      paint: { 'fill-color': cssVar('--accent') || '#2a78d6', 'fill-opacity': 0.1 },
    });
    map.addLayer({
      id: 's-zonering',
      type: 'line',
      source: 's-zone',
      paint: { 'line-color': cssVar('--accent') || '#2a78d6', 'line-width': 1.5 },
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
        'line-color': cssVar('--q-edge') || '#e0a000',
        'line-width': 2,
        'line-dasharray': [2, 1],
      },
    });

    /* Above MAX_MAP_ZONES the label pills stop being readable and start being a
       performance problem, so the partition is drawn as plain dots instead. The CLI
       drew nothing at all at that size (generate.py:15079); a coloured dot is still
       the answer, and it is the same answer. */
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
          'circle-stroke-color': cssVar('--wa-color-surface-default') || '#ffffff',
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
   * Build one marker per zone, once.
   *
   * The CLI removes and recreates all of them on every paint (generate.py:15076);
   * at MAX_MAP_ZONES that is 1,200 elements and 1,200 `Marker`s per click. They are
   * built here once and repainted in place instead, which is the same picture.
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
   * Repaint the partition.
   *
   * `data-band` and `data-answer` are mutually exclusive: explore sets the first and
   * clears the second, every question mode does the reverse, so no rule can ever see
   * a marker claiming both a score band and an answer.
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
   *
   * MapLibre gives a custom marker element no focusability of its own and drags it
   * with the pointer, so the node is made a real control here: `tabindex="0"`, a name,
   * and arrow keys that nudge it. Together with the "Place the seekers at …" button in
   * `#s-opts` that is the whole keyboard path — without it the readout below the map
   * asked for a click for ever and the simulator could not be operated at all.
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
      /* MapLibre's own keyboard handler is bound to the map container, which is this
         node's ancestor, and pans on the same four keys — without this the seeker and
         the viewport would both move on one press */
      ev.stopPropagation();
      /* a shifted nudge is ten times the step, which is how far a seeker walks
         between two questions rather than between two guesses */
      const scale = ev.shiftKey ? 10 : 1;
      /* longitude degrees shrink with latitude; scaling by cos keeps a horizontal
         nudge the same distance on the ground as a vertical one */
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

  /** Where a click on the map goes, per mode (generate.py:15013–15020). */
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
   * Construct the map.
   *
   * On any failure the container is hidden and everything else keeps working — the
   * rail, the dossier and the table need no map, and the map card's caption already
   * tells the reader that.
   */
  async function drawMap() {
    const host = $('s-map');
    if (!host) return;
    try {
      const ns = await import(MAPLIBRE_JS);
      /* ns.default ?? ns, never .default alone: maplibre-gl 6 ships named exports
         only and .default is undefined on the unpinned CDN URL (app.js:2444). */
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

  /** The lead phrase for the current question (generate.py:15113–15117). */
  function readoutLead() {
    const label = (poi.categories && poi.categories[opt.cat] && poi.categories[opt.cat].label)
      || opt.cat || 'feature';
    if (mode === 'radar') return `Within ${s4Val(opt.radar)} mi: `;
    if (mode === 'thermo') return 'Hotter (closer to the end of your leg): ';
    if (mode === 'match') return `Same nearest ${label}: `;
    /* NOT "that ${label}": there is no shared feature. Each side measures to the
       instance nearest itself, which is the whole point of the question. */
    if (mode === 'measure') return `Nearer their own ${label} than you are to yours: `;
    /* NOT "zones with an answer": every zone has one, and for most of them it is "I am
       not within reach". This counts the zones that must name something. */
    if (mode === 'tentacle') return `Within reach, and so having to name a ${label}: `;
    return '';
  }

  /**
   * The sentence under the map.
   *
   * The closing percentage is the client twin of `survivalFractions`: the share of the
   * whole field held by the largest group of zones giving the IDENTICAL answer (see
   * `majorityGroup`), with the edge zones in no group at all because their answer is
   * not decided. It is `aria-live="polite"`, so a reader who cannot see the colours
   * still gets every repaint read to them.
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
    /* `opt.cat` is shared by the three category modes, so it can arrive here naming a
       category this mode has no question for — a park is a matching and a measuring
       subject but never a tentacle one. The option row already shows nothing checked;
       without this the readout would report a field of zeroes as if it were an answer. */
    if ((mode === 'match' || mode === 'measure' || mode === 'tentacle')
      && !(chips[mode] || []).some((c) => c.key === opt.cat)) {
      host.textContent = 'Pick a category above.';
      return;
    }
    const total = views.length;
    const yes = counts.yes || 0;
    const no = counts.no || 0;
    const edge = counts.edge || 0;
    /* the dominant answer as a word, so the map's colours are never the only channel */
    let top = 'un';
    for (const k of ['yes', 'no', 'edge', 'un']) {
      if ((counts[k] || 0) > (counts[top] || 0)) top = k;
    }
    const words = mode === 'tentacle' ? TENTACLE_TEXT : ANSWER_TEXT;
    const [word, variant, icon] = words[top] || words.un;
    /* the tentacle mode's third answer is a real answer, not a gap in the map, so it is
       counted out loud rather than left to be inferred from the other two */
    const notInReach = mode === 'tentacle' && no
      ? `. ${el('b', num(no))} are not within reach of the seekers and simply say so`
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
   * The forty best zones, as a real listbox.
   *
   * `#s-list` is announced as a listbox, so it owes the reader the listbox
   * interaction model: exactly ONE tab stop (roving `tabindex`), Up/Down/Home/End
   * moving the selection, Enter/Space selecting. Selecting re-renders the rail, so
   * focus is captured before the rebuild and restored after it — otherwise the first
   * arrow press would drop focus to the body.
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

  /**
   * The travel sentence. DERIVED from metric R1, never re-measured: the guide must
   * never print a travel time the score did not use (generate.py:13989).
   */
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
        esc('No question on this map singles this zone out — which is the best thing a dossier can say.'),
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
        esc('No candidate legal endgame spot was found inside this circle. That is a real'
          + ' risk: the rulebook needs somewhere publicly accessible during every game hour.'),
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
   * Block 6 — service.
   *
   * Scope-reduced against the CLI, deliberately: the CLI's block is per-zone ×
   * per-day (first and last departure, a departure count and a 24-bin sparkline) and
   * reads `ServiceDay.stopDays`, which `daySummary` (worker.js:643) strips before
   * anything crosses `postMessage`. What is left is what was already scored — metrics
   * S1, S2 and S3 plus the frequent-stop count — and the block says which day that
   * was measured on rather than pretending the number is day-independent.
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

  /**
   * The eight blocks, in the order the scouting report needs them: what this zone is,
   * what betrays it, what it scored, and only then the metric rows behind every
   * number (generate.py:15262–15270).
   */
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
  // The full table
  // ═════════════════════════════════════════════════════════════════════════

  /** The sort key for one row under the current column (generate.py:15279–15286). */
  function sortKey(view) {
    if (sortCol === SORT_RANK) return rankKey(view);
    if (sortCol === SORT_NAME) return view.name.toLowerCase();
    if (sortCol === SORT_SCORE) return view.overall;
    if (sortCol >= SORT_AXIS_FIRST && sortCol <= SORT_AXIS_LAST) {
      return view.axes[AXIS_IDS[sortCol - SORT_AXIS_FIRST]];
    }
    if (sortCol === SORT_FLAGS) return view.flags.length;
    return view.travelMin === null || view.travelMin === undefined ? Infinity : view.travelMin;
  }

  /**
   * Filter, then sort. Ties always break on rank ascending, so the order is total.
   *
   * DIVERGENCE, deliberate, recorded in CONTRACT.md §(g). `generate.py:15288` reads
   * `if (ka < kb) return sortDir; if (ka > kb) return -sortDir;` with `sortDir = -1`,
   * which sorts ASCENDING — against its own comment ("everything else descends"), its
   * own `sortDir = (c === 1 ? 1 : -1)` intent, and the `aria-sort="descending"` it
   * writes two lines later (15317). So the CLI opens the table on the worst zones and
   * tells assistive tech the opposite. The sign is corrected here: `sortDir = -1` now
   * means descending in the rows AND in `aria-sort`. File it against generate.py.
   */
  function tableRows() {
    const f = filter.trim().toLowerCase();
    const rows = f
      ? views.filter((v) => `${v.name} ${v.routeNames.join(' ')} ${v.flags.join(' ')}`
        .toLowerCase().includes(f))
      : views.slice();
    return rows.sort((a, b) => {
      const c = cmp(sortKey(a), sortKey(b));
      if (c !== 0) return c * sortDir;
      return rankKey(a) - rankKey(b);
    });
  }

  /** One axis cell. An unmeasurable axis prints an em dash, never a scored-and-lost 0.0. */
  function axisCell(view, axis) {
    return el('td', view.axisMax[axis] ? num(view.axes[axis], 1) : '—');
  }

  /**
   * Rewrite the page of rows, the header's `aria-sort`, the count and the pager.
   *
   * A row opens a dossier, so it is a control: Enter and Space reach it the same way
   * the rail's rows do, and the focused row survives the re-render that selecting it
   * causes.
   */
  function renderTable() {
    const body = $('s-tbody');
    if (!body) return;
    const focusId = document.activeElement
      && body.contains(document.activeElement)
      && document.activeElement.dataset
      ? document.activeElement.dataset.id
      : null;

    const rows = tableRows();
    const pages = paged ? Math.max(1, Math.ceil(rows.length / TABLE_PAGE)) : 1;
    if (page > pages - 1) page = pages - 1;
    if (page < 0) page = 0;
    const start = paged ? page * TABLE_PAGE : 0;
    const slice = paged ? rows.slice(start, start + TABLE_PAGE) : rows;

    body.innerHTML = slice.map((v) => el('tr', join(
      el('td', v.rank === null ? '—' : num(v.rank)),
      el('td', esc(v.name)),
      el('td', num(v.overall, 1)),
      AXIS_IDS.map((a) => axisCell(v, a)).join(''),
      el('td', esc(v.flags.map((f) => (FLAG_TEXT[f] || [f])[0]).join(', '))),
      el('td', v.travelMin === null || v.travelMin === undefined ? '—' : mins(v.travelMin, 1)),
    ), { tabindex: '0', dataId: v.id, dataSel: v.id === selected || null })).join('');

    body.querySelectorAll('tr').forEach((tr) => {
      tr.addEventListener('click', () => select(tr.dataset.id));
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(tr.dataset.id); }
      });
    });
    if (focusId) {
      const again = body.querySelector(`tr[data-id="${CSS.escape(focusId)}"]`);
      if (again) again.focus();
    }

    /* the sort state was otherwise invisible: eleven identical headers, no indicator */
    root.querySelectorAll('#s-table thead th').forEach((th, i) => {
      th.setAttribute(
        'aria-sort',
        i === sortCol ? (sortDir > 0 ? 'ascending' : 'descending') : 'none',
      );
    });

    const info = $('s-tableinfo');
    if (info) {
      info.textContent = paged
        ? `Showing ${num(start + 1)}–${num(Math.min(start + TABLE_PAGE, rows.length))}`
          + ` of ${num(rows.length)}`
        : `${num(rows.length)} ${s4Plural(rows.length, 'zone')}`;
    }

    const pager = $('s-pager');
    if (!pager || !paged) return;
    /* the two buttons are recreated on every render, so they are re-bound on every
       render; a disabled end-stop is a control that says so rather than one that
       silently does nothing */
    pager.innerHTML = join(
      waButton('Previous', { id: 's-prev', disabled: page === 0 || null }),
      el('span', `Page ${num(page + 1)} of ${num(pages)}`, { className: 'wa-caption-s' }),
      waButton('Next', { id: 's-next', disabled: page >= pages - 1 || null }),
    );
    const prev = $('s-prev');
    const next = $('s-next');
    if (prev) prev.addEventListener('click', () => { if (page > 0) { page -= 1; renderTable(); } });
    if (next) {
      next.addEventListener('click', () => {
        if (page < pages - 1) { page += 1; renderTable(); }
      });
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Controls
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * One mutually-exclusive option row, as the native pair.
   *
   * A `wa-radio-group` of button-appearance radios, exactly as `s4ChipGroup`
   * (render/deck.js 259) builds the report's filter rows — the group carries the role,
   * the accessible label, arrow-key navigation and a real checked state, which a row
   * of `wa-button`s swapping `appearance` carried in fill colour alone. The helper
   * itself cannot be reused because it has no way to disable an option, and a dead
   * radius or category shown disabled-with-its-reason is the point of this row.
   *
   * The reasons are PRINTED, not put in a `title`: a disabled control is not
   * focusable, so a tooltip on one is reachable by hovering with a pointer and by
   * nothing else. "This map cannot ask that" is the most useful thing the guide can
   * say about a question, so it is said out loud.
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
   * The per-mode option row, plus the keyboard path to the seeker.
   *
   * The seeker is otherwise placed only by clicking the canvas or dragging its marker,
   * both pointer-only — which left every question mode permanently stuck on its "click
   * the map" prompt for anyone using a keyboard, i.e. the whole simulator unusable.
   * The button seeds it at the round-start station, which is also the most useful
   * opening guess; from there the marker itself is focusable and the arrow keys nudge
   * it (see `placeSeeker`).
   */
  function optionChips() {
    const host = $('s-opts');
    if (!host) return;
    optionBind = null;

    /* clustered, not stacked: `wa-stack` stretches its children, and a full-bleed
       button reads as the primary action of the card rather than a convenience */
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
          /* focus follows the thing the button just created, so the arrow keys the
             marker's label promises work without hunting for it */
          const node = placeSeeker();
          if (node) node.focus();
        }
        paint();
      });
    }
    if (optionBind) {
      const group = host.querySelector(`#${optionBind.groupId}`);
      const { onPick } = optionBind;
      // The group is NOT re-rendered on a pick: it owns the checked state itself, and
      // rebuilding it under a keyboard user would throw away their focus mid-row.
      if (group) group.addEventListener('change', () => { if (group.value) onPick(group.value); });
    }
  }

  /**
   * Recompute and redraw everything the current question touches.
   *
   * NOTHING IS EVER REMOVED. Elimination is expressed as a colour partition plus a
   * survival percentage; the rail and the table show the same zones in the same order
   * whatever question is loaded, because the rulebook eliminates zones from a
   * *seeker's* map, not from the hider's options.
   */
  function paint() {
    computeAnswers();
    repaintMarkers();
    updateCircle();
    renderReadout();
    renderList();
    renderTable();
  }

  /** The one way the selection ever changes — the rail, the table and the map agree. */
  function select(id) {
    if (!id || !byId.has(id)) return;
    selected = id;
    updateCircle();
    renderList();
    renderDossier();
    renderTable();
    repaintMarkers();
    /* on a phone the dossier is below the rail, so a tap otherwise looks like a no-op */
    if (window.matchMedia('(max-width: 920px)').matches) {
      const detail = $('s-detail');
      if (detail) detail.scrollIntoView({ block: 'start' });
    }
  }

  // ── one-time bindings ──────────────────────────────────────────────────────

  /* `#s-modes` is a `wa-radio-group`: the checked state is the group's own, so nothing
     here rewrites an appearance, and a dead mode is unreachable by arrow key as well
     as by pointer. */
  const modeGroup = $('s-modes');
  if (modeGroup) {
    modeGroup.addEventListener('change', () => {
      if (!modeGroup.value || modeGroup.value === mode) return;
      mode = modeGroup.value;
      /* entering the thermometer always starts a fresh leg; the other seeker modes
         share one seeker and keep it */
      if (mode === 'thermo') { thermoA = null; thermoB = null; drawLeg(); }
      optionChips();
      paint();
    });
  }

  root.querySelectorAll('#s-table [data-sort]').forEach((b) => b.addEventListener('click', () => {
    const c = Number.parseInt(b.dataset.sort, 10);
    if (!Number.isFinite(c)) return;
    /* alphabetical ascends, everything else descends — a new column should open on
       its most useful end */
    if (c === sortCol) sortDir = -sortDir;
    else { sortCol = c; sortDir = c === SORT_NAME ? 1 : -1; }
    page = 0;
    renderTable();
  }));

  const filterInput = $('s-filter');
  if (filterInput) {
    filterInput.value = filter;
    filterInput.addEventListener('input', () => {
      filter = filterInput.value;
      page = 0;
      renderTable();
    });
  }

  /* "Show on the map" on the hero's pick card — the only server-rendered control that
     drives client selection state, so it goes through select() like everything else. */
  root.querySelectorAll('[data-zone]').forEach((b) => b.addEventListener('click', () => {
    select(b.dataset.zone);
    const zones = $('s-zones');
    if (zones) zones.scrollIntoView();
  }));

  // ── boot, in the CLI's order (generate.py:15397–15405) ─────────────────────
  optionChips();
  renderList();
  renderDossier();
  renderTable();
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
