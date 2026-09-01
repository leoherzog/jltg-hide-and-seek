# Hide + Seek Map Rater

Point it at a city's public transit feed. It tells you whether that city works as a map for
[Jet Lag: The Game's *Hide and Seek*](https://www.jetlagthegame.com/) home game, how good a map it
is, and — if you're the one hiding — where to go.

It runs entirely in your browser. Serve this directory with any static file server, open it, pick
your city off the map — or bring your own feed — and the whole pipeline runs client-side. The feed
goes from the agency, or from your disk, straight into the tab. It is never uploaded anywhere.

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
python3 -m http.server 8000              # then open http://localhost:8000/
node tools/smoke.mjs                     # headless: the pipeline, against 19 golden numbers
node tools/mdb-snapshot.mjs --check      # validate the committed feed catalogue, no network
```

**Pick your city on the map.** The landing page *is* a world map of 2,471 transit systems —
full-screen, with every control in one panel floating on it (a column on the left on a desktop, a
bottom sheet on a phone) —
one marker per feed, clustered, drawn from a tracked snapshot of the
[Mobility Database](https://mobilitydatabase.org/) catalogue. Search for a city or an operator,
click a marker, or draw a shape and take every system it touches. Two switches add the other 299
in the snapshot — regional and long-distance networks, and feeds nobody publishes any more, both
off by default because they overlap almost any shape you draw. Press Analyse. Everything — the
feed download, the parse, the travel-time model, the map-feature lookups, the scoring — happens in
your browser.

**Or bring your own feed.** Under *Or bring your own feed* the original flow is intact: drop a
`.zip` or paste a URL. It's the path that works when the catalogue never loaded, when the map
library is blocked, and when your agency simply never published to the Mobility Database. A map
pick and a zip of your own **add up** rather than replacing each other. One wrinkle the page itself
will warn you about: fetching a URL only works if the agency's server sends CORS headers, and
plenty don't. When that happens, download the zip yourself and drop it in — same answer, one extra
step. (The catalogue's own mirror URLs, which is what a map pick fetches, always send them.)

**Or start from an example.** A row of chips in the panel — Chicago, New York and a
dozen other metros — loads a hand-picked set of that city's public operators in one click: CTA,
Metra, Pace and the Water Taxi for Chicago; the subway, the borough bus feeds, both ferries and
the Roosevelt Island tram for New York. Campus shuttles and private coaches are left out on
purpose. The chip fills the selected list; add to it, remove from it or press another.

**More than one system at a time.** A metro plus its commuter rail, or two neighbouring operators a
drawn shape happened to cross, merge into one map. Up to ten feeds per run — each one costs a
download and a parse, so a big pick takes longer and the tenth is refused rather than merged.
Picking several no longer changes anything else about the run: the map-feature layer used to switch
itself off past one feed, and doesn't any more.

**Where the game is played.** As soon as you pick a feed, a gold rectangle appears on the map: the
game border, fitted to what you picked. Drag a corner, drag an edge, drag the middle to move the
whole thing, or type the four numbers — South, West, North and East — into the fields in the panel;
Shift+↑ and Shift+↓ in a field nudge that edge, so the keyboard does everything the handles do.
Buttons beside them fit the border back to the feeds, seed it from where two systems overlap, box a
shape you drew, or shrink and grow it 10 % at a time. **Leave it alone and nothing changes**: an
untouched border is inferred from what the start stop can actually reach, exactly as before. Touch
it and the box becomes the game — the stops outside it stop counting, and so do the zones, the size
vote, the crossing time and the score.

**"Re-run with this border."** Some maps are two games in one. CTA + Metra + Pace + the Water Taxi
measures LARGE, because the outer Pace and Metra stops stretch the map across the whole metro,
though the game most people mean to play is the core. So the report asks a narrower question: is
there a tighter box — everything the start stop can reach inside one hiding period — that measures
as a smaller, self-consistent game? When there is, §01 says so in plain numbers (on that Chicago
run: 11,430 of 24,705 stops, carrying 77 % of the day's departures, a MEDIUM game rather than
LARGE; of the 13,275 stops left outside, 12,281 are Pace), draws the suggested box on the map
beside the current one, and offers a button. Pressing it re-runs everything inside that border. The
feeds come back out of the browser's cache, so the second run downloads nothing, and a chip at the
top of the page says which run you are looking at and what the last one measured. The suggestion is
an offer the report never applies on its own, and it appears only when it would change the answer —
so re-running inside the suggested box is the end of it, not the start of a loop.

The map is optional, not load-bearing: search, Add and Analyse all work before the map library
loads, and if it never loads.

**How long it takes.** The schedule side runs in seconds. The map-feature layer is the slow part:
about 18 seconds on the Grand Rapids reference border, over roughly 303 HTTP Range requests and
14.7 MB, and the browser's HTTP cache makes a second run much cheaper. There is no switch to turn
it off. There used to be, and it was a mistake: a run without map features loses 37 of the 80
questions, 16 of the 24 curses and two of the six score axes — a third of the report, gone for
about 18 seconds. If the map files genuinely cannot be read the run still finishes, and says so:
everything the feed alone can answer is reported, and everything that needed map features is
excluded from the denominator rather than guessed at.

**Overrides.** The Advanced panel also holds an override for every inference — game size, zone
radius, hiding period, start stop, border shape, departure time, analysis date, excluded stops and
routes. The border box itself is no longer typed in here: the panel shows the four numbers read-only
and the map above is where you edit them, so the two can never disagree. Everything is inferred by
default; the overrides exist for when you disagree, or when your group has already agreed on a
border. Excluding stops or routes now narrows the whole report, not just the border — the excluded
stops stop counting toward the zones, the size and the score. Two more switches manage the feed
cache: one re-downloads a feed the browser has already cached (worth flipping when the agency publishes a new
one), and one does the opposite — a cache miss becomes an error, so a run either reproduces exactly
what an earlier run saw or stops and says so.

---

## What comes out

One page, two views.

### The report — should we play here?

The public-facing view. It opens with a rating out of 100 and the band that rating falls in — from
"not recommended as a transit game" up through "excellent map" — and then shows its working across
eight sections, opening with the map. It fills in progressively as the pipeline runs, section by
section, rather than appearing all at once at the end.

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

Eight, not nine, since 2026-08-23: the At a Glance tiles were folded into the map section
and hydrate there through a nested `data-section="glance"` host with its own clock, so the
map is built once and the tiles are still corrected on every stage and every day click.

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

**Several feeds become one.** When you pick more than one system, they are merged before anything
downstream sees them, table by table: every id — stops, routes, trips, services, shapes, agencies —
grows an `f0:` / `f1:` prefix so two agencies that both number a route `1` cannot collide, and each
feed keeps its own calendar. The service window is the **intersection** of the feeds' windows, so
the day the report picks is a day every system actually runs; if that intersection is empty or
shorter than a week, the report says so rather than quietly choosing badly. Mixed time zones are a
warning, never a refusal — every time in the pipeline is feed-local, so the only thing a mixed-zone
merge is wrong about is the clock alignment of a ride *between* the two systems, and the page says
that out loud. Connections between the systems come for free: transfers are built from stop
proximity rather than from `transfers.txt`, so two agencies whose stops sit forty metres apart are
already connected. Section 09 lists every feed that went in, with its own hash, window and operator.
One thing the merge cannot average: the fare quoted in the house rules is the **primary** operator's
(the feed with the most trips), because there is no honest way to add two fare tables together.

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
each of the eight sections is swapped from skeleton to real markup the moment its data lands, so you
read the map while the score is still being worked out. [Web Awesome](https://webawesome.com/)
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
index.html           the page shell: landing stage, Advanced panel, eight skeleton sections
app.js               main-thread controller: owns every element, listener, and the worker protocol
worker.js            the pipeline orchestrator, off the main thread
lib/ gtfs/ osm/ rules/   worker-side pipeline (no DOM)
  gtfs/merge.js      merges several feeds into one, with per-feed id namespacing
render/              main-side renderers (Report → HTML strings)
  render/landing.js  the landing picker's markup, pure data → string
  render/picker.js   the landing map: MapLibre, clustering, the hand-rolled draw tool
lib/catalog.js       main-side reader for data/feeds.json: search, bbox intersection, feed URLs
data/feeds.json      the feed catalogue snapshot the landing map draws — 3,309 systems, of
                     which 2,471 are on the map before the two opt-in switches; one
                     JSON object per line so a regeneration reads as a diff
styles.css           the one stylesheet
CONTRACT.md          authoritative for every shape crossing a module boundary
tools/smoke.mjs      headless harness: runs the real pipeline, asserts 19 golden numbers,
                     then the merge assertions
tools/mdb-snapshot.mjs   rebuilds data/feeds.json from the Mobility Database CSV; --check
                     validates the committed file without touching the network; --counts
                     also measures each feed's stops and routes by reading three HTTP
                     ranges out of its zip, never the whole archive
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
- **The feed catalogue is a snapshot, and its boxes are crude.** The markers on the landing map
  come from `data/feeds.json`, curated from the Mobility Database's published CSV, refreshed
  monthly by `.github/workflows/feed-catalogue.yml` as a pull request and regenerable by hand with
  `node tools/mdb-snapshot.mjs`. Each system is placed and sized by the bounding box
  that catalogue records — enough to drop a marker and to decide whether a drawn shape crosses a
  system, and *not* evidence of where that system runs today. A handful were measured years ago and
  a few were measured once and then withdrawn upstream, in which case the file keeps the box it
  already had and marks the row `k`. 253 systems whose box spans more than 250 km (intercity rail,
  national aggregates) are hidden behind an opt-in switch, along with 638 whose feed is no longer
  updated; both can be added anyway from the search results. 184 feeds need an API key and cannot
  be fetched by the page at all — it shows them and links the agency's own download instead. And a system whose
  agency never published to the Mobility Database is not on the map: that is what bringing your own
  feed is for.
- **A map pick downloads the catalogue's mirror, not the agency's own file.** MobilityData keeps a
  copy of the latest zip it fetched for each source, and that copy is what the page can actually
  read (it sends CORS headers; most agency servers don't). It is a different file from the one on
  the agency's site, with a different hash and possibly a different publication date — so a run
  from the map and a run from the agency's URL can legitimately disagree. Section 09 names the
  exact source of every feed that went in, which is how you tell the two apart.
- **Nothing yet guards the map layer against a country-sized border.** The OpenStreetMap layer's
  cost scales with the border, and picking several systems, or drawing a very large shape, can
  produce a border far bigger than anything this has been run on. Skipping OpenStreetMap is
  pre-ticked above one feed for that reason; it is a mitigation, not a fix.
- **The map layer has only been exercised on a handful of cities**, of small and large size; the
  schedule side on a few more, including heavy-rail systems. Behaviour beyond those is unproven.
- **Some of this is interpretation**, and the rulebook is genuinely ambiguous in places. Those spots
  are labelled as interpretations on the page rather than presented as rules — but you and your
  group are still the final authority. It's your game.
