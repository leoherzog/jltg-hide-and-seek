/**
 * lib/catalog.js — the Mobility Database snapshot, as data.
 *
 * `data/feeds.json` is a same-origin repo asset (CONTRACT.md §0), generated offline
 * by `tools/mdb-snapshot.mjs`. Nothing here fetches the upstream CSV or a feed; this
 * module only says which feeds exist, where they are, and what URL to use.
 *
 * No DOM, no MapLibre: imports `lib/geo.js` and `lib/core.js` only, so it runs in
 * Node. `render/picker.js` owns the pixels, `render/landing.js` the strings.
 *
 * DETERMINISM. Every list comes back in a stated order and every comparison is
 * code-point, never `localeCompare`.
 *
 * THE ROW SHAPE (authority: `tools/mdb-snapshot.mjs` §3.3):
 *
 *   id  string   catalogue id (`mdb-400`, `tld-5873`); `mdb:<id>` in a SourceRef and
 *                the mirror's object name. `[A-Za-z0-9_-]+`, so no URL escaping.
 *   p   string   provider, the primary label
 *   n   string?  sub-feed name, present only when it is not just `p` again
 *   c s m string country code / subdivision / municipality; any may be ''
 *   b   [S,W,N,E] bounding box, Overpass order, 5 dp
 *   d   string   the producer's own URL. Never auto-fetched: usually no CORS.
 *   a   int?     authentication_type when non-zero ⇒ the page cannot fetch it
 *   t   int?     places served (`location_type=1` stations where modelled, else
 *                stops). Measured from the feed; absent when no snapshot could read it.
 *   u   int?     routes published. Same provenance as `t`.
 *   k   1?       `b` carried from an earlier snapshot; an older measurement, not special
 *   q   1?       `t`/`u` carried the same way
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
 * Fetch and shape-check the snapshot. Throws rather than returning a half-document:
 * the picker either works or is not there.
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
 * The MobilityData mirror URL for a row: what the page downloads, because the mirror
 * sends CORS headers and an agency's server usually does not. It is a different file
 * from `row.d`, with a different hash, which is why §09 prints the URL it read. The
 * mirror names every object after the catalogue id, so the row carries no URL.
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
 * The longer side of the row's box in km, the figure `tools/mdb-snapshot.mjs` cuts
 * `r` on, so the badge and the flag agree.
 * @param {Object} row @returns {number}
 */
export function spanKmOf(row) {
  const [s, w, n, e] = row.b;
  const midLat = ((s + n) / 2) * (Math.PI / 180);
  return Math.max((n - s) * 110.574, Math.abs(e - w) * 111.320 * Math.cos(midLat));
}

/**
 * The rows the map may show, in `id` order. The opt-in groups are filtered out of
 * the data, not a layer, so cluster counts stay honest. `searchCatalog` is
 * deliberately not filtered.
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
 * country code. Searches EVERY row, including the opt-in groups; the caller renders
 * those with a badge and an "add anyway" affordance.
 *
 * Search is the path a screen reader, a phone and a map-blocked browser all use, so
 * the obvious operator must surface inside the caller's limit. Tiers:
 *   0  the query IS the provider, the full label, or the municipality
 *   1  the provider or the municipality starts with it
 *   2  it starts a word inside the provider, the sub-feed name or the municipality
 *   3  it is (the start of) the subdivision — a state-wide hit, much weaker
 *   4  it appears somewhere in the row at all
 *
 * Inside a tier: opt-in groups sink; then match position in the label ("The Rapid"
 * beats "Bay Area Rapid Transit"); then the bigger system by measured station count;
 * then the bigger box, for unmeasured rows; then provider and id, so the order is
 * total. Station count matters because every feed in a state ties at tier 3, and box
 * size there ranks the widest, least urban operator first (the NYC subway's 43 km box
 * lost to a dozen rural coach networks). Box size stays as the fallback because `t`
 * is optional.
 *
 * @param {Object[]} rows @param {string} query
 * @param {{limit?: number}} [opts]
 * @returns {{rows: Object[], total: number}} the page and the total match count, so
 *   the caller can say "and N more".
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
 * Every row whose box overlaps the drawn ring, in `id` order. `rows` is the caller's
 * visible set, so dragging a box across a state cannot silently add Amtrak.
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
 * `id` is `mdb:<catalogue id>`, stable across sessions and catalogue regenerations.
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
 * A drawn ring as the third kind of `SourceRef` (CONTRACT.md §(d)): the area as a
 * run input, built from OpenStreetMap when the catalogue has nothing here.
 *
 * The ring travels inside the ref, not as an option: CONTRACT.md forbids a shape
 * field on `Options`, and this ring is the input being read, not a border. `id` is a
 * hash of the ring, not its bbox, so two shapes round the same city stay distinct; it
 * is a stable identity, not a content address. Vertices are quantised through `coord`
 * so the same ring hashes the same on a second visit.
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
    // Named by where it is: §09 and the run label print this string.
    label: `OpenStreetMap rail near ${num(lat, 3, { comma: false })}, `
      + `${num(lon, 3, { comma: false })}`,
    mdbId: null,
    ring: points,
  };
}

/**
 * The example maps: metros the landing page offers as one-click chips, each a
 * hand-picked set of catalogue rows that together are that city's public transit.
 *
 * HAND-CURATED, NOT DERIVED. Publicly operated or contracted services only; a campus
 * loop is not a transit system a hider can rely on.
 *
 * `ids` are catalogue ids. `tools/mdb-snapshot.mjs --check` fails when one has left
 * the catalogue, needs an API key, is no longer updated, or a list exceeds
 * `MAX_FEEDS_PER_RUN`; the fix is here. At runtime `exampleMapsFor` drops a chip
 * whose rows are not all present.
 *
 * `key` is the chip's stable spelling (`data-example`), `name` what it says, `where`
 * the disambiguating country or state. Order is display order.
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
  // Puget Sound consolidated (KC Metro, Sound Transit, WSF, Kitsap Transit…). Do not
  // add mdb-1304 (Kitsap standalone): mdb-1080 already ships it, and both double-count.
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
 * The example maps this catalogue can serve, in `EXAMPLE_MAPS` order. A chip is
 * offered only when every row is present and none needs an API key; the dropped
 * ones are named in `missing`.
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
