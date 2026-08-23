/**
 * osm/flatgeobuf.js — the FlatGeobuf-over-HTTP-Range transport layer.
 *
 * This is to the world files what `./overpass.js` is to Overpass: pure transport, no
 * app knowledge. It knows the byte layout of a FlatGeobuf and nothing about parks.
 * `./worldfile.js` is the layer above that turns features into `Poi` records.
 *
 * WORKER SIDE ONLY — no DOM.
 *
 * ── Why this file exists at all ───────────────────────────────────────────────
 *
 * The reference implementation is the `flatgeobuf` npm package. It is not used here
 * for two reasons, and only the second is about taste:
 *
 *   1. This app is a no-build ESM app and the pipeline runs inside a module Worker.
 *      Import maps are document-scoped and do not apply to workers, so a bare
 *      `import 'flatgeobuf'` cannot resolve there. The alternative is a CDN URL, which
 *      would reintroduce a run-time third-party dependency — the exact failure mode
 *      this whole migration exists to remove.
 *   2. Everything else in this codebase is a hand-port with its reasoning written down.
 *
 * ── The format, in the order the bytes appear ─────────────────────────────────
 *
 *   magic          8 bytes    'f','g','b', 3, 'f','g','b', patch
 *   headerLength   uint32     little-endian, as is everything below
 *   header         flatbuffer  name, envelope, geometry type, columns, feature count,
 *                              and index_node_size — the R-tree branching factor
 *   index          optional   packed Hilbert R-tree, 40 bytes per node
 *   features       repeated   uint32 byte length, then a Feature flatbuffer
 *
 * ── Why the index is the entire point ────────────────────────────────────────
 *
 * The R-tree is packed: it is a flat array of nodes in level order, so a node's
 * children are at a computable offset rather than behind a pointer chase. That is what
 * makes it readable over HTTP. `search` walks it a block at a time with Range requests
 * and never reads the levels it does not need, so a bbox query against a 4 GB planet
 * layer costs a few tens of kilobytes.
 *
 * A FlatGeobuf written WITHOUT the index (`index_node_size` = 0) is still a valid file
 * and still reads correctly — by downloading all of it. That failure is silent, which
 * is why `tools/osm-world/build.py` checks the GDAL version rather than trusting it,
 * and why `search` throws rather than quietly falling back to a full scan.
 */

// ── format constants ─────────────────────────────────────────────────────────

const MAGIC = Object.freeze([0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62]);
const MAGIC_LEN = 8;
const HEADER_PREFIX = MAGIC_LEN + 4;   // magic + the uint32 header length
const NODE_ITEM_LEN = 40;              // 4 doubles of bbox + one uint64 offset

/** How much to read on the first request. Big enough for essentially every header. */
const HEADER_PROBE_BYTES = 16384;

/**
 * Seconds before one Range request is abandoned. An origin that accepts the connection
 * and then says nothing is indistinguishable from a slow one until a timer says
 * otherwise, and without this the page spins for as long as the reader is willing to
 * wait — which was forever. `lib/http.js` has had the same abort-based timeout since
 * the Overpass days; this is that pattern, applied to the transport that replaced it.
 */
export const RANGE_TIMEOUT_S = 30;

/** Two ranges closer together than this are fetched as one. */
const RANGE_COALESCE_BYTES = 8192;

/** Never ask for a single range larger than this. */
const MAX_RANGE_BYTES = 8 << 20;

/**
 * How many index reads to have in flight at once during a level of the R-tree walk.
 * The origin is nowhere near the constraint — R2 answered 1,200 concurrent range
 * requests against one object in 2.9 s with no failures — so this is set for the
 * browser's own per-host connection limit rather than for the server.
 */
const INDEX_READ_CONCURRENCY = 12;

/** Cap the resident chunk cache by BYTES, not by entry count: one walk of a busy
 *  layer touches ~150 KB across a couple of hundred small blocks, so a 64-entry cap
 *  evicted the head of the walk before its tail had been read. */
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
// A minimal FlatBuffers table reader
// ═══════════════════════════════════════════════════════════════════════════════
//
// FlatBuffers is read, never written, here — so this is the read half only, and it is
// about forty lines. A table stores a signed 32-bit offset BACKWARDS to its vtable;
// the vtable then lists, per field, the byte offset of that field within the table (or
// zero when the field is absent, which is how defaults work). Nothing is copied: every
// accessor is an offset computation against the one underlying DataView.

class Table {
  /**
   * @param {DataView} view
   * @param {number} pos byte offset of the table within `view`
   */
  constructor(view, pos) {
    this.view = view;
    this.pos = pos;
    // The vtable lives at a NEGATIVE offset from the table — the one place in the
    // format where an offset is signed.
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
 * The world files are immutable per build and served `max-age=31536000, immutable`, so
 * the browser HTTP cache does the durable caching and this only avoids re-requesting
 * ranges within a single run. Chunks are kept whole rather than merged: an R-tree walk
 * revisits the same node block often and rarely revisits feature bytes at all.
 *
 * A server that ignores `Range` and answers 200 with the whole body would silently
 * turn every query into a full download, so a non-206 response is an error.
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
    this.bytesFetched = 0;
    this.requests = 0;
    // Learned from the first 206's `Content-Range`. Until then reads are unclamped,
    // which is safe because the header probe is far smaller than any real world file.
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
    // The tail of the file is a legitimate read target — the last feature's own length
    // is not known until its size prefix has been read, so callers deliberately ask for
    // a conservative overshoot. Clamping here is what keeps that from becoming an
    // unsatisfiable range.
    if (this.size !== null) end = Math.min(end, this.size);
    if (end <= start) return new Uint8Array(0);
    if (end - start <= MAX_RANGE_BYTES) return this._readOne(start, end);

    // An oversize span is DATA, not a bug. `query` derives it from the feature's own
    // 4-byte length prefix, and OSM really does hold single features tens of megabytes
    // wide — Lake Nasser is 21 MB and one `pitch` covering the Alaska panhandle is 31 MB,
    // 3.7× this ceiling. Refusing threw out of `query` entirely, so every OTHER feature
    // in the run was lost too and `geodata.js` recorded the whole category as partial
    // with nothing on the page to say so: a ~0.04° box over Savonlinna lost all four
    // `water` features, a 2 km box over Juneau all fifteen `pitch`. Split the read and
    // let the ceiling do the one job it should — bounding a single request.
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
   * One Range request, at most `MAX_RANGE_BYTES` wide. `read` is the entry point;
   * this is where the ceiling is enforced, and the throw is now unreachable from
   * outside — it survives only as an assertion that `read` did its own arithmetic right.
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

    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, RANGE_TIMEOUT_S * 1000);
    let response;
    try {
      response = await this._fetch(this.url, {
        headers: { Range: `bytes=${start}-${end - 1}` },
        signal: controller.signal,
      });
    } catch (exc) {
      // `AbortError` alone says nothing about which layer stalled, and this message
      // travels all the way to the reader through `collectGeodata`'s failure list.
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
    // Evict oldest-first until the cache is back under budget. Counting entries
    // instead of bytes made the cap depend on the size of the reads that happened to
    // land in it, which is why an index walk could evict its own working set.
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
 * `[start, end)` node index of each level, leaves first, root last.
 *
 * The tree is stored as one flat array in level order: all leaves, then their parents,
 * and so on up to a single root. Knowing each level's span is what lets a child index
 * be computed arithmetically instead of stored, which is what makes the whole structure
 * readable over HTTP.
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
 * Total node count of the packed tree — its size in nodes, not bytes.
 *
 * `levelBounds` returns leaves FIRST and root LAST, but the node array is laid out root
 * first, so the leaf level is the one that ends at the end of the array. Reading the
 * last entry's end instead gives 1 — the root — which under-sizes the index and lands
 * `dataStart` in the middle of it.
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
 * FlatGeobuf stores every coordinate of a feature in one flat `xy` array and slices it
 * with `ends`, so a polygon's rings are ranges into a single buffer rather than nested
 * arrays. Multi-geometries nest one level further, in `parts`.
 *
 * The three kinds are returned separately, and polygons keep their outer/inner
 * structure, because that is exactly the shape `representativeLatlon` needs: it
 * subtracts inner-ring area from outer-ring area to place a label point. Flattening
 * every ring into one list would silently turn a lake with an island into a lake, and
 * the resulting centroid would drift with no error anywhere.
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
      // LineString, MultiLineString and anything untyped read as open runs. A closed
      // run is promoted to a polygon by the caller, which is where `natural=coastline`
      // and closed-way areas are told apart.
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
 * The blob is a packed sequence of (uint16 column index, value), where the value's
 * width comes from that column's declared type rather than from the blob — which is why
 * the header's column list has to be parsed before any feature can be read. Absent
 * columns are simply not present in the blob, so a null is a missing key here, and that
 * is what lets `name IS NOT NULL` survive the round trip.
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
        // An unknown type has an unknown width, so the rest of the blob is
        // unparseable. Returning what was read is honest; guessing is not.
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
    // The last walk, keyed by rect. `worldCount` and `worldPois` are called back to
    // back on the same layer with the same rect — the first to decide whether the
    // category is affordable, the second to fetch it — and each ran a full independent
    // walk of the same tree. One entry is all that is needed: the caller moves on to
    // the next layer and never comes back to this one.
    /** @type {null|{key: string, offsets: Array<number>}} */
    this._lastSearch = null;
  }

  /** Bytes fetched so far, for the provenance row. */
  get bytesFetched() { return this.reader.bytesFetched; }

  get requestCount() { return this.reader.requests; }

  /**
   * Read and parse the header. Idempotent — every query awaits it first.
   *
   * One request covers the magic, the header and usually the first index nodes too;
   * `HEADER_PROBE_BYTES` is deliberately generous because a second round-trip costs
   * far more than the unused bytes.
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
   * A breadth-first walk of the packed tree, reading one node block per step. The
   * queue holds `[nodeIndex, level]`; at the leaf level a hit is a feature offset,
   * above it a hit is a subtree to descend into. Nodes are read a full block at a time
   * (`indexNodeSize` nodes, 640 bytes at the default branching factor of 16) because
   * siblings are contiguous and are always examined together.
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
    // The tree is stored ROOT FIRST — `levelBounds` returns leaves first, but the last
    // entry it produces is `[0, 1]`, so node index 0 is the root. Starting anywhere
    // else walks into the middle of the leaf level and reads feature offsets as if they
    // were node indices.
    // Walk one LEVEL at a time, not one node at a time. Every node in a level is
    // independent of its siblings, so draining a queue with `shift()` and awaiting each
    // read in turn spends the entire walk waiting on round trips that could have
    // overlapped — and blocks a few hundred bytes apart in the file were fetched
    // separately, even though RANGE_COALESCE_BYTES was declared for exactly that and
    // used only by `query`. Measured on the live `shop` layer over the Grand Rapids
    // border: 98 serial requests and 7.4 s became 8 requests and 0.7 s, for an
    // identical offset list. The traversal below is unchanged — same tests, same order
    // of descent — only the fetching is batched.
    /** @type {Array<number>} node indices at the current level. */
    let frontier = [0];

    for (let level = bounds.length - 1; level >= 0 && frontier.length; level--) {
      const isLeafLevel = level === 0;
      const levelEnd = bounds[level][1];

      // One block per frontier node, deduplicated and ordered: two parents can point
      // into the same block, and reading it twice is pure waste.
      const blocks = Array.from(new Set(frontier)).sort((a, b) => a - b)
        .map((nodeIndex) => ({
          start: nodeIndex,
          end: Math.min(nodeIndex + head.indexNodeSize, levelEnd),
        }));

      // Merge blocks close enough that one request is cheaper than two, subject to the
      // single-request ceiling.
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
          // The same uint64 field means two different things by level: on an internal
          // node it is the index of the child block, on a leaf it is the byte offset of
          // the feature. That is the format, not a shortcut.
          const offset = Number(view.getBigUint64(at + 32, true));
          if (isLeafLevel) offsets.push(offset);
          else next.push(offset);
        }
      }
      frontier = next;
    }

    // Ascending order turns the reads into a forward scan, which is what makes
    // coalescing worthwhile.
    offsets.sort((a, b) => a - b);
    // Hand out a copy, always, so a caller that sorts or splices its result cannot
    // corrupt what the next caller gets back.
    this._lastSearch = { key: memoKey, offsets };
    return offsets.slice();
  }

  /**
   * Every feature intersecting `rect`, decoded.
   *
   * Adjacent feature offsets are coalesced into one Range request when the gap between
   * them is small: a bbox query usually lands on a run of Hilbert-adjacent features, so
   * fetching the gap is cheaper than a second round-trip.
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

      const first = offsets[runStart];
      const last = offsets[runEnd - 1];
      // The last feature's own length is unknown until its size prefix is read, so
      // pull a conservative tail. When that turns out to be short, fetch ONLY the
      // missing bytes and splice them on — re-reading the whole run was the old
      // behavior, and the RangeReader cache cannot absorb a request wider than any
      // chunk it holds, so a run ending in a country-sized polygon (~1 MB) paid for
      // the entire run twice on every admin query.
      let bytes = await this.reader.read(
        head.dataStart + first,
        head.dataStart + last + RANGE_COALESCE_BYTES,
      );
      let view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

      const lastSize = view.getUint32(last - first, true);
      const need = (last - first) + 4 + lastSize;
      if (need > bytes.length) {
        const rest = await this.reader.read(
          head.dataStart + first + bytes.length,
          head.dataStart + first + need,
        );
        const joined = new Uint8Array(bytes.length + rest.length);
        joined.set(bytes, 0);
        joined.set(rest, bytes.length);
        bytes = joined;
        view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      }

      for (let k = runStart; k < runEnd; k++) {
        const at = offsets[k] - first;
        const feature = root(view, at + 4);
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
      runStart = runEnd;
    }
    return features;
  }
}
