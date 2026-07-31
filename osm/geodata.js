/**
 * osm/geodata.js — S2 · GEO, the OSM semantic layer.
 *
 * Port of generate.py lines 4454–6356 (everything in S2 except the raw transport,
 * which lives in ./overpass.js). WORKER SIDE ONLY — no DOM, no window, no document.
 *
 * Etiquette is a hard requirement, not a nicety: ONE bbox-wide query per category
 * group, never one per stop (1,493 stops × 16 categories would be 24,000 requests
 * and a ban). The whole reference dataset was six Overpass calls and one Nominatim
 * call. Overpass bbox order is (S, W, N, E) — the opposite of GeoJSON. Mirror
 * failover is required; the main endpoint 504'd on five of six first attempts.
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
 * Everything between those two — a dead group, a dead tile, a dead category, a dead
 * Nominatim, a dead is_in, a dead curse audit — degrades in place with a warning and
 * a `partial` provenance row.
 */

import {
  num, pct, quantile, sha256Text,
} from '../lib/core.js';
import {
  Projection, GridIndex, haversineM, bboxExpand, bboxContains,
  polygonArea, pointInRing, segPointDist, ringWithin,
} from '../lib/geo.js';
import {
  OVERPASS_ENDPOINTS, NOMINATIM_ENDPOINT, OVERPASS_WAY_BUDGET,
} from '../lib/http.js';
import { CacheMiss } from '../lib/cache.js';
import {
  overpassQL, overpassQuery, parseOverpass, tileBbox, nominatimReverse,
} from './overpass.js';

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

export const OVERPASS_QL_TIMEOUT_S = 300;      // the [timeout:N] header inside the QL itself
export const OVERPASS_TILE_DEG = 0.1;          // ≤0.1° squares when a single-shot fetch fails
export const CATEGORY_FEATURE_BUDGET = 40000;  // above this, a category is counted but not fetched
export const IS_IN_BATCH = 150;                // zone centres per batched is_in request
export const LEGAL_SPOTS_PER_ZONE = 40;        // cap on the per-zone shortlist (page size guard)
export const TOILET_WIDE_FACTOR = 1.5;         // A1's "just outside the circle" fallback ring
export const REDUNDANT_PAIR_FRACTION = 0.05;   // 1/20 of the map diagonal (specs/osm.md §7.4)
export const LEGAL_PATH_RADIUS_M = 5;          // OSM analogue of the rulebook's 10 ft
export const LEGAL_PATH_QL_TIMEOUT_S = 120;    // the optional path join gets a small server budget
export const LEGAL_PATH_HTTP_TIMEOUT_S = 150.0;// …and one attempt per mirror, not two
// Buffering every walkable way by 5 m is the most expensive thing this program can ask
// a shared free service to do. Measured on the reference bbox (84,466 non-motorway
// highway ways) it timed out on all three mirrors, twice, costing 7½ minutes for an
// optional refinement. So it is only attempted on maps whose walkable network is small
// enough for the join to be cheap; above the budget the test is skipped and every
// candidate spot is honestly marked verify-on-the-ground.
export const LEGAL_PATH_JOIN_WAY_BUDGET = 40000;
export const SPOT_VERIFY_WEIGHT = 0.5;         // restrictive opening_hours ⇒ half weight

// Which categories are fetched as features, grouped into as few Overpass requests
// as the size guard allows. One request per group; statements are separated in the
// response by `out count;` markers so attribution is never guessed.
export const GEO_FETCH_GROUPS = Object.freeze([
  Object.freeze(['landmarks', Object.freeze([
    'advertising', 'amusement_park', 'aquarium', 'bench', 'coastline',
    'commercial_airport', 'foreign_consulate', 'golf_course', 'high_speed_rail',
    'hospital', 'library', 'mountain', 'movie_theater', 'museum', 'newsagent',
    'platform', 'rail_station', 'shelter', 'toilets', 'zoo'])]),
  Object.freeze(['areas', Object.freeze(['park', 'water'])]),
  Object.freeze(['amenities', Object.freeze([
    'cafe', 'fast_food', 'grocery', 'place_of_worship', 'restaurant', 'shop', 'tree'])]),
  Object.freeze(['cover', Object.freeze(['green', 'pitch'])]),
]);

// Descriptive: the categories no group fetches. They are counted map-wide and never
// pulled as features, because they are densities rather than icons and their geometry
// would be tens of megabytes in service of no question.
export const GEO_COUNT_ONLY = Object.freeze(['bridge', 'car_street', 'footpath', 'street']);

// Fetched with `out center qt` — a pure density tally, the one place where the
// bbox centre is acceptable (specs/osm.md §3.1).
export const GEO_DENSITY_ONLY = Object.freeze(['building']);

// Rings are kept only where a containment test is actually asked for. The photo
// questions ask "is the hider standing in a park", the matching/measuring ones ask
// about the icon; the two predicates must never be interchanged.
export const RING_CATEGORIES = Object.freeze(['commercial_airport', 'park', 'water']);

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

// The candidate set the server-side 5 m path join asks about. Wider than
// LEGAL_SPOT_CATEGORIES on purpose: the join is one request either way, and a
// superset costs nothing while keeping the filter usable if the table above grows.
export const LEGAL_PATH_CANDIDATE_SELECTOR =
  'nwr["leisure"~"^(park|garden|playground|pitch|recreation_ground|common|nature_reserve)$"]({{bbox}});'
  + 'nwr["amenity"~"^(bench|shelter|library|place_of_worship|toilets|marketplace|townhall)$"]({{bbox}});'
  + 'nwr["landuse"~"^(forest|grass|meadow|village_green|recreation_ground)$"]({{bbox}});'
  + 'nwr["public_transport"="platform"]({{bbox}});nwr["railway"="platform"]({{bbox}});';

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

/** The 16-hex handle the cache entry is named after — printed in §Provenance. */
async function cacheKey16(query) {
  return (await sha256Text(query)).slice(0, 16);
}

/**
 * `out geom` everywhere a distance or a ring is compared; `out center qt` only for
 * the pure density tally (buildings), per specs/osm.md §1.4 and §3.1.
 */
function outDirective(category) {
  return GEO_DENSITY_ONLY.includes(category.key) ? 'out center qt;' : 'out geom;';
}

function keepRingsFor(key) { return RING_CATEGORIES.includes(key); }
function keepTagsFor(key) { return !GEO_DENSITY_ONLY.includes(key); }

/** A cache miss under `--offline` is a hard error and must never be swallowed. */
function isCacheMiss(err) {
  return (typeof CacheMiss === 'function' && err instanceof CacheMiss)
    || (err && err.name === 'CacheMiss');
}

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

/** Python truthiness for a possibly-empty dict: `{}` is falsy there, truthy here. */
function nonEmptyObject(o) {
  return Boolean(o) && typeof o === 'object' && Object.keys(o).length > 0;
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

/**
 * Split an `out …; out count;`-per-statement response into per-statement blocks.
 *
 * Overpass returns every statement's elements concatenated in statement order with
 * nothing between them, so the trailing `out count;` of each statement is used as an
 * explicit terminator *and* as a checksum: the block length must equal the count.
 * Without this, a partially failed query silently shifts every category's features
 * onto the wrong category.
 */
function splitStatements(data, expected, what) {
  const blocks = [];
  let current = [];
  for (const element of (data.elements || [])) {
    if (element && element.type === 'count') {
      const tags = element.tags || {};
      const total = tags.total !== undefined ? parseInt(tags.total, 10) : current.length;
      if (total !== current.length) {
        throw new Error(`Overpass ${what}: statement ${blocks.length} returned `
          + `${current.length} elements but counted ${total}`);
      }
      blocks.push(current);
      current = [];
    } else {
      current.push(element);
    }
  }
  if (current.length) {
    throw new Error(`Overpass ${what}: ${current.length} trailing elements with no count marker`);
  }
  if (blocks.length !== expected) {
    throw new Error(`Overpass ${what}: expected ${expected} statements, got ${blocks.length}`);
  }
  return blocks;
}

/** The exact QL text `overpassCounts` sends — also the cache key. */
function countsQueryBody(selectors) {
  return selectors.map(([, sel]) => `(${sel});out count;`).join('');
}

function countsQuery(bbox, selectors) {
  return overpassQL(countsQueryBody(selectors), bbox, { timeoutS: OVERPASS_QL_TIMEOUT_S });
}

/**
 * Map-level audit in ONE request, using `out count`.
 *
 * `selectors` is `[key, selector]` pairs; each becomes a statement followed by
 * `out count;`. Responses come back as `type:"count"` elements **in statement
 * order**, so assert the arity before zipping — a partially failed query silently
 * returns fewer, and mis-zipping would attribute one category's count to another.
 * 28 categories cost one request and ~4 kB.
 */
async function overpassCounts(cache, bbox, selectors) {
  const data = await overpassQuery(cache, countsQuery(bbox, selectors));
  const counts = (data.elements || []).filter((e) => e && e.type === 'count');
  if (counts.length !== selectors.length) {
    throw new Error(`Overpass count audit: asked ${selectors.length} statements, `
      + `got ${counts.length} counts`);
  }
  const out = {};
  for (let i = 0; i < selectors.length; i++) {
    const tags = counts[i].tags || {};
    out[selectors[i][0]] = parseInt(tags.total !== undefined ? tags.total : 0, 10) || 0;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Category fetching
// ═══════════════════════════════════════════════════════════════════════════════

function categoryQuery(category, bbox) {
  return overpassQL(`(${ovSelector(category)});${outDirective(category)}`, bbox,
    { timeoutS: OVERPASS_QL_TIMEOUT_S });
}

/**
 * Fetch one category bbox-wide and reduce it to `Poi` records.
 *
 * Uses `out geom` when geometry is required and `out center qt` for the density
 * tally. Applies the representative-point rule, deduplicates a node inside a
 * same-category polygon in favour of the polygon, and returns sorted by
 * `(osmType, osmId)`.
 *
 * When the size guard trips, tiles the bbox into ≤0.1° squares, caches per tile, and
 * the caller marks the result `partial` — a size failure must never become a `0`
 * that reads as "this category does not exist here".
 */
async function fetchCategory(cache, category, bbox, proj, progress, log) {
  const selector = ovSelector(category);
  const opts = { keepRings: keepRingsFor(category.key), keepTags: keepTagsFor(category.key) };
  const query = categoryQuery(category, bbox);
  progress.start(`geo:overpass ${category.key}`);
  try {
    const data = await overpassQuery(cache, query);
    return parseOverpass(data.elements || [], category.key, proj, opts);
  } catch (exc) {
    if (isCacheMiss(exc)) throw exc;
    // A too-big or timed-out fetch degrades to tiles.
    log('warn', `category ${category.key} failed whole-bbox (${exc}); tiling`);
  } finally {
    progress.finish();
  }

  /** @type {Map<string, Object>} */
  const merged = new Map();
  let failures = 0;
  const tiles = tileBbox(bbox, OVERPASS_TILE_DEG);
  progress.grow(tiles.length);
  for (const tile of tiles) {
    const tileQuery = overpassQL(`(${selector});${outDirective(category)}`, tile,
      { timeoutS: OVERPASS_QL_TIMEOUT_S });
    progress.start(`geo:overpass ${category.key} tile ${ovBbox(tile)}`);
    let data;
    try {
      data = await overpassQuery(cache, tileQuery);
    } catch (exc) {
      if (isCacheMiss(exc)) throw exc;
      // One dead tile is a floor, not a zero.
      failures += 1;
      log('warn', `category ${category.key} tile ${ovBbox(tile)} failed: ${exc}`);
      continue;
    } finally {
      progress.finish();
    }
    for (const poi of parseOverpass(data.elements || [], category.key, proj, opts)) {
      merged.set(`${poi.osmType}\u001f${poi.osmId}`, poi);
    }
  }
  if (failures) {
    log('warn', `category ${category.key}: ${failures} tiles failed; count is a floor`);
  }
  return Array.from(merged.values()).sort(cmpTypeId);
}

/**
 * Fetch several categories in ONE request, attributing results by count marker.
 *
 * Returns `[category key → pois, cacheKey]`. On any failure the caller falls back to
 * per-category fetches, which cost more requests but survive one bad selector.
 */
async function fetchGroup(cache, categories, bbox, proj, label, progress) {
  const body = categories
    .map((c) => `(${ovSelector(c)});${outDirective(c)}out count;`)
    .join('');
  const query = overpassQL(body, bbox, { timeoutS: OVERPASS_QL_TIMEOUT_S });
  progress.start(`geo:overpass ${label}`);
  let data;
  try {
    data = await overpassQuery(cache, query);
  } finally {
    progress.finish();
  }
  const blocks = splitStatements(data, categories.length, `group ${label}`);
  const out = {};
  for (let i = 0; i < categories.length; i++) {
    out[categories[i].key] = parseOverpass(blocks[i], categories[i].key, proj, {
      keepRings: keepRingsFor(categories[i].key),
      keepTags: keepTagsFor(categories[i].key),
    });
  }
  return [out, await cacheKey16(query)];
}

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

// ═══════════════════════════════════════════════════════════════════════════════
// Nominatim and administrative divisions
// ═══════════════════════════════════════════════════════════════════════════════

function nominatimParams(lat, lon) {
  return {
    addressdetails: '1',
    extratags: '1',
    format: 'jsonv2',
    lat: lat.toFixed(6),
    lon: lon.toFixed(6),
    zoom: '10',
  };
}

/** The fully-substituted request URL — the cache key and the provenance line. */
function nominatimUrl(lat, lon) {
  const params = nominatimParams(lat, lon);
  return `${NOMINATIM_ENDPOINT}?${Object.keys(params).sort(cmpStr)
    .map((k) => `${k}=${params[k]}`).join('&')}`;
}

/** The exact QL one batched containment request sends — also its cache key. */
function isInQuery(batch, bbox) {
  const body = batch
    .map(([lat, lon]) => `is_in(${lat.toFixed(6)},${lon.toFixed(6)});out tags;out count;`)
    .join('');
  return overpassQL(body, bbox, { timeoutS: OVERPASS_QL_TIMEOUT_S });
}

/**
 * Batched `is_in` containment lookup. Returns per-point tag objects and cache keys.
 *
 * `is_in` yields **area** objects, so a `relation.a[...]` filter silently returns
 * nothing; the result is filtered on the returned elements' own tags instead. The
 * `out count;` after each `out tags;` is what makes a batched response separable —
 * without it every point's hierarchy is one undifferentiated list.
 */
async function isInAreas(cache, points, bbox, progress) {
  const perPoint = [];
  const keys = [];
  for (let start = 0; start < points.length; start += IS_IN_BATCH) {
    const batch = points.slice(start, start + IS_IN_BATCH);
    const query = isInQuery(batch, bbox);
    progress.start('geo:overpass admin containment');
    let data;
    try {
      data = await overpassQuery(cache, query);
    } finally {
      progress.finish();
    }
    keys.push(await cacheKey16(query));
    for (const block of splitStatements(data, batch.length, 'is_in')) {
      perPoint.push(block.map((e) => {
        const raw = (e && e.tags) || {};
        const tags = {};
        for (const k of Object.keys(raw).sort(cmpStr)) tags[String(k)] = String(raw[k]);
        return tags;
      }));
    }
  }
  return [perPoint, keys];
}

/** (generate.py `_admin_level`, line 5489) */
function adminLevel(tags) {
  const value = tags.admin_level !== undefined ? tags.admin_level : '';
  // Python's str.isdigit(): non-empty and every character a digit.
  if (value !== '' && /^\d+$/.test(value)) return parseInt(value, 10);
  return null;
}

/**
 * `ISO3166-2-lvl<N>` ⇒ N is the country's first-division `admin_level`.
 * (generate.py `_iso_lvl_from_nominatim`, line 5496)
 */
function isoLvlFromNominatim(nominatim) {
  if (!nonEmptyObject(nominatim)) return null;
  const address = nominatim.address || {};
  const levels = [];
  for (const key of Object.keys(address).sort(cmpStr)) {
    const m = /^ISO3166-2-lvl(\d+)$/.exec(key);
    if (m) levels.push(parseInt(m[1], 10));
  }
  return levels.length ? Math.min(...levels) : null;
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
export async function adminInfo(cache, zones, bbox, nominatim, hooks = {}) {
  const progress = hooks.progress || new Progress(null, 0);
  const log = hooks.log || noopLog;

  const ordered = Array.from(zones).sort((a, b) => cmpStr(a.zoneId, b.zoneId));
  const points = ordered.map((z) => [z.lat, z.lon]);
  let perPoint = [];
  if (points.length) {
    try {
      [perPoint] = await isInAreas(cache, points, bbox, progress);
    } catch (exc) {
      if (isCacheMiss(exc)) throw exc;
      // Admin questions degrade to `unknown`.
      log('warn', `is_in containment lookup failed: ${exc}`);
      perPoint = [];
    }
  }

  // Per-zone {admin_level: name}, plus the map-wide level census.
  /** @type {Map<string, Map<number, string>>} */
  const perZoneLevels = new Map();
  const levelsPresent = new Set();
  let iso1Country = null;
  let iso2Level = null;
  let countryName = null;
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
      if (tags['ISO3166-1']) {
        iso1Country = iso1Country || tags['ISO3166-1'].toLowerCase();
        countryName = countryName || name;
      }
      if (tags['ISO3166-2'] && iso2Level === null) iso2Level = level;
    }
    perZoneLevels.set(zone.zoneId, ladder);
  }

  // Country identity: Nominatim first, `is_in`'s ISO3166-1 tag as the free fallback.
  let countryCode = null;
  let placeName = null;
  let source = 'unknown';
  if (nonEmptyObject(nominatim)) {
    const address = nominatim.address || {};
    const cc = String(address.country_code !== undefined ? address.country_code : '').toLowerCase();
    countryCode = cc || null;
    countryName = String(address.country !== undefined ? address.country : '') || countryName;
    for (const fieldName of ['city', 'town', 'village', 'municipality', 'borough', 'suburb',
      'county', 'state', 'region']) {
      if (address[fieldName]) { placeName = String(address[fieldName]); break; }
    }
    if (!placeName && nominatim.name) placeName = String(nominatim.name);
    source = 'nominatim';
  }
  if (countryCode === null && iso1Country) {
    countryCode = iso1Country;
    source = 'is_in';
  } else if (source === 'unknown' && perZoneLevels.size) {
    source = 'is_in';
  }

  // Ordinal ladder. Derived, never guessed.
  const first = isoLvlFromNominatim(nominatim) || iso2Level || null;
  /** @type {Object<string, number|null>} */
  const ordinals = { 1: null, 2: null, 3: null, 4: null };
  const override = ADMIN_ORDINAL_OVERRIDES[countryCode || ''];
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
  // zones sit in Grand Rapids. Nominatim's answer is the fallback, not the source.
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

  // Does a boundary LINE cross the map? Ordinal 0 is the international border.
  const wanted = [[0, 2]];
  for (const ordinal of [1, 2, 3, 4]) {
    const level = ordinals[ordinal];
    if (level !== null && level !== undefined) wanted.push([ordinal, level]);
  }
  /** @type {Object<string, boolean>} */
  const borderLevels = {};
  if (wanted.length) {
    const body = wanted.map(([ordinal, level]) => (
      `relation["boundary"="administrative"]["admin_level"="${level}"]`
      + `({{bbox}})->.a${ordinal};way(r.a${ordinal})({{bbox}});out count;`
    )).join('');
    progress.start('geo:overpass admin borders');
    try {
      const data = await overpassQuery(cache,
        overpassQL(body, bbox, { timeoutS: OVERPASS_QL_TIMEOUT_S }));
      const counts = (data.elements || []).filter((e) => e && e.type === 'count');
      if (counts.length === wanted.length) {
        for (let i = 0; i < wanted.length; i++) {
          const tags = counts[i].tags || {};
          borderLevels[wanted[i][0]] =
            (parseInt(tags.total !== undefined ? tags.total : 0, 10) || 0) > 0;
        }
      } else {
        log('warn', `admin border audit returned ${counts.length} of ${wanted.length} counts`);
      }
    } catch (exc) {
      if (isCacheMiss(exc)) throw exc;
      log('warn', `admin border audit failed: ${exc}`);
    } finally {
      progress.finish();
    }
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
 * Evaluate every OSM-decided curse predicate in one `out count` request.
 * (generate.py `curse_predicates`, line 5687 — exported as `curseCounts`)
 *
 * Returns `curseId → count`. Removal is `count === 0` for the hard tier; the warn
 * tier is reported with its count and never auto-removed. Two predicates are *not*
 * OSM: Unguided Tourist (the static Street View country table) and U-Turn (GTFS
 * route overlap and wait times) — those are decided elsewhere and must not be
 * invented here.
 */
export async function curseCounts(cache, bbox, geo, hooks = {}) {
  const progress = hooks.progress || new Progress(null, 0);
  const log = hooks.log || noopLog;
  const counts = {};
  let raw = {};
  progress.start('geo:overpass curse predicates');
  try {
    raw = await overpassCounts(cache, bbox, CURSE_PREDICATE_SELECTORS);
  } catch (exc) {
    if (isCacheMiss(exc)) throw exc;
    // The curse audit degrades, it never aborts.
    log('warn', `curse predicate audit failed: ${exc}`);
    raw = {};
  } finally {
    progress.finish();
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
 * Ids of candidate spot features within 5 m of a foot-routable way.
 * (generate.py `_fetch_path_adjacent_ids`, line 5891)
 *
 * The join runs **server-side** (`around.paths:5`) and returns `out ids` — a few kB
 * instead of the ~40 MB the foot-way geometry would cost. Returns `null` ids when the
 * query fails, which the caller reports as "the path test could not be applied"
 * rather than silently dropping every spot.
 *
 * This is the one *optional* request in the pipeline, and the most expensive one for
 * the server (a 5 m buffer around every walkable way in the map). It therefore runs
 * on a deliberately small budget — one attempt per mirror, a short server-side
 * timeout — so a busy Overpass costs the run a couple of minutes and a caveat rather
 * than half an hour.
 *
 * @returns {Promise<[Set<string>|null, string, number]>}
 */
async function fetchPathAdjacentIds(cache, bbox, progress, log) {
  const body = `(${FOOT_WAY_SELECTOR})->.paths;`
    + `(${LEGAL_PATH_CANDIDATE_SELECTOR})->.cand;`
    + `(node.cand(around.paths:${LEGAL_PATH_RADIUS_M});`
    + `way.cand(around.paths:${LEGAL_PATH_RADIUS_M});`
    + `relation.cand(around.paths:${LEGAL_PATH_RADIUS_M}););out ids;`;
  const query = overpassQL(body, bbox, { timeoutS: LEGAL_PATH_QL_TIMEOUT_S });
  const key = await cacheKey16(query);
  progress.start('geo:overpass path proximity join');
  let data;
  try {
    data = await overpassQuery(cache, query, {
      attemptsPerEndpoint: 1,
      timeoutS: LEGAL_PATH_HTTP_TIMEOUT_S,
    });
    if (!data || !Array.isArray(data.elements)) throw new Error('no elements array');
  } catch (exc) {
    if (isCacheMiss(exc)) throw exc;
    log('warn', `legal-spot path filter unavailable: ${exc}`);
    return [null, key, 0];
  } finally {
    progress.finish();
  }
  const ids = new Set();
  for (const e of data.elements) {
    if (e && (e.type === 'node' || e.type === 'way' || e.type === 'relation')) {
      ids.add(`${e.type}/${parseInt(e.id, 10)}`);
    }
  }
  return [ids, key, ids.size];
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
 * that need it → the POI index → per-zone inventory → Nominatim → admin resolution →
 * curse predicates → cuisines → legal spots. Under `--no-osm`, or if Overpass fails
 * outright, the CALLER returns `emptyGeoData(...)`; every downstream consumer must
 * degrade rather than crash.
 *
 * Budget on the reference map: ~10 requests, ~40 MB, once, then cached.
 *
 * @param {Object} cache
 * @param {Object} opts Options
 * @param {Object} border Border
 * @param {Array<Object>} zones
 * @param {Projection} proj
 * @param {number} radiusM
 * @param {{onProgress?: function(number, number, string), onLog?: function(string, string)}
 *        | function(number, number, string)} [hooks]
 * @returns {Promise<Object>} GeoData
 */
export async function collectGeodata(cache, opts, border, zones, proj, radiusM, hooks = {}) {
  const h = typeof hooks === 'function' ? { onProgress: hooks } : (hooks || {});
  const log = typeof h.onLog === 'function' ? h.onLog : noopLog;

  const bbox = border.bbox;
  const catalogue = geoCategories();
  /** @type {Array<Object>} */
  const queries = [];
  /** @type {Array<string>} */
  const notes = [];

  // Estimated round-trips: count audit + 4 groups + buildings + nominatim + is_in
  // batches + admin borders + curse audit + path join. `total` may grow when a group
  // falls back to per-category fetches or a category has to be tiled.
  const isInBatches = zones.length ? Math.ceil(zones.length / IS_IN_BATCH) : 0;
  const progress = new Progress(h.onProgress,
    1 + GEO_FETCH_GROUPS.length + 1 + 1 + isInBatches + 1 + 1 + 1);

  // ── 1. one-request map-level audit ────────────────────────────────────────
  const auditPairs = GEO_CATEGORIES.map((c) => [c.key, ovSelector(c)]);
  const auditQueryText = countsQuery(bbox, auditPairs);
  progress.start('geo:overpass category audit');
  let counts;
  try {
    // Raises ⇒ the caller degrades the whole OSM layer.
    counts = await overpassCounts(cache, bbox, auditPairs);
  } finally {
    progress.finish();
  }
  const auditKey = await cacheKey16(auditQueryText);

  // ── 2. features, one request per group, per-category fallback ─────────────
  /** @type {Object<string, Array<Object>>} */
  const pois = {};
  /** @type {Object<string, string>} */
  const fetchKeys = {};
  const partialCategories = new Set();
  for (const [label, keys] of GEO_FETCH_GROUPS) {
    let group = keys.filter((k) => catalogue.has(k)).map((k) => catalogue.get(k));
    const big = group.filter((c) => (counts[c.key] || 0) > CATEGORY_FEATURE_BUDGET);
    group = group.filter((c) => !big.includes(c));
    for (const category of big) {
      partialCategories.add(category.key);
      log('warn', `category ${category.key} has ${counts[category.key] || 0} features `
        + `(> ${CATEGORY_FEATURE_BUDGET}): counted, not fetched`);
    }
    if (group.length) {
      try {
        const [fetched, key] = await fetchGroup(cache, group, bbox, proj, label, progress);
        for (const category of group) {
          pois[category.key] = fetched[category.key] || [];
          fetchKeys[category.key] = key;
        }
      } catch (exc) {
        if (isCacheMiss(exc)) throw exc;
        // One bad selector must not kill the group.
        log('warn', `group ${label} failed (${exc}); falling back to per-category fetches`);
        progress.grow(group.length);
        for (const category of group) {
          try {
            pois[category.key] = await fetchCategory(cache, category, bbox, proj, progress, log);
            fetchKeys[category.key] = await cacheKey16(categoryQuery(category, bbox));
          } catch (inner) {
            if (isCacheMiss(inner)) throw inner;
            partialCategories.add(category.key);
            log('warn', `category ${category.key} unavailable: ${inner}`);
          }
        }
      }
    }
  }

  // Buildings: a pure density tally, and the only place `out center` is allowed.
  const building = catalogue.get('building');
  if (building !== undefined) {
    const nBuildings = counts.building || 0;
    if (nBuildings > 0 && nBuildings <= OVERPASS_WAY_BUDGET) {
      try {
        pois.building = await fetchCategory(cache, building, bbox, proj, progress, log);
        fetchKeys.building = await cacheKey16(categoryQuery(building, bbox));
      } catch (exc) {
        if (isCacheMiss(exc)) throw exc;
        partialCategories.add('building');
        log('warn', `building density fetch failed: ${exc}`);
      }
    } else if (nBuildings > OVERPASS_WAY_BUDGET) {
      partialCategories.add('building');
      notes.push(
        `${num(nBuildings)} buildings is above the ${num(OVERPASS_WAY_BUDGET)}-way fetch `
        + 'budget, so per-zone building counts were not computed; the map-wide count is exact.',
      );
    }
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
  for (const category of GEO_CATEGORIES) {
    const selector = ovSelector(category);
    const counted = counts[category.key];
    if (counted === undefined) continue;
    queries.push({
      key: category.key,
      selector: ovSub(selector, bbox),
      bbox: Array.from(bbox),
      count: counted,
      cacheKey: fetchKeys[category.key] !== undefined ? fetchKeys[category.key] : auditKey,
      endpoint: OVERPASS_ENDPOINTS[0],
      partial: partialCategories.has(category.key),
    });
  }

  // ── 4. per-zone inventory (two predicates, never interchanged) ────────────
  const [inventory, polygonHits] = zoneInventory(zones, pois, proj, radiusM);

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
  // Probe the mean of the zone centres, not the bbox centre: the network's centre of
  // mass is where the map actually is, and a bounding box's middle can easily be a
  // field. Falls back to the bbox centre when there are no zones at all.
  const [s, w, n, e] = bbox;
  let probe;
  if (zones.length) {
    const ordered = Array.from(zones).sort((a, b) => cmpStr(a.zoneId, b.zoneId));
    probe = [
      ordered.reduce((acc, z) => acc + z.lat, 0) / ordered.length,
      ordered.reduce((acc, z) => acc + z.lon, 0) / ordered.length,
    ];
  } else {
    probe = [(s + n) / 2.0, (w + e) / 2.0];
  }
  let nominatim = null;
  progress.start('geo:nominatim reverse geocode');
  try {
    const got = await nominatimReverse(cache, probe[0], probe[1]);
    // Python's `if nominatim:` treats `{}` as absent. Normalise here, once.
    nominatim = nonEmptyObject(got) ? got : null;
  } catch (exc) {
    if (isCacheMiss(exc)) throw exc;
    // is_in carries the ISO code as a free fallback.
    log('warn', `Nominatim unavailable (${exc}); falling back to is_in tags`);
  } finally {
    progress.finish();
  }
  if (nominatim) {
    const url = nominatimUrl(probe[0], probe[1]);
    queries.push({
      key: 'nominatim-reverse',
      selector: url,
      bbox: Array.from(bbox),
      count: 1,
      cacheKey: await cacheKey16(url),
      endpoint: NOMINATIM_ENDPOINT,
      partial: false,
    });
  }
  geo.admin = await adminInfo(cache, zones, bbox, nominatim, { progress, log });
  if (zones.length) {
    const orderedPoints = Array.from(zones)
      .sort((a, b) => cmpStr(a.zoneId, b.zoneId)).map((z) => [z.lat, z.lon]);
    queries.push({
      key: 'admin-containment',
      selector: `is_in(lat,lon);out tags;out count;  × ${num(zones.length)} zone centres, `
        + `batched ${IS_IN_BATCH} per request`,
      bbox: Array.from(bbox),
      count: Object.keys(geo.admin.perZone).length,
      cacheKey: await cacheKey16(isInQuery(orderedPoints.slice(0, IS_IN_BATCH), bbox)),
      endpoint: OVERPASS_ENDPOINTS[0],
      partial: Object.keys(geo.admin.perZone).length === 0,
    });
  }

  // ── 6. cuisines, then the curse audit that consumes them ─────────────────
  const host = ((geo.admin.countryCode || '').toUpperCase()) || null;
  const restaurants = pois.restaurant || [];
  const { perCountry, qualifying, tagged, total, rejected } = cuisineDetail(restaurants, host);
  geo.cuisines = perCountry;
  geo.curseCounts = await curseCounts(cache, bbox, geo, { progress, log });
  queries.push({
    key: 'curse-audit',
    selector: CURSE_PREDICATE_SELECTORS
      .map(([k, sel]) => `${k}: ${ovSub(sel, bbox)}`).join('; '),
    bbox: Array.from(bbox),
    count: Object.keys(geo.curseCounts).length,
    cacheKey: await cacheKey16(countsQuery(bbox, CURSE_PREDICATE_SELECTORS)),
    endpoint: OVERPASS_ENDPOINTS[0],
    partial: Object.keys(geo.curseCounts).length === 0,
  });

  // ── 7. candidate legal endgame spots ─────────────────────────────────────
  const walkableWays = counts.street || 0;
  let pathIds = null;
  let pathKey = '';
  let pathN = 0;
  if (walkableWays && walkableWays > LEGAL_PATH_JOIN_WAY_BUDGET) {
    // The most expensive query in the pipeline is not attempted at all on a large map.
    log('info', `path proximity join skipped: ${walkableWays} walkable ways `
      + `> ${LEGAL_PATH_JOIN_WAY_BUDGET}`);
    notes.push(
      'The rulebook\'s “within 10 ft of a routable path” test was not evaluated: '
      + `this map has ${num(walkableWays)} walkable ways, and asking a shared Overpass mirror to `
      + 'buffer all of them is not a polite request. Every candidate spot below is therefore '
      + 'marked verify-on-the-ground.',
    );
  } else {
    [pathIds, pathKey, pathN] = await fetchPathAdjacentIds(cache, bbox, progress, log);
    queries.push({
      key: 'legal-spot-path-filter',
      selector: `(${ovSub(FOOT_WAY_SELECTOR, bbox)})->.paths; candidate features `
        + `(around.paths:${LEGAL_PATH_RADIUS_M}); out ids;`,
      bbox: Array.from(bbox),
      count: pathN,
      cacheKey: pathKey,
      endpoint: OVERPASS_ENDPOINTS[0],
      partial: pathIds === null,
    });
  }
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
  if (pathIds === null && pathKey) {
    notes.push(
      'The “within 10 ft of a routable path” test could not be evaluated (the '
      + 'Overpass proximity join failed), so every candidate spot below is marked '
      + 'verify-on-the-ground.',
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
