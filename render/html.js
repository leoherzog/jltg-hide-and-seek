// render/html.js — HTML string-builder helpers (generate.py).
//
// Template literals through a small set of pure helpers; nothing here touches the DOM.
//
// THE ESCAPING CONTRACT:
//   * A parameter whose name ends in `Html` is markup that is ALREADY safe and is
//     inserted verbatim.
//   * Every other string parameter is plain text and goes through `esc()`.
//   * `esc()` is the only way text becomes markup; feed data contains apostrophes,
//     ampersands and angle brackets. Attribute values always go through `attrs()`.
//
// Only WebAwesome 3.11 components the drafts use (or pages.md sanctions) get a helper;
// do not invent one.
//
// Python keyword arguments become a trailing options object; `class_` is `className`,
// `void()` is `voidEl()`.

import { cmpStr, jdump, num } from '../lib/core.js';

// ── the primitives ───────────────────────────────────────────────────────────

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
};

/**
 * HTML-escape any value, including both quotes; `null` / `undefined` become ''.
 * Matches Python's `html.escape(s, quote=True)`, including `'` → `&#x27;`.
 *
 * @param {*} value
 * @returns {string}
 */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * `className` / `class_` → `class`, `for_` / `htmlFor` → `for`; otherwise strip
 * trailing underscores, split camelCase, `_` → `-`, lowercase.
 *
 * @param {string} raw
 * @returns {string}
 */
function attrName(raw) {
  if (raw === 'className' || raw === 'class_' || raw === 'class') return 'class';
  if (raw === 'htmlFor' || raw === 'for_' || raw === 'for') return 'for';
  return raw
    .replace(/_+$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

/**
 * Render an object as HTML attributes, escaped, in sorted key order.
 *
 * `null`, `false` and `undefined` drop the attribute; `true` renders it bare. An
 * empty string does NOT drop it, which is why the helpers write `label || null`.
 * Sorting is on the rendered name and keeps the output byte-stable.
 *
 * @param {Object<string,*>} [obj]
 * @returns {string} '' or a LEADING-SPACE-PREFIXED string
 */
export function attrs(obj) {
  if (!obj) return '';
  /** @type {Array<[string, *]>} */
  const pairs = [];
  for (const raw of Object.keys(obj)) {
    const v = obj[raw];
    if (v === null || v === false || v === undefined) continue;
    pairs.push([attrName(raw), v]);
  }
  if (pairs.length === 0) return '';
  // Plain code-point comparison — never localeCompare, which is locale-dependent.
  pairs.sort((a, b) => cmpStr(a[0], b[0]));
  const parts = pairs.map(([k, v]) => (v === true ? k : `${k}="${esc(v)}"`));
  return ` ${parts.join(' ')}`;
}

/**
 * A generic element: `el('p', esc(text), { className: 'wa-body-s' })`.
 * @param {string} tag @param {string} [contentHtml] @param {Object} [opts]
 * @returns {string}
 */
export function el(tag, contentHtml = '', opts = {}) {
  return `<${tag}${attrs(opts)}>${contentHtml}</${tag}>`;
}

/**
 * A void element: `voidEl('img', { src: … })`. (Python's `void`.)
 * @param {string} tag @param {Object} [opts]
 * @returns {string}
 */
export function voidEl(tag, opts = {}) {
  return `<${tag}${attrs(opts)}>`;
}

/**
 * Concatenate markup chunks, dropping nulls and empties. Newline-separated.
 * @param {...(string|null|undefined)} chunks
 * @returns {string}
 */
export function join(...chunks) {
  return chunks.filter((c) => c).join('\n');
}

// ── WebAwesome component helpers ─────────────────────────────────────────────

/**
 * `<wa-icon>` — Font Awesome Free solid. `label` is the accessible name: omit it for
 * a decorative icon beside text, supply it for an icon-only control.
 *
 * @param {string} name @param {Object} [opts] @param {string} [opts.label]
 * @returns {string}
 */
export function waIcon(name, opts = {}) {
  const { label = '', ...rest } = opts;
  return el('wa-icon', '', { name, label: label || null, ...rest });
}

/**
 * `<wa-card>` with optional header/footer slots. A header or footer adds the
 * `with-header` / `with-footer` attribute WebAwesome needs to lay the slot out.
 *
 * @param {string} bodyHtml
 * @param {Object} [opts]
 * @returns {string}
 */
export function waCard(bodyHtml, opts = {}) {
  const { headerHtml = '', footerHtml = '', className = '', ...rest } = opts;
  const slots = join(
    headerHtml ? el('div', headerHtml, { slot: 'header' }) : '',
    bodyHtml,
    footerHtml ? el('div', footerHtml, { slot: 'footer' }) : '',
  );
  return el('wa-card', slots, {
    className: className || null,
    withHeader: Boolean(headerHtml),
    withFooter: Boolean(footerHtml),
    ...rest,
  });
}

/**
 * `<wa-callout>`. `variant` ∈ brand | success | warning | danger | neutral.
 * @param {string} bodyHtml @param {Object} [opts]
 * @returns {string}
 */
export function waCallout(bodyHtml, opts = {}) {
  const { variant = 'neutral', appearance = 'filled-outlined', icon = null, ...rest } = opts;
  const inner = join(icon ? waIcon(icon, { slot: 'icon' }) : '', bodyHtml);
  return el('wa-callout', inner, { variant, appearance, ...rest });
}

/**
 * `<wa-tag>` — a static label chip. Text is escaped. `icon` prepends a `<wa-icon>`
 * in the default slot (`wa-tag` has no `start` slot). Prefer `chip()` for a status.
 *
 * @param {string} text @param {Object} [opts]
 * @returns {string}
 */
export function waTag(text, opts = {}) {
  const {
    variant = 'neutral', appearance = 'outlined', size = 's', pill = true, icon = '', ...rest
  } = opts;
  const inner = join(icon ? waIcon(icon) : '', esc(text));
  return el('wa-tag', inner, { variant, appearance, size, pill, ...rest });
}

/**
 * `<wa-badge>` — a count or status pip. Text is escaped.
 * @param {string} text @param {Object} [opts]
 * @returns {string}
 */
export function waBadge(text, opts = {}) {
  const { variant = 'brand', appearance = 'filled', pill = true, ...rest } = opts;
  return el('wa-badge', esc(text), { variant, appearance, pill, ...rest });
}

/**
 * `<wa-button>`. Text is escaped. `icon` fills the button's `start` slot.
 * @param {string} text @param {Object} [opts]
 * @returns {string}
 */
export function waButton(text, opts = {}) {
  const {
    variant = 'neutral', appearance = 'outlined', size = 's', icon = '', ...rest
  } = opts;
  const inner = join(icon ? waIcon(icon, { slot: 'start' }) : '', esc(text));
  return el('wa-button', inner, { variant, appearance, size, ...rest });
}

/**
 * `<wa-details>` disclosure. `summary` is plain text and is escaped (by `attrs`).
 * @param {string} summary @param {string} bodyHtml @param {Object} [opts]
 * @returns {string}
 */
export function waDetails(summary, bodyHtml, opts = {}) {
  return el('wa-details', bodyHtml, { summary, ...opts });
}


/**
 * `<wa-scroller>` — wraps wide tables and charts. Never wrap a map in one; it
 * breaks MapLibre's sizing.
 * @param {string} bodyHtml @param {Object} [opts]
 * @returns {string}
 */
export function waScroller(bodyHtml, opts = {}) {
  const { orientation = 'horizontal', ...rest } = opts;
  return el('wa-scroller', bodyHtml, { orientation, ...rest });
}

/**
 * `<wa-progress-bar>`; `value` is 0..100 and is rounded to one place.
 * @param {number} value @param {Object} [opts]
 * @returns {string}
 */
export function waProgressBar(value, opts = {}) {
  const { label = '', ...rest } = opts;
  return el('wa-progress-bar', '', {
    value: num(value, 1, { comma: false }),
    label: label || null,
    ...rest,
  });
}

/**
 * `<wa-progress-ring>`; `value` is 0..100. `innerHtml` fills the centre.
 * @param {number} value @param {Object} [opts]
 * @returns {string}
 */
export function waProgressRing(value, opts = {}) {
  const { label = '', innerHtml = '', ...rest } = opts;
  return el('wa-progress-ring', innerHtml, {
    value: num(value, 1, { comma: false }),
    label: label || null,
    ...rest,
  });
}

/**
 * `<wa-switch>`. Label text is escaped.
 * @param {string} label @param {Object} [opts]
 * @returns {string}
 */
export function waSwitch(label, opts = {}) {
  const { checked = false, size = 's', ...rest } = opts;
  return el('wa-switch', esc(label), { checked, size, ...rest });
}


/**
 * `<wa-copy-button>` carrying `payload` as its `value`. Used for the border GeoJSON:
 * every player must use the exact same border, so it has to be copy-pasteable.
 *
 * `trigger` slots a visible control in place of the icon-only default, so two copy
 * buttons side by side are told apart. `label` stays the accessible name and tooltip.
 *
 * @param {string} payload @param {Object} [opts]
 * @returns {string}
 */
export function waCopyButton(payload, opts = {}) {
  const { label = 'Copy', trigger = '', ...rest } = opts;
  return el('wa-copy-button', trigger, { value: payload, copyLabel: label, ...rest });
}

/**
 * `<wa-chart>` with an inline Chart.js config. `configJson` must come from `jdump()`.
 *
 * `wa-chart` resolves `var(--x)` for Chart.js on the dataset keys it knows
 * (`backgroundColor`, `borderColor`, `pointBackgroundColor`, `borderWidth`,
 * `pointRadius`) and on every option in its transform schema, and re-resolves them on
 * a theme flip — so `"var(--seq-550)"` in the JSON is correct and preferable to
 * `cssVar()`, which snapshots once. `cssVar()` is still required for keys outside that
 * schema (`borderRadius`, `barThickness`, `barPercentage`) and for a plugin's own
 * `ctx.fillStyle`. `borderWidth`'s transform is `Number`, so the per-side object form
 * yields `NaN`.
 *
 * A slotted `<script type="application/json">` wins over the `.config` property and
 * is re-parsed on every render, so never ship both; `.plugins` is merged afterwards.
 *
 * `<` is escaped as in `jsonBlock`, so a route or stop name cannot close the script
 * block; the parsed config is unchanged.
 *
 * @param {string} chartType @param {string} configJson @param {Object} [opts]
 * @returns {string}
 */
export function waChart(chartType, configJson, opts = {}) {
  const safe = jsonSafe(configJson);
  return el('wa-chart', el('script', safe, { type: 'application/json' }), {
    type: chartType,
    ...opts,
  });
}

/**
 * A grouped disclosure list. `items` are `[itemId, labelHtml, bodyHtml, expanded]`.
 *
 * `labelHtml` fills each item's `label` slot, so a collapsed label can still carry a
 * progress bar or a badge. `itemId` becomes the item's `id`, so a `#fragment`
 * addresses it and `openTargeted()` expands every ancestor disclosure before scrolling.
 *
 * NEVER put a map or a chart inside one: MapLibre and Chart.js read their container
 * size once, at construction, and nothing here calls `.resize()`.
 *
 * @param {Array<[string,string,string,boolean]>} items @param {Object} [opts]
 * @returns {string}
 */
export function waAccordion(items, opts = {}) {
  const {
    mode = 'single-collapsible', appearance = 'plain', headingLevel = '4', ...rest
  } = opts;
  const body = items.map(([itemId, labelHtml, bodyHtml, expanded]) => el(
    'wa-accordion-item',
    el('div', labelHtml, {
      slot: 'label',
      className: 'wa-split wa-gap-s',
      style: 'flex:1',
    }) + bodyHtml,
    { id: itemId || null, expanded: expanded ? true : null },
  )).join('');
  return el('wa-accordion', body, { mode, appearance, headingLevel, ...rest });
}


// ── design primitives: the three tiers (grade · rubric · evidence) ────────────

/**
 * A status chip: icon AND word, never colour alone.
 *
 * The only sanctioned way to render a question status, curse action, finding severity
 * or metric source: `--warn`, `--q-edge` and `--gold` all sit under the 3:1 non-text
 * contrast floor on the off-white surface, so the hue cannot carry the signal.
 *
 * `appearance` is `wa-tag`'s (`outlined`, `filled`, `filled-outlined`, `accent`);
 * anything else silently renders as the default.
 *
 * @param {string} text @param {string} [iconName] @param {Object} [opts]
 * @returns {string}
 */
export function chip(text, iconName = '', opts = {}) {
  const { variant = 'neutral', appearance = 'outlined', ...rest } = opts;
  return waTag(text, { variant, appearance, icon: iconName, ...rest });
}

/**
 * A label / track / value row — the rubric tier's workhorse. `valuePct` is 0–100 and
 * computed by the caller. Rubric is never collapsed.
 *
 * `opts.label` is the bar's accessible name and must be plain text: `wa-progress-bar`
 * puts it straight into `aria-label`, and without it every bar announces as "Progress".
 *
 * @param {string} labelHtml @param {number} valuePct @param {string} rightHtml
 * @param {Object} [opts]
 * @param {string} [opts.label]
 * @returns {string}
 */
export function meter(labelHtml, valuePct, rightHtml, opts = {}) {
  const { flank = '6rem', label = '', ...rest } = opts;
  const left = el('div', join(labelHtml, waProgressBar(valuePct, { label })), {
    className: 'wa-stack wa-gap-3xs',
  });
  return el('div', join(left, rightHtml), {
    className: 'wa-flank:end wa-gap-s',
    style: `--flank-size:${flank}`,
    ...rest,
  });
}

/**
 * The Points Budget / deck strip — one category, one dataset per segment, stacked.
 *
 * `segments` are `[letter, value, tipText]` triples summing to at most `total`; each
 * becomes a single-point dataset laid along one row. A shortfall gets a final
 * un-earned dataset in the de-emphasis grey. `tipText` becomes the dataset `label`,
 * which the hover reads (`budgetSeg` in app.js).
 *
 * A `wa-chart` (`stacked` + `index-axis="y"`), not `wa-progress-bar`, which is a
 * single-fill track. The `budgetSeg` plugin in app.js paints the A–F letters (no
 * datalabels plugin is registered) and routes hover to the `#tt` panel, because
 * Chart.js's own tooltip draws inside a canvas too short to hold it. `letter` and
 * `ink` are extra dataset keys that survive `wa-chart`'s clone verbatim.
 *
 * `variants` is optional and parallel to `segments`: each is a WebAwesome variant,
 * rendered as `var(--wa-color-<variant>-fill-loud)`. Use it only when the segments
 * encode state and something beside the bar acts as a colour legend.
 *
 * Never nest one inside a disclosure: a canvas in a `display:none` subtree measures 0.
 * Pass `height`, never `style`: `style` would drop `aspect-ratio:auto` and let the
 * component's own `:host{aspect-ratio:16/9}` win.
 *
 * @param {Array<[string,number,string]>} segments @param {number} total
 * @param {Object} opts @param {string} opts.ariaLabel
 * @param {string} [opts.height] CSS block-size for the bar
 * @returns {string}
 */
export function budgetBar(segments, total, opts = {}) {
  const {
    ariaLabel, remainderTip = '', variants = [], height = '1.25rem', ...rest
  } = opts;
  // The 2px flex `gap` becomes a 1px paper-coloured border per side. It MUST be set:
  // omitted, the component paints `var(--border-color-N)` per dataset. `borderWidth`
  // must stay a scalar (its transform is `Number`).
  const seg = (label, letter, value, fill, ink) => ({
    backgroundColor: fill,
    borderColor: 'var(--wa-color-surface-default)',
    borderSkipped: false,
    borderWidth: 1,
    data: [value],
    label,
    letter,
    ...(ink ? { ink } : {}),
  });
  const datasets = segments.map(([letter, value, tip], i) => (i < variants.length
    ? seg(tip || letter, letter, value,
      `var(--wa-color-${variants[i]}-fill-loud)`, `--wa-color-${variants[i]}-on-loud`)
    : seg(tip || letter, letter, value, 'var(--seq-550)', null)));
  let used = 0;
  for (const [, value] of segments) used += value;
  if (used < total - 1e-9) {
    datasets.push(seg(remainderTip || 'Not earned', '', total - used, 'var(--off)', null));
  }
  const config = jdump({
    data: { datasets, labels: [''] },
    options: {
      // the defaults are 0.9 × 0.8, which would leave a 14px bar in a 20px canvas
      datasets: { bar: { barPercentage: 1, categoryPercentage: 1 } },
      layout: { padding: 0 },
      // `title.display` defaults to Boolean(label) with text = label, so without this
      // the whole aria sentence is painted into the canvas. `grace` defaults to '5%'.
      plugins: { legend: { display: false }, title: { display: false } },
      scales: { x: { display: false, grace: 0 }, y: { display: false, grace: 0 } },
    },
  });
  return waChart('bar', config, {
    dataBudget: true,
    description: remainderTip || null,
    grid: 'none',
    indexAxis: 'y',
    label: ariaLabel,
    max: num(total, 2, { comma: false }),
    min: '0',
    stacked: true,
    style: `aspect-ratio:auto;block-size:${height}`,
    withoutAnimation: true,
    withoutLegend: true,
    withoutTooltip: true,
    ...rest,
  });
}

/**
 * A native `<input type="search">`, skinned by WebAwesome's `native.css`; it stays
 * usable with scripting off.
 *
 * @param {string} inputId @param {Object} opts
 * @param {string} opts.placeholder @param {string} opts.label
 * @returns {string}
 */
export function searchInput(inputId, opts = {}) {
  const { placeholder, label } = opts;
  return el('label', join(
    el('span', esc(label), { className: 'wa-visually-hidden' }),
    voidEl('input', {
      type: 'search', id: inputId, placeholder,
    }),
  ));
}

/**
 * The page's one counter-intuitive claim, as a pull quote. `native.css` styles
 * `<blockquote>` already. Exactly one per page.
 *
 * @param {string} text
 * @returns {string}
 */
export function pullQuote(text) {
  return el('blockquote', el('p', esc(text), { className: 'wa-longform-xl' }));
}

// ── page-level composition helpers ───────────────────────────────────────────

/**
 * A numbered editorial `<section>`. `number` renders through `h2[data-n]::before`,
 * so a screen reader never reads it twice.
 *
 * `answerHtml` is ONE plain-English sentence carrying the two or three numbers that
 * matter, set as a tinted strip above the evidence. Every number in it must come from
 * an existing helper or `Report` field — a renderer never computes one.
 *
 * @param {string} sectionId @param {string} number @param {string} title
 * @param {string} bodyHtml @param {Object} [opts]
 * @returns {string}
 */
export function section(sectionId, number, title, bodyHtml, opts = {}) {
  const { kicker = '', lede = '', answerHtml = '' } = opts;
  const head = join(
    kicker ? el('p', esc(kicker), { className: 'kicker wa-caption-s wa-text-uppercase' }) : '',
    el('h2', esc(title), { className: 'wa-heading-2xl', dataN: number }),
    lede ? el('p', esc(lede), { className: 'wa-body-l' }) : '',
  );
  const answer = answerHtml
    ? waCallout(answerHtml, { variant: 'neutral', appearance: 'plain', icon: 'circle-info' })
    : '';
  return el(
    'section',
    join(el('header', head, { className: 'wa-stack wa-gap-3xs' }), answer, bodyHtml),
    { id: sectionId, className: 'wa-stack wa-gap-l' },
  );
}

/**
 * A small quiet subheading inside a section. `anchorId` makes it a nav target.
 * @param {string} text @param {Object} [opts] @param {string} [opts.anchorId]
 * @returns {string}
 */
export function subhead(text, opts = {}) {
  const { anchorId = '' } = opts;
  return el('h3', esc(text), {
    id: anchorId || null,
    className: 'wa-heading-s wa-color-text-quiet wa-text-uppercase',
  });
}

/**
 * The stat-tile inner block: big number, caption, optional note. `chipHtml` sits
 * under the value, so a day-sensitive tile's gold rule carries a word as well.
 *
 * @param {string} value @param {string} label @param {string} [noteHtml]
 * @param {Object} [opts] @param {string} [opts.chipHtml]
 * @returns {string}
 */
export function kpi(value, label, noteHtml = '', opts = {}) {
  const { chipHtml = '' } = opts;
  return el('div', join(
    el('span', esc(value), { className: 'wa-heading-2xl', style: 'font-family:var(--sans)' }),
    el('span', esc(label), { className: 'wa-caption-xs wa-text-uppercase' }),
    chipHtml,
    noteHtml ? el('span', noteHtml, { className: 'wa-body-s wa-color-text-quiet' }) : '',
  ), { className: 'wa-stack wa-gap-3xs' });
}

/**
 * A provenance chip: every printed number carries the id of the metric or map-data
 * category that produced it, linking to that row in the score trace or the provenance
 * section. Variadic, like the Python.
 *
 * @param {...string} ids
 * @returns {string}
 */
export function provChip(...ids) {
  const good = ids.filter((i) => i);
  if (good.length === 0) return '';
  const links = good.map((i) => el('a', esc(i), {
    className: 'wa-link',
    href: `#prov-${i}`,
    title: `Where this number comes from: ${i}`,
  })).join(',');
  return el('sup', links, { dataCite: true });
}

/**
 * A `<table>` from plain-text headers and pre-escaped row cells, always wrapped in a
 * `wa-scroller` so a long table scrolls inside its own container, never the page.
 *
 * @param {ReadonlyArray<string>} headers
 * @param {ReadonlyArray<ReadonlyArray<string>>} rows
 * @param {Object} [opts]
 * @returns {string}
 */
export function dataTable(headers, rows, opts = {}) {
  const { className = '', ...rest } = opts;
  const thead = el('thead', el('tr', headers.map((h) => el('th', esc(h))).join('')));
  const tbody = el('tbody', rows.map(
    (row) => el('tr', row.map((c) => el('td', c)).join('')),
  ).join(''));
  const table = el('table', thead + tbody, { className: className || null, ...rest });
  return waScroller(table);
}

/**
 * Embed a payload as `<script type="application/json" id="…">`. Every `<` is escaped
 * so a hostile stop name cannot break out. One block per concern, so a huge POI set
 * need not be parsed to render the verdict.
 *
 * @param {string} blockId @param {*} payload
 * @returns {string}
 */
export function jsonBlock(blockId, payload) {
  return el('script', jsonSafe(jdump(payload, { floatDp: 6 })),
    { type: 'application/json', id: blockId });
}

/**
 * Make a JSON document safe as `<script>` text content.
 *
 * Escaping `</` alone stops `</script>` but not `<!--<script>`, which puts the
 * tokeniser into the double-escaped state where the block's own `</script>` no longer
 * ends it. Escaping every `<` closes all three sequences, and is exact: structural
 * JSON has no `<`, so every one is inside a string literal and decodes back unchanged.
 *
 * @param {string} json
 * @returns {string}
 */
function jsonSafe(json) {
  return String(json).split('<').join('\\u003c');
}
