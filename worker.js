// ═══════════════════════════════════════════════════════════════════════════════
// worker.js — the pipeline orchestrator
// ═══════════════════════════════════════════════════════════════════════════════
//
// Ported from `build_report` (generate.py). The order below is the
// Python's dependency order and it is the contract between sections: nothing later
// may be needed by anything earlier. The one reordering is `travelTimeSamples`,
// which the CLI computes last but CONTRACT.md §(d) puts in the `'network'` stage
// payload; every input it needs (feed, days, zones, origin, departure) exists by
// then, so moving it up is dependency-safe and changes no value.
//
// Two entry points:
//
//   * `runPipeline(options, source, emit)` — the pipeline itself, with the message
//     sink injected. Importable from Node with no `Worker` global, which is what
//     `tools/smoke.mjs` uses.
//   * the module's own `self.onmessage`, which wraps `runPipeline` and forwards
//     every message through `postMessage`. Installed only when this module is
//     actually evaluated inside a worker.
//
// Everything that crosses `postMessage` is flattened to plain data here: the GTFS
// layer's `ServiceDay` carries typed arrays and `Map`s, `Feed.tables` is a lazy
// Proxy over a columnar store, and `Projection` is a class. None of the three can
// be structured-cloned, so §(d)'s wire shapes (`DaySummary`, `StopRow`,
// `{lat0, lon0}`) are built at this boundary and nowhere else.

import {
  QUARTER_MILE_M, DEFAULT_DEPARTURE, BOARD_SLACK_S, MAX_FEEDS_PER_RUN,
  MAX_MAP_SPOKES, MAP_SPOKE_RDP_M, cmpStr, hmsToS, coord, rhu,
} from './lib/core.js';
import { Projection, bboxOf } from './lib/geo.js';
import { openCache } from './lib/cache.js';

import {
  loadFeed, normaliseTimes, feedWindow, setFeedLogger, s1Median,
} from './gtfs/feed.js';
import { mergeFeeds, mergeOrder, feedSourceRows } from './gtfs/merge.js';
import {
  dayTypes, buildServiceDay, busiestDay, clusterStations,
} from './gtfs/service.js';
import { raptor, raptorReverse } from './gtfs/raptor.js';
import {
  zoneCover, buildZones, networkMetrics, routeHeadways, routeSpokes, s1Percentiles,
} from './gtfs/network.js';
import {
  inferHub, inferBorder, inferGameSize, travelTimeSamples, gtfsQuestionFacts,
  dayRaptorRuns, zoneReachMinutes,
  setInferLogger,
} from './gtfs/infer.js';
import { collectGeodata, emptyGeoData } from './osm/geodata.js';
import {
  openWorld, worldStatsLine, worldTransitRoutes, DEFAULT_WORLD_BASE_URL,
} from './osm/worldfile.js';
import { catalogueFor } from './rules/catalogue.js';
import {
  answerSignature, survivalFractions, globalQuestionOrder, auditQuestions,
  auditCurses, seekerSample,
} from './rules/audit.js';

// `rules/score.js` (CONTRACT.md §(a)) is loaded dynamically rather than with a
// static import. A static import of a module that is not on disk is a link error
// that takes the whole worker down before the first message; a dynamic one lets the
// nine sections that do not depend on scoring still reach the page. See `loadScore`.
let SCORE = null;
let SCORE_ERROR = null;

/** The greedy-question depth `k`, generate.py. */
const GREEDY_K = Object.freeze({ small: 3, medium: 4, large: 5 });

/**
 * `DEFAULT_OPTIONS`, CONTRACT.md §(c). `source` is deliberately absent — the run
 * message carries the file or the URL separately.
 */
const DEFAULT_PIPELINE_OPTIONS = Object.freeze({
  useOsm: true,
  // Null, not the URL: this is an OVERRIDE, and it has to be distinguishable from
  // "the reader typed the default back in by hand". `openWorld`'s own parameter
  // default is the one place the published bucket is named, and a null here resolves
  // to it at the call site — a null passed straight into `openWorld(baseUrl = …)`
  // would NOT trigger the parameter default, which is the trap this comment exists
  // to close.
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
 * Headway histogram buckets, CONTRACT.md §(d) `DaySummary.headwayHistogramMin`:
 * `[0,5) [5,10) [10,15) [15,20) [20,30) [30,45) [45,60) [60,90) [90,∞)`.
 */
const HEADWAY_BUCKETS = Object.freeze([5, 10, 15, 20, 30, 45, 60, 90]);

// ── progress model ───────────────────────────────────────────────────────────
//
// One monotonic 0..1000 bar over weighted phases. Weights are rough measured
// shares of a `--no-osm` run on the reference feed; the OSM phase dominates when it
// is enabled, which is why it carries the largest weight. `total` is fixed at 1000
// and only `done` moves — CONTRACT.md permits a growing `total`, but a bar that
// only ever advances reads better and the geo layer's own growing estimate is
// already normalised into this phase's slice.

const PHASES = Object.freeze([
  ['feed', 'Reading the feed', 150],
  ['feed:normalise', 'Normalising times', 40],
  ['days', 'Building service days', 170],
  ['network:hub', 'Finding the round-start station', 30],
  ['network:metrics', 'Measuring the network', 120],
  ['network:zones', 'Covering the map with hiding zones', 90],
  ['network:samples', 'Sampling ride times', 60],
  ['geo', 'Reading the map files', 180],
  ['rules:questions', 'Auditing the question deck', 60],
  ['rules:surv', 'Measuring information resistance', 60],
  ['score', 'Scoring the city', 30],
  ['provenance', 'Writing the receipts', 10],
]);

const PROGRESS_TOTAL = 1000;

class Progress {
  /** @param {(msg: object) => void} emit */
  constructor(emit) {
    this.emit = emit;
    this.index = -1;
    this.base = 0;
    this.done = 0;
    const sum = PHASES.reduce((acc, p) => acc + p[2], 0);
    this.scale = PROGRESS_TOTAL / sum;
  }

  /**
   * Enter phase `i`, retiring every earlier phase's weight. The first message
   * carries no label of its own, so `report` falls through to `PHASES[i]`'s name —
   * which is the only phase-opening label there has ever been.
   */
  begin(i) {
    this.index = i;
    let base = 0;
    for (let j = 0; j < i; j++) base += PHASES[j][2];
    this.base = base * this.scale;
    this.report(0, undefined);
  }

  /** Advance within the current phase. `frac` is 0..1 and is clamped. */
  report(frac, label) {
    if (this.index < 0) return;
    const [token, name, weight] = PHASES[this.index];
    const f = frac < 0 ? 0 : frac > 1 ? 1 : frac;
    const value = this.base + f * weight * this.scale;
    // Monotonic: a sub-phase that recomputes its own denominator must never
    // walk the bar backwards.
    if (value > this.done) this.done = value;
    this.emit({
      type: 'progress',
      stage: token,
      label: label || name,
      done: this.done,
      total: PROGRESS_TOTAL,
    });
  }

  /** Retire the current phase whether it succeeded or not. */
  finish() { this.report(1, undefined); }

  /**
   * A sink shaped like the geo / audit modules' `onProgress(done, total, label)`,
   * normalised into the current phase's slice. A zero or missing `total` is
   * treated as "unknown work remaining" and leaves the bar where it is.
   */
  sink() {
    return (done, total, label) => {
      const t = Number(total);
      if (!Number.isFinite(t) || t <= 0) return;
      this.report(Number(done) / t, label);
    };
  }
}

// ── the pipeline ─────────────────────────────────────────────────────────────

/** The `SourceRef.kind` values this worker knows how to read. CONTRACT.md §(d). */
const SOURCE_KINDS = Object.freeze(['file', 'osm', 'url']);

/**
 * The run's sources as a list of `{ arg, ring, id, label, mdbId }`.
 *
 * CONTRACT.md §(d)'s `run` message carries `sources: SourceRef[]` and nothing else —
 * the older `file` / `url` pair is gone, because two ways to say the same thing is
 * how a stale main thread half-works silently. This function is the one place that
 * knows a `SourceRef` from a bare input, so `runPipeline` stays callable from Node
 * with a single `File`, which is exactly what `tools/smoke.mjs` does and the path
 * the golden numbers are measured on.
 *
 * A `kind:'osm'` ref carries no loadable input at all: `ring` is the input, and the
 * GTFS zip it becomes is synthesized inside the load loop, so a synthesis failure
 * lands in the same per-source catch a dead mirror does. `arg` stays null until then.
 *
 * A ref-shaped object whose `kind` is not one of the three is REFUSED BY NAME. Before
 * this, an unknown kind failed the `isRef` test, was treated as a bare input, and was
 * handed to `loadFeed` as a raw object — which surfaced four stages later as an
 * unreadable source rather than as the one sentence that says a newer page is talking
 * to an older worker.
 *
 * @param {SourceRef[]|Array<File|Blob|string>|File|Blob|ArrayBuffer|Uint8Array|string} source
 * @returns {Array<{arg: (File|Blob|ArrayBuffer|Uint8Array|string|null),
 *   ring: Array<[number, number]>|null, id: string, label: string,
 *   mdbId: string|null}>}
 */
function normaliseSources(source) {
  const list = Array.isArray(source) ? source : [source];
  const out = [];
  for (const item of list) {
    if (item === null || item === undefined) continue;
    // A `File` and a `Blob` are objects with no `kind`, which is what keeps the bare
    // input path — and the golden numbers that run on it — untouched by all of this.
    const kind = (typeof item === 'object' && !Array.isArray(item)
      && typeof item.kind === 'string') ? item.kind : '';
    if (kind && !SOURCE_KINDS.includes(kind)) {
      throw new Error(`The run named a source of kind ${JSON.stringify(kind)}, which this `
        + 'analysis does not know how to read. Reload the page and try again.');
    }
    const isRef = kind !== '';
    const ring = kind === 'osm' && Array.isArray(item.ring) ? item.ring : null;
    const arg = isRef ? (kind === 'osm' ? null : (item.file ?? item.url)) : item;
    if (kind === 'osm') {
      if (ring === null || ring.length < 3) {
        throw new Error('An OpenStreetMap area was named as a source without the shape it '
          + 'is meant to cover, so there is nothing to read.');
      }
    } else if (arg === null || arg === undefined) continue;
    let label = isRef ? String(item.label || '') : '';
    if (!label) {
      if (kind === 'osm') label = 'the OpenStreetMap area';
      else {
        label = typeof arg === 'string'
          ? arg
          : (arg && typeof arg.name === 'string' ? arg.name : 'the feed');
      }
    }
    const mdbId = isRef && item.mdbId !== undefined && item.mdbId !== null
      ? String(item.mdbId) : null;
    // `id` is carried only so a synthesized feed can be NAMED after the area it was
    // built from; nothing here sorts on it. The main thread already sorted the list.
    out.push({ arg, ring, id: isRef ? String(item.id || '') : '', label, mdbId });
  }
  if (!out.length) throw new Error('The run message carried no feed to read.');
  // CONTRACT.md §(d) bounds the list at both ends. The page refuses the eleventh feed
  // twice over before it gets here, so this is the backstop for a message that came
  // from somewhere else — a stale tab, a hand-built `postMessage` — rather than a
  // sentence anyone should be able to reach through the UI.
  if (out.length > MAX_FEEDS_PER_RUN) {
    throw new Error(`One run merges at most ${MAX_FEEDS_PER_RUN} feeds; `
      + `this run asked for ${out.length}.`);
  }
  return out;
}


/**
 * A drawn area as GTFS zip bytes, built from OpenStreetMap's own route relations.
 *
 * `osm/synth.js` is imported DYNAMICALLY, the same way `rules/score.js` is and for a
 * weaker version of the same reason: a run whose sources are all published feeds must
 * not parse the converter, and — since the module is only reachable from a source kind
 * the page has to offer first — its absence should degrade one source rather than
 * refuse to start the worker.
 *
 * `worldTransitRoutes` answers three different ways and they are three different
 * sentences: `null` says the build shipped no `transit_route` layer at all, which is a
 * stale bucket rather than a city with no railway; `[]` says the layer is there and has
 * nothing inside this shape; anything else is the relations to convert. None of the
 * three is a report about the city until the last one.
 *
 * The bytes come back wrapped in a `File` where there is one to wrap them in, purely
 * so `loadFeed` has a name to put in `Feed.source`: unwrapped, every synthesized feed
 * is called `uploaded.zip` in §09, which is the one place a report must not be vague
 * about what it read. The hash is unaffected — `sha256` is still the digest of exactly
 * these bytes.
 *
 * @param {{ring: Array<[number,number]>, label: string, id?: string}} src
 * @param {Object} world an open `World` (`osm/worldfile.js`)
 * @param {string|null} asOf the effective analysis date for the synthesized
 *        calendar — the run's own `asOf`, or the caller's alignment date on a
 *        mixed run (see the load loop), or null for the fixed 2030 fallback
 * @returns {Promise<{arg: (File|Uint8Array), notes: string[]}>}
 */
async function synthesizeArea(src, world, asOf) {
  const { synthesizeFeedZip } = await import('./osm/synth.js');
  const routes = await worldTransitRoutes(world, bboxOf(src.ring));
  if (routes === null) {
    throw new Error('these map files carry no OpenStreetMap route relations, so an area '
      + 'cannot be built from them; the published build is the one to point at');
  }
  if (!routes.length) {
    throw new Error('OpenStreetMap maps no rail, metro or tram line inside that shape');
  }
  const { zip, notes } = synthesizeFeedZip({ routes, ring: src.ring, asOf });
  const name = `openstreetmap-${String(src.id || '').replace(/^osm:/, '') || 'area'}.zip`;
  const arg = typeof File === 'function'
    ? new File([zip], name, { type: 'application/zip' })
    : zip;
  return { arg, notes };
}


/**
 * Run the whole pipeline, emitting `progress` / `stage` / `log` / `degraded` /
 * `error` / `done` messages through `emit`.
 *
 * `emit` is injected rather than being `postMessage` directly so the pipeline is
 * importable and testable outside a worker (`tools/smoke.mjs`). Every payload
 * `emit` receives is already structured-clone-safe.
 *
 * The only fatal failures are the ones CONTRACT.md §(f)6 names: the source could
 * not be read, the zip could not be opened, or the feed has no usable tables.
 * Everything after that degrades — a stage that throws emits a non-fatal `error`
 * plus a `degraded`, and the pipeline continues as far as the dependency order
 * allows.
 *
 * @param {object} options an `Options` (CONTRACT.md §(c))
 * @param {SourceRef[]|Array<File|Blob|string>|File|Blob|ArrayBuffer|Uint8Array|string} source
 *        the run's sources. A bare `File`/`Blob`/buffer/URL is a list of one, which
 *        is the shape `tools/smoke.mjs` passes and the path the golden numbers run on.
 * @param {(msg: object) => void} emit
 * @returns {Promise<object|null>} the `Report`, or null after a fatal error
 */
export async function runPipeline(options, source, emit) {
  // CONTRACT.md §(c) `DEFAULT_OPTIONS`. The main thread is supposed to send a full
  // `Options`, but `buildProvenance` prints `departure`, `boardSlackS`,
  // `excludeStops` and `excludeRoutes` verbatim, and an absent key would reach the
  // page as `undefined`. Fill the defaults once, here, rather than at each reader.
  const opts = { ...DEFAULT_PIPELINE_OPTIONS, ...options };
  const post = typeof emit === 'function' ? emit : () => {};
  const progress = new Progress(post);

  /** @type {string[]} */
  const degradations = [];

  const log = (level, message) => post({ type: 'log', level, message: String(message) });
  const degrade = (message) => {
    const text = String(message);
    degradations.push(text);
    post({ type: 'degraded', message: text });
  };
  const nonFatal = (stage, err) => {
    const message = (err && err.message) ? err.message : String(err);
    post({ type: 'error', stage, message, fatal: false });
    return message;
  };
  const fatal = (stage, err) => {
    const message = (err && err.message) ? err.message : String(err);
    post({ type: 'error', stage, message, fatal: true });
  };

  // The GTFS and inference layers log through injectable sinks (they have no
  // stdlib `log` in a worker). Route both at the `log` message.
  setFeedLogger({
    info: (m) => log('info', m),
    warn: (m) => log('warn', m),
  });
  setInferLogger({
    info: (m) => log('info', m),
    warn: (m) => log('warn', m),
  });

  const cache = await openCache({
    offline: Boolean(opts.offline),
    refresh: Boolean(opts.refresh),
  });

  // The world files, opened at most once and only when something asks. Two phases can
  // need them now — an OpenStreetMap area source at S1, and the geo layer at S2 — and
  // they must share one handle: `world.stats()` is what the run reports as its map-file
  // budget, and two handles would each report half of it.
  let world = null;
  const openWorldOnce = async () => {
    if (world === null) world = await openWorld(opts.worldBaseUrl || DEFAULT_WORLD_BASE_URL);
    return world;
  };
  /** True when any source was built from OpenStreetMap rather than published. */
  let assumedSchedule = false;

  // ── S1 load feed ──────────────────────────────────────────────────────────
  let feed;
  let start;
  let end;
  let asOf;
  let types;
  let srcs;
  try {
    srcs = normaliseSources(source);
    progress.begin(0);
    // One `loadFeed` per source, then a table-level merge. The per-source download
    // cache is what makes a repeated pick cheap; there is no merged-artifact cache,
    // because a `Feed` holds typed arrays and a Proxy and is not serialisable.
    const loaded = [];
    // The source metadata travels BESIDE the feed it produced, never re-indexed by
    // position: when a download fails the loaded list is shorter than `srcs`, and an
    // index into one is not an index into the other. §09 exists so a merged report
    // cannot lie about what it read, so this pairing is load-bearing, not tidiness.
    const loadedSrcs = [];
    // Published sources load FIRST and drawn areas synthesize after them — not for
    // tidiness: a synthesized calendar pinned to the fixed 2030 fallback can never
    // intersect a live feed's window, so a default mixed run would take merge's
    // no-dates-in-common union and the OSM system would run on zero representative
    // days. With the published feeds already loaded, a ring source with no explicit
    // `asOf` anchors its 14-day calendar to their latest start date instead — still
    // deterministic, a pure function of the run's own feed bytes, and an OSM-only
    // run keeps the fixed fallback untouched. The reorder is free: `mergeOrder`
    // sorts by content hash, and `loaded`/`loadedSrcs` travel as a pair.
    const loadOrder = [];
    for (let i = 0; i < srcs.length; i++) if (!srcs[i].ring) loadOrder.push(i);
    for (let i = 0; i < srcs.length; i++) if (srcs[i].ring) loadOrder.push(i);
    for (let k = 0; k < loadOrder.length; k++) {
      const i = loadOrder[k];
      const many = srcs.length > 1;
      const label = many ? `Reading feed ${k + 1} of ${srcs.length}` : 'Reading the feed';
      // A download is one silent block — `loadFeed`'s own `onProgress` fires per
      // table, not per byte — so the bar is nudged between sources as well, which is
      // also what keeps app.js's 120-second silence watchdog fed on a multi-feed run.
      progress.report(k / srcs.length, label);
      try {
        // An OpenStreetMap area becomes a real GTFS zip HERE, before anything else in
        // the pipeline sees it, and then falls into the untouched `loadFeed` below.
        // That is the whole trick: the fatal guards, the content-addressed `sha256`,
        // the merge order, the `f0:` namespacing and `mergeFeeds([f]) === f` all hold
        // by construction rather than by a second Feed constructor re-earning each of
        // them. A failure in here is a per-source failure like any other — the catch
        // below is fatal on a single-source run and degrades on a merged one.
        if (srcs[i].ring) {
          progress.report(k / srcs.length, 'Building the area from OpenStreetMap');
          // The effective analysis date: the run's own `asOf` when given, else the
          // latest feed_start_date among the feeds already loaded — the merged
          // window's intersection starts there, and the synthesizer's windowMonday
          // steps back at most six days, so its 14-day calendar covers it — else
          // null, and the synthesizer's fixed 2030 fallback (the OSM-only path,
          // unchanged).
          let synthAsOf = opts.asOf;
          if (!String(synthAsOf ?? '').trim()) {
            synthAsOf = null;
            for (const f of loaded) {
              if (f.feedStart && (synthAsOf === null || f.feedStart > synthAsOf)) {
                synthAsOf = f.feedStart;
              }
            }
          }
          const built = await synthesizeArea(srcs[i], await openWorldOnce(), synthAsOf);
          srcs[i].arg = built.arg;
          // The assumptions go to the log channel, one line each, rather than into the
          // degradation list: they are what the feed ASSUMED, not what the report is
          // missing, and the callout they would land in is titled the other thing. The
          // one sentence that IS a limit of the source is degraded below.
          for (const note of built.notes) log('info', `osm feed: ${note}`);
        }
        loaded.push(await loadFeed(srcs[i].arg, cache, {
          onProgress: ({ done, total }) => {
            if (total) progress.report((k + done / total) / srcs.length, label);
          },
        }));
        loadedSrcs.push(srcs[i]);
        // Said only once the feed is actually IN the run. Synthesis can succeed and the
        // load still fail, and on a merged run that source is then dropped — a report
        // that announced an assumed timetable it did not end up reading would be
        // apologising for the wrong thing.
        if (srcs[i].ring) {
          assumedSchedule = true;
          degrade(`${srcs[i].label} was built from OpenStreetMap's rail, metro and tram `
            + 'lines rather than read from a published timetable. Where the lines run is '
            + 'measured; how often they run is assumed, so every score that rests on the '
            + 'timetable is dropped rather than guessed at.');
        }
      } catch (err) {
        // One dead mirror out of four must not kill the run. With a single source,
        // one failure IS zero loaded, so this falls through to the fatal below and
        // the single-feed path behaves exactly as it always has.
        if (srcs.length === 1) throw err;
        // One failure, one line in the degradation list. A `nonFatal` here as well
        // would reach the page twice — app.js files a non-fatal `error` as its own
        // degradation — so the diagnostic copy goes to the log channel instead, and
        // the sentence that names the feed and the consequence is the record.
        log('warn', `feed: ${(err && err.message) || err}`);
        degrade(`${srcs[i].label} could not be read (${(err && err.message) || err}); `
          + 'the report covers the other feeds only.');
      }
    }
    if (!loaded.length) {
      throw new Error('None of the chosen feeds could be read.');
    }
    const order = mergeOrder(loaded);
    // `mergeFeeds([f]) === f` — reference equality, nothing copied. That identity is
    // why a single-source run cannot drift. `sources` is attached HERE, on both
    // paths, so every renderer sees the same shape whatever the feed count.
    feed = await mergeFeeds(loaded, { onNote: degrade });
    feed.sources = feedSourceRows(order, loadedSrcs);
    progress.finish();

    progress.begin(1);
    normaliseTimes(feed);
    progress.finish();

    [start, end, asOf] = feedWindow(feed, opts.asOf);
    types = dayTypes(feed, start, end);
    if (types.length < 2) {
      degrade('This feed schedules every day the same way, so there is no weekday '
        + 'and weekend difference to report.');
    }
  } catch (err) {
    fatal('feed', err);
    return null;
  }

  const stopCount = Object.keys(feed.stops).length;
  const routeCount = Object.keys(feed.routes).length;
  const tripCount = (feed.tables.trips || []).length;

  post({
    type: 'stage',
    stage: 'feed',
    payload: {
      agencyName: feed.agencyName,
      agencyUrl: feed.agencyUrl,
      timezone: feed.timezone,
      feedStart: feed.feedStart,
      feedEnd: feed.feedEnd,
      feedVersion: feed.feedVersion,
      publisher: feed.publisher,
      asOf,
      sha256: feed.sha256,
      source: feed.source,
      feeds: feed.sources,
      stops: stopCount,
      routes: routeCount,
      trips: tripCount,
      // `geo.admin.placeName` has not been resolved yet; the agency name is the
      // CLI's own fallback and the `'provenance'` stage overwrites it.
      place: feed.agencyName,
    },
  });

  // ── S1 service days ───────────────────────────────────────────────────────
  const orderedStops = Object.keys(feed.stops).sort(cmpStr).map((id) => feed.stops[id]);
  const proj = Projection.about(orderedStops.map((s) => [s.lat, s.lon]));

  let days;
  let best;
  let stations;
  try {
    progress.begin(2);
    days = [];
    for (let i = 0; i < types.length; i++) {
      days.push(buildServiceDay(feed, types[i], proj, { boardSlackS: opts.boardSlackS }));
      progress.report((i + 1) / types.length, `Building service days (${i + 1}/${types.length})`);
    }
    best = busiestDay(days);
    stations = clusterStations(orderedStops, proj);
    progress.finish();
  } catch (err) {
    fatal('days', err);
    return null;
  }

  post({
    type: 'stage',
    stage: 'days',
    payload: {
      days: days.map(daySummary),
      selectedDay: best.dayType.key,
    },
  });

  // ── S1 inference ──────────────────────────────────────────────────────────
  let hub;
  let metrics;
  let size;
  let sizeInference;
  let border;
  let zones;
  let headways;
  let gtfsFacts;
  let travelSamples = [];
  let zoneReach = null;
  let spokes = { spokes: [], cap: { shown: 0, total: 0, source: 'shapes' } };
  let origin;
  let depS;
  try {
    progress.begin(3);
    hub = inferHub(feed, best, proj);
    progress.finish();

    progress.begin(4);
    // First pass at the rulebook's default zone radius: the size vote reads
    // `nZones`, and `nZones` depends on the radius, so the radius the size
    // resolves to cannot be used to compute the vote. The CLI does the same and
    // then re-runs the whole metric table at the real radius below.
    metrics = networkMetrics(feed, days, proj, hub, QUARTER_MILE_M);
    progress.finish();

    [size, sizeInference] = inferGameSize(metrics, opts);
    border = inferBorder(feed, best, hub, size, proj, opts);

    progress.begin(5);
    const events = Object.create(null);
    const pos = Object.create(null);
    for (const sid of best.servedStopIds) {
      events[sid] = best.stopDays[sid].departures.length;
      pos[sid] = proj.xy(feed.stops[sid].lat, feed.stops[sid].lon);
    }
    const centres = zoneCover(best.servedStopIds, size.zoneRadiusM, events, pos);
    zones = buildZones(feed, best, centres, size.zoneRadiusM, proj);
    progress.report(0.5, 'Re-measuring at the resolved zone radius');
    metrics = networkMetrics(feed, days, proj, hub, size.zoneRadiusM);
    // The honesty boundary, carried as one clone-safe boolean on the object that
    // already reaches every scoring entry point — `auditQuestions`, `scoreFitness`,
    // `fitnessCaps`, `scoreZones`, `deriveRecommendations` — so nothing downstream
    // grows a parameter for it. The rule is run-level and deliberately conservative:
    // ONE invented timetable in the merge makes every schedule-derived number in the
    // run assumed, because after `mergeFeeds` nothing can tell the two apart.
    metrics.assumedSchedule = assumedSchedule;
    headways = routeHeadways(feed, days);
    gtfsFacts = gtfsQuestionFacts(feed, days, zones, stations);
    progress.finish();

    // generate.py: `--start` is resolved here, not inside infer.js,
    // and the departure `or` chain lets a literal '00:00:00' fall through to 09:00.
    origin = opts.startStopId || hub.stopId;
    depS = hmsToS(opts.departure || DEFAULT_DEPARTURE) || hmsToS(DEFAULT_DEPARTURE);

    progress.begin(6);
    // The CLI computes this last; CONTRACT.md §(d) needs it in the `'network'`
    // payload and every input already exists. Pure function, same value.
    //
    // One RAPTOR pass per day, shared: the fourteen chart destinations and the
    // per-zone reach the map colours by are two readings of the same runs, so the
    // reach layer costs no extra pass. (2026-08-23.)
    const runs = dayRaptorRuns(days, origin, depS);
    travelSamples = travelTimeSamples(days, zones, origin, depS, 14, runs);
    zoneReach = zoneReachMinutes(days, zones, runs, origin, depS, size.hidingPeriodMin);
    spokes = routeSpokes(feed, days, hub, MAX_MAP_SPOKES, MAP_SPOKE_RDP_M);
    progress.finish();
  } catch (err) {
    fatal('network', err);
    return null;
  }

  // Built once, sent twice. CONTRACT.md §(d) carries these rows on the `'network'`
  // stage AND in the `Report`, and nothing between the two touches `feed`, `days`,
  // `best` or `zones`, so the `'done'` payload below reuses this array. On the worker
  // path each `postMessage` clones it and the two messages stay independent; in Node
  // (`tools/smoke.mjs`) they are one array, which neither consumer writes to.
  const stops = stopRows(feed, days, best, zones);

  post({
    type: 'stage',
    stage: 'network',
    payload: {
      zones,
      hub,
      border,
      size,
      sizeInference,
      metrics,
      routeHeadways: headways,
      travelSamples,
      zoneReach,
      routeSpokes: spokes.spokes,
      spokeCap: spokes.cap,
      stops,
      proj: proj.toJSON(),
    },
  });

  // ── S2 geodata ────────────────────────────────────────────────────────────
  //
  // CONTRACT.md §(f)1: a failed map-file read is not fatal. `--no-osm` is the same
  // path with a different note.
  let geo;
  progress.begin(7);
  if (opts.useOsm) {
    try {
      // One manifest fetch, then every category is a Range request against an
      // immutable file. `opts.worldBaseUrl` exists so a build can be pointed at a
      // local static server before it is published — the Advanced panel's "Map file
      // base URL" field sets it, and null means "the published bucket".
      const baseUrl = opts.worldBaseUrl || DEFAULT_WORLD_BASE_URL;
      if (opts.worldBaseUrl) log('info', `reading the map files from ${baseUrl}`);
      // `openWorldOnce`, not a second `openWorld`: an area source has usually opened
      // this bucket already, and one handle is what keeps `worldStatsLine` a report of
      // the whole run's map-file budget instead of the geo phase's share of it.
      const handle = await openWorldOnce();
      geo = await collectGeodata(handle, opts, border, zones, proj, size.zoneRadiusM, {
        onProgress: progress.sink(),
        onLog: (level, message) => log(level === 'warning' ? 'warn' : level, message),
      });
      log('info', worldStatsLine(handle));
    } catch (err) {
      const name = (err && err.name) ? err.name : 'Error';
      log('warn', `OSM layer unavailable: ${err && err.message ? err.message : err}`);
      nonFatal('geo', err);
      degrade(`The OpenStreetMap files could not be read (${name}), so every question, `
        + 'curse and score that needs map features is excluded rather than guessed at.');
      geo = emptyGeoData(border.bbox,
        'The map files could not be read; OSM-backed scores are excluded.');
    }
  } else {
    // Not `--no-osm`: there is no command line here. The reader flipped a switch
    // labelled "Skip OpenStreetMap", so the notice names the thing they did.
    degrade('OpenStreetMap was skipped, so every question, curse and score that needs '
      + 'map features is excluded rather than guessed at.');
    geo = emptyGeoData(border.bbox, 'OpenStreetMap was skipped, so the OSM layer was never '
      + 'queried.');
  }
  progress.finish();

  post({ type: 'stage', stage: 'geo', payload: { geo } });

  // ── S3 questions ──────────────────────────────────────────────────────────
  let questions = [];
  let curses = [];
  let signatures = Object.create(null);
  let surv = Object.create(null);
  let order = [];
  let funnel = [];
  try {
    progress.begin(8);
    questions = auditQuestions(size, geo, gtfsFacts, zones, metrics, border, {
      onProgress: progress.sink(),
    });
    curses = auditCurses(size, geo, gtfsFacts, geo.admin.countryCode, metrics);
    progress.finish();

    progress.begin(9);
    // Signatures and surv are computed only for questions that are still alive:
    // a dead question partitions nothing, and evaluating it would just be noise.
    const defs = Object.create(null);
    for (const d of catalogueFor(size)) defs[d.id] = d;
    const live = questions.filter(
      (q) => q.status === 'functional' || q.status === 'weak',
    );
    for (let i = 0; i < live.length; i++) {
      const q = live[i];
      signatures[q.id] = answerSignature(defs[q.id], zones, geo, gtfsFacts, proj);
      progress.report(0.4 * ((i + 1) / Math.max(1, live.length)), 'Computing answer signatures');
    }
    const seekers = seekerSample(zones);
    for (let i = 0; i < live.length; i++) {
      const q = live[i];
      surv[q.id] = survivalFractions(defs[q.id], signatures[q.id], zones, seekers);
      progress.report(0.4 + 0.3 * ((i + 1) / Math.max(1, live.length)),
        'Computing survival fractions');
    }
    const k = GREEDY_K[size.name];
    [order, funnel] = globalQuestionOrder(questions, signatures, zones, k, {
      onProgress: (done, total, label) => {
        const t = Number(total);
        if (Number.isFinite(t) && t > 0) {
          progress.report(0.7 + 0.3 * (Number(done) / t), label || 'Ordering the questions');
        }
      },
    });
    progress.finish();
  } catch (err) {
    nonFatal('rules', err);
    degrade(`The question audit failed (${(err && err.name) || 'Error'}), so the questions `
      + 'and curse-deck sections are incomplete.');
  }

  post({
    type: 'stage',
    stage: 'rules',
    payload: {
      questions,
      curses,
      questionOrder: order,
      questionFunnel: funnel,
    },
  });

  // ── S3 scoring ────────────────────────────────────────────────────────────
  let fitness = null;
  let caps = [];
  let zoneScores = Object.create(null);
  let ranked = [];
  let dossiers = [];
  let findings = [];
  let recommendations = [];

  const score = await loadScore();
  progress.begin(10);
  if (!score) {
    degrade(`The scoring layer could not be loaded (${SCORE_ERROR}), so the verdict, `
      + 'the score trace and the house rules are missing.');
    post({
      type: 'error',
      stage: 'score',
      message: `The scoring layer could not be loaded: ${SCORE_ERROR}`,
      fatal: false,
    });
  } else {
    try {
      const times = raptor(best, [origin], depS);
      const back = raptorReverse(best, [origin],
        Math.trunc(Number(metrics.medianLastDepartureS) || 0));
      progress.report(0.4, 'Scoring the zones');
      zoneScores = score.scoreZones(zones, questions, signatures, surv, geo, best,
        times, back, size, metrics, proj);
      ranked = score.rankZones(zoneScores);
      progress.report(0.7, 'Scoring the city');
      fitness = score.scoreFitness(metrics, questions, zones, zoneScores, size, days);
      // `fitnessCaps(metrics, questions, zones, size, days)` — the Python signature
      // (generate.py). It does not take `zoneScores`.
      caps = score.fitnessCaps(metrics, questions, zones, size, days);
      const zoneById = Object.create(null);
      for (const z of zones) zoneById[z.zoneId] = z;
      dossiers = score.selectDossiers(ranked, zoneScores, zoneById, size.zoneRadiusM);
      findings = score.deriveFindings(fitness, metrics, questions);
      recommendations = score.deriveRecommendations({
        metrics, fitness, size, hub, border, curses, questions, feed,
      });
    } catch (err) {
      nonFatal('score', err);
      degrade(`Scoring failed (${(err && err.name) || 'Error'}), so the verdict and the `
        + 'score trace are incomplete.');
    }
  }
  progress.finish();

  post({
    type: 'stage',
    stage: 'score',
    payload: {
      fitness,
      caps,
      zoneScores,
      rankedZoneIds: ranked,
      dossierZoneIds: dossiers,
      findings,
      recommendations,
      // `scoreZones` fills `QuestionAudit.survMean` IN PLACE, so this copy is the
      // authoritative one and §07 must re-hydrate from it. CONTRACT.md §(d).
      questions,
    },
  });

  // ── provenance ────────────────────────────────────────────────────────────
  progress.begin(11);
  let provenance = null;
  if (score && score.buildProvenance) {
    try {
      provenance = score.buildProvenance(opts, feed, geo, size, asOf, degradations);
    } catch (err) {
      nonFatal('provenance', err);
      degrade(`The provenance record could not be assembled (${(err && err.name) || 'Error'}), `
        + 'so the sources section is incomplete.');
    }
  }
  progress.finish();

  post({
    type: 'stage',
    stage: 'provenance',
    payload: { provenance, degradations: degradations.slice() },
  });

  const place = (geo.admin && geo.admin.placeName) || feed.agencyName;

  const report = {
    opts: wireOptions(opts),
    feed: wireFeed(feed),
    proj: proj.toJSON(),
    size,
    sizeInference,
    hub,
    border,
    days: days.map(daySummary),
    selectedDay: best.dayType.key,
    zones,
    metrics,
    routeHeadways: headways,
    travelSamples,
    zoneReach,
    routeSpokes: spokes.spokes,
    spokeCap: spokes.cap,
    geo,
    questions,
    questionOrder: order,
    questionFunnel: funnel,
    curses,
    fitness,
    zoneScores,
    rankedZoneIds: ranked,
    dossierZoneIds: dossiers,
    findings,
    recommendations,
    place,
    provenance,
    degradations: degradations.slice(),
    // Not in the CLI's `Report`; CONTRACT.md §(d) sends both on their stages and
    // the renderers read them off the report object.
    caps,
    stops,
  };

  post({ type: 'done', report });
  return report;
}

// ── wire shapes ──────────────────────────────────────────────────────────────

/**
 * `ServiceDay` → `DaySummary` (CONTRACT.md §(d)).
 *
 * Full `ServiceDay` objects never leave the worker: `patterns`, `patternAtStop`,
 * `footpaths`, `stopIndex` and `extras` are typed arrays and `Map`s, and
 * `stopDays` is one object per served stop, which is megabytes of no use to the
 * page. The scalars below are everything §06 reads.
 */
function daySummary(day) {
  const served = day.servedStopIds;
  const medians = [];
  const worst = [];
  const lasts = [];
  let frequentStops = 0;
  const histogram = new Array(HEADWAY_BUCKETS.length + 1).fill(0);

  for (const sid of served) {
    const sd = day.stopDays[sid];
    if (sd.last !== null && sd.last !== undefined) lasts.push(sd.last);
    if (sd.medianHeadwayS === null || sd.medianHeadwayS === undefined) continue;
    const minutes = sd.medianHeadwayS / 60.0;
    medians.push(minutes);
    if (sd.worstGapS !== null && sd.worstGapS !== undefined) worst.push(sd.worstGapS / 60.0);
    if (sd.frequent) frequentStops += 1;
    let bucket = HEADWAY_BUCKETS.length;
    for (let i = 0; i < HEADWAY_BUCKETS.length; i++) {
      if (minutes < HEADWAY_BUCKETS[i]) { bucket = i; break; }
    }
    histogram[bucket] += 1;
  }

  const span = (day.lastDeparture - day.firstDeparture) / 3600.0;
  return {
    dayType: {
      key: day.dayType.key,
      label: day.dayType.label,
      date: day.dayType.date,
      dates: day.dayType.dates.slice(),
      serviceIds: day.dayType.serviceIds.slice(),
      trips: day.dayType.trips,
      tripCounts: day.dayType.tripCounts.slice(),
    },
    trips: day.trips,
    stopEvents: day.stopEvents,
    servedStops: served.length,
    routes: day.routeIds.length,
    firstDeparture: day.firstDeparture,
    lastDeparture: day.lastDeparture,
    spanHours: span,
    medianHeadwayMin: medians.length ? s1Median(medians) : null,
    medianWorstGapMin: worst.length ? s1Median(worst) : null,
    frequentStops,
    frequentShare: medians.length ? frequentStops / medians.length : 0.0,
    headwayHistogramMin: histogram,
    lastBusPercentilesS: toPlain(s1Percentiles(lasts, [0.05, 0.25, 0.5, 0.75, 0.95])),
  };
}

/**
 * The map's stop layer (CONTRACT.md §(d) `StopRow`), one row per served stop.
 *
 * `zoneId` is the zone whose circle designates the stop. Zone circles overlap —
 * the cover guarantees centres are more than one radius apart, not that the discs
 * are disjoint — so a stop can sit in two. First zone wins in sorted `zoneId`
 * order, which is deterministic and is what the map legend implies.
 *
 * THE ROW SET IS THE BUSIEST DAY'S SERVED STOPS, on every day. `headwayByDay`
 * (added 2026-08-23 for the map's frequency layer) expresses the other days through
 * `null` — "no service here that day" — and never through extra rows, because
 * `render/strategy.js` counts these rows per zone and `servedStopCount` falls back to
 * their length: widening the set would move published numbers. The cost is real and
 * small: a stop served only on a Sunday never appears (3 of 1,493 on the reference
 * feed), and `null` is what says so.
 */
function stopRows(feed, days, day, zones) {
  const owner = Object.create(null);
  for (const z of Array.from(zones).sort((a, b) => cmpStr(a.zoneId, b.zoneId))) {
    for (const sid of z.stopIds) if (owner[sid] === undefined) owner[sid] = z.zoneId;
  }
  // Sorted so the per-day object's key order is the day key order, not insertion
  // order — CONTRACT §(b): nothing that reaches output iterates an object unsorted.
  const dayKeys = Array.from(days || [], (d) => d.dayType.key)
    .sort((a, b) => cmpStr(a, b));
  const stopDaysByKey = new Map();
  for (const d of days || []) stopDaysByKey.set(d.dayType.key, d.stopDays);

  const rows = [];
  for (const sid of day.servedStopIds) {
    const stop = feed.stops[sid];
    if (!stop) continue;
    const sd = day.stopDays[sid];
    /** @type {Object<string, number|null>} */ const headwayByDay = Object.create(null);
    for (const key of dayKeys) {
      const rowsForDay = stopDaysByKey.get(key) || {};
      const cell = rowsForDay[sid];
      const value = (cell && cell.medianHeadwayS !== null && cell.medianHeadwayS !== undefined)
        ? cell.medianHeadwayS / 60.0
        : null;
      headwayByDay[key] = value === null ? null : rhu(value, 1);
    }
    rows.push({
      stopId: sid,
      name: stop.name,
      lat: coord(stop.lat),
      lon: coord(stop.lon),
      routeIds: sd ? sd.routes.slice() : [],
      frequent: Boolean(sd && sd.frequent),
      headwayByDay,                                      // headway_by_day
      zoneId: owner[sid] === undefined ? null : owner[sid],
    });
  }
  return rows;
}

/**
 * `Feed` minus `tables`.
 *
 * CONTRACT.md §(b) permits dropping it and §(d) requires it: `tables.stop_times`
 * is a lazy Proxy over a columnar store, which `structuredClone` cannot copy.
 * Nothing after `buildProvenance` reads it.
 */
function wireFeed(feed) {
  return {
    source: feed.source,
    sha256: feed.sha256,
    sources: feed.sources || [],
    stops: feed.stops,
    routes: feed.routes,
    agencyName: feed.agencyName,
    agencyUrl: feed.agencyUrl,
    timezone: feed.timezone,
    feedStart: feed.feedStart,
    feedEnd: feed.feedEnd,
    feedVersion: feed.feedVersion,
    publisher: feed.publisher,
  };
}

/**
 * `Options` as the page receives them. `source` is deliberately absent from
 * `DEFAULT_PIPELINE_OPTIONS` — the run message carries the file or the URL
 * separately — so anything under that key is already a plain string.
 */
function wireOptions(opts) {
  return { ...opts };
}

/**
 * `Object.create(null)` → an ordinary object.
 *
 * `structuredClone` already does this, but the smoke harness calls `runPipeline`
 * directly and never crosses a clone boundary, so the two paths would otherwise
 * disagree about the prototype of a handful of small tables.
 */
function toPlain(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort(cmpStr)) out[k] = obj[k];
  return out;
}

/**
 * Load `rules/score.js` if it is present.
 *
 * It is the one module in CONTRACT.md §(a) whose absence must not take the page
 * down with it: §01–§03 and §09 need it, §04–§08 do not, and a report with six
 * sections beats a blank page with a stack trace. Memoised, including the failure.
 */
async function loadScore() {
  if (SCORE || SCORE_ERROR) return SCORE;
  try {
    SCORE = await import('./rules/score.js');
  } catch (err) {
    SCORE = null;
    SCORE_ERROR = (err && err.message) ? err.message : String(err);
  }
  return SCORE;
}

// ── worker entry point ───────────────────────────────────────────────────────

/**
 * True only inside a real `WorkerGlobalScope`. Node has neither `self` nor
 * `WorkerGlobalScope`, so importing this module there installs no handler and has
 * no side effect beyond the imports.
 */
const IN_WORKER = typeof self !== 'undefined'
  && typeof WorkerGlobalScope !== 'undefined'
  // eslint-disable-next-line no-undef
  && self instanceof WorkerGlobalScope;

if (IN_WORKER) {
  let started = false;
  self.onmessage = (event) => {
    const msg = event && event.data;
    if (!msg || msg.type !== 'run') return;
    // CONTRACT.md §(d): exactly one message, ever. A second `run` is a bug on the
    // main thread and must not start a second pipeline over the same cache.
    if (started) return;
    started = true;

    // `readSources` on the main thread sends a `SourceRef[]` and nothing else:
    // two ways to name the same input is how a stale main thread half-works.
    const source = msg.sources;
    const post = (out) => self.postMessage(out);
    runPipeline(msg.options || {}, source, post).catch((err) => {
      post({
        type: 'error',
        stage: 'worker',
        message: (err && err.message) ? err.message : String(err),
        fatal: true,
      });
    });
  };
}
