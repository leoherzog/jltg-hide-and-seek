# AGENTS.md

Guidance for Claude Code, Codex, Gemini, etc. working in this repository.

## What this is

A no-build ES-module single-page app that reads **one or more GTFS feeds** and rates that transit
system as a map for Jet Lag: The Game's *Hide and Seek* home game. The whole pipeline — feed parse,
RAPTOR travel-time model, map-feature lookups, rules audit, two scoring models — runs client-side in
a module Web Worker; the feed never leaves the browser. One document, two views: the public report,
and `#strategy`, the hider's guide, reached only by fragment.

Feeds arrive two ways. The landing page **is** a world map of the tracked catalogue
(`data/feeds.json`), full-bleed, with every control floating on it in one panel: a reader searches,
clicks a marker or draws a shape to take every system inside it. The drop-a-zip / paste-a-URL flow
sits in a disclosure, and the two **add** rather than replace. Several picks are merged into one
`Feed` inside the worker, so everything downstream of `gtfs/merge.js` sees exactly one feed.

Everything is inferred from the feed. There is no per-city configuration.

**Provenance comments:** this codebase is a port of a deleted Python CLI (`generate.py`). Comments
saying "Ported from generate.py's `<symbol>`" record where an algorithm came from; do not "fix"
them and do not go looking for the file. `CONTRACT.md`'s occasional "mirrors the Python" phrasing
is the same: the browser code is the only implementation and the authority on its own behaviour.
The design specs the code cites (`specs/*.md`, `scoring.md`) are kept outside the tree.

## Running

No build step, no bundler, no npm runtime dependency. Serve the root and open it:

```bash
python3 -m http.server 8000            # then http://localhost:8000/
node tools/smoke.mjs                   # headless: 19 golden numbers + the merge assertions
node tools/smoke.mjs --json --quiet    # same, machine-readable
node tools/smoke.mjs --merge-pipeline  # also run a merged feed end to end (off by default)
node tools/smoke.mjs --no-merge        # goldens only
node tools/mdb-snapshot.mjs --check    # validate data/feeds.json, no network
node tools/mdb-snapshot.mjs            # refresh it from the Mobility Database CSV
node tools/mdb-snapshot.mjs --counts   # ...and re-measure every feed's size over the mirror
```

`smoke.mjs` imports `runPipeline` from `worker.js` directly — no browser, no Worker global — and
runs it against the reference feed (The Rapid, Grand Rapids) with `worldBaseUrl` pointed at a host
that cannot resolve, asserting 19 golden numbers: feed metrics, hub, game size, hull area, T90, and
the fitness and zone-score outputs. **Never adjust an assertion to make it pass**: a moved number
means an algorithm moved, which may be correct but must be deliberate. It also prints a `BORDER:`
line of shape assertions for the in-play set and the suggested border, including a second scenario
that re-runs with a `borderBbox` clipping the reference network's southern fifth. Those are
deliberately **not** in the `SUMMARY` count, so "19 golden numbers" stays the true figure.

The reference feed lives at `cache/gtfs/c25d617e4716161f.zip`, which is gitignored; a fresh clone
doesn't have it. `--feed <path>` points the harness at any local GTFS zip.

**The unreachable world bucket is load-bearing.** The OSM layer has no off switch (no `useOsm`
option; `worker.js`'s S2 phase is unconditional), so the only way a harness stays offline and
deterministic is `worldBaseUrl: 'https://world.invalid/world'`, which fails in DNS and takes
CONTRACT.md §(f)1's failure path to an empty `GeoData`. Do not "fix" the harness by pointing it at
the live bucket: every golden number below the feed metrics is measured with the E and A axes
dropped from the denominator, and a real map layer would change all of them at once.

After the goldens the harness runs its **merge assertions**: the reference feed merged with itself
(identical bytes, so every id collides), then merged with Rochester when that zip is cached too. A
missing cached feed prints `SKIP:` and does not fail. These are additivity, prefix, window and
determinism checks, never golden numbers: a merged map is not a stable reference and must never
grow one.

## Architecture

`CONTRACT.md` is authoritative for every shape crossing a module boundary — **read it before
touching anything here.** If code and contract disagree, one of them is a bug; say so rather than
silently diverging.

The split that matters is worker vs main. `lib/`, `gtfs/`, `osm/` and `rules/` run inside the Web
Worker and **must not touch the DOM**; `app.js` and `render/` are main-thread and may. `worker.js`
is the pipeline orchestrator and emits stages (`feed`, `days`, `network`, `geo`, `rules`, `score`,
`provenance`) that `app.js` hydrates into the page as they land. `runPipeline` takes its message
sink as an argument, which is what lets `tools/smoke.mjs` import it from Node.

The report's **eight** sections are rendered by `render/verdict.js`, `render/map.js` and
`render/deck.js`. The At a Glance tiles live inside the map section and hydrate through a
**nested** `data-section="glance"` host with its own `needs`/`redo`. That matters: §05's rendered
string must not change after the `network` stage, because a re-render swaps `#netmap` out and tears
down the MapLibre instance, while the tiles are corrected at `rules`, at `score` and on every day
click. Two hydration clocks, one section; see `CONTRACT.md` §(d) and §(e). The strategy view is
**fragment-only** — `render/strategy.js` (markup, pure `Report → string`) plus `render/simulator.js`
(every DOM mutation in that view). It appears in no nav or link. See `CONTRACT.md` §(g).

Renderers **format only — they never compute.** Every number reaching the UI goes through exactly
one formatter from `lib/core.js`.

## The landing picker and multi-feed runs

The landing map is main-side and splits the same way the strategy view does: `render/landing.js` is
pure `data → string`, `render/picker.js` owns every DOM mutation, the lazy MapLibre import and the
draw tool, and `lib/catalog.js` is the DOM-free reader (search, bbox intersection, feed URLs) that
imports from Node and is testable as data.

**The layout is a stage and a panel.** `#picker` is a one-cell grid the height of the viewport
under the header; `#catalog-map` fills it and `.landing-panel` floats on it — a column on the left
on a desktop, a bottom sheet under 48rem. Consequences:

- `#catalog-map` is **static markup in `index.html`**, a sibling of the panel, because `app.js`
  replaces `[data-role=pickerbody]` wholesale and the map must survive that. Every other picker id
  is built by `renderPickerCard`, and `initPicker`'s root is `#picker`, so `root.querySelector`
  reaches both.
- `#picker` never carries `hidden`. The ONE signal for "there is no map" is `#catalog-map[hidden]`,
  set by `initLanding`'s catch when the catalogue never arrives and by `giveUpOnMap` when MapLibre
  does not load; styles.css §7 collapses the stage back to a centred card on either.
- `cooperativeGestures` is **off**: there is no scrolling column for the map to fight.
- **Search is wired synchronously, before the map**: it works with MapLibre blocked, and a failed
  catalogue fetch degrades to the bring-your-own card rather than an empty grey box.
- The polygon tool is **hand-rolled on the map's own events on purpose**: `CONTRACT.md` §0 pins an
  exhaustive five-item external-asset allowlist, and a draw library would need an amendment.
- The picker's map must be `destroy()`ed before the run starts, and must never be folded into
  `PAGE_RUNTIME_JS`'s `String.raw` template (§05's map lives there; a backtick would end it).

The **game-border frame** — the gold rectangle with eight handles that appears when a feed is
picked — is hand-rolled on MapLibre's events for the same reason as the draw tool, and is owned by
the picker: `handlers.onBorder({bbox, mode}|null)` reports it outward and there is no setter back
in. An untouched, auto-fitted frame sends `borderBbox: null`, so a reader who never touches it gets
the plain inferred run. The four `#border-s/w/n/e` fields ARE the keyboard path; the handles are
deliberately not focusable. `#opt-border-bbox` under Advanced is a `readonly` mirror WHILE a frame
exists, and `readOptions` reads the frame's `mode`, never the mirror's text. With no frame at all (a
dropped zip or pasted URL, which the picker has no bounding box for) the field is writable and
`readOptions` parses it, because that is the only way a bring-your-own feed can be given a border.
On the map the eight handles resize and the rectangle's OUTLINE moves the whole box; the FILL is
left to the map, or a frame fitted to the picks would swallow every attempt to pan.

**`jltg.rerun` in `sessionStorage` is the only cross-load handoff in the repo**, consumed exactly
once in `boot()`, which removes the key *before* it validates so a bad value cannot replay. It
exists because "Re-run with this border" is a new document load (`resetToLanding` explains why the
shell cannot be put back), and it carries URL and OSM sources only, never a `File`. Nothing else
may ride it: it is not a request/response channel and not a way to push a selection into the picker.

`servedStopIds` is **cmpStr-sorted at build** (`gtfs/service.js`), and `s1DayMetrics`' T90 origin
sample is a fixed stride over it. Any stop subset must be produced by **filtering** that array —
never by re-sorting, never by round-tripping through a `Set` — or the stride lands on different
stops and a golden moves. `gtfs/infer.js` `inPlayStopIds` is the one place that builds such a
subset; with no override it threads `null` so the no-override path is literally the old one.

The **example-map chips** in the panel are `lib/catalog.js`'s `EXAMPLE_MAPS`: hand-curated lists of
catalogue ids, public operators only — no campus loops, tourist cruises or private coaches. A chip
replaces the catalogue picks through the picker's own `commit()` funnel, so it is not a way in for
a selection setter. `tools/mdb-snapshot.mjs --check` fails when a chip names a row the snapshot no
longer has, and `exampleMapsFor` hides a chip at runtime rather than offer a city with a feed
missing.

`data/feeds.json` is a **build artifact reviewed as a diff**, the same discipline as
`tools/osm-world/categories.json`. `tools/mdb-snapshot.mjs` regenerates it from the Mobility
Database's open CSV, prints what changed against the file on disk, and `--check` re-validates the
committed file offline. Nothing in it reads a clock: the `snapshot` date comes from the catalogue's
newest `extracted_on`, so a rerun is byte-identical given the same CSV and the same
`data/feeds.json` already on disk (a row whose upstream bbox has been withdrawn borrows its previous
box and carries `k`).

`--counts` is the ONE part of that tool which is not a function of the CSV, which is why it is
opt-in. The catalogue records where a feed is and never how big it is, so `--counts` measures the
feeds themselves: three HTTP Range requests each, reading the zip's central directory and then only
`stops.txt` and `routes.txt`. Feeds that cannot be measured (empty archives, zero-byte mirror
objects, HTML error pages) keep their previous numbers under `q` rather than failing the run. A
plain `node tools/mdb-snapshot.mjs` carries `t`/`u` forward untouched, so a hand refresh never needs
the network beyond the CSV. `.github/workflows/feed-catalogue.yml` runs it monthly with `--counts`
and opens a PR; it never pushes to `main`, because the diff is the review. The catalogue rots
silently, so refreshing it is a checklist item.

Three things about the merge that are load-bearing and non-obvious:

- **`mergeFeeds([f]) === f`** — reference equality, no copy. That single-feed identity rule keeps
  the 19 golden numbers safe by construction: on a one-source run `gtfs/merge.js` does nothing.
  `tools/smoke.mjs` asserts it with a literal `===`. Do not tidy the fast path away.
- **Mixed time zones warn and never refuse.** `Feed.timezone` is display-only (`CONTRACT.md` §(b))
  and every time in the pipeline is feed-local seconds since midnight, so a mixed-zone merge is
  wrong about exactly one thing — the clock alignment of a ride between the two systems — which the
  report says. Throwing would conflict with the contract.
- **The fare house rule quotes ONE operator, and says which.** `fare_attributes` carries the primary
  feed's rows (the feed with the most trips), or, when the primary ships no fares, the first feed in
  merge order that has them. Concatenating would misattribute a fare; taking an empty primary table
  would silently delete a recommendation. `Feed.fareAgency` names whose fare it is.

Ids are namespaced `f0:` / `f1:` **always, not on collision**: an id whose spelling depends on
which other feed you picked is a trap for the exclude-stop and start-stop overrides. The service
window is the intersection of the feeds' windows, degrading loudly when it is empty or under a
week. Merge order is content-addressed (`sha256`, then source, then input index), so the merged
feed is a pure function of the feed bytes. `gtfs/merge.js`'s header is the full statement.

## The OSM layer

**Every run reads it.** There is no `--no-osm`, no `useOsm` option and no "Skip OpenStreetMap"
switch: the S2 phase in `worker.js` is unconditional, and `geo.available === false` means the map
files could not be read, never that someone chose to skip them. An unavailable layer drops 37 of
the 80 questions, 16 of the 24 curses and the whole of the `E` and `A` axes (30 of the 100 points,
removed from the denominator rather than scored zero), which is too much of the report to offer as
a preference. A harness that must run offline points `worldBaseUrl` at an unresolvable host; see
`tools/smoke.mjs`.

OpenStreetMap features come from prebuilt **FlatGeobuf** files in Cloudflare R2
(`https://map.jltg.herzog.tech/world`, 39 layers), read with HTTP Range requests against the packed
Hilbert R-tree in each file's header. There is **no Overpass call and no Nominatim call at
runtime**. The measured budget on the reference border is ~18 s, ~303 range requests, ~14.7 MB
against the live world. Never adjust that figure by arithmetic; re-measure it.

The requests run **concurrently**, in two places that must be read together: `osm/geodata.js`
fetches its categories in parallel lanes, and every range request in the module (those, the R-tree
walks under them, and the feature runs under those) funnels through one module-global FIFO gate in
`osm/flatgeobuf.js`. The gate bounds what reaches the browser's connection pool no matter how much
concurrency is stacked above it, so tuning a lane count can never turn into a socket storm.
`tools/osm-world/test-reader.mjs` holds the gate to that, including that a permit is returned on
the error paths.

Three modules, strictly layered:

- `osm/flatgeobuf.js` — pure transport. A hand-written FlatGeobuf reader (the npm package cannot
  load in a no-build module worker; import maps are document-scoped). Knows byte layout, knows
  nothing about parks.
- `osm/worldfile.js` — the semantic layer. Turns features into the `Poi` records the pipeline
  consumes; owns `DEFAULT_WORLD_BASE_URL`, the manifest, counts, the density grid, and admin
  containment.
- `osm/geodata.js` — the app layer (S2). The category catalogue, per-zone inventories,
  representative points, curse predicates, degradation handling.

Things in there that look wrong but aren't:

- **`GEO_CATEGORIES` selectors are Overpass QL on purpose.** They are the DEFINITION of each
  category, printed verbatim in provenance so a player can re-run one at overpass-turbo.eu, and
  `tools/osm-world/categories.json` is a mechanical translation of them. Do not delete them as
  dead code.
- **Six categories have no feature layer by design** — `bridge`, `building`, `car_street`,
  `footpath`, `street`, `tree` (`GEO_DENSITY_GRID_CATEGORIES`) are integer columns on a 0.002°
  (~220 m) density grid. That list and the density layers in `categories.json` must agree: a key
  here the build doesn't produce silently becomes a zero.
- **Administrative divisions come from Overture, not OSM** (`admin_source: overture` in the
  manifest). Map features are © OpenStreetMap contributors, ODbL; admin divisions are Overture.
  Both credits are rendered on the page — keep them.
- **Degradation is a first-class path, not an error path**, with two distinct states that must
  never be conflated: the whole layer failing (empty geodata, scores dropped from the denominator,
  banner on the page) versus the "within 10 ft of a routable path" join, which is not evaluated at
  all — `pathIds` is unconditionally null, so every candidate spot comes back `verify: true` at
  half weight while `available` stays `true`. `osm/geodata.js`'s header is the full statement.

`tools/osm-world/` is the build that produces the files — `build.py` (planet → per-category
FlatGeobuf → R2), `merge.py`, `cover.py`, `build-admin.sh`, with `categories.json` as the build
table. `.github/workflows/world-*.yml` run it in CI. `tools/osm-world/README.md` is the reference
for format choice, costs, sharding and CI.

The world files also carry the **OSM fallback tier**: a city with no published GTFS feed can be
played from a drawn shape. `transit_route` is a global out-of-band layer (assembled route
relations, built by `build-transit.py` and handed to `merge.py --transit` the way the admin layer
is; it is deliberately NOT a `categories.json` entry and `collectGeodata` never fetches it).
`osm/worldfile.js`'s `worldTransitRoutes` reads it only when a run names a `kind:'osm'` source, and
`osm/synth.js` turns the relations into a byte-deterministic GTFS zip that the untouched `loadFeed`
reads, so the merge rules, golden numbers and content-addressed `sha256` all hold by construction.
The honesty boundary is one run-level flag, `metrics.assumedSchedule`: geometry is measured, the
timetable is assumed, and every score that is a pure function of the assumed timetable is dropped
and renormalised, never imputed. `CONTRACT.md` §(b) OSM layer, §(d) `SourceRef` and §(f) rule 7 are
the full statement; `rail_line` (track, an ordinary category for the questions) and `transit_route`
(routes, for the synthesizer) are different layers on purpose.

## Scoring

**City fitness** — 100 points across six sub-scores: zone supply 20, question health 25, mobility &
tempo 20, round viability 15, schedule resilience 10, structural fairness 10. **Zone score** — 100
points across six axes: information resistance (IR) 30, reachability (R) 15, redundancy & exit (S)
15, endgame spots (E) 15, amenities (A) 15, exposure (X) 10.

Every point traces to a named metric with its value, unit, threshold and basis
(`rulebook` / `feed` / `interp`), and every one of those rows is rendered on the page. Metrics that
cannot be measured are dropped and the denominator renormalised — never imputed. Interpretations
are labelled as interpretations rather than asserted as rules.

The IR axis: for each live question it computes what each zone would answer, then how many other
zones share that answer. A zone whose answer vector is shared with a crowd survives questioning; a
zone with a unique vector is named by one cheap question.

Question verdicts are `functional` / `weak` / `degenerate` / `dead` (plus `unknown` when the
evidence to judge is missing, which is excluded from scoring). `unaskable` is not emitted by
anything; code that mentions it is explaining its absence.

## Determinism

The same feed plus the same map files produce the same report. No randomness outside a fixed-seed
permutation inside the minimum-enclosing-circle, no unsorted iteration reaching output, no wall
clock — dates come from the feed's own calendar or the analysis-date override. The feed is cached
in IndexedDB under a content-addressed scheme (`<kind>/<sha256(key)[:16]>`, key = the
fully-substituted request); the map files are immutable and content-addressed, so the browser's
HTTP cache handles them.

The one sanctioned wall clock in the repo is `tools/smoke.mjs`'s stage timing, which measures the
harness and never reaches a pipeline value.

## Verification performed

The first two bullets run today; the rest are measurements made during development, carried
forward as a record of what was checked.

- `node tools/smoke.mjs`: 19/19 golden numbers on the reference feed (served stops, routes, trips,
  zones, hub, game size, hull area, T90, hub route share, fitness score/band, ranked zones,
  dossiers, findings, house rules, top zone and its tenths), plus the merge assertions and the 24
  `BORDER:` assertions. The cheapest way to prove a change did not move an algorithm.
- `node tools/mdb-snapshot.mjs --check`: every invariant of the committed feed catalogue — sorted
  unique ids (code-point; they are strings like `mdb-400` or `tld-5873`, not integers),
  four-finite-number boxes inside the sane ranges, the regional flag agreeing with the 250 km cut,
  no duplicate `(provider, box)` pair. Network-free, so CI can run it.
- `node tools/test-synth.mjs`: the OSM-to-GTFS converter, network-free — byte-identical
  determinism, acceptance by the untouched `loadFeed`, ring clipping, stop clustering, the
  frequency-expansion landmines, and the failure paths. Shape assertions only, never golden
  numbers: a synthesized feed is not a stable reference and must never grow one.
- The OSM layer's harnesses in `tools/osm-world/`: `test-reader.mjs` checks `osm/flatgeobuf.js`
  against a file GDAL wrote, `test-pipeline.mjs` runs `collectGeodata` end to end over real HTTP
  Range requests, `probe-admin.mjs` validates an admin layer through the app's own reader (Grand
  Rapids must not be in Canada), `test-update.py` covers `build.py`/`merge.py` internals,
  `make-fixture.py` / `make-test-world.py` write the fixtures the first two read, and
  `fgb-equal.sh` decides whether two FlatGeobufs are equivalent.
- Measured OSM budget on the reference border (live world, `rail_line` included): ~18 s, ~303
  range requests, ~14.7 MB, at a peak of ~20 requests in flight. Requests and bytes repeat exactly
  across runs; the seconds are the network's and vary about a fifth either way. Do not adjust by
  arithmetic.
- Parallel-range equivalence: the report payload hashes identically with and without concurrent
  range requests, on the same requests and bytes. One pre-existing wobble: the scoring stage's own
  progress labels differ run to run (the stream diverges at `question order:
  measuring.admin_2_border`), so a whole-stream digest is not a stable check.
- Escaping: a feed rebuilt with hostile stop names (`</script><script>alert(1)</script>`,
  `<img src=x onerror=...>`, quotes, ampersands, emoji) produces well-formed pages with every
  payload inert inside JSON blocks and no premature `</script>`.
- Headway model cross-checked against an independent computation from raw `stop_times`: the
  reported figure is the **midday (10:00–14:00) median over the route-direction's stops**. It
  legitimately differs from an all-day mean on peak-heavy routes.
- Generality: BART (pure rail, semi-radial → MEDIUM) and MBTA (polycentric → LARGE) both produce
  clean pages.

## Conventions

- The root `index.html` is the app shell, not generated output. Nothing writes HTML files; nothing
  should start to.
- Commit messages stay bare: no `Co-Authored-By`, no `Claude-Session` trailer.
- `GUIDE.md` / `HIDING.md` / `SEEKING.md` are the rulebook and the authority on game rules.
- `package.json` is a LOCAL copy of Web Awesome Pro for reading component source offline. NOTHING
  imports it: the page loads Web Awesome from the hosted kit pinned in `index.html`, and that kit is
  the version users get. Do not delete it as unused, and do not "align" the two versions without
  checking the kit.
- `data/feeds.json` is generated, tracked, and read as a diff. Edit `tools/mdb-snapshot.mjs` and
  regenerate; never hand-patch a row, and never make the page fetch the upstream CSV at load. A
  row's `t` (stations, or stops where the feed models no stations) and `u` (routes) are MEASURED
  from the feed, not read from the catalogue; `searchCatalog` ranks on `t`, so a row that loses
  them silently sorts to the bottom of its own city.
- Page prose is templated, not generated. The deleted CLI tried local LLMs for this and removed the
  feature after they invented facts a validator couldn't catch; do not reintroduce model-written
  prose.
