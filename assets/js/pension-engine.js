/**
 * Pension projection engine. Pure functions, no DOM, no dependencies except the tax engine.
 *
 *  1. project()           grow today's pot with contributions (yours, your employer's, tax relief
 *                         included) to the retirement age, monthly, net of charges.
 *  2. statePension()      the new State Pension for a given number of qualifying years.
 *  3. retirementIncome()  turn the pot into income (drawdown or annuity), add State Pension and
 *                         other income, take off income tax, and say how long a drawdown pot lasts.
 *  4. evaluate()          1 + 2 + 3 in one go, plus the figures the page needs.
 *  5. contributionCost()  what paying in really costs you after tax relief, using the full tax engine.
 *  6. extraToReachTarget(), annualAllowance() and the scenario helpers used by the comparison tables.
 *
 * Retirement income is worked out in today's money: tax bands, the State Pension and spending
 * power are all treated as rising with inflation, so the figures mean what they would buy now.
 * The lump sum allowance is frozen in pounds (as it is in law), so it is compared in future pounds.
 * Rates are percentages (5 means 5%), as everywhere else in this app.
 */
import { calculate } from './tax-engine.js?v=fdea76ad1f';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export const FREQUENCIES = { weekly: 52, monthly: 12, quarterly: 4, yearly: 1 };
export const MAX_AGE = 100; // drawdown is projected up to this age

/** Fill in pension figures missing from older tax-year data files. */
export function pensionRates(rates = {}) {
  const p = rates.pensions || {};
  return {
    annualAllowance: p.annualAllowance ?? 60000,
    reliefMinimumGross: p.reliefMinimumGross ?? 3600,
    taxFreeShare: p.taxFreeShare ?? 0.25,
    lumpSumAllowance: p.lumpSumAllowance ?? 268275,
    taperThresholdIncome: p.taperThresholdIncome ?? 200000,
    taperAdjustedIncome: p.taperAdjustedIncome ?? 260000,
    taperMinimumAllowance: p.taperMinimumAllowance ?? 10000,
    minimumPensionAge: p.minimumPensionAge ?? 55,
    minimumPensionAgeFrom2028: p.minimumPensionAgeFrom2028 ?? 57,
    statePensionNewWeekly: p.statePensionNewWeekly ?? 241.3,
    statePensionFullYears: p.statePensionFullYears ?? 35,
    statePensionMinimumYears: p.statePensionMinimumYears ?? 10,
  };
}

/** Monthly rate equivalent to an annual percentage. */
export const monthlyRate = (annualPct) => Math.pow(1 + annualPct / 100, 1 / 12) - 1;

/** Approximate State Pension age from the year of birth (exact dates: gov.uk/state-pension-age). */
export function statePensionAge(birthYear) {
  if (birthYear <= 1959) return 66;
  if (birthYear <= 1977) return 67;
  return 68;
}

/** Earliest age you can normally take pension savings: 55, rising to 57 from 6 April 2028. */
export function minimumPensionAge(retireYear, p) {
  return retireYear >= 2029 ? p.minimumPensionAgeFrom2028 : p.minimumPensionAge;
}

/** Rough annuity rate (income per £1 of pot) for a single life at the age of buying, early 2020s market. */
export function defaultAnnuityRate(age, rises = false) {
  const points = [[55, 5.2], [60, 5.8], [65, 6.8], [70, 8.0], [75, 9.6]];
  const a = clamp(age, 55, 75);
  let level = points[points.length - 1][1];
  for (let i = 1; i < points.length; i++) {
    if (a <= points[i][0]) { const [x0, y0] = points[i - 1], [x1, y1] = points[i]; level = y0 + ((a - x0) / (x1 - x0)) * (y1 - y0); break; }
  }
  return round2(rises ? Math.max(1, level - 2.3) : level);
}

/** Which tax-free handling applies: an annuity is bought with the pot left after an up-front lump sum. */
function effectiveTaxFree(taxFree, method) {
  if (!['upfront', 'spread', 'none'].includes(taxFree)) return 'upfront';
  return method === 'annuity' && taxFree === 'spread' ? 'upfront' : taxFree;
}

// ------------------------------------------------------------------ contributions and growth

/**
 * Annual contributions in year `y` (0 = the first year), before any growth.
 * member / employer amounts are gross: what goes into the pot, tax relief included.
 */
export function contributionsForYear(o, y) {
  const rise = Math.pow(1 + num(o.payRise) / 100, y);
  const salary = num(o.salary) * rise;
  const m = o.member || {};
  const e = o.employer || {};
  const step = o.escalate ? rise : 1;
  const mFreq = FREQUENCIES[m.freq] || 12;
  const eFreq = FREQUENCIES[e.freq] || 12;
  const member = (m.type === 'percent' ? (num(m.amount) / 100) * salary : num(m.amount) * mFreq * step) + num(o.extraMemberAnnual) * step;
  let employer = 0;
  if (e.type === 'percent') employer = (num(e.value) / 100) * salary;
  else if (e.type === 'amount') employer = num(e.value) * eFreq * step;
  else if (e.type === 'match') employer = Math.min(member, (num(e.value) / 100) * salary);
  return { salary, member: Math.max(0, member), employer: Math.max(0, employer) };
}

/** Grow the pot month by month. Contributions are paid in at the end of each month. */
function growPot(o, charges) {
  const months = Math.max(0, Math.round((num(o.retireAge) - num(o.age)) * 12));
  const rm = monthlyRate(num(o.growth) - charges);
  let pot = Math.max(0, num(o.pot));
  const rows = [];
  let yr = { member: 0, employer: 0, start: pot };
  let totalMember = 0, totalEmployer = 0;
  let c = contributionsForYear(o, 0);
  for (let m = 1; m <= months; m++) {
    const y = Math.floor((m - 1) / 12);
    if ((m - 1) % 12 === 0) { c = contributionsForYear(o, y); yr = { member: 0, employer: 0, start: pot, salary: c.salary }; }
    pot = pot * (1 + rm) + c.member / 12 + c.employer / 12;
    yr.member += c.member / 12; yr.employer += c.employer / 12;
    totalMember += c.member / 12; totalEmployer += c.employer / 12;
    if (m % 12 === 0 || m === months) {
      const d = Math.pow(1 + num(o.inflation) / 100, m / 12);
      rows.push({
        year: y + 1, age: num(o.age) + y + 1, salary: yr.salary,
        member: yr.member, employer: yr.employer,
        growth: pot - yr.start - yr.member - yr.employer,
        pot, potReal: pot / d,
      });
    }
  }
  return { months, pot, rows, totalMember, totalEmployer };
}

/**
 * Project the pot to retirement.
 * @param {object} o { age, retireAge, pot, salary, member:{amount,freq,type,method}, employer:{type,value,freq},
 *   payRise, escalate, extraMemberAnnual, growth, charges, inflation, region }
 */
export function project(o, rates) {
  const pr = pensionRates(rates);
  const warnings = [];
  const run = growPot(o, num(o.charges));
  const free = growPot(o, 0);
  const deflator = Math.pow(1 + num(o.inflation) / 100, run.months / 12);
  const potStart = Math.max(0, num(o.pot));
  const growthTotal = run.pot - potStart - run.totalMember - run.totalEmployer;

  // Annual allowance and tax-relief limit, checked in today's money (the limits are assumed to rise with prices).
  const method = o.member?.method || 'relief_at_source';
  for (const r of run.rows) {
    const d = Math.pow(1 + num(o.inflation) / 100, r.year - 1);
    const total = (r.member + r.employer) / d;
    const aa = annualAllowance({ salary: r.salary / d, employerAnnual: r.employer / d, memberAnnual: r.member / d, method }, pr);
    if (total > aa.allowance + 0.5) {
      warnings.push(`Your contributions${r.year > 1 ? ` in year ${r.year}` : ''} (${gbp(total)} a year including your employer's) are above your annual allowance of ${gbp(aa.allowance)}${aa.tapered ? ' (reduced because of your income)' : ''}. Unless you have unused allowance from the last three years, the excess is taxed as income. This is not modelled.`);
      break;
    }
  }
  if (num(o.salary) > 0) {
    for (const r of run.rows) {
      const d = Math.pow(1 + num(o.inflation) / 100, r.year - 1);
      const limit = Math.max(r.salary, pr.reliefMinimumGross) / d;
      if (r.member / d > limit + 0.5) {
        warnings.push(`You pay in more than your earnings${r.year > 1 ? ` in year ${r.year}` : ''}. You only get tax relief on contributions up to 100% of your earnings (or ${gbp(pr.reliefMinimumGross)} if that is higher), so the relief shown is overstated.`);
        break;
      }
    }
  }
  return {
    months: run.months, years: run.months / 12,
    potStart, potNominal: run.pot, potReal: run.pot / deflator, deflator,
    totalMember: run.totalMember, totalEmployer: run.totalEmployer, growthTotal,
    chargesCost: Math.max(0, free.pot - run.pot),
    rows: run.rows, warnings,
  };
}

const gbp = (v) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(v);

/**
 * Annual allowance for one year, including the taper for high earners. Approximate: threshold
 * income is taken as salary (less relief-at-source contributions), adjusted income as salary plus
 * employer contributions.
 */
export function annualAllowance({ salary = 0, employerAnnual = 0, memberAnnual = 0, method = 'relief_at_source' }, pr) {
  const threshold = salary - (method === 'relief_at_source' ? memberAnnual : 0);
  const adjusted = salary + employerAnnual;
  if (threshold > pr.taperThresholdIncome && adjusted > pr.taperAdjustedIncome) {
    const reduced = pr.annualAllowance - (adjusted - pr.taperAdjustedIncome) / 2;
    return { allowance: Math.max(pr.taperMinimumAllowance, reduced), tapered: true };
  }
  return { allowance: pr.annualAllowance, tapered: false };
}

// ------------------------------------------------------------------ State Pension

/**
 * The new State Pension. Qualifying years keep building until you stop work or reach State
 * Pension age, whichever is first. Retiring after State Pension age defers it: +1% for every
 * 9 weeks, about 5.8% a year.
 * @returns {{annualReal:number, years:number, fraction:number, startAge:number, deferralUplift:number, fullAnnual:number, perYear:number, eligible:boolean}}
 */
export function statePension({ age, retireAge, spa, qualifyingYears, include = true }, rates) {
  const pr = pensionRates(rates);
  const fullAnnual = pr.statePensionNewWeekly * 52;
  const startAge = Math.max(num(retireAge), num(spa));
  const base = qualifyingYears == null || qualifyingYears === '' ? clamp(num(age) - 18, 0, pr.statePensionFullYears) : clamp(num(qualifyingYears), 0, pr.statePensionFullYears);
  const years = clamp(base + Math.max(0, Math.min(num(retireAge), num(spa)) - num(age)), 0, pr.statePensionFullYears);
  const eligible = years >= pr.statePensionMinimumYears;
  const fraction = eligible ? Math.min(1, years / pr.statePensionFullYears) : 0;
  const deferralUplift = Math.max(0, num(retireAge) - num(spa)) * (52 / 9) / 100;
  const annualReal = include ? fullAnnual * fraction * (1 + deferralUplift) : 0;
  return { annualReal, years, fraction, startAge, deferralUplift, fullAnnual, perYear: fullAnnual / pr.statePensionFullYears, eligible, minYears: pr.statePensionMinimumYears, fullYears: pr.statePensionFullYears };
}

// ------------------------------------------------------------------ retirement income

/** Income tax on taxable retirement income (today's money, today's bands). */
export function retirementTax(taxable, region, rates) {
  if (!rates) return null;
  return calculate({ region, other: { otherIncome: Math.max(0, taxable) } }, rates).incomeTax.total;
}

/**
 * Turn a pot into income.
 * @param {object} o { potNominal, deflator, retireAge, spa, method:'drawdown'|'annuity', withdrawalRate, annuityRate,
 *   annuityRises, taxFree:'upfront'|'spread'|'none', otherIncome (taxable, today's money, a year),
 *   statePensionReal, retireGrowth, charges, inflation, region }
 */
export function retirementIncome(o, rates) {
  const pr = pensionRates(rates);
  const method = o.method === 'annuity' ? 'annuity' : 'drawdown';
  const taxFree = effectiveTaxFree(o.taxFree, method);
  const potNominal = Math.max(0, num(o.potNominal));
  const deflator = num(o.deflator) || 1;
  const warnings = [];

  // Tax-free cash
  let lumpNominal = 0, taxFreeFraction = 0, incomePotNominal = potNominal;
  const share = pr.taxFreeShare;
  if (taxFree === 'upfront') {
    lumpNominal = Math.min(share * potNominal, pr.lumpSumAllowance);
    incomePotNominal = potNominal - lumpNominal;
  } else if (taxFree === 'spread') {
    taxFreeFraction = potNominal > 0 ? Math.min(share, pr.lumpSumAllowance / potNominal) : 0;
  }
  if (taxFree !== 'none' && share * potNominal > pr.lumpSumAllowance + 0.5) {
    warnings.push(`Your tax-free cash is limited by the lump sum allowance of ${gbp(pr.lumpSumAllowance)} (frozen in pounds), which is less than 25% of your pot.`);
  }
  const incomePotReal = incomePotNominal / deflator;

  // Gross income from the pot, a year, in today's money (first year of retirement)
  let potGross;
  let rate;
  if (method === 'annuity') {
    rate = num(o.annuityRate) > 0 ? num(o.annuityRate) : defaultAnnuityRate(num(o.retireAge), !!o.annuityRises);
    potGross = incomePotReal * (rate / 100);
  } else {
    rate = o.withdrawalRate == null || o.withdrawalRate === '' ? 4 : num(o.withdrawalRate);
    potGross = incomePotReal * (rate / 100);
  }
  const potTaxFree = potGross * taxFreeFraction;
  const potTaxable = potGross - potTaxFree;

  const other = Math.max(0, num(o.otherIncome));
  const sp = Math.max(0, num(o.statePensionReal));
  const retireAge = num(o.retireAge);
  const spStart = Math.max(retireAge, num(o.spa));

  const phase = (label, fromAge, withSP) => {
    const stateIncome = withSP ? sp : 0;
    const taxable = potTaxable + stateIncome + other;
    const tax = retirementTax(taxable, o.region, rates);
    const gross = potGross + stateIncome + other;
    return {
      label, fromAge, potGross, potTaxFree, potTaxable, statePension: stateIncome, other,
      gross, taxable, tax, net: tax == null ? null : gross - tax,
    };
  };
  const phases = [];
  if (retireAge < spStart && (potGross > 0 || other > 0)) phases.push(phase('Until State Pension age', retireAge, false));
  phases.push(phase(spStart > retireAge || sp > 0 ? 'With State Pension' : 'In retirement', spStart, true));

  // How long a drawdown pot lasts: withdrawals rise with inflation, so the pot is followed in today's money.
  let lastsToAge = null, depleted = false, potAtMax = null;
  const track = [];
  const startPot = method === 'drawdown' ? incomePotReal : null;
  if (method === 'drawdown') {
    const realRm = Math.pow((1 + (num(o.retireGrowth) - num(o.charges)) / 100) / (1 + num(o.inflation) / 100), 1 / 12) - 1;
    let pot = startPot;
    const w = potGross / 12;
    const maxMonths = Math.max(0, Math.round((MAX_AGE - retireAge) * 12));
    track.push({ age: retireAge, pot });
    for (let m = 1; m <= maxMonths; m++) {
      pot -= w;
      if (pot <= 0) { depleted = true; lastsToAge = retireAge + (m - 1) / 12; pot = 0; track.push({ age: Math.ceil(retireAge + m / 12), pot }); break; }
      pot *= 1 + realRm;
      if (m % 12 === 0) track.push({ age: retireAge + m / 12, pot });
    }
    if (!depleted) potAtMax = pot;
  }
  // Level annuity: its buying power falls with inflation
  const annuityRealAt = (age) => (method === 'annuity' && !o.annuityRises ? potGross * Math.pow(1 + num(o.inflation) / 100, -(age - retireAge)) : potGross);

  return {
    method, taxFree, rate, lumpNominal, lumpReal: lumpNominal / deflator, incomePotReal, taxFreeFraction,
    potGross, potTaxFree, potTaxable, phases, depleted, lastsToAge, potAtMax, track, startPot,
    annuityRealAt, spStart, warnings,
  };
}

// ------------------------------------------------------------------ everything together

/**
 * Full evaluation for one set of inputs.
 * @param {object} o project() options plus retirement fields (see retirementIncome) and
 *   { spa, qualifyingYears, includeStatePension }
 */
export function evaluate(o, rates) {
  const proj = project(o, rates);
  const sp = statePension({ age: o.age, retireAge: o.retireAge, spa: o.spa, qualifyingYears: o.qualifyingYears, include: o.includeStatePension !== false }, rates);
  const ret = retirementIncome({
    potNominal: proj.potNominal, deflator: proj.deflator, retireAge: o.retireAge, spa: o.spa,
    method: o.method, withdrawalRate: o.withdrawalRate, annuityRate: o.annuityRate, annuityRises: o.annuityRises, taxFree: o.taxFree,
    otherIncome: o.otherIncome, statePensionReal: sp.annualReal,
    retireGrowth: o.retireGrowth, charges: o.charges, inflation: o.inflation, region: o.region,
  }, rates);
  const last = ret.phases[ret.phases.length - 1];
  return { proj, sp, ret, last, first: ret.phases[0] };
}

/** Compact result used by the comparison tables. */
export function summary(o, rates) {
  const r = evaluate(o, rates);
  const real = (v) => (v == null ? null : v);
  return {
    potReal: r.proj.potReal, potNominal: r.proj.potNominal,
    grossAnnual: r.last.gross, netAnnual: real(r.last.net), potNetAnnual: r.ret.potGross,
    firstNetAnnual: real(r.first.net), firstGrossAnnual: r.first.gross,
    statePensionAnnual: r.sp.annualReal, lastsToAge: r.ret.lastsToAge, depleted: r.ret.depleted,
  };
}

/**
 * The extra gross contribution each month needed for the long-run net income to reach a target
 * (today's money, a year). Bisection: income only ever rises as contributions rise.
 * @returns {number|null} 0 when already on track, null when no realistic amount gets there
 */
export function extraToReachTarget(o, targetNetAnnual, rates) {
  const net = (extraMonthly) => evaluate({ ...o, extraMemberAnnual: num(o.extraMemberAnnual) + extraMonthly * 12 }, rates).last.net;
  if (net(0) == null) return null;
  if (net(0) >= targetNetAnnual - 0.5) return 0;
  let hi = 1000;
  while (net(hi) < targetNetAnnual && hi < 64000) hi *= 2;
  if (net(hi) < targetNetAnnual) return null;
  let lo = 0;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (net(mid) >= targetNetAnnual) hi = mid; else lo = mid; }
  return Math.ceil(hi);
}

/** Extra monthly amounts compared in the "pay in more" table. */
export const EXTRA_STEPS = [0, 50, 100, 250, 500];
export function contributionScenarios(o, rates, steps = EXTRA_STEPS) {
  return steps.map((extra) => ({ extra, ...summary({ ...o, extraMemberAnnual: num(o.extraMemberAnnual) + extra * 12 }, rates) }));
}

/** Retiring earlier or later. Ages the law does not allow, or that are already past, are left out. */
export function retireAgeScenarios(o, rates, thisYear, deltas = [-5, -3, -1, 0, 1, 3, 5]) {
  const pr = pensionRates(rates);
  const out = [];
  for (const d of deltas) {
    const retireAge = num(o.retireAge) + d;
    if (retireAge <= num(o.age) || retireAge > 80) continue;
    if (retireAge < minimumPensionAge(thisYear + (retireAge - num(o.age)), pr)) continue;
    out.push({ retireAge, delta: d, current: d === 0, ...summary({ ...o, retireAge }, rates) });
  }
  return out;
}

/** Lower and higher growth, for "what if the markets do worse / better". */
export function growthScenarios(o, rates, deltas = [-2, 0, 2]) {
  return deltas.map((d) => ({ delta: d, growth: num(o.growth) + d, retireGrowth: num(o.retireGrowth) + d, ...summary({ ...o, growth: num(o.growth) + d, retireGrowth: num(o.retireGrowth) + d }, rates) }));
}

/**
 * What paying in really costs once tax relief is counted: take-home pay without the contribution
 * minus take-home pay with it, from the full tax engine (income tax, National Insurance, relief
 * at source and the higher-rate band extension are all handled there).
 */
export function contributionCost({ salary, region, method, memberAnnual }, rates) {
  const gross = Math.max(0, num(memberAnnual));
  if (!rates || num(salary) <= 0 || gross <= 0) return null;
  const m = ['salary_sacrifice', 'net_pay', 'relief_at_source'].includes(method) ? method : 'relief_at_source';
  const base = calculate({ region, employment: { salary } }, rates);
  const withPension = calculate({ region, employment: { salary, pension: { method: m, type: 'amount', value: gross } } }, rates);
  const cost = base.totals.takeHome - withPension.totals.takeHome;
  return {
    gross, cost, relief: gross - cost, reliefRate: gross > 0 ? (gross - cost) / gross : 0,
    takeHomeBefore: base.totals.takeHome, takeHomeAfter: withPension.totals.takeHome,
    warnings: withPension.warnings.filter((w) => /ension/.test(w)),
  };
}

export const _internal = { num, clamp, growPot, effectiveTaxFree };
