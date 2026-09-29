import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculate, marginalRate } from '../assets/js/tax-engine.js';

const y2627 = JSON.parse(readFileSync(new URL('../data/tax-years/2026-27.json', import.meta.url)));
const y2526 = JSON.parse(readFileSync(new URL('../data/tax-years/2025-26.json', import.meta.url)));
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.011, `${msg ?? ''} expected ${b} got ${a}`);

test('basic-rate employee, no pension (2026/27)', () => {
  const r = calculate({ employment: { salary: 30000 } }, y2627);
  close(r.incomeTax.total, 3486);
  close(r.nationalInsurance.class1.total, 1394.4);
  close(r.totals.takeHome, 25119.6);
  assert.equal(r.incomeTax.level, 'basic');
});

test('higher-rate employee', () => {
  const r = calculate({ employment: { salary: 60000 } }, y2627);
  close(r.incomeTax.total, 11432);
  close(r.nationalInsurance.class1.total, 3210.6);
  close(r.nationalInsurance.class1.employer, (60000 - 5000) * 0.15);
  assert.equal(r.incomeTax.level, 'higher');
});

test('personal allowance taper at £110,000', () => {
  const r = calculate({ employment: { salary: 110000 } }, y2627);
  assert.equal(r.allowances.personalAllowance, 7570);
  close(r.incomeTax.total, 33432);
});

test('additional rate at £130,000 (no personal allowance)', () => {
  const r = calculate({ employment: { salary: 130000 } }, y2627);
  assert.equal(r.allowances.personalAllowance, 0);
  close(r.incomeTax.total, 44703);
  assert.equal(r.incomeTax.level, 'additional');
});

test('Scottish taxpayer at £50,000 (2026/27 bands)', () => {
  const r = calculate({ region: 'scotland', employment: { salary: 50000 } }, y2627);
  close(r.incomeTax.total, 753.73 + 2597.8 + 2968.56 + 2661.96);
  // NI is UK-wide
  close(r.nationalInsurance.class1.total, (50000 - 12570) * 0.08);
});

test('Scottish taxpayer 2025/26 bands differ', () => {
  const r = calculate({ region: 'scotland', employment: { salary: 50000 } }, y2526);
  close(r.incomeTax.total, 2827 * 0.19 + (14921 - 2827) * 0.2 + (31092 - 14921) * 0.21 + (37430 - 31092) * 0.42);
});

test('gov.uk dividend example: £29,570 wages + £3,000 dividends', () => {
  const r = calculate({ employment: { salary: 29570 }, other: { dividends: 3000 } }, y2627);
  close(r.incomeTax.nonSavings.tax, 3400);
  close(r.incomeTax.dividends.tax, 2500 * 0.1075);
  close(r.incomeTax.total, 3668.75);
});

test('dividends straddling the higher-rate threshold use the higher dividend rate', () => {
  const r = calculate({ employment: { salary: 50000 }, other: { dividends: 5000 } }, y2627);
  // taxable non-savings 37,430; dividend allowance 500 -> pos 37,930; 4,500 taxed: 0 in basic? no: 37,700 limit already passed at 37,930
  close(r.incomeTax.dividends.tax, 4500 * 0.3575);
});

test('gov.uk savings example: £16,000 wages + £200 interest is covered by starting rate', () => {
  const r = calculate({ employment: { salary: 16000 }, other: { savingsInterest: 200 } }, y2627);
  close(r.incomeTax.savings.startingRateAvailable, 1570);
  close(r.incomeTax.savings.tax, 0);
  close(r.incomeTax.total, 686);
});

test('personal savings allowance: basic rate £1,300 interest -> £60 tax', () => {
  const r = calculate({ employment: { salary: 30000 }, other: { savingsInterest: 1300 } }, y2627);
  close(r.incomeTax.savings.tax, 60);
});

test('relief-at-source pension extends the basic rate band', () => {
  // £10,000 gross contribution => employee pays £8,000; band limit becomes £47,700
  const r = calculate({ employment: { salary: 60000, pension: { method: 'relief_at_source', type: 'amount', value: 10000 } } }, y2627);
  close(r.income.employment.pensionCash, 8000);
  close(r.incomeTax.total, 9486);
  close(r.nationalInsurance.class1.total, 3210.6); // NI unaffected
});

test('salary sacrifice reduces tax and NI; net pay reduces tax only', () => {
  const ss = calculate({ employment: { salary: 60000, pension: { method: 'salary_sacrifice', type: 'percent', value: 10 } } }, y2627);
  const np = calculate({ employment: { salary: 60000, pension: { method: 'net_pay', type: 'percent', value: 10 } } }, y2627);
  close(ss.incomeTax.total, 9032);
  close(np.incomeTax.total, 9032);
  close(ss.nationalInsurance.class1.total, 37700 * 0.08 + (54000 - 50270) * 0.02);
  close(np.nationalInsurance.class1.total, 3210.6);
  close(ss.totals.takeHome, 54000 - 9032 - ss.nationalInsurance.class1.total);
});

test('pension contribution keeps adjusted net income below the taper', () => {
  const r = calculate({ employment: { salary: 110000, pension: { method: 'relief_at_source', type: 'amount', value: 10000 } } }, y2627);
  close(r.allowances.adjustedNetIncome, 100000);
  assert.equal(r.allowances.personalAllowance, 12570);
});

test('self-employed only: profits, class 4 and class 2 status', () => {
  const r = calculate({ selfEmployment: { turnover: 45000, expenses: 5000, deduction: 'expenses' } }, y2627);
  close(r.income.selfEmployment.profit, 40000);
  close(r.incomeTax.total, (40000 - 12570) * 0.2);
  close(r.nationalInsurance.class4.total, (40000 - 12570) * 0.06);
  assert.equal(r.nationalInsurance.class2.status, 'credited');
  assert.equal(r.nationalInsurance.class1.total, 0);
});

test('self-employed: trading allowance and class 2 voluntary below small profits threshold', () => {
  const r = calculate({ selfEmployment: { turnover: 6000, deduction: 'trading_allowance' } }, y2627);
  close(r.income.selfEmployment.profit, 5000);
  assert.equal(r.nationalInsurance.class2.status, 'voluntary');
  close(r.nationalInsurance.class2.voluntaryAnnual, 3.65 * 52);
  close(r.incomeTax.total, 0);
});

test('self-employed class 4 above upper profits limit', () => {
  const r = calculate({ selfEmployment: { turnover: 70000, expenses: 0, deduction: 'expenses' } }, y2627);
  close(r.nationalInsurance.class4.total, (50270 - 12570) * 0.06 + (70000 - 50270) * 0.02);
});

test('employment + self-employment: class 4 annual maximum interaction', () => {
  const r = calculate({ employment: { salary: 40000 }, selfEmployment: { turnover: 20000, expenses: 0, deduction: 'expenses' } }, y2627);
  close(r.nationalInsurance.class1.main, 2194.4);
  close(r.nationalInsurance.class4.main, 67.6);
  close(r.nationalInsurance.class4.upper, 126.07);
  assert.equal(r.nationalInsurance.class4.annualMaximumApplied, true);
  // income tax on the combined income
  close(r.incomeTax.total, 37700 * 0.2 + (60000 - 12570 - 37700) * 0.4);
});

test('employment + self-employment: class 1 already at UEL means all class 4 at 2%', () => {
  const r = calculate({ employment: { salary: 60000 }, selfEmployment: { turnover: 30000, expenses: 0, deduction: 'expenses' } }, y2627);
  close(r.nationalInsurance.class4.main, 0);
  close(r.nationalInsurance.class4.upper, (30000 - 12570) * 0.02);
});

test('student loan plan 2 and postgraduate', () => {
  const r = calculate({ employment: { salary: 40000 }, studentLoans: ['plan2', 'postgraduate'] }, y2627);
  assert.equal(r.studentLoans.undergraduate.amount, Math.floor((40000 - 29385) * 0.09));
  assert.equal(r.studentLoans.postgraduate.amount, Math.floor((40000 - 21000) * 0.06));
});

test('student loan: plan 1 and plan 2 together use the lower threshold once', () => {
  const r = calculate({ employment: { salary: 40000 }, studentLoans: ['plan1', 'plan2'] }, y2627);
  assert.equal(r.studentLoans.undergraduate.threshold, 26900);
  assert.equal(r.studentLoans.undergraduate.amount, Math.floor((40000 - 26900) * 0.09));
});

test('student loan uses salary after salary sacrifice, and self-employed profits', () => {
  const r = calculate({ employment: { salary: 40000, pension: { method: 'salary_sacrifice', type: 'percent', value: 10 } }, selfEmployment: { turnover: 10000, deduction: 'expenses' }, studentLoans: ['plan5'] }, y2627);
  close(r.studentLoans.income, 46000);
});

test('high income child benefit charge (gov.uk example: £67,600 -> 38%)', () => {
  const r = calculate({ employment: { salary: 67600 }, adjustments: { childBenefitChildren: 1 } }, y2627);
  assert.equal(r.hicbc.percent, 38);
  assert.equal(r.hicbc.charge, Math.floor(27.05 * 52 * 0.38));
  const full = calculate({ employment: { salary: 85000 }, adjustments: { childBenefitChildren: 2 } }, y2627);
  assert.equal(full.hicbc.percent, 100);
  close(full.hicbc.charge, Math.floor((27.05 + 17.9) * 52));
});

test('marriage allowance: receive gives £252 reducer, transfer reduces allowance', () => {
  const rec = calculate({ employment: { salary: 20000 }, adjustments: { marriageAllowance: 'receive' } }, y2627);
  close(rec.incomeTax.total, 1486 - 252);
  const tr = calculate({ employment: { salary: 11000 }, adjustments: { marriageAllowance: 'transfer' } }, y2627);
  assert.equal(tr.allowances.total, 12570 - 1260);
  const hr = calculate({ employment: { salary: 60000 }, adjustments: { marriageAllowance: 'receive' } }, y2627);
  assert.equal(hr.incomeTax.marriageReducer, 0);
  assert.ok(hr.warnings.length > 0);
});

test('blind person\'s allowance adds to allowances', () => {
  const r = calculate({ employment: { salary: 30000 }, adjustments: { blindPersonsAllowance: true } }, y2627);
  assert.equal(r.allowances.total, 12570 + 3250);
});

test('gift aid extends the basic rate band', () => {
  const r = calculate({ employment: { salary: 55000 }, adjustments: { giftAid: 800 } }, y2627);
  close(r.allowances.giftAidGross, 1000);
  close(r.incomeTax.total, 38700 * 0.2 + (55000 - 12570 - 38700) * 0.4);
});

test('2025/26 dividend rates are lower', () => {
  const r = calculate({ employment: { salary: 30000 }, other: { dividends: 2500 } }, y2526);
  close(r.incomeTax.dividends.tax, 2000 * 0.0875);
});

test('nothing entered gives zeros, no crash', () => {
  const r = calculate({}, y2627);
  assert.equal(r.totals.takeHome, 0);
  assert.equal(r.incomeTax.total, 0);
});

test('marginal rate around £100k reflects the personal allowance taper (60%+)', () => {
  const m = marginalRate({ employment: { salary: 110000 } }, y2627);
  close(m.rate, 0.62);
  const b = marginalRate({ employment: { salary: 30000 } }, y2627);
  close(b.rate, 0.28);
});
