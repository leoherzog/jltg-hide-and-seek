// lib/http.js — fetch with caching, retries, mirror failover and courtesy
// sleeps. Port of `http_fetch`, generate.py.
//
// Worker-side module: no DOM. `fetch` and `setTimeout` only. Sleeps affect timing,
// never output; no wall clock is read.
//
// `CacheMiss` is thrown by `cache.requireOnline()`; import it from `./cache.js`.

// ── constants (generate.py) ────────────────────────────────────

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
// Send no header that is not CORS-safelisted, or the preflight fails the fetch.
// The POST body therefore carries `text/plain`; JSON would provoke a preflight.
// Nothing in the tree POSTs today, so this guards a currently-unused path.

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
 * Tries each endpoint in order, `attemptsPerEndpoint` times each, sleeping
 * `HTTP_BACKOFF_S` between attempts and honouring `Retry-After` on 429. The only
 * live caller passes one endpoint, so today the retry does the work.
 *
 * Throws `CacheMiss` in offline mode, or a plain `Error` when every endpoint is
 * exhausted; for `kind: 'gtfs'` that error is worded for the user (see the throw).
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
          // As in the Python, a non-numeric (HTTP-date) Retry-After is a failed attempt.
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
  // Many agencies serve their zip with no `Access-Control-Allow-Origin`, and nothing
  // on the user's side can fix that, so the feed failure is an instruction to upload
  // the zip instead. Every other caller keeps the diagnostic wording.
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
