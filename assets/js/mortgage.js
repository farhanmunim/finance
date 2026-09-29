import { amortise, compare, monthlyPayment } from './mortgage-engine.js';
import { fmt, parseNum, initMoneyInputs, $, $$, el, linesTable, urlState, debounce } from './ui.js';

const form = $('#form');
const results = $('#results');
const COLOR_BASE = '#2a78d6';
const COLOR_OVER = '#eb6834';

function init() {
  restoreFromUrl();
  initMoneyInputs(form);
  const rerender = debounce(() => { syncVisibility(); render(); }, 80);
  form.addEventListener('input', rerender);
  form.addEventListener('change', () => { syncVisibility(); render(); });
  form.addEventListener('submit', (e) => e.preventDefault());
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', debounce(() => { if (window.innerWidth !== lastWidth) { lastWidth = window.innerWidth; render(); } }, 150));
  syncVisibility();
  render();
}

function syncVisibility() {
  const f = form;
  $('#depAffix').textContent = f.dt.value === 'percent' ? '%' : '£';
  $('#payment-field').hidden = !f.op.checked;
  $('#own-payment-toggle').hidden = f.type.value === 'interest_only';
  $('#effect-field').hidden = f.type.value === 'interest_only' || f.op.checked;
  $('#type-hint').textContent = f.type.value === 'interest_only'
    ? 'Each payment covers only the interest. The full loan is still owed at the end of the term.'
    : "Each payment covers interest and part of the loan, so it's fully repaid at the end of the term.";
}

function readForm() {
  const f = form;
  const raw = { pv: f.pv.value, dep: f.dep.value, dt: f.dt.value, t: f.t.value, r: f.r.value, type: f.type.value, fy: f.fy.value, rr: f.rr.value, op: f.op.checked ? '1' : '', pay: f.pay.value, mo: f.mo.value, ao: f.ao.value, ls: f.ls.value, ly: f.ly.value, eff: f.eff.value };
  const price = parseNum(raw.pv);
  const depositInput = parseNum(raw.dep);
  const deposit = raw.dt === 'percent' ? price * depositInput / 100 : depositInput;
  const principal = Math.max(0, price - deposit);
  const termYears = Math.max(1, Math.min(40, Math.round(parseNum(raw.t)) || 25));
  const opts = {
    principal,
    termMonths: termYears * 12,
    annualRate: parseNum(raw.r),
    type: raw.type,
    fixedMonths: Math.round(parseNum(raw.fy)) * 12,
    revertRate: raw.rr.trim() === '' ? null : parseNum(raw.rr),
    payment: raw.op && raw.type === 'repayment' ? parseNum(raw.pay) : 0,
    monthlyOverpayment: parseNum(raw.mo),
    annualOverpayment: parseNum(raw.ao),
    lumpSum: parseNum(raw.ls),
    lumpSumMonth: Math.max(1, Math.round(parseNum(raw.ly)) || 1) * 12,
    overpaymentEffect: raw.eff,
  };
  return { raw, opts, price, deposit, principal, termYears };
}

function restoreFromUrl() {
  const q = urlState.read();
  const f = form;
  const setRadio = (name, v) => { const r = $(`input[name="${name}"][value="${v}"]`, f); if (r) r.checked = true; };
  for (const k of ['pv', 'dep', 't', 'r', 'fy', 'rr', 'pay', 'mo', 'ao', 'ls', 'ly']) if (q[k] != null && f[k]) f[k].value = q[k];
  if (q.dt) setRadio('dt', q.dt);
  if (q.type) setRadio('type', q.type);
  if (q.eff) setRadio('eff', q.eff);
  if (q.op) f.op.checked = true;
  if (q.fy || q.rr) $('#rate-period').open = true;
}

function render() {
  const { raw, opts, price, deposit, principal, termYears } = readForm();
  urlState.write(raw);
  const note = $('#loan-note');
  if (principal > 0 && price > 0) {
    const ltv = principal / price;
    note.innerHTML = `Loan amount <b class="num">${fmt.gbp(principal)}</b> · loan-to-value <b class="num">${fmt.pct(ltv, 0)}</b>${ltv > 0.95 ? ' <span style="color:var(--warn)">(few lenders go above 95%)</span>' : ''}`;
  } else {
    note.textContent = 'Enter a property value and deposit to see your loan amount.';
  }

  results.innerHTML = '';
  $('#mobile-summary').hidden = true;
  if (principal <= 0 || raw.r.trim() === '') {
    results.append(el('div', { class: 'card' }, el('p', { class: 'muted', text: 'Enter your property value, deposit and interest rate to see your payments.' })));
    return;
  }
  const c = compare(opts);
  const main = c.hasOverpayments ? c.withOverpayments : c.base;
  if (!main.ok) {
    results.append(el('div', { class: 'card note-box warn' }, main.warnings.map((w) => el('p', { text: w }))));
    return;
  }
  results.append(heroCard(c, opts, principal, price, termYears));
  if (c.hasOverpayments) results.append(comparisonCard(c, opts));
  results.append(chartCard(c, opts));
  results.append(scheduleCard(main, c));
  results.append(assumptionsCard(opts));
  $('#ms-pay').textContent = fmt.gbp(main.initialPayment, 2);
  $('#ms-int').textContent = fmt.gbp(main.totalInterest);
  $('#mobile-summary').hidden = false;
}

function tile(k, v, s, primary) {
  return el('div', { class: `tile${primary ? ' primary' : ''}` }, [el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }), s ? el('div', { class: 's', text: s }) : null]);
}
function stat(k, v, s) {
  return el('div', { class: 'stat' }, [el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }), s ? el('div', { class: 's', text: s }) : null]);
}
function payoffDate(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

function heroCard(c, opts, principal, price, termYears) {
  const r = c.hasOverpayments ? c.withOverpayments : c.base;
  const io = opts.type === 'interest_only';
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'card-header' }, [el('div', {}, [el('h2', { text: c.hasOverpayments ? 'Your mortgage with overpayments' : 'Your mortgage' }), el('p', { text: `${fmt.gbp(principal)} over ${termYears} years at ${opts.annualRate}%${opts.fixedMonths ? ` for ${opts.fixedMonths / 12} years, then ${opts.revertRate ?? opts.annualRate}%` : ''} · ${io ? 'interest only' : 'repayment'}` })])]));
  const paymentSub = r.paymentChanges.length > 1 ? `then ${fmt.gbp(r.paymentChanges[1].amount, 2)} from month ${r.paymentChanges[1].fromMonth}` : 'a month';
  card.append(el('div', { class: 'hero' }, [
    tile('Monthly payment', fmt.gbp(r.initialPayment, 2), paymentSub + (c.hasOverpayments && opts.monthlyOverpayment ? ` + ${fmt.gbp(opts.monthlyOverpayment)} overpayment` : ''), true),
    tile('Total interest', fmt.gbp(r.totalInterest), `over ${fmt.months(r.months)}`),
    tile(io ? 'Still owed at the end' : 'Total repaid', fmt.gbp(io ? r.closingBalance : r.totalPaid), io ? 'interest-only leaves the loan unpaid' : 'loan plus interest'),
  ]));
  const ltv = price > 0 ? principal / price : 0;
  card.append(el('div', { class: 'stat-row', style: 'margin-top:14px' }, [
    stat('Loan-to-value', fmt.pct(ltv, 0), `${fmt.gbp(principal)} of ${fmt.gbp(price)}`),
    stat(io ? 'Term ends' : 'Paid off', payoffDate(r.months), fmt.months(r.months) + ' from now'),
    stat('Interest as share of payments', r.totalPaid > 0 ? fmt.pct(r.totalInterest / r.totalPaid, 0) : '0%', 'of everything you pay'),
  ]));
  if (r.warnings.length) card.append(el('div', { class: 'note-box warn', style: 'margin-top:14px' }, r.warnings.map((w) => el('p', { text: w }))));
  if (r.paymentChanges.length > 1 && !c.hasOverpayments) {
    card.append(el('div', { class: 'note-box', style: 'margin-top:14px', html: `When your deal ends in month ${r.paymentChanges[1].fromMonth} the rate moves to ${r.paymentChanges[1].rate}% and the payment becomes <b class="num">${fmt.gbp(r.paymentChanges[1].amount, 2)}</b>. Most people remortgage to a new deal at that point.` }));
  }
  return card;
}

function comparisonCard(c, opts) {
  const b = c.base, w = c.withOverpayments;
  const io = opts.type === 'interest_only';
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'card-header' }, [el('div', {}, [el('h2', { text: 'What overpaying saves you' }), el('p', { text: 'Compared with paying only the standard amount.' })])]));
  const headline = io
    ? `You'd owe <b class="num">${fmt.gbp(c.balanceReduced)}</b> less at the end of the term and pay <b class="num">${fmt.gbp(c.interestSaved)}</b> less interest.`
    : opts.overpaymentEffect === 'reduce_payment'
      ? `You'd pay <b class="num">${fmt.gbp(c.interestSaved)}</b> less interest over the term, and your monthly payment falls to <b class="num">${fmt.gbp(w.paymentChanges[w.paymentChanges.length - 1].amount, 2)}</b>.`
      : `You'd be mortgage-free <b>${fmt.months(c.monthsSaved)}</b> earlier and pay <b class="num">${fmt.gbp(c.interestSaved)}</b> less interest.`;
  card.append(el('div', { class: 'note-box good', html: headline }));
  card.append(linesTable([
    ['Total interest', fmt.gbp(w.totalInterest), { mid: fmt.gbp(b.totalInterest) }],
    ['Total paid', fmt.gbp(w.totalPaid), { mid: fmt.gbp(b.totalPaid) }],
    ['Overpaid in total', fmt.gbp(w.totalOverpaid), { mid: fmt.gbp(0) }],
    io ? ['Owed at end of term', fmt.gbp(w.closingBalance), { mid: fmt.gbp(b.closingBalance) }] : ['Time to pay off', fmt.months(w.months), { mid: fmt.months(b.months) }],
    ['Interest saved', fmt.gbp(c.interestSaved), { total: true, mid: '' }],
  ], { header: ['', 'Standard', 'With overpayments'] }));
  card.append(el('details', { class: 'explain' }, [el('summary', { text: 'Why does overpaying save so much?' }), el('div', { class: 'body' }, [
    el('p', { text: 'Interest is charged on the balance you still owe. Every pound you overpay stops earning interest for the lender from that month on, for the rest of the term. Overpaying early in the mortgage saves the most because the balance (and so the interest) is largest then.' }),
    el('p', { style: 'margin-top:8px', text: 'Check your deal\'s overpayment limit (often 10% of the balance each year) - paying more than that can trigger an early repayment charge.' }),
  ])]));
  return card;
}

// ------------------------------------------------------------------ chart
function chartCard(c, opts) {
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'card-header' }, [el('div', {}, [el('h2', { text: 'Balance over time' }), el('p', { text: 'How much you still owe at the end of each year.' })])]));
  const series = [{ name: 'Standard payments', color: COLOR_BASE, data: yearlyBalances(c.base, opts.principal) }];
  if (c.hasOverpayments) series.push({ name: 'With overpayments', color: COLOR_OVER, data: yearlyBalances(c.withOverpayments, opts.principal) });
  card.append(lineChart(series));
  return card;
}

function yearlyBalances(run, principal) {
  const pts = [{ x: 0, y: principal }];
  for (const y of run.yearly) pts.push({ x: y.year, y: y.closing });
  return pts;
}

function lineChart(series) {
  const W = Math.max(320, Math.min(760, (results.clientWidth || 640) - 42));
  const H = Math.round(W < 480 ? W * 0.62 : W * 0.47);
  const m = { top: 16, right: 20, bottom: 36, left: 56 };
  const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
  const xMax = Math.max(1, ...series.map((s) => s.data[s.data.length - 1].x));
  const yMax = Math.max(1, ...series.flatMap((s) => s.data.map((p) => p.y)));
  const niceY = niceCeil(yMax);
  const sx = (x) => m.left + (x / xMax) * iw;
  const sy = (y) => m.top + ih - (y / niceY) * ih;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Line chart of outstanding mortgage balance by year');
  const add = (tag, attrs, parent = svg) => { const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); parent.append(n); return n; };

  // grid + y labels
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const v = (niceY / ySteps) * i, y = sy(v);
    add('line', { x1: m.left, x2: W - m.right, y1: y, y2: y, stroke: '#e5e7eb', 'stroke-width': 1 });
    const t = add('text', { x: m.left - 8, y: y + 4, 'text-anchor': 'end', 'font-size': 12, fill: '#6b7280' });
    t.textContent = compactGbp(v);
  }
  // x labels
  const xStep = xMax <= 10 ? 1 : xMax <= 20 ? 2 : 5;
  for (let x = 0; x <= xMax; x += xStep) {
    const t = add('text', { x: sx(x), y: H - m.bottom + 18, 'text-anchor': 'middle', 'font-size': 12, fill: '#6b7280' });
    t.textContent = x === 0 ? 'Now' : `Yr ${x}`;
  }
  add('line', { x1: m.left, x2: W - m.right, y1: sy(0), y2: sy(0), stroke: '#d1d5db', 'stroke-width': 1 });

  for (const s of series) {
    const d = s.data.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
    add('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  }
  // hover layer
  const cross = add('line', { x1: 0, x2: 0, y1: m.top, y2: m.top + ih, stroke: '#9ca3af', 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0 });
  const dots = series.map((s) => add('circle', { r: 4.5, fill: s.color, stroke: '#fff', 'stroke-width': 2, opacity: 0 }));
  const wrap = el('div', { class: 'chart-wrap' });
  const tip = el('div', { class: 'chart-tip' });
  wrap.append(svg, tip);
  const onMove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const x = Math.round(((px - m.left) / iw) * xMax);
    if (x < 0 || x > xMax) return onLeave();
    cross.setAttribute('x1', sx(x)); cross.setAttribute('x2', sx(x)); cross.setAttribute('opacity', 1);
    const lines = [`<div>${x === 0 ? 'Now' : `End of year ${x}`}</div>`];
    series.forEach((s, i) => {
      const p = s.data.find((q) => q.x === x);
      if (p) { dots[i].setAttribute('cx', sx(x)); dots[i].setAttribute('cy', sy(p.y)); dots[i].setAttribute('opacity', 1); lines.push(`<div><span style="color:${s.color}">●</span> ${s.name}: <b>${fmt.gbp(p.y)}</b></div>`); }
      else dots[i].setAttribute('opacity', 0);
    });
    tip.innerHTML = lines.join('');
    tip.style.left = `${(sx(x) / W) * rect.width}px`;
    tip.style.top = `${(m.top / H) * rect.height + 10}px`;
    tip.classList.add('show');
  };
  const onLeave = () => { cross.setAttribute('opacity', 0); dots.forEach((d) => d.setAttribute('opacity', 0)); tip.classList.remove('show'); };
  svg.addEventListener('mousemove', onMove);
  svg.addEventListener('touchmove', (e) => { onMove(e.touches[0]); }, { passive: true });
  svg.addEventListener('mouseleave', onLeave);
  svg.addEventListener('touchend', onLeave);

  const legend = el('div', { class: 'legend' }, series.map((s) => el('span', { style: `--c:${s.color}`, text: s.name })));
  return el('div', {}, [wrap, legend]);
}

function niceCeil(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return n * p;
}
function compactGbp(v) {
  if (v >= 1e6) return `£${(v / 1e6).toFixed(v % 1e6 ? 1 : 0)}m`;
  if (v >= 1e3) return `£${Math.round(v / 1e3)}k`;
  return `£${Math.round(v)}`;
}

// ------------------------------------------------------------------ schedule
function scheduleCard(run, c) {
  const card = el('details', { class: 'section' });
  card.append(el('summary', {}, el('span', {}, ['Year-by-year breakdown', el('span', { class: 'sub', text: c.hasOverpayments ? 'With your overpayments included' : 'Standard payments' })])));
  const body = el('div', { class: 'body' });
  const table = el('table', { class: 'lines' });
  table.append(el('thead', {}, el('tr', {}, ['Year', 'Paid', 'Interest', 'Loan repaid', 'Balance'].map((h, i) => el('th', { text: h, style: i ? 'text-align:right' : '' })))));
  const tbody = el('tbody');
  for (const y of run.yearly) {
    tbody.append(el('tr', {}, [
      el('td', { text: String(y.year) }),
      el('td', { class: 'num', style: 'text-align:right', text: fmt.gbp(y.paid) }),
      el('td', { class: 'num', style: 'text-align:right', text: fmt.gbp(y.interest) }),
      el('td', { class: 'num', style: 'text-align:right', text: fmt.gbp(y.principal) }),
      el('td', { class: 'num', style: 'text-align:right', text: fmt.gbp(y.closing) }),
    ]));
  }
  table.append(tbody);
  body.append(el('div', { style: 'overflow-x:auto' }, table));
  if (run.paymentChanges.length > 1) {
    body.append(el('h3', { text: 'Payment changes', style: 'margin:16px 0 8px' }));
    body.append(linesTable(run.paymentChanges.map((p) => [`From month ${p.fromMonth} at ${p.rate}%`, fmt.gbp(p.amount, 2)])));
  }
  card.append(body);
  return card;
}

function assumptionsCard(opts) {
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'card-header' }, [el('div', {}, [el('h2', { text: 'How this is worked out' })])]));
  card.append(el('ul', { class: 'small', style: 'margin:0; padding-left:18px; color:var(--text-2)' }, [
    el('li', { html: 'Interest is added monthly at one twelfth of the annual rate on the balance at the start of the month, and payments are made at the end of each month. This is the standard formula lenders quote; real lenders charge daily so figures may differ by a few pounds.' }),
    el('li', { html: 'The monthly payment is the fixed amount that clears the loan exactly at the end of the term. When the rate changes it is recalculated on the remaining balance and term.' }),
    el('li', { html: 'Overpayments come off the balance immediately. "Pay it off sooner" keeps the payment the same; "lower my monthly payment" recalculates the payment over the remaining term after each overpayment.' }),
    el('li', { html: 'Arrangement fees, early repayment charges, insurance and changes to the rate after the deal ends (beyond the one you enter) are not included.' }),
  ]));
  return card;
}

init();
