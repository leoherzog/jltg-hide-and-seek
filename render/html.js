// render/html.js — the HTML string-builder helpers (generate.py).
//
// APPROACH: template literals through a small set of helpers, no template files, no
// template engine. Every function here is pure and returns a string; nothing in this
// file touches the DOM, so it is equally usable from a worker if that ever helps.
//
// THE ESCAPING CONTRACT — every renderer must follow it exactly:
//
//   * A parameter whose name ends in `Html` receives markup that is ALREADY safe.
//     The helper inserts it verbatim. You build it with other helpers, or you call
//     `esc()` yourself.
//   * Every other string parameter is plain text. The helper calls `esc()` on it.
//   * `esc()` is the only way text becomes markup. There is no "I know this is safe"
//     exception — feed data contains apostrophes, ampersands and, in the wild, angle
//     brackets. The escaping was verified with `</script><script>alert(1)</script>`
//     as a stop name.
//   * Attribute values always go through `attrs()`, which escapes them.
//
// Only WebAwesome 3.11 components that the drafts already use (or that pages.md
// explicitly sanctions) get a helper. If there is no helper for it, it is not on the
// sanctioned list — do not invent one.
//
// Python keyword arguments become a single trailing options object. Python's
// `class_` becomes `className`; Python's `void()` is `voidEl()` (`void` is a JS
// operator).

import { jdump, num } from '../lib/core.js';

// ── the primitives ───────────────────────────────────────────────────────────

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
};

/**
 * HTML-escape any value, including both kinds of quote. The single entry point for
 * text. `null` / `undefined` become the empty string.
 *
 * Matches Python's `html.escape(s, quote=True)` character for character, including
 * `'` → `&#x27;` (not `&apos;`, which predates HTML5 in some parsers).
 *
 * @param {*} value
 * @returns {string}
 */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * `className` / `class_` → `class`, `for_` / `htmlFor` → `for`, otherwise: strip
 * trailing underscores, split camelCase, turn `_` into `-`, lowercase. So
 * `indexAxis` and `index_axis` both give `index-axis`, and `dataTip` / `data_tip`
 * both give `data-tip`.
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
 * `null`, `false` and `undefined` DROP the attribute; `true` renders it bare
 * (`pill`). An empty string does NOT drop it — `label=""` renders `label=""`, which
 * is why the helpers below all write `label || null`. That is the Python's rule
 * (`if v is None or v is False: continue`) and callers depend on it.
 *
 * Sorting is on the *rendered* name, so `dataTip` and `data_tip` sort identically.
 * Sorted keys keep the output byte-stable.
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
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
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
 * `<wa-icon>` — Font Awesome Free **solid**; the kit autoloads the element.
 *
 * `label` is the accessible name. Omit it for a decorative icon sitting beside text
 * that already says the same thing; supply it for an icon-only control. An icon is
 * never the only channel for a status — that is what `chip()` enforces.
 *
 * @param {string} name @param {Object} [opts] @param {string} [opts.label]
 * @returns {string}
 */
export function waIcon(name, opts = {}) {
  const { label = '', ...rest } = opts;
  return el('wa-icon', '', { name, label: label || null, ...rest });
}

/**
 * `<wa-card>` with optional header/footer slots.
 *
 * Passing a header or footer adds the `with-header` / `with-footer` attributes,
 * which WebAwesome requires for the slot to be laid out.
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
 * `<wa-tag>` — a static label chip. Text is escaped.
 *
 * `icon` prepends a `<wa-icon>` in the tag's default slot; `wa-tag` has no `start`
 * slot, and its `:host` gap spaces the icon from the word. Prefer `chip()` whenever
 * the tag is carrying a *status*, which must never be colour alone.
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
 * breaks MapLibre's sizing (the drafts carry this comment and it is correct).
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
 * `<wa-copy-button>` carrying `payload` as its `value` (escaped as an attribute).
 *
 * Used for the border GeoJSON: the rulebook's hard requirement is that every player
 * uses the *exact same* border, so it has to be copy-pasteable.
 *
 * @param {string} payload @param {Object} [opts]
 * @returns {string}
 */
export function waCopyButton(payload, opts = {}) {
  const { label = 'Copy', ...rest } = opts;
  return el('wa-copy-button', '', { value: payload, copyLabel: label, ...rest });
}

/**
 * `<wa-chart>` with an inline Chart.js config.
 *
 * `configJson` must come from `jdump()` so the markup is byte-stable.
 *
 * Chart.js cannot resolve `var(--x)`, but `wa-chart` resolves it *for* Chart.js on the
 * dataset keys it knows — `backgroundColor`, `borderColor`, `pointBackgroundColor`,
 * `borderWidth`, `pointRadius` — and on every option in its own transform schema. It
 * writes the string onto a hidden `#property-calculator` div in its shadow root, reads
 * `getComputedStyle`, and registers each custom property with a StyleObserver, so those
 * values re-resolve on a light/dark flip. `"backgroundColor":"var(--seq-550)"` in a JSON
 * config is therefore correct, and *preferable* to `cssVar()`, which snapshots the
 * colour once — see `budgetBar`.
 *
 * `cssVar()` is still required for (a) keys outside that schema — `borderRadius`,
 * `barThickness`, `barPercentage` — and (b) a custom plugin's own `ctx.fillStyle`, which
 * is why `ttDecor` and `budgetSeg` use it. One trap: `borderWidth`'s transform is
 * `Number`, so the per-side object form yields `NaN`.
 *
 * A slotted `<script type="application/json">` WINS over the `.config` property —
 * `renderChart()` re-parses it on every render, including theme-flip repaints — so never
 * ship both. `.plugins` is merged in afterwards and is the supported escape hatch.
 *
 * `</` is escaped the same way `jsonBlock` escapes it. The Python omits this here;
 * it is added deliberately, because a chart config can carry a route or stop name
 * and `</script>` inside one would otherwise close the block. `<\/` inside a JSON
 * string literal decodes to `/`, so the parsed config is unchanged.
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
 * `labelHtml` fills each item's `label` slot, so a *collapsed* label can still carry
 * a progress bar or a badge — which is the whole point of preferring this to tabs.
 * `itemId` becomes the item's `id`, so a `#fragment` addresses it and
 * `openTargeted()` expands every ancestor disclosure before scrolling.
 *
 * NEVER put a map or a chart inside one. MapLibre and Chart.js read their container
 * size once, at construction, a collapsed item has none, and nothing in this file
 * ever calls `.resize()` — the same reason `waScroller` forbids it.
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
      className: 'wa-split wa-align-items-center wa-gap-s',
      style: 'flex:1',
    }) + bodyHtml,
    { id: itemId || null, expanded: expanded ? true : null },
  )).join('');
  return el('wa-accordion', body, { mode, appearance, headingLevel, ...rest });
}


// ── design primitives: the three tiers (grade · rubric · evidence) ────────────

/**
 * A status chip: icon **and** word, never colour alone.
 *
 * The only sanctioned way to render a question status, a curse action, a finding
 * severity or a metric source on either page. The reason is measured: against the
 * warm-paper surface `--warn` is 1.66:1, `--gold` 1.96:1 and `--q-edge` 2.07:1, all
 * under the 3:1 non-text floor, so the hue cannot carry the signal by itself. Those
 * hues are the page's identity and stay; the word and the icon are the redundancy.
 *
 * `appearance` is `wa-tag`'s, which has no `plain`: use `outlined` (the default),
 * `filled`, `filled-outlined` or `accent`. Anything else is silently ignored and
 * renders as the default.
 *
 * @param {string} text @param {string} [iconName] @param {Object} [opts]
 * @returns {string}
 */
export function chip(text, iconName = '', opts = {}) {
  const { variant = 'neutral', appearance = 'outlined', ...rest } = opts;
  return waTag(text, { variant, appearance, icon: iconName, ...rest });
}

/**
 * A label / track / value row — the rubric tier's workhorse.
 *
 * `valuePct` is 0–100 and is computed by the caller, never here. `labelHtml` and
 * `rightHtml` are markup. Rubric is never collapsed: it is what makes a headline
 * number checkable rather than decorative.
 *
 * `opts.label` is the bar's accessible name and must be plain text — `labelHtml` is
 * often an anchor, and `wa-progress-bar` puts `label` straight into `aria-label`.
 * Without it every bar on the page announces as the generic "Progress".
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
    className: 'wa-flank:end wa-gap-s wa-align-items-center',
    style: `--flank-size:${flank}`,
    ...rest,
  });
}

/**
 * The Points Budget / deck strip — one category, one dataset per segment, stacked.
 *
 * `segments` are `[letter, value, tipText]` triples whose values sum to at most
 * `total`; each becomes its own single-point dataset, and `stacked` lays them along
 * one row. If the segments fall short a final un-earned dataset is appended in the
 * de-emphasis grey. `tipText` becomes the dataset `label`, which is what the hover
 * reads — see `budgetSeg` in app.js.
 *
 * A `wa-chart` (`stacked` + `index-axis="y"`), not `wa-progress-bar`: that is a
 * single-fill track (one `value`, one `--indicator-color`) and cannot show six
 * segments. Two things this element cannot do declaratively, both handled by the one
 * `budgetSeg` plugin in app.js: chart.js registers no datalabels plugin, so the A–F
 * letters are painted in `afterDatasetsDraw`; and Chart.js's own tooltip draws
 * *inside* the canvas, where a 20px-tall bar clips it to nothing, so hover is routed
 * to the same `#tt` panel the heatmap uses. `letter` and `ink` are extra dataset keys
 * — `wa-chart` deep-clones the config and only rewrites keys in its own schema, so
 * they survive verbatim into Chart.js.
 *
 * `variants` is optional and parallel to `segments`: each entry is a WebAwesome
 * variant (`success`, `warning`, `danger`, `brand`, `neutral`), which becomes an
 * explicit `var(--wa-color-<variant>-fill-loud)` — a canvas cannot carry the
 * `.wa-success` utility class. Use it only when the segments encode *state* and
 * something beside the bar is acting as a colour legend; leave it empty when they
 * encode identity, where one hue is correct.
 *
 * Never nest one inside a disclosure: it is rubric, not evidence — and a canvas in a
 * `display:none` subtree measures 0 and renders empty.
 *
 * Pass `height`, never `style`: `style` would replace the whole style string and drop
 * `aspect-ratio:auto`, letting the component's own `:host{aspect-ratio:16/9}` win.
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
  // omit it and the component assigns `var(--border-color-N)` by dataset index,
  // painting six pastel hairlines. `borderWidth` must stay a scalar — its transform
  // is `Number`, so the per-side object form yields NaN.
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
 * A native `<input type="search">`, skinned by WebAwesome's `native.css`.
 *
 * A real `<wa-input>` would add a custom element per table for no gain, and the
 * native control stays usable with scripting off.
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
 * The page's one counter-intuitive claim, set as an editorial pull quote.
 *
 * `native.css` already gives `<blockquote>` its leading border, quiet colour and
 * serif face, so this costs no CSS. Exactly one per page.
 *
 * @param {string} text
 * @returns {string}
 */
export function pullQuote(text) {
  return el('blockquote', el('p', esc(text), { className: 'wa-longform-xl' }));
}

// ── page-level composition helpers ───────────────────────────────────────────

/**
 * A numbered editorial `<section>` with the drafts' heading treatment.
 *
 * `number` renders through `h2[data-n]::before`, so it exists only as an attribute
 * and never as text a screen reader has to read twice.
 *
 * `answerHtml` is ONE plain-English sentence carrying the two or three numbers that
 * matter, set as a quiet tinted strip above the evidence. Every number in it must
 * already be produced by an existing helper or `Report` field — a renderer chooses
 * where a value appears and what word labels it, never what it is.
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
 * The drafts' stat-tile inner block: big number, caption, optional note.
 *
 * `chipHtml` sits under the value — it is where a "changes by day" chip goes, so the
 * gold top rule on a day-sensitive tile carries a word as well as a colour.
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
 * A provenance chip — the drafts' superscript citation mechanism, repurposed.
 *
 * Every printed number carries the id of the metric or map-data category that produced
 * it; the chip links to that row in the score trace or the provenance section, both
 * of which the sources index gives a named home. This is how "every point traces to a
 * named metric" actually reaches the UI.
 *
 * Variadic, like the Python.
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
 * A `<table>` from plain-text headers and **pre-escaped** row cells.
 *
 * Row cells are markup (so a cell can hold a `wa-tag`); headers are text. Always
 * wrapped in a `wa-scroller`, because long tables must scroll inside their own
 * container, never the page body.
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
 * Embed a payload as `<script type="application/json" id="…">`.
 *
 * Every `<` is escaped so a hostile stop name cannot break out of its own script tag.
 * Parsed once at the top of the page script; one block per concern, so a huge POI set
 * does not have to be parsed to render the verdict.
 *
 * @param {string} blockId @param {*} payload
 * @returns {string}
 */
export function jsonBlock(blockId, payload) {
  return el('script', jsonSafe(jdump(payload, { floatDp: 6 })),
    { type: 'application/json', id: blockId });
}

/**
 * Make a JSON document safe as the text content of a `<script>` element.
 *
 * The Python escapes `</` alone, which stops the obvious `</script>` break-out but
 * NOT the one that actually gets pages owned: inside script data, `<!--` puts the
 * tokeniser into the *escaped* state and a following `<script` puts it into the
 * *double-escaped* state, where the block's own `</script>` no longer ends the
 * element. A stop named `<!--<script>` would therefore swallow the rest of the
 * document. Escaping every `<` closes all three sequences at once, and it is exact:
 * structural JSON contains no `<`, so the only `<` in the text is inside a string
 * literal, where `<` decodes back to `<` and the parsed value is unchanged.
 *
 * @param {string} json
 * @returns {string}
 */
function jsonSafe(json) {
  return String(json).split('<').join('\\u003c');
}
