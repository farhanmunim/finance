import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  project, statePension, statePensionAge, retirementIncome, evaluate, contributionCost, contributionsForYear,
  extraToReachTarget, annualAllowance, pensionRates, defaultAnnuityRate, minimumPensionAge, retireAgeScenarios, contributionScenarios, monthlyRate,
} from '../assets/js/pension-engine.js';

const rates = JSON.parse(readFileSync(new URL('../data/tax-years/2026-27.json', import.meta.url), 'utf8'));
const close = (a, b, tol = 0.02) => assert.ok(Math.abs(a - b) < tol, `expected ${b} got ${a}`);

const base = {
  age: 35, retireAge: 67, pot: 0, salary: 0, region: 'ruk',
  member: { amount: 0, freq: 'monthly', type: 'amount', method: 'net_pay' }, employer: { type: 'amount', value: 0, freq: 'monthly' },
  payRise: 0, growth: 5, charges: 0, inflation: 0, retireGrowth: 4, spa: 67, method: 'drawdown', withdrawalRate: 4, taxFree: 'upfront', otherIncome: 0,
};

test('a lump sum with no contributions compounds at the monthly-equivalent rate', () => {
  const p = project({ ...base, pot: 10000, retireAge: 45 }, rates); // 10 years
  close(p.potNominal, 10000 * Math.pow(1.05, 10), 0.5);
  close(p.growthTotal, p.potNominal - 10000, 0.01);
});

test('monthly contributions use the future value of an annuity formula', () => {
  const p = project({ ...base, retireAge: 45, member: { amount: 100, freq: 'monthly', type: 'amount', method: 'net_pay' } }, rates);
  const r = monthlyRate(5);
  close(p.potNominal, 100 * ((Math.pow(1 + r, 120) - 1) / r), 0.5);
  close(p.totalMember, 12000, 0.01);
});

test('contribution frequencies convert to the same yearly total', () => {
  const yearly = (freq, amount) => contributionsForYear({ ...base, member: { amount, freq, type: 'amount' } }, 0).member;
  close(yearly('weekly', 10), 520); close(yearly('monthly', 100), 1200); close(yearly('quarterly', 300), 1200); close(yearly('yearly', 1200), 1200);
});

test('percentage contributions follow salary growth; £ amounts only when escalated', () => {
  const o = { ...base, salary: 40000, payRise: 3, member: { amount: 5, type: 'percent', freq: 'monthly' }, employer: { type: 'percent', value: 3 } };
  close(contributionsForYear(o, 0).member, 2000); close(contributionsForYear(o, 1).member, 2060);
  close(contributionsForYear(o, 1).employer, 1236);
  const fixed = { ...base, payRise: 3, member: { amount: 100, type: 'amount', freq: 'monthly' } };
  close(contributionsForYear(fixed, 5).member, 1200);
  close(contributionsForYear({ ...fixed, escalate: true }, 1).member, 1236);
});

test('employer match pays the same as you, up to the cap', () => {
  const o = { ...base, salary: 40000, member: { amount: 6, type: 'percent', freq: 'monthly' }, employer: { type: 'match', value: 4 } };
  close(contributionsForYear(o, 0).employer, 1600);
  close(contributionsForYear({ ...o, member: { amount: 2, type: 'percent', freq: 'monthly' } }, 0).employer, 800);
});

test('charges reduce the pot and the cost is reported', () => {
  const o = { ...base, pot: 50000, retireAge: 65, member: { amount: 200, freq: 'monthly', type: 'amount' } };
  const a = project({ ...o, charges: 0 }, rates), b = project({ ...o, charges: 1 }, rates);
  assert.ok(b.potNominal < a.potNominal);
  close(b.chargesCost, a.potNominal - b.potNominal, 0.5);
  assert.equal(a.chargesCost, 0);
});

test('today\'s-money pot is the future pot deflated by inflation', () => {
  const p = project({ ...base, pot: 10000, retireAge: 55, inflation: 2.5 }, rates);
  close(p.potReal, p.potNominal / Math.pow(1.025, 20), 0.01);
  close(p.deflator, Math.pow(1.025, 20), 1e-9);
});

test('retiring now uses the pot as it stands', () => {
  const p = project({ ...base, pot: 123456, retireAge: 35 }, rates);
  assert.equal(p.months, 0); close(p.potNominal, 123456);
});

test('annual allowance is flagged, with the taper for high earners', () => {
  const pr = pensionRates(rates);
  assert.deepEqual(annualAllowance({ salary: 80000 }, pr), { allowance: 60000, tapered: false });
  const t = annualAllowance({ salary: 300000, employerAnnual: 20000 }, pr);
  assert.equal(t.tapered, true); close(t.allowance, 60000 - (320000 - 260000) / 2);
  assert.equal(annualAllowance({ salary: 1000000 }, pr).allowance, 10000);
  const p = project({ ...base, salary: 50000, member: { amount: 6000, freq: 'monthly', type: 'amount', method: 'net_pay' } }, rates);
  assert.ok(p.warnings.some((w) => /annual allowance/.test(w)));
  assert.ok(p.warnings.some((w) => /more than your earnings/.test(w)));
});

test('State Pension age follows year of birth', () => {
  assert.equal(statePensionAge(1955), 66); assert.equal(statePensionAge(1970), 67); assert.equal(statePensionAge(1985), 68);
});

test('State Pension: full amount, pro rata, under 10 years, deferral, switched off', () => {
  const full = statePension({ age: 40, retireAge: 67, spa: 67, qualifyingYears: 35 }, rates);
  close(full.annualReal, 241.3 * 52); assert.equal(full.eligible, true);
  const half = statePension({ age: 40, retireAge: 40, spa: 67, qualifyingYears: 17.5 }, rates);
  close(half.annualReal, (241.3 * 52) / 2);
  const few = statePension({ age: 40, retireAge: 40, spa: 67, qualifyingYears: 9 }, rates);
  assert.equal(few.annualReal, 0); assert.equal(few.eligible, false);
  // years keep building until you retire, so working 10 more years crosses the 10-year line
  assert.equal(statePension({ age: 40, retireAge: 50, spa: 67, qualifyingYears: 5 }, rates).years, 15);
  const deferred = statePension({ age: 40, retireAge: 69, spa: 67, qualifyingYears: 35 }, rates);
  close(deferred.deferralUplift, 2 * 52 / 9 / 100, 1e-9); assert.ok(deferred.annualReal > full.annualReal);
  assert.equal(statePension({ age: 40, retireAge: 67, spa: 67, qualifyingYears: 35, include: false }, rates).annualReal, 0);
  // blank years are estimated from age (assumes work from 18), capped at 35
  assert.equal(statePension({ age: 30, retireAge: 30, spa: 67 }, rates).years, 12);
});

test('upfront tax-free cash is a quarter, capped by the lump sum allowance', () => {
  const small = retirementIncome({ potNominal: 400000, deflator: 1, retireAge: 67, spa: 67, taxFree: 'upfront', withdrawalRate: 4, inflation: 0, retireGrowth: 4, charges: 0, region: 'ruk' }, rates);
  close(small.lumpNominal, 100000); close(small.potGross, 300000 * 0.04);
  const big = retirementIncome({ potNominal: 2000000, deflator: 1, retireAge: 67, spa: 67, taxFree: 'upfront', withdrawalRate: 4, inflation: 0, retireGrowth: 4, charges: 0, region: 'ruk' }, rates);
  close(big.lumpNominal, 268275); assert.ok(big.warnings.length);
  const none = retirementIncome({ potNominal: 400000, deflator: 1, retireAge: 67, spa: 67, taxFree: 'none', withdrawalRate: 4, inflation: 0, retireGrowth: 4, charges: 0, region: 'ruk' }, rates);
  assert.equal(none.lumpNominal, 0); close(none.potGross, 16000);
});

test('spread tax-free cash makes a quarter of each payment tax-free', () => {
  const r = retirementIncome({ potNominal: 400000, deflator: 1, retireAge: 67, spa: 67, taxFree: 'spread', withdrawalRate: 5, inflation: 0, retireGrowth: 4, charges: 0, region: 'ruk' }, rates);
  close(r.potGross, 20000); close(r.potTaxFree, 5000); close(r.potTaxable, 15000);
});

test('retirement tax uses the real bands: £12,570 allowance, then 20%', () => {
  const r = retirementIncome({ potNominal: 300000, deflator: 1, retireAge: 67, spa: 67, taxFree: 'none', withdrawalRate: 10, inflation: 0, retireGrowth: 4, charges: 0, region: 'ruk' }, rates);
  const last = r.phases[r.phases.length - 1];
  close(last.gross, 30000); close(last.tax, (30000 - 12570) * 0.2); close(last.net, 30000 - last.tax);
  const scot = retirementIncome({ potNominal: 300000, deflator: 1, retireAge: 67, spa: 67, taxFree: 'none', withdrawalRate: 10, inflation: 0, retireGrowth: 4, charges: 0, region: 'scotland' }, rates);
  assert.notEqual(scot.phases[0].tax, last.tax);
});

test('a retirement before State Pension age gets two stages', () => {
  const r = retirementIncome({ potNominal: 300000, deflator: 1, retireAge: 60, spa: 67, statePensionReal: 12000, taxFree: 'none', withdrawalRate: 4, inflation: 0, retireGrowth: 4, charges: 0, region: 'ruk' }, rates);
  assert.equal(r.phases.length, 2); assert.equal(r.phases[0].statePension, 0); close(r.phases[1].statePension, 12000); assert.equal(r.phases[1].fromAge, 67);
  const after = retirementIncome({ potNominal: 300000, deflator: 1, retireAge: 68, spa: 67, statePensionReal: 12000, taxFree: 'none', withdrawalRate: 4, inflation: 0, retireGrowth: 4, charges: 0, region: 'ruk' }, rates);
  assert.equal(after.phases.length, 1); assert.equal(after.phases[0].fromAge, 68);
});

test('drawdown: a sustainable rate lasts, a high rate runs out, and 0% growth gives the arithmetic answer', () => {
  const o = { potNominal: 100000, deflator: 1, retireAge: 65, spa: 65, taxFree: 'none', inflation: 0, retireGrowth: 0, charges: 0, region: 'ruk' };
  const flat = retirementIncome({ ...o, withdrawalRate: 5 }, rates); // £5,000 a year from £100,000 at 0% growth = 20 years
  assert.equal(flat.depleted, true); close(flat.lastsToAge, 65 + 19 + 11 / 12, 0.1);
  assert.equal(retirementIncome({ ...o, retireGrowth: 6, inflation: 2, withdrawalRate: 3 }, rates).depleted, false);
  assert.equal(retirementIncome({ ...o, withdrawalRate: 15 }, rates).depleted, true);
});

test('annuity: income is pot × rate; a level annuity loses buying power, a rising one does not', () => {
  const o = { potNominal: 200000, deflator: 1, retireAge: 65, spa: 65, method: 'annuity', annuityRate: 6, taxFree: 'none', inflation: 2.5, retireGrowth: 4, charges: 0, region: 'ruk' };
  const level = retirementIncome(o, rates);
  close(level.potGross, 12000); close(level.annuityRealAt(85), 12000 / Math.pow(1.025, 20), 0.01);
  close(retirementIncome({ ...o, annuityRises: true }, rates).annuityRealAt(85), 12000);
  // spread is not available with an annuity: it falls back to an up-front lump sum
  assert.equal(retirementIncome({ ...o, taxFree: 'spread' }, rates).taxFree, 'upfront');
  assert.ok(defaultAnnuityRate(70) > defaultAnnuityRate(60)); assert.ok(defaultAnnuityRate(65, true) < defaultAnnuityRate(65));
});

test('lump sum allowance is compared in future pounds', () => {
  const r = retirementIncome({ potNominal: 2000000, deflator: 2, retireAge: 67, spa: 67, taxFree: 'upfront', withdrawalRate: 4, inflation: 2.5, retireGrowth: 4, charges: 0, region: 'ruk' }, rates);
  close(r.lumpNominal, 268275); close(r.lumpReal, 268275 / 2);
});

test('evaluate: income with State Pension, with a hand-checked case', () => {
  const o = { ...base, age: 45, retireAge: 67, pot: 200000, growth: 4, retireGrowth: 4, taxFree: 'none', qualifyingYears: 35, withdrawalRate: 4 };
  const r = evaluate(o, rates);
  close(r.proj.potNominal, 200000 * Math.pow(Math.pow(1.04, 1 / 12), 22 * 12), 1);
  close(r.last.statePension, 241.3 * 52);
  close(r.last.gross, r.proj.potNominal * 0.04 + 241.3 * 52, 1);
  assert.ok(r.last.net < r.last.gross && r.last.net > 0);
});

test('more contributions, later retirement and higher growth all raise income', () => {
  const o = { ...base, pot: 20000, salary: 40000, member: { amount: 100, freq: 'monthly', type: 'amount', method: 'net_pay' }, qualifyingYears: 20 };
  const c = contributionScenarios(o, rates);
  for (let i = 1; i < c.length; i++) { assert.ok(c[i].potReal > c[i - 1].potReal); assert.ok(c[i].netAnnual > c[i - 1].netAnnual); }
  const a = retireAgeScenarios(o, rates, 2026);
  for (let i = 1; i < a.length; i++) assert.ok(a[i].netAnnual >= a[i - 1].netAnnual);
  assert.ok(a.find((x) => x.current));
  assert.ok(!a.some((x) => x.retireAge < 55));
});

test('retire-age scenarios drop ages before the minimum pension age', () => {
  const a = retireAgeScenarios({ ...base, age: 40, retireAge: 57, pot: 10000 }, rates, 2026);
  assert.ok(a.every((x) => x.retireAge >= 55));
  assert.equal(minimumPensionAge(2030, pensionRates(rates)), 57); assert.equal(minimumPensionAge(2027, pensionRates(rates)), 55);
});

test('extra needed to reach a target: 0 when on track, and the answer really reaches it', () => {
  const o = { ...base, age: 40, pot: 30000, salary: 45000, member: { amount: 200, freq: 'monthly', type: 'amount', method: 'net_pay' }, qualifyingYears: 20 };
  const now = evaluate(o, rates).last.net;
  assert.equal(extraToReachTarget(o, now - 100, rates), 0);
  const target = now + 5000;
  const extra = extraToReachTarget(o, target, rates);
  assert.ok(extra > 0);
  assert.ok(evaluate({ ...o, extraMemberAnnual: extra * 12 }, rates).last.net >= target - 0.5);
  assert.ok(evaluate({ ...o, extraMemberAnnual: (extra - 2) * 12 }, rates).last.net < target);
  assert.equal(extraToReachTarget(o, 5e8, rates), null);
});

test('contribution cost uses the full tax engine for each method', () => {
  const args = { salary: 50000, region: 'ruk', memberAnnual: 5000 };
  const net = contributionCost({ ...args, method: 'net_pay' }, rates);
  close(net.cost, 4000); close(net.reliefRate, 0.2);
  const ras = contributionCost({ ...args, method: 'relief_at_source' }, rates);
  close(ras.cost, 4000);
  const ss = contributionCost({ ...args, method: 'salary_sacrifice' }, rates);
  assert.ok(ss.cost < net.cost, 'salary sacrifice also saves National Insurance');
  // a higher-rate taxpayer gets relief at 40% on the part above the threshold
  const high = contributionCost({ salary: 80000, region: 'ruk', memberAnnual: 10000, method: 'net_pay' }, rates);
  close(high.cost, 6000);
  assert.equal(contributionCost({ ...args, memberAnnual: 0, method: 'net_pay' }, rates), null);
  assert.equal(contributionCost({ ...args, salary: 0, method: 'net_pay' }, rates), null);
});

test('works with older data files that lack the new pension figures', () => {
  const old = { ...rates, pensions: { annualAllowance: 60000, reliefMinimumGross: 3600 } };
  const r = evaluate({ ...base, pot: 50000, qualifyingYears: 35 }, old);
  close(r.sp.annualReal, 241.3 * 52); assert.ok(r.last.net > 0);
});
