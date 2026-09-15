# CONTRACT.md

Authoritative for every shape that crosses a module boundary. If this file and the code
disagree, one of them is a bug: work out which, fix it, and say so. Never silently diverge.

The rules on sorting, key order and number formatting are why two runs agree; they are
live, not history. The snake_case name in a field's trailing comment is that field's
canonical name; do not remove or rename it.

**Scope.** `index.html`, plus `strategy.html` (S5) as a **fragment-only second view of the
same document** — §(g). S5 adds no worker stage, no `Report` field and no embedded JSON
block; it is built from `state.report` in memory.

---

## 0. Ground rules

| Rule | Detail |
|---|---|
| Modules | Plain ES modules. `export` / `import`. Relative paths, `.js` extension **required**. |
| No build | No bundler, no TypeScript, no npm runtime dep. Top-level `await` is fine. |
| Worker side | `lib/**`, `gtfs/**`, `osm/**`, `rules/**` run inside the Web Worker. **No DOM.** Allowed: `self`, `fetch`, `indexedDB`, `crypto`, `DecompressionStream`, `TextDecoder`, typed arrays, `structuredClone`. |
| Main side | `app.js`, `render/**`. DOM freely. |
| External assets | Only these five: WebAwesome kit `https://ka-p.webawesome.com/kit/95e68140d1204145/webawesome@3.12.0`; MapLibre `https://cdn.jsdelivr.net/npm/maplibre-gl/+esm` and `.../dist/maplibre-gl.min.css`; tiles `https://tiles.openfreemap.org/styles/positron` and `/dark`. The kit and the MapLibre stylesheet are `<link>`ed by `index.html` and have no constant. The other three are exported from `lib/core.js` as `MAPLIBRE_JS`, `TILES_LIGHT`, `TILES_DARK`. |
| Still five | `data/feeds.json` is a **same-origin repo asset**, not an external one. A feed zip — a Mobility Database mirror URL or an agency's own — is **input**, like a pasted URL. The polygon draw tool and the landing border editor are hand-rolled on MapLibre's own events so this list stays exhaustive; do not replace either with a CDN module without amending the row above. **Known divergence, recorded rather than fixed:** the world-file base URL (`DEFAULT_WORLD_BASE_URL`, `osm/worldfile.js`) is not in the list although every run fetches from it. Folding it in is a deliberate amendment, never a side effect of another change. |
| Determinism | No `Date.now()`, no `Math.random()`, no wall clock anywhere in the pipeline. Never iterate a `Map`/`Set`/object whose insertion order could vary without sorting first. Two runs over the same input must be byte-identical. |
| Numbers | Every number that reaches the UI goes through exactly one formatter from `lib/core.js`. No `toFixed`, no `Math.round`, no `Intl.NumberFormat` in the pipeline or the renderers. |
| Sorting strings | The comparator is exactly `a < b ? -1 : a > b ? 1 : 0` — code-point order, identical to UTF-16 code-unit order below U+10000 — never `localeCompare` (locale-dependent = non-deterministic). It has **one** implementation, `cmpStr` in `lib/core.js`; do not add a local copy. Two deliberate hold-outs: `tools/mdb-snapshot.mjs` (a standalone Node tool importing nothing from the app) and `lib/geo.js`'s `GridIndex.nearKeys` (a local arrow on its hot path). |
| Sorting numbers | `Array.prototype.sort()` is lexicographic by default. Always pass `(a, b) => a - b`. |
| Object key order | JS objects hoist integer-like keys (`'1','2','12'`) ahead of lexicographic order (`'1','12','2'`). Zone ids and stop ids are numeric strings on most feeds. **Never** rely on `Object.keys()` order — always `Object.keys(o).sort(cmp)`. `jdump()` already does this internally. |

---

## (a) Module map

| File | Side | Exports |
|---|---|---|
| `index.html` | main | — (page shell, 9 skeleton sections, WebAwesome head). Three label hooks live here because the shell owns the markup a controller only rewrites: `<p data-role="analysereason">` in the panel foot, which `app.js`'s `syncAnalyse` fills and unhides for exactly as long as `#analyse` is disabled; `<span data-role="resetlabel">` inside the header Reset control, which `syncResetControl` swaps to `Cancel` (and the icon to `xmark`) while `body[data-state="running"]`; and `<span data-role="themelabel">` inside `#color-scheme-button`, which the inline colour-scheme script writes along with the icon and an `aria-label`. That script cycles light → dark → system, where **system is the ABSENCE of the localStorage key `wa-color-scheme`** — the state the `prefers-color-scheme` listener needs in order to take over again. |
| `styles.css` | main | — (`SHARED_CSS` + `INDEX_CSS`) |
| `app.js` | main | `boot()` — main-thread controller, worker protocol, hydration dispatch |
| `render/html.js` | main | see §(e) |
| `render/verdict.js` | main | `renderHero`, `renderVerdict`, `renderScoreTrace`, `renderYourGame`. Also the page's **single implementation** of the `s4*` day and unit helpers — `s4Imperial`, `s4Signed`, `s4JoinWords`, `s4DayView`, `s4DayOrder`, `s4DayLabel`, `s4BestDay`, `s4WorstDay` — imported by `app.js`, `render/map.js` and `render/strategy.js` (`app.js` aliases them to bare names); and the deterministic primitives `sortedBy(items, keyFn)` and `fnum(x)`, consumed by `render/deck.js` and `render/map.js`. `cmpKey` stays module-private, reached only through `sortedBy`. `s4SourceTag` and `s4Swatch` are aliases of `render/html.js`'s `basisChip` and `swatch`; `s4CardHeader(title, caption)` is a positional wrapper over `cardHeader`; `s4RampShort(spec, unit = '')` is the terse threshold form of `s4RampText`. |
| `render/map.js` | main | `renderGlanceRail`, `renderNetworkMap`, `renderTransitReality`, `s4TilesHtml`, `s4MapCaption`, `s4Legend`, `S4_HEADWAY_BINS`, `s4DayByKey` (`app.js` takes the last one for day switching). It **re-exports nothing**; consumers take the day helpers from `render/verdict.js` directly. `s4Legend` delegates to `render/html.js` `legendRow`. |
| `render/deck.js` | main | `renderQuestions`, `renderCurses`, `renderProvenance`, `S4_STATUS_TAG`, `S4_STATUS_COUNT`, `S4_ACTION_TAG` |
| `render/strategy.js` | main | `renderStrategy`, `zoneViews`, `modeChips`, `poiCategories`; the constants `AXES`, `AXIS_IDS`, `AXIS_PLAIN`, `BAND_CUTS`, `FLAG_TEXT`, `MODE_LABEL`, `MODE_ICON`, `MODE_CATEGORY`, `RADAR_ID_MILES`, `TABLE_PAGE`, `TABLE_PAGE_ABOVE`, `MAX_MAP_ZONES`, `SPOTS_SHIPPED`, `MAX_POI_PER_CATEGORY`, `TENTACLE_ID_REACH_MI`; the rounding helpers `pts`, `bar`, `band`. Pure `Report → string`, no DOM. Reads `QUESTIONS` from `rules/catalogue.js` for one field: a tentacle question's own `param`, which `QuestionAudit` does not carry. `FLAG_TEXT[flag]` is `[label, variant, icon, shortLabel]`. |
| `render/simulator.js` | main | `initStrategy(root, report)` — the only export `app.js` uses. Owns every DOM mutation in §(g)'s view; idempotent; imports from `strategy.js` one-way. |
| `render/landing.js` | main | `renderPickerCard`, `renderExampleMaps`, `renderResults`, `renderResultsSummary`, `renderPicks`, `renderPickerNote`, `renderBorderRow`, `renderBorderCaption`, `renderBorderChips`, `renderDrawHint`, `renderPicksCount`, `renderMapNote`, `renderMarkerTip`, `NUDGE_DEG`; the constant `PICK_CAP` (= `lib/core.js`'s `MAX_FEEDS_PER_RUN`). Pure `data → string`, no DOM — the landing feed picker's markup. `renderPickerCard` emits the `#border-row` host (`app.js` replaces `[data-role=pickerbody]` wholesale, so `index.html` cannot) but neither `#catalog-map` nor a heading: the map host is static markup in `index.html`, a sibling of the panel inside `#picker`, and the heading and lede belong to the panel. The card's outermost node carries `.picker-controls`, which styles.css §7 reaches through. `renderPickerCard` also emits `#picker-draw-hint`, a `role`-less `aria-live="polite"` `<div>` (it holds a `legendRow` `<ul>`, which a `<p>` cannot) INSIDE `#picker-draw`: styles.css §7 keeps only that row on screen while a shape is being drawn on a phone, so a hint outside it would be the one sentence the reader cannot see. `renderResults(rows, {more, farKm, …})` receives the overflow count and, per catalogue id, the km a too-far row sits from the nearest pick (its Add is disabled) from `render/picker.js`. `renderPickerNote` takes `{capped, blocked: Array<{label, href}>, ringEmpty, osmOffer, osmPicked, regionalOn, locate, far: Array<{label, km}>, farMore, split}` and prints only the hard cap, feeds refused as too far away, picks that no longer chain into one map, an API-keyed feed, an uncovered shape, the OpenStreetMap offer and the locate button's empty outcomes (`locate` is `'none'`, `'denied'`, `'unavailable'` or null). `renderPickerCard` puts the icon-only `#locate-me` `<wa-button>` in the search box's `end` slot; it is markup only, and nothing in the page asks the browser for a position until it is pressed. `renderBorderCaption` branches on the frame's `mode` FIRST and the OpenStreetMap flags second, because `mode` alone decides what `readOptions` sends: an `'auto'` frame says the border will be inferred even when the pick is a drawn shape. That sentence fills the caption's visually hidden `[data-caption-text]`; `renderBorderChips` draws the visible, `aria-hidden` `[data-caption-chips]`, mode chip first. |
| `render/picker.js` | main | `initPicker(root, handlers) → {setByo, resize, destroy}` — the only export `app.js` uses. Owns every DOM mutation in the landing picker, the lazy MapLibre import, the hand-rolled draw tool and the game-border **frame** (`st.border`; the `border` source and its `border-fill` / `border-line` / `border-handle` layers; eight handles; pointer and touch drags; four edge fields; the Fit / Where-they-overlap / Box-around-my-shape / Shrink / Grow buttons), all on MapLibre's own events (§0). Idempotent; imports from `landing.js` / `lib/catalog.js` / `lib/geo.js` one-way. Its map is `destroy()`ed in `enterRunningState`; never merge it into `PAGE_RUNTIME_JS`. **State flows outward only**: `commit()` → `handlers.onChange`, and `handlers.onBorder({bbox, mode: 'auto'|'custom'} | null)` on every frame move or mode change. There is no `setSelection`, `setBorder` or `refresh`; `app.js` owns the pick list and reads the frame. The example-map chips write `st.selected` through `commit()`; a chip **replaces** the catalogue picks and leaves the drawn shape and bring-your-own feed alone. Drag rules: handles resize; the OUTLINE (`border-line`, within `EDGE_PX`) moves the box; the FILL belongs to the map's pan; a move drag needs `MOVE_PX` of travel before it can turn an `'auto'` frame `'custom'`. `#border-caption` is a `role="status"` region set `aria-live="off"` during a drag. The map uses `cooperativeGestures: false` because the map is the page. `giveUpOnMap`'s `mapHost.hidden` is the ONE signal styles.css §7 reads to collapse the landing stage to a centred card; `app.js` sets the same attribute when the catalogue never arrives. The picker writes `#picker-draw-hint` per mode — idle, drawing, and the refusal — and a `click` on Draw a shape whose `detail === 0` (a keyboard activation) refuses draw mode outright, writes that refusal and moves focus to the search box, because every vertex of the hand-rolled tool is a pointer event. `fitRows` pads `fitBounds` by the measured `.landing-panel` — the left column above 48rem, the bottom sheet below — and fires on the 0→1 pick as well as for the example chips, so the first feed taken is framed and no later one moves the view. `#locate-me` is the ONLY caller of `navigator.geolocation`, and only on a press — never at load, never at map init — so the permission prompt is always the reader's doing; it is hidden where the API is missing or the origin is insecure. A position lists `rowsNear(st.rows, lat, lon)` in the results (the switches govern it, like a drawn shape; a typed query is cleared), drops a `maplibregl.Marker` there and eases the map to it, and works with MapLibre blocked because the list, not the map move, is the result. A refusal or failure writes `st.locate` for the note and nothing else. A catalogue pick past `MAX_FEED_GAP_M` from every current pick is refused inside `addRow`, the one door the results, Enter, a marker click and a shape's sweep all use, and the results list marks such rows with their distance and a disabled Add. Picks that stop chaining without an add (a middle one removed; an example chip beside a far drawn area) get a note, never a silent removal. |
| `worker.js` | worker | — (module worker entry; pipeline orchestrator, stage emitter) |
| `lib/core.js` | worker+main | numbers, formatting, deterministic JSON, hashing, constants |
| `lib/geo.js` | worker+main | geometry toolkit |
| `lib/catalog.js` | main | `loadCatalog`, `feedUrlOf`, `visibleRows`, `searchCatalog` (→ `{rows, total}`, so a truncated list can say how many more matched), `rowsIntersectingRing`, `rowsNear(rows, lat, lon, {withinKm, limit}) → {rows, total}` (boxes containing the point first, then within `NEAR_KM` edge to edge, ties to the bigger `t`), `centroidOf`, `spanKmOf`, `gapKmOf(row, boxes)`, `tooFarFrom(row, boxes)` (past `MAX_FEED_GAP_M` from every box), `labelOf`, `placeOf`, `sourceRefFor`, `osmSourceRef`, `CATALOG_VERSION`; `EXAMPLE_MAPS` and `exampleMapsFor(doc) → {examples, missing}` — the hand-curated example-map chips, catalogue ids only, validated by `tools/mdb-snapshot.mjs --check` (every id present, none behind a key or inactive, each list within `MAX_FEEDS_PER_RUN`). Reads `data/feeds.json`, generated offline by `tools/mdb-snapshot.mjs` and reviewed as a diff. No DOM, no MapLibre; importable from Node. |
| `lib/cache.js` | worker | `openCache`, `Cache`, `CacheMiss` — content-addressed IndexedDB cache |
| `lib/http.js` | worker | `httpFetch`, `sleep` — fetch with mirror failover, retries, courtesy sleep |
| `gtfs/feed.js` | worker | `loadFeed`, `unzip`, `normaliseTimes`, `feedWindow`, `StopTimes`, `attachStopTimes`, `stopTimesOf` (`StopTimes.appendFrom` is how `gtfs/merge.js` copies a columnar store; `stopTimesOf` serves the merge and `buildServiceDay`), `tripRows(feed)` (trip_id → `Int32Array` of stop_time row indices, sorted by `int(stop_sequence)`), and `s1Cache` / `s1Invalidate` — the **one** per-feed memo worker-side (a non-enumerable own property on the `Feed`, keyed by name; one store, one meaning per key). `normaliseTimes` calls `s1Invalidate` whenever the columnar store is rebuilt; nothing else invalidates. The shared numeric helpers `s1Median`, `s1Share`, `s1Int`, `s1Float` live here too. |
| `gtfs/merge.js` | worker | `mergeFeeds`, `mergeOrder`, `feedSourceRows`, `MERGE_TABLES`, `NAMESPACED_COLUMNS` — table-level merge of several feeds into one `Feed` |
| `gtfs/service.js` | worker | `dayTypes`, `buildServiceDay`, `clusterStations`, `noServiceDates`, `busiestDay` (the one implementation of "the day this report is about" — see the service-day layer), `s1BestDirGaps` (best route-direction median headway per stop, read by `gtfs/network.js`'s `s1DayMetrics` and by `buildServiceDay`) |
| `gtfs/raptor.js` | worker | `raptor`, `raptorReverse`, `buildJourney` |
| `gtfs/network.js` | worker | `zoneCover`, `buildZones`, `networkMetrics`, `routeHeadways`, `radarLiveness`. `networkMetrics`, `s1DayMetrics` and `buildZones` take a trailing `inPlay: string[]|null`; the metrics memo key gains `in:<length>:<stableHash(join(','))>`, or the literal `'all'` when `inPlay` is null, which keeps a no-override run on its original key. `inPlayForDay` is the one place the per-day intersection is written; it falls back to the whole day when the intersection is empty. |
| `gtfs/infer.js` | worker | `inferHub`, `inferBorder`, `inferGameSize`, `travelTimeSamples`, `gtfsQuestionFacts`, `excludedStopSet`, `inPlayStopIds`, `hubRun`, `suggestBorder`. `hubRun(feed, day, originId, departS)` is the **one** memoised forward RAPTOR from the run's origin (`s1Cache` key `raptor:<dayKey>:<origin>:<departS>`), shared by `inferBorder`, `s1DayMetrics` and `suggestBorder`. `gtfs/network.js` imports `hubRun` and `gtfs/infer.js` imports `networkMetrics`: a **function-body-only** cycle that ESM hoisting resolves, commented at both imports. Do not add a top-level use on either side. |
| `osm/flatgeobuf.js` | worker | `FlatGeobufReader`, `levelBounds`, `nodeCount`, `GEOMETRY_TYPE`. Pure transport: reads a FlatGeobuf over HTTP Range, knows nothing about parks. |
| `osm/worldfile.js` | worker | `openWorld`, `worldPois`, `worldCount`, `worldDensity`, `worldAdminAreas`, `worldTransitRoutes`, `adminAreasAt`, `featuresToPois`, `representativeFromGeometry`, `worldProvenance`, `worldStatsLine`, `worldLayerRecord`, `worldSnapshot` |
| `osm/geodata.js` | worker | `GEO_CATEGORIES`, `CAR_STREET_SELECTOR`, `FOOT_WAY_SELECTOR`, `LOW_STREETVIEW_COUNTRIES`, `collectGeodata`, `buildPoiIndex`, `zoneInventory`, `adminInfo`, `curseCounts`, `legalEndgameSpots`, `emptyGeoData(bbox)`. Only `GEO_CATEGORIES` and `LOW_STREETVIEW_COUNTRIES` cross into `rules/audit.js`; `CAR_STREET_SELECTOR` is the `car_street` entry's own `selector` (declared above the table so it can be), so audit reads it through `GEO_CATEGORIES` like every other category. |
| `osm/synth.js` | worker | `synthesizeFeedZip` plus the frozen `SYNTH_*` assumption constants (`SYNTH_MODE_ROUTE_TYPE`, `SYNTH_MODE_SPEED_KMH`, `SYNTH_MODE_HEADWAY_S`, `SYNTH_DWELL_S`, `SYNTH_SERVICE_WINDOW_S`, `SYNTH_TEMPLATE_ANCHOR_S`, `SYNTH_CALENDAR_DAYS`, `SYNTH_FALLBACK_ASOF`, `SYNTH_CLUSTER_NAME_M`, `SYNTH_CLUSTER_ANY_M`, `SYNTH_HEADWAY_MIN_S`, `SYNTH_HEADWAY_MAX_S`), quoted by `rules/catalogue.js`'s three `osm_synth_*` INTERPRETATIONS rows in both `text` and `data` — move a constant and re-sync both. Pure and synchronous: `worldTransitRoutes` output + the drawn ring + `asOf` → a byte-deterministic GTFS zip (`Uint8Array`) the **untouched** `loadFeed` accepts, plus prose notes. Imported DYNAMICALLY by `worker.js` only for a `kind:'osm'` source. Harness: `node tools/test-synth.mjs`, network-free. |
| `rules/catalogue.js` | worker+main | `QUESTIONS`, `CURSES`, `INTERPRETATIONS`, `catalogueFor`. Frozen data importing nothing but `lib/core.js`, so `render/deck.js` and `render/strategy.js` read it on the main thread. The size table lives in `gtfs/network.js` as `S1_SIZE_PARAMS`, the radar radii as `S1_RADAR_MILES`. `INTERPRETATIONS`' `map_border_derivation` row is plain data: `text` is the `'reach'` sentence and `byDerivation` holds `{option: '…the box you set on the landing map, with no padding…'}`; `buildProvenance` picks between them. A `text` that became a callback would break every main-thread reader that treats this file as data. Also `THERMO_DEGENERATE_SHARE`. `INTERPRETATIONS` rows may carry `lead`, `byDerivationLead`, `groups` and `data`; `CURSES` rows carry `test`. All plain data. |
| `rules/audit.js` | worker | `answerSignature`, `survivalFractions`, `globalQuestionOrder`, `auditQuestions`, `auditCurses`, `questionCategories` |
| `rules/score.js` | worker | `ramp`, `rramp`, `plateau`, `tenths`, `scoreFitness`, `fitnessCaps`, `scoreZones`, `rankZones`, `selectDossiers`, `deriveFindings`, `deriveRecommendations`, `buildProvenance(opts, feed, geo, size, asOf, degradations, border = null)`. The trailing `Border` is optional; a caller that omits it gets the `'reach'` interpretation text. The provenance shape gains only `borderSource`; `argv` is untouched because it already echoes each `Options` field as a flag string, and there is no `Options` field for where a box came from. |

**Import edges added deliberately.** `rules/score.js` imports `busiestDay` from
`gtfs/service.js` — the only `rules/` → `gtfs/` edge. Both are worker-side, `worker.js`
already loads both, and the graph stays acyclic: `gtfs/` imports nothing from `rules/`.
`gtfs/infer.js` imports `s1Median` / `s1Share` from `gtfs/feed.js`, which imports only `lib/`.

### `lib/core.js` — exported symbols

Constants: `GENERATOR VERSION M_PER_MILE M_PER_KM QUARTER_MILE_M HALF_MILE_M
SQM_PER_SQMI EARTH_R_M WALK_SPEED_MPS WALK_RADIUS_M WALK_CIRCUITY BOARD_SLACK_S
MAX_TRANSFERS DEFAULT_DEPARTURE SERVICE_DAY_SECONDS HEADWAY_WINDOW MIDDAY_WINDOW
FREQUENT_HEADWAY_MIN STATION_CLUSTER_M HUB_SNAP_M T90_ORIGIN_STRIDE
RADAR_SAMPLE_PAIRS RADAR_DEAD_HIGH RADAR_DEAD_LOW SEEKER_SAMPLE_CAP
SURV_FULL_UNIVERSE_MAX HUB_RADIAL_MIN HUB_SEMI_RADIAL_MIN IN_PLAY_MIN_SHARE
SUGGEST_MIN_TRIM_SHARE SUGGEST_MIN_EVENT_SHARE SUGGEST_MIN_CORE_STOPS
SUGGEST_MIN_CORE_SHARE
MAPLIBRE_JS TILES_LIGHT TILES_DARK MAX_FEEDS_PER_RUN IMPERIAL_COUNTRIES
DEGRADE_KIND FINDING_MINUS_BELOW FINDING_PLUS_ABOVE FITNESS_MIN_AVAILABLE_POINTS
NETWORK_SHAPE_LABEL DIRECTION_WORD`

Functions: `rhu num pct mins miles milesRange km sqmi coord hhmm hhmmss hmsToS prettyDate
dowOf dateRange lowerMedian quantile cmpStr jdump sha256Bytes sha256Text stableHash
fillPct explainText fare capWord shapeWord directionWord`

Notes:
* `num(x, dp = 0, {comma = true})` takes a trailing options object for its non-required parameters.
* `miles(metres, dp = 2)` trims trailing zeros (`10 mi`, `0.5 mi`, `18.99 mi`). Formatting only; the value is unchanged. `milesRange(lo, hi, dp = 2)` prints a range with the unit once (`2.72–9.37 mi`), each end as `miles()` prints it.
* `directionWord(id)` is the one place a GTFS `direction_id` becomes a word, through `DIRECTION_WORD` (0 → outbound, 1 → inbound).
* `capWord(s)` capitalises the first letter and leaves the rest alone (the worker cannot import a renderer's `cap`). `shapeWord(shape)` is the one place `Metrics.networkShape` becomes a word, through `NETWORK_SHAPE_LABEL` (`radial-hub` → hub-and-spoke, `semi-radial` → partly hub-and-spoke, `polycentric` → multi-centred).
* `jdump(obj, {floatDp = 6})` is the **only** deterministic-serialisation entry point. Its private `emit()` holds every rule: non-finite → null, `rhu` quantise, sorted `Set`/`Map`/object keys, `TypeError` on anything else.
* `HEADWAY_WINDOW`/`MIDDAY_WINDOW` are frozen 2-element arrays of `'HH:MM:SS'`.
* `MAX_FEEDS_PER_RUN` is the run's feed cap (10). It lives in `lib/core.js` because three modules must agree on it: the picker refuses the eleventh pick, `readSources` refuses an eleventh that arrived by the other door (ten map picks plus a dropped zip), and `normaliseSources` refuses one the worker was handed anyway.
* `MAX_FEED_GAP_M` (75 000) is how far apart, edge to edge, two feeds' boxes may sit and still chain into one map. The picker's `addRow` refuses a catalogue pick past it from every current pick; `mergeFeeds` measures each loaded feed's stop box and emits `merge_far_apart` when the feeds do not chain, warning and never refusing, because a dropped zip or URL has no box before it loads. `tools/mdb-snapshot.mjs --check` fails an example map whose feeds do not chain.
* `cmpStr(a, b)` is the shared code-point string comparator (§0 *Sorting strings*). `byString` and `jdump` use it too.
* `IN_PLAY_MIN_SHARE` (0.5) is the floor under `inPlayStopIds`; `SUGGEST_MIN_TRIM_SHARE` (0.05), `SUGGEST_MIN_EVENT_SHARE` (0.5), `SUGGEST_MIN_CORE_STOPS` (100) and `SUGGEST_MIN_CORE_SHARE` (0.10) are `suggestBorder`'s four gates. Each carries its one-line rationale at the declaration; move one and the rationale moves with it.
* `IMPERIAL_COUNTRIES` is a frozen **sorted Array** (`['gb','lr','mm','us']`), not a Set, so it is clone-safe. Use `.includes()`.
* **`sha256Text` and `sha256Bytes` are `async`** — `crypto.subtle.digest` returns a Promise. Every caller must `await`.
* `stableHash(text)` is **synchronous** and returns 16 hex characters, for a click handler building a `SourceRef` id that cannot await `crypto.subtle` (and must not require a secure context). It is a **stable identity, never a content address**. `sha256` fields stay `sha256Text`/`sha256Bytes`; do not unify the two.
* `rhu` is round-**half-up** on the shortest round-trip decimal string, verified equal to `Decimal(repr(x)).quantize(…, ROUND_HALF_UP)` on the boundary cases (`2.675→2.68`, `1.005→1.01`, `0.145→0.15`, `-0.5→-1`). Do not simplify it to `toFixed`.
* `num(-0.4)` returns `'-0'`. Kept deliberately.
* `hhmm`/`hhmmss` never modulo 86400. `hhmm(87360) === '24:16'`.
* `dowOf`/`dateRange`/`prettyDate` are pure calendar arithmetic on `'YYYYMMDD'`. **Never** `new Date(string)` — that reads the host timezone. `prettyDate` hard-codes English abbreviations so it cannot follow the browser locale.
* `fillPct(part, whole = 1)` is the one channel from a measured fraction to a bar's 0–100 value; a renderer never multiplies or divides for a fill. `explainText(lead, detail)` builds the legacy `why` from an `Explain`. `fare(price, currency)` formats a `fare_attributes` price without `Intl`.
* `DEGRADE_KIND` is the closed vocabulary of degraded and limited states (§(f) rule 8).

### `lib/geo.js` — exported symbols

`haversineM Projection bboxOf bboxExpand bboxContains bboxUnion bboxIntersection
bboxAreaSqM bboxScale bboxGapM bboxChains segIntersects bboxIntersectsRing
convexHull polygonArea ringCentroid pointInRing representativePoint polylineMidpoint
segPointDist ringWithin minEnclosingCircle GridIndex`

Conventions:
* Geographic point = `[lat, lon]` degrees. Planar point = `[x, y]` metres. Bbox = `[S, W, N, E]` (**Overpass order, not GeoJSON**). Ring = array of planar points, first point NOT repeated.
* `Projection` is a class: `new Projection(lat0, lon0)`, `Projection.about(points)`, `Projection.from({lat0, lon0})`. Methods `xy(lat, lon) → [x, y]`, `lonlat(x, y) → [lon, lat]` (note the order; the sole planar→geographic method), getters `mPerDegLat` / `mPerDegLon`, `toJSON() → {lat0, lon0}`. **Projection instances cannot cross `postMessage`** — send `{lat0, lon0}` and rebuild with `Projection.from()`.
* `segIntersects(a, b, c, d) → boolean` is the planar orientation test, collinear overlap included. `bboxIntersectsRing(bbox, ring) → boolean` checks **all three** cases — a box corner inside the ring, a ring vertex inside the box, a box edge crossing a ring edge — because any one alone is quietly wrong. Both are used by the landing picker to decide which feeds a drawn shape sweeps up.
* `GridIndex(cell)`: `.add(key, x, y)`, `.addBbox(key, minx, miny, maxx, maxy, {cap = 400}) → boolean`, `.near(x, y, radius) → [[key, x, y], …]` sorted by `String(key)`, `.nearKeys(x, y, radius) → [key, …]` deduped + sorted. `radius` may be `Infinity`; the 3×3 neighbourhood restriction still applies and is load-bearing for the area-index callers. Holds a `Map` — **not clone-safe**, build inside the worker.
* `bboxUnion(bboxes) → bbox|null`, `bboxIntersection(a, b) → bbox|null`, `bboxAreaSqM(bbox)` and `bboxScale(bbox, factor)` (about the centre, clamped to ±90/±180) are the landing frame's arithmetic. `bboxAreaSqM` uses the same 111132 / 111320·cos(mid) constants as `Projection` and `bboxExpand`, so the caption's area and the border's area cannot drift apart.
* `bboxGapM(a, b) → metres` is the edge-to-edge distance between two boxes (0 when they touch), on the same constants. `bboxChains(bboxes, maxGapM) → number[][]` groups boxes by single linkage within `maxGapM`, each group ascending indices, groups ordered by first index; one group means one map (`MAX_FEED_GAP_M`).
* `minEnclosingCircle` returns `[cx, cy, r]`. It uses a fixed-seed `mulberry32(0)` Fisher–Yates over the sorted+deduped point list rather than any source of entropy, so the circle is permutation-invariant up to fp noise inside the existing `1e-7` slack.

### Constants NOT in `core.js` — owned by `lib/http.js`

```js
export const HTTP_TIMEOUT_S = 300.0;
export const HTTP_ATTEMPTS_PER_ENDPOINT = 2;
export const HTTP_BACKOFF_S = 8.0;            // between attempts on the same endpoint
```

`httpFetch` has exactly one caller — `gtfs/feed.js` downloading the feed zip. There is no
Overpass or Nominatim endpoint and no `OVERPASS_WAY_BUDGET`: the OSM layer reads prebuilt
FlatGeobuf world files over HTTP Range (`osm/flatgeobuf.js`), which calls `fetch` directly
and touches neither `lib/http.js` nor the cache. See `tools/osm-world/README.md`.

The LLM constants (`LLM_URL`, `LLM_MODEL`) and everything under `--llm` are **dropped**.

---

## (b) Data shapes

All shapes are plain JS objects. Field names are camelCase; the trailing comment on a field
gives the underlying GTFS column name where one exists (used verbatim as CSV headers and
merge-table keys elsewhere in the codebase), or the field's short snake_case alias otherwise.

A set-like collection is a sorted JS **Array** unless stated otherwise (a `Set` is not
clone-safe). An ordered tuple is a JS **Array**. A string-keyed map is a plain object;
**iteration order is never significant** — sort the keys.

### Shared row shapes

```js
/** @typedef {{lead: string, detail: string}} Explain
 * `lead` is templated plain text of at most 14 words (a house rule: an imperative of at
 * most 8; an interpretation: at most 6), no trailing period, '' only when `facts` carry the
 * finding. `detail` is zero or more sentences, folded on the page. Every number in `lead`
 * or `facts` also appears in the record's full string (a `Recommendation`: `text` or `evidence`). */
/** @typedef {Object} Fact  // one always-visible chip, formatted worker-side
 * @property {string} text @property {string} icon
 * @property {'neutral'|'brand'|'success'|'warning'|'danger'} variant
 * @property {number|null} fill  // 0..100 from fillPct(), or null */
/** @typedef {string} DegradeCode  // a key of lib/core.js DEGRADE_KIND; see §(f) rule 8 */
```

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
 * `tables.stop_times` is the exception: a lazy `Proxy` over the columnar `StopTimes`
 * store that materialises a row dict per index access. It currently has no readers —
 * `buildServiceDay` walks `stopTimesOf(feed)` / `tripRows(feed)` directly and
 * `gtfs/merge.js` refuses it — which is the precondition for ever deleting the view.
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
 * @property {string} [fareAgency]                 // MERGED FEEDS ONLY: whose `fare_attributes` rows the merge carried, so the fare house rule can name them. Absent on a single-feed run.
 */

/**
 * @typedef {Object} FeedSourceRow   // one input feed of a run. Clone-safe; §09 prints them all.
 * @property {string} tag            // 'f0' — the namespace prefix, minus its colon
 * @property {string} label          // what the page calls it: 'The Rapid', 'mbta.zip'
 * @property {string} source         // the URL or File name `loadFeed` recorded
 * @property {string} sha256         // this feed's own hash — NOT the merged one
 * @property {string|null} mdbId     // Mobility Database catalogue id, or null
 * @property {string} agencyName @property {string} agencyUrl @property {string} timezone
 * @property {string} feedStart @property {string} feedEnd @property {string} feedVersion
 * @property {number} stops @property {number} routes @property {number} trips
 * @property {boolean} synthesized   // true iff built from an OpenStreetMap ring
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
  touched, no typed view rebuilt. `tools/smoke.mjs` asserts it with a literal `===`. Do not
  tidy the fast path away.
* **Merge order is content-addressed**: feeds are sorted by `(sha256, source, input
  index)`, code-point, and tagged `f0`, `f1`, … in that order. The merged feed is a pure
  function of the feed bytes, independent of download order, the main thread's sort key,
  and which source failed and was dropped.
* **Ids are namespaced ALWAYS, not on collision.** Every id column grows a `f{i}:`
  prefix, so an id's spelling never depends on which other feed was picked. If any
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
  `stop_times`, `stops`, `transfers`, `trips`. Everything else is dropped, because an
  unknown extension table carries un-namespaced ids.
* **`fare_attributes` carries exactly ONE feed's rows.** The primary feed (most trips, ties
  to merge order) supplies them when it has any; otherwise the first feed in merge order
  with fares does. `deriveRecommendations` prints `fare_attributes[0]`'s price as *the*
  fare, so a concatenated table would quote one operator's fare as the merged system's, and
  the primary's empty table would lose a small city's house rule beside a fare-less
  neighbour. `Feed.fareAgency` names whose fare it is.
* **`feed_info` is one synthesised row** carrying the merged window, so `_s1WindowDates`
  agrees with the window the merge computed. Each feed keeps its own `calendar` /
  `calendar_dates` rows.
* **The window is the INTERSECTION** — `max(feedStart)` … `min(feedEnd)` — because
  `dayTypes` picks a representative date by trip count over the window and a union could
  land on a date one feed runs nothing on. An empty intersection falls back to the union
  and emits a `degraded`; an intersection under seven days emits one too.
* **Mixed timezones warn, never refuse.** `Feed.timezone` is display-only and every time
  in the pipeline is feed-local seconds since midnight, so a mixed-zone merge is wrong only
  about the clock alignment of a ride *between* the systems — a `degraded` message, not a
  crash. `merged.timezone` is the primary feed's.
* **Cross-feed connectivity is free.** `s1Footpaths` (`gtfs/service.js`) builds footpaths
  geometrically from stop proximity within `WALK_RADIUS_M` and only *consults*
  `transfers.txt`, so two agencies whose stops sit 40 m apart connect without a row.
* **No merged-artifact cache.** The per-source download cache is unchanged
  (`httpFetch`'s `cacheKey` is the exact URL); a `Feed` holds typed arrays and a Proxy and
  is not serialisable. `merged.sha256` is the hash of the tagged per-feed hashes — a run
  **identity**, not a storage key.

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

> `patterns` / `patternAtStop` / `footpaths` / `stopIndex` and `extras` are **internal to
> `gtfs/`** (typed arrays / Maps) and **must be stripped** before any `ServiceDay` crosses
> `postMessage`. See §(d) — the `'days'` stage sends summaries, not `ServiceDay` objects.
>
> Internal shapes, for the GTFS agent only:
> `_S1StopIndex {byId: Map<string,number>, ids: string[]}`;
> `_S1Pattern {stops:number[], dep:number[][], arr:number[][], tripIds:string[], tripRoutes:string[], routeId:string, directionId:string, sortedCols:boolean}` — column-major so the board lookup is a bisect; `sortedCols === false` ⇒ this pattern overtakes itself, scan linearly;
> `_S1DayExtras {tripRoute, dedup, routeDirStop, stopRoutes, stopName, routeLabel}`.

**Which day the report is about is ONE function.** `busiestDay(days)` (`gtfs/service.js`)
is the whole rule: maximum `trips`, ties to the larger `dayType.key` by code point. It is
imported by `worker.js`, `gtfs/network.js`, `rules/score.js` and `gtfs/infer.js`, so
`Report.selectedDay`, `Metrics.bestDay`, the route-headway table, the travel samples and
S3's one-route share cannot pick different days. `busiestDay` **requires a non-empty
list**; each caller keeps its own empty-days answer (throw / `[]` / `null` / `0.0`).

`s1BestDirGaps(routeDirStop)` is the one implementation of the `stop_id → best
route-direction median headway` map over `HEADWAY_WINDOW`, called by `buildServiceDay` (on
its cleaned route-direction table) and by `gtfs/network.js`'s `s1DayMetrics` (on
`day.extras.routeDirStop`). The two callers cut the result at **different** thresholds on
purpose — `frequent` at `FREQUENT_HEADWAY_MIN` (15 min), `within30` at 30. Do not
reconcile them; the goldens move if you do.

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
 * @property {number} requiredHours           // required_hours — 6 / 10 / 12. INFERRED, not transcribed: the rulebook gives a size's length only as prose and never an hours-per-playing-day figure. Metrics built on it are tagged `interp`.
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
 * @property {[number,number,number,number]} bbox   // bbox — (S, W, N, E), padded by one zone
 *                                   //   radius; or the reader's own box, UNPADDED (padM 0)
 * @property {[number,number,number,number]} rawBbox// raw_bbox — before padding; EQUALS bbox
 *                                   //   when derivation is 'option'
 * @property {[number,number,number]} circle        // circle — (lat, lon, radiusM)
 * @property {number} padM                          // pad_m — 0 on an 'option' border
 * @property {Object} geojson                       // geojson — a GeoJSON Feature, {type:'Feature', properties:{kind}, geometry:{type:'Polygon', coordinates:[ring]}}; ring is [lon,lat] pairs, closed
 * @property {number} areaSqM                       // area_sq_m
 * @property {string[]} trimmedStopIds              // trimmed_stop_ids — sorted cmpStr: the
 *                                   //   in-play stops outside the 3× hiding-period
 *                                   //   there-and-back reach of the hub, after the two 50 %
 *                                   //   fallbacks (exclusions removed first)
 * @property {'reach'|'option'|'option_fallback'} derivation // derivation — 'option' iff
 *                                   //   options.borderBbox; 'option_fallback' when there WAS a
 *                                   //   box and `inPlayStopIds` fell back off it: the rectangle
 *                                   //   is still the reader's and is still drawn, but nothing
 *                                   //   was measured inside it. Stamped by worker.js after
 *                                   //   inferBorder, which is handed a set and cannot know.
 */

/**
 * `rawBbox`, `trimmedStopIds` and `derivation` are returned by `inferBorder`; `derivation`
 * conditions `rules/catalogue.js`'s `map_border_derivation` row.
 *
 * THREE derivations, each named distinctly wherever the border is described: §05's legend
 * label and copy-cluster chip (`render/map.js`), the `map_border_derivation`
 * interpretation's `lead` and `text` (`byDerivationLead`, `byDerivation`), the `use_borders`
 * house rule's facts (`rules/score.js`) and §09's border row (`render/deck.js`).
 * `'option_fallback'` is the one case where the drawn border and the measured numbers
 * disagree, so worker.js ALSO emits a `degraded` message (`border_not_applied`), and every
 * one of those places shows `degradeChip('border_not_applied')`.
 */

/**
 * @typedef {Object} SuggestedBorder // `Report.suggestedBorder`, or null.
 * A tighter, reachability-aware box the run OFFERS and never applies. Computed only by
 * `gtfs/infer.js` `suggestBorder` on the busiest service day, emitted on the `'network'`
 * payload and the `Report`. Renderers format it; nothing in `render/` or `rules/` derives a
 * number from it; applying it is a second run (§(d)).
 *
 * Reachability criterion: a stop is in the CORE of size `s` when its ONE-WAY RAPTOR
 * arrival from the run origin (`options.startStopId || hub.stopId`) at the run departure is
 * within `S1_SIZE_PARAMS[s].hidingPeriodMin` — the rule `ZoneReach.unreachableZoneIds`
 * uses, NOT `inferBorder`'s 3× there-and-back rule. The suggestion is the SMALLEST size
 * whose core, re-measured on those stops alone, votes that same size (ascending, stopping
 * at the all-stop vote), subject to `SUGGEST_MIN_EVENT_SHARE`, `SUGGEST_MIN_CORE_STOPS` /
 * `SUGGEST_MIN_CORE_SHARE` and `SUGGEST_MIN_TRIM_SHARE` (`lib/core.js`).
 *
 * `null` when `sizeOverride` or `borderBbox` is set (so a re-run inside the suggested box
 * offers nothing further and the loop converges), when the origin sees no departure on the
 * best day, when no candidate size is self-consistent, or when the suggestion would equal
 * the current game.
 *
 * @property {'bbox'} kind
 * @property {[number,number,number,number]} bbox   // = bboxExpand(rawBbox, S1_SIZE_PARAMS[sizeName].zoneRadiusM)
 * @property {[number,number,number,number]} rawBbox// the core stops' own bbox
 * @property {number} padM @property {Object} geojson @property {number} areaSqM
 * @property {'small'|'medium'|'large'} sizeName    // the accepted size
 * @property {number} hidingPeriodMin
 * @property {string} originStopId @property {number} departureS @property {string} dayKey
 * @property {number} coreStops                     // stops in the accepted core
 * @property {number} allServedStops                // the best day's UNFILTERED served count
 * @property {number} trimmedStops                  // = trimmedStopIds.length
 * @property {number} eventShare                    // 0..1, departure-weighted, of the core
 * @property {string[]} trimmedStopIds              // sorted cmpStr — the in-play stops the core
 *                                   //   leaves out (in-play MINUS core, not served minus core)
 * @property {Array<{feedIndex:number, agencyName:string, count:number}>} trimmedByFeed
 *                                   //   count desc, then feedIndex asc
 * @property {{axes:number[], hullSqM:number, t90Min:number, nZones:number, diameterM:number}} vote
 * @property {Array<{sizeName:string, keptStops:number, eventShare:number, vote:string|null, reason:string}>} candidatesTried
 *                                   //   every candidate in the order tried, so the page can say
 *                                   //   why nothing was offered. `reason` is one of
 *                                   //   'degenerate' | 'sparse' | 'outvoted' | 'accepted';
 *                                   //   'outvoted' is a core that clears both floors but whose
 *                                   //   own metrics vote a different size.
 * @property {'one_way_from_origin_within_hiding_period'} definition
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
 * @property {string} selector       // selector — Overpass QL with `{{bbox}}` UNSUBSTITUTED; printed verbatim on the page.
 *                                   //   NEVER empty: `car_street` carries the shared `CAR_STREET_SELECTOR`
 *                                   //   constant as its own selector, so the provenance record and
 *                                   //   `rules/audit.js` both just read `.selector`.
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
 *                                                    //   deliberately: the world-file build table was translated
 *                                                    //   from it, and a player can still re-run it.
 * @property {[number,number,number,number]} bbox     // bbox
 * @property {number} count                           // count
 * @property {string} cacheKey                        // ALWAYS ''. Vestigial — kept so the record shape is stable.
 * @property {string} endpoint                        // A world-file description: the layer's URL followed by feature
 *                                                    //   count, size, planet snapshot and sha256 prefix. For a layer
 *                                                    //   that is absent or empty there is no file, so it is prose
 *                                                    //   only and no URL appears. See worldProvenance.
 * @property {boolean} partial                        // TWO meanings. (1) a size guard forced a degraded query;
 *                                                    //   (2) for the six density-grid categories, always true —
 *                                                    //   the map-wide total is EXACT but the per-zone breakdown
 *                                                    //   is approximate. See §(f) rule 3.
 * @property {'feature'|'density'} source
 * @property {{url:string, features:number, bytes:number, sha256:string}|null} layer // null when no file shipped
 */

/**
 * @typedef {Object} AdminInfo       // class AdminInfo.
 * The administrative-division ladder for this map. `ordinals` maps 1..4 → OSM
 * `admin_level`, DERIVED not guessed: the first-division level is the LOWEST
 * `admin_level` in the map's `admin` layer carrying an `ISO3166-2` code (ISO 3166-2 is
 * by definition a country's principal subdivision), and ordinals 2–4 are the distinct
 * levels present across all zone centres above it. Everything is read off the polygons;
 * no network service is consulted. A missing ordinal is `null` and must render as
 * "no Nth division here", never as a guessed level. `place_name` is a service-weighted
 * census: each zone votes its `stopEvents`, the walk visits ordinals 4→3→2, and a
 * division wins with a third of the census — or, additively, with a ≥20% city-rung
 * plurality at ≥1.5× the runner-up where the country has an override-table entry. If
 * nothing wins, an ordinal-1 division holding ≥90% of the census is accepted iff its
 * name equals the feed's `agency_timezone` city (accent/case-insensitive, exact
 * otherwise) and no deeper rung holds that name; then the deepest LADDER-level admin
 * area at the map centre (`name:en` preferred); the caller falls back to the agency
 * name. Unknown country ⇒ every admin question is `unknown`, NOT `dead`.
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
client behaves as documented above). Under `"overture"` the admin layer's levels are
SYNTHETIC — country=2, dependency=3, region=4, county=6, localadmin=7, locality=8,
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
 * @property {boolean} verify        // ALWAYS true: the "within 10 ft of a routable path" join that
 *                                   //   cleared spots has no local equivalent, so every spot is unverified.
 * @property {string} osm            // '{osmType}/{osmId}'
 * @property {number} distanceM      // distance_m from the zone centre
 */

/**
 * @typedef {Object} GeoData         // class GeoData. Everything the OSM layer produces.
 * ABSENT CATEGORIES ARE ABSENT KEYS, and that is load-bearing: a category that was never
 * queried and a category with zero features are different states all the way to the page.
 * Never conflate them.
 * @property {boolean} available                                   // available — false only when no world-file layer could be read
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
 * @property {Object<string, DegradeCode>} noteCodes               // note → code
 * @property {boolean} pathJoinEvaluated                           // always false; the join has no local equivalent
 * @property {string|null} snapshot                                // 'YYYYMMDD'
 * @property {number|null} densityCellM
 * @property {{strong:string[], weak:string[]}} osmCoverage
 * @property {{tagged:number, total:number, qualifying:number}|null} cuisineStats
 * @property {string[]} cuisineRejected
 * @property {number|null} iconOffsetP90M
 * @property {{segments:number, names:string[]}|null} derivedShore
 * @property {Array<{a,b,aLabel,bLabel,distanceM}>} redundantPairs
 */
```

The unavailable form, which `osm/geodata.js` exports as `emptyGeoData(bbox)`
(mirrors `build_report`):

```js
{ available: false, bbox, pois: {}, counts: {}, zoneInventory: {}, zonePolygonHits: {},
  admin: { countryCode: null, countryName: null, placeName: null,
           ordinals: {}, perZone: {}, borderLevels: {}, source: 'unknown' },
  curseCounts: {}, cuisines: {}, legalSpots: {}, queries: [],
  notes: [], noteCodes: {}, pathJoinEvaluated: false,
  snapshot: null, densityCellM: null, osmCoverage: {strong: [], weak: []}, cuisineStats: null,
  cuisineRejected: [], iconOffsetP90M: null, derivedShore: null, redundantPairs: [] }
```

The worker's `osm_unavailable` degradation is the one record of the failure.

The manifest also lists **`transit_route`** — assembled OSM route relations
(subway/train/light_rail/tram/monorail/funicular), one MultiLineString feature per
relation, built by a global out-of-band pass (`tools/osm-world/build-transit.py` →
`merge.py --transit`) like `admin`, because a route relation is no more shardable than a
boundary. It is **not** a `GEO_CATEGORIES` member and `collectGeodata` never fetches it;
the only reader is the converter below. `merge.py` requires `--transit` on exactly the
runs it requires `--admin`, so a published world cannot silently lack the layer; a
**path-less** manifest entry is present-but-empty.

```js
/**
 * @typedef {Object} TransitRouteStop
 * @property {number} nodeId         // OSM node id of the relation's `stop` member
 * @property {string|null} name @property {string|null} nameEn
 * @property {number} lat @property {number} lon
 */

/**
 * @typedef {Object} TransitRoute    // one route relation, from worldTransitRoutes()
 * @property {number} osmId          // the relation id — every row is a relation
 * @property {{name, nameEn, ref, colour, operator, network, route, interval,
 *   duration}} tags                 // each string|null. A FIXED nine-key table read
 *                                   //   by column name, never a property sweep; the
 *                                   //   build's empty-string absents arrive as null
 * @property {Array<Array<[number,number]>>} lines // MultiLineString parts, [lat, lon]
 * @property {Array<TransitRouteStop>} stops       // travel order
 */
```

`worldTransitRoutes(world, bbox, opts = {}) → Promise<Array<TransitRoute>|null>`:
**`null`** — the manifest has no `transit_route` layer (a stale bucket, not a city without
rail; the caller must refuse the source, never report "no rail here"); **`[]`** — the
layer shipped and has nothing inside this bbox; otherwise the relations, sorted by
`osmId`. A relation whose `stops` JSON is missing or unparseable is dropped whole; a short
or unplaceable stop row is skipped and the rest of the line kept. Does NOT go through
`featuresToPois`; `Poi` grows no line field.

`osm/synth.js` turns that output into a real GTFS zip: `synthesizeFeedZip({routes, ring,
asOf}) → {zip: Uint8Array, notes: string[]}`. Stops are clipped to the drawn ring itself
(`pointInRing`, not the bbox); relations left with <2 in-ring stops are dropped; stop
nodes cluster into stations (same normalised name within 500 m, any pair within 100 m);
one route + template trip + `frequencies.txt` row per relation, times from
distance-along-line at per-mode speeds — the `SYNTH_*` constants in §(a) are the
authority. The calendar is 14 days from the **Monday of the week containing `asOf`**; the
no-`asOf` fallback `2030-06-01` is a Saturday, so that window starts Monday
**2030-05-27**. Nothing surviving clipping is an error, not an empty zip, routed through
the worker's ordinary per-source catch.

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
 * @property {string} removalRule    // removal_rule — plain words, printed folded under the row
 * @property {string} quote          // quote — verbatim rulebook trigger, tier 1 only
 * @property {string} test           // at most 8 words, tier 1–2; '' otherwise
 */

/**
 * @typedef {Object} QuestionAudit   // class QuestionAudit. One question's verdict — the core of §07.
 * @property {string} id @property {string} category @property {string} label @property {string} text
 * @property {'functional'|'weak'|'degenerate'|'dead'|'unknown'} status // status
 * @property {number} quality              // quality — 0..1, normalised per category
 * @property {number|null} instances       // instances — in-border N; null when not evaluated
 * @property {number|null} coverage        // coverage — photo questions: share of zones with the subject
 * @property {string} selector             // selector — the exact Overpass selector, or a GTFS note
 * @property {string} why                  // why — explainText(explain.lead, explain.detail)
 * @property {number|null} survMean        // surv_mean — mean surv over Z, for the funnel. FILLED IN PLACE by scoreZones; render questions AFTER scoring.
 * @property {boolean} borderline          // borderline — would flip under a modestly larger border
 * @property {number} draw                 // draw — card draw price, copied from the catalogue question definition
 * @property {number} keep                 // keep — card keep price, copied from the catalogue question definition
 * @property {Explain} explain
 * @property {Fact[]} facts
 * @property {DegradeCode|null} degrade    // non-null iff status is unknown; a partial evaluation is a warning Fact
 * @property {string|null} interpId
 * @property {number|null} marginCount
 */

/**
 * @typedef {Object} QuestionCategory  // one element of Report.questionCategories — questionCategories().
 * Health and risk are computed at the rules stage; renderers read them.
 * @property {string} category @property {number} n
 * @property {{functional:number, weak:number, degenerate:number, dead:number, unknown:number}} counts
 * @property {number} health @property {number} risk
 * @property {Array<{id:string, label:string, status:string}>} gone
 */

/**
 * @typedef {Object} CurseAudit      // class CurseAudit. One curse's verdict.
 * @property {string} id @property {string} name @property {number} tier
 * @property {'keep'|'warn'|'remove'|'player-choice'} action // action
 * @property {string} predicate      // predicate
 * @property {number|null} count     // count
 * @property {string} why            // why — explainText(explain.lead, explain.detail)
 * @property {Explain} explain @property {Fact[]} facts
 * @property {DegradeCode|null} degrade @property {string|null} interpId
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
 * @property {DegradeCode|null} degrade // null iff available
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
 * @property {number} lostTenths     // maxTenths − earnedTenths over available metrics
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
 * @property {Object<string, number>} perDayDelta // dayKey → score − selected-day score, 1 dp; {} without a selected day
 */

/**
 * @typedef {Object} FitnessCap      // one element of `fitnessCaps(...)`. Fitness only carries
 * `cappedBy`, so §Score Trace needs this to show "CAP_CATEGORIES: not evaluated"
 * rather than silently omitting it.
 * @property {string} id @property {number} cap
 * @property {boolean} fired @property {boolean} evaluated @property {string} why
 * @property {string} label          // the threshold as a short templated phrase
 */

/**
 * @typedef {Object} Threat          // class Threat.
 * One question that narrows the search onto a zone.
 * @property {string} questionId     // question_id
 * @property {string} label          // label
 * @property {number} surv           // surv — 0..1
 * @property {string} answer         // answer
 * @property {number} zonesRemaining // zones_remaining
 * @property {string} answerKey      // the answer class key
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

### Flat aggregate objects

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
 * @property {number} unservedStops // stopsInFeed − servedStops, stamped by worker.js
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
 * @property {boolean} assumedSchedule // set by worker.js, ALWAYS present — false on an
 *                                     //   ordinary run. True iff any loaded source was
 *                                     //   built from OpenStreetMap (kind:'osm'), and
 *                                     //   RUN-LEVEL on purpose: after mergeFeeds
 *                                     //   nothing can tell an invented timetable's
 *                                     //   trips from a published one's. See §(f) 7.
 * @property {Object<string, DayMetrics>} perDay             // dayKey → DayMetrics
 * @property {number} allServedStops   // all_served_stops — the UNFILTERED served-stop
 *                                     //   count on the best day, so the page can say
 *                                     //   "11,430 of 24,705" when a box is in force.
 * @property {boolean} inPlayFallback  // in_play_fallback — true when the in-play filter
 *                                     //   kept too few stops and the whole served set was
 *                                     //   used instead. `networkMetrics` is handed a set,
 *                                     //   not the options, so it writes `false` and
 *                                     //   worker.js overwrites the flag right after each
 *                                     //   call — the same pattern as `assumedSchedule`.
 *
 * STOP SET. Every Metrics quantity, the hub candidate list, `zoneCover`, `StopRow`s and
 * `inferBorder`'s served set are measured over the IN-PLAY SET = `servedStopIds` ∩
 * `borderBbox` − `excludeStops` − every stop whose routes are ALL in `excludeRoutes`,
 * computed once per run by `gtfs/infer.js` `inPlayStopIds`, which shares its exclusion set
 * with `inferBorder` through `excludedStopSet`. It FILTERS the cmpStr-sorted
 * `servedStopIds` and never re-sorts, because the T90 stride sample depends on that order.
 * With no override `null` is threaded instead of an array, so a no-override run takes the
 * original code path down to the memo keys — the identity the smoke goldens rest on. If
 * fewer than `IN_PLAY_MIN_SHARE` (lib/core.js) of served stops survive, the whole served
 * set is used and `inPlayFallback` is true. The hub run is a whole-network RAPTOR pass
 * whatever the set is, so `hubTravelP50Min`, `hubTravelP95Min` and
 * `reachWithinHidingPeriod*` are narrowed to the day's in-play set where they are counted:
 * a reach count printed against `servedStops` must never exceed it. `buildZones` takes the
 * set too, since the cover picks the CENTRES. Per DAY the set is intersected with that
 * day's served stops; a day the set does not touch is measured WHOLE (an empty set is
 * `RangeError: no points` in `minEnclosingCircle`).
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
 * @property {string} id @property {number} priority @property {boolean} required
 * @property {string} text // the full chat-ready rule; the copied checklist reads only this
 * @property {string} evidence // provenance string for report.json; never rendered
 * @property {'rulebook'|'feed'|'interp'} basis // what the rule rests on; rendered as a basisChip in the status row
 * @property {Explain} explain @property {string} icon
 * @property {Fact[]} facts @property {Array<{id:string,label:string}>} items
 * @property {number} itemsMore // items beyond the five the page shows as tags
 * @property {string[]} metricIds @property {DegradeCode|null} degrade
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
 * @property {'landing'|'suggestion'|null} borderSource // echoed from `Options.borderSource`; `argv` is unchanged
 * @property {boolean} llmUsed                     // always false in the browser port
 * @property {Array<{id, text, affects:string[], explain:Explain, applies:boolean, affectLinks:Array<{kind:'metric'|'guide'|'cap'|'question'|'curse'|'text', id, label}>, groups?:Array<{label, basis, ids}>, data?:Object}>} interpretations // sorted by id
 *   // A `guide` link is a hider's-guide metric named by the row's `guideMetrics` (its id
 *   // collides with a report metric, so it never renders as a provenance superscript).
 *   // A `cap` link carries its CAP_LABEL text, never its id. Radar and Thermometer question
 *   // labels are prefixed 'Radar · ' / 'Thermometer · ' because the two share labels.
 *   // `applies` is false only for an `osm_synth_*` row on a run with no synthesized
 *   // source; such rows still print, grouped.
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
 * @property {SuggestedBorder|null} suggestedBorder // suggested_border — the offer §05 prints; null is the common case
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
 * @property {QuestionCategory[]} questionCategories
 * @property {Object<string, DegradeCode>} degradationCodes // degradation message → code
 */
```

---

## (c) The Options object

Fields dropped as meaningless in a browser: `out_dir`,
`cache_dir`, `llm`, `llm_url`, `llm_model`, `selftest`, `-v/--verbose`, `argv`.

```js
/**
 * @typedef {Object} Options
 * @property {File|string} source        // source — a File picked from disk, or a GTFS URL string
 * @property {string|null} worldBaseUrl  // where the prebuilt world files are served from; null = `DEFAULT_WORLD_BASE_URL` (osm/worldfile.js).
 * @property {string|null} asOf          // as_of — 'YYYYMMDD', clamped into the feed window
 * @property {'small'|'medium'|'large'|null} sizeOverride // size
 * @property {number|null} zoneRadiusM   // zone_radius_m — metres
 * @property {number|null} hidingPeriodMin // hiding_period_min
 * @property {string|null} startStopId   // start_stop_id — overrides the inferred hub / round-start station
 * @property {'bbox'|'circle'} borderShape // border_kind
 * @property {[number,number,number,number]|null} borderBbox // border_bbox — (S, W, N, E) decimal degrees
 * @property {'landing'|'suggestion'|null} borderSource // PROVENANCE ONLY: where the box came from. No pipeline code reads it.
 * @property {string[]} excludeStops     // exclude_stops — SORTED + DEDUPED by the caller
 * @property {string[]} excludeRoutes    // exclude_routes — SORTED + DEDUPED by the caller
 * @property {string} departure          // departure — 'HH:MM:SS' on the representative day
 * @property {number} boardSlackS        // board_slack_s
 * @property {boolean} offline           // offline — a cache miss is a hard error instead of a fetch
 * @property {boolean} refresh           // refresh — ignore cached responses and refetch
 */

export const DEFAULT_OPTIONS = {
  source: '',
  worldBaseUrl: null,      // resolved to DEFAULT_WORLD_BASE_URL by worker.js, not here
  asOf: null,
  sizeOverride: null,
  zoneRadiusM: null,
  hidingPeriodMin: null,
  startStopId: null,
  borderShape: 'bbox',
  borderBbox: null,
  borderSource: null,     // provenance only
  excludeStops: [],
  excludeRoutes: [],
  departure: '09:00:00',   // DEFAULT_DEPARTURE
  boardSlackS: 0,          // BOARD_SLACK_S
  offline: false,
  refresh: false,
};
```

Normalisation the main thread performs before posting:
`departure` gains `':00'` when it has only one colon; `excludeStops` / `excludeRoutes` are
sorted and deduped; `borderBbox` must be exactly four numbers or it is an error;
`worldBaseUrl` must parse as an http(s) URL or it is an error, and loses any trailing
slashes (`openWorld` joins with one of its own).
`source` stays a **display string** and is carried in `options`; the inputs themselves
travel in the `run` message's `sources` list, not inside `options`. On a multi-feed run
`source` is the labels joined with `' + '`.

The landing map's **border frame** is a page control, not an `Options` field: it produces a
`borderBbox`. An untouched, auto-fitted frame sends **`null`** (the inferred border). A
frame that was dragged, typed into, seeded from an overlap or a drawn shape, or handed over
by "Re-run with this border" sends its rectangle, with `borderShape` forced to `'bbox'`.
`readOptions` decides this from the frame's own `mode`: while a frame exists
`#opt-border-bbox` is `readonly` and mirrors the frame (`app.js`'s `onPickerBorder` is the
one place that toggles `readonly`). With NO frame the field is the input again — the picker
only frames feeds with a catalogue bounding box, so a dropped zip, a pasted URL or a run
after a failed catalogue fetch would otherwise have no way to set a border. Do not add a
shape or ring field to **`Options`**; the one ring on the wire is *inside a `kind:'osm'`
`SourceRef`* (§(d)), where the ring IS the source, not a run setting.

`borderBbox`, `excludeStops` and `excludeRoutes` are honoured by `inferHub`,
`networkMetrics`, `zoneCover`, `stopRows` and `inferBorder`, not only by the border
rectangle: zones outside a supplied box are not built, and the box narrows the hub
candidates, the metric table, the size vote, the zone cover, the stop table and the border
trim (§(b) stop-set note). `borderSource` is provenance only. There is no
`#opt-use-drawn-border` checkbox: a drawn sweep ring is a sweep, not a border.

---

## (d) The worker protocol

`worker.js` is a **module worker**: `new Worker('./worker.js', { type: 'module' })`.

### Main thread → worker — exactly one message

```js
{ type: 'run', options: Options, sources: SourceRef[] }     // 1 ≤ sources.length ≤ MAX_FEEDS_PER_RUN (10)

/**
 * @typedef {Object} SourceRef       // main → worker. A `File` is clone-safe; a string is.
 * @property {'file'|'url'|'osm'} kind
 * @property {File|null} file        // kind === 'file'; null for 'osm'
 * @property {string|null} url       // kind === 'url' — http(s) only; null for 'osm'
 * @property {string} id             // STABLE IDENTITY, and what the list is sorted on:
 *                                   //   'mdb:<id>' | 'url:<the url>' | 'file:<name>:<size>'
 *                                   //   | 'osm:<stableHash of the ring>'
 * @property {string} label          // 'The Rapid' | 'mbta.zip' | 'OpenStreetMap rail near …'
 * @property {string|null} mdbId     // Mobility Database catalogue id, or null
 * @property {Array<[number,number]>} [ring] // kind === 'osm' ONLY: the drawn shape,
 *                                   //   [lat, lon] vertices quantised to 6 dp (so the
 *                                   //   same shape is the same id across sessions).
 *                                   //   The ring IS the input — there is no file and
 *                                   //   no url; the worker reads `transit_route` over
 *                                   //   its bbox and synthesizes the feed (§(b) OSM
 *                                   //   layer). Built by `lib/catalog.js`'s
 *                                   //   `osmSourceRef(ring)`.
 */
```

A `kind:'osm'` ref counts against `MAX_FEEDS_PER_RUN` like any other source. `normaliseSources`
refuses a ref with an unrecognised `kind` **by name** rather than letting it fall through to
`loadFeed`, so a stale page's third kind fails in the first stage; an osm ref with no usable
ring (absent, or fewer than 3 vertices) is refused the same way.

`sources` is the only carrier; there is no `file` / `url` pair. The main thread sorts the
list by `id`, code-point, before posting; the **merge** order is decided independently
inside the worker, from the feed bytes (§(b)). It is **exactly one message** however many
feeds it names: the worker never receives a second one and never posts back a request;
there is no request/response channel.

**"Exactly one message" is per Worker instance.** A re-run is a NEW DOCUMENT LOAD. `app.js`
writes the sessionStorage key **`jltg.rerun`** (`{v: 1, sources, options, note}`; `sources`
are `kind:'url'` or `kind:'osm'` refs only, `file` always `null`, because a `File` cannot
survive the reload — which is why §05's button is disabled when any source is a file) and
calls `resetToLanding()`, a `location.replace` of a fragment-less, query-less URL. `boot()`
reads the key and **removes it before validating**, validates with the same normalisers
`readOptions` / `readSources` use (`normaliseRerunOptions`, `normaliseRerunSource`), skips
`initLanding` and calls `startRun(sources, options)`. An invalid, file-bearing, wrong-`v`
or already-consumed value is ignored and the reader gets the ordinary landing. The feeds
come back from the IndexedDB zip cache, so run 2 downloads nothing. `note` is chip copy
for the second run's `#run-history`, not pipeline input: `{prevSize, prevBorderSource, run}`.

`runPipeline(options, source, emit)` also accepts a bare `File` / `Blob` / buffer / URL
string, or an array of them, as a list of one — the shape `tools/smoke.mjs` uses and the
path the golden numbers are measured on.

### Worker → main thread — many messages

| Message | Shape | Meaning |
|---|---|---|
| progress | `{ type:'progress', stage:string, label:string, done:number, total:number }` | Fine-grained; drives the header progress bar. **`total` may grow** as work is discovered — the UI must not assume it is fixed. |
| stage | `{ type:'stage', stage:string, payload:object }` | A section's data is ready. See the stage table. |
| log | `{ type:'log', level:'info'\|'warn', message:string }` | Diagnostics. Never rendered as report content. |
| degraded | `{ type:'degraded', message:string, code:DegradeCode }` | Appended to `Report.degradations`, recorded in `Report.degradationCodes`, shown in the toast and §09. |
| preview | `{ type:'preview', key:string, payload:object }` | A **hint** for the page while a long stage runs. Not a stage: never merged into the `Report`, never written into a `<script type="application/json">` block, never a `degraded`, a `log` or a progress caption. Painted only into a section that is still a skeleton and ignored once the key's owning stage has arrived. `tools/smoke.mjs` ignores it. See "Previews" below; the stage order is still exactly seven. |
| error | `{ type:'error', stage:string, message:string, fatal:boolean }` | `fatal: false` ⇒ the run continues degraded. `fatal: true` ⇒ no further messages will arrive. A non-fatal `error` is logged by `app.js`, never rendered: every non-fatal error is paired with a templated `degraded` message, which is the record. |
| done | `{ type:'done', report: Report }` | The complete `Report`. Always last. |

**Every payload must be structured-clone-safe**: plain objects, arrays, numbers, strings,
booleans, `null`, and `File`/`ArrayBuffer`/typed arrays. **No class instances, no `Map`, no
`Set`, no functions, no `undefined` as a meaningful value.** Modules may use `Map`/`Set`
internally but must flatten before emitting. `Projection` crosses as `{lat0, lon0}`.
`GridIndex` never crosses at all.

### Stage order — the UI hydrates in exactly this order

| # | `stage` | Payload | Unblocks |
|---|---|---|---|
| 1 | `'feed'` | `{ agencyName, agencyUrl, timezone, feedStart, feedEnd, feedVersion, publisher, asOf, sha256, source, feeds: FeedSourceRow[], stops: number, routes: number, trips: number, place }` — every scalar describes the MERGED feed; `feeds` names what it was merged from | hero |
| 2 | `'days'` | `{ days: DaySummary[], selectedDay: string }` | §06 (Service by day) |
| 3 | `'network'` | `{ zones: Zone[], hub: Hub, border: Border, suggestedBorder: SuggestedBorder\|null, size: GameSize, sizeInference: SizeInference, metrics: Metrics, routeHeadways: RouteHeadwayRow[], travelSamples: TravelSampleRow[], zoneReach: ZoneReach, routeSpokes: RouteSpoke[], spokeCap: {shown,total,source}, stops: StopRow[], proj: {lat0,lon0} }` — the `Report` carries `suggestedBorder` too | §05 and its stat rail; §06's ride chart and headway grid |
| 4 | `'geo'` | `{ geo: GeoData }` | stage 5; the hero and the wordmark re-read `place` from `geo.admin.placeName` |
| 5 | `'rules'` | `{ questions: QuestionAudit[], curses: CurseAudit[], questionOrder: string[], questionFunnel: number[], questionCategories: QuestionCategory[] }` | §07, §08 |
| 6 | `'score'` | `{ fitness: Fitness, caps: FitnessCap[], zoneScores: Object<string,ZoneScore>, rankedZoneIds: string[], dossierZoneIds: string[], findings: Finding[], recommendations: Recommendation[], questions: QuestionAudit[] }` | §01, §02, §03 |
| 7 | `'provenance'` | `{ provenance: Provenance, degradations: string[], degradationCodes: Object<string, DegradeCode> }` | §09 |

Notes on the stage payloads:

* **`'score'` re-sends `questions`.** `scoreZones` fills `QuestionAudit.survMean` *in
  place* — it is the only function that sees both the audit rows and the survival table.
  The UI must re-hydrate §07 from the `'score'` copy, not the `'rules'` copy.
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
   * @property {Object<string, number|null>} headwayByDay  // dayKey → median minutes, 06:00–22:00
   * @property {string|null} zoneId                  // the zone whose circle designates it, or null
   */
  ```
  **The row set is the busiest day's served stops, on every day.** Other days are
  expressed through `headwayByDay[k] === null`, never through extra rows:
  `render/strategy.js` counts these rows per zone and `servedStopCount` falls back to their
  length, so widening the set would move published numbers. A stop served only at the
  weekend never appears. `headwayByDay` is the **per-stop, all-routes, 06:00–22:00**
  median; §06's grid is the **per-route-direction, 10:00–14:00** one. They legitimately
  differ, so the map's frequency legend must name its window.
* **`ZoneReach`** — per-zone travel minutes from the round-start station, per day. Computed
  from the SAME RAPTOR runs `travelTimeSamples` makes (`dayRaptorRuns`), enforced by the
  signature `travelTimeSamples(days, zones, originStopId, departureS, count, runs)` with
  `runs` mandatory. So `perDay[bestDay].minutes[z]` and
  `ZoneScore.metrics.R1.raw × hidingPeriodMin` are two roundings of one number and the map
  cannot disagree with the hider's dossier. The counts are computed worker-side because a
  renderer may count, filter and sort but may not do arithmetic on a measured quantity.
  ```js
  /**
   * @typedef {Object} ZoneReachDay
   * @property {Object<string, number|null>} minutes   // zoneId → minutes, null = no journey
   * @property {string[]} unreachableZoneIds           // sorted; minutes === null OR > hidingPeriodMin
   * @property {number} reachableZones                 // zones.length - unreachableZoneIds.length
   * @property {string|null} furthestZoneId            // largest finite minutes; null if none
   * @property {number|null} furthestMinutes
   *
   * @typedef {Object} ZoneReach
   * @property {string} originStopId
   * @property {number} departureS
   * @property {number} hidingPeriodMin
   * @property {Object<string, ZoneReachDay>} perDay   // keyed by DayType.key
   */
  ```
* **`RouteSpoke`** — one drawn route-direction for the map's spoke layer. `coords` come from
  the longest shape per `(routeId, directionId)`, the SAME selection `s1RouteKm` makes for
  `routeKmOneDir`: both read one memoised `s1Shapes(feed)` (`gtfs/network.js`, `s1Cache`
  key `'shapes'`). The coords are decimated by iterative Ramer-Douglas-Peucker at
  `MAP_SPOKE_RDP_M` (20 m). `source` is `'stops'` when the feed ships no `shapes.txt` and
  the geometry is the longest ordered stop sequence per route-direction (a chord diagram,
  not a road alignment). The list is ranked by `(-maxTrips, shortName, routeId,
  directionId)` and capped at `MAX_MAP_SPOKES` (60) **worker-side**, so the bytes never
  cross `postMessage`; `spokeCap.shown < spokeCap.total` must be said on the page.
  `routeSpokes` imports `MAX_MAP_SPOKES` and `MAP_SPOKE_RDP_M` from `lib/core.js` as its
  parameter defaults.
  ```js
  /**
   * @typedef {Object} RouteSpoke
   * @property {string} routeId @property {string} shortName @property {string} longName
   * @property {string} directionId
   * @property {'shapes'|'stops'} source
   * @property {Object<string, number>} trips          // dayKey → trips on that day
   * @property {boolean} touchesHub
   * @property {Array<[number,number]>} coords         // [lon, lat], through core.coord()
   */
  ```
* **§05's rendered string must not depend on `rules` or `score`.** A string that changes
  there re-mounts the section, and a re-mount replaces the section's controls and their
  DOM state (`mountSection` moves the live `#netmap` across a swap that carries one on
  both sides, so the MapLibre instance itself survives; see "Previews").
  The stat rail moves at both stages, which is why it is a **nested** `data-section` host
  with its own `needs`/`redo`. §05's string does change at `geo` (`s4Imperial` flips km→mi
  and rewrites the zone radius, border pad and border area) and the section re-mounts; the
  live `#netmap` is adopted across that re-mount, so the instance is never rebuilt.
  Anything arriving after `network` reaches the map through `#stops`: `writeDataBlocks()`
  rewrites that block on **every** `applyStage` and calls `window.__jltg.refreshMapData()`,
  which pushes it through MapLibre's `setData`/`setPaintProperty`. That is why `network`'s
  `redo` is `['geo']`, not `['geo', 'score']`, and it is the only sanctioned channel for
  late-arriving map data. `s4MapCaption` (rendered into `#netcaption`) is part of §05's
  string and held to the same readable fields; its per-day variants ride in `#data` as
  `days[k].map_caption_html`, beside `banner_html` and `tiles_html`, so a day switch is an
  `innerHTML` swap.
  `renderNetworkMap` may additionally read `suggestedBorder` and one main-side field,
  `report.sourceKinds`, which `app.js` stamps on the report *before* the worker starts and
  never changes; it decides only whether `#suggest-rerun` ships `disabled`. The suggested
  box is a second static line layer, **`border-suggested-line`**, built empty in
  `buildLayers` and filled by `setData` from `DATA.suggestedBorder` at `network` (the
  `'extent'` highlight thickens both lines);
  its source is an empty `FeatureCollection` when there is no suggestion, so `applyHl` need
  not branch. The `#suggest-rerun` button is wired from `app.js` by **one delegated
  document-level click listener**, never from `PAGE_RUNTIME_JS` and never per mount,
  because §05 re-mounts at `geo`. `#suggest-note` ships `role="status"` and
  `tabindex="-1"` because the storage-refusal path (a private window with zero quota)
  writes its explanation there; `app.js` moves focus to it after writing.
* **Stages 4–7 must still emit when the OSM layer is unavailable**, carrying the
  degradation. See §(f).
* **`'feed'` seeds `place` with the agency name and no later stage payload replaces it.**
  `geo.admin.placeName` is known at stage 4, so `app.js` overwrites `report.place` in
  `applyStage('geo')` and the hero's `redo` carries `geo`. Only the final `Report` carries
  `place` on the wire.
* **S5 adds no payload here, deliberately.** The hider's guide (§(g)) is built entirely
  from fields the stages above already carry. The per-zone × per-day service block is
  **not** added: it would need `ServiceDay.stopDays[zoneId]`, which `daySummary()` strips
  before anything crosses `postMessage`. The guide's Service block is scope-reduced to
  metrics `S1` / `S2` / `S3` out of `zoneScores[id].metrics` plus `stops` filtered to the
  zone, on the scored day. Lost: first/last departure, the departure count, the 24-bin
  sparkline, per-day switching.
* `progress.stage` uses the same seven tokens plus finer sub-tokens (`'feed:unzip'`,
  `'geo:overpass'`, …). The UI maps any `stage` prefix before the first `:` onto its
  section. `preview.key` uses the same roots: `stops`/`hub`/`zones` belong to `network`;
  `geo:…` and `rules:…` to their stage.

### Previews — hints, not stages

The three long stages (`network`, `geo`, `rules`) deliver nothing to the page until they
finish. `preview` messages let the page paint *provisional* content meanwhile. One rule
above all others: **a preview never reaches the `Report`.** It is not merged into
`state.report`, not written into `#data` / `#questions-data` / `#curses-data` / `#stops` /
`#provenance`, not appended to `degradations`, not logged and not shown as a progress
caption. A run with every hook removed produces the byte-identical `Report`, progress
stream and log.

| `key` | posted | payload | owning stage (retires it) |
|---|---|---|---|
| `'stops'` | after the `'days'` stage message, once the in-play set is fixed | `{ lon: Float64Array, lat: Float64Array, name: string[], bbox: [S,W,N,E] }` — the rows `StopRow[]` will carry, in `servedStopIds` order: a FILTER of `inPlay ?? best.servedStopIds`, never a re-sort, coordinates through `coord()` | `network` |
| `'hub'` | right after `inferHub` | `{ stopId, name, lat, lon, dominant }` | `network` |
| `'zones'` | right after `buildZones` | `{ lon: Float64Array, lat: Float64Array, name: string[], radiusM }` — zone centres in `buildZones`' order | `network` |
| `'geo:category'` | from inside `collectGeodata`, as each category lane completes, through `hooks.onPreview(key, payload)` — in the NETWORK's completion order; the page sorts into `GEO_CATEGORIES` order before painting | `{ key, label, kind: 'read'\|'counted'\|'absent'\|'failed', count: number\|null }` — `counted` is an upper bound and must be printed as one; the six density-grid categories take no lane and emit nothing | `geo` |
| `'rules:question'` | from inside `auditQuestions`, per judged question, through `opts.onPreview(key, payload)`, in catalogue order | `{ id, label, category, status }` | `rules` |

* Payloads are structured-clone-safe and small; typed arrays for coordinate columns.
* The hooks are guarded on both sides: `collectGeodata` and `auditQuestions` wrap the call
  so a hook that throws cannot fail a category read or the audit, and `worker.js`'s
  `preview()` wraps the payload build and the `post` so a preview cannot fail the stage it
  decorates. A `'geo:category'` preview fires *after* its lane's outcome is decided, never
  inside the `try` that classifies it; it is the one per-category emission in
  `collectGeodata`, exempt from the "name the phase, not the category" caption rule because
  a preview is not output.
* `app.js` (`applyPreview`) accepts a preview only while `state.arrived` lacks the owning
  stage, and paints only into a host still marked `data-state="skeleton"` (through the
  `[data-preview]` slots the shell ships and, for the map, the skeleton's `#netmap-frame`);
  the section's own mount then replaces the host wholesale. Previews live in
  `state.previews`, a sibling of `state.report` that nothing in `writeDataBlocks`,
  `finish` or any renderer reads.
* **The map is the one place preview-built state persists.** `app.js` hands the three map
  previews to the page runtime as `window.__jltg.preview` (never through `#stops`) and
  `PAGE_RUNTIME_JS` `buildMap` creates the MapLibre instance from the `stops` extent while
  §05 is still a skeleton. The instance is built ONCE per run: `mountSection` ADOPTS the
  live `#netmap` node into the incoming §05 markup whenever both sides carry one (at
  `network`, and again at `geo`'s km→mi re-mount) and the next `injectRuntime()` pass
  re-attaches it (`resize`, `ScaleControl.setUnit`, control wiring, `setData`). Sources
  that used to be built at `style.load` (`border`, `border-suggested`, `n-mec`,
  `n-spokes`) start empty and are filled by `setData` when `network` lands; `zonerings`
  is seeded from the `zones` hint, then replaced by the real rings the same way.
  A rebuild happens only when no live instance owns the outgoing node (MapLibre blocked,
  or the import still in flight when `network` lands): at most one, and never after
  `network`.
* One viewport move is sanctioned: when the instance was created from the `stops` extent
  and the real border first arrives, `attachMap` calls `fitBounds` on the border exactly
  once, and skips it if the reader has already dragged or zoomed. Nothing else moves the
  viewport after creation; the "setData, never fitBounds" rule for late data stands.

---

## (e) `render/html.js` — pinned API

All functions return **HTML strings**, taking a single trailing options object for their
optional parameters, with `className` for the `class` attribute. The element helper is named
`voidEl()`, not `void()`, because `void` is a JS operator.

### The escaping contract — both renderers follow it exactly

* A parameter whose name ends in `Html` receives markup that is **already safe**. The
  helper inserts it verbatim. You build it with other helpers, or you call `esc()` yourself.
* Every other string parameter is **plain text**. The helper calls `esc()` on it.
* `esc()` is the only way text becomes markup. There is no "I know this is safe" exception
  — feed data contains apostrophes, ampersands and, in the wild, angle brackets.
* Attribute values always go through `attrs()`, which escapes them.
* Only WebAwesome 3.12 components with a helper below are sanctioned. If there is no helper
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
voidEl(tag, opts = {}) → string                        // <tag …>
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
waCopyButton(payload, { label='Copy', trigger='', ...attrs })  // trigger: slotted visible control; label stays the accessible name
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
        { kicker='', lede='', ledeHtml='', answerHtml='', answerVariant='neutral', answerIcon='circle-info' })
subhead(text, { anchorId='', badgeHtml='' })
kpi(value, label, noteHtml = '', { chipHtml='', subHtml='', size='2xl' })
swatch(style) → string                                  // <span class="sw" aria-hidden="true">
basisChip(source) → string                              // 'rulebook'|'feed'|'interp' → From the rules | Measured | Our call
degradeChip(code, { suffix='' }) → string               // DEGRADE_KIND word + icon + variant
factChips(facts, { className='' }) → string             // Fact[] → wa-cluster; '' when empty
miniMeter(fill, textHtml, { label }) → string           // fill from fillPct; label required
linkChip(href, text, iconName='', opts={}) → string     // <a class="wa-link-plain"> around chip()
iconLabel(iconName, text, { quiet=true }) → string
iconLabelHtml(iconName, contentHtml, { quiet=true }) → string
legendRow(items, { label='', leadHtml='' }) → string    // items: Array<[markHtml, text, liId?]>
leadDetail(leadHtml, detailHtml, { summary='Why', inline=false, chipsHtml='', afterHtml='', id='', dataBasis='', foldBelow=false, className='' }) → string
cardHeader(title, { caption='', captionHtml='', chipsHtml='', titleHtml='' }) → string
setProvNames(pairs)                                     // Iterable<[id, name]>; replaces the whole table
provChip(...ids)                                        // variadic
dataTable(headers, rows, { className='', ...attrs })   // always wrapped in a scroller
                                                        // headers: plain text; rows: PRE-ESCAPED markup cells
jsonBlock(blockId, payload)                             // floatDp is fixed at 6; escapes EVERY '<'
```

Behavioural notes that are load-bearing, not style:

* **Never introduce tabs.** A tab hides n−1 panels from Ctrl+F and from print, puts no
  state in the URL, and cannot hold a map or a canvas. There is no `waTabGroup` helper.
* **Never** put a map or a chart inside `waAccordion` or `waScroller`. MapLibre and
  Chart.js read their container size once, at construction; a collapsed item has none.
* `chip()` is the **only** sanctioned way to render a question status, a curse action, a
  finding severity or a metric source. Icon **and** word, never colour alone: against the
  off-white surface `--warn` and `--q-edge` are 2.38:1 and `--gold` 1.44:1, all under
  the 3:1 non-text floor.
* `meter()`'s `valuePct` and `waProgressBar`'s `value` are 0–100 and always come from `lib/core.js` `fillPct()`; no caller multiplies or divides.
* `budgetBar` is a `<wa-chart stacked index-axis="y">`, one dataset per segment
  (`wa-progress-bar` is a single-fill track). Pass `height`, never `style` — `style`
  replaces the whole style string and drops `aspect-ratio:auto`, letting the component's
  `:host{aspect-ratio:16/9}` win. The segment letters and the hover tip are painted by the
  `budgetSeg` plugin in `app.js`, which `bindBudgets()` attaches to every
  `wa-chart[data-budget]`; chart.js bundles no datalabels plugin and its own tooltip is
  clipped inside a 20px canvas. Never nest one inside a disclosure: a canvas in a
  `display:none` subtree measures 0.
* `pullQuote` — exactly one per page.
* `section()`'s `number` renders through `h2[data-n]::before`, so it exists only as an
  attribute, never as text a screen reader has to read twice. `answerHtml` is ONE line:
  either one plain sentence of at most 20 words, or one `wa-cluster` of chips and inline
  `<b>` figures; never two sentences, never a paragraph. Every number in it already comes
  from a formatter or a `Report` field. A section with nothing to add omits it.
* **Row detail is native `<details>`**, built by `leadDetail`, never `wa-details`: it opens
  for find-in-page, costs no component upgrade per row, and `app.js` opens it for print
  (`bindPrintDisclosures`) and for a fragment (`openTargeted`). Section- and card-level
  disclosures keep `waDetails`. The summary is an explanation's handle; a label, a basis chip
  or a `degradeChip` never sits only inside the fold.
* `provChip()` links to `#prov-{id}`; this is how "every point traces to a named metric"
  reaches the UI. The visible text is the bare code, so each link is named
  `Source: <metric or source name>` from the table `setProvNames` holds —
  `render/verdict.js` fills it from `fitness.subscores` in `renderHero`, the first
  section `app.js` renders on every stage; an id with no name keeps its code.
* A section with no data emits **nothing at all** — not an empty card — and its nav entry
  disappears with it.

### Section ids — the shell must use exactly these

| # | `id` | Nav group | Nav label | Icon | Renderer |
|---|---|---|---|---|---|
| 01 | `network` | The Map | The map you're playing on | `map-location-dot` | `map.js` |
| — | `glance` | The Map | At a glance | `hashtag` | `map.js` |
| 02 | `yourgame` | Your Game (split) | House rules `#recs` / What works, what fights you `#findings` | `list-check` / `circle-exclamation` | `verdict.js` |
| 03 | `transit` | Your Game | Getting around | `route` | `map.js` |
| 04 | `verdict` | The Answer | Verdict | `circle-check` | `verdict.js` |
| 05 | `questions` | The Deck | The questions | `circle-question` | `deck.js` |
| 06 | `curses` | The Deck | The curse deck | `wand-magic-sparkles` | `deck.js` |
| 07 | `trace` | The Receipts | Where the points came from | `chart-simple` | `verdict.js` |
| 08 | `sources` | The Receipts | Where these numbers come from | `book-open` | `deck.js` |

`glance` is the map's stat rail. It is **not** a numbered section: a NESTED
`data-section="glance"` host inside `#network` with its own `needs`/`redo`, no ordinal,
absent from `NUMBERED`; `#glance` is an in-section anchor like `#recs` and `#findings`.

Its markup is fixed in three places. The day marker on a day-sensitive tile is a
`<span class="tile-tag">` — icon plus word, never a `chip()` or a `wa-button`: it is a
label beside a 2xl number, and the helper-notes list above is about statuses, actions,
severities and sources, which this is not. A tile's note keeps **one clause** under the
value; a sub-figure goes in `kpi`'s `subHtml`; any remainder stays in `<wa-details
class="tile-more" appearance="plain" summary="More">`, so a group of tiles reads as numbers and not as prose. `s4Tiles`
returns the two as separate fields (`n` and `more`); the boundary is never inferred
from the prose, because a note interpolates stop names. The hover/pin hint is its
own `<p id="glance-hover-note">`, right after the glance legend row, which `app.js` removes when MapLibre does not load —
`buildMap`'s `sayBlocked` alone, re-run by every `injectRuntime()` pass, so a re-mount
at `rules` or at `score` brings the fresh sentence back and loses it again. `bindRail`
never removes it: `buildMap` is async, so "not ready yet" is the state of every
healthy run's first pass.

The **headway grid** (§06's `#hwmap` / `#hwmap2`) marks the selected day rather than
fading the rest. `app.js`'s `hwHighlight` puts class `is-day` on that column's `th` and
on each of its `td`s; styles.css draws a 2px accent rule down it — on the `th`, and on
each `td`'s `.cell`, which is the box that paints — bolds the header, and leaves
**no other column below opacity .7** — every number in the grid is true
whichever day is picked. The `data-dim` / `data-sel` attributes and the `.33` opacity
are gone.

**§07 and §08's tables.** `render/deck.js` renders a question's category as
`<span class="cat-tag">`, and every `<td>` an `s4Table` emits carries
`data-label="<column header>"`, which is what makes the narrow-screen row cards CSS-only
(`td::before{content:attr(data-label)}` under 720px) instead of a second copy of the
markup. Both deck tables open on a page size of **25**; `s4Pager` emits nothing at all
at 25 rows or fewer, and drops "50 at a time" at 50 or fewer. A print takes the window
off through `setDeckPageSize('all')` and puts the reader's own size back afterwards
(`app.js` `bindPrintDisclosures`), because paper carries the whole deck and a CSS
override would also reveal the rows the reader's filter excludes. §08's citation index
(`<ol id="cites">`) sits inside a `wa-details` summarised "All N citations", which
`openTargeted()` opens when a superscript points inside it.

**The report's sticky offset is `--sticky-top`**, declared on `:root` and on `wa-page` as
`calc(var(--header-height, 4rem) + var(--subheader-height, 3rem))` — the two heights
`wa-page` measures as inline styles on itself, with the fallbacks load-bearing because an
unresolvable `calc` leaves `top: auto`. A new sticky element uses that variable rather
than a fresh number.

**This order is page order**, stated in four places kept in lockstep: the `<section>`
order in `index.html`, `app.js`'s `NUMBERED` (the array `renumberSections` walks to hand
out ordinals), `app.js`'s `SECTIONS`, and the nav rail. `bindSpy` takes the **last** link
whose section is above the fold in document order, so a rail out of page order highlights
the wrong entry; every nav group is a **contiguous run** of this table.

The `§NN` labels in code comments are nicknames from the report's own numbering (§01 verdict …
§09 sources), **not** the printed ordinal. `render/strategy.js` and `render/simulator.js`
number the strategy view's own five sections.

Ordinals (`data-n`) are assigned **after** empty sections are dropped, so the printed
sequence never has a hole. The embedded `<script type="application/json">` blocks keep ids
with `-data` suffixes: `#data`, `#questions-data`, `#curses-data`, `#stops`,
`#provenance`. `#data` also carries `feed_key`, the feed's `sha256` (its `place` until the
feed lands): it keys the per-viewer state the page runtime stores, so a day chosen for one
city cannot override another city's best day.

**View state rides in `location.search`**, written with `history.replaceState` — never a
history entry, never a fragment. Four keys: `day` (the service day), `qs` (the question
status filter), `qsort` (`<column>:asc|desc`), `qq` (the question search). Each is read
**once**, when the part that owns it is first on the page and ahead of anything stored:
the day in `PAGE_RUNTIME_JS`'s `loadDay`, the other three in `app.js`'s
`restoreDeckUrlState` once `#qtable` exists. A key at its default value is dropped rather
than written. The write preserves `location.hash`, and the guide's own fragment writer
preserves this query string (§(g)): each carries the other half, or one of them silently
deletes the other's state. The landing ignores all four, and `resetToLanding()` still
reloads a query-less URL.

---

## (f) Error and degradation policy

The rule from `build_report`:

```
try   geo = await collectGeodata(...)
catch geo = emptyGeoData(border.bbox)
      log('warn', `OSM layer unavailable: ${err.message}`)
      degrade('The OpenStreetMap files could not be read, so every question, curse and score …', 'osm_unavailable')
```

**There is no `else`.** The geo phase is unconditional. An unavailable OSM layer costs 37
of the 80 questions, 16 of the 24 curses and the whole `E` and `A` axes (30 of 100
points): a third of the report is a failure to disclose, not a mode to offer. The ONLY way
to reach `geo.available === false` is the catch. A caller that must run without the
network points `worldBaseUrl` at a host that cannot resolve; `tools/smoke.mjs` does, which
keeps its 19 golden numbers offline.

Rules that follow from it, and that every module must obey:

1. **A failed map-file read is not fatal.** The run continues with
   `geo.available === false`, empty containers, and a degradation string with code
   `osm_unavailable`. The trigger is
   `collectGeodata` finding that *not one* world-file layer could be read. One unreadable
   layer degrades that category alone — throwing on the first failure would turn a single
   missing layer into a dead OSM section.
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

   **A third state exists and is neither of those.** The six density-grid categories —
   `building`, `street`, `car_street`, `footpath`, `bridge`, `tree` — are counted but never
   materialised as features. On every successful run `counts[key]` holds a real,
   map-wide-**exact** number while `pois[key]` is **permanently absent**, because no
   `Poi[]` is ever built for them; code that infers "not queried" from an absent `pois` key
   is wrong for these six. Their `zoneInventory` entries are present but **approximate** —
   a grid cell is attributed to whichever zone circle contains its centre — which is why
   they are also unconditionally `partial: true`. See `tools/osm-world/README.md`.
4. **The single service-day degradation.** Fewer than two day types ⇒
   `"single service-day type: no weekend variation in this feed"`. §06 still renders.
5. Every `degraded` message the worker posts is also appended to `Report.degradations`, so
   the final `done` payload is self-contained.
6. A fatal error (`{ type:'error', fatal:true }`) is only for the cases where there is no
   report at all: the source could not be fetched, the zip could not be opened, or the feed
   has no `stops.txt` / no `stop_times.txt`. Everything else degrades.
7. **The assumed-timetable drop** — rule 2's drop-and-renormalise keyed on
   `metrics.assumedSchedule` (§(b)). When any loaded source was synthesized from
   OpenStreetMap, every metric that is a pure function of the invented timetable — fitness
   rows C1, C3, D1, D2, D3, E1, E2 (`S3_ASSUMED_TIMETABLE_METRICS`, `rules/score.js`) and
   the zone S3 departure-gap row — gets `available: false`, zero points and a note; the
   denominator renormalises, **never imputes**. C2 and X3 survive on geometry and are
   relabelled `source: 'interp'`; the `Metric.source` enum stays closed. `auditCurses`
   takes ONE trailing optional `metrics = null` for this: under the flag `u_turn`, the one
   schedule-decided curse, becomes `action: 'player-choice'` with `count: null`, its
   route-share geometry still quoted; `check_timetable` stands down (it would quote dropped
   C1) and `end_timer` keeps firing with a disclosure. No question verdict reads the
   timetable. §09 prints a `Timetable` row (`render/deck.js`) only when the flag is true,
   and each assumption is a standing `osm_synth_*` INTERPRETATIONS row quoting the
   `SYNTH_*` constants.
8. **One vocabulary for degraded states.** Every degraded or limited state that reaches the
   page is named by a `DegradeCode` from `lib/core.js` `DEGRADE_KIND` and drawn by
   `render/html.js` `degradeChip`: the toast, §07 and §08 rows, §02's trace, §09's limits
   card, the guide's axes and dossier, and the landing picker. `osm_unavailable` (the layer
   failed) and `path_join_not_evaluated` (the join is never attempted) never share a word,
   an icon or a variant. A degradation chip is always visible; only its explanation folds.
   §09's "What this data does not know" prints every `Report.degradations` sentence in full
   and folds only `limit`-family note text.

---

## (g) The second view — `#strategy`

Nothing in the report view mentions, links to or hints at the guide; the guide may link
back.

| Contract | Detail |
|---|---|
| Entry | `location.hash.split('?')[0] === '#strategy'` **and** a finished report. The head of the fragment is what routes: the simulator keeps its own state in a `?…` suffix on the same fragment, so `applyRoute`, `leaveStrategy` and the wordmark (which points at the fragment the page is already on, suffix and all) all read it that way. Nothing else. No nav entry, no subheader entry, no button, no keyboard shortcut, no `<link rel>`, no comment in `index.html`. `index.html` gains **zero lines** for this feature. |
| Deep link, no report | `boot()` first looks for the restore handoff: `finish()` stores `{sources, options, source, place}` in the localStorage key **`jltg.lastRun`** (URL, catalogue and OSM refs only, never a `File`, the `jltg.rerun` rule), and a load whose hash is `#strategy` with no `jltg.rerun` waiting replays it through `startRun`, so `finish()` lands the reader in the guide. It is a restore, not a handoff: the key is validated by the same normalisers and is never consumed. With nothing stored, or a stored value that fails validation, `applyRoute()` falls through to the ordinary landing form — no error, no message, no hint. If a feed is then run with the fragment still set, `finish()` calls `applyRoute()` again and the reader lands in the guide. |
| Exit | The guide's hero link `href="#top"`, the browser Back button, or any other fragment. All go through the same `applyRoute`. |
| Visibility | `body[data-view='strategy']`, an attribute **orthogonal to `data-state`**. `data-state` keeps its meaning (the run lifecycle) and is never touched, so the report is *hidden by three rules in styles.css §7, not destroyed*: no section re-renders, no listener is dropped, `#netmap` keeps its MapLibre instance, and returning is free. A fourth `data-state` value would put the two axes into a fight over the same `!important` rules. |
| Sticky offsets | The report's `--sticky-top` clears the header **and** the `[slot='subheader']` strip (the header alone below 920px); the strip is `data-when="report"` and hidden here, so the guide's stack is the header alone at every width. `--s-sticky` is set once on the root under `html:has(body[data-view='strategy'])`, carries the `scroll-padding-top` and inherits into `#s-controls` and `#s-detail`. Do not restate the report's numbers in this view. |
| Reader state in the fragment | The simulator mirrors what the reader chose into a `?…` suffix on the same fragment, written with `history.replaceState` — which fires no `hashchange`, so `applyRoute` is never re-entered — and read **once** at `initStrategy`. Seven keys: `mode`, `sk` (the seekers, `lat,lon` at `coord()`'s 6 dp), `leg` (the thermometer's two ends, four coordinates), `z` (the selected zone), `sort` (`<columnId>:asc|desc`), `f` (the table filter) and `p` (the 1-based table page). Every value is validated against the run before it is applied; anything else is dropped, never repaired. The fragment carries **no run inputs** — see the row below. Each writer carries the other half of the URL: the fragment writer keeps `location.search`, and the report's query-string writer (§(e)) keeps `location.hash`. |
| Back to the list | `#s-back` sits in the dossier card's head, `hidden` except where the dossier is a section under the rail — decided by measuring the two columns' left edges, not by a breakpoint, because the `wa-grid` stacks on its own column width. Both it and `#s-print-dossiers` carry a `wa-*` layout class, so styles.css needs an explicit `[hidden] { display: none }` for each: an author `display` beats the UA rule. It is a real `<a href="#s-list">` for copy and middle-click, but its default is cancelled: setting the fragment would take `applyRoute` out of the guide, so the handler scrolls and moves focus to the rail itself. |
| Paper | The guide printed is a briefing, not a simulator. Every element the view is driven by carries `data-print="hide"` at the source (`render/strategy.js`), and `<div id="s-print-dossiers" hidden>` holds the top 15 dossiers, rendered statically at `initStrategy` and revealed by the print block's `[hidden]` override. Nothing else reveals it. §07 and §08's page window is the report's own paper concern (§(e)). |
| Landmark and focus | The guide root carries `role="main"`: the report's `<main>` is `display: none` while the guide is up and `wa-page` supplies no landmark; a hidden element is not in the accessibility tree, so there is no collision. `applyRoute` moves focus to the root (`tabindex="-1"`, `preventScroll`) and `leaveStrategy` mirrors it onto `#top`, because a view swap with a new `document.title` otherwise drops focus to `<body>`. Both scrolls are queued **two** frames out, after `PAGE_RUNTIME_JS`'s `openTargeted` on the same `hashchange`, which would otherwise re-scroll the root to `block: 'center'`. |
| Not a section | The root is not an entry in `SECTIONS`, so `hydrate`, `mountSection`, `dropSection`, `renumberSections` and `pruneNav` never see it. Its five sections pass the **literal** ordinals `'01'`…`'05'`, never `'--'` — `renumberSections` strips the attribute from every remaining `[data-n='--']` in the document. It carries no `data-state`, so `fatalError`'s `[data-state='skeleton']` sweep cannot take it either. |
| Mount point | Inside `<wa-page>`, as a sibling of `<main>`, in the default slot. **The root is a `<section>`**: `wa-page` pads only `main` and `section` in its default slot, and `wa-page > section` is in the one measure rule in `styles.css` (`:where(main, wa-page > section, …)`) that gives the `--content-width` cap, centring and gutter. A `<div>` root renders flush and full-bleed. Not `main`, because `body[data-view='strategy']` hides `wa-page > main`. |
| Kept out of `PAGE_RUNTIME_JS` | Nothing about this view is added to `PAGE_RUNTIME_JS` and the view ships no JSON block, so nothing is added to the blocks written by `writeDataBlocks` either. Its wiring lives in module code (`render/simulator.js`, `initStrategy`). |
| Data source | `state.report` in memory. The answer matrix (`answerSignature` / `survivalFractions`) is worker-local and is **not** needed: the guide recomputes answers client-side by haversine (`answerFor`). `report.geo.pois` crosses `postMessage` whole, as rich `{lon, lat, name, …}` POIs. |
| Re-runs and the URL | "Re-run with this border" (§05) hands the next document load its inputs through the sessionStorage key `jltg.rerun` (§(d)), **never through the URL** — nothing a reader could bookmark into a run they did not ask for. `resetToLanding()` remains a plain reload of a fragment-less, query-less URL; `boot()` has already removed the key, so Reset from run 2 is the ordinary landing and never a replay. |
| Id namespace | **Every id inside the view is prefixed `s-`**, the root `#strategy` excepted. Without the prefix, bare ids collide in a single document (`#sources` with §09, `#top` with the report hero, `#axis-*` with §04's accordion). The `s-` prefix is also what keeps `PAGE_RUNTIME_JS`'s `openTargeted` from opening a report disclosure on a guide fragment. |
| Controls | The three mutually-exclusive rows — `#s-modes`, `#s-radius`, `#s-category` — are `wa-radio-group`s of `appearance="button"` radios, the same pair `s4ChipGroup` (`render/deck.js`) builds for the report's filter rows, read through the group's `value` on `change`. `s4ChipGroup` cannot be reused because it cannot disable an option. A dead option is a `disabled` radio **and** a printed reason; options sharing one reason are named together beside that reason, printed once, since a disabled control is not focusable and its `title` is reachable only by hovering. Never express the selection by rewriting `appearance`. |
| Seeker placement | Pointer **and** keyboard. The map click and marker drag are pointer-only, so a "Place seekers at …" `wa-button` in `#s-opts` (thermometer: "Leg: … → selected zone", accessible name "Run the leg from … to the selected zone") and a focusable marker element that the arrow keys nudge cover the keyboard path. Without one of these every question mode is stuck on its "click the map" prompt for a keyboard user. |
| Module boundary | `app.js` → `renderStrategy(report) → string` (one root element, or `''`) and `initStrategy(root, report) → void`. `initStrategy` is called **only after** `body[data-view]` is set, because MapLibre reads its container size at construction. It is idempotent: a second call resizes the map and returns, so mode, selection, sort, filter and page survive re-entry. `simulator.js` imports `strategy.js`, never the reverse. The one shape that crosses is `modeChips`' `CatChip` (typedef in `render/strategy.js`), whose `reachMi` — the tentacle question's own reach in miles, `null` on matching and measuring chips — is what `answerFor` measures against. Never `size.tentacleReachMi`: a LARGE deck holds two reaches at once. |
| What `answerFor` answers | `rules/audit.js` is the specification. Measuring compares each side's own nearest feature (`osm_distance` / `survMeasuring`), not both sides against the seeker's. Tentacles have a third answer, "not within reach" (`survTentacle`'s class `-1`), plus a fourth when the seekers' own circle holds nothing to name (class `-2`). Tentacle reach is per question, not per game size. The majority group a readout reports is keyed on the winning **feature**, never on its name: two features sharing a name are two answers, and unnamed features are not one group. |

### Design decisions in this view

1. **Per-zone × per-day service is scope-reduced** to metrics `S1` / `S2` / `S3` plus
   frequent-stop counts on the scored day. Reasoning in §(d).
2. **The rail's six-segment axis micro-bar is dropped** in favour of one
   `wa-progress-bar` for the overall score. The breakdown is one click away in the
   dossier.
3. **The six `wa-tooltip for="th-{axis}"` header tooltips are replaced** by the 'Best
   on each axis' block above the table, whose six rows' `<code>` letters link to
   `#s-axis-{AXIS}`, one row per axis including unmeasured ones. `html.js` has
   no `waTooltip` and is not gaining one for this.
4. **All ids are namespaced `s-`**, as above.
5. **The guide's map follows the theme button.** One document has one theme control, so
   this map follows `buildMap`'s `matchMedia` + `MutationObserver` pattern.
6. **Playbook tip 9 reads `metrics.hubDominance`**, which `network_metrics` emits
   (`gtfs/network.js`).
7. **§02's table sorts the direction it claims to.** An earlier implementation's
   comparator sorted every column *ascending* while its comment, its `sortDir` reset and
   its `aria-sort="descending"` said descending. Here `wa-data-grid` derives the row order,
   `aria-sort` and the indicator arrow from the one `desc` boolean of `grid.sort`.
   Reasoning in `simulator.js`'s `tableData` comment. **File it.**
9. **§02's table is a `wa-data-grid`; its column contract is string ids.** The component
   addresses a column by id — `rank`, `name`, `score`, `axis-IR`, `axis-R`, `axis-S`,
   `axis-E`, `axis-A`, `axis-X`, `flags`, `travel` — and that id set is the contract
   between `render/strategy.js` and `render/simulator.js`, reported by `wa-sort-change`
   and taken by `grid.sort`. `TABLE_HEADERS`' order still matters, because
   `TABLE_LABELS` is derived from it positionally.
10. **A row is activated by Enter, not by Enter or Space.** `selectable` stays `none`
   (`single` would render a radio column the design does not have), and with selection off
   the component gives Space nothing to do; Enter reaches `activateCell`, which emits
   `wa-cell-click` whatever `selectable` says. One keyboard path to the dossier, not two.
11. **The table is one tab stop, not one per row.** The component uses a roving `tabindex`
   over its cells (the ARIA grid pattern); the old table put every row in the tab order.
12. **Focus after a re-sort holds its position, not its zone.** The component tracks the
   active cell by row **index** (`activateCell(rowIndex, columnId)`), so the same row
   *position* stays active and a re-sort changes which zone that is.

8. **The overall score is printed over 100, not over Σ `axisMax`.** `overallTenths` is
   already renormalised (`rules/score.js`, `1000 × earned ÷ max`); `ZoneView.max` is fixed
   at 100 here, so a run whose map files could not be read (leaving the E and A axes'
   `axisMax === 0`) never shows an over-full bar.

`render/simulator.js`'s local `cmp` is **not** a stale `cmpStr` copy: it is the body of
`cmpNum` and of every column `comparator` in the zone table, and every one of those keys
is a **number** except Name. Same body, different contract — do not fold it into
`lib/core.js`'s `cmpStr`.

Four other divergences are repaired in `styles.css`: §6's `.dark-map` selector is keyed on
the class alone (set by the map builders and nothing else; the shared sheet must not name
a map the report does not have); the sticky control-bar rule covers `#s-controls`;
`[data-band='fair']` gets `--warn`; and four of `SHARED_CSS`'s custom
properties are **deliberately unused here** — `--warn-text`, `--serif`, `--serious`,
`--serious-text` — because nothing reads them. This view's JS reads tokens by literal name
only; the sole concatenated name, `render/html.js`'s
`var(--wa-color-${variants[i]}-fill-loud)`, stays inside `--wa-color-*`. `styles.css`
notes this under its `legacy aliases` header.

### The stylesheet is partitioned

`styles.css` carries the guide's rules in a span delimited by the `/* == STRATEGY CSS` and
`/* == END STRATEGY CSS` markers. Nothing parses the markers, but the partition holds: new
guide CSS goes inside them, and nothing the report needs goes there.
