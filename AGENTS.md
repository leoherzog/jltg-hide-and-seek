# AGENTS.md

Guidance for Claude Code, Codex, Gemini, etc. working in this repository.

## What this is

A no-build ES-module single-page app that reads **one GTFS feed** and rates that transit system as
a map for Jet Lag: The Game's *Hide and Seek* home game. The whole pipeline — feed parse, RAPTOR
travel-time model, map-feature lookups, rules audit, two scoring models — runs client-side in a
module Web Worker; the feed never leaves the browser. One document, two views: the public report,
and `#strategy`, the hider's guide, reached only by fragment.

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
python3 -m http.server 8000          # then http://localhost:8000/
node tools/smoke.mjs                 # headless: asserts 19 golden numbers
node tools/smoke.mjs --json --quiet  # same, machine-readable
```

`smoke.mjs` imports `runPipeline` from `worker.js` directly — no browser, no Worker global — and
runs it against the reference feed (The Rapid, Grand Rapids) with the OSM layer off, asserting 19
measured golden numbers: feed metrics, hub, game size, hull area, T90, and the fitness and
zone-score outputs. **Never adjust an assertion to make it pass** — a change to one of those
numbers means an algorithm moved, which may be correct but must be deliberate.

The reference feed lives at `cache/gtfs/c25d617e4716161f.zip`, which is gitignored — a fresh clone
doesn't have it. `--feed <path>` points the harness at any local GTFS zip.

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

The report's nine sections are rendered by `render/verdict.js`, `render/map.js` and
`render/deck.js`. The strategy view is **fragment-only** — `render/strategy.js` (markup, pure
`Report → string`) plus `render/simulator.js` (every DOM mutation in that view). It is reached only
by `#strategy` and appears in no nav or link. See `CONTRACT.md` §(g).

Renderers **format only — they never compute.** Every number reaching the UI goes through exactly
one formatter from `lib/core.js`.

## The OSM layer

OpenStreetMap features come from prebuilt **FlatGeobuf** files in Cloudflare R2
(`https://map.jltg.herzog.tech/world`, 37 layers), read with HTTP Range requests against the packed
Hilbert R-tree in each file's header. There is **no Overpass call and no Nominatim call at
runtime** — the modules' headers record what replaced what, and the measured budget on the
reference border is ~33 s, ~290 range requests, ~14.6 MB.

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
  dossiers, findings, house rules, top zone and its tenths). The cheapest way to prove a change did
  not move an algorithm.
- The OSM layer has its own harnesses in `tools/osm-world/`: `test-reader.mjs` checks
  `osm/flatgeobuf.js` against a file GDAL wrote, `test-pipeline.mjs` runs `collectGeodata` end to
  end over real HTTP Range requests, `probe-admin.mjs` validates an admin layer through the app's
  own reader (Grand Rapids must not be in Canada), `test-update.py` covers `build.py`/`merge.py`
  internals no other harness reaches, `make-fixture.py` / `make-test-world.py` write the fixtures
  the first two read, and `fgb-equal.sh` decides whether two FlatGeobufs are equivalent.
- Measured OSM budget on the reference border (2026-08-22): ~33 s, ~290 range requests, ~14.6 MB.
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
- Page prose is templated, not generated. The deleted CLI measured local LLMs for exactly this and
  removed the feature after it invented facts a validator couldn't catch — do not reintroduce
  model-written prose.
