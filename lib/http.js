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

export const HTTP_TIMEOUT_S = 300.0;
export const HTTP_ATTEMPTS_PER_ENDPOINT = 2;
export const HTTP_BACKOFF_S = 8.0;             // between attempts on the same endpoint

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
// Send no header that is not CORS-safelisted: a preflight `OPTIONS` is not answered
// the way the actual request is, and the fetch fails outright. `User-Agent` and
// `Accept-Encoding` are forbidden names anyway — the browser manages them. The POST
// body below therefore carries `text/plain`; JSON would provoke a preflight. Nothing
// in the tree POSTs today (the Overpass client this was written for is gone), so this
// is a live rule guarding a currently-unused path.

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
 * sleeping `HTTP_BACKOFF_S` between attempts and honouring `Retry-After` on 429. The
 * failover was built for Overpass, which needed it — one measured query only succeeded
 * on its third mirror. The only live caller passes a single-element array, so today it
 * is the retry, not the failover, that does the work.
 *
 * Throws `CacheMiss` in offline mode, or a plain `Error` when every endpoint is
 * exhausted. For `kind: 'gtfs'` that final error is worded for the user rather than
 * for us — see the CORS note at the throw.
 *
 * @param {import('./cache.js').Cache} cache
 * @param {Object} opts
 * @param {string} opts.kind                          cache namespace; only 'gtfs' is used
 * @param {string} opts.cacheKey                      the fully substituted request
 * @param {string} opts.ext
 * @param {ReadonlyArray<string>} opts.endpoints
 * @param {'GET'|'POST'} [opts.method]
 * @param {Object<string,string>|null} [opts.params]
 * @param {string|null} [opts.data]                   POST body
 * @param {number} [opts.courtesySleepS]
 * @param {number} [opts.attemptsPerEndpoint]
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
          const wait = raw === null ? HTTP_BACKOFF_S : Number(raw);
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
        if (attempt < attemptsPerEndpoint) await sleep(HTTP_BACKOFF_S);
      }
    }
  }
  const detail = last ? last.message : 'no response';
  // CORS: many transit agencies serve their GTFS zip with NO `Access-Control-Allow-Origin`
  // header. The browser then refuses to hand us the response no matter what we do, and
  // there is nothing the user can change on their end — so the feed failure is surfaced
  // as a plain-English instruction to download the zip and upload it instead, not as a
  // network error the user will read as our bug. Only the feed has that escape hatch;
  // every other caller keeps the diagnostic wording.
  if (kind === 'gtfs') {
    throw new Error(
      `Could not download the GTFS feed from ${cacheKey} (${detail}). `
      + 'Many transit agencies do not send the CORS headers a browser requires, and no '
      + 'setting on your side can change that. Download the .zip yourself and choose it '
      + 'with the file picker instead.',
    );
  }
  throw new Error(`all endpoints failed for ${kind}: ${detail}`);
}
