/**
 * osm/synth.js — the OSM fallback converter: route relations → a GTFS zip.
 *
 * When a drawn border closes over no catalogued feed, the run can still happen:
 * this module turns the `transit_route` world layer (assembled OSM route
 * relations, read by `./worldfile.js`'s `worldTransitRoutes`) into a real GTFS
 * zip in memory and hands the bytes back. The worker then feeds them to the
 * **untouched** `loadFeed`, so everything downstream — the fatal guards, the
 * `sha256` that is literally the hex of the zip bytes, merge order, id
 * namespacing, `mergeFeeds([f]) === f` — holds by construction rather than by a
 * parallel Feed constructor that would have to re-earn each of those properties.
 *
 * WORKER SIDE ONLY — no DOM. No wall clock, no randomness: the same routes, the
 * same ring and the same `asOf` produce byte-identical zips (stored entries,
 * fixed DOS timestamps, every table sorted by its primary key), which keeps the
 * hash a true content address for the merge order and the provenance page.
 *
 * ── Input shape ──────────────────────────────────────────────────────────────
 *
 * `routes` is `worldTransitRoutes`' resolved output, verbatim — an array of
 *
 *     {
 *       osmId: number,                      // the relation id
 *       tags: {                             // string | null, each
 *         name, nameEn, ref, colour, operator, network,
 *         route,                            // subway|train|light_rail|tram|monorail|funicular
 *         interval, duration,               // raw tag text; `duration` is deliberately unread
 *       },
 *       lines: Array<Array<[lat, lon]>>,    // MultiLineString parts, chained by the build
 *       stops: Array<{nodeId, name, nameEn, lat, lon}>,  // TRAVEL order; names string|null
 *     }
 *
 * `ring` is the drawn border, `[[lat, lon], …]`, at least three vertices.
 * `asOf` is the analysis date (`'YYYYMMDD'`, dashes tolerated) or absent.
 *
 * The `duration` tag goes unread on purpose: the final design spaces stop_times
 * from line distance at mode speed constants, and a second, tag-calibrated speed
 * source would make two relations of the same line disagree about physics.
 *
 * ── What the feed asserts, and what it merely assumes ────────────────────────
 *
 * Geometry is measured (OSM's), and everything about time is invented. The
 * invention is confined to named constants so the rules layer can print each one
 * as an interpretation, and `notes` restates them in prose for provenance:
 *
 *   · service window 6:00–22:00, every day of a 14-day calendar
 *   · headway from the relation's `interval` tag when it parses sanely,
 *     else a per-mode default
 *   · inter-stop times from distance along the relation's own line at a
 *     per-mode commercial speed, plus a fixed dwell
 *
 * The calendar starts on the Monday of the week containing `asOf`; with no
 * `asOf` it starts on the Monday of the week containing the fixed fallback date
 * (`SYNTH_FALLBACK_ASOF`), so a run with no override is still a pure function of
 * its inputs. Taking the containing week's Monday in both cases keeps the window
 * aligned the same way whether or not the player picked a date.
 *
 * ── The landmines this module is shaped around ───────────────────────────────
 *
 *   1. `_s1ExpandFrequencies` (gtfs/feed.js) anchors each expansion at
 *      `departure(rows[0]) || arrival(rows[0]) || 0` — a departure of literally
 *      0 is falsy and falls through. Template stop_times therefore start at
 *      8:00:00, never midnight.
 *   2. A frequencies row that fails its validity test still costs the template
 *      its stop_times. So an invalid row is unrepresentable here: headway is
 *      clamped into a sane band or replaced by the mode default, and the window
 *      is a constant with start < end.
 *   3. Every emitted time must stay under `SERVICE_DAY_SECONDS` *after*
 *      expansion — the last slot departs just before 22:00, so a template
 *      longer than eight hours is dropped (with a note) rather than emitted.
 *   4. Ids never contain `:` and never match `/^f\d+:/`, so `gtfs/merge.js`
 *      namespaces them at the ordinary depth on a mixed run.
 *
 * Stop clustering: OSM maps one `stop_position` node per line per platform, so
 * the same physical station arrives 1.10–3.83× over — measured on the design
 * survey's 13-city Overpass corpus (2026-08-23 snapshot), not on the build's own
 * 14-city corpus, which tools/osm-world/build-transit.py documents separately.
 * Nodes merge when they carry the same normalised name within
 * 500 m, or sit within 100 m of each other regardless of name; the surviving
 * stop takes the lowest member node id, the modal member name and the mean
 * member position. Every stop is a plain boarding stop (`location_type` and
 * `parent_station` omitted — never a station hierarchy), which is exactly the
 * shape `loadFeed` keeps.
 *
 * Border clipping keeps, per relation, the maximal contiguous run of stops
 * inside the drawn ring — contiguous, because a line that leaves and re-enters
 * would otherwise teleport across the gap; maximal, so Seoul Line 1 does not
 * drag Cheonan into a Seoul game. On a circular relation (a repeated endpoint
 * stop, or chained geometry that closes on itself) "contiguous" is read around
 * the loop: the build seeds its walk on the lowest-id segment, so where the stop
 * list starts is arbitrary, and an in-border arc that happens to span that seam
 * must survive whole rather than be truncated to the longer linear fragment. A
 * relation left with fewer than two stops is dropped. The test is against the
 * ring itself, not its bounding box: the ring is the game border the player
 * drew, and the bbox was only ever the read layer's coarse filter.
 */

import { SERVICE_DAY_SECONDS, hhmmss, dowOf } from '../lib/core.js';
import { haversineM, pointInRing, Projection } from '../lib/geo.js';

// ── the assumption constants ──────────────────────────────────────────────────
// Exported so the rules layer can cite the numbers it is disclosing instead of
// keeping a second copy that could drift. Every one of these is an
// interpretation, not a measurement.

/** GTFS `route_type` per OSM `route=` value. All rail-family, all inside
 *  `_S1_RAIL_TYPES`, so `has_rail` and the metro route set light up. */
export const SYNTH_MODE_ROUTE_TYPE = Object.freeze({
  light_rail: '0', tram: '0', subway: '1', train: '2', funicular: '7', monorail: '12',
});

/** Assumed commercial speed, km/h, calibrated on the build corpus' medians. */
export const SYNTH_MODE_SPEED_KMH = Object.freeze({
  subway: 32, light_rail: 22, tram: 22, train: 45, monorail: 30, funicular: 10,
});

/** Assumed headway, seconds, when the relation's `interval` tag is unusable. */
export const SYNTH_MODE_HEADWAY_S = Object.freeze({
  subway: 360, monorail: 360, light_rail: 480, tram: 480, train: 720, funicular: 900,
});

/** Assumed dwell at every stop, seconds. */
export const SYNTH_DWELL_S = 30;

/** The assumed service window: 6:00:00–22:00:00, one frequencies row per trip. */
export const SYNTH_SERVICE_WINDOW_S = Object.freeze([6 * 3600, 22 * 3600]);

/** Template stop_times anchor. Nonzero on purpose — see landmine 1 above. */
export const SYNTH_TEMPLATE_ANCHOR_S = 8 * 3600;

/** Calendar length, days, starting on a Monday. */
export const SYNTH_CALENDAR_DAYS = 14;

/** The fallback analysis date when the run carries no `asOf`. The window still
 *  starts on the Monday of the week containing this date (2030-05-27). */
export const SYNTH_FALLBACK_ASOF = '20300601';

/** Stop clustering: same normalised name within this many metres merges … */
export const SYNTH_CLUSTER_NAME_M = 500;

/** … and any two nodes within this many metres merge regardless of name. */
export const SYNTH_CLUSTER_ANY_M = 100;

/** Sanity band for the `interval` tag, seconds. Outside it (the '10:00'
 *  hours-vs-minutes ambiguity, '24:00', 'irregular') falls to the mode default. */
export const SYNTH_HEADWAY_MIN_S = 120;
export const SYNTH_HEADWAY_MAX_S = 7200;

// A stop further than this from the relation's line abandons projection for that
// stop and falls back to chord distance from its predecessor.
const PROJECTION_LEASH_M = 500;

// Speed, route_type and fallback headway for a mode value outside the build's
// six. The build's osmium filter should make this unreachable; if it is reached
// anyway the relation is published under tram's route_type — the conservative
// rail-family reading — but assumed at these generic constants, which are their
// own numbers, not tram's, and the note states exactly the numbers used.
const UNKNOWN_MODE_SPEED_KMH = 25;
const UNKNOWN_MODE_ROUTE_TYPE = '0';
const UNKNOWN_MODE_HEADWAY_S = 600;

/** Code-point string order — the repo's, never `localeCompare`. */
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ── date arithmetic ───────────────────────────────────────────────────────────
// lib/core.js keeps its civil-days kernel private (only `dowOf`/`dateRange`
// escape), and this module needs to step *backwards* to a Monday, which
// `dateRange` cannot. The kernel is mirrored here rather than exported from
// core.js so this optional module leaves core.js untouched. Howard Hinnant's
// days_from_civil, proleptic Gregorian — identical to core.js's private copy.

function daysFromCivil(y, m, d) {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z0) {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524)
    - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [y + (m <= 2 ? 1 : 0), m, d];
}

/** 'YYYYMMDD' plus n days (n may be negative). */
function addDays(yyyymmdd, n) {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6));
  const [Y, M, D] = civilFromDays(daysFromCivil(y, m, d) + n);
  return `${String(Y).padStart(4, '0')}${String(M).padStart(2, '0')}${String(D).padStart(2, '0')}`;
}

/** `asOf` (or the fallback) → the Monday starting its week. Throws on garbage —
 *  `dowOf` validates the date and this keeps its exact error. */
function windowMonday(asOf) {
  const given = String(asOf ?? '').trim().replace(/-/g, '');
  const date = given || SYNTH_FALLBACK_ASOF;
  if (!/^\d{8}$/.test(date)) {
    throw new Error(`The analysis date must be YYYYMMDD, got ${JSON.stringify(asOf)}`);
  }
  return addDays(date, -dowOf(date));    // dowOf: Monday=0 … Sunday=6, and validates
}

// ── stop clustering ───────────────────────────────────────────────────────────

/** NFC, trimmed, internal whitespace collapsed. No case folding: two casings of
 *  one station name inside 500 m still merge via the 100 m rule when they are
 *  the same platform, and case is signal when they are not. */
function normName(text) {
  if (text === null || text === undefined) return '';
  return String(text).normalize('NFC').trim().replace(/\s+/g, ' ');
}

/**
 * Union-find over the distinct stop nodes. An edge joins two nodes when they sit
 * within `SYNTH_CLUSTER_ANY_M` of each other, or carry the same non-empty
 * normalised name within `SYNTH_CLUSTER_NAME_M`. Bucketing by a 0.02° grid keeps
 * the pair scan linear-ish; the result is independent of scan order because
 * membership is a property of the edge set, and the representative is the
 * minimum member node id, not the first one unioned.
 *
 * @param {Array<{nodeId:number, name:string|null, nameEn:string|null,
 *                lat:number, lon:number}>} nodes sorted by nodeId
 * @returns {Map<number, number>} nodeId → representative nodeId
 */
function clusterNodes(nodes) {
  const parent = nodes.map((_, i) => i);
  const find = (i) => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) { const next = parent[i]; parent[i] = r; i = next; }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // 0.02° of latitude is ~2.2 km and 0.02° of longitude stays over 500 m up to
  // ~76° latitude, so scanning the 3×3 neighbourhood sees every pair the edge
  // rules could join.
  const CELL = 0.02;
  const grid = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const key = `${Math.floor(nodes[i].lat / CELL)}:${Math.floor(nodes[i].lon / CELL)}`;
    let bucket = grid.get(key);
    if (bucket === undefined) { bucket = []; grid.set(key, bucket); }
    bucket.push(i);
  }
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    const ci = Math.floor(a.lat / CELL);
    const cj = Math.floor(a.lon / CELL);
    const nameA = normName(a.name);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const bucket = grid.get(`${ci + di}:${cj + dj}`);
        if (bucket === undefined) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          const b = nodes[j];
          const d = haversineM(a.lat, a.lon, b.lat, b.lon);
          if (d <= SYNTH_CLUSTER_ANY_M
            || (d <= SYNTH_CLUSTER_NAME_M && nameA !== '' && nameA === normName(b.name))) {
            union(i, j);
          }
        }
      }
    }
  }

  const out = new Map();
  for (let i = 0; i < nodes.length; i++) out.set(nodes[i].nodeId, nodes[find(i)].nodeId);
  return out;
}

/** Modal choice over strings: highest count, ties to the code-point smallest. */
function modal(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  let bestCount = -1;
  for (const key of Array.from(counts.keys()).sort(cmpStr)) {
    const c = counts.get(key);
    if (c > bestCount) { best = key; bestCount = c; }
  }
  return best;
}

// ── distance along the line ───────────────────────────────────────────────────

/**
 * Positions of the (clipped) stops along the relation's chained line, metres,
 * non-decreasing by construction.
 *
 * The parts are concatenated in the build's order — a disconnected relation
 * carries its gap as line length, which slightly overstates the run across it
 * and is the honest reading of "the track continues somewhere off the map".
 * Each stop takes the nearest point of the line at or after the previous stop's
 * position — monotone, so a loop line's second visit to a shared vertex lands on
 * the second pass, not back at the first. A stop the line never comes within
 * `PROJECTION_LEASH_M` of (or a relation with no usable line at all) falls back
 * to chord distance from its predecessor.
 *
 * @param {Array<Array<[number, number]>>} lines
 * @param {Array<{lat:number, lon:number}>} stops travel order
 * @returns {number[]} metres from the line start, same length as `stops`
 */
function stopPositionsAlong(lines, stops) {
  const pts = [];
  for (const part of lines || []) {
    for (const p of part) {
      const last = pts[pts.length - 1];
      if (last !== undefined && last[0] === p[0] && last[1] === p[1]) continue;
      pts.push(p);
    }
  }

  const chordFrom = (positions, i) => (i === 0 ? 0
    : positions[i - 1] + haversineM(stops[i - 1].lat, stops[i - 1].lon, stops[i].lat, stops[i].lon));

  const positions = [];
  if (pts.length < 2) {
    for (let i = 0; i < stops.length; i++) positions.push(chordFrom(positions, i));
    return positions;
  }

  const proj = Projection.about(pts);
  const P = pts.map((p) => proj.xy(p[0], p[1]));
  const cum = [0];
  for (let k = 1; k < P.length; k++) {
    const dx = P[k][0] - P[k - 1][0];
    const dy = P[k][1] - P[k - 1][1];
    cum.push(cum[k - 1] + Math.hypot(dx, dy));
  }

  let prev = 0;
  for (let i = 0; i < stops.length; i++) {
    const [sx, sy] = proj.xy(stops[i].lat, stops[i].lon);
    let bestPos = null;
    let bestDist = Infinity;
    for (let k = 0; k + 1 < P.length; k++) {
      if (cum[k + 1] < prev) continue;                     // segment wholly behind us
      const [ax, ay] = P[k];
      const [bx, by] = P[k + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const len = cum[k + 1] - cum[k];
      let t = len > 0 ? ((sx - ax) * dx + (sy - ay) * dy) / (len * len) : 0;
      const tMin = len > 0 ? Math.max(0, (prev - cum[k]) / len) : 0;
      t = Math.min(1, Math.max(tMin, t));
      const qx = ax + t * dx;
      const qy = ay + t * dy;
      const d = Math.hypot(sx - qx, sy - qy);
      if (d < bestDist) { bestDist = d; bestPos = cum[k] + t * len; }
    }
    positions.push(bestPos !== null && bestDist <= PROJECTION_LEASH_M
      ? bestPos : chordFrom(positions, i));
    prev = positions[i];
  }
  return positions;
}

// ── tag parsing ───────────────────────────────────────────────────────────────

/**
 * The `interval` tag → headway seconds, or null when it is unusable. The wiki
 * grammar in the wild: bare digits are minutes, one colon is H:MM, two are
 * H:MM:SS. Values outside the sanity band are discarded rather than clamped —
 * '10:00' meaning "every 10 minutes" written in the hours grammar would
 * otherwise become a six-hundred-minute headway, and a wrong default beats a
 * confidently wrong tag.
 */
function parseIntervalS(text) {
  if (text === null || text === undefined) return null;
  const t = String(text).trim();
  let s = null;
  let m;
  if (/^\d+$/.test(t)) s = Number(t) * 60;
  else if ((m = /^(\d+):(\d{2})$/.exec(t)) !== null) s = Number(m[1]) * 3600 + Number(m[2]) * 60;
  else if ((m = /^(\d+):(\d{2}):(\d{2})$/.exec(t)) !== null) {
    s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  } else return null;
  return (s >= SYNTH_HEADWAY_MIN_S && s <= SYNTH_HEADWAY_MAX_S) ? s : null;
}

// The colour tag is overwhelmingly '#RRGGBB' in the build corpus, with a short
// tail of CSS names (Tokyo, Berlin). The basic CSS keywords cover that tail;
// anything else is omitted rather than guessed.
const CSS_COLOURS = Object.freeze({
  aqua: '00FFFF', black: '000000', blue: '0000FF', brown: 'A52A2A', cyan: '00FFFF',
  darkblue: '00008B', darkgreen: '006400', darkred: '8B0000', fuchsia: 'FF00FF',
  gold: 'FFD700', gray: '808080', green: '008000', grey: '808080',
  lightblue: 'ADD8E6', lime: '00FF00', magenta: 'FF00FF', maroon: '800000',
  navy: '000080', olive: '808000', orange: 'FFA500', pink: 'FFC0CB',
  purple: '800080', red: 'FF0000', silver: 'C0C0C0', teal: '008080',
  violet: 'EE82EE', white: 'FFFFFF', yellow: 'FFFF00',
});

/** OSM `colour` → GTFS `route_color` ('RRGGBB', uppercase), or '' to omit. */
function parseColour(text) {
  if (text === null || text === undefined) return '';
  const t = String(text).trim();
  let m = /^#?([0-9a-fA-F]{6})$/.exec(t);
  if (m !== null) return m[1].toUpperCase();
  m = /^#([0-9a-fA-F]{3})$/.exec(t);
  if (m !== null) return m[1].split('').map((c) => c + c).join('').toUpperCase();
  return CSS_COLOURS[t.toLowerCase()] || '';
}

// ── CSV and zip emission ──────────────────────────────────────────────────────

function csvField(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC-4180, LF endings, trailing newline — the dialect the reader round-trips. */
function csvTable(header, rows) {
  const out = [header.join(',')];
  for (const row of rows) out.push(header.map((h) => csvField(row[h])).join(','));
  return `${out.join('\n')}\n`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// The one fixed timestamp every entry carries: the DOS epoch, 1980-01-01 00:00.
// A timestamp of "now" would make two identical synth runs hash differently and
// break every content-addressed thing downstream.
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;

/**
 * A stored-entry (method 0) zip of UTF-8 text files. `gtfs/feed.js`'s reader
 * takes the central directory as authoritative and accepts method 0, so this is
 * the smallest archive it round-trips; deflate would buy nothing but a
 * dependency on a compressor's byte-for-byte stability.
 *
 * @param {Array<{name:string, text:string}>} files sorted by name by the caller
 * @returns {Uint8Array}
 */
function buildZip(files) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const nameB = enc.encode(file.name);
    const data = enc.encode(file.text);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameB.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);                 // version needed
    lv.setUint16(6, 0, true);                  // flags
    lv.setUint16(8, 0, true);                  // method 0, stored
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);       // compressed == uncompressed
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameB.length, true);
    lv.setUint16(28, 0, true);                 // extra
    local.set(nameB, 30);
    local.set(data, 30 + nameB.length);

    const central = new Uint8Array(46 + nameB.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);                 // version made by
    cv.setUint16(6, 20, true);                 // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint32(42, offset, true);            // local header offset
    central.set(nameB, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  let cdSize = 0;
  for (const c of centrals) cdSize += c.length;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const zip = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, eocd]) { zip.set(part, at); at += part.length; }
  return zip;
}

// ── the converter ─────────────────────────────────────────────────────────────

/** The maximal contiguous run of `true` in `flags` — `[start, length]`, first
 *  such run on a tie so the answer is deterministic. */
function longestRun(flags) {
  let bestStart = 0;
  let bestLen = 0;
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    if (i < flags.length && flags[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start > bestLen) { bestStart = start; bestLen = i - start; }
      start = -1;
    }
  }
  return [bestStart, bestLen];
}

/** True when the relation's chained geometry closes on itself — the parts,
 *  concatenated in the build's order, end where they began. The stop list has
 *  its own closure test (a repeated endpoint node) at the call site; either
 *  reading makes the relation circular. */
function lineClosed(lines) {
  const pts = [];
  for (const part of lines || []) for (const p of part) pts.push(p);
  return pts.length >= 3
    && pts[0][0] === pts[pts.length - 1][0]
    && pts[0][1] === pts[pts.length - 1][1];
}

/**
 * Synthesize a GTFS zip from OSM route relations clipped to a drawn border.
 *
 * Pure and synchronous: the same `routes`, `ring` and `asOf` produce
 * byte-identical output. Both return fields are structured-clone-safe. Throws
 * when nothing survives clipping — the worker's per-source failure path already
 * knows how to say "this source produced no feed", and an empty zip would fail
 * inside `loadFeed` with a worse message.
 *
 * @param {{routes: Array<Object>, ring: Array<[number, number]>, asOf?: string|null}} input
 *   `routes` — `worldTransitRoutes` output (shape in the module header);
 *   `ring` — the drawn border, `[[lat, lon], …]`, ≥ 3 vertices;
 *   `asOf` — optional analysis date, `'YYYYMMDD'` (dashes tolerated).
 * @returns {{zip: Uint8Array, notes: string[]}} the feed bytes for `loadFeed`,
 *   and the assumptions/drops in prose for provenance.
 */
export function synthesizeFeedZip({ routes, ring, asOf = null }) {
  if (!Array.isArray(routes)) throw new TypeError('synthesizeFeedZip: routes must be an array');
  if (!Array.isArray(ring) || ring.length < 3
    || ring.some((p) => !Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) {
    throw new TypeError('synthesizeFeedZip: ring must be [[lat, lon], …] with at least 3 vertices');
  }

  // ── 1 · clip each relation's stop list to the border ────────────────────────
  const considered = routes.slice().sort((a, b) => a.osmId - b.osmId);
  const kept = [];
  let droppedOutside = 0;
  let clippedStops = 0;
  for (const rel of considered) {
    const listed = Array.isArray(rel.stops) ? rel.stops : [];
    // A circular relation has no honest list origin — the build seeds its walk on
    // the lowest-id segment — so its maximal contiguous run is found around the
    // loop, where it may wrap the list seam. Circular means the stop list repeats
    // its endpoint (the PTv2 shape; the duplicate comes off so the loop is one
    // visit per stop) or the chained geometry closes on itself.
    const loops = listed.length >= 3 && listed[0].nodeId === listed[listed.length - 1].nodeId;
    const stops = loops ? listed.slice(0, -1) : listed;
    const circular = loops || (stops.length >= 3 && lineClosed(rel.lines));
    const inside = stops.map((s) => pointInRing([s.lat, s.lon], ring));
    // The circular run comes from `longestRun` over the flags doubled, capped at
    // one lap; the doubled array is periodic, so the leftmost winner starts in the
    // first copy and the answer stays deterministic.
    let [runStart, runLen] = longestRun(circular ? inside.concat(inside) : inside);
    if (circular) {
      runLen = Math.min(runLen, stops.length);
      runStart %= stops.length;
    }
    if (runLen < 2) { droppedOutside++; continue; }
    clippedStops += stops.length - runLen;
    const wraps = runStart + runLen > stops.length;
    let clipped = wraps
      ? Array.from({ length: runLen }, (_, i) => stops[(runStart + i) % stops.length])
      : stops.slice(runStart, runStart + runLen);
    // A loop whose every stop survives keeps its closing return to the first stop,
    // exactly as the list wrote it — the trip rides the full circle.
    if (loops && runLen === stops.length) clipped = clipped.concat([clipped[0]]);
    kept.push({ rel, clipped, wraps });
  }
  if (!kept.length) {
    throw new Error('no OSM route relation keeps two stops inside the drawn border; '
      + 'there is nothing to synthesize a feed from');
  }

  // ── 2 · cluster stop nodes into GTFS stops ──────────────────────────────────
  const nodeById = new Map();
  for (const { clipped } of kept) {
    for (const s of clipped) if (!nodeById.has(s.nodeId)) nodeById.set(s.nodeId, s);
  }
  const nodes = Array.from(nodeById.values()).sort((a, b) => a.nodeId - b.nodeId);
  const repOf = clusterNodes(nodes);

  const members = new Map();                    // representative nodeId → member nodes
  for (const n of nodes) {
    const rep = repOf.get(n.nodeId);
    let list = members.get(rep);
    if (list === undefined) { list = []; members.set(rep, list); }
    list.push(n);
  }
  const clusters = new Map();                   // representative nodeId → stop record
  for (const rep of Array.from(members.keys()).sort((a, b) => a - b)) {
    const list = members.get(rep);
    const names = list.map((n) => normName(n.name)).filter((s) => s !== '');
    const enNames = list.map((n) => normName(n.nameEn)).filter((s) => s !== '');
    let lat = 0;
    let lon = 0;
    for (const n of list) { lat += n.lat; lon += n.lon; }
    clusters.set(rep, {
      stopId: `n${rep}`,
      name: names.length ? modal(names) : (enNames.length ? modal(enNames) : `Stop ${rep}`),
      lat: lat / list.length,
      lon: lon / list.length,
    });
  }

  // ── 3–5 · one route, one template trip, one frequencies row per relation ────
  const [windowStartS, windowEndS] = SYNTH_SERVICE_WINDOW_S;
  const routeRows = [];
  const tripRows = [];
  const stopTimeRows = [];
  const freqRows = [];
  const usedClusters = new Set();
  let droppedCollapsed = 0;
  let droppedTooLong = 0;
  let headwayFromTag = 0;
  let headwayAssumed = 0;
  let unknownModes = 0;

  for (const { rel, clipped, wraps } of kept) {
    const mode = rel.tags.route === null || rel.tags.route === undefined
      ? '' : String(rel.tags.route);
    const known = Object.prototype.hasOwnProperty.call(SYNTH_MODE_ROUTE_TYPE, mode);

    // Consecutive stops that clustered together collapse to one; a relation
    // reduced below two distinct stops has nothing left to ride.
    const seq = [];
    for (const s of clipped) {
      const rep = repOf.get(s.nodeId);
      if (seq.length && seq[seq.length - 1].rep === rep) continue;
      seq.push({ rep, stop: s });
    }
    if (seq.length < 2) { droppedCollapsed++; continue; }

    // A wrapped run rides across the list seam, so the closed line is laid out
    // twice and the post-seam stops project onto the second lap instead of
    // falling back to chord distance across the join.
    const positions = stopPositionsAlong(
      wraps ? [...(rel.lines || []), ...(rel.lines || [])] : rel.lines,
      seq.map((e) => e.stop));
    const speedMps = (known ? SYNTH_MODE_SPEED_KMH[mode] : UNKNOWN_MODE_SPEED_KMH) / 3.6;
    const times = [SYNTH_TEMPLATE_ANCHOR_S];
    for (let i = 1; i < seq.length; i++) {
      const travel = Math.max(1, Math.round((positions[i] - positions[i - 1]) / speedMps));
      times.push(times[i - 1] + travel + SYNTH_DWELL_S);
    }

    // Landmine 3: the last frequency slot departs just before the window end, so
    // the whole template duration must fit between there and the 30-hour day.
    const duration = times[times.length - 1] - SYNTH_TEMPLATE_ANCHOR_S;
    if (windowEndS + duration >= SERVICE_DAY_SECONDS) { droppedTooLong++; continue; }

    // Counted only past both drop checks: the note below discloses a treatment,
    // and a relation that was dropped instead was not treated at all.
    if (!known) unknownModes++;

    const routeId = `r${rel.osmId}`;
    const tripId = `t${rel.osmId}`;
    routeRows.push({
      route_id: routeId,
      agency_id: 'osm',
      route_short_name: normName(rel.tags.ref),
      route_long_name: normName(rel.tags.name) || normName(rel.tags.nameEn),
      route_type: known ? SYNTH_MODE_ROUTE_TYPE[mode] : UNKNOWN_MODE_ROUTE_TYPE,
      route_color: parseColour(rel.tags.colour),
    });

    const lastCluster = clusters.get(seq[seq.length - 1].rep);
    tripRows.push({
      route_id: routeId,
      service_id: 'wk',
      trip_id: tripId,
      trip_headsign: lastCluster.name,
      direction_id: '0',
    });

    for (let i = 0; i < seq.length; i++) {
      usedClusters.add(seq[i].rep);
      stopTimeRows.push({
        trip_id: tripId,
        arrival_time: hhmmss(times[i]),
        departure_time: hhmmss(times[i]),
        stop_id: clusters.get(seq[i].rep).stopId,
        stop_sequence: String(i + 1),
      });
    }

    const tagged = parseIntervalS(rel.tags.interval);
    if (tagged !== null) headwayFromTag++; else headwayAssumed++;
    const headway = tagged !== null ? tagged
      : (known ? SYNTH_MODE_HEADWAY_S[mode] : UNKNOWN_MODE_HEADWAY_S);
    freqRows.push({
      trip_id: tripId,
      start_time: hhmmss(windowStartS),
      end_time: hhmmss(windowEndS),
      headway_secs: String(headway),
    });
  }
  if (!routeRows.length) {
    throw new Error('every OSM route relation inside the border collapsed under stop '
      + 'clustering or overran the service day; there is nothing to synthesize');
  }

  // ── stops.txt: only clusters some trip actually serves ──────────────────────
  const stopRows = [];
  for (const rep of Array.from(usedClusters).sort((a, b) => a - b)) {
    const c = clusters.get(rep);
    stopRows.push({
      stop_id: c.stopId,
      stop_name: c.name,
      stop_lat: c.lat.toFixed(6),
      stop_lon: c.lon.toFixed(6),
    });
  }

  // ── 6 · calendar: 14 days from the window Monday, every day alike ───────────
  const startDate = windowMonday(asOf);
  const endDate = addDays(startDate, SYNTH_CALENDAR_DAYS - 1);
  const calendarRows = [{
    service_id: 'wk',
    monday: '1', tuesday: '1', wednesday: '1', thursday: '1', friday: '1',
    saturday: '1', sunday: '1',
    start_date: startDate,
    end_date: endDate,
  }];

  // ── 7 · agency: majority network tag, longitude-derived nominal clock ───────
  const networkVotes = kept.map(({ rel }) => normName(rel.tags.network)).filter((s) => s !== '');
  const operatorVotes = kept.map(({ rel }) => normName(rel.tags.operator)).filter((s) => s !== '');
  const agencyName = networkVotes.length ? modal(networkVotes)
    : (operatorVotes.length ? modal(operatorVotes) : 'OpenStreetMap-derived');

  let lonSum = 0;
  for (const row of stopRows) lonSum += Number(row.stop_lon);
  const utcOffset = Math.max(-12, Math.min(12, Math.round(lonSum / stopRows.length / 15)));
  // POSIX Etc/GMT zones spell their sign backwards: Etc/GMT-1 is UTC+1.
  const timezone = utcOffset === 0 ? 'Etc/GMT'
    : (utcOffset > 0 ? `Etc/GMT-${utcOffset}` : `Etc/GMT+${-utcOffset}`);
  const agencyRows = [{
    agency_id: 'osm',
    agency_name: agencyName,
    agency_url: 'https://www.openstreetmap.org/',
    agency_timezone: timezone,
  }];

  const feedInfoRows = [{
    feed_publisher_name: 'Synthesized from OpenStreetMap route relations '
      + '(© OpenStreetMap contributors, ODbL); the timetable is assumed, not published',
    feed_publisher_url: 'https://www.openstreetmap.org/',
    feed_lang: 'mul',
    feed_start_date: startDate,
    feed_end_date: endDate,
    feed_version: 'osm-synth-1',
  }];

  // ── 8 · the zip: sorted rows, sorted names, fixed timestamps ────────────────
  routeRows.sort((a, b) => cmpStr(a.route_id, b.route_id));
  tripRows.sort((a, b) => cmpStr(a.trip_id, b.trip_id));
  freqRows.sort((a, b) => cmpStr(a.trip_id, b.trip_id));
  stopTimeRows.sort((a, b) => cmpStr(a.trip_id, b.trip_id)
    || (Number(a.stop_sequence) - Number(b.stop_sequence)));
  stopRows.sort((a, b) => cmpStr(a.stop_id, b.stop_id));

  const files = [
    { name: 'agency.txt', text: csvTable(['agency_id', 'agency_name', 'agency_url', 'agency_timezone'], agencyRows) },
    { name: 'calendar.txt', text: csvTable(['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'], calendarRows) },
    { name: 'feed_info.txt', text: csvTable(['feed_publisher_name', 'feed_publisher_url', 'feed_lang', 'feed_start_date', 'feed_end_date', 'feed_version'], feedInfoRows) },
    { name: 'frequencies.txt', text: csvTable(['trip_id', 'start_time', 'end_time', 'headway_secs'], freqRows) },
    { name: 'routes.txt', text: csvTable(['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type', 'route_color'], routeRows) },
    { name: 'stop_times.txt', text: csvTable(['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'], stopTimeRows) },
    { name: 'stops.txt', text: csvTable(['stop_id', 'stop_name', 'stop_lat', 'stop_lon'], stopRows) },
    { name: 'trips.txt', text: csvTable(['route_id', 'service_id', 'trip_id', 'trip_headsign', 'direction_id'], tripRows) },
  ];
  files.sort((a, b) => cmpStr(a.name, b.name));

  // ── the assumptions, in prose, for the provenance page ──────────────────────
  // The clustering note counts numerator and denominator over the same
  // population — the clusters some emitted trip actually serves. A relation
  // dropped after clustering takes its nodes out of both sides, or the stated
  // ratio would call a drop a merge.
  let servedNodes = 0;
  for (const rep of usedClusters) servedNodes += members.get(rep).length;
  const notes = [
    `${considered.length} OSM route relations considered; ${routeRows.length} synthesized `
      + `into routes, ${droppedOutside} dropped with fewer than two stops inside the border, `
      + `${droppedCollapsed} collapsed to a single stop by clustering, `
      + `${droppedTooLong} dropped for overrunning the service day.`,
    `${clippedStops} stops clipped away where lines run past the border; each relation `
      + 'keeps its longest contiguous run of in-border stops.',
    `${servedNodes} OSM stop nodes clustered into ${stopRows.length} stops (same name `
      + `within ${SYNTH_CLUSTER_NAME_M} m, or any pair within ${SYNTH_CLUSTER_ANY_M} m).`,
    `Headways: ${headwayFromTag} from an OSM interval tag, ${headwayAssumed} assumed at `
      + `mode defaults; service assumed ${hhmmss(windowStartS)}–${hhmmss(windowEndS)} every day.`,
    'Stop-to-stop times assumed from distance along the mapped line at mode speeds '
      + `(km/h: subway ${SYNTH_MODE_SPEED_KMH.subway}, light rail/tram ${SYNTH_MODE_SPEED_KMH.tram}, `
      + `train ${SYNTH_MODE_SPEED_KMH.train}, monorail ${SYNTH_MODE_SPEED_KMH.monorail}, `
      + `funicular ${SYNTH_MODE_SPEED_KMH.funicular}) plus ${SYNTH_DWELL_S} s dwell.`,
    `Calendar: ${SYNTH_CALENDAR_DAYS} days from ${startDate}, the Monday of the week `
      + `containing ${String(asOf ?? '').trim() ? 'the analysis date' : 'the fixed fallback date'}; `
      + 'every day runs the same assumed service.',
    `Agency ${JSON.stringify(agencyName)} from the relations' network/operator tags; `
      + `timezone ${timezone} derived from longitude and nominal only.`,
  ];
  if (unknownModes) {
    notes.push(`${unknownModes} synthesized relation(s) carried a route value outside the six `
      + `rail modes and were assumed at ${UNKNOWN_MODE_SPEED_KMH} km/h, with a `
      + `${UNKNOWN_MODE_HEADWAY_S} s headway where the interval tag was unusable, published `
      + `as route_type ${UNKNOWN_MODE_ROUTE_TYPE} (tram).`);
  }

  return { zip: buildZip(files), notes };
}
