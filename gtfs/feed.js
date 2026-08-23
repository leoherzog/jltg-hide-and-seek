/**
 * gtfs/feed.js — GTFS feed loading and normalisation.
 *
 * Port of `generate.py` (the small `_s1_*` helpers plus all of
 * "S1 · feed loading and normalisation"). Runs **inside the Web Worker**: no DOM,
 * no `window`, no `document`.
 *
 * Python gets `zipfile` and `csv.DictReader` for free. This module does not, so it
 * carries its own minimal ZIP reader (stored + deflate only) and its own streaming
 * RFC-4180/`csv`-dialect parser. Both are below and both are dependency-free.
 *
 * ── stop_times is stored COLUMNAR ───────────────────────────────────────────────
 *
 * The largest feed this must survive is MBTA: 7,770 stops and 2.15 million
 * `stop_times` rows. Two million plain objects with eight string keys each would
 * exhaust the tab. So `stop_times` — and *only* `stop_times`; every other table is
 * thousands of rows and stays as plain objects — lives in a `StopTimes` store of
 * parallel typed arrays, one slot per row, in file order:
 *
 *     trip   Uint32Array   index into `tripIds` (string-interning table)
 *     stop   Uint32Array   index into `stopIds`
 *     seqv   Int32Array    int(stop_sequence), 0 when blank/absent
 *     arrv   Int32Array    arrival_time in seconds since service-day start,
 *                          MISSING (-2^31) when the field is blank
 *     depv   Int32Array    departure_time, same encoding
 *     distv  Float64Array  shape_dist_traveled, NaN when blank; null when the
 *                          column is absent from the file entirely
 *
 * Times are seconds since midnight **of the service day** and are never reduced
 * mod 86400: GTFS legally runs past 24:00:00 and a wrap would silently reorder a
 * night network. Storing the integer instead of the `'H:MM:SS'` text is exact —
 * `hmsToS(hhmmss(n)) === n` for every integer, negatives included.
 *
 * The interning tables are `Map<string, number>` internally. Their iteration order
 * is first-seen, which is a deterministic function of the input bytes, and nothing
 * that reaches output iterates them unsorted anyway.
 *
 * Downstream code should never touch the arrays directly. Use:
 *
 *     const st = stopTimesOf(feed);
 *     st.length                     // number of rows
 *     st.tripId(i) / st.stopId(i)   // strings
 *     st.arrival(i) / st.departure(i)  // seconds, or null when blank
 *     st.dist(i)                    // number, or null
 *     st.rowAt(i)                   // a plain GTFS row dict (allocates — not for hot loops)
 *     tripRows(feed)                // Map<trip_id, Int32Array of row indices,
 *                                   //     sorted by int(stop_sequence)>
 *
 * `feed.tables.stop_times` is still present and still behaves like an array of row
 * dicts — it is a lazy `Proxy` over the store that materialises a row object on
 * index access, so `.length`, `for…of`, `.map`, `.filter` and `[i]` all work. Two
 * consequences, both deliberate:
 *   * it is **not** structured-clone-safe (a `Proxy` never is). `CONTRACT.md` §(b)
 *     already says `Feed.tables` MAY be dropped before `postMessage`; do that.
 *   * writing to it throws. Mutate through `st.setArrival` / `st.setDeparture`.
 *   * `rowAt()` returns only the six columns the pipeline reads (`trip_id`,
 *     `arrival_time`, `departure_time`, `stop_id`, `stop_sequence` and, when the
 *     file carries it, `shape_dist_traveled`). `pickup_type`, `stop_headsign` and
 *     friends are dropped at parse time; nothing in `generate.py` reads them.
 *
 * ── determinism ────────────────────────────────────────────────────────────────
 * No clock, no randomness. Every `Map`/`Set`/object is sorted before it is iterated
 * anywhere the result can reach output. `Array.prototype.sort` is stable in every
 * target engine, which is relied on exactly where CPython's stable `list.sort` is.
 */

import { hhmmss, hmsToS, sha256Bytes } from '../lib/core.js';
import { httpFetch } from '../lib/http.js';

// ── logging ───────────────────────────────────────────────────────────────────
// `generate.py` logs through the stdlib `log`. In the worker there is no console
// worth writing to, so the sink is injectable and defaults to silence. The worker
// wires it to `postMessage({type:'log', …})`.

let LOG = { info() {}, warn() {} };

/**
 * Install the log sink used by this module. `sink.info(msg)` / `sink.warn(msg)`.
 * Passing null restores silence.
 * @param {{info:(m:string)=>void, warn:(m:string)=>void}|null} sink
 */
export function setFeedLogger(sink) {
  LOG = sink && typeof sink.info === 'function' ? sink : { info() {}, warn() {} };
}

// ── private constants ─────────────────────────────────────────────────────────

const _S1_DIR_SUFFIX = /\s*\((NB|SB|EB|WB)\)$/;
const _S1_RAIL_TYPES = [0, 1, 2, 5, 7, 11, 12];

/** Sentinel for "this time field was blank". Outside any legal GTFS time. */
const MISSING = -2147483648;

/** Code-point string order — Python's. Never `localeCompare` (locale = non-determinism). */
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ── small private helpers (generate.py) ─────────────────────────────

/**
 * Median of a *measured distribution* — headways, gaps, travel times.
 *
 * This is the ordinary median (Python's `statistics.median`: the mean of the two
 * middle values for even n), and it is deliberately **not** `lowerMedian`. The
 * contract reserves `lowerMedian` for the two places where a tie must resolve
 * *down* to the quieter option — representative-day choice and the game-size vote —
 * because there the two middle values are alternative realities and averaging them
 * would invent a day the feed does not have. A headway distribution is not like
 * that: the middle of an even sample is genuinely between the two, and the
 * lower-median variant shifts the reference feed's frequent-stop count from 186 to
 * 191 and its ≤30-minute share from 57% to 60% against the measured values.
 * @param {number[]} values
 * @returns {number}
 */
export function s1Median(values) {
  const s = Array.from(values).sort((a, b) => a - b);
  const n = s.length;
  if (!n) throw new RangeError('median of an empty sequence');
  const half = n >> 1;
  return (n % 2) ? s[half] : (s[half - 1] + s[half]) / 2;
}

/**
 * `n / d`, or 0.0 when the denominator is empty. Keeps every share finite.
 * @param {number} numerator @param {number} denominator @returns {number}
 */
export function s1Share(numerator, denominator) {
  return denominator ? (numerator / denominator) : 0.0;
}

/**
 * Strip a trailing directional suffix: 'Wealthy Street Station (NB)' → '… Station'.
 * @param {string} name @returns {string}
 */
export function s1BaseName(name) {
  return String(name || '').replace(_S1_DIR_SUFFIX, '').trim();
}

/** @param {string} source @returns {boolean} */
export function s1IsUrl(source) {
  return typeof source === 'string'
    && (source.startsWith('http://') || source.startsWith('https://'));
}

/**
 * Tolerant int(): GTFS fields are text and optional columns arrive blank.
 * @param {string|number|null|undefined} value @param {number} [def=0] @returns {number}
 */
export function s1Int(value, def = 0) {
  if (value === null || value === undefined) return def;
  const t = String(value).trim();
  if (!/^[+-]?\d+$/.test(t)) return def;
  const v = Number.parseInt(t, 10);
  return Number.isFinite(v) ? v : def;
}

const _FLOAT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Tolerant float(): returns null where Python's `float()` would raise.
 * @param {string|number|null|undefined} value @returns {number|null}
 */
export function s1Float(value) {
  if (value === null || value === undefined) return null;
  const t = String(value).trim();
  if (!t) return null;
  if (!_FLOAT_RE.test(t)) {
    if (/^[+-]?inf(inity)?$/i.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
    if (/^[+-]?nan$/i.test(t)) return NaN;
    return null;
  }
  const v = Number(t);
  return Number.isNaN(v) ? null : v;
}

/** Python's `round()` — round half to **even**, unlike core.js `rhu`. */
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return (f % 2 === 0) ? f : f + 1;
}

/** Coerce anything byte-ish to a `Uint8Array` without copying when possible. */
function toU8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('expected bytes');
}

// ══════════════════════════════════════════════════════════════════════════════
// The ZIP reader
// ══════════════════════════════════════════════════════════════════════════════
//
// Locate the End Of Central Directory record by scanning backwards, walk the
// central directory, and inflate members on demand. Exactly two compression
// methods are supported — 0 (stored) and 8 (deflate, via DecompressionStream
// 'deflate-raw'). ZIP64 is read properly rather than silently misread.

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const SIG_CDIR = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function u16(dv, o) { return dv.getUint16(o, true); }
function u32(dv, o) { return dv.getUint32(o, true); }

function u64(dv, o) {
  const lo = dv.getUint32(o, true);
  const hi = dv.getUint32(o + 4, true);
  const v = hi * 4294967296 + lo;
  if (!Number.isSafeInteger(v)) {
    throw new RangeError('ZIP64 archive is larger than this browser can address (>8 EiB field)');
  }
  return v;
}

const utf8 = new TextDecoder('utf-8');

/** Split a nested member name down to its basename: `feed/stops.txt` → `stops.txt`. */
function baseNameOf(name) {
  const i = name.lastIndexOf('/');
  return i < 0 ? name : name.slice(i + 1);
}

async function* storedStream(slice) {
  const CH = 1 << 20;
  for (let o = 0; o < slice.length; o += CH) {
    yield slice.subarray(o, Math.min(o + CH, slice.length));
  }
}

async function* inflateStream(slice) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('this browser has no DecompressionStream; cannot inflate the GTFS zip');
  }
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  // Do not await the write before reading: the stream's queue is small and the
  // reader is what drains it. Errors surface on the read side too.
  const pump = (async () => { await writer.write(slice); await writer.close(); })()
    .catch(() => { /* reported by the reader */ });
  const reader = ds.readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength) yield value;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  await pump;
}

/**
 * Read a ZIP archive's central directory and return one descriptor per member.
 *
 * Members are returned in ascending name order — `generate.py` iterates
 * `sorted(zf.namelist())` and later duplicates of a basename must win.
 *
 * @param {Uint8Array|ArrayBuffer} bytes the whole archive
 * @param {{filter?: (basename: string, name: string) => boolean}} [opts]
 *   `filter` is consulted per member; only members that pass are returned. Nothing
 *   is decompressed until you call `stream()`.
 * @returns {Promise<Array<{name:string, basename:string, method:number,
 *   compressedSize:number, size:number,
 *   stream:() => AsyncGenerator<Uint8Array>}>>}
 */
export async function unzip(bytes, opts = {}) {
  const { filter = null } = opts;
  const buf = toU8(bytes);
  if (buf.byteLength < 22) throw new Error('not a zip file (too short)');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // ── End Of Central Directory: scan backwards over the 65,535-byte comment ──
  let eocd = -1;
  const floor = Math.max(0, buf.byteLength - 22 - 65535);
  for (let i = buf.byteLength - 22; i >= floor; i--) {
    if (u32(dv, i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) {
    throw new Error('not a zip file (no End Of Central Directory record found). '
      + 'A GTFS feed must be a .zip; a bare .txt or an HTML error page will land here.');
  }

  let entries = u16(dv, eocd + 10);
  let cdSize = u32(dv, eocd + 12);
  let cdOffset = u32(dv, eocd + 16);
  const diskNo = u16(dv, eocd + 4);
  const cdDisk = u16(dv, eocd + 6);

  // ── ZIP64: >65,535 members or >4 GiB. Feeds this big exist. ───────────────
  const zip64Hint = entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff
    || diskNo === 0xffff || cdDisk === 0xffff;
  if (zip64Hint) {
    const loc = eocd - 20;
    if (loc < 0 || u32(dv, loc) !== SIG_LOC64) {
      throw new Error('zip claims ZIP64 but carries no ZIP64 EOCD locator; refusing to '
        + 'read it rather than return garbage');
    }
    const rec = u64(dv, loc + 8);
    if (rec + 56 > buf.byteLength || u32(dv, rec) !== SIG_EOCD64) {
      throw new Error('ZIP64 EOCD record is missing or out of range');
    }
    entries = u64(dv, rec + 32);
    cdSize = u64(dv, rec + 40);
    cdOffset = u64(dv, rec + 48);
  }
  if ((diskNo !== 0 && diskNo !== 0xffff) || (cdDisk !== 0 && cdDisk !== 0xffff)) {
    throw new Error('split/spanned zip archives are not supported');
  }
  if (cdOffset + cdSize > buf.byteLength) {
    throw new Error('zip central directory runs past the end of the file (truncated download?)');
  }

  const out = [];
  let p = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.byteLength || u32(dv, p) !== SIG_CDIR) {
      throw new Error(`zip central directory entry ${n} is malformed`);
    }
    const flags = u16(dv, p + 8);
    const method = u16(dv, p + 10);
    let compSize = u32(dv, p + 20);
    let size = u32(dv, p + 24);
    const nameLen = u16(dv, p + 28);
    const extraLen = u16(dv, p + 30);
    const commentLen = u16(dv, p + 32);
    let localOffset = u32(dv, p + 42);
    const name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen));

    // ZIP64 extended information extra field (0x0001), in fixed order, present
    // only for the fields whose 32-bit slot is saturated.
    if (size === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      let found = false;
      while (e + 4 <= eEnd) {
        const id = u16(dv, e);
        const len = u16(dv, e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) { size = u64(dv, q); q += 8; }
          if (compSize === 0xffffffff) { compSize = u64(dv, q); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = u64(dv, q); q += 8; }
          found = true;
          break;
        }
        e += 4 + len;
      }
      if (!found) {
        throw new Error(`zip member ${JSON.stringify(name)} needs a ZIP64 extra field and has none`);
      }
    }
    p += 46 + nameLen + extraLen + commentLen;

    const base = baseNameOf(name);
    if (name.endsWith('/')) continue;                       // directory entry
    if (filter && !filter(base, name)) continue;
    if (flags & 0x1) {
      throw new Error(`zip member ${JSON.stringify(name)} is encrypted; cannot read it`);
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`zip member ${JSON.stringify(name)} uses compression method ${method}; `
        + 'only 0 (stored) and 8 (deflate) are supported');
    }

    const entry = {
      name, basename: base, method, compressedSize: compSize, size,
      stream() { return memberStream(buf, dv, entry); },
      _localOffset: localOffset,
    };
    out.push(entry);
  }

  out.sort((a, b) => cmpStr(a.name, b.name));
  return out;
}

/** Resolve a member's data window from its local file header and stream it out. */
function memberStream(buf, dv, entry) {
  const lo = entry._localOffset;
  if (lo + 30 > buf.byteLength || u32(dv, lo) !== SIG_LOCAL) {
    throw new Error(`zip member ${JSON.stringify(entry.name)} has no local file header at ${lo}`);
  }
  // The local header's sizes are unreliable (a data descriptor leaves them zero);
  // the central directory's are authoritative.
  const nameLen = u16(dv, lo + 26);
  const extraLen = u16(dv, lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.byteLength) {
    throw new Error(`zip member ${JSON.stringify(entry.name)} runs past the end of the file`);
  }
  const slice = buf.subarray(start, end);
  return entry.method === 0 ? storedStream(slice) : inflateStream(slice);
}

// ══════════════════════════════════════════════════════════════════════════════
// The CSV parser
// ══════════════════════════════════════════════════════════════════════════════
//
// Python's `csv.DictReader` under the default dialect. `line.split(',')` corrupts
// real feeds: stop names carry commas and quotes constantly. Handled here:
//   * quoted fields, embedded commas, embedded newlines inside quotes
//   * `""` as an escaped quote
//   * CRLF, LF and lone CR line terminators
//   * a quote in the middle of an *unquoted* field is literal, and text after a
//     closing quote is appended — both are what CPython's csv module does
//   * completely empty lines are skipped (DictReader loops `while row == []`)
//   * short rows fill with '' (DictReader's restval, then `None → ''`), long rows
//     drop the surplus (DictReader's restkey, which generate.py pops)
//   * the UTF-8 BOM is stripped, or the first column would be named '﻿stop_id'
//   * field names are trimmed

class CsvParser {
  /** @param {(fields: string[]) => void} onRecord */
  constructor(onRecord) {
    this.onRecord = onRecord;
    this.pending = '';
    this.atStart = true;
  }

  /** @param {string} text a decoded chunk; chunk boundaries may fall anywhere */
  push(text) {
    if (!text) return;
    if (this.atStart) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      this.atStart = false;
    }
    this.pending += text;
    this._drain(false);
  }

  /** Flush the tail. A file that does not end in a newline still yields its last row. */
  end() {
    this._drain(true);
    this.pending = '';
  }

  _drain(final) {
    const s = this.pending;
    const n = s.length;
    let pos = 0;
    while (pos < n) {
      const next = this._record(s, pos, n, final);
      if (next < 0) break;
      pos = next;
    }
    if (pos > 0) this.pending = s.slice(pos);
  }

  /**
   * Parse one record starting at `start`. Emits it and returns the index just past
   * its terminator, or -1 when the buffer does not yet hold a complete record.
   * Uses only local state, so returning -1 is always safe to retry.
   */
  _record(s, start, n, final) {
    // A blank line is `[]` to csv.reader and is skipped by DictReader entirely.
    const c0 = s.charCodeAt(start);
    if (c0 === 10) return start + 1;
    if (c0 === 13) {
      if (start + 1 < n) return s.charCodeAt(start + 1) === 10 ? start + 2 : start + 1;
      return final ? start + 1 : -1;
    }

    const fields = [];
    let i = start;
    for (;;) {
      let value = '';

      // A quote only opens a quoted field when it is the field's first character.
      if (i < n && s.charCodeAt(i) === 34) {
        i++;
        let seg = i;
        let closed = false;
        while (i < n) {
          if (s.charCodeAt(i) === 34) {
            if (i + 1 < n && s.charCodeAt(i + 1) === 34) {   // "" → literal "
              value += s.slice(seg, i + 1);
              i += 2; seg = i;
              continue;
            }
            if (i + 1 >= n && !final) return -1;             // cannot tell yet
            value += s.slice(seg, i);
            i++; seg = i; closed = true;
            break;
          }
          i++;
        }
        if (!closed) {
          if (!final) return -1;
          value += s.slice(seg, i);                          // unterminated quote at EOF
        }
      }

      // Unquoted remainder. Also picks up any garbage after a closing quote.
      let seg = i;
      let next = -1;
      let eol = false;
      while (i < n) {
        const c = s.charCodeAt(i);
        if (c === 44) { value += s.slice(seg, i); next = i + 1; break; }
        if (c === 10) { value += s.slice(seg, i); next = i + 1; eol = true; break; }
        if (c === 13) {
          value += s.slice(seg, i);
          if (i + 1 < n) next = s.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
          else if (final) next = i + 1;
          else return -1;
          eol = true;
          break;
        }
        i++;
      }
      if (next < 0) {                                        // ran out of input
        if (!final) return -1;
        value += s.slice(seg, i);
        fields.push(value);
        this.onRecord(fields);
        return i;
      }
      fields.push(value);
      i = next;
      if (eol) { this.onRecord(fields); return i; }
    }
  }
}

function dictify(header, fields) {
  const o = {};
  for (let k = 0; k < header.length; k++) o[header[k]] = k < fields.length ? fields[k] : '';
  return o;
}

/** Stream a zip member's bytes through the CSV parser. `onRecord` sees raw fields. */
async function streamCsv(entry, onRecord) {
  const parser = new CsvParser(onRecord);
  const dec = new TextDecoder('utf-8');
  for await (const chunk of entry.stream()) parser.push(dec.decode(chunk, { stream: true }));
  const tail = dec.decode();
  if (tail) parser.push(tail);
  parser.end();
}

// ══════════════════════════════════════════════════════════════════════════════
// The columnar stop_times store
// ══════════════════════════════════════════════════════════════════════════════

class StopTimes {
  /** @param {StopTimes|null} shared reuse another store's interning tables */
  constructor(shared = null) {
    this.tripIds = shared ? shared.tripIds : [];
    this._tripKeys = shared ? shared._tripKeys : new Map();
    this.stopIds = shared ? shared.stopIds : [];
    this._stopKeys = shared ? shared._stopKeys : new Map();
    this.length = 0;
    this._cap = 0;
    this.trip = new Uint32Array(0);
    this.stop = new Uint32Array(0);
    this.seqv = new Int32Array(0);
    this.arrv = new Int32Array(0);
    this.depv = new Int32Array(0);
    this.distv = null;
    this.hasDist = shared ? shared.hasDist : false;
  }

  _reserve(want) {
    if (want <= this._cap) return;
    let cap = this._cap || 1024;
    while (cap < want) cap *= 2;
    const grow = (old, Ctor) => { const a = new Ctor(cap); a.set(old); return a; };
    this.trip = grow(this.trip, Uint32Array);
    this.stop = grow(this.stop, Uint32Array);
    this.seqv = grow(this.seqv, Int32Array);
    this.arrv = grow(this.arrv, Int32Array);
    this.depv = grow(this.depv, Int32Array);
    if (this.hasDist) {
      const a = new Float64Array(cap).fill(NaN);
      if (this.distv) a.set(this.distv);
      this.distv = a;
    }
    this._cap = cap;
  }

  enableDist() {
    if (this.hasDist) return;
    this.hasDist = true;
    const a = new Float64Array(this._cap).fill(NaN);
    this.distv = a;
  }

  internTrip(id) {
    let k = this._tripKeys.get(id);
    if (k === undefined) { k = this.tripIds.length; this.tripIds.push(id); this._tripKeys.set(id, k); }
    return k;
  }

  internStop(id) {
    let k = this._stopKeys.get(id);
    if (k === undefined) { k = this.stopIds.length; this.stopIds.push(id); this._stopKeys.set(id, k); }
    return k;
  }

  /** Append a row from already-interned keys. Times are seconds or MISSING. */
  pushRaw(tripKey, stopKey, seq, arr, dep, dist) {
    const i = this.length;
    this._reserve(i + 1);
    this.trip[i] = tripKey;
    this.stop[i] = stopKey;
    this.seqv[i] = seq;
    this.arrv[i] = arr;
    this.depv[i] = dep;
    if (this.hasDist) this.distv[i] = dist;
    this.length = i + 1;
  }

  /** Trim the over-allocated tail once loading is finished. */
  compact() {
    const n = this.length;
    if (n === this._cap) return;
    this.trip = this.trip.slice(0, n);
    this.stop = this.stop.slice(0, n);
    this.seqv = this.seqv.slice(0, n);
    this.arrv = this.arrv.slice(0, n);
    this.depv = this.depv.slice(0, n);
    if (this.hasDist) this.distv = this.distv.slice(0, n);
    this._cap = n;
  }

  tripId(i) { return this.tripIds[this.trip[i]]; }
  stopId(i) { return this.stopIds[this.stop[i]]; }
  arrival(i) { const v = this.arrv[i]; return v === MISSING ? null : v; }
  departure(i) { const v = this.depv[i]; return v === MISSING ? null : v; }
  dist(i) {
    if (!this.hasDist) return null;
    const v = this.distv[i];
    return Number.isNaN(v) ? null : v;
  }

  setArrival(i, seconds) { this.arrv[i] = seconds === null ? MISSING : seconds; }
  setDeparture(i, seconds) { this.depv[i] = seconds === null ? MISSING : seconds; }

  /** Materialise one row as a plain GTFS dict. Allocates — not for hot loops. */
  rowAt(i) {
    const a = this.arrv[i];
    const d = this.depv[i];
    const row = {
      trip_id: this.tripId(i),
      arrival_time: a === MISSING ? '' : hhmmss(a),
      departure_time: d === MISSING ? '' : hhmmss(d),
      stop_id: this.stopId(i),
      stop_sequence: String(this.seqv[i]),
    };
    if (this.hasDist) {
      const v = this.distv[i];
      row.shape_dist_traveled = Number.isNaN(v) ? '' : String(v);
    }
    return row;
  }
}

/**
 * A lazy array-like view over the store, installed as `feed.tables.stop_times`.
 * The target is a real Array so `Array.isArray`, `for…of`, `.map`, `.filter` and
 * the spread operator all work through the generic index/length protocol.
 */
function stopTimesTableView(st) {
  const idx = (prop) => {
    if (typeof prop !== 'string') return -1;
    const i = +prop;
    return Number.isInteger(i) && i >= 0 && String(i) === prop ? i : -1;
  };
  return new Proxy([], {
    get(target, prop, recv) {
      if (prop === 'length') return st.length;
      const i = idx(prop);
      if (i >= 0) return i < st.length ? st.rowAt(i) : undefined;
      return Reflect.get(target, prop, recv);
    },
    has(target, prop) {
      const i = idx(prop);
      if (i >= 0) return i < st.length;
      return Reflect.has(target, prop);
    },
    set(target, prop, value, recv) {
      if (idx(prop) >= 0) {
        throw new TypeError('feed.tables.stop_times is a read-only view; '
          + 'mutate through stopTimesOf(feed).setArrival / .setDeparture');
      }
      return Reflect.set(target, prop, value, recv);
    },
  });
}

/**
 * The columnar `stop_times` store for a feed.
 * @param {Object} feed @returns {StopTimes}
 */
export function stopTimesOf(feed) {
  return feed._s1StopTimes;
}

function attachStopTimes(feed, st) {
  Object.defineProperty(feed, '_s1StopTimes', {
    value: st, writable: true, enumerable: false, configurable: true,
  });
  feed.tables.stop_times = stopTimesTableView(st);
}

// ══════════════════════════════════════════════════════════════════════════════
// S1 · feed loading and normalisation
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Return `[zipBytes, sha256]` for a URL or a picked `File`/`Blob`/byte buffer.
 *
 * The CLI's third case — a directory, repacked in sorted name order so its hash is
 * stable — has no browser analogue and is dropped. A bare path string that is not a
 * URL is an error here: the worker has no filesystem.
 *
 * @param {string|File|Blob|ArrayBuffer|Uint8Array} source
 * @param {Object} cache
 * @returns {Promise<[Uint8Array, string]>}
 */
async function _s1ReadSource(source, cache) {
  if (typeof source === 'string') {
    if (!s1IsUrl(source)) {
      throw new Error(`GTFS source ${JSON.stringify(source)} is not an http(s) URL. `
        + 'The browser port cannot read local paths — pick the .zip from disk instead.');
    }
    const body = toU8(await httpFetch(cache, {
      kind: 'gtfs', cacheKey: source, ext: 'zip', endpoints: [source],
    }));
    return [body, await sha256Bytes(body)];
  }
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    const body = new Uint8Array(await source.arrayBuffer());
    return [body, await sha256Bytes(body)];
  }
  const body = toU8(source);
  return [body, await sha256Bytes(body)];
}

/**
 * Every `*.txt` in the archive as a list of row dicts — except `stop_times`, which
 * goes into the columnar store and is exposed through a lazy view.
 *
 * The UTF-8 BOM is stripped (it would otherwise rename the first column to
 * `'﻿stop_id'`); quoted fields containing CRLF stay intact; the basename is
 * matched so a feed zipped with a top-level directory still works.
 *
 * @param {Uint8Array} body
 * @param {{onProgress?: (info:{table:string, done:number, total:number}) => void}} [opts]
 * @returns {Promise<{tables: Object, stopTimes: StopTimes}>}
 */
async function _s1ParseTables(body, opts = {}) {
  const { onProgress = null } = opts;
  const entries = await unzip(body, {
    filter: (base, name) => base.endsWith('.txt') && !base.startsWith('.') && !name.includes('__MACOSX'),
  });

  const tables = {};
  let stopTimes = new StopTimes();
  for (let e = 0; e < entries.length; e++) {
    const entry = entries[e];
    const key = entry.basename.slice(0, -4);
    if (onProgress) onProgress({ table: key, done: e, total: entries.length });
    if (key === 'stop_times') {
      stopTimes = await readStopTimes(entry);
      tables[key] = null;                                   // placeholder; view installed later
    } else {
      tables[key] = await readTable(entry);
    }
  }
  if (onProgress) onProgress({ table: '', done: entries.length, total: entries.length });
  return { tables, stopTimes };
}

async function readTable(entry) {
  const rows = [];
  let header = null;
  await streamCsv(entry, (fields) => {
    if (header === null) { header = fields.map((f) => f.trim()); return; }
    rows.push(dictify(header, fields));
  });
  return rows;
}

async function readStopTimes(entry) {
  const st = new StopTimes();
  let header = null;
  let iTrip = -1; let iArr = -1; let iDep = -1; let iStop = -1; let iSeq = -1; let iDist = -1;
  await streamCsv(entry, (fields) => {
    if (header === null) {
      header = fields.map((f) => f.trim());
      iTrip = header.indexOf('trip_id');
      iArr = header.indexOf('arrival_time');
      iDep = header.indexOf('departure_time');
      iStop = header.indexOf('stop_id');
      iSeq = header.indexOf('stop_sequence');
      iDist = header.indexOf('shape_dist_traveled');
      if (iDist >= 0) st.enableDist();
      return;
    }
    const cell = (k) => (k >= 0 && k < fields.length ? fields[k] : '');
    const arr = hmsToS(cell(iArr));
    const dep = hmsToS(cell(iDep));
    let dist = NaN;
    if (iDist >= 0) {
      const d = s1Float(cell(iDist));
      if (d !== null) dist = d;
    }
    st.pushRaw(
      st.internTrip(cell(iTrip)),
      st.internStop(cell(iStop)),
      s1Int(cell(iSeq)),
      arr === null ? MISSING : arr,
      dep === null ? MISSING : dep,
      dist,
    );
  });
  st.compact();
  return st;
}

const DATE8 = /^\d{8}$/;

/**
 * `[feedStart, feedEnd]` from feed_info, else calendar, else calendar_dates.
 * @param {Object} tables @returns {[string, string]}
 */
function _s1WindowDates(tables) {
  const info = tables.feed_info || [];
  if (info.length) {
    const start = String(info[0].feed_start_date || '').trim();
    const end = String(info[0].feed_end_date || '').trim();
    if (DATE8.test(start) && DATE8.test(end) && start <= end) return [start, end];
  }

  const cal = tables.calendar || [];
  const starts = [];
  const ends = [];
  for (const r of cal) {
    const s = String(r.start_date || '').trim();
    if (DATE8.test(s)) starts.push(s);
    const e = String(r.end_date || '').trim();
    if (DATE8.test(e)) ends.push(e);
  }
  if (starts.length && ends.length) {
    return [starts.slice().sort(cmpStr)[0], ends.slice().sort(cmpStr)[ends.length - 1]];
  }

  const seen = new Set();
  for (const r of (tables.calendar_dates || [])) {
    const d = String(r.date || '').trim();
    if (DATE8.test(d)) seen.add(d);
  }
  const dates = Array.from(seen).sort(cmpStr);
  if (dates.length) return [dates[0], dates[dates.length - 1]];
  throw new Error('feed has no feed_info, calendar or calendar_dates dates to derive a window from');
}

/**
 * Fetch (or open) a GTFS zip and parse every `*.txt` into a `Feed`.
 *
 * Returns a fully normalised `Feed`: `tables` holds the raw rows, `stops`/`routes`
 * the typed views, and `sha256` the hash of the zip bytes (which goes on the page as
 * provenance). Reads as UTF-8 with the BOM stripped, tolerates files nested in a
 * top-level directory, and treats every optional column as optional. Downloads go
 * through the shared cache under `gtfs/<sha256(url)>.zip`.
 *
 * @param {string|File|Blob|ArrayBuffer|Uint8Array} source a GTFS URL or a picked file
 * @param {Object} cache the worker's `Cache`
 * @param {{onProgress?: (info:{table:string, done:number, total:number}) => void}} [opts]
 *        called once per `*.txt` before it is parsed, and once more when the last
 *        one is done — `done`/`total` count tables, not bytes.
 * @returns {Promise<Object>} a `Feed` (CONTRACT.md §(b))
 */
export async function loadFeed(source, cache, opts = {}) {
  const label = typeof source === 'string'
    ? source
    : (source && typeof source.name === 'string' ? source.name : 'uploaded.zip');

  const [body, digest] = await _s1ReadSource(source, cache);
  const { tables, stopTimes } = await _s1ParseTables(body, opts);

  const count = (name) => {
    const t = tables[name];
    if (name === 'stop_times') return stopTimes.length;
    return t ? t.length : 0;
  };
  for (const required of ['stops', 'routes', 'trips', 'stop_times']) {
    if (!count(required)) {
      throw new Error(`GTFS feed ${JSON.stringify(label)} has no usable ${required}.txt`);
    }
  }

  const stops = {};
  let stopCount = 0;
  for (const row of tables.stops) {
    const sid = String(row.stop_id || '').trim();
    const loc = String(row.location_type || '0').trim() || '0';
    // 1=station, 2/3/4=entrance/node/area.
    if (!sid || loc !== '0') continue;
    const lat = s1Float(row.stop_lat);
    const lon = s1Float(row.stop_lon);
    if (lat === null || lon === null) continue;
    const name = String(row.stop_name || sid).trim();
    if (!(sid in stops)) stopCount++;                       // a repeated stop_id overwrites
    stops[sid] = {
      stopId: sid,
      name,
      baseName: s1BaseName(name) || name,
      lat,
      lon,
      parentStation: String(row.parent_station || '').trim(),
    };
  }
  if (!stopCount) {
    throw new Error(`GTFS feed ${JSON.stringify(label)} contains no boarding-capable stops`);
  }

  const routes = {};
  let routeCount = 0;
  for (const row of tables.routes) {
    const rid = String(row.route_id || '').trim();
    if (!rid) continue;
    const shortName = String(row.route_short_name || '').trim();
    const longName = String(row.route_long_name || '').trim();
    const routeType = s1Int(row.route_type, 3);
    if (!(rid in routes)) routeCount++;
    routes[rid] = {
      routeId: rid,
      shortName,
      longName,
      routeType,
      color: String(row.route_color || '').trim(),
      // Python exposes these as properties; materialised here so a Route stays
      // clone-safe (CONTRACT.md §(b)).
      label: shortName || longName || rid,
      isRail: _S1_RAIL_TYPES.includes(routeType),
    };
  }

  const agencies = (tables.agency && tables.agency.length) ? tables.agency : [{}];
  const tzSet = new Set();
  for (const a of agencies) {
    const tz = String(a.agency_timezone || '').trim();
    if (tz) tzSet.add(tz);
  }
  const tzs = Array.from(tzSet).sort(cmpStr);
  if (tzs.length > 1) {
    LOG.warn(`feed declares ${tzs.length} agency timezones (${tzs.join(', ')}); `
      + 'using the primary agency\'s');
  }

  // A multi-agency feed is not "the first row in agency.txt". MBTA's feed lists Cape
  // Cod RTA first and MBTA second, which named a Boston-wide map after a bus operator
  // 100 km away. Pick the agency that actually runs the most trips; ties break on
  // agency_id so the choice is deterministic. Single-agency feeds are unaffected.
  let primary = agencies[0];
  if (agencies.length > 1) {
    const routeAgency = new Map();
    for (const r of tables.routes) {
      routeAgency.set(String(r.route_id || '').trim(), String(r.agency_id || '').trim());
    }
    const tripsPerAgency = new Map();
    for (const row of tables.trips) {
      const key = routeAgency.get(String(row.route_id || '').trim()) ?? '';
      tripsPerAgency.set(key, (tripsPerAgency.get(key) || 0) + 1);
    }
    const trips = (a) => tripsPerAgency.get(String(a.agency_id || '').trim()) || 0;
    const aid = (a) => String(a.agency_id || '').trim();
    const ranked = agencies.slice().sort((x, y) => (trips(y) - trips(x)) || cmpStr(aid(x), aid(y)));
    primary = ranked[0];
    LOG.info(`multi-agency feed: ${agencies.length} agencies, using `
      + `${JSON.stringify(String(primary.agency_name || '').trim())} `
      + `(${trips(primary)} of ${tables.trips.length} trips)`);
  }
  const timezone = String(primary.agency_timezone || 'UTC').trim();

  const [start, end] = _s1WindowDates(tables);
  const info = (tables.feed_info && tables.feed_info.length) ? tables.feed_info[0] : {};

  const feed = {
    source: label,
    sha256: digest,
    tables,
    stops,
    routes,
    agencyName: String(primary.agency_name || '').trim() || 'this transit agency',
    agencyUrl: String(primary.agency_url || '').trim(),
    timezone,
    feedStart: start,
    feedEnd: end,
    feedVersion: String(info.feed_version || '').trim(),
    publisher: String(info.feed_publisher_name || '').trim(),
  };
  attachStopTimes(feed, stopTimes);

  LOG.info(`feed ${feed.agencyName}: ${stopCount} stops, ${routeCount} routes, `
    + `${tables.trips.length} trips, ${stopTimes.length} stop_times, window ${start}–${end}`);
  return feed;
}

// ── per-feed derived caches (attached to the Feed object, never serialised) ────

/**
 * Memoise a derived structure on the Feed. Pure, so this cannot affect output.
 *
 * The store is a non-enumerable own property, which keeps it out of
 * `structuredClone` and out of `JSON.stringify`.
 * @param {Object} feed @param {string} key @param {() => any} build @returns {any}
 */
export function s1Cache(feed, key, build) {
  let store = feed._s1Derived;
  if (store === undefined) {
    store = new Map();
    Object.defineProperty(feed, '_s1Derived', {
      value: store, writable: true, enumerable: false, configurable: true,
    });
  }
  if (!store.has(key)) store.set(key, build());
  return store.get(key);
}

/** Drop every derived structure. @param {Object} feed */
export function s1Invalidate(feed) {
  Object.defineProperty(feed, '_s1Derived', {
    value: new Map(), writable: true, enumerable: false, configurable: true,
  });
}

/**
 * `trip_id → row indices into the columnar store, sorted by int(stop_sequence)`.
 *
 * `stop_sequence` is non-contiguous in **every** trip of the reference feed and
 * starts at 0, so it is a sort key and never an index.
 *
 * @param {Object} feed @returns {Map<string, Int32Array>}
 */
export function tripRows(feed) {
  return s1Cache(feed, 'trip_rows', () => {
    const st = stopTimesOf(feed);
    const n = st.length;

    // Bucket by interned trip key first (integer keys, no string hashing), then
    // materialise one Int32Array per trip.
    const counts = new Int32Array(st.tripIds.length);
    for (let i = 0; i < n; i++) counts[st.trip[i]]++;
    const buckets = new Array(st.tripIds.length);
    for (let k = 0; k < counts.length; k++) buckets[k] = counts[k] ? new Int32Array(counts[k]) : null;
    const fill = new Int32Array(st.tripIds.length);
    for (let i = 0; i < n; i++) {
      const k = st.trip[i];
      buckets[k][fill[k]++] = i;
    }

    const out = new Map();
    for (let k = 0; k < buckets.length; k++) {
      const b = buckets[k];
      if (!b) continue;
      // Stable sort on stop_sequence, matching CPython's `list.sort(key=…)`.
      const sorted = Array.prototype.slice.call(b).sort((x, y) => st.seqv[x] - st.seqv[y]);
      out.set(st.tripIds[k], Int32Array.from(sorted));
    }
    return out;
  });
}

/**
 * In-place: fill blank `arrival_time`/`departure_time` by linear interpolation,
 * expand `frequencies.txt` into concrete trips (dropping the template trips'
 * original `stop_times`), and validate that every trip's times are non-decreasing.
 *
 * Mutates the columnar store and `feed.tables.trips`. Idempotent.
 * @param {Object} feed
 */
export function normaliseTimes(feed) {
  if (feed._s1Normalised) return;

  _s1ExpandFrequencies(feed);
  _s1FillBlankTimes(feed);
  _s1CheckMonotone(feed);

  Object.defineProperty(feed, '_s1Normalised', {
    value: true, writable: true, enumerable: false, configurable: true,
  });
  s1Invalidate(feed);
}

/**
 * Turn every `frequencies.txt` row into concrete trips.
 *
 * The template trip's own `stop_times` rows are **dropped**, not kept alongside —
 * keeping them would double-count the first headway slot. `exact_times` makes no
 * difference to an earliest-arrival model: expanding at the stated headway is the
 * correct conservative reading of both 0 and 1.
 *
 * Note the surprise carried over from the CLI: a template whose frequency row is
 * unusable (no headway, inverted window) still has its original stop_times dropped
 * and gets no replacements — `dropped` is built from every template id, before the
 * per-row validity test.
 */
function _s1ExpandFrequencies(feed) {
  const freq = (feed.tables.frequencies || []).filter((r) => String(r.trip_id || '').trim());
  if (!freq.length) return;

  const byTrip = tripRows(feed);
  const st = stopTimesOf(feed);
  const tripsById = new Map();
  for (const t of feed.tables.trips) tripsById.set(String(t.trip_id || ''), t);

  const templateSet = new Set();
  for (const r of freq) templateSet.add(String(r.trip_id || '').trim());
  const templates = Array.from(templateSet).sort(cmpStr);

  const ordered = freq.slice().sort((a, b) => cmpStr(String(a.trip_id || ''), String(b.trip_id || ''))
    || cmpStr(String(a.start_time || ''), String(b.start_time || '')));

  const newTrips = [];
  /** @type {Array<[number, Int32Array, number, number]>} newId key, source rows, dep0, anchor */
  const plan = [];
  const out = new StopTimes(st);                            // shares the interning tables

  for (const row of ordered) {
    const tid = String(row.trip_id || '').trim();
    const rows = byTrip.get(tid);
    const template = tripsById.get(tid);
    if (!rows || !rows.length || template === undefined) continue;
    const t0 = hmsToS(row.start_time);
    const t1 = hmsToS(row.end_time);
    const headway = s1Int(row.headway_secs, 0);
    if (t0 === null || t1 === null || headway <= 0 || t1 <= t0) continue;
    // `or` chain, exactly as the CLI: a departure of literally 0 falls through.
    const anchor = st.departure(rows[0]) || st.arrival(rows[0]) || 0;
    let k = 0;
    for (let dep0 = t0; dep0 < t1; dep0 += headway, k++) {
      const newId = `${tid}#${String(k).padStart(4, '0')}`;
      const clone = { ...template };
      clone.trip_id = newId;
      newTrips.push(clone);
      plan.push([out.internTrip(newId), rows, dep0, anchor]);
    }
  }

  // Rebuild the store: surviving rows in file order, then the expansions — the same
  // ordering the CLI's list concatenation produces.
  for (let i = 0; i < st.length; i++) {
    if (templateSet.has(st.tripId(i))) continue;
    out.pushRaw(st.trip[i], st.stop[i], st.seqv[i], st.arrv[i], st.depv[i],
      st.hasDist ? st.distv[i] : NaN);
  }
  for (const [tripKey, rows, dep0, anchor] of plan) {
    for (let j = 0; j < rows.length; j++) {
      const src = rows[j];
      const a = st.arrv[src];
      const d = st.depv[src];
      out.pushRaw(
        tripKey, st.stop[src], st.seqv[src],
        a === MISSING ? MISSING : dep0 + a - anchor,
        d === MISSING ? MISSING : dep0 + d - anchor,
        st.hasDist ? st.distv[src] : NaN,
      );
    }
  }
  out.compact();

  feed.tables.trips = feed.tables.trips
    .filter((t) => !templateSet.has(String(t.trip_id || '')))
    .concat(newTrips);
  attachStopTimes(feed, out);
  s1Invalidate(feed);
  LOG.info(`frequencies.txt: expanded ${templates.length} template trips into `
    + `${newTrips.length} concrete trips`);
}

/**
 * Linear interpolation of blank times between the surrounding timepoints.
 *
 * Interpolates by `shape_dist_traveled` when every row of the run carries it, and by
 * post-sort position otherwise. Rows outside the first/last timepoint of a trip
 * (which is malformed GTFS) are filled by copying the nearest known time.
 */
function _s1FillBlankTimes(feed) {
  const st = stopTimesOf(feed);
  const byTrip = tripRows(feed);
  let filled = 0;

  for (const tid of Array.from(byTrip.keys()).sort(cmpStr)) {
    const rows = byTrip.get(tid);
    const n = rows.length;
    // `departure or arrival` — a departure of exactly 0 is falsy in Python too and
    // falls through to the arrival. The quirk is load-bearing; keep it.
    const times = new Array(n);
    let anyBlank = false;
    for (let i = 0; i < n; i++) {
      const t = st.departure(rows[i]) || st.arrival(rows[i]);
      times[i] = t;
      if (t === null) anyBlank = true;
    }
    if (!anyBlank) continue;

    const known = [];
    for (let i = 0; i < n; i++) if (times[i] !== null) known.push(i);
    if (!known.length) continue;

    const dists = new Array(n);
    let allDist = true;
    for (let i = 0; i < n; i++) {
      const d = st.dist(rows[i]);
      dists[i] = d;
      if (d === null) allDist = false;
    }
    const useDist = allDist && dists[n - 1] !== dists[0];
    const axis = new Array(n);
    for (let i = 0; i < n; i++) axis[i] = useDist ? dists[i] : i;

    for (let i = 0; i < n; i++) {
      if (times[i] !== null) continue;
      let a = -1;
      let b = -1;
      for (const k of known) { if (k < i) a = k; else if (b < 0) { b = k; break; } }
      let value;
      if (a >= 0 && b >= 0) {
        const span = axis[b] - axis[a];
        const frac = span ? ((axis[i] - axis[a]) / span) : 0.5;
        value = pyRound(times[a] + frac * (times[b] - times[a]));
      } else {
        value = a >= 0 ? times[a] : times[known[0]];
      }
      times[i] = value;
      filled++;
    }

    for (let i = 0; i < n; i++) {
      const r = rows[i];
      if (st.arrv[r] === MISSING) st.setArrival(r, times[i]);
      if (st.depv[r] === MISSING) st.setDeparture(r, times[i]);
    }
  }
  if (filled) LOG.info(`interpolated ${filled} blank stop_times values`);
}

/** Warn (never crash) when a trip's times go backwards. Real feeds do this. */
function _s1CheckMonotone(feed) {
  const st = stopTimesOf(feed);
  const byTrip = tripRows(feed);
  let bad = 0;
  for (const tid of Array.from(byTrip.keys()).sort(cmpStr)) {
    const rows = byTrip.get(tid);
    let prev = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const arr = st.arrival(r);
      const dep = st.departure(r);
      for (const value of [arr, dep]) {
        if (value === null) continue;
        if (prev !== null && value < prev) bad++;
        prev = prev !== null ? Math.max(prev, value) : value;
      }
    }
  }
  if (bad) {
    LOG.warn(`${bad} non-monotone stop_times values; the travel-time model clamps them`);
  }
}

/**
 * Resolve the feed's validity window and the analysis date.
 *
 * Returns `[start, end, asOf]` as GTFS date strings. Priority for the window:
 * `feed_info` dates, else min/max over `calendar`, else min/max over
 * `calendar_dates`. `asOf` defaults to `start` and is clamped into the window.
 * **Never reads the clock** — that is the whole reason this function exists.
 *
 * @param {Object} feed @param {string|null} asOf @returns {[string, string, string]}
 */
export function feedWindow(feed, asOf) {
  const start = feed.feedStart;
  const end = feed.feedEnd;
  let chosen = String(asOf || '').trim() || start;
  if (!DATE8.test(chosen)) {
    throw new Error(`--as-of must be YYYYMMDD, got ${JSON.stringify(asOf)}`);
  }
  if (chosen < start) {
    LOG.warn(`as-of ${chosen} is before the feed window; clamped to ${start}`);
    chosen = start;
  } else if (chosen > end) {
    LOG.warn(`as-of ${chosen} is after the feed window; clamped to ${end}`);
    chosen = end;
  }
  return [start, end, chosen];
}
