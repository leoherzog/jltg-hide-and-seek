/**
 * osm/flatgeobuf.js — the FlatGeobuf-over-HTTP-Range transport layer.
 *
 * Pure transport: it knows the byte layout of a FlatGeobuf and nothing about parks.
 * `./worldfile.js` turns features into `Poi` records.
 *
 * WORKER SIDE ONLY — no DOM.
 *
 * Hand-written rather than the `flatgeobuf` npm package: import maps do not apply to
 * workers, and a CDN URL would reintroduce a run-time third-party dependency.
 *
 * The format, in the order the bytes appear:
 *
 *   magic          8 bytes    'f','g','b', 3, 'f','g','b', patch
 *   headerLength   uint32     little-endian, as is everything below
 *   header         flatbuffer  name, envelope, geometry type, columns, feature count,
 *                              and index_node_size — the R-tree branching factor
 *   index          optional   packed Hilbert R-tree, 40 bytes per node
 *   features       repeated   uint32 byte length, then a Feature flatbuffer
 *
 * The packed R-tree is a flat array in level order, so children sit at computable
 * offsets and `search` can walk it with Range requests, reading only the levels it
 * needs. A file WITHOUT the index (`index_node_size` = 0) reads correctly by downloading
 * all of it, silently, which is why `search` throws instead.
 */

// ── format constants ─────────────────────────────────────────────────────────

const MAGIC = Object.freeze([0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62]);
const MAGIC_LEN = 8;
const HEADER_PREFIX = MAGIC_LEN + 4;   // magic + the uint32 header length
const NODE_ITEM_LEN = 40;              // 4 doubles of bbox + one uint64 offset

/** How much to read on the first request. Big enough for essentially every header. */
const HEADER_PROBE_BYTES = 16384;

/** Seconds before one Range request is abandoned; same abort pattern as `lib/http.js`. */
export const RANGE_TIMEOUT_S = 30;

/** Two ranges closer together than this are fetched as one. */
const RANGE_COALESCE_BYTES = 8192;

/** Never ask for a single range larger than this. */
const MAX_RANGE_BYTES = 8 << 20;

/**
 * How many index reads one level of the R-tree walk offers the gate at once. A
 * batch-shaping number, not a ceiling; `MAX_CONCURRENT_RANGES` is the ceiling.
 */
const INDEX_READ_CONCURRENCY = 12;

/**
 * How many coalesced feature runs `query` reads at once. Smaller than the index number
 * for memory: a run is up to `MAX_RANGE_BYTES` and the batch is resident until decoded.
 */
const FEATURE_READ_CONCURRENCY = 8;

/**
 * Range requests in flight at once across EVERY reader. Every request funnels through
 * `RangeReader._readOne`, so this bounds the whole OSM layer no matter how much
 * concurrency callers stack above it. Set for the browser, not the origin: 32 sits
 * inside the HTTP/2 stream budget with room for the page's own traffic, and under
 * HTTP/1.1 the browser's 6-per-host limit becomes the real ceiling.
 */
const MAX_CONCURRENT_RANGES = 32;

/**
 * The gate: a counting semaphore with a FIFO queue, shared by every reader because the
 * connection pool is. FIFO matters: the R-tree walk reads a level before the next, so a
 * LIFO gate under a full queue could starve one layer while others keep arriving.
 */
let rangeSlotsInUse = 0;
/** @type {Array<() => void>} Resolvers of the reads waiting for a slot, oldest first. */
const rangeSlotQueue = [];

/**
 * Take a slot. Returns null when one was free so the uncontended path skips the await.
 * @returns {Promise<void>|null}
 */
function acquireRangeSlot() {
  if (rangeSlotsInUse < MAX_CONCURRENT_RANGES) {
    rangeSlotsInUse += 1;
    return null;
  }
  return new Promise((resolve) => { rangeSlotQueue.push(resolve); });
}

/**
 * Give a slot back: straight to the longest waiter if there is one, else to the pool.
 * Handing it over directly is what keeps the queue FIFO.
 */
function releaseRangeSlot() {
  const next = rangeSlotQueue.shift();
  if (next) next();
  else rangeSlotsInUse -= 1;
}

/** Cap the resident chunk cache by BYTES, not entries: an index walk touches a couple
 *  of hundred small blocks, and an entry cap evicted its head before its tail was read. */
const CHUNK_CACHE_BYTES = 4 << 20;

/** ColumnType, from the FlatGeobuf schema. Order is the wire order — do not sort. */
const COLUMN_TYPE = Object.freeze({
  BYTE: 0, UBYTE: 1, BOOL: 2, SHORT: 3, USHORT: 4, INT: 5, UINT: 6,
  LONG: 7, ULONG: 8, FLOAT: 9, DOUBLE: 10, STRING: 11, JSON: 12,
  DATETIME: 13, BINARY: 14,
});

/** GeometryType, from the FlatGeobuf schema. */
export const GEOMETRY_TYPE = Object.freeze({
  UNKNOWN: 0, POINT: 1, LINESTRING: 2, POLYGON: 3, MULTIPOINT: 4,
  MULTILINESTRING: 5, MULTIPOLYGON: 6, GEOMETRYCOLLECTION: 7,
});

// ═══════════════════════════════════════════════════════════════════════════════
// A minimal FlatBuffers table reader (read half only)
// ═══════════════════════════════════════════════════════════════════════════════
//
// A table stores a signed 32-bit offset BACKWARDS to its vtable, which lists per field
// the byte offset within the table (zero when absent, which is how defaults work).
// Nothing is copied: every accessor is an offset computation against one DataView.

class Table {
  /**
   * @param {DataView} view
   * @param {number} pos byte offset of the table within `view`
   */
  constructor(view, pos) {
    this.view = view;
    this.pos = pos;
    // The vtable lives at a NEGATIVE offset; the one signed offset in the format.
    this.vtable = pos - view.getInt32(pos, true);
    this.vtableSize = view.getUint16(this.vtable, true);
  }

  /** Byte position of field `i`, or 0 when the field is absent (use the default). */
  field(i) {
    const offsetPos = this.vtable + 4 + i * 2;
    if (offsetPos >= this.vtable + this.vtableSize) return 0;
    const offset = this.view.getUint16(offsetPos, true);
    return offset === 0 ? 0 : this.pos + offset;
  }

  u8(i, fallback = 0) { const p = this.field(i); return p === 0 ? fallback : this.view.getUint8(p); }

  u16(i, fallback = 0) { const p = this.field(i); return p === 0 ? fallback : this.view.getUint16(p, true); }

  i32(i, fallback = 0) { const p = this.field(i); return p === 0 ? fallback : this.view.getInt32(p, true); }

  /** uint64 → Number. File offsets and feature counts stay far below 2^53. */
  u64(i, fallback = 0) {
    const p = this.field(i);
    return p === 0 ? fallback : Number(this.view.getBigUint64(p, true));
  }

  /** Follow an indirect (uint32, relative) offset to a table, string or vector. */
  indirect(pos) { return pos + this.view.getUint32(pos, true); }

  /** A nested table, or null when absent. */
  table(i) {
    const p = this.field(i);
    return p === 0 ? null : new Table(this.view, this.indirect(p));
  }

  string(i) {
    const p = this.field(i);
    if (p === 0) return null;
    const start = this.indirect(p);
    const length = this.view.getUint32(start, true);
    return utf8(this.view, start + 4, length);
  }

  /** `[startOfElements, elementCount]`, or `[0, 0]` when the vector is absent. */
  vector(i) {
    const p = this.field(i);
    if (p === 0) return [0, 0];
    const start = this.indirect(p);
    return [start + 4, this.view.getUint32(start, true)];
  }

  vectorF64(i) {
    const [start, length] = this.vector(i);
    const out = new Float64Array(length);
    for (let k = 0; k < length; k++) out[k] = this.view.getFloat64(start + k * 8, true);
    return out;
  }

  vectorU32(i) {
    const [start, length] = this.vector(i);
    const out = new Uint32Array(length);
    for (let k = 0; k < length; k++) out[k] = this.view.getUint32(start + k * 4, true);
    return out;
  }

  /** Element `k` of a vector of tables. */
  vectorTable(i, k) {
    const [start] = this.vector(i);
    return new Table(this.view, this.indirect(start + k * 4));
  }
}

const DECODER = new TextDecoder('utf-8');

function utf8(view, start, length) {
  return DECODER.decode(new Uint8Array(view.buffer, view.byteOffset + start, length));
}

/** A FlatBuffers root table: the buffer opens with a uint32 offset to it. */
function root(view, base = 0) {
  return new Table(view, base + view.getUint32(base, true));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Byte source — coalesced HTTP Range requests with a small resident cache
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reads byte ranges out of one remote file.
 *
 * The browser HTTP cache does the durable caching (the files are immutable); this only
 * avoids re-requesting ranges within a run. A server that ignores `Range` and answers
 * 200 would silently turn every query into a full download, so a non-206 is an error.
 */
class RangeReader {
  /**
   * @param {string} url
   * @param {{fetchImpl?: typeof fetch}} [opts]
   */
  constructor(url, opts = {}) {
    this.url = url;
    this._fetch = opts.fetchImpl || ((...args) => fetch(...args));
    /** @type {Array<{start: number, end: number, bytes: Uint8Array}>} */
    this._chunks = [];
    this._cachedBytes = 0;
    // In-flight reads keyed by byte span, so concurrent asks for one span share a
    // request; the chunk cache only holds COMPLETED reads. See `_readOne`.
    /** @type {Map<string, Promise<Uint8Array>>} */
    this._pending = new Map();
    this.bytesFetched = 0;
    this.requests = 0;
    // Learned from the first 206's `Content-Range`. Until then reads are unclamped.
    /** @type {number|null} */
    this.size = null;
  }

  /** A cached chunk wholly containing `[start, end)`, or null. */
  _cached(start, end) {
    for (const chunk of this._chunks) {
      if (chunk.start <= start && chunk.end >= end) {
        return chunk.bytes.subarray(start - chunk.start, end - chunk.start);
      }
    }
    return null;
  }

  /**
   * `[start, end)` as bytes, from cache or one Range request.
   * @returns {Promise<Uint8Array>}
   */
  async read(start, end) {
    // Callers deliberately overshoot the tail (a feature's length is unknown until its
    // size prefix is read); clamping keeps that from becoming an unsatisfiable range.
    if (this.size !== null) end = Math.min(end, this.size);
    if (end <= start) return new Uint8Array(0);
    if (end - start <= MAX_RANGE_BYTES) return this._readOne(start, end);

    // An oversize span is DATA, not a bug: OSM holds single features tens of megabytes
    // wide (Lake Nasser is 21 MB). Split the read; the ceiling bounds one request only.
    const parts = [];
    let total = 0;
    for (let at = start; at < end; at += MAX_RANGE_BYTES) {
      const want = Math.min(MAX_RANGE_BYTES, end - at);
      const part = await this._readOne(at, at + want);
      parts.push(part);
      total += part.length;
      if (part.length < want) break;   // a short tail read is normal; stop, do not spin
    }
    const joined = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { joined.set(part, at); at += part.length; }
    return joined;
  }

  /**
   * One Range request, at most `MAX_RANGE_BYTES` wide; the throw is an assertion that
   * `read` split correctly. This is the chokepoint every byte passes through, so the
   * two GLOBAL guarantees live here: the fetch gate (in `_fetchRange`) and in-flight
   * dedup. Awaiters share the returned view; every caller treats it as read-only.
   * @returns {Promise<Uint8Array>}
   */
  async _readOne(start, end) {
    if (this.size !== null) end = Math.min(end, this.size);
    if (end <= start) return new Uint8Array(0);
    if (end - start > MAX_RANGE_BYTES) {
      throw new Error(`FlatGeobuf: refusing a ${end - start} byte range from ${this.url}`);
    }
    const hit = this._cached(start, end);
    if (hit) return hit;

    const key = `${start}-${end}`;
    const already = this._pending.get(key);
    if (already) return already;

    const pending = this._fetchRange(start, end);
    this._pending.set(key, pending);
    // Forget on failure too, so a span that threw is retryable. Two handlers rather
    // than `finally` so the rejection is not reported as unhandled here; the caller
    // awaits `pending` and still gets the error.
    const forget = () => {
      if (this._pending.get(key) === pending) this._pending.delete(key);
    };
    pending.then(forget, forget);
    return pending;
  }

  /**
   * Acquire a slot, make one request, release the slot. The gate is held across the
   * body read too (a body still arriving still occupies a connection), and the
   * `finally` matters: a slot leaked on an error path would deadlock every later read.
   * @private
   * @returns {Promise<Uint8Array>}
   */
  async _fetchRange(start, end) {
    const slot = acquireRangeSlot();
    if (slot) await slot;
    try {
      // A wider overlapping read may have landed while this one queued; the span-keyed
      // dedup cannot see that.
      const late = this._cached(start, end);
      if (late) return late;

      return await this._request(start, end);
    } finally {
      releaseRangeSlot();
    }
  }

  /**
   * The request itself, with no gate and no cache lookup: `_fetchRange` owns both.
   * @private
   * @returns {Promise<Uint8Array>}
   */
  async _request(start, end) {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, RANGE_TIMEOUT_S * 1000);
    let response;
    try {
      response = await this._fetch(this.url, {
        headers: { Range: `bytes=${start}-${end - 1}` },
        signal: controller.signal,
      });
    } catch (exc) {
      // Name the layer: this message reaches the page via `collectGeodata`'s failures.
      if (exc && exc.name === 'AbortError') {
        throw new Error(
          `FlatGeobuf: ${this.url} did not answer a Range request within `
          + `${RANGE_TIMEOUT_S}s`,
        );
      }
      throw exc;
    } finally {
      clearTimeout(timer);
    }
    if (response.status !== 206) {
      throw new Error(
        `FlatGeobuf: ${this.url} answered ${response.status} to a Range request; `
        + 'the origin must support HTTP Range or every query downloads the whole file',
      );
    }
    if (this.size === null && response.headers && typeof response.headers.get === 'function') {
      // `Content-Range: bytes 0-16383/4230581` — the total after the slash.
      const match = /\/(\d+)\s*$/.exec(response.headers.get('content-range') || '');
      if (match) this.size = Number(match[1]);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.requests += 1;
    this.bytesFetched += bytes.length;
    this._chunks.push({ start, end: start + bytes.length, bytes });
    this._cachedBytes += bytes.length;
    // Evict oldest-first until the cache is back under budget.
    while (this._cachedBytes > CHUNK_CACHE_BYTES && this._chunks.length > 1) {
      this._cachedBytes -= this._chunks.shift().bytes.length;
    }
    // Never hand back more than was asked for, but a short tail read is normal.
    return bytes.subarray(0, Math.min(end - start, bytes.length));
  }

  /** A DataView over `[start, end)`. */
  async view(start, end) {
    const bytes = await this.read(start, end);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// The packed Hilbert R-tree
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * `[start, end)` node index of each level, leaves first, root last. Knowing each level's
 * span is what lets a child index be computed instead of stored.
 *
 * @param {number} numItems @param {number} nodeSize
 * @returns {Array<[number, number]>}
 */
export function levelBounds(numItems, nodeSize) {
  if (nodeSize < 2) throw new Error('FlatGeobuf: index node size must be at least 2');
  if (numItems === 0) return [];
  let n = numItems;
  let numNodes = n;
  const perLevel = [n];
  do {
    n = Math.ceil(n / nodeSize);
    numNodes += n;
    perLevel.push(n);
  } while (n !== 1);

  const bounds = [];
  let end = numNodes;
  for (const size of perLevel) {
    bounds.push([end - size, end]);
    end -= size;
  }
  return bounds;
}

/**
 * Total node count of the packed tree, in nodes not bytes. The leaf level (first entry
 * of `levelBounds`) ends at the end of the array; the last entry's end is the root (1).
 */
export function nodeCount(numItems, nodeSize) {
  const bounds = levelBounds(numItems, nodeSize);
  return bounds.length ? bounds[0][1] : 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Geometry decoding
// ═══════════════════════════════════════════════════════════════════════════════

/** The type a multi-geometry's parts carry when they do not declare one themselves. */
function partType(type) {
  if (type === GEOMETRY_TYPE.MULTIPOLYGON) return GEOMETRY_TYPE.POLYGON;
  if (type === GEOMETRY_TYPE.MULTILINESTRING) return GEOMETRY_TYPE.LINESTRING;
  if (type === GEOMETRY_TYPE.MULTIPOINT) return GEOMETRY_TYPE.POINT;
  // A GeometryCollection's parts each declare their own.
  return GEOMETRY_TYPE.UNKNOWN;
}

/**
 * One Geometry table → points, lines and polygons in GeoJSON axis order (lon, lat).
 *
 * FlatGeobuf stores a feature's coordinates in one flat `xy` array sliced by `ends`;
 * multi-geometries nest one level further in `parts`. Polygons keep their outer/inner
 * structure because the representative-point rule subtracts inner-ring area.
 *
 * @param {Table} geometry
 * @param {number} inheritedType type from the header, for files with a fixed type
 * @returns {{type: number, points: Array<[number, number]>,
 *            lines: Array<Array<[number, number]>>,
 *            polygons: Array<{outer: Array<[number, number]>,
 *                             inners: Array<Array<[number, number]>>}>}}
 */
function decodeGeometry(geometry, inheritedType) {
  const type = geometry.u8(6, inheritedType);
  const out = { type, points: [], lines: [], polygons: [] };

  // A multi-part geometry keeps its parts as nested Geometry tables.
  const [, partsLength] = geometry.vector(7);
  if (partsLength > 0) {
    const inherited = partType(type);
    for (let k = 0; k < partsLength; k++) {
      const decoded = decodeGeometry(geometry.vectorTable(7, k), inherited);
      for (const point of decoded.points) out.points.push(point);
      for (const line of decoded.lines) out.lines.push(line);
      for (const polygon of decoded.polygons) out.polygons.push(polygon);
    }
    return out;
  }

  const xy = geometry.vectorF64(1);
  const ends = geometry.vectorU32(0);
  const total = xy.length / 2;
  if (total === 0) return out;

  /** @param {number} from @param {number} to indices into `xy`, in coordinate pairs */
  const slice = (from, to) => {
    const run = [];
    for (let k = from; k < to; k++) run.push([xy[k * 2], xy[k * 2 + 1]]);
    return run;
  };

  // `ends` is absent when the geometry is a single coordinate run.
  const runs = [];
  if (ends.length === 0) {
    runs.push(slice(0, total));
  } else {
    let from = 0;
    for (const end of ends) {
      runs.push(slice(from, end));
      from = end;
    }
  }

  switch (type) {
    case GEOMETRY_TYPE.POINT:
    case GEOMETRY_TYPE.MULTIPOINT:
      for (const run of runs) for (const point of run) out.points.push(point);
      break;
    case GEOMETRY_TYPE.POLYGON:
      // Ring order within one polygon is outer first, then holes.
      out.polygons.push({ outer: runs[0], inners: runs.slice(1) });
      break;
    default:
      // LineString, MultiLineString and anything untyped read as open runs.
      for (const run of runs) out.lines.push(run);
      break;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Property decoding
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The `properties` byte blob → a plain object keyed by column name.
 *
 * A packed sequence of (uint16 column index, value), where the value's width comes from
 * the column's declared type, so the header must be parsed first. Absent columns are
 * absent from the blob, so a null becomes a missing key.
 *
 * @param {DataView} view @param {number} start @param {number} length
 * @param {ReadonlyArray<{name: string, type: number}>} columns
 * @returns {Object<string, string|number|boolean>}
 */
function decodeProperties(view, start, length, columns) {
  /** @type {Object<string, string|number|boolean>} */
  const out = {};
  let pos = 0;
  while (pos + 2 <= length) {
    const index = view.getUint16(start + pos, true);
    pos += 2;
    const column = columns[index];
    if (column === undefined) break;  // schema drift; stop rather than misread the rest
    const at = start + pos;
    switch (column.type) {
      case COLUMN_TYPE.BOOL: out[column.name] = view.getUint8(at) !== 0; pos += 1; break;
      case COLUMN_TYPE.BYTE: out[column.name] = view.getInt8(at); pos += 1; break;
      case COLUMN_TYPE.UBYTE: out[column.name] = view.getUint8(at); pos += 1; break;
      case COLUMN_TYPE.SHORT: out[column.name] = view.getInt16(at, true); pos += 2; break;
      case COLUMN_TYPE.USHORT: out[column.name] = view.getUint16(at, true); pos += 2; break;
      case COLUMN_TYPE.INT: out[column.name] = view.getInt32(at, true); pos += 4; break;
      case COLUMN_TYPE.UINT: out[column.name] = view.getUint32(at, true); pos += 4; break;
      case COLUMN_TYPE.LONG: out[column.name] = Number(view.getBigInt64(at, true)); pos += 8; break;
      case COLUMN_TYPE.ULONG: out[column.name] = Number(view.getBigUint64(at, true)); pos += 8; break;
      case COLUMN_TYPE.FLOAT: out[column.name] = view.getFloat32(at, true); pos += 4; break;
      case COLUMN_TYPE.DOUBLE: out[column.name] = view.getFloat64(at, true); pos += 8; break;
      case COLUMN_TYPE.DATETIME:
      case COLUMN_TYPE.JSON:
      case COLUMN_TYPE.STRING: {
        const size = view.getUint32(at, true);
        out[column.name] = utf8(view, at + 4, size);
        pos += 4 + size;
        break;
      }
      case COLUMN_TYPE.BINARY: {
        const size = view.getUint32(at, true);
        pos += 4 + size;  // nothing here reads binary columns
        break;
      }
      default:
        // An unknown type has an unknown width; the rest of the blob is unparseable.
        return out;
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FlatGeobufReader
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} FgbFeature
 * @property {Object<string, string|number|boolean>} properties
 * @property {number} type GEOMETRY_TYPE
 * @property {Array<[number, number]>} points (lon, lat)
 * @property {Array<Array<[number, number]>>} lines open coordinate runs, (lon, lat)
 * @property {Array<{outer: Array<[number, number]>, inners: Array<Array<[number, number]>>}>} polygons
 */

export class FlatGeobufReader {
  /**
   * @param {string} url
   * @param {{fetchImpl?: typeof fetch}} [opts]
   */
  constructor(url, opts = {}) {
    this.url = url;
    this.reader = new RangeReader(url, opts);
    /** @type {null|{featuresCount: number, indexNodeSize: number, columns: Array, geometryType: number, dataStart: number, indexStart: number}} */
    this.head = null;
    // The last walk, keyed by rect: `worldCount` and `worldPois` run back to back on
    // the same layer and rect, and one entry saves the second walk.
    /** @type {null|{key: string, offsets: Array<number>}} */
    this._lastSearch = null;
  }

  /** Bytes fetched so far, for the provenance row. */
  get bytesFetched() { return this.reader.bytesFetched; }

  get requestCount() { return this.reader.requests; }

  /**
   * Read and parse the header. Idempotent; every query awaits it first. One generous
   * probe usually covers the header and the first index nodes too.
   */
  async open() {
    if (this.head) return this.head;

    const probe = await this.reader.read(0, HEADER_PROBE_BYTES);
    if (probe.length < HEADER_PREFIX) {
      throw new Error(`FlatGeobuf: ${this.url} is too short to be a FlatGeobuf`);
    }
    for (let i = 0; i < MAGIC.length; i++) {
      if (probe[i] !== MAGIC[i]) {
        throw new Error(`FlatGeobuf: ${this.url} is not a FlatGeobuf (bad magic)`);
      }
    }

    const view = new DataView(probe.buffer, probe.byteOffset, probe.byteLength);
    const headerLength = view.getUint32(MAGIC_LEN, true);
    if (HEADER_PREFIX + headerLength > probe.length) {
      // Rare, but a layer with very many columns can exceed the probe.
      const bigger = await this.reader.read(0, HEADER_PREFIX + headerLength);
      return this._parseHeader(
        new DataView(bigger.buffer, bigger.byteOffset, bigger.byteLength), headerLength,
      );
    }
    return this._parseHeader(view, headerLength);
  }

  /** @private */
  _parseHeader(view, headerLength) {
    const header = root(view, MAGIC_LEN + 4);

    const [, columnCount] = header.vector(7);
    const columns = [];
    for (let k = 0; k < columnCount; k++) {
      const column = header.vectorTable(7, k);
      columns.push({ name: column.string(0) || `col${k}`, type: column.u8(1) });
    }

    const featuresCount = header.u64(8, 0);
    const indexNodeSize = header.u16(9, 16);
    const indexStart = HEADER_PREFIX + headerLength;
    const indexBytes = indexNodeSize > 0
      ? nodeCount(featuresCount, indexNodeSize) * NODE_ITEM_LEN
      : 0;

    this.head = {
      geometryType: header.u8(2, GEOMETRY_TYPE.UNKNOWN),
      columns,
      featuresCount,
      indexNodeSize,
      indexStart,
      dataStart: indexStart + indexBytes,
    };
    return this.head;
  }

  /**
   * Byte offsets of every feature whose bounding box intersects `rect`.
   *
   * A breadth-first walk of the packed tree, one level at a time. At the leaf level a
   * hit is a feature offset; above it a hit is a child block to descend into. Nodes are
   * read a block at a time (`indexNodeSize` nodes) because siblings are contiguous.
   *
   * @param {{minX: number, minY: number, maxX: number, maxY: number}} rect (lon, lat)
   * @returns {Promise<Array<number>>} byte offsets relative to `dataStart`, ascending
   */
  async search(rect) {
    const memoKey = `${rect.minX},${rect.minY},${rect.maxX},${rect.maxY}`;
    if (this._lastSearch !== null && this._lastSearch.key === memoKey) {
      return this._lastSearch.offsets.slice();
    }
    const head = await this.open();
    if (head.featuresCount === 0) return [];
    if (head.indexNodeSize === 0) {
      throw new Error(
        `FlatGeobuf: ${this.url} carries no spatial index, so a bbox query would mean `
        + 'downloading the whole file. Rebuild it with SPATIAL_INDEX=YES.',
      );
    }

    const bounds = levelBounds(head.featuresCount, head.indexNodeSize);

    /** @type {Array<number>} */
    const offsets = [];
    // The tree is stored ROOT FIRST: node index 0 is the root. Each level's blocks are
    // independent, so they are coalesced and fetched together rather than one at a time.
    /** @type {Array<number>} node indices at the current level. */
    let frontier = [0];

    for (let level = bounds.length - 1; level >= 0 && frontier.length; level--) {
      const isLeafLevel = level === 0;
      const levelEnd = bounds[level][1];

      // One block per frontier node, deduplicated (two parents can share a block).
      const blocks = Array.from(new Set(frontier)).sort((a, b) => a - b)
        .map((nodeIndex) => ({
          start: nodeIndex,
          end: Math.min(nodeIndex + head.indexNodeSize, levelEnd),
        }));

      // Merge nearby blocks into one request, subject to the single-request ceiling.
      /** @type {Array<{start: number, end: number, bytes?: Uint8Array}>} */
      const runs = [];
      for (const block of blocks) {
        const last = runs[runs.length - 1];
        if (last
            && (block.start - last.end) * NODE_ITEM_LEN <= RANGE_COALESCE_BYTES
            && (block.end - last.start) * NODE_ITEM_LEN <= MAX_RANGE_BYTES) {
          last.end = Math.max(last.end, block.end);
        } else {
          runs.push({ start: block.start, end: block.end });
        }
      }

      for (let at = 0; at < runs.length; at += INDEX_READ_CONCURRENCY) {
        const batch = runs.slice(at, at + INDEX_READ_CONCURRENCY);
        /* eslint-disable-next-line no-await-in-loop */
        const parts = await Promise.all(batch.map((run) => this.reader.read(
          head.indexStart + run.start * NODE_ITEM_LEN,
          head.indexStart + run.end * NODE_ITEM_LEN,
        )));
        batch.forEach((run, k) => { run.bytes = parts[k]; });
      }

      /** @type {Array<number>} */
      const next = [];
      for (const block of blocks) {
        const run = runs.find((r) => r.start <= block.start && r.end >= block.end);
        const view = new DataView(
          run.bytes.buffer, run.bytes.byteOffset, run.bytes.byteLength,
        );
        const base = (block.start - run.start) * NODE_ITEM_LEN;
        for (let i = 0; i < block.end - block.start; i++) {
          const at = base + i * NODE_ITEM_LEN;
          // A clamped tail read can hand back a short block; stop rather than read past.
          if (at + NODE_ITEM_LEN > view.byteLength) break;
          const minX = view.getFloat64(at, true);
          const minY = view.getFloat64(at + 8, true);
          const maxX = view.getFloat64(at + 16, true);
          const maxY = view.getFloat64(at + 24, true);
          if (rect.maxX < minX || rect.maxY < minY || rect.minX > maxX || rect.minY > maxY) {
            continue;
          }
          // The same uint64 is a child block index on an internal node and a feature
          // byte offset on a leaf. That is the format.
          const offset = Number(view.getBigUint64(at + 32, true));
          if (isLeafLevel) offsets.push(offset);
          else next.push(offset);
        }
      }
      frontier = next;
    }

    // Ascending order turns the reads into a forward scan, which makes coalescing work.
    offsets.sort((a, b) => a - b);
    // Always hand out a copy so a caller cannot corrupt the memo.
    this._lastSearch = { key: memoKey, offsets };
    return offsets.slice();
  }

  /**
   * Every feature intersecting `rect`, decoded.
   *
   * Nearby feature offsets are coalesced into one Range request (a bbox query lands on
   * Hilbert-adjacent features), and the runs are read a batch at a time.
   *
   * OUTPUT ORDER IS PART OF THE CONTRACT: batches, runs and features all go in offset
   * order, so `features` is ascending-offset and `worldPois` tie-breaks on that.
   * Decoding is per batch so a batch's bytes are droppable once read.
   *
   * @param {{minX: number, minY: number, maxX: number, maxY: number}} rect
   * @returns {Promise<Array<FgbFeature>>}
   */
  async query(rect) {
    const head = await this.open();
    const offsets = await this.search(rect);
    if (!offsets.length) return [];

    /** @type {Array<FgbFeature>} */
    const features = [];

    // Group the offsets into runs that will be fetched together.
    /** @type {Array<{from: number, to: number}>} indices into `offsets`, half-open */
    const runs = [];
    let runStart = 0;
    while (runStart < offsets.length) {
      let runEnd = runStart + 1;
      while (
        runEnd < offsets.length
        && offsets[runEnd] - offsets[runEnd - 1] < RANGE_COALESCE_BYTES
        && offsets[runEnd] - offsets[runStart] < MAX_RANGE_BYTES - RANGE_COALESCE_BYTES
      ) {
        runEnd += 1;
      }
      runs.push({ from: runStart, to: runEnd });
      runStart = runEnd;
    }

    /**
     * One run's bytes, tail included. The second read's length depends on the first.
     * @param {{from: number, to: number}} run
     * @returns {Promise<Uint8Array>}
     */
    const readRun = async (run) => {
      const first = offsets[run.from];
      const last = offsets[run.to - 1];
      // The last feature's length is unknown until its size prefix is read, so pull a
      // conservative tail; when short, fetch ONLY the missing bytes and splice them on.
      const bytes = await this.reader.read(
        head.dataStart + first,
        head.dataStart + last + RANGE_COALESCE_BYTES,
      );
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

      const lastSize = view.getUint32(last - first, true);
      const need = (last - first) + 4 + lastSize;
      if (need <= bytes.length) return bytes;

      const rest = await this.reader.read(
        head.dataStart + first + bytes.length,
        head.dataStart + first + need,
      );
      const joined = new Uint8Array(bytes.length + rest.length);
      joined.set(bytes, 0);
      joined.set(rest, bytes.length);
      return joined;
    };

    for (let at = 0; at < runs.length; at += FEATURE_READ_CONCURRENCY) {
      const batch = runs.slice(at, at + FEATURE_READ_CONCURRENCY);
      /* eslint-disable-next-line no-await-in-loop */
      const parts = await Promise.all(batch.map(readRun));

      batch.forEach((run, b) => {
        const bytes = parts[b];
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const first = offsets[run.from];
        for (let k = run.from; k < run.to; k++) {
          const offsetInRun = offsets[k] - first;
          const feature = root(view, offsetInRun + 4);
          const geometry = feature.table(0);
          const decoded = geometry
            ? decodeGeometry(geometry, head.geometryType)
            : { type: GEOMETRY_TYPE.UNKNOWN, points: [], lines: [], polygons: [] };
          const [propsStart, propsLength] = feature.vector(1);
          features.push({
            properties: propsLength
              ? decodeProperties(view, propsStart, propsLength, head.columns)
              : {},
            type: decoded.type,
            points: decoded.points,
            lines: decoded.lines,
            polygons: decoded.polygons,
          });
        }
      });
    }
    return features;
  }
}
