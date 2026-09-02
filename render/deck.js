// render/deck.js — §07 The Questions, §08 The Curse Deck, §09 The Receipts, the page
// footer, and the sort/filter/search/paging behaviour of the two deck tables.
//
// Ported from generate.py S4: index_questions, index_curses, index_provenance,
// _s4_footer, _S4_INDEX_JS (bindFilter/bindSearch/bindSpending), plus `_s4_table` and
// `_s4_chip_group`. Unit and value formatting comes from `./verdict.js`.
//
// Invariants:
// 1. §07 prints every question. The paging control defaults to "All" and never hides
//    the tail unasked; the dead list is the useful half of the section.
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
  GENERATOR, VERSION, SEEKER_SAMPLE_CAP, cmpStr, num, pct, prettyDate,
} from '../lib/core.js';

import {
  esc, el, join, waIcon, waCard, waCallout, waTag, waButton, waDetails, waScroller,
  waProgressBar, waSwitch, chip, budgetBar, searchInput, section, subhead, provChip,
} from './html.js';

import {
  S4_ORDINAL, s4Dist, s4JoinWords, s4Plural, s4NaturalCmp, s4LiveQuestions,
  s4CardHeader, sortedBy, fnum,
} from './verdict.js';

// The catalogue is frozen data that imports only `lib/core.js`, so reading `draw` /
// `keep` off it on the main thread is safe. The funnel needs each question's card cost
// and `QuestionAudit` does not carry it.
import { QUESTIONS } from '../rules/catalogue.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Rulebook presentation constants (read, never recomputed)
// ═══════════════════════════════════════════════════════════════════════════════

// Question status → (plain phrase, icon, wa-tag variant, appearance). The one-word
// status always rides in the chip's `title`, in `data-status` (the filter key) and in
// §07's "What these words mean" list, so colour is never the only channel.
//
// These words are this generator's, not the rulebook's (rules/audit.js "THE SIX
// VERDICTS"); nothing on the page may present them as rules.
const S4_STATUS_TAG = Object.freeze({
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

// The same statuses as a counting phrase ("7 work · 3 barely help"): a count needs a verb.
const S4_STATUS_COUNT = Object.freeze({
  functional: 'work',
  weak: 'barely help',
  degenerate: 'always answer the same',
  dead: "can't be answered",
  unknown: 'not checked',
});

// The status order every count, chip row and sort key uses: degradation order, not
// alphabetical, and the order `S4_STATUS_DEF` prints.
const S4_STATUS_ORDER = Object.freeze([
  'functional', 'weak', 'degenerate', 'dead', 'unknown',
]);

const S4_ACTION_TAG = Object.freeze({
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
  Object.freeze(['remove', 'Nothing on this map can satisfy it, so it is a dead card in the '
    + "hider's hand."]),
  Object.freeze(['player-choice', 'Whether it belongs in the deck is a conversation, not a '
    + 'measurement.']),
]);

const S4_ACTION_ORDER = Object.freeze(['keep', 'warn', 'remove', 'player-choice']);

// Curse tier → (rulebook label, plain phrase, meaning). "tier N" stays on every row
// and in `data-tier`.
const S4_TIER_DEF = Object.freeze([
  Object.freeze(['tier 1', 'the rulebook says so',
    'The rulebook itself tells you to take this one out.']),
  Object.freeze(['tier 2', 'the map decides',
    'It depends on the geography, and this map settles it clearly enough to act on.']),
  Object.freeze(['tier 3', 'warning only',
    "Weaker or stranger on this map, but never removed on this page's advice."]),
  Object.freeze(['tier 4', 'nothing to do with the map',
    'It is about the deck, the clock or the players, not the geography.']),
]);

const S4_CATEGORY_LABEL = Object.freeze({
  matching: 'Matching',
  measuring: 'Measuring',
  radar: 'Radar',
  thermometer: 'Thermometer',
  photo: 'Photo',
  tentacle: 'Tentacle',
});

// The order `_s4_question_categories` walks before it appends anything unexpected.
const S4_CATEGORY_ORDER = Object.freeze([
  'matching', 'measuring', 'radar', 'thermometer', 'photo', 'tentacle',
]);

// The three purchase curses the "no spending" switch toggles together. The rulebook
// names the first two and is silent on the third (rules.md `spending_curse_inconsistency`);
// the page surfaces that rather than resolving it quietly. A sorted Array, not a Set.
const S4_SPENDING_CURSES = Object.freeze([
  'egg_partner', 'impressionable_consumer', 'lemon_phylactery',
]);

/** The page sizes the deck tables offer. `'all'` is the default and prints the tail. */
const PAGE_SIZES = Object.freeze(['all', '25', '50']);

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

/** `Counter[k]` — 0 for an absent key, exactly as Python's Counter reads. */
function count(c, k) {
  const v = c[k];
  return typeof v === 'number' ? v : 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Shared markup helpers (generate.py)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A filter chip row: a `wa-radio-group` of button-appearance radios.
 *
 * Option VALUES are always the one-word terms — `bindFilter` and every row's
 * `data-status` / `data-action` key on them; only the labels are plain English. An
 * option may carry a third element, its icon name.
 *
 * (generate.py `_s4_chip_group`.)
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
 * `aria-sort` on its `<th>`, so Enter and Space fire `click` for free.
 *
 * (generate.py `_s4_table`.)
 *
 * @param {ReadonlyArray<string|[string,string,string]>} headers
 * @param {ReadonlyArray<[Object, ReadonlyArray<string>]>} rows
 * @param {{tableId?: string, className?: string}} [opts]
 * @returns {string}
 */
function s4Table(headers, rows, opts = {}) {
  const { tableId = '', className = 'wa-zebra-rows wa-hover-rows' } = opts;
  const ths = headers.map((h) => {
    if (typeof h === 'string') return el('th', esc(h), { scope: 'col' });
    const [text, sortKey, sortType] = h;
    const button = waButton(text, {
      icon: 'sort',
      appearance: 'plain',
      size: 's',
      dataSortBtn: true,
      title: `Sort by ${text}`,
    });
    return el('th', button, {
      scope: 'col', dataSortKey: sortKey, dataSortType: sortType, ariaSort: 'none',
    });
  }).join('');
  const thead = el('thead', el('tr', ths));
  const body = rows.map(([rowAttrs, cells]) => el(
    'tr',
    cells.map((c) => el('td', c)).join(''),
    rowAttrs,
  )).join('');
  const table = el('table', thead + el('tbody', body), {
    id: tableId || null, className,
  });
  return waScroller(table);
}

/**
 * A `<dl>` of `(plain phrase, the precise term, what it means)` — a list on the page,
 * not a tooltip, because this reader is on a phone.
 *
 * (generate.py `_s4_definition_list`.)
 *
 * @param {ReadonlyArray<[string,string,string]>} rows
 * @returns {string}
 */
function s4DefinitionList(rows) {
  const out = [];
  for (const [plain, term, meaning] of rows) {
    out.push(el('dt', join(
      el('b', esc(plain)),
      el('code', esc(term), { className: 'wa-caption-xs' }),
    ), { className: 'wa-cluster wa-gap-2xs wa-align-items-center' }));
    out.push(el('dd', esc(meaning), {
      className: 'wa-body-s wa-color-text-quiet',
      style: 'margin:0 0 var(--wa-space-xs) 0',
    }));
  }
  return el('dl', out.join(''), { className: 'wa-stack wa-gap-3xs' });
}

/**
 * The paging strip under a deck table. Rendered inert: the size group opens on "All"
 * and the Previous/Next pair stays `hidden` until a finite page size is chosen.
 * `initDeckTables` owns every string in here after the first paint.
 *
 * @param {string} pagerId @param {string} tableId @param {number} total
 * @param {string} noun @param {string} groupLabel
 * @returns {string}
 */
function s4Pager(pagerId, tableId, total, noun, groupLabel) {
  const options = [
    ['all', `All ${num(total)}`, 'list'],
    ['25', '25 at a time', 'table-list'],
    ['50', '50 at a time', 'table-list'],
  ];
  const status = el('p', esc(`Showing all ${num(total)} ${s4Plural(total, noun)}.`), {
    className: 'wa-caption-xs wa-color-text-quiet',
    dataRole: 'count',
    role: 'status',
    ariaLive: 'polite',
  });
  const nav = el('div', join(
    waButton('Previous', { icon: 'chevron-left', dataRole: 'prev', disabled: true }),
    el('span', esc('Page 1 of 1'), {
      className: 'wa-caption-xs wa-color-text-quiet wa-text-nowrap', dataRole: 'page',
    }),
    waButton('Next', { icon: 'chevron-right', dataRole: 'next', disabled: true }),
  ), {
    className: 'wa-cluster wa-gap-2xs wa-align-items-center',
    dataRole: 'pagenav',
    hidden: true,
  });
  return el('div', join(
    status,
    el('div', join(
      s4ChipGroup(`${pagerId}-size`, `${pagerId}-size`, options, { label: groupLabel }),
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
 * (generate.py `_s4_status_tag`.)
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
 * Per-category health (pages.md §3.6): `health = (functional + 0.5 · weak) / count`,
 * and `risk` is the share that is dead or degenerate — the chance a Randomize redraw,
 * which stays inside the category, hands the hider a free card.
 *
 * (generate.py `_s4_question_categories`.)
 *
 * @param {Object} report @returns {Array<Object>}
 */
function s4QuestionCategories(report) {
  const questions = report.questions || [];
  const order = Array.from(S4_CATEGORY_ORDER);
  const seen = [];
  for (const q of questions) {
    const c = String(q.category || '');
    if (!order.includes(c) && !seen.includes(c)) seen.push(c);
  }
  order.push(...seen.sort(cmpStr));

  const out = [];
  for (const cat of order) {
    const rows = questions.filter((q) => q.category === cat);
    if (rows.length === 0) continue;
    const counts = counter(rows, (q) => q.status);
    const n = rows.length;
    const health = (count(counts, 'functional') + 0.5 * count(counts, 'weak')) / n;
    const risk = (count(counts, 'dead') + count(counts, 'degenerate')) / n;
    const goneSet = [];
    for (const q of rows) {
      if (q.status !== 'dead' && q.status !== 'degenerate') continue;
      const label = String(q.label || '');
      if (!goneSet.includes(label)) goneSet.push(label);
    }
    out.push({
      category: cat,
      label: S4_CATEGORY_LABEL[cat] || (cat ? cat.charAt(0).toUpperCase() + cat.slice(1) : cat),
      n,
      counts,
      health,
      risk,
      gone: goneSet.sort(s4NaturalCmp),
    });
  }
  return out;
}

/**
 * "The questions that break this map" — the greedy map-wide narrowing order.
 *
 * (generate.py `_s4_funnel`.)
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
  /** @type {Object<string, Object>} */
  const defs = {};
  for (const d of QUESTIONS) defs[d.id] = d;

  const start = funnel[0];
  const items = [];
  for (let i = 0; i < order.length; i += 1) {
    const qid = order[i];
    const remaining = i + 1 < funnel.length ? funnel[i + 1] : funnel[funnel.length - 1];
    const before = i < funnel.length ? funnel[i] : funnel[funnel.length - 1];
    const a = audits[qid];
    const d = defs[qid];
    const label = a ? a.label : qid;
    const cat = S4_CATEGORY_LABEL[a ? a.category : ''] || '';
    const cost = d ? `draw ${num(d.draw)} · keep ${num(d.keep)}` : '';
    const left = el('span', esc(`${num(before)} → ${num(remaining)}`), {
      className: 'wa-text-nowrap wa-heading-xs',
    });
    const share = `${pct(start ? remaining / start : 0.0)} of the map is still in the running `
      + 'with you';
    const mid = el('span', join(
      el('b', esc(label)),
      el('span', esc([cat, cost, share].filter((x) => x).join(' · ')), {
        className: 'wa-caption-xs wa-color-text-quiet', style: 'display:block',
      }),
    ));
    items.push(el('li', mid + left, {
      className: 'wa-split wa-gap-m',
    }));
  }

  // The CLI's caption ends by pointing at the strategy simulator; that clause is
  // dropped here. The rest is the CLI's, word for word.
  const caption = 'Greedy order: at each step, the question that leaves the smallest average '
    + `group of identical answers across all ${num(start)} zones. It is the seekers' best line `
    + 'of play if they knew nothing about you. '
    + `After ${num(order.length)} questions the map narrows from ${num(start)} zones to `
    + `${num(funnel[funnel.length - 1])} — that is what a hider has to survive.`;

  return waCard(el('div', join(
    el('ol', items.join(''), { className: 'recs' }),
    el('p', esc(caption), { className: 'wa-body-s wa-color-text-quiet' }),
  ), { className: 'wa-stack wa-gap-s' }), {
    headerHtml: s4CardHeader(
      'How fast this map narrows',
      `${num(start)} zones down to ${num(funnel[funnel.length - 1])}, one question at a time.`,
    ),
  });
}

/**
 * The two counts, side by side, labelled apart. "Fully functional" and "works at all"
 * differ by the weak pile — askable, answerable, and nearly useless to the seekers —
 * and a single "N of M work" headline would hide it. No CLI counterpart.
 *
 * @param {Object} report @returns {string}
 */
function s4LiveCounts(report) {
  const questions = report.questions || [];
  if (questions.length === 0) return '';
  const counts = counter(questions, (q) => q.status);
  const functional = count(counts, 'functional');
  const weak = count(counts, 'weak');
  const live = functional + weak;
  const wasted = count(counts, 'dead') + count(counts, 'degenerate');

  const chips = el('div', join(
    chip(`${num(functional)} fully functional`, 'circle-check', {
      variant: 'success',
      appearance: 'accent',
      title: 'status functional: the answer splits the map',
    }),
    chip(`${num(live)} work at all`, 'list-check', {
      variant: 'brand',
      appearance: 'outlined',
      title: 'status functional or weak',
    }),
    chip(`${num(wasted)} wasted ${s4Plural(wasted, 'draw')}`, 'circle-xmark', {
      variant: 'danger',
      appearance: 'outlined',
      title: 'status dead or degenerate',
    }),
  ), { className: 'wa-cluster wa-gap-2xs' });

  const body = el('p', esc(
    `${num(functional)} ${s4Plural(functional, 'question')} on this map ${s4Plural(functional, 'is', 'are')} `
    + `fully functional: ${s4Plural(functional, 'it', 'they')} split the map, so the answer `
    + `narrows the search. ${num(live)} work at all — that is the same ${num(functional)} plus `
    + `the ${num(weak)} that can be asked and answered but barely narrow anything. The two `
    + 'numbers are not interchangeable, and the larger one is the optimistic reading.',
  ), { className: 'wa-body-s' });

  return waCallout(join(body, chips), {
    variant: 'neutral', appearance: 'plain', icon: 'circle-info',
  });
}

/**
 * §07 — the narrowing funnel, category health, the filterable question table, and
 * every question's exact test collected into one appendix at the foot, each one click
 * and one permalink from the row it belongs to.
 *
 * (generate.py `index_questions`.)
 *
 * @param {Object} payload — the partial `Report` app.js has accumulated
 * @returns {string}
 */
export function renderQuestions(payload) {
  const report = payload || {};
  const questions = report.questions || [];
  if (questions.length === 0) return '';

  const cats = s4QuestionCategories(report);
  const cards = [];
  for (const c of cats) {
    const detail = S4_STATUS_ORDER
      .filter((k) => count(c.counts, k))
      .map((k) => `${num(count(c.counts, k))} ${S4_STATUS_COUNT[k]}`)
      .join(' · ');
    const body = join(
      el('div', join(
        el('b', esc(c.label), { className: 'wa-heading-s' }),
        el('span', esc(`${num(c.health * 100, 0)}%`), { className: 'wa-caption-s' }),
      ), { className: 'wa-split' }),
      waProgressBar(c.health * 100, {
        label: `${c.label} health: ${pct(c.health)}`,
        style: '--indicator-color:var(--accent);--track-color:var(--surface-2);--track-height:9px',
      }),
      el('p', esc(`${num(c.n)} questions · ${detail}`) + provChip('B1'), {
        className: 'wa-body-s wa-color-text-quiet',
      }),
      c.gone.length ? el('p', join(
        el('b', esc('Dead or fixed:'), {
          className: 'wa-caption-xs wa-text-uppercase', style: 'color:var(--crit-text)',
        }),
        esc(` ${s4JoinWords(c.gone)}`),
      ), { className: 'wa-body-s' }) : '',
      c.risk > 0 ? el('p', esc(
        `A Randomize redraw inside this category lands on one of those ${pct(c.risk)} of the time.`,
      ) + provChip('B4'), { className: 'wa-body-s wa-color-text-quiet' }) : '',
    );
    cards.push(waCard(el('div', body, { className: 'wa-stack wa-gap-2xs' })));
  }
  const grid = el('div', join(
    subhead('How each kind of question holds up'),
    el('div', cards.join(''), {
      className: 'wa-grid wa-gap-s', style: '--min-column-size:300px',
    }),
  ), { className: 'wa-stack wa-gap-xs' });

  const geoAvailable = Boolean(report.geo && report.geo.available);
  const funnel = geoAvailable ? s4Funnel(report) : '';

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

  const words = waDetails('What these words mean', s4DefinitionList([
    ...S4_STATUS_DEF.map(([key, meaning]) => [S4_STATUS_TAG[key][0], key, meaning]),
    ['How much it narrows the search', 'quality',
      'The information a question carries, normalised inside its own category, '
      + 'so a clean 50/50 split scores 100%.'],
    ['Blends in', 'anonymity',
      'The share of zones that answer this question exactly the way yours does — the '
      + 'higher it is, the more company you have.'],
  ]), { appearance: 'plain' });

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
    let why = el('p', esc(q.why), { className: 'wa-body-s' });
    const extras = [];
    if (q.borderline) {
      extras.push(chip('borderline', 'circle-half-stroke', {
        variant: 'warning', title: 'would change verdict under a modestly larger map',
      }));
    }
    const survN = fnum(q.survMean);
    if (survN !== null) {
      extras.push(chip(`blends in ${pct(survN, 0)}`, '', {
        title: `anonymity ${num(survN, 2, { comma: false })}`,
      }));
    }
    extras.push(el('a', el('code', esc('test')), {
      href: `#sel-${q.id}`,
      className: 'wa-caption-xs wa-link',
      title: 'The exact thing this question was tested against',
    }));
    why += el('div', extras.join(''), { className: 'wa-cluster wa-gap-2xs' });

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
    }, [
      el('span', esc(S4_CATEGORY_LABEL[q.category] || q.category), {
        className: 'wa-text-nowrap',
      }),
      el('b', esc(q.label)) + el('span', esc(q.text), {
        className: 'wa-caption-xs wa-color-text-quiet', style: 'display:block;max-width:44ch',
      }),
      s4StatusTag(q.status),
      el('span', esc(instances), { className: 'wa-text-nowrap' }),
      el('span', esc(quality), { className: 'wa-text-nowrap' }),
      why,
    ]]);
    selectorRows.push(el('tr', el('td', el('b', esc(q.label)) + el(
      'span',
      esc(S4_CATEGORY_LABEL[q.category] || q.category),
      { className: 'wa-caption-xs wa-color-text-quiet', style: 'display:block' },
    )) + el('td', el('pre', esc(q.selector))), { id: `sel-${q.id}` }));
  }

  const table = s4Table([
    ['Category', 'cat', 'text'],
    ['Question', 'label', 'text'],
    ['Status', 'status', 'num'],
    ['Found on the map', 'found', 'num'],
    ['How much it narrows the search', 'quality', 'num'],
    'Assessment',
  ], rows, { tableId: 'qtable' });

  const pager = s4Pager('qpager', 'qtable', questions.length, 'question',
    'How many questions to show at once');

  let tests = '';
  if (selectorRows.length) {
    const head = el('thead', el('tr', el('th', esc('Question'), { scope: 'col' })
      + el('th', esc('What was searched for'), { scope: 'col' })));
    tests = waDetails("Every question's exact test", join(
      el('p', esc('One row per question, printed verbatim, so you can re-run any of them '
        + 'yourself.'), { className: 'wa-body-s wa-color-text-quiet' }),
      waScroller(el('table', head + el('tbody', selectorRows.join('')), {
        className: 'wa-zebra-rows',
      })),
    ), { appearance: 'plain' });
  }

  const counts = counter(questions, (q) => q.status);
  const live = s4LiveQuestions(report);
  const title = `${num(live)} of the ${num(questions.length)} questions work here`;
  let lede = 'Every question in the deck, checked against this map. “Found on the map” counts '
    + 'the qualifying things inside the border; “how much it narrows the search” is the '
    + "information the answer carries. The one-word status names are this report's, not "
    + "the rulebook's, and are defined under “what these words mean”.";
  if (!geoAvailable) {
    lede += ' OpenStreetMap was not available for this run, so only the questions '
      + 'answerable from the feed alone are evaluated.';
  }
  const answer = el('p', esc(
    `${num(count(counts, 'functional'))} split the map cleanly, ${num(count(counts, 'weak'))} `
    + `barely help, and ${num(count(counts, 'dead') + count(counts, 'degenerate'))} are a `
    + 'wasted draw you should brief everyone about before you start.',
  ), { className: 'wa-body-s' });

  const body = el('div', join(
    funnel, s4LiveCounts(report), grid, controls, words, table, pager, tests,
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
 * (generate.py `_s4_action_tag`.)
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
 * (generate.py `_s4_curse_rows`.)
 *
 * @param {Object} report @param {ReadonlyArray<Object>} curses
 * @returns {Array<[Object, string[]]>}
 */
function s4CurseRows(report, curses) {
  const rows = [];
  /** @type {Object<string,string>} */
  const tiers = {};
  for (const [term, plain] of S4_TIER_DEF) tiers[term] = plain;

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
    };
    if (S4_SPENDING_CURSES.includes(c.id)) {
      rowAttrs.dataSpending = '1';
      actionCell = el('span', s4ActionTag(c.action), { dataWhen: 'off' })
        + el('span', s4ActionTag('remove'), { dataWhen: 'on', hidden: true });
    }
    const tierWord = tiers[`tier ${c.tier}`] || '';
    let why = el('p', esc(c.why), { className: 'wa-body-s' });
    why += el('div', el('a', el('code', esc('test')), {
      href: `#pred-${c.id}`,
      className: 'wa-caption-xs wa-link',
      title: 'The exact test that decided this',
    }), { className: 'wa-cluster wa-gap-2xs' });
    rows.push([rowAttrs, [
      el('b', esc(c.name)) + el('span', esc(`tier ${num(c.tier)} · ${tierWord}`), {
        className: 'wa-caption-xs wa-color-text-quiet', style: 'display:block',
      }),
      actionCell,
      el('span', esc(countText), { className: 'wa-text-nowrap' }),
      why,
    ]]);
  }
  return rows;
}

/**
 * The whole deck's shape in one bar. Labelled "as printed": it is static and does not
 * follow `#nospend`, because the callout above already says what that switch moves.
 * Each segment carries its action's variant so the chips below read as its legend.
 *
 * (generate.py `_s4_deck_strip`.)
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
    subhead('The deck, as printed'),
    budgetBar(segments, total, {
      ariaLabel: `${num(total)} curses: ${spoken}`,
      variants: order.map((a) => S4_ACTION_TAG[a][2]),
    }),
    legend,
  ), { className: 'wa-stack wa-gap-2xs' });
}

/**
 * §08 — the curse audit, filterable by action, with the one "no-spending" `wa-switch`
 * that toggles Egg Partner, Impressionable Consumer and Lemon Phylactery together (the
 * rulebook flags the first two and is silent on the third). The deciding predicates
 * are collected into one appendix at the foot; every row links to its own.
 *
 * (generate.py `index_curses`.)
 *
 * @param {Object} payload @returns {string}
 */
export function renderCurses(payload) {
  const report = payload || {};
  const curses = report.curses || [];
  if (curses.length === 0) return '';

  const counts = counter(curses, (c) => c.action);
  const main = curses.filter((c) => c.tier <= 3);
  const tier4 = curses.filter((c) => c.tier >= 4);

  // Chip counts are over the rows the table holds, not all 24. Chip VALUES stay the
  // one-word actions: `bindFilter` reads them.
  const shown = counter(main, (c) => c.action);
  const present = S4_ACTION_ORDER.filter((a) => count(shown, a));
  const options = [['all', `All ${num(main.length)}`, 'list']];
  for (const a of present) {
    options.push([a, `${S4_ACTION_TAG[a][0]} · ${num(count(shown, a))}`, S4_ACTION_TAG[a][1]]);
  }

  const words = waDetails('What these words mean', s4DefinitionList([
    ...S4_ACTION_DEF.map(([key, meaning]) => [S4_ACTION_TAG[key][0], key, meaning]),
    ...S4_TIER_DEF.map(([term, plain, meaning]) => [plain, term, meaning]),
  ]), { appearance: 'plain' });

  // `words` sits outside #ccontrols, which is `position: sticky`: an open definition
  // list inside it would pin ~500px of glossary over the table.
  const controls = el('div',
    s4ChipGroup('cchips', 'cfilter', options, { label: 'Filter curses by action' }), {
      className: 'wa-split wa-flex-wrap wa-gap-s', id: 'ccontrols',
    });

  const spendingPresent = curses
    .filter((c) => S4_SPENDING_CURSES.includes(c.id))
    .map((c) => String(c.name || ''))
    .sort(cmpStr);
  let toggle = '';
  if (spendingPresent.length) {
    toggle = waCallout(join(
      el('p', esc(
        `The rulebook removes ${s4JoinWords(spendingPresent.slice(0, 2))} when your group does `
        + 'not want to spend money during the game, and says nothing about '
        + `${spendingPresent[spendingPresent.length - 1]}, which needs a purchase just the same. `
        + `The switch treats all ${num(spendingPresent.length)} together; the table shows what `
        + 'it changes.',
      ), { className: 'wa-body-s' }),
      waSwitch('Nobody spends money during this game', { checked: false, id: 'nospend' }),
    ), { variant: 'neutral', appearance: 'outlined', icon: null });
  }

  const table = s4Table([
    ['Curse', 'name', 'text'],
    ['Action', 'action', 'num'],
    ['Count', 'count', 'num'],
    'Why',
  ], s4CurseRows(report, main), { tableId: 'ctable' });

  const pager = s4Pager('cpager', 'ctable', main.length, 'curse',
    'How many curses to show at once');

  let details = '';
  if (tier4.length) {
    details = waDetails(`${num(tier4.length)} curses that no map can affect`, join(
      el('p', esc('These are about the deck, the clock or the players, not the geography. '
        + "Listed for completeness; never removed on this page's advice."), { className: 'wa-body-s' }),
      s4Table(['Curse', 'Action', 'Count', 'Why'], s4CurseRows(report, tier4)),
    ), { appearance: 'plain' });
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
  const tests = waDetails("Every curse's deciding test", join(
    el('p', esc('One row per curse, printed verbatim.'), { className: 'wa-body-s wa-color-text-quiet' }),
    waScroller(el('table', predHead + el('tbody', predRows), { className: 'wa-zebra-rows' })),
  ), { appearance: 'plain' });

  const title = `${num(count(counts, 'keep'))} of ${num(curses.length)} curses work as printed `
    + 'on this map';
  const lede = "Every curse in the hider's deck, checked against this map's geography and this "
    + "feed's network. A count is the number of qualifying features inside the border; outside "
    + 'does not exist for this game. Tiers and instructions are defined under “what these '
    + 'words mean”, beside the filter.';
  const answer = el('p', esc(
    `Take ${num(count(counts, 'remove'))} ${s4Plural(count(counts, 'remove'), 'curse')} out of `
    + `the deck before you start, flag ${num(count(counts, 'warn'))} more, and talk about `
    + `${num(count(counts, 'player-choice'))}.`,
  ), { className: 'wa-body-s' });

  const body = el('div', join(
    s4DeckStrip(report, main), toggle, controls, words, table, pager, details, tests,
  ), { className: 'wa-stack wa-gap-l' });
  return section('curses', S4_ORDINAL, title, body, {
    kicker: 'The curse deck', lede, answerHtml: answer,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// S4 · §09 WHERE THESE NUMBERS COME FROM
// ═══════════════════════════════════════════════════════════════════════════════

/** Curses the audit says to physically remove. (generate.py `_s4_removed_curses`.) */
function s4RemovedCurses(report) {
  return (report.curses || []).filter((c) => c.action === 'remove');
}

/**
 * A definition list of `(anchorId, label, value)` — the provenance spine. A blank value
 * suppresses the row, and `_s4_sources_index` is handed the same list so an index entry
 * can never point at a row that never rendered.
 *
 * (generate.py `_s4_fact_rows`.)
 *
 * @param {ReadonlyArray<[string,string,string]>} rows @returns {string}
 */
function s4FactRows(rows) {
  const out = [];
  for (const [anchor, label, value] of rows) {
    if (!value) continue;
    out.push(el('div', join(
      el('span', esc(label), { className: 'wa-caption-xs wa-text-uppercase' }),
      el('span', esc(value), { className: 'wa-body-s', style: 'overflow-wrap:anywhere' }),
    ), { className: 'wa-stack wa-gap-3xs', id: anchor ? `prov-${anchor}` : null }));
  }
  return el('div', out.join(''), {
    className: 'wa-grid wa-gap-m', style: '--min-column-size:260px',
  });
}

/**
 * `<ol id="cites">` — a named home for every `provChip` target on the page, so a reader
 * arriving from a superscript can see what the anchor is called. Order is the score
 * trace's, then the provenance card's rows, then the Overpass keys as already sorted.
 *
 * (generate.py `_s4_sources_index`.)
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
    entries.push([`prov-osm-${q.key}`, `OpenStreetMap query — ${q.key}`]);
  }
  if (entries.length === 0) return '';
  const lis = entries.map(([anchor, label]) => el('li', join(
    el('code', esc(anchor.startsWith('prov-') ? anchor.slice('prov-'.length) : anchor)),
    el('a', esc(label), { href: `#${anchor}`, className: 'wa-link' }),
  ))).join('');
  return el('ol', lis, { id: 'cites' });
}

/**
 * §09 — feed hash and dates, every category selector with its count, the admin ladder,
 * the generator version and arguments, and the full interpretation list. Printed in
 * full: nothing here is summarised, elided or paginated. The machine identifiers sit
 * in a "Build fingerprint" disclosure; app.js's `openTargeted()` opens it when a
 * citation points inside.
 *
 * (generate.py `index_provenance`.)
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
  for (const q of questions) if (q.borderline) borderline += 1;
  let warned = 0;
  let playerChoice = 0;
  for (const c of curses) {
    if (c.action === 'warn') warned += 1;
    if (c.action === 'player-choice') playerChoice += 1;
  }

  /** @type {Array<[string,string,string]>} */
  const factRows = [
    ['feed', merged ? 'The published timetable files' : "The agency's published timetable file",
      merged
        ? `${num(feeds.length)} feeds merged, ids namespaced ${feeds.map((f) => `${f.tag}:`).join(' ')}`
        : String(p.feedUrl || feed.source || '')],
    ...(merged ? feeds.map((f) => ['', `${String(f.tag || '')} · ${String(f.label || '')}`,
      [String(f.agencyName || ''), String(f.timezone || ''),
        (f.feedStart && f.feedEnd)
          ? `${prettyDate(String(f.feedStart))} – ${prettyDate(String(f.feedEnd))}` : '',
        String(f.source || '')].filter((x) => x).join(' · ')]) : []),
    // Blank on an ordinary run (a blank value drops the row); otherwise it sits directly
    // under the file it qualifies.
    ['', 'Timetable', assumedSchedule
      ? 'Assumed, not published. The lines come from OpenStreetMap: where they run is '
        + 'measured, how often they run is modelled from the assumptions listed below, '
        + 'and every score that rests on the timetable is dropped rather than estimated.'
      : ''],
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
      : ''],
    // Follows `Border.derivation` (CONTRACT §(b)): a reader-set box is unpadded, and one
    // the in-play filter fell back on was not applied at all.
    ['border', 'Border', border
      ? `${border.kind} · S ${num(border.bbox[0], 6, { comma: false })}, `
        + `W ${num(border.bbox[1], 6, { comma: false })}, `
        + `N ${num(border.bbox[2], 6, { comma: false })}, `
        + `E ${num(border.bbox[3], 6, { comma: false })} · `
        + (border.derivation === 'option_fallback' ? 'set by you, not applied'
          : border.derivation === 'option' ? 'set by you, unpadded'
            : `padded ${s4Dist(report, border.padM, 2)}`)
      : ''],
    ['questions', 'Question audit', questions.length
      ? `${num(questions.length)} questions evaluated inside the border; `
        + `${num(s4LiveQuestions(report))} function, `
        + `${num(borderline)} would change under a larger map`
      : ''],
    ['curses', 'Curse audit', curses.length
      ? `${num(curses.length)} curses checked; `
        + `${num(s4RemovedCurses(report).length)} removed, `
        + `${num(warned)} weakened, ${num(playerChoice)} left to the players`
      : ''],
    ['start', 'Round-start location and departure', hub
      ? `${hub.name} (${opts.startStopId || hub.stopId}) at ${opts.departure}` : ''],
    ['days', 'Representative days', (report.days || [])
      .filter((d) => d && d.dayType && d.dayType.date)
      .map((d) => `${d.dayType.label} ${prettyDate(d.dayType.date)}`).join(' · ')],
    ['scoring', 'Scoring parameters',
      `seeker sample ${num(p.seekerSampleCap || SEEKER_SAMPLE_CAP)} · `
      + `greedy k ${num(p.greedyK || (report.questionOrder || []).length)} · `
      + `zone radius ${s4Dist(report, Number(p.zoneRadiusM || size.zoneRadiusM || 0), 2)}`],
  ];

  const blocks = [waCard(join(
    s4FactRows(factRows),
    waDetails('Build fingerprint', s4FactRows(fingerprintRows), { appearance: 'plain' }),
  ), {
    headerHtml: s4CardHeader(
      'What this report was built from',
      'Everything here is derived from the feed, the OpenStreetMap snapshot and the rulebook.',
    ),
  })];

  const overpass = sortedBy(p.overpass || [], (x) => [String(x.key), String(x.cacheKey)]);
  if (overpass.length) {
    const rows = [];
    for (const q of overpass) {
      const c = fnum(q.count);
      let shownCount = c === null ? '—' : num(c);
      if (q.partial) shownCount += ' +';
      rows.push([{ id: `prov-osm-${q.key}` }, [
        el('b', esc(String(q.key || ''))),
        el('span', esc(shownCount), { className: 'wa-text-nowrap' }),
        el('pre', esc(String(q.selector || ''))),
        el('span', esc(String(q.endpoint || '')), {
          className: 'wa-caption-xs wa-color-text-quiet', style: 'overflow-wrap:anywhere',
        }),
      ]]);
    }
    // No "Cache key" column: every record carries `cacheKey: ''`. The last column is
    // the file each count was read from.
    const note = 'Every count is the number of matching OpenStreetMap elements inside the '
      + 'border. A + marks a count not confirmed by reading the features: the category was '
      + 'too large to fetch (so the number is an upper bound) or the layer could not be read. '
      + 'Selectors are printed verbatim so you can re-run them at overpass-turbo.eu.';
    blocks.push(waCard(join(
      el('p', esc(note), { className: 'wa-body-s wa-color-text-quiet' }),
      s4Table(['Category', 'Count', 'What was searched for', 'Read from'], rows),
    ), {
      headerHtml: s4CardHeader(
        `${num(overpass.length)} OpenStreetMap categories`,
        'One selector per category; this run read the matching features inside the border.',
      ),
    }));
  }

  const admin = (report.geo && report.geo.admin) || {
    countryCode: null, countryName: null, source: 'unknown',
  };
  const ladder = p.adminLevels || {};
  if (Object.keys(ladder).length || admin.countryCode) {
    const items = [];
    for (const ordinal of ['1', '2', '3', '4']) {
      const level = ladder[ordinal];
      if (level === null || level === undefined) {
        items.push(`${ordinal}: no ${ordinal}th-level division on this map`);
      } else {
        // Overture synthesises a level per subtype and those numbers deliberately do
        // NOT mean what OSM's `admin_level` means, so the source has to reach the label.
        items.push(p.adminSource === 'overture'
          ? `${ordinal}: Overture level ${num(level)}`
          : `${ordinal}: OSM admin_level ${num(level)}`);
      }
    }
    let text = `Country ${String(admin.countryName || admin.countryCode || 'unknown')} · `
      + items.join(' · ');
    if (admin.source === 'unknown') {
      text = 'The country could not be determined, so the administrative-division questions '
        + "were marked unknown rather than guessed at, and were excluded from the score's "
        + 'denominator.';
    }
    blocks.push(waCard(
      el('p', esc(text), { className: 'wa-body-s', style: 'max-width:80ch' }),
      {
        headerHtml: s4CardHeader(
          'Administrative divisions',
          "The rulebook's 1st–4th divisions land on different levels in every country, so "
          + 'the ladder is derived from the division data, never assumed.',
        ),
      },
    ));
  }

  const interps = sortedBy(p.interpretations || [], (x) => [String(x.id)]);
  if (interps.length) {
    // A flat `<dl>`, not an accordion: the sentence is the content and the payload is
    // two tags. `id="interp-…"` anchors each entry.
    const entries = [];
    for (const i of interps) {
      const iid = String(i.id || '');
      const affects = (i.affects || []).map((a) => String(a));
      const tail = affects.length
        ? el('span', esc('affects'), {
          className: 'wa-caption-xs wa-text-uppercase wa-color-text-quiet',
        }) + affects.map((a) => waTag(a)).join('')
        : el('span', esc('changes no printed number directly'), {
          className: 'wa-caption-xs wa-color-text-quiet',
        });
      entries.push(el('dt', esc(String(i.text || '')), {
        className: 'wa-body-s', id: `interp-${iid}`,
      }));
      entries.push(el('dd', el('div', join(
        el('code', esc(iid), { className: 'wa-caption-2xs wa-color-text-quiet' }),
        tail,
      ), { className: 'wa-cluster wa-gap-2xs wa-align-items-center' }), {
        style: 'margin:0 0 var(--wa-space-m) 0',
      }));
    }
    blocks.push(waCard(el('dl', entries.join(''), { className: 'wa-stack wa-gap-3xs' }), {
      headerHtml: s4CardHeader(
        `${num(interps.length)} places where the rulebook is silent and this report decided`,
        'Each changed a number on this page. They are interpretations, not rules; a group '
        + 'that disagrees with one may overrule it.',
      ),
    }));
  }

  const geoNotes = Array.from(new Set((report.geo && report.geo.notes) || [])).sort(cmpStr);
  const degradations = Array.from(new Set(report.degradations || [])).sort(cmpStr);
  const notes = geoNotes.concat(degradations);
  if (notes.length) {
    blocks.push(waCard(
      el('ul', notes.map((n) => el('li', esc(n))).join(''), {
        className: 'wa-stack wa-gap-2xs',
      }),
      {
        headerHtml: s4CardHeader(
          'What this data does not know',
          'Limits of the sources, carried through from the layers that produced them.',
        ),
      },
    ));
  }

  const indexBlock = s4SourcesIndex(report, factRows.concat(fingerprintRows));
  if (indexBlock) {
    blocks.push(waCard(indexBlock, {
      headerHtml: s4CardHeader(
        'Every citation on this page, and where it lands',
        'The little superscript links next to the numbers point here.',
      ),
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
 * The page footer: five figures, the credit sentence, and a link back to the top. The
 * ids match the shell's skeleton (`#footer-figures`, `#footer-credit`) so app.js can
 * replace the whole `<footer>` or swap the two children in place.
 *
 * (generate.py `_s4_footer`.)
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
    [`${num(s4LiveQuestions(report))} / ${num(questions.length)}`, 'questions live'],
    [num(s4RemovedCurses(report).length), 'curses removed'],
    [num((p.overpass || []).length), 'OpenStreetMap queries'],
    [num((p.interpretations || []).length), 'documented interpretations'],
  ];
  const figures = el('div', stats.map(([value, label]) => el('span', join(
    el('b', esc(value), { className: 'wa-heading-s' }),
    el('span', esc(label), { className: 'wa-caption-xs' }),
  ), { className: 'wa-stack wa-gap-3xs' })).join(''), {
    className: 'wa-grid wa-gap-m', style: '--min-column-size:230px', id: 'footer-figures',
  });

  const credit = `Built from ${feed.agencyName || ''}'s GTFS feed`
    + ((p.feedStart && p.feedEnd)
      ? ` (valid ${prettyDate(String(p.feedStart))} – ${prettyDate(String(p.feedEnd))})` : '')
    + '. Map features from OpenStreetMap contributors, ODbL. '
    + (p.adminSource === 'overture'
      ? 'Administrative divisions from the Overture Maps Foundation. '
      : 'Administrative divisions from OpenStreetMap contributors, ODbL. ')
    + "Basemap tiles by OpenFreeMap, from OpenMapTiles data. Rules from Jet Lag: The Game's "
    + 'Hide+Seek rulebook. Scheduled times are planning estimates — check live tracking on the '
    + 'day.'
    + (dateText ? ` Analysis date ${dateText}, taken from the feed's own calendar.` : '');

  const top = el('a', join(waIcon('arrow-up'), esc('Back to top')), {
    href: '#top', className: 'wa-link wa-caption-s wa-cluster wa-gap-2xs',
  });
  return el('footer', el('div', join(
    figures,
    el('p', esc(credit), {
      className: 'wa-body-s', style: 'max-width:88ch', id: 'footer-credit',
    }),
    top,
  ), { className: 'wa-stack wa-gap-m' }), { slot: 'footer', dataWhen: 'report' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE DECK TABLES — sort, filter, search, paging
// ═══════════════════════════════════════════════════════════════════════════════
//
// The CLI binds a chip filter, a search box and the no-spending switch to one static
// document (`_S4_INDEX_JS`). The browser build adds column sorting and an opt-in page
// size, and app.js re-renders a whole section when a later stage lands or the reader
// switches service day, which discards every element these listeners were on. So the
// state lives in `DECK_STATE`, keyed by table id, and `initDeckTables` writes it back
// into the fresh controls before binding anything.
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
  qtable: { sortKey: null, sortDir: 1, filter: 'all', search: '', pageSize: 'all', page: 0 },
  ctable: { sortKey: null, sortDir: 1, filter: 'all', pageSize: 'all', page: 0 },
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
    countEl.textContent = Number.isFinite(size)
      ? `Showing ${num(shownN)} of ${num(total)} ${s4Plural(total, spec.noun)}.`
      : `Showing all ${num(total)} ${s4Plural(total, spec.noun)}.`;
  }
  const nav = pager.querySelector('[data-role="pagenav"]');
  if (nav) nav.hidden = !Number.isFinite(size) || pages < 2;
  const pageEl = pager.querySelector('[data-role="page"]');
  if (pageEl) pageEl.textContent = `Page ${num(st.page + 1)} of ${num(pages)}`;
  const prev = pager.querySelector('[data-role="prev"]');
  if (prev) prev.disabled = st.page <= 0;
  const next = pager.querySelector('[data-role="next"]');
  if (next) next.disabled = st.page >= pages - 1;
}

/**
 * The no-spending switch: Egg Partner, Impressionable Consumer and Lemon Phylactery
 * become `remove` together, and the action filter follows the switch.
 *
 * (generate.py `bindSpending`.)
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
      if (!PAGE_SIZES.includes(st.pageSize)) st.pageSize = 'all';
      if (sizeGroup.getAttribute('value') !== st.pageSize) {
        sizeGroup.setAttribute('value', st.pageSize);
      }
      if (sizeGroup.value !== st.pageSize) sizeGroup.value = st.pageSize;
      bindOnce(sizeGroup, 'deckSizeBound', 'change', () => {
        st.pageSize = String(sizeGroup.value || 'all');
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
