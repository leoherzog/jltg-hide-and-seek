# Country-Scale Evaluation: The Grounded Recommendation

*Produced 2026-08-26 by a 17-agent workflow: 4 grounding scouts → 3 competing designs (Fable, Opus,
Sonnet) → 9 adversarial judges across 3 lenses → 1 synthesis. Panel ranking: Border First 6.33 >
The Honest Country Run 5.67 > Exploit the Feed That Already Exists 5.17. 19 hard blockers found.*

**Status: unreviewed machine output.** The synthesis corrected its own scouts in four places, but the
line citations below have not been independently verified against the tree. Treat every `file:line`
as a claim to check, not a fact. See §10.

## Bottom line

**Switzerland is the only one of the three that can be done properly, client-side, in this repo.** It
needs four weeks of allocation and clipping work, all of it inside existing module boundaries, plus
one CONTRACT amendment. **England ships as "Great Britain, buses and coaches, and says so"** — the
rail gap is a data-landscape fact and the OSM-synth patch for it is actively harmful (proof below).
**Japan has no client-side path at all** and the honest product is a Tokyo-metro run, not a refusal
message dressed as a feature.

The spine is **Border First** (panel 6.3), specifically its moves 2, 4, 5 and 10. Grafted in: the
`layersRead` bug from *Honest Country Run* (its judge's single "worth stealing"), and the catalogue
split from *Exploit the Feed* (its judge's single "worth stealing"). **Discarded** outright: Border
First's move 6 (bake all layers into density tiers) and *Exploit the Feed*'s move 4 (OSM rail
synthesis) — both wrong, not merely expensive.

---

## 1. Corrections to the ground truth

**The scouts were right about:** `_reserve` doubling from 1024 (`gtfs/feed.js:567-583`), `compact()`
slicing all five/six arrays (`:618-628`), `_s1ExpandFrequencies` building a whole second store via
`out = new StopTimes(st)` (`:1187`) and rebuilding all rows at `:1212-1229`, the two dead
`Object.keys(run.arrivalS).sort(cmpStr)` calls (`gtfs/network.js:813-814`, `:837-838`),
`stopRows(feed, days, best, zones)` called identically at `worker.js:670` and `worker.js:903`,
`zoneCover` called 13× per run, `worldAdminAreas` unconditional at `osm/geodata.js:977`,
`worldDensity` unconditional at `:2084`, `adminAreasAt` a linear scan per zone at `:988`, and
`osm_nearest`/`osm_distance` as unindexed nested loops at `rules/audit.js:708-733` / `:735-757`.

**Correction 1 — `Border.trimmedStopIds` does not exist.** *Honest Country Run*'s move 4 is built on
it. `inferBorder` returns exactly `{kind, bbox, circle, padM, geojson, areaSqM}`
(`gtfs/infer.js:358-365`), and the comment at `:315-319` says the difference is *counted, not
materialised*, on purpose. If CONTRACT.md §(b) documents that field, that is a live contract/code
divergence worth reporting on its own.

**Correction 2 — `worldCount`'s result is published.** Both Border First (move 7) and Honest Country
Run (move 6.2) claim "the budget branch discards the exact count anyway." It does not:
`osm/geodata.js:2039` is `counts[key] = outcome.upperBound`, and `GeoData.counts` reaches
`curseCounts` and the page. A `stopAfter` cap converts a published bbox *upper bound* into a *floor*.
That is a report-content change requiring disclosure, not a free optimisation. Deprioritise it.

**Correction 3 — the size-vote shortcut, correctly stated.** Border First's version (A, B, D all
saturate ⇒ large for any C) is arithmetically **true**: votes `[2,2,c,2]` sort to `[c,2,2,2]`,
`lowerMedian` takes `s[1] = 2`, and the clamp at `gtfs/infer.js:397` is `max(1, min(3, 2)) = 2`.
Honest Country Run's version (hull + diameter alone) is **false**: `[2,0,0,2]` gives lower median 0,
clamped up to 1 — *medium*. Do not ship the second one.

**Addition neither approach found:** at LARGE, `s1DayMetrics` calls `zoneCover(served, radiusM, ...)`
at `gtfs/network.js:758` and `zoneCover(served, HALF_MILE_M, ...)` at `:759` with **identical
arguments**, because `size.zoneRadiusM` *is* `HALF_MILE_M` (`gtfs/network.js:148`). `zoneCover` is
pure and deterministic. Memoising it on `radiusM` is one line, fires only at LARGE — exactly national
scale — and cannot move a golden, because the reference feed is `medium` (`tools/smoke.mjs:498`).

**Correction 4 — a single ring is not a country, and `Border.kind` is a closed enum.**
`gtfs/infer.js:347` is `opts.borderShape === 'circle' ? 'circle' : 'bbox'`, and CONTRACT.md
§(c):1027-1032 says flatly *"Do not add a shape or ring field to `Options`."* It then carves exactly
one exception: *"the one place a ring does cross the wire is inside a `kind:'osm'` `SourceRef` —
there the ring IS the source."* That sentence is the whole argument for a clip ring, and it is an
argument the owner has to accept or reject (§8).

---

## 2. What ships, staged

### Stage 0 — Measure, before arguing (2 days, no contract, no golden risk)

Extend `tools/smoke.mjs` with a `--budget` mode printing peak heap and per-stage wall time. Every
number below is reasoned from V8 costs and one live ZIP central-directory probe; the repo's own
culture (AGENTS.md: re-measure the OSM budget, never derive it) says the scaling work is held to the
same standard. **The specific number nobody has: how many zones does a clipped Swiss feed produce at
`HALF_MILE_M`?** That single figure decides whether `adminAreasAt` and `SEEKER_SAMPLE_CAP` are
problems or footnotes, and it cannot be estimated from either side.

### Stage 1 — Free wins, useful today, on every existing city run (1.5 days)

All contract-free, all golden-safe.

| Change | File:line | Why it's free |
|---|---|---|
| Delete the two `.sort(cmpStr)` calls | `gtfs/network.js:813`, `:837` | Result is overwritten by `.sort(cmpNum)` on the same expression |
| Pre-reserve `StopTimes` from `entry.size` | `gtfs/feed.js:567-583`, consumed at `:826`; `size` set in the entry object at `~:367` | Kills the ~2.0 GB doubling transient; `readStopTimes` already has the member |
| Skip `compact()` under ~5% overshoot | `gtfs/feed.js:618-628` | Every reader goes through `st.length` |
| Memoise `zoneCover` on `radiusM` | `gtfs/network.js:758-759` | Identical call twice at LARGE only |
| Send `stopRows` once | `worker.js:670`, `:903` | Same arguments, computed and cloned twice |
| **`layersRead` accounting** | `osm/geodata.js:2046` vs `:2060-2076` | *Grafted from Honest Country Run.* A `counted` outcome proves the origin answered. Today, a bbox where every feature category exceeds `CATEGORY_FEATURE_BUDGET` (`:237`, 40000) reaches `:2060` with `layersRead === 0` and throws `world files: no layer could be read` with an **empty** reason list — because `layerFailures` was never populated. The comment at `:2061-2067` says this shape exists precisely to avoid reporting a code problem as a network problem; at national scale it reports a *scale* problem as an origin failure. Genuine bug at any scale. Fix it whether or not country support ever ships. |

Do **not** bundle a worker-side stop cap with this. CONTRACT §(d) `StopRow` states
`render/strategy.js` counts these rows per zone and `servedStopCount` falls back to their length —
narrowing the set moves published numbers. Fix the fallback first, then cap.

### Stage 2 — Make one national feed parse (2.5–3 weeks). This is the unlock.

**2a. Staged table read order.** `unzip` sorts entries by `cmpStr(a.name, b.name)`
(`gtfs/feed.js:~375`) and `_s1ParseTables` iterates that order (`:801`). `'stop_times.txt' <
'stops.txt'` because `_` (0x5F) precedes `s` (0x73) — which is the *only* reason a clip cannot be
done today. Replace the loop with a fixed order: `stops → stop_times → trips → calendar/calendar_dates
→ rest`. No consumer iterates `Object.keys(feed.tables)`, so the reorder is invisible.

**2b. Parse-time ring clip.** After `stops.txt`, build a `Uint8Array` in-ring mask over interned stop
ids via `pointInRing`. In `readStopTimes` (`gtfs/feed.js:826`), skip out-of-ring rows; drop trips
left with `<2` rows; keep only referenced `trip_id`s and `service_id`s. Times are absolute, so
surviving rows stay correct. This is exact, not sampled. It is the difference between 34.6 M
`stop_times` reaching Barcelona and Prague and the subset that actually serves Switzerland.

**2c. Columnar `trips` / `calendar_dates` / `transfers`.** `gtfs/feed.js:16-17` states the assumption
that breaks — *"every other table is thousands of rows and stays as plain objects."* Add a
`ColumnTable` beside `StopTimes` with a per-table column spec; expose it behind the lazy row-dict
Proxy `tables.stop_times` already uses.

**Two things Border First got wrong here, both of which change the plan:**

- **2c and 2d are not independent.** `gtfs/feed.js:1232-1234` does
  `feed.tables.trips = feed.tables.trips.filter(...).concat(newTrips)`. Against a `ColumnTable`
  Proxy, `.filter()` materialises 2.27 M plain row dicts — silently reverting the whole saving on
  exactly the national feeds you're targeting (the Swiss feed ships a non-empty `frequencies.txt`).
  They land together or 2d is written to preserve the store.
- **`gtfs/merge.js` is the real cost.** Those three tables are precisely the ones merge namespaces by
  rewriting row objects. CONTRACT §(b) already records that columnarising `stop_times` forced merge
  to refuse it explicitly. Budget a week for merge invariants; "reads through an accessor" is not the
  whole job.

**2d. Fix `_s1ExpandFrequencies` in place** (`gtfs/feed.js:1168-1239`): reserve once, append
expansions at the tail, remove template rows with one stable in-place filter across the arrays. The
reference feed ships no `frequencies.txt`, so this cannot move a golden.

**2e. The size-vote elision, correctly gated.** Give `s1DayMetrics` an option to skip the T90 sample
and return `t90Min: null`; have `inferGameSize` accept a null axis C **only when A, B and D all score
2**, with the shortcut recorded on the axis and in `sizeInference.note`. Compute hull and diameter
first (`gtfs/network.js:762`, no RAPTOR), then `zoneCover`; only if all three saturate do you skip the
~150 RAPTOR runs of the discarded first pass (`worker.js:605`, overwritten wholesale at `:621`).
Reference feed is `medium`, so it never enters the branch.

**2f. RAPTOR typed results** (`gtfs/raptor.js:287-297`). Land this **alone**, with smoke before and
after. `t90_min` is golden at 76.8 ± 1.0 (`tools/smoke.mjs:502`) and it is fed by the key set that the
string sort touches.

**Explicitly not in Stage 2:** shrinking the RAPTOR stop universe to served stops. The claim that it
preserves answers is false — `s1Footpaths` is built over the whole feed's stop index, so RAPTOR
reaches walk-only stops that then appear in `arrivalS` and in the T90 percentile sample. It changes
the distribution, against a golden.

**Also not in Stage 2:** the RAPTOR arena. `raptor()` returns `_s1Parent` and `_s1Round` as live
references into its arrays (`gtfs/raptor.js:301-302`), and `worker.js:645-647` and
`gtfs/infer.js:292-293` both hold two results at once. Reusing and `.fill()`ing those arrays silently
corrupts journeys. It needs a lifetime audit nobody has done.

### Stage 3 — Make the Swiss run honest (1.5 weeks)

**3a. OSM at national scale: read admin, refuse the rest.** This is the part the synthesis disagrees
with all three proposals about. Border First wants to bake 33 more categories into coarse density
tiers; its own judge correctly killed that — `DensityHandler` (`tools/osm-world/build.py:1582-1651`)
is hand-written Python whose `node()` understands only `natural=tree`, has **no `relation()` method at
all**, and bins ways by their **first node**. `park`, `water`, `green`, `shop` are all `nwr/` filters
with relation members. It is a planet-pass rewrite, not a `categories.json` edit, and the first-node
binning would attribute a national park to whichever 1.1 km cell its first vertex lands in.

What actually survives at national scale is the **admin ladder**, and it *improves*: 26 cantons vs.
one metro, `matching.admin_1` goes from degenerate to one of the map's strongest questions, and
`nearestOtherLabelM` (`rules/audit.js:449`) is an x-sweep, so the admin-border measuring questions are
cheap in zones. So:

- Guard `worldDensity` (`osm/geodata.js:2084`) on border area — keys stay **absent**, which
  `:2090-2104` already handles correctly (absent-not-zero, with the note machinery).
- Keep `worldAdminAreas` but give `adminAreasAt` (`osm/worldfile.js:996-1024`) a `GridIndex` bbox
  prefilter over area bboxes. The comment at `osm/geodata.js:968-972` claims *"the number of zones
  stops costing anything at all"* — that is true for the fetch and false for the scan, and national
  scale is where it stops being a rounding error.
- Let every feature category over `CATEGORY_FEATURE_BUDGET` go `partial` → `unknown`
  (`rules/audit.js:335-339`, `:1480-1492`). That machinery is already correct.

**3b. Two scale-broken constants.** `REDUNDANT_PAIR_FRACTION = 0.05` of the map diagonal
(`osm/geodata.js:240`) declares any two categories within ~160 km on a Japan bbox "the same question"
— and that result is printed on the page. `synthCoastline`'s
`threshold = Math.max(mapArea, COAST_MIN_AREA_SQM)` (`:1797`, with `COAST_MIN_AREA_SQM = 25e6` at
`:561`) means that above ~76,000 km² no water body on Earth exceeds the map area, so the
great-lake-shore synthesis silently switches itself off. Both produce plausible wrong answers rather
than failing loudly.

**3c. Recalibrate LARGE. Do not add a fourth size.** GUIDE.md:38-39 and :149-153 name Switzerland
(~1,800 stations) and Japan (~8,500) as LARGE's own worked examples; the only higher tier the rulebook
describes (GUIDE.md:233-245, "Global Hide and Seek") is continent scale. `rules/audit.js:2068` already
establishes the `size.name === 'large'` gate precedent. Every change below is golden-safe by
construction.

### Explicitly out of scope

- **A fourth rung in `S1_SIZE_PARAMS`** (`gtfs/network.js:134-153`). No rulebook warrant.
- **Raising `MAX_FEEDS_PER_RUN`** (`lib/core.js:80`). Wrong axis: CH and GB need one pick that is 15×
  over the budget the number encodes; Japan needs ~600.
- **Server-side pre-merged national GTFS.** Breaks "the feed never leaves the browser" and adds an
  origin §0 does not sanction.
- **Wiring up the manifest's per-layer bbox.** Every layer except `high_speed_rail` is effectively
  global; a country bbox intersects all of them.
- **Multi-landmass assembly for `matching.landmass`** (`rules/audit.js:668-675` — the branch returns
  all-null with *"assembling real landmasses is out of scope"*). Japan-only benefit, in the country
  this plan cannot serve.
- **`stopAfter` on `search`.** See Correction 2 — it changes a published number, and `search` reads
  and coalesces a whole level before examining any of it (`osm/flatgeobuf.js:872-880`), so the saving
  is far smaller than claimed.
- **Latitude-banded projection.** Real correctness work (`lib/geo.js:68` is one `cos(lat0)` for the
  whole map), but landing it during the memory refactor doubles golden risk for no Swiss gain (±2% at
  Swiss latitudes).

---

## 3. Country by country

### Switzerland — build for this, and only this

`mdb-2898` "Switzerland Aggregate 2026" is already in `data/feeds.json` (verified: `"c":"CH"`,
`"b":[41.37891,-4.47982,53.5526,16.37711]`, `"r":1`). Its bbox's south edge is Barcelona Sants'
latitude to eight decimals; its stop set reaches Prague. So every hull, diameter, MEC and bbox number
today describes Western Europe.

The parse-time clip fixes that **exactly**, and it fixes it in the one place that also makes the feed
fit. `mergeFeeds([f]) === f` means a one-feed run pays no merge cost. Switzerland is one ring — no
multipolygon question. Projection error at Swiss latitudes is ±2%. `Projection.about`
(`lib/geo.js:96-102`) is the arithmetic mean of stops, and after clipping that mean is genuinely
inside Switzerland.

**Switzerland is the acceptance test.** If a clipped Swiss run does not complete in a tab with honest
numbers, nothing else here is worth shipping.

### England — ship it as buses, and say so in the hero

`mdb-2014` "BODS UK aggregate feed" is in the catalogue (`"c":"GB"`,
`"b":[48.14248,-7.54342,60.80896,20.96378]`, `"r":1`). It is the DfT's own all-operators bundle. It is
**bus and coach only** — National Rail publishes CIF/Darwin, and none of the 41 GB rows is a rail
timetable.

**The OSM-synth rail patch, which two of three approaches propose, must not ship.** Three independent
reasons, all verified:

1. `osm/synth.js:699` — `if (windowEndS + duration >= SERVICE_DAY_SECONDS) { droppedTooLong++;
   continue; }`. With `SYNTH_SERVICE_WINDOW_S = [6*3600, 22*3600]` and `SERVICE_DAY_SECONDS = 30*3600`,
   any synthesized ride over 8 hours is dropped whole. At `SYNTH_MODE_SPEED_KMH.train = 45`
   (`osm/synth.js:113-115`) that is a hard **360 km ceiling on line length**. The ECML, WCML and GWML
   all exceed it and vanish into a counter.
2. `metrics.assumedSchedule` is **run-level on purpose** (`worker.js:628`: *"ONE invented timetable in
   the merge makes every schedule-derived number in the run assumed"*). Adding synthesized rail to a
   real BODS bus feed drops and renormalises the *bus* timetable's scoring too.
3. `osm/synth.js:784-786` derives the timezone from mean longitude — a GB run gets `Etc/GMT` beside
   BODS's `Europe/London` and trips the mixed-timezone degradation on every single run.

So England's answer is: surface `mdb-2014`, clip it to a GB ring, and print "every registered bus and
coach service in Great Britain; National Rail is not in this feed" as a first-class degradation. That
is a real product and an honest one. It is not the England game most readers picture, and the page
must not pretend otherwise.

**Two England-specific hazards.** `Projection.about` is the mean of *stops*, which for BODS clusters
in the Midlands — Scottish stops at 58.7°N are mis-scaled by `cos(58.7)/cos(52.5) ≈ 0.89`, about −11%,
not the ±5% the second proposal claims. And GB is not one ring (Northern Ireland, the Hebrides).

### Japan — there is no client-side path. Say so, and offer the real game.

608 catalogue rows, 570 of them `jbda-` municipal community-bus feeds (verified by count). Zero JR,
zero Tokyo Metro, zero major private railway. This is corroborated data-landscape fact, not a
MobilityData curation artifact.

The OSM fallback tier does not rescue it. At `SYNTH_MODE_SPEED_KMH.train = 45` with a 360 km cap,
**every Shinkansen relation is dropped** — and the Shinkansen *is* the Japan game. The relations that
survive are modelled at 45 km/h, so T90, hub travel and every reachability metric would be wrong by
~6×. Travel time is the entire game. A Japan report built this way would be confidently, specifically
wrong.

Separately, `matching.landmass` stays permanently `unknown` on an archipelago
(`rules/audit.js:668-675`), and `measuring.international_border` is structurally dead on an island
nation — properties of the country, not defects the app can fix.

**The honest Japan product is a Tokyo-area run** from ODPT/Toei picks inside the existing 6-feed cap,
rated as the metro map it is. Everything in Stage 2 and 3 is sized so that the day a Japanese national
feed appears, the pipeline is ready. Do not build a Japan-shaped feature in the meantime.

---

## 4. Catalogue: split the one over-broad predicate

*Grafted from Exploit the Feed — its judge's sole "worth stealing."*

`tools/mdb-snapshot.mjs:~621` is a single line:
`if (spanKm(entry.b) > REGIONAL_KM) { entry.r = 1; regional++; }`. That assigns identical `r:1` to a
genuine national aggregate, a cross-border coach operator, and an upstream bbox typo. `corruptReason`
(`:222-233`) caps latitude span at 60° and longitude span at 150° — `mdb-2898`'s spans are 12.2° and
20.9°, so it sails through every check.

**But do not ship the version as designed.** Its own named counterexample defeats it: `mdb-2900`
"Flixbus GB" has `"c":"GB"` and `"b":[48.14248,-5.53222,57.4808,20.96378]` — same corrupted 48.14248
and 20.96378 edges as `mdb-2014`. A rule of "country code matches + bbox overlaps that country ⇒ clip
and promote" badges an international coach operator as a national feed on the first three-entry table.
And "clip to the reference box" is circular: whenever the raw box *contains* the country, the
intersection **is** the reference box, so nothing from upstream survives and the mitigation is just a
hand-typed bbox.

What works instead: a small **curated allowlist by id** (`mdb-2898`, `mdb-2014`) with the corrected
bbox stored alongside, plus a new `nat` flag. Explicit, reviewable as a diff, no inference to get
wrong. `data/feeds.json` stays generated (AGENTS.md forbids hand-patching).

Two things the graft must also handle:

- **Search already finds these rows.** `searchCatalog` is deliberately unfiltered — typing
  "Switzerland" surfaces `mdb-2898` today at tier 2 with an "add anyway" control. What is actually
  broken is `centroidOf` (which puts the Swiss marker in eastern France), `spanKmOf` in `rowWhere`
  (`render/landing.js:~169`, printing a ~1,570 km span), and `rowsIntersectingRing`.
- **Do not exempt `nat` rows from `visibleRows` on the draw path.** `rowsIntersectingRing`'s whole
  purpose is that dragging a box across a state must not silently add Amtrak. A corrected GB box
  intersects every shape drawn anywhere in Britain — and the consequence is not clutter, it is a
  34.6 M-row feed arriving uninvited. Promote `nat` rows in **search**; leave the draw path gated.
- **It reverses a documented decision.** `tools/mdb-snapshot.mjs:~288-295` records that oversized
  boxes are dropped rather than repaired precisely because they belonged to national aggregates and
  were wrong on their face. That position has to be argued down explicitly, not stepped over.

---

## 5. Constants and thresholds to change

| Constant | Current | File:line | Change |
|---|---|---|---|
| A1 ramp bounds | `ramp(nZones, 15, 60)`, 8 pts | `rules/score.js:313` | Size-key against GUIDE.md:141-151's 30/100/500 floors. MEDIUM bound must be ≤319 to keep the reference at full marks |
| `CAP_ZONES` floor | `n < 30`, cap 40.0 | `rules/score.js:686` | Use the resolved size's floor. Its own `why` at `:689` says *"the rulebook's own SMALL floor of 30 stations"* |
| A2 ramp bounds | `ramp(reachShare, 0.35, 0.85)`, 7 pts | `rules/score.js:320` | LARGE-only re-base. **Owner decision — see §8** |
| `CAP_UNREACHABLE` | `reach < 0.15`, cap 45.0 | `rules/score.js:716` | Same gate, same decision |
| `REDUNDANT_PAIR_FRACTION` | `0.05` of map diagonal | `osm/geodata.js:240` | Add an absolute cap (~5 km) |
| `synthCoastline` threshold | `Math.max(mapArea, COAST_MIN_AREA_SQM)` | `osm/geodata.js:1797` (`COAST_MIN_AREA_SQM = 25e6` at `:561`) | ~~Becomes `min(mapArea, cap)`~~ **Rejected 2026-08-26**: the shutoff above ~76,000 km² is the stated semantics — "larger than the game map" is the test, and the constant is a *floor* under that relative test, not a ceiling candidate. A cap would keep synthesizing shore for lakes the map dwarfs. The real (separate) gap is honesty — the page never says "the map is bigger than every lake" — and beyond that, area is a proxy for containment: a strip-shaped border along a great lake's shore suppresses the synthesis without containing the lake |
| `CATEGORY_FEATURE_BUDGET` | `40000` | `osm/geodata.js:237` | **Leave alone.** Changing it changes what "counted" means. The `layersRead` fix is the real repair |
| `SEEKER_SAMPLE_CAP` / `SURV_FULL_UNIVERSE_MAX` | `200` / `400` | `lib/core.js:49-50` | Keep the cap; **print the sampling ratio** in §09. At ~12k zones it is a ~1.7% draw where it was ~50% on the reference feed |
| `MAX_FEEDS_PER_RUN` | `6` | `lib/core.js:80` | Unchanged. Add `MAX_STOP_TIMES_PER_RUN` as a post-clip row budget with a named remedy |
| `T90_ORIGIN_STRIDE` | `30` | `lib/core.js:45` | Unchanged — `gtfs/network.js:828-833` already caps at ~50 origins whatever the feed size, with a comment saying why |
| `SYNTH_MODE_SPEED_KMH.train` | `45` | `osm/synth.js:113-115` | Unchanged, but note it implies the 360 km line-length ceiling at `:699`. Document that, don't tune it |

---

## 6. CONTRACT.md amendments

Sections at: §0 Ground rules (line 22), §(a) Module map (40), §(b) Data shapes (143), §(c) Options
(971), §(d) worker protocol (1036), §(f) degradation policy (1381).

1. **§(c), lines 1027-1032** — the ring rule. The clip ring must be argued as a *source*, not a run
   setting, riding the sentence already there: *"there the ring IS the source, the same category as a
   `File`'s bytes."* Deliberate amendment, not reinterpretation.
2. **§(b) `Feed`** — a new `Feed.clip` record: the ring's `stableHash`, and how many
   stops/trips/stop_times/calendar rows were dropped. A clipped feed is a different feed.
3. **§(b) `Feed`** — the `tables.stop_times` lazy-Proxy exception generalises to a named set. The
   current note calling out that the view has zero readers ("the precondition for ever deleting it")
   must be rewritten: it becomes load-bearing for three more tables.
4. **§(b) `Border`** — `kind` gains a third value, or the ring stays a *clip input* and the presented
   border remains a bbox. **Owner decision — see §8.**
5. **§(b) `TravelTimes`** — `raptor()`'s return shape (typed arrays + `stopIndex`, not a string-keyed
   object).
6. **§(b) `SizeInference`** — axis C gains a flag recording that the value came from one origin
   because A, B and D had already decided the vote. Carry the three-line proof and a unit test over
   `c ∈ {0,1,2}`.
7. **§(f)** — two new rules: (a) the feed was clipped before parsing, counts describe the clipped
   feed; (b) above X km² the density grid is refused, not read, and refusals are notes. Both in the
   same family as rule 3's third state.
8. **§(f) rule 6** — exceeding the post-clip row budget is a fatal error with a named remedy.
9. **§(b) `Border`** — if `trimmedStopIds` is documented there, it does not exist in
   `gtfs/infer.js:358-365`. Fix the divergence in whichever direction you prefer.

Also: `rules/catalogue.js` `INTERPRETATIONS` (the frozen `{id, affects, text}` array at ~463-618)
needs **three** new rows and **one conditioned row**: country-border clip; through-service truncation
at the ring; the LARGE A2 re-base. And `map_border_derivation` (~470-473) currently tells the reader
the border is the bbox of in-map stops padded by one zone radius — on a clipped run that is false and
it must be conditioned, not merely supplemented.

---

## 7. The honesty ceiling nobody can engineer around

With the density grid refused and most feature categories over budget, a Swiss run drops a large share
of the OSM-backed points. If more than 40% of the 100 go unavailable, `Fitness.score` is `null` and
the country verdict reads "Partly measurable" (§(f) rule 2). That is honest. It may also be the
*expected* outcome, not a risk — the IR axis alone is 30 points and it needs `zoneInventory`, which
needs `pois`, which a counted-not-fetched category never sets.

This is not a reason not to ship. It is a reason to know the number before you promise a score.
**Stage 0 must measure the surviving denominator on a real clipped Swiss run before Stage 3 is
designed.**

---

## 8. Decisions only the repo owner can make

1. **Does a clip ring belong in `Options`?** §(c):1029 forbids a ring field and then sanctions one *as
   a source*. A clip ring genuinely redefines what the feed is — that is the argument — but it is your
   rule and your call. The alternative (ship the ring as a same-origin repo asset the worker resolves
   from a `countryCode`) respects the letter while making the asset list grow.

2. **Can a country's `Fitness.score` be `null`?** If "Partly measurable" is an acceptable country
   verdict, ship Stage 3 as written. If not, the 40% rule needs a size-gated exemption — which is a
   rules change with no rulebook warrant, and should not be made quietly.

3. **`Border.kind`: a third value, or a bbox that lies?** A country ring that clips the feed but is
   presented as a padded bbox is defensible (the bbox of a clipped Swiss feed *is* Switzerland-shaped)
   and cheap. A `kind: 'country'` polygon is correct and touches every bbox-assuming consumer in the
   renderer and the audit.

4. **Is A2 at LARGE a rulebook expectation or a city-scale interpretation?** `reachability_one_way`
   (`rules/catalogue.js:~571-575`) already asserts the rulebook's constraint is one-way and
   hider-only. If you accept that reading, A2's 0.35/0.85 ramp and `CAP_UNREACHABLE`'s 0.15 are ours,
   not the rulebook's, and a national map with 25% reachability is legitimate rather than capped at
   45. If you don't, they stay and countries score badly for a property nobody asked about. Either way
   it needs a disclosed `INTERPRETATIONS` row — the one thing that must not happen is an unlabelled
   retune.

5. **Is "Great Britain, buses only" a product you want to ship?** It is honest, it is real, and it is
   not the England game. Saying no here is a legitimate answer.

6. **Does `data/borders.json` (or equivalent) count against §0's asset allowlist?** §0's own note says
   `data/feeds.json` is a same-origin repo asset and not a sixth external one, so precedent says no —
   but the §0 "Known divergence" line about `DEFAULT_WORLD_BASE_URL` becomes harder to leave as-is
   once a national run's *counts* come from the bucket.

---

## 9. If you only do one thing

Ship Stage 1. Six changes, a day and a half, no contract amendment, no golden risk, and every one of
them helps Grand Rapids and Chicago today. The `layersRead` fix in particular is a genuine bug whose
failure mode — telling a player the map files were unreachable when they were merely large — is
exactly the confusion `osm/geodata.js:2061-2067` says that code shape exists to prevent.

Then measure a clipped Swiss run before committing to anything in Stage 3.

---

## 10. Provenance and what is not verified

Independently confirmed before the workflow ran: `MAX_FEEDS_PER_RUN = 6` at `lib/core.js:80` and its
three enforcement sites (`render/landing.js` `PICK_CAP`, `app.js:1007`, `worker.js:261`); the module
layout; GUIDE.md:159 and :239 on country and global scale.

Everything else is agent output. The synthesis claims it opened the files and corrected its scouts in
four places, and the `mdb-2898` / `mdb-2014` / `mdb-2900` bbox values were quoted by two independent
agents from `data/feeds.json`. But no line citation here has been re-checked against the tree by hand.
Before acting on any item, open the file.

The workflow journal, with all 17 agents' full return values — four scout reports, three complete
designs, nine judge verdicts — is at:

```
~/.claude/projects/-home-lu-Projects-jltg-hide-and-seek/<session>/subagents/workflows/wf_d1b7cb13-cf3/journal.jsonl
```
