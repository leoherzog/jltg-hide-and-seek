# AGENTS.md

Guidance for Claude Code, Codex, Gemini, etc. working in this repository.

## What this is

Two implementations of one analysis. The **repo root is the browser port** — a no-build ES-module
single-page app that runs the whole pipeline client-side; `CONTRACT.md` is authoritative for every
shape crossing a module boundary in it, and `tools/smoke.mjs` asserts it against the CLI's golden
numbers. **`generated/`** holds the original Python CLI and the example pages it produced.

`generated/generate.py` reads **one GTFS feed** and writes two self-contained HTML pages that rate
that transit system as a map for Jet Lag: The Game's *Hide and Seek* home game:

- **`index.html`** — the public feasibility report: the verdict and rating with its full score
  trace, key numbers, transit reality, the network map, a question-by-question audit of all six
  categories, the curse-deck audit, findings, and recommended setup.
- **`strategy.html`** — the hider's guide: how zones are scored, every candidate hiding zone
  ranked with a dossier, a question simulator on the map, the complete sortable candidate table,
  and rulebook-derived tactics parameterised to this map.

Everything is inferred from the feed. There is no per-city configuration.

## Running

### The browser port (repo root)

No build step, no bundler, no npm runtime dependency. Serve the root and open it:

```bash
python3 -m http.server 8000          # then http://localhost:8000/
node tools/smoke.mjs                 # headless: asserts the CLI's golden numbers, 19/19
node tools/smoke.mjs --json --quiet  # same, machine-readable
```

`smoke.mjs` runs the real `runPipeline` against the cached reference feed with the OSM layer off,
and asserts `selftest()`'s numbers. **Never adjust an assertion to make it pass** — a change to one
of those numbers means an algorithm moved, which may be correct but must be deliberate.

### The CLI (`generated/`)

Single file, PEP 723 inline metadata, one dependency (`httpx`). No venv setup:

```bash
uv run generated/generate.py https://connect.ridetherapid.org/InfoPoint/GTFS-Zip.ashx --out build/
uv run generated/generate.py feed.zip --out build/ --no-osm       # skip Overpass; much faster
uv run generated/generate.py <url> --out build/ --selftest        # assert the reference feed's golden numbers
```

`--out` defaults to `.`, which from the repo root would overwrite the browser port's own
`index.html`. Always pass `--out build/`.

Useful flags: `--size/--zone-radius/--hiding-period/--start/--border-bbox` override an inference,
`--as-of YYYYMMDD` picks the analysis date, `--offline` turns a cache miss into an error,
`--refresh` refetches, `-v`/`-vv` for logging. `--help` lists everything.

**Runtime** on the reference feed (The Rapid, 1,493 stops / 200k stop_times): ~10 s with a warm
cache, ~8 min cold, almost all of it Overpass. MBTA (7,770 stops / 2.15M stop_times) is 2m41s with
`--no-osm`.

## Architecture

### The browser port (repo root)

`CONTRACT.md` is authoritative for every shape crossing a module boundary — **read it before
touching anything here.** If it and `generated/generate.py` disagree, the Python wins and the
contract is a bug; say so rather than silently diverging.

The split that matters is worker vs main. `lib/`, `gtfs/`, `osm/` and `rules/` run inside the Web
Worker and **must not touch the DOM**; `app.js` and `render/` are main-thread and may. `worker.js`
is the pipeline orchestrator and emits stages (`feed`, `days`, `network`, `geo`, `rules`, `score`,
`provenance`) that `app.js` hydrates into the page as they land, so the report fills in
progressively rather than appearing at the end.

Same two pages as the CLI, but as one document: `render/verdict.js`, `render/map.js` and
`render/deck.js` are S4, and S5 is a **fragment-only second view** — `render/strategy.js` (markup,
pure `Report → string`) plus `render/simulator.js` (every DOM mutation in that view). It is reached
only by `#strategy` and appears in no nav or link. See
`CONTRACT.md` §(g), which also lists the deliberate divergences from the Python.

Renderers **format only — they never compute.** Every number reaching the UI goes through exactly
one formatter from `lib/core.js`.

### The CLI (`generated/generate.py`)

One file, six banded sections. `build_report()` runs the pipeline in dependency order and returns
a `Report`; both renderers consume that object and **format only — they never compute**.

- **S0 plumbing** — CLI, logging, content-addressed HTTP cache with mirror failover, one rounding
  policy (`rhu`/`num`/`mins`/`miles`), deterministic JSON, a pure-Python geometry toolkit
  (haversine, equirectangular projection, hull, Welzl, ray casting, grid index), and 30 HTML
  helpers that are the only sanctioned way to emit WebAwesome markup.
- **S1 gtfs** — feed parse, service calendar (handles `calendar.txt`, `calendar_dates.txt`-only,
  and empty `frequencies.txt`), per-day spans and headway distributions, network metrics, a
  schedule-respecting RAPTOR travel-time model, and inference of game size, hub and border.
- **S2 geo** — Overpass/Nominatim with disk caching, one bbox-wide query per category, a spatial
  index for per-zone inventories, representative-point derivation (the rulebook measures to the
  map *icon*), admin-division resolution, and the curse predicates.
- **S3 rules** — the rulebook catalogue as data, the question-viability engine
  (functional / weak / degenerate / dead), the answer-signature and
  survival computation that measures information resistance, the curse audit, and both scoring
  models with a full explainable trace.
- **S4 render_index**, **S5 render_strategy** — the two pages.

Section sources are spliced into the skeleton by an `assemble.py`; the assembled
`generated/generate.py` is the artifact. **Those sources and the specs behind the design are kept
outside this tree** — there is no `scratchpad/` in the checkout, so edit the assembled file
directly and treat the `scratchpad/…` paths cited in the file's own docstring as historical
references, not as things you can open.

## Scoring

**City fitness** — 100 points across six sub-scores (map size, question health, frequency, span,
week coverage, network shape). **Zone score** — 100 points across six axes: information
resistance (IR), reach (R), service (S), endgame spots (E), amenities (A), exposure (X).

Every point traces to a named metric with its value, unit, threshold and basis
(`rulebook` / `feed` / `interp`), and every one of those rows is rendered on the page. Metrics that
cannot be measured are dropped and the denominator renormalised — never imputed. Interpretations
are labelled as interpretations rather than asserted as rules.

The IR axis is the interesting one: for each live question it computes what each zone would answer,
then how many other zones share that answer. A zone whose answer vector is shared with a crowd
survives questioning; a zone with a unique vector is named by one cheap question.

## Determinism

The same feed plus the same cached HTTP responses produce **byte-identical** HTML. No `random`
outside a fixed-seed permutation inside the minimum-enclosing-circle, no unsorted iteration
reaching output, no wall clock — dates come from `feed_info.txt`/`calendar*.txt` or `--as-of`.
The CLI's cache keys are the fully-substituted request, so changing the border correctly
invalidates. The browser caches only the feed; the map files are immutable, so nothing there
needs invalidating.

Verified by running twice with **identical arguments** and `cmp`-ing. Note that `argv` is recorded
in the provenance block, so two runs that differ only in `--out` legitimately differ in output —
that is provenance working, not nondeterminism.

## The LLM's deliberately limited role

`--llm` lets a local model (LM Studio, default `google/gemma-4-12b-qat`) do **exactly one thing**:
break ties among zones the deterministic layer scored *exactly* equal. That is the only job it
cannot get factually wrong — every candidate in a tie is already known to be equally good, so no
ordering it produces becomes a claim on the page. Responses are cached by prompt hash, so reruns
stay byte-identical, and every failure is silent. Without `--llm` the pages are complete and never
mention a model.

This is narrow because it was measured. Full write-up: `scratchpad/MODEL_COMPARISON.md` and
`scratchpad/QWEN_VERDICT.md` — both outside this tree, like every other `scratchpad/` path here
(see the note above), so treat them as historical references rather than files to open. Two local models were probed against hand-labelled ground truth:

| Probe | qwen3.5-9b | gemma-4-12b-qat |
|---|---|---|
| Binary legality, 16 features × 5 samples | 62% majority-vote (50% baseline) | **94%** |
| Self-consistency across 5 samples | 7 of 16 items unstable | **0 of 16** |
| Score a zone from fixed facts | ±2 swings on identical input | ±1 at worst |
| Prose from a fact list | invented freely | ~0% invented atomic facts |

**Gemma is much better and is now the default.** It is genuinely good at bounded judgement against
a rubric.

**Page prose is still templated, not generated.** A flavour-sentence slot was built, tested against
three prompt designs on real zone data, and removed. With gemma the problem is no longer lying: it
is that once Python has chosen which fact matters, the model adds only variance — its output
reduces to what an f-string produces deterministically and for free. It also still mis-attributes
relations in a way no validator catches: given a zone ranked 4, it wrote "Coit Park, a park ranked
4", attributing the *zone's* rank to the park. The numeral is in the fact list, so the check passes.
If you are tempted to reintroduce it, read the comparison file first.

**Open opportunity:** S2 decides "is this OSM feature a legal endgame spot" with hand-written tag
heuristics, and that feeds the E axis of every zone score. Gemma scored 94% with zero variance on
exactly that call. Routing ambiguous cases through it — cached by prompt hash, so runs stay
byte-reproducible — would put a measurably better judge on the one question the data cannot settle.
Not implemented: it would make zone scores depend on a cached model verdict.

**Note:** the LM Studio host holds one mid-size model at a time; loading one evicts whatever else
is resident.

## Verification performed

- `--selftest` golden numbers for the reference feed (served stops, routes, trips, zones, hub,
  game size, hull area, T90, hub route share). The browser port reproduces all 19 of them through
  `node tools/smoke.mjs`, which is the cheapest way to prove a change to either implementation did
  not move an algorithm.
- Byte-identical output across repeated runs, on both the `--no-osm` and OSM paths.
- Headway model cross-checked against an independent computation from raw `stop_times`: the
  reported figure is the **midday (10:00–14:00) median over the route-direction's stops**, which
  reproduces exactly. It legitimately differs from `THERAPID-COMPACT.md` on peak-heavy routes
  (Wyoming: 60 midday vs 43 all-day mean) — different definition, both correct.
- Escaping: a feed rebuilt with hostile stop names (`</script><script>alert(1)</script>`,
  `<img src=x onerror=...>`, quotes, ampersands, emoji) produces well-formed pages with every
  payload inert inside JSON blocks and no premature `</script>`.
- Both pages executed in jsdom: zero runtime errors, all simulator modes, table sort/filter/paging,
  zone selection and day switching exercised.
- Generality: BART (pure rail, 105 stops, semi-radial → MEDIUM) and MBTA (7,770 stops, 401 routes,
  `calendar.txt`, polycentric → LARGE) both generate clean pages.

## Conventions

- **Never** overwrite the root `index.html` — that is the browser port's shell, not output.
  Always pass `--out build/`.
- Commit messages stay bare: no `Co-Authored-By`, no `Claude-Session` trailer.
- `THERAPID*.md` are a prose rendering of the reference feed, useful for sanity checks; they are
  **not** an input to the script, which reads GTFS directly.
- `GUIDE.md` / `HIDING.md` / `SEEKING.md` are the rulebook and the authority on game rules.
