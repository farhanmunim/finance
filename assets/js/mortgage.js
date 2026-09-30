import { amortise, compare, overpayVsSave, breakEvenSavingsRate, rateSensitivity, ltvBands } from './mortgage-engine.js?v=61f5bba74e';
import { propertyIncrementalTax } from './tax-engine.js?v=fdea76ad1f';
import { fmt, parseNum, initMoneyInputs, $, $$, el, linesTable, urlState, debounce, loadJSON } from './ui.js?v=4673fe000f';

const form = $('#form');
const results = $('#results');
const COLOR_BASE = '#2a78d6';
const COLOR_OVER = '#eb6834';
const state = { rates: null, ratesLabel: '' };

async function init() {
  restoreFromUrl();
  loadRates().then(() => render());
  initMoneyInputs(form);
  const rerender = debounce(() => { syncVisibility(); render(); }, 80);
  form.addEventListener('input', rerender);
  form.addEventListener('change', (e) => { if (e.target.matches('input:not([type=radio]):not([type=checkbox])')) return; syncVisibility(); render(); });
  form.addEventListener('submit', (e) => e.preventDefault());
  $('#deposit').addEventListener('blur', formatDeposit);
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', debounce(() => { if (window.innerWidth !== lastWidth) { lastWidth = window.innerWidth; render(); } }, 150));
  syncVisibility();
  render();
}

async function loadRates() {
  try {
    const index = await loadJSON('/data/tax-years/index.json');
    const meta = index.years.find((y) => y.id === index.default) || index.years[0];
    state.rates = await loadJSON(meta.file);
    state.ratesLabel = state.rates.label;
  } catch (e) {
    state.rates = null;
  }
}

/** Tax treatment of savings interest for the chosen band: rate and Personal Savings Allowance. */
function savingsTaxFor(band) {
  if (band === 'isa') return { rate: 0, allowance: 0, label: 'ISA, no tax' };
  const it = state.rates?.incomeTax;
  const fallback = { basic: [0.2, 1000], higher: [0.4, 500], additional: [0.45, 0] };
  if (!fallback[band]) band = 'basic';
  const rate = it ? (it.bands.ruk.find((b) => b.id === band)?.rate ?? fallback[band][0]) : fallback[band][0];
  const allowance = it ? (it.savings.personalSavingsAllowance[band] ?? fallback[band][1]) : fallback[band][1];
  return { rate, allowance, label: `${fmt.pct(rate, 0)} above a ${fmt.gbp(allowance)} savings allowance` };
}

function formatDeposit() {
  const f = form;
  const n = parseNum(f.dep.value);
  if (f.dep.value.trim() === '' || n === 0) return;
  f.dep.value = f.dt.value === 'percent' ? String(Math.round(n * 100) / 100) : n.toLocaleString('en-GB', { maximumFractionDigits: 0 });
}

let lastDepositType = null;
function syncVisibility() {
  const f = form;
  // Switching £ <-> % converts the figure so the deposit stays the same
  if (lastDepositType && lastDepositType !== f.dt.value) {
    const price = parseNum(f.pv.value), n = parseNum(f.dep.value);
    if (price > 0 && n > 0) f.dep.value = f.dt.value === 'percent' ? String(Math.round((n / price) * 10000) / 100) : String(Math.round(price * n / 100));
  }
  lastDepositType = f.dt.value;
  $('#depAffix').textContent = f.dt.value === 'percent' ? '%' : '£';
  if (document.activeElement !== f.dep) formatDeposit();
  $('#payment-field').hidden = !f.op.checked;
  $('#own-payment-toggle').hidden = f.type.value === 'interest_only';
  $('#effect-field').hidden = f.type.value === 'interest_only' || f.op.checked;
  $('#type-hint').textContent = f.type.value === 'interest_only'
    ? 'Each payment covers only the interest. The full loan is still owed at the end of the term.'
    : "Each payment covers interest and part of the loan, so it's fully repaid at the end of the term.";
}

function readForm() {
  const f = form;
  const raw = { pv: f.pv.value, dep: f.dep.value, dt: f.dt.value, t: f.t.value, r: f.r.value, type: f.type.value, fy: f.fy.value, rr: f.rr.value, op: f.op.checked ? '1' : '', pay: f.pay.value, mo: f.mo.value, ao: f.ao.value, ls: f.ls.value, ly: f.ly.value, eff: f.eff.value,
    sr: f.sr.value, sb: f.sb.value, rent: f.rent.value, bex: f.bex.value, oi: f.oi.value, reg: f.reg.value };
  const price = parseNum(raw.pv);
  const depositInput = parseNum(raw.dep);
  const deposit = raw.dt === 'percent' ? price * depositInput / 100 : depositInput;
  const principal = Math.max(0, price - deposit);
  const termYearsRaw = Math.round(parseNum(raw.t)) || 25;
  const termYears = Math.max(1, Math.min(40, termYearsRaw));
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
  const extras = {
    savingsRate: raw.sr.trim() === '' ? null : parseNum(raw.sr),
    savingsBand: raw.sb,
    rentMonthly: parseNum(raw.rent),
    btlExpenses: parseNum(raw.bex),
    otherIncome: parseNum(raw.oi),
    region: raw.reg,
  };
  return { raw, opts, price, deposit, principal, termYears, termClamped: termYearsRaw !== termYears, extras };
}

function restoreFromUrl() {
  const q = urlState.read();
  const f = form;
  const setRadio = (name, v) => { const r = $(`input[name="${name}"][value="${v}"]`, f); if (r) r.checked = true; };
  for (const k of ['pv', 'dep', 't', 'r', 'fy', 'rr', 'pay', 'mo', 'ao', 'ls', 'ly', 'sr', 'rent', 'bex', 'oi']) if (q[k] != null && f[k]) f[k].value = q[k];
  if (q.sb) f.sb.value = q.sb;
  if (q.reg) setRadio('reg', q.reg);
  if (q.sr) $('#sec-save').open = true;
  if (q.rent) $('#sec-btl').open = true;
  if (q.dt) setRadio('dt', q.dt);
  if (q.type) setRadio('type', q.type);
  if (q.eff) setRadio('eff', q.eff);
  if (q.op) f.op.checked = true;
  if (q.fy || q.rr) $('#rate-period').open = true;
}

function render() {
  const { raw, opts, price, deposit, principal, termYears, termClamped, extras } = readForm();
  urlState.write(raw);
  const note = $('#loan-note');
  const depositTooBig = price > 0 && deposit >= price;
  if (depositTooBig) {
    note.innerHTML = '<span style="color:var(--warn)">The deposit must be less than the property value.</span>';
  } else if (principal > 0 && price > 0) {
    const ltv = principal / price;
    note.innerHTML = `Loan amount <b class="num">${fmt.gbp(principal)}</b> · loan-to-value <b class="num">${fmt.pct(ltv, 0)}</b>${ltv > 0.95 ? ' <span style="color:var(--warn)">(few lenders go above 95%)</span>' : ''}${termClamped ? ` · term limited to ${termYears} years` : ''}`;
  } else {
    note.textContent = 'Enter a property value and deposit to see your loan amount.';
  }

  const openSummaries = new Set($$('details[open] > summary', results).map((x) => x.textContent));
  results.innerHTML = '';
  $('#mobile-summary').hidden = true;
  if (principal <= 0 || raw.r.trim() === '') {
    results.append(el('div', { class: 'card' }, el('p', { class: 'muted', text: depositTooBig ? 'The deposit must be less than the property value.' : 'Enter your property value, deposit and interest rate to see your payments.' })));
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
  results.append(saveCard(c, opts, extras));
  if (extras.rentMonthly > 0) results.append(btlCard(c.base, opts, extras, price));
  if (!opts.payment) results.append(sensitivityCard(opts));
  results.append(ltvCard(price, principal));
  results.append(scheduleCard(main, c));
  results.append(assumptionsCard(opts));
  for (const sm of $$('details > summary', results)) if (openSummaries.has(sm.textContent)) sm.parentElement.open = true;
  $('#ms-pay').textContent = fmt.gbp(main.initialPayment, 2);
  $('#ms-int').textContent = fmt.gbp(main.totalInterest);
  $('#mobile-summary').hidden = false;
}

function tile(k, v, s, variant) {
  const cls = variant === 'loss' ? ' primary loss' : variant ? ' primary' : '';
  return el('div', { class: `tile${cls}` }, [el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }), s ? el('div', { class: 's', text: s }) : null]);
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
  const card = el('div', { class: 'card', 'aria-live': 'polite' });
  card.append(el('div', { class: 'card-header' }, [el('div', {}, [el('h2', { text: c.hasOverpayments ? 'Your mortgage with overpayments' : 'Your mortgage' }), el('p', { text: `${fmt.gbp(principal)} over ${termYears} years at ${opts.annualRate}%${opts.fixedMonths ? ` for ${opts.fixedMonths / 12} years, then ${opts.revertRate ?? opts.annualRate}%` : ''} · ${io ? 'interest only' : 'repayment'}` })])]));
  const paymentSub = r.paymentChanges.length > 1 ? `then ${fmt.gbp(r.paymentChanges[1].amount, 2)} from month ${r.paymentChanges[1].fromMonth}` : 'a month';
  card.append(el('div', { class: 'hero' }, [
    tile('Monthly payment', fmt.gbp(r.initialPayment, 2), paymentSub + (c.hasOverpayments && opts.monthlyOverpayment ? ` + ${fmt.gbp(opts.monthlyOverpayment)} overpayment` : ''), true),
    tile('Total interest', fmt.gbp(r.totalInterest), `over ${fmt.months(r.months)}`),
    tile(io ? 'Still owed at the end' : 'Total repaid', fmt.gbp(io ? r.closingBalance : r.totalPaid), io ? 'interest-only leaves the loan unpaid' : 'loan plus interest'),
  ]));
  const ltv = price > 0 ? principal / price : 0;
  card.append(el('div', { class: 'stat-row', style: 'margin-top:14px' }, [
    stat('Loan-to-value', fmt.pct(ltv, 1), `${fmt.gbp(principal)} of ${fmt.gbp(price)}`),
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

function lineChart(series, { xLabel = (x) => (x === 0 ? 'Now' : `Yr ${x}`), tipLabel = (x) => (x === 0 ? 'Now' : `End of year ${x}`) } = {}) {
  const W = Math.max(320, Math.min(760, (results.clientWidth || 640) - 42));
  const H = Math.round(W < 480 ? W * 0.62 : W * 0.47);
  const m = { top: 16, right: 20, bottom: 36, left: 56 };
  const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
  const xMax = Math.max(1, ...series.map((s) => s.data[s.data.length - 1].x));
  const ys = series.flatMap((s) => s.data.map((p) => p.y));
  const yMaxRaw = Math.max(0, ...ys), yMinRaw = Math.min(0, ...ys);
  const step = niceCeil(Math.max(1, (yMaxRaw - yMinRaw) / 4));
  const niceY = Math.ceil(yMaxRaw / step) * step;
  const niceMin = Math.floor(yMinRaw / step) * step;
  const span = Math.max(1, niceY - niceMin);
  const ySteps = Math.round(span / step);
  const sx = (x) => m.left + (x / xMax) * iw;
  const sy = (y) => m.top + ih - ((y - niceMin) / span) * ih;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Line chart of outstanding mortgage balance by year');
  const add = (tag, attrs, parent = svg) => { const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); parent.append(n); return n; };

  // grid + y labels
  for (let i = 0; i <= ySteps; i++) {
    const v = niceMin + (span / ySteps) * i, y = sy(v);
    add('line', { x1: m.left, x2: W - m.right, y1: y, y2: y, stroke: '#e5e7eb', 'stroke-width': 1 });
    const t = add('text', { x: m.left - 8, y: y + 4, 'text-anchor': 'end', 'font-size': 12, fill: '#6b7280' });
    t.textContent = compactGbp(v);
  }
  // x labels
  const xStep = W < 480 ? (xMax <= 6 ? 1 : xMax <= 12 ? 2 : 5) : (xMax <= 10 ? 1 : xMax <= 20 ? 2 : 5);
  for (let x = 0; x <= xMax; x += xStep) {
    const t = add('text', { x: sx(x), y: H - m.bottom + 18, 'text-anchor': 'middle', 'font-size': 12, fill: '#6b7280' });
    t.textContent = xLabel(x);
  }
  add('line', { x1: m.left, x2: W - m.right, y1: sy(0), y2: sy(0), stroke: '#9ca3af', 'stroke-width': 1 });

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
    const lines = [`<div>${tipLabel(x)}</div>`];
    series.forEach((s, i) => {
      const p = s.data.find((q) => q.x === x);
      if (p) { dots[i].setAttribute('cx', sx(x)); dots[i].setAttribute('cy', sy(p.y)); dots[i].setAttribute('opacity', 1); lines.push(`<div><span style="color:${s.color}">●</span> ${s.name}: <b>${fmt.gbp(p.y)}</b></div>`); }
      else dots[i].setAttribute('opacity', 0);
    });
    tip.innerHTML = lines.join('');
    const px2 = (sx(x) / W) * rect.width;
    tip.style.left = `${px2}px`;
    tip.style.top = `${(m.top / H) * rect.height + 10}px`;
    tip.classList.toggle('left', px2 < rect.width * 0.25);
    tip.classList.toggle('right', px2 > rect.width * 0.75);
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
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (a >= 1e6) return `${sign}£${(a / 1e6).toFixed(a % 1e6 ? 1 : 0)}m`;
  if (a >= 1e3) return `${sign}£${Math.round(a / 1e3)}k`;
  return `${sign}£${Math.round(a)}`;
}

// ------------------------------------------------------------------ overpay vs save
function saveCard(c, opts, extras) {
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'card-header' }, [el('div', {}, [el('h2', { text: 'Overpay or save?' }), el('p', { text: 'Is your spare cash better off reducing the mortgage or earning interest?' })])]));
  if (!c.hasOverpayments) {
    card.append(el('p', { class: 'muted small', text: 'Add an overpayment in the form to compare putting that money into savings instead.' }));
    return card;
  }
  const tax = savingsTaxFor(extras.savingsBand);
  const taxRate = tax.rate;
  const be = breakEvenSavingsRate(opts, tax);
  const rateLine = be == null
    ? 'No realistic savings rate beats overpaying here.'
    : `Savings need to pay more than <b class="num">${be.toFixed(2)}%</b> to beat overpaying this mortgage${taxRate ? ` (${tax.label}${state.ratesLabel ? `, ${state.ratesLabel} rules` : ''})` : ''}.`;
  if (extras.savingsRate == null) {
    card.append(el('div', { class: 'note-box', html: rateLine + ' Enter a savings rate in the "Overpay or save?" section to see the full comparison.' }));
    card.append(saveExplain());
    return card;
  }
  const v = overpayVsSave(opts, extras.savingsRate, tax);
  if (!v) return card;
  const wins = v.advantage >= 0;
  card.append(el('div', { class: `note-box ${Math.abs(v.advantage) < 1 ? '' : 'good'}`, html: `${wins ? 'Overpaying wins' : 'Saving wins'} by <b class="num">${fmt.gbp(Math.abs(v.advantage))}</b> after ${fmt.months(v.horizonMonths)} at a savings rate of ${extras.savingsRate}%. ${rateLine}` }));
  card.append(el('div', { class: 'table-scroll' }, linesTable([
    ['Interest paid on the mortgage', fmt.gbp(v.save.interestPaid), { mid: fmt.gbp(v.overpay.interestPaid) }],
    ['Savings built up', fmt.gbp(v.save.savings), { mid: fmt.gbp(v.overpay.savings), note: 'Overpaying: once the mortgage is cleared the freed-up payments go into savings.' }],
    ['Savings interest earned (after tax)', fmt.gbp(v.save.interestEarned), { mid: fmt.gbp(v.overpay.interestEarned) }],
    taxRate ? ['Tax paid on interest', fmt.gbp(v.save.taxPaid), { mid: fmt.gbp(v.overpay.taxPaid), note: v.allowance ? `Only interest above the ${fmt.gbp(v.allowance)} Personal Savings Allowance each year is taxed.` : 'No savings allowance at this band.' }] : null,
    ['Mortgage still owed', fmt.gbp(v.save.balance), { mid: fmt.gbp(v.overpay.balance) }],
    ['Net position (savings − mortgage)', fmt.gbp(v.save.net), { mid: fmt.gbp(v.overpay.net), total: true }],
  ], { header: ['At the end of the term', 'Overpay', 'Save instead'] })));
  card.append(el('div', { style: 'margin-top:14px' }, [el('h3', { text: 'Net position over time', style: 'margin-bottom:6px' }), lineChart([
    { name: 'Overpay the mortgage', color: COLOR_OVER, data: [{ x: 0, y: -opts.principal }, ...v.yearly.map((y) => ({ x: y.year, y: y.netA }))] },
    { name: 'Save instead', color: COLOR_BASE, data: [{ x: 0, y: -opts.principal }, ...v.yearly.map((y) => ({ x: y.year, y: y.netB }))] },
  ])]));
  card.append(saveExplain());
  return card;
}
function saveExplain() {
  return el('details', { class: 'explain' }, [el('summary', { text: 'How this comparison works' }), el('div', { class: 'body' }, [
    el('p', { text: 'Both options spend exactly the same money each month: the normal mortgage payment plus your overpayment. In one, the extra goes into the mortgage (and once it is paid off, or the payment drops, the freed-up cash goes into savings). In the other, the mortgage runs as normal and the extra goes into a savings account compounding monthly.' }),
    el('p', { text: 'At the end of the original term we compare "net position": savings minus anything still owed. The break-even rate is the savings rate at which the two come out equal. Interest is credited gross and taxed only above your Personal Savings Allowance for the tax year, so the break-even rate rises as the pot grows beyond what the allowance covers.' }),
    el('p', { text: 'Things this ignores: the peace of mind and flexibility of accessible savings, an emergency fund, early repayment charges, and pension contributions, which often beat both because of tax relief.' }),
  ])]);
}

// ------------------------------------------------------------------ buy-to-let
function btlCard(run, opts, extras, price) {
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'card-header' }, [el('div', {}, [el('h2', { text: 'Buy-to-let: rent, tax and yield' }), el('p', { text: `First-year figures using the mortgage above with standard payments${state.ratesLabel ? `, ${state.ratesLabel} tax rules` : ''}.` })])]));
  if (!state.rates) { card.append(el('p', { class: 'note-box warn', text: 'Tax rates could not be loaded, so the tax on rent cannot be shown.' })); return card; }
  const y1 = run.yearly[0] || { interest: 0, paid: 0 };
  const rent = extras.rentMonthly * 12;
  const t = propertyIncrementalTax({ region: extras.region, otherIncome: extras.otherIncome, rentalIncome: rent, expenses: extras.btlExpenses, financeCosts: y1.interest }, state.rates);
  const cashBeforeTax = rent - extras.btlExpenses - y1.paid;
  const cashAfterTax = cashBeforeTax - t.tax;
  const grossYield = price > 0 ? rent / price : null;
  card.append(el('div', { class: 'hero' }, [
    tile('Rent after costs and tax', fmt.gbpSigned(cashAfterTax), cashAfterTax >= 0 ? 'a year, after mortgage payments' : 'a year - the property loses money', cashAfterTax >= 0 ? true : 'loss'),
    tile('Tax on the rent', fmt.gbp(t.tax), t.tax > 0 ? `on top of ${fmt.gbp(extras.otherIncome)} other income` : extras.otherIncome + t.profit <= (state.rates.incomeTax.personalAllowance) ? 'covered by your Personal Allowance' : 'nothing due'),
    tile('Gross yield', grossYield != null ? fmt.pct(grossYield) : '-', 'annual rent ÷ property value'),
  ]));
  const usedAllowance = t.deductionUsed === 'property_allowance';
  card.append(el('div', { class: 'table-scroll', style: 'margin-top:14px' }, linesTable([
    ['Rental income', fmt.gbp(rent)],
    usedAllowance ? ['Property allowance', '− ' + fmt.gbp(t.allowanceUsed), { neg: true, note: 'Chosen automatically: it beats deducting your costs and claiming the interest credit.' }] : ['Running costs', '− ' + fmt.gbp(Math.min(extras.btlExpenses, rent)), { neg: true }],
    ['Taxable rental profit', fmt.gbp(t.profit), { total: true, note: 'Mortgage interest is not deducted here.' }],
    ['Tax on the profit at your rates', fmt.gbp(t.taxBeforeCredit), { note: t.personalAllowanceUnusedBefore > 0 ? `${fmt.gbp(Math.min(t.personalAllowanceUnusedBefore, t.profit))} of the profit is covered by unused Personal Allowance.` : null }],
    t.credit > 0 ? [`Less ${fmt.pct(t.creditRate, 0)} credit on ${fmt.gbp(t.creditBase)} of interest`, '− ' + fmt.gbp(t.credit), { neg: true, note: t.creditBase < y1.interest - 0.5 ? 'Credit limited by your profit or income; the rest carries forward.' : null }] : (usedAllowance ? null : ['Mortgage interest credit', fmt.gbp(0), { note: 'No tax to set it against this year; it carries forward.' }]),
    ['Tax due', fmt.gbp(t.tax), { total: true }],
    ['Mortgage payments (year 1)', '− ' + fmt.gbp(y1.paid), { neg: true, note: `of which ${fmt.gbp(y1.interest)} is interest` }],
    ['Cash left after mortgage and tax', fmt.gbpSigned(cashAfterTax), { total: true }],
  ])));
  if (t.tax - t.oldRulesTax > 0.5) {
    const realProfit = rent - extras.btlExpenses - y1.interest;
    card.append(el('div', { class: 'note-box warn', style: 'margin-top:12px', html: `The interest restriction costs you <b class="num">${fmt.gbp(t.tax - t.oldRulesTax)}</b> a year more tax than if interest were fully deductible (pre-2020 rules).${realProfit > 0 && t.tax / realProfit > 0.5 ? ` That is an effective rate of ${fmt.pct(t.tax / realProfit, 0)} on your real profit of ${fmt.gbp(realProfit)}.` : ''}` }));
  }
  card.append(el('details', { class: 'explain' }, [el('summary', { text: 'How rental income is taxed' }), el('div', { class: 'body' }, [
    el('p', { text: 'Rental profit is added to your other income and taxed through the same Personal Allowance and bands, so this card works out the extra tax the property causes: tax with the property minus tax without it. Since April 2020 individual landlords cannot deduct mortgage interest; instead the tax bill is reduced by 20% of the interest, capped at the lower of the interest, the rental profit and your total non-savings income after allowances. Capital repayments were never deductible.' }),
    el('p', { text: 'The £1,000 property allowance can be claimed instead of costs (it removes the interest credit); the better option is chosen for you. Interest falls each year on a repayment mortgage, so the credit shrinks while rent usually rises. Stamp duty surcharges, capital gains tax on sale, void periods and the Child Benefit charge are not included. Use the take-home pay calculator to see the rent alongside all your other income.' }),
  ])]));
  return card;
}

// ------------------------------------------------------------------ rate sensitivity
function sensitivityCard(opts) {
  const rows = rateSensitivity(opts).filter((r) => r.payment != null);
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'card-header' }, [el('div', {}, [el('h2', { text: 'What if the rate changes?' }), el('p', { text: opts.type === 'interest_only' ? 'Monthly interest at different rates.' : 'Monthly payment at different rates, without overpayments.' })])]));
  const max = Math.max(...rows.map((r) => r.payment));
  const bars = el('div', { class: 'bars' });
  for (const r of rows) {
    bars.append(el('div', { class: `bar-row${r.current ? ' current' : ''}` }, [
      el('span', { text: `${r.rate.toFixed(2)}%${r.current ? ' (now)' : ''}` }),
      el('span', { class: 'track' }, el('span', { class: 'fill', style: `width:${(r.payment / max) * 100}%` })),
      el('span', { class: 'val', text: fmt.gbp(r.payment, 2) }),
    ]));
  }
  card.append(bars);
  const up1 = rows.find((r) => r.delta === 1), cur = rows.find((r) => r.current);
  if (up1 && cur) card.append(el('p', { class: 'muted small', style: 'margin-top:10px', text: `A 1 percentage point rise would add ${fmt.gbp(up1.payment - cur.payment, 2)} a month (${fmt.gbp((up1.payment - cur.payment) * 12)} a year).` }));
  return card;
}

// ------------------------------------------------------------------ LTV
function ltvCard(price, principal) {
  const bands = ltvBands(price, principal);
  const card = el('div', { class: 'card' });
  const ltv = principal / price;
  card.append(el('div', { class: 'card-header' }, [el('div', {}, [el('h2', { text: 'Deposit and loan-to-value' }), el('p', { text: `You are borrowing ${fmt.pct(ltv, 1)} of the property value. Lenders price in tiers - a bigger deposit can unlock a cheaper rate.` })])]));
  const rows = bands.map((b) => [
    `${fmt.pct(b.tier, 0)} LTV`,
    b.reached ? 'Reached' : `Add ${fmt.gbp(b.extraDeposit)} to deposit`,
    { mid: fmt.gbp(b.maxLoan) },
  ]);
  const table = linesTable(rows, { header: ['Tier', 'Max loan', 'To get there'] });
  // highlight the next tier
  const next = bands.findIndex((b) => !b.reached);
  if (next >= 0) table.querySelectorAll('tbody tr')[next]?.classList.add('hl');
  card.append(el('div', { class: 'table-scroll' }, table));
  return card;
}

// ------------------------------------------------------------------ schedule
function scheduleCard(run, c) {
  const card = el('details', { class: 'section' });
  card.append(el('summary', {}, el('span', {}, ['Year-by-year breakdown', el('span', { class: 'sub', text: c.hasOverpayments ? 'With your overpayments included' : 'Standard payments' })])));
  const body = el('div', { class: 'body' });
  const table = el('table', { class: 'lines' });
  const narrow = (results.clientWidth || 640) < 420; // five money columns do not fit on a phone; "Paid" = interest + loan repaid
  table.append(el('thead', {}, el('tr', {}, ['Year', ...(narrow ? [] : ['Paid']), 'Interest', 'Loan repaid', 'Balance'].map((h, i) => el('th', { text: h, style: i ? 'text-align:right' : '' })))));
  const tbody = el('tbody');
  for (const y of run.yearly) {
    tbody.append(el('tr', {}, [
      el('td', { text: String(y.year) }),
      narrow ? null : el('td', { class: 'num', style: 'text-align:right', text: fmt.gbp(y.paid) }),
      el('td', { class: 'num', style: 'text-align:right', text: fmt.gbp(y.interest) }),
      el('td', { class: 'num', style: 'text-align:right', text: fmt.gbp(y.principal) }),
      el('td', { class: 'num', style: 'text-align:right', text: fmt.gbp(y.closing) }),
    ]));
  }
  table.append(tbody);
  body.append(el('div', { class: 'table-scroll' }, table));
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
