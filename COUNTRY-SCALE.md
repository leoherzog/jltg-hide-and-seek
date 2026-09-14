# Country-Scale Evaluation: The Grounded Recommendation

> [!WARNING]
> **Unreviewed machine output.** The synthesis corrected its own scouts in four places, but no line
> citation has been independently verified against the tree. Treat every `file:line` as a claim to
> check, not a fact. See [§10](#10-provenance-and-what-is-not-verified).

*2026-08-26 · 17 agents: 4 grounding scouts → 3 competing designs (Fable, Opus, Sonnet) → 9
adversarial judges across 3 lenses → 1 synthesis · 19 hard blockers found. Panel: Border First
6.33 > The Honest Country Run 5.67 > Exploit the Feed That Already Exists 5.17.*

## Bottom line

| Country | Verdict | Deciding fact |
|---|---|---|
| Switzerland | **Build.** The only one done properly, client-side, in this repo: ~4 weeks of allocation and clipping inside existing module boundaries, plus one CONTRACT amendment | One national feed, one ring |
| England | **Ship as "Great Britain, buses and coaches, and says so"** | The rail gap is a data-landscape fact; the OSM-synth patch for it is actively harmful ([proof](#england-ship-it-as-buses-and-say-so-in-the-hero)) |
| Japan | **No client-side path.** Ship a Tokyo-metro run, not a refusal message dressed as a feature | 570 of 608 catalogue rows are municipal community buses |

Spine: **Border First** (panel 6.3), moves 2, 4, 5 and 10. Grafted in, each its judge's single
"worth stealing": the `layersRead` bug from *Honest Country Run* and the catalogue split from
*Exploit the Feed*. **Discarded** as wrong, not merely expensive: Border First's move 6 (bake all
layers into density tiers) and *Exploit the Feed*'s move 4 (OSM rail synthesis).

---

## 1. Corrections to the ground truth

**The scouts were right about:**

| Confirmed finding | File:line |
|---|---|
| `_reserve` doubles from 1024 | `gtfs/feed.js:567-583` |
| `compact()` slices all five/six arrays | `gtfs/feed.js:618-628` |
| `_s1ExpandFrequencies` builds a whole second store via `out = new StopTimes(st)` and rebuilds all rows | `gtfs/feed.js:1187`, `:1212-1229` |
| Two dead `Object.keys(run.arrivalS).sort(cmpStr)` calls | `gtfs/network.js:813-814`, `:837-838` |
| `stopRows(feed, days, best, zones)` called identically twice | `worker.js:670`, `worker.js:903` |
| `zoneCover` called 13× per run | — |
| `worldAdminAreas` unconditional | `osm/geodata.js:977` |
| `worldDensity` unconditional | `osm/geodata.js:2084` |
| `adminAreasAt` is a linear scan per zone | `osm/geodata.js:988` |
| `osm_nearest` / `osm_distance` are unindexed nested loops | `rules/audit.js:708-733` / `:735-757` |

| # | Claim under test | Verdict | Evidence |
|---|---|---|---|
| 1 | `Border.trimmedStopIds` exists (*Honest Country Run* move 4 is built on it) | **False at synthesis. Closed 2026-08-27** toward CONTRACT §(b) | `gtfs/infer.js:358-365`, `:315-319` |
| 2 | `worldCount`: "the budget branch discards the exact count anyway" (Border First move 7, *Honest Country Run* move 6.2) | **False: the count is published** | `osm/geodata.js:2039` |
| 3a | Size-vote shortcut: A, B, D all saturate ⇒ large for any C (Border First) | **True** | `gtfs/infer.js:397` |
| 3b | Size-vote shortcut: hull + diameter alone (*Honest Country Run*) | **False. Do not ship it** | `gtfs/infer.js:397` |
| 4 | A single ring is a country, and `Border.kind` can take one | **False: `kind` is a closed enum.** Owner decision ([§8](#8-decisions-only-the-repo-owner-can-make)) | `gtfs/infer.js:347`, CONTRACT §(c):1027-1032 |
| + | Neither approach found: `zoneCover` runs twice with identical arguments at LARGE | **True.** Memoise it ([Stage 1](#stage-1-free-wins)) | `gtfs/network.js:758-759`, `:148` |

<details>
<summary>Evidence for each correction</summary>

**1.** `inferBorder` returned exactly `{kind, bbox, circle, padM, geojson, areaSqM}`
(`gtfs/infer.js:358-365`), and the comment at `:315-319` said the difference is *counted, not
materialised*, on purpose. It now returns `rawBbox`, `trimmedStopIds` and
`derivation: 'reach'|'option'`, because the game-border work needed the list: §05 explains the border
with it and `suggestBorder` attributes the trimmed stops to their feeds. The line references above
describe the file before that change. Borders stay rectangular; the polygon `Border.kind` question in
§8 is **reserved**.

**2.** `osm/geodata.js:2039` is `counts[key] = outcome.upperBound`, and `GeoData.counts` reaches
`curseCounts` and the page. A `stopAfter` cap converts a published bbox *upper bound* into a *floor*:
a report-content change requiring disclosure, not a free optimisation. Deprioritise it.

**3.** Votes sort, `lowerMedian` takes `s[1]`, and the clamp at `gtfs/infer.js:397` is
`max(1, min(3, x))`:

```
[2,2,c,2] → [c,2,2,2] → s[1] = 2 → max(1, min(3, 2)) = 2   large
[2,0,0,2] → [0,0,2,2] → s[1] = 0 → clamped up to 1          medium
```

**4.** `gtfs/infer.js:347` is `opts.borderShape === 'circle' ? 'circle' : 'bbox'`, and CONTRACT.md
§(c):1027-1032 says flatly *"Do not add a shape or ring field to `Options`."* It carves exactly one
exception: *"the one place a ring does cross the wire is inside a `kind:'osm'` `SourceRef` — there
the ring IS the source."* That sentence is the whole argument for a clip ring.

**+.** At LARGE, `s1DayMetrics` calls `zoneCover(served, radiusM, ...)` at `gtfs/network.js:758` and
`zoneCover(served, HALF_MILE_M, ...)` at `:759`, because `size.zoneRadiusM` *is* `HALF_MILE_M`
(`gtfs/network.js:148`). `zoneCover` is pure and deterministic. Memoising it on `radiusM` is one line
and cannot move a golden, because the reference feed is `medium` (`tools/smoke.mjs:498`).

</details>

---

## 2. What ships, staged

| Stage | Duration | CONTRACT change | Golden risk |
|---|---|---|---|
| [0 Measure](#stage-0-measure) | 2 days | No | No |
| [1 Free wins](#stage-1-free-wins) | 1.5 days | No | No |
| [2 One national feed parses](#stage-2-make-one-national-feed-parse) | 2.5–3 weeks | [§6](#6-contractmd-amendments) items 1–3, 5–7 | 2f (`t90_min`); 2b/2c not assessed |
| [3 Swiss run is honest](#stage-3-make-the-swiss-run-honest) | 1.5 weeks | §6 item 7 and `INTERPRETATIONS` rows | 3c none by construction |

> [!IMPORTANT]
> **Gate:** measure zones at `HALF_MILE_M` and the surviving scoring denominator on a real clipped
> Swiss run before Stage 3 is designed ([§7](#7-the-honesty-ceiling-nobody-can-engineer-around)).

### Stage 0: Measure

Extend `tools/smoke.mjs` with a `--budget` mode printing peak heap and per-stage wall time. Every
number below is reasoned from V8 costs and one live ZIP central-directory probe; AGENTS.md holds the
OSM budget to re-measurement, never derivation, and the scaling work gets the same standard. **The
number nobody has: how many zones does a clipped Swiss feed produce at `HALF_MILE_M`?** It decides
whether `adminAreasAt` and `SEEKER_SAMPLE_CAP` are problems or footnotes, and neither side can
estimate it.

### Stage 1: Free wins

Helps every existing city run.

| Change | File:line | Why it's free |
|---|---|---|
| Delete the two `.sort(cmpStr)` calls | `gtfs/network.js:813`, `:837` | Result is overwritten by `.sort(cmpNum)` on the same expression |
| Pre-reserve `StopTimes` from `entry.size` | `gtfs/feed.js:567-583`, consumed at `:826`; `size` set in the entry object at `~:367` | Kills the ~2.0 GB doubling transient; `readStopTimes` already has the member |
| Skip `compact()` under ~5% overshoot | `gtfs/feed.js:618-628` | Every reader goes through `st.length` |
| Memoise `zoneCover` on `radiusM` | `gtfs/network.js:758-759` | Identical call twice at LARGE only |
| Send `stopRows` once | `worker.js:670`, `:903` | Same arguments, computed and cloned twice |
| **`layersRead` accounting** (note 1) | `osm/geodata.js:2046` vs `:2060-2076` | *Grafted from Honest Country Run.* Real bug at any scale; fix it whether or not country support ships |

**Note 1.** A `counted` outcome proves the origin answered, yet a bbox where every feature category
exceeds `CATEGORY_FEATURE_BUDGET` (`osm/geodata.js:237`, 40000) reaches `:2060` with
`layersRead === 0` and throws `world files: no layer could be read` with an **empty** reason list,
because `layerFailures` was never populated. The comment at `osm/geodata.js:2061-2067` says this shape
exists to avoid reporting a code problem as a network problem; at national scale it reports a *scale*
problem as an origin failure.

> [!WARNING]
> Do **not** bundle a worker-side stop cap with Stage 1. CONTRACT §(d) `StopRow` states
> `render/strategy.js` counts these rows per zone and `servedStopCount` falls back to their length, so
> narrowing the set moves published numbers. Fix the fallback first, then cap.

### Stage 2: Make one national feed parse

This is the unlock.

| Step | Change | Files | Golden risk | Depends on |
|---|---|---|---|---|
| 2a | Fixed table read order | `gtfs/feed.js:~375`, `:801` | None: no consumer iterates `Object.keys(feed.tables)` | — |
| 2b | Parse-time ring clip | `gtfs/feed.js:826` | Not assessed | 2a |
| 2c | `ColumnTable` for `trips` / `calendar_dates` / `transfers` | `gtfs/feed.js:16-17`, `gtfs/merge.js` (+1 week) | Not assessed | Lands with 2d |
| 2d | Expand `frequencies.txt` in place | `gtfs/feed.js:1168-1239` | None: the reference feed ships no `frequencies.txt` | 2c |
| 2e | Size-vote elision when A, B, D all score 2 | `gtfs/network.js`, `gtfs/infer.js`, `worker.js` | None: the reference feed is `medium` | — |
| 2f | RAPTOR typed results | `gtfs/raptor.js:287-297` | **`t90_min` golden 76.8 ± 1.0** (`tools/smoke.mjs:502`), fed by the key set the string sort touches | Land alone, smoke before and after |

> [!WARNING]
> **Two things Border First got wrong here, both of which change the plan.**
>
> - **2c and 2d are not independent.** `gtfs/feed.js:1232-1234` does
>   `feed.tables.trips = feed.tables.trips.filter(...).concat(newTrips)`. Against a `ColumnTable`
>   Proxy, `.filter()` materialises 2.27 M plain row dicts, silently reverting the whole saving on
>   exactly the national feeds targeted (the Swiss feed ships a non-empty `frequencies.txt`). They
>   land together or 2d is written to preserve the store.
> - **`gtfs/merge.js` is the real cost.** Those three tables are the ones merge namespaces by
>   rewriting row objects. CONTRACT §(b) already records that columnarising `stop_times` forced merge
>   to refuse it explicitly. Budget a week for merge invariants; "reads through an accessor" is not
>   the whole job.

<details>
<summary>Step detail, 2a–2e</summary>

**2a.** `unzip` sorts entries by `cmpStr(a.name, b.name)` and `_s1ParseTables` iterates that order.
`'stop_times.txt' < 'stops.txt'` because `_` (0x5F) precedes `s` (0x73), which is the *only* reason a
clip cannot be done today. Replace the loop with a fixed order:
`stops → stop_times → trips → calendar/calendar_dates → rest`.

**2b.** After `stops.txt`, build a `Uint8Array` in-ring mask over interned stop ids via `pointInRing`.
In `readStopTimes`, skip out-of-ring rows; drop trips left with `<2` rows; keep only referenced
`trip_id`s and `service_id`s. Times are absolute, so surviving rows stay correct. This is exact, not
sampled: the difference between 34.6 M `stop_times` reaching Barcelona and Prague and the subset that
serves Switzerland.

**2c.** `gtfs/feed.js:16-17` states the assumption that breaks: *"every other table is thousands of
rows and stays as plain objects."* Add a `ColumnTable` beside `StopTimes` with a per-table column
spec; expose it behind the lazy row-dict Proxy `tables.stop_times` already uses.

**2d.** Fix `_s1ExpandFrequencies`: reserve once, append expansions at the tail, remove template rows
with one stable in-place filter across the arrays.

**2e.** Give `s1DayMetrics` an option to skip the T90 sample and return `t90Min: null`; have
`inferGameSize` accept a null axis C **only when A, B and D all score 2**, with the shortcut recorded
on the axis and in `sizeInference.note`. Compute hull and diameter first (`gtfs/network.js:762`, no
RAPTOR), then `zoneCover`; only if all three saturate do you skip the ~150 RAPTOR runs of the
discarded first pass (`worker.js:605`, overwritten wholesale at `:621`).

</details>

**Not in Stage 2:**

| Excluded | Why |
|---|---|
| Shrinking the RAPTOR stop universe to served stops | The claim that it preserves answers is false. `s1Footpaths` is built over the whole feed's stop index, so RAPTOR reaches walk-only stops that then appear in `arrivalS` and in the T90 percentile sample. It changes the distribution, against a golden |
| The RAPTOR arena | `raptor()` returns `_s1Parent` and `_s1Round` as live references into its arrays (`gtfs/raptor.js:301-302`), and `worker.js:645-647` and `gtfs/infer.js:292-293` both hold two results at once. Reusing and `.fill()`ing those arrays silently corrupts journeys. It needs a lifetime audit nobody has done |

### Stage 3: Make the Swiss run honest

**3a. OSM at national scale: read admin, refuse the rest.** Here the synthesis disagrees with all
three proposals. Border First wants to bake 33 more categories into coarse density tiers; its own
judge correctly killed that. `DensityHandler` (`tools/osm-world/build.py:1582-1651`) is hand-written
Python whose `node()` understands only `natural=tree`, has **no `relation()` method at all**, and bins
ways by their **first node**. `park`, `water`, `green`, `shop` are all `nwr/` filters with relation
members. It is a planet-pass rewrite, not a `categories.json` edit, and first-node binning would
attribute a national park to whichever 1.1 km cell its first vertex lands in.

What survives at national scale is the **admin ladder**, and it *improves*: 26 cantons vs. one metro,
`matching.admin_1` goes from degenerate to one of the map's strongest questions, and
`nearestOtherLabelM` (`rules/audit.js:449`) is an x-sweep, so the admin-border measuring questions are
cheap in zones. So:

- Guard `worldDensity` (`osm/geodata.js:2084`) on border area; keys stay **absent**, which
  `:2090-2104` already handles correctly (absent-not-zero, with the note machinery).
- Keep `worldAdminAreas` but give `adminAreasAt` (`osm/worldfile.js:996-1024`) a `GridIndex` bbox
  prefilter over area bboxes. The comment at `osm/geodata.js:968-972` claims *"the number of zones
  stops costing anything at all"*: true for the fetch, false for the scan, and national scale is where
  it stops being a rounding error.
- Let every feature category over `CATEGORY_FEATURE_BUDGET` go `partial` → `unknown`
  (`rules/audit.js:335-339`, `:1480-1492`). That machinery is already correct.

**3b. Two scale-broken constants** ([§5](#5-constants-and-thresholds-to-change)). Both produce
plausible wrong answers rather than failing loudly. `REDUNDANT_PAIR_FRACTION` declares any two
categories within ~160 km on a Japan bbox "the same question", and that result is printed on the
page. `synthCoastline`'s shutoff above ~76,000 km² stays (change rejected); the gap is disclosure.

**3c. Recalibrate LARGE, no fourth size.** GUIDE.md:38-39 and :149-153 name Switzerland (~1,800
stations) and Japan (~8,500) as LARGE's own examples; the only higher tier (GUIDE.md:233-245, "Global
Hide and Seek") is continent scale. `rules/audit.js:2068` already sets the `size.name === 'large'` gate
precedent. Changes: the §5 A1, `CAP_ZONES`, A2 and `CAP_UNREACHABLE` rows, all golden-safe.

### Explicitly out of scope

| Out of scope | Why not | Ref |
|---|---|---|
| A fourth rung in `S1_SIZE_PARAMS` | No rulebook warrant | `gtfs/network.js:134-153` |
| Raising `MAX_FEEDS_PER_RUN` | Wrong axis: CH and GB need one pick 15× over the budget the number encodes; Japan needs ~600 | `lib/core.js:80` *(cap since raised to 10; argument unchanged)* |
| Server-side pre-merged national GTFS | Breaks "the feed never leaves the browser"; adds an origin §0 does not sanction | CONTRACT §0 |
| Wiring up the manifest's per-layer bbox | Every layer except `high_speed_rail` is effectively global; a country bbox intersects all of them | — |
| Multi-landmass assembly for `matching.landmass` | Japan-only benefit, in the country this plan cannot serve. The branch returns all-null with *"assembling real landmasses is out of scope"* | `rules/audit.js:668-675` |
| `stopAfter` on `search` | Changes a published number (Correction 2); `search` reads and coalesces a whole level before examining any of it, so the saving is far smaller than claimed | `osm/flatgeobuf.js:872-880` |
| Latitude-banded projection | Real correctness work, but landing it during the memory refactor doubles golden risk for no Swiss gain (±2% at Swiss latitudes) | `lib/geo.js:68` is one `cos(lat0)` for the whole map |

---

## 3. Country by country

| | Switzerland | England / GB | Japan |
|---|---|---|---|
| Catalogue ([§4](#4-catalogue-split-the-one-over-broad-predicate)) | `mdb-2898` "Switzerland Aggregate 2026" | `mdb-2014` "BODS UK aggregate feed", the DfT's all-operators bundle | 608 rows, 570 of them `jbda-` municipal community-bus feeds (verified by count) |
| Modes | National aggregate | **Bus and coach only.** National Rail publishes CIF/Darwin; none of the 41 GB rows is a rail timetable | Zero JR, zero Tokyo Metro, zero major private railway: a data-landscape fact, not a MobilityData curation artifact |
| Raw bbox | South edge is Barcelona Sants' latitude to eight decimals; stops reach Prague. Every hull, diameter, MEC and bbox number today describes Western Europe | Corrupted 48.14248 / 20.96378 edges, shared with `mdb-2900` | — |
| Rings | One: no multipolygon question | Not one (Northern Ireland, the Hebrides) | Archipelago: `matching.landmass` permanently `unknown` (`rules/audit.js:668-675`); `measuring.international_border` structurally dead |
| Projection error | ±2% | About −11% for Scottish stops (note 2) | — |
| OSM-synth rescue | Not needed | **Harmful** (three reasons below) | Drops every Shinkansen at the 360 km cap; survivors modelled at 45 km/h put T90, hub travel and every reachability metric ~6× wrong |

**Note 2.** `Projection.about` (`lib/geo.js:96-102`) is the arithmetic mean of *stops*. For BODS they
cluster in the Midlands, so Scottish stops at 58.7°N are mis-scaled by `cos(58.7)/cos(52.5) ≈ 0.89`,
not the ±5% the second proposal claims. For Switzerland the clipped mean lies inside the country.

### Switzerland: build for this, and only this

The parse-time clip fixes the bbox **exactly**, in the one place that also makes the feed fit.
`mergeFeeds([f]) === f` means a one-feed run pays no merge cost.

**Switzerland is the acceptance test.** If a clipped Swiss run does not complete in a tab with honest
numbers, nothing else here is worth shipping.

### England: ship it as buses, and say so in the hero

**The OSM-synth rail patch, which two of three approaches propose, must not ship.** Three independent
reasons, all verified:

| Reason | Mechanism | Evidence |
|---|---|---|
| Line-length ceiling | `if (windowEndS + duration >= SERVICE_DAY_SECONDS) { droppedTooLong++; continue; }`. With `SYNTH_SERVICE_WINDOW_S = [6*3600, 22*3600]` and `SERVICE_DAY_SECONDS = 30*3600`, any synthesized ride over 8 hours is dropped whole. At `SYNTH_MODE_SPEED_KMH.train = 45` that is a hard **360 km ceiling on line length**. The ECML, WCML and GWML all exceed it and vanish into a counter | `osm/synth.js:699`, `:113-115` |
| Run-level `assumedSchedule` | `metrics.assumedSchedule` is run-level on purpose: *"ONE invented timetable in the merge makes every schedule-derived number in the run assumed"*. Synthesized rail beside a real BODS bus feed drops and renormalises the *bus* timetable's scoring too | `worker.js:628` |
| Timezone | Derived from mean longitude: a GB run gets `Etc/GMT` beside BODS's `Europe/London` and trips the mixed-timezone degradation on every run | `osm/synth.js:784-786` |

England's answer: surface `mdb-2014`, clip it to a GB ring, and print this as a first-class
degradation:

> every registered bus and coach service in Great Britain; National Rail is not in this feed

That is a real, honest product. It is not the England game most readers picture, and the page must not
pretend otherwise.

### Japan: there is no client-side path. Say so, and offer the real game.

The Shinkansen *is* the Japan game, so a report built on synthesized rail would be confidently,
specifically wrong. The landmass and border gaps are properties of the country, not defects to fix.

**The honest Japan product is a Tokyo-area run** from ODPT/Toei picks inside the existing 6-feed cap
*(since raised to 10; argument unchanged)*, rated as the metro map it is. Stages 2 and 3 are sized so
that the day a Japanese national feed appears, the pipeline is ready. Do not build a Japan-shaped
feature in the meantime.

---

## 4. Catalogue: split the one over-broad predicate

*Grafted from Exploit the Feed, its judge's sole "worth stealing."*

`tools/mdb-snapshot.mjs:~621` is a single line:
`if (spanKm(entry.b) > REGIONAL_KM) { entry.r = 1; regional++; }`. It assigns identical `r:1` to a
genuine national aggregate, a cross-border coach operator, and an upstream bbox typo. `corruptReason`
(`:222-233`) caps latitude span at 60° and longitude span at 150°; `mdb-2898`'s spans are 12.2° and
20.9°, so it sails through every check.

**But do not ship the version as designed.** Its own named counterexample defeats it:

| id | c | b | r | What it is |
|---|---|---|---|---|
| `mdb-2898` | `CH` | `[41.37891,-4.47982,53.5526,16.37711]` | `1` | Swiss national aggregate (verified in `data/feeds.json`) |
| `mdb-2014` | `GB` | `[48.14248,-7.54342,60.80896,20.96378]` | `1` | BODS national bus and coach aggregate |
| `mdb-2900` | `GB` | `[48.14248,-5.53222,57.4808,20.96378]` | `1` | "Flixbus GB", an international coach operator with the same corrupted edges |

"Country code matches + bbox overlaps that country ⇒ clip and promote" badges `mdb-2900` as a national
feed. "Clip to the reference box" is circular: whenever the raw box *contains* the country, the
intersection **is** the reference box, so the mitigation is just a hand-typed bbox.

What works instead: a small **curated allowlist by id** (`mdb-2898`, `mdb-2014`) with the corrected
bbox stored alongside, plus a new `nat` flag. Explicit, reviewable as a diff, no inference to get
wrong. `data/feeds.json` stays generated (AGENTS.md forbids hand-patching).

Three things the graft must also handle:

| Path | Promote `nat`? | Why |
|---|---|---|
| Search | **Yes** | `searchCatalog` is deliberately unfiltered: typing "Switzerland" surfaces `mdb-2898` today at tier 2 with an "add anyway" control. What is broken is `centroidOf` (the Swiss marker lands in eastern France), `spanKmOf` in `rowWhere` (`render/landing.js:~169`, printing a ~1,570 km span), and `rowsIntersectingRing` |
| Draw | **No.** Do not exempt `nat` rows from `visibleRows` | `rowsIntersectingRing` exists so dragging a box across a state never silently adds Amtrak. A corrected GB box intersects every shape drawn anywhere in Britain, and a 34.6 M-row feed arrives uninvited |
| Snapshot | Needs an explicit argument | It reverses a documented decision: `tools/mdb-snapshot.mjs:~288-295` records that oversized boxes are dropped rather than repaired precisely because they belonged to national aggregates and were wrong on their face |

---

## 5. Constants and thresholds to change

| Status | Constant | Current | File:line | Change |
|---|---|---|---|---|
| Change | A1 ramp bounds | `ramp(nZones, 15, 60)`, 8 pts | `rules/score.js:313` | Size-key against GUIDE.md:141-151's 30/100/500 floors. MEDIUM bound must be ≤319 to keep the reference at full marks |
| Change | `CAP_ZONES` floor | `n < 30`, cap 40.0 | `rules/score.js:686` | Use the resolved size's floor. Its own `why` at `:689` says *"the rulebook's own SMALL floor of 30 stations"* |
| Owner decision ([§8](#8-decisions-only-the-repo-owner-can-make)) | A2 ramp bounds | `ramp(reachShare, 0.35, 0.85)`, 7 pts | `rules/score.js:320` | LARGE-only re-base |
| Owner decision (§8) | `CAP_UNREACHABLE` | `reach < 0.15`, cap 45.0 | `rules/score.js:716` | Same gate, same decision |
| Change | `REDUNDANT_PAIR_FRACTION` | `0.05` of map diagonal | `osm/geodata.js:240` | Add an absolute cap (~5 km) |
| Rejected 2026-08-26 | `synthCoastline` threshold | `Math.max(mapArea, COAST_MIN_AREA_SQM)` | `osm/geodata.js:1797` (`COAST_MIN_AREA_SQM = 25e6` at `:561`) | ~~Becomes `min(mapArea, cap)`~~ (note 3) |
| Leave alone | `CATEGORY_FEATURE_BUDGET` | `40000` | `osm/geodata.js:237` | Changing it changes what "counted" means. The `layersRead` fix is the real repair |
| Change | `SEEKER_SAMPLE_CAP` / `SURV_FULL_UNIVERSE_MAX` | `200` / `400` | `lib/core.js:49-50` | Keep the cap; **print the sampling ratio** in the provenance section. At ~12k zones it is a ~1.7% draw where it was ~50% on the reference feed |
| Unchanged | `MAX_FEEDS_PER_RUN` | `6` (since raised to `10`) | `lib/core.js:80` | Add `MAX_STOP_TIMES_PER_RUN` as a post-clip row budget with a named remedy |
| Unchanged | `T90_ORIGIN_STRIDE` | `30` | `lib/core.js:45` | `gtfs/network.js:828-833` already caps at ~50 origins whatever the feed size, with a comment saying why |
| Unchanged | `SYNTH_MODE_SPEED_KMH.train` | `45` | `osm/synth.js:113-115` | It implies the 360 km line-length ceiling at `:699`. Document that, don't tune it |

**Note 3.** Above ~76,000 km² no water body on Earth exceeds the map area, so the great-lake-shore
synthesis switches itself off. That shutoff is the stated semantics: "larger than the game map" is the
test, and the constant is a *floor* under that relative test, not a ceiling candidate; a cap would keep
synthesizing shore for lakes the map dwarfs. The real, separate gap is honesty: the page never says
"the map is bigger than every lake". Beyond that, area is a proxy for containment: a strip-shaped
border along a great lake's shore suppresses the synthesis without containing the lake.

---

## 6. CONTRACT.md amendments

*Section lines re-measured 2026-08-27, after the game-border amendments; every line number in this
section moved: §0 Ground rules 22 · §(a) Module map 40 · §(b) Data shapes 148 · §(c) Options 1065 ·
§(d) worker protocol 1147 · §(f) degradation policy 1521.*

| # | CONTRACT § | Amendment | Status |
|---|---|---|---|
| 1 | §(c), lines 1124-1133 | Argue the clip ring as a *source*, not a run setting, riding the sentence already there: *"there the ring IS the source, the same category as a `File`'s bytes."* A deliberate amendment, not a reinterpretation | Owner decision ([§8](#8-decisions-only-the-repo-owner-can-make) 1) |
| 2 | §(b) `Feed` | New `Feed.clip` record: ring `stableHash` and how many stops, trips, stop_times and calendar rows were dropped. A clipped feed is a different feed | Open |
| 3 | §(b) `Feed` | The `tables.stop_times` lazy-Proxy exception generalises to a named set. The note that the view has zero readers ("the precondition for ever deleting it") must be rewritten: it becomes load-bearing for three more tables | Open |
| 4 | §(b) `Border` | `kind` gains a third value, or the ring stays a *clip input* and the presented border remains a bbox | Owner decision (§8 3) |
| 5 | §(b) `TravelTimes` | `raptor()` returns typed arrays + `stopIndex`, not a string-keyed object | Open |
| 6 | §(b) `SizeInference` | Axis C flags a one-origin value decided by A, B and D. Carry the three-line proof and a unit test over `c ∈ {0,1,2}` | Open |
| 7 | §(f) | Two new rules: (a) the feed was clipped before parsing, counts describe the clipped feed; (b) above X km² the density grid is refused, not read, and refusals are notes. Both in the same family as rule 3's third state | Open |
| 8 | §(f) rule 6 | Exceeding the post-clip row budget is fatal, with a named remedy | Open |
| 9 | §(b) `Border` | `trimmedStopIds` documented but absent from `gtfs/infer.js:358-365` | **Closed 2026-08-27** toward the typedef ([Correction 1](#1-corrections-to-the-ground-truth)) |

`rules/catalogue.js` `INTERPRETATIONS` (the frozen `{id, affects, text}` array at ~463-618) needs
three new rows and one conditioned row. An unlabelled retune must not happen.

| Row | Kind | Status |
|---|---|---|
| Country-border clip | New | Owed |
| Through-service truncation at the ring | New | Owed |
| LARGE A2 re-base | New | Owed |
| `map_border_derivation` (~470-473) | Conditioned | Partly done 2026-08-27: `byDerivation` mechanism and `option` sentence landed; country-clip sentence owed |

`map_border_derivation` said the border is the bbox of in-map stops padded by one zone radius, which
is false on a clipped run, so it must be conditioned, not merely supplemented. It is now conditioned on
`Border.derivation` through a frozen `byDerivation` map, not a callback, which `buildProvenance`
selects. Its `byDerivation.option` sentence covers a reader-supplied box; the country-clip sentence
uses the same mechanism.

---

## 7. The honesty ceiling nobody can engineer around

With the density grid refused and most feature categories over budget, a Swiss run drops a large share
of the OSM-backed points. If more than 40% of the 100 go unavailable, `Fitness.score` is `null` and
the country verdict reads "Partly measurable" (§(f) rule 2). That is honest, and it may be the
*expected* outcome: the IR axis alone is 30 points and it needs `zoneInventory`, which needs `pois`,
which a counted-not-fetched category never sets.

This is not a reason not to ship. It is the [§2 gate](#2-what-ships-staged): **Stage 0 measures the
surviving denominator on a real clipped Swiss run before anyone promises a score or designs Stage 3.**

---

## 8. Decisions only the repo owner can make

| # | Decision | Blocks |
|---|---|---|
| 1 | Does a clip ring belong in `Options`? | Stage 2b, §6 item 1 |
| 2 | Can a country's `Fitness.score` be `null`? | Stage 3 |
| 3 | `Border.kind`: a third value, or a bbox that lies? | §6 item 4 |
| 4 | Is A2 at LARGE a rulebook expectation or a city-scale interpretation? **Either way it needs a disclosed `INTERPRETATIONS` row** | §5 A2 and `CAP_UNREACHABLE` rows |
| 5 | Is "Great Britain, buses only" a product you want to ship? Saying no is a legitimate answer | England |
| 6 | Does `data/borders.json` (or equivalent) count against §0's asset allowlist? | The clip-ring asset |

<details>
<summary>The argument for each decision</summary>

1. §(c):1029 forbids a ring field and then sanctions one *as a source*. A clip ring genuinely redefines
   what the feed is, but it is your rule and your call. The alternative (ship the ring as a same-origin
   repo asset the worker resolves from a `countryCode`) respects the letter while making the asset list
   grow.
2. If "Partly measurable" is an acceptable country verdict, ship Stage 3 as written. If not, the 40%
   rule needs a size-gated exemption, which is a rules change with no rulebook warrant and should not
   be made quietly.
3. A country ring that clips the feed but is presented as a padded bbox is defensible (the bbox of a
   clipped Swiss feed *is* Switzerland-shaped) and cheap. A `kind: 'country'` polygon is correct and
   touches every bbox-assuming consumer in the renderer and the audit.
4. `reachability_one_way` (`rules/catalogue.js:~571-575`) already asserts the rulebook's constraint is
   one-way and hider-only. If you accept that reading, A2's 0.35/0.85 ramp and `CAP_UNREACHABLE`'s 0.15
   are ours, not the rulebook's, and a national map with 25% reachability is legitimate rather than
   capped at 45. If you don't, they stay and countries score badly for a property nobody asked about.
   An unlabelled retune is the one thing that must not happen.
5. Honest and real, but not the England game.
6. §0's own note says `data/feeds.json` is a same-origin repo asset and not a sixth external one, so
   precedent says no, but the §0 "Known divergence" line about `DEFAULT_WORLD_BASE_URL` becomes harder
   to leave as-is once a national run's *counts* come from the bucket.

</details>

---

## 9. If you only do one thing

Ship [Stage 1](#stage-1-free-wins): 1.5 days, six changes, no contract amendment or golden risk, and
every one helps Grand Rapids and Chicago today. It fixes the `layersRead` bug that tells players the
map files were unreachable when they were merely large. Then pass the [§2 gate](#2-what-ships-staged)
before committing to anything in Stage 3.

---

## 10. Provenance and what is not verified

Confirmed by hand before the workflow ran: `MAX_FEEDS_PER_RUN = 6` at `lib/core.js:80` and its three
enforcement sites (`render/landing.js` `PICK_CAP`, `app.js:1007`, `worker.js:261`); the
module layout; GUIDE.md:159 and :239 on country and global scale.

Everything else is agent output, including the synthesis's claim that it opened the files and
corrected its scouts in four places. The `mdb-2898` / `mdb-2014` / `mdb-2900` bbox values were quoted
by two independent agents from `data/feeds.json`. Open the file before acting on any item.

The workflow journal, with all 17 agents' full return values (four scout reports, three complete
designs, nine judge verdicts), is at:

```
~/.claude/projects/-home-lu-Projects-jltg-hide-and-seek/<session>/subagents/workflows/wf_d1b7cb13-cf3/journal.jsonl
```
