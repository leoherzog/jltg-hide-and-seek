/**
 * osm/geodata.js — S2 · GEO, the OSM semantic layer.
 *
 * Port of generate.py's S2 (raw transport lives in ./overpass.js). WORKER SIDE ONLY —
 * no DOM, no window, no document.
 *
 * No network service is called from here. Every feature, count and administrative
 * boundary comes from the prebuilt, immutable world files (`./worldfile.js`), read with
 * HTTP Range requests against an R2 bucket.
 *
 * The GEO_CATEGORIES selectors are Overpass QL and stay that way: they DEFINE each
 * category, are printed verbatim in provenance, and `tools/osm-world/categories.json`
 * is a mechanical translation that must be checkable against them.
 *
 * Budget on the reference map: ~303 range requests, ~14.7 MB, ~18 s (measured
 * 2026-08-25; the seconds are the network's and vary ~20%). Never adjust these by
 * arithmetic. Nothing here caches; the files are served `max-age=31536000`, so the
 * browser's HTTP cache makes a second run cheap. Every round-trip is announced through
 * `onProgress(done, total, label)`.
 *
 * Everything below is deterministic: no wall clock reaches a return value, every
 * dict/set is iterated through a sort, every tie-break ends in a stable OSM id.
 * Categories are READ concurrently and APPLIED in catalogue order — see
 * `GEO_CATEGORY_CONCURRENCY` and the category loop in `collectGeodata`.
 *
 * Degradation is a first-class path, and there are two distinct states that must
 * never be conflated:
 *
 *   1. The whole OSM layer failed. `collectGeodata` throws only when NOT ONE layer
 *      could be read (`layersRead === 0`); the caller answers with `emptyGeoData(bbox, note)`
 *      (`available: false`, empty containers, one honesty note) and the run continues
 *      with every OSM-backed score dropped from the denominator. See CONTRACT.md §(f).
 *
 *   2. The "within 10 ft of a routable path" join is not evaluated at all — `pathIds`
 *      is unconditionally null (see the note above `legalEndgameSpots`). Every count is
 *      real; every candidate hiding spot comes back `verify: true` at half weight. No
 *      provenance row is emitted; the printed E1 definition tells the reader.
 *      `available` stays `true`; this is NOT case 1.
 *
 * Everything in between — a category missing from the manifest, an unreadable layer,
 * density grid or admin layer — degrades in place with a warning and a `partial`
 * provenance row.
 */

import {
  cmpStr, num, pct, quantile,
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
// `selector` is Overpass QL with `{{bbox}}` unsubstituted, printed verbatim next to
// every count on the page. The table is the S1/S2/S3 interface: S2 fetches it, S3
// asks questions of it, S4 prints the selectors. Trailing counts in comments are the
// measured reference values, kept as a regression anchor.

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

// One constant, three consumers (Right Turn, Luxury Car, street density), so they
// never disagree about what a street is.
export const CAR_STREET_SELECTOR =
  'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|'
  + 'living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]'
  + '["motor_vehicle"!="no"]["access"!="no"]({{bbox}});';

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
  cat('rail_line', 'Rail line',
    'way["railway"~"^(rail|subway|light_rail|tram|monorail|funicular)$"][!"service"]'
    + '({{bbox}});', {
      note: 'The [!service] clause is the whole category: 59.5% of railway=subway ways carry '
        + 'service=* (47.3% yard) and railway=rail 49.9%, so without it a depot behind a '
        + 'maintenance shed counts as much line as the route through the middle of town. '
        + 'Naming the live railway values instead of matching ["railway"] is what leaves out '
        + 'construction, disused and abandoned track for the same reason. The assembled route '
        + 'RELATIONS are a separate world layer, transit_route, and deliberately NOT a category '
        + 'here: nothing on the page asks a question about a route relation, and their only '
        + 'reader is the OSM fallback converter — a category would buy every run a fetch to '
        + 'answer a question nobody asked.',
    }),  // 136
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
  cat('car_street', 'Motor-vehicle street', CAR_STREET_SELECTOR),  // 54,693
  cat('shop', 'Shop', 'nwr["shop"]({{bbox}});'),  // 1,220
  cat('advertising', 'Advertising', 'nwr["advertising"]({{bbox}});', {
    note: 'OSM barely maps billboards — a low count is not evidence of scarcity.',
  }),  // 22
  cat('newsagent', 'Print source',
    'nwr["shop"~"^(newsagent|books|kiosk|stationery)$"]({{bbox}});'),  // 23
]);

// Foot-routable graph for the "within 10 ft of a marked path" legality test.
export const FOOT_WAY_SELECTOR =
  'way["highway"]["highway"!~"^(motorway|motorway_link|trunk|trunk_link)$"]'
  + '["foot"!~"^(no|private)$"]["access"!~"^(no|private)$"]({{bbox}});';

// Street View coverage — a static country table, NOT an OSM query: the low-coverage
// set the Unguided Tourist curse is removed for. Frozen SORTED array; use `.includes`.
export const LOW_STREETVIEW_COUNTRIES = Object.freeze(
  ['at', 'ba', 'by', 'cn', 'de', 'in', 'lt'],
);

// ── tuning constants (S2-local) ───────────────────────────────────────────────
//
// Every constant here still decides something, except `LEGAL_PATH_JOIN_WAY_BUDGET`,
// which only names the size the legal-path join would have had to fit into (see the
// note above `legalEndgameSpots`).

export const CATEGORY_FEATURE_BUDGET = 40000;  // above this, a category is counted but not fetched
export const LEGAL_SPOTS_PER_ZONE = 40;        // cap on the per-zone shortlist (page size guard)
export const TOILET_WIDE_FACTOR = 1.5;         // A1's "just outside the circle" fallback ring
export const REDUNDANT_PAIR_FRACTION = 0.05;   // 1/20 of the map diagonal (specs/osm.md §7.4)
export const REDUNDANT_PAIR_MAX_M = 5000.0;    // …and never further than this — see `redundantPairs`
// Buffering every walkable way by 5 m timed out on every Overpass mirror for the
// reference bbox (84,466 ways); above this budget every spot is marked verify-on-the-ground.
export const LEGAL_PATH_JOIN_WAY_BUDGET = 40000;
export const SPOT_VERIFY_WEIGHT = 0.5;         // restrictive opening_hours ⇒ half weight

// ── the world-file layer map ─────────────────────────────────────────────────
//
// Every category is answered by one of three things:
//
//   a FEATURE layer   real geometry, exact count, usable for distance and containment
//   the DENSITY grid  a per-cell tally, exact map-wide, APPROXIMATE per zone
//   nothing           absent from the build, so the category degrades
//
// `GEO_DENSITY_GRID_CATEGORIES` must match the density layers in
// tools/osm-world/categories.json: a key the build does not produce silently becomes
// a zero, which reads as "this map has no streets" rather than as a missing layer.
export const GEO_DENSITY_GRID_CATEGORIES = Object.freeze(
  ['bridge', 'building', 'car_street', 'footpath', 'street', 'tree'],
);

// `curse_animal_habitat` is not built; its count is reconstructed from a partition
// identity (DESIGN.md §Phase 1 R2), exact because `landuse` is single-valued:
//
//   green                = landuse ∈ {forest, grass, meadow, village_green,
//                                     recreation_ground}
//   curse_animal_habitat = landuse ∈ {forest, grass, meadow, village_green}
//                          ∪ leisure ∈ {park, nature_reserve}
//                          ∪ (natural = water ∧ name)
//
// `green` minus its `recreation_ground` members is exactly the first line, and
// `animal_delta` is exactly the remaining two lines with `landuse` members removed,
// so the terms never double-count. `worldCount` counts per-feature bboxes, which are
// the same whichever layer a feature was written into, so the sum equals what the
// layer itself would return — including the deliberate over-count of a feature whose
// bbox clips the map while its geometry does not (see `curseCounts`).
//
// Order is load-bearing for term 0: `curseLayerCount` treats the FIRST term as the
// base layer. A base absent from the manifest refuses the whole expression; a later
// term absent counts as 0 (unless the manifest is marked partial).
export const CURSE_ANIMAL_HABITAT_TERMS = Object.freeze([
  Object.freeze([1, 'green']),
  Object.freeze([-1, 'green_recreation_ground']),
  Object.freeze([1, 'animal_delta']),
]);

// Curse predicates whose selector differs from the same-named category's, so they
// ship as their own world-file layer. `water` matters most: the curse says "marked",
// the category says "named", and they differ by 8:1. Everything absent from this map
// is answered by a category layer or the density grid — see `curseCounts`.
//
// The optional third element is a FALLBACK EXPRESSION: a signed sum of other layers
// equal to the named layer's count, used only when the build did not ship the layer.
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

// Rings are kept only where a containment test is actually asked for: the photo
// questions ask "is the hider standing in a park", the matching/measuring ones ask
// about the icon, and the two predicates must never be interchanged. Only `park`
// is read out of `polygonHits` by `rules/score.js`; `featuresToPois` computes the
// representative point, area and dedup independently of `keepRings`.
export const RING_CATEGORIES = Object.freeze(['park', 'water']);

// ═══════════════════════════════════════════════════════════════════════════════
// LEGAL SPOT HEURISTICS — THE EDITABLE TABLE
// ═══════════════════════════════════════════════════════════════════════════════
//
// AGENTS.md flags this as the weakest hand-written judgement in the codebase. Kept in
// one block so a human can argue with it in one place. Change it on purpose or not at all.

// Categories that can supply a candidate endgame spot, with the starting weight.
// Restricted to categories already fetched. `true` = an enclosure when it is an area
// (park interior, playground, pitch), `false` = a point on the street.
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
// is demoted to verify-on-the-ground at half weight rather than dropped. An ABSENT
// tag deliberately counts as open: most benches carry no hours.
export const SPOT_ALL_HOURS_VALUES = Object.freeze(['24/7', 'Mo-Su 00:00-24:00']);

// ═══════════════════════════════════════════════════════════════════════════════
// Curse predicates
// ═══════════════════════════════════════════════════════════════════════════════

// Curse predicates decided by an OSM count. Unguided Tourist (Street View table) and
// U-Turn (GTFS route overlap) are decided elsewhere and deliberately absent.
export const CURSE_PREDICATE_SELECTORS = Object.freeze([
  // Bridge Troll: "any elevated structure, acting as a path, road or railway", so
  // railway bridges are in and covered bridges are not excluded. Two statements
  // because Overpass cannot OR across two keys; the union deduplicates.
  Object.freeze(['bridge',
    'way["bridge"]["bridge"!="no"]["highway"]({{bbox}});'
    + 'way["bridge"]["bridge"!="no"]["railway"]({{bbox}});']),
  // Water Weight: "does not necessarily mean natural, but it cannot be a pool and
  // must be large enough to be marked on the map". MARKED, not named — no ["name"]
  // filter; the named form is the GEO_CATEGORIES `water` category and they differ
  // by 8:1. "Not necessarily natural" pulls in reservoirs and basins. "Marked" is
  // approximated by "OSM marks it at all", the looser reading, right for a REMOVAL test.
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
// Adjective tokens ONLY. Dishes and super-national regions are rejected and the
// rejected tokens reported so a player can override.

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

// The two reject lists below are DESCRIPTIVE: nothing reads them. `cuisineDetail`
// rejects by absence from CUISINE_COUNTRY; these enumerate what that absence is
// meant to catch.
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
// Per specs/osm.md §6.3 step 5. A null entry means "this country has no such
// division"; a level absent from the map resolves to null too.
export const ADMIN_ORDINAL_OVERRIDES = Object.freeze({
  fr: Object.freeze([4, 6, 8, 9]),      // région / département / commune (7 = arrondissement is skipped)
  de: Object.freeze([4, 6, 8, 9]),      // Land / Kreis / Gemeinde / Stadtbezirk (5 = Regierungsbezirk skipped)
  gb: Object.freeze([4, 6, 8, 10]),     // constituent country / county / district / civil parish
  jp: Object.freeze([4, 7, 8, null]),   // prefecture / municipality / ward
  cn: Object.freeze([4, 6, 7, 8]),      // province / prefecture-city / county / township
  it: Object.freeze([4, 6, 8, 9]),      // regione / provincia / comune / circoscrizione
});

// The same ladder judgements for a world whose `admin` layer was built from Overture
// divisions (manifest `admin_source: 'overture'`, DESIGN.md Phase 2). The build
// synthesises `admin_level` per subtype — country=2, dependency=3, region=4,
// county=6, localadmin=7, locality=8, macrohood=9, neighborhood=10 — and stamps
// ISO3166-1 only on levels 2–3 and ISO3166-2 only on level 4. The numbers echo OSM's
// but do NOT mean the same thing, so the OSM table above must never be consulted for
// an overture world and vice versa. A country absent here takes the generic path,
// which for overture always anchors at level 4.
export const OVERTURE_ADMIN_ORDINAL_OVERRIDES = Object.freeze({
  us: Object.freeze([4, 6, 8, null]),   // state / county / place; NO fourth rung —
  // US cities are Overture localities at 8 and level 9 is `macrohood`. Without this
  // entry the census takes the deepest ordinal with any tally and names the map after
  // a neighbourhood ("Third Ward" instead of "Grand Rapids").
  ca: Object.freeze([4, 6, 8, null]),   // province / regional district / municipality;
  // same judgement as `us`: without it the fourth rung filled with "Downtown" and the
  // missing entry withheld the city-rung plurality clause from the census walk.
  fr: Object.freeze([4, 6, 8, 10]),     // region / department / commune / neighbourhood
  it: Object.freeze([4, 6, 8, 10]),     // regione / provincia / comune / neighbourhood
  jp: Object.freeze([4, 6, 8, null]),   // prefecture / municipality / ward
  de: Object.freeze([4, 6, 8, 9]),      // Land / Kreis / Gemeinde / Stadtbezirk
  gb: Object.freeze([4, 6, 8, 10]),     // constituent country / county / district / parish
  cn: Object.freeze([4, 6, 7, 8]),      // province / prefecture-city / county / township
});

// A water body larger than the game map behaves like a coast. OSM reserves
// `natural=coastline` for ocean and sea, so a Great Lakes map would otherwise report
// "no coastline". House ruling: a great-lake shore is a coast.
//
// The shore is emitted as many short segments, as `natural=coastline` itself is
// modelled: the in-border filter and measuring questions work off a representative
// point, and Lake Michigan's centroid is ~100 km offshore.
export const COAST_SEGMENT_PTS = 12;      // ring points per synthesised shore segment
export const COAST_MAX_SEGMENTS = 600;    // hard cap; a whole sea coast must not swamp the page
export const COAST_BBOX_PAD_M = 2000.0;   // keep shore just outside the border — it still bounds the map
export const COAST_MIN_AREA_SQM = 25e6;   // 25 km²: floor, so a tiny map cannot promote a pond to a sea

// ═══════════════════════════════════════════════════════════════════════════════
// Small deterministic helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Python tuple comparison for `(osmType, osmId)` — string then NUMBER. */
function cmpTypeId(a, b) {
  return cmpStr(a.osmType, b.osmType) || (a.osmId - b.osmId);
}

/** Python tuple comparison for `(category, osmType, osmId)`. */
function cmpCatTypeId(a, b) {
  return cmpStr(a.category, b.category) || cmpStr(a.osmType, b.osmType) || (a.osmId - b.osmId);
}

/**
 * The grid/lookup key for one POI: `(category, osm_type, osm_id)` as a delimited
 * string. Every ordering that matters is re-derived from the parts, never the string.
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

/** `GEO_CATEGORIES` as a key → category map (`_geo_categories`). */
export function geoCategories() {
  const out = new Map();
  for (const c of GEO_CATEGORIES) out.set(c.key, c);
  return out;
}

function keepRingsFor(key) { return RING_CATEGORIES.includes(key); }

/** Project a geographic ring (`[lat, lon]` pairs) into planar metres. */
function planarRing(ring, proj) {
  return ring.map((p) => proj.xy(p[0], p[1]));
}

/** `math.dist` over two planar points. */
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

// `Math.min(...arr)` blows the argument limit above ~65k elements, and one Great
// Lake ring is bigger than that. Loop everywhere.
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
 * Progress bookkeeping around every world-file read. `total` is an estimate that
 * finishing a task raises if the run overruns.
 *
 * One counter, several reads in flight: `start` hands back a TASK, and a task is the
 * thing that completes, so `done` counts completions and nothing else.
 *
 * Two rules keep the bar honest under concurrency:
 *
 *   1. An emission identical to the previous one (same `done`, `total`, caption) is
 *      DROPPED, so a batch of lanes opening at once does not post identical messages.
 *
 *   2. The caption is the OLDEST read still waiting, falling back to the last
 *      completed label when nothing is open, so it never blanks between phases.
 *
 * A CONCURRENT CALLER MUST PASS THE SAME LABEL FOR EVERY TASK IN ITS BATCH: completion
 * order is the network's, so a per-task caption would differ between two runs of the
 * same input, breaking the determinism contract. Name the PHASE and let the counter
 * carry the detail.
 */
class Progress {
  constructor(cb, total) {
    this._cb = typeof cb === 'function' ? cb : () => {};
    this.done = 0;
    this.total = total;
    this._label = '';
    // Insertion-ordered, so the first value is the oldest open task. Keyed by a
    // serial because two reads may carry the same caption.
    this._open = new Map();
    this._seq = 0;
    // The last triple handed to `cb`, for rule 1. Null so the first emission always goes out.
    this._last = null;
  }

  /**
   * Open one unit of work and return its handle. `finish` is idempotent: callers
   * close from a `finally`, and a unit counted twice would push `done` past `total`.
   */
  start(label) {
    const id = (this._seq += 1);
    this._open.set(id, label);
    this._emit();
    return {
      finish: () => {
        if (!this._open.delete(id)) return;
        this.done += 1;
        if (this.done > this.total) this.total = this.done;
        this._label = label;
        this._emit();
      },
    };
  }

  /** Retire the estimate: whatever was skipped never happens, so the bar completes. */
  settle(label) {
    this.total = this.done;
    this._label = label !== undefined ? label : this._label;
    this._emit();
  }

  /** Rule 1: say nothing when there is nothing new to say. */
  _emit() {
    const caption = this._caption();
    const last = this._last;
    if (last !== null
      && last[0] === this.done && last[1] === this.total && last[2] === caption) return;
    this._last = [this.done, this.total, caption];
    this._cb(this.done, this.total, caption);
  }

  /** Rule 2: the oldest read still waiting, or the last one that finished. */
  _caption() {
    for (const label of this._open.values()) return label;
    return this._label;
  }
}

// How many feature categories `collectGeodata` reads at once.
//
// NOT a request limit: sockets are gated a layer down by `MAX_CONCURRENT_RANGES` in
// `./flatgeobuf.js`, a guard rail this number is not chosen to press against. A
// category is a mostly serial chain (R-tree root, nodes, feature runs) with decode
// pauses; eight lanes cover those pauses (19.4 s → ~2.9 s, ~20 requests in flight)
// while bounding the resident working set. 16 and 24 measured inside run-to-run noise.
const GEO_CATEGORY_CONCURRENCY = 8;

// The one caption every category read in the batch reports under, shaped like the
// other phase labels: the name of a phase, not of a file.
const GEO_FEATURE_PHASE_LABEL = 'geo:world features';

/**
 * Run `worker` over `items` with at most `limit` in flight, returning results in
 * INPUT order however they finished, so a caller can apply them in catalogue order.
 *
 * `worker` must not reject — a rejection abandons the lanes still running. Every
 * caller wraps its own body in try/catch.
 */
async function mapConcurrent(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const lane = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await worker(items[i]);
    }
  };
  const lanes = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) lanes.push(lane());
  await Promise.all(lanes);
  return out;
}

function noopLog() {}

// ═══════════════════════════════════════════════════════════════════════════════
// Spatial index and the two zone predicates
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Index a POI set for radius queries at the zone radius. See `GridIndex`.
 * (generate.py `build_poi_index`)
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
 * (generate.py `_area_index`)
 *
 * A feature is inserted into every cell its bbox touches; anything spanning more
 * than `GridIndex.addBbox`'s cap goes into the overflow list instead.
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

/** (generate.py `_rings_planar`) */
function ringsPlanar(poi, proj) {
  return (poi.rings || []).map((ring) => planarRing(ring, proj));
}

/**
 * Count, per zone, how many features of each category fall inside the circle.
 * (generate.py `zone_inventory`)
 *
 * Returns `[iconCounts, polygonHits]`. **Two different predicates**: icon counts ask
 * whether the representative point is inside the disc (matching/measuring questions);
 * polygon hits ask whether the ring intersects the disc (photo questions' "stand in a
 * park"). Parks are 28.5% by icon and 45.5% by polygon. Never substitute one for the other.
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
  // NOT `flat.push(...pois[key])`: spread blows the stack above ~65k elements and
  // `building` alone is 88k features. Same reason as `minOf`/`maxOf` above.
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





/** (generate.py `_admin_level`) */
function adminLevel(tags) {
  const value = tags.admin_level !== undefined ? tags.admin_level : '';
  // Python's str.isdigit(): non-empty and every character a digit.
  if (value !== '' && /^\d+$/.test(value)) return parseInt(value, 10);
  return null;
}

/**
 * Normalise a place name for equality against a timezone's city token: NFD, strip
 * combining marks, casefold, collapse whitespace. Deliberately no fuzzier than
 * accents and case: the ordinal-1 rule accepts on exact match only.
 */
function normPlace(value) {
  return String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}


/**
 * Resolve the 1st–4th administrative divisions for this map.
 * (generate.py `resolve_admin` — exported as `adminInfo` per CONTRACT.md)
 *
 * Containment (which division is a zone in) answers the *matching* questions;
 * boundary crossing answers the *border measuring* questions. They are different
 * questions and must not be conflated.
 *
 * Ordinals 2–4 come from the distinct levels present across *all* zone centres, not
 * one probe point. Never guess an `admin_level`.
 *
 * The place name is a service-weighted census: each zone votes its `stopEvents`
 * (`gtfs/network.js` buildZones), the walk visits ordinals 4→3→2, and a division wins
 * with a third of the census — or, additively, with a ≥20% city-rung plurality at
 * 1.5× the runner-up in countries with an override-table entry. When nothing wins, an
 * ordinal-1 division holding ≥90% of the census is accepted iff its name equals the
 * feed's `agency_timezone` city and no deeper rung holds that name (pass
 * `hooks.timezone` to arm this); then the deepest LADDER-level admin area at the map
 * centre (`name:en` preferred); then the caller's agency-name fallback.
 *
 * @returns {Promise<Object>} AdminInfo
 */
export async function adminInfo(world, zones, bbox, hooks = {}) {
  const progress = hooks.progress || new Progress(null, 0);
  const log = hooks.log || noopLog;
  // The primary feed's `agency_timezone`, for the ordinal-1 rule below. A hint, never
  // an input the ladder depends on.
  const feedTimezone = typeof hooks.timezone === 'string' ? hooks.timezone : '';

  const ordered = Array.from(zones).sort((a, b) => cmpStr(a.zoneId, b.zoneId));

  // The administrative areas overlapping the map are fetched ONCE and every zone
  // centre is tested against them locally.
  /** @type {Array<Object>} */
  let areas = [];
  const adminTask = progress.start('geo:world admin areas');
  try {
    areas = (await worldAdminAreas(world, bbox)) || [];
  } catch (exc) {
    // Admin questions degrade to `unknown`; they never abort the run.
    log('warn', `admin containment lookup failed: ${exc}`);
    areas = [];
  } finally {
    adminTask.finish();
  }

  // The containing areas per zone, kept as AREA objects: the country census needs to
  // know WHICH polygon contained a zone.
  const perPointAreas = ordered.map((zone) => adminAreasAt(areas, zone.lat, zone.lon));

  // One tag object per containing area, in zone order. `name:en` is carried through
  // because a multilingual country's bare `name` is the slash-joined native form.
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
  // The first-division level anchors the ordinal ladder for every country absent
  // from `ADMIN_ORDINAL_OVERRIDES`. It is the lowest level carrying an `ISO3166-2`
  // code, which is by definition a country's principal subdivision.
  let iso2Level = null;
  for (const area of areas) {
    if (area.iso2 && (iso2Level === null || area.level < iso2Level)) iso2Level = area.level;
  }

  // Country identity: the ISO3166-1 polygon CONTAINING the most zone centres, so a
  // border-straddling map (Basel: de/ch/fr) is not resolved alphabetically. The
  // (level, name) order of `areas` is the tie-break and the fallback when no zone
  // centre sits in any country polygon.
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
  // Same `name:en` preference the ladder applies.
  const countryName = countryArea === null ? null
    : (countryArea.nameEn || countryArea.name || null);

  // Per-zone {admin_level: name}, plus the map-wide level census.
  /** @type {Map<string, Map<number, string>>} */
  const perZoneLevels = new Map();
  const levelsPresent = new Set();

  // Divisions OVERLAP within a level (Overture files a US city and a civil township
  // both as `locality`), so the ladder cannot be built by last-write-wins. Collect
  // every name a zone falls in, then let map-wide prevalence choose its rung.
  /** @type {Map<string, Map<number, Set<string>>>} */
  const perZoneAll = new Map();
  /** @type {Map<number, Map<string, number>>} level → name → zones it contains */
  const levelTally = new Map();
  const pairs = Math.min(ordered.length, perPoint.length);
  for (let i = 0; i < pairs; i++) {
    const zone = ordered[i];
    /** @type {Map<number, Set<string>>} */
    const ladder = new Map();
    for (const tags of perPoint[i]) {
      if (tags.boundary !== 'administrative') continue;
      const level = adminLevel(tags);
      const name = tags['name:en'] || tags.name || '';
      if (level === null || !name) continue;
      if (!ladder.has(level)) ladder.set(level, new Set());
      ladder.get(level).add(name);
      levelsPresent.add(level);
    }
    for (const [level, names] of ladder) {
      if (!levelTally.has(level)) levelTally.set(level, new Map());
      const tally = levelTally.get(level);
      for (const name of names) tally.set(name, (tally.get(name) || 0) + 1);
    }
    perZoneAll.set(zone.zoneId, ladder);
  }
  // Collapse to one name per level. Ties break on the name, so the answer never
  // depends on the order the areas came back in.
  for (const [zoneId, ladder] of perZoneAll) {
    const one = new Map();
    for (const [level, names] of ladder) {
      const tally = levelTally.get(level);
      one.set(level, Array.from(names).sort(
        (x, y) => ((tally.get(y) || 0) - (tally.get(x) || 0)) || cmpStr(x, y),
      )[0]);
    }
    perZoneLevels.set(zoneId, one);
  }

  // `'unknown'` means no administrative data at all; it is the only value
  // `render/deck.js` branches on.
  let countryCode = iso1Country;
  let placeName = null;
  let source = 'unknown';
  if (countryCode !== null || perZoneLevels.size) source = 'world';

  // Ordinal ladder. Derived, never guessed. The manifest's `admin_source` picks the
  // override table: an overture-built admin layer uses synthetic levels that only
  // look like OSM's.
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

  // The place name is the division that carries the most SERVICE, not the most map
  // area (a bare zone count rewards sprawl: Surrey out-zoned Vancouver while Vancouver
  // out-served it 2:1) and not the one under the bbox centre. Zone discs overlap, so
  // the census is a share of summed zone `stopEvents`, not of the map's departures;
  // harmless for a plurality test.
  //
  // Go as specific as the data allows, then take the leader *within that ordinal*.
  // Ranking by raw weight across ordinals always picks the broadest division. Which
  // ordinal holds "the municipality" varies even across US states, so the walk starts deep.
  const zoneIds = Object.keys(perZone).sort(cmpStr);
  /** zoneId → census weight: departures when the zones carry them, 1 each otherwise. */
  const weightOf = new Map();
  {
    let events = 0;
    for (const zone of ordered) {
      const weight = Math.max(0, Number(zone.stopEvents) || 0);
      weightOf.set(zone.zoneId, weight);
      events += weight;
    }
    if (!(events > 0)) {
      // Synthetic or stripped zones: degrade to one zone, one vote.
      for (const zone of ordered) weightOf.set(zone.zoneId, 1);
    }
  }
  let censusTotal = 0;
  for (const zoneId of zoneIds) censusTotal += weightOf.get(zoneId) || 0;
  const pctOf = (weight) => (censusTotal > 0
    ? ((100.0 * weight) / censusTotal).toFixed(1) : '0.0');

  // Weighted tally per ordinal, ranked (weight desc, then name). Ordinal 1 is
  // tallied for the timezone rule after the walk.
  /** @type {Object<number, Array<[string, number]>>} */
  const census = {};
  for (const ordinal of [1, 2, 3, 4]) {
    const tally = new Map();
    for (const zoneId of zoneIds) {
      const name = perZone[zoneId][ordinal];
      if (name) tally.set(name, (tally.get(name) || 0) + (weightOf.get(zoneId) || 0));
    }
    census[ordinal] = Array.from(tally.entries())
      .sort((a, b) => (b[1] - a[1]) || cmpStr(a[0], b[0]));
  }

  if (zoneIds.length && censusTotal > 0) {
    const ord2Leader = census[2].length ? census[2][0][0] : null;
    const ord2Runner = census[2].length > 1 ? census[2][1][0] : null;
    for (const ordinal of [4, 3, 2]) {
      const ranked = census[ordinal];
      if (!ranked.length) continue;
      const [leaderName, leaderW] = ranked[0];
      const runnerW = ranked.length > 1 ? ranked[1][1] : 0;
      // A third of the whole census is the bar: a stray sliver must not beat an
      // ordinal that names the whole map.
      const clearsThird = leaderW * 3 >= censusTotal;
      // The ADDITIVE city-rung clause: a regional network's core city routinely holds
      // 20–30% with nothing close (Seattle ~26%, 1.8× Tacoma). Accept a clear plurality
      // only additively (a leader over the third is never demoted), only where an
      // override entry vouches that ordinal 3 is the locality rung, only when the rung
      // holds three or more divisions (the ratio is vacuous otherwise), and never when
      // ordinal 2 is the SAME RUNG duplicated (Japan files wards at two levels).
      // Duplication needs BOTH leader and runner-up to coincide: a city-département
      // like Paris legitimately tops both rungs while the rest differs.
      const rungDuplicated = leaderName === ord2Leader
        && (ranked.length > 1 ? ranked[1][0] : null) === ord2Runner;
      const loose = !clearsThird
        && ordinal === 3
        && Boolean(override)
        && ranked.length >= 3
        && !rungDuplicated
        && leaderW >= 0.20 * censusTotal
        && runnerW > 0 && leaderW >= 1.5 * runnerW;
      if (!clearsThird && !loose) {
        log('info', `ordinal ${ordinal} skipped for the place name: its leader `
          + `${JSON.stringify(leaderName)} carries only ${pctOf(leaderW)}% of the census`);
        continue;
      }
      placeName = leaderName;
      log('info', `place name ${JSON.stringify(placeName)} from ordinal ${ordinal} `
        + `(${pctOf(leaderW)}% of the census, ${ranked.length} divisions there${loose
          ? `; city-rung plurality, ${(leaderW / runnerW).toFixed(2)}x the runner-up` : ''})`);
      break;
    }
  }

  // A city-state or prefecture-city (Tokyo, Vienna) exists ONLY at ordinal 1. A state
  // must not name a map ("Massachusetts" for Boston), so ordinal 1 is admitted only
  // under a conjunction: ≥90% of the census AND named by the feed's `agency_timezone`
  // city AND no deeper rung holds that name. The deeper-rung guard blocks Rochester
  // inside "New York" and Campinas inside "São Paulo". The timezone alone is NOT
  // trustworthy (Dublin feeds declare Europe/London; MBTA declares America/New_York).
  if (placeName === null && zoneIds.length && censusTotal > 0
      && ordinals[1] !== null && census[1].length) {
    const [leaderName, leaderW] = census[1][0];
    const tzCity = normPlace(String(feedTimezone).split('/').pop().replace(/_/g, ' '));
    const deeperSame = tzCity !== '' && [2, 3, 4].some(
      (ordinal) => census[ordinal].some(([name]) => normPlace(name) === tzCity),
    );
    if (tzCity !== '' && leaderW * 10 >= censusTotal * 9
        && normPlace(leaderName) === tzCity && !deeperSame) {
      placeName = leaderName;
      log('info', `place name ${JSON.stringify(placeName)} from ordinal 1 `
        + `(${pctOf(leaderW)}% of the census; matches the agency timezone `
        + `${JSON.stringify(feedTimezone)})`);
    }
  }

  if (placeName === null) {
    // No zones, or no division passed any bar: fall back to the administrative area
    // covering the map centre, a geometric artefact. Candidates are restricted to the
    // LADDER'S levels when any cover the centre (a raw deepest-level sort resurfaces
    // the macrohoods the ladder skips), and `name:en` is preferred, as in the census.
    const ladderLevels = new Set([ordinals[1], ordinals[2], ordinals[3], ordinals[4]]
      .filter((level) => level !== null && level !== undefined));
    const [s, w, n, e] = bbox;
    const at = adminAreasAt(areas, (s + n) / 2.0, (w + e) / 2.0)
      .filter((area) => area.name || area.nameEn);
    const onLadder = at.filter((area) => ladderLevels.has(area.level));
    const covering = (onLadder.length ? onLadder : at)
      .sort((a, b) => b.level - a.level || cmpStr(a.name, b.name));
    if (covering.length) {
      placeName = covering[0].nameEn || covering[0].name;
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
  // Answered off the `areas` in hand: more than one area at a level means the seam
  // between them runs through the map. An area that merely surrounds the whole map
  // does not count, and there is exactly one per level.
  //
  // Deliberately diverges from Overpass's `way(r.a)({{bbox}})`: this asks whether the
  // map spans a division at that level, and says no where a map sits inside one
  // division and clips the outer edge of its parent.
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
    // The manifest's own `admin_source`; renderers need it because Overture's levels
    // do NOT mean what OSM's `admin_level` means.
    adminSource,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Curse predicates and cuisines
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * One curse predicate's count: the layer if the build shipped it (older and fixture
 * worlds), otherwise the fallback expression. The two agree by construction; which
 * branch ran is visible only in the log.
 *
 * `worldCount` returns null for anything the manifest does not list, and
 * `tools/osm-world/build.py` OMITS a layer whose selector matched nothing, so an
 * absent term means two different things:
 *
 *   - The FIRST term is the base layer, a superset the others carve pieces out of.
 *     Absent, the total would be wrong in the direction that removes a curse, so
 *     the predicate goes unanswered (the curse stays in the deck).
 *
 *   - A LATER term absent is the empty-layer case and counts as 0, with an info line.
 *
 * A path-less manifest entry (`{"features": 0}`) is a genuine zero from `worldCount`
 * and reaches neither bullet.
 *
 * Absent-as-zero is only sound for a FULL build. A `--only` build marks its manifest
 * `"partial": true`; there an absent term means "not built", so the expression refuses.
 *
 * @param {Object} world
 * @param {string} layer the named layer
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
      // Base layer (term 0) missing: untrusted. Later term missing: empty. See above.
      if (i === 0) {
        log('warn', `curse predicate ${predicate}: no ${layer} layer in the manifest, and `
          + `the ${terms.map(([, k]) => k).join(' / ')} substitute needs ${key}, which is `
          + 'not there either');
        return null;
      }
      if (world.manifest && world.manifest.partial === true) {
        // Partial manifest: absent means "not built", and zeroing would fabricate a total.
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
  // Only possible if a build ships mismatched layers; a negative total would lie in
  // the direction that removes a curse. Refuse instead.
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
 * (generate.py `curse_predicates` — exported as `curseCounts`)
 *
 * Returns `curseId → count`. Removal is `count === 0` for the hard tier; the warn
 * tier is reported with its count and never auto-removed. Unguided Tourist and
 * U-Turn are not OSM and must not be invented here.
 */
export async function curseCounts(world, bbox, geo, hooks = {}) {
  const progress = hooks.progress || new Progress(null, 0);
  const log = hooks.log || noopLog;
  const counts = {};

  // The source split is data (`CURSE_WORLD_LAYERS`, `CURSE_FROM_CATEGORY`,
  // `CURSE_FROM_DENSITY`). `water` reads `curse_water`, its own layer, never
  // `counts.water`: "marked" and "named" differ by 8:1.
  /** @type {Object<string, number>} */
  const raw = {};

  const curseTask = progress.start('geo:world curse predicates');
  try {
    for (const [predicate, layer, terms] of CURSE_WORLD_LAYERS) {
      // An upper bound: these are removal tests and only zero has to be exact. A
      // bbox clip can turn a 0 into a 1, which fails SAFE.
      const count = await curseLayerCount(world, layer, terms, bbox, log, predicate);
      if (count !== null) raw[predicate] = count;
    }
  } catch (exc) {
    // The curse audit degrades, it never aborts.
    log('warn', `curse predicate audit failed: ${exc}`);
  } finally {
    curseTask.finish();
  }

  // Predicates that are exactly a category already fetched.
  for (const predicate of CURSE_FROM_CATEGORY) {
    const category = CURSE_CATEGORY_ALIASES[predicate] || predicate;
    if (Object.prototype.hasOwnProperty.call(geo.counts, category)) {
      raw[predicate] = geo.counts[category];
    }
  }
  // Predicates the density grid answers; map-wide grid totals are exact.
  for (const predicate of CURSE_FROM_DENSITY) {
    if (Object.prototype.hasOwnProperty.call(geo.counts, predicate)) {
      raw[predicate] = geo.counts[predicate];
    }
  }

  for (const [curseId, predicate] of Array.from(CURSE_PREDICATE_MAP)
    .sort((a, b) => cmpStr(a[0], b[0]) || cmpStr(a[1], b[1]))) {
    if (Object.prototype.hasOwnProperty.call(raw, predicate)) counts[curseId] = raw[predicate];
  }
  // Distant Cuisine: restaurants serving a single identifiable foreign country's cuisine.
  if (Object.prototype.hasOwnProperty.call(geo.pois, 'restaurant')) {
    const restaurants = geo.pois.restaurant;
    const host = ((geo.admin.countryCode || '').toUpperCase()) || null;
    counts.distant_cuisine = cuisineDetail(restaurants, host).qualifying;
  }
  return counts;
}

/** (generate.py `_cuisine_tokens`) */
function cuisineTokens(poi) {
  const raw = (poi.tags && poi.tags.cuisine !== undefined) ? poi.tags.cuisine : '';
  return raw.split(';')
    .filter((t) => t.trim() !== '')
    .map((t) => t.trim().toLowerCase().split(' ').join('_'));
}

/**
 * (generate.py `_cuisine_detail`)
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

/** (generate.py `_spot_open_all_hours`) */
function spotOpenAllHours(tags) {
  const hours = ((tags && tags.opening_hours) || '').trim();
  return hours === '' || SPOT_ALL_HOURS_VALUES.includes(hours);
}

/** (generate.py `_spot_public`) */
function spotPublic(tags) {
  for (const key of SPOT_ACCESS_TAG_KEYS) {
    const value = ((tags && tags[key]) || '').trim().toLowerCase();
    if (PRIVATE_ACCESS.includes(value)) return false;
  }
  return true;
}

/**
 * Shortlist candidate legal hiding spots inside each zone circle.
 * (generate.py `legal_endgame_spots`)
 *
 * The rulebook's two hard tests are (a) publicly accessible during all game hours
 * and (b) within 10 ft of a routable path. (b) has an OSM analogue (within 5 m of a
 * foot-accessible `highway` way); **(a) does not**, so this is a shortlist for a
 * human, never a verdict, and the page must say so.
 *
 * Restrictive `opening_hours` (anything but `24/7`) demotes to "verify on the ground"
 * at half weight rather than dropping.
 *
 * `pathOkIds` is a `Set` of `'type/id'` strings, or `null` when the path join was not
 * attempted or failed, in which case EVERY spot is marked verify-on-the-ground.
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
    // Best first, then nearest: the cap must never let a cluster of grass verges
    // push the park off a zone's shortlist.
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
 * A cell counts toward a zone when its CENTRE is within `radiusM` of the zone centre,
 * so a cell straddling the circle edge lands wholly in or out. At ~220 m cells
 * against a ~400 m radius the boundary error is real, which is why every density
 * category is marked `partial`. Map-wide totals in `counts` are exact sums; only the
 * per-zone numbers are fuzzy.
 *
 * @param {Object<string, Object<string, number>>} inventory mutated in place
 * @param {Array<Object>} zones
 * @param {{cells: Array<{lat: number, lon: number, counts: Object<string, number>}>}} density
 * @param {Projection} proj @param {number} radiusM
 */
function mergeDensityIntoInventory(inventory, zones, density, proj, radiusM) {
  // Seed every zone to zero FIRST, even when the grid came back empty: "key absent"
  // must mean "not queried" (`audit.js` drops such zones from the denominator), and
  // `worldDensity` omits zero-valued columns, so a zone with no buildings would
  // otherwise get no `building` key. A present-but-empty grid is a real zero.
  for (const zone of zones) {
    const row = inventory[zone.zoneId] || (inventory[zone.zoneId] = {});
    for (const key of GEO_DENSITY_GRID_CATEGORIES) {
      if (row[key] === undefined) row[key] = 0;
    }
  }
  if (!density.cells.length) return;

  // Index the cells once at the zone radius. Cell size == query radius is what makes
  // `near`'s 3×3 neighbourhood scan complete, as in `buildPoiIndex`.
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
 * (generate.py `_icon_offset_p90`)
 *
 * The honesty number specs/osm.md §3.3 demands: how far our computed icon can sit
 * from where a map app's label puts it.
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
 * (generate.py `_redundant_pairs`)
 *
 * GR's zoo and aquarium are 81 m apart, so the two matching questions are the same
 * bit for six cards (specs/osm.md §7.4).
 *
 * The threshold is a fraction of the map diagonal UNDER AN ABSOLUTE CEILING: the
 * page prints a claim that two icons are effectively in the same place, and a
 * twentieth of a regional border's diagonal (MBTA: 8.4 km) makes that claim false.
 * The cap binds above a ~100 km diagonal.
 */
function redundantPairs(pois, proj, diagonalM) {
  const singles = Object.keys(pois)
    .filter((k) => pois[k].length === 1)
    .sort(cmpStr);
  const out = [];
  const threshold = Math.min(diagonalM * REDUNDANT_PAIR_FRACTION, REDUNDANT_PAIR_MAX_M);
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
 * (generate.py `_synth_coastline`)
 *
 * Returns `[segments, names]`. A water body wholly inside the border is a lake you
 * can walk around, not a coast, and is left to the body-of-water questions.
 */
function synthCoastline(pois, bbox, proj, log) {
  const padded = bboxExpand(bbox, COAST_BBOX_PAD_M);
  const segments = [];
  const names = [];

  // "Larger than the game map", with a floor so a tiny map cannot promote a pond to a sea.
  const [south, west, north, east] = bbox;
  const sw = proj.xy(south, west);
  const ne = proj.xy(north, east);
  const mapArea = Math.abs((ne[0] - sw[0]) * (ne[1] - sw[1]));
  const threshold = Math.max(mapArea, COAST_MIN_AREA_SQM);

  for (const water of Array.from(pois.water || []).sort(cmpTypeId)) {
    if (!water.rings || !water.rings.length) continue;
    // Polygonal water only: a riverbank is not a coast.
    if ((water.tags || {}).natural !== 'water') continue;
    // A real size test, not a clipping test: "some ring point falls outside the
    // border" is also true of every pond near the map edge.
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
          // Negative ids mark a derived feature and keep every segment distinct.
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
 * The `available: false` form of `GeoData` (mirrors `build_report`). The run
 * continues with empty containers; `note` is the single honesty note on the page.
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
      adminSource: 'unknown',
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
 * (generate.py `collect_geodata`)
 *
 * Order: one bbox query per category → the POI index → per-zone inventory → admin
 * resolution → curse predicates → cuisines → legal spots. If not one layer can be
 * read, the CALLER returns `emptyGeoData(...)`; every consumer degrades, never crashes.
 *
 * @param {Object} opts Options
 * @param {Object} border Border
 * @param {Array<Object>} zones
 * @param {Projection} proj
 * @param {number} radiusM
 * @param {{onProgress?: function(number, number, string), onLog?: function(string, string), timezone?: string}
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

  // Estimated round-trips: one per feature category plus three phases (curses, admin,
  // density). The density-grid tallies are columns on one grid read and take no turn
  // of their own; budgeting for them stalls the bar.
  const progress = new Progress(
    h.onProgress,
    GEO_CATEGORIES.length - GEO_DENSITY_GRID_CATEGORIES.length + 3,
  );

  // ── 1. features, one bbox query per category ──────────────────────────────
  //
  // The R-tree yields a free upper bound (`worldCount` reads no feature bytes) and
  // the exact count falls out of the fetch, so count and feature list cannot
  // disagree. `CATEGORY_FEATURE_BUDGET` is applied to that bound as a page-size guard.
  /** @type {Object<string, Array<Object>>} */
  const pois = {};
  /** @type {Object<string, number>} */
  const counts = {};
  const partialCategories = new Set();
  let layersRead = 0;
  /** Distinct per-category failure reasons, kept so the throw below can name a cause. */
  const layerFailures = new Set();

  // THE CATEGORIES ARE READ CONCURRENTLY, AND THE RESULTS ARE APPLIED IN CATALOGUE
  // ORDER. Both statements are load-bearing.
  //
  // Concurrently, because a category is a mostly serial chain of dependent reads and
  // reading them one at a time spent the run's latency in series (19.4 s → 2.0 s).
  //
  // In catalogue order, because the hazard is completion order leaking into the
  // output: the KEY ORDER of `pois` and `counts` survives the structured clone, and
  // `layersRead`, `partialCategories` and `layerFailures` would otherwise record the
  // network's answer order. So the concurrent phase computes only per-category
  // outcomes, and every mutation, log line included, happens afterwards in
  // `GEO_CATEGORIES` order. The result is byte-identical to a sequential read.
  //
  // THE PROGRESS CAPTION IS THE PHASE, NOT THE CATEGORY, for the same reason: the
  // label is output too (`app.js` prints it), and with eight in flight naming any
  // one category would be rendering the network's order. See the rules on `Progress`.
  const featureCategories = GEO_CATEGORIES
    // The tallies are answered by the density grid in step 2, not by a feature layer.
    .filter((c) => !GEO_DENSITY_GRID_CATEGORIES.includes(c.key));
  const outcomes = await mapConcurrent(
    featureCategories, GEO_CATEGORY_CONCURRENCY, async (category) => {
      const key = category.key;
      // A layer the build did not produce degrades that category only, costs no
      // round-trip, and takes no progress task; hence the underrun and `settle`.
      if (worldLayerInfo(world, key) === null) return { key, kind: 'absent' };
      const task = progress.start(GEO_FEATURE_PHASE_LABEL);
      try {
        const upperBound = await worldCount(world, key, bbox);
        if (upperBound !== null && upperBound > CATEGORY_FEATURE_BUDGET) {
          // An upper bound, not a count — say so by marking the category partial.
          return { key, kind: 'counted', upperBound };
        }
        const features = (await worldPois(world, key, key, bbox, proj, {
          keepRings: keepRingsFor(key),
        })) || [];
        return { key, kind: 'read', features };
      } catch (exc) {
        // One dead layer is a caveat; all of them dead is the next check.
        return { key, kind: 'failed', exc };
      } finally {
        task.finish();
      }
    },
  );

  for (const outcome of outcomes) {
    const { key } = outcome;
    if (outcome.kind === 'absent') {
      partialCategories.add(key);
      log('warn', `category ${key}: no world-file layer in the manifest`);
    } else if (outcome.kind === 'counted') {
      counts[key] = outcome.upperBound;
      partialCategories.add(key);
      // A COUNTED LAYER WAS READ: only the feature bytes were skipped. Leaving it out
      // of `layersRead` sent a border where EVERY category is over budget into the
      // fatal branch below, reporting a scale problem as an origin failure.
      layersRead += 1;
      log('warn', `category ${key} has ~${outcome.upperBound} features `
        + `(> ${CATEGORY_FEATURE_BUDGET}): counted, not fetched`);
    } else if (outcome.kind === 'read') {
      pois[key] = outcome.features;
      counts[key] = outcome.features.length;
      layersRead += 1;
    } else {
      const { exc } = outcome;
      partialCategories.add(key);
      layerFailures.add(String((exc && exc.message) ? exc.message : exc));
      log('warn', `category ${key} unavailable: ${exc}`);
    }
  }

  // Not one layer readable is the whole-OSM-layer failure of CONTRACT.md §(f)1; the
  // caller answers with `emptyGeoData`. Throwing on the FIRST failure would turn one
  // missing layer into a dead OSM section.
  if (layersRead === 0) {
    // NOT necessarily an unreachable origin: `openWorld` already fetched manifest.json,
    // and a dead origin fails there with its own message. Carry the real reasons out
    // so a code regression does not read as "the map files were unreachable".
    //
    // The `sort` must not be dropped: this message is output and `layerFailures` is a
    // Set, so sorted, the same broken world always says the same thing.
    const why = Array.from(layerFailures).sort(cmpStr).slice(0, 3).join('; ');
    throw new Error(`world files: no layer could be read${why ? `: ${why}` : ''}`);
  }

  // ── 2. the density grid: the categories that are tallies, not icons ───────
  const densityTask = progress.start('geo:world density grid');
  /** @type {null|{counts: Object<string, number>, cells: Array<Object>, cellDeg: number}} */
  let density = null;
  try {
    density = await worldDensity(world, bbox);
  } catch (exc) {
    log('warn', `density grid unavailable: ${exc}`);
  } finally {
    densityTask.finish();
  }
  for (const key of GEO_DENSITY_GRID_CATEGORIES) {
    // ABSENT, NOT ZERO, when the grid could not be read (§(f) rule 3): a zero
    // propagates through `curseCounts` and removes Bridge Troll, Luxury Car and Right
    // Turn off a failed fetch. An unset key sends `auditCurses` down its
    // `count === null` warn branch instead.
    if (density) counts[key] = density.counts[key] || 0;
    // Partial either way: exact map-wide, never a measured per-zone figure.
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
  // `selector` carries the Overpass QL (the category's definition, which a player
  // can paste into overpass-turbo); `endpoint` names the file the number actually
  // came from and its planet snapshot.
  for (const category of GEO_CATEGORIES) {
    const key = category.key;
    const counted = counts[key];
    if (counted === undefined) continue;
    const onGrid = GEO_DENSITY_GRID_CATEGORIES.includes(key);
    queries.push({
      key,
      selector: ovSub(category.selector, bbox),
      bbox: Array.from(bbox),
      count: counted,
      cacheKey: '',
      endpoint: worldProvenance(world, onGrid ? 'density' : key),
      partial: partialCategories.has(key),
    });
  }

  // ── 4. per-zone inventory (two predicates, never interchanged) ────────────
  const [inventory, polygonHits] = zoneInventory(zones, pois, proj, radiusM);
  // Density categories have no features to inventory, so their per-zone figures are
  // attributed from grid cells. Merged in, not computed inside `zoneInventory`, so
  // the exact and approximate predicates stay visibly separate.
  if (density) mergeDensityIntoInventory(inventory, zones, density, proj, radiusM);

  // ── 5. place, country and the administrative ladder ──────────────────────
  const admin = await adminInfo(world, zones, bbox, { progress, log, timezone: h.timezone });
  if (zones.length) {
    queries.push({
      key: 'admin-containment',
      selector: 'boundary=administrative, admin_level 2–10, tested locally against '
        + `${num(zones.length)} zone centres`,
      bbox: Array.from(bbox),
      count: Object.keys(admin.perZone).length,
      cacheKey: '',
      endpoint: worldProvenance(world, 'admin'),
      partial: Object.keys(admin.perZone).length === 0,
    });
  }

  /** @type {Object} GeoData */
  const geo = {
    available: true,
    bbox: Array.from(bbox),
    pois,
    counts,
    zoneInventory: inventory,
    zonePolygonHits: polygonHits,
    admin,
    curseCounts: {},
    cuisines: {},
    legalSpots: {},
    queries,
    notes,
  };

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
  // The "within 10 ft of a routable path" join is not evaluated: it needs the whole
  // walkable network, the one layer too dense to ship. `pathIds` is null, every
  // candidate spot comes back `verify: true` at `SPOT_VERIFY_WEIGHT`, and the note
  // says so. This is CONTRACT.md §(f)2's degradation-in-place, made permanent.
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
      'These counts were not confirmed by reading the features and are marked partial — '
      + 'either the category was too large to fetch, leaving an upper bound, or the layer '
      + 'could not be read: '
      + `${partialKeys.join(', ')}.`,
    );
  }
  notes.push(
    'Counts reflect one OpenStreetMap snapshot, taken when the map files were built rather '
    + 'than when this page was generated — the snapshot date is on the provenance table. '
    + 'The files are immutable, so two runs against the same build agree exactly.',
  );

  geo.notes = notes;
  geo.queries = Array.from(queries)
    .sort((a, b) => cmpStr(a.key, b.key) || cmpStr(a.cacheKey, b.cacheKey));
  progress.settle('geo:done');
  return geo;
}
