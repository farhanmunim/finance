import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculate, marginalRate, applyOverrides, propertyIncrementalTax } from '../assets/js/tax-engine.js';

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

test('employment expenses reduce tax but not NI', () => {
  const r = calculate({ employment: { salary: 30000, expenses: 1000 } }, y2627);
  close(r.incomeTax.total, (29000 - 12570) * 0.2);
  close(r.nationalInsurance.class1.total, (30000 - 12570) * 0.08);
});

test('property income: finance costs not deductible, 20% tax reducer (gov.uk style example)', () => {
  // Salary 40,000; rent 12,000; expenses 2,000; mortgage interest 4,000
  const r = calculate({ employment: { salary: 40000 }, property: { rentalIncome: 12000, expenses: 2000, financeCosts: 4000, deduction: 'expenses' } }, y2627);
  close(r.income.property.profit, 10000);
  const before = (37700) * 0.2 + (50000 - 12570 - 37700) * 0.4; // 7540 + (-270)? no: taxable 37,430 -> all basic
  close(r.incomeTax.beforeReducers, 37430 * 0.2);
  close(r.incomeTax.financeCostReducer, 800);
  close(r.incomeTax.total, 37430 * 0.2 - 800);
  assert.equal(r.nationalInsurance.class4.total, 0); // no NI on rent
});

test('property income: reducer capped at property profits', () => {
  const r = calculate({ employment: { salary: 40000 }, property: { rentalIncome: 6000, expenses: 1000, financeCosts: 8000, deduction: 'expenses' } }, y2627);
  close(r.incomeTax.financeCostReliefBase, 5000);
  close(r.incomeTax.financeCostReducer, 1000);
});

test('property allowance replaces expenses and blocks finance cost relief', () => {
  const r = calculate({ employment: { salary: 30000 }, property: { rentalIncome: 5000, expenses: 200, financeCosts: 1000, deduction: 'property_allowance' } }, y2627);
  close(r.income.property.profit, 4000);
  assert.equal(r.incomeTax.financeCostReducer, 0);
  assert.ok(r.warnings.some((w) => /property allowance/.test(w)));
});

test('child benefit: opted out means no charge and nothing received', () => {
  const r = calculate({ employment: { salary: 70000 }, adjustments: { childBenefitChildren: 2, childBenefitOptedOut: true } }, y2627);
  assert.equal(r.hicbc.charge, 0);
  assert.equal(r.hicbc.received, 0);
  assert.ok(r.warnings.length === 1);
  const kept = calculate({ employment: { salary: 70000 }, adjustments: { childBenefitChildren: 2 } }, y2627);
  close(kept.hicbc.netKept, kept.hicbc.received - kept.hicbc.charge);
  close(kept.totals.takeHome, calculate({ employment: { salary: 70000 } }, y2627).totals.takeHome + kept.hicbc.netKept);
});

test('rate overrides change the calculation', () => {
  const custom = applyOverrides(y2627, { 'incomeTax.personalAllowance': '15000', 'incomeTax.bands.ruk.0.rate': '0.19', 'nationalInsurance.class1.employeeMainRate': 0.1 });
  const r = calculate({ employment: { salary: 30000 } }, custom);
  close(r.incomeTax.total, 15000 * 0.19);
  close(r.nationalInsurance.class1.total, (30000 - 12570) * 0.1);
  // original untouched
  assert.equal(y2627.incomeTax.personalAllowance, 12570);
});

test('automatic deduction picks the trading allowance when expenses are small', () => {
  const auto = calculate({ selfEmployment: { turnover: 20000, expenses: 300 } }, y2627);
  const ta = calculate({ selfEmployment: { turnover: 20000, expenses: 300, deduction: 'trading_allowance' } }, y2627);
  assert.equal(auto.income.selfEmployment.deduction, 'trading_allowance');
  assert.equal(auto.income.selfEmployment.auto, true);
  close(auto.totals.totalDeductions, ta.totals.totalDeductions);
  const big = calculate({ selfEmployment: { turnover: 20000, expenses: 5000 } }, y2627);
  assert.equal(big.income.selfEmployment.deduction, 'expenses');
});

test('automatic property deduction keeps the interest credit when that is cheaper', () => {
  const r = calculate({ employment: { salary: 60000 }, property: { rentalIncome: 12000, expenses: 500, financeCosts: 6000 } }, y2627);
  // expenses 500 + 20% credit on 6,000 (=1,200 off tax) beats a 1,000 allowance (400 off tax at 40%)
  assert.equal(r.income.property.deduction, 'expenses');
  close(r.incomeTax.financeCostReducer, 1200);
  const small = calculate({ employment: { salary: 60000 }, property: { rentalIncome: 3000, expenses: 100, financeCosts: 200 } }, y2627);
  assert.equal(small.income.property.deduction, 'property_allowance');
});

test('propertyIncrementalTax uses the personal allowance when other income is low', () => {
  const noIncome = propertyIncrementalTax({ region: 'ruk', otherIncome: 0, rentalIncome: 10000, expenses: 1000, financeCosts: 3000 }, y2627);
  assert.equal(noIncome.tax, 0); // profit 9,000 is within the personal allowance
  const higher = propertyIncrementalTax({ region: 'ruk', otherIncome: 60000, rentalIncome: 12000, expenses: 2000, financeCosts: 4000, deduction: 'expenses' }, y2627);
  close(higher.taxBeforeCredit, 4000);
  close(higher.credit, 800);
  close(higher.tax, 3200);
  close(higher.oldRulesTax, 2400);
  const straddle = propertyIncrementalTax({ region: 'ruk', otherIncome: 45000, rentalIncome: 12000, expenses: 2000, financeCosts: 0, deduction: 'expenses' }, y2627);
  // 5,270 of profit at 20%, 4,730 at 40%
  close(straddle.tax, 5270 * 0.2 + 4730 * 0.4);
});

test('gift aid: higher-rate taxpayer saves 20% of the gross donation', () => {
  const r = calculate({ employment: { salary: 70000 }, adjustments: { giftAid: 800 } }, y2627);
  close(r.giving.giftAidGross, 1000);
  close(r.giving.charityClaims, 200);
  close(r.giving.taxSaved, 200); // 40% - 20% on £1,000 of income moved into the basic band
  close(r.giving.netCost, 600);
  assert.equal(r.giving.taxCoverShortfall, 0);
});

test('gift aid: basic-rate taxpayer saves nothing extra but charity still gains', () => {
  const r = calculate({ employment: { salary: 30000 }, adjustments: { giftAid: 800 } }, y2627);
  close(r.giving.taxSaved, 0);
  close(r.giving.charityReceives, 1000);
});

test('gift aid: restores personal allowance in the taper zone (60% effective relief)', () => {
  const r = calculate({ employment: { salary: 110000 }, adjustments: { giftAid: 8000 } }, y2627);
  close(r.giving.giftAidGross, 10000);
  assert.equal(r.allowances.personalAllowance, 12570);
  close(r.giving.taxSaved, 10000 * 0.6 - 10000 * 0.2); // 40% higher-rate relief + PA restored (worth 5,000 × 40%)
});

test('gift aid: warning when not enough tax paid to cover the charity claim', () => {
  const r = calculate({ employment: { salary: 13000 }, adjustments: { giftAid: 2000 } }, y2627);
  assert.ok(r.giving.taxCoverShortfall > 0);
  assert.ok(r.warnings.some((w) => /Gift Aid/.test(w)));
});

test('payroll giving reduces taxable pay, not NI, and leaves take-home', () => {
  const r = calculate({ employment: { salary: 60000, payrollGiving: 1200 } }, y2627);
  const base = calculate({ employment: { salary: 60000 } }, y2627);
  close(r.incomeTax.total, base.incomeTax.total - 1200 * 0.4);
  close(r.nationalInsurance.total, base.nationalInsurance.total);
  close(r.totals.takeHome, base.totals.takeHome - 1200 + 480);
  close(r.giving.taxSaved, 480);
  close(r.giving.netCost, 720);
});

test('student loan is based on NI-able pay (net-pay pension does not reduce it)', () => {
  const r = calculate({ employment: { salary: 40000, pension: { method: 'net_pay', type: 'percent', value: 10 } }, studentLoans: ['plan2'] }, y2627);
  close(r.studentLoans.income, 40000);
});

// ---------------------------------------------------------------- reviewer checks
const y1617 = applyOverrides(y2627, {
  'incomeTax.personalAllowance': 11000, 'incomeTax.bands.ruk.0.upTo': 32000, 'incomeTax.bands.ruk.1.upTo': 150000,
});

test('HMRC landlord case study 1 (Sophia): credit on finance costs, no extra tax', () => {
  const r = calculate({ property: { rentalIncome: 52000, expenses: 9000, financeCosts: 20000, deduction: 'expenses' } }, y1617);
  close(r.incomeTax.beforeReducers, 6400);
  close(r.incomeTax.financeCostReducer, 4000);
  close(r.incomeTax.total, 2400);
});

test('HMRC landlord case study 4 (Brian year 1): credit capped at property profits, rest carried forward', () => {
  const r = calculate({ employment: { salary: 36000 }, property: { rentalIncome: 20000, expenses: 7000, financeCosts: 15000, deduction: 'expenses' } }, y1617);
  close(r.incomeTax.beforeReducers, 8800);
  close(r.incomeTax.financeCostReducer, 2600);
  close(r.incomeTax.total, 6200);
  close(r.incomeTax.financeCostsCarriedForward, 2000);
});

test('HMRC landlord case study 4 (Brian year 2): brought-forward finance costs used', () => {
  const r = calculate({ employment: { salary: 36000 }, property: { rentalIncome: 24000, expenses: 2000, financeCosts: 15000, financeCostsBroughtForward: 2000, deduction: 'expenses' } }, y1617);
  close(r.incomeTax.beforeReducers, 12400);
  close(r.incomeTax.financeCostReducer, 3400);
  close(r.incomeTax.total, 9000);
  close(r.incomeTax.financeCostsCarriedForward, 0);
});

test('allowances: set against dividends before savings when that is cheaper (ITA 2007 s25)', () => {
  const r = calculate({ other: { savingsInterest: 6000, dividends: 20000 } }, y2627);
  // PA 12,570 all against dividends; savings covered by starting rate (5,000) + PSA (1,000)
  close(r.allowances.allocated.dividends, 12570);
  close(r.allowances.allocated.savings, 0);
  close(r.incomeTax.savings.tax, 0);
  close(r.incomeTax.dividends.tax, (20000 - 12570 - 500) * 0.1075);
  assert.equal(r.allowances.reordered, true);
});

test('allowances: default order kept when reordering would not help', () => {
  const r = calculate({ employment: { salary: 10000 }, other: { savingsInterest: 3000 } }, y2627);
  assert.equal(r.allowances.reordered, false);
  close(r.incomeTax.total, 0);
  // and a case where moving £500 of allowance to dividends does save tax
  const d = calculate({ employment: { salary: 10000 }, other: { savingsInterest: 3000, dividends: 1000 } }, y2627);
  assert.equal(d.allowances.reordered, true);
  close(d.incomeTax.total, 0);
});

test('Scottish taxpayer keeps the £1,000 savings allowance while under the UK higher-rate threshold', () => {
  const r = calculate({ region: 'scotland', employment: { salary: 45000 }, other: { savingsInterest: 900 } }, y2627);
  // taxable earnings 32,430: Scottish higher rate (42%) but below the UK 37,700 limit
  assert.equal(r.incomeTax.level, 'basic');
  close(r.incomeTax.savings.tax, 0);
  const above = calculate({ region: 'scotland', employment: { salary: 55000 }, other: { savingsInterest: 900 } }, y2627);
  assert.equal(above.incomeTax.level, 'higher');
  close(above.incomeTax.savings.tax, 400 * 0.4);
});

test('pension relief limit and annual allowance warnings', () => {
  const over = calculate({ employment: { salary: 20000, pension: { method: 'relief_at_source', type: 'amount', value: 25000 } } }, y2627);
  assert.ok(over.warnings.some((w) => /100% of your earnings/.test(w)));
  const aa = calculate({ employment: { salary: 150000, pension: { method: 'net_pay', type: 'amount', value: 70000 } } }, y2627);
  assert.ok(aa.warnings.some((w) => /annual allowance/.test(w)));
  const fine = calculate({ employment: { salary: 60000, pension: { method: 'net_pay', type: 'percent', value: 10 } } }, y2627);
  assert.equal(fine.warnings.length, 0);
});

test('marriage allowance transfer warns when the transferor is a higher-rate taxpayer', () => {
  const r = calculate({ employment: { salary: 60000 }, adjustments: { marriageAllowance: 'transfer' } }, y2627);
  assert.ok(r.warnings.some((w) => /transferred/.test(w)));
});

// ---------------------------------------------------------------- property (SA105) coverage
test('property: joint ownership share applies to rent, costs and interest', () => {
  const r = calculate({ employment: { salary: 30000 }, property: { rentalIncome: 12000, expenses: 2000, financeCosts: 4000, share: 50, deduction: 'expenses' } }, y2627);
  close(r.income.property.rentalIncome, 6000);
  close(r.income.property.profit, 5000);
  close(r.incomeTax.financeCostReducer, 2000 * 0.2);
});

test('property: replacement of domestic items relief is deducted', () => {
  const r = calculate({ property: { rentalIncome: 15000, expenses: 1000, replacementItems: 800, deduction: 'expenses' } }, y2627);
  close(r.income.property.profit, 13200);
});

test('property losses: HMRC PIM4210 example (Xiang) carried forward year by year', () => {
  // 2011-12 loss 5,000; 2012-13 profit 3,000; 2013-14 loss 1,000; 2014-15 profit 8,000
  const y1 = calculate({ property: { rentalIncome: 10000, expenses: 15000, deduction: 'expenses' } }, y2627);
  close(y1.income.property.profit, 0); close(y1.income.property.lossesCarriedForward, 5000);
  const y2 = calculate({ property: { rentalIncome: 10000, expenses: 7000, lossesBroughtForward: 5000, deduction: 'expenses' } }, y2627);
  close(y2.income.property.profit, 0); close(y2.income.property.lossesCarriedForward, 2000);
  const y3 = calculate({ property: { rentalIncome: 10000, expenses: 11000, lossesBroughtForward: 2000, deduction: 'expenses' } }, y2627);
  close(y3.income.property.profit, 0); close(y3.income.property.lossesCarriedForward, 3000);
  const y4 = calculate({ property: { rentalIncome: 10000, expenses: 2000, lossesBroughtForward: 3000, deduction: 'expenses' } }, y2627);
  close(y4.income.property.profit, 5000); close(y4.income.property.lossesCarriedForward, 0);
});

test('property: finance cost credit is capped by profit after losses brought forward', () => {
  const r = calculate({ employment: { salary: 40000 }, property: { rentalIncome: 12000, expenses: 2000, financeCosts: 6000, lossesBroughtForward: 7000, deduction: 'expenses' } }, y2627);
  close(r.income.property.profit, 3000);
  close(r.incomeTax.financeCostReliefBase, 3000);
  close(r.incomeTax.financeCostsCarriedForward, 3000);
});

test('rent a room: tax-free up to £7,500, excess taxed, halved if shared', () => {
  const under = calculate({ employment: { salary: 30000 }, property: { lodgerIncome: 7000 } }, y2627);
  close(under.income.property.lodgerTaxable, 0);
  close(under.incomeTax.total, calculate({ employment: { salary: 30000 } }, y2627).incomeTax.total);
  const over = calculate({ employment: { salary: 30000 }, property: { lodgerIncome: 9000 } }, y2627);
  close(over.income.property.lodgerTaxable, 1500);
  close(over.incomeTax.total, calculate({ employment: { salary: 30000 } }, y2627).incomeTax.total + 300);
  const shared = calculate({ employment: { salary: 30000 }, property: { lodgerIncome: 5000, lodgerShared: true } }, y2627);
  close(shared.income.property.lodgerTaxable, 1250);
  // take-home includes the lodger's rent in full
  close(over.totals.takeHome, calculate({ employment: { salary: 30000 } }, y2627).totals.takeHome + 9000 - 300);
});

test('rent a room blocks the property allowance', () => {
  const r = calculate({ property: { rentalIncome: 5000, expenses: 100, lodgerIncome: 8000, deduction: 'property_allowance' } }, y2627);
  assert.equal(r.income.property.deduction, 'expenses');
  assert.ok(r.warnings.some((w) => /Rent a Room/.test(w)));
  const auto = calculate({ property: { rentalIncome: 5000, expenses: 100, lodgerIncome: 8000 } }, y2627);
  assert.equal(auto.income.property.deduction, 'expenses');
});

// ---------------------------------------------------------------- PAYE vs Self Assessment
test('collection: employee with rental profit pays the extra tax through Self Assessment', () => {
  const r = calculate({ employment: { salary: 40000 }, property: { rentalIncome: 12000, expenses: 2000, deduction: 'expenses' } }, y2627);
  const payeOnly = calculate({ employment: { salary: 40000 } }, y2627);
  close(r.collection.paye.incomeTax, payeOnly.incomeTax.total);
  close(r.collection.selfAssessment.incomeTax, r.incomeTax.total - payeOnly.incomeTax.total);
  close(r.collection.selfAssessment.balancingPayment, r.incomeTax.total - payeOnly.incomeTax.total);
  assert.equal(r.collection.selfAssessment.likelyNeedsReturn, true);
  // £10,000 profit all within the basic band: £2,000 -> payments on account required
  close(r.collection.selfAssessment.relevantAmount, 2000);
  assert.equal(r.collection.selfAssessment.paymentsOnAccountRequired, true);
  close(r.collection.selfAssessment.paymentOnAccount, 1000);
});

test('collection: no payments on account when the SA bill is under £1,000', () => {
  const r = calculate({ employment: { salary: 40000 }, other: { dividends: 3000 } }, y2627);
  close(r.collection.selfAssessment.balancingPayment, 2500 * 0.1075);
  assert.equal(r.collection.selfAssessment.paymentsOnAccountRequired, false);
});

test('collection: self-employed only pays everything through Self Assessment', () => {
  const r = calculate({ selfEmployment: { turnover: 50000, expenses: 5000, deduction: 'expenses' }, studentLoans: ['plan2'] }, y2627);
  assert.equal(r.collection.paye.total, 0);
  close(r.collection.selfAssessment.balancingPayment, r.incomeTax.total + r.nationalInsurance.class4.total + r.studentLoans.total);
  assert.equal(r.collection.selfAssessment.paymentsOnAccountRequired, true);
});

test('collection: employee only has nothing due through Self Assessment', () => {
  const r = calculate({ employment: { salary: 40000 }, studentLoans: ['plan2'] }, y2627);
  close(r.collection.selfAssessment.balancingPayment, 0);
  assert.equal(r.collection.selfAssessment.likelyNeedsReturn, false);
  close(r.collection.paye.studentLoan, r.studentLoans.total);
});
