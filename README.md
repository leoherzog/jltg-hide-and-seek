# Hide + Seek Map Rater

Point it at a city's public transit feed. It tells you whether that city works as a map for
[Jet Lag: The Game's *Hide and Seek*](https://www.jetlagthegame.com/) home game, how good a map it
is, and — if you're the one hiding — where to go.

It runs entirely in your browser. Serve this directory with any static file server, pick your city
off the map or bring your own feed, and the whole pipeline runs client-side. The feed goes from the
agency, or from your disk, straight into the tab. It is never uploaded anywhere.

---

## The problem this solves

*Hide and Seek* is played on a real transit system. One player rides to a hiding zone; the others
find them by asking questions from six categories — "is your nearest museum the same as mine?",
"are you within 3 miles of me?", "name the nearest library within a mile of us."

Whether the game is fun depends on the city. Four bus routes give the seekers too little to search.
A city with no zoo, no coastline and no consulate quietly deletes a third of the seekers' toolkit.
A last bus at six strands the hider. Working that out by hand means reading the rulebook, reading
the timetable and cross-referencing every question against the map. This tool does it from the
feed, the same way every time, for any city that publishes one.

---

## Quick start

Nothing to install and no build step. Serve the repo root with any static file server and open it:

```bash
python3 -m http.server 8000              # then open http://localhost:8000/
node tools/smoke.mjs                     # headless: the pipeline, against 19 golden numbers
node tools/mdb-snapshot.mjs --check      # validate the committed feed catalogue, no network
```

**Pick your city on the map.** The landing page is a world map of transit systems, one clustered
marker per feed, drawn from a tracked snapshot of the [Mobility Database](https://mobilitydatabase.org/)
catalogue. Every control sits in one panel floating on it — a column on the left on a desktop, a
bottom sheet on a phone. Search for a city or an operator, click a marker, or draw a shape and take
every system it touches. Two switches add regional and long-distance networks, and feeds nobody
publishes any more; both are off by default because they overlap almost any shape you draw. Press
Analyse. The download, the parse, the travel-time model, the map-feature lookups and the scoring all
happen in your browser.

**Or bring your own feed.** Under *Or bring your own feed*, drop a `.zip` or paste a URL. This is
the path when the catalogue never loaded, when the map library is blocked, or when your agency never
published to the Mobility Database. A map pick and a zip of your own add up rather than replacing
each other. Fetching a URL only works if the agency's server sends CORS headers, and plenty don't;
the page will warn you. When that happens, download the zip yourself and drop it in. The catalogue's
own mirror URLs, which is what a map pick fetches, always send them.

**Or start from an example.** A row of chips in the panel — Chicago, New York and a dozen other
metros — loads a hand-picked set of that city's public operators in one click. Campus shuttles and
private coaches are left out on purpose. The chip fills the selected list; add to it, remove from it
or press another.

**More than one system at a time.** A metro plus its commuter rail, or two neighbouring operators a
drawn shape crossed, merge into one map. Up to ten feeds per run; each one costs a download and a
parse, and the eleventh is refused rather than merged.

**Where the game is played.** As soon as you pick a feed, a gold rectangle appears on the map: the
game border, fitted to what you picked. Drag a corner, an edge or the middle, or type the four
numbers — South, West, North and East — into the panel; Shift+↑ and Shift+↓ in a field nudge that
edge. Buttons beside them fit the border back to the feeds, seed it from where two systems overlap,
box a shape you drew, or shrink and grow it 10 % at a time. **Leave it alone and nothing changes**:
an untouched border is inferred from what the start stop can actually reach. Touch it and the box
becomes the game — stops outside it stop counting, and so do the zones, the size vote, the crossing
time and the score.

**"Re-run with this border."** Some maps are two games in one: a metro plus its suburban operators
measures LARGE because the outer stops stretch the map across the whole region, though the game most
people mean to play is the core. So the report asks whether a tighter box — everything the start
stop can reach inside one hiding period — measures as a smaller, self-consistent game. When it does,
§01 says so with the stop and departure counts, draws the suggested box on the map beside the
current one, and offers a button. Pressing it re-runs everything inside that border; the feeds come
back out of the browser's cache, and a chip at the top of the page says which run you are looking
at and what the last one measured. The suggestion is only an offer, and it appears only when it
would change the answer, so re-running inside it is the end, not the start of a loop.

The map is optional: search, Add and Analyse all work before the map library loads, and if it never
loads.

**How long it takes.** The schedule side runs in seconds. The map-feature layer is the slow part,
around twenty seconds on a city-sized border, and the browser's HTTP cache makes a second run much
cheaper. There is no switch to turn it off: a run without map features loses nearly half the
questions, two thirds of the curses and two of the six score axes. If the map files genuinely cannot
be read the run still finishes and says so; everything the feed alone can answer is reported, and
everything that needed map features is excluded from the denominator rather than guessed at.

**Overrides.** The Advanced panel holds an override for every inference — game size, zone radius,
hiding period, start stop, border shape, departure time, analysis date, excluded stops and routes.
The border box shows there read-only; the map is where you edit it, so the two can never disagree.
Excluding stops or routes narrows the whole report: the excluded stops stop counting toward the
zones, the size and the score. Two switches manage the feed cache: one re-downloads a feed the
browser has already cached (for when the agency publishes a new one), and one makes a cache miss an
error, so a run either reproduces exactly what an earlier run saw or stops and says so.

---

## What comes out

One page, two views.

### The report — should we play here?

The public-facing view. It opens with a rating out of 100 and the band that rating falls in — from
"not recommended as a transit game" up through "excellent map" — and then shows its working across
eight sections, filling in section by section as the pipeline runs.

| § | Section | What's in it |
|---|---|---|
| 01 | The map you're playing on | Live map of every stop with service, every zone, and the game border — coloured by reach or by frequency, with the stat rail (zone count, area, stops, routes, service span) beside it |
| 02 | What this means for your game | What the map does well, what fights you, and the house rules — including the ones your group has to agree in advance |
| 03 | Getting around | How long it takes to cross the map, and how often buses actually come |
| 04 | The verdict | The rating, the band, and the axes that voted on the game size |
| 05 | How many questions work here | **Every question in the deck**, one by one, with a verdict each |
| 06 | How many curses work as printed | Which curses to physically remove from the deck |
| 07 | Where the points came from | The full score trace — every point tied to a named metric, its value and its threshold |
| 08 | Where these numbers come from | Every query, every source, every interpretation |

The rating breaks into six sub-scores:

```
A  Zone supply           / 20     how many distinct places there are to hide
B  Question health       / 25     how much of the deck actually functions
C  Mobility & tempo      / 20     crossing time against the hiding period, and frequency
D  Round viability       / 15     whether a full round fits inside the service day
E  Schedule resilience   / 10     how far the weekend falls off the weekday
F  Structural fairness   / 10     whether one hub carries the whole network
```

The deck size follows the game size: 58 questions on a Small map, 71 on a Medium one, 80 on a
Large one. Two counts get reported — how many questions are *fully* functional, and how many work
at all, which adds the weak ones that barely narrow anything.

It also rates each day separately, weekday against Saturday against Sunday. A map can be a
materially worse game on a Sunday, and you'd want to know before scheduling.

### `#strategy` — where should I hide?

The hider's companion: a second view of the same page, reached only by adding `#strategy` to the
URL. It appears in no nav and no link, because the seekers will be looking at the report. Every
candidate zone scored and ranked, with:

- **A map with a question simulator.** Pick a question category, drop a seeker on the map, and
  watch the map partition into the zones that answer yes, the zones that answer no, and the zones
  on the **edge**, where the ¼-mile circle straddles the boundary so the honest answer depends on
  where inside your zone you are standing. All six categories work: radar, thermometer, matching,
  measuring, tentacles, plus plain exploring.
- **A dossier per zone**: designated station, travel time from the start, the six axis scores,
  **"what finds you"** (the questions that most narrow the search onto you, with the answer you'd
  be forced to give), candidate hiding spots with distances, amenities, service facts for the
  selected day, and a full evidence table of every metric it earned.
- **The complete table of every scored zone**, sortable by any axis. Zones unreachable inside the
  hiding period are held out of the ranking but still listed, with the reason and the travel time.
- **Tactics**, derived from the rulebook and parameterised to this map, each citing its rule.

The simulator's six categories differ slightly from the question catalogue's own six: photo
challenges take the place of exploring, since there's nothing for a map to partition.

---

## How it works

Five stages. Everything downstream of the feed is deterministic.

### 1. Read the schedule

Parses GTFS — the standard format transit agencies publish. Works out which days have genuinely
different service, then for each one: when the first and last buses run, how long the gaps between
them really are, which routes run, and which days have no service at all.

**Headways are medians, not averages**, and the figure reported is the *midday* median, because
that's when you'll be playing. **Travel times are computed by RAPTOR**, a real transit routing
algorithm, over the actual timetable, so "35 minutes from the hub" means a genuine sequence of buses
including the transfer wait, not a straight-line guess.

From this it infers the game size (small/medium/large, using the rulebook's own definitions), the
hub station, and the map border.

**Several feeds become one.** When you pick more than one system, they are merged before anything
downstream sees them: every id grows an `f0:` / `f1:` prefix so two agencies that both number a
route `1` cannot collide, and each feed keeps its own calendar. The service window is the
**intersection** of the feeds' windows; if that is empty or shorter than a week, the report says so.
Mixed time zones are a warning, never a refusal: every time in the pipeline is feed-local, so the
only thing a mixed-zone merge gets wrong is the clock alignment of a ride *between* the two systems,
and the page says so. Transfers are built from stop proximity rather than `transfers.txt`, so two
agencies whose stops sit forty metres apart are already connected. The provenance section (§08)
lists every feed that went in, with its own hash, window and operator. The fare quoted in the house
rules is the **primary** operator's (the feed with the most trips), because there is no honest way
to add two fare tables together.

### 2. Look up what's actually there

The rulebook's questions reference things GTFS knows nothing about — museums, zoos, golf courses,
hospitals, consulates, parks, mountains, coastlines. Those come from OpenStreetMap, read from
prebuilt **FlatGeobuf** files, one per feature category, served from a public bucket. Each file
carries a spatial index in its header, so the browser reads the index with HTTP Range requests and
fetches only the features inside the game border. This gives no rate limit, an immutable snapshot
so two people analysing the same city read identical data, and a single origin that either answers
or visibly doesn't. What it costs is freshness: every count is as-of the planet snapshot the files
were built from, and the provenance section says which.

Each category is *defined* by an Overpass QL selector, printed verbatim in the provenance section,
so a player who doubts a count can re-run the exact query at
[overpass-turbo.eu](https://overpass-turbo.eu) against live OSM. The prebuilt files are a mechanical
translation of those selectors.

Two special cases. Categories that exist only to be counted — bridges, buildings, streets,
footpaths, trees — ship as a density grid (a per-cell tally at ~220 m resolution) rather than as
feature geometry. And administrative divisions come from the **Overture Maps Foundation** rather
than OSM. Map features are © OpenStreetMap contributors, ODbL; admin divisions are from Overture;
the page credits both.

The rulebook says distances are measured **to the map icon**, not to the nearest edge. For a large
park, the relevant point is the label in the middle, which can be a mile from where you're standing
inside it. The code derives that point properly (area-weighted centroid, with an interior fallback)
rather than using a bounding-box centre, because that choice changes the answer to a lot of
questions.

### 3. Audit the rules against the city

Every question in the deck gets a verdict:

- **functional** — works, and tells the seekers something
- **weak** — works, but barely narrows things down
- **degenerate** — there's exactly one on the map, so the answer is always the same
- **dead** — there are none, so it always returns null (which still costs the seekers a question
  and still pays the hider a card)

The dead list is usually longer than the list of missing features: one absent feature can kill two
questions, because the deck asks about it in both the Matching and the Measuring category. Others
die from the shape of the map — a map inside a single state and country can't answer either border
question, and a feed with no rail mode kills Train Platform.

Curses get the same treatment. The rulebook says things like *"if there are no bridges on the game
map, this curse should be removed"*, so that becomes a real query against real data. Curses that
survive the geography check can still earn a warning, and a couple are flagged as player preference
rather than measurement.

### 4. Score it

Two models, both worth 100 points, both fully traceable. Every point traces to a named metric with
its value, its threshold, and whether it came from the rulebook, the feed, or an interpretation, all
printed on the page. Metrics that can't be measured get **dropped and the denominator
renormalised**, never guessed at.

Zones are scored on six axes: **information resistance**, **reach**, **service**, **endgame spots**,
**amenities**, **exposure**.

Information resistance is the thing a human with a map can't do. For every live question, it
computes what every zone *would answer*, then how many other zones give the same answers. A zone
whose answer vector is shared with a crowd survives interrogation; a zone with a unique vector gets
named by one cheap question. The comfortable zone with the distinctive landmark next door is often a
*worse* hide than a boring one.

Reach and exposure deliberately pull against each other: one rewards a zone you can get to quickly,
the other rewards a zone the seekers find expensive to reach. Zones that score well on both are what
you're shopping for.

### 5. Render

One document, hydrated progressively. The pipeline runs in a Web Worker and streams staged results;
each section is swapped from skeleton to real markup the moment its data lands.
[Web Awesome](https://webawesome.com/) components for the interface, MapLibre + OpenFreeMap for the
maps, no build step, no framework, no bundler. Light and dark themes, and the selected game day
follows you between the two views.

---

## Determinism

The same feed and the same map files produce the same report. No wall clock reaches the output;
every date on the page comes from the feed's own calendar or from the analysis-date override. The
one call into randomness is a fixed-seed permutation inside the minimum-enclosing-circle
computation, and every dictionary and set is iterated through a sort. The feed is cached in the
browser (IndexedDB, keyed by a hash of the exact request), and the map files are immutable and
content-addressed, so a run is reproducible without being offline.

If two people generate the report for the same city they must get the same report, or it isn't
evidence of anything.

---

## Repo layout

```
index.html           the page shell: landing stage, Advanced panel, eight skeleton sections
app.js               main-thread controller: owns every element, listener, and the worker protocol
worker.js            the pipeline orchestrator, off the main thread
lib/ gtfs/ osm/ rules/   worker-side pipeline (no DOM)
  gtfs/merge.js      merges several feeds into one, with per-feed id namespacing
render/              main-side renderers (Report → HTML strings)
  render/landing.js  the landing picker's markup, pure data → string
  render/picker.js   the landing map: MapLibre, clustering, the hand-rolled draw tool
lib/catalog.js       main-side reader for data/feeds.json: search, bbox intersection, feed URLs
data/feeds.json      the feed catalogue snapshot the landing map draws; one JSON object per
                     line so a regeneration reads as a diff
styles.css           the one stylesheet
CONTRACT.md          authoritative for every shape crossing a module boundary
tools/smoke.mjs      headless harness: runs the real pipeline, asserts 19 golden numbers,
                     then the merge assertions
tools/mdb-snapshot.mjs   rebuilds data/feeds.json from the Mobility Database CSV; --check
                     validates the committed file offline; --counts also measures each
                     feed's stops and routes from three HTTP ranges of its zip
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
                     hosted kit pinned in index.html. Kept deliberately; do not delete.
```

The design specs the code occasionally cites (`specs/*.md`, `scoring.md`) are kept outside the
tree and have never been tracked here.

---

## Caveats

- **Scheduled times are not real times.** Everything comes from the published timetable. Check live
  tracking on game day.
- **OpenStreetMap isn't Google Maps**, and the rulebook assumes players are using a maps app. The
  rulebook's legitimacy test (5+ Google reviews) has no OSM equivalent; expect some category
  disagreements at the margins.
- **The map data is a snapshot, not live.** The prebuilt files reflect OSM as of the planet dump
  they were built from; the provenance section names the date. The selectors printed next to each
  count let you check any number against live OSM.
- **The "within 10 ft of a routable path" test is not evaluated.** Checking it needs a buffer around
  every walkable way on the map, which the prebuilt files don't carry. Candidate hiding spots are
  still found and listed, but every one is marked verify-on-the-ground. Stand somewhere legal.
- **The feed catalogue is a snapshot, and its boxes are crude.** The markers come from
  `data/feeds.json`, curated from the Mobility Database's published CSV, refreshed monthly by
  `.github/workflows/feed-catalogue.yml` as a pull request and regenerable with
  `node tools/mdb-snapshot.mjs`. Each system is placed by the bounding box the catalogue records,
  which is enough to drop a marker and *not* evidence of where that system runs today. A box
  withdrawn upstream keeps the one the file already had and marks the row `k`. Systems spanning
  more than 250 km and feeds no longer updated are hidden behind opt-in switches, but can be added
  from search. Feeds that need an API key cannot be fetched by the page; it shows them and links the
  agency's own download. A system whose agency never published to the Mobility Database is not on
  the map: that is what bringing your own feed is for.
- **A map pick downloads the catalogue's mirror, not the agency's own file.** MobilityData keeps a
  copy of the latest zip it fetched for each source, and that copy sends CORS headers where most
  agency servers don't. It can differ from the agency's file in hash and publication date, so a run
  from the map and a run from the agency's URL can legitimately disagree. The provenance section
  names the exact source of every feed that went in.
- **Nothing guards the map layer against a country-sized border.** The OpenStreetMap layer's cost
  scales with the border, and picking several systems or drawing a very large shape can produce a
  border far bigger than anything this has been run on.
- **The map layer has only been exercised on a handful of cities**, small and large; the schedule
  side on a few more, including heavy-rail systems. Behaviour beyond those is unproven.
- **Some of this is interpretation**, and the rulebook is genuinely ambiguous in places. Those spots
  are labelled as interpretations on the page, but you and your group are the final authority. It's
  your game.
