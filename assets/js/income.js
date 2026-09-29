import { calculate, marginalRate, applyOverrides } from './tax-engine.js';
import { fmt, parseNum, initMoneyInputs, $, $$, el, linesTable, urlState, debounce, loadJSON } from './ui.js';

const state = { index: null, rates: {}, period: 'year', overrides: {}, editorKey: '' };
const form = $('#form');
const results = $('#results');

// ------------------------------------------------------------------ boot
async function init() {
  try {
    state.index = await loadJSON('/data/tax-years/index.json');
  } catch (e) {
    results.innerHTML = '';
    results.append(el('div', { class: 'card note-box warn', text: `Could not load tax rates: ${e.message}` }));
    return;
  }
  const sel = $('#taxYear');
  for (const y of state.index.years) sel.append(el('option', { value: y.id, text: `${y.label}${y.id === state.index.default ? ' (current)' : ''}` }));
  sel.value = state.index.default;

  restoreFromUrl();
  initMoneyInputs(form);
  bindEvents();
  await ensureRates(sel.value);
  syncVisibility();
  buildRatesEditor();
  render();
}

async function ensureRates(id) {
  if (state.rates[id]) return state.rates[id];
  const meta = state.index.years.find((y) => y.id === id) || state.index.years[0];
  state.rates[id] = await loadJSON(meta.file);
  return state.rates[id];
}

function bindEvents() {
  const rerender = debounce(() => { syncVisibility(); render(); }, 80);
  form.addEventListener('input', (e) => { if (e.target.closest('#rates-editor')) return; rerender(); });
  form.addEventListener('change', async (e) => {
    if (e.target.closest('#rates-editor')) return;
    if (e.target.id === 'taxYear') { results.setAttribute('aria-busy', 'true'); await ensureRates(e.target.value); results.removeAttribute('aria-busy'); }
    syncVisibility(); buildRatesEditor(); render();
  });
  form.addEventListener('submit', (e) => e.preventDefault());
  $('#rates-editor').addEventListener('input', debounce(onRateEdit, 120));
  $('#rates-reset').addEventListener('click', () => { state.overrides = {}; buildRatesEditor(true); render(); });
}

function syncVisibility() {
  const mode = form.mode.value;
  $('#sec-employment').hidden = mode === 'self';
  $('#sec-self').hidden = mode === 'employed';
  const pm = $('#pensionMethod').value;
  $('#pension-row').hidden = pm === 'none';
  const pt = form.pt.value;
  $('#pensionAffix').textContent = pt === 'percent' ? '%' : '£';
  $('#pensionHint').textContent = pt === 'percent'
    ? (pm === 'relief_at_source' ? 'Percentage of salary that goes into your pension, including the 20% the provider claims back.' : 'Percentage of salary.')
    : (pm === 'relief_at_source' ? 'Gross amount into your pension each year, including the 20% the provider claims back.' : 'Amount per year.');
}

// ------------------------------------------------------------------ form <-> state
function readForm() {
  const f = form;
  const mode = f.mode.value;
  const raw = {
    y: f.y.value, r: f.r.value, mode,
    sal: f.sal.value, bon: f.bon.value, pm: f.pm.value, pv: f.pv.value, pt: f.pt.value, ben: f.ben.value, eex: f.eex.value,
    to: f.to.value, ex: f.ex.value, ded: f.ded.value, sep: f.sep.value,
    rent: f.rent.value, pex: f.pex.value, fc: f.fc.value, pded: f.pded.value,
    sav: f.sav.value, div: f.div.value, oth: f.oth.value,
    sl: $$('input[name="sl"]:checked', f).map((c) => c.value).join(','),
    ga: f.ga.value, ma: f.ma.value, bpa: f.bpa.checked ? '1' : '', ch: f.ch.value, cbo: f.cbo.checked ? '1' : '', p: state.period === 'year' ? '' : state.period,
    ov: Object.keys(state.overrides).length ? JSON.stringify(state.overrides) : '',
  };
  const input = {
    region: raw.r,
    employment: mode === 'self' ? {} : {
      salary: parseNum(raw.sal), bonus: parseNum(raw.bon), taxableBenefits: parseNum(raw.ben), expenses: parseNum(raw.eex),
      pension: { method: raw.pm, type: raw.pt, value: parseNum(raw.pv) },
    },
    selfEmployment: mode === 'employed' ? {} : { turnover: parseNum(raw.to), expenses: parseNum(raw.ex), deduction: raw.ded, pensionPaid: parseNum(raw.sep) },
    property: { rentalIncome: parseNum(raw.rent), expenses: parseNum(raw.pex), financeCosts: parseNum(raw.fc), deduction: raw.pded },
    other: { savingsInterest: parseNum(raw.sav), dividends: parseNum(raw.div), otherIncome: parseNum(raw.oth) },
    studentLoans: raw.sl ? raw.sl.split(',') : [],
    adjustments: { giftAid: parseNum(raw.ga), marriageAllowance: raw.ma, blindPersonsAllowance: !!raw.bpa, childBenefitChildren: parseNum(raw.ch), childBenefitOptedOut: !!raw.cbo },
  };
  return { raw, input };
}

function restoreFromUrl() {
  const q = urlState.read();
  const f = form;
  const setRadio = (name, v) => { const r = $(`input[name="${name}"][value="${v}"]`, f); if (r) r.checked = true; };
  if (q.y && state.index.years.some((y) => y.id === q.y)) f.y.value = q.y;
  if (q.r) setRadio('r', q.r);
  if (q.mode) setRadio('mode', q.mode);
  for (const k of ['sal', 'bon', 'pv', 'ben', 'eex', 'to', 'ex', 'sep', 'rent', 'pex', 'fc', 'sav', 'div', 'oth', 'ga', 'ch']) if (q[k] != null && f[k]) f[k].value = q[k];
  if (q.pded) setRadio('pded', q.pded);
  if (q.cbo) f.cbo.checked = true;
  if (q.ov) { try { const o = JSON.parse(q.ov); if (o && typeof o === 'object') state.overrides = o; } catch { /* ignore bad overrides */ } }
  if (q.rent || q.pex || q.fc) $('#sec-property').open = true;
  if (Object.keys(state.overrides).length) $('#sec-rates').open = true;
  if (q.pm) f.pm.value = q.pm;
  if (q.pt) setRadio('pt', q.pt);
  if (q.ded) setRadio('ded', q.ded);
  if (q.ma) f.ma.value = q.ma;
  if (q.bpa) f.bpa.checked = true;
  if (q.sl) for (const p of q.sl.split(',')) { const c = $(`input[name="sl"][value="${p}"]`, f); if (c) c.checked = true; }
  if (q.p && ['month', 'week'].includes(q.p)) state.period = q.p;
  if (q.sav || q.div || q.oth) $('#sec-other').open = true;
  if (q.ga || q.ma || q.bpa || q.ch || q.cbo) $('#sec-adjust').open = true;
}

// ------------------------------------------------------------------ render
function render() {
  const { raw, input } = readForm();
  const base = state.rates[raw.y];
  if (!base) return;
  urlState.write(raw);
  const rates = applyOverrides(base, state.overrides);
  state.effective = rates;
  const r = calculate(input, rates);
  const m = marginalRate(input, rates);
  results.innerHTML = '';
  results.append(heroCard(r, rates), summaryCard(r, m, rates));
  results.append(incomeCard(r, rates), allowancesCard(r, rates), incomeTaxCard(r, rates), niCard(r, rates));
  if (r.studentLoans.plans.length) results.append(studentLoanCard(r, rates));
  if (r.hicbc) results.append(hicbcCard(r, rates));
  results.append(sourcesCard(base));
  $('#ms-month').textContent = fmt.gbp(r.totals.takeHomeMonthly);
  $('#ms-year').textContent = fmt.gbp(r.totals.takeHome);
  $('#mobile-summary').hidden = r.totals.cashIncome <= 0;
}

const DIV = { year: 1, month: 12, week: 52 };
const money = (v) => fmt.gbp(v / DIV[state.period], state.period === 'year' ? 0 : 2);
const per = () => ({ year: 'a year', month: 'a month', week: 'a week' })[state.period];

function periodSwitch() {
  const wrap = el('div', { class: 'segmented mini', role: 'radiogroup', 'aria-label': 'Show figures per' });
  for (const p of ['year', 'month', 'week']) {
    const id = `period-${p}`;
    wrap.append(
      el('input', { type: 'radio', name: 'period', id, value: p, checked: state.period === p, onchange: () => { state.period = p; render(); } }),
      el('label', { for: id, text: p[0].toUpperCase() + p.slice(1) }),
    );
  }
  return wrap;
}

function explain(title, bodyNodes) {
  return el('details', { class: 'explain' }, [el('summary', { text: title }), el('div', { class: 'body' }, bodyNodes)]);
}

function heroCard(r, rates) {
  const t = r.totals;
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'card-header' }, [
    el('div', {}, [el('h2', { text: 'Your take-home pay' }), el('p', {}, [`Tax year ${rates.label}${r.region === 'scotland' ? ' · Scottish rates' : ''} `, Object.keys(state.overrides).length ? el('span', { class: 'badge', text: `Custom rates (${Object.keys(state.overrides).length} changed)` }) : null])]),
    periodSwitch(),
  ]));
  if (t.cashIncome <= 0) {
    card.append(el('p', { class: 'muted', text: 'Enter your salary or self-employed income to see your take-home pay.' }));
    return card;
  }
  const hero = el('div', { class: 'hero' }, [
    tile('Take-home pay', money(t.takeHome), `${per()} after everything`, true),
    tile('Income tax', money(t.incomeTax), per()),
    tile('National Insurance', money(t.nationalInsurance), per()),
  ]);
  card.append(hero);

  // Split bar
  const segs = [
    ['Take-home', t.takeHome, 'var(--takehome)'],
    ['Income tax', t.incomeTax, 'var(--tax)'],
    ['National Insurance', t.nationalInsurance, 'var(--ni)'],
    ['Student loan', t.studentLoans, 'var(--sl)'],
    ['Pension', t.pensionCash, 'var(--pension)'],
    ['Child Benefit charge', t.hicbc, '#9ca3af'],
  ].filter((s) => s[1] > 0);
  const total = segs.reduce((s, x) => s + x[1], 0);
  const bar = el('div', { class: 'split', role: 'img', 'aria-label': 'Where your income goes' });
  const legend = el('div', { class: 'legend' });
  for (const [label, v, c] of segs) {
    bar.append(el('span', { style: `width:${(v / total) * 100}%;background:${c}`, title: `${label}: ${fmt.gbp(v)}` }));
    legend.append(el('span', { style: `--c:${c}`, text: `${label} ${fmt.pct(v / total, 0)}` }));
  }
  card.append(el('div', { style: 'margin-top:18px' }, [bar, legend]));
  if (r.warnings.length) card.append(el('div', { class: 'note-box warn', style: 'margin-top:14px' }, [el('ul', {}, r.warnings.map((w) => el('li', { text: w })))]));
  return card;
}

function tile(k, v, s, primary) {
  return el('div', { class: `tile${primary ? ' primary' : ''}` }, [el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }), s ? el('div', { class: 's', text: s }) : null]);
}

function summaryCard(r, m, rates) {
  const t = r.totals;
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'card-header' }, [el('div', {}, [el('h2', { text: 'Summary' }), el('p', { text: `Figures shown ${per()}.` })])]));
  const rows = [
    ['Gross income', money(t.grossIncome), { note: r.income.employment.taxableBenefits > 0 ? 'Includes taxable benefits, which are taxed but not paid as cash.' : null }],
    t.pensionCash > 0 ? ['Pension contributions', '− ' + money(t.pensionCash), { neg: true, note: r.income.employment.pensionMethod === 'relief_at_source' || r.income.selfEmployment.pensionPaid > 0 ? 'What leaves your pocket; your provider adds basic-rate tax relief on top.' : null }] : null,
    ['Income tax', '− ' + money(t.incomeTax), { neg: true }],
    ['National Insurance', '− ' + money(t.nationalInsurance), { neg: true }],
    t.studentLoans > 0 ? ['Student loan repayments', '− ' + money(t.studentLoans), { neg: true }] : null,
    t.financeCosts > 0 ? ['Mortgage interest on let property', '− ' + money(t.financeCosts), { neg: true, note: 'Paid from rent but not deductible for tax - see Step 3 for the 20% credit.' }] : null,
    t.hicbc > 0 ? ['High Income Child Benefit Charge', '− ' + money(t.hicbc), { neg: true }] : null,
    t.childBenefitReceived > 0 ? ['Child Benefit received (tax-free)', '+ ' + money(t.childBenefitReceived)] : null,
    r.income.employment.taxableBenefits > 0 ? ['Benefits in kind (not cash)', '− ' + money(r.income.employment.taxableBenefits), { neg: true }] : null,
    ['Take-home pay', money(t.takeHome), { total: true }],
  ];
  card.append(linesTable(rows));
  const stats = el('div', { class: 'stat-row', style: 'margin-top:16px' }, [
    stat('Effective deduction rate', fmt.pct(t.effectiveRate), 'tax, NI and loans ÷ income'),
    m ? stat('Marginal rate', fmt.pct(m.rate, 0), `of your next £${m.step} ${m.on === 'employment' ? 'of salary' : 'of profit'}`) : null,
    r.income.employment.grossPay > 0 ? stat('Cost to your employer', money(t.employerCost), `incl. ${fmt.pct(r.nationalInsurance.class1.employerRate, 0)} employer NI`) : null,
  ]);
  card.append(stats);
  card.append(explain('What do these rates mean?', [
    el('p', { html: '<b>Effective rate</b> is the share of your total income that goes on income tax, National Insurance, student loan and the Child Benefit charge. <b>Marginal rate</b> is how much of the <i>next</i> pound you earn is lost to those deductions - useful when weighing up a pay rise, bonus or extra pension contribution. Between £100,000 and £125,140 the marginal rate jumps because the Personal Allowance is withdrawn.' }),
  ]));
  return card;
}

function stat(k, v, s) {
  return el('div', { class: 'stat' }, [el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }), s ? el('div', { class: 's', text: s }) : null]);
}

function incomeCard(r, rates) {
  const e = r.income.employment, s = r.income.selfEmployment, i = r.income;
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'card-header' }, [el('div', {}, [el('h2', { text: 'Step 1 · Your income' }), el('p', { text: 'What counts as income for tax.' })])]));
  const rows = [];
  if (e.grossPay > 0 || e.taxableBenefits > 0) {
    rows.push(['Salary', money(e.salary)]);
    if (e.bonus > 0) rows.push(['Bonus', money(e.bonus)]);
    if (e.pensionGross > 0 && (e.pensionMethod === 'salary_sacrifice' || e.pensionMethod === 'net_pay')) {
      rows.push([e.pensionMethod === 'salary_sacrifice' ? 'Salary sacrificed into pension' : 'Pension (net pay arrangement)', '− ' + money(e.pensionGross), { neg: true, sub: true }]);
    }
    if (e.pensionGross > 0 && e.pensionMethod === 'relief_at_source') {
      rows.push(['Pension (relief at source)', money(e.pensionGross), { sub: true, note: `You pay ${money(e.pensionCash)}; the provider claims ${money(e.pensionGross - e.pensionCash)} basic-rate relief. Does not reduce taxable pay but extends your basic-rate band (Step 3).` }]);
    }
    if (e.taxableBenefits > 0) rows.push(['Taxable benefits in kind', money(e.taxableBenefits)]);
    if (e.expenses > 0) rows.push(['Allowable work expenses', '− ' + money(e.expenses), { neg: true, sub: true }]);
    rows.push(['Taxable employment income', money(e.taxableIncome), { total: true }]);
  }
  if (s.turnover > 0) {
    rows.push(['Self-employed turnover', money(s.turnover)]);
    if (s.deduction === 'trading_allowance') rows.push(['Trading allowance', '− ' + money(s.tradingAllowanceUsed), { neg: true, sub: true, note: s.auto ? `Chosen automatically: it beats deducting your ${money(s.expenses)} of expenses.` : null }]);
    else rows.push(['Allowable expenses', '− ' + money(s.expensesUsed), { neg: true, sub: true, note: s.auto ? 'Chosen automatically: it beats the £1,000 trading allowance.' : null }]);
    rows.push(['Taxable profit', money(s.profit), { total: true }]);
    if (s.pensionGross > 0) rows.push(['Personal pension (relief at source)', money(s.pensionGross), { sub: true, note: `You pay ${money(s.pensionPaid)}; the provider adds ${money(s.pensionGross - s.pensionPaid)}. Extends your basic-rate band (Step 3).` }]);
  }
  const pr = i.property;
  if (pr.rentalIncome > 0) {
    rows.push(['Rental income', money(pr.rentalIncome)]);
    if (pr.deduction === 'property_allowance') rows.push(['Property allowance', '− ' + money(pr.propertyAllowanceUsed), { neg: true, sub: true, note: pr.auto ? 'Chosen automatically: it beats deducting expenses and claiming the mortgage interest credit.' : null }]);
    else rows.push(['Allowable property expenses', '− ' + money(pr.expensesUsed), { neg: true, sub: true, note: pr.auto ? 'Chosen automatically: expenses plus the mortgage interest credit beat the £1,000 property allowance.' : null }]);
    rows.push(['Taxable property profit', money(pr.profit), { total: true, note: pr.financeCosts > 0 ? `Mortgage interest of ${money(pr.financeCosts)} is not deducted here; a 20% tax credit is given in Step 3 instead.` : null }]);
  }
  if (i.savings > 0) rows.push(['Savings interest', money(i.savings)]);
  if (i.dividends > 0) rows.push(['Dividends', money(i.dividends)]);
  if (i.otherIncome > 0) rows.push(['Other income', money(i.otherIncome)]);
  rows.push(['Total income for tax', money(i.total), { total: true }]);
  card.append(linesTable(rows));
  if (pr.rentalIncome > 0) card.append(explain('How landlords are taxed', [
    el('p', { text: 'Rental profit is rent less allowable running costs. Since April 2020 residential landlords cannot deduct mortgage interest or other finance costs. Instead the tax bill is reduced by 20% of the finance costs (limited to the lower of the finance costs, the property profit and your total non-savings income after allowances). Higher-rate taxpayers therefore pay more than under the old rules. There is no National Insurance on rental income.' }),
  ]));
  card.append(explain('How pensions affect this', [
    el('ul', {}, [
      el('li', { html: '<b>Salary sacrifice:</b> you give up pay and your employer pays it into your pension. It never counts as income, so you save income tax <i>and</i> National Insurance on it.' }),
      el('li', { html: '<b>Net pay arrangement:</b> the contribution is taken from your pay before tax is worked out, so you get full tax relief automatically, but you still pay NI on it.' }),
      el('li', { html: '<b>Relief at source:</b> the contribution is taken after tax. Your provider claims 20% back from HMRC and adds it to your pot. If you pay higher-rate tax, the extra relief is given by stretching your basic-rate band (Step 3) - you\'d normally claim it through Self Assessment or by asking HMRC to adjust your tax code.' }),
    ]),
  ]));
  return card;
}

function allowancesCard(r, rates) {
  const a = r.allowances;
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'card-header' }, [el('div', {}, [el('h2', { text: 'Step 2 · Tax-free allowances' }), el('p', { text: 'The part of your income that is not taxed.' })])]));
  const rows = [
    ['Standard Personal Allowance', money(a.personalAllowanceStandard)],
  ];
  if (a.taper > 0) {
    rows.push(['Adjusted net income', money(a.adjustedNetIncome), { sub: true, note: `Income above ${fmt.gbp(a.incomeLimit)} reduces the allowance by £1 for every £2.` }]);
    rows.push(['Reduction', '− ' + money(a.taper), { neg: true, sub: true }]);
  }
  if (a.blindPersonsAllowance) rows.push(["Blind Person's Allowance", '+ ' + money(a.blindPersonsAllowance)]);
  if (a.marriageTransfer) rows.push(['Marriage Allowance transferred to partner', '− ' + money(a.marriageTransfer), { neg: true }]);
  rows.push(['Your tax-free allowance', money(a.total), { total: true }]);
  card.append(linesTable(rows));
  const alloc = [];
  if (a.allocated.nonSavings) alloc.push(`${money(a.allocated.nonSavings)} against earnings`);
  if (a.allocated.savings) alloc.push(`${money(a.allocated.savings)} against savings interest`);
  if (a.allocated.dividends) alloc.push(`${money(a.allocated.dividends)} against dividends`);
  if (a.unused > 0) alloc.push(`${money(a.unused)} unused`);
  card.append(el('p', { class: 'muted small', style: 'margin-top:10px', text: `Used: ${alloc.join(', ') || 'nothing to set it against'}. Taxable income after allowances: ${money(a.taxable.total)}.` }));
  card.append(explain('Why might my allowance be lower?', [
    el('p', { html: `Everyone starts with the standard Personal Allowance. If your <b>adjusted net income</b> (total income minus gross pension contributions paid from taxed pay and Gift Aid) is over ${fmt.gbp(a.incomeLimit)}, the allowance drops by £1 for every £2 above that, reaching zero at ${fmt.gbp(a.incomeLimit + 2 * a.personalAllowanceStandard)}. Paying more into a pension is the usual way to keep your allowance.` }),
  ]));
  return card;
}

function incomeTaxCard(r, rates) {
  const it = r.incomeTax;
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'card-header' }, [el('div', {}, [el('h2', { text: 'Step 3 · Income tax' }), el('p', { text: r.region === 'scotland' ? 'Scottish rates on earnings; UK rates on savings and dividends.' : 'Taxable income is filled into the bands from the bottom up.' })])]));
  const rows = [];
  const pieceRows = (pieces, group) => pieces.map((p) => [
    el('span', {}, [el('span', { class: 'band-rate', text: fmt.pct(p.rate, 2) }), ` ${p.name}`]),
    money(p.tax),
    { mid: money(p.amount) },
  ]);
  if (it.nonSavings.pieces.length) { rows.push([el('b', { text: 'Earnings and other income' }), '', { mid: '' }]); rows.push(...pieceRows(it.nonSavings.pieces)); }
  if (it.savings.pieces.length) { rows.push([el('b', { text: 'Savings interest' }), '', { mid: '' }]); rows.push(...pieceRows(it.savings.pieces)); }
  if (it.dividends.pieces.length) { rows.push([el('b', { text: 'Dividends' }), '', { mid: '' }]); rows.push(...pieceRows(it.dividends.pieces)); }
  if (it.marriageReducer > 0) rows.push(['Marriage Allowance tax reduction', '− ' + money(it.marriageReducer), { neg: true, mid: '' }]);
  if (it.financeCostReducer > 0) rows.push([`Mortgage interest tax credit (${fmt.pct(it.financeCostReliefRate, 0)} of ${money(it.financeCostReliefBase)})`, '− ' + money(it.financeCostReducer), { neg: true, mid: '', note: it.financeCostReliefBase < r.income.property.financeCosts ? 'Limited to your property profit; the unused amount carries forward to future years.' : null }]);
  rows.push(['Total income tax', money(it.total), { total: true, mid: money(r.allowances.taxable.total) }]);
  if (!rows.length) rows.push(['No income tax due', money(0), { mid: '' }]);
  card.append(el('div', { class: 'table-scroll' }, linesTable(rows, { header: ['Band', 'Amount', 'Tax'] })));

  const bandsText = it.bands.map((b) => `${b.name} ${fmt.pct(b.rate, 0)}: ${b.from === 0 ? 'up to' : fmt.gbp(b.from + 1) + ' to'} ${b.to == null ? 'no limit' : fmt.gbp(b.to)}`).join(' · ');
  const notes = [el('p', { html: `<b>Bands of taxable income (after allowances):</b> ${bandsText}.` })];
  if (it.bandExtension > 0) notes.push(el('p', { style: 'margin-top:8px', html: `Your band limits have been extended by <b>${fmt.gbp(it.bandExtension)}</b> for pension contributions paid from taxed pay and Gift Aid, so more income is taxed at the basic rate.` }));
  if (r.income.savings > 0) notes.push(el('p', { style: 'margin-top:8px', html: `Savings interest gets up to £${rates.incomeTax.savings.startingRateBand.toLocaleString('en-GB')} at the 0% starting rate (reduced by every £1 of earnings over your allowance) plus a Personal Savings Allowance of <b>${fmt.gbp(it.savings.personalSavingsAllowance)}</b> because you are a ${it.level}-rate taxpayer.` }));
  if (r.income.dividends > 0) notes.push(el('p', { style: 'margin-top:8px', html: `The first ${fmt.gbp(it.dividends.allowance)} of dividends is tax-free, then they are taxed at dividend rates depending on which band they fall in when stacked on top of your other income.` }));
  card.append(explain('How the bands work', notes));
  return card;
}

function niCard(r, rates) {
  const ni = r.nationalInsurance;
  const c1 = ni.class1, c4 = ni.class4, c2 = ni.class2;
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'card-header' }, [el('div', {}, [el('h2', { text: 'Step 4 · National Insurance' }), el('p', { text: 'Charged on earnings and profits, not on savings or dividends.' })])]));
  const rows = [];
  if (r.income.employment.grossPay > 0) {
    rows.push([el('b', { text: 'Class 1 (employee)' }), '', { mid: '' }]);
    rows.push(['Earnings for NI', '', { mid: money(c1.niablePay) }]);
    rows.push([el('span', {}, [el('span', { class: 'band-rate', text: fmt.pct(c1.mainRate, 0) }), ` on ${fmt.gbp(c1.primaryThreshold)} to ${fmt.gbp(c1.upperEarningsLimit)}`]), money(c1.main), { mid: money(Math.min(Math.max(c1.niablePay - c1.primaryThreshold, 0), c1.upperEarningsLimit - c1.primaryThreshold)) }]);
    if (c1.upper > 0) rows.push([el('span', {}, [el('span', { class: 'band-rate', text: fmt.pct(c1.upperRate, 0) }), ` above ${fmt.gbp(c1.upperEarningsLimit)}`]), money(c1.upper), { mid: money(c1.niablePay - c1.upperEarningsLimit) }]);
  }
  if (r.income.selfEmployment.profit > 0) {
    rows.push([el('b', { text: 'Class 4 (self-employed)' }), '', { mid: '' }]);
    rows.push([el('span', {}, [el('span', { class: 'band-rate', text: fmt.pct(c4.mainRate, 0) }), ` on ${fmt.gbp(c4.lowerProfitsLimit)} to ${fmt.gbp(c4.upperProfitsLimit)}`]), money(c4.main), { mid: money(c4.mainBandProfits - c4.displacedProfits), note: c4.annualMaximumApplied ? 'Reduced because your employee NI already covers part of this band (annual maximum rule).' : null }]);
    if (c4.upper > 0) rows.push([el('span', {}, [el('span', { class: 'band-rate', text: fmt.pct(c4.upperRate, 0) }), c4.annualMaximumApplied ? ' on remaining profits' : ` above ${fmt.gbp(c4.upperProfitsLimit)}`]), money(c4.upper), { mid: money(Math.max(0, c4.profit - c4.upperProfitsLimit) + c4.displacedProfits) }]);
    rows.push(['Class 2', money(0), { mid: '', note: c2.status === 'credited' ? `Profits are above ${fmt.gbp(c2.smallProfitsThreshold)}, so you get NI credits for free.` : `Profits are below ${fmt.gbp(c2.smallProfitsThreshold)}. You can pay voluntary Class 2 (${fmt.gbp(c2.weeklyRate, 2)} a week, ${fmt.gbp(c2.voluntaryAnnual)} a year) to protect your State Pension record - not included here.` }]);
  }
  rows.push(['Total National Insurance', money(ni.total), { total: true, mid: '' }]);
  card.append(el('div', { class: 'table-scroll' }, linesTable(rows, { header: ['', 'Amount', 'NI'] })));
  const notes = [];
  if (r.income.employment.grossPay > 0) notes.push(el('p', { html: `Employee NI is worked out here on an annual basis. Through payroll it is calculated each pay period, so if your pay is uneven (for example a big bonus month) the real total can differ slightly. Your employer separately pays ${fmt.pct(c1.employerRate, 0)} on your earnings above ${fmt.gbp(c1.secondaryThreshold)} (${money(c1.employer)}), which does not come out of your pay.` }));
  if (r.income.selfEmployment.profit > 0) notes.push(el('p', { style: 'margin-top:8px', html: `Class 4 is charged on profits and paid with your Self Assessment bill. Since April 2024 nobody has to pay Class 2 - if your profits are over the small profits threshold you get the credits automatically.` }));
  if (c4.annualMaximumApplied) notes.push(el('p', { style: 'margin-top:8px', html: `Because you pay both employee NI and Class 4, the law caps the total you pay at the main rate. The main-rate Class 4 band is reduced by the employee NI you have already paid, and the profits that no longer fit are charged at ${fmt.pct(c4.upperRate, 0)} instead. HMRC applies this automatically in Self Assessment.` }));
  if (notes.length) card.append(explain('Good to know', notes));
  return card;
}

function studentLoanCard(r, rates) {
  const s = r.studentLoans;
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'card-header' }, [el('div', {}, [el('h2', { text: 'Step 5 · Student loan' }), el('p', { text: 'Repayments are a percentage of income above the plan threshold.' })])]));
  const rows = [['Income counted for repayments', money(s.income), { note: s.unearnedIncluded > 0 ? 'Includes savings, dividends and other income because they exceed £2,000.' : null }]];
  if (s.undergraduate) {
    const names = s.undergraduate.plans.map((p) => rates.studentLoans[p].name).join(' + ');
    rows.push([`${names}: ${fmt.pct(s.undergraduate.rate, 0)} of income over ${fmt.gbp(s.undergraduate.threshold)}`, money(s.undergraduate.amount), { note: s.undergraduate.plans.length > 1 ? 'With more than one undergraduate plan the 9% is split between them, so the total uses the lowest threshold.' : null }]);
  }
  if (s.postgraduate) rows.push([`Postgraduate Loan: ${fmt.pct(s.postgraduate.rate, 0)} of income over ${fmt.gbp(s.postgraduate.threshold)}`, money(s.postgraduate.amount)]);
  rows.push(['Total repayments', money(s.total), { total: true }]);
  card.append(linesTable(rows));
  card.append(explain('How repayments are taken', [el('p', { text: 'If you are employed, repayments are deducted through payroll based on each pay period, so a bonus month can trigger a repayment even if your annual income is below the threshold. If you are self-employed, or have other income over £2,000, repayments are worked out on your Self Assessment return.' })]));
  return card;
}

function hicbcCard(r, rates) {
  const h = r.hicbc;
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'card-header' }, [el('div', {}, [el('h2', { text: 'High Income Child Benefit Charge' }), el('p', { text: `Applies when adjusted net income is over ${fmt.gbp(h.threshold)}.` })])]));
  card.append(linesTable([
    [`Child Benefit for ${h.children} ${h.children === 1 ? 'child' : 'children'}`, money(h.childBenefitAnnual), { note: h.optedOut ? 'You have opted out of payments, so nothing is received and no charge applies.' : 'Not taxable income, but clawed back through the charge below if your income is high.' }],
    ['Your adjusted net income', money(r.allowances.adjustedNetIncome)],
    [`Charge: ${h.percent}% of Child Benefit`, '− ' + money(h.charge), { neg: true, note: h.percent === 0 ? 'No charge - your income is under the threshold.' : `1% for every ${fmt.gbp(rates.childBenefit.hicbc.stepPounds)} over ${fmt.gbp(h.threshold)}, all of it from ${fmt.gbp(h.fullWithdrawal)}.` }],
    ['Child Benefit you keep', money(h.netKept), { total: true }],
  ]));
  card.append(explain('Can I avoid this?', [el('p', { text: 'The charge is based on the higher earner in the household and on adjusted net income, so pension contributions and Gift Aid reduce it. Unless your income is over the full-withdrawal point it is usually better to keep receiving the payments and pay the charge. Families who do opt out should still register the claim to protect National Insurance credits. The charge is normally collected through Self Assessment or PAYE.' })]));
  return card;
}

function sourcesCard(rates) {
  const card = el('div', { class: 'card' });
  const n = Object.keys(state.overrides).length;
  if (n) card.append(el('div', { class: 'note-box warn', style: 'margin-bottom:14px' }, [el('p', { html: `<b>${n} figure${n === 1 ? '' : 's'} changed from the official values.</b> The results above use your custom rates, not the GOV.UK ones listed below.` }), el('p', {}, el('button', { type: 'button', class: 'btn', style: 'margin-top:8px', text: 'Reset to official figures', onclick: () => { state.overrides = {}; buildRatesEditor(true); render(); } }))]));
  card.append(el('div', { class: 'card-header' }, [el('div', {}, [el('h2', { text: 'Assumptions and sources' }), el('p', { text: `Rates for ${rates.label} verified against GOV.UK on ${new Date(rates.verified).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.` })])]));
  card.append(el('ul', { class: 'small', style: 'margin:0 0 14px; padding-left:18px; color:var(--text-2)' }, [
    el('li', { text: 'You are UK resident with a standard tax code, and the figures cover a full tax year.' }),
    el('li', { text: 'Wales uses the same rates as England and Northern Ireland. Scottish rates apply to earnings only; savings and dividends use UK rates.' }),
    el('li', { text: 'Allowances are set against earnings first, then savings, then dividends (HMRC\'s standard order).' }),
    el('li', { text: 'Employee NI is calculated annually. Losses, capital gains, pension annual allowance limits and tapered allowances for very high earners are not modelled.' }),
  ]));
  card.append(el('h3', { text: 'Official sources', style: 'margin-bottom:8px' }));
  card.append(el('ul', { class: 'sources' }, rates.sources.map((s) => el('li', {}, [el('a', { href: s.url, target: '_blank', rel: 'noopener', text: s.title }), el('span', { text: s.covers.join(' · ') })]))));
  return card;
}

// ------------------------------------------------------------------ custom rates editor
function rateFields(base, region) {
  const bands = base.incomeTax.bands[region];
  const sl = base.studentLoans;
  return [
    { group: 'Allowances', fields: [
      ['incomeTax.personalAllowance', 'Personal Allowance', 'money'],
      ['incomeTax.personalAllowanceIncomeLimit', 'Allowance taper starts at', 'money'],
      ['incomeTax.blindPersonsAllowance', "Blind Person's Allowance", 'money'],
      ['incomeTax.marriageAllowanceTransfer', 'Marriage Allowance transfer', 'money'],
      ['incomeTax.tradingAllowance', 'Trading allowance', 'money'],
      ['incomeTax.propertyAllowance', 'Property allowance', 'money'],
    ] },
    { group: region === 'scotland' ? 'Scottish income tax bands (taxable income after allowances)' : 'Income tax bands (taxable income after allowances)', fields: bands.flatMap((b, i) => [
      [`incomeTax.bands.${region}.${i}.rate`, `${b.name}`, 'pct'],
      [`incomeTax.bands.${region}.${i}.upTo`, `${b.name} up to`, 'money', b.upTo == null],
    ]) },
    { group: 'Savings and dividends', fields: [
      ['incomeTax.savings.startingRateBand', 'Starting rate for savings band', 'money'],
      ['incomeTax.savings.personalSavingsAllowance.basic', 'Savings allowance (basic rate)', 'money'],
      ['incomeTax.savings.personalSavingsAllowance.higher', 'Savings allowance (higher rate)', 'money'],
      ['incomeTax.savings.personalSavingsAllowance.additional', 'Savings allowance (additional)', 'money'],
      ['incomeTax.dividends.allowance', 'Dividend allowance', 'money'],
      ['incomeTax.dividends.rates.basic', 'Dividend basic rate', 'pct'],
      ['incomeTax.dividends.rates.higher', 'Dividend higher rate', 'pct'],
      ['incomeTax.dividends.rates.additional', 'Dividend additional rate', 'pct'],
      ['incomeTax.financeCostReliefRate', 'Landlord mortgage interest credit', 'pct'],
    ] },
    { group: 'National Insurance', fields: [
      ['nationalInsurance.class1.primaryThreshold', 'Class 1 primary threshold', 'money'],
      ['nationalInsurance.class1.upperEarningsLimit', 'Class 1 upper earnings limit', 'money'],
      ['nationalInsurance.class1.employeeMainRate', 'Employee main rate', 'pct'],
      ['nationalInsurance.class1.employeeUpperRate', 'Employee upper rate', 'pct'],
      ['nationalInsurance.class1.secondaryThreshold', 'Employer secondary threshold', 'money'],
      ['nationalInsurance.class1.employerRate', 'Employer rate', 'pct'],
      ['nationalInsurance.class4.lowerProfitsLimit', 'Class 4 lower profits limit', 'money'],
      ['nationalInsurance.class4.upperProfitsLimit', 'Class 4 upper profits limit', 'money'],
      ['nationalInsurance.class4.mainRate', 'Class 4 main rate', 'pct'],
      ['nationalInsurance.class4.upperRate', 'Class 4 upper rate', 'pct'],
      ['nationalInsurance.class2.smallProfitsThreshold', 'Class 2 small profits threshold', 'money'],
      ['nationalInsurance.class2.weeklyRate', 'Class 2 weekly rate', 'money2'],
    ] },
    { group: 'Student loans', fields: ['plan1', 'plan2', 'plan4', 'plan5', 'postgraduate'].flatMap((p) => [
      [`studentLoans.${p}.threshold`, `${sl[p].name} threshold`, 'money'],
      [`studentLoans.${p}.rate`, `${sl[p].name} rate`, 'pct'],
    ]) },
    { group: 'Child Benefit', fields: [
      ['childBenefit.weeklyEldest', 'Weekly rate, eldest child', 'money2'],
      ['childBenefit.weeklyOther', 'Weekly rate, other children', 'money2'],
      ['childBenefit.hicbc.threshold', 'Charge starts at', 'money'],
      ['childBenefit.hicbc.fullWithdrawal', 'Fully withdrawn at', 'money'],
    ] },
  ];
}
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const fmtRateValue = (v, type) => (v == null ? '' : type === 'pct' ? String(Math.round(v * 10000) / 100) : type === 'money2' ? v.toFixed(2) : String(v));

function buildRatesEditor(force) {
  const yearId = form.y.value, region = form.r.value;
  const base = state.rates[yearId];
  if (!base) return;
  const key = `${yearId}|${region}`;
  if (!force && state.editorKey === key) return;
  state.editorKey = key;
  const root = $('#rates-editor');
  root.innerHTML = '';
  for (const g of rateFields(base, region)) {
    root.append(el('h3', { text: g.group }));
    const grid = el('div', { class: 'rates-grid' });
    for (const [path, label, type, noLimit] of g.fields) {
      const baseVal = getPath(base, path);
      const cur = state.overrides[path] != null ? Number(state.overrides[path]) : baseVal;
      const id = 'rf-' + path.replace(/\W/g, '-');
      const input = el('input', { id, type: 'text', inputmode: 'decimal', 'data-path': path, 'data-type': type, 'data-base': baseVal == null ? '' : String(baseVal), value: fmtRateValue(cur, type), disabled: !!noLimit, placeholder: noLimit ? 'No limit' : '' });
      const wrap = el('div', { class: 'input-wrap' + (state.overrides[path] != null ? ' changed' : '') }, type === 'pct' ? [input, el('span', { class: 'affix suffix', text: '%' })] : [el('span', { class: 'affix', text: '£' }), input]);
      grid.append(el('div', { class: 'field' }, [el('label', { for: id, text: label }), wrap]));
    }
    root.append(grid);
  }
}

function onRateEdit(e) {
  const input = e.target.closest('input[data-path]');
  if (!input) return;
  const path = input.dataset.path, type = input.dataset.type;
  const raw = input.value.trim();
  const baseVal = input.dataset.base === '' ? null : Number(input.dataset.base);
  let v = raw === '' ? null : parseNum(raw);
  if (v != null && type === 'pct') v = Math.round(v * 100) / 10000;
  if (v == null || (baseVal != null && Math.abs(v - baseVal) < 1e-9)) delete state.overrides[path];
  else state.overrides[path] = v;
  input.closest('.input-wrap').classList.toggle('changed', state.overrides[path] != null);
  render();
}

init();
