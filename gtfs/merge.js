/**
 * gtfs/merge.js — table-level merge of several GTFS feeds into one `Feed`.
 *
 * Runs **inside the Web Worker**: no DOM, no `window`, no `document`.
 *
 * The landing page lets a reader pick more than one operator — a metro plus its
 * commuter rail, two neighbouring systems a polygon happened to cross. Downstream
 * nothing changes: `worker.js` hands the rest of the pipeline one `Feed`, and the
 * S1/S2/S3 layers cannot tell a merged feed from a single one.
 *
 * ── the identity rule ───────────────────────────────────────────────────────────
 *
 *     mergeFeeds([f]) === f          // reference equality, no copy, nothing touched
 *
 * This is the property the harness's 19 golden numbers rest on, and it is deliberate
 * structure rather than a hopeful optimisation: a single-source run cannot drift
 * because on that path this module does nothing at all. Do not "tidy" the fast path
 * away — `tools/smoke.mjs` asserts it with a literal `===`.
 *
 * ── ids are namespaced ALWAYS, not on collision ────────────────────────────────
 *
 * Every id column of every feed grows a `f0:` / `f1:` … prefix, in merge order,
 * whether or not anything actually collided. An id whose spelling depends on which
 * *other* feed you happened to pick is a trap for the exclude-stop and start-stop
 * options and for anyone reading a stop id off the page; `f1:1` is ugly and honest.
 * The tag is a plain ordinal rather than a provider slug because a slug needs its
 * own collision rule and stops being stable the moment the selection changes —
 * §09's provenance rows say which `f{i}` is which.
 *
 * Merge order is content-addressed — sorted by `(sha256, source, input index)` — so
 * the merged feed is a pure function of the feed bytes: independent of which
 * download finished first, of the main thread's own sort key, and of which source
 * failed and was dropped.
 *
 * ── what is kept ───────────────────────────────────────────────────────────────
 *
 * An allowlist of twelve tables (`MERGE_TABLES`), never a denylist: a GTFS extension
 * table nobody here has heard of carries un-namespaced ids, and dropping it is the
 * only way to be sure one cannot leak through. Two of the twelve are special —
 * `fare_attributes` carries the PRIMARY feed's rows only (the house rule quotes one
 * operator's fare, and concatenating would quote it as the merged system's), and
 * `feed_info` is a single synthesised row carrying the merged window.
 *
 * ── what merging cannot fix ────────────────────────────────────────────────────
 *
 * Mixed timezones warn and never refuse: `Feed.timezone` is display-only
 * (CONTRACT.md §(b)) and every time in the pipeline is feed-local seconds since
 * midnight, so a mixed-zone merge is wrong about exactly one thing — the clock
 * alignment of a ride *between* the two systems — which the report already knows how
 * to say out loud.
 *
 * Cross-feed connectivity is free and needs no `transfers.txt` row: `s1Footpaths`
 * (`gtfs/service.js`) builds footpaths geometrically from stop proximity, so two
 * agencies whose stops sit 40 m apart connect on their own.
 *
 * ── determinism ────────────────────────────────────────────────────────────────
 * No clock, no randomness, every `Map`/object sorted before it is iterated anywhere
 * the result can reach output. Merging the same feeds in a different argument order
 * produces the same bytes.
 */

import { cmpStr, sha256Text } from '../lib/core.js';
import { StopTimes, attachStopTimes, stopTimesOf } from './feed.js';

/** `String(x).trim()`, tolerating null/undefined the way the loader does. */
const cell = (row, key) => String(row[key] ?? '').trim();

/**
 * The twelve tables a merged feed keeps, sorted. Everything else in the archive —
 * `pathways`, `levels`, `areas`, `fare_rules`, `route_patterns`, the operator
 * extensions — is dropped, because nothing downstream reads it and every one of them
 * carries ids this module does not know how to namespace.
 * @type {ReadonlyArray<string>}
 */
export const MERGE_TABLES = Object.freeze([
  'agency', 'calendar', 'calendar_dates', 'fare_attributes', 'feed_info',
  'frequencies', 'routes', 'shapes', 'stop_times', 'stops', 'transfers', 'trips',
]);

/**
 * Which columns carry an id, per table. Anything not listed here is copied through
 * untouched.
 *
 * `fare_attributes` and `feed_info` are listed with no columns on purpose: they are
 * in `MERGE_TABLES` but are not concatenated, and an empty list says so rather than
 * leaving a reader to wonder whether they were forgotten.
 * @type {Readonly<Object<string, ReadonlyArray<string>>>}
 */
export const NAMESPACED_COLUMNS = Object.freeze({
  agency: Object.freeze(['agency_id']),
  calendar: Object.freeze(['service_id']),
  calendar_dates: Object.freeze(['service_id']),
  fare_attributes: Object.freeze([]),
  feed_info: Object.freeze([]),
  frequencies: Object.freeze(['trip_id']),
  routes: Object.freeze(['route_id', 'agency_id']),
  shapes: Object.freeze(['shape_id']),
  stop_times: Object.freeze(['trip_id', 'stop_id']),
  stops: Object.freeze(['stop_id', 'parent_station']),
  transfers: Object.freeze([
    'from_stop_id', 'to_stop_id', 'from_trip_id', 'to_trip_id',
    'from_route_id', 'to_route_id',
  ]),
  trips: Object.freeze(['trip_id', 'route_id', 'service_id', 'shape_id', 'block_id']),
});

/** The tables that are concatenated row-for-row, in `MERGE_TABLES` order. */
const CONCAT_TABLES = Object.freeze(
  MERGE_TABLES.filter((t) => t !== 'stop_times' && t !== 'fare_attributes' && t !== 'feed_info'),
);

/**
 * Merge order and each feed's namespace tag.
 *
 * The comparator is **total**: `sha256` first, then the source label, then the input
 * index. The tie-breaks are not decoration — merging a feed with itself (which the
 * smoke harness does) gives two feeds with equal hashes, and a comparator that
 * returned 0 there would make the tags depend on the engine's sort.
 *
 * @param {Object[]} feeds
 * @returns {Array<{feed: Object, index: number, tag: string}>}
 */
export function mergeOrder(feeds) {
  return feeds
    .map((feed, index) => ({ feed, index }))
    .sort((a, b) => cmpStr(a.feed.sha256, b.feed.sha256)
      || cmpStr(String(a.feed.source || ''), String(b.feed.source || ''))
      || (a.index - b.index))
    .map((row, i) => ({ feed: row.feed, index: row.index, tag: `f${i}` }));
}

/**
 * One clone-safe `FeedSourceRow` per input feed, in merge order (CONTRACT.md §(b)).
 *
 * This is what §09 prints so a merged report names every file it read: a run that
 * prints one hash for three feeds is lying about what it analysed.
 *
 * @param {Array<{feed: Object, index: number, tag: string}>} order from `mergeOrder`
 * @param {Array<{label?: string, mdbId?: string|null}>|null} [srcs]
 *        the main thread's own metadata, indexed as the `feeds` array was
 * @returns {Object[]} `FeedSourceRow[]`
 */
export function feedSourceRows(order, srcs = null) {
  return order.map(({ feed, index, tag }) => {
    const meta = (srcs && srcs[index]) || null;
    const label = (meta && meta.label) || String(feed.source || '');
    const mdbId = meta && meta.mdbId !== undefined && meta.mdbId !== null
      ? String(meta.mdbId) : null;
    return {
      tag,
      label,
      source: String(feed.source || ''),
      sha256: String(feed.sha256 || ''),
      mdbId,
      agencyName: String(feed.agencyName || ''),
      agencyUrl: String(feed.agencyUrl || ''),
      timezone: String(feed.timezone || ''),
      feedStart: String(feed.feedStart || ''),
      feedEnd: String(feed.feedEnd || ''),
      feedVersion: String(feed.feedVersion || ''),
      stops: Object.keys(feed.stops || {}).length,
      routes: Object.keys(feed.routes || {}).length,
      trips: ((feed.tables && feed.tables.trips) || []).length,
    };
  });
}

/**
 * How many colons the prefix needs.
 *
 * If any feed already spells an id `f0:something` — because it was merged once
 * before, or because an operator genuinely uses that pattern — one more colon is
 * added to **every** tag, uniformly, until nothing matches. Uniform escalation keeps
 * the scheme a pure function of the input set instead of a per-feed accident.
 */
function prefixDepth(feeds) {
  let depth = 1;
  const clashes = (sep) => {
    const re = new RegExp(`^f\\d+${sep}`);
    for (const feed of feeds) {
      for (const table of CONCAT_TABLES) {
        const cols = NAMESPACED_COLUMNS[table];
        if (!cols.length) continue;
        for (const row of ((feed.tables && feed.tables[table]) || [])) {
          for (const col of cols) {
            const v = cell(row, col);
            if (v && re.test(v)) return true;
          }
        }
      }
      // stop_times is checked through its interning tables, which hold every
      // distinct id exactly once — never through the row view.
      const st = stopTimesOf(feed);
      if (st) {
        for (const id of st.tripIds) if (re.test(id)) return true;
        for (const id of st.stopIds) if (re.test(id)) return true;
      }
    }
    return false;
  };
  // The first probe is the cheap one; escalation past `::` has never been observed
  // and the loop is bounded so a pathological feed cannot spin here.
  while (depth < 8 && clashes(':'.repeat(depth))) depth++;
  return depth;
}

/**
 * What a blank `agency_id` in this feed means, once namespaced.
 *
 * A feed that declares exactly one agency may legally omit `agency_id` from
 * `agency.txt`, from `routes.txt`, or from both, and every route still belongs to
 * that agency. Merged, blanks on either side would join every operator's routes to
 * every other operator's agency row, so both sides are filled with the same value:
 * the agency's own namespaced id, or the bare tag when it has none.
 *
 * A feed with several agencies and a blank `agency_id` is malformed GTFS; there is
 * no honest value to invent, so the blank is left alone.
 */
function blankAgencyId(feed, tag, pfx) {
  const rows = (feed.tables && feed.tables.agency) || [];
  if (rows.length !== 1) return '';
  const id = cell(rows[0], 'agency_id');
  return id ? pfx + id : tag;
}

/**
 * Copy one row with its id columns prefixed.
 *
 * A blank id stays blank — a blank `parent_station` means "no parent", not "the
 * parent whose id is the empty string". The two exceptions are agency ids, handled
 * by the caller through `blankAgency`: a single-agency feed legally omits
 * `agency_id` everywhere, and leaving those blank on a merge would silently join
 * every operator's routes to every other operator's agency row.
 */
function nsRow(row, cols, pfx, blankAgency) {
  const out = {};
  for (const key of Object.keys(row)) out[key] = row[key];
  for (const col of cols) {
    const v = cell(row, col);
    if (v) out[col] = pfx + v;
    else if (blankAgency && col === 'agency_id') out[col] = blankAgency;
  }
  return out;
}

/**
 * Merge a list of loaded feeds into one `Feed`.
 *
 * Called **before** `normaliseTimes`, so `frequencies.txt` expansion runs once over
 * already-namespaced trip ids.
 *
 * @param {Object[]} feeds one or more `Feed`s from `loadFeed`
 * @param {{onNote?: (message: string) => void}} [opts]
 *        `onNote` receives degradation text (CONTRACT.md §(f)) — mixed timezones, a
 *        short or empty window. It is never an error path.
 * @returns {Promise<Object>} a `Feed` (CONTRACT.md §(b))
 */
export async function mergeFeeds(feeds, opts = {}) {
  const list = Array.from(feeds || []);
  if (!list.length) throw new Error('mergeFeeds needs at least one feed');
  // THE identity rule. Nothing below runs for a single source — see the header.
  if (list.length === 1) return list[0];

  const onNote = typeof opts.onNote === 'function' ? opts.onNote : () => {};
  const ordered = mergeOrder(list);
  const n = ordered.length;
  const sep = ':'.repeat(prefixDepth(list));

  // ── the primary feed ──────────────────────────────────────────────────────
  // The one that runs the most trips; ties fall to merge order, which is content
  // addressed. It supplies the timezone, the fare table, the publisher and the
  // agency name the hero prints.
  let primaryAt = 0;
  const tripsOf = (f) => ((f.tables && f.tables.trips) || []).length;
  for (let i = 1; i < n; i++) {
    if (tripsOf(ordered[i].feed) > tripsOf(ordered[primaryAt].feed)) primaryAt = i;
  }
  const primary = ordered[primaryAt].feed;

  // ── the twelve tables ─────────────────────────────────────────────────────
  const tables = {};
  for (const table of CONCAT_TABLES) {
    const cols = NAMESPACED_COLUMNS[table];
    let rows = null;
    for (const { feed, tag } of ordered) {
      const src = (feed.tables && feed.tables[table]) || null;
      if (!src || !src.length) continue;
      if (rows === null) rows = [];
      const pfx = tag + sep;
      const blankAgency = blankAgencyId(feed, tag, pfx);
      for (const row of src) rows.push(nsRow(row, cols, pfx, blankAgency));
    }
    if (rows !== null) tables[table] = rows;
  }

  // Every operator credited, in a stable order, so `buildProvenance` lists them all.
  if (tables.agency) {
    tables.agency.sort((a, b) => cmpStr(cell(a, 'agency_name'), cell(b, 'agency_name'))
      || cmpStr(cell(a, 'agency_id'), cell(b, 'agency_id')));
  }

  // The fare house rule prints `fare_attributes[0]`'s price as THE fare for the map,
  // so exactly ONE feed's table is carried — concatenating would quote whichever
  // operator sorted first as if its fare covered every system.
  //
  // The primary feed supplies it when it has one. When it does not, the first feed in
  // merge order that HAS fares supplies it instead: a big operator that ships no
  // `fare_attributes.txt` merged with a small neighbour that does is the commonest
  // shape of merge (MBTA has none, The Rapid has one), and taking the primary's empty
  // table would silently delete a recommendation the small city produces on its own.
  // `fareAgency` records who is being quoted, so the sentence can name them; it is
  // set on the merged path only, so a single-feed report is unchanged.
  let fareFeed = null;
  const faresOf = (f) => ((f.tables && f.tables.fare_attributes) || []);
  if (faresOf(primary).length) {
    fareFeed = primary;
  } else {
    for (const { feed } of ordered) {
      if (faresOf(feed).length) { fareFeed = feed; break; }
    }
  }
  if (fareFeed) tables.fare_attributes = faresOf(fareFeed).map((row) => ({ ...row }));

  // ── the window ────────────────────────────────────────────────────────────
  // Intersection, because `dayTypes` picks a representative date by trip count over
  // the window: a union would happily land on a date one feed runs nothing on.
  const starts = ordered.map(({ feed }) => String(feed.feedStart || ''));
  const ends = ordered.map(({ feed }) => String(feed.feedEnd || ''));
  const maxStart = starts.slice().sort(cmpStr)[n - 1];
  const minEnd = ends.slice().sort(cmpStr)[0];
  const minStart = starts.slice().sort(cmpStr)[0];
  const maxEnd = ends.slice().sort(cmpStr)[n - 1];
  const windows = ordered
    .map(({ feed, tag }) => `${tag} ${feed.agencyName} ${feed.feedStart}–${feed.feedEnd}`)
    .join('; ');

  let mergedStart = maxStart;
  let mergedEnd = minEnd;
  if (maxStart > minEnd) {
    mergedStart = minStart;
    mergedEnd = maxEnd;
    onNote(`These feeds cover no dates in common (${windows}), so the analysis runs `
      + `over ${minStart}–${maxEnd} instead. On any single date at least one of them `
      + 'contributes no service, which makes the busier system look like the whole map.');
  } else if (dayCount(mergedStart, mergedEnd) < 7) {
    onNote(`These feeds overlap for fewer than seven days (${mergedStart}–${mergedEnd}, `
      + `from ${windows}), so the representative days are chosen from a very short `
      + 'window and may not describe an ordinary week.');
  }

  // ── timezones ─────────────────────────────────────────────────────────────
  // Warn, never refuse: `Feed.timezone` is display-only and every time downstream is
  // feed-local seconds since midnight. What is genuinely wrong in a mixed-zone merge
  // is the clock alignment of a ride between the two systems, and that is a sentence
  // the report can say.
  const zones = Array.from(new Set(ordered.map(({ feed }) => String(feed.timezone || ''))))
    .filter((z) => z).sort(cmpStr);
  if (zones.length > 1) {
    onNote(`These feeds are in different time zones (${zones.join(', ')} — ${windows}). `
      + 'Every departure below is in its own feed\'s local time, so a journey that '
      + 'changes system assumes the two clocks agree, and any ride time crossing that '
      + 'boundary is out by the offset between them.');
  }

  // ── one synthesised feed_info row ─────────────────────────────────────────
  // Nothing reads `feed_info` after loading, but `_s1WindowDates` over merged tables
  // would otherwise recover the UNION of the calendars — the exact trap the
  // intersection above exists to close.
  tables.feed_info = [{
    feed_start_date: mergedStart,
    feed_end_date: mergedEnd,
    feed_version: '',
    feed_publisher_name: '',
  }];

  // ── the typed views ───────────────────────────────────────────────────────
  // Rebuilt by walking each feed's EXISTING `stops` / `routes` maps in sorted-key
  // order, never re-derived from `tables.stops`: re-running the `location_type`
  // filter here would be a second implementation of a rule that already has one.
  const stops = {};
  const routes = {};
  for (const { feed, tag } of ordered) {
    const pfx = tag + sep;
    for (const sid of Object.keys(feed.stops).sort(cmpStr)) {
      const s = feed.stops[sid];
      stops[pfx + sid] = {
        ...s,
        stopId: pfx + s.stopId,
        parentStation: s.parentStation ? pfx + s.parentStation : '',
      };
    }
    for (const rid of Object.keys(feed.routes).sort(cmpStr)) {
      const r = feed.routes[rid];
      routes[pfx + rid] = { ...r, routeId: pfx + r.routeId };
    }
  }

  // ── stop_times, columnar ──────────────────────────────────────────────────
  // Never through `rowAt()` / the Proxy view: that allocates a dict per row, which is
  // ~2.4 M allocations for a big-city pair. Each feed's interning tables are remapped
  // once per DISTINCT id, then the rows are copied in one typed pass.
  //
  // Padding, and what the merge does NOT change: `tripRows` (gtfs/feed.js) keys on
  // the interned `trip_id` exactly as the file spells it — no `.strip()` — which
  // preserves a real padding mismatch some feeds ship. The two halves of the merge
  // treat that padding differently — the concatenated tables go through `nsRow`,
  // which trims via `cell()` before prefixing (`' XT1'` → `'f1:XT1'`), while the ids interned here
  // are prefixed raw (`' XT1'` → `'f1: XT1'`). So the mismatch is carried through
  // unchanged rather than healed: a trip whose two spellings differed before the
  // merge still differs after it, exactly as on the single-feed path. That is the
  // safe outcome, and the trim in `nsRow` is load-bearing — do not remove it.
  const out = new StopTimes();
  if (ordered.some(({ feed }) => stopTimesOf(feed).hasDist)) out.enableDist();
  for (const { feed, tag } of ordered) {
    const st = stopTimesOf(feed);
    const pfx = tag + sep;
    const tripRemap = new Uint32Array(st.tripIds.length);
    for (let k = 0; k < st.tripIds.length; k++) tripRemap[k] = out.internTrip(pfx + st.tripIds[k]);
    const stopRemap = new Uint32Array(st.stopIds.length);
    for (let k = 0; k < st.stopIds.length; k++) stopRemap[k] = out.internStop(pfx + st.stopIds[k]);
    out.appendFrom(st, tripRemap, stopRemap);
  }
  out.compact();

  // ── identity ──────────────────────────────────────────────────────────────
  const sha256 = await sha256Text(
    ordered.map(({ feed, tag }) => `${tag}:${feed.sha256}`).join('\n'),
  );

  const merged = {
    source: ordered.map(({ feed }) => feed.source).join(' + '),
    sha256,
    tables,
    stops,
    routes,
    // `report.place` falls back to this until the `provenance` stage overwrites it
    // with the resolved place name, so it has to fit in a sentence. The full list is
    // in §09.
    agencyName: `${primary.agencyName} + ${n - 1} more`,
    agencyUrl: primary.agencyUrl,
    timezone: primary.timezone,
    feedStart: mergedStart,
    feedEnd: mergedEnd,
    feedVersion: primary.feedVersion,
    publisher: primary.publisher,
    // Merged runs only: whose fare table `tables.fare_attributes` came from.
    fareAgency: fareFeed ? String(fareFeed.agencyName || '') : '',
  };
  attachStopTimes(merged, out);
  return merged;
}

/** Inclusive day span of two `YYYYMMDD` strings. Calendar arithmetic only — no clock. */
function dayCount(start, end) {
  const toUtc = (d) => Date.UTC(
    Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)),
  );
  if (!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end)) return 0;
  return Math.round((toUtc(end) - toUtc(start)) / 86400000) + 1;
}
