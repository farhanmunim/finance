import { evaluate, contributionCost, contributionsForYear, extraToReachTarget, contributionScenarios, retireAgeScenarios, growthScenarios, statePension, statePensionAge, minimumPensionAge, defaultAnnuityRate, pensionRates, MAX_AGE } from './pension-engine.js?v=587af5ffca';
import { lineChart as drawLineChart } from './charts.js?v=6af7b529a9';
import { fmt, parseNum, initMoneyInputs, initNumberInputs, captionTables, $, $$, el, linesTable, urlState, debounce, loadJSON, announce, linkHints } from './ui.js?v=60c2d4f53d';

const form = $('#form');
const f = form.elements;
const results = $('#results');
const COLOR_BASE = '#2a78d6';
const COLOR_OVER = '#eb6834';
const COLOR_GREEN = '#1baf7a';
const COLOR_PURPLE = '#7c5cd6';
const state = { rates: null };
const view = { real: true, inflation: 2.5 };
const lineChart = (series, opts) => drawLineChart(series, { width: results.clientWidth, ...opts });

const DEFAULTS = { growth: 5, charges: 0.75, inflation: 2.5, payRise: 2.5, retireGrowth: 4, withdrawal: 4 };
const FREQ_LABEL = { weekly: 'a week', monthly: 'a month', quarterly: 'a quarter', yearly: 'a year' };
const METHOD_HINTS = {
  relief_at_source: 'You pay 80% of what goes in and your provider claims the other 20% from the government. Higher-rate taxpayers can claim extra back.',
  net_pay: 'Taken from your pay before tax, so you get full tax relief automatically. National Insurance is still due on that pay.',
  salary_sacrifice: 'You give up part of your salary, so you save income tax and National Insurance. Your employer may share its saving.',
};

// ------------------------------------------------------------------ boot
function showError(message) {
  results.innerHTML = '';
  results.append(el('div', { class: 'card' }, [
    el('h2', { text: 'Something went wrong' }),
    el('p', { class: 'muted', style: 'margin-top:8px', text: message }),
    el('p', { style: 'margin-top:12px' }, el('button', { type: 'button', class: 'btn primary', text: 'Reload the page', onclick: () => location.reload() })),
  ]));
}

async function init() {
  restoreFromUrl();
  initMoneyInputs(form);
  initNumberInputs(form);
  linkHints(form);
  const rerender = debounce(() => { syncVisibility(); render(); }, 80);
  form.addEventListener('input', rerender);
  form.addEventListener('change', (e) => { if (e.target.matches('input:not([type=radio]):not([type=checkbox])')) return; syncVisibility(); render(); });
  form.addEventListener('submit', (e) => e.preventDefault());
  f.c.addEventListener('blur', formatContribution);
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', debounce(() => { if (window.innerWidth !== lastWidth) { lastWidth = window.innerWidth; render(); } }, 150));
  syncVisibility();
  try {
    const index = await loadJSON('/data/tax-years/index.json');
    const meta = index.years.find((y) => y.id === index.default) || index.years[0];
    state.rates = await loadJSON(meta.file);
  } catch (e) {
    showError(`The tax rates could not be loaded (${e.message}). Check your connection and try again.`);
    return;
  }
  render();
}

function restoreFromUrl() {
  const q = urlState.read();
  const setRadio = (name, v) => { const r = $(`input[name="${name}"][value="${v}"]`, form); if (r) r.checked = true; };
  for (const k of ['a', 'ra', 'sal', 'p', 'c', 'ep', 'ea', 'em', 'sa', 'ny', 'wr', 'ar', 'oi', 'tg', 'g', 'ch', 'inf', 'pr', 'rg']) if (q[k] != null && f[k]) f[k].value = q[k];
  for (const k of ['cf', 'cm', 'ef']) if (q[k] && [...f[k].options].some((o) => o.value === q[k])) f[k].value = q[k];
  for (const k of ['reg', 'ct', 'et', 'im', 'tf']) if (q[k]) setRadio(k, q[k]);
  if (q.rl === '0') f.rl.checked = false;
  if (q.sp === '0') f.sp.checked = false;
  if (q.ai) f.ai.checked = true;
  if (q.es) f.es.checked = true;
  const open = (id, keys) => { if (keys.some((k) => q[k])) $(id).open = true; };
  open('#sec-sp', ['sa', 'ny', 'sp']);
  open('#sec-take', ['im', 'wr', 'ar', 'ai', 'tf', 'oi']);
  open('#sec-target', ['tg']);
  open('#sec-assume', ['g', 'ch', 'inf', 'pr', 'rg', 'es']);
}

// ------------------------------------------------------------------ form
const numOr = (v, d) => (String(v ?? '').trim() === '' ? d : parseNum(v));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function formatContribution() {
  const n = parseNum(f.c.value);
  if (f.c.value.trim() === '' || n === 0) return;
  f.c.value = f.ct.value === 'percent' ? String(Math.round(n * 100) / 100) : n.toLocaleString('en-GB', { maximumFractionDigits: 2 });
}

let lastContribType = null;
function syncVisibility() {
  // Switching £ <-> % of salary converts the figure so the contribution stays the same
  if (lastContribType && lastContribType !== f.ct.value) {
    const salary = parseNum(f.sal.value), n = parseNum(f.c.value), perYear = { weekly: 52, monthly: 12, quarterly: 4, yearly: 1 }[f.cf.value] || 12;
    if (salary > 0 && n > 0) f.c.value = f.ct.value === 'percent' ? String(Math.round(((n * perYear) / salary) * 10000) / 100) : String(Math.round((salary * n) / 100 / perYear * 100) / 100);
  }
  lastContribType = f.ct.value;
  $('#contribAffix').textContent = f.ct.value === 'percent' ? '%' : '£';
  f.c.placeholder = f.ct.value === 'percent' ? 'e.g. 5' : 'e.g. 250';
  if (document.activeElement !== f.c) formatContribution();
  $('#contrib-hint').textContent = f.ct.value === 'percent' ? 'Share of your salary, including any tax relief your provider adds.' : 'Include any tax relief your provider adds, so this is the total that goes into your pot.';
  $('#method-hint').textContent = METHOD_HINTS[f.cm.value] || '';
  $('#emp-percent-field').hidden = f.et.value !== 'percent';
  $('#emp-amount-field').hidden = f.et.value !== 'amount';
  $('#emp-match-field').hidden = f.et.value !== 'match';
  const annuity = f.im.value === 'annuity';
  $('#wr-field').hidden = annuity;
  $('#ann-fields').hidden = !annuity;
  $('#im-hint').textContent = annuity
    ? 'Swap the pot for a guaranteed income that is paid for life, however long you live.'
    : 'Keep the pot invested and take an income from it. It can run out if you take too much.';
  $('#tf-spread').disabled = annuity;
  if (annuity && f.tf.value === 'spread') $('#tf-up').checked = true;
  $('#tf-hint').textContent = { upfront: 'Take a quarter of the pot tax-free at retirement. The rest pays your income.', spread: 'Every payment you take is a quarter tax-free and three quarters taxable.', none: 'Everything you take is taxed as income. Rarely the best choice.' }[f.tf.value];
}

function readForm() {
  const raw = {};
  for (const el_ of form.elements) {
    if (!el_.name || (el_.type === 'radio' && !el_.checked)) continue;
    raw[el_.name] = el_.type === 'checkbox' ? (el_.checked ? '1' : '') : el_.value;
  }
  raw.rl = f.rl.checked ? '' : '0';
  raw.sp = f.sp.checked ? '' : '0';
  const thisYear = new Date().getFullYear();
  const age = clamp(Math.round(parseNum(raw.a)), 0, 75);
  const retireAge = clamp(Math.round(parseNum(raw.ra)), 0, 80);
  const salary = parseNum(raw.sal);
  const spaDefault = age ? statePensionAge(thisYear - age) : 67;
  const spa = raw.sa.trim() === '' ? spaDefault : clamp(Math.round(parseNum(raw.sa)), 60, 75);
  const inflation = clamp(numOr(raw.inf, DEFAULTS.inflation), 0, 15);
  const method = raw.im === 'annuity' ? 'annuity' : 'drawdown';
  const o = {
    age, retireAge, pot: parseNum(raw.p), salary, region: raw.reg === 'scotland' ? 'scotland' : 'ruk',
    member: { amount: parseNum(raw.c), freq: raw.cf, type: raw.ct === 'percent' ? 'percent' : 'amount', method: raw.cm },
    employer: { type: raw.et, value: raw.et === 'amount' ? parseNum(raw.ea) : raw.et === 'match' ? parseNum(raw.em) : parseNum(raw.ep), freq: raw.ef },
    payRise: clamp(numOr(raw.pr, DEFAULTS.payRise), 0, 15), escalate: !!raw.es,
    growth: clamp(numOr(raw.g, DEFAULTS.growth), -5, 15), charges: clamp(numOr(raw.ch, DEFAULTS.charges), 0, 5),
    inflation, retireGrowth: clamp(numOr(raw.rg, DEFAULTS.retireGrowth), -5, 15),
    spa, qualifyingYears: raw.ny.trim() === '' ? null : clamp(Math.round(parseNum(raw.ny)), 0, 35), includeStatePension: raw.sp !== '0',
    method, withdrawalRate: clamp(numOr(raw.wr, DEFAULTS.withdrawal), 0.5, 15), annuityRate: raw.ar.trim() === '' ? 0 : clamp(parseNum(raw.ar), 1, 20), annuityRises: !!raw.ai,
    taxFree: raw.tf, otherIncome: parseNum(raw.oi),
  };
  return { raw, o, thisYear, spaDefault, target: parseNum(raw.tg) };
}

// ------------------------------------------------------------------ render
function render() {
  const { raw, o, thisYear, spaDefault, target } = readForm();
  urlState.write(raw);
  view.real = raw.rl !== '0';
  view.inflation = o.inflation;
  const pr = pensionRates(state.rates);

  // Placeholders that show what will be used when a field is left empty
  $('#spa').placeholder = String(spaDefault);
  const estYears = o.age ? Math.min(pr.statePensionFullYears, Math.max(0, o.age - 18)) : 0;
  $('#qyears').placeholder = o.age ? `about ${estYears}` : 'e.g. 20';
  $('#ar').placeholder = o.retireAge ? String(defaultAnnuityRate(o.retireAge, o.annuityRises)) : 'e.g. 6.8';
  $('#ar-hint').textContent = o.retireAge ? `Yearly income for every £100 handed over. We guess ${defaultAnnuityRate(o.retireAge, o.annuityRises)}% for your age; ask a provider for a real quote.` : 'Yearly income for every £100 handed over. Ask a provider for a quote.';

  const openSummaries = new Set($$('details[open] > summary', results).map((x) => x.textContent));
  results.innerHTML = '';
  $('#mobile-summary').hidden = true;
  const note = $('#age-note');
  note.hidden = true;

  if (!o.age || !o.retireAge) {
    results.append(el('div', { class: 'card' }, el('p', { class: 'muted', text: 'Enter your age and retirement age, and what you pay in, to see your projected pot and retirement income.' })));
    return;
  }
  if (o.retireAge < o.age) {
    note.hidden = false; note.className = 'note-box warn'; note.textContent = 'Your retirement age must be the same as or later than your age now.';
    results.append(el('div', { class: 'card' }, el('p', { class: 'muted', text: 'Your retirement age must be the same as or later than your age now.' })));
    return;
  }
  const minAge = minimumPensionAge(thisYear + (o.retireAge - o.age), pr);
  note.hidden = false;
  if (o.retireAge < minAge) {
    note.className = 'note-box warn';
    note.textContent = `You can't normally take money from a pension before ${minAge}${minAge === 55 ? ' (rising to 57 from 6 April 2028)' : ''}, apart from in ill health. The results assume you can.`;
  } else {
    note.className = 'note-box';
    note.textContent = o.retireAge === o.age ? 'Retiring now: your pot is used as it stands.' : `${o.retireAge - o.age} year${o.retireAge - o.age === 1 ? '' : 's'} until you retire.`;
  }
  const y1 = contributionsForYear(o, 0);
  if (o.pot <= 0 && y1.member + y1.employer <= 0) {
    const needSalary = (o.member.type === 'percent' || ['percent', 'match'].includes(o.employer.type)) && o.salary <= 0 && (o.member.amount > 0 || o.employer.value > 0);
    results.append(el('div', { class: 'card' }, el('p', { class: 'muted', text: needSalary ? 'Enter your salary to use a percentage of salary, or switch to a £ amount.' : 'Enter your pension pot today or what you pay in to see your projection.' })));
    return;
  }

  let r;
  try { r = evaluate(o, state.rates); } catch (e) { showError(`The calculation failed (${e.message}).`); return; }
  const warnings = [...r.proj.warnings, ...r.ret.warnings];
  const cost = o.salary > 0 && y1.member > 0 ? contributionCost({ salary: o.salary, region: o.region, method: o.member.method, memberAnnual: y1.member }, state.rates) : null;
  if (cost) warnings.push(...cost.warnings);
  if ((o.member.type === 'percent' || ['percent', 'match'].includes(o.employer.type)) && o.salary <= 0) warnings.push('You chose a percentage of salary but have not entered a salary, so those contributions count as £0.');

  results.append(heroCard(r, o, y1, warnings));
  if (target > 0) results.append(targetCard(r, o, target));
  results.append(chartCard(r, o));
  results.append(sourcesCard(r));
  if (cost) results.append(costCard(cost, o, y1));
  results.append(incomeCard(r, o));
  results.append(contributionsCard(r, o, y1));
  const ages = retireAgeScenarios(o, state.rates, thisYear);
  if (ages.length > 1) results.append(retireAgeCard(ages, o));
  results.append(growthCard(o));
  results.append(scheduleCard(r, o));
  results.append(assumptionsCard(o));
  captionTables(results);
  for (const sm of $$('details > summary', results)) if (openSummaries.has(sm.textContent)) sm.parentElement.open = true;

  const monthly = incomeShown(r.last, o);
  $('#ms-inc').textContent = fmt.gbp(monthly);
  $('#ms-pot').textContent = fmt.gbp(potShown(r));
  $('#mobile-summary').hidden = false;
  announce(`Projected pot ${fmt.gbp(potShown(r))} at ${o.retireAge}. Income after tax ${fmt.gbp(monthly)} a month${view.real ? " in today's money" : ''}.`);
}

// ------------------------------------------------------------------ helpers
const growthFactor = (years) => Math.pow(1 + view.inflation / 100, years);
/** A figure worked out in today's money, shown in today's money or in the future pounds of `years` from now. */
const inView = (real, years) => (view.real ? real : real * growthFactor(years));
const potShown = (r) => (view.real ? r.proj.potReal : r.proj.potNominal);
/** Monthly take-home (or gross when tax could not be worked out) for a retirement phase. */
const incomeShown = (phase, o) => inView((phase.net ?? phase.gross) / 12, phase.fromAge - o.age);
const moneyWord = () => (view.real ? "today's money" : 'future pounds');

function tile(k, v, s, variant) {
  const cls = variant === 'loss' ? ' primary loss' : variant ? ' primary' : '';
  return el('div', { class: `tile${cls}` }, [el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }), s ? el('div', { class: 's', text: s }) : null]);
}
function stat(k, v, s) {
  return el('div', { class: 'stat' }, [el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }), s ? el('div', { class: 's', text: s }) : null]);
}
function header(title, sub) {
  return el('div', { class: 'card-header' }, [el('div', {}, [el('h2', { text: title }), sub ? el('p', { text: sub }) : null])]);
}
function dataTable(heads, rows, { hl = -1, caption } = {}) {
  const table = el('table', { class: 'lines' });
  if (caption) table.append(el('caption', { class: 'visually-hidden', text: caption }));
  table.append(el('thead', {}, el('tr', {}, heads.map((h) => el('th', { scope: 'col', text: h })))));
  const tbody = el('tbody');
  rows.forEach((cells, i) => tbody.append(el('tr', { class: i === hl ? 'hl' : null }, cells.map((c) => el('td', { text: c })))));
  table.append(tbody);
  return el('div', { class: 'table-scroll' }, table);
}

// ------------------------------------------------------------------ hero
function heroCard(r, o, y1, warnings) {
  const { proj, sp, ret, last } = r;
  const card = el('section', { class: 'card' });
  const years = proj.years;
  card.append(header('Your pension', `${years > 0 ? `Retiring at ${o.retireAge}, in ${years} year${years === 1 ? '' : 's'}` : `Retiring now, at ${o.retireAge}`} · ${ret.method === 'annuity' ? 'annuity' : 'drawdown'} · in ${moneyWord()}`));
  const other = view.real ? `${fmt.gbp(proj.potNominal)} in future pounds` : `worth ${fmt.gbp(proj.potReal)} in today's money`;
  const monthly = incomeShown(last, o);
  const hasTwo = ret.phases.length > 1;
  const thirdIsLump = ret.taxFree === 'upfront';
  card.append(el('div', { class: 'hero' }, [
    tile(`Pot at ${o.retireAge}`, fmt.gbp(potShown(r)), other, true),
    tile('Income after tax', `${fmt.gbp(monthly)}`, `a month${hasTwo || sp.annualReal > 0 ? ` from age ${last.fromAge}` : ''}${last.net == null ? ' (before tax)' : ''}`),
    thirdIsLump
      ? tile('Tax-free lump sum', fmt.gbp(inView(ret.lumpReal, years)), `${fmt.pct(ret.lumpNominal / Math.max(1, proj.potNominal), 0)} of your pot`)
      : tile('Income from your pot', fmt.gbp(inView(ret.potGross / 12, years)), `a month before tax${ret.taxFree === 'spread' ? ', a quarter tax-free' : ''}`),
  ]));
  const stats = [];
  stats.push(sp.annualReal > 0
    ? stat('State Pension', fmt.gbp(inView(sp.annualReal / 12, sp.startAge - o.age)), `a month from age ${sp.startAge} · ${Math.round(sp.years)} qualifying years`)
    : stat('State Pension', o.includeStatePension ? 'Not enough years' : 'Not included', o.includeStatePension ? `${Math.round(sp.years)} of the ${sp.minYears} years needed` : 'switched off'));
  if (o.salary > 0) {
    const salaryReal = o.salary * Math.pow((1 + o.payRise / 100) / (1 + o.inflation / 100), years);
    stats.push(stat('Replaces about', fmt.pct(last.gross / Math.max(1, salaryReal), 0), `of your salary at retirement (${fmt.gbp(salaryReal)} in today's money)`));
  }
  if (ret.method === 'drawdown') {
    stats.push(ret.depleted
      ? stat('Pot lasts until', `age ${Math.floor(ret.lastsToAge)}`, `at ${fmt.pct(ret.rate / 100, ret.rate % 1 ? 1 : 0)} a year, rising with inflation`)
      : stat('Pot lasts', `Past ${MAX_AGE}`, `${fmt.gbp(inView(ret.potAtMax, MAX_AGE - o.age))} still left at ${MAX_AGE}`));
  } else {
    stats.push(stat('Annuity', 'Paid for life', `${ret.rate}% a year${o.annuityRises ? ', rises with inflation' : ', stays the same in pounds'}`));
  }
  card.append(el('div', { class: 'stat-row', style: 'margin-top:14px' }, stats));
  if (hasTwo) {
    const first = ret.phases[0];
    card.append(el('div', { class: 'note-box', style: 'margin-top:14px', html: `From ${first.fromAge} until State Pension age (${last.fromAge}) you would live on your pot${first.other ? ' and other income' : ''}: <b class="num">${fmt.gbp(incomeShown(first, o))}</b> a month after tax. The State Pension then adds <b class="num">${fmt.gbp(inView(sp.annualReal / 12, last.fromAge - o.age))}</b>.` }));
  }
  if (sp.deferralUplift > 0 && sp.annualReal > 0) card.append(el('div', { class: 'note-box', style: 'margin-top:14px', text: `Retiring after State Pension age delays it, which raises it by about ${fmt.pct(sp.deferralUplift, 0)} (1% for every 9 weeks deferred).` }));
  if (warnings.length) card.append(el('div', { class: 'note-box warn', style: 'margin-top:14px' }, warnings.map((w) => el('p', { text: w }))));
  return card;
}

// ------------------------------------------------------------------ target
function targetCard(r, o, target) {
  const card = el('section', { class: 'card' });
  card.append(header('Are you on track?', `Your target of ${fmt.gbp(target)} a month after tax, in today's money.`));
  const { last } = r;
  const projected = (last.net ?? last.gross) / 12;
  const gap = projected - target;
  const maxV = Math.max(projected, target, 1);
  const bars = el('ul', { class: 'bars' });
  for (const [label, v, cur] of [['Target', target, false], ['Projected', projected, true]]) {
    bars.append(el('li', { class: `bar-row${cur ? ' current' : ''}` }, [
      el('span', { text: label }),
      el('span', { class: 'track', 'aria-hidden': 'true' }, el('span', { class: 'fill', style: `width:${(v / maxV) * 100}%` })),
      el('span', { class: 'val', text: fmt.gbp(v) }),
    ]));
  }
  if (gap >= -0.5) {
    card.append(el('div', { class: 'note-box good', html: `You are on track. Your projected income of <b class="num">${fmt.gbp(projected)}</b> a month is <b class="num">${fmt.gbp(Math.max(0, gap))}</b> above your target.` }));
    card.append(el('div', { style: 'margin-top:12px' }, bars));
    return card;
  }
  const extra = extraToReachTarget(o, target * 12, state.rates);
  card.append(el('div', { class: 'note-box warn', html: `You are <b class="num">${fmt.gbp(-gap)}</b> a month short of your target. ${extra == null ? 'Even very large extra payments would not reach it, so consider retiring later or lowering the target.' : `Paying in an extra <b class="num">${fmt.gbp(extra)}</b> a month from now would close the gap.`}` }));
  card.append(el('div', { style: 'margin-top:12px' }, bars));
  if (extra != null && o.salary > 0) {
    const y1 = contributionsForYear(o, 0);
    const base = contributionCost({ salary: o.salary, region: o.region, method: o.member.method, memberAnnual: y1.member }, state.rates)?.cost ?? 0;
    const more = contributionCost({ salary: o.salary, region: o.region, method: o.member.method, memberAnnual: y1.member + extra * 12 }, state.rates);
    if (more) card.append(el('p', { class: 'muted small', style: 'margin-top:10px', text: `After tax relief, that would reduce your take-home pay by about ${fmt.gbp((more.cost - base) / 12)} a month.` }));
  }
  return card;
}

// ------------------------------------------------------------------ chart
function chartCard(r, o) {
  const { proj, ret } = r;
  const card = el('section', { class: 'card' });
  card.append(header('Your pot over time', `In ${moneyWord()}${ret.method === 'drawdown' ? ', saving and then taking income' : ''}.`));
  const pts = [{ x: 0, y: proj.potStart }];
  for (const row of proj.rows) pts.push({ x: row.year, y: view.real ? row.potReal : row.pot });
  const series = [{ name: 'Building your pot', color: COLOR_BASE, data: pts }];
  if (ret.method === 'drawdown' && ret.track.length > 1) {
    const base = proj.years;
    series.push({
      name: 'Taking income', color: COLOR_OVER,
      data: [{ x: base, y: pts[pts.length - 1].y }, ...ret.track.slice(1).map((t) => ({ x: base + (t.age - o.age - base), y: inView(t.pot, t.age - o.age) }))].filter((p, i, a) => i === 0 || p.x > a[i - 1].x),
    });
    // after a lump sum the pot being drawn on starts lower than the pot at retirement
    series[1].data[0].y = inView(ret.startPot, base);
  }
  card.append(lineChart(series, {
    title: `Line chart of your pension pot by age, ${moneyWord()}`, note: ' The same figures are in the year-by-year table.',
    xLabel: (x) => (x === 0 ? `Age ${o.age}` : String(o.age + x)),
    tipLabel: (x) => `Age ${o.age + x}`,
  }));
  if (ret.lumpReal > 0 && ret.method === 'drawdown') card.append(el('p', { class: 'muted small', style: 'margin-top:8px', text: 'The drop when you retire is your tax-free lump sum leaving the pot.' }));
  return card;
}

// ------------------------------------------------------------------ where the pot comes from
function sourcesCard(r) {
  const { proj } = r;
  const card = el('section', { class: 'card' });
  card.append(header('Where your pot comes from', 'In future pounds, as the money actually goes in.'));
  const parts = [
    ['Pot today', proj.potStart, COLOR_PURPLE],
    ['You pay in', proj.totalMember, COLOR_BASE],
    ['Your employer pays in', proj.totalEmployer, COLOR_GREEN],
    ['Investment growth', Math.max(0, proj.growthTotal), COLOR_OVER],
  ].filter((p) => p[1] > 0.5);
  const total = parts.reduce((a, p) => a + p[1], 0) || 1;
  card.append(el('div', { class: 'split', role: 'img', 'aria-label': parts.map((p) => `${p[0]} ${fmt.pct(p[1] / total, 0)}`).join(', ') }, parts.map((p) => el('span', { style: `width:${(p[1] / total) * 100}%;background:${p[2]}` }))));
  card.append(el('div', { class: 'legend' }, parts.map((p) => el('span', { style: `--c:${p[2]}`, text: `${p[0]} ${fmt.pct(p[1] / total, 0)}` }))));
  card.append(el('div', { style: 'margin-top:12px' }, linesTable([
    ['Pot today', fmt.gbp(proj.potStart)],
    ['You pay in', fmt.gbp(proj.totalMember), { note: 'Includes tax relief added to your contributions.' }],
    ['Your employer pays in', fmt.gbp(proj.totalEmployer)],
    ['Investment growth after charges', fmt.gbpSigned(proj.growthTotal)],
    ['Pot at retirement', fmt.gbp(proj.potNominal), { total: true }],
  ])));
  if (proj.chargesCost > 1) card.append(el('p', { class: 'muted small', style: 'margin-top:10px', text: `Charges cost you about ${fmt.gbp(proj.chargesCost)} of growth over this time. A 0.25% lower charge would add roughly ${fmt.gbp(proj.chargesCost / 3)}.` }));
  return card;
}

// ------------------------------------------------------------------ cost after tax relief
function costCard(c, o, y1) {
  const card = el('section', { class: 'card' });
  const methodName = { relief_at_source: 'relief at source', net_pay: 'net pay', salary_sacrifice: 'salary sacrifice' }[o.member.method];
  card.append(header('What paying in costs you', `First-year figures using ${methodName}${state.rates?.label ? ` and ${state.rates.label} tax rules` : ''}.`));
  const inPot = y1.member + y1.employer;
  card.append(el('div', { class: 'hero' }, [
    tile('Costs you', fmt.gbp(c.cost / 12), `a month off your take-home pay`, true),
    tile('Goes into your pot', fmt.gbp(inPot / 12), `a month${y1.employer > 0 ? ` including ${fmt.gbp(y1.employer / 12)} from your employer` : ''}`),
    tile('Tax relief', fmt.pct(c.reliefRate, 0), `of what you pay in comes back`),
  ]));
  card.append(el('div', { class: 'table-scroll', style: 'margin-top:14px' }, linesTable([
    ['You pay in (a year)', fmt.gbp(c.gross)],
    ['Tax relief and savings', '− ' + fmt.gbp(c.relief), { neg: true, note: o.member.method === 'salary_sacrifice' ? 'Income tax and National Insurance you no longer pay on that part of your salary.' : o.member.method === 'net_pay' ? 'Income tax you no longer pay on that part of your pay.' : 'Basic-rate relief added by your provider, plus any higher-rate relief you claim back.' }],
    ['Your take-home pay falls by', fmt.gbp(c.cost), { total: true, note: `${fmt.gbp(c.takeHomeBefore)} to ${fmt.gbp(c.takeHomeAfter)} a year` }],
    y1.employer > 0 ? ['Your employer adds', fmt.gbp(y1.employer)] : null,
    ['Goes into your pot', fmt.gbp(inPot), { total: true, note: c.cost > 0 ? `${fmt.gbp(inPot / c.cost, 2)} in your pot for every £1 off your take-home pay.` : null }],
  ])));
  if (o.member.method === 'relief_at_source' && o.salary > 0) card.append(el('p', { class: 'muted small', style: 'margin-top:10px', text: 'With relief at source your provider adds basic-rate relief automatically. If you pay higher or additional-rate tax, claim the rest through Self Assessment or by telling HMRC.' }));
  return card;
}

// ------------------------------------------------------------------ retirement income
function incomeCard(r, o) {
  const { ret, sp } = r;
  const card = el('section', { class: 'card' });
  card.append(header('Your income in retirement', `A year, after tax, in ${moneyWord()}${state.rates?.label ? ` · ${state.rates.label} tax rules` : ''}.`));
  const ph = ret.phases;
  const v = (x, p) => fmt.gbp(inView(x, p.fromAge - o.age));
  const table = el('table', { class: 'lines' });
  table.append(el('caption', { class: 'visually-hidden', text: 'Retirement income, tax and take-home by stage' }));
  table.append(el('thead', {}, el('tr', {}, ['', ...ph.map((p) => `${p.label} (${p.fromAge})`)].map((h, i) => el('th', { scope: 'col', text: h }, i === 0 ? el('span', { class: 'visually-hidden', text: 'Item' }) : null)))));
  const tbody = el('tbody');
  const row = (label, cells, cls, noteText) => {
    const tdl = el('td', {}, [label]);
    if (noteText) tdl.append(el('span', { class: 'note', text: noteText }));
    tbody.append(el('tr', { class: cls || null }, [tdl, ...cells.map((c) => el('td', { text: c }))]));
  };
  row(ret.method === 'annuity' ? 'Annuity' : 'From your pot', ph.map((p) => v(p.potGross, p)), null, ret.method === 'annuity' && !o.annuityRises ? "Level, so its buying power falls each year (see below)." : null);
  if (ret.taxFreeFraction > 0) row('of which tax-free', ph.map((p) => v(p.potTaxFree, p)), 'sub');
  if (sp.annualReal > 0) row('State Pension', ph.map((p) => v(p.statePension, p)));
  if (ph.some((p) => p.other > 0)) row('Other income', ph.map((p) => v(p.other, p)));
  row('Income before tax', ph.map((p) => v(p.gross, p)), 'total');
  const hasTax = ph.every((p) => p.tax != null);
  if (hasTax) {
    row('Income tax', ph.map((p) => '− ' + v(p.tax, p)));
    row('Take-home a year', ph.map((p) => v(p.net, p)), 'total');
    row('Take-home a month', ph.map((p) => v(p.net / 12, p)), 'total');
  }
  table.append(tbody);
  card.append(el('div', { class: 'table-scroll' }, table));

  if (ret.lumpReal > 0) card.append(el('div', { class: 'note-box', style: 'margin-top:12px', html: `You would also take a tax-free lump sum of <b class="num">${fmt.gbp(inView(ret.lumpReal, r.proj.years))}</b> at ${o.retireAge}.` }));
  if (ret.method === 'drawdown') {
    card.append(el('div', { class: `note-box${ret.depleted ? ' warn' : ' good'}`, style: 'margin-top:12px', html: ret.depleted
      ? `Taking <b class="num">${fmt.gbp(inView(ret.potGross, r.proj.years))}</b> a year, rising with inflation, the pot runs out at about age <b>${Math.floor(ret.lastsToAge)}</b>. After that only the State Pension would remain. Taking less, or retiring later, makes it last longer.`
      : `Taking <b class="num">${fmt.gbp(inView(ret.potGross, r.proj.years))}</b> a year, rising with inflation, the pot is projected to last beyond age ${MAX_AGE}.` }));
  } else if (!o.annuityRises) {
    const at85 = ret.annuityRealAt(85);
    card.append(el('div', { class: 'note-box', style: 'margin-top:12px', html: `A level annuity stays the same in pounds, so by age 85 its buying power would have fallen from <b class="num">${fmt.gbp(ret.potGross)}</b> to about <b class="num">${fmt.gbp(at85)}</b> a year in today's money.` }));
  }
  card.append(el('details', { class: 'explain' }, [el('summary', { text: 'How this is worked out' }), el('div', { class: 'body' }, [
    el('p', { text: ret.method === 'annuity' ? 'An annuity swaps your pot for a fixed income paid for life. The income is the pot (after any lump sum) multiplied by the annuity rate. Rates depend on your age, health, whether it rises with inflation and whether it continues for a partner, so get real quotes before deciding.' : 'In drawdown your pot stays invested. The first year you take the withdrawal rate multiplied by the pot, and the amount rises with inflation each year after that. The pot keeps growing at the retirement growth rate less charges while you draw on it.' }),
    el('p', { text: 'Pension income is added to the State Pension and anything else you enter, and taxed like earnings using this year\'s Personal Allowance and tax bands (Scottish bands if you chose Scotland), with no National Insurance. Tax bands are assumed to rise with inflation, which is why the sums are in today\'s money. Tax-free cash is a quarter of the pot, up to the lump sum allowance.' }),
    el('p', { text: 'The State Pension is the full new State Pension scaled by your qualifying years (35 for the full amount, at least 10 to get anything) and assumed to rise at least with prices. If you worked while contracted out, or have gaps, your forecast on GOV.UK is the best guide.' }),
  ])]));
  return card;
}

// ------------------------------------------------------------------ scenarios
function contributionsCard(r, o, y1) {
  const card = el('section', { class: 'card' });
  card.append(header('What if you pay in more?', `Extra paid in each month from today, before tax relief. Figures in ${moneyWord()}.`));
  const rows = contributionScenarios(o, state.rates);
  const baseCost = o.salary > 0 ? contributionCost({ salary: o.salary, region: o.region, method: o.member.method, memberAnnual: y1.member }, state.rates)?.cost ?? 0 : null;
  const showCost = baseCost != null;
  const heads = ['Pay in extra', 'Pot at retirement', 'Income a month'];
  if (showCost) heads.push('Costs you');
  const body = rows.map((s) => {
    const cells = [s.extra === 0 ? 'Your plan' : `+${fmt.gbp(s.extra)} a month`, fmt.gbp(view.real ? s.potReal : s.potNominal), fmt.gbp(incomeFor(s, o))];
    if (showCost) {
      if (s.extra === 0) cells.push('-');
      else {
        const c = contributionCost({ salary: o.salary, region: o.region, method: o.member.method, memberAnnual: y1.member + s.extra * 12 }, state.rates);
        cells.push(c ? `${fmt.gbp((c.cost - baseCost) / 12)} a month` : '-');
      }
    }
    return cells;
  });
  card.append(dataTable(heads, body, { hl: 0, caption: 'Effect of paying in more' }));
  if (showCost) card.append(el('p', { class: 'muted small', style: 'margin-top:10px', text: '"Costs you" is the extra reduction in your monthly take-home pay once tax relief is counted.' }));
  return card;
}
/** Net monthly income of a scenario in the chosen money basis, at the stage when the State Pension has started. */
function incomeFor(s, o) {
  const startAge = Math.max(s.retireAge ?? o.retireAge, o.spa);
  return inView((s.netAnnual ?? s.grossAnnual) / 12, startAge - o.age);
}

function retireAgeCard(rows, o) {
  const card = el('section', { class: 'card' });
  card.append(header('What if you retire earlier or later?', `Same savings plan, different retirement age. Figures in ${moneyWord()}.`));
  const cur = rows.findIndex((x) => x.current);
  const body = rows.map((s) => [
    `${s.retireAge}${s.delta ? ` (${Math.abs(s.delta)} year${Math.abs(s.delta) === 1 ? '' : 's'} ${s.delta < 0 ? 'earlier' : 'later'})` : ' (your plan)'}`,
    fmt.gbp(view.real ? s.potReal : s.potNominal),
    fmt.gbp(incomeFor(s, o)),
  ]);
  card.append(dataTable(['Retire at', 'Pot', 'Income a month'], body, { hl: cur, caption: 'Effect of retiring earlier or later' }));
  return card;
}

function growthCard(o) {
  const card = el('section', { class: 'card' });
  card.append(header('What if investments do better or worse?', `Growth before and during retirement moved by 2 percentage points. Figures in ${moneyWord()}.`));
  const rows = growthScenarios(o, state.rates);
  const labels = { '-2': 'Lower growth', '0': 'Your assumption', '2': 'Higher growth' };
  card.append(dataTable(['Scenario', 'Pot', 'Income a month'], rows.map((s) => [`${labels[s.delta]} (${s.growth}% a year)`, fmt.gbp(view.real ? s.potReal : s.potNominal), fmt.gbp(incomeFor(s, o))]), { hl: 1, caption: 'Effect of different investment growth' }));
  card.append(el('p', { class: 'muted small', style: 'margin-top:10px', text: 'Nobody knows how markets will behave. Over long periods a lower figure is the safer one to plan with.' }));
  return card;
}

// ------------------------------------------------------------------ schedule
function scheduleCard(r, o) {
  const card = el('details', { class: 'section' });
  card.append(el('summary', {}, el('span', {}, ['Year-by-year breakdown', el('span', { class: 'sub', text: 'Contributions, growth and pot each year' })])));
  const body = el('div', { class: 'body' });
  const narrow = (results.clientWidth || 640) < 460;
  const table = el('table', { class: 'lines' });
  table.append(el('caption', { class: 'visually-hidden', text: 'Pension pot by year' }));
  table.append(el('thead', {}, el('tr', {}, ['Age', 'Paid in', 'Growth', 'Pot', ...(narrow ? [] : ["Pot, today's money"])].map((h, i) => el('th', { text: h, scope: 'col', style: i ? 'text-align:right' : '' })))));
  const tbody = el('tbody');
  for (const row of r.proj.rows) {
    tbody.append(el('tr', {}, [
      el('td', { text: String(row.age) }),
      el('td', { class: 'num', style: 'text-align:right', text: fmt.gbp(row.member + row.employer) }),
      el('td', { class: 'num', style: 'text-align:right', text: fmt.gbpSigned(row.growth) }),
      el('td', { class: 'num', style: 'text-align:right', text: fmt.gbp(row.pot) }),
      narrow ? null : el('td', { class: 'num', style: 'text-align:right', text: fmt.gbp(row.potReal) }),
    ]));
  }
  table.append(tbody);
  body.append(el('div', { class: 'table-scroll' }, table));
  body.append(el('p', { class: 'muted small', style: 'margin-top:10px', text: 'Paid in includes tax relief and your employer. Growth is after charges. All in future pounds except the last column.' }));
  card.append(body);
  return card;
}

function assumptionsCard(o) {
  const card = el('section', { class: 'card' });
  card.append(header('How this is worked out'));
  card.append(el('ul', { class: 'small', style: 'margin:0; padding-left:18px; color:var(--text-2)' }, [
    el('li', { text: `Your pot grows at ${o.growth}% a year less ${o.charges}% charges, added monthly. Contributions are paid in at the end of each month, and the contributions you enter are the total going in, including tax relief.` }),
    el('li', { text: `Prices rise ${o.inflation}% a year and your pay ${o.payRise}% a year. Contributions set as a % of salary rise with your pay${o.escalate ? ', and so do your £ amounts' : '; £ amounts stay the same unless you switch that on'}.` }),
    el('li', { text: "Retirement income and tax are worked out in today's money, assuming tax bands and the State Pension keep pace with prices. The lump sum allowance is fixed in pounds, as it is in law." }),
    el('li', { text: 'Not modelled: final salary pensions, fund choice, the lifetime and carry-forward rules, spouse benefits, pension tax on death, and State Pension changes for people who were contracted out.' }),
    el('li', { text: 'Projections are not guaranteed and are not financial advice. Pension Wise (free, from MoneyHelper) can guide you on your options from age 50.' }),
  ]));
  return card;
}

init();
