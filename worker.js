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
  QUARTER_MILE_M, DEFAULT_DEPARTURE, BOARD_SLACK_S, hmsToS, coord,
} from './lib/core.js';
import { Projection } from './lib/geo.js';
import { openCache } from './lib/cache.js';

import {
  loadFeed, normaliseTimes, feedWindow, setFeedLogger, s1Median,
} from './gtfs/feed.js';
import {
  dayTypes, buildServiceDay, clusterStations, invalidateDerived,
} from './gtfs/service.js';
import { raptor, raptorReverse } from './gtfs/raptor.js';
import {
  zoneCover, buildZones, networkMetrics, routeHeadways, s1Percentiles,
} from './gtfs/network.js';
import {
  inferHub, inferBorder, inferGameSize, travelTimeSamples, gtfsQuestionFacts,
  setInferLogger,
} from './gtfs/infer.js';
import { collectGeodata, emptyGeoData } from './osm/geodata.js';
import { openWorld, worldStatsLine, DEFAULT_WORLD_BASE_URL } from './osm/worldfile.js';
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

/** Code-point comparator. Never `localeCompare` — that is locale-dependent. */
function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

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

  /** Enter phase `i`, retiring every earlier phase's weight. */
  begin(i, label) {
    this.index = i;
    let base = 0;
    for (let j = 0; j < i; j++) base += PHASES[j][2];
    this.base = base * this.scale;
    this.report(0, label);
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
 * @param {File|Blob|ArrayBuffer|Uint8Array|string} source the picked file or the URL
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

  // ── S1 load feed ──────────────────────────────────────────────────────────
  let feed;
  let start;
  let end;
  let asOf;
  let types;
  try {
    progress.begin(0, 'Reading the feed');
    feed = await loadFeed(source, cache, {
      onProgress: ({ done, total }) => {
        if (total) progress.report(done / total, 'Reading the feed');
      },
    });
    progress.finish();

    progress.begin(1, 'Normalising times');
    normaliseTimes(feed);
    invalidateDerived(feed);
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
    progress.begin(2, 'Building service days');
    days = [];
    for (let i = 0; i < types.length; i++) {
      days.push(buildServiceDay(feed, types[i], proj, { boardSlackS: opts.boardSlackS }));
      progress.report((i + 1) / types.length, `Building service days (${i + 1}/${types.length})`);
    }
    // `max(days, key=(trips, day_type.key))` — the Python's tuple order, so a tie
    // on trips is broken by the LARGER day key.
    best = days[0];
    for (const d of days) {
      if (d.trips > best.trips
        || (d.trips === best.trips && cmpStr(d.dayType.key, best.dayType.key) > 0)) best = d;
    }
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
  let origin;
  let depS;
  try {
    progress.begin(3, 'Finding the round-start station');
    hub = inferHub(feed, best, proj);
    progress.finish();

    progress.begin(4, 'Measuring the network');
    // First pass at the rulebook's default zone radius: the size vote reads
    // `nZones`, and `nZones` depends on the radius, so the radius the size
    // resolves to cannot be used to compute the vote. The CLI does the same and
    // then re-runs the whole metric table at the real radius below.
    metrics = networkMetrics(feed, days, proj, hub, QUARTER_MILE_M);
    progress.finish();

    [size, sizeInference] = inferGameSize(metrics, opts);
    border = inferBorder(feed, best, hub, size, proj, opts);

    progress.begin(5, 'Covering the map with hiding zones');
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
    headways = routeHeadways(feed, days);
    gtfsFacts = gtfsQuestionFacts(feed, days, zones, stations);
    progress.finish();

    // generate.py: `--start` is resolved here, not inside infer.js,
    // and the departure `or` chain lets a literal '00:00:00' fall through to 09:00.
    origin = opts.startStopId || hub.stopId;
    depS = hmsToS(opts.departure || DEFAULT_DEPARTURE) || hmsToS(DEFAULT_DEPARTURE);

    progress.begin(6, 'Sampling ride times');
    // The CLI computes this last; CONTRACT.md §(d) needs it in the `'network'`
    // payload and every input already exists. Pure function, same value.
    travelSamples = travelTimeSamples(feed, days, zones, origin, depS, proj);
    progress.finish();
  } catch (err) {
    fatal('network', err);
    return null;
  }

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
      stops: stopRows(feed, best, zones),
      proj: proj.toJSON(),
    },
  });

  // ── S2 geodata ────────────────────────────────────────────────────────────
  //
  // CONTRACT.md §(f)1: a failed map-file read is not fatal. `--no-osm` is the same
  // path with a different note.
  let geo;
  progress.begin(7, 'Reading the map files');
  if (opts.useOsm) {
    try {
      // One manifest fetch, then every category is a Range request against an
      // immutable file. `opts.worldBaseUrl` exists so a build can be pointed at a
      // local static server before it is published — the Advanced panel's "Map file
      // base URL" field sets it, and null means "the published bucket".
      const baseUrl = opts.worldBaseUrl || DEFAULT_WORLD_BASE_URL;
      if (opts.worldBaseUrl) log('info', `reading the map files from ${baseUrl}`);
      const world = await openWorld(baseUrl);
      geo = await collectGeodata(world, opts, border, zones, proj, size.zoneRadiusM, {
        onProgress: progress.sink(),
        onLog: (level, message) => log(level === 'warning' ? 'warn' : level, message),
      });
      log('info', worldStatsLine(world));
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
    progress.begin(8, 'Auditing the question deck');
    questions = auditQuestions(size, geo, gtfsFacts, zones, metrics, border, {
      onProgress: progress.sink(),
    });
    curses = auditCurses(size, geo, gtfsFacts, geo.admin.countryCode);
    progress.finish();

    progress.begin(9, 'Measuring information resistance');
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
  progress.begin(10, 'Scoring the city');
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
  progress.begin(11, 'Writing the receipts');
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
    stops: stopRows(feed, best, zones),
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
 */
function stopRows(feed, day, zones) {
  const owner = Object.create(null);
  for (const z of Array.from(zones).sort((a, b) => cmpStr(a.zoneId, b.zoneId))) {
    for (const sid of z.stopIds) if (owner[sid] === undefined) owner[sid] = z.zoneId;
  }
  const rows = [];
  for (const sid of day.servedStopIds) {
    const stop = feed.stops[sid];
    if (!stop) continue;
    const sd = day.stopDays[sid];
    rows.push({
      stopId: sid,
      name: stop.name,
      lat: coord(stop.lat),
      lon: coord(stop.lon),
      routeIds: sd ? sd.routes.slice() : [],
      frequent: Boolean(sd && sd.frequent),
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

    // `readSource` on the main thread sets exactly one of `file` / `url`.
    const source = msg.file || msg.url;
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

export default runPipeline;
