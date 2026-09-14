// ═══════════════════════════════════════════════════════════════════════════════
// S3 · THE CATALOGUE — the rulebook as data
// ═══════════════════════════════════════════════════════════════════════════════
//
// Transcribed from specs/rules.json (itself read off GUIDE.md / HIDING.md /
// SEEKING.md and the 24 curse card faces). Question text is verbatim. Ids follow
// contract.md §5.1/§5.2 (`radar.5mi`, `matching.admin_1`, `tentacle.metro_line`).
//
// This is data: the literal must be complete (80 questions, 24 curses, 3 sizes)
// and its counts are asserted at import time.

/**
 * One of the rulebook's 80 questions. Positional parameters mirror generate.py's
 * `QuestionDef`, minus the unused `group` label.
 * @param {string} id                'matching.park'
 * @param {'matching'|'measuring'|'radar'|'thermometer'|'photo'|'tentacle'} category
 * @param {string} label              'Park'
 * @param {string} text               the full question sentence
 * @param {string[]} sizes            which game sizes include it
 * @param {number} draw
 * @param {number} keep               == the cards the hider gains; 2 only for tentacles
 * @param {string|null} geodataRef    key into GEO_CATEGORIES, or null for GTFS-only
 * @param {{param?: number}} [extra]  param: radar/thermometer/tentacle distance, in miles
 * @returns {import('../lib/core.js').QuestionDef|Object}
 */
function Q(id, category, label, text, sizes, draw, keep, geodataRef, extra = {}) {
  return Object.freeze({
    id,
    category,
    label,
    text,
    sizes: Object.freeze(sizes),
    draw,
    keep,
    geodataRef,
    param: extra.param === undefined ? null : extra.param,
  });
}

/**
 * One of the 24 curses, with the predicate that decides whether it stays in.
 * Positional parameters mirror generate.py's `CurseDef`, minus the card face,
 * which this pipeline never reads.
 * @param {string} id
 * @param {string} name
 * @param {1|2|3|4} tier              1 rulebook-explicit … 4 not map-contingent
 * @param {string|null} predicateKey  curse-predicate key, or null
 * @param {string} removalRule        plain words, printed folded under the row
 * @param {string} [test]             at most 8 words, tier 1–2; '' otherwise
 */
function C(id, name, tier, predicateKey, removalRule, test = '') {
  return Object.freeze({
    id,
    name,
    tier,
    predicateKey,
    removalRule,
    test,
  });
}

/** Share of the map diameter above which a thermometer leg is degenerate. */
export const THERMO_DEGENERATE_SHARE = 0.7;

/**
 * Catalogue size per game size, kept here for the shape assertions below. The
 * rest of the size table lives in `S1_SIZE_PARAMS` (gtfs/network.js).
 */
const SIZES = Object.freeze({
  small: Object.freeze({ catalogueSize: 58 }),
  medium: Object.freeze({ catalogueSize: 71 }),
  large: Object.freeze({ catalogueSize: 80 }),
});

export const QUESTIONS = Object.freeze([
  Q('matching.commercial_airport', 'matching', 'Commercial Airport',
    'Is your nearest commercial airport the same as my nearest commercial airport?',
    ['small', 'medium', 'large'], 3, 1, 'commercial_airport'),
  Q('matching.transit_line', 'matching', 'Transit Line',
    'Is your nearest transit line the same as my nearest transit line?',
    ['small', 'medium', 'large'], 3, 1, null),
  Q('matching.station_name_length', 'matching', "Station's Name Length",
    "Is your nearest station's name length the same as my nearest station's name length?",
    ['small', 'medium', 'large'], 3, 1, null),
  Q('matching.street_or_path', 'matching', 'Street or Path',
    'Is your nearest street or path the same as my nearest street or path?',
    ['small', 'medium', 'large'], 3, 1, 'street'),
  Q('matching.admin_1', 'matching', '1st Administrative Division',
    'Is your nearest 1st administrative division the same as my nearest 1st administrative division?',
    ['small', 'medium', 'large'], 3, 1, null),
  Q('matching.admin_2', 'matching', '2nd Administrative Division',
    'Is your nearest 2nd administrative division the same as my nearest 2nd administrative division?',
    ['small', 'medium', 'large'], 3, 1, null),
  Q('matching.admin_3', 'matching', '3rd Administrative Division',
    'Is your nearest 3rd administrative division the same as my nearest 3rd administrative division?',
    ['small', 'medium', 'large'], 3, 1, null),
  Q('matching.admin_4', 'matching', '4th Administrative Division',
    'Is your nearest 4th administrative division the same as my nearest 4th administrative division?',
    ['small', 'medium', 'large'], 3, 1, null),
  Q('matching.mountain', 'matching', 'Mountain',
    'Is your nearest mountain the same as my nearest mountain?',
    ['small', 'medium', 'large'], 3, 1, 'mountain'),
  Q('matching.landmass', 'matching', 'Landmass',
    'Is your nearest landmass the same as my nearest landmass?',
    ['small', 'medium', 'large'], 3, 1, 'coastline'),
  Q('matching.park', 'matching', 'Park',
    'Is your nearest park the same as my nearest park?',
    ['small', 'medium', 'large'], 3, 1, 'park'),
  Q('matching.amusement_park', 'matching', 'Amusement Park',
    'Is your nearest amusement park the same as my nearest amusement park?',
    ['small', 'medium', 'large'], 3, 1, 'amusement_park'),
  Q('matching.zoo', 'matching', 'Zoo',
    'Is your nearest zoo the same as my nearest zoo?',
    ['small', 'medium', 'large'], 3, 1, 'zoo'),
  Q('matching.aquarium', 'matching', 'Aquarium',
    'Is your nearest aquarium the same as my nearest aquarium?',
    ['small', 'medium', 'large'], 3, 1, 'aquarium'),
  Q('matching.golf_course', 'matching', 'Golf Course',
    'Is your nearest golf course the same as my nearest golf course?',
    ['small', 'medium', 'large'], 3, 1, 'golf_course'),
  Q('matching.museum', 'matching', 'Museum',
    'Is your nearest museum the same as my nearest museum?',
    ['small', 'medium', 'large'], 3, 1, 'museum'),
  Q('matching.movie_theater', 'matching', 'Movie Theater',
    'Is your nearest movie theater the same as my nearest movie theater?',
    ['small', 'medium', 'large'], 3, 1, 'movie_theater'),
  Q('matching.hospital', 'matching', 'Hospital',
    'Is your nearest hospital the same as my nearest hospital?',
    ['small', 'medium', 'large'], 3, 1, 'hospital'),
  Q('matching.library', 'matching', 'Library',
    'Is your nearest library the same as my nearest library?',
    ['small', 'medium', 'large'], 3, 1, 'library'),
  Q('matching.foreign_consulate', 'matching', 'Foreign Consulate',
    'Is your nearest foreign consulate the same as my nearest foreign consulate?',
    ['small', 'medium', 'large'], 3, 1, 'foreign_consulate'),
  Q('measuring.commercial_airport', 'measuring', 'Commercial Airport',
    'Compared to me, are you closer to or further from a commercial airport?',
    ['small', 'medium', 'large'], 3, 1, 'commercial_airport'),
  Q('measuring.high_speed_rail', 'measuring', 'High-Speed Train Line',
    'Compared to me, are you closer to or further from a high-speed train line?',
    ['small', 'medium', 'large'], 3, 1, 'high_speed_rail'),
  Q('measuring.rail_station', 'measuring', 'Rail Station',
    'Compared to me, are you closer to or further from a rail station?',
    ['small', 'medium', 'large'], 3, 1, 'rail_station'),
  Q('measuring.international_border', 'measuring', 'International Border',
    'Compared to me, are you closer to or further from an international border?',
    ['small', 'medium', 'large'], 3, 1, null),
  Q('measuring.admin_1_border', 'measuring', '1st Administrative Division Border',
    'Compared to me, are you closer to or further from a 1st administrative division border?',
    ['small', 'medium', 'large'], 3, 1, null),
  Q('measuring.admin_2_border', 'measuring', '2nd Administrative Division Border',
    'Compared to me, are you closer to or further from a 2nd administrative division border?',
    ['small', 'medium', 'large'], 3, 1, null),
  Q('measuring.sea_level', 'measuring', 'Sea Level',
    'Compared to me, are you closer to or further from sea level?',
    ['small', 'medium', 'large'], 3, 1, null),
  Q('measuring.body_of_water', 'measuring', 'Body of Water',
    'Compared to me, are you closer to or further from a body of water?',
    ['small', 'medium', 'large'], 3, 1, 'water'),
  Q('measuring.coastline', 'measuring', 'Coastline',
    'Compared to me, are you closer to or further from a coastline?',
    ['small', 'medium', 'large'], 3, 1, 'coastline'),
  Q('measuring.mountain', 'measuring', 'Mountain',
    'Compared to me, are you closer to or further from a mountain?',
    ['small', 'medium', 'large'], 3, 1, 'mountain'),
  Q('measuring.park', 'measuring', 'Park',
    'Compared to me, are you closer to or further from a park?',
    ['small', 'medium', 'large'], 3, 1, 'park'),
  Q('measuring.amusement_park', 'measuring', 'Amusement Park',
    'Compared to me, are you closer to or further from an amusement park?',
    ['small', 'medium', 'large'], 3, 1, 'amusement_park'),
  Q('measuring.zoo', 'measuring', 'Zoo',
    'Compared to me, are you closer to or further from a zoo?',
    ['small', 'medium', 'large'], 3, 1, 'zoo'),
  Q('measuring.aquarium', 'measuring', 'Aquarium',
    'Compared to me, are you closer to or further from an aquarium?',
    ['small', 'medium', 'large'], 3, 1, 'aquarium'),
  Q('measuring.golf_course', 'measuring', 'Golf Course',
    'Compared to me, are you closer to or further from a golf course?',
    ['small', 'medium', 'large'], 3, 1, 'golf_course'),
  Q('measuring.museum', 'measuring', 'Museum',
    'Compared to me, are you closer to or further from a museum?',
    ['small', 'medium', 'large'], 3, 1, 'museum'),
  Q('measuring.movie_theater', 'measuring', 'Movie Theater',
    'Compared to me, are you closer to or further from a movie theater?',
    ['small', 'medium', 'large'], 3, 1, 'movie_theater'),
  Q('measuring.hospital', 'measuring', 'Hospital',
    'Compared to me, are you closer to or further from a hospital?',
    ['small', 'medium', 'large'], 3, 1, 'hospital'),
  Q('measuring.library', 'measuring', 'Library',
    'Compared to me, are you closer to or further from a library?',
    ['small', 'medium', 'large'], 3, 1, 'library'),
  Q('measuring.foreign_consulate', 'measuring', 'Foreign Consulate',
    'Compared to me, are you closer to or further from a foreign consulate?',
    ['small', 'medium', 'large'], 3, 1, 'foreign_consulate'),
  Q('radar.quarter_mile', 'radar', '¼ Mile',
    'Are you within ¼ mile of me?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 0.25 }),
  Q('radar.half_mile', 'radar', '½ Mile',
    'Are you within ½ mile of me?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 0.5 }),
  Q('radar.1mi', 'radar', '1 Mile',
    'Are you within 1 mile of me?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 1.0 }),
  Q('radar.3mi', 'radar', '3 Miles',
    'Are you within 3 miles of me?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 3.0 }),
  Q('radar.5mi', 'radar', '5 Miles',
    'Are you within 5 miles of me?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 5.0 }),
  Q('radar.10mi', 'radar', '10 Miles',
    'Are you within 10 miles of me?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 10.0 }),
  Q('radar.25mi', 'radar', '25 Miles',
    'Are you within 25 miles of me?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 25.0 }),
  Q('radar.50mi', 'radar', '50 Miles',
    'Are you within 50 miles of me?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 50.0 }),
  Q('radar.100mi', 'radar', '100 Miles',
    'Are you within 100 miles of me?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 100.0 }),
  Q('radar.choose', 'radar', 'Choose',
    'Are you within a distance of my choosing of me?',
    ['small', 'medium', 'large'], 2, 1, null),
  Q('thermometer.half_mile', 'thermometer', '½ Mile',
    'After traveling ½ mile, am I hotter or colder?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 0.5 }),
  Q('thermometer.3mi', 'thermometer', '3 Miles',
    'After traveling 3 miles, am I hotter or colder?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 3.0 }),
  Q('thermometer.10mi', 'thermometer', '10 Miles',
    'After traveling 10 miles, am I hotter or colder?',
    ['medium', 'large'], 2, 1, null, { param: 10.0 }),
  Q('thermometer.50mi', 'thermometer', '50 Miles',
    'After traveling 50 miles, am I hotter or colder?',
    ['large'], 2, 1, null, { param: 50.0 }),
  Q('photo.any_building_visible_from_transit_station', 'photo', 'Any Building Visible from Transit Station',
    'Send me a photo of any building visible from transit station.',
    ['small', 'medium', 'large'], 1, 1, null),
  Q('photo.widest_street', 'photo', 'Widest Street',
    'Send me a photo of widest street.',
    ['small', 'medium', 'large'], 1, 1, null),
  Q('photo.tree', 'photo', 'Tree',
    'Send me a photo of tree.',
    ['small', 'medium', 'large'], 1, 1, null),
  Q('photo.tallest_structure_in_your_current_sightline', 'photo', 'Tallest Structure in Your Current Sightline',
    'Send me a photo of tallest structure in your current sightline.',
    ['small', 'medium', 'large'], 1, 1, null),
  Q('photo.you', 'photo', 'You',
    'Send me a photo of you.',
    ['small', 'medium', 'large'], 1, 1, null),
  Q('photo.the_sky', 'photo', 'The Sky',
    'Send me a photo of the sky.',
    ['small', 'medium', 'large'], 1, 1, null),
  Q('photo.tallest_building_visible_from_transit_station', 'photo', 'Tallest Building Visible from Transit Station',
    'Send me a photo of tallest building visible from transit station.',
    ['medium', 'large'], 1, 1, null),
  Q('photo.trace_nearest_street_path', 'photo', 'Trace Nearest Street/Path',
    'Send me a photo of trace nearest street/path.',
    ['medium', 'large'], 1, 1, null),
  Q('photo.2_buildings', 'photo', '2 Buildings',
    'Send me a photo of 2 buildings.',
    ['medium', 'large'], 1, 1, null),
  Q('photo.restaurant_interior', 'photo', 'Restaurant Interior',
    'Send me a photo of restaurant interior.',
    ['medium', 'large'], 1, 1, null),
  Q('photo.park', 'photo', 'Park',
    'Send me a photo of park.',
    ['medium', 'large'], 1, 1, null),
  Q('photo.grocery_store_aisle', 'photo', 'Grocery Store Aisle',
    'Send me a photo of grocery store aisle.',
    ['medium', 'large'], 1, 1, null),
  Q('photo.place_of_worship', 'photo', 'Place of Worship',
    'Send me a photo of place of worship.',
    ['medium', 'large'], 1, 1, null),
  Q('photo.train_platform', 'photo', 'Train Platform',
    'Send me a photo of train platform.',
    ['medium', 'large'], 1, 1, null),
  Q('photo.half_mile_of_streets_traced', 'photo', '½ Mile of Streets Traced',
    'Send me a photo of ½ mile of streets traced.',
    ['large'], 1, 1, null),
  Q('photo.tallest_mountain_visible_from_transit_station', 'photo', 'Tallest Mountain Visible from Transit Station',
    'Send me a photo of tallest mountain visible from transit station.',
    ['large'], 1, 1, null),
  Q('photo.biggest_body_of_water', 'photo', 'The Biggest Body of Water in Your Zone',
    'Send me a photo of the biggest body of water in your zone.',
    ['large'], 1, 1, null),
  Q('photo.5_buildings', 'photo', '5 Buildings',
    'Send me a photo of 5 buildings.',
    ['large'], 1, 1, null),
  Q('tentacle.museum', 'tentacle', 'Museums Within 1 Mile',
    'Within 1 mile of me, which museums are you nearest to? (You must also be within 1 mile.)',
    ['medium', 'large'], 4, 2, 'museum', { param: 1.0 }),
  Q('tentacle.library', 'tentacle', 'Libraries Within 1 Mile',
    'Within 1 mile of me, which libraries are you nearest to? (You must also be within 1 mile.)',
    ['medium', 'large'], 4, 2, 'library', { param: 1.0 }),
  Q('tentacle.movie_theater', 'tentacle', 'Movie Theaters Within 1 Mile',
    'Within 1 mile of me, which movie theaters are you nearest to? (You must also be within 1 mile.)',
    ['medium', 'large'], 4, 2, 'movie_theater', { param: 1.0 }),
  Q('tentacle.hospital', 'tentacle', 'Hospitals Within 1 Mile',
    'Within 1 mile of me, which hospitals are you nearest to? (You must also be within 1 mile.)',
    ['medium', 'large'], 4, 2, 'hospital', { param: 1.0 }),
  Q('tentacle.metro_line', 'tentacle', 'Metro Lines Within 15 Miles',
    'Within 15 miles of me, which metro lines are you nearest to? (You must also be within 15 miles.)',
    ['large'], 4, 2, null,
    { param: 15.0 }),
  Q('tentacle.zoo', 'tentacle', 'Zoos Within 15 Miles',
    'Within 15 miles of me, which zoos are you nearest to? (You must also be within 15 miles.)',
    ['large'], 4, 2, 'zoo', { param: 15.0 }),
  Q('tentacle.aquarium', 'tentacle', 'Aquariums Within 15 Miles',
    'Within 15 miles of me, which aquariums are you nearest to? (You must also be within 15 miles.)',
    ['large'], 4, 2, 'aquarium', { param: 15.0 }),
  Q('tentacle.amusement_park', 'tentacle', 'Amusement Parks Within 15 Miles',
    'Within 15 miles of me, which amusement parks are you nearest to? (You must also be within 15 miles.)',
    ['large'], 4, 2, 'amusement_park', { param: 15.0 }),
]);

// `removalRule` and `test` are our page wording; on tier 1 they paraphrase the rulebook's
// instruction. Card text lives only on the faces (www.lifack.ch/img/cards).
export const CURSES = Object.freeze([
  // ── tier 1 · the rulebook says to remove it ───────────────────────────────
  C('bridge_troll', 'Curse of the Bridge Troll', 1, 'bridge',
    'Remove when the map contains no bridges.',
    'removed if bridges = 0'),
  C('egg_partner', 'Curse of the Egg Partner', 1, 'grocery',
    'The grocery count only says whether an egg is obtainable.',
    'removed if no spending, or groceries = 0'),
  C('impressionable_consumer', 'Curse of the Impressionable Consumer', 1, 'shop',
    'The shop count is the secondary check: an ad 100 ft from its subject needs ' +
    'commercial density.',
    'removed if no spending, or shops = 0'),
  C('unguided_tourist', 'Curse of the Unguided Tourist', 1, null,
    'Decided by a static Street View coverage table keyed on the map\'s country, not by ' +
    "OpenStreetMap. Removed in the countries the rulebook's own example (Germany) belongs to.",
    'removed if Street View coverage is low'),

  // ── tier 2 · map-contingent by derivation, hard enough to auto-remove ─────
  C('distant_cuisine', 'Curse of the Distant Cuisine', 2, 'cuisine',
    'Remove when no restaurant on the map is tagged with a single foreign country\'s ' +
    'cuisine. Warn when there are fewer than five, or when only one distinct country is ' +
    'represented — then every qualifying restaurant is the same distance away and the ' +
    'curse is a formality.',
    'removed if foreign-cuisine restaurants = 0'),
  C('lemon_phylactery', 'Curse of the Lemon Phylactery', 2, 'grocery',
    'Every seeker has to buy a lemon.',
    'removed if no spending, or groceries = 0'),
  C('luxury_car', 'Curse of the Luxury Car', 2, 'car_street',
    'Remove only when the map has no motor-vehicle street at all. Car-free transit maps ' +
    'are real: Venice, Zermatt, Mackinac Island, Hydra, Giethoorn.',
    'removed if motor-vehicle streets = 0'),
  C('right_turn', 'Curse of the Right Turn', 2, 'car_street',
    'The rulebook says outright that the curse has no effect where there are no streets, ' +
    'so remove it when the motor-vehicle street count is zero.',
    'removed if motor-vehicle streets = 0'),
  C('water_weight', 'Curse of the Water Weight', 2, 'water',
    'The casting cost is a geographic gate: with no non-pool body of water on the map the ' +
    'curse can never be cast.',
    'removed if non-pool water bodies = 0'),

  // ── tier 3 · map-contingent, warn only, never auto-removed ────────────────
  C('bird_guide', 'Curse of the Bird Guide', 3, 'animal_habitat',
    'Green cover is the signal for how quickly either side finds a bird worth filming.'),
  C('cairn', 'Curse of the Cairn', 3, 'cairn_terrain',
    'Loose rock is not reliably mapped, so the terrain count is a hint rather than a ' +
    'verdict; the rulebook only calls this curse useless at global scale.'),
  C('endless_tumble', 'Curse of the Endless Tumble', 3, 'tumble_ground',
    'It needs 100 ft of open, ideally sloped, publicly accessible ground; the open-ground ' +
    'count says how grim that will be here.'),
  C('jammed_door', 'Curse of the Jammed Door', 3, 'building',
    "Always satisfiable. Its bite scales with how much of the seekers' route is boardings: " +
    'punishing on a bus-heavy map, weak on a walking one.'),
  C('labyrinth', 'Curse of the Labyrinth', 3, null,
    'Needs pen and paper, which belongs in the what-to-pack list. Not a geography question.'),
  C('mediocre_travel_agent', 'Curse of the Mediocre Travel Agent', 3, 'travel_agent_stop',
    'It fails only where the seekers are somewhere with nothing around, so the signal is ' +
    'the share of stations with a public destination in range.'),
  C('ransom_note', 'Curse of the Ransom Note', 3, 'print_source',
    'Both sides need printed material found in the wild plus something to cut with, which ' +
    'is genuinely hard in a zone with no newsstand or flyer board.'),
  C('u_turn', 'Curse of the U-Turn', 3, 'u_turn',
    'Decided by GTFS, not OSM: the card only bites when another route serves the next ' +
    'station inside 0.5/0.5/1 hours. The escape hatch is printed on the card, not a flaw ' +
    'in the map.'),
  C('urban_explorer', 'Curse of the Urban Explorer', 3, null,
    'It permanently kills the Transit Line matching question, which requires the seekers ' +
    'to be on moving transit.'),
  C('zoologist', 'Curse of the Zoologist', 3, 'animal_habitat',
    'The hider picks the category, so they will pick bird or bug; zoos and aquariums ' +
    'explicitly do not count.'),

  // ── tier 4 · not map-contingent at all ───────────────────────────────────
  C('drained_brain', 'Curse of the Drained Brain', 4, null,
    'It cannot break on any map, because the radar category is never fully dead — the ' +
    'Choose radar guarantees at least one live category.'),
  C('gamblers_feet', "Curse of the Gambler's Feet", 4, null, ''),
  C('hidden_hangman', 'Curse of the Hidden Hangman', 4, null, ''),
  C('overflowing_chalice', 'Curse of the Overflowing Chalice', 4, null,
    'Its note is the only place the rulebook independently restates the base draw/keep ' +
    'numbers, and they agree with SEEKING.md exactly.'),
  C('spotty_memory', 'Curse of the Spotty Memory', 4, null,
    'A SMALL game has only five question categories.'),
]);

// ── shape assertions, run at import; they have caught real transcription errors ──

/** @param {boolean} cond @param {string} msg */
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Counter(...).items() sorted by key, as a comparable array of [key, count]. */
function sortedCounts(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

assert(QUESTIONS.length === 80, `question catalogue is ${QUESTIONS.length}, expected 80`);
assert(new Set(QUESTIONS.map((q) => q.id)).size === 80, 'duplicate question id');
assert(CURSES.length === 24, `curse deck is ${CURSES.length}, expected 24`);
assert(new Set(CURSES.map((c) => c.id)).size === 24, 'duplicate curse id');
assert(
  JSON.stringify(sortedCounts(QUESTIONS.map((q) => q.category))) === JSON.stringify([
    ['matching', 20], ['measuring', 20], ['photo', 18], ['radar', 10],
    ['tentacle', 8], ['thermometer', 4]]),
  'category counts do not match the rulebook',
);
assert(
  JSON.stringify(sortedCounts(CURSES.map((c) => c.tier))) === JSON.stringify([
    [1, 4], [2, 5], [3, 10], [4, 5]]),
  'curse tier counts do not match rules.md §4',
);
for (const [sizeName, expected] of [['small', 58], ['medium', 71], ['large', 80]]) {
  const got = QUESTIONS.filter((q) => q.sizes.includes(sizeName)).length;
  assert(got === expected, `${sizeName} catalogue is ${got}, expected ${expected}`);
  assert(SIZES[sizeName].catalogueSize === expected,
    `${sizeName} SIZES.catalogueSize is ${SIZES[sizeName].catalogueSize}, expected ${expected}`);
}
assert(
  !QUESTIONS.some((q) => q.category === 'tentacle' && q.sizes.includes('small')),
  'SMALL games drop the tentacle category (SEEKING.md, and the Spotty Memory note)',
);

// ═══════════════════════════════════════════════════════════════════════════════
// S3 · INTERPRETATIONS — where the rulebook is silent and this code decides
// ═══════════════════════════════════════════════════════════════════════════════
//
// Printed folded under each row's `lead` in §Provenance. A judgement call in the
// engine without a row here is a bug. `lead` is at most 6 words with no trailing period.

/**
 * @type {ReadonlyArray<{id: string, lead: string, affects: string[], text: string,
 *   byDerivation?: Object<string, string>, byDerivationLead?: Object<string, string>,
 *   groups?: Array<{label: string, basis: 'rulebook'|'feed'|'interp', ids: string[]}>,
 *   data?: Object}>}
 */
export const INTERPRETATIONS = Object.freeze([
  { id: 'in_border_rule', lead: 'Outside the border does not exist',
    affects: Object.freeze(['every count on this page']),
    text: 'The rulebook treats locations outside the map as not existing, so every instance ' +
          'count is measured inside the drawn border. The border therefore decides most of ' +
          'this audit; a question that would change status under a slightly larger border is ' +
          'flagged borderline.' },
  // The one run-dependent row: `text` and `lead` describe the inferred derivation,
  // `byDerivation` and `byDerivationLead` the reader's-own-box alternatives.
  // `buildProvenance` picks; the row stays plain data for main-thread readers.
  { id: 'map_border_derivation', lead: "Stops' box plus one zone radius",
    affects: Object.freeze(['border', 'every instance count']),
    text: 'The border is the bounding box of the in-map stops padded by one hiding-zone ' +
          'radius, so that every legal zone lies wholly inside the map. The rulebook leaves ' +
          'borders entirely to the players; this is a default, not a rule.',
    byDerivation: Object.freeze({
      option: 'The border is the box you set on the landing map, with no padding: every ' +
              'stop, zone and instance count on this page is measured inside it. The ' +
              'rulebook leaves borders entirely to the players; this one is yours.',
      // Box drawn but not applied: it kept under `IN_PLAY_MIN_SHARE` of served
      // stops, so worker.js fell back to the whole network and degraded.
      option_fallback: 'The border is the box you drew, unpadded. It kept under half the ' +
              'served stops, so it was not applied; this is yours, not a rule.',
    }),
    byDerivationLead: Object.freeze({
      option: 'Your box, unpadded',
      option_fallback: 'Your box, not applied',
    }) },
  { id: 'osm_is_not_google_maps', lead: 'OpenStreetMap stands in for map apps',
    affects: Object.freeze(['all OSM counts', 'B', 'E', 'A']),
    text: 'Matching, measuring and tentacle questions are defined by what a mapping app ' +
          'categorises, with a five-Google-Reviews legitimacy test. OpenStreetMap has no ' +
          'reviews, tags things the apps do not surface and misses chains they have. Counts ' +
          'are a lower bound, with the exact selector printed beside each so a player can ' +
          'check it.' },
  { id: 'matching_quality_is_binary', lead: 'Matching scored as a yes/no split',
    affects: Object.freeze(["every matching question's quality"]),
    text: 'A matching answer is yes or no, so its quality is the balance of that split (the ' +
          'chance two random zones answer alike), not the entropy of the nearest-feature ' +
          'partition. When every zone has its own nearest instance the answer is almost ' +
          'always no and removes one zone; the binary form shows that and entropy does not.' },
  { id: 'measuring_ties_are_their_own_answer', lead: 'Equal distance answers neither',
    affects: Object.freeze(['every measuring question']),
    text: 'The rulebook offers only closer and further, so it does not say how a hider exactly ' +
          'as far from the feature as the seeker answers. That zone answers neither and agrees ' +
          'only with zones at the same distance, so survival numbers and the dossiers\' ' +
          'concrete answers describe the same game.' },
  { id: 'measuring_quality_is_narrowing', lead: 'Measuring scored by area removed',
    affects: Object.freeze(["every measuring question's quality"]),
    text: 'A measuring question always splits the map close to evenly, so a balance score ' +
          'would rate every one perfect. Its quality is how much of the map the answer removes ' +
          'on average: one minus the mean survival, renormalised so a clean halving is 1.0.' },
  { id: 'thermometer_beyond_map', lead: 'Long legs leave the map',
    affects: Object.freeze(['thermometer.3mi', 'thermometer.10mi', 'thermometer.50mi']),
    text: 'The rulebook does not say what happens when the thermometer distance exceeds the ' +
          "map. This generator calls a thermometer dead above the map's straight-line " +
          'diameter and degenerate above 0.7 of it, because beyond that the seekers cannot ' +
          'travel the leg without leaving the map.',
    data: Object.freeze({ degenerateShare: THERMO_DEGENERATE_SHARE }) },
  { id: 'thermometer_bearings', lead: 'Averaged over eight bearings',
    affects: Object.freeze(['every thermometer question']),
    text: "Nothing constrains which direction the seekers travel, so the thermometer's " +
          'decision boundary is averaged over eight fixed bearings from each sampled seeker ' +
          'position.' },
  { id: 'choose_radar_radius', lead: 'Choose radar at the median distance',
    affects: Object.freeze(['radar.choose']),
    text: 'The Choose radar lets the seekers name any distance, which is why the radar ' +
          'category can never be fully dead. It is modelled at the distance that splits this ' +
          'particular map most evenly — the median distance between two zones.' },
  { id: 'transit_line_zone_set', lead: 'Same routes reach both zones',
    affects: Object.freeze(['matching.transit_line']),
    text: 'Your nearest transit line is modelled as the set of routes reaching your zone ' +
          'circle, and two zones answer yes when those sets are identical.' },
  { id: 'street_singleton_partition', lead: 'One nearest street per zone',
    affects: Object.freeze(['matching.street_or_path']),
    text: 'Street geometry is counted map-wide but not downloaded, so the nearest-street ' +
          'partition is modelled as one class per zone. That is the honest worst case for the ' +
          'seekers: the answer is almost always no, and a no removes exactly one zone.' },
  { id: 'admin_border_distance_proxy', lead: 'Border distance via neighbouring zones',
    affects: Object.freeze(['measuring.admin_1_border', 'measuring.admin_2_border']),
    text: 'Administrative boundary geometry is not downloaded. Distance to a division border ' +
          'is approximated by the distance to the nearest zone that sits in a different ' +
          'division, which is an upper bound on the true distance.' },
  { id: 'sea_level_needs_dem', lead: 'Sea Level not evaluated',
    affects: Object.freeze(['measuring.sea_level']),
    text: 'Elevation needs a digital elevation model, which this pipeline deliberately does ' +
          'not carry for one question. Sea Level is reported as not evaluated rather than ' +
          'guessed; on a map with real terrain it is probably functional.' },
  { id: 'coastline_definition', lead: 'Big lake shores count as coast',
    affects: Object.freeze(['measuring.coastline', 'matching.landmass']),
    text: 'OpenStreetMap tags natural=coastline on ocean and sea shorelines only, so a great ' +
          'lake carries none. This generator treats the shore of any water body larger than the ' +
          'game map as a coast and derives shore segments from it, because such a shore bounds ' +
          'the map exactly the way an ocean coast does. A shore derived this way is counted for ' +
          'the coastline question but is not treated as splitting the map into separate ' +
          "landmasses. The rulebook's one-mile-estuary clause still has no OSM equivalent." },
  { id: 'metro_line_definition', lead: 'Metro lines are rail routes',
    affects: Object.freeze(['tentacle.metro_line']),
    text: 'Metro lines are the coloured lines a map app draws, so this question is restricted ' +
          'to rail route types. On a bus-only feed it is dead. Where rail exists, a line\'s ' +
          'position is approximated by the zones its route serves.' },
  { id: 'photo_null_is_not_free', lead: 'Cannot answer still leaks a bit',
    affects: Object.freeze(['every photo question']),
    text: '“I cannot answer the question” is a real answer: it pays the hider a card and it ' +
          'still leaks one bit. Low coverage is therefore scored as weak, never dead, and the ' +
          'coverage share is printed.' },
  { id: 'photo_always_answerable', lead: 'Six photos scored as answerable anywhere',
    affects: Object.freeze(['photo.you', 'photo.the_sky',
      'photo.tallest_structure_in_your_current_sightline', 'photo.widest_street',
      'photo.trace_nearest_street_path', 'photo.half_mile_of_streets_traced']),
    groups: Object.freeze([
      Object.freeze({ label: 'Answerable anywhere', basis: 'rulebook',
        ids: Object.freeze(['photo.you', 'photo.the_sky',
          'photo.tallest_structure_in_your_current_sightline', 'photo.widest_street']) }),
      Object.freeze({ label: 'Assumed answerable', basis: 'interp',
        ids: Object.freeze(['photo.trace_nearest_street_path',
          'photo.half_mile_of_streets_traced']) }),
    ]),
    text: 'Six photo questions are short-circuited to answerable everywhere, so as locational ' +
          'questions they are degenerate — but the image itself can still show the seekers a ' +
          'landmark, a shadow or a sky no model can score. They are scored as zero-information ' +
          'and flagged. Four of them really are answerable from anywhere on Earth: You, The ' +
          'Sky, Tallest Structure in Your Current Sightline and Widest Street. The other two ' +
          'are a judgement call. The rulebook conditions Trace Nearest Street/Path on ' +
          '“Street/path must be visible on mapping app” and ½ Mile of Streets Traced on ' +
          '“Streets must appear on mapping app”, plus a continuous five-turn route with no ' +
          'doubling back — and street geometry is counted map-wide but never downloaded, so ' +
          'neither condition can be checked here. They are assumed answerable rather than ' +
          'reported as unknown, which overstates them on a zone whose streets a mapping app ' +
          'does not draw.' },
  { id: 'tentacle_double_radius', lead: 'Both tentacle reaches from the seeker',
    affects: Object.freeze(['every tentacle question']),
    text: 'The two distance blanks on a tentacle card are always the same number, and both ' +
          'reach tests are anchored on the seeker, not on the hider.' },
  { id: 'tentacle_weak_is_a_radar', lead: 'One-arm tentacle is a radar',
    affects: Object.freeze(['every tentacle question']),
    text: 'When the median zone has at most one instance in reach, the tentacle usually has at ' +
          'most one arm and its answer mostly repeats a radar at twice the card cost. Such a ' +
          'tentacle is graded weak, not functional.' },
  { id: 'seeker_positions_are_zones', lead: 'Seekers stand at stations',
    affects: Object.freeze(['every survival number']),
    text: 'Seekers stand at transit stations, so the seeker sample is drawn from the candidate ' +
          'zone set itself. Answers are computed from station icons, not from anywhere inside ' +
          "the zone circle, which is the rulebook's own measurement rule." },
  { id: 'funnel_reference_seeker', lead: 'Funnel seeker at the map centre',
    affects: Object.freeze(['question_order', 'question_funnel']),
    text: 'The narrowing funnel is computed for a seeker standing at the zone closest to the ' +
          "map's centre of mass. A survival number averages over every seeker position; a " +
          'funnel has to pick one, and the centre is the least arbitrary choice.' },
  { id: 'reachability_one_way', lead: 'Reachability binds the hider only',
    affects: Object.freeze(['R1', 'S2']),
    text: "The rulebook's reachability constraint is one-way and applies to the hider only: " +
          'you must be able to get there inside the hiding period. Nothing requires you to be ' +
          'able to get back, so a zone that strands the seekers is reported as a tactical fact ' +
          'and never scored.' },
  { id: 'one_route_cap_is_stop_share', lead: 'One-route cap by stop share',
    affects: Object.freeze(['CAP_ONE_ROUTE']),
    text: 'The one-route cap is evaluated as the share of served stops a single route reaches, ' +
          'because per-route trip totals are not part of the metric table. A route touching ' +
          'nine stops in ten is a one-dimensional map either way.' },
  { id: 'legal_spots_are_a_shortlist', lead: 'Endgame spots are a shortlist',
    affects: Object.freeze(['E1', 'E2', 'E3']),
    text: 'OpenStreetMap does not know whether a plaza is locked at night, so the rulebook\'s ' +
          '“publicly accessible during all game hours” test cannot be automated. Endgame spot ' +
          'counts are a shortlist for a human to check, never a verdict.' },
  // ── curse judgement calls ─────────────────────────────────────────────────
  { id: 'spending_curses_grouped', lead: 'Three spending curses, one switch',
    affects: Object.freeze(['egg_partner', 'impressionable_consumer', 'lemon_phylactery']),
    text: 'Whether to spend money is a player preference, not a measurement. The rulebook ' +
          'removes Egg Partner and Impressionable Consumer when you do not want to buy things ' +
          'during the game and is silent about Lemon Phylactery, which also makes every seeker ' +
          'buy something. That is an inconsistency, so one no-spending house rule groups all ' +
          'three.' },
  { id: 'urban_explorer_cost', lead: 'Urban Explorer can cost Transit Line',
    affects: Object.freeze(['urban_explorer', 'matching.transit_line']),
    text: 'Urban Explorer is never removed, but it permanently kills the Transit Line matching ' +
          'question. On a map where Transit Line is one of the few live matching questions, ' +
          'it costs the seekers far more than two cards.' },
  { id: 'spotty_memory_small_game', lead: 'On SMALL, a six rerolls',
    affects: Object.freeze(['spotty_memory']),
    text: 'A SMALL game has only five question categories, so a six is read as a reroll. The ' +
          'curse hurts most on a map where only two categories are any good.' },
  // ── the OSM fallback tier ─────────────────────────────────────────────────
  // Three rows for one decision: a source synthesized from OSM route relations
  // (osm/synth.js). Each constant is quoted from that module in `text` and `data`; keep both in step.
  { id: 'osm_synth_feed', lead: 'Route geometry real; times assumed',
    affects: Object.freeze(['matching.transit_line', 'tentacle.metro_line',
      'photo.train_platform', 'u_turn', 'C2', 'X3']),
    text: 'Where a source is built from OpenStreetMap instead of a published feed, routes, ' +
          'stations and rail modes are read from OSM route relations and a timetable is ' +
          'synthesized. Route sets and geometry are real mapped data; every time-derived ' +
          'number is an assumption. So on such a run the metrics that would only measure ' +
          'the assumed timetable are dropped and the score renormalised — never imputed — ' +
          'the two normally feed-measured metrics that survive on geometry (C2, X3) are ' +
          'relabelled as our call, and the U-Turn curse becomes a conversation rather than ' +
          'a measurement.',
    groups: Object.freeze([
      Object.freeze({ label: 'Read from OSM route relations', basis: 'feed',
        ids: Object.freeze(['matching.transit_line', 'tentacle.metro_line',
          'photo.train_platform']) }),
      Object.freeze({ label: 'Dropped · renormalised, never imputed', basis: 'interp',
        ids: Object.freeze(['C1', 'C3', 'D1', 'D2', 'D3', 'E1', 'E2', 'S3']) }),
      Object.freeze({ label: 'Relabelled as our call', basis: 'interp',
        ids: Object.freeze(['C2', 'X3']) }),
      Object.freeze({ label: 'Player choice', basis: 'interp', ids: Object.freeze(['u_turn']) }),
    ]) },
  { id: 'osm_synth_timetable', lead: 'Timetable assumed from mode defaults',
    affects: Object.freeze(['C1', 'C3', 'D1', 'D2', 'D3', 'E1', 'E2', 'S3']),
    text: 'A synthesized timetable assumes service 06:00–22:00 on every day of a 14-day ' +
          'calendar; a headway from the relation\'s interval tag when it parses to a sane ' +
          '2–120 minutes, otherwise a per-mode default (subway and monorail every 6 minutes, ' +
          'light rail and tram 8, train 12, funicular 15); and travel times from distance ' +
          'along the relation\'s own line at a per-mode commercial speed (subway 32 km/h, ' +
          'light rail and tram 22, train 45, monorail 30, funicular 10) plus 30 seconds of ' +
          'dwell per stop. Every metric that is a pure function of these constants is ' +
          'dropped on such a run, because it would grade the assumption, not the city.',
    data: Object.freeze({
      serviceStartS: 6 * 3600,
      serviceEndS: 22 * 3600,
      calendarDays: 14,
      headwayMinMin: 2,
      headwayMaxMin: 120,
      dwellS: 30,
      modes: Object.freeze([
        Object.freeze({ mode: 'subway', headwayMin: 6, speedKmh: 32 }),
        Object.freeze({ mode: 'monorail', headwayMin: 6, speedKmh: 30 }),
        Object.freeze({ mode: 'light rail', headwayMin: 8, speedKmh: 22 }),
        Object.freeze({ mode: 'tram', headwayMin: 8, speedKmh: 22 }),
        Object.freeze({ mode: 'train', headwayMin: 12, speedKmh: 45 }),
        Object.freeze({ mode: 'funicular', headwayMin: 15, speedKmh: 10 }),
      ]),
    }) },
  { id: 'osm_synth_stations', lead: 'Stations are clustered OSM stop nodes',
    affects: Object.freeze(['A1', 'every stop and zone count on a synthesized source']),
    text: 'OpenStreetMap maps one stop_position node per line per platform, so a synthesized ' +
          'station is a cluster of those nodes: nodes sharing a normalised name merge within ' +
          '500 m, and any two nodes merge within 100 m regardless of name. Stop and zone ' +
          'counts on a synthesized source count those clusters, not the raw nodes.',
    data: Object.freeze({ clusterNameM: 500, clusterAnyM: 100 }) },
].map(Object.freeze));

/** @param {string} s @returns {number} */
const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;
for (const row of INTERPRETATIONS) {
  for (const lead of [row.lead, ...Object.values(row.byDerivationLead || {})]) {
    assert(typeof lead === 'string' && lead !== '' && wordCount(lead) <= 6 && !lead.endsWith('.'),
      `interpretation ${row.id} lead must be 1–6 words with no trailing period`);
  }
}
for (const c of CURSES) {
  assert(c.tier <= 2 ? c.test !== '' && wordCount(c.test) <= 8 : c.test === '',
    `curse ${c.id} test must be 1–8 words on tier 1–2 and empty otherwise`);
}

/**
 * The question catalogue for one game size: 58 / 71 / 80 questions. SMALL drops
 * the tentacle category (the tentacle section and the Spotty Memory note both say so).
 *
 * @param {{name: string, catalogueSize: number}} size
 * @returns {Array<Object>}
 */
export function catalogueFor(size) {
  const rows = QUESTIONS.filter((q) => q.sizes.includes(size.name));
  if (rows.length !== size.catalogueSize) {
    throw new Error(`${size.name} catalogue is ${rows.length}, expected ${size.catalogueSize}`);
  }
  return rows;
}
