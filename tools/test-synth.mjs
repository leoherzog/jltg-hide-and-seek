#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// tools/test-synth.mjs — the OSM fallback converter, checked without a network
// ═══════════════════════════════════════════════════════════════════════════════
//
// `osm/synth.js` is a pure function from (route relations, ring, asOf) to zip
// bytes, so it is the one piece of the fallback tier that can be proven correct
// from an inline fixture: no world files, no HTTP, no cache. The fixture is a
// small Berlin-shaped system chosen to hit every rule with a hand-checkable
// answer — a loop line (first and last stop are the same node), a plain branch,
// a line whose tail runs out of the border (the Seoul-Line-1 clip case), a
// colour-less tram with a junk `interval` tag, one relation entirely outside the
// ring and one with a single stop inside, plus two stop-node pairs that must
// cluster (same name within 500 m; different names within 100 m).
//
// What is asserted, in order:
//   1  determinism — two runs over fresh fixture copies are byte-identical
//   2  acceptance — the untouched `loadFeed` loads the zip and reports the
//      hand-computed stop/route/trip counts, agency, timezone and window
//   3  clipping — the out-of-border tail is gone, the in-border run survives,
//      and a loop's in-border arc survives even across its list seam
//   4  clustering — merged nodes share one stop_id across relations
//   5  the time rules — every emitted time is H:MM:SS, under the 30-hour day
//      (before AND after frequency expansion), the template anchors at 8:00:00,
//      and each trip's times strictly increase
//   6  frequencies — `normaliseTimes` expands each template into exactly
//      (window ÷ headway) concrete trips, headway from the interval tag when it
//      parses and from the mode default when it does not
//   7  the failure paths — nothing inside the ring, a bad ring, a bad asOf
//
// These are SHAPE assertions on a fixture this file owns, never golden numbers:
// the synthesized feed is not a stable reference and must never grow one.
//
//   node tools/test-synth.mjs [--quiet]

import process from 'node:process';

import {
  synthesizeFeedZip,
  SYNTH_DWELL_S,
  SYNTH_MODE_HEADWAY_S,
  SYNTH_SERVICE_WINDOW_S,
  SYNTH_TEMPLATE_ANCHOR_S,
} from '../osm/synth.js';
import { loadFeed, normaliseTimes, stopTimesOf, unzip } from '../gtfs/feed.js';
import { SERVICE_DAY_SECONDS, hmsToS } from '../lib/core.js';
import { haversineM } from '../lib/geo.js';

const QUIET = process.argv.includes('--quiet');

let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) {
    passed++;
    if (!QUIET) console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}`);
  }
}

function eq(actual, expected, label) {
  ok(Object.is(actual, expected), `${label}: ${JSON.stringify(actual)} `
    + (Object.is(actual, expected) ? '' : `(wanted ${JSON.stringify(expected)})`));
}

// ── the fixture ─────────────────────────────────────────────────────────────────
// Built fresh per call so a determinism check cannot be satisfied by shared
// object identity. Coordinates are Berlin-ish; the ring is a rectangle
// lat 52.35–52.65, lon 13.20–13.65, and every "inside" point is comfortably
// interior so the ray-cast's undefined boundary never decides a test.

const RING = () => [[52.35, 13.20], [52.35, 13.65], [52.65, 13.65], [52.65, 13.20]];

const stop = (nodeId, name, lat, lon) => ({ nodeId, name, nameEn: null, lat, lon });
const tags = (extra) => ({
  name: null, nameEn: null, ref: null, colour: null, operator: null,
  network: null, route: null, interval: null, duration: null, ...extra,
});

function fixture() {
  // r100 — the loop: five stop slots over four nodes, first === last.
  const loopStops = [
    stop(1, 'Westkreuz', 52.500, 13.300),
    stop(2, 'Nordkreuz', 52.520, 13.320),
    stop(3, 'Ostkreuz', 52.500, 13.340),
    stop(4, 'Südkreuz', 52.480, 13.320),
    stop(1, 'Westkreuz', 52.500, 13.300),
  ];
  // r200 — the branch. Its 'Hauptbahnhof' node must cluster with r300's (same
  // name, ~130 m apart), and its 'Zoologischer Garten' with r300's differently
  // named node ~65 m away.
  const branchStops = [
    stop(10, 'Hauptbahnhof', 52.525, 13.369),
    stop(11, 'Zoologischer Garten', 52.507, 13.332),
    stop(12, 'Charlottenburg', 52.505, 13.303),
    stop(13, 'Spandau', 52.535, 13.220),
  ];
  // r300 — the out-of-border tail: five stops inside, then three marching south
  // out of the ring. The maximal contiguous in-ring run is stops 0–4.
  const tailStops = [
    stop(20, 'Hauptbahnhof', 52.526, 13.370),
    stop(21, 'U Zoologischer Garten', 52.5075, 13.3325),
    stop(22, 'Rathaus Steglitz', 52.457, 13.322),
    stop(23, 'Lichterfelde', 52.433, 13.307),
    stop(24, 'Teltow', 52.402, 13.270),
    stop(25, 'Outside A', 52.300, 13.250),
    stop(26, 'Outside B', 52.250, 13.240),
    stop(27, 'Outside C', 52.200, 13.230),
  ];
  // r400 — the colour-less tram; its interval tag is the wiki's 'irregular',
  // which must fall through to the tram default.
  const tramStops = [
    stop(30, 'Alexanderplatz', 52.522, 13.413),
    stop(31, 'Landsberger Allee', 52.529, 13.455),
    stop(32, 'Marzahn', 52.545, 13.510),
    stop(33, 'Ahrensfelde', 52.571, 13.565),
  ];
  const line = (stops) => [stops.map((s) => [s.lat, s.lon])];

  return [
    {
      osmId: 100,
      tags: tags({ name: 'Ringbahn', ref: 'S41', colour: '#A23B72', network: 'BVG', route: 'subway' }),
      lines: line(loopStops),
      stops: loopStops,
    },
    {
      osmId: 200,
      tags: tags({
        name: 'RE1: Brandenburg – Berlin', ref: 'RE1', colour: 'red',
        network: 'DB Regio', route: 'train', interval: '01:00',
      }),
      lines: line(branchStops),
      stops: branchStops,
    },
    {
      osmId: 300,
      tags: tags({ name: 'U9', ref: 'U9', network: 'BVG', route: 'subway', interval: '10' }),
      lines: line(tailStops),
      stops: tailStops,
    },
    {
      osmId: 400,
      tags: tags({ name: 'Tram 68', ref: '68', network: 'BVG', route: 'tram', interval: 'irregular' }),
      lines: line(tramStops),
      stops: tramStops,
    },
    {
      osmId: 500,
      tags: tags({ name: 'Elsewhere', ref: 'E1', network: 'DVB', route: 'tram' }),
      lines: [[[51.000, 13.000], [51.010, 13.020]]],
      stops: [stop(50, 'Far Away', 51.000, 13.000), stop(51, 'Farther', 51.010, 13.020)],
    },
    {
      osmId: 600,
      tags: tags({ name: 'One Toe In', ref: 'X1', network: 'BVG', route: 'subway' }),
      lines: [[[52.500, 13.500], [52.700, 13.700], [52.720, 13.720]]],
      stops: [
        stop(40, 'Edge', 52.500, 13.500),
        stop(41, 'Out One', 52.700, 13.700),
        stop(42, 'Out Two', 52.720, 13.720),
      ],
    },
  ];
}

// Hand-computed expectations. 17 distinct in-border nodes minus the two cluster
// merges (20→10, 21→11) is 15 stops; relations 500 and 600 are dropped, so
// 4 routes and 4 template trips survive out of 6 considered.
const EXPECT_STOPS = 15;
const EXPECT_ROUTES = 4;
const WINDOW_SPAN_S = SYNTH_SERVICE_WINDOW_S[1] - SYNTH_SERVICE_WINDOW_S[0];
const EXPECT_HEADWAYS = {
  t100: SYNTH_MODE_HEADWAY_S.subway,  // no interval tag → subway default
  t200: 3600,                         // interval '01:00' → one hour
  t300: 600,                          // interval '10' → ten minutes
  t400: SYNTH_MODE_HEADWAY_S.tram,    // interval 'irregular' → tram default
};
const EXPECT_TEMPLATE_ROWS = { t100: 5, t200: 4, t300: 5, t400: 4 };

/** Every member's text, decoded — stored entries only, so no DecompressionStream. */
async function zipTexts(zipBytes) {
  const out = {};
  for (const entry of await unzip(zipBytes)) {
    const dec = new TextDecoder('utf-8');
    let text = '';
    for await (const chunk of entry.stream()) text += dec.decode(chunk, { stream: true });
    out[entry.basename] = text + dec.decode();
  }
  return out;
}

/** `trip_id → arrival seconds in stop_sequence order` from the columnar store. */
function tripTimes(feed) {
  const st = stopTimesOf(feed);
  const byTrip = new Map();
  for (let i = 0; i < st.length; i++) {
    const tid = st.tripId(i);
    let rows = byTrip.get(tid);
    if (rows === undefined) { rows = []; byTrip.set(tid, rows); }
    rows.push(i);
  }
  const out = new Map();
  for (const [tid, rows] of byTrip) {
    rows.sort((a, b) => st.seqv[a] - st.seqv[b]);
    out.set(tid, rows.map((i) => ({ stopId: st.stopId(i), arrival: st.arrival(i) })));
  }
  return out;
}

async function main() {
  // ── 1 · determinism ──────────────────────────────────────────────────────────
  const first = synthesizeFeedZip({ routes: fixture(), ring: RING() });
  const second = synthesizeFeedZip({ routes: fixture(), ring: RING() });
  ok(first.zip instanceof Uint8Array && first.zip.length > 0, 'zip is a non-empty Uint8Array');
  ok(first.zip.length === second.zip.length
    && first.zip.every((b, i) => b === second.zip[i]), 'two runs are byte-identical');
  ok(Array.isArray(first.notes) && first.notes.length > 0
    && first.notes.every((n) => typeof n === 'string'), 'notes is a non-empty string array');
  ok(first.notes[0].includes('6 OSM route relations considered')
    && first.notes[0].includes('4 synthesized'), 'the counts note says 6 considered, 4 kept');

  // ── 2 · loadFeed accepts the bytes ───────────────────────────────────────────
  const feed = await loadFeed(first.zip, null);
  eq(Object.keys(feed.stops).length, EXPECT_STOPS, 'stops after clustering');
  eq(Object.keys(feed.routes).length, EXPECT_ROUTES, 'routes');
  eq(feed.tables.trips.length, EXPECT_ROUTES, 'template trips (one per relation)');
  eq(feed.tables.frequencies.length, EXPECT_ROUTES, 'frequencies rows (one per trip)');
  eq(feed.agencyName, 'BVG', 'agency named by the majority network tag');
  eq(feed.timezone, 'Etc/GMT-1', 'timezone derived from longitude (POSIX sign)');
  eq(feed.feedStart, '20300527', 'no asOf → window starts the fallback week\'s Monday');
  eq(feed.feedEnd, '20300609', 'window runs 14 days');
  const cal = feed.tables.calendar[0];
  ok(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    .every((d) => cal[d] === '1'), 'all seven days are active');

  eq(feed.routes.r100.color, 'A23B72', 'hex colour tag survives, hash stripped');
  eq(feed.routes.r200.color, 'FF0000', 'CSS colour name resolves');
  eq(feed.routes.r400.color, '', 'colour-less tram omits route_color');
  eq(feed.routes.r100.routeType, 1, 'subway → route_type 1');
  eq(feed.routes.r200.routeType, 2, 'train → route_type 2');
  eq(feed.routes.r400.routeType, 0, 'tram → route_type 0');
  ok(feed.routes.r100.isRail && feed.routes.r200.isRail && feed.routes.r400.isRail,
    'every synthesized mode is rail-family');

  // ── 3 · clipping ─────────────────────────────────────────────────────────────
  ok(!('n25' in feed.stops) && !('n26' in feed.stops) && !('n27' in feed.stops),
    'the out-of-border tail is clipped away');
  ok(!('n40' in feed.stops) && !('n50' in feed.stops),
    'dropped relations contribute no stops');
  ok('n24' in feed.stops, 'the last in-border stop of the clipped line survives');

  // ── 3b · a loop clipped across its list seam ─────────────────────────────────
  // The Ringbahn case: the border covers an arc that crosses the relation's
  // arbitrary list origin. The maximal contiguous run is circular — it wraps the
  // seam — and a linear reading would keep only the longer fragment and silently
  // drop in-border stations.
  const seamStops = [
    stop(61, 'Loop North', 52.550, 13.400),
    stop(62, 'Loop North-East', 52.525, 13.450),
    stop(63, 'Loop South-East', 52.475, 13.450),
    stop(64, 'Loop South', 52.450, 13.400),
    stop(65, 'Loop South-West', 52.475, 13.350),
    stop(66, 'Loop North-West', 52.525, 13.350),
    stop(61, 'Loop North', 52.550, 13.400),
  ];
  const seam = synthesizeFeedZip({
    routes: [{
      osmId: 700,
      tags: tags({ name: 'Seam Loop', ref: 'SL', network: 'BVG', route: 'subway' }),
      lines: [seamStops.map((s) => [s.lat, s.lon])],
      stops: seamStops,
    }],
    // Covers the northern arc only: n66 → n61 → n62, wrapping the list seam at n61.
    ring: [[52.50, 13.30], [52.50, 13.50], [52.60, 13.50], [52.60, 13.30]],
  });
  const seamFeed = await loadFeed(seam.zip, null);
  ok('n66' in seamFeed.stops && 'n61' in seamFeed.stops && 'n62' in seamFeed.stops,
    'a loop\'s in-border arc survives across the list seam');
  ok(!('n63' in seamFeed.stops) && !('n64' in seamFeed.stops) && !('n65' in seamFeed.stops),
    'the out-of-border arc of the loop is clipped away');
  const seamRows = tripTimes(seamFeed).get('t700');
  ok(seamRows.length === 3 && seamRows[0].stopId === 'n66' && seamRows[1].stopId === 'n61'
    && seamRows[2].stopId === 'n62', 'the wrapped run rides n66 → n61 → n62 in travel order');
  ok(seamRows[1].arrival > seamRows[0].arrival && seamRows[2].arrival > seamRows[1].arrival,
    'the wrapped run\'s times still strictly increase');
  ok(seam.notes[1].startsWith('3 stops clipped away'),
    'the clip note counts only the stops actually outside the border');

  // ── 4 · clustering ───────────────────────────────────────────────────────────
  ok('n10' in feed.stops && !('n20' in feed.stops),
    'same-name nodes within 500 m merge under the lowest node id');
  ok('n11' in feed.stops && !('n21' in feed.stops),
    'differently named nodes within 100 m merge too');
  eq(feed.stops.n11.name, 'U Zoologischer Garten',
    'merged stop takes the modal name, ties to the code-point smallest');

  // ── 5 · the time rules, before expansion ─────────────────────────────────────
  const templates = tripTimes(feed);
  for (const [tid, want] of Object.entries(EXPECT_TEMPLATE_ROWS)) {
    eq((templates.get(tid) || []).length, want, `${tid} template stop count`);
  }
  eq(templates.get('t100')[0].arrival, SYNTH_TEMPLATE_ANCHOR_S,
    'template anchors at 8:00:00, never the falsy midnight');
  const loop = templates.get('t100');
  ok(loop[0].stopId === 'n1' && loop[loop.length - 1].stopId === 'n1',
    'the loop line starts and ends at the same stop');
  const u9 = templates.get('t300').map((r) => r.stopId);
  ok(u9[0] === 'n10' && u9[1] === 'n11',
    'the clipped line boards at the cross-relation cluster stops');
  for (const [tid, rows] of templates) {
    let increasing = true;
    for (let i = 1; i < rows.length; i++) {
      if (!(rows[i].arrival > rows[i - 1].arrival)) increasing = false;
    }
    ok(increasing, `${tid} template times strictly increase`);
  }

  const texts = await zipTexts(first.zip);
  const timeFields = [];
  for (const line of texts['stop_times.txt'].trim().split('\n').slice(1)) {
    const cells = line.split(',');
    timeFields.push(cells[1], cells[2]);
  }
  for (const line of texts['frequencies.txt'].trim().split('\n').slice(1)) {
    const cells = line.split(',');
    timeFields.push(cells[1], cells[2]);
  }
  ok(timeFields.every((t) => /^\d+:\d{2}:\d{2}$/.test(t)),
    'every emitted time is H:MM:SS with unpadded hours');
  ok(timeFields.every((t) => hmsToS(t) < SERVICE_DAY_SECONDS),
    'every emitted time is under the 30-hour service day');

  // ── 6 · frequency expansion through the untouched normaliseTimes ─────────────
  const headwayByTrip = {};
  for (const row of feed.tables.frequencies) headwayByTrip[row.trip_id] = Number(row.headway_secs);
  for (const [tid, want] of Object.entries(EXPECT_HEADWAYS)) {
    eq(headwayByTrip[tid], want, `${tid} headway`);
  }

  normaliseTimes(feed);
  let expectTrips = 0;
  let expectRows = 0;
  for (const [tid, headway] of Object.entries(EXPECT_HEADWAYS)) {
    expectTrips += WINDOW_SPAN_S / headway;
    expectRows += (WINDOW_SPAN_S / headway) * EXPECT_TEMPLATE_ROWS[tid];
  }
  eq(feed.tables.trips.length, expectTrips, 'templates expand to window ÷ headway trips');
  eq(stopTimesOf(feed).length, expectRows, 'expanded stop_times row count');
  ok(feed.tables.trips.every((t) => !(t.trip_id in EXPECT_TEMPLATE_ROWS)),
    'the template trips themselves are gone after expansion');

  const st = stopTimesOf(feed);
  let maxTime = -1;
  for (let i = 0; i < st.length; i++) {
    const a = st.arrival(i);
    const d = st.departure(i);
    if (a !== null && a > maxTime) maxTime = a;
    if (d !== null && d > maxTime) maxTime = d;
  }
  ok(maxTime < SERVICE_DAY_SECONDS,
    `expanded times stay under the 30-hour day (max ${maxTime})`);

  // ── the unknown-mode path ────────────────────────────────────────────────────
  // A route value outside the six modes is assumed at the generic constants, and
  // the note must state the numbers actually used — quoted from the note itself
  // here, so the disclosure and the feed cannot drift apart.
  const odd = synthesizeFeedZip({
    routes: [{
      osmId: 800,
      tags: tags({ name: 'Rack', ref: 'RK', network: 'BVG', route: 'rack_railway' }),
      lines: [[[52.500, 13.300], [52.500, 13.440]]],
      stops: [stop(70, 'Rack Base', 52.500, 13.300), stop(71, 'Rack Top', 52.500, 13.440)],
    }],
    ring: RING(),
  });
  const oddFeed = await loadFeed(odd.zip, null);
  eq(oddFeed.routes.r800.routeType, 0, 'unknown mode publishes route_type 0');
  const oddNote = odd.notes.find((n) => n.includes('outside the six rail modes')) || '';
  ok(oddNote !== '', 'an emitted unknown-mode relation is disclosed');
  const notedSpeed = Number((/(\d+(?:\.\d+)?) km\/h/.exec(oddNote) || [])[1]);
  const notedHeadway = Number((/(\d+) s headway/.exec(oddNote) || [])[1]);
  eq(Number(oddFeed.tables.frequencies[0].headway_secs), notedHeadway,
    'the note\'s headway is the headway emitted');
  const oddRows = tripTimes(oddFeed).get('t800');
  const oddDist = haversineM(52.500, 13.300, 52.500, 13.440);
  const oddGap = oddRows[1].arrival - oddRows[0].arrival;
  // ±2 s: the synthesizer measures along its own planar projection, the check
  // along the haversine, and the two may round apart by a second.
  ok(Math.abs(oddGap - (oddDist / (notedSpeed / 3.6) + SYNTH_DWELL_S)) <= 2,
    `the note's speed reproduces the emitted stop_times (gap ${oddGap} s)`);

  // A relation that is DROPPED (here: overrunning the eight-hour template cap on
  // a zigzag ~240 km long) was never treated at all, so it must not be counted
  // into the unknown-mode disclosure.
  const zig = [];
  for (let k = 0; k <= 9; k++) zig.push([k % 2 ? 52.62 : 52.38, 13.25 + k * 0.04]);
  const mixed = synthesizeFeedZip({
    routes: [...fixture(), {
      osmId: 900,
      tags: tags({ name: 'Slow Boat', ref: 'F9', route: 'ferry' }),
      lines: [zig],
      stops: [stop(80, 'Pier West', zig[0][0], zig[0][1]),
        stop(81, 'Pier East', zig[9][0], zig[9][1])],
    }],
    ring: RING(),
  });
  ok(mixed.notes[0].includes('7 OSM route relations considered')
    && mixed.notes[0].includes('1 dropped for overrunning the service day'),
    'the overlong unknown-mode relation is dropped');
  ok(!mixed.notes.some((n) => n.includes('outside the six rail modes')),
    'a dropped relation is not disclosed as treated');
  ok(mixed.notes[2].startsWith('17 OSM stop nodes clustered into 15 stops'),
    'the clustering note counts only clusters the emitted trips serve');

  // ── the asOf rule ────────────────────────────────────────────────────────────
  const dated = synthesizeFeedZip({ routes: fixture(), ring: RING(), asOf: '2030-06-11' });
  const datedFeed = await loadFeed(dated.zip, null);
  eq(datedFeed.feedStart, '20300610', 'asOf (a Tuesday, dashes tolerated) → its Monday');
  eq(datedFeed.feedEnd, '20300623', 'dated window still runs 14 days');
  ok(dated.zip.length !== first.zip.length
    || !dated.zip.every((b, i) => b === first.zip[i]), 'a different asOf changes the bytes');

  // ── 7 · failure paths ────────────────────────────────────────────────────────
  const farRing = [[10.0, 10.0], [10.0, 11.0], [11.0, 11.0], [11.0, 10.0]];
  let threw = null;
  try { synthesizeFeedZip({ routes: fixture(), ring: farRing }); } catch (e) { threw = e; }
  ok(threw !== null && /nothing to synthesize/.test(String(threw && threw.message)),
    'an empty border throws instead of emitting an unloadable zip');
  threw = null;
  try { synthesizeFeedZip({ routes: fixture(), ring: [[1, 2]] }); } catch (e) { threw = e; }
  ok(threw instanceof TypeError, 'a degenerate ring throws a TypeError');
  threw = null;
  try { synthesizeFeedZip({ routes: fixture(), ring: RING(), asOf: 'tomorrow' }); } catch (e) { threw = e; }
  ok(threw !== null, 'a malformed asOf throws');

  console.log(`${failed ? 'FAIL' : 'PASS'}: ${passed} passed, ${failed} failed`);
  return failed ? 1 : 0;
}

process.exitCode = await main();
