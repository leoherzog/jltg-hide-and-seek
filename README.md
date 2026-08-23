# Hide + Seek Map Rater

Point it at a city's public transit feed. It tells you whether that city works as a map for
[Jet Lag: The Game's *Hide and Seek*](https://www.jetlagthegame.com/) home game, how good a map it
is, and — if you're the one hiding — where to go.

It runs entirely in your browser. Serve this directory with any static file server, open it, drop
in a feed, and the whole pipeline runs client-side. The feed is never uploaded anywhere.

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
question against what's actually on the map, then argue about it. This tool does that work from the
feed, the same way every time, for any city that publishes one — it has produced 319 scored zones
for Grand Rapids, 1,204 for Chicago, 137 for Rochester, Minnesota, from nothing but each city's
feed and the same map files.

---

## Quick start

Nothing to install and no build step. Serve the repo root with any static file server and open it:

```bash
python3 -m http.server 8000     # then open http://localhost:8000/
```

Paste a feed URL or drop a `.zip` on the page. Everything — the feed parse, the travel-time model,
the map-feature lookups, the scoring — runs in your browser.

Find a feed for your city on [Mobility Database](https://mobilitydatabase.org/) or
[transit.land](https://www.transit.land/). Most agencies publish one. One wrinkle the page itself
will warn you about: fetching a URL only works if the agency's server sends CORS headers, and
plenty don't. When that happens, download the zip yourself and drop it in — same answer, one extra
step.

**How long it takes.** The schedule side runs in seconds. The map-feature layer is the slow part:
on the Grand Rapids reference border it takes about 33 seconds, and the browser's HTTP cache makes
a second run much cheaper. There's a "Skip OpenStreetMap" switch under **Advanced** that drops the
map layer entirely — everything the feed alone can answer still runs, and every question, curse and
sub-score that needs map features is excluded from the denominator, not guessed at.

**Overrides.** The Advanced panel also holds an override for every inference — game size, zone
radius, hiding period, start stop, border shape and box, departure time, analysis date, excluded
stops and routes. Everything is inferred by default; the overrides exist for when you disagree, or
when your group has already agreed on a border. Two more switches manage the feed cache: one
re-downloads a feed the browser has already cached (worth flipping when the agency publishes a new
one), and one does the opposite — a cache miss becomes an error, so a run either reproduces exactly
what an earlier run saw or stops and says so.

---

## What comes out

One page, two views.

### The report — should we play here?

The public-facing view. It opens with a rating out of 100 and the band that rating falls in — from
"not recommended as a transit game" up through "excellent map" — and then shows its working across
nine sections. It fills in progressively as the pipeline runs, section by section, rather than
appearing all at once at the end.

| § | Section | What's in it |
|---|---|---|
| 01 | The verdict | The rating, the band, and the axes that voted on the game size |
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

### `#strategy` — where should I hide?

The hider's companion. It's a second view of the same page, reached only by adding `#strategy` to
the URL — it appears in no nav and no link, because the seekers will be looking at the report.
Every candidate zone scored and ranked, with:

- **A map with a question simulator.** Pick a question category, drop a seeker on the map, and
  watch the map partition into the zones that answer yes, the zones that answer no, and — the good
  bit — the zones on the **edge**, where the ¼-mile circle straddles the boundary so the honest
  answer depends on where inside your own zone you happen to be standing. All six categories work:
  radar, thermometer, matching, measuring, tentacles, plus plain exploring.
- **A dossier per zone**: designated station, travel time from the start, the six axis scores,
  **"what finds you"** (the questions that most narrow the search onto you, with the answer you'd
  be forced to give), candidate hiding spots with distances, amenities, service facts for the
  selected day, and a full evidence table of every metric it earned.
- **The complete table of every scored zone**, sortable by any axis. If you disagree with the
  weighting, re-sort by the axis you care about and get your own shortlist. Nothing is hidden
  behind a cutoff — zones that are unreachable inside the hiding period are held out of the
  ranking but still listed, with the reason and the travel time.
- **Tactics**, derived from the rulebook and parameterised to this map, each citing its rule.

Six categories are named above because that's what the *simulator* offers. The question catalogue's
own six are slightly different — photo challenges take the place of exploring, since there's nothing
for a map to partition.

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
hospitals, consulates, parks, mountains, coastlines. Those come from OpenStreetMap — but not by
querying a live OSM service. The app reads prebuilt **FlatGeobuf** files, one per feature category,
served from a public bucket. Each file carries a spatial index in its header, so the browser reads
the index with HTTP Range requests, learns which byte ranges hold the features inside the game
border, and fetches only those — a bbox query against a multi-gigabyte planet-scale layer costs
tens of kilobytes of index reads plus the features themselves. On the Grand Rapids reference border
the whole layer is about 290 range requests and 14.6 MB.

This buys three things a live query service can't offer: no rate limit and no shared-server
etiquette, an immutable snapshot so two people analysing the same city read identical data, and a
single origin that either answers or visibly doesn't. What it costs is freshness — every count is
as-of the planet snapshot the files were built from, and the page's provenance section says which.

Each category is *defined* by an Overpass QL selector — the query language of OSM's public query
service — and those selectors are printed verbatim in the provenance section, so a player who
doubts a count can re-run the exact query at [overpass-turbo.eu](https://overpass-turbo.eu) against
live OSM and check. The prebuilt files are a mechanical translation of those selectors; the
selector is the definition, the file is a cache of its answer.

Two special cases. Six categories that exist only to be counted — bridges, buildings, streets,
footpaths, trees — ship as a density grid (a per-cell tally at ~220 m resolution) rather than as
feature geometry, because nobody needs the outline of every building to know a zone is downtown.
And administrative divisions (which state are you in, which city) come from the **Overture Maps
Foundation** rather than OSM, whose admin polygons are the one layer where the alternative is
cleaner. Map features are © OpenStreetMap contributors, ODbL; admin divisions are from Overture —
the page credits both.

One subtlety worth naming: the rulebook says distances are measured **to the map icon**, not to the
nearest edge. So for a large park, the relevant point is the label in the middle, which can be a
mile from where you're standing inside it. The code derives that representative point properly
(area-weighted centroid, with an interior fallback) rather than using a bounding-box centre, because
that single choice changes the answer to a lot of questions.

### 3. Audit the rules against the city

Every question in the deck gets a verdict:

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

One document, hydrated progressively. The pipeline runs in a Web Worker and streams staged results;
each of the nine sections is swapped from skeleton to real markup the moment its data lands, so you
read the verdict while the map layer is still loading. [Web Awesome](https://webawesome.com/)
components for the interface, MapLibre + OpenFreeMap for the maps, no build step, no framework, no
bundler. Light and dark themes, and the selected game day follows you between the two views.

---

## Determinism

The same feed and the same map files produce the same report. No wall clock reaches the output —
every date on the page comes from the feed's own calendar or from the analysis-date override. There
is exactly one call into randomness — a fixed-seed permutation inside the minimum-enclosing-circle
computation, which is a fixed shuffle rather than entropy — and every dictionary and set is iterated
through a sort. The feed is cached in the browser (IndexedDB, keyed by a hash of the exact request),
and the map files are immutable and content-addressed, so a run is reproducible without being
offline.

This is the point of the project, not a nicety. If two people generate the report for the same city
they must get the same report, or it isn't evidence of anything.

---

## Repo layout

```
index.html           the page shell: landing form, Advanced panel, nine skeleton sections
app.js               main-thread controller: owns every element, listener, and the worker protocol
worker.js            the pipeline orchestrator, off the main thread
lib/ gtfs/ osm/ rules/   worker-side pipeline (no DOM)
render/              main-side renderers (Report → HTML strings)
styles.css           the one stylesheet
CONTRACT.md          authoritative for every shape crossing a module boundary
tools/smoke.mjs      headless harness: runs the real pipeline, asserts 19 golden numbers
tools/osm-world/     builds the prebuilt OpenStreetMap files the app reads
  build.py           planet.osm.pbf -> per-category FlatGeobuf -> R2 (uv script)
  categories.json    the build table: one entry per category, plus the density grid
  README.md          why FlatGeobuf, what a build costs, how sharding and CI work

README.md            this file
AGENTS.md            notes for AI coding agents: architecture, conventions, measurements
GUIDE.md             \
HIDING.md             >  the Hide+Seek rulebook — the authority on game rules
SEEKING.md           /
package.json         a LOCAL copy of Web Awesome Pro, for reading component source
                     offline. NOTHING imports it: the page loads Web Awesome from the
                     hosted kit pinned in index.html, and that kit — not this — is the
                     version users get. Kept deliberately; do not delete it as unused.
```

The design specs the code occasionally cites (`specs/*.md`, `scoring.md`) have never been tracked
in this repo — they're kept outside the tree, so stop hunting for them.

---

## Caveats

- **Scheduled times are not real times.** Everything comes from the published timetable. Check live
  tracking on game day.
- **OpenStreetMap isn't Google Maps**, and the rulebook assumes players are using a maps app. The
  rulebook's own legitimacy test (5+ Google reviews) has no OSM equivalent; the report says so where
  it matters, but expect some category disagreements at the margins.
- **The map data is a snapshot, not live.** The prebuilt files reflect OSM as of the planet dump
  they were built from — the provenance section names the date. A park that opened last week isn't
  in them; the selectors printed next to each count let you check any number against live OSM.
- **The "within 10 ft of a routable path" test is not evaluated.** The rulebook qualifies a hiding
  spot by proximity to a routable path, and checking that needs a buffer around every walkable way
  on the map — data the prebuilt files don't carry, short of shipping the global footpath network.
  So the test simply isn't run: candidate hiding spots are still found and listed, but every one of
  them is marked verify-on-the-ground, always. Stand somewhere legal.
- **The map layer has only been exercised on a handful of cities**, of small and large size; the
  schedule side on a few more, including heavy-rail systems. Behaviour beyond those is unproven.
- **Some of this is interpretation**, and the rulebook is genuinely ambiguous in places. Those spots
  are labelled as interpretations on the page rather than presented as rules — but you and your
  group are still the final authority. It's your game.
