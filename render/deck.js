// render/deck.js — §07 The Questions, §08 The Curse Deck, §09 The Receipts, the page
// footer, and the sort/filter/search/paging behaviour of the two deck tables.
//
// Unit and value formatting comes from `./verdict.js`.
//
// Invariants:
// 1. §07 prints every question. The table pages 25 at a time with "All" one click
//    away, and the pager is dropped entirely when every row already fits; the dead
//    list is the useful half of the section.
// 2. §07 prints "fully functional" and "work at all" as two labelled counts. They are
//    different numbers and must never be conflated.
// 3. §08 keeps `remove` (a query returned zero: an instruction) visibly distinct from
//    `player-choice` (no data can settle it: a conversation) — different word, icon,
//    variant and definition entry.
//
// Every renderer takes the partial report app.js has accumulated: a piece the worker
// has not sent is not printed, and an empty section returns '' so app.js drops it and
// its nav entry. Every number goes through one formatter from `../lib/core.js`: no
// `toFixed`, `Math.round` or arithmetic inside a template literal.
//
// @module render/deck

import {
  GENERATOR, VERSION, SEEKER_SAMPLE_CAP, DEGRADE_KIND, cmpStr, num, pct, mins, hhmm,
  prettyDate, fillPct,
} from '../lib/core.js';

import {
  esc, el, voidEl, join, waIcon, waCard, waCallout, waTag, waBadge, waButton, waDetails,
  waScroller, waSwitch, waCopyButton, chip, budgetBar, searchInput, section,
  subhead, provChip, basisChip, degradeChip, factChips, miniMeter, linkChip, iconLabel,
  leadDetail, cardHeader, dataTable, legendRow,
} from './html.js';

import {
  S4_ORDINAL, s4Dist, s4JoinWords, s4Plural, s4LiveQuestions, sortedBy, fnum,
} from './verdict.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Rulebook presentation constants (read, never recomputed)
// ═══════════════════════════════════════════════════════════════════════════════

// Question status → (plain phrase, icon, wa-tag variant, appearance). The one-word
// status always rides in the chip's `title`, in `data-status` (the filter key) and in
// §07's "What these words mean" list, so colour is never the only channel.
//
// These words are this generator's, not the rulebook's (rules/audit.js "THE SIX
// VERDICTS"); nothing on the page may present them as rules.
export const S4_STATUS_TAG = Object.freeze({
  functional: Object.freeze(['works', 'circle-check', 'success', 'accent']),
  weak: Object.freeze(['barely helps', 'circle-half-stroke', 'warning', 'accent']),
  degenerate: Object.freeze(['always the same answer', 'equals', 'neutral', 'filled']),
  dead: Object.freeze(["can't be answered here", 'circle-xmark', 'danger', 'accent']),
  unknown: Object.freeze(['not checked', 'circle-question', 'neutral', 'outlined']),
});

// The statuses in the order the deck degrades, with §07's definition sentence. An
// ordered array so `Object.keys()` integer-key hoisting can never reorder it.
const S4_STATUS_DEF = Object.freeze([
  Object.freeze(['functional', 'It splits the map into groups, so the answer narrows the search.']),
  Object.freeze(['weak', 'It can be asked and answered, but it barely splits the map.']),
  Object.freeze(['degenerate', 'Only one qualifying thing is on the map, so every zone answers '
    + 'identically. It buys the seekers nothing and still pays you a card.']),
  Object.freeze(['dead', 'Nothing on this map can answer it, so it is a wasted draw.']),
  Object.freeze(['unknown', 'It could not be evaluated on this run, so it is excluded from the '
    + 'score rather than guessed at.']),
]);

// The same statuses as a short counting phrase ("7 work · 2 same answer").
export const S4_STATUS_COUNT = Object.freeze({
  functional: 'work',
  weak: 'barely help',
  degenerate: 'same answer',
  dead: 'unanswerable',
  unknown: 'not checked',
});

// The status order every count, chip row and sort key uses: degradation order, not
// alphabetical, and the order `S4_STATUS_DEF` prints.
const S4_STATUS_ORDER = Object.freeze([
  'functional', 'weak', 'degenerate', 'dead', 'unknown',
]);

export const S4_ACTION_TAG = Object.freeze({
  keep: Object.freeze(['leave it in', 'circle-check', 'success', 'accent']),
  warn: Object.freeze(['flag it', 'circle-half-stroke', 'warning', 'accent']),
  remove: Object.freeze(['take it out', 'circle-xmark', 'danger', 'accent']),
  'player-choice': Object.freeze(['your call', 'scale-balanced', 'brand', 'outlined']),
});

// `remove` (a query settled it) and `player-choice` (no query can) must stay apart.
const S4_ACTION_DEF = Object.freeze([
  Object.freeze(['keep', 'The curse works exactly as printed on this map.']),
  Object.freeze(['warn', 'It still works, but it is weaker or stranger here than the rulebook '
    + 'assumes.']),
  Object.freeze(['remove', 'Nothing on this map can satisfy it, so it is a wasted card in the '
    + "hider's hand."]),
  Object.freeze(['player-choice', 'Whether it belongs in the deck is a conversation, not a '
    + 'measurement.']),
]);

const S4_ACTION_ORDER = Object.freeze(['keep', 'warn', 'remove', 'player-choice']);

// Curse tier → (rulebook label, plain phrase, meaning, icon). Rows carry the tier in data-tier; tier-4 prints its chip once above its table.
const S4_TIER_DEF = Object.freeze([
  Object.freeze(['tier 1', 'the rulebook says so',
    'The rulebook itself tells you to take this one out.', 'book']),
  Object.freeze(['tier 2', 'the map decides',
    'It depends on the geography, and this map settles it clearly enough to act on.', 'map']),
  Object.freeze(['tier 3', 'warning only',
    "Weaker or stranger on this map, but never removed on this page's advice.",
    'triangle-exclamation']),
  Object.freeze(['tier 4', 'nothing to do with the map',
    'It is about the deck, the clock or the players, not the geography.', 'clock']),
]);

const S4_CATEGORY_LABEL = Object.freeze({
  matching: 'Matching',
  measuring: 'Measuring',
  radar: 'Radar',
  thermometer: 'Thermometer',
  photo: 'Photo',
  tentacle: 'Tentacle',
});

// Each admin border question and the matching question it shadows.
const S4_ADMIN_TWIN = Object.freeze({
  'measuring.admin_1_border': 'matching.admin_1',
  'measuring.admin_2_border': 'matching.admin_2',
});

// Caveats that hold for one status across a whole category, printed once in §07's words
// list instead of on every row: (category, status, sentence).
const S4_CATEGORY_CAVEATS = Object.freeze([
  Object.freeze(['matching', 'weak', 'The cells are so fine that a random seeker almost never '
    + "shares yours, so the answer is nearly always no. A no eliminates only that seeker's "
    + 'own cell.']),
  Object.freeze(['radar', 'weak',
    'One branch is rare enough that the expected narrowing is small.']),
  Object.freeze(['photo', 'weak', 'Note which branch: the rare answer is the informative one, '
    + 'and “I cannot answer” is a real answer that pays the hider.']),
  Object.freeze(['photo', 'degenerate', 'The photograph itself may still show the seekers '
    + 'something — a landmark, a shadow, a skyline — that no model can score.']),
]);

// `Provenance.adminLevels` keys with the rulebook's ordinal words.
const S4_ADMIN_ORDINALS = Object.freeze([
  Object.freeze(['1', '1st']), Object.freeze(['2', '2nd']),
  Object.freeze(['3', '3rd']), Object.freeze(['4', '4th']),
]);

// The three purchase curses the "no spending" switch toggles together. The rulebook
// names the first two and is silent on the third (rules.md `spending_curse_inconsistency`);
// the page surfaces that rather than resolving it quietly. A sorted Array, not a Set.
const S4_SPENDING_CURSES = Object.freeze([
  'egg_partner', 'impressionable_consumer', 'lemon_phylactery',
]);

/** The page sizes the deck tables can offer. Which of them a table shows is a
 * function of its row total: `s4Pager` drops "50 at a time" at 50 rows or fewer and
 * the whole strip at 25 or fewer. */
const PAGE_SIZES = Object.freeze(['all', '25', '50']);

/** The page size both tables open on, and the fallback when a stored one is gone. */
const DEFAULT_PAGE_SIZE = '25';

/** `DEFAULT_PAGE_SIZE` as a number, for the pager's first-paint count. */
const DEFAULT_PAGE_ROWS = 25;

/** Row totals at or below these need no pager, and no "50 at a time", respectively. */
const PAGER_MIN_ROWS = 25;
const PAGE_SIZE_50_MIN_ROWS = 50;

// ═══════════════════════════════════════════════════════════════════════════════
// Tiny deterministic primitives
// ═══════════════════════════════════════════════════════════════════════════════

/** `collections.Counter(…)` as a plain object. Read it through `count(c, k)`; never iterate it unsorted. */
function counter(items, keyFn) {
  /** @type {Object<string, number>} */
  const out = {};
  for (const item of items) {
    const k = String(keyFn(item));
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/** Returns 0 for an absent key instead of undefined. */
function count(c, k) {
  const v = c[k];
  return typeof v === 'number' ? v : 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Shared markup helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A filter chip row: a `wa-radio-group` of button-appearance radios.
 *
 * Option VALUES are always the one-word terms — `bindFilter` and every row's
 * `data-status` / `data-action` key on them; only the labels are plain English. An
 * option may carry a third element, its icon name.
 *
 * @param {string} groupId @param {string} name
 * @param {ReadonlyArray<[string,string]|[string,string,string]>} options
 * @param {{label: string, value?: string}} opts
 * @returns {string}
 */
function s4ChipGroup(groupId, name, options, opts) {
  const { label, value = '' } = opts;
  if (!options || options.length === 0) return '';
  const radios = options.map((opt) => el(
    'wa-radio',
    join(opt.length > 2 && opt[2] ? waIcon(opt[2]) : '', esc(opt[1])),
    { value: opt[0], appearance: 'button', size: 's' },
  )).join('');
  return el('wa-radio-group', radios, {
    id: groupId,
    name,
    size: 's',
    orientation: 'horizontal',
    label,
    value: value || options[0][0],
    className: 'wa-visually-hidden-label',
  });
}

/**
 * A `<table>` whose rows can carry attributes (the filters need `data-status`). Cells
 * are pre-escaped markup, headers plain text, as in `dataTable`.
 *
 * A header given as `[text, sortKey, sortType]` becomes a real `<button>` with
 * `aria-sort` on its `<th>`, so Enter and Space fire `click` for free. A fourth
 * element is the column's long form: it rides in the `<th>`'s `title` so a short
 * header never has to be truncated to fit.
 *
 * Every `<td>` carries `data-label="<header text>"`, which is what lets the stylesheet
 * turn a row into a card on a narrow screen without a second copy of the markup.
 * `opts.cols` is a `<colgroup>` of CSS widths, one per header.
 *
 * @param {ReadonlyArray<string|[string,string,string]|[string,string,string,string]>} headers
 * @param {ReadonlyArray<[Object, ReadonlyArray<string>]>} rows
 * @param {{tableId?: string, className?: string, cols?: ReadonlyArray<string>}} [opts]
 * @returns {string}
 */
function s4Table(headers, rows, opts = {}) {
  const { tableId = '', className = 'wa-zebra-rows wa-hover-rows', cols = null } = opts;
  const labels = headers.map((h) => (typeof h === 'string' ? h : h[0]));
  const ths = headers.map((h) => {
    if (typeof h === 'string') return el('th', esc(h), { scope: 'col' });
    const [text, sortKey, sortType, longForm] = h;
    const button = waButton(text, {
      icon: 'sort',
      appearance: 'plain',
      size: 's',
      dataSortBtn: true,
      title: `Sort by ${longForm || text}`,
    });
    return el('th', button, {
      scope: 'col',
      dataSortKey: sortKey,
      dataSortType: sortType,
      ariaSort: 'none',
      title: longForm || null,
    });
  }).join('');
  const colgroup = cols
    ? el('colgroup', cols.map((w) => voidEl('col', { style: w ? `width:${w}` : null })).join(''))
    : '';
  const thead = el('thead', el('tr', ths));
  const body = rows.map(([rowAttrs, cells]) => el(
    'tr',
    cells.map((c, i) => el('td', c, { dataLabel: labels[i] || null })).join(''),
    rowAttrs,
  )).join('');
  const table = el('table', colgroup + thead + el('tbody', body), {
    id: tableId || null, className,
  });
  return waScroller(table);
}

/**
 * A `<dl>` of `(mark markup, what it means)`: a list on the page, not a tooltip, because
 * this reader is on a phone. The one-word term rides in the mark's chip `title`.
 *
 * @param {ReadonlyArray<[string,string]>} rows
 * @returns {string}
 */
function s4DefinitionList(rows) {
  const out = rows.map(([markHtml, meaning]) => el('div', join(
    el('dt', markHtml, {
      className: 'wa-cluster wa-gap-2xs wa-align-items-center',
    }),
    el('dd', esc(meaning), { className: 'wa-body-s wa-color-text-quiet', style: 'margin:0' }),
  ), { className: 'wa-stack wa-gap-3xs' }));
  return el('dl', out.join(''), { className: 'wa-grid wa-gap-s', style: '--min-column-size:260px' });
}

/**
 * The paging strip under a deck table, or `''` when the table already fits in one
 * page. Rendered inert: `initDeckTables` owns every string in here after the first
 * paint, and the Previous/Next pair stays `hidden` until it runs.
 *
 * @param {string} pagerId @param {string} tableId @param {number} total
 * @param {string} noun @param {string} groupLabel
 * @returns {string}
 */
function s4Pager(pagerId, tableId, total, noun, groupLabel) {
  // A control that can only ever say "showing all of them" is noise, not a control.
  if (total <= PAGER_MIN_ROWS) return '';
  const options = [
    ['all', `All ${num(total)}`, 'list'],
    ['25', '25 at a time', 'table-list'],
  ];
  if (total > PAGE_SIZE_50_MIN_ROWS) options.push(['50', '50 at a time', 'table-list']);
  const status = el('p', esc(
    `${num(1)}–${num(DEFAULT_PAGE_ROWS)} of ${num(total)} ${s4Plural(total, noun)}`,
  ), {
    className: 'wa-caption-xs wa-color-text-quiet',
    dataRole: 'count',
    role: 'status',
    ariaLive: 'polite',
  });
  const nav = el('div', join(
    waButton('Previous', {
      icon: 'chevron-left', dataRole: 'prev', disabled: true, ariaLabel: 'Previous page',
    }),
    waButton('Next', {
      icon: 'chevron-right', dataRole: 'next', disabled: true, ariaLabel: 'Next page',
    }),
  ), {
    className: 'wa-cluster wa-gap-2xs wa-align-items-center',
    dataRole: 'pagenav',
    hidden: true,
  });
  return el('div', join(
    status,
    el('div', join(
      s4ChipGroup(`${pagerId}-size`, `${pagerId}-size`, options, {
        label: groupLabel, value: DEFAULT_PAGE_SIZE,
      }),
      nav,
    ), { className: 'wa-cluster wa-gap-s wa-align-items-center' }),
  ), {
    className: 'wa-split wa-flex-wrap wa-gap-s',
    id: pagerId,
    dataPagerFor: tableId,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · §07 THE QUESTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A question's status as a plain phrase with its icon. The one-word status survives in
 * the chip's `title` and the row's `data-status`; the `title` says whose word it is,
 * because calling these the rulebook's turned judgement calls into rules.
 *
 * @param {string} status @returns {string}
 */
function s4StatusTag(status) {
  const [plain, icon, variant, appearance] = S4_STATUS_TAG[status]
    || [status, 'circle-question', 'neutral', 'outlined'];
  return chip(plain, icon, {
    variant, appearance, title: `this report's word for this is “${status}”`,
  });
}

/**
 * One card per `report.questionCategories` row: health, status counts, Randomize risk
 * and the wasted draws. '' until the rules stage has sent the categories.
 *
 * @param {Object} report @returns {string}
 */
function s4CategoryCards(report) {
  const cats = report.questionCategories || [];
  if (!cats.length) return '';
  const cards = cats.map((c) => {
    const label = S4_CATEGORY_LABEL[c.category] || String(c.category || '');
    const counts = c.counts || {};
    const health = fnum(c.health);
    const risk = fnum(c.risk);
    const statusChips = S4_STATUS_ORDER.filter((k) => count(counts, k)).map((k) => chip(
      `${num(count(counts, k))} ${S4_STATUS_COUNT[k]}`,
      S4_STATUS_TAG[k][1],
      { variant: S4_STATUS_TAG[k][2], appearance: S4_STATUS_TAG[k][3] },
    )).join('');
    // Four name chips, then `+N more`: N is the length of the sliced remainder, never a
    // subtraction of two counts.
    const goneAll = c.gone || [];
    const hidden = goneAll.slice(4);
    const gone = goneAll.slice(0, 4).map((g) => {
      const [word, icon, variant, appearance] = S4_STATUS_TAG[g.status]
        || ['', 'circle-xmark', 'danger', 'accent'];
      return chip(String(g.label || ''), icon, { variant, appearance, title: word || null });
    }).join('') + (hidden.length ? linkChip('#qtable', `+${num(hidden.length)} more`) : '');
    const head = el('div', join(
      el('div', join(
        el('b', esc(label), { className: 'wa-heading-s' }),
        el('span', esc(`${num(c.n)} questions`), { className: 'wa-caption-xs wa-color-text-quiet' }),
      ), { className: 'wa-cluster wa-gap-xs wa-align-items-baseline' }),
      el('div', join(
        risk !== null && risk > 0 ? chip(`${pct(risk)} Randomize risk`, 'dice', {
          variant: 'danger',
          appearance: 'outlined',
          title: 'chance a Randomize redraw inside this category lands on a wasted draw',
        }) + provChip('B4') : '',
      ), { className: 'wa-cluster wa-gap-2xs wa-align-items-center' }),
    ), { className: 'wa-split wa-flex-wrap wa-gap-xs' });
    return waCard(el('div', join(
      head,
      health !== null ? miniMeter(fillPct(health), esc(`${pct(health)} healthy`), {
        label: `${label} health: ${pct(health)}`,
      }) : '',
      el('div', statusChips + provChip('B1'), {
        className: 'wa-cluster wa-gap-2xs wa-align-items-center',
      }),
      gone ? el('div', join(
        el('b', esc('Wasted draws'), {
          className: 'wa-caption-xs wa-text-uppercase', style: 'color:var(--crit-text)',
        }),
        gone,
      ), { className: 'wa-cluster wa-gap-2xs wa-align-items-center' }) : '',
    ), { className: 'wa-stack wa-gap-2xs' }));
  });
  return el('div', cards.join(''), {
    className: 'wa-grid wa-gap-s', style: '--min-column-size:300px',
  });
}

/**
 * "The questions that break this map" — the greedy map-wide narrowing order.
 *
 * @param {Object} report @returns {string}
 */
function s4Funnel(report) {
  const order = Array.from(report.questionOrder || []);
  const funnel = Array.from(report.questionFunnel || []);
  if (order.length === 0 || funnel.length < 2) return '';

  /** @type {Object<string, Object>} */
  const audits = {};
  for (const q of report.questions || []) audits[q.id] = q;

  const start = funnel[0];
  const end = funnel[funnel.length - 1];
  const items = [];
  for (let i = 0; i < order.length; i += 1) {
    const qid = order[i];
    const remaining = i + 1 < funnel.length ? funnel[i + 1] : end;
    const a = audits[qid];
    const label = a ? a.label : qid;
    const cat = S4_CATEGORY_LABEL[a ? a.category : ''] || '';
    const tags = join(
      cat ? el('span', esc(cat), { className: 'cat-tag' }) : '',
      a && fnum(a.draw) !== null ? waTag(`draw ${num(a.draw)}`) : '',
      a && fnum(a.keep) !== null ? waTag(`keep ${num(a.keep)}`) : '',
      miniMeter(fillPct(remaining, start), esc(`${num(remaining)} zones left`), {
        label: `${num(remaining)} of ${num(start)} zones still in the running`,
      }),
    );
    const mid = el('div', join(
      el('b', esc(label)),
      el('div', tags, { className: 'wa-cluster wa-gap-2xs wa-align-items-center' }),
    ), { className: 'wa-stack wa-gap-3xs' });
    items.push(el('li', mid));
  }

  const method = 'Greedy order: at each step, the question that leaves the smallest average '
    + `group of identical answers across all ${num(start)} zones. It is the seekers' best line `
    + 'of play if they knew nothing about you.';

  return waCard(el('div', join(
    el('ol', items.join(''), { className: 'recs' }),
    el('div', join(
      linkChip('#interp-funnel_reference_seeker', 'Our call', 'scale-balanced', {
        variant: 'warning',
      }),
      waDetails('How this order is picked',
        el('p', esc(method), { className: 'wa-body-s wa-color-text-quiet' }),
        { appearance: 'plain' }),
    ), { className: 'wa-stack wa-gap-2xs' }),
  ), { className: 'wa-stack wa-gap-s' }), {
    headerHtml: cardHeader('How fast this map narrows', {
      caption: `${num(start)} → ${num(end)} zones: what a hider has to survive`,
    }),
  });
}

/**
 * The deck by status in one bar, with "fully functional" and "work at all" as two
 * labelled chips: they differ by the weak pile, and a single "N of M work" headline
 * would hide it. Unchecked questions are the bar's remainder.
 *
 * @param {Object} report @returns {string}
 */
function s4LiveCounts(report) {
  const questions = report.questions || [];
  if (questions.length === 0) return '';
  const total = questions.length;
  const counts = counter(questions, (q) => q.status);
  const functional = count(counts, 'functional');
  const weak = count(counts, 'weak');
  const unknown = count(counts, 'unknown');
  const wasted = count(counts, 'dead') + count(counts, 'degenerate');

  const parts = [
    [functional, 'works', 'success'],
    [weak, 'barely helps', 'warning'],
    [wasted, 'wasted draw', 'danger'],
  ].filter(([n]) => n > 0);
  const bar = budgetBar(
    parts.map(([n, word]) => [num(n), n, `${word} — ${num(n)} of ${num(total)}`]),
    total,
    {
      ariaLabel: `${num(total)} questions: ${parts.map(([n, word]) => `${word} ${num(n)}`).join('; ')}`,
      remainderTip: `not checked ${num(unknown)}`,
      variants: parts.map(([, , variant]) => variant),
    },
  );

  const chips = el('div', join(
    chip(`${num(functional)} work`, 'circle-check', {
      variant: 'success',
      appearance: 'accent',
      title: 'status functional: the answer splits the map',
    }),
    weak ? chip(`${num(weak)} barely help`, 'circle-half-stroke', {
      variant: 'warning',
      appearance: 'accent',
      title: 'status weak: the answer barely splits the map',
    }) : '',
    chip(`${num(wasted)} wasted ${s4Plural(wasted, 'draw')}`, 'circle-xmark', {
      variant: 'danger',
      appearance: 'outlined',
      title: 'status dead or degenerate',
    }),
    unknown ? chip(`${num(unknown)} not checked`, 'circle-question', {
      appearance: 'outlined', title: 'status unknown',
    }) : '',
  ), { className: 'wa-cluster wa-gap-2xs' });

  return el('div', join(subhead(`The ${num(total)} questions, by status`), bar, chips), {
    className: 'wa-stack wa-gap-2xs',
  });
}

/**
 * §07 — the narrowing funnel, category health, the filterable question table, and
 * every question's exact test collected into one appendix at the foot, each one click
 * and one permalink from the row it belongs to.
 *
 * @param {Object} payload — the partial `Report` app.js has accumulated
 * @returns {string}
 */
export function renderQuestions(payload) {
  const report = payload || {};
  const questions = report.questions || [];
  if (questions.length === 0) return '';

  const cards = s4CategoryCards(report);
  const grid = cards ? el('div', join(subhead('How each kind of question holds up'), cards), {
    className: 'wa-stack wa-gap-xs',
  }) : '';

  const geoAvailable = Boolean(report.geo && report.geo.available);
  const funnel = geoAvailable ? s4Funnel(report) : '';

  const osmDown = questions.filter((q) => q.degrade === 'osm_unavailable').length;
  const countryDown = questions.filter((q) => q.degrade === 'country_unresolved').length;
  const degraded = join(
    !geoAvailable && osmDown ? waCallout(join(
      degradeChip('osm_unavailable'),
      esc(` ${num(osmDown)} map ${s4Plural(osmDown, 'question')} not checked.`),
    ), { variant: 'warning' }) : '',
    countryDown ? waCallout(join(
      degradeChip('country_unresolved'),
      esc(` ${num(countryDown)} administrative ${s4Plural(countryDown, 'question')} not checked; `
        + 'levels are never guessed.'),
    ), { variant: 'warning' }) : '',
  );

  // Chip VALUES are the one-word statuses and never change — `bindFilter` keys on
  // them and so does every row's `data-status`. Only the labels are plain.
  const present = S4_STATUS_ORDER.filter((s) => questions.some((q) => q.status === s));
  const options = [['all', `All ${num(questions.length)}`, 'list']];
  for (const s of present) {
    let n = 0;
    for (const q of questions) if (q.status === s) n += 1;
    options.push([s, `${S4_STATUS_TAG[s][0]} · ${num(n)}`, S4_STATUS_TAG[s][1]]);
  }
  const controls = el('div', join(
    s4ChipGroup('qchips', 'qfilter', options, { label: 'Filter questions by status' }),
    searchInput('qsearch', {
      placeholder: 'Search the questions…', label: 'Search the question table',
    }),
  ), {
    className: 'wa-split wa-flex-wrap wa-gap-s', id: 'qcontrols',
  });

  const words = waDetails('What these words mean',
    el('p', esc("This report's words, not the rulebook's."), { className: 'wa-caption-s wa-color-text-quiet' })
    + s4DefinitionList([
      ...S4_STATUS_DEF.map(([key, meaning]) => [s4StatusTag(key), meaning]),
      ...S4_CATEGORY_CAVEATS.map(([cat, key, meaning]) => [
        join(el('span', esc(S4_CATEGORY_LABEL[cat] || cat), { className: 'cat-tag' }),
          s4StatusTag(key)),
        meaning]),
      [el('b', esc('Found on the map')),
        'Qualifying things inside the border; for photo questions, the share of zones that '
        + 'contain the subject.'],
      [el('b', esc('Narrows by')),
        'The information a question carries, normalised inside its own category, '
        + 'so a clean 50/50 split scores 100%.'],
      [el('b', esc('Blends in')),
        'The share of zones that answer this question exactly the way yours does — the '
        + 'higher it is, the more company you have.'],
      [chip('Randomize risk', 'dice', { variant: 'danger', appearance: 'outlined' }),
        'A Randomize redraw stays inside the category; this is the chance it lands on a '
        + "question that can't be answered or always answers the same."],
    ]), { appearance: 'plain' });

  /** @type {Object<string, Object>} */
  const byId = {};
  for (const q of questions) byId[q.id] = q;
  const urbanExplorer = (report.curses || []).some((c) => c.id === 'urban_explorer');
  const ordered = sortedBy(questions, (q) => [String(q.category || ''), String(q.id || '')]);
  const rows = [];
  const selectorRows = [];
  for (const q of ordered) {
    const instancesN = fnum(q.instances);
    const coverageN = fnum(q.coverage);
    let instances = instancesN === null ? '—' : num(instancesN);
    if (coverageN !== null) instances = `${pct(coverageN)} of zones`;
    const qualityN = fnum(q.quality);
    const quality = qualityN !== null ? pct(qualityN, 0) : '—';
    const explain = q.explain || null;
    const lead = explain ? String(explain.lead || '') : '';
    const detail = explain ? String(explain.detail || '') : String(q.why || '');
    const extras = [factChips(q.facts), degradeChip(q.degrade)];
    if (q.borderline) {
      const margin = fnum(q.marginCount);
      extras.push(chip(margin !== null ? `borderline · ${num(margin)} just outside` : 'borderline',
        'circle-half-stroke', {
          variant: 'warning', title: 'would change verdict under a modestly larger map',
        }));
    }
    const survN = fnum(q.survMean);
    if (survN !== null) {
      extras.push(chip(`blends in ${pct(survN, 0)}`, '', {
        title: `anonymity ${num(survN, 2, { comma: false })}`,
      }));
    }
    if ((q.status === 'dead' || q.status === 'degenerate')
      && fnum(q.draw) !== null && fnum(q.keep) !== null) {
      extras.push(chip(`draw ${num(q.draw)} · keep ${num(q.keep)}`, 'hand-holding-dollar', {
        variant: 'danger',
      }));
    }
    if (q.interpId) {
      extras.push(linkChip(`#interp-${q.interpId}`, 'Our call', 'scale-balanced', {
        variant: 'warning',
      }));
    }
    if (q.id === 'matching.transit_line' && urbanExplorer) {
      extras.push(linkChip('#curses', 'lost to Urban Explorer', 'ban', { variant: 'warning' }));
    }
    const twin = S4_ADMIN_TWIN[q.id] ? byId[S4_ADMIN_TWIN[q.id]] : null;
    if (twin && S4_STATUS_TAG[twin.status]) {
      extras.push(chip(`matching twin · ${S4_STATUS_TAG[twin.status][0]}`, 'clone'));
    }
    if (!String(q.selector || '').startsWith('no data needed')) {
      extras.push(linkChip(`#sel-${q.id}`, 'exact test', 'magnifying-glass', {
        appearance: 'outlined', title: 'The exact thing this question was tested against',
      }));
    }
    const why = leadDetail(esc(lead), esc(detail), { chipsHtml: extras.join(''), summary: 'Why' });

    // Sort keys ride on the row so the click handler never re-parses a cell. `found`
    // prefers the instance count and falls back to the coverage share, so that column
    // is only a rough grouping; the printed cell says which quantity it is.
    const statusRank = S4_STATUS_ORDER.indexOf(String(q.status));
    const found = instancesN !== null ? instancesN : (coverageN !== null ? coverageN : -1);
    rows.push([{
      id: `q-${q.id}`,
      dataStatus: q.status,
      dataCat: q.category,
      dataId: q.id,
      dataSortCat: S4_CATEGORY_LABEL[q.category] || String(q.category || ''),
      dataSortLabel: String(q.label || ''),
      dataSortStatus: String(statusRank < 0 ? S4_STATUS_ORDER.length : statusRank),
      dataSortFound: String(found),
      dataSortQuality: String(qualityN === null ? -1 : qualityN),
      dataBasis: q.interpId ? 'interp' : null,
    }, [
      el('span', esc(S4_CATEGORY_LABEL[q.category] || q.category), {
        className: 'cat-tag',
      }),
      el('b', esc(q.label))
        + leadDetail('', esc(q.text), { summary: 'Card text', foldBelow: true }),
      s4StatusTag(q.status),
      el('span', esc(instances), { className: 'wa-text-nowrap' }),
      qualityN !== null
        ? miniMeter(fillPct(qualityN), esc(quality), { label: `Narrows by ${quality}` })
        : el('span', esc(quality), { className: 'wa-text-nowrap' }),
      why,
    ]]);
    selectorRows.push(el('tr', join(
      el('td', esc(S4_CATEGORY_LABEL[q.category] || q.category), {
        className: 'wa-caption-xs wa-color-text-quiet',
      }),
      el('td', el('b', esc(q.label))),
      el('td', el('pre', esc(q.selector))),
    ), { id: `sel-${q.id}` }));
  }

  // Widths are hints, not a layout: the category is a tag and needs almost nothing,
  // and the question is the column a reader scans, so it is the widest.
  const table = s4Table([
    ['Category', 'cat', 'text'],
    ['Question', 'label', 'text'],
    ['Status', 'status', 'num'],
    ['Found on the map', 'found', 'num',
      'Qualifying things inside the border (or share of zones, for photos)'],
    ['Narrows by', 'quality', 'num', 'How much it narrows the search'],
    'Assessment',
  ], rows, {
    tableId: 'qtable',
    cols: ['10%', '24%', '20%', '11%', '10%', '25%'],
  });

  const pager = s4Pager('qpager', 'qtable', questions.length, 'question',
    'How many questions to show at once');

  let tests = '';
  if (selectorRows.length) {
    const head = el('thead', el('tr', el('th', esc('Category'), { scope: 'col' })
      + el('th', esc('Question'), { scope: 'col' })
      + el('th', esc('What was searched for'), { scope: 'col' })));
    tests = waDetails("Every question's exact test (verbatim)",
      waScroller(el('table', head + el('tbody', selectorRows.join('')), {
        className: 'wa-zebra-rows',
      })), { appearance: 'plain' });
  }

  const counts = counter(questions, (q) => q.status);
  const live = s4LiveQuestions(report);
  const title = `${num(live)} of ${num(questions.length)} questions work`;
  const lede = 'Every question in the deck, checked against this map.';
  const wasted = count(counts, 'dead') + count(counts, 'degenerate');
  const answer = el('p', esc(wasted
    ? `Brief everyone on the ${num(wasted)} wasted ${s4Plural(wasted, 'draw')} before you start.`
    : 'No wasted draws on this map.'), { className: 'wa-body-s' });

  const body = el('div', join(
    degraded, funnel, s4LiveCounts(report), grid, controls, words, table, pager, tests,
  ), { className: 'wa-stack wa-gap-l' });
  return section('questions', S4_ORDINAL, title, body, {
    kicker: 'The deck', lede, answerHtml: answer,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · §08 THE CURSE DECK
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A curse's verdict as an instruction, with its icon. `data-action` and the chip's
 * `title` keep the one-word action. `take it out` (a measurement the page defends) and
 * `your call` (an argument it refuses to have for the group) must never read alike.
 *
 * The four actions are this report's vocabulary, not the rulebook's; what the rulebook
 * prescribes is which curses to take out, and tier 1 records that (`S4_TIER_DEF`).
 *
 * @param {string} action @returns {string}
 */
function s4ActionTag(action) {
  const [plain, icon, variant, appearance] = S4_ACTION_TAG[action]
    || [action, 'circle-question', 'neutral', 'outlined'];
  return chip(plain, icon, {
    variant, appearance, title: `this report's word for this is “${action}”`,
  });
}

/**
 * The `(rowAttrs, cells)` pairs for one block of curses.
 *
 * @param {Object} report @param {ReadonlyArray<Object>} curses
 * @param {{compact?: boolean}} [opts] `compact` prints only the name and Why cells
 * @returns {Array<[Object, string[]]>}
 */
function s4CurseRows(report, curses, opts = {}) {
  const { compact = false } = opts;
  const rows = [];
  const ordered = sortedBy(curses, (c) => [
    typeof c.tier === 'number' ? c.tier : 0, String(c.name || ''), String(c.id || ''),
  ]);
  for (const c of ordered) {
    const countN = fnum(c.count);
    const countText = countN === null ? '—' : num(countN);
    let actionCell = s4ActionTag(c.action);
    /** @type {Object<string, *>} */
    const rowAttrs = {
      id: `c-${c.id}`,
      dataAction: c.action,
      dataTier: String(c.tier),
      dataId: c.id,
      dataSortName: String(c.name || ''),
      dataSortAction: String(S4_ACTION_ORDER.indexOf(String(c.action)) < 0
        ? S4_ACTION_ORDER.length : S4_ACTION_ORDER.indexOf(String(c.action))),
      dataSortTier: String(c.tier),
      dataSortCount: String(countN === null ? -1 : countN),
      dataBasis: c.interpId ? 'interp' : null,
    };
    if (S4_SPENDING_CURSES.includes(c.id)) {
      rowAttrs.dataSpending = '1';
      actionCell = el('span', s4ActionTag(c.action), { dataWhen: 'off' })
        + el('span', s4ActionTag('remove'), { dataWhen: 'on', hidden: true });
    }
    const explain = c.explain || null;
    const lead = explain ? String(explain.lead || '') : '';
    const detail = explain ? String(explain.detail || '') : String(c.why || '');
    const chips = join(
      factChips(c.facts),
      degradeChip(c.degrade),
      c.interpId ? linkChip(`#interp-${c.interpId}`, 'Our call', 'scale-balanced', {
        variant: 'warning',
      }) : '',
      c.predicate === 'not map-contingent' ? '' : linkChip(`#pred-${c.id}`, 'deciding test',
        'magnifying-glass', { appearance: 'outlined', title: 'The exact test that decided this' }),
    );
    const why = leadDetail(esc(lead), esc(detail), { chipsHtml: chips, summary: 'Why' });
    if (compact) {
      rows.push([rowAttrs, [el('b', esc(c.name)), why]]);
      continue;
    }
    rows.push([rowAttrs, [
      el('b', esc(c.name)) + el('div', s4TierChips(c.tier), {
        className: 'wa-cluster wa-gap-2xs',
      }),
      actionCell,
      el('span', esc(countText), { className: 'wa-text-nowrap' }),
      why,
    ]]);
  }
  return rows;
}

/**
 * A curse tier as its chip, plus tier 4's standing rule. Tier 3's "never removed" rides
 * in the chip's `title` ("warning only").
 * @param {number} tier @returns {string}
 */
function s4TierChips(tier) {
  const def = S4_TIER_DEF.find(([term]) => term === `tier ${tier}`);
  return join(
    chip(`tier ${num(tier)}`, def ? def[3] : 'circle-question', { title: def ? def[1] : null }),
    tier === 4 ? chip('not map-contingent', 'shuffle') : '',
  );
}

/**
 * The shape of the curses handed in, in one bar. It is drawn over the same rows the
 * table and the filter hold, and its subhead prints that population, so the section's
 * four counts never disagree. Labelled "as printed": it is static and does not follow
 * `#nospend`, because the rows beside that switch already name what it moves. Each
 * segment carries its action's variant so the chips below read as its legend.
 *
 * @param {Object} report @param {ReadonlyArray<Object>} curses @returns {string}
 */
function s4DeckStrip(report, curses) {
  if (!curses || curses.length === 0) return '';
  const shown = counter(curses, (c) => c.action);
  const order = S4_ACTION_ORDER.filter((a) => count(shown, a));
  const total = curses.length;
  const segments = order.map((a) => [
    num(count(shown, a)),
    count(shown, a),
    `${S4_ACTION_TAG[a][0]} — ${num(count(shown, a))} of ${num(total)} `
      + `${s4Plural(total, 'curse')}`,
  ]);
  const spoken = order.map((a) => `${S4_ACTION_TAG[a][0]} ${num(count(shown, a))}`).join('; ');
  const legend = el('div', order.map((a) => chip(
    `${S4_ACTION_TAG[a][0]} · ${num(count(shown, a))}`,
    S4_ACTION_TAG[a][1],
    { variant: S4_ACTION_TAG[a][2], appearance: 'outlined' },
  )).join(''), { className: 'wa-cluster wa-gap-2xs' });
  return el('div', join(
    subhead(`The ${num(total)} curses this map decides, as printed`),
    budgetBar(segments, total, {
      ariaLabel: `${num(total)} curses: ${spoken}`,
      variants: order.map((a) => S4_ACTION_TAG[a][2]),
    }),
    legend,
  ), { className: 'wa-stack wa-gap-2xs' });
}

/**
 * §08 — the curse audit over the tier-1-to-3 curses this map can settle, filterable by
 * action, with the one "no-spending" `wa-switch`
 * that toggles Egg Partner, Impressionable Consumer and Lemon Phylactery together (the
 * rulebook flags the first two and is silent on the third). The deciding predicates
 * are collected into one appendix at the foot; every row links to its own.
 *
 * @param {Object} payload @returns {string}
 */
export function renderCurses(payload) {
  const report = payload || {};
  const curses = report.curses || [];
  if (curses.length === 0) return '';

  const main = curses.filter((c) => c.tier <= 3);
  const tier4 = curses.filter((c) => c.tier >= 4);

  // The heading, strip, filter and answer line count main; chip values stay the one-word actions bindFilter reads.
  const shown = counter(main, (c) => c.action);
  const present = S4_ACTION_ORDER.filter((a) => count(shown, a));
  const options = [['all', `All ${num(main.length)}`, 'list']];
  for (const a of present) {
    options.push([a, `${S4_ACTION_TAG[a][0]} · ${num(count(shown, a))}`, S4_ACTION_TAG[a][1]]);
  }

  const words = waDetails('What these words mean', el('div', join(
    s4DefinitionList(S4_ACTION_DEF.map(([key, meaning]) => [s4ActionTag(key), meaning])),
    s4DefinitionList(S4_TIER_DEF.map(([term, plain, meaning, icon]) => [
      join(chip(term, icon), term === 'tier 1' ? basisChip('rulebook') : '', el('b', esc(plain))),
      meaning])),
  ), { className: 'wa-grid wa-gap-m', style: '--min-column-size:300px' }), { appearance: 'plain' });

  // `words` sits outside #ccontrols, which is `position: sticky`: an open definition
  // list inside it would pin ~500px of glossary over the table.
  const controls = el('div',
    s4ChipGroup('cchips', 'cfilter', options, { label: 'Filter curses by action' }), {
      className: 'wa-split wa-flex-wrap wa-gap-s', id: 'ccontrols',
    });

  const spending = sortedBy(curses.filter((c) => S4_SPENDING_CURSES.includes(c.id)),
    (c) => [String(c.name || '')]);
  let toggle = '';
  if (spending.length) {
    // A name without its "Curse of the" prefix, joined into one sentence per basis.
    const names = (list) => s4JoinWords(list.map((c) => String(c.name || '').replace(/^Curse of the /, '')));
    const byRule = spending.filter((c) => c.tier === 1);
    const byCall = spending.filter((c) => c.tier !== 1);
    const legend = [];
    if (byRule.length) {
      legend.push([basisChip('rulebook'),
        `${names(byRule)} ${byRule.length === 1 ? 'leaves' : 'leave'} the deck when nobody spends.`]);
    }
    if (byCall.length) {
      legend.push([linkChip('#interp-spending_curses_grouped', 'Our call', 'scale-balanced', { variant: 'warning' }),
        `${names(byCall)} also ${byCall.length === 1 ? 'needs' : 'need'} a purchase. The rulebook does not say so.`]);
    }
    toggle = waCallout(el('div', join(
      legendRow(legend, { label: 'Curses that need a purchase' }),
      waSwitch('Nobody spends money during this game', { checked: false, id: 'nospend' }),
    ), { className: 'wa-stack wa-gap-xs' }), { variant: 'neutral', appearance: 'outlined', icon: null });
  }

  const table = s4Table([
    ['Curse', 'name', 'text'],
    ['Action', 'action', 'num'],
    ['Count', 'count', 'num',
      'Qualifying features inside the border; outside does not exist for this game'],
    'Why',
  ], s4CurseRows(report, main), { tableId: 'ctable' });

  const pager = s4Pager('cpager', 'ctable', main.length, 'curse',
    'How many curses to show at once');

  let details = '';
  if (tier4.length) {
    // Action, count and tier are the same on every tier-4 row, so they print once above.
    const constant = tier4.every((c) => c.action === 'keep' && fnum(c.count) === null);
    const strip = el('div', join(
      chip('tier 4', 'clock'),
      chip(S4_TIER_DEF[3][1], 'shuffle'),
      constant ? chip('leave it in', 'circle-check', { variant: 'success', appearance: 'accent' }) : '',
    ), { className: 'wa-cluster wa-gap-2xs' });
    details = waDetails(`${num(tier4.length)} curses that no map can affect`, join(
      strip,
      constant
        ? s4Table(['Curse', 'Why'], s4CurseRows(report, tier4, { compact: true }))
        : s4Table(['Curse', 'Action', 'Count', 'Why'], s4CurseRows(report, tier4)),
    ), { appearance: 'plain', id: 'curses-tier4' });
  }

  const predHead = el('thead', el('tr', el('th', esc('Curse'), { scope: 'col' })
    + el('th', esc('The deciding test'), { scope: 'col' })));
  const predRows = sortedBy(curses, (c) => [
    typeof c.tier === 'number' ? c.tier : 0, String(c.name || ''), String(c.id || ''),
  ]).map((c) => el(
    'tr',
    el('td', el('b', esc(c.name)) + el('span', esc(`tier ${num(c.tier)}`), {
      className: 'wa-caption-xs wa-color-text-quiet', style: 'display:block',
    })) + el('td', el('pre', esc(c.predicate))),
    { id: `pred-${c.id}` },
  )).join('');
  const tests = waDetails("Every curse's deciding test (verbatim)",
    waScroller(el('table', predHead + el('tbody', predRows), { className: 'wa-zebra-rows' })),
    { appearance: 'plain' });

  const title = `${num(count(shown, 'keep'))} of ${num(main.length)} map-dependent curses work `
    + 'as printed here';
  const lede = 'The curses this map decides, checked against its geography and network.';
  const ledeHtml = join(
    chip(`${num(main.length)} map-dependent`, 'map'),
    tier4.length ? linkChip('#curses-tier4', `${num(tier4.length)} not about the map`, 'clock') : '',
    chip(`${num(curses.length)} in the deck`, 'layer-group'),
    linkChip('#interp-in_border_rule', 'Inside the border only',
      'scale-balanced', { variant: 'warning' }),
  );
  const nRemove = count(shown, 'remove');
  const nWarn = count(shown, 'warn');
  const nTalk = count(shown, 'player-choice');
  const answer = el('p', esc(nRemove
    ? `Take ${num(nRemove)} ${s4Plural(nRemove, 'curse')} out of the deck before you start, `
      + `flag ${num(nWarn)} more, and talk about ${num(nTalk)}.`
    : `Nothing to take out. Flag ${num(nWarn)} ${s4Plural(nWarn, 'curse')} and talk about `
      + `${num(nTalk)}.`,
  ), { className: 'wa-body-s' });

  const body = el('div', join(
    s4DeckStrip(report, main), toggle, controls, words, table, pager, details, tests,
  ), { className: 'wa-stack wa-gap-l' });
  return section('curses', S4_ORDINAL, title, body, {
    kicker: 'The curse deck', lede, ledeHtml, answerHtml: answer,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · §09 WHERE THESE NUMBERS COME FROM
// ═══════════════════════════════════════════════════════════════════════════════

/** Curses the audit says to physically remove. */
function s4RemovedCurses(report) {
  return (report.curses || []).filter((c) => c.action === 'remove');
}

/**
 * A grid of `(anchorId, label, value, valueHtml?)` rows, the provenance spine. A blank
 * `value` suppresses the row, and `s4SourcesIndex` is handed the same list so an index
 * entry can never point at a row that never rendered. `valueHtml` is printed instead of
 * `value` when given.
 *
 * @param {ReadonlyArray<[string,string,string,string?]>} rows @returns {string}
 */
function s4FactRows(rows) {
  const out = [];
  for (const [anchor, label, value, valueHtml] of rows) {
    if (!value) continue;
    out.push(el('div', join(
      el('span', esc(label), { className: 'wa-caption-xs wa-text-uppercase' }),
      valueHtml
        ? el('div', valueHtml, {
          className: 'wa-cluster wa-gap-2xs wa-align-items-center wa-body-s',
          style: 'overflow-wrap:anywhere',
        })
        : el('span', esc(value), { className: 'wa-body-s', style: 'overflow-wrap:anywhere' }),
    ), { className: 'wa-stack wa-gap-3xs', id: anchor ? `prov-${anchor}` : null }));
  }
  return el('div', out.join(''), {
    className: 'wa-grid wa-gap-m', style: '--min-column-size:260px',
  });
}

// The static metric-id pattern `Provenance.interpretations[].affectLinks` classifies by.
const S4_METRIC_ID = /^([A-F]\d|IR\d|[RSEAX]\d)$/;

/**
 * The curse-audit query's `key: selector; key: selector` string as one fold, a
 * captioned `<pre>` per predicate, instead of one ~1,600-character line.
 * @param {string} selector @returns {string}
 */
function s4PredicateFold(selector) {
  const parts = selector.split('; ').map((p) => {
    const i = p.indexOf(': ');
    return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 2)];
  });
  return waDetails(`${num(parts.length)} predicates`, parts.map(([k, sel]) => el('div', join(
    el('b', esc(k.split('_').join(' ')), { className: 'wa-caption-xs' }),
    el('pre', esc(sel), { className: 'prov-sel' }),
  ), { className: 'wa-stack wa-gap-3xs' })).join(''), { appearance: 'plain' });
}

/**
 * One interpretation: its lead is the handle for the folded text, and what it affects
 * stays visible after it. `labels` maps question and curse ids to their names.
 *
 * @param {Object} i a `Provenance.interpretations` row @param {Object<string,string>} labels
 * @returns {string}
 */
function s4InterpRow(i, labels, traceIds = new Set()) {
  const explain = i.explain || null;
  const lead = explain ? String(explain.lead || '') : String(i.text || '');
  const text = explain ? String(explain.detail || '') : '';
  const links = Array.isArray(i.affectLinks)
    ? i.affectLinks
    : (i.affects || []).map((a) => ({ kind: 'text', id: String(a), label: String(a) }));
  // Never a provChip for an id with no `#prov-` target on this page.
  const guideLink = linkChip('#strategy', 'Hider’s guide scoring', 'user-secret');
  const linkHtml = (l) => {
    const name = String(l.label || l.id || '');
    // A hider's-guide metric shares its id with a report metric, so it links to that view.
    if (l.kind === 'guide') return guideLink;
    if (l.kind === 'metric') return traceIds.has(String(l.id)) ? provChip(String(l.id)) : guideLink;
    if (l.kind === 'question') return linkChip('#questions', name, 'circle-question');
    if (l.kind === 'curse') return linkChip('#curses', name, 'wand-magic-sparkles');
    if (l.kind === 'cap') return linkChip('#trace', name, 'lock', { variant: 'warning' });
    if (l.kind === 'text' && name === 'How fast this map narrows') {
      return linkChip('#questions', name, 'filter');
    }
    return waTag(name);
  };
  const affects = Array.from(new Set(links.map(linkHtml))).join('');
  const linkById = new Map(links.map((l) => [String(l.id), l]));
  const groupId = (raw) => {
    const id = String(raw);
    if (linkById.has(id)) return linkHtml(linkById.get(id));
    if (S4_METRIC_ID.test(id)) {
      return traceIds.has(id) ? provChip(id) : guideLink;
    }
    return waTag(labels[id] || id);
  };
  const groups = (i.groups || []).map((g) => el('div', join(
    basisChip(g.basis),
    el('span', esc(String(g.label || '')), { className: 'wa-caption-xs' }),
    Array.from(new Set((g.ids || []).map(groupId))).join(''),
  ), { className: 'wa-cluster wa-gap-2xs wa-align-items-center' })).join('');
  const d = i.data || {};
  const has = (k) => Object.hasOwn(d, k);
  const dataChips = join(
    has('degenerateShare')
      ? chip(`same answer past ${pct(d.degenerateShare, 0)} of diameter`, 'ruler-horizontal') : '',
    has('clusterNameM') ? chip(`same name within ${num(d.clusterNameM)} m`, 'object-group') : '',
    has('clusterAnyM') ? chip(`any name within ${num(d.clusterAnyM)} m`, 'object-group') : '',
    has('serviceStartS') ? chip(`service ${hhmm(d.serviceStartS)}–${hhmm(d.serviceEndS)}`, 'clock') : '',
    has('calendarDays') ? chip(`${num(d.calendarDays)}-day calendar`, 'calendar') : '',
    has('headwayMinMin')
      ? chip(`tagged headway ${num(d.headwayMinMin)}–${num(d.headwayMaxMin)} min`, 'hourglass-half') : '',
    has('dwellS') ? chip(`dwell ${num(d.dwellS)} s per stop`, 'stopwatch') : '',
  );
  const modes = Array.isArray(d.modes) && d.modes.length
    ? dataTable(['Mode', 'Default headway', 'Speed'], d.modes.map((m) => [
      esc(String(m.mode || '')), esc(mins(m.headwayMin)), esc(`${num(m.speedKmh)} km/h`),
    ]))
    : '';
  const quiet = 'wa-caption-xs wa-color-text-quiet';
  let reach = el('span', esc('changes no printed number directly'), { className: quiet });
  if (groups) reach = el('div', groups, { className: 'wa-stack wa-gap-2xs' });
  else if (affects) reach = el('span', esc('affects'), { className: `${quiet} wa-text-uppercase` }) + affects;
  return leadDetail(esc(lead), join(esc(text), modes), {
    inline: true,
    id: `interp-${String(i.id || '')}`,
    dataBasis: 'interp',
    afterHtml: join(reach, dataChips),
  });
}

/**
 * `<ol id="cites">` inside a collapsed disclosure — a named home for every `provChip`
 * target on the page, so a reader arriving from a superscript can see what the anchor
 * is called. Order is the score trace's, then the provenance card's rows, then the
 * Overpass keys as already sorted.
 *
 * @param {Object} report @param {ReadonlyArray<[string,string,string]>} factRows
 * @returns {string}
 */
function s4SourcesIndex(report, factRows) {
  /** @type {Array<[string,string]>} */
  const entries = [];
  const subscores = (report.fitness && report.fitness.subscores) || [];
  if (subscores.length) {
    for (const s of subscores) {
      for (const m of s.metrics || []) entries.push([`prov-${m.id}`, m.name]);
    }
    entries.push(['prov-trace', 'The full score trace']);
  }
  for (const [anchor, label, value] of factRows) {
    if (anchor && value) entries.push([`prov-${anchor}`, label]);
  }
  const overpass = sortedBy((report.provenance && report.provenance.overpass) || [],
    (x) => [String(x.key), String(x.cacheKey)]);
  for (const q of overpass) {
    entries.push([`prov-osm-${q.key}`, `OpenStreetMap query · ${String(q.key).split(/[_-]/).join(' ')}`]);
  }
  if (entries.length === 0) return '';
  const lis = entries.map(([anchor, label]) => el('li',
    el('a', esc(label), { href: `#${anchor}`, className: 'wa-link' }))).join('');
  // Collapsed: it is a lookup table for a reader who arrived from a superscript, and
  // app.js's `openTargeted()` opens an ancestor `wa-details` before it scrolls.
  return waDetails(
    `All ${num(entries.length)} citations`,
    el('ol', lis, { id: 'cites' }),
    { appearance: 'plain' },
  );
}

/**
 * §09 — feed hash and dates, every category selector with its count, the admin ladder,
 * the generator version and arguments, and every interpretation. Nothing is elided or
 * paginated; explanations, machine identifiers and the citation index fold, and app.js's
 * `openTargeted()` opens any disclosure a citation points inside.
 *
 * @param {Object} payload @returns {string}
 */
export function renderProvenance(payload) {
  const report = payload || {};
  const p = report.provenance;
  if (!p) return '';
  const size = report.size || {};
  const feed = report.feed || {};
  const border = report.border || null;
  const hub = report.hub || null;
  const opts = report.opts || {};
  const agencies = p.agencies || [];
  const agencyNames = s4JoinWords(agencies.map((a) => String(a.name || '')));
  const tz = String((agencies.length ? agencies[0].timezone : '') || '');
  // One row per input feed on a merged run; a single feed prints the usual rows.
  const feeds = p.feeds || [];
  const merged = feeds.length > 1;
  // True for the WHOLE run once any source was built from OpenStreetMap: after the
  // merge nothing downstream can tell an invented departure from a published one.
  const assumedSchedule = Boolean(report.metrics && report.metrics.assumedSchedule);

  /** @type {Array<[string,string,string]>} */
  const fingerprintRows = [
    ['', merged ? 'Merged feed sha256' : 'Feed sha256', String(p.feedSha256 || '')],
    ...(merged ? feeds.map((f) => [
      '',
      `Feed sha256 · ${String(f.tag || '')} ${String(f.label || '')}`,
      String(f.sha256 || ''),
    ]) : []),
    ['generator', 'Generator', `${p.generator || GENERATOR} ${p.version || VERSION}`],
    // Printed always so its absence is never ambiguous: `memory` means IndexedDB could
    // not be opened and the cache died with the run.
    ['', 'Cache backend', String(p.cacheBackend || '')],
    // Verbatim: this string *is* the determinism claim.
    ['argv', 'Options', (p.argv || []).map((a) => String(a)).join(' ') || '(none)'],
  ];

  const questions = report.questions || [];
  const curses = report.curses || [];
  let borderline = 0;
  let checked = 0;
  for (const q of questions) {
    if (q.borderline) borderline += 1;
    if (q.status !== 'unknown') checked += 1;
  }
  const codes = Object.values(report.degradationCodes || {});
  const mergeHtml = join(
    ...['merge_no_overlap', 'merge_short_overlap', 'merge_mixed_tz']
      .filter((k) => codes.includes(k)).map((k) => degradeChip(k)),
    ...(codes.includes('merge_mixed_tz')
      ? Array.from(new Set(feeds.map((f) => String(f.timezone || '')).filter((z) => z)))
        .sort(cmpStr).map((z) => waTag(z, { icon: 'clock' }))
      : []),
  );
  // A single feed is named by what the page calls it; the URL or file name it was read
  // from is provenance, so it rides in a copy button rather than standing as the name.
  // A dropped file's label IS its file name, so the agency stands in for it.
  const feedSource = String(p.feedUrl || feed.source || '');
  const feedRow = feeds[0] || {};
  const feedName = String((feedRow.label && feedRow.label !== feedRow.source ? feedRow.label : '')
    || feed.agencyName || feedRow.label || feedSource);
  const feedValue = merged
    ? `${num(feeds.length)} feeds merged, ids namespaced ${feeds.map((f) => `${f.tag}:`).join(' ')}`
    : feedName;
  const feedHtml = merged
    ? (mergeHtml ? join(mergeHtml, el('span', esc(feedValue))) : '')
    : join(el('span', esc(feedName)), feedSource
      ? waCopyButton(feedSource, { label: `Copy ${/^https?:/i.test(feedSource) ? 'feed URL' : 'file name'}` })
      : '');
  // §06 counts the map-dependent curses only (tiers 1–3), so §08 counts the same set.
  const mapCurses = curses.filter((c) => c.tier <= 3);
  const actionCounts = counter(mapCurses, (c) => c.action);
  const bboxText = border
    ? `S ${num(border.bbox[0], 6, { comma: false })}, `
      + `W ${num(border.bbox[1], 6, { comma: false })}, `
      + `N ${num(border.bbox[2], 6, { comma: false })}, `
      + `E ${num(border.bbox[3], 6, { comma: false })}`
    : '';
  // Follows `Border.derivation` (CONTRACT §(b)): a reader-set box is unpadded, and one the
  // in-play filter fell back on was not applied at all.
  let borderChip = '';
  if (border) {
    if (border.derivation === 'option_fallback') {
      borderChip = degradeChip('border_not_applied')
        + linkChip('#interp-map_border_derivation', 'Our call', 'scale-balanced', { variant: 'warning' });
    } else if (border.derivation === 'option') {
      borderChip = waTag('set by you, unpadded', { icon: 'draw-polygon' });
    } else {
      borderChip = waTag(`padded ${s4Dist(report, border.padM, 2)}`, { icon: 'draw-polygon' });
    }
  }

  const sampled = `${num(p.seekerSampleCap || SEEKER_SAMPLE_CAP)} seekers sampled`;
  const funnelK = `${num(p.greedyK || (report.questionOrder || []).length)}-question funnel`;
  const radius = `${s4Dist(report, Number(p.zoneRadiusM || size.zoneRadiusM || 0), 2)} zone radius`;

  /** @type {Array<[string,string,string,string?]>} */
  const factRows = [
    ['feed', merged ? 'The published timetable files' : "The agency's published timetable file",
      feedValue, feedHtml],
    ...(merged ? feeds.map((f) => {
      const value = [String(f.agencyName || ''), String(f.timezone || ''),
        (f.feedStart && f.feedEnd)
          ? `${prettyDate(String(f.feedStart))} – ${prettyDate(String(f.feedEnd))}` : '',
        String(f.source || '')].filter((x) => x).join(' · ');
      return ['', `${String(f.tag || '')} · ${String(f.label || '')}`, value,
        f.synthesized ? join(degradeChip('assumed_schedule'), el('span', esc(value))) : ''];
    }) : []),
    // Blank on an ordinary run (a blank value drops the row); otherwise it sits directly
    // under the file it qualifies.
    ['', 'Timetable', assumedSchedule ? 'Assumed, not published' : '', assumedSchedule ? join(
      degradeChip('assumed_schedule'),
      chip('where: measured', 'route'),
      chip('how often: modelled', 'clock'),
      chip('timetable scores dropped', 'ban'),
      linkChip('#interp-osm_synth_timetable', 'Our call', 'scale-balanced', { variant: 'warning' }),
    ) : ''],
    ['', 'Feed version / publisher',
      [String(p.feedVersion || ''), String(p.publisher || '')].filter((x) => x).join(' · ')],
    ['', 'Feed validity', (p.feedStart && p.feedEnd)
      ? `${prettyDate(String(p.feedStart))} – ${prettyDate(String(p.feedEnd))}` : ''],
    ['', 'Analysis date', p.asOf ? prettyDate(String(p.asOf)) : ''],
    ['', 'Agencies', [agencyNames, tz].filter((x) => x).join(' · ')],
    ['rulebook', 'Game size', size.name
      ? `${String(size.name).toUpperCase()}`
        + `${size.inferred ? ' (inferred)' : ' (set by hand)'} · `
        + `${num(size.hidingPeriodMin)}-minute hiding period · `
        + `${s4Dist(report, size.zoneRadiusM, 2)} zones · `
        + `${num(size.catalogueSize)} questions · ${num(curses.length)} curses`
      : '', size.name ? join(
      waBadge(String(size.name).toUpperCase(), { variant: 'neutral' }),
      waTag(size.inferred ? 'inferred' : 'set by hand', {
        icon: size.inferred ? 'wand-magic-sparkles' : 'hand',
      }),
      waTag(`${num(size.hidingPeriodMin)} min hiding period`, { icon: 'hourglass-half' }),
      waTag(`${s4Dist(report, size.zoneRadiusM, 2)} zones`),
    ) : ''],
    ['border', 'Border', border ? bboxText : '',
      border ? join(borderChip, el('span', esc(bboxText))) : ''],
    ['questions', 'Question audit', questions.length
      ? `${num(questions.length)} questions in the deck, ${num(checked)} checked inside the border` : '',
    questions.length ? join(
      chip(`${num(s4LiveQuestions(report))} of ${num(questions.length)} questions work`, 'list-check',
        { variant: 'brand' }),
      chip(`${num(checked)} checked`, 'list'),
      borderline ? chip(`${num(borderline)} borderline`, 'circle-half-stroke', { variant: 'warning' }) : '',
    ) : ''],
    ['curses', 'Curse audit', curses.length ? `${num(curses.length)} curses checked` : '',
      curses.length ? join(
        chip(`${num(mapCurses.length)} map-dependent`, 'map'),
        ...S4_ACTION_ORDER.filter((a) => count(actionCounts, a)).map((a) => chip(
          `${num(count(actionCounts, a))} ${S4_ACTION_TAG[a][0]}`, S4_ACTION_TAG[a][1],
          { variant: S4_ACTION_TAG[a][2], appearance: 'outlined' },
        )),
      ) : ''],
    ['start', 'Round-start location and departure', hub
      ? `${hub.name} · stop ${opts.startStopId || hub.stopId} · ${String(opts.departure || '').slice(0, 5)}`
      : '', hub ? join(
      el('span', esc(hub.name)),
      waTag(`stop ID ${opts.startStopId || hub.stopId}`, { icon: 'location-dot' }),
      waTag(String(opts.departure || '').slice(0, 5), { icon: 'clock' }),
    ) : ''],
    ['days', 'Representative days', (report.days || [])
      .filter((d) => d && d.dayType && d.dayType.date)
      .map((d) => `${d.dayType.label} ${prettyDate(d.dayType.date)}`).join(' · ')],
    ['scoring', 'Scoring parameters', `${sampled} · ${funnelK} · ${radius}`,
      join(waTag(sampled, { icon: 'users' }), waTag(funnelK, { icon: 'filter' }),
        waTag(radius, { icon: 'circle-dot' }))],
  ];

  const blocks = [waCard(join(
    s4FactRows(factRows),
    waDetails('Build fingerprint', s4FactRows(fingerprintRows), { appearance: 'plain' }),
  ), {
    headerHtml: cardHeader('What this report was built from'),
  })];

  const geo = report.geo || {};
  const overpass = sortedBy(p.overpass || [], (x) => [String(x.key), String(x.cacheKey)]);
  if (overpass.length) {
    const cellM = fnum(geo.densityCellM);
    const partialTip = 'upper bound, or layer unread';
    let partialN = 0;
    const rows = [];
    for (const q of overpass) {
      const c = fnum(q.count);
      // The curse audit is one query of many predicates: no single count, and its
      // selector folds as one labelled block per predicate (a string split, not a parse).
      const curseAudit = q.key === 'curse-audit';
      if (q.partial) partialN += 1;
      const layer = q.layer || null;
      const url = layer ? String(layer.url || '') : '';
      const readFrom = join(
        layer ? waTag(url.slice(url.lastIndexOf('/') + 1), { icon: 'file' }) : '',
        layer ? el('span', esc(`${num(layer.features)} features`), {
          className: 'wa-caption-xs wa-color-text-quiet',
        }) : '',
        q.source === 'density'
          ? chip(cellM !== null ? `grid · ${num(cellM)} m` : 'grid', 'table-cells') : '',
        url ? waCopyButton(url, {
          label: 'Copy file URL', trigger: waButton('URL', { icon: 'copy', appearance: 'plain' }),
        }) : '',
        layer && layer.sha256 ? waCopyButton(String(layer.sha256), {
          label: 'Copy sha256', trigger: waButton('sha256', { icon: 'copy', appearance: 'plain' }),
        }) : '',
        !layer && q.endpoint ? el('span', esc(String(q.endpoint)), {
          className: 'wa-caption-xs wa-color-text-quiet', style: 'overflow-wrap:anywhere',
        }) : '',
      );
      rows.push([{ id: `prov-osm-${q.key}` }, [
        el('b', esc(String(q.key || '').split(/[_-]/).join(' '))),
        el('span', esc(c === null || curseAudit ? '—' : num(c))
          + (q.partial ? ` ${el('abbr', '+', { title: partialTip })}` : ''), {
          className: 'wa-text-nowrap',
        }),
        curseAudit ? s4PredicateFold(String(q.selector || ''))
          : el('pre', esc(String(q.selector || '')), { className: 'prov-sel' }),
        el('div', readFrom, { className: 'wa-cluster wa-gap-2xs wa-align-items-center' }),
      ]]);
    }
    const legend = el('div', join(
      el('span', join(waTag('+'), el('span', esc(partialTip))), {
        className: 'wa-cluster wa-gap-2xs wa-align-items-center wa-caption-xs',
      }),
      waButton('Re-run at overpass-turbo.eu', {
        href: 'https://overpass-turbo.eu', target: '_blank', rel: 'noopener',
        icon: 'arrow-up-right-from-square', appearance: 'plain',
      }),
    ), { className: 'wa-cluster wa-gap-s wa-align-items-center' });
    blocks.push(waCard(join(
      legend,
      s4Table(['Category', 'Count', 'What was searched for', 'Read from'], rows),
    ), {
      headerHtml: cardHeader(`${num(overpass.length)} OpenStreetMap categories`, {
        caption: 'Counted inside the border · selectors verbatim',
        chipsHtml: join(
          geo.snapshot ? chip(`OSM snapshot · ${prettyDate(String(geo.snapshot))}`, 'camera') : '',
          partialN ? waBadge(`${num(partialN)} partial`, { variant: 'warning' }) : '',
        ),
      }),
    }));
  }

  const admin = geo.admin || { countryCode: null, countryName: null, source: 'unknown' };
  const ladder = p.adminLevels || {};
  if (Object.keys(ladder).length || admin.countryCode) {
    const unknown = admin.source === 'unknown';
    const overture = p.adminSource === 'overture';
    // Overture synthesises a level per subtype and those numbers deliberately do NOT mean
    // what OSM's `admin_level` means, so the source has to reach the label.
    const cells = S4_ADMIN_ORDINALS.map(([key, word]) => {
      const level = ladder[key];
      const tag = level === null || level === undefined
        ? chip('none', 'circle-minus')
        : waTag(overture ? `Overture level ${num(level)}` : `OpenStreetMap level ${num(level)}`);
      return el('div', join(
        el('span', esc(word), { className: 'wa-caption-xs wa-text-uppercase' }),
        el('div', tag),
      ), { className: 'wa-stack wa-gap-3xs' });
    }).join('');
    const why = "The rulebook's 1st–4th divisions land on different levels in every country, so "
      + 'the ladder is derived from the division data, never assumed.';
    const body = join(
      unknown ? leadDetail('', esc('The country could not be determined, so the '
        + 'administrative-division questions were marked unknown rather than guessed at, and '
        + "were excluded from the score's denominator."), {
        chipsHtml: degradeChip(geo.available ? 'country_unresolved' : 'osm_unavailable'),
      }) : el('div', cells, { className: 'wa-grid wa-gap-s', style: '--min-column-size:8rem' }),
      waDetails('Why the ladder is derived',
        el('p', esc(why), { className: 'wa-body-s wa-color-text-quiet' }), { appearance: 'plain' }),
    );
    blocks.push(waCard(el('div', body, { className: 'wa-stack wa-gap-s' }), {
      headerHtml: cardHeader('Administrative divisions', {
        chipsHtml: join(
          unknown ? '' : chip(String(admin.countryName || admin.countryCode || ''), 'globe'),
          overture ? chip('Overture Maps', 'layer-group')
            : p.adminSource === 'osm' ? chip('OpenStreetMap', 'map') : '',
        ),
      }),
    }));
  }

  const interps = sortedBy(p.interpretations || [], (x) => [String(x.id)]);
  /** @type {Object<string, string>} */
  const idLabels = {};
  for (const q of questions) idLabels[q.id] = String(q.label || q.id);
  for (const c of curses) idLabels[c.id] = String(c.name || c.id);
  if (interps.length) {
    const applying = interps.filter((i) => i.applies !== false);
    const unused = interps.filter((i) => i.applies === false);
    const traceIds = new Set();
    for (const s of (report.fitness && report.fitness.subscores) || []) {
      for (const m of s.metrics || []) traceIds.add(String(m.id));
    }
    const list = (rows) => el('div', rows.map((i) => s4InterpRow(i, idLabels, traceIds)).join(''), {
      className: 'wa-stack wa-gap-s',
    });
    blocks.push(waCard(el('div', join(
      list(applying),
      unused.length ? el('details', join(
        el('summary', esc(`Not used on this run · ${num(unused.length)}`), { className: 'wa-caption-s' }),
        list(unused),
      ), { className: 'ld-more' }) : '',
    ), { className: 'wa-stack wa-gap-s' }), {
      headerHtml: cardHeader(`${num(applying.length)} interpretations`, {
        chipsHtml: basisChip('interp'),
        caption: 'Not rules. Your group may overrule any.',
      }),
    }));
  }

  // Degradations print in full; only a `limit`-family map note folds behind its chip.
  const noteCodes = geo.noteCodes || {};
  const degradationCodes = report.degradationCodes || {};
  const limitRows = [];
  for (const d of Array.from(new Set(report.degradations || [])).sort(cmpStr)) {
    const code = Object.hasOwn(degradationCodes, d) ? degradationCodes[d] : '';
    limitRows.push(el('li', join(
      code ? degradeChip(code)
        : chip('Part of this report is missing', 'triangle-exclamation', { variant: 'warning' }),
      el('p', esc(d), { className: 'wa-body-s' }),
    ), { className: 'wa-stack wa-gap-3xs' }));
  }
  // Limit notes sharing a code fold behind one chip.
  const limitGroups = new Map();
  for (const n of Array.from(new Set(geo.notes || [])).sort(cmpStr)) {
    const code = Object.hasOwn(noteCodes, n) ? noteCodes[n] : 'osm_note';
    const kind = DEGRADE_KIND[code];
    if (!kind || kind.family === 'limit') {
      if (!limitGroups.has(code)) {
        limitGroups.set(code, []);
        limitRows.push(code);
      }
      limitGroups.get(code).push(n);
    } else {
      limitRows.push(el('li', join(degradeChip(code), el('p', esc(n), { className: 'wa-body-s' })), {
        className: 'wa-stack wa-gap-3xs',
      }));
    }
  }
  for (let i = 0; i < limitRows.length; i++) {
    const notes = limitGroups.get(limitRows[i]);
    if (!notes) continue;
    const code = limitRows[i];
    limitRows[i] = el('li', leadDetail('', notes.map((n) => el('p', esc(n), { className: 'wa-body-s' })).join(''), {
      inline: true,
      chipsHtml: degradeChip(code, { suffix: notes.length > 1 ? `${num(notes.length)} notes` : '' }),
    }), { className: 'wa-stack wa-gap-3xs' });
  }
  const coverage = geo.osmCoverage || {};
  const strong = coverage.strong || [];
  const weakCov = coverage.weak || [];
  const leadOf = (id) => {
    const row = interps.find((i) => i.id === id);
    return row && row.explain && row.explain.lead ? String(row.explain.lead) : id;
  };
  const cluster = 'wa-cluster wa-gap-2xs wa-align-items-center';
  const legend = join(
    strong.length ? el('div', chip('OSM strong', 'circle-check', { variant: 'success' })
      + strong.map((s) => waTag(String(s))).join(''), { className: cluster }) : '',
    weakCov.length ? el('div', chip('OSM incomplete', 'circle-half-stroke', { variant: 'warning' })
      + weakCov.map((s) => waTag(String(s))).join(''), { className: cluster }) : '',
    geo.available ? el('div', join(
      basisChip('interp'),
      linkChip('#interp-legal_spots_are_a_shortlist', leadOf('legal_spots_are_a_shortlist'), 'list-check'),
      linkChip('#interp-osm_is_not_google_maps', leadOf('osm_is_not_google_maps'), 'map'),
    ), { className: cluster }) : '',
  );
  if (limitRows.length || legend) {
    blocks.push(waCard(el('div', join(
      limitRows.length ? el('ul', limitRows.join(''), { className: 'wa-stack wa-gap-xs wa-list-plain' }) : '',
      legend ? el('div', legend, { className: 'wa-stack wa-gap-2xs' }) : '',
    ), { className: 'wa-stack wa-gap-s' }), {
      headerHtml: cardHeader('What this data does not know', {
        caption: 'Limits inherited from the map and feed layers.',
      }),
    }));
  }

  const indexBlock = s4SourcesIndex(report, factRows.concat(fingerprintRows));
  if (indexBlock) {
    blocks.push(waCard(indexBlock, {
      headerHtml: cardHeader('Citations', { caption: 'Where each superscript link lands' }),
    }));
  }

  return section('sources', S4_ORDINAL, 'Where these numbers come from',
    el('div', blocks.join(''), { className: 'wa-stack wa-gap-s' }), {
      kicker: 'Provenance',
      lede: 'Every number above, traced to the query that produced it.',
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · THE FOOTER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The page footer: five figures, the credit list, and a link back to the top. The ids
 * match the shell's skeleton (`#footer-figures`, `#footer-credit`); app.js replaces the
 * whole `<footer>`.
 *
 * @param {Object} payload @returns {string}
 */
export function renderFooter(payload) {
  const report = payload || {};
  const p = report.provenance || {};
  const feed = report.feed || {};
  if (!report.provenance && !feed.agencyName) return '';

  const asOf = String(p.asOf || feed.feedStart || '');
  const dateText = /^\d{8}$/.test(asOf) ? prettyDate(asOf) : '';
  const questions = report.questions || [];
  const stats = [
    [num((report.zones || []).length), 'hiding zones scored'],
    [`${num(s4LiveQuestions(report))} of ${num(questions.length)}`, 'questions work'],
    [num(s4RemovedCurses(report).length), 'curses removed'],
    [num((p.overpass || []).length), 'OpenStreetMap queries'],
    [num((p.interpretations || []).filter((i) => i.applies !== false).length), 'documented interpretations'],
  ];
  const figures = el('div', stats.map(([value, label]) => el('span', join(
    el('b', esc(value), { className: 'wa-heading-s' }),
    el('span', esc(label), { className: 'wa-caption-xs' }),
  ), { className: 'wa-stack wa-gap-3xs' })).join(''), {
    className: 'wa-grid wa-gap-m', style: '--min-column-size:230px', id: 'footer-figures',
  });

  const agency = String(feed.agencyName || '');
  const credits = [
    agency ? ['bus', `${agency} GTFS`
      + ((p.feedStart && p.feedEnd)
        ? ` · valid ${prettyDate(String(p.feedStart))} – ${prettyDate(String(p.feedEnd))}` : '')] : null,
    ['map', 'Map features © OpenStreetMap contributors, ODbL'],
    ['layer-group', p.adminSource === 'overture'
      ? 'Admin divisions: Overture Maps Foundation'
      : 'Admin divisions © OpenStreetMap contributors, ODbL'],
    ['map-location-dot', 'Basemap: OpenFreeMap, OpenMapTiles data'],
    ['book', "Rules from Jet Lag: The Game's Hide+Seek rulebook"],
    dateText ? ['calendar-check', `Analysis date ${dateText}, from the feed's calendar`] : null,
    ['circle-info', 'Scheduled times are estimates. Check live tracking on the day.'],
  ].filter((x) => x);

  const top = el('a', join(waIcon('arrow-up'), esc('Back to top')), {
    href: '#top', className: 'wa-link wa-caption-s wa-cluster wa-gap-2xs',
  });
  return el('footer', el('div', join(
    figures,
    el('ul', credits.map(([icon, text]) => el('li', iconLabel(icon, text, { quiet: false }))).join(''), {
      id: 'footer-credit',
      className: 'wa-cluster wa-gap-s wa-caption-s wa-list-plain',
      role: 'list',
      ariaLabel: 'Credits',
    }),
    top,
  ), { className: 'wa-stack wa-gap-m' }), { slot: 'footer', dataWhen: 'report' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE DECK TABLES — sort, filter, search, paging
// ═══════════════════════════════════════════════════════════════════════════════
//
// Each table's chip filter, search box, no-spending switch, column sorting and page
// size are all live DOM state, but app.js re-renders a whole section whenever a later
// stage lands or the reader switches service day, which discards every element these
// listeners were on. So the state lives in `DECK_STATE`, keyed by table id, and
// `initDeckTables` writes it back into the fresh controls before binding anything.
//
// app.js carries its own copy of `bindFilter` / `bindSearch` / `bindSpending`
// (`PAGE_RUNTIME_JS`), bound to the same elements. Both agree on one rule:
//
//     a row is hidden when its chip filter rejects it, OR when data-match is '0'
//
// app.js writes `data-match` from the search box alone; this module writes it from the
// search box AND the page window, a strict refinement, and both read it live. This
// module listens for app.js's `refilter` event and never dispatches one.
//
// Every control is a real control (`wa-radio-group`, `<input type=search>`,
// `wa-switch`, `wa-button`), so everything is keyboard-operable with no `keydown`
// handler of our own.

/**
 * Per-table interaction state, preserved across every re-render of its section.
 * `search` exists only for a table with a search box (the curses table has none).
 *
 * @type {Object<string, {sortKey: string|null, sortDir: number, filter: string,
 *                        search?: string, pageSize: string, page: number}>}
 */
const DECK_STATE = {
  qtable: {
    sortKey: null, sortDir: 1, filter: 'all', search: '', pageSize: DEFAULT_PAGE_SIZE, page: 0,
  },
  ctable: {
    sortKey: null, sortDir: 1, filter: 'all', pageSize: DEFAULT_PAGE_SIZE, page: 0,
  },
};

/** The no-spending switch is one switch for the whole page, not per table. */
const SPEND_STATE = { on: false };

/** The two tables this module wires, and the controls that drive each. */
const DECK_TABLES = Object.freeze([
  Object.freeze({
    tableId: 'qtable',
    groupId: 'qchips',
    searchId: 'qsearch',
    pagerId: 'qpager',
    filterKey: 'status',
    noun: 'question',
  }),
  Object.freeze({
    tableId: 'ctable',
    groupId: 'cchips',
    searchId: null,
    pagerId: 'cpager',
    filterKey: 'action',
    noun: 'curse',
  }),
]);

/** The last payload `initDeckTables` was handed, for the re-wire observer. */
let lastPayload = null;
/**
 * Table ids whose `refilter` listener is already on `document`. Module state, not a
 * `data-` flag: app.js hands us a new `<table>` on every re-render, so a per-element
 * flag would leak one document listener per day switch.
 * @type {Set<string>}
 */
const REFILTER_BOUND = new Set();
/** The table nodes wired last time, so the observer can tell a re-render from a nudge. */
const lastNodes = { qtable: null, ctable: null };
/** @type {MutationObserver|null} */
let rewireObserver = null;

/** `document.getElementById`, scoped to a container when one is given. */
function find(container, id) {
  if (!id) return null;
  const root = container && container.querySelector ? container : document;
  if (root.getElementById) return root.getElementById(id);
  return root.querySelector(`#${CSS.escape(id)}`) || document.getElementById(id);
}

/** Read one of a row's `data-sort-*` attributes as its declared type. */
function sortValue(row, key, type) {
  const raw = row.getAttribute(`data-sort-${key}`);
  if (type === 'num') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : -Infinity;
  }
  return String(raw === null ? '' : raw).toLowerCase();
}

/** The declared type of a sortable column, or `'text'`. */
function sortTypeOf(table, key) {
  const th = table.querySelector(`th[data-sort-key="${key}"]`);
  return (th && th.getAttribute('data-sort-type')) || 'text';
}

/**
 * Reorder the table body to the stored sort and mirror it into `aria-sort` and the
 * header icons. Document order is stamped as `data-ord` the first time a table is
 * seen, so "no sort" is restorable and every comparison has a deterministic tie-break.
 */
function applySort(table, st) {
  const tbody = table.tBodies[0];
  if (!tbody) return;
  const rows = Array.from(tbody.rows);
  rows.forEach((tr, i) => {
    if (tr.dataset.ord === undefined) tr.dataset.ord = String(i);
  });

  for (const th of table.querySelectorAll('th[data-sort-key]')) {
    const key = th.getAttribute('data-sort-key');
    const active = key === st.sortKey;
    th.setAttribute('aria-sort', active ? (st.sortDir > 0 ? 'ascending' : 'descending') : 'none');
    const icon = th.querySelector('wa-icon[slot="start"]');
    if (icon) icon.setAttribute('name', active ? (st.sortDir > 0 ? 'sort-up' : 'sort-down') : 'sort');
  }

  const key = st.sortKey;
  const type = key ? sortTypeOf(table, key) : 'text';
  const ordered = rows.slice().sort((a, b) => {
    if (key) {
      const x = sortValue(a, key, type);
      const y = sortValue(b, key, type);
      const c = x < y ? -1 : x > y ? 1 : 0;
      if (c !== 0) return c * st.sortDir;
    }
    return Number(a.dataset.ord) - Number(b.dataset.ord);
  });
  // Only touch the DOM when the order actually changed; a no-op reorder on a re-render
  // would restart every row's animation for nothing.
  let same = true;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i] !== ordered[i]) { same = false; break; }
  }
  if (same) return;
  const frag = document.createDocumentFragment();
  for (const tr of ordered) frag.appendChild(tr);
  tbody.appendChild(frag);
}

/**
 * Decide every row's visibility from filter + search + page, and update the pager.
 * `data-match` is the channel shared with app.js's `bindFilter`: '0' means "hidden for
 * a reason other than the chip filter", and the page window is folded into it.
 */
function applyRows(spec) {
  const table = document.getElementById(spec.tableId);
  if (!table || !table.tBodies.length) return;
  const st = DECK_STATE[spec.tableId];
  const group = document.getElementById(spec.groupId);
  const input = spec.searchId ? document.getElementById(spec.searchId) : null;

  // Read the property once upgraded and the attribute before then; falling through to
  // 'all' would drop a restored filter on the paint where WebAwesome has not landed.
  let want = st.filter || 'all';
  if (group) {
    const live = group.value;
    if (live !== undefined && live !== null && live !== '') want = String(live);
    else if (group.hasAttribute('value')) want = group.getAttribute('value');
  }
  st.filter = want;
  let q = st.search || '';
  if (input) {
    q = String(input.value || '').trim().toLowerCase();
    st.search = q;
  }

  const rows = Array.from(table.tBodies[0].rows);
  const passing = [];
  /** @type {Map<Element, boolean>} */
  const filterOk = new Map();
  /** @type {Map<Element, boolean>} */
  const searchOk = new Map();
  for (const tr of rows) {
    const fOk = want === 'all' || tr.dataset[spec.filterKey] === want;
    const sOk = !q || tr.textContent.toLowerCase().includes(q);
    filterOk.set(tr, fOk);
    searchOk.set(tr, sOk);
    if (fOk && sOk) passing.push(tr);
  }

  const size = st.pageSize === 'all' ? Infinity : Number(st.pageSize);
  const total = passing.length;
  const pages = Number.isFinite(size) && size > 0
    ? Math.max(1, Math.ceil(total / size)) : 1;
  if (st.page > pages - 1) st.page = pages - 1;
  if (st.page < 0) st.page = 0;
  const from = Number.isFinite(size) ? st.page * size : 0;
  const to = Number.isFinite(size) ? from + size : total;

  /** @type {Set<Element>} */
  const windowed = new Set();
  for (let i = from; i < to && i < total; i += 1) windowed.add(passing[i]);

  for (const tr of rows) {
    const onPage = windowed.has(tr);
    tr.dataset.match = (searchOk.get(tr) && onPage) ? '1' : '0';
    tr.hidden = !filterOk.get(tr) || !onPage;
  }

  const pager = document.getElementById(spec.pagerId);
  if (!pager) return;
  const shownN = Math.min(to, total) - Math.min(from, total);
  const countEl = pager.querySelector('[data-role="count"]');
  if (countEl) {
    const noun = s4Plural(total, spec.noun);
    if (!Number.isFinite(size)) countEl.textContent = `All ${num(total)} ${noun}`;
    else if (shownN === 0) countEl.textContent = `0 of ${num(total)} ${noun}`;
    else countEl.textContent = `${num(from + 1)}–${num(from + shownN)} of ${num(total)} ${noun}`;
  }
  const nav = pager.querySelector('[data-role="pagenav"]');
  if (nav) nav.hidden = !Number.isFinite(size) || pages < 2;
  const prev = pager.querySelector('[data-role="prev"]');
  if (prev) prev.disabled = st.page <= 0;
  const next = pager.querySelector('[data-role="next"]');
  if (next) next.disabled = st.page >= pages - 1;
}

/**
 * The no-spending switch: Egg Partner, Impressionable Consumer and Lemon Phylactery
 * become `remove` together, and the action filter follows the switch.
 */
function applySpending() {
  const sw = document.getElementById('nospend');
  if (!sw) return;
  const on = SPEND_STATE.on;
  // Attribute and property, for the same upgrade-order reason the radio groups get
  // both: a `wa-switch` that has not upgraded yet only knows about the attribute.
  if (sw.hasAttribute('checked') !== on) sw.toggleAttribute('checked', on);
  if (sw.checked !== on) sw.checked = on;
  for (const node of document.querySelectorAll('#ctable tr[data-spending] [data-when]')) {
    node.hidden = (node.dataset.when === 'on') !== on;
  }
  for (const tr of document.querySelectorAll('#ctable tr[data-spending]')) {
    if (!tr.dataset.baseAction) tr.dataset.baseAction = tr.dataset.action;
    tr.dataset.action = on ? 'remove' : tr.dataset.baseAction;
  }
}

/** Bind `fn` to `event` on `node` exactly once, however many times this is called. */
function bindOnce(node, flag, event, fn) {
  if (!node || node.dataset[flag]) return;
  node.dataset[flag] = '1';
  node.addEventListener(event, fn);
}

/** Wire one table: restore its stored state, then attach every listener it needs. */
function wireTable(container, spec) {
  const table = find(container, spec.tableId) || document.getElementById(spec.tableId);
  if (!table) return;
  const st = DECK_STATE[spec.tableId];

  // A stored filter whose chip no longer exists (a status a later stage re-audited
  // away) falls back to "all" rather than filtering the table down to nothing.
  const group = document.getElementById(spec.groupId);
  if (group) {
    const has = st.filter === 'all'
      || Boolean(group.querySelector(`wa-radio[value="${CSS.escape(st.filter)}"]`));
    if (!has) st.filter = 'all';
    // Attribute first, then property, so the restore does not depend on whether the
    // `wa-radio-group` has upgraded yet.
    if (group.getAttribute('value') !== st.filter) group.setAttribute('value', st.filter);
    if (group.value !== st.filter) group.value = st.filter;
    bindOnce(group, 'deckFilterBound', 'change', () => {
      st.page = 0;
      applyRows(spec);
    });
  }

  const input = spec.searchId ? document.getElementById(spec.searchId) : null;
  if (input) {
    if (input.value !== st.search) input.value = st.search;
    bindOnce(input, 'deckSearchBound', 'input', () => {
      st.page = 0;
      applyRows(spec);
    });
  }

  // One delegated listener per table. The headers are real `wa-button`s, so Enter and
  // Space already produce `click`; there must be no keydown handler here.
  bindOnce(table, 'deckSortBound', 'click', (event) => {
    const th = event.target && event.target.closest
      ? event.target.closest('th[data-sort-key]') : null;
    if (!th || !table.contains(th)) return;
    const key = th.getAttribute('data-sort-key');
    if (st.sortKey === key) st.sortDir = -st.sortDir;
    else { st.sortKey = key; st.sortDir = 1; }
    st.page = 0;
    applySort(table, st);
    applyRows(spec);
  });

  const pager = document.getElementById(spec.pagerId);
  if (pager) {
    const sizeGroup = document.getElementById(`${spec.pagerId}-size`);
    if (sizeGroup) {
      // A stored size whose option this table does not offer (a smaller total dropped
      // "50") falls back to the default rather than paging by a size with no control.
      const offered = PAGE_SIZES.includes(st.pageSize)
        && Boolean(sizeGroup.querySelector(`wa-radio[value="${CSS.escape(st.pageSize)}"]`));
      if (!offered) st.pageSize = DEFAULT_PAGE_SIZE;
      if (sizeGroup.getAttribute('value') !== st.pageSize) {
        sizeGroup.setAttribute('value', st.pageSize);
      }
      if (sizeGroup.value !== st.pageSize) sizeGroup.value = st.pageSize;
      bindOnce(sizeGroup, 'deckSizeBound', 'change', () => {
        st.pageSize = String(sizeGroup.value || DEFAULT_PAGE_SIZE);
        st.page = 0;
        applyRows(spec);
      });
    }
    const prev = pager.querySelector('[data-role="prev"]');
    bindOnce(prev, 'deckPrevBound', 'click', () => {
      if (st.page > 0) st.page -= 1;
      applyRows(spec);
    });
    const next = pager.querySelector('[data-role="next"]');
    bindOnce(next, 'deckNextBound', 'click', () => {
      st.page += 1;
      applyRows(spec);
    });
  }

  // Listen for app.js's `refilter` (dispatched after it rewrites `data-match`) and never
  // dispatch one, so the two filter copies agree without re-entering each other.
  if (!REFILTER_BOUND.has(spec.tableId)) {
    REFILTER_BOUND.add(spec.tableId);
    document.addEventListener('refilter', () => applyRows(spec));
  }

  applySort(table, st);
  applyRows(spec);
  lastNodes[spec.tableId] = table;
}

/**
 * Re-wire automatically after app.js swaps a section's markup. Armed on the first
 * `initDeckTables` call, never at import time. The check is identity: if `#qtable` and
 * `#ctable` are the nodes wired last time, nothing was re-rendered, so the observer's
 * own mutations cost one frame-debounced comparison.
 */
function armRewireObserver() {
  if (rewireObserver || typeof MutationObserver === 'undefined' || !document.body) return;
  let queued = false;
  rewireObserver = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const q = document.getElementById('qtable');
      const c = document.getElementById('ctable');
      if (q === lastNodes.qtable && c === lastNodes.ctable) return;
      initDeckTables(document, lastPayload);
    });
  });
  rewireObserver.observe(document.body, { childList: true, subtree: true });
}

/**
 * The reader's own page sizes while a print override stands, or null.
 * @type {Object<string, string>|null}
 */
let sizeBeforePrint = null;

/**
 * Force both deck tables to one page size, or hand each its own back. Paper takes the
 * whole deck: the page window is a screen affordance, and `applyRows` enforces it with
 * `tr.hidden`, which a print stylesheet must not undo (it would also reveal the rows
 * the reader's own filter excludes).
 *
 * @param {string|null} size — a `PAGE_SIZES` value, or null to restore
 * @returns {void}
 */
export function setDeckPageSize(size) {
  if (size === null) {
    if (!sizeBeforePrint) return;
    for (const spec of DECK_TABLES) {
      DECK_STATE[spec.tableId].pageSize = sizeBeforePrint[spec.tableId];
    }
    sizeBeforePrint = null;
  } else {
    if (!PAGE_SIZES.includes(size)) return;
    if (!sizeBeforePrint) {
      sizeBeforePrint = {};
      for (const spec of DECK_TABLES) {
        sizeBeforePrint[spec.tableId] = DECK_STATE[spec.tableId].pageSize;
      }
    }
    for (const spec of DECK_TABLES) DECK_STATE[spec.tableId].pageSize = size;
  }
  for (const spec of DECK_TABLES) applyRows(spec);
}

/**
 * Wire §07's and §08's tables after their markup has been inserted. Idempotent: every
 * listener is guarded and every apply is a pure function of `DECK_STATE` and the DOM.
 * Safe to call when neither table is on the page yet.
 *
 * @param {ParentNode} [container] — the freshly-inserted subtree, or the document
 * @param {Object} [payload] — the partial `Report`, kept for the re-wire observer
 * @returns {void}
 */
export function initDeckTables(container, payload) {
  if (payload !== undefined && payload !== null) lastPayload = payload;
  const root = container || document;
  for (const spec of DECK_TABLES) wireTable(root, spec);

  const sw = document.getElementById('nospend');
  if (sw) {
    bindOnce(sw, 'deckSpendBound', 'change', () => {
      SPEND_STATE.on = Boolean(sw.checked);
      applySpending();
      applyRows(DECK_TABLES[1]);
    });
    applySpending();
    applyRows(DECK_TABLES[1]);
  }
  armRewireObserver();
}
