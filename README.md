# Hide + Seek Map Rater

Point it at a city's public transit feed. It tells you whether that city works as a map for
[Jet Lag: The Game's *Hide and Seek*](https://www.jetlagthegame.com/) home game, how good a map it
is, and — if you're the one hiding — where to go.

```bash
uv run generate.py https://connect.ridetherapid.org/InfoPoint/GTFS-Zip.ashx --out build/
```

Two HTML files come out. That's the whole interface.

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

The two files at the repo root, `index.html` and `strategy.html`, are hand-built drafts of what that
answer should look like for Grand Rapids. `generate.py` produces the same thing for anywhere.

---

## Quick start

You need [`uv`](https://docs.astral.sh/uv/). No virtualenv, no install step — the script declares
its own dependency inline (just `httpx`).

```bash
# any GTFS feed URL, or a local .zip
uv run generate.py <gtfs-url> --out build/

# much faster: skip the OpenStreetMap layer
uv run generate.py <gtfs-url> --out build/ --no-osm
```

Find a feed for your city on [Mobility Database](https://mobilitydatabase.org/) or
[transit.land](https://www.transit.land/). Most agencies publish one.

> **Pass `--out`.** It defaults to the current directory, which would overwrite the two hand-built
> drafts at the repo root.

**How long it takes.** ~10 seconds with a warm cache. First run on a new city is ~8 minutes, almost
all of it waiting on the free OpenStreetMap query servers. `--no-osm` runs in seconds but disables
everything that depends on knowing where the museums are. Big systems scale fine — Boston's MBTA
(7,770 stops, 2.15 million scheduled stop times) takes under three minutes.

---

## What comes out

### `index.html` — should we play here?

The public-facing report. For Grand Rapids it opens with **70.5 / 100, "Strong map"**, and then
shows its working:

| § | Section | What's in it |
|---|---|---|
| 01 | Verdict | The rating, the band, and the one-line reason |
| 02 | The map at a glance | Zone count, area, stops, routes, service span |
| 03 | Ride times and the frequency problem | How long it takes to cross the map, and how often buses actually come |
| 04 | Where the transit actually goes | Live map of every stop, every zone, and the game border |
| 05 | Question feasibility | **All 71 questions**, one by one, with a verdict each |
| 06 | Curse deck audit | Which curses to physically remove from the deck |
| 07 | Where every point came from | The full score trace |
| 08 | Findings | Plusses, minuses, things to agree in advance |
| 09 | House rules for game day | Recommended setup for this specific map |
| 10 | Provenance and method | Every query, every source, every interpretation |

The rating breaks into six sub-scores. Grand Rapids scores:

```
A  Zone supply             20   / 20     319 distinct hiding zones
B  Question health         13.5 / 25     only 30 of 71 questions fully work
C  Mobility & tempo        11.2 / 20
D  Round viability         15   / 15
E  Schedule resilience      6.6 / 10     Sunday service falls apart
F  Structural fairness      4.2 / 10     one hub carries 75% of routes
```

It also rates each day separately — Grand Rapids is 70.5 on a weekday, 66.2 Saturday, **60.3
Sunday**. That's a real finding: it's a meaningfully worse game on a Sunday, and you'd want to know
before scheduling.

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
- **The complete table of all 319 zones**, sortable by any axis. If you disagree with the weighting,
  re-sort by the axis you care about and get your own shortlist. Nothing is hidden behind a cutoff —
  zones that are unreachable inside the hiding period are held out of the ranking but still listed,
  with the reason and the travel time.
- **Tactics**, derived from the rulebook and parameterised to this map, each citing its rule.

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
- **unaskable** / **unknown** — structurally impossible here, or needs data this pipeline doesn't
  carry

Grand Rapids: 30 functional, 14 weak, 13 degenerate, 11 dead. The dead list is the useful part —
no commercial airport, no coastline, no consulate, no mountain, no high-speed rail inside the
border. Those five questions are dead weight in the deck.

Curses get the same treatment. The rulebook itself says things like *"if there are no bridges on the
game map, this curse should be removed"* — so that becomes a real query against real data, not a
judgement call. Grand Rapids keeps 21 of 24; two are flagged as player preference rather than
measurement (Egg Partner, Impressionable Consumer), and Curse of the U-Turn gets a warning because
only 10.2% of stops carry a second route, so it rarely does anything.

### 4. Score it

Two models, both worth 100 points, both fully traceable. Every single point traces to a named
metric with its value, its threshold, and whether it came from the rulebook, the feed, or an
interpretation — and all of that is printed on the page. If you think a threshold is wrong, you can
see exactly which one and exactly what it cost.

Metrics that can't be measured get **dropped and the denominator renormalised**, never guessed at.

Zones are scored on six axes: **information resistance**, **reach**, **service**, **endgame spots**,
**amenities**, **exposure**.

The first of those is the interesting one, and it's the thing this project does that a human with a
map really can't. For every live question, it computes what each of the 319 zones *would answer* —
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

The same feed and the same cached data produce **byte-identical** HTML. No randomness, no unsorted
iteration reaching the output, no clock — every date on the page comes from the feed's own calendar
or from `--as-of`. Network responses are cached by a hash of the exact request, so once a city is
cached the whole thing runs offline and reproducibly.

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
to invent things. The full write-up, including why the better model *still* didn't earn a place, is
in `AGENTS.md` and `scratchpad/MODEL_COMPARISON.md`.

Without the flag, the pages are complete and never mention a model.

---

## Options

```
--out DIR              where to write (default: ., which would clobber the drafts — always set this)
--no-osm               skip OpenStreetMap entirely; fast, but disables the OSM-backed questions
--as-of YYYYMMDD       analysis date (default: the feed's own start date)
--size {small,medium,large}      override the inferred game size
--zone-radius M        override the hiding-zone radius
--hiding-period MIN    override the hiding period
--start STOP_ID        override the inferred round-start station
--border-bbox S,W,N,E  set the map border explicitly
--exclude-stop ID      drop a stop from the map (repeatable — for the safety conversation)
--exclude-route ID     drop a route (repeatable)
--departure HH:MM      round-start departure time (default 09:00)
--offline              a cache miss becomes an error instead of a fetch
--refresh              ignore the cache and refetch
--llm                  allow the local model to break exact score ties
--selftest             assert the reference feed's known-good numbers
-v / -vv               logging
```

Everything is inferred by default. The overrides exist for when you disagree, or when your group has
already agreed on a border.

---

## Repo layout

```
generate.py          the whole thing (single file, ~14k lines, one dependency)
README.md            this file
AGENTS.md            notes for AI coding agents: architecture, conventions, measurements
index.html           hand-built draft for Grand Rapids — the design reference, NOT generated
strategy.html        ditto
GUIDE.md             \
HIDING.md             >  the Hide+Seek rulebook — the authority on game rules
SEEKING.md           /
THERAPID*.md         prose rendering of the Grand Rapids feed, handy for sanity checks
build/               generated output (gitignored)
cache/               cached HTTP responses (gitignored)
```

`generate.py` is assembled from section sources kept in the scratchpad — see `AGENTS.md` if you're
editing it.

---

## Caveats

- **Scheduled times are not real times.** Everything comes from the published timetable. Check live
  tracking on game day.
- **OpenStreetMap isn't Google Maps**, and the rulebook assumes players are using a maps app. The
  rulebook's own legitimacy test (5+ Google reviews) has no OSM equivalent; the report says so where
  it matters, but expect some category disagreements at the margins.
- **The OSM layer has only been exercised on Grand Rapids.** The schedule side has been tested on
  BART and the MBTA; Overpass behaviour on other cities is unproven.
- **Some of this is interpretation**, and the rulebook is genuinely ambiguous in places. Those spots
  are labelled as interpretations on the page rather than presented as rules — but you and your
  group are still the final authority. It's your game.
