// ═══════════════════════════════════════════════════════════════════════════════
// S3 · THE CATALOGUE — the rulebook as data
// ═══════════════════════════════════════════════════════════════════════════════
//
// Transcribed from specs/rules.json, which was itself read off GUIDE.md / HIDING.md
// / SEEKING.md and the 24 curse card faces. Question text is verbatim. `note` is
// analysis and the pages must render it as such.
//
// Ids differ from rules.json's in three families, to match contract.md §5.1/§5.2:
// `radar.5mi` not `radar.5_miles`, `matching.admin_1` not
// `matching.1st_administrative_division`, `tentacle.metro_line` not
// `tentacle.metro_lines_within_15_miles`. Nothing else was renamed.
//
// The catalogue below is *data*. The literal must be complete — 80 questions,
// 24 curses, 3 sizes — and its counts are asserted at import time.

import { QUARTER_MILE_M, HALF_MILE_M } from '../lib/core.js';

/**
 * One of the rulebook's 80 questions, as the engine needs it.
 * Positional parameters mirror `class QuestionDef` (generate.py line 6373) exactly.
 * @param {string} id                 'matching.park'
 * @param {'matching'|'measuring'|'radar'|'thermometer'|'photo'|'tentacle'} category
 * @param {string} group              the rulebook's own grouping, e.g. 'Transit'
 * @param {string} label              'Park'
 * @param {string} text               the full question sentence
 * @param {string[]} sizes            which game sizes include it
 * @param {number} draw
 * @param {number} keep               == the cards the hider gains; 2 only for tentacles
 * @param {string|null} geodataRef    key into GEO_CATEGORIES, or null for GTFS-only
 * @param {{param?: number, note?: string}} [extra]  param: radar/thermometer/tentacle distance, in miles
 * @returns {import('../lib/core.js').QuestionDef|Object}
 */
function Q(id, category, group, label, text, sizes, draw, keep, geodataRef, extra = {}) {
  return Object.freeze({
    id,
    category,
    group,
    label,
    text,
    sizes: Object.freeze(sizes),
    draw,
    keep,
    geodataRef,
    param: extra.param === undefined ? null : extra.param,
    note: extra.note === undefined ? '' : extra.note,
  });
}

/**
 * One of the 24 curses, with the predicate that decides whether it stays in.
 * Positional parameters mirror `class CurseDef` (generate.py line 6390) exactly.
 * @param {string} id
 * @param {string} name
 * @param {1|2|3|4} tier              1 rulebook-explicit … 4 not map-contingent
 * @param {string} cardText
 * @param {string} castingCost
 * @param {string[]} blocks
 * @param {string|null} predicateKey  curse-predicate key, or null
 * @param {string} removalRule        plain words, printed on the page
 * @param {{quote?: string}} [extra]  quote: verbatim rulebook trigger, tier 1 only
 */
function C(id, name, tier, cardText, castingCost, blocks, predicateKey, removalRule, extra = {}) {
  return Object.freeze({
    id,
    name,
    tier,
    cardText,
    castingCost,
    blocks: Object.freeze(blocks),
    predicateKey,
    removalRule,
    quote: extra.quote === undefined ? '' : extra.quote,
  });
}

/** Rulebook size parameters. Complete — these three entries are the whole table. */
export const SIZES = Object.freeze({
  small: Object.freeze({
    name: 'small',
    hidingPeriodMin: 30,
    zoneRadiusM: QUARTER_MILE_M,
    tentacleReachMi: 0.5,
    thermometerMi: Object.freeze([0.25, 1.0, 3.0]),
    categoryCount: 5,
    catalogueSize: 58,
    photoLimitMin: 10,
    otherLimitMin: 5,
    moveGrantMin: 10,
    requiredHours: 6.0,
    inferred: true,
  }),
  medium: Object.freeze({
    name: 'medium',
    hidingPeriodMin: 60,
    zoneRadiusM: QUARTER_MILE_M,
    tentacleReachMi: 1.0,
    thermometerMi: Object.freeze([0.5, 3.0, 10.0]),
    categoryCount: 6,
    catalogueSize: 71,
    photoLimitMin: 10,
    otherLimitMin: 5,
    moveGrantMin: 20,
    requiredHours: 10.0,
    inferred: true,
  }),
  large: Object.freeze({
    name: 'large',
    hidingPeriodMin: 180,
    zoneRadiusM: HALF_MILE_M,
    tentacleReachMi: 15.0,
    thermometerMi: Object.freeze([1.0, 15.0, 50.0]),
    categoryCount: 6,
    catalogueSize: 80,
    photoLimitMin: 20,
    otherLimitMin: 5,
    moveGrantMin: 60,
    requiredHours: 12.0,
    inferred: true,
  }),
});

/**
 * Radar distances the rulebook offers, in miles. The last one is the "Choose" radar,
 * which is why the radar category can never be fully dead on any map.
 */
export const RADAR_MILES = Object.freeze([0.25, 0.5, 1.0, 3.0, 5.0, 10.0, 25.0, 50.0, 100.0]);

export const QUESTIONS = Object.freeze([
  Q('matching.commercial_airport', 'matching', 'Transit', 'Commercial Airport',
    'Is your nearest commercial airport the same as my nearest commercial airport?',
    ['small', 'medium', 'large'], 3, 1, 'commercial_airport'),
  Q('matching.transit_line', 'matching', 'Transit', 'Transit Line',
    'Is your nearest transit line the same as my nearest transit line?',
    ['small', 'medium', 'large'], 3, 1, null,
    { note: 'Unaskable while the seekers are not on moving transit; Curse of the Urban ' +
            'Explorer kills it permanently for the run.' }),
  Q('matching.station_name_length', 'matching', 'Transit', "Station's Name Length",
    "Is your nearest station's name length the same as my nearest station's name length?",
    ['small', 'medium', 'large'], 3, 1, null),
  Q('matching.street_or_path', 'matching', 'Transit', 'Street or Path',
    'Is your nearest street or path the same as my nearest street or path?',
    ['small', 'medium', 'large'], 3, 1, 'street',
    { note: 'Streets are counted map-wide but not fetched as geometry; the partition is ' +
            'modelled as one class per zone.' }),
  Q('matching.admin_1', 'matching', 'Administrative Divisions', '1st Administrative Division',
    'Is your nearest 1st administrative division the same as my nearest 1st administrative division?',
    ['small', 'medium', 'large'], 3, 1, null),
  Q('matching.admin_2', 'matching', 'Administrative Divisions', '2nd Administrative Division',
    'Is your nearest 2nd administrative division the same as my nearest 2nd administrative division?',
    ['small', 'medium', 'large'], 3, 1, null),
  Q('matching.admin_3', 'matching', 'Administrative Divisions', '3rd Administrative Division',
    'Is your nearest 3rd administrative division the same as my nearest 3rd administrative division?',
    ['small', 'medium', 'large'], 3, 1, null),
  Q('matching.admin_4', 'matching', 'Administrative Divisions', '4th Administrative Division',
    'Is your nearest 4th administrative division the same as my nearest 4th administrative division?',
    ['small', 'medium', 'large'], 3, 1, null),
  Q('matching.mountain', 'matching', 'Natural', 'Mountain',
    'Is your nearest mountain the same as my nearest mountain?',
    ['small', 'medium', 'large'], 3, 1, 'mountain'),
  Q('matching.landmass', 'matching', 'Natural', 'Landmass',
    'Is your nearest landmass the same as my nearest landmass?',
    ['small', 'medium', 'large'], 3, 1, 'coastline',
    { note: 'Derived from assembled coastline: with no coastline inside the border the ' +
            'whole map is one landmass.' }),
  Q('matching.park', 'matching', 'Natural', 'Park',
    'Is your nearest park the same as my nearest park?',
    ['small', 'medium', 'large'], 3, 1, 'park'),
  Q('matching.amusement_park', 'matching', 'Places of Interest', 'Amusement Park',
    'Is your nearest amusement park the same as my nearest amusement park?',
    ['small', 'medium', 'large'], 3, 1, 'amusement_park'),
  Q('matching.zoo', 'matching', 'Places of Interest', 'Zoo',
    'Is your nearest zoo the same as my nearest zoo?',
    ['small', 'medium', 'large'], 3, 1, 'zoo'),
  Q('matching.aquarium', 'matching', 'Places of Interest', 'Aquarium',
    'Is your nearest aquarium the same as my nearest aquarium?',
    ['small', 'medium', 'large'], 3, 1, 'aquarium'),
  Q('matching.golf_course', 'matching', 'Places of Interest', 'Golf Course',
    'Is your nearest golf course the same as my nearest golf course?',
    ['small', 'medium', 'large'], 3, 1, 'golf_course'),
  Q('matching.museum', 'matching', 'Places of Interest', 'Museum',
    'Is your nearest museum the same as my nearest museum?',
    ['small', 'medium', 'large'], 3, 1, 'museum'),
  Q('matching.movie_theater', 'matching', 'Places of Interest', 'Movie Theater',
    'Is your nearest movie theater the same as my nearest movie theater?',
    ['small', 'medium', 'large'], 3, 1, 'movie_theater'),
  Q('matching.hospital', 'matching', 'Public Utilities', 'Hospital',
    'Is your nearest hospital the same as my nearest hospital?',
    ['small', 'medium', 'large'], 3, 1, 'hospital'),
  Q('matching.library', 'matching', 'Public Utilities', 'Library',
    'Is your nearest library the same as my nearest library?',
    ['small', 'medium', 'large'], 3, 1, 'library'),
  Q('matching.foreign_consulate', 'matching', 'Public Utilities', 'Foreign Consulate',
    'Is your nearest foreign consulate the same as my nearest foreign consulate?',
    ['small', 'medium', 'large'], 3, 1, 'foreign_consulate'),
  Q('measuring.commercial_airport', 'measuring', 'Transit-Related', 'Commercial Airport',
    'Compared to me, are you closer to or further from a commercial airport?',
    ['small', 'medium', 'large'], 3, 1, 'commercial_airport'),
  Q('measuring.high_speed_rail', 'measuring', 'Transit-Related', 'High-Speed Train Line',
    'Compared to me, are you closer to or further from a high-speed train line?',
    ['small', 'medium', 'large'], 3, 1, 'high_speed_rail'),
  Q('measuring.rail_station', 'measuring', 'Transit-Related', 'Rail Station',
    'Compared to me, are you closer to or further from a rail station?',
    ['small', 'medium', 'large'], 3, 1, 'rail_station'),
  Q('measuring.international_border', 'measuring', 'Borders', 'International Border',
    'Compared to me, are you closer to or further from an international border?',
    ['small', 'medium', 'large'], 3, 1, null,
    { note: 'Decided by whether an admin_level=2 boundary line crosses the map, not by ' +
            'the containing country.' }),
  Q('measuring.admin_1_border', 'measuring', 'Borders', '1st Administrative Division Border',
    'Compared to me, are you closer to or further from a 1st administrative division border?',
    ['small', 'medium', 'large'], 3, 1, null,
    { note: 'A boundary LINE crossing the map, which can be true while the matching ' +
            'twin is degenerate.' }),
  Q('measuring.admin_2_border', 'measuring', 'Borders', '2nd Administrative Division Border',
    'Compared to me, are you closer to or further from a 2nd administrative division border?',
    ['small', 'medium', 'large'], 3, 1, null,
    { note: 'A boundary LINE crossing the map, which can be true while the matching ' +
            'twin is degenerate.' }),
  Q('measuring.sea_level', 'measuring', 'Natural', 'Sea Level',
    'Compared to me, are you closer to or further from sea level?',
    ['small', 'medium', 'large'], 3, 1, null,
    { note: 'Needs a digital elevation model this pipeline deliberately does not carry; ' +
            'reported as not evaluated rather than guessed.' }),
  Q('measuring.body_of_water', 'measuring', 'Natural', 'Body of Water',
    'Compared to me, are you closer to or further from a body of water?',
    ['small', 'medium', 'large'], 3, 1, 'water'),
  Q('measuring.coastline', 'measuring', 'Natural', 'Coastline',
    'Compared to me, are you closer to or further from a coastline?',
    ['small', 'medium', 'large'], 3, 1, 'coastline'),
  Q('measuring.mountain', 'measuring', 'Natural', 'Mountain',
    'Compared to me, are you closer to or further from a mountain?',
    ['small', 'medium', 'large'], 3, 1, 'mountain'),
  Q('measuring.park', 'measuring', 'Natural', 'Park',
    'Compared to me, are you closer to or further from a park?',
    ['small', 'medium', 'large'], 3, 1, 'park'),
  Q('measuring.amusement_park', 'measuring', 'Places of Interest', 'Amusement Park',
    'Compared to me, are you closer to or further from an amusement park?',
    ['small', 'medium', 'large'], 3, 1, 'amusement_park'),
  Q('measuring.zoo', 'measuring', 'Places of Interest', 'Zoo',
    'Compared to me, are you closer to or further from a zoo?',
    ['small', 'medium', 'large'], 3, 1, 'zoo'),
  Q('measuring.aquarium', 'measuring', 'Places of Interest', 'Aquarium',
    'Compared to me, are you closer to or further from an aquarium?',
    ['small', 'medium', 'large'], 3, 1, 'aquarium'),
  Q('measuring.golf_course', 'measuring', 'Places of Interest', 'Golf Course',
    'Compared to me, are you closer to or further from a golf course?',
    ['small', 'medium', 'large'], 3, 1, 'golf_course'),
  Q('measuring.museum', 'measuring', 'Places of Interest', 'Museum',
    'Compared to me, are you closer to or further from a museum?',
    ['small', 'medium', 'large'], 3, 1, 'museum'),
  Q('measuring.movie_theater', 'measuring', 'Places of Interest', 'Movie Theater',
    'Compared to me, are you closer to or further from a movie theater?',
    ['small', 'medium', 'large'], 3, 1, 'movie_theater'),
  Q('measuring.hospital', 'measuring', 'Public Utilities', 'Hospital',
    'Compared to me, are you closer to or further from a hospital?',
    ['small', 'medium', 'large'], 3, 1, 'hospital'),
  Q('measuring.library', 'measuring', 'Public Utilities', 'Library',
    'Compared to me, are you closer to or further from a library?',
    ['small', 'medium', 'large'], 3, 1, 'library'),
  Q('measuring.foreign_consulate', 'measuring', 'Public Utilities', 'Foreign Consulate',
    'Compared to me, are you closer to or further from a foreign consulate?',
    ['small', 'medium', 'large'], 3, 1, 'foreign_consulate'),
  Q('radar.quarter_mile', 'radar', 'Radar', '¼ Mile',
    'Are you within ¼ mile of me?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 0.25 }),
  Q('radar.half_mile', 'radar', 'Radar', '½ Mile',
    'Are you within ½ mile of me?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 0.5 }),
  Q('radar.1mi', 'radar', 'Radar', '1 Mile',
    'Are you within 1 mile of me?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 1.0 }),
  Q('radar.3mi', 'radar', 'Radar', '3 Miles',
    'Are you within 3 miles of me?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 3.0 }),
  Q('radar.5mi', 'radar', 'Radar', '5 Miles',
    'Are you within 5 miles of me?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 5.0 }),
  Q('radar.10mi', 'radar', 'Radar', '10 Miles',
    'Are you within 10 miles of me?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 10.0 }),
  Q('radar.25mi', 'radar', 'Radar', '25 Miles',
    'Are you within 25 miles of me?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 25.0 }),
  Q('radar.50mi', 'radar', 'Radar', '50 Miles',
    'Are you within 50 miles of me?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 50.0 }),
  Q('radar.100mi', 'radar', 'Radar', '100 Miles',
    'Are you within 100 miles of me?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 100.0 }),
  Q('radar.choose', 'radar', 'Radar', 'Choose',
    'Are you within a distance of my choosing of me?',
    ['small', 'medium', 'large'], 2, 1, null,
    { note: 'The seekers name any distance, so the radar category can never be fully ' +
            'dead; modelled at the distance that splits this map most evenly.' }),
  Q('thermometer.half_mile', 'thermometer', 'Thermometer', '½ Mile',
    'After traveling ½ mile, am I hotter or colder?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 0.5 }),
  Q('thermometer.3mi', 'thermometer', 'Thermometer', '3 Miles',
    'After traveling 3 miles, am I hotter or colder?',
    ['small', 'medium', 'large'], 2, 1, null, { param: 3.0 }),
  Q('thermometer.10mi', 'thermometer', 'Thermometer', '10 Miles',
    'After traveling 10 miles, am I hotter or colder?',
    ['medium', 'large'], 2, 1, null, { param: 10.0 }),
  Q('thermometer.50mi', 'thermometer', 'Thermometer', '50 Miles',
    'After traveling 50 miles, am I hotter or colder?',
    ['large'], 2, 1, null, { param: 50.0 }),
  Q('photo.any_building_visible_from_transit_station', 'photo', 'Photo', 'Any Building Visible from Transit Station',
    'Send me a photo of any building visible from transit station.',
    ['small', 'medium', 'large'], 1, 1, null),
  Q('photo.widest_street', 'photo', 'Photo', 'Widest Street',
    'Send me a photo of widest street.',
    ['small', 'medium', 'large'], 1, 1, null,
    { note: 'Unconditionally answerable wherever a transit stop exists.' }),
  Q('photo.tree', 'photo', 'Photo', 'Tree',
    'Send me a photo of tree.',
    ['small', 'medium', 'large'], 1, 1, null),
  Q('photo.tallest_structure_in_your_current_sightline', 'photo', 'Photo', 'Tallest Structure in Your Current Sightline',
    'Send me a photo of tallest structure in your current sightline.',
    ['small', 'medium', 'large'], 1, 1, null,
    { note: 'Unconditionally answerable: there is always a tallest thing in a ' +
            'sightline.' }),
  Q('photo.you', 'photo', 'Photo', 'You',
    'Send me a photo of you.',
    ['small', 'medium', 'large'], 1, 1, null,
    { note: 'Unconditionally answerable, so it carries no locational information — but ' +
            'the image itself can still show the seekers something no model can score.' }),
  Q('photo.the_sky', 'photo', 'Photo', 'The Sky',
    'Send me a photo of the sky.',
    ['small', 'medium', 'large'], 1, 1, null,
    { note: 'Unconditionally answerable; weather and sun angle are outside this model.' }),
  Q('photo.tallest_building_visible_from_transit_station', 'photo', 'Photo', 'Tallest Building Visible from Transit Station',
    'Send me a photo of tallest building visible from transit station.',
    ['medium', 'large'], 1, 1, null),
  Q('photo.trace_nearest_street_path', 'photo', 'Photo', 'Trace Nearest Street/Path',
    'Send me a photo of trace nearest street/path.',
    ['medium', 'large'], 1, 1, null,
    { note: 'Treated as answerable wherever a mapped street reaches the zone.' }),
  Q('photo.2_buildings', 'photo', 'Photo', '2 Buildings',
    'Send me a photo of 2 buildings.',
    ['medium', 'large'], 1, 1, null),
  Q('photo.restaurant_interior', 'photo', 'Photo', 'Restaurant Interior',
    'Send me a photo of restaurant interior.',
    ['medium', 'large'], 1, 1, null),
  Q('photo.park', 'photo', 'Photo', 'Park',
    'Send me a photo of park.',
    ['medium', 'large'], 1, 1, null),
  Q('photo.grocery_store_aisle', 'photo', 'Photo', 'Grocery Store Aisle',
    'Send me a photo of grocery store aisle.',
    ['medium', 'large'], 1, 1, null),
  Q('photo.place_of_worship', 'photo', 'Photo', 'Place of Worship',
    'Send me a photo of place of worship.',
    ['medium', 'large'], 1, 1, null),
  Q('photo.train_platform', 'photo', 'Photo', 'Train Platform',
    'Send me a photo of train platform.',
    ['medium', 'large'], 1, 1, null,
    { note: 'OSM tags `public_transport=platform` on bus stops too, so this is gated on ' +
            'the feed actually having a rail mode.' }),
  Q('photo.half_mile_of_streets_traced', 'photo', 'Photo', '½ Mile of Streets Traced',
    'Send me a photo of ½ mile of streets traced.',
    ['large'], 1, 1, null,
    { note: 'The ≥0.5 mi, ≥5-turn walk is not verified against the street graph; ' +
            'treated as answerable and flagged.' }),
  Q('photo.tallest_mountain_visible_from_transit_station', 'photo', 'Photo', 'Tallest Mountain Visible from Transit Station',
    'Send me a photo of tallest mountain visible from transit station.',
    ['large'], 1, 1, null),
  Q('photo.biggest_body_of_water', 'photo', 'Photo', 'The Biggest Body of Water in Your Zone',
    'Send me a photo of the biggest body of water in your zone.',
    ['large'], 1, 1, null),
  Q('photo.5_buildings', 'photo', 'Photo', '5 Buildings',
    'Send me a photo of 5 buildings.',
    ['large'], 1, 1, null),
  Q('tentacle.museum', 'tentacle', 'Tentacle', 'Museums Within 1 Mile',
    'Within 1 mile of me, which museums are you nearest to? (You must also be within 1 mile.)',
    ['medium', 'large'], 4, 2, 'museum', { param: 1.0 }),
  Q('tentacle.library', 'tentacle', 'Tentacle', 'Libraries Within 1 Mile',
    'Within 1 mile of me, which libraries are you nearest to? (You must also be within 1 mile.)',
    ['medium', 'large'], 4, 2, 'library', { param: 1.0 }),
  Q('tentacle.movie_theater', 'tentacle', 'Tentacle', 'Movie Theaters Within 1 Mile',
    'Within 1 mile of me, which movie theaters are you nearest to? (You must also be within 1 mile.)',
    ['medium', 'large'], 4, 2, 'movie_theater', { param: 1.0 }),
  Q('tentacle.hospital', 'tentacle', 'Tentacle', 'Hospitals Within 1 Mile',
    'Within 1 mile of me, which hospitals are you nearest to? (You must also be within 1 mile.)',
    ['medium', 'large'], 4, 2, 'hospital', { param: 1.0 }),
  Q('tentacle.metro_line', 'tentacle', 'Tentacle', 'Metro Lines Within 15 Miles',
    'Within 15 miles of me, which metro lines are you nearest to? (You must also be within 15 miles.)',
    ['large'], 4, 2, null,
    { param: 15.0,
      note: 'Metro lines are the coloured rail lines a map app draws, so this is ' +
            'decided by GTFS route_type, not by OSM.' }),
  Q('tentacle.zoo', 'tentacle', 'Tentacle', 'Zoos Within 15 Miles',
    'Within 15 miles of me, which zoos are you nearest to? (You must also be within 15 miles.)',
    ['large'], 4, 2, 'zoo', { param: 15.0 }),
  Q('tentacle.aquarium', 'tentacle', 'Tentacle', 'Aquariums Within 15 Miles',
    'Within 15 miles of me, which aquariums are you nearest to? (You must also be within 15 miles.)',
    ['large'], 4, 2, 'aquarium', { param: 15.0 }),
  Q('tentacle.amusement_park', 'tentacle', 'Tentacle', 'Amusement Parks Within 15 Miles',
    'Within 15 miles of me, which amusement parks are you nearest to? (You must also be within 15 miles.)',
    ['large'], 4, 2, 'amusement_park', { param: 15.0 }),
]);

// Card text and casting costs are read off the card faces (www.lifack.ch/img/cards),
// which are the only place they exist — the markdown rulebook carries the *notes*
// only. `removalRule` is plain words for the page; `quote` is verbatim rulebook and
// is present on tier 1 only, because tier 1 is the tier the rulebook itself decides.
export const CURSES = Object.freeze([
  // ── tier 1 · the rulebook says to remove it ───────────────────────────────
  C('bridge_troll', 'Curse of the Bridge Troll', 1,
    'The seekers must ask their next question from under a bridge.',
    'Seekers must be at least S 1 / M 5 / L 30 miles from you.',
    ['asking_questions'], 'bridge',
    'Remove when the map contains no bridges.',
    { quote: 'If there are no bridges on the game map, this curse should be removed from the deck.' }),
  C('egg_partner', 'Curse of the Egg Partner', 1,
    'The seekers must acquire an egg before asking another question. This egg is now ' +
    'treated as an official team member of the seekers. If any team members are abandoned ' +
    "or killed (defined as any crack, in the egg's case) before the end of your run, you " +
    'are awarded an extra S 30 / M 45 / L 60 minutes. This curse cannot be played during ' +
    'the endgame.',
    'Discard two cards.',
    ['asking_questions'], 'grocery',
    'A player preference, not a measurement: the rulebook removes it when you do not want ' +
    'to buy things during the game. The grocery count only tells you whether an egg is ' +
    'obtainable at all.',
    { quote: 'If you do not want to buy items during the course of your game, or object to ' +
             'this curse on ethical grounds, this curse should be removed from the deck.' }),
  C('impressionable_consumer', 'Curse of the Impressionable Consumer', 1,
    'Seekers must enter and gain admission (if applicable) to a location or a buy a ' +
    'product that they saw an advertisement for before asking another question. This ' +
    "advertisement must be found out in the world, not on a seeker's device, and must be " +
    'at least 100 feet from the product or location itself.',
    "The seekers' next question is free.",
    ['asking_questions'], 'shop',
    'A player preference, not a measurement. The shop count is the secondary check: an ' +
    'advertisement 100 ft from the thing it advertises needs commercial density.',
    { quote: 'If you do not want to be forced to potentially spend money to fulfill this ' +
             'curse, it should be removed from the deck.' }),
  C('unguided_tourist', 'Curse of the Unguided Tourist', 1,
    'Send the seekers an unzoomed Google Street View image from a street within 500 feet ' +
    'of where they are now. The shot has to be parallel to the horizon and include at ' +
    'least one human-built structure other than a road. Without using the internet for ' +
    'research, they must find what you sent them in real life before they can use ' +
    'transportation or ask another question. They must send a picture to the hider for ' +
    'verification.',
    'Seekers must be outside.',
    ['asking_questions', 'taking_transit'], null,
    'Decided by a static Street View coverage table keyed on the map\'s country, not by ' +
    "OpenStreetMap. Removed in the countries the rulebook's own example (Germany) belongs to.",
    { quote: 'If you are playing in a country or area with highly limited Google Street View ' +
             'coverage (such as Germany), this curse should be removed from the deck.' }),

  // ── tier 2 · map-contingent by derivation, hard enough to auto-remove ─────
  C('distant_cuisine', 'Curse of the Distant Cuisine', 2,
    'Find a restaurant within your zone that explicitly serves food from a specific ' +
    'foreign country. The seekers must visit a restaurant serving food from a country ' +
    'that is an equal or greater distance away before asking another question.',
    'You must be at the restaurant.',
    ['asking_questions'], 'cuisine',
    'Remove when no restaurant on the map is tagged with a single foreign country\'s ' +
    'cuisine. Warn when there are fewer than five, or when only one distinct country is ' +
    'represented — then every qualifying restaurant is the same distance away and the ' +
    'curse is a formality.'),
  C('lemon_phylactery', 'Curse of the Lemon Phylactery', 2,
    'Before asking another question, the seekers must each find a lemon and affix it to ' +
    'the outermost layer of their clothes or skin. If, at any point, one of these lemons ' +
    'is no longer touching a seeker, you are awarded an extra S 30 / M 45 / L 60 minutes. ' +
    'This curse cannot be played during the endgame.',
    'Discard a powerup.',
    ['asking_questions'], 'grocery',
    'Every seeker has to buy a lemon. The rulebook flags Egg Partner and Impressionable ' +
    'Consumer for the spending objection and is silent about this one, which is an ' +
    'inconsistency — group all three under one no-spending house rule.'),
  C('luxury_car', 'Curse of the Luxury Car', 2,
    'Take a photo of a car. The seekers must take a photo of a more expensive car before ' +
    'asking another question.',
    'A photo of a car.',
    ['asking_questions'], 'car_street',
    'Remove only when the map has no motor-vehicle street at all. Car-free transit maps ' +
    'are real: Venice, Zermatt, Mackinac Island, Hydra, Giethoorn.'),
  C('right_turn', 'Curse of the Right Turn', 2,
    'For the next S 20 / M 40 / L 60 minutes, the seekers can only turn right at any ' +
    'street intersection. If, at any point, they find themselves in a dead end where they ' +
    'cannot continue forward or turn right for another 1,000 feet, they may do a full ' +
    '180. A right turn is defined as a road at any angle that veers to the right of the ' +
    'seekers.',
    'Discard a card.',
    [], 'car_street',
    'The rulebook says outright that the curse has no effect where there are no streets, ' +
    'so remove it when the motor-vehicle street count is zero.'),
  C('water_weight', 'Curse of Water Weight', 2,
    'The seekers must acquire and carry at least 2 liters of liquid per seeker for the ' +
    'rest of your run. They cannot ask another question until they have acquired the ' +
    'liquid. The water may be distributed between seekers as they see fit. If the liquid ' +
    'is lost or abandoned at any point after acquisition, the hider is awarded a ' +
    'S 30 / M 30 / L 60 minute bonus.',
    'Seekers must be within 1,000 feet (300 m) of a body of water.',
    ['asking_questions'], 'water',
    'The casting cost is a geographic gate: with no non-pool body of water on the map the ' +
    'curse can never be cast.'),

  // ── tier 3 · map-contingent, warn only, never auto-removed ────────────────
  C('bird_guide', 'Curse of the Bird Guide', 3,
    'You have one chance to film a bird for as long as possible, up to S 5 / M 10 / L 15 ' +
    'minutes straight. If, at any point, the bird leaves the frame, your timer is ' +
    'stopped. The seekers must then film a bird for the same amount of time or longer ' +
    'before asking another question.',
    'Film a bird.',
    ['asking_questions'], 'animal_habitat',
    'Never removed. Green cover is the signal for how quickly either side finds a bird ' +
    'worth filming.'),
  C('cairn', 'Curse of the Cairn', 3,
    'You have one attempt to stack as many rocks on top of each other as you can in a ' +
    'freestanding tower. Each rock may only touch one other rock. Once you have added a ' +
    'rock to the tower, it may not be removed. Before adding another rock, the tower must ' +
    'stand for at least five seconds. If at any point, any rock other than the base rock ' +
    'touches the ground, your tower has fallen. Once your tower falls, tell the seekers ' +
    'how many rocks high your tower was when it last stood for five seconds. The seekers ' +
    'must then construct a rock tower of the same number of rocks, under the same ' +
    'parameters, before asking another question. The rocks must be found in nature, and ' +
    'both teams must disperse the rocks after building.',
    'Build a rock tower.',
    ['asking_questions'], 'cairn_terrain',
    'Never removed. Loose rock is not reliably mapped, so the terrain count is a hint ' +
    'rather than a verdict; the rulebook only calls this curse useless at global scale.'),
  C('endless_tumble', 'Curse of the Endless Tumble', 3,
    'Seekers must roll a die at least 100 feet and have it land on a 5 or a 6 before they ' +
    'can ask another question. The die must roll the full distance, unaided, using only ' +
    'the momentum from the initial throw and gravity to travel the 100 feet. If the ' +
    'seekers accidentally hit someone with a die, you are awarded a S 10 / M 20 / L 30 ' +
    'minute bonus.',
    "Roll a die. If it's a 5 or a 6, this card has no effect.",
    ['asking_questions'], 'tumble_ground',
    'Never removed. It needs 100 ft of open, ideally sloped, publicly accessible ground; ' +
    'the open-ground count says how grim that will be here.'),
  C('jammed_door', 'Curse of the Jammed Door', 3,
    'For the next S 0.5 / M 1 / L 3 hours, whenever the seekers want to pass through a ' +
    'doorway into a building, business, train, or other vehicle, they must first roll 2 ' +
    'dice. If they do not roll a 7 or higher, they cannot enter that space (including ' +
    'through other doorways.) Any given doorway can be re-attempted after ' +
    'S 5 / M 10 / L 15 minutes.',
    'Discard two cards.',
    [], 'building',
    'Never removed — it is always satisfiable. Its bite scales with how much of the ' +
    "seekers' route is boardings: punishing on a bus-heavy map, weak on a walking one."),
  C('labyrinth', 'Curse of the Labyrinth', 3,
    'Spend up to S 10 / M 20 / L 30 minutes drawing a solvable maze and send a photo of ' +
    'it to the seekers. You cannot use the internet to research maze designs. The seekers ' +
    'must solve the maze before asking another question.',
    'Draw a maze.',
    [], null,
    'Never removed and not a geography question: it needs pen and paper, which belongs in ' +
    'the what-to-pack list.'),
  C('mediocre_travel_agent', 'Curse of the Mediocre Travel Agent', 3,
    'Choose any publicly-accessible place within S 0.25 / M 0.25 / L 0.5 miles of the ' +
    "seekers' current location. They cannot currently be on transit. They must go there, " +
    'and spend at least S 5 / M 5 / L 10 minutes there, before asking another question. ' +
    'They must send you at least three photos of them enjoying their vacation, and ' +
    'procure an object to bring you as a souvenir. If this souvenir is lost before they ' +
    'can give it to you, you are awarded an extra S 30 / M 45 / L 60 minutes.',
    'Their vacation destination must be further from you than their current location.',
    ['asking_questions'], 'travel_agent_stop',
    'Never removed. It fails only where the seekers are somewhere with nothing around, so ' +
    'the signal is the share of stations with a public destination in range.'),
  C('ransom_note', 'Curse of the Ransom Note', 3,
    'The next question that the seekers ask must be composed of words and letters cut out ' +
    'of any printed material. The question must be coherent, and include at least 5 words.',
    'Spell out “ransom note” as a ransom note (without using this card).',
    ['asking_questions'], 'print_source',
    'Never removed. Both sides need printed material found in the wild plus something to ' +
    'cut with, which is genuinely hard in a zone with no newsstand or flyer board.'),
  C('u_turn', 'Curse of the U-Turn', 3,
    'The seekers must disembark their current mode of transportation at the next station ' +
    '(as long as that station is serviced by another form of transit in the next ' +
    'S 0.5 / M 0.5 / L 1 hours.)',
    'Seekers must be heading the wrong way. (Their next station is further from you than ' +
    'they are.)',
    [], 'u_turn',
    'Decided by GTFS, not OSM: the card only bites when another route serves the next ' +
    'station inside 0.5/0.5/1 hours. Never removed — the escape hatch is printed on the ' +
    'card, not a flaw in the map.'),
  C('urban_explorer', 'Curse of the Urban Explorer', 3,
    'For the rest of your run, seekers cannot ask questions when they are on transit or ' +
    'in a transit station.',
    'Discard 2 cards.',
    ['asking_questions'], null,
    'Never removed, but it permanently kills the Transit Line matching question, which ' +
    'requires the seekers to be on moving transit. On a map where Transit Line is one of ' +
    'the few live matching questions this costs the seekers far more than two cards.'),
  C('zoologist', 'Curse of the Zoologist', 3,
    'Take a photo of a wild fish, bird, mammal, reptile, amphibian, or bug. The seekers ' +
    'must take a picture of a wild animal in the same category before asking another ' +
    'question.',
    'A photo of an animal.',
    ['asking_questions'], 'animal_habitat',
    'Never removed. The hider picks the category, so they will pick bird or bug; zoos and ' +
    'aquariums explicitly do not count.'),

  // ── tier 4 · not map-contingent at all ───────────────────────────────────
  C('drained_brain', 'Curse of the Drained Brain', 4,
    'Choose three questions in different categories. The seekers cannot ask those ' +
    'questions for the rest of your run.',
    'Discard your hand.',
    [], null,
    'Not map-contingent. It cannot break on any map, because the radar category is never ' +
    'fully dead — the Choose radar guarantees at least one live category.'),
  C('gamblers_feet', "Curse of the Gambler's Feet", 4,
    'For the next S 20 / M 40 / L 60 minutes, seekers must roll a die before they take ' +
    'any steps in any direction. They may take that many steps before rolling again.',
    "Roll a die. If it's an even number, this curse has no effect.",
    [], null,
    'Not map-contingent.'),
  C('hidden_hangman', 'Curse of the Hidden Hangman', 4,
    'Before asking another question or boarding another form of transportation, seekers ' +
    'must beat the hider in a game of hangman. To play, the hider chooses a 5 letter ' +
    'word, and the game ends after either a correct word guess or 7 wrong letter guesses ' +
    '(head, body, two arms, two legs, and a hat). The hider must respond to all queries ' +
    'within 30 seconds. The seekers cannot challenge the hider for 10 minutes after a ' +
    'loss. After S 1 / M 2 / L 3 losses, the seekers must wait 10 more minutes and then ' +
    'the curse is cleared.',
    'Discard 2 cards.',
    ['asking_questions', 'taking_transit'], null,
    'Not map-contingent.'),
  C('overflowing_chalice', 'Curse of the Overflowing Chalice', 4,
    'For the next three questions, you may draw (not keep) an additional card when ' +
    'drawing from the hider deck.',
    'Discard a card.',
    [], null,
    'Not map-contingent. Its note is the only place the rulebook independently restates ' +
    'the base draw/keep numbers, and they agree with SEEKING.md exactly.'),
  C('spotty_memory', 'Curse of Spotty Memory', 4,
    'For the rest of your run, one random category of questions will be disabled at all ' +
    'times. After this curse is played, seekers must roll a die to determine the category ' +
    'of questions to be disabled. This category remains disabled until the next question ' +
    'is asked, at which point a die is rolled again to choose a new category. The same ' +
    'category can be disabled multiple times in a row.',
    'Discard a time bonus.',
    [], null,
    'Not map-contingent, but note that a SMALL game has only five categories, so a six is ' +
    'a reroll — and that the curse hurts most on a map where only two categories are any ' +
    'good.'),
]);

// ── shape assertions, run at import ───────────────────────────────────────────
// They assert the catalogue counts and they have caught real transcription errors.

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
// S3 · INTERPRETATIONS — everywhere the rulebook is silent and this code decides
// ═══════════════════════════════════════════════════════════════════════════════
//
// Every entry here is printed verbatim in §Provenance and is the reason a page may
// say "interpretation" next to a number. Adding a judgement call to the engine
// without adding a row here is a bug.

/** @type {ReadonlyArray<{id: string, affects: string[], text: string}>} */
export const INTERPRETATIONS = Object.freeze([
  { id: 'in_border_rule', affects: Object.freeze(['every count on this page']),
    text: "The rulebook says that locations outside the map's boundaries must be treated as " +
          'not existing, so every instance count here is measured inside the drawn border. ' +
          'The border therefore decides most of this audit, which is why questions that would ' +
          'change status under a slightly larger border are flagged as borderline.' },
  { id: 'map_border_derivation', affects: Object.freeze(['border', 'every instance count']),
    text: 'The border is the bounding box of the in-map stops padded by one hiding-zone ' +
          'radius, so that every legal zone lies wholly inside the map. The rulebook leaves ' +
          'borders entirely to the players; this is a default, not a rule.' },
  { id: 'osm_is_not_google_maps', affects: Object.freeze(['all OSM counts', 'B', 'E', 'A']),
    text: 'Every matching, measuring and tentacle question is defined by what a mapping app ' +
          'categorises, with a five-Google-Reviews legitimacy test. This generator reads ' +
          'OpenStreetMap, which has no reviews, tags things the apps do not surface and misses ' +
          'chains the apps have. Counts here are a lower bound and the exact selector is ' +
          'printed beside each one so a player can check it.' },
  { id: 'matching_quality_is_binary', affects: Object.freeze(["every matching question's quality"]),
    text: "A matching question's answer is yes or no, so its quality is scored as the balance " +
          'of that binary split — the chance that a random pair of zones answers the same way ' +
          '— rather than as the entropy of the underlying nearest-feature partition. A ' +
          'question whose feature set is so fine that every zone has its own nearest instance ' +
          'almost always answers no, and eliminates one zone; the binary form says so and the ' +
          'entropy form does not.' },
  { id: 'measuring_ties_are_their_own_answer', affects: Object.freeze(['every measuring question']),
    text: 'The rulebook offers closer and further and nothing else, so it does not say what a ' +
          'hider sitting exactly as far from the feature as the seeker should answer. Here ' +
          'that zone is treated as answering neither, agreeing only with the other zones at ' +
          'the same distance — which keeps the survival numbers and the concrete answers ' +
          'printed in the dossiers describing the same game.' },
  { id: 'measuring_quality_is_narrowing', affects: Object.freeze(["every measuring question's quality"]),
    text: 'A measuring question always splits the map close to evenly, so scoring the balance ' +
          'of its split would rate every one of them perfect. Its quality is scored as how ' +
          'much of the map the answer removes on average — one minus the mean survival, ' +
          'renormalised so a clean halving is 1.0.' },
  { id: 'thermometer_beyond_map',
    affects: Object.freeze(['thermometer.3mi', 'thermometer.10mi', 'thermometer.50mi']),
    text: 'The rulebook does not say what happens when the thermometer distance exceeds the ' +
          "map. This generator calls a thermometer dead above the map's straight-line " +
          'diameter and degenerate above 0.7 of it, because beyond that the seekers cannot ' +
          'travel the leg without leaving the map.' },
  { id: 'thermometer_bearings', affects: Object.freeze(['every thermometer question']),
    text: "Nothing constrains which direction the seekers travel, so the thermometer's " +
          'decision boundary is averaged over eight fixed bearings from each sampled seeker ' +
          'position.' },
  { id: 'choose_radar_radius', affects: Object.freeze(['radar.choose']),
    text: 'The Choose radar lets the seekers name any distance, which is why the radar ' +
          'category can never be fully dead. It is modelled at the distance that splits this ' +
          'particular map most evenly — the median distance between two zones.' },
  { id: 'transit_line_zone_set', affects: Object.freeze(['matching.transit_line']),
    text: 'Your nearest transit line is modelled as the set of routes reaching your zone ' +
          'circle, and two zones answer yes when those sets are identical.' },
  { id: 'street_singleton_partition', affects: Object.freeze(['matching.street_or_path']),
    text: 'Street geometry is counted map-wide but not downloaded, so the nearest-street ' +
          'partition is modelled as one class per zone. That is the honest worst case for the ' +
          'seekers: the answer is almost always no, and a no removes exactly one zone.' },
  { id: 'admin_border_distance_proxy',
    affects: Object.freeze(['measuring.admin_1_border', 'measuring.admin_2_border']),
    text: 'Administrative boundary geometry is not downloaded. Distance to a division border ' +
          'is approximated by the distance to the nearest zone that sits in a different ' +
          'division, which is an upper bound on the true distance.' },
  { id: 'sea_level_needs_dem', affects: Object.freeze(['measuring.sea_level']),
    text: 'Elevation needs a digital elevation model, which this pipeline deliberately does ' +
          'not carry for one question. Sea Level is reported as not evaluated rather than ' +
          'guessed; on a map with real terrain it is probably functional.' },
  { id: 'coastline_definition',
    affects: Object.freeze(['measuring.coastline', 'matching.landmass']),
    text: 'OpenStreetMap tags natural=coastline on ocean and sea shorelines only, so a great ' +
          'lake carries none. This generator treats the shore of any water body larger than the ' +
          'game map as a coast and derives shore segments from it, because such a shore bounds ' +
          'the map exactly the way an ocean coast does. A shore derived this way is counted for ' +
          'the coastline question but is not treated as splitting the map into separate ' +
          "landmasses. The rulebook's one-mile-estuary clause still has no OSM equivalent." },
  { id: 'metro_line_definition', affects: Object.freeze(['tentacle.metro_line']),
    text: 'Metro lines are the coloured lines a map app draws, so this question is restricted ' +
          'to rail route types. On a bus-only feed it is dead. Where rail exists, a line\'s ' +
          'position is approximated by the zones its route serves.' },
  { id: 'photo_null_is_not_free', affects: Object.freeze(['every photo question']),
    text: '“I cannot answer the question” is a real answer: it pays the hider a card and it ' +
          'still leaks one bit. Low coverage is therefore scored as weak, never dead, and the ' +
          'coverage share is printed.' },
  { id: 'photo_always_answerable',
    affects: Object.freeze(['photo.you', 'photo.the_sky',
      'photo.tallest_structure_in_your_current_sightline', 'photo.widest_street']),
    text: 'Four photo questions can be answered from anywhere, so as locational questions they ' +
          'are degenerate — but the image itself can still show the seekers a landmark, a ' +
          'shadow or a sky no model can score. They are scored as zero-information and flagged.' },
  { id: 'tentacle_double_radius', affects: Object.freeze(['every tentacle question']),
    text: 'The two distance blanks on a tentacle card are always the same number, and both ' +
          'reach tests are anchored on the seeker, not on the hider.' },
  { id: 'seeker_positions_are_zones', affects: Object.freeze(['every survival number']),
    text: 'Seekers stand at transit stations, so the seeker sample is drawn from the candidate ' +
          'zone set itself. Answers are computed from station icons, not from anywhere inside ' +
          "the zone circle, which is the rulebook's own measurement rule." },
  { id: 'funnel_reference_seeker', affects: Object.freeze(['question_order', 'question_funnel']),
    text: 'The narrowing funnel is computed for a seeker standing at the zone closest to the ' +
          "map's centre of mass. A survival number averages over every seeker position; a " +
          'funnel has to pick one, and the centre is the least arbitrary choice.' },
  { id: 'reachability_one_way', affects: Object.freeze(['R1', 'S2']),
    text: "The rulebook's reachability constraint is one-way and applies to the hider only: " +
          'you must be able to get there inside the hiding period. Nothing requires you to be ' +
          'able to get back, so a zone that strands the seekers is reported as a tactical fact ' +
          'and never scored.' },
  { id: 'one_route_cap_is_stop_share', affects: Object.freeze(['CAP_ONE_ROUTE']),
    text: 'The one-route cap is evaluated as the share of served stops a single route reaches, ' +
          'because per-route trip totals are not part of the metric table. A route touching ' +
          'nine stops in ten is a one-dimensional map either way.' },
  { id: 'legal_spots_are_a_shortlist', affects: Object.freeze(['E1', 'E2', 'E3']),
    text: 'OpenStreetMap does not know whether a plaza is locked at night, so the rulebook\'s ' +
          '“publicly accessible during all game hours” test cannot be automated. Endgame spot ' +
          'counts are a shortlist for a human to check, never a verdict.' },
].map(Object.freeze));

/**
 * The question catalogue for one game size: 58 / 71 / 80 questions.
 *
 * SMALL drops the **tentacle** category (confirmed twice in the rulebook — the
 * tentacle section says so outright, and the Spotty Memory note says a d6 roll of
 * six is a reroll "for small-sized games, which only include five categories").
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
