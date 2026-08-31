/**
 * lib/catalog.js — the Mobility Database snapshot, as data.
 *
 * `data/feeds.json` is a **same-origin repo asset**, not a sixth external one
 * (CONTRACT.md §0): it is generated offline by `tools/mdb-snapshot.mjs` and reviewed
 * as a diff, the same way `tools/osm-world/categories.json` is. Nothing here fetches
 * the upstream CSV, and nothing here fetches a feed — this module only says which
 * feeds exist, where they are, and what URL a caller would use.
 *
 * NO DOM, NO MAPLIBRE. It imports `lib/geo.js` and `lib/core.js` and nothing else, so
 * it is importable from Node and testable without a browser. `render/picker.js` owns
 * every pixel; `render/landing.js` owns every string; this file owns the arithmetic.
 *
 * DETERMINISM. Every function that returns a list returns it in a stated order, and
 * every comparison is code-point (`a < b ? -1 : a > b ? 1 : 0`) — never
 * `localeCompare`, which would reorder the same catalogue for a reader in a different
 * locale.
 *
 * THE ROW SHAPE, as written by `tools/mdb-snapshot.mjs` (its §3.3 table is the
 * authority; repeated here because this is the only consumer):
 *
 *   id  string   the catalogue id — `mdb-400`, `tld-5873` — and the stable identity,
 *                `mdb:<id>` in a SourceRef. Also the mirror's object name; see
 *                `feedUrlOf`. `[A-Za-z0-9_-]+`, so it needs no escaping in a URL.
 *   p   string   provider, the primary label
 *   n   string?  sub-feed name, present only when it is not just `p` again
 *   c s m string country code / subdivision / municipality; any may be ''
 *   b   [S,W,N,E] bounding box, Overpass order, 5 dp
 *   d   string   the producer's own URL. Never auto-fetched: usually no CORS.
 *   a   int?     authentication_type when non-zero ⇒ the page cannot fetch it
 *   t   int?     how many places the feed serves — its `location_type=1` stations
 *                where it models them, its stops where it does not. MEASURED from the
 *                feed itself, which the catalogue CSV cannot tell you; absent on a row
 *                no snapshot has managed to read yet.
 *   u   int?     how many routes it publishes. Same provenance as `t`.
 *   k   1?       `b` was carried from an earlier snapshot because the catalogue has
 *                stopped publishing a usable box. A real measurement, just an older
 *                one; nothing in the page treats such a row differently.
 *   q   1?       `t`/`u` were carried the same way, because the feed could not be read
 *                on the last run that tried. Also just an older measurement.
 *   r   1?       regional / long-distance, spanKm > doc.regionalKm ⇒ opt-in
 *   x   1?       upstream status is `inactive` ⇒ opt-in, labelled "no longer updated"
 *
 * @module lib/catalog
 */

import { bboxIntersectsRing, ringCentroid } from './geo.js';
import { cmpStr, coord, num, stableHash } from './core.js';

/** The snapshot schema this module understands. Bump only with the tool. */
export const CATALOG_VERSION = 3;

/**
 * Fetch and shape-check the snapshot.
 *
 * Throws rather than returning a half-document: the caller's whole contract with the
 * reader is "the picker either works or is not there", and a doc with no `rows` would
 * render an empty grey map instead of getting out of the way.
 *
 * @param {string|URL} url
 * @returns {Promise<Object>} the snapshot document
 */
export async function loadCatalog(url) {
  const res = await fetch(String(url), { credentials: 'omit' });
  if (!res.ok) throw new Error(`the feed catalogue answered ${res.status}`);
  const doc = await res.json();
  if (!doc || typeof doc !== 'object') throw new Error('the feed catalogue is not an object');
  if (doc.version !== CATALOG_VERSION) {
    throw new Error(`the feed catalogue is version ${doc.version}, not ${CATALOG_VERSION}`);
  }
  if (!Array.isArray(doc.rows) || !doc.rows.length) throw new Error('the feed catalogue has no rows');
  if (typeof doc.mirror !== 'string' || !doc.mirror) throw new Error('the feed catalogue has no mirror');
  return doc;
}

/**
 * The MobilityData mirror URL for a row.
 *
 * This — not `row.d` — is what the page downloads, because the mirror sends CORS
 * headers for an arbitrary origin and an agency's own server usually does not. It is
 * also a DIFFERENT FILE from the agency's: a run over the mirror and a run over
 * `row.d` are two feeds with two hashes, which is why §09 prints the URL it read.
 *
 * The row carries no URL of its own: the mirror names every object after the
 * catalogue id, so the id IS the path segment and the tool checks that identity on
 * every row it writes rather than storing the same string twice.
 *
 * @param {Object} doc @param {Object} row
 * @returns {string}
 */
export function feedUrlOf(doc, row) {
  return `${doc.mirror}${row.id}${doc.mirrorSuffix || ''}`;
}

/** `'Grand Rapids, Michigan, US'` — whichever of the three the row actually carries. */
export function placeOf(row) {
  return [row.m, row.s, row.c].filter((part) => part).join(', ');
}

/** What the page calls this feed: the provider, plus the sub-feed name when there is one. */
export function labelOf(row) {
  return row.n ? `${row.p} — ${row.n}` : row.p;
}

/** `[lat, lon]` at the middle of the row's box. Where its marker goes. */
export function centroidOf(row) {
  const [s, w, n, e] = row.b;
  return [(s + n) / 2, (w + e) / 2];
}

/**
 * The longer side of the row's box in km — the same figure `tools/mdb-snapshot.mjs`
 * cuts `r` on, recomputed here so the badge and the flag can never disagree.
 * @param {Object} row @returns {number}
 */
export function spanKmOf(row) {
  const [s, w, n, e] = row.b;
  const midLat = ((s + n) / 2) * (Math.PI / 180);
  return Math.max((n - s) * 110.574, Math.abs(e - w) * 111.320 * Math.cos(midLat));
}

/**
 * The rows the map and the search are allowed to show, in `id` order.
 *
 * The two opt-in groups are filtered OUT OF THE DATA rather than out of a layer, so
 * the cluster counts on the map stay honest — a cluster reading 12 that expands to 4
 * is worse than no count at all. Search re-admits an individual hidden row through
 * its "add anyway" button (`searchCatalog` is deliberately not filtered).
 *
 * @param {Object} doc
 * @param {{regional?: boolean, inactive?: boolean}} [opts]
 * @returns {Object[]}
 */
export function visibleRows(doc, opts = {}) {
  const { regional = false, inactive = false } = opts;
  return doc.rows.filter((row) => (regional || !row.r) && (inactive || !row.x));
}

/** Lowercase, never `toLocaleLowerCase` — the same string must match for every reader. */
const low = (v) => String(v || '').toLowerCase();

/** Does `q` start a word inside `hay`? `'rapid'` starts one in `'the rapid'`. */
function wordStart(hay, q) {
  for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + 1)) {
    if (i === 0 || !/[a-z0-9]/.test(hay[i - 1])) return true;
  }
  return false;
}

/**
 * How well one row answers the query. Lower is better; see `searchCatalog`.
 * @param {Object} row @param {string} q @returns {number}
 */
function matchTier(row, q) {
  const p = low(row.p);
  const n = low(row.n);
  const m = low(row.m);
  const s = low(row.s);
  const label = n ? `${p} — ${n}` : p;
  if (p === q || label === q || m === q) return 0;
  if (p.startsWith(q) || m.startsWith(q)) return 1;
  if (wordStart(p, q) || wordStart(n, q) || wordStart(m, q)) return 2;
  if (s === q || s.startsWith(q)) return 3;
  return 4;
}

/**
 * Free-text search over provider, sub-feed name, municipality, subdivision and
 * country code.
 *
 * Searches EVERY row, including the two opt-in groups: a threshold that hides
 * De Lijn from a reader who typed "De Lijn" is a bug, and the caller renders the row
 * with its badge and an "add anyway" affordance instead (PLAN D15).
 *
 * ORDER, and why it is not alphabetical. Search is a first-class path here — it is
 * what a screen reader, a phone and a browser with the map library blocked all use —
 * so a query that does not surface the obvious operator inside the caller's limit has
 * failed, silently. Ranking `startsWith(provider)` then alphabetically did exactly
 * that: "boston" listed five harbour ferries and a business council above the MBTA,
 * and "new york" put the MTA at index 37 of 72, past every caller's limit.
 *
 * The tiers, in order:
 *   0  the query IS the provider, the full label, or the municipality
 *   1  the provider or the municipality starts with it
 *   2  it starts a word inside the provider, the sub-feed name or the municipality
 *   3  it is (the start of) the subdivision — a state-wide hit, much weaker
 *   4  it appears somewhere in the row at all
 *
 * Inside a tier: the two opt-in groups sink (a reader typing a city name wants the
 * city's operator, not the coach network passing through); then the match's position
 * in the label, so "The Rapid" beats "Bay Area Rapid Transit" for "rapid"; then the
 * BIGGER SYSTEM first by measured station count, which is how the metro operator gets
 * above the harbour ferry that shares its municipality; then the bigger box, for the
 * rows no snapshot has measured; then provider and id, both code-point, so the order
 * is total.
 *
 * Station count replaced box size as that tiebreak, and tier 3 is why. Every feed in a
 * state ties at tier 3, so the tiebreak alone decides them, and box size decides them
 * close to backwards: "new york" ranked the subway 46th of 101 — past every caller's
 * limit — because its 43 km box is smaller than the 70-170 km boxes of a dozen rural
 * county coach networks. Inside one subdivision, the widest box means the least urban
 * operator. `t` says how big the system actually is, and puts it 2nd.
 *
 * Box size stays as the fallback rather than being deleted, because `t` is optional:
 * a fresh catalogue refresh that has not been measured yet, or a feed the mirror will
 * not serve, still has to sort somewhere sensible.
 *
 * @param {Object[]} rows @param {string} query
 * @param {{limit?: number}} [opts]
 * @returns {{rows: Object[], total: number}} the page, and how many matched in all —
 *   the caller says "and N more", because a list silently cut at 20 is a list lying
 *   about the catalogue.
 */
export function searchCatalog(rows, query, opts = {}) {
  const { limit = 20 } = opts;
  const q = low(String(query || '').trim());
  if (!q) return { rows: [], total: 0 };
  const hits = [];
  for (const row of rows) {
    const p = low(row.p);
    const label = row.n ? `${p} — ${low(row.n)}` : p;
    const haystack = `${p}\n${low(row.n)}\n${low(row.m)}\n${low(row.s)}\n${low(row.c)}`;
    if (haystack.indexOf(q) < 0) continue;
    const at = label.indexOf(q);
    hits.push({
      tier: matchTier(row, q),
      optIn: (row.r || row.x) ? 1 : 0,
      at: at < 0 ? Number.MAX_SAFE_INTEGER : at,
      stops: Number.isFinite(row.t) ? row.t : 0,
      span: spanKmOf(row),
      key: p,
      row,
    });
  }
  hits.sort((a, b) => (a.tier - b.tier)
    || (a.optIn - b.optIn)
    || (a.at - b.at)
    || (b.stops - a.stops)
    || (b.span - a.span)
    || cmpStr(a.key, b.key)
    || cmpStr(a.row.id, b.row.id));
  return { rows: hits.slice(0, limit).map((h) => h.row), total: hits.length };
}

/**
 * Every row whose box overlaps the drawn ring, in `id` order.
 *
 * `rows` is whatever the caller decided is visible, so the opt-in switches govern
 * what a drawn shape can sweep up — dragging a box across a state must not silently
 * add Amtrak.
 *
 * @param {Object[]} rows @param {Array<[number, number]>} ring
 * @returns {Object[]}
 */
export function rowsIntersectingRing(rows, ring) {
  if (!ring || ring.length < 3) return [];
  return rows.filter((row) => bboxIntersectsRing(row.b, ring))
    .slice()
    .sort((a, b) => cmpStr(a.id, b.id));
}

/**
 * A catalogue row as the `SourceRef` the worker protocol carries (CONTRACT.md §(d)).
 *
 * `id` is `mdb:<catalogue id>` — stable across sessions, across a re-drawn polygon
 * and across a catalogue regeneration, which is what makes the selection sortable and
 * the run label reproducible.
 *
 * @param {Object} doc @param {Object} row
 * @returns {Object} SourceRef
 */
export function sourceRefFor(doc, row) {
  return {
    kind: 'url',
    file: null,
    url: feedUrlOf(doc, row),
    id: `mdb:${row.id}`,
    label: labelOf(row),
    mdbId: row.id,
  };
}

/**
 * A drawn ring as the third kind of `SourceRef` (CONTRACT.md §(d)): the area itself
 * as a run input, to be built from OpenStreetMap when the catalogue has nothing here.
 *
 * The ring travels INSIDE the ref rather than as an option. CONTRACT.md forbids a
 * shape field on `Options` — the drawn border is a page control there, offered to
 * `borderBbox` and nothing more — but this ring is not a border, it is the input
 * being read, in the same slot a URL or a file occupies. There is no other slot for
 * it: `sources` is the only carrier main→worker and there is exactly one message.
 *
 * `id` is a hash of the ring rather than of its bounding box, because a bounding box
 * is not what was drawn: two different shapes round the same city share a box, and an
 * id that cannot tell them apart would let the second one silently replace the first
 * in a Map keyed by id. It is a stable identity, not a content address — the feed's
 * content address is the sha256 of the synthesized zip, and only the worker can know
 * that.
 *
 * Vertices are quantised through `coord` for the same reason every emitted coordinate
 * is: the same drawn ring must hash the same on a second visit, and 11 cm is far
 * below what a finger on a map can express.
 *
 * @param {Array<[number, number]>} ring `[[lat, lon], …]`, first point NOT repeated
 * @returns {Object|null} SourceRef, or null when the ring is not a ring
 */
export function osmSourceRef(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const points = ring.map((p) => [coord(p[0]), coord(p[1])]);
  const [lat, lon] = ringCentroid(points);
  return {
    kind: 'osm',
    file: null,
    url: null,
    id: `osm:${stableHash(points.map((p) => `${p[0]},${p[1]}`).join(';'))}`,
    // Named by where it is, because §09 and the run label print this string and
    // "the area you drew" tells a reader who comes back to the report nothing.
    label: `OpenStreetMap rail near ${num(lat, 3, { comma: false })}, `
      + `${num(lon, 3, { comma: false })}`,
    mdbId: null,
    ring: points,
  };
}

/**
 * The example maps — a dozen-odd metros the landing page offers as one-click chips,
 * each a hand-picked set of catalogue rows that together are that city's public
 * transit: the metro, the buses, the commuter rail, the ferries.
 *
 * HAND-CURATED, NOT DERIVED. A drawn shape around Manhattan sweeps up university
 * shuttles, tourist cruises and a business-district circulator alongside the subway;
 * these lists carry publicly operated (or publicly contracted) services only, and
 * the choice of what counts is editorial. Keep it that way — a campus loop is not a
 * transit system a hider can rely on, and a chip that loads one is a chip that lies
 * about the city.
 *
 * `ids` are catalogue ids, so a chip survives a snapshot regeneration as long as the
 * feed does. `tools/mdb-snapshot.mjs --check` fails when one of them has left the
 * catalogue, needs an API key or is no longer updated — the fix is here, not there.
 * At runtime `exampleMapsFor` drops a chip whose rows are not all present rather
 * than offering a city with a hole in it. Every list is within `MAX_FEEDS_PER_RUN`
 * — `--check` holds that too.
 *
 * `key` is the chip's stable spelling (`data-example`), `name` what it says, `where`
 * the country or state that disambiguates it. Order is display order: the two the
 * feature was designed around first, then by region.
 */
export const EXAMPLE_MAPS = Object.freeze([
  // ── the two it was designed around ──
  {
    key: 'chicago', name: 'Chicago', where: 'Illinois',
    ids: ['mdb-389', 'mdb-2854', 'mdb-2347', 'mdb-306'],   // CTA, Metra, Pace, Water Taxi
  },
  {
    key: 'new-york', name: 'New York', where: 'New York',
    ids: [
      'mdb-511',                                                        // MTA — NYC Subway
      'mdb-513', 'mdb-512', 'mdb-520', 'mdb-528', 'mdb-514', 'mdb-510', // MTA buses, five boroughs + MTA Bus Company
      'mdb-515', 'mdb-518',                                             // NYC Ferry, Staten Island Ferry
      'tld-3364',                                                       // Roosevelt Island Tramway
    ],
  },
  // ── North America ──
  { key: 'boston', name: 'Boston', where: 'Massachusetts', ids: ['mdb-437'] },       // MBTA: subway, bus, commuter rail, ferry
  {
    key: 'philadelphia', name: 'Philadelphia', where: 'Pennsylvania',
    ids: ['mdb-502', 'mdb-503', 'mdb-3035'],                             // SEPTA bus+subway, SEPTA Regional Rail, PATCO
  },
  {
    key: 'san-francisco', name: 'San Francisco', where: 'California',
    ids: ['mdb-53', 'mdb-2886', 'mdb-54', 'mdb-3143', 'mdb-67', 'mdb-57'], // BART, Muni, Caltrain, SF Bay Ferry, Golden Gate, VTA
  },
  {
    key: 'los-angeles', name: 'Los Angeles', where: 'California',
    ids: ['mdb-29', 'mdb-30', 'mdb-96', 'mdb-1210', 'mdb-37', 'mdb-1198', 'mdb-101'], // Metro Bus, Metro Rail, Metrolink, LADOT, Big Blue Bus, Long Beach Transit, Foothill
  },
  // Puget Sound consolidated (KC Metro, Sound Transit, WSF, Kitsap Transit…).
  // mdb-1304 (Kitsap standalone) was dropped 2026-08-30: mdb-1080 already ships
  // Kitsap as its agency 20 with the same stops and near-identical routes, so
  // loading both double-counted every Kitsap stop.
  { key: 'seattle', name: 'Seattle', where: 'Washington', ids: ['mdb-1080'] },
  { key: 'grand-rapids', name: 'Grand Rapids', where: 'Michigan', ids: ['mdb-400'] },   // The Rapid — the reference feed
  {
    key: 'toronto', name: 'Toronto', where: 'Ontario',
    ids: ['mdb-732', 'mdb-1993', 'mdb-730', 'mdb-1994', 'mdb-728', 'mdb-726'], // TTC, GO, MiWay, Brampton, York Region, Durham Region
  },
  {
    key: 'montreal', name: 'Montréal', where: 'Québec',
    ids: ['mdb-2126', 'tld-6691', 'mdb-748', 'mdb-751', 'mdb-3190'],    // STM, REM, exo trains, RTL, STL
  },
  { key: 'vancouver', name: 'Vancouver', where: 'British Columbia', ids: ['mdb-696'] }, // TransLink
  // ── Europe ──
  { key: 'paris', name: 'Paris', where: 'France', ids: ['tdg-80921'] },              // Île-de-France Mobilités: métro, RER, tram, bus, Transilien
  { key: 'berlin', name: 'Berlin', where: 'Germany', ids: ['mdb-3233'] },            // VBB — the only publication of BVG + S-Bahn (regional box)
  { key: 'vienna', name: 'Vienna', where: 'Austria', ids: ['mdb-648'] },             // Wiener Linien + Wiener Lokalbahnen
  { key: 'prague', name: 'Prague', where: 'Czechia', ids: ['mdb-767'] },             // PID
  { key: 'warsaw', name: 'Warsaw', where: 'Poland', ids: ['mdb-2092', 'mdb-2091', 'mdb-1011'] }, // ZTM, WKD, Koleje Mazowieckie
  { key: 'helsinki', name: 'Helsinki', where: 'Finland', ids: ['mdb-865'] },         // HSL
  {
    key: 'dublin', name: 'Dublin', where: 'Ireland',
    ids: ['mdb-2635', 'mdb-2638', 'mdb-2637', 'mdb-2639'],              // Dublin Bus, Luas, Irish Rail, Go-Ahead Ireland
  },
  {
    key: 'lisbon', name: 'Lisbon', where: 'Portugal',
    ids: ['tld-716', 'mdb-2929', 'mdb-2027', 'mdb-2057', 'tld-715', 'mdb-2921', 'mdb-2408'], // Metro, Carris, Carris Metropolitana, CP, Fertagus, Transtejo Soflusa, MTS
  },
  // ── Asia-Pacific and Latin America ──
  { key: 'tokyo', name: 'Tokyo', where: 'Japan', ids: ['mdb-3176', 'mdb-3175'] },    // Toei subway + tram, Toei Bus (no Tokyo Metro / JR in the catalogue)
  { key: 'singapore', name: 'Singapore', where: 'Singapore', ids: ['mdb-1076'] },    // LTA: MRT, LRT, every bus operator
  { key: 'hong-kong', name: 'Hong Kong', where: 'Hong Kong', ids: ['mdb-1924'] },    // Transport Department aggregate: MTR, buses, minibuses, trams, ferries
  { key: 'santiago', name: 'Santiago', where: 'Chile', ids: ['mdb-3357'] },          // DTPM: Metro, Red buses, EFE
].map((e) => Object.freeze({ ...e, ids: Object.freeze(e.ids.slice()) })));

/**
 * The example maps this catalogue can actually serve, in `EXAMPLE_MAPS` order.
 *
 * A chip is offered only when every one of its rows is in the snapshot and none
 * needs an API key: a New York with the subway missing is not New York, and a chip
 * that adds nine feeds and silently skips the tenth is worse than no chip. The
 * dropped ones are named in `missing` so a console line can say which.
 *
 * @param {Object} doc the snapshot
 * @returns {{examples: Array<{key: string, name: string, where: string, rows: Object[]}>,
 *            missing: Array<{key: string, ids: string[]}>}}
 */
export function exampleMapsFor(doc) {
  const byId = new Map(doc.rows.map((row) => [row.id, row]));
  const examples = [];
  const missing = [];
  for (const ex of EXAMPLE_MAPS) {
    const rows = [];
    const gone = [];
    for (const id of ex.ids) {
      const row = byId.get(id);
      if (row && !row.a) rows.push(row);
      else gone.push(id);
    }
    if (gone.length) missing.push({ key: ex.key, ids: gone });
    else examples.push({ key: ex.key, name: ex.name, where: ex.where, rows });
  }
  return { examples, missing };
}
