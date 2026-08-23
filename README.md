# Hide + Seek Map Rater

Point it at a city's public transit feed. It tells you whether that city works as a map for
[Jet Lag: The Game's *Hide and Seek*](https://www.jetlagthegame.com/) home game, how good a map it
is, and — if you're the one hiding — where to go.

There are two ways to run it, and they do the same analysis.

**In a browser, no install.** Serve this directory and open it. Drop in a feed and the whole
pipeline runs client-side — the feed is never uploaded anywhere.

**As a CLI**, which writes two self-contained HTML files:

```bash
uv run generated/generate.py <gtfs-url> --out build/
```

That's the whole interface.

---

## The problem this solves

*Hide and Seek* is played on a real transit system. One player rides to a hiding zone; the others
work together to find them by asking questions from six categories — "is your nearest museum the
same as mine?", "are you within 3 miles of me?", "name the nearest library within a mile of us."

Whether the game is any *fun* depends enormously on the city you play it in. A system with four bus
routes gives the seekers too little to search. A system where half the questions reference things
your city doesn't have — no zoo, no coastline, no consulate — quietly deletes a third of the
seekers' toolkit. A system where the last bus leaves at six strands the hider. None of this is
obvious until you've set up a game and started playing it badly.

Answering it by hand is a slog: read the rulebook, read the timetable, cross-reference every
question against what's actually on the map, then argue about it. This repo does that work from the
feed, the same way every time.

A few worked examples ship with the repo under `generated/`, one directory per city, each holding
the two pages the tool produced for that feed. It produces the same thing for anywhere.

---

## Quick start

### In a browser

Nothing to install and no build step. Serve the repo root with any static file server and open it:

```bash
python3 -m http.server 8000     # then open http://localhost:8000/
```

Paste a feed URL or drop a `.zip` on the page. Everything — the feed parse, the travel-time model,
the OpenStreetMap lookups, the scoring — runs in your browser.

### As a CLI

You need [`uv`](https://docs.astral.sh/uv/). No virtualenv, no install step — the script declares
its own dependency inline (just `httpx`).

```bash
# any GTFS feed URL, or a local .zip
uv run generated/generate.py <gtfs-url> --out build/

# much faster: skip the OpenStreetMap layer
uv run generated/generate.py <gtfs-url> --out build/ --no-osm
```

Find a feed for your city on [Mobility Database](https://mobilitydatabase.org/) or
[transit.land](https://www.transit.land/). Most agencies publish one.

> **Pass `--out`.** It defaults to the current directory. Run from the repo root without it and
> the two pages land on top of the browser port's own `index.html`; point it at one of the
> `generated/<city>/` directories and it overwrites that example.

**How long it takes.** ~10 seconds with a warm cache. First run on a new city is ~8 minutes, almost
all of it waiting on the free OpenStreetMap query servers. `--no-osm` runs in seconds but disables
everything that depends on knowing where the museums are. Big systems scale fine — a 7,700-stop feed
with 2.15 million scheduled stop times takes under three minutes.

**When OpenStreetMap doesn't answer.** The public Overpass mirrors are shared and frequently busy.
Each query falls back through three of them, and a run can still lose one: if the whole OSM layer is
unreachable the report is written with the OSM-backed scores excluded and a banner saying so, and if
only the optional "within 10 ft of a routable path" join fails, the pages come out complete but every
candidate hiding spot is marked verify-on-the-ground. Both outcomes are printed on the page rather
than papered over — see [Caveats](#caveats). Retrying later, when the mirrors are quieter, fills the
gap from cache in seconds.

---

## What comes out

### `index.html` — should we play here?

The public-facing report. It opens with a rating out of 100 and the band that rating falls in — from
"not recommended as a transit game" up through "excellent map" — and then shows its working across
nine sections. Three of the headings are written from the measurements themselves, so their wording
changes with the feed:

| § | Section | What's in it |
|---|---|---|
| 01 | The verdict | The rating, the band, and the four axes that voted on the game size |
| 02 | Where the points came from | The full score trace — every point tied to a named metric, its value and its threshold |
| 03 | What this means for your game | What the map does well, what fights you, and the house rules — including the ones your group has to agree in advance |
| 04 | The map at a glance | Zone count, area, stops, routes, service span |
| 05 | The map you're playing on | Live map of every stop with service, every zone, and the game border |
| 06 | Getting around | How long it takes to cross the map, and how often buses actually come |
| 07 | How many questions work here | **Every question in the deck**, one by one, with a verdict each |
| 08 | How many curses work as printed | Which curses to physically remove from the deck |
| 09 | Where these numbers come from | Every query, every source, every interpretation |

The rating breaks into six sub-scores:

```
A  Zone supply           / 20     how many distinct places there are to hide
B  Question health       / 25     how much of the deck actually functions
C  Mobility & tempo      / 20     crossing time against the hiding period, and frequency
D  Round viability       / 15     whether a full round fits inside the service day
E  Schedule resilience   / 10     how far the weekend falls off the weekday
F  Structural fairness   / 10     whether one hub carries the whole network
```

The deck size follows the game size, so the question total moves with the map: 58 questions on a
Small map, 71 on a Medium one, 80 on a Large one. Two different counts get reported and they mean
different things — how many questions are *fully* functional, and how many work at all, which adds
the weak ones that barely narrow anything.

It also rates each day separately, weekday against Saturday against Sunday. That's often the most
actionable thing on the page: a map can be a materially worse game on a Sunday, and you'd want to
know before scheduling.

### `strategy.html` — where should I hide?

The hider's companion. Every candidate zone scored and ranked, with:

- **A map with a question simulator.** Pick a question category, drop a seeker on the map, and
  watch the map partition into the zones that answer yes, the zones that answer no, and — the good
  bit — the zones on the **edge**, where the ¼-mile circle straddles the boundary so the honest
  answer depends on where inside your own zone you happen to be standing. All six categories work:
  radar, thermometer, matching, measuring, tentacles, plus plain exploring.
- **A dossier per zone**: designated station, travel time from the start, the six axis scores,
  **"what finds you"** (the three questions that most narrow the search onto you, with the answer
  you'd be forced to give), candidate legal hiding spots with distances, amenities, service facts
  for the selected day, and a full evidence table of every metric it earned.
- **The complete table of every scored zone**, sortable by any axis. If you disagree with the weighting,
  re-sort by the axis you care about and get your own shortlist. Nothing is hidden behind a cutoff —
  zones that are unreachable inside the hiding period are held out of the ranking but still listed,
  with the reason and the travel time.
- **Tactics**, derived from the rulebook and parameterised to this map, each citing its rule.

Six categories are named above because that's what the *simulator* offers. The question catalogue's
own six are slightly different — photo challenges take the place of exploring, since there's nothing
for a map to partition.

On a map with more than 2,000 zones the full field is too big to put in the page, so a `zones.json`
is written next to the two HTML files and nothing is silently dropped.

---

## How it works

Five stages. Everything downstream of the feed is deterministic.

### 1. Read the schedule

Parses GTFS — the standard format transit agencies publish. Works out which days have genuinely
different service, then for each one: when the first and last buses run, how long the gaps between
them really are, which routes run, and which days have no service at all.

Two details that matter more than they sound. **Headways are medians, not averages** — a route that
runs every 10 minutes at rush hour and once an hour at noon averages out to something that describes
neither. And the figure reported is the *midday* median, because that's when you'll be playing.
**Travel times are computed by RAPTOR**, a real transit routing algorithm, over the actual timetable
— so "35 minutes from the hub" means there is a genuine sequence of buses that gets you there in 35
minutes, including waiting for the transfer, not a straight-line distance guess.

From this it infers the game size (small/medium/large, using the rulebook's own definitions), the
hub station, and the map border.

### 2. Look up what's actually there

The rulebook's questions reference things GTFS knows nothing about — museums, zoos, golf courses,
hospitals, consulates, parks, mountains, coastlines. Those come from OpenStreetMap.

One subtlety worth naming: the rulebook says distances are measured **to the map icon**, not to the
nearest edge. So for a large park, the relevant point is the label in the middle, which can be a
mile from where you're standing inside it. The code derives that representative point properly
(area-weighted centroid, with an interior fallback) rather than using a bounding-box centre, because
that single choice changes the answer to a lot of questions.

### 3. Audit the rules against the city

Every question in the deck gets one of six verdicts:

- **functional** — works, and tells the seekers something
- **weak** — works, but barely narrows things down
- **degenerate** — there's exactly one on the map, so the answer is always the same and teaches
  nobody anything
- **dead** — there are none, so it always returns null (which still costs the seekers a question
  and still pays the hider a card)

The dead list is the useful part, and it's usually longer than the list of things the map is missing:
one absent feature can kill two questions, because the deck asks about several of them in both the
Matching and the Measuring category. Others die from the shape of the map rather than a missing
landmark — a map inside a single state and a single country can't answer either border question, and
a feed with no rail mode kills Train Platform.

Curses get the same treatment. The rulebook itself says things like *"if there are no bridges on the
game map, this curse should be removed"* — so that becomes a real query against real data, not a
judgement call. Curses that survive the geography check can still earn a warning: one that turns on
transferring to a second route does very little on a network where few stops carry one. A couple are
flagged as player preference rather than measurement, since no query settles them.

### 4. Score it

Two models, both worth 100 points, both fully traceable. Every single point traces to a named
metric with its value, its threshold, and whether it came from the rulebook, the feed, or an
interpretation — and all of that is printed on the page. If you think a threshold is wrong, you can
see exactly which one and exactly what it cost.

Metrics that can't be measured get **dropped and the denominator renormalised**, never guessed at.

Zones are scored on six axes: **information resistance**, **reach**, **service**, **endgame spots**,
**amenities**, **exposure**.

The first of those is the interesting one, and it's the thing this project does that a human with a
map really can't. For every live question, it computes what every zone on the map *would answer* —
then, for each zone, how many other zones give the same answers. A zone whose answer vector is
shared with a large crowd survives interrogation. A zone with a unique vector gets named by one
cheap question, no matter how nice it is otherwise. That's a genuinely counterintuitive property —
the comfortable, well-connected zone with the distinctive landmark next door is often a *worse* hide
than a boring one — and it falls straight out of the arithmetic.

Reach and exposure deliberately pull against each other: one rewards a zone you can get to quickly,
the other rewards a zone the seekers find expensive to reach. Zones that score well on both are
rare, and they're what you're shopping for.

### 5. Render

Two self-contained HTML files. [WebAwesome](https://webawesome.com/) components for all the
interface, minimal custom CSS, MapLibre + OpenFreeMap for the maps. No build step, no framework, no
bundler — the generator writes the markup directly. Light and dark themes, and the selected game day
follows you between the two pages.

---

## Determinism

The same feed and the same cached data produce **byte-identical** HTML. No unsorted iteration
reaching the output, no clock — every date on the page comes from the feed's own calendar or from
`--as-of`. There is exactly one call into `random` — a fixed-seed permutation inside the
minimum-enclosing-circle, which is a fixed shuffle rather than entropy. The CLI caches network
responses by a hash of the exact request, so once a city is cached the whole thing runs offline and
reproducibly. In the browser only the GTFS feed is cached that way; the map files are immutable and
content-addressed, so a run is reproducible without being offline.

This is the point of the project, not a nicety. If two people generate the report for the same city
they must get the same report, or it isn't evidence of anything.

---

## The AI part (it's small, deliberately)

There is an optional `--llm` flag that talks to a local model on LM Studio. It does **one thing**:
break ties between zones that scored *exactly* equal. That's the only job where a language model
can't be wrong, because every candidate in a tie is already known to be equally good.

Everything else — every number, score, ranking, verdict and sentence — is computed. That's not
caution for its own sake; it's what the measurements said. Two local models were tested against
hand-labelled ground truth, and a flavour-text feature was built and then deleted when it turned out
to invent things. The surviving write-up, including why the better model *still* didn't earn a
place, is in `AGENTS.md`. (`--llm`'s own `--help` text still advertises those deleted flavour
sentences; the code no longer has them.)

Without the flag, the pages are complete and never mention a model.

---

## Options

```
--out DIR              where to write (default: ., the repo root — always set this)
--cache DIR            HTTP cache directory (default: cache)
--no-osm               skip OpenStreetMap entirely; fast, but disables the OSM-backed questions
--as-of YYYYMMDD       analysis date (default: the feed's own start date)
--size {small,medium,large}      override the inferred game size
--zone-radius M        override the hiding-zone radius
--hiding-period MIN    override the hiding period
--start STOP_ID        override the inferred round-start station
--border {bbox,circle} border shape (default: bbox)
--border-bbox S,W,N,E  set the map border explicitly
--exclude-stop ID      drop a stop from the map (repeatable — for the safety conversation)
--exclude-route ID     drop a route (repeatable)
--departure HH:MM[:SS] round-start departure time (default 09:00:00)
--board-slack SEC      transfer slack in the travel-time model (default 0)
--offline              a cache miss becomes an error instead of a fetch
--refresh              ignore the cache and refetch
--llm                  allow the local model to break exact score ties
--llm-url URL          LM Studio base URL
--llm-model ID         model id
--selftest             assert the reference feed's known-good numbers
-v / -vv               logging
```

Everything is inferred by default. The overrides exist for when you disagree, or when your group has
already agreed on a border.

---

## Repo layout

```
index.html           the browser port: same analysis, self-serve, no install
app.js               main-thread controller
worker.js            the pipeline, off the main thread
lib/ gtfs/ osm/ rules/   worker-side pipeline (no DOM)
render/              main-side renderers
styles.css           the one stylesheet
CONTRACT.md          authoritative for every shape crossing a module boundary
tools/smoke.mjs      headless harness: asserts the CLI's golden numbers
tools/osm-world/     builds the global OpenStreetMap files the web app reads
  build.py           planet.osm.pbf -> per-category FlatGeobuf -> R2 (uv script)
  categories.json    the build table: one entry per category, plus the density grid
  README.md          why FlatGeobuf, what it costs, and what the migration lost
  test-reader.mjs    checks osm/flatgeobuf.js against a file GDAL wrote
  test-pipeline.mjs  runs collectGeodata end to end over real HTTP Range requests

generated/           the Python generator and its output
  generate.py        the whole thing (single file, ~16k lines, one dependency)
  <city>/            generated examples, one directory per city

README.md            this file
AGENTS.md            notes for AI coding agents: architecture, conventions, measurements
GUIDE.md             \
HIDING.md             >  the Hide+Seek rulebook — the authority on game rules
SEEKING.md           /
THERAPID*.md         prose rendering of the reference feed, handy for sanity checks
package.json         the WebAwesome Pro component dependency
build/               generated output (gitignored)
cache/               the CLI's cached HTTP responses (gitignored). The browser port
                     does not use it — it keeps the same content-addressed scheme in
                     IndexedDB, and only for the GTFS feed.
```

The browser port is the repo root and needs no build step — serve the directory and open it.
It runs the same pipeline as `generated/generate.py` entirely in the browser; the feed is
never uploaded anywhere.

`generate.py` is assembled from section sources — see `AGENTS.md` if you're editing it. Those
sources, and the specs the file's docstring cites, are kept outside this tree.

---

## Caveats

- **Scheduled times are not real times.** Everything comes from the published timetable. Check live
  tracking on game day.
- **OpenStreetMap isn't Google Maps**, and the rulebook assumes players are using a maps app. The
  rulebook's own legitimacy test (5+ Google reviews) has no OSM equivalent; the report says so where
  it matters, but expect some category disagreements at the margins.
- **The OSM layer has only been exercised on a handful of cities**, of small and large size; the
  schedule side on a few more, including heavy-rail systems. Behaviour beyond those is unproven —
  Overpass's for the CLI, and the prebuilt world files' for the web app.
- **The path-proximity test no longer runs in the web app.** The rulebook's "within 10 ft of a
  routable path" check needs a 5 m buffer around every walkable way on the map. The CLI still asks
  Overpass to do that server-side, where it is the most expensive query in the pipeline: on a large
  map it isn't attempted at all, because asking a shared mirror to buffer several hundred thousand
  ways is not a polite request, and on a small one a busy Overpass can still refuse it — three
  mirrors timing out on three consecutive runs is a real outcome, not a hypothetical. The web app
  reads prebuilt map files instead of querying Overpass, and there is no local equivalent of that
  join short of shipping the global footpath network, so it does not attempt the test at all.
  Either way candidate hiding spots are still listed, just marked verify-on-the-ground — in the web
  app, always.
- **Some of this is interpretation**, and the rulebook is genuinely ambiguous in places. Those spots
  are labelled as interpretations on the page rather than presented as rules — but you and your
  group are still the final authority. It's your game.
