/** Shared UI helpers: formatting, money inputs, URL state, DOM helpers. */

const gbp0 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
const gbp2 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

export const fmt = {
  gbp: (v, dp = 0) => (dp ? gbp2 : gbp0).format(Math.abs(v) < 0.005 ? 0 : v),
  gbpSigned: (v, dp = 0) => (v < -0.005 ? '−' : '') + (dp ? gbp2 : gbp0).format(Math.abs(v)),
  pct: (v, dp = 1) => `${(v * 100).toFixed(dp).replace(/\.0+$/, '')}%`,
  num: (v) => n0.format(v),
  months: (m) => {
    const y = Math.floor(m / 12), r = m % 12;
    const parts = [];
    if (y) parts.push(`${y} year${y === 1 ? '' : 's'}`);
    if (r) parts.push(`${r} month${r === 1 ? '' : 's'}`);
    return parts.join(' ') || '0 months';
  },
};

export function parseNum(v) {
  const cleaned = String(v ?? '').replace(/[£,\s]/g, '');
  if (cleaned === '' || !/^-?\d*\.?\d+(e[+-]?\d+)?$/i.test(cleaned)) return 0; // junk such as "abc" counts as nothing
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/** Make text inputs with data-money behave like friendly currency fields. */
export function initMoneyInputs(root = document) {
  root.querySelectorAll('input[data-money]').forEach((input) => {
    input.setAttribute('inputmode', 'decimal');
    input.setAttribute('autocomplete', 'off');
    const format = () => {
      const n = Math.max(0, parseNum(input.value)); // money is never negative
      if (input.value.trim() === '' || n === 0) { input.value = input.value.trim() === '' ? '' : '0'; return; }
      const dp = input.dataset.money === '2' ? 2 : 0;
      input.value = n.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: 2 });
    };
    input.addEventListener('blur', format);
    input.addEventListener('focus', () => { if (parseNum(input.value) === 0) input.select(); });
    if (input.value) format();
  });
}

/** Number inputs with min/max: show the clamped value rather than silently using a different one. */
export function initNumberInputs(root = document) {
  root.querySelectorAll('input[type="number"]').forEach((input) => {
    input.addEventListener('blur', () => {
      if (input.value.trim() === '') return;
      let n = Number(input.value);
      if (!Number.isFinite(n)) { input.value = ''; return; }
      if (input.min !== '' && n < Number(input.min)) n = Number(input.min);
      if (input.max !== '' && n > Number(input.max)) n = Number(input.max);
      if (String(n) !== input.value) { input.value = String(n); input.dispatchEvent(new Event('input', { bubbles: true })); }
    });
  });
}

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Simple table of [label, value, opts] rows. */
export function linesTable(rows, { header } = {}) {
  const table = el('table', { class: 'lines' });
  if (header) table.append(el('thead', {}, el('tr', {}, header.map((h) => el('th', { text: h })))));
  const tbody = el('tbody');
  for (const r of rows) {
    if (!r) continue;
    const [label, value, opts = {}] = r;
    const tr = el('tr', { class: [opts.total ? 'total' : '', opts.sub ? 'sub' : ''].join(' ').trim() || null });
    const tdl = el('td', {}, [label]);
    if (opts.note) tdl.append(el('span', { class: 'note', text: opts.note }));
    tr.append(tdl);
    if (opts.mid != null) tr.append(el('td', { class: 'num', text: opts.mid }));
    tr.append(el('td', { class: opts.neg ? 'neg' : null, text: value }));
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

/** Read/write form state to the URL query string so results can be shared. */
export const urlState = {
  read() {
    const p = new URLSearchParams(location.search);
    const out = {};
    for (const [k, v] of p.entries()) out[k] = v;
    return out;
  },
  write(obj) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(obj)) {
      if (v === '' || v == null || v === false) continue;
      const str = String(v);
      // formatted money such as "320,000" is stored as plain digits
      p.set(k, /^-?[\d,]+(\.\d+)?$/.test(str) ? str.replace(/,/g, '') : str);
    }
    const qs = p.toString();
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
  },
};

export function debounce(fn, ms = 120) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Stamped by scripts/stamp-assets.mjs; changes whenever the tax-year data changes so that
// browsers never pair new code with cached old data.
export const DATA_VERSION = 'fe33481113';

export async function loadJSON(url) {
  const versioned = DATA_VERSION && url.startsWith('/data/') ? `${url}${url.includes('?') ? '&' : '?'}v=${DATA_VERSION}` : url;
  const res = await fetch(versioned);
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  return res.json();
}
