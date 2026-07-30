// lib/http.js — fetch with caching, retries, mirror failover and courtesy
// sleeps. Port of `http_fetch`, generate.py lines 548–610.
//
// Worker-side module: no DOM. `fetch` and `setTimeout` only.
//
// Retries and sleeps use setTimeout-based delay. That affects timing, never output,
// so it does not violate the determinism rule — no wall clock is ever read.

// `CacheMiss` is thrown by `cache.requireOnline()`, not here — import it from
// `./cache.js` if you need to catch it by identity.

// ── constants (generate.py lines 127–139) ────────────────────────────────────

export const OVERPASS_ENDPOINTS = Object.freeze([
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]);
export const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';
export const HTTP_TIMEOUT_S = 300.0;
export const HTTP_ATTEMPTS_PER_ENDPOINT = 2;
export const HTTP_BACKOFF_S = 8.0;             // between attempts on the same endpoint
export const OVERPASS_COURTESY_SLEEP_S = 3.0;  // after every successful fetch
export const NOMINATIM_COURTESY_SLEEP_S = 1.0; // Nominatim's hard limit is 1 req/s
export const OVERPASS_WAY_BUDGET = 150000;     // above this, tile the bbox

/**
 * Delay for `seconds`. The only timing primitive in the port.
 * @param {number} seconds
 * @returns {Promise<void>}
 */
export function sleep(seconds) {
  const ms = Math.max(0, Number(seconds) || 0) * 1000;
  if (ms === 0) return Promise.resolve();
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// ── what the browser will not let us do ──────────────────────────────────────
//
// The Python sends `User-Agent: <USER_AGENT>` and `Accept-Encoding: gzip`. Neither
// is settable from `fetch()`: both are forbidden header names, and the browser
// manages them itself. Do not try. More importantly, do not send ANY header that
// is not CORS-safelisted — a preflight `OPTIONS` to Overpass or Nominatim is not
// answered the way the actual request is, and the fetch fails outright.
//
// Overpass POSTs therefore carry `Content-Type: text/plain`, which is safelisted
// (verified: overpass-api.de answers such a POST with `Access-Control-Allow-Origin: *`).
// Anything else — `application/x-www-form-urlencoded` is fine too, but JSON is not —
// provokes a preflight.

const POST_CONTENT_TYPE = 'text/plain';

/**
 * Build the request URL. `params` is applied in insertion order, mirroring httpx.
 * @param {string} endpoint
 * @param {Object<string,string>|null} params
 */
function withParams(endpoint, params) {
  if (!params) return endpoint;
  const url = new URL(endpoint);
  for (const key of Object.keys(params)) {
    const v = params[key];
    if (v === null || v === undefined) continue;
    url.searchParams.set(key, String(v));
  }
  return url.toString();
}

/**
 * `fetch` with an abort-based timeout — the equivalent of httpx's `timeout=`.
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutS
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, init, timeoutS) {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, Math.max(1, timeoutS * 1000));
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a URL with caching, retries and mirror failover. Returns the body.
 *
 * Tries each endpoint in `endpoints` order, `attemptsPerEndpoint` times each,
 * sleeping `backoffS` between attempts and honouring `Retry-After` on 429. This is
 * not defensive programming for its own sake: during the measurement run behind
 * specs/osm.md, overpass-api.de returned HTTP 504 on the first attempt of five of
 * six queries and one query only succeeded on the third mirror.
 *
 * Throws `CacheMiss` in offline mode, or a plain `Error` when every endpoint is
 * exhausted.
 *
 * @param {import('./cache.js').Cache} cache
 * @param {Object} opts
 * @param {string} opts.kind                          'gtfs' | 'overpass' | 'nominatim'
 * @param {string} opts.cacheKey                      the fully substituted request
 * @param {string} opts.ext
 * @param {ReadonlyArray<string>} opts.endpoints
 * @param {'GET'|'POST'} [opts.method]
 * @param {Object<string,string>|null} [opts.params]
 * @param {string|null} [opts.data]                   POST body
 * @param {number} [opts.courtesySleepS]
 * @param {number} [opts.attemptsPerEndpoint]
 * @param {number} [opts.backoffS]
 * @param {number} [opts.timeoutS]
 * @returns {Promise<ArrayBuffer>}
 */
export async function httpFetch(cache, opts) {
  const {
    kind,
    cacheKey,
    ext,
    endpoints,
    method = 'GET',
    params = null,
    data = null,
    courtesySleepS = 0,
    attemptsPerEndpoint = HTTP_ATTEMPTS_PER_ENDPOINT,
    backoffS = HTTP_BACKOFF_S,
    timeoutS = HTTP_TIMEOUT_S,
  } = opts;

  const hit = await cache.get(kind, cacheKey, ext);
  if (hit !== null) return hit;
  cache.requireOnline(cacheKey.slice(0, 120));

  /** @type {Error|null} */
  let last = null;
  for (const endpoint of endpoints) {
    for (let attempt = 1; attempt <= attemptsPerEndpoint; attempt++) {
      try {
        const url = withParams(endpoint, params);
        /** @type {RequestInit} */
        const init = method === 'POST'
          ? { method: 'POST', body: data, headers: { 'Content-Type': POST_CONTENT_TYPE } }
          : { method: 'GET' };
        const r = await fetchWithTimeout(url, init, timeoutS);
        if (r.status === 429) {
          // Mirrors the Python's `float(r.headers.get("Retry-After", backoff_s))`:
          // a non-numeric (HTTP-date) Retry-After raises there and is caught as a
          // failed attempt, so it does the same here.
          const raw = r.headers.get('Retry-After');
          const wait = raw === null ? backoffS : Number(raw);
          if (!Number.isFinite(wait)) throw new Error(`unparseable Retry-After: ${raw}`);
          await sleep(wait);
          continue;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} from ${endpoint}`);
        const body = await r.arrayBuffer();
        await cache.put(kind, cacheKey, ext, body);
        if (courtesySleepS) await sleep(courtesySleepS);
        return body;
      } catch (exc) {
        // Any transport error means "try the next mirror".
        last = exc instanceof Error ? exc : new Error(String(exc));
        if (attempt < attemptsPerEndpoint) await sleep(backoffS);
      }
    }
  }
  throw new Error(`all endpoints failed for ${kind}: ${last ? last.message : 'no response'}`);
}

// ── the feed zip ─────────────────────────────────────────────────────────────

/**
 * Read the GTFS feed as an ArrayBuffer from either of the two browser input modes.
 *
 *   * A `File` (or `Blob`) picked from disk — read directly. No network, no cache:
 *     the bytes are already local, and caching them would only duplicate them.
 *   * A URL string — fetched with the same cache-first / retry policy as
 *     `httpFetch` (`kind: 'gtfs'`, the URL itself as the cache key), but streamed
 *     so `onProgress` can report bytes received. Feeds are tens of megabytes and a
 *     silent download reads as a hang.
 *
 * CORS: many transit agencies serve their GTFS zip with NO `Access-Control-Allow-Origin`
 * header. The browser then refuses to hand us the response no matter what we do, and
 * there is nothing the user can change on their end — so the failure is surfaced as a
 * plain-English instruction to download the zip and upload it instead, not as a
 * network error the user will read as our bug.
 *
 * @param {File|Blob|string} source
 * @param {import('./cache.js').Cache} cache
 * @param {(received: number, total: number|null) => void} [onProgress]
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchFeedZip(source, cache, onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : () => {};

  // ── local file ──
  if (typeof source !== 'string') {
    if (!source || typeof source.arrayBuffer !== 'function') {
      throw new Error('feed source is neither a URL string nor a File');
    }
    const total = typeof source.size === 'number' ? source.size : null;
    report(0, total);
    const buf = await source.arrayBuffer();
    report(buf.byteLength, total === null ? buf.byteLength : total);
    return buf;
  }

  // ── URL ──
  const url = source;
  const hit = await cache.get('gtfs', url, 'zip');
  if (hit !== null) {
    report(hit.byteLength, hit.byteLength);
    return hit;
  }
  cache.requireOnline(url.slice(0, 120));

  /** @type {Error|null} */
  let last = null;
  for (let attempt = 1; attempt <= HTTP_ATTEMPTS_PER_ENDPOINT; attempt++) {
    try {
      const r = await fetchWithTimeout(url, { method: 'GET' }, HTTP_TIMEOUT_S);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);

      const declared = Number(r.headers.get('Content-Length'));
      const total = Number.isFinite(declared) && declared > 0 ? declared : null;

      let body;
      if (r.body && typeof r.body.getReader === 'function') {
        const reader = r.body.getReader();
        /** @type {Uint8Array[]} */
        const chunks = [];
        let received = 0;
        report(0, total);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
          report(received, total);
        }
        const out = new Uint8Array(received);
        let at = 0;
        for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
        body = out.buffer;
      } else {
        // No streaming body available (some environments); fall back to one read.
        body = await r.arrayBuffer();
        report(body.byteLength, total === null ? body.byteLength : total);
      }

      await cache.put('gtfs', url, 'zip', body);
      return body;
    } catch (exc) {
      last = exc instanceof Error ? exc : new Error(String(exc));
      if (attempt < HTTP_ATTEMPTS_PER_ENDPOINT) await sleep(HTTP_BACKOFF_S);
    }
  }

  const detail = last ? last.message : 'no response';
  throw new Error(
    `Could not download the GTFS feed from ${url} (${detail}). `
    + 'Many transit agencies do not send the CORS headers a browser requires, and no '
    + 'setting on your side can change that. Download the .zip yourself and choose it '
    + 'with the file picker instead.',
  );
}
