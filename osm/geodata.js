/**
 * osm/geodata.js — S2 · GEO, the OSM semantic layer.
 *
 * Port of generate.py lines 4454–6356 (everything in S2 except the raw transport,
 * which lives in ./overpass.js). WORKER SIDE ONLY — no DOM, no window, no document.
 *
 * NO NETWORK SERVICE IS CALLED FROM HERE ANY MORE. This module used to be a client of
 * two shared free services — Overpass for features and Nominatim for the place name —
 * with mirror failover, ≤0.1° tiling fallbacks and 3 s courtesy sleeps, because
 * etiquette was a hard requirement rather than a nicety. Both are gone. Every feature,
 * count and administrative boundary now comes from the prebuilt world files
 * (`./worldfile.js`), which are immutable, rate-limit-free, and read with HTTP Range
 * requests against an R2 bucket.
 *
 * The GEO_CATEGORIES selectors below are still Overpass QL, and stay that way: they are
 * the DEFINITION of each category, they are printed verbatim in provenance so a player
 * can re-run one, and `tools/osm-world/categories.json` is a mechanical translation of
 * them that has to be checkable against something.
 *
 * Budget on the reference map: ~10 requests, ~40 MB, once, then cached. Every
 * round-trip is announced through `onProgress(done, total, label)` because the user
 * is watching a bar.
 *
 * Everything below is deterministic: no wall clock reaches a return value, every
 * dict/set is iterated through a sort, every tie-break ends in a stable OSM id, and
 * every cache key is the fully-substituted request text.
 *
 * DEGRADATION IS A FIRST-CLASS PATH, NOT AN ERROR PATH, and there are two of them.
 * They are different states and must be reported separately, never conflated:
 *
 *   1. The whole OSM layer failed. `collectGeodata` throws only from the one-request
 *      category count audit; the caller answers with `emptyGeoData(bbox, note)` —
 *      `available: false`, empty containers, one honesty note — and the run
 *      continues with every OSM-backed score dropped from the denominator and a
 *      banner on the page. See CONTRACT.md §(f).
 *
 *   2. Only the "within 10 ft of a routable path" join failed or was skipped. The
 *      pages are complete and every count is real; what is lost is one refinement,
 *      so every candidate hiding spot comes back `verify: true` at half weight, the
 *      `legal-spot-path-filter` provenance row is `partial`, and a note says so.
 *      `available` stays `true`. This is NOT case 1 and must not read like it.
 *
 * Everything between those two — a category missing from the manifest, an unreadable
 * layer, an unreadable density grid, an unreadable admin layer — degrades in place with
 * a warning and a `partial` provenance row.
 */

import {
  num, pct, quantile,
} from '../lib/core.js';
import {
  Projection, GridIndex, haversineM, bboxExpand, bboxContains,
  polygonArea, pointInRing, segPointDist, ringWithin,
} from '../lib/geo.js';
import {
  worldPois, worldCount, worldDensity, worldAdminAreas, adminAreasAt,
  worldLayerInfo, worldProvenance,
} from './worldfile.js';

// ═══════════════════════════════════════════════════════════════════════════════
// The category catalogue — DATA. Do not summarise, do not drop the obscure ones.
// ═══════════════════════════════════════════════════════════════════════════════
//
// One rulebook feature category and the exact selector that realises it.
//
// `selector` is Overpass QL with `{{bbox}}` unsubstituted; it is printed verbatim
// next to every count on the page so a player can re-run it.
//
// The category table is the S1/S2/S3 interface: S2 fetches it, S3 asks questions of
// it, S4 prints the selectors. Counts in the comments are the measured reference
// values, kept as a regression anchor.

/**
 * @typedef {Object} GeoCategory
 * @property {string} key
 * @property {string} label
 * @property {string} selector
 * @property {string} note
 */

/** @returns {GeoCategory} */
function cat(key, label, selector, opts = {}) {
  return Object.freeze({
    key,
    label,
    selector,
    note: opts.note !== undefined ? opts.note : '',
  });
}

/** @type {ReadonlyArray<GeoCategory>} */
export const GEO_CATEGORIES = Object.freeze([
  cat('park', 'Park',
    'nwr["leisure"="park"]["name"]({{bbox}});', {
      note: 'Not garden/nature_reserve/recreation_ground — a map app gives those different icons.',
    }),  // 214
  cat('museum', 'Museum', 'nwr["tourism"="museum"]["name"]({{bbox}});'),  // 10
  cat('movie_theater', 'Movie theater', 'nwr["amenity"="cinema"]["name"]({{bbox}});'),  // 7
  cat('hospital', 'Hospital', 'nwr["amenity"="hospital"]["name"]({{bbox}});', {
    note: 'Excludes amenity=clinic and amenity=doctors — including them is a 7× overcount.',
  }),  // 6
  cat('library', 'Library', 'nwr["amenity"="library"]["name"]({{bbox}});', {
    note: 'Excludes amenity=public_bookcase (Little Free Libraries).',
  }),  // 21
  cat('zoo', 'Zoo', 'nwr["tourism"="zoo"]({{bbox}});'),  // 1
  cat('aquarium', 'Aquarium', 'nwr["tourism"="aquarium"]({{bbox}});'),  // 1
  cat('amusement_park', 'Amusement park', 'nwr["tourism"="theme_park"]({{bbox}});', {
    note: 'Excludes leisure=water_park and amusement_arcade.',
  }),  // 1
  cat('golf_course', 'Golf course',
    'nwr["leisure"="golf_course"]["golf"!="driving_range"]["name"]({{bbox}});', {
      note: 'The rulebook explicitly excludes mini golf and driving ranges.',
    }),  // 18
  cat('foreign_consulate', 'Foreign consulate',
    'nwr["office"="diplomatic"]["diplomatic"~"^(consulate|consulate_general)$"]'
    + '["consulate"!="honorary"]({{bbox}});', {
      note: 'Honorary consulates are excluded by the rulebook.',
    }),  // 0
  cat('commercial_airport', 'Commercial airport',
    'nwr["aeroway"="aerodrome"]["iata"]({{bbox}});', {
      note: "The iata filter is what makes it 'commercial'; without it, private grass strips count.",
    }),  // 1
  cat('mountain', 'Mountain', 'node["natural"~"^(peak|volcano)$"]["name"]({{bbox}});'),  // 0
  cat('rail_station', 'Rail station', 'nwr["railway"~"^(station|halt)$"]({{bbox}});', {
    note: 'Unioned with GTFS stops on rail route types.',
  }),  // 1
  cat('high_speed_rail', 'High-speed rail line',
    'way["railway"="rail"]["highspeed"="yes"]({{bbox}});', {
      note: "Fallback: parse maxspeed ≥ 200 km/h, accepting '200', '200 km/h' and '125 mph'.",
    }),  // 0
  cat('water', 'Body of water',
    'nwr["natural"="water"]["name"]["water"!~"^(pool|reflecting_pool)$"]'
    + '["leisure"!="swimming_pool"]({{bbox}});'
    + 'way["waterway"~"^(river|canal)$"]["name"]({{bbox}});', {
      note: 'The name filter is the measuring question\'s own wording — "any named body of '
        + 'water on your maps app, excluding pools": 999 water features exist, 75 are named. '
        + 'It belongs to THIS question only. Curse of the Water Weight says "marked", not '
        + '"named", and has its own unnamed predicate in CURSE_PREDICATE_SELECTORS.',
    }),  // 75+48
  cat('coastline', 'Coastline', 'way["natural"="coastline"]({{bbox}});', {
    note: 'OSM tags ocean/sea only, so shore segments are also derived from any '
      + 'water body larger than the game map — a great-lake shore is a coast.',
  }),  // 0 tagged
  cat('street', 'Street or path',
    'way["highway"]["highway"!~"^(motorway|motorway_link|trunk_link|construction|proposed|raceway)$"]'
    + '({{bbox}});', {
      note: 'Dissolved by name per connected component; unnamed ways split at intersections.',
    }),  // 14,246 named
  cat('restaurant', 'Restaurant', 'nwr["amenity"="restaurant"]({{bbox}});'),  // 368
  cat('grocery', 'Grocery store',
    'nwr["shop"~"^(supermarket|greengrocer|convenience|grocery|farm)$"]({{bbox}});'),  // 233
  cat('place_of_worship', 'Place of worship', 'nwr["amenity"="place_of_worship"]({{bbox}});'),  // 227
  cat('toilets', 'Public toilets', 'nwr["amenity"="toilets"]({{bbox}});'),  // 81
  cat('cafe', 'Cafe', 'nwr["amenity"="cafe"]({{bbox}});'),  // 90
  cat('fast_food', 'Fast food', 'nwr["amenity"="fast_food"]({{bbox}});'),
  cat('bench', 'Bench', 'node["amenity"="bench"]({{bbox}});'),  // 241
  cat('shelter', 'Shelter', 'nwr["amenity"="shelter"]({{bbox}});'),
  cat('platform', 'Train platform',
    'nwr["railway"="platform"]({{bbox}});nwr["public_transport"="platform"]({{bbox}});'),
  cat('tree', 'Tree', 'node["natural"="tree"]({{bbox}});'),  // 2,675
  cat('building', 'Building', 'way["building"]({{bbox}});', {
    note: 'Fetched with `out center qt` — id and one point each, ~8 MB not ~120 MB.',
  }),  // 134,962
  cat('green', 'Green landuse',
    'nwr["landuse"~"^(forest|grass|meadow|village_green|recreation_ground)$"]({{bbox}});'),  // 640
  cat('pitch', 'Pitch / playground',
    'nwr["leisure"~"^(pitch|playground|recreation_ground|garden|nature_reserve)$"]({{bbox}});'),  // 1,559
  cat('footpath', 'Footpath',
    'way["highway"~"^(footway|path|pedestrian|steps|cycleway|track)$"]({{bbox}});'),  // 30,827
  cat('bridge', 'Bridge',
    'way["bridge"]["bridge"!="no"]["highway"]({{bbox}});'
    + 'way["bridge"]["bridge"!="no"]["railway"]({{bbox}});', {
      note: 'The Bridge Troll card defines a bridge as "any elevated structure, acting as a '
        + 'path, road or railway" — so railway bridges are in, and covered bridges are not '
        + 'filtered out. Kept identical to the `bridge` curse predicate.',
    }),  // >1,026 (1,026 was the road-only, uncovered count)
  cat('car_street', 'Motor-vehicle street', '', { note: 'See CAR_STREET_SELECTOR.' }),  // 54,693
  cat('shop', 'Shop', 'nwr["shop"]({{bbox}});'),  // 1,220
  cat('advertising', 'Advertising', 'nwr["advertising"]({{bbox}});', {
    note: 'OSM barely maps billboards — a low count is not evidence of scarcity.',
  }),  // 22
  cat('newsagent', 'Print source',
    'nwr["shop"~"^(newsagent|books|kiosk|stationery)$"]({{bbox}});'),  // 23
]);

// One constant, three consumers (Right Turn, Luxury Car, street density) — so they
// can never disagree about what a street is.
export const CAR_STREET_SELECTOR =
  'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|'
  + 'living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]'
  + '["motor_vehicle"!="no"]["access"!="no"]({{bbox}});';

// Foot-routable graph for the "within 10 ft of a marked path" legality test.
export const FOOT_WAY_SELECTOR =
  'way["highway"]["highway"!~"^(motorway|motorway_link|trunk|trunk_link)$"]'
  + '["foot"!~"^(no|private)$"]["access"!~"^(no|private)$"]({{bbox}});';

// Street View coverage — a static country table, NOT an OSM query. The rulebook
// names Germany explicitly; this is the low-coverage set the Unguided Tourist curse
// is removed for. (Python frozenset ⇒ a frozen SORTED array here; use `.includes`.)
export const LOW_STREETVIEW_COUNTRIES = Object.freeze(
  ['at', 'ba', 'by', 'cn', 'de', 'in', 'lt'],
);

// ── tuning constants (S2-local) ───────────────────────────────────────────────
//
// VESTIGIAL, the Overpass ones. This module now reads the prebuilt world files
// (`./worldfile.js`) and issues no Overpass query at all, so every constant below that
// describes a request budget — the QL timeout, the tiling degree, the two legal-path
// timeouts — no longer governs anything here. They are kept because the selectors and
// the budgets are still the DEFINITION of each category and each refinement, they are
// printed in provenance, and `tools/osm-world/categories.json` is a translation of them
// that has to be checkable against something. Do not tune them expecting an effect.

          // ≤0.1° squares when a single-shot fetch fails
export const CATEGORY_FEATURE_BUDGET = 40000;  // above this, a category is counted but not fetched
                // zone centres per batched is_in request
export const LEGAL_SPOTS_PER_ZONE = 40;        // cap on the per-zone shortlist (page size guard)
export const TOILET_WIDE_FACTOR = 1.5;         // A1's "just outside the circle" fallback ring
export const REDUNDANT_PAIR_FRACTION = 0.05;   // 1/20 of the map diagonal (specs/osm.md §7.4)
          // OSM analogue of the rulebook's 10 ft
// …and one attempt per mirror, not two
// Buffering every walkable way by 5 m is the most expensive thing this program can ask
// a shared free service to do. Measured on the reference bbox (84,466 non-motorway
// highway ways) it timed out on all three mirrors, twice, costing 7½ minutes for an
// optional refinement. So it is only attempted on maps whose walkable network is small
// enough for the join to be cheap; above the budget the test is skipped and every
// candidate spot is honestly marked verify-on-the-ground.
export const LEGAL_PATH_JOIN_WAY_BUDGET = 40000;
export const SPOT_VERIFY_WEIGHT = 0.5;         // restrictive opening_hours ⇒ half weight

// Fetched with `out center qt` — a pure density tally, the one place where the
// bbox centre is acceptable (specs/osm.md §3.1).
export const GEO_DENSITY_ONLY = Object.freeze(['building']);

// ── the world-file layer map ─────────────────────────────────────────────────
//
// Every category above is answered by one of exactly three things now, and which one
// it is decides how honest its number can be:
//
//   a FEATURE layer   real geometry, exact count, usable for distance and containment
//   the DENSITY grid  a per-cell tally, exact map-wide, APPROXIMATE per zone
//   nothing           absent from the build, so the category degrades
//
// `GEO_DENSITY_GRID_CATEGORIES` is the second set. It is the same list as the density
// layers in tools/osm-world/categories.json, and the two must agree: a key here that
// the build does not produce silently becomes a zero, which reads as "this map has no
// streets" rather than as a missing layer.
export const GEO_DENSITY_GRID_CATEGORIES = Object.freeze(
  ['bridge', 'building', 'car_street', 'footpath', 'street', 'tree'],
);

// `curse_animal_habitat` was the second-largest layer in the build and almost all of
// it was a copy of `green`, which every build already ships. It is no longer built;
// its count is reconstructed from a partition identity instead (PLAN.md §Phase 1 R2).
//
// The identity is exact, and it is exact because `landuse` is single-valued. Writing
// the two selectors out:
//
//   green                = landuse ∈ {forest, grass, meadow, village_green,
//                                     recreation_ground}
//   curse_animal_habitat = landuse ∈ {forest, grass, meadow, village_green}
//                          ∪ leisure ∈ {park, nature_reserve}
//                          ∪ (natural = water ∧ name)
//
// No feature carries two `landuse` values, so `green` minus its `recreation_ground`
// members is precisely the first line of the habitat selector — not an estimate of it
// — and `animal_delta` is built to be exactly the remaining two lines with the
// `landuse` members already removed, so the three terms never double-count a feature.
//
// Counting is per-feature over unchanged envelopes: `worldCount` walks an R-tree of
// bounding boxes, and a feature's bbox is the same bbox whichever of these layers it
// was written into. So the sum is the same upper bound the deleted layer would have
// returned, bit for bit — including the deliberate over-count of a feature whose bbox
// clips the map while its geometry does not, which is what makes a zero here safe to
// act on (see `curseCounts`).
//
// Order is load-bearing for term 0: `curseLayerCount` treats the FIRST term as the
// base layer — the superset the later terms carve pieces out of. A base absent from
// the manifest refuses the whole expression; a later term absent counts as 0 (unless
// the manifest is marked partial). The correction terms after the base may be
// reordered freely; the base must stay first.
export const CURSE_ANIMAL_HABITAT_TERMS = Object.freeze([
  Object.freeze([1, 'green']),
  Object.freeze([-1, 'green_recreation_ground']),
  Object.freeze([1, 'animal_delta']),
]);

// Curse predicates whose selector is NOT the same as the same-named category's, so
// they ship as their own world-file layer. `water` is the one that matters: the curse
// says "marked", the category says "named", and they differ by 8:1 on a real map.
// Everything absent from this map is answered either by a category layer of the same
// name or by the density grid — see `curseCounts`.
//
// The third element, where present, is a FALLBACK EXPRESSION: a signed sum of other
// layers that equals the named layer's count exactly, used only when the build did
// not ship the named layer. See `CURSE_ANIMAL_HABITAT_TERMS`.
export const CURSE_WORLD_LAYERS = Object.freeze([
  Object.freeze(['water', 'curse_water']),
  Object.freeze(['cairn_terrain', 'curse_cairn_terrain']),
  Object.freeze(['travel_agent_stop', 'curse_travel_agent_stop']),
  Object.freeze(['animal_habitat', 'curse_animal_habitat', CURSE_ANIMAL_HABITAT_TERMS]),
]);

// Curse predicates that are exactly a category layer already fetched, and the ones the
// density grid answers. Split out so `curseCounts` never has to guess which is which.
export const CURSE_FROM_CATEGORY = Object.freeze(
  ['grocery', 'shop', 'print_source', 'tumble_ground'],
);
export const CURSE_FROM_DENSITY = Object.freeze(['bridge', 'car_street', 'building']);

// `print_source` and `tumble_ground` are the curse names for categories the catalogue
// calls something else.
export const CURSE_CATEGORY_ALIASES = Object.freeze({
  print_source: 'newsagent',
  tumble_ground: 'pitch',
});

// Rings are kept only where a containment test is actually asked for. The photo
// questions ask "is the hider standing in a park", the matching/measuring ones ask
// about the icon; the two predicates must never be interchanged.
//
// `commercial_airport` was in this list and is not any more. Its rings were built,
// projected and indexed on every run and then read by nothing: `zoneInventory`'s
// `polygonHits` is the only consumer of a non-`park`, non-`water` ring, and the only
// key `rules/score.js` ever reads out of it is `park` (score.js 1068, 1088 — a
// containment test for a bathroom and for shelter). `legalEndgameSpots` uses rings
// only for `LEGAL_SPOT_CATEGORIES`, which does not list airports; `iconOffsetP90` is
// called on `pois.park` alone; `synthCoastline` on `pois.water` alone; and nothing in
// `render/` ever reads `poi.rings` at all. Dropping the key changes no published
// number: `featuresToPois` computes the representative point, the area and the
// node-swallowed-by-area dedup from its own planar copy of the outers
// (`worldfile.js:524-586`), independently of `keepRings`.
export const RING_CATEGORIES = Object.freeze(['park', 'water']);

// ═══════════════════════════════════════════════════════════════════════════════
// LEGAL SPOT HEURISTICS — THE EDITABLE TABLE
// ═══════════════════════════════════════════════════════════════════════════════
//
// AGENTS.md flags this as the weakest hand-written judgement in the codebase. It is
// deliberately kept here, in one block, rather than scattered through
// `legalEndgameSpots`, so a human can argue with it in one place. Ported as-is —
// resist the urge to "improve" it while porting; change it on purpose or not at all.

// Categories that can supply a candidate endgame spot, with the weight the spot
// starts at. Restricted to categories this pipeline already fetches, so the
// shortlist costs no extra request. `true` = the feature is an enclosure when it is
// an area (park interior, playground, pitch), `false` = a point on the street.
// Shape: [categoryKey, weight, enclosing]
export const LEGAL_SPOT_CATEGORIES = Object.freeze([
  Object.freeze(['park', 1.0, true]),
  Object.freeze(['pitch', 1.0, true]),
  Object.freeze(['green', 0.5, true]),      // a grass verge is a place to stand, not a destination
  Object.freeze(['bench', 1.0, false]),
  Object.freeze(['shelter', 1.0, false]),
  Object.freeze(['platform', 0.75, false]),
  Object.freeze(['library', 0.75, false]),
  Object.freeze(['place_of_worship', 0.5, false]),
  Object.freeze(['toilets', 0.75, false]),
]);

// Access values that make a feature unusable as a hiding spot.
export const PRIVATE_ACCESS = Object.freeze(
  ['customers', 'delivery', 'military', 'no', 'permit', 'private'],
);

// The tag keys consulted for public accessibility, in order.
export const SPOT_ACCESS_TAG_KEYS = Object.freeze(['access', 'foot', 'entry']);

// `opening_hours` values that count as "open during all game hours". Anything else
// is demoted to verify-on-the-ground at half weight rather than dropped, because
// OSM does not know whether a plaza is locked at night. An ABSENT tag counts as
// open — that is the surprise, and it is deliberate: most benches carry no hours.
export const SPOT_ALL_HOURS_VALUES = Object.freeze(['24/7', 'Mo-Su 00:00-24:00']);

// ═══════════════════════════════════════════════════════════════════════════════
// Curse predicates
// ═══════════════════════════════════════════════════════════════════════════════

// Curse predicates that are decided by an OSM count. Everything else — Unguided
// Tourist (a static Street View country table) and U-Turn (GTFS route overlap) —
// is decided elsewhere and deliberately absent from this table.
export const CURSE_PREDICATE_SELECTORS = Object.freeze([
  // "'Bridge' is defined as any elevated structure, acting as a path, road or railway,
  // intended to be crossed by pedestrians, cars, or other vehicles" (Bridge Troll). So
  // the ["highway"] clause cannot be mandatory — railway bridges are named outright —
  // and covered bridges are not excluded: the card cares that it is crossable, not that
  // it is open to the sky. Two statements because Overpass cannot OR across two keys in
  // one; the surrounding union deduplicates a way carrying both.
  Object.freeze(['bridge',
    'way["bridge"]["bridge"!="no"]["highway"]({{bbox}});'
    + 'way["bridge"]["bridge"!="no"]["railway"]({{bbox}});']),
  // "'Body of water' within this context does not necessarily mean natural, but it
  // cannot be a pool and must be large enough to be marked on the map" (Water Weight).
  // MARKED, not named — so no ["name"] filter here. The named form belongs to the
  // *measuring* question ("any named body of water on your maps app"), which is the
  // GEO_CATEGORIES `water` category; the two are kept apart on purpose because they
  // differ by 8:1 and one drifted into the other once already. "Not necessarily
  // natural" pulls in reservoirs and basins. "Large enough to be marked" has no tag
  // that expresses it, so it is approximated by "OSM marks it at all" — the honest
  // reading, and the looser one, which is the right direction for a REMOVAL test.
  Object.freeze(['water',
    'nwr["natural"="water"]["water"!~"^(pool|reflecting_pool)$"]'
    + '["leisure"!="swimming_pool"]({{bbox}});'
    + 'nwr["landuse"~"^(reservoir|basin)$"]({{bbox}});'
    + 'way["waterway"~"^(river|canal)$"]({{bbox}});']),
  Object.freeze(['car_street', CAR_STREET_SELECTOR]),
  Object.freeze(['grocery',
    'nwr["shop"~"^(supermarket|greengrocer|convenience|grocery|farm)$"]({{bbox}});']),
  Object.freeze(['shop', 'nwr["shop"]({{bbox}});']),
  Object.freeze(['cairn_terrain', 'nwr["natural"~"^(scree|bare_rock|beach|shingle|wood)$"]({{bbox}});']),
  Object.freeze(['print_source', 'nwr["shop"~"^(newsagent|books|kiosk|stationery)$"]({{bbox}});']),
  Object.freeze(['tumble_ground',
    'nwr["leisure"~"^(pitch|playground|recreation_ground|garden|nature_reserve)$"]({{bbox}});']),
  Object.freeze(['building', 'way["building"]({{bbox}});']),
  Object.freeze(['travel_agent_stop',
    'nwr["leisure"~"^(park|garden|playground)$"]({{bbox}});'
    + 'nwr["amenity"~"^(library|place_of_worship|marketplace|townhall)$"]({{bbox}});'
    + 'way["highway"="pedestrian"]({{bbox}});']),
  Object.freeze(['animal_habitat',
    'nwr["leisure"~"^(park|nature_reserve)$"]({{bbox}});'
    + 'nwr["landuse"~"^(forest|grass|meadow|village_green)$"]({{bbox}});'
    + 'nwr["natural"="water"]["name"]({{bbox}});']),
]);

// curse id → predicate key above. A curse absent from this map is decided by GTFS
// or by a static table, never by silence.
export const CURSE_PREDICATE_MAP = Object.freeze([
  Object.freeze(['bridge_troll', 'bridge']),
  Object.freeze(['water_weight', 'water']),
  Object.freeze(['right_turn', 'car_street']),
  Object.freeze(['luxury_car', 'car_street']),
  Object.freeze(['lemon_phylactery', 'grocery']),
  Object.freeze(['egg_partner', 'grocery']),
  Object.freeze(['impressionable_consumer', 'shop']),
  Object.freeze(['cairn', 'cairn_terrain']),
  Object.freeze(['ransom_note', 'print_source']),
  Object.freeze(['endless_tumble', 'tumble_ground']),
  Object.freeze(['jammed_door', 'building']),
  Object.freeze(['mediocre_travel_agent', 'travel_agent_stop']),
  Object.freeze(['zoologist', 'animal_habitat']),
  Object.freeze(['bird_guide', 'animal_habitat']),
]);

// ── cuisine → ISO-3166-1 alpha-2 ──────────────────────────────────────────────
// Adjective tokens ONLY. Promoting a dish to a country is a judgement call that
// changes the count, so dishes and super-national regions are rejected and the
// rejected tokens are reported so a player can override.

export const CUISINE_COUNTRY = Object.freeze({
  afghan: 'AF', albanian: 'AL', algerian: 'DZ', american: 'US', argentinian: 'AR',
  argentine: 'AR', armenian: 'AM', australian: 'AU', austrian: 'AT', bangladeshi: 'BD',
  basque: 'ES', belgian: 'BE', bolivian: 'BO', bosnian: 'BA', brazilian: 'BR',
  british: 'GB', bulgarian: 'BG', cambodian: 'KH', canadian: 'CA', chilean: 'CL',
  chinese: 'CN', colombian: 'CO', croatian: 'HR', cuban: 'CU', czech: 'CZ',
  danish: 'DK', dominican: 'DO', dutch: 'NL', ecuadorian: 'EC', egyptian: 'EG',
  english: 'GB', eritrean: 'ER', estonian: 'EE', ethiopian: 'ET', filipino: 'PH',
  finnish: 'FI', french: 'FR', georgian: 'GE', german: 'DE', ghanaian: 'GH',
  greek: 'GR', guatemalan: 'GT', haitian: 'HT', hawaiian: 'US', honduran: 'HN',
  hungarian: 'HU', icelandic: 'IS', indian: 'IN', indonesian: 'ID', iranian: 'IR',
  persian: 'IR', iraqi: 'IQ', irish: 'IE', israeli: 'IL', italian: 'IT',
  jamaican: 'JM', japanese: 'JP', jordanian: 'JO', kenyan: 'KE', korean: 'KR',
  laotian: 'LA', lao: 'LA', lebanese: 'LB', malaysian: 'MY', mexican: 'MX',
  moroccan: 'MA', nepalese: 'NP', nepali: 'NP', nigerian: 'NG', norwegian: 'NO',
  pakistani: 'PK', palestinian: 'PS', peruvian: 'PE', polish: 'PL', portuguese: 'PT',
  puerto_rican: 'PR', romanian: 'RO', russian: 'RU', salvadoran: 'SV', scottish: 'GB',
  senegalese: 'SN', serbian: 'RS', singaporean: 'SG', slovak: 'SK', slovenian: 'SI',
  somali: 'SO', spanish: 'ES', sri_lankan: 'LK', sudanese: 'SD', swedish: 'SE',
  swiss: 'CH', syrian: 'SY', taiwanese: 'TW', thai: 'TH', tibetan: 'CN',
  tunisian: 'TN', turkish: 'TR', ukrainian: 'UA', uruguayan: 'UY', venezuelan: 'VE',
  vietnamese: 'VN', welsh: 'GB', yemeni: 'YE',
});

// The two reject lists below are DESCRIPTIVE, exactly as in the Python: nothing reads
// them. `cuisineDetail` rejects by absence from CUISINE_COUNTRY, so these enumerate
// what that absence is *meant* to catch and are there to be argued with.
export const CUISINE_REJECT_REGIONAL = Object.freeze([
  'african', 'american_chinese', 'arab', 'asian', 'balkan', 'baltic', 'caribbean',
  'central_american', 'central_asian', 'eastern_european', 'european', 'fusion',
  'international', 'latin', 'latin_american', 'mediterranean', 'middle_eastern',
  'nordic', 'oriental', 'regional', 'scandinavian', 'south_american', 'southern',
  'southwestern', 'tex-mex', 'western',
]);

export const CUISINE_REJECT_DISH = Object.freeze([
  'bagel', 'bakery', 'barbecue', 'bbq', 'beef_bowl', 'breakfast', 'brunch', 'buffet',
  'burger', 'cake', 'chicken', 'coffee_shop', 'crepe', 'curry', 'deli', 'dessert',
  'diner', 'donut', 'doughnut', 'dumpling', 'empanada', 'fine_dining', 'fish',
  'fish_and_chips', 'friture', 'frozen_yogurt', 'gyro', 'hot_dog', 'ice_cream',
  'juice', 'kebab', 'noodle', 'pancake', 'pasta', 'pastry', 'pho', 'pie', 'pizza',
  'poke', 'pretzel', 'ramen', 'rice', 'salad', 'sandwich', 'sausage', 'seafood',
  'shawarma', 'smoothie', 'soup', 'steak_house', 'sushi', 'taco', 'tapas', 'tea',
  'teppanyaki', 'vegan', 'vegetarian', 'waffle', 'wings', 'wrap',
]);

// ── administrative ladders that are not simply "the next level that exists" ────
// Small and explicit, per specs/osm.md §6.3 step 5. A null entry means "this
// country has no such division"; a level absent from the map resolves to null too.
export const ADMIN_ORDINAL_OVERRIDES = Object.freeze({
  fr: Object.freeze([4, 6, 8, 9]),      // région / département / commune (7 = arrondissement is skipped)
  de: Object.freeze([4, 6, 8, 9]),      // Land / Kreis / Gemeinde / Stadtbezirk (5 = Regierungsbezirk skipped)
  gb: Object.freeze([4, 6, 8, 10]),     // constituent country / county / district / civil parish
  jp: Object.freeze([4, 7, 8, null]),   // prefecture / municipality / ward
  cn: Object.freeze([4, 6, 7, 8]),      // province / prefecture-city / county / township
  it: Object.freeze([4, 6, 8, 9]),      // regione / provincia / comune / circoscrizione
});

// The same ladder judgements for a world whose `admin` layer was built from Overture
// divisions (manifest `admin_source: 'overture'`, PLAN.md Phase 2). Overture has no
// `admin_level`; the build synthesises one per subtype — country=2, dependency=3,
// region=4, county=6, localadmin=7, locality=8, macrohood=9, neighborhood=10 — and
// stamps ISO3166-1 only on levels 2–3 and ISO3166-2 only on level 4. The numbers
// deliberately echo OSM's, but they do NOT mean the same thing (jp municipalities
// land on 6, not 7; fr communes have no arrondissement level to skip), so the OSM
// table above must never be consulted for an overture world and vice versa. A country
// absent here takes the generic path, which for overture always anchors at level 4.
export const OVERTURE_ADMIN_ORDINAL_OVERRIDES = Object.freeze({
  fr: Object.freeze([4, 6, 8, 10]),     // region / department / commune / neighbourhood
  it: Object.freeze([4, 6, 8, 10]),     // regione / provincia / comune / neighbourhood
  jp: Object.freeze([4, 6, 8, null]),   // prefecture / municipality / ward
  de: Object.freeze([4, 6, 8, 9]),      // Land / Kreis / Gemeinde / Stadtbezirk
  gb: Object.freeze([4, 6, 8, 10]),     // constituent country / county / district / parish
  cn: Object.freeze([4, 6, 7, 8]),      // province / prefecture-city / county / township
});

// A water body larger than the game map behaves exactly like a coast: its shore is
// the edge of the playable world. OSM reserves `natural=coastline` for ocean and sea,
// so a Great Lakes or inland-sea map would otherwise report "no coastline" — which is
// true of the tagging and false of the geography. House ruling: a great-lake shore is
// a coast.
//
// The shore is emitted as many short segments rather than one whole-lake feature,
// because that is how `natural=coastline` itself is modelled and everything
// downstream depends on it: the in-border filter and the measuring questions both
// work off a feature's representative point, and Lake Michigan's centroid is ~100 km
// offshore and outside the map entirely.
export const COAST_SEGMENT_PTS = 12;      // ring points per synthesised shore segment
export const COAST_MAX_SEGMENTS = 600;    // hard cap; a whole sea coast must not swamp the page
export const COAST_BBOX_PAD_M = 2000.0;   // keep shore just outside the border — it still bounds the map
export const COAST_MIN_AREA_SQM = 25e6;   // 25 km²: floor, so a tiny map cannot promote a pond to a sea

// ═══════════════════════════════════════════════════════════════════════════════
// Small deterministic helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Plain code-point string comparator. Never `localeCompare` (locale = non-determinism). */
function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/** Python tuple comparison for `(osmType, osmId)` — string then NUMBER. */
function cmpTypeId(a, b) {
  return cmpStr(a.osmType, b.osmType) || (a.osmId - b.osmId);
}

/** Python tuple comparison for `(category, osmType, osmId)`. */
function cmpCatTypeId(a, b) {
  return cmpStr(a.category, b.category) || cmpStr(a.osmType, b.osmType) || (a.osmId - b.osmId);
}

/**
 * The grid/lookup key for one POI. Python uses the tuple
 * `(category, osm_type, osm_id)`; `GridIndex` sorts by `String(key)`, and only
 * *sets* of keys are ever consumed, so a delimited string is equivalent. Every
 * ordering that matters is re-derived from the parts, never from the string.
 */
function poiKey(poi) { return `${poi.category}\u001f${poi.osmType}\u001f${poi.osmId}`; }

/** Inverse of `poiKey` — the three tuple parts, for the final tie-break sorts. */
function splitKey(key) {
  const i = key.indexOf('\u001f');
  const j = key.indexOf('\u001f', i + 1);
  return [key.slice(0, i), key.slice(i + 1, j), Number(key.slice(j + 1))];
}

/** Overpass bbox literal — (S, W, N, E), fixed 6 dp so the cache key is stable. */
function ovBbox(bbox) {
  return bbox.map((v) => v.toFixed(6)).join(',');
}

/** Substitute `{{bbox}}` in a selector. */
function ovSub(selector, bbox) {
  return selector.split('{{bbox}}').join(ovBbox(bbox));
}

/** The selector for a category, resolving the ones that live in a shared constant. */
function ovSelector(category) {
  if (category.key === 'car_street') return CAR_STREET_SELECTOR;
  return category.selector;
}

/** `GEO_CATEGORIES` as a key → category map (`_geo_categories`, line 4880). */
export function geoCategories() {
  const out = new Map();
  for (const c of GEO_CATEGORIES) out.set(c.key, c);
  return out;
}

function keepRingsFor(key) { return RING_CATEGORIES.includes(key); }
function keepTagsFor(key) { return !GEO_DENSITY_ONLY.includes(key); }

/** Project a geographic ring (`[lat, lon]` pairs) into planar metres. */
function planarRing(ring, proj) {
  return ring.map((p) => proj.xy(p[0], p[1]));
}

/** `math.dist` over two planar points. */
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

// `Math.min(...arr)` blows the argument limit somewhere north of 65k elements, and
// one Great Lake ring is bigger than that. Loop instead — everywhere, so no caller
// has to remember which arrays are small.
function minOf(values) {
  let m = Infinity;
  for (const v of values) if (v < m) m = v;
  return m;
}

function maxOf(values) {
  let m = -Infinity;
  for (const v of values) if (v > m) m = v;
  return m;
}

/**
 * Progress bookkeeping around every Overpass round-trip. `total` is an estimate and
 * MAY GROW as tiling and per-category fallbacks discover more work — the worker
 * protocol explicitly allows that.
 */
class Progress {
  constructor(cb, total) {
    this._cb = typeof cb === 'function' ? cb : () => {};
    this.done = 0;
    this.total = total;
    this._label = '';
  }

  grow(n) { this.total += n; this._cb(this.done, this.total, this._label); }

  start(label) { this._label = label; this._cb(this.done, this.total, label); }

  finish() {
    this.done += 1;
    if (this.done > this.total) this.total = this.done;
    this._cb(this.done, this.total, this._label);
  }

  /** Retire the estimate: whatever was skipped never happens, so the bar completes. */
  settle(label) {
    this.total = this.done;
    this._label = label !== undefined ? label : this._label;
    this._cb(this.done, this.total, this._label);
  }
}

function noopLog() {}

// ═══════════════════════════════════════════════════════════════════════════════
// Overpass statement splitting and the one-request count audit
// ═══════════════════════════════════════════════════════════════════════════════





// ═══════════════════════════════════════════════════════════════════════════════
// Category fetching
// ═══════════════════════════════════════════════════════════════════════════════




// ═══════════════════════════════════════════════════════════════════════════════
// Spatial index and the two zone predicates
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Index a POI set for radius queries at the zone radius. See `GridIndex`.
 * (generate.py `build_poi_index`, line 5307)
 * @param {Array<Object>} pois @param {Projection} proj @param {number} radiusM
 * @returns {GridIndex}
 */
export function buildPoiIndex(pois, proj, radiusM) {
  const index = new GridIndex(Math.max(1.0, radiusM));
  for (const poi of Array.from(pois).sort(cmpCatTypeId)) {
    const [x, y] = proj.xy(poi.lat, poi.lon);
    index.add(poiKey(poi), x, y);
  }
  return index;
}

/**
 * Grid of *area* features by bounding box, plus the linear-scan overflow list.
 * (generate.py `_area_index`, line 5316)
 *
 * A feature is inserted into every cell its bbox touches, so a query only has to
 * read the 3×3 neighbourhood; anything spanning more than `GridIndex.addBbox`'s cap
 * (one statewide multipolygon) goes into the overflow list instead of blowing up the
 * index.
 *
 * @returns {[GridIndex, Array<Object>, Map<string, Object>]}
 */
function areaIndex(pois, proj, radiusM) {
  const index = new GridIndex(Math.max(1.0, radiusM));
  const overflow = [];
  const lookup = new Map();
  for (const poi of Array.from(pois).sort(cmpCatTypeId)) {
    if (!poi.rings || !poi.rings.length) continue;
    const key = poiKey(poi);
    lookup.set(key, poi);
    const xs = [];
    const ys = [];
    for (const ring of poi.rings) {
      for (const p of ring) {
        const [x, y] = proj.xy(p[0], p[1]);
        xs.push(x);
        ys.push(y);
      }
    }
    if (!xs.length) continue;
    if (!index.addBbox(key, minOf(xs), minOf(ys), maxOf(xs), maxOf(ys))) {
      overflow.push(poi);
    }
  }
  return [index, overflow, lookup];
}

/** (generate.py `_rings_planar`, line 5347) */
function ringsPlanar(poi, proj) {
  return (poi.rings || []).map((ring) => planarRing(ring, proj));
}

/**
 * Count, per zone, how many features of each category fall inside the circle.
 * (generate.py `zone_inventory`, line 5351)
 *
 * Returns `[iconCounts, polygonHits]`. **Two different predicates**: icon counts ask
 * whether the representative point is inside the disc (what matching and measuring
 * questions measure to); polygon hits ask whether the feature's ring intersects the
 * disc (what the photo questions mean by "stand in a park"). On the reference feed
 * parks are 28.5% by icon and 45.5% by polygon. Never substitute one for the other.
 *
 * @param {Array<Object>} zones
 * @param {Object<string, Array<Object>>} pois
 * @param {Projection} proj
 * @param {number} radiusM
 * @returns {[Object<string, Object<string, number>>, Object<string, Object<string, boolean>>]}
 */
export function zoneInventory(zones, pois, proj, radiusM) {
  const categories = Object.keys(pois).sort(cmpStr);
  const flat = [];
  // NOT `flat.push(...pois[key])`: spread passes every element as a call argument
  // and blows the stack somewhere north of 65k. `building` alone is 88k features on
  // the reference bbox, so this threw `RangeError: Maximum call stack size exceeded`
  // and took the whole OSM layer down. Same reason as `minOf`/`maxOf` above.
  for (const key of categories) {
    const rows = pois[key];
    for (let i = 0; i < rows.length; i++) flat.push(rows[i]);
  }
  const index = buildPoiIndex(flat, proj, radiusM);

  const ringPois = flat.filter((p) => p.rings && p.rings.length);
  const [areaGrid, areaOverflow, areaLookup] = areaIndex(ringPois, proj, radiusM);
  const ringCategories = Array.from(new Set(ringPois.map((p) => p.category))).sort(cmpStr);
  /** @type {Map<string, Array<Array<[number, number]>>>} */
  const planarCache = new Map();

  const wideCategories = ['toilets'];
  const wideIndex = buildPoiIndex(
    flat.filter((p) => wideCategories.includes(p.category)), proj, radiusM * TOILET_WIDE_FACTOR,
  );

  const iconCounts = {};
  const polygonHits = {};
  for (const zone of Array.from(zones).sort((a, b) => cmpStr(a.zoneId, b.zoneId))) {
    const counts = {};
    for (const key of categories) counts[key] = 0;
    for (const key of index.nearKeys(zone.x, zone.y, radiusM)) {
      counts[splitKey(key)[0]] += 1;
    }
    if (Object.prototype.hasOwnProperty.call(counts, 'toilets')) {
      counts.toilets_wide = wideIndex
        .nearKeys(zone.x, zone.y, radiusM * TOILET_WIDE_FACTOR).length;
    }
    iconCounts[zone.zoneId] = counts;

    const hits = {};
    for (const key of ringCategories) hits[key] = false;
    const candidates = areaGrid.nearKeys(zone.x, zone.y, Infinity).map((k) => areaLookup.get(k));
    for (const poi of candidates.concat(areaOverflow)) {
      if (hits[poi.category]) continue;
      const key = poiKey(poi);
      let rings = planarCache.get(key);
      if (rings === undefined) {
        rings = ringsPlanar(poi, proj);
        planarCache.set(key, rings);
      }
      if (rings.some((ring) => ringWithin([zone.x, zone.y], ring, radiusM))) {
        hits[poi.category] = true;
      }
    }
    polygonHits[zone.zoneId] = hits;
  }
  return [iconCounts, polygonHits];
}





/** (generate.py `_admin_level`, line 5489) */
function adminLevel(tags) {
  const value = tags.admin_level !== undefined ? tags.admin_level : '';
  // Python's str.isdigit(): non-empty and every character a digit.
  if (value !== '' && /^\d+$/.test(value)) return parseInt(value, 10);
  return null;
}


/**
 * Resolve the 1st–4th administrative divisions for this map.
 * (generate.py `resolve_admin`, line 5509 — exported as `adminInfo` per CONTRACT.md)
 *
 * Two Overpass forms are needed because they answer two different rulebook questions
 * and they disagree: containment (`is_in`, batched) answers the *matching* questions,
 * boundary crossing (`relation[boundary=administrative]` inside the bbox) answers the
 * *border measuring* questions. A bbox query returns only divisions whose boundary
 * crosses the box, so the containing state and country are simply absent from it —
 * correct for "does a border cross the map", catastrophically wrong for "which state
 * am I in".
 *
 * Ordinals 2–4 come from the distinct levels present across *all* zone centres, not
 * one probe point. Never guess an `admin_level`.
 *
 * @returns {Promise<Object>} AdminInfo
 */
export async function adminInfo(world, zones, bbox, hooks = {}) {
  const progress = hooks.progress || new Progress(null, 0);
  const log = hooks.log || noopLog;

  const ordered = Array.from(zones).sort((a, b) => cmpStr(a.zoneId, b.zoneId));

  // The admin layer replaces batched Overpass `is_in`, and the shape of the work
  // changes completely. `is_in` cost one request per 150 zone centres and could not be
  // cached usefully, because the batch key changed whenever the zone set did. Here the
  // administrative areas overlapping the map are fetched ONCE and every zone centre is
  // tested against them locally, so the number of zones stops costing anything at all.
  /** @type {Array<Object>} */
  let areas = [];
  progress.start('geo:world admin areas');
  try {
    areas = (await worldAdminAreas(world, bbox)) || [];
  } catch (exc) {
    // Admin questions degrade to `unknown`; they never abort the run.
    log('warn', `admin containment lookup failed: ${exc}`);
    areas = [];
  } finally {
    progress.finish();
  }

  // The containing areas per zone, kept as AREA objects too: the country census below
  // needs to know WHICH polygon contained a zone, not just its synthesized tags.
  const perPointAreas = ordered.map((zone) => adminAreasAt(areas, zone.lat, zone.lon));

  // One entry per zone, in zone order, shaped exactly like the `is_in` tag objects the
  // rest of this function already consumes — so everything below is untouched.
  // `name:en` is carried through where the build has it, because the ladder reads
  // `tags['name:en'] || tags.name` and a multilingual country's bare `name` is the
  // slash-joined native form ("Schweiz/Suisse/Svizzera/Svizra").
  const perPoint = perPointAreas.map((zoneAreas) => zoneAreas
    .map((area) => {
      /** @type {Object<string, string>} */
      const tags = { boundary: 'administrative', admin_level: String(area.level) };
      if (area.name) tags.name = area.name;
      if (area.nameEn) tags['name:en'] = area.nameEn;
      if (area.iso1) tags['ISO3166-1'] = area.iso1;
      if (area.iso2) tags['ISO3166-2'] = area.iso2;
      return tags;
    }));

  // ── country identity and the first-division level, from the layer itself ──
  //
  // These used to come from a Nominatim reverse geocode, with the OSM tags as the free
  // fallback when Nominatim was unreachable. The fallback is now the only path, and it
  // is derived from EVERY area overlapping the map rather than only from the areas that
  // happen to contain a zone centre — which makes it strictly more robust than the
  // fallback ever was, and no worse than Nominatim on the one thing Nominatim was
  // genuinely better at.
  //
  // That thing was `ISO3166-2-lvl<N>`: Nominatim reports, as a property of the COUNTRY,
  // which OSM `admin_level` holds its first administrative division. That anchors the
  // ordinal ladder for every country absent from `ADMIN_ORDINAL_OVERRIDES`. The local
  // equivalent is to observe which level actually carries an `ISO3166-2` code, because
  // ISO 3166-2 is by definition the code of a country's principal subdivision. Same
  // fact, read off the polygons instead of asked for.
  let iso2Level = null;
  for (const area of areas) {
    // Lowest level carrying an ISO3166-2 code wins: a country's principal subdivision
    // is the shallowest thing that has one.
    if (area.iso2 && (iso2Level === null || area.level < iso2Level)) iso2Level = area.level;
  }

  // Country identity. `areas` is sorted (level, name), and "first area carrying
  // ISO3166-1" — the old rule — resolves a border-straddling map alphabetically: a
  // Basel map touching de/ch/fr answered 'de' whatever the game was actually in. The
  // country is instead the ISO3166-1 polygon CONTAINING the most zone centres, with
  // the (level, name)-order rule kept as the tie-break and as the fallback when no
  // zone centre sits in any country polygon — so a single-country map, and a map
  // with no zones at all, answer exactly as they did before.
  /** @type {Map<Object, number>} AdminArea (object identity) → zone centres inside */
  const countryTally = new Map();
  for (const zoneAreas of perPointAreas) {
    for (const area of zoneAreas) {
      if (area.iso1) countryTally.set(area, (countryTally.get(area) || 0) + 1);
    }
  }
  let countryArea = null;
  let countryZones = -1;
  for (const area of areas) {
    if (!area.iso1) continue;
    const inside = countryTally.get(area) || 0;
    if (inside > countryZones) {
      countryArea = area;
      countryZones = inside;
    }
  }
  if (countryArea !== null && countryTally.size > 1) {
    log('info', `country ${JSON.stringify(countryArea.iso1)} by zone census `
      + `(${countryZones} zone centres; ${countryTally.size} countries touch the map)`);
  }
  const iso1Country = countryArea === null ? null : countryArea.iso1.toLowerCase();
  // Same `name:en` preference the ladder applies — "Switzerland", not the
  // slash-joined native form.
  const countryName = countryArea === null ? null
    : (countryArea.nameEn || countryArea.name || null);

  // Per-zone {admin_level: name}, plus the map-wide level census.
  /** @type {Map<string, Map<number, string>>} */
  const perZoneLevels = new Map();
  const levelsPresent = new Set();
  const pairs = Math.min(ordered.length, perPoint.length);
  for (let i = 0; i < pairs; i++) {
    const zone = ordered[i];
    const ladder = new Map();
    for (const tags of perPoint[i]) {
      if (tags.boundary !== 'administrative') continue;
      const level = adminLevel(tags);
      const name = tags['name:en'] || tags.name || '';
      if (level === null || !name) continue;
      ladder.set(level, name);
      levelsPresent.add(level);
    }
    perZoneLevels.set(zone.zoneId, ladder);
  }

  // Country identity, entirely from the admin layer. `source` is now one value where
  // it used to be two ('nominatim' / 'is_in'); `'unknown'` still means what it always
  // meant — no administrative data at all — which is the only value `render/deck.js`
  // actually branches on.
  let countryCode = iso1Country;
  let placeName = null;
  let source = 'unknown';
  if (countryCode !== null || perZoneLevels.size) source = 'world';

  // Ordinal ladder. Derived, never guessed. Which override table applies is a
  // property of the WORLD, not the country: an overture-built admin layer uses
  // synthetic levels that only look like OSM's (see the table's comment), so the
  // manifest's `admin_source` picks the table. Absent or 'osm' is today's behavior.
  const adminSource = String(
    (world && world.manifest && world.manifest.admin_source) || 'osm',
  );
  const overrideTable = adminSource === 'overture'
    ? OVERTURE_ADMIN_ORDINAL_OVERRIDES : ADMIN_ORDINAL_OVERRIDES;
  const first = iso2Level;
  /** @type {Object<string, number|null>} */
  const ordinals = { 1: null, 2: null, 3: null, 4: null };
  const override = overrideTable[countryCode || ''];
  if (override) {
    for (let i = 0; i < override.length; i++) {
      const level = override[i];
      ordinals[i + 1] = (level !== null && levelsPresent.has(level)) ? level : null;
    }
    if (ordinals[1] === null && first !== null && levelsPresent.has(first)) ordinals[1] = first;
  } else if (first !== null) {
    ordinals[1] = first;
    const rest = Array.from(levelsPresent).filter((lv) => lv > first).sort((a, b) => a - b);
    for (let i = 0; i < 3 && i < rest.length; i++) ordinals[i + 2] = rest[i];
  }

  // Zone → ordinal → division name.
  /** @type {Object<string, Object<string, string>>} */
  const perZone = {};
  for (const zoneId of Array.from(perZoneLevels.keys()).sort(cmpStr)) {
    const ladder = perZoneLevels.get(zoneId);
    const entry = {};
    for (const ordinal of [1, 2, 3, 4]) {
      const level = ordinals[ordinal];
      if (level !== null && level !== undefined && ladder.has(level)) {
        entry[ordinal] = ladder.get(level);
      }
    }
    perZone[zoneId] = entry;
  }

  // The place name is the municipality that contains the most zone centres, not the
  // one under the bbox centre: the centre of a bounding box is a geometric artefact
  // and on the reference feed it lands in a suburb (Wyoming, MI) while 171 of 393
  // zones sit in Grand Rapids. This was already the source and Nominatim was already
  // the fallback, so dropping Nominatim leaves the normal path untouched — it only
  // changes what happens on a map with no zones at all, handled below.
  //
  // Go as specific as the data allows, then take the division containing the most
  // zone centres *within that ordinal*. Ranking candidates by raw zone count across
  // ordinals does not work: a broader division always wins on count, which named the
  // Grand Rapids map "Kent County" (317 of 319).
  //
  // Which ordinal holds "the municipality" is not fixed, even across US states.
  // Michigan puts cities at ordinal 3 and has no ordinal 4. Illinois puts historic
  // civil townships at 3 and the city at 4, so reading ordinal 3 named the CTA map
  // "Lake Township" (265 of 1,204) when ordinal 4 held "Chicago" (1,070). Taking the
  // deepest populated ordinal gets both right.
  const zoneIds = Object.keys(perZone).sort(cmpStr);
  if (zoneIds.length) {
    for (const ordinal of [4, 3, 2]) {
      /** @type {Map<string, number>} */
      const tally = new Map();
      for (const zoneId of zoneIds) {
        const name = perZone[zoneId][ordinal];
        if (name) tally.set(name, (tally.get(name) || 0) + 1);
      }
      if (!tally.size) continue;
      const best = Array.from(tally.entries())
        .sort((a, b) => (b[1] - a[1]) || cmpStr(a[0], b[0]))[0];
      [placeName] = best;
      log('info', `place name ${JSON.stringify(placeName)} from ordinal ${ordinal} `
        + `(${best[1]} of ${zoneIds.length} zones, ${tally.size} divisions there)`);
      break;
    }
  }
  if (placeName === null) {
    // No zones, or no named division containing any of them — the one case where
    // Nominatim used to answer. The local equivalent is the deepest administrative area
    // covering the middle of the map: a geometric artefact, and worse than the census
    // above, but it is the same kind of answer Nominatim gave and it needs no network.
    const [s, w, n, e] = bbox;
    const covering = adminAreasAt(areas, (s + n) / 2.0, (w + e) / 2.0)
      .filter((area) => area.name)
      .sort((a, b) => b.level - a.level || cmpStr(a.name, b.name));
    if (covering.length) {
      placeName = covering[0].name;
      log('info', `place name ${JSON.stringify(placeName)} from the admin area at the `
        + `map centre (level ${covering[0].level}); no zone census was available`);
    }
  }

  // Does a boundary LINE cross the map? Ordinal 0 is the international border.
  const wanted = [[0, 2]];
  for (const ordinal of [1, 2, 3, 4]) {
    const level = ordinals[ordinal];
    if (level !== null && level !== undefined) wanted.push([ordinal, level]);
  }
  /** @type {Object<string, boolean>} */
  const borderLevels = {};
  // Answered off the `areas` already in hand, at no further cost. The question is
  // whether a boundary LINE crosses the map, and the local test for that is whether
  // more than one area exists at that level — two adjacent areas at one level means the
  // seam between them runs through the map. An area whose boundary merely surrounds the
  // whole map does not count, and there is exactly one of those per level.
  //
  // A DIVERGENCE from the Overpass form, and a deliberate one. `way(r.a)({{bbox}})`
  // asked whether any member way of such a relation lies in the bbox, which is the
  // sharper question; this asks whether the map spans a division at that level. The two
  // agree except when a map sits entirely inside one division and clips the outer edge
  // of its parent, where this says no and Overpass said yes.
  for (const [ordinal, level] of wanted) {
    const atLevel = areas.filter((area) => area.level === level);
    borderLevels[ordinal] = atLevel.length > 1;
  }

  return {
    countryCode,
    countryName,
    placeName,
    ordinals,
    perZone,
    borderLevels,
    source,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Curse predicates and cuisines
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * One curse predicate's count: the layer if the build shipped it, otherwise the
 * fallback expression.
 *
 * The order is deliberate and is the whole backward-compatibility story. A world
 * built before PLAN.md §Phase 1 R2 — and every fixture world, and any world a reader
 * points the app at by hand — still carries `curse_animal_habitat`, and for those the
 * layer is read directly and no arithmetic happens at all. The expression is reached
 * only when the named layer is genuinely absent from the manifest, which is the new
 * build's signature. The two agree by construction, so which branch ran is invisible
 * in the number; it is not invisible in the log, on purpose.
 *
 * A missing layer is never an exception: `worldCount` returns null for anything the
 * manifest does not list. But "not in the manifest" means two different things for
 * the two kinds of term, because `tools/osm-world/build.py` OMITS a layer whose
 * selector matched nothing in the region rather than shipping an empty file:
 *
 *   - The FIRST term is the base layer (`green` in the one live expression), a
 *     superset the others carve pieces out of. If it is absent AND the region has
 *     features the expression should count, the total would be wrong in the
 *     direction that removes a curse — so an absent base is a refusal, and the
 *     predicate goes unanswered. Unanswerable is the safe end: the curse stays in
 *     the deck instead of being removed on the strength of an incomplete total.
 *
 *   - A LATER term absent from the manifest is the empty-layer case: a region with
 *     zero `landuse=recreation_ground` gets no `green_recreation_ground` layer at
 *     all, and treating that as null used to null the whole expression — deleting
 *     the animal-habitat predicates from exactly the regions where they were
 *     answerable. An absent correction term counts as 0, with an info line saying
 *     so.
 *
 * A path-less manifest entry (`merge.py` writes `{"features": 0}` for a layer that is
 * legitimately empty everywhere) never reaches either bullet: `worldCount` answers 0
 * for it directly, a genuine zero, so no term is "absent" and no arithmetic is skipped.
 *
 * The absent-as-zero reading is only sound for a FULL build, which omits nothing but
 * genuinely-empty layers. A `--only` run of build.py or merge.py ships a manifest that
 * is green while missing layers the region does have, and marks itself with
 * `"partial": true` at the manifest top level. On such a manifest an absent term means
 * "not built", not "empty", so the expression refuses (warn log) instead of fabricating
 * a total that is wrong in the direction that removes a curse.
 *
 * @param {Object} world
 * @param {string} layer the layer the build used to ship
 * @param {ReadonlyArray<readonly [number, string]>|undefined} terms signed fallback sum
 * @param {[number, number, number, number]} bbox
 * @param {function(string, string): void} log
 * @param {string} predicate for the log line only
 * @returns {Promise<number|null>} null when neither the layer nor the expression exists
 */
async function curseLayerCount(world, layer, terms, bbox, log, predicate) {
  const direct = await worldCount(world, layer, bbox);
  if (direct !== null) return direct;
  if (!terms || !terms.length) {
    log('warn', `curse predicate ${predicate}: no ${layer} layer in the manifest`);
    return null;
  }

  let total = 0;
  const absentAsZero = [];
  for (let i = 0; i < terms.length; i++) {
    const [sign, key] = terms[i];
    const part = await worldCount(world, key, bbox);
    if (part === null) {
      // The base layer (term 0) missing means the expression cannot be trusted;
      // a later term missing means the build had nothing to put in it. See the
      // doc comment above — the split is what keeps a recreation-ground-free
      // region from losing an answerable predicate.
      if (i === 0) {
        log('warn', `curse predicate ${predicate}: no ${layer} layer in the manifest, and `
          + `the ${terms.map(([, k]) => k).join(' / ')} substitute needs ${key}, which is `
          + 'not there either');
        return null;
      }
      if (world.manifest && world.manifest.partial === true) {
        // A --only build: the manifest is marked partial, so an absent term means
        // "not built in this run", not "empty region", and zeroing it would fabricate
        // a total. See the doc comment above.
        log('warn', `curse predicate ${predicate}: ${key} is absent from a PARTIAL `
          + 'manifest (a --only build), where absence means not built rather than '
          + 'empty — the predicate is left unanswered rather than zeroed');
        return null;
      }
      absentAsZero.push(key);
      continue;
    }
    total += sign * part;
  }
  if (absentAsZero.length) {
    log('info', `curse predicate ${predicate}: ${absentAsZero.join(', ')} not in this `
      + 'build — the build omits a layer whose selector matched nothing, so counted as 0');
  }
  // Cannot happen while the layers are the ones this identity was derived over — a
  // subtracted layer is a strict subset of the layer it is subtracted from, over the
  // same envelopes. It CAN happen if a build ships mismatched layers, and a negative
  // count published as a curse total would be a lie in the direction that removes a
  // curse. Refuse to answer instead.
  if (total < 0) {
    log('warn', `curse predicate ${predicate}: the substitute for ${layer} summed to `
      + `${total}, which means the layers it reads do not partition each other; the `
      + 'predicate is left unanswered rather than guessed at');
    return null;
  }
  log('info', `curse predicate ${predicate}: ${layer} is not in this build, counted as `
    + `${terms.map(([s, k]) => `${s < 0 ? '−' : '+'}${k}`).join(' ')} = ${total}`);
  return total;
}

/**
 * Evaluate every OSM-decided curse predicate in one `out count` request.
 * (generate.py `curse_predicates`, line 5687 — exported as `curseCounts`)
 *
 * Returns `curseId → count`. Removal is `count === 0` for the hard tier; the warn
 * tier is reported with its count and never auto-removed. Two predicates are *not*
 * OSM: Unguided Tourist (the static Street View country table) and U-Turn (GTFS
 * route overlap and wait times) — those are decided elsewhere and must not be
 * invented here.
 */
export async function curseCounts(world, bbox, geo, hooks = {}) {
  const progress = hooks.progress || new Progress(null, 0);
  const log = hooks.log || noopLog;
  const counts = {};

  // Each predicate is answered by whichever of the three sources actually defines it,
  // and the split is data (`CURSE_WORLD_LAYERS`, `CURSE_FROM_CATEGORY`,
  // `CURSE_FROM_DENSITY`) rather than a chain of special cases. The one that must not
  // be got wrong is `water`: the curse says "marked", the `water` CATEGORY says
  // "named", and they differ by 8:1 — so it reads `curse_water`, its own layer, and
  // never `counts.water`.
  /** @type {Object<string, number>} */
  const raw = {};

  progress.start('geo:world curse predicates');
  try {
    for (const [predicate, layer, terms] of CURSE_WORLD_LAYERS) {
      // An upper bound is the right tool here: these are removal tests of the form
      // "is there none of this on the map", and the only value that has to be exact is
      // zero. A bounding box that clips the map without its feature entering can turn
      // a 0 into a 1, which fails SAFE — the curse stays in play rather than being
      // removed on a technicality.
      const count = await curseLayerCount(world, layer, terms, bbox, log, predicate);
      if (count !== null) raw[predicate] = count;
    }
  } catch (exc) {
    // The curse audit degrades, it never aborts.
    log('warn', `curse predicate audit failed: ${exc}`);
  } finally {
    progress.finish();
  }

  // Predicates that are exactly a category already fetched — no extra read at all.
  for (const predicate of CURSE_FROM_CATEGORY) {
    const category = CURSE_CATEGORY_ALIASES[predicate] || predicate;
    if (Object.prototype.hasOwnProperty.call(geo.counts, category)) {
      raw[predicate] = geo.counts[category];
    }
  }
  // Predicates the density grid answers. Map-wide grid totals are exact, which is
  // exactly the property a removal test needs.
  for (const predicate of CURSE_FROM_DENSITY) {
    if (Object.prototype.hasOwnProperty.call(geo.counts, predicate)) {
      raw[predicate] = geo.counts[predicate];
    }
  }

  for (const [curseId, predicate] of Array.from(CURSE_PREDICATE_MAP)
    .sort((a, b) => cmpStr(a[0], b[0]) || cmpStr(a[1], b[1]))) {
    if (Object.prototype.hasOwnProperty.call(raw, predicate)) counts[curseId] = raw[predicate];
  }
  // Distant Cuisine is decided by tag *content*, not by a count: it is the number of
  // restaurants serving a single identifiable foreign country's cuisine.
  if (Object.prototype.hasOwnProperty.call(geo.pois, 'restaurant')) {
    const restaurants = geo.pois.restaurant;
    const host = ((geo.admin.countryCode || '').toUpperCase()) || null;
    counts.distant_cuisine = cuisineDetail(restaurants, host).qualifying;
  }
  return counts;
}

/** (generate.py `_cuisine_tokens`, line 5717) */
function cuisineTokens(poi) {
  const raw = (poi.tags && poi.tags.cuisine !== undefined) ? poi.tags.cuisine : '';
  return raw.split(';')
    .filter((t) => t.trim() !== '')
    .map((t) => t.trim().toLowerCase().split(' ').join('_'));
}

/**
 * (generate.py `_cuisine_detail`, line 5722)
 * `{perCountry, qualifying, tagged, total, rejected}` — the Python 5-tuple.
 */
function cuisineDetail(restaurants, hostCountry) {
  /** @type {Object<string, number>} */
  const perCountry = {};
  let qualifying = 0;
  let tagged = 0;
  const rejected = new Set();
  const host = (hostCountry || '').toUpperCase();
  for (const poi of Array.from(restaurants).sort(cmpTypeId)) {
    const tokens = cuisineTokens(poi);
    if (!tokens.length) continue;
    tagged += 1;
    const hits = new Set();
    for (const token of tokens) {
      const code = Object.prototype.hasOwnProperty.call(CUISINE_COUNTRY, token)
        ? CUISINE_COUNTRY[token] : undefined;
      if (code === undefined) { rejected.add(token); continue; }
      if (code === host) continue;
      hits.add(code);
    }
    if (hits.size) {
      qualifying += 1;
      for (const code of Array.from(hits).sort(cmpStr)) {
        perCountry[code] = (perCountry[code] || 0) + 1;
      }
    }
  }
  return {
    perCountry,
    qualifying,
    tagged,
    total: restaurants.length,
    rejected: Array.from(rejected).sort(cmpStr),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Candidate legal endgame spots
// ═══════════════════════════════════════════════════════════════════════════════

/** (generate.py `_spot_open_all_hours`, line 5770) */
function spotOpenAllHours(tags) {
  const hours = ((tags && tags.opening_hours) || '').trim();
  return hours === '' || SPOT_ALL_HOURS_VALUES.includes(hours);
}

/** (generate.py `_spot_public`, line 5775) */
function spotPublic(tags) {
  for (const key of SPOT_ACCESS_TAG_KEYS) {
    const value = ((tags && tags[key]) || '').trim().toLowerCase();
    if (PRIVATE_ACCESS.includes(value)) return false;
  }
  return true;
}

/**
 * Shortlist candidate legal hiding spots inside each zone circle.
 * (generate.py `legal_endgame_spots`, line 5782)
 *
 * The rulebook's two hard tests are (a) publicly accessible during all game hours
 * and (b) within 10 ft of a path the map app would route you along. (b) has an OSM
 * analogue: within 5 m of a foot-accessible `highway` way. **(a) does not.** OSM does
 * not know whether a plaza is locked at night, so this returns a shortlist for a
 * human and the page must say so — it is never a verdict.
 *
 * Features carrying a restrictive `opening_hours` (anything but `24/7`) are demoted
 * to "verify on the ground" at half weight rather than dropped.
 *
 * `pathOkIds` is a `Set` of `'type/id'` strings, or `null` when the path join was not
 * attempted or failed — in which case EVERY spot is marked verify-on-the-ground.
 *
 * @returns {Object<string, Array<Object>>} zoneId → LegalSpot[]
 */
export function legalEndgameSpots(zones, geo, proj, radiusM, pathOkIds) {
  const pathOk = pathOkIds;
  const labels = new Map(GEO_CATEGORIES.map((c) => [c.key, c.label]));

  /** @type {Array<[Object, number, boolean]>} */
  const candidates = [];
  for (const [category, weight, enclosing] of LEGAL_SPOT_CATEGORIES) {
    for (const poi of (geo.pois[category] || [])) {
      if (!spotPublic(poi.tags)) continue;
      if (pathOk !== null && !pathOk.has(`${poi.osmType}/${poi.osmId}`)) continue;
      candidates.push([poi, weight, enclosing]);
    }
  }
  if (!candidates.length) {
    const empty = {};
    for (const zone of zones) empty[zone.zoneId] = [];
    return empty;
  }

  const index = buildPoiIndex(candidates.map((c) => c[0]), proj, radiusM);

  // Planar rings, projected exactly once each.
  /** @type {Map<string, Array<Array<[number, number]>>>} */
  const planar = new Map();
  for (const [poi] of candidates) {
    if (poi.rings && poi.rings.length) planar.set(poiKey(poi), ringsPlanar(poi, proj));
  }
  const [areaGrid, areaOverflow] = areaIndex(
    candidates.filter(([p]) => p.rings && p.rings.length).map(([p]) => p), proj, radiusM,
  );

  const parks = (geo.pois.park || []).filter((p) => p.rings && p.rings.length);
  const [parkGrid, parkOverflow] = areaIndex(parks, proj, radiusM);
  /** @type {Map<string, Array<Array<[number, number]>>>} */
  const parkPlanar = new Map(parks.map((p) => [poiKey(p), ringsPlanar(p, proj)]));

  const insideAPark = (x, y) => {
    for (const key of parkGrid.nearKeys(x, y, Infinity)) {
      if ((parkPlanar.get(key) || []).some((ring) => pointInRing([x, y], ring))) return true;
    }
    for (const poi of parkOverflow) {
      const rings = parkPlanar.get(poiKey(poi)) || [];
      if (rings.some((ring) => pointInRing([x, y], ring))) return true;
    }
    return false;
  };

  // Per-feature facts: computed once per feature, never once per zone.
  /** @type {Map<string, Object>} */
  const fixed = new Map();
  for (const [poi, weight, enclosing] of candidates) {
    const key = poiKey(poi);
    const [px, py] = proj.xy(poi.lat, poi.lon);
    const verify = (pathOk === null) || !spotOpenAllHours(poi.tags);
    const enclosed = Boolean(enclosing && poi.osmType !== 'node') || insideAPark(px, py);
    fixed.set(key, {
      name: poi.name || (labels.get(poi.category) || poi.category),
      type: poi.category,
      lat: poi.lat,
      lon: poi.lon,
      weight: weight * (verify ? SPOT_VERIFY_WEIGHT : 1.0),
      enclosed,
      verify,
      osm: `${poi.osmType}/${poi.osmId}`,
      _xy: [px, py],
    });
  }

  /** @type {Object<string, Array<Object>>} */
  const out = {};
  for (const zone of Array.from(zones).sort((a, b) => cmpStr(a.zoneId, b.zoneId))) {
    const centre = [zone.x, zone.y];
    const keys = Array.from(index.nearKeys(zone.x, zone.y, radiusM));
    // An area feature counts when its ring reaches the circle even if its icon does
    // not: a big park with a distant centroid is still a legal spot here.
    const areaKeys = Array.from(areaGrid.nearKeys(zone.x, zone.y, Infinity))
      .concat(areaOverflow.map((p) => poiKey(p)));
    for (const key of areaKeys) {
      if ((planar.get(key) || []).some((ring) => ringWithin(centre, ring, radiusM))) {
        keys.push(key);
      }
    }
    /** @type {Map<string, Object>} */
    const found = new Map();
    for (const key of keys) {
      if (found.has(key) || !fixed.has(key)) continue;
      const src = fixed.get(key);
      const row = {
        name: src.name,
        type: src.type,
        lat: src.lat,
        lon: src.lon,
        weight: src.weight,
        enclosed: src.enclosed,
        verify: src.verify,
        osm: src.osm,
      };
      let distance = dist(centre, src._xy);
      for (const ring of (planar.get(key) || [])) {
        if (pointInRing(centre, ring)) { distance = 0.0; break; }
        let best = Infinity;
        for (let i = 0; i < ring.length; i++) {
          const d = segPointDist(centre, ring[i], ring[(i + 1) % ring.length]);
          if (d < best) best = d;
        }
        distance = Math.min(distance, best);
      }
      row.distanceM = distance;
      found.set(key, row);
    }
    // Best first, then nearest: the cap must never let a cluster of unnamed grass
    // verges push the park, the bench and the shelter off a zone's shortlist.
    const rows = Array.from(found.entries()).sort((a, b) => {
      const wd = b[1].weight - a[1].weight;
      if (wd !== 0) return wd;
      const dd = a[1].distanceM - b[1].distanceM;
      if (dd !== 0) return dd;
      const ka = splitKey(a[0]);
      const kb = splitKey(b[0]);
      return cmpStr(ka[0], kb[0]) || cmpStr(ka[1], kb[1]) || (ka[2] - kb[2]);
    });
    out[zone.zoneId] = rows.slice(0, LEGAL_SPOTS_PER_ZONE).map(([, row]) => row);
  }
  return out;
}

/**
 * Attribute density-grid cells to zones, in place.
 *
 * A cell counts toward a zone when its CENTRE is within `radiusM` of the zone centre.
 * That is the approximation, stated plainly: a cell straddling the circle edge lands
 * wholly in or wholly out. At the build's 0.002° cells (~220 m) against a ~400 m zone
 * radius the boundary error is real and is why every density category is marked
 * `partial` and carries a note.
 *
 * What it is NOT is a map-wide approximation. The build attributes each feature to
 * exactly one cell, so the map-wide totals in `counts` are exact sums — and those are
 * what every curse predicate and the street-density figure actually read. Only the
 * per-zone numbers here are fuzzy.
 *
 * @param {Object<string, Object<string, number>>} inventory mutated in place
 * @param {Array<Object>} zones
 * @param {{cells: Array<{lat: number, lon: number, counts: Object<string, number>}>}} density
 * @param {Projection} proj @param {number} radiusM
 */
function mergeDensityIntoInventory(inventory, zones, density, proj, radiusM) {
  if (!density.cells.length) return;

  // Index the cells once, at the zone radius, so a 2,000-zone map does not become a
  // 2,000 × 50,000 scan. Cell size == query radius is what makes `near`'s 3×3
  // neighbourhood scan complete; `buildPoiIndex` sizes its index the same way.
  const index = new GridIndex(Math.max(1.0, radiusM));
  const cells = Array.from(density.cells)
    .sort((a, b) => (a.lat - b.lat) || (a.lon - b.lon));
  cells.forEach((cell, i) => {
    const [x, y] = proj.xy(cell.lat, cell.lon);
    index.add(i, x, y);
  });

  for (const zone of Array.from(zones).sort((a, b) => cmpStr(a.zoneId, b.zoneId))) {
    const row = inventory[zone.zoneId] || (inventory[zone.zoneId] = {});
    const [zx, zy] = proj.xy(zone.lat, zone.lon);
    // `near` already applies the radius, so there is no second distance test here.
    for (const id of index.nearKeys(zx, zy, radiusM)) {
      const cell = cells[id];
      if (cell === undefined) continue;
      for (const key of Object.keys(cell.counts).sort(cmpStr)) {
        row[key] = (row[key] || 0) + cell.counts[key];
      }
    }
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// The pipeline
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * p90 of |representative point − bbox centre| over ring-carrying features.
 * (generate.py `_icon_offset_p90`, line 5952)
 *
 * This is the honesty number specs/osm.md §3.3 demands: how far our computed map
 * icon can sit from where `out center` (and, by proxy, a map app's label) puts it.
 */
function iconOffsetP90(pois, proj) {
  const offsets = [];
  for (const poi of Array.from(pois).sort(cmpTypeId)) {
    if (!poi.rings || !poi.rings.length) continue;
    const xs = [];
    const ys = [];
    for (const ring of poi.rings) {
      for (const p of ring) {
        const [x, y] = proj.xy(p[0], p[1]);
        xs.push(x);
        ys.push(y);
      }
    }
    if (!xs.length) continue;
    const centre = [(minOf(xs) + maxOf(xs)) / 2, (minOf(ys) + maxOf(ys)) / 2];
    offsets.push(dist(proj.xy(poi.lat, poi.lon), centre));
  }
  if (offsets.length < 5) return null;
  return quantile(offsets, 0.90);
}

/**
 * Single-instance categories whose icons are close enough to be one question.
 * (generate.py `_redundant_pairs`, line 5978)
 *
 * GR's zoo and aquarium are 81 m apart, so the two matching questions are the same
 * bit for six cards (specs/osm.md §7.4).
 */
function redundantPairs(pois, proj, diagonalM) {
  const singles = Object.keys(pois)
    .filter((k) => pois[k].length === 1 && !GEO_DENSITY_ONLY.includes(k))
    .sort(cmpStr);
  const out = [];
  const threshold = diagonalM * REDUNDANT_PAIR_FRACTION;
  for (let i = 0; i < singles.length; i++) {
    for (let j = i + 1; j < singles.length; j++) {
      const pa = pois[singles[i]][0];
      const pb = pois[singles[j]][0];
      const d = haversineM(pa.lat, pa.lon, pb.lat, pb.lon);
      if (d <= threshold) out.push([singles[i], singles[j], d]);
    }
  }
  return out;
}

/**
 * Shore segments for every water body that extends beyond the map border.
 * (generate.py `_synth_coastline`, line 6014)
 *
 * Returns `[segments, names]`. A water body wholly inside the border is a lake you
 * can walk around, not a coast, and is left to the body-of-water questions.
 */
function synthCoastline(pois, bbox, proj, log) {
  const padded = bboxExpand(bbox, COAST_BBOX_PAD_M);
  const segments = [];
  const names = [];

  // "Larger than the game map" is the test, with a floor so that a very small map
  // cannot promote a boating pond to a sea.
  const [south, west, north, east] = bbox;
  const sw = proj.xy(south, west);
  const ne = proj.xy(north, east);
  const mapArea = Math.abs((ne[0] - sw[0]) * (ne[1] - sw[1]));
  const threshold = Math.max(mapArea, COAST_MIN_AREA_SQM);

  for (const water of Array.from(pois.water || []).sort(cmpTypeId)) {
    if (!water.rings || !water.rings.length) continue;
    // Polygonal water only. A river or canal is linear and almost always runs off the
    // edge of the map, but a riverbank is not a coast — that is what the
    // body-of-water questions are for.
    if ((water.tags || {}).natural !== 'water') continue;
    // Bigger than the map? This has to be a real size test, not a clipping test:
    // "some ring point falls outside the border" is also true of every pond near the
    // map edge, and picked up three suburban ponds on the reference feed. Overpass
    // returns a matched element's full geometry, so the area is honest.
    let area = 0.0;
    for (const ring of water.rings) {
      if (ring.length < 3) continue;
      const a = Math.abs(polygonArea(planarRing(ring, proj)));
      if (a > area) area = a;
    }
    if (area < threshold) continue;

    const runs = [];
    for (const ring of water.rings) {
      let run = [];
      for (const p of ring) {
        if (bboxContains(padded, p[0], p[1])) {
          run.push(p);
        } else if (run.length) {
          runs.push(run);
          run = [];
        }
      }
      if (run.length) runs.push(run);
    }
    if (!runs.length) continue;          // bigger than the map, but nowhere near it

    let made = 0;
    for (const run of runs) {
      for (let start = 0; start < run.length; start += COAST_SEGMENT_PTS) {
        const chunk = run.slice(start, start + COAST_SEGMENT_PTS);
        if (chunk.length < 2) continue;
        if (segments.length >= COAST_MAX_SEGMENTS) break;
        const mid = chunk[Math.floor(chunk.length / 2)];
        segments.push({
          category: 'coastline',
          osmType: water.osmType,
          // Negative ids mark a derived feature, and keep every segment distinct so
          // nothing downstream dedupes them into one.
          osmId: -(Math.abs(water.osmId) * 1000 + segments.length),
          name: water.name,
          lat: mid[0],
          lon: mid[1],
          tags: {
            derived: 'shore of a water body larger than the map',
            derived_from: `${water.osmType}/${water.osmId}`,
            natural: 'coastline',
          },
          rings: [chunk.map((p) => [p[0], p[1]])],
        });
        made += 1;
      }
      if (segments.length >= COAST_MAX_SEGMENTS) break;
    }
    if (made) names.push(water.name || `${water.osmType}/${water.osmId}`);
    if (segments.length >= COAST_MAX_SEGMENTS) {
      log('warn', `coastline synthesis hit the ${COAST_MAX_SEGMENTS}-segment cap`);
      break;
    }
  }

  return [segments, names];
}

/**
 * The `available: false` form of `GeoData` (mirrors `build_report`, line 15697).
 *
 * Degradation is a first-class path, not an error path: the run continues, every
 * container is empty, and `note` is the single honesty note that reaches the page.
 * @param {[number, number, number, number]} bbox
 * @param {string} note
 */
export function emptyGeoData(bbox, note) {
  return {
    available: false,
    bbox: Array.from(bbox),
    pois: {},
    counts: {},
    zoneInventory: {},
    zonePolygonHits: {},
    admin: {
      countryCode: null,
      countryName: null,
      placeName: null,
      ordinals: {},
      perZone: {},
      borderLevels: {},
      source: 'unknown',
    },
    curseCounts: {},
    cuisines: {},
    legalSpots: {},
    queries: [],
    notes: [note],
  };
}

/**
 * Run the whole S2 pipeline and return `GeoData`.
 * (generate.py `collect_geodata`, line 6096)
 *
 * Order: the one-request category count audit → geometry fetches for the categories
 * that need it → the POI index → per-zone inventory → admin resolution →
 * curse predicates → cuisines → legal spots. Under `--no-osm`, or if Overpass fails
 * outright, the CALLER returns `emptyGeoData(...)`; every downstream consumer must
 * degrade rather than crash.
 *
 * Budget on the reference map: ~10 requests, ~40 MB, once, then cached.
 *
 * @param {Object} opts Options
 * @param {Object} border Border
 * @param {Array<Object>} zones
 * @param {Projection} proj
 * @param {number} radiusM
 * @param {{onProgress?: function(number, number, string), onLog?: function(string, string)}
 *        | function(number, number, string)} [hooks]
 * @returns {Promise<Object>} GeoData
 */
export async function collectGeodata(world, opts, border, zones, proj, radiusM, hooks = {}) {
  const h = typeof hooks === 'function' ? { onProgress: hooks } : (hooks || {});
  const log = typeof h.onLog === 'function' ? h.onLog : noopLog;

  const bbox = border.bbox;
  const catalogue = geoCategories();
  /** @type {Array<Object>} */
  const queries = [];
  /** @type {Array<string>} */
  const notes = [];

  // Estimated round-trips. A world-file run has a very different shape from an Overpass
  // one: every category is one bbox query against an immutable file, so the total is
  // known up front and never grows. What used to be a count audit, four group fetches,
  // a building fetch, ⌈zones/150⌉ is_in batches and a Nominatim reverse geocode is now
  // one query per category, plus the density grid and the admin layer.
  const progress = new Progress(h.onProgress, GEO_CATEGORIES.length + 2);

  // ── 1. features, one bbox query per category ──────────────────────────────
  //
  // There is no separate count audit any more, and that is a real simplification
  // rather than a shortcut. Overpass had one because asking it for a count was
  // enormously cheaper than asking it for features, so the pipeline spent a whole
  // request learning what it could afford. Here the R-tree yields a free upper bound
  // (`worldCount` walks the index and reads no feature bytes at all) and the exact
  // count falls out of the fetch itself. The audit collapses into the fetch, and a
  // category's count and its feature list can no longer disagree.
  //
  // `CATEGORY_FEATURE_BUDGET` survives, applied to that free upper bound. Its meaning
  // has changed though: it was an etiquette limit on what to ask a shared free service
  // for, and it is now purely a page-size guard.
  /** @type {Object<string, Array<Object>>} */
  const pois = {};
  /** @type {Object<string, number>} */
  const counts = {};
  const partialCategories = new Set();
  let layersRead = 0;

  for (const category of GEO_CATEGORIES) {
    const key = category.key;
    // The tallies are answered by the density grid in step 2, not by a feature layer.
    if (GEO_DENSITY_GRID_CATEGORIES.includes(key)) continue;
    if (worldLayerInfo(world, key) === null) {
      // A layer the build did not produce degrades that category and nothing else.
      partialCategories.add(key);
      log('warn', `category ${key}: no world-file layer in the manifest`);
      continue;
    }
    progress.start(`geo:world ${key}`);
    try {
      const upperBound = await worldCount(world, key, bbox);
      if (upperBound !== null && upperBound > CATEGORY_FEATURE_BUDGET) {
        // An upper bound, not a count — say so by marking the category partial.
        counts[key] = upperBound;
        partialCategories.add(key);
        log('warn', `category ${key} has ~${upperBound} features `
          + `(> ${CATEGORY_FEATURE_BUDGET}): counted, not fetched`);
        continue;
      }
      pois[key] = (await worldPois(world, key, key, bbox, proj, {
        keepRings: keepRingsFor(key),
        keepTags: keepTagsFor(key),
      })) || [];
      counts[key] = pois[key].length;
      layersRead += 1;
    } catch (exc) {
        // One dead layer is a caveat; all of them dead is the next check.
      partialCategories.add(key);
      log('warn', `category ${key} unavailable: ${exc}`);
    } finally {
      progress.finish();
    }
  }

  // Not one layer readable means the origin is down, which is the whole-OSM-layer
  // failure CONTRACT.md §(f)1 describes — the caller answers it with `emptyGeoData`.
  // Overpass signalled that by throwing from the count audit; the equivalent here is
  // having read nothing at all. Throwing on the FIRST failure instead would turn one
  // missing layer into a dead OSM section, which is the bug this shape avoids.
  if (layersRead === 0) {
    throw new Error('world files: no layer could be read; the origin is unreachable');
  }

  // ── 2. the density grid: the categories that are tallies, not icons ───────
  progress.start('geo:world density grid');
  /** @type {null|{counts: Object<string, number>, cells: Array<Object>, cellDeg: number}} */
  let density = null;
  try {
    density = await worldDensity(world, bbox);
  } catch (exc) {
    log('warn', `density grid unavailable: ${exc}`);
  } finally {
    progress.finish();
  }
  for (const key of GEO_DENSITY_GRID_CATEGORIES) {
    // ABSENT, NOT ZERO, when the grid could not be read. §(f) rule 3 is the whole
    // reason: a zero here is indistinguishable from "this map genuinely has no
    // bridges", and it propagates — `curseCounts` reads `geo.counts` directly, so
    // Bridge Troll, Luxury Car and Right Turn would all come back `action: remove,
    // count: 0` ("No bridges on the game map") off a failed fetch, and the street
    // matching question would flip from functional to dead. Leaving the key unset
    // sends `auditCurses` down its `count === null` warn branch instead, which is the
    // honest answer. This is the same guard `mergeDensityIntoInventory` already gets
    // right below; it was missing only here.
    if (density) counts[key] = density.counts[key] || 0;
    // Partial either way: exact map-wide when present, absent when not, and never a
    // measured per-zone figure.
    partialCategories.add(key);
  }
  if (density) {
    const cellM = Math.round(density.cellDeg * 111000);
    notes.push(
      `Counts for ${GEO_DENSITY_GRID_CATEGORIES.join(', ')} come from a precomputed `
      + `${num(cellM)} m density grid rather than from individual features — their `
      + 'geometry is tens of gigabytes worldwide and every question asked of them is a '
      + 'tally. The map-wide totals are exact. The per-zone figures are approximate: a '
      + 'grid cell counts wholly inside or wholly outside a zone circle depending on '
      + 'where its centre falls.',
    );
  } else {
    notes.push(
      'The precomputed density grid could not be read, so counts of buildings, streets, '
      + 'footpaths, bridges and trees are missing rather than zero. Every score that '
      + 'needs them is excluded rather than guessed at.',
    );
  }
  // ── 2b. great-lake and inland-sea shores count as coastline ──────────────
  if (pois.water && pois.water.length) {
    const [shore, shoreNames] = synthCoastline(pois, bbox, proj, log);
    if (shore.length) {
      pois.coastline = (pois.coastline || []).concat(shore).sort(cmpTypeId);
      counts.coastline = (counts.coastline || 0) + shore.length;
      const joined = Array.from(new Set(shoreNames)).sort(cmpStr).slice(0, 4).join(', ');
      notes.push(
        'OpenStreetMap tags `natural=coastline` on ocean and sea shorelines only, so a '
        + `great lake carries none. ${num(shore.length)} shore segments were derived from `
        + `${joined} — water bodies larger than the game map, whose shore bounds the map the `
        + 'way a coast does. Distances are measured to those segments.',
      );
      log('info', `coastline: derived ${shore.length} shore segments from ${joined}`);
    }
  }

  // ── 3. provenance rows, one per category ─────────────────────────────────
  //
  // The `selector` field still carries the Overpass QL, and deliberately: it is the
  // definition of the category, it is what `tools/osm-world/categories.json` was
  // mechanically translated FROM, and a player who wants to check a number can still
  // paste it into overpass-turbo. What changes is `endpoint`, which now names the file
  // the number actually came from and the planet snapshot it is as of. Printing an
  // Overpass endpoint next to a world-file count would be a lie about provenance.
  for (const category of GEO_CATEGORIES) {
    const key = category.key;
    const counted = counts[key];
    if (counted === undefined) continue;
    const onGrid = GEO_DENSITY_GRID_CATEGORIES.includes(key);
    queries.push({
      key,
      selector: ovSub(ovSelector(category), bbox),
      bbox: Array.from(bbox),
      count: counted,
      cacheKey: '',
      endpoint: worldProvenance(world, onGrid ? 'density' : key),
      partial: partialCategories.has(key),
    });
  }

  // ── 4. per-zone inventory (two predicates, never interchanged) ────────────
  const [inventory, polygonHits] = zoneInventory(zones, pois, proj, radiusM);
  // The density categories have no features to inventory, so their per-zone figures
  // are attributed from grid cells instead. Merged in rather than computed inside
  // `zoneInventory` so the exact predicate and the approximate one stay visibly
  // separate — every consumer of `zoneInventory` reads both out of the same object,
  // and the note pushed in step 2 is what tells the page which is which.
  if (density) mergeDensityIntoInventory(inventory, zones, density, proj, radiusM);

  /** @type {Object} GeoData */
  const geo = {
    available: true,
    bbox: Array.from(bbox),
    pois,
    counts,
    zoneInventory: inventory,
    zonePolygonHits: polygonHits,
    admin: {
      countryCode: null,
      countryName: null,
      placeName: null,
      ordinals: { 1: null, 2: null, 3: null, 4: null },
      perZone: {},
      borderLevels: {},
      source: 'unknown',
    },
    curseCounts: {},
    cuisines: {},
    legalSpots: {},
    queries,
    notes,
  };

  // ── 5. place, country and the administrative ladder ──────────────────────
  //
  // Was: one Nominatim reverse geocode of the mean of the zone centres, with the OSM
  // `is_in` tags as the free fallback when it was unreachable. Nominatim is gone and
  // the fallback is now the whole story — see `adminInfo`. That removes the last
  // shared-free-service dependency in the pipeline, and with it a 1 req/s rate limit
  // and a mandatory-User-Agent header a browser cannot set.
  geo.admin = await adminInfo(world, zones, bbox, { progress, log });
  if (zones.length) {
    const orderedPoints = Array.from(zones)
      .sort((a, b) => cmpStr(a.zoneId, b.zoneId)).map((z) => [z.lat, z.lon]);
    queries.push({
      key: 'admin-containment',
      selector: 'boundary=administrative, admin_level 2–10, tested locally against '
        + `${num(zones.length)} zone centres`,
      bbox: Array.from(bbox),
      count: Object.keys(geo.admin.perZone).length,
      cacheKey: '',
      endpoint: worldProvenance(world, 'admin'),
      partial: Object.keys(geo.admin.perZone).length === 0,
    });
  }

  // ── 6. cuisines, then the curse audit that consumes them ─────────────────
  const host = ((geo.admin.countryCode || '').toUpperCase()) || null;
  const restaurants = pois.restaurant || [];
  const { perCountry, qualifying, tagged, total, rejected } = cuisineDetail(restaurants, host);
  geo.cuisines = perCountry;
  geo.curseCounts = await curseCounts(world, bbox, geo, { progress, log });
  queries.push({
    key: 'curse-audit',
    selector: CURSE_PREDICATE_SELECTORS
      .map(([k, sel]) => `${k}: ${ovSub(sel, bbox)}`).join('; '),
    bbox: Array.from(bbox),
    count: Object.keys(geo.curseCounts).length,
    cacheKey: '',
    endpoint: worldProvenance(world, 'curse_water'),
    partial: Object.keys(geo.curseCounts).length === 0,
  });

  // ── 7. candidate legal endgame spots ─────────────────────────────────────
  //
  // The "within 10 ft of a routable path" refinement is GONE, and this is the one
  // capability the world-file migration loses rather than improves. It worked by
  // asking Overpass to buffer every walkable way in the map by 5 m and intersect that
  // with the candidate spots — a server-side spatial join, returning a few kB of ids
  // instead of the ~40 MB the foot-way geometry would cost. There is no local
  // equivalent: doing it here would mean shipping the whole walkable network, which is
  // the single densest thing in OSM and precisely what the density grid exists to
  // avoid carrying.
  //
  // It was already the exception rather than the rule. `LEGAL_PATH_JOIN_WAY_BUDGET` is
  // 40,000 walkable ways and the reference map alone has 84,466, so the join was
  // skipped on essentially every real map — and when it was attempted it timed out on
  // all three mirrors twice, costing 7½ minutes for an optional refinement.
  //
  // So this is now the documented, unconditional path: `pathIds` is null, every
  // candidate spot comes back `verify: true` at `SPOT_VERIFY_WEIGHT`, and the note
  // says so. That is CONTRACT.md §(f)2's degradation-in-place, made permanent —
  // `available` stays true and every count on the page is still real.
  const pathIds = null;
  notes.push(
    'The rulebook\'s “within 10 ft of a routable path” test is not evaluated. It '
    + 'required a server-side spatial join against every walkable way in the map, which '
    + 'the precomputed map files cannot answer — a global footpath network is the one '
    + 'layer too dense to ship. Every candidate spot below is therefore marked '
    + 'verify-on-the-ground, which is what the previous pipeline did on any map larger '
    + `than ${num(LEGAL_PATH_JOIN_WAY_BUDGET)} walkable ways in any case.`,
  );
  // Read by legalEndgameSpots only, and never emitted: a Set is not clone-safe.
  geo.legalSpots = legalEndgameSpots(zones, geo, proj, radiusM, pathIds);

  // ── 8. the honesty notes that must reach the page ────────────────────────
  notes.push(
    'OSM has no review count, so the rulebook\'s “5 or more Google Reviews” '
    + 'legitimacy test is approximated by requiring a `name` tag. Measured effect on this kind '
    + 'of feed: a 5–10% trim, in the right direction, but not the same function.',
  );
  notes.push(
    'Every OpenStreetMap count here is a lower bound on what the seekers\' map app will '
    + 'show. OSM is strong on parks, schools, places of worship, hospitals and libraries and '
    + 'materially incomplete on retail, restaurants and chains.',
  );
  const offset = iconOffsetP90(pois.park || [], proj);
  if (offset !== null) {
    notes.push(
      'Distances are measured to a computed area centroid, not to a map app\'s label '
      + `anchor. On this map\'s park polygons the two differ by up to ${num(offset)} m at `
      + `the 90th percentile, which is a real fraction of the ${num(radiusM)} m zone radius.`,
    );
  }
  notes.push(
    'Candidate hiding spots are a shortlist for a human, never a verdict: OpenStreetMap does '
    + 'not know whether a plaza is locked at night, so the rulebook\'s “publicly '
    + 'accessible during all game hours” test cannot be automated.',
  );
  if (total) {
    notes.push(
      `${pct(tagged / total)} of restaurants carry a \`cuisine\` tag (${num(tagged)} of `
      + `${num(total)}), so the ${num(qualifying)} restaurants qualifying for Curse of the `
      + 'Distant Cuisine are a floor, not a total.',
    );
  }
  if (rejected.length) {
    const shown = rejected.slice(0, 12).join(', ');
    notes.push(
      'Cuisine tokens rejected as dishes or super-national regions rather than countries: '
      + `${shown}${rejected.length > 12 ? '…' : ''}. Adjective tokens only — promoting a `
      + 'dish to a country would change the count.',
    );
  }
  if ((counts.coastline || 0) === 0 && (counts.water || 0) > 0) {
    notes.push(
      'OpenStreetMap tags `natural=coastline` on ocean and sea shorelines only, so a great '
      + 'lake or inland sea carries none. A zero here means “no ocean coast in the '
      + 'border”, not “no large water”.',
    );
  }
  if ((counts.mountain || 0) === 0) {
    notes.push(
      'No named peak or volcano is mapped inside the border. A map app may still label a hill '
      + 'from its own gazetteer, so treat the mountain questions as dead-with-a-caveat.',
    );
  }
  if (zones.length > 1) {
    const pts = Array.from(zones)
      .sort((a, b) => cmpStr(a.zoneId, b.zoneId)).map((z) => [z.lat, z.lon]);
    const lats = pts.map((p) => p[0]);
    const lons = pts.map((p) => p[1]);
    const diagonal = haversineM(minOf(lats), minOf(lons), maxOf(lats), maxOf(lons));
    for (const [a, b, d] of redundantPairs(pois, proj, diagonal)) {
      notes.push(
        `${catalogue.get(a).label} and ${catalogue.get(b).label} each have exactly one instance `
        + `on this map and their icons are ${num(d)} m apart, so the two matching questions are `
        + 'the same bit of information bought twice.',
      );
    }
  }
  const partialKeys = queries.filter((q) => q.partial).map((q) => q.key).sort(cmpStr);
  if (partialKeys.length) {
    notes.push(
      'These queries returned a floor rather than a total and are marked partial: '
      + `${partialKeys.join(', ')}.`,
    );
  }
  notes.push(
    'Counts reflect one OpenStreetMap snapshot; the mirror that answered is not recorded, '
    + 'because recording it would make two identical runs produce different pages. Cached '
    + 'responses keep reruns byte-identical.',
  );

  geo.notes = notes;
  geo.queries = Array.from(queries)
    .sort((a, b) => cmpStr(a.key, b.key) || cmpStr(a.cacheKey, b.cacheKey));
  progress.settle('geo:done');
  return geo;
}
