# AGENTS.md

Guidance for Claude Code, Codex, Gemini, etc. working in this repository.

## What this is

A no-build ES-module single-page app that reads **one or more GTFS feeds** and rates that transit
system as a map for Jet Lag: The Game's *Hide and Seek* home game. The whole pipeline — feed parse,
RAPTOR travel-time model, map-feature lookups, rules audit, two scoring models — runs client-side in
a module Web Worker; the feed never leaves the browser. One document, two views: the public report,
and `#strategy`, the hider's guide, reached only by fragment.

Feeds arrive two ways. The landing page is a world map of the tracked catalogue (`data/feeds.json`)
where a reader searches, clicks a marker or draws a shape to take every system inside it; the
original drop-a-zip / paste-a-URL flow is still there, demoted to a disclosure, and the two **add**
rather than replace. Several picks are merged into one `Feed` inside the worker, so everything
downstream of `gtfs/merge.js` still sees exactly one feed and cannot tell the difference.

Everything is inferred from the feed. There is no per-city configuration.

**History you will trip over otherwise:** this codebase is a port of a Python CLI
(`generate.py`, ~16k lines) that used to live in `generated/` and has been deleted. Many comments
still say "Ported from generate.py's `<symbol>`". That is deliberate historical
provenance — a record of where an algorithm came from — not a reference you can follow. Do not
"fix" those comments, and do not go looking for the file. The same applies to `CONTRACT.md`'s
occasional "mirrors the Python" phrasing: the browser code is the only implementation and the
authority on its own behaviour. The design specs the code cites (`specs/*.md`, `scoring.md`) have
never been tracked here either; they are kept outside the tree.

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
```

`smoke.mjs` imports `runPipeline` from `worker.js` directly — no browser, no Worker global — and
runs it against the reference feed (The Rapid, Grand Rapids) with the OSM layer off, asserting 19
measured golden numbers: feed metrics, hub, game size, hull area, T90, and the fitness and
zone-score outputs. **Never adjust an assertion to make it pass** — a change to one of those
numbers means an algorithm moved, which may be correct but must be deliberate.

The reference feed lives at `cache/gtfs/c25d617e4716161f.zip`, which is gitignored — a fresh clone
doesn't have it. `--feed <path>` points the harness at any local GTFS zip.

After the goldens the harness runs its **merge assertions**: the reference feed merged with itself
(identical bytes, so every single id collides — the strongest collision test available for two
seconds and no extra fixture), then the reference feed merged with Rochester when that zip is
cached too. A missing cached feed prints `SKIP:` and does not fail. These are additivity, prefix,
window and determinism checks, never golden numbers: a merged map is not a stable reference and must
never grow one.

## Architecture

`CONTRACT.md` is authoritative for every shape crossing a module boundary — **read it before
touching anything here.** If code and contract disagree, one of them is a bug; say so rather than
silently diverging.

The split that matters is worker vs main. `lib/`, `gtfs/`, `osm/` and `rules/` run inside the Web
Worker and **must not touch the DOM**; `app.js` and `render/` are main-thread and may. `worker.js`
is the pipeline orchestrator and emits stages (`feed`, `days`, `network`, `geo`, `rules`, `score`,
`provenance`) that `app.js` hydrates into the page as they land, so the report fills in
progressively rather than appearing at the end. `runPipeline` takes its message sink as an
argument, which is what lets `tools/smoke.mjs` import it from Node.

The report's **eight** sections are rendered by `render/verdict.js`, `render/map.js` and
`render/deck.js`. Eight, not nine, since 2026-08-23: the At a Glance tiles were folded
into the map section and now hydrate through a **nested** `data-section="glance"` host
inside it, with its own `needs`/`redo`. That is not a decoration — §05's rendered string
must not change after the `network` stage, because a re-render swaps `#netmap` out and
tears down the MapLibre instance, and the tiles are corrected at `rules`, at `score` and
on every day click. Two hydration clocks, one section. See `CONTRACT.md` §(d) and §(e). The strategy view is **fragment-only** — `render/strategy.js` (markup, pure
`Report → string`) plus `render/simulator.js` (every DOM mutation in that view). It is reached only
by `#strategy` and appears in no nav or link. See `CONTRACT.md` §(g).

Renderers **format only — they never compute.** Every number reaching the UI goes through exactly
one formatter from `lib/core.js`.

## The landing picker and multi-feed runs

The landing map is main-side and splits the same way the strategy view does: `render/landing.js` is
pure `data → string`, `render/picker.js` owns every DOM mutation, the lazy MapLibre import and the
draw tool, and `lib/catalog.js` is the DOM-free reader (search, bbox intersection, feed URLs) that
imports from Node and is testable as data. **Search is wired synchronously, before the map**: it
works with MapLibre blocked, and a failed catalogue fetch degrades to the bring-your-own card rather
than to an empty grey box. The polygon tool is **hand-rolled on the map's own events on purpose** —
`CONTRACT.md` §0 pins an exhaustive five-item external-asset allowlist, and a draw library would
need an amendment to it. The picker's map must be `destroy()`ed before the run starts, and it must
never be folded into `PAGE_RUNTIME_JS`'s `String.raw` template (§05's map lives there; a backtick
would end it).

`data/feeds.json` is a **build artifact reviewed as a diff**, not a live fetch — the same discipline
as `tools/osm-world/categories.json`. `tools/mdb-snapshot.mjs` regenerates it from the Mobility
Database's open CSV, prints a summary of what changed against the file already on disk, and
`--check` re-validates the committed file offline. Nothing in it reads a clock: the `snapshot` date
comes from the catalogue's own newest `extracted_on`, so a rerun against the same CSV is
byte-identical. Refreshing it is a checklist item, not a memory — the catalogue rots silently, and
most of its bounding boxes were extracted in 2022.

Three things about the merge that are load-bearing and non-obvious:

- **`mergeFeeds([f]) === f`** — reference equality, no copy, nothing touched. That single-feed
  identity rule is what keeps the 19 golden numbers safe *by construction* rather than by hope: on a
  one-source run `gtfs/merge.js` does nothing at all. `tools/smoke.mjs` asserts it with a literal
  `===`. Do not tidy the fast path away.
- **Mixed time zones warn and never refuse.** `Feed.timezone` is display-only (`CONTRACT.md` §(b))
  and every time in the pipeline is feed-local seconds since midnight, so a mixed-zone merge is
  wrong about exactly one thing — the clock alignment of a ride between the two systems — which the
  report already knows how to say. Throwing would put the merge in conflict with the contract.
- **The fare house rule quotes ONE operator, and says which.** `fare_attributes` carries the primary
  feed's rows (the feed with the most trips), or — when the primary ships no fares at all, which is
  the usual shape of a small city merged with a big neighbour — the first feed in merge order that
  has them. Concatenating would quote one operator's fare as if it were the merged system's, and
  taking the primary's empty table would silently delete a recommendation. `Feed.fareAgency` names
  whose fare it is on a merged run.

Ids are namespaced `f0:` / `f1:` **always, not on collision** — an id whose spelling depends on
which other feed you happened to pick is a trap for the exclude-stop and start-stop overrides. The
service window is the intersection of the feeds' windows, degrading loudly when it is empty or under
a week. Merge order is content-addressed (`sha256`, then source, then input index), so the merged
feed is a pure function of the feed bytes. `gtfs/merge.js`'s header is the full statement.

## The OSM layer

OpenStreetMap features come from prebuilt **FlatGeobuf** files in Cloudflare R2
(`https://map.jltg.herzog.tech/world`, 39 layers as of the `rail_line` + `transit_route` build —
the live bucket has 37 until the next full rebuild publishes, and until then every run marks
`rail_line` partial with a warning, which is the correct degradation, not a bug), read with HTTP
Range requests against the packed Hilbert R-tree in each file's header. There is **no Overpass call
and no Nominatim call at runtime** — the modules' headers record what replaced what, and the
measured budget on the reference border is ~33 s, ~290 range requests, ~14.6 MB. That measurement
**predates `rail_line`** and must be re-measured against a world that ships it — never adjusted by
arithmetic — before the number is quoted as current.

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
  `tools/osm-world/categories.json` is a mechanical translation of them that has to be checkable
  against something. Do not delete them as dead code.
- **Six categories have no feature layer by design** — `bridge`, `building`, `car_street`,
  `footpath`, `street`, `tree` (`GEO_DENSITY_GRID_CATEGORIES`) are integer columns on a 0.002°
  (~220 m) density grid. That list and the density layers in `categories.json` must agree: a key
  here the build doesn't produce silently becomes a zero.
- **Administrative divisions come from Overture, not OSM** (`admin_source: overture` in the
  manifest). Map features are © OpenStreetMap contributors, ODbL; admin divisions are Overture.
  Both credits are rendered on the page — keep them.
- **Degradation is a first-class path, not an error path**, and there are two distinct states that
  must never be conflated: the whole layer failing (empty geodata, scores dropped from the
  denominator, banner on the page) versus the "within 10 ft of a routable path" join, which is not
  evaluated at all — `pathIds` is unconditionally null, so every candidate spot comes back
  `verify: true` at half weight while `available` stays `true`. `osm/geodata.js`'s header is the
  full statement.

`tools/osm-world/` is the build that produces the files — `build.py` (planet → per-category
FlatGeobuf → R2), `merge.py`, `cover.py`, `build-admin.sh`, with `categories.json` as the build
table. `.github/workflows/world-*.yml` run it in CI. `tools/osm-world/README.md` is the reference
for all of it: format choice, costs, sharding, CI, and what the migration from Overpass lost.

The world files also carry the **OSM fallback tier**: a city with no published GTFS feed can be
played from a drawn shape. `transit_route` is a global out-of-band layer (assembled route
relations, built by `build-transit.py` and handed to `merge.py --transit` exactly the way the
admin layer is — it is deliberately NOT a `categories.json` entry and `collectGeodata` never
fetches it), `osm/worldfile.js`'s `worldTransitRoutes` reads it only when a run names a
`kind:'osm'` source, and `osm/synth.js` turns the relations into a real, byte-deterministic GTFS
zip that the untouched `loadFeed` reads — so the merge rules, golden numbers and content-addressed
`sha256` all hold by construction. The honesty boundary is one run-level flag,
`metrics.assumedSchedule`: geometry is measured, the timetable is assumed, and every score that is
a pure function of the assumed timetable is dropped and renormalised, never imputed.
`CONTRACT.md` §(b) OSM layer, §(d) `SourceRef` and §(f) rule 7 are the full statement; `rail_line`
(track, an ordinary category for the questions) and `transit_route` (routes, for the synthesizer)
are different layers on purpose.

## Scoring

**City fitness** — 100 points across six sub-scores: zone supply 20, question health 25, mobility &
tempo 20, round viability 15, schedule resilience 10, structural fairness 10. **Zone score** — 100
points across six axes: information resistance (IR) 30, reachability (R) 15, redundancy & exit (S)
15, endgame spots (E) 15, amenities (A) 15, exposure (X) 10.

Every point traces to a named metric with its value, unit, threshold and basis
(`rulebook` / `feed` / `interp`), and every one of those rows is rendered on the page. Metrics that
cannot be measured are dropped and the denominator renormalised — never imputed. Interpretations
are labelled as interpretations rather than asserted as rules.

The IR axis is the interesting one: for each live question it computes what each zone would answer,
then how many other zones share that answer. A zone whose answer vector is shared with a crowd
survives questioning; a zone with a unique vector is named by one cheap question.

Question verdicts are `functional` / `weak` / `degenerate` / `dead` (plus `unknown` when the
evidence to judge is missing, which is excluded from scoring). `unaskable` is **no longer emitted**
by anything — code that mentions it is explaining its absence.

## Determinism

The same feed plus the same map files produce the same report. No randomness outside a fixed-seed
permutation inside the minimum-enclosing-circle, no unsorted iteration reaching output, no wall
clock — dates come from the feed's own calendar or the analysis-date override. The feed is cached
in IndexedDB under the same content-addressed scheme the CLI used on disk
(`<kind>/<sha256(key)[:16]>`, key = the fully-substituted request); the map files are immutable and
content-addressed, so the browser's HTTP cache handles them and nothing here has to.

The one sanctioned wall clock in the repo is `tools/smoke.mjs`'s stage timing, which measures the
harness and never reaches a pipeline value.

## Verification performed

The harnesses in the first two bullets run today; the later bullets are measurements made during
development, carried forward as a record of what was checked.

- `node tools/smoke.mjs`: 19/19 golden numbers on the reference feed (served stops, routes, trips,
  zones, hub, game size, hull area, T90, hub route share, fitness score/band, ranked zones,
  dossiers, findings, house rules, top zone and its tenths), plus the merge assertions described
  above. The cheapest way to prove a change did not move an algorithm.
- `node tools/mdb-snapshot.mjs --check`: every invariant of the committed feed catalogue — sorted
  unique ids, four-finite-number boxes inside the sane ranges, the regional flag agreeing with the
  250 km cut, no duplicate `(provider, box)` pair. Network-free, so CI can run it.
- `node tools/test-synth.mjs`: the OSM-to-GTFS converter, network-free — byte-identical
  determinism, acceptance by the untouched `loadFeed`, ring clipping, stop clustering, the
  frequency-expansion landmines, and the failure paths. Shape assertions only, never golden
  numbers: a synthesized feed is not a stable reference and must never grow one.
- The OSM layer has its own harnesses in `tools/osm-world/`: `test-reader.mjs` checks
  `osm/flatgeobuf.js` against a file GDAL wrote, `test-pipeline.mjs` runs `collectGeodata` end to
  end over real HTTP Range requests, `probe-admin.mjs` validates an admin layer through the app's
  own reader (Grand Rapids must not be in Canada), `test-update.py` covers `build.py`/`merge.py`
  internals no other harness reaches, `make-fixture.py` / `make-test-world.py` write the fixtures
  the first two read, and `fgb-equal.sh` decides whether two FlatGeobufs are equivalent.
- Measured OSM budget on the reference border (2026-08-22): ~33 s, ~290 range requests, ~14.6 MB.
  Taken before `rail_line` existed — one more count and one more feature read per run once a world
  ships it. Re-measure; do not adjust by arithmetic.
- Escaping: a feed rebuilt with hostile stop names (`</script><script>alert(1)</script>`,
  `<img src=x onerror=...>`, quotes, ampersands, emoji) produces well-formed pages with every
  payload inert inside JSON blocks and no premature `</script>`.
- Headway model cross-checked against an independent computation from raw `stop_times`: the
  reported figure is the **midday (10:00–14:00) median over the route-direction's stops**. It
  legitimately differs from an all-day mean on peak-heavy routes (Wyoming: 60 midday vs 43
  all-day mean) — different definition, both correct.
- Generality: BART (pure rail, semi-radial → MEDIUM) and MBTA (7,770 stops, 401 routes,
  polycentric → LARGE) both produce clean pages; reference zone counts are Grand Rapids 319,
  Chicago 1,204, Rochester MN 137.

## Conventions

- The root `index.html` is the app shell, not generated output. Nothing writes HTML files any more;
  nothing should start to.
- Commit messages stay bare: no `Co-Authored-By`, no `Claude-Session` trailer.
- `GUIDE.md` / `HIDING.md` / `SEEKING.md` are the rulebook and the authority on game rules.
- `package.json` is a LOCAL copy of Web Awesome Pro for reading component source offline. NOTHING
  imports it: the page loads Web Awesome from the hosted kit pinned in `index.html`, and that kit —
  not this — is the version users get. Do not delete it as unused, and do not "align" the two
  versions without checking the kit.
- `data/feeds.json` is generated, tracked, and read as a diff. Edit `tools/mdb-snapshot.mjs` and
  regenerate; never hand-patch a row, and never make the page fetch the upstream CSV at load.
- Page prose is templated, not generated. The deleted CLI measured local LLMs for exactly this and
  removed the feature after it invented facts a validator couldn't catch — do not reintroduce
  model-written prose.
