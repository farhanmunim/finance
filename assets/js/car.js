import { analyse, whatIf, quoteApr, defaultPaymentCount } from './car-engine.js?v=6e481b69cf';
import { lineChart as drawLineChart } from './charts.js?v=4df7c0dce0';
import { fmt, parseNum, initMoneyInputs, initNumberInputs, captionTables, $, $$, el, linesTable, urlState, debounce, announce, linkHints } from './ui.js?v=bdf638f516';

const form = $('#form');
const results = $('#results');
const C_CAR = '#2a78d6';
const C_INTEREST = '#eb6834';
const C_FEES = '#7c5cd6';
const C_DEPOSIT = '#1baf7a';
const C_FINAL = '#7c5cd6';
const KEYS = ['p', 'd', 't', 'm', 'b', 'n', 'f1', 'f2'];
const EXAMPLE = { p: '26,500.00', d: '5,000.00', t: '48', m: '378.12', b: '12,879.26', n: '', f1: '', f2: '' };
const lineChart = (series, opts) => drawLineChart(series, { width: results.clientWidth, ...opts });

const gbp2 = (v) => fmt.gbp(v, 2);
const pct = (v, dp = 2) => `${(v * 100).toFixed(dp)}%`;
const aprText = (apr) => `${quoteApr(apr).toFixed(1)}%`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function init() {
  restoreFromUrl();
  initMoneyInputs(form);
  initNumberInputs(form);
  linkHints(form);
  form.addEventListener('input', debounce(render, 80));
  form.addEventListener('submit', (e) => e.preventDefault());
  $('#example').addEventListener('click', () => {
    for (const k of KEYS) form[k].value = EXAMPLE[k];
    render();
    $('#price').focus();
  });
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', debounce(() => { if (window.innerWidth !== lastWidth) { lastWidth = window.innerWidth; render(); } }, 150));
  render();
}

function restoreFromUrl() {
  const q = urlState.read();
  for (const k of KEYS) if (q[k] != null && form[k]) form[k].value = q[k];
  if (q.n || q.f1 || q.f2) $('#more').open = true;
}

function readForm() {
  const raw = Object.fromEntries(KEYS.map((k) => [k, form[k].value]));
  return {
    raw,
    price: parseNum(raw.p),
    deposit: parseNum(raw.d),
    termMonths: Math.round(parseNum(raw.t)),
    monthlyPayment: parseNum(raw.m),
    finalPayment: parseNum(raw.b),
    paymentCount: Math.round(parseNum(raw.n)),
    upfrontFee: parseNum(raw.f1),
    finalFee: parseNum(raw.f2),
  };
}

/** Live notes under the inputs, so the user can see how their figures were read. */
function updateNotes(o) {
  const credit = o.price - o.deposit;
  const cn = $('#credit-note');
  if (o.price > 0 && credit <= 0) cn.innerHTML = '<span style="color:var(--warn)">The deposit covers the whole price, so there is nothing to borrow.</span>';
  else if (o.price > 0) cn.innerHTML = `You're borrowing <b class="num">${gbp2(credit)}</b>${o.deposit > 0 ? ` · deposit is <b class="num">${fmt.pct(o.deposit / o.price, 0)}</b> of the price` : ''}`;
  else cn.textContent = "Enter the price and deposit to see how much you're borrowing.";

  const t = o.termMonths;
  $('#term-hint').textContent = t > 0 ? `${t} months is ${fmt.months(t)}.` : 'Usually 24, 36, 48 or 60.';
  const auto = t > 0 ? defaultPaymentCount(t, o.finalPayment) : null;
  $('#count').placeholder = auto ? String(auto) : 'Automatic';
  $('#count-hint').textContent = auto
    ? `Leave blank for ${auto}${o.finalPayment > 0 ? `: the final payment replaces the last monthly payment, as on most PCP quotes (e.g. "${auto} monthly payments" on a ${t}-month agreement).` : ': one payment a month for the whole term.'}`
    : 'Leave blank to use the usual layout for the term.';

  const sn = $('#schedule-note');
  if (t > 0 && o.monthlyPayment > 0) {
    const n = Math.min(t, o.paymentCount || auto);
    sn.innerHTML = `<b class="num">${n}</b> monthly payment${n === 1 ? '' : 's'} of <b class="num">${gbp2(o.monthlyPayment)}</b>${o.finalPayment > 0 ? `, then a final payment of <b class="num">${gbp2(o.finalPayment)}</b> in month ${t}` : ''}.`;
  } else sn.textContent = 'Enter the term and monthly payment to see your payment plan.';
}

function render() {
  const o = readForm();
  urlState.write(o.raw);
  updateNotes(o);

  const openSummaries = new Set($$('details[open] > summary', results).map((x) => x.textContent));
  results.innerHTML = '';
  $('#mobile-summary').hidden = true;
  if (!(o.price > 0) || !(o.termMonths > 0) || !(o.monthlyPayment > 0)) {
    results.append(el('div', { class: 'card' }, el('p', { class: 'muted', text: 'Enter the car price, deposit, term and monthly payment to see what the finance costs.' })));
    return;
  }
  const r = analyse(o);
  if (!r.ok) {
    results.append(el('section', { class: 'card note-box warn' }, r.warnings.map((w) => el('p', { text: w }))));
    return;
  }
  results.append(heroCard(r));
  results.append(breakdownCard(r));
  results.append(timelineCard(r));
  results.append(whatIfCard(r));
  results.append(ratesCard(r));
  captionTables(results);
  for (const sm of $$('details > summary', results)) if (openSummaries.has(sm.textContent)) sm.parentElement.open = true;
  $('#ms-int').textContent = fmt.gbp(r.interest);
  $('#ms-apr').textContent = aprText(r.apr);
  $('#mobile-summary').hidden = false;
  announce(`Total interest ${gbp2(r.interest)}, about ${gbp2(r.interestPerMonth)} a month. APR ${aprText(r.apr)}.`);
}

function header(title, sub) {
  return el('div', { class: 'card-header' }, [el('div', {}, [el('h2', { text: title }), sub ? el('p', { text: sub }) : null])]);
}
function tile(k, v, s, primary) {
  return el('div', { class: `tile${primary ? ' primary' : ''}` }, [el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }), s ? el('div', { class: 's', text: s }) : null]);
}
function stat(k, v, s) {
  return el('div', { class: 'stat' }, [el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }), s ? el('div', { class: 's', text: s }) : null]);
}
function splitBar(parts) {
  parts = parts.filter((p) => p[1] > 0.005);
  const total = parts.reduce((a, p) => a + p[1], 0) || 1;
  return el('div', {}, [
    el('div', { class: 'split', role: 'img', 'aria-label': parts.map((p) => `${p[0]} ${fmt.gbp(p[1])}, ${fmt.pct(p[1] / total, 0)}`).join('; ') }, parts.map((p) => el('span', { style: `width:${(p[1] / total) * 100}%;background:${p[2]}` }))),
    el('div', { class: 'legend' }, parts.map((p) => el('span', { style: `--c:${p[2]}`, text: `${p[0]} ${fmt.gbp(p[1])} (${fmt.pct(p[1] / total, 0)})` }))),
  ]);
}

// ------------------------------------------------------------------ headline
function heroCard(r) {
  const card = el('section', { class: 'card' });
  const kind = r.balloon > 0 ? 'PCP' : 'hire purchase';
  card.append(header('What this finance costs', `${gbp2(r.credit)} borrowed over ${r.term} months · ${kind}`));
  const zero = Math.abs(r.interest) < 0.5;
  card.append(el('div', { class: 'hero' }, [
    tile('Total interest', gbp2(r.interest), zero ? 'interest-free' : `${gbp2(r.interestPerMonth)} a month · ${fmt.gbp(r.interestPerYear)} a year`, true),
    tile('APR', aprText(r.apr), r.fees > 0 ? `${aprText(r.interestRate)} before fees` : `${pct(r.monthlyRate, 4)} a month`),
    tile('Total you pay', gbp2(r.totalPayable), `for a ${fmt.gbp(r.price)} car`),
  ]));

  const extra = r.costOfCredit;
  const sentence = zero && r.fees < 0.005
    ? `You borrow <b class="num">${gbp2(r.credit)}</b> and pay back exactly that: this deal is interest-free.`
    : `You borrow <b class="num">${gbp2(r.credit)}</b> and pay back <b class="num">${gbp2(r.repaid + r.fees)}</b>. The extra <b class="num">${gbp2(extra)}</b> is ${r.fees > 0 ? 'interest and fees' : 'interest'}, which adds <b class="num">${fmt.pct(extra / r.price, 0)}</b> to the price of the car.`;
  card.append(el('div', { class: 'note-box', style: 'margin-top:14px', html: sentence }));
  card.append(el('div', { style: 'margin-top:14px' }, [
    el('h3', { text: 'Where your money goes', style: 'margin-bottom:8px' }),
    splitBar([['Car', r.price, C_CAR], ['Interest', r.interest, C_INTEREST], ['Fees', r.fees, C_FEES]]),
  ]));
  if (r.warnings.length) card.append(el('div', { class: 'note-box warn', style: 'margin-top:14px' }, r.warnings.map((w) => el('p', { text: w }))));
  return card;
}

// ------------------------------------------------------------------ full breakdown (the quote, rearranged)
function breakdownCard(r) {
  const card = el('section', { class: 'card' });
  card.append(header('Full breakdown', 'The same numbers as the quote, grouped so they add up.'));
  const group = (title, rows) => el('div', { style: 'margin-top:4px' }, [el('h3', { text: title, style: 'margin:14px 0 4px' }), linesTable(rows, { caption: title })]);

  card.append(group('1. The car', [
    ['Car price', gbp2(r.price)],
    ['Deposit', '− ' + gbp2(r.deposit), { neg: true, note: r.deposit > 0 ? `${fmt.pct(r.depositShare, 0)} of the price` : null }],
    ['Amount borrowed', gbp2(r.credit), { total: true, note: 'The "amount of credit" on the quote.' }],
  ]));

  card.append(group('2. What you pay back', [
    [`${plural(r.count, 'monthly payment')} of ${gbp2(r.monthly)}`, gbp2(r.monthlyTotal)],
    r.balloon > 0 ? [`Final payment in month ${r.term}`, gbp2(r.balloon), { note: `${fmt.pct(r.balloonShare, 0)} of the car's price. Pay it to keep the car, or hand the car back instead.` }] : null,
    r.upfrontFee > 0 ? ['Arrangement fee', gbp2(r.upfrontFee)] : null,
    r.finalFee > 0 ? ['Option to purchase fee', gbp2(r.finalFee)] : null,
    ['Total repaid', gbp2(r.repaid + r.fees), { total: true, note: 'Not counting the deposit.' }],
    ['Plus the deposit', gbp2(r.deposit), { sub: true }],
    ['Total payable', gbp2(r.totalPayable), { total: true, note: 'Everything you pay, deposit included.' }],
  ]));

  card.append(group('3. The cost of borrowing', [
    ['Interest', gbp2(r.interest), { note: 'Total repaid minus the amount borrowed.' }],
    r.fees > 0 ? ['Fees', gbp2(r.fees)] : null,
    r.fees > 0 ? ['Total cost of credit', gbp2(r.costOfCredit), { total: true }] : null,
    ['Interest a month (average)', gbp2(r.interestPerMonth)],
    ['Interest a year (average)', gbp2(r.interestPerYear)],
    ['Monthly interest rate', pct(r.monthlyRate, 4)],
    r.fees > 0 ? ['Interest rate (excluding fees)', aprText(r.interestRate)] : null,
    ['APR', aprText(r.apr), { total: true, note: 'The monthly rate compounded over 12 months.' }],
  ]));
  return card;
}

// ------------------------------------------------------------------ balance over time and interest by year
function timelineCard(r) {
  const card = el('section', { class: 'card' });
  card.append(header('What you owe over time', r.balloon > 0 ? 'With a PCP most of the loan is still owed until the final payment.' : 'The balance falls steadily to zero.'));
  const data = [{ x: 0, y: r.credit }, ...r.schedule.map((s) => ({ x: s.month, y: Math.max(0, s.balance) }))];
  card.append(lineChart([{ name: 'Amount owed', color: C_CAR, data }], {
    title: 'Line chart of the amount owed on the car finance by month',
    note: ' The year-by-year figures are in the table below.',
    xLabel: (x) => (x === 0 ? 'Start' : `${x}m`),
    tipLabel: (x) => (x === 0 ? 'Start' : `After month ${x}`),
  }));

  const table = el('table', { class: 'lines' });
  table.append(el('thead', {}, el('tr', {}, ['Year', 'You pay', 'Interest', 'Off the loan', 'Still owed'].map((h) => el('th', { scope: 'col', text: h })))));
  const tbody = el('tbody');
  for (const y of r.yearly) {
    const label = `Year ${y.year}${y.months < 12 ? ` (${plural(y.months, 'month')})` : ''}`;
    tbody.append(el('tr', {}, [label, fmt.gbp(y.paid), fmt.gbp(y.interest), fmt.gbp(y.capital), fmt.gbp(Math.max(0, y.balance))].map((t) => el('td', { text: t }))));
  }
  tbody.append(el('tr', { class: 'total' }, [el('td', { text: 'Total' }), el('td', { text: fmt.gbp(r.repaid + r.fees) }), el('td', { text: fmt.gbp(r.interest) }), el('td', { text: fmt.gbp(r.credit) }), el('td', { text: '' })]));
  table.append(tbody);
  card.append(el('h3', { text: 'Interest by year', style: 'margin:16px 0 4px' }));
  card.append(el('div', { class: 'table-scroll' }, table));
  if (r.yearly.length > 1 && r.interest > 1) {
    const first = r.yearly[0].interest;
    card.append(el('p', { class: 'muted small', style: 'margin-top:10px', text: `Interest is charged on what you still owe, so it's highest at the start: ${fmt.gbp(first)} in the first year${r.balloon > 0 ? '. Because the final payment keeps the balance high, the interest falls only slowly' : ', falling each year as the balance comes down'}.` }));
  }
  return card;
}

// ------------------------------------------------------------------ what would change the cost
function whatIfCard(r) {
  const card = el('section', { class: 'card' });
  card.append(header('What would make it cheaper', `Same term and ${r.balloon > 0 ? 'final payment' : 'number of payments'}, so you can compare.`));

  const depRows = [1000, 2500, 5000].filter((x) => x < r.credit).map((extra) => {
    const w = whatIf(r, { extraDeposit: extra });
    return [`${fmt.gbp(extra)} more deposit`, `${gbp2(w.monthly)}`, { mid: `${fmt.gbp(r.interest - w.interest)} less interest` }];
  });
  if (depRows.length) {
    card.append(el('h3', { text: 'A bigger deposit', style: 'margin:4px 0 4px' }));
    card.append(el('div', { class: 'table-scroll' }, linesTable(depRows, { header: ['', 'Saves', 'Monthly payment'], caption: 'A bigger deposit, same APR' })));
  }

  const current = quoteApr(r.interestRate) / 100;
  const aprs = [...new Set([0, 0.049, 0.069, 0.099, current - 0.02, current].map((a) => Math.round(Math.max(0, a) * 1000) / 1000))].sort((a, b) => a - b);
  const rows = aprs.map((a) => {
    const isCurrent = Math.abs(a - current) < 1e-9;
    const w = isCurrent ? { monthly: r.monthly, interest: r.interest } : whatIf(r, { apr: a });
    return [isCurrent ? `${(a * 100).toFixed(1)}% (this quote)` : `${(a * 100).toFixed(1)}%`, gbp2(w.monthly), { mid: fmt.gbp(w.interest) }];
  });
  const t = linesTable(rows, { header: ['Interest rate', 'Total interest', 'Monthly payment'], caption: 'Monthly payment and interest at other rates' });
  const idx = aprs.findIndex((a) => Math.abs(a - current) < 1e-9);
  if (idx >= 0) t.querySelectorAll('tbody tr')[idx]?.classList.add('hl');
  card.append(el('h3', { text: 'A lower rate', style: 'margin:16px 0 4px' }));
  card.append(el('div', { class: 'table-scroll' }, t));
  card.append(el('p', { class: 'muted small', style: 'margin-top:10px', text: 'Dealers can often lower the rate or add a deposit contribution. Paying cash avoids the interest entirely, and a personal loan from your bank may have a lower APR.' }));
  return card;
}

// ------------------------------------------------------------------ explaining the rates
function ratesCard(r) {
  const card = el('section', { class: 'card' });
  card.append(header('Ways of quoting the rate', 'Why the same deal can be described by different numbers.'));
  card.append(el('div', { class: 'stat-row' }, [
    stat('APR', aprText(r.apr), 'what the law requires on quotes'),
    stat('Monthly rate', pct(r.monthlyRate, 4), 'charged on what you owe'),
    stat('Flat rate', pct(r.flatRate, 1), 'looks lower, but isn\'t'),
  ]));
  card.append(el('details', { class: 'explain' }, [el('summary', { text: 'What do these mean?' }), el('div', { class: 'body' }, [
    el('p', { html: `<b>Monthly rate.</b> Each month you're charged ${pct(r.monthlyRate, 4)} of what you still owe. This is the rate that actually drives the cost.` }),
    el('p', { html: `<b>APR.</b> The monthly rate compounded over a year: (1 + ${pct(r.monthlyRate, 4)})<sup>12</sup> − 1 = ${pct(r.interestRate, 2)}, quoted to one decimal place${r.fees > 0 ? `. Fees are then added in, giving ${aprText(r.apr)}` : ''}. Use this to compare deals.` }),
    el('p', { html: `<b>Flat rate.</b> Interest divided by the amount borrowed and the number of years (${fmt.gbp(r.interest)} ÷ ${fmt.gbp(r.credit)} ÷ ${(r.term / 12).toFixed(r.term % 12 ? 1 : 0)}). It ignores that you pay the loan down, so it understates the cost. Be wary of quotes that only show this.` }),
  ])]));
  return card;
}
init();
