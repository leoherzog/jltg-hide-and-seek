# CONTRACT.md

Authoritative for every shape that crosses a module boundary. If this file and your
intuition disagree, this file wins. If this file and the CODE disagree, that is a bug in
one of them — work out which, fix it, and say so in your report. Never silently diverge.

This file was written before the port, as the interface eleven parallel agents built
against: nothing composed unless every boundary shape was fixed in advance, which is why
it is this precise about sorting, key order and number formatting. Those rules are still
live and still the reason two runs agree.

The snake_case name in a field's trailing comment is its original in the Python CLI that
this code was ported from. That file has been deleted; the names are provenance, not a
reference you can follow.

**Scope.** `index.html`, plus `strategy.html` (S5) as a **fragment-only
second view of the same document** — §(g). S5 adds no worker stage, no `Report` field and no
embedded JSON block; it is built from `state.report` in memory.

---

## 0. Ground rules

| Rule | Detail |
|---|---|
| Modules | Plain ES modules. `export` / `import`. Relative paths, `.js` extension **required**. |
| No build | No bundler, no TypeScript, no npm runtime dep. Top-level `await` is fine. |
| Worker side | `lib/**`, `gtfs/**`, `osm/**`, `rules/**` run inside the Web Worker. **No DOM.** Allowed: `self`, `fetch`, `indexedDB`, `crypto`, `DecompressionStream`, `TextDecoder`, typed arrays, `structuredClone`. |
| Main side | `app.js`, `render/**`. DOM freely. |
| External assets | Only these five: WebAwesome kit `https://ka-p.webawesome.com/kit/95e68140d1204145/webawesome@3.12.0`; MapLibre `https://cdn.jsdelivr.net/npm/maplibre-gl/+esm` and `.../dist/maplibre-gl.min.css`; tiles `https://tiles.openfreemap.org/styles/positron` and `/dark`. The kit and the MapLibre stylesheet are `<link>`ed by `index.html` directly and have no constant — nothing in module code needs their URLs. The other three are exported from `lib/core.js` as `MAPLIBRE_JS`, `TILES_LIGHT`, `TILES_DARK`. |
| Still five | The landing-page feed picker added **none**. `data/feeds.json` is a **same-origin repo asset**, not an external one. A feed zip — a Mobility Database mirror URL or an agency's own — is **input**, the same category as a URL a reader pastes today, not a page asset. The polygon draw tool is **hand-rolled on the map's own events on purpose**, so that this list stays exhaustive: do not "improve" it with a pinned CDN module without amending the row above. |
| Determinism | No `Date.now()`, no `Math.random()`, no wall clock anywhere in the pipeline. Never iterate a `Map`/`Set`/object whose insertion order could vary without sorting first. Two runs over the same input must be byte-identical. |
| Numbers | Every number that reaches the UI goes through exactly one formatter from `lib/core.js`. No `toFixed`, no `Math.round`, no `Intl.NumberFormat` in the pipeline or the renderers. |
| Sorting strings | Python compares strings by code point, JS by UTF-16 code unit. Identical below U+10000. Use a plain `a < b ? -1 : a > b ? 1 : 0` comparator, never `localeCompare` (locale-dependent = non-deterministic). |
| Sorting numbers | `Array.prototype.sort()` is lexicographic by default. Always pass `(a, b) => a - b`. |
| Object key order | JS objects hoist integer-like keys (`'1','2','12'`) ahead of lexicographic order (`'1','12','2'`). Zone ids and stop ids are numeric strings on most feeds. **Never** rely on `Object.keys()` order — always `Object.keys(o).sort(cmp)`. `jdump()` already does this internally. |

---

## (a) Module map

| File | Side | Exports |
|---|---|---|
| `index.html` | main | — (page shell, 9 skeleton sections, WebAwesome head) |
| `styles.css` | main | — (`SHARED_CSS` + `INDEX_CSS`, ported) |
| `app.js` | main | `boot()` — main-thread controller, worker protocol, hydration dispatch |
| `render/html.js` | main | see §(e) |
| `render/verdict.js` | main | `renderHero`, `renderVerdict`, `renderScoreTrace`, `renderYourGame` |
| `render/map.js` | main | `renderKeyNumbers`, `renderNetworkMap`, `renderTransitReality` |
| `render/deck.js` | main | `renderQuestions`, `renderCurses`, `renderProvenance` |
| `render/strategy.js` | main | `renderStrategy`, `zoneViews`, `modeChips`, `poiCategories`; the constants `AXES`, `AXIS_IDS`, `AXIS_PLAIN`, `FLAG_TEXT`, `MODE_LABEL`, `MODE_ICON`, `MODE_CATEGORY`, `RADAR_ID_MILES`, `TABLE_PAGE`, `TABLE_PAGE_ABOVE`, `MAX_MAP_ZONES`, `SPOTS_SHIPPED`, `MAX_POI_PER_CATEGORY`, `TENTACLE_ID_REACH_MI`; the rounding helpers `pts`, `bar`, `band`. Pure `Report → string`, no DOM. Reads `QUESTIONS` from `rules/catalogue.js` for one field — a tentacle question's own `param`, which `QuestionAudit` does not carry across the wire. |
| `render/simulator.js` | main | `initStrategy(root, report)` — the only export `app.js` uses. Owns every DOM mutation in §(g)'s view; idempotent; imports from `strategy.js` one-way. |
| `render/landing.js` | main | `renderPickerCard`, `renderResults`, `renderResultsSummary`, `renderPicks`, `renderPickerNote`; the constants `PICK_CAP` (= `lib/core.js`'s `MAX_FEEDS_PER_RUN`), `PICK_WARN`, `BIG_DOWNLOAD_MB`. Pure `data → string`, no DOM — the landing feed picker's markup. |
| `render/picker.js` | main | `initPicker(root, handlers) → {setSelection, setByo, refresh, resize, destroy}` (`handlers.osmSkipped()` reports the live state of the Advanced panel's Skip OpenStreetMap switch, which lives outside this card) — the only export `app.js` uses. Owns every DOM mutation in the landing picker, the lazy MapLibre import and the hand-rolled draw tool; idempotent; imports from `landing.js` / `lib/catalog.js` / `lib/geo.js` one-way. Its map is `destroy()`ed in `enterRunningState`; it must never be merged into `PAGE_RUNTIME_JS`. |
| `worker.js` | worker | — (module worker entry; pipeline orchestrator, stage emitter) |
| `lib/core.js` | worker+main | numbers, formatting, deterministic JSON, hashing, constants |
| `lib/geo.js` | worker+main | geometry toolkit |
| `lib/catalog.js` | main | `loadCatalog`, `feedUrlOf`, `visibleRows`, `searchCatalog` (→ `{rows, total}`, so a truncated list can say how many more matched), `rowsIntersectingRing`, `centroidOf`, `spanKmOf`, `labelOf`, `placeOf`, `sourceRefFor`, `CATALOG_VERSION`. Reads `data/feeds.json` — a **same-origin repo asset**, generated offline by `tools/mdb-snapshot.mjs` and reviewed as a diff, NOT a sixth external asset. No DOM, no MapLibre; importable from Node. |
| `lib/cache.js` | worker | `openCache`, `Cache`, `CacheMiss` — content-addressed IndexedDB cache |
| `lib/http.js` | worker | `httpFetch`, `sleep` — fetch with mirror failover, retries, courtesy sleep |
| `gtfs/feed.js` | worker | `loadFeed`, `unzip`, `normaliseTimes`, `feedWindow`, `StopTimes`, `attachStopTimes`, `stopTimesOf` (the last three exist for `gtfs/merge.js`; `StopTimes.appendFrom` is how a merge copies a columnar store) |
| `gtfs/merge.js` | worker | `mergeFeeds`, `mergeOrder`, `feedSourceRows`, `MERGE_TABLES`, `NAMESPACED_COLUMNS` — table-level merge of several feeds into one `Feed` |
| `gtfs/service.js` | worker | `dayTypes`, `buildServiceDay`, `clusterStations`, `noServiceDates` |
| `gtfs/raptor.js` | worker | `raptor`, `raptorReverse`, `buildJourney` |
| `gtfs/network.js` | worker | `zoneCover`, `buildZones`, `networkMetrics`, `routeHeadways`, `radarLiveness` |
| `gtfs/infer.js` | worker | `inferHub`, `inferBorder`, `inferGameSize`, `travelTimeSamples`, `gtfsQuestionFacts` |
| `osm/flatgeobuf.js` | worker | `FlatGeobufReader`, `levelBounds`, `nodeCount`, `GEOMETRY_TYPE`. Pure transport: reads a FlatGeobuf over HTTP Range, knows nothing about parks. |
| `osm/worldfile.js` | worker | `openWorld`, `worldPois`, `worldCount`, `worldDensity`, `worldAdminAreas`, `adminAreasAt`, `featuresToPois`, `representativeFromGeometry`, `worldProvenance`, `worldStatsLine` |
| `osm/geodata.js` | worker | `GEO_CATEGORIES`, `CAR_STREET_SELECTOR`, `FOOT_WAY_SELECTOR`, `LOW_STREETVIEW_COUNTRIES`, `collectGeodata`, `buildPoiIndex`, `zoneInventory`, `adminInfo`, `curseCounts`, `legalEndgameSpots`, `emptyGeoData` |
| `rules/catalogue.js` | worker+main | `QUESTIONS`, `CURSES`, `INTERPRETATIONS`, `catalogueFor`. Frozen data importing nothing but `lib/core.js`, so `render/deck.js` and `render/strategy.js` read it on the main thread for the question fields `QuestionAudit` does not carry. The size table lives in `gtfs/network.js` as `S1_SIZE_PARAMS`, and the radar radii as `S1_RADAR_MILES` — a *different* list from the one this file used to carry. |
| `rules/audit.js` | worker | `answerSignature`, `survivalFractions`, `globalQuestionOrder`, `auditQuestions`, `auditCurses` |
| `rules/score.js` | worker | `ramp`, `rramp`, `plateau`, `tenths`, `scoreFitness`, `fitnessCaps`, `scoreZones`, `rankZones`, `selectDossiers`, `deriveFindings`, `deriveRecommendations`, `buildProvenance` |

### `lib/core.js` — exported symbols (already written)

Constants: `GENERATOR VERSION M_PER_MILE M_PER_KM QUARTER_MILE_M HALF_MILE_M
SQM_PER_SQMI EARTH_R_M WALK_SPEED_MPS WALK_RADIUS_M WALK_CIRCUITY BOARD_SLACK_S
MAX_TRANSFERS DEFAULT_DEPARTURE SERVICE_DAY_SECONDS HEADWAY_WINDOW MIDDAY_WINDOW
EVENING_WINDOW FREQUENT_HEADWAY_MIN STATION_CLUSTER_M HUB_SNAP_M T90_ORIGIN_STRIDE
RADAR_SAMPLE_PAIRS RADAR_DEAD_HIGH RADAR_DEAD_LOW SEEKER_SAMPLE_CAP
SURV_FULL_UNIVERSE_MAX HUB_RADIAL_MIN HUB_SEMI_RADIAL_MIN
MAPLIBRE_JS TILES_LIGHT TILES_DARK MAX_FEEDS_PER_RUN IMPERIAL_COUNTRIES`

Functions: `rhu num pct mins miles km sqmi coord hhmm hhmmss hmsToS prettyDate
dowOf dateRange lowerMedian quantile normalise jdump sha256Bytes sha256Text`

Notes:
* `num(x, dp = 0, {comma = true})`. Python keyword args are a trailing options object.
* `jdump(obj, {floatDp = 6})`.
* `HEADWAY_WINDOW`/`MIDDAY_WINDOW`/`EVENING_WINDOW` are frozen 2-element arrays of `'HH:MM:SS'`.
* `MAX_FEEDS_PER_RUN` is the run's feed cap (6). It lives in `lib/core.js` because three modules have to agree on it and none may own it: the picker refuses the seventh pick, `readSources` refuses a seventh that arrived by the other door (six map picks plus a dropped zip), and `normaliseSources` refuses one the worker was handed anyway.
* `IMPERIAL_COUNTRIES` is a frozen **sorted Array** (`['gb','lr','mm','us']`), not a Set, so it is clone-safe. Use `.includes()`.
* **`sha256Text` and `sha256Bytes` are `async`** — `crypto.subtle.digest` returns a Promise. Every caller must `await`. This is the one signature that differs from the Python.
* `rhu` is round-**half-up** implemented on the shortest round-trip decimal string. Verified equal to `Decimal(repr(x)).quantize(…, ROUND_HALF_UP)` on the boundary cases (`2.675→2.68`, `1.005→1.01`, `0.145→0.15`, `-0.5→-1`). Do not "simplify" it to `toFixed`.
* `num(-0.4)` returns `'-0'`. Python does too. Kept deliberately.
* `hhmm`/`hhmmss` never modulo 86400. `hhmm(87360) === '24:16'`.
* `dowOf`/`dateRange`/`prettyDate` are pure calendar arithmetic on `'YYYYMMDD'`. **Never** `new Date(string)` — that reads the host timezone. `prettyDate` hard-codes English abbreviations so it cannot follow the browser locale.

### `lib/geo.js` — exported symbols (already written)

`haversineM Projection bboxOf bboxExpand bboxContains segIntersects bboxIntersectsRing
convexHull polygonArea ringCentroid pointInRing representativePoint polylineMidpoint
segPointDist ringWithin minEnclosingCircle GridIndex`

Conventions:
* Geographic point = `[lat, lon]` degrees. Planar point = `[x, y]` metres. Bbox = `[S, W, N, E]` (**Overpass order, not GeoJSON**). Ring = array of planar points, first point NOT repeated.
* `Projection` is a class: `new Projection(lat0, lon0)`, `Projection.about(points)`, `Projection.from({lat0, lon0})`. Methods `xy(lat, lon) → [x, y]`, `lonlat(x, y) → [lon, lat]` (note the order — mirrors Python), `latlon(x, y) → [lat, lon]` (JS-only convenience), getters `mPerDegLat` / `mPerDegLon`, `toJSON() → {lat0, lon0}`. **Projection instances are class instances and cannot cross `postMessage`** — send `{lat0, lon0}` and rebuild with `Projection.from()`.
* `segIntersects(a, b, c, d) → boolean` is the planar orientation test, collinear overlap included. `bboxIntersectsRing(bbox, ring) → boolean` answers "does this `[S,W,N,E]` box overlap this ring at all", and checks **all three** cases — a box corner inside the ring, a ring vertex inside the box, and a box edge crossing a ring edge — because any one alone is quietly wrong. Both are used by the landing picker to decide which feeds a drawn shape sweeps up.
* `GridIndex(cell)`: `.add(key, x, y)`, `.addBbox(key, minx, miny, maxx, maxy, {cap = 400}) → boolean`, `.near(x, y, radius) → [[key, x, y], …]` sorted by `String(key)`, `.nearKeys(x, y, radius) → [key, …]` deduped + sorted. `radius` may be `Infinity`; the 3×3 neighbourhood restriction still applies (that is intentional and load-bearing for the area-index callers). Holds a `Map` — **not clone-safe**, build inside the worker.
* `minEnclosingCircle` returns `[cx, cy, r]`. It uses a fixed-seed `mulberry32(0)` Fisher–Yates over the sorted+deduped point list. **This is the one intentional divergence from the CLI**, which uses `random.Random(0)` (Mersenne Twister). Fixed permutation, not entropy; the circle is permutation-invariant up to fp noise well inside the existing `1e-7` slack.

### Constants NOT in `core.js` — owned by `lib/http.js`

Transcribed here so nobody guesses (generate.py):

```js
export const HTTP_TIMEOUT_S = 300.0;
export const HTTP_ATTEMPTS_PER_ENDPOINT = 2;
export const HTTP_BACKOFF_S = 8.0;            // between attempts on the same endpoint
```

`httpFetch` now has exactly one caller — `gtfs/feed.js` downloading the feed zip. The
Overpass endpoint list, the Nominatim endpoint, both courtesy sleeps and
`OVERPASS_WAY_BUDGET` are **gone**: the OSM layer reads prebuilt FlatGeobuf world files
over HTTP Range (`osm/flatgeobuf.js`), which calls `fetch` directly and touches neither
`lib/http.js` nor the cache. See `tools/osm-world/README.md`.

The LLM constants (`LLM_URL`, `LLM_MODEL`) and everything under `--llm` are **dropped** from
the port.

---

## (b) Data shapes

All shapes are plain JS objects. Field names are camelCase; the trailing comment gives the
snake_case Python original it was ported from — provenance only; that file is gone.

Python `frozenset` → JS **Array, sorted** unless stated otherwise (a `Set` is not
clone-safe). Python `tuple` → JS **Array**. Python `dict[str, X]` → JS plain object keyed
by string; **iteration order is never significant** — sort the keys.

### Feed layer

```js
/**
 * @typedef {Object} Stop            // class Stop. One GTFS stop (a pole, not a station).
 * @property {string} stopId         // stop_id
 * @property {string} name           // name
 * @property {string} baseName       // base_name — directional suffix like ' (NB)' stripped
 * @property {number} lat            // lat, degrees
 * @property {number} lon            // lon, degrees
 * @property {string} code           // code, default ''
 * @property {string} parentStation  // parent_station, default ''
 */

/**
 * @typedef {Object} Route           // class Route.
 * @property {string} routeId        // route_id
 * @property {string} shortName      // short_name
 * @property {string} longName       // long_name
 * @property {number} routeType      // route_type
 * @property {string} color          // color, default ''
 * @property {string} label          // Route.label property — shortName || longName || routeId. MATERIALISED, not a getter (clone-safe).
 * @property {boolean} isRail        // Route.is_rail property — routeType ∈ {0,1,2,5,7,11,12}. MATERIALISED.
 */

/**
 * @typedef {Object} Feed            // class Feed. Parsed, normalised GTFS feed.
 * `tables` holds every *.txt as an array of plain objects exactly as read (optional
 * columns accessed with `?? ''`). The typed fields are the normalised views.
 * @property {string} source                       // source — the URL, or the File name
 * @property {string} sha256                       // sha256 — lowercase hex of the zip bytes
 * @property {Object<string, Object<string,string>[]>} tables  // tables — keyed by table name WITHOUT '.txt'
 * @property {Object<string, Stop>} stops          // stops — stop_id → Stop. Sort keys before iterating.
 * @property {Object<string, Route>} routes        // routes — route_id → Route. Sort keys before iterating.
 * @property {string} agencyName                   // agency_name
 * @property {string} agencyUrl                    // agency_url
 * @property {string} timezone                     // timezone — IANA tz name; DISPLAY ONLY, never used for arithmetic
 * @property {string} feedStart                    // feed_start, 'YYYYMMDD'
 * @property {string} feedEnd                      // feed_end,   'YYYYMMDD'
 * @property {string} feedVersion                  // feed_version, default ''
 * @property {string} publisher                    // publisher, default ''
 * @property {FeedSourceRow[]} sources             // one row per input feed, in merge order. Length 1 for an ordinary run; `worker.js` attaches it on EVERY path so no renderer branches on the count.
 * @property {string} [fareAgency]                 // MERGED FEEDS ONLY: whose `fare_attributes` rows the merge carried, so the fare house rule can name them. Absent on a single-feed run, which is why that run's wording is unchanged.
 */

/**
 * @typedef {Object} FeedSourceRow   // one input feed of a run. Clone-safe; §09 prints them all.
 * @property {string} tag            // 'f0' — the namespace prefix, minus its colon
 * @property {string} label          // what the page calls it: 'The Rapid', 'mbta.zip'
 * @property {string} source         // the URL or File name `loadFeed` recorded
 * @property {string} sha256         // this feed's own hash — NOT the merged one
 * @property {number|null} mdbId     // Mobility Database source id, or null
 * @property {string} agencyName @property {string} agencyUrl @property {string} timezone
 * @property {string} feedStart @property {string} feedEnd @property {string} feedVersion
 * @property {number} stops @property {number} routes @property {number} trips
 */

/**
 * @typedef {Object} Station         // class Station.
 * A synthesised station: a cluster of stops that a player would call one place.
 * @property {string} stationId      // station_id — the lowest member stopId, for stability
 * @property {string} name           // name
 * @property {number} lat            // lat
 * @property {number} lon            // lon
 * @property {string[]} stopIds      // stop_ids — sorted
 */
```

#### Merging several feeds — `gtfs/merge.js`

A run may read more than one feed. `worker.js` loads each one, merges them at table
level, and hands the rest of the pipeline a single `Feed`; nothing downstream can tell
the difference.

* **The identity rule.** `mergeFeeds([f]) === f` — reference equality, no copy, no table
  touched, no typed view rebuilt. A single-source run cannot drift because on that path
  the merge does nothing at all, and `tools/smoke.mjs` asserts it with a literal `===`.
  Do not "tidy" the fast path away.
* **Merge order is content-addressed**: feeds are sorted by `(sha256, source, input
  index)`, code-point, and tagged `f0`, `f1`, … in that order. The merged feed is a pure
  function of the feed bytes — independent of which download finished first, of the main
  thread's own sort key, and of which source failed and was dropped.
* **Ids are namespaced ALWAYS, not on collision.** Every id column grows a `f{i}:`
  prefix. An id whose spelling depends on which *other* feed was picked is a trap for
  `startStopId` / `excludeStops` and for anyone reading a stop id off the page. If any
  input already spells an id `f0:…`, every prefix escalates uniformly to `f{i}::`.
  A blank id stays blank, with one exception: a feed declaring exactly one agency may
  omit `agency_id` on either side of the route→agency join, and both sides are filled
  with that agency's namespaced id (or the bare tag when it has none).

  | table | namespaced columns |
  |---|---|
  | `agency` | `agency_id` |
  | `stops` | `stop_id`, `parent_station` |
  | `routes` | `route_id`, `agency_id` |
  | `trips` | `trip_id`, `route_id`, `service_id`, `shape_id`, `block_id` |
  | `stop_times` | `trip_id`, `stop_id` — through the interning tables, never `rowAt()` |
  | `calendar`, `calendar_dates` | `service_id` |
  | `transfers` | `from_/to_` `stop_id`, `trip_id`, `route_id` |
  | `frequencies` | `trip_id` |
  | `shapes` | `shape_id` |
  | `fare_attributes`, `feed_info` | none — see below |

* **`MERGE_TABLES` is an allowlist of twelve**, never a denylist: `agency`, `calendar`,
  `calendar_dates`, `fare_attributes`, `feed_info`, `frequencies`, `routes`, `shapes`,
  `stop_times`, `stops`, `transfers`, `trips`. Everything else in the archive is dropped,
  because an extension table nobody here has heard of carries un-namespaced ids and
  dropping it is the only way to be sure one cannot leak through.
* **`fare_attributes` carries exactly ONE feed's rows.** The primary feed — the one running
  the most trips, ties falling to merge order — supplies them when it has any; when it ships
  no `fare_attributes.txt` at all, the first feed in merge order that HAS fares supplies them
  instead. `deriveRecommendations` prints `fare_attributes[0]`'s price as *the* fare for the
  map, so a concatenated table would quote one operator's fare as the merged system's — and
  taking the primary's empty table would silently delete the house rule a small city produces
  on its own beside a big fare-less neighbour (MBTA has no fares; The Rapid does). `Feed`
  gains `fareAgency` on the merged path, so the sentence names whose fare it is.
* **`feed_info` is one synthesised row** carrying the merged window, so `_s1WindowDates`
  over merged tables agrees with the window the merge computed instead of recovering the
  union of the calendars. Each feed keeps its own `calendar` / `calendar_dates` rows.
* **The window is the INTERSECTION** — `max(feedStart)` … `min(feedEnd)` — because
  `dayTypes` picks a representative date by trip count over the window and a union would
  happily land on a date one feed runs nothing on. An empty intersection falls back to
  the union and emits a `degraded`; an intersection under seven days emits one too.
* **Mixed timezones warn, never refuse.** `Feed.timezone` is display-only and every time
  in the pipeline is feed-local seconds since midnight, so a mixed-zone merge is wrong
  about exactly one thing — the clock alignment of a ride *between* the systems — and
  that is a `degraded` message, not a crash. `merged.timezone` is the primary feed's.
* **Cross-feed connectivity is free.** `s1Footpaths` (`gtfs/service.js`) builds footpaths
  geometrically from stop proximity within `WALK_RADIUS_M` and only *consults*
  `transfers.txt`, so two agencies whose stops sit 40 m apart connect with no
  `transfers.txt` row between them.
* **No merged-artifact cache.** The per-source download cache is unchanged
  (`httpFetch`'s `cacheKey` is the exact URL). A `Feed` holds typed arrays and a Proxy
  and is not serialisable; the only expensive part is already cached per source, so two
  overlapping selections that both include one city download it once. `merged.sha256` is
  the hash of the tagged per-feed hashes — a run **identity**, not a storage key.

### Service-day layer

```js
/**
 * @typedef {Object} DayType         // class DayType.
 * One distinguishable kind of service day in the feed.
 * @property {string} key            // key — 'weekday' | 'saturday' | 'sunday' | 'dow{N}'
 * @property {string} label          // label — 'Weekday', 'Saturday', …
 * @property {string} date           // date — representative 'YYYYMMDD', chosen by lower-median trip count
 * @property {string[]} dates        // dates — every date of that type in the window, ascending
 * @property {string[]} serviceIds   // service_ids — sorted
 * @property {number} trips          // trips
 * @property {number[]} tripCounts   // trip_counts — parallel to `dates`, for the spread report
 */

/**
 * @typedef {Object} StopDay         // class StopDay. Per-stop facts on one service day.
 * @property {string} stopId              // stop_id
 * @property {number[]} departures        // departures — seconds since service-day start, sorted ascending
 * @property {string[]} routes            // routes — route_ids, sorted
 * @property {number|null} first          // first — seconds
 * @property {number|null} last           // last — seconds
 * @property {number|null} medianHeadwayS // median_headway_s — over HEADWAY_WINDOW, all routes combined
 * @property {number|null} worstGapS      // worst_gap_s — seconds
 * @property {boolean} frequent           // frequent — some single (route, direction) ≤ 15 min
 */

/**
 * @typedef {Object} ServiceDay      // class ServiceDay.
 * One materialised service day: everything RAPTOR and the metrics need.
 * @property {DayType} dayType                 // day_type
 * @property {Object<string, StopDay>} stopDays// stop_days — stop_id → StopDay. Sort keys before iterating.
 * @property {string[]} servedStopIds          // served_stop_ids — sorted
 * @property {string[]} routeIds               // route_ids — sorted
 * @property {number} trips                    // trips
 * @property {number} stopEvents               // stop_events
 * @property {number} firstDeparture           // first_departure, seconds
 * @property {number} lastDeparture            // last_departure, seconds
 * @property {*} patterns                      // patterns — OPAQUE RAPTOR structure, owned by gtfs/service.js
 * @property {*} patternAtStop                 // pattern_at_stop — OPAQUE
 * @property {*} footpaths                     // footpaths — OPAQUE
 * @property {*} stopIndex                     // stop_index — OPAQUE
 * @property {*} extras                        // day._s1x (_S1DayExtras) — OPAQUE per-day vectors
 */
```

> The four `patterns` / `patternAtStop` / `footpaths` / `stopIndex` fields and `extras`
> are **internal to `gtfs/`** and are typed arrays / Maps. They **must be stripped**
> before any `ServiceDay` crosses `postMessage`. See §(d) — the `'days'` stage sends
> summaries, not `ServiceDay` objects.
>
> Internal shapes, for the GTFS agent only:
> `_S1StopIndex {byId: Map<string,number>, ids: string[]}`;
> `_S1Pattern {stops:number[], dep:number[][], arr:number[][], tripIds:string[], tripRoutes:string[], routeId:string, directionId:string, sortedCols:boolean}` — column-major so the board lookup is a bisect; `sortedCols === false` ⇒ this pattern overtakes itself, scan linearly;
> `_S1DayExtras {tripRoute, dedup, routeDirStop, stopRoutes, stopName, routeLabel}`.

### Routing layer

```js
/**
 * @typedef {Object} JourneyLeg      // one element of Journey.legs; keys are fixed by build_journey.
 * @property {'walk'|'transit'} mode
 * @property {string} route          // display label; '' for a walk leg
 * @property {string} routeId        // route_id; '' for a walk leg
 * @property {string} [tripId]       // trip_id; transit legs only
 * @property {string} from           // origin stop display name
 * @property {string} fromId         // origin stop_id
 * @property {string} to             // destination stop display name
 * @property {string} toId           // destination stop_id
 * @property {number|null} dep       // seconds since service-day start; null on a walk leg
 * @property {number|null} arr       // seconds; null on a walk leg
 */

/**
 * @typedef {Object} Journey         // class Journey. A concrete itinerary.
 * @property {number} minutes        // minutes
 * @property {number} transfers      // transfers — count of transit legs minus 1, floored at 0
 * @property {JourneyLeg[]} legs     // legs — ordered
 */

/**
 * @typedef {Object} TravelTimes     // class TravelTimes. One one-to-all RAPTOR run.
 * @property {string[]} originStopIds          // origin_stop_ids
 * @property {number} departureS               // departure_s
 * @property {Object<string, number>} arrivalS // arrival_s — stop_id → earliest arrival seconds; ABSENT KEY = unreachable (never Infinity, never null)
 * @property {Object<string, number>} rounds   // rounds — stop_id → transfers used by the best journey
 */
```

### Inference layer

```js
/**
 * @typedef {Object} GameSize        // class GameSize. Rulebook size parameters.
 * @property {'small'|'medium'|'large'} name  // name
 * @property {number} hidingPeriodMin         // hiding_period_min — 30 / 60 / 180
 * @property {number} zoneRadiusM             // zone_radius_m — QUARTER_MILE_M / QUARTER_MILE_M / HALF_MILE_M
 * @property {number} tentacleReachMi         // tentacle_reach_mi — 0.0 / 1.0 / 15.0. The deck's headline reach only: a LARGE deck holds 1-mile AND 15-mile tentacle questions at once, so per-question reach comes from `QuestionDef.param`, never from here. SMALL is 0 because the rulebook bars the category.
 * @property {number[]} thermometerMi         // thermometer_mi — cumulative: (0.5,3) / (0.5,3,10) / (0.5,3,10,50)
 * @property {number} categoryCount           // category_count — 5 / 6 / 6
 * @property {number} catalogueSize           // catalogue_size — 58 / 71 / 80
 * @property {number} photoLimitMin           // photo_limit_min — 10 / 10 / 20
 * @property {number} otherLimitMin           // other_limit_min — 5
 * @property {number} moveGrantMin            // move_grant_min — 10 / 20 / 60
 * @property {number} requiredHours           // required_hours — 6 / 10 / 12. INFERRED, not transcribed: the rulebook gives a size's length only as prose ("lasts 4–8 hours" / "about 1 day" / "2 to 4 days") and never an hours-per-playing-day figure. Metrics built on it are tagged `interp`.
 * @property {boolean} inferred               // inferred — false when options.sizeOverride forced it
 */

/**
 * @typedef {Object} SizeAxis        // one element of SizeInference.axes
 * @property {string} id @property {string} name @property {number} value
 * @property {string} unit @property {number} score  // 0 small / 1 medium / 2 large
 * @property {number[]} thresholds
 */

/**
 * @typedef {Object} SizeInference   // class SizeInference.
 * The four-axis size vote, kept in full because the page shows the disagreement.
 * @property {SizeAxis[]} axes       // axes
 * @property {number[]} votes        // votes
 * @property {'small'|'medium'|'large'} verdict // verdict
 * @property {boolean} unanimous     // unanimous
 * @property {boolean} clamped       // clamped
 * @property {string} note           // note
 */

/**
 * @typedef {Object} Hub             // class Hub. Round-start station + network shape.
 * @property {string} stopId         // stop_id
 * @property {string} name           // name
 * @property {number} lat @property {number} lon
 * @property {number} routeShare     // route_share, 0..1
 * @property {number} tripShare      // trip_share, 0..1
 * @property {'radial-hub'|'semi-radial'|'polycentric'} shape // shape
 * @property {Array<[string,string]>} alternatives // alternatives — [stopId, name] runners-up
 * @property {boolean} dominant      // dominant — false ⇒ do NOT name a single hub in the UI
 */

/**
 * @typedef {Object} Border          // class Border. Both a box and a circle; the rulebook sanctions both.
 * @property {'bbox'|'circle'} kind                 // kind
 * @property {[number,number,number,number]} bbox   // bbox — (S, W, N, E), padded
 * @property {[number,number,number,number]} rawBbox// raw_bbox — unpadded
 * @property {[number,number,number]} circle        // circle — (lat, lon, radiusM)
 * @property {number} padM                          // pad_m
 * @property {Object} geojson                       // geojson — a GeoJSON Feature, {type:'Feature', properties:{kind}, geometry:{type:'Polygon', coordinates:[ring]}}; ring is [lon,lat] pairs, closed
 * @property {number} areaSqM                       // area_sq_m
 * @property {string[]} trimmedStopIds              // trimmed_stop_ids — stops ruled out-of-map, sorted
 */

/**
 * @typedef {Object} Zone            // class Zone.
 * One candidate hiding zone: a rulebook circle centred on a designated station.
 * @property {string} zoneId         // zone_id — IS the designated stop_id
 * @property {string} name           // name
 * @property {number} lat @property {number} lon
 * @property {number} x              // x — projected metres
 * @property {number} y              // y
 * @property {string[]} stopIds      // stop_ids — every served stop inside the circle, sorted
 * @property {string[]} routeIds     // route_ids — every route at any of those stops, sorted
 * @property {number} stopEvents     // stop_events
 */
```

### OSM layer

```js
/**
 * @typedef {Object} GeoCategory     // class GeoCategory.
 * One rulebook feature category and the exact Overpass selector that realises it.
 * @property {string} key            // key
 * @property {string} label          // label
 * @property {string} selector       // selector — Overpass QL with `{{bbox}}` UNSUBSTITUTED; printed verbatim on the page
 * @property {string} note           // note
 */

/**
 * @typedef {Object} Poi             // class Poi. One OSM feature reduced to what the questions need.
 * `lat`/`lon` is the REPRESENTATIVE POINT (the rulebook's "map icon"): a node's own
 * coordinates, a closed way's area centroid with an interior fallback, an open way's
 * length-weighted midpoint, or a multipolygon's area-weighted centroid. NEVER Overpass's
 * `out center`, which is the bbox centre.
 * `rings` carries polygon geometry only for categories where containment is needed
 * (parks and water): the photo questions ask about the polygon while the
 * matching/measuring questions ask about the icon. Never interchange the two predicates.
 * @property {string} category                       // category
 * @property {'node'|'way'|'relation'} osmType        // osm_type
 * @property {number} osmId                           // osm_id
 * @property {string} name                            // name
 * @property {number} lat @property {number} lon
 * @property {Object<string,string>} tags             // tags, default {}
 * @property {Array<Array<[number,number]>>} rings    // rings — GEOGRAPHIC [lat, lon] pairs, default []. Project with `Projection.xy` before any geometry call.
 */

/**
 * @typedef {Object} OverpassQueryRecord  // class OverpassQueryRecord.
 * @property {string} key                             // key
 * @property {string} selector                        // the Overpass QL that DEFINES the category. Retained
 *                                                    //   deliberately: it is what the world-file build table was
 *                                                    //   translated from, and a player can still re-run it.
 * @property {[number,number,number,number]} bbox     // bbox
 * @property {number} count                           // count
 * @property {string} cacheKey                        // ALWAYS ''. Vestigial — kept so the record shape is stable.
 * @property {string} endpoint                        // A world-file description: the layer's URL followed by feature
 *                                                    //   count, size, planet snapshot and sha256 prefix. For a layer
 *                                                    //   that is absent or empty there is no file, so it is prose
 *                                                    //   only and no URL appears. See worldProvenance.
 * @property {boolean} partial                        // TWO meanings now. (1) a size guard forced a degraded query,
 *                                                    //   as before; (2) for the six density-grid categories, always
 *                                                    //   true — the map-wide total is EXACT but the per-zone
 *                                                    //   breakdown is approximate. See §(f) rule 3.
 */

/**
 * @typedef {Object} AdminInfo       // class AdminInfo.
 * The administrative-division ladder for this map. `ordinals` maps 1..4 → OSM
 * `admin_level`, DERIVED not guessed: the first-division level is the LOWEST
 * `admin_level` in the map's `admin` layer carrying an `ISO3166-2` code — ISO 3166-2 is
 * by definition the code of a country's principal subdivision — and ordinals 2–4 are the
 * distinct levels present across all zone centres above it. This used to come from
 * Nominatim's `ISO3166-2-lvl<N>` key; it is now read off the polygons instead of asked
 * for, and no network service is consulted. A missing ordinal is `null` and must render
 * as "no Nth division here", never as a guessed level. Unknown country ⇒ every admin
 * question is `unknown`, NOT `dead`.
 * @property {string|null} countryCode                       // country_code — ISO-3166-1 alpha-2, lowercase
 * @property {string|null} countryName                       // country_name
 * @property {string|null} placeName                         // place_name
 * @property {Object<string, number|null>} ordinals          // ordinals — keys '1'..'4' as STRINGS
 * @property {Object<string, Object<string,string>>} perZone // per_zone — zoneId → ordinal('1'..'4') → division name
 * @property {Object<string, boolean>} borderLevels          // border_levels — ordinal → does a boundary line cross the map
 * @property {'world'|'unknown'} source                      // source — 'world' = the admin FlatGeobuf layer
 */
```

The world-file manifest may carry **`admin_source`** (`tools/osm-world/merge.py` writes
`"overture"`; absent or `"osm"` means the admin layer is OSM boundary relations and the
client behaves exactly as documented above). Under `"overture"` the admin layer's levels
are SYNTHETIC — country=2, dependency=3, region=4, county=6, localadmin=7, locality=8,
macrohood=9, neighborhood=10; ISO3166-1 appears only on levels 2–3, ISO3166-2 only on
level 4 — and `adminInfo` consults `OVERTURE_ADMIN_ORDINAL_OVERRIDES` (osm/geodata.js)
instead of `ADMIN_ORDINAL_OVERRIDES`. The two tables are never mixed: the numbers look
like OSM `admin_level`s but do not mean the same thing.

```js

/**
 * @typedef {Object} LegalSpot       // one element of GeoData.legalSpots[zoneId]
 * @property {string} name @property {string} type   // type == the GeoCategory key
 * @property {number} lat @property {number} lon
 * @property {number} weight         // category weight, halved when `verify` is true
 * @property {boolean} enclosed      // inside a park / an enclosing area feature
 * @property {boolean} verify        // ALWAYS true. Restrictive opening_hours was one cause; the
 *                                   //   "within 10 ft of a routable path" join that cleared the rest
 *                                   //   is gone (no local equivalent), so every spot is unverified.
 * @property {string} osm            // '{osmType}/{osmId}'
 * @property {number} distanceM      // distance_m from the zone centre
 */

/**
 * @typedef {Object} GeoData         // class GeoData. Everything the OSM layer produces.
 * ABSENT CATEGORIES ARE ABSENT KEYS, and that is load-bearing: a category that was never
 * queried and a category with zero features are different states all the way to the page.
 * Never conflate them.
 * @property {boolean} available                                   // available — false under !useOsm, or when no world-file layer could be read
 * @property {[number,number,number,number]} bbox                  // bbox
 * @property {Object<string, Poi[]>} pois                          // pois — category key → features, sorted by (osmType, osmId)
 * @property {Object<string, number>} counts                       // counts — category key → in-border feature count
 * @property {Object<string, Object<string,number>>} zoneInventory // zone_inventory — zoneId → category → count inside the circle
 * @property {Object<string, Object<string,boolean>>} zonePolygonHits // zone_polygon_hits — zoneId → category → polygon intersects circle
 * @property {AdminInfo} admin                                     // admin
 * @property {Object<string, number>} curseCounts                  // curse_counts — curse id → the count its predicate returned
 * @property {Object<string, number>} cuisines                     // cuisines — ISO-3166-1 alpha-2 → qualifying restaurants
 * @property {Object<string, LegalSpot[]>} legalSpots              // legal_spots — zoneId → candidate endgame spots, best first
 * @property {OverpassQueryRecord[]} queries                       // queries
 * @property {string[]} notes                                      // notes — honesty notes that MUST reach the page
 */
```

The unavailable form, which `osm/geodata.js` exports as `emptyGeoData(bbox, note)`
(mirrors `build_report`):

```js
{ available: false, bbox, pois: {}, counts: {}, zoneInventory: {}, zonePolygonHits: {},
  admin: { countryCode: null, countryName: null, placeName: null,
           ordinals: {}, perZone: {}, borderLevels: {}, source: 'unknown' },
  curseCounts: {}, cuisines: {}, legalSpots: {}, queries: [], notes: [note] }
```

### Rules layer

```js
/**
 * @typedef {Object} QuestionDef     // class QuestionDef. One of the rulebook's 80 questions.
 * @property {string} id             // id — e.g. 'matching.park'
 * @property {'matching'|'measuring'|'radar'|'thermometer'|'photo'|'tentacle'} category // category
 * @property {string} group          // group — the rulebook's own grouping, e.g. 'Transit'
 * @property {string} label          // label — 'Park'
 * @property {string} text           // text — the full question sentence, VERBATIM
 * @property {string[]} sizes        // sizes — which game sizes include it
 * @property {number} draw           // draw
 * @property {number} keep           // keep — == cards the hider gains; 2 only for tentacles
 * @property {string|null} geodataRef// geodata_ref — key into GEO_CATEGORIES, or null for GTFS-only
 * @property {number|null} param     // param — radar/thermometer/tentacle distance, in MILES
 * @property {string} note           // note — analysis; the page must render it as such
 */

/**
 * @typedef {Object} CurseDef        // class CurseDef. One of the 24 curses.
 * @property {string} id             // id
 * @property {string} name           // name
 * @property {1|2|3|4} tier          // tier — 1 rulebook-explicit … 4 not map-contingent
 * @property {string} cardText       // card_text
 * @property {string} castingCost    // casting_cost
 * @property {string[]} blocks       // blocks
 * @property {string|null} predicateKey // predicate_key — curse-predicate key, or null
 * @property {string} removalRule    // removal_rule — plain words, printed on the page
 * @property {string} quote          // quote — verbatim rulebook trigger, tier 1 only
 */

/**
 * @typedef {Object} QuestionAudit   // class QuestionAudit. One question's verdict — the core of §07.
 * @property {string} id @property {string} category @property {string} label @property {string} text
 * @property {'functional'|'weak'|'degenerate'|'dead'} status // status
 *   // `unaskable`/`unknown` are gone: no map can earn either, so nothing downstream branches on them.
 * @property {number} quality              // quality — 0..1, normalised per category
 * @property {number|null} instances       // instances — in-border N; null when not evaluated
 * @property {number|null} coverage        // coverage — photo questions: share of zones with the subject
 * @property {string} selector             // selector — the exact Overpass selector, or a GTFS note
 * @property {string} why                  // why — one sentence, printed next to the status
 * @property {number|null} survMean        // surv_mean — mean surv over Z, for the funnel. FILLED IN PLACE by scoreZones; render questions AFTER scoring.
 * @property {boolean} borderline          // borderline — would flip under a modestly larger border
 * @property {number} draw                 // draw — card draw price, copied from the catalogue question definition
 * @property {number} keep                 // keep — card keep price, copied from the catalogue question definition
 */

/**
 * @typedef {Object} CurseAudit      // class CurseAudit. One curse's verdict.
 * @property {string} id @property {string} name @property {number} tier
 * @property {'keep'|'warn'|'remove'|'player-choice'} action // action
 * @property {string} predicate      // predicate
 * @property {number|null} count     // count
 * @property {string} why            // why
 */
```

### Scoring layer

```js
/**
 * @typedef {Object} Metric          // class Metric. One named, traceable scoring metric.
 * THIS TUPLE *IS* THE EXPLANATION. Arithmetic is in INTEGER TENTHS OF A POINT throughout,
 * so sub-scores and totals are integer sums and no float drift can move a headline number.
 * @property {string} id             // id — 'A1', 'IR2', …
 * @property {string} name           // name
 * @property {number|null} raw       // raw
 * @property {string} unit           // unit
 * @property {number} pointsTenths   // points_tenths
 * @property {number} maxTenths      // max_tenths
 * @property {{kind:'ramp'|'rramp'|'plateau'|'table', args:number[]}} ramp // ramp
 * @property {'rulebook'|'feed'|'interp'} source // source
 * @property {string} note           // note
 * @property {boolean} available     // available — false ⇒ DROPPED FROM THE DENOMINATOR, never imputed
 */

/**
 * @typedef {Object} SubScore        // class SubScore. A named block of metrics.
 * Degradation is drop-and-renormalise, never impute.
 * @property {string} id @property {string} name
 * @property {Metric[]} metrics      // metrics
 * @property {number} earnedTenths   // earned_tenths
 * @property {number} maxTenths      // max_tenths
 * @property {boolean} partial       // partial
 * @property {string[]} missing      // missing — metric ids dropped from the denominator
 */

/**
 * @typedef {Object} Fitness         // class Fitness.
 * The city rating: 100 points across six sub-scores, plus the per-day deltas.
 * @property {number|null} score     // score — NULL when >40% of points are unavailable. The UI must handle null.
 * @property {number} rawScore       // raw_score
 * @property {string|null} cappedBy  // capped_by — cap id, or null
 * @property {string} band           // band
 * @property {SubScore[]} subscores  // subscores
 * @property {number} availablePoints// available_points
 * @property {Object<string, number>} perDay // per_day — dayKey → score
 */

/**
 * @typedef {Object} FitnessCap      // one element of `fitnessCaps(...)`. Fitness only carries
 * `cappedBy`, so §Score Trace needs this to show "CAP_CATEGORIES: not evaluated"
 * rather than silently omitting it.
 * @property {string} id @property {number} cap
 * @property {boolean} fired @property {boolean} evaluated @property {string} why
 */

/**
 * @typedef {Object} Threat          // class Threat.
 * One question that narrows the search onto a zone.
 * @property {string} questionId     // question_id
 * @property {string} label          // label
 * @property {number} surv           // surv — 0..1
 * @property {string} answer         // answer
 * @property {number} zonesRemaining // zones_remaining
 */

/**
 * @typedef {Object} ZoneScore       // class ZoneScore. One zone's rating: six axes, 100 points.
 * @property {string} zoneId         // zone_id
 * @property {number} overallTenths  // overall_tenths
 * @property {string|null} cappedBy  // capped_by
 * @property {Object<string,number>} axes    // axes — axis id → tenths earned
 * @property {Object<string,number>} axisMax // axis_max
 * @property {Metric[]} metrics      // metrics
 * @property {string[]} flags        // flags
 * @property {Threat[]} threats      // threats
 * @property {number} survK          // surv_k
 * @property {number} pinWorst       // pin_worst
 * @property {number} meanSurv       // mean_surv
 * @property {boolean} excluded      // excluded — unreachable / no service: ranked separately
 * @property {string} excludeReason  // exclude_reason
 */
```

### Aggregates that are plain dicts in the Python

```js
/**
 * @typedef {Object} DayMetrics      // one value of Metrics.perDay; built by _s1_day_metrics.
 * @property {string} dayKey @property {string} dayLabel @property {string} date
 * @property {number} datesRepresented
 * @property {number} trips @property {number} stopEvents
 * @property {number} servedStops @property {number} routes
 * @property {number} firstDepartureS @property {number} lastDepartureS @property {number} spanHours
 * @property {number} nZones @property {number} nZonesHalfMile
 * @property {string[]} [zoneCentreIds]                       // present per-day, POPPED from the head-level copy
 * @property {[number,number,number,number]} bbox
 * @property {number} hullSqM @property {number} bboxSqM @property {number} diameterM
 * @property {[number,number,number]} mec                     // (lat, lon, radiusM)
 * @property {Array<[number,number]>} hullLonlat              // [lon, lat] pairs
 * @property {number|null} medianHeadwayMin @property {number|null} medianWorstGapMin
 * @property {[number,number,number]|null} middayHeadwayP25P50P75
 * @property {[number,number,number]|null} eveningHeadwayP25P50P75
 * @property {number} headwayBaseStops @property {number} frequentStops @property {number} frequentShare
 * @property {number} share30min
 * @property {number} medianLastDepartureS
 * @property {Object<string,number>} lastBusPercentilesS      // '0.05'|'0.25'|'0.5'|'0.75'|'0.95' → seconds
 * @property {number} transferStops2plus @property {number} transferStops3plus
 * @property {number} multiRouteStopShare @property {number} routesPerStopMean @property {number} routesPerStopMax
 * @property {number} stopDensityPerSqMi @property {number} zoneDensityPerSqMi
 * @property {number} tripsPerServedStop @property {number} stopEventsPerServedStop @property {number} tripsPerSqMi
 * @property {number|null} hubTravelP50Min @property {number|null} hubTravelP95Min @property {number|null} hubTravelMaxMin
 * @property {number} t90Min @property {number} t90OriginSample
 * @property {number} isolatedZoneShare
 * @property {Object<string,number>} eveningZoneShareBySize   // 'small'|'medium'|'large' → share
 * @property {Object<string,number>} reachWithinMinutes       // minutes (as a string key) → zones
 * @property {Object<string,number>} reachableZonesWithinMinutes
 * @property {Object<string,number>} reachWithinHidingPeriodBySize
 * @property {Object<string,number>} reachableZoneShareBySize
 */

/**
 * @typedef {DayMetrics} Metrics     // Report.metrics — networkMetrics(). The BEST day's DayMetrics
 * (minus `zoneCentreIds`) flattened at the top level, PLUS everything below. Three choices
 * that are baked in and must not be re-litigated: route-km uses the longest shape per
 * (routeId, directionId); area uses the CONVEX HULL of served stops, not the bbox
 * (160 vs 259 sq mi on the reference feed); traversal time is T90, never max.
 * @property {number} stopsInFeed @property {number} stations @property {number} distinctBaseNames
 * @property {number} zoneRadiusM
 * @property {number} routeKmBothDirs @property {number} routeKmOneDir @property {number} routeMiBothDirs
 * @property {number|null} hubDominance @property {number|null} hubTripShare @property {string|null} hubStopId
 * @property {string} networkShape
 * @property {number} weekendRatio
 * @property {number|null} satTripRatio @property {number|null} sunTripRatio
 * @property {number|null} satStopRatio @property {number|null} sunStopRatio
 * @property {string} weekdayDayKey @property {string|null} saturdayDayKey @property {string|null} sundayDayKey
 * @property {Object<string,string|null>} dowDayType         // '0'..'6' (Mon..Sun) → dayKey
 * @property {string[]} noServiceDates @property {string[]} reducedServiceDates
 * @property {number} fullServiceDateShare
 * @property {Object<string,number>} playableDayWeightBySize
 * @property {Object<string,number>} radarHitRate            // radius in METRES (string key) → hit rate
 * @property {string[]} dayKeys @property {string} bestDay
 * @property {[string,string]} feedWindow @property {number} feedWindowDays
 * @property {Object<string, DayMetrics>} perDay             // dayKey → DayMetrics
 */

/**
 * @typedef {Object} RouteHeadwayRow // one element of Report.routeHeadways — routeHeadways().
 * A route whose two directions differ by more than 1.5× on the best day is SPLIT into two
 * rows; otherwise the two directions are merged into one row with `directionId: null`.
 * @property {string} routeId @property {string} shortName @property {string} longName
 * @property {number} routeType @property {string} color
 * @property {number|null} directionId
 * @property {Object<string, number|null>} perDay  // dayKey → median headway MINUTES, null when unmeasurable
 * @property {Object<string, number>} trips        // dayKey → trip count
 */

/**
 * @typedef {Object} TravelSampleRow // one element of Report.travelSamples — travelTimeSamples().
 * A deterministic destination sample for the ride-time chart, re-running the zone cover at
 * 3× the zone radius and keeping the `count` (default 14) highest-stopEvents picks. Rows
 * are sorted by travel time on the best day; a destination with NO SERVICE that day carries
 * `minutes: null`, which the chart draws hollow-dashed rather than omitting.
 * @property {string} stopId @property {string} zoneId @property {string} name
 * @property {number} lat @property {number} lon @property {number} stopEvents
 * @property {Object<string, {minutes: number|null, transfers: number|null, routes: string[]}>} perDay
 */

/**
 * @typedef {Object} Finding         // one element of Report.findings — deriveFindings().
 * Emitted from threshold crossings, not from prose: a metric earning < 0.35 of its maximum
 * emits a `minus` (or a `concern` when the static mitigation table has an entry for its id);
 * > 0.85 emits a `plus`. Sorted by (quadrant, −severity, metricId). The BENEFIT quadrant is
 * never emitted — its only source is fare_attributes.txt, which deriveFindings is not handed,
 * so it is DROPPED rather than invented. The fare fact reaches the page as the `carry_fare`
 * recommendation instead.
 * @property {'plus'|'minus'|'concern'} quadrant
 * @property {'high'|'medium'|'low'} severity
 * @property {string} metricId @property {string} title @property {string} detail
 * @property {string|null} mitigation
 * @property {boolean} daySensitive
 */

/**
 * @typedef {Object} Recommendation  // one element of Report.recommendations — deriveRecommendations().
 * The house rules whose preconditions hold, in fixed priority order. ONE RULE ALWAYS FIRES:
 * agree the safety exclusions — the rulebook demands that conversation and explicitly
 * refuses to automate the polygon.
 * @property {string} id @property {string} title @property {string} body
 * @property {string} [why] @property {string} [icon] @property {string} [variant]
 */

/**
 * @typedef {Object} Provenance      // Report.provenance — buildProvenance(). Contains NO timestamp
 * that is not derived from feed_info or options.asOf.
 * @property {string} feedUrl @property {string} feedSha256 @property {string} feedVersion
 * @property {string} publisher @property {string} feedStart @property {string} feedEnd @property {string} asOf
 * @property {Array<{name:string,url:string,timezone:string}>} agencies
 * @property {string} generator @property {string} version
 * @property {FeedSourceRow[]} feeds               // one row per input feed, in merge order. Length 1 for an ordinary run.
 * @property {string[]} argv                       // in the browser: a synthesised echo of the Options form. A merged run echoes one `--feed <label>` per source instead of the single positional.
 * @property {OverpassQueryRecord[]} overpass      // sorted by (key, cacheKey)
 * @property {boolean} osmAvailable @property {string[]} osmNotes
 * @property {Object<string, number|null>} adminLevels   // '1'..'4'
 * @property {string} adminSource
 * @property {string|null} countryCode @property {string|null} countryName @property {string|null} placeName
 * @property {string} gameSize @property {boolean} sizeInferred
 * @property {number} hidingPeriodMin @property {number} zoneRadiusM @property {number} catalogueSize
 * @property {number} greedyK @property {number} seekerSampleCap
 * @property {string} departure @property {number} boardSlackS
 * @property {string[]} excludedStops @property {string[]} excludedRoutes
 * @property {boolean} llmUsed                     // always false in the browser port
 * @property {Array<{id:string,text:string,affects:string[]}>} interpretations // sorted by id
 * @property {string[]} degradations
 */
```

### The Report

```js
/**
 * @typedef {Object} Report          // class Report. Everything the renderers consume.
 * @property {Options} opts                       // opts
 * @property {Feed} feed                          // feed — `tables` MAY be dropped before postMessage; nothing after `provenance` reads it
 * @property {{lat0:number,lon0:number}} proj     // proj — WIRE FORM; rebuild with Projection.from()
 * @property {GameSize} size                      // size
 * @property {SizeInference} sizeInference        // size_inference
 * @property {Hub} hub                            // hub
 * @property {Border} border                      // border
 * @property {DaySummary[]} days                  // days — see §(d) stage 'days'; NOT full ServiceDay objects
 * @property {string} selectedDay                 // selected_day — the best day's dayType.key
 * @property {Zone[]} zones                       // zones
 * @property {Metrics} metrics                    // metrics
 * @property {RouteHeadwayRow[]} routeHeadways    // route_headways
 * @property {TravelSampleRow[]} travelSamples    // travel_samples
 * @property {GeoData} geo                        // geo
 * @property {QuestionAudit[]} questions          // questions
 * @property {string[]} questionOrder             // question_order — k question ids, greedy
 * @property {number[]} questionFunnel            // question_funnel — k+1 entries. funnel[0] is n (the whole zone universe); funnel[i] is the surviving block size after the i-th question. MEDIUM reads 319 → 159 → 80 → 42 → 23. RENDER AS A CHAIN, do not zip against questionOrder.
 * @property {CurseAudit[]} curses                // curses
 * @property {Fitness} fitness                    // fitness
 * @property {Object<string, ZoneScore>} zoneScores // zone_scores — zoneId → ZoneScore. Sort keys before iterating.
 * @property {string[]} rankedZoneIds             // ranked_zone_ids — best first
 * @property {string[]} dossierZoneIds            // dossier_zone_ids
 * @property {Finding[]} findings                 // findings
 * @property {Recommendation[]} recommendations   // recommendations
 * @property {string} place                       // place — geo.admin.placeName || feed.agencyName
 * @property {Provenance} provenance              // provenance
 * @property {string[]} degradations              // degradations
 */
```

---

## (c) The Options object

Ported from `class Options`. Dropped as meaningless in a browser: `out_dir`,
`cache_dir`, `llm`, `llm_url`, `llm_model`, `selftest`, `-v/--verbose`, `argv`.

```js
/**
 * @typedef {Object} Options
 * @property {File|string} source        // source — a File picked from disk, or a GTFS URL string
 * @property {boolean} useOsm            // use_osm (CLI `--no-osm` inverted)
 * @property {string|null} worldBaseUrl  // where the prebuilt world files are served from; null = `DEFAULT_WORLD_BASE_URL` (osm/worldfile.js). No CLI equivalent — the CLI predates the world files.
 * @property {string|null} asOf          // as_of — 'YYYYMMDD', clamped into the feed window
 * @property {'small'|'medium'|'large'|null} sizeOverride // size
 * @property {number|null} zoneRadiusM   // zone_radius_m — metres
 * @property {number|null} hidingPeriodMin // hiding_period_min
 * @property {string|null} startStopId   // start_stop_id — overrides the inferred hub / round-start station
 * @property {'bbox'|'circle'} borderShape // border_kind
 * @property {[number,number,number,number]|null} borderBbox // border_bbox — (S, W, N, E) decimal degrees
 * @property {string[]} excludeStops     // exclude_stops — SORTED + DEDUPED by the caller
 * @property {string[]} excludeRoutes    // exclude_routes — SORTED + DEDUPED by the caller
 * @property {string} departure          // departure — 'HH:MM:SS' on the representative day
 * @property {number} boardSlackS        // board_slack_s
 * @property {boolean} offline           // offline — a cache miss is a hard error instead of a fetch
 * @property {boolean} refresh           // refresh — ignore cached responses and refetch
 */

export const DEFAULT_OPTIONS = {
  source: '',
  useOsm: true,
  worldBaseUrl: null,      // resolved to DEFAULT_WORLD_BASE_URL by worker.js, not here
  asOf: null,
  sizeOverride: null,
  zoneRadiusM: null,
  hidingPeriodMin: null,
  startStopId: null,
  borderShape: 'bbox',
  borderBbox: null,
  excludeStops: [],
  excludeRoutes: [],
  departure: '09:00:00',   // DEFAULT_DEPARTURE
  boardSlackS: 0,          // BOARD_SLACK_S
  offline: false,
  refresh: false,
};
```

Normalisation the main thread performs before posting (mirrors `parse_args`):
`departure` gains `':00'` when it has only one colon; `excludeStops` / `excludeRoutes` are
sorted and deduped; `borderBbox` must be exactly four numbers or it is an error;
`worldBaseUrl` must parse as an http(s) URL or it is an error, and loses any trailing
slashes (`openWorld` joins with one of its own).
`source` stays a **display string** and is carried in `options`; the inputs themselves
travel in the `run` message's `sources` list, not inside `options` (a `File` is
clone-safe, but keeping the two apart makes the protocol readable). On a multi-feed run
`source` is the labels joined with `' + '`.

The landing map's drawn shape is a **page** control, not an `Options` field: it produces a
`borderBbox` (and leaves `borderShape` at `'bbox'`), which `inferBorder` already honours
as an override. Do not add a shape or ring field to the wire.

---

## (d) The worker protocol

`worker.js` is a **module worker**: `new Worker('./worker.js', { type: 'module' })`.

### Main thread → worker — exactly one message

```js
{ type: 'run', options: Options, sources: SourceRef[] }     // 1 ≤ sources.length ≤ MAX_FEEDS_PER_RUN (6)

/**
 * @typedef {Object} SourceRef       // main → worker. A `File` is clone-safe; a string is.
 * @property {'file'|'url'} kind
 * @property {File|null} file        // kind === 'file'
 * @property {string|null} url       // kind === 'url' — http(s) only
 * @property {string} id             // STABLE IDENTITY, and what the list is sorted on:
 *                                   //   'mdb:<id>' | 'url:<the url>' | 'file:<name>:<size>'
 * @property {string} label          // 'The Rapid' | 'mbta.zip'
 * @property {number|null} mdbId     // Mobility Database source id, or null
 */
```

`sources` is the only carrier — the older `file` / `url` pair is **gone**, because two
ways to say the same thing is how a stale main thread half-works silently. The main
thread sorts the list by `id`, code-point, before posting; the **merge** order is decided
independently inside the worker, from the feed bytes (§(b)). It is still **exactly one
message** however many feeds it names: the worker never receives a second one and never
posts back a request; there is no request/response channel.

`runPipeline(options, source, emit)` also accepts a bare `File` / `Blob` / buffer / URL
string, or an array of them, as a list of one — that is the shape `tools/smoke.mjs` uses
and the path the golden numbers are measured on.

### Worker → main thread — many messages

| Message | Shape | Meaning |
|---|---|---|
| progress | `{ type:'progress', stage:string, label:string, done:number, total:number }` | Fine-grained; drives the header progress bar. **`total` may grow** as work is discovered — the UI must not assume it is fixed. |
| stage | `{ type:'stage', stage:string, payload:object }` | A section's data is ready. See the stage table. |
| log | `{ type:'log', level:'info'\|'warn', message:string }` | Diagnostics. Never rendered as report content. |
| degraded | `{ type:'degraded', message:string }` | Appended to `Report.degradations` and shown in the page's degradation callout. |
| error | `{ type:'error', stage:string, message:string, fatal:boolean }` | `fatal: false` ⇒ the run continues degraded. `fatal: true` ⇒ no further messages will arrive. |
| done | `{ type:'done', report: Report }` | The complete `Report`. Always last. |

**Every payload must be structured-clone-safe**: plain objects, arrays, numbers, strings,
booleans, `null`, and `File`/`ArrayBuffer`/typed arrays. **No class instances, no `Map`, no
`Set`, no functions, no `undefined` as a meaningful value.** Modules may use `Map`/`Set`
internally but must flatten before emitting. `Projection` crosses as `{lat0, lon0}`.
`GridIndex` never crosses at all.

### Stage order — the UI hydrates in exactly this order

| # | `stage` | Payload | Unblocks |
|---|---|---|---|
| 1 | `'feed'` | `{ agencyName, agencyUrl, timezone, feedStart, feedEnd, feedVersion, publisher, asOf, sha256, source, feeds: FeedSourceRow[], stops: number, routes: number, trips: number, place }` — every scalar describes the MERGED feed; `feeds` names what it was merged from | hero, §04 partial |
| 2 | `'days'` | `{ days: DaySummary[], selectedDay: string }` | §06 |
| 3 | `'network'` | `{ zones: Zone[], hub: Hub, border: Border, size: GameSize, sizeInference: SizeInference, metrics: Metrics, routeHeadways: RouteHeadwayRow[], travelSamples: TravelSampleRow[], stops: StopRow[], proj: {lat0,lon0} }` | §04, §05 |
| 4 | `'geo'` | `{ geo: GeoData }` | stage 5 |
| 5 | `'rules'` | `{ questions: QuestionAudit[], curses: CurseAudit[], questionOrder: string[], questionFunnel: number[] }` | §07, §08 |
| 6 | `'score'` | `{ fitness: Fitness, caps: FitnessCap[], zoneScores: Object<string,ZoneScore>, rankedZoneIds: string[], dossierZoneIds: string[], findings: Finding[], recommendations: Recommendation[], questions: QuestionAudit[] }` | §01, §02, §03 |
| 7 | `'provenance'` | `{ provenance: Provenance, degradations: string[] }` | §09 |

Notes on the stage payloads:

* **`'score'` re-sends `questions`.** `scoreZones` fills `QuestionAudit.survMean` *in
  place* — it is the only function that sees both the audit rows and the survival table.
  The UI must re-hydrate §07 from the `'score'` copy, not the `'rules'` copy. (This is why
  §07 renders after scoring in the CLI too.)
* **`DaySummary`** — the flattened, clone-safe view of a `ServiceDay`:
  ```js
  /**
   * @typedef {Object} DaySummary
   * @property {DayType} dayType
   * @property {number} trips @property {number} stopEvents
   * @property {number} servedStops                 // servedStopIds.length
   * @property {number} routes                      // routeIds.length
   * @property {number} firstDeparture @property {number} lastDeparture @property {number} spanHours
   * @property {number|null} medianHeadwayMin @property {number|null} medianWorstGapMin
   * @property {number} frequentStops @property {number} frequentShare
   * @property {number[]} headwayHistogramMin        // bucket counts; buckets are [0,5,10,15,20,30,45,60,90,∞)
   * @property {Object<string,number>} lastBusPercentilesS
   */
  ```
  Full `ServiceDay` objects never leave the worker.
* **`StopRow`** — the map's stop layer, one row per served stop:
  ```js
  /**
   * @typedef {Object} StopRow
   * @property {string} stopId @property {string} name
   * @property {number} lat @property {number} lon   // both through core.coord()
   * @property {string[]} routeIds
   * @property {boolean} frequent
   * @property {string|null} zoneId                  // the zone whose circle designates it, or null
   */
  ```
* **Stages 4–7 must still emit when the OSM layer is unavailable**, carrying the
  degradation. See §(f).
* **S5 changed no payload here, and that is deliberate.** The hider's guide (§(g)) is built
  entirely from fields the stages above already carry. In particular the per-zone × per-day
  service block is **not** added: it would need `ServiceDay.stopDays[zoneId]`, which
  `daySummary()` strips before anything crosses `postMessage` because it is megabytes of no
  use to the page. The guide's Service block is scope-reduced to metrics `S1` / `S2` / `S3`
  out of `zoneScores[id].metrics` plus `stops` filtered to the zone, on the scored day. Lost:
  first/last departure, the departure count, the 24-bin sparkline, per-day switching. A new
  `zoneService` payload for one eighth of one card was not worth a pipeline change.
* `progress.stage` uses the same seven tokens plus finer sub-tokens (`'feed:unzip'`,
  `'geo:overpass'`, …). The UI maps any `stage` prefix before the first `:` onto its
  section.

---

## (e) `render/html.js` — pinned API

All functions return **HTML strings**. Python keyword arguments become a single trailing
options object. Python's `class_` becomes `className`. Python's `void()` is renamed
`voidEl()` (`void` is a JS operator).

### The escaping contract (generate.py) — both renderers follow it exactly

* A parameter whose name ends in `Html` receives markup that is **already safe**. The
  helper inserts it verbatim. You build it with other helpers, or you call `esc()` yourself.
* Every other string parameter is **plain text**. The helper calls `esc()` on it.
* `esc()` is the only way text becomes markup. There is no "I know this is safe" exception
  — feed data contains apostrophes, ampersands and, in the wild, angle brackets.
* Attribute values always go through `attrs()`, which escapes them.
* Only WebAwesome 3.11 components with a helper below are sanctioned. If there is no helper
  for it, do not invent one.

```js
esc(value) → string
// HTML-escape any value including quotes. null/undefined → ''. The single entry point.

attrs(obj) → string
// Render an object as HTML attributes, escaped, IN SORTED KEY ORDER (byte-stable).
// null / false / undefined DROP the attribute; true renders it bare (`pill`).
// Trailing underscores are stripped and inner underscores become hyphens:
// `className` → `class`, `for_` → `for`, `indexAxis`/`index_axis` → `index-axis`,
// `dataTip`/`data_tip` → `data-tip`. Returns '' or a LEADING-SPACE-PREFIXED string.

el(tag, contentHtml = '', opts = {}) → string          // <tag …>contentHtml</tag>
voidEl(tag, opts = {}) → string                        // <tag …>   (Python `void`)
join(...chunks) → string                               // newline-join, dropping null/''

waIcon(name, { label = '', ...attrs }) → string
waCard(bodyHtml, { headerHtml='', footerHtml='', imageHtml='', className='', ...attrs })
waCallout(bodyHtml, { variant='neutral', appearance='filled-outlined', icon=null, ...attrs })
waTag(text, { variant='neutral', appearance='outlined', size='s', pill=true, icon='', ...attrs })
waBadge(text, { variant='brand', appearance='filled', pill=true, ...attrs })
waButton(text, { variant='neutral', appearance='outlined', size='s', icon='', ...attrs })
waDetails(summary, bodyHtml, opts = {})
waScroller(bodyHtml, { orientation='horizontal', ...attrs })
waProgressBar(value, { label='', ...attrs })           // value 0..100, rounded to 1 dp via num()
waProgressRing(value, { label='', innerHtml='', ...attrs })
waSwitch(label, { checked=false, size='s', ...attrs })
waCopyButton(payload, { label='Copy', ...attrs })
waChart(chartType, configJson, opts = {})               // configJson MUST come from jdump()
waAccordion(items, { mode='single-collapsible', appearance='plain', headingLevel='4', ...attrs })
                                                        // items: Array<[itemId, labelHtml, bodyHtml, expanded]>

chip(text, iconName = '', { variant='neutral', appearance='outlined', ...attrs })
meter(labelHtml, valuePct, rightHtml, { flank='6rem', ...attrs })
budgetBar(segments, total, { ariaLabel, remainderTip='', variants=[], height='1.25rem', ...attrs })
                                                        // segments: Array<[letter, value, tipText]>
searchInput(inputId, { placeholder, label })
pullQuote(text)
section(sectionId, number, title, bodyHtml,
        { kicker='', lede='', answerHtml='', answerVariant='neutral', answerIcon='circle-info' })
subhead(text, { anchorId='' })
kpi(value, label, noteHtml = '', { chipHtml='' })
provChip(...ids)                                        // variadic, like the Python
dataTable(headers, rows, { className='', ...attrs })   // always wrapped in a scroller
                                                        // headers: plain text; rows: PRE-ESCAPED markup cells
jsonBlock(blockId, payload)                             // floatDp is fixed at 6; escapes EVERY '<'
```

Behavioural notes that must survive the port (they are load-bearing, not style):

* **Never introduce tabs.** A tab hides n−1 panels from Ctrl+F and from print, puts no
  state in the URL, and cannot hold a map or a canvas. A `waTabGroup` helper existed
  unused for this reason and has been deleted; the prohibition is the part that matters.
* **Never** put a map or a chart inside `waAccordion` or `waScroller`. MapLibre and
  Chart.js read their container size once, at construction; a collapsed item has none.
* `chip()` is the **only** sanctioned way to render a question status, a curse action, a
  finding severity or a metric source. Icon **and** word, never colour alone: against the
  off-white surface `--warn` and `--q-edge` are 2.38:1 and `--gold` 1.44:1, all under
  the 3:1 non-text floor.
* `meter()`'s `valuePct` is 0–100 and is computed by the caller, never inside the helper.
* `budgetBar` is a `<wa-chart stacked index-axis="y">`, one dataset per segment.
  `wa-progress-bar` is a single-fill track and cannot show six segments. Pass `height`,
  never `style` — `style` replaces the whole style string and drops `aspect-ratio:auto`,
  letting the component's `:host{aspect-ratio:16/9}` win. The segment letters and the
  hover tip are painted by the `budgetSeg` plugin in `app.js`, which `bindBudgets()`
  attaches to every `wa-chart[data-budget]`; chart.js bundles no datalabels plugin and
  its own tooltip is clipped inside a 20px canvas. Never nest one inside a disclosure:
  it is rubric, not evidence — and a canvas in a `display:none` subtree measures 0.
* `pullQuote` — exactly one per page.
* `section()`'s `number` renders through `h2[data-n]::before`, so it exists only as an
  attribute, never as text a screen reader has to read twice. `answerHtml` is ONE
  plain-English sentence carrying the two or three numbers that matter; every number in it
  must already come from a formatter or a `Report` field.
* `provChip()` links to `#prov-{id}`; this is how "every point traces to a named metric"
  reaches the UI.
* A section with no data emits **nothing at all** — not an empty card — and its nav entry
  disappears with it.

### Section ids (from `render_index`) — the shell must use exactly these

| # | `id` | Nav group | Nav label | Icon | Renderer |
|---|---|---|---|---|---|
| 01 | `numbers` | The Map | At a Glance | `hashtag` | `map.js` |
| 02 | `network` | The Map | The Map You're Playing On | `map-location-dot` | `map.js` |
| 03 | `yourgame` | Your Game (split) | House Rules `#recs` / What Works, What Fights You `#findings` | `list-check` / `circle-exclamation` | `verdict.js` |
| 04 | `transit` | Your Game | Getting Around | `route` | `map.js` |
| 05 | `verdict` | The Answer | Verdict | `circle-check` | `verdict.js` |
| 06 | `questions` | The Deck | The Questions | `circle-question` | `deck.js` |
| 07 | `curses` | The Deck | The Curse Deck | `wand-magic-sparkles` | `deck.js` |
| 08 | `trace` | The Receipts | Where the Points Came From | `chart-simple` | `verdict.js` |
| 09 | `sources` | The Receipts | Where These Numbers Come From | `book-open` | `deck.js` |

**This order is page order** (reordered 2026-08-23; it used to open on the verdict and
close on the sources). It is stated in four places that must be kept in lockstep: the
`<section>` order in `index.html`, `app.js`'s `NUMBERED` — the array `renumberSections`
actually walks, so it, not the DOM, hands out the ordinals — `app.js`'s `SECTIONS`, and
the nav rail. The rail matters as much as the rest: `bindSpy` takes the **last** link
whose section is above the fold, walking the links in document order, so a rail that is
not in page order silently highlights the wrong entry. Every nav group is therefore a
**contiguous run** of this table.

The `§NN` labels in `render/*.js`'s own comments are module-local nicknames inherited
from the CLI's numbering (§01 verdict … §09 sources) and, since the reorder, are **not**
the printed ordinal — this table and `NUMBERED` are. `render/strategy.js` and
`render/simulator.js` number the strategy view's own five sections and are unrelated to
either.

Ordinals (`data-n`) are assigned **after** empty sections are dropped, so the printed
sequence never has a hole. The embedded `<script type="application/json">` blocks keep the
CLI's ids, with the `-data` suffixes that avoid colliding with the section anchors:
`#data`, `#questions-data`, `#curses-data`, `#stops`, `#provenance`.

---

## (f) Error and degradation policy

The rule from `build_report`:

```
if useOsm:
    try   geo = await collectGeodata(...)
    catch geo = emptyGeoData(border.bbox,
                'Overpass was unreachable; OSM-backed scores are excluded.')
          degradations.push(`OpenStreetMap layer unavailable (${err.name})`)
else:
    geo = emptyGeoData(border.bbox, 'OSM was not queried.')
    degradations.push('no-osm: OSM-backed questions, curses and zone axes are excluded')
```

Rules that follow from it, and that every module must obey:

1. **A failed map-file read is not fatal.** The run continues with
   `geo.available === false`, empty containers, and a degradation string. `--no-osm`
   (`options.useOsm === false`) is the same path with a different note. The trigger used
   to be an Overpass failure; it is now `collectGeodata` finding that *not one*
   world-file layer could be read. One unreadable layer degrades that category alone —
   throwing on the first failure would turn a single missing layer into a dead OSM
   section, which is the bug that shape exists to avoid.
2. **Any module receiving an unavailable `GeoData` must return partial results, never
   throw.** Concretely:
   * `auditQuestions` — every OSM-backed question gets `status: 'unknown'` (never `'dead'`,
     never `'degenerate'`), `instances: null`, `coverage: null`, and a `why` that says the
     layer was unavailable. GTFS-only questions are audited normally.
   * `auditCurses` — every OSM-predicate curse gets `action: 'player-choice'` with
     `count: null`. GTFS-decided curses (e.g. `u_turn`) are audited normally.
   * `scoreFitness` / `scoreZones` — OSM-backed metrics get `available: false`, which
     **drops them from the denominator**. Degradation is drop-and-renormalise, **never
     impute**. If more than 40% of the 100 points are unavailable, `Fitness.score` is
     `null` and the UI shows "Partly measurable" instead of a number.
   * `legalEndgameSpots` → `{}` (an empty array per zone), not an error.
   * `AdminInfo` with `source: 'unknown'` ⇒ every admin question is `unknown`, **not**
     `dead`, and every ordinal renders as "no Nth division here", never as a guessed level.
3. **Absent ≠ zero.** In `GeoData.counts` / `zoneInventory`, a category that was never
   queried is an **absent key**; a category with zero features is a key with value `0`.
   Never conflate them, all the way to the page.

   **A third state exists since the world-file migration, and it is not either of those.**
   The six density-grid categories — `building`, `street`, `car_street`, `footpath`,
   `bridge`, `tree` — are counted but never materialised as features. On every successful
   run `counts[key]` holds a real, map-wide-**exact** number while `pois[key]` is
   **permanently absent**, because no `Poi[]` is ever built for them. Before the
   migration those two keys appeared and disappeared together; they no longer do, and
   code that infers "not queried" from an absent `pois` key is wrong for these six.
   Their `zoneInventory` entries are present but **approximate** — a grid cell is
   attributed to whichever zone circle contains its centre — which is why they are also
   unconditionally `partial: true`. See `tools/osm-world/README.md`.
4. **The single service-day degradation.** Fewer than two day types ⇒
   `"single service-day type: no weekend variation in this feed"`. §06 still renders.
5. Every `degraded` message the worker posts is also appended to `Report.degradations`, so
   the final `done` payload is self-contained: a reader who only sees the `Report` sees
   every degradation.
6. A fatal error (`{ type:'error', fatal:true }`) is only for the cases where there is no
   report at all: the source could not be fetched, the zip could not be opened, or the feed
   has no `stops.txt` / no `stop_times.txt`. Everything else degrades.

---

## (g) The second view — `#strategy`

The CLI emitted two files per city: `index.html` and `strategy.html` (S5,
`render_strategy`), the hider's guide, which nothing links to. The invariant it
stated is that the two pages never link to each other, because the seekers
read the first one. The port has **one document**, so the invariant becomes: nothing in the
report view mentions, links to or hints at the guide. The guide may link back — that link is
only ever visible to someone already inside it.

| Contract | Detail |
|---|---|
| Entry | `location.hash === '#strategy'` **and** a finished report. Nothing else. No nav entry, no subheader entry, no button, no keyboard shortcut, no `<link rel>`, no comment in `index.html`. `index.html` gains **zero lines** for this feature. |
| Deep link, no report | `applyRoute()` falls through to the ordinary landing form — no error, no message, no hint. If a feed is then run with the fragment still set, `finish()` calls `applyRoute()` again and the reader lands in the guide. |
| Exit | The guide's hero link `href="#top"`, the browser Back button, or any other fragment. All go through the same `applyRoute`. |
| Visibility | `body[data-view='strategy']`, a **new attribute orthogonal to `data-state`**. `data-state` keeps its meaning (the run lifecycle) and is never touched, so the report is *hidden by three rules in styles.css §7, not destroyed*: no section re-renders, no listener is dropped, `#netmap` keeps its MapLibre instance, and returning is free. A fourth `data-state` value would put the two axes into a fight over the same `!important` rules. |
| Sticky offsets | The report's 7rem clears the header **and** the `[slot='subheader']` strip; the strip is `data-when="report"` and hidden here, so the guide's stack is the header alone. `--s-sticky` is set once on the root under `html:has(body[data-view='strategy'])`, carries the `scroll-padding-top` and inherits into `#s-controls` and `#s-detail`. Do not restate the report's numbers in this view. |
| Landmark and focus | The guide root carries `role="main"` — the report's `<main>` is `display: none` while the guide is up, and `wa-page` supplies no landmark of its own, so without it the whole view sits outside every landmark region. There is no collision: a hidden element is not in the accessibility tree. `applyRoute` also moves focus to the root (`tabindex="-1"`, `preventScroll`) and `leaveStrategy` mirrors it onto `#top`, because a view swap with a new `document.title` otherwise drops focus to `<body>` silently. Both scrolls are queued **two** frames out, so they land after `PAGE_RUNTIME_JS`'s still-live `openTargeted`, which is bound to the same `hashchange` and would otherwise re-scroll the root to `block: 'center'`. |
| Not a section | The root is not an entry in `SECTIONS`, so `hydrate`, `mountSection`, `dropSection`, `renumberSections` and `pruneNav` never see it. Its five sections pass the **literal** ordinals `'01'`…`'05'`, never `'--'` — `renumberSections` strips the attribute from every remaining `[data-n='--']` in the document. It carries no `data-state`, so `fatalError`'s `[data-state='skeleton']` sweep cannot take it either. |
| Mount point | Inside `<wa-page>`, as a sibling of `<main>`, so it inherits the page gutter and the `--content-width` cap. |
| Kept out of the ported runtime | Nothing about this view is added to `PAGE_RUNTIME_JS`, whose source string was a verbatim port of the CLI's page JS. The CLI is gone, so there is nothing left to diff it against — treat the string as owned here now. The view ships no JSON block at all, so nothing is added to the blocks written by `writeDataBlocks` either. Its wiring lives in module code (`render/simulator.js`, `initStrategy`), which is where anything the CLI does not have belongs. |
| Data source | `state.report` in memory. The answer matrix (`answerSignature` / `survivalFractions`) is worker-local and is **not** needed: the CLI's simulator never consumed it either — it recomputes answers client-side by haversine (`answerFor`). `report.geo.pois` crosses `postMessage` whole and is richer than the CLI's `[lon, lat, name]` triples. |
| Id namespace | **Every id inside the view is prefixed `s-`**, the root `#strategy` excepted. The CLI's bare ids collide in a single document: `#sources` with §09, `#top` with the report hero, `#axis-*` with §04's accordion, `#zmap`/`#ztable` with nothing yet but by luck. The `s-` prefix is also what keeps `PAGE_RUNTIME_JS`'s `openTargeted` from opening a report disclosure on a guide fragment. |
| Controls | The three mutually-exclusive rows — `#s-modes` (question mode), `#s-radius`, `#s-category` — are `wa-radio-group`s of `appearance="button"` radios, the same native pair `s4ChipGroup` (`render/map.js` 169) builds for the report's filter rows, read through the group's `value` on `change`. `s4ChipGroup` itself cannot be reused because it has no way to disable an option. A dead option is a `disabled` radio **and** a printed reason — a disabled control is not focusable, so a `title` on one is reachable by hovering with a pointer and by nothing else. Never express the selection by rewriting `appearance`. |
| Seeker placement | Pointer **and** keyboard. The map click and the marker drag are the CLI's; the port adds a "Place the seekers at …" `wa-button` in `#s-opts` (a leg from the hub to the selected zone, in thermometer mode) and makes the marker element itself a focusable control that the arrow keys nudge. Without one of these every question mode is stuck on its "click the map" prompt for a keyboard user, i.e. the flagship feature does not run at all. |
| Module boundary | `app.js` → `renderStrategy(report) → string` (one root element, or `''`) and `initStrategy(root, report) → void`. `initStrategy` is called **only after** `body[data-view]` is set, because MapLibre reads its container size once, at construction. It is idempotent: a second call resizes the map and returns, so mode, selection, sort, filter and page survive leaving and re-entering. The dependency between the two new modules is one-way — `simulator.js` imports `strategy.js`, never the reverse. The one shape that crosses it is `modeChips`' `CatChip` (typedef in `render/strategy.js`), whose `reachMi` — that tentacle question's own reach in miles, `null` on matching and measuring chips — is what `answerFor` measures against. Never `size.tentacleReachMi`: that is the deck's headline figure and a LARGE deck holds two reaches at once. |
| What `answerFor` answers | `generate.py` is the port's source, but it is **not** the specification — `rules/audit.js` is, and three of its answers used to disagree with the CLI's simulator. All three were fixed on both sides and the two implementations now agree. Measuring compares each side's own nearest feature (`osm_distance` / `survMeasuring`), not both sides against the seeker's. Tentacles have a third answer, "not within reach" (`survTentacle`'s class `-1`), plus a fourth when the seekers' own circle holds nothing to name (class `-2`). Tentacle reach is per question, not per game size. The majority group a readout reports is keyed on the winning **feature**, never on its name: two features sharing a name are two answers, and unnamed features are not one group. |

### Deliberate divergences from `generate.py` in this view

1. **Per-zone × per-day service is scope-reduced** to metrics `S1` / `S2` / `S3` plus
   frequent-stop counts on the scored day. Reasoning in §(d).
2. **The rail's six-segment axis micro-bar is dropped** in favour of one
   `wa-progress-bar` for the overall score. The breakdown is one click away in the
   dossier. Removes two custom classes and ~200 custom elements from a 40-row list.
3. **The six `wa-tooltip for="th-{axis}"` header tooltips are replaced** by an axis
   legend above the table whose `<code>` entries link to `#s-axis-{AXIS}`. `html.js` has
   no `waTooltip` and is not gaining one for this.
4. **All ids are namespaced `s-`**, as above.
5. **The guide's map follows the theme button.** The CLI's reads dark once at
   construction and never restyles; one document has one theme control, so
   this map follows `buildMap`'s `matchMedia` + `MutationObserver` pattern instead.
6. **Playbook tip 9 reads `metrics.hubDominance`.** The CLI reads
   `metrics["hub_route_share"]`, a key `network_metrics` never emits — it
   emits `hub_dominance` — so the tip has never fired in the CLI. `generate.py`
   wins on shapes, but a key that does not exist is a bug, not a shape. **File it.**
7. **§02's table sorts the direction it claims to.** `generate.py` is
   `if (ka < kb) return sortDir; if (ka > kb) return -sortDir;` and `sortDir` starts at
   `-1`, so every column sorts *ascending* — contradicting the CLI's own comment
   ("everything else descends"), its `sortDir = (c === 1 ? 1 : -1)` on a column change,
   and the `aria-sort="descending"` it writes at 15317. The CLI therefore opens the
   zone table on the worst zones and mislabels the state to assistive tech. The sign is
   inverted here (`simulator.js` `tableRows`), so `sortDir = -1` means descending in the
   rows and in `aria-sort` alike. Same class of finding as 6 — a contradiction, not a
   shape. **File it.**
8. **The overall score is printed over 100, not over Σ `axisMax`.** `overallTenths` is
   already renormalised (`rules/score.js:1121`, `1000 × earned ÷ max`), so its
   denominator is always 100 — but the CLI prints it against the raw axis maxima
   (14326, 14361). With OSM the two are the same number; on a `--no-osm` run the E and
   A axes have `axisMax === 0` and the CLI would print `97.6 / 70.0`, plus a 139%-full
   progress bar. `ZoneView.max` is fixed at 100 here, which is identical on the OSM path
   and correct on the other. **File it.**

Three other divergences this work surfaced, all repaired in `styles.css` rather than left:
§6's `.dark-map` selector is now keyed on the class alone rather than on the one map id
`generate.py` names (the class is set by the map builders and by nothing else, and
the shared sheet must not name a map the report does not have — see below); the sticky
control-bar rule of `generate.py` had lost `#zcontrols` (now `#s-controls`); and
`[data-band='fair']` had been collapsed onto `good`'s colour, rendering a five-band scale
in three colours — it gets `--warn` back, as `generate.py` gives it.

### The stylesheet is partitioned

The CLI writes two files with two stylesheets (`INDEX_CSS` 10662, `STRATEGY_CSS` 1675;
the note at 1449 is explicit that shipping one into the other was ~19 rules that could
never match). One document cannot do that, so `styles.css` carries the guide's rules in
a span delimited by the `/* == STRATEGY CSS` and `/* == END STRATEGY CSS` markers. The
markers are a boundary for readers — nothing parses them — but the partition still holds:
new guide CSS goes inside them, and nothing the report needs goes there.
