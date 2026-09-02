// ═══════════════════════════════════════════════════════════════════════════════
// worker.js — the pipeline orchestrator
// ═══════════════════════════════════════════════════════════════════════════════
//
// Ported from `build_report` (generate.py). The order below is the Python's
// dependency order: nothing later may be needed by anything earlier. The one
// reordering is `travelTimeSamples`, which CONTRACT.md §(d) puts in the `'network'`
// payload; every input it needs exists by then.
//
// Two entry points: `runPipeline(options, source, emit)`, importable from Node
// (`tools/smoke.mjs`), and `self.onmessage`, installed only inside a real worker.
//
// Everything that crosses `postMessage` is flattened to plain data here: `ServiceDay`,
// `Feed.tables` and `Projection` cannot be structured-cloned, so §(d)'s wire shapes
// are built at this boundary and nowhere else.

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
  dayRaptorRuns, zoneReachMinutes, inPlayStopIds, excludedStopSet, suggestBorder,
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

// `rules/score.js` (CONTRACT.md §(a)) is imported dynamically so its absence
// degrades the scoring sections instead of taking the worker down. See `loadScore`.
let SCORE = null;
let SCORE_ERROR = null;

/** The greedy-question depth `k`, generate.py. */
const GREEDY_K = Object.freeze({ small: 3, medium: 4, large: 5 });

/**
 * `DEFAULT_OPTIONS`, CONTRACT.md §(c). `source` is deliberately absent: the run
 * message carries the sources separately.
 */
const DEFAULT_PIPELINE_OPTIONS = Object.freeze({
  // Null, not the URL: an override must be distinguishable from the default typed
  // back in. Resolve it at the call site; a null passed straight into
  // `openWorld(baseUrl = …)` would NOT trigger the parameter default.
  worldBaseUrl: null,
  asOf: null,
  sizeOverride: null,
  zoneRadiusM: null,
  hidingPeriodMin: null,
  startStopId: null,
  borderShape: 'bbox',
  borderBbox: null,
  // Provenance only: where a `borderBbox` came from ('landing' | 'suggestion').
  borderSource: null,
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
// One monotonic 0..1000 bar over weighted phases; weights are rough measured shares
// on the reference feed. `total` is fixed and only `done` moves: CONTRACT.md permits
// a growing `total`, but a bar that only advances reads better.

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

  /** Enter phase `i`, retiring every earlier phase's weight; the label is `PHASES[i]`'s name. */
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
    // Monotonic: a sub-phase that recomputes its denominator must never walk the bar back.
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
   * normalised into the current phase's slice. A zero or missing `total` leaves the bar put.
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
 * CONTRACT.md §(d)'s `run` message carries `sources: SourceRef[]` only. This is the
 * one place that knows a `SourceRef` from a bare input, so `runPipeline` stays
 * callable from Node with a single `File` (`tools/smoke.mjs`, the golden path).
 *
 * A `kind:'osm'` ref has no loadable input: `ring` is the input, and the zip is
 * synthesized inside the load loop so a failure lands in the per-source catch.
 * A ref whose `kind` is unknown is refused by name, so a newer page talking to an
 * older worker gets one sentence rather than an unreadable source four stages later.
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
    // A `File` or `Blob` has no `kind`, which keeps the bare-input path untouched.
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
    // `id` only names a synthesized feed; nothing here sorts on it.
    out.push({ arg, ring, id: isRef ? String(item.id || '') : '', label, mdbId });
  }
  if (!out.length) throw new Error('The run message carried no feed to read.');
  // CONTRACT.md §(d) bounds the list at both ends; the page refuses first, so this is
  // the backstop for a stale tab or a hand-built `postMessage`.
  if (out.length > MAX_FEEDS_PER_RUN) {
    throw new Error(`One run merges at most ${MAX_FEEDS_PER_RUN} feeds; `
      + `this run asked for ${out.length}.`);
  }
  return out;
}


/**
 * A drawn area as GTFS zip bytes, built from OpenStreetMap's own route relations.
 *
 * `osm/synth.js` is imported dynamically so a run of published feeds never parses
 * the converter and its absence degrades one source rather than the worker.
 *
 * `worldTransitRoutes` answers three ways: `null` means the build shipped no
 * `transit_route` layer (a stale bucket, not a city with no railway); `[]` means
 * nothing inside this shape; anything else is the relations to convert.
 *
 * The bytes are wrapped in a `File` where one exists so `Feed.source` has a name in
 * §09 instead of `uploaded.zip`. The hash is still the digest of exactly these bytes.
 *
 * @param {{ring: Array<[number,number]>, label: string, id?: string}} src
 * @param {Object} world an open `World` (`osm/worldfile.js`)
 * @param {string|null} asOf the effective analysis date for the synthesized
 *        calendar (the run's `asOf`, the alignment date on a mixed run, or null
 *        for the fixed 2030 fallback)
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
 * `error` / `done` messages through `emit`, which is injected so the pipeline is
 * testable outside a worker. Every payload is already structured-clone-safe.
 *
 * The only fatal failures are CONTRACT.md §(f)6's: the source could not be read,
 * the zip could not be opened, or the feed has no usable tables. Every later stage
 * that throws emits a non-fatal `error` plus a `degraded` and the pipeline continues.
 *
 * @param {object} options an `Options` (CONTRACT.md §(c))
 * @param {SourceRef[]|Array<File|Blob|string>|File|Blob|ArrayBuffer|Uint8Array|string} source
 *        the run's sources; a bare `File`/`Blob`/buffer/URL is a list of one
 * @param {(msg: object) => void} emit
 * @returns {Promise<object|null>} the `Report`, or null after a fatal error
 */
export async function runPipeline(options, source, emit) {
  // CONTRACT.md §(c) `DEFAULT_OPTIONS`: `buildProvenance` prints several options
  // verbatim, so fill the defaults once here rather than at each reader.
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

  // The GTFS and inference layers log through injectable sinks.
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

  // The world files, opened at most once. An OSM area source at S1 and the geo layer
  // at S2 must share one handle, or `world.stats()` would report half the budget each.
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
    // One `loadFeed` per source, then a table-level merge. There is no merged-artifact
    // cache: a `Feed` is not serialisable.
    const loaded = [];
    // Source metadata travels BESIDE the feed it produced, never re-indexed by
    // position: a failed download makes `loaded` shorter than `srcs`.
    const loadedSrcs = [];
    // Published sources load FIRST: a ring source with no explicit `asOf` anchors its
    // 14-day calendar to their latest start date, since the fixed 2030 fallback could
    // never intersect a live feed's window. Order is free: `mergeOrder` sorts by hash.
    const loadOrder = [];
    for (let i = 0; i < srcs.length; i++) if (!srcs[i].ring) loadOrder.push(i);
    for (let i = 0; i < srcs.length; i++) if (srcs[i].ring) loadOrder.push(i);
    for (let k = 0; k < loadOrder.length; k++) {
      const i = loadOrder[k];
      const many = srcs.length > 1;
      const label = many ? `Reading feed ${k + 1} of ${srcs.length}` : 'Reading the feed';
      // A download is one silent block, so the bar is nudged between sources too,
      // which keeps app.js's silence watchdog fed.
      progress.report(k / srcs.length, label);
      try {
        // An OpenStreetMap area becomes a real GTFS zip HERE and then falls into the
        // untouched `loadFeed`, so every guard, the hash and the merge order hold by
        // construction. A failure here is a per-source failure like any other.
        if (srcs[i].ring) {
          progress.report(k / srcs.length, 'Building the area from OpenStreetMap');
          // The run's own `asOf`, else the latest feed_start_date already loaded,
          // else null for the synthesizer's fixed 2030 fallback.
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
          // Assumptions go to the log, not the degradation list; the one real limit
          // of the source is degraded below.
          for (const note of built.notes) log('info', `osm feed: ${note}`);
        }
        loaded.push(await loadFeed(srcs[i].arg, cache, {
          onProgress: ({ done, total }) => {
            if (total) progress.report((k + done / total) / srcs.length, label);
          },
        }));
        loadedSrcs.push(srcs[i]);
        // Said only once the feed is actually IN the run: synthesis can succeed and
        // the load still fail.
        if (srcs[i].ring) {
          assumedSchedule = true;
          degrade(`${srcs[i].label} was built from OpenStreetMap's rail, metro and tram `
            + 'lines rather than read from a published timetable. Where the lines run is '
            + 'measured; how often they run is assumed, so every score that rests on the '
            + 'timetable is dropped rather than guessed at.');
        }
      } catch (err) {
        // One dead mirror must not kill a merged run; a single source falls through
        // to the fatal below.
        if (srcs.length === 1) throw err;
        // Not `nonFatal` as well: app.js files a non-fatal `error` as its own
        // degradation, so the diagnostic goes to the log and the sentence is the record.
        log('warn', `feed: ${(err && err.message) || err}`);
        degrade(`${srcs[i].label} could not be read (${(err && err.message) || err}); `
          + 'the report covers the other feeds only.');
      }
    }
    if (!loaded.length) {
      throw new Error('None of the chosen feeds could be read.');
    }
    const order = mergeOrder(loaded);
    // `mergeFeeds([f]) === f`, so a single-source run cannot drift. `sources` is
    // attached here on both paths so every renderer sees the same shape.
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
      // `geo.admin.placeName` is not resolved yet; the `'provenance'` stage overwrites this.
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
  /** The tighter border `suggestBorder` offers, or null. Never applied here. */
  let suggestedBorder = null;
  let zones;
  let headways;
  let gtfsFacts;
  let travelSamples = [];
  let zoneReach = null;
  let spokes = { spokes: [], cap: { shown: 0, total: 0, source: 'shapes' } };
  let origin;
  let depS;
  // ── the in-play set (CONTRACT.md §(b) Metrics "Stop set") ──────────────────
  // Computed ONCE and threaded into every measurement below. `null` is the literal
  // "no override" case, not an array equal to `servedStopIds`: the smoke goldens are
  // an identity under it. `excludedStopSet` rather than the option lists, because
  // `excludeRoutes` can name a route no stop is exclusively on, which must be a no-op.
  let inPlay = null;
  let inPlayFallback = false;
  if (opts.borderBbox || excludedStopSet(feed, best, opts).size) {
    const picked = inPlayStopIds(feed, best, opts);
    inPlay = picked.ids;
    inPlayFallback = picked.fallback;
    log('info', `in-play: ${inPlay.length} of ${best.servedStopIds.length} served stops`
      + (inPlayFallback ? ' (fallback: every served stop)' : '')
      + (opts.borderBbox ? ' inside the supplied border' : '')
      + ' after exclusions');
    // A silent fallback would contradict §05's "measured inside it", so it is a
    // degradation, and `Border.derivation` becomes `'option_fallback'` below.
    if (inPlayFallback) {
      degrade(opts.borderBbox
        ? 'The border you set kept fewer than half the stops this network serves, so it '
          + 'was used as the frame drawn on the map and not as a filter: every stop, zone '
          + 'and count on this page is measured over the whole network instead.'
        : 'The stops and routes you excluded would have removed more than half the '
          + 'network, so they were not applied: every count on this page is measured over '
          + 'the whole network instead.');
    }
  }
  try {
    progress.begin(3);
    hub = inferHub(feed, best, proj, inPlay);
    progress.finish();

    progress.begin(4);
    // First pass at the rulebook's default radius: the size vote reads `nZones`,
    // which depends on the radius. Re-measured at the resolved radius below, as the CLI does.
    metrics = networkMetrics(feed, days, proj, hub, QUARTER_MILE_M, inPlay);
    metrics.inPlayFallback = inPlayFallback;
    progress.finish();

    [size, sizeInference] = inferGameSize(metrics, opts);
    border = inferBorder(feed, best, hub, size, proj, opts, inPlay);
    // `inferBorder` is handed a set, not the decision, so the worker stamps the third
    // derivation. Only when there WAS a box: a fallback from exclusions alone leaves
    // the border inferred ('reach').
    if (inPlayFallback && border && opts.borderBbox) border.derivation = 'option_fallback';

    progress.begin(5);
    const events = Object.create(null);
    const pos = Object.create(null);
    for (const sid of best.servedStopIds) {
      events[sid] = best.stopDays[sid].departures.length;
      pos[sid] = proj.xy(feed.stops[sid].lat, feed.stops[sid].lon);
    }
    // The reachability-aware suggestion (CONTRACT.md §(b) SuggestedBorder): OFFERED,
    // never applied. Computed on the run's own inputs; null once `sizeOverride` or
    // `borderBbox` says the reader already chose.
    progress.report(0, 'Looking for a tighter border');
    suggestedBorder = suggestBorder(feed, days, best, hub, proj, opts, size, inPlay, events);
    // Zones outside a supplied border cease to exist: the cover runs over the in-play set.
    const centres = zoneCover(inPlay ?? best.servedStopIds, size.zoneRadiusM, events, pos);
    zones = buildZones(feed, best, centres, size.zoneRadiusM, proj, inPlay);
    progress.report(0.5, 'Re-measuring at the resolved zone radius');
    metrics = networkMetrics(feed, days, proj, hub, size.zoneRadiusM, inPlay);
    metrics.inPlayFallback = inPlayFallback;
    // One clone-safe boolean on the object every scoring entry point already gets.
    // Run-level and conservative: ONE invented timetable in the merge makes every
    // schedule-derived number assumed, since after `mergeFeeds` nothing can tell them apart.
    metrics.assumedSchedule = assumedSchedule;
    headways = routeHeadways(feed, days);
    gtfsFacts = gtfsQuestionFacts(feed, days, zones, stations);
    progress.finish();

    // generate.py resolves `--start` here, and its `or` chain lets '00:00:00' fall through to 09:00.
    origin = opts.startStopId || hub.stopId;
    depS = hmsToS(opts.departure || DEFAULT_DEPARTURE) || hmsToS(DEFAULT_DEPARTURE);

    progress.begin(6);
    // The CLI computes this last; CONTRACT.md §(d) needs it in the `'network'`
    // payload. One RAPTOR pass per day is shared by the chart and the reach layer.
    const runs = dayRaptorRuns(days, origin, depS);
    travelSamples = travelTimeSamples(days, zones, origin, depS, 14, runs);
    zoneReach = zoneReachMinutes(days, zones, runs, origin, depS, size.hidingPeriodMin);
    spokes = routeSpokes(feed, days, hub, MAX_MAP_SPOKES, MAP_SPOKE_RDP_M);
    progress.finish();
  } catch (err) {
    fatal('network', err);
    return null;
  }

  // Built once, sent twice (CONTRACT.md §(d): the `'network'` stage AND the `Report`);
  // nothing between the two touches its inputs, and no consumer writes to it.
  const stops = stopRows(feed, days, best, zones, inPlay);

  post({
    type: 'stage',
    stage: 'network',
    payload: {
      zones,
      hub,
      border,
      suggestedBorder,
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
  // UNCONDITIONAL: no switch turns this phase off, and the only way to an
  // unavailable OSM layer is the catch below. `geo.available === false` costs a third
  // of the report (CONTRACT.md §(f)1), which is a failure to report, not a mode.
  // A caller that must run offline points `worldBaseUrl` at an unresolvable host and
  // takes the catch deliberately, as `tools/smoke.mjs` does.
  let geo;
  progress.begin(7);
  try {
    // One manifest fetch, then Range requests against immutable files. Null
    // `worldBaseUrl` means the published bucket.
    const baseUrl = opts.worldBaseUrl || DEFAULT_WORLD_BASE_URL;
    if (opts.worldBaseUrl) log('info', `reading the map files from ${baseUrl}`);
    // `openWorldOnce`, so `worldStatsLine` reports the whole run's map-file budget.
    const handle = await openWorldOnce();
    geo = await collectGeodata(handle, opts, border, zones, proj, size.zoneRadiusM, {
      onProgress: progress.sink(),
      onLog: (level, message) => log(level === 'warning' ? 'warn' : level, message),
      // Arms adminInfo's ordinal-1 place rule (Tokyo, Vienna); a hint the census
      // cross-checks, never an input it trusts.
      timezone: feed.timezone,
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
    // Signatures and surv only for live questions: a dead question partitions nothing.
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
      // The Python signature; it does not take `zoneScores`.
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
      // `scoreZones` fills `QuestionAudit.survMean` IN PLACE; §07 re-hydrates from
      // this copy (CONTRACT.md §(d)).
      questions,
    },
  });

  // ── provenance ────────────────────────────────────────────────────────────
  progress.begin(11);
  let provenance = null;
  if (score && score.buildProvenance) {
    try {
      provenance = score.buildProvenance(opts, feed, geo, size, asOf, degradations, border);
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
    suggestedBorder,
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
    // Not in the CLI's `Report`; the renderers read them off the report object (§(d)).
    caps,
    stops,
  };

  post({ type: 'done', report });
  return report;
}

// ── wire shapes ──────────────────────────────────────────────────────────────

/**
 * `ServiceDay` → `DaySummary` (CONTRACT.md §(d)). Full `ServiceDay` objects never
 * leave the worker: they hold typed arrays, `Map`s and megabytes of per-stop data.
 * The scalars below are everything §06 reads.
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
 * Zone circles overlap, so a stop can sit in two; the first in sorted `zoneId`
 * order wins.
 *
 * THE ROW SET IS THE BUSIEST DAY'S SERVED STOPS, on every day. `headwayByDay` says
 * `null` for a day with no service and never adds rows: `render/strategy.js` counts
 * these rows per zone, so widening the set would move published numbers. A stop
 * served only on a Sunday therefore never appears.
 */
function stopRows(feed, days, day, zones, inPlay = null) {
  const owner = Object.create(null);
  for (const z of Array.from(zones).sort((a, b) => cmpStr(a.zoneId, b.zoneId))) {
    for (const sid of z.stopIds) if (owner[sid] === undefined) owner[sid] = z.zoneId;
  }
  // Sorted: nothing that reaches output iterates an object unsorted (CONTRACT §(b)).
  const dayKeys = Array.from(days || [], (d) => d.dayType.key)
    .sort((a, b) => cmpStr(a, b));
  const stopDaysByKey = new Map();
  for (const d of days || []) stopDaysByKey.set(d.dayType.key, d.stopDays);

  const rows = [];
  // The in-play set when one exists, else every served stop; both in `servedStopIds` order.
  for (const sid of (inPlay ?? day.servedStopIds)) {
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
 * `Feed` minus `tables`, which `structuredClone` cannot copy (CONTRACT.md §(b), §(d)).
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

/** `Options` as the page receives them. */
function wireOptions(opts) {
  return { ...opts };
}

/**
 * `Object.create(null)` → an ordinary object, so the smoke harness (no clone
 * boundary) and the worker agree about prototypes.
 */
function toPlain(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort(cmpStr)) out[k] = obj[k];
  return out;
}

/**
 * Load `rules/score.js` if present. The one module in CONTRACT.md §(a) whose absence
 * must not take the page down: §04–§08 do not need it. Memoised, including the failure.
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

/** True only inside a real `WorkerGlobalScope`; importing from Node installs no handler. */
const IN_WORKER = typeof self !== 'undefined'
  && typeof WorkerGlobalScope !== 'undefined'
  // eslint-disable-next-line no-undef
  && self instanceof WorkerGlobalScope;

if (IN_WORKER) {
  let started = false;
  self.onmessage = (event) => {
    const msg = event && event.data;
    if (!msg || msg.type !== 'run') return;
    // CONTRACT.md §(d): exactly one `run` message, ever.
    if (started) return;
    started = true;

    // `readSources` sends a `SourceRef[]` and nothing else.
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
