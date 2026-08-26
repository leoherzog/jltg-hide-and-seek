// lib/cache.js — content-addressed HTTP cache (generate.py).
//
// The Python writes `cache/<kind>/<sha256(key)[:16]>.<ext>` on disk. The browser has
// no disk, so the same content-addressed naming scheme becomes a single IndexedDB
// object store keyed by that exact relative path string. Everything that made the
// file-system version defensible survives:
//
//   * The key is always the FULLY SUBSTITUTED request — the URL with its parameters —
//     so a different feed is a different entry. Only 'gtfs' is stored now; the world
//     files are immutable and content-addressed, so the browser's HTTP cache handles
//     them and nothing here has to.
//   * Nothing time-derived is ever part of a key.
//   * The stored value is the response body and nothing else: no fetch timestamp,
//     no headers, no status. A populated cache makes the whole run offline and
//     byte-identical.
//
// Worker-side module: no DOM, no window, no localStorage.

import { sha256Text } from './core.js';

const DB_NAME = 'jltg-hide-and-seek-cache';
const DB_VERSION = 1;
const STORE = 'responses';

/**
 * Raised in offline mode when a request is not already cached.
 * `err.name === 'CacheMiss'` — callers switch on the name, not on `instanceof`,
 * because the error may cross a `postMessage` boundary as a plain string.
 */
export class CacheMiss extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'CacheMiss';
  }
}

// ── backing stores ───────────────────────────────────────────────────────────
//
// Two implementations behind one two-method interface — `get` and `put`. There is
// no delete: invalidation is `opts.refresh`, which makes `get` report a miss and
// the write that follows overwrite the entry in place, so nothing ever has to be
// evicted. `indexedDB` does not exist in Node (the integration smoke test runs
// there) and can also be missing or throw in a locked-down browser profile, so the
// in-memory Map is not a test affordance — it is the real fallback. The public
// `Cache` API is identical either way; only `cache.backend` tells them apart.

class MemoryStore {
  constructor() {
    /** @type {Map<string, ArrayBuffer>} */
    this.map = new Map();
    this.backend = 'memory';
  }

  /** @param {string} name @returns {Promise<ArrayBuffer|null>} */
  async get(name) {
    const hit = this.map.get(name);
    return hit === undefined ? null : hit;
  }

  /** @param {string} name @param {ArrayBuffer} body */
  async put(name, body) {
    this.map.set(name, body);
  }
}

class IdbStore {
  /** @param {IDBDatabase} db */
  constructor(db) {
    this.db = db;
    this.backend = 'indexeddb';
  }

  /** @param {IDBTransactionMode} mode */
  _tx(mode) {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }

  /** @param {string} name @returns {Promise<ArrayBuffer|null>} */
  async get(name) {
    const value = await request(this._tx('readonly').get(name));
    if (value === undefined || value === null) return null;
    // Older entries, or a store written by another tab, may hold a view.
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    return null;
  }

  /** @param {string} name @param {ArrayBuffer} body */
  async put(name, body) {
    await request(this._tx('readwrite').put(body, name));
  }
}

// The backend the cache in force settled on. The pipeline hands the `Cache` to the
// network layer and never to the scoring layer, so this module-level record is how
// `buildProvenance` (rules/score.js) gets to say that the browser fell back to a
// non-persistent Map — which is otherwise completely silent, and is the difference
// between "the second run is instant" and "the second run refetches everything".
// One run opens exactly one cache, so there is nothing here to disambiguate.
let ACTIVE_BACKEND = 'memory';

/**
 * Which store the cache in force is using: `'indexeddb'` or `'memory'`.
 * Read by `buildProvenance`; see `ACTIVE_BACKEND` above.
 * @returns {string}
 */
export function cacheBackend() {
  return ACTIVE_BACKEND;
}

/** Promisify one IDBRequest. @param {IDBRequest} req */
function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

/** @param {string} dbName @returns {Promise<IdbStore>} */
function openIdb(dbName) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    open.onsuccess = () => resolve(new IdbStore(open.result));
    open.onerror = () => reject(open.error || new Error('IndexedDB open failed'));
    open.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

// ── the cache ────────────────────────────────────────────────────────────────

export class Cache {
  /**
   * Prefer `openCache()` — it picks the backing store for you. Constructing
   * directly with no store gives you the in-memory one, which is what a Node
   * smoke test wants.
   *
   * @param {{get:Function, put:Function, backend:string}} [store]
   * @param {{offline?: boolean, refresh?: boolean}} [opts]
   */
  constructor(store, opts = {}) {
    this.store = store || new MemoryStore();
    /** @type {string} `'indexeddb'` or `'memory'` — reported in the provenance block */
    this.backend = this.store.backend;
    ACTIVE_BACKEND = this.backend;
    this.offline = opts.offline === true;
    this.refresh = opts.refresh === true;
  }

  /**
   * The `<kind>/<sha256(key)[:16]>.<ext>` handle a request is filed under. ASYNC,
   * because `sha256Text` is (`crypto.subtle.digest` returns a Promise) — this is
   * the one signature that differs from the Python's `path_for`.
   *
   * @param {string} kind cache namespace; only 'gtfs' is used
   * @param {string} key the fully substituted request
   * @param {string} ext
   * @returns {Promise<string>}
   */
  async nameFor(kind, key, ext) {
    const digest = await sha256Text(key);
    return `${kind}/${digest.slice(0, 16)}.${ext}`;
  }

  /**
   * Return the cached body, or null on a miss (or when `refresh` is set).
   * @param {string} kind @param {string} key @param {string} ext
   * @returns {Promise<ArrayBuffer|null>}
   */
  async get(kind, key, ext) {
    const name = await this.nameFor(kind, key, ext);
    if (this.refresh) return null;
    let body = null;
    try {
      body = await this.store.get(name);
    } catch {
      // A failed read is a miss, never a crash: the run can always refetch.
      return null;
    }
    if (body === null) return null;
    return body;
  }

  /**
   * Write a response body into the cache and return its handle.
   * @param {string} kind @param {string} key @param {string} ext
   * @param {ArrayBuffer|ArrayBufferView} body
   * @returns {Promise<string>}
   */
  async put(kind, key, ext, body) {
    const name = await this.nameFor(kind, key, ext);
    const buf = body instanceof ArrayBuffer
      ? body
      : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    try {
      await this.store.put(name, buf);
    } catch {
      // Quota exceeded, or a private-mode store that refuses writes. The body is
      // already in hand; losing the cache entry only costs a refetch next run.
    }
    return name;
  }

  /**
   * @param {string} what
   * @throws {CacheMiss} in offline mode
   */
  requireOnline(what) {
    if (this.offline) throw new CacheMiss(`offline and no cached response for ${what}`);
  }
}

/**
 * Open the cache, preferring IndexedDB and falling back to an in-memory Map when
 * `indexedDB` is absent (Node) or unusable (locked-down profile).
 *
 * @param {{offline?: boolean, refresh?: boolean}} [opts]
 * @returns {Promise<Cache>}
 */
export async function openCache(opts = {}) {
  let store = null;
  if (typeof indexedDB !== 'undefined' && indexedDB) {
    try {
      store = await openIdb(DB_NAME);
    } catch {
      store = null;
    }
  }
  return new Cache(store || new MemoryStore(), opts);
}

