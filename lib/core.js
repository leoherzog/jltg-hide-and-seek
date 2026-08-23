// lib/core.js
// ─────────────────────────────────────────────────────────────────────────────
// S0 · CONSTANTS, NUMBERS, DETERMINISTIC JSON, HASHING
//
// Ported from generate.py's constants, number formatting, and deterministic
// JSON + hashing sections.
//
// THE RULE (carried over verbatim from the Python): no section formats a number
// by hand. Every quantity that reaches the HTML or the embedded JSON goes
// through exactly one of the functions below, so two sections can never print
// the same value differently. Rounding happens at the point of *formatting*,
// never at the point of computation.
//
// Worker-safe: no DOM, no window, no wall clock.
// ─────────────────────────────────────────────────────────────────────────────

// ══ CONSTANTS ═══════════════════════════════════════════════════════════════

export const GENERATOR = 'jltg-hide-and-seek';
export const VERSION = '1.0.0';

// ── units ───────────────────────────────────────────────────────────────────
export const M_PER_MILE = 1609.344;
export const M_PER_KM = 1000.0;
export const QUARTER_MILE_M = 402.336;   // exact; do NOT round to 400 or counts stop reproducing
export const HALF_MILE_M = 804.672;      // exact
export const SQM_PER_SQMI = M_PER_MILE * M_PER_MILE;
export const EARTH_R_M = 6371008.8;      // IUGG mean radius

// ── travel-time model (specs/gtfs.md §4.1) ──────────────────────────────────
export const WALK_SPEED_MPS = 1.2;       // deliberately below the 1.4 pedestrian norm
export const WALK_RADIUS_M = 400.0;      // straight-line transfer radius
export const WALK_CIRCUITY = 1.3;        // straight-line → street distance
export const BOARD_SLACK_S = 0;          // options.boardSlackS overrides
export const MAX_TRANSFERS = 4;          // K; measured to saturate at 2 on a radial bus feed
export const DEFAULT_DEPARTURE = '09:00:00';   // mid-morning on the representative day
export const SERVICE_DAY_SECONDS = 30 * 3600;  // service days legally run past 24:00; never modulo 86400

// ── analysis windows ────────────────────────────────────────────────────────
export const HEADWAY_WINDOW = Object.freeze(['06:00:00', '22:00:00']);
export const MIDDAY_WINDOW = Object.freeze(['10:00:00', '14:00:00']);
export const FREQUENT_HEADWAY_MIN = 15;  // a stop is "frequent" if one route-direction beats this
export const STATION_CLUSTER_M = 100.0;  // single-link station synthesis (specs/gtfs.md §3.2)
export const HUB_SNAP_M = 200.0;         // snap the hub to the busiest member of its cluster
export const T90_ORIGIN_STRIDE = 30;     // sorted(served)[::30] → ~50 deterministic origins
export const RADAR_SAMPLE_PAIRS = 200000; // deterministic stop-pair sample for radar liveness
export const RADAR_DEAD_HIGH = 0.98;     // hit rate above this ⇒ always "yes" ⇒ dead
export const RADAR_DEAD_LOW = 0.02;      // hit rate below this ⇒ always "no"  ⇒ dead
export const SEEKER_SAMPLE_CAP = 200;    // |S| for the surv computation when n > 400
export const SURV_FULL_UNIVERSE_MAX = 400; // S = Z below this

// ── network shape classification (specs/gtfs.md §6.1) ───────────────────────
export const HUB_RADIAL_MIN = 0.50;
export const HUB_SEMI_RADIAL_MIN = 0.25;

// ── front-end chrome (copied verbatim from the hand-built drafts) ───────────
// The WebAwesome kit and MapLibre's stylesheet are `<link>`ed by index.html directly
// and have no constant here: nothing in module code needs their URLs. `MAPLIBRE_JS`
// does, because `PAGE_RUNTIME_JS` substitutes it into an `import()`.
export const MAPLIBRE_JS = 'https://cdn.jsdelivr.net/npm/maplibre-gl/+esm';
export const TILES_LIGHT = 'https://tiles.openfreemap.org/styles/positron';
export const TILES_DARK = 'https://tiles.openfreemap.org/styles/dark';

// How many feeds one run may merge (CONTRACT.md §(d): `1 <= sources.length <= 6`).
// It lives here because three modules have to agree about it and none of them may
// own it: the picker refuses the seventh pick, `readSources` refuses a seventh that
// arrived by a different door (six map picks plus a dropped zip), and the worker
// refuses one it was handed anyway. The number is a memory and time bound — two
// metro feeds already merge 2.35 M stop_times — not a matter of taste.
export const MAX_FEEDS_PER_RUN = 6;

// Countries that read distances in miles (drives MapLibre's ScaleControl unit).
// A plain sorted Array, not a Set, so it is structured-clone-safe and stable.
export const IMPERIAL_COUNTRIES = Object.freeze(['gb', 'lr', 'mm', 'us']);

// ══ NUMBERS — one rounding policy for the whole program ═════════════════════

/**
 * Split a finite number into its shortest round-trip decimal digits.
 * JS `String(x)` is the shortest repr that round-trips, exactly like Python's
 * `repr()`, so this is the JS spelling of `Decimal(repr(x))`.
 * @param {number} x
 * @returns {{neg: boolean, int: string, frac: string}}
 */
function decimalParts(x) {
  let s = String(x);
  let neg = false;
  if (s[0] === '-') { neg = true; s = s.slice(1); }
  else if (s[0] === '+') { s = s.slice(1); }
  let exp = 0;
  const e = s.indexOf('e') >= 0 ? s.indexOf('e') : s.indexOf('E');
  if (e >= 0) { exp = parseInt(s.slice(e + 1), 10); s = s.slice(0, e); }
  let int = s;
  let frac = '';
  const dot = s.indexOf('.');
  if (dot >= 0) { int = s.slice(0, dot); frac = s.slice(dot + 1); }
  if (exp > 0) {
    while (exp > 0) { int += frac[0] !== undefined ? frac[0] : '0'; frac = frac.slice(1); exp--; }
  } else if (exp < 0) {
    while (exp < 0) {
      const last = int.length ? int[int.length - 1] : '0';
      frac = last + frac;
      int = int.slice(0, -1);
      exp++;
    }
  }
  int = int.replace(/^0+(?=\d)/, '');
  if (int === '') int = '0';
  return { neg, int, frac };
}

/** Increment a decimal digit string by one, growing it if it carries out. */
function incDigits(digits) {
  const a = digits.split('');
  let i = a.length - 1;
  for (; i >= 0; i--) {
    if (a[i] === '9') { a[i] = '0'; } else { a[i] = String(Number(a[i]) + 1); break; }
  }
  if (i < 0) a.unshift('1');
  return a.join('');
}

/**
 * `rhu`, returned as its component pieces so `num()` can format without a
 * second float round-trip. `frac` is exactly `dp` digits long.
 * @param {number} x
 * @param {number} dp
 * @returns {{neg: boolean, int: string, frac: string}}
 */
function rhuParts(x, dp) {
  if (!Number.isFinite(x)) throw new RangeError(`cannot round non-finite ${x}`);
  const { neg, int, frac } = decimalParts(x);
  let digits = int + frac;
  const pointAt = int.length;             // digits[0..pointAt) is the integer part
  const keep = pointAt + dp;              // number of digits to keep
  if (keep >= digits.length) {
    return { neg, int, frac: frac + '0'.repeat(dp - frac.length) };
  }
  let kept = keep <= 0 ? '' : digits.slice(0, keep);
  // ROUND_HALF_UP: ties go away from zero, so look only at the first dropped digit.
  const first = keep < 0 ? '0' : digits.charAt(keep);
  let carry = first >= '5';
  if (keep <= 0) {
    // Everything, including part of the integer part, is dropped. Only possible
    // for dp < 0, which nothing in this program uses; treat as zero + carry.
    kept = carry ? '1' : '0';
    carry = false;
    return { neg, int: kept, frac: '' };
  }
  if (carry) kept = incDigits(kept);
  const grew = kept.length - keep;        // 1 when the carry added a digit
  const newPoint = pointAt + grew;
  const outInt = kept.slice(0, newPoint) || '0';
  const outFrac = kept.slice(newPoint);
  return { neg, int: outInt, frac: outFrac + '0'.repeat(Math.max(0, dp - outFrac.length)) };
}

/**
 * Round half **up** (not banker's) to `dp` decimal places.
 *
 * `Math.round` is half-up-toward-+∞ (wrong for negatives) and `toFixed` is
 * round-half-to-even on the *binary* value (wrong at representation
 * boundaries: `(2.675).toFixed(2) === '2.67'`). This mirrors Python's
 * `Decimal(repr(x)).quantize(Decimal(1).scaleb(-dp), ROUND_HALF_UP)` by doing
 * the rounding on the shortest round-trip decimal string.
 *
 * @param {number} x
 * @param {number} [dp=0]
 * @returns {number}
 */
export function rhu(x, dp = 0) {
  const p = rhuParts(x, dp);
  const body = p.frac ? `${p.int}.${p.frac}` : p.int;
  const v = Number(body);
  return p.neg ? -v : v;
}

/** Group an integer digit string with commas: '1493' → '1,493'. */
function group(int) {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format a plain number: `num(1493)` → '1,493', `num(76.83, 1)` → '76.8'.
 * @param {number} x
 * @param {number} [dp=0]
 * @param {{comma?: boolean}} [opts]
 * @returns {string}
 */
export function num(x, dp = 0, opts = {}) {
  const comma = opts.comma !== undefined ? opts.comma : true;
  const p = rhuParts(x, dp);
  const int = comma ? group(p.int) : p.int;
  const body = dp > 0 ? `${int}.${p.frac}` : int;
  // Python prints a negative zero as '-0'; keep the surprise.
  return p.neg ? `-${body}` : body;
}

/**
 * Format a 0..1 fraction as a percentage: `pct(0.126)` → '12.6%'.
 * @param {number} frac
 * @param {number} [dp=1]
 */
export function pct(frac, dp = 1) {
  return `${num(frac * 100, dp, { comma: false })}%`;
}

/**
 * Format a duration given in minutes: `mins(76.8, 1)` → '76.8 min'.
 * @param {number} minutes
 * @param {number} [dp=0]
 */
export function mins(minutes, dp = 0) {
  return `${num(minutes, dp)} min`;
}

/**
 * Format a distance given in metres, as miles: `miles(15270)` → '9.49 mi'.
 * @param {number} metres
 * @param {number} [dp=2]
 */
export function miles(metres, dp = 2) {
  return `${num(metres / M_PER_MILE, dp)} mi`;
}

/**
 * Format a distance given in metres, as kilometres.
 * @param {number} metres
 * @param {number} [dp=1]
 */
export function km(metres, dp = 1) {
  return `${num(metres / M_PER_KM, dp)} km`;
}

/**
 * Format an area given in m², as square miles: → '160.1 sq mi'.
 * @param {number} sqMetres
 * @param {number} [dp=1]
 */
export function sqmi(sqMetres, dp = 1) {
  return `${num(sqMetres / SQM_PER_SQMI, dp)} sq mi`;
}

/**
 * Quantise a latitude/longitude to 6 dp (~11 cm). All coordinates in the
 * emitted JSON pass through this so the payload is byte-stable.
 * @param {number} x
 * @returns {number}
 */
export function coord(x) {
  return rhu(x, 6);
}

/** Python's floor division, which differs from JS `/ | 0` for negatives. */
function floorDiv(a, b) { return Math.floor(a / b); }
/** Python's modulo, whose sign follows the divisor. */
function pyMod(a, b) { return ((a % b) + b) % b; }

/**
 * Format seconds-since-service-day-start as 'H:MM', keeping hours past 24.
 *
 * `hhmm(87360)` → '24:16'. Never modulo by 86400 — a last bus at 24:16 really
 * is later than one at 23:59.
 * @param {number} seconds
 * @returns {string}
 */
export function hhmm(seconds) {
  const s = Math.trunc(rhu(seconds));
  return `${floorDiv(s, 3600)}:${String(floorDiv(pyMod(s, 3600), 60)).padStart(2, '0')}`;
}

/**
 * Format seconds-since-service-day-start as 'H:MM:SS', keeping hours past 24.
 * @param {number} seconds
 * @returns {string}
 */
export function hhmmss(seconds) {
  const s = Math.trunc(rhu(seconds));
  return `${floorDiv(s, 3600)}:${String(floorDiv(pyMod(s, 3600), 60)).padStart(2, '0')}`
    + `:${String(pyMod(s, 60)).padStart(2, '0')}`;
}

function strictInt(text) {
  const t = text.trim();
  if (!/^[+-]?\d+$/.test(t)) throw new SyntaxError(`not an integer: ${JSON.stringify(text)}`);
  return parseInt(t, 10);
}

/**
 * Parse a GTFS 'H:MM:SS' time to seconds since service-day start.
 *
 * Returns null for a blank/absent time (legal at non-timepoint stops). Hours
 * are not zero-padded in many feeds and may exceed 23; both are handled.
 * @param {string|null|undefined} value
 * @returns {number|null}
 */
export function hmsToS(value) {
  if (value === null || value === undefined || !String(value).trim()) return null;
  const parts = String(value).trim().split(':');
  if (parts.length !== 3) throw new SyntaxError(`not a GTFS time: ${JSON.stringify(value)}`);
  return strictInt(parts[0]) * 3600 + strictInt(parts[1]) * 60 + strictInt(parts[2]);
}

// ── pure calendar arithmetic on 'YYYYMMDD' strings ──────────────────────────
// Deliberately NOT `new Date(string)`: that would drag in the host timezone and
// make the output depend on where the browser is sitting.

const MONTH_LEN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DOW_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

/** Parse and validate 'YYYYMMDD' → [y, m, d]. Throws exactly where Python does. */
function ymd(yyyymmdd) {
  const s = String(yyyymmdd);
  if (!/^\d{8}$/.test(s)) throw new RangeError(`not a GTFS date: ${JSON.stringify(yyyymmdd)}`);
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6));
  if (m < 1 || m > 12) throw new RangeError(`month out of range: ${JSON.stringify(yyyymmdd)}`);
  const len = m === 2 && isLeap(y) ? 29 : MONTH_LEN[m - 1];
  if (d < 1 || d > len) throw new RangeError(`day out of range: ${JSON.stringify(yyyymmdd)}`);
  return [y, m, d];
}

/** Days since 1970-01-01 (Howard Hinnant's days_from_civil). Proleptic Gregorian. */
function daysFromCivil(y, m, d) {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of `daysFromCivil`. */
function civilFromDays(z0) {
  let z = z0 + 719468;
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

function pad(n, w) { return String(n).padStart(w, '0'); }

/**
 * '20260812' → 'Wed 12 Aug 2026'. Derived from the feed, never from the clock.
 * (Python's `'%a %-d %b %Y'` under the C locale; the English abbreviations are
 * hard-coded so the output cannot follow the browser's locale.)
 * @param {string} yyyymmdd
 * @returns {string}
 */
export function prettyDate(yyyymmdd) {
  const [y, m, d] = ymd(yyyymmdd);
  return `${DOW_NAMES[dowOf(yyyymmdd)]} ${d} ${MONTH_NAMES[m - 1]} ${y}`;
}

/**
 * Monday=0 … Sunday=6, for a GTFS date string.
 * @param {string} yyyymmdd
 * @returns {number}
 */
export function dowOf(yyyymmdd) {
  const [y, m, d] = ymd(yyyymmdd);
  // 1970-01-01 is a Thursday, which is Python weekday 3.
  return pyMod(daysFromCivil(y, m, d) + 3, 7);
}

/**
 * Every GTFS date string from `start` to `end` inclusive, ascending.
 * @param {string} start
 * @param {string} end
 * @returns {string[]}
 */
export function dateRange(start, end) {
  const a = ymd(start);
  const b = ymd(end);
  const z0 = daysFromCivil(a[0], a[1], a[2]);
  const z1 = daysFromCivil(b[0], b[1], b[2]);
  const out = [];
  for (let z = z0; z <= z1; z++) {
    const [y, m, d] = civilFromDays(z);
    out.push(`${pad(y, 4)}${pad(m, 2)}${pad(d, 2)}`);
  }
  return out;
}

/**
 * `sorted(v)[(n-1)//2]` — the lower of the two middle values for even n.
 *
 * Used for representative-day selection and for the game-size vote, where ties
 * must round *down* to the smaller/quieter option.
 * @param {number[]} values
 * @returns {number}
 */
export function lowerMedian(values) {
  const s = Array.from(values).sort((a, b) => a - b);
  if (!s.length) throw new RangeError('lowerMedian of an empty sequence');
  return s[Math.floor((s.length - 1) / 2)];
}

/**
 * Deterministic nearest-rank quantile: `sorted(v)[ceil(q*n)-1]`, clamped.
 *
 * Not an interpolating quantile — interpolation's edge behaviour differs across
 * implementations. Every p05/p50/p90/p95 on the page uses this one.
 * @param {number[]} values
 * @param {number} q
 * @returns {number}
 */
export function quantile(values, q) {
  const s = Array.from(values).sort((a, b) => a - b);
  if (!s.length) throw new RangeError('quantile of an empty sequence');
  const idx = Math.max(0, Math.min(s.length - 1, Math.ceil(q * s.length) - 1));
  return s[idx];
}

// ══ DETERMINISTIC JSON ══════════════════════════════════════════════════════

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

/**
 * Recursively quantise floats and convert sets/maps for serialisation.
 *
 * Returns plain JS values. NOTE: JS objects reorder integer-like keys, so the
 * key order of the returned object is NOT authoritative — `jdump` re-sorts at
 * emit time. Use this function for shape normalisation, `jdump` for bytes.
 *
 * @param {*} obj
 * @param {number} floatDp
 * @returns {*}
 */
export function normalise(obj, floatDp = 6) {
  if (obj === null) return null;
  const t = typeof obj;
  if (t === 'boolean' || t === 'string') return obj;
  if (t === 'number') {
    if (!Number.isFinite(obj)) return null;
    // Python passes `int` through untouched and quantises `float`; an
    // integer-valued JS number is indistinguishable from either, and both
    // paths produce the same integer, so keep it as-is.
    if (Number.isInteger(obj)) return obj;
    return rhu(obj, floatDp);
  }
  if (t === 'bigint') return Number(obj);
  if (Array.isArray(obj)) return obj.map((v) => normalise(v, floatDp));
  if (obj instanceof Set) {
    return Array.from(obj).sort(byString).map((v) => normalise(v, floatDp));
  }
  if (obj instanceof Map) {
    const out = {};
    for (const k of Array.from(obj.keys()).map(String).sort(cmpStr)) {
      out[k] = normalise(obj.get(k), floatDp);
    }
    return out;
  }
  if (obj instanceof Date) return obj.toISOString();
  if (isPlainObject(obj)) {
    const out = {};
    for (const k of Object.keys(obj).sort(cmpStr)) out[k] = normalise(obj[k], floatDp);
    return out;
  }
  throw new TypeError(`cannot serialise ${Object.prototype.toString.call(obj)} deterministically`);
}

/** Python `sorted(x, key=str)`: compare the string forms, by code unit. */
function byString(a, b) { return cmpStr(String(a), String(b)); }
function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function emitNumber(n) {
  if (!Number.isFinite(n)) throw new RangeError('non-finite number reached jdump');
  return String(n);
}

function emit(value, floatDp) {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return emitNumber(Number.isInteger(value) ? value : rhu(value, floatDp));
  }
  if (t === 'bigint') return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => emit(v, floatDp)).join(',')}]`;
  if (value instanceof Set) {
    const items = Array.from(value).sort(byString);
    return `[${items.map((v) => emit(v, floatDp)).join(',')}]`;
  }
  if (value instanceof Map) {
    const keys = Array.from(value.keys()).map(String).sort(cmpStr);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${emit(value.get(k), floatDp)}`).join(',')}}`;
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort(cmpStr);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${emit(value[k], floatDp)}`).join(',')}}`;
  }
  throw new TypeError(`cannot serialise ${Object.prototype.toString.call(value)} deterministically`);
}

/**
 * Serialise to compact, key-sorted, byte-stable JSON.
 *
 * Every float is quantised to `floatDp` places first (a backstop — callers
 * should already have applied the semantic precision: coordinates 6 dp, scores
 * 1 dp, shares 4 dp). Sets, Maps and Dates are converted; anything else throws
 * rather than silently stringifying.
 *
 * Emits keys in `sort()` order itself rather than trusting `JSON.stringify`,
 * because JS objects hoist integer-like keys ('1','2','12') ahead of the
 * lexicographic order Python uses ('1','12','2') and zone ids are numeric
 * strings on most feeds.
 *
 * @param {*} obj
 * @param {{floatDp?: number}} [opts]
 * @returns {string}
 */
export function jdump(obj, opts = {}) {
  const floatDp = opts.floatDp !== undefined ? opts.floatDp : 6;
  return emit(obj, floatDp);
}

// ══ HASHING ═════════════════════════════════════════════════════════════════
// crypto.subtle is async, so both of these return a Promise<string>. Every
// caller (cache keys, feed provenance) must `await`.

const HEX = '0123456789abcdef';

/**
 * Lowercase hex sha256 — used for cache keys and for feed provenance. ASYNC.
 * @param {ArrayBuffer|ArrayBufferView} data
 * @returns {Promise<string>}
 */
export async function sha256Bytes(data) {
  const buf = data instanceof ArrayBuffer ? data
    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  let out = '';
  for (let i = 0; i < digest.length; i++) {
    out += HEX[digest[i] >> 4] + HEX[digest[i] & 15];
  }
  return out;
}

/**
 * Lowercase hex sha256 of UTF-8 text. ASYNC.
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function sha256Text(text) {
  return sha256Bytes(new TextEncoder().encode(text));
}
